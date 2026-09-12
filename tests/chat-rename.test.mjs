import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatIdentityCoordinator, CHAT_IDENTITY_COLLECTION } from '../src/chat-identity.js';
import { createChatSession } from '../src/chat-session.js';
import { createPluginLifecycle } from '../src/plugin-lifecycle.js';

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

async function renameHarness({ onPrepared = null, ...backendOptions } = {}) {
  const backend = backendHarness(backendOptions);
  backend.records.set(bindingKey(OLD), readyBinding(OLD, '旧聊天'));
  backend.records.set(`chat-${OLD}/v3-root`, { revision: 14, data: { marker: '原有完整 root' } });
  const context = hostContext();
  const coordinator = createChatIdentityCoordinator({ client: backend.client, now: () => new Date(NOW) });
  const session = createChatSession({ contextProvider: () => context, identityCoordinator: coordinator });
  assert.equal((await session.prepare()).identity.chatId, OLD);
  const events = eventHarness();
  const warnings = [];
  const lifecycle = createPluginLifecycle({ session, getUi: () => null, onPrepared, logger: { warn: (...args) => warnings.push(args) } });
  lifecycle.bind({ eventSource: events.eventSource, eventTypes: { CHAT_CHANGED: 'changed', CHAT_RENAMED: 'renamed', PERSONA_CHANGED: 'persona' } });
  return { backend, context, coordinator, session, events, lifecycle, warnings };
}

const renameEvent = (overrides = {}) => ({
  avatarId: 'char.png', groupId: null, oldFileName: '旧聊天.jsonl', newFileName: '用户输入的新名字.jsonl', ...overrides,
});

test('CHAT_CHANGED prepare 已完成后，明确 CHAT_RENAMED 收敛回原 UUID/root，刷新仍沿用旧档', async () => {
  const h = await renameHarness();
  h.context.chatId = '服务端清洗后的新名字';
  h.events.handlers.get('changed')[0]();
  await waitFor(() => h.context.chatMetadata.qianqianjie.chatId !== OLD, '改名 reload 的独立 prepare 未完成');
  const temporaryId = h.context.chatMetadata.qianqianjie.chatId;
  assert.equal(h.backend.records.get(bindingKey(temporaryId)).data.sourceChatId, OLD);

  const result = await h.events.emit('renamed', renameEvent());
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
  const h = await renameHarness();
  h.context.chatId = '普通复制';
  h.events.handlers.get('changed')[0]();
  await waitFor(() => h.context.chatMetadata.qianqianjie.chatId !== OLD, '复制身份未建立');
  const cloneId = h.context.chatMetadata.qianqianjie.chatId;
  assert.equal(h.backend.records.get(bindingKey(cloneId)).data.sourceChatId, OLD);
  assert.equal(h.backend.records.has(`chat-${cloneId}/v3-root`), false);
  assert.equal(h.backend.records.get(bindingKey(OLD)).data.owner.hostChatId, '旧聊天');
});

test('错误/迟到 rename 事件及已产生业务记忆的临时档都不会改绑旧档', async t => {
  await t.test('旧文件名不匹配', async () => {
    const h = await renameHarness();
    h.context.chatId = '新聊天';
    h.events.handlers.get('changed')[0]();
    await waitFor(() => h.context.chatMetadata.qianqianjie.chatId !== OLD, '临时身份未建立');
    const temporaryId = h.context.chatMetadata.qianqianjie.chatId;
    const result = await h.events.handlers.get('renamed')[0](renameEvent({ oldFileName: '其它聊天.jsonl' }));
    assert.equal(result.status, 'error');
    assert.equal(h.context.chatMetadata.qianqianjie.chatId, temporaryId);
    assert.equal(h.backend.records.get(bindingKey(OLD)).data.owner.hostChatId, '旧聊天');
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
