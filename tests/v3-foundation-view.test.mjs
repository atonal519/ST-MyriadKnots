import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createV3FoundationView as createV3FoundationViewImpl } from '../src/ui/v3-foundation-view.js';
import { createV3RecallRuntime } from '../src/v3/recall-runtime.js';
import { createVectorIndex } from '../src/v3/vector-index.js';
import { publicErrorMessage } from '../src/public-error.js';
import { scaleCssFontSizes } from '../src/ui/font-scale.js';

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.textContent = ''; this.className = ''; this.disabled = false; this.replaceCount = 0; this.value = ''; this.open = false; this.selectionStart = 0; this.selectionEnd = 0; this.scrollLeft = 0; this.attributes = {}; }
  append(...nodes) { for (const node of nodes) { this.children.push(node); if (node instanceof Node) node.parentNode = this; } }
  replaceChildren(...nodes) { this.replaceCount += 1; this.children = []; this.append(...nodes); }
  addEventListener(name, handler) { (this.listeners[name] ??= []).push(handler); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  click() { return this.fire('click'); }
  fire(name, event = {}) { let result; for (const handler of this.listeners[name] ?? []) result = handler({ target: this, currentTarget: this, stopPropagation() {}, preventDefault() {}, ...event }); return result; }
  focus(options) { documentRef.activeElement = this; this.focusOptions = options; }
  contains(target) { return target === this || flatten(this).includes(target); }
  querySelector(selector) { return flatten(this).find(node => selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1)) : selector.startsWith('[data-') && node.attributes[selector.slice(1, selector.indexOf('='))] === selector.match(/"([^"]+)"/)?.[1]) ?? null; }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (selector.startsWith('.') && node.className.split(' ').includes(selector.slice(1))) return node; return null; }
  getBoundingClientRect() { return this.rect ?? { top: 20, bottom: 120, height: 100 }; }
  get classList() { return { add: value => { if (!this.className.split(' ').includes(value)) this.className += `${this.className ? ' ' : ''}${value}`; }, remove: value => { this.className = this.className.split(' ').filter(item => item && item !== value).join(' '); } }; }
}
const documentRef = { activeElement: null, createElement: tag => new Node(tag) };
function eventDocument() {
  const clicks = new Set();
  return {
    activeElement: null,
    createElement: tag => new Node(tag),
    addEventListener(name, handler) { if (name === 'click') clicks.add(handler); },
    removeEventListener(name, handler) { if (name === 'click') clicks.delete(handler); },
    click(event) { for (const handler of clicks) handler(event); },
    clickListenerCount: () => clicks.size,
  };
}
const flatten = node => [node, ...(node.children ?? []).flatMap(flatten)];
const openDetails = node => { if (!node) throw new TypeError('expected details row'); node.open = true; node.fire('toggle'); return node; };
let activeEditorDialog = null;
let lastEditorDialogError = null;
function captureEditorDialog(options) {
  activeEditorDialog?.cancel();
  lastEditorDialogError = null;
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  let finished = false;
  const finish = value => { if (finished) return; finished = true; if (activeEditorDialog?.options === options) activeEditorDialog = null; options.onClose?.(); resolve(value); };
  activeEditorDialog = { options, content: options.content, cancel: () => finish(null), async submit() { try { const result = await options.submit(); finish(result); return result; } catch (error) { lastEditorDialogError = error; return false; } } };
  return promise;
}
function createV3FoundationView(options = {}) {
  const customImpl = options.customImpl;
  return createV3FoundationViewImpl({ ...options, customImpl: dialogOptions => {
    const fallback = captureEditorDialog(dialogOptions);
    if (typeof customImpl !== 'function') return fallback;
    let result;
    try { result = customImpl(dialogOptions); } catch (error) { activeEditorDialog?.cancel(); throw error; }
    if (result === undefined) return fallback;
    Promise.resolve(result).then(value => activeEditorDialog?.options === dialogOptions && activeEditorDialog.cancel(value), () => activeEditorDialog?.options === dialogOptions && activeEditorDialog.cancel(null));
    return result;
  } });
}
const editorContent = () => activeEditorDialog?.content ?? null;
const submitEditor = () => activeEditorDialog?.submit() ?? Promise.resolve(null);
const cancelEditor = () => activeEditorDialog?.cancel() ?? false;

test('已保存摘要等待 CSE 时显示人物分析阶段', () => {
  const state = { status: 'running', pluginEnabled: true, chatId: 'chat', foundationStatus: 'ready',
    memorySnapshotStatus: 'ready', memorySyncStatus: 'idle', memoryWorkBusy: true,
    activeMemoryWork: { kind: 'manual', phase: 'analyzingCse' }, activeExtraction: { floorId: 'floor', phase: 'analyzingCse' },
    activeCse: { floorId: 'floor', phase: 'analyzing' }, stableCount: 1, rememberedCount: 1, unprocessedCount: 0,
    csePendingCount: 1, cseFailedCount: 0, floors: [{ floorId: 'floor', assistantSeq: 1, messageIndex: 0,
      status: 'ready', memoryId: 'memory', summary: '已保存的摘要', cse: { status: 'running' } }] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef }); view.setPage('memories'); view.mount(container);
  const texts = flatten(container).map(node => node.textContent);
  assert.ok(texts.includes('摘要已保存，正在分析人物状态'));
  assert.ok(!texts.some(value => value.includes('摘要与人物状态并行') || value.includes('正在处理摘要')));
  view.deactivate();
});

test('fresh向量runtime在真实记忆管理activate读取manifest后显示建立索引链接', async () => {
  const chatId = 'direct-count-view-chat', narrativeGeneration = 'generation-current';
  const state = { status: 'ready', pluginEnabled: true, chatId, narrativeGeneration, foundationStatus: 'ready',
    memorySnapshotStatus: 'ready', memorySyncStatus: 'idle', stableCount: 1, rememberedCount: 1, unprocessedCount: 0,
    floors: [{ floorId: 'floor', assistantSeq: 1, messageIndex: 1, status: 'ready', memoryId: 'memory', summary: '既有摘要' }] };
  let manifestGets = 0, shardGets = 0, identityReads = 0, sourceReads = 0, embedCalls = 0, puts = 0;
  const vectorRuntime = createVectorIndex({ client: { async get(_collection, id) {
      if (id === 'qqj-vector-index') { manifestGets += 1; throw Object.assign(new Error('not_found'), { status: 404 }); }
      shardGets += 1; throw new Error('unexpected shard read');
    }, async put() { puts += 1; } },
    api: { async embed() { embedCalls += 1; return []; } },
    configProvider: () => ({ url: 'https://vector.invalid/v1', model: 'model', key: 'local-test-key', dimensions: null }),
    identityProvider: () => { identityReads += 1; throw new Error('explicit target must bypass session identity'); },
    sourceProvider: async () => { sourceReads += 1; throw new Error('readIndexStatus must not project source'); },
  });
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const container = new Node('main'), view = createV3FoundationView({ runtime, vectorRuntime, documentRef });
  view.setPage('management'); view.mount(container);
  assert.equal(manifestGets, 0, 'mount不读取索引');
  await view.activate();
  const link = flatten(container).find(node => node.className.includes('qqj-vector-index-link'));
  assert.ok(link); assert.equal(link.hidden, false, '设置记忆管理按缺失manifest显示链接');
  assert.match(link.textContent, /还没有向量索引，去建立吧/u);
  assert.equal(flatten(container).some(node => node.className.includes('qqj-vector-index-hint')), false, '不再创建记忆页独立提示');
  assert.equal(manifestGets, 1); assert.equal(shardGets, 0); assert.equal(identityReads, 0);
  assert.equal(sourceReads, 0); assert.equal(embedCalls, 0); assert.equal(puts, 0);
  view.deactivate();
});

test('记忆管理仅在手动建立完成后复查索引，失败读取不误报为零', async () => {
  const state = { status: 'ready', pluginEnabled: true, chatId: 'vector-hint-chat', narrativeGeneration: 'vector-generation', foundationStatus: 'ready', memorySnapshotStatus: 'ready',
    memorySyncStatus: 'idle', memoryWorkBusy: false, stableCount: 1, rememberedCount: 1,
    unprocessedCount: 0, floors: [{ floorId: 'hint-floor', assistantSeq: 1, messageIndex: 1, status: 'ready', memoryId: 'hint-memory', summary: '保留的摘要行' }] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  let readCalls = 0, nextRead = { status: 'ready', chunkCount: 0 }, readFailure = null; const vectorListeners = new Set();
  const vectorRuntime = { async readIndexStatus(target) { readCalls += 1; assert.deepEqual(target, { chatId: state.chatId, narrativeGeneration: state.narrativeGeneration }); if (readFailure) throw readFailure; return nextRead; },
    subscribe(listener) { vectorListeners.add(listener); return () => vectorListeners.delete(listener); } };
  const container = new Node('main'), view = createV3FoundationView({ runtime, vectorRuntime, documentRef });
  view.setPage('management'); view.mount(container);
  const texts = () => flatten(container).map(node => node.textContent).join('|');
  let link = flatten(container).find(node => node.className.includes('qqj-vector-index-link'));
  assert.ok(link); assert.equal(link.hidden, true, '只render/mount不读取manifest或显示判断');
  await view.activate();
  assert.equal(readCalls, 1);
  link = flatten(container).find(node => node.className.includes('qqj-vector-index-link'));
  let readErrorNode = flatten(container).find(node => node.className.includes('qqj-vector-index-read-error'));
  assert.ok(link); assert.equal(link.hidden, false);
  assert.ok(readErrorNode); assert.equal(readErrorNode.hidden, true);
  const replaceCount = container.replaceCount;
  for (const listener of vectorListeners) listener({ status: 'building', background: false });
  assert.equal(readCalls, 1, '建立进度不重复读取manifest');
  nextRead = { status: 'ready', chunkCount: 5 };
  for (const listener of vectorListeners) listener({ status: 'ready', background: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readCalls, 2, '既有设置中的建立完成后只复查一次manifest');
  link = flatten(container).find(node => node.className.includes('qqj-vector-index-link'));
  assert.equal(link.hidden, true, '已建立片段的聊天不显示提示');
  assert.equal(container.replaceCount, replaceCount, '索引通知原位更新，不重绘管理页');
  readFailure = Object.assign(new Error('后端暂不可用'), { code: 'BACKEND_UNAVAILABLE' });
  await view.activate();
  link = flatten(container).find(node => node.className.includes('qqj-vector-index-link'));
  readErrorNode = flatten(container).find(node => node.className.includes('qqj-vector-index-read-error'));
  assert.equal(readCalls, 3); assert.equal(link.hidden, true); assert.equal(readErrorNode.hidden, false);
  assert.match(texts(), /读取当前聊天的向量索引失败/u);
  assert.equal(link.hidden, true, '读取失败不能显示零索引链接');
  view.deactivate();
});

test('ready快照内的后续向量进度通知不重复读取manifest', async () => {
  const chatId = 'vector-background-missing-chat';
  const config = { url: 'https://vector.invalid/v1', model: 'mock-embedding', key: 'test-key', dimensions: null };
  const source = { status: 'ready', chatId, narrativeGeneration: 'generation', rawSources: [] };
  const getCalls = [], putCalls = []; let embedCalls = 0, manifest = null;
  const vectorRuntime = createVectorIndex({
    client: {
      async get(collection, id) {
        getCalls.push({ collection, id });
        if (!manifest) throw Object.assign(new Error('not_found'), { status: 404 });
        return structuredClone(manifest);
      },
      async put(...args) { putCalls.push(args); },
    },
    api: { async embed() { embedCalls += 1; throw new Error('incremental missing-index path must not embed'); } },
    configProvider: () => config, identityProvider: () => ({ chatId }), sourceProvider: async () => source,
  });
  const state = { status: 'ready', pluginEnabled: true, chatId, narrativeGeneration: 'generation', foundationStatus: 'ready', memorySnapshotStatus: 'ready',
    memorySyncStatus: 'idle', memoryWorkBusy: false, stableCount: 0, rememberedCount: 0, unprocessedCount: 0, floors: [] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const container = new Node('main'), view = createV3FoundationView({ runtime, vectorRuntime, documentRef });
  view.setPage('management'); view.mount(container);
  let link = flatten(container).find(node => node.className.includes('qqj-vector-index-link'));
  assert.ok(link); assert.equal(link.hidden, true, '未读manifest时不提示');
  await view.activate();
  link = flatten(container).find(node => node.className.includes('qqj-vector-index-link'));
  assert.equal(getCalls.length, 1); assert.equal(link.hidden, false);
  const afterActivationGets = getCalls.length;
  const result = await vectorRuntime.updateIncrementally({ targetIdentity: { chatId }, config });
  assert.equal(result.status, 'notIndexed', '后台增量仍跳过未建立索引');
  assert.equal(getCalls.length, afterActivationGets + 1, '增量本身只执行其必要manifest读取');
  assert.equal(getCalls.length, afterActivationGets + 1, '已读向量通知不触发额外提醒读取');
  assert.equal(embedCalls, 0, '不自动建立索引'); assert.equal(putCalls.length, 0, '不写入索引');
  view.deactivate();
});

test('本楼编辑以摘要为主，时间地点人物与修订说明按需展开', () => {
  const state = { status: 'ready', pluginEnabled: true, chatId: 'editor-chat', foundationStatus: 'ready', memorySnapshotStatus: 'ready', memorySyncStatus: 'idle',
    floors: [{ floorId: 'editor-floor', assistantSeq: 1, messageIndex: 0, status: 'ready', memoryId: 'editor-memory', summary: '原摘要', canonicalFingerprint: 'canonical', rawFingerprint: 'raw',
      memory: { summary: '原摘要', chronology: [], participants: [], locations: [] } }], memoryEntities: [] };
  let dialogOptions, closeDialog;
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, editMemory: async () => ({ status: 'saved' }) };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef, customImpl: options => { dialogOptions = options; return new Promise(resolve => { closeDialog = resolve; }); } });
  view.setPage('memories'); view.mount(container);
  const edit = flatten(container).find(node => node.textContent === '编辑'); assert.ok(edit);
  edit.click(); assert.ok(dialogOptions?.content);
  const groups = flatten(dialogOptions.content).filter(node => node.className.split(' ').includes('qqj-editor-group'));
  assert.equal(groups[0].children[0].textContent, '摘要', '正文摘要排在编辑窗首位');
  assert.ok(flatten(groups[0]).some(node => node.tag === 'textarea'));
  assert.deepEqual(groups.slice(1).map(group => group.tag), ['details', 'details', 'details', 'details'], '其余元信息保持可编辑但默认收起');
  assert.equal(flatten(container).some(node => node.className.includes('qqj-memory-edit')), false, '列表不挂载编辑表单');
  let locationGroup = flatten(dialogOptions.content).find(node => node.tag === 'details' && node.children[0]?.textContent === '地点');
  locationGroup.open = true;
  flatten(locationGroup).find(node => node.textContent === '添加地点').click();
  locationGroup = flatten(dialogOptions.content).find(node => node.tag === 'details' && node.children[0]?.textContent === '地点');
  assert.equal(locationGroup.open, true, '增添地点后保留当前分组展开');
  const locationInput = flatten(locationGroup).find(node => node.placeholder === '地点名称');
  assert.ok(locationInput, '新地点输入仍在展开组内可见'); locationInput.value = '旧站'; locationInput.fire('input');
  dialogOptions.onClose?.(); closeDialog(null); view.deactivate();
});

test('批量摘要结束后反馈跟随 CSE、同步阶段并在完成后清除处理中状态', async () => {
  let state = { status: 'running', pluginEnabled: true, chatId: 'batch', foundationStatus: 'ready',
    memorySnapshotStatus: 'ready', memorySyncStatus: 'idle', memoryWorkBusy: true,
    activeMemoryWork: { kind: 'auto', phase: 'analyzingCse' }, activeAutoMemory: { phase: 'analyzingCse' },
    activeExtraction: null, activeCse: { phase: 'analyzing' }, stableCount: 5, rememberedCount: 5,
    unprocessedCount: 0, csePendingCount: 3, floors: [] };
  let notify;
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, subscribe: listener => { notify = listener; return () => {}; } };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef }); view.setPage('memories'); view.mount(container); await view.activate();
  const texts = () => flatten(container).map(node => node.textContent).join('|');
  assert.match(texts(), /摘要已保存 · 5\/5 楼 · 正在分析人物状态/);
  assert.doesNotMatch(texts(), /正在处理摘要|正在处理\|/);
  state = { ...state, activeCse: null, activeMemoryWork: { kind: 'auto', phase: 'syncing' }, activeAutoMemory: { phase: 'syncing' } };
  notify(state); assert.match(texts(), /正在同步记忆状态/);
  state = { ...state, status: 'ready', memoryWorkBusy: false, activeMemoryWork: null, activeAutoMemory: null, csePendingCount: 0 };
  notify(state); assert.match(texts(), /已记忆 5\/5 楼/); assert.match(texts(), /记忆状态已刷新/);
  assert.doesNotMatch(texts(), /正在处理|正在分析人物状态|正在同步记忆状态/);
  view.deactivate();
});

test('摘要近期事项默认折叠并局部更新，草稿同步恢复可点击，读失败仅重试读取与生命周期清理', async () => {
  const css = await readFile(new URL('../src/ui/panel.css', import.meta.url), 'utf8');
  const scaledCss = scaleCssFontSizes(css, '--qqj-ui-fixed-scale', true);
  assert.match(css, /#qqj-recent-items\[hidden\]\{display:none\}/u, '作者样式需显式覆盖 settings-block 的 display:grid，不能仅依赖 UA hidden');
  assert.match(css, /\.qqj-recent-item-title\{[^}]*font-size:12px/u);
  assert.match(css, /\.qqj-recent-item-times\{[^}]*font-size:9px/u);
  assert.match(scaledCss, /\.qqj-recent-item-description\{[^}]*font-size:calc\(12px \* var\(--qqj-ui-fixed-scale,1\)\)/u, '近期事项正文继续受全局字号缩放');
  assert.match(css, /\.qqj-time-clock-reminder\{[^}]*flex:0 0 100%/u, '时间戳提醒单独占一行');
  assert.match(css, /\.qqj-time-clock-reminder\[hidden\]\{display:none\}/u, 'hidden 必须覆盖提醒自身的 display');
  assert.match(css, /\.qqj-cse-page-heading>strong\{[^}]*white-space:nowrap/u, '分析记录标题在桌面窄栏不得被搜索框挤成逐字换行');
  assert.match(css, /\.qqj-cse-page-heading>\.qqj-history-search\{[^}]*flex:1 1 auto/u, '分析记录搜索框应按标题和返回按钮之外的剩余宽度伸缩');
  assert.match(css, /@media\(max-width:390px\)\{[^\n]*\.qqj-cse-page-heading\{[^}]*flex-wrap:wrap/u, '手机窄屏应让分析记录工具栏合理换行');
  const floor = { floorId: 'floor', assistantSeq: 1, messageIndex: 2, canonicalFingerprint: 'sha256:same', status: 'ready', memoryId: 'memory', summary: '原摘要', summarySource: 'ai', memory: { summaryEvidenceRefs: [] }, cse: { status: 'ready', deltaId: 'delta' } };
  let state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', memorySnapshotStatus: 'ready', memorySyncStatus: 'idle', memoryWorkBusy: false, stableCount: 1, rememberedCount: 1, unprocessedCount: 0, cseReady: true, csePendingCount: 0, cseFailedCount: 0, floors: [floor] };
  const memoryListeners = new Set(), timeListeners = new Set();
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state, editSummary: async () => state, subscribe(listener) { memoryListeners.add(listener); return () => memoryListeners.delete(listener); } };
  const emit = next => { state = next; for (const listener of memoryListeners) listener(next); };
  const item = { person: '甲', label: '擦伤', type: 'body', status: 'active', observation: '手腕擦伤 <b>原文</b>', observationTime: { date: '2026-05-10' }, occurrenceTime: { date: null }, observationElapsedDays: 2, observationElapsedHours: null, elapsedDays: null, elapsedHours: null, projection: null };
  let timeState = { status: 'idle', active: false, canOrganize: true, disabledReason: '', last: null, trackedItems: null, clockContentChanged: false }, reads = 0, refreshes = 0, organizes = 0, cached = false;
  const publish = () => { for (const listener of timeListeners) listener(timeState); };
  const timeRuntime = { getState: () => structuredClone(timeState), subscribe(listener) { timeListeners.add(listener); return () => timeListeners.delete(listener); },
    async refreshStatus(options) { refreshes += 1; if (!cached || options?.force) { reads += 1; cached = true; timeState = { ...timeState, status: 'completed', last: { status: 'completed', items: 1 }, trackedItems: [item] }; } publish(); return timeState; },
    async prepareHistoryPlan() { return { floorCount: 1, batchCount: 1, apiCalls: 1 }; },
    async organize() { organizes += 1; timeState = { ...timeState, status: 'completed', last: { status: 'completed', items: 1 }, trackedItems: [{ ...item, projection: '可能有所减轻' }] }; publish(); return timeState; } };
  const container = new Node('main'); container.scrollTop = 45;
  const view = createV3FoundationView({ runtime, timeRuntime, documentRef, confirmImpl: () => true }); view.setPage('memories'); view.mount(container);
  let toggle = flatten(container).find(node => node.textContent === '近期事项');
  const memoryToolbar = flatten(container).find(node => String(node.className).split(' ').includes('qqj-memory-toolbar'));
  assert.equal(memoryToolbar.children[0].className, 'qqj-history-search'); assert.equal(memoryToolbar.children[1], toggle, '摘要搜索位于近期事项左侧');
  const clockReminder = memoryToolbar.children.find(node => String(node.className).includes('qqj-time-clock-reminder'));
  assert.ok(clockReminder); assert.equal(clockReminder.hidden, true);
  timeState = { ...timeState, clockContentChanged: true }; publish();
  assert.equal(clockReminder.hidden, false); assert.equal(clockReminder.textContent, '时间信息可能变化，请用户核实');
  timeState = { ...timeState, clockContentChanged: false }; publish(); assert.equal(clockReminder.hidden, true);
  assert.equal(toggle.attributes['aria-expanded'], 'false'); assert.equal(reads, 0); assert.equal(refreshes, 0);
  let body = flatten(container).find(node => node.id === toggle.attributes['aria-controls']); assert.equal(body.hidden, true);
  assert.ok(flatten(container).some(node => node.className === 'v3-memory-list'));
  await toggle.click(); assert.equal(reads, 1); assert.equal(toggle.textContent, '近期事项（1）'); assert.equal(body.hidden, false);
  let recentText = flatten(body).map(node => node.textContent).join('|');
  assert.match(recentText, /手腕擦伤 <b>原文<\/b>/u);
  assert.doesNotMatch(recentText, /观察时间|经过时间|已过 2 天|待更新|旧推测/u);
  assert.equal(flatten(body).some(node => node.className.includes('qqj-recent-item-result')), false, '没有推测时不显示待更新占位');
  assert.equal(flatten(body).some(node => node.tag === 'details'), false, '列表不再嵌套另一折叠层');
  const list = body.children.at(-1), entry = list.children[0], listReplaceCount = list.replaceCount;
  list.scrollTop = 28; entry.scrollTop = 9;
  await toggle.click(); assert.equal(body.hidden, true); assert.equal(toggle.attributes['aria-expanded'], 'false');
  publish(); assert.equal(body.hidden, true); assert.equal(toggle.attributes['aria-expanded'], 'false', '时间通知不得重新展开已收起区域');
  timeState = { ...timeState, last: { status: 'failed', automaticFailure: true, automaticFailureMessage: '再次推演失败。', message: '原失败原因：年表读取错误' } }; publish();
  const automaticFailure = flatten(memoryToolbar).find(node => node.className.includes('qqj-time-automatic-failure'));
  assert.equal(automaticFailure.hidden, false, '自动推演失败在折叠状态也要显示小字');
  assert.match(automaticFailure.textContent, /原失败原因：年表读取错误/u, '自动准备失败时保留已记录的具体原因');
  timeState = { ...timeState, last: { status: 'partial', message: '有两条事项尚待处理。' } }; publish();
  assert.equal(automaticFailure.hidden, false); assert.match(automaticFailure.textContent, /部分未完成：有两条事项尚待处理/u);
  timeState = { ...timeState, status: 'waiting', last: { status: 'failed', message: '旧周期失败' } }; publish();
  assert.equal(automaticFailure.hidden, true, '等待记忆同步时不展示可能过期的失败');
  timeState = { ...timeState, status: 'idle', last: { status: 'completed' } }; publish(); assert.equal(automaticFailure.hidden, true, '成功后清除瞬时失败提示');
  await toggle.click(); assert.equal(body.hidden, false); assert.equal(reads, 1);
  assert.equal(list.children[0], entry); assert.equal(list.replaceCount, listReplaceCount, '不同clone内容相同与cache-hit notify不得重建列表');
  assert.equal(list.scrollTop, 28); assert.equal(entry.scrollTop, 9);
  timeState = { ...timeState, active: true, canOrganize: false }; publish();
  assert.equal(list.children[0], entry); assert.equal(list.replaceCount, listReplaceCount);
  assert.equal(flatten(body).find(node => node.textContent === '补查历史').disabled, true, '清单相同时busy仍更新按钮');
  timeState = { ...timeState, active: false, canOrganize: true }; publish();
  assert.equal(flatten(body).find(node => node.textContent === '补查历史').disabled, false);
  flatten(container).find(node => node.textContent === '编辑').click();
  const input = flatten(editorContent()).find(node => node.tag === 'textarea'); input.value = '未保存草稿'; input.fire('input'); input.focus();
  toggle = flatten(container).find(node => node.textContent === '近期事项（1）');
  const replaceCount = container.replaceCount;
  const editedBody = flatten(container).find(node => node.id === 'qqj-recent-items'), editedList = editedBody.children.at(-1), oldEntry = editedList.children[0];
  await flatten(container).find(node => node.textContent === '补查历史').click();
  assert.notEqual(editedList.children[0], oldEntry, '真实显示内容改变才替换事项');
  assert.equal(organizes, 1); assert.equal(container.replaceCount, replaceCount); assert.equal(input.value, '未保存草稿');
  assert.equal(documentRef.activeElement, input); assert.equal(container.scrollTop, 45);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /可能有所减轻/u);
  assert.ok(flatten(container).some(node => node.attributes['data-qqj-floor-id'] === 'floor'), 'timeState 返回不得替换 memoryState');
  timeState = { ...timeState, status: 'waiting', canOrganize: false, trackedItems: null }; publish();
  emit({ ...state, memorySnapshotStatus: 'syncing', memorySyncStatus: 'syncing', memoryWorkBusy: true });
  assert.equal(toggle.disabled, false); assert.equal(flatten(container).find(node => node.textContent === '补查历史').disabled, true);
  timeState = { ...timeState, status: 'completed', canOrganize: true, trackedItems: [item] };
  emit({ ...state, memorySnapshotStatus: 'ready', memorySyncStatus: 'idle', memoryWorkBusy: false });
  assert.equal(container.replaceCount, replaceCount); assert.equal(input.value, '未保存草稿'); assert.equal(toggle.disabled, false);
  await toggle.click(); await toggle.click(); assert.equal(reads, 1); assert.equal(toggle.attributes['aria-expanded'], 'true');
  timeState = { ...timeState, trackedItems: [{ ...item, oldProjection: { text: '旧推测', applicableTime: { date: '2026-05-11' } }, assessmentReason: '没有新观察，无法判断。' }] }; publish();
  recentText = flatten(container).map(node => node.textContent).join('|');
  assert.match(recentText, /依据不足：没有新观察，无法判断/u);
  assert.doesNotMatch(recentText, /截至 2026-05-11 的旧推测|观察时间|经过时间/u);
  assert.ok(flatten(container).find(node => node.textContent === '甲 · 擦伤').className.includes('error'));
  timeState = { ...timeState, trackedItems: [{ ...item, reviewStatus: 'omitted' }] }; publish();
  assert.doesNotMatch(flatten(container).map(node => node.textContent).join('|'), /本次未纳入当前推测|未获得有效推测/u, '未形成结果时不显示状态占位文案');
  assert.equal(flatten(container).find(node => node.textContent === '甲 · 擦伤').className.includes('error'), false, '未形成结果不标成事项错误');
  timeState = { ...timeState, trackedItems: [{ ...item, failureReason: '来源编号无效。' }] }; publish();
  assert.match(flatten(container).map(node => node.textContent).join('|'), /更新失败：来源编号无效/u);
  assert.ok(flatten(container).find(node => node.textContent === '甲 · 擦伤').className.includes('error'));
  timeState = { ...timeState, trackedItems: [{ ...item, reviewStatus: 'unanswered' }] }; publish();
  assert.doesNotMatch(flatten(container).map(node => node.textContent).join('|'), /本次未获得有效推测/u);
  assert.equal(flatten(container).find(node => node.textContent === '甲 · 擦伤').className.includes('error'), false, '仅状态标记不显示为失败');
  timeState = { ...timeState, trackedItems: [item] }; publish();
  assert.equal(flatten(container).find(node => node.textContent === '甲 · 擦伤').className.includes('error'), false, '健康后标题恢复普通色');
  timeState = { ...timeState, last: { status: 'partial', message: '第2项：来源编号未在本次请求中出现。请手动继续。' } }; publish();
  assert.match(flatten(container).map(node => node.textContent).join('|'), /部分完成.*第2项/);
  assert.equal(flatten(container).find(node => node.textContent === '继续补查历史').disabled, false);
  timeState = { ...timeState, status: 'failed', trackedItems: null, last: { status: 'failed', reason: 'read', message: '读取失败' } }; publish();
  const retry = flatten(container).find(node => node.textContent === '重试读取'); assert.equal(retry.hidden, false);
  assert.equal(flatten(container).find(node => node.textContent === '继续补查历史').disabled, true);
  await retry.click(); assert.equal(reads, 2); assert.equal(organizes, 1);
  view.deactivate(); assert.equal(timeListeners.size, 0); assert.equal(memoryListeners.size, 0);
  view.mount(container); assert.equal(timeListeners.size, 1); assert.equal(memoryListeners.size, 1); assert.equal(reads, 2);
  emit({ ...state, chatId: 'new-chat', floors: [] });
  assert.equal(flatten(container).includes(editedBody), false, '切聊天不带旧section或清单节点');
  assert.equal(flatten(container).find(node => node.className.includes('qqj-profile-more')).attributes['aria-expanded'], 'false');
  view.setPage('management'); assert.equal(flatten(container).some(node => node.textContent.startsWith('近期事项')), false);
  view.deactivate(); assert.equal(timeListeners.size, 0); assert.equal(memoryListeners.size, 0);
});
function peopleRuntime(candidates, selected = candidates.map(item => item.entityId)) {
  let state = { status: 'ready', selectedEntityIds: [...selected], people: candidates.map(item => ({ aliases: [], appearanceCount: 1, recommended: false, ...item, selected: selected.includes(item.entityId) })), active: null };
  return { getState: () => state, refresh: async () => state, setSelectedEntityIds: async ids => { state = { ...state, selectedEntityIds: [...ids], people: state.people.map(item => ({ ...item, selected: ids.includes(item.entityId) })) }; return state; } };
}

test('近期事项人工编辑保草稿焦点，失败重试与取消零写，停止项同缓存恢复', async () => {
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', memorySnapshotStatus: 'ready', memorySyncStatus: 'idle', memoryWorkBusy: false, stableCount: 0, rememberedCount: 0, unprocessedCount: 0, floors: [] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  let item = { id: 'body-item', observationKey: 'key-one', status: 'active', person: '甲', label: '旧擦伤', type: 'body', observation: '原观察', observationTime: { date: '2026-05-11', raw: '次日', clock: '08:00' }, occurrenceTime: { date: '纪1年10月4日', raw: '纪元年10月4日' }, dueTime: { date: null }, periodDays: null, elapsedHours: null, elapsedDays: null, observationElapsedHours: null, observationElapsedDays: 2, projection: '旧推测' };
  let timeState = { status: 'completed', active: false, canOrganize: true, disabledReason: '', last: { status: 'completed', items: 1 }, trackedItems: [item], stoppedItems: [] }, writes = 0, reads = 0, fail = true;
  let lastFields; const listeners = new Set(); const emit = () => { for (const listener of listeners) listener(timeState); };
  const timeRuntime = { getState: () => structuredClone(timeState), subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, refreshStatus: async () => { reads += 1; emit(); return timeState; },
    async editItem(id, fields, key) { writes += 1; lastFields = fields; assert.equal(id, item.id); assert.equal(key, item.observationKey); if (fail) { fail = false; throw Object.assign(new Error('事项描述超过1200字，请缩短后保存。'), { code: 'QQJ_TIME_EDIT_INVALID' }); }
      item = { ...item, ...fields, observationKey: `key-${writes}`, projection: null };
      timeState = { ...timeState, trackedItems: item.status === 'active' ? [item] : [], stoppedItems: item.status === 'active' ? [] : [item] }; emit(); return timeState;
    } };
  const container = new Node('main'); container.scrollTop = 35;
  let confirmedCopy; const view = createV3FoundationView({ runtime, timeRuntime, documentRef, confirmImpl: options => { confirmedCopy = options; return true; } }); view.setPage('memories'); view.mount(container);
  await flatten(container).find(node => node.textContent === '近期事项（1）').click();
  let recentText = flatten(container).map(node => node.textContent).join('|');
  assert.match(recentText, /发生：纪元年10月4日/u, '列表显示正式发生时间并保留任意纪年');
  assert.doesNotMatch(recentText, /观察时间|次日 08:00|经过/u, '列表不展示观察时间或由观察时间推导的经过时间');
  const itemMenu = flatten(container).find(node => node.className === 'qqj-profile-menu');
  assert.equal(itemMenu.parentNode.className, 'qqj-recent-item-head'); assert.equal(itemMenu.parentNode.children.at(-1), itemMenu);
  assert.equal(itemMenu.children[0].textContent, '⋮'); assert.equal(itemMenu.children[0].attributes['aria-haspopup'], 'menu'); assert.match(itemMenu.children[0].attributes['aria-label'], /事项操作/u);
  assert.ok(flatten(itemMenu).filter(node => node.tag === 'button').every(node => node.className.includes('qqj-profile-menu-action') && node.attributes.role === 'menuitem'));
  itemMenu.open = true;
  await flatten(container).find(node => node.textContent === '编辑事项').click();
  assert.equal(itemMenu.open, false);
  const editGroups = flatten(editorContent()).filter(node => node.className.split(' ').includes('qqj-editor-group'));
  assert.equal(editGroups[0].children[0].textContent, '事项内容', '主要事件内容放在编辑窗最前');
  assert.equal(editGroups[1].tag, 'details'); assert.equal(editGroups[2].tag, 'details', '时间和人物归属作为可展开的次要信息');
  assert.equal(editGroups[1].open, false); assert.equal(editGroups[2].open, false);
  let description = flatten(editorContent()).find(node => node.attributes['aria-label'] === '观察描述');
  const name = flatten(editorContent()).find(node => node.attributes['aria-label'] === '事项名称');
  name.value = '名'.repeat(151); name.fire('input');
  description.value = '描'.repeat(1201); description.fire('input'); description.selectionStart = 3; description.focus();
  const oldNode = description, replacements = container.replaceCount;
  timeState = { ...timeState, active: true, canOrganize: false }; emit();
  assert.equal(flatten(editorContent()).find(node => node.attributes['aria-label'] === '观察描述'), oldNode);
  timeState = { ...timeState, active: false, canOrganize: true }; emit();
  assert.equal(description.value, '描'.repeat(1201)); assert.equal(name.value, '名'.repeat(151)); assert.equal(documentRef.activeElement, description); assert.equal(description.selectionStart, 3); assert.equal(container.scrollTop, 35);
  await submitEditor();
  assert.equal(description.value, '描'.repeat(1201)); assert.equal(name.value, '名'.repeat(151));
  assert.ok(activeEditorDialog, '失败后事项编辑窗保持打开');
  assert.equal(lastEditorDialogError?.message, '事项描述超过1200字，请缩短后保存。', '弹窗应保留原有的具体校验原因');
  assert.equal(documentRef.activeElement, description); assert.equal(container.replaceCount, replacements);
  name.value = '名'.repeat(150); name.fire('input'); description.value = '描'.repeat(1200); description.fire('input');
  await submitEditor(); assert.equal(item.observation.length, 1200); assert.equal(item.label.length, 150); assert.equal(item.projection, null);
  await flatten(container).find(node => node.textContent === '编辑事项').click();
  await submitEditor(); assert.equal(writes, 2, '原样保存不写新批次或清推测');
  await flatten(container).find(node => node.textContent === '编辑事项').click();
  description = flatten(editorContent()).find(node => node.attributes['aria-label'] === '观察描述'); description.value = '取消的内容'; description.fire('input');
  cancelEditor(); assert.equal(writes, 2); assert.equal(item.observation.length, 1200);
  const oldTimes = { observationTime: structuredClone(item.observationTime), occurrenceTime: structuredClone(item.occurrenceTime), dueTime: structuredClone(item.dueTime) };
  await flatten(container).find(node => node.textContent === '编辑事项').click();
  const renamed = flatten(editorContent()).find(node => node.attributes['aria-label'] === '事项名称'); renamed.value = '只改名称'; renamed.fire('input');
  await submitEditor();
  assert.deepEqual(lastFields, { label: '只改名称' });
  for (const [key, value] of Object.entries(oldTimes)) assert.deepEqual(item[key], value);
  await flatten(container).find(node => node.textContent === '暂停').click();
  assert.equal(flatten(container).some(node => node.textContent === '确认保存'), false, '弹窗确认后直接保存，不再嵌套确认');
  assert.equal(item.status, 'paused'); assert.equal(flatten(container).find(node => node.className.includes('qqj-profile-more')).textContent, '近期事项（0）');
  const beforeStopped = reads; await flatten(container).find(node => node.textContent === '查看停止项（1）').click(); assert.equal(reads, beforeStopped);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /已暂停/u);
  for (const status of ['completed', 'paused', 'cancelled']) {
    timeState = { ...timeState, stoppedItems: [{ ...item, type: 'cycle', status, failureReason: '旧失败', assessmentReason: '旧依据不足', reviewStatus: 'unanswered', dueTime: { date: '2026-05-15' }, periodDays: 5 }] }; emit();
    const text = flatten(container).map(node => node.textContent).join('|');
    assert.match(text, /已暂停|已完成|已移除/u); assert.doesNotMatch(text, /等待推算|尚未确认发生或完成|当前推测/u);
    assert.equal(flatten(container).find(node => node.textContent.includes('甲 · 只改名称')).className.includes('error'), false, '结束事项不保留错误标题色');
  }
  timeState = { ...timeState, stoppedItems: [{ ...item, mergedInto: 'primary' }] }; emit();
  assert.match(flatten(container).map(node => node.textContent).join('|'), /已归并/u);
  await flatten(container).find(node => node.textContent === '恢复追踪').click();
  assert.match(confirmedCopy.body, /解除归并，恢复独立跟进/u);
  assert.equal(item.status, 'active'); assert.equal(flatten(container).find(node => node.className.includes('qqj-profile-more')).textContent, '近期事项（1）');
  await flatten(container).find(node => node.textContent === '返回追踪中事项').click(); assert.match(flatten(container).map(node => node.textContent).join('|'), /只改名称/u);
  assert.equal(reads, beforeStopped); view.deactivate(); assert.equal(listeners.size, 0);
});

test('近期事项编辑可选择现有人物并修订当前推测，不显示人物ID', async () => {
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', memorySnapshotStatus: 'ready', memorySyncStatus: 'idle', memoryWorkBusy: false,
    memoryEntities: [{ entityId: 'person-a', displayName: '甲' }, { entityId: 'person-b', displayName: '乙' }], floors: [] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  let item = { id: 'body-item', subjectEntityId: 'person-a', observationKey: 'key-one', status: 'active', person: '甲', label: '擦伤', type: 'body', observation: '手腕擦伤',
    observationTime: { date: '2026-05-11' }, occurrenceTime: { date: '2026-05-10' }, dueTime: { date: null }, periodDays: null, projection: '仍可能疼痛', projectionTime: { date: '2026-05-11', clock: '09:00' } };
  let timeState = { status: 'completed', active: false, canOrganize: true, last: { status: 'completed' }, trackedItems: [item],
    stoppedItems: [{ id: 'old-time-item', subjectEntityId: 'time-person-known', status: 'paused', person: '路人甲' }] }, savedFields = null;
  const timeRuntime = { getState: () => structuredClone(timeState), refreshStatus: async () => timeState, subscribe: () => () => {}, async editItem(id, fields, key) {
    assert.equal(id, item.id); assert.equal(key, item.observationKey); savedFields = fields;
    const { projectionText, ...saved } = fields;
    item = { ...item, ...saved, person: fields.subjectEntityId === 'person-b' ? '乙' : '甲', projection: projectionText ?? item.projection, observationKey: 'key-two' };
    timeState = { ...timeState, trackedItems: [item] }; return timeState;
  } };
  const container = new Node('main'), view = createV3FoundationView({ runtime, timeRuntime, documentRef });
  view.setPage('memories'); view.mount(container);
  await flatten(container).find(node => node.textContent === '近期事项（1）').click();
  await flatten(container).find(node => node.textContent === '编辑事项').click();
  const person = flatten(editorContent()).find(node => node.attributes['aria-label'] === '人物归属');
  assert.deepEqual(person.children.map(option => option.textContent), ['甲', '乙', '路人甲']);
  assert.doesNotMatch(flatten(container).map(node => node.textContent).join('|'), /person-a|person-b/u);
  person.value = 'person-b'; person.fire('change');
  const projection = flatten(editorContent()).find(node => node.attributes['aria-label'] === '当前推测');
  assert.ok(projection); projection.value = '疼痛可能已经减轻，尚未确认恢复'; projection.fire('input');
  await submitEditor();
  assert.deepEqual(savedFields, { subjectEntityId: 'person-b', projectionText: '疼痛可能已经减轻，尚未确认恢复' });
  assert.equal(item.projectionTime.clock, '09:00');
  assert.match(flatten(container).map(node => node.textContent).join('|'), /乙 · 擦伤/u);
  view.deactivate();
});

test('近期事项精简列表保留有效推测、发生/期限、停止与年度只读结果', async () => {
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', memorySnapshotStatus: 'ready', memorySyncStatus: 'idle', memoryWorkBusy: false, floors: [] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, subscribe: () => () => {} };
  const trackedItems = [
    { id: 'cycle', observationKey: 'cycle-key', status: 'active', person: '甲', label: '周期', type: 'cycle', observation: '细节观察', mergeDescription: '共同经历的整体影响', observationTime: { date: '1999-01-02' }, occurrenceTime: { date: '纪1年2月3日' }, dueTime: { date: '纪1年2月8日' }, periodDays: 5, elapsedDays: 4, projection: '可能开始缓解', projectionTime: { date: '纪1年2月5日' }, keywords: ['轻微不适', '恢复中', '<img onerror>'], reviewStatus: 'unanswered', oldProjection: { text: '不再适用旧推测', applicableTime: { date: '纪1年2月5日' } } },
    { id: 'unknown', observationKey: 'unknown-key', status: 'active', person: '乙', label: '未知起点', type: 'body', observation: '说明', observationTime: { date: '1999-01-03' }, occurrenceTime: { date: null }, dueTime: { date: null }, elapsedDays: null, projection: null },
    { id: 'deadline', observationKey: 'deadline-key', status: 'active', person: '丙', label: '归还旧书', type: 'deadline', observation: '答应归还旧书', occurrenceTime: { date: '纪1年1月4日' }, dueTime: { date: '纪1年2月4日' }, projection: '不应显示约定推测', projectionTime: { date: '纪1年2月3日' }, assessmentReason: '不应显示约定依据不足', keywords: ['借书', '归还'] },
  ];
  const stoppedItems = [{ id: 'merged', observationKey: 'merged-key', status: 'paused', mergedInto: 'cycle', person: '甲', label: '归并项', observation: '重复观察内容', mergeDescription: '已合并到共同经历', occurrenceTime: { date: null }, dueTime: { date: null } }];
  const annualItems = [{ id: 'annual', person: '甲', label: '纪念日', status: '临近（3天后）', originalDate: '5月8日', nextDate: '2026-05-17', distance: 3, note: '重要纪念', }];
  let timeState = { status: 'completed', active: false, canOrganize: true, trackedItems, stoppedItems, annualItems, coverage: { checkedFloors: 4, totalFloors: 4 }, last: { status: 'completed' } };
  const listeners = new Set();
  const timeRuntime = { getState: () => structuredClone(timeState), subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, refreshStatus: async () => timeState };
  const container = new Node('main'), view = createV3FoundationView({ runtime, timeRuntime, documentRef });
  view.setPage('memories'); view.mount(container);
  await flatten(container).find(node => node.textContent === '近期事项（4）').click();
  const body = flatten(container).find(node => node.id === 'qqj-recent-items');
  const list = body.children.at(-1), text = flatten(list).map(node => node.textContent).join('|');
  assert.match(text, /甲 · 周期.*共同经历的整体影响.*轻微不适.*恢复中.*当前推测：可能开始缓解.*发生：纪1年2月3日.*预计周期日：纪1年2月8日.*推算至：纪1年2月5日/u);
  assert.equal(flatten(list.children[0]).some(node => node.tag === 'img'), false, '关键词通过文本节点展示，不解释为HTML');
  assert.ok(flatten(list.children[0]).some(node => node.textContent === '<img onerror>'));
  assert.doesNotMatch(text, /细节观察|1999-01-02|经过时间|已过 4 天|明确周期|旧推测|不再适用|本次未获得有效推测/u, 'projection存在时不堆叠观察、经过、旧预测和未返回状态');
  assert.match(text, /乙 · 未知起点.*说明/u);
  const unknownText = flatten(list.children[1]).map(node => node.textContent).join('|');
  assert.doesNotMatch(unknownText, /1999-01-03|发生：/u, '未知发生时间不冒用观察时间，也不生成空时间行');
  const deadlineText = flatten(list.children[2]).map(node => node.textContent).join('|');
  assert.match(deadlineText, /丙 · 归还旧书.*借书.*归还.*发生：纪1年1月4日.*约定时间：纪1年2月4日/u);
  assert.doesNotMatch(deadlineText, /不应显示约定推测|不应显示约定依据不足|推算至：/u, '约定显示发生时间和期限，不呈现自然进展估计');
  assert.equal(flatten(list.children[2]).find(node => node.textContent.includes('丙 · 归还旧书')).className.includes('error'), false, '约定事项隐藏依据不足时不保留错误标题色');
  await flatten(body).find(node => node.textContent === '查看停止项（1）').click();
  const stoppedList = body.children.at(-1), stoppedText = flatten(stoppedList).map(node => node.textContent).join('|');
  assert.match(stoppedText, /甲 · 归并项 · 已归并.*已合并到共同经历/u);
  assert.doesNotMatch(stoppedText, /重复观察内容/u, '有归并描述时不重复列出被归并成员观察');
  await flatten(body).find(node => node.textContent === '返回追踪中事项').click();
  const currentList = body.children.at(-1), currentText = flatten(currentList).map(node => node.textContent).join('|');
  assert.match(currentText, /甲 · 纪念日 · 临近（3天后）.*重要纪念.*原日期：5月8日.*本年日期：2026-05-17.*只读事项/u);
  assert.doesNotMatch(currentText, /还有 3 天/u, '年度状态保留日期结果，不展示经过天数');
  const entry = currentList.children[0], listUpdates = currentList.replaceCount;
  timeState = { ...timeState, trackedItems: [{ ...trackedItems[0], observationTime: { date: '2001-01-01' }, elapsedDays: 99, periodDays: 88, oldProjection: { text: '隐藏旧推测' } }, trackedItems[1], { ...trackedItems[2], keywords: ['不同关键词'] }] };
  for (const listener of listeners) listener(timeState);
  assert.notEqual(currentList.children[0], entry, '关键词变化更新近期事项DOM');
  assert.equal(currentList.replaceCount, listUpdates + 1);
  const updatedEntry = currentList.children[0], afterVisibleUpdate = currentList.replaceCount;
  timeState = { ...timeState, trackedItems: [{ ...trackedItems[0], observationTime: { date: '2001-01-01' }, elapsedDays: 99, periodDays: 88, oldProjection: { text: '隐藏旧推测' } }, trackedItems[1], { ...trackedItems[2], keywords: ['不同关键词'], assessmentReason: '隐藏依据变化' }] };
  for (const listener of listeners) listener(timeState);
  assert.equal(currentList.children[0], updatedEntry, '隐藏依据变化不替换近期事项DOM');
  assert.equal(currentList.replaceCount, afterVisibleUpdate);
  view.deactivate();
});

test('近期事项菜单确认取消零写，失败重试，同内容通知及迟到确认守卫', async () => {
  const css = await readFile(new URL('../src/ui/panel.css', import.meta.url), 'utf8');
  assert.match(css, /\.qqj-recent-item-head\{display:flex;align-items:center;gap:8px\}/u);
  assert.match(css, /\.qqj-recent-item-head>span\{flex:1;min-width:0;overflow-wrap:anywhere\}/u);
  assert.match(css, /\.qqj-recent-item-keywords\{display:flex;flex-wrap:wrap;gap:4px;margin:0\}/u);
  async function scenario() {
    const doc = eventDocument(), memoryListeners = new Set(), timeListeners = new Set();
    const floor = { floorId: 'floor', assistantSeq: 1, messageIndex: 0, status: 'ready', memoryId: 'memory', summary: '原摘要', memory: { summaryEvidenceRefs: [] }, cse: { status: 'ready', deltaId: 'delta' } };
    let state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', memorySnapshotStatus: 'ready', memorySyncStatus: 'idle', memoryWorkBusy: false, stableCount: 1, rememberedCount: 1, unprocessedCount: 0, floors: [floor] };
    let item = { id: 'item', observationKey: 'key', status: 'active', person: '甲', label: '擦伤', type: 'body', observation: '原观察', observationTime: { date: '2026-05-10' }, occurrenceTime: { date: null }, dueTime: { date: null }, elapsedHours: null, elapsedDays: null, observationElapsedHours: null, observationElapsedDays: 2, projection: null };
    let timeState = { status: 'completed', active: false, canOrganize: true, last: { status: 'completed', items: 1 }, trackedItems: [item], stoppedItems: [] }, writes = 0, fail = false, resolveConfirm, confirms = 0;
    const emitTime = () => { for (const listener of timeListeners) listener(timeState); };
    const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, subscribe(listener) { memoryListeners.add(listener); return () => memoryListeners.delete(listener); } };
    const timeRuntime = { getState: () => structuredClone(timeState), refreshStatus: async () => timeState, subscribe(listener) { timeListeners.add(listener); return () => timeListeners.delete(listener); }, async editItem(id, fields, key) {
      writes += 1; assert.equal(id, item.id); assert.equal(key, item.observationKey); assert.deepEqual(Object.keys(fields), ['status']);
      if (fail) { fail = false; throw new Error('mock status save failure'); }
      item = { ...item, ...fields, observationKey: 'saved-key', projection: null }; timeState = { ...timeState, trackedItems: [], stoppedItems: [item] }; emitTime(); return timeState;
    } };
    const container = new Node('main'), view = createV3FoundationView({ runtime, timeRuntime, documentRef: doc, confirmImpl: options => { confirms += 1; assert.equal(options.cancelText, '取消'); assert.match(options.body, /保存不调用模型/u); return new Promise(resolve => { resolveConfirm = resolve; }); } });
    view.setPage('memories'); view.mount(container); await flatten(container).find(node => node.textContent === '近期事项（1）').click();
    return { container, view, doc, writes: () => writes, confirms: () => confirms, failNext: () => { fail = true; }, confirm: value => resolveConfirm(value), emitTime,
      changeTime: patch => { timeState = { ...timeState, ...patch }; emitTime(); }, changeKey: () => { timeState = { ...timeState, trackedItems: [{ ...item, observationKey: 'new-key' }] }; emitTime(); },
      changeChat: () => { state = { ...state, chatId: 'another-chat' }; for (const listener of memoryListeners) listener(state); } };
  }
  const s = await scenario(), action = label => flatten(s.container).find(node => node.textContent === label);
  const menu = flatten(s.container).find(node => node.className === 'qqj-profile-menu'), entry = menu.parentNode.parentNode, list = entry.parentNode;
  const summaryMenu = flatten(s.container).find(node => node.className === 'qqj-memory-menu');
  list.scrollTop = 24; menu.open = true; let pending = action('完成').click(); assert.equal(menu.open, false);
  assert.equal(action('编辑事项').disabled, true); assert.equal(action('移除').disabled, true);
  await action('编辑事项').click(); assert.equal(action('保存事项'), undefined);
  s.emitTime(); assert.equal(flatten(s.container).find(node => node.className === 'qqj-profile-menu'), menu); assert.equal(list.children[0], entry); assert.equal(list.scrollTop, 24);
  s.confirm(false); await pending; assert.equal(s.writes(), 0); assert.equal(action('完成').disabled, false);
  s.failNext(); pending = action('完成').click(); s.confirm(true); await pending; assert.equal(s.writes(), 1); assert.match(flatten(entry).map(node => node.textContent).join('|'), /保存失败/u);
  assert.equal(action('完成').disabled, false); pending = action('完成').click(); s.confirm(true); await pending; assert.equal(s.writes(), 2);
  assert.equal(action('确认保存'), undefined); assert.equal(action('保存事项'), undefined);
  summaryMenu.open = true; s.doc.click({ composedPath: () => [] }); assert.equal(summaryMenu.open, false, '局部时间清单更新保留摘要菜单的外部关闭注册');
  assert.equal(s.doc.clickListenerCount(), 1); s.view.deactivate(); assert.equal(s.doc.clickListenerCount(), 0);
  for (const mutation of ['chat', 'key', 'busy', 'page']) {
    const late = await scenario(); const pending = flatten(late.container).find(node => node.textContent === '移除').click();
    if (mutation === 'chat') late.changeChat(); else if (mutation === 'key') late.changeKey(); else if (mutation === 'busy') late.changeTime({ active: true, canOrganize: false }); else late.view.setPage('management');
    late.confirm(true); await pending; assert.equal(late.writes(), 0, `${mutation}变化后旧确认不保存`); late.view.deactivate();
  }
});

test('近期事项批量勾选当前列表或问题项，年度设定保持只读且一次提交', async () => {
  let memoryState = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', memorySnapshotStatus: 'ready', memorySyncStatus: 'idle', memoryWorkBusy: false, floors: [] };
  const memoryListeners = new Set(), timeListeners = new Set(), calls = [];
  const item = (id, extra = {}) => ({ id, observationKey: `key-${id}`, status: 'active', person: '甲', label: id, type: 'body', observation: `${id}观察`, observationTime: { date: '2026-05-10' }, occurrenceTime: { date: null }, dueTime: { date: null }, elapsedHours: null, elapsedDays: null, observationElapsedHours: null, observationElapsedDays: 2, projection: null, ...extra });
  let timeState = { status: 'completed', active: false, canOrganize: true, trackedItems: [item('健康'), item('失败', { failureReason: '来源无效' }), item('不足', { assessmentReason: '时间不明' })], stoppedItems: [], annualItems: [{ id: 'annual', person: '甲', label: '生日', status: '休眠', originalDate: '8月1日' }] };
  const emitTime = () => { for (const listener of timeListeners) listener(timeState); };
  const runtime = { getState: () => memoryState, refreshStatus: async () => memoryState, confirmLatest: async () => memoryState, subscribe(listener) { memoryListeners.add(listener); return () => memoryListeners.delete(listener); } };
  const timeRuntime = { getState: () => structuredClone(timeState), refreshStatus: async () => timeState, subscribe(listener) { timeListeners.add(listener); return () => timeListeners.delete(listener); },
    async editItems(edits) { calls.push(structuredClone(edits)); const ids = new Set(edits.map(edit => edit.itemId)); const stopped = timeState.trackedItems.filter(value => ids.has(value.id)).map(value => ({ ...value, status: edits.find(edit => edit.itemId === value.id).fields.status, observationKey: `${value.observationKey}-saved` })); timeState = { ...timeState, trackedItems: timeState.trackedItems.filter(value => !ids.has(value.id)), stoppedItems: stopped }; emitTime(); return timeState; },
    async editItem() { throw new Error('批量路径不应循环调用 editItem'); } };
  const container = new Node('main'), view = createV3FoundationView({ runtime, timeRuntime, documentRef, confirmImpl: () => true }); view.setPage('memories'); view.mount(container);
  await flatten(container).find(node => node.textContent === '近期事项（4）').click(); await flatten(container).find(node => node.textContent === '批量管理').click();
  assert.equal(flatten(container).filter(node => node.className === 'qqj-recent-item-select').length, 3, '年度设定没有复选框');
  await flatten(container).find(node => node.textContent === '选择问题项').click();
  const checks = flatten(container).filter(node => node.className === 'qqj-recent-item-select');assert.deepEqual(checks.map(node => node.checked), [false, true, true]);
  assert.ok(flatten(container).some(node => node.textContent === '批量完成'));assert.ok(flatten(container).some(node => node.textContent === '批量移除'));
  await flatten(container).find(node => node.textContent === '批量暂停').click();assert.equal(calls.length, 1);assert.deepEqual(calls[0].map(edit => edit.itemId), ['失败', '不足']);assert.ok(calls[0].every(edit => edit.fields.status === 'paused'));
  await flatten(container).find(node => node.textContent === '批量管理').click();await flatten(container).find(node => node.textContent === '选择当前列表').click();
  assert.equal(flatten(container).filter(node => node.className === 'qqj-recent-item-select' && node.checked).length, 1);assert.match(flatten(container).map(node => node.textContent).join('|'), /甲 · 生日 · 休眠.*只读事项/u);
  memoryState = { ...memoryState, chatId: 'new-chat' };for (const listener of memoryListeners) listener(memoryState);
  assert.equal(flatten(container).some(node => node.className === 'qqj-recent-item-select'), false, '切聊天清空批量模式与选择');view.deactivate();
});

test('管理视图先显示壳并在激活时自动刷新，只在管理页提供手工刷新', async () => {
  let release;
  let refreshes = 0;
  const base = {
    status: 'idle', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT,
    foundationStatus: 'uninitialized', stableCount: 2, pending: { assistantSeq: 3, messageIndex: 5 },
    stableBoundary: { assistantSeq: 2 }, headCheckpointId: null, activeRun: null, lastRun: null,
    lastError: null, unreachableCount: 0, metrics: {},
  };
  const runtime = {
    getState: () => base,
    refreshStatus: () => { refreshes += 1; return new Promise(resolve => { release = () => resolve({ ...base, status: 'ready', foundationStatus: 'ready' }); }); },
    confirmLatest: async () => ({ ...base, status: 'ready', stableCount: 3, pending: null }),
  };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef });
  view.mount(container);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /记忆管理/);
  const activation = view.activate();
  assert.equal(refreshes, 1);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /记忆管理/);
  release();
  await activation;
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /刷新状态/);
  assert.doesNotMatch(copy, /确认最新 AI 楼|提取下一个未处理楼|分析下一楼人物状态/);
  assert.match(copy, /补齐缺失.*完全重构/);
});

test('未建档聊天的空同步 ID 不误锁刷新与显式补齐', async () => {
  const state = {
    status: 'uninitialized', pluginEnabled: true, chatId: null, headCheckpointId: null,
    foundationStatus: 'uninitialized', memorySnapshotStatus: 'ready', memorySyncStatus: 'idle',
    stableCount: 0, rememberedCount: 0, unprocessedCount: 0, pending: null, activeRun: null,
    memoryWorkBusy: false, activeAutoMemory: null, activeExtraction: null, activeCse: null,
    lastError: null, lastExtractorError: null, lastCseError: null,
    rebuildStatus: 'pendingRebuild', rebuildHasActionableWork: true, floors: [],
  };
  let refreshes = 0, rebuilds = 0;
  const runtime = {
    getState: () => state,
    refreshStatus: async () => { refreshes += 1; return state; },
    confirmLatest: async () => state,
    startHistoricalRebuild: async () => { rebuilds += 1; return state; },
  };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef });
  view.mount(container);

  let refresh = flatten(container).find(node => node.textContent === '刷新状态');
  let rebuild = flatten(container).find(node => node.textContent === '补齐缺失');
  assert.equal(refresh?.disabled, false, '空同步 ID 不代表当前聊天正在同步');
  assert.equal(rebuild?.disabled, false, '未建档聊天必须保留显式建档入口');

  refresh.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshes, 1, '刷新仍只调用既有 refreshStatus');

  rebuild = flatten(container).find(node => node.textContent === '补齐缺失');
  rebuild.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rebuilds, 1, '补齐仍调用既有 startHistoricalRebuild');
});

test('补齐与完全重构用标准两按钮选择本次模式，关闭时不开始任务或删除', async () => {
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', memorySnapshotStatus: 'ready', memorySyncStatus: 'idle',
    stableCount: 20, rememberedCount: 0, unprocessedCount: 20, memoryWorkBusy: false, activeAutoMemory: null, activeExtraction: null, activeCse: null,
    rebuildStatus: 'pendingRebuild', rebuildHasActionableWork: true, cseRebuildStatus: 'idle', floors: [] };
  const starts = [], resets = [], dialogs = [], selections = [true, false, null, null];
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state,
    startHistoricalRebuild: async options => { starts.push(options); return state; } };
  const chooseImpl = async options => { dialogs.push(options); return selections.shift(); };
  const memoryManagement = { getState: () => ({}), deleteCurrent: async () => ({}), fullRebuild: async (chatId, options) => { resets.push([chatId, options]); return state; } };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, memoryManagement, documentRef, chooseImpl }); view.mount(container);
  await flatten(container).find(node => node.textContent === '补齐缺失').click();
  await new Promise(resolve => setImmediate(resolve));
  await flatten(container).find(node => node.textContent === '完全重构').click();
  await new Promise(resolve => setImmediate(resolve));
  await flatten(container).find(node => node.textContent === '补齐缺失').click();
  await new Promise(resolve => setImmediate(resolve));
  await flatten(container).find(node => node.textContent === '完全重构').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(starts, [{ aggregate: true }]);
  assert.deepEqual(resets, [[CHAT, { aggregate: false }]]);
  assert.equal(dialogs.length, 4);
  for (const dialog of dialogs) {
    assert.deepEqual(dialog.choices, [
      { value: false, label: '否（普通逐楼模式）' },
      { value: true, label: '是（高楼压缩模式）', primary: true },
    ]);
    assert.match(dialog.note, /关闭窗口不开始任务/u);
  }
  assert.match(dialogs[1].body, /删除本聊天全部千千结记录.*所有人工修改都会清除/u, '完全重构必须保留清空警告');
});

test('未建立记忆按现有历史与自动摘要开关提示，三页均不把正常空态报错', () => {
  for (const [extra, expected] of [
    [{ inspectedStableCount: 0, autoMemoryEnabled: true }, /尚未开始记录，继续对话后可开始记录/],
    [{ inspectedStableCount: 3, canInitialize: true }, /尚未建立记忆.*补齐缺失.*已有楼层/],
    [{ inspectedStableCount: 0, autoMemoryEnabled: false }, /自动摘要已关闭.*手动“补齐缺失”/],
  ]) {
    const state = { status: 'uninitialized', foundationStatus: 'uninitialized', pluginEnabled: true, chatId: null, floors: [], memorySnapshotStatus: 'ready', memorySyncStatus: 'idle', ...extra };
    const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
    const container = new Node('main'); const view = createV3FoundationView({ runtime, documentRef }); view.mount(container);
    for (const page of ['management', 'memories', 'people']) {
      view.setPage(page);
      const health = flatten(container).find(node => node.className.split(' ').includes('qqj-page-health'));
      assert.match(health.textContent, expected); assert.doesNotMatch(health.className, /error/);
      assert.doesNotMatch(flatten(container).map(node => node.textContent).join('|'), /尚未建立记忆身份|尚未建立.*chatId/);
    }
  }
});

test('记忆页idle时先准备身份；无聊天保持待记录，身份创建失败明确反馈且不读取记忆', async () => {
  for (const outcome of [{ status: 'idle' }, new Error('聊天身份保存失败，请检查聊天存档。')]) {
    const state = { status: 'idle', foundationStatus: 'uninitialized', pluginEnabled: true, chatId: null, floors: [], lastError: null };
    let refreshes = 0, prepares = 0;
    const runtime = { getState: () => state, refreshStatus: async () => { refreshes += 1; return state; }, prepareCurrent: async () => { refreshes += 1; return state; }, confirmLatest: async () => state };
    const container = new Node('main');
    const view = createV3FoundationView({ runtime, documentRef, sessionStateProvider: () => ({ status: 'idle' }), prepareSession: async () => {
      prepares += 1; if (outcome instanceof Error) throw outcome; return outcome;
    } });
    view.setPage('management'); view.mount(container);
    const result = await view.activate();
    assert.equal(prepares, 1);
    assert.equal(refreshes, 0, '身份未就绪时不触发记忆后端读取');
    if (outcome instanceof Error) {
      assert.equal(result.status, 'error');
      assert.match(flatten(container).map(node => node.textContent).join('|'), /聊天身份准备失败：聊天身份保存失败/u);
    } else {
      assert.deepEqual(result, { status: 'uninitialized' });
      assert.match(flatten(container).map(node => node.textContent).join('|'), /尚未开始记录，继续对话后可开始记录/u);
      assert.doesNotMatch(flatten(container).map(node => node.textContent).join('|'), /读取失败/u);
    }
    view.deactivate();
  }
});

test('记忆页身份准备错误缺少具体说明时指向状态诊断', async () => {
  const state = { status: 'idle', foundationStatus: 'uninitialized', pluginEnabled: true, chatId: null, floors: [], lastError: null };
  const runtime = { getState: () => state, refreshStatus: async () => state, prepareCurrent: async () => state, confirmLatest: async () => state };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef, sessionStateProvider: () => ({ status: 'idle' }), prepareSession: async () => { throw new Error(''); } });
  view.setPage('management'); view.mount(container);
  assert.equal((await view.activate()).status, 'error');
  assert.match(flatten(container).map(node => node.textContent).join('|'), /聊天身份准备失败：请到“记忆管理”页点击“复制状态诊断”反馈/u);
});

test('未建记忆的真实身份或后端错误不包装成新档提示或摘要提取失败', () => {
  for (const identityError of [true, false]) {
    const error = new Error('后端身份绑定读取失败');
    const state = { status: identityError ? 'uninitialized' : 'error', foundationStatus: 'uninitialized', pluginEnabled: true, chatId: null, floors: [], lastError: identityError ? null : error };
    const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
    const container = new Node('main'); const view = createV3FoundationView({ runtime, documentRef, sessionStateProvider: () => identityError ? { status: 'error', error } : { status: 'ready' } }); view.mount(container);
    for (const page of ['management', 'memories', 'people']) {
      view.setPage(page);
      const health = flatten(container).find(node => node.className.split(' ').includes('qqj-page-health'));
      assert.match(health.textContent, /后端身份绑定读取失败/); assert.match(health.className, /error/);
      assert.doesNotMatch(health.textContent, /尚未开始记录|摘要提取失败/);
    }
  }
});

test('needsReview 终态显示准确中文和安全原因，不向页面泄露内部状态值', async () => {
  const memory = { chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const state = { status: 'needsReview', pluginEnabled: true, chatId: CHAT, foundationStatus: 'needsReview', reviewReason: { code: 'fingerprintMismatch', assistantSeq: 12, messageIndex: 23, expectedCount: 12, actualCount: 12, markerStatus: 'none', rawFingerprintMatches: false, canonicalFingerprintMatches: false, sanitizerFingerprintMatches: true }, stableCount: 1, rememberedCount: 1, unprocessedCount: 0, pending: null, headCheckpointId: null, lastError: null, lastExtractorError: null, lastCseError: null, floors: [{ floorId: 'floor', assistantSeq: 1, messageIndex: 2, status: 'ready', memoryId: 'memory', summary: 'needsReview 下仍可见的摘要', summarySource: 'ai', aiSummary: 'needsReview 下仍可见的摘要', counts: {}, memory }], memoryEntities: [{ entityId: 'p1', displayName: '裴晚生' }], cseSubjects: [{ subjectEntityId: 'p1', displayName: '裴晚生', core: [], adaptive: [], situational: [{ text: 'needsReview 下仍可见的人物状态', visibility: 'private', reason: '当时证据', sourceAssistantSeq: 1 }] }], memoryWorkBusy: false, cseReady: true, csePendingCount: 0, cseFailedCount: 0 };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, peopleRuntime: peopleRuntime([{ entityId: 'p1', displayName: '裴晚生' }]), documentRef }); view.mount(container); await view.activate();
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /需要核对当前聊天记忆/); assert.match(copy, /待核对原因.*楼正文指纹不一致.*实际第 23 楼.*记录 12 \/ 当前 12.*消息标识：无.*不一致：原始正文、清洗后正文/); assert.doesNotMatch(copy, /不一致：[^|]*清洗规则/); assert.match(copy, /最近记忆错误.*无/); assert.doesNotMatch(copy, /needsReview|fingerprintMismatch|AI序号/);
  assert.match(copy, /请先点击“刷新状态”.*现有记忆会保留、正文可继续.*复制诊断反馈/);
  view.setPage('memories'); assert.match(flatten(container).map(node => node.textContent).join('|'), /needsReview 下仍可见的摘要/);
  view.setPage('people'); assert.match(flatten(container).map(node => node.textContent).join('|'), /needsReview 下仍可见的人物状态/);
});

test('无正文分支冲突在待核对文案与状态诊断中区分标识指向外部楼和多楼共用标识', async () => {
  let copied = '';
  const base = { status: 'needsReview', pluginEnabled: true, chatId: CHAT, foundationStatus: 'needsReview', memorySnapshotStatus: 'ready', memorySyncStatus: 'idle',
    stableCount: 4, rememberedCount: 2, unprocessedCount: 2, memoryWorkBusy: false, activeAutoMemory: null, activeExtraction: null, activeCse: null,
    rebuildStatus: 'notReady', cseRebuildStatus: 'idle', floors: [] };
  let state = { ...base, reviewReason: { code: 'markerMismatch', assistantSeq: 3, messageIndex: 8, expectedCount: 4, actualCount: 4, markerStatus: 'valid', bindingIssue: 'markerConflict' } };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef, navigatorRef: { clipboard: { writeText: async value => { copied = value; } } } }); view.mount(container);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /绑定冲突：消息标识指向当前记录之外的楼/u);
  await flatten(container).find(node => node.textContent === '复制状态诊断').click();
  await new Promise(resolve => setImmediate(resolve));
  let diagnostic = JSON.parse(copied).foundation.reviewReason;
  assert.deepEqual(diagnostic, { present: true, code: 'markerMismatch', assistantSeq: 3, messageIndex: 8, expectedCount: 4, actualCount: 4, markerStatus: 'valid', bindingIssue: 'markerConflict' });
  assert.doesNotMatch(copied, new RegExp(CHAT, 'u'));
  assert.doesNotMatch(copied, /floorId|聊天正文/u);

  state = { ...base, reviewReason: { code: 'markerMismatch', assistantSeq: 2, messageIndex: 6, expectedCount: 4, actualCount: 4, markerStatus: 'valid', bindingIssue: 'duplicateMarker' } };
  view.render(state);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /绑定冲突：多楼共用同一标识/u);
  await flatten(container).find(node => node.textContent === '复制状态诊断').click();
  await new Promise(resolve => setImmediate(resolve));
  diagnostic = JSON.parse(copied).foundation.reviewReason;
  assert.equal(diagnostic.bindingIssue, 'duplicateMarker');
});

test('状态诊断复制按钮包含安全的身份准备与总开关原始失败，并在恢复后清除', async () => {
  const state = { status: 'idle', pluginEnabled: false, floors: [] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  let sessionState = { status: 'error', preparationFailure: { prepareStep: 'snapshotClone', name: 'DataCloneError', code: 25, detail: 'contextCapture', location: 'src/chat-session.js:88:7', message: 'SECRET_BODY https://private.invalid/id' } };
  let pluginDiagnostic = { phase: 'pluginEnable', failure: { name: 'TypeError', code: 'CHAT_SESSION_NOT_READY', httpStatus: 503, prepareStep: 'identityDirectory', detail: 'contextCapture', location: 'index.js:92:4', message: 'SECRET_TOKEN' } };
  let copied = '';
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef, sessionStateProvider: () => sessionState,
    pluginDiagnosticProvider: () => pluginDiagnostic,
    navigatorRef: { clipboard: { writeText: async value => { copied = value; } } } });
  view.mount(container);
  await flatten(container).find(node => node.textContent === '复制状态诊断').click();
  await new Promise(resolve => setImmediate(resolve));
  let diagnostic = JSON.parse(copied);
  assert.deepEqual(diagnostic.identity.preparationFailure, { present: true, name: 'DataCloneError', code: 25, prepareStep: 'snapshotClone', detail: null, location: 'src/chat-session.js:88:7' });
  assert.deepEqual(diagnostic.pluginLifecycle, { phase: 'pluginEnable', failure: { present: true, name: 'TypeError', code: 'CHAT_SESSION_NOT_READY', httpStatus: 503, prepareStep: 'identityDirectory', detail: null, location: 'index.js:92:4' } });
  assert.doesNotMatch(copied, /SECRET_BODY|SECRET_TOKEN|private\.invalid/u);
  sessionState = { status: 'ready' }; pluginDiagnostic = null;
  await flatten(container).find(node => node.textContent === '复制状态诊断').click();
  await new Promise(resolve => setImmediate(resolve));
  diagnostic = JSON.parse(copied);
  assert.deepEqual(diagnostic.identity.preparationFailure, { present: false });
  assert.deepEqual(diagnostic.pluginLifecycle, { phase: 'unknown', failure: { present: false } });
  view.deactivate();
});

test('完整诊断必须显式确认，clipboard 不可用时显示可选择文本框', async () => {
  let confirmed = false;
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const state = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'checkpoint', activeRun: null, lastRun: null, lastError: null, unreachableCount: 0, metrics: {}, floors: [{ floorId: 'floor', assistantSeq: 1, messageIndex: 2, status: 'ready', memoryId: 'memory', summary: '摘要', summarySource: 'ai', aiSummary: '摘要', extractorVersion: 'v', counts: {}, api: null, memory }] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state, editSummary: async () => state, restoreAi: async () => state, markError: async () => state, copySafeDiagnostic: () => '{"safe":true}', copyFullDiagnostic: () => '{"canonicalContent":"原文"}' };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef, navigatorRef: {}, confirmImpl: () => confirmed }); view.mount(container);
  const floorDrawer = flatten(container).find(node => node.className.includes('qqj-floor-diagnostics'));
  assert.ok(floorDrawer); assert.equal(floorDrawer.open, false, '楼层诊断默认折叠');
  assert.ok(flatten(floorDrawer).some(node => node.textContent === '楼层诊断'));
  assert.equal(flatten(floorDrawer).filter(node => node.className === 'qqj-diagnostic-row').length, 1);
  floorDrawer.open = true; floorDrawer.fire('toggle'); view.render(state);
  assert.equal(flatten(container).find(node => node.className.includes('qqj-floor-diagnostics')).open, true, '刷新状态保留展开选择');
  let full = flatten(container).find(node => node.textContent === '复制完整诊断'); full.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(flatten(container).some(node => node.className === 'v3-diagnostic-fallback'), false);
  confirmed = true; full = flatten(container).find(node => node.textContent === '复制完整诊断'); full.click(); await new Promise(resolve => setImmediate(resolve));
  const fallback = flatten(container).find(node => node.className === 'v3-diagnostic-fallback'); assert.match(fallback.value, /canonicalContent/);
});

test('没有摘要楼时仍可复制界面滚动诊断，并复用只读文本框fallback', async () => {
  const state = { status: 'idle', pluginEnabled: true, chatId: null, foundationStatus: 'uninitialized', stableCount: 0, rememberedCount: 0, unprocessedCount: 0, pending: null, activeRun: null, lastError: null, floors: [], rebuildStatus: 'caughtUp' };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  let reads = 0;
  const uiDiagnosticProvider = () => { reads += 1; return '{"schemaVersion":1,"records":[]}'; };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, uiDiagnosticProvider, documentRef, navigatorRef: { clipboard: { writeText: async () => { throw new Error('clipboard denied'); } } } }); view.mount(container);
  const button = flatten(container).find(node => node.textContent === '复制界面诊断');
  assert.ok(button, '界面诊断入口不应依赖已存在的摘要楼');
  assert.match(flatten(container).map(node => node.textContent).join('|'), /不含聊天正文或输入内容/);
  button.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  const fallback = flatten(container).find(node => node.className === 'v3-diagnostic-fallback');
  assert.equal(fallback?.readOnly, true); assert.match(fallback?.value ?? '', /"records":\[\]/);
});

test('状态诊断在无可刷新状态与同步删除灰态仍可复制即时白名单，fallback 保持可选中', async () => {
  const privateText = 'PRIVATE_BODY_SENTINEL_20260911';
  const rawChatId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const rawHeadId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  let memoryState = {
    status: 'running', foundationStatus: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: rawChatId, headCheckpointId: rawHeadId,
    memorySnapshotStatus: 'ready', memorySyncStatus: 'syncing', rebuildStatus: 'pendingRebuild', rememberedCount: 2, stableCount: 5, unprocessedCount: 3,
    memoryWorkBusy: true, activeRun: { id: 'foundation-run-private', phase: 'capturing', reason: privateText },
    activeMemoryWork: { kind: 'auto', phase: 'reconciling', reason: privateText, floorIds: ['private-floor'] },
    activeExtraction: { phase: 'extracting', floorId: 'private-floor', runId: 'private-run' },
    activeAutoMemory: { kind: 'private-kind', phase: 'analyzingCse', mode: 'historical', floorIds: ['private-floor'] },
    activeCse: { phase: 'committing', floorId: 'private-floor', runId: 'private-cse-run' },
    memorySyncError: { name: 'TimeoutError', code: 'BACKEND_TIMEOUT', message: privateText },
    lastError: { name: 'PrivateErrorName', code: `FREE_${privateText}`, message: privateText, stack: privateText },
    lastExtractorError: { name: 'TypeError', code: 'V3_EXTRACTOR_FAILED', httpStatus: 429, message: privateText, providerError: privateText },
    lastAutomationError: { name: 'Error', code: 'V3_AUTO_MEMORY_FAILED', message: privateText },
    lastCseError: { name: 'Error', code: 'V3_CSE_FORMAT_INVALID', message: privateText, validationErrors: [privateText] },
    cseRebuildStatus: 'running', floors: [{ floorId: 'private-floor', memoryId: 'private-memory', summary: privateText, canonicalFingerprint: privateText }],
  };
  let identityState = { status: 'preparing', identity: { chatId: rawChatId, hostChatId: privateText }, error: Object.assign(new Error(privateText), { code: 'QQJ_CHAT_BINDING_CONFLICT', httpStatus: 409 }) };
  let recallState = { recallStatus: 'running', activeRecall: { phase: 'selecting', token: privateText, chatId: rawChatId }, lastRecallError: Object.assign(new Error(privateText), { code: 'QQJ_TIMEOUT', httpStatus: 504 }) };
  const vectorState = { status: 'error', buildDiagnostic: { status: 'failed', phase: 'embedding', batchNumber: 2, completedChunks: 16, totalChunks: 57,
    inputCount: 16, inputCharacters: 6400, longestInputCharacters: 400, errorCode: 'VECTOR_HTTP_ERROR', httpStatus: 400,
    request: { requestId: 'b5c5f920-53b0-4c6c-9be0-2b7b', phase: 'response', pendingStage: 'response_headers', elapsedMs: 91, deadlineMs: 30000,
      httpStatus: 400, providerRequestId: 'sc_trace_20261010_12345678', providerError: { code: 'invalid_dimensions', type: 'invalid_request_error', param: 'dimensions', message: privateText },
      key: privateText, body: privateText, url: 'https://private.invalid' } } };
  let managementState = { status: 'deleting', phase: 'deletingRecords', workBusy: true, error: privateText, targetChatId: rawChatId };
  let backendState = { sinceClientCreatedRequestCounts: { get: 2, put: 1, delete: 0 }, latestRead: null, latestWrite: null, lastFailure: null,
    coreCache: { available: true, hits: 271, misses: 0, corruptions: 0, writes: 4, writeFailures: 0, evictedRecords: 0, estimatedBytes: 123456 } };
  const listeners = new Set(); let refreshes = 0, sessionReads = 0, backendReads = 0, recallReads = 0, managementReads = 0;
  const runtime = {
    getState: () => memoryState,
    refreshStatus: async () => { refreshes += 1; return memoryState; },
    confirmLatest: async () => memoryState,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const recallRuntime = { getState: () => { recallReads += 1; return recallState; } };
  const vectorRuntime = { getState: () => vectorState };
  const memoryManagement = { getState: () => { managementReads += 1; return managementState; }, deleteCurrent: async () => managementState };
  const container = new Node('main');
  const view = createV3FoundationView({
    runtime, recallRuntime, vectorRuntime, memoryManagement, pluginVersion: '0.1.9-test',
    sessionStateProvider: () => { sessionReads += 1; return identityState; },
    backendDiagnosticProvider: () => { backendReads += 1; return backendState; },
    documentRef, navigatorRef: { clipboard: { writeText: async () => { throw new Error('clipboard denied'); } } },
  });
  view.mount(container);
  const ordinaryInput = new Node('textarea'); container.children[0].append(ordinaryInput);
  memoryState = { ...memoryState, memorySnapshotStatus: 'syncing' };
  for (const listener of listeners) listener(memoryState);
  const refresh = flatten(container).find(node => node.textContent === '刷新状态');
  let copyState = flatten(container).find(node => node.textContent === '复制状态诊断');
  assert.equal(refresh.disabled, true, '业务刷新在 busy/delete 灰态保持禁用');
  assert.ok(copyState); assert.equal(copyState.disabled, false, '状态诊断在同步灰态仍可点击');
  assert.equal(ordinaryInput.disabled, true, '同步遮罩仍禁用普通业务输入');

  copyState.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshes, 0, '复制状态不得触发业务刷新');
  assert.ok(sessionReads >= 1 && backendReads >= 1 && recallReads >= 1 && managementReads >= 1, '复制时必须即时读取现有 getter');
  let fallback = flatten(container).find(node => node.className === 'v3-diagnostic-fallback');
  assert.equal(fallback?.readOnly, true); assert.equal(fallback?.disabled, false, '同步遮罩不得禁用只读复制 fallback');
  let diagnostic = JSON.parse(fallback.value);
  assert.equal(diagnostic.formatVersion, 2); assert.equal(diagnostic.pluginVersion, '0.1.9-test'); assert.match(diagnostic.capturedAt, /^\d{4}-/);
  assert.deepEqual(diagnostic.backend, backendState);
  assert.deepEqual(diagnostic.identity, { status: 'preparing', identityPresent: true, error: { present: true, name: 'Error', code: 'QQJ_CHAT_BINDING_CONFLICT', httpStatus: 409 }, preparationFailure: { present: false } });
  assert.equal(diagnostic.foundation.chatIdPresent, true); assert.equal(diagnostic.foundation.headCheckpointPresent, true); assert.equal(diagnostic.foundation.activeRun.phase, 'capturing');
  assert.deepEqual(diagnostic.foundation.lastError, { present: true });
  assert.equal(diagnostic.memory.activeMemoryWork.kind, 'auto'); assert.equal(diagnostic.memory.activeMemoryWork.phase, 'reconciling');
  assert.equal(diagnostic.memory.activeExtraction.phase, 'extracting'); assert.equal(Object.hasOwn(diagnostic.memory.activeAutoMemory, 'kind'), false); assert.equal(diagnostic.memory.activeAutoMemory.phase, 'analyzingCse');
  assert.deepEqual(diagnostic.memory.syncError, { present: true, name: 'TimeoutError', code: 'BACKEND_TIMEOUT' });
  assert.deepEqual(diagnostic.memory.lastExtractorError, { present: true, name: 'TypeError', code: 'V3_EXTRACTOR_FAILED', httpStatus: 429 });
  assert.deepEqual(diagnostic.memory.lastAutomationError, { present: true, name: 'Error', code: 'V3_AUTO_MEMORY_FAILED', prepareStep: null, detail: null, location: null, lastFailedAt: null });
  assert.equal(diagnostic.cse.active.phase, 'committing'); assert.equal(diagnostic.recall.active.phase, 'selecting');
  assert.deepEqual(diagnostic.management, { status: 'deleting', phase: 'deletingRecords', workBusy: true, error: { present: true } });
  assert.deepEqual(diagnostic.vector.build, { status: 'failed', phase: 'embedding', batchNumber: 2, completedChunks: 16, totalChunks: 57,
    inputCount: 16, inputCharacters: 6400, longestInputCharacters: 400, errorCode: 'VECTOR_HTTP_ERROR', httpStatus: 400,
    request: { requestId: 'b5c5f920-53b0-4c6c-9be0-2b7b', phase: 'response', pendingStage: 'response_headers', elapsedMs: 91, deadlineMs: 30000,
      httpStatus: 400, errorCode: null, providerRequestId: 'sc_trace_20261010_12345678', providerError: { code: 'invalid_dimensions', type: 'invalid_request_error', param: 'dimensions' },
      fetchCallMs: 'unknown', responseHeadersMs: 'unknown', responseBodyMs: 'unknown' } });
  assert.deepEqual(diagnostic.ui, { syncingOverlayActive: true, workBusy: true, deleting: true, deletePending: false });
  const serialized = JSON.stringify(diagnostic);
  assert.doesNotMatch(serialized, new RegExp(`${privateText}|${rawChatId}|${rawHeadId}|private-floor|private-run|private-memory|private\.invalid`));
  assert.equal(Object.hasOwn(diagnostic.identity, 'identity'), false); assert.equal(Object.hasOwn(diagnostic.foundation, 'chatId'), false); assert.equal(Object.hasOwn(diagnostic.foundation, 'headCheckpointId'), false);

  memoryState = { ...memoryState, activeMemoryWork: { ...memoryState.activeMemoryWork, phase: 'committing' }, activeAutoMemory: { ...memoryState.activeAutoMemory, phase: privateText } };
  identityState = { status: 'error', error: { name: 'RangeError', code: 'CHAT_SESSION_PERSIST_FAILED', message: privateText } };
  recallState = { ...recallState, activeRecall: { ...recallState.activeRecall, phase: 'receipt' } };
  managementState = { ...managementState, status: 'failed', phase: null };
  backendState = { ...backendState, latestRead: { sequence: 4, method: 'GET', recordType: 'root', elapsedMs: 7, completedAt: '2026-09-12T00:00:00.000Z', outcome: 'success' } };
  copyState = flatten(container).find(node => node.textContent === '复制状态诊断'); copyState.click(); await new Promise(resolve => setImmediate(resolve));
  fallback = flatten(container).find(node => node.className === 'v3-diagnostic-fallback'); diagnostic = JSON.parse(fallback.value);
  assert.equal(diagnostic.identity.status, 'error'); assert.equal(diagnostic.identity.identityPresent, false); assert.equal(diagnostic.identity.error.code, 'CHAT_SESSION_PERSIST_FAILED');
  assert.equal(diagnostic.memory.activeMemoryWork.phase, 'committing'); assert.equal(diagnostic.memory.activeAutoMemory.phase, 'unknown'); assert.equal(diagnostic.recall.active.phase, 'receipt');
  assert.equal(diagnostic.management.status, 'failed'); assert.equal(diagnostic.management.phase, null); assert.equal(diagnostic.ui.deletePending, true);
  assert.deepEqual(diagnostic.backend, backendState, '每次复制都应读取最新后端安全快照');
});

test('无 chat 与无状态 provider 仍提供状态诊断，复制不会抢占正在激活的业务回显', async () => {
  let release;
  let state = { status: 'idle', pluginEnabled: true, chatId: null, headCheckpointId: null, foundationStatus: 'uninitialized', stableCount: 0, rememberedCount: 0, memoryWorkBusy: false, floors: [], rebuildStatus: 'caughtUp' };
  const runtime = {
    getState: () => state,
    refreshStatus: () => new Promise(resolve => { release = resolve; }),
    confirmLatest: async () => state,
  };
  const copied = [];
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef, navigatorRef: { clipboard: { writeText: async value => { copied.push(value); } } } });
  view.mount(container);
  const activation = view.activate();
  const copyState = flatten(container).find(node => node.textContent === '复制状态诊断');
  assert.ok(copyState, '状态诊断入口不依赖 chatId 或摘要楼'); assert.equal(copyState.disabled, false);
  copyState.click(); await new Promise(resolve => setImmediate(resolve));
  const diagnostic = JSON.parse(copied[0]);
  assert.equal(diagnostic.backend, null);
  assert.equal(diagnostic.identity.status, 'unknown'); assert.equal(diagnostic.identity.identityPresent, 'unknown'); assert.equal(diagnostic.recall.status, 'unknown'); assert.equal(diagnostic.management.status, 'unknown');
  state = { ...state, status: 'ready', foundationStatus: 'ready' }; release(state);
  const result = await activation;
  assert.equal(result.status, 'ready', '只读复制不得递增业务 epoch 使激活结果变 stale');
  assert.match(flatten(container).map(node => node.textContent).join('|'), /记忆状态已刷新/);
});

test('四项破坏性记忆操作等待异步确认，取消时零业务动作', async () => {
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const floor = { floorId: 'floor', assistantSeq: 1, messageIndex: 2, status: 'ready', memoryId: 'memory', summary: '摘要', summarySource: 'ai', aiSummary: '摘要', extractorVersion: 'v', counts: {}, api: null, memory, cse: { status: 'ready', deltaId: 'delta' } };
  const state = { status: 'ready', pluginEnabled: true, chatId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'checkpoint', activeRun: null, activeExtraction: null, activeCse: null, memoryWorkBusy: false, activeAutoMemory: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, cseReady: true, csePendingCount: 0, cseFailedCount: 0, baselineId: 'baseline', cseSubjects: [], floors: [floor] };
  const calls = [];
  const runtime = {
    getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state,
    extractFloor: async () => { calls.push('extract'); return state; }, retryStateAnalysis: async () => { calls.push('cse'); return state; },
    copyFullDiagnostic: () => { calls.push('full'); return '{}'; }, copySafeDiagnostic: () => '{}',
  };
  const container = new Node('main'); const view = createV3FoundationView({ runtime, memoryManagement: { getState: () => ({}), deleteCurrent: async () => ({}), fullRebuild: async () => { calls.push('rebuild'); return state; } }, documentRef, confirmImpl: async () => false }); view.mount(container);
  view.setPage('memories'); flatten(container).find(node => node.textContent === '重新提取').click(); await new Promise(resolve => setImmediate(resolve));
  view.setPage('people'); flatten(container).find(node => node.textContent === '分析记录').click(); openDetails(flatten(container).find(node => node.className === 'qqj-cse-history-row')); flatten(container).find(node => node.textContent === '重新分析').click(); await new Promise(resolve => setImmediate(resolve));
  view.setPage('management'); flatten(container).find(node => node.textContent === '完全重构').click(); await new Promise(resolve => setImmediate(resolve));
  flatten(container).find(node => node.textContent === '复制完整诊断').click(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, []);
});

test('已有旧摘要或旧 CSE 时，本次重新提取/分析失败不会被旧记录误报为完成', async () => {
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const floor = { floorId: 'floor', assistantSeq: 1, messageIndex: 6, status: 'ready', memoryId: 'old-memory', summary: '旧摘要', summarySource: 'ai', aiSummary: '旧摘要', counts: {}, memory, cse: { status: 'ready', deltaId: 'old-delta' } };
  let state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, unprocessedCount: 0, memoryWorkBusy: false, cseReady: true, csePendingCount: 0, cseFailedCount: 0, floors: [floor], lastExtractorError: null, lastCseError: null };
  const runtime = {
    getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state,
    extractFloor: async () => { state = { ...state, lastExtractorError: { floorId: 'floor', message: '模拟重提失败' } }; return state; },
    retryStateAnalysis: async () => { state = { ...state, lastCseError: { floorId: 'floor', message: '模拟分析失败' } }; return state; },
  };
  const container = new Node('main'); const view = createV3FoundationView({ runtime, documentRef, confirmImpl: async () => true }); view.mount(container);
  view.setPage('memories'); flatten(container).find(node => node.textContent === '重新提取').click(); await new Promise(resolve => setImmediate(resolve));
  assert.match(flatten(container).map(node => node.textContent).join('|'), /重新提取未完成：第 6 楼 · 模拟重提失败/);
  view.setPage('people'); flatten(container).find(node => node.textContent === '分析记录').click(); openDetails(flatten(container).find(node => node.className === 'qqj-cse-history-row')); flatten(container).find(node => node.textContent === '重新分析').click(); await new Promise(resolve => setImmediate(resolve));
  assert.match(flatten(container).map(node => node.textContent).join('|'), /重新分析未完成：第 6 楼 · 模拟分析失败/);
});

test('补齐结果按真实楼号区分摘要全失败与摘要已存但 CSE 部分失败', async () => {
  let mode = 'summary';
  let state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 2, rememberedCount: 1, unprocessedCount: 1, memoryWorkBusy: false, csePendingCount: 1, rebuildStatus: 'pendingRebuild', rebuildHasActionableWork: true, floors: [{ floorId: 'failed-floor', assistantSeq: 2, messageIndex: 8, status: 'failed', memoryId: null }] };
  const runtime = {
    getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state,
    startHistoricalRebuild: async () => {
      state = mode === 'summary'
        ? { ...state, rebuildStatus: 'failed', lastAutoMemory: { status: 'failed', phase: 'extracting', processed: 0, cseProcessed: 0, failedItems: [{ floorLabel: '第 8 楼' }], message: '摘要提取失败' } }
        : { ...state, rebuildStatus: 'partial', lastAutoMemory: { status: 'partial', phase: 'analyzingCse', processed: 1, cseProcessed: 0, floorId: 'failed-floor', messageIndex: 8, message: '人物状态分析失败' } };
      return state;
    },
  };
  const container = new Node('main'); const view = createV3FoundationView({ runtime, documentRef }); view.mount(container);
  flatten(container).find(node => node.textContent === '补齐缺失').click(); await new Promise(resolve => setImmediate(resolve));
  assert.match(flatten(container).map(node => node.textContent).join('|'), /补齐缺失未完成：第 8 楼 · 摘要提取失败/);
  mode = 'cse'; state = { ...state, rebuildStatus: 'partial', rebuildHasActionableWork: true };
  view.render(state); flatten(container).find(node => node.textContent === '继续补齐').click(); await new Promise(resolve => setImmediate(resolve));
  assert.match(flatten(container).map(node => node.textContent).join('|'), /继续补齐部分完成：新增摘要 1 楼，补齐人物状态 0 楼；第 8 楼人物状态未完成/);
});

test('删除当前聊天记忆使用自绘异步确认，取消零写且确认说明保留边界', async () => {
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 0, rememberedCount: 0, unprocessedCount: 0, pending: null, activeRun: null, memoryWorkBusy: false, activeAutoMemory: null, activeExtraction: null, activeCse: null, rebuildStatus: 'caughtUp', rebuildHasActionableWork: false, floors: [] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  let calls = 0, confirmation = null;
  const memoryManagement = { getState: () => ({ status: 'idle' }), deleteCurrent: async () => { calls += 1; return { status: 'completed' }; } };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, memoryManagement, documentRef, confirmImpl: async options => { confirmation = options; return false; } });
  view.mount(container);
  const deleteButton = flatten(container).find(node => node.textContent === '删除当前聊天记忆');
  assert.equal(deleteButton.className, 'primary-action');
  const pageNode = flatten(container).find(node => node.className === 'qqj-page qqj-management-page');
  assert.equal(pageNode.children.at(-1).className, 'qqj-management-delete');
  assert.ok(flatten(pageNode.children.at(-2)).some(node => node.textContent === '详细诊断'), '删除区位于详细诊断之后');
  flatten(container).find(node => node.textContent === '删除当前聊天记忆').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.match(confirmation.body, /摘要、双丝网、人物资料、时间事项、召回及历史版本/);
  assert.match(confirmation.body, /正文、手动前情和全局设置保留.*前情可另行清空/);
  assert.match(confirmation.note, /移入回收站.*并非永久擦除/);
});

test('搬家按钮与删除同处管理入口，未打开时如实提示从聊天列表访问', async () => {
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 0, rememberedCount: 0, unprocessedCount: 0, pending: null, activeRun: null, memoryWorkBusy: false, activeAutoMemory: null, activeExtraction: null, activeCse: null, rebuildStatus: 'caughtUp', rebuildHasActionableWork: false, floors: [] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  let calls = 0;
  const memoryManagement = { getState: () => ({ status: 'idle', migrationState: { status: 'idle' } }),
    deleteCurrent: async () => ({}), migrateCurrent: async () => { calls += 1; return { status: 'completed', opened: false }; } };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, memoryManagement, documentRef }); view.mount(container);
  const pageNode = flatten(container).find(node => node.className === 'qqj-page qqj-management-page');
  const actions = pageNode.children.at(-1);
  assert.equal(actions.className, 'qqj-management-delete');
  const migration = flatten(actions).find(node => node.textContent === '搬家');
  assert.ok(migration); assert.equal(flatten(actions).find(node => node.textContent === '删除当前聊天记忆')?.parentNode, migration.parentNode);
  migration.click();
  for (let attempt = 0; attempt < 20 && !flatten(container).some(node => node.textContent.includes('新聊天已保存；可从当前角色的聊天列表打开')); attempt += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /新聊天已保存；可从当前角色的聊天列表打开/);
});

test('搬家启动通知后显示处理中并禁用删除，完成后恢复操作', async () => {
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 0, rememberedCount: 0, unprocessedCount: 0, pending: null, activeRun: null, memoryWorkBusy: false, activeAutoMemory: null, activeExtraction: null, activeCse: null, rebuildStatus: 'caughtUp', rebuildHasActionableWork: false, floors: [] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  let current = { status: 'idle', workBusy: false, migrationState: { status: 'idle' } }, resolveMigration;
  const listeners = new Set();
  const memoryManagement = { getState: () => current, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    deleteCurrent: async () => ({}), migrateCurrent() {
      current = { status: 'idle', workBusy: true, migrationState: { status: 'migrating' } };
      for (const listener of listeners) listener(current);
      return new Promise(resolve => { resolveMigration = resolve; });
    } };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, memoryManagement, documentRef }); view.mount(container);
  flatten(container).find(node => node.textContent === '搬家').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(flatten(container).some(node => node.textContent === '搬家中…'));
  assert.equal(flatten(container).find(node => node.textContent === '删除当前聊天记忆').disabled, true);
  current = { status: 'idle', workBusy: false, migrationState: { status: 'completed' } };
  for (const listener of listeners) listener(current);
  resolveMigration({ status: 'completed', opened: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(flatten(container).find(node => node.textContent === '删除当前聊天记忆').disabled, false);
});

test('删除按钮使用管理器统一忙碌投影', () => {
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 0, rememberedCount: 0, unprocessedCount: 0, pending: null, activeRun: null, memoryWorkBusy: false, activeAutoMemory: null, activeExtraction: null, activeCse: null, rebuildStatus: 'caughtUp', rebuildHasActionableWork: false, floors: [] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const memoryManagement = { getState: () => ({ status: 'idle', workBusy: true }), deleteCurrent: async () => ({ status: 'completed' }) };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, memoryManagement, documentRef }); view.mount(container);
  assert.equal(flatten(container).find(node => node.textContent === '删除当前聊天记忆').disabled, true);
});

test('地基尚无 root 时以 ready 会话身份开放删除，缺少有效身份仍保持禁用', async () => {
  const state = { status: 'uninitialized', pluginEnabled: true, chatId: null, foundationStatus: 'uninitialized', stableCount: 0, rememberedCount: 0, unprocessedCount: 0, pending: null, activeRun: null, memoryWorkBusy: false, activeAutoMemory: null, activeExtraction: null, activeCse: null, rebuildStatus: 'pendingRebuild', rebuildHasActionableWork: false, floors: [] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  let sessionState = { status: 'idle', identity: null }, calls = 0;
  const memoryManagement = { getState: () => ({ status: 'idle', workBusy: false }), deleteCurrent: async () => { calls += 1; return { status: 'completed' }; } };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, memoryManagement, sessionStateProvider: () => sessionState, documentRef, confirmImpl: async () => true });
  view.mount(container);
  assert.equal(flatten(container).find(node => node.textContent === '删除当前聊天记忆').disabled, true);
  sessionState = { status: 'ready', identity: { chatId: CHAT, hostChatId: 'host-a' } }; view.render(state);
  const remove = flatten(container).find(node => node.textContent === '删除当前聊天记忆');
  assert.equal(remove.disabled, false, '已卡档但当前会话身份有效时仍应允许走既有删除恢复链');
  remove.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('删除部分失败后管理页保留同聊天继续入口，成功后呈空档反馈', async () => {
  let state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, unprocessedCount: 0, pending: null, activeRun: null, memoryWorkBusy: false, activeAutoMemory: null, activeExtraction: null, activeCse: null, rebuildStatus: 'caughtUp', rebuildHasActionableWork: false, floors: [] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  let management = { status: 'idle', targetChatId: null, error: null }, attempts = 0;
  const listeners = new Set();
  const memoryManagement = {
    getState: () => management,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async deleteCurrent() {
      attempts += 1;
      if (attempts === 1) { management = { status: 'failed', targetChatId: CHAT, error: '版本冲突' }; for (const listener of listeners) listener(management); throw new Error('版本冲突'); }
      management = { status: 'completed', targetChatId: CHAT, error: null }; state = { ...state, status: 'idle', chatId: null, foundationStatus: 'uninitialized', stableCount: 0, rememberedCount: 0 }; for (const listener of listeners) listener(management); return management;
    },
  };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, memoryManagement, documentRef, confirmImpl: async () => true }); view.mount(container);
  flatten(container).find(node => node.textContent === '删除当前聊天记忆').click(); await new Promise(resolve => setImmediate(resolve));
  assert.match(flatten(container).map(node => node.textContent).join('|'), /继续删除当前聊天记忆|已保留原聊天身份/);
  flatten(container).find(node => node.textContent === '继续删除当前聊天记忆').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /当前聊天记忆已清空/);
});

test('A删除失败后切到B重绘不会沿用A失败文案或禁用B的普通管理动作', () => {
  const stateA = { status: 'idle', pluginEnabled: true, chatId: CHAT, foundationStatus: 'uninitialized', stableCount: 0, rememberedCount: 0, unprocessedCount: 0, pending: null, activeRun: null, memoryWorkBusy: false, activeAutoMemory: null, activeExtraction: null, activeCse: null, rebuildStatus: 'pendingRebuild', rebuildHasActionableWork: true, floors: [] };
  const stateB = { ...stateA, status: 'ready', chatId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', foundationStatus: 'ready' };
  let current = stateA, currentManagement = { status: 'failed', targetChatId: CHAT, error: 'A版本冲突' };
  const runtime = { getState: () => current, refreshStatus: async () => current, confirmLatest: async () => current, startHistoricalRebuild: async () => current };
  const memoryManagement = { getState: () => currentManagement, deleteCurrent: async () => ({ status: 'completed' }) };
  const container = new Node('main'), view = createV3FoundationView({ runtime, memoryManagement, documentRef }); view.mount(container);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /继续删除当前聊天记忆|A版本冲突/);
  current = stateB; currentManagement = { status: 'idle' }; view.render(current);
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.doesNotMatch(copy, /继续删除当前聊天记忆|A版本冲突|已保留原聊天身份/);
  assert.equal(flatten(container).find(node => node.textContent === '补齐缺失').disabled, false, 'B普通记忆管理不应被A删除失败阻塞');
  assert.equal(flatten(container).find(node => node.textContent === '删除当前聊天记忆').disabled, false, 'A失败状态不会限制B删除当前聊天');
});

test('Extractor 失败且尚无 FloorMemory 时仍可复制诊断并直接提取摘要', async () => {
  let extractedFloorId = null;
  let confirmations = 0;
  const state = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 0, unprocessedCount: 1, failedCount: 1, reviewCount: 0, pending: null, headCheckpointId: 'checkpoint', activeRun: null, lastRun: null, lastError: null, lastExtractorError: { message: '失败' }, unreachableCount: 0, metrics: {}, floors: [{ floorId: 'floor', assistantSeq: 1, messageIndex: 2, status: 'failed', memoryId: null, summary: '', counts: {}, error: '失败', memory: null }] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async floorId => { extractedFloorId = floorId; return state; }, copySafeDiagnostic: () => '{"safe":true}', copyFullDiagnostic: () => '{"sessionCandidate":{}}' };
  const container = new Node('main'); const view = createV3FoundationView({ runtime, documentRef, navigatorRef: {}, confirmImpl: () => { confirmations += 1; return true; } }); view.mount(container);
  const copy = flatten(container).map(node => node.textContent); assert.ok(copy.includes('复制安全诊断')); assert.ok(copy.includes('复制完整诊断'));
  view.setPage('memories');
  const card = flatten(container).find(node => String(node.className).includes('qqj-memory-card'));
  assert.equal(card.open, false);
  assert.match(flatten(card).map(node => node.textContent).join('|'), /第 2 楼.*时间未明确.*失败可重试.*暂无摘要.*⋮.*提取摘要.*失败/);
  const extract = flatten(container).find(node => node.textContent === '提取摘要');
  assert.ok(extract); assert.equal(extract.disabled, false);
  extract.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(extractedFloorId, 'floor');
  assert.equal(confirmations, 0, '无摘要楼的首次提取不是破坏性操作，不弹重提确认');
});

test('摘要页列出全部尚未摘要候选并显示真实等待原因，无 floorId 时不提供提取操作', async () => {
  const memory = { chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const registered = { floorId: 'floor-42', assistantSeq: 42, messageIndex: 82, status: 'ready', memoryId: 'memory-42', summary: '旧摘要仍然可见', summarySource: 'ai', aiSummary: '旧摘要仍然可见', counts: {}, memory };
  let state = {
    status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', memorySnapshotStatus: 'ready', memorySyncStatus: 'idle',
    stableCount: 42, rememberedCount: 42, unprocessedCount: 0, memoryWorkBusy: false, floors: [registered],
    unregisteredCandidates: [
      { assistantSeq: 43, messageIndex: 84, reason: 'consecutiveAssistant' },
      { assistantSeq: 44, messageIndex: 85, reason: 'waitingEarlierFloor' },
      { assistantSeq: 45, messageIndex: 87, reason: 'waitingNextUser' },
    ],
    consecutiveAssistantConfirmation: { chatId: CHAT, candidates: [
      { assistantSeq: 43, messageIndex: 84, confirmationRequired: true },
      { assistantSeq: 44, messageIndex: 85, confirmationRequired: false },
    ] },
  };
  let extractCalls = 0, consecutiveCalls = 0, confirmation = null, receivedScope = null;
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state,
    confirmConsecutiveAssistants: async scope => { consecutiveCalls += 1; receivedScope = scope; return state; }, extractFloor: async () => { extractCalls += 1; return state; } };
  const container = new Node('main'); const view = createV3FoundationView({ runtime, documentRef, confirmImpl: options => { confirmation = options; return true; } }); view.setPage('memories'); view.mount(container);
  let copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /已记忆 42\/42 楼.*另有 3 楼尚未摘要，正在等待确认/);
  assert.match(copy, /本次确认 2 个连续 AI 回复.*第 84 楼.*连续 AI，尚待确认/);
  assert.match(copy, /第 85 楼.*等待前面楼层处理.*先确认前面的 AI 楼/);
  assert.match(copy, /第 87 楼.*等待下一条用户消息.*发送下一条用户消息后检查/);
  assert.match(copy, /旧摘要仍然可见/);
  const confirmConsecutive = flatten(container).find(node => node.textContent === '确认连续 AI 并分别记录');
  assert.ok(confirmConsecutive); confirmConsecutive.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(consecutiveCalls, 1);
  assert.equal(receivedScope, state.consecutiveAssistantConfirmation, '弹窗必须把渲染时冻结的精确范围原样传入');
  assert.deepEqual(confirmation, { title: '确认连续 AI 回复', body: '第 84–85 楼，共 2 个 AI 回复，将按顺序分别摘要；正文不删除或合并。最新 AI 楼等待下一条用户消息，不在本次范围内。', confirmText: '确认并分别记录', cancelText: '取消' });
  assert.equal(flatten(container).filter(node => node.textContent === '提取摘要').length, 0);
  assert.equal(extractCalls, 0);

  state = { ...state, unregisteredCandidates: state.unregisteredCandidates.filter(candidate => candidate.reason !== 'waitingNextUser') };
  view.render(state);
  flatten(container).find(node => node.textContent === '确认连续 AI 并分别记录').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(confirmation.body, '第 84–85 楼，共 2 个 AI 回复，将按顺序分别摘要；正文不删除或合并。');

  runtime.confirmConsecutiveAssistants = async () => { throw Object.assign(new Error('连续 AI 确认范围已经变化，请重新查看后再确认。'), { code: 'V3_MEMORY_STALE' }); };
  flatten(container).find(node => node.textContent === '确认连续 AI 并分别记录').click();
  await new Promise(resolve => setImmediate(resolve));
  copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /确认连续 AI失败：连续 AI 确认范围已经变化，请重新查看后再确认/);

  state = { ...state, stableCount: 43, unprocessedCount: 1,
    floors: [...state.floors, { floorId: 'floor-45', assistantSeq: 45, messageIndex: 87, status: 'unprocessed', memoryId: null, summary: '', counts: {}, memory: null }],
    unregisteredCandidates: [{ assistantSeq: 45, messageIndex: 87, reason: 'waitingNextUser' }],
  };
  view.render(state); copy = flatten(container).map(node => node.textContent).join('|');
  assert.equal(flatten(container).filter(node => node.textContent === '第 87 楼').length, 1, '正式 floor 与迟到展示候选不得重复成两张卡');
  assert.match(copy, /旧摘要仍然可见/);
});

test('面板顶部显示 CSE 分层状态、原因/来源与待分析重试入口，不创建楼内聊天渲染', async () => {
  let nextCalls = 0, retryCalls = 0;
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const state = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'checkpoint', activeRun: null, activeExtraction: null, activeCse: null, lastRun: null, lastError: null, unreachableCount: 0, metrics: {}, cseReady: false, csePendingCount: 1, cseFailedCount: 0, baselineId: 'baseline', mainCharacterEntityId: 'character', mainCharacterDisplayName: '林岚', cseSubjects: [{ subjectEntityId: 'character', displayName: '林岚', core: [{ text: '谨慎', reason: '角色设定', visibility: 'authorial', sourceAssistantSeq: 1 }], adaptive: [{ text: '保持戒备', reason: '发生冲突', visibility: 'observable', towardDisplayName: '裴晚生', sourceAssistantSeq: 1 }], situational: [{ text: '紧张', reason: '雨夜危险', visibility: 'private', sourceAssistantSeq: 1 }] }], floors: [{ floorId: 'floor', assistantSeq: 1, messageIndex: 2, status: 'ready', memoryId: 'memory', summary: '摘要', summarySource: 'ai', aiSummary: '摘要', extractorVersion: 'v', counts: {}, api: null, memory, cse: { status: 'pending', deltaId: null } }] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state, editSummary: async () => state, restoreAi: async () => state, markError: async () => state, analyzeNextState: async () => { nextCalls += 1; return state; }, retryStateAnalysis: async () => { retryCalls += 1; return state; } };
  const sharedPeople = peopleRuntime([{ entityId: 'character', displayName: '林岚', entityDisplayName: '林岚' }]);
  const container = new Node('main'); const view = createV3FoundationView({ runtime, peopleRuntime: sharedPeople, documentRef }); view.setPage('people'); view.mount(container);
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /核心特质|长期倾向|当前情境|谨慎|保持戒备|紧张/);
  assert.equal(flatten(container).some(node => String(node.className).includes('qqj-v3-floor-card')), false);
  flatten(container).find(node => node.textContent === '分析记录').click();
  openDetails(flatten(container).find(node => node.className === 'qqj-cse-history-row'));
  flatten(container).find(node => node.textContent === '分析本楼').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nextCalls, 0); assert.equal(retryCalls, 1);
});

test('CSE 失败数、本楼错误与最近错误在 V3 面板可见，并保留独立重试', async () => {
  let retries = 0;
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const state = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'checkpoint', activeRun: null, activeExtraction: null, activeCse: null, lastRun: null, lastError: null, lastExtractorError: null, lastAutomationError: { message: '跨刷新自动任务错误' }, lastCseError: { message: '安全 CSE 错误' }, unreachableCount: 0, metrics: {}, cseReady: false, csePendingCount: 0, cseFailedCount: 1, baselineId: 'baseline', cseSubjects: [], floors: [{ floorId: 'floor', assistantSeq: 1, messageIndex: 2, status: 'ready', memoryId: 'memory', summary: '摘要', summarySource: 'ai', aiSummary: '摘要', extractorVersion: 'v', counts: {}, api: null, memory, cse: { status: 'failed', deltaId: null, error: 'Failed to fetch' } }] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state, editSummary: async () => state, restoreAi: async () => state, markError: async () => state, analyzeNextState: async () => state, retryStateAnalysis: async () => { retries += 1; return state; } };
  const container = new Node('main'); const view = createV3FoundationView({ runtime, documentRef }); view.setPage('people'); view.mount(container); flatten(container).find(node => node.textContent === '分析记录').click(); openDetails(flatten(container).find(node => node.className === 'qqj-cse-history-row'));
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /0 待分析 · 1 失败/);
  assert.match(copy, /安全 CSE 错误/);
  assert.match(copy, /网络连接失败，请检查网络或 API 地址/);
  assert.doesNotMatch(copy, /Failed to fetch/);
  flatten(container).find(node => node.textContent === '重试分析').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(retries, 1);
  view.setPage('management');
  const managementCopy = flatten(container).map(node => node.textContent).join('|');
  assert.match(managementCopy, /最近自动任务错误/);
  assert.match(managementCopy, /跨刷新自动任务错误/);
});

test('千结与双丝网健康提示只显示各自进度和错误', () => {
  const state = { status: 'running', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 4, rememberedCount: 3, unprocessedCount: 1,
    memoryWorkBusy: true, activeMemoryWork: { phase: 'analyzingCse' }, activeExtraction: null, activeCse: { floorId: 'floor', phase: 'analyzing' },
    lastError: null, lastExtractorError: { message: '摘要错误' }, lastCseError: { message: '状态错误' }, cseReady: false, csePendingCount: 2, cseFailedCount: 1,
    selectedEntityIds: [], cseSubjects: [], floors: [], rebuildStatus: 'pendingRebuild' };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const container = new Node('main'), view = createV3FoundationView({ runtime, peopleRuntime: peopleRuntime([], []), documentRef });
  view.setPage('memories'); view.mount(container);
  let copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /摘要提取失败 · 摘要错误/); assert.doesNotMatch(copy, /状态错误|正在分析人物状态/);
  view.setPage('people'); copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /正在分析人物状态 · 待分析 2 楼/); assert.doesNotMatch(copy, /摘要错误/);
  view.setPage('memories'); view.render({ ...state, activeMemoryWork: { phase: 'revising' }, activeCse: null, lastExtractorError: null, lastCseError: null });
  copy = flatten(container).map(node => node.textContent).join('|'); assert.match(copy, /正在处理摘要 · 3\/4 楼/);
  view.setPage('people'); view.render({ ...state, activeMemoryWork: null, activeCse: null, lastError: { message: '共享读取失败' }, lastCseError: null });
  copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /人物状态需要处理 · 共享记忆：共享读取失败/); assert.doesNotMatch(copy, /摘要错误/);
});

test('双丝网页会显示激活期间的共享刷新失败', async () => {
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 0, rememberedCount: 0, unprocessedCount: 0,
    activeMemoryWork: null, activeExtraction: null, activeCse: null, lastError: null, lastExtractorError: null, lastCseError: null,
    cseReady: true, csePendingCount: 0, cseFailedCount: 0, selectedEntityIds: [], cseSubjects: [], floors: [] };
  const runtime = { getState: () => state, refreshStatus: async () => { throw new Error('共享暂不可用'); }, confirmLatest: async () => state };
  const container = new Node('main'), view = createV3FoundationView({ runtime, peopleRuntime: peopleRuntime([], []), documentRef });
  view.setPage('people'); view.mount(container); await view.activate();
  assert.match(flatten(container).map(node => node.textContent).join('|'), /记忆读取失败：共享暂不可用；历史召回回执已独立处理/);
});

test('所有用户可见楼号统一使用零基 messageIndex，非均匀楼层不猜 AI 序号', () => {
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const floors = [
    { floorId: 'floor-zero', assistantSeq: 1, messageIndex: 0, frozen: true, sourceOrigin: { sourceMessageIndex: 1, sourceHostChatId: 'archive.jsonl' }, status: 'ready', memoryId: 'memory-zero', summary: '零楼摘要', summarySource: 'ai', aiSummary: '零楼摘要', extractorVersion: 'v', counts: {}, api: null, memory, cse: { status: 'ready', deltaId: 'delta-zero' } },
    { floorId: 'floor-two', assistantSeq: 2, messageIndex: 2, status: 'ready', memoryId: 'memory-two', summary: '二楼摘要', summarySource: 'ai', aiSummary: '二楼摘要', extractorVersion: 'v', counts: {}, api: null, memory, cse: { status: 'ready', deltaId: 'delta-two' } },
    { floorId: 'floor-five', assistantSeq: 3, messageIndex: 5, status: 'ready', memoryId: 'memory-five', summary: '五楼摘要', summarySource: 'ai', aiSummary: '五楼摘要', extractorVersion: 'v', counts: {}, api: null, memory, cse: { status: 'ready', deltaId: 'delta-five' } },
  ];
  const state = {
    status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 3, rememberedCount: 3, unprocessedCount: 0, failedCount: 0, reviewCount: 0,
    pending: { assistantSeq: 3, messageIndex: 5 }, headCheckpointId: 'checkpoint', activeRun: null, activeExtraction: { floorId: 'floor-two', phase: 'extracting' }, activeCse: null, memoryWorkBusy: false, activeAutoMemory: null,
    lastRun: null, lastAutoMemory: { status: 'completed', fromAssistantSeq: 1, toAssistantSeq: 3 }, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, cseReady: true,
    csePendingCount: 0, cseFailedCount: 0, baselineId: 'baseline', rebuildStatus: 'pendingRebuild', rebuildCompletedCount: 1, rebuildTotalCount: 3, rebuildNextAssistantSeq: 2,
    mainCharacterEntityId: 'character', mainCharacterDisplayName: '裴晚生', cseSubjects: [{ subjectEntityId: 'character', displayName: '裴晚生', core: [
      { text: '来源以 floorId 为准', reason: '证据', visibility: 'observable', origin: 'delta', sourceFloorId: 'floor-zero', sourceAssistantSeq: 3 },
      { text: '失配不能退回序号', reason: '证据', visibility: 'observable', origin: 'delta', sourceFloorId: 'missing-floor', sourceAssistantSeq: 2 },
    ], adaptive: [], situational: [] }], floors,
  };
  const recallRuntime = { getState: () => ({ recallStatus: 'ready', activeRecall: null, lastRecall: {
    status: 'ready', userMessageIndex: 4, createdAt: '2026-09-05T00:00:00.000Z', generationType: 'normal', receiptPersistence: 'persisted', selectedStates: [], injectionText: '已注入', skipReasons: [],
    selectedFloors: [{ floorId: 'floor-zero', assistantSeq: 99 }, { assistantSeq: 2 }, { floorId: 'missing-floor', assistantSeq: 3 }],
    selectedCseChanges: [{ sourceFloorId: 'floor-zero', sourceAssistantSeq: 99, subject: '裴晚生', layer: 'core', action: 'update' }],
    coverage: { rememberedAiFloors: 3, stableAiFloors: 3, cseThroughAssistantSeq: 2 }, stages: null, timings: null,
  } }) };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state, editSummary: async () => state, restoreAi: async () => state, markError: async () => state };
  const container = new Node('main');
  const selectedPeople = peopleRuntime([{ entityId: 'character', displayName: '裴晚生', entityDisplayName: '裴晚生' }]);
  const view = createV3FoundationView({ runtime, recallRuntime, peopleRuntime: selectedPeople, documentRef });
  view.setPage('memories'); view.mount(container);
  let visible = flatten(container).map(node => node.textContent).filter(Boolean);
  assert.deepEqual(flatten(container).filter(node => node.className === 'qqj-floor-number').map(node => node.textContent), ['第 5 楼', '第 2 楼', '第 1 楼 · archive']);
  const summarySearch = flatten(container).find(node => node.placeholder === '搜索全部摘要'); summarySearch.value = '零楼摘要'; summarySearch.fire('input');
  const archiveResult = flatten(container).find(node => node.className === 'qqj-history-search-result');
  assert.equal(flatten(archiveResult).find(node => node.className === 'qqj-history-search-title qqj-memory-search-title').children[0].textContent, '第 1 楼 · archive');
  archiveResult.click();
  const archivedCard = flatten(container).find(node => node.attributes['data-qqj-floor-id'] === 'floor-zero');
  assert.ok(flatten(archivedCard).some(node => node.textContent.includes('来源：archive.jsonl')), '搜索和展开都保留只读来源标记');
  view.setPage('people');
  visible = flatten(container).map(node => node.textContent).filter(Boolean);
  assert.ok(visible.includes('裴晚生'), '当前人物状态继续按人物实体显示');
  view.setPage('management');
  visible = flatten(container).map(node => node.textContent).filter(Boolean);
  assert.ok(visible.includes('第 4 楼'), '触发用户楼不得 +1');
  assert.ok(visible.includes('来源聊天第 1 楼、第 2 楼、来源楼号未提供'));
  assert.ok(visible.some(value => value.includes('来源聊天第 1 楼') && value.includes('裴晚生')), `CSE回执按floorId显示冻结来源聊天楼号: ${visible.join('|')}`);
  assert.ok(visible.includes('记忆 3/3 · CSE 到第 2 楼'));
  assert.equal(visible.some(value => /AI #|宿主楼|宿主索引/.test(value)), false);
});

test('已完成人物状态可确认后重新分析，取消不调用且忙碌时禁用', async () => {
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const floors = [
    { floorId: 'floor-ready', assistantSeq: 1, messageIndex: 2, status: 'ready', memoryId: 'memory-ready', summary: '摘要一', summarySource: 'ai', aiSummary: '摘要一', extractorVersion: 'v', counts: {}, api: null, memory, cse: { status: 'ready', deltaId: 'delta-ready' } },
    { floorId: 'floor-no-change', assistantSeq: 2, messageIndex: 4, status: 'ready', memoryId: 'memory-no-change', summary: '摘要二', summarySource: 'ai', aiSummary: '摘要二', extractorVersion: 'v', counts: {}, api: null, memory, cse: { status: 'noChange', deltaId: 'delta-no-change' } },
  ];
  const base = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 2, rememberedCount: 2, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'checkpoint', activeRun: null, activeExtraction: null, activeCse: null, memoryWorkBusy: false, activeAutoMemory: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, cseReady: true, csePendingCount: 0, cseFailedCount: 0, baselineId: 'baseline', cseSubjects: [], floors };
  let state = base;
  const retries = [];
  const confirmations = [];
  let confirmed = true;
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state, editSummary: async () => state, restoreAi: async () => state, markError: async () => state, retryStateAnalysis: async floorId => { retries.push(floorId); return state; } };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef, confirmImpl: message => { confirmations.push(message); return confirmed; } });
  view.setPage('people'); view.mount(container);
  flatten(container).find(node => node.textContent === '分析记录').click();
  for (const row of flatten(container).filter(node => node.className === 'qqj-cse-history-row')) openDetails(row);

  let buttons = flatten(container).filter(node => node.textContent === '重新分析');
  assert.equal(buttons.length, 2, 'ready 与 noChange 楼层都应显示入口');
  buttons[0].click();
  await new Promise(resolve => setImmediate(resolve));
  buttons = flatten(container).filter(node => node.textContent === '重新分析');
  buttons[1].click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(retries, ['floor-no-change', 'floor-ready'], '逐楼记录按最新楼在前操作同一 floorId');
  assert.equal(confirmations.length, 2);
  assert.match(`${confirmations[0].title} ${confirmations[0].body}`, /重新分析人物状态.*只会替换本楼人物状态.*摘要与其他楼记录保持不变/);

  confirmed = Promise.resolve(false);
  flatten(container).find(node => node.textContent === '重新分析').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(retries, ['floor-no-change', 'floor-ready'], '取消后不得调用 runtime');

  state = { ...base, memoryWorkBusy: true };
  view.render(state);
  buttons = flatten(container).filter(node => node.textContent === '重新分析');
  assert.equal(buttons.length, 2);
  for (const button of buttons) assert.equal(button.disabled, true);
});

test('自动批次活跃时面板提取、CSE 与修订入口统一禁用，结束后恢复', () => {
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const base = { status: 'running', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, unprocessedCount: 1, failedCount: 0, reviewCount: 0, pending: { assistantSeq: 2, messageIndex: 3 }, headCheckpointId: 'checkpoint', activeRun: null, activeExtraction: null, activeCse: null, memoryWorkBusy: true, activeAutoMemory: { phase: 'reconciling', floorIds: ['floor'] }, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, cseReady: false, csePendingCount: 1, cseFailedCount: 0, baselineId: 'baseline', cseSubjects: [], floors: [{ floorId: 'floor', assistantSeq: 1, messageIndex: 2, status: 'ready', memoryId: 'memory', summary: '摘要', summarySource: 'user', aiSummary: 'AI 摘要', extractorVersion: 'v', counts: {}, api: null, memory, cse: { status: 'pending', deltaId: null } }] };
  let state = base;
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractNext: async () => state, extractFloor: async () => state, editSummary: async () => state, restoreAi: async () => state, markError: async () => state, analyzeNextState: async () => state, retryStateAnalysis: async () => state };
  const container = new Node('main'); const view = createV3FoundationView({ runtime, memoryManagement: { getState: () => ({}), deleteCurrent: async () => ({}), fullRebuild: async () => state }, documentRef }); view.mount(container);
  assert.equal(flatten(container).find(node => node.textContent === '完全重构')?.disabled, true);
  view.setPage('memories');
  for (const label of ['编辑', '重新提取']) assert.equal(flatten(container).find(node => node.textContent === label)?.disabled, true, label);
  view.setPage('people');
  flatten(container).find(node => node.textContent === '分析记录').click();
  openDetails(flatten(container).find(node => node.className === 'qqj-cse-history-row'));
  assert.equal(flatten(container).find(node => node.textContent === '分析本楼')?.disabled, true);
  state = { ...base, status: 'ready', memoryWorkBusy: false, activeAutoMemory: null };
  view.render(state);
  assert.equal(flatten(container).find(node => node.textContent === '分析本楼')?.disabled, false);
  view.setPage('memories');
  for (const label of ['编辑', '重新提取']) assert.equal(flatten(container).find(node => node.textContent === label)?.disabled, false, label);
  view.setPage('management');
  assert.equal(flatten(container).find(node => node.textContent === '完全重构')?.disabled, false);
});

test('历史欠账与人物状态重构按钮各自开始暂停继续，CSE 进度独立显示并保留失败原因', async () => {
  const base = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 5, rememberedCount: 2, unprocessedCount: 3, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'checkpoint', activeRun: null, activeExtraction: null, activeCse: null, memoryWorkBusy: false, activeAutoMemory: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, autoMemoryEnabled: false, autoMemoryBatchSize: 2, rebuildStatus: 'pendingRebuild', rebuildCompletedCount: 2, rebuildTotalCount: 5, rebuildNextAssistantSeq: 3, cseRebuildStatus: 'idle', cseRebuildCompletedCount: 0, cseRebuildTotalCount: 2, cseReady: false, csePendingCount: 0, cseFailedCount: 0, baselineId: null, cseSubjects: [], floors: [] };
  let state = base, starts = 0, pauses = 0, resetChatId = 'unset', cseChatId = null, csePauses = 0, cseResumes = 0;
  const confirmations = [];
  const runtime = {
    getState: () => state,
    refreshStatus: async () => state,
    confirmLatest: async () => state,
    startHistoricalRebuild: async () => { starts += 1; return state; },
    pauseHistoricalRebuild: () => { pauses += 1; return state; },
    rebuildCse: async chatId => { cseChatId = chatId; return state; },
    pauseCseRebuild: () => { csePauses += 1; return state; },
    resumeCseRebuild: async chatId => { cseResumes += 1; cseChatId = chatId; return state; },
  };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, memoryManagement: { getState: () => ({}), deleteCurrent: async () => ({}), fullRebuild: async chatId => { resetChatId = chatId; return state; } }, documentRef, confirmImpl: options => { confirmations.push(options); return true; } });
  view.mount(container);
  state = { ...base, status: 'idle', chatId: null, foundationStatus: 'uninitialized', rememberedCount: 0, headCheckpointId: null };
  view.render(state);
  flatten(container).find(node => node.textContent === '完全重构').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resetChatId, null, '空档完全重构仍按 UI 当前状态传入 null');
  resetChatId = 'unset';
  state = { ...base, rememberedCount: 0, rebuildCompletedCount: 0, rebuildNextAssistantSeq: 1 };
  view.render(state);
  assert.equal(flatten(container).find(node => node.textContent === '补齐缺失')?.disabled, false);
  state = base;
  view.render(state);
  let copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /自动维护新楼\|已关闭/);
  assert.match(copy, /历史重建\|等待开始 · 2\/5/);
  assert.match(copy, /记忆尚未完整.*刷新页面不会自动续跑/);
  const resume = flatten(container).find(node => node.textContent === '补齐缺失');
  assert.equal(resume.disabled, false);
  resume.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 1);
  flatten(container).find(node => node.textContent === '完全重构').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resetChatId, CHAT, '完全重构必须携带用户当前看到的聊天 ID');
  const actionLabels = flatten(container).filter(node => node.tag === 'button').map(node => node.textContent);
  assert.ok(actionLabels.indexOf('人物状态重构') === actionLabels.indexOf('完全重构') + 1, '人物状态重构固定放在完全重构旁边');
  flatten(container).find(node => node.textContent === '人物状态重构').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cseChatId, CHAT);
  assert.match(`${confirmations.at(-1)?.body}`, /保留摘要.*双丝网人工纠正会被覆盖.*未摘要楼不处理/);

  state = { ...base, status: 'running', memoryWorkBusy: true, activeAutoMemory: { phase: 'analyzingCse', mode: 'cseRebuild', floorIds: ['floor-2'] }, cseRebuildStatus: 'running', cseRebuildCompletedCount: 1, cseRebuildTotalCount: 2 };
  view.render(state);
  const pauseCse = flatten(container).find(node => node.textContent === '暂停人物状态重构');
  assert.equal(pauseCse.disabled, false); pauseCse.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(csePauses, 1); assert.match(flatten(container).map(node => node.textContent).join('|'), /人物状态重构中 · 1\/2/);
  state = { ...base, cseRebuildStatus: 'paused', cseRebuildCompletedCount: 1, cseRebuildTotalCount: 2 };
  view.render(state);
  assert.equal(flatten(container).filter(node => node.textContent === '继续人物状态重构').length, 1, '暂停态只保留同一枚 CSE 按钮');
  const pausedProgress = flatten(container).find(node => node.className === 'qqj-management-progress');
  assert.ok(pausedProgress); assert.notEqual(pausedProgress.parentNode, flatten(container).find(node => node.className.includes('qqj-management-actions')), '进度必须位于按钮行之外');
  assert.equal(flatten(container).some(node => node.textContent === '继续'), false, '通用历史继续不得接管 CSE 作业');
  flatten(container).find(node => node.textContent === '继续人物状态重构').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(cseResumes, 1); assert.equal(cseChatId, CHAT);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /人物状态已暂停 · 1\/2/);

  state = { ...base, cseRebuildStatus: 'paused', cseRebuildCompletedCount: 1, cseRebuildTotalCount: 2, lastCseError: { message: 'BACKEND_TIMEOUT' }, memorySnapshotStatus: 'ready', memorySyncStatus: 'idle' };
  view.render(state);
  let copyWithOldFailure = flatten(container).map(node => node.textContent).join('|');
  assert.match(copyWithOldFailure, /上次人物状态分析失败：请求超时，请稍后重试；可继续人物状态重构/);
  assert.equal(flatten(container).find(node => node.textContent === '继续人物状态重构')?.disabled, false, '旧 CSE 超时不应锁死继续按钮');

  state = { ...base, cseRebuildStatus: 'failed', cseRebuildCompletedCount: 1, cseRebuildTotalCount: 2, cseRebuildNextAssistantSeq: 2, cseRebuildError: '第 4 楼返回的人物状态 JSON 不完整。', lastCseError: null,
    memorySnapshotStatus: 'ready', memorySyncStatus: 'idle', floors: [{ floorId: 'floor-1', assistantSeq: 1, messageIndex: 2 }, { floorId: 'floor-2', assistantSeq: 2, messageIndex: 4 }] };
  view.render(state);
  await flatten(container).find(node => node.textContent === '刷新状态').click();
  await new Promise(resolve => setImmediate(resolve));
  let failure = flatten(container).find(node => node.className.includes('qqj-management-feedback'));
  assert.match(failure.textContent, /当前聊天已读取完成/);
  const oldFailure = flatten(container).find(node => node.textContent.includes('上次人物状态分析失败'));
  assert.match(oldFailure.textContent, /第 4 楼返回的人物状态 JSON 不完整.*可继续人物状态重构/);
  view.setPage('memories'); view.setPage('management');
  assert.match(flatten(container).map(node => node.textContent).join('|'), /上次人物状态分析失败：第 4 楼返回的人物状态 JSON 不完整/, '切页回来仍显示 runtime 当前掌握的失败原因');

  state = { ...base, rebuildStatus: 'waitingRealtime', rebuildHasActionableWork: true };
  view.render(state);
  assert.equal(flatten(container).find(node => node.textContent === '补齐缺失')?.disabled, false, '等待新楼状态下仍有稳定欠账时补齐必须可用');
  state = { ...state, status: 'running', memoryWorkBusy: true, activeMemoryWork: { phase: 'analyzingCse' } };
  view.render(state);
  const busyAction = flatten(container).find(node => node.textContent === '正在分析人物状态');
  assert.ok(busyAction); assert.equal(busyAction.disabled, true, '真实任务忙碌时仍保留并发锁并显示阶段');
  state = { ...base, rebuildStatus: 'waitingRealtime', rebuildHasActionableWork: false };
  view.render(state);
  assert.equal(flatten(container).find(node => node.textContent === '补齐缺失')?.disabled, true, '确实没有稳定待办时补齐才置灰');

  state = { ...base, status: 'running', memoryWorkBusy: true, rebuildStatus: 'rebuilding', activeAutoMemory: { phase: 'extracting', mode: 'historical', floorIds: ['floor-3'] } };
  view.render(state);
  const pause = flatten(container).find(node => node.textContent === '暂停补齐');
  assert.equal(pause.disabled, false);
  pause.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pauses, 1);
});

test('完全重构进度与暂停/续跑控制从管理页转发到同一目标任务', async () => {
  const state = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 4, rememberedCount: 4, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'head', activeRun: null, activeExtraction: null, activeCse: null, memoryWorkBusy: false, activeAutoMemory: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, autoMemoryEnabled: true, autoMemoryBatchSize: 1, rebuildStatus: 'caughtUp', rebuildCompletedCount: 4, rebuildTotalCount: 4, rebuildHasActionableWork: false, cseRebuildStatus: 'idle', cseRebuildCompletedCount: 0, cseRebuildTotalCount: 0, cseReady: true, csePendingCount: 0, cseFailedCount: 0, baselineId: null, cseSubjects: [], floors: [] };
  let taskState = { ...state, rebuildStatus: 'rebuilding', rebuildCompletedCount: 2, rebuildTotalCount: 4, activeAutoMemory: { mode: 'historical', phase: 'extracting', floorIds: ['floor-a'] } };
  let listener, paused = 0, resumed = 0;
  const management = {
    getState: () => ({ rebuildState: taskState, pauseHistoricalRebuild: async () => { paused += 1; taskState = { ...taskState, rebuildStatus: 'paused', activeAutoMemory: null }; listener?.(management.getState()); } }),
    subscribe(callback) { listener = callback; return () => { listener = null; }; },
    deleteCurrent: async () => ({}),
    fullRebuild: async chatId => { assert.equal(chatId, CHAT); resumed += 1; taskState = { ...taskState, rebuildStatus: 'caughtUp' }; return taskState; },
  };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, memoryManagement: management, documentRef });
  view.mount(container); view.setPage('management');
  assert.match(flatten(container).map(node => node.textContent).join('|'), /历史重建\|正在重建 · 2\/4/);
  const pause = flatten(container).find(node => node.textContent === '暂停重构');
  assert.ok(pause); pause.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(paused, 1);
  assert.equal(flatten(container).some(node => node.textContent === '继续完全重构'), true);
  assert.equal(flatten(container).some(node => node.textContent === '继续补齐'), false);
  flatten(container).find(node => node.textContent === '继续完全重构').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(resumed, 1);
});

test('合并聊天完全重构确认说明归档历史保留且只重做当前部分', async () => {
  const state = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, migrationDescriptorId: 'archive-prefix', foundationStatus: 'ready', stableCount: 2, rememberedCount: 2, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'head', activeRun: null, activeExtraction: null, activeCse: null, memoryWorkBusy: false, activeAutoMemory: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, autoMemoryEnabled: true, autoMemoryBatchSize: 1, rebuildStatus: 'caughtUp', rebuildCompletedCount: 2, rebuildTotalCount: 2, rebuildHasActionableWork: false, cseRebuildStatus: 'idle', cseRebuildCompletedCount: 0, cseRebuildTotalCount: 0, cseReady: true, csePendingCount: 0, cseFailedCount: 0, baselineId: null, cseSubjects: [], floors: [] };
  let confirmation;
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const management = { getState: () => ({}), deleteCurrent: async () => ({}), fullRebuild: async () => assert.fail('取消确认后不启动重构') };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, memoryManagement: management, documentRef, chooseImpl: options => { confirmation = options; return null; } });
  view.mount(container);
  await flatten(container).find(node => node.textContent === '完全重构').click();
  assert.equal(confirmation.title, '完全重构当前聊天记忆');
  assert.match(confirmation.body, /保留归档历史、千人人物资料（含头像与重要人物选择）和前情/u);
  assert.match(confirmation.body, /重新整理当前部分的摘要与人物状态，并补查时间事项/u);
  assert.doesNotMatch(confirmation.body, /删除本聊天全部千千结记录|所有人工修改都会清除/);
});

test('地基视图固定显示每楼更新，旧批次 20 不再生效', () => {
  const base = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 0, rememberedCount: 0, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: null, activeRun: null, activeExtraction: null, activeCse: null, memoryWorkBusy: false, activeAutoMemory: null, lastAutoMemory: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, autoMemoryEnabled: true, rebuildStatus: 'caughtUp', rebuildCompletedCount: 0, rebuildTotalCount: 0, rebuildNextAssistantSeq: null, cseReady: false, csePendingCount: 0, cseFailedCount: 0, baselineId: null, cseSubjects: [], floors: [] };
  const runtime = { getState: () => base, refreshStatus: async () => base, confirmLatest: async () => base };
  const container = new Node('main');
  const selectedPeople = peopleRuntime([{ entityId: 'character', displayName: '裴晚生', entityDisplayName: '裴晚生' }]);
  const view = createV3FoundationView({ runtime, peopleRuntime: selectedPeople, documentRef });
  view.mount(container);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /自动维护新楼\|已开启 · 每楼更新/);
  view.render({ ...base, autoMemoryBatchSize: 20 });
  assert.match(flatten(container).map(node => node.textContent).join('|'), /自动维护新楼\|已开启 · 每楼更新/);
});

test('runtime 通知会自动呈现；deactivate 停止重绘，重新 activate 恢复且不重复订阅', async () => {
  const base = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 0, unprocessedCount: 1, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'checkpoint-1', activeRun: null, activeExtraction: null, activeCse: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, cseReady: false, csePendingCount: 0, cseFailedCount: 0, baselineId: null, cseSubjects: [], floors: [] };
  let state = base, subscriptions = 0;
  const listeners = new Set();
  const runtime = {
    getState: () => state,
    refreshStatus: async () => state,
    confirmLatest: async () => state,
    subscribe(listener) { subscriptions += 1; listeners.add(listener); return () => listeners.delete(listener); },
  };
  const emit = next => { state = next; for (const listener of [...listeners]) listener(next); };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef });
  view.mount(container);
  assert.equal(subscriptions, 1);
  assert.equal(listeners.size, 1);
  emit({ ...base, status: 'stale', stableCount: 1, headCheckpointId: 'checkpoint-1' });
  emit({ ...base, status: 'running', stableCount: 1, headCheckpointId: 'checkpoint-1' });
  emit({ ...base, status: 'ready', stableCount: 2, headCheckpointId: 'checkpoint-2' });
  assert.equal(subscriptions, 1, 'stale/running/ready 连续通知不应重复订阅');
  assert.equal(listeners.size, 1);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /checkpoint-2/);
  view.deactivate();
  assert.equal(listeners.size, 0);
  const inactiveRenderCount = container.replaceCount;
  emit({ ...base, stableCount: 3, headCheckpointId: 'checkpoint-3' });
  assert.equal(container.replaceCount, inactiveRenderCount, '隐藏视图不应继续重绘');
  await view.activate();
  assert.equal(subscriptions, 2);
  assert.equal(listeners.size, 1);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /checkpoint-3/);
  await view.activate();
  assert.equal(subscriptions, 2, '重复 activate 不应重复订阅');
  assert.equal(listeners.size, 1);
  const beforeSingleNotification = container.replaceCount;
  emit({ ...base, stableCount: 4, headCheckpointId: 'checkpoint-4' });
  assert.equal(container.replaceCount, beforeSingleNotification + 1, '单次通知只重绘一次');
  assert.match(flatten(container).map(node => node.textContent).join('|'), /checkpoint-4/);
});

test('activate 初始 stale 使用中性暂态文案，订阅 ready 后原地恢复且不残留身份误报', async () => {
  const base = { status: 'stale', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 0, unprocessedCount: 1, failedCount: 0, reviewCount: 0, pending: { assistantSeq: 2, messageIndex: 2 }, headCheckpointId: 'checkpoint-1', activeRun: null, activeExtraction: null, activeCse: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, cseReady: false, csePendingCount: 0, cseFailedCount: 0, baselineId: null, cseSubjects: [], floors: [] };
  let state = base;
  const listeners = new Set();
  const runtime = {
    getState: () => state,
    refreshStatus: async () => state,
    confirmLatest: async () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef });
  view.mount(container);
  await view.activate();
  let copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /正在等待最新结果/);
  assert.doesNotMatch(copy, /聊天已切换|聊天身份/);

  state = { ...base, status: 'ready', stableCount: 2, pending: { assistantSeq: 3, messageIndex: 3 }, headCheckpointId: 'checkpoint-2' };
  for (const listener of listeners) listener(state);
  copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /checkpoint-2/);
  assert.doesNotMatch(copy, /聊天已切换|聊天身份/);
  assert.equal(listeners.size, 1);
});

test('身份准备期间首次打开记忆或管理页只等待 lifecycle，不抢跑 runtime 读取', async () => {
  for (const page of ['memories', 'management']) {
    let prepareCalls = 0, refreshCalls = 0, receiptCalls = 0, listener = null;
    let state = { status: 'idle', pluginEnabled: true, chatId: null, foundationStatus: 'uninitialized', memorySnapshotStatus: 'syncing', memorySyncStatus: 'syncing', stableCount: 0, rememberedCount: 0, unprocessedCount: 0, failedCount: 0, reviewCount: 0, floors: [] };
    const runtime = {
      getState: () => state,
      async prepareCurrent() { prepareCalls += 1; return state; },
      async refreshStatus() { refreshCalls += 1; return state; },
      confirmLatest: async () => state,
      subscribe(next) { listener = next; return () => {}; },
    };
    const recallRuntime = { getState: () => ({ recallStatus: 'idle' }), async restorePersistedReceipt() { receiptCalls += 1; } };
    const container = new Node('main');
    const view = createV3FoundationView({ runtime, recallRuntime, sessionStateProvider: () => ({ status: 'preparing' }), documentRef });
    view.setPage(page); view.mount(container);
    assert.deepEqual(await view.activate(), { status: 'preparing' }, page);
    assert.equal(prepareCalls, 0, `${page} 不得在身份认领完成前调用 prepareCurrent`);
    assert.equal(refreshCalls, 0, `${page} 不得在身份认领完成前调用 refreshStatus`);
    assert.equal(receiptCalls, 1, `${page} 应保留与身份后端无关的聊天回执恢复`);
    assert.match(flatten(container).map(node => node.textContent).join('|'), /正在读取当前聊天/);
    state = { ...state, status: 'ready', chatId: CHAT, foundationStatus: 'ready', memorySnapshotStatus: 'ready', memorySyncStatus: 'idle', stableCount: 1, rememberedCount: 1 };
    listener(state);
    await new Promise(resolve => setImmediate(resolve));
    const settledCopy = flatten(container).map(node => node.textContent).join('|');
    assert.doesNotMatch(settledCopy, /正在读取当前聊天/, `${page} 收到准备完成通知后不得残留等待文案`);
    assert.match(settledCopy, /已记忆 1\/1 楼/, `${page} 应呈现订阅送达的最新内容`);
    assert.equal(receiptCalls, 1, `${page} 订阅更新不得重复恢复聊天回执`);
  }
});

test('旧 runtime 没有 subscribe 时继续使用手动刷新兼容路径', async () => {
  const base = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 0, unprocessedCount: 1, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'old-1', activeRun: null, activeExtraction: null, activeCse: null, lastRun: null, lastError: null, unreachableCount: 0, metrics: {}, floors: [] };
  let state = base;
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const container = new Node('main'); const view = createV3FoundationView({ runtime, documentRef }); view.mount(container);
  state = { ...base, stableCount: 2, headCheckpointId: 'old-2' };
  assert.doesNotMatch(flatten(container).map(node => node.textContent).join('|'), /old-2/);
  await view.activate();
  assert.match(flatten(container).map(node => node.textContent).join('|'), /old-2/);
  view.deactivate();
});

test('轻量召回运行结果自动显示实际注入、收据、阶段与覆盖；deactivate 后解除独立订阅', () => {
  const foundation = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 8, rememberedCount: 8, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'head', activeRun: null, activeExtraction: null, activeCse: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, cseReady: true, csePendingCount: 0, cseFailedCount: 0, baselineId: 'baseline', cseSubjects: [], floors: [] };
  const foundationRuntime = { getState: () => foundation, refreshStatus: async () => foundation, confirmLatest: async () => foundation };
  let recall = { recallStatus: 'idle', activeRecall: null, lastRecall: null, lastRecallError: null };
  const listeners = new Set();
  const recallRuntime = { getState: () => recall, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime: foundationRuntime, recallRuntime, documentRef });
  view.mount(container);
  assert.equal(listeners.size, 1);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /最近召回回执|下一次正文生成/);
  recall = {
    recallStatus: 'ready', activeRecall: null, lastRecallError: null,
    lastRecall: {
      status: 'ready', userMessageIndex: 67, createdAt: '2026-09-03T00:00:00.000Z', generationType: 'continue', reusedReceipt: true, receiptPersistence: 'saveUnconfirmed',
      selectedFloors: [{ assistantSeq: 2 }], selectedStates: [{ subject: '裴晚生', layer: 'core' }], selectedCseChanges: [{ subject: '裴晚生', layer: 'situational', action: 'remove', assistantSeq: 2 }],
      coverage: { rememberedAiFloors: 8, stableAiFloors: 8, cseThroughAssistantSeq: 8 },
      stages: { input: 3, candidates: 8, dropRecent: 3, dropPersistent: 0, dropVisibility: 0, selected: 1, recentSummaryCount: 1, distantHistoryItemCount: 3, linkedHistoryItemCount: 2, stateCount: 1, currentStateCount: 1, cseChangeCount: 2, linkedCseChangeCount: 1, budgetDroppedCount: 4, finalInjectionItemCount: 5, estimatedTokenCount:1234, estimatedTokenBudget:4000 },
      selectorDiagnostic: { mode: 'llm', historyCandidateCount: 12, stateCandidateCount: 7, historyExcludedCount: 2, stateExcludedCount: 1, historyRetainedCount: 10, stateRetainedCount: 6, utilityRoundTripMs: 8, localSelectionMs: 3,
        priority: { status: 'timeGuard', keys: ['R1', 'C2'], selectedKeys: ['R1'], ignoredCount: 3 } },
      timings: { totalMs: 12, sourceReadAttempts: { reachableReads: 1, exitPoint: 'ready' } }, skipReasons: ['recentRawWindow'],
      injectionText: '<qqj_recalled_context>\n旧约仍然有效\n</qqj_recalled_context>', error: null,
    },
  };
  for (const listener of listeners) listener(recall);
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /触发用户楼|第 67 楼|生成时间|生成类型|继续生成（continue）|复用 · 已请求宿主保存，结果未确认|来源楼号未提供|终点楼号未提供|裴晚生 \/ core|裴晚生 \/ situational \/ 移除/);
  assert.match(copy, /本轮复用耗时 12\.0 ms · 未发起新选材请求 · 原回执接口往返（含传输） 8\.0 ms · 本地选材 3\.0 ms/);
  assert.match(copy, /复用耗时 0\.0 秒/u, '复用摘要采用秒级格式且不把原始选材请求当作本轮请求');
  assert.match(copy, /输入 3 → 记忆楼 8 → 近期摘要 1 → 远期旧事 3（关联补入 2） → 当前态 1 → 历史变化 2（关联补入 1） → 未选入 4（含预算、条数或剧情线限制） → 最终材料 5/);
  const stage = flatten(container).find(node => node.className === 'v3-foundation-row' && node.children[0]?.textContent === '筛选阶段');
  assert.equal(stage.children[1].children.length, 2, 'Token估算须在筛选阶段原位置使用独立DOM行');
  assert.match(stage.children[1].children[0].textContent, /最终材料 5$/);
  assert.equal(stage.children[1].children[1].textContent, 'Token 保守估算 1234/4000');
  assert.match(copy, /智能选材计数.*历史候选 12 → 模型排除 2 → 保留 10 → 关联补入 2 → 最终远期 3 · 人物候选 7 → 模型排除 1 → 保留 6 → 关联补入 1 → 最终注入 3/);
  assert.match(copy, /优先证据 保留 1\/2 · 时间材料参与，本轮原序/);
  assert.match(copy, /完整快照 1 次 · 退出 读取成功/);
  assert.match(copy, /旧约仍然有效/);
  assert.doesNotMatch(copy, /时间参考 \d/u, '旧回执缺新字段时不冒报时间参考');
  delete recall.lastRecall.selectorDiagnostic.priority;
  for (const listener of listeners) listener(recall);
  assert.doesNotMatch(flatten(container).map(node => node.textContent).join('|'), /优先证据/u, '旧回执缺字段时不编造优先诊断');
  recall.lastRecall.stages.timeCorrectionCount = 1;
  recall.lastRecall.stages.timeReminderCount = 2;
  for (const listener of listeners) listener(recall);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /历史变化 2（关联补入 1） → 时间参考 3/u);
  view.deactivate();
  assert.equal(listeners.size, 0);
});

test('召回常用摘要区分向量候选与实际原文段，诊断默认折叠且复制仍保留完整回执', async () => {
  const foundation = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 4, rememberedCount: 4, floors: [] };
  const runtime = { getState: () => foundation, refreshStatus: async () => foundation, confirmLatest: async () => foundation };
  const listeners = new Set(), copied = [], container = new Node('main');
  let record = { schemaVersion: 17, status: 'ready', requestDiagnosticId: 3, userMessageIndex: 12, generationType: 'continue', receiptPersistence: 'chatRecord',
    selectedFloors: [{ assistantSeq: 2 }], selectedStates: [{ subject: '甲', layer: 'core' }], selectedCseChanges: [{ subject: '甲', layer: 'situational', action: 'update', assistantSeq: 2 }],
    stages: { input: 4, candidates: 9, recentSummaryCount: 2, distantHistoryItemCount: 3, stateCount: 1, currentStateCount: 1, cseChangeCount: 1, finalInjectionItemCount: 7, estimatedTokenCount: 1234, estimatedTokenBudget: 4000 },
    selectorDiagnostic: { mode: 'llm', historyCandidateCount: 8, stateCandidateCount: 2, historyModelSelectedCount: 3, stateModelSelectedCount: 1, semantic: { status: 'ready', candidateCount: 12, durationMs: 200 } },
    timings: { totalMs: 27300 }, skipReasons: [], injectionText: '<qqj_recalled_context>已注入材料</qqj_recalled_context>', error: null };
  let state = { recallStatus: 'ready', lastRecall: record, requestDiagnostic: { status: 'recording', requests: [{ label: '生成请求', startedAt: 1, requestStartedAt: 2, responseStartedAt: 3, finishedAt: 4 }] } };
  const view = createV3FoundationView({ runtime, recallRuntime: { getState: () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } }, documentRef,
    navigatorRef: { clipboard: { writeText: async value => copied.push(value) } } });
  view.mount(container);
  const text = () => flatten(container).map(node => node.textContent).join('|');
  const diagnostic = () => flatten(container).find(node => node.className.includes('qqj-recall-diagnostics'));
  assert.equal(diagnostic().open, false, '完整诊断默认关闭');
  assert.match(text(), /本轮选入：旧楼 1 · 当前状态 1 · 历史变化 1/u);
  assert.match(text(), /向量 可用 · 候选 12 · 选入原文段 0/u, '候选数不能冒充实际选入段数');
  assert.doesNotMatch(text(), /人工摘要未记录/u, '新回执不显示已取消的摘要向量字段');
  assert.match(text(), /本轮召回等待 27\.3 秒/u);
  assert.match(text(), /1234\/4000（保守估算）/u);
  assert.match(text(), /历史候选 8 → 模型选择 3/u, '完整筛选细节保留在可展开诊断中');
  diagnostic().open = true; diagnostic().fire('toggle');
  record = { ...record, selectedFloors: [{ assistantSeq: 2, rawWitnesses: [{ floorId: 'floor', floorMemoryId: 'memory', assistantSeq: 2, text: 'witness' }], summaryWitnesses: [] }] };
  state = { ...state, lastRecall: record };
  for (const listener of listeners) listener(state);
  assert.equal(diagnostic().open, true, '重绘后沿用诊断开合状态');
  assert.match(text(), /向量 可用 · 候选 12 · 选入原文段 1/u);
  assert.doesNotMatch(text(), /人工摘要 0条/u, '新回执不显示没有意义的人工摘要0条');
  record = { ...record, selectedFloors: [{ assistantSeq: 2, summaryWitnesses: [
    { sourceKind: 'userSummary', floorId: 'floor', floorMemoryId: 'memory', assistantSeq: 2, fingerprint: 'one' },
    { sourceKind: 'userSummary', floorId: 'floor-2', floorMemoryId: 'memory-2', assistantSeq: 3, fingerprint: 'two' },
  ] }] };
  state = { ...state, lastRecall: record };
  for (const listener of listeners) listener(state);
  assert.match(text(), /向量 可用 · 候选 12 · 选入原文段 0 · 历史人工摘要 2条/u, '旧回执的人工摘要见证仍如实显示');
  record = { ...record, selectedFloors: [{ assistantSeq: 2, rawWitnesses: [{ floorId: 'floor', floorMemoryId: 'memory', assistantSeq: 2, text: 'witness' }], summaryWitnesses: [] }] };
  state = { ...state, lastRecall: record };
  for (const listener of listeners) listener(state);
  diagnostic().open = false; diagnostic().fire('toggle');
  await flatten(container).find(node => node.textContent === '复制回执').click();
  assert.equal(diagnostic().open, false, '复制不要求展开诊断');
  assert.match(copied[0], /智能选材计数.*历史候选 8 → 模型选择 3/su);
  assert.match(copied[0], /实际注入：有；旧楼 1，状态 1，变化 1/u);
  assert.match(copied[0], /生成请求：发起/u, '折叠时仍复制最新请求计时');

  record = { ...record, status: 'stale', injectionText: '', skipReasons: ['sourceStale'], timings: { totalMs: 900 } };
  state = { ...state, recallStatus: 'stale', lastRecall: record };
  for (const listener of listeners) listener(state);
  assert.match(text(), /候选材料（本轮未注入）/u);
  assert.match(text(), /候选原文段 1/u, '未提交材料只标为候选');
  assert.match(text(), /记忆来源正在更新，本轮已安全跳过召回注入/u);

  record = { ...record, status: 'error', skipReasons: ['error'], error: null, selectorDiagnostic: { ...record.selectorDiagnostic, semantic: { status: 'VECTOR_TIMEOUT', candidateCount: 12 } } };
  state = { ...state, recallStatus: 'error', lastRecallError: { code: 'V3_RECALL_SOURCE_UNAVAILABLE' }, lastRecall: record };
  for (const listener of listeners) listener(state);
  assert.match(text(), /当前聊天记忆暂时无法读取/u, '短失败原因在折叠诊断外仍可见');
  const safeErrorNode = flatten(container).find(node => node.className === 'v3-foundation-feedback error');
  for (let node = safeErrorNode; node; node = node.parentNode) assert.notEqual(node, diagnostic(), '短失败原因不得藏在折叠诊断中');
  const vectorRow = () => flatten(container).find(node => node.className === 'v3-foundation-row' && node.children[0]?.textContent === '向量');
  assert.match(vectorRow().children[1].textContent, /查询超时/u);
  for (const [status, label] of [['VECTOR_INDEX_LOAD_TIMEOUT', '索引读取超时'], ['VECTOR_ABORTED', '查询已取消'], ['VECTOR_QUERY_BUDGET_EXHAUSTED', '本轮次数已用尽'], ['VECTOR_OTHER_FAILURE', '不可用']]) {
    record = { ...record, selectorDiagnostic: { ...record.selectorDiagnostic, semantic: { status, candidateCount: 0 } } };
    state = { ...state, lastRecall: record };
    for (const listener of listeners) listener(state);
    assert.match(vectorRow().children[1].textContent, new RegExp(label));
  }
  record = { ...record, status: 'ready', skipReasons: [], selectorDiagnostic: { ...record.selectorDiagnostic, semantic: { status: 'unindexed', candidateCount: 0, durationMs: 12 } } };
  state = { ...state, recallStatus: 'ready', lastRecallError: null, lastRecall: record };
  for (const listener of listeners) listener(state);
  assert.match(vectorRow().children[1].textContent, /本轮无可用向量片段 · 候选 0/u);
  assert.doesNotMatch(vectorRow().children[1].textContent, /未建索引|unindexed/u, '内部状态名不直接展示给用户');
  await flatten(container).find(node => node.textContent === '复制回执').click();
  assert.match(copied.at(-1), /向量 本轮无可用向量片段 · 候选 0 · 12\.0 ms/u, '复制回执复用用户可见状态文案');

  record = { ...record, status: 'stale', terminationEvent: 'GENERATION_ENDED', diagnosticPhase: 'selecting', selectionStatus: 'incomplete',
    pendingStep: 'utilityTask', lastCompletedStep: 'candidateBuild', attemptDiagnostics: [{ attempt: 1, phase: 'selecting', selectionStatus: 'incomplete', pendingStep: 'utilityTask', lastCompletedStep: 'candidateBuild', timings: { totalMs: 27300, sourceMs: 400, selectorMs: 26000 } }],
    timings: { totalMs: 27300, sourceMs: 400, selectorMs: 26000 }, skipReasons: ['stopped'], injectionText: '' };
  state = { ...state, recallStatus: 'stale', lastRecall: record };
  for (const listener of listeners) listener(state);
  assert.match(text(), /生成已结束，召回未完成/u);
  assert.match(text(), /候选材料（本轮未注入）/u);
  assert.match(text(), /终止时步骤 模型选材/u);
  assert.match(text(), /本轮未注入/u);
  assert.doesNotMatch(text(), /正在等待最新结果/u);
  await flatten(container).find(node => node.textContent === '复制回执').click();
  assert.match(copied.at(-1), /召回回执：生成已结束，召回未完成/u);
  assert.match(copied.at(-1), /实际注入：无/u);
  assert.match(copied.at(-1), /上一步 候选构建/u);
  view.deactivate();
  assert.equal(listeners.size, 0);
});

test('召回区分无可靠命中与来源更新/不可用的安全跳过', () => {
  const foundation = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 2, rememberedCount: 1, unprocessedCount: 1, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'head', activeRun: null, activeExtraction: null, activeCse: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, cseReady: false, csePendingCount: 0, cseFailedCount: 0, baselineId: null, cseSubjects: [], floors: [] };
  const runtime = { getState: () => foundation, refreshStatus: async () => foundation, confirmLatest: async () => foundation };
  const container = new Node('main');
  let recall = { recallStatus: 'empty', activeRecall: null, lastRecallError: null, lastRecall: { status: 'empty', generationType: 'continue', reusedReceipt: false, receiptPersistence: 'none', selectedFloors: [], selectedStates: [], coverage: null, stages: null, timings: null, skipReasons: [], injectionText: '', error: null } };
  const listeners = new Set();
  const recallRuntime = { getState: () => recall, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  const view = createV3FoundationView({ runtime, recallRuntime, documentRef });
  view.mount(container);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /完成 · 无需注入.*本轮没有需要注入的记忆/);
  for (const [reasons, copy] of [[['sourceStale'], '记忆来源正在更新'], [['sourceUnavailable'], '记忆来源暂不可用'], [['memoryRebuilding'], '历史记忆正在后台重建'], [['memoryNotReady', 'historicalRebuildRequired'], '当前存在历史记忆缺口']]) {
    recall = { recallStatus: 'skipped', activeRecall: null, lastRecallError: null, lastRecall: { ...recall.lastRecall, status: 'skipped', skipReasons: reasons } };
    for (const listener of listeners) listener(recall);
    const text = flatten(container).map(node => node.textContent).join('|');
    assert.match(text, new RegExp(copy));
    assert.doesNotMatch(text, /聊天身份/);
  }
  recall = { recallStatus: 'ready', activeRecall: null, lastRecallError: null,
    lastRecall: { ...recall.lastRecall, status: 'ready', skipReasons: ['partialAggregateBodyOverlap'] } };
  for (const listener of listeners) listener(recall);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /部分聚合摘要与当前正文来源重叠；整条材料仍参与相关性和预算筛选，可能重复，未逐成员拆分/u);
});

test('真实uninitialized召回记录在设置页显示待记录且正文继续生成', async () => {
  const assistant = { is_user: false, is_system: false, mes: '欢迎来到新故事。' };
  const user = { is_user: true, is_system: false, mes: '我们开始吧。' };
  const chat = [assistant, user];
  const context = { chat, chatMetadata: { qianqianjie: { schemaVersion: 1 } },
    constants: { promptTypes: { IN_CHAT: 1 }, promptRoles: { SYSTEM: 0 } }, setExtensionPrompt() {} };
  const recall = createV3RecallRuntime({ store: { readReachable: async () => { throw new Error('uninitialized must skip storage'); } }, hostAdapter: { snapshot: () => ({ context, chat }) },
    prepareMemory: async () => ({ status: 'uninitialized' }), logger: { warn() {} } });
  const result = await recall.intercept(chat, 8192, () => assert.fail('正常待记录不应中止生成'), 'normal');
  assert.equal(result.lastRecall.status, 'skipped');
  assert.deepEqual(result.lastRecall.skipReasons, ['uninitialized']);
  const foundationState = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: null,
    foundationStatus: 'uninitialized', stableCount: 0, rememberedCount: 0, unprocessedCount: 0, floors: [] };
  const runtime = { getState: () => foundationState, refreshStatus: async () => foundationState, confirmLatest: async () => foundationState };
  const recallRuntime = { getState: () => ({ recallStatus: 'skipped', lastRecall: result.lastRecall }) };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, recallRuntime, documentRef });
  view.mount(container);
  const text = flatten(container).map(node => node.textContent).join('|');
  assert.match(text, /尚未开始记录，本轮不注入记忆，正文继续生成/u);
  assert.doesNotMatch(text, /召回失败，正文生成已停止/u);
  view.deactivate();
});

test('复制回执仅诊断，独立fallback不切抽屉或重绘草稿，失败阶段不冒称注入', async () => {
  const foundation = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 0, rememberedCount: 0, unprocessedCount: 0, memorySyncStatus: 'idle', floors: [] };
  const runtime = { getState: () => foundation, refreshStatus: async () => foundation, confirmLatest: async () => foundation };
  const record = { status: 'error', userMessageIndex: 4, createdAt: '2026-09-15T00:00:00Z', generationType: 'normal', receiptPersistence: 'none', selectedFloors: [{ floorId: 'secret-floor' }], selectedStates: [{ text: '人物状态秘密原文', subject: '隐私姓名', layer: 'core' }], selectedCseChanges: [], injectionText: '注入正文SECRET_AUTH_COOKIE', skipReasons: ['error'],
    coverage: { rememberedAiFloors: 8, stableAiFloors: 8, cseThroughAssistantSeq: 8 }, stages: { input: 2, candidates: 8, recentSummaryCount: 3, distantHistoryItemCount: 2, stateCount: 1, currentStateCount: 1, cseChangeCount: 0, finalInjectionItemCount: 6, budgetDroppedCount: 0 },
    diagnosticAttempt: 1, diagnosticPhase: 'commit', selectionStatus: 'completed', timings: { totalMs: 64000, selectorMs: 28000, sourceMs: 1300, sourceReadAttempts: { reachableReads: 0, exitPoint: 'validatedSnapshot' } },
    selectorDiagnostic: { mode: 'llm', code: 'V3_RECALL_LLM_FIELDS_MISSING', finishReason: 'length', historyCandidateCount: 8, stateCandidateCount: 1, historyRetainedCount: 2, stateRetainedCount: 1 }, error: { code: 'V3_RECALL_MEMORY_PREPARATION_TIMEOUT', finishReason: 'stop', message: '不能复制的原始响应SECRET_ERROR' },
    attemptDiagnostics: [{ attempt: 1, phase: 'commit', selectionStatus: 'completed', timings: { totalMs: 33000 }, error: { code: 'TEST_FIRST_COMMIT', finishReason: 'length' } }, { attempt: 2, phase: 'source', selectionStatus: 'notStarted', timings: { totalMs: 5000 }, error: { code: 'V3_RECALL_MEMORY_PREPARATION_TIMEOUT', finishReason: 'content_filter' } }] };
  for (const mode of ['success', 'denied', 'missing']) {
    const copied = [], navigatorRef = mode === 'missing' ? {} : { clipboard: { writeText: async value => { copied.push(value); if (mode === 'denied') throw new Error('denied'); } } };
    const recallRuntime = { getState: () => ({ recallStatus: 'error', lastRecall: record }), getPrequel: () => ({ text: '前情私密正文' }), savePrequel: async () => ({}) };
    const container = new Node('main'), view = createV3FoundationView({ runtime, recallRuntime, documentRef, navigatorRef }); view.mount(container);
    const pageText = flatten(container).map(node => node.textContent).join('|');
    assert.match(pageText, /结束原因 length/u, '页面展示智能选材的完成原因');
    assert.match(pageText, /结束原因 stop/u, '页面展示本轮错误的完成原因');
    assert.match(pageText, /结束原因 content_filter/u, '页面展示各次尝试的完成原因');
    const button = flatten(container).find(node => node.textContent === '复制回执'), drawer = button.parentNode.parentNode;
    drawer.open = true; drawer.fire('toggle'); container.scrollTop = 52;
    flatten(container).find(node => node.textContent === '编辑前情').click();
    const draft = flatten(editorContent()).find(node => node.className.includes('qqj-prequel-editor')); draft.value = '草稿内容PRIVATE'; draft.fire('input');
    for (const node of flatten(drawer).filter(node => node.children.length)) Object.defineProperty(node, 'textContent', { configurable: true, get: () => node.children.map(child => child.textContent).join('') });
    const replacements = container.replaceCount; await button.click();
    assert.equal(drawer.open, true); assert.equal(container.replaceCount, replacements); assert.equal(container.scrollTop, 52); assert.equal(flatten(editorContent()).find(node => node.className.includes('qqj-prequel-editor')), draft); assert.equal(draft.value, '草稿内容PRIVATE');
    const fallback = flatten(drawer).find(node => node.attributes['aria-label'] === '召回回执诊断复制文本');
    const text = mode === 'success' ? copied[0] : fallback.value;
    assert.match(text, /记忆 8\/8.*第 1 次尝试的候选选材结果/su); assert.match(text, /第 2 次尝试.*来源读取.*未执行选材/su); assert.match(text, /实际注入：无/u); assert.match(text, /V3_RECALL_MEMORY_PREPARATION_TIMEOUT/u);
    assert.match(text, /结束原因 length/u); assert.match(text, /结束原因 stop/u); assert.match(text, /结束原因 content_filter/u);
    assert.equal(text.match(/触发用户楼/gu).length, 1, '真实DOM聚合textContent不能重复拼字段');
    assert.doesNotMatch(text, /注入正文|秘密原文|隐私姓名|SECRET_|前情私密|PRIVATE|收据复用或未执行|最终注入 1/u);
    if (mode === 'success') assert.equal(fallback, undefined); else { assert.equal(fallback.readOnly, true); assert.ok(flatten(drawer).includes(fallback)); }
    view.deactivate();
  }
  const container = new Node('main'); createV3FoundationView({ runtime, documentRef }).mount(container); assert.equal(flatten(container).some(node => node.textContent === '复制回执'), false);
});

test('复制回执附核验保存计时及最新本轮请求，不混入新轮或响应正文', async () => {
  const foundation = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 0, rememberedCount: 0, memorySyncStatus: 'idle', floors: [] };
  const record = { status: 'ready', requestDiagnosticId: 7, userMessageIndex: 4, createdAt: '2026-10-02T11:46:51Z', generationType: 'normal', receiptPersistence: 'saveUnconfirmed',
    selectedFloors: [], selectedStates: [], coverage: null, stages: null, timings: { totalMs: 146000, selectorMs: 24000, sourceMs: 1000, commitMs: 3, receiptMs: 120000 }, skipReasons: [], injectionText: 'PRIVATE_BODY', error: null };
  let state = { recallStatus: 'ready', lastRecall: record, requestDiagnostic: { status: 'recording', requests: [] } };
  const copied = [], container = new Node('main');
  createV3FoundationView({ runtime: { getState: () => foundation, refreshStatus: async () => foundation, confirmLatest: async () => foundation }, recallRuntime: { getState: () => state }, documentRef,
    navigatorRef: { clipboard: { writeText: async text => copied.push(text) } } }).mount(container);
  const text = flatten(container).map(node => node.textContent).join('|');
  assert.match(text, /核验 3\.0 ms.*保存 120000\.0 ms/u);
  const button = flatten(container).find(node => node.textContent === '复制回执');
  const stamp = Date.parse('2026-10-02T11:49:00Z');
  state.requestDiagnostic.requests.push({ label: '生成请求', startedAt: stamp, requestStartedAt: stamp + 2000, responseStartedAt: stamp + 2100, finishedAt: stamp + 2150, responseText: 'PRIVATE_RESPONSE' });
  await button.click();
  assert.match(copied[0], /核验 3\.0 ms.*保存 120000\.0 ms/su);
  assert.match(copied[0], /生成请求.*2026-10-02T11:49:02\.000Z/su, '读取复制时才完成的请求');
  assert.match(copied[0], /首响应不代表模型首字/u); assert.doesNotMatch(copied[0], /PRIVATE_/u);
  state = { ...state, lastRecall: { ...record, requestDiagnosticId: 8 }, requestDiagnostic: { status: 'recording', requests: [{ label: '另一轮请求' }] } };
  await button.click();
  assert.match(copied[1], /请求计时：未记录/u); assert.doesNotMatch(copied[1], /另一轮请求/u);
});

test('后台保存更新现有回执小字，等待与保存耗时分列，失败仍保留可用材料', async () => {
  const foundation = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 0, rememberedCount: 0, memorySyncStatus: 'idle', floors: [] };
  const record = { status: 'ready', requestDiagnosticId: 7, userMessageIndex: 4, createdAt: '2026-10-02T11:46:51Z', generationType: 'normal', receiptPersistence: 'saving',
    selectedFloors: [], selectedStates: [], coverage: null, stages: null, timings: { totalMs: 15000, selectorMs: 14000, commitMs: 500 }, skipReasons: [], injectionText: 'PRIVATE_BODY', error: null };
  let state = { recallStatus: 'ready', activeRecall: null, lastRecall: record };
  const listeners = new Set(), copied = [], container = new Node('main');
  const view = createV3FoundationView({ runtime: { getState: () => foundation, refreshStatus: async () => foundation, confirmLatest: async () => foundation },
    recallRuntime: { getState: () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } }, documentRef,
    navigatorRef: { clipboard: { writeText: async text => copied.push(text) } } });
  view.mount(container);
  const pageText = () => flatten(container).map(node => node.textContent).join('|');
  const copy = () => flatten(container).find(node => node.textContent === '复制回执').click();
  assert.match(pageText(), /后台保存中；刷新可能丢失本轮回执/u);
  assert.match(pageText(), /本轮召回等待 15000\.0 ms.*核验 500\.0 ms · 后台保存中/u);
  assert.match(pageText(), /本轮召回等待 15\.0 秒/u);
  assert.doesNotMatch(pageText(), /本轮召回等待 135\.0 秒/u, '后台回执保存时间不加入召回等待');
  await copy();
  assert.match(copied[0], /召回回执：可用.*后台保存中/su);
  assert.doesNotMatch(copied[0], /PRIVATE_BODY|后台保存 \d/u);

  state = { ...state, lastRecall: { ...record, receiptPersistence: 'saveUnconfirmed', timings: { ...record.timings, receiptMs: 12000 } } };
  for (const listener of listeners) listener(state);
  assert.match(pageText(), /已请求宿主保存，结果未确认/u);
  assert.match(pageText(), /本轮召回等待 15000\.0 ms.*后台保存 12000\.0 ms/u);
  assert.match(pageText(), /本轮召回等待 15\.0 秒/u);
  assert.doesNotMatch(pageText(), /后台保存中|本轮召回等待 27000/u);
  await copy();
  assert.match(copied[1], /本轮召回等待 15000\.0 ms.*后台保存 12000\.0 ms/su);
  assert.doesNotMatch(copied[1], /PRIVATE_BODY/u);

  state = { ...state, lastRecall: { ...state.lastRecall, receiptPersistence: 'sessionOnly' } };
  for (const listener of listeners) listener(state);
  assert.match(pageText(), /未保存；仅当前页面可复用/u);
  assert.match(pageText(), /PRIVATE_BODY/u, '保存失败不撤回已核验的召回材料');
  await copy();
  assert.match(copied[2], /召回回执：可用.*未保存；仅当前页面可复用/su);
  view.deactivate();
  assert.equal(listeners.size, 0);
});

test('召回归属旧字段缺失自然降级，候选回复使用中文标签且不拒绝正文', () => {
  const foundation = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 2, rememberedCount: 2, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'head', activeRun: null, activeExtraction: null, activeCse: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, floors: [] };
  const runtime = { getState: () => foundation, refreshStatus: async () => foundation, confirmLatest: async () => foundation };
  const recallState = { recallStatus: 'ready', activeRecall: null, lastRecallError: null, lastRecall: { status: 'ready', generationType: 'swipe', reusedReceipt: false, receiptPersistence: 'sessionOnly', selectedFloors: [], selectedStates: [], coverage: null, stages: null, timings: null, skipReasons: [], injectionText: '<qqj_recalled_context>旧格式仍展示</qqj_recalled_context>', error: null } };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, recallRuntime: { getState: () => recallState }, documentRef });
  view.mount(container);
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /触发用户楼\|旧记录未提供.*生成时间\|旧记录未提供.*切换候选回复.*旧格式仍展示/);
  assert.match(copy, /智能选材计数.*历史候选 未知 → 模型选择 未知 → 最终远期 未知 · 人物候选 未知 → 模型选择 未知 → 最终注入 未知/);
  assert.doesNotMatch(copy, /历史候选 0|人物候选 0/);
});

test('Schema 4 只读历史缺少归属显示字段仍展示正文，并明确不代表本轮已注入', () => {
  const foundation = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 2, rememberedCount: 2, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'head', activeRun: null, activeExtraction: null, activeCse: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, floors: [] };
  const runtime = { getState: () => foundation, refreshStatus: async () => foundation, confirmLatest: async () => foundation };
  const recallState = { recallStatus: 'ready', activeRecall: null, lastRecallError: null, lastRecall: { status: 'ready', userMessageIndex: null, createdAt: null, generationType: null, reusedReceipt: false, restoredReceipt: true, legacyReadOnly: true, receiptPersistence: 'legacyReadOnly', selectedFloors: [], selectedStates: [], coverage: null, stages: null, timings: null, skipReasons: [], injectionText: '<qqj_recalled_context>Schema 4 旧正文</qqj_recalled_context>', error: null } };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, recallRuntime: { getState: () => recallState }, documentRef });
  view.mount(container);
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /旧版只读记录 · 不代表本轮已注入/);
  assert.match(copy, /触发用户楼\|旧记录未提供.*生成时间\|旧记录未提供.*生成类型\|旧记录未提供/);
  assert.match(copy, /不会复用、注入或升级为当前回执.*Schema 4 旧正文/);
});

test('activate 请求恢复聊天记录回执，并明确标注历史展示、不重新注入与来源读取', async () => {
  const foundation = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 8, rememberedCount: 8, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'new-head', activeRun: null, activeExtraction: null, activeCse: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, cseReady: true, csePendingCount: 0, cseFailedCount: 0, baselineId: 'baseline', cseSubjects: [], floors: [] };
  const runtime = { getState: () => foundation, refreshStatus: async () => foundation, confirmLatest: async () => foundation };
  let restores = 0;
  const recallState = {
    recallStatus: 'ready', activeRecall: null, lastRecallError: null,
    lastRecall: {
      schemaVersion: 17, status: 'ready', generationType: 'normal', reusedReceipt: false, restoredReceipt: true, receiptPersistence: 'chatRecord',
      selectedFloors: [{ assistantSeq: 2, rawWitnesses: [{ floorId: 'floor', floorMemoryId: 'memory', assistantSeq: 2, text: '历史段' }] }], selectedStates: [], coverage: { rememberedAiFloors: 6, stableAiFloors: 6, cseThroughAssistantSeq: 6 },
      stages: { input: 3, candidates: 6, dropRecent: 3, dropPersistent: 0, dropVisibility: 0, selected: 1 }, timings: { totalMs: 3600 }, skipReasons: [],
      selectorDiagnostic: { semantic: { status: 'ready', candidateCount: 1 } },
      injectionText: '<qqj_recalled_context>历史实际注入</qqj_recalled_context>', error: null,
    },
  };
  const recallRuntime = { getState: () => recallState, restorePersistedReceipt: async () => { restores += 1; return recallState; } };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, recallRuntime, documentRef });
  view.mount(container);
  await view.activate();
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.equal(restores, 1);
  assert.match(copy, /最近一次召回结果|聊天记录中的回执 · 恢复显示/);
  assert.match(copy, /从聊天记录读取 · 仅恢复历史展示，不会再次注入|历史回执不重新读取来源|历史实际注入/);
  assert.match(copy, /历史耗时 3\.6 秒/u, '恢复回执明确标注历史耗时');
  assert.match(copy, /历史选入原文段 1/u, '历史段落不标成本轮候选或注入');
});

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('三页职责分离，千结只保留摘要编辑/重提，双丝网归位人物与逐楼 CSE，管理页不混摘要', () => {
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const state = {
    status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, unprocessedCount: 0,
    pending: null, headCheckpointId: 'head', lastError: null, lastExtractorError: null, lastCseError: null, cseReady: true, csePendingCount: 0, cseFailedCount: 0,
    baselineId: 'baseline', mainCharacterEntityId: 'character', mainCharacterDisplayName: '裴晚生',
    cseSubjects: [{ subjectEntityId: 'character', displayName: '裴晚生', core: [{ text: '克制', reason: '基线', visibility: 'authorial', origin: 'baseline' }], adaptive: [], situational: [] }],
    floors: [{ floorId: 'floor', assistantSeq: 1, messageIndex: 4, canonicalFingerprint: 'sha256:same', status: 'ready', memoryId: 'memory', summary: '剧情摘要', summarySource: 'ai', memory, cse: { status: 'ready', deltaId: 'delta' } }],
  };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state, editSummary: async () => state, retryStateAnalysis: async () => state, copySafeDiagnostic: () => '{}', copyFullDiagnostic: () => '{}' };
  const container = new Node('main');
  const selectedPeople = peopleRuntime([{ entityId: 'character', displayName: '裴晚生', entityDisplayName: '裴晚生' }]);
  const view = createV3FoundationView({ runtime, peopleRuntime: selectedPeople, documentRef });
  view.setPage('memories'); view.mount(container);
  let copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /已记忆 1\/1 楼.*第 4 楼.*剧情摘要.*编辑.*重新提取/);
  assert.doesNotMatch(copy, /逐楼校对故事摘要/);
  assert.equal(flatten(container).some(node => node.tag === 'h2' && node.textContent === '千结'), false);
  assert.doesNotMatch(copy, /状态分析记录|详细诊断|恢复 AI|标记错误/);
  assert.doesNotMatch(copy, /刷新状态/);
  view.setPage('people'); copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /关系往来.*裴晚生.*核心特质/);
  assert.doesNotMatch(copy, /剧情摘要|复制完整诊断/);
  assert.doesNotMatch(copy, /刷新状态/);
  flatten(container).find(node => node.textContent === '分析记录').click(); openDetails(flatten(container).find(node => node.className === 'qqj-cse-history-row')); copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /分析记录.*重新分析/);
  view.setPage('management'); copy = flatten(container).map(node => node.textContent).join('|');
  for (const value of ['记忆管理', '补齐缺失', '完全重构', '最近召回回执', '详细诊断']) assert.ok(copy.includes(value));
  assert.ok(copy.indexOf('最近召回回执') < copy.indexOf('详细诊断'));
  assert.doesNotMatch(copy, /API 接口/);
  assert.match(copy, /刷新状态/);
  assert.doesNotMatch(copy, /剧情摘要|重新提取/);
  for (const button of flatten(container).filter(node => node.tag === 'button')) assert.equal(button.type, 'button');
});

test('管理页刷新状态按钮发起 fresh 读取并显式核对 foundation', async () => {
  const state = { status: 'ready', memorySnapshotStatus: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 0, rememberedCount: 0, unprocessedCount: 0, pending: null, headCheckpointId: 'head', lastError: null, lastExtractorError: null, lastCseError: null, floors: [], memoryWorkBusy: false };
  const calls = [];
  let releaseRefresh;
  const pendingRefresh = new Promise(resolve => { releaseRefresh = () => resolve(state); });
  const runtime = { getState: () => state, refreshStatus: options => { calls.push(options); return pendingRefresh; }, confirmLatest: async () => state };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef });
  view.setPage('management'); view.mount(container);
  const button = flatten(container).find(node => node.textContent === '刷新状态');
  assert.ok(button);
  const replaceCount = container.replaceCount;
  button.click();
  const pendingFeedback = flatten(container).find(node => node.className.includes('qqj-management-feedback'));
  assert.equal(pendingFeedback.textContent, '正在刷新状态…', '未决刷新必须立即显示在实际反馈节点');
  assert.equal(pendingFeedback.className.includes('error'), false);
  assert.equal(container.replaceCount, replaceCount, '显示刷新进度不得整页重绘');
  releaseRefresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [{ preferCached: false, recoverTailDeletion: true, reconcileFoundation: true }]);
  assert.equal(flatten(container).find(node => node.className.includes('qqj-management-feedback')).textContent, '当前聊天已读取完成。');
});

test('管理页刷新反馈跟随真实终态并保留后续操作反馈', async () => {
  const initial = { status: 'ready', foundationStatus: 'ready', memorySnapshotStatus: 'ready', memorySyncStatus: 'ready', pluginEnabled: true,
    chatId: CHAT, stableCount: 247, rememberedCount: 247, unprocessedCount: 0, floors: [], memoryWorkBusy: false,
    lastError: null, lastExtractorError: null, lastCseError: null };
  const mixed = { ...initial, memorySyncStatus: 'syncing' };
  const reviewed = { ...initial, status: 'needsReview', foundationStatus: 'ready', memorySnapshotStatus: 'ready', memorySyncStatus: 'needsReview',
    reviewReason: { code: 'markerMismatch', messageIndex: 495, expectedCount: 247, actualCount: 248, markerStatus: 'valid', bindingIssue: 'markerConflict' },
    floors: [{ floorId: 'floor-247', assistantSeq: 247, messageIndex: 493, status: 'ready', memoryId: 'memory-247' }] };
  let state = initial, listener, releaseRefresh, copied;
  const pending = new Promise(resolve => { releaseRefresh = () => { state = mixed; resolve(mixed); }; });
  const calls = [];
  const runtime = { getState: () => state, refreshStatus: options => { calls.push(options); return pending; }, confirmLatest: async () => state,
    subscribe(callback) { listener = callback; return () => { listener = null; }; }, copySafeDiagnostic: () => ({ status: state.status }) };
  const container = new Node('main'), view = createV3FoundationView({ runtime, documentRef,
    navigatorRef: { clipboard: { writeText: async value => { copied = value; } } } });
  view.setPage('management'); view.mount(container);
  flatten(container).find(node => node.textContent === '刷新状态').click();
  state = { ...initial, memorySyncStatus: 'idle' }; listener(state);
  assert.equal(flatten(container).find(node => node.className.includes('qqj-management-feedback')).textContent, '正在刷新状态…', '本次刷新开始前排队的旧 ready/idle 通知不能结算新提示');
  releaseRefresh();
  await new Promise(resolve => setImmediate(resolve));
  listener(state);
  let feedback = flatten(container).find(node => node.className.includes('qqj-management-feedback'));
  assert.match(feedback.textContent, /后台校验仍在进行/u);
  assert.doesNotMatch(feedback.textContent, /已记忆|已保留/u);

  state = reviewed; listener(state);
  feedback = flatten(container).find(node => node.className.includes('qqj-management-feedback'));
  assert.equal(feedback.textContent, '核验已结束；第 495 楼记忆标记需核对。已保留 247 楼记忆。');
  assert.doesNotMatch(feedback.textContent, /后台校验仍在进行/u);
  assert.deepEqual(calls, [{ preferCached: false, recoverTailDeletion: true, reconcileFoundation: true }]);

  flatten(container).find(node => node.textContent === '复制状态诊断').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(copied);
  assert.equal(flatten(container).find(node => node.className.includes('qqj-management-feedback')).textContent, '已复制。');
  state = { ...initial, status: 'ready', foundationStatus: 'ready', memorySnapshotStatus: 'ready', memorySyncStatus: 'ready' };
  listener(state);
  assert.equal(flatten(container).find(node => node.className.includes('qqj-management-feedback')).textContent, '已复制。', '后续runtime订阅不得覆盖复制等较新的操作反馈');
});

test('管理页刷新订阅对 ready idle 与真实错误显示各自终态', async () => {
  for (const terminal of [
    { status: 'idle', foundationStatus: 'uninitialized', memorySnapshotStatus: 'ready', memorySyncStatus: 'idle', rememberedCount: 0 },
    { status: 'error', foundationStatus: 'ready', memorySnapshotStatus: 'ready', memorySyncStatus: 'error', memorySyncError: { code: 'V3_MEMORY_LOAD_FAILED' } },
  ]) {
    const initial = { status: 'ready', foundationStatus: 'ready', memorySnapshotStatus: 'ready', memorySyncStatus: 'ready', pluginEnabled: true,
      chatId: CHAT, stableCount: 0, rememberedCount: 0, floors: [], memoryWorkBusy: false, lastError: null, lastExtractorError: null, lastCseError: null };
    let state = initial, listener, releaseRefresh;
    const pending = new Promise(resolve => { releaseRefresh = () => { state = { ...initial, memorySyncStatus: 'syncing' }; resolve(state); }; });
    const runtime = { getState: () => state, refreshStatus: async () => pending, confirmLatest: async () => state,
      subscribe(callback) { listener = callback; return () => { listener = null; }; } };
    const container = new Node('main'), view = createV3FoundationView({ runtime, documentRef });
    view.setPage('management'); view.mount(container);
    flatten(container).find(node => node.textContent === '刷新状态').click();
    releaseRefresh(); await new Promise(resolve => setImmediate(resolve));
    state = { ...initial, ...terminal }; listener(state);
    const feedback = flatten(container).find(node => node.className.includes('qqj-management-feedback'));
    if (terminal.status === 'idle') {
      assert.match(feedback.textContent, /尚未建立记忆/u);
      assert.doesNotMatch(feedback.textContent, /校验仍在进行/u);
    } else {
      assert.match(feedback.textContent, /刷新状态未完成/u);
      assert.match(feedback.textContent, /记忆数据读取失败/u);
      assert.equal(feedback.className.includes('error'), true);
      assert.doesNotMatch(feedback.textContent, /校验仍在进行/u);
    }
  }
});

test('旧刷新失败不清理较新刷新的反馈所有权', async () => {
  const initial = { status: 'ready', foundationStatus: 'ready', memorySnapshotStatus: 'ready', memorySyncStatus: 'ready', pluginEnabled: true,
    chatId: CHAT, rememberedCount: 0, floors: [], memoryWorkBusy: false, lastError: null, lastExtractorError: null, lastCseError: null };
  let state = initial, listener;
  const pending = [];
  const runtime = { getState: () => state, refreshStatus: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    confirmLatest: async () => state, subscribe(callback) { listener = callback; return () => { listener = null; }; } };
  const container = new Node('main'), view = createV3FoundationView({ runtime, documentRef });
  view.setPage('management'); view.mount(container);
  const refresh = () => flatten(container).find(node => node.textContent === '刷新状态').click();
  refresh(); refresh();
  state = { ...initial, memorySyncStatus: 'syncing' }; pending[1].resolve(state);
  await new Promise(resolve => setImmediate(resolve));
  pending[0].reject(new Error('older refresh failed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(flatten(container).find(node => node.className.includes('qqj-management-feedback')).textContent, '当前聊天已读取完成；后台校验仍在进行。');
  state = { ...initial, status: 'needsReview', memorySyncStatus: 'needsReview', reviewReason: { code: 'markerMismatch', messageIndex: 495 }, rememberedCount: 247 };
  listener(state);
  assert.equal(flatten(container).find(node => node.className.includes('qqj-management-feedback')).textContent, '核验已结束；记忆仍需核对。已保留 247 楼记忆。');
});

test('同聊天记忆同步保留千结与双丝网已确认文字，确认结果或切聊后再替换', () => {
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const floor = { floorId: 'floor', assistantSeq: 1, messageIndex: 4, canonicalFingerprint: 'sha256:same', status: 'ready', memoryId: 'memory', summary: '同步期间必须保留的摘要', summarySource: 'ai', memory, cse: { status: 'ready', deltaId: 'delta' } };
  const ready = {
    status: 'ready', memorySnapshotStatus: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, unprocessedCount: 0,
    memoryWorkBusy: false, activeAutoMemory: null, activeExtraction: null, activeCse: null, cseReady: true, csePendingCount: 0, cseFailedCount: 0,
    mainCharacterEntityId: 'character', mainCharacterDisplayName: '裴晚生',
    cseSubjects: [{ subjectEntityId: 'character', displayName: '裴晚生', core: [{ text: '同步期间必须保留的人物状态', reason: '已确认', visibility: 'authorial', origin: 'baseline' }], adaptive: [], situational: [] }],
    floors: [floor],
  };
  let state = ready;
  const listeners = new Set();
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state, editSummary: async () => state, retryStateAnalysis: async () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  const emit = next => { state = next; for (const listener of listeners) listener(next); };
  const selectedPeople = peopleRuntime([{ entityId: 'character', displayName: '裴晚生', entityDisplayName: '裴晚生' }]);
  const container = new Node('main'), view = createV3FoundationView({ runtime, peopleRuntime: selectedPeople, documentRef });
  view.setPage('memories'); view.mount(container);
  const memoryTree = container.children[0];
  const summaryCard = flatten(container).find(node => node.className.includes('qqj-memory-card'));
  assert.ok(summaryCard && !summaryCard.open, '摘要正文应在首次展开前保持惰建');
  emit({ ...ready, status: 'ready', memorySnapshotStatus: 'syncing', memoryWorkBusy: false, floors: [], cseSubjects: [] });
  let copy = flatten(container).map(node => node.textContent).join('|');
  assert.equal(container.children[0], memoryTree, '同步通知不得重建或清空当前页面 DOM');
  assert.match(copy, /已记忆 1\/1 楼.*后台同步中/);
  assert.doesNotMatch(copy, /同步期间必须保留的摘要/, '折叠摘要正文应保持惰建');
  assert.equal(flatten(summaryCard).some(node => node.textContent === '重新提取'), false, '折叠摘要在同步开始时仍不预建正文');
  summaryCard.open = true; summaryCard.fire('toggle');
  const extractButton = flatten(summaryCard).find(node => node.textContent === '重新提取');
  assert.equal(extractButton.disabled, true, '同步开始后首次展开必须以同步呈现状态禁用依赖快照的动作');
  copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /已记忆 1\/1 楼.*后台同步中.*同步期间必须保留的摘要/);

  view.setPage('people');
  copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /同步期间必须保留的人物状态/, '同步期间切换到双丝网页仍显示同聊天上次确认结果');

  const confirmedEmpty = { ...ready, memorySnapshotStatus: 'ready', stableCount: 0, rememberedCount: 0, floors: [], cseSubjects: [] };
  emit(confirmedEmpty); copy = flatten(container).map(node => node.textContent).join('|');
  assert.doesNotMatch(copy, /同步期间必须保留的人物状态|同步期间必须保留的摘要/, '已确认覆盖回退后必须替换旧显示');

  emit({ ...ready, chatId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', memorySnapshotStatus: 'syncing', floors: [], cseSubjects: [] });
  copy = flatten(container).map(node => node.textContent).join('|');
  assert.doesNotMatch(copy, /同步期间必须保留的人物状态|同步期间必须保留的摘要/, '切聊天时不得保留上一聊天投影');
});

test('摘要地点只按来源楼的明确关系显示父级，搜索与编辑仍使用原地点名', async () => {
  const ids = {
    estate: 'place-liuwan-estate', region: 'place-bay', kitchen: 'room-kitchen',
    bedroom: 'room-main-bedroom', otherBedroom: 'room-other-main-bedroom',
    livingRoom: 'room-liuwan-living-room', amverLivingRoom: 'room-amver-living-room', amverEstate: 'place-amver-estate',
    conflictRoom: 'room-conflict', conflictParentA: 'place-conflict-a', conflictParentB: 'place-conflict-b',
    cycleA: 'place-cycle-a', cycleB: 'place-cycle-b',
  };
  let spatialHistoryReads = 0;
  const edge = (placeEntityId, parentEntityId, sourceFloorIds) => ({
    itemId: `${placeEntityId}:${parentEntityId}:${sourceFloorIds.join(',')}`,
    placeEntityId, parentEntityId, evidenceRefs: sourceFloorIds.map(floorId => ({ floorId, quotedText: '正文明确说明地点包含关系' })),
  });
  const makeMemory = (summary, locations = [], containments = []) => {
    const memory = { recordStatus: 'active', summaryEvidenceRefs: [], chronology: [],
      locations: locations.map((location, index) => ({ itemId: `${summary}:location:${index}`, ...location })),
      participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [],
      eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
    Object.defineProperty(memory, 'spatialFacts', { enumerable: true, get() {
      spatialHistoryReads += 1;
      return { schemaVersion: 1, containments, positions: [] };
    } });
    return memory;
  };
  const floor = (seq, locations = [], containments = []) => ({ floorId: `floor-${seq}`, assistantSeq: seq, messageIndex: seq * 2,
    sourceFloorIds: [`floor-${seq}`], sourceAssistantSeqs: [seq], status: 'ready', memoryId: `memory-${seq}`,
    summary: `summary-${seq}`, memory: makeMemory(`summary-${seq}`, locations, containments) });
  const floors = [
    floor(3, [], [edge(ids.estate, ids.region, ['floor-3'])]),
    floor(8, [{ name: '厨房', entityId: ids.kitchen }]),
    floor(9, [{ name: '厨房', entityId: ids.kitchen }], [edge(ids.kitchen, ids.estate, ['floor-9'])]),
    floor(17, [{ name: '主卧', entityId: ids.bedroom }]),
    floor(18, [{ name: '主卧', entityId: null }]),
    floor(19, [{ name: '主卧', entityId: ids.bedroom }], [edge(ids.bedroom, ids.estate, ['floor-19'])]),
    floor(20, [{ name: '主卧', entityId: ids.bedroom }]),
    floor(21, [{ name: '主卧', entityId: ids.bedroom }]),
    floor(22, [{ name: '客厅', entityId: ids.amverLivingRoom }]),
    floor(23, [{ name: '客厅', entityId: ids.amverLivingRoom }], [edge(ids.amverLivingRoom, ids.amverEstate, ['floor-23'])]),
    floor(24, [{ name: '客厅', entityId: ids.livingRoom }]),
    floor(25, [{ name: '主卧', entityId: ids.otherBedroom }]),
    floor(26, [{ name: '冲突房间', entityId: ids.conflictRoom }], [
      edge(ids.conflictRoom, ids.conflictParentA, ['floor-26']), edge(ids.conflictRoom, ids.conflictParentB, ['floor-26']),
    ]),
    floor(27, [], [edge(ids.cycleA, ids.cycleB, ['floor-27'])]),
    floor(28, [{ name: '循环房', entityId: ids.cycleA }], [edge(ids.cycleB, ids.cycleA, ['floor-28'])]),
  ];
  const state = { status: 'ready', pluginEnabled: true, chatId: 'location-display-chat', foundationStatus: 'ready',
    stableCount: floors.length, rememberedCount: floors.length, cseReady: true, csePendingCount: 0, cseFailedCount: 0, floors,
    memoryEntities: [], memoryPlaceEntities: [
      [ids.estate, '柳湾庄园'], [ids.region, '海湾'], [ids.kitchen, '厨房'], [ids.bedroom, '主卧'], [ids.otherBedroom, '主卧'],
      [ids.livingRoom, '客厅'], [ids.amverLivingRoom, '客厅'], [ids.amverEstate, 'Amver家庄园'],
      [ids.conflictRoom, '冲突房间'], [ids.conflictParentA, '候选父级甲'], [ids.conflictParentB, '候选父级乙'],
      [ids.cycleA, '环室甲'], [ids.cycleB, '环室乙'],
    ].map(([entityId, displayName]) => ({ entityId, displayName, aliases: [] })) };
  let saved = null;
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state,
    extractFloor: async () => state, editMemory: async (...args) => { saved = args; return state; } };
  const container = new Node('main'), view = createV3FoundationView({ runtime, documentRef });
  view.setPage('memories'); view.mount(container);
  const cardFor = floorId => flatten(container).find(node => node.attributes['data-qqj-floor-id'] === floorId);
  const locationFor = floorId => {
    const card = cardFor(floorId);
    const meta = flatten(card).find(node => node.className === 'qqj-memory-meta');
    return meta.children.find(node => node.children[0]?.textContent === '地点').children[1].textContent;
  };
  assert.equal(locationFor('floor-8'), '厨房', '未来才明确的包含关系不倒灌到前楼');
  assert.equal(locationFor('floor-9'), '海湾 › 柳湾庄园 › 厨房', '关系在来源楼生效，并沿已知多级父链显示');
  assert.equal(locationFor('floor-17'), '主卧', '主卧关系出现前仍保留本楼原名');
  assert.equal(locationFor('floor-18'), '主卧', '缺少地点身份时不按同名房间绑定关系');
  assert.equal(locationFor('floor-19'), '海湾 › 柳湾庄园 › 主卧');
  assert.equal(locationFor('floor-20'), '海湾 › 柳湾庄园 › 主卧', '后续楼承接已保存的历史关系');
  assert.equal(locationFor('floor-21'), '海湾 › 柳湾庄园 › 主卧');
  assert.equal(locationFor('floor-22'), '客厅', '包含关系出现前不显示未来父级');
  assert.equal(locationFor('floor-23'), 'Amver家庄园 › 客厅');
  assert.equal(locationFor('floor-24'), '客厅', '同名但不同ID的客厅不继承另一地点关系');
  assert.equal(locationFor('floor-25'), '主卧', '同名但不同ID的主卧不继承已知关系');
  assert.equal(locationFor('floor-26'), '冲突房间', '同一来源楼出现不同父级时不自行选择');
  assert.equal(locationFor('floor-28'), '环室乙 › 循环房', '历史图出现循环时只显示不重复的有据部分');
  assert.equal(spatialHistoryReads, floors.length, '一次摘要列表构建只收集每楼空间关系一次');

  const historyReadsBeforeSearch = spatialHistoryReads;
  const search = flatten(container).find(node => node.placeholder === '搜索全部摘要');
  search.value = 'summary-20'; search.fire('input');
  assert.equal(spatialHistoryReads, historyReadsBeforeSearch, '搜索结果构建复用本次已生成的轻量地点投影');
  const result = flatten(container).find(node => node.className === 'qqj-history-search-result');
  result.click();
  assert.equal(locationFor('floor-20'), '海湾 › 柳湾庄园 › 主卧', '从搜索结果打开完整摘要仍显示地点层级');
  assert.equal(spatialHistoryReads, historyReadsBeforeSearch, '打开搜索结果不再重扫楼层关系');

  const card = cardFor('floor-20');
  flatten(card).find(node => node.textContent === '编辑').click();
  const locationInput = flatten(editorContent()).find(node => node.placeholder === '地点名称');
  assert.equal(locationInput.value, '主卧', '编辑控件仍显示存档中的原名，不写入派生父级');
  const summary = flatten(editorContent()).find(node => node.placeholder === '输入用户修订摘要');
  summary.value = '用户改过的摘要'; summary.fire('input');
  await submitEditor(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved[0], 'floor-20');
  assert.deepEqual(saved[1].locations, [{ itemId: 'summary-20:location:0', name: '主卧' }], '保存载荷仍只含原地点名与原itemId');
  view.deactivate();
});

test('摘要楼分页每页50条，搜索覆盖全部摘要并将页外命中打开到原楼', () => {
  const floors = Array.from({ length: 101 }, (_, index) => {
    const number = index + 1;
    return { floorId: `page-floor-${number}`, assistantSeq: number, messageIndex: number * 2, status: 'ready',
      memoryId: `page-memory-${number}`, summary: number === 1 ? '唯一第1楼分页搜索标记' : `摘要楼-${number}`,
      memory: { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [],
        informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] } };
  });
  const state = { status: 'ready', pluginEnabled: true, chatId: 'pagination-chat', foundationStatus: 'ready', stableCount: floors.length,
    rememberedCount: floors.length, cseReady: true, csePendingCount: 0, cseFailedCount: 0, floors };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state };
  const container = new Node('main'), view = createV3FoundationView({ runtime, documentRef });
  view.setPage('memories'); view.mount(container);
  const hasFloor = floorId => flatten(container).some(node => node.attributes['data-qqj-floor-id'] === floorId);
  assert.equal(hasFloor('page-floor-101'), true);
  assert.equal(hasFloor('page-floor-1'), false, '首屏最多显示最新50楼');
  flatten(container).find(node => node.textContent === '下一页').click();
  assert.equal(hasFloor('page-floor-1'), false, '第二页仍只显示50条');
  flatten(container).find(node => node.textContent === '下一页').click();
  assert.equal(hasFloor('page-floor-1'), true, '末页包含最早楼');
  const search = flatten(container).find(node => node.placeholder === '搜索全部摘要');
  search.value = '唯一第1楼分页搜索标记'; search.fire('input');
  const result = flatten(container).find(node => node.className === 'qqj-history-search-result');
  assert.ok(result, '搜索在当前页外找到摘要'); result.click();
  assert.equal(hasFloor('page-floor-1'), true, '搜索打开时切到命中楼所在页');
  assert.equal(flatten(container).some(node => node.textContent === '唯一第1楼分页搜索标记'), true, '命中楼正文摘要已展开');
  view.deactivate();
});

test('记忆阶段通知保留楼层节点并原位更新状态；离屏编辑草稿不冻结搜索结果，时间通知复用传入快照', async () => {
  let state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', memorySnapshotStatus: 'ready', memorySyncStatus: 'idle',
    memoryWorkBusy: false, stableCount: 2, rememberedCount: 2, unprocessedCount: 0,
    unregisteredCandidates: [{ messageIndex: 0, reason: 'consecutiveAssistant' }], consecutiveAssistantConfirmation: { candidates: [{ messageIndex: 0 }] }, floors: [
      { floorId: 'floor-a', assistantSeq: 2, messageIndex: 3, status: 'ready', memoryId: 'memory-a', summary: '可以搜索的摘要甲', memory: { chronology: {}, locations: [], participants: [] } },
      { floorId: 'floor-b', assistantSeq: 1, messageIndex: 1, status: 'ready', memoryId: 'memory-b', summary: '可以搜索的摘要乙', memory: { chronology: {}, locations: [], participants: [] } },
    ] };
  const listeners = new Set();
  let savedEdit = null;
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, extractFloor: async () => state, confirmConsecutiveAssistants: async () => state };
  runtime.editMemory = async (...args) => { savedEdit = args; return state; };
  let timeReads = 0; const timeListeners = new Set();
  const timeSnapshot = { status: 'completed', active: false, canOrganize: true, trackedItems: [], stoppedItems: [], annualItems: [], last: { status: 'empty' } };
  const timeRuntime = { getState() { timeReads += 1; return timeSnapshot; }, subscribe(listener) { timeListeners.add(listener); return () => timeListeners.delete(listener); } };
  const container = new Node('main'), view = createV3FoundationView({ runtime, timeRuntime, documentRef });
  view.setPage('memories'); view.mount(container);
  const confirmConsecutive = flatten(container).find(node => node.textContent === '确认连续 AI 并分别记录');
  assert.ok(confirmConsecutive);
  let card = flatten(container).find(node => node.tag === 'details' && node.className.includes('qqj-memory-card'));
  const beforeSyncReplaceCount = container.replaceCount;
  await view.activate();
  assert.equal(container.replaceCount, beforeSyncReplaceCount, '正式 activate 对相同快照复用现有列表');
  for (const listener of listeners) listener({ ...state, memorySnapshotStatus: 'syncing' });
  assert.equal(container.replaceCount, beforeSyncReplaceCount, '显式同步开始只更新现有页面');
  assert.equal(flatten(container).find(node => node.tag === 'details' && node.className.includes('qqj-memory-card')), card);
  for (const listener of listeners) listener(state);
  assert.equal(container.replaceCount, beforeSyncReplaceCount + 1, '同步完成时按权威快照刷新列表');
  card = flatten(container).find(node => node.tag === 'details' && node.className.includes('qqj-memory-card'));
  const initialReplaceCount = container.replaceCount;
  openDetails(card);
  flatten(card).find(node => node.textContent === '编辑').click();
  const editor = editorContent(); assert.ok(editor, '编辑器挂在宿主弹窗，不嵌入摘要列表');

  const during = { ...state, status: 'running', memoryWorkBusy: true, activeExtraction: { floorId: 'floor-a', phase: 'extracting' } };
  for (const listener of listeners) listener(during);
  const currentCard = flatten(container).find(node => node.tag === 'details' && node.className.includes('qqj-memory-card'));
  assert.equal(currentCard, card, '同一楼的阶段通知原位更新，不重建楼层节点');
  assert.equal(container.replaceCount, initialReplaceCount, '阶段通知不重建记忆页');
  assert.equal(confirmConsecutive.disabled, true, '进度复用同时更新连续 AI 确认忙态');
  assert.equal(card.className, 'qqj-memory-card status-ready');
  assert.equal(flatten(card).find(node => node.className === 'v3-memory-status').textContent, '正在提取摘要', '状态节点保留并更新为当前阶段');
  assert.equal(flatten(card).find(node => node.textContent === '编辑').disabled, true, '阶段通知原位更新楼层操作忙态');
  const otherCard = flatten(container).find(node => node.tag === 'details' && node.attributes['data-qqj-floor-id'] === 'floor-b');
  assert.equal(flatten(otherCard).some(node => node.className === 'qqj-memory-card-body'), false, '未展开楼层不构造摘要正文');
  openDetails(otherCard);
  assert.equal(flatten(otherCard).find(node => node.textContent === '编辑').disabled, true, '忙态中首次展开使用最新 foundation 状态');
  assert.equal(activeEditorDialog?.content, editor, '外置编辑草稿不受状态通知影响');

  timeReads = 0;
  for (const listener of timeListeners) listener({ ...timeSnapshot, status: 'running', active: true, phase: 'projecting' });
  assert.equal(timeReads, 0, '时间订阅直接使用传入快照，不重复 getState');

  const search = flatten(container).find(node => node.placeholder === '搜索全部摘要');
  search.value = '摘要乙'; search.fire('input');
  assert.equal(flatten(container).some(node => node === card), false, '搜索替换列表时已编辑楼离屏');
  state = { ...during, status: 'ready', memoryWorkBusy: false, activeExtraction: null, lastError: { message: '状态内容已变化' } };
  for (const listener of listeners) listener(state);
  assert.ok(container.replaceCount > initialReplaceCount, '仅离屏草稿存在时，实质状态变化会更新搜索列表');
  assert.equal(activeEditorDialog?.content, editor, '搜索/列表更新不关闭外置编辑器或丢弃草稿');
  const editedSummary = flatten(editor).find(node => node.placeholder === '输入用户修订摘要');
  editedSummary.value = '搜索后仍可保存'; editedSummary.fire('input');
  await submitEditor();
  assert.equal(savedEdit?.[0], 'floor-a'); assert.equal(savedEdit?.[1].summary, '搜索后仍可保存', '搜索替换列表后仍可保存原楼草稿');
  const currentSearch = flatten(container).find(node => node.placeholder === '搜索全部摘要');
  currentSearch.value = ''; currentSearch.fire('input');
  const visibleCard = flatten(container).find(node => node.tag === 'details' && node.className.includes('qqj-memory-card'));
  visibleCard.open = true; visibleCard.fire('toggle'); flatten(visibleCard).find(node => node.textContent === '编辑').click();
  assert.ok(editorContent()); cancelEditor(); assert.equal(activeEditorDialog, null, '搜索更新后的楼层编辑仍可取消');
  view.deactivate();
});

test('设置页以 management 初始页挂载，只渲染一次且重复 setPage 幂等', () => {
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', memorySnapshotStatus: 'ready', memorySyncStatus: 'idle', floors: [] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const container = new Node('main'), view = createV3FoundationView({ runtime, documentRef });
  view.setPage('memories');
  view.mount(container, { page: 'management' });
  assert.equal(container.replaceCount, 1, 'management 页面由首次 render 直接创建');
  assert.ok(flatten(container).some(node => node.tag === 'h2' && node.textContent === '记忆管理'));
  view.setPage('management');
  assert.equal(container.replaceCount, 1, '重复设置相同页面不重新绘制');
  view.deactivate();
});

test('摘要楼默认折叠，折叠条显示楼号/时间/真实状态，展开后显示正文与人物地点并从内联菜单编辑', async () => {
  const entityId = '11111111-1111-4111-8111-111111111111';
  const memory = { extractorVersion: 'qqj-v3-extractor-prompt-33/schema-3/semantic-compiler-14', summaryEvidenceRefs: [], chronology: [{ itemId: 'time-1', time: { sourceText: '10月4日 周二 15:30', normalized: '2026-10-04 06:00', precision: 'approximate' }, description: '开场' }], locations: [{ itemId: 'place-1', name: '钟楼' }], participants: [{ entityId, presence: 'present' }], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  let saved = null;
  const floor = { floorId: 'floor', assistantSeq: 1, messageIndex: 2, canonicalFingerprint: 'sha256:canonical', rawFingerprint: 'sha256:raw', status: 'ready', memoryId: 'memory', summary: '钟楼相见', summarySource: 'ai', memory, cse: { status: 'ready', deltaId: 'delta' } };
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, cseReady: true, csePendingCount: 0, cseFailedCount: 0, memoryEntities: [{ entityId, displayName: '裴晚生' }], floors: [floor] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state, editMemory: async (...args) => { saved = args; return state; } };
  const menuDocument = eventDocument();
  const container = new Node('main'), view = createV3FoundationView({ runtime, documentRef: menuDocument }); view.setPage('memories'); view.mount(container);
  const card = flatten(container).find(node => String(node.className).includes('qqj-memory-card'));
  assert.equal(card.tag, 'details'); assert.equal(card.open, false);
  assert.equal(flatten(card).some(node => node.className === 'qqj-memory-card-body'), false, '折叠摘要楼只创建标题，不构造正文');
  openDetails(card);
  const copy = flatten(card).map(node => node.textContent).join('|');
  assert.match(copy, /第 2 楼.*10月4日 周二 15:30.*可用.*钟楼相见.*人物.*裴晚生.*地点.*钟楼.*⋮.*编辑.*重新提取/);
  assert.doesNotMatch(copy, /2026-10-04 06:00/, '非 exact 的 normalized 不在列表中变成精确时刻');
  assert.ok(copy.indexOf('钟楼相见') < copy.indexOf('人物') && copy.indexOf('人物') < copy.indexOf('地点'));
  assert.doesNotMatch(copy, /在场|远程参与|被提及/);
  const menu = flatten(card).find(node => node.className === 'qqj-memory-menu'); assert.equal(menu.tag, 'details'); assert.equal(menu.open, false);
  menu.open = true; menuDocument.click({ target: menu, composedPath: () => [menu] }); assert.equal(menu.open, true, '菜单内部点击不提前关闭');
  menuDocument.click({ target: container, composedPath: () => [container] }); assert.equal(menu.open, false, '千结菜单点击外部后关闭');
  card.open = true; card.fire('toggle'); flatten(card).find(node => node.textContent === '编辑').click();
  const summary = flatten(editorContent()).find(node => node.placeholder === '输入用户修订摘要'); summary.value = '修订后摘要'; summary.fire('input');
  const time = flatten(editorContent()).find(node => node.placeholder === '日期、时间范围或相对时间'); time.value = '次日'; time.fire('input'); time.value = '10月4日 周二 15:30'; time.fire('input');
  await submitEditor(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved[0], 'floor'); assert.equal(saved[1].summary, '修订后摘要');
  assert.equal(saved[1].timeText, '10月4日 周二 15:30'); assert.equal(saved[1].originalTimeText, '10月4日 周二 15:30'); assert.equal(saved[1].timeChanged, false); assert.equal(saved[1].locations[0].itemId, 'place-1');
  assert.deepEqual(saved[1].participantNames, ['裴晚生']);
  assert.equal(flatten(container).find(node => String(node.className).includes('qqj-memory-card')).open, true);
  view.deactivate(); assert.equal(menuDocument.clickListenerCount(), 0, '页面停用时清理外部点击监听');
});

test('摘要楼按现有人物名只读展示关键原文，空、单条、多条均保持原文与安全文本', async () => {
  const entityId = '11111111-1111-4111-8111-111111111111';
  const unknownSpeakerId = '22222222-2222-4222-8222-222222222222';
  const makeMemory = exactAnchors => ({ summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors, openLoops: [], ambiguities: [], cseSignals: [] });
  const original = '<img src=x onerror=alert(1)>\n第二行原句';
  const floors = [
    { floorId: 'empty', assistantSeq: 1, messageIndex: 0, status: 'ready', memoryId: 'memory-empty', summary: '无关键原文', memory: makeMemory([]) },
    { floorId: 'single', assistantSeq: 2, messageIndex: 2, status: 'ready', memoryId: 'memory-single', summary: '单条原文', memory: makeMemory([{ anchorId: unknownSpeakerId, kind: 'promise', exactText: original, speakerEntityId: entityId, whyPreserve: '不可展示的内部说明' }]), memoryEntityNames: { [entityId]: '林岚' } },
    { floorId: 'multiple', assistantSeq: 3, messageIndex: 4, status: 'ready', memoryId: 'memory-multiple', summary: '多条原文', memory: makeMemory([
      { anchorId: '33333333-3333-4333-8333-333333333333', kind: 'promise', exactText: '已确认说话人原句。', speakerEntityId: entityId, whyPreserve: '另一条内部说明' },
      { anchorId: '44444444-4444-4444-8444-444444444444', kind: 'codePhrase', exactText: '缺少可确认说话人的口令。', speakerEntityId: unknownSpeakerId, whyPreserve: '仍不显示内部说明' },
    ]) },
  ];
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 3, rememberedCount: 3, cseReady: true,
    csePendingCount: 0, cseFailedCount: 0, memoryEntities: [{ entityId, displayName: '裴晚生' }], floors };
  let stateListener;
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state,
    subscribe(listener) { stateListener = listener; return () => { stateListener = null; }; } };
  const container = new Node('main'), view = createV3FoundationView({ runtime, documentRef }); view.setPage('memories'); view.mount(container);
  const cardFor = floorId => flatten(container).find(node => node.attributes['data-qqj-floor-id'] === floorId);
  const emptyCard = cardFor('empty');
  assert.equal(flatten(emptyCard).some(node => node.className === 'qqj-memory-key-quotes'), false, '没有原句时不显示标题或占位');

  const singleCard = cardFor('single');
  const singleQuotes = flatten(singleCard).find(node => node.className === 'qqj-memory-key-quotes');
  assert.equal(singleQuotes.tag, 'div', '单条原句直接展示，不增加折叠层');
  const singleText = flatten(singleQuotes).map(node => node.textContent).join('|');
  assert.ok(singleText.includes('关键原文') && singleText.includes(`林岚：`) && singleText.includes(original));
  assert.ok(flatten(singleCard).map(node => node.textContent).indexOf('人物') < flatten(singleCard).indexOf(singleQuotes));
  assert.equal(flatten(singleQuotes).some(node => ['button', 'input', 'textarea', 'select'].includes(node.tag)), false, '原文区没有编辑控件');

  const multipleCard = cardFor('multiple');
  const multipleQuotes = flatten(multipleCard).find(node => node.className === 'qqj-memory-key-quotes is-collapsible');
  assert.equal(multipleQuotes.tag, 'details'); assert.equal(multipleQuotes.open, false, '多条原文默认收起');
  assert.equal(multipleQuotes.children[0].tag, 'summary');
  assert.equal(multipleQuotes.children[0].textContent, '关键原文（2）');
  multipleQuotes.open = true;
  multipleQuotes.fire('toggle');
  stateListener({ ...state, csePendingCount: 1 });
  let rerenderedQuotes = flatten(cardFor('multiple')).find(node => node.className === 'qqj-memory-key-quotes is-collapsible');
  assert.equal(rerenderedQuotes.open, true, '同一聊天正常后台通知重绘后仍保持用户展开状态');
  rerenderedQuotes.open = false;
  rerenderedQuotes.fire('toggle');
  stateListener({ ...state, csePendingCount: 0 });
  rerenderedQuotes = flatten(cardFor('multiple')).find(node => node.className === 'qqj-memory-key-quotes is-collapsible');
  assert.equal(rerenderedQuotes.open, false, '用户收起后同一聊天后台通知不再次展开');
  rerenderedQuotes.open = true; rerenderedQuotes.fire('toggle');
  const multipleText = flatten(rerenderedQuotes).map(node => node.textContent).join('|');
  assert.ok(multipleText.includes('裴晚生：') && multipleText.includes('已确认说话人原句。'));
  assert.ok(multipleText.includes('缺少可确认说话人的口令。'));
  assert.doesNotMatch(multipleText, /不可展示的内部说明|另一条内部说明|仍不显示内部说明|33333333-3333|44444444-4444|22222222-2222/);
  assert.equal(flatten(container).some(node => node.tag === 'img'), false, '含 HTML 标签样式的原句作为文本保留，不创建元素');

  const css = await readFile(new URL('../src/ui/panel.css', import.meta.url), 'utf8');
  assert.match(css, /\.qqj-memory-key-quotes\{[^}]*font-size:9px/u, '关键原文字号与人物/地点元信息一致');
  assert.match(css, /\.qqj-memory-key-quote\{[^}]*white-space:pre-wrap;overflow-wrap:anywhere/u, '原句保留换行并允许长内容换行');
  view.deactivate();
});

test('未处理空楼保留恢复入口，长时间仅由样式省略且长摘要原文完整保留', () => {
  const longTime = `冬至后的第七个雨夜 · ${'很长的时间描述'.repeat(12)}`;
  const longSummary = `开头。${'这是一段必须完整保留的楼层摘要。'.repeat(80)}结尾。`;
  const memory = { extractorVersion: 'qqj-v3-extractor-prompt-33/schema-3/semantic-compiler-14', summaryEvidenceRefs: [], chronology: [{ time: { sourceText: longTime } }], locations: [], participants: [] };
  const floors = [
    { floorId: 'ready', messageIndex: 8, status: 'ready', memoryId: 'memory', summary: longSummary, memory, cse: { status: 'ready' } },
    { floorId: 'empty', messageIndex: 6, status: 'unprocessed', memoryId: null, summary: '', timeFallback: '时间仍待提取', memory: null },
  ];
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 2, rememberedCount: 1, unprocessedCount: 1, cseReady: false, csePendingCount: 0, cseFailedCount: 0, floors };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state };
  const container = new Node('main'), view = createV3FoundationView({ runtime, documentRef }); view.setPage('memories'); view.mount(container);
  const cards = flatten(container).filter(node => String(node.className).split(' ').includes('qqj-memory-card'));
  const readyCard = cards.find(node => flatten(node).some(child => child.textContent === '第 8 楼'));
  const emptyCard = cards.find(node => flatten(node).some(child => child.textContent === '第 6 楼'));
  assert.equal(flatten(readyCard).find(node => node.className === 'qqj-floor-time').textContent, longTime);
  assert.equal(flatten(readyCard).find(node => node.className === 'qqj-memory-main').textContent, longSummary);
  assert.match(flatten(emptyCard).map(node => node.textContent).join('|'), /未处理.*这一楼尚未生成摘要.*提取摘要/);
});

test('旧内部时间字段只在有正文时间 fallback 时改用多段显示，并同步作为编辑初值', () => {
  const oldTime = '| date=0081-10-30 | weekday=周五 | time=12:45';
  const time252 = '10月30日 周五 12:45 → 10月30日 周五 13:10；10月30日 周五 14:30 → 10月30日 周五 14:50';
  const time254 = '11月2日 周一 08:00 → 11月2日 周一 08:20；11月2日 周一 09:10 → 11月2日 周一 09:40；11月2日 周一 11:00 → 11月2日 周一 11:15；11月2日 周一 13:30 → 11月2日 周一 14:00';
  const memory = sourceText => ({ summaryEvidenceRefs: [], chronology: [{ time: { sourceText } }], locations: [], participants: [] });
  const floors = [
    { floorId: 'floor-252', messageIndex: 252, memoryId: 'memory-252', status: 'ready', summary: '两段完整、悬空尾不猜', timeFallback: time252, memory: memory(oldTime) },
    { floorId: 'floor-254', messageIndex: 254, memoryId: 'memory-254', status: 'ready', summary: '四段完整', timeFallback: time254, memory: memory('| date=0081-11-02 | time=08:00') },
    { floorId: 'floor-normal', messageIndex: 256, memoryId: 'memory-normal', status: 'ready', summary: '正常人工时间', manualTime: true, timeFallback: '', memory: memory('人工校准：次日清晨') },
  ];
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 3, rememberedCount: 3, unprocessedCount: 0, cseReady: false, csePendingCount: 0, cseFailedCount: 0, floors };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, editMemory: async () => state };
  const container = new Node('main'), view = createV3FoundationView({ runtime, documentRef }); view.setPage('memories'); view.mount(container);
  const cards = flatten(container).filter(node => String(node.className).split(' ').includes('qqj-memory-card'));
  const cardFor = floorId => cards.find(node => node.attributes['data-qqj-floor-id'] === floorId);
  assert.equal(flatten(cardFor('floor-252')).find(node => node.className === 'qqj-floor-time').textContent, time252);
  assert.equal(flatten(cardFor('floor-254')).find(node => node.className === 'qqj-floor-time').textContent, time254);
  assert.equal(flatten(cardFor('floor-normal')).find(node => node.className === 'qqj-floor-time').textContent, '人工校准：次日清晨');
  flatten(cardFor('floor-252')).find(node => node.textContent === '编辑').click();
  assert.equal(flatten(editorContent()).find(node => node.placeholder === '日期、时间范围或相对时间').value, time252);
});

test('未修改、改回原值与未动时间 fallback 直接退出编辑并保持展开，零保存调用', async () => {
  const memory = { summary: { revisionNote: '旧说明' }, summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const floor = { floorId: 'floor', messageIndex: 18, canonicalFingerprint: 'sha256:content', rawFingerprint: 'sha256:raw', memoryId: 'memory', status: 'ready', summary: '原摘要', timeFallback: '10月4日 15:30', memory, cse: { status: 'ready', deltaId: 'delta' } };
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, cseReady: true, csePendingCount: 0, cseFailedCount: 0, floors: [floor] };
  let saves = 0;
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, editMemory: async () => { saves += 1; return state; } };
  const scroller = new Node('div'), container = new Node('main'); scroller.className = 'body'; scroller.scrollTop = 30; scroller.rect = { top: 10, bottom: 410, height: 400 }; scroller.append(container);
  const view = createV3FoundationView({ runtime, documentRef }); view.setPage('memories'); view.mount(container);
  let card = flatten(container).find(node => String(node.className).includes('qqj-memory-card')); card.open = true; card.fire('toggle');
  flatten(container).find(node => node.textContent === '编辑').click();
  assert.ok(flatten(editorContent()).find(node => node.className.includes('qqj-memory-edit'))); assert.equal(flatten(editorContent()).some(node => node.className.includes('qqj-manual-save-bar')),false,'保存取消由统一弹窗页脚提供');
  const summary = flatten(editorContent()).find(node => node.placeholder === '输入用户修订摘要'); summary.value = '临时修改'; summary.fire('input'); summary.value = '原摘要'; summary.fire('input');
  assert.equal(flatten(editorContent()).find(node => node.placeholder === '日期、时间范围或相对时间').value, '10月4日 15:30');
  await submitEditor(); await new Promise(resolve => setImmediate(resolve));
  card = flatten(container).find(node => String(node.className).includes('qqj-memory-card'));
  assert.equal(saves, 0); assert.equal(card.open, true); assert.equal(flatten(container).some(node => node.placeholder === '输入用户修订摘要'), false);
  assert.equal(scroller.scrollTop, 30, '打开独立弹窗不滚动摘要阅读页');
  assert.match(flatten(container).map(node => node.textContent).join('|'), /原摘要/, '不变提交保持原阅读内容且不写入新版本');
});

test('保存等待中用户主动收起时，完成后退出编辑但不重新展开', async () => {
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const floor = { floorId: 'floor', messageIndex: 18, canonicalFingerprint: 'sha256:content', rawFingerprint: 'sha256:raw', memoryId: 'memory', status: 'ready', summary: '原摘要', memory, cse: { status: 'ready', deltaId: 'delta' } };
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, cseReady: true, csePendingCount: 0, cseFailedCount: 0, floors: [floor] };
  let resolveSave;
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, editMemory: () => new Promise(resolve => { resolveSave = resolve; }) };
  const container = new Node('main'), view = createV3FoundationView({ runtime, documentRef }); view.setPage('memories'); view.mount(container);
  let card = flatten(container).find(node => String(node.className).includes('qqj-memory-card')); card.open = true; card.fire('toggle');
  flatten(container).find(node => node.textContent === '编辑').click();
  const summary = flatten(editorContent()).find(node => node.placeholder === '输入用户修订摘要'); summary.value = '新摘要'; summary.fire('input');
  const save = submitEditor();
  card = flatten(container).find(node => String(node.className).includes('qqj-memory-card')); card.open = false; card.fire('toggle');
  resolveSave(state); await save; await new Promise(resolve => setImmediate(resolve));
  card = flatten(container).find(node => String(node.className).includes('qqj-memory-card'));
  assert.equal(card.open, false); assert.equal(flatten(container).some(node => node.placeholder === '输入用户修订摘要'), false);
});

test('CSE 历史每楼只显示实际变化，并可折叠查看该楼结束状态与部分隔离提示', () => {
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const floor = { floorId: 'floor', messageIndex: 2, memoryId: 'memory', status: 'ready', summary: '摘要', memory, cse: { status: 'ready', deltaId: 'delta', record: { fixedChangesAvailable: true, noMaterialChange: false, isolationSummary: { count: 2, codes: ['V3_CSE_REVIEW_TARGET_AMBIGUOUS'] }, subjects: [{ displayName: '裴晚生', changeSummary: ['被拒的模型自报'], changes: [
    { category: 'adaptive', action: 'refine', beforeText: '会谨慎回应', afterText: '会谨慎回应', before: { text: '会谨慎回应', towardDisplayName: '甲', visibility: 'private', reason: '旧依据', origin: 'floor' }, after: { text: '会谨慎回应', towardDisplayName: '乙', visibility: 'observable', reason: '新依据', origin: 'floor' } },
    { category: 'situational', action: 'update', beforeText: '仍在门边', afterText: '已经落座', before: { text: '仍在门边', visibility: 'observable', reason: '站在门边', origin: 'floor' }, after: { text: '已经落座', visibility: 'observable', reason: '坐到桌旁', origin: 'floor' } },
    { category: 'situational', action: 'remove', beforeText: '仍在等雨停', afterText: null, before: { text: '仍在等雨停', visibility: 'observable', reason: '雨还没停', origin: 'floor' }, after: null },
    { category: 'situational', action: 'add', beforeText: null, afterText: '刚刚握紧钥匙', before: null, after: { text: '刚刚握紧钥匙', visibility: 'private', reason: '准备开门', origin: 'floor' } },
  ] }], endStateSubjects: [{ displayName: '裴晚生', core: [{ text: '重视承诺', visibility: 'authorial', reason: '角色卡设定', origin: 'baseline', sourceFloorId: null }], adaptive: [{ text: '会谨慎回应', towardEntityId: 'entity-乙', towardDisplayName: '乙', visibility: 'observable', reason: '新依据', origin: 'floor', sourceFloorId: 'floor' }], situational: [{ text: '已经落座', visibility: 'observable', reason: '坐到桌旁', origin: 'floor', sourceFloorId: 'floor' }, { text: '刚刚握紧钥匙', visibility: 'private', reason: '准备开门', origin: 'floor', sourceFloorId: 'floor' }] }] } } };
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, cseReady: true, csePendingCount: 0, cseFailedCount: 0, cseSubjects: [], floors: [floor] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, retryStateAnalysis: async () => state };
  const container = new Node('main'), view = createV3FoundationView({ runtime, documentRef }); view.setPage('people'); view.mount(container);
  flatten(container).find(node => node.textContent === '分析记录').click();
  const rowNode = flatten(container).find(node => node.className === 'qqj-cse-history-row');
  assert.equal(rowNode.tag, 'details'); assert.equal(rowNode.open, false);
  rowNode.open = true; rowNode.fire('toggle');
  const copy = flatten(rowNode).map(node => node.textContent).join('|');
  const resultCopy = flatten(rowNode).find(node => node.className === 'qqj-cse-floor-result').children[1];
  assert.match(flatten(resultCopy).map(node => node.textContent).join('|'), /长期倾向：会谨慎回应.*当前情境：已经落座.*当前情境：刚刚握紧钥匙/);
  assert.doesNotMatch(flatten(resultCopy).map(node => node.textContent).join('|'), /重视承诺|仍在门边|仍在等雨停|甲/);
  assert.match(copy, /裴晚生.*当前情境更新：仍在门边 → 已经落座/);
  assert.match(copy, /长期倾向属性更新：会谨慎回应.*对象：甲 → 乙.*信息范围：私密 → 可观察.*依据：旧依据 → 新依据/);
  assert.match(copy, /移除当前情境：仍在等雨停/);
  assert.match(copy, /新增当前情境：刚刚握紧钥匙/);
  assert.match(copy, /变更详情 · 4 项/);
  assert.match(copy, /部分内容未通过校验，已保留有效结果（2 项校验记录）/);
  assert.match(copy, /查看本楼已保存状态.*核心特质.*重视承诺.*长期倾向.*对 乙.*会谨慎回应.*当前情境.*已经落座.*刚刚握紧钥匙/);
  assert.equal(flatten(rowNode).find(node => node.className === 'qqj-cse-floor-state').open, false);
  assert.doesNotMatch(copy, /被拒的模型自报/);
  rowNode.open = true; rowNode.fire('toggle'); view.setPage('memories'); view.setPage('people');
  assert.equal(flatten(container).find(node => node.className === 'qqj-cse-history-row').open, true);
});

test('CSE 旧记录直接展示本楼快照且不伪造成新增或重复变更抽屉', () => {
  const memory = { summaryEvidenceRefs: [] };
  const floor = { floorId: 'legacy', messageIndex: 6, memoryId: 'memory', status: 'ready', summary: '摘要', memory, cse: { status: 'ready', deltaId: 'delta', record: {
    fixedChangesAvailable: false,
    noMaterialChange: false,
    isolationSummary: { count: 2, codes: ['V3_CSE_REVIEW_TARGET_AMBIGUOUS'] },
    subjects: [],
    endStateSubjects: [{ displayName: '裴晚生', core: [{ text: '重视承诺', visibility: 'authorial', reason: '旧档快照', origin: 'baseline', sourceFloorId: null }], adaptive: [{ text: '会保护同伴', visibility: 'observable', reason: '旧档快照', origin: 'floor', sourceFloorId: 'legacy' }], situational: [{ text: '正在门外等候', visibility: 'observable', reason: '旧档快照', origin: 'floor', sourceFloorId: 'legacy' }] }],
  } } };
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, cseReady: true, csePendingCount: 0, cseFailedCount: 0, cseSubjects: [], floors: [floor] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, retryStateAnalysis: async () => state };
  const container = new Node('main'), view = createV3FoundationView({ runtime, documentRef }); view.setPage('people'); view.mount(container);
  flatten(container).find(node => node.textContent === '分析记录').click();
  const rowNode = flatten(container).find(node => node.className === 'qqj-cse-history-row');
  rowNode.open = true; rowNode.fire('toggle');
  const resultNode = flatten(rowNode).find(node => node.className === 'qqj-cse-floor-result');
  const resultCopy = flatten(resultNode).map(node => node.textContent).join('|');
  assert.equal(flatten(resultNode).find(node => node.className === 'qqj-cse-floor-result-title').textContent, '本楼已保存状态');
  assert.match(resultCopy, /裴晚生.*核心特质.*重视承诺.*长期倾向.*会保护同伴.*当前情境.*正在门外等候/);
  assert.match(resultCopy, /旧记录未保存可核对的逐项变化；以上为本楼已保存状态快照/);
  assert.match(resultCopy, /部分内容未通过校验，已保留有效结果（2 项校验记录）/);
  assert.equal(flatten(rowNode).some(node => node.className === 'qqj-cse-floor-changes'), false, '旧记录不生成空变更抽屉');
  assert.equal(flatten(rowNode).some(node => node.className === 'qqj-cse-floor-state'), false, '同一旧快照不在下方重复折叠展示');
  assert.doesNotMatch(resultCopy, /本楼新增与调整|新增核心特质|新增长期倾向|新增当前情境/);
});

test('CSE 新固定空变化仍显示无变化与可折叠本楼快照', () => {
  const memory = { summaryEvidenceRefs: [] };
  const floor = { floorId: 'fixed-empty', messageIndex: 8, memoryId: 'memory', status: 'ready', summary: '摘要', memory, cse: { status: 'noChange', deltaId: 'delta', record: {
    fixedChangesAvailable: true,
    noMaterialChange: true,
    isolationSummary: null,
    subjects: [],
    endStateSubjects: [{ displayName: '裴晚生', core: [{ text: '保持警惕', visibility: 'authorial', reason: '已保存状态', origin: 'baseline', sourceFloorId: null }], adaptive: [], situational: [] }],
  } } };
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, cseReady: true, csePendingCount: 0, cseFailedCount: 0, cseSubjects: [], floors: [floor] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, retryStateAnalysis: async () => state };
  const container = new Node('main'), view = createV3FoundationView({ runtime, documentRef }); view.setPage('people'); view.mount(container);
  flatten(container).find(node => node.textContent === '分析记录').click();
  const rowNode = flatten(container).find(node => node.className === 'qqj-cse-history-row'); rowNode.open = true; rowNode.fire('toggle');
  const copy = flatten(rowNode).map(node => node.textContent).join('|');
  assert.match(copy, /本楼新增与调整.*本楼没有新增或调整的人物状态.*变更详情 · 0 项.*本楼无实质人物状态变化/);
  assert.match(copy, /查看本楼已保存状态.*裴晚生.*核心特质.*保持警惕/);
  assert.ok(flatten(rowNode).find(node => node.className === 'qqj-cse-floor-changes'));
  assert.ok(flatten(rowNode).find(node => node.className === 'qqj-cse-floor-state'));
  assert.doesNotMatch(copy, /旧记录未保存|旧记录没有固定/);
});

test('摘要搜索遍历全部已存楼，清空恢复列表且切聊天不保留查询', () => {
  const memory = { summaryEvidenceRefs: [] }, listeners = new Set();
  const floor = (floorId, messageIndex, summary) => ({ floorId, assistantSeq: messageIndex, messageIndex, memoryId: `memory-${floorId}`, status: 'ready', summary, memory, cse: { status: 'pending', deltaId: null } });
  let state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 3, rememberedCount: 3, csePendingCount: 3, cseFailedCount: 0, floors: [floor('old', 2, `${'很早的内容'.repeat(25)}远古线索在末尾`), floor('middle', 40, '中间摘要'), floor('new', 88, '最新摘要')] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  const container = new Node('main'), view = createV3FoundationView({ runtime, documentRef }); view.setPage('memories'); view.mount(container);
  const search = flatten(container).find(node => node.attributes['aria-label'] === '搜索当前聊天的全部摘要');
  assert.ok(search, '没有时间 runtime 也必须显示摘要搜索');
  search.value = '远古线索'; search.fire('input');
  let results = flatten(container).filter(node => node.className === 'qqj-history-search-result');
  assert.equal(results.length, 1); assert.match(flatten(results[0]).map(node => node.textContent).join('|'), /第 2 楼.*….*远古线索/u);
  assert.equal(flatten(container).filter(node => String(node.className).split(' ').includes('qqj-memory-card')).length, 0, '搜索时用结果列表替换常规列表');
  results[0].click();
  const opened = flatten(container).find(node => node.attributes['data-qqj-floor-id'] === 'old');
  assert.equal(search.value, ''); assert.equal(opened.open, true, '点击结果回到并展开原摘要卡片');
  assert.match(flatten(opened).map(node => node.textContent).join('|'), /远古线索.*编辑.*重新提取/u, '原卡片保留完整摘要与操作');
  search.value = '不存在的文字'; search.fire('input');
  assert.match(flatten(container).map(node => node.textContent).join('|'), /找到 0 条结果.*没有包含该文字的摘要/u);
  flatten(container).find(node => node.textContent === '清空').click();
  assert.equal(flatten(container).filter(node => String(node.className).split(' ').includes('qqj-memory-card')).length, 3);
  const currentSearch = flatten(container).find(node => node.attributes['aria-label'] === '搜索当前聊天的全部摘要'); currentSearch.value = '最新'; currentSearch.fire('input');
  state = { ...state, chatId: 'new-chat', stableCount: 1, rememberedCount: 1, floors: [floor('other', 4, '新聊天摘要')] }; for (const listener of listeners) listener(state);
  const switchedSearch = flatten(container).find(node => node.attributes['aria-label'] === '搜索当前聊天的全部摘要');
  assert.equal(switchedSearch.value, ''); assert.match(flatten(container).map(node => node.textContent).join('|'), /新聊天摘要/u); view.deactivate();
});

test('CSE 搜索覆盖不同人物的变更前旧值与历史快照', () => {
  const memory = { summaryEvidenceRefs: [] };
  const oldFloor = { floorId: 'old', assistantSeq: 2, messageIndex: 2, memoryId: 'memory-old', status: 'ready', summary: '摘要', memory, cse: { status: 'ready', deltaId: 'delta-old', record: { fixedChangesAvailable: true, subjects: [{ displayName: '甲', changes: [{ category: 'adaptive', action: 'update', beforeText: '旧雨夜约定', afterText: '改为白天见面' }] }], endStateSubjects: [] } } };
  const newFloor = { floorId: 'new', assistantSeq: 80, messageIndex: 80, memoryId: 'memory-new', status: 'ready', summary: '摘要', memory, cse: { status: 'ready', deltaId: 'delta-new', record: { fixedChangesAvailable: false, subjects: [], endStateSubjects: [{ displayName: '乙', core: [], adaptive: [], situational: [{ text: '保留在旧记录快照里的银色钥匙', visibility: 'private', reason: '旧档快照', origin: 'floor' }] }] } } };
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 2, rememberedCount: 2, cseReady: true, csePendingCount: 0, cseFailedCount: 0, cseSubjects: [], floors: [oldFloor, newFloor] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const container = new Node('main'), view = createV3FoundationView({ runtime, documentRef }); view.setPage('people'); view.mount(container); flatten(container).find(node => node.textContent === '分析记录').click();
  const search = flatten(container).find(node => node.attributes['aria-label'] === '搜索当前聊天的全部人物状态历史');
  const heading = search.parentNode.parentNode; assert.equal(heading.children.at(-1).textContent, '返回当前状态', '搜索位于返回按钮左侧');
  search.value = '旧雨夜约定'; search.fire('input');
  let result = flatten(container).find(node => node.className === 'qqj-history-search-result');
  assert.match(flatten(result).map(node => node.textContent).join('|'), /甲.*第 2 楼.*长期倾向.*旧雨夜约定/u);
  result.click();
  let row = flatten(container).find(node => node.className === 'qqj-cse-history-row' && flatten(node).some(child => child.textContent === '第 2 楼'));
  assert.equal(search.value, ''); assert.equal(row.open, true, '点击结果回到并展开原分析楼');
  assert.ok(flatten(row).filter(node => node.tag === 'details').every(node => node.open), '完整变更与状态详情一并展开');
  assert.match(flatten(row).map(node => node.textContent).join('|'), /旧雨夜约定.*改为白天见面.*查看本楼已保存状态/u);
  search.value = '银色钥匙'; search.fire('input');
  result = flatten(container).find(node => node.className === 'qqj-history-search-result');
  assert.match(flatten(result).map(node => node.textContent).join('|'), /乙.*第 80 楼.*当前情境.*银色钥匙.*旧档快照/u);
  flatten(container).find(node => node.textContent === '清空').click();
  assert.equal(flatten(container).filter(node => node.className === 'qqj-cse-history-row').length, 2, '清空后恢复逐楼历史'); view.deactivate();
});

function searchCseRecordInDom(record, query) {
  const identitySnapshot = () => {
    const subjects = [], targets = [];
    const addValue = value => { if (value?.towardEntityId) targets.push(value.towardEntityId); };
    for (const subject of record.subjects ?? []) {
      subjects.push(subject.subjectEntityId ?? null);
      for (const change of subject.changes ?? []) { addValue(change.before); addValue(change.after); }
    }
    for (const subject of record.endStateSubjects ?? []) {
      subjects.push(subject.subjectEntityId ?? null);
      for (const category of ['core', 'adaptive', 'situational']) for (const value of subject[category] ?? []) addValue(value);
    }
    return { subjects, targets };
  };
  const identitiesBefore = identitySnapshot();
  const people = [...new Map(record.subjects.map(subject => [subject.subjectEntityId, subject])).values()].map(subject => ({
    entityId: subject.subjectEntityId, displayName: subject.displayName, aliases: [], appearanceCount: 1,
  }));
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1,
    unprocessedCount: 0, cseReady: true, csePendingCount: 0, cseFailedCount: 0,
    cseSubjects: people.map(person => ({ subjectEntityId: person.entityId, displayName: person.displayName, core: [], adaptive: [], situational: [] })),
    floors: [{ floorId: 'search-identity-floor', assistantSeq: 1, messageIndex: 1, status: 'ready', memoryId: 'search-identity-memory', summary: '摘要',
      memory: { summaryEvidenceRefs: [] }, cse: { status: 'ready', deltaId: 'search-identity-delta', record } }],
  };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const container = new Node('main'), view = createV3FoundationView({ runtime, peopleRuntime: peopleRuntime(people), documentRef });
  view.setPage('people'); view.mount(container);
  flatten(container).find(node => node.textContent === '分析记录').click();
  const search = flatten(container).find(node => node.attributes['aria-label'] === '搜索当前聊天的全部人物状态历史');
  assert.ok(search, '双丝网分析记录页应提供历史搜索'); search.value = query; search.fire('input');
  const results = flatten(container).filter(node => node.className === 'qqj-history-search-result');
  const visibleText = results.map(result => flatten(result).map(node => node.textContent).join(' ')).join(' ');
  for (const id of [...identitiesBefore.subjects, ...identitiesBefore.targets].filter(Boolean)) {
    assert.ok(!visibleText.includes(id), `搜索结果不得显示内部 ID：${id}`);
  }
  assert.deepEqual(identitySnapshot(), identitiesBefore, '展示搜索结果不得改写主体或关系对象 ID');
  view.deactivate();
  return results;
}

test('CSE 搜索保留同名同文但主体 ID 不同的两条记录', () => {
  const value = { text: '仍保持同一份安排', visibility: 'observable', reason: '同一段已保存依据', origin: 'floor', towardEntityId: null, towardDisplayName: null, sourceFloorId: 'search-identity-floor', sourceAssistantSeq: 1 };
  const record = { fixedChangesAvailable: true, subjects: [
    { subjectEntityId: 'person-A', displayName: '林岚', changes: [{ category: 'situational', action: 'add', before: null, after: value }] },
    { subjectEntityId: 'person-B', displayName: '林岚', changes: [{ category: 'situational', action: 'add', before: null, after: { ...value } }] },
  ], endStateSubjects: [
    { subjectEntityId: 'person-A', displayName: '林岚', core: [], adaptive: [], situational: [{ ...value }] },
    { subjectEntityId: 'person-B', displayName: '林岚', core: [], adaptive: [], situational: [{ ...value }] },
  ] };
  const results = searchCseRecordInDom(record, value.text);
  assert.equal(results.length, 2, '两个不同人物 ID 的同名同文记录都应保留');
});

test('CSE 搜索保留同一人物面向不同同名对象 ID 的同文记录', () => {
  const value = targetEntityId => ({ text: '仍保持同一份安排', visibility: 'observable', reason: '同一段已保存依据', origin: 'floor', towardEntityId: targetEntityId, towardDisplayName: '许明', sourceFloorId: 'search-identity-floor', sourceAssistantSeq: 1 });
  const record = { fixedChangesAvailable: true, subjects: [{ subjectEntityId: 'person-C', displayName: '周宁', changes: [
    { category: 'adaptive', action: 'add', before: null, after: value('target-A') },
    { category: 'adaptive', action: 'add', before: null, after: value('target-B') },
  ] }], endStateSubjects: [{ subjectEntityId: 'person-C', displayName: '周宁', core: [], adaptive: [value('target-A'), value('target-B')], situational: [] }] };
  const results = searchCseRecordInDom(record, '仍保持同一份安排');
  assert.equal(results.length, 2, '不同关系对象 ID 的同名同文记录都应保留');
});

test('CSE 搜索仍合并同一主体和对象的重复 before/after 文案', () => {
  const value = { text: '仍保持同一份安排', visibility: 'observable', reason: '同一段已保存依据', origin: 'floor', towardEntityId: 'target-same', towardDisplayName: '许明', sourceFloorId: 'search-identity-floor', sourceAssistantSeq: 1 };
  const record = { fixedChangesAvailable: true, subjects: [{ subjectEntityId: 'person-D', displayName: '吴安', changes: [
    { category: 'adaptive', action: 'update', before: value, after: { ...value } },
  ] }], endStateSubjects: [{ subjectEntityId: 'person-D', displayName: '吴安', core: [], adaptive: [{ ...value }], situational: [] }] };
  const results = searchCseRecordInDom(record, value.text);
  assert.equal(results.length, 1, '同一主体和关系对象的相同 before/after 仍只显示一条');
});

test('CSE 历史折叠时延迟构建、相同记录通知复用 DOM，搜索仍可展开完整旧楼', async () => {
  const memory = { summaryEvidenceRefs: [] }, listeners = new Set(), peopleListeners = new Set();
  let peopleState = { status: 'ready' };
  const record = Object.freeze({ fixedChangesAvailable: true, subjects: Object.freeze([{ displayName: '甲', changes: Object.freeze([
    Object.freeze({ category: 'adaptive', action: 'update', beforeText: '旧约定文本', afterText: '当前约定文本' }),
  ]) }]), endStateSubjects: Object.freeze([{ displayName: '甲', core: Object.freeze([]), adaptive: Object.freeze([]), situational: Object.freeze([{ text: '历史状态快照文本', reason: '旧楼事实', visibility: 'observable', origin: 'floor' }]) }]) });
  const floors = Array.from({ length: 300 }, (_, index) => ({ floorId: `floor-${index}`, assistantSeq: index + 1, messageIndex: index + 1,
    memoryId: `memory-${index}`, status: 'ready', summary: '摘要', memory,
    cse: { status: 'ready', deltaId: `delta-${index}`, record } }));
  let state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', memoryWorkBusy: false,
    stableCount: floors.length, rememberedCount: floors.length, cseReady: true, csePendingCount: 0, cseFailedCount: 0, floors };
  let created = 0;
  const countedDocument = { activeElement: null, createElement(tag) { created += 1; return new Node(tag); } };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, retryStateAnalysis: async () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  const peopleRuntime = { getState: () => peopleState, subscribe(listener) { peopleListeners.add(listener); return () => peopleListeners.delete(listener); } };
  const container = new Node('main'), view = createV3FoundationView({ runtime, peopleRuntime, documentRef: countedDocument });
  view.setPage('people'); view.mount(container); await view.activate();
  flatten(container).find(node => node.textContent === '分析记录').click();
  const builtCollapsed = created;
  let rows = flatten(container).filter(node => node.className === 'qqj-cse-history-row');
  assert.equal(rows.length, 300);
  assert.equal(rows[0].children.length, 1, '折叠楼只创建摘要，不预建记录正文');
  assert.ok(builtCollapsed < 300 * 12, `折叠历史只创建行和摘要所需节点，实际 ${builtCollapsed}`);
  const firstRow = rows[0]; firstRow.open = true; firstRow.fire('toggle');
  assert.equal(firstRow.children.length, 2);
  assert.match(flatten(firstRow).map(node => node.textContent).join('|'), /当前约定文本/);
  const existingBody = firstRow.children[1];
  assert.ok(created > builtCollapsed, '展开楼后才创建正文');

  const search = flatten(container).find(node => node.attributes['aria-label'] === '搜索当前聊天的全部人物状态历史');
  search.value = '旧约定文本'; search.fire('input');
  const result = flatten(container).find(node => node.className === 'qqj-history-search-result' && node.attributes['aria-label'].includes('第 1 楼'));
  assert.ok(result, '折叠楼的变更前值仍可搜索');
  const queriedSearch = search, queriedRow = firstRow, beforeNoopNotification = created;
  state = { ...state };
  for (const listener of listeners) listener(state);
  const afterQueryNotify = flatten(container).find(node => node.attributes['aria-label'] === '搜索当前聊天的全部人物状态历史');
  assert.ok(afterQueryNotify === queriedSearch, '无变化通知保留搜索输入节点');
  assert.equal(afterQueryNotify.value, '旧约定文本');
  const notifiedResult = flatten(container).find(node => node.className === 'qqj-history-search-result' && node.attributes['aria-label'].includes('第 1 楼'));
  assert.ok(notifiedResult === result, '通知后保留完整历史搜索结果节点');
  assert.equal(created, beforeNoopNotification, '相同记录通知不创建新DOM节点');

  const beforeSameHealth = created;
  peopleState = { ...peopleState };
  for (const listener of peopleListeners) listener(peopleState);
  assert.equal(created, beforeSameHealth, '健康状态未变化时不重建状态栏');
  peopleState = { status: 'error', lastError: { message: '重要人物资料读取失败。' } };
  for (const listener of peopleListeners) listener(peopleState);
  let health = flatten(container).find(node => node.className.includes('qqj-page-health'));
  assert.match(health.textContent, /重要人物资料读取失败/);
  assert.ok(health.className.includes('error'));
  assert.ok(flatten(container).find(node => node.attributes['aria-label'] === '搜索当前聊天的全部人物状态历史') === queriedSearch, '状态栏变化保留搜索输入');
  assert.ok(flatten(container).find(node => node.className === 'qqj-history-search-result' && node.attributes['aria-label'].includes('第 1 楼')) === result, '状态栏变化不重建搜索结果');
  const errorHealth = health, beforeSameErrorCopy = created;
  peopleState = { ...peopleState, status: 'stale' };
  for (const listener of peopleListeners) listener(peopleState);
  health = flatten(container).find(node => node.className.includes('qqj-page-health'));
  assert.ok(health === errorHealth, '可见错误文案不变时复用健康节点');
  assert.equal(created, beforeSameErrorCopy, '可见错误文案不变时不创建状态栏节点');
  peopleState = { status: 'ready' };
  for (const listener of peopleListeners) listener(peopleState);
  health = flatten(container).find(node => node.className.includes('qqj-page-health'));
  assert.ok(!health.className.includes('error'), '重要人物读取恢复后清除健康栏错误态');
  assert.ok(flatten(container).find(node => node.className === 'qqj-history-search-result' && node.attributes['aria-label'].includes('第 1 楼')) === result, '健康栏恢复也不重建搜索结果');
  flatten(container).find(node => node.textContent === '清空').click();
  rows = flatten(container).filter(node => node.className === 'qqj-cse-history-row');
  assert.ok(rows.some(node => node === queriedRow && node.open), '清空查询后原展开楼与状态仍保留');
  search.value = '旧约定文本'; search.fire('input');
  const openResult = flatten(container).find(node => node.className === 'qqj-history-search-result' && node.attributes['aria-label'].includes('第 1 楼'));
  assert.ok(openResult, '搜索结果定位到真实第 1 楼');
  openResult.click();
  rows = flatten(container).filter(node => node.className === 'qqj-cse-history-row');
  const oldRow = rows.find(node => flatten(node).some(child => child.textContent === '第 1 楼'));
  assert.ok(oldRow?.open); assert.ok(flatten(oldRow).filter(node => node.tag === 'details').every(node => node.open));
  assert.match(flatten(oldRow).map(node => node.textContent).join('|'), /旧约定文本.*当前约定文本.*历史状态快照文本/);

  const rowNode = oldRow, rowBody = oldRow.children[1];
  state = { ...state, activeMemoryWork: { phase: 'analyzingCse' } };
  for (const listener of listeners) listener(state);
  const notifiedRows = flatten(container).filter(node => node.className === 'qqj-cse-history-row');
  const notifiedFirst = notifiedRows.find(node => flatten(node).some(child => child.textContent.includes('第 1 楼')));
  assert.ok(notifiedFirst === rowNode, '忙碌状态通知仍复用当前历史楼节点');
  assert.ok(notifiedFirst.children[1] === rowBody, '忙碌状态通知沿用当前楼正文容器');
  assert.equal(flatten(notifiedFirst).find(node => node.textContent === '重新分析').disabled, true, 'activeMemoryWork 忙碌状态仍禁用本楼分析按钮');

  state = { ...state, activeMemoryWork: null, floors: state.floors.map((floor, index) => index === 0 ? { ...floor, cse: { ...floor.cse, status: 'failed', error: '本楼状态分析失败。' } } : floor) };
  for (const listener of listeners) listener(state);
  const updatedFirst = flatten(container).find(node => node.className === 'qqj-cse-history-row' && flatten(node).some(child => child.textContent.includes('第 1 楼')));
  assert.match(flatten(updatedFirst).map(node => node.textContent).join('|'), /本楼状态分析失败/);
  assert.equal(flatten(updatedFirst).find(node => node.textContent === '重试分析')?.disabled, false);

  const changedRecord = Object.freeze({ ...record, subjects: Object.freeze([{ displayName: '甲', changes: Object.freeze([
    Object.freeze({ category: 'adaptive', action: 'update', beforeText: '旧约定文本', afterText: '更新后的真实记录' }),
  ]) }]) });
  state = { ...state, floors: state.floors.map((floor, index) => index === 0 ? { ...floor, cse: { ...floor.cse, status: 'ready', error: null, record: changedRecord } } : floor) };
  for (const listener of listeners) listener(state);
  const changedFirst = flatten(container).find(node => node.className === 'qqj-cse-history-row' && flatten(node).some(child => child.textContent.includes('第 1 楼')));
  assert.ok(changedFirst.children[1] === rowBody, '不可变record换引用时复用正文容器');
  assert.match(flatten(changedFirst).map(node => node.textContent).join('|'), /更新后的真实记录/);
  view.deactivate();
  container.replaceChildren(new Node('section'));
  view.mount(container);
  assert.ok(flatten(container).some(node => String(node.className).split(/\s+/u).includes('qqj-cse-history-page')), '同一 view 重新挂载后把历史页放回被替换的容器');
  const remountedFirst = flatten(container).find(node => node.className === 'qqj-cse-history-row' && flatten(node).some(child => child.textContent === '第 1 楼'));
  assert.ok(Boolean(remountedFirst?.open), '重新挂载后保留原先展开的楼');
  assert.match(flatten(remountedFirst).map(node => node.textContent).join('|'), /更新后的真实记录/, '重新挂载后显示更新过的记录正文');
  view.deactivate();
});

test('CSE 完整隔离不伪造成功，旧楼缺诊断字段不冒充零隔离', () => {
  const memory = { summaryEvidenceRefs: [] };
  const isolatedFloor = { floorId: 'isolated', messageIndex: 4, memoryId: 'memory-1', status: 'ready', summary: '摘要', memory, cse: { status: 'noChange', deltaId: 'delta-1', record: { fixedChangesAvailable: true, noMaterialChange: true, isolationSummary: { count: 1, codes: ['V3_CSE_SUBJECT_UNBOUND'] }, subjects: [], endStateSubjects: [] } } };
  const legacyFloor = { floorId: 'legacy', messageIndex: 2, memoryId: 'memory-2', status: 'ready', summary: '摘要', memory, cse: { status: 'noChange', deltaId: 'delta-2', record: { fixedChangesAvailable: true, noMaterialChange: true, isolationSummary: null, subjects: [], endStateSubjects: [] } } };
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 2, rememberedCount: 2, cseReady: true, csePendingCount: 0, cseFailedCount: 0, cseSubjects: [], floors: [legacyFloor, isolatedFloor] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, retryStateAnalysis: async () => state };
  const container = new Node('main'), view = createV3FoundationView({ runtime, documentRef }); view.setPage('people'); view.mount(container);
  flatten(container).find(node => node.textContent === '分析记录').click();
  for (const row of flatten(container).filter(node => node.className === 'qqj-cse-history-row')) { row.open = true; row.fire('toggle'); }
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /有内容未通过校验；本楼未产生人物状态变化（1 项校验记录）/);
  assert.equal((copy.match(/校验记录/g) ?? []).length, 1, '旧楼缺诊断字段应保持未知，不显示为零');
});

test('摘要编辑时后台通知不替换独立弹窗草稿；取消后阅读区显示最新内容', () => {
  const memory = { summaryEvidenceRefs: [] };
  const floor = { floorId: 'floor', assistantSeq: 1, messageIndex: 2, canonicalFingerprint: 'sha256:same', status: 'ready', memoryId: 'memory', summary: '原摘要', summarySource: 'ai', memory, cse: { status: 'ready', deltaId: 'delta' } };
  let state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, unprocessedCount: 0, cseReady: true, csePendingCount: 0, cseFailedCount: 0, floors: [floor] };
  const listeners = new Set();
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state, editSummary: async () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  const emit = next => { state = next; for (const listener of listeners) listener(next); };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef }); view.setPage('memories'); view.mount(container);
  flatten(container).find(node => node.textContent === '编辑').click();
  const input = flatten(editorContent()).find(node => node.placeholder === '输入用户修订摘要');
  input.value = '未保存草稿'; input.fire('input'); input.focus();
  const replaceCount = container.replaceCount;
  emit({ ...state, status: 'running', stableCount: 2, memoryWorkBusy: true, activeMemoryWork: { phase: 'extracting' }, rebuildCompletedCount: 1, rebuildTotalCount: 2, floors: [{ ...floor, summary: '后台新摘要' }] });
  assert.equal(container.replaceCount, replaceCount, '同楼后台通知不能替换编辑中的摘要 DOM');
  assert.equal(documentRef.activeElement, input); assert.equal(input.value, '未保存草稿');
  assert.equal(flatten(editorContent()).find(node => node.placeholder === '输入用户修订摘要').value, '未保存草稿');
  assert.match(flatten(container).map(node => node.textContent).join('|'), /正在处理摘要 · 1\/2 楼/);
  emit({ ...state, status: 'ready', memoryWorkBusy: false, activeMemoryWork: null });
  assert.equal(flatten(editorContent()).find(node => node.placeholder === '输入用户修订摘要').value, '未保存草稿');
  cancelEditor();
  assert.equal(editorContent(), null);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /后台新摘要/);
});

test('视图停用期间同聊天正文改变后，重新激活仍按永久楼身份保留编辑草稿', async () => {
  const floor = { floorId: 'floor', assistantSeq: 1, messageIndex: 2, canonicalFingerprint: 'sha256:old', status: 'ready', memoryId: 'memory', summary: '旧正文摘要', summarySource: 'ai', memory: { summaryEvidenceRefs: [] }, cse: { status: 'ready', deltaId: 'delta' } };
  let state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, unprocessedCount: 0, cseReady: true, csePendingCount: 0, cseFailedCount: 0, floors: [floor] };
  const saves = [];
  const runtime = {
    getState: () => state,
    refreshStatus: async () => state,
    confirmLatest: async () => state,
    extractFloor: async () => state,
    editSummary: async (...args) => { saves.push(args); return state; },
  };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef }); view.setPage('memories'); view.mount(container);
  flatten(container).find(node => node.textContent === '编辑').click();
  const staleInput = flatten(editorContent()).find(node => node.tag === 'textarea');
  staleInput.value = '不可错存的旧草稿'; staleInput.fire('input');
  view.deactivate();
  state = { ...state, floors: [{ ...floor, canonicalFingerprint: 'sha256:new', summary: '重 Roll 后的新摘要' }] };
  await view.activate();
  assert.equal(flatten(editorContent()).some(node => node.tag === 'textarea'), true);
  assert.equal(flatten(editorContent()).find(node => node.tag === 'textarea').value, '不可错存的旧草稿');
  assert.equal(saves.length, 0);
});

test('隐藏时间戳改变但永久楼身份相同时保留编辑草稿', async () => {
  const floor = { floorId: 'floor', assistantSeq: 1, messageIndex: 2, canonicalFingerprint: 'sha256:same', rawFingerprint: 'sha256:old', status: 'ready', memoryId: 'memory', summary: '旧时间摘要', summarySource: 'ai', memory: { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [] }, cse: { status: 'ready', deltaId: 'delta' } };
  let state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, cseReady: true, csePendingCount: 0, cseFailedCount: 0, floors: [floor] };
  const listeners = new Set(), runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state, editMemory: async () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  const container = new Node('main'), view = createV3FoundationView({ runtime, documentRef }); view.setPage('memories'); view.mount(container);
  flatten(container).find(node => node.textContent === '编辑').click(); assert.ok(flatten(editorContent()).some(node => node.tag === 'textarea'));
  state = { ...state, floors: [{ ...floor, rawFingerprint: 'sha256:new' }] };
  for (const listener of listeners) listener(state);
  assert.equal(flatten(editorContent()).some(node => node.tag === 'textarea'), true);
});

test('重要人物缺少 CSE 时显示常显空态，更多人物同行入口与选择跨切页保留', async () => {
  let state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, cseReady: false, csePendingCount: 0, cseFailedCount: 0, baselineId: 'baseline', mainCharacterEntityId: 'character', mainCharacterDisplayName: '裴晚生', cseSubjects: [], floors: [] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const sharedPeople = peopleRuntime([{ entityId: 'character', displayName: '裴晚生', entityDisplayName: '裴晚生' }, { entityId: 'npc', displayName: '旁人', entityDisplayName: '旁人' }], ['character']);
  const container = new Node('main'); const view = createV3FoundationView({ runtime, peopleRuntime: sharedPeople, documentRef }); view.setPage('people'); view.mount(container);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /裴晚生.*还没有已保存的状态分析/);
  const own = flatten(container).find(node => node.className === 'qqj-relation-note');
  assert.equal(own.tag, 'section'); assert.equal(flatten(own).some(node => node.tag === 'summary'), false, '选中人物自身状态常显且没有无用箭头');
  const switchRow = flatten(container).find(node => node.className === 'qqj-relation-switch-row');
  assert.ok(flatten(switchRow).find(node => node.textContent === '更多人物（1）'), '更多人物入口与关注人物在同一行');
  flatten(switchRow).find(node => node.textContent === '更多人物（1）').click();
  assert.equal(flatten(container).filter(node => node.className === 'qqj-profile-picker qqj-cse-more').length, 1);
  state = { ...state, cseSubjects: [
    { subjectEntityId: 'character', displayName: '裴晚生', core: [], adaptive: [], situational: [] },
    { subjectEntityId: 'npc', displayName: '旁人', core: [], adaptive: [], situational: [] },
  ] };
  view.render(state);
  flatten(container).find(node => node.textContent === '设为重要').click(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sharedPeople.getState().selectedEntityIds, ['character', 'npc']);
  flatten(container).find(node => node.textContent === '返回关系').click();
  view.setPage('memories'); view.setPage('people');
  assert.match(flatten(container).map(node => node.textContent).join('|'), /裴晚生.*旁人/);
  assert.equal(flatten(container).find(node => node.className === 'qqj-relation-note').tag, 'section');
});

test('双丝网人名横条同聊天同列表重绘保留位置，列表或聊天变化重置', async () => {
  const userId = '10000000-0000-4000-8000-000000000001';
  const aId = '20000000-0000-4000-8000-000000000002';
  const bId = '30000000-0000-4000-8000-000000000003';
  const cId = '40000000-0000-4000-8000-000000000004';
  let state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, cseReady: true, csePendingCount: 0, cseFailedCount: 0, floors: [], memoryEntities: [{ entityId: userId, displayName: '你', specialRole: 'user' }], cseSubjects: [] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const sharedPeople = peopleRuntime([{ entityId: aId, displayName: '甲' }, { entityId: bId, displayName: '乙' }, { entityId: cId, displayName: '丙' }], [aId, bId, cId]);
  const container = new Node('main'), view = createV3FoundationView({ runtime, peopleRuntime: sharedPeople, documentRef }); view.setPage('people'); view.mount(container);
  let switcher = flatten(container).find(node => node.className === 'qqj-relation-switcher');
  switcher.scrollLeft = 67;
  flatten(switcher).find(node => node.textContent === '丙').click();
  switcher = flatten(container).find(node => node.className === 'qqj-relation-switcher');
  assert.equal(switcher.scrollLeft, 67); assert.match(flatten(container).find(node => node.className === 'qqj-relation-card').textContent + flatten(container).map(node => node.textContent).join('|'), /丙/);

  switcher.scrollLeft = 79; state = { ...state, stableCount: 2 }; view.render(state);
  switcher = flatten(container).find(node => node.className === 'qqj-relation-switcher');
  assert.equal(switcher.scrollLeft, 79, '同人物列表的后台刷新应保留横向位置');
  flatten(container).find(node => node.textContent === '更多人物（0）').click();
  assert.equal(flatten(container).find(node => node.className === 'qqj-relation-switcher').scrollLeft, 79);
  flatten(container).find(node => node.textContent === '返回关系').click();
  assert.equal(flatten(container).find(node => node.className === 'qqj-relation-switcher').scrollLeft, 79);

  await sharedPeople.setSelectedEntityIds([aId, cId]); view.render(state);
  switcher = flatten(container).find(node => node.className === 'qqj-relation-switcher');
  assert.equal(switcher.scrollLeft, 0, '人物有序列表变化后不得继承旧位置');
  switcher.scrollLeft = 43; state = { ...state, chatId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }; view.render(state);
  assert.equal(flatten(container).find(node => node.className === 'qqj-relation-switcher').scrollLeft, 0, '切聊天必须重置横向位置');
});

test('双丝网精确区分双方关系、自身状态与选中 NPC 的其他关系', async () => {
  const userId = '10000000-0000-4000-8000-000000000001', aId = '20000000-0000-4000-8000-000000000002', bId = '30000000-0000-4000-8000-000000000003', cId = '40000000-0000-4000-8000-000000000004';
  const state = {
    status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, cseReady: true, csePendingCount: 0, cseFailedCount: 0, floors: [],
    currentStateId: '50000000-0000-4000-8000-000000000005', currentStateFingerprint: `sha256:${'a'.repeat(64)}`,
    memoryEntities: [{ entityId: userId, displayName: '你', specialRole: 'user' }, { entityId: aId, displayName: '左佐' }, { entityId: bId, displayName: '乙' }, { entityId: cId, displayName: '一个非常非常长的未关注人物名字' }],
    cseSubjects: [
      { subjectEntityId: userId, displayName: '你', core: [], adaptive: [{ text: '会长期信任左佐', towardEntityId: aId, towardDisplayName: '左佐' }, { text: '你对乙保持警惕', towardEntityId: bId, towardDisplayName: '乙' }, { text: '习惯独自复盘', towardEntityId: null, towardDisplayName: '不应使用的旧名字' }, { text: '另一同名人物的关系', towardEntityId: cId, towardDisplayName: '乙' }, { text: '缺名人物的关系', towardEntityId: 'missing-person' }], situational: [{ text: '此刻担心左佐', towardEntityId: aId, visibility: 'shared' }, { text: '用户自身疲惫', towardEntityId: null }] },
      { subjectEntityId: aId, displayName: '左佐', core: [{ text: '谨慎' }], adaptive: [{ text: '会保护你', towardEntityId: userId }, { text: '会偿还你的恩情', towardEntityId: userId }, { text: '对乙保持警惕', towardEntityId: bId }, { text: '习惯独自复盘', towardEntityId: null }], situational: [{ text: '正在门外等候', towardEntityId: null, visibility: 'private' }, { text: '此刻等你回应', towardEntityId: userId, visibility: 'observable' }, { text: '正在观察乙', towardEntityId: bId }] },
      { subjectEntityId: bId, displayName: '乙', core: [], adaptive: [{ text: '乙对左佐的态度不应混入', towardEntityId: aId }], situational: [] },
    ],
  };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, correctSubjectState: async () => state };
  const sharedPeople = peopleRuntime([{ entityId: aId, displayName: '左佐' }, { entityId: bId, displayName: '乙' }, { entityId: cId, displayName: '一个非常非常长的未关注人物名字' }], [aId, bId]);
  const menuDocument = eventDocument();
  const container = new Node('main'), view = createV3FoundationView({ runtime, peopleRuntime: sharedPeople, documentRef: menuDocument }); view.setPage('people'); view.mount(container);
  const userAnchorCopy = flatten(container).find(node => node.className === 'qqj-user-anchor').children.flatMap(flatten).map(node => node.textContent).join('|');
  assert.match(userAnchorCopy, /长期倾向.*对 左佐.*会长期信任左佐.*对 乙.*你对乙保持警惕.*自身状态.*习惯独自复盘.*用户自身疲惫/, '用户总览必须显示全部长期倾向并区分关系与自身状态');
  const anchorGroups = flatten(container).find(node => node.className === 'qqj-user-anchor');
  assert.deepEqual(flatten(anchorGroups).filter(node => node.className === 'qqj-current-situation-visibility').map(node => node.textContent), ['未标注'], '旧状态缺少信息范围时明确显示未标注');
  assert.equal(flatten(anchorGroups).filter(node => node.className === 'qqj-current-situation-line').length, 1, '标签仅出现在当前情境，核心特质与长期倾向保持原样');
  assert.deepEqual(flatten(anchorGroups).filter(node => node.tag === 'h6').map(node => node.textContent), ['对 左佐', '对 乙', '自身状态', '对 乙', '对 未知人物'], '按人物 ID 分组，同名不同人不混组，缺名关系不当自身状态');
  assert.doesNotMatch(userAnchorCopy, /对 未指定对象|不应使用的旧名字/);
  assert.doesNotMatch(userAnchorCopy, /此刻担心左佐/, '有对象的用户当前情境仍只显示在关系方向中');
  const pair = flatten(container).find(node => node.className === 'qqj-relation-card'), pairCopy = flatten(pair).map(node => node.textContent).join('|');
  assert.match(pairCopy, /你 → 左佐.*当前态度.*此刻担心左佐.*长期相处方式.*会长期信任左佐.*左佐 → 你.*当前态度.*此刻等你回应.*长期相处方式.*会保护你.*会偿还你的恩情/, '下方关系栏仍保留同一条有对象长期倾向');
  assert.deepEqual(flatten(pair).filter(node => node.className === 'qqj-current-situation-visibility').map(node => node.textContent), ['共享', '可观察', '私密'], '双方当前态度与人物自身当前情境都显示已保存的信息范围');
  const pairHead = flatten(pair).find(node => node.className === 'qqj-relation-head'), pairMenu = pairHead.children.at(-1);
  assert.equal(pairMenu.tag, 'details'); assert.equal(pairMenu.className, 'qqj-memory-menu qqj-relation-menu');
  assert.equal(pairMenu.children[0].tag, 'summary'); assert.equal(pairMenu.children[0].textContent, '⋮'); assert.equal(pairMenu.children[0].attributes['aria-label'], '关系操作');
  assert.deepEqual(flatten(pairMenu).filter(node => node.tag === 'button').map(node => node.textContent), ['编辑状态', '移出重要']);
  pairMenu.open = true; menuDocument.click({ target: pairMenu.children[0], composedPath: () => [pairMenu.children[0], pairMenu] }); assert.equal(pairMenu.open, true, '关系菜单内部点击不提前关闭');
  menuDocument.click({ target: container, composedPath: () => [container] }); assert.equal(pairMenu.open, false, '关系菜单点击外部后关闭');
  const own = flatten(container).find(node => node.className === 'qqj-relation-note'), ownCopy = flatten(own).map(node => node.textContent).join('|');
  assert.equal(own.tag, 'section'); assert.match(ownCopy, /谨慎.*习惯独自复盘.*正在门外等候/); assert.doesNotMatch(ownCopy, /会保护你|会偿还你的恩情|对乙保持警惕|此刻等你回应|正在观察乙/);
  const others = flatten(container).find(node => node.className === 'qqj-other-relations'), otherCopy = flatten(others).map(node => node.textContent).join('|');
  assert.match(otherCopy, /左佐与其他人物.*左佐 → 乙.*当前态度.*正在观察乙.*长期相处方式.*对乙保持警惕/); assert.doesNotMatch(otherCopy, /你对乙|乙对左佐/);
  assert.deepEqual(flatten(others).filter(node => node.className === 'qqj-current-situation-visibility').map(node => node.textContent), ['未标注'], '其他当前关系缺少范围时也不推测为私密');
  assert.equal(pair.children.at(-1), own, '自身状态融入关系卡内部底部');
  assert.equal(flatten(own).some(node => node.className === 'v3-memory-status'), false, '页脚不再重复状态胶囊');
  flatten(pairMenu).find(node => node.textContent === '编辑状态').click();
  assert.equal(flatten(container).some(node => node.className === 'qqj-cse-edit'), false, '编辑表单不嵌入阅读页');
  assert.ok(flatten(editorContent()).some(node => node.className.split(' ').includes('qqj-cse-edit')), '编辑表单位于独立弹窗');
  cancelEditor();
  const switchRow = flatten(container).find(node => node.className === 'qqj-relation-switch-row'); flatten(switchRow).find(node => node.textContent === '更多人物（1）').click();
  assert.match(flatten(container).find(node => node.className === 'qqj-profile-picker qqj-cse-more').textContent + flatten(container).map(node => node.textContent).join('|'), /一个非常非常长的未关注人物名字/);
  view.deactivate(); assert.equal(menuDocument.clickListenerCount(), 0);
});

test('双丝网空关系方向只读显示各自最后历史记录与宿主楼号，不进入当前编辑保存', async () => {
  const userId = '10000000-0000-4000-8000-000000000001', personId = '20000000-0000-4000-8000-000000000002';
  const historicalItem = (text, towardEntityId) => ({ text, towardEntityId, visibility: 'observable', reason: '历史已存', origin: 'floor' });
  const floor = (floorId, messageIndex, endStateSubjects) => ({
    floorId, assistantSeq: messageIndex, messageIndex, memoryId: `memory-${floorId}`, cse: { status: 'ready', record: { endStateSubjects } },
  });
  const historyFloors = [
    floor('old', 5, [
      { subjectEntityId: userId, displayName: '你', core: [], adaptive: [], situational: [historicalItem('较早的你方关系', personId)] },
      { subjectEntityId: personId, displayName: '甲', core: [], adaptive: [], situational: [historicalItem('甲方最后关系', userId)] },
    ]),
    floor('newer', 8, [
      { subjectEntityId: userId, displayName: '你', core: [], adaptive: [], situational: [historicalItem('你方最后关系', personId)] },
      { subjectEntityId: personId, displayName: '甲', core: [], adaptive: [], situational: [{ text: '甲当时很疲惫', towardEntityId: null }] },
    ]),
    floor('latest', 11, [
      { subjectEntityId: userId, displayName: '你', core: [], adaptive: [], situational: [{ text: '你正在休息', towardEntityId: null }] },
      { subjectEntityId: personId, displayName: '甲', core: [], adaptive: [], situational: [{ text: '甲正在休息', towardEntityId: null }] },
    ]),
  ];
  let savedPayload = null;
  let state = {
    status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 3, rememberedCount: 3,
    cseReady: true, csePendingCount: 0, cseFailedCount: 0, currentStateId: 'state-current', currentStateFingerprint: `sha256:${'a'.repeat(64)}`,
    memoryEntities: [{ entityId: userId, displayName: '你', specialRole: 'user' }, { entityId: personId, displayName: '甲' }],
    cseSubjects: [
      { subjectEntityId: userId, displayName: '你', core: [], adaptive: [], situational: [{ id: 'user-own', text: '你正在休息', towardEntityId: null }] },
      { subjectEntityId: personId, displayName: '甲', core: [], adaptive: [], situational: [{ id: 'person-own', text: '甲正在休息', towardEntityId: null }] },
    ],
    floors: historyFloors,
  };
  const runtime = {
    getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state,
    correctSubjectState: async (_subjectEntityId, payload) => { savedPayload = payload; return state; },
  };
  const selectedPeople = peopleRuntime([{ entityId: personId, displayName: '甲' }], [personId]);
  const container = new Node('main'), view = createV3FoundationView({ runtime, peopleRuntime: selectedPeople, documentRef }); view.setPage('people'); view.mount(container);
  let lanes = flatten(container).filter(node => /^qqj-relation-lane(?: |$)/.test(node.className));
  const fromUser = flatten(lanes[0]).map(node => node.textContent).join('|'), towardUser = flatten(lanes[1]).map(node => node.textContent).join('|');
  assert.match(fromUser, /最后关系记录 · 第 8 楼.*当时态度.*你方最后关系/);
  assert.doesNotMatch(fromUser, /较早的你方关系|当前态度/);
  assert.match(towardUser, /最后关系记录 · 第 5 楼.*当时态度.*甲方最后关系/);
  assert.equal(flatten(lanes[0]).concat(flatten(lanes[1])).filter(node => node.className === 'qqj-current-situation-visibility').length, 0, '只读历史关系不额外标注当前信息范围');

  flatten(container).find(node => node.textContent === '编辑状态').click();
  const editor = editorContent();
  assert.equal(flatten(container).some(node => node.className.split(' ').includes('qqj-cse-edit')), false);
  assert.doesNotMatch(flatten(editor).map(node => node.value || node.textContent).join('|'), /你方最后关系|甲方最后关系/);
  await submitEditor();
  assert.doesNotMatch(JSON.stringify(savedPayload), /你方最后关系|甲方最后关系/);

  state = { ...state, cseSubjects: [
    { ...state.cseSubjects[0], situational: [historicalItem('当前你方关系', personId)] },
    { ...state.cseSubjects[1], adaptive: [historicalItem('当前甲方关系', userId)] },
  ] };
  view.render(state); lanes = flatten(container).filter(node => /^qqj-relation-lane(?: |$)/.test(node.className));
  const currentCopy = lanes.map(lane => flatten(lane).map(node => node.textContent).join('|')).join('||');
  assert.match(currentCopy, /当前态度.*当前你方关系.*长期相处方式.*当前甲方关系/);
  assert.doesNotMatch(currentCopy, /最后关系记录|你方最后关系|甲方最后关系|当时态度/);

  state = { ...state, cseSubjects: state.cseSubjects.map(subject => ({ ...subject, adaptive: [], situational: [] })), floors: [] };
  view.render(state); lanes = flatten(container).filter(node => /^qqj-relation-lane(?: |$)/.test(node.className));
  assert.equal(lanes.filter(lane => /暂无已保存的关系状态/.test(lane.textContent + flatten(lane).map(node => node.textContent).join('|'))).length, 2);
});

test('双丝网按实体 ID 展示已有 user 状态，且空状态关系卡仍可从菜单移出重要', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const characterId = '22222222-2222-4222-8222-222222222222';
  let state = {
    status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1,
    cseReady: true, csePendingCount: 0, cseFailedCount: 0, floors: [],
    memoryEntities: [{ entityId: userId, displayName: '林岚', specialRole: 'user' }, { entityId: characterId, displayName: '裴晚生', specialRole: 'char' }],
    cseSubjects: [{ subjectEntityId: userId, displayName: '林岚', core: [{ text: '冷静', reason: '已有状态', visibility: 'authorial' }], adaptive: [], situational: [] }],
  };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const sharedPeople = peopleRuntime([{ entityId: characterId, displayName: '裴晚生', entityDisplayName: '裴晚生' }], []);
  const container = new Node('main'); const view = createV3FoundationView({ runtime, peopleRuntime: sharedPeople, documentRef }); view.setPage('people'); view.mount(container);
  let copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /林岚.*冷静.*尚未选择重要人物.*更多人物（1）/);
  const anchor = flatten(container).find(node => node.className === 'qqj-user-anchor');
  assert.equal(flatten(anchor).some(node => ['设为重要', '移出重要'].includes(node.textContent)), false, 'user 状态不提供千人选择操作');
  assert.equal(flatten(anchor).some(node => /核对我的核心特质/.test(node.textContent)), false, '人物页不再显示手动核心特质核对流程');
  assert.equal(flatten(anchor).some(node => node.tag === 'button' && node.textContent === '编辑我的状态'), true, '人工状态编辑入口仍保留');

  state = { ...state, cseSubjects: [] }; view.render(state); copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /尚未选择重要人物/); assert.doesNotMatch(copy, /林岚.*人物状态/);
  sharedPeople.setSelectedEntityIds([characterId]);
  state = { ...state, cseSubjects: [{ subjectEntityId: userId, displayName: '林岚', core: [], adaptive: [], situational: [] }] };
  view.render(state); copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /林岚.*裴晚生/); assert.doesNotMatch(copy, /尚未选择重要人物|暂无人物状态/);
  const menu = flatten(container).find(node => node.className === 'qqj-memory-menu qqj-relation-menu');
  assert.deepEqual(flatten(menu).filter(node => node.tag === 'button').map(node => node.textContent), ['移出重要']);
  flatten(menu).find(node => node.textContent === '移出重要').click(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sharedPeople.getState().selectedEntityIds, []); assert.match(flatten(container).map(node => node.textContent).join('|'), /尚未选择重要人物/);
});

test('人物状态编辑保存期间冻结全部草稿控件并复制输入，成功留在抽屉、失败保留草稿', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const targetId = '55555555-5555-4555-8555-555555555555';
  let state = {
    status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1,
    memoryWorkBusy: false, activeMemoryWork: null, activeCse: null, cseReady: true, csePendingCount: 0, cseFailedCount: 0, floors: [],
    currentStateId: '22222222-2222-4222-8222-222222222222', currentStateFingerprint: `sha256:${'a'.repeat(64)}`,
    cseTowardCandidates: [{ entityId: userId, displayName: '林岚' }, { entityId: targetId, displayName: '左佐' }],
    memoryEntities: [{ entityId: userId, displayName: '林岚', specialRole: 'user' }, { entityId: targetId, displayName: '左佐' }],
    cseSubjects: [{ subjectEntityId: userId, displayName: '林岚', core: [], adaptive: [
      { id: '66666666-6666-4666-8666-666666666666', text: '会独自复盘', reason: '正文', visibility: 'private', towardEntityId: null },
      { id: '77777777-7777-4777-8777-777777777777', text: '仍对左佐谨慎', reason: '正文', visibility: 'private', towardEntityId: targetId },
    ], situational: [{ id: '33333333-3333-4333-8333-333333333333', text: '紧张', reason: '正文', visibility: 'private', towardEntityId: null }] }],
  };
  let pending = null;
  const calls = [];
  const runtime = {
    getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state,
    correctSubjectState: (subjectEntityId, payload) => {
      calls.push({ subjectEntityId, payload });
      return new Promise((resolve, reject) => { pending = { resolve, reject }; });
    },
  };
  const scroller = new Node('div'), container = new Node('main'); scroller.className = 'body'; scroller.scrollTop = 30; scroller.rect = { top: 10, bottom: 410, height: 400 }; scroller.append(container);
  const selectedPeople = peopleRuntime([{ entityId: targetId, displayName: '左佐' }], [targetId]);
  const view = createV3FoundationView({ runtime, peopleRuntime: selectedPeople, documentRef }); view.setPage('people'); view.mount(container);
  flatten(container).find(node => node.textContent === '编辑我的状态').click();
  let editor = flatten(editorContent()).find(node => node.className.split(' ').includes('qqj-cse-edit'));
  assert.ok(editor);
  assert.equal(flatten(container).some(node => node.className.split(' ').includes('qqj-cse-edit')), false, '列表阅读区不挂载编辑表单');
  assert.equal(flatten(editor).some(node => node.tag === 'select'), false, 'CSE 信息范围与对象不得使用手机原生选择器');
  let adaptiveGroup = flatten(editor).find(node => node.tag === 'details' && node.children[0]?.textContent === '长期倾向');
  adaptiveGroup.open = true; flatten(adaptiveGroup).find(node => node.textContent === '添加长期倾向').click();
  adaptiveGroup = flatten(editorContent()).find(node => node.tag === 'details' && node.children[0]?.textContent === '长期倾向');
  assert.equal(adaptiveGroup.open, true, '新增长期倾向后分组保持展开');
  assert.equal(flatten(adaptiveGroup).filter(node => node.placeholder === '长期倾向内容').length, 3, '新建输入仍在可见分组中');
  flatten(adaptiveGroup).filter(node => node.textContent === '删除').at(-1).click();
  editor = flatten(editorContent()).find(node => node.className.split(' ').includes('qqj-cse-edit'));
  adaptiveGroup = flatten(editor).find(node => node.tag === 'details' && node.children[0]?.textContent === '长期倾向');
  assert.equal(adaptiveGroup.open, true, '删除行后分组仍保持展开');
  const ownTarget = flatten(editor).filter(node => node.attributes?.['aria-label'] === '长期倾向对象')[0];
  assert.equal(flatten(ownTarget).find(node => node.className === 'qqj-inline-select-value').textContent, '自身状态');
  ownTarget.click(); flatten(ownTarget.parentNode).find(node => node.attributes?.['data-value'] === targetId).click();
  ownTarget.click(); const ownOption = flatten(ownTarget.parentNode).find(node => node.attributes?.['data-value'] === '');
  assert.equal(ownOption.textContent, '自身状态'); ownOption.click();
  let situational = flatten(editor).find(node => node.placeholder === '当前情境内容');
  const adaptive = flatten(editor).filter(node => node.placeholder === '长期倾向内容');
  adaptive[0].value = '会定期独自复盘'; adaptive[0].fire('input');
  adaptive[1].value = '开始信任左佐'; adaptive[1].fire('input');
  situational.value = '已经平静'; situational.fire('input');
  const situationalTarget = flatten(editor).find(node => node.attributes?.['aria-label'] === '当前情境对象');
  situationalTarget.click(); flatten(situationalTarget.parentNode).find(node => node.attributes?.['data-value'] === targetId).click();
  flatten(editor).find(node => node.className.split(' ').includes('qqj-cse-help')).click();
  assert.match(flatten(editor).map(node => node.textContent).join('|'), /与上传权限无关.*私密：.*已表达：.*可观察：.*共享：.*作者设定：/s);
  assert.equal(situational.value, '已经平静', '打开信息范围帮助不得重建或清空编辑草稿');
  const save = submitEditor();
  assert.equal(calls.length, 1); assert.equal(calls[0].subjectEntityId, userId);
  assert.deepEqual(calls[0].payload.adaptive.map(item => [item.text, item.towardEntityId]), [['会定期独自复盘', null], ['开始信任左佐', targetId]]);
  assert.equal(calls[0].payload.situational[0].towardEntityId, targetId, '当前情境对象下拉须进入同一保存 payload');
  editor = flatten(editorContent()).find(node => node.className.split(' ').includes('qqj-cse-edit'));
  assert.ok(flatten(editor).filter(node => ['textarea', 'select', 'button'].includes(node.tag)).every(node => node.disabled === true), '异步保存期间全部输入、选择与增删按钮都应禁用');
  situational.value = '迟到改动'; situational.fire('input');
  assert.equal(calls[0].payload.situational[0].text, '已经平静', '本次保存使用点击时复制的草稿，不被迟到输入改写');
  state = { ...state, currentStateId: '44444444-4444-4444-8444-444444444444', currentStateFingerprint: `sha256:${'b'.repeat(64)}`, cseSubjects: [{ ...state.cseSubjects[0], adaptive: [
    { ...state.cseSubjects[0].adaptive[0], text: '会定期独自复盘', origin: 'manual', reason: '用户纠正当前状态' },
    { ...state.cseSubjects[0].adaptive[1], text: '开始信任左佐', origin: 'manual', reason: '用户纠正当前状态' },
  ], situational: [{ ...state.cseSubjects[0].situational[0], text: '已经平静', towardEntityId: targetId, origin: 'manual', reason: '用户纠正当前状态' }] }] };
  pending.resolve(state); await save;
  assert.equal(editorContent(), null); assert.equal(flatten(container).some(node => node.className.split(' ').includes('qqj-cse-edit')), false); assert.equal(scroller.scrollTop, 30);
  assert.ok(flatten(container).find(node => node.className === 'qqj-user-anchor'), '保存成功后用户状态仍常显');
  let copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /会定期独自复盘.*开始信任左佐/s); assert.doesNotMatch(copy, /会独自复盘|仍对左佐谨慎/);

  flatten(container).find(node => node.textContent === '编辑我的状态').click();
  editor = editorContent();
  assert.deepEqual(flatten(editor).filter(node => node.placeholder === '长期倾向内容').map(node => node.value), ['会定期独自复盘', '开始信任左佐']);
  situational = flatten(editor).find(node => node.placeholder === '当前情境内容');
  situational.value = '失败时保留'; situational.fire('input');
  const failedSave = submitEditor();
  pending.reject(new Error('模拟写入失败')); await failedSave;
  editor = editorContent();
  assert.equal(lastEditorDialogError?.message, '模拟写入失败', '共享弹窗保留真实保存错误');
  assert.ok(editor); assert.doesNotMatch(flatten(editor).map(node => node.textContent).join('|'), /保存失败：模拟写入失败/, '保存失败文案由共享弹窗 footer 单独呈现');
  assert.equal(scroller.scrollTop, 30, '弹窗保存失败不改变阅读页滚动位置');
  assert.equal(flatten(editor).find(node => node.placeholder === '当前情境内容').value, '失败时保留');
  assert.ok(flatten(editor).filter(node => ['textarea', 'select', 'button'].includes(node.tag)).every(node => node.disabled === false), '保存失败后同一草稿恢复可编辑');
});

test('地基刷新失败不吞掉已恢复回执，错误文案明确两条链独立', async () => {
  const state = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 0, rememberedCount: 0, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: null, activeRun: null, lastRun: null, lastError: null, unreachableCount: 0, metrics: {}, floors: [] };
  const runtime = { getState: () => state, refreshStatus: async () => { throw new Error('模拟地基失败'); }, confirmLatest: async () => state };
  const receipt = { recallStatus: 'completed-empty', lastRecall: { status: 'completed-empty', restoredReceipt: true, selectedFloorIds: [], selectedFloors: [], skipReasons: [], coverage: null, stages: null, timings: null } };
  const recallRuntime = { getState: () => receipt, restorePersistedReceipt: async () => receipt };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, recallRuntime, documentRef });
  view.mount(container);
  await view.activate();
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /记忆读取失败：模拟地基失败；历史召回回执已独立处理/);
  const visibleFeedback = flatten(container).find(node => node.className?.includes('qqj-management-feedback'));
  assert.equal(visibleFeedback.textContent, '记忆读取失败：模拟地基失败');
  assert.match(visibleFeedback.className, /error/);
  const diagnostics = flatten(container).find(node => node.className === 'qqj-management-drawer' && flatten(node).some(child => child.textContent === '详细诊断'));
  const diagnosticCopy = flatten(diagnostics).map(node => node.textContent).join('|');
  assert.match(diagnosticCopy, /历史召回回执已独立处理/);
  assert.match(diagnosticCopy, /记忆状态/);
  assert.doesNotMatch(diagnosticCopy, /后端状态|地基状态/);
  assert.match(copy, /最近一次召回结果/);
});

test('回执恢复失败只显示在召回区，不妨碍地基 ready', async () => {
  const state = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 2, rememberedCount: 0, unprocessedCount: 2, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'checkpoint', activeRun: null, lastRun: null, lastError: null, unreachableCount: 0, metrics: {}, floors: [] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const recallRuntime = { getState: () => ({ recallStatus: 'idle', lastRecall: null }), restorePersistedReceipt: async () => { throw new Error('模拟回执失败'); } };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, recallRuntime, documentRef });
  view.mount(container);
  await view.activate();
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /记忆状态已刷新/);
  assert.match(copy, /历史召回回执恢复失败：模拟回执失败；不影响记忆读取/);
  assert.match(copy, /已记忆 0\/2 楼/);
});

test('前情仅在独立弹窗内编辑，取消不改存档且保存失败保留草稿', async () => {
  let state = { status: 'uninitialized', pluginEnabled: true, chatId: null, foundationStatus: 'uninitialized', stableCount: 0, rememberedCount: 0, unprocessedCount: 0, memoryWorkBusy: false, floors: [], rebuildStatus: 'pendingRebuild' };
  const listeners = new Set();
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  let saved = { hostChatId: 'host-a', text: '旧前情' }, releaseSave, fail = false;
  const recallRuntime = {
    getState: () => ({ recallStatus: 'ready', lastRecall: { restoredReceipt: false, stages: { estimatedTokenCount: 40 } }, lastPrequel: { status: 'ready', injectionText: '【前情片段 2】\n旧经历', fragmentIndexes: [2], estimatedTokens: 20 } }),
    getPrequel: () => saved,
    savePrequel: text => new Promise((resolve, reject) => { releaseSave = () => fail ? reject(new Error('模拟保存失败')) : resolve(saved = { hostChatId: 'host-a', text }); }),
  };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, recallRuntime, memoryManagement: { getState: () => ({}), deleteCurrent: async () => ({}), fullRebuild: async () => { saved = { hostChatId: 'host-a', text: '' }; state = { ...state, chatId: CHAT, status: 'ready', foundationStatus: 'ready' }; return state; } }, confirmImpl: () => true, documentRef }); view.mount(container);
  assert.equal(flatten(container).some(node => String(node.className).includes('qqj-prequel-editor')), false, '阅读页不常驻编辑器');
  flatten(container).find(node => node.textContent === '编辑前情').click();
  let editor = flatten(editorContent()).find(node => String(node.className).includes('qqj-prequel-editor'));
  assert.equal(editor.value, '旧前情');
  assert.match(flatten(container).map(node => node.textContent).join('|'), /当前 3 字符/);
  editor.value = '正在输入的草稿'; editor.fire('input');
  for (const listener of listeners) listener({ ...state, chatId: CHAT, status: 'ready', foundationStatus: 'ready' });
  editor = flatten(editorContent()).find(node => String(node.className).includes('qqj-prequel-editor'));
  assert.equal(editor.value, '正在输入的草稿', 'QQJ 身份从 null 建立时仍按宿主聊天保留草稿');
  assert.match(flatten(container).map(node => node.textContent).join('|'), /召回材料估算 40 \+ 前情估算 20 = 合计 60 Token/);
  cancelEditor();
  assert.equal(saved.text, '旧前情', '取消不写入前情存档');
  assert.equal(flatten(container).some(node => String(node.className).includes('qqj-prequel-editor')), false);

  flatten(container).find(node => node.textContent === '编辑前情').click();
  editor = flatten(editorContent()).find(node => String(node.className).includes('qqj-prequel-editor'));
  assert.equal(editor.value, '旧前情', '重新打开读取当前已保存内容');
  editor.value = '新前情'; editor.fire('input');
  const save = submitEditor(); releaseSave(); await save;
  assert.equal(saved.text, '新前情');
  assert.ok(flatten(container).some(node => node.textContent === '前情已更新，并已交给酒馆保存。'));

  flatten(container).find(node => node.textContent === '编辑前情').click();
  editor = flatten(editorContent()).find(node => String(node.className).includes('qqj-prequel-editor'));
  editor.value = '失败时保留的草稿'; editor.fire('input');
  fail = true; const failedSave = submitEditor(); releaseSave(); await failedSave;
  editor = flatten(editorContent()).find(node => String(node.className).includes('qqj-prequel-editor'));
  assert.equal(lastEditorDialogError?.message, '模拟保存失败', '共享弹窗保留前情保存原因');
  assert.equal(editor.value, '失败时保留的草稿', '保存失败时编辑窗保留原内容');
  assert.equal(saved.text, '新前情');
});

test('公共错误展示只翻译明确错误，并保留诊断字段与健康空态', () => {
  const apiError = Object.assign(new TypeError('Failed to fetch'), { code: 'CUSTOM_NETWORK', status: 0 });
  assert.equal(publicErrorMessage(apiError, { fallback: '操作失败。' }), '网络连接失败，请检查网络或 API 地址。');
  assert.equal(apiError.code, 'CUSTOM_NETWORK');
  assert.equal(apiError.status, 0);
  assert.equal(publicErrorMessage('SyntaxError: Unexpected token \'<\', "<html>" is not valid JSON', { fallback: '操作失败。' }), '返回数据不是合法 JSON，请稍后重试。');
  assert.equal(publicErrorMessage('JSON Parse error: Unexpected identifier "oops"', { fallback: '操作失败。' }), '返回数据不是合法 JSON，请稍后重试。');
  assert.equal(publicErrorMessage('Memory load failed', { fallback: '记忆读取失败。' }), '记忆读取失败。');
  assert.equal(publicErrorMessage('已经是具体中文错误', { fallback: '操作失败。' }), '已经是具体中文错误');
  assert.equal(publicErrorMessage(null, { fallback: '操作失败。' }), '操作失败。');
  assert.equal(publicErrorMessage(null), '');

  const state = {
    status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT,
    foundationStatus: 'ready', memorySnapshotStatus: 'ready', memorySyncStatus: 'idle',
    stableCount: 0, rememberedCount: 0, unprocessedCount: 0, failedCount: 0, reviewCount: 0,
    pending: null, headCheckpointId: null, activeRun: null, lastRun: null, lastError: null,
    lastExtractorError: null, lastAutomationError: null, lastCseError: null, unreachableCount: 0,
    memoryWorkBusy: false, activeAutoMemory: null, activeExtraction: null, activeCse: null,
    rebuildStatus: 'caughtUp', cseReady: true, csePendingCount: 0, cseFailedCount: 0, floors: [], metrics: {},
  };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef });
  view.mount(container);
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.doesNotMatch(copy, /处理失败|需要处理/);
  assert.equal(flatten(container).some(node => String(node.className).includes('qqj-page-health error')), false);
});

test('管理界面把英文内部读取失败显示为对应中文', () => {
  const state = {
    status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT,
    foundationStatus: 'ready', memorySnapshotStatus: 'error', memorySyncStatus: 'error',
    stableCount: 1, rememberedCount: 0, unprocessedCount: 1, failedCount: 1, reviewCount: 0,
    pending: null, headCheckpointId: 'checkpoint', activeRun: null, lastRun: null, lastError: null,
    lastExtractorError: { code: 'V3_MEMORY_LOAD_FAILED', message: 'Memory load failed' },
    lastAutomationError: null, lastCseError: null, unreachableCount: 0, memoryWorkBusy: false,
    activeAutoMemory: null, activeExtraction: null, activeCse: null, rebuildStatus: 'failed',
    cseReady: false, csePendingCount: 0, cseFailedCount: 0, floors: [], metrics: {},
  };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const container = new Node('main');
  createV3FoundationView({ runtime, documentRef }).mount(container);
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /记忆数据读取失败，请稍后重试/);
  assert.doesNotMatch(copy, /Memory load failed|网络连接失败/);
});

test('历史流水界面同时显示摘要与CSE实际进度，时间任务不遮活跃流水或错误', () => {
  let state = {
    status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT,
    foundationStatus: 'ready', memorySnapshotStatus: 'ready', memorySyncStatus: 'idle',
    stableCount: 4, rememberedCount: 2, unprocessedCount: 2, failedCount: 0, reviewCount: 0,
    activeExtraction: { phase: 'extracting' }, activeCse: { phase: 'analyzing' },
    memoryWorkBusy: true, activeAutoMemory: { phase: 'extracting' }, rebuildStatus: 'running',
    csePendingCount: 1, cseFailedCount: 0, floors: [], metrics: {},
  };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const timeRuntime = { getState: () => ({ active: true, phase: 'projecting' }) };
  const copy = () => {
    const container = new Node('main');
    createV3FoundationView({ runtime, timeRuntime, documentRef }).mount(container);
    return flatten(container).filter(node => String(node.className).includes('qqj-page-health')).map(node => node.textContent).join('|');
  };
  assert.match(copy(), /摘要与人物状态并行 · 摘要 2\/4 楼 · 人物状态待分析 1 楼/);
  assert.doesNotMatch(copy(), /正在推算时间状态/);
  state = { ...state, activeCse: null, activeAutoMemory: { phase: 'extracting', cseBlocked: true }, lastCseError: { message: '本批人物状态失败' } };
  assert.match(copy(), /人物状态待重试/);
  state = { ...state, activeAutoMemory: { phase: 'extracting', cseBlocked: false } };
  assert.doesNotMatch(copy(), /人物状态待重试/, '上批错误不冒充本批停止');
  state = { ...state, activeExtraction: null, activeCse: null, memoryWorkBusy: false, activeAutoMemory: null, lastCseError: null, lastExtractorError: { message: '本楼摘要失败', floorId: 'failed' } };
  assert.match(copy(), /本楼摘要失败/);
  assert.doesNotMatch(copy(), /正在推算时间状态/);
});

test('时间补查真实view先计划后确认，取消零整理；摘要CSE忙不阻断，二次收起和通知仍收起',async()=>{
  const state={status:'ready',pluginEnabled:true,chatId:CHAT,foundationStatus:'ready',memorySnapshotStatus:'ready',memorySyncStatus:'idle',memoryWorkBusy:true,activeCse:{phase:'analyzing'},floors:[]};let plans=0,runs=0,confirmed=false,shown;const listeners=new Set();
  const runtime={getState:()=>state,refreshStatus:async()=>state,confirmLatest:async()=>state,subscribe:()=>()=>{}};const timeState={status:'completed',active:false,canOrganize:true,trackedItems:[],stoppedItems:[],coverage:{checkedFloors:1,totalFloors:5,startAssistantSeq:5,earlierUnchecked:4,pendingFloors:1},last:{status:'empty'}};
  const timeRuntime={getState:()=>structuredClone(timeState),subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},refreshStatus:async()=>{},prepareHistoryPlan:async()=>{plans++;return {floorCount:4,bodyBatchCount:2,batchCount:3,apiCalls:3,currentReview:true};},organize:async plan=>{runs++;assert.equal(plan.apiCalls,3);}};
  const container=new Node('main'),view=createV3FoundationView({runtime,timeRuntime,documentRef,confirmImpl:options=>{shown=options;return confirmed;}});view.setPage('memories');view.mount(container);const toggle=flatten(container).find(node=>node.className.includes('qqj-profile-more'));await toggle.click();const body=flatten(container).find(node=>node.id==='qqj-recent-items'),button=flatten(body).find(node=>node.textContent==='补查历史');assert.equal(button.disabled,false);
  assert.match(flatten(body).map(node=>node.textContent).join('|'),/正文已检查 1\/5 楼；此前 4 楼未检查；1 楼等待稳定/u);await button.click();assert.equal(plans,1);assert.equal(runs,0);assert.match(shown.body,/4 个 AI 楼.*2 批.*摘要 API 3 次.*一次当前事项评估/);confirmed=true;await button.click();assert.equal(runs,1);await toggle.click();assert.equal(body.hidden,true);for(const listener of listeners)listener(timeState);assert.equal(body.hidden,true);view.deactivate();
});

test('停止项复用批量控件永久删除，取消零写，失败后同入口续做',async()=>{
  const state={status:'ready',pluginEnabled:true,chatId:CHAT,foundationStatus:'ready',memorySnapshotStatus:'ready',memorySyncStatus:'idle',memoryWorkBusy:false,floors:[]};
  const runtime={getState:()=>state,refreshStatus:async()=>state,confirmLatest:async()=>state,subscribe:()=>()=>{}};const listeners=new Set();let confirmed=false,shown,calls=[];
  let timeState={status:'completed',active:false,canOrganize:true,pendingDeletionCount:0,trackedItems:[{id:'active',observationKey:'active-key',label:'追踪项',status:'active'}],stoppedItems:[
    {id:'done',observationKey:'done-key',label:'完成项',status:'completed',person:'甲',observation:'已完成'},
    {id:'merged',observationKey:'merged-key',label:'归并项',status:'paused',mergedInto:'main',person:'乙',observation:'已归并'},
  ],coverage:{checkedFloors:1,totalFloors:1},last:{status:'completed'}};
  const timeRuntime={getState:()=>structuredClone(timeState),subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},refreshStatus:async()=>{},
    async deleteItems(items){calls.push(structuredClone(items));if(calls.length===1)throw new Error('模拟旧记录清理失败');timeState={...timeState,pendingDeletionCount:0,stoppedItems:[],last:{status:'completed'}};for(const listener of listeners)listener(timeState);}};
  const container=new Node('main'),view=createV3FoundationView({runtime,timeRuntime,documentRef,confirmImpl:options=>{shown=options;return confirmed;}});view.setPage('memories');view.mount(container);
  await flatten(container).find(node=>node.className.includes('qqj-profile-more')).click();let body=flatten(container).find(node=>node.id==='qqj-recent-items');await flatten(body).find(node=>node.textContent==='查看停止项（2）').click();
  await flatten(body).find(node=>node.textContent==='批量管理').click();assert.equal(flatten(body).find(node=>node.textContent==='选择问题项').hidden,true);assert.ok(flatten(body).filter(node=>node.className==='qqj-recent-item-select').length===2);
  await flatten(body).find(node=>node.textContent==='选择当前列表').click();let remove=flatten(body).find(node=>node.textContent==='批量永久删除');assert.equal(remove.disabled,false);
  await remove.click();assert.equal(calls.length,0);assert.match(shown.body,/永久删除 2 项.*全部时间历史.*不可恢复.*不调用模型.*摘要与千事保留/u);
  confirmed=true;await remove.click();assert.deepEqual(calls[0],[{itemId:'done',observationKey:'done-key'},{itemId:'merged',observationKey:'merged-key'}]);assert.match(flatten(body).map(node=>node.textContent).join('|'),/永久删除未完成：模拟旧记录清理失败/u);
  for(const checkbox of flatten(body).filter(node=>node.className==='qqj-recent-item-select')) { checkbox.checked=false; await checkbox.fire('change'); }
  assert.ok(flatten(body).filter(node=>node.className==='qqj-recent-item-select').every(node=>!node.checked),'此时同一停止列表没有新选择');
  timeState={...timeState,pendingDeletionCount:2,last:{status:'partial'}};for(const listener of listeners)listener(timeState);
  remove=flatten(body).find(node=>node.textContent==='继续永久删除');assert.equal(remove.disabled,false);
  assert.ok(flatten(body).filter(node=>node.className==='qqj-recent-item-select').every(node=>node.disabled&&!node.checked),'续清期间不能把新勾选混进旧删除');
  assert.equal(flatten(body).find(node=>node.textContent==='选择当前列表').disabled,true);
  await remove.click();assert.deepEqual(calls[1],[]);assert.equal(flatten(body).some(node=>node.textContent==='继续永久删除'),false);view.deactivate();
});

test('准备子阶段在回执及复制诊断中按attempt展示，不复制来源材料', async () => {
  const foundation = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 0, rememberedCount: 0, unprocessedCount: 0, memorySyncStatus: 'idle', floors: [] };
  const runtime = { getState: () => foundation, refreshStatus: async () => foundation, confirmLatest: async () => foundation };
  const preparation = { phase: 'commit', mode: 'fresh', stage: 'prepare', status: 'timeout', totalMs: 5100, budgetMs: 5000,
    identityMs: 1, rootMs: 2, prepareMs: 5097, readMs: 0, projectionMs: 0, source: 'SECRET_SOURCE' };
  const record = { status: 'error', userMessageIndex: 4, generationType: 'normal', receiptPersistence: 'none', selectedFloors: [], selectedStates: [], selectedCseChanges: [], injectionText: '', skipReasons: [],
    attemptDiagnostics: [{ attempt: 1, phase: 'commit', selectionStatus: 'completed', timings: { preparationAttempts: [preparation] } },
      { attempt: 2, phase: 'source', selectionStatus: 'notStarted', timings: { preparationAttempts: [{ ...preparation, phase: 'source', stage: 'read', prepareMs: 0, readMs: 5097 }] } }] };
  const recallRuntime = { getState: () => ({ recallStatus: 'error', lastRecall: record }) };
  const copied = [], navigatorRef = { clipboard: { writeText: async value => copied.push(value) } };
  const container = new Node('main'); const view = createV3FoundationView({ runtime, recallRuntime, documentRef, navigatorRef }); view.mount(container);
  for (const node of flatten(container).filter(node => node.children.length)) Object.defineProperty(node, 'textContent', { configurable: true, get: () => node.children.map(child => child.textContent).join('') });
  await flatten(container).find(node => node.textContent === '复制回执').click();
  assert.match(copied[0], /第 1 次准备.*只读核验.*超时于准备缓存.*期限 5000 ms/su);
  assert.match(copied[0], /第 2 次准备.*超时于独立来源读取.*独立来源读取 5097 ms/su);
  assert.doesNotMatch(copied[0], /SECRET_SOURCE/u); view.deactivate();
});
