import test from 'node:test';
import assert from 'node:assert/strict';
import { createTauriBackendFetch } from '../src/tauri-backend.js';
import { createBackendClient } from '../src/backend-client.js';
import { createFoundationStore } from '../src/v3/foundation-store.js';
import { createFoundationRuntime } from '../src/v3/foundation-runtime.js';
import { createV3MemoryRuntime } from '../src/v3/memory-runtime.js';
import { createHostAdapter } from '../src/v3/host-adapter.js';
import { createIndexedDbCoreRecordCache } from '../src/v3/indexeddb-core-cache.js';
import { createChatSession } from '../src/chat-session.js';
import { createMemoryTransfer } from '../src/memory-transfer.js';
import { EXTRACTOR_SYSTEM_PROMPT } from '../src/v3/extractor.js';
import { localForageHarness } from './helpers/indexeddb-harness.mjs';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = '2026-10-28T00:00:00.000Z';
const coreTypes = ['floor', 'floorMemory', 'entity', 'stateDelta', 'index'];
const nativeJson = value => Array.isArray(value) ? value.map(nativeJson) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, nativeJson(value[key])])) : value;
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture() {
  const slots = new Map(), nativeReads = [];
  const slotKey = ({ namespace, table = 'main', key }) => `${namespace}/${table}/${key}`;
  const native = {
    async tryGetJson(options) {
      const value = slots.get(slotKey(options));
      nativeReads.push(value?.serialized ? JSON.parse(value.serialized).current?.data?.recordType ?? 'aux' : 'missing');
      return value ? { found: true, value: structuredClone(value) } : { found: false };
    },
    async setJson(options) { slots.set(slotKey(options), nativeJson(options.value)); },
    async deleteJson(options) { slots.delete(slotKey(options)); },
    async listKeys({ namespace, table }) { const prefix = `${namespace}/${table}/`; return [...slots.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length)); },
    async listTables({ namespace }) { return [...new Set([...slots.keys()].filter(key => key.startsWith(`${namespace}/`)).map(key => key.split('/')[1]))]; },
  };
  const globalRef = { crypto: globalThis.crypto, __TAURITAVERN__: { ready: Promise.resolve(), api: { extension: { store: native } } } };
  const makeClient = () => createBackendClient({ fetchImpl: createTauriBackendFetch({ globalRef }) });
  const client = makeClient(), idb = localForageHarness();
  // TT v2.2.0 src/scripts/user.js supplies this default itself, even before /api/users/me.
  const getCurrentUserHandle = () => 'default-user';
  const location = { origin: 'tauri://localhost' };
  const makeCache = (source = idb) => createIndexedDbCoreRecordCache({ localForage: source.localForage,
    indexedDBProvider: () => source.indexedDB, keyRangeProvider: () => source.keyRange,
    accountHandleProvider: getCurrentUserHandle, originProvider: () => location.origin });
  const chat = [{ is_user: true, mes: '开始', send_date: NOW }];
  for (let index = 0; index < 24; index++) chat.push(
    { is_user: false, is_system: false, mes: `第${index + 1}楼，守门人把钥匙放进木盒。`, swipes: [`第${index + 1}楼，守门人把钥匙放进木盒。`], swipe_id: 0 },
    { is_user: true, mes: `继续${index}`, send_date: new Date(Date.parse(NOW) + (index + 1) * 1000).toISOString() });
  const context = { name1: '访客', name2: '守门人', characterId: 0, groupId: null, chatId: 'cache-chat',
    characters: [{ avatar: 'character.png', name: '守门人', data: { description: '负责保管钥匙。' } }],
    userAvatar: 'persona.png', powerUserSettings: { persona_description: '前来取钥匙的访客。' },
    chatMetadata: { qianqianjie: { schemaVersion: 2, chatId: CHAT } }, chat,
    async saveMetadata() {}, async saveChat() { return true; }, getRequestHeaders() { return {}; } };
  const identity = () => ({ hostChatId: context.chatId, chatId: context.chatMetadata.qianqianjie.chatId,
    characterLocator: 'character.png', personaLocator: 'persona.png' });
  const host = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => context } } });
  const makeRuntime = (cache, transport = makeClient()) => {
    const store = createFoundationStore({ client: transport, contextProvider: identity, coreRecordCache: cache });
    const foundation = createFoundationRuntime({ hostAdapter: host, store, contextProvider: () => context,
      newUuid: () => crypto.randomUUID(), now: () => new Date(NOW), logger: { warn() {} } });
    return { store, foundation };
  };
  const seeded = makeRuntime(null, client);
  const initial = await seeded.foundation.start();
  assert.equal(initial.status, 'ready', JSON.stringify(initial.lastError));
  const memory = createV3MemoryRuntime({ foundationRuntime: seeded.foundation, store: seeded.store, hostAdapter: host,
    automationSettings: () => ({ enabled: false, batchSize: 1 }), newUuid: () => crypto.randomUUID(),
    now: () => new Date(NOW), logger: { warn() {} },
    generateUtilityTask: async options => ({ jsonData: options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { summary: '钥匙在木盒里。' } : { noMaterialChange: true } }),
    generateAnalysisTask: async () => ({ jsonData: { noMaterialChange: true } }) });
  await memory.start();
  await memory.extractFloor(memory.getState().floors[0].floorId, { analyzeState: false });
  await memory.analyzeNextState();
  const cache = makeCache();
  const settleCache = async (graph, currentCache = cache) => {
    const envelope = await client.get(`chat-${graph.root.chatId}`, 'v3-root');
    const witness = { formatVersion: 1, generationId: envelope.generationId, revision: envelope.revision,
      headCheckpointId: graph.root.headCheckpointId, narrativeGeneration: graph.root.narrativeGeneration,
      sourceSnapshotFingerprint: graph.root.sourceSnapshotFingerprint };
    const scope = await currentCache.scopeFor({ chatId: graph.root.chatId });
    assert.ok(scope, '宿主现成账户和origin必须形成非空scope');
    for (let count = 0; count < 200; count++) { if (await currentCache.readManifest(scope, witness)) return; await tick(); }
    assert.fail('正式图读取后未发布缓存manifest');
  };
  return { client, idb, nativeReads, context, identity, host, memory, makeCache, makeRuntime, cache, settleCache };
}

test('TT正式client/store/runtime冷读后，新实例热读五类core省去原生IO；关闭和不可用仍正式回源', async t => {
  const f = await fixture();
  f.nativeReads.length = 0;
  const cold = f.makeRuntime(f.cache); await cold.foundation.inspect('cold');
  const graph = cold.foundation.getReachable(), coldReads = [...f.nativeReads];
  assert.equal(graph.status, 'ready'); assert.equal(graph.floors.length, 24);
  for (const type of coreTypes) assert.ok(coldReads.includes(type), `冷读实际包含${type}`);
  await f.settleCache(graph);

  f.nativeReads.length = 0;
  const restartedCache = f.makeCache(), restarted = f.makeRuntime(restartedCache);
  await restarted.foundation.inspect('restart');
  assert.deepEqual(restarted.foundation.getReachable(), graph);
  const hotReads = [...f.nativeReads];
  t.diagnostic(`24楼图（1条摘要和1条状态变化）：冷读${coldReads.length}次原生读取，重启热读${hotReads.length}次。`);
  assert.deepEqual([...new Set(hotReads)].sort(), ['root', 'checkpoint', 'run', 'baseline', 'currentState'].sort());
  assert.equal(hotReads.some(type => coreTypes.includes(type)), false, '每类core通过当前root见证后全部走现有IDB');
  assert.ok(hotReads.length * 4 < coldReads.length, `${coldReads.length}次原生读取降至${hotReads.length}次`);
  assert.ok(restartedCache.getStats().hits >= 24);

  for (const cache of [null, f.makeCache({ localForage: null })]) {
    f.nativeReads.length = 0;
    const uncached = f.makeRuntime(cache); await uncached.foundation.inspect('formal');
    assert.deepEqual(uncached.foundation.getReachable(), graph);
    for (const type of coreTypes) assert.ok(f.nativeReads.includes(type), `缓存关闭或不可用必须回源${type}`);
  }
});

test('TT手工摘要和人物状态提交后按新root读取，旧缓存不遮盖新值', async () => {
  const f = await fixture(), before = f.makeRuntime(f.cache);
  await before.foundation.inspect('before'); const previous = before.foundation.getReachable();
  await f.settleCache(previous);
  const floorId = f.memory.getState().floors[0].floorId;
  await f.memory.editSummary(floorId, '用户手改：钥匙已放入衣袋。');
  const state = f.memory.getState(), subject = state.cseSubjects[0];
  assert.ok(subject && state.currentStateId);
  await f.memory.correctSubjectState(subject.subjectEntityId, { expectedCurrentStateId: state.currentStateId,
    expectedCurrentStateFingerprint: state.currentStateFingerprint, core: subject.core, adaptive: subject.adaptive,
    situational: [...subject.situational, { text: '用户手填状态', reason: '用户输入', visibility: 'private', towardEntityId: null }] });
  const fresh = f.makeRuntime(f.cache); await fresh.foundation.inspect('after-edits');
  const edited = fresh.foundation.getReachable();
  assert.notEqual(edited.root.headCheckpointId, previous.root.headCheckpointId);
  assert.equal(edited.floorMemories.find(memory => memory.floorId === floorId).summary.userText, '用户手改：钥匙已放入衣袋。');
  assert.ok(JSON.stringify(edited.currentStates).includes('用户手填状态'));
  await f.settleCache(edited);
  const hot = f.makeRuntime(f.makeCache()); await hot.foundation.inspect('edited-restart');
  assert.deepEqual(hot.foundation.getReachable(), edited);
});

test('TT实际记忆导入切换新chatId与撤销返回旧chatId，各自缓存按根见证隔离', async () => {
  const f = await fixture(), original = f.makeRuntime(f.cache);
  await original.foundation.inspect('original'); const graph = original.foundation.getReachable();
  await f.settleCache(graph);
  let saved = [{ chat_metadata: structuredClone(f.context.chatMetadata) }, ...structuredClone(f.context.chat)];
  const session = createChatSession({ contextProvider: () => f.context }); await session.prepare();
  const transfer = createMemoryTransfer({ client: f.client, session, hostAdapter: f.host,
    fetchImpl: async (url, init) => {
      if (url === '/api/chats/get') return { ok: true, json: async () => structuredClone(saved) };
      assert.equal(url, '/api/chats/save'); saved = structuredClone(JSON.parse(init.body).chat);
      return { ok: true, json: async () => ({}) };
    },
    onSettled: async () => { session.invalidate(); await session.prepare(); } });
  const exported = await transfer.exportCurrent(), preview = await transfer.preview(exported.text);
  const imported = await transfer.importPreview(preview);
  assert.notEqual(imported.chatId, CHAT);
  const importedRuntime = f.makeRuntime(f.cache); await importedRuntime.foundation.inspect('imported');
  const importedGraph = importedRuntime.foundation.getReachable();
  assert.equal(importedGraph.root.chatId, imported.chatId);
  assert.deepEqual(importedGraph.floorMemories[0].summary, graph.floorMemories[0].summary);
  await f.settleCache(importedGraph);
  await transfer.undo();
  assert.equal(f.identity().chatId, CHAT);
  f.nativeReads.length = 0;
  const restored = f.makeRuntime(f.makeCache()); await restored.foundation.inspect('undo');
  assert.deepEqual(restored.foundation.getReachable(), graph);
  assert.equal(f.nativeReads.some(type => coreTypes.includes(type)), false, '撤销后核旧root，复用旧身份的已验证副本');
});
