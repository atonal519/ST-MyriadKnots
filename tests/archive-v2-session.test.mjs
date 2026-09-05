import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchiveV2Session } from '../src/archive-v2-session.js';
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
  const session = createArchiveV2Session({ contextProvider: () => context });
    const first = await session.prepare();
    assert.equal(first.status, 'ready');
    assert.match(first.identity.chatId, UUID_PATTERN);
    assert.deepEqual(context.chatMetadata.qianqianjie, { schemaVersion: 2, chatId: first.identity.chatId });
    assert.equal(saves, 1);
    assert.equal((await session.prepare()).identity.chatId, first.identity.chatId);
    assert.equal(saves, 1);
    assert.deepEqual(Object.keys(context.chatMetadata), ['qianqianjie']);
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
  return { characterId: 0, chatId: hostChatId, characters: [{ avatar: 'char.png' }], userAvatar: 'me.png', chatMetadata: { qianqianjie: { schemaVersion: 1, chatId } }, async saveMetadata() {} };
}

test('同一 QQJ chatId 被复制到不同宿主聊天后直接获得独立 ready 身份', async () => {
  const backend = recordBackend();
  const source = chatContext('原聊天');
  const sourceCoordinator = createChatIdentityCoordinator({ client: backend.client, now: () => new Date('2026-09-04T00:00:00.000Z') });
  const sourceSession = createArchiveV2Session({ contextProvider: () => source, identityCoordinator: sourceCoordinator });
  assert.equal((await sourceSession.prepare()).identity.chatId, UUID);
  const reopenedSource = createArchiveV2Session({
    contextProvider: () => source,
    identityCoordinator: createChatIdentityCoordinator({ client: backend.client, now: () => new Date('2026-09-05T00:00:00.000Z') }),
  });
  assert.equal((await reopenedSource.prepare()).identity.chatId, UUID, '已正式绑定的同 owner ready 聊天必须沿用原 ID');

  const clone = chatContext('复制聊天', UUID);
  const cloneCoordinator = createChatIdentityCoordinator({ client: backend.client, now: () => new Date('2026-09-04T00:00:00.000Z') });
  const cloneSession = createArchiveV2Session({ contextProvider: () => clone, identityCoordinator: cloneCoordinator });
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
    sourceChatId: null,
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
  });
  const callsAfterReady = { ...backend.calls };
  assert.equal((await cloneSession.prepare()).identity.chatId, prepared.identity.chatId);
  assert.deepEqual(backend.calls, callsAfterReady, '同宿主 ready session 应内存返回，不再 PUT 0 / 409 / GET');
});

test('旧 preparing 认领不复用已搬入的 root，当前宿主改领无继承的新身份', async () => {
  const backend = recordBackend();
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
  const coordinator = createChatIdentityCoordinator({ client: backend.client, now: () => new Date('2026-09-05T00:00:00.000Z') });
  const session = createArchiveV2Session({ contextProvider: () => clone, identityCoordinator: coordinator });
  const prepared = await session.prepare();
  assert.equal(prepared.status, 'ready');
  assert.notEqual(prepared.identity.chatId, UUID);
  assert.deepEqual(backend.records.get(`${CHAT_IDENTITY_COLLECTION}/binding-${UUID}`).data, oldBinding);
  assert.deepEqual(backend.records.get(`chat-${UUID}/v3-root`).data, { copied: true });
  assert.equal(backend.records.get(`${CHAT_IDENTITY_COLLECTION}/binding-${prepared.identity.chatId}`).data.state, 'ready');
  assert.equal(backend.records.get(`${CHAT_IDENTITY_COLLECTION}/binding-${prepared.identity.chatId}`).data.sourceChatId, null);
  assert.equal(backend.records.has(`chat-${prepared.identity.chatId}/v3-root`), false);
});

test('同一宿主聊天只切换 persona 不会误判成聊天分支', async () => {
  const backend = recordBackend();
  const context = chatContext('同一聊天');
  const coordinator = createChatIdentityCoordinator({ client: backend.client });
  const session = createArchiveV2Session({ contextProvider: () => context, identityCoordinator: coordinator });
  assert.equal((await session.prepare()).identity.chatId, UUID);
  context.userAvatar = 'another-persona.png';
  session.invalidate();
  assert.equal((await session.prepare()).identity.chatId, UUID);
});

test('禁用时零元数据操作；切聊天后旧 prepare 返回 stale', async () => {
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
  const session = createArchiveV2Session({
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
    assert.equal((await pending).status, 'stale');
});
