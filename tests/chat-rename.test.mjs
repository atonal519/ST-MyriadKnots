import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatIdentityCoordinator, CHAT_IDENTITY_COLLECTION } from '../src/chat-identity.js';
import { createChatSession } from '../src/chat-session.js';
import { createPluginLifecycle } from '../src/plugin-lifecycle.js';
import { createHostChatList } from '../src/host-context.js';
import { persistTargetChatIdentity } from '../src/v3/message-floor-anchor.js';

const OLD = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-09-07T03:00:00.000Z';
const bindingKey = id => `${CHAT_IDENTITY_COLLECTION}/binding-${id}`;
const failure = status => Object.assign(new Error(`HTTP ${status}`), { status });
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(message);
}

function backendHarness({ beforePut = null } = {}) {
  const records = new Map();
  const calls = [];
  const client = {
    async list(collection, { signal } = {}) {
      calls.push(['list', collection]);
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return [...records.entries()]
        .filter(([mapKey]) => mapKey.startsWith(`${collection}/`))
        .map(([mapKey, value]) => ({ recordId: mapKey.slice(collection.length + 1), revision: value.revision, data: structuredClone(value.data) }));
    },
    async get(collection, key) {
      calls.push(['get', collection, key]);
      const value = records.get(`${collection}/${key}`);
      if (!value) throw failure(404);
      return { revision: value.revision, data: structuredClone(value.data) };
    },
    async put(collection, key, data, expectedRevision) {
      calls.push(['put', collection, key, expectedRevision]);
      await beforePut?.({ collection, key, data, expectedRevision });
      const mapKey = `${collection}/${key}`, previous = records.get(mapKey);
      if ((previous?.revision ?? 0) !== expectedRevision) throw failure(409);
      const revision = (previous?.revision ?? 0) + 1;
      records.set(mapKey, { revision, data: structuredClone(data) });
      return { revision, data: structuredClone(data) };
    },
  };
  return { records, calls, client };
}

function readyBinding(chatId, hostChatId, { sourceChatId = null, revision = 1, characterLocator = 'char.png', personaLocator = 'me.png', state = 'ready' } = {}) {
  return {
    revision,
    data: {
      schemaVersion: 1, kind: 'qqj-chat-identity-binding', chatId,
      owner: { hostChatId, characterLocator, personaLocator },
      state, sourceChatId, createdAt: NOW, updatedAt: NOW,
    },
  };
}

function hostContext(hostChatId = '旧聊天') {
  const context = {
    characterId: 0, groupId: null, chatId: hostChatId,
    characters: [{ avatar: 'char.png', name: '角色' }], userAvatar: 'me.png',
    chatMetadata: { qianqianjie: { schemaVersion: 2, chatId: OLD } },
    saves: 0, saveBlock: null,
    async saveChatMetadata() {
      context.saves += 1;
      if (context.saveBlock) await context.saveBlock.promise;
      return true;
    },
  };
  return context;
}

function eventHarness() {
  const handlers = new Map();
  return {
    handlers,
    eventSource: { on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } },
    async emit(name, ...args) { for (const handler of handlers.get(name) ?? []) await handler(...args); },
  };
}

async function renameHarness({ onPrepared = null, listHostChats = null, initializeBranch = async () => {}, persist = null, isEnabled = true, ...backendOptions } = {}) {
  const backend = backendHarness(backendOptions);
  backend.records.set(bindingKey(OLD), readyBinding(OLD, '旧聊天'));
  backend.records.set(`chat-${OLD}/v3-root`, { revision: 14, data: { marker: '原有完整 root' } });
  const context = hostContext();
  const coordinator = createChatIdentityCoordinator({ client: backend.client, listHostChats, initializeBranch, ...(persist ? { persist } : {}), now: () => new Date(NOW) });
  const session = createChatSession({ contextProvider: () => context, isEnabled, identityCoordinator: coordinator });
  assert.equal((await session.prepare()).identity.chatId, OLD);
  const events = eventHarness();
  const warnings = [];
  const lifecycle = createPluginLifecycle({ session, isEnabled, getUi: () => null, onPrepared, logger: { warn: (...args) => warnings.push(args) } });
  lifecycle.bind({ eventSource: events.eventSource, eventTypes: { CHAT_CHANGED: 'changed', CHAT_RENAMED: 'renamed', CHARACTER_RENAMED: 'character-renamed', PERSONA_CHANGED: 'persona' } });
  return { backend, context, coordinator, session, events, lifecycle, warnings };
}

test('角色卡改名迁移该角色全部 binding，当前与未打开聊天保持原 UUID', async () => {
  const SECOND = '22222222-2222-4222-8222-222222222222';
  const PREPARING = '33333333-3333-4333-8333-333333333333';
  const OTHER = '44444444-4444-4444-8444-444444444444';
  const h = await renameHarness();
  h.backend.records.set(bindingKey(SECOND), readyBinding(SECOND, '未打开聊天', { personaLocator: 'other-persona.png' }));
  h.backend.records.set(bindingKey(PREPARING), readyBinding(PREPARING, '准备中的副本', { state: 'preparing', sourceChatId: OLD }));
  h.backend.records.set(bindingKey(OTHER), readyBinding(OTHER, '其它角色聊天', { characterLocator: 'other-character.png' }));
  const otherBefore = structuredClone(h.backend.records.get(bindingKey(OTHER)));
  const secondBefore = structuredClone(h.backend.records.get(bindingKey(SECOND)).data);
  const preparingBefore = structuredClone(h.backend.records.get(bindingKey(PREPARING)).data);

  const migrated = await h.events.handlers.get('character-renamed')[0]('char.png', 'renamed-character.png');
  assert.deepEqual(migrated, { status: 'migrated', migratedCount: 3, skippedCount: 0 });
  for (const id of [OLD, SECOND, PREPARING]) {
    assert.equal(h.backend.records.get(bindingKey(id)).data.chatId, id);
    assert.equal(h.backend.records.get(bindingKey(id)).data.owner.characterLocator, 'renamed-character.png');
  }
  assert.deepEqual(h.backend.records.get(bindingKey(SECOND)).data.owner, { ...secondBefore.owner, characterLocator: 'renamed-character.png' });
  assert.equal(h.backend.records.get(bindingKey(PREPARING)).data.state, preparingBefore.state);
  assert.equal(h.backend.records.get(bindingKey(PREPARING)).data.sourceChatId, preparingBefore.sourceChatId);
  assert.deepEqual(h.backend.records.get(bindingKey(OTHER)), otherBefore, '其它角色 binding 不得改动');
  assert.equal(h.context.chatMetadata.qianqianjie.chatId, OLD, '角色改名事件期间不得派生临时身份');
  assert.equal(h.session.getState().status, 'idle', '角色改名须先使旧身份工作失效');

  h.context.characters[0].avatar = 'renamed-character.png';
  h.events.handlers.get('changed')[0]();
  await waitFor(() => h.session.getState().status === 'ready', '宿主切到新 avatar 后未正常准备');
  assert.equal(h.session.getState().identity.chatId, OLD);
  assert.equal(h.context.chatMetadata.qianqianjie.chatId, OLD);
  assert.deepEqual(h.backend.records.get(`chat-${OLD}/v3-root`).data, { marker: '原有完整 root' });
  assert.deepEqual(await h.coordinator.renameCharacter('char.png', 'renamed-character.png'), { status: 'migrated', migratedCount: 0, skippedCount: 0 }, '重复事件须幂等');
});

test('角色改名 CAS 冲突不覆盖已被其它操作改走的 binding', async () => {
  let backend;
  let injected = false;
  const h = await renameHarness({ beforePut: async ({ data, expectedRevision }) => {
    if (!injected && data?.chatId === OLD && data?.owner?.characterLocator === 'renamed-character.png' && expectedRevision === 1) {
      injected = true;
      backend.records.set(bindingKey(OLD), readyBinding(OLD, '其它赢家', { revision: 2, characterLocator: 'third-character.png' }));
    }
  } });
  backend = h.backend;
  const result = await h.coordinator.renameCharacter('char.png', 'renamed-character.png');
  assert.deepEqual(result, { status: 'migrated', migratedCount: 0, skippedCount: 1 });
  assert.equal(h.context.chatMetadata.qianqianjie.chatId, OLD);
  assert.equal(h.backend.records.get(bindingKey(OLD)).data.owner.characterLocator, 'third-character.png');
  assert.equal(h.backend.records.get(bindingKey(OLD)).data.owner.hostChatId, '其它赢家');
});

test('没有 CHAT_RENAMED 时，宿主列表确认旧文件消失后直接沿用原 UUID', async () => {
  const listCalls = [];
  const h = await renameHarness({
    listHostChats: async (avatar, options) => {
      listCalls.push([avatar, options]);
      return ['服务端清洗后的新名字'];
    },
  });
  h.context.chatId = '服务端清洗后的新名字';
  h.lifecycle.onChatChanged();
  await waitFor(() => h.session.getState().status === 'ready', '改名后的身份未完成准备');

  assert.equal(h.session.getState().identity.chatId, OLD);
  assert.equal(h.context.chatMetadata.qianqianjie.chatId, OLD);
  assert.equal(h.context.chatMetadata.qianqianjie.chatId, OLD);
  assert.equal(h.context.chatMetadata.qianqianjie.file.hostChatId, '服务端清洗后的新名字');
  assert.equal([...h.backend.records.values()].filter(row => row.data?.sourceChatId === OLD).length, 0, '不得建立 TEMP binding');
  assert.equal(listCalls.length, 1);
  assert.equal(listCalls[0][0], 'char.png');
  assert.equal(listCalls[0][1].signal instanceof AbortSignal, true);
  assert.deepEqual(h.backend.records.get(`chat-${OLD}/v3-root`).data, { marker: '原有完整 root' });
});

test('prepare 已完成改名时，尾随 CHAT_RENAMED 直接收敛且不重复后台续接', async () => {
  const prepared = [];
  const h = await renameHarness({
    listHostChats: async () => ['服务端清洗后的新名字'],
    onPrepared: ({ result }) => { prepared.push(result.identity.chatId); },
  });
  h.context.chatId = '服务端清洗后的新名字';
  h.lifecycle.onChatChanged();
  await waitFor(() => prepared.length === 1, '改名 prepare 未完成后台续接');

  const result = await h.events.handlers.get('renamed')[0](renameEvent({ newFileName: '用户输入的新名字.jsonl' }));
  assert.ok(['ready', 'ignored'].includes(result.status));
  assert.equal(h.session.identity().chatId, OLD);
  assert.deepEqual(prepared, [OLD], '尾随 rename 不得重复 invalidate/onPrepared');
  assert.equal(h.context.chatMetadata.qianqianjie.chatId, OLD);
  assert.equal(h.warnings.length, 0);
});

test('非当前聊天改名事件静默忽略，之后打开目标仍由列表沿用原 UUID', async () => {
  const OTHER = '22222222-2222-4222-8222-222222222222';
  const h = await renameHarness({ listHostChats: async () => ['新聊天'] });
  h.backend.records.set(bindingKey(OTHER), readyBinding(OTHER, '第三个聊天'));
  h.context.chatId = '第三个聊天';
  h.context.chatMetadata.qianqianjie.chatId = OTHER;
  h.session.invalidate();
  assert.equal((await h.session.prepare()).identity.chatId, OTHER);

  const offscreen = await h.events.handlers.get('renamed')[0](renameEvent({ newFileName: '新聊天.jsonl' }));
  assert.equal(offscreen.status, 'ignored');
  assert.equal(h.context.chatMetadata.qianqianjie.chatId, OTHER);
  assert.equal(h.warnings.length, 0, '非当前 rename 不应误报缺少连续身份凭据');

  h.context.chatId = '新聊天';
  h.context.chatMetadata.qianqianjie.chatId = OLD;
  h.events.handlers.get('changed')[0]();
  await waitFor(() => h.session.getState().status === 'ready', '打开改名目标后身份未准备完成');
  assert.equal(h.session.getState().identity.chatId, OLD);
  assert.equal(h.context.chatMetadata.qianqianjie.chatId, OLD);
  assert.equal([...h.backend.records.values()].filter(row => row.data?.sourceChatId === OLD).length, 0);
});

test('关闭千千结期间改名，重新启用时由宿主列表沿用原 UUID', async () => {
  let enabled = true;
  const h = await renameHarness({
    isEnabled: () => enabled,
    listHostChats: async () => ['新聊天'],
  });
  enabled = false;
  assert.equal((await h.lifecycle.setEnabled(false)).status, 'disabled');
  h.context.chatId = '新聊天';
  assert.equal((await h.lifecycle.onChatRenamed(renameEvent({ newFileName: '新聊天.jsonl' }))).status, 'disabled');

  enabled = true;
  const result = await h.lifecycle.setEnabled(true);
  assert.ok(['ready', 'ignored'].includes(result.status));
  assert.equal(h.session.identity().chatId, OLD);
  assert.equal(h.context.chatMetadata.qianqianjie.chatId, OLD);
  assert.equal(h.context.chatMetadata.qianqianjie.chatId, OLD);
  assert.equal([...h.backend.records.values()].filter(row => row.data?.sourceChatId === OLD).length, 0);
});

test('宿主聊天列表只发送 simple 请求，并优先使用 file_id', async () => {
  const requests = [];
  const controller = new AbortController();
  const listHostChats = createHostChatList({
    headers: () => ({ 'X-CSRF-Token': 'token' }),
    fetchImpl: async (url, options) => {
      requests.push([url, options]);
      return { ok: true, status: 200, async json() {
        return [
          { file_id: '无后缀优先', file_name: '不应使用.jsonl' },
          { file_name: '兜底名字.jsonl' },
        ];
      } };
    },
  });

  assert.deepEqual(await listHostChats('char.png', { signal: controller.signal }), ['无后缀优先', '兜底名字']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], '/api/characters/chats');
  assert.equal(requests[0][1].method, 'POST');
  assert.deepEqual(requests[0][1].headers, { 'X-CSRF-Token': 'token' });
  assert.deepEqual(JSON.parse(requests[0][1].body), { avatar_url: 'char.png', simple: true });
  assert.equal(requests[0][1].signal, controller.signal);

  for (const payload of [{ error: true }, [{}]]) {
    const invalid = createHostChatList({ fetchImpl: async () => ({ ok: true, status: 200, async json() { return payload; } }) });
    await assert.rejects(invalid('char.png'), error => error.code === 'QQJ_HOST_CHAT_LIST_INVALID');
  }
});

const renameEvent = (overrides = {}) => ({
  avatarId: 'char.png', groupId: null, oldFileName: '旧聊天.jsonl', newFileName: '新聊天.jsonl', ...overrides,
});

test('列表确认普通复制后先调用分支初始化器，再把独立 binding 标为 ready', async () => {
  let listCalls = 0;
  const initialized = [];
  const h = await renameHarness({
    listHostChats: async () => { listCalls += 1; return ['旧聊天', '普通复制']; },
    initializeBranch: async options => { initialized.push(options); },
  });
  h.context.chatId = '普通复制';
  h.events.handlers.get('changed')[0]();
  await waitFor(() => h.context.chatMetadata.qianqianjie.chatId !== OLD, '复制身份未建立');
  const cloneId = h.context.chatMetadata.qianqianjie.chatId;
  assert.equal(h.backend.records.get(bindingKey(cloneId)).data.sourceChatId, OLD);
  assert.equal(h.backend.records.get(bindingKey(cloneId)).data.state, 'ready');
  assert.equal(initialized.length, 1);
  assert.equal(initialized[0].sourceChatId, OLD);
  assert.equal(initialized[0].targetChatId, cloneId);
  assert.equal(initialized[0].createdAt, NOW);
  assert.equal(h.backend.records.has(`chat-${cloneId}/v3-root`), false);
  assert.equal(h.backend.records.get(bindingKey(OLD)).data.owner.hostChatId, '旧聊天');
  assert.equal(listCalls, 1, '旧文件仍存在时只查询一次并保留独立副本路径');
});
