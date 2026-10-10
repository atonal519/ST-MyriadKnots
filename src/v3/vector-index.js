import { sha256 } from '../identity.js';
import { normalizeVector } from '../vector-api.js';
import { rawWitnessShape, rawWitnessValid, vectorWitnessShape } from './vector-source.js';
import { projectVectorSources } from './vector-source.js';
import { selectRecallMemories } from './recall-source.js';

export const VECTOR_INDEX_ID = 'qqj-vector-index';
export const VECTOR_SHARD_PREFIX = 'qqj-vector-shard-';
const SCHEMA = 1, BATCH = 16, INDEX_LOAD_TIMEOUT_MS = 15000, VECTOR_QUERY_TIMEOUT_MS = 15000;
const hash = async value => `sha256:${await sha256(value)}`;
const configKey = config => JSON.stringify([config.url, config.model, config.dimensions]);
const ownerKey = (source, modelKey) => JSON.stringify([source.chatId, source.narrativeGeneration, modelKey]);
// 摘要修订会换 FloorMemory.id；缓存复用仅依赖真实原文楼、锚点与正文指纹。
const rawSourceKey = value => JSON.stringify([value.floorId, value.assistantSeq, value.memoryFloorId, value.memoryAssistantSeq, value.fingerprint]);
const rawChunkKey = value => JSON.stringify([rawSourceKey(value), value.offset, value.length]);
const bindRawWitness = (raw, witness) => ({ floorId: raw.floorId, assistantSeq: raw.assistantSeq, floorMemoryId: raw.floorMemoryId,
  memoryFloorId: raw.memoryFloorId, memoryAssistantSeq: raw.memoryAssistantSeq, fingerprint: raw.fingerprint,
  offset: witness.offset, length: witness.length, textFingerprint: witness.textFingerprint });
const orderedRawWitness = value => ({ floorId: value.floorId, assistantSeq: value.assistantSeq, floorMemoryId: value.floorMemoryId,
  memoryFloorId: value.memoryFloorId, memoryAssistantSeq: value.memoryAssistantSeq, fingerprint: value.fingerprint,
  offset: value.offset, length: value.length, textFingerprint: value.textFingerprint });
const witnessMatches = (actual, expected) => {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const keys = Object.keys(expected);
  return keys.every(key => Object.prototype.hasOwnProperty.call(actual, key) && actual[key] === expected[key]);
};
const errorWith = (code, message) => Object.assign(new Error(message), { code });

// vectorWitnessShape 保持 schema 1 的旧摘要行可读；查询阶段只接受原文见证。
export function vectorRecordOwned(record) {
  const data = record?.data;
  if (!data || data.schemaVersion !== SCHEMA || data.recordType !== 'vectorCache' || typeof data.chatId !== 'string'
    || typeof data.narrativeGeneration !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(data.modelKey ?? '')) return false;
  const shardId = id => /^qqj-vector-shard-[a-f0-9]{40}$/u.test(id);
  if (record.recordId === VECTOR_INDEX_ID) return Number.isSafeInteger(data.dimensions) && data.dimensions > 0 && data.dimensions <= 8192
    && Number.isSafeInteger(data.chunkCount) && data.chunkCount >= 0 && Array.isArray(data.shardIds) && data.shardIds.every(shardId) && new Set(data.shardIds).size === data.shardIds.length;
  return shardId(record.recordId) && Array.isArray(data.rows) && data.rows.length > 0 && data.rows.length <= BATCH
    && data.rows.every(row => vectorWitnessShape(row?.witness) && typeof row.vector === 'string' && row.vector.length > 0 && row.vector.length <= 44000 && /^[A-Za-z0-9+/]+={0,2}$/u.test(row.vector));
}

export function rawSourceChunks(source) {
  return (source.rawSources ?? []).flatMap(raw => {
    const chunks = [];
    const content = raw.canonicalContent;
    for (let offset = 0; offset < content.length; offset += 320) {
      let start = offset;
      const first = content.charCodeAt(start), previous = content.charCodeAt(start - 1);
      if (start > 0 && first >= 0xdc00 && first <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) start -= 1;
      let end = Math.min(content.length, start + 400);
      const last = content.charCodeAt(end - 1), next = content.charCodeAt(end);
      if (end < content.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
      const text = content.slice(start, end);
      if (text.trim()) chunks.push({ text, witness: {
        floorId: raw.floorId, assistantSeq: raw.assistantSeq, floorMemoryId: raw.floorMemoryId,
        memoryFloorId: raw.memoryFloorId, memoryAssistantSeq: raw.memoryAssistantSeq,
        fingerprint: raw.fingerprint, offset: start, length: text.length,
      } });
      if (end >= content.length) break;
    }
    return chunks;
  });
}

// 新索引统一取当前可验证的原文；旧摘要向量只保留在读取兼容合同中。
const vectorSourceChunks = source => rawSourceChunks(source);

function encodeVector(vector) {
  const bytes = new Uint8Array(new Float32Array(vector).buffer);
  return btoa(Array.from(bytes, value => String.fromCharCode(value)).join(''));
}
function decodeVector(value, dimensions) {
  if (typeof value !== 'string' || value.length > 44000) throw errorWith('VECTOR_CACHE_INVALID', '向量索引无效，请重新建立。');
  const binary = atob(value), bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (bytes.byteLength !== dimensions * 4) throw errorWith('VECTOR_CACHE_INVALID', '向量索引无效，请重新建立。');
  return normalizeVector([...new Float32Array(bytes.buffer)]);
}
const safeProviderErrorFields = value => {
  if (!value || typeof value !== 'object') return null;
  const field = item => typeof item === 'string' && item.length <= 80 && /^[A-Za-z0-9_.:\-\[\]]+$/u.test(item) ? item : null;
  const result = { code: field(value.code), type: field(value.type), param: field(value.param) };
  return Object.values(result).some(Boolean) ? result : null;
};
const buildPhases = ['source', 'cache', 'embedding', 'verification', 'save', 'complete'];
function safeBuildRequest(value) {
  if (!value || typeof value !== 'object') return null;
  const safeString = (text, pattern, max = 128) => typeof text === 'string' && text.length <= max && pattern.test(text) ? text : null;
  return Object.freeze({
    requestId: safeString(value.requestId, /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u),
    phase: ['request', 'response', 'validation', 'complete'].includes(value.phase) ? value.phase : null,
    pendingStage: ['request_prepared', 'fetch_call_start', 'fetch_called', 'response_headers', 'response_body', 'complete', 'aborted'].includes(value.pendingStage) ? value.pendingStage : null,
    elapsedMs: Number.isFinite(value.elapsedMs) ? Math.max(0, value.elapsedMs) : null,
    deadlineMs: Number.isFinite(value.deadlineMs) ? Math.max(0, value.deadlineMs) : null,
    httpStatus: Number.isSafeInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? value.httpStatus : null,
    errorCode: safeString(value.errorCode, /^VECTOR_[A-Z0-9_]{1,80}$/u, 80),
    networkCode: safeString(value.networkCode, /^[A-Z][A-Z0-9_]{1,63}$/u, 64),
    providerRequestId: safeString(value.providerRequestId, /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u),
    providerError: safeProviderErrorFields(value.providerError),
    fetchCallMs: Number.isFinite(value.fetchCallMs) ? Math.max(0, value.fetchCallMs) : null,
    responseHeadersMs: Number.isFinite(value.responseHeadersMs) ? Math.max(0, value.responseHeadersMs) : null,
    responseBodyMs: Number.isFinite(value.responseBodyMs) ? Math.max(0, value.responseBodyMs) : null,
  });
}
function safeBuildDiagnostic(value) {
  if (!value) return null;
  return Object.freeze({
    status: ['building', 'ready', 'failed', 'cancelled', 'skipped'].includes(value.status) ? value.status : 'building',
    phase: buildPhases.includes(value.phase) ? value.phase : 'source',
    batchNumber: Number.isSafeInteger(value.batchNumber) && value.batchNumber > 0 ? value.batchNumber : 0,
    completedChunks: Number.isSafeInteger(value.completedChunks) && value.completedChunks >= 0 ? value.completedChunks : 0,
    totalChunks: Number.isSafeInteger(value.totalChunks) && value.totalChunks >= 0 ? value.totalChunks : 0,
    inputCount: Number.isSafeInteger(value.inputCount) && value.inputCount >= 0 ? value.inputCount : 0,
    inputCharacters: Number.isSafeInteger(value.inputCharacters) && value.inputCharacters >= 0 ? value.inputCharacters : 0,
    longestInputCharacters: Number.isSafeInteger(value.longestInputCharacters) && value.longestInputCharacters >= 0 ? value.longestInputCharacters : 0,
    errorCode: typeof value.errorCode === 'string' && /^VECTOR_[A-Z0-9_]{1,80}$/u.test(value.errorCode) ? value.errorCode : null,
    httpStatus: Number.isSafeInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? value.httpStatus : null,
    request: safeBuildRequest(value.request),
  });
}

// 索引是可删除的派生缓存；保存向量与片段见证，原文始终从当前可达 FloorMemory 读取。
export function createVectorIndex({ client, api, configProvider, sourceProvider, identityProvider, isEnabled = () => true } = {}) {
  let cached = null, lastQuery = null, loading = null, active = null, updating = null, queryOperation = null, querySnapshot = null, querySerial = 0, epoch = 0;
  let lastIncrementalFailureKey = null, lastIncrementalCancelledKey = null;
  const requestScopes = new WeakMap();
  const newRequestScope = () => ({ requestCount: 0, requestAttempts: [], requestSent: [], retryOutcome: 'not_retried', terminalCode: null });
  const requestScopeFor = signal => {
    if (!signal || typeof signal !== 'object') return newRequestScope();
    let scope = requestScopes.get(signal);
    if (!scope) { scope = newRequestScope(); requestScopes.set(signal, scope); }
    return scope;
  };
  let state = { status: 'idle', completed: 0, total: 0, error: null, cancelled: false, userCancelled: false, buildDiagnostic: null };
  const subscribers = new Set();
  // Cancellation markers describe this notification only; query progress must not replay an old cancel.
  const notify = patch => { state = { ...state, ...patch, cancelled: patch?.cancelled === true, userCancelled: patch?.userCancelled === true }; for (const fn of subscribers) fn({ ...state }); };
  const updateBuildDiagnostic = (operation, patch) => {
    operation.buildDiagnostic = { ...(operation.buildDiagnostic ?? {}), ...patch };
    const safe = safeBuildDiagnostic(operation.buildDiagnostic);
    notify({ buildDiagnostic: safe });
  };
  const targetIdentity = value => {
    const identity = value ?? identityProvider?.();
    if (!identity || typeof identity.chatId !== 'string' || !identity.chatId) throw errorWith('VECTOR_SOURCE_TARGET_INVALID', '索引来源无效。');
    return Object.freeze({ chatId: identity.chatId });
  };
  const readRecord = async (collection, recordId) => {
    // 新派生记录尚不存在是正常状态；白鳥 GET 的信封不带编号，由请求路径提供。
    try { return { ...await client.get(collection, recordId), recordId }; }
    catch (error) { if (error?.status === 404) return null; throw error; }
  };
  async function batchWitnesses(source, modelKey, batch, reusable = null) {
    const witnesses = [];
    for (const chunk of batch) {
      const known = reusable?.get(rawChunkKey(chunk.witness));
      let witness;
      if (known && rawWitnessShape(known.witness) && rawChunkKey(known.witness) === rawChunkKey(chunk.witness)) {
        witness = orderedRawWitness(known.witness);
      } else witness = { ...chunk.witness, textFingerprint: await hash(chunk.text) };
      witnesses.push(witness);
    }
    const id = `${VECTOR_SHARD_PREFIX}${(await sha256(JSON.stringify([source.narrativeGeneration, modelKey, witnesses]))).slice(0, 40)}`;
    return { witnesses, id };
  }
  async function validSavedBatch(record, source, modelKey, batch, witnesses, expectedId, expectedDimensions = null) {
    if (!record || record.recordId !== expectedId || !vectorRecordOwned(record)
      || ownerKey(record.data, record.data.modelKey) !== ownerKey(source, modelKey)
      || record.data.rows.length !== batch.length) return null;
    const rows = [];
    let dimensions = expectedDimensions;
    for (let index = 0; index < batch.length; index += 1) {
      const saved = record.data.rows[index];
      if (!witnessMatches(saved.witness, witnesses[index])) return null;
      try {
        const encodedBytes = atob(saved.vector).length;
        const rowDimensions = encodedBytes / 4;
        if (!Number.isSafeInteger(rowDimensions) || rowDimensions < 1 || rowDimensions > 8192 || dimensions && dimensions !== rowDimensions) return null;
        dimensions ??= rowDimensions;
        rows.push({ witness: witnesses[index], vector: decodeVector(saved.vector, rowDimensions) });
      } catch { return null; }
    }
    return { rows, dimensions };
  }
  function load(source, config, modelKey, diagnostic = null, { allowActive = false } = {}) {
    const key = ownerKey(source, modelKey), captured = epoch;
    const reportLoad = value => { if (diagnostic) { diagnostic.load = value; diagnostic.onLoadProgress?.(); } };
    if (loading?.key === key && loading.epoch === captured) return loading.promise;
    const job = { key, epoch: captured, promise: null }; loading = job;
    job.promise = (async () => {
      try {
        if (!isEnabled()) { reportLoad({ pending: null, shardsRead: 0, shardCount: null, exitReason: 'disabled', backendCode: null, httpStatus: null }); return; }
        reportLoad({ pending: 'manifest', shardsRead: 0, shardCount: null, exitReason: null, backendCode: null, httpStatus: null });
        const manifest = await readRecord(`chat-${source.chatId}`, VECTOR_INDEX_ID);
        if (!manifest) {
          reportLoad({ ...diagnostic?.load, pending: null, exitReason: 'missing' });
          if (isEnabled() && captured === epoch && (!active || allowActive) && configKey(configProvider()) === configKey(config)) cached = { key, rows: [], dimensions: 1024 };
          return;
        }
        if (!vectorRecordOwned(manifest)) {
          reportLoad({ ...diagnostic?.load, pending: null, exitReason: 'invalid' });
          if (isEnabled() && captured === epoch && (!active || allowActive) && configKey(configProvider()) === configKey(config)) cached = { key, rows: [], dimensions: 1024 };
          return;
        }
        if (ownerKey(manifest.data, manifest.data.modelKey) !== key) {
          reportLoad({ ...diagnostic?.load, pending: null, exitReason: 'ownerMismatch' });
          if (isEnabled() && captured === epoch && (!active || allowActive) && configKey(configProvider()) === configKey(config)) cached = { key, rows: [], dimensions: 1024 };
          return;
        }
        const rows = [];
        const dimensions = manifest.data.dimensions;
        reportLoad({ ...diagnostic?.load, pending: 'shard', shardCount: manifest.data.shardIds.length });
        if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 8192) { reportLoad({ ...diagnostic?.load, pending: null, exitReason: 'invalid' }); return; }
        for (const id of manifest.data.shardIds) {
          if (!isEnabled() || captured !== epoch || active && !allowActive) return;
          const shard = await readRecord(`chat-${source.chatId}`, id);
          if (!shard) { reportLoad({ ...diagnostic?.load, pending: null, exitReason: 'missing' }); return; }
          if (!vectorRecordOwned(shard)) { reportLoad({ ...diagnostic?.load, pending: null, exitReason: 'invalid' }); return; }
          if (ownerKey(shard.data, shard.data.modelKey) !== key) { reportLoad({ ...diagnostic?.load, pending: null, exitReason: 'ownerMismatch' }); return; }
          for (const row of shard.data.rows) rows.push({ witness: row.witness, vector: decodeVector(row.vector, dimensions), shardId: id });
          reportLoad({ ...diagnostic?.load, shardsRead: (diagnostic?.load?.shardsRead ?? 0) + 1 });
        }
        if (isEnabled() && captured === epoch && (!active || allowActive) && configKey(configProvider()) === configKey(config)) {
          cached = { key, rows, dimensions, manifest: { revision: manifest.revision, shardIds: [...manifest.data.shardIds], chunkCount: manifest.data.chunkCount } };
          if (!active && !updating) notify({ status: 'ready', completed: rows.length, total: rows.length, error: null });
        }
        if (diagnostic && !diagnostic.load?.exitReason) reportLoad({ ...diagnostic.load, pending: null, exitReason: 'ready' });
      } catch (error) {
        if (diagnostic) reportLoad({ ...diagnostic?.load, pending: null, exitReason: 'readFailed',
          backendCode: /^(?:BACKEND_|ROOT_|QQJ_)[A-Z0-9_]{1,80}$/u.test(error?.code ?? '') ? error.code : null,
          httpStatus: Number.isSafeInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : null });
        /* 缓存读取失败仍按既有行为退回无索引召回；快照只保留安全错误元数据。 */
      }
      finally { if (loading === job) loading = null; }
    })();
    return job.promise;
  }

  async function executeBuild(operation, incremental) {
    const owner = () => incremental ? updating === operation : active === operation;
    const guard = source => {
      if (!owner() || operation.controller.signal.aborted || epoch !== operation.epoch || !isEnabled()
        || source?.chatId !== operation.targetIdentity.chatId
        || JSON.stringify(configProvider()) !== operation.config) throw errorWith('VECTOR_ABORTED', '索引建立已取消。');
    };
    let phase = 'source';
    updateBuildDiagnostic(operation, { status: 'building', phase, batchNumber: 0, completedChunks: 0, totalChunks: 0,
      inputCount: 0, inputCharacters: 0, longestInputCharacters: 0, errorCode: null, httpStatus: null, request: null });
    try {
      const source = await sourceProvider({ targetIdentity: operation.targetIdentity, stage: 'source', sourceKey: operation.sourceKey });
      if (source?.status !== 'ready') {
        if (incremental) { updateBuildDiagnostic(operation, { status: 'skipped', phase: 'source' }); return { status: 'notReady' }; }
        throw errorWith('VECTOR_SOURCE_UNAVAILABLE', '当前聊天记忆尚未准备好。');
      }
      const chunks = vectorSourceChunks(source), modelKey = await hash(configKey(operation.configValue)), key = ownerKey(source, modelKey);
      updateBuildDiagnostic(operation, { phase: 'cache', totalChunks: chunks.length });
      operation.signature = JSON.stringify([key, chunks.map(value => rawChunkKey(value.witness))]);
      guard(source);
      if (incremental && (lastIncrementalFailureKey === operation.signature || lastIncrementalCancelledKey === operation.signature)) {
        updateBuildDiagnostic(operation, { status: 'skipped', phase: 'cache' }); return { status: 'suppressed' };
      }
      const collection = `chat-${source.chatId}`;
      phase = 'cache';
      const previous = await readRecord(collection, VECTOR_INDEX_ID);
      if (incremental && (!previous || !vectorRecordOwned(previous) || ownerKey(previous.data, previous.data.modelKey) !== key)) {
        updateBuildDiagnostic(operation, { status: 'skipped', phase: 'cache' }); return { status: 'notIndexed' };
      }
      // 冷启动和手动重复建索引先恢复已提交向量；后台不因缓存冷而重算整档。
      if (cached?.key !== key) await load(source, operation.configValue, modelKey, null, { allowActive: !incremental });
      guard(source);
      if (cached?.key !== key) {
        updateBuildDiagnostic(operation, { status: 'skipped', phase: 'cache' });
        return incremental ? { status: 'notIndexed' } : { status: 'unavailable' };
      }
      const cachedRawRows = cached.rows.filter(row => rawWitnessShape(row.witness));
      if (incremental && previous.data.chunkCount > 0 && cachedRawRows.length === 0) {
        updateBuildDiagnostic(operation, { status: 'skipped', phase: 'cache' });
        return { status: 'legacySummaryOnly' };
      }
      const reusable = new Map(cachedRawRows.map(row => [rawChunkKey(row.witness), row]));
      const currentKeys = new Set(chunks.map(value => rawChunkKey(value.witness)));
      if (incremental && currentKeys.size === reusable.size && [...currentKeys].every(value => reusable.has(value))) {
        updateBuildDiagnostic(operation, { status: 'ready', phase: 'complete', completedChunks: chunks.length, totalChunks: chunks.length });
        return { status: 'unchanged', chunkCount: chunks.length };
      }
      notify({ status: 'building', completed: 0, total: chunks.length, error: null, background: incremental, cancelled: false });
      const rows = [], shardIds = [];
      const previousShardIds = new Set(previous?.data?.shardIds ?? []);
      let dimensions = null;
      for (let start = 0; start < chunks.length; start += BATCH) {
        guard(source);
        const batch = chunks.slice(start, start + BATCH);
        updateBuildDiagnostic(operation, { phase: 'cache', batchNumber: Math.floor(start / BATCH) + 1,
          completedChunks: rows.length, totalChunks: chunks.length, inputCount: 0, inputCharacters: 0, longestInputCharacters: 0, request: null });
        const { witnesses, id: expectedId } = await batchWitnesses(source, modelKey, batch, reusable);
        let savedBatch = null, existingBatch = null;
        let persistedBatch = false;
        const cachedBatchRows = batch.map(value => reusable.get(rawChunkKey(value.witness)) ?? null);
        if (cachedBatchRows.every(Boolean)) {
          const cachedDimensions = cachedBatchRows[0].vector.length;
          if (cachedBatchRows.every((row, index) => row.vector.length === cachedDimensions && witnessMatches(row.witness, witnesses[index]))
            && (!dimensions || cachedDimensions === dimensions)) {
            savedBatch = { rows: cachedBatchRows.map((row, index) => ({ witness: witnesses[index], vector: row.vector })), dimensions: cachedDimensions };
          }
        }
        // A failed build may already have persisted this exact batch; check its deterministic ID before re-embedding.
        if (!previousShardIds.has(expectedId)) {
          phase = 'cache';
          existingBatch = await readRecord(collection, expectedId); guard(source);
          const persisted = await validSavedBatch(existingBatch, source, modelKey, batch, witnesses, expectedId, dimensions);
          if (persisted) { savedBatch = persisted; persistedBatch = true; }
        }
        let batchRows;
        if (savedBatch) {
          batchRows = savedBatch.rows;
          dimensions ??= savedBatch.dimensions;
        } else {
          const missing = batch.filter((value, index) => !cachedBatchRows[index] || !witnessMatches(cachedBatchRows[index].witness, witnesses[index]));
          phase = 'embedding';
          const inputCharacters = missing.reduce((sum, value) => sum + value.text.length, 0);
          updateBuildDiagnostic(operation, { phase, batchNumber: Math.floor(start / BATCH) + 1, completedChunks: rows.length,
            totalChunks: chunks.length, inputCount: missing.length, inputCharacters,
            longestInputCharacters: missing.reduce((max, value) => Math.max(max, value.text.length), 0), request: null });
          const newVectors = missing.length ? await api.embed(operation.configValue, missing.map(value => value.text), {
            signal: operation.controller.signal,
            onProgress: value => updateBuildDiagnostic(operation, { request: value }),
            onDiagnostic: value => updateBuildDiagnostic(operation, { request: value, httpStatus: value.httpStatus ?? operation.buildDiagnostic?.httpStatus }),
          }) : [];
          let nextVector = 0;
          const vectors = batch.map((value, index) => {
            const cachedRow = cachedBatchRows[index];
            return cachedRow && witnessMatches(cachedRow.witness, witnesses[index]) ? cachedRow.vector : newVectors[nextVector++];
          });
          guard(source);
          dimensions ??= vectors[0]?.length;
          if (!dimensions || vectors.some(vector => vector.length !== dimensions)) throw errorWith('VECTOR_RESPONSE_INVALID', '向量维度不一致。');
          batchRows = batch.map((value, index) => ({
            witness: witnesses[index], vector: vectors[index],
          }));
        }
        const id = `${VECTOR_SHARD_PREFIX}${(await sha256(JSON.stringify([source.narrativeGeneration, modelKey, batchRows.map(row => row.witness)]))).slice(0, 40)}`;
        if (!persistedBatch && !previousShardIds.has(id)) {
          const storedRows = batchRows.map(row => ({ witness: row.witness, vector: encodeVector(row.vector) }));
          phase = 'cache';
          const existing = id === expectedId ? existingBatch : await readRecord(collection, id); guard(source);
          phase = 'save';
          await client.put(collection, id, { schemaVersion: SCHEMA, recordType: 'vectorCache', chatId: source.chatId, narrativeGeneration: source.narrativeGeneration, modelKey, rows: storedRows }, existing?.revision ?? 0, { signal: operation.controller.signal });
        }
        rows.push(...batchRows.map(row => ({ ...row, shardId: id })));
        shardIds.push(id); notify({ completed: rows.length });
        updateBuildDiagnostic(operation, { phase: 'cache', completedChunks: rows.length, totalChunks: chunks.length });
      }
      // 先完整写入新 shard，再核验原文并 CAS 切换 manifest；失败时旧索引仍可查询。
      phase = 'verification';
      updateBuildDiagnostic(operation, { phase, completedChunks: rows.length, totalChunks: chunks.length });
      const fresh = await sourceProvider({ targetIdentity: operation.targetIdentity, stage: 'verification', sourceKey: operation.sourceKey }); guard(source);
      const valid = new Set((fresh?.rawSources ?? []).map(rawSourceKey));
      if (fresh?.chatId !== source.chatId || fresh?.narrativeGeneration !== source.narrativeGeneration
        || rows.some(row => !valid.has(rawSourceKey(row.witness)))) throw errorWith('VECTOR_SOURCE_CHANGED', '来源已变化，请重新建立索引。');
      phase = 'save';
      updateBuildDiagnostic(operation, { phase, completedChunks: rows.length, totalChunks: chunks.length });
      await client.put(collection, VECTOR_INDEX_ID, { schemaVersion: SCHEMA, recordType: 'vectorCache', chatId: source.chatId, narrativeGeneration: source.narrativeGeneration, modelKey, dimensions: dimensions ?? cached.dimensions ?? operation.configValue.dimensions ?? 1024, shardIds, chunkCount: rows.length }, previous?.revision ?? 0, { signal: operation.controller.signal });
      guard(source);
      cached = { key, rows, dimensions: dimensions ?? cached.dimensions ?? operation.configValue.dimensions ?? 1024,
        manifest: { revision: (previous?.revision ?? 0) + 1, shardIds, chunkCount: rows.length } };
      lastIncrementalFailureKey = null; lastIncrementalCancelledKey = null;
      updateBuildDiagnostic(operation, { status: 'ready', phase: 'complete', completedChunks: rows.length, totalChunks: chunks.length, errorCode: null, httpStatus: null });
      notify({ status: 'ready', error: null, background: false }); return { status: 'ready', chunkCount: rows.length };
    } catch (error) {
      // 只公开阶段与 HTTP 状态，不把后端正文或网络异常中的凭证放进提示。
      const labels = { source: '读取原文', cache: '读取索引', embedding: '生成向量', verification: '核验原文', save: '索引保存' };
      const detail = Number.isSafeInteger(error?.status) ? `（HTTP ${error.status}）` : error?.code === 'BACKEND_TIMEOUT' ? '（请求超时）' : '';
      const safe = operation.controller.signal.aborted ? errorWith('VECTOR_ABORTED', '索引建立已取消。')
        : String(error?.code ?? '').startsWith('VECTOR_') ? error : errorWith(`VECTOR_${phase.toUpperCase()}_FAILED`, `${labels[phase]}失败${detail}，请重试。`);
      updateBuildDiagnostic(operation, { status: safe.code === 'VECTOR_ABORTED' ? 'cancelled' : 'failed', phase,
        errorCode: safe.code, httpStatus: Number.isSafeInteger(error?.status) ? error.status : operation.buildDiagnostic?.httpStatus });
      if (incremental && operation.signature) {
        if (safe.code === 'VECTOR_ABORTED') {
          if (operation.userCancelled === true) lastIncrementalCancelledKey = operation.signature;
        } else lastIncrementalFailureKey = operation.signature;
      }
      notify({ status: safe.code === 'VECTOR_ABORTED' ? 'idle' : 'error', error: safe.message, background: false });
      if (incremental) return { status: safe.code === 'VECTOR_ABORTED' ? 'cancelled' : 'error', error: safe.message };
      throw safe;
    } finally {
      if (incremental && updating === operation) {
        updating = null; notify({});
      }
      if (!incremental && active === operation) { active = null; notify({}); }
    }
  }

  async function build() {
    if (active || updating) return { status: 'busy' };
    queryOperation?.controller.abort();
    const config = configProvider();
    if (!config || !isEnabled()) throw errorWith('VECTOR_DISABLED', '请先启用向量 API。');
    const operation = { controller: new AbortController(), epoch, targetIdentity: targetIdentity(), configValue: config, config: JSON.stringify(config), sourceKey: null };
    active = operation; lastIncrementalFailureKey = null; lastIncrementalCancelledKey = null;
    notify({ status: 'building', completed: 0, total: 0, error: null, background: false, cancelled: false });
    return executeBuild(operation, false);
  }

  async function updateIncrementally(task = {}) {
    if (active) return { status: 'busy' };
    if (updating) return { status: 'busy' };
    const config = task.config ?? configProvider();
    if (!config || !isEnabled()) return { status: 'disabled' };
    const operation = { controller: new AbortController(), epoch, targetIdentity: targetIdentity(task.targetIdentity),
      configValue: config, config: JSON.stringify(config), sourceKey: task.sourceKey ?? null, signature: null };
    updating = operation;
    operation.promise = executeBuild(operation, true);
    return operation.promise;
  }

  function cancelIncrementally(reason = 'external') {
    if (!updating) return false;
    updating.controller.abort(reason);
    return true;
  }

  async function copyPrefix(sourceIdentity, targetIdentity, targetNarrativeGeneration, sourceReachable) {
    const config = configProvider();
    if (!config || !sourceIdentity?.chatId || !targetIdentity?.chatId || sourceIdentity.chatId === targetIdentity.chatId
      || typeof targetNarrativeGeneration !== 'string' || sourceReachable?.root?.chatId !== sourceIdentity.chatId
      || sourceReachable.status !== 'ready') return Object.freeze([]);
    const selected = selectRecallMemories(sourceReachable);
    const { rawSources } = await projectVectorSources(selected.activeMemories, selected.floors, { includeSummaries: false });
    const source = { status: 'ready', chatId: sourceReachable.root.chatId, narrativeGeneration: sourceReachable.root.narrativeGeneration, rawSources };
    const modelKey = await hash(configKey(config));
    const manifest = await readRecord(`chat-${source.chatId}`, VECTOR_INDEX_ID);
    if (!manifest || !vectorRecordOwned(manifest) || ownerKey(manifest.data, modelKey) !== ownerKey(source, modelKey)) return Object.freeze([]);
    const rows = [];
    for (const id of manifest.data.shardIds) {
      const shard = await readRecord(`chat-${source.chatId}`, id);
      if (!shard || !vectorRecordOwned(shard) || ownerKey(shard.data, modelKey) !== ownerKey(source, modelKey)) return Object.freeze([]);
      for (const row of shard.data.rows) {
        if (!rawWitnessShape(row.witness) || !await rawWitnessValid(row.witness, source)) continue;
        decodeVector(row.vector, manifest.data.dimensions);
        rows.push(row);
      }
    }
    const shardIds = [];
    for (let start = 0; start < rows.length; start += BATCH) {
      const batch = rows.slice(start, start + BATCH);
      const id = `${VECTOR_SHARD_PREFIX}${(await sha256(JSON.stringify([targetNarrativeGeneration, modelKey, batch.map(row => row.witness)]))).slice(0, 40)}`;
      await client.put(`chat-${targetIdentity.chatId}`, id, { schemaVersion: SCHEMA, recordType: 'vectorCache',
        chatId: targetIdentity.chatId, narrativeGeneration: targetNarrativeGeneration, modelKey, rows: batch }, 0);
      shardIds.push(id);
    }
    await client.put(`chat-${targetIdentity.chatId}`, VECTOR_INDEX_ID, { schemaVersion: SCHEMA, recordType: 'vectorCache',
      chatId: targetIdentity.chatId, narrativeGeneration: targetNarrativeGeneration, modelKey,
      dimensions: manifest.data.dimensions, shardIds, chunkCount: rows.length }, 0);
    return Object.freeze(shardIds);
  }

  async function getResumableShardIds(reachable, records) {
    const config = configProvider();
    const root = reachable?.root;
    if (!isEnabled() || !config || reachable?.status !== 'ready' || !root?.chatId || !root?.narrativeGeneration || !Array.isArray(records)) return Object.freeze([]);
    const modelKey = await hash(configKey(config));
    const manifest = records.find(record => record.recordId === VECTOR_INDEX_ID && vectorRecordOwned(record)
      && record.data.chatId === root.chatId && record.data.narrativeGeneration === root.narrativeGeneration
      && record.data.modelKey === modelKey);
    const referenced = new Set(manifest?.data?.shardIds ?? []);
    const candidates = new Map(records.filter(record => vectorRecordOwned(record)
      && record.recordId.startsWith(VECTOR_SHARD_PREFIX) && record.data.chatId === root.chatId
      && record.data.narrativeGeneration === root.narrativeGeneration && record.data.modelKey === modelKey
      && !referenced.has(record.recordId)).map(record => [record.recordId, record]));
    if (!candidates.size) return Object.freeze([]);
    const selected = selectRecallMemories(reachable);
    const { rawSources } = await projectVectorSources(selected.activeMemories, selected.floors, { includeSummaries: false });
    const source = { status: 'ready', chatId: root.chatId, narrativeGeneration: root.narrativeGeneration, rawSources };
    const chunks = vectorSourceChunks(source), resumable = [];
    for (let start = 0; start < chunks.length; start += BATCH) {
      const batch = chunks.slice(start, start + BATCH);
      const { witnesses, id } = await batchWitnesses(source, modelKey, batch);
      const record = candidates.get(id);
      if (!record) continue;
      const valid = await validSavedBatch(record, source, modelKey, batch, witnesses, id);
      if (valid) resumable.push(id);
    }
    return Object.freeze(resumable);
  }

  async function query({ source, queryContext, signal, eligibleFloorMemoryIds = null } = {}) {
    const started = Date.now();
    const requestScope = requestScopeFor(signal);
    let requestDiagnostic = null, requestConfig = null, requestText = '';
    const legacyResult = (status, candidates = []) => ({ candidates, diagnostic: { status, candidateCount: candidates.length, durationMs: Date.now() - started,
      ...(requestDiagnostic ? { request: requestDiagnostic } : {}) } });
    if (active || queryOperation) return legacyResult('busy');
    const captured = epoch;
    const operation = { id: `vq-${started}-${++querySerial}`, controller: new AbortController(), source, epoch: captured,
      started, step: null, lastCompletedStep: null, timings: {}, request: requestScope.requestAttempts.at(-1) ? { ...requestScope.requestAttempts.at(-1) } : null, requestAttempts: requestScope.requestAttempts.slice(0, 2),
      requestCount: requestScope.requestCount, retryOutcome: requestScope.retryOutcome,
      totalIndexRows: null, eligibleRows: null, candidateCount: 0, cached: false, status: 'running', timeoutOrigin: null, errorCode: null };
    queryOperation = operation;
    const publish = (terminal = false) => {
      if (queryOperation !== operation || !terminal && operation.epoch !== epoch) return;
      querySnapshot = Object.freeze({ queryId: operation.id, chatId: source?.chatId ?? null, status: operation.status,
        pendingStep: operation.step, lastCompletedStep: operation.lastCompletedStep, timings: Object.freeze({ ...operation.timings,
          ...(operation.step ? { [`${operation.step}Ms`]: Math.max(0, Date.now() - operation.stepStarted) } : {}) }),
        request: operation.request ? Object.freeze({ ...operation.request }) : null,
        requestAttempts: Object.freeze(requestScope.requestAttempts.slice(0, 2).map(value => Object.freeze({ ...value }))),
        requestCount: requestScope.requestCount, retryOutcome: requestScope.retryOutcome, cached: operation.cached,
        totalIndexRows: operation.totalIndexRows, eligibleRows: operation.eligibleRows, candidateCount: operation.candidateCount,
        timeoutOrigin: operation.timeoutOrigin, errorCode: operation.errorCode, load: operation.load ? Object.freeze({ ...operation.load }) : null,
        abortOrigin: operation.abortOrigin ?? null, abortReason: operation.abortReason ?? null, elapsedMs: Math.max(0, Date.now() - operation.started) });
      try { notify({}); } catch { /* 私有诊断订阅失败不能中断向量召回。 */ }
    };
    operation.onLoadProgress = () => publish();
    operation.publishTerminal = () => publish(true);
    const finishStep = () => {
      if (!operation.step) return;
      const key = `${operation.step}Ms`;
      operation.timings[key] = (operation.timings[key] ?? 0) + Math.max(0, Date.now() - operation.stepStarted);
      operation.lastCompletedStep = operation.step;
      operation.step = null;
    };
    const step = name => {
      finishStep();
      operation.step = name;
      operation.stepStarted = Date.now();
      publish();
    };
    const complete = (status, candidates = []) => {
      operation.status = status; operation.candidateCount = candidates.length;
      const incomplete = ['timeout', 'cancelled', 'changed', 'error'].includes(status) || /^VECTOR_/u.test(status)
        || status === 'unavailable' && operation.load?.exitReason === 'readFailed';
      if (queryOperation === operation && operation.epoch === epoch) {
        if (incomplete) { publish(true); }
        else {
        finishStep(); operation.status = status; operation.candidateCount = candidates.length; operation.step = 'complete'; operation.stepStarted = Date.now();
        publish(true); finishStep(); operation.step = null; publish(true);
        }
      }
      const resultStatus = status === 'cached' ? 'ready' : status;
      return { candidates, diagnostic: { status: resultStatus, candidateCount: candidates.length, durationMs: Date.now() - started,
        ...(operation.id ? { queryId: operation.id } : {}), ...(operation.request ? { request: { ...operation.request } } : requestDiagnostic ? { request: requestDiagnostic } : {}),
        ...(requestScope.requestAttempts.length ? { requestCount: requestScope.requestCount, requestAttempts: requestScope.requestAttempts.slice(0, 2).map(value => ({ ...value })), retryOutcome: requestScope.retryOutcome } : {}) } };
    };
    const abortQuery = () => operation.controller.abort(signal?.reason);
    if (signal?.aborted) abortQuery(); else signal?.addEventListener('abort', abortQuery, { once: true });
    const changed = signature => operation.controller.signal.aborted || active || captured !== epoch || !isEnabled()
      || signature !== JSON.stringify(configProvider());
    const requestSnapshot = value => {
      const id = typeof value?.requestId === 'string' && /^[a-z0-9-]{1,80}$/iu.test(value.requestId) ? value.requestId : null;
      const fingerprint = typeof value?.inputSha256 === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value.inputSha256) ? value.inputSha256 :
        typeof value?.inputSha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.inputSha256) ? `sha256:${value.inputSha256}` : null;
      return { requestId: id, startedAt: typeof value?.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt)) ? value.startedAt : null,
        inputCharacters: Number.isSafeInteger(value?.inputCharacters) && value.inputCharacters >= 0 ? value.inputCharacters : null,
        inputSha256: fingerprint, deadlineMs: Number.isFinite(value?.deadlineMs ?? value?.timeoutMs) ? Math.max(0, value.deadlineMs ?? value.timeoutMs) : null,
        timeoutMs: Number.isFinite(value?.timeoutMs ?? value?.deadlineMs) ? Math.max(0, value.timeoutMs ?? value.deadlineMs) : null,
        elapsedMs: Number.isFinite(value?.elapsedMs ?? value?.durationMs) ? Math.max(0, value.elapsedMs ?? value.durationMs) : null,
        durationMs: Number.isFinite(value?.durationMs ?? value?.elapsedMs) ? Math.max(0, value.durationMs ?? value.elapsedMs) : null,
        deadlineOverrunMs: Number.isFinite(value?.deadlineOverrunMs) ? Math.max(0, value.deadlineOverrunMs) : null,
        phase: ['request', 'response', 'validation', 'complete'].includes(value?.phase) ? value.phase : null,
        pendingStage: ['request_prepared', 'fetch_call_start', 'fetch_called', 'response_headers', 'response_body', 'complete', 'aborted'].includes(value?.pendingStage) ? value.pendingStage : null,
        lastSuccessfulStage: ['request_prepared', 'fetch_called', 'response_headers', 'response_body', 'validated'].includes(value?.lastSuccessfulStage) ? value.lastSuccessfulStage : null,
        timeoutOrigin: value?.timeoutOrigin === 'vector_api_deadline' ? value.timeoutOrigin : null,
        abortOrigin: ['caller_signal', 'client_abort_all', 'vector_api_deadline'].includes(value?.abortOrigin) ? value.abortOrigin : null,
        abortReason: ['stopped', 'superseded', 'chatChanged', 'userChanged', 'narrativeChanged', 'disabled', 'invalidated', 'timeout', 'indexReset', 'external'].includes(value?.abortReason) ? value.abortReason : null,
        result: ['running', 'succeeded', 'timeout', 'failed', 'cancelled'].includes(value?.result) ? value.result : null,
        errorCode: typeof value?.errorCode === 'string' && /^VECTOR_[A-Z0-9_]{1,80}$/u.test(value.errorCode) ? value.errorCode : null,
        networkCode: typeof value?.networkCode === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/u.test(value.networkCode) ? value.networkCode : null,
        httpStatus: Number.isSafeInteger(value?.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? value.httpStatus : null,
        providerRequestId: typeof value?.providerRequestId === 'string' && (/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value.providerRequestId)
          || /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value.providerRequestId)) ? value.providerRequestId : null,
        providerError: safeProviderErrorFields(value.providerError),
        fetchCallMs: Number.isFinite(value?.fetchCallMs) ? Math.max(0, value.fetchCallMs) : null,
        responseHeadersMs: Number.isFinite(value?.responseHeadersMs) ? Math.max(0, value.responseHeadersMs) : null,
        responseBodyMs: Number.isFinite(value?.responseBodyMs) ? Math.max(0, value.responseBodyMs) : null };
    };
    const syncRequestScope = () => {
      operation.requestAttempts = requestScope.requestAttempts.slice(0, 2);
      operation.requestCount = requestScope.requestCount;
      operation.retryOutcome = requestScope.retryOutcome;
      publish();
    };
    const sendQueryRequest = async () => {
      if (requestScope.requestAttempts.length >= 2) throw errorWith('VECTOR_QUERY_BUDGET_EXHAUSTED', '向量请求次数已达本轮上限。');
      const attemptIndex = requestScope.requestAttempts.length;
      requestScope.requestAttempts[attemptIndex] = { ...requestSnapshot({ timeoutMs: VECTOR_QUERY_TIMEOUT_MS, deadlineMs: VECTOR_QUERY_TIMEOUT_MS }), result: 'running', errorCode: null };
      operation.request = requestScope.requestAttempts[attemptIndex];
      syncRequestScope();
      const update = value => {
        const snapshot = requestSnapshot(value);
        const fetchStarted = value?.pendingStage === 'fetch_called' || value?.lastSuccessfulStage === 'fetch_called'
          || ['response_headers', 'response_body', 'complete'].includes(value?.pendingStage);
        if (fetchStarted && !requestScope.requestSent[attemptIndex]) { requestScope.requestSent[attemptIndex] = true; requestScope.requestCount++; }
        const previous = requestScope.requestAttempts[attemptIndex];
        requestScope.requestAttempts[attemptIndex] = { ...snapshot, result: previous.result ?? 'running', errorCode: previous.errorCode ?? null };
        operation.request = requestScope.requestAttempts[attemptIndex];
        requestDiagnostic = operation.request;
        syncRequestScope();
      };
      try {
        const vector = (await api.embed(requestConfig, [requestText], { signal: operation.controller.signal, timeoutMs: VECTOR_QUERY_TIMEOUT_MS,
          onProgress: update, onDiagnostic: update }))[0];
        requestScope.requestAttempts[attemptIndex] = { ...requestScope.requestAttempts[attemptIndex], result: 'succeeded', errorCode: null };
        operation.request = requestScope.requestAttempts[attemptIndex]; requestDiagnostic = operation.request; syncRequestScope();
        return vector;
      } catch (error) {
        if (!requestScope.requestSent[attemptIndex] && (requestScope.requestAttempts[attemptIndex].pendingStage === 'fetch_called'
          || requestScope.requestAttempts[attemptIndex].lastSuccessfulStage === 'fetch_called')) { requestScope.requestSent[attemptIndex] = true; requestScope.requestCount++; }
        const errorCode = /^VECTOR_[A-Z0-9_]{1,80}$/u.test(error?.code ?? '') ? error.code : null;
        const result = error?.code === 'VECTOR_TIMEOUT' ? 'timeout' : error?.code === 'VECTOR_ABORTED' ? 'cancelled' : 'failed';
        requestScope.requestAttempts[attemptIndex] = { ...requestScope.requestAttempts[attemptIndex], result, errorCode };
        operation.request = requestScope.requestAttempts[attemptIndex]; requestDiagnostic = operation.request;
        if (result === 'cancelled') requestScope.retryOutcome = 'cancelled';
        if (attemptIndex > 0) {
          requestScope.retryOutcome = result === 'cancelled' ? 'cancelled' : 'retry_failed';
          if (result !== 'cancelled') requestScope.terminalCode = errorCode ?? 'VECTOR_CONNECTION_FAILED';
        }
        else if (result === 'failed') requestScope.terminalCode = errorCode ?? 'VECTOR_CONNECTION_FAILED';
        syncRequestScope();
        throw error;
      }
    };
    try {
      step('configIdentity');
      const config = configProvider();
      if (!config || !isEnabled()) return complete('disabled');
      if (operation.controller.signal.aborted) return complete('cancelled');
      const signature = JSON.stringify(config), modelKey = await hash(configKey(config)), key = ownerKey(source, modelKey);
      requestConfig = config;
      if (changed(signature)) return complete('changed');
      if (cached?.key !== key) {
        step('indexLoad');
        // 索引读取单独受十五秒 deadline 约束；这不是向量 API timeout。
        let timer, onAbort;
        try {
        await Promise.race([load(source, config, modelKey, operation), new Promise((_, reject) => {
            onAbort = () => reject(errorWith('VECTOR_ABORTED', '向量请求已取消。'));
            if (operation.controller.signal.aborted) onAbort(); else operation.controller.signal.addEventListener('abort', onAbort, { once: true });
            timer = setTimeout(() => reject(errorWith('VECTOR_INDEX_LOAD_TIMEOUT', '向量索引读取超时。')), INDEX_LOAD_TIMEOUT_MS);
          })]);
        } finally { clearTimeout(timer); operation.controller.signal.removeEventListener('abort', onAbort); }
        if (changed(signature)) return complete('changed');
        if (cached?.key !== key) {
          if (operation.load?.exitReason !== 'readFailed') finishStep();
          else operation.errorCode = operation.load.backendCode;
          return complete('unavailable');
        }
      }
      // A request continues against the index it loaded, even if another target replaces the single warm slot.
      const indexSnapshot = cached;
      const indexDimensions = indexSnapshot.dimensions;
      operation.totalIndexRows = indexSnapshot.rows.length;
      step('eligibility');
      const raws = new Map((source.rawSources ?? []).map(raw => [rawSourceKey(raw), raw]));
      const covered = new Set(source.bodyMatch?.recentBodyFloorIds ?? source.bodyMatch?.coveredFloorIds ?? []);
      const eligible = eligibleFloorMemoryIds ? new Set(eligibleFloorMemoryIds) : null;
      // 已发布的摘要向量可解码，但不能成为新一轮查询候选。
      const rows = indexSnapshot.rows.filter(row => {
        if (!rawWitnessShape(row.witness)) return false;
        const raw = raws.get(rawSourceKey(row.witness));
        return Boolean(raw && !covered.has(row.witness.floorId) && (!eligible || eligible.has(raw.floorMemoryId)));
      });
      operation.eligibleRows = rows.length;
      if (changed(signature)) return complete('changed');
      if (!rows.length) return complete('unindexed');
      const text = String(queryContext?.text ?? '').slice(0, 6000);
      requestText = text;
      const reused = lastQuery?.key === key && lastQuery.text === text;
      let vector;
      if (reused) {
        step('queryCache'); operation.cached = true; vector = lastQuery.vector; finishStep(); publish();
      } else {
        if (requestScope.terminalCode) {
          operation.errorCode = requestScope.terminalCode;
          if (requestScope.terminalCode === 'VECTOR_TIMEOUT') operation.timeoutOrigin = 'api';
          const result = complete(requestScope.terminalCode === 'VECTOR_TIMEOUT' ? 'timeout' : 'error');
          return { ...result, diagnostic: { ...result.diagnostic, status: requestScope.terminalCode } };
        }
        if (requestScope.requestCount >= 2) {
          requestScope.retryOutcome = 'budget_exhausted'; syncRequestScope();
          operation.errorCode = 'VECTOR_QUERY_BUDGET_EXHAUSTED';
          const result = complete('error');
          return { ...result, diagnostic: { ...result.diagnostic, status: 'VECTOR_QUERY_BUDGET_EXHAUSTED' } };
        }
        step('queryRequest');
        // 浏览器 fetch 没有 body-sent 信号：只报告生产 client 可见的调用与响应边界。
        // 同一 signal 是整轮召回的预算边界；内层超时最多补发一次，外层重算不能重置次数。
        try { vector = await sendQueryRequest(); }
        catch (error) {
          if (error?.code !== 'VECTOR_TIMEOUT') throw error;
          if (changed(signature)) {
            requestScope.retryOutcome = 'cancelled'; syncRequestScope();
            return complete(operation.controller.signal.aborted ? 'cancelled' : 'changed');
          }
          if (requestScope.requestCount >= 2) {
            requestScope.retryOutcome = 'budget_exhausted'; syncRequestScope();
            operation.errorCode = 'VECTOR_QUERY_BUDGET_EXHAUSTED';
            const result = complete('error');
            return { ...result, diagnostic: { ...result.diagnostic, status: 'VECTOR_QUERY_BUDGET_EXHAUSTED' } };
          }
          requestScope.retryOutcome = 'retrying'; syncRequestScope();
          if (changed(signature)) {
            requestScope.retryOutcome = 'cancelled'; syncRequestScope();
            return complete(operation.controller.signal.aborted ? 'cancelled' : 'changed');
          }
          try { vector = await sendQueryRequest(); requestScope.retryOutcome = 'retry_succeeded'; syncRequestScope(); }
          catch (retryError) {
            requestScope.retryOutcome = retryError?.code === 'VECTOR_ABORTED' ? 'cancelled' : 'retry_failed'; syncRequestScope();
            if (retryError?.code !== 'VECTOR_ABORTED') requestScope.terminalCode = /^VECTOR_[A-Z0-9_]{1,80}$/u.test(retryError?.code ?? '') ? retryError.code : 'VECTOR_CONNECTION_FAILED';
            throw retryError;
          }
        }
        if (changed(signature)) return complete('changed');
        finishStep();
      }
      if (changed(signature)) return complete('changed');
      if (vector.length !== indexDimensions) return complete('dimensionMismatch');
      if (!reused) lastQuery = { key, text, vector };
      step('scoring');
      const scored = [];
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        let score = 0;
        for (let dimension = 0; dimension < vector.length; dimension += 1) score += vector[dimension] * row.vector[dimension];
        scored.push({ ...row, score });
        if (index % 256 === 255) {
          await new Promise(resolve => setTimeout(resolve, 0));
          if (changed(signature)) return complete('changed');
        }
      }
      scored.sort((a, b) => b.score - a.score || a.witness.assistantSeq - b.witness.assistantSeq || a.witness.offset - b.witness.offset);
      step('witnessVerification');
      const candidates = [];
      for (const row of scored.slice(0, 12)) {
        const raw = raws.get(rawSourceKey(row.witness));
        const text = raw.canonicalContent.slice(row.witness.offset, row.witness.offset + row.witness.length);
        if (await hash(text) !== row.witness.textFingerprint) continue;
        candidates.push({ text, witness: bindRawWitness(raw, row.witness), similarity: row.score });
      }
      if (changed(signature)) return complete('changed');
      operation.candidateCount = candidates.length;
      return complete(reused ? 'cached' : 'ready', candidates);
    } catch (error) {
      const code = String(error?.code ?? '');
      if (code === 'VECTOR_INDEX_LOAD_TIMEOUT') operation.timeoutOrigin = 'index_load';
      else if (code === 'VECTOR_TIMEOUT' || operation.request?.timeoutOrigin === 'vector_api_deadline') operation.timeoutOrigin = 'api';
      const status = code === 'VECTOR_INDEX_LOAD_TIMEOUT' || code === 'VECTOR_TIMEOUT' ? 'timeout'
        : code === 'VECTOR_ABORTED' ? 'cancelled' : code.startsWith('VECTOR_') ? 'error' : 'unavailable';
      operation.errorCode = /^VECTOR_[A-Z0-9_]{1,80}$/u.test(code) ? code : null;
      const result = complete(status);
      return code.startsWith('VECTOR_') ? { ...result, diagnostic: { ...result.diagnostic, status: code } } : result;
    } finally {
      signal?.removeEventListener('abort', abortQuery);
      if (queryOperation === operation) queryOperation = null;
    }
  }
  return Object.freeze({
    build, updateIncrementally, query, getState: () => ({ ...state, active: Boolean(active || updating && state.status === 'building'), updating: Boolean(updating), background: Boolean(updating && state.status === 'building'), query: querySnapshot }), subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    cancelIncrementally,
    copyPrefix,
    getResumableShardIds,
    abortAll({ userInitiated = false } = {}) {
      const pending = queryOperation;
      if (pending) {
        pending.status = 'cancelled'; pending.errorCode = 'VECTOR_ABORTED'; pending.abortOrigin = 'client_abort_all'; pending.abortReason = 'indexReset';
        pending.controller.abort('indexReset'); pending.publishTerminal?.();
      }
      if (updating) {
        updating.userCancelled = userInitiated === true;
        updating.controller.abort('indexReset');
      }
      epoch += 1; active?.controller.abort('indexReset'); cached = null; lastQuery = null;
      notify({ status: 'idle', completed: 0, total: 0, error: null, background: false, cancelled: true, userCancelled: userInitiated === true });
    },
  });
}
