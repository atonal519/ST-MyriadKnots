import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatSession } from '../src/chat-session.js';
import { persistTargetChatIdentity, readTargetChat, readTargetChatFile } from '../src/v3/message-floor-anchor.js';
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
    assert.deepEqual(context.chatMetadata.qianqianjie, { schemaVersion: 2, chatId: first.identity.chatId, file: { characterLocator: 'char.png', hostChatId: 'host-chat' } });
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

test('首次身份只读一次实际文件作保存基底，保留宿主字段并仅确认QQJ身份', async () => {
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
      if (reads === 1) {
        saved.header.chat_metadata.otherPlugin.view = 2;
        saved.chat[0].extra.otherPlugin.view = 2;
        saved.chat[0].swipe_info[0].extra.otherPlugin.view = 2;
        raw.chatMetadata.otherPlugin.view = 2;
      }
      if (reads === 2) {
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
    assert.equal(body.chat[0].chat_metadata.otherPlugin.view, 2, '写入基底应包含实际读取后的 header');
    assert.equal(body.chat[1].extra.otherPlugin.view, 2, '写入基底应包含实际读取后的 outer extra');
    assert.equal(body.chat[1].swipe_info[0].extra.otherPlugin.view, 2, '写入基底应包含实际读取后的 swipe_info');
    saved = { header: body.chat[0], chat: body.chat.slice(1) };
    return { ok: true, status: 200 };
  };
  const result = await persistTargetChatIdentity({ coordinates: target, raw, snapshot, chatId,
    fetchImpl });
  assert.equal(result.status, 'persisted');
  assert.equal(reads, 2);
  assert.equal(saves, 1);
  assert.equal(result.header.chat_metadata.qianqianjie.chatId, chatId);
  assert.equal(result.header.chat_metadata.afterSave, 'kept');
  assert.equal(result.chat[0].extra.afterSave, 'kept');
  assert.equal(result.chat[0].swipe_info[0].extra.afterSave, 'kept');
  assert.equal(raw.chatMetadata.otherPlugin.view, 2);
  assert.equal(raw.chatMetadata.qianqianjie.chatId, chatId);
  assert.equal(raw.chatMetadata.integrity, 'latest-integrity');
});

for (const hostName of ['SillyTavern', 'Luker']) test(`首次身份保存保留文件宏开场及页面渲染正文：${hostName}`, async () => {
  const chatId = '923e4567-e89b-42d3-a456-426614174000';
  const target = { hostChatId: '宏开场', characterLocator: 'char.png', characterName: '角色', avatarUrl: 'char.png', requestHeaders: {} };
  const storedMessage = { is_user: false, is_system: false, name: '角色', mes: '你好，{{user}}。', extra: { otherPlugin: { file: '保留' } } };
  const raw = { characterId: 0, chatId: target.hostChatId, characters: [{ name: '角色', avatar: 'char.png' }], userAvatar: 'me.png',
    chat: [{ ...structuredClone(storedMessage), mes: '你好，测试用户。', extra: { otherPlugin: { live: '保留' } } }],
    chatMetadata: { otherPlugin: { live: '保留' } },
    async saveMetadata() { assert.fail('首次身份应保存固定文件'); },
    ...(hostName === 'Luker' ? { async saveChatMetadata() { assert.fail('首次身份应保存固定文件'); } } : {}),
  };
  let file = { header: { chat_metadata: { otherPlugin: { file: '保留' } } }, chat: [structuredClone(storedMessage)] };
  let reads = 0, saves = 0, captures = 0;
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.file_name, target.hostChatId);
    assert.equal(body.avatar_url, target.avatarUrl);
    if (url === '/api/chats/get') {
      reads += 1;
      return { ok: true, status: 200, async json() { return [structuredClone(file.header), ...structuredClone(file.chat)]; } };
    }
    assert.equal(url, '/api/chats/save');
    assert.equal(body.force, false);
    saves += 1;
    file = { header: body.chat[0], chat: body.chat.slice(1) };
    file.header.chat_metadata.integrity = 'macro-integrity';
    return { ok: true, status: 200 };
  };
  const backend = recordBackend();
  const coordinator = createChatIdentityCoordinator({ client: backend.client, freshUuid: () => chatId,
    readTargetFile: () => readTargetChatFile(target, { fetchImpl }),
    persist: (context, id, snapshot) => persistTargetChatIdentity({ coordinates: target, raw: context, snapshot, chatId: id, fetchImpl }),
  });
  const session = createChatSession({ contextProvider: () => raw, identityCoordinator: coordinator,
    captureTaskInputs: () => { captures += 1; return { target, chat: structuredClone(raw.chat), chatMetadata: structuredClone(raw.chatMetadata) }; },
  });
  assert.equal((await session.prepare()).identity.chatId, chatId);
  assert.equal(session.identity().chatId, chatId);
  assert.deepEqual(file.chat, [storedMessage]);
  assert.deepEqual(file.header.chat_metadata.otherPlugin, { file: '保留' });
  assert.deepEqual(file.header.chat_metadata.qianqianjie, { schemaVersion: 2, chatId, file: { characterLocator: 'char.png', hostChatId: '宏开场' } });
  assert.deepEqual(raw.chat, [{ ...storedMessage, mes: '你好，测试用户。', extra: { otherPlugin: { live: '保留' } } }]);
  assert.deepEqual(raw.chatMetadata, { otherPlugin: { live: '保留' }, qianqianjie: file.header.chat_metadata.qianqianjie, integrity: 'macro-integrity' });
  assert.equal((await session.prepare()).identity.chatId, chatId);
  assert.equal(reads, 2); assert.equal(saves, 1); assert.equal(captures, 1);
  assert.deepEqual(backend.calls, { get: 0, put: 0 });
});

test('首次身份保存跟随宿主正文和回复选择，仅拒绝QQJ身份不符或实际保存失败', async () => {
  for (const change of ['body', 'selectedReply', 'identity', 'noop', 'qqjFile', 'http']) {
    const chatId = '623e4567-e89b-42d3-a456-426614174000';
    const target = { hostChatId: `目标-${change}`, characterLocator: 'char.png', characterName: '角色', avatarUrl: 'char.png', requestHeaders: {} };
    const message = { is_user: false, mes: '原正文', swipes: ['原正文', '另一条'], swipe_id: 0, extra: { other: true } };
    const raw = { chatId: target.hostChatId, chat: [structuredClone(message)], chatMetadata: {} };
    const snapshot = { chat: [structuredClone(message)], chatMetadata: {} };
    let saved = { header: { chat_metadata: {} }, chat: [structuredClone(message)] }, reads = 0, saves = 0;
    const fetchImpl = async (url, options) => {
      if (url === '/api/chats/get') {
        reads++;
        if (reads === 1 && change === 'identity') saved.header.chat_metadata.qianqianjie = { schemaVersion: 2, chatId: '823e4567-e89b-42d3-a456-426614174000' };
        if (change === 'body') saved.chat[0].mes = reads === 1 ? '保存前宿主正文' : '保存后宿主正文';
        if (change === 'selectedReply') { saved.chat[0].swipe_id = 1; saved.chat[0].mes = '另一条'; }
        return { ok: true, json: async () => [structuredClone(saved.header), ...structuredClone(saved.chat)] };
      }
      saves++;
      if (change === 'http') return { ok: false, status: 503 };
      if (change !== 'noop') { const body = JSON.parse(options.body); saved = { header: body.chat[0], chat: body.chat.slice(1) }; }
      if (change === 'qqjFile') delete saved.header.chat_metadata.qianqianjie.file;
      return { ok: true, status: 200 };
    };
    const operation = () => persistTargetChatIdentity({ coordinates: target, raw, snapshot, chatId, fetchImpl });
    if (['identity', 'noop', 'qqjFile', 'http'].includes(change)) {
      await assert.rejects(operation(), { code: change === 'http' ? 'V3_TARGET_CHAT_SAVE_FAILED'
        : change === 'qqjFile' ? 'V3_TARGET_CHAT_VERIFY_FAILED' : 'V3_MESSAGE_ANCHOR_READ_SCOPE_MISMATCH' });
      assert.equal(saves, change === 'identity' ? 0 : 1);
    } else {
      assert.equal((await operation()).persistedIdentity, chatId);
      assert.equal(saved.chat[0].mes, change === 'body' ? '保存后宿主正文' : '另一条');
      assert.equal(saves, 1); assert.equal(reads, 2); assert.equal(saved.chat[0].extra.other, true);
    }
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

  const clone = chatContext('复制聊天', UUID); clone.chatMetadata = structuredClone(source.chatMetadata);
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
  assert.deepEqual(clone.chatMetadata.qianqianjie, { schemaVersion: 2, chatId: prepared.identity.chatId, file: { characterLocator: 'char.png', hostChatId: '复制聊天' } });
  assert.equal(source.chatMetadata.qianqianjie.chatId, UUID);
  assert.equal(backend.records.has(`${CHAT_IDENTITY_COLLECTION}/binding-${UUID}`), false, '普通源档不再认领目录');
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

test('旧档已有ID不被陈旧preparing辅助目录改编号', async () => {
  const backend = recordBackend(), context = chatContext('复制聊天');
  backend.records.set(`${CHAT_IDENTITY_COLLECTION}/binding-${UUID}`, { revision: 1, data: { schemaVersion: 1, kind: 'qqj-chat-identity-binding', chatId: UUID,
    owner: { hostChatId: context.chatId, characterLocator: 'char.png', personaLocator: 'me.png' }, state: 'preparing', sourceChatId: '223e4567-e89b-42d3-a456-426614174000', createdAt: '2026-09-04', updatedAt: '2026-09-04' } });
  const session = createChatSession({ contextProvider: () => context, identityCoordinator: createChatIdentityCoordinator({ client: backend.client }) });
  assert.equal((await session.prepare()).identity.chatId, UUID); assert.equal(session.identity().chatId, UUID);
  assert.equal(backend.calls.put, 0);
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
    identityCoordinator: { prepare: async (_raw, host, { getTaskInputs }) => {
      const taskInputs = getTaskInputs();
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
    identityCoordinator: { async prepare(_raw, _host, { getTaskInputs }) { captured = getTaskInputs(); return UUID; } },
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
    identityCoordinator: { async prepare(_raw, _host, { getTaskInputs }) { getTaskInputs(); identityCalls += 1; return UUID; } },
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

test('文件身份：归属匹配的普通准备零目录零整chat捕获，角色改名保ID', async () => {
  for (const renamed of [false, true]) {
    const backend = recordBackend(), raw = chatContext('已存聊天'); raw.chat = [{ is_user: false, mes: '原正文' }];
    raw.chatMetadata.qianqianjie = { schemaVersion: 2, chatId: UUID, file: { characterLocator: renamed ? 'old-char.png' : 'char.png', hostChatId: raw.chatId } };
    let captures = 0, saves = 0, reads = 0;
    raw.saveMetadata = async () => { saves++; };
    const coordinator = createChatIdentityCoordinator({ client: backend.client, readTargetFile: async () => { reads++; assert.fail('普通文件无需全文首读'); } });
    const session = createChatSession({ contextProvider: () => raw, identityCoordinator: coordinator, captureTaskInputs: () => { captures++; throw new Error('普通打开不应复制全chat'); } });
    const result = await session.prepare();
    assert.equal(result.identity.chatId, UUID); assert.equal(session.identity().chatId, UUID);
    assert.deepEqual(backend.calls, { get: 0, put: 0 }); assert.equal(captures, 0); assert.equal(reads, 0); assert.equal(saves, 0);
    assert.deepEqual(raw.chatMetadata.qianqianjie.file, { characterLocator: 'char.png', hostChatId: raw.chatId });
  }
});

test('文件身份：旧档目录缺失或故障不否决已存ID，仅用宿主metadata补归属', async () => {
  for (const unavailable of [false, true]) {
    const backend = recordBackend(), raw = chatContext('旧档'); raw.chatMetadata.qianqianjie.schemaVersion = 2;
    backend.records.set(`chat-${UUID}/v3-root`, { revision: 7, data: { manual: '旧人工资料' } });
    if (unavailable) backend.client.get = async () => { backend.calls.get++; throw new Error('辅助目录离线'); };
    let captures = 0, saves = 0; raw.saveMetadata = async () => { saves++; };
    const session = createChatSession({ contextProvider: () => raw, identityCoordinator: createChatIdentityCoordinator({ client: backend.client }), captureTaskInputs: () => { captures++; assert.fail('旧档补file不复制全文'); } });
    assert.equal((await session.prepare()).identity.chatId, UUID); assert.equal(session.identity().chatId, UUID);
    assert.equal(backend.calls.put, 0); assert.equal(backend.calls.get, 1); assert.equal(captures, 0); assert.equal(saves, 0);
    assert.equal(backend.records.get(`chat-${UUID}/v3-root`).revision, 7);
  }
});

test('文件身份：缺失及643/schema1派生capture以固定文件473为准，不先造ready绑定', async () => {
  const storedId = '47383391-1111-4111-8111-111111111111', staleId = '64334d9f-1111-4111-8111-111111111111';
  for (const stale of [false, true]) {
    const backend = recordBackend(), raw = chatContext('葬礼'); raw.chat = [{ is_user: false, mes: '选中文件正文' }];
    raw.chatMetadata.qianqianjie = stale ? { schemaVersion: 1, chatId: staleId } : undefined;
    let reads = 0, captures = 0;
    const file = { header: { chat_metadata: { qianqianjie: { schemaVersion: 2, chatId: storedId, file: { characterLocator: 'char.png', hostChatId: raw.chatId } } } }, chat: structuredClone(raw.chat) };
    const coordinator = createChatIdentityCoordinator({ client: backend.client, readTargetFile: async (context, host) => { reads++; assert.equal(host.hostChatId, '葬礼'); return file; } });
    const session = createChatSession({ contextProvider: () => raw, identityCoordinator: coordinator, captureTaskInputs: () => { captures++; return { chat: structuredClone(raw.chat), chatMetadata: JSON.parse(JSON.stringify(raw.chatMetadata)) }; } });
    assert.equal((await session.prepare()).identity.chatId, storedId); assert.equal(session.identity().chatId, storedId);
    assert.equal(raw.chatMetadata.qianqianjie.chatId, storedId); assert.equal(reads, 1); assert.equal(captures, 0); assert.deepEqual(backend.calls, { get: 0, put: 0 });
  }
});

test('文件身份：改名从头沿用ID，新分支才惰性捕获并继承', async () => {
  for (const fork of [false, true]) {
    const backend = recordBackend(), raw = chatContext('新文件'); raw.chat = [];
    raw.chatMetadata.qianqianjie = { schemaVersion: 2, chatId: UUID, file: { characterLocator: 'char.png', hostChatId: '原文件' } };
    let captures = 0, inherited = 0, saves = 0; raw.saveMetadata = async () => { saves++; };
    const coordinator = createChatIdentityCoordinator({ client: backend.client, listHostChats: async () => fork ? ['原文件', '新文件'] : ['新文件'], initializeBranch: async ({ sourceChatId }) => { inherited++; assert.equal(sourceChatId, UUID); } });
    const session = createChatSession({ contextProvider: () => raw, identityCoordinator: coordinator, captureTaskInputs: () => { captures++; return { chat: [], chatMetadata: structuredClone(raw.chatMetadata) }; } });
    const result = await session.prepare(); assert.equal(session.identity().chatId, result.identity.chatId);
    assert.equal(inherited, fork ? 1 : 0); assert.equal(captures, fork ? 1 : 0); assert.equal(saves, fork ? 1 : 0);
    assert.equal(result.identity.chatId === UUID, !fork); assert.deepEqual(raw.chatMetadata.qianqianjie.file, { characterLocator: 'char.png', hostChatId: '新文件' });
  }
});


test('文件身份：固定首读走真实session coordinator persist链，旧643读取473先决冲突被消除', async () => {
  const storedId = '47383391-1111-4111-8111-111111111111', staleId = '64334d9f-1111-4111-8111-111111111111';
  const backend = recordBackend(), raw = chatContext('葬礼', staleId); raw.chat = [{ is_user: false, is_system: false, mes: '选中文件正文' }];
  const target = { hostChatId: raw.chatId, characterLocator: 'char.png', characterName: '角色', avatarUrl: 'char.png' };
  const file = { header: { chat_metadata: { qianqianjie: { schemaVersion: 2, chatId: storedId, file: { characterLocator: 'char.png', hostChatId: raw.chatId } } } }, chat: structuredClone(raw.chat) };
  let reads = 0, writes = 0, captures = 0;
  const fetchImpl = async url => { assert.equal(url, '/api/chats/get'); reads++; return { ok: true, json: async () => [structuredClone(file.header), ...structuredClone(file.chat)] }; };
  const coordinator = createChatIdentityCoordinator({ client: backend.client, freshUuid: () => staleId,
    readTargetFile: () => readTargetChatFile(target, { fetchImpl, readPhase: 'identityBeforeSave' }),
    persist: (context, chatId, snapshot) => { writes++; return persistTargetChatIdentity({ coordinates: target, raw: context, snapshot, chatId, fetchImpl }); } });
  const session = createChatSession({ contextProvider: () => raw, identityCoordinator: coordinator, captureTaskInputs: () => { captures++; return { target, chat: structuredClone(raw.chat), chatMetadata: structuredClone(raw.chatMetadata) }; } });
  let result;
  try { result = await session.prepare({ entryPoint: 'memoryManagement' }); }
  catch (error) { console.log(JSON.stringify({ identityBeforeSaveRed: { code: error.code, diagnostic: error.identityRead, backendCalls: backend.calls, reads, persistCalls: writes, captures } })); throw error; }
  assert.equal(result.identity.chatId, storedId); assert.equal(session.identity().chatId, storedId);
  assert.equal(reads, 1); assert.equal(writes, 0); assert.equal(captures, 0); assert.deepEqual(backend.calls, { get: 0, put: 0 });
});

test('文件身份：分支判定列表读取失败保持父归属并准确报错', async () => {
  const raw = chatContext('新分支'); raw.chatMetadata.qianqianjie = { schemaVersion: 2, chatId: UUID, file: { characterLocator: 'char.png', hostChatId: '父文件' } };
  const before = structuredClone(raw.chatMetadata);
  const session = createChatSession({ contextProvider: () => raw, identityCoordinator: createChatIdentityCoordinator({ client: recordBackend().client,
    listHostChats: async () => { throw Object.assign(new Error('宿主列表读取失败'), { code: 'QQJ_HOST_CHAT_LIST_FAILED' }); } }) });
  await assert.rejects(session.prepare(), { code: 'QQJ_HOST_CHAT_LIST_FAILED' });
  assert.deepEqual(raw.chatMetadata, before);
});

test('文件身份：分支必要首读已是当前文件独立ID时直接采用，不先写辅助preparing', async () => {
  const backend = recordBackend(), raw = chatContext('当前文件');
  raw.chatMetadata.qianqianjie = { schemaVersion: 2, chatId: UUID, file: { characterLocator: 'char.png', hostChatId: '旧父文件' } };
  let reads = 0, captures = 0, inherits = 0;
  const file = { header: { chat_metadata: { qianqianjie: { schemaVersion: 2, chatId: '47383391-1111-4111-8111-111111111111', file: { characterLocator: 'char.png', hostChatId: raw.chatId } } } }, chat: [] };
  const coordinator = createChatIdentityCoordinator({ client: backend.client, listHostChats: async () => ['旧父文件', raw.chatId],
    readTargetFile: async () => { reads++; return file; }, initializeBranch: async () => { inherits++; throw new Error('固定文件已有独立身份'); } });
  const session = createChatSession({ contextProvider: () => raw, identityCoordinator: coordinator, captureTaskInputs: () => { captures++; return { chat: [], chatMetadata: structuredClone(raw.chatMetadata) }; } });
  assert.equal((await session.prepare()).identity.chatId, file.header.chat_metadata.qianqianjie.chatId);
  assert.equal(session.identity().chatId, file.header.chat_metadata.qianqianjie.chatId);
  assert.equal(reads, 1); assert.equal(captures, 0); assert.equal(inherits, 0); assert.deepEqual(backend.calls, { get: 0, put: 0 });
});


test('文件身份：原生归属补记随正常保存，Luker独立metadata保存且不碰聊天数组', async () => {
  const costs = [];
  for (const luker of [false, true]) {
    const raw = chatContext('旧大聊天'); raw.chatMetadata.qianqianjie.schemaVersion = 2;
    raw.chatMetadata.otherPlugin = { transient: () => 'keep', bigint: 1n };
    Object.defineProperty(raw, 'chat', { get() { assert.fail('普通读取不访问整聊天数组'); } });
    let fullSaves = 0, metadataSaves = 0, captures = 0;
    raw.saveMetadata = async () => { fullSaves++; };
    if (luker) raw.saveChatMetadata = async () => { metadataSaves++; return true; };
    const backend = recordBackend(), createSession = () => createChatSession({ contextProvider: () => raw,
      identityCoordinator: createChatIdentityCoordinator({ client: backend.client }), captureTaskInputs: () => { captures++; assert.fail('普通读取不clone'); } });
    await createSession().prepare(); assert.equal(fullSaves, 0); assert.equal(metadataSaves, luker ? 1 : 0); assert.equal(captures, 0);
    assert.equal(backend.calls.get, 1); assert.equal(backend.calls.put, 0);
    await createSession().prepare(); assert.equal(backend.calls.get, 1); assert.equal(metadataSaves, luker ? 1 : 0);
    costs.push({ host: luker ? 'Luker' : 'SillyTavern', firstLegacyBindingGet: 1, bindingPut: 0, chatGet: 0, fullCaptures: captures, metadataOnlySaves: metadataSaves, fullSaves, reopenBindingIo: 0 });
  }
  console.log(JSON.stringify({ ordinaryFileIdentityCosts: costs }));
});
