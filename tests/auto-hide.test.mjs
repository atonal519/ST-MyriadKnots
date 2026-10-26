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
const aggregateCard = floors => ({ ...floors.at(-1), sourceFloorIds: floors.map(floor => floor.floorId),
  sourceAssistantSeqs: floors.map(floor => floor.assistantSeq), sourceMessageIndexes: floors.map(floor => floor.messageIndex) });

test('聚合来源覆盖与单楼混合逐楼延伸，保留边界可在聚合批次内部', () => {
  const chat = Array.from({ length: 12 }, (_, index) => [assistant(`第${index + 1}段`), user(`继续${index + 1}`)]).flat();
  const rows = completeFloors(chat);
  for (const floors of [[aggregateCard(rows.slice(0, 10)), aggregateCard(rows.slice(10))],
    [rows[0], aggregateCard(rows.slice(1, 7)), rows[7], aggregateCard(rows.slice(8))]]) {
    const plan = planAutoHide({ chat, memoryState: { ...stateFor(chat), floors }, keepAiCount: 3 });
    assert.equal(plan.keepFrom, 15);
    assert.deepEqual(plan.hideRanges, [{ start: 0, end: 14 }]);
  }
});

test('聚合缺口与未就绪CSE停止于已证实来源前缀，不取最大端点越过', () => {
  const chat = Array.from({ length: 12 }, (_, index) => [assistant(`第${index + 1}段`), user(`继续${index + 1}`)]).flat();
  const rows = completeFloors(chat);
  const missing = aggregateCard([...rows.slice(0, 6), ...rows.slice(7, 10)]);
  let plan = planAutoHide({ chat, memoryState: { ...stateFor(chat), floors: [missing, aggregateCard(rows.slice(10))] }, keepAiCount: 3 });
  assert.deepEqual(plan.hideRanges, [{ start: 0, end: 10 }], '缺少AI7，只能确认AI1–6');
  const pending = { ...aggregateCard(rows.slice(1, 7)), cse: { status: 'pending' } };
  plan = planAutoHide({ chat, memoryState: { ...stateFor(chat), floors: [rows[0], pending, aggregateCard(rows.slice(7))] }, keepAiCount: 3 });
  assert.deepEqual(plan.hideRanges, [{ start: 0, end: 0 }], '整批共用CSE未完成，不能推进任何成员');
});

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
  let plan = planAutoHide({ chat, memoryState: stateFor(chat), keepAiCount: 1 });
  assert.equal(plan.keepFrom, 1, '最近 N 条历史 AI 外还保留当前回复槽位');
  assert.equal(plan.hideThrough, 0); assert.deepEqual(plan.hideRanges, [{ start: 0, end: 0 }]);

  const incomplete = stateFor(chat); incomplete.floors[0] = { ...incomplete.floors[0], cse: { status: 'pending', deltaId: null } };
  plan = planAutoHide({ chat, memoryState: incomplete, keepAiCount: 1 });
  assert.equal(plan.hideThrough, null); assert.deepEqual(plan.hideRanges, [], '最早 CSE 缺口之前没有可靠连续覆盖时不得隐藏');

  chat[3].is_system = true;
  plan = planAutoHide({ chat, memoryState: stateFor(chat), keepAiCount: 1 });
  assert.equal(plan.keepFrom, 1, '已隐藏的普通 AI 仍计入最近 N 条，不得让记忆序号漂移');

  const withNarrator = [assistant('旧 AI'), user('旧 user'), { is_user: false, is_system: '', mes: '旁白', extra: { type: 'narrator' } }, assistant('comment AI', { type: 'comment' }), user('新 user'), assistant('最新 AI')];
  plan = planAutoHide({ chat: withNarrator, memoryState: stateFor(withNarrator), keepAiCount: 1 });
  assert.equal(plan.keepFrom, 1, 'narrator 不得占用历史 AI 窗口，comment 仍是 AI');
  assert.deepEqual(plan.hideRanges, [{ start: 0, end: 0 }], '旁白不得被自动隐藏接管');
});

test('明确排除的稳定楼不打断后续楼的连续自动隐藏覆盖', () => {
  const chat = [assistant('不计入记忆', { qianqianjie_memory_excluded: true }), assistant('已记录楼'), user('后续提问'), assistant('最新回复')];
  const floors = completeFloors(chat).map((floor, index) => index === 0
    ? { ...floor, memoryId: null, memoryExcluded: true, status: 'excluded', cse: null }
    : floor);
  const plan = planAutoHide({ chat, memoryState: { chatId: CHAT, memorySnapshotStatus: 'ready', floors }, keepAiCount: 1 });
  assert.equal(plan.hideThrough, 0);
  assert.deepEqual(plan.hideRanges, [{ start: 0, end: 0 }]);
});

test('自动隐藏额外保留当前可被roll移除的一条AI，但最大设置仍保留51条', () => {
  const chat = Array.from({ length: 52 }, (_, index) => assistant(`第${index + 1}楼`));
  const plan = planAutoHide({ chat, memoryState: stateFor(chat), keepAiCount: 50 });
  assert.equal(plan.keepFrom, 1, '50条历史AI之外还需留下当前回复槽位');
  assert.equal(plan.hideThrough, 0);
  assert.deepEqual(plan.hideRanges, [{ start: 0, end: 0 }]);
});

test('归档冻结前缀不以当前聊天同位置正文证明覆盖，后续活动楼仍可正常连续隐藏', () => {
  const chat = [user('当前前缀'), assistant('B活动楼一'), user('继续'), assistant('B活动楼二'), user('新输入'), assistant('最新')];
  const base = stateFor(chat);
  const floors = base.floors.filter(floor => floor.messageIndex === 1 || floor.messageIndex === 3);
  const state = { ...base, migrationAliases: [], floors: [
    { ...base.floors[0], frozen: true, messageIndex: 0 },
    ...floors.map(floor => ({ ...floor, assistantSeq: floor.assistantSeq + 1 })),
  ] };
  const plan = planAutoHide({ chat, memoryState: state, keepAiCount: 1 });
  assert.equal(plan.hideThrough, 1);
  assert.deepEqual(plan.hideRanges, [{ start: 0, end: 1 }]);
});

test('宿主命令只处理可见目标并写稳定聊天标记；调大 N 保持隐藏，关闭只恢复千千结自有范围', async () => {
  const chat = [user('旧输入'), assistant('旧回复'), event('narrator_note'), user('中间输入'), assistant('中间回复'), user('最新输入'), assistant('最新回复')];
  chat[2].extra.keep = true;
  const commands = [];
  const h = harness({ chat, enabled: true, keepAiCount: 1, execute: commandExecutor(chat, commands) });
  const applied = await h.controller.reconcile();
  assert.equal(applied.status, 'applied'); assert.deepEqual(commands, ['/hide 0-1']);
  for (const index of [0, 1]) {
    assert.equal(chat[index].is_system, true);
    assert.deepEqual(chat[index].extra[AUTO_HIDE_MARKER_KEY], { schemaVersion: 1, chatId: CHAT });
  }
  assert.equal(chat[2].is_system, true); assert.equal(chat[2].extra[AUTO_HIDE_MARKER_KEY], undefined, '宿主系统事件不接管');
  assert.equal(chat[5].is_system, false); assert.equal(chat[6].is_system, false);

  h.values.autoHideKeepAiCount = 3;
  const expanded = await h.controller.applySettings({ enabled: true, keepAiCount: 3 });
  assert.equal(expanded.status, 'unchanged'); assert.deepEqual(commands, ['/hide 0-1']);
  for (const index of [0, 1]) { assert.equal(chat[index].is_system, true); assert.equal(chat[index].extra?.[AUTO_HIDE_MARKER_KEY]?.chatId, CHAT); }

  await h.controller.applySettings({ enabled: false });
  assert.deepEqual(commands, ['/hide 0-1', '/unhide 0-1']);
  for (const index of [0, 1]) { assert.equal(chat[index].is_system, false); assert.equal(chat[index].extra?.[AUTO_HIDE_MARKER_KEY], undefined); }

  chat[0].is_system = true; chat[0].extra = { manuallyHidden: true };
  chat[1].is_system = true; chat[1].extra = { [AUTO_HIDE_MARKER_KEY]: { schemaVersion: 1, chatId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } };
  h.values.autoHideKeepAiCount = 1; await h.controller.applySettings({ enabled: true, keepAiCount: 1 });
  assert.equal(chat[0].extra[AUTO_HIDE_MARKER_KEY], undefined, '人工预隐藏消息不得补写所有权标记');
  h.values.autoHideEnabled = false; await h.controller.applySettings({ enabled: false });
  assert.equal(chat[0].is_system, true); assert.deepEqual(chat[0].extra, { manuallyHidden: true });
  assert.equal(chat[1].is_system, true); assert.equal(chat[1].extra[AUTO_HIDE_MARKER_KEY].chatId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '其他聊天标记不得接管');
});

test('摘要与 CSE 状态、连续覆盖回退及删尾缩窗都不得恢复既有隐藏，覆盖恢复后只追加隐藏', async () => {
  const chat = [user('旧输入'), assistant('旧回复'), user('中间输入'), assistant('中间回复'), user('最新输入'), assistant('最新回复')];
  const commands = [];
  const h = harness({ chat, enabled: true, keepAiCount: 1, execute: commandExecutor(chat, commands) });
  await h.controller.reconcile();
  assert.deepEqual(commands, ['/hide 0-1']);

  h.setMemoryState({ chatId: CHAT, memorySnapshotStatus: 'syncing', floors: [] });
  h.emit(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(commands, ['/hide 0-1'], '重读期间的空 floors 不是已确认覆盖回退，不得发送 unhide');
  assert.deepEqual(chat.flatMap((message, index) => message.is_system !== true ? [index] : []), [2, 3, 4, 5], '宿主按 !is_system 取上下文时仍只能看到保留窗口');

  h.setMemoryState({ ...stateFor(chat), activeCse: { floorId: 'floor-1' }, floors: stateFor(chat).floors.map((floor, index) => index === 0 ? { ...floor, cse: { status: 'running' } } : floor) });
  h.emit(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(commands, ['/hide 0-1'], 'CSE 在途状态不得临时恢复完整历史');

  h.setMemoryState({ ...stateFor(chat), activeExtraction: { floorId: 'floor-1' }, floors: stateFor(chat).floors.map((floor, index) => index === 0 ? { ...floor, status: 'running' } : floor) });
  h.emit(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(commands, ['/hide 0-1'], '摘要提取在途状态不得临时恢复完整历史');

  h.setMemoryState({ chatId: CHAT, memorySnapshotStatus: 'error', floors: [] });
  h.emit(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(commands, ['/hide 0-1'], '读取失败不得把未知状态冒充已确认空覆盖');

  h.setMemoryState({ chatId: CHAT, floors: [] });
  h.emit(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(commands, ['/hide 0-1'], '缺少 readiness 合同的状态不得当成已确认空覆盖');

  const unreliableStates = [
    { name: 'ready 空 floors', value: { chatId: CHAT, memorySnapshotStatus: 'ready', floors: [] } },
    { name: '首楼 CSE pending', patch: floors => [{ ...floors[0], cse: { status: 'pending' } }, ...floors.slice(1)] },
    { name: '首楼 CSE failed', patch: floors => [{ ...floors[0], cse: { status: 'failed' } }, ...floors.slice(1)] },
    { name: '首楼摘要缺失', patch: floors => [{ ...floors[0], memoryId: null }, ...floors.slice(1)] },
    { name: '序号错位', patch: floors => [{ ...floors[0], assistantSeq: 2 }, ...floors.slice(1)] },
    { name: '部分连续覆盖回退', patch: floors => floors.slice(0, 1) },
  ];
  for (const scenario of unreliableStates) {
    const base = stateFor(chat);
    h.setMemoryState(scenario.value ?? { ...base, floors: scenario.patch(base.floors) });
    const result = await h.controller.reconcile();
    assert.deepEqual(result.unhideRanges, [], `${scenario.name} 的普通规划不得生成恢复范围`);
    assert.deepEqual(commands, ['/hide 0-1'], `${scenario.name} 不得发送 unhide`);
    assert.deepEqual(chat.flatMap((message, index) => message.is_system !== true ? [index] : []), [2, 3, 4, 5], `${scenario.name} 后宿主仍看不到原隐藏历史`);
  }

  chat.push(user('新输入'), assistant('新回复'));
  h.setMemoryState(stateFor(chat));
  const appended = await h.controller.reconcile();
  assert.equal(appended.status, 'applied');
  assert.deepEqual(commands, ['/hide 0-1', '/hide 2-3'], '覆盖可靠后只追加隐藏新越界范围');
  assert.deepEqual(appended.unhideRanges, []);

  chat.splice(-2, 2);
  h.setMemoryState(stateFor(chat));
  const shortened = await h.controller.reconcile();
  assert.equal(shortened.status, 'unchanged'); assert.deepEqual(shortened.unhideRanges, []);
  assert.deepEqual(commands, ['/hide 0-1', '/hide 2-3'], '删除尾楼缩短窗口不得恢复旧范围');
  assert.deepEqual(chat.flatMap((message, index) => message.is_system !== true ? [index] : []), [4, 5], '删尾后仍保留设置要求的历史AI');

  await h.controller.applySettings({ enabled: false });
  assert.deepEqual(commands, ['/hide 0-1', '/hide 2-3', '/unhide 0-3'], '显式恢复仍可恢复当前聊天剩余自有范围');
});

test('原生命令resolve但可见性尚未同步时仍保留自有标记', async () => {
  const chat = [assistant('更早'), user('旧输入'), assistant('旧回复'), event('note'), user('中间输入'), assistant('中间回复'), user('较新输入'), assistant('较新回复'), user('最新输入'), assistant('最新回复')];
  const commands = [];
  const apply = commandExecutor(chat, commands);
  const h = harness({ chat, execute: async command => {
    if (command === '/hide 4-5') { commands.push(command); return; }
    return apply(command);
  } });
  assert.equal((await h.controller.reconcile()).status, 'applied');
  assert.deepEqual(commands, ['/hide 0-2', '/hide 4-5']);
  for (const index of [0, 1, 2]) { assert.equal(chat[index].is_system, true); assert.equal(chat[index].extra[AUTO_HIDE_MARKER_KEY].chatId, CHAT); }
  for (const index of [4, 5]) { assert.equal(chat[index].is_system, false); assert.equal(chat[index].extra?.[AUTO_HIDE_MARKER_KEY]?.chatId, CHAT); }
});

test('原生命令失败只回退自有marker，保留宿主状态及其它插件extra', async () => {
  const chat = [user('更早输入'), assistant('更早回复'), user('旧输入'), assistant('旧回复'), user('最新输入'), assistant('最新回复')];
  const commands = [];
  const apply = commandExecutor(chat, commands, { failOnce: true });
  const h = harness({ chat, execute: async command => {
    try { await apply(command); } finally { chat[0].extra.otherPlugin = { saved: true }; }
  } });
  await assert.rejects(h.controller.reconcile(), /模拟宿主持久化失败/);
  assert.equal(chat[0].is_system, true); assert.equal(chat[1].is_system, true);
  assert.deepEqual(chat[0].extra, { otherPlugin: { saved: true } });
  assert.equal(chat[1].extra?.[AUTO_HIDE_MARKER_KEY], undefined);
  assert.equal(h.notices.length, 1);
  assert.deepEqual(commands, ['/hide 0-1']);
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

  const chat = [assistant('更早'), user('旧输入'), assistant('旧回复'), event('note'), user('中间输入'), assistant('中间回复'), user('较新输入'), assistant('较新回复'), user('新输入'), assistant('新回复')];
  const commands = [];
  let release, startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const applyCommand = commandExecutor(chat, commands);
  const h = harness({ chat, enabled: true, keepAiCount: 1, execute: async command => { startedResolve(); await new Promise(resolve => { release = resolve; }); return applyCommand(command); } });
  const pending = h.controller.reconcile();
  const queued = h.controller.reconcile();
  await started;
  let stopSettled = false;
  const stopping = h.controller.stop().then(() => { stopSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopSettled, false, 'stop 必须等待已经在途的宿主命令收束');
  release();
  await stopping;
  const stopped = await pending;
  assert.equal((await queued).status, 'stopped', 'stop 前已排队的旧任务不得再发送新命令');
  assert.equal(stopped.status, 'stopped'); assert.deepEqual(commands, ['/hide 0-2']);
  assert.equal(chat[0].is_system, true); assert.equal(chat[4].is_system, false, '总开关停止后不得继续下一条范围命令');
});

test('宿主聊天切换或 metadata 尚未绑定当前稳定 UUID 时不把旧计划写进新档', async () => {
  const chat = [user('更早'), assistant('更早'), user('旧'), assistant('旧'), user('新'), assistant('新')];
  const commands = [];
  const h = harness({ chat, enabled: true, keepAiCount: 1, execute: commandExecutor(chat, commands) });
  h.context.chatMetadata.qianqianjie.chatId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  assert.equal((await h.controller.reconcile()).status, 'stale'); assert.deepEqual(commands, []);

  h.context.chatMetadata.qianqianjie.chatId = CHAT;
  const apply = commandExecutor(chat, commands);
  h.context.executeSlashCommandsWithOptions = async command => { await apply(command); h.context.chatId = 'new-host-chat'; };
  assert.equal((await h.controller.reconcile()).status, 'applied');
  assert.deepEqual(commands, ['/hide 0-1'], '聊天切换后不得继续旧计划的后续范围');
  assert.equal(chat[0].is_system, true); assert.equal(chat[0].extra[AUTO_HIDE_MARKER_KEY].chatId, CHAT, '原生已完成结果不被后置页面状态反撤');

  const disposedChat = [user('旧'), assistant('旧'), user('新'), assistant('新')];
  const disposedCommands = [];
  const disposed = harness({ chat: disposedChat, execute: commandExecutor(disposedChat, disposedCommands) });
  disposed.controller.dispose();
  assert.equal((await disposed.controller.reconcile()).status, 'disposed'); assert.deepEqual(disposedCommands, []);
});

test('原生命令明确失败或中止结果撤销自有marker，解析错误交宿主抛出且保留宿主状态', async () => {
  for (const flag of ['isError', 'isAborted']) {
    const chat = [user('旧输入'), assistant('旧楼'), user('中间'), assistant('中间楼'), user('继续'), assistant('新楼')];
    let commandOptions;
    const h = harness({ chat, execute: async (_command, options) => {
      commandOptions = options;
      chat[0].is_system = true;
      chat[0].extra.otherPlugin = { changed: true };
      return { [flag]: true };
    } });
    await assert.rejects(h.controller.reconcile(), error => error.code === 'QQJ_AUTO_HIDE_COMMAND_FAILED');
    assert.equal(commandOptions.handleParserErrors, false);
    assert.equal(chat[0].is_system, true);
    assert.deepEqual(chat[0].extra, { otherPlugin: { changed: true } });
    assert.equal(chat[1].extra?.[AUTO_HIDE_MARKER_KEY], undefined);
  }
});
