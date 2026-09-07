import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatMemoryManagement, CHAT_RECALL_RECEIPT_KEY } from '../src/chat-memory-management.js';
import { createChatSession } from '../src/chat-session.js';

const CHAT_ID = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_ID = '223e4567-e89b-42d3-a456-426614174000';

function fixture({ failRemove = null, holdRemove = null, failSaveChat = false, silentSaveChatFailure = false, failSaveMetadata = false, busy = false, autoHideStatus = 'applied' } = {}) {
  const records = new Map([
    [`chat-${CHAT_ID}/floor-a`, { recordId: 'floor-a', revision: 2, data: { kind: 'floor' } }],
    [`chat-${CHAT_ID}/orphan-old`, { recordId: 'orphan-old', revision: 5, data: { kind: 'old-version' } }],
    [`chat-${CHAT_ID}/v3-people-workspace`, { recordId: 'v3-people-workspace', revision: 3, data: { kind: 'workspace' } }],
    [`chat-${CHAT_ID}/v3-root`, { recordId: 'v3-root', revision: 9, data: { kind: 'root' } }],
    [`chat-${OTHER_ID}/v3-root`, { recordId: 'v3-root', revision: 4, data: { kind: 'other' } }],
    [`chat-identity-bindings/binding-${CHAT_ID}`, { recordId: `binding-${CHAT_ID}`, revision: 6, data: { kind: 'binding' } }],
  ]);
  const calls = [], invalidated = [];
  let releaseHeld;
  const held = new Promise(resolve => { releaseHeld = resolve; });
  let removeFailure = failRemove, saveChatFailure = failSaveChat, saveMetadataFailure = failSaveMetadata;
  const client = {
    async list(collection) { calls.push(['list', collection]); return [...records.entries()].filter(([key]) => key.startsWith(`${collection}/`)).map(([, value]) => structuredClone(value)); },
    async get(collection, recordId) { calls.push(['get', collection, recordId]); const value = records.get(`${collection}/${recordId}`); if (!value) throw Object.assign(new Error('missing'), { status: 404 }); return structuredClone(value); },
    async remove(collection, recordId, revision) {
      calls.push(['remove', collection, recordId, revision]);
      if (holdRemove === recordId) { holdRemove = null; await held; }
      if (removeFailure === recordId) { removeFailure = null; throw Object.assign(new Error('conflict'), { status: 409 }); }
      const key = `${collection}/${recordId}`, value = records.get(key);
      if (!value) throw Object.assign(new Error('missing'), { status: 404 });
      if (value.revision !== revision) throw Object.assign(new Error('conflict'), { status: 409 });
      records.delete(key); return { trashId: `${recordId}-${revision}` };
    },
  };
  const receipt = { schemaVersion: 5, marker: 'receipt' };
  const user = { is_user: true, mes: '正文保留', extra: { [CHAT_RECALL_RECEIPT_KEY]: receipt, otherPlugin: { keep: true } } };
  const hidden = { is_user: false, mes: '隐藏正文保留', is_system: true, extra: { qianqianjieAutoHide: { schemaVersion: 1, chatId: CHAT_ID }, other: 1 } };
  let persistedMessages = cloneMessages([user, hidden]);
  let persistedMetadata = { qianqianjie: { schemaVersion: 2, chatId: CHAT_ID }, otherPlugin: { keep: true } };
  const context = {
    chatId: 'host-chat', characterId: 0, characters: [{ name: '角色', avatar: 'char' }], getRequestHeaders: () => ({ 'x-test': 'yes' }), chatMetadata: { qianqianjie: { schemaVersion: 2, chatId: CHAT_ID }, otherPlugin: { keep: true } }, chat: [user, hidden],
    async saveChat() { calls.push(['saveChat']); if (saveChatFailure) { saveChatFailure = false; throw new Error('save chat failed'); } if (silentSaveChatFailure) { silentSaveChatFailure = false; return; } persistedMessages = cloneMessages(context.chat); },
    async saveChatMetadata() { calls.push(['saveMetadata']); if (saveMetadataFailure) { saveMetadataFailure = false; return false; } persistedMetadata = structuredClone(context.chatMetadata); return true; },
  };
  let suspended = false;
  const identity = Object.freeze({ hostChatId: 'host-chat', chatId: CHAT_ID, characterLocator: 'char', personaLocator: 'persona' });
  const session = {
    identity() { if (suspended) throw Object.assign(new Error('suspended'), { code: 'CHAT_SESSION_SUSPENDED' }); return identity; },
    suspend(chatId) { assert.equal(chatId, CHAT_ID); calls.push(['suspend', chatId]); suspended = true; return { status: 'suspended', identity }; },
    resume(chatId) { assert.equal(chatId, CHAT_ID); calls.push(['resume', chatId]); suspended = false; return true; },
  };
  const state = { memoryWorkBusy: busy };
  const runtime = name => ({ getState: () => state, invalidate() { invalidated.push(name); } });
  let memoryChatId = CHAT_ID;
  const memoryRuntime = { getState: () => ({ ...state, chatId: memoryChatId }), invalidate() { memoryChatId = null; invalidated.push('memory'); } };
  const recallRuntime = { getState: () => ({}), invalidate() { invalidated.push('recall'); }, clearCurrent() { invalidated.push('recall-clear'); } };
  const peopleRuntime = { getState: () => ({}), invalidate() { invalidated.push('people'); } };
  const autoHideController = { async restoreOwned() { calls.push(['restoreOwned']); if (memoryChatId !== CHAT_ID) return { status: 'stale' }; if (autoHideStatus === 'applied') { hidden.is_system = false; delete hidden.extra.qianqianjieAutoHide; } return { status: autoHideStatus }; } };
  const fetchImpl = async (url, options) => { calls.push(['hostRead', url, JSON.parse(options.body)]); return { ok: true, json: async () => [{ chat_metadata: structuredClone(persistedMetadata) }, ...cloneMessages(persistedMessages)] }; };
  const manager = createChatMemoryManagement({ client, session, hostAdapter: { snapshot: () => ({ chatId: context.chatId, chat: context.chat, context }) }, foundationRuntime: runtime('foundation'), memoryRuntime, recallRuntime, peopleRuntime, autoHideController, isMainGenerationActive: () => false, fetchImpl, logger: { warn() {} } });
  return { manager, records, calls, invalidated, context, user, hidden, receipt, identity, releaseHeld };
}

function cloneMessages(messages) { return structuredClone(messages); }

test('按实际revision删除全collection后root和binding，并保留正文、他插件字段与人工隐藏边界', async () => {
  const f = fixture();
  const result = await f.manager.deleteCurrent();
  assert.equal(result.status, 'completed');
  assert.equal(result.deletedCount, 5);
  assert.deepEqual([...f.records.keys()], [`chat-${OTHER_ID}/v3-root`]);
  const removes = f.calls.filter(call => call[0] === 'remove');
  assert.deepEqual(removes.map(call => call[2]), ['floor-a', 'orphan-old', 'v3-people-workspace', 'v3-root', `binding-${CHAT_ID}`]);
  assert.deepEqual(removes.map(call => call[3]), [2, 5, 3, 9, 6]);
  assert.ok(f.calls.findIndex(call => call[0] === 'restoreOwned') < f.calls.findIndex(call => call[0] === 'remove'));
  assert.equal(f.user.mes, '正文保留');
  assert.deepEqual(f.user.extra, { otherPlugin: { keep: true } });
  assert.equal(f.hidden.mes, '隐藏正文保留'); assert.equal(f.hidden.is_system, false); assert.deepEqual(f.hidden.extra, { other: 1 });
  assert.deepEqual(f.context.chatMetadata, { otherPlugin: { keep: true } });
  assert.ok(f.invalidated.includes('memory') && f.invalidated.includes('foundation') && f.invalidated.includes('recall') && f.invalidated.includes('people'));
  assert.equal(f.calls.at(-1)[0], 'resume');
});

test('revision冲突不覆盖并保留捕获UUID，重试重新list后删完剩余记录', async () => {
  const f = fixture({ failRemove: 'orphan-old' });
  await assert.rejects(f.manager.deleteCurrent(), error => error.status === 409);
  assert.equal(f.manager.getState().status, 'failed');
  assert.equal(f.manager.getState().targetChatId, CHAT_ID);
  assert.deepEqual(f.context.chatMetadata.qianqianjie, { schemaVersion: 2, chatId: CHAT_ID });
  assert.equal(f.calls.some(call => call[0] === 'resume'), false);
  const result = await f.manager.deleteCurrent();
  assert.equal(result.status, 'completed');
  assert.equal(f.calls.filter(call => call[0] === 'list').length, 2);
  assert.equal(f.calls.filter(call => call[0] === 'restoreOwned').length, 1, '已恢复可见性后，部分删除重试不得依赖已失效的memory投影再次恢复');
  assert.deepEqual([...f.records.keys()], [`chat-${OTHER_ID}/v3-root`]);
});

test('receipt或metadata保存失败会恢复内存身份并保留重试入口', async () => {
  for (const option of [{ failSaveChat: true }, { silentSaveChatFailure: true }, { failSaveMetadata: true }]) {
    const f = fixture(option);
    await assert.rejects(f.manager.deleteCurrent());
    assert.equal(f.manager.getState().status, 'failed');
    assert.deepEqual(f.context.chatMetadata.qianqianjie, { schemaVersion: 2, chatId: CHAT_ID });
    if (option.failSaveChat || option.silentSaveChatFailure) assert.equal(f.user.extra[CHAT_RECALL_RECEIPT_KEY], f.receipt);
    assert.equal((await f.manager.deleteCurrent()).status, 'completed');
    assert.equal(f.user.extra[CHAT_RECALL_RECEIPT_KEY], undefined);
    assert.equal(f.context.chatMetadata.qianqianjie, undefined);
  }
});

test('忙碌时拒绝且不暂停、不恢复隐藏、不访问后端', async () => {
  const f = fixture({ busy: true });
  await assert.rejects(f.manager.deleteCurrent(), error => error.code === 'QQJ_DELETE_BUSY');
  assert.deepEqual(f.calls, []);
});

test('自动隐藏恢复未确认完成时停止在后端删除之前并保留重试身份', async () => {
  const f = fixture({ autoHideStatus: 'stale' });
  await assert.rejects(f.manager.deleteCurrent(), error => error.code === 'QQJ_DELETE_VISIBILITY_RESTORE_FAILED');
  assert.equal(f.calls.some(call => call[0] === 'list' || call[0] === 'remove'), false);
  assert.equal(f.manager.getState().status, 'failed');
  assert.deepEqual(f.context.chatMetadata.qianqianjie, { schemaVersion: 2, chatId: CHAT_ID });
});

test('A聊天删除在途切到B时不复用A promise，也不把A成功显示成B删除成功', async () => {
  const f = fixture({ holdRemove: 'floor-a' });
  const deletingA = f.manager.deleteCurrent();
  while (!f.calls.some(call => call[0] === 'remove')) await new Promise(resolve => setImmediate(resolve));
  f.context.chatId = 'other-host';
  f.context.chatMetadata = { qianqianjie: { schemaVersion: 2, chatId: OTHER_ID } };
  assert.equal(f.manager.getState().status, 'idle');
  assert.equal(f.manager.getState().blockedByOtherChat, true);
  const attemptedB = f.manager.deleteCurrent();
  await assert.rejects(attemptedB, error => error.code === 'QQJ_DELETE_OTHER_CHAT_ACTIVE');
  assert.notEqual(attemptedB, deletingA);
  f.releaseHeld();
  await assert.rejects(deletingA, error => error.code === 'QQJ_DELETE_CHAT_CHANGED');
});

test('删除成功只释放旧身份，下一次正常prepare才建立新空身份且不触发提取', async () => {
  let persistedMetadata = { qianqianjie: { schemaVersion: 2, chatId: CHAT_ID } }, nextId = OTHER_ID, extractCalls = 0;
  const context = {
    characterId: 0, chatId: 'host-chat', characters: [{ name: '角色', avatar: 'char.png' }], userAvatar: 'persona.png', chatMetadata: structuredClone(persistedMetadata), chat: [], getRequestHeaders: () => ({}),
    async saveChatMetadata() { persistedMetadata = structuredClone(context.chatMetadata); return true; },
  };
  const session = createChatSession({ contextProvider: () => context, ensureChatId: async raw => { raw.chatMetadata.qianqianjie = { schemaVersion: 2, chatId: nextId }; await raw.saveChatMetadata(); return nextId; } });
  assert.equal((await session.prepare()).identity.chatId, CHAT_ID);
  const missing = () => { throw Object.assign(new Error('missing'), { status: 404 }); };
  const client = { list: async () => [], get: async () => missing(), remove: async () => missing() };
  const runtime = { getState: () => ({}), invalidate() {}, extractFloor() { extractCalls += 1; } };
  const manager = createChatMemoryManagement({ client, session, hostAdapter: { snapshot: () => ({ chatId: context.chatId, chat: context.chat, context }) }, foundationRuntime: runtime, memoryRuntime: runtime, recallRuntime: { getState: () => ({}), invalidate() {}, clearCurrent() {} }, peopleRuntime: { getState: () => ({}), invalidate() {} }, autoHideController: { restoreOwned: async () => ({ status: 'unchanged' }) }, fetchImpl: async () => ({ ok: true, json: async () => [{ chat_metadata: structuredClone(persistedMetadata) }] }) });
  assert.equal((await manager.deleteCurrent()).status, 'completed');
  assert.equal(context.chatMetadata.qianqianjie, undefined);
  assert.equal(session.getState().status, 'idle');
  assert.equal(extractCalls, 0);
  assert.equal((await session.prepare()).identity.chatId, nextId);
  assert.equal(extractCalls, 0);
});
