import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostAdapter } from '../src/v3/host-adapter.js';
import { createFoundationStore } from '../src/v3/foundation-store.js';
import { createFoundationRuntime } from '../src/v3/foundation-runtime.js';
import { createV3MemoryRuntime } from '../src/v3/memory-runtime.js';
import { EXTRACTOR_SYSTEM_PROMPT } from '../src/v3/extractor.js';
import { createChatIdentityCoordinator, CHAT_IDENTITY_COLLECTION } from '../src/chat-identity.js';
import { createArchiveV2Session } from '../src/archive-v2-session.js';

const SOURCE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = '2026-09-05T00:00:00.000Z';
const assistant = mes => ({ is_user: false, is_system: false, mes, swipes: [mes], swipe_id: 0 });
const user = mes => ({ is_user: true, is_system: false, mes });
const uuidFactory = () => { let value = 1000; return () => `${(++value).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`; };

function backendHarness() {
  const records = new Map();
  const calls = [];
  const failure = status => Object.assign(new Error(`HTTP ${status}`), { status });
  const envelope = (data, revision) => ({ revision, data: structuredClone(data), createdAt: NOW, updatedAt: NOW });
  const client = {
    async get(collection, key) {
      calls.push(['get', collection, key]);
      const value = records.get(`${collection}/${key}`);
      if (!value) throw failure(404);
      return envelope(value.data, value.revision);
    },
    async put(collection, key, data, expectedRevision) {
      calls.push(['put', collection, key]);
      const mapKey = `${collection}/${key}`;
      const previous = records.get(mapKey);
      if ((previous?.revision ?? 0) !== expectedRevision) throw failure(409);
      const revision = (previous?.revision ?? 0) + 1;
      records.set(mapKey, { revision, data: structuredClone(data) });
      return envelope(data, revision);
    },
  };
  return { records, calls, client };
}

function context(hostChatId, qqjChatId, chat, characterAvatar = 'character.png') {
  return {
    name1: '林岚', name2: '裴晚生', characterId: 0, groupId: null, chatId: hostChatId,
    characters: [{ avatar: characterAvatar, name: '裴晚生', data: { description: '角色描述', personality: '克制', scenario: '雨夜' } }],
    userAvatar: 'persona.png', powerUserSettings: { persona_description: '调查员' },
    chatMetadata: { qianqianjie: { schemaVersion: 2, chatId: qqjChatId } }, chat,
    async saveMetadata() {},
    getWorldInfoNames() { return []; }, async loadWorldInfoBatch() { return new Map(); },
  };
}

function identity(hostChatId, chatId, characterLocator = 'character.png') {
  return { hostChatId, chatId, characterLocator, personaLocator: 'persona.png' };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(message);
}

function chatRecords(records, chatId) {
  return JSON.stringify([...records.entries()].filter(([key]) => key.startsWith(`chat-${chatId}/`)).sort(([left], [right]) => left.localeCompare(right)));
}

test('复制分支只领独立身份，源记忆零读零搬运，按钮授权后才自行重建', async () => {
  const backend = backendHarness();
  let activeContext = context('原聊天', SOURCE, [user('开始'), assistant('公共 A'), assistant('公共 B'), assistant('旧线 C'), assistant('旧线 pending')]);
  const hostAdapter = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => activeContext } } });
  const sourceSession = createArchiveV2Session({
    contextProvider: () => activeContext,
    identityCoordinator: createChatIdentityCoordinator({ client: backend.client, now: () => new Date(NOW) }),
  });
  assert.equal((await sourceSession.prepare()).identity.chatId, SOURCE);
  const sourceStore = createFoundationStore({ client: backend.client, contextProvider: () => identity('原聊天', SOURCE) });
  const sourceFoundation = createFoundationRuntime({ hostAdapter, store: sourceStore, contextProvider: () => activeContext, now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} } });
  let apiCalls = 0;
  const generateUtilityTask = async options => {
    apiCalls += 1;
    if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) {
      const content = JSON.parse(options.taskMessages[0].content).payload.canonicalContent;
      return { jsonData: { summary: `摘要-${content}` }, taskMetadata: { source: 'test', sourceLabel: '测试', model: 'mock' } };
    }
    return { jsonData: { noMaterialChange: true }, taskMetadata: { source: 'test', sourceLabel: '测试', model: 'mock' } };
  };
  const sourceMemory = createV3MemoryRuntime({
    foundationRuntime: sourceFoundation, store: sourceStore, hostAdapter, generateUtilityTask,
    now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} },
  });
  await sourceMemory.start();
  await sourceMemory.startHistoricalRebuild();
  await waitFor(() => sourceMemory.getState().rebuildStatus === 'caughtUp' && !sourceMemory.getState().activeAutoMemory, '源聊天记忆未追平');

  const sourceBefore = chatRecords(backend.records, SOURCE);
  const callsBeforeClone = apiCalls;

  activeContext = context('复制聊天', SOURCE, [user('开始'), assistant('公共 A'), assistant('公共 B'), assistant('新线 X'), assistant('新线 pending')]);
  const cloneClient = {
    async get(collection, key) {
      assert.notEqual(collection, `chat-${SOURCE}`, '建立复制分支身份不得读源聊天记忆');
      return backend.client.get(collection, key);
    },
    async put(collection, key, data, expectedRevision) { return backend.client.put(collection, key, data, expectedRevision); },
  };
  const cloneSession = createArchiveV2Session({
    contextProvider: () => activeContext,
    identityCoordinator: createChatIdentityCoordinator({ client: cloneClient, now: () => new Date(NOW) }),
  });
  const prepared = await cloneSession.prepare();
  const targetChatId = prepared.identity.chatId;
  assert.equal(prepared.status, 'ready');
  assert.notEqual(targetChatId, SOURCE);
  assert.equal(apiCalls, callsBeforeClone, '独立身份建立不得调用 Extractor/CSE');
  assert.equal(chatRecords(backend.records, SOURCE), sourceBefore, '源聊天全部记录必须不变');
  const targetBinding = backend.records.get(`${CHAT_IDENTITY_COLLECTION}/binding-${targetChatId}`).data;
  assert.equal(targetBinding.state, 'ready');
  assert.equal(targetBinding.sourceChatId, null);

  const targetStore = createFoundationStore({ client: backend.client, contextProvider: () => identity('复制聊天', targetChatId) });
  assert.equal((await targetStore.readReachable()).status, 'uninitialized');
  const targetFoundation = createFoundationRuntime({ hostAdapter, store: targetStore, contextProvider: () => activeContext, now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} } });
  const targetMemory = createV3MemoryRuntime({
    foundationRuntime: targetFoundation, store: targetStore, hostAdapter, generateUtilityTask,
    now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} },
  });
  await targetMemory.start();
  assert.equal(targetMemory.getState().rebuildStatus, 'pendingRebuild');
  assert.equal(apiCalls, callsBeforeClone, '仅检测到 historical debt 不得自动调模型');
  await targetMemory.startHistoricalRebuild();
  await waitFor(() => targetMemory.getState().rebuildStatus === 'caughtUp' && !targetMemory.getState().activeAutoMemory, '复制分支手动重建未追平');
  const target = await targetStore.readReachable();
  assert.deepEqual(target.floorMemories.map(item => item.summary.aiText), ['摘要-公共 A', '摘要-公共 B', '摘要-新线 X']);
  assert.equal(chatRecords(backend.records, SOURCE), sourceBefore, '分支自行重建也不得改源数据');
});

test('无 binding 的旧 root 不再猜原分支：相同正文的两宿主按任何顺序打开都各领稳定新 ID', async () => {
  const openInOrder = async order => {
    const backend = backendHarness();
    const body = [user('开始'), assistant('公共 A'), assistant('公共 B'), assistant('pending')];
    const legacyHost = context('旧 root 建造宿主', SOURCE, body);
    const sourceAdapter = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => legacyHost } } });
    const sourceStore = createFoundationStore({ client: backend.client, contextProvider: () => identity('旧 root 建造宿主', SOURCE) });
    await createFoundationRuntime({ hostAdapter: sourceAdapter, store: sourceStore, contextProvider: () => legacyHost, now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} } }).start();
    const legacyBefore = chatRecords(backend.records, SOURCE);
    const hosts = {
      source: context('原聊天', SOURCE, body),
      clone: context('复制聊天', SOURCE, body),
    };
    const ids = {};
    for (const name of order) {
      const session = createArchiveV2Session({
        contextProvider: () => hosts[name],
        identityCoordinator: createChatIdentityCoordinator({ client: backend.client, now: () => new Date(NOW) }),
      });
      ids[name] = (await session.prepare()).identity.chatId;
    }
    assert.notEqual(ids.source, SOURCE);
    assert.notEqual(ids.clone, SOURCE);
    assert.notEqual(ids.source, ids.clone);
    assert.equal(backend.records.has(`${CHAT_IDENTITY_COLLECTION}/binding-${SOURCE}`), false, '旧 ID 不得被任何宿主认领');
    assert.equal(backend.records.has(`chat-${ids.source}/v3-root`), false, '原聊天新身份不得继承 root');
    assert.equal(backend.records.has(`chat-${ids.clone}/v3-root`), false, '复制分支新身份不得继承 root');
    assert.equal(chatRecords(backend.records, SOURCE), legacyBefore, '旧 root 与其可达记录必须逐字不变');
    return ids;
  };
  const cloneFirst = await openInOrder(['clone', 'source']);
  const sourceFirst = await openInOrder(['source', 'clone']);
  assert.deepEqual(sourceFirst, cloneFirst, '独立 ID 只由宿主身份决定，不得受打开顺序影响');
});

test('复制到不同角色卡也只建独立身份，不读旧卡记忆', async () => {
  const backend = backendHarness();
  const source = context('原角色聊天', SOURCE, [], 'old-character.png');
  await createArchiveV2Session({
    contextProvider: () => source,
    identityCoordinator: createChatIdentityCoordinator({ client: backend.client, now: () => new Date(NOW) }),
  }).prepare();
  const clone = context('新角色复制', SOURCE, [], 'new-character.png');
  const guardedClient = {
    async get(collection, key) {
      assert.notEqual(collection, `chat-${SOURCE}`, '不得读旧角色记忆');
      return backend.client.get(collection, key);
    },
    async put(collection, key, data, expectedRevision) { return backend.client.put(collection, key, data, expectedRevision); },
  };
  const result = await createArchiveV2Session({
    contextProvider: () => clone,
    identityCoordinator: createChatIdentityCoordinator({ client: guardedClient, now: () => new Date(NOW) }),
  }).prepare();
  assert.notEqual(result.identity.chatId, SOURCE);
  assert.equal(backend.records.get(`${CHAT_IDENTITY_COLLECTION}/binding-${result.identity.chatId}`).data.owner.characterLocator, 'new-character.png');
  assert.equal(backend.records.has(`chat-${result.identity.chatId}/v3-root`), false);
});
