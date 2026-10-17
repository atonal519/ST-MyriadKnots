import { VECTOR_INDEX_ID, vectorRecordOwned } from './v3/vector-index.js';
import { NAMESPACE } from './constants.js';
import {
  validateFoundationCheckpoint,
  validateFoundationFloorContent,
  validateFoundationIndex,
  validateFoundationRoot,
  validateFoundationRun,
} from './v3/foundation-schema.js';
import { validateEntityRecord, validateFloorMemory } from './v3/memory-schema.js';
import { validateBaselineRecord, validateCurrentStateRecord, validateStateDeltaRecord } from './v3/cse-schema.js';

const FOUNDATION_TYPES = Object.freeze([
  ['v3-floor-memory-', 'floorMemory'],
  ['v3-current-state-', 'currentState'],
  ['v3-state-delta-', 'stateDelta'],
  ['v3-checkpoint-', 'checkpoint'],
  ['v3-baseline-', 'baseline'],
  ['v3-entity-', 'entity'],
  ['v3-index-', 'index'],
  ['v3-floor-', 'floor'],
  ['v3-run-', 'run'],
]);
const CATEGORY_BY_TYPE = Object.freeze({
  floor: 'story', floorMemory: 'story',
  entity: 'people', baseline: 'people', stateDelta: 'people', currentState: 'people',
  run: 'runtime', checkpoint: 'runtime', index: 'runtime',
});
const VALIDATOR_BY_TYPE = Object.freeze({
  run: validateFoundationRun,
  checkpoint: validateFoundationCheckpoint,
  currentState: validateCurrentStateRecord,
  index: validateFoundationIndex,
  floor: validateFoundationFloorContent,
  floorMemory: validateFloorMemory,
  entity: validateEntityRecord,
  baseline: validateBaselineRecord,
  stateDelta: validateStateDeltaRecord,
});
const AUTO_FLOOR_INTERVAL = 10;
const CLASSIFICATION_BATCH_SIZE = 50;
const TRASH_GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const STORAGE_AUTO_RECORD_THRESHOLD = 100;
export const STORAGE_AUTO_BYTE_THRESHOLD = 8 * 1024 * 1024;

const textBytes = value => {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
  catch { return 0; }
};
const errorWith = (code, message) => Object.assign(new Error(message), { code });
const clone = value => structuredClone(value);

function recordType(recordId) {
  return FOUNDATION_TYPES.find(([prefix]) => String(recordId).startsWith(prefix))?.[1] ?? null;
}

function expectedRecordId(type, data) {
  if (type === 'index') return `v3-index-${data?.kind}-${data?.shard}-${data?.id}`;
  const prefix = FOUNDATION_TYPES.find(([, candidate]) => candidate === type)?.[0];
  return prefix && typeof data?.id === 'string' ? `${prefix}${data.id}` : '';
}

async function safeFoundationEnvelope(envelope, chatId) {
  const type = recordType(envelope?.recordId);
  if (!type || !Number.isSafeInteger(envelope?.revision) || envelope.revision < 1) return null;
  const data = envelope?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || data.schemaVersion !== 3 || data.recordType !== type || data.chatId !== chatId) return null;
  let safe;
  try { safe = await VALIDATOR_BY_TYPE[type](data, { expectedChatId: chatId }); }
  catch { return null; }
  if (expectedRecordId(type, safe) !== envelope.recordId) return null;
  return { type, category: CATEGORY_BY_TYPE[type] };
}

function reachableRecordIds(reachable) {
  const checkpoint = reachable?.checkpoint;
  const root = reachable?.root;
  const result = new Set(['v3-root']);
  if (root?.headCheckpointId) result.add(`v3-checkpoint-${root.headCheckpointId}`);
  if (checkpoint?.runId) result.add(`v3-run-${checkpoint.runId}`);
  if (root?.baselineId) result.add(`v3-baseline-${root.baselineId}`);
  for (const [field, prefix] of [
    ['floors', 'v3-floor-'], ['floorMemories', 'v3-floor-memory-'], ['entities', 'v3-entity-'],
    ['stateDeltas', 'v3-state-delta-'], ['currentStates', 'v3-current-state-'],
  ]) for (const id of checkpoint?.producedRefs?.[field] ?? []) result.add(`${prefix}${id}`);
  for (const key of checkpoint?.producedRefs?.indexes ?? []) result.add(String(key));
  return result;
}

function emptyBreakdown() {
  return { story: { count: 0, bytes: 0 }, people: { count: 0, bytes: 0 }, runtime: { count: 0, bytes: 0 } };
}

function createStorageClassifier(reachable, chatId) {
  const activeIds = reachableRecordIds(reachable);
  const breakdown = { active: emptyBreakdown(), cleanup: emptyBreakdown() };
  const candidates = [];
  const totals = { count: 0, bytes: 0 };
  const active = { count: 0, bytes: 0 };
  const cleanup = { count: 0, bytes: 0 };
  const retained = { count: 0, bytes: 0 };
  let processed = 0;
  return {
    protectVectorRecords(records, resumableVectorShardIds = []) {
      const resumableIds = new Set(resumableVectorShardIds);
      for (const record of records) if (resumableIds.has(record?.recordId) && vectorRecordOwned(record)
        && record.data.chatId === chatId && record.data.narrativeGeneration === reachable?.root?.narrativeGeneration
        && record.recordId.startsWith('qqj-vector-shard-')) activeIds.add(record.recordId);
      const manifest = records.find(record => record.recordId === VECTOR_INDEX_ID && vectorRecordOwned(record)
        && record.data.chatId === chatId && record.data.narrativeGeneration === reachable?.root?.narrativeGeneration);
      if (manifest) { activeIds.add(VECTOR_INDEX_ID); for (const id of manifest.data.shardIds) activeIds.add(id); }
    },
    async add(envelope, sourceIndex = processed) {
      processed += 1;
      const bytes = textBytes(envelope);
      totals.count += 1; totals.bytes += bytes;
      const vectorOwned = vectorRecordOwned(envelope) && envelope.data.chatId === chatId;
      const classified = vectorOwned ? { type: 'vectorCache', category: 'runtime' } : await safeFoundationEnvelope(envelope, chatId);
      if (activeIds.has(envelope?.recordId)) {
        active.count += 1; active.bytes += bytes;
        if (classified) {
          breakdown.active[classified.category].count += 1;
          breakdown.active[classified.category].bytes += bytes;
        }
      } else if (classified) {
        cleanup.count += 1; cleanup.bytes += bytes;
        breakdown.cleanup[classified.category].count += 1;
        breakdown.cleanup[classified.category].bytes += bytes;
        candidates.push({ sourceIndex, value: Object.freeze({ recordId: envelope.recordId, revision: envelope.revision }) });
      } else {
        // Unreachable is not proof of QQJ ownership; malformed or foreign records stay out of cleanup candidates.
        retained.count += 1; retained.bytes += bytes;
      }
      if (processed % CLASSIFICATION_BATCH_SIZE === 0) await new Promise(resolve => setTimeout(resolve, 0));
    },
    finish() {
      candidates.sort((left, right) => left.sourceIndex - right.sourceIndex);
      return Object.freeze({
        stats: Object.freeze({ total: Object.freeze(totals), active: Object.freeze(active), cleanup: Object.freeze(cleanup), retained: Object.freeze(retained), breakdown: clone(breakdown) }),
        candidates: Object.freeze(candidates.map(item => item.value)),
      });
    },
  };
}

export async function classifyStorageRecords(records, reachable, chatId, { resumableVectorShardIds = [] } = {}) {
  const classifier = createStorageClassifier(reachable, chatId);
  classifier.protectVectorRecords(records, resumableVectorShardIds);
  for (let index = 0; index < records.length; index += 1) await classifier.add(records[index], index);
  return classifier.finish();
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.chatId === right.chatId && left.hostChatId === right.hostChatId
    && left.characterLocator === right.characterLocator && left.personaLocator === right.personaLocator);
}

export function createStorageManagement({
  client,
  store,
  session,
  hostAdapter,
  settings,
  memoryRuntime,
  foundationRuntime,
  vectorRuntime = null,
  activitySources = [],
  isBusy = () => false,
  isEnabled = () => true,
  logger = console,
} = {}) {
  if (!client?.list || !client?.get || !client?.remove || !store?.readReachable
    || !session?.identity || !session?.suspend || !session?.resume || !session?.prepare || !session?.getState
    || !hostAdapter?.snapshot || !settings?.get || !settings?.update || !memoryRuntime?.getActivityState) {
    throw new TypeError('当前聊天存储管理依赖无效');
  }
  let operation = null;
  let resultState = { status: 'idle', chatId: null, stats: null, lastResult: null, error: null, autoPending: false };
  let automaticCheck = null;
  let trashGcCapability = null;
  let trashGcCapabilityCheck = null;
  let trashGcCheck = null;
  let trashGcProgress = null;
  let trashGcRetryAfter = 0;
  let trashGcState = { status: 'idle', scanned: 0, deleted: 0, failed: 0, error: null, automatic: false };
  const automaticAttempts = new Map();
  let reusableAutomaticSnapshot = null;
  let disposed = false;
  const subscribers = new Set();

  const autoEnabled = () => settings.get().storageAutoCleanupEnabled === true;
  const currentIdentity = () => session.identity();
  const hostMatches = identity => {
    try {
      const host = hostAdapter.snapshot();
      return host.chatId === identity.hostChatId
        && host.context?.chatMetadata?.qianqianjie?.chatId === identity.chatId;
    } catch { return false; }
  };
  const inCurrentHost = identity => {
    if (!hostMatches(identity)) return false;
    try { return sameIdentity(identity, currentIdentity()); }
    catch {
      const state = session.getState();
      return state?.status === 'suspended' && sameIdentity(identity, state.identity);
    }
  };
  const assertCurrent = identity => {
    if (!inCurrentHost(identity)) throw errorWith('QQJ_STORAGE_CHAT_CHANGED', '当前聊天已经变化，未操作其他聊天的数据。');
  };
  const workBusy = () => {
    try { return Boolean(isBusy()); }
    catch { return true; }
  };
  const scopedState = () => {
    let identity = null;
    try { identity = currentIdentity(); } catch { /* current chat may still be preparing */ }
    const sameChat = identity?.chatId && resultState.chatId === identity.chatId;
    return Object.freeze({
      status: operation && inCurrentHost(operation.identity) ? operation.kind : sameChat ? resultState.status : 'idle',
      chatId: sameChat ? resultState.chatId : identity?.chatId ?? null,
      stats: sameChat && resultState.stats ? clone(resultState.stats) : null,
      lastResult: sameChat && resultState.lastResult ? clone(resultState.lastResult) : null,
      error: sameChat ? resultState.error : null,
      busy: workBusy(),
      autoEnabled: autoEnabled(),
      autoPending: sameChat && resultState.autoPending === true,
      trashGc: Object.freeze({ ...trashGcState }),
    });
  };
  const notify = () => {
    const state = scopedState();
    for (const listener of subscribers) { try { listener(state); } catch { /* UI listener isolation */ } }
    return state;
  };
  const setResult = (identity, patch) => {
    if (!inCurrentHost(identity)) return scopedState();
    resultState = { ...resultState, chatId: identity.chatId, ...patch };
    return notify();
  };
  const capture = () => {
    const identity = currentIdentity();
    assertCurrent(identity);
    return identity;
  };

  const currentStableCount = identity => {
    const state = memoryRuntime.getActivityState();
    return state?.chatId === identity.chatId && Number.isSafeInteger(state.stableCount) ? state.stableCount : null;
  };
  const warmReachable = identity => {
    const reachable = foundationRuntime?.getReachable?.();
    if (reachable?.status !== 'ready' || reachable.root?.chatId !== identity.chatId
      || reachable.root?.headCheckpointId !== reachable.checkpoint?.id || !reachable.indexesComplete
      || reachable.indexesMissing || reachable.cseUnavailable === true
      || !Number.isSafeInteger(reachable.rootRevision)
      || typeof reachable.root?.narrativeGeneration !== 'string'
      || reachable.checkpoint?.narrativeGeneration !== reachable.root.narrativeGeneration
      || reachable.checkpoint?.sourceSnapshotFingerprint !== reachable.root.sourceSnapshotFingerprint
      || reachable.run?.inputSnapshotFingerprint !== reachable.root.sourceSnapshotFingerprint) return null;
    return reachable;
  };
  const rootMatchesAnchor = (root, anchor) => anchor?.status === 'ready'
    ? root?.status === 'ready' && root.revision === anchor.revision && root.data?.chatId === anchor.chatId
      && root.data?.narrativeGeneration === anchor.narrativeGeneration && root.data?.headCheckpointId === anchor.headCheckpointId
      && root.data?.sourceSnapshotFingerprint === anchor.sourceSnapshotFingerprint
    : anchor?.status === root?.status;
  async function currentRootAnchor(identity) {
    const root = await store.readRoot();
    assertCurrent(identity);
    return root?.status === 'ready'
      ? Object.freeze({ status: 'ready', chatId: root.data.chatId, revision: root.revision,
        narrativeGeneration: root.data.narrativeGeneration, headCheckpointId: root.data.headCheckpointId,
        sourceSnapshotFingerprint: root.data.sourceSnapshotFingerprint })
      : Object.freeze({ status: root?.status ?? 'unavailable' });
  }
  const rememberAutomaticSnapshot = (identity, snapshot, stableCount) => {
    if (snapshot?.status === 'ready' && stableCount !== null && currentStableCount(identity) === stableCount && inCurrentHost(identity)) {
      reusableAutomaticSnapshot = { identity, stableCount, snapshot };
    }
  };
  async function takeReusableAutomaticSnapshot(identity, stableCount) {
    const cached = reusableAutomaticSnapshot;
    if (!cached || cached.stableCount !== stableCount || !sameIdentity(cached.identity, identity) || !inCurrentHost(identity)) return { snapshot: null, stale: false };
    const root = await store.readRoot();
    assertCurrent(identity);
    const matches = rootMatchesAnchor(root, cached.snapshot.anchor);
    reusableAutomaticSnapshot = null;
    return matches ? { snapshot: cached.snapshot, stale: false } : { snapshot: null, stale: true };
  }

  async function scanSnapshot(identity) {
    assertCurrent(identity);
    let reachable = warmReachable(identity);
    if (reachable && typeof store.readRoot === 'function') {
      const root = await store.readRoot();
      assertCurrent(identity);
      if (root?.status !== 'ready' || root.revision !== reachable.rootRevision
        || root.data?.chatId !== reachable.root.chatId
        || root.data?.narrativeGeneration !== reachable.root.narrativeGeneration
        || root.data?.headCheckpointId !== reachable.root.headCheckpointId
        || root.data?.sourceSnapshotFingerprint !== reachable.root.sourceSnapshotFingerprint) reachable = null;
    } else reachable = null;
    if (!reachable) reachable = await store.readReachable({ mode: 'full' });
    assertCurrent(identity);
    if (reachable?.status === 'ready' && reachable.root?.chatId !== identity.chatId) {
      throw errorWith('QQJ_STORAGE_ROOT_IDENTITY_MISMATCH', '当前基础数据身份无法安全核对，本次没有生成清理候选。');
    }
    if (reachable?.status !== 'ready' || !reachable.root || !reachable.root.headCheckpointId) {
      const totals = { count: 0, bytes: 0 };
      if (typeof client.iterRecords === 'function') {
        for await (const item of client.iterRecords(`chat-${identity.chatId}`)) { totals.count += 1; totals.bytes += textBytes(item); }
      } else {
        const records = await client.list(`chat-${identity.chatId}`);
        if (!Array.isArray(records)) throw errorWith('QQJ_STORAGE_LIST_INVALID', '后端没有返回可核对的记录清单。');
        for (const item of records) { totals.count += 1; totals.bytes += textBytes(item); }
      }
      assertCurrent(identity);
      return Object.freeze({ status: reachable?.status === 'uninitialized' ? 'uninitialized' : 'notReady', identity, stats: Object.freeze({ total: totals, active: { count: 0, bytes: 0 }, cleanup: { count: 0, bytes: 0 }, retained: totals, breakdown: { active: emptyBreakdown(), cleanup: emptyBreakdown() } }), candidates: Object.freeze([]), anchor: null });
    }
    let classified;
    if (typeof client.iterRecords === 'function') {
      const classifier = createStorageClassifier(reachable, identity.chatId);
      const vectorRecords = [];
      let sourceIndex = 0;
      for await (const record of client.iterRecords(`chat-${identity.chatId}`)) {
        if (record?.recordId === VECTOR_INDEX_ID || String(record?.recordId ?? '').startsWith('qqj-vector-shard-')) vectorRecords.push({ record, sourceIndex });
        else await classifier.add(record, sourceIndex);
        sourceIndex += 1;
      }
      const vectorEnvelopes = vectorRecords.map(item => item.record);
      const resumableVectorShardIds = await vectorRuntime?.getResumableShardIds?.(reachable, vectorEnvelopes) ?? [];
      classifier.protectVectorRecords(vectorEnvelopes, resumableVectorShardIds);
      for (const item of vectorRecords) await classifier.add(item.record, item.sourceIndex);
      classified = classifier.finish();
    } else {
      const records = await client.list(`chat-${identity.chatId}`);
      assertCurrent(identity);
      if (!Array.isArray(records)) throw errorWith('QQJ_STORAGE_LIST_INVALID', '后端没有返回可核对的记录清单。');
      const resumableVectorShardIds = await vectorRuntime?.getResumableShardIds?.(reachable, records) ?? [];
      classified = await classifyStorageRecords(records, reachable, identity.chatId, { resumableVectorShardIds });
    }
    assertCurrent(identity);
    return Object.freeze({
      status: 'ready', identity, stats: classified.stats, candidates: classified.candidates,
      anchor: Object.freeze({ status: 'ready', chatId: reachable.root.chatId, revision: reachable.rootRevision, headCheckpointId: reachable.root.headCheckpointId,
        narrativeGeneration: reachable.root.narrativeGeneration, sourceSnapshotFingerprint: reachable.root.sourceSnapshotFingerprint }),
    });
  }

  async function scan() {
    if (operation) return operation.promise;
    const identity = capture();
    const stableCount = currentStableCount(identity);
    reusableAutomaticSnapshot = null;
    const current = { kind: 'scanning', identity, promise: null };
    operation = current; notify();
    current.promise = scanSnapshot(identity).then(snapshot => {
      setResult(identity, { status: snapshot.status, stats: snapshot.stats, error: null, lastResult: null });
      rememberAutomaticSnapshot(identity, snapshot, stableCount);
      return snapshot;
    }).catch(error => {
      if (inCurrentHost(identity)) setResult(identity, { status: 'error', stats: null, error, lastResult: null });
      throw error;
    }).finally(() => { if (operation === current) operation = null; notify(); scheduleAutomatic(); });
    return current.promise;
  }

  async function readRootUnderMaintenance(identity) {
    assertCurrent(identity);
    const envelope = await client.get(`chat-${identity.chatId}`, 'v3-root');
    assertCurrent(identity);
    if (!Number.isSafeInteger(envelope?.revision) || envelope.revision < 1) {
      throw errorWith('QQJ_STORAGE_ROOT_INVALID', '当前版本记录缺少可核对的 revision，本次没有删除。');
    }
    let data;
    try { data = validateFoundationRoot(envelope.data, { expectedChatId: identity.chatId }); }
    catch { throw errorWith('QQJ_STORAGE_ROOT_INVALID', '当前版本记录未通过完整校验，本次没有删除。'); }
    return Object.freeze({ revision: envelope.revision, data });
  }
  const rootMatches = (current, anchor) => current?.revision === anchor?.revision
    && current.data?.chatId === anchor?.chatId && current.data?.headCheckpointId === anchor?.headCheckpointId;

  async function releaseMaintenance(identity) {
    session.resume(identity.chatId);
    if (!hostMatches(identity)) return;
    const prepared = await session.prepare();
    if (prepared?.status !== 'ready' || !sameIdentity(identity, prepared.identity)) {
      throw errorWith('QQJ_STORAGE_SESSION_RESTORE_FAILED', '清理保护已释放，但当前聊天身份需要重新准备后才能刷新统计。');
    }
  }

  async function removeCandidates(identity, candidates) {
    let cursor = 0, firstError = null, deletedCount = 0, convergedCount = 0;
    const collection = `chat-${identity.chatId}`;
    async function worker() {
      while (!firstError) {
        try {
          assertCurrent(identity);
          const index = cursor;
          if (index >= candidates.length) return;
          cursor += 1;
          const candidate = candidates[index];
          await client.removePermanent(collection, candidate.recordId, candidate.revision);
          deletedCount += 1;
          assertCurrent(identity);
        } catch (error) {
          if (error?.status === 404) { convergedCount += 1; continue; }
          firstError ??= error;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, () => worker()));
    if (deletedCount === 0 && convergedCount === candidates.length) {
      convergedCount = 0;
      firstError = errorWith('QQJ_STORAGE_PERMANENT_DELETE_UNAVAILABLE', '存储管理永久清理需要更新白鳥后端；本次没有删除任何文件。');
    }
    return { deletedCount, convergedCount, error: firstError };
  }

  async function cleanFromSnapshot(identity, snapshot, { automatic = false } = {}) {
    if (snapshot.status !== 'ready') return { status: snapshot.status, deletedCount: 0, convergedCount: 0, remainingCount: 0, automatic };
    if (!snapshot.candidates.length) return { status: 'completed', deletedCount: 0, convergedCount: 0, remainingCount: 0, automatic };
    if (workBusy()) throw errorWith('QQJ_STORAGE_BUSY', '当前正在生成或处理千千结任务，请等待完成后再清理。');
    let suspended = false, removed = null, lockedRootChanged = false, maintenanceError = null, releaseError = null;
    try {
      session.suspend(identity.chatId);
      suspended = true;
      assertCurrent(identity);
      const before = await readRootUnderMaintenance(identity);
      if (!rootMatches(before, snapshot.anchor)) throw errorWith('QQJ_STORAGE_ROOT_CHANGED', '当前版本已在扫描后变化，本次没有删除；请刷新统计后重试。');
      removed = await removeCandidates(identity, snapshot.candidates);
      assertCurrent(identity);
      try {
        const after = await readRootUnderMaintenance(identity);
        lockedRootChanged = !rootMatches(after, snapshot.anchor);
      } catch (error) { maintenanceError = error; }
    } catch (error) { maintenanceError = error; }
    finally {
      if (suspended) {
        try { await releaseMaintenance(identity); }
        catch (error) { releaseError = error; }
      }
    }
    if (!removed) throw maintenanceError ?? releaseError ?? errorWith('QQJ_STORAGE_CLEANUP_FAILED', '清理没有开始。');
    let refreshed = null, refreshError = null;
    if (!hostMatches(identity)) throw errorWith('QQJ_STORAGE_CHAT_CHANGED', '当前聊天已经变化，未操作其他聊天的数据。');
    if (releaseError) refreshError = releaseError;
    else {
      assertCurrent(identity);
      try { refreshed = await scanSnapshot(identity); }
      catch (error) { refreshError = error; }
    }
    const rootChanged = lockedRootChanged || Boolean(refreshed?.anchor && (refreshed.anchor.revision !== snapshot.anchor.revision
      || refreshed.anchor.headCheckpointId !== snapshot.anchor.headCheckpointId || refreshed.anchor.chatId !== snapshot.anchor.chatId));
    const remainingCount = refreshed?.stats?.cleanup?.count ?? Math.max(0, snapshot.candidates.length - removed.deletedCount - removed.convergedCount);
    const error = removed.error ?? maintenanceError ?? releaseError ?? refreshError ?? null;
    const status = error ? 'partial' : rootChanged ? 'stale' : 'completed';
    const result = Object.freeze({ status, deletedCount: removed.deletedCount, convergedCount: removed.convergedCount, remainingCount, automatic,
      error, rootChanged });
    setResult(identity, { status: refreshed?.status ?? 'error', stats: refreshed?.stats ?? snapshot.stats, error: result.error, lastResult: result });
    rememberAutomaticSnapshot(identity, refreshed, currentStableCount(identity));
    return result;
  }

  async function cleanup({ automatic = false } = {}) {
    if (operation) throw errorWith('QQJ_STORAGE_ACTIVE', '存储统计或清理正在进行。');
    const identity = capture();
    if (workBusy()) throw errorWith('QQJ_STORAGE_BUSY', '当前正在生成或处理千千结任务，请等待完成后再清理。');
    const stableCount = currentStableCount(identity);
    reusableAutomaticSnapshot = null;
    const current = { kind: 'cleaning', identity, promise: null };
    operation = current; notify();
    current.promise = (async () => {
      const snapshot = await scanSnapshot(identity);
      if (snapshot.status === 'ready' && snapshot.candidates.length === 0) rememberAutomaticSnapshot(identity, snapshot, stableCount);
      return cleanFromSnapshot(identity, snapshot, { automatic });
    })().catch(error => {
      if (inCurrentHost(identity)) setResult(identity, { status: resultState.stats ? 'ready' : 'error', error, lastResult: null });
      throw error;
    }).finally(() => { if (operation === current) operation = null; notify(); scheduleAutomatic(); });
    return current.promise;
  }

  const progress = () => {
    const value = settings.get().storageAutoCleanupProgress;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  };
  const updateProgress = (chatId, stableCount) => {
    const next = { ...progress(), [chatId]: Math.max(0, Math.floor(Number(stableCount) || 0)) };
    settings.update({ storageAutoCleanupProgress: next });
  };
  async function readTrashGcCapability({ retry = false } = {}) {
    if (retry && (trashGcCapability === 'error' || trashGcCapability === false)) trashGcCapability = null;
    if (trashGcCapability !== null) return trashGcCapability;
    if (!client?.collectExpiredTrash || typeof client?.health !== 'function') {
      trashGcCapability = false;
      return false;
    }
    if (!trashGcCapabilityCheck) trashGcCapabilityCheck = (async () => {
      try {
        const health = await client.health();
        trashGcCapability = health?.capabilities?.trashGc === true;
        return trashGcCapability;
      } catch (error) {
        if (error?.status === 404) {
          trashGcCapability = false;
          const unsupported = errorWith('QQJ_TRASH_GC_UNSUPPORTED', '回收站尚未清理；请更新白鳥数据后端并重启酒馆。');
          trashGcState = { ...trashGcState, status: 'unsupported', error: unsupported, automatic: true };
          notify();
          return false;
        }
        trashGcCapability = 'error';
        trashGcState = { ...trashGcState, status: 'error', error, automatic: true };
        notify();
        return 'error';
      } finally { trashGcCapabilityCheck = null; }
    })();
    return trashGcCapabilityCheck;
  }
  async function collectExpiredTrash({ automatic = false } = {}) {
    if (trashGcCheck) return trashGcCheck;
    if (automatic && trashGcCapability === false) return { status: 'unsupported', deleted: 0 };
    if (automatic) {
      if (disposed || !isEnabled?.()) return { status: 'idle', deleted: 0 };
      const completedAt = Date.parse(settings.get().storageTrashGcLastCompletedAt);
      if (Number.isFinite(completedAt) && Date.now() - completedAt < TRASH_GC_INTERVAL_MS) return { status: 'idle', deleted: 0 };
      if (Date.now() < trashGcRetryAfter) return { status: 'pending', deleted: 0 };
    }
    if (workBusy() || operation) {
      trashGcState = { ...trashGcState, status: 'pending', automatic, error: null };
      notify();
      return { status: 'pending', deleted: 0 };
    }
    const current = { kind: 'trashGc', identity: (() => { try { return currentIdentity(); } catch { return null; } })(), promise: null };
    operation = current;
    trashGcState = { ...trashGcState, status: 'checking', error: null, automatic };
    notify();
    current.promise = (async () => {
      const capability = await readTrashGcCapability({ retry: !automatic || (trashGcCapability === 'error' && Date.now() >= trashGcRetryAfter) });
      if (capability === false) {
        const error = errorWith('QQJ_TRASH_GC_UNSUPPORTED', '回收站尚未清理；请更新白鳥数据后端并重启酒馆。');
        trashGcProgress = null;
        trashGcRetryAfter = Date.now() + TRASH_GC_INTERVAL_MS;
        trashGcState = { ...trashGcState, status: 'unsupported', error, automatic };
        return { status: 'unsupported', deleted: 0, error };
      }
      if (capability === 'error') {
        const error = trashGcState.error ?? errorWith('QQJ_TRASH_GC_HEALTH_FAILED', '无法确认后端回收站清理能力。');
        trashGcRetryAfter = Date.now() + TRASH_GC_INTERVAL_MS;
        return { status: 'error', deleted: 0, error };
      }
      trashGcProgress ??= { cursor: null, scanned: 0, deleted: 0, failed: 0 };
      trashGcState = { status: 'running', ...trashGcProgress, error: null, automatic };
      let complete = false;
      while (!complete) {
        const page = await client.collectExpiredTrash(NAMESPACE, { limit: 32, cursor: trashGcProgress.cursor });
        if (!page || !Number.isSafeInteger(page.scanned) || page.scanned < 0
          || !Number.isSafeInteger(page.deleted) || page.deleted < 0
          || !Number.isSafeInteger(page.failed) || page.failed < 0 || typeof page.complete !== 'boolean'
          || (!page.complete && (!page.nextCursor || JSON.stringify(page.nextCursor) === JSON.stringify(trashGcProgress.cursor)))) {
          throw errorWith('QQJ_TRASH_GC_RESPONSE_INVALID', '后端回收站清理没有返回有效进度。');
        }
        trashGcProgress = { cursor: page.complete ? null : page.nextCursor,
          scanned: trashGcProgress.scanned + page.scanned, deleted: trashGcProgress.deleted + page.deleted,
          failed: trashGcProgress.failed + page.failed };
        trashGcState = { status: 'running', ...trashGcProgress, error: null, automatic };
        notify();
        complete = page.complete;
        if (!complete && (disposed || !isEnabled?.() || workBusy())) {
          trashGcState = { status: 'pending', ...trashGcProgress, error: null, automatic };
          return { status: 'pending', ...trashGcProgress };
        }
      }
      const result = { ...trashGcProgress };
      trashGcProgress = null;
      if (result.failed) {
        trashGcRetryAfter = Date.now() + TRASH_GC_INTERVAL_MS;
        trashGcState = { status: 'partial', ...result, error: errorWith('QQJ_TRASH_GC_PARTIAL', '部分回收站记录未能核验或清理；可在存储管理中手动重试。'), automatic };
        return { status: 'partial', ...result, error: trashGcState.error };
      }
      settings.update({ storageTrashGcLastCompletedAt: new Date().toISOString() });
      trashGcRetryAfter = 0;
      trashGcState = { status: 'completed', ...result, error: null, automatic };
      return { status: 'completed', ...result };
    })().catch(error => {
      trashGcRetryAfter = Date.now() + TRASH_GC_INTERVAL_MS;
      trashGcState = { status: 'error', ...(trashGcProgress ?? { scanned: 0, deleted: 0, failed: 0 }), error, automatic };
      return { status: 'error', ...trashGcProgress, error };
    }).finally(() => {
      if (operation === current) operation = null;
      notify();
      scheduleAutomatic();
    });
    trashGcCheck = current.promise.finally(() => { trashGcCheck = null; });
    return trashGcCheck;
  }
  async function checkAutomatic() {
    if (disposed) return;
    if (isEnabled?.()) await collectExpiredTrash({ automatic: true });
    if (disposed || !autoEnabled() || automaticCheck) return;
    const memory = memoryRuntime.getActivityState();
    if (!memory?.chatId || !Number.isSafeInteger(memory.stableCount) || memory.stableCount < 0) return;
    const identity = (() => { try { return capture(); } catch { return null; } })();
    if (!identity || identity.chatId !== memory.chatId) return;
    const previous = progress()[identity.chatId];
    if (!Number.isSafeInteger(previous) || previous < 0 || memory.stableCount < previous) {
      updateProgress(identity.chatId, memory.stableCount);
      automaticAttempts.delete(identity.chatId);
      setResult(identity, { autoPending: false });
      return;
    }
    if (memory.stableCount - previous < AUTO_FLOOR_INTERVAL) return;
    if (workBusy() || operation) { setResult(identity, { autoPending: true }); return; }
    const targetStableCount = memory.stableCount;
    setResult(identity, { autoPending: false });
    automaticCheck = (async () => {
      const current = { kind: 'scanning', identity, promise: null };
      operation = current; notify();
      current.promise = (async () => {
        const reusable = await takeReusableAutomaticSnapshot(identity, targetStableCount);
        if (reusable.stale) automaticAttempts.delete(identity.chatId);
        const previousAttempt = automaticAttempts.get(identity.chatId);
        if (!reusable.snapshot && !reusable.stale && previousAttempt
          && targetStableCount - previousAttempt.stableCount < AUTO_FLOOR_INTERVAL) {
          const currentAnchor = await currentRootAnchor(identity);
          if (rootMatchesAnchor({ status: currentAnchor.status, revision: currentAnchor.revision, data: currentAnchor }, previousAttempt.rootAnchor)) return false;
          automaticAttempts.delete(identity.chatId);
        }
        let snapshot = reusable.snapshot;
        if (!snapshot) {
          try { snapshot = await scanSnapshot(identity); }
          catch (error) {
            if (inCurrentHost(identity) && !['QQJ_STORAGE_ROOT_CHANGED', 'QQJ_STORAGE_ROOT_IDENTITY_MISMATCH', 'QQJ_STORAGE_CHAT_CHANGED'].includes(error?.code)) {
              try {
                const rootAnchor = await currentRootAnchor(identity);
                automaticAttempts.set(identity.chatId, { stableCount: targetStableCount, rootAnchor });
              } catch { /* A failed root read cannot establish a retry version. */ }
            }
            throw error;
          }
        }
        if (snapshot.status !== 'ready') return false;
        if (snapshot.stats.cleanup.count >= STORAGE_AUTO_RECORD_THRESHOLD || snapshot.stats.cleanup.bytes >= STORAGE_AUTO_BYTE_THRESHOLD) {
          current.kind = 'cleaning'; notify();
          await cleanFromSnapshot(identity, snapshot, { automatic: true });
        } else setResult(identity, { status: 'ready', stats: snapshot.stats, error: null, lastResult: null });
        return true;
      })();
      try {
        const completed = await current.promise;
        if (completed && inCurrentHost(identity)) {
          updateProgress(identity.chatId, targetStableCount);
          automaticAttempts.delete(identity.chatId);
        }
      } catch (error) {
        throw error;
      } finally {
        if (operation === current) operation = null;
        notify();
      }
    })().catch(error => {
      if (inCurrentHost(identity)) setResult(identity, { autoPending: ['QQJ_STORAGE_BUSY', 'QQJ_STORAGE_ROOT_CHANGED'].includes(error?.code), error });
      try { logger?.warn?.('[qianqianjie] 自动存储清理检查未完成', { code: error?.code ?? error?.name ?? 'QQJ_STORAGE_AUTO_FAILED' }); } catch { /* diagnostics only */ }
    }).finally(() => { automaticCheck = null; notify(); });
  }
  const scheduleAutomatic = () => { void Promise.resolve().then(checkAutomatic); };
  const activity = () => { notify(); scheduleAutomatic(); };
  const unsubscribers = [...new Set([memoryRuntime, ...activitySources])]
    .map(source => typeof source?.subscribe === 'function' ? source.subscribe(activity) : null).filter(Boolean);

  function setAutoEnabled(enabled) {
    const identity = capture();
    if (enabled === true && (!resultState.stats || resultState.chatId !== identity.chatId)) {
      throw errorWith('QQJ_STORAGE_AUTO_SCAN_REQUIRED', '请先刷新并查看当前聊天的存储统计，再开启自动清理。');
    }
    settings.update({ storageAutoCleanupEnabled: enabled === true });
    if (enabled === true) updateProgress(identity.chatId, memoryRuntime.getActivityState()?.stableCount ?? 0);
    setResult(identity, { autoPending: false });
    return scopedState();
  }

  scheduleAutomatic();
  return Object.freeze({
    scan,
    cleanup,
    collectExpiredTrash() { return collectExpiredTrash({ automatic: false }); },
    setAutoEnabled,
    getState: scopedState,
    subscribe(listener) { if (typeof listener !== 'function') throw new TypeError('存储管理 listener 无效'); subscribers.add(listener); return () => subscribers.delete(listener); },
    dispose() { disposed = true; for (const unsubscribe of unsubscribers) unsubscribe(); subscribers.clear(); },
  });
}
