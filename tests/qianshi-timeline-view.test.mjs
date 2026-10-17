import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createQianshiTimelineView } from '../src/ui/qianshi-timeline-view.js';
import { createQianshiSnapshotMemo, createQianshiEventLookup } from '../src/v3/memory-runtime.js';
import { compileQianshiDelta, projectQianshiGraph, projectQianshiTimeline, publicQianshiSnapshot } from '../src/v3/qianshi-domain.js';

let activeCustomDialog = null;
class Node {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.className = ''; this.textContent = ''; this.hidden = false; this.open = false; this.disabled = false; this.value = ''; this.scrollTop = 0; }
  append(...nodes) { for (const node of nodes) if (node && typeof node === 'object') { if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node); node.parent = this; } this.children.push(...nodes); }
  replaceChildren(...nodes) { for (const node of nodes) if (node && typeof node === 'object') node.parent = this; this.children = [...nodes]; }
  after(...nodes) { if (!this.parent) return; const index = this.parent.children.indexOf(this); this.parent.children.splice(index + 1, 0, ...nodes); for (const node of nodes) if (node && typeof node === 'object') node.parent = this.parent; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  fire(name, event = {}) { return this.listeners[name]?.(event); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  focus(options) { this.focused = true; this.focusOptions = options; }
  setSelectionRange() {}
  querySelector(selector) { return flatten(this).find(node => selector.startsWith('#') ? node.id === selector.slice(1) : selector.startsWith('.') ? node.className.split(/\s+/u).includes(selector.slice(1)) : false) ?? null; }
  contains(node) { return flatten(this).includes(node); }
}
const flatten = node => [node, ...(node.children ?? []).flatMap(flatten)];
const visibleEventMenus = node => flatten(node).filter(item => item.className.includes('qqj-qianshi-event-menu')
  && !Array.from((function* () { for (let parent = item.parent; parent; parent = parent.parent) yield parent; })()).some(parent => parent.hidden || (parent.tag === 'details' && !parent.open)));
const copy = node => flatten(node).map(value => value.textContent).filter(Boolean).join('|');
const byText = (node, value) => flatten(node).find(item => item.textContent === value);
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const events = Array.from({ length: 7 }, (_, index) => ({
    id: `event-${index + 1}`, matterId: 'matter-1', updatesMatter: index !== 1, title: index === 0 ? '取得旧信' : `旧信进展 ${index + 1}`,
    description: index === 0 ? '这是完整说明正文，不是另造的第二份详情。' : `完整经过 ${index + 1}`,
    status: index === 6 ? 'completed' : index ? 'inProgress' : 'planned', storyTime: `2026-07-${String(index + 1).padStart(2, '0')} 10:00`,
    scheduledTime: index === 0 ? '2026-07-09' : null, people: [{ entityId: 'person', name: index === 0 ? '沈棠' : '闻舟' }], object: '旧信', sourceFloorMemoryId: `memory-${index + 1}`, sourceMessageIndex: 12 + index,
  }));
  events.push({ id: 'undated', matterId: null, updatesMatter: false, title: '无日期回忆', description: '后来提及但没有可靠日期。', status: 'occurred', storyTime: null, scheduledTime: null, people: [{ entityId: 'other', name: '旧友' }], object: null, sourceMessageIndex: 30 });
  return { status: 'ready', identity: { qqjChatId: 'chat-a' }, coverage: { eligibleFloors: 9, completeFloors: 7, pendingFloors: 2, partialFloors: 0, degradedFloors: 0, unavailableFloors: 0 },
    events, matters: [{ matterId: 'matter-1', following: true, recordIds: events.slice(0, 7).map(event => event.id), eventIds: events.slice(0, 7).map(event => event.id) }], relations: [],
    timeline: { hasGlobalLatest: true, globalLatestGroupId: 'day-7', segments: [{ id: 'gregorian', label: '公历', latestGroupId: 'day-7', groups: events.slice(0, 7).map((event, index) => ({ id: `day-${index + 1}`, day: `${index + 1}日`, period: '2026年7月', full: event.storyTime, eventIds: [event.id] })) }], undatedEventIds: ['undated'] },
    history: { status: 'idle', processedFloors: 0, totalFloors: 0, calls: 0, message: '' } };
}

function harness({ confirm = false, choose = null, custom = null, initialSnapshot = fixture(), plan = null, startResult = { status: 'completed', message: '' }, rejudgeStartResult = { status: 'running' }, canEdit = true, editText = null, editPeople = [], manualActions = false, promptValues = ['12~18'] } = {}) {
  let snapshot = structuredClone(initialSnapshot), state = { status: 'ready', memoryWorkBusy: false, qianshiHistoryActive: false }, prepareCalls = 0, prepareOptions = null, startCalls = 0, rejudgePrepareCalls = 0, rejudgeStartCalls = 0, rejudgeRange = null, promptIndex = 0;
  let snapshotReads = 0, editPeopleReads = 0;
  const listeners = new Set(), confirms = [];
  const runtime = { getState: () => state, getQianshiSnapshot: () => { snapshotReads += 1; return structuredClone(snapshot); },
    getQianshiSnapshotVersion: () => ({ status: snapshot.status, projectionRevision: snapshot.projectionRevision ?? null, history: snapshot.history }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    canEditQianshiEventText(id) { return typeof canEdit === 'function' ? canEdit(id) : canEdit; },
    getQianshiEditPeople() { editPeopleReads += 1; return structuredClone(editPeople); },
    _setEventText(id, title, description, object) { const event = snapshot.events.find(item => item.id === id); event.title = title; event.description = description; if (object !== undefined) event.object = object; if (Number.isSafeInteger(snapshot.projectionRevision)) snapshot.projectionRevision += 1; for (const listener of listeners) listener(state); },
    async editQianshiEventText(input) { if (editText) return editText(input); runtime._setEventText(input.eventId, input.title, input.description, input.object); return { status: 'saved' }; },
    ...(manualActions ? {
      async setQianshiMatterFollowing(input) { snapshot.matters.find(item => item.matterId === input.matterId).following = input.following; if (Number.isSafeInteger(snapshot.projectionRevision)) snapshot.projectionRevision += 1; for (const listener of listeners) listener(state); return { status: 'saved' }; },
      async setQianshiMatterStatus(input) { const matter = snapshot.matters.find(item => item.matterId === input.matterId); matter.manualStatusOverride = input.status; if (input.status !== null) matter.status = input.status; if (Number.isSafeInteger(snapshot.projectionRevision)) snapshot.projectionRevision += 1; for (const listener of listeners) listener(state); return { status: 'saved' }; },
    } : {}),
    async prepareQianshiHistory(options) { prepareCalls += 1; prepareOptions = options; return { status: 'ready', planId: 'plan', totalFloors: 2, batchCount: 1, apiCalls: 1, modelFloors: 2, estimatedInputTokens: 900, unavailableFloors: [], ...(plan ?? {}) }; },
    async startQianshiHistory() { startCalls += 1; if (typeof startResult === 'function') return startResult({ setHistory(history) { snapshot.history = history; for (const listener of listeners) listener(state); } }); snapshot.history = { ...snapshot.history, ...startResult }; for (const listener of listeners) listener(state); return startResult; },
    async stopQianshiHistory() { return { status: 'stopped' }; },
    async prepareQianshiRejudge(range) { rejudgePrepareCalls += 1; rejudgeRange = range; return { status: 'ready', planId: 'rejudge-plan', totalFloors: 2, apiCalls: 2,
      floors: [{ assistantSeq: 3, messageIndex: 12, recordCount: 2 }, { assistantSeq: 4, messageIndex: 18, recordCount: 1 }], ...(plan ?? {}) }; },
    async startQianshiRejudge() { rejudgeStartCalls += 1; snapshot.history = { ...snapshot.history, mode: 'rejudge', ...rejudgeStartResult }; for (const listener of listeners) listener(state); return rejudgeStartResult; } };
  const documentRef = { listeners: {}, createElement: tag => new Node(tag), defaultView: { matchMedia: () => ({ matches: false }) },
    addEventListener(name, listener) { this.listeners[name] = listener; }, removeEventListener(name) { delete this.listeners[name]; },
    fire(name, event) { return this.listeners[name]?.(event); } };
  const dialogCustom = options => {
    if (typeof custom === 'function') { const result = custom(options); if (result !== undefined) return result; }
    activeCustomDialog?.cancel();
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    let done = false;
    const finish = value => { if (done) return; done = true; if (activeCustomDialog?.options === options) activeCustomDialog = null; options.onClose?.(); resolve(value); };
    activeCustomDialog = { options, cancel: () => finish(null), submit: async () => { try { const result = await options.submit(); finish(result); return result; } catch { return false; } } };
    return promise;
  };
  const view = createQianshiTimelineView({ runtime, documentRef, dialog: { async confirm(options) { confirms.push(options); return typeof confirm === 'function' ? confirm(options) : confirm; },
    async choose(options) { confirms.push(options); return typeof choose === 'function' ? choose(options) : choose; },
    async custom(options) { confirms.push(options); return dialogCustom(options); },
    async prompt(options) { confirms.push(options); return promptValues[promptIndex++] ?? null; } } });
  const container = new Node('main'); let pageReplacements = 0;
  const replacePage = container.replaceChildren.bind(container);
  container.replaceChildren = (...nodes) => { pageReplacements += 1; return replacePage(...nodes); };
  view.mount(container);
  return { view, container, runtime, documentRef, confirms, snapshotReads: () => snapshotReads, editPeopleReads: () => editPeopleReads, calls: () => ({ prepareCalls, startCalls }), prepareOptions: () => prepareOptions,
    editor: () => activeCustomDialog?.options.content ?? null,
    pageReplacements: () => pageReplacements,
    dialogContent: () => activeCustomDialog?.options.content ?? null,
    saveEditor: () => activeCustomDialog?.submit() ?? Promise.resolve(null),
    cancelEditor: () => activeCustomDialog?.cancel() ?? false,
    rejudgeCalls: () => ({ prepareCalls: rejudgePrepareCalls, startCalls: rejudgeStartCalls, range: rejudgeRange }),
    eventCard(id) {
      let card = flatten(container).find(node => node.className === 'qqj-qianshi-event' && node.dataset.eventId === id);
      if (card) return card;
      const group = snapshot.timeline?.segments?.flatMap(segment => segment.groups ?? []).find(item => item.eventIds.includes(id));
      if (group) {
        const day = flatten(container).find(node => node.id === group.id && node.className.includes('qqj-qianshi-day'));
        const disclosure = flatten(day).find(node => node.className === 'qqj-qianshi-day-disclosure');
        if (!disclosure.open) flatten(day).find(node => node.className === 'qqj-qianshi-day-summary').fire('click', { isTrusted: true });
        disclosure.open = true; disclosure.fire('toggle');
        card = flatten(container).find(node => node.className === 'qqj-qianshi-event' && node.dataset.eventId === id);
      }
      return card;
    },
    eventMenu(id) {
      const card = this.eventCard(id);
      return card && flatten(card.parent).find(node => node.className.includes('qqj-qianshi-event-menu') && node.dataset.qianshiEventId === id);
    },
    emit(nextSnapshot = snapshot, nextState = state) { snapshot = nextSnapshot; state = nextState; for (const listener of listeners) listener(state); } };
}

test('千事同版本通知不重读；history-only 更新只保留并更新进度区', () => {
  const next = { ...fixture(), projectionRevision: 1 };
  next.history = { status: 'running', processedFloors: 1, totalFloors: 2, calls: 1, message: '' };
  const h = harness({ initialSnapshot: { ...fixture(), projectionRevision: 1 } });
  const card = h.eventCard('event-1');
  const search = h.container.querySelector('.qqj-history-search-input'); search.focus(); h.documentRef.activeElement = search;
  const initialReads = h.snapshotReads();
  const initialRenders = h.pageReplacements();
  h.emit();
  assert.equal(h.snapshotReads(), initialReads, '同版本通知只检查轻量头');
  assert.equal(h.pageReplacements(), initialRenders, '同版本通知不重绘');
  h.emit(next);
  assert.equal(h.snapshotReads(), initialReads, 'history-only 更新复用完整快照');
  assert.equal(h.pageReplacements(), initialRenders, 'history-only 更新不销毁页面列表');
  assert.equal(h.eventCard('event-1'), card, '事件节点沿用原DOM');
  assert.equal(h.container.querySelector('.qqj-history-search-input'), search, '搜索输入节点沿用');
  assert.equal(search.focused, true, '搜索焦点沿用');
  assert.equal(byText(h.container, '停止')?.tag, 'button', '历史任务显示停止入口');
  assert.match(copy(h.container), /已处理 1\/2 楼/u, '进度文字仍及时更新');
});

test('仅忙态变化原位更新禁用按钮，投影版本变化仍完整刷新', () => {
  const initial = { ...fixture(), projectionRevision: 1 };
  const busySnapshot = structuredClone(initial);
  const changed = structuredClone(initial);
  changed.projectionRevision = 2;
  changed.events[0].title = '新的人工标题';
  const h = harness({ initialSnapshot: initial });
  h.runtime.deleteQianshiEvent = async () => ({ status: 'saved' });
  h.runtime.setQianshiMatterStatus = async () => ({ status: 'saved' });
  const card = h.eventCard('event-1');
  const menu = h.eventMenu('event-1');
  const remove = byText(menu, '删除'), change = byText(menu, '修改状态');
  assert.equal(remove.disabled, false); assert.equal(change.disabled, false, '忙态前两项正常可用');
  const initialReads = h.snapshotReads(), initialRenders = h.pageReplacements();
  h.emit(busySnapshot, { status: 'ready', memoryWorkBusy: true, qianshiHistoryActive: false });
  assert.equal(h.snapshotReads(), initialReads, 'busy-only 更新不读取完整快照');
  assert.equal(h.pageReplacements(), initialRenders, 'busy-only 更新不重建页面');
  assert.equal(h.eventCard('event-1'), card, '事件列表节点保持不变');
  assert.equal(remove.disabled, true); assert.match(remove.title, /后台记忆任务/u);
  assert.equal(change.disabled, true);

  h.emit(busySnapshot, { status: 'ready', memoryWorkBusy: false, qianshiHistoryActive: false });
  assert.equal(h.snapshotReads(), initialReads, '忙态解除仍只更新现有按钮');
  assert.equal(h.pageReplacements(), initialRenders, '忙态解除仍不重建页面');
  assert.equal(h.eventCard('event-1'), card);
  assert.equal(remove.disabled, false); assert.equal(remove.title, '', '任务结束后清除禁用说明');
  assert.equal(change.disabled, false);

  h.emit(changed, { status: 'ready', memoryWorkBusy: false, qianshiHistoryActive: false });
  assert.equal(h.snapshotReads(), initialReads + 1, '内容版本变化照常读取完整快照');
  assert.equal(h.pageReplacements(), initialRenders + 1, '内容版本变化照常重绘列表');
  assert.notEqual(h.eventCard('event-1'), card);
  assert.match(copy(h.container), /新的人工标题/u);

  const fallback = structuredClone(changed); fallback.projectionRevision = 3; fallback.events[0].title = '无版本头时的新内容';
  const fallbackReads = h.snapshotReads(), fallbackRenders = h.pageReplacements();
  h.runtime.getQianshiSnapshotVersion = undefined;
  h.emit(fallback, { status: 'ready', memoryWorkBusy: false, qianshiHistoryActive: false });
  assert.equal(h.snapshotReads(), fallbackReads + 1, '没有轻量版本头时沿用原完整读取路径');
  assert.equal(h.pageReplacements(), fallbackRenders + 1);
  assert.match(copy(h.container), /无版本头时的新内容/u);
});

test('折叠事件右侧菜单可打开编辑，取消和无变化都不写入', async () => {
  let writes = 0, submitted = null;
  const h = harness({ editText: async input => { writes += 1; submitted = input; return { status: 'saved' }; } });
  const first = h.eventCard('event-1');
  assert.equal(first.open, false);
  let menu = flatten(first.parent).find(node => node.className.includes('qqj-qianshi-event-menu'));
  assert.ok(menu, '折叠行上仍有事件菜单');
  assert.equal(menu.parent.className, 'qqj-qianshi-event-row');
  assert.equal(first.parent, menu.parent, '事件 details 和菜单是可见 wrapper 的兄弟');
  assert.equal(first.contains(menu), false, '关闭 details 不会隐藏菜单');
  const summary = flatten(first).find(node => node.tag === 'summary');
  assert.equal(summary.contains(menu), false, '菜单不在事件展开 summary 子树中');
  byText(menu, '⋮').fire('click');
  assert.equal(first.open, false, '点击三点按钮不会触发事件展开');
  menu.open = true;
  let edit = byText(menu, '编辑详情');
  assert.ok(edit); edit.fire('click');
  assert.ok(activeCustomDialog, '点击编辑应打开独立弹窗');
  let card = h.eventCard('event-1');
  assert.equal(card.open, false, '编辑以独立弹窗打开，不改变列表卡片');
  let form = flatten(h.editor()).find(node => node.className.split(/\s+/u).includes('qqj-qianshi-text-form'));
  assert.equal(form.querySelector('.qqj-qianshi-title-input').value, '取得旧信');
  h.cancelEditor();
  assert.equal(writes, 0);
  card = h.eventCard('event-1');
  menu = flatten(card.parent).find(node => node.className.includes('qqj-qianshi-event-menu'));
  byText(menu, '编辑详情').fire('click');
  card = h.eventCard('event-1');
  form = flatten(h.editor()).find(node => node.className.split(/\s+/u).includes('qqj-qianshi-text-form'));
  assert.equal(form.querySelector('.qqj-qianshi-title-input').value, '取得旧信');
  assert.equal(form.querySelector('.qqj-qianshi-description-input').value, '这是完整说明正文，不是另造的第二份详情。');
  assert.equal(form.querySelector('.qqj-qianshi-object-input').value, '旧信');
  assert.equal(flatten(form).find(node => node.tag === 'label' && node.children[0]?.textContent === '涉及物品')?.children[1]?.className, 'settings-input qqj-qianshi-object-input');
  assert.equal(form.querySelector('.qqj-qianshi-object-hint').textContent, '只填对后续有用的具体物品；多个用顿号分隔；没有可留空。');
  await h.saveEditor();
  assert.equal(writes, 0, `不变更字段不创建 revision: ${JSON.stringify(submitted)}`);
  assert.equal(h.editor(), null, '无变化关闭编辑窗，不创建新版本');
  assert.match(copy(h.container), /内容没有变化，没有写入新版本/u);
});

test('事件菜单仅有编辑、删除和状态入口，插件弹窗四种状态及恢复自动判断明确保存', async () => {
  let next = 'completed';
  const snapshot = fixture(); snapshot.matters[0].status = 'inProgress';
  const h = harness({ initialSnapshot: snapshot, manualActions: true, custom: async options => {
    assert.equal(options.title, '修改状态');
    assert.deepEqual(flatten(options.content).filter(node => node.tag === 'input').map(node => node.value),
      ['planned', 'inProgress', 'completed', 'occurred', 'automatic']);
    assert.match(copy(options.content), /已经安排，尚未开始.*已经开始，后面还有进展.*一次性的事情已经发生/u);
    assert.equal(flatten(options.content).some(node => node.tag === 'select'), false);
    const radio = flatten(options.content).find(node => node.tag === 'input' && node.value === next);
    radio.checked = true; radio.fire('change');
    assert.notEqual(h.runtime.getQianshiSnapshot().matters[0].manualStatusOverride, next, '选中还没有保存');
    return options.submit();
  } });
  let menu = h.eventMenu('event-1');
  const actions = flatten(menu).filter(node => node.className.includes('qqj-profile-menu-action'));
  assert.deepEqual(actions.map(node => node.textContent), ['编辑详情', '删除', '修改状态']);
  assert.equal(byText(menu, '删除').disabled, true);
  assert.doesNotMatch(copy(menu), /停止主动关注|继续关注|恢复自动判断|保存整线状态/u);
  byText(menu, '修改状态').fire('click'); await tick(); await tick();
  assert.equal(h.runtime.getQianshiSnapshot().matters[0].manualStatusOverride, 'completed');
  const card = h.eventCard('event-7');
  const badge = () => flatten(card.children[0]).find(node => node.className.includes('qqj-qianshi-state'));
  assert.equal(badge().textContent, '已完成'); assert.equal(badge().title, '整件事状态：已完成');
  const historicalCard = h.eventCard('event-3');
  assert.equal(flatten(historicalCard.children[0]).find(node => node.className.includes('qqj-qianshi-state')).textContent, '已完成');
  historicalCard.open = true; historicalCard.fire('toggle');
  const history = flatten(historicalCard).find(node => node.className === 'qqj-qianshi-matter');
  history.open = true; history.fire('toggle');
  assert.ok(flatten(history).some(node => node.title === '本条动作状态：进行中'), '历史动作不被整线完成改写');
  assert.equal(h.runtime.getQianshiSnapshot().events[2].status, 'inProgress');
  assert.doesNotMatch(copy(h.container), /正在保存|保存失败/u);
  next = 'automatic';
  menu = h.eventMenu('event-1');
  byText(menu, '修改状态').fire('click'); await tick(); await tick();
  assert.equal(h.runtime.getQianshiSnapshot().matters[0].manualStatusOverride, null);
  assert.doesNotMatch(copy(h.container), /正在保存|保存失败/u);
});

test('状态弹窗取消不保存', async () => {
  const cancelled = harness({ manualActions: true });
  const menu = cancelled.eventMenu('event-1');
  byText(menu, '修改状态').fire('click'); await tick();
  assert.equal(cancelled.runtime.getQianshiSnapshot().matters[0].manualStatusOverride, undefined);
});

test('状态保存先关弹窗，原事件显示小字，浏览不中止保存，失败保留原状态', async () => {
  for (const mode of ['success', 'failure', 'browse']) {
    const snapshot = fixture(); snapshot.matters[0].status = 'inProgress';
    let resolveSave, rejectSave, closed = false, writes = 0;
    const done = new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject; });
    const h = harness({ initialSnapshot: snapshot, manualActions: true, custom: async options => {
      const radio = flatten(options.content).find(node => node.value === 'completed'); radio.fire('change');
      const choice = await options.submit(); closed = true; return choice;
    } });
    h.runtime.setQianshiMatterStatus = async () => {
      assert.equal(closed, true, '关窗之后才启动落盘'); writes += 1; await done;
      const saved = h.runtime.getQianshiSnapshot(); saved.matters[0].status = 'completed'; h.emit(saved);
      return { status: 'saved' };
    };
    byText(h.eventMenu('event-7'), '修改状态').fire('click'); await tick();
    assert.equal(writes, 1); assert.match(copy(h.container), /正在保存…/u);
    assert.equal(h.runtime.getQianshiSnapshot().matters[0].status, 'inProgress', '落盘期间不提前显示成功');
    assert.equal(byText(h.eventMenu('event-7'), '修改状态').disabled, true);
    if (mode === 'browse') h.view.deactivate();
    if (mode === 'success') resolveSave(); else rejectSave(new Error('保存服务暂时不可用'));
    await tick(); await tick();
    if (mode === 'browse') await h.view.activate();
    assert.doesNotMatch(copy(h.container), /正在保存/u);
    if (mode === 'success') {
      assert.equal(h.runtime.getQianshiSnapshot().matters[0].status, 'completed');
      assert.doesNotMatch(copy(h.container), /保存失败/u);
    } else {
      assert.match(copy(h.container), /保存失败.*保存服务暂时不可用/u);
      assert.equal(h.runtime.getQianshiSnapshot().matters[0].status, 'inProgress');
    }
    assert.equal(writes, 1, '失败不自动重试');
  }
});

test('独立记录状态弹窗只修改本条，旧未知状态不能被人工选入', async () => {
  const snapshot = fixture(); snapshot.events[0].matterId = null; snapshot.events[0].status = 'unknown';
  let submitted;
  const h = harness({ initialSnapshot: snapshot, editText: async input => { submitted = input; return { status: 'saved' }; },
    custom: async options => {
      const inputs = flatten(options.content).filter(node => node.tag === 'input');
      assert.deepEqual(inputs.map(node => node.value), ['planned', 'inProgress', 'completed', 'occurred']);
      assert.equal(inputs.some(node => node.checked), false, '旧未知状态不会默认转为待办');
      await assert.rejects(options.submit, /请选择状态/u);
      const radio = inputs.find(node => node.value === 'occurred'); radio.checked = true; radio.fire('change');
      return options.submit();
    } });
  byText(h.eventMenu('event-1'), '修改状态').fire('click'); await tick(); await tick();
  assert.equal(submitted.status, 'occurred'); assert.equal(submitted.actionStatus, 'occurred');
  assert.equal(h.runtime.getQianshiSnapshot().matters[0].manualStatusOverride, undefined);
});

test('事件编辑可改或清空涉及物品，其他字段不变时仍按物品差异保存', async () => {
  const submitted = [];
  const h = harness({ editText: async input => { submitted.push(input); return { status: 'saved' }; } });
  let event = h.eventCard('event-1');
  byText(flatten(event.parent).find(node => node.className.includes('qqj-qianshi-event-menu')), '编辑详情').fire('click');
  let form = flatten(h.editor()).find(node => node.className.split(/\s+/u).includes('qqj-qianshi-text-form'));
  const object = form.querySelector('.qqj-qianshi-object-input'); object.value = '蓝皮手稿'; object.fire('input', { target: object });
  await h.saveEditor();
  assert.equal(submitted.length, 1, '仅物品变化也会保存');
  assert.equal(submitted[0].object, '蓝皮手稿');
  assert.equal(submitted[0].title, '取得旧信');
  assert.equal(submitted[0].description, '这是完整说明正文,不是另造的第二份详情。');

  const blank = harness({ editText: async input => { submitted.push(input); return { status: 'saved' }; } });
  event = blank.eventCard('event-1');
  byText(flatten(event.parent).find(node => node.className.includes('qqj-qianshi-event-menu')), '编辑详情').fire('click');
  form = flatten(blank.editor()).find(node => node.className.split(/\s+/u).includes('qqj-qianshi-text-form'));
  const clear = form.querySelector('.qqj-qianshi-object-input'); clear.value = '   '; clear.fire('input', { target: clear });
  await h.saveEditor();
  assert.equal(submitted[1].object, null, '空值按既有合同落为 null');
});

test('千事编辑弹窗四组使用原生独立折叠，折叠组草稿仍进入保存', async () => {
  let saved;
  const snapshot = fixture(); snapshot.events[0].people = [{ entityId: 'person', name: '沈棠' }];
  const h = harness({ initialSnapshot: snapshot, editPeople: [{ entityId: 'person', name: '沈棠' }, { entityId: 'npc', name: '阿澈' }],
    editText: async input => { saved = input; return { status: 'saved' }; } });
  const event = h.eventCard('event-1');
  byText(flatten(event.parent).find(node => node.className.includes('qqj-qianshi-event-menu')), '编辑详情').fire('click');
  const form = h.editor();
  const groups = flatten(form).filter(node => node.tag === 'details' && node.className === 'qqj-editor-group');
  assert.equal(groups.length, 4, '事件内容、时间、人物、状态各自使用原生可折叠组');
  assert.deepEqual(groups.map(group => group.children.find(node => node.tag === 'summary')?.textContent), ['事件内容', '时间', '人物（可多选）', '状态']);
  assert.deepEqual(groups.map(group => group.open), [true, false, false, false], '默认只展开主要事件内容');

  const title = form.querySelector('.qqj-qianshi-title-input'); title.value = '折叠状态下保留草稿'; title.fire('input', { target: title });
  groups[0].open = false;
  groups[2].open = true;
  const npcRow = flatten(form).find(node => node.className.includes('qqj-qianshi-person-choice') && copy(node).includes('阿澈'));
  const npc = flatten(npcRow).find(node => node.type === 'checkbox'); npc.checked = true; npc.fire('change', { target: npc });
  const search = flatten(form).find(node => node.attributes['aria-label'] === '搜索姓名或别名');
  search.value = '沈棠'; search.fire('input', { target: search });
  groups[2].open = false;
  assert.equal(title.value, '折叠状态下保留草稿', '收起事件内容后保留已编辑输入');
  assert.equal(search.value, '沈棠', '收起人物组后保留查询');
  assert.equal(npc.checked, true, '收起人物组后保留勾选');
  await h.saveEditor();
  assert.equal(saved.title, '折叠状态下保留草稿');
  assert.deepEqual(saved.people, [{ entityId: 'person', name: '沈棠' }, { entityId: 'npc', name: '阿澈' }], '人物查询和勾选状态随编辑草稿保存');
});

test('时间五格草稿保留，取消零写，保存带时间及原值校验', async () => {
  const submitted = [];
  const h = harness({ editText: async input => { submitted.push(input); return { status: 'saved' }; } });
  const open = () => {
    const event = h.eventCard('event-1');
    byText(flatten(event.parent).find(node => node.className.includes('qqj-qianshi-event-menu')), '编辑详情').fire('click');
    return h.editor();
  };
  let form = open();
  let controls = flatten(flatten(form).filter(node => node.tag === 'fieldset')[0]).filter(node => node.className.includes('qqj-qianshi-time-input'));
  assert.deepEqual(controls.map(node => node.value), ['', '2026', '7', '1', '10:00']);
  assert.equal(h.container.querySelector('.qqj-qianshi-description'), null);
  controls[0].value = '大陆历'; controls[0].fire('input');
  controls[2].value = '夏月'; controls[2].fire('input');
  assert.match(copy(form), /保存后：大陆历2026年夏月1日 10:00/u);
  assert.ok(h.editor());
  h.emit(); form = h.editor();
  assert.equal(flatten(form).find(node => node.attributes['aria-label'] === '发生时间前缀').value, '大陆历');
  h.cancelEditor();
  assert.equal(submitted.length, 0);
  assert.equal(h.runtime.getQianshiSnapshot().events[0].storyTime, '2026-07-01 10:00');
  form = open(); controls = flatten(flatten(form).filter(node => node.tag === 'fieldset')[0]).filter(node => node.className.includes('qqj-qianshi-time-input'));
  controls[2].value = '贰月'; controls[2].fire('input');
  await h.saveEditor();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].storyTime, '2026年2月1日 10:00');
  assert.equal(submitted[0].expected.storyTime, '2026-07-01 10:00');
});

test('千事事件可点选已识别人物并独立编辑约定时间，未触碰时保留相对值', async () => {
  const submitted = [], people = [{ entityId: 'person', name: '沈棠' }, { entityId: 'npc', name: '阿澈' }];
  const snapshot = fixture(); snapshot.events[0].scheduledTime = '周末';
  const h = harness({ initialSnapshot: snapshot, editPeople: people, editText: async input => { submitted.push(input); return { status: 'saved' }; } });
  const event = h.eventCard('event-1');
  byText(flatten(event.parent).find(node => node.className.includes('qqj-qianshi-event-menu')), '编辑详情').fire('click');
  let form = h.editor();
  const groups = flatten(form).filter(node => node.tag === 'fieldset' && node.className.includes('qqj-qianshi-time-editor'));
  assert.equal(groups.length, 2, '发生时间与约定时间使用独立的五格编辑组');
  assert.equal(copy(groups[1]).includes('约定 / 预计时间：周末'), true, '相对约定原文只预填展示，不被强行解析');
  const choices = flatten(form).filter(node => node.className.includes('qqj-qianshi-person-choice'));
  assert.equal(choices.length, 2, '候选包含目录中的普通人物，不限重要人物');
  const added = flatten(choices.find(node => copy(node).includes('阿澈'))).find(node => node.tag === 'input');
  assert.equal(flatten(choices.find(node => copy(node).includes('沈棠'))).find(node => node.tag === 'input').checked, true);
  added.checked = true; added.fire('change', { target: added });
  const scheduledClear = flatten(groups[1]).find(node => node.className.includes('qqj-qianshi-time-clear'));
  scheduledClear.fire('click');
  form = h.editor();
  for (const [label, value] of [['约定 / 预计时间年', '2027'], ['约定 / 预计时间月', '3'], ['约定 / 预计时间日', '5']]) {
    const input = flatten(form).find(node => node.attributes['aria-label'] === label); input.value = value; input.fire('input');
  }
  await h.saveEditor();
  assert.equal(submitted.length, 1);
  assert.equal(Object.hasOwn(submitted[0], 'storyTime'), false, '只改约定时间不提交发生时间');
  assert.equal(submitted[0].scheduledTime, '2027年3月5日', '约定时间可以按五格填写');
  assert.deepEqual(submitted[0].people, [{ entityId: 'person', name: '沈棠' }, { entityId: 'npc', name: '阿澈' }]);
  assert.deepEqual(submitted[0].expected.people, snapshot.events[0].people);
  assert.equal(submitted[0].expected.scheduledTime, '周末');

  const clearAgain = harness({ initialSnapshot: snapshot, editText: async input => { submitted.push(input); return { status: 'saved' }; } });
  const clearEvent = clearAgain.eventCard('event-1');
  byText(flatten(clearEvent.parent).find(node => node.className.includes('qqj-qianshi-event-menu')), '编辑详情').fire('click');
  let clearForm = clearAgain.editor();
  byText(flatten(clearForm).filter(node => node.className.includes('qqj-qianshi-time-editor'))[1], '清空').fire('click');
  clearForm = clearAgain.editor();
  let clearClock = flatten(clearForm).find(node => node.attributes['aria-label'] === '约定 / 预计时间时间');
  clearClock.value = '08:30'; clearClock.fire('input');
  clearClock = flatten(clearAgain.editor()).find(node => node.attributes['aria-label'] === '约定 / 预计时间时间');
  clearClock.value = ''; clearClock.fire('input');
  await clearAgain.saveEditor();
  assert.equal(submitted[1].scheduledTime, null, '清空后曾填入又擦除，仍保持明确未知而不恢复原相对值');
});

test('千事人物搜索匹配姓名与别名，隐藏已选项仍参与保存且Enter不提交', async () => {
  const submitted = [], snapshot = fixture();
  snapshot.events[0].people = [{ entityId: 'person', name: '沈棠' }];
  const people = [
    { entityId: 'person', name: '沈棠', aliases: ['Shen Tang', '棠棠'] },
    { entityId: 'npc', name: '阿澈', aliases: ['A-Che'] },
    { entityId: 'other', name: '闻舟', aliases: ['Wen Zhou'] },
  ];
  const h = harness({ initialSnapshot: snapshot, editPeople: people, editText: async input => { submitted.push(input); return { status: 'saved' }; } });
  const open = () => {
    const event = h.eventCard('event-1');
    byText(flatten(event.parent).find(node => node.className.includes('qqj-qianshi-event-menu')), '编辑详情').fire('click');
    return h.editor();
  };
  let form = open();
  assert.equal(h.editPeopleReads(), 1);
  let search = flatten(form).find(node => node.attributes['aria-label'] === '搜索姓名或别名');
  assert.ok(search, '人物候选上方提供可访问的搜索框');
  const firstSnapshotReads = h.snapshotReads(), firstCandidateReads = h.editPeopleReads();
  search.value = '沈棠'; search.fire('input', { target: search });
  assert.equal(h.snapshotReads(), firstSnapshotReads, '查询不重新读取快照');
  assert.equal(h.editPeopleReads(), firstCandidateReads, '查询只筛选已加载候选');
  h.cancelEditor();
  assert.equal(submitted.length, 0, '取消搜索或编辑不保存');

  form = open();
  assert.equal(h.editPeopleReads(), 2, '每次打开只读取一次已加载人物目录');
  search = flatten(form).find(node => node.attributes['aria-label'] === '搜索姓名或别名');
  const rows = flatten(form).filter(node => node.className.includes('qqj-qianshi-person-choice'));
  assert.equal(rows.length, 3);
  const originalRows = [...rows];
  const rowInput = row => flatten(row).find(node => node.type === 'checkbox');
  assert.equal(rowInput(rows[0]).checked, true);

  let queryReads = h.editPeopleReads();
  search.value = '沈棠'; search.fire('input', { target: search });
  assert.deepEqual(rows.map(row => row.hidden), [false, true, true], '中文姓名匹配且只隐藏不重建行');
  search.value = 'sHeN tAnG'; search.fire('input', { target: search });
  assert.deepEqual(rows.map(row => row.hidden), [false, true, true], '英文别名大小写不敏感');
  search.value = '阿澈'; search.fire('input', { target: search });
  assert.deepEqual(rows.map(row => row.hidden), [true, false, true]);
  rowInput(rows[1]).checked = true; rowInput(rows[1]).fire('change', { target: rowInput(rows[1]) });
  search.value = '没有这个人'; search.fire('input', { target: search });
  assert.deepEqual(rows.map(row => row.hidden), [true, true, true]);
  const noResults = flatten(form).find(node => node.className.includes('qqj-qianshi-people-empty'));
  assert.equal(noResults?.hidden, false, '无匹配时说明当前搜索没有结果');
  search.value = ''; search.fire('input', { target: search });
  const currentRows = flatten(form).filter(node => node.className.includes('qqj-qianshi-person-choice'));
  assert.deepEqual(currentRows.map(row => row.hidden), [false, false, false], '清空搜索恢复完整目录');
  currentRows.forEach((row, index) => assert.strictEqual(row, originalRows[index], '筛选过程复用原人物行'));
  assert.equal(rowInput(currentRows[1]).checked, true, '隐藏期间保留的选择不会丢失');
  assert.equal(h.editPeopleReads(), queryReads, '输入查询不重新读取人物目录');

  const enter = { key: 'Enter', isComposing: false, keyCode: 13, defaultPrevented: false, cancelBubble: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.cancelBubble = true; } };
  search.fire('keydown', enter);
  assert.equal(enter.defaultPrevented, true, '搜索框Enter只完成查询，不触发保存');
  assert.equal(enter.cancelBubble, true);
  const composing = { key: 'Enter', isComposing: true, keyCode: 229, defaultPrevented: false, cancelBubble: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.cancelBubble = true; } };
  search.fire('keydown', composing);
  assert.equal(composing.defaultPrevented, false, '输入法组合期间保留Enter');
  assert.equal(composing.cancelBubble, false);
  assert.equal(submitted.length, 0);

  search.value = '沈棠'; search.fire('input', { target: search });
  await h.saveEditor();
  assert.deepEqual(submitted[0].people, [{ entityId: 'person', name: '沈棠' }, { entityId: 'npc', name: '阿澈' }], '隐藏的已选人物仍在最终保存内容中');

  const empty = harness({ editPeople: [] });
  const emptyEvent = empty.eventCard('event-1');
  byText(flatten(emptyEvent.parent).find(node => node.className.includes('qqj-qianshi-event-menu')), '编辑详情').fire('click');
  const emptyMessage = flatten(empty.editor()).find(node => node.className.includes('qqj-qianshi-people-empty'));
  assert.equal(emptyMessage?.hidden, false, '没有可用候选时给出明确说明');
  assert.equal(emptyMessage?.textContent, '暂无可选人物。');
  assert.equal(emptyMessage.parent, flatten(empty.editor()).find(node => node.className === 'qqj-qianshi-people-choices'), '空状态位于候选框内');
});

test('时间清空提交明确 null；无效时钟保留草稿且不写入', async () => {
  const submitted = [];
  const h = harness({ editText: async input => { submitted.push(input); return { status: 'saved' }; } });
  const event = h.eventCard('event-1');
  byText(flatten(event.parent).find(node => node.className.includes('qqj-qianshi-event-menu')), '编辑详情').fire('click');
  let form = h.editor();
  const clock = flatten(form).find(node => node.attributes['aria-label'] === '发生时间时间');
  clock.value = '25:00'; clock.fire('input');
  await h.saveEditor();
  assert.equal(submitted.length, 0);
  form = h.editor();
  assert.equal(flatten(form).some(node => node.className.includes('qqj-qianshi-edit-error')), false, '校验提示只由共用弹窗 footer 呈现');
  assert.ok(activeCustomDialog, '无效时间保留编辑弹窗');
  assert.equal(flatten(form).find(node => node.attributes['aria-label'] === '发生时间时间').value, '25:00');
  byText(form, '清空').fire('click'); form = h.editor();
  assert.match(copy(form), /保存后：时间未知/u);
  await h.saveEditor();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].storyTime, null);
});

test('时间预填使用共用投影，真实时间段保留原文，普通文字保存不带时间字段', async () => {
  for (const raw of ['大陆历1686年9月22日 20:30 星期三', '1年夏1日 周一 10:15-10:25']) {
    const snapshot = fixture(); snapshot.events[0].storyTime = raw;
    let submitted;
    const h = harness({ initialSnapshot: snapshot, editText: async input => { submitted = input; return { status: 'saved' }; } });
    const event = h.eventCard('event-1');
    byText(flatten(event.parent).find(node => node.className.includes('qqj-qianshi-event-menu')), '编辑详情').fire('click');
    const form = h.editor();
    assert.ok(copy(form).includes(`发生时间：${raw}`));
    if (raw.startsWith('大陆历')) assert.deepEqual(flatten(flatten(form).filter(node => node.tag === 'fieldset')[0]).filter(node => node.className.includes('qqj-qianshi-time-input'))
      .map(node => node.value), ['大陆历', '1686', '9月', '22', '20:30']);
    const title = form.querySelector('.qqj-qianshi-title-input'); title.value = '人工标题'; title.fire('input', { target: title });
    await h.saveEditor();
    assert.equal(submitted.title, '人工标题');
    assert.equal(Object.hasOwn(submitted, 'storyTime'), false);
    assert.equal(Object.hasOwn(submitted, 'timeDraft'), false);
    assert.equal(h.runtime.getQianshiSnapshot().events[0].storyTime, raw);
  }
});

test('事件编辑分别提交本条动作状态与整线状态', async () => {
  const submitted = [];
  const h = harness({ editText: async input => { submitted.push(input); return { status: 'saved' }; } });
  const event = h.eventCard('event-1');
  byText(flatten(event.parent).find(node => node.className.includes('qqj-qianshi-event-menu')), '编辑详情').fire('click');
  const form = flatten(h.editor()).find(node => node.className.split(/\s+/u).includes('qqj-qianshi-text-form'));
  const selects = flatten(form).filter(node => node.className.includes('qqj-qianshi-status-select'));
  assert.equal(selects.length, 2);
  assert.equal(flatten(form).some(node => node.tag === 'select'), false, '编辑表单也复用插件内状态选择');
  selects[0].querySelector('.qqj-inline-select-trigger').fire('click');
  flatten(selects[0]).find(node => node.attributes['data-value'] === 'completed').fire('click');
  selects[1].querySelector('.qqj-inline-select-trigger').fire('keydown', { key: 'ArrowDown', preventDefault() {} });
  flatten(selects[1]).find(node => node.attributes['data-value'] === 'inProgress').fire('keydown', { key: 'Enter', preventDefault() {} });
  assert.equal(submitted.length, 0, '选项的键盘操作不会提交整个编辑表单');
  await h.saveEditor();
  assert.equal(submitted[0].actionStatus, 'completed');
  assert.equal(submitted[0].status, 'inProgress');
});

test('文字编辑失败时弹窗保留草稿，成功后刷新年表文字', async () => {
  let fail = true, writes = 0;
  const h = harness({ editText: async input => {
    writes += 1;
    if (fail) throw new Error('临时拒绝保存');
    h.runtime._setEventText(input.eventId, input.title, input.description);
    return { status: 'saved' };
  } });
  const first = h.eventCard('event-1');
  const menu = flatten(first.parent).find(node => node.className.includes('qqj-qianshi-event-menu'));
  byText(menu, '编辑详情').fire('click');
  let form = flatten(h.editor()).find(node => node.className.split(/\s+/u).includes('qqj-qianshi-text-form'));
  const title = form.querySelector('.qqj-qianshi-title-input'); title.value = '新标题'; title.fire('input', { target: title });
  const description = form.querySelector('.qqj-qianshi-description-input'); description.value = '新经过'; description.fire('input', { target: description });
  await h.saveEditor();
  form = flatten(h.editor()).find(node => node.className.split(/\s+/u).includes('qqj-qianshi-text-form'));
  assert.equal(form.querySelector('.qqj-qianshi-title-input').value, '新标题');
  assert.equal(form.querySelector('.qqj-qianshi-description-input').value, '新经过');
  assert.equal(flatten(form).some(node => node.className.includes('qqj-qianshi-edit-error')), false, '失败原因只由共享弹窗 footer 呈现');
  assert.ok(activeCustomDialog, '保存失败后编辑窗保持打开');
  assert.equal(writes, 1);
  fail = false;
  await h.saveEditor();
  assert.equal(writes, 2);
  const updated = h.eventCard('event-1');
  assert.match(copy(updated), /新标题.*新经过/u);
  assert.match(copy(h.container), /事件修改已保存/u);
});

test('空文字拒绝保存且保留编辑弹窗，审核候选不提供编辑入口', async () => {
  let writes = 0;
  const h = harness({ canEdit: id => id !== 'event-1', editText: async () => { writes += 1; } });
  const first = h.eventCard('event-1');
  assert.equal(flatten(first.parent).some(node => node.className.includes('qqj-qianshi-event-menu')), false, 'review-only event has no menu');
  h.runtime.canEditQianshiEventText = id => id === 'event-1';
  h.emit();
  const refreshed = h.eventCard('event-1');
  byText(flatten(refreshed.parent).find(node => node.className.includes('qqj-qianshi-event-menu')), '编辑详情').fire('click');
  const editedCard = h.eventCard('event-1');
  let form = flatten(h.editor()).find(node => node.className.split(/\s+/u).includes('qqj-qianshi-text-form'));
  const title = form.querySelector('.qqj-qianshi-title-input'); title.value = '  '; title.fire('input', { target: title });
  await h.saveEditor();
  assert.ok(activeCustomDialog, '空文字校验失败时弹窗保留');
  assert.equal(flatten(form).some(node => node.className.includes('qqj-qianshi-edit-error')), false, '校验原因由共享弹窗 footer 单独呈现');
  assert.equal(writes, 0);
});

test('同日事件卡各自保留编辑入口和原事件身份', () => {
  const grouped = fixture();
  grouped.timeline.segments[0].groups[0].eventIds = ['event-1', 'event-2', 'event-3'];
  const h = harness({ initialSnapshot: grouped });
  const day = flatten(h.container).find(node => node.id === 'day-1');
  assert.equal(flatten(day).filter(node => node.className === 'qqj-qianshi-event').length, 0, '折叠日期不创建事件卡和菜单');
  const disclosure = flatten(day).find(node => node.className === 'qqj-qianshi-day-disclosure');
  disclosure.open = true; disclosure.fire('toggle');
  const cards = flatten(day).filter(node => node.className === 'qqj-qianshi-event');
  assert.deepEqual(cards.map(card => card.dataset.eventId), ['event-3', 'event-2', 'event-1']);
  assert.deepEqual(cards.map(card => flatten(card.parent).find(node => node.className.includes('qqj-qianshi-event-menu'))?.dataset.qianshiEventId), ['event-3', 'event-2', 'event-1'], '菜单分别绑定其事件');
  byText(h.eventMenu('event-2'), '编辑详情').fire('click');
  assert.equal(h.eventCard('event-2').open, false, '独立编辑弹窗不会展开原事件卡');
  assert.equal(h.container.querySelector('.qqj-qianshi-text-form'), null, '列表树中不嵌入编辑表单');
  assert.equal(h.editor().querySelector('.qqj-qianshi-title-input')?.value, '旧信进展 2');
});

test('人工状态编辑仍调用原事件或事项保存接口', async () => {
  const grouped = fixture(); grouped.timeline.segments[0].groups[0].eventIds = ['event-1', 'event-2', 'event-3'];
  const matterWrites = [], actionWrites = [];
  const h = harness({ initialSnapshot: grouped, manualActions: true, custom: async options => {
    const choices = flatten(options.content).filter(node => node.tag === 'input');
    choices.find(node => node.value === 'completed').fire('change');
    return options.submit();
  } });
  h.runtime.setQianshiMatterStatus = async input => { matterWrites.push(input); return { status: 'saved' }; };
  h.runtime.editQianshiEventText = async input => { actionWrites.push(input); return { status: 'saved' }; };
  byText(h.eventMenu('event-3'), '修改状态').fire('click'); await tick(); await tick();
  assert.equal(matterWrites.length, 1, '更新事项的事件使用原整事项状态接口');
  assert.equal(matterWrites[0].matterId, 'matter-1');
  assert.deepEqual(h.calls(), { prepareCalls: 0, startCalls: 0 });
});

test('事件菜单支持外点关闭并在离开页面时清除文档监听', () => {
  const h = harness();
  const event = h.eventCard('event-1');
  const menu = flatten(event.parent).find(node => node.className.includes('qqj-qianshi-event-menu'));
  assert.equal(typeof h.documentRef.listeners.click, 'function');
  menu.open = true;
  const inside = byText(menu, '⋮');
  h.documentRef.fire('click', { target: inside, composedPath: () => [inside, menu, event] });
  assert.equal(menu.open, true, '点菜单内部不关闭当前菜单');
  const outside = new Node('button');
  h.documentRef.fire('click', { target: outside, composedPath: () => [outside] });
  assert.equal(menu.open, false, '点到菜单外关闭');
  h.view.deactivate();
  assert.equal(h.documentRef.listeners.click, undefined, '离开页面后解除全局 click 监听');
});

test('右侧菜单在窄事件栏保留标题空间，内层浮层父级不裁切', () => {
  const css = readFileSync(new URL('../src/ui/panel.css', import.meta.url), 'utf8');
  assert.match(css, /\.qqj-qianshi-meta\{[^}]*grid-template-columns:max-content minmax\(0,1fr\)/u);
  assert.match(css, /\.qqj-qianshi-event-menu\{position:absolute;[^}]*right:0/u);
  assert.match(css, /\.qqj-qianshi-event-row,\.qqj-qianshi-day-event-row\{position:relative/u);
  assert.match(css, /\.qqj-qianshi-event>summary\{[^}]*padding-right:35px/u);
  assert.match(css, /\.qqj-qianshi-matter,\.qqj-qianshi-day-progress\{border-top:1px dashed var\(--line\)\}/u);
  assert.doesNotMatch(css, /\.qqj-qianshi-matter,\.qqj-qianshi-day-progress\{overflow:hidden/u);
  assert.match(css, /\.qqj-qianshi-day\{[^}]*display:grid;grid-template-columns:var\(--qqj-date-width\) var\(--qqj-axis-width\) minmax\(0,1fr\)/u, "day row has three grid columns");
  assert.match(css, /\.qqj-qianshi-day-disclosure\{grid-column:1/u, "date disclosure occupies the date column");
  assert.match(css, /\.qqj-qianshi-dot\{grid-column:2;grid-row:1\}/u, "axis dot shares the date row");
  assert.match(css, /\.qqj-qianshi-events\{grid-column:3;grid-row:1;min-width:0\}/u, "events share the date row");
  assert.match(css, /\.qqj-qianshi-day-summary::after\{display:none;content:none\}/u, "text labels are removed from the date disclosure");
  assert.match(css, /\.qqj-qianshi-day-first::before\{top:11px\}/u, "timeline starts at the first dot");
  assert.match(css, /\.qqj-qianshi-day-last::before\{bottom:calc\(100% - 11px\)\}/u, "timeline stops at the last dot");
  assert.match(css, /\.qqj-qianshi-day-single::before\{content:none\}/u, "single-day segments have no dangling line");
  assert.match(css, /\.qqj-qianshi-day-preview\{grid-column:3;grid-row:1;[^}]*min-width:0/u, "collapsed preview uses the existing event column");
  assert.match(css, /@media\(max-width:340px\)\{\.qqj-qianshi-segment\{--qqj-date-width:46px\}\}/u, "narrow layouts retain enough date-label width");
  assert.doesNotMatch(css, /\.qqj-qianshi-day-chevron/u, "date disclosure has no replacement chevron");
  assert.match(css, /\.qqj-qianshi-date\{position:relative;display:grid;grid-template-columns:minmax\(0,1fr\);align-items:start\}/u, "date text reclaims the removed chevron column");
  assert.doesNotMatch(css, /\.qqj-qianshi-event-row::before/u, 'event rows do not draw axis points');
  assert.match(css, /\.qqj-qianshi-day-last\.qqj-qianshi-day-has-card-axis::before\{bottom:0\}/u, "expanded final date line reaches the visible event list end");
  assert.match(css, /\.qqj-qianshi-day \[hidden\]\{display:none\}/u, "collapsed content is hidden");
  assert.doesNotMatch(css, /\.qqj-qianshi-day-content|\.qqj-qianshi-day\[open\]/u, "old details layout rules are gone");
});

test('每日期仅有一个轴点；独立事件卡按需构建，搜索只显示命中事件', () => {
  const snapshot = fixture();
  const dayEvents = [
    { id: 'merged-early', matterId: 'merged', title: '合并事项较早过程', description: '同事项早段', status: 'occurred', storyTime: '2026-07-01 08:00', people: [] },
    { id: 'merged-late', matterId: 'merged', title: '合并事项较晚过程', description: '同事项晚段', status: 'occurred', storyTime: '2026-07-01 10:00', people: [] },
    { id: 'middle-card', matterId: null, title: '中间独立卡', description: '筛选目标', status: 'occurred', storyTime: '2026-07-01 09:00', people: [] },
    { id: 'last-card', matterId: null, title: '故事最早卡', description: '屏幕最下方的卡', status: 'occurred', storyTime: '2026-07-01 11:00', people: [] },
    { id: 'newer-day', matterId: null, title: '较晚日期卡', description: '另一天', status: 'occurred', storyTime: '2026-07-02 11:00', people: [] },
  ];
  snapshot.events = dayEvents;
  snapshot.matters = [];
  snapshot.timeline = { hasGlobalLatest: true, globalLatestGroupId: 'newer', segments: [{ id: 'gregorian', latestGroupId: 'newer', groups: [
    { id: 'earliest', day: '1日', period: '2026年7月', full: '2026年7月1日', eventIds: dayEvents.slice(0, 4).map(event => event.id) },
    { id: 'newer', day: '2日', period: '2026年7月', full: '2026年7月2日', eventIds: ['newer-day'] },
  ] }], undatedEventIds: [] };
  const h = harness({ initialSnapshot: snapshot });
  const day = id => flatten(h.container).find(node => node.tag === 'div' && node.id === id && node.className.includes('qqj-qianshi-day'));
  const firstCardOrder = () => flatten(day('earliest')).filter(node => node.tag === 'details' && node.className === 'qqj-qianshi-event').map(node => node.dataset.cardId);
  const dateDots = () => flatten(day('earliest')).filter(node => node.className === 'qqj-qianshi-dot');
  const eventRowDots = () => flatten(day('earliest')).filter(node => node.className === 'qqj-qianshi-event-row')
    .flatMap(row => flatten(row).slice(1)).filter(node => node.className === 'qqj-qianshi-dot');
  const earliestDisclosure = flatten(day('earliest')).find(node => node.className === 'qqj-qianshi-day-disclosure');
  assert.equal(dateDots().length, 1, '日期行保留且只保留日期自身的轴点');
  assert.equal(day('earliest').className.includes('qqj-qianshi-day-has-card-axis'), false, '折叠日期不把连线延进隐藏事件');
  assert.deepEqual(firstCardOrder(), [], '折叠日期不创建事件卡 DOM');
  flatten(day('earliest')).find(node => node.className === 'qqj-qianshi-day-summary').fire('click', { isTrusted: true });
  earliestDisclosure.open = true; earliestDisclosure.fire('toggle');
  assert.deepEqual(firstCardOrder(), ['last-card', 'middle-card', 'merged-late', 'merged-early'], '默认倒序保留每条事件及其原顺序');
  assert.equal(dateDots().length, 1, '展开多张事件卡仍只有日期轴点');
  assert.equal(eventRowDots().length, 0, '事件卡里没有日期轴点');
  assert.ok(day('earliest').className.includes('qqj-qianshi-day-last'), '最早日期处于默认屏幕末尾');
  assert.ok(day('earliest').className.includes('qqj-qianshi-day-has-card-axis'), '展开的多卡末日将日期连线沿事件列表延伸');
  earliestDisclosure.open = false; earliestDisclosure.fire('toggle');
  assert.equal(day('earliest').className.includes('qqj-qianshi-day-has-card-axis'), false, '收起后连线回到日期点');
  assert.equal(dateDots().length, 1, '收起事件卡不影响日期自身轴点');
  earliestDisclosure.open = true; earliestDisclosure.fire('toggle');
  const summary = flatten(day('earliest')).find(node => node.className === 'qqj-qianshi-day-summary');
  assert.equal(summary.tag, 'summary', '日期仍使用原生 details/summary 鼠标和键盘交互');
  assert.equal(flatten(summary).some(node => node.className === 'qqj-qianshi-day-chevron' || node.textContent === '›'), false, '日期边没有展开箭头');
  assert.match(summary.attributes['aria-label'], /收起/u, '日期 summary 保留可操作状态提示');
  assert.match(readFileSync(new URL('../src/ui/panel.css', import.meta.url), 'utf8'), /\.qqj-qianshi-day-summary:focus-visible\{outline:2px solid var\(--knot\)/u, '键盘焦点仍有可见轮廓');

  assert.equal(byText(h.container, '由晚到早'), undefined, '固定最近在前，不显示方向切换');
  assert.equal(dateDots().length, 1, '最近在前仍只保留一个日期轴点');
  assert.equal(eventRowDots().length, 0, '最近在前也不在事件卡旁增加轴点');

  const search = flatten(h.container).find(node => node.className.includes('qqj-history-search-input'));
  search.value = '中间独立卡'; search.fire('input', { target: search });
  assert.deepEqual(firstCardOrder(), ['middle-card'], '搜索按现有过滤语义只显示命中顶层卡');
  assert.equal(dateDots().length, 1, '过滤后日期仍保留自己的唯一轴点');
  assert.equal(eventRowDots().length, 0, '搜索结果不在事件旁增加轴点');
  assert.equal(day('earliest').className.includes('qqj-qianshi-day-has-card-axis'), false, '过滤后的单卡不延长线');
});

test('千事页以健康条和共享搜索开头，说明与事项全链按需展开且不虚构地点', () => {
  const h = harness();
  const page = h.container.children[0];
  assert.match(page.children[0].className, /^qqj-qianshi-coverage /u);
  assert.equal(page.children[1].className, 'qqj-history-search');
  assert.deepEqual(page.children[1].children[0].className.split(/\s+/u), ['settings-input', 'qqj-history-search-input']);
  assert.equal(page.children[1].children[0].placeholder, '搜索事件、说明、人物、涉及物品或时间');
  assert.equal(page.children[1].children[0].attributes['aria-label'], page.children[1].children[0].placeholder);
  assert.deepEqual(page.children[1].children[1].className.split(/\s+/u), ['secondary-action', 'qqj-history-search-clear']);
  assert.doesNotMatch(copy(h.container), /故事年表|按剧情日期整理已保存的事件/u);
  assert.match(copy(h.container), /取得旧信.*这是完整说明正文/u);
  assert.equal(flatten(h.container).some(node => node.attributes['aria-label'] === '搜索事件' || /展开全部|收起全部/u.test(node.attributes['aria-label'] ?? '')), false);
  assert.doesNotMatch(copy(h.container), /地点/u);
  const first = h.eventCard('event-1');
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
  assert.equal(flatten(h.container).find(node => node.tag === 'strong')?.textContent, '部分关系失效');
  assert.match(coverage, /已完成 3 楼；待补 1 楼；部分整理 2 楼；断链 2 楼；无唯一有效摘要 1 楼/u);
  assert.match(coverage, /分母是 8 个有唯一有效摘要的楼/u);
  assert.doesNotMatch(coverage, /断链楼的既有事件和摘要仍显示/u, '异常详情移入弹窗，不在顶部堆长文');
  assert.doesNotMatch(coverage, /隔离/u);
});

test('全局覆盖说明区分已结案楼和仍待补楼，complete 加 pending 不再称部分整理', () => {
  const mixedPartial = fixture();
  mixedPartial.coverage = { eligibleFloors: 9, completeFloors: 5, pendingFloors: 1, partialFloors: 2, degradedFloors: 0, unavailableFloors: 0 };
  const mixed = harness({ initialSnapshot: mixedPartial });
  const mixedNodes = flatten(mixed.container);
  assert.equal(mixedNodes.find(node => node.tag === 'strong')?.textContent, '尚有其他楼未完成');
  assert.match(copy(mixed.container), /已完成 5 楼；待补 1 楼；部分整理 2 楼/u);
  assert.match(copy(mixed.container), /已有事件的楼按已存档计入完成/u);

  const pending = fixture();
  pending.coverage = { eligibleFloors: 9, completeFloors: 7, pendingFloors: 2, partialFloors: 0, degradedFloors: 0, unavailableFloors: 0 };
  const withPending = harness({ initialSnapshot: pending });
  const pendingNodes = flatten(withPending.container);
  assert.equal(pendingNodes.find(node => node.tag === 'strong')?.textContent, '尚有其他楼未完成');
  assert.doesNotMatch(pendingNodes.find(node => node.tag === 'strong')?.textContent ?? '', /部分整理/u);
  assert.match(copy(withPending.container), /已完成 7 楼；待补 2 楼；部分整理 0 楼/u);
  assert.match(copy(withPending.container), /已有事件的楼按已存档计入完成/u);
});

test('只读导入历史不显示为当前待补或已检查为空，既存事件仍可查看', () => {
  const snapshot = fixture();
  snapshot.coverage = { eligibleFloors: 3602, completeFloors: 0, pendingFloors: 3602, partialFloors: 0,
    degradedFloors: 0, unavailableFloors: 0, processable: { eligibleFloors: 0, completeFloors: 0, readyFloors: 0,
      emptyFloors: 0, pendingFloors: 0, partialFloors: 0, degradedFloors: 0, unavailableFloors: 0, frozenFloors: 3602 } };
  snapshot.events = []; snapshot.matters = []; snapshot.timeline = { segments: [], undatedEventIds: [] };
  const h = harness({ initialSnapshot: snapshot, canEdit: false });
  assert.match(copy(h.container), /当前没有可处理楼/u);
  assert.match(copy(h.container), /导入历史 3602 楼只读/u);
  assert.doesNotMatch(copy(h.container), /待补 3602 楼|已检查为空/u);
  assert.equal(byText(h.container, '补齐旧楼'), undefined, '冻结历史不会显示补齐入口');

  const withEvent = structuredClone(snapshot);
  withEvent.events = [{ id: 'archived-visible', matterId: null, title: '旧事件仍可查看', description: '保留历史事件', status: 'occurred',
    storyTime: null, scheduledTime: null, people: [], sourceFloorMemoryId: 'archived-memory', frozen: true }];
  withEvent.timeline = { segments: [], undatedEventIds: ['archived-visible'] };
  h.emit(withEvent);
  const archiveGroup = flatten(h.container).find(node => node.className === 'qqj-qianshi-undated');
  archiveGroup.children.find(node => node.tag === 'summary').fire('click', { isTrusted: true }); archiveGroup.open = true; archiveGroup.fire('toggle');
  assert.ok(flatten(h.container).some(node => node.dataset.eventId === 'archived-visible'), '冻结事件仍显示');
  assert.equal(flatten(h.container).some(node => node.className.includes('qqj-qianshi-event-menu')), false, '冻结事件仍只读');
  assert.equal(byText(h.container, '补齐旧楼'), undefined, '显示只读事件不产生补齐入口');
});

test('历史补齐界面区分已保存完整楼和部分楼并展示编译原因', () => {
  const snapshot = fixture();
  snapshot.history = { status: 'partial', message: '1 楼部分事件已保存。', attemptedFloors: 2, processedFloors: 2,
    savedCompleteFloors: 1, savedPartialFloors: 1, failedFloors: 0, skippedFloors: 0,
    outcomes: [{ status: 'saved-partial', reasonCode: 'QIANSHI_HISTORY_EVENT_PARTIAL', messageIndex: 4, assistantSeq: 1, message: '1 条事件未能整理：第 1 条事件对应的整件事或本次动作状态无法识别，未保存。' },
      { status: 'saved-complete', messageIndex: 8, assistantSeq: 2, message: '千事结果已完整保存。' }] };
  const h = harness({ initialSnapshot: snapshot });
  assert.match(copy(h.container), /保存完整 1 楼、部分 1 楼/u);
  assert.match(copy(h.container), /第 4 楼：1 条事件未能整理：第 1 条事件对应的整件事或本次动作状态无法识别/u);
});

test('百节点年表只创建当前展开日卡片，事项链仍在二次展开时创建', () => {
  const large = fixture();
  large.events = Array.from({ length: 100 }, (_, index) => ({ ...large.events[0], id: `large-${index}`, title: `大事项 ${index}`, description: `说明 ${index}`, matterId: 'large-matter' }));
  large.matters[0].matterId = 'large-matter';
  large.matters[0].recordIds = large.events.map(event => event.id); large.matters[0].eventIds = [...large.matters[0].recordIds];
  large.timeline.segments[0].groups = large.events.map((event, index) => ({ id: `large-day-${index}`, day: `${index + 1}日`, period: '长历', full: `长历${index + 1}日`, eventIds: [event.id] }));
  large.timeline.segments[0].latestGroupId = 'large-day-99'; large.timeline.globalLatestGroupId = 'large-day-99'; large.timeline.undatedEventIds = [];
  const h = harness({ initialSnapshot: large });
  assert.equal(flatten(h.container).filter(node => node.className === 'qqj-qianshi-event').length, 1, '其余99个日期收起，不创建完整事件卡');
  assert.equal(flatten(h.container).filter(node => node.className.includes('qqj-qianshi-matter-event')).length, 0, '展开全部不生成一万条事项链 DOM');
  const first = h.eventCard('large-0'); first.open = true; first.fire('toggle');
  assert.equal(flatten(h.container).filter(node => node.className === 'qqj-qianshi-event').length, 2, '打开另一日期只增建该日事件卡');
  const firstMatter = flatten(first).find(node => node.className === 'qqj-qianshi-matter'); firstMatter.open = true; firstMatter.fire('toggle');
  assert.equal(flatten(firstMatter).filter(node => node.className.includes('qqj-qianshi-matter-event')).length, 100);
});

test('同日同事项分别显示原事件，搜索显示命中记录且日期收起会释放卡片', () => {
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
  const day = flatten(h.container).find(node => node.id === 'day-1');
  const disclosure = flatten(day).find(node => node.className === 'qqj-qianshi-day-disclosure');
  const dayCards = () => flatten(day).filter(node => node.className === 'qqj-qianshi-event');
  assert.equal(dayCards().length, 0, '收起日期时不创建卡片与操作菜单');
  disclosure.open = true; disclosure.fire('toggle');
  assert.deepEqual(dayCards().map(node => node.dataset.eventId), ['independent', 'event-3', 'event-2', 'event-1'], '同日同事项也逐条显示并按当前顺序排列');
  assert.ok(dayCards().some(node => node.dataset.eventId === 'independent'), '同日独立事件保留');
  const event1 = dayCards().find(node => node.dataset.eventId === 'event-1');
  assert.equal(flatten(event1.parent).find(node => node.className.includes('qqj-qianshi-event-menu'))?.dataset.qianshiEventId, 'event-1', '每张事件卡的操作仍绑定原事件 ID');
  event1.open = true; event1.fire('toggle');
  assert.ok(flatten(event1).some(node => node.className === 'qqj-qianshi-matter'), '每条记录仍保留跨日完整事项经过入口');
  assert.ok(flatten(event1).some(node => node.className === 'qqj-qianshi-description' || node.className === 'qqj-qianshi-event-detail'), '事件正文只在本卡展开后创建');
  const undatedGroup = flatten(h.container).find(node => node.className === 'qqj-qianshi-undated');
  assert.ok(undatedGroup, '未知日期事件仍保留独立分组');
  undatedGroup.open = true; undatedGroup.fire('toggle');
  assert.ok(flatten(undatedGroup).some(node => node.dataset.eventId === 'undated-matter'), '展开后未知日期事件不并入日期组');

  const input = flatten(h.container).find(node => node.className.split(/\s+/u).includes('qqj-history-search-input'));
  input.fire('input', { target: { value: '沈棠', selectionStart: 2 } });
  assert.match(copy(h.container), /匹配 1 件事件 · 显示 1 条.*取得旧信/u);
  assert.deepEqual(flatten(h.container).filter(node => node.className === 'qqj-qianshi-event').map(node => node.dataset.eventId), ['event-1'], '命中事件本身直接显示，不借同事项末条代表');
  assert.equal(flatten(h.container).some(node => node.dataset.eventId === 'event-3'), false);
  byText(h.eventCard('event-1').parent, '编辑详情').fire('click');
  assert.equal(h.eventCard('event-1').querySelector('.qqj-qianshi-text-form'), null, '事件卡阅读树不嵌入编辑表单');
  assert.equal(flatten(h.editor()).find(node => node.className.split(/\s+/u).includes('qqj-qianshi-title-input'))?.value, '取得旧信', '搜索命中事件仍进入独立编辑弹窗');
  input.value = ''; input.fire('input', { target: { value: '', selectionStart: 0 } });
  const restoredDay = flatten(h.container).find(node => node.id === 'day-1');
  const restoredDisclosure = flatten(restoredDay).find(node => node.className === 'qqj-qianshi-day-disclosure');
  restoredDisclosure.open = false; restoredDisclosure.fire('toggle');
  assert.equal(flatten(restoredDay).filter(node => node.className === 'qqj-qianshi-event').length, 0, '收起日期会移除整组卡片 DOM');
  restoredDisclosure.open = true; restoredDisclosure.fire('toggle');
  assert.deepEqual(flatten(restoredDay).filter(node => node.className === 'qqj-qianshi-event').map(node => node.dataset.eventId), ['independent', 'event-3', 'event-2', 'event-1'], '重新展开只重建一份当前日期卡片');
});

test('固定最近在前，跨不可比时间组按来源倒序且不推断先后', () => {
  const snapshot = fixture();
  snapshot.events = [
    { id: 'old', matterId: null, title: '旧年', description: '旧年说明', status: 'occurred', storyTime: '公历2024年12月31日', scheduledTime: null, people: [] },
    { id: 'new', matterId: null, title: '新年', description: '新年说明', status: 'occurred', storyTime: '公历2025年1月1日', scheduledTime: null, people: [] },
    { id: 'oct', matterId: null, title: '无年十月', description: '十月说明', status: 'occurred', storyTime: '10月1日', scheduledTime: null, people: [] },
    { id: 'nov', matterId: null, title: '无年十一月', description: '十一月说明', status: 'occurred', storyTime: '11月3日', scheduledTime: null, people: [] },
    { id: 'range', matterId: null, title: '时间范围', description: '范围说明', status: 'unknown', storyTime: '10月1日至10月3日', scheduledTime: null, people: [] },
  ];
  snapshot.timeline = { hasGlobalLatest: false, globalLatestGroupId: null, segments: [
    { id: 'dated', label: '完整日期', latestGroupId: 'new-day', groups: [
      { id: 'old-day', day: '31日', period: '2024年12月', full: '公历2024年12月31日', eventIds: ['old'] },
      { id: 'new-day', day: '1日', period: '2025年1月', full: '公历2025年1月1日', eventIds: ['new'] },
    ] },
    { id: 'month-day', label: '仅月日', latestGroupId: 'nov-day', groups: [
      { id: 'oct-day', day: '1日', period: '10月', full: '10月1日（年份未明）', eventIds: ['oct', 'range'] },
      { id: 'nov-day', day: '3日', period: '11月', full: '11月3日（年份未明）', eventIds: ['nov'] },
    ] },
  ], undatedEventIds: [] };
  const h = harness({ initialSnapshot: snapshot });
  const dayOrder = () => flatten(h.container).filter(node => node.id && node.className.startsWith('qqj-qianshi-day')).map(node => node.id);
  assert.deepEqual(dayOrder(), ['nov-day', 'oct-day', 'new-day', 'old-day'], '不可比时间组按最近来源优先，各组日期最近在前');
  assert.equal(byText(h.container, '由晚到早'), undefined, '固定最近在前，不显示方向切换');
  assert.match(copy(h.container), /仅月日 · 不依据其他组推断先后/u);
  assert.match(copy(h.container), /10月1日至10月3日/u, '可识别左端点的范围留在对应日期，并继续展示完整原文');
});

test('无年份的年末与年初页面保留来源顺序，不显示虚假的段内最近', () => {
  const snapshot = fixture();
  snapshot.events = [
    { id: 'dec', matterId: null, updatesMatter: false, title: '年末事件', description: '只有月日', status: 'occurred', storyTime: '12月31日', scheduledTime: null, people: [], object: null },
    { id: 'jan', matterId: null, updatesMatter: false, title: '年初事件', description: '只有月日', status: 'occurred', storyTime: '1月1日', scheduledTime: null, people: [], object: null },
  ];
  snapshot.matters = []; snapshot.relations = [];
  snapshot.timeline = projectQianshiTimeline({ events: snapshot.events, relations: [] });
  assert.equal(snapshot.timeline.hasGlobalLatest, false);
  assert.equal(snapshot.timeline.segments[0].latestGroupId, null);
  const h = harness({ initialSnapshot: snapshot });
  const dayOrder = () => flatten(h.container).filter(node => node.id && node.className.startsWith('qqj-qianshi-day')).map(node => node.id);
  const sourceOrder = snapshot.timeline.segments[0].groups.map(group => group.id);
  assert.deepEqual(dayOrder(), [...sourceOrder].reverse(), '跨年不可比时按最近来源倒序显示');
  assert.equal(flatten(h.container).some(node => node.className.includes('qqj-qianshi-latest-tag')), false, '年末或年初不显示最近标记');
});

test('不可比较的多个纪年组不逐段标最近，可比较时只标全局最近日', () => {
  const snapshot = fixture();
  snapshot.events = [
    { id: 'april', matterId: null, title: '四月事件', description: '较早', status: 'occurred', storyTime: '启航387年4月30日', people: [] },
    { id: 'may', matterId: null, title: '五月事件', description: '较晚', status: 'occurred', storyTime: '启航387年5月6日', people: [] },
  ];
  snapshot.matters = []; snapshot.relations = [];
  snapshot.timeline = { hasGlobalLatest: false, globalLatestGroupId: null, undatedEventIds: [], segments: [
    { id: 'era-april', label: '启航纪年', latestGroupId: 'april-day', groups: [{ id: 'april-day', day: '30日', period: '启航387年4月', full: '启航387年4月30日', eventIds: ['april'] }] },
    { id: 'era-may', label: '启航纪年', latestGroupId: 'may-day', groups: [{ id: 'may-day', day: '6日', period: '启航387年5月', full: '启航387年5月6日', eventIds: ['may'] }] },
  ] };
  const h = harness({ initialSnapshot: snapshot });
  const latestDays = () => flatten(h.container).filter(node => node.className.split(/\s+/u).includes('qqj-qianshi-day') && node.className.includes(' latest'));
  const displayedDayIds = () => flatten(h.container).filter(node => node.id && node.className.startsWith('qqj-qianshi-day')).map(node => node.id);
  assert.deepEqual(displayedDayIds(), ['may-day', 'april-day'], '两个不可比纪年域保持分组，并按组内较新来源倒序');
  assert.equal(latestDays().length, 0, '不同域没有可比较的整体最近时，各域的局部末日也不高亮');
  assert.equal(flatten(h.container).some(node => node.className === 'qqj-qianshi-latest-tag'), false);

  const comparable = h.runtime.getQianshiSnapshot();
  comparable.timeline = { hasGlobalLatest: true, globalLatestGroupId: 'may-day', undatedEventIds: [], segments: [
    { id: 'configured-era', label: '启航纪年', latestGroupId: 'april-day', groups: [
      { id: 'april-day', day: '30日', period: '启航387年4月', full: '启航387年4月30日', eventIds: ['april'] },
      { id: 'may-day', day: '6日', period: '启航387年5月', full: '启航387年5月6日', eventIds: ['may'] },
    ] },
  ] };
  h.emit(comparable);
  assert.deepEqual(latestDays().map(node => node.id), ['may-day']);
  assert.equal(flatten(h.container).filter(node => node.className === 'qqj-qianshi-latest-tag').length, 1);
  assert.deepEqual(latestDays().map(node => node.id), ['may-day'], '反转显示顺序不改变投影确定的全局最近日');
});

test('真实投影以中性文案显示完整日期、特殊月份和仅月日', () => {
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
  assert.equal(snapshot.timeline.segments[0].id, 'dated');
  assert.match(snapshot.timeline.segments[1].id, /^era-numeric:/u);
  assert.equal(snapshot.timeline.segments[2].id, 'month-day');
  const segmentLabels = () => flatten(h.container).filter(node => node.className === 'qqj-qianshi-segment-label').map(node => node.textContent);
  assert.deepEqual(segmentLabels(), [
    '大陆历纪年 · 不依据其他组推断先后', '完整日期 · 不依据其他组推断先后', '仅月日 · 不依据其他组推断先后',
  ], '不可比段按组内最新来源倒序，不猜纪年顺序');
  assert.match(copy(h.container), /无法确定单一发生时间 · 1 件/u, '无法排序的日期仍留在底部折叠区');

  const initialOrder = dayOrder();
  assert.equal(initialOrder[0], snapshot.timeline.segments[1].groups[0].id, '最新来源的具名纪年组排前');
  assert.equal(initialOrder[1], snapshot.timeline.segments[0].groups.at(-1).id, '完整日期组内部按时间倒序');
  assert.equal(byText(h.container, '由晚到早'), undefined, '固定最近在前，没有升序切换');
});

test('普通楼和聚合楼的完整日期进入同组，特殊日期原文独立显示', async () => {
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
  const dated = snapshot.timeline.segments.find(segment => segment.id === 'dated');
  assert.equal(dated.label, '完整日期');
  assert.ok(dated.groups.some(group => group.eventIds.includes(projection.events.find(event => event.title === '普通楼明确日期').id)));
  assert.ok(dated.groups.some(group => group.eventIds.includes(projection.events.find(event => event.title === '聚合楼明确日期').id)));
  assert.equal(snapshot.timeline.segments.findIndex(segment => segment.id === 'month-day') > snapshot.timeline.segments.findIndex(segment => segment.id === 'dated'), true,
    '无年份月日仍在明确年份段之后独立展示');

  const h = harness({ initialSnapshot: snapshot });
  const segmentLabels = () => flatten(h.container).filter(node => node.className === 'qqj-qianshi-segment-label').map(node => node.textContent);
  assert.deepEqual(segmentLabels(), [
    '完整日期 · 不依据其他组推断先后', '大陆历纪年 · 不依据其他组推断先后', '仅月日 · 不依据其他组推断先后',
  ]);
  assert.match(copy(h.container), /2010年9月22日/u);
  assert.match(copy(h.container), /2010年9月23日/u);
  assert.doesNotMatch(copy(h.container), /2010年9月(?:22|23)日[^|]*年份未明/u);
  assert.deepEqual(segmentLabels(), [
    '完整日期 · 不依据其他组推断先后', '大陆历纪年 · 不依据其他组推断先后', '仅月日 · 不依据其他组推断先后',
  ], '最近在前不改时间信息分组');
});

test('同日事项根据事件原文的显式秒由近及远显示，保留原文时间', () => {
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
  assert.equal(byText(h.container, '由晚到早'), undefined);
});

test('真实投影将同日精确时刻排近在前，缺时记录继续按来源倒序', async () => {
  const chatId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', generation = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const floors = [1, 2, 3, 4].map(assistantSeq => ({ id: `11111111-1111-4111-8111-${String(assistantSeq).padStart(12, '0')}`,
    chatId, narrativeGeneration: generation, assistantSeq, hostLocator: { messageIndex: assistantSeq * 2 }, content: { canonicalContent: `第${assistantSeq}楼` } }));
  const titles = ['明确晚时', '缺时较早来源', '明确早时', '缺时较新来源'];
  const times = ['2026-04-05 10:00', null, '2026-04-05 08:00', null];
  const memories = [];
  for (const [index, source] of floors.entries()) {
    const delta = await compileQianshiDelta({ floor: source, now: '2026-04-06T00:00:00.000Z', packet: { qianshi: { events: [
      { key: `event-${index}`, title: titles[index], description: titles[index], status: 'occurred', matter: false, ...(times[index] ? { storyTime: times[index] } : {}) },
    ], order: [] } } });
    memories.push({ id: `22222222-2222-4222-8222-${String(index + 1).padStart(12, '0')}`, floorId: source.id, recordStatus: 'active', chronology: index === 1 || index === 3
      ? [{ time: { kind: 'absolute', normalized: '2026-04-05' } }] : [], qianshiDelta: delta });
  }
  const reachable = { root: { chatId, narrativeGeneration: generation, headCheckpointId: '33333333-3333-4333-8333-333333333333' }, rootRevision: 1,
    floors, floorMemories: memories, entities: [] };
  const projection = projectQianshiGraph(reachable), snapshot = publicQianshiSnapshot(reachable);
  assert.deepEqual(snapshot.timeline.segments[0].groups[0].eventIds.map(id => projection.events.find(event => event.id === id).title),
    ['缺时较早来源', '明确早时', '明确晚时', '缺时较新来源'], '真实 timeline 投影保留缺时来源fallback，同时把可比钟点排正确');
  const h = harness({ initialSnapshot: snapshot });
  const shown = flatten(h.container).filter(node => node.className === 'qqj-qianshi-event').map(node => node.dataset.eventId);
  const byTitle = new Map(projection.events.map(event => [event.title, event.id]));
  assert.deepEqual(shown, [byTitle.get('缺时较新来源'), byTitle.get('明确晚时'), byTitle.get('明确早时'), byTitle.get('缺时较早来源')],
    '真实 graph→timeline→view 将可比较时刻最近优先，缺时事件按来源新旧倒序');
});

test('真实编译与公开投影保留同分钟秒顺序，夹入缺秒记录不补造精度', async () => {
  const chatId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', generation = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const source = { id: '11111111-1111-4111-8111-111111111111', chatId, narrativeGeneration: generation, assistantSeq: 1,
    hostLocator: { messageIndex: 2 }, content: { canonicalContent: '同日同分钟记录' } };
  const delta = await compileQianshiDelta({ floor: source, now: '2026-04-06T00:00:00.000Z', packet: { qianshi: { events: [
    { key: 'late', title: '先记录的较晚秒', description: '原文明确为56秒。', status: 'occurred', matter: false, storyTime: '2026-04-05 12:34:56' },
    { key: 'unknown-old', title: '夹入的较早缺秒记录', description: '原文只有分钟。', status: 'occurred', matter: false, storyTime: '2026-04-05 12:34' },
    { key: 'early', title: '后记录的较早秒', description: '原文明确为05秒。', status: 'occurred', matter: false, storyTime: '2026-04-05 12:34:05' },
    { key: 'unknown-new', title: '后来记录的缺秒', description: '原文仍只有分钟。', status: 'occurred', matter: false, storyTime: '2026-04-05 12:34' },
  ], order: [] } } });
  const reachable = { root: { chatId, narrativeGeneration: generation, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 1,
    floors: [source], floorMemories: [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', floorId: source.id, recordStatus: 'active', chronology: [], qianshiDelta: delta }], entities: [] };
  const projection = projectQianshiGraph(reachable), snapshot = publicQianshiSnapshot(reachable);
  const byTitle = new Map(projection.events.map(event => [event.title, event.id]));
  const sameDay = snapshot.timeline.segments.flatMap(segment => segment.groups).find(group => group.eventIds.includes(byTitle.get('先记录的较晚秒')));
  const projectionTitles = sameDay.eventIds.map(id => projection.events.find(event => event.id === id).title);
  assert.deepEqual(projectionTitles.filter(title => ['后记录的较早秒', '先记录的较晚秒'].includes(title)),
    ['后记录的较早秒', '先记录的较晚秒'], '图内保留明确秒数的先后');
  assert.deepEqual(projectionTitles.filter(title => title.includes('缺秒')), ['夹入的较早缺秒记录', '后来记录的缺秒'], '缺秒项仍按来源顺序');
  assert.equal(snapshot.events.find(event => event.id === byTitle.get('夹入的较早缺秒记录')).storyTime, '2026-04-05 12:34', '缺秒原文不补成12:34:00');
  const h = harness({ initialSnapshot: snapshot });
  const snapshotTitleById = new Map(snapshot.events.map(event => [event.id, event.title]));
  const shownTitles = flatten(h.container).filter(node => node.className === 'qqj-qianshi-event').map(node => snapshotTitleById.get(node.dataset.eventId));
  assert.deepEqual(shownTitles.filter(title => ['后记录的较早秒', '先记录的较晚秒'].includes(title)),
    ['先记录的较晚秒', '后记录的较早秒'], '真实UI按有据秒数由近及远');
  assert.deepEqual(shownTitles.filter(title => title.includes('缺秒')), ['后来记录的缺秒', '夹入的较早缺秒记录'], '真实UI未定秒项按来源新旧倒序');
});

test('事项经过使用recordIds权威顺序并将最新记录放在前面', () => {
  const snapshot = fixture();
  snapshot.matters[0].recordIds = ['event-1', 'event-2', 'event-3'];
  snapshot.events = [snapshot.events[2], snapshot.events[0], snapshot.events[1], ...snapshot.events.slice(3)];
  const h = harness({ initialSnapshot: snapshot });
  const card = h.eventCard('event-1'); card.open = true; card.fire('toggle');
  const matter = flatten(card).find(node => node.className === 'qqj-qianshi-matter'); matter.open = true; matter.fire('toggle');
  const titles = flatten(matter).filter(node => node.className.includes('qqj-qianshi-matter-event')).map(row => row.children[0].children[0].textContent);
  assert.deepEqual(titles, ['2026-07-03 10:00 · 旧信进展 3', '2026-07-02 10:00 · 旧信进展 2（背景 / 补充）', '2026-07-01 10:00 · 取得旧信'],
    '经过顺序来自recordIds并倒序；snapshot.events的物理排列不改变权威历史');
});

test('真实事项recordIds从project graph到public snapshot再到UI都保持完整且最近优先', async () => {
  const chatId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', generation = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const floors = [1, 2].map(assistantSeq => ({ id: `44444444-4444-4444-8444-${String(assistantSeq).padStart(12, '0')}`,
    chatId, narrativeGeneration: generation, assistantSeq, hostLocator: { messageIndex: assistantSeq * 2 }, content: { canonicalContent: `事项来源${assistantSeq}` } }));
  const first = await compileQianshiDelta({ floor: floors[0], now: '2026-04-06T00:00:00.000Z', packet: { qianshi: { events: [
    { key: 'start', title: '先发现线索', description: '事项早期记录', status: 'completed', matter: true, storyTime: '2026-04-05 08:00' },
  ], order: [] } } });
  const second = await compileQianshiDelta({ floor: floors[1], now: '2026-04-06T00:00:00.000Z', packet: { qianshi: { events: [
    { key: 'finish', title: '后来找到答案', description: '事项最新记录', status: 'inProgress', matter: true, storyTime: '2026-04-05 10:00' },
  ], order: [] } } });
  second.events[0].matterId = first.events[0].matterId;
  const reachable = { root: { chatId, narrativeGeneration: generation, headCheckpointId: '55555555-5555-4555-8555-555555555555' }, rootRevision: 1,
    floors, floorMemories: [
      { id: '66666666-6666-4666-8666-666666666661', floorId: floors[0].id, recordStatus: 'active', chronology: [], qianshiDelta: first },
      { id: '66666666-6666-4666-8666-666666666662', floorId: floors[1].id, recordStatus: 'active', chronology: [], qianshiDelta: second },
    ], entities: [] };
  const graph = projectQianshiGraph(reachable), snapshot = publicQianshiSnapshot(reachable);
  const matter = snapshot.matters.find(item => item.matterId === first.events[0].matterId);
  assert.deepEqual(matter.recordIds, [first.events[0].id, second.events[0].id], 'projectGraph的事项记录顺序进入公开recordIds');
  const h = harness({ initialSnapshot: snapshot });
  const card = h.eventCard(second.events[0].id); card.open = true; card.fire('toggle');
  const history = flatten(card).find(node => node.className === 'qqj-qianshi-matter'); history.open = true; history.fire('toggle');
  const titles = flatten(history).filter(node => node.className.includes('qqj-qianshi-matter-event')).map(row => row.children[0].children[0].textContent);
  assert.deepEqual(titles, ['2026-04-05 10:00 · 后来找到答案', '2026-04-05 08:00 · 先发现线索'],
    'UI按public recordIds由近及远显示实际图投影事项经过');
  assert.equal(graph.matters.find(item => item.matterId === matter.matterId).recordIds.length, 2);
});

test('异常楼与异常楼内事件都按来源新旧倒序查看', async () => {
  const snapshot = fixture();
  snapshot.events = [
    { id: 'old-event', matterId: null, title: '旧异常事件', description: '旧', status: 'occurred', sourceAssistantSeq: 2, people: [] },
    { id: 'new-event', matterId: null, title: '新异常事件', description: '新', status: 'occurred', sourceAssistantSeq: 9, people: [] },
    { id: 'older-sibling', matterId: null, title: '同楼较早事件', description: '旧同楼', status: 'occurred', sourceAssistantSeq: 9, people: [] },
  ];
  snapshot.timeline = { segments: [], undatedEventIds: ['old-event', 'new-event', 'older-sibling'] };
  snapshot.diagnostics = { anomalyFloors: [
    { floorId: 'floor-old', assistantSeq: 2, messageIndex: 4, eventIds: ['old-event'], reasons: ['旧关联缺失'] },
    { floorId: 'floor-new', assistantSeq: 9, messageIndex: 18, eventIds: ['older-sibling', 'new-event'], reasons: ['新关联缺失'] },
  ] };
  const h = harness({ initialSnapshot: snapshot });
  byText(h.container, '处理异常').fire('click'); await tick();
  const sections = flatten(h.dialogContent()).filter(node => node.className === 'qqj-qianshi-anomaly-floor');
  assert.deepEqual(sections.map(section => section.dataset.floorId), ['floor-new', 'floor-old'], '异常楼使用 assistantSeq 倒序，不以聊天楼号冒充剧情时间');
  for (const section of sections) { section.open = true; section.fire('toggle'); }
  assert.deepEqual(flatten(sections[0]).filter(node => node.className === 'qqj-qianshi-event').map(node => node.dataset.eventId),
    ['older-sibling', 'new-event'], '同一来源楼事件并列时按既有记录顺序倒序');
});

test('日期折叠默认只展开最近可靠日，手动状态跨快照和排序保留', () => {
  const h = harness(), days = () => flatten(h.container).filter(node => node.className.split(/\s+/u).includes('qqj-qianshi-day') && node.tag === 'div');
  const day = id => days().find(node => node.id === id), disclosure = target => flatten(target).find(node => node.className === 'qqj-qianshi-day-disclosure'), stableDay = () => days().find(node => node.dataset.dayStateId === '["gregorian",["2026年7月","1日"]]');
  const userToggle = target => {
    flatten(target).find(node => node.className === 'qqj-qianshi-day-summary').fire('click', { isTrusted: true });
    disclosure(target).open = !disclosure(target).open; disclosure(target).fire('toggle');
  };
  assert.equal(disclosure(day('day-7')).open, true);
  assert.equal(days().filter(node => disclosure(node).open).length, 1);
  assert.equal(day('day-7').children[0].className, 'qqj-qianshi-day-disclosure');
  assert.ok(day('day-7').className.includes('qqj-qianshi-day-first'), '可见日期段首点单独标记');
  assert.ok(day('day-1').className.includes('qqj-qianshi-day-last'), '可见日期段末点单独标记');
  assert.equal(day('day-7').children[1].className, 'qqj-qianshi-dot');
  assert.equal(day('day-7').children[2].className, 'qqj-qianshi-day-preview');
  assert.equal(day('day-7').children[3].className, 'qqj-qianshi-events');
  assert.equal(day('day-7').children[1].hidden, false, '展开时轴点可见');
  assert.equal(day('day-7').children[2].hidden, true, '展开列表时静态预览隐藏');
  assert.equal(day('day-7').children[3].hidden, false, '展开时事件列表可见');
  assert.equal(day('day-1').children[1].hidden, false, '折叠时轴点仍可见');
  assert.equal(day('day-1').children[2].hidden, false, '折叠时显示静态预览');
  assert.equal(day('day-1').children[3].hidden, true, '折叠时完整事件列表隐藏');
  assert.equal(flatten(day('day-1')).find(node => node.className === 'qqj-qianshi-day-count').textContent, '1 件');
  userToggle(day('day-1'));
  const scroller = new Node(); scroller.scrollTop = 42; h.container.parentElement = scroller;
  h.documentRef.activeElement = flatten(day('day-1')).find(node => node.className === 'qqj-qianshi-day-summary');
  const next = h.runtime.getQianshiSnapshot();
  next.timeline.segments[0].groups[0].id = 'shifted-day-id';
  next.timeline.segments[0].groups.unshift({ id: 'new-unstable-id', day: '0日', period: '2026年6月', full: '2026-06-30', eventIds: ['new-event'] });
  next.events.push({ id: 'new-event', matterId: null, title: '新旧间新增', description: '后来增加的日期', status: 'occurred', storyTime: '2026-06-30', people: [] });
  h.emit(next);
  assert.equal(disclosure(stableDay()).open, true, '已有日期的语义键不因前方新增组或原组 ID 变化而漂移');
  assert.equal(scroller.scrollTop, 42, '后台快照重绘保留外层滚动位置');
  const restoredSummary = flatten(stableDay()).find(node => node.className === 'qqj-qianshi-day-summary');
  assert.equal(restoredSummary.focused, true, '后台重绘后键盘焦点留在同一日期标题');
  assert.equal(restoredSummary.focusOptions.preventScroll, true, '恢复焦点时要求浏览器不要滚动页面');
  assert.equal(disclosure(stableDay()).open, true, '排序重绘保留手动展开');
  assert.equal(disclosure(day('day-7')).open, true, '默认组状态也继续展开');
});

test('折叠预览取当天事件权威顺序末条，不跟随页面排序或复制菜单', () => {
  const snapshot = fixture();
  snapshot.events = snapshot.events.slice(0, 2);
  snapshot.events[0] = { ...snapshot.events[0], id: 'earlier', title: '较早事件', description: '较早说明', storyTime: '2026-07-01 08:00', status: 'planned' };
  snapshot.events[1] = { ...snapshot.events[1], id: 'latest', title: '当天最后事件', description: '当天最后的短说明', storyTime: '2026-07-01 21:30', status: 'completed' };
  snapshot.timeline = { hasGlobalLatest: true, globalLatestGroupId: 'same-day', segments: [{ id: 'gregorian', latestGroupId: 'same-day', groups: [
    { id: 'same-day', day: '1日', period: '2026年7月', full: '2026年7月1日', eventIds: ['earlier', 'latest'] },
  ] }], undatedEventIds: [] };
  const h = harness({ initialSnapshot: snapshot });
  const day = () => flatten(h.container).find(node => node.className.includes('qqj-qianshi-day') && node.id === 'same-day');
  assert.ok(day().className.includes('qqj-qianshi-day-single'), '单日时间段不画悬空纵线');
  assert.equal(flatten(day()).filter(node => node.className === 'qqj-qianshi-dot').length, 1, '单日仍由自身唯一日期点表示');
  const collapse = () => {
    const disclosure = flatten(day()).find(node => node.className === 'qqj-qianshi-day-disclosure');
    flatten(day()).find(node => node.className === 'qqj-qianshi-day-summary').fire('click', { isTrusted: true });
    disclosure.open = false; disclosure.fire('toggle');
  };
  collapse();
  const preview = flatten(day()).find(node => node.className === 'qqj-qianshi-day-preview');
  assert.match(copy(preview), /2026-07-01 21:30.*当天最后事件.*已完成.*当天最后的短说明/u);
  assert.doesNotMatch(copy(preview), /较早事件/u);
  assert.equal(flatten(preview).some(node => node.className.includes('qqj-qianshi-event-menu')), false, '预览不创建第二份编辑菜单');
  assert.equal(visibleEventMenus(day()).length, 0, '折叠状态不显示完整事件菜单');
  const restoredPreview = flatten(day()).find(node => node.className === 'qqj-qianshi-day-preview');
  assert.match(copy(restoredPreview), /当天最后事件/u, '固定最近在前仍以权威末条作为预览');
  const disclosure = flatten(day()).find(node => node.className === 'qqj-qianshi-day-disclosure');
  flatten(day()).find(node => node.className === 'qqj-qianshi-day-summary').fire('click', { isTrusted: true });
  disclosure.open = true; disclosure.fire('toggle');
  assert.equal(flatten(day()).find(node => node.className === 'qqj-qianshi-day-preview').hidden, true, '展开列表时隐藏静态预览');
  assert.deepEqual(flatten(day()).filter(node => node.className === 'qqj-qianshi-event').map(node => node.dataset.eventId), ['latest', 'earlier'], '同日每条正式事件直接按最近优先出现');
  assert.equal(visibleEventMenus(day()).length, 2, '每条事件只显示自身编辑入口');
});

test('搜索临时展开命中旧日，异步 toggle 不污染手动状态，清空后恢复原状态', async () => {
  const h = harness();
  const day = id => flatten(h.container).find(node => node.className.split(/\s+/u).includes('qqj-qianshi-day') && node.tag === 'div' && node.id === id);
  const disclosure = target => flatten(target).find(node => node.className === 'qqj-qianshi-day-disclosure');
  const userToggle = target => {
    flatten(target).find(node => node.className === 'qqj-qianshi-day-summary').fire('click', { isTrusted: true });
    disclosure(target).open = !disclosure(target).open; disclosure(target).fire('toggle');
  };
  userToggle(day('day-1')); userToggle(day('day-1'));
  const input = flatten(h.container).find(node => node.className.includes('qqj-history-search-input'));
  input.value = '取得旧信'; input.fire('input', { target: input });
  assert.equal(disclosure(day('day-1')).open, true, '搜索命中的旧日期临时展开');
  await new Promise(resolve => setImmediate(() => { disclosure(day('day-1')).fire('toggle'); resolve(); }));
  assert.equal(day('day-7'), undefined, '无命中的日期从当前搜索结果中隐藏');
  assert.match(copy(h.container), /待补 2 楼/u, '顶部待补状态不受折叠影响');
  input.value = ''; input.fire('input', { target: input });
  assert.equal(disclosure(day('day-1')).open, false, '清空搜索恢复用户原先的收起状态');
  assert.equal(disclosure(day('day-7')).open, true, '默认展开状态仍在');
});

test('无年份跨年歧义按当前屏上首组默认展开，无日期桶可浏览', () => {
  const snapshot = fixture();
  snapshot.events = [
    { id: 'dec', matterId: null, title: '年末事件', description: '只有月日', status: 'occurred', storyTime: '12月31日', people: [] },
    { id: 'jan', matterId: null, title: '年初事件', description: '只有月日', status: 'occurred', storyTime: '1月1日', people: [] },
    { id: 'unknown', matterId: null, title: '无日期回忆', description: '仍可浏览', status: 'occurred', storyTime: null, people: [] },
  ];
  snapshot.matters = []; snapshot.timeline = projectQianshiTimeline({ events: snapshot.events, relations: [] });
  const h = harness({ initialSnapshot: snapshot });
  const dated = flatten(h.container).filter(node => node.tag === 'div' && node.className.split(/\s+/u).includes('qqj-qianshi-day'));
  assert.equal(dated.length, 2);
  assert.equal(flatten(dated[0]).find(node => node.className === 'qqj-qianshi-day-disclosure').open, true, '歧义时选择现有屏上顺序的首组');
  assert.equal(flatten(dated[1]).find(node => node.className === 'qqj-qianshi-day-disclosure').open, false);
  const undated = flatten(h.container).find(node => node.className === 'qqj-qianshi-undated');
  assert.ok(undated, '无日期分组仍存在');
  undated.open = true; undated.fire('toggle');
  assert.match(copy(undated), /无日期回忆/u);
});

test('未定时间分组记住手动开合，编辑时自动展开并在搜索后恢复', () => {
  const snapshot = fixture();
  snapshot.events = [{ id: 'undated-edit', matterId: null, title: '未定时间事件', description: '等待编辑的经过', status: 'occurred',
    storyTime: '18:00左右', scheduledTime: null, people: [], object: null, sourceFloorMemoryId: 'memory-undated' }];
  snapshot.timeline = projectQianshiTimeline({ events: snapshot.events, relations: [] });
  const h = harness({ initialSnapshot: snapshot });
  let disclosure = flatten(h.container).find(node => node.className === 'qqj-qianshi-undated');
  assert.equal(disclosure.open, false);
  const summary = disclosure.children.find(node => node.tag === 'summary');
  summary.fire('click', { isTrusted: true }); disclosure.open = true; h.emit();
  disclosure = flatten(h.container).find(node => node.className === 'qqj-qianshi-undated');
  assert.equal(disclosure.open, true, '重绘保留手动展开');
  const event = flatten(disclosure).find(node => node.dataset.eventId === 'undated-edit');
  const menu = flatten(event.parent).find(node => node.className.includes('qqj-qianshi-event-menu'));
  byText(menu, '编辑详情').fire('click');
  disclosure = flatten(h.container).find(node => node.className === 'qqj-qianshi-undated');
  assert.equal(disclosure.open, true, '点击编辑后外层未定分组保持展开');
  assert.equal(flatten(disclosure).some(node => node.className.split(/\s+/u).includes('qqj-qianshi-text-form')), false, '编辑表单不嵌在时间线列表里');
  assert.ok(flatten(h.editor()).some(node => node.className.split(/\s+/u).includes('qqj-qianshi-text-form')), '弹窗内容含编辑表单');

  const input = flatten(h.container).find(node => node.className.includes('qqj-history-search-input'));
  input.value = '未定时间事件'; input.fire('input', { target: input, isTrusted: true });
  assert.equal(flatten(h.container).find(node => node.className === 'qqj-qianshi-undated').open, true, '搜索时临时展开');
  const clear = flatten(h.container).find(node => node.className.includes('qqj-history-search-clear'));
  clear.fire('click');
  assert.equal(flatten(h.container).find(node => node.className === 'qqj-qianshi-undated').open, true, '清空搜索恢复先前展开状态');

  const collapsed = flatten(h.container).find(node => node.className === 'qqj-qianshi-undated');
  collapsed.children.find(node => node.tag === 'summary').fire('click', { isTrusted: true }); collapsed.open = false; h.emit();
  assert.equal(flatten(h.container).find(node => node.className === 'qqj-qianshi-undated').open, false, '手动收起在重绘后保留');
});

test('数百未定事件仅在展开时建卡，收起释放菜单但保留编辑草稿', () => {
  const snapshot = fixture();
  snapshot.events = Array.from({ length: 240 }, (_, index) => ({ id: `undated-${index}`, matterId: null,
    title: `未定事件 ${index}`, description: `原始说明 ${index}`, status: 'occurred', storyTime: null, people: [], sourceFloorMemoryId: `memory-${index}` }));
  snapshot.matters = []; snapshot.timeline = projectQianshiTimeline({ events: snapshot.events, relations: [] });
  let permissionChecks = 0;
  const h = harness({ initialSnapshot: snapshot, canEdit: () => { permissionChecks += 1; return true; } });
  const details = () => flatten(h.container).find(node => node.className === 'qqj-qianshi-undated');
  const summary = () => details().children.find(node => node.tag === 'summary');
  assert.equal(flatten(details()).filter(node => node.className === 'qqj-qianshi-event').length, 0, '默认收起不创建事件卡');
  assert.equal(permissionChecks, 0, '收起不逐事件查询操作权限');

  summary().fire('click', { isTrusted: true }); details().open = true; details().fire('toggle');
  assert.equal(flatten(details()).filter(node => node.className === 'qqj-qianshi-event').length, 240);
  let firstMenu = flatten(details()).find(node => node.className.includes('qqj-qianshi-event-menu'));
  byText(firstMenu, '编辑详情').fire('click');
  assert.ok(flatten(h.editor()).some(node => node.className.split(/\s+/u).includes('qqj-qianshi-text-form')), '打开的编辑草稿正常显示');
  let staleMenuVisits = 0;
  const oldMenus = flatten(details()).filter(node => node.className.includes('qqj-qianshi-event-menu'));
  for (const menu of oldMenus) {
    menu.open = true;
    const contains = menu.contains.bind(menu);
    menu.contains = value => { staleMenuVisits += 1; return contains(value); };
  }
  const current = details(); current.children.find(node => node.tag === 'summary').fire('click', { isTrusted: true }); current.open = false; current.fire('toggle');
  assert.equal(flatten(details()).filter(node => node.className === 'qqj-qianshi-event').length, 0, '收起移除事件卡 DOM');
  h.documentRef.fire('click', { target: new Node('button'), composedPath: () => [] });
  assert.equal(staleMenuVisits, 0, '文档点击不再访问已移除的菜单');

  const reopened = details(); reopened.children.find(node => node.tag === 'summary').fire('click', { isTrusted: true }); reopened.open = true; reopened.fire('toggle');
  assert.equal(flatten(details()).filter(node => node.className === 'qqj-qianshi-event').length, 240, '再次展开从原事件重建卡片');
  assert.ok(flatten(h.editor()).some(node => node.className.split(/\s+/u).includes('qqj-qianshi-text-form')), '未提交的编辑草稿仍保留');
  assert.equal(permissionChecks, 240, '权限只在首次实际构建卡片时查询');
});

test('日期分组收起时也注销已移除事件菜单', () => {
  const snapshot = fixture();
  snapshot.events = [{ ...snapshot.events[0], id: 'day-menu', title: '当天事件', storyTime: '2026-07-01 10:00' }];
  snapshot.timeline = { hasGlobalLatest: true, globalLatestGroupId: 'only-day', segments: [{ id: 'gregorian', label: '公历', latestGroupId: 'only-day', groups: [
    { id: 'only-day', day: '1日', period: '2026年7月', full: '2026年7月1日', eventIds: ['day-menu'] },
  ] }], undatedEventIds: [] };
  const h = harness({ initialSnapshot: snapshot });
  const day = flatten(h.container).find(node => node.className.split(/\s+/u).includes('qqj-qianshi-day') && node.tag === 'div');
  const disclosure = flatten(day).find(node => node.className === 'qqj-qianshi-day-disclosure');
  const menu = flatten(day).find(node => node.className.includes('qqj-qianshi-event-menu'));
  assert.ok(menu);
  let visits = 0; menu.open = true;
  const contains = menu.contains.bind(menu); menu.contains = value => { visits += 1; return contains(value); };
  disclosure.open = false; disclosure.fire('toggle');
  assert.equal(flatten(day).filter(node => node.className === 'qqj-qianshi-event').length, 0);
  h.documentRef.fire('click', { target: new Node('button'), composedPath: () => [] });
  assert.equal(visits, 0, '文档点击跳过日期组已移除菜单');
});

test('同日新增更早事件改变展示全文时，稳定日期键仍保留手动折叠', () => {
  const snapshot = fixture();
  snapshot.events = [
    { id: 'later', matterId: null, title: '较晚事件', description: '后来发生', status: 'occurred', storyTime: '公历2010年11月3日 12:34:56', people: [] },
    { id: 'other-day', matterId: null, title: '另一日事件', description: '另一天', status: 'occurred', storyTime: '公历2010年11月2日', people: [] },
  ];
  snapshot.matters = []; snapshot.timeline = projectQianshiTimeline({ events: snapshot.events, relations: [] });
  const h = harness({ initialSnapshot: snapshot });
  const day = () => flatten(h.container).find(node => node.className.split(/\s+/u).includes('qqj-qianshi-day') && node.id === snapshot.timeline.segments[0].groups.find(group => group.period === '2010年11月' && group.day === '3日').id);
  const disclosure = () => flatten(day()).find(node => node.className === 'qqj-qianshi-day-disclosure');
  const oldFull = snapshot.timeline.segments[0].groups.find(group => group.day === '3日').full;
  const oldKey = day().dataset.dayStateId;
  const summary = flatten(day()).find(node => node.className === 'qqj-qianshi-day-summary');
  summary.fire('click', { isTrusted: true }); disclosure().open = false; disclosure().fire('toggle');
  const next = h.runtime.getQianshiSnapshot();
  next.events.unshift({ id: 'earlier', matterId: null, title: '新补入的更早事件', description: '同一天更早发生', status: 'occurred', storyTime: '公历2010年11月3日 08:00:00', people: [] });
  next.timeline = projectQianshiTimeline({ events: next.events, relations: [] });
  const newGroup = next.timeline.segments[0].groups.find(group => group.day === '3日');
  assert.notEqual(newGroup.full, oldFull, '首个事件变化会改变展示用完整原文');
  assert.equal(newGroup.key, snapshot.timeline.segments[0].groups.find(group => group.day === '3日').key, '投影提供稳定日期语义键');
  h.emit(next);
  const rebuilt = flatten(h.container).find(node => node.dataset.dayStateId === oldKey);
  assert.equal(flatten(rebuilt).find(node => node.className === 'qqj-qianshi-day-disclosure').open, false, '同日事件变更不覆盖手动收起状态');
});

test('默认展开产生的异步原生 toggle 不会记成用户手动状态', async () => {
  const h = harness(), day = id => flatten(h.container).find(node => node.tag === 'div' && node.className.split(/\s+/u).includes('qqj-qianshi-day') && node.id === id);
  const disclosure = target => flatten(target).find(node => node.className === 'qqj-qianshi-day-disclosure');
  await new Promise(resolve => setImmediate(() => { disclosure(day('day-7')).fire('toggle'); resolve(); }));
  const next = h.runtime.getQianshiSnapshot();
  next.timeline.globalLatestGroupId = 'day-6'; next.timeline.segments[0].latestGroupId = 'day-6';
  h.emit(next);
  assert.equal(disclosure(day('day-7')).open, false, '初次默认打开产生的异步通知没有固化旧默认值');
  assert.equal(disclosure(day('day-6')).open, true, '新快照的可靠最近日成为默认展开组');
  assert.equal(flatten(h.container).filter(node => node.className === 'qqj-qianshi-day-disclosure' && node.open).length, 1);
});

test('状态胶囊显示本条动作状态，已发生不伪装成完成', () => {
  const snapshot = fixture(), statuses = ['planned', 'inProgress', 'completed', 'cancelled', 'occurred', 'unknown'];
  snapshot.events = snapshot.events.slice(0, statuses.length).map((event, index) => ({ ...event, id: `status-${index}`, matterId: null, status: statuses[index] }));
  snapshot.timeline.segments[0].groups = snapshot.events.map((event, index) => ({ id: `status-day-${index}`, day: `${index + 1}日`, period: '状态历', full: event.storyTime, eventIds: [event.id] }));
  snapshot.timeline.segments[0].latestGroupId = 'status-day-5'; snapshot.timeline.undatedEventIds = [];
  const h = harness({ initialSnapshot: snapshot });
  for (const group of snapshot.timeline.segments[0].groups) {
    const day = flatten(h.container).find(node => node.id === group.id && node.className.includes('qqj-qianshi-day'));
    const disclosure = flatten(day).find(node => node.className === 'qqj-qianshi-day-disclosure');
    if (!disclosure.open) { flatten(day).find(node => node.className === 'qqj-qianshi-day-summary').fire('click', { isTrusted: true }); disclosure.open = true; disclosure.fire('toggle'); }
  }
  const badges = flatten(h.container).filter(node => node.className.includes('qqj-qianshi-state')
    && !Array.from((function* () { for (let parent = node.parent; parent; parent = parent.parent) yield parent; })()).some(parent => parent.className === 'qqj-qianshi-day-preview'));
  assert.deepEqual(badges.map(node => node.textContent), ['状态未明', '已发生', '已取消', '已完成', '进行中', '待办']);
  assert.deepEqual(badges.map(node => node.attributes['aria-label']), ['本条动作状态：状态未明', '本条动作状态：已发生', '本条动作状态：已取消', '本条动作状态：已完成', '本条动作状态：进行中', '本条动作状态：待办']);
});

test('同日事件分别保留动作状态与整线状态来源', () => {
  const snapshot = fixture();
  snapshot.events[0] = { ...snapshot.events[0], storyTime: '2026-07-01 09:00', status: 'planned', updatesMatter: false };
  snapshot.events[1] = { ...snapshot.events[1], storyTime: '2026-07-01 10:00', status: 'completed', updatesMatter: true };
  snapshot.matters[0].status = 'completed';
  snapshot.timeline.segments[0].groups[0] = { ...snapshot.timeline.segments[0].groups[0], eventIds: ['event-1', 'event-2'] };
  const h = harness({ initialSnapshot: snapshot });
  const earlier = h.eventCard('event-1');
  const summary = flatten(earlier).find(node => node.tag === 'summary');
  assert.ok(flatten(summary).some(node => node.className.includes('qqj-qianshi-state') && node.textContent === '待办'), '本事件动作状态徽标保留');
  earlier.open = true; earlier.fire('toggle');
  const detail = flatten(earlier).find(node => node.className === 'qqj-qianshi-event-detail');
  const labels = flatten(detail).filter(node => node.tag === 'dt');
  const statusIndex = labels.findIndex(node => node.textContent === '本条动作状态');
  assert.notEqual(statusIndex, -1, '展开详情区分本条动作状态');
  const meta = flatten(detail).find(node => node.className === 'qqj-qianshi-meta');
  const statusDt = meta.children.findIndex(node => node.tag === 'dt' && node.textContent === '本条动作状态');
  assert.equal(meta.children[statusDt + 1].textContent, '已计划 / 尚未记录完成');
  assert.equal(snapshot.events[0].status, 'planned', '事项当前已完成不回写旧事件状态');
});

test('旧快照即使带 important 也不会在时间线显示标记或颜色', () => {
  const grouped = fixture(); grouped.events[0].important = true;
  grouped.timeline.segments[0].groups = [
    { ...grouped.timeline.segments[0].groups[0], eventIds: ['event-1', 'event-2', 'event-3'] },
    ...grouped.timeline.segments[0].groups.slice(3),
  ];
  const h = harness({ initialSnapshot: grouped });
  const card = h.eventCard('event-1');
  assert.equal(card.className.includes('important'), false);
  assert.doesNotMatch(copy(card), /标为重要|取消重要|重要：|含重要事件/u);
  assert.deepEqual(h.calls(), { prepareCalls: 0, startCalls: 0 });
});

test('千事时间线不再接收 settings，也不创建任何重要操作按钮', () => {
  const grouped = fixture();
  grouped.timeline.segments[0].groups = [
    { ...grouped.timeline.segments[0].groups[0], eventIds: ['event-1', 'event-2', 'event-3'] },
    ...grouped.timeline.segments[0].groups.slice(3),
  ];
  const runtime = { getState: () => ({}), getQianshiSnapshot: () => grouped, subscribe: () => () => {}, prepareQianshiHistory: async () => ({}), startQianshiHistory: async () => ({}), stopQianshiHistory: async () => ({}), canEditQianshiEventText: () => false, editQianshiEventText: async () => ({}) };
  const documentRef = { createElement: tag => new Node(tag) };
  const view = createQianshiTimelineView({ runtime, documentRef });
  const container = new Node('main'); view.mount(container);
  assert.equal(flatten(container).some(node => node.tag === 'button' && /重要/u.test(node.textContent)), false);
  assert.doesNotMatch(copy(container), /重要/u);
});

test('搬家前千事事件显示来源聊天且只读，B 的新进展仍保留操作', () => {
  const initialSnapshot = fixture();
  initialSnapshot.events[0] = { ...initialSnapshot.events[0], frozen: true,
    sourceOrigin: { sourceMessageIndex: 1, sourceChatId: 'source-chat' } };
  const view = harness({ initialSnapshot, canEdit: id => id !== 'event-1' });
  const old = view.eventCard('event-1');
  old.open = true; old.fire('toggle');
  assert.match(copy(old), /来源聊天第 1 楼/u);
  assert.match(copy(old), /来源于搬家前存档，只读/u);
  assert.equal(view.eventMenu('event-1'), undefined, '冻结事件不显示编辑、删除、改状态菜单');
  assert.ok(view.eventMenu('event-2'), 'B 的后续进展仍可按原合同操作');
});

test('重要事件颜色和按钮样式已从千事 CSS 移除', () => {
  const css = readFileSync(new URL('../src/ui/panel.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /qqj-qianshi-(?:important|importance)|qqj-qianshi-event\.important|qqj-qianshi-matter-event\.important/u);
});

test('未知日期和跨日事项详情保留普通展开交互且不含重要按钮', () => {
  const h = harness();
  const undatedGroup = flatten(h.container).find(node => node.className === 'qqj-qianshi-undated');
  undatedGroup.open = true; undatedGroup.fire('toggle');
  const undated = h.eventCard('undated');
  undated.open = true; undated.fire('toggle');
  assert.doesNotMatch(copy(undated), /标为重要|取消重要/u);

  const first = h.eventCard('event-1'); first.open = true; first.fire('toggle');
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
  const date = flatten(day).find(node => node.className === 'qqj-qianshi-date');
  const dayName = flatten(date).find(node => node.className === 'qqj-qianshi-day-name');
  assert.equal(dayName.textContent.length, 3, '43px日期栏中的 nowrap 主字只占短日标签');
  assert.equal(date.title, '大陆历1686年9月22日 20:30 星期三', '完整日期仍可通过悬停查看');
});

test('搜索与后台通知保留展开状态，打开和浏览不会规划或启动历史模型任务', () => {
  const h = harness();
  const input = flatten(h.container).find(node => node.tag === 'input'); input.value = '沈棠'; input.fire('input', { target: { value: '沈棠', selectionStart: 2 } });
  assert.equal(flatten(h.container).find(node => node.tag === 'input').focused, true, '搜索重绘结果后保持输入焦点');
  assert.match(copy(h.container), /匹配 1 件事件 · 显示 1 条.*取得旧信/u);
  assert.equal(flatten(h.container).filter(node => node.dataset.eventId).length, 1, '搜索只保留命中的顶层事件，事项经过仍可完整查看');
  const matched = h.eventCard('event-1'); matched.open = true; matched.fire('toggle');
  byText(h.container, '清除').fire('click');
  assert.equal(flatten(h.container).some(node => node.className === 'qqj-qianshi-event' && node.dataset.eventId === 'event-1'), false, '清空搜索后旧日折叠并释放命中卡片');
  const oldDay = flatten(h.container).find(node => node.id === 'day-1');
  const oldDisclosure = flatten(oldDay).find(node => node.className === 'qqj-qianshi-day-disclosure');
  flatten(oldDay).find(node => node.className === 'qqj-qianshi-day-summary').fire('click', { isTrusted: true });
  oldDisclosure.open = true; oldDisclosure.fire('toggle');
  assert.equal(flatten(h.container).find(node => node.dataset.eventId === 'event-1').open, true, '事件详情状态在日期折叠期间保留');
  assert.equal(flatten(h.container).find(node => node.className === 'qqj-qianshi-undated').open, false, '清空搜索后时间未明外层恢复默认收起');
  h.emit();
  assert.equal(h.eventCard('event-1').open, true);
  assert.deepEqual(h.calls(), { prepareCalls: 0, startCalls: 0 });
});

test('历史补齐先展示真实计划，取消零调用模型，确认后才启动', async () => {
  const cancelled = harness({ confirm: false }); byText(cancelled.container, '补齐旧楼').fire('click'); await tick();
  assert.deepEqual(cancelled.calls(), { prepareCalls: 1, startCalls: 0 });
  assert.match(cancelled.confirms[0].body, /2 楼.*1 批.*1 次.*900 token/u);
  assert.match(cancelled.confirms[0].body, /2 楼进入模型补齐/u);
  assert.match(cancelled.confirms[0].note, /确认后才调用 API.*取消不调用模型或写入/u);
  assert.match(copy(cancelled.container), /已取消；没有调用模型/u);
  const confirmed = harness({ confirm: true }); byText(confirmed.container, '补齐旧楼').fire('click'); await tick(); await tick();
  assert.deepEqual(confirmed.calls(), { prepareCalls: 1, startCalls: 1 });
});

test('已存千事有独立重判入口，按用户楼号预览，取消不启动请求', async () => {
  const cancelled = harness({ confirm: false, promptValues: ['12~18'] });
  byText(cancelled.container, '整理').fire('click');
  await tick(); await tick(); await tick(); await tick();
  assert.deepEqual(cancelled.rejudgeCalls(), { prepareCalls: 1, startCalls: 0, range: { fromMessageIndex: 12, toMessageIndex: 18 } });
  const preview = cancelled.confirms.find(value => value.title === '确认重判已存千事');
  assert.match(preview.body, /第 12–18 楼/u);
  assert.match(preview.body, /2 个 AI 楼、3 条旧记录/u);
  assert.match(preview.note, /只重判千事的归线和状态/u);
  assert.match(copy(cancelled.container), /已取消；没有调用模型或写入/u);
  assert.equal(cancelled.confirms.filter(value => value.title === '重新整理已存千事').length, 1, '只询问一次范围');
  assert.equal(cancelled.confirms.length, 2, '一次输入直接进入预览确认');

  const confirmed = harness({ confirm: true, promptValues: [' 12 ～ 18 '] });
  byText(confirmed.container, '整理').fire('click');
  await tick(); await tick(); await tick(); await tick();
  assert.equal(confirmed.rejudgeCalls().startCalls, 1, '仅确认后启动重判请求');
  assert.deepEqual(confirmed.rejudgeCalls().range, { fromMessageIndex: 12, toMessageIndex: 18 });
  assert.equal(confirmed.calls().startCalls, 0, '新入口不调用旧补齐计划');
});

test('重判进度和保存结果接管启动提示，不同时显示未来暂存与已提交', async () => {
  const h = harness({ confirm: true });
  byText(h.container, '整理').fire('click'); await tick(); await tick();
  assert.match(copy(h.container), /已暂存 0\/0 楼/u);
  assert.equal(h.container.querySelector('.qqj-qianshi-feedback'), null, '真实进度到达后移除启动提示');
  const snapshot = fixture();
  snapshot.history = { mode: 'rejudge', status: 'running', committing: true, processedFloors: 2, totalFloors: 2 };
  h.emit(snapshot);
  assert.match(copy(h.container), /整组正在提交/u);
  assert.doesNotMatch(copy(h.container), /正在启动|结果将先暂存/u);
  snapshot.history = { ...snapshot.history, status: 'partial', committing: false, message: '千事重判完成；整组已一次提交。', commitStatus: 'saved', savedFloors: 1, savedCompleteFloors: 0, savedPartialFloors: 1, totalFloors: 1, processedFloors: 1, outcomes: [{ status: 'saved-partial', reasonCode: 'QIANSHI_REJUDGE_PARTIAL', messageIndex: 0, assistantSeq: 9, message: '本楼部分记录已保存。' }] };
  h.emit(snapshot);
  assert.match(copy(h.container), /千事重判完成；整组已一次提交/u);
  assert.doesNotMatch(copy(h.container), /整组正在提交|正在启动|结果将先暂存/u);
  assert.match(copy(h.container), /已确认保存 1\/1 楼/u);
  assert.match(copy(h.container), /第 0 楼：本楼部分记录已保存/u, 'display messageIndex 0 takes precedence over assistantSeq');
});

test('直接收到重判终态也清除启动提示，并保留成功、失败或取消的实际结果', async () => {
  for (const status of ['completed', 'partial', 'failed', 'stopped']) {
    const message = status === 'completed' ? '整组已保存。' : status === 'partial' ? '已保存；1 楼部分通过。'
      : status === 'failed' ? '请求超时；原千事保持不变。' : '已取消；原千事保持不变。';
    const h = harness({ confirm: true, rejudgeStartResult: { status, message } });
    byText(h.container, '整理').fire('click'); await tick(); await tick();
    assert.ok(copy(h.container).includes(message));
    assert.equal(h.container.querySelector('.qqj-qianshi-feedback'), null);
  }
});

test('数百楼重判预览只显示首尾和计数，提示长度不随楼数增长', async () => {
  const h = harness({ plan: { totalFloors: 300, apiCalls: 300,
    floors: Array.from({ length: 300 }, (_, i) => ({ assistantSeq: i + 1, messageIndex: i * 2, recordCount: 2 })) } });
  byText(h.container, '整理').fire('click'); await tick(); await tick();
  const preview = h.confirms.find(value => value.title === '确认重判已存千事');
  assert.match(preview.body, /第 0–598 楼.*300 个 AI 楼、600 条旧记录.*API 300 次/u);
  assert.ok(preview.body.length < 100, '范围再长也不逐楼列举');
  assert.match(preview.note, /人工修订.*提交前取消或失败不改原档/u);
  assert.equal(h.rejudgeCalls().startCalls, 0);
});

test('千事重判单次输入支持全部、范围和取消，错误格式不启动', async () => {
  for (const input of ['0', '  ', '0~']) {
    const h = harness({ promptValues: [input] });
    byText(h.container, '整理').fire('click');
    await tick(); await tick(); await tick(); await tick();
    assert.deepEqual(h.rejudgeCalls(), { prepareCalls: 1, startCalls: 0, range: { fromMessageIndex: 0, toMessageIndex: null } });
    assert.match(h.confirms.find(value => value.title === '重新整理已存千事').body, /当前最新为第 30 楼/u);
  }
  const zero = harness({ promptValues: ['0~0'] });
  byText(zero.container, '整理').fire('click');
  await tick(); await tick(); await tick(); await tick();
  assert.deepEqual(zero.rejudgeCalls().range, { fromMessageIndex: 0, toMessageIndex: 0 });
  const cancelled = harness({ promptValues: [null] });
  byText(cancelled.container, '整理').fire('click');
  await tick(); await tick(); await tick(); await tick();
  assert.equal(cancelled.rejudgeCalls().prepareCalls, 0);
  assert.equal(cancelled.rejudgeCalls().startCalls, 0);
  for (const input of ['abc', '12~~18']) {
    const invalid = harness({ promptValues: [input] });
    byText(invalid.container, '整理').fire('click');
    await tick(); await tick();
    assert.equal(invalid.rejudgeCalls().prepareCalls, 0);
    assert.equal(invalid.rejudgeCalls().startCalls, 0);
    assert.match(copy(invalid.container), /请输入楼号范围/u);
  }
});

test('覆盖就绪时健康色为绿且隐藏补齐入口；已有在途任务仍显示停止', () => {
  const snapshot = fixture();
  snapshot.coverage.pendingFloors = 0;
  snapshot.coverage.partialFloors = 0;
  const h = harness({ initialSnapshot: snapshot });
  const coverage = flatten(h.container).find(node => node.className === 'qqj-qianshi-coverage ready');
  assert.ok(coverage, '完整覆盖沿用 ready 状态类');
  assert.equal(flatten(coverage).some(node => node.tag === 'button' && node.textContent === '补齐旧楼'), false);
  assert.deepEqual(h.calls(), { prepareCalls: 0, startCalls: 0 });

  const running = structuredClone(snapshot);
  running.history = { ...running.history, status: 'running' };
  h.emit(running, { status: 'ready', memoryWorkBusy: false, qianshiHistoryActive: true });
  assert.equal(byText(h.container, '停止')?.tag, 'button', '运行中的停止入口优先保留');
  assert.equal(byText(h.container, '补齐旧楼'), undefined);

  const css = readFileSync(new URL('../src/ui/panel.css', import.meta.url), 'utf8');
  assert.match(css, /\.qqj-qianshi-coverage\.ready\{border-left-color:var\(--success\);background:color-mix\(in srgb,var\(--success\) 5%,var\(--paper\)\)\}/u);
});

test('聚合楼从模型计划中跳过并说明原因，空计划与执行失败均有可见原因', async () => {
  const plan = { totalFloors: 1, batchCount: 1, apiCalls: 1, modelFloors: 1,
    aggregateSkippedFloors: [{ floorId: 'aggregate', assistantSeq: 10 }] };
  const confirmed = harness({ confirm: true, plan, startResult: { status: 'partial', message: '其中 1 楼未补齐。' } });
  byText(confirmed.container, '补齐旧楼').fire('click'); await tick(); await tick();
  assert.match(confirmed.confirms[0].body, /1 楼进入模型补齐.*跳过聚合记忆 1 楼/u);
  assert.match(copy(confirmed.container), /1 楼未补齐/u, '执行失败时 UI 显示失败事实');

  const emptySnapshot = fixture();
  const empty = harness({ initialSnapshot: emptySnapshot, plan: { status: 'empty', totalFloors: 0, batchCount: 0,
    apiCalls: 0, aggregateSkippedFloors: [{ floorId: 'aggregate', assistantSeq: 10 }] } });
  byText(empty.container, '补齐旧楼').fire('click'); await tick();
  assert.match(copy(empty.container), /由多个正文楼聚合.*跳过模型替换/u);
  assert.equal(empty.calls().startCalls, 0);
});

test('历史确认后仍检查现有 busy 状态，不与后台任务并行启动', async () => {
  let resolveSecond; const busy = harness({ confirm: () => new Promise(resolve => { resolveSecond = resolve; }) });
  byText(busy.container, '补齐旧楼').fire('click'); await tick();
  busy.emit(fixture(), { status: 'running', memoryWorkBusy: true, qianshiHistoryActive: false }); resolveSecond(true); await tick();
  assert.equal(busy.calls().startCalls, 0, '确认后复查现有 busy 语义，不和后台任务并行启动');
  assert.match(copy(busy.container), /后台任务状态已经变化/u);
});

test('历史批次部分失败时，在时间线中显示楼号和失败原因', () => {
  const snapshot = fixture();
  snapshot.history = { status: 'partial', message: '1 楼补齐失败。', processedFloors: 0, attemptedFloors: 1,
    savedCompleteFloors: 0, conflictFloors: 0, skippedFloors: 0, failedFloors: 1,
    outcomes: [{ floorId: 'floor-74', assistantSeq: 74, status: 'failed',
      reasonCode: 'QIANSHI_HISTORY_COMPILE_FAILED', message: '事件 1 的关系无法验证，本楼原档案保持不变。' }], pendingReviews: [] };
  const h = harness({ initialSnapshot: snapshot });
  assert.match(copy(h.container), /1 楼补齐失败/u);
  assert.match(copy(h.container), /AI 记录 74：事件 1 的关系无法验证，本楼原档案保持不变/u);
  assert.doesNotMatch(copy(h.container), /QIANSHI_|qianshi_|events\[|\bprogress\b|\bcontext\b|\bpartial\b|\bfloors\b|\btokens\b/u);
});

test('历史逐楼结果限高半屏、独立滚动并在进度更新保留节点、位置与焦点', () => {
  const snapshot = fixture();
  snapshot.history = { status: 'running', totalFloors: 20, calls: 1, attemptedFloors: 2, savedCompleteFloors: 1,
    conflictFloors: 1, skippedFloors: 0, failedFloors: 0,
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
  assert.equal(flatten(coverage).find(node => node.tag === 'button').textContent, '停止', '停止按钮留在滚动容器外');

  const css = readFileSync(new URL('../src/ui/panel.css', import.meta.url), 'utf8');
  assert.match(css, /\.qqj-qianshi-history-results\{[^}]*max-height:50vh;[^}]*overflow-y:auto/u);
  assert.match(css, /\.qqj-qianshi-history-results\{[^}]*overflow-wrap:anywhere/u, '长文本在窄屏允许换行');
  assert.match(css, /@media\(max-width:340px\)/u);
  assert.match(css, /\.qqj-qianshi-history-results\{grid-column:1\/-1\}/u, '窄屏仍跨满 coverage 网格');

  results.scrollTop = 76; h.documentRef.activeElement = results;
  h.emit({ ...snapshot, history: { ...snapshot.history, message: '进度更新' } });
  const updatedResults = h.container.querySelector('.qqj-qianshi-history-results');
  assert.notEqual(updatedResults, results, '只重建进度结果子区');
  assert.equal(updatedResults.scrollTop, 76, '同一聊天保留结果区内部位置');
  assert.equal(updatedResults.focused, true, '原结果区有焦点时保留焦点');

});

test('历史逐楼反馈保留中文原因与楼号，不显示内部错误码或状态枚举', () => {
  const snapshot = fixture();
  snapshot.history = { status: 'partial', message: '', processedFloors: 0, totalFloors: 7, calls: 3,
    attemptedFloors: 7, savedCompleteFloors: 0, conflictFloors: 3, skippedFloors: 1, failedFloors: 2,
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
  for (const seq of [56, 67, 82, 104, 134, 140, 141, 142, 143, 144]) assert.match(rendered, new RegExp(`AI 记录 ${seq}：`));
  assert.match(rendered, /AI 记录 134：.*部分结果状态未能保存：后端请求超时/u);
  assert.match(rendered, /AI 记录 144：完整请求估算 71000 token，超过 70000；未调用模型/u);
  assert.doesNotMatch(rendered, /QIANSHI_|qianshi_|BACKEND_TIMEOUT|events\[|\bprogress\b|\bcontext\b|\bpartial\b|\bfloors\b|\btokens\b/u);
});

test('恢复的历史结果缺少楼号时说明目标楼已变化，不伪造楼号', () => {
  const snapshot = fixture();
  snapshot.history = { status: 'partial', message: '', processedFloors: 0, totalFloors: 1, calls: 0,
    attemptedFloors: 1, savedCompleteFloors: 0, conflictFloors: 0, skippedFloors: 0, failedFloors: 1,
    outcomes: [{ floorId: 'deleted-floor', status: 'failed', reasonCode: 'QIANSHI_HISTORY_FLOOR_MISSING',
      message: '目标楼已变化，原记录保留。' }], pendingReviews: [] };
  const h = harness({ initialSnapshot: snapshot });
  const resultText = copy(h.container.querySelector('.qqj-qianshi-history-results'));
  assert.match(resultText, /目标楼：目标楼已变化，原记录保留。/u);
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

test('事件编辑索引复用快照，换档、删除和来源冲突后重新判断权限', () => {
  let builds = 0;
  const memo = createQianshiSnapshotMemo(source => { builds += 1; return { events: source.visibleIds.map(id => ({ id })) }; });
  const lookup = createQianshiEventLookup(source => memo(source, null, null));
  const memory = (id, eventIds, status = 'ready', recordStatus = 'active') => ({ id, recordStatus,
    qianshiDelta: { status, events: eventIds.map(id => ({ id })) } });
  const source = { visibleIds: ['a', 'duplicate', 'review', 'partial', 'inactive'], floorMemories: [
    memory('first', ['a', 'hidden', 'duplicate']), memory('second', ['duplicate']),
    memory('partial', ['partial'], 'partial'), memory('inactive', ['inactive'], 'ready', 'superseded'),
  ] };
  for (let index = 0; index < 100; index += 1) assert.equal(lookup('a', source).memory.id, 'first');
  assert.equal(builds, 1, '大量卡片查权限只计算一次快照');
  for (const id of ['hidden', 'duplicate', 'review', 'inactive', 'missing']) assert.equal(lookup(id, source), null);
  assert.equal(lookup('partial', source).memory.id, 'partial');
  const deleted = { ...source, visibleIds: source.visibleIds.filter(id => id !== 'a') };
  assert.equal(lookup('a', deleted), null, '删除后不能沿用旧权限');
  const otherChat = { visibleIds: ['a'], floorMemories: [memory('new-chat', ['a'])] };
  assert.equal(lookup('a', otherChat).memory.id, 'new-chat', '切档不能用前档来源');
  assert.equal(builds, 3);
});

test('首次 mount 后 activate 不重复渲染，无关通知跳过而进度和存档变化及时更新', async () => {
  const snapshot = fixture(); snapshot.projectionRevision = 1;
  let permissions = 0;
  const h = harness({ initialSnapshot: snapshot, canEdit: () => { permissions += 1; return true; } });
  const page = h.container.children[0], firstChecks = permissions;
  await h.view.activate();
  assert.equal(h.container.children[0], page);
  assert.equal(permissions, firstChecks);
  h.emit(snapshot, { status: 'ready', syncStatus: 'syncing' });
  assert.equal(h.container.children[0], page, '无关同步通知不重建页面');
  const progress = structuredClone(snapshot); progress.history = { status: 'running', totalFloors: 10, processedFloors: 2 };
  h.emit(progress);
  assert.equal(h.container.children[0], page, '进度通知保留页面与事件列表DOM');
  assert.match(copy(h.container), /已处理 2\/10 楼/u);
  assert.equal(permissions, firstChecks, '进度变了，但事件编辑权限继续复用');
  const changed = structuredClone(snapshot); changed.projectionRevision = 2; changed.events[0].title = '新的人工标题';
  h.emit(changed);
  assert.match(copy(h.container), /新的人工标题/u);
  assert.ok(permissions > firstChecks, '新存档重新判断可编辑来源');
  const prior = h.container.children[0]; h.view.deactivate(); await h.view.activate();
  assert.notEqual(h.container.children[0], prior, '重新激活仍读取当前状态');
});

test('旧快照的 historyReview 仅兼容读取，不恢复待审或结案入口', () => {
  const snapshot = fixture();
  snapshot.history.pendingReviews = [{ floorId: 'old-floor', events: [{ title: '旧候选' }] }];
  snapshot.history.persistedIssues = [{ floorId: 'old-floor', canAcceptCurrent: true, message: '旧审核状态' }];
  const h = harness({ initialSnapshot: snapshot });
  const rendered = copy(h.container);
  assert.doesNotMatch(rendered, /待审|结案|审核状态|相似旧条/u);
  assert.equal(flatten(h.container).some(node => /审阅|结案/u.test(node.textContent)), false);
});

test('正式事件删除确认取消零写，保存后卡片消失', async () => {
  for (const mode of ['cancel', 'save']) {
    let calls = 0, h;
    h = harness({ confirm: () => {
      return mode !== 'cancel';
    } });
    h.runtime.deleteQianshiEvent = async input => {
      calls += 1;
      assert.equal(input.expected.memoryId, 'memory-1');
      const next = h.runtime.getQianshiSnapshot(); next.events = next.events.filter(event => event.id !== input.eventId); h.emit(next);
      return { status: 'saved' };
    };
    h.emit();
    const menu = h.eventMenu('event-1');
    const remove = byText(menu, '删除'); assert.equal(remove.disabled, false); remove.fire('click');
    await tick(); await tick();
    assert.equal(calls, mode === 'save' ? 1 : 0);
    if (mode === 'save') assert.equal(flatten(h.container).some(node => node.dataset.eventId === 'event-1'), false);
  }
});

test('过往日期预览可点击展开原事件菜单，后台结束后删除重新可用且先弹确认', async () => {
  const h = harness(), original = h.runtime.getQianshiSnapshot(); original.projectionRevision = 1;
  let deletes = 0;
  h.runtime.deleteQianshiEvent = async () => { deletes += 1; };
  const day = () => flatten(h.container).find(node => node.id === 'day-1');
  const disclosure = () => flatten(day()).find(node => node.className === 'qqj-qianshi-day-disclosure');
  const preview = () => flatten(day()).find(node => node.className === 'qqj-qianshi-day-preview');
  const menu = () => flatten(day()).find(node => node.className.includes('qqj-qianshi-event-menu'));
  h.emit(original, { memoryWorkBusy: true });
  assert.equal(disclosure().open, false); assert.equal(visibleEventMenus(day()).length, 0);
  assert.equal(preview().tag, 'button'); assert.match(preview().attributes['aria-label'], /展开.*1 件/u);
  preview().fire('click'); disclosure().fire('toggle');
  assert.equal(disclosure().open, true); assert.equal(preview().hidden, true);
  assert.equal(visibleEventMenus(day()).length, 1, '只展开已有菜单，不在预览复制菜单');
  assert.equal(byText(menu(), '删除').disabled, true); assert.match(byText(menu(), '删除').title, /后台记忆/u);
  h.emit(original, { memoryWorkBusy: false });
  assert.equal(disclosure().open, true, '忙闲通知重绘保留用户从预览展开的旧日');
  assert.equal(byText(menu(), '删除').disabled, false);
  byText(menu(), '删除').fire('click'); await tick();
  assert.equal(h.confirms.at(-1).title, '删除这条千事'); assert.equal(deletes, 0, '确认取消不删除');
});

test('整理与处理异常短按钮并排，异常弹窗按楼展开并复用原事件编辑表单', async () => {
  const snapshot = fixture(); snapshot.projectionRevision = 1; snapshot.coverage.degradedFloors = 1;
  snapshot.diagnostics = { anomalyFloors: [{ floorId: 'floor-1', messageIndex: 12, eventIds: ['event-1'], reasons: ['找不到前序事件'] }] };
  let content;
  const h = harness({ initialSnapshot: snapshot, custom: options => {
    if (options.title === '处理异常') { content = options.content; return new Promise(() => {}); }
    return undefined;
  } });
  h.runtime.deleteQianshiEvent = async () => ({ status: 'saved' });
  const actions = flatten(h.container).find(node => node.className === 'qqj-qianshi-coverage-actions');
  assert.deepEqual(actions.children.map(node => node.textContent), ['补齐旧楼', '整理', '处理异常']);
  byText(actions, '处理异常').fire('click'); await tick();
  assert.match(copy(content), /事件仍已收录.*部分关联失效/u);
  assert.match(copy(content), /第 12 楼.*找不到前序事件/u);
  assert.equal(flatten(content).some(node => node.dataset.eventId === 'event-1'), false, '折叠时不复制大量事件详情');
  const floor = flatten(content).find(node => node.dataset.floorId === 'floor-1'); floor.open = true; floor.fire('toggle');
  const menu = flatten(content).find(node => node.dataset.qianshiEventId === 'event-1');
  const anomalyCard = flatten(content).find(node => node.className === 'qqj-qianshi-event' && node.dataset.eventId === 'event-1');
  const remove = byText(menu, '删除'); assert.equal(remove.disabled, false, '异常弹窗内删除入口初始可用');
  h.emit(structuredClone(snapshot), { status: 'ready', memoryWorkBusy: true, qianshiHistoryActive: false });
  assert.equal(byText(menu, '删除'), remove); assert.equal(remove.disabled, true, '忙态沿用异常弹窗中的原按钮');
  assert.match(remove.title, /后台记忆/u); assert.equal(flatten(content).find(node => node.className === 'qqj-qianshi-event' && node.dataset.eventId === 'event-1'), anomalyCard);
  h.emit(structuredClone(snapshot), { status: 'ready', memoryWorkBusy: false, qianshiHistoryActive: false });
  assert.equal(remove.disabled, false); assert.equal(remove.title, '', '忙态结束同步解除异常弹窗按钮');
  byText(menu, '编辑详情').fire('click');
  assert.equal(flatten(content).some(node => node.className.split(/\s+/u).includes('qqj-qianshi-text-form')), false, '异常列表不包含编辑表单');
  let form = flatten(h.editor()).find(node => node.className.split(/\s+/u).includes('qqj-qianshi-text-form')); assert.ok(form);
  const input = flatten(form).find(node => node.className.includes('qqj-qianshi-title-input')); input.value = '人工校正标题'; input.fire('input', { target: input });
  await h.saveEditor();
  assert.equal(h.runtime.getQianshiSnapshot().events[0].title, '人工校正标题');
  assert.match(copy(content), /人工校正标题/u);
  const clean = fixture(); h.emit(clean);
  assert.equal(byText(h.container, '处理异常'), undefined); assert.match(copy(content), /当前没有异常楼/u);
});


test('补齐旧楼可显式重查真实空结果，混合范围默认只补未处理楼', async () => {
  const emptyOnlySnapshot = fixture();
  emptyOnlySnapshot.coverage.pendingFloors = 0;
  emptyOnlySnapshot.coverage.partialFloors = 0;
  emptyOnlySnapshot.coverage.emptyFloors = 2;
  const emptyOnly = harness({ initialSnapshot: emptyOnlySnapshot, confirm: true,
    plan: { includeEmptyFloors: true, recheckedEmptyFloors: 2 } });
  assert.ok(byText(emptyOnly.container, '补齐旧楼'), '只有空结果楼时仍显示补齐入口');
  byText(emptyOnly.container, '补齐旧楼').fire('click');
  await tick(); await tick(); await tick(); await tick();
  assert.deepEqual(emptyOnly.prepareOptions(), { includeEmptyFloors: true }, '只有空结果楼时直接生成重查计划');
  assert.match(emptyOnly.confirms.find(value => value.title === '补齐旧楼千事').body, /重查已判空楼 2 楼/u);
  assert.match(emptyOnly.confirms.find(value => value.title === '补齐旧楼千事').note, /只替换千事增量/u);
  assert.equal(emptyOnly.calls().startCalls, 1, '经单独确认后才开始原历史任务');

  const mixedSnapshot = fixture();
  mixedSnapshot.coverage.emptyFloors = 3;
  const mixed = harness({ initialSnapshot: mixedSnapshot, choose: 'pendingOnly', confirm: true });
  byText(mixed.container, '补齐旧楼').fire('click');
  await tick(); await tick(); await tick(); await tick();
  const chooser = mixed.confirms.find(value => value.title === '选择补齐范围');
  assert.ok(chooser, '未处理楼与空结果楼并存时先选择范围');
  assert.deepEqual(chooser.choices.map(value => [value.value, value.label, Boolean(value.primary)]), [
    ['cancel', '取消', false], ['pendingOnly', '仅补未处理', true], ['includeEmpty', '含无事件楼', false],
  ], '扩大到空结果楼不是默认项');
  assert.deepEqual(mixed.prepareOptions(), { includeEmptyFloors: false });

  const includeEmpty = harness({ initialSnapshot: mixedSnapshot, choose: 'includeEmpty', confirm: true,
    plan: { includeEmptyFloors: true, recheckedEmptyFloors: 1 } });
  byText(includeEmpty.container, '补齐旧楼').fire('click');
  await tick(); await tick(); await tick(); await tick();
  assert.deepEqual(includeEmpty.prepareOptions(), { includeEmptyFloors: true });

  const cancelled = harness({ initialSnapshot: mixedSnapshot, choose: 'cancel', confirm: true });
  byText(cancelled.container, '补齐旧楼').fire('click');
  await tick(); await tick(); await tick();
  assert.equal(cancelled.calls().prepareCalls, 0, '取消范围选择不产生计划或模型请求');
  assert.equal(cancelled.calls().startCalls, 0);
});
