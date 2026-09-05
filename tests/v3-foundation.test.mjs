import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHostAdapter } from '../src/v3/host-adapter.js';
import { createFoundationStore, reverseRefCandidateKeys } from '../src/v3/foundation-store.js';
import { buildFoundationIndexes, createFoundationRuntime, validatePreparedFoundation } from '../src/v3/foundation-runtime.js';
import { deterministicUuid, reverseRefShardPrefix, scanAssistantCandidates } from '../src/v3/foundation-domain.js';
import { sha256 } from '../src/identity.js';
import { createArchiveV2Session } from '../src/archive-v2-session.js';
import { createArchiveV2Lifecycle } from '../src/archive-v2-lifecycle.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_CHAT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const assistant = (mes, extra = {}) => ({ is_user: false, is_system: false, mes, swipes: [mes], swipe_id: 0, extra, ...extra });
const hiddenAssistant = mes => ({ ...assistant(mes), is_system: true, extra: {} });
const user = mes => ({ is_user: true, is_system: false, mes });
const system = (mes, type = 'generic') => ({ is_user: false, is_system: true, mes, extra: { type } });
const uuidFactory = (start = 0) => {
  let value = start;
  return () => `${(++value).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
};

function hostContext(chat = [assistant('A'), assistant('B'), assistant('C')], chatUuid = CHAT) {
  return {
    characterId: 0,
    groupId: null,
    chatId: `host-${chatUuid}`,
    characters: [{ avatar: 'character.png' }],
    userAvatar: 'persona.png',
    chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: chatUuid } },
    chat,
    eventTypes: {},
    eventSource: { on() {} },
  };
}

function backendHarness() {
  const records = new Map();
  const calls = [];
  let conflictRoot = false;
  let failPutPrefix = null;
  let beforePut = null;
  const runPhases = [];
  const envelope = (data, revision, createdAt) => ({
    schemaVersion: 1,
    revision,
    generationId: '11111111-1111-4111-8111-111111111111',
    createdAt,
    updatedAt: createdAt,
    data: structuredClone(data),
  });
  const error = status => Object.assign(new Error(`HTTP ${status}`), { status });
  return {
    records,
    calls,
    runPhases,
    setConflictRoot(value) { conflictRoot = value; },
    setFailPutPrefix(value) { failPutPrefix = value; },
    setBeforePut(value) { beforePut = value; },
    client: {
      async get(collection, key) {
        calls.push(['get', collection, key]);
        const record = records.get(`${collection}/${key}`);
        if (!record) throw error(404);
        return envelope(record.data, record.revision, record.createdAt);
      },
      async put(collection, key, data, expectedRevision) {
        calls.push(['put', collection, key, expectedRevision]);
        if (beforePut) await beforePut({ collection, key, data, expectedRevision });
        const mapKey = `${collection}/${key}`;
        const previous = records.get(mapKey);
        if (failPutPrefix && key.startsWith(failPutPrefix)) throw error(503);
        if (key === 'v3-root' && conflictRoot) throw error(409);
        if ((previous?.revision ?? 0) !== expectedRevision) throw error(409);
        const revision = (previous?.revision ?? 0) + 1;
        const createdAt = previous?.createdAt ?? '2026-09-02T00:00:00.000Z';
        records.set(mapKey, { revision, createdAt, data: structuredClone(data) });
        if (key.startsWith('v3-run-')) runPhases.push(data.phase);
        return envelope(data, revision, createdAt);
      },
    },
  };
}

function harness(chat = [assistant('A'), assistant('B'), assistant('C')], { enhanced = false, prepareSession = null } = {}) {
  let context = hostContext(chat);
  let enabled = true;
  const handlers = new Map();
  context.eventTypes = Object.fromEntries(['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MORE_MESSAGES_LOADED', 'MESSAGE_UPDATED'].map(name => [name, name]));
  context.eventSource = { on: (name, handler) => handlers.set(name, handler) };
  const standard = { getContext: () => context };
  const globalRef = enhanced ? { SillyTavern: standard, Luker: { getContext: () => context } } : { SillyTavern: standard };
  const hostAdapter = createHostAdapter({ globalRef });
  const backend = backendHarness();
  const identityProvider = () => ({ hostChatId: context.chatId, chatId: context.chatMetadata.qianqianjie.chatId, characterLocator: 'character.png', personaLocator: 'persona.png' });
  const store = createFoundationStore({ client: backend.client, contextProvider: identityProvider, isEnabled: () => enabled });
  const runtime = createFoundationRuntime({
    hostAdapter,
    store,
    contextProvider: () => context,
    prepareSession,
    isEnabled: () => enabled,
    newUuid: uuidFactory(),
    now: () => new Date('2026-09-02T00:00:00.000Z'),
    logger: { warn() {} },
  });
  runtime.bind({ eventSource: context.eventSource, eventTypes: context.eventTypes });
  return {
    runtime, backend, handlers,
    get context() { return context; },
    setChat(next, uuid = CHAT) { context.chat = next; context.chatMetadata.qianqianjie.chatId = uuid; context.chatId = `host-${uuid}`; },
    setEnabled(value) { enabled = value; },
  };
}

test('HostAdapter 优先 official-only SillyTavern，且增强能力只由真实 metadata 字段触发', () => {
  const official = { chat: [] };
  let lukerReads = 0;
  const officialAdapter = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => official }, Luker: { getContext: () => { lukerReads += 1; return null; } } } });
  assert.equal(officialAdapter.getContext(), official);
  assert.equal(officialAdapter.snapshot().source, 'SillyTavern');
  assert.equal(lukerReads, 0, '标准入口存在时不得把 Luker 全局本身当成 metadata 能力');
  assert.equal(officialAdapter.snapshot().mode, 'standard');
  assert.deepEqual(officialAdapter.mutationMetadata([{ messageIndex: 2 }]), { messageIndex: 2 });
  assert.equal(officialAdapter.snapshot().mode, 'enhanced');
  const fallback = { chat: [] };
  const lukerAdapter = createHostAdapter({ globalRef: { Luker: { getContext: () => fallback } } });
  assert.equal(lukerAdapter.snapshot().source, 'Luker');
  assert.equal(lukerAdapter.snapshot().mode, 'standard');
});

test('纯扫描只枚举有效 AI 楼，3 楼得到 2 stable + 1 pending；确认后得到 3 stable', async () => {
  const chat = [user('不要保存'), assistant('<content>A</content>'), system('系统'), assistant('B'), user('继续'), assistant('C')];
  const candidates = await scanAssistantCandidates(chat);
  assert.deepEqual(candidates.map(item => [item.assistantSeq, item.hostLocator.messageIndex, item.canonicalContent]), [[1, 1, 'A'], [2, 3, 'B'], [3, 5, 'C']]);
  assert.ok(candidates.every(item => /^sha256:[0-9a-f]{64}$/.test(item.rawFingerprint)));
  const h = harness(chat);
  let state = await h.runtime.start();
  assert.equal(state.stableCount, 2);
  assert.equal(state.pending.assistantSeq, 3);
  state = await h.runtime.confirmLatest();
  assert.equal(state.stableCount, 3);
  assert.equal(state.pending, null);
  assert.equal(state.foundationStatus, 'ready');
  assert.deepEqual(state.stableBoundary.assistantSeq, 3);
});

test('V3 真实 AI 判定保留各类隐藏 AI，只排除带宿主 type 的真系统楼', async () => {
  const chat = [
    assistant('普通 AI'),
    hiddenAssistant('/hide AI'),
    { ...assistant('is_hidden AI'), is_hidden: true },
    { ...assistant('extra.is_hidden AI'), extra: { is_hidden: true } },
    user('user'),
    { mes: 'unknown role' },
    system('generic system', 'generic'),
    system('narrator system', 'narrator'),
    system('comment system', 'comment'),
  ];
  const candidates = await scanAssistantCandidates(chat);
  assert.deepEqual(candidates.map(item => [item.assistantSeq, item.hostLocator.messageIndex, item.canonicalContent]), [
    [1, 0, '普通 AI'],
    [2, 1, '/hide AI'],
    [3, 2, 'is_hidden AI'],
    [4, 3, 'extra.is_hidden AI'],
  ]);
});

test('初始化时 /hide AI 与普通 AI 共用相同 stable／pending 规则', async () => {
  const hiddenStable = harness([hiddenAssistant('隐藏 stable'), assistant('普通 pending')]);
  let state = await hiddenStable.runtime.start();
  assert.equal(state.stableCount, 1);
  assert.equal(state.pending.assistantSeq, 2);
  assert.equal(state.pending.messageIndex, 1);

  const hiddenPending = harness([assistant('普通 stable'), hiddenAssistant('隐藏 pending')]);
  state = await hiddenPending.runtime.start();
  assert.equal(state.stableCount, 1);
  assert.equal(state.pending.assistantSeq, 2);
  assert.equal(state.pending.messageIndex, 1);
  state = await hiddenPending.runtime.confirmLatest();
  assert.equal(state.stableCount, 2);
  assert.equal(state.pending, null);
});

test('缺失或未知 is_user 角色绝不被当作 AI 楼持久化', async () => {
  const candidates = await scanAssistantCandidates([
    { mes: 'unknown' },
    { is_system: false, mes: 'also-unknown' },
    { is_user: null, is_system: false, mes: 'null-role' },
    assistant('valid'),
  ]);
  assert.deepEqual(candidates.map(item => item.canonicalContent), ['valid']);
});

test('user 楼漂移只更新 locator 索引，不改变 floorId 或 assistantSeq', async () => {
  const h = harness([assistant('A'), user('x'), assistant('B'), assistant('C')]);
  await h.runtime.start();
  await h.runtime.confirmLatest();
  const firstRoot = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  const firstCheckpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${firstRoot.headCheckpointId}`).data;
  const ids = firstCheckpoint.floorRange.floorIds;
  h.context.chat.unshift(user('前置噪音'));
  const state = await h.runtime.refreshStatus();
  const nextRoot = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  const nextCheckpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${nextRoot.headCheckpointId}`).data;
  assert.deepEqual(nextCheckpoint.floorRange.floorIds, ids);
  assert.equal(state.status, 'ready', JSON.stringify(state));
  assert.equal(state.lastRun.mode, 'incremental');
  assert.equal(state.stableCount, 3);
});

test('pending swipe 只换候选；stable swipe 新建世代并保留可信前缀', async () => {
  const h = harness([assistant('A'), assistant('B'), assistant('C')], { enhanced: true });
  let state = await h.runtime.start();
  const generation = h.backend.records.get(`chat-${CHAT}/v3-root`).data.narrativeGeneration;
  h.context.chat[2] = assistant('C2');
  state = await h.runtime.refreshStatus();
  assert.equal(state.stableCount, 2);
  assert.equal(h.backend.records.get(`chat-${CHAT}/v3-root`).data.narrativeGeneration, generation);
  h.context.chat[1] = assistant('B2');
  state = await h.runtime.refreshStatus();
  const nextRoot = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  assert.notEqual(nextRoot.narrativeGeneration, generation);
  assert.equal(state.lastRun.result, 'trustedPrefix:1');
  assert.equal(state.stableCount, 2);
});

test('canonical 相同的稳定编辑不重建；标点级变化直接从最早楼 branchReplay', async () => {
  const h = harness([assistant(' A '), assistant('B'), assistant('C')]);
  await h.runtime.start();
  const firstRoot = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  const firstCheckpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${firstRoot.headCheckpointId}`).data;
  const generation = firstRoot.narrativeGeneration;
  h.context.chat[0] = assistant('\nA\n');
  let state = await h.runtime.refreshStatus();
  const formatOnlyRoot = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  const formatOnlyCheckpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${formatOnlyRoot.headCheckpointId}`).data;
  assert.equal(formatOnlyRoot.narrativeGeneration, generation);
  assert.deepEqual(formatOnlyCheckpoint.floorRange.floorIds, firstCheckpoint.floorRange.floorIds);
  assert.equal(state.status, 'ready');
  h.context.chat[0] = assistant('A！');
  state = await h.runtime.refreshStatus();
  assert.equal(state.status, 'ready');
  assert.equal(state.lastRun.mode, 'branchReplay');
  assert.equal(state.lastRun.result, 'trustedPrefix:0');
  assert.notEqual(h.backend.records.get(`chat-${CHAT}/v3-root`).data.narrativeGeneration, generation);
});

test('删除早期 AI 后可信前缀严格为 f-1；official 最小参数与 Luker metadata 结果一致', async () => {
  const outcomes = [];
  for (const enhanced of [false, true]) {
    const h = harness([assistant('A'), assistant('B'), assistant('C'), assistant('D')], { enhanced });
    await h.runtime.start();
    h.context.chat.splice(1, 1);
    h.handlers.get('MESSAGE_DELETED')(...(enhanced ? [1, { messageIndex: 1, range: [1, 1] }] : [1]));
    await Promise.resolve();
    const state = await h.runtime.refreshStatus();
    outcomes.push([state.stableCount, state.lastRun.result]);
  }
  assert.deepEqual(outcomes, [[2, 'trustedPrefix:1'], [2, 'trustedPrefix:1']]);
});

test('CAS 冲突时 root 不前移，staged 不成为 active', async () => {
  const h = harness();
  await h.runtime.start();
  const rootBefore = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-root`));
  h.context.chat.push(assistant('D'));
  h.backend.setConflictRoot(true);
  const state = await h.runtime.refreshStatus();
  const rootAfter = h.backend.records.get(`chat-${CHAT}/v3-root`);
  assert.equal(state.status, 'conflict');
  assert.deepEqual(rootAfter, rootBefore);
  assert.ok(state.unreachableCount > 0);
});

test('CAS 冲突前旧 root 可达 checkpoint、floors、indexes 逐字不变，locator-only 也走 COW', async () => {
  const h = harness([assistant('A'), user('x'), assistant('B'), assistant('C')]);
  await h.runtime.start();
  await h.runtime.confirmLatest();
  const rootKey = `chat-${CHAT}/v3-root`;
  const oldRoot = structuredClone(h.backend.records.get(rootKey));
  const oldCheckpointKey = `chat-${CHAT}/v3-checkpoint-${oldRoot.data.headCheckpointId}`;
  const oldCheckpoint = structuredClone(h.backend.records.get(oldCheckpointKey));
  const oldKeys = [
    rootKey,
    oldCheckpointKey,
    ...oldCheckpoint.data.producedRefs.floors.map(id => `chat-${CHAT}/v3-floor-${id}`),
    ...oldCheckpoint.data.producedRefs.indexes.map(key => `chat-${CHAT}/${key}`),
  ];
  const byteSnapshots = new Map(oldKeys.map(key => [key, JSON.stringify(h.backend.records.get(key))]));
  h.context.chat.unshift(user('前置 user 只让 locator 漂移'));
  h.backend.setConflictRoot(true);
  const state = await h.runtime.refreshStatus();
  assert.equal(state.status, 'conflict');
  for (const [key, bytes] of byteSnapshots) assert.equal(JSON.stringify(h.backend.records.get(key)), bytes, key);
  const activeStore = createFoundationStore({
    client: h.backend.client,
    contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }),
  });
  const reachable = await activeStore.readReachable();
  assert.equal(reachable.checkpoint.id, oldRoot.data.headCheckpointId);
  assert.deepEqual(reachable.checkpoint.floorRange.floorIds, oldCheckpoint.data.floorRange.floorIds);
  assert.ok([...h.backend.records.keys()].some(key => key.includes('v3-checkpoint-') && key !== oldCheckpointKey), '应存在不可达的 staged checkpoint');
});

test('run 按真实阶段持久化；写失败为 retryableError，CAS 冲突为 stale', async () => {
  const success = harness();
  await success.runtime.start();
  assert.deepEqual(success.backend.runPhases.slice(0, 5), ['capturing', 'validating', 'sealing', 'committing', 'completed']);
  const root = success.backend.records.get(`chat-${CHAT}/v3-root`).data;
  const checkpoint = success.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  const persistedRun = success.backend.records.get(`chat-${CHAT}/v3-run-${checkpoint.runId}`).data;
  assert.equal(persistedRun.phase, 'completed');
  assert.equal(success.runtime.getState().lastRun.phase, persistedRun.phase);

  const failed = harness();
  failed.backend.setFailPutPrefix('v3-floor-');
  await failed.runtime.start();
  assert.equal(failed.backend.runPhases.at(-1), 'retryableError');
  assert.equal([...failed.backend.records.values()].find(item => item.data.recordType === 'run').data.phase, 'retryableError');

  const conflicted = harness();
  await conflicted.runtime.start();
  conflicted.context.chat.push(assistant('D'));
  conflicted.backend.setConflictRoot(true);
  await conflicted.runtime.refreshStatus();
  assert.equal(conflicted.backend.runPhases.at(-1), 'stale');
  assert.equal(conflicted.runtime.getState().lastRun.phase, 'stale');
});

test('FloorRecord 写失败时 root 不前移，真实网络错误进入 retryableError', async () => {
  const h = harness();
  await h.runtime.start();
  const rootBefore = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-root`));
  h.context.chat.push(assistant('D'));
  h.backend.setFailPutPrefix('v3-floor-');
  const state = await h.runtime.refreshStatus();
  assert.equal(state.status, 'error');
  assert.equal(state.lastRun.phase, 'retryableError');
  assert.deepEqual(h.backend.records.get(`chat-${CHAT}/v3-root`), rootBefore);
});

test('floor／index／checkpoint 任一 staged 写失败都持久化 retryableError', async () => {
  for (const prefix of ['v3-floor-', 'v3-index-', 'v3-checkpoint-']) {
    const h = harness();
    h.backend.setFailPutPrefix(prefix);
    const state = await h.runtime.start();
    assert.equal(state.status, 'error', prefix);
    const runs = [...h.backend.records.values()].filter(item => item.data.recordType === 'run');
    assert.equal(runs.at(-1).data.phase, 'retryableError', prefix);
    assert.equal(h.backend.records.has(`chat-${CHAT}/v3-root`), false, prefix);
  }
});

test('后端恢复得到相同 stableBoundary，warm reconcile 不按楼读取详情', async () => {
  const h = harness();
  const first = await h.runtime.start();
  const readsBefore = h.backend.calls.filter(call => call[0] === 'get').length;
  const warm = await h.runtime.refreshStatus();
  assert.deepEqual(warm.stableBoundary, first.stableBoundary);
  assert.equal(h.backend.calls.filter(call => call[0] === 'get').length, readsBefore);
  const secondStore = createFoundationStore({
    client: h.backend.client,
    contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }),
  });
  const secondRuntime = createFoundationRuntime({ hostAdapter: createHostAdapter({ globalRef: { SillyTavern: { getContext: () => h.context } } }), store: secondStore, contextProvider: () => h.context, newUuid: uuidFactory(), now: () => new Date('2026-09-02T00:00:00.000Z'), logger: { warn() {} } });
  const recovered = await secondRuntime.start();
  assert.deepEqual(recovered.stableBoundary, first.stableBoundary);
  const coldReads = h.backend.calls.filter(call => call[0] === 'get').length - readsBefore;
  const activeRoot = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  const activeCheckpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${activeRoot.headCheckpointId}`).data;
  const runtimeIndexCount = activeCheckpoint.producedRefs.indexes.filter(key => key.startsWith('v3-index-floorOrder-') || key.startsWith('v3-index-fingerprint-')).length;
  assert.equal(coldReads, 3 + activeCheckpoint.producedRefs.floors.length + runtimeIndexCount,
    'get-only 后端冷恢复只读取 root + checkpoint + run + N floors + 运行时所需索引');
  assert.ok(runtimeIndexCount < activeCheckpoint.producedRefs.indexes.length, '冷恢复不会读取 entity/reverseRef 等运行时无关索引');
});

test('明确 legacy 快照缺失可重建索引时从 root 可达 FloorRecord 重封口，不读取旧世代', async () => {
  const h = harness();
  await h.runtime.start();
  const root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  const checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  const run = h.backend.records.get(`chat-${CHAT}/v3-run-${checkpoint.runId}`).data;
  delete root.sourceSnapshotFingerprint;
  delete checkpoint.sourceSnapshotFingerprint;
  delete run.inputSnapshotFingerprint;
  h.backend.records.delete(`chat-${CHAT}/${checkpoint.producedRefs.indexes[0]}`);
  const store = createFoundationStore({ client: h.backend.client, contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }) });
  const runtime = createFoundationRuntime({ hostAdapter: createHostAdapter({ globalRef: { SillyTavern: { getContext: () => h.context } } }), store, contextProvider: () => h.context, newUuid: uuidFactory(10000), now: () => new Date('2026-09-02T00:00:00.000Z'), logger: { warn() {} } });
  const state = await runtime.start();
  assert.equal(state.status, 'ready');
  assert.equal(state.stableCount, 2);
  assert.notEqual(state.headCheckpointId, root.headCheckpointId);
});

test('reachable 读模式按用途裁剪索引，projection 零索引读取且 full 保留完整校验', async () => {
  const h = harness();
  await h.runtime.start();
  const store = createFoundationStore({
    client: h.backend.client,
    contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }),
  });
  h.backend.calls.splice(0);
  const projected = await store.readReachable({ mode: 'projection' });
  assert.equal(projected.status, 'ready');
  assert.equal(projected.indexesComplete, false);
  assert.equal(h.backend.calls.some(call => call[0] === 'get' && call[2].startsWith('v3-index-')), false);

  h.backend.calls.splice(0);
  const runtime = await store.readReachable({ mode: 'runtime' });
  const runtimeIndexGets = h.backend.calls.filter(call => call[0] === 'get' && call[2].startsWith('v3-index-')).map(call => call[2]);
  assert.ok(runtimeIndexGets.length > 0);
  assert.ok(runtimeIndexGets.every(key => key.startsWith('v3-index-floorOrder-') || key.startsWith('v3-index-fingerprint-')));
  assert.equal(runtime.indexesComplete, false);

  h.backend.calls.splice(0);
  const full = await store.readReachable();
  assert.equal(full.indexesComplete, true);
  assert.equal(h.backend.calls.filter(call => call[0] === 'get' && call[2].startsWith('v3-index-')).length, full.checkpoint.producedRefs.indexes.length);
});

test('现代 active manifest 指向缺失索引时拒绝 ready，不冒充 legacy 重封口', async () => {
  const h = harness();
  await h.runtime.start();
  const root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  const checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  h.backend.records.delete(`chat-${CHAT}/${checkpoint.producedRefs.indexes[0]}`);
  const store = createFoundationStore({
    client: h.backend.client,
    contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }),
  });
  await assert.rejects(store.readReachable(), error => error?.code === 'V3_STORE_INDEX_MISSING');
});

test('150 AI 楼为 149 stable，手动确认后 150；不持久化 user 正文并记录线性性能证据', async () => {
  const chat = [];
  for (let index = 1; index <= 150; index += 1) chat.push(user(`USER-SECRET-${index}`), assistant(`AI-${index}`));
  const h = harness(chat);
  let state = await h.runtime.start();
  assert.equal(state.stableCount, 149);
  assert.equal(state.metrics.algorithm, 'ordered-O(n)');
  assert.ok(state.metrics.maximumChunkMs >= 0);
  state = await h.runtime.confirmLatest();
  assert.equal(state.stableCount, 150);
  const persisted = JSON.stringify([...h.backend.records.values()].map(item => item.data));
  assert.equal(persisted.includes('USER-SECRET'), false);
  assert.equal((persisted.match(/AI-/g) || []).length >= 150, true);
});

test('插件关闭时事件、start 与刷新均不读写后端', async () => {
  const h = harness();
  h.setEnabled(false);
  await h.runtime.setEnabled(false);
  await h.runtime.start();
  await h.runtime.refreshStatus();
  h.handlers.get('MESSAGE_RECEIVED')?.(2);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.backend.calls.length, 0);
});

test('事件合同绑定正文与结构事件，但忽略纯渲染事件与 MESSAGE_UPDATED', async () => {
  const h = harness();
  for (const name of ['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MORE_MESSAGES_LOADED']) assert.equal(typeof h.handlers.get(name), 'function', name);
  assert.equal(h.handlers.has('CHARACTER_MESSAGE_RENDERED'), false);
  assert.equal(h.handlers.has('MESSAGE_UPDATED'), false);
  const before = h.backend.calls.length;
  h.handlers.get('MORE_MESSAGES_LOADED')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.backend.calls.length, before);
});

test('official/Luker 新 AI 楼只由 MESSAGE_RECEIVED 触发一次地基收敛，并保持 N-1 边界', async () => {
  for (const enhanced of [false, true]) {
    const h = harness([assistant('A'), assistant('B'), assistant('C')], { enhanced });
    await h.runtime.start();
    const rootWritesBefore = h.backend.calls.filter(call => call[0] === 'put' && call[2] === 'v3-root').length;
    h.context.chat.push(assistant('D'));
    h.handlers.get('MESSAGE_RECEIVED')(3);
    h.handlers.get('CHARACTER_MESSAGE_RENDERED')?.(3);
    for (let attempt = 0; attempt < 100 && (h.runtime.getState().status !== 'ready' || h.runtime.getState().stableCount !== 3); attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
    const state = h.runtime.getState();
    assert.equal(state.chatId, CHAT);
    assert.equal(state.status, 'ready');
    assert.equal(state.stableCount, 3);
    assert.equal(state.pending.assistantSeq, 4);
    const rootWritesAfter = h.backend.calls.filter(call => call[0] === 'put' && call[2] === 'v3-root').length;
    assert.equal(rootWritesAfter - rootWritesBefore, 1, enhanced ? 'Luker' : 'official');
  }
});

test('300/600 楼扫描保持有序线性，并按 50 楼异步让步', async () => {
  for (const count of [300, 600]) {
    let yields = 0;
    const metrics = {};
    const result = await scanAssistantCandidates(Array.from({ length: count }, (_, index) => assistant(`floor-${index}`)), { metrics, yieldControl: async () => { yields += 1; } });
    assert.equal(result.length, count);
    assert.equal(result.at(-1).assistantSeq, count);
    assert.equal(yields, Math.floor(count / 50));
    assert.ok(metrics.maximumChunkMs >= 0);
  }
});

test('CHAT_CHANGED 使迟到扫描失效且不能串到新 chat', async () => {
  const h = harness(Array.from({ length: 60 }, (_, index) => assistant(`old-${index}`)));
  const pendingRun = h.runtime.start();
  h.setChat([assistant('new-A'), assistant('new-B')], OTHER_CHAT);
  h.handlers.get('CHAT_CHANGED')();
  await pendingRun;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal([...h.backend.records.keys()].some(key => key.startsWith(`chat-${CHAT}/v3-root`)), false);
  const state = h.runtime.getState();
  assert.ok([OTHER_CHAT, null].includes(state.chatId));
});

test('旧 epoch 身份准备迟到不得用 stale/null 覆盖已完成的新 chat', async () => {
  let prepareCalls = 0, releaseOld, oldStartedResolve;
  const oldStarted = new Promise(resolve => { oldStartedResolve = resolve; });
  const h = harness([assistant('old-A'), assistant('old-B')], {
    prepareSession: async () => {
      prepareCalls += 1;
      if (prepareCalls !== 1) return { status: 'ready' };
      oldStartedResolve();
      await new Promise(resolve => { releaseOld = resolve; });
      return { status: 'ready' };
    },
  });
  const oldRun = h.runtime.start();
  await oldStarted;
  h.setChat([assistant('new-A'), assistant('new-B')], OTHER_CHAT);
  h.handlers.get('CHAT_CHANGED')();
  for (let attempt = 0; attempt < 100 && (h.runtime.getState().status !== 'ready' || h.runtime.getState().chatId !== OTHER_CHAT); attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  const newState = h.runtime.getState();
  assert.equal(newState.status, 'ready');
  assert.equal(newState.chatId, OTHER_CHAT);
  assert.equal(newState.stableCount, 1);
  releaseOld();
  await oldRun;
  const finalState = h.runtime.getState();
  assert.equal(finalState.status, 'ready');
  assert.equal(finalState.chatId, OTHER_CHAT);
  assert.equal(finalState.stableCount, 1);
});

test('聊天切换发生在 staged 写入途中时，旧 chat run 最终持久化 stale', async () => {
  const h = harness([assistant('A'), assistant('B'), assistant('C')]);
  await h.runtime.start();
  h.context.chat.push(assistant('D'));
  let releaseIndex;
  let signalBlocked;
  const blocked = new Promise(resolve => { signalBlocked = resolve; });
  const release = new Promise(resolve => { releaseIndex = resolve; });
  let held = false;
  h.backend.setBeforePut(async ({ key }) => {
    if (held || !key.startsWith('v3-index-')) return;
    held = true;
    signalBlocked();
    await release;
  });
  const lateRun = h.runtime.refreshStatus();
  await blocked;
  h.setChat([assistant('new-A'), assistant('new-B')], OTHER_CHAT);
  h.handlers.get('CHAT_CHANGED')();
  releaseIndex();
  await lateRun;
  h.backend.setBeforePut(null);
  await new Promise(resolve => setTimeout(resolve, 20));
  const oldRuns = [...h.backend.records.entries()]
    .filter(([key, item]) => key.startsWith(`chat-${CHAT}/v3-run-`) && item.data.mode === 'incremental')
    .map(([, item]) => item.data);
  assert.equal(oldRuns.at(-1).phase, 'stale');
  assert.notEqual(h.runtime.getState().chatId, CHAT);
});

test('CHAT_CHANGED 先于 UUID 落盘时复用 session.prepare，最终 ready 且无未处理拒绝', async () => {
  const context = hostContext([assistant('A'), assistant('B')]);
  delete context.chatMetadata.qianqianjie;
  const handlers = new Map();
  context.eventTypes = Object.fromEntries(EVENT_NAMES.map(name => [name, name]));
  context.eventSource = { on: (name, handler) => handlers.set(name, handler) };
  const backend = backendHarness();
  let prepareCalls = 0;
  const prepareSession = async () => {
    prepareCalls += 1;
    await new Promise(resolve => setImmediate(resolve));
    context.chatMetadata.qianqianjie = { schemaVersion: 1, chatId: CHAT };
    return { status: 'ready' };
  };
  const identityProvider = () => ({ hostChatId: context.chatId, chatId: context.chatMetadata.qianqianjie?.chatId, characterLocator: 'character.png', personaLocator: 'persona.png' });
  const store = createFoundationStore({ client: backend.client, contextProvider: identityProvider });
  const runtime = createFoundationRuntime({
    hostAdapter: createHostAdapter({ globalRef: { SillyTavern: { getContext: () => context } } }),
    store, contextProvider: () => context, prepareSession, newUuid: uuidFactory(8000),
    now: () => new Date('2026-09-02T00:00:00.000Z'), logger: { warn() {} },
  });
  runtime.bind({ eventSource: context.eventSource, eventTypes: context.eventTypes });
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    handlers.get('CHAT_CHANGED')();
    await new Promise(resolve => setTimeout(resolve, 40));
  } finally { process.off('unhandledRejection', onUnhandled); }
  assert.equal(prepareCalls, 1);
  assert.equal(runtime.getState().status, 'ready');
  assert.equal(runtime.getState().chatId, CHAT);
  assert.deepEqual(unhandled, []);
});

test('同 chat 两个并发 run 只有一个 root CAS 合法提交', async () => {
  const h = harness([assistant('A'), assistant('B'), assistant('C')]);
  const secondStore = createFoundationStore({
    client: h.backend.client,
    contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }),
  });
  const second = createFoundationRuntime({
    hostAdapter: createHostAdapter({ globalRef: { SillyTavern: { getContext: () => h.context } } }),
    store: secondStore, contextProvider: () => h.context, newUuid: uuidFactory(9000),
    now: () => new Date('2026-09-02T00:00:00.000Z'), logger: { warn() {} },
  });
  let releaseFirst;
  let signalFirst;
  const firstAtRoot = new Promise(resolve => { signalFirst = resolve; });
  const firstRelease = new Promise(resolve => { releaseFirst = resolve; });
  let held = false;
  h.backend.setBeforePut(async ({ key }) => {
    if (key !== 'v3-root' || held) return;
    held = true;
    signalFirst();
    await firstRelease;
  });
  const first = h.runtime.start();
  await firstAtRoot;
  const secondResult = await second.start();
  releaseFirst();
  const outcomes = [await first, secondResult];
  h.backend.setBeforePut(null);
  assert.ok(outcomes.some(item => item.status === 'ready'));
  const root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  const checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  assert.equal(checkpoint.floorRange.toAssistantSeq, 2);
});

test('swipe 删除：未选项不回退，当前选中项删除从该楼分歧', async () => {
  const swiped = (values, selected) => ({ is_user: false, is_system: false, mes: values[selected], swipes: values, swipe_id: selected });
  const h = harness([swiped(['A0', 'A1'], 0), assistant('B'), assistant('C')]);
  await h.runtime.start();
  await h.runtime.confirmLatest();
  const rootBefore = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-root`).data);
  h.context.chat[0] = swiped(['A0'], 0);
  let state = await h.runtime.refreshStatus();
  assert.equal(state.headCheckpointId, rootBefore.headCheckpointId);
  h.context.chat[0] = swiped(['A2'], 0);
  state = await h.runtime.refreshStatus();
  assert.equal(state.lastRun.result, 'trustedPrefix:0');
  assert.notEqual(state.stableBoundary.floorId, rootBefore.stableBoundary.floorId);
});

test('user 楼编辑不改正式链，删除只更新 locator index；大面积回退仍为 f-1', async () => {
  const h = harness([assistant('A'), user('x'), assistant('B'), user('y'), assistant('C'), assistant('D')]);
  await h.runtime.start();
  await h.runtime.confirmLatest();
  const before = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  const beforeCheckpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${before.headCheckpointId}`).data;
  h.context.chat[1].mes = 'edited user only';
  let state = await h.runtime.refreshStatus();
  assert.equal(state.headCheckpointId, before.headCheckpointId);
  h.context.chat.splice(1, 1);
  state = await h.runtime.refreshStatus();
  const locatorCheckpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${state.headCheckpointId}`).data;
  assert.deepEqual(locatorCheckpoint.floorRange.floorIds, beforeCheckpoint.floorRange.floorIds);
  h.context.chat.splice(1, 2, assistant('B-rewritten'), assistant('C-rewritten'));
  state = await h.runtime.refreshStatus();
  assert.equal(state.lastRun.result, 'trustedPrefix:1');
});

test('malformed Schema、断裂 predecessor、错误 index ref 都阻止 foundation 提交验证', async () => {
  const h = harness();
  await h.runtime.start();
  const root = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-root`).data);
  const checkpoint = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data);
  const run = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-run-${checkpoint.runId}`).data);
  const floors = checkpoint.producedRefs.floors.map(id => structuredClone(h.backend.records.get(`chat-${CHAT}/v3-floor-${id}`).data));
  const indexes = checkpoint.producedRefs.indexes.map(key => structuredClone(h.backend.records.get(`chat-${CHAT}/${key}`).data));
  const valid = { root, checkpoint, run, floors, indexes, indexKeys: checkpoint.producedRefs.indexes };
  assert.equal((await validatePreparedFoundation(valid)).referencesValid, true);
  const malformed = structuredClone(valid);
  malformed.floors[0].schemaVersion = 2;
  await assert.rejects(validatePreparedFoundation(malformed), /V3_FLOOR_INVALID/);
  const broken = structuredClone(valid);
  broken.floors[1].predecessorFloorId = null;
  await assert.rejects(validatePreparedFoundation(broken), /V3_GRAPH_FLOOR_ORDER_INVALID/);
  const wrongRef = structuredClone(valid);
  wrongRef.indexes.find(index => index.kind === 'floorOrder').entries[0].refs[0].recordId = OTHER_CHAT;
  await assert.rejects(validatePreparedFoundation(wrongRef), /V3_GRAPH_INDEX_/);
});

test('FloorRecord 正文与 canonicalFingerprint 必须本地互证，冷读取与 staged 复用同样拒绝损坏', async () => {
  const h = harness();
  await h.runtime.start();
  const root = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-root`).data);
  const checkpoint = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data);
  const run = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-run-${checkpoint.runId}`).data);
  const floors = checkpoint.producedRefs.floors.map(id => structuredClone(h.backend.records.get(`chat-${CHAT}/v3-floor-${id}`).data));
  const indexes = checkpoint.producedRefs.indexes.map(key => structuredClone(h.backend.records.get(`chat-${CHAT}/${key}`).data));
  const base = { root, checkpoint, run, floors, indexes, indexKeys: [...checkpoint.producedRefs.indexes] };

  const canonicalOnly = structuredClone(base);
  canonicalOnly.floors[0].content.canonicalContent = '正文已损坏';
  await assert.rejects(validatePreparedFoundation(canonicalOnly), /V3_GRAPH_FLOOR_CANONICAL_FINGERPRINT_INVALID/);

  const fingerprintOnly = structuredClone(base);
  fingerprintOnly.floors[0].content.canonicalFingerprint = `sha256:${await sha256('伪造指纹')}`;
  await assert.rejects(validatePreparedFoundation(fingerprintOnly), /V3_GRAPH_FLOOR_CANONICAL_FINGERPRINT_INVALID/);

  const contentAndFingerprint = structuredClone(base);
  contentAndFingerprint.floors[0].content.canonicalContent = '正文与指纹一起被改';
  contentAndFingerprint.floors[0].content.canonicalFingerprint = `sha256:${await sha256(contentAndFingerprint.floors[0].content.canonicalContent)}`;
  await assert.rejects(validatePreparedFoundation(contentAndFingerprint), /V3_GRAPH_FINGERPRINT_LIST_INVALID/);

  const activeFloorKey = `chat-${CHAT}/v3-floor-${checkpoint.producedRefs.floors[0]}`;
  h.backend.records.get(activeFloorKey).data.content.canonicalContent = '冷读取损坏正文';
  const coldStore = createFoundationStore({
    client: h.backend.client,
    contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }),
  });
  await assert.rejects(coldStore.readReachable(), /V3_GRAPH_FLOOR_CANONICAL_FINGERPRINT_INVALID/);

  const staged = harness([assistant('A'), assistant('B'), assistant('C'), assistant('D')]);
  staged.backend.setFailPutPrefix('v3-index-');
  assert.equal((await staged.runtime.start()).status, 'error');
  const stagedFloor = [...staged.backend.records.entries()].find(([, envelope]) => envelope.data.recordType === 'floor');
  stagedFloor[1].data.content.canonicalContent = '损坏的 staged 正文';
  staged.backend.setFailPutPrefix(null);
  const stagedStore = createFoundationStore({
    client: staged.backend.client,
    contextProvider: () => ({ hostChatId: staged.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }),
  });
  const stagedRuntime = createFoundationRuntime({
    hostAdapter: createHostAdapter({ globalRef: { SillyTavern: { getContext: () => staged.context } } }),
    store: stagedStore, contextProvider: () => staged.context, newUuid: uuidFactory(13500),
    now: () => new Date('2026-09-02T00:30:00.000Z'), logger: { warn() {} },
  });
  const stagedState = await stagedRuntime.start();
  assert.equal(stagedState.status, 'error');
  assert.match(stagedState.lastError, /V3_GRAPH_FLOOR_CANONICAL_FINGERPRINT_INVALID/);
});

test('active checkpoint 的 committing run 冷启动幂等收敛 completed，非 active run 保持不变', async () => {
  const h = harness();
  await h.runtime.start();
  const firstRoot = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-root`).data);
  const firstCheckpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${firstRoot.headCheckpointId}`).data;
  const firstRunKey = `chat-${CHAT}/v3-run-${firstCheckpoint.runId}`;
  h.backend.records.get(firstRunKey).data.phase = 'committing';

  const coldStore = createFoundationStore({
    client: h.backend.client,
    contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }),
  });
  const coldRuntime = createFoundationRuntime({
    hostAdapter: createHostAdapter({ globalRef: { SillyTavern: { getContext: () => h.context } } }),
    store: coldStore, contextProvider: () => h.context, newUuid: uuidFactory(13700),
    now: () => new Date('2026-09-02T00:45:00.000Z'), logger: { warn() {} },
  });
  const recovered = await coldRuntime.start();
  assert.equal(recovered.status, 'ready');
  assert.equal(h.backend.records.get(`chat-${CHAT}/v3-root`).data.headCheckpointId, firstRoot.headCheckpointId);
  assert.equal(h.backend.records.get(firstRunKey).data.phase, 'completed');
  assert.equal(recovered.lastRun.phase, 'completed');

  h.context.chat.push(assistant('D'));
  await coldRuntime.refreshStatus();
  const secondRoot = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  assert.notEqual(secondRoot.headCheckpointId, firstRoot.headCheckpointId);
  h.backend.records.get(firstRunKey).data.phase = 'committing';
  const latestStore = createFoundationStore({
    client: h.backend.client,
    contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }),
  });
  const latestRuntime = createFoundationRuntime({
    hostAdapter: createHostAdapter({ globalRef: { SillyTavern: { getContext: () => h.context } } }),
    store: latestStore, contextProvider: () => h.context, newUuid: uuidFactory(13800),
    now: () => new Date('2026-09-02T00:50:00.000Z'), logger: { warn() {} },
  });
  assert.equal((await latestRuntime.start()).status, 'ready');
  assert.equal(h.backend.records.get(firstRunKey).data.phase, 'committing');
});

test('root indexManifest 对 checkpoint 三类 foundation index 必须精确覆盖且分栏正确', async () => {
  const h = harness();
  await h.runtime.start();
  const root = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-root`).data);
  const checkpoint = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data);
  const run = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-run-${checkpoint.runId}`).data);
  const floors = checkpoint.producedRefs.floors.map(id => structuredClone(h.backend.records.get(`chat-${CHAT}/v3-floor-${id}`).data));
  const indexes = checkpoint.producedRefs.indexes.map(key => structuredClone(h.backend.records.get(`chat-${CHAT}/${key}`).data));
  const base = { root, checkpoint, run, floors, indexes, indexKeys: [...checkpoint.producedRefs.indexes] };
  const bucketFor = kind => kind === 'reverseRef' ? 'reverseRef' : 'floor';

  for (const kind of ['floorOrder', 'fingerprint', 'reverseRef']) {
    const missing = structuredClone(base);
    const indexPosition = missing.indexes.findIndex(index => index.kind === kind);
    const key = missing.indexKeys[indexPosition];
    const bucket = bucketFor(kind);
    missing.root.indexManifest[bucket] = missing.root.indexManifest[bucket].filter(item => item !== key);
    await assert.rejects(validatePreparedFoundation(missing), /V3_GRAPH_ROOT_INDEX_MANIFEST_INVALID/, `${kind} 缺项必须拒绝`);
  }

  const extra = structuredClone(base);
  extra.root.indexManifest.floor.push('v3-index-floorOrder-0-extra');
  await assert.rejects(validatePreparedFoundation(extra), /V3_GRAPH_ROOT_INDEX_MANIFEST_INVALID/);

  const duplicate = structuredClone(base);
  duplicate.root.indexManifest.floor.push(duplicate.root.indexManifest.floor[0]);
  await assert.rejects(validatePreparedFoundation(duplicate), /V3_GRAPH_ROOT_INDEX_MANIFEST_INVALID/);

  const wrongBucket = structuredClone(base);
  const fingerprintKey = wrongBucket.indexKeys[wrongBucket.indexes.findIndex(index => index.kind === 'fingerprint')];
  wrongBucket.root.indexManifest.floor = wrongBucket.root.indexManifest.floor.filter(key => key !== fingerprintKey);
  wrongBucket.root.indexManifest.reverseRef.push(fingerprintKey);
  await assert.rejects(validatePreparedFoundation(wrongBucket), /V3_GRAPH_ROOT_INDEX_MANIFEST_INVALID/);
});

test('513+ fingerprint/reverseRef entries 自动追加分片且冷恢复可读', async () => {
  const h = harness(Array.from({ length: 513 }, () => assistant('same-content')));
  await h.runtime.start();
  const state = await h.runtime.confirmLatest();
  assert.equal(state.stableCount, 513);
  const root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  const checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  const indexes = checkpoint.producedRefs.indexes.map(key => h.backend.records.get(`chat-${CHAT}/${key}`).data);
  assert.ok(indexes.every(index => index.entryCount <= 512));
  assert.ok(indexes.filter(index => index.kind === 'fingerprint').length >= 3);
  const reverse = indexes.filter(index => index.kind === 'reverseRef');
  assert.ok(reverse.length > 1);
  for (const record of reverse) {
    for (const entry of record.entries) assert.equal(record.shard.split('-')[0], await reverseRefShardPrefix(entry.key));
  }
  for (const floorId of checkpoint.producedRefs.floors) {
    const prefix = await reverseRefShardPrefix(floorId);
    const candidates = await reverseRefCandidateKeys(root.indexManifest, floorId);
    assert.ok(candidates.length >= 1);
    assert.ok(candidates.every(key => key.includes(`-reverseRef-${prefix}-`)));
  }
  const store = createFoundationStore({ client: h.backend.client, contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }) });
  const recovered = await store.readReachable();
  assert.equal(recovered.floors.length, 513);
});

test('A-old/B/C 与 A-new/B/C 交错 CAS 后自动收敛，新快照 run 安全重基', async () => {
  const h = harness([assistant('A-old'), assistant('B'), assistant('C')]);
  const secondStore = createFoundationStore({
    client: h.backend.client,
    contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }),
  });
  const second = createFoundationRuntime({
    hostAdapter: createHostAdapter({ globalRef: { SillyTavern: { getContext: () => h.context } } }),
    store: secondStore, contextProvider: () => h.context, newUuid: uuidFactory(12000),
    now: () => new Date('2026-09-02T00:00:01.000Z'), logger: { warn() {} },
  });
  let rootArrival = 0;
  let signalOld;
  let signalNew;
  let releaseOld;
  let releaseNew;
  const oldAtCas = new Promise(resolve => { signalOld = resolve; });
  const newAtCas = new Promise(resolve => { signalNew = resolve; });
  const holdOld = new Promise(resolve => { releaseOld = resolve; });
  const holdNew = new Promise(resolve => { releaseNew = resolve; });
  h.backend.setBeforePut(async ({ key }) => {
    if (key !== 'v3-root') return;
    rootArrival += 1;
    if (rootArrival === 1) { signalOld(); await holdOld; }
    else if (rootArrival === 2) { signalNew(); await holdNew; }
  });
  const oldPromise = h.runtime.start();
  await oldAtCas;
  h.context.chat[0] = assistant('A-new');
  const newPromise = second.start();
  await newAtCas;
  releaseOld();
  await new Promise(resolve => setImmediate(resolve));
  releaseNew();
  await Promise.all([oldPromise, newPromise]);
  h.backend.setBeforePut(null);
  const reachable = await secondStore.readReachable();
  assert.equal(reachable.status, 'ready');
  assert.equal(reachable.floors[0].content.canonicalContent, 'A-new');
  assert.equal(reachable.root.sourceSnapshotFingerprint, reachable.checkpoint.sourceSnapshotFingerprint);
  const oldFloors = [...h.backend.records.values()].filter(item => item.data.recordType === 'floor' && item.data.content.canonicalContent === 'A-old');
  assert.ok(oldFloors.length > 0);
  const oldRunIds = new Set(oldFloors.map(item => item.data.processing.runId));
  const oldRuns = [...h.backend.records.values()].filter(item => item.data.recordType === 'run' && oldRunIds.has(item.data.id));
  assert.ok(oldRuns.every(item => item.data.phase !== 'completed'), '旧输入 run 不得最终 completed');
});

test('mutation 恰好发生在 CAS 请求在途时自动二次收敛且无未处理拒绝', async () => {
  const h = harness([assistant('A-old'), assistant('B'), assistant('C')]);
  let mutated = false;
  h.backend.setBeforePut(async ({ key }) => {
    if (key !== 'v3-root' || mutated) return;
    mutated = true;
    h.context.chat[0] = assistant('A-new');
  });
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const state = await h.runtime.start();
    assert.equal(state.status, 'ready');
  } finally {
    process.off('unhandledRejection', onUnhandled);
    h.backend.setBeforePut(null);
  }
  const store = createFoundationStore({ client: h.backend.client, contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }) });
  const reachable = await store.readReachable();
  assert.equal(reachable.floors[0].content.canonicalContent, 'A-new');
  assert.deepEqual(unhandled, []);
});

test('索引会重算 contentFingerprint，并拒绝错误 key、ref、id 与 shard 路由', async () => {
  const h = harness();
  await h.runtime.start();
  const root = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-root`).data);
  const checkpoint = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data);
  const run = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-run-${checkpoint.runId}`).data);
  const floors = checkpoint.producedRefs.floors.map(id => structuredClone(h.backend.records.get(`chat-${CHAT}/v3-floor-${id}`).data));
  const indexes = checkpoint.producedRefs.indexes.map(key => structuredClone(h.backend.records.get(`chat-${CHAT}/${key}`).data));
  const base = { checkpoint, run, floors, indexes, indexKeys: [...checkpoint.producedRefs.indexes] };
  const resign = async (graph, indexPosition) => {
    const record = graph.indexes[indexPosition];
    record.contentFingerprint = `sha256:${await sha256(JSON.stringify([record.kind, record.shard, record.entries]))}`;
    record.id = await deterministicUuid(['index', record.sourceCheckpointId, record.kind, record.shard, record.entries]);
    const key = `v3-index-${record.kind}-${record.shard}-${record.id}`;
    graph.indexKeys[indexPosition] = key;
    graph.checkpoint.producedRefs.indexes[indexPosition] = key;
  };

  const fakeFingerprint = structuredClone(base);
  fakeFingerprint.indexes[0].contentFingerprint = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(validatePreparedFoundation(fakeFingerprint), /V3_GRAPH_INDEX_FINGERPRINT_INVALID/);

  const wrongOrderKey = structuredClone(base);
  const orderAt = wrongOrderKey.indexes.findIndex(index => index.kind === 'floorOrder');
  wrongOrderKey.indexes[orderAt].entries[0].key = '99';
  await resign(wrongOrderKey, orderAt);
  await assert.rejects(validatePreparedFoundation(wrongOrderKey), /V3_GRAPH_FLOOR_ORDER_INDEX_INVALID/);

  const wrongFingerprintKey = structuredClone(base);
  const fingerprintAt = wrongFingerprintKey.indexes.findIndex(index => index.kind === 'fingerprint' && index.entries.some(entry => entry.refs.some(ref => ref.itemId === 'canonical')));
  const canonicalEntry = wrongFingerprintKey.indexes[fingerprintAt].entries.find(entry => entry.refs.some(ref => ref.itemId === 'canonical'));
  const canonicalShardPrefix = wrongFingerprintKey.indexes[fingerprintAt].shard.slice(0, 2);
  canonicalEntry.key = `sha256:${canonicalShardPrefix}${'1'.repeat(62)}`;
  await resign(wrongFingerprintKey, fingerprintAt);
  await assert.rejects(validatePreparedFoundation(wrongFingerprintKey), /V3_GRAPH_FINGERPRINT_INDEX_INVALID/);

  const wrongShard = structuredClone(base);
  const reverseAt = wrongShard.indexes.findIndex(index => index.kind === 'reverseRef');
  wrongShard.indexes[reverseAt].shard = 'ff-0';
  await resign(wrongShard, reverseAt);
  await assert.rejects(validatePreparedFoundation(wrongShard), /V3_GRAPH_INDEX_SHARD_INVALID/);

  const wrongId = structuredClone(base);
  wrongId.indexes[0].id = OTHER_CHAT;
  wrongId.indexKeys[0] = `v3-index-${wrongId.indexes[0].kind}-${wrongId.indexes[0].shard}-${OTHER_CHAT}`;
  wrongId.checkpoint.producedRefs.indexes[0] = wrongId.indexKeys[0];
  await assert.rejects(validatePreparedFoundation(wrongId), /V3_GRAPH_INDEX_ROUTE_INVALID/);

  const emptyRefs = structuredClone(base);
  const emptyRefsAt = emptyRefs.indexes.findIndex(index => index.kind === 'fingerprint');
  emptyRefs.indexes[emptyRefsAt].entries[0].refs = [];
  await resign(emptyRefs, emptyRefsAt);
  await assert.rejects(validatePreparedFoundation(emptyRefs), /V3_INDEX_INVALID/);
});

test('reverseRef 同一哈希前缀超过 512 entries 时追加序号且可由目标 ID 确定定位', async () => {
  const ids = [];
  for (let value = 1; ids.length < 513; value += 1) {
    const raw = value.toString(16).padStart(32, '0').split('');
    raw[12] = '4'; raw[16] = '8';
    const id = `${raw.slice(0, 8).join('')}-${raw.slice(8, 12).join('')}-${raw.slice(12, 16).join('')}-${raw.slice(16, 20).join('')}-${raw.slice(20).join('')}`;
    if (createHash('sha256').update(id).digest('hex').startsWith('00')) ids.push(id);
  }
  const fingerprint = `sha256:${'a'.repeat(64)}`;
  const floors = ids.map((id, index) => ({
    id, assistantSeq: index + 1, hostLocator: { messageIndex: index, swipeId: 0, selectedSwipeIndex: 0 },
    content: { rawFingerprint: fingerprint, canonicalFingerprint: fingerprint },
  }));
  const indexes = await buildFoundationIndexes({
    chatId: CHAT, narrativeGeneration: OTHER_CHAT, checkpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    floors, candidates: [], now: '2026-09-02T00:00:00.000Z',
  });
  const reverse = indexes.filter(index => index.kind === 'reverseRef');
  assert.deepEqual(reverse.map(index => [index.shard, index.entryCount]), [['00-0', 512], ['00-1', 1]]);
  for (const id of ids) {
    const prefix = await reverseRefShardPrefix(id);
    assert.ok(reverse.some(index => index.shard.startsWith(`${prefix}-`) && index.entries.some(entry => entry.key === id)));
  }
});

test('部分 FloorRecord 写完后冷启动复用 staged，不重复写相同 FloorRecord', async () => {
  const h = harness([assistant('A'), assistant('B'), assistant('C'), assistant('D')]);
  h.backend.setFailPutPrefix('v3-index-');
  const failed = await h.runtime.start();
  assert.equal(failed.status, 'error');
  const floorPutsBefore = h.backend.calls.filter(call => call[0] === 'put' && call[2].startsWith('v3-floor-')).length;
  assert.equal(floorPutsBefore, 3);
  h.backend.setFailPutPrefix(null);
  const store = createFoundationStore({ client: h.backend.client, contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }) });
  const runtime = createFoundationRuntime({
    hostAdapter: createHostAdapter({ globalRef: { SillyTavern: { getContext: () => h.context } } }),
    store, contextProvider: () => h.context, newUuid: uuidFactory(14000),
    now: () => new Date('2026-09-02T01:00:00.000Z'), logger: { warn() {} },
  });
  const recovered = await runtime.start();
  assert.equal(recovered.status, 'ready');
  const floorPutsAfter = h.backend.calls.filter(call => call[0] === 'put' && call[2].startsWith('v3-floor-')).length;
  assert.equal(floorPutsAfter, floorPutsBefore, '已验证 staged FloorRecord 不应再次 put');
  const reachable = await store.readReachable();
  assert.deepEqual(reachable.floors.map(floor => floor.content.canonicalContent), ['A', 'B', 'C']);
});

test('staged fingerprint index entries 被篡改但保留旧摘要时，冷启动拒绝发布损坏 root', async () => {
  const h = harness([assistant('A'), assistant('B'), assistant('C'), assistant('D')]);
  h.backend.setConflictRoot(true);
  assert.equal((await h.runtime.start()).status, 'conflict');
  const stagedIndex = [...h.backend.records.values()]
    .find(item => item.data.recordType === 'index' && item.data.kind === 'fingerprint');
  assert.ok(stagedIndex);
  const oldFingerprint = stagedIndex.data.contentFingerprint;
  stagedIndex.data.entries[0].key = `sha256:${'f'.repeat(64)}`;
  assert.equal(stagedIndex.data.contentFingerprint, oldFingerprint);
  h.backend.setConflictRoot(false);

  const store = createFoundationStore({
    client: h.backend.client,
    contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }),
  });
  const runtime = createFoundationRuntime({
    hostAdapter: createHostAdapter({ globalRef: { SillyTavern: { getContext: () => h.context } } }),
    store, contextProvider: () => h.context, newUuid: uuidFactory(14100),
    now: () => new Date('2026-09-02T01:10:00.000Z'), logger: { warn() {} },
  });
  const recovered = await runtime.start();
  assert.equal(recovered.status, 'error');
  assert.match(recovered.lastError, /V3 staged 记录内容冲突/);
  assert.equal(h.backend.records.has(`chat-${CHAT}/v3-root`), false);
  assert.equal((await store.readReachable()).status, 'uninitialized');
});

test('staged checkpoint inputFingerprints 被篡改但保留旧状态摘要时，冷启动拒绝假 ready', async () => {
  const h = harness([assistant('A'), assistant('B'), assistant('C'), assistant('D')]);
  h.backend.setConflictRoot(true);
  assert.equal((await h.runtime.start()).status, 'conflict');
  const stagedCheckpoint = [...h.backend.records.values()].find(item => item.data.recordType === 'checkpoint');
  assert.ok(stagedCheckpoint);
  const oldStateFingerprint = stagedCheckpoint.data.validation.stateFingerprint;
  const oldProducedRefs = structuredClone(stagedCheckpoint.data.producedRefs);
  stagedCheckpoint.data.inputFingerprints[0].canonicalFingerprint = `sha256:${'e'.repeat(64)}`;
  assert.equal(stagedCheckpoint.data.validation.stateFingerprint, oldStateFingerprint);
  assert.deepEqual(stagedCheckpoint.data.producedRefs, oldProducedRefs);
  h.backend.setConflictRoot(false);

  const store = createFoundationStore({
    client: h.backend.client,
    contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }),
  });
  const runtime = createFoundationRuntime({
    hostAdapter: createHostAdapter({ globalRef: { SillyTavern: { getContext: () => h.context } } }),
    store, contextProvider: () => h.context, newUuid: uuidFactory(14200),
    now: () => new Date('2026-09-02T01:20:00.000Z'), logger: { warn() {} },
  });
  const recovered = await runtime.start();
  assert.equal(recovered.status, 'error');
  assert.match(recovered.lastError, /V3 staged 记录内容冲突/);
  assert.equal(h.backend.records.has(`chat-${CHAT}/v3-root`), false);
  assert.equal((await store.readReachable()).status, 'uninitialized');
});

test('putRecord 409 只复用完整内容等价记录，相同摘要下的不等价 index 返回 conflict', async () => {
  const h = harness();
  await h.runtime.start();
  const existing = structuredClone([...h.backend.records.values()]
    .find(item => item.data.recordType === 'index' && item.data.kind === 'fingerprint').data);
  const store = createFoundationStore({
    client: h.backend.client,
    contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }),
  });
  assert.equal((await store.putRecord(structuredClone(existing))).status, 'reused');
  const tampered = structuredClone(existing);
  tampered.entries[0].key = `sha256:${'d'.repeat(64)}`;
  assert.equal(tampered.contentFingerprint, existing.contentFingerprint);
  assert.equal((await store.putRecord(tampered)).status, 'conflict');
});

test('root CAS 前重读并校验真实落盘图，写完后被篡改的 index 不得可达', async () => {
  const h = harness();
  let corrupted = false;
  h.backend.setBeforePut(async ({ data }) => {
    if (corrupted || data?.recordType !== 'run' || data.phase !== 'committing') return;
    const persistedIndex = [...h.backend.records.values()]
      .find(item => item.data.recordType === 'index' && item.data.kind === 'fingerprint');
    assert.ok(persistedIndex);
    persistedIndex.data.entries[0].key = `sha256:${'c'.repeat(64)}`;
    corrupted = true;
  });
  const state = await h.runtime.start();
  assert.equal(corrupted, true);
  assert.equal(state.status, 'error');
  assert.match(state.lastError, /V3_GRAPH_INDEX_(ROUTE|FINGERPRINT)_INVALID/);
  assert.equal(h.backend.records.has(`chat-${CHAT}/v3-root`), false);
});

test('runtime 前置校验后、真实 store commitRoot 前篡改 backing index，最终封口仍拒绝发布', async () => {
  const h = harness();
  const baseStore = createFoundationStore({
    client: h.backend.client,
    contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }),
  });
  let corrupted = false;
  const store = Object.freeze({
    ...baseStore,
    async commitRoot(...args) {
      const persistedIndex = [...h.backend.records.values()]
        .find(item => item.data.recordType === 'index' && item.data.kind === 'fingerprint');
      assert.ok(persistedIndex);
      persistedIndex.data.entries[0].key = `sha256:${'b'.repeat(64)}`;
      corrupted = true;
      return baseStore.commitRoot(...args);
    },
  });
  const runtime = createFoundationRuntime({
    hostAdapter: createHostAdapter({ globalRef: { SillyTavern: { getContext: () => h.context } } }),
    store,
    contextProvider: () => h.context,
    newUuid: uuidFactory(14300),
    now: () => new Date('2026-09-02T01:30:00.000Z'),
    logger: { warn() {} },
  });
  const state = await runtime.start();
  assert.equal(corrupted, true);
  assert.equal(state.status, 'error');
  assert.match(state.lastError, /V3_GRAPH_INDEX_(ROUTE|FINGERPRINT)_INVALID/);
  assert.equal(h.backend.records.has(`chat-${CHAT}/v3-root`), false);
  assert.equal((await baseStore.readReachable()).status, 'uninitialized');
});

test('staged 与当前输入 snapshot 不同则绝不复用', async () => {
  const h = harness([assistant('A-old'), assistant('B'), assistant('C')]);
  h.backend.setFailPutPrefix('v3-index-');
  await h.runtime.start();
  const oldFloorIds = new Set([...h.backend.records.values()]
    .filter(item => item.data.recordType === 'floor')
    .map(item => item.data.id));
  h.context.chat[0] = assistant('A-new');
  h.backend.setFailPutPrefix(null);
  const store = createFoundationStore({ client: h.backend.client, contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }) });
  const runtime = createFoundationRuntime({
    hostAdapter: createHostAdapter({ globalRef: { SillyTavern: { getContext: () => h.context } } }),
    store, contextProvider: () => h.context, newUuid: uuidFactory(14500),
    now: () => new Date('2026-09-02T02:00:00.000Z'), logger: { warn() {} },
  });
  assert.equal((await runtime.start()).status, 'ready');
  const reachable = await store.readReachable();
  assert.equal(reachable.floors[0].content.canonicalContent, 'A-new');
  assert.ok(reachable.floors.every(floor => !oldFloorIds.has(floor.id)));
});

test('读取第一轮未发布 V3 记录后原地重封口，不删除旧记录', async () => {
  const h = harness();
  await h.runtime.start();
  const collection = `chat-${CHAT}/`;
  const rootEnvelope = h.backend.records.get(`${collection}v3-root`);
  const checkpointEnvelope = h.backend.records.get(`${collection}v3-checkpoint-${rootEnvelope.data.headCheckpointId}`);
  const runEnvelope = h.backend.records.get(`${collection}v3-run-${checkpointEnvelope.data.runId}`);
  delete rootEnvelope.data.sourceSnapshotFingerprint;
  delete checkpointEnvelope.data.sourceSnapshotFingerprint;
  delete runEnvelope.data.parentCheckpointId;
  delete runEnvelope.data.inputSnapshotFingerprint;
  const reverseKeys = checkpointEnvelope.data.producedRefs.indexes.filter(key => key.includes('-reverseRef-'));
  const reverseRecords = reverseKeys.map(key => h.backend.records.get(`${collection}${key}`).data);
  const entries = reverseRecords.flatMap(record => record.entries);
  const shard = '0';
  const legacyReverse = structuredClone(reverseRecords[0]);
  legacyReverse.shard = shard;
  legacyReverse.entries = entries;
  legacyReverse.entryCount = entries.length;
  legacyReverse.contentFingerprint = `sha256:${await sha256(JSON.stringify(['reverseRef', shard, entries]))}`;
  legacyReverse.id = await deterministicUuid(['index', legacyReverse.sourceCheckpointId, 'reverseRef', shard, entries]);
  const legacyKey = `v3-index-reverseRef-${shard}-${legacyReverse.id}`;
  for (const key of reverseKeys) h.backend.records.delete(`${collection}${key}`);
  h.backend.records.set(`${collection}${legacyKey}`, { revision: 1, createdAt: legacyReverse.createdAt, data: legacyReverse });
  checkpointEnvelope.data.producedRefs.indexes = checkpointEnvelope.data.producedRefs.indexes.filter(key => !reverseKeys.includes(key));
  checkpointEnvelope.data.producedRefs.indexes.push(legacyKey);
  rootEnvelope.data.indexManifest.reverseRef = [legacyKey];

  const store = createFoundationStore({ client: h.backend.client, contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }) });
  assert.equal((await store.readReachable()).status, 'ready');
  const runtime = createFoundationRuntime({
    hostAdapter: createHostAdapter({ globalRef: { SillyTavern: { getContext: () => h.context } } }),
    store, contextProvider: () => h.context, newUuid: uuidFactory(14800),
    now: () => new Date('2026-09-02T03:00:00.000Z'), logger: { warn() {} },
  });
  assert.equal((await runtime.start()).status, 'ready');
  const upgraded = await store.readReachable();
  assert.match(upgraded.root.sourceSnapshotFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.ok(h.backend.records.has(`${collection}${legacyKey}`), '旧索引只变为不可达，不应被删除');
});

test('legacy root manifest 缺项只进入 needsReseal，重封口后恢复精确覆盖', async () => {
  const h = harness();
  await h.runtime.start();
  const collection = `chat-${CHAT}/`;
  const rootEnvelope = h.backend.records.get(`${collection}v3-root`);
  const checkpointEnvelope = h.backend.records.get(`${collection}v3-checkpoint-${rootEnvelope.data.headCheckpointId}`);
  const runEnvelope = h.backend.records.get(`${collection}v3-run-${checkpointEnvelope.data.runId}`);
  delete rootEnvelope.data.sourceSnapshotFingerprint;
  delete checkpointEnvelope.data.sourceSnapshotFingerprint;
  delete runEnvelope.data.inputSnapshotFingerprint;
  rootEnvelope.data.indexManifest.floor.pop();

  const store = createFoundationStore({
    client: h.backend.client,
    contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }),
  });
  assert.equal((await store.readReachable()).status, 'needsReseal');
  const runtime = createFoundationRuntime({
    hostAdapter: createHostAdapter({ globalRef: { SillyTavern: { getContext: () => h.context } } }),
    store, contextProvider: () => h.context, newUuid: uuidFactory(14900),
    now: () => new Date('2026-09-02T03:30:00.000Z'), logger: { warn() {} },
  });
  assert.equal((await runtime.start()).status, 'ready');
  const upgraded = await store.readReachable();
  assert.equal(upgraded.status, 'ready');
  const expectedFloorKeys = upgraded.checkpoint.producedRefs.indexes.filter(key => key.includes('-floorOrder-') || key.includes('-fingerprint-'));
  assert.deepEqual(new Set(upgraded.root.indexManifest.floor), new Set(expectedFloorKeys));
});

test('真实 V2 session + lifecycle + V3 runtime 在 CHAT_CHANGED UUID 时序下只建立一份身份', async () => {
  const context = hostContext([assistant('A'), assistant('B')]);
  delete context.chatMetadata.qianqianjie;
  const handlers = new Map();
  context.eventTypes = Object.fromEntries(EVENT_NAMES.map(name => [name, name]));
  context.eventTypes.PERSONA_CHANGED = 'PERSONA_CHANGED';
  context.eventSource = { on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); } };
  const backend = backendHarness();
  let ensureCalls = 0;
  const session = createArchiveV2Session({
    contextProvider: () => context,
    ensureChatId: async raw => {
      ensureCalls += 1;
      await new Promise(resolve => setImmediate(resolve));
      raw.chatMetadata.qianqianjie = { schemaVersion: 1, chatId: CHAT };
      return CHAT;
    },
  });
  const lifecycle = createArchiveV2Lifecycle({ session, getUi: () => null, logger: { warn() {} } });
  const store = createFoundationStore({ client: backend.client, contextProvider: () => session.identity() });
  const runtime = createFoundationRuntime({
    hostAdapter: createHostAdapter({ globalRef: { SillyTavern: { getContext: () => context } } }),
    store, contextProvider: () => context, prepareSession: () => session.prepare(),
    newUuid: uuidFactory(15000), now: () => new Date('2026-09-02T00:00:00.000Z'), logger: { warn() {} },
  });
  lifecycle.bind({ eventSource: context.eventSource, eventTypes: context.eventTypes });
  runtime.bind({ eventSource: context.eventSource, eventTypes: context.eventTypes });
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    for (const handler of handlers.get('CHAT_CHANGED')) handler();
    await new Promise(resolve => setTimeout(resolve, 60));
  } finally { process.off('unhandledRejection', onUnhandled); }
  assert.equal(ensureCalls, 1);
  assert.equal(session.identity().chatId, CHAT);
  assert.equal(runtime.getState().status, 'ready');
  assert.deepEqual(unhandled, []);
});

const EVENT_NAMES = ['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MORE_MESSAGES_LOADED'];
