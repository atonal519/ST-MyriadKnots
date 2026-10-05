import { sha256 } from '../identity.js';
import { normalizeVector } from '../vector-api.js';
import { summaryWitnessShape, vectorWitnessShape } from './vector-source.js';

export const VECTOR_INDEX_ID = 'qqj-vector-index';
export const VECTOR_SHARD_PREFIX = 'qqj-vector-shard-';
const SCHEMA = 1, BATCH = 16, INDEX_LOAD_TIMEOUT_MS = 15000, VECTOR_QUERY_TIMEOUT_MS = 15000;
const hash = async value => `sha256:${await sha256(value)}`;
const configKey = config => JSON.stringify([config.url, config.model, config.dimensions]);
const ownerKey = (source, modelKey) => JSON.stringify([source.chatId, source.narrativeGeneration, modelKey]);
const sourceKey = value => `${value.sourceKind ?? 'raw'}|${value.floorMemoryId}|${value.floorId}|${value.fingerprint}`;
const witnessKey = value => JSON.stringify([sourceKey(value), value.assistantSeq, value.memoryFloorId, value.memoryAssistantSeq, value.offset, value.length]);
const errorWith = (code, message) => Object.assign(new Error(message), { code });

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
    for (let offset = 0; offset < raw.canonicalContent.length; offset += 320) {
      const text = raw.canonicalContent.slice(offset, offset + 400);
      if (text.trim()) chunks.push({ text, witness: {
        floorId: raw.floorId, assistantSeq: raw.assistantSeq, floorMemoryId: raw.floorMemoryId,
        memoryFloorId: raw.memoryFloorId, memoryAssistantSeq: raw.memoryAssistantSeq,
        fingerprint: raw.fingerprint, offset, length: text.length,
      } });
      if (offset + 400 >= raw.canonicalContent.length) break;
    }
    return chunks;
  });
}

export function summarySourceChunks(source) {
  return (source.summarySources ?? []).flatMap(summary => {
    const chunks = [];
    for (let offset = 0; offset < summary.canonicalContent.length; offset += 320) {
      const text = summary.canonicalContent.slice(offset, offset + 400);
      if (text.trim()) chunks.push({ text, witness: {
        sourceKind: summary.sourceKind, floorId: summary.floorId, assistantSeq: summary.assistantSeq, floorMemoryId: summary.floorMemoryId,
        memoryFloorId: summary.memoryFloorId, memoryAssistantSeq: summary.memoryAssistantSeq,
        fingerprint: summary.fingerprint, offset, length: text.length,
      } });
      if (offset + 400 >= summary.canonicalContent.length) break;
    }
    return chunks;
  });
}

const vectorSourceChunks = source => [...rawSourceChunks(source), ...summarySourceChunks(source)];

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

// 索引是可删除的派生缓存；保存向量与片段见证，原文始终从当前可达 FloorMemory 读取。
export function createVectorIndex({ client, api, configProvider, sourceProvider, identityProvider, isEnabled = () => true } = {}) {
  let cached = null, lastQuery = null, loading = null, active = null, queryOperation = null, querySnapshot = null, querySerial = 0, epoch = 0;
  const requestScopes = new WeakMap();
  const newRequestScope = () => ({ requestCount: 0, requestAttempts: [], requestSent: [], retryOutcome: 'not_retried', terminalCode: null });
  const requestScopeFor = signal => {
    if (!signal || typeof signal !== 'object') return newRequestScope();
    let scope = requestScopes.get(signal);
    if (!scope) { scope = newRequestScope(); requestScopes.set(signal, scope); }
    return scope;
  };
  let state = { status: 'idle', completed: 0, total: 0, error: null };
  const subscribers = new Set();
  const notify = patch => { state = { ...state, ...patch }; for (const fn of subscribers) fn({ ...state }); };
  const identityMatches = source => {
    try { return isEnabled() && identityProvider().chatId === source.chatId; } catch { return false; }
  };
  const readRecord = async (collection, recordId) => {
    // 新派生记录尚不存在是正常状态；白鳥 GET 的信封不带编号，由请求路径提供。
    try { return { ...await client.get(collection, recordId), recordId }; }
    catch (error) { if (error?.status === 404) return null; throw error; }
  };
  function load(source, config, modelKey, diagnostic = null) {
    const key = ownerKey(source, modelKey), captured = epoch;
    const reportLoad = value => { if (diagnostic) { diagnostic.load = value; diagnostic.onLoadProgress?.(); } };
    if (loading?.key === key && loading.epoch === captured) return loading.promise;
    const job = { key, epoch: captured, promise: null }; loading = job;
    job.promise = (async () => {
      try {
        reportLoad({ pending: 'manifest', shardsRead: 0, shardCount: null, exitReason: null, backendCode: null, httpStatus: null });
        const manifest = await readRecord(`chat-${source.chatId}`, VECTOR_INDEX_ID);
        if (!manifest) {
          reportLoad({ ...diagnostic?.load, pending: null, exitReason: 'missing' });
          if (captured === epoch && !active && identityMatches(source) && configKey(configProvider()) === configKey(config)) cached = { key, rows: [], dimensions: 1024 };
          return;
        }
        if (!vectorRecordOwned(manifest)) {
          reportLoad({ ...diagnostic?.load, pending: null, exitReason: 'invalid' });
          if (captured === epoch && !active && identityMatches(source) && configKey(configProvider()) === configKey(config)) cached = { key, rows: [], dimensions: 1024 };
          return;
        }
        if (ownerKey(manifest.data, manifest.data.modelKey) !== key) {
          reportLoad({ ...diagnostic?.load, pending: null, exitReason: 'ownerMismatch' });
          if (captured === epoch && !active && identityMatches(source) && configKey(configProvider()) === configKey(config)) cached = { key, rows: [], dimensions: 1024 };
          return;
        }
        const rows = [];
        const dimensions = manifest.data.dimensions;
        reportLoad({ ...diagnostic?.load, pending: 'shard', shardCount: manifest.data.shardIds.length });
        if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 8192) { reportLoad({ ...diagnostic?.load, pending: null, exitReason: 'invalid' }); return; }
        for (const id of manifest.data.shardIds) {
          if (captured !== epoch || active || !identityMatches(source)) return;
          const shard = await readRecord(`chat-${source.chatId}`, id);
          if (!shard) { reportLoad({ ...diagnostic?.load, pending: null, exitReason: 'missing' }); return; }
          if (!vectorRecordOwned(shard)) { reportLoad({ ...diagnostic?.load, pending: null, exitReason: 'invalid' }); return; }
          if (ownerKey(shard.data, shard.data.modelKey) !== key) { reportLoad({ ...diagnostic?.load, pending: null, exitReason: 'ownerMismatch' }); return; }
          for (const row of shard.data.rows) rows.push({ witness: row.witness, vector: decodeVector(row.vector, dimensions) });
          reportLoad({ ...diagnostic?.load, shardsRead: (diagnostic?.load?.shardsRead ?? 0) + 1 });
        }
        if (captured === epoch && !active && identityMatches(source) && configKey(configProvider()) === configKey(config)) {
          cached = { key, rows, dimensions }; notify({ status: 'ready', completed: rows.length, total: rows.length, error: null });
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

  async function build() {
    if (active) return { status: 'busy' };
    queryOperation?.controller.abort();
    const config = configProvider();
    if (!config) throw errorWith('VECTOR_DISABLED', '请先启用向量 API。');
    const operation = { controller: new AbortController(), epoch, config: JSON.stringify(config) }; active = operation;
    const guard = source => {
      if (active !== operation || operation.controller.signal.aborted || epoch !== operation.epoch || !identityMatches(source)
        || JSON.stringify(configProvider()) !== operation.config) throw errorWith('VECTOR_ABORTED', '索引建立已取消。');
    };
    notify({ status: 'building', completed: 0, total: 0, error: null });
    let phase = 'source';
    try {
      const source = await sourceProvider();
      if (source?.status !== 'ready') throw errorWith('VECTOR_SOURCE_UNAVAILABLE', '当前聊天记忆尚未准备好。');
      guard(source);
      const chunks = vectorSourceChunks(source), modelKey = await hash(configKey(config)), collection = `chat-${source.chatId}`;
      const reusable = cached?.key === ownerKey(source, modelKey) ? new Map(cached.rows.map(row => [witnessKey(row.witness), row])) : new Map();
      notify({ total: chunks.length });
      phase = 'cache';
      const previous = await readRecord(collection, VECTOR_INDEX_ID), rows = [], shardIds = [];
      let dimensions = null;
      for (let start = 0; start < chunks.length; start += BATCH) {
        guard(source);
        const batch = chunks.slice(start, start + BATCH);
        const missing = batch.filter(value => !reusable.has(witnessKey(value.witness)));
        phase = 'embedding';
        const newVectors = missing.length ? await api.embed(config, missing.map(value => value.text), { signal: operation.controller.signal }) : [];
        let nextVector = 0;
        const vectors = batch.map(value => reusable.get(witnessKey(value.witness))?.vector ?? newVectors[nextVector++]);
        guard(source);
        dimensions ??= vectors[0].length;
        if (vectors.some(vector => vector.length !== dimensions)) throw errorWith('VECTOR_RESPONSE_INVALID', '向量维度不一致。');
        const storedRows = [];
        for (let index = 0; index < batch.length; index += 1) {
          const witness = reusable.get(witnessKey(batch[index].witness))?.witness ?? { ...batch[index].witness, textFingerprint: await hash(batch[index].text) };
          storedRows.push({ witness, vector: encodeVector(vectors[index]) });
          rows.push({ witness, vector: vectors[index] });
        }
        const id = `${VECTOR_SHARD_PREFIX}${(await sha256(JSON.stringify([source.narrativeGeneration, modelKey, storedRows.map(row => row.witness)]))).slice(0, 40)}`;
        phase = 'cache';
        const existing = await readRecord(collection, id); guard(source);
        phase = 'save';
        await client.put(collection, id, { schemaVersion: SCHEMA, recordType: 'vectorCache', chatId: source.chatId, narrativeGeneration: source.narrativeGeneration, modelKey, rows: storedRows }, existing?.revision ?? 0, { signal: operation.controller.signal });
        shardIds.push(id); notify({ completed: rows.length });
      }
      // 构建期间允许新增独立楼，但旧来源的删除、人工修订或切换世代会撤销提交。
      phase = 'verification';
      const fresh = await sourceProvider(); guard(source);
      const valid = new Set([...(fresh?.rawSources ?? []), ...(fresh?.summarySources ?? [])].map(sourceKey));
      if (fresh?.narrativeGeneration !== source.narrativeGeneration || rows.some(row => !valid.has(sourceKey(row.witness)))) throw errorWith('VECTOR_SOURCE_CHANGED', '来源已变化，请重新建立索引。');
      phase = 'save';
      await client.put(collection, VECTOR_INDEX_ID, { schemaVersion: SCHEMA, recordType: 'vectorCache', chatId: source.chatId, narrativeGeneration: source.narrativeGeneration, modelKey, dimensions: dimensions ?? config.dimensions ?? 1024, shardIds, chunkCount: rows.length }, previous?.revision ?? 0, { signal: operation.controller.signal });
      guard(source);
      cached = { key: ownerKey(source, modelKey), rows, dimensions: dimensions ?? config.dimensions ?? 1024 };
      notify({ status: 'ready', error: null }); return { status: 'ready', chunkCount: rows.length };
    } catch (error) {
      // 只公开阶段与 HTTP 状态，不把后端正文或网络异常中的凭证放进提示。
      const labels = { source: '读取原文', cache: '读取索引', embedding: '生成向量', verification: '核验原文', save: '索引保存' };
      const detail = Number.isSafeInteger(error?.status) ? `（HTTP ${error.status}）` : error?.code === 'BACKEND_TIMEOUT' ? '（请求超时）' : '';
      const safe = operation.controller.signal.aborted ? errorWith('VECTOR_ABORTED', '索引建立已取消。')
        : String(error?.code ?? '').startsWith('VECTOR_') ? error : errorWith(`VECTOR_${phase.toUpperCase()}_FAILED`, `${labels[phase]}失败${detail}，请重试。`);
      notify({ status: safe.code === 'VECTOR_ABORTED' ? 'idle' : 'error', error: safe.message });
      throw safe;
    } finally { if (active === operation) { active = null; notify({}); } }
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
      if (queryOperation !== operation || !terminal && (operation.epoch !== epoch || !identityMatches(source))) return;
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
    const changed = signature => operation.controller.signal.aborted || active || captured !== epoch || !identityMatches(source) || signature !== JSON.stringify(configProvider());
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
          || /^[a-f0-9]{16,64}$/iu.test(value.providerRequestId)) ? value.providerRequestId : null,
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
      if (!config || !identityMatches(source)) return complete('disabled');
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
      operation.totalIndexRows = cached.rows.length;
      step('eligibility');
      const raws = new Map((source.rawSources ?? []).map(raw => [sourceKey(raw), raw]));
      const summaries = new Map((source.summarySources ?? []).map(summary => [sourceKey(summary), summary]));
      const indexedSources = new Map([...raws, ...summaries]);
      const covered = new Set(source.bodyMatch?.recentBodyFloorIds ?? source.bodyMatch?.coveredFloorIds ?? []);
      const eligible = eligibleFloorMemoryIds ? new Set(eligibleFloorMemoryIds) : null;
      const rows = cached.rows.filter(row => vectorWitnessShape(row.witness) && indexedSources.has(sourceKey(row.witness))
        && (summaryWitnessShape(row.witness) ? (eligible ? eligible.has(row.witness.floorMemoryId) : !covered.has(row.witness.floorId))
          : !covered.has(row.witness.floorId) && (!eligible || eligible.has(row.witness.floorMemoryId))));
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
      if (vector.length !== cached.dimensions) return complete('dimensionMismatch');
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
        const summarySource = summaryWitnessShape(row.witness), raw = indexedSources.get(sourceKey(row.witness));
        const text = raw.canonicalContent.slice(row.witness.offset, row.witness.offset + row.witness.length);
        if (await hash(text) !== row.witness.textFingerprint) continue;
        candidates.push(summarySource ? { text: raw.canonicalContent, summaryWitness: row.witness, similarity: row.score }
          : { text, witness: row.witness, similarity: row.score });
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
    build, query, getState: () => ({ ...state, active: Boolean(active), query: querySnapshot }), subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    abortAll() {
      const pending = queryOperation;
      if (pending) {
        pending.status = 'cancelled'; pending.errorCode = 'VECTOR_ABORTED'; pending.abortOrigin = 'client_abort_all'; pending.abortReason = 'indexReset';
        pending.controller.abort('indexReset'); pending.publishTerminal?.();
      }
      epoch += 1; active?.controller.abort('indexReset'); cached = null; lastQuery = null;
      notify({ status: 'idle', completed: 0, total: 0, error: null });
    },
  });
}
