import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createQianshiTimelineView } from '../src/ui/qianshi-timeline-view.js';
import { createQianshiSnapshotMemo } from '../src/v3/memory-runtime.js';
import { compileQianshiDelta, projectQianshiGraph, projectQianshiTimeline, publicQianshiSnapshot } from '../src/v3/qianshi-domain.js';

class Node {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.className = ''; this.textContent = ''; this.hidden = false; this.open = false; this.disabled = false; this.value = ''; this.scrollTop = 0; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  fire(name, event = {}) { return this.listeners[name]?.(event); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  focus() { this.focused = true; }
  setSelectionRange() {}
  querySelector(selector) { return flatten(this).find(node => selector.startsWith('#') ? node.id === selector.slice(1) : selector.startsWith('.') ? node.className.split(/\s+/u).includes(selector.slice(1)) : false) ?? null; }
  contains(node) { return flatten(this).includes(node); }
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

function harness({ confirm = false, choose = null, initialSnapshot = fixture(), plan = null, startResult = { status: 'completed', message: '' }, reviewResult = null } = {}) {
  let snapshot = structuredClone(initialSnapshot), state = { status: 'ready', memoryWorkBusy: false, qianshiHistoryActive: false }, prepareCalls = 0, startCalls = 0;
  const listeners = new Set(), confirms = [], reviewCalls = [];
  const runtime = { getState: () => state, getQianshiSnapshot: () => structuredClone(snapshot), subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async prepareQianshiHistory() { prepareCalls += 1; return { status: 'ready', planId: 'plan', totalFloors: 2, batchCount: 1, apiCalls: 1, localRepairFloors: 1, modelFloors: 2, estimatedInputTokens: 900, unavailableFloors: [], ...(plan ?? {}) }; },
    async startQianshiHistory() { startCalls += 1; if (typeof startResult === 'function') return startResult({ setHistory(history) { snapshot.history = history; for (const listener of listeners) listener(state); } }); snapshot.history = { ...snapshot.history, ...startResult }; for (const listener of listeners) listener(state); return startResult; },
    async confirmQianshiHistoryReview({ independent, ...review }) { reviewCalls.push({ independent, ...review }); if (reviewResult) return reviewResult({ independent, review, snapshot, emit(next = state) { for (const listener of listeners) listener(next); } }); snapshot.history.pendingReviews = []; snapshot.history.message = independent ? '已确认独立新事实。' : '已拒绝追加。'; for (const listener of listeners) listener(state); return snapshot.history; },
    async stopQianshiHistory() { return { status: 'stopped' }; } };
  const documentRef = { createElement: tag => new Node(tag), defaultView: { matchMedia: () => ({ matches: false }) } };
  const view = createQianshiTimelineView({ runtime, documentRef, dialog: { async confirm(options) { confirms.push(options); return typeof confirm === 'function' ? confirm(options) : confirm; },
    async choose(options) { confirms.push(options); return typeof choose === 'function' ? choose(options) : choose; } } });
  const container = new Node('main'); view.mount(container);
  return { view, container, runtime, documentRef, confirms, reviewCalls, calls: () => ({ prepareCalls, startCalls }), emit(nextSnapshot = snapshot, nextState = state) { snapshot = nextSnapshot; state = nextState; for (const listener of listeners) listener(state); } };
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

test('覆盖状态同屏列出各缺口并把有效摘要楼数写清楚', () => {
  const snapshot = fixture();
  snapshot.coverage = { eligibleFloors: 8, completeFloors: 3, pendingFloors: 1, partialFloors: 2, degradedFloors: 2, unavailableFloors: 1 };
  const h = harness({ initialSnapshot: snapshot });
  const coverage = flatten(h.container).map(node => node.textContent).join('|');
  assert.match(coverage, /已完成 3 楼；待补 1 楼；部分整理 2 楼；断链 2 楼；无唯一有效摘要 1 楼/u);
  assert.match(coverage, /分母是 8 个有唯一有效摘要的楼/u);
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

test('真实投影与时间线视图始终先显示有年份日期段，再显示月日段', () => {
  const snapshot = fixture();
  snapshot.events = [
    { id: 'yearless-late', matterId: null, title: '旧档九月二十四日', description: '无年份', status: 'occurred', storyTime: '9月24日', scheduledTime: null, people: [] },
    { id: 'gregorian-earlier', matterId: null, title: '公历较早日期', description: '有年份', status: 'occurred', storyTime: '公历2026年9月22日', scheduledTime: null, people: [] },
    { id: 'gregorian-later', matterId: null, title: '公历较晚日期', description: '有年份', status: 'occurred', storyTime: '公历2026年9月23日', scheduledTime: null, people: [] },
    { id: 'named-calendar', matterId: null, title: '具名历法日期', description: '另一历法', status: 'occurred', storyTime: '大陆历1686年9月23日', scheduledTime: null, people: [] },
    { id: 'undated', matterId: null, title: '时间未明', description: '保留底部', status: 'occurred', storyTime: null, scheduledTime: null, people: [] },
  ];
  snapshot.matters = []; snapshot.relations = [];
  snapshot.timeline = projectQianshiTimeline({ events: snapshot.events, relations: snapshot.relations });
  const h = harness({ initialSnapshot: snapshot });
  const dayOrder = () => flatten(h.container).filter(node => node.id && node.className.startsWith('qqj-qianshi-day')).map(node => node.id);
  assert.deepEqual(snapshot.timeline.segments.map(segment => segment.id), ['gregorian', 'named:大陆历', 'yearless'],
    '明确年份段优先，已知年份段内部保持首次出现顺序');
  const segmentLabels = () => flatten(h.container).filter(node => node.className === 'qqj-qianshi-segment-label').map(node => node.textContent);
  assert.deepEqual(segmentLabels(), [
    '公历 · 与其他时间区域不可直接比较', '大陆历 · 与其他时间区域不可直接比较', '年份未明 · 与其他时间区域不可直接比较',
  ]);
  assert.match(copy(h.container), /无法确定单一发生时间 · 1 件/u, '无法排序的日期仍留在底部折叠区');

  const initialOrder = dayOrder();
  assert.equal(initialOrder[0], snapshot.timeline.segments[0].groups.at(-1).id, '默认显示方向只反转段内日期');
  assert.equal(initialOrder[2], snapshot.timeline.segments[1].groups[0].id, '不同历法段仍按稳定首次顺序排列');
  byText(h.container, '由晚到早').fire('click');
  const ascendingOrder = dayOrder();
  assert.deepEqual(ascendingOrder.slice(0, 2), snapshot.timeline.segments[0].groups.map(group => group.id), '升序仍保持公历年份段在前');
  assert.equal(ascendingOrder[2], snapshot.timeline.segments[1].groups[0].id, '升序仍保持第二历法段在前于无年段');
  assert.equal(ascendingOrder.at(-1), snapshot.timeline.segments[2].groups[0].id, '升序仍将无年份月日段放在最后');
});

test('编译到真实快照与视图中，普通楼和聚合楼的2010年均标为年份已知', async () => {
  const chatId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', generation = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const floors = [1, 2].map(index => ({ id: index === 1 ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222',
    chatId, narrativeGeneration: generation, assistantSeq: index, hostLocator: { messageIndex: index }, content: { canonicalContent: `第${index}楼` } }));
  const ordinaryDelta = await compileQianshiDelta({ floor: floors[0], now: '2026-09-25T00:00:00.000Z', packet: { qianshi: { events: [
    { key: 'ordinary-known', title: '普通楼明确日期', description: '普通楼明确写明2010年9月22日。', status: 'occurred', matter: false, storyTime: '2010年9月22日' },
    { key: 'yearless', title: '旧档月日', description: '只写了9月24日。', status: 'occurred', matter: false, storyTime: '9月24日' },
    { key: 'named', title: '具名历法', description: '另一套历法中的日期。', status: 'occurred', matter: false, storyTime: '大陆历1686年9月23日' },
  ], order: [] } } });
  const aggregateDelta = await compileQianshiDelta({ floor: floors[1], sourceFloorBindings: [
    { floorKey: 'floor-1', floorId: floors[0].id }, { floorKey: 'floor-2', floorId: floors[1].id },
  ], now: '2026-09-25T00:00:00.000Z', packet: { qianshi: { events: [
    { key: 'aggregate-known', sourceFloorKey: 'floor-1', title: '聚合楼明确日期', description: '旧楼成员明确写明2010年9月23日。', status: 'occurred', matter: false, storyTime: '2010年9月23日' },
  ], order: [] } } });
  const reachable = { root: { chatId, narrativeGeneration: generation, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 1, floors,
    floorMemories: [
      { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', floorId: floors[0].id, recordStatus: 'active', chronology: [], qianshiDelta: ordinaryDelta },
      { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', floorId: floors[1].id, sourceFloorIds: floors.map(floor => floor.id), recordStatus: 'active', chronology: [], qianshiDelta: aggregateDelta },
    ], entities: [] };
  const projection = projectQianshiGraph(reachable), snapshot = publicQianshiSnapshot(reachable);
  const dated = snapshot.timeline.segments.find(segment => segment.id === 'bare');
  assert.equal(dated.label, '年份已知，历法未注明');
  assert.ok(dated.groups.some(group => group.eventIds.includes(projection.events.find(event => event.title === '普通楼明确日期').id)));
  assert.ok(dated.groups.some(group => group.eventIds.includes(projection.events.find(event => event.title === '聚合楼明确日期').id)));
  assert.equal(snapshot.timeline.segments.findIndex(segment => segment.id === 'yearless') > snapshot.timeline.segments.findIndex(segment => segment.id === 'bare'), true,
    '无年份月日仍在明确年份段之后独立展示');

  const h = harness({ initialSnapshot: snapshot });
  const segmentLabels = () => flatten(h.container).filter(node => node.className === 'qqj-qianshi-segment-label').map(node => node.textContent);
  assert.deepEqual(segmentLabels(), [
    '年份已知，历法未注明 · 与其他时间区域不可直接比较', '大陆历 · 与其他时间区域不可直接比较', '年份未明 · 与其他时间区域不可直接比较',
  ]);
  assert.match(copy(h.container), /2010年9月22日/u);
  assert.match(copy(h.container), /2010年9月23日/u);
  assert.doesNotMatch(copy(h.container), /2010年9月(?:22|23)日[^|]*年份未明/u);
  byText(h.container, '由晚到早').fire('click');
  assert.deepEqual(segmentLabels(), [
    '年份已知，历法未注明 · 与其他时间区域不可直接比较', '大陆历 · 与其他时间区域不可直接比较', '年份未明 · 与其他时间区域不可直接比较',
  ], '正倒序只改变各段内部日期，不改年份精度分组');
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
  const runtime = { getState: () => ({}), getQianshiSnapshot: () => grouped, subscribe: () => () => {}, prepareQianshiHistory: async () => ({}), startQianshiHistory: async () => ({}), stopQianshiHistory: async () => ({}), confirmQianshiHistoryReview: async () => ({}) };
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
  assert.match(cancelled.confirms[0].body, /2 楼.*1 批.*1 次.*900 token/u);
  assert.match(cancelled.confirms[0].body, /2 楼进入模型补齐.*1 楼会在本地隔离确证失效引用/u);
  assert.match(cancelled.confirms[0].note, /打开计划和取消均不会写入或调用 API/u);
  assert.match(copy(cancelled.container), /已取消；没有调用模型/u);
  const confirmed = harness({ confirm: true }); byText(confirmed.container, '补齐旧楼').fire('click'); await tick(); await tick();
  assert.deepEqual(confirmed.calls(), { prepareCalls: 1, startCalls: 1 });
});

test('已审楼结案只显示一个批量入口，预览明确零 API 且逐楼结果可见', async () => {
  const h = harness({ confirm: true });
  let prepareCount = 0, startCount = 0;
  h.runtime.prepareQianshiReviewedClose = async () => { prepareCount += 1; return { status: 'ready', planId: 'reviewed-plan', totalFloors: 3, apiCalls: 0 }; };
  h.runtime.startQianshiReviewedClose = async planId => {
    startCount += 1; assert.equal(planId, 'reviewed-plan');
    return { outcomes: [
      { floorId: 'one', status: 'saved-complete' },
      { floorId: 'two', status: 'saved-partial' },
      { floorId: 'three', status: 'failed' },
    ] };
  };
  const snapshot = h.runtime.getQianshiSnapshot();
  snapshot.history.persistedIssues = [{ floorId: 'one', assistantSeq: 1, canAcceptCurrent: true, message: '待处理' },
    { floorId: 'two', assistantSeq: 2, canAcceptCurrent: true, message: '待处理' },
    { floorId: 'three', assistantSeq: 3, canAcceptCurrent: true, message: '待处理' }];
  h.emit(snapshot);
  const buttons = flatten(h.container).filter(node => node.tag === 'button');
  const action = buttons.find(node => /按已审结果结案/u.test(node.textContent));
  assert.equal(action.textContent, '按已审结果结案 · 3 楼');
  assert.equal(buttons.filter(node => /按已审结果结案/u.test(node.textContent)).length, 1, '只显示单个批量入口');
  assert.equal(buttons.some(node => /第 [123] 楼.*结案/u.test(node.textContent)), false, '不增加逐楼操作按钮');
  action.fire('click'); await tick(); await tick();
  assert.equal(prepareCount, 1); assert.equal(startCount, 1);
  assert.match(h.confirms[0].body, /模型 API 调用 0 次/u);
  assert.match(copy(h.container), /结案完成：1 楼结案，1 楼保持部分状态，1 楼失败；模型 API 调用 0 次/u);
});

test('历史补齐运行时显示真实阶段，并在待确认卡中跨列展示长文本', async () => {
  let markStartCalled, markRunning, releaseStart, releaseRun;
  const startCalled = new Promise(resolve => { markStartCalled = resolve; }), runningStarted = new Promise(resolve => { markRunning = resolve; });
  const waitForStart = new Promise(resolve => { releaseStart = resolve; }), waitForRun = new Promise(resolve => { releaseRun = resolve; });
  const longText = `原记录与后续引用存在冲突：${'仍需核对'.repeat(30)}`;
  const snapshot = fixture();
  snapshot.history = { status: 'partial', jobId: 'job', processedFloors: 0, totalFloors: 1, calls: 1,
    conflictFloors: 1, pendingReviews: [{ floorId: 'floor-75', assistantSeq: 75, reason: longText,
      events: [{ id: 'pending-event', title: '待确认事件', description: longText }] }] };
  const h = harness({ initialSnapshot: snapshot, confirm: true, startResult: async ({ setHistory }) => {
    markStartCalled(); await waitForStart;
    setHistory({ status: 'running', processedFloors: 0, totalFloors: 1, calls: 0, attemptedFloors: 1,
      savedCompleteFloors: 0, savedPartialFloors: 0, failedFloors: 1, conflictFloors: 0, skippedFloors: 0,
      outcomes: [{ assistantSeq: 75, status: 'failed', reasonCode: 'QIANSHI_HISTORY_CANDIDATE_STALE', message: '本批实际引用的前楼事项语义已变化，本楼原记录保留。' }],
      message: '正在重新读取并核对当前聊天与千事存档…' });
    markRunning(); await waitForRun;
    const result = { status: 'completed', message: '补齐完成。', calls: 1, processedFloors: 1, totalFloors: 1 };
    setHistory(result); return result;
  } });
  const card = flatten(h.container).find(node => node.className === 'qqj-qianshi-history-review');
  assert.ok(card); assert.match(copy(card), new RegExp(longText));
  const css = readFileSync(new URL('../src/ui/panel.css', import.meta.url), 'utf8');
  assert.match(css, /\.qqj-qianshi-history-review\{[^}]*grid-column:1\/-1;[^}]*min-width:0/u);
  assert.match(css, /\.qqj-qianshi-history-review-actions>\.secondary-action\{[^}]*max-width:100%;white-space:normal/u);

  byText(h.container, '补齐旧楼').fire('click'); await startCalled;
  assert.match(copy(h.container), /计划已确认；正在启动本地核对/u, 'runtime 首次发布运行状态前保留短暂提示');
  releaseStart(); await runningStarted;
  assert.match(copy(h.container), /已成功保存替换 0\/1 楼 · 已尝试 1 楼；失败 1 楼；待确认 0 楼；跳过 0 楼 · 模型任务尝试 0 次 · 正在重新读取并核对当前聊天与千事存档/u,
    'running 状态分别呈现成功替换、尝试和失败数量，并显示 runtime 阶段');
  assert.doesNotMatch(copy(h.container), /计划已确认；正在启动本地核对/u, '核对阶段不残留启动提示');
  releaseRun(); await tick(); await tick();
  assert.match(copy(h.container), /补齐完成/u);
  assert.doesNotMatch(copy(h.container), /计划已确认；正在启动本地核对/u, '结束状态也不残留启动提示');

  const failed = harness({ confirm: true, startResult: async () => { throw new Error('测试启动失败'); } });
  byText(failed.container, '补齐旧楼').fire('click'); await tick(); await tick();
  assert.match(copy(failed.container), /历史补齐未开始：测试启动失败/u, '启动异常仍显示最终错误提示');
  assert.doesNotMatch(copy(failed.container), /计划已确认；正在启动本地核对/u);
});

test('聚合计划区分可模型楼、本地修整和跳过说明，空计划与执行失败均有可见原因', async () => {
  const plan = { totalFloors: 1, batchCount: 0, apiCalls: 0, modelFloors: 0, localRepairFloors: 1,
    aggregateSkippedFloors: [{ floorId: 'aggregate', assistantSeq: 10 }] };
  const confirmed = harness({ confirm: true, plan, startResult: { status: 'partial', message: '其中 1 楼本地隔离未成功，原记录保留；请重新准备计划。' } });
  byText(confirmed.container, '补齐旧楼').fire('click'); await tick(); await tick();
  assert.match(confirmed.confirms[0].body, /0 楼进入模型补齐.*1 楼会在本地隔离.*1 楼由多个正文楼聚合/u);
  assert.match(confirmed.confirms[0].body, /跳过模型替换以保留成员来源/u);
  assert.match(copy(confirmed.container), /本地隔离未成功，原记录保留/u, '执行失败时 UI 显示失败事实而不宣称已隔离');

  const emptySnapshot = fixture();
  const empty = harness({ initialSnapshot: emptySnapshot, plan: { status: 'empty', totalFloors: 0, batchCount: 0,
    apiCalls: 0, aggregateSkippedFloors: [{ floorId: 'aggregate', assistantSeq: 10 }] } });
  byText(empty.container, '补齐旧楼').fire('click'); await tick();
  assert.match(copy(empty.container), /由多个正文楼聚合.*跳过模型替换/u);
  assert.equal(empty.calls().startCalls, 0);
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

test('待审列表可搜索，选中后展示相似旧条和依据并提供明确二选一', async () => {
  const snapshot = fixture();
  snapshot.history = { status: 'partial', jobId: 'job', processedFloors: 0, totalFloors: 1, calls: 1,
    attemptedFloors: 1, savedCompleteFloors: 0, savedPartialFloors: 0, conflictFloors: 1, skippedFloors: 0, failedFloors: 0,
    outcomes: [{ floorId: 'floor-73', assistantSeq: 73, status: 'conflict-review', reasonCode: 'QIANSHI_HISTORY_REPLACEMENT_CONFLICT', message: '后楼仍引用旧事件' }],
    pendingReviews: [{ floorId: 'floor-73', assistantSeq: 73, reason: '新事件与本楼旧记录存在可见文本重合，请审阅后决定。', events: [
      { id: 'new-event', title: '新约定', description: '新事实正文', matchBasis: ['共同词项“旧信”'],
        recommendedEvent: { id: 'old-event', title: '旧约定', description: '已存的旧约定正文', sourceAssistantSeq: 10,
          storyTime: '2026-07-01', people: [{ name: '沈棠' }], object: '旧信', referenceCount: 2 } },
    ] }] };
  const h = harness({ initialSnapshot: snapshot });
  assert.match(copy(h.container), /待审候选 1 项/u);
  assert.match(copy(h.container), /第 73 楼 · 新约定/u);
  assert.match(copy(h.container), /旧约定.*已存的旧约定正文.*第 10 楼/u);
  assert.match(copy(h.container), /共同词项“旧信”/u);
  assert.match(copy(h.container), /这些词项只用于定位可能相似的旧条，是否为重复由你决定/u);
  assert.deepEqual(flatten(h.container).filter(node => node.tag === 'button').map(node => node.textContent).filter(value => /保存为新事件|这是重复/u.test(value)),
    ['保存为新事件', '这是重复，不保存']);
  const actions = flatten(h.container).find(node => node.className === 'qqj-qianshi-history-review-actions');
  assert.deepEqual(actions.children.map(node => node.textContent), ['保存为新事件', '这是重复，不保存'], '两个操作按钮在同一局部容器');
  const css = readFileSync(new URL('../src/ui/panel.css', import.meta.url), 'utf8');
  assert.match(css, /\.qqj-qianshi-history-review-list\{[^}]*margin-top:8px/u, '搜索框与候选列表之间保留垂直间距');
  assert.match(css, /\.qqj-qianshi-history-review-actions\{[^}]*flex-wrap:wrap;gap:8px/u, '窄屏可换行且按钮间距为 8px');
  assert.equal(h.confirms.length, 0, '展示待审卡不启动弹窗');
});

test('冷启动 idle 时恢复持久待审候选与已审楼异常', () => {
  const snapshot = fixture();
  snapshot.history = { status: 'idle', pendingReviews: [{ floorId: 'floor-21', assistantSeq: 21, reason: '待确认候选',
    events: [{ id: 'restored-candidate', title: '恢复后的候选', description: '候选正文' },
      { id: 'restored-candidate-b', title: '同楼第二候选', description: '第二项候选正文' }] }],
    persistedIssues: [{ floorId: 'floor-22', assistantSeq: 22, reconciliationStatus: 'partial', message: '关系端点仍待处理。' }] };
  const h = harness({ initialSnapshot: snapshot });
  assert.match(copy(h.container), /已恢复 2 项待审候选；本地核对已结束，但 1 楼仍未能证明千事完整/u);
  assert.doesNotMatch(copy(h.container), /已审楼仍待处理/u, '已审楼记录不再显示成候选仍待处理');
  assert.match(copy(h.container), /待审候选 2 项.*恢复后的候选.*同楼第二候选/u);
  const disclosure = flatten(h.container).find(node => node.className === 'qqj-qianshi-history-terminal-partial');
  assert.equal(disclosure.open, false, '刷新恢复的终态 partial 默认收起');
  assert.equal(disclosure.children[0].textContent, '已核对，仍为部分完成 · 1 楼');
  const results = flatten(disclosure).find(node => node.className === 'qqj-qianshi-history-results');
  assert.equal(results.attributes['aria-label'], '已结束核对但仍部分完成的楼层');
  assert.match(copy(disclosure), /已核对，仍为部分完成.*第 22 楼：关系端点仍待处理/u);
  assert.deepEqual(flatten(h.container).filter(node => node.tag === 'button').map(node => node.textContent).filter(value => /保存为新事件|这是重复/u.test(value)),
    ['保存为新事件', '这是重复，不保存'], '两个审阅操作仍只对应待审候选，没有为已审楼增加处理按钮');
});

test('审阅保存错误显示卡内反馈，刷新切聊后不误提交旧卡', async () => {
  const snapshot = fixture();
  snapshot.history = { status: 'partial', totalFloors: 1, calls: 1,
    pendingReviews: [{ floorId: 'floor-73', assistantSeq: 73, reason: '后楼仍引用旧事件',
      events: [{ id: 'new-event', title: '新约定', description: '新事实正文' }] }] };
  let attempt = 0;
  const h = harness({ initialSnapshot: snapshot, reviewResult: async ({ independent, review, snapshot: current, emit }) => {
    assert.equal(independent, true, '明确独立选择向生产 seam 传 true');
    assert.equal(review.eventId, 'new-event');
    if (attempt++ === 0) throw new Error('后端请求超时，保存状态待核对');
    current.history.pendingReviews = [];
    current.history.message = '已确认独立新事实。'; emit(); return current.history;
  } });
  byText(h.container, '保存为新事件').fire('click'); await tick(); await tick();
  const cardAfterTimeout = flatten(h.container).find(node => node.className === 'qqj-qianshi-history-review');
  assert.match(copy(cardAfterTimeout), /保存结果待核对：后端请求超时/u, '失败原因显示在当前待确认卡内');
  assert.equal(flatten(cardAfterTimeout).filter(node => node.tag === 'button').find(node => node.textContent === '保存为新事件').disabled, false,
    '失败后保留用户决定是否重试的入口');
  byText(cardAfterTimeout, '保存为新事件').fire('click'); await tick(); await tick();
  assert.equal(h.reviewCalls.length, 2, '重试由用户再次点击触发');
  assert.equal(flatten(h.container).some(node => node.className === 'qqj-qianshi-history-review'), false, '确认成功后卡片消失');
  assert.match(copy(h.container), /已保存为新事件/u);

  const switched = harness({ initialSnapshot: snapshot });
  const staleReview = switched.runtime.confirmQianshiHistoryReview;
  switched.emit({ ...snapshot, identity: { qqjChatId: 'chat-b' }, history: { status: 'idle', pendingReviews: [] } });
  byText(switched.container, '保存为新事件')?.fire('click'); await tick();
  assert.equal(switched.reviewCalls.length, 0, '切聊后旧卡入口已移除');
  assert.equal(typeof staleReview, 'function');
});

test('历史编译 partial 在时间线中显示楼号和逐楼原因', () => {
  const snapshot = fixture();
  snapshot.history = { status: 'partial', message: '1 楼保存部分结果。', attemptedFloors: 1,
    savedCompleteFloors: 0, savedPartialFloors: 1, conflictFloors: 0, skippedFloors: 0, failedFloors: 0,
    outcomes: [{ floorId: 'floor-74', assistantSeq: 74, status: 'saved-partial',
      reasonCode: 'QIANSHI_HISTORY_COMPILE_PARTIAL', message: '事件 1 将一次性事件当作持续事项的进展；应改为背景关联或补充先后顺序。' }], pendingReviews: [] };
  const h = harness({ initialSnapshot: snapshot });
  assert.match(copy(h.container), /第 74 楼：事件 1 将一次性事件当作持续事项的进展/u);
  assert.doesNotMatch(copy(h.container), /QIANSHI_|qianshi_|events\[|\bprogress\b|\bcontext\b|\bpartial\b|\bfloors\b|\btokens\b/u);
});

test('刷新后终态 partial 默认收起，重绘保留展开状态且详情跨 coverage 双列', () => {
  const snapshot = fixture();
  snapshot.history = { status: 'idle', pendingReviews: [], persistedIssues: [
    { floorId: 'floor-73', assistantSeq: 73, reconciliationStatus: 'partial', message: '已保存的独立事件仍有关系端点或关系未入账，本楼保持部分状态。' },
  ] };
  const h = harness({ initialSnapshot: snapshot });
  const disclosure = h.container.querySelector('.qqj-qianshi-history-terminal-partial');
  assert.ok(disclosure, '冷启动恢复已审楼终态 partial');
  assert.equal(disclosure.open, false, '冷启动恢复详情默认收起');
  assert.match(copy(disclosure), /第 73 楼：已保存的独立事件仍有关系端点或关系未入账，本楼保持部分状态/u);
  assert.match(copy(h.container), /再次点补齐不会重新核对这些楼/u);
  assert.equal(flatten(h.container).some(node => node.tag === 'strong' && node.textContent.includes('候选已审完但')), false,
    '已终态楼不再进入待处理提示');

  disclosure.open = true; disclosure.fire('toggle');
  h.emit({ ...snapshot, history: { ...snapshot.history, message: '状态刷新' } });
  assert.equal(h.container.querySelector('.qqj-qianshi-history-terminal-partial').open, true, '同聊天后台通知后保留展开状态');
  const search = h.container.querySelector('.qqj-history-search-input');
  search.fire('input', { target: { value: '旧信', selectionStart: 2 } });
  assert.equal(h.container.querySelector('.qqj-qianshi-history-terminal-partial').open, true, '搜索重绘后保留展开状态');
  byText(h.container, '由晚到早').fire('click');
  assert.equal(h.container.querySelector('.qqj-qianshi-history-terminal-partial').open, true, '排序重绘后保留展开状态');

  const css = readFileSync(new URL('../src/ui/panel.css', import.meta.url), 'utf8');
  assert.match(css, /\.qqj-qianshi-history-terminal-partial\{grid-column:1\/-1;min-width:0\}/u,
    '详情在 coverage 双列和窄屏单列时都占满结果宽度');
  h.emit({ ...snapshot, identity: { qqjChatId: 'chat-b' } });
  assert.equal(h.container.querySelector('.qqj-qianshi-history-terminal-partial').open, false, '切换聊天时回到默认收起');
});

test('本轮终态核对 partial 默认收起，真实失败继续显示在顶部结果区且楼层不重复', () => {
  const snapshot = fixture();
  snapshot.history = { status: 'partial', message: '本地核对完成；未能证明完整的楼仍保留部分状态并显示原因。',
    attemptedFloors: 2, totalFloors: 2, savedCompleteFloors: 0, savedPartialFloors: 1, failedFloors: 1,
    outcomes: [
      { floorId: 'floor-73', assistantSeq: 73, status: 'saved-partial', reasonCode: 'QIANSHI_HISTORY_RECONCILE_PARTIAL', message: '关系端点尚未可证。' },
      { floorId: 'floor-74', assistantSeq: 74, status: 'failed', reasonCode: 'BACKEND_TIMEOUT', message: '本楼本地保存失败，原记录已保留。' },
    ], pendingReviews: [], persistedIssues: [
      { floorId: 'floor-73', assistantSeq: 73, reconciliationStatus: 'partial', message: '关系端点尚未可证。' },
    ] };
  const h = harness({ initialSnapshot: snapshot });
  const disclosure = h.container.querySelector('.qqj-qianshi-history-terminal-partial');
  assert.ok(disclosure);
  assert.equal(disclosure.open, false, '本轮结束结果默认收起');
  assert.equal((copy(h.container).match(/第 73 楼：关系端点尚未可证。/gu) ?? []).length, 1, 'outcome 与持久快照同一楼只展示一次');
  assert.match(copy(disclosure), /第 73 楼：关系端点尚未可证/u);
  const visibleResults = flatten(h.container).find(node => node.className === 'qqj-qianshi-history-results'
    && node.attributes['aria-label'] === '历史补齐逐楼结果');
  assert.ok(visibleResults, '真实失败仍在单独的顶部结果区显示');
  assert.match(copy(visibleResults), /第 74 楼：本楼本地保存失败/u);
  assert.doesNotMatch(copy(visibleResults), /第 73 楼/u);
  assert.match(copy(h.container), /本地核对已结束，但 1 楼仍未能证明千事完整；再次点补齐不会重新核对这些楼/u);
});

test('待审搜索后详情和操作只绑定当前可见候选', async () => {
  const snapshot = fixture();
  snapshot.history = { status: 'partial', pendingReviews: [{ floorId: 'floor-8', assistantSeq: 8, reason: '两项待确认', events: [
    { id: 'candidate-a', title: 'Alpha 旧候选', description: '第一个候选详情', recommendedEvent: { title: 'Alpha 旧条', description: '旧条说明' } },
    { id: 'candidate-b', title: 'Beta 新候选', description: '第二个候选详情', recommendedEvent: { title: 'Beta 旧条', description: '目标旧条说明' } },
  ] }] };
  const h = harness({ initialSnapshot: snapshot });
  const search = flatten(h.container).find(node => node.className.split(/\s+/u).includes('qqj-qianshi-review-search'));
  search.value = 'Beta'; search.fire('input', { target: { value: 'Beta', selectionStart: 4 } });
  const panel = flatten(h.container).find(node => node.className === 'qqj-qianshi-history-review');
  assert.match(copy(panel), /新候选：Beta 新候选.*第二个候选详情.*最相似旧条：Beta 旧条/u);
  assert.doesNotMatch(copy(panel), /Alpha 旧候选|第一个候选详情|Alpha 旧条/u, '过滤后不显示其他候选的详情');
  assert.equal(flatten(panel).filter(node => node.attributes.role === 'option').length, 1, '选项和详情使用同一过滤集合');
  byText(panel, '保存为新事件').fire('click'); await tick();
  assert.equal(h.reviewCalls.length, 1);
  assert.equal(h.reviewCalls[0].eventId, 'candidate-b', '确认按钮操作当前搜索命中的候选');
});

test('点击待审列表底部候选后，同聊天重绘保留列表位置与该候选焦点，切聊天时重置', () => {
  const snapshot = fixture();
  snapshot.history = { status: 'partial', pendingReviews: [
    { floorId: 'floor-3', assistantSeq: 3, events: [{ id: 'candidate-3', title: '第三楼候选', description: '低楼说明' }] },
    { floorId: 'floor-8', assistantSeq: 8, events: [{ id: 'candidate-8', title: '第八楼候选', description: '中楼说明' }] },
    { floorId: 'floor-15', assistantSeq: 15, events: [{ id: 'candidate-15', title: '第十五楼候选', description: '底部候选说明' }] },
  ] };
  const h = harness({ initialSnapshot: snapshot });
  const list = h.container.querySelector('.qqj-qianshi-history-review-list');
  const bottom = list.children.at(-1);
  list.scrollTop = 137;
  h.documentRef.activeElement = bottom;
  bottom.fire('click');

  const redrawnList = h.container.querySelector('.qqj-qianshi-history-review-list');
  const redrawnBottom = redrawnList.children.at(-1);
  assert.equal(redrawnList.scrollTop, 137, '重绘保留列表内部滚动位置');
  assert.equal(redrawnBottom.focused, true, '重绘把焦点还给刚点选的底部候选');
  assert.match(copy(h.container), /新候选：第十五楼候选.*底部候选说明/u, '详情仍显示刚点选的候选');

  h.emit({ ...snapshot, identity: { qqjChatId: 'chat-b' } });
  const switchedList = h.container.querySelector('.qqj-qianshi-history-review-list');
  assert.equal(switchedList.scrollTop, 0, '切换聊天后列表从顶部开始');
  assert.equal(switchedList.children.at(-1).focused, undefined, '切换聊天时不转移旧聊天的焦点');
});

test('历史逐楼结果限高半屏、独立滚动并在同聊天重绘保留位置与焦点', () => {
  const snapshot = fixture();
  snapshot.history = { status: 'running', totalFloors: 20, calls: 1, attemptedFloors: 2, savedCompleteFloors: 1,
    savedPartialFloors: 0, conflictFloors: 1, skippedFloors: 0, failedFloors: 0,
    outcomes: [
      { assistantSeq: 12, status: 'conflict-review', reasonCode: 'QIANSHI_HISTORY_REPLACEMENT_CONFLICT', message: '第十二楼等待确认。' },
      { assistantSeq: 13, status: 'failed', reasonCode: 'BACKEND_TIMEOUT', message: '第十三楼请求超时。' },
    ],
    pendingReviews: [{ floorId: 'floor-12', assistantSeq: 12, events: [{ id: 'review-12', title: '待确认事实', description: '待确认内容' }] }] };
  const h = harness({ initialSnapshot: snapshot });
  const results = h.container.querySelector('.qqj-qianshi-history-results');
  const coverage = flatten(h.container).find(node => node.className.startsWith('qqj-qianshi-coverage'));
  const review = flatten(coverage).find(node => node.className === 'qqj-qianshi-history-review');
  assert.ok(results);
  assert.equal(results.children.length, 2, '只将逐楼结果行放入滚动容器');
  assert.equal(coverage.contains(results), true);
  assert.equal(results.contains(review), false, '待确认卡留在滚动容器外');
  assert.equal(results.contains(flatten(coverage).find(node => node.className === 'qqj-qianshi-history-status')), false, '总进度留在滚动容器外');
  assert.equal(results.attributes.role, 'region', '结果区以具名 region 暴露给辅助技术');
  assert.equal(results.attributes['aria-label'], '历史补齐逐楼结果');
  assert.equal(results.attributes.tabindex, '0');
  assert.doesNotMatch(copy(results), /已成功保存替换/u, '总进度留在滚动容器外');
  assert.equal(coverage.children.find(node => node.tag === 'button').textContent, '停止', '停止按钮留在滚动容器外');

  const css = readFileSync(new URL('../src/ui/panel.css', import.meta.url), 'utf8');
  assert.match(css, /\.qqj-qianshi-history-results\{[^}]*max-height:50vh;[^}]*overflow-y:auto/u);
  assert.match(css, /\.qqj-qianshi-history-results\{[^}]*overflow-wrap:anywhere/u, '长文本在窄屏允许换行');
  assert.match(css, /@media\(max-width:340px\)/u);
  assert.match(css, /\.qqj-qianshi-history-results\{grid-column:1\/-1\}/u, '窄屏仍跨满 coverage 网格');

  results.scrollTop = 76; h.documentRef.activeElement = results;
  h.emit({ ...snapshot, history: { ...snapshot.history, message: '进度更新' } });
  const redrawnResults = h.container.querySelector('.qqj-qianshi-history-results');
  assert.notEqual(redrawnResults, results, 'runtime 通知重建结果区');
  assert.equal(redrawnResults.scrollTop, 76, '同一聊天保留结果区内部位置');
  assert.equal(redrawnResults.focused, true, '原结果区有焦点时恢复焦点');

  h.emit({ ...snapshot, identity: { qqjChatId: 'chat-b' } });
  const switchedResults = h.container.querySelector('.qqj-qianshi-history-results');
  assert.equal(switchedResults.scrollTop, 0, '切换聊天后从顶部显示');
  assert.equal(switchedResults.focused, undefined, '不把旧聊天的焦点带入新聊天');
});

test('历史逐楼反馈保留中文原因与楼号，不显示内部错误码或状态枚举', () => {
  const snapshot = fixture();
  snapshot.history = { status: 'partial', message: '', processedFloors: 0, totalFloors: 7, calls: 3,
    attemptedFloors: 7, savedCompleteFloors: 0, savedPartialFloors: 1, conflictFloors: 3, skippedFloors: 1, failedFloors: 2,
    outcomes: [
      { assistantSeq: 56, status: 'conflict-review', reasonCode: 'QIANSHI_HISTORY_REPLACEMENT_CONFLICT', message: '新千事结果漏掉仍被后楼引用事件，旧记录保留。' },
      { assistantSeq: 67, status: 'failed', reasonCode: 'BACKEND_TIMEOUT', message: '后端请求超时，请稍后重试。' },
      { assistantSeq: 82, status: 'conflict-review', reasonCode: 'QIANSHI_HISTORY_REPLACEMENT_CONFLICT', message: '新千事结果漏掉仍被后楼引用事件，旧记录保留。' },
      { assistantSeq: 104, status: 'failed', reasonCode: 'BACKEND_TIMEOUT', message: '后端请求超时，请稍后重试。' },
      { assistantSeq: 134, status: 'failed', reasonCode: 'QIANSHI_HISTORY_CONFLICT_PARTIAL_COMMIT_FAILED', message: '新千事结果漏掉仍被后楼引用事件，旧记录保留。部分结果状态未能保存：后端请求超时，请稍后重试。' },
      { assistantSeq: 140, status: 'failed', reasonCode: 'QIANSHI_HISTORY_RESPONSE_SHAPE', message: '批响应缺少楼层列表；本批原记录保持不变。' },
      { assistantSeq: 141, status: 'failed', reasonCode: 'QIANSHI_HISTORY_FLOOR_MISSING', message: '批响应漏回本楼，已保留原记录。' },
      { assistantSeq: 142, status: 'failed', reasonCode: 'QIANSHI_HISTORY_FLOOR_DUPLICATE', message: '批响应重复返回本楼，已保留原记录。' },
      { assistantSeq: 143, status: 'failed', reasonCode: 'QIANSHI_HISTORY_CANDIDATE_STALE', message: '本批实际引用的前楼事项语义已变化，本楼原记录保留。' },
      { assistantSeq: 144, status: 'failed', reasonCode: 'QIANSHI_HISTORY_INPUT_BUDGET', message: '完整请求估算 71000 token，超过 70000；未调用模型。' },
    ], pendingReviews: [] };
  const h = harness({ initialSnapshot: snapshot });
  const rendered = copy(h.container);
  assert.match(rendered, /历史补齐部分完成/u, '空状态消息使用中文状态说明');
  for (const seq of [56, 67, 82, 104, 134, 140, 141, 142, 143, 144]) assert.match(rendered, new RegExp(`第 ${seq} 楼：`));
  assert.match(rendered, /第 134 楼：.*部分结果状态未能保存：后端请求超时/u);
  assert.match(rendered, /第 144 楼：完整请求估算 71000 token，超过 70000；未调用模型/u);
  assert.doesNotMatch(rendered, /QIANSHI_|qianshi_|BACKEND_TIMEOUT|events\[|\bprogress\b|\bcontext\b|\bpartial\b|\bfloors\b|\btokens\b/u);
});

test('恢复的历史结果缺少楼号时说明目标楼已变化，不伪造楼号', () => {
  const snapshot = fixture();
  snapshot.history = { status: 'partial', message: '', processedFloors: 0, totalFloors: 1, calls: 0,
    attemptedFloors: 1, savedCompleteFloors: 0, savedPartialFloors: 0, conflictFloors: 0, skippedFloors: 0, failedFloors: 1,
    outcomes: [{ floorId: 'deleted-floor', status: 'failed', reasonCode: 'QIANSHI_HISTORY_FLOOR_MISSING',
      message: '目标楼已变化，原记录保留。' }], pendingReviews: [] };
  const h = harness({ initialSnapshot: snapshot });
  const resultText = copy(h.container.querySelector('.qqj-qianshi-history-results'));
  assert.match(resultText, /目标楼已不存在或楼层已变化：目标楼已变化，原记录保留。/u);
  assert.doesNotMatch(resultText, /第 undefined 楼|第 NaN 楼/u);
});

test('千事快照 memo 在历史通知时复用全图，reachable 或身份投影变化才失效', () => {
  let builds = 0; const memo = createQianshiSnapshotMemo((reachable, _history, identity) => ({ status: 'ready', marker: `${reachable.id}:${identity.id}:${++builds}` }));
  const reachableA = { id: 'a' }, reachableB = { id: 'b' }, identityA = { id: 'ia' }, identityB = { id: 'ib' };
  const first = memo(reachableA, identityA, { status: 'idle' });
  const historyOnly = memo(reachableA, identityA, { status: 'running' });
  assert.equal(first.marker, historyOnly.marker); assert.equal(historyOnly.history.status, 'running'); assert.equal(builds, 1);
  memo(reachableB, identityA, { status: 'idle' }); memo(reachableB, identityB, { status: 'idle' }); assert.equal(builds, 3);
});
