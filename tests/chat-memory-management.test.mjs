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
import { runHistoricalRebuildTask } from '../src/v3/historical-rebuild-task.js';
import { scanAssistantCandidates } from '../src/v3/foundation-domain.js';
import { persistMessageFloorAnchors } from '../src/v3/message-floor-anchor.js';
import { captureHistoricalRebuildSources } from '../src/v3/historical-rebuild-sources.js';
import { EXTRACTOR_SYSTEM_PROMPT } from '../src/v3/extractor.js';
import { CSE_SYSTEM_PROMPT } from '../src/v3/cse-engine.js';

const CHAT_ID = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_ID = '223e4567-e89b-42d3-a456-426614174000';

function fixture({ failRemove = null, holdRemove = null, failSaveChat = false, silentSaveChatFailure = false, failSaveMetadata = false, busy = false, prepareHook = null, removeHook = null, rebuildHook = null, migrationPrefix = false, memoryMigration = null } = {}) {
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
      await removeHook?.(collection, recordId);
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
    chatId: 'host-chat', userAvatar: 'persona', characterId: 0, characterAvatar: 'char', characters: [{ name: '角色', avatar: 'char' }], getRequestHeaders: () => ({ 'x-test': 'yes' }), chatMetadata: { qianqianjie: { schemaVersion: 2, chatId: CHAT_ID }, qianqianjiePrequel: '用户手工前情', otherPlugin: { keep: true } }, chat: [user, hidden, malformedHidden, manualHidden],
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
  let identity = Object.freeze({ hostChatId: 'host-chat', chatId: CHAT_ID, characterLocator: 'char', personaLocator: 'persona' });
  const session = {
    async prepare() { calls.push(['prepare']); await prepareHook?.(context); const chatId = '323e4567-e89b-42d3-a456-426614174000'; context.chatMetadata.qianqianjie = { schemaVersion: 2, chatId }; await context.saveChatMetadata(); identity = { ...identity, chatId }; return { status: 'ready', identity }; },
    identity() { if (suspended) throw Object.assign(new Error('suspended'), { code: 'CHAT_SESSION_SUSPENDED' }); return identity; },
    suspend(chatId) { assert.equal(chatId, CHAT_ID); calls.push(['suspend', chatId]); suspended = true; return { status: 'suspended', identity }; },
    resume(chatId) { assert.equal(chatId, CHAT_ID); calls.push(['resume', chatId]); suspended = false; return true; },
  };
  const state = { memoryWorkBusy: busy };
  const runtime = name => ({ getState: () => state, getReachable: () => migrationPrefix ? { root: { chatId: CHAT_ID }, migrationDescriptor: { id: 'archive-prefix' } } : null, invalidate() { invalidated.push(name); } });
  const memoryRuntime = { async startHistoricalRebuild() { const chatId = context.chatMetadata.qianqianjie.chatId; calls.push(['history', chatId]); records.set(`chat-${chatId}/v3-root`, { recordId: 'v3-root', revision: 1, data: { chatId } }); return { status: 'ready', chatId }; }, getState: () => ({ ...state, chatId: CHAT_ID }), invalidate(options) { memoryInvalidations.push(options); invalidated.push('memory'); } };
  const recallRuntime = { getState: () => ({}), invalidate() { invalidated.push('recall'); }, clearCurrent() { invalidated.push('recall-clear'); } };
  const peopleRuntime = { getState: () => ({}), invalidate() { invalidated.push('people'); } };
  const timeRuntime = { async stop() { calls.push(['stopTime']); }, async authorizeHistory() { calls.push(['timeHistory', context.chatMetadata.qianqianjie.chatId]); } };
  const hostAdapter = { snapshot: () => ({ chatId: context.chatId, chat: context.chat, context }) };
  const autoHideController = { async stop() { calls.push(['stopAutoHide']); } };
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body); calls.push([url.endsWith('/save') ? 'hostSave' : 'hostRead', url, body]);
    if (url.endsWith('/save')) {
      if (saveChatFailure) { saveChatFailure = false; return { ok: false, status: 500 }; }
      if (silentSaveChatFailure) { silentSaveChatFailure = false; return { ok: true, json: async () => ({}) }; }
      persistedMetadata = structuredClone(body.chat[0].chat_metadata);
      persistedMessages = cloneMessages(body.chat.slice(1));
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => [{ chat_metadata: structuredClone(persistedMetadata) }, ...cloneMessages(persistedMessages)] };
  };
  const createHistoricalRebuild = async options => {
    const result = await rebuildHook?.(options, context);
    if (result?.rebuildStatus) return result;
    const chatId = '323e4567-e89b-42d3-a456-426614174000';
    context.chatMetadata.qianqianjie = { schemaVersion: 2, chatId };
    await context.saveChatMetadata();
    calls.push(['timeHistory', chatId]);
    records.set(`chat-${chatId}/v3-root`, { recordId: 'v3-root', revision: 1, data: { chatId } });
    calls.push(['history', chatId]);
    return { status: 'ready', chatId };
  };
  const manager = createChatMemoryManagement({ client, session, hostAdapter, foundationRuntime: runtime('foundation'), memoryRuntime, recallRuntime, peopleRuntime, timeRuntime, memoryMigration, autoHideController, isMainGenerationActive: () => false, fetchImpl, coreRecordCache: { async invalidateIdentity(identity) { calls.push(['invalidateCache', identity.chatId]); } }, createHistoricalRebuild, logger: { warn() {} } });
  return { manager, records, calls, invalidated, memoryInvalidations, context, user, hidden, malformedHidden, manualHidden, receipt, floorMarker, identity, releaseHeld };
}

function cloneMessages(messages) { return structuredClone(messages); }

test('搬家启动立即通知管理器busy状态，结束后再通知完成', async () => {
  let status = 'idle', release;
  const migration = { getState: () => ({ status }), migrateCurrent() { status = 'migrating'; return new Promise(resolve => { release = resolve; }); } };
  const f = fixture({ memoryMigration: migration });
  const states = [];
  f.manager.subscribe(state => states.push(state));
  const pending = f.manager.migrateCurrent();
  assert.equal(f.manager.getState().migrationState.status, 'migrating');
  assert.equal(f.manager.getState().workBusy, true);
  assert.equal(states.at(-1).migrationState.status, 'migrating', '异步搬家运行前立即通知UI重绘');
  status = 'completed'; release({ status: 'completed' }); await pending;
  assert.equal(states.at(-1).migrationState.status, 'completed', '搬家结束仍通知最终状态');
});

test('先CAS删除root使旧manifest失效，再并发清理普通记录，binding最后删除', async () => {
  let active = 0, maxActive = 0; const releases = [];
  const f = fixture({ removeHook: async (_, id) => {
    if (id === 'v3-root' || id.startsWith('binding-')) { assert.equal(active, 0); return; }
    active += 1; maxActive = Math.max(maxActive, active);
    if (releases.length < 4) await new Promise(resolve => { releases.push(resolve); });
    active -= 1;
  } });
  for (let index = 0; index < 6; index += 1) f.records.set(`chat-${CHAT_ID}/extra-${index}`, { recordId: `extra-${index}`, revision: 1, data: {} });
  const pending = f.manager.deleteCurrent();
  while (releases.length < 4) await new Promise(resolve => setImmediate(resolve));
  assert.equal(active, 4); assert.equal(f.calls.filter(call => call[0] === 'remove').length, 5);
  assert.equal(f.records.has(`chat-${CHAT_ID}/v3-root`), false);
  releases.forEach(release => release());
  const result = await pending;
  assert.equal(maxActive, 4); assert.equal(result.deletedCount, 11);
  assert.deepEqual(f.calls.filter(call => call[0] === 'remove').map(call => call[2]).slice(0, 1), ['v3-root']);
  assert.equal(f.calls.filter(call => call[0] === 'remove').at(-1)[2], `binding-${CHAT_ID}`);
});

test('首错停止领项，所有已发删除完成才失败且累计成功数，重试仍全清', async () => {
  let fail = true, settled = false; const releases = [];
  const f = fixture({ removeHook: async (_, id) => {
    if (!fail) return;
    if (id === 'v3-root') return;
    if (id === 'floor-a') throw Object.assign(new Error('conflict'), { status: 409 });
    await new Promise(resolve => { releases.push(resolve); });
  } });
  for (let index = 0; index < 3; index += 1) f.records.set(`chat-${CHAT_ID}/extra-${index}`, { recordId: `extra-${index}`, revision: 1, data: {} });
  const pending = f.manager.deleteCurrent().then(() => { settled = true; }, error => { settled = true; return error; });
  while (releases.length < 3) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(f.calls.filter(call => call[0] === 'remove').length, 5);
  releases.forEach(release => release());
  assert.equal((await pending).status, 409); assert.equal(f.manager.getState().deletedCount, 4);
  assert.equal(f.records.has(`chat-${CHAT_ID}/v3-root`), false);
  assert.equal(f.calls.some(call => call[0] === 'hostSave'), false);
  fail = false; assert.equal((await f.manager.deleteCurrent()).deletedCount, 8);
});

test('完全重构删除整collection与前情后新建身份，普通删除仍保留前情', async () => {
  const f = fixture();
  for (const id of ['v3-time-head', 'v3-time-batch-old', 'v3-baseline-old', 'unknown-unreachable']) f.records.set(`chat-${CHAT_ID}/${id}`, { recordId: id, revision: 1, data: { old: true } });
  const texts = f.context.chat.map(message => message.mes);
  const result = await f.manager.fullRebuild(CHAT_ID);
  const timeIndex = f.calls.findIndex(call => call[0] === 'timeHistory'), summaryIndex = f.calls.findIndex(call => call[0] === 'history');
  assert.ok(timeIndex >= 0 && timeIndex < summaryIndex, '新UUID先授时间历史，再启动摘要，无CSE齐全门槛');
  assert.equal(f.calls[timeIndex][1], f.calls[summaryIndex][1]);
  assert.notEqual(result.chatId, CHAT_ID);
  assert.equal([...f.records.keys()].some(key => key.startsWith(`chat-${CHAT_ID}/`)), false);
  assert.equal(f.records.has(`chat-identity-bindings/binding-${CHAT_ID}`), false);
  assert.equal(f.records.has(`chat-${OTHER_ID}/v3-root`), true);
  assert.equal(f.context.chatMetadata.qianqianjiePrequel, undefined);
  assert.deepEqual(f.context.chatMetadata.otherPlugin, { keep: true });
  assert.deepEqual(f.context.chat.map(message => message.mes), texts);
  assert.equal(f.hidden.is_system, false); assert.equal(f.manualHidden.is_system, true);
  assert.ok(f.calls.findIndex(call => call[0] === 'timeHistory') > f.calls.findLastIndex(call => call[0] === 'remove'));
  assert.equal(f.calls.filter(call => call[0] === 'history').length, 1);
  assert.equal(f.manager.getState().status, 'idle', '新档不沿用普通删除结果文案');
});

test('迁移档完全重构保留冻结图和宿主身份，历史任务在原目标图上继续', async () => {
  const f = fixture({ migrationPrefix: true, rebuildHook: async options => {
    assert.equal(options.identity.chatId, CHAT_ID);
    assert.equal(options.cleanedChat.header.chat_metadata.qianqianjie.chatId, CHAT_ID);
    options.onTaskControl({ getState: () => ({ rebuildStatus: 'caughtUp', chatId: CHAT_ID }), subscribe: () => () => {}, pause: async () => {}, start: async () => ({ rebuildStatus: 'caughtUp', chatId: CHAT_ID }) });
    return { rebuildStatus: 'caughtUp', chatId: CHAT_ID };
  } });
  const before = [...f.records.keys()].filter(key => key.startsWith(`chat-${CHAT_ID}/`)).sort();
  const result = await f.manager.fullRebuild(CHAT_ID);
  const after = [...f.records.keys()].filter(key => key.startsWith(`chat-${CHAT_ID}/`)).sort();
  assert.equal(result.chatId, CHAT_ID);
  assert.deepEqual(after, before, '不删除迁移归档图中的root、楼或descriptor');
  assert.equal(f.calls.some(call => call[0] === 'remove' || call[0] === 'list'), false);
  assert.equal(f.calls.some(call => call[0] === 'suspend'), false);
});

test('完全重构删除失败不生成，续删完成后沿开始时的目标创建新身份', async () => {
  const failed = fixture({ failRemove: 'orphan-old' });
  await assert.rejects(failed.manager.fullRebuild(CHAT_ID));
  assert.equal(failed.calls.some(call => ['prepare', 'history'].includes(call[0])), false);
  await failed.manager.fullRebuild(CHAT_ID);
  assert.equal(failed.calls.filter(call => call[0] === 'history').length, 1);
});

test('完全重构任务转发真实进度与暂停，暂停后复用同一目标任务继续', async () => {
  let state = Object.freeze({ rebuildStatus: 'rebuilding', rebuildCompletedCount: 1, rebuildTotalCount: 4, activeAutoMemory: { mode: 'historical' } });
  let listener, starts = 0;
  const control = {
    getState: () => state,
    subscribe(callback) { listener = callback; return () => { listener = null; }; },
    async pause() { state = Object.freeze({ rebuildStatus: 'paused', rebuildCompletedCount: 1, rebuildTotalCount: 4 }); listener?.(state); return state; },
    async start() { starts += 1; state = Object.freeze({ rebuildStatus: 'caughtUp', rebuildCompletedCount: 4, rebuildTotalCount: 4, chatId: OTHER_ID }); listener?.(state); return state; },
  };
  const f = fixture({ rebuildHook: async options => { options.onTaskControl(control); await control.pause(); return state; } });
  const paused = await f.manager.fullRebuild(CHAT_ID);
  assert.equal(paused.rebuildStatus, 'paused');
  assert.equal(f.manager.getState().rebuildState.rebuildCompletedCount, 1);
  assert.equal(typeof f.manager.getState().pauseHistoricalRebuild, 'function');
  const completed = await f.manager.fullRebuild(CHAT_ID);
  assert.equal(starts, 1, '继续按钮调用同一历史任务实例，不新删后端或重开另一task');
  assert.equal(completed.rebuildStatus, 'caughtUp');
  assert.equal(f.records.has(`chat-${OTHER_ID}/v3-root`), true);
});

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
  assert.equal(removes[0][2], 'v3-root');
  assert.equal(removes.at(-1)[2], `binding-${CHAT_ID}`);
  assert.deepEqual(new Map(removes.map(call => [call[2], call[3]])), new Map([['v3-root', 9], ['floor-a', 2], ['orphan-old', 5], ['v3-people-workspace', 3], [`binding-${CHAT_ID}`, 6]]));
  assert.ok(f.calls.findIndex(call => call[0] === 'stopAutoHide') < f.calls.findIndex(call => call[0] === 'remove'));
  assert.ok(f.calls.findIndex(call => call[0] === 'remove') < f.calls.findIndex(call => call[0] === 'hostSave'), '后端记录删除先于唯一一次聊天清理保存');
  assert.equal(f.calls.filter(call => call[0] === 'hostSave').length, 1);
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
  assert.deepEqual(f.memoryInvalidations, [{ deletedChatId: CHAT_ID }], '删除目标的记忆投影按A身份失效');
  assert.equal(f.calls.at(-1)[0], 'resume');
});

test('revision冲突不覆盖并保留捕获UUID，重试重新list后删完剩余记录', async () => {
  const f = fixture({ failRemove: 'orphan-old' });
  await assert.rejects(f.manager.deleteCurrent(), error => error.status === 409);
  assert.equal(f.manager.getState().status, 'failed');
  assert.equal(f.manager.getState().targetChatId, CHAT_ID);
  assert.deepEqual(f.memoryInvalidations, [{ deletedChatId: CHAT_ID }], '删除失败时只按A身份失效记忆投影');
  assert.deepEqual(f.context.chatMetadata.qianqianjie, { schemaVersion: 2, chatId: CHAT_ID });
  assert.equal(f.calls.some(call => call[0] === 'resume'), false);
  const result = await f.manager.deleteCurrent();
  assert.equal(result.status, 'completed');
  assert.equal(f.calls.filter(call => call[0] === 'list').length, 2);
  assert.equal(f.calls.filter(call => call[0] === 'stopAutoHide').length, 2, '每次重入先等待当时已有的自动隐藏队列收束');
  assert.deepEqual(f.memoryInvalidations, [{ deletedChatId: CHAT_ID }, { deletedChatId: CHAT_ID }]);
  assert.deepEqual([...f.records.keys()], [`chat-${OTHER_ID}/v3-root`]);
});

test('目标文件保存失败或读回不一致保留重试入口', async () => {
  for (const option of [{ failSaveChat: true }, { silentSaveChatFailure: true }]) {
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

test('A目标删除在途切到B仍完成A的目标保存，不阻断或改写B展示', async () => {
  const f = fixture({ holdRemove: 'floor-a' });
  const deletingA = f.manager.deleteCurrent();
  while (!f.calls.some(call => call[0] === 'remove')) await new Promise(resolve => setImmediate(resolve));
  f.context.chatId = 'other-host';
  f.context.chatMetadata = { qianqianjie: { schemaVersion: 2, chatId: OTHER_ID } };
  assert.equal(f.manager.getState().status, 'idle');
  f.releaseHeld();
  assert.equal((await deletingA).status, 'completed');
  assert.equal(f.records.has(`chat-${CHAT_ID}/v3-root`), false);
  assert.equal(f.calls.filter(call => call[0] === 'hostSave').length, 1);
  assert.deepEqual(f.context.chatMetadata, { qianqianjie: { schemaVersion: 2, chatId: OTHER_ID } }, '当前B展示元数据没有接收A清理结果');
});

test('真实历史重构完整完成与暂停续跑均接回A身份、消息锚点和共享覆盖', async () => {
 for (const pauseAndResume of [true, false]) {
  let persistedMetadata = { qianqianjie: { schemaVersion: 2, chatId: CHAT_ID }, world_info: ['聊天世界书'] }, nextId = OTHER_ID, prepareCalls = 0;
  const oldMarker = { schemaVersion: 1, chatId: CHAT_ID, floorId: '323e4567-e89b-42d3-a456-426614174000' };
  let persistedMessages = [
    { is_user: true, is_system: true, mes: '原隐藏 USER', send_date: 'hidden-user', extra: { qianqianjieAutoHide: { schemaVersion: 1, chatId: CHAT_ID } } },
    { is_user: false, is_system: true, mes: '旧回复仍保留', extra: { qianqianjieAutoHide: { schemaVersion: 1, chatId: CHAT_ID }, [MESSAGE_FLOOR_ANCHOR_KEY]: oldMarker } },
    { is_user: true, is_system: false, mes: '确认', send_date: 'confirm' },
  ];
  const context = {
    name1: '用户', name2: '角色', characterId: 0, chatId: 'host-chat', characters: [{ name: '角色', avatar: 'char.png', data: { description: '角色设定', personality: '可靠', scenario: '测试场景', extensions: { world: '角色世界书' } } }], userAvatar: 'persona.png', personaId: 'persona-id', powerUserSettings: { persona_description: '用户设定', persona_description_lorebook: '人格世界书' }, extensionSettings: { note: { default: '聊天作者注释', chara: [] } }, chatMetadata: { ...structuredClone(persistedMetadata), world_info: ['聊天世界书'] }, chat: structuredClone(persistedMessages), getRequestHeaders: () => ({}), getCharaAuxWorlds: () => ['附加世界书'], chatWorldInfo: { getNames: () => ['聊天世界书'], globalSelection: ['全局世界书'] },
    async saveChat() { persistedMessages = structuredClone(context.chat); },
    async saveChatMetadata() { persistedMetadata = structuredClone(context.chatMetadata); return true; },
    getWorldInfoNames() { return []; }, async loadWorldInfoBatch() { return new Map(); },
  };
  const session = createChatSession({ contextProvider: () => context, ensureChatId: async raw => { prepareCalls += 1; raw.chatMetadata.qianqianjie = { schemaVersion: 2, chatId: nextId }; await raw.saveChatMetadata(); return nextId; } });
  assert.equal((await session.prepare()).identity.chatId, CHAT_ID);
  const missing = () => { throw Object.assign(new Error('missing'), { status: 404 }); };
  const records = new Map(['v3-root', 'v3-people-workspace', 'v3-time-head', 'v3-time-batch-old', 'unknown-unreachable'].map(recordId => [`chat-${CHAT_ID}/${recordId}`, { recordId, revision: 1, data: { oldChatId: CHAT_ID, selectedEntityIds: ['old-person'], profiles: [{ avatar: 'old-avatar', identityRedirects: ['old-person'] }] } }]));
  const client = {
    list: async collection => [...records.entries()].filter(([key]) => key.startsWith(`${collection}/`)).map(([, value]) => structuredClone(value)),
    get: async (collection, recordId) => records.has(`${collection}/${recordId}`) ? structuredClone(records.get(`${collection}/${recordId}`)) : missing(),
    put: async (collection, recordId, data, expectedRevision) => {
      const key = `${collection}/${recordId}`, previous = records.get(key);
      if ((previous?.revision ?? 0) !== expectedRevision) throw Object.assign(new Error('conflict'), { status: 409 });
      const envelope = { recordId, revision: expectedRevision + 1, data: structuredClone(data) }; records.set(key, envelope); return structuredClone(envelope);
    },
    remove: async (collection, recordId, revision) => { const key = `${collection}/${recordId}`, envelope = records.get(key); if (!envelope) return missing(); assert.equal(envelope.revision, revision); records.delete(key); return { trashId: recordId }; },
  };
  const hostAdapter = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => context } } });
  const store = createFoundationStore({ client, contextProvider: () => session.identity() });
  const foundation = createFoundationRuntime({ hostAdapter, store, contextProvider: () => context, prepareSession: () => session.prepare(), now: () => new Date('2026-09-14T00:00:00.000Z'), logger: { warn() {} } });
  const requests = [];
  let historicalTaskControl = null, firstExtractorPending = true, signalFirstExtractor, releaseFirstExtractor;
  const firstExtractorStarted = new Promise(resolve => { signalFirstExtractor = resolve; });
  const firstExtractorGate = new Promise(resolve => { releaseFirstExtractor = resolve; });
  const utility = async options => {
    requests.push(options);
    if (firstExtractorPending && options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) {
      firstExtractorPending = false;
      signalFirstExtractor();
      if (pauseAndResume) await firstExtractorGate;
    }
    return options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: '旧回复摘要' }, taskMetadata: { source: 'test', sourceLabel: '测试', model: 'mock' } }
      : { jsonData: { noMaterialChange: true }, taskMetadata: { source: 'test', sourceLabel: '测试', model: 'mock' } };
  };
  const memory = createV3MemoryRuntime({ foundationRuntime: foundation, store, hostAdapter, generateAnalysisTask: utility, generateUtilityTask: utility, now: () => new Date('2026-09-14T00:00:00.000Z'), logger: { warn() {} } });
  const autoHideController = createAutoHideController({ hostAdapter, memoryRuntime: memory, settings: { get: () => ({ pluginEnabled: true, autoHideEnabled: false, autoHideKeepAiCount: 3 }) }, logger: { warn() {} } });
  const fetchImpl = async (url, request) => {
    const body = JSON.parse(request.body);
    if (url.endsWith('/save')) {
      persistedMetadata = structuredClone(body.chat[0].chat_metadata);
      persistedMessages = structuredClone(body.chat.slice(1));
    }
    return { ok: true, json: async () => [{ chat_metadata: structuredClone(persistedMetadata) }, ...structuredClone(persistedMessages)] };
  };
  let uuidSequence = 0;
  const freshUuid = () => {
    uuidSequence += 1;
    if (uuidSequence === 1) return nextId;
    return `423e4567-e89b-42d3-a456-4266141740${String(uuidSequence).padStart(2, '0')}`;
  };
  const books = Object.fromEntries(['角色世界书', '人格世界书', '聊天世界书', '附加世界书', '全局世界书'].map(name => [name, { entries: { 1: { uid: 1, constant: true, content: `${name}的绑定正文` } } }]));
  const calendarReads = [];
  const manager = createChatMemoryManagement({ client, session, hostAdapter, foundationRuntime: foundation, memoryRuntime: memory, recallRuntime: { getState: () => ({}), invalidate() {}, clearCurrent() {} }, peopleRuntime: { getState: () => ({}), invalidate() {} }, autoHideController, fetchImpl,
    captureHistoricalRebuildSources: snapshot => captureHistoricalRebuildSources(snapshot, {
      worldInfoBindings: { getSelectedWorldInfo: () => ['全局世界书'], getWorldInfoSettings: () => ({ charLore: [{ name: 'char', extraBooks: ['附加世界书'] }] }), getWorldInfoNames: () => Object.keys(books), getDefaultCaseSensitive: () => false, getDefaultMatchWholeWords: () => false },
      getCharacterLorebooks: () => ({ primary: '角色世界书', additional: ['附加世界书'] }), getGlobalSelection: () => ['全局世界书'],
      loadWorldInfo: async name => books[name] ?? null,
    }),
    freshUuid,
    createHistoricalRebuild: options => runHistoricalRebuildTask({
    ...options, storyCalendarForChat: chatId => { calendarReads.push(chatId); return chatId === nextId ? { timezone: 'UTC' } : null; },
    onTaskControl: control => { historicalTaskControl = control; options.onTaskControl?.(control); }, client, fetchImpl, isEnabled: true, newUuid: freshUuid, sanitizerOptions: () => ({}), scanCandidates: scanAssistantCandidates,
    generateUtilityTask: utility, generateAnalysisTask: utility, automationSettings: () => ({ enabled: false, batchSize: 1 }),
    extractorPromptGuidance: () => '', csePromptGuidance: () => '', processingPrompt: () => '', storyClockReferenceTags: () => '',
    filterWorldInfoSources: sources => sources, persistAnchors: persistMessageFloorAnchors, logger: { warn() {} },
  }) });
  assert.equal((await manager.deleteCurrent()).status, 'completed');
  assert.equal([...records.keys()].some(key => key.startsWith(`chat-${CHAT_ID}/`)), false, '未知旧记录、workspace与time均无活动残留');
  assert.equal(context.chatMetadata.qianqianjie, undefined);
  assert.equal(session.getState().status, 'idle');
  assert.equal(prepareCalls, 0, '删除完成前未创建替代身份');
  const rebuildPromise = manager.fullRebuild(null);
  await firstExtractorStarted;
  assert.equal(persistedMetadata.qianqianjie.chatId, nextId, '进入实际提取调用前原A文件已持久化任务UUID');
  assert.ok(historicalTaskControl?.getState && historicalTaskControl?.subscribe && historicalTaskControl?.pause && historicalTaskControl?.start,
    '真实任务工厂向既有管理入口提供自身进度、暂停与续跑控制');
  let rebuilt;
  if (pauseAndResume) {
    const pause = manager.getState().pauseHistoricalRebuild;
    assert.equal(typeof pause, 'function', '可见A的管理状态转发真实任务暂停入口');
    await pause();
    releaseFirstExtractor();
    const paused = await rebuildPromise;
    assert.equal(paused.rebuildStatus, 'paused', `生产任务控制可在真实CSE阶段暂停：${JSON.stringify({ task: historicalTaskControl.getState(), manager: manager.getState(), memory: memory.getState().lastAutoMemory })}`);
    assert.equal(paused.chatId, nextId);
    assert.equal(persistedMetadata.qianqianjie.chatId, nextId, '暂停前任务已将新UUID保存到原A文件');
    assert.equal(context.chatMetadata.qianqianjie.chatId, nextId, '暂停结果同步A的展示身份，避免后续普通prepare重新认领');
    assert.equal(session.getState().status, 'ready');
    assert.equal(session.identity().chatId, nextId, '暂停后可见A session身份与持久文件的新UUID一致');
    rebuilt = await manager.fullRebuild(null);
  } else {
    rebuilt = await rebuildPromise;
  }
  assert.equal(rebuilt.chatId, nextId);
  assert.equal(rebuilt.rebuildStatus, 'caughtUp');
  assert.deepEqual(calendarReads, [nextId], '新UUID只读取该目标自己的既有历法；无设置时与普通新身份provider一致');
  assert.equal(context.chatMetadata.qianqianjie.chatId, nextId, '完成后只将目标A结果接回仍显示的A上下文');
  assert.equal(prepareCalls, 0, '任务身份由固定目标 identity coordinator认领，不调用页面的legacy ensure');
  assert.equal(context.chat[1].mes, '旧回复仍保留');
  assert.equal(context.chat[0].is_system, false);
  assert.equal(context.chat[1].is_system, false);
  assert.equal(context.chat[0].extra.qianqianjieAutoHide, undefined);
  assert.equal(context.chat[1].extra.qianqianjieAutoHide, undefined);
  const rebuiltGraph = await store.readReachable();
  assert.deepEqual(context.chat[1].extra[MESSAGE_FLOOR_ANCHOR_KEY], { schemaVersion: 1, chatId: nextId, floorId: rebuiltGraph.floors[0].id }, '重构锚点只绑定新身份，不保留旧身份标记');
  assert.equal(rebuilt.rememberedCount, 1);
  assert.equal(rebuilt.cseReady, true);
  assert.equal(session.identity().chatId, persistedMetadata.qianqianjie.chatId, '成功接回后live session identity与A持久身份一致');
  assert.equal(context.chatMetadata.qianqianjie.chatId, persistedMetadata.qianqianjie.chatId, '成功接回后live A metadata与A持久身份一致');
  assert.equal(JSON.stringify(context.chat[1].extra[MESSAGE_FLOOR_ANCHOR_KEY]), JSON.stringify(persistedMessages[1].extra[MESSAGE_FLOOR_ANCHOR_KEY]), 'live A消息锚点与A持久文件一致');
  const sharedFoundation = foundation.getReachable();
  const sharedMemory = memory.getState();
  assert.equal(sharedFoundation.root.headCheckpointId, rebuiltGraph.root.headCheckpointId, '共享foundation已刷新到重构最终head');
  assert.equal(sharedMemory.rememberedCount, rebuiltGraph.floors.length, '共享memory coverage已刷新到最终floor覆盖');
  assert.equal(JSON.stringify(await store.readReachable()).includes(CHAT_ID), false, '真实新图不含旧UUID、旧人物与旧时间引用');
  assert.equal(requests.filter(request => request.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, pauseAndResume ? 2 : 1, '提取调用数符合完整执行或暂停后恢复');
  assert.equal(requests.filter(request => request.systemPrompt === CSE_SYSTEM_PROMPT).length, 1);
  const cseRequestText = JSON.stringify(requests.find(request => request.systemPrompt === CSE_SYSTEM_PROMPT));
  for (const source of ['角色设定', '可靠', '测试场景', '用户设定', '聊天作者注释', '角色世界书的绑定正文', '人格世界书的绑定正文', '聊天世界书的绑定正文', '附加世界书的绑定正文', '全局世界书的绑定正文']) {
    assert.ok(cseRequestText.includes(source), `实际历史重构 CSE 输入必须保留 A 来源：${source}`);
  }
  const extractorPayload = JSON.parse(requests.find(request => request.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).taskMessages[0].content).payload;
  assert.deepEqual(extractorPayload.precedingUserInput.map(item => item.content), ['原隐藏 USER'], '恢复后的 USER 必须重新进入前置输入来源');
  assert.ok(records.has(`chat-${nextId}/v3-root`), '删除旧标识后新身份可从保留正文正常初始化，不再落入 foreign marker');
 }
});
