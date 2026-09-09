import { isUuid, newIdentityUuid, sha256 } from '../identity.js';
import { readHostState } from '../host-context.js';
import {
  FOUNDATION_CAPABILITIES,
  candidateSummary,
  createCheckpointInputFingerprints,
  createFloorRecord,
  deterministicUuid,
  foundationInputSnapshot,
  reverseRefShardPrefix,
  scanAssistantCandidates,
  selectAssistantMessage,
  selectUserStabilityAnchor,
} from './foundation-domain.js';
import {
  validateFoundationCheckpoint,
  validateFoundationGraph,
  validateFoundationIndex,
  validateFoundationRoot,
  validateFoundationRun,
  sameFoundationRecordContent,
} from './foundation-schema.js';
import { collectFloorMemoryEntityIds, entityIndexKey, validateMemoryGraph } from './memory-schema.js';
import { filterReachableDeltas, replayCurrentState } from './cse-engine.js';
import { validateCseGraph } from './cse-schema.js';
import { diagnosticsWithRealtimeOrigin, realtimeOriginFromReachable } from './memory-coverage.js';

const EVENTS = Object.freeze([
  'CHAT_CHANGED', 'CHAT_RENAMED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED',
  'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MORE_MESSAGES_LOADED',
]);
const INDEX_SHARD_LIMIT = 512;
const PREPARED_WRITE_CONCURRENCY = 4;
const emptyIndexManifest = () => ({ floor: [], entity: [], event: [], claim: [], knowledge: [], episode: [], thread: [], state: [], anchor: [], reverseRef: [] });
const hash = async value => `sha256:${await sha256(JSON.stringify(value))}`;
const timestamp = value => {
  const result = typeof value === 'string' ? value : value?.toISOString?.();
  if (!result || !Number.isFinite(Date.parse(result))) throw new TypeError('V3_RUNTIME_TIME_INVALID');
  return result;
};
const clone = value => structuredClone(value);
const sameLocator = (left, right) => left?.messageIndex === right?.messageIndex
  && left?.swipeId === right?.swipeId
  && left?.selectedSwipeIndex === right?.selectedSwipeIndex;

function normalizedIdentity(contextProvider) {
  const raw = contextProvider();
  const state = readHostState(raw);
  if (state?.ok !== true || !isUuid(state.chatId)) throw new Error('当前聊天尚未建立稳定 chatId');
  return Object.freeze({
    hostChatId: state.hostChatId,
    chatId: state.chatId,
    characterLocator: state.characterAvatar,
    personaLocator: state.personaAvatar,
  });
}

function commonRecord({ recordType, id, chatId, narrativeGeneration, now, recordStatus = 'staged', supersedes = null }) {
  return { schemaVersion: 3, recordType, id, chatId, narrativeGeneration, createdAt: now, updatedAt: now, recordStatus, supersedes };
}
function chunks(values, size = INDEX_SHARD_LIMIT) {
  const result = [];
  for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size));
  return result;
}

export async function buildFoundationIndexes({ chatId, narrativeGeneration, checkpointId, floors, candidates, entities = [], now }) {
  const records = [];
  const add = async (kind, shard, entries) => {
    if (!entries.length) return;
    records.push(validateFoundationIndex({
      ...commonRecord({ recordType: 'index', id: await deterministicUuid(['index', checkpointId, kind, shard, entries]), chatId, narrativeGeneration, now }),
      kind, shard, sourceCheckpointId: checkpointId, entries, entryCount: entries.length,
      contentFingerprint: await hash([kind, shard, entries]),
    }, { expectedChatId: chatId }));
  };
  for (let offset = 0; offset < floors.length; offset += 128) {
    const floorChunk = floors.slice(offset, offset + 128);
    await add('floorOrder', String(Math.floor(offset / 128)), floorChunk.map((floor, index) => {
      const locator = candidates[offset + index]?.hostLocator ?? floor.hostLocator;
      return { key: String(floor.assistantSeq), refs: [{ recordType: 'floor', recordId: floor.id, itemId: JSON.stringify(locator) }] };
    }));
  }
  const fingerprints = new Map();
  for (let index = 0; index < floors.length; index += 1) {
    const floor = floors[index], candidate = candidates[index];
    for (const [value, itemId] of [
      [candidate?.rawFingerprint ?? floor.content.rawFingerprint, 'raw'],
      [candidate?.canonicalFingerprint ?? floor.content.canonicalFingerprint, 'canonical'],
    ]) {
      const prefix = value.slice('sha256:'.length, 'sha256:'.length + 2);
      const entries = fingerprints.get(prefix) ?? [];
      entries.push({ key: value, refs: [{ recordType: 'floor', recordId: floor.id, itemId }] });
      fingerprints.set(prefix, entries);
    }
  }
  for (const [prefix, entries] of fingerprints) {
    const shards = chunks(entries);
    for (let index = 0; index < shards.length; index += 1) await add('fingerprint', `${prefix}-${index}`, shards[index]);
  }
  const entityEntries = new Map();
  for (const entity of entities) {
    const keys = new Set([await entityIndexKey(entity.id), await entityIndexKey(entity.displayName), ...await Promise.all(entity.aliases.map(alias => entityIndexKey(alias.normalized || alias.name)))]);
    for (const key of keys) {
      const prefix = key.slice('sha256:'.length, 'sha256:'.length + 2);
      const entries = entityEntries.get(prefix) ?? [];
      entries.push({ key, refs: [{ recordType: 'entity', recordId: entity.id, itemId: null }] });
      entityEntries.set(prefix, entries);
    }
  }
  for (const [prefix, entries] of entityEntries) {
    const shards = chunks(entries);
    for (let index = 0; index < shards.length; index += 1) await add('entity', `${prefix}-${index}`, shards[index]);
  }
  const reverseEntries = new Map();
  for (const floor of floors) {
    const prefix = await reverseRefShardPrefix(floor.id);
    const entries = reverseEntries.get(prefix) ?? [];
    entries.push({ key: floor.id, refs: [{ recordType: 'checkpoint', recordId: checkpointId, itemId: null }] });
    reverseEntries.set(prefix, entries);
  }
  for (const [prefix, entries] of reverseEntries) {
    const routedShards = chunks(entries);
    for (let index = 0; index < routedShards.length; index += 1) await add('reverseRef', `${prefix}-${index}`, routedShards[index]);
  }
  return records;
}

export function validatePreparedFoundation(records) {
  return records?.floorMemories || records?.entities ? validateMemoryGraph(records) : validateFoundationGraph(records);
}

function activeFloorViews(floors, candidates) {
  return floors.map((floor, index) => {
    const candidate = candidates[index];
    if (!candidate) return floor;
    return { ...floor, hostLocator: { ...candidate.hostLocator }, content: { ...floor.content, rawFingerprint: candidate.rawFingerprint } };
  });
}
function restoreActiveFloorViews(floors, indexes) {
  const locators = new Map();
  const rawFingerprints = new Map();
  for (const index of indexes ?? []) {
    for (const entry of index.entries ?? []) {
      for (const ref of entry.refs ?? []) {
        if (ref.recordType !== 'floor') continue;
        if (index.kind === 'floorOrder' && typeof ref.itemId === 'string') {
          try { locators.set(ref.recordId, JSON.parse(ref.itemId)); } catch { /* validated graph will reject malformed routing */ }
        }
        if (index.kind === 'fingerprint' && ref.itemId === 'raw') rawFingerprints.set(ref.recordId, entry.key);
      }
    }
  }
  return floors.map(floor => ({
    ...floor,
    hostLocator: locators.has(floor.id) ? { ...locators.get(floor.id) } : floor.hostLocator,
    content: rawFingerprints.has(floor.id) ? { ...floor.content, rawFingerprint: rawFingerprints.get(floor.id) } : floor.content,
  }));
}
function runSummary(run, result = null) {
  if (!run) return null;
  return Object.freeze({ id: run.id, mode: run.mode, phase: run.phase, ...(result ? { result } : {}) });
}
function statusError(status, message = `V3 operation ${status}`) {
  return Object.assign(new Error(message), { code: `V3_${String(status).toUpperCase()}`, operationStatus: status });
}

export function createFoundationRuntime({
  hostAdapter,
  store,
  contextProvider = () => hostAdapter.getContext(),
  prepareSession = null,
  isEnabled = true,
  sanitizerOptions = () => ({}),
  scanCandidates = scanAssistantCandidates,
  now = () => new Date(),
  newUuid = newIdentityUuid,
  logger = console,
} = {}) {
  if (typeof hostAdapter?.snapshot !== 'function') throw new TypeError('V3 runtime HostAdapter 无效');
  if (!store || ['readReachable', 'readRecord', 'putRecord', 'replaceRecord', 'settleRun', 'commitRoot', 'invalidate', 'recordKey'].some(name => typeof store[name] !== 'function')) throw new TypeError('V3 runtime store 无效');
  if (prepareSession !== null && typeof prepareSession !== 'function') throw new TypeError('V3 runtime prepareSession 无效');
  if (typeof scanCandidates !== 'function') throw new TypeError('V3 runtime candidate scanner 无效');
  let sessionEpoch = 0;
  let cache = null;
  let pending = null;
  let activeOperation = null;
  let scheduled = null;
  let dirtyReason = null;
  let dirtyStableThrough = null;
  let bound = false;
  let lastRun = null;
  let lastError = null;
  let unreachableCount = 0;
  let metrics = Object.freeze({});
  let emptyRealtimeObservation = null;
  const subscribers = new Set();

  const enabled = () => {
    try { return (typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true; }
    catch { return false; }
  };
  const state = status => Object.freeze({
    status,
    pluginEnabled: enabled(),
    compatibilityMode: (() => { try { return hostAdapter.snapshot().mode; } catch { return 'standard'; } })(),
    hostSource: (() => { try { return hostAdapter.snapshot().source; } catch { return null; } })(),
    chatId: cache?.root?.chatId ?? activeOperation?.chatId ?? null,
    foundationStatus: cache?.root?.status ?? 'uninitialized',
    stableCount: cache?.floors?.length ?? 0,
    stableBoundary: cache?.root?.stableBoundary ?? { assistantSeq: 0, floorId: null, canonicalFingerprint: null },
    pending: candidateSummary(pending),
    headCheckpointId: cache?.root?.headCheckpointId ?? null,
    activeRun: activeOperation ? { id: activeOperation.id, phase: activeOperation.phase, reason: activeOperation.reason } : null,
    lastRun, lastError, unreachableCount, sessionEpoch, metrics,
  });
  let publicState = state(enabled() ? 'idle' : 'disabled');
  const publish = status => {
    publicState = state(status);
    for (const listener of subscribers) {
      try { listener(publicState); } catch { /* read-only completion listeners are isolated */ }
    }
    return publicState;
  };
  const publishOperation = (operation, status) => operation?.epoch === sessionEpoch ? publish(status) : publicState;

  function capture() {
    const identity = normalizedIdentity(contextProvider);
    const host = hostAdapter.snapshot();
    if (host.chatId && identity.hostChatId && host.chatId !== identity.hostChatId) throw new Error('宿主聊天身份正在切换');
    return { identity, host };
  }
  function current(operation) {
    if (!enabled()) return 'disabled';
    if (operation.epoch !== sessionEpoch || operation.controller.signal.aborted) return 'stale';
    if (!operation.chatId) return 'current';
    try { return capture().identity.chatId === operation.chatId ? 'current' : 'stale'; }
    catch { return 'stale'; }
  }
  function invalidate() {
    sessionEpoch += 1;
    activeOperation?.controller.abort();
    activeOperation = null;
    scheduled = null;
    dirtyReason = null;
    dirtyStableThrough = null;
    cache = null;
    pending = null;
    emptyRealtimeObservation = null;
    store.invalidate();
    publish(enabled() ? 'idle' : 'disabled');
  }
  async function load(operation) {
    if (cache) return cache;
    let loaded = await store.readReachable({ mode: 'runtime' });
    if (current(operation) !== 'current') return null;
    if (loaded.status === 'uninitialized') {
      cache = { root: null, rootRevision: 0, checkpoint: null, run: null, floors: [], floorMemories: [], entities: [], indexes: [] };
      return cache;
    }
    if (!['ready', 'needsReseal'].includes(loaded.status)) return null;
    if (loaded.run?.phase === 'committing'
      && loaded.root?.headCheckpointId === loaded.checkpoint?.id
      && loaded.checkpoint?.runId === loaded.run.id) {
      const completed = validateFoundationRun({
        ...loaded.run,
        phase: 'completed',
        updatedAt: timestamp(now()),
      }, { expectedChatId: loaded.root.chatId });
      let settled = await store.replaceRecord(completed, loaded.runRevision, { signal: operation.controller.signal });
      if (settled.status === 'conflict') {
        const winner = await store.readRecord('run', loaded.run.id);
        const sameActiveRun = winner.status === 'ready'
          && winner.data.id === loaded.run.id
          && winner.data.narrativeGeneration === loaded.checkpoint.narrativeGeneration
          && winner.data.inputSnapshotFingerprint === loaded.checkpoint.sourceSnapshotFingerprint;
        if (sameActiveRun && winner.data.phase === 'completed') settled = { ...winner, status: 'reused' };
        else if (sameActiveRun && winner.data.phase === 'committing') {
          settled = await store.replaceRecord(completed, winner.revision, { signal: operation.controller.signal });
        }
      }
      if (!['saved', 'reused'].includes(settled.status)) throw statusError(settled.status, 'V3 active committing run 冷恢复收尾失败');
      loaded = { ...loaded, run: settled.data ?? completed, runRevision: settled.revision };
    }
    const orderedFloors = [...loaded.floors].sort((left, right) => left.assistantSeq - right.assistantSeq);
    cache = { ...loaded, floors: restoreActiveFloorViews(orderedFloors, loaded.indexes) };
    lastRun = runSummary(loaded.run, 'recovered');
    return cache;
  }
  function stableCountFor(candidates, floors, confirmLatest, stableThrough = null) {
    if (stableThrough) {
      const boundaryIndex = candidates.findIndex(candidate => candidate.assistantSeq === stableThrough.assistantSeq
        && candidate.hostLocator.messageIndex === stableThrough.messageIndex
        && candidate.canonicalFingerprint === stableThrough.canonicalFingerprint);
      const trustedPrefix = boundaryIndex >= 0 && floors.length <= boundaryIndex + 1
        && candidates[boundaryIndex]?.stabilityProof?.kind === 'nextUser'
        && floors.every((floor, index) => floor.content.canonicalFingerprint === candidates[index]?.canonicalFingerprint);
      if (trustedPrefix) return boundaryIndex + 1;
      throw statusError('stale', '提前稳定边界已变化，本次操作不再提交。');
    }
    let count = 0;
    while (candidates[count]?.stabilityProof?.kind === 'nextUser') count += 1;
    return count;
  }

  async function persistRunPhase(operation, phase, { completedFloorIds, failedItems } = {}) {
    if (!operation.runBase) return null;
    operation.phase = phase;
    publishOperation(operation, 'running');
    const record = validateFoundationRun({
      ...operation.runBase,
      phase,
      completedFloorIds: completedFloorIds ?? operation.runRecord?.completedFloorIds ?? [],
      failedItems: failedItems ?? operation.runRecord?.failedItems ?? [],
      updatedAt: timestamp(now()),
    }, { expectedChatId: operation.chatId });
    let result = operation.runRevision
      ? await store.replaceRecord(record, operation.runRevision, { signal: operation.controller.signal })
      : await store.putRecord(record, { signal: operation.controller.signal });
    if (result.status === 'conflict') {
      const winner = await store.readRecord('run', record.id);
      const sameRun = winner.status === 'ready'
        && winner.data.parentCheckpointId === record.parentCheckpointId
        && winner.data.inputSnapshotFingerprint === record.inputSnapshotFingerprint
        && winner.data.narrativeGeneration === record.narrativeGeneration;
      if (sameRun) {
        const phaseOrder = ['capturing', 'validating', 'sealing', 'committing', 'completed'];
        const winnerOrder = phaseOrder.indexOf(winner.data.phase);
        const wantedOrder = phaseOrder.indexOf(phase);
        if (winnerOrder >= wantedOrder && winnerOrder >= 0) result = { ...winner, status: 'reused' };
        else result = await store.replaceRecord(record, winner.revision, { signal: operation.controller.signal });
      }
    }
    if (!['saved', 'reused'].includes(result.status)) throw statusError(result.status, `V3 run phase ${phase} 写入失败`);
    operation.runRevision = result.revision;
    operation.runRecord = result.data ?? record;
    return operation.runRecord;
  }

  async function recoverPreparedRun(operation, runId, { parentCheckpointId, inputSnapshotFingerprint, narrativeGeneration }) {
    const result = await store.readRecord('run', runId);
    if (result.status === 'missing') return null;
    if (result.status !== 'ready') throw statusError(result.status, 'V3 staged run 读取失败');
    const record = result.data;
    if (record.parentCheckpointId !== parentCheckpointId
      || record.inputSnapshotFingerprint !== inputSnapshotFingerprint
      || record.narrativeGeneration !== narrativeGeneration) {
      throw Object.assign(new Error('V3 staged run 与当前输入不一致'), { code: 'V3_STAGED_SCOPE_MISMATCH' });
    }
    operation.runRevision = result.revision;
    operation.runRecord = record;
    operation.resumePreparedRefs = new Set(record.preparedRecordRefs);
    return record;
  }

  async function persistPreparedRecord(operation, record) {
    const key = store.recordKey(record);
    if (operation.resumePreparedRefs?.has(key)) {
      const existing = await store.readRecord(record.recordType, key);
      if (existing.status === 'ready' && sameFoundationRecordContent(existing.data, record)) return { status: 'reused', data: existing.data, revision: existing.revision, recordId: key };
      if (existing.status !== 'missing') throw Object.assign(new Error('V3 staged 记录内容冲突'), { code: 'V3_STAGED_CONFLICT' });
    }
    return store.putRecord(record, { signal: operation.controller.signal });
  }

  async function persistPreparedRecords(operation, records) {
    let cursor = 0;
    let firstError = null;
    async function worker() {
      while (firstError === null) {
        const index = cursor;
        if (index >= records.length) return;
        cursor += 1;
        try {
          const freshness = current(operation);
          if (freshness !== 'current') throw statusError(freshness);
          const result = await persistPreparedRecord(operation, records[index]);
          if (result.status === 'conflict') throw Object.assign(new Error('V3 staged 记录冲突'), { code: 'V3_STAGED_CONFLICT' });
          if (!['saved', 'reused'].includes(result.status)) throw statusError(result.status, 'V3 staged 记录写入失败');
        } catch (error) {
          firstError ??= error;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(PREPARED_WRITE_CONCURRENCY, records.length) }, () => worker()));
    if (firstError) throw firstError;
  }

  async function scanCurrentSnapshot(operation, { confirmLatest = false, stableThrough = operation?.stableThrough ?? null } = {}) {
    if (current(operation) !== 'current') throw statusError('stale');
    const captured = capture();
    const candidates = await scanCandidates(captured.host.chat, { sanitizerOptions: sanitizerOptions() });
    if (current(operation) !== 'current') throw statusError('stale');
    const stableCount = stableCountFor(candidates, cache?.floors ?? [], confirmLatest, stableThrough);
    const snapshot = await foundationInputSnapshot(candidates, stableCount);
    return { candidates, stableCount, snapshot };
  }

  async function settleStaleRun(operation) {
    if (!operation.runRecord || !operation.runRevision || !operation.identity || !enabled()) return null;
    const record = validateFoundationRun({
      ...operation.runRecord,
      phase: 'stale',
      failedItems: [...operation.runRecord.failedItems, { stage: operation.phase, code: 'V3_OPERATION_STALE', retryCount: 0 }],
      updatedAt: timestamp(now()),
    }, { expectedChatId: operation.chatId });
    const result = await store.settleRun(record, operation.runRevision, operation.identity);
    if (result.status === 'saved') {
      operation.runRecord = result.data;
      operation.runRevision = result.revision;
      return result.data;
    }
    return null;
  }

  async function seal(operation, { candidates, stableCount, confirmLatest = false, stableThrough = operation?.stableThrough ?? null, sourceSnapshot = null, rebaseAttempt = 0 }) {
    const snapshot = sourceSnapshot ?? await foundationInputSnapshot(candidates, stableCount);
    const existing = cache.floors;
    const stableCandidates = candidates.slice(0, stableCount);
    let divergence = null;
    const common = Math.min(existing.length, stableCandidates.length);
    const priorInputs = cache.checkpoint?.inputFingerprints ?? [];
    for (let index = 0; index < common; index += 1) {
      const priorStabilityFingerprint = priorInputs[index]?.floorId === existing[index].id ? priorInputs[index].stabilityFingerprint : null;
      if (existing[index].content.canonicalFingerprint !== stableCandidates[index].canonicalFingerprint
        || (priorStabilityFingerprint && priorStabilityFingerprint !== stableCandidates[index].stabilityProof?.fingerprint)) {
        divergence = index + 1; break;
      }
    }
    if (divergence === null && existing.length !== stableCandidates.length) divergence = common + 1;
    const locatorChanged = existing.length === stableCandidates.length && existing.some((floor, index) => !sameLocator(floor.hostLocator, stableCandidates[index]?.hostLocator));
    const rawChanged = existing.length === stableCandidates.length && existing.some((floor, index) => floor.content.rawFingerprint !== stableCandidates[index]?.rawFingerprint);
    if (divergence === null && !locatorChanged && !rawChanged && !cache.indexesMissing
      && cache.root?.sourceSnapshotFingerprint === snapshot.fingerprint) {
      pending = candidates[stableCount] ?? null;
      lastError = null;
      lastRun = runSummary(cache.run, 'unchanged');
      return publishOperation(operation, cache.root ? 'ready' : 'uninitialized');
    }

    const isBranch = Boolean(existing.length && divergence && divergence <= existing.length);
    const narrativeGeneration = cache.root && !isBranch
      ? cache.root.narrativeGeneration
      : await deterministicUuid(['generation', operation.chatId, cache.root?.narrativeGeneration ?? null, divergence, stableCandidates.map(candidate => candidate.canonicalFingerprint)]);
    const mode = !cache.root ? 'initialize' : isBranch ? 'branchReplay' : 'incremental';
    const parentCheckpointId = cache.root?.headCheckpointId ?? null;
    const runId = await deterministicUuid(['foundation-run-v1', operation.chatId, parentCheckpointId, narrativeGeneration, snapshot.fingerprint]);
    const checkpointId = await deterministicUuid(['foundation-checkpoint-v1', operation.chatId, parentCheckpointId, narrativeGeneration, snapshot.fingerprint]);
    operation.id = runId;
    operation.runBase = null;
    operation.runRecord = null;
    operation.runRevision = 0;
    operation.resumePreparedRefs = null;
    const recoveredRun = await recoverPreparedRun(operation, runId, { parentCheckpointId, inputSnapshotFingerprint: snapshot.fingerprint, narrativeGeneration });
    const nowValue = recoveredRun?.createdAt ?? timestamp(now());
    const prefixLength = isBranch ? Math.max(0, divergence - 1)
      : Math.min(existing.length, stableCount);
    const floors = existing.slice(0, prefixLength);
    for (let index = prefixLength; index < stableCount; index += 1) {
      floors.push(createFloorRecord({
        id: await deterministicUuid(['floor', operation.chatId, narrativeGeneration, runId, index + 1, stableCandidates[index].rawFingerprint, stableCandidates[index].canonicalFingerprint]),
        chatId: operation.chatId, narrativeGeneration, candidate: stableCandidates[index], predecessorFloorId: floors.at(-1)?.id ?? null,
        stabilizedBy: stableCandidates[index].stabilityProof ? 'nextUser' : 'manual', runId, checkpointId, now: nowValue,
      }));
    }
    const floorIdSet = new Set(floors.map(floor => floor.id));
    const floorMemories = (cache.floorMemories ?? []).filter(memory => floorIdSet.has(memory.floorId));
    let stateDeltas = filterReachableDeltas({ floors, floorMemories, stateDeltas: cache.stateDeltas ?? [] });
    const referencedEntityIds = new Set();
    floorMemories.forEach(memory => collectFloorMemoryEntityIds(memory).forEach(id => referencedEntityIds.add(id)));
    stateDeltas.forEach(delta => delta.subjectSnapshots.forEach(subject => { referencedEntityIds.add(subject.subjectEntityId); for (const category of ['adaptive', 'situational']) subject[category].forEach(item => { if (item.towardEntityId) referencedEntityIds.add(item.towardEntityId); }); }));
    if (cache.baseline) { referencedEntityIds.add(cache.baseline.userPersona.entityId); referencedEntityIds.add(cache.baseline.characterCard.entityId); }
    const entities = (cache.entities ?? []).filter(entity => (referencedEntityIds.has(entity.id) || (entity.firstSeenFloorId && floorIdSet.has(entity.firstSeenFloorId))) && (!entity.firstSeenFloorId || floorIdSet.has(entity.firstSeenFloorId)));
    const entityIds = new Set(entities.map(entity => entity.id));
    const baseline = cache.baseline && entityIds.has(cache.baseline.userPersona.entityId) && entityIds.has(cache.baseline.characterCard.entityId) ? cache.baseline : null;
    if (!baseline) stateDeltas = [];
    const memoryReady = floorMemories.some(memory => memory.recordStatus === 'active');
    const cseReady = memoryReady && floorMemories.filter(memory => memory.recordStatus === 'active').every(memory => stateDeltas.some(delta => delta.floorId === memory.floorId && delta.floorMemoryId === memory.id));
    const capabilities = { ...FOUNDATION_CAPABILITIES, memoryReady, cseReady };
    const currentState = baseline ? await replayCurrentState({ chatId: operation.chatId, narrativeGeneration, baselineId: baseline.id, floors, floorMemories, stateDeltas, now: nowValue, id: await deterministicUuid(['v3-cse-current-state', checkpointId]), previousId: cache.currentStates?.at(-1)?.id ?? null }) : null;
    const indexes = await buildFoundationIndexes({ chatId: operation.chatId, narrativeGeneration, checkpointId, floors, candidates: stableCandidates, entities, now: nowValue });
    const indexKeys = indexes.map(index => store.recordKey(index));
    const floorIds = floors.map(floor => floor.id);
    const newFloors = floors.slice(prefixLength);
    const priorRealtimeOrigin = realtimeOriginFromReachable(cache);
    const carriesRealtimeOrigin = ['MESSAGE_SENT', 'MESSAGE_RECEIVED', 'earlyAssistantStarted'].includes(operation.reason) && !isBranch
      && (emptyRealtimeObservation?.chatId === operation.chatId || priorRealtimeOrigin !== null);
    const realtimeOrigin = carriesRealtimeOrigin ? {
      chatId: operation.chatId,
      narrativeGeneration,
      sourceSnapshotFingerprint: snapshot.fingerprint,
    } : null;
    operation.runBase = {
      ...commonRecord({ recordType: 'run', id: runId, chatId: operation.chatId, narrativeGeneration, now: nowValue }),
      parentCheckpointId, inputSnapshotFingerprint: snapshot.fingerprint,
      mode, sessionEpoch: operation.epoch, inputFloorIds: newFloors.map(floor => floor.id), completedFloorIds: [], failedItems: [], diagnostics: diagnosticsWithRealtimeOrigin(cache.run?.diagnostics, realtimeOrigin),
      preparedRecordRefs: [...newFloors.map(floor => `v3-floor-${floor.id}`), ...(currentState ? [store.recordKey(currentState)] : []), ...indexKeys, `v3-checkpoint-${checkpointId}`], startedAt: operation.startedAt,
    };
    let run = await persistRunPhase(operation, 'capturing');
    run = await persistRunPhase(operation, 'validating');
    const stateFingerprint = await hash([narrativeGeneration, floorIds, floors.map(floor => floor.content.canonicalFingerprint)]);
    const checkpointCandidate = {
      ...commonRecord({ recordType: 'checkpoint', id: checkpointId, chatId: operation.chatId, narrativeGeneration, now: nowValue, recordStatus: 'active' }),
      parentCheckpointId, runId, sourceSnapshotFingerprint: snapshot.fingerprint, capabilities: clone(capabilities),
      floorRange: { fromAssistantSeq: floors.length ? 1 : 0, toAssistantSeq: floors.length, floorIds },
      inputFingerprints: createCheckpointInputFingerprints(floors, { candidates: stableCandidates, previous: cache.checkpoint?.inputFingerprints }),
      producedRefs: { floors: floorIds, floorMemories: floorMemories.map(memory => memory.id), entities: entities.map(entity => entity.id), events: [], claims: [], knowledge: [], stateDeltas: stateDeltas.map(delta => delta.id), currentStates: currentState ? [currentState.id] : [], stateProjections: [], episodes: [], threads: [], indexes: indexKeys },
      validation: { schemaValid: true, referencesValid: true, orderedReplayValid: true, stateFingerprint },
      sealedAt: nowValue,
    };
    const actualValidation = await validatePreparedFoundation({ checkpoint: checkpointCandidate, run, floors, floorMemories, entities, indexes, indexKeys });
    const checkpoint = validateFoundationCheckpoint({
      ...checkpointCandidate,
      validation: { ...actualValidation, stateFingerprint },
    }, { expectedChatId: operation.chatId });
    run = await persistRunPhase(operation, 'sealing');
    await persistPreparedRecords(operation, [...newFloors, ...(currentState ? [currentState] : []), ...indexes]);
    const checkpointResult = await persistPreparedRecord(operation, checkpoint);
    if (checkpointResult.status === 'conflict') throw Object.assign(new Error('V3 staged checkpoint 冲突'), { code: 'V3_STAGED_CONFLICT' });
    if (!['saved', 'reused'].includes(checkpointResult.status)) throw statusError(checkpointResult.status, 'V3 staged checkpoint 写入失败');
    run = await persistRunPhase(operation, 'committing', { completedFloorIds: newFloors.map(floor => floor.id) });
    const freshness = current(operation);
    if (freshness !== 'current') throw statusError(freshness);
    const beforeCommit = await scanCurrentSnapshot(operation, { confirmLatest, stableThrough });
    if (beforeCommit.snapshot.fingerprint !== snapshot.fingerprint) {
      const staleRun = await persistRunPhase(operation, 'stale', { completedFloorIds: newFloors.map(floor => floor.id) });
      lastRun = runSummary(staleRun, 'sourceChangedBeforeCommit');
      lastError = '地基输入在提交前已变化，旧快照已作废并将自动收敛。';
      dirtyReason = 'sourceChangedBeforeCommit';
      return publishOperation(operation, 'stale');
    }
    const boundaryFloor = floors.at(-1) ?? null;
    const root = validateFoundationRoot({
      ...commonRecord({ recordType: 'root', id: 'root', chatId: operation.chatId, narrativeGeneration: checkpoint.narrativeGeneration, now: nowValue, recordStatus: 'active' }),
      status: 'ready', capabilities: clone(capabilities), headCheckpointId: checkpoint.id,
      sourceSnapshotFingerprint: checkpoint.sourceSnapshotFingerprint,
      stableBoundary: { assistantSeq: floors.length, floorId: boundaryFloor?.id ?? null, canonicalFingerprint: boundaryFloor?.content?.canonicalFingerprint ?? null },
      baselineId: baseline?.id ?? null, activeRunId: null,
      indexManifest: { ...emptyIndexManifest(), floor: indexKeys.filter(key => key.includes('-floorOrder-') || key.includes('-fingerprint-')), entity: indexKeys.filter(key => key.includes('-entity-')), reverseRef: indexKeys.filter(key => key.includes('-reverseRef-')) },
      activeStateRefs: currentState ? [currentState.id] : [], activeThreadRefs: [],
    }, { expectedChatId: operation.chatId });
    await validateCseGraph({ root, checkpoint, run, floors, floorMemories, entities, indexes, indexKeys, baseline, stateDeltas, currentStates: currentState ? [currentState] : [] });
    const committed = await store.commitRoot(root, cache.rootRevision ?? 0, { signal: operation.controller.signal });
    if (committed.status === 'conflict') {
      unreachableCount += newFloors.length + indexes.length + 2;
      const winner = await store.readReachable();
      const currentInput = await scanCurrentSnapshot(operation, { confirmLatest, stableThrough });
      const samePreparedWinner = winner.status === 'ready'
        && winner.checkpoint.runId === runId
        && winner.root.sourceSnapshotFingerprint === snapshot.fingerprint;
      const staleRun = samePreparedWinner
        ? winner.run
        : await persistRunPhase(operation, 'stale', { completedFloorIds: newFloors.map(floor => floor.id) });
      if (currentInput.snapshot.fingerprint !== snapshot.fingerprint) {
        lastRun = runSummary(staleRun, 'casConflictSourceChanged');
        lastError = '并发提交期间正文又发生变化，旧快照已作废并将自动收敛。';
        cache = winner.status === 'ready' ? { ...winner, floors: restoreActiveFloorViews([...winner.floors].sort((left, right) => left.assistantSeq - right.assistantSeq), winner.indexes) } : null;
        dirtyReason = 'casConflictSourceChanged';
        return publishOperation(operation, 'stale');
      }
      if (winner.status === 'ready') {
        cache = { ...winner, floors: restoreActiveFloorViews([...winner.floors].sort((left, right) => left.assistantSeq - right.assistantSeq), winner.indexes) };
        if (winner.root.sourceSnapshotFingerprint === snapshot.fingerprint) {
          pending = candidates[stableCount] ?? null;
          lastRun = runSummary(staleRun, 'winnerAlreadyCurrent');
          lastError = null;
          return publishOperation(operation, 'ready');
        }
        if (rebaseAttempt < 2) {
          return seal(operation, { candidates, stableCount, confirmLatest, stableThrough, sourceSnapshot: snapshot, rebaseAttempt: rebaseAttempt + 1 });
        }
      }
      lastRun = runSummary(staleRun, 'casConflict');
      lastError = '地基提交遇到并发更新，当前快照无法安全重基。';
      cache = null;
      return publishOperation(operation, 'conflict');
    }
    if (committed.status !== 'saved') throw statusError(committed.status, 'V3 root 提交失败');
    const committedReachable = committed.reachable;
    if (!committedReachable || committedReachable.status !== 'ready'
      || committedReachable.rootRevision !== committed.revision
      || committedReachable.root?.chatId !== operation.chatId
      || committedReachable.root?.headCheckpointId !== checkpointId
      || committedReachable.root?.narrativeGeneration !== narrativeGeneration
      || committedReachable.root?.sourceSnapshotFingerprint !== snapshot.fingerprint) {
      throw Object.assign(new Error('V3 root 已提交，但提交结果缺少一致的真实可达图'), { code: 'V3_COMMIT_REACHABLE_MISMATCH' });
    }
    cache = { ...committedReachable, floors: activeFloorViews(committedReachable.floors, stableCandidates) };
    pending = candidates[stableCount] ?? null;
    const afterCommit = await scanCurrentSnapshot(operation, { confirmLatest, stableThrough });
    if (afterCommit.snapshot.fingerprint !== snapshot.fingerprint) {
      const staleRun = await persistRunPhase(operation, 'stale', { completedFloorIds: newFloors.map(floor => floor.id) });
      cache.run = staleRun;
      lastRun = runSummary(staleRun, 'sourceChangedAfterCommit');
      lastError = '提交响应返回时正文已变化，正在自动收敛到最新快照。';
      if (rebaseAttempt < 2) {
        const latest = await scanCurrentSnapshot(operation, { confirmLatest: false, stableThrough });
        return seal(operation, { ...latest, confirmLatest: false, stableThrough, sourceSnapshot: latest.snapshot, rebaseAttempt: rebaseAttempt + 1 });
      }
      dirtyReason = 'sourceChangedAfterCommit';
      return publishOperation(operation, 'stale');
    }
    const completedRun = await persistRunPhase(operation, 'completed', { completedFloorIds: newFloors.map(floor => floor.id) });
    cache = { ...cache, run: completedRun };
    emptyRealtimeObservation = floors.length === 0 ? Object.freeze({ chatId: operation.chatId }) : null;
    pending = candidates[stableCount] ?? null;
    lastRun = runSummary(completedRun, isBranch ? `trustedPrefix:${prefixLength}` : 'committed');
    lastError = null;
    return publishOperation(operation, 'ready');
  }

  async function reconcile(reason = 'manualRefresh', { confirmLatest = false, stableThrough = null } = {}) {
    if (!enabled()) return publish('disabled');
    if (activeOperation) {
      dirtyReason = reason;
      if (stableThrough) dirtyStableThrough = stableThrough;
      return activeOperation.promise;
    }
    const operation = {
      id: newUuid(), chatId: null, epoch: sessionEpoch, controller: new AbortController(), reason, phase: 'capturing',
      startedAt: timestamp(now()), promise: null, runBase: null, runRecord: null, runRevision: 0, stableThrough,
    };
    activeOperation = operation;
    publishOperation(operation, 'running');
    let settledPublicState = null;
    const runPromise = (async () => {
      try {
        if (prepareSession) {
          const prepared = await prepareSession();
          if (prepared?.status && prepared.status !== 'ready') throw statusError(prepared.status, `V3 身份准备未就绪：${prepared.status}`);
        }
        if (operation.epoch !== sessionEpoch || operation.controller.signal.aborted) return publishOperation(operation, enabled() ? 'stale' : 'disabled');
        const captured = capture();
        operation.chatId = captured.identity.chatId;
        operation.identity = captured.identity;
        const loaded = await load(operation);
        if (!loaded || current(operation) !== 'current') return publishOperation(operation, 'stale');
        const scanMetrics = {};
        const started = globalThis.performance?.now?.() ?? Date.now();
        const candidates = await scanCandidates(captured.host.chat, { sanitizerOptions: sanitizerOptions(), metrics: scanMetrics });
        const elapsed = (globalThis.performance?.now?.() ?? Date.now()) - started;
        if (current(operation) !== 'current') return publishOperation(operation, 'stale');
        metrics = Object.freeze({ assistantFloors: candidates.length, canonicalCharacters: candidates.reduce((sum, item) => sum + item.canonicalContent.length, 0), scanMs: elapsed, maximumChunkMs: scanMetrics.maximumChunkMs ?? elapsed, algorithm: 'ordered-O(n)' });
        const stableCount = stableCountFor(candidates, loaded.floors, confirmLatest, stableThrough);
        const sourceSnapshot = await foundationInputSnapshot(candidates, stableCount);
        if (!loaded.root && stableCount === 0) {
          emptyRealtimeObservation = Object.freeze({ chatId: operation.chatId });
          pending = candidates[0] ?? null;
          lastRun = null;
          lastError = null;
          return publishOperation(operation, 'uninitialized');
        }
        return await seal(operation, { candidates, stableCount, confirmLatest, stableThrough, sourceSnapshot });
      } catch (error) {
        const operationState = current(operation);
        if (operationState === 'stale' || operationState === 'disabled' || error?.operationStatus === 'stale') {
          try {
            const staleRun = await settleStaleRun(operation);
            if (staleRun) lastRun = runSummary(staleRun);
          } catch { /* stale completion is best-effort and must not cross into the new active root */ }
          return publishOperation(operation, enabled() ? 'stale' : 'disabled');
        }
        if (operation.runBase && operation.runRecord?.phase !== 'retryableError') {
          try {
            const failedRun = await persistRunPhase(operation, 'retryableError', { failedItems: [{ stage: operation.phase, code: error?.code ?? 'V3_FOUNDATION_FAILED', retryCount: 0 }] });
            lastRun = runSummary(failedRun);
          } catch { lastRun = Object.freeze({ id: operation.id, mode: operation.runBase.mode, phase: 'retryableError', code: error?.code ?? null }); }
        } else if (!lastRun || lastRun.id !== operation.id) {
          lastRun = Object.freeze({ id: operation.id, mode: reason, phase: 'retryableError', code: error?.code ?? null });
        }
        lastError = error?.message || 'V3 地基处理失败';
        logger?.warn?.('[qianqianjie] V3 foundation failed', { code: error?.code ?? error?.name ?? 'V3_FOUNDATION_FAILED' });
        return publishOperation(operation, 'error');
      } finally {
        if (activeOperation === operation) {
          activeOperation = null;
          if (operation.epoch === sessionEpoch) settledPublicState = publish(enabled() ? publicState.status : 'disabled');
        }
        if (dirtyReason && enabled()) {
          const nextReason = dirtyReason;
          const nextStableThrough = dirtyStableThrough;
          dirtyReason = null;
          dirtyStableThrough = null;
          Promise.resolve().then(() => reconcile(nextReason, { stableThrough: nextStableThrough })).catch(error => { lastError = error?.message || 'V3 地基调度失败'; publish('error'); });
        }
      }
    })();
    operation.promise = runPromise.then(result => settledPublicState ?? result);
    return operation.promise;
  }

  function schedule(reason) {
    if (!enabled()) return Promise.resolve(publish('disabled'));
    dirtyReason = reason;
    if (scheduled) return scheduled;
    scheduled = Promise.resolve().then(() => {
      scheduled = null;
      const next = dirtyReason; dirtyReason = null;
      return reconcile(next);
    }).catch(error => {
      lastError = error?.message || 'V3 地基调度失败';
      logger?.warn?.('[qianqianjie] V3 foundation schedule failed', { code: error?.code ?? error?.name ?? 'V3_SCHEDULE_FAILED' });
      return publish('error');
    });
    return scheduled;
  }
  function cancelEarlyStabilization(reason = 'earlyStabilizationCancelled') {
    let cancelled = false;
    if (activeOperation?.reason === 'earlyAssistantStarted') {
      activeOperation.controller.abort(reason);
      cancelled = true;
    }
    if (dirtyStableThrough) {
      dirtyStableThrough = null;
      if (dirtyReason === 'earlyAssistantStarted') dirtyReason = null;
      cancelled = true;
    }
    return cancelled;
  }
  function validSentUserIndex(value) {
    if (!Number.isSafeInteger(value)) return false;
    try {
      const chat = hostAdapter.snapshot().chat;
      return Boolean(selectUserStabilityAnchor(chat?.[value]) && selectAssistantMessage(chat?.[value - 1]));
    } catch { return false; }
  }
  function bind({ eventSource, eventTypes } = hostAdapter.snapshot()) {
    if (bound || !eventSource?.on || !eventTypes) return false;
    for (const name of EVENTS) {
      const eventName = eventTypes[name];
      if (!eventName) continue;
      eventSource.on(eventName, (...args) => {
        if (name === 'CHAT_CHANGED' || name === 'CHAT_RENAMED') {
          invalidate();
          if (enabled()) void schedule(name);
          return;
        }
        if (name === 'MORE_MESSAGES_LOADED') return;
        if (name === 'MESSAGE_SENT' && !validSentUserIndex(args[0])) return;
        hostAdapter.mutationMetadata(args);
        void schedule(name);
      });
    }
    bound = true;
    return true;
  }
  async function setEnabled(value) {
    if (value !== true) { invalidate(); return publish('disabled'); }
    return reconcile('enabled');
  }
  function adoptReachable(value) {
    if (!value?.root || !Number.isSafeInteger(value.rootRevision)) return false;
    let identity;
    try { identity = capture().identity; } catch { return false; }
    if (value.root.chatId !== identity.chatId || (cache?.rootRevision ?? 0) > value.rootRevision) return false;
    cache = value;
    lastRun = runSummary(cache.run, 'adopted');
    publish('ready');
    return true;
  }
  return Object.freeze({
    bind,
    start: () => enabled() ? reconcile('start') : Promise.resolve(publish('disabled')),
    reconcile,
    refreshStatus: () => reconcile('manualRefresh'),
    stabilizeThrough: boundary => reconcile('earlyAssistantStarted', { stableThrough: boundary }),
    cancelEarlyStabilization,
    confirmLatest: () => pending ? reconcile('manualConfirm', { confirmLatest: true }) : Promise.resolve(publish('ready')),
    invalidate, setEnabled, adoptReachable, getState: () => publicState,
    getReachable: () => cache,
    subscribe(listener) { if (typeof listener !== 'function') throw new TypeError('V3 foundation listener 必须是函数'); subscribers.add(listener); return () => subscribers.delete(listener); },
    identityProvider: () => normalizedIdentity(contextProvider),
  });
}
