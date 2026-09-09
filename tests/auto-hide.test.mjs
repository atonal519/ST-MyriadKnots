import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_HIDE_MARKER_KEY, createAutoHideController, planAutoHide } from '../src/v3/auto-hide.js';
import { selectAssistantMessage } from '../src/v3/foundation-domain.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const user = text => ({ is_user: true, is_system: false, mes: text });
const assistant = (text, extra = {}) => ({ is_user: false, is_system: false, mes: text, extra });
const event = type => ({ is_user: false, is_system: true, mes: '', extra: { type } });
const completeFloors = chat => {
  let assistantSeq = 0;
  return chat.flatMap((message, messageIndex) => {
    if (!selectAssistantMessage(message)) return [];
    assistantSeq += 1;
    return [{ floorId: `floor-${assistantSeq}`, assistantSeq, messageIndex, memoryId: `memory-${assistantSeq}`, status: 'ready', cse: { status: 'ready', deltaId: `delta-${assistantSeq}` } }];
  });
};
const stateFor = chat => ({ chatId: CHAT, memorySnapshotStatus: 'ready', floors: completeFloors(chat) });

function harness({ chat, enabled = true, keepAiCount = 1, execute } = {}) {
  const listeners = new Set();
  const context = {
    chatId: 'host-chat', chat, chatMetadata: { qianqianjie: { schemaVersion: 2, chatId: CHAT } },
    executeSlashCommandsWithOptions: execute,
  };
  const hostAdapter = { snapshot: () => ({ context, chat: context.chat, chatId: context.chatId }) };
  let memoryState = stateFor(context.chat);
  const memoryRuntime = { getState: () => memoryState, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  const values = { pluginEnabled: true, autoHideEnabled: enabled, autoHideKeepAiCount: keepAiCount };
  const settings = { get: () => values };
  const notices = [];
  const controller = createAutoHideController({ hostAdapter, memoryRuntime, settings, notifyUser: value => notices.push(value), logger: { warn() {} } });
  return { controller, context, values, notices, emit() { for (const listener of listeners) listener(memoryRuntime.getState()); }, setMemoryState(value) { memoryState = value; } };
}

function commandExecutor(chat, commands, { failOnce = false } = {}) {
  let shouldFail = failOnce;
  return async command => {
    commands.push(command);
    const [, kind, rangeText] = command.match(/^\/(hide|unhide) (\d+(?:-\d+)?)$/) ?? [];
    assert.ok(kind && rangeText, command);
    const [start, end = start] = rangeText.split('-').map(Number);
    for (let index = start; index <= end; index += 1) chat[index].is_system = kind === 'hide';
    if (shouldFail) { shouldFail = false; throw new Error('模拟宿主持久化失败'); }
  };
}

test('计划按最近 N 个真实 AI 的上一 AI 边界保留整段用户上下文，并受连续摘要+CSE上界约束', () => {
  const chat = [assistant('旧一'), user('连续输入一'), user('连续输入二'), assistant('旧二'), user('新输入'), assistant('最新')];
  let plan = planAutoHide({ chat, memoryState: stateFor(chat), keepAiCount: 2 });
  assert.equal(plan.keepFrom, 1, '最近两条 AI 的保留窗口必须从上一 AI 之后开始');
  assert.equal(plan.hideThrough, 0); assert.deepEqual(plan.hideRanges, [{ start: 0, end: 0 }]);

  const incomplete = stateFor(chat); incomplete.floors[0] = { ...incomplete.floors[0], cse: { status: 'pending', deltaId: null } };
  plan = planAutoHide({ chat, memoryState: incomplete, keepAiCount: 1 });
  assert.equal(plan.hideThrough, null); assert.deepEqual(plan.hideRanges, [], '最早 CSE 缺口之前没有可靠连续覆盖时不得隐藏');

  chat[3].is_system = true;
  plan = planAutoHide({ chat, memoryState: stateFor(chat), keepAiCount: 2 });
  assert.equal(plan.keepFrom, 1, '已隐藏的普通 AI 仍计入最近 N 条，不得让记忆序号漂移');

  const withNarrator = [assistant('旧 AI'), user('旧 user'), { is_user: false, is_system: '', mes: '旁白', extra: { type: 'narrator' } }, assistant('comment AI', { type: 'comment' }), user('新 user'), assistant('最新 AI')];
  plan = planAutoHide({ chat: withNarrator, memoryState: stateFor(withNarrator), keepAiCount: 1 });
  assert.equal(plan.keepFrom, 4, 'narrator 不得占用最近 AI 窗口，comment 仍是 AI');
  assert.deepEqual(plan.hideRanges, [{ start: 0, end: 1 }, { start: 3, end: 3 }], '旁白不得被自动隐藏接管');
});

test('宿主命令只处理可见目标并写稳定聊天标记；调大 N 与关闭只恢复千千结自有范围', async () => {
  const chat = [user('旧输入'), assistant('旧回复'), event('narrator_note'), user('中间输入'), assistant('中间回复'), user('最新输入'), assistant('最新回复')];
  chat[2].extra.keep = true;
  const commands = [];
  const h = harness({ chat, enabled: true, keepAiCount: 1, execute: commandExecutor(chat, commands) });
  const applied = await h.controller.reconcile();
  assert.equal(applied.status, 'applied'); assert.deepEqual(commands, ['/hide 0-1', '/hide 3-4']);
  for (const index of [0, 1, 3, 4]) {
    assert.equal(chat[index].is_system, true);
    assert.deepEqual(chat[index].extra[AUTO_HIDE_MARKER_KEY], { schemaVersion: 1, chatId: CHAT });
  }
  assert.equal(chat[2].is_system, true); assert.equal(chat[2].extra[AUTO_HIDE_MARKER_KEY], undefined, '宿主系统事件不接管');
  assert.equal(chat[5].is_system, false); assert.equal(chat[6].is_system, false);

  h.values.autoHideKeepAiCount = 3;
  const expanded = await h.controller.applySettings({ enabled: true, keepAiCount: 3 });
  assert.equal(expanded.status, 'applied'); assert.deepEqual(commands.slice(-2), ['/unhide 0-1', '/unhide 3-4']);
  for (const index of [0, 1, 3, 4]) { assert.equal(chat[index].is_system, false); assert.equal(chat[index].extra?.[AUTO_HIDE_MARKER_KEY], undefined); }

  chat[0].is_system = true; chat[0].extra = { manuallyHidden: true };
  h.values.autoHideKeepAiCount = 1; await h.controller.applySettings({ enabled: true, keepAiCount: 1 });
  assert.equal(chat[0].extra[AUTO_HIDE_MARKER_KEY], undefined, '人工预隐藏消息不得补写所有权标记');
  h.values.autoHideEnabled = false; await h.controller.applySettings({ enabled: false });
  assert.equal(chat[0].is_system, true); assert.deepEqual(chat[0].extra, { manuallyHidden: true });
});

test('记忆重读空快照与在途分析不得恢复既有隐藏，确认覆盖回退与显式恢复仍生效', async () => {
  const chat = [user('旧输入'), assistant('旧回复'), user('中间输入'), assistant('中间回复'), user('最新输入'), assistant('最新回复')];
  const commands = [];
  const h = harness({ chat, enabled: true, keepAiCount: 1, execute: commandExecutor(chat, commands) });
  await h.controller.reconcile();
  assert.deepEqual(commands, ['/hide 0-3']);

  h.setMemoryState({ chatId: CHAT, memorySnapshotStatus: 'syncing', floors: [] });
  h.emit(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(commands, ['/hide 0-3'], '重读期间的空 floors 不是已确认覆盖回退，不得发送 unhide');
  assert.deepEqual(chat.flatMap((message, index) => message.is_system !== true ? [index] : []), [4, 5], '宿主按 !is_system 取上下文时仍只能看到保留窗口');

  h.setMemoryState({ ...stateFor(chat), activeCse: { floorId: 'floor-1' }, floors: stateFor(chat).floors.map((floor, index) => index === 0 ? { ...floor, cse: { status: 'running' } } : floor) });
  h.emit(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(commands, ['/hide 0-3'], 'CSE 在途状态不得临时恢复完整历史');

  h.setMemoryState({ ...stateFor(chat), activeExtraction: { floorId: 'floor-1' }, floors: stateFor(chat).floors.map((floor, index) => index === 0 ? { ...floor, status: 'running' } : floor) });
  h.emit(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(commands, ['/hide 0-3'], '摘要提取在途状态不得临时恢复完整历史');

  h.setMemoryState({ chatId: CHAT, memorySnapshotStatus: 'error', floors: [] });
  h.emit(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(commands, ['/hide 0-3'], '读取失败不得把未知状态冒充已确认空覆盖');

  h.setMemoryState({ chatId: CHAT, floors: [] });
  h.emit(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(commands, ['/hide 0-3'], '缺少 readiness 合同的状态不得当成已确认空覆盖');

  await h.controller.restoreOwned();
  assert.deepEqual(commands, ['/hide 0-3', '/unhide 0-3'], '显式恢复必须绕过 readiness 保护');
  h.setMemoryState(stateFor(chat));
  await h.controller.reconcile();
  assert.deepEqual(commands, ['/hide 0-3', '/unhide 0-3', '/hide 0-3']);

  const confirmedFallback = stateFor(chat);
  confirmedFallback.floors = confirmedFallback.floors.slice(0, 1);
  h.setMemoryState(confirmedFallback);
  h.emit(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(commands, ['/hide 0-3', '/unhide 0-3', '/hide 0-3', '/unhide 2-3'], '已确认覆盖回退仍须恢复不再可靠的范围');

  await h.controller.restoreOwned();
  assert.deepEqual(commands, ['/hide 0-3', '/unhide 0-3', '/hide 0-3', '/unhide 2-3', '/unhide 0-1'], '显式恢复仍可恢复剩余自有范围');
});

test('slash 在改动内存后失败会回滚可重试事实，下一次成功才留下隐藏与标记', async () => {
  const chat = [user('旧输入'), assistant('旧回复'), user('最新输入'), assistant('最新回复')];
  const commands = [];
  const h = harness({ chat, enabled: true, keepAiCount: 1, execute: commandExecutor(chat, commands, { failOnce: true }) });
  await assert.rejects(h.controller.reconcile(), /模拟宿主持久化失败/);
  assert.equal(chat[0].is_system, false); assert.equal(chat[1].is_system, false);
  assert.equal(chat[0].extra, undefined); assert.deepEqual(chat[1].extra, {}, '既有空 extra 必须原样恢复');
  assert.equal(h.notices.length, 1); assert.match(h.notices[0].text, /未完成.*重试/);
  const retried = await h.controller.reconcile();
  assert.equal(retried.status, 'applied'); assert.deepEqual(commands, ['/hide 0-1', '/hide 0-1']);
  assert.equal(chat[0].is_system, true); assert.equal(chat[0].extra[AUTO_HIDE_MARKER_KEY].chatId, CHAT);
});

test('默认关闭不执行；停止在途多范围任务后只允许已发命令落地，不再继续下一范围', async () => {
  const disabledChat = [user('旧'), assistant('旧'), user('新'), assistant('新')];
  const disabledCommands = [];
  const disabled = harness({ chat: disabledChat, enabled: false, keepAiCount: 1, execute: commandExecutor(disabledChat, disabledCommands) });
  disabled.emit(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(disabledCommands, []);
  disabled.values.pluginEnabled = false;
  disabled.values.autoHideEnabled = true;
  const pluginDisabled = await disabled.controller.applySettings({ enabled: true });
  assert.equal(pluginDisabled.status, 'disabled');
  assert.deepEqual(disabledCommands, [], '总开关关闭时显式设置也不得发送宿主命令');

  const chat = [user('旧输入'), assistant('旧回复'), event('note'), user('中间输入'), assistant('中间回复'), user('新输入'), assistant('新回复')];
  const commands = [];
  let release, startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const applyCommand = commandExecutor(chat, commands);
  const h = harness({ chat, enabled: true, keepAiCount: 1, execute: async command => { startedResolve(); await new Promise(resolve => { release = resolve; }); return applyCommand(command); } });
  const pending = h.controller.reconcile(); await started; h.controller.stop(); release();
  const stopped = await pending;
  assert.equal(stopped.status, 'stopped'); assert.deepEqual(commands, ['/hide 0-1']);
  assert.equal(chat[0].is_system, true); assert.equal(chat[3].is_system, false, '总开关停止后不得继续下一条范围命令');
});

test('宿主聊天切换或 metadata 尚未绑定当前稳定 UUID 时不把旧计划写进新档', async () => {
  const chat = [user('旧'), assistant('旧'), user('新'), assistant('新')];
  const commands = [];
  const h = harness({ chat, enabled: true, keepAiCount: 1, execute: commandExecutor(chat, commands) });
  h.context.chatMetadata.qianqianjie.chatId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  assert.equal((await h.controller.reconcile()).status, 'stale'); assert.deepEqual(commands, []);
});
