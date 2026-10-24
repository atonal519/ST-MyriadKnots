import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatSession } from '../src/chat-session.js';
import { persistTargetChatIdentity, readTargetChat } from '../src/v3/message-floor-anchor.js';
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

test('身份准备未返回可确认身份时保留错误码并指向状态诊断', async () => {
  const session = createChatSession({
    contextProvider: () => chatContext('新聊天'),
    identityCoordinator: { async prepare() { return null; } },
  });
  await assert.rejects(session.prepare(), error => error.code === 'CHAT_SESSION_PERSIST_FAILED'
    && /到“记忆管理”页点击“复制状态诊断”反馈/u.test(error.message));
});

test('聊天改名后无法确认身份时准确说明聊天改名并保留状态诊断指引', async () => {
  const session = createChatSession({
    contextProvider: () => chatContext('改名中的聊天'),
    captureTaskInputs: () => ({ chat: [], chatMetadata: {} }),
    identityCoordinator: { async prepare() { return UUID; }, async rename() { return null; } },
  });
  await assert.rejects(session.rename({ file_name: '旧聊天' }, null, null), error => error.code === 'CHAT_SESSION_PERSIST_FAILED'
    && /聊天改名后无法确认聊天身份/u.test(error.message)
    && !/角色改名/u.test(error.message)
    && /到“记忆管理”页点击“复制状态诊断”反馈/u.test(error.message));
});

test('首次身份保存兼容宿主 new_chat 读回，固定目标创建空聊天存档', async () => {
  const chatId = '323e4567-e89b-42d3-a456-426614174000';
  const target = { hostChatId: '新聊天', characterLocator: 'char.png', characterName: '角色', avatarUrl: 'char.png', requestHeaders: {} };
  const rawMetadata = { otherPlugin: { label: '保留', transient: () => 'not stored' } };
  const raw = { chatId: '新聊天', chat: [], chatMetadata: rawMetadata, saveChatMetadata() { assert.fail('不得回落到动态当前聊天保存'); } };
  const snapshot = { chat: [], chatMetadata: { otherPlugin: { label: '保留' } } };
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
  assert.deepEqual(saved.header.chat_metadata.otherPlugin, { label: '保留' });
  assert.deepEqual(saved.chat, [], 'USER0/空新档创建不要求有开场消息');
  assert.equal(raw.chatMetadata.qianqianjie.chatId, chatId);
  assert.equal(typeof raw.chatMetadata.otherPlugin.transient, 'function', '宿主 live metadata 不得被快照清洗');
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

test('首次身份保存比较QQJ业务内容，并以第二次读取的宿主数据为保存基底', async () => {
  const chatId = '523e4567-e89b-42d3-a456-426614174000';
  const target = { hostChatId: '正在记录', characterLocator: 'char.png', characterName: '角色', avatarUrl: 'char.png', requestHeaders: {} };
  const message = { is_user: false, is_system: false, name: '角色', mes: 'AI0正文', swipes: ['AI0正文', '另一条回复'], swipe_id: 0,
    extra: { otherPlugin: { view: 0 } }, swipe_info: [{ extra: { otherPlugin: { view: 0 } } }] };
  const raw = { chatId: target.hostChatId, chat: [structuredClone(message)], chatMetadata: { otherPlugin: { view: 0 } } };
  const snapshot = { chat: [structuredClone(message)], chatMetadata: { otherPlugin: { view: 0 } } };
  let saved = { header: { chat_metadata: { otherPlugin: { view: 1 } } }, chat: [structuredClone(message)] };
  let reads = 0, saves = 0;
  const fetchImpl = async (url, options) => {
    if (url === '/api/chats/get') {
      reads += 1;
      if (reads === 2) {
        saved.header.chat_metadata.otherPlugin.view = 2;
        saved.chat[0].extra.otherPlugin.view = 2;
        saved.chat[0].swipe_info[0].extra.otherPlugin.view = 2;
        raw.chatMetadata.otherPlugin.view = 2;
      }
      if (reads === 3) {
        saved.header.chat_metadata.afterSave = 'kept';
        saved.chat[0].extra.afterSave = 'kept';
        saved.chat[0].swipe_info[0].extra.afterSave = 'kept';
        saved.header.chat_metadata.integrity = 'latest-integrity';
      }
      return { ok: true, status: 200, async json() { return [structuredClone(saved.header), ...structuredClone(saved.chat)]; } };
    }
    assert.equal(url, '/api/chats/save');
    saves += 1;
    const body = JSON.parse(options.body);
    assert.equal(body.force, false);
    assert.equal(body.chat[0].chat_metadata.otherPlugin.view, 2, '写入基底应包含第二次读取后的 header');
    assert.equal(body.chat[1].extra.otherPlugin.view, 2, '写入基底应包含第二次读取后的 outer extra');
    assert.equal(body.chat[1].swipe_info[0].extra.otherPlugin.view, 2, '写入基底应包含第二次读取后的 swipe_info');
    saved = { header: body.chat[0], chat: body.chat.slice(1) };
    return { ok: true, status: 200 };
  };
  const result = await persistTargetChatIdentity({ coordinates: target, raw, snapshot, chatId,
    fetchImpl });
  assert.equal(result.status, 'persisted');
  assert.equal(reads, 3);
  assert.equal(saves, 1);
  assert.equal(result.header.chat_metadata.qianqianjie.chatId, chatId);
  assert.equal(result.header.chat_metadata.afterSave, 'kept');
  assert.equal(result.chat[0].extra.afterSave, 'kept');
  assert.equal(result.chat[0].swipe_info[0].extra.afterSave, 'kept');
  assert.equal(raw.chatMetadata.otherPlugin.view, 2);
  assert.equal(raw.chatMetadata.qianqianjie.chatId, chatId);
  assert.equal(raw.chatMetadata.integrity, 'latest-integrity');
});

test('首次身份保存仍拒绝正文、所选回复或QQJ身份归属变化', async () => {
  for (const change of ['body', 'selectedReply', 'identity']) {
    const chatId = '623e4567-e89b-42d3-a456-426614174000';
    const target = { hostChatId: `目标-${change}`, characterLocator: 'char.png', characterName: '角色', avatarUrl: 'char.png', requestHeaders: {} };
    const message = { is_user: false, is_system: false, mes: '原正文', swipes: ['原正文', '另一条'], swipe_id: 0,
      extra: { qianqianjie_floor: { schemaVersion: 1, chatId, floorId: '723e4567-e89b-42d3-a456-426614174000' } } };
    const raw = { chatId: target.hostChatId, chat: [structuredClone(message)], chatMetadata: {} };
    const snapshot = { chat: [structuredClone(message)], chatMetadata: {} };
    let saved = { header: { chat_metadata: {} }, chat: [structuredClone(message)] }, reads = 0, saves = 0;
    const fetchImpl = async url => {
      if (url === '/api/chats/get') {
        reads += 1;
        if (reads === 2) {
          if (change === 'body') saved.chat[0].mes = '编辑后的正文';
          if (change === 'selectedReply') { saved.chat[0].swipe_id = 1; saved.chat[0].mes = '另一条'; }
          if (change === 'identity') saved.header.chat_metadata.qianqianjie = { schemaVersion: 1, chatId: '823e4567-e89b-42d3-a456-426614174000' };
        }
        return { ok: true, status: 200, async json() { return [structuredClone(saved.header), ...structuredClone(saved.chat)]; } };
      }
      saves += 1;
      return { ok: true, status: 200 };
    };
    await assert.rejects(persistTargetChatIdentity({ coordinates: target, raw, snapshot, chatId, fetchImpl }),
      { code: change === 'identity' ? 'V3_MESSAGE_ANCHOR_READ_SCOPE_MISMATCH' : 'V3_TARGET_CHAT_CHANGED' }, change);
    assert.equal(saves, 0, `${change} change must be rejected before save`);
  }
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

test('默认身份快照只序列化可持久化聊天元数据，不阻断其他插件字段', async () => {
  const metadata = { otherPlugin: { label: 'keep', transient: () => 'not persisted' } };
  const context = { ...chatContext('元数据快照'), chat: [], chatMetadata: metadata };
  let captured;
  const session = createChatSession({
    contextProvider: () => context,
    identityCoordinator: { async prepare(_raw, _host, { taskInputs }) { captured = taskInputs; return UUID; } },
  });
  const result = await session.prepare();
  assert.equal(result.status, 'ready');
  assert.deepEqual(captured.chatMetadata, { otherPlugin: { label: 'keep' } });
  assert.equal(metadata.otherPlugin.label, 'keep');
  assert.equal(typeof metadata.otherPlugin.transient, 'function', '捕获不得改写宿主实时元数据');

  let identityCalls = 0;
  const invalid = { ...chatContext('不可保存元数据'), chat: [], chatMetadata: { otherPlugin: { value: 1n } } };
  const invalidSession = createChatSession({
    contextProvider: () => invalid,
    identityCoordinator: { async prepare() { identityCalls += 1; return UUID; } },
  });
  await assert.rejects(invalidSession.prepare(), TypeError, 'JSON合同无法保存的BigInt仍要报告');
  assert.equal(identityCalls, 0, '失败的元数据快照不得创建或持久化身份');
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


test('正常身份准备读回区分缺失与不同，并把受控入口和头部诊断带到会话', async () => {
  const different = '223e4567-e89b-42d3-a456-426614174000';
  const target = { hostChatId: '合成聊天', characterName: '人物', avatarUrl: 'person.png', characterLocator: 'person.png', chatId: UUID, requestHeaders: { Authorization: 'SECRET' } };
  const cases = [
    [null, 'payloadNotArray'], [[], 'headerMissing'], [[{}], 'metadataMissing'],
    [[{ chat_metadata: { otherPlugin: 'SECRET' } }], 'identityMissing'],
    [[{ chat_metadata: { qianqianjie: { schemaVersion: 2, chatId: different }, otherPlugin: 'SECRET' } }, { mes: 'SECRET' }], 'identityDifferent'],
  ];
  for (const [payload, reason] of cases) {
    const session = createChatSession({ contextProvider: () => chatContext('合成聊天'),
      identityCoordinator: { prepare: () => readTargetChat(target, { readPhase: 'identityBeforeSave', fetchImpl: async () => ({ ok: true, json: async () => payload }) }) } });
    await assert.rejects(session.prepare({ entryPoint: 'startup' }), error => {
      assert.equal(error.code, 'V3_MESSAGE_ANCHOR_READ_SCOPE_MISMATCH');
      assert.match(error.message, reason === 'identityDifferent' ? /身份.*不一致/u : /缺少|不完整/u);
      return true;
    });
    const failure = session.getState().preparationFailure;
    assert.equal(failure.entryPoint, 'startup');
    assert.equal(failure.identityRead.reason, reason);
    assert.equal(failure.identityRead.readPhase, 'identityBeforeSave');
    assert.equal(failure.identityRead.target.hostChatId, target.hostChatId);
    assert.equal(failure.identityRead.expectedChatId, UUID);
    assert.equal(failure.identityRead.actualChatId, reason === 'identityDifferent' ? different : null);
    assert.doesNotMatch(JSON.stringify(failure), /SECRET|Authorization|otherPlugin|mes"/u);
  }
  const fetchImpl = async () => ({ ok: true, json: async () => [{ chat_metadata: {} }] });
  assert.equal((await readTargetChat(target, { fetchImpl, allowMissingIdentity: true })).chat.length, 0);
  await assert.rejects(readTargetChat(target, { fetchImpl, allowedChatIds: [different] }), { code: 'V3_MESSAGE_ANCHOR_READ_SCOPE_MISMATCH' });
  const accepted = await readTargetChat(target, { allowedChatIds: [different], fetchImpl: async () => ({ ok: true, json: async () => [{ chat_metadata: { qianqianjie: { chatId: different } } }] }) });
  assert.equal(accepted.header.chat_metadata.qianqianjie.chatId, different);
});
