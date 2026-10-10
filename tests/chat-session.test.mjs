import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatSession } from '../src/chat-session.js';
import { persistTargetChatIdentity } from '../src/v3/message-floor-anchor.js';
import { CHAT_IDENTITY_COLLECTION, createChatIdentityCoordinator } from '../src/chat-identity.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('新聊天只持久化稳定 chatId，不读取或写入任何 V1/后端记录', async () => {
  let saves = 0;
  const context = {
    characterId: 0,
    chatId: 'host-chat',
    characters: [{ avatar: 'char.png' }],
    userAvatar: 'me.png',
    chatMetadata: {},
    async saveMetadata() { saves += 1; },
  };
  const session = createChatSession({ contextProvider: () => context });
    const first = await session.prepare();
    assert.equal(first.status, 'ready');
    assert.match(first.identity.chatId, UUID_PATTERN);
    assert.deepEqual(context.chatMetadata.qianqianjie, { schemaVersion: 2, chatId: first.identity.chatId });
    assert.equal(saves, 1);
    assert.equal((await session.prepare()).identity.chatId, first.identity.chatId);
    assert.equal(saves, 1);
    assert.deepEqual(Object.keys(context.chatMetadata), ['qianqianjie']);
});

test('首次身份保存兼容宿主 new_chat 读回，固定目标创建空聊天存档', async () => {
  const chatId = '323e4567-e89b-42d3-a456-426614174000';
  const target = { hostChatId: '新聊天', characterLocator: 'char.png', characterName: '角色', avatarUrl: 'char.png', requestHeaders: {} };
  const raw = { chatId: '新聊天', chat: [], chatMetadata: {}, saveChatMetadata() { assert.fail('不得回落到动态当前聊天保存'); } };
  const snapshot = { chat: [], chatMetadata: {} };
  let saved = null, reads = 0, lists = 0;
  const fetchImpl = async (url, options) => {
    if (url === '/api/chats/get') {
      reads += 1;
      return saved ? { ok: true, status: 200, async json() { return [structuredClone(saved.header), ...structuredClone(saved.chat)]; } }
        : { ok: true, status: 200, async json() { return { new_chat: true }; } };
    }
    assert.equal(url, '/api/chats/save');
    const body = JSON.parse(options.body);
    assert.equal(body.force, false);
    const [header, ...chat] = body.chat;
    header.chat_metadata.integrity = 'created-integrity';
    saved = { header, chat };
    return { ok: true, status: 200, async json() { return { ok: true, integrity: 'created-integrity' }; } };
  };
  const result = await persistTargetChatIdentity({ coordinates: target, raw, snapshot, chatId,
    listHostChats: async () => { lists += 1; return []; }, fetchImpl });
  assert.equal(result.status, 'persisted');
  assert.equal(result.persistedIdentity, chatId);
  assert.equal(reads, 2);
  assert.equal(lists, 1);
  assert.equal(saved.header.chat_metadata.qianqianjie.chatId, chatId);
  assert.deepEqual(saved.chat, [], 'USER0/空新档创建不要求有开场消息');
  assert.equal(raw.chatMetadata.qianqianjie.chatId, chatId);
  assert.equal(raw.chatMetadata.integrity, 'created-integrity');

  saved = null;
  const userZeroId = '423e4567-e89b-42d3-a456-426614174000';
  const userZero = { is_user: true, is_system: false, mes: 'USER0', send_date: '2026-10-10T00:00:00.000Z' };
  const userZeroRaw = { chatId: 'USER0聊天', chat: [userZero], chatMetadata: {} };
  const userZeroResult = await persistTargetChatIdentity({
    coordinates: { ...target, hostChatId: 'USER0聊天' }, raw: userZeroRaw,
    snapshot: { chat: [userZero], chatMetadata: {} }, chatId: userZeroId,
    listHostChats: async () => { lists += 1; return []; }, fetchImpl,
  });
  assert.equal(userZeroResult.persistedIdentity, userZeroId);
  assert.deepEqual(saved.chat, [userZero], 'USER0 首条消息须原样保留');
  assert.equal(saved.header.chat_metadata.qianqianjie.chatId, userZeroId);
  assert.equal(reads, 4);
  assert.equal(lists, 2);
});

function recordBackend() {
  const records = new Map();
  const calls = { get: 0, put: 0 };
  const failure = status => Object.assign(new Error(`HTTP ${status}`), { status });
  return { records, calls, client: {
    async get(collection, key) { calls.get += 1; const value = records.get(`${collection}/${key}`); if (!value) throw failure(404); return { revision: value.revision, data: structuredClone(value.data) }; },
    async put(collection, key, data, expectedRevision) { calls.put += 1; const mapKey = `${collection}/${key}`, previous = records.get(mapKey); if ((previous?.revision ?? 0) !== expectedRevision) throw failure(409); const revision = (previous?.revision ?? 0) + 1; records.set(mapKey, { revision, data: structuredClone(data) }); return { revision, data: structuredClone(data) }; },
  } };
}

function chatContext(hostChatId, chatId = UUID) {
  return { characterId: 0, chatId: hostChatId, characters: [{ avatar: 'char.png', name: '角色' }], userAvatar: 'me.png', chatMetadata: { qianqianjie: { schemaVersion: 1, chatId } }, async saveMetadata() {} };
}

test('同一 QQJ chatId 被复制到不同宿主聊天后直接获得独立 ready 身份', async () => {
  const backend = recordBackend();
  let listCalls = 0;
  let initializeCalls = 0;
  const listHostChats = async () => { listCalls += 1; return ['原聊天', '复制聊天']; };
  const source = chatContext('原聊天');
  const sourceCoordinator = createChatIdentityCoordinator({ client: backend.client, now: () => new Date('2026-09-04T00:00:00.000Z') });
  const sourceSession = createChatSession({ contextProvider: () => source, identityCoordinator: sourceCoordinator });
  assert.equal((await sourceSession.prepare()).identity.chatId, UUID);
  const reopenedSource = createChatSession({
    contextProvider: () => source,
    identityCoordinator: createChatIdentityCoordinator({ client: backend.client, now: () => new Date('2026-09-05T00:00:00.000Z') }),
  });
  assert.equal((await reopenedSource.prepare()).identity.chatId, UUID, '已正式绑定的同 owner ready 聊天必须沿用原 ID');

  const clone = chatContext('复制聊天', UUID);
  const cloneCoordinator = createChatIdentityCoordinator({
    client: backend.client,
    listHostChats,
    initializeBranch: async () => { initializeCalls += 1; },
    now: () => new Date('2026-09-04T00:00:00.000Z'),
  });
  const cloneSession = createChatSession({ contextProvider: () => clone, identityCoordinator: cloneCoordinator });
  const prepared = await cloneSession.prepare();
  assert.equal(prepared.status, 'ready');
  assert.notEqual(prepared.identity.chatId, UUID);
  assert.deepEqual(clone.chatMetadata.qianqianjie, { schemaVersion: 2, chatId: prepared.identity.chatId });
  assert.equal(backend.records.get(`${CHAT_IDENTITY_COLLECTION}/binding-${UUID}`).data.owner.hostChatId, '原聊天');
  assert.deepEqual(backend.records.get(`${CHAT_IDENTITY_COLLECTION}/binding-${prepared.identity.chatId}`).data, {
    schemaVersion: 1,
    kind: 'qqj-chat-identity-binding',
    chatId: prepared.identity.chatId,
    owner: { hostChatId: '复制聊天', characterLocator: 'char.png', personaLocator: 'me.png' },
    state: 'ready',
    sourceChatId: UUID,
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
  });
  const callsAfterReady = { ...backend.calls };
  assert.equal((await cloneSession.prepare()).identity.chatId, prepared.identity.chatId);
  assert.deepEqual(backend.calls, callsAfterReady, '同宿主 ready session 应内存返回，不再 PUT 0 / 409 / GET');
  assert.equal(listCalls, 1, '只有首次判定宿主复制时读取列表');
  assert.equal(initializeCalls, 1, '确认是同角色副本后只初始化一次继承数据');

  const reopenedClone = createChatSession({
    contextProvider: () => clone,
    identityCoordinator: createChatIdentityCoordinator({
      client: backend.client,
      listHostChats: async () => { throw new Error('已独立分支不得再关联原档状态'); },
      now: () => new Date('2026-09-05T00:00:00.000Z'),
    }),
  });
  assert.equal((await reopenedClone.prepare()).identity.chatId, prepared.identity.chatId, '独立 binding 建立后即使原档删除也保持当前身份');
});

test('旧 preparing 认领不复用已搬入的 root，当前宿主改领无继承的新身份', async () => {
  const backend = recordBackend();
  let listCalls = 0;
  const oldBinding = {
    schemaVersion: 1,
    kind: 'qqj-chat-identity-binding',
    chatId: UUID,
    owner: { hostChatId: '复制聊天', characterLocator: 'char.png', personaLocator: 'me.png' },
    state: 'preparing',
    sourceChatId: '223e4567-e89b-42d3-a456-426614174000',
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
  };
  backend.records.set(`${CHAT_IDENTITY_COLLECTION}/binding-${UUID}`, { revision: 1, data: structuredClone(oldBinding) });
  backend.records.set(`chat-${UUID}/v3-root`, { revision: 1, data: { copied: true } });
  const clone = chatContext('复制聊天', UUID);
  const coordinator = createChatIdentityCoordinator({ client: backend.client, listHostChats: async () => { listCalls += 1; return []; }, now: () => new Date('2026-09-05T00:00:00.000Z') });
  const session = createChatSession({ contextProvider: () => clone, identityCoordinator: coordinator });
  const prepared = await session.prepare();
  assert.equal(prepared.status, 'ready');
  assert.notEqual(prepared.identity.chatId, UUID);
  assert.deepEqual(backend.records.get(`${CHAT_IDENTITY_COLLECTION}/binding-${UUID}`).data, oldBinding);
  assert.deepEqual(backend.records.get(`chat-${UUID}/v3-root`).data, { copied: true });
  assert.equal(backend.records.get(`${CHAT_IDENTITY_COLLECTION}/binding-${prepared.identity.chatId}`).data.state, 'ready');
  assert.equal(backend.records.get(`${CHAT_IDENTITY_COLLECTION}/binding-${prepared.identity.chatId}`).data.sourceChatId, UUID);
  assert.equal(backend.records.has(`chat-${prepared.identity.chatId}/v3-root`), false);
  assert.equal(listCalls, 0, 'preparing binding 不得用宿主列表升级成改名');
});

test('同一宿主聊天只切换 persona 不会误判成聊天分支', async () => {
  const backend = recordBackend();
  let listCalls = 0;
  const context = chatContext('同一聊天');
  const coordinator = createChatIdentityCoordinator({ client: backend.client, listHostChats: async () => { listCalls += 1; return []; } });
  const session = createChatSession({ contextProvider: () => context, identityCoordinator: coordinator });
  assert.equal((await session.prepare()).identity.chatId, UUID);
  context.userAvatar = 'another-persona.png';
  session.invalidate();
  assert.equal((await session.prepare()).identity.chatId, UUID);
  assert.equal(listCalls, 0, '只切 Persona 时宿主文件名和角色未变，不读取列表');
});

test('同一在途 prepare 共用一次输入快照，ready 重入不再复制聊天输入', async () => {
  const context = chatContext('固定目标');
  let release;
  let captures = 0;
  const session = createChatSession({
    contextProvider: () => context,
    captureTaskInputs: ({ host }) => { captures += 1; return { hostChatId: host.hostChatId }; },
    identityCoordinator: { prepare: async (_raw, host, { taskInputs }) => {
      assert.equal(taskInputs.hostChatId, host.hostChatId);
      await new Promise(resolve => { release = resolve; });
      return UUID;
    } },
  });
  const first = session.prepare();
  const concurrent = session.prepare();
  assert.equal(first, concurrent);
  assert.equal(captures, 1);
  release();
  assert.equal((await first).identity.chatId, UUID);
  assert.equal((await session.prepare()).identity.chatId, UUID);
  assert.equal(captures, 1);
});

test('禁用时零元数据操作；在途准备完成后仍归捕获聊天身份', async () => {
  let enabled = false;
  let release;
  const firstMetadata = {};
  const context = {
    characterId: 0,
    chatId: 'first',
    characters: [{ avatar: 'char.png' }],
    userAvatar: 'me.png',
    chatMetadata: firstMetadata,
    saveMetadata: () => new Promise(resolve => { release = resolve; }),
  };
  const session = createChatSession({
    contextProvider: () => context,
    isEnabled: () => enabled,
    ensureChatId: async raw => { raw.chatMetadata.qianqianjie = { schemaVersion: 1, chatId: UUID }; await raw.saveMetadata(); return UUID; },
  });
    assert.equal((await session.prepare()).status, 'disabled');
    assert.equal(release, undefined);
    enabled = true;
    const pending = session.prepare();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    context.chatId = 'second';
    context.chatMetadata = { qianqianjie: { schemaVersion: 1, chatId: '223e4567-e89b-42d3-a456-426614174000' } };
    session.invalidate();
    release();
    const result = await pending;
    assert.equal(result.status, 'ready');
    assert.equal(result.identity.hostChatId, 'first');
    assert.equal(result.identity.chatId, UUID);
    assert.equal(firstMetadata.qianqianjie.chatId, UUID);
    assert.equal(context.chatMetadata.qianqianjie.chatId, '223e4567-e89b-42d3-a456-426614174000');
});

test('真正没有当前聊天时保持 idle；群聊与有聊天的身份错误仍然报错', async () => {
  const home = { characterId: undefined, groupId: null, chatId: '', characters: [], userAvatar: '' };
  const session = createChatSession({ contextProvider: () => home });
  assert.deepEqual(await session.prepare(), { status: 'idle' });

  home.characterId = 0;
  home.characters = [{ avatar: 'char.png' }];
  home.userAvatar = 'me.png';
  assert.deepEqual(await session.prepare(), { status: 'idle' }, '已选角色但没有 chatId 也应正常待机');

  home.groupId = 'group-a';
  await assert.rejects(session.prepare(), error => error.code === 'CHAT_SESSION_CONTEXT_INVALID' && /仅支持单人聊天/u.test(error.message));
  home.groupId = null;
  home.chatId = 'host-chat';
  home.characterId = undefined;
  await assert.rejects(session.prepare(), error => error.code === 'CHAT_SESSION_CONTEXT_INVALID' && /仅支持单人聊天/u.test(error.message));
  home.characterId = 0;
  home.userAvatar = '';
  await assert.rejects(session.prepare(), error => error.code === 'CHAT_SESSION_CONTEXT_INVALID' && /Persona/u.test(error.message));
});

test('删除暂停只拦目标 UUID，切到其他聊天可用且回原聊天仍保持暂停', async () => {
  const original = chatContext('原聊天', UUID);
  const otherId = '223e4567-e89b-42d3-a456-426614174000';
  const other = chatContext('其他聊天', otherId);
  let current = original;
  const session = createChatSession({ contextProvider: () => current });
  assert.equal((await session.prepare()).status, 'ready');
  assert.equal(session.suspend(UUID).status, 'suspended');
  await assert.rejects(async () => session.identity(), error => error.code === 'CHAT_SESSION_SUSPENDED');
  current = other;
  session.invalidate();
  assert.equal((await session.prepare()).identity.chatId, otherId);
  assert.equal(session.identity().chatId, otherId);
  current = original;
  session.invalidate();
  assert.equal((await session.prepare()).status, 'suspended');
  await assert.rejects(async () => session.identity(), error => error.code === 'CHAT_SESSION_SUSPENDED');
  assert.equal(session.resume(UUID), true);
  assert.equal((await session.prepare()).identity.chatId, UUID);
});

test('A删除结束恢复时保留已完成准备的B session owner', async () => {
  const original = chatContext('原聊天', UUID);
  const otherId = '223e4567-e89b-42d3-a456-426614174000';
  const other = chatContext('其他聊天', otherId);
  let current = original;
  const session = createChatSession({ contextProvider: () => current });
  assert.equal((await session.prepare()).identity.chatId, UUID);
  session.suspend(UUID);

  current = other;
  session.invalidate();
  assert.equal((await session.prepare()).identity.chatId, otherId);
  assert.equal(session.getState().status, 'ready');
  assert.equal(session.resume(UUID), true);

  assert.equal(session.getState().status, 'ready');
  assert.equal(session.getState().identity.chatId, otherId);
  assert.equal(session.identity().chatId, otherId);
});
