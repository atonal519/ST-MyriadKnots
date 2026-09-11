import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyInlineMessage, projectInlineMemoryFloor, projectInlineRecallReceipt } from '../src/ui/inline-projection.js';
import { createInlineRenderer, resolveInlineAnchor, resolveInlineMessageIndex } from '../src/ui/inline-renderer.js';
import { RECALL_RECEIPT_KEY } from '../src/v3/recall-runtime.js';
import { createV3RecallRuntime } from '../src/v3/recall-runtime.js';
import { readRecallSource } from '../src/v3/recall-source.js';
import { selectRecall } from '../src/v3/recall-selector.js';
import { formatRecallInjection } from '../src/v3/recall-selector.js';
import { compileCseResponse } from '../src/v3/cse-engine.js';
import { MESSAGE_FLOOR_ANCHOR_KEY } from '../src/v3/message-floor-anchor.js';

const MARKER_CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_CHAT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HISTORY_FLOOR = '11111111-1111-4111-8111-111111111111';
const CHANGE_FLOOR = '22222222-2222-4222-8222-222222222222';
const EXTRA_FLOOR = '33333333-3333-4333-8333-333333333333';

const withFloorMarker = (message, floorId, chatId = MARKER_CHAT, schemaVersion = 1) => ({
  ...message,
  extra: { ...(message.extra ?? {}), [MESSAGE_FLOOR_ANCHOR_KEY]: { schemaVersion, chatId, floorId } },
});

class FakeNode {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null; this.attributes = {}; this.dataset = {};
    this.className = ''; this.textContent = ''; this.hidden = false; this.disabled = false; this.style = {}; this.listeners = new Map(); this.shadowRoot = null;
  }
  get classList() { return { contains: value => this.className.split(/\s+/u).includes(value) }; }
  get isConnected() { let node = this; while (node) { if (node.__documentRoot) return true; node = node.parentElement ?? node.host ?? null; } return false; }
  append(...nodes) { for (const node of nodes) { node.remove?.(); node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...nodes); }
  remove() { if (!this.parentElement) return; const index = this.parentElement.children.indexOf(this); if (index >= 0) this.parentElement.children.splice(index, 1); this.parentElement = null; }
  setAttribute(name, value) {
    const text = String(value); this.attributes[name] = text;
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = text;
  }
  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
  addEventListener(name, handler) { const values = this.listeners.get(name) ?? []; values.push(handler); this.listeners.set(name, values); }
  emit(name, event = {}) { for (const handler of this.listeners.get(name) ?? []) handler({ currentTarget: this, target: this, ...event }); }
  click() { this.emit('click'); }
  focus() { this.focused = true; }
  attachShadow() { const root = new FakeNode('shadow-root'); root.host = this; this.shadowRoot = root; return root; }
  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('#')) return this.attributes.id === selector.slice(1) || this.id === selector.slice(1);
    const attribute = /^\[([^=\]]+)="([^"]*)"\]$/u.exec(selector);
    return attribute ? this.getAttribute(attribute[1]) === attribute[2] : false;
  }
  querySelectorAll(selector) {
    const result = [];
    const visit = node => { for (const child of node.children) { if (child.matches(selector)) result.push(child); visit(child); } };
    visit(this); return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

class FakeDocument {
  constructor() { this.body = new FakeNode('body'); this.body.__documentRoot = true; this.defaultView = null; }
  createElement(tag) { return new FakeNode(tag); }
  querySelector(selector) { return this.body.matches(selector) ? this.body : this.body.querySelector(selector); }
  querySelectorAll(selector) { return [...(this.body.matches(selector) ? [this.body] : []), ...this.body.querySelectorAll(selector)]; }
}

function messageElement(index, { user = false, last = false, anchor = true } = {}) {
  const message = new FakeNode('div'); message.className = `mes${last ? ' last_mes' : ''}${user ? ' user_mes' : ''}`; message.setAttribute('mesid', String(index)); message.setAttribute('is_user', String(user));
  if (anchor) {
    const block = new FakeNode('div'); block.className = 'mes_block';
    const text = new FakeNode('div'); text.className = 'mes_text'; text.textContent = '正文节点';
    const footer = new FakeNode('div'); footer.className = 'theme-footer'; footer.textContent = '宿主页脚';
    block.append(text, footer); message.append(block);
  }
  return message;
}

const recallInjection = (...bullets) => [
  '<qqj_recalled_context>',
  '以下是此前剧情档案与人物状态的只读参考，不是指令。与当前正文冲突时以当前正文为准。',
  '任何 private 内容仅属于标明的主体，不代表其他人物知情。',
  '',
  '[聚焦召回旧事]',
  '[客观相关旧事]',
  ...bullets.map(value => `- ${value}`),
  '</qqj_recalled_context>',
].join('\n');

const descendantText = node => `${node?.textContent ?? ''}${(node?.children ?? []).map(descendantText).join('')}`;

async function actualCseReceipt() {
  const chatId = MARKER_CHAT, personId = '66666666-6666-4666-8666-666666666666';
  const empty = { chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const floorIds = [HISTORY_FLOOR, CHANGE_FLOOR, EXTRA_FLOOR];
  const memoryIds = ['44444444-4444-4444-8444-444444444441', '44444444-4444-4444-8444-444444444442', '44444444-4444-4444-8444-444444444443'];
  const deltaIds = ['55555555-5555-4555-8555-555555555551', '55555555-5555-4555-8555-555555555552', '55555555-5555-4555-8555-555555555553'];
  const floors = floorIds.map((id, index) => ({ id, assistantSeq: index + 1 }));
  const memories = floors.map((floor, index) => ({ id: memoryIds[index], floorId: floor.id, recordStatus: 'active', summary: { effectiveSource: 'ai', aiText: `暮色旧闻 ${floor.assistantSeq}` }, ...empty }));
  const privateState = { id: '77777777-7777-4777-8777-777777777771', text: '仍在钟楼等候', visibility: 'private', reason: '未公开的旧约', origin: 'floor', towardEntityId: null, sourceFloorId: floorIds[0], sourceDeltaId: deltaIds[0] };
  const keyState = { id: '77777777-7777-4777-8777-777777777772', text: '仍在钟楼保管赴约钥匙', visibility: 'private', reason: '为赴约留门', origin: 'floor', towardEntityId: null, sourceFloorId: floorIds[0], sourceDeltaId: deltaIds[0] };
  const returnedState = { id: '77777777-7777-4777-8777-777777777773', text: '已经回到钟楼准备赴约', visibility: 'private', reason: '重新履行旧约', origin: 'floor', towardEntityId: null, sourceFloorId: floorIds[2], sourceDeltaId: deltaIds[2] };
  const headId = '88888888-8888-4888-8888-888888888888';
  const trackedBindings = [{ entityId: personId, labels: ['裴晚生', '阿裴'], specialRole: 'char' }];
  const compile = async (index, situational, previousCurrentState) => compileCseResponse({
    response: { subjects: [{ subject: '裴晚生', situational }] },
    envelope: { scope: { floorId: floorIds[index], floorMemoryId: memoryIds[index], chatId, narrativeGeneration: OTHER_CHAT, baselineId: '99999999-9999-4999-8999-999999999999', trackedBindings, knownBindings: trackedBindings, evidenceSources: [], coreUserEditedSubjectEntityIds: [] } },
    previousCurrentState,
    now: '2026-09-10T00:00:00.000Z',
    deltaId: deltaIds[index],
  });
  const first = await compile(0, [
    { text: privateState.text, visibility: privateState.visibility, reason: privateState.reason },
    { text: keyState.text, visibility: keyState.visibility, reason: keyState.reason },
  ], null);
  const firstState = { id: deltaIds[0], subjects: first.delta.subjectSnapshots };
  const second = await compile(1, [], firstState);
  const secondState = { id: deltaIds[1], subjects: second.delta.subjectSnapshots };
  const third = await compile(2, [
    { text: returnedState.text, visibility: returnedState.visibility, reason: returnedState.reason },
  ], secondState);
  const reachable = { status: 'ready', rootRevision: 1, root: { chatId, narrativeGeneration: OTHER_CHAT, headCheckpointId: headId }, checkpoint: { id: headId }, baseline: { id: '99999999-9999-4999-8999-999999999999' }, floors, floorMemories: memories, currentStates: [], entities: [{ id: personId, entityType: 'person', displayName: '裴晚生', aliases: [{ name: '阿裴' }], specialRole: 'char', recordStatus: 'active', status: 'established' }], stateDeltas: [first.delta, second.delta, third.delta] };
  const userMessage = { is_user: true, is_system: false, mes: '阿裴，我们回钟楼赴约。' };
  const chat = [{ is_user: false, is_system: false, mes: '当前正文' }, userMessage];
  const context = { chatMetadata: { qianqianjie: { chatId } }, constants: { promptTypes: { IN_CHAT: 1 }, promptRoles: { SYSTEM: 0 } }, setExtensionPrompt() {}, async saveChat() {} };
  const runtime = createV3RecallRuntime({ store: { readReachable: async () => structuredClone(reachable) }, hostAdapter: { snapshot: () => ({ context, chat }) }, sourceReader: ({ now }) => readRecallSource({ store: { readReachable: async () => structuredClone(reachable) }, now }), selector: selectRecall, pluginVersion: '0.1.8-test', now: () => new Date('2026-09-10T00:00:00.000Z'), logger: { warn() {} } });
  const state = await runtime.intercept(chat, 12000, null, 'normal');
  assert.equal(state.lastRecall.status, 'ready');
  return { chat, userMessage, receipt: userMessage.extra[RECALL_RECEIPT_KEY], floorIds };
}

function createHarness({ chat, memoryState, recallState = { recallStatus: 'idle', activeRecall: null, lastRecall: null }, projectReceipt, chatId = 'chat-a' } = {}) {
  const documentRef = new FakeDocument(), chatRoot = new FakeNode('main'); chatRoot.id = 'chat'; chatRoot.setAttribute('id', 'chat'); documentRef.body.append(chatRoot);
  const handlers = new Map(), memorySubscribers = new Set(), recallSubscribers = new Set(), extractionCalls = [];
  const eventTypes = Object.fromEntries(['CHAT_CHANGED', 'CHAT_RENAMED', 'MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MORE_MESSAGES_LOADED', 'GENERATION_ENDED'].map(name => [name, name]));
  const eventSource = {
    on(name, handler) { const values = handlers.get(name) ?? []; values.push(handler); handlers.set(name, values); },
    removeListener(name, handler) { handlers.set(name, (handlers.get(name) ?? []).filter(value => value !== handler)); },
  };
  const timers = new Map(); let timerId = 0;
  const observers = [];
  class Observer {
    constructor(callback) { this.callback = callback; this.active = false; observers.push(this); }
    observe(_root, options) { this.active = true; this.options = options; }
    disconnect() { this.active = false; }
    trigger() { if (this.active) this.callback([]); }
  }
  const windowRef = {
    MutationObserver: Observer,
    setTimeout(handler, delay) { const id = ++timerId; timers.set(id, { handler, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const context = { chatMetadata: { qianqianjie: { chatId } } };
  const snapshot = { chat, chatId: 'host-chat-a', context, eventSource, eventTypes };
  const memoryRuntime = {
    getState: () => memoryState,
    extractFloor: async (...args) => { extractionCalls.push(args); return memoryState; },
    subscribe(handler) { memorySubscribers.add(handler); return () => memorySubscribers.delete(handler); },
  };
  const recallRuntime = { getState: () => recallState, subscribe(handler) { recallSubscribers.add(handler); return () => recallSubscribers.delete(handler); } };
  let snapshotCalls = 0;
  const hostAdapter = { snapshot: () => { snapshotCalls += 1; return snapshot; } };
  const renderer = createInlineRenderer({ memoryRuntime, recallRuntime, hostAdapter, documentRef, windowRef, projectReceipt, logger: { warn() {} } });
  const emit = (name, ...args) => { for (const handler of handlers.get(name) ?? []) handler(...args); };
  const flushMicrotasks = async () => { await Promise.resolve(); await Promise.resolve(); await new Promise(resolve => setImmediate(resolve)); };
  const runNextTimer = () => { const next = [...timers].sort((a, b) => a[0] - b[0])[0]; if (!next) return false; timers.delete(next[0]); next[1].handler(); return true; };
  return { documentRef, chatRoot, context, snapshot, memoryRuntime, recallRuntime, renderer, handlers, observers, timers, extractionCalls, memorySubscribers, recallSubscribers, emit, flushMicrotasks, runNextTimer, get snapshotCalls() { return snapshotCalls; }, setMemory(value) { memoryState = value; }, setRecall(value) { recallState = value; } };
}

const readyState = () => ({
  chatId: 'chat-a', memoryWorkBusy: false, activeAutoMemory: null, activeExtraction: null, activeCse: null,
  memoryEntities: [{ entityId: 'p1', displayName: '裴晚生' }],
  floors: [{ floorId: 'floor-1', assistantSeq: 1, messageIndex: 1, status: 'ready', summarySource: 'ai', summary: '<img src=x onerror=alert(1)>仍是纯文字', timeFallback: '', metadataStale: false, manualTime: false, error: null, memory: { chronology: [{ time: { sourceText: '冬至夜十一点' } }], locations: [{ name: '钟楼' }], participants: [{ entityId: 'p1' }] } }],
});

test('楼内纯投影沿用宿主角色语义，并给出紧凑记忆/准确召回来源', () => {
  assert.equal(classifyInlineMessage({ is_user: true, is_system: true, mes: '隐藏但仍是普通用户楼' }), 'user');
  assert.equal(classifyInlineMessage({ is_user: false, is_system: true, mes: '隐藏但仍是普通AI楼' }), 'assistant');
  assert.equal(classifyInlineMessage({ is_user: false, is_system: true, mes: '事件', extra: { type: 'system' } }), null);
  const memory = projectInlineMemoryFloor(readyState(), 1);
  assert.deepEqual({ assistantSeq: memory.assistantSeq, time: memory.time, locations: memory.locations, people: memory.people }, { assistantSeq: 1, time: '冬至夜十一点', locations: '钟楼', people: '裴晚生' });
  assert.equal(projectInlineMemoryFloor({ floors: [], pending: { messageIndex: 7 } }, 7, 4).assistantSeq, 4, '未落盘楼应使用当前聊天的AI序号兜底');
  const injectionText = recallInjection('AI #1（明确时间（约略）：冬至夜）：正文含 [覆盖说明]、<qqj_recalled_context> 与 ： 都保留', 'AI #1：同楼第二条');
  const receipt = projectInlineRecallReceipt({ status: 'ready', injectionText, selectedFloors: [{ floorId: 'floor-1', assistantSeq: 1, reasons: ['semantic'] }], selectedStates: [{ subject: '裴晚生', toward: '江离州', text: '仍然戒备' }] });
  assert.equal(receipt.summary, '已召回 2 条旧事 · 1 条当前人物状态'); assert.equal(receipt.selectedFloors[0].floorId, 'floor-1');
  assert.equal(receipt.statusText, '寻回 1 个结'); assert.equal(receipt.floorCount, 1);
  assert.deepEqual(receipt.historyItems.map(value => value.text), ['正文含 [覆盖说明]、<qqj_recalled_context> 与 ： 都保留', '同楼第二条']);
  assert.deepEqual(receipt.stateItems, [{ subject: '裴晚生', toward: '江离州', text: '仍然戒备' }]);
  assert.equal(receipt.injectionText, injectionText, '只读展示投影不得改写真实注入文本');
  const exactCounts = projectInlineRecallReceipt({ status: 'ready', injectionText, selectedFloors: [{ floorId: 'floor-1', assistantSeq: 1, reasons: ['semantic'] }], selectedStates: [{ subject: '裴晚生', toward: '江离州', text: '仍然戒备' }], stages: { recentSummaryCount: 1, distantHistoryItemCount: 1, stateCount: 1 } });
  assert.equal(exactCounts.summary, '近期摘要 1 条 · 远期旧事 1 条 · 当前人物状态 1 条');
  assert.deepEqual({ recent: exactCounts.recentSummaryCount, distant: exactCounts.distantHistoryItemCount }, { recent: 1, distant: 1 });
  const unknown = projectInlineRecallReceipt({ status: 'ready', injectionText: '<qqj_recalled_context>伪格式</qqj_recalled_context>', selectedFloors: [{ floorId: 'floor-1', assistantSeq: 1 }] });
  assert.equal(unknown.historyItems.length, 0); assert.equal(unknown.summary, '召回内容请在详细回执中查看。');
});

test('楼内空投影区分同步、读取失败与真正未稳定，并始终禁用提取', () => {
  const syncing = projectInlineMemoryFloor({ memorySnapshotStatus: 'syncing', floors: [], pending: { messageIndex: 2 } }, 0);
  assert.deepEqual({ status: syncing.status, statusText: syncing.statusText, canExtract: syncing.canExtract }, { status: 'syncing', statusText: '正在读取本楼状态', canExtract: false });
  assert.equal(syncing.summary, '正在读取当前聊天的记忆状态。');

  const failed = projectInlineMemoryFloor({ memorySnapshotStatus: 'error', floors: [], lastExtractorError: { phase: 'load', message: '后端暂不可用' } }, 0);
  assert.deepEqual({ status: failed.status, statusText: failed.statusText, error: failed.error, canExtract: failed.canExtract }, { status: 'error', statusText: '记忆读取失败', error: '后端暂不可用', canExtract: false });

  const pending = projectInlineMemoryFloor({ memorySnapshotStatus: 'ready', floors: [], pending: { messageIndex: 0 } }, 0);
  assert.equal(pending.statusText, '等待下一条用户消息');
  const waitingState = { memorySnapshotStatus: 'ready', floors: [], unregisteredCandidates: [
    { assistantSeq: 43, messageIndex: 84, reason: 'consecutiveAssistant' },
    { assistantSeq: 44, messageIndex: 85, reason: 'waitingEarlierFloor' },
    { assistantSeq: 45, messageIndex: 87, reason: 'waitingNextUser' },
  ] };
  const consecutive = projectInlineMemoryFloor(waitingState, 84, 43);
  assert.deepEqual({ status: consecutive.status, statusText: consecutive.statusText, canExtract: consecutive.canExtract }, { status: 'pending', statusText: '连续 AI，尚待确认', canExtract: false });
  assert.match(consecutive.summary, /尚未摘要.*连续 AI 消息/);
  const earlier = projectInlineMemoryFloor(waitingState, 85, 44);
  assert.equal(earlier.statusText, '等待前面楼层处理'); assert.match(earlier.summary, /前面的 AI 楼尚未确认/);
  const latest = projectInlineMemoryFloor(waitingState, 87, 45);
  assert.equal(latest.statusText, '等待下一条用户消息'); assert.match(latest.summary, /尚未摘要.*下一条用户消息/);
  const unavailable = projectInlineMemoryFloor({ memorySnapshotStatus: 'ready', floors: [], pending: { messageIndex: 2 } }, 0);
  assert.equal(unavailable.statusText, '尚未读取本楼状态');
});

test('楼内待摘要候选按实际宿主楼号显示，缺少 floorId 时点击也不能发起提取', async () => {
  const chat = Array.from({ length: 88 }, (_, index) => ({ is_user: true, is_system: true, mes: `占位 ${index}`, extra: { type: 'system' } }));
  chat[84] = { is_user: false, is_system: false, mes: 'A84' };
  chat[85] = { is_user: false, is_system: false, mes: 'A85' };
  chat[87] = { is_user: false, is_system: false, mes: 'A87' };
  const memoryState = { chatId: 'chat-a', memorySnapshotStatus: 'ready', floors: [], unregisteredCandidates: [
    { assistantSeq: 43, messageIndex: 84, reason: 'consecutiveAssistant' },
    { assistantSeq: 44, messageIndex: 85, reason: 'waitingEarlierFloor' },
    { assistantSeq: 45, messageIndex: 87, reason: 'waitingNextUser' },
  ] };
  const h = createHarness({ chat, memoryState });
  const elements = [84, 85, 87].map(index => messageElement(index)); elements.forEach(node => h.chatRoot.append(node));
  h.renderer.start(); await h.flushMicrotasks();
  const views = elements.map(element => resolveInlineAnchor(element).querySelector('[data-qqj-inline-host="true"]').__qqjInlineCard);
  assert.deepEqual(views.map(view => view.title.textContent), ['第 84 个结', '第 85 个结', '第 87 个结']);
  assert.deepEqual(views.map(view => view.status.textContent), ['连续 AI，尚待确认', '等待前面楼层处理', '等待下一条用户消息']);
  assert.ok(views.every(view => view.extract.disabled));
  views.forEach(view => view.extract.emit('click'));
  await h.flushMicrotasks();
  assert.deepEqual(h.extractionCalls, []);
});

test('读取失败与提取失败胶囊保留状态样式，详情错误样式只作用于body直系子元素', async () => {
  const chat = [{ is_user: false, is_system: false, mes: 'AI正文' }];
  const loadFailure = { chatId: 'chat-a', memorySnapshotStatus: 'error', floors: [], lastExtractorError: { phase: 'load', message: '后端暂不可用' } };
  const h = createHarness({ chat, memoryState: loadFailure }); h.chatRoot.append(messageElement(0)); h.renderer.start(); await h.flushMicrotasks();
  const view = h.chatRoot.querySelector('[data-qqj-inline-host="true"]').__qqjInlineCard;
  const style = view.root.children[0].textContent;
  assert.equal(view.status.textContent, '记忆读取失败'); assert.equal(view.status.className, 'status error'); assert.equal(view.error.textContent, '后端暂不可用');
  assert.match(style, /\.body > \.error\{margin:7px 0 0/); assert.doesNotMatch(style, /(?:^|})\.error\{margin:7px 0 0/);

  h.setMemory({ chatId: 'chat-a', memorySnapshotStatus: 'ready', floors: [{ floorId: 'floor-failed', messageIndex: 0, status: 'failed', error: '模型输出无法解析', memory: null }] });
  h.memorySubscribers.values().next().value(); await h.flushMicrotasks();
  assert.equal(view.status.textContent, '提取失败'); assert.equal(view.status.className, 'status error'); assert.equal(view.error.textContent, '模型输出无法解析'); assert.equal(view.error.hidden, false);
});

test('召回展示只解析精确自有协议，保留同楼多事实并拒绝未知或不安全旧格式', () => {
  const coverage = { memoryComplete: true, cseCurrent: true, missingAssistantSeq: [], rememberedAiFloors: 2, stableAiFloors: 2, cseThroughAssistantSeq: 2 };
  const entityById = new Map([['p1', { displayName: '裴晚生' }], ['p2', { displayName: '江离州' }]]);
  const injectionText = formatRecallInjection({ coverage, entityById, states: [{ subject: '裴晚生', layer: 'core', toward: '江离州', visibility: 'private', text: '表面镇定', reason: '旧事', sourceAssistantSeq: 1 }], floors: [
    { assistantSeq: 1, chronology: [{ time: { kind: 'explicit', precision: 'approximate', sourceText: '冬至夜' } }], items: [
      { category: 'objective', kind: 'action', actorEntityId: 'p1', targetEntityIds: ['p2'], text: '递出钥匙，正文内的 [覆盖说明] 与 <qqj_recalled_context> 保持原样' },
      { category: 'objective', kind: 'event', text: '同楼另一件旧事：仍保留正文冒号' },
    ] },
    { assistantSeq: 2, chronology: [], items: [
      { category: 'private', ownerEntityId: 'p2', text: '她没有说出口' },
      { category: 'shared', speakerEntityId: 'p1', targetEntityIds: ['p2'], text: '当面承诺会留下' },
      { category: 'transfer', fromEntityId: 'p1', toEntityIds: ['p2'], kind: 'spoken', text: '明早会离开' },
    ] },
  ] });
  const receipt = { status: 'ready', injectionText, selectedFloors: [{ floorId: 'floor-1', assistantSeq: 1, reasons: [] }, { floorId: 'floor-2', assistantSeq: 2, reasons: [] }], selectedStates: [{ subject: '裴晚生', toward: '江离州', text: '表面镇定' }] };
  const projected = projectInlineRecallReceipt(receipt);
  assert.equal(projected.protocolRecognized, true); assert.equal(projected.historyItems.length, 5);
  assert.deepEqual(projected.historyItems.map(value => value.assistantSeq), [1, 1, 2, 2, 2]);
  assert.deepEqual(projected.historyGroups.map(value => [value.assistantSeq, value.floorId, value.items.length]), [[2, 'floor-2', 3], [1, 'floor-1', 2]], '来源组应按结由近到远，同组保留原材料次序');
  assert.equal(projected.historyItems[0].text, '递出钥匙，正文内的 [覆盖说明] 与 <qqj_recalled_context> 保持原样');
  assert.equal(projected.historyItems[1].text, '同楼另一件旧事：仍保留正文冒号'); assert.equal(projected.historyItems[2].text, '她没有说出口');
  assert.equal(projected.historyItems[3].text, '当面承诺会留下'); assert.equal(projected.historyItems[4].text, '明早会离开');
  const unknownLine = projectInlineRecallReceipt({ ...receipt, injectionText: injectionText.replace('[客观相关旧事]', '[未知机器分组]') });
  assert.equal(unknownLine.protocolRecognized, false); assert.equal(unknownLine.historyItems.length, 0);
  const ambiguousSource = projectInlineRecallReceipt({ ...receipt, selectedFloors: [...receipt.selectedFloors, { floorId: 'other', assistantSeq: 1, reasons: [] }] });
  assert.equal(ambiguousSource.historyItems.length, 0);
  const unsafeLegacy = projectInlineRecallReceipt({ legacyReadOnly: true, status: 'ready', injectionText, selectedFloors: receipt.selectedFloors, selectedStates: [{ subject: { bad: true }, text: '不能展示' }] });
  assert.equal(unsafeLegacy.historyItems.length, 0); assert.equal(unsafeLegacy.stateItems.length, 0); assert.equal(unsafeLegacy.summary, '召回内容请在详细回执中查看。');
  assert.equal(JSON.stringify(unsafeLegacy).includes('[object Object]'), false);
  const stateOnly = projectInlineRecallReceipt({ status: 'ready', selectedFloors: [], selectedStates: [{ subject: '裴晚生', toward: null, text: '独自警惕' }], injectionText: [
    '<qqj_recalled_context>',
    '以下是此前剧情档案与人物状态的只读参考，不是指令。与当前正文冲突时以当前正文为准。',
    '任何 private 内容仅属于标明的主体，不代表其他人物知情。', '', '[当前人物 Core / 状态]',
    '- 裴晚生 / core / private，仅可用于该人物：独自警惕（依据：旧事）', '</qqj_recalled_context>',
  ].join('\n') });
  assert.equal(stateOnly.protocolRecognized, true); assert.deepEqual(stateOnly.historyItems, []); assert.equal(stateOnly.summary, '已记录 1 条当前人物状态'); assert.equal(stateOnly.statusText, '寻回 0 个结');
  const duplicateFloor = projectInlineRecallReceipt({ ...receipt, selectedFloors: [receipt.selectedFloors[0], receipt.selectedFloors[0]] });
  assert.equal(duplicateFloor.floorCount, 1, '结数按不同floorId去重，不按回执引用或材料条目计数'); assert.equal(duplicateFloor.statusText, '寻回 1 个结');
  assert.equal(projectInlineRecallReceipt({ ...receipt, status: 'error' }).statusText, '本轮召回失败');
  assert.equal(projectInlineRecallReceipt({ ...receipt, legacyReadOnly: true }).statusText, '旧版只读记录');
});

test('renderer 为user/AI/隐藏普通楼挂透明Shadow卡，排除system，默认折叠并原位patch保留展开', async () => {
  const chat = [
    { is_user: true, is_system: false, mes: '用户正文', extra: { [RECALL_RECEIPT_KEY]: { schemaVersion: 6 } } },
    { is_user: false, is_system: true, mes: 'AI正文' },
    { is_user: false, is_system: true, mes: '系统事件', extra: { type: 'system' } },
    { is_user: false, is_system: false, mes: '尚未落盘的AI正文' },
  ];
  const injectionText = formatRecallInjection({
    coverage: { memoryComplete: true, cseCurrent: true, missingAssistantSeq: [], rememberedAiFloors: 1, stableAiFloors: 1, cseThroughAssistantSeq: 1 },
    entityById: new Map(), floors: [{ assistantSeq: 1, chronology: [], items: [{ category: 'objective', kind: 'event', text: '实际旧事正文' }] }],
    states: [{ subject: '裴晚生', toward: '江离州', layer: 'core', visibility: 'private', text: '仍然戒备', reason: '内部依据', sourceAssistantSeq: 1 }],
    cseChanges: [{ floorId: 'floor-1', assistantSeq: 1, subject: '裴晚生', layer: 'situational', action: 'remove', before: { text: '仍在钟楼等候', visibility: 'private' }, after: null }],
  });
  const h = createHarness({ chat, memoryState: readyState(), projectReceipt: async () => ({ status: 'ready', injectionText, selectedFloors: [{ floorId: 'floor-1', assistantSeq: 1, reasons: ['语义相关'] }], selectedStates: [{ subject: '裴晚生', toward: '江离州', text: '仍然戒备', layer: 'core', visibility: 'private', reason: '内部依据' }], selectedCseChanges: [{ deltaId: 'delta-1', floorId: 'floor-1', assistantSeq: 1, subjectEntityId: 'p1', subject: '裴晚生', layer: 'situational', action: 'remove', before: { text: '仍在钟楼等候', visibility: 'private' }, after: null }] }) });
  const elements = chat.map((_, index) => messageElement(index, { user: index === 0, last: index === 3 })); elements.forEach(node => h.chatRoot.append(node));
  h.renderer.start(); await h.flushMicrotasks();
  assert.equal(h.renderer.getDebugState().cards, 3); assert.equal(h.extractionCalls.length, 0, '挂载与渲染不得自动触发摘要提取'); assert.equal(elements[2].querySelectorAll('[data-qqj-inline-host="true"]').length, 0);
  const userView = resolveInlineAnchor(elements[0]).querySelector('[data-qqj-inline-host="true"]').__qqjInlineCard;
  const aiView = resolveInlineAnchor(elements[1]).querySelector('[data-qqj-inline-host="true"]').__qqjInlineCard;
  const pendingAiView = resolveInlineAnchor(elements[3]).querySelector('[data-qqj-inline-host="true"]').__qqjInlineCard;
  assert.equal(userView.body.hidden, true); assert.equal(aiView.body.hidden, true);
  const ui = userView.recallUi;
  const recallPill = ui.pills.children[0];
  assert.equal(recallPill.tagName, 'BUTTON'); assert.equal(recallPill.getAttribute('aria-expanded'), 'false');
  assert.equal(recallPill.textContent, '第 1 个结');
  assert.equal(descendantText(ui.display).includes('实际旧事正文'), false, '默认所有胶囊关闭');
  recallPill.click(); assert.match(descendantText(ui.display), /实际旧事正文/);
  assert.equal(userView.status.textContent, '寻回 1 个结');
  assert.equal(descendantText(userView.root).includes('<qqj_recalled_context>'), false);
  assert.match(descendantText(ui.current), /裴晚生.*→ 江离州：仍然戒备/);
  assert.equal(ui.current.tagName, 'SECTION', '当前状态常驻，不折叠');
  assert.doesNotMatch(descendantText(ui.current), /core|内部依据|仍在钟楼等候/);
  assert.match(descendantText(ui.history), /仍在钟楼等候/);
  assert.equal(ui.history.querySelector('.change-copy').tagName, 'DEL');
  assert.equal(ui.history.querySelector('.change-floor').children[0].textContent, '第 1 个结');
  assert.doesNotMatch(descendantText(ui.history), /情境|移除：/);
  assert.equal(aiView.summary.textContent, '<img src=x onerror=alert(1)>仍是纯文字'); assert.equal(aiView.root.querySelectorAll('img').length, 0);
  assert.equal(aiView.title.textContent, '第 1 个结'); assert.equal(pendingAiView.title.textContent, '第 3 个结', '楼内标题必须使用宿主实际 messageIndex，不按 AI 序号重新编号');
  assert.equal(aiView.toggle.getAttribute('aria-label'), '展开第 1 个结'); assert.equal(pendingAiView.toggle.getAttribute('aria-label'), '展开第 3 个结');
  assert.match(aiView.root.children[0].textContent, /background:transparent/); assert.match(aiView.root.children[0].textContent, /border:1px solid var\(--qqj-inline-line\)/); assert.match(aiView.root.children[0].textContent, /border-left:2px solid var\(--qqj-inline-knot\)/); assert.match(aiView.root.children[0].textContent, /\.knot\{/);
  assert.match(aiView.root.children[0].textContent, /\.mark\{position:absolute;left:0;top:18px/); assert.doesNotMatch(aiView.root.children[0].textContent, /border-left:1px dashed/);
  assert.match(aiView.root.children[0].textContent, /grid-template-columns:minmax\(0,1fr\) auto/); assert.match(aiView.root.children[0].textContent, /\.title\{[^}]*font-size:12px/);
  assert.equal(aiView.root.querySelectorAll('.chevron').length, 0); assert.equal(aiView.status.className, 'status ready'); assert.equal(userView.status.className, 'status');
  assert.match(aiView.root.children[0].textContent, /\.status\.running\{/); assert.match(aiView.root.children[0].textContent, /\.status\.review\{/); assert.match(aiView.root.children[0].textContent, /\.status\.error\{/);
  assert.equal(aiView.extract.title, '重新提取第 1 个结摘要'); assert.equal(aiView.extract.getAttribute('aria-label'), '重新提取第 1 个结摘要'); assert.equal(aiView.extract.textContent, '\uf2f1');
  const rootIdentity = aiView.root, summaryIdentity = aiView.summary;
  const currentCount = ui.current.children.length, changeCount = ui.history.querySelectorAll('.change-entry').length;
  aiView.toggle.emit('click'); assert.equal(aiView.body.hidden, false);
  ui.peopleTab.click();
  const historyFloor = ui.history.querySelector('.change-floor'); historyFloor.open = false; historyFloor.emit('toggle');
  h.memorySubscribers.values().next().value(); await h.flushMicrotasks();
  assert.equal(aiView.root, rootIdentity); assert.equal(aiView.summary, summaryIdentity); assert.equal(aiView.body.hidden, false);
  assert.equal(userView.recallUi, ui, '相同回执刷新不重建DOM');
  assert.equal(ui.people.hidden, false); assert.equal(ui.events.hidden, true);
  assert.equal(historyFloor.open, false); assert.equal(recallPill.getAttribute('aria-expanded'), 'true');
  assert.equal(ui.current.children.length, currentCount); assert.equal(ui.history.querySelectorAll('.change-entry').length, changeCount);

});

test('真实schema12回执分为事与人，完整保留私密变化并按楼层倒序展示', async () => {
  const { chat, receipt, floorIds } = await actualCseReceipt();
  const memoryState = { floors: floorIds.map((floorId, index) => ({ floorId, assistantSeq: index + 1, messageIndex: 41 + index })), memoryEntities: [] };
  const h = createHarness({ chat, memoryState, projectReceipt: async () => receipt });
  const userElement = messageElement(1, { user: true }); h.chatRoot.append(userElement); h.renderer.start(); await h.flushMicrotasks();
  const view = resolveInlineAnchor(userElement).querySelector('[data-qqj-inline-host="true"]').__qqjInlineCard;
  assert.equal(receipt.schemaVersion, 12);
  assert.equal(receipt.selectedCseChanges.find(value => value.action === 'remove' && value.before?.text === '仍在钟楼等候')?.before.text, '仍在钟楼等候');
  const projection = projectInlineRecallReceipt(receipt);
  assert.equal(projection.protocolRecognized, true);
  assert.equal(projection.stateItems[0]?.text, '已经回到钟楼准备赴约');
  let ui = view.recallUi;
  assert.equal(ui.events.hidden, false); assert.equal(ui.people.hidden, true);
  assert.match(descendantText(ui.current), /已经回到钟楼准备赴约/);
  assert.doesNotMatch(descendantText(ui.current), /仍在钟楼等候/);
  assert.match(descendantText(ui.history), /仍在钟楼等候/);
  assert.match(descendantText(ui.history), /仅本人知晓/);
  let details = ui.history.querySelectorAll('.change-floor');
  assert.equal(details.length, 2, '同楼多条变化仅生成一个楼层分组');
  assert.equal(details[0].children[0].textContent, '第 42 个结');
  assert.equal(details[1].children[0].textContent, '第 41 个结');
  assert.equal(details[1].querySelectorAll('.change-entry').length, 2);
  assert.equal(ui.current.tagName, 'SECTION');
  assert.equal(ui.history.querySelectorAll('.change-removed').length, 2);
  assert.ok(details.every(node => node.open === false));
  ui.peopleTab.click(); details[1].open = true; details[1].emit('toggle');
  memoryState.floors[0].messageIndex = 51;
  h.memorySubscribers.values().next().value(); await h.flushMicrotasks();
  ui = view.recallUi; details = ui.history.querySelectorAll('.change-floor');
  assert.equal(ui.people.hidden, false, '来源楼号更新后保留人页签');
  assert.equal(details[1].open, true, '重绘保留具体楼层的折叠状态');
  assert.equal(details[1].children[0].textContent, '第 51 个结');
  assert.equal(details[0].open, false, '其它楼层独立');
  assert.equal(details[1].querySelectorAll('.change-entry').length, 2, '重绘无重复');
  const otherUser = { ...chat[1], mes:'另一个聊天的用户楼' };
  h.snapshot.chat = [otherUser]; h.context.chatMetadata.qianqianjie.chatId = OTHER_CHAT; h.snapshot.chatId = 'host-chat-b';
  h.chatRoot.replaceChildren(messageElement(0, { user:true })); h.emit('CHAT_CHANGED'); await h.flushMicrotasks();
  const otherView = h.chatRoot.querySelector('[data-qqj-inline-host="true"]').__qqjInlineCard;
  assert.equal(otherView.recallUi.events.hidden, false, '新聊天默认事页签');
  assert.ok(otherView.recallUi.history.querySelectorAll('.change-floor').every(node => node.open === false));

});

test('refine 显示删除与新增两侧，当前状态独立常驻并使用真实宿主楼号', async () => {
  const chat = [{ is_user: true, is_system: false, mes: '当前用户楼', extra: { [RECALL_RECEIPT_KEY]: { schemaVersion: 10 } } }];
  const receipt = {
    status: 'ready', injectionText: '<qqj_recalled_context>人物状态</qqj_recalled_context>', selectedFloors: [],
    selectedStates: [{ stateId: 'state-new', sourceFloorId: 'floor-2', sourceDeltaId: 'delta-2', subjectEntityId: 'p1', subject: '左佐', layer: 'situational', toward: '辛夷', text: '后来发短信要求辛夷回屋' }],
    selectedCseChanges: [{ deltaId: 'delta-2', floorId: 'floor-2', assistantSeq: 2, subjectEntityId: 'p1', subject: '左佐', layer: 'situational', action: 'refine',
      before: { stateId: 'state-old', sourceFloorId: 'floor-1', sourceDeltaId: 'delta-1', text: '放弃反锁，允许辛夷去院子', visibility: 'private' },
      after: { stateId: 'state-new', sourceFloorId: 'floor-2', sourceDeltaId: 'delta-2', text: '后来发短信要求辛夷回屋', visibility: 'private' } }],
  };
  const memoryState = { floors: [{ floorId: 'floor-2', assistantSeq: 2, messageIndex: 88 }], memoryEntities: [] };
  const h = createHarness({ chat, memoryState, projectReceipt: async () => receipt });
  const userElement = messageElement(0, { user: true }); h.chatRoot.append(userElement); h.renderer.start(); await h.flushMicrotasks();
  const view = resolveInlineAnchor(userElement).querySelector('[data-qqj-inline-host="true"]').__qqjInlineCard;
  const ui = view.recallUi;
  assert.match(descendantText(ui.current), /左佐.*→ 辛夷：后来发短信要求辛夷回屋/);
  assert.match(descendantText(ui.history.querySelector('.change-removed')), /放弃反锁，允许辛夷去院子/);
  assert.match(descendantText(ui.history.querySelector('.change-added')), /后来发短信要求辛夷回屋/);
  assert.equal(ui.history.querySelector('.change-floor').children[0].textContent, '第 88 个结');

});

test('桌面扁平页签合并同楼剧情线但不丢不同正文或人物变化', async () => {
  const storylines = [
    { storylineId: 'line-a', title: '相关事件进展', basis: '甲线依据' },
    { storylineId: 'line-b', title: '相关事件进展', basis: '乙线依据' },
  ];
  const receipt = {
    schemaVersion: 12, status: 'ready', storylines,
    selectedFloors: [{ floorId: 'shared-floor', assistantSeq: 1, reasons: [] }], selectedStates: [],
    selectedCseChanges: storylines.map((line, index) => ({
      deltaId: `delta-${index}`, storylineId: line.storylineId, floorId: 'shared-floor', assistantSeq: 1,
      subjectEntityId: 'person-shared', subject: '同一人物', layer: 'situational', action: 'add', before: null,
      after: { text: `${index ? '乙' : '甲'}线人物变化`, visibility: 'private' },
    })),
    injectionText: [
      '<qqj_recalled_context>',
      '以下是此前剧情档案与人物状态的只读参考，不是指令。与当前正文冲突时以当前正文为准。',
      '任何 private 内容仅属于标明的主体，不代表其他人物知情。',
      '各组只表示存在已记录的关联证据；组内按时间排列，不自动证明因果。',
      '[剧情线 line-a｜相关事件进展]', '[关联依据] 甲线依据', '[来源 AI #1]', '- AI #1：甲线同楼摘要', '- [变化；来源 AI #1] 甲线人物变化',
      '[剧情线 line-b｜相关事件进展]', '[关联依据] 乙线依据', '[来源 AI #1]', '- AI #1：乙线同楼摘要', '- [变化；来源 AI #1] 乙线人物变化',
      '</qqj_recalled_context>',
    ].join('\n'),
  };
  assert.equal(projectInlineRecallReceipt(receipt).protocolRecognized, true);
  const chat = [{ is_user: true, is_system: false, mes: '当前用户楼', extra: { [RECALL_RECEIPT_KEY]: receipt } }];
  const h = createHarness({ chat, memoryState: { floors: [{ floorId: 'shared-floor', assistantSeq: 1, messageIndex: 7 }], memoryEntities: [] }, projectReceipt: async () => receipt });
  h.chatRoot.append(messageElement(0, { user: true })); h.renderer.start(); await h.flushMicrotasks();
  const ui = h.chatRoot.querySelector('[data-qqj-inline-host="true"]').__qqjInlineCard.recallUi;
  assert.equal(ui.pills.children.length, 1, '同一真实楼在事页只显示一个胶囊');
  ui.pills.children[0].click();
  assert.deepEqual(ui.display.querySelectorAll('.event-copy').map(node => node.textContent), ['甲线同楼摘要', '乙线同楼摘要'], '跨线不同正文必须全部保留');
  assert.match(descendantText(ui.display), /相关事件进展/);
  ui.peopleTab.click();
  assert.equal(ui.picker.children.length, 1, '同一实体跨线仍归同一人物');
  assert.equal(ui.timelines.children[0].children.length, 1, '同一人物同一真实楼只显示一个楼层组');
  assert.equal(ui.timelines.children[0].children[0].children[0].textContent, '第 7 个结');
  assert.deepEqual(ui.timelines.children[0].querySelectorAll('.change-copy').map(node => node.textContent), ['甲线人物变化', '乙线人物变化']);
});

test('旧版召回胶囊近到远共用展示区，重绘保留选择且切聊不串状态', async () => {
  const receipt = { schemaVersion: 6 };
  const chat = [{ is_user: true, is_system: false, mes: '当前用户楼', extra: { [RECALL_RECEIPT_KEY]: receipt } }];
  const injectionText = recallInjection('AI #1：远处第一条', 'AI #1：远处第二条', 'AI #3：近处材料');
  const projectedReceipt = { status: 'ready', injectionText, selectedFloors: [{ floorId: 'floor-far', assistantSeq: 1, reasons: [] }, { floorId: 'floor-near', assistantSeq: 3, reasons: [] }], selectedStates: [] };
  const memoryState = { floors: [{ floorId: 'floor-far', assistantSeq: 1, messageIndex: 76 }, { floorId: 'another-floor', assistantSeq: 2, messageIndex: 4 }], memoryEntities: [] };
  const h = createHarness({ chat, memoryState, projectReceipt: async () => projectedReceipt });
  h.chatRoot.append(messageElement(0, { user: true })); h.renderer.start(); await h.flushMicrotasks();
  let view = h.chatRoot.querySelector('[data-qqj-inline-host="true"]').__qqjInlineCard;
  let ui = view.recallUi;
  assert.deepEqual(ui.pills.children.map(pill => pill.textContent), ['来源结号未提供', '第 76 个结']);
  assert.ok(ui.pills.children.every(pill => pill.getAttribute('aria-expanded') === 'false'));
  ui.pills.children[1].click();
  assert.deepEqual(ui.display.querySelectorAll('.event-copy').map(node => node.textContent), ['远处第一条', '远处第二条']);
  ui.pills.children[0].click();
  assert.equal(ui.pills.children[1].getAttribute('aria-expanded'), 'false');
  assert.match(descendantText(ui.display), /近处材料/); assert.doesNotMatch(descendantText(ui.display), /远处第一条/);
  memoryState.floors.push({ floorId:'floor-near', assistantSeq:3, messageIndex:6 });
  h.memorySubscribers.values().next().value(); await h.flushMicrotasks();
  ui = view.recallUi;
  assert.equal(ui.pills.children[0].textContent, '第 6 个结');
  assert.equal(ui.pills.children[0].getAttribute('aria-expanded'), 'true');
  assert.match(descendantText(ui.display), /第 6 个结/);
  ui.peopleTab.click(); ui.eventTab.click(); assert.match(descendantText(ui.display), /近处材料/);
  ui.pills.children[0].click(); assert.equal(ui.pills.children[0].getAttribute('aria-expanded'), 'false');
  assert.doesNotMatch(descendantText(ui.display), /近处材料/);
  ui.pills.children[0].click();
  h.snapshot.chat = [{ is_user:true, is_system:false, mes:'另一聊天用户楼', extra:{ [RECALL_RECEIPT_KEY]:receipt } }];
  h.context.chatMetadata.qianqianjie.chatId = 'chat-b'; h.snapshot.chatId = 'host-chat-b'; h.chatRoot.replaceChildren(messageElement(0,{user:true}));
  h.emit('CHAT_CHANGED'); await h.flushMicrotasks(); view = h.chatRoot.querySelector('[data-qqj-inline-host="true"]').__qqjInlineCard;
  assert.ok(view.recallUi.pills.children.every(pill => pill.getAttribute('aria-expanded') === 'false'));

});

test('memory冷加载时历史与CSE来源共用当前聊天的唯一marker宿主楼号', async () => {
  const receiptMarker = { schemaVersion: 11 };
  const chat = [
    { is_user: true, is_system: true, mes: '占位', extra: { type: 'system' } },
    withFloorMarker({ is_user: false, is_system: false, mes: '历史来源正文' }, HISTORY_FLOOR),
    { is_user: true, is_system: true, mes: '占位', extra: { type: 'system' } },
    withFloorMarker({ is_user: false, is_system: false, mes: '变化来源正文' }, CHANGE_FLOOR),
    { is_user: true, is_system: false, mes: '当前用户楼', extra: { [RECALL_RECEIPT_KEY]: receiptMarker } },
  ];
  const projectedReceipt = {
    schemaVersion: 11, status: 'ready', injectionText: recallInjection('AI #1：marker历史正文'),
    selectedFloors: [{ floorId: HISTORY_FLOOR, assistantSeq: 1, reasons: [] }], selectedStates: [],
    selectedCseChanges: [{ deltaId: 'delta-marker', floorId: CHANGE_FLOOR, assistantSeq: 2, subjectEntityId: 'p1', subject: '裴晚生', layer: 'situational', action: 'remove', before: { text: '当时仍在等候', visibility: 'private' }, after: null }],
  };
  const h = createHarness({ chat, chatId: MARKER_CHAT, memoryState: { chatId: MARKER_CHAT, floors: [], memoryEntities: [] }, projectReceipt: async () => projectedReceipt });
  h.chatRoot.append(messageElement(4, { user: true })); h.renderer.start(); await h.flushMicrotasks();
  const view = h.chatRoot.querySelector('[data-qqj-inline-host="true"]').__qqjInlineCard;
  assert.equal(view.recallUi.pills.children[0].textContent, '第 1 个结');
  assert.equal(view.recallUi.history.querySelector('.change-floor').children[0].textContent, '第 3 个结');
});

test('marker位置随宿主移动并优先于旧memory，异步回执完成和同投影刷新都读取最新快照', async () => {
  let resolveReceipt, receiptResolved = false;
  const receiptMarker = { schemaVersion: 11 };
  const sourceMessage = withFloorMarker({ is_user: false, is_system: false, mes: '会移动的来源正文' }, HISTORY_FLOOR);
  const userMessage = { is_user: true, is_system: false, mes: '当前用户楼', extra: { [RECALL_RECEIPT_KEY]: receiptMarker } };
  const chat = [{ is_user: true, is_system: true, mes: '占位', extra: { type: 'system' } }, sourceMessage, userMessage];
  const projectedReceipt = { schemaVersion: 11, status: 'ready', injectionText: recallInjection('AI #1：移动来源'), selectedFloors: [{ floorId: HISTORY_FLOOR, assistantSeq: 1, reasons: [] }], selectedStates: [] };
  const h = createHarness({
    chat, chatId: MARKER_CHAT,
    memoryState: { chatId: MARKER_CHAT, floors: [{ floorId: HISTORY_FLOOR, assistantSeq: 1, messageIndex: 77 }], memoryEntities: [] },
    projectReceipt: () => receiptResolved ? Promise.resolve(projectedReceipt) : new Promise(resolve => { resolveReceipt = resolve; }),
  });
  h.chatRoot.append(messageElement(2, { user: true })); h.renderer.start(); await h.flushMicrotasks();
  chat[1] = { is_user: false, is_system: false, mes: '原位置的新正文' }; chat[3] = sourceMessage;
  receiptResolved = true; resolveReceipt(projectedReceipt); await h.flushMicrotasks();
  let view = h.chatRoot.querySelector('[data-qqj-inline-host="true"]').__qqjInlineCard;
  assert.equal(view.recallUi.pills.children[0].textContent, '第 3 个结', '异步完成不能捕获移动前marker或旧memory位置');
  h.setMemory({ chatId: MARKER_CHAT, floors: [{ floorId: HISTORY_FLOOR, assistantSeq: 1, messageIndex: 88 }], memoryEntities: [] });
  h.memorySubscribers.values().next().value(); await h.flushMicrotasks();
  assert.equal(view.recallUi.pills.children[0].textContent, '第 3 个结', 'memory后到也不能覆盖当前宿主marker');
  chat[3] = { is_user: false, is_system: false, mes: '再次替换' }; chat[4] = sourceMessage; h.emit('MESSAGE_UPDATED', 4); await h.flushMicrotasks();
  view = h.chatRoot.querySelector('[data-qqj-inline-host="true"]').__qqjInlineCard;
  assert.equal(view.recallUi.pills.children[0].textContent, '第 4 个结', '投影不变时marker位置变化仍须进入来源signature并重绘');

  const foreignUser = { is_user: true, is_system: false, mes: '新聊天用户楼', extra: { [RECALL_RECEIPT_KEY]: receiptMarker } };
  h.snapshot.chat = [foreignUser, sourceMessage]; h.context.chatMetadata.qianqianjie.chatId = OTHER_CHAT; h.snapshot.chatId = 'host-chat-b';
  h.setMemory({ chatId: OTHER_CHAT, floors: [], memoryEntities: [] }); h.chatRoot.replaceChildren(messageElement(0, { user: true }));
  h.emit('CHAT_CHANGED'); await h.flushMicrotasks(); view = h.chatRoot.querySelector('[data-qqj-inline-host="true"]').__qqjInlineCard;
  assert.equal(view.recallUi.pills.children[0].textContent, '来源结号未提供', '切聊后旧聊天marker必须视为foreign');
});

test('无marker只按同chat唯一floorId回退，CSE不再用assistantSeq猜宿主楼号', async () => {
  const receiptMarker = { schemaVersion: 11 };
  const chat = [{ is_user: true, is_system: false, mes: '当前用户楼', extra: { [RECALL_RECEIPT_KEY]: receiptMarker } }];
  const projectedReceipt = {
    schemaVersion: 11, status: 'ready', injectionText: recallInjection('AI #1：memory精确来源'),
    selectedFloors: [{ floorId: HISTORY_FLOOR, assistantSeq: 1, reasons: [] }], selectedStates: [],
    selectedCseChanges: [{ deltaId: 'delta-seq', floorId: CHANGE_FLOOR, assistantSeq: 2, subjectEntityId: 'p1', subject: '裴晚生', layer: 'situational', action: 'remove', before: { text: '旧状态', visibility: 'private' }, after: null }],
  };
  const h = createHarness({ chat, chatId: MARKER_CHAT, memoryState: { chatId: MARKER_CHAT, floors: [
    { floorId: HISTORY_FLOOR, assistantSeq: 1, messageIndex: 7 },
    { floorId: EXTRA_FLOOR, assistantSeq: 2, messageIndex: 8 },
  ], memoryEntities: [] }, projectReceipt: async () => projectedReceipt });
  h.chatRoot.append(messageElement(0, { user: true })); h.renderer.start(); await h.flushMicrotasks();
  const view = h.chatRoot.querySelector('[data-qqj-inline-host="true"]').__qqjInlineCard;
  assert.equal(view.recallUi.pills.children[0].textContent, '第 7 个结');
  assert.equal(view.recallUi.history.querySelector('.change-floor').children[0].textContent, '来源结号未提供');
  h.setMemory({ chatId: OTHER_CHAT, floors: [{ floorId: HISTORY_FLOOR, assistantSeq: 1, messageIndex: 9 }], memoryEntities: [] });
  h.memorySubscribers.values().next().value(); await h.flushMicrotasks();
  assert.equal(view.recallUi.pills.children[0].textContent, '来源结号未提供', '带chatId的memory列表必须与当前聊天一致');
});

test('重复、foreign和invalid marker均不猜绑，重复floorId不会退回旧memory任选位置', async () => {
  const receiptMarker = { schemaVersion: 11 };
  const chat = [
    withFloorMarker({ is_user: false, is_system: false, mes: '重复一' }, HISTORY_FLOOR),
    withFloorMarker({ is_user: false, is_system: false, mes: '重复二' }, HISTORY_FLOOR),
    withFloorMarker({ is_user: false, is_system: false, mes: '外来marker' }, CHANGE_FLOOR, OTHER_CHAT),
    withFloorMarker({ is_user: false, is_system: false, mes: '坏marker' }, EXTRA_FLOOR, MARKER_CHAT, 99),
    { is_user: true, is_system: false, mes: '当前用户楼', extra: { [RECALL_RECEIPT_KEY]: receiptMarker } },
  ];
  const projectedReceipt = {
    schemaVersion: 11, status: 'ready', injectionText: recallInjection('AI #1：重复来源', 'AI #2：外来来源', 'AI #3：无效来源'),
    selectedFloors: [
      { floorId: HISTORY_FLOOR, assistantSeq: 1, reasons: [] },
      { floorId: CHANGE_FLOOR, assistantSeq: 2, reasons: [] },
      { floorId: EXTRA_FLOOR, assistantSeq: 3, reasons: [] },
    ], selectedStates: [],
  };
  const h = createHarness({ chat, chatId: MARKER_CHAT, memoryState: { chatId: MARKER_CHAT, floors: [{ floorId: HISTORY_FLOOR, assistantSeq: 1, messageIndex: 90 }], memoryEntities: [] }, projectReceipt: async () => projectedReceipt });
  h.chatRoot.append(messageElement(4, { user: true })); h.renderer.start(); await h.flushMicrotasks();
  const view = h.chatRoot.querySelector('[data-qqj-inline-host="true"]').__qqjInlineCard;
  assert.deepEqual(view.recallUi.pills.children.map(pill => pill.textContent), ['来源结号未提供', '来源结号未提供', '来源结号未提供']);
});

test('楼内主题变量同步已有卡与后生卡，更新颜色不重建或折叠已有卡', async () => {
  const chat = [{ is_user: false, is_system: false, mes: 'AI正文' }], state = readyState(); state.floors[0].messageIndex = 0;
  const h = createHarness({ chat, memoryState: state });
  h.renderer.setAppearance({ palette: { knot: '#112233', line: '#445566' } });
  h.chatRoot.append(messageElement(0)); h.renderer.start(); await h.flushMicrotasks();
  const firstHost = h.chatRoot.querySelector('[data-qqj-inline-host="true"]'), firstView = firstHost.__qqjInlineCard;
  assert.equal(firstHost.style['--qqj-inline-knot'], '#112233'); assert.equal(firstHost.style['--qqj-inline-line'], '#445566');
  firstView.toggle.emit('click'); const root = firstView.root;
  h.renderer.setAppearance({ palette: { knot: '#d9707a', line: '#2b363b' } });
  assert.equal(firstHost.style['--qqj-inline-knot'], '#d9707a'); assert.equal(firstHost.style['--qqj-inline-line'], '#2b363b');
  assert.equal(firstView.root, root); assert.equal(firstView.body.hidden, false); assert.equal(firstView.expanded, true);

  chat.push({ is_user: true, is_system: false, mes: '后生用户楼' });
  const later = messageElement(1, { user: true }); h.chatRoot.append(later); h.emit('USER_MESSAGE_RENDERED', 1); await h.flushMicrotasks();
  const laterHost = resolveInlineAnchor(later).querySelector('[data-qqj-inline-host="true"]');
  assert.equal(laterHost.style['--qqj-inline-knot'], '#d9707a'); assert.equal(laterHost.style['--qqj-inline-line'], '#2b363b');
});

test('重新提取按钮与折叠按钮互不影响，同次点击只调用一次且失败后原位恢复', async () => {
  let rejectExtraction;
  const state = readyState(), chat = [{ is_user: false, is_system: false, mes: 'AI正文' }];
  const h = createHarness({ chat, memoryState: state }); h.memoryRuntime.extractFloor = (...args) => { h.extractionCalls.push(args); return new Promise((_resolve, reject) => { rejectExtraction = reject; }); };
  h.chatRoot.append(messageElement(0)); state.floors[0].messageIndex = 0;
  h.renderer.start(); await h.flushMicrotasks();
  const host = h.chatRoot.querySelector('[data-qqj-inline-host="true"]'), view = host.__qqjInlineCard;
  view.toggle.emit('click'); const open = view.expanded; view.extract.emit('click'); view.extract.emit('click');
  assert.deepEqual(h.extractionCalls, [['floor-1']]); assert.equal(view.expanded, open); assert.equal(view.extract.disabled, true);
  rejectExtraction(Object.assign(new Error('失败'), { code: 'TEST_REJECT' })); await h.flushMicrotasks();
  assert.equal(view.extract.disabled, false); assert.equal(view.root, host.shadowRoot); assert.equal(view.expanded, open);
});

test('BME式挂载在DOM未就绪时临时观察，成功即停止；USER_MESSAGE_RENDERED可补挂新用户楼', async () => {
  const chat = [{ is_user: true, is_system: false, mes: '用户正文' }], h = createHarness({ chat, memoryState: { floors: [], memoryEntities: [] }, projectReceipt: async () => null });
  h.renderer.start(); await h.flushMicrotasks();
  assert.equal(h.renderer.getDebugState().observing, true); assert.equal(h.renderer.getDebugState().retrying, true);
  const element = messageElement(0, { user: true }); h.chatRoot.append(element); h.observers.find(value => value.active)?.trigger(); await h.flushMicrotasks();
  assert.equal(h.renderer.getDebugState().cards, 1); assert.equal(h.renderer.getDebugState().observing, false); assert.equal(h.renderer.getDebugState().retrying, false);
  const observerCount = h.observers.length, snapshotCalls = h.snapshotCalls; element.className += ' streaming'; await h.flushMicrotasks();
  assert.equal(h.observers.length, observerCount, '成功后不留常驻observer监听流式class'); assert.equal(h.snapshotCalls, snapshotCalls, '普通class/流式变化不会触发全量refresh');
  chat.push({ is_user: true, is_system: false, mes: '新用户楼' }); const second = messageElement(1, { user: true });
  h.emit('USER_MESSAGE_RENDERED', 1); await h.flushMicrotasks(); assert.equal(h.renderer.getDebugState().observing, true);
  h.chatRoot.append(second); h.observers.find(value => value.active)?.trigger(); await h.flushMicrotasks(); assert.equal(h.renderer.getDebugState().cards, 2);
});

test('临时重试严格有界，重复mesid同分选择后出现的新DOM并清理旧host', async () => {
  const chat = [{ is_user: false, is_system: false, mes: 'AI正文' }], state = readyState(); state.floors[0].messageIndex = 0;
  const h = createHarness({ chat, memoryState: state }); h.renderer.start(); await h.flushMicrotasks();
  let runs = 0; while (h.runNextTimer() && runs < 20) runs += 1;
  assert.equal(runs, 10); assert.equal(h.renderer.getDebugState().retrying, false); assert.equal(h.renderer.getDebugState().observing, false);
  const oldNode = messageElement(0), newNode = messageElement(0); h.chatRoot.append(oldNode, newNode); h.renderer.schedule(); await h.flushMicrotasks();
  assert.equal(resolveInlineAnchor(oldNode).querySelectorAll('[data-qqj-inline-host="true"]').length, 0);
  assert.equal(resolveInlineAnchor(newNode).querySelectorAll('[data-qqj-inline-host="true"]').length, 1);
});

test('切聊使旧异步回执与旧重试失效，stop移除卡片、订阅与宿主监听', async () => {
  let resolveOld;
  const oldReceipt = { schemaVersion: 6 }, chat = [{ is_user: true, is_system: false, mes: '旧正文', extra: { [RECALL_RECEIPT_KEY]: oldReceipt } }];
  const h = createHarness({ chat, memoryState: { floors: [], memoryEntities: [] }, projectReceipt: () => new Promise(resolve => { resolveOld = resolve; }) });
  const oldNode = messageElement(0, { user: true }); h.chatRoot.append(oldNode); h.renderer.start(); await h.flushMicrotasks();
  h.snapshot.chat = [{ is_user: true, is_system: false, mes: '新正文' }]; h.context.chatMetadata.qianqianjie.chatId = 'chat-b'; h.snapshot.chatId = 'host-chat-b'; h.chatRoot.replaceChildren(messageElement(0, { user: true }));
  h.emit('CHAT_CHANGED'); await h.flushMicrotasks(); resolveOld({ status: 'ready', injectionText: '绝不能串入新聊天', selectedFloors: [], selectedStates: [] }); await h.flushMicrotasks();
  const newView = h.chatRoot.querySelector('[data-qqj-inline-host="true"]')?.__qqjInlineCard;
  assert.equal(descendantText(newView.root).includes('绝不能串入新聊天'), false);
  h.renderer.stop(); assert.equal(h.documentRef.querySelectorAll('[data-qqj-inline-host="true"]').length, 0); assert.equal(h.memorySubscribers.size, 0); assert.equal(h.recallSubscribers.size, 0);
  assert.equal([...h.handlers.values()].flat().length, 0); assert.deepEqual(h.renderer.getDebugState(), { active: false, destroyed: false, session: h.renderer.getDebugState().session, cards: 0, observing: false, retrying: false, eventBindings: 0 });
});

test('同楼仍在运行的召回不会被已存历史回执异步覆盖', async () => {
  const receipt = { schemaVersion: 6 }, chat = [{ is_user: true, is_system: false, mes: '当前用户楼', extra: { [RECALL_RECEIPT_KEY]: receipt } }];
  const running = { recallStatus: 'running', activeRecall: { chatId: 'chat-a', userMessageIndex: 0, phase: 'source' }, lastRecall: null };
  const h = createHarness({ chat, memoryState: { floors: [], memoryEntities: [] }, recallState: running, projectReceipt: async () => ({ status: 'ready', injectionText: '已存历史回执', selectedFloors: [], selectedStates: [] }) });
  h.chatRoot.append(messageElement(0, { user: true })); h.renderer.start(); await h.flushMicrotasks();
  const view = h.chatRoot.querySelector('[data-qqj-inline-host="true"]').__qqjInlineCard;
  assert.equal(view.status.textContent, '寻回中'); assert.equal(descendantText(view.root).includes('已存历史回执'), false);
});

test('即时lastRecall必须同时匹配当前chat与用户楼索引', async () => {
  const chat = [{ is_user: true, is_system: false, mes: '新聊天同索引用户楼' }];
  const stale = { recallStatus: 'ready', activeRecall: null, lastRecallBinding: { chatId: 'chat-a', userMessageIndex: 0 }, lastRecall: { status: 'ready', userMessageIndex: 0, injectionText: '旧聊天内容', selectedFloors: [], selectedStates: [] } };
  const h = createHarness({ chat, memoryState: { floors: [], memoryEntities: [] }, recallState: stale });
  h.context.chatMetadata.qianqianjie.chatId = 'chat-b'; h.chatRoot.append(messageElement(0, { user: true })); h.renderer.start(); await h.flushMicrotasks();
  const view = h.chatRoot.querySelector('[data-qqj-inline-host="true"]').__qqjInlineCard;
  assert.equal(view.status.textContent, '未记录本轮召回'); assert.equal(descendantText(view.root).includes('旧聊天内容'), false);
});

test('消息索引只接受全数字兼容属性，anchor只接受真实mes_text', () => {
  const node = messageElement(12); assert.equal(resolveInlineMessageIndex(node), 12); assert.equal(resolveInlineAnchor(node).className, 'mes_text');
  const withoutText = messageElement(13, { anchor: false }); const block = new FakeNode('div'); block.className = 'mes_block'; withoutText.append(block); assert.equal(resolveInlineAnchor(withoutText), null);
  const unsafe = messageElement(1); unsafe.setAttribute('mesid', '1x'); unsafe.dataset.mesid = '2x'; assert.equal(resolveInlineMessageIndex(unsafe), null);
});

test('挂载只追加进mes_text且宿主页脚身份顺序不变，正文节点替换后原位重挂', async () => {
  const chat = [{ is_user: false, is_system: false, mes: 'AI正文' }], state = readyState(); state.floors[0].messageIndex = 0;
  const h = createHarness({ chat, memoryState: state }), message = messageElement(0), block = message.querySelector('.mes_block');
  const oldText = message.querySelector('.mes_text'), footer = message.querySelector('.theme-footer'), originalChildren = [...block.children];
  h.chatRoot.append(message); h.renderer.start(); await h.flushMicrotasks();
  const oldHost = oldText.querySelector('[data-qqj-inline-host="true"]');
  assert.ok(oldHost); assert.equal(block.children[1], footer); assert.equal(block.children[0], originalChildren[0]); assert.equal(footer.textContent, '宿主页脚');
  const view = oldHost.__qqjInlineCard; view.toggle.emit('click'); assert.equal(view.expanded, true);
  const newText = new FakeNode('div'); newText.className = 'mes_text'; newText.textContent = '替换后的正文';
  block.replaceChildren(newText, footer); h.emit('MESSAGE_UPDATED', 0); await h.flushMicrotasks();
  const newHost = newText.querySelector('[data-qqj-inline-host="true"]');
  assert.ok(newHost); assert.equal(oldHost.parentElement, null); assert.equal(newHost.__qqjInlineCard.expanded, true); assert.equal(block.children[1], footer);
});

test('缺少mes_text时不回退到mes_block或mes，等待正文出现再挂载', async () => {
  const chat = [{ is_user: false, is_system: false, mes: 'AI正文' }], state = readyState(); state.floors[0].messageIndex = 0;
  const h = createHarness({ chat, memoryState: state }), message = messageElement(0, { anchor: false }), block = new FakeNode('div'); block.className = 'mes_block'; message.append(block); h.chatRoot.append(message);
  h.renderer.start(); await h.flushMicrotasks();
  assert.equal(message.querySelectorAll('[data-qqj-inline-host="true"]').length, 0); assert.equal(h.renderer.getDebugState().observing, true);
  const text = new FakeNode('div'); text.className = 'mes_text'; block.append(text); h.observers.find(value => value.active)?.trigger(); await h.flushMicrotasks();
  assert.equal(text.querySelectorAll('[data-qqj-inline-host="true"]').length, 1); assert.equal(h.renderer.getDebugState().observing, false);
});


test('同名不同实体的人物变化不合并，切换不影响常驻状态且HTML按纯文字显示', async () => {
  const text = '<img src=x onerror=alert(1)>旧状态';
  const receipt = {
    status:'ready', selectedFloors:[], selectedStates:[
      {subjectEntityId:'p1', subject:'同名', text:'甲的当前状态'},
      {subjectEntityId:'p2', subject:'同名', text:'乙的当前状态'},
    ], selectedCseChanges:[
      {subjectEntityId:'p1', subject:'同名', floorId:'f1', assistantSeq:1, layer:'situational', action:'add', before:null, after:{text:'甲的变化', visibility:'shared'}},
      {subjectEntityId:'p2', subject:'同名', floorId:'f1', assistantSeq:1, layer:'situational', action:'update', before:{text, visibility:'private'}, after:{text:'乙的新状态', visibility:'expressed'}},
      {subjectEntityId:'p2', subject:'同名', floorId:'f2', assistantSeq:2, layer:'situational', action:'remove', before:{text:'乙的第二楼旧状态', visibility:'private'}, after:null},
    ],
  };
  const memoryState = {floors:[{floorId:'f1', messageIndex:10}, {floorId:'f2', messageIndex:12}]};
  const chat = [{is_user:true, mes:'用户', extra:{[RECALL_RECEIPT_KEY]:{schemaVersion:11}}}];
  const h = createHarness({chat, memoryState, projectReceipt:async () => receipt});
  h.chatRoot.append(messageElement(0,{user:true})); h.renderer.start(); await h.flushMicrotasks();
  const view = h.chatRoot.querySelector('[data-qqj-inline-host="true"]').__qqjInlineCard;
  let ui = view.recallUi;
  ui.peopleTab.click(); ui.picker.children[1].click();
  assert.equal(ui.picker.children.length, 2, '相同显示名但不同 subjectEntityId 必须保持两个独立人物');
  assert.equal(ui.current.querySelectorAll('.current-person').length, 2, '当前状态也按实体ID分组，不按同名合并');
  assert.match(descendantText(ui.current), /甲的当前状态.*乙的当前状态/);
  assert.equal(ui.timelines.children[0].hidden, true); assert.equal(ui.timelines.children[1].hidden, false);
  assert.deepEqual(ui.timelines.children[1].children.map(node => node.children[0].textContent), ['第 12 个结','第 10 个结']);
  assert.equal(ui.timelines.children[1].querySelector('.change-copy').tagName, 'DEL');
  assert.equal(ui.history.querySelectorAll('img').length, 0);
  assert.ok(ui.history.querySelectorAll('.change-copy').some(node => node.textContent === text));
  assert.equal(ui.history.querySelectorAll('.change-layer').length, 0, '情境标签移除');
  const detail = ui.timelines.children[1].children[0]; detail.open = false; detail.emit('toggle');
  memoryState.floors[1].messageIndex = 14; h.emit('MESSAGE_UPDATED'); await h.flushMicrotasks();
  ui = view.recallUi;
  assert.equal(ui.people.hidden, false); assert.equal(ui.picker.children[1].getAttribute('aria-pressed'), 'true');
  assert.equal(ui.timelines.children[1].children[0].open, false);
  assert.equal(ui.timelines.children[1].children[0].children[0].textContent, '第 14 个结');
  let prevented = false;
  ui.peopleTab.emit('keydown', {key:'ArrowLeft', preventDefault(){prevented=true;}});
  assert.equal(prevented,true); assert.equal(ui.events.hidden,false); assert.equal(ui.people.hidden,true);
  assert.equal(ui.eventTab.tabIndex,0); assert.equal(ui.peopleTab.tabIndex,-1); assert.equal(ui.eventTab.focused,true);
  ui.eventTab.emit('keydown', {key:'End', preventDefault(){}});
  assert.equal(ui.people.hidden,false); assert.equal(ui.peopleTab.getAttribute('aria-controls'),ui.people.id);
  assert.equal(view.root.children.filter(node => node.tagName === 'STYLE').length,2,'刷新不会累积样式');
});
