import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatIdentityCoordinator, CHAT_IDENTITY_COLLECTION } from '../src/chat-identity.js';
import { createChatSession } from '../src/chat-session.js';
import { createPluginLifecycle } from '../src/plugin-lifecycle.js';
import { createHostChatList } from '../src/host-context.js';

const OLD = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-09-07T03:00:00.000Z';
const bindingKey = id => `${CHAT_IDENTITY_COLLECTION}/binding-${id}`;
const failure = status => Object.assign(new Error(`HTTP ${status}`), { status });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
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

function readyBinding(chatId, hostChatId, { sourceChatId = null, revision = 1 } = {}) {
  return {
    revision,
    data: {
      schemaVersion: 1, kind: 'qqj-chat-identity-binding', chatId,
      owner: { hostChatId, characterLocator: 'char.png', personaLocator: 'me.png' },
      state: 'ready', sourceChatId, createdAt: NOW, updatedAt: NOW,
    },
  };
}

function hostContext(hostChatId = '旧聊天') {
  const context = {
    characterId: 0, groupId: null, chatId: hostChatId,
    characters: [{ avatar: 'char.png' }], userAvatar: 'me.png',
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

async function renameHarness({ onPrepared = null, listHostChats = null, isEnabled = true, ...backendOptions } = {}) {
  const backend = backendHarness(backendOptions);
  backend.records.set(bindingKey(OLD), readyBinding(OLD, '旧聊天'));
  backend.records.set(`chat-${OLD}/v3-root`, { revision: 14, data: { marker: '原有完整 root' } });
  const context = hostContext();
  const coordinator = createChatIdentityCoordinator({ client: backend.client, listHostChats, now: () => new Date(NOW) });
  const session = createChatSession({ contextProvider: () => context, isEnabled, identityCoordinator: coordinator });
  assert.equal((await session.prepare()).identity.chatId, OLD);
  const events = eventHarness();
  const warnings = [];
  const lifecycle = createPluginLifecycle({ session, isEnabled, getUi: () => null, onPrepared, logger: { warn: (...args) => warnings.push(args) } });
  lifecycle.bind({ eventSource: events.eventSource, eventTypes: { CHAT_CHANGED: 'changed', CHAT_RENAMED: 'renamed', PERSONA_CHANGED: 'persona' } });
  return { backend, context, coordinator, session, events, lifecycle, warnings };
}

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
  assert.equal(h.backend.records.get(bindingKey(OLD)).revision, 2);
  assert.equal(h.backend.records.get(bindingKey(OLD)).data.owner.hostChatId, '服务端清洗后的新名字');
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
  assert.equal(result.status, 'ready');
  assert.equal(result.identity.chatId, OLD);
  assert.deepEqual(prepared, [OLD], '尾随 rename 不得重复 invalidate/onPrepared');
  assert.equal(h.backend.records.get(bindingKey(OLD)).revision, 2);
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
  assert.equal(h.backend.records.get(bindingKey(OLD)).revision, 2);
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
  assert.equal(result.status, 'ready');
  assert.equal(result.identity.chatId, OLD);
  assert.equal(h.context.chatMetadata.qianqianjie.chatId, OLD);
  assert.equal(h.backend.records.get(bindingKey(OLD)).revision, 2);
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

test('CHAT_CHANGED prepare 已完成后，明确 CHAT_RENAMED 收敛回原 UUID/root，刷新仍沿用旧档', async () => {
  const h = await renameHarness();
  h.context.chatId = '服务端清洗后的新名字';
  h.events.handlers.get('changed')[0]();
  await waitFor(() => h.context.chatMetadata.qianqianjie.chatId !== OLD, '改名 reload 的独立 prepare 未完成');
  const temporaryId = h.context.chatMetadata.qianqianjie.chatId;
  assert.equal(h.backend.records.get(bindingKey(temporaryId)).data.sourceChatId, OLD);

  const result = await h.events.emit('renamed', renameEvent({ newFileName: '服务端清洗后的新名字.jsonl' }));
  assert.equal(result, undefined);
  assert.equal(h.context.chatMetadata.qianqianjie.chatId, OLD);
  assert.equal(h.backend.records.get(bindingKey(OLD)).data.owner.hostChatId, '服务端清洗后的新名字');
  assert.equal(h.backend.records.get(`chat-${OLD}/v3-root`).revision, 14);
  assert.deepEqual(h.backend.records.get(`chat-${OLD}/v3-root`).data, { marker: '原有完整 root' });

  const reopened = createChatSession({
    contextProvider: () => h.context,
    identityCoordinator: createChatIdentityCoordinator({ client: h.backend.client, now: () => new Date(NOW) }),
  });
  assert.equal((await reopened.prepare()).identity.chatId, OLD);
  assert.deepEqual((await h.backend.client.get(`chat-${OLD}`, 'v3-root')).data, { marker: '原有完整 root' });
});

test('临时 binding PUT 已开始时 rename 等其完成，再恢复原身份', async () => {
  const hold = deferred();
  let held = false;
  const h = await renameHarness({ beforePut: async ({ data, expectedRevision }) => {
    if (!held && data?.sourceChatId === OLD && data.chatId !== OLD && expectedRevision === 0) { held = true; await hold.promise; }
  } });
  h.context.chatId = '新聊天';
  h.events.handlers.get('changed')[0]();
  await waitFor(() => held, '临时 binding PUT 未进入');
  const renamed = h.events.handlers.get('renamed')[0](renameEvent());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.context.chatMetadata.qianqianjie.chatId, OLD, '在途 PUT 未完成前不应抢写 metadata');
  hold.resolve();
  assert.equal((await renamed).status, 'ready');
  assert.equal(h.context.chatMetadata.qianqianjie.chatId, OLD);
  assert.equal(h.backend.records.get(bindingKey(OLD)).data.owner.hostChatId, '新聊天');
});

test('临时 metadata save 已开始时 rename 等其完成，迟到写不能覆盖恢复结果', async () => {
  const h = await renameHarness();
  const hold = deferred();
  h.context.saveBlock = hold;
  h.context.chatId = '新聊天';
  h.events.handlers.get('changed')[0]();
  await waitFor(() => h.context.saves === 1, '临时 metadata save 未进入');
  const renamed = h.events.handlers.get('renamed')[0](renameEvent());
  await new Promise(resolve => setImmediate(resolve));
  hold.resolve();
  assert.equal((await renamed).status, 'ready');
  assert.equal(h.context.chatMetadata.qianqianjie.chatId, OLD);
  assert.equal(h.context.saves, 2, '临时身份与恢复身份各完成一次权威 metadata save');
});

test('临时身份的后台记忆读取不阻塞 rename，恢复原身份后只继续当前人物读取', async () => {
  const temporaryMemory = deferred();
  const calls = [];
  const h = await renameHarness({
    onPrepared: async ({ result, isCurrent }) => {
      const id = result.identity.chatId;
      calls.push(`memory:${id}`);
      if (id !== OLD) await temporaryMemory.promise;
      if (isCurrent()) calls.push(`people:${id}`);
    },
  });
  h.context.chatId = '新聊天';
  h.events.handlers.get('changed')[0]();
  await waitFor(() => calls.some(call => call.startsWith('memory:') && call !== `memory:${OLD}`), '临时身份未启动后台记忆读取');
  const temporaryId = h.context.chatMetadata.qianqianjie.chatId;

  const renamed = h.events.handlers.get('renamed')[0](renameEvent());
  let timer;
  const result = await Promise.race([
    renamed,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('rename 被后台记忆读取阻塞')), 1000); }),
  ]).finally(() => clearTimeout(timer));
  assert.equal(result.status, 'ready');
  assert.equal(result.identity.chatId, OLD, '后台回调返回值不得覆盖 rename 的 ready 身份');
  await waitFor(() => calls.includes(`people:${OLD}`), '原身份恢复后未完成当前后台续接');

  temporaryMemory.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.includes(`people:${temporaryId}`), false, '改名后不得继续临时身份的人物读取');
});

test('无 CHAT_RENAMED 的普通复制始终保留独立身份，sourceChatId 不授予旧 root 读取权', async () => {
  let listCalls = 0;
  const h = await renameHarness({ listHostChats: async () => { listCalls += 1; return ['旧聊天', '普通复制']; } });
  h.context.chatId = '普通复制';
  h.events.handlers.get('changed')[0]();
  await waitFor(() => h.context.chatMetadata.qianqianjie.chatId !== OLD, '复制身份未建立');
  const cloneId = h.context.chatMetadata.qianqianjie.chatId;
  assert.equal(h.backend.records.get(bindingKey(cloneId)).data.sourceChatId, OLD);
  assert.equal(h.backend.records.has(`chat-${cloneId}/v3-root`), false);
  assert.equal(h.backend.records.get(bindingKey(OLD)).data.owner.hostChatId, '旧聊天');
  assert.equal(listCalls, 1, '旧文件仍存在时只查询一次并保留独立副本路径');
});

test('当前副本 B 收到旧档 A→C 的迟到改名事件时保持 B 独立，不误回绑 A', async () => {
  const prepared = [];
  const h = await renameHarness({
    listHostChats: async () => ['旧聊天', '副本 B'],
    onPrepared: ({ result }) => { prepared.push(result.identity.chatId); },
  });
  h.context.chatId = '副本 B';
  h.events.handlers.get('changed')[0]();
  await waitFor(() => h.session.getState().status === 'ready' && h.context.chatMetadata.qianqianjie.chatId !== OLD, '副本 B 身份未建立');
  await waitFor(() => prepared.length === 1, '副本 B 后台续接未启动');

  const copyId = h.context.chatMetadata.qianqianjie.chatId;
  const copyBinding = structuredClone(h.backend.records.get(bindingKey(copyId)));
  const oldBinding = structuredClone(h.backend.records.get(bindingKey(OLD)));
  const oldRoot = structuredClone(h.backend.records.get(`chat-${OLD}/v3-root`));
  const callsBefore = h.backend.calls.length;
  const savesBefore = h.context.saves;

  const result = await h.events.handlers.get('renamed')[0](renameEvent({ newFileName: '迟到目标 C.jsonl' }));
  assert.equal(result.status, 'ignored');
  assert.equal(h.session.getState().identity.chatId, copyId);
  assert.equal(h.session.getState().identity.hostChatId, '副本 B');
  assert.equal(h.context.chatMetadata.qianqianjie.chatId, copyId);
  assert.deepEqual(h.backend.records.get(bindingKey(copyId)), copyBinding);
  assert.deepEqual(h.backend.records.get(bindingKey(OLD)), oldBinding);
  assert.deepEqual(h.backend.records.get(`chat-${OLD}/v3-root`), oldRoot);
  assert.equal(h.backend.calls.length, callsBefore, '无关事件不得发起后端请求');
  assert.equal(h.context.saves, savesBefore, '无关事件不得改写 metadata');
  assert.deepEqual(prepared, [copyId], '无关事件不得重复后台续接');
  assert.equal(h.warnings.length, 0);
});

test('列表失败不改 binding/metadata，也不回落创建 TEMP', async () => {
  const h = await renameHarness({ listHostChats: async () => { throw Object.assign(new Error('network down'), { code: 'NETWORK_DOWN' }); } });
  h.context.chatId = '新聊天';
  h.session.invalidate();
  await assert.rejects(h.session.prepare(), error => error.code === 'NETWORK_DOWN');
  assert.equal(h.context.chatMetadata.qianqianjie.chatId, OLD);
  assert.equal(h.backend.records.get(bindingKey(OLD)).revision, 1);
  assert.equal(h.backend.records.get(bindingKey(OLD)).data.owner.hostChatId, '旧聊天');
  assert.equal([...h.backend.records.values()].filter(row => row.data?.sourceChatId === OLD).length, 0);
});

test('列表在途切聊天后旧结果返回 stale，不改旧 binding 或新聊天 metadata', async () => {
  const OTHER = '22222222-2222-4222-8222-222222222222';
  const hold = deferred();
  let listed = false;
  const h = await renameHarness({ listHostChats: async (_avatar, { signal }) => {
    listed = true;
    await hold.promise;
    assert.equal(signal.aborted, true);
    return ['新聊天'];
  } });
  h.backend.records.set(bindingKey(OTHER), readyBinding(OTHER, '其它聊天'));
  h.context.chatId = '新聊天';
  h.session.invalidate();
  const pending = h.session.prepare();
  await waitFor(() => listed, '宿主列表请求未开始');
  h.context.chatId = '其它聊天';
  h.context.chatMetadata.qianqianjie.chatId = OTHER;
  h.session.invalidate();
  hold.resolve();

  assert.equal((await pending).status, 'stale');
  assert.equal(h.context.chatMetadata.qianqianjie.chatId, OTHER);
  assert.equal(h.backend.records.get(bindingKey(OLD)).revision, 1);
  assert.equal(h.backend.records.get(bindingKey(OLD)).data.owner.hostChatId, '旧聊天');
  assert.equal([...h.backend.records.values()].filter(row => row.data?.sourceChatId === OLD).length, 0);
});

test('列表在途禁用后旧结果返回 disabled，不改 binding 或 metadata', async () => {
  let enabled = true;
  const hold = deferred();
  let listed = false;
  const h = await renameHarness({
    isEnabled: () => enabled,
    listHostChats: async (_avatar, { signal }) => {
      listed = true;
      await hold.promise;
      assert.equal(signal.aborted, true);
      return ['新聊天'];
    },
  });
  h.context.chatId = '新聊天';
  h.session.invalidate();
  const pending = h.session.prepare();
  await waitFor(() => listed, '宿主列表请求未开始');
  enabled = false;
  h.session.invalidate();
  hold.resolve();

  assert.equal((await pending).status, 'disabled');
  assert.equal(h.context.chatMetadata.qianqianjie.chatId, OLD);
  assert.equal(h.backend.records.get(bindingKey(OLD)).revision, 1);
  assert.equal(h.backend.records.get(bindingKey(OLD)).data.owner.hostChatId, '旧聊天');
  assert.equal([...h.backend.records.values()].filter(row => row.data?.sourceChatId === OLD).length, 0);
});

test('列表确认改名后的 CAS 冲突不覆盖胜出 binding，也不创建 TEMP', async () => {
  let backend;
  let injected = false;
  const h = await renameHarness({
    listHostChats: async () => ['新聊天'],
    beforePut: async ({ data, expectedRevision }) => {
      if (!injected && data?.chatId === OLD && data?.owner?.hostChatId === '新聊天' && expectedRevision === 1) {
        injected = true;
        backend.records.set(bindingKey(OLD), readyBinding(OLD, '其它赢家', { revision: 2 }));
      }
    },
  });
  backend = h.backend;
  h.context.chatId = '新聊天';
  h.session.invalidate();
  await assert.rejects(h.session.prepare(), error => error.code === 'QQJ_CHAT_RENAME_CONFLICT');
  assert.equal(h.context.chatMetadata.qianqianjie.chatId, OLD);
  assert.equal(h.backend.records.get(bindingKey(OLD)).revision, 2);
  assert.equal(h.backend.records.get(bindingKey(OLD)).data.owner.hostChatId, '其它赢家');
  assert.equal([...h.backend.records.values()].filter(row => row.data?.sourceChatId === OLD).length, 0);
});

test('错误/迟到 rename 事件及已产生业务记忆的临时档都不会改绑旧档', async t => {
  await t.test('旧文件名不匹配', async () => {
    const h = await renameHarness();
    h.context.chatId = '新聊天';
    h.events.handlers.get('changed')[0]();
    await waitFor(() => h.context.chatMetadata.qianqianjie.chatId !== OLD, '临时身份未建立');
    const temporaryId = h.context.chatMetadata.qianqianjie.chatId;
    const result = await h.events.handlers.get('renamed')[0](renameEvent({ oldFileName: '其它聊天.jsonl' }));
    assert.equal(result.status, 'ignored');
    assert.equal(h.context.chatMetadata.qianqianjie.chatId, temporaryId);
    assert.equal(h.backend.records.get(bindingKey(OLD)).data.owner.hostChatId, '旧聊天');
    assert.equal(h.warnings.length, 0);
  });

  await t.test('临时档已有 FloorMemory', async () => {
    const h = await renameHarness();
    h.context.chatId = '新聊天';
    h.events.handlers.get('changed')[0]();
    await waitFor(() => h.context.chatMetadata.qianqianjie.chatId !== OLD, '临时身份未建立');
    const temporaryId = h.context.chatMetadata.qianqianjie.chatId;
    const checkpointId = '22222222-2222-4222-8222-222222222222';
    h.backend.records.set(`chat-${temporaryId}/v3-root`, { revision: 1, data: {
      recordType: 'root', chatId: temporaryId, headCheckpointId: checkpointId,
      baselineId: null, activeRunId: null, activeStateRefs: [], activeThreadRefs: [],
    } });
    h.backend.records.set(`chat-${temporaryId}/v3-checkpoint-${checkpointId}`, { revision: 1, data: {
      recordType: 'checkpoint', id: checkpointId, chatId: temporaryId,
      producedRefs: {
        floors: [], floorMemories: ['memory'], entities: [], events: [], claims: [], knowledge: [],
        stateDeltas: [], currentStates: [], stateProjections: [], episodes: [], threads: [], indexes: [],
      },
    } });
    const result = await h.events.handlers.get('renamed')[0](renameEvent());
    assert.equal(result.status, 'error');
    assert.equal(result.error.code, 'QQJ_CHAT_RENAME_TEMP_HAS_MEMORY');
    assert.equal(h.context.chatMetadata.qianqianjie.chatId, temporaryId);
    assert.equal(h.backend.records.get(bindingKey(OLD)).data.owner.hostChatId, '旧聊天');
  });

  await t.test('旧 binding CAS 已有其它赢家', async () => {
    let backend;
    let injected = false;
    const h = await renameHarness({ beforePut: async ({ data, expectedRevision }) => {
      if (!injected && data?.chatId === OLD && data?.owner?.hostChatId === '新聊天' && expectedRevision === 1) {
        injected = true;
        backend.records.set(bindingKey(OLD), readyBinding(OLD, '其它赢家', { revision: 2 }));
      }
    } });
    backend = h.backend;
    h.context.chatId = '新聊天';
    h.events.handlers.get('changed')[0]();
    await waitFor(() => h.context.chatMetadata.qianqianjie.chatId !== OLD, '临时身份未建立');
    const temporaryId = h.context.chatMetadata.qianqianjie.chatId;
    const result = await h.events.handlers.get('renamed')[0](renameEvent());
    assert.equal(result.status, 'error');
    assert.equal(result.error.code, 'QQJ_CHAT_RENAME_CONFLICT');
    assert.equal(h.context.chatMetadata.qianqianjie.chatId, temporaryId);
    assert.equal(h.backend.records.get(bindingKey(OLD)).data.owner.hostChatId, '其它赢家');
  });
});
