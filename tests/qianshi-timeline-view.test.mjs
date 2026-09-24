import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createQianshiTimelineView } from '../src/ui/qianshi-timeline-view.js';
import { createQianshiSnapshotMemo } from '../src/v3/memory-runtime.js';

class Node {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.className = ''; this.textContent = ''; this.hidden = false; this.open = false; this.disabled = false; this.value = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  fire(name, event = {}) { return this.listeners[name]?.(event); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  focus() { this.focused = true; }
  setSelectionRange() {}
  querySelector(selector) { return flatten(this).find(node => selector.startsWith('#') ? node.id === selector.slice(1) : selector === '.qqj-history-search-input' ? node.className.split(/\s+/u).includes('qqj-history-search-input') : false) ?? null; }
}
const flatten = node => [node, ...(node.children ?? []).flatMap(flatten)];
const copy = node => flatten(node).map(value => value.textContent).filter(Boolean).join('|');
const byText = (node, value) => flatten(node).find(item => item.textContent === value);
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const events = Array.from({ length: 7 }, (_, index) => ({
    id: `event-${index + 1}`, matterId: 'matter-1', updatesMatter: index !== 1, title: index === 0 ? '取得旧信' : `旧信进展 ${index + 1}`,
    description: index === 0 ? '这是完整说明正文，不是另造的第二份详情。' : `完整经过 ${index + 1}`,
    status: index === 6 ? 'completed' : index ? 'inProgress' : 'planned', storyTime: `2026-07-${String(index + 1).padStart(2, '0')} 10:00`,
    scheduledTime: index === 0 ? '2026-07-09' : null, people: [{ entityId: 'person', name: index === 0 ? '沈棠' : '闻舟' }], object: '旧信', sourceMessageIndex: 12 + index,
  }));
  events.push({ id: 'undated', matterId: null, updatesMatter: false, title: '无日期回忆', description: '后来提及但没有可靠日期。', status: 'occurred', storyTime: null, scheduledTime: null, people: [{ entityId: 'other', name: '旧友' }], object: null, sourceMessageIndex: 30 });
  return { status: 'ready', identity: { qqjChatId: 'chat-a' }, coverage: { eligibleFloors: 9, completeFloors: 7, pendingFloors: 2, partialFloors: 0, degradedFloors: 0, unavailableFloors: 0 },
    events, matters: [{ matterId: 'matter-1', eventIds: events.slice(0, 5).map(event => event.id) }], relations: [],
    timeline: { hasGlobalLatest: true, globalLatestGroupId: 'day-7', segments: [{ id: 'gregorian', label: '公历', latestGroupId: 'day-7', groups: events.slice(0, 7).map((event, index) => ({ id: `day-${index + 1}`, day: `${index + 1}日`, period: '2026年7月', full: event.storyTime, eventIds: [event.id] })) }], undatedEventIds: ['undated'] },
    history: { status: 'idle', processedFloors: 0, totalFloors: 0, calls: 0, message: '' } };
}

function harness({ confirm = false, initialSnapshot = fixture() } = {}) {
  let snapshot = structuredClone(initialSnapshot), state = { status: 'ready', memoryWorkBusy: false, qianshiHistoryActive: false }, prepareCalls = 0, startCalls = 0;
  const listeners = new Set(), confirms = [];
  const runtime = { getState: () => state, getQianshiSnapshot: () => structuredClone(snapshot), subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async prepareQianshiHistory() { prepareCalls += 1; return { status: 'ready', planId: 'plan', totalFloors: 2, batchCount: 1, apiCalls: 1, estimatedInputTokens: 900, unavailableFloors: [] }; },
    async startQianshiHistory() { startCalls += 1; return { status: 'completed' }; }, async stopQianshiHistory() { return { status: 'stopped' }; } };
  const documentRef = { createElement: tag => new Node(tag), defaultView: { matchMedia: () => ({ matches: false }) } };
  const view = createQianshiTimelineView({ runtime, documentRef, dialog: { async confirm(options) { confirms.push(options); return typeof confirm === 'function' ? confirm(options) : confirm; } } });
  const container = new Node('main'); view.mount(container);
  return { view, container, runtime, confirms, calls: () => ({ prepareCalls, startCalls }), emit(nextSnapshot = snapshot, nextState = state) { snapshot = nextSnapshot; state = nextState; for (const listener of listeners) listener(state); } };
}

test('千事页以健康条和共享搜索开头，说明与事项全链按需展开且不虚构地点', () => {
  const h = harness();
  const page = h.container.children[0];
  assert.match(page.children[0].className, /^qqj-qianshi-coverage /u);
  assert.equal(page.children[1].className, 'qqj-history-search');
  assert.deepEqual(page.children[1].children[0].className.split(/\s+/u), ['settings-input', 'qqj-history-search-input']);
  assert.deepEqual(page.children[1].children[1].className.split(/\s+/u), ['secondary-action', 'qqj-history-search-clear']);
  assert.doesNotMatch(copy(h.container), /故事年表|按剧情日期整理已保存的事件/u);
  assert.match(copy(h.container), /取得旧信.*这是完整说明正文/u);
  assert.equal(flatten(h.container).some(node => node.attributes['aria-label'] === '搜索事件' || /展开全部|收起全部/u.test(node.attributes['aria-label'] ?? '')), false);
  assert.doesNotMatch(copy(h.container), /地点/u);
  const first = flatten(h.container).find(node => node.dataset.eventId === 'event-1');
  assert.equal(flatten(first).some(node => node.className === 'qqj-qianshi-expanded'), false, '收起时不渲染每件事的整条长链');
  first.open = true; first.fire('toggle');
  assert.match(copy(first), /约定.*2026-07-09（约定 \/ 预计）.*来源.*第 12 楼/u);
  const matter = flatten(first).find(node => node.className === 'qqj-qianshi-matter');
  assert.equal(flatten(first).filter(node => node.className.includes('qqj-qianshi-matter-event')).length, 0, '顶层展开不立即复制事项链');
  matter.open = true; matter.fire('toggle');
  assert.equal(flatten(first).filter(node => node.className.includes('qqj-qianshi-matter-event')).length, 7, '事项超过5节点仍完整可查，含背景节点');
});

test('百节点同事项仍按线性顶层渲染，事项链只在二次展开时创建一次', () => {
  const large = fixture();
  large.events = Array.from({ length: 100 }, (_, index) => ({ ...large.events[0], id: `large-${index}`, title: `大事项 ${index}`, description: `说明 ${index}`, matterId: 'large-matter' }));
  large.timeline.segments[0].groups = large.events.map((event, index) => ({ id: `large-day-${index}`, day: `${index + 1}日`, period: '长历', full: `长历${index + 1}日`, eventIds: [event.id] }));
  large.timeline.segments[0].latestGroupId = 'large-day-99'; large.timeline.globalLatestGroupId = 'large-day-99'; large.timeline.undatedEventIds = [];
  const h = harness({ initialSnapshot: large });
  assert.equal(flatten(h.container).filter(node => node.dataset.eventId).length, 100);
  assert.equal(flatten(h.container).filter(node => node.className.includes('qqj-qianshi-matter-event')).length, 0, '展开全部不生成一万条事项链 DOM');
  const first = flatten(h.container).find(node => node.dataset.eventId === 'large-0'); first.open = true; first.fire('toggle');
  const firstMatter = flatten(first).find(node => node.className === 'qqj-qianshi-matter'); firstMatter.open = true; firstMatter.fire('toggle');
  assert.equal(flatten(firstMatter).filter(node => node.className.includes('qqj-qianshi-matter-event')).length, 100);
});

test('同日同事项合成当天末条代表，搜索覆盖非代表且排序不改代表', () => {
  const grouped = fixture();
  grouped.timeline.segments[0].groups = [
    { ...grouped.timeline.segments[0].groups[0], eventIds: ['event-1', 'event-2', 'event-3'] },
    ...grouped.timeline.segments[0].groups.slice(3),
  ];
  grouped.events.push({ ...grouped.events[0], id: 'independent', matterId: null, title: '同日独立事件', description: '独立说明', people: [{ entityId: 'independent', name: '旁人' }] });
  grouped.timeline.segments[0].groups[0].eventIds.push('independent');
  grouped.events.push({ ...grouped.events[0], id: 'undated-matter', title: '未知日期同事项', storyTime: null, people: [{ entityId: 'undated', name: '旧友' }] });
  grouped.timeline.undatedEventIds.push('undated-matter');
  const h = harness({ initialSnapshot: grouped });
  let top = flatten(h.container).filter(node => node.className === 'qqj-qianshi-event');
  assert.equal(top.filter(node => node.dataset.cardId === 'day-1:matter-1').length, 1, '同日同事项只显示一张卡');
  const group = top.find(node => node.dataset.cardId === 'day-1:matter-1');
  assert.equal(group.dataset.eventId, 'event-3', '代表固定为当天原正序最后一条');
  assert.match(copy(group), /旧信进展 3.*当天 3 条.*进行中/u);
  assert.ok(top.some(node => node.dataset.eventId === 'independent'), '同日独立事件不合并');
  assert.ok(top.some(node => node.dataset.eventId === 'undated-matter'), '未知日期事件不并入日期组');
  group.open = true; group.fire('toggle');
  const dayRows = flatten(group).filter(node => node.className.includes('qqj-qianshi-matter-event'));
  assert.equal(dayRows.length, 3, '展开卡片列出当天完整过程');
  assert.equal(flatten(dayRows[0]).some(node => node.className === 'qqj-qianshi-day-event-detail'), false, '每条详情保持懒创建');
  dayRows[0].open = true; dayRows[0].fire('toggle');
  assert.match(copy(dayRows[0]), /取得旧信.*这是完整说明正文.*第 12 楼/u);
  assert.ok(flatten(group).some(node => node.className === 'qqj-qianshi-matter'), '仍保留跨天完整事项经过入口');

  byText(h.container, '由晚到早').fire('click');
  assert.equal(flatten(h.container).find(node => node.dataset.cardId === 'day-1:matter-1').dataset.eventId, 'event-3', '倒序只改显示次序，不改代表');
  const input = flatten(h.container).find(node => node.className.split(/\s+/u).includes('qqj-history-search-input'));
  input.fire('input', { target: { value: '沈棠', selectionStart: 2 } });
  assert.match(copy(h.container), /匹配 1 件事件 · 显示 1 组.*旧信进展 3/u);
  const searched = flatten(h.container).find(node => node.dataset.cardId === 'day-1:matter-1'); searched.open = true; searched.fire('toggle');
  assert.match(copy(searched), /取得旧信/u, '非代表成员命中时仍可展开查看匹配项');
});

test('默认最新在前，方向切换按真实日期反转各自区域且不混排无年记录', () => {
  const snapshot = fixture();
  snapshot.events = [
    { id: 'old', matterId: null, title: '旧年', description: '旧年说明', status: 'occurred', storyTime: '公历2024年12月31日', scheduledTime: null, people: [] },
    { id: 'new', matterId: null, title: '新年', description: '新年说明', status: 'occurred', storyTime: '公历2025年1月1日', scheduledTime: null, people: [] },
    { id: 'oct', matterId: null, title: '无年十月', description: '十月说明', status: 'occurred', storyTime: '10月1日', scheduledTime: null, people: [] },
    { id: 'nov', matterId: null, title: '无年十一月', description: '十一月说明', status: 'occurred', storyTime: '11月3日', scheduledTime: null, people: [] },
    { id: 'range', matterId: null, title: '时间范围', description: '范围说明', status: 'unknown', storyTime: '10月1日至10月3日', scheduledTime: null, people: [] },
  ];
  snapshot.timeline = { hasGlobalLatest: false, globalLatestGroupId: null, segments: [
    { id: 'gregorian', label: '公历', latestGroupId: 'new-day', groups: [
      { id: 'old-day', day: '31日', period: '2024年12月', full: '公历2024年12月31日', eventIds: ['old'] },
      { id: 'new-day', day: '1日', period: '2025年1月', full: '公历2025年1月1日', eventIds: ['new'] },
    ] },
    { id: 'yearless', label: '年份未明', latestGroupId: 'nov-day', groups: [
      { id: 'oct-day', day: '1日', period: '10月', full: '10月1日（年份未明）', eventIds: ['oct', 'range'] },
      { id: 'nov-day', day: '3日', period: '11月', full: '11月3日（年份未明）', eventIds: ['nov'] },
    ] },
  ], undatedEventIds: [] };
  const h = harness({ initialSnapshot: snapshot });
  const dayOrder = () => flatten(h.container).filter(node => node.id && node.className.startsWith('qqj-qianshi-day')).map(node => node.id);
  assert.deepEqual(dayOrder(), ['new-day', 'old-day', 'nov-day', 'oct-day'], '初始最新在前，每个历法区域独立降序');
  assert.equal(byText(h.container, '由晚到早') !== undefined, true, '按钮显示当前排序方向');
  assert.match(copy(h.container), /年份未明 · 与其他时间区域不可直接比较/u);
  byText(h.container, '由晚到早').fire('click');
  assert.deepEqual(dayOrder(), ['old-day', 'new-day', 'oct-day', 'nov-day'], '切换后每个可比区域升序，区域顺序不被假装成绝对时间');
  assert.match(copy(h.container), /10月1日至10月3日/u, '可识别左端点的范围留在对应日期，并继续展示完整原文');
  assert.equal(byText(h.container, '由早到晚') !== undefined, true);
});

test('同日事项根据事件原文的显式秒倒序显示且切换后正序，保留原文时间', () => {
  const snapshot = fixture();
  snapshot.events = [
    { id: 'sec-early', matterId: null, title: '较早一秒', description: '早', status: 'occurred', storyTime: '公历2010年11月3日 12:34:05', scheduledTime: '公历2099年12月31日', people: [] },
    { id: 'sec-late', matterId: null, title: '较晚一秒', description: '晚', status: 'occurred', storyTime: '公历2010年11月3日 12:34:56', scheduledTime: '公历1900年1月1日', people: [] },
  ];
  snapshot.timeline = { hasGlobalLatest: true, globalLatestGroupId: 'same-day', segments: [{ id: 'gregorian', label: '公历', latestGroupId: 'same-day', groups: [
    { id: 'same-day', day: '3日', period: '2010年11月', full: '公历2010年11月3日', eventIds: ['sec-early', 'sec-late'] },
  ] }], undatedEventIds: [] };
  const h = harness({ initialSnapshot: snapshot });
  const ids = () => flatten(h.container).filter(node => node.dataset.eventId).map(node => node.dataset.eventId);
  assert.deepEqual(ids(), ['sec-late', 'sec-early'], '默认较晚秒先显示，scheduledTime不参与排序');
  const lateTime = flatten(h.container).find(node => node.className === 'qqj-qianshi-event-time' && node.textContent.includes('12:34:56'));
  assert.equal(lateTime.textContent, '公历2010年11月3日 12:34:56', '事件时间文本仍显示原始storyTime秒');
  byText(h.container, '由晚到早').fire('click');
  assert.deepEqual(ids(), ['sec-early', 'sec-late']);
});

test('状态胶囊保留当时语义，已发生不伪装成完成', () => {
  const snapshot = fixture(), statuses = ['planned', 'inProgress', 'completed', 'cancelled', 'occurred', 'unknown'];
  snapshot.events = snapshot.events.slice(0, statuses.length).map((event, index) => ({ ...event, id: `status-${index}`, matterId: null, status: statuses[index] }));
  snapshot.timeline.segments[0].groups = snapshot.events.map((event, index) => ({ id: `status-day-${index}`, day: `${index + 1}日`, period: '状态历', full: event.storyTime, eventIds: [event.id] }));
  snapshot.timeline.segments[0].latestGroupId = 'status-day-5'; snapshot.timeline.undatedEventIds = [];
  const h = harness({ initialSnapshot: snapshot });
  const badges = flatten(h.container).filter(node => node.className.includes('qqj-qianshi-state'));
  assert.deepEqual(badges.map(node => node.textContent), ['状态未明', '已发生', '已取消', '已完成', '进行中', '待办']);
  assert.deepEqual(badges.map(node => node.attributes['aria-label']), ['当时状态：状态未明', '当时状态：已发生', '当时状态：已取消', '当时状态：已完成', '当时状态：进行中', '当时状态：待办']);
});

test('旧快照即使带 important 也不会在时间线显示标记或颜色', () => {
  const grouped = fixture(); grouped.events[0].important = true;
  grouped.timeline.segments[0].groups = [
    { ...grouped.timeline.segments[0].groups[0], eventIds: ['event-1', 'event-2', 'event-3'] },
    ...grouped.timeline.segments[0].groups.slice(3),
  ];
  const h = harness({ initialSnapshot: grouped });
  const group = flatten(h.container).find(node => node.dataset.cardId === 'day-1:matter-1');
  assert.equal(group.dataset.eventId, 'event-3', '重要成员不改变当天原代表');
  assert.equal(group.className.includes('important'), false);
  assert.doesNotMatch(copy(group), /标为重要|取消重要|重要：|含重要事件/u);
  group.open = true; group.fire('toggle');
  const firstRow = flatten(group).find(node => node.className.includes('qqj-qianshi-matter-event'));
  firstRow.open = true; firstRow.fire('toggle');
  assert.doesNotMatch(copy(firstRow), /标为重要|取消重要|重要/u);
  assert.deepEqual(h.calls(), { prepareCalls: 0, startCalls: 0 });
});

test('千事时间线不再接收 settings，也不创建任何重要操作按钮', () => {
  const grouped = fixture();
  grouped.timeline.segments[0].groups = [
    { ...grouped.timeline.segments[0].groups[0], eventIds: ['event-1', 'event-2', 'event-3'] },
    ...grouped.timeline.segments[0].groups.slice(3),
  ];
  const runtime = { getState: () => ({}), getQianshiSnapshot: () => grouped, subscribe: () => () => {}, prepareQianshiHistory: async () => ({}), startQianshiHistory: async () => ({}), stopQianshiHistory: async () => ({}) };
  const documentRef = { createElement: tag => new Node(tag) };
  const view = createQianshiTimelineView({ runtime, documentRef });
  const container = new Node('main'); view.mount(container);
  assert.equal(flatten(container).some(node => node.tag === 'button' && /重要/u.test(node.textContent)), false);
  assert.doesNotMatch(copy(container), /重要/u);
});

test('重要事件颜色和按钮样式已从千事 CSS 移除', () => {
  const css = readFileSync(new URL('../src/ui/panel.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /qqj-qianshi-(?:important|importance)|qqj-qianshi-event\.important|qqj-qianshi-matter-event\.important/u);
});

test('未知日期和跨日事项详情保留普通展开交互且不含重要按钮', () => {
  const h = harness();
  const undated = flatten(h.container).find(node => node.dataset.eventId === 'undated');
  undated.open = true; undated.fire('toggle');
  assert.doesNotMatch(copy(undated), /标为重要|取消重要/u);

  const first = flatten(h.container).find(node => node.dataset.eventId === 'event-1'); first.open = true; first.fire('toggle');
  const matter = flatten(first).find(node => node.className === 'qqj-qianshi-matter'); matter.open = true; matter.fire('toggle');
  const historyRow = flatten(matter).find(node => node.className.includes('qqj-qianshi-matter-event')); historyRow.open = true; historyRow.fire('toggle');
  assert.doesNotMatch(copy(historyRow), /标为重要|取消重要|重要/u);
});

test('日期旁保留最近标记但不再提供最近定位按钮', () => {
  const h = harness();
  assert.ok(flatten(h.container).some(node => node.tag === 'span' && node.textContent === '最近'));
  assert.equal(flatten(h.container).some(node => node.tag === 'button' && node.textContent === '最近'), false);
});

test('短日主标签适配窄日期栏，完整日期仍作为详情提示', () => {
  const snapshot = fixture();
  snapshot.timeline.segments[0].groups[0] = { ...snapshot.timeline.segments[0].groups[0], day: '22日', full: '大陆历1686年9月22日 20:30 星期三' };
  const h = harness({ initialSnapshot: snapshot });
  const day = flatten(h.container).find(node => node.id === 'day-1');
  const date = day.children.find(node => node.className === 'qqj-qianshi-date');
  const dayName = flatten(date).find(node => node.className === 'qqj-qianshi-day-name');
  assert.equal(dayName.textContent.length, 3, '43px日期栏中的 nowrap 主字只占短日标签');
  assert.equal(date.title, '大陆历1686年9月22日 20:30 星期三', '完整日期仍可通过悬停查看');
});

test('搜索与后台通知保留展开状态，打开和浏览不会规划或启动历史模型任务', () => {
  const h = harness();
  const input = flatten(h.container).find(node => node.tag === 'input'); input.value = '沈棠'; input.fire('input', { target: { value: '沈棠', selectionStart: 2 } });
  assert.equal(flatten(h.container).find(node => node.tag === 'input').focused, true, '搜索重绘结果后保持输入焦点');
  assert.match(copy(h.container), /匹配 1 件事件 · 显示 1 组.*取得旧信/u);
  assert.equal(flatten(h.container).filter(node => node.dataset.eventId).length, 1, '搜索只保留命中的顶层事件，事项经过仍可完整查看');
  const matched = flatten(h.container).find(node => node.dataset.eventId === 'event-1'); matched.open = true; matched.fire('toggle');
  byText(h.container, '清除').fire('click');
  assert.equal(flatten(h.container).filter(node => node.className === 'qqj-qianshi-event' && node.open).length, 1, '清空搜索不连带展开未命中的事件');
  assert.equal(flatten(h.container).find(node => node.className === 'qqj-qianshi-undated').open, false, '清空搜索后时间未明外层恢复默认收起');
  h.emit();
  assert.equal(flatten(h.container).find(node => node.dataset.eventId === 'event-1').open, true);
  assert.deepEqual(h.calls(), { prepareCalls: 0, startCalls: 0 });
});

test('历史补齐先展示真实计划，取消零调用模型，确认后才启动', async () => {
  const cancelled = harness({ confirm: false }); byText(cancelled.container, '补齐旧楼').fire('click'); await tick();
  assert.deepEqual(cancelled.calls(), { prepareCalls: 1, startCalls: 0 });
  assert.match(cancelled.confirms[0].body, /2 楼.*1 批.*1 次.*900 tokens/u);
  assert.match(copy(cancelled.container), /已取消；没有调用模型/u);
  const confirmed = harness({ confirm: true }); byText(confirmed.container, '补齐旧楼').fire('click'); await tick(); await tick();
  assert.deepEqual(confirmed.calls(), { prepareCalls: 1, startCalls: 1 });
});

test('历史确认等待期间切聊或后台转忙，不执行旧计划', async () => {
  let resolveFirst; const switched = harness({ confirm: () => new Promise(resolve => { resolveFirst = resolve; }) });
  byText(switched.container, '补齐旧楼').fire('click'); await tick();
  switched.emit({ ...fixture(), identity: { qqjChatId: 'chat-b' } }); resolveFirst(true); await tick();
  assert.equal(switched.calls().startCalls, 0, '切聊使等待中的旧计划失效');

  let resolveSecond; const busy = harness({ confirm: () => new Promise(resolve => { resolveSecond = resolve; }) });
  byText(busy.container, '补齐旧楼').fire('click'); await tick();
  busy.emit(fixture(), { status: 'running', memoryWorkBusy: true, qianshiHistoryActive: false }); resolveSecond(true); await tick();
  assert.equal(busy.calls().startCalls, 0, '确认后复查现有 busy 语义，不和后台任务并行启动');
  assert.match(copy(busy.container), /后台任务状态已经变化/u);
});

test('千事快照 memo 在历史通知时复用全图，reachable 或身份投影变化才失效', () => {
  let builds = 0; const memo = createQianshiSnapshotMemo((reachable, _history, identity) => ({ status: 'ready', marker: `${reachable.id}:${identity.id}:${++builds}` }));
  const reachableA = { id: 'a' }, reachableB = { id: 'b' }, identityA = { id: 'ia' }, identityB = { id: 'ib' };
  const first = memo(reachableA, identityA, { status: 'idle' });
  const historyOnly = memo(reachableA, identityA, { status: 'running' });
  assert.equal(first.marker, historyOnly.marker); assert.equal(historyOnly.history.status, 'running'); assert.equal(builds, 1);
  memo(reachableB, identityA, { status: 'idle' }); memo(reachableB, identityB, { status: 'idle' }); assert.equal(builds, 3);
});
