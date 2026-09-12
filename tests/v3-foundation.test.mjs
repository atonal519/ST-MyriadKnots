import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHostAdapter } from '../src/v3/host-adapter.js';
import { createFoundationStore, reverseRefCandidateKeys } from '../src/v3/foundation-store.js';
import { buildFoundationIndexes, createFoundationRuntime, validatePreparedFoundation } from '../src/v3/foundation-runtime.js';
import { deterministicUuid, foundationInputSnapshot, reverseRefShardPrefix, scanAssistantCandidates } from '../src/v3/foundation-domain.js';
import { sha256 } from '../src/identity.js';
import { entityIndexKey } from '../src/v3/memory-schema.js';
import { createChatSession } from '../src/chat-session.js';
import { createPluginLifecycle } from '../src/plugin-lifecycle.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_CHAT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const assistant = (mes, extra = {}) => ({ is_user: false, is_system: false, mes, swipes: [mes], swipe_id: 0, extra, ...extra });
const hiddenAssistant = mes => ({ ...assistant(mes), is_system: true, extra: {} });
const user = mes => ({ is_user: true, is_system: false, mes, send_date: `test-user:${mes}` });
const system = (mes, type = 'generic') => ({ is_user: false, is_system: true, mes, extra: { type } });
const legacyScanner = async (chat, options) => {
  const candidates = await scanAssistantCandidates(chat, options);
  return Object.freeze(candidates.map((candidate, index) => index < candidates.length - 1 || candidate.stabilityProof
    ? Object.freeze({ ...candidate, stabilityProof: Object.freeze({ kind: 'nextUser', messageIndex: candidate.hostLocator.messageIndex + 1, fingerprint: `sha256:${createHash('sha256').update(`legacy-test-${index}`).digest('hex')}` }) })
    : candidate));
};
const uuidFactory = (start = 0) => {
  let value = start;
  return () => `${(++value).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
};

function waitForRuntimeStatus(runtime, expected, message) {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`${message}: ${runtime.getState().status}`));
    }, 5000);
    const finish = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    unsubscribe = runtime.subscribe(state => { if (state.status === expected) finish(); });
    if (runtime.getState().status === expected) finish();
  });
}

function hostContext(chat = [assistant('A'), assistant('B'), assistant('C')], chatUuid = CHAT) {
  return {
    characterId: 0,
    groupId: null,
    chatId: `host-${chatUuid}`,
    characters: [{ avatar: 'character.png' }],
    userAvatar: 'persona.png',
    chatMetadata: { integrity: 'complete', qianqianjie: { schemaVersion: 1, chatId: chatUuid } },
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
  let beforeGet = null;
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
    setBeforeGet(value) { beforeGet = value; },
    client: {
      async get(collection, key) {
        calls.push(['get', collection, key]);
        if (beforeGet) await beforeGet({ collection, key });
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

async function buildLegacyIndexFixture({ chatId, narrativeGeneration, checkpointId, floors, candidates = [], entities = [], now = '2026-09-02T00:00:00.000Z' }) {
  const records = [];
  const add = async (kind, shard, entries) => {
    if (!entries.length) return;
    const id = await deterministicUuid(['index', checkpointId, kind, shard, entries]);
    records.push({
      schemaVersion: 3, recordType: 'index', id, chatId, narrativeGeneration, kind, shard,
      sourceCheckpointId: checkpointId, entries, entryCount: entries.length,
      contentFingerprint: `sha256:${await sha256(JSON.stringify([kind, shard, entries]))}`,
      createdAt: now, updatedAt: now, recordStatus: 'staged', supersedes: null,
    });
  };
  const chunks = (values, size = 512) => Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
  for (let offset = 0; offset < floors.length; offset += 128) {
    await add('floorOrder', String(Math.floor(offset / 128)), floors.slice(offset, offset + 128).map((floor, index) => ({
      key: String(offset + index + 1),
      refs: [{ recordType: 'floor', recordId: floor.id, itemId: JSON.stringify(candidates[offset + index]?.hostLocator ?? floor.hostLocator) }],
    })));
  }
  const fingerprints = new Map();
  for (const floor of floors) {
    for (const [value, itemId] of [[floor.content.rawFingerprint, 'raw'], [floor.content.canonicalFingerprint, 'canonical']]) {
      const prefix = value.slice('sha256:'.length, 'sha256:'.length + 2);
      const entries = fingerprints.get(prefix) ?? [];
      entries.push({ key: value, refs: [{ recordType: 'floor', recordId: floor.id, itemId }] });
      fingerprints.set(prefix, entries);
    }
  }
  for (const [prefix, entries] of fingerprints) {
    for (const [index, shard] of chunks(entries).entries()) await add('fingerprint', `${prefix}-${index}`, shard);
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
    for (const [index, shard] of chunks(entries).entries()) await add('entity', `${prefix}-${index}`, shard);
  }
  const reverseRefs = new Map();
  for (const floor of floors) {
    const prefix = await reverseRefShardPrefix(floor.id);
    const entries = reverseRefs.get(prefix) ?? [];
    entries.push({ key: floor.id, refs: [{ recordType: 'checkpoint', recordId: checkpointId, itemId: null }] });
    reverseRefs.set(prefix, entries);
  }
  for (const [prefix, entries] of reverseRefs) {
    for (const [index, shard] of chunks(entries).entries()) await add('reverseRef', `${prefix}-${index}`, shard);
  }
  return records;
}

async function installLegacyIndexFixture(h) {
  const collection = `chat-${CHAT}/`;
  const rootEnvelope = h.backend.records.get(`${collection}v3-root`);
  const checkpointEnvelope = h.backend.records.get(`${collection}v3-checkpoint-${rootEnvelope.data.headCheckpointId}`);
  const floors = checkpointEnvelope.data.producedRefs.floors.map(id => h.backend.records.get(`${collection}v3-floor-${id}`).data);
  const indexes = await buildLegacyIndexFixture({
    chatId: rootEnvelope.data.chatId,
    narrativeGeneration: rootEnvelope.data.narrativeGeneration,
    checkpointId: checkpointEnvelope.data.id,
    floors,
  });
  const keys = indexes.map(index => `v3-index-${index.kind}-${index.shard}-${index.id}`);
  for (let index = 0; index < indexes.length; index += 1) {
    h.backend.records.set(`${collection}${keys[index]}`, { revision: 1, createdAt: indexes[index].createdAt, data: indexes[index] });
  }
  delete checkpointEnvelope.data.indexLayout;
  checkpointEnvelope.data.producedRefs.indexes = keys;
  rootEnvelope.data.indexManifest = {
    floor: keys.filter(key => key.includes('-floorOrder-') || key.includes('-fingerprint-')),
    entity: [], event: [], claim: [], knowledge: [], episode: [], thread: [], state: [], anchor: [],
    reverseRef: keys.filter(key => key.includes('-reverseRef-')),
  };
  return { rootEnvelope, checkpointEnvelope, indexes, keys };
}

function harness(chat = [assistant('A'), assistant('B'), assistant('C')], { enhanced = false, prepareSession = null, modernAnchors = false } = {}) {
  let context = hostContext(chat);
  let enabled = true;
  const handlers = new Map();
  context.eventTypes = Object.fromEntries(['CHAT_CHANGED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MORE_MESSAGES_LOADED', 'MESSAGE_UPDATED'].map(name => [name, name]));
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
    scanCandidates: modernAnchors ? scanAssistantCandidates : legacyScanner,
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

async function anchorLatest(h, label = 'legacy test anchor') {
  h.context.chat.push(user(label));
  return h.runtime.refreshStatus();
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

test('纯扫描只枚举有效 AI 楼；无 user 锚时确认入口也不能越过 pending', async () => {
  const chat = [user('不要保存'), assistant('<content>A</content>'), system('系统'), assistant('B'), user('继续'), assistant('C')];
  const candidates = await scanAssistantCandidates(chat);
  assert.deepEqual(candidates.map(item => [item.assistantSeq, item.hostLocator.messageIndex, item.canonicalContent]), [[1, 1, 'A'], [2, 3, 'B'], [3, 5, 'C']]);
  assert.ok(candidates.every(item => /^sha256:[0-9a-f]{64}$/.test(item.rawFingerprint)));
  const h = harness(chat);
  let state = await h.runtime.start();
  assert.equal(state.stableCount, 2);
  assert.equal(state.pending.assistantSeq, 3);
  state = await h.runtime.confirmLatest();
  assert.equal(state.stableCount, 2);
  assert.equal(state.pending.assistantSeq, 3);
  assert.equal(state.foundationStatus, 'ready');
  assert.deepEqual(state.stableBoundary.assistantSeq, 2);
});

test('新楼首正文边界只晋升启动前 pending，空占位不落 Floor 且后续刷新保持稳定', async () => {
  const h = harness([assistant('上一楼正文')]);
  let state = await h.runtime.start();
  const boundary = structuredClone(state.pending);
  assert.equal(state.stableCount, 0);

  h.context.chat.push(user('继续'), assistant(''));
  state = await h.runtime.stabilizeThrough(boundary);
  assert.equal(state.stableCount, 1);
  assert.equal(state.pending, null);
  assert.equal(h.runtime.getReachable().floors[0].content.canonicalContent, '上一楼正文');
  assert.equal(h.runtime.getReachable().floors.some(floor => floor.hostLocator.messageIndex === 2), false, '空占位不得成为 FloorRecord');

  state = await h.runtime.refreshStatus();
  assert.equal(state.stableCount, 1, '同一生成期间普通 refresh 不得把提前稳定楼退回 pending');
  h.context.chat[2] = assistant('当前楼首段');
  state = await h.runtime.refreshStatus();
  assert.equal(state.stableCount, 1);
  assert.equal(state.pending.assistantSeq, 2);
  assert.equal(state.pending.messageIndex, 2);
});

test('提前边界是精确上限，首 token 后即使出现多个后继 assistant 也只封启动前旧楼', async () => {
  const h = harness([assistant('启动前旧楼')]);
  const boundary = structuredClone((await h.runtime.start()).pending);
  h.context.chat.push(user('继续'), assistant('工具中间楼'), assistant('递归当前楼'));
  const state = await h.runtime.stabilizeThrough(boundary);
  assert.equal(state.stableCount, 1);
  assert.deepEqual(h.runtime.getReachable().floors.map(floor => floor.content.canonicalContent), ['启动前旧楼']);
  assert.equal(state.pending.assistantSeq, 2);
  assert.equal(state.pending.messageIndex, 2);
});

test('提前边界正文指纹或位置失配时 stale 且零 root 提交', async () => {
  for (const mutation of ['canonical', 'locator']) {
    const h = harness([assistant('启动前旧楼')]);
    const boundary = structuredClone((await h.runtime.start()).pending);
    if (mutation === 'canonical') h.context.chat[0] = assistant('已变化的旧楼');
    else h.context.chat.unshift(user('插入导致位置变化'));
    h.context.chat.push(user('继续'), assistant(''));
    h.backend.calls.splice(0);
    const state = await h.runtime.stabilizeThrough(boundary);
    assert.equal(state.status, 'stale', mutation);
    assert.equal(h.backend.calls.some(call => call[0] === 'put' && call[2] === 'v3-root'), false, `${mutation} 失配不得提交 root`);
    assert.equal(h.runtime.getReachable()?.floors?.length ?? 0, 0);
  }
});

test('已有 reconcile 占用时排队的提前边界不会丢失，释放后精确封存旧 pending', async () => {
  let hold = false, release, markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const h = harness([assistant('已稳定楼'), assistant('启动前 pending')], {
    prepareSession: async () => {
      if (!hold) return;
      hold = false;
      markStarted();
      await new Promise(resolve => { release = resolve; });
    },
  });
  const initial = await h.runtime.start();
  const boundary = structuredClone(initial.pending);
  hold = true;
  const refresh = h.runtime.refreshStatus();
  await started;
  h.context.chat.push(user('继续'), assistant(''));
  const queued = h.runtime.stabilizeThrough(boundary);
  release();
  await refresh;
  await queued;
  for (let attempt = 0; attempt < 100 && h.runtime.getState().stableCount !== 2; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(h.runtime.getState().stableCount, 2);
  assert.deepEqual(h.runtime.getReachable().floors.map(floor => floor.content.canonicalContent), ['已稳定楼', '启动前 pending']);
  assert.equal(h.runtime.getReachable().floors.some(floor => floor.hostLocator.messageIndex === 3), false);
});

test('V3 真实 AI 判定排除各种 narrator，保留隐藏 AI、comment 与未知扩展 type', async () => {
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
    { ...assistant('narrator empty system', { type: 'narrator' }), is_system: '' },
    assistant('narrator false system', { type: 'narrator' }),
    { is_user: false, mes: 'narrator missing system', extra: { type: 'narrator' } },
    assistant('comment AI', { type: 'comment' }),
    assistant('unknown extension AI', { type: 'extension-output' }),
  ];
  const candidates = await scanAssistantCandidates(chat);
  assert.deepEqual(candidates.map(item => [item.assistantSeq, item.hostLocator.messageIndex, item.canonicalContent]), [
    [1, 0, '普通 AI'],
    [2, 1, '/hide AI'],
    [3, 2, 'is_hidden AI'],
    [4, 3, 'extra.is_hidden AI'],
    [5, 12, 'comment AI'],
    [6, 13, 'unknown extension AI'],
  ]);
  const anchors = await scanAssistantCandidates([
    assistant('未被旁白确认的 AI'),
    { is_user: true, is_system: '', mes: '伪装 user 的旁白', extra: { type: 'narrator' } },
    assistant('正常 AI'),
    user('正常 user 锚'),
  ]);
  assert.deepEqual(anchors.map(item => item.stabilityProof?.messageIndex ?? null), [null, 3], 'narrator 也不能伪装 user 稳定锚');
});

test('生产 scanner 与 foundation runtime 跳过空/假 system narrator，并随真实 user 增删稳定 AI', async () => {
  for (const narrator of [
    { is_user: false, is_system: '', mes: '空 system 旁白', extra: { type: 'narrator' } },
    { is_user: false, is_system: false, mes: 'false system 旁白', extra: { type: 'narrator' } },
    { is_user: false, mes: '缺 system 旁白', extra: { type: 'narrator' } },
  ]) {
    const candidates = await scanAssistantCandidates([narrator, assistant('真实 AI'), user('稳定锚')]);
    assert.deepEqual(candidates.map(item => [item.assistantSeq, item.hostLocator.messageIndex, item.stabilityProof?.messageIndex]), [[1, 1, 2]]);
  }

  const narrator = { is_user: false, is_system: '', mes: '宿主旁白', extra: { type: 'narrator' } };
  const stable = harness([narrator, assistant('真实 AI'), user('稳定锚')], { modernAnchors: true });
  let state = await stable.runtime.start();
  assert.equal(state.stableCount, 1);
  assert.deepEqual(stable.runtime.getReachable().floors.map(item => item.hostLocator.messageIndex), [1]);
  stable.context.chat.pop();
  state = await stable.runtime.refreshStatus();
  assert.equal(state.stableCount, 0, '删除真实 user 后 AI 必须重新等待');
  assert.equal(state.pending?.messageIndex, 1);

  const waiting = harness([narrator, assistant('仍未确认的 AI')], { modernAnchors: true });
  state = await waiting.runtime.start();
  assert.equal(state.stableCount, 0);
  assert.equal(state.pending?.messageIndex, 1, 'narrator 后的 AI 无 user 时仍保持 pending');
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
  state = await anchorLatest(hiddenPending);
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
  await anchorLatest(h);
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

test('pending swipe 只换候选；未摘要 stable swipe 在原世代替换本楼', async () => {
  const h = harness([assistant('A'), assistant('B'), assistant('C')], { enhanced: true });
  let state = await h.runtime.start();
  const rootKey = `chat-${CHAT}/v3-root`;
  const rootBeforePending = structuredClone(h.backend.records.get(rootKey));
  const generation = rootBeforePending.data.narrativeGeneration;
  const pendingFingerprint = state.pending.canonicalFingerprint;
  h.backend.calls.splice(0);
  h.context.chat[2] = assistant('C2');
  state = await h.runtime.refreshStatus();
  assert.equal(state.stableCount, 2);
  assert.notEqual(state.pending.canonicalFingerprint, pendingFingerprint);
  assert.deepEqual(h.backend.records.get(rootKey), rootBeforePending, 'pending-only 变化不得推进 root revision/head');
  assert.equal(h.backend.calls.some(call => call[0] === 'put'), false, 'pending-only 变化不得写正式图');
  h.context.chat[1] = assistant('B2');
  state = await h.runtime.refreshStatus();
  const nextRoot = h.backend.records.get(rootKey).data;
  assert.equal(nextRoot.narrativeGeneration, generation);
  assert.equal(state.lastRun.result, 'committed');
  assert.equal(state.stableCount, 2);
});

test('稳定前缀指纹不受尾楼 pending 暂时消失影响，稳定正文变化仍会换指纹', async () => {
  const withPending = await scanAssistantCandidates([assistant('A'), assistant('B'), assistant('尾楼')]);
  const pendingSnapshot = await foundationInputSnapshot(withPending, 2);
  const emptyTailSnapshot = await foundationInputSnapshot(withPending.slice(0, 2), 2);
  assert.equal(pendingSnapshot.payload.latestStatus, 'pending');
  assert.equal(emptyTailSnapshot.payload.latestStatus, 'confirmed');
  assert.equal(emptyTailSnapshot.fingerprint, pendingSnapshot.fingerprint, '瞬时 pending 投影不得进入稳定前缀持久指纹');

  const changedPrefix = await scanAssistantCandidates([assistant('A'), assistant('B 已修改')]);
  const changedSnapshot = await foundationInputSnapshot(changedPrefix, 2);
  assert.notEqual(changedSnapshot.fingerprint, pendingSnapshot.fingerprint, '稳定前缀正文变化必须继续换指纹');
});

test('旧全候选 snapshot 首次刷新只对齐一次，后续 pending-only 变化保持 root 不动', async () => {
  const h = harness([assistant('A'), assistant('B'), assistant('C')]);
  await h.runtime.start();
  const candidates = await scanAssistantCandidates(h.context.chat);
  const legacyPayload = {
    version: 1,
    stableCount: 2,
    latestStatus: 'pending',
    floors: candidates.map(candidate => ({
      assistantSeq: candidate.assistantSeq,
      rawFingerprint: candidate.rawFingerprint,
      canonicalFingerprint: candidate.canonicalFingerprint,
      sanitizerFingerprint: candidate.sanitizerFingerprint,
      messageIndex: candidate.hostLocator.messageIndex,
      swipeId: candidate.hostLocator.swipeId,
      selectedSwipeIndex: candidate.hostLocator.selectedSwipeIndex,
    })),
  };
  const legacyFingerprint = `sha256:${createHash('sha256').update(JSON.stringify(legacyPayload)).digest('hex')}`;
  const rootKey = `chat-${CHAT}/v3-root`;
  const rootRecord = h.backend.records.get(rootKey);
  const checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${rootRecord.data.headCheckpointId}`);
  const run = h.backend.records.get(`chat-${CHAT}/v3-run-${checkpoint.data.runId}`);
  assert.notEqual(rootRecord.data.sourceSnapshotFingerprint, legacyFingerprint);
  rootRecord.data.sourceSnapshotFingerprint = legacyFingerprint;
  checkpoint.data.sourceSnapshotFingerprint = legacyFingerprint;
  run.data.inputSnapshotFingerprint = legacyFingerprint;
  const cached = structuredClone(h.runtime.getReachable());
  cached.root.sourceSnapshotFingerprint = legacyFingerprint;
  cached.checkpoint.sourceSnapshotFingerprint = legacyFingerprint;
  cached.run.inputSnapshotFingerprint = legacyFingerprint;
  assert.equal(h.runtime.adoptReachable(cached), true);

  const revisionBeforeAlignment = rootRecord.revision;
  await h.runtime.refreshStatus();
  const aligned = structuredClone(h.backend.records.get(rootKey));
  assert.equal(aligned.revision, revisionBeforeAlignment + 1);
  assert.notEqual(aligned.data.sourceSnapshotFingerprint, legacyFingerprint);

  h.backend.calls.splice(0);
  h.context.chat[2] = assistant('C2');
  const state = await h.runtime.refreshStatus();
  assert.equal(state.pending.assistantSeq, 3);
  assert.deepEqual(h.backend.records.get(rootKey), aligned);
  assert.equal(h.backend.calls.some(call => call[0] === 'put'), false);
});

test('成功 fresh read 与 adopt 清除旧读取错误，失败 adopt 不洗绿', async () => {
  const h = harness();
  await h.runtime.start();
  const verified = structuredClone(h.runtime.getReachable());
  h.backend.setBeforeGet(({ key }) => {
    if (key === 'v3-root') throw new Error('projection failed');
  });
  let state = await h.runtime.inspect('failedProjection', { allowCached: false });
  assert.equal(state.status, 'error');
  assert.equal(state.lastError, 'projection failed');

  h.backend.setBeforeGet(null);
  state = await h.runtime.inspect('cacheOnly', { allowCached: true });
  assert.equal(state.status, 'ready', '存在旧读取错误时必须跳过缓存快路并执行新鲜读取');
  assert.equal(state.lastError, null);
  h.backend.setBeforeGet(({ key }) => { if (key === 'v3-root') throw new Error('projection failed again'); });
  state = await h.runtime.inspect('failedAgain', { allowCached: false });
  assert.equal(state.status, 'error');
  assert.equal(h.runtime.adoptReachable({ ...verified, root: { ...verified.root, chatId: OTHER_CHAT } }), false);
  assert.equal(h.runtime.getState().lastError, 'projection failed again', '失败 adopt 不能清除读取错误');

  assert.equal(h.runtime.adoptReachable(verified), true);
  assert.equal(h.runtime.getState().status, 'ready');
  assert.equal(h.runtime.getState().lastError, null, '成功接纳已验证的新图后旧读取错误应清除');
  state = await h.runtime.inspect('cacheAfterAdopt', { allowCached: true });
  assert.equal(state.status, 'ready');
  assert.equal(state.lastError, null);
});

test('canonical 相同的未摘要稳定编辑保留楼；标点级变化只替换本楼', async () => {
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
  assert.equal(state.lastRun.mode, 'incremental');
  assert.equal(state.lastRun.result, 'committed');
  assert.equal(h.backend.records.get(`chat-${CHAT}/v3-root`).data.narrativeGeneration, generation);
});

test('删除未摘要早期 AI 后两种宿主均按现存楼提交', async () => {
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
  assert.deepEqual(outcomes, [[2, 'committed'], [2, 'committed']]);
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
  await anchorLatest(h);
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
  const successState = await success.runtime.start();
  assert.equal(successState.activeRun, null, '成功返回值必须已经清除公开运行标记');
  assert.equal(success.runtime.getState().activeRun, null, '成功后的公开状态不能残留运行标记');
  assert.deepEqual(success.backend.runPhases.slice(0, 5), ['capturing', 'validating', 'sealing', 'committing', 'completed']);
  const root = success.backend.records.get(`chat-${CHAT}/v3-root`).data;
  const checkpoint = success.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  const persistedRun = success.backend.records.get(`chat-${CHAT}/v3-run-${checkpoint.runId}`).data;
  assert.equal(persistedRun.phase, 'completed');
  assert.equal(success.runtime.getState().lastRun.phase, persistedRun.phase);

  const failed = harness();
  failed.backend.setFailPutPrefix('v3-floor-');
  const failedState = await failed.runtime.start();
  assert.equal(failedState.activeRun, null, '失败返回值必须已经清除公开运行标记');
  assert.equal(failed.runtime.getState().activeRun, null, '失败后的公开状态不能残留运行标记');
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

test('地基 prepared 写入最多四路并发，全部完成后才写 checkpoint', async () => {
  const h = harness(Array.from({ length: 6 }, (_, index) => assistant(`并发-${index}`)));
  let active = 0;
  let maximum = 0;
  let started = 0;
  let release;
  let fourStarted;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { fourStarted = resolve; });
  h.backend.setBeforePut(async ({ key }) => {
    if (key === 'v3-root' || key.startsWith('v3-run-') || key.startsWith('v3-checkpoint-')) return;
    started += 1;
    active += 1;
    maximum = Math.max(maximum, active);
    if (started === 4) fourStarted();
    await gate;
    active -= 1;
  });
  const pending = h.runtime.start();
  await ready;
  assert.equal(maximum, 4);
  assert.equal(h.backend.calls.some(call => call[0] === 'put' && call[2].startsWith('v3-checkpoint-')), false);
  release();
  const state = await pending;
  assert.equal(state.status, 'ready');
  assert.equal(active, 0);
});

test('prepared 写失败会等待在途任务收拢，不续排新任务或提交 checkpoint/root', async () => {
  const h = harness(Array.from({ length: 6 }, (_, index) => assistant(`失败收拢-${index}`)));
  let started = 0;
  let completed = 0;
  let failFirst;
  let releaseOthers;
  let fourStarted;
  const failGate = new Promise(resolve => { failFirst = resolve; });
  const otherGate = new Promise(resolve => { releaseOthers = resolve; });
  const ready = new Promise(resolve => { fourStarted = resolve; });
  h.backend.setBeforePut(async ({ key }) => {
    if (key === 'v3-root' || key.startsWith('v3-run-') || key.startsWith('v3-checkpoint-')) return;
    started += 1;
    const position = started;
    if (started === 4) fourStarted();
    if (position === 1) {
      await failGate;
      throw Object.assign(new Error('prepared failed'), { status: 503 });
    }
    await otherGate;
    completed += 1;
  });
  let settled = false;
  const pending = h.runtime.start().finally(() => { settled = true; });
  await ready;
  failFirst();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, '首个失败后仍须等待其他在途写入结束');
  assert.equal(started, 4, '失败后不得继续领取新 prepared 记录');
  releaseOthers();
  const state = await pending;
  assert.equal(state.status, 'error');
  assert.equal(completed, 3);
  assert.equal(started, 4);
  assert.equal(h.backend.calls.some(call => call[0] === 'put' && call[2].startsWith('v3-checkpoint-')), false);
  assert.equal(h.backend.calls.some(call => call[0] === 'put' && call[2] === 'v3-root'), false);
});

test('首次封口只由 store 做一次真实全图回读', async () => {
  const h = harness();
  await h.runtime.start();
  const root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  const checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  const reads = h.backend.calls.filter(call => call[0] === 'get').length;
  const committedIndexCount = Object.values(root.indexManifest).flat().length;
  assert.equal(reads, 4 + checkpoint.producedRefs.floors.length + committedIndexCount,
    '仅保留初始 root、staged run 探测，以及 commitRoot 的 checkpoint/run/floors/indexes 真回读');
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
  const secondRuntime = createFoundationRuntime({ hostAdapter: createHostAdapter({ globalRef: { SillyTavern: { getContext: () => h.context } } }), store: secondStore, contextProvider: () => h.context, scanCandidates: legacyScanner, newUuid: uuidFactory(), now: () => new Date('2026-09-02T00:00:00.000Z'), logger: { warn() {} } });
  const recovered = await secondRuntime.start();
  assert.deepEqual(recovered.stableBoundary, first.stableBoundary);
  const coldReads = h.backend.calls.filter(call => call[0] === 'get').length - readsBefore;
  const activeRoot = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  const activeCheckpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${activeRoot.headCheckpointId}`).data;
  const runtimeIndexCount = activeCheckpoint.producedRefs.indexes.filter(key => key.startsWith('v3-index-floorOrder-') || key.startsWith('v3-index-fingerprint-')).length;
  assert.equal(coldReads, 3 + activeCheckpoint.producedRefs.floors.length + runtimeIndexCount,
    'get-only 后端冷恢复只读取 root + checkpoint + run + N floors + 运行时所需索引');
  assert.equal(activeCheckpoint.indexLayout, 'floorOrder-v1');
  assert.equal(runtimeIndexCount, activeCheckpoint.producedRefs.indexes.length, '新布局只有运行时真正使用的楼序索引');
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
  const runtime = createFoundationRuntime({ hostAdapter: createHostAdapter({ globalRef: { SillyTavern: { getContext: () => h.context } } }), store, contextProvider: () => h.context, scanCandidates: legacyScanner, newUuid: uuidFactory(10000), now: () => new Date('2026-09-02T00:00:00.000Z'), logger: { warn() {} } });
  const state = await runtime.start();
  assert.equal(state.status, 'ready');
  assert.equal(state.stableCount, 2);
  assert.notEqual(state.headCheckpointId, root.headCheckpointId);
});

test('新布局各读模式只读楼序索引，并将其视为完整索引集', async () => {
  const h = harness();
  await h.runtime.start();
  const store = createFoundationStore({
    client: h.backend.client,
    contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }),
  });
  h.backend.calls.splice(0);
  const projected = await store.readReachable({ mode: 'projection' });
  assert.equal(projected.status, 'ready');
  assert.equal(projected.indexesComplete, true);
  const projectionIndexGets = h.backend.calls.filter(call => call[0] === 'get' && call[2].startsWith('v3-index-')).map(call => call[2]);
  assert.ok(projectionIndexGets.length > 0);
  assert.ok(projectionIndexGets.every(key => key.startsWith('v3-index-floorOrder-')));

  h.backend.calls.splice(0);
  const runtime = await store.readReachable({ mode: 'runtime' });
  const runtimeIndexGets = h.backend.calls.filter(call => call[0] === 'get' && call[2].startsWith('v3-index-')).map(call => call[2]);
  assert.ok(runtimeIndexGets.length > 0);
  assert.ok(runtimeIndexGets.every(key => key.startsWith('v3-index-floorOrder-') || key.startsWith('v3-index-fingerprint-')));
  assert.equal(runtime.indexesComplete, true);

  h.backend.calls.splice(0);
  const full = await store.readReachable();
  assert.equal(full.indexesComplete, true);
  assert.equal(h.backend.calls.filter(call => call[0] === 'get' && call[2].startsWith('v3-index-')).length, full.checkpoint.producedRefs.indexes.length);
});

test('53 楼/15 实体同形输入在内存 backend 实测新旧索引 PUT，并对照 53 楼完整冷读 GET', async () => {
  const h = harness(Array.from({ length: 53 }, (_, index) => assistant(`统计楼-${index + 1}`)));
  await h.runtime.start();
  await anchorLatest(h, '确认第 53 楼');
  const store = createFoundationStore({
    client: h.backend.client,
    contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }),
  });

  h.backend.calls.splice(0);
  const current = await store.readReachable();
  const newReadGets = h.backend.calls.filter(call => call[0] === 'get').length;
  assert.equal(current.status, 'ready');
  assert.equal(current.floors.length, 53);
  assert.equal(newReadGets, 57, '新布局完整冷读为 root + checkpoint + run + 53 floors + 1 floorOrder');

  const entities = Array.from({ length: 15 }, (_, index) => ({
    id: `${String(index + 1).padStart(8, '0')}-dddd-4ddd-8ddd-${String(index + 1).padStart(12, '0')}`,
    displayName: `统计人物-${index + 1}`,
    aliases: [{ name: `别名-${index + 1}`, normalized: `别名-${index + 1}` }],
  }));
  const newIndexes = await buildFoundationIndexes({
    chatId: CHAT, narrativeGeneration: current.root.narrativeGeneration, checkpointId: OTHER_CHAT,
    floors: current.floors, candidates: [], entities, now: '2026-09-02T00:00:00.000Z',
  });
  const legacyIndexes = await buildLegacyIndexFixture({
    chatId: CHAT, narrativeGeneration: current.root.narrativeGeneration,
    checkpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', floors: current.floors, entities,
  });
  h.backend.calls.splice(0);
  await Promise.all(newIndexes.map(index => store.putRecord(index)));
  const newIndexPuts = h.backend.calls.filter(call => call[0] === 'put').length;
  h.backend.calls.splice(0);
  await Promise.all(legacyIndexes.map(index => store.putRecord(index)));
  const legacyIndexPuts = h.backend.calls.filter(call => call[0] === 'put').length;
  assert.equal(newIndexPuts, 1);
  assert.equal(legacyIndexPuts, 137);
  assert.equal(legacyIndexPuts, legacyIndexes.length);

  const legacy = await installLegacyIndexFixture(h);
  h.backend.calls.splice(0);
  const legacyCold = await store.readReachable();
  const legacyReadGets = h.backend.calls.filter(call => call[0] === 'get').length;
  assert.equal(legacyCold.status, 'ready');
  assert.equal(legacyCold.floors.length, current.floors.length);
  assert.equal(legacyReadGets, 151);
  assert.equal(legacyReadGets, 3 + current.floors.length + legacy.indexes.length);
});

test('无布局标识的旧 checkpoint 冷读按四类索引校验，首次新提交自然切换到 floorOrder-v1', async () => {
  const h = harness();
  await h.runtime.start();
  const legacy = await installLegacyIndexFixture(h);
  const store = createFoundationStore({
    client: h.backend.client,
    contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }),
  });
  const cold = await store.readReachable();
  assert.equal(cold.checkpoint.indexLayout, null);
  assert.ok(cold.indexes.some(index => index.kind === 'fingerprint'));
  assert.ok(cold.indexes.some(index => index.kind === 'reverseRef'));

  h.context.chat.push(user('锚定 C'));
  const runtime = createFoundationRuntime({
    hostAdapter: createHostAdapter({ globalRef: { SillyTavern: { getContext: () => h.context } } }),
    store, contextProvider: () => h.context, scanCandidates: legacyScanner, newUuid: uuidFactory(9000),
    now: () => new Date('2026-09-02T00:10:00.000Z'), logger: { warn() {} },
  });
  assert.equal((await runtime.start()).status, 'ready');
  const upgraded = await store.readReachable();
  assert.equal(upgraded.checkpoint.indexLayout, 'floorOrder-v1');
  assert.ok(upgraded.indexes.every(index => index.kind === 'floorOrder'));
  assert.ok(legacy.keys.every(key => h.backend.records.has(`chat-${CHAT}/${key}`)), '旧辅助索引保留为不可达历史记录');
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

test('150 AI 楼为 149 stable，追加 user 锚后 150；不持久化 user 正文并记录线性性能证据', async () => {
  const chat = [];
  for (let index = 1; index <= 150; index += 1) chat.push(user(`USER-SECRET-${index}`), assistant(`AI-${index}`));
  const h = harness(chat);
  let state = await h.runtime.start();
  assert.equal(state.stableCount, 149);
  assert.equal(state.metrics.algorithm, 'ordered-O(n)');
  assert.ok(state.metrics.maximumChunkMs >= 0);
  state = await anchorLatest(h);
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
    store, contextProvider: () => context, prepareSession, scanCandidates: legacyScanner, newUuid: uuidFactory(8000),
    now: () => new Date('2026-09-02T00:00:00.000Z'), logger: { warn() {} },
  });
  runtime.bind({ eventSource: context.eventSource, eventTypes: context.eventTypes });
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const ready = waitForRuntimeStatus(runtime, 'ready', 'CHAT_CHANGED 后地基未收敛');
    handlers.get('CHAT_CHANGED')();
    await ready;
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
    store: secondStore, contextProvider: () => h.context, scanCandidates: legacyScanner, newUuid: uuidFactory(9000),
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

test('swipe 删除：未选项不回退，未摘要当前选中项按本楼替换', async () => {
  const swiped = (values, selected) => ({ is_user: false, is_system: false, mes: values[selected], swipes: values, swipe_id: selected });
  const h = harness([swiped(['A0', 'A1'], 0), assistant('B'), assistant('C')]);
  await h.runtime.start();
  await anchorLatest(h);
  const rootBefore = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-root`).data);
  const floorIdsBefore = h.runtime.getReachable().floors.map(floor => floor.id);
  h.context.chat[0] = swiped(['A0'], 0);
  let state = await h.runtime.refreshStatus();
  assert.equal(state.headCheckpointId, rootBefore.headCheckpointId);
  h.context.chat[0] = swiped(['A2'], 0);
  state = await h.runtime.refreshStatus();
  assert.equal(state.lastRun.result, 'committed');
  assert.notEqual(h.runtime.getReachable().floors[0].id, floorIdsBefore[0]);
  assert.equal(state.stableBoundary.floorId, rootBefore.stableBoundary.floorId);
});

test('user 楼编辑不改正式链；未摘要稳定 AI 大面积重写只提交对应楼', async () => {
  const h = harness([assistant('A'), user('x'), assistant('B'), user('y'), assistant('C'), assistant('D')]);
  await h.runtime.start();
  await anchorLatest(h);
  const before = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  h.context.chat[1].mes = 'edited user only';
  let state = await h.runtime.refreshStatus();
  assert.equal(state.headCheckpointId, before.headCheckpointId);
  h.context.chat.splice(2, 2, assistant('B-rewritten'), user('replacement-anchor'));
  state = await h.runtime.refreshStatus();
  assert.equal(state.lastRun.result, 'committed');
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
    store: stagedStore, contextProvider: () => staged.context, scanCandidates: legacyScanner, newUuid: uuidFactory(13500),
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
    store: coldStore, contextProvider: () => h.context, scanCandidates: legacyScanner, newUuid: uuidFactory(13700),
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
    store: latestStore, contextProvider: () => h.context, scanCandidates: legacyScanner, newUuid: uuidFactory(13800),
    now: () => new Date('2026-09-02T00:50:00.000Z'), logger: { warn() {} },
  });
  assert.equal((await latestRuntime.start()).status, 'ready');
  assert.equal(h.backend.records.get(firstRunKey).data.phase, 'committing');
});

test('新布局 root indexManifest 必须精确覆盖 floorOrder，且拒绝辅助索引', async () => {
  const h = harness();
  await h.runtime.start();
  const root = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-root`).data);
  const checkpoint = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data);
  const run = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-run-${checkpoint.runId}`).data);
  const floors = checkpoint.producedRefs.floors.map(id => structuredClone(h.backend.records.get(`chat-${CHAT}/v3-floor-${id}`).data));
  const indexes = checkpoint.producedRefs.indexes.map(key => structuredClone(h.backend.records.get(`chat-${CHAT}/${key}`).data));
  const base = { root, checkpoint, run, floors, indexes, indexKeys: [...checkpoint.producedRefs.indexes] };
  assert.equal(checkpoint.indexLayout, 'floorOrder-v1');
  assert.ok(indexes.length > 0);
  assert.ok(indexes.every(index => index.kind === 'floorOrder'));

  const missing = structuredClone(base);
  missing.root.indexManifest.floor = [];
  await assert.rejects(validatePreparedFoundation(missing), /V3_GRAPH_ROOT_INDEX_MANIFEST_INVALID/);

  const extra = structuredClone(base);
  extra.root.indexManifest.floor.push('v3-index-floorOrder-0-extra');
  await assert.rejects(validatePreparedFoundation(extra), /V3_GRAPH_ROOT_INDEX_MANIFEST_INVALID/);

  const duplicate = structuredClone(base);
  duplicate.root.indexManifest.floor.push(duplicate.root.indexManifest.floor[0]);
  await assert.rejects(validatePreparedFoundation(duplicate), /V3_GRAPH_ROOT_INDEX_MANIFEST_INVALID/);

  const wrongBucket = structuredClone(base);
  const floorKey = wrongBucket.indexKeys[0];
  wrongBucket.root.indexManifest.floor = [];
  wrongBucket.root.indexManifest.reverseRef.push(floorKey);
  await assert.rejects(validatePreparedFoundation(wrongBucket), /V3_GRAPH_ROOT_INDEX_MANIFEST_INVALID/);

  const auxiliary = structuredClone(base);
  const legacyIndexes = await buildLegacyIndexFixture({ chatId: checkpoint.chatId, narrativeGeneration: checkpoint.narrativeGeneration, checkpointId: checkpoint.id, floors });
  const fingerprint = legacyIndexes.find(index => index.kind === 'fingerprint');
  const fingerprintKey = `v3-index-${fingerprint.kind}-${fingerprint.shard}-${fingerprint.id}`;
  auxiliary.indexes.push(fingerprint);
  auxiliary.indexKeys.push(fingerprintKey);
  auxiliary.checkpoint.producedRefs.indexes.push(fingerprintKey);
  auxiliary.root.indexManifest.floor.push(fingerprintKey);
  await assert.rejects(validatePreparedFoundation(auxiliary), /V3_GRAPH_INDEX_LAYOUT_INVALID/);
});

test('513 楼新布局只写 floorOrder 分页，冷恢复可读', async () => {
  const h = harness(Array.from({ length: 513 }, () => assistant('same-content')));
  await h.runtime.start();
  const state = await anchorLatest(h);
  assert.equal(state.stableCount, 513);
  const root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  const checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  const indexes = checkpoint.producedRefs.indexes.map(key => h.backend.records.get(`chat-${CHAT}/${key}`).data);
  assert.equal(checkpoint.indexLayout, 'floorOrder-v1');
  assert.deepEqual(indexes.map(index => [index.kind, index.shard, index.entryCount]), [
    ['floorOrder', '0', 128], ['floorOrder', '1', 128], ['floorOrder', '2', 128], ['floorOrder', '3', 128], ['floorOrder', '4', 1],
  ]);
  assert.deepEqual(root.indexManifest.entity, []);
  assert.deepEqual(root.indexManifest.reverseRef, []);
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
    store: secondStore, contextProvider: () => h.context, scanCandidates: legacyScanner, newUuid: uuidFactory(12000),
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

test('floorOrder 索引会重算 contentFingerprint，并拒绝错误 key、ref 与 id', async () => {
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

  const wrongId = structuredClone(base);
  wrongId.indexes[0].id = OTHER_CHAT;
  wrongId.indexKeys[0] = `v3-index-${wrongId.indexes[0].kind}-${wrongId.indexes[0].shard}-${OTHER_CHAT}`;
  wrongId.checkpoint.producedRefs.indexes[0] = wrongId.indexKeys[0];
  await assert.rejects(validatePreparedFoundation(wrongId), /V3_GRAPH_INDEX_ROUTE_INVALID/);

  const emptyRefs = structuredClone(base);
  const emptyRefsAt = emptyRefs.indexes.findIndex(index => index.kind === 'floorOrder');
  emptyRefs.indexes[emptyRefsAt].entries[0].refs = [];
  await resign(emptyRefs, emptyRefsAt);
  await assert.rejects(validatePreparedFoundation(emptyRefs), /V3_INDEX_INVALID/);
});

test('旧布局 reverseRef 同一哈希前缀超过 512 entries 时仍可按原规则读取定位', async () => {
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
  const indexes = await buildLegacyIndexFixture({
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
    store, contextProvider: () => h.context, scanCandidates: legacyScanner, newUuid: uuidFactory(14000),
    now: () => new Date('2026-09-02T01:00:00.000Z'), logger: { warn() {} },
  });
  const recovered = await runtime.start();
  assert.equal(recovered.status, 'ready');
  const floorPutsAfter = h.backend.calls.filter(call => call[0] === 'put' && call[2].startsWith('v3-floor-')).length;
  assert.equal(floorPutsAfter, floorPutsBefore, '已验证 staged FloorRecord 不应再次 put');
  const reachable = await store.readReachable();
  assert.deepEqual(reachable.floors.map(floor => floor.content.canonicalContent), ['A', 'B', 'C']);
});

test('staged floorOrder index entries 被篡改但保留旧摘要时，冷启动拒绝发布损坏 root', async () => {
  const h = harness([assistant('A'), assistant('B'), assistant('C'), assistant('D')]);
  h.backend.setConflictRoot(true);
  assert.equal((await h.runtime.start()).status, 'conflict');
  const stagedIndex = [...h.backend.records.values()]
    .find(item => item.data.recordType === 'index' && item.data.kind === 'floorOrder');
  assert.ok(stagedIndex);
  const oldFingerprint = stagedIndex.data.contentFingerprint;
  stagedIndex.data.entries[0].key = '99';
  assert.equal(stagedIndex.data.contentFingerprint, oldFingerprint);
  h.backend.setConflictRoot(false);

  const store = createFoundationStore({
    client: h.backend.client,
    contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }),
  });
  const runtime = createFoundationRuntime({
    hostAdapter: createHostAdapter({ globalRef: { SillyTavern: { getContext: () => h.context } } }),
    store, contextProvider: () => h.context, scanCandidates: legacyScanner, newUuid: uuidFactory(14100),
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
    store, contextProvider: () => h.context, scanCandidates: legacyScanner, newUuid: uuidFactory(14200),
    now: () => new Date('2026-09-02T01:20:00.000Z'), logger: { warn() {} },
  });
  const recovered = await runtime.start();
  assert.equal(recovered.status, 'error');
  assert.match(recovered.lastError, /V3 staged 记录内容冲突/);
  assert.equal(h.backend.records.has(`chat-${CHAT}/v3-root`), false);
  assert.equal((await store.readReachable()).status, 'uninitialized');

  const proof = harness([assistant('A'), assistant('B')]);
  proof.backend.setConflictRoot(true);
  assert.equal((await proof.runtime.start()).status, 'conflict');
  const proofCheckpoint = [...proof.backend.records.values()].find(item => item.data.recordType === 'checkpoint');
  proofCheckpoint.data.inputFingerprints[0].stabilityFingerprint = `sha256:${'a'.repeat(64)}`;
  proof.backend.setConflictRoot(false);
  const proofStore = createFoundationStore({ client: proof.backend.client, contextProvider: () => ({ hostChatId: proof.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }) });
  const proofRuntime = createFoundationRuntime({
    hostAdapter: createHostAdapter({ globalRef: { SillyTavern: { getContext: () => proof.context } } }),
    store: proofStore, contextProvider: () => proof.context, scanCandidates: legacyScanner, newUuid: uuidFactory(14250),
    now: () => new Date('2026-09-02T01:25:00.000Z'), logger: { warn() {} },
  });
  const proofRecovered = await proofRuntime.start();
  assert.equal(proofRecovered.status, 'error');
  assert.match(proofRecovered.lastError, /V3 staged 记录内容冲突/);
});

test('putRecord 409 只复用完整内容等价记录，相同摘要下的不等价 floorOrder index 返回 conflict', async () => {
  const h = harness();
  await h.runtime.start();
  const existing = structuredClone([...h.backend.records.values()]
    .find(item => item.data.recordType === 'index' && item.data.kind === 'floorOrder').data);
  const store = createFoundationStore({
    client: h.backend.client,
    contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }),
  });
  assert.equal((await store.putRecord(structuredClone(existing))).status, 'reused');
  const tampered = structuredClone(existing);
  tampered.entries[0].key = '99';
  assert.equal(tampered.contentFingerprint, existing.contentFingerprint);
  assert.equal((await store.putRecord(tampered)).status, 'conflict');
});

test('root CAS 前重读并校验真实落盘图，写完后被篡改的 index 不得可达', async () => {
  const h = harness();
  let corrupted = false;
  h.backend.setBeforePut(async ({ data }) => {
    if (corrupted || data?.recordType !== 'run' || data.phase !== 'committing') return;
    const persistedIndex = [...h.backend.records.values()]
      .find(item => item.data.recordType === 'index' && item.data.kind === 'floorOrder');
    assert.ok(persistedIndex);
    persistedIndex.data.contentFingerprint = `sha256:${'c'.repeat(64)}`;
    corrupted = true;
  });
  const state = await h.runtime.start();
  assert.equal(corrupted, true);
  assert.equal(state.status, 'error');
  assert.match(state.lastError, /V3_GRAPH_INDEX_(ROUTE|FINGERPRINT)_INVALID/);
  assert.equal(h.backend.records.has(`chat-${CHAT}/v3-root`), false);
});

test('root 校验发现缺失记录后仍等待其他在途读取收拢，且不发 CAS', async () => {
  const h = harness();
  await h.runtime.start();
  const rootKey = `chat-${CHAT}/v3-root`;
  const rootEnvelope = structuredClone(h.backend.records.get(rootKey));
  const checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${rootEnvelope.data.headCheckpointId}`).data;
  const missingKey = `v3-floor-${checkpoint.producedRefs.floors[0]}`;
  h.backend.records.delete(`chat-${CHAT}/${missingKey}`);
  let checkpointRead = false;
  let activeReads = 0;
  let startedReads = 0;
  let completedReads = 0;
  let releaseReads;
  let inflightResolve;
  const readGate = new Promise(resolve => { releaseReads = resolve; });
  const inflight = new Promise(resolve => { inflightResolve = resolve; });
  h.backend.setBeforeGet(async ({ key }) => {
    if (!checkpointRead) {
      assert.match(key, /^v3-checkpoint-/);
      checkpointRead = true;
      return;
    }
    if (key === missingKey) return;
    startedReads += 1;
    activeReads += 1;
    inflightResolve();
    await readGate;
    activeReads -= 1;
    completedReads += 1;
  });
  const store = createFoundationStore({
    client: h.backend.client,
    contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }),
  });
  let settled = false;
  const pending = store.commitRoot(rootEnvelope.data, rootEnvelope.revision).finally(() => { settled = true; });
  await inflight;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, '缺失结果不得让提交在其他读取仍在途时提前结束');
  assert.ok(activeReads > 0);
  assert.equal(h.backend.calls.filter(call => call[0] === 'put' && call[2] === 'v3-root').length, 1, '只存在初始化 root PUT');
  releaseReads();
  await assert.rejects(pending, error => error?.code === 'V3_STORE_FLOOR_MISSING');
  assert.equal(activeReads, 0);
  assert.equal(completedReads, startedReads);
  assert.deepEqual(h.backend.records.get(rootKey), rootEnvelope, '失败校验不得改变 root revision 或内容');
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
        .find(item => item.data.recordType === 'index' && item.data.kind === 'floorOrder');
      assert.ok(persistedIndex);
      persistedIndex.data.contentFingerprint = `sha256:${'b'.repeat(64)}`;
      corrupted = true;
      return baseStore.commitRoot(...args);
    },
  });
  const runtime = createFoundationRuntime({
    hostAdapter: createHostAdapter({ globalRef: { SillyTavern: { getContext: () => h.context } } }),
    store,
    contextProvider: () => h.context,
    scanCandidates: legacyScanner,
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
    store, contextProvider: () => h.context, scanCandidates: legacyScanner, newUuid: uuidFactory(14500),
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
  await installLegacyIndexFixture(h);
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
    store, contextProvider: () => h.context, scanCandidates: legacyScanner, newUuid: uuidFactory(14800),
    now: () => new Date('2026-09-02T03:00:00.000Z'), logger: { warn() {} },
  });
  assert.equal((await runtime.start()).status, 'ready');
  const upgraded = await store.readReachable();
  assert.match(upgraded.root.sourceSnapshotFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(upgraded.checkpoint.indexLayout, 'floorOrder-v1');
  assert.ok(upgraded.indexes.every(index => index.kind === 'floorOrder'));
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
    store, contextProvider: () => h.context, scanCandidates: legacyScanner, newUuid: uuidFactory(14900),
    now: () => new Date('2026-09-02T03:30:00.000Z'), logger: { warn() {} },
  });
  const review = await runtime.inspect('coldLegacyIndex');
  assert.equal(review.status, 'needsReview');
  assert.deepEqual(review.reviewReason, { code: 'indexNeedsReseal', assistantSeq: null, messageIndex: null, expectedCount: null, actualCount: null });
  const putsBeforeCachedInspect = h.backend.calls.filter(call => call[0] === 'put').length;
  const cachedReview = await runtime.inspect('cachedLegacyIndex', { allowCached: true });
  assert.equal(cachedReview.status, 'needsReview');
  assert.deepEqual(cachedReview.reviewReason, review.reviewReason);
  assert.equal(h.backend.calls.filter(call => call[0] === 'put').length, putsBeforeCachedInspect, '缓存检查不得自动重封口');
  assert.equal((await runtime.start()).status, 'ready');
  const upgraded = await store.readReachable();
  assert.equal(upgraded.status, 'ready');
  const expectedFloorKeys = upgraded.checkpoint.producedRefs.indexes.filter(key => key.includes('-floorOrder-') || key.includes('-fingerprint-'));
  assert.deepEqual(new Set(upgraded.root.indexManifest.floor), new Set(expectedFloorKeys));
});

test('只读检查给出首个安全图匹配原因，恢复匹配后清除原因', async () => {
  const h = harness();
  await h.runtime.start();
  h.context.chat[0] = assistant('A 已编辑');
  const store = createFoundationStore({
    client: h.backend.client,
    contextProvider: () => ({ hostChatId: h.context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }),
  });
  const runtime = createFoundationRuntime({
    hostAdapter: createHostAdapter({ globalRef: { SillyTavern: { getContext: () => h.context } } }),
    store, contextProvider: () => h.context, scanCandidates: legacyScanner, newUuid: uuidFactory(15000),
    now: () => new Date('2026-09-02T03:35:00.000Z'), logger: { warn() {} },
  });
  const review = await runtime.inspect('coldMismatch');
  assert.equal(review.status, 'needsReview');
  assert.deepEqual(review.reviewReason, { code: 'fingerprintMismatch', assistantSeq: 1, messageIndex: 0, expectedCount: 2, actualCount: 3,
    markerStatus: 'none', rawFingerprintMatches: false, canonicalFingerprintMatches: false, sanitizerFingerprintMatches: true });
  assert.equal(review.lastError, null, '图匹配原因不是 API 读取错误');
  h.context.chat[0] = assistant('A');
  const recovered = await runtime.inspect('matchedAgain');
  assert.equal(recovered.status, 'ready');
  assert.equal(recovered.reviewReason, null);
});

test('无 marker 的包装变化与唯一位置移动在检查和封口中沿用原 floor', async () => {
  const h = harness([assistant('正文 A'), user('继续'), assistant('尾楼')]);
  await h.runtime.start();
  const before = h.runtime.getReachable().floors[0];
  h.context.chat[0] = assistant('正文 A<!--宿主新包装-->');
  const wrappedReview = await h.runtime.inspect('wrappedCanonical');
  assert.equal(wrappedReview.status, 'ready');
  assert.equal(wrappedReview.reviewReason, null);
  await h.runtime.reconcile('wrappedCanonical');
  assert.equal(h.runtime.getReachable().floors[0].id, before.id);

  const movedHarness = harness([assistant('正文 B'), user('继续'), assistant('尾楼')]);
  await movedHarness.runtime.start();
  const beforeMove = movedHarness.runtime.getReachable().floors[0];
  movedHarness.context.chat.splice(0, 0, user('前置消息'));
  const movedReview = await movedHarness.runtime.inspect('movedUnique');
  assert.equal(movedReview.status, 'ready');
  await movedHarness.runtime.reconcile('movedUnique');
  const moved = movedHarness.runtime.getReachable().floors[0];
  assert.equal(moved.id, beforeMove.id);
  assert.equal(moved.hostLocator.messageIndex, 1);
});

test('真实聊天 session + lifecycle + V3 runtime 在 CHAT_CHANGED UUID 时序下只建立一份身份', async () => {
  const context = hostContext([assistant('A'), assistant('B')]);
  delete context.chatMetadata.qianqianjie;
  const handlers = new Map();
  context.eventTypes = Object.fromEntries(EVENT_NAMES.map(name => [name, name]));
  context.eventTypes.PERSONA_CHANGED = 'PERSONA_CHANGED';
  context.eventSource = { on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); } };
  const backend = backendHarness();
  let ensureCalls = 0;
  const session = createChatSession({
    contextProvider: () => context,
    ensureChatId: async raw => {
      ensureCalls += 1;
      await new Promise(resolve => setImmediate(resolve));
      raw.chatMetadata.qianqianjie = { schemaVersion: 1, chatId: CHAT };
      return CHAT;
    },
  });
  const lifecycle = createPluginLifecycle({ session, getUi: () => null, logger: { warn() {} } });
  const store = createFoundationStore({ client: backend.client, contextProvider: () => session.identity() });
  const runtime = createFoundationRuntime({
    hostAdapter: createHostAdapter({ globalRef: { SillyTavern: { getContext: () => context } } }),
    store, contextProvider: () => context, prepareSession: () => session.prepare(),
    scanCandidates: legacyScanner, newUuid: uuidFactory(15000), now: () => new Date('2026-09-02T00:00:00.000Z'), logger: { warn() {} },
  });
  lifecycle.bind({ eventSource: context.eventSource, eventTypes: context.eventTypes });
  runtime.bind({ eventSource: context.eventSource, eventTypes: context.eventTypes });
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const ready = waitForRuntimeStatus(runtime, 'ready', '身份落盘后地基未收敛');
    for (const handler of handlers.get('CHAT_CHANGED')) handler();
    await ready;
  } finally { process.off('unhandledRejection', onUnhandled); }
  assert.equal(ensureCalls, 1);
  assert.equal(session.identity().chatId, CHAT);
  assert.equal(runtime.getState().status, 'ready');
  assert.deepEqual(unhandled, []);
});

test('生产 scanner 只用紧邻普通 user 稳定 AI，真 system 不算而 auto-hide user 算', async () => {
  const autoHideUser = { is_user: true, is_system: true, mes: '已自动隐藏的用户消息', send_date: 'anchor-auto-hide', extra: { qianqianjieAutoHide: true } };
  const trueSystem = { is_user: true, is_system: true, mes: '真实系统消息', send_date: 'system-1', extra: { type: 'narrator' } };
  const candidates = await scanAssistantCandidates([
    assistant('AI0'), user('U1'), assistant('AI2'), trueSystem, assistant('AI4'), autoHideUser, assistant('AI6'),
  ]);
  assert.deepEqual(candidates.map(item => item.stabilityProof?.kind ?? null), ['nextUser', null, 'nextUser', null]);
  assert.deepEqual(candidates.map(item => item.stabilityProof?.messageIndex ?? null), [1, null, 5, null]);
});

test('生产 scanner 的连续 AI 尾部全部进入只读待摘要投影，正式楼与晋升语义保持不变', async () => {
  const chat = Array.from({ length: 84 }, (_, messageIndex) => messageIndex % 2 === 0
    ? assistant(`已登记 AI ${messageIndex}`)
    : user(`稳定用户楼 ${messageIndex}`));
  chat.push(assistant('A84'), assistant('A85'), user('U86'), assistant('A87'));
  const h = harness(chat, { modernAnchors: true });
  let state = await h.runtime.start();
  assert.equal(state.stableCount, 42);
  assert.equal(h.runtime.getReachable().floors.length, 42);
  assert.deepEqual(state.unregisteredCandidates, [
    { assistantSeq: 43, messageIndex: 84, reason: 'consecutiveAssistant' },
    { assistantSeq: 44, messageIndex: 85, reason: 'waitingEarlierFloor' },
    { assistantSeq: 45, messageIndex: 87, reason: 'waitingNextUser' },
  ]);
  assert.equal(state.pending?.messageIndex, 84, '原有首个 pending 语义保持不变');

  const promotion = harness([assistant('正常单尾 AI')], { modernAnchors: true });
  state = await promotion.runtime.start();
  assert.deepEqual(state.unregisteredCandidates, [{ assistantSeq: 1, messageIndex: 0, reason: 'waitingNextUser' }]);
  promotion.context.chat.push(user('确认上一楼'));
  state = await promotion.runtime.refreshStatus();
  assert.equal(state.stableCount, 1);
  assert.deepEqual(state.unregisteredCandidates, [], '候选成为正式 floor 后不得重复显示');
  assert.equal(promotion.runtime.getReachable().floors[0].hostLocator.messageIndex, 0);

  const caughtUp = harness([assistant('已稳定 AI'), user('确认')], { modernAnchors: true });
  state = await caughtUp.runtime.start();
  assert.equal(state.stableCount, 1);
  assert.deepEqual(state.unregisteredCandidates, []);
});

test('MESSAGE_SENT 在 user 入列时稳定前一 AI；重复事件、同锚正文编辑与尾楼 reroll 均不破坏前缀', async () => {
  const h = harness([assistant('AI0')], { modernAnchors: true });
  let state = await h.runtime.start();
  assert.equal(state.stableCount, 0);
  state = await h.runtime.confirmLatest();
  assert.equal(state.stableCount, 0, '无 user 锚时旧确认入口不得写入最新 AI');

  h.context.chat.push(user('U1'));
  assert.equal(h.handlers.get('MESSAGE_SENT')(1), undefined, '宿主事件 listener 不等待异步持久化');
  for (let attempt = 0; attempt < 100 && h.runtime.getState().stableCount !== 1; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  state = h.runtime.getState();
  assert.equal(state.stableCount, 1);
  const firstRoot = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-root`));
  const firstGeneration = h.runtime.getReachable().root.narrativeGeneration;

  h.handlers.get('MESSAGE_SENT')(1);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(h.backend.records.get(`chat-${CHAT}/v3-root`), firstRoot, '重复 MESSAGE_SENT 不得重复提交');
  h.context.chat[1].mes = 'U1 编辑后正文';
  state = await h.runtime.refreshStatus();
  assert.equal(h.runtime.getReachable().root.narrativeGeneration, firstGeneration);
  assert.deepEqual(h.backend.records.get(`chat-${CHAT}/v3-root`), firstRoot, '同一 user 身份的正文编辑不撤锚');

  h.context.chat.push(assistant('AI2-old'));
  state = await h.runtime.refreshStatus();
  assert.equal(state.stableCount, 1);
  h.context.chat[2] = assistant('AI2-reroll');
  state = await h.runtime.refreshStatus();
  assert.equal(state.stableCount, 1);
  assert.equal(h.runtime.getReachable().root.narrativeGeneration, firstGeneration);
  assert.equal(h.runtime.getReachable().floors[0].content.canonicalContent, 'AI0');
});

test('替换 user 正文不改变未摘要楼身份，删除唯一稳定证明仍撤回未保存楼', async () => {
  const h = harness([assistant('AI0'), user('U1'), assistant('AI2'), user('U3'), assistant('AI4')], { modernAnchors: true });
  let state = await h.runtime.start();
  assert.equal(state.stableCount, 2);
  const oldGeneration = h.runtime.getReachable().root.narrativeGeneration;
  const oldFloorIds = h.runtime.getReachable().floors.map(floor => floor.id);

  h.context.chat[1] = { ...user('U1 replacement'), send_date: 'replacement-anchor-1' };
  state = await h.runtime.refreshStatus();
  assert.equal(state.stableCount, 2);
  assert.equal(h.runtime.getReachable().root.narrativeGeneration, oldGeneration);
  assert.deepEqual(h.runtime.getReachable().floors.map(floor => floor.id), oldFloorIds);

  h.context.chat.splice(1, 1);
  h.handlers.get('MESSAGE_DELETED')(1);
  for (let attempt = 0; attempt < 100 && h.runtime.getState().stableCount !== 0; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  state = h.runtime.getState();
  assert.equal(state.stableCount, 0, '中间 user 删除后只能保留其前方连续稳定前缀');
  assert.equal(h.runtime.getReachable().floors.length, 0);
});

test('已挂有效 marker 且属于当前图的末楼即使尚无摘要，失去 user 锚后仍永久稳定', async () => {
  const h = harness([assistant('已挂标末楼'), user('稳定锚')], { modernAnchors: true });
  let state = await h.runtime.start();
  assert.equal(state.stableCount, 1);
  const floor = h.runtime.getReachable().floors[0];
  assert.equal(h.runtime.getReachable().floorMemories.length, 0, '夹具必须覆盖尚无 active FloorMemory 的楼');
  h.context.chat[0].extra.qianqianjie_floor = { schemaVersion: 1, chatId: CHAT, floorId: floor.id };
  h.context.chat.splice(1, 1);

  state = await h.runtime.refreshStatus();
  assert.equal(state.status, 'ready');
  assert.equal(state.stableCount, 1);
  assert.equal(h.runtime.getReachable().floors[0].id, floor.id);
});

const EVENT_NAMES = ['CHAT_CHANGED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MORE_MESSAGES_LOADED'];
