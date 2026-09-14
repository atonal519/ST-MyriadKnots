import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatMemoryManagement, CHAT_RECALL_RECEIPT_KEY } from '../src/chat-memory-management.js';
import { createChatSession } from '../src/chat-session.js';
import { MESSAGE_FLOOR_ANCHOR_KEY } from '../src/v3/message-floor-anchor.js';
import { createFoundationStore } from '../src/v3/foundation-store.js';
import { createFoundationRuntime } from '../src/v3/foundation-runtime.js';
import { createHostAdapter } from '../src/v3/host-adapter.js';
import { createAutoHideController } from '../src/v3/auto-hide.js';
import { createV3MemoryRuntime } from '../src/v3/memory-runtime.js';
import { EXTRACTOR_SYSTEM_PROMPT } from '../src/v3/extractor.js';
import { CSE_SYSTEM_PROMPT } from '../src/v3/cse-engine.js';

const CHAT_ID = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_ID = '223e4567-e89b-42d3-a456-426614174000';

function fixture({ failRemove = null, holdRemove = null, failSaveChat = false, silentSaveChatFailure = false, failSaveMetadata = false, busy = false } = {}) {
  const records = new Map([
    [`chat-${CHAT_ID}/floor-a`, { recordId: 'floor-a', revision: 2, data: { kind: 'floor' } }],
    [`chat-${CHAT_ID}/orphan-old`, { recordId: 'orphan-old', revision: 5, data: { kind: 'old-version' } }],
    [`chat-${CHAT_ID}/v3-people-workspace`, { recordId: 'v3-people-workspace', revision: 3, data: { kind: 'workspace' } }],
    [`chat-${CHAT_ID}/v3-root`, { recordId: 'v3-root', revision: 9, data: { kind: 'root' } }],
    [`chat-${OTHER_ID}/v3-root`, { recordId: 'v3-root', revision: 4, data: { kind: 'other' } }],
    [`chat-identity-bindings/binding-${CHAT_ID}`, { recordId: `binding-${CHAT_ID}`, revision: 6, data: { kind: 'binding' } }],
  ]);
  const calls = [], invalidated = [], memoryInvalidations = [];
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
  const floorMarker = { schemaVersion: 1, chatId: CHAT_ID, floorId: '323e4567-e89b-42d3-a456-426614174000' };
  const user = { is_user: true, is_system: true, mes: '正文保留', extra: { qianqianjieAutoHide: { schemaVersion: 1, chatId: OTHER_ID }, [CHAT_RECALL_RECEIPT_KEY]: receipt, [MESSAGE_FLOOR_ANCHOR_KEY]: floorMarker, otherPlugin: { keep: true } }, swipe_info: [
    { extra: { [CHAT_RECALL_RECEIPT_KEY]: receipt, [MESSAGE_FLOOR_ANCHOR_KEY]: floorMarker, swipeKeep: 1 } },
    { extra: { [MESSAGE_FLOOR_ANCHOR_KEY]: floorMarker, otherSwipeKeep: 2 } },
  ] };
  const hidden = { is_user: false, mes: '隐藏正文保留', is_system: true, extra: { qianqianjieAutoHide: { schemaVersion: 1, chatId: CHAT_ID }, [MESSAGE_FLOOR_ANCHOR_KEY]: floorMarker, other: 1 } };
  const malformedHidden = { is_user: false, mes: '畸形标记隐藏', is_system: true, extra: { qianqianjieAutoHide: { schemaVersion: 2, chatId: CHAT_ID }, malformedKeep: true } };
  const manualHidden = { is_user: false, mes: '人工隐藏', is_system: true, extra: { manuallyHidden: true } };
  let persistedMessages = cloneMessages([user, hidden, malformedHidden, manualHidden]);
  let persistedMetadata = { qianqianjie: { schemaVersion: 2, chatId: CHAT_ID }, qianqianjiePrequel: '用户手工前情', otherPlugin: { keep: true } };
  const context = {
    chatId: 'host-chat', characterId: 0, characters: [{ name: '角色', avatar: 'char' }], getRequestHeaders: () => ({ 'x-test': 'yes' }), chatMetadata: { qianqianjie: { schemaVersion: 2, chatId: CHAT_ID }, qianqianjiePrequel: '用户手工前情', otherPlugin: { keep: true } }, chat: [user, hidden, malformedHidden, manualHidden],
    async saveChat() { calls.push(['saveChat']); if (saveChatFailure) { saveChatFailure = false; throw new Error('save chat failed'); } if (silentSaveChatFailure) { silentSaveChatFailure = false; return; } persistedMessages = cloneMessages(context.chat); },
    async saveChatMetadata() { calls.push(['saveMetadata']); if (saveMetadataFailure) { saveMetadataFailure = false; return false; } persistedMetadata = structuredClone(context.chatMetadata); return true; },
    swipe: { refresh() { calls.push(['swipeRefresh']); } },
    async executeSlashCommandsWithOptions(command) {
      calls.push(['slash', command]);
      const match = /^\/(?:hide|unhide) (\d+)(?:-(\d+))?$/.exec(command);
      assert.ok(match, command);
      const hide = command.startsWith('/hide '), start = Number(match[1]), end = Number(match[2] ?? match[1]);
      for (let index = start; index <= end; index += 1) context.chat[index].is_system = hide;
    },
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
  const memoryRuntime = { getState: () => ({ ...state, chatId: CHAT_ID }), invalidate(options) { memoryInvalidations.push(options); invalidated.push('memory'); } };
  const recallRuntime = { getState: () => ({}), invalidate() { invalidated.push('recall'); }, clearCurrent() { invalidated.push('recall-clear'); } };
  const peopleRuntime = { getState: () => ({}), invalidate() { invalidated.push('people'); } };
  const hostAdapter = { snapshot: () => ({ chatId: context.chatId, chat: context.chat, context }) };
  const autoHideController = { async stop() { calls.push(['stopAutoHide']); } };
  const fetchImpl = async (url, options) => { calls.push(['hostRead', url, JSON.parse(options.body)]); return { ok: true, json: async () => [{ chat_metadata: structuredClone(persistedMetadata) }, ...cloneMessages(persistedMessages)] }; };
  const manager = createChatMemoryManagement({ client, session, hostAdapter, foundationRuntime: runtime('foundation'), memoryRuntime, recallRuntime, peopleRuntime, autoHideController, isMainGenerationActive: () => false, fetchImpl, logger: { warn() {} } });
  return { manager, records, calls, invalidated, memoryInvalidations, context, user, hidden, malformedHidden, manualHidden, receipt, floorMarker, identity, releaseHeld };
}

function cloneMessages(messages) { return structuredClone(messages); }

test('按实际revision删除全collection后root和binding，并保留正文、他插件字段与人工隐藏边界', async () => {
  const f = fixture();
  const previousDocument = globalThis.document;
  const nodes = [0, 1, 2, 3].map(mesid => ({ attributes: { mesid: String(mesid), is_system: 'true' }, getAttribute(name) { return this.attributes[name]; }, setAttribute(name, value) { this.attributes[name] = value; } }));
  globalThis.document = { querySelectorAll(selector) { assert.equal(selector, '#chat .mes[mesid]'); return nodes; } };
  let result;
  try { result = await f.manager.deleteCurrent(); }
  finally { if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; }
  assert.equal(result.status, 'completed');
  assert.equal(result.deletedCount, 5);
  assert.deepEqual([...f.records.keys()], [`chat-${OTHER_ID}/v3-root`]);
  const removes = f.calls.filter(call => call[0] === 'remove');
  assert.deepEqual(removes.map(call => call[2]), ['floor-a', 'orphan-old', 'v3-people-workspace', 'v3-root', `binding-${CHAT_ID}`]);
  assert.deepEqual(removes.map(call => call[3]), [2, 5, 3, 9, 6]);
  assert.ok(f.calls.findIndex(call => call[0] === 'stopAutoHide') < f.calls.findIndex(call => call[0] === 'remove'));
  assert.ok(f.calls.findIndex(call => call[0] === 'remove') < f.calls.findIndex(call => call[0] === 'saveChat'), '后端记录删除先于唯一一次聊天清理保存');
  assert.equal(f.calls.filter(call => call[0] === 'saveChat').length, 1);
  assert.equal(f.calls.some(call => call[0] === 'slash'), false, '删除清理不再依赖 slash 命令');
  assert.equal(f.user.mes, '正文保留');
  assert.equal(f.user.is_system, false, '有效来源 UUID 标记也属于千千结，应恢复当前分支对象');
  assert.deepEqual(f.user.extra, { otherPlugin: { keep: true } });
  assert.deepEqual(f.user.swipe_info, [{ extra: { swipeKeep: 1 } }, { extra: { otherSwipeKeep: 2 } }], '当前与非当前 swipe 的旧标识都必须清除，其他字段保留');
  assert.equal(f.hidden.mes, '隐藏正文保留'); assert.equal(f.hidden.is_system, false); assert.deepEqual(f.hidden.extra, { other: 1 });
  assert.equal(f.malformedHidden.is_system, true); assert.deepEqual(f.malformedHidden.extra, { malformedKeep: true }, '畸形标记只清键，不解除隐藏');
  assert.equal(f.manualHidden.is_system, true); assert.deepEqual(f.manualHidden.extra, { manuallyHidden: true }, '无千千结标记的人工隐藏保持');
  assert.deepEqual(nodes.map(node => node.attributes.is_system), ['false', 'false', 'true', 'true'], '只同步已恢复楼层的已渲染 DOM 属性');
  assert.equal(f.calls.filter(call => call[0] === 'swipeRefresh').length, 1);
  assert.deepEqual(f.context.chatMetadata, { qianqianjiePrequel: '用户手工前情', otherPlugin: { keep: true } });
  assert.ok(f.invalidated.includes('memory') && f.invalidated.includes('foundation') && f.invalidated.includes('recall') && f.invalidated.includes('people'));
  assert.deepEqual(f.memoryInvalidations, [undefined, { deletedChatId: CHAT_ID }], '仅完整删除成功后的最终 invalidate 携带已删除聊天 ID');
  assert.equal(f.calls.at(-1)[0], 'resume');
});

test('revision冲突不覆盖并保留捕获UUID，重试重新list后删完剩余记录', async () => {
  const f = fixture({ failRemove: 'orphan-old' });
  await assert.rejects(f.manager.deleteCurrent(), error => error.status === 409);
  assert.equal(f.manager.getState().status, 'failed');
  assert.equal(f.manager.getState().targetChatId, CHAT_ID);
  assert.deepEqual(f.memoryInvalidations, [undefined], '删除失败时普通失效不能冒充整聊天删除成功');
  assert.deepEqual(f.context.chatMetadata.qianqianjie, { schemaVersion: 2, chatId: CHAT_ID });
  assert.equal(f.calls.some(call => call[0] === 'resume'), false);
  const result = await f.manager.deleteCurrent();
  assert.equal(result.status, 'completed');
  assert.equal(f.calls.filter(call => call[0] === 'list').length, 2);
  assert.equal(f.calls.filter(call => call[0] === 'stopAutoHide').length, 2, '每次重入先等待当时已有的自动隐藏队列收束');
  assert.deepEqual(f.memoryInvalidations, [undefined, undefined, { deletedChatId: CHAT_ID }]);
  assert.deepEqual([...f.records.keys()], [`chat-${OTHER_ID}/v3-root`]);
});

test('receipt或metadata保存失败会恢复内存身份并保留重试入口', async () => {
  for (const option of [{ failSaveChat: true }, { silentSaveChatFailure: true }, { failSaveMetadata: true }]) {
    const f = fixture(option);
    await assert.rejects(f.manager.deleteCurrent());
    assert.equal(f.manager.getState().status, 'failed');
    assert.deepEqual(f.context.chatMetadata.qianqianjie, { schemaVersion: 2, chatId: CHAT_ID });
    if (option.failSaveChat || option.silentSaveChatFailure) {
      assert.equal(f.user.is_system, true);
      assert.equal(f.hidden.is_system, true);
      assert.deepEqual(f.user.extra.qianqianjieAutoHide, { schemaVersion: 1, chatId: OTHER_ID });
      assert.deepEqual(f.hidden.extra.qianqianjieAutoHide, { schemaVersion: 1, chatId: CHAT_ID });
      assert.equal(f.user.extra[CHAT_RECALL_RECEIPT_KEY], f.receipt);
      assert.equal(f.user.extra[MESSAGE_FLOOR_ANCHOR_KEY], f.floorMarker);
      assert.equal(f.user.swipe_info[1].extra[MESSAGE_FLOOR_ANCHOR_KEY], f.floorMarker);
    }
    assert.equal((await f.manager.deleteCurrent()).status, 'completed');
    assert.equal(f.user.extra[CHAT_RECALL_RECEIPT_KEY], undefined);
    assert.equal(f.user.extra[MESSAGE_FLOOR_ANCHOR_KEY], undefined);
    assert.ok(f.user.swipe_info.every(swipe => swipe.extra[MESSAGE_FLOOR_ANCHOR_KEY] === undefined && swipe.extra[CHAT_RECALL_RECEIPT_KEY] === undefined));
    assert.equal(f.context.chatMetadata.qianqianjie, undefined);
  }
});

test('忙碌时拒绝且不暂停、不停止队列、不访问后端', async () => {
  const f = fixture({ busy: true });
  assert.equal(f.manager.getState().workBusy, true, 'UI 与执行层必须读取同一份忙碌投影');
  await assert.rejects(f.manager.deleteCurrent(), error => error.code === 'QQJ_DELETE_BUSY');
  assert.deepEqual(f.calls, []);
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

test('真实删除后空ID完全重构自行建立新身份，并从已恢复USER正文生成root、摘要与CSE', async () => {
  let persistedMetadata = { qianqianjie: { schemaVersion: 2, chatId: CHAT_ID } }, nextId = OTHER_ID, prepareCalls = 0;
  const oldMarker = { schemaVersion: 1, chatId: CHAT_ID, floorId: '323e4567-e89b-42d3-a456-426614174000' };
  let persistedMessages = [
    { is_user: true, is_system: true, mes: '原隐藏 USER', send_date: 'hidden-user', extra: { qianqianjieAutoHide: { schemaVersion: 1, chatId: CHAT_ID } } },
    { is_user: false, is_system: true, mes: '旧回复仍保留', extra: { qianqianjieAutoHide: { schemaVersion: 1, chatId: CHAT_ID }, [MESSAGE_FLOOR_ANCHOR_KEY]: oldMarker } },
    { is_user: true, is_system: false, mes: '确认', send_date: 'confirm' },
  ];
  const context = {
    name1: '用户', name2: '角色', characterId: 0, chatId: 'host-chat', characters: [{ name: '角色', avatar: 'char.png', data: { description: '角色设定', personality: '可靠', scenario: '测试场景' } }], userAvatar: 'persona.png', powerUserSettings: { persona_description: '用户设定' }, chatMetadata: structuredClone(persistedMetadata), chat: structuredClone(persistedMessages), getRequestHeaders: () => ({}),
    async saveChat() { persistedMessages = structuredClone(context.chat); },
    async saveChatMetadata() { persistedMetadata = structuredClone(context.chatMetadata); return true; },
    getWorldInfoNames() { return []; }, async loadWorldInfoBatch() { return new Map(); },
  };
  const session = createChatSession({ contextProvider: () => context, ensureChatId: async raw => { prepareCalls += 1; raw.chatMetadata.qianqianjie = { schemaVersion: 2, chatId: nextId }; await raw.saveChatMetadata(); return nextId; } });
  assert.equal((await session.prepare()).identity.chatId, CHAT_ID);
  const missing = () => { throw Object.assign(new Error('missing'), { status: 404 }); };
  const records = new Map();
  const client = {
    list: async collection => [...records.entries()].filter(([key]) => key.startsWith(`${collection}/`)).map(([, value]) => structuredClone(value)),
    get: async (collection, recordId) => records.has(`${collection}/${recordId}`) ? structuredClone(records.get(`${collection}/${recordId}`)) : missing(),
    put: async (collection, recordId, data, expectedRevision) => {
      const key = `${collection}/${recordId}`, previous = records.get(key);
      if ((previous?.revision ?? 0) !== expectedRevision) throw Object.assign(new Error('conflict'), { status: 409 });
      const envelope = { recordId, revision: expectedRevision + 1, data: structuredClone(data) }; records.set(key, envelope); return structuredClone(envelope);
    },
    remove: async () => missing(),
  };
  const hostAdapter = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => context } } });
  const store = createFoundationStore({ client, contextProvider: () => session.identity() });
  const foundation = createFoundationRuntime({ hostAdapter, store, contextProvider: () => context, prepareSession: () => session.prepare(), now: () => new Date('2026-09-14T00:00:00.000Z'), logger: { warn() {} } });
  const requests = [];
  const utility = async options => {
    requests.push(options);
    return options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: '旧回复摘要' }, taskMetadata: { source: 'test', sourceLabel: '测试', model: 'mock' } }
      : { jsonData: { noMaterialChange: true }, taskMetadata: { source: 'test', sourceLabel: '测试', model: 'mock' } };
  };
  const memory = createV3MemoryRuntime({ foundationRuntime: foundation, store, hostAdapter, generateAnalysisTask: utility, generateUtilityTask: utility, now: () => new Date('2026-09-14T00:00:00.000Z'), logger: { warn() {} } });
  const autoHideController = createAutoHideController({ hostAdapter, memoryRuntime: memory, settings: { get: () => ({ pluginEnabled: true, autoHideEnabled: false, autoHideKeepAiCount: 3 }) }, logger: { warn() {} } });
  const manager = createChatMemoryManagement({ client, session, hostAdapter, foundationRuntime: foundation, memoryRuntime: memory, recallRuntime: { getState: () => ({}), invalidate() {}, clearCurrent() {} }, peopleRuntime: { getState: () => ({}), invalidate() {} }, autoHideController, fetchImpl: async () => ({ ok: true, json: async () => [{ chat_metadata: structuredClone(persistedMetadata) }, ...structuredClone(persistedMessages)] }) });
  assert.equal((await manager.deleteCurrent()).status, 'completed');
  assert.equal(context.chatMetadata.qianqianjie, undefined);
  assert.equal(session.getState().status, 'idle');
  assert.equal(prepareCalls, 0, '删除完成前未创建替代身份');
  const rebuilt = await memory.fullRebuild(null);
  assert.equal(rebuilt.chatId, nextId);
  assert.equal(session.getState().identity.chatId, nextId, 'fullRebuild(null) 必须经现有 session.prepare 建立新 UUID');
  assert.equal(prepareCalls, 1);
  assert.equal(context.chat[1].mes, '旧回复仍保留');
  assert.equal(context.chat[0].is_system, false);
  assert.equal(context.chat[1].is_system, false);
  assert.equal(context.chat[0].extra.qianqianjieAutoHide, undefined);
  assert.equal(context.chat[1].extra.qianqianjieAutoHide, undefined);
  assert.equal(context.chat[1].extra[MESSAGE_FLOOR_ANCHOR_KEY], undefined);
  assert.equal(rebuilt.rememberedCount, 1);
  assert.equal(rebuilt.cseReady, true);
  assert.equal(requests.filter(request => request.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, 1);
  assert.equal(requests.filter(request => request.systemPrompt === CSE_SYSTEM_PROMPT).length, 1);
  const extractorPayload = JSON.parse(requests.find(request => request.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).taskMessages[0].content).payload;
  assert.deepEqual(extractorPayload.precedingUserInput.map(item => item.content), ['原隐藏 USER'], '恢复后的 USER 必须重新进入前置输入来源');
  assert.ok(records.has(`chat-${nextId}/v3-root`), '删除旧标识后新身份可从保留正文正常初始化，不再落入 foreign marker');
});
