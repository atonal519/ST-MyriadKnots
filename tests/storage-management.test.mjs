import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { classifyStorageRecords, createStorageManagement, STORAGE_AUTO_BYTE_THRESHOLD, STORAGE_AUTO_RECORD_THRESHOLD } from '../src/storage-management.js';
import { createFoundationStore } from '../src/v3/foundation-store.js';

const CHAT = '123e4567-e89b-42d3-a456-426614174000';
const HOST = 'host-chat';
const GENERATION = '223e4567-e89b-42d3-a456-426614174000';
const HEAD = '323e4567-e89b-42d3-a456-426614174000';
const RUN = '423e4567-e89b-42d3-a456-426614174000';
const FLOOR = '523e4567-e89b-42d3-a456-426614174000';
const MEMORY = '623e4567-e89b-42d3-a456-426614174000';
const ENTITY = '723e4567-e89b-42d3-a456-426614174000';
const BASELINE = '823e4567-e89b-42d3-a456-426614174000';
const DELTA = '923e4567-e89b-42d3-a456-426614174000';
const CURRENT = 'a23e4567-e89b-42d3-a456-426614174000';
const INDEX = 'b23e4567-e89b-42d3-a456-426614174000';
const USER = 'c23e4567-e89b-42d3-a456-426614174000';
const CHARACTER = 'd23e4567-e89b-42d3-a456-426614174000';
const NOW = '2026-09-21T00:00:00.000Z';
const HASH = `sha256:${'0'.repeat(64)}`;
const oldId = index => `f23e4567-e89b-42d3-a456-${String(index).padStart(12, '0')}`;

const prefixes = {
  floor: 'v3-floor-', floorMemory: 'v3-floor-memory-', entity: 'v3-entity-', baseline: 'v3-baseline-',
  stateDelta: 'v3-state-delta-', currentState: 'v3-current-state-', run: 'v3-run-', checkpoint: 'v3-checkpoint-',
};
const common = (type, id) => ({ schemaVersion: 3, recordType: type, id, chatId: CHAT, narrativeGeneration: GENERATION, createdAt: NOW, updatedAt: NOW, recordStatus: 'active', supersedes: null });
function validData(type, id) {
  if (type === 'run') return { ...common(type, id), parentCheckpointId: null, inputSnapshotFingerprint: null, mode: 'incremental', sessionEpoch: 1, inputFloorIds: [], phase: 'completed', completedFloorIds: [], failedItems: [], preparedRecordRefs: [], diagnostics: null, startedAt: NOW };
  if (type === 'checkpoint') return { ...common(type, id), parentCheckpointId: null, runId: RUN, sourceSnapshotFingerprint: null, indexLayout: null, capabilities: { foundationReady: true, memoryReady: false, cseReady: false, recallReady: false }, floorRange: { fromAssistantSeq: 0, toAssistantSeq: 0, floorIds: [] }, inputFingerprints: [], producedRefs: { floors: [], floorMemories: [], entities: [], events: [], claims: [], knowledge: [], stateDeltas: [], currentStates: [], stateProjections: [], episodes: [], threads: [], indexes: [] }, validation: { schemaValid: true, referencesValid: true, orderedReplayValid: true, stateFingerprint: HASH }, sealedAt: NOW };
  if (type === 'floor') {
    const canonicalContent = '测试楼层正文';
    const canonicalFingerprint = `sha256:${createHash('sha256').update(canonicalContent).digest('hex')}`;
    return { ...common(type, id), assistantSeq: 1, predecessorFloorId: null, hostLocator: { messageIndex: 1, swipeId: null, selectedSwipeIndex: null }, content: { canonicalContent, rawFingerprint: HASH, canonicalFingerprint, sanitizerFingerprint: HASH, formatVersion: 1 }, stability: { status: 'stable', stabilizedAt: NOW, stabilizedBy: 'manual' }, processing: { sourceSaved: true, memoryReady: false, cseRequired: false, cseReady: false, recallReady: false, runId: RUN, checkpointId: null } };
  }
  if (type === 'index') return { ...common(type, id), kind: 'floorOrder', shard: '0', sourceCheckpointId: HEAD, entries: [{ key: '1', refs: [{ recordType: 'floor', recordId: FLOOR, itemId: null }] }], entryCount: 1, contentFingerprint: HASH };
  if (type === 'floorMemory') return { ...common(type, id), floorId: FLOOR, extractorVersion: 'test', summary: { aiText: '摘要', userText: null, effectiveSource: 'ai', revisionNote: null }, summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  if (type === 'entity') return { ...common(type, id), entityType: 'person', displayName: '测试人物', aliases: [], specialRole: 'none', firstSeenFloorId: null, lastSeenFloorId: null, status: 'established', mergedIntoEntityId: null, mergeEvidenceRefs: [], baselineClaimIds: [] };
  if (type === 'baseline') return { ...common(type, id), userPersona: { entityId: USER, name: '用户', description: '', aliases: [] }, characterCard: { entityId: CHARACTER, name: '角色', description: '', personality: '', scenario: '' }, worldInfoSources: [], fingerprint: HASH };
  if (type === 'stateDelta') return { ...common(type, id), floorId: FLOOR, floorMemoryId: MEMORY, baselineId: BASELINE, previousCurrentStateId: null, subjectSnapshots: [], noMaterialChange: true, fingerprint: HASH, source: { promptVersion: 'test', compilerVersion: 'test' } };
  if (type === 'currentState') return { ...common(type, id), baselineId: BASELINE, subjects: [], appliedDeltaIds: [], headFloorId: null, fingerprint: HASH };
  throw new TypeError(`unknown test type: ${type}`);
}
function validEnvelope(type, id, revision = 1) {
  const data = validData(type, id);
  const recordId = type === 'index' ? `v3-index-${data.kind}-${data.shard}-${data.id}` : `${prefixes[type]}${id}`;
  return { recordId, revision, data };
}
function rootData(chatId = CHAT, headCheckpointId = HEAD) {
  return { schemaVersion: 3, recordType: 'root', id: 'root', chatId, narrativeGeneration: GENERATION, status: 'ready', capabilities: { foundationReady: true, memoryReady: true, cseReady: true, recallReady: false }, headCheckpointId, sourceSnapshotFingerprint: null, stableBoundary: { assistantSeq: 0, floorId: null, canonicalFingerprint: null }, baselineId: BASELINE, activeRunId: null, indexManifest: { floor: [], entity: [], event: [], claim: [], knowledge: [], episode: [], thread: [], state: [], anchor: [], reverseRef: [] }, activeStateRefs: [], activeThreadRefs: [], createdAt: NOW, updatedAt: NOW, recordStatus: 'active', supersedes: null };
}
function reachable(chatId = CHAT) {
  return {
    status: 'ready', rootRevision: 9,
    root: rootData(chatId),
    checkpoint: { id: HEAD, runId: RUN, producedRefs: { floors: [FLOOR], floorMemories: [MEMORY], entities: [ENTITY], stateDeltas: [DELTA], currentStates: [CURRENT], indexes: [validEnvelope('index', INDEX).recordId] } },
  };
}
function recordsWithOld(oldCount = 3) {
  const source = reachable();
  const current = [
    { recordId: 'v3-root', revision: 9, data: rootData() }, validEnvelope('checkpoint', HEAD, 2), validEnvelope('run', RUN, 3),
    validEnvelope('floor', source.checkpoint.producedRefs.floors[0], 4), validEnvelope('floorMemory', source.checkpoint.producedRefs.floorMemories[0], 5),
    validEnvelope('entity', source.checkpoint.producedRefs.entities[0], 6), validEnvelope('baseline', source.root.baselineId, 7),
    validEnvelope('stateDelta', source.checkpoint.producedRefs.stateDeltas[0], 8), validEnvelope('currentState', source.checkpoint.producedRefs.currentStates[0], 9),
    validEnvelope('index', INDEX, 10),
  ];
  const old = Array.from({ length: oldCount }, (_, index) => validEnvelope('run', oldId(index), 20 + index));
  return [...current, ...old,
    { recordId: 'v3-time-head', revision: 31, data: { chatId: CHAT } },
    { recordId: 'v3-time-batch-old', revision: 32, data: { chatId: CHAT } },
    { recordId: 'v3-people-workspace', revision: 33, data: { chatId: CHAT } },
    { recordId: 'binding-private', revision: 34, data: { chatId: CHAT } },
    { recordId: 'v3-run-malformed', revision: 35, data: { schemaVersion: 3, recordType: 'run', id: 'different', chatId: CHAT } },
    { recordId: 'unknown-record', revision: 36, data: { private: true } },
  ];
}

function fixture({ oldCount = 3, busy = false, rootChanged = false, rootChatId = CHAT, removeHook = null } = {}) {
  let items = recordsWithOld(oldCount), memoryState = { chatId: CHAT, stableCount: 10 }, isBusy = busy;
  const removes = [], ordinaryRemoves = [], listeners = new Set(), sessionCalls = [];
  const identity = { hostChatId: HOST, chatId: CHAT, characterLocator: 'char', personaLocator: 'persona' };
  let sessionState = { status: 'ready', identity };
  const session = {
    identity() {
      if (sessionState.status === 'suspended') throw Object.assign(new Error('suspended'), { code: 'CHAT_SESSION_SUSPENDED' });
      return identity;
    },
    suspend(chatId) { assert.equal(chatId, CHAT); sessionCalls.push('suspend'); sessionState = { status: 'suspended', identity }; return sessionState; },
    resume(chatId) { assert.equal(chatId, CHAT); sessionCalls.push('resume'); sessionState = { status: 'idle' }; return true; },
    async prepare() { sessionCalls.push('prepare'); sessionState = { status: 'ready', identity }; return sessionState; },
    getState: () => sessionState,
  };
  const settingsValue = { storageAutoCleanupEnabled: false, storageAutoCleanupProgress: {} };
  const settings = { get: () => settingsValue, update(patch) { Object.assign(settingsValue, structuredClone(patch)); } };
  const client = {
    async list() { return structuredClone(items); },
    async get(_collection, recordId) {
      assert.equal(recordId, 'v3-root');
      return { revision: rootChanged ? 10 : 9, data: rootData(CHAT, rootChanged ? RUN : HEAD) };
    },
    async remove(_collection, recordId, revision) {
      ordinaryRemoves.push([recordId, revision]);
      throw new Error('存储管理不得调用普通 remove');
    },
    async removePermanent(_collection, recordId, revision) {
      removes.push([recordId, revision]);
      await removeHook?.(recordId, revision, items);
      const index = items.findIndex(item => item.recordId === recordId);
      if (index < 0) throw Object.assign(new Error('missing'), { status: 404 });
      if (items[index].revision !== revision) throw Object.assign(new Error('conflict'), { status: 409 });
      items.splice(index, 1);
      return { trashId: recordId };
    },
  };
  const store = {
    async readReachable() { return structuredClone(reachable(rootChatId)); },
  };
  const memoryRuntime = {
    getState: () => memoryState,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const manager = createStorageManagement({
    client, store, settings, memoryRuntime,
    session,
    hostAdapter: { snapshot: () => ({ chatId: HOST, context: { chatMetadata: { qianqianjie: { chatId: CHAT } } } }) },
    isBusy: () => isBusy,
    logger: { warn() {} },
  });
  return {
    manager, removes, ordinaryRemoves, settingsValue, session, sessionCalls,
    setBusy(value) { isBusy = value; for (const listener of listeners) listener(memoryState); },
    setStableCount(value) { memoryState = { ...memoryState, stableCount: value }; for (const listener of listeners) listener(memoryState); },
    records: () => items,
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('统计只把通过生产完整 schema 校验且不可达的九类 foundation 记录列为旧版本', async () => {
  const oldTypes = ['run', 'checkpoint', 'currentState', 'index', 'floor', 'floorMemory', 'entity', 'baseline', 'stateDelta'];
  const oldRecords = oldTypes.map((type, index) => validEnvelope(type, oldId(index), 40 + index));
  const wrongChat = validEnvelope('run', oldId(20), 60); wrongChat.data.chatId = '223e4567-e89b-42d3-a456-426614174099';
  const malformed = validEnvelope('run', oldId(21), 61); delete malformed.data.phase;
  const records = [...recordsWithOld(0), ...oldRecords, wrongChat, malformed];
  const classified = await classifyStorageRecords(records, reachable(), CHAT);
  assert.equal(classified.stats.total.count, 27);
  assert.equal(classified.stats.active.count, 10);
  assert.equal(classified.stats.cleanup.count, 9);
  assert.equal(classified.stats.retained.count, 8);
  assert.equal(classified.candidates.length, 9);
  assert.deepEqual(new Set(classified.candidates.map(item => item.recordId)), new Set(oldRecords.map(item => item.recordId)));
});

test('大清单分类分批让出事件循环且分类结果与小清单规则一致', async () => {
  const old = validEnvelope('run', oldId(0), 40);
  const records = Array.from({ length: 120 }, (_, index) => ({
    ...structuredClone(old), recordId: `v3-run-${oldId(index)}`, revision: 40 + index,
    data: { ...structuredClone(old.data), id: oldId(index) },
  }));
  let yielded = false;
  const turn = new Promise(resolve => setTimeout(() => { yielded = true; resolve(); }, 0));
  const classified = await classifyStorageRecords(records, reachable(), CHAT);
  await turn;
  assert.equal(yielded, true);
  assert.equal(classified.stats.total.count, 120);
  assert.equal(classified.stats.cleanup.count, 120);
  assert.equal(classified.stats.retained.count, 0);
  assert.deepEqual(classified.candidates.map(item => item.recordId), records.map(item => item.recordId));
});

test('root 在扫描后变化时零删除，busy 时同样拒绝且不访问 remove', async () => {
  const changed = fixture({ rootChanged: true });
  await assert.rejects(changed.manager.cleanup(), error => error.code === 'QQJ_STORAGE_ROOT_CHANGED');
  assert.deepEqual(changed.removes, []);
  assert.deepEqual(changed.sessionCalls, ['suspend', 'resume', 'prepare'], 'root 变化异常路径也必须释放清理保护');
  const busy = fixture({ busy: true });
  await assert.rejects(busy.manager.cleanup(), error => error.code === 'QQJ_STORAGE_BUSY');
  assert.deepEqual(busy.removes, []);
  assert.deepEqual(busy.sessionCalls, [], '已有任务运行时不得通过 suspend 取消任务');
  const mismatched = fixture({ rootChatId: 'other-chat' });
  await assert.rejects(mismatched.manager.cleanup(), error => error.code === 'QQJ_STORAGE_ROOT_IDENTITY_MISMATCH');
  assert.deepEqual(mismatched.removes, []);
});

test('root 二次核验后到删除结束之间 session 保持暂停，新 foundation 写入无法取得身份', async () => {
  let f, writerStore, writerBlocked = false, writerCommitted = false;
  f = fixture({ oldCount: 1, removeHook: async () => {
    try { await writerStore.putRecord(validData('run', oldId(50))); }
    catch (error) { writerBlocked = error.code === 'CHAT_SESSION_SUSPENDED'; }
  } });
  writerStore = createFoundationStore({
    client: {
      async get() { throw new Error('writer should not read'); },
      async put() { writerCommitted = true; throw new Error('writer crossed maintenance gate'); },
    },
    contextProvider: () => f.session.identity(),
  });
  const result = await f.manager.cleanup();
  assert.equal(result.status, 'completed');
  assert.equal(writerBlocked, true);
  assert.equal(writerCommitted, false);
  assert.equal(f.removes.length, 1);
  assert.deepEqual(f.sessionCalls, ['suspend', 'resume', 'prepare']);
  assert.equal(f.session.getState().status, 'ready');
});

test('逐条使用 list revision；404 收敛，409 首错停止继续领项并报告部分失败', async () => {
  let first = true;
  const converged = fixture({ oldCount: 2, removeHook: async (recordId, _revision, items) => {
    if (first) { first = false; const index = items.findIndex(item => item.recordId === recordId); items.splice(index, 1); }
  } });
  const ok = await converged.manager.cleanup();
  assert.equal(ok.status, 'completed'); assert.equal(ok.deletedCount, 1); assert.equal(ok.convergedCount, 1); assert.equal(ok.remainingCount, 0);
  assert.deepEqual(converged.removes.map(([, revision]) => revision), [20, 21]);

  let failed = false;
  const conflict = fixture({ oldCount: 8, removeHook: async recordId => {
    if (!failed && recordId === `v3-run-${oldId(0)}`) { failed = true; throw Object.assign(new Error('conflict'), { status: 409 }); }
  } });
  const partial = await conflict.manager.cleanup();
  assert.equal(partial.status, 'partial'); assert.equal(partial.error.status, 409);
  assert.ok(conflict.removes.length <= 4, '首错后不再分配第5条，等待最多4条在途结束');
  assert.equal(conflict.manager.getState().stats.cleanup.count, partial.remainingCount, '失败后重新扫描并显示真实剩余量');

  const network = fixture({ oldCount: 8, removeHook: async recordId => {
    if (recordId === `v3-run-${oldId(0)}`) throw new TypeError('network unavailable');
  } });
  const networkPartial = await network.manager.cleanup();
  assert.equal(networkPartial.status, 'partial');
  assert.equal(networkPartial.error.message, 'network unavailable');
  assert.ok(network.removes.length <= 4, '网络首错后不再领取新记录');
});

test('旧后端对永久路径全量 404 时零删除并明确要求更新白鳥', async () => {
  const legacy = fixture({ oldCount: 3, removeHook: async () => { throw Object.assign(new Error('missing route'), { status: 404 }); } });
  const result = await legacy.manager.cleanup();
  assert.equal(result.status, 'partial');
  assert.equal(result.deletedCount, 0);
  assert.equal(result.convergedCount, 0);
  assert.equal(result.remainingCount, 3);
  assert.equal(result.error.code, 'QQJ_STORAGE_PERMANENT_DELETE_UNAVAILABLE');
  assert.match(result.error.message, /永久清理需要更新白鳥后端/u);
  assert.equal(legacy.removes.length, 3);
  assert.deepEqual(legacy.ordinaryRemoves, []);
});

test('自动清理默认关闭；显式开启后每新增10个稳定楼检查，忙碌顺延且达到100条才删', async () => {
  const f = fixture({ oldCount: STORAGE_AUTO_RECORD_THRESHOLD });
  assert.equal(f.manager.getState().autoEnabled, false);
  await f.manager.scan();
  f.manager.setAutoEnabled(true);
  assert.equal(f.settingsValue.storageAutoCleanupProgress[CHAT], 10, '开启时以当前稳定楼为起点，不清已有数据');
  f.setBusy(true); f.setStableCount(20); await tick();
  assert.equal(f.removes.length, 0); assert.equal(f.manager.getState().autoPending, true);
  f.setBusy(false);
  for (let index = 0; index < 200 && f.manager.getState().stats?.cleanup?.count !== 0; index += 1) await tick();
  assert.equal(f.removes.length, STORAGE_AUTO_RECORD_THRESHOLD);
  assert.equal(f.manager.getState().stats.cleanup.count, 0);
  assert.equal(f.settingsValue.storageAutoCleanupProgress[CHAT], 20);
});

test('自动清理的约 8 MiB 阈值与 100 条阈值为“或”关系', async () => {
  const f = fixture({ oldCount: 1 });
  await f.manager.scan();
  f.manager.setAutoEnabled(true);
  const old = f.records().find(item => item.recordId === `v3-run-${oldId(0)}`);
  old.data.diagnostics = { estimatedPayload: 'x'.repeat(STORAGE_AUTO_BYTE_THRESHOLD + 1) };
  f.setStableCount(20);
  for (let index = 0; index < 200 && f.manager.getState().stats?.cleanup?.count !== 0; index += 1) await tick();
  assert.equal(f.removes.length, 1);
  assert.equal(f.manager.getState().stats.cleanup.count, 0);
});
