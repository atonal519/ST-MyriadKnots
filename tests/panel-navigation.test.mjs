import { createPanelGeometryController, desktopPanelSize, mobilePanelRect, PANEL_POSITION_KEY, PANEL_SIZE_KEY } from '../src/ui/layout.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { createV3FoundationView } from '../src/ui/v3-foundation-view.js';
import { applyPluginEnabledImmediately } from '../src/settings.js';
import { openHelpGuide } from '../src/ui/help-guide.js';
import { publicErrorMessage } from '../src/public-error.js';
import { scrollbarCss } from '../src/ui/scrollbar-style.js';
import { createVectorIndex } from '../src/v3/vector-index.js';

class Node {
  constructor(tag = 'div') {
    this.tag = tag; this.children = []; this.listeners = {}; this.hidden = false; this.scrollTop = 0; this.dataset = {}; this.className = ''; this.textContent = '';
    this.attributes = {}; this.style = { setProperty() {} };
    this.classList = { toggle: (name, enabled) => { this.dataset[`class_${name}`] = Boolean(enabled); } };
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  fire(name, event = {}) { return this.listeners[name]?.(event); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  querySelector(selector) { return flatten(this).find(node => selector.startsWith('#') ? node.id === selector.slice(1) : selector === 'summary' && node.tag === 'summary') ?? null; }
  focus() { this.focused = true; }
  scrollIntoView(options) { this.scrollOptions = options; }
}
const flatten = node => [node, ...(node.children ?? []).flatMap(flatten)];
const waitFor = async (condition, message, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
};

test('真实面板入口按千人/千结/千事/千窗/双丝网/设置映射视图，并恢复各页滚动位置', async () => {
  const [source, panelHtml, panelCss] = await Promise.all([
    readFile(new URL('../src/ui/panel.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/panel.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/panel.css', import.meta.url), 'utf8'),
  ]);
  let updateChecks = 0;
  const pluginUpdates = { ensureChecked() { updateChecks += 1; } };
  const calls = [];
  const panelNode = new Node('section'), body = new Node('main'), view = new Node('div');
  const topbar = new Node('header'), resize = new Node('button'), close = new Node('button'), themeButton = new Node('button'), fabButton = new Node('button');
  const themeSvg = new Node('svg'); themeButton.querySelector = selector => selector === 'svg' ? themeSvg : null;
  const profileTab = new Node('button'), eventTab = new Node('button'), qianshiTab = new Node('button'), qianchuangTab = new Node('button'), peopleTab = new Node('button'), settingsTab = new Node('button'); profileTab.dataset.tab = 'profiles'; eventTab.dataset.tab = 'events'; qianshiTab.dataset.tab = 'qianshi'; qianchuangTab.dataset.tab = 'qianchuang'; peopleTab.dataset.tab = 'people'; settingsTab.dataset.tab = 'settings';
  const nodeMap = new Map([['.panel', panelNode], ['.body', body], ['.view', view], ['.topbar', topbar], ['.panel-resize-handle', resize], ['.close', close], ['.theme-btn', themeButton], ['.fab-toggle-btn', fabButton]]);
  const root = { innerHTML: '', querySelector: selector => nodeMap.get(selector) ?? null, querySelectorAll: selector => selector === '.tab' ? [profileTab, eventTab, qianshiTab, qianchuangTab, peopleTab, settingsTab] : [] };
  const host = new Node('host'); host.attachShadow = () => root;
  let firstElement = true;
  const documentEvents = {}, documentListeners = new Map();
  const documentRef = { defaultView: { innerWidth: 390, matchMedia: () => ({ matches: documentRef.defaultView.innerWidth <= 640 }) }, body: new Node('body'), createElement(tag) { if (firstElement) { firstElement = false; return host; } return new Node(tag); },
    addEventListener(name, listener, capture = false) {
      if (!documentListeners.has(name)) documentListeners.set(name, []);
      documentListeners.get(name).push({ listener, capture });
      documentEvents[name] = event => {
        let stopped = false;
        const dispatched = { ...event, stopPropagation() { stopped = true; event.stopPropagation?.(); }, stopImmediatePropagation() { stopped = true; event.stopImmediatePropagation?.(); } };
        for (const entry of [...documentListeners.get(name)].sort((left, right) => Number(right.capture) - Number(left.capture))) {
          entry.listener(dispatched); if (stopped) break;
        }
      };
    },
    removeEventListener(name, listener, capture = false) { documentListeners.set(name, (documentListeners.get(name) ?? []).filter(entry => entry.listener !== listener || entry.capture !== capture)); },
  };
  const drawerState = new Map();
  const drawer = ({ title, open = false, onToggle, id, level } = {}) => {
    const node = new Node('details'), drawerBody = new Node('div'), summary = new Node('summary');
    node.drawerLevel = level;
    node.drawerTitle = title; node.id = id; node.open = open; node.addEventListener('toggle', () => onToggle?.(node.open)); node.append(drawerBody);
    node.append(summary);
    return { drawer: node, body: drawerBody, summary };
  };
  const dialogAppearances = [];
  let rejectSaveSchedule = false;
  let tauriTavern = false;
  const saveScheduleError = new Error('private settings scheduler detail');
  let apiSettingsMounts = 0, apiSettingsDisposals = 0, vectorSettingsMounts = 0, vectorSettingsDisposals = 0;
  let wrapperMounts = 0, wrapperDisposals = 0;
  const modules = {
    './plugin-updates-view.js': { createPluginUpdatesView: () => ({ controls: new Node(), noticeRow: new Node(), feedback: new Node(), dispose() {} }) },
    './panel.html?raw': { default: '' }, './panel.css?inline': { default: '' },
    './scrollbar-style.js': { scrollbarCss },
    './shared-ui-style.js': { sharedUiCss: '', sharedDialogCss: '', QQJ_GEOMETRY_TOKENS: {}, QQJ_MOTION_TOKENS: {} },
    './layout.js': { createPanelGeometryController: () => ({ restore() {}, cancelGesture() {} }) },
    './appearance.js': { createAppearanceController: ({ onChange }) => { const state = { mode: 'auto', effectiveTheme: 'day', palette: {}, fontReady: Promise.resolve() }; onChange?.(state); return { apply() { onChange?.(state); return state; }, getState: () => state, destroy() {} }; } },
    './font-scale.js': { scaleCssFontSizes: css => css, scaleCssSpacing: css => css },
    './settings-drawer.js': { createSettingsDrawer: drawer, createSettingsDrawerState: () => ({ open(key) { drawerState.set(key, true); }, set(key, value) { drawerState.set(key, value); }, isOpen: (key, fallback) => drawerState.has(key) ? drawerState.get(key) : fallback }) },
    './settings/api-settings.js': { createApiSettings: ({ open, onToggle }) => {
      apiSettingsMounts++;
      const api = drawer({ title: 'API 配置', id: 'qqj-settings-api', open, onToggle, level: 'sub' });
      const apiDraft = new Node('input'); apiDraft.value = '未保存的 API 草稿';
      api.body.append(apiDraft);
      return { node: api.drawer, apiDraft, dispose() { apiSettingsDisposals++; } };
    } },
    './settings/vector-api-settings.js': { createVectorApiSettings: ({ open, onToggle }) => {
      vectorSettingsMounts++;
      const vector = drawer({ title: '向量配置', id: 'qqj-settings-vector-api', open, onToggle, level: 'sub' });
      return { node: vector.drawer, dispose() { vectorSettingsDisposals++; } };
    } },
    './settings/prompts-settings.js': { createPromptsSettings: () => { wrapperMounts++; return { node: new Node(), dispose() { wrapperDisposals++; } }; } },
    './settings/appearance-settings.js': { createAppearanceSettings: () => ({ node: new Node() }) },
    './help-guide.js': { openHelpGuide },
    '../settings.js': { applyPluginEnabledImmediately },
    '../tauri-backend.js': { isTauriTavern: () => tauriTavern },
    '../public-error.js': { publicErrorMessage },
  };
  const context = createContext({ console });
  const entry = new SourceTextModule(source, { context, identifier: new URL('../src/ui/panel.js', import.meta.url).href });
  await entry.link(specifier => new SyntheticModule(Object.keys(modules[specifier]), function initialize() { for (const [name, value] of Object.entries(modules[specifier])) this.setExport(name, value); }, { context, identifier: specifier }));
  await entry.evaluate();
  let foundationState = {
    status: 'uninitialized', pluginEnabled: true, chatId: null, narrativeGeneration: null, foundationStatus: 'uninitialized',
    memorySnapshotStatus: 'unavailable', memorySyncStatus: 'idle',
    stableCount: 0, rememberedCount: 0, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null,
    headCheckpointId: null, activeRun: null, activeExtraction: null, activeCse: null, lastRun: null, lastError: null,
    lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, cseReady: false, csePendingCount: 0,
    cseFailedCount: 0, baselineId: null, cseSubjects: [], floors: [], rebuildStatus: 'caughtUp',
  };
  const foundationListeners = new Set(); let foundationRefreshes = 0;
  const foundationRuntime = { getState: () => foundationState, async refreshStatus() {
    foundationRefreshes += 1;
    foundationState = { ...foundationState, status: 'ready', chatId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', narrativeGeneration: 'panel-generation', foundationStatus: 'ready', memorySnapshotStatus: 'ready' };
    for (const listener of foundationListeners) listener(foundationState);
    return foundationState;
  }, confirmLatest: async () => foundationState, subscribe(listener) { foundationListeners.add(listener); return () => foundationListeners.delete(listener); } };
  const clipboardWrites = [];
  let indexManifestReads = 0, indexShardReads = 0, identityReads = 0;
  const vectorRuntime = createVectorIndex({ client: { async get(_collection, id) {
      if (id === 'qqj-vector-index') { indexManifestReads += 1; throw Object.assign(new Error('not_found'), { status: 404 }); }
      indexShardReads += 1; throw new Error('unexpected shard read');
    } }, configProvider: () => ({ url: 'https://vector.invalid/v1', model: 'model', key: 'local-test-key', dimensions: null }),
    identityProvider: () => { identityReads += 1; throw new Error('page check uses loaded target identity'); } });
  let panel;
  const actualFoundationView = createV3FoundationView({ runtime: foundationRuntime, vectorRuntime, documentRef,
    onOpenVectorSettings: () => panel?.openVectorSettings?.(),
    navigatorRef: { clipboard: { async writeText(value) { clipboardWrites.push(value); } } } });
  let rejectFoundationActivation = false;
  const v3FoundationView = {
    setPage(value) { calls.push(['page', value]); actualFoundationView.setPage(value); },
    mount(target, options) { calls.push(['mount', target]); if (options?.page) calls.push(['mount-page', options.page]); actualFoundationView.mount(target, options); },
    activate() { return rejectFoundationActivation ? Promise.reject(new Error('management offline')) : actualFoundationView.activate(); },
    deactivate() { calls.push(['deactivate']); actualFoundationView.deactivate(); },
  };
  const peopleProfilesView = {
    mount(target) { calls.push(['profiles-mount', target]); target.replaceChildren(new Node('profiles')); },
    async activate() { calls.push(['profiles-activate']); return { status: 'ready' }; },
    deactivate() { calls.push(['profiles-deactivate']); },
  };
  const qianshiTimelineView = {
    mount(target) { calls.push(['qianshi-mount', target]); target.replaceChildren(new Node('qianshi')); },
    async activate() { calls.push(['qianshi-activate']); return { status: 'ready' }; },
    deactivate() { calls.push(['qianshi-deactivate']); },
  };
  const storageManagementView = {
    mount(target) { calls.push(['storage-mount', target]); target.replaceChildren(new Node('storage')); },
    async activate() { calls.push(['storage-activate']); return { status: 'ready' }; },
    deactivate() { calls.push(['storage-deactivate']); },
  };
  const transferViews = [];
  const memoryTransferViewFactory = options => {
    const value = { node: new Node('memory-transfer'), disposed: false, dispose() { this.disposed = true; } };
    value.node.open = options.open; value.node.addEventListener('toggle', () => options.onToggle(value.node.open));
    transferViews.push(value); return value;
  };
  const values = { pluginEnabled: true, appearanceTheme: 'auto', appearanceFontFamily: '测试字体', appearanceFontCssUrl: 'https://example.invalid/font.css', fabShow: true, autoHideEnabled: false, autoHideKeepAiCount: 3, coreCacheEnabled: true };
  const updates = [];
  const settings = { isEnabled: () => values.pluginEnabled !== false, get: () => values, update(value, options = {}) { Object.assign(values, value); updates.push(value); if (rejectSaveSchedule && options.observeSaveFailure) throw saveScheduleError; return value; } };
  let rejectPluginDisable = false;
  const pluginDisableError = new TypeError('private plugin start detail');
  const pluginFailures = [];
  let fabVisible = true, dialogActive = false, dialogCancels = 0, helpDialog = null, clipboardFail = false;
  let ledgerInjectionEnabled = false, timeChanges = 0, resolveTimeConfirm;
  const timeConfirms = [];
  const timeListeners = new Set(), memoryListeners = new Set(); let timeReads = 0, timeOrganizes = 0;
  let timeState = { status: 'idle', active: false, last: null, canOrganize: true, disabledReason: '' };
  const publishTime = () => { for (const listener of timeListeners) listener(timeState); };
  const timeRuntime = { getState: () => timeState, async refreshStatus() { timeReads += 1; publishTime(); return timeState; }, async organize() { timeOrganizes += 1; publishTime(); return timeState; }, subscribe(listener) { timeListeners.add(listener); return () => timeListeners.delete(listener); } };
  const memoryRuntime = { subscribe(listener) { memoryListeners.add(listener); return () => memoryListeners.delete(listener); } };
  const autoHideApplies = [];
  let autoHideApplyStatus = null;
  let calendarChatId = foundationState.chatId, savedCalendar = null; const calendarChanges = [];
  const calendarContextProvider = () => ({ chatId: calendarChatId, calendar: savedCalendar });
  panel = entry.namespace.createPanel({ pluginUpdates, calendarContextProvider, onCalendarChange: async value => { calendarChanges.push(value); savedCalendar = value.calendar; }, settings, v3FoundationView, timeRuntime, memoryRuntime, peopleProfilesView, qianshiTimelineView, qianchuangView: { mount(target) { calls.push(['window-mount',target]); }, activate() { calls.push(['window-activate']); return Promise.resolve({status:'ready'}); }, deactivate() { calls.push(['window-deactivate']); } }, storageManagementView, memoryTransferViewFactory, documentRef, isSevenDaysLedgerInjectionEnabled: () => ledgerInjectionEnabled, onPluginEnabledChange: async value => { if (rejectPluginDisable && value === false) throw pluginDisableError; }, onPluginEnableFailure: (error, phase) => pluginFailures.push({ error, phase, settingsEnabled: settings.isEnabled() }), onTimeEvolutionChange: () => { timeChanges += 1; }, navigatorRef: { clipboard: { async writeText(value) { clipboardWrites.push(value); if (clipboardFail) throw new Error('clipboard denied'); } } }, dialog: { setAppearance(value) { dialogAppearances.push(value); }, confirm(options) { timeConfirms.push(options); dialogActive = true; return new Promise(resolve => { resolveTimeConfirm = result => { dialogActive = false; resolve(result); }; }); }, custom(options) { helpDialog = options; dialogActive = true; return Promise.resolve(true); }, closeAll() { resolveTimeConfirm?.(false); dialogActive = false; }, hasActive: () => dialogActive, cancelTop() { dialogCancels += 1; dialogActive = false; } }, onFabShowChange: value => { fabVisible = value; }, onAutoHideChange: async value => { autoHideApplies.push(value); return autoHideApplyStatus ? { status: autoHideApplyStatus } : undefined; } });

  await panel.show();
  await Promise.resolve();
  assert.equal(updateChecks, 1, '首次打开面板非阻塞触发版本检查');
  assert.equal(dialogAppearances.at(-1)?.family, '测试字体', '独立编辑窗接收外观控制器解析出的字体');
  assert.equal(dialogAppearances.at(-1)?.fontCssUrl, 'https://example.invalid/font.css');
  assert.match(root.innerHTML, /\.body\{[^}]*touch-action:pan-y/);
  assert.ok(root.innerHTML.includes('@media(min-width:641px){:host{pointer-events:none}}'));
  assert.match(root.innerHTML, /\.panel\{[^}]*pointer-events:auto/);
  assert.ok(calls.some(([kind]) => kind === 'profiles-activate'));
  let preventedOutside = 0, stoppedOutside = 0;
  const background = new Node('div');
  const outsideEvent = inside => ({ button: 0, pointerId: 1, clientX: 5, clientY: 5, target: inside ? host : background, composedPath: () => inside ? [close, panelNode, root, host] : [background, documentRef], preventDefault() { preventedOutside += 1; }, stopImmediatePropagation() { stoppedOutside += 1; } });
  const pointerSequence = (downInside, upInside) => {
    documentEvents['pointerdown']?.(outsideEvent(downInside));
    documentEvents['pointerup']?.(outsideEvent(upInside));
    documentEvents['click']?.(outsideEvent(false));
  };
  pointerSequence(true, false);
  assert.equal(panel.getState().open, true, '从面板内部拖到外侧不关闭');
  pointerSequence(false, true);
  assert.equal(panel.getState().open, true, '从外侧拖到面板内部不关闭');
  documentEvents['pointerdown']?.(outsideEvent(false)); documentEvents.pointercancel?.({});
  documentEvents['pointerup']?.(outsideEvent(false)); documentEvents['click']?.(outsideEvent(false));
  assert.equal(panel.getState().open, true, '取消的pointer手势不关闭');
  documentEvents['pointerdown']?.(outsideEvent(true)); documentEvents['pointerup']?.(outsideEvent(true)); documentEvents['click']?.(outsideEvent(true));
  assert.equal(panel.getState().open, true, 'Shadow DOM重定向到host的内部点击保持打开');
  documentEvents.pointerdown?.(outsideEvent(false));
  documentEvents.pointermove?.({ pointerId: 1, clientX: 25, clientY: 5 });
  documentEvents.pointerup?.(outsideEvent(false)); documentEvents.click?.(outsideEvent(false));
  assert.equal(panel.getState().open, true, '外侧拖选移动超过5px不关闭');
  assert.equal(documentListeners.has('wheel'), false, '原生滚轮不设转发或阻止监听');
  documentRef.defaultView.getComputedStyle = () => ({ position: 'fixed' });
  const foreignHost = new Node('foreign-host'), foreignRoot = { nodeType: 11, host: foreignHost };
  for (const type of ['pointerdown', 'pointerup', 'click']) documentEvents[type]?.({ ...outsideEvent(false), composedPath: () => [foreignRoot, foreignHost, documentRef] });
  assert.equal(panel.getState().open, true, '其它fixed Shadow窗口内部点击不被当前窗口抢先关闭');
  for (const selector of ['button', 'input', 'textarea', 'a[href]', 'label', 'summary', '[role~="button"]', '[tabindex]:not([tabindex="-1"])', 'dialog', 'select', 'input[list]', '[role~="dialog"]', '[role~="alertdialog"]', '[role~="menu"]', '[role~="listbox"]', '[role~="combobox"]', '[aria-haspopup]', '[popover]']) {
    const popup = selector === '[popover]' ? { popover: 'auto', matches: value => value === ':popover-open' }
      : selector === '[aria-haspopup]' ? { getAttribute: name => name === 'aria-haspopup' ? 'menu' : null }
        : { matches: selectors => selectors.split(',').map(value => value.trim()).includes(selector === 'input[list]' ? 'input' : selector) };
    let blocked = false;
    for (const type of ['pointerdown', 'pointerup', 'click']) documentEvents[type]?.({ ...outsideEvent(false),
      composedPath: () => [{}, popup, documentRef], preventDefault: () => { blocked = true; } });
    const protectedWindow = ['dialog', '[role~="dialog"]', '[role~="alertdialog"]', '[role~="menu"]', '[role~="listbox"]', '[role~="combobox"]', '[popover]'].includes(selector);
    assert.equal(panel.getState().open, protectedWindow, `外侧宿主动作收起，独立窗口保持所属层 ${selector}`);
    if (!protectedWindow) await panel.show();
    assert.equal(blocked, false, `外来弹窗点击送回原控件 ${selector}`);
    documentEvents.keydown({ key: 'Escape', composedPath: () => [{}, popup, documentRef] });
    assert.equal(panel.getState().open, true, `外来弹窗Escape保留千千结 ${selector}`);
    dialogActive = true;
    documentEvents.keydown({ key: 'Escape', composedPath: () => [{}, popup, documentRef] });
    assert.equal(dialogActive, true, '外来弹窗Escape不取消我方已打开的子窗');
    dialogActive = false;
  }

  dialogActive = true; pointerSequence(false, false);
  assert.equal(panel.getState().open, true, '子弹窗活跃时外侧事件不穿透关闭主面板');
  dialogActive = false;
  for (const width of [1280, 641]) {
    documentRef.defaultView.innerWidth = width;
    pointerSequence(false, false);
    assert.equal(panel.getState().open, true, '桌面宿主纯点击不关闭主浮窗');
    assert.equal(preventedOutside, 0, '桌面宿主click不被消费');
    assert.equal(stoppedOutside, 0);
  }
  documentRef.defaultView.innerWidth = 390;
  documentEvents.pointerdown(outsideEvent(false));
  documentRef.defaultView.innerWidth = 641;
  documentEvents.pointerup(outsideEvent(false)); documentEvents.click(outsideEvent(false));
  assert.equal(panel.getState().open, true, '手机按下后切桌面不关闭');
  documentEvents.pointerdown(outsideEvent(false));
  documentRef.defaultView.innerWidth = 390;
  documentEvents.pointerup(outsideEvent(false)); documentEvents.click(outsideEvent(false));
  assert.equal(panel.getState().open, true, '桌面按下后切手机不续用旧手势');
  documentRef.defaultView.innerWidth = 640;
  const outsideTrigger = new Node('button');
  await panel.show(outsideTrigger);
  const outsideDeactivations = calls.filter(([kind]) => kind === 'profiles-deactivate').length;
  const hostInput = { matches: selectors => selectors.split(',').includes('input') };
  for (const type of ['pointerdown', 'pointerup', 'click']) documentEvents[type]({ ...outsideEvent(false), composedPath: () => [hostInput, documentRef] });
  assert.equal(panel.getState().open, false, '手机宿主input首击应收起主窗');
  assert.notEqual(outsideTrigger.focused, true, '外侧关闭不把输入焦点拉回FAB');
  assert.equal(preventedOutside, 0);
  await panel.show(outsideTrigger);
  pointerSequence(false, false);
  assert.equal(panel.getState().open, false, '文档外侧两端点击沿close关闭');
  assert.equal(preventedOutside, 0, '外侧关闭保留宿主默认动作');
  assert.equal(stoppedOutside, 0, '外侧关闭保留宿主click传播');
  pointerSequence(false, false);
  assert.equal(preventedOutside, 0, '隐藏面板放行宿主click');
  assert.notEqual(outsideTrigger.focused, true);
  assert.equal(calls.filter(([kind]) => kind === 'profiles-deactivate').length, outsideDeactivations + 2, '两次外侧关闭均执行原视图清理');
  documentRef.defaultView.innerWidth = 390;
  await panel.show(); pointerSequence(false, false);
  assert.equal(panel.getState().open, false, '390手机纯外侧点击仍关闭');
  assert.equal(preventedOutside, 0); assert.equal(stoppedOutside, 0);
  await panel.show(outsideTrigger);
  panelNode.getBoundingClientRect = () => ({ left: 10, top: 20, width: 370, height: 764 });
  for (const type of ['pointerdown', 'pointerup']) documentEvents[type]({ ...outsideEvent(true), clientX: 4, clientY: 400 });
  documentEvents.click({ ...outsideEvent(true), clientX: 12, clientY: 400 });
  assert.equal(panel.getState().open, false, '浏览器将窄边触控重定向入窗也按物理两端关闭');
  assert.equal(preventedOutside, 1); assert.equal(stoppedOutside, 1, '重定向的窗内click不激活隐藏动作');
  delete panelNode.getBoundingClientRect;
  await panel.show();
  body.scrollTop = 31;
  settingsTab.fire('click');
  const findManagementMount = () => view.children[0]?.children.find(node => node.className === 'qqj-settings-management');
  const findIndexLink = () => flatten(findManagementMount() ?? view).find(node => node.className.includes('qqj-vector-index-link'));
  await waitFor(() => indexManifestReads === 1 && findIndexLink()?.hidden === false, '设置页索引状态未完成');
  const initialManagementMount = findManagementMount();
  const indexLink = findIndexLink();
  assert.ok(indexLink); assert.equal(indexLink.hidden, false, '直接打开设置记忆管理后按当前manifest显示零索引文字链接');
  assert.match(indexLink.textContent, /还没有向量索引/u);
  assert.equal(flatten(view).some(node => node.className.includes('qqj-vector-index-hint')), false, '千结内容页不再显示独立索引提示');
  assert.equal(foundationRefreshes, 1, '只有当前设置管理页读取一次当前状态');
  assert.equal(indexManifestReads, 1); assert.equal(indexShardReads, 0); assert.equal(identityReads, 0);
  const settingsPage = view.children[0];
  const apiDraft = flatten(settingsPage).find(node => node.value === '未保存的 API 草稿');
  const apiMountsBeforeNavigation = apiSettingsMounts, apiDisposalsBeforeNavigation = apiSettingsDisposals;
  await indexLink.fire('click');
  const generalDrawer = flatten(settingsPage).find(node => node.id === 'qqj-settings-group-general');
  const apiDrawer = flatten(settingsPage).find(node => node.id === 'qqj-settings-api');
  const vectorDrawer = flatten(settingsPage).find(node => node.id === 'qqj-settings-vector-api');
  assert.equal(generalDrawer?.open, true); assert.equal(apiDrawer?.open, false, '向量深链保持API原开合'); assert.equal(vectorDrawer?.open, true);
  assert.equal(vectorDrawer.drawerTitle, '向量配置');
  assert.ok(generalDrawer.children[0].children.includes(apiDrawer));
  assert.ok(generalDrawer.children[0].children.includes(vectorDrawer), 'API与向量直接属于同一个通用设置body');
  assert.equal(vectorDrawer?.scrollOptions?.block, 'center'); assert.equal(vectorDrawer?.children.find(node => node.tag === 'summary')?.focused, true);
  assert.equal(flatten(settingsPage).find(node => node.value === '未保存的 API 草稿'), apiDraft, '导航不重绘设置或丢未保存API草稿');
  assert.equal(apiSettingsMounts, apiMountsBeforeNavigation); assert.equal(apiSettingsDisposals, apiDisposalsBeforeNavigation);
  assert.equal(indexManifestReads, 1); assert.equal(indexShardReads, 0); assert.equal(identityReads, 0, '纯导航不重新读取manifest或identity');
  eventTab.fire('click');
  assert.equal(vectorSettingsDisposals, vectorSettingsMounts, '离开设置独立释放向量订阅');
  await waitFor(() => foundationRefreshes === 2, '千结页状态刷新未完成');
  assert.equal(foundationRefreshes, 2, '随后打开千结页只读取当前状态');
  assert.equal(indexManifestReads, 1, '零索引检查属于设置记忆管理入口');
  assert.equal(flatten(view).some(node => node.className.includes('qqj-vector-index-hint')), false);
  settingsTab.fire('click');
  await waitFor(() => findIndexLink()?.hidden === false, '重新进入设置页时索引状态未完成');
  const indexDiagnosticMount = view.children[0]?.children.find(node => node.className === 'qqj-settings-management');
  const copyStatus = flatten(indexDiagnosticMount).find(node => node.textContent === '复制状态诊断');
  assert.ok(copyStatus, '设置页保留记忆页状态诊断入口');
  copyStatus.fire('click'); await waitFor(() => clipboardWrites.length > 0, '状态诊断复制未完成');
  const copiedStatus = JSON.parse(clipboardWrites.at(-1));
  assert.equal(copiedStatus.vector.indexCheckStatus, 'ready');
  assert.equal(copiedStatus.vector.indexChunkCount, 0);
  assert.equal(copiedStatus.vector.indexChatMatchesMemory, true);
  assert.equal(JSON.stringify(copiedStatus).includes('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), false, '诊断说明是否匹配，不暴露聊天编号');
  clipboardWrites.length = 0;
  eventTab.fire('click');
  await waitFor(() => indexManifestReads === 2, '重新打开记忆页时索引状态未完成');
  assert.equal(indexManifestReads, 2, '重新打开记忆页只再读取一次manifest');
  assert.equal(indexShardReads, 0); assert.equal(identityReads, 0);
  body.scrollTop = 31; eventTab.fire('click');
  assert.equal(body.scrollTop, 31, '同一记忆页重新激活时保留当前位置'); assert.deepEqual(calls.filter(([kind]) => kind === 'page').at(-1), ['page', 'memories']);
  body.scrollTop = 71; peopleTab.fire('click');
  assert.equal(body.scrollTop, 0); assert.deepEqual(calls.at(-1), ['page', 'people']);
  body.scrollTop = 39; settingsTab.fire('click');
  assert.ok(calls.some(([kind, value]) => kind === 'mount-page' && value === 'management'), '设置页 mount 应使用 management 页选项');
  assert.equal(calls.filter(([kind, value]) => kind === 'page' && value === 'management').length, 0, '设置页不应先构建摘要页再切换');
  assert.equal(view.children[0]?.className, 'settings-page', '设置页应真实占据面板内容容器');
  const masterInput = flatten(view).find(node => node.tag === 'input');
  assert.ok(masterInput, '设置首开应存在总开关输入');
  rejectPluginDisable = true; masterInput.checked = false;
  await masterInput.fire('change');
  assert.equal(pluginFailures.at(-1)?.error, pluginDisableError, '真实设置面板应在恢复后保留启用入口的原异常');
  assert.equal(pluginFailures.at(-1)?.phase, 'pluginEnable');
  assert.equal(pluginFailures.at(-1)?.settingsEnabled, true, '诊断回调只能在总开关回滚后运行');
  assert.equal(masterInput.checked, true, '失败后面板总开关应恢复原值');
  rejectPluginDisable = false;
  rejectSaveSchedule = true; masterInput.checked = false;
  await masterInput.fire('change');
  assert.equal(pluginFailures.at(-1)?.error, saveScheduleError, '同步设置调度失败应保留真实异常');
  assert.equal(pluginFailures.at(-1)?.phase, 'settingsSave', '同步设置调度失败应标记 settingsSave');
  assert.equal(pluginFailures.at(-1)?.settingsEnabled, true);
  assert.equal(masterInput.checked, true);
  rejectSaveSchedule = false;
  assert.equal(apiSettingsDisposals, apiSettingsMounts - 1, '当前设置页保留唯一 API 进度订阅');
  assert.equal(wrapperDisposals, wrapperMounts - 1, '当前设置页保留唯一包裹值回显订阅');
  assert.equal(view.children[0]?.children.some(node => node.className === 'master-switch'), true, '设置首开不得被真实 setPage 重绘清掉总开关');
  const settingsGroups = view.children[0]?.children.filter(node => node.tag === 'details');
  assert.deepEqual(settingsGroups.map(node => node.drawerTitle), ['通用设置', '记忆设置', '教程与配置文件'], '存储管理应收进记忆设置，不再占用顶层抽屉');
  const coreCacheToggle = flatten(settingsGroups[1]).find(node => node.id === 'qqj-settings-core-cache');
  assert.ok(coreCacheToggle, 'native记忆设置提供独立的浏览器缓存开关');
  const coreCacheInput = coreCacheToggle.children.find(node => node.tag === 'input');
  assert.equal(coreCacheInput.checked, true);
  assert.match(flatten(settingsGroups[1]).map(node => node.textContent).join('|'), /关闭不会删除记忆.*正式存储.*整页刷新酒馆生效/u);
  coreCacheInput.checked = false; coreCacheInput.fire('change');
  assert.equal(values.coreCacheEnabled, false, '开关修改写入正式设置store');
  assert.equal(updates.at(-1).coreCacheEnabled, false);
  assert.match(flatten(settingsGroups[1]).find(node => node.id === 'qqj-settings-core-cache-result').textContent, /整页刷新酒馆后生效/u);
  values.pluginEnabled = false;
  assert.equal(coreCacheInput.disabled, undefined, '总开关关闭时仍可操作缓存设置');
  values.pluginEnabled = true;
  const documentation = settingsGroups[2];
  assert.equal(documentation.open, false); assert.equal(view.children[0].children.at(-1), documentation, '教程与配置文件必须是设置页最后一项');
  const documentationCopy = flatten(documentation).map(node => node.textContent).join('|');
  for (const value of ['教程文档', 'API 接口', '复制接口示例']) assert.ok(documentationCopy.includes(value));
  assert.doesNotMatch(documentationCopy, /getStatus\(\)|readMemory\(\)|getSnapshot\(\)|复制调用示例|供同一 SillyTavern/);
  const documentRows = flatten(documentation).filter(node => node.className === 'settings-document-row');
  assert.deepEqual(documentRows.map(node => node.children.map(child => child.textContent)), [['教程文档', '教程文档'], ['API 接口', '复制接口示例']]);
  assert.ok(documentationCopy.indexOf('教程文档') < documentationCopy.indexOf('API 接口'));
  const managementMount = view.children[0]?.children.find(node => node.className === 'qqj-settings-management');
  assert.doesNotMatch(flatten(managementMount).map(node => node.textContent).join('|'), /API 接口/, '记忆管理不再嵌套API说明');
  assert.equal(flatten(view.children[0]).filter(node => node.tag === 'button' && node.textContent === '教程文档').length, 1, '设置标题旁不得另放教程入口');
  const tutorial = flatten(documentation).find(node => node.tag === 'button' && node.textContent === '教程文档');
  assert.notEqual(tutorial.disabled, true, '教程是静态内容，不受后台忙碌状态影响');
  const callsBeforeHelp = calls.length; tutorial.fire('click'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, callsBeforeHelp, '打开静态教程不得读取或激活记忆runtime');
  assert.equal(helpDialog.title, '千千结使用说明'); assert.equal(helpDialog.confirmText, '关闭'); assert.equal(helpDialog.cancelText, '');
  const helpSections = flatten(helpDialog.content).filter(node => node.tag === 'details');
  assert.equal(helpSections.length, 11); assert.equal(helpSections[0].open, true); assert.ok(helpSections.slice(1).every(node => node.open === false));
  const placeGuide = helpSections.find(node => node.children[0].textContent === '千窗：地点与地图');
  assert.ok(placeGuide);
  const placeGuideCopy = flatten(placeGuide).map(node => node.textContent).join('|');
  assert.match(placeGuideCopy, /添加子地点.*未归属地点.*24张通用图/u);
  assert.match(placeGuideCopy, /每次调用一次摘要 API.*不需要先补完逐楼摘要/u);
  assert.equal(helpSections.at(-1).children[0].textContent, '排障手册');
  assert.match(flatten(helpDialog.content).map(node => node.textContent).join('|'), /保留包裹符.*清洗包裹符.*人物状态重构/);
  assert.match(flatten(helpDialog.content).map(node => node.textContent).join('|'), /近期事项.*关键词只概括事项类型与宽泛主题，推测状态另列/u);
  assert.match(flatten(helpDialog.content).map(node => node.textContent).join('|'), /千事.*涉及物品.*搜索/u);
  assert.match(flatten(helpDialog.content).map(node => node.textContent).join('|'), /摘要每页最多50楼.*上一页.*下一页.*输入页码跳转.*搜索命中会定位到原摘要页/u);
  dialogActive = false;
  const copyExample = flatten(documentation).find(node => node.tag === 'button' && node.textContent === '复制接口示例');
  copyExample.fire('click'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(clipboardWrites.length, 1); assert.match(clipboardWrites[0], /globalThis\.qqj_v3_public_bridge_v1/); assert.match(clipboardWrites[0], /getPromptSnapshot\(\)/);
  assert.match(flatten(documentation).map(node => node.textContent).join('|'), /已复制/);
  clipboardFail = true; copyExample.fire('click'); await new Promise(resolve => setImmediate(resolve));
  let fallback = flatten(documentation).find(node => node.className === 'v3-diagnostic-fallback');
  assert.equal(fallback?.readOnly, true); assert.match(fallback?.value ?? '', /getPromptSnapshot\(\)/); assert.match(fallback?.value ?? '', /getSnapshot\(\)/);
  documentation.open = true; documentation.fire('toggle');
  await panel.show();
  const rerenderedPage = view.children[0], rerenderedDocumentation = rerenderedPage.children.filter(node => node.tag === 'details').at(-1);
  assert.equal(rerenderedDocumentation.drawerTitle, '教程与配置文件'); assert.equal(rerenderedDocumentation.open, true);
  fallback = flatten(rerenderedDocumentation).find(node => node.className === 'v3-diagnostic-fallback');
  assert.match(fallback?.value ?? '', /globalThis\.qqj_v3_public_bridge_v1/, '设置页重绘后保留手动复制文本');
  const memoryControls = settingsGroups[1].children[0].children;
  const storageDrawer = memoryControls.find(node => node.drawerTitle === '存储管理');
  assert.equal(storageDrawer?.drawerLevel, 'sub');
  assert.equal(storageDrawer?.id, 'qqj-settings-sub-storage');
  const [storageMount, transferNode] = storageDrawer.children[0].children;
  assert.equal(transferNode.tag, 'memory-transfer', '导入导出位于存储管理内部最下方');
  assert.equal(transferNode.open, false); transferNode.open = true; transferNode.fire('toggle');
  assert.equal(drawerState.get('memory-transfer'), true, '记录导入导出折叠状态供重绘时恢复');
  storageMount.replaceChildren(new Node('refreshed-storage'));
  assert.equal(storageDrawer.children[0].children.at(-1), transferNode, '刷新存储统计保留导入预览节点');
  const storageActivationsBefore = calls.filter(([kind]) => kind === 'storage-activate').length;
  storageDrawer.open = true; storageDrawer.fire('toggle');
  assert.equal(calls.filter(([kind]) => kind === 'storage-activate').length, storageActivationsBefore, '父抽屉收起时子抽屉不得读取清单');
  settingsGroups[1].open = true; settingsGroups[1].fire('toggle');
  assert.equal(calls.filter(([kind]) => kind === 'storage-activate').length, storageActivationsBefore + 1);
  settingsGroups[1].open = false; settingsGroups[1].fire('toggle');
  assert.equal(calls.at(-1)[0], 'storage-deactivate');
  settingsGroups[1].open = true; settingsGroups[1].fire('toggle');
  assert.equal(calls.filter(([kind]) => kind === 'storage-activate').length, storageActivationsBefore + 2);
  storageDrawer.open = false; storageDrawer.fire('toggle');
  assert.equal(calls.at(-1)[0], 'storage-deactivate');
  const autoHideInput = memoryControls.find(node => node.tag === 'label' && node.children.some(child => child.textContent === '自动隐藏'))?.children.find(node => node.tag === 'input');
  const keepInput = memoryControls.find(node => node.className === 'qqj-auto-hide-row')?.children.find(node => node.tag === 'input');
  assert.equal(autoHideInput?.checked, false); assert.equal(keepInput?.value, '3'); assert.equal(keepInput?.className, 'settings-input settings-num');
  assert.equal(memoryControls.find(node => node.className === 'qqj-auto-hide-row')?.children[0]?.textContent, '保留历史 AI 楼数');
  assert.equal(memoryControls.some(node => node.drawerTitle === '时间推演'), false, '设置仅保普通开关，不再有时间抽屉');
  const timeToggle = memoryControls.find(node => node.id === 'qqj-settings-time');
  assert.equal(timeToggle.tag, 'label'); assert.equal(timeToggle.children[0].textContent, '时间推演');
  assert.equal(timeToggle.children.at(-1).tag, 'input', '时间文字左/开关右');
  const hideToggle = memoryControls.find(node => node.id === 'qqj-settings-auto-hide');
  assert.equal(hideToggle.children[0].textContent, '自动隐藏');
  assert.equal(hideToggle.children.at(-1).tag, 'input', '自动隐藏也应文字左/开关右');
  assert.match(panelCss, /\.qqj-settings-management \.qqj-view-heading>p:not\(\.qqj-page-health\)\{display:none\}/u, '嵌入管理页仅隐藏说明，读取状态保持可见');
  assert.match(panelCss, /#qqj-settings-time,#qqj-settings-auto-hide,#qqj-settings-core-cache\{justify-content:space-between\}/u);
  const memoryHints = memoryControls.filter(node => node.className === 'settings-hint');
  assert.match(memoryHints[0]?.textContent ?? '', /身体状态、周期与期限.*AI 正文.*摘要 API.*当前楼.*近期事项/u);
  assert.match(memoryHints.find(node => /推算时间间隔/u.test(node.textContent))?.textContent ?? '', /推算时间间隔.*当前聊天/u);
  const timeInput = timeToggle.children.find(node => node.tag === 'input');
  let stoppedToggleClick = 0;
  timeToggle.fire('click', { stopPropagation() { stoppedToggleClick += 1; } });
  assert.equal(stoppedToggleClick, 1);
  assert.equal(timeListeners.size, 0); assert.equal(memoryListeners.size, 0);
  assert.equal(timeReads, 0); assert.equal(timeOrganizes, 0, '进入/重绘设置不读取或整理时间');
  timeInput.checked = true; await timeInput.fire('change');
  assert.equal(values.timeEvolutionEnabled, true); assert.equal(timeChanges, 1); assert.equal(timeConfirms.length, 0);
  timeInput.checked = false; await timeInput.fire('change');
  ledgerInjectionEnabled = true;
  timeInput.checked = true; const cancelledTime = timeInput.fire('change');
  assert.equal(timeInput.disabled, true); assert.equal(timeInput.checked, false);
  assert.equal(values.timeEvolutionEnabled, false); assert.equal(timeChanges, 2, '确认前不保存开启或触发任务');
  assert.equal(timeConfirms[0].confirmText, '仍要开启');
  resolveTimeConfirm(false); await cancelledTime;
  assert.equal(timeInput.disabled, false); assert.equal(values.timeEvolutionEnabled, false); assert.equal(timeChanges, 2);
  timeInput.checked = true; const confirmedTime = timeInput.fire('change');
  resolveTimeConfirm(true); await confirmedTime;
  assert.equal(values.timeEvolutionEnabled, true); assert.equal(timeChanges, 3);

  const calendarRow = memoryControls.find(node => node.id === 'qqj-settings-calendar');
  const fourInput = flatten(calendarRow).find(node => node.attributes['aria-label'] === '4个月');
  const twelveInput = flatten(calendarRow).find(node => node.attributes['aria-label'] === '12个月');
  const prefixInput = flatten(settingsGroups[1]).find(node => node.attributes['aria-label'] === '特殊纪年名称');
  assert.ok(memoryControls.indexOf(calendarRow) > memoryControls.indexOf(hideToggle));
  assert.equal(fourInput.checked, false); assert.equal(twelveInput.checked, true);
  fourInput.checked = true;
  const cancelCalendar = fourInput.fire('change');
  assert.equal(twelveInput.checked, false, '等待确认时选择也保持互斥');
  assert.equal(calendarChanges.length, 0, '确认前不保存历法');
  resolveTimeConfirm(false); await cancelCalendar;
  assert.equal(fourInput.checked, false); assert.equal(twelveInput.checked, true);
  prefixInput.value = '启航'; fourInput.checked = true; twelveInput.checked = false;
  const saveCalendar = fourInput.fire('change');
  resolveTimeConfirm(true); await saveCalendar;
  assert.equal(calendarChanges.length, 1);
  assert.equal(savedCalendar.months, 4); assert.equal(savedCalendar.prefix, '启航');
  assert.equal(fourInput.checked, true); assert.equal(twelveInput.checked, false);
  const lateCalendar = twelveInput.fire('change');
  calendarChatId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  resolveTimeConfirm(true); await lateCalendar;
  assert.equal(calendarChanges.length, 1, '等待确认期间切换聊天不能把旧选择保存到新聊天');
  calendarChatId = foundationState.chatId;
  timeInput.checked = false; await timeInput.fire('change');
  assert.equal(values.timeEvolutionEnabled, false); assert.equal(timeConfirms.length, 5, '关闭不确认');
  timeInput.checked = true; const rerenderedTime = timeInput.fire('change');
  panel.openSourceSettings(); resolveTimeConfirm(true); await rerenderedTime;
  assert.equal(values.timeEvolutionEnabled, false); assert.equal(timeChanges, 4, '重绘后旧确认不写入开启');
  assert.match(panelCss, /\.settings-group-body\{[^}]*padding:0 12px 8px 26px/);
  assert.match(panelCss, /\.settings-sub-body\.settings-drawer-list\{gap:0;padding:0 2px\}/);
  assert.match(panelCss, /\.settings-sub>\.settings-sub-summary\{[^}]*padding:8px 2px[^}]*min-height:var\(--qqj-control-height\)/);
  assert.match(panelCss, /\.qqj-storage-management\{display:grid;gap:9px\}/);
  assert.doesNotMatch(panelCss, /\.qqj-storage-management\{[^}]*(?:padding|border-top)/);
  autoHideInput.checked = true; autoHideInput.fire('change'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(autoHideApplies.at(-1).enabled, true); assert.equal(autoHideApplies.at(-1).keepAiCount, 3);
  assert.equal(memoryControls.find(node => node.className?.split?.(' ').includes('settings-result') && /已开启/u.test(node.textContent))?.textContent, '已开启；后续保留最近 3 个 AI 楼，并另留当前回复供重生成；已隐藏楼保持隐藏。');
  keepInput.value = '6'; keepInput.fire('change'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(autoHideApplies.at(-1).enabled, true); assert.equal(autoHideApplies.at(-1).keepAiCount, 6);
  autoHideApplyStatus = 'disabled'; values.pluginEnabled = false; keepInput.value = '7'; keepInput.fire('change'); await new Promise(resolve => setImmediate(resolve));
  assert.match(memoryControls.find(node => node.className?.split?.(' ').includes('settings-result') && /重新启用千千结后生效/u.test(node.textContent))?.textContent ?? '', /重新启用千千结后生效/);
  autoHideApplyStatus = null; values.pluginEnabled = true;
  assert.equal(managementMount?.children[0]?.className, 'qqj-page qqj-management-page', '真实管理视图应挂载在设置页内部');
  body.scrollTop = 18; peopleTab.fire('click');
  assert.equal(body.scrollTop, 39, '从设置返回双丝网时恢复其滚动位置');
  assert.deepEqual(calls.filter(([kind]) => kind === 'mount').at(-1), ['mount', view], '返回内容页应重新挂载到主视图容器');
  assert.equal(apiSettingsDisposals, apiSettingsMounts, '离开设置页必须释放 API 进度订阅');
  assert.equal(wrapperDisposals, wrapperMounts, '离开设置页释放包裹值回显订阅');
  assert.equal(view.children[0]?.className, 'qqj-page qqj-people-page', '返回内容页应移除设置 DOM 并呈现真实内容视图');
  eventTab.fire('click');
  assert.equal(body.scrollTop, 71, '回到千结时恢复千结滚动位置');
  qianchuangTab.fire('click'); body.scrollTop=63;
  assert.ok(calls.some(([kind])=>kind==='window-mount'));
  eventTab.fire('click'); qianchuangTab.fire('click');assert.equal(body.scrollTop,63,'千窗恢复自己的滚动位置');
  qianshiTab.fire('click'); body.scrollTop = 57;
  assert.ok(calls.some(([kind]) => kind === 'qianshi-activate'), '千事必须挂载独立时间线视图');
  eventTab.fire('click');
  assert.equal(body.scrollTop, 71, '从千事返回千结仍恢复千结滚动位置');
  profileTab.fire('click');
  assert.equal(body.scrollTop, 31, '回到千人时恢复进入设置前保存的滚动位置');

  themeButton.fire('click');
  assert.equal(updates.at(-1).appearanceTheme, 'day', '顶部主题按钮应按跟随酒馆、日间、夜间循环并即时保存');
  assert.match(themeSvg.innerHTML, /M12 3v2/); assert.match(themeSvg.innerHTML, /M19 12h2/, '动态日间图标实际图形应覆盖约 3..21 的统一边界');
  themeButton.fire('click');
  assert.equal(updates.at(-1).appearanceTheme, 'night'); assert.match(themeSvg.innerHTML, /M21 15\.5/, '动态夜间图标应与同组按钮图形边界一致');
  fabButton.fire('click');
  assert.equal(updates.at(-1).fabShow, false); assert.equal(fabVisible, false);

  assert.match(panelHtml, /fab-toggle-btn[^>]*>[\s\S]*?<circle cx="12" cy="12" r="9"/);
  assert.match(panelHtml, /class="icon-btn close"[\s\S]*?M3\.5 3\.5l17 17M20\.5 3\.5l-17 17/);
  assert.doesNotMatch(panelHtml, /status-(?:line|dot|label)/, '导航下方不应再渲染重复页名与装饰菱形');
  assert.doesNotMatch(panelCss, /\.status-(?:line|dot|label)\b/, '重复状态行的专用样式应一并删除');
  assert.match(panelCss, /\.icon-btn svg\{[^}]*stroke-width:1\.8[^}]*width:calc\(18px \* var\(--qqj-button-scale,\.85\)\)/);
  assert.doesNotMatch(panelCss, /\.qqj-cse-help\{[^}]*(?:width|height):/u, '信息范围说明使用文字按钮尺寸');
  assert.match(panelCss, /\.qqj-person-summary,\.qqj-section-summary\{[^}]*flex-wrap:wrap/,
    'summary 标题、状态和回执按钮在高倍率或窄面板中应能换行');
  assert.match(panelCss, /\.qqj-person-summary strong,\.qqj-section-summary strong\{[^}]*flex:1 1 8em;min-width:min\(100%,8em\)/,
    'summary 标题应保留可读宽度并允许长标题自然换行');
  assert.match(panelCss, /\.qqj-person-summary>\.v3-memory-status,\.qqj-section-summary>\.v3-memory-status\{[^}]*white-space:normal;overflow-wrap:anywhere/,
    'summary 状态胶囊应在窄宽度下完整换行显示');
  assert.doesNotMatch(panelCss, /@media\(max-width:640px\)[^}]*\.icon-btn\{width:30px/, '手机端不应再次缩小三枚顶部按钮的实际图形或点击框');
  for (const selector of ['topbar', 'panel-resize-handle']) assert.match(panelCss, new RegExp(`\\.${selector}\\{[^}]*touch-action:none`), '触控拖动和缩放仅手柄接管手势');
  assert.match(panelCss, /@media\(max-width:640px\)\{\.panel>\.panel-resize-handle\{display:none\}\}/, '手机把手隐藏规则须覆盖通用 display:grid，避免生成多余底部行');
  assert.doesNotMatch(panelCss, /\.panel:has\(\.qqj-manual-save-bar\)\{background:var\(--panel\)\}/, '编辑页底部不应再绘制整条保存栏背景');
  assert.doesNotMatch(panelCss, /linear-gradient\(to top,var\(--panel\)/, '不得重新引入底部高度拼接接缝');
  assert.match(panelCss, /\.qqj-api-editor>\.settings-sub-body>\.sub-advanced\+\.qqj-manual-save-bar\{margin-top:calc\(-1 \* var\(--qqj-space-group\)\)\}/, '高级设置和 API 按钮栏之间抵消父容器 gap，避免重复留白');
  assert.doesNotMatch(panelCss, /\.qqj-profile-switcher\{touch-action:pan-x\}/, '人物横条不得用pan-x-only阻断从条内起步的整页纵向滚动');
  assert.match(panelCss, /\.source-permission-list,.qqj-inline-select-options,.qqj-model-list-items\{touch-action:pan-y\}/, '内部纵向列表应保留自己的原生纵向滚动');
  for (const surface of [
    /\.icon-btn\{[^}]*background:var\(--qqj-control-bg,var\(--qqj-color-surface\)\)/,
    /\.v3-memory-status\{[^}]*background:color-mix\([^}]*var\(--panel\)\)/,
    /\.v3-cse-current\{[^}]*background:color-mix\([^}]*var\(--panel\)\)/,
    /\.qqj-model-list-item\{[^}]*background:var\(--qqj-control-bg,var\(--paper\)\)/,
    /button:disabled\{[^}]*background:var\(--qqj-control-bg,var\(--line\)\)/,
  ]) assert.match(panelCss, surface, '实际绘制表面应以实色 palette 为底');

  const touch = (x, y) => ({ clientX: x, clientY: y });
  const touchEvent = values => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...values });
  const swipeTarget = { closest: () => null };
  let summaryClicks = 0;
  const summaryTarget = { closest: selector => selector.split(',').some(part => part.trim() === 'summary') ? summaryTarget : null, click: () => { summaryClicks += 1; } };
  body.fire('touchstart', touchEvent({ touches: [touch(260, 100)], target: summaryTarget }));
  const summaryMove = touchEvent({ touches: [touch(170, 105)], target: summaryTarget }); body.fire('touchmove', summaryMove);
  const summaryEnd = touchEvent({ changedTouches: [touch(160, 105)], target: summaryTarget }); body.fire('touchend', summaryEnd);
  if (!summaryEnd.defaultPrevented) summaryTarget.click();
  assert.equal(summaryMove.defaultPrevented, true); assert.equal(summaryEnd.defaultPrevented, true); assert.equal(summaryClicks, 0, 'summary 起始的横滑不得合成展开点击');
  assert.equal(panel.getState().activeTab, 'events', 'summary 起始横滑应进入下一个主内容页');
  body.fire('touchstart', touchEvent({ touches: [touch(120, 100)], target: summaryTarget }));
  const summaryTapEnd = touchEvent({ changedTouches: [touch(122, 100)], target: summaryTarget }); body.fire('touchend', summaryTapEnd);
  if (!summaryTapEnd.defaultPrevented) summaryTarget.click();
  assert.equal(summaryClicks, 1, '横滑结束后的下一次真实轻触仍应展开 summary');

  let buttonClicks = 0;
  const buttonTarget = { closest: selector => selector.split(',').some(part => part.trim() === 'button') ? buttonTarget : null, click: () => { buttonClicks += 1; } };
  body.fire('touchstart', touchEvent({ touches: [touch(260, 100)], target: buttonTarget }));
  const buttonEnd = touchEvent({ changedTouches: [touch(160, 105)], target: buttonTarget }); body.fire('touchend', buttonEnd);
  if (!buttonEnd.defaultPrevented) buttonTarget.click();
  assert.equal(buttonEnd.defaultPrevented, true); assert.equal(buttonClicks, 0, '按钮起始的横滑不得触发业务点击');
  assert.equal(panel.getState().activeTab, 'qianshi', '按钮起始横滑应进入千事');
  body.fire('touchstart', touchEvent({ touches: [touch(120, 100)], target: buttonTarget }));
  const buttonTapEnd = touchEvent({ changedTouches: [touch(120, 100)], target: buttonTarget }); body.fire('touchend', buttonTapEnd);
  if (!buttonTapEnd.defaultPrevented) buttonTarget.click();
  assert.equal(buttonClicks, 1, '同一按钮后续真实轻触不得被吞');

  body.fire('touchstart', { touches: [touch(260, 100)], target: swipeTarget });
  body.fire('touchend', { changedTouches: [touch(160, 105)], target: swipeTarget });
  assert.equal(panel.getState().activeTab, 'qianchuang', '第三次左滑应进入千窗');
  assert.ok(calls.some(([kind])=>kind==='window-activate'),'千窗使用独立view');
  body.fire('touchstart', { touches: [touch(260,100)], target:swipeTarget });
  body.fire('touchend', { changedTouches:[touch(160,105)], target:swipeTarget });
  assert.equal(panel.getState().activeTab,'people','第四次左滑应进入双丝网');
  body.fire('touchstart', { touches: [touch(260, 100)], target: swipeTarget });
  body.fire('touchend', { changedTouches: [touch(160, 105)], target: swipeTarget });
  assert.equal(panel.getState().screen, 'settings', '第四次左滑应进入设置页');
  const settingsInputTarget = { closest: selector => selector.includes('input') ? {} : null };
  body.fire('touchstart', { touches: [touch(100, 100)], target: settingsInputTarget });
  body.fire('touchend', { changedTouches: [touch(200, 105)], target: settingsInputTarget });
  assert.equal(panel.getState().screen, 'settings', '设置页输入控件应保留自身触摸，不触发切页');
  const inlineSelectTarget = { closest: selector => selector.includes('.qqj-inline-select') ? {} : null };
  body.fire('touchstart', { touches: [touch(100, 100)], target: inlineSelectTarget });
  body.fire('touchend', { changedTouches: [touch(220, 105)], target: inlineSelectTarget });
  assert.equal(panel.getState().screen, 'settings', '内联选择器横向操作应保留自身手势，不触发切页');
  body.fire('touchstart', { touches: [touch(100, 100)], target: swipeTarget });
  body.fire('touchend', { changedTouches: [touch(200, 105)], target: swipeTarget });
  assert.equal(panel.getState().activeTab, 'people'); assert.equal(panel.getState().screen, 'content', '设置页右滑应回到双丝网');
  body.fire('touchstart', { touches: [touch(200, 100)], target: swipeTarget });
  const verticalMove = touchEvent({ touches: [touch(190, 190)], target: swipeTarget }); body.fire('touchmove', verticalMove);
  const verticalEnd = touchEvent({ changedTouches: [touch(185, 220)], target: swipeTarget }); body.fire('touchend', verticalEnd);
  assert.equal(verticalMove.defaultPrevented, false); assert.equal(verticalEnd.defaultPrevented, false, '纯纵向手势不得被QQJ横滑监听器取消');
  assert.equal(panel.getState().activeTab, 'people', '纵向滚动不得误触主 tab 切页');
  body.fire('touchstart', touchEvent({ touches: [touch(220, 100)], target: swipeTarget }));
  body.fire('touchmove', touchEvent({ touches: [touch(190, 103)], target: swipeTarget }));
  body.fire('touchcancel', touchEvent({ changedTouches: [touch(190, 103)], target: swipeTarget }));
  body.fire('touchend', touchEvent({ changedTouches: [touch(100, 104)], target: swipeTarget }));
  assert.equal(panel.getState().activeTab, 'people', '取消后的旧手势不得残留并触发切页');
  const profileStripTarget = { closest: selector => selector.includes('.qqj-profile-switcher') ? {} : null };
  body.fire('touchstart', { touches: [touch(260, 100)], target: profileStripTarget });
  body.fire('touchend', { changedTouches: [touch(100, 100)], target: profileStripTarget });
  assert.equal(panel.getState().activeTab, 'people', '人物横滑条应保留自身原生手势');
  const relationStripTarget = { closest: selector => selector.includes('.qqj-relation-switcher') ? {} : null };
  body.fire('touchstart', touchEvent({ touches: [touch(260, 100)], target: relationStripTarget }));
  const relationMove = touchEvent({ touches: [touch(170, 102)], target: relationStripTarget }); body.fire('touchmove', relationMove);
  const relationEnd = touchEvent({ changedTouches: [touch(100, 103)], target: relationStripTarget }); body.fire('touchend', relationEnd);
  assert.equal(relationMove.defaultPrevented, false); assert.equal(relationEnd.defaultPrevented, false, '关系人物横条应保留原生横向滚动，不得被QQJ全局横滑取消');
  assert.equal(panel.getState().activeTab, 'people', '关系人物横条横拖不得触发主 tab 切页');

  rejectFoundationActivation = true;
  settingsTab.fire('click'); await new Promise(resolve => setImmediate(resolve));
  const failedSettingsPage = view.children[0];
  const managementError = failedSettingsPage.children.find(node => node.className === 'v3-foundation-feedback error');
  assert.equal(managementError?.hidden, false); assert.match(managementError?.textContent ?? '', /记忆管理暂时无法读取/);
  assert.equal(failedSettingsPage.children.some(node => node.className === 'master-switch'), true, '记忆管理加载异常不得重建或丢失设置表单');
  rejectFoundationActivation = false;
  const calendarChangesBeforeUnavailable = calendarChanges.length;
  const readyCalendarChatId = calendarChatId, readyCalendar = savedCalendar;
  calendarChatId = null; savedCalendar = null;
  panel.setEnabled(false);
  await panel.show();
  const unavailableSettingsPage = view.children[0];
  assert.equal(unavailableSettingsPage?.className, 'settings-page');
  assert.ok(unavailableSettingsPage.children.some(node => node.className === 'master-switch'), '关闭或无聊天时仍显示总开关');
  const unavailableCalendarInputs = flatten(unavailableSettingsPage).filter(node => ['4个月', '12个月', '特殊纪年名称'].includes(node.attributes?.['aria-label']));
  assert.equal(unavailableCalendarInputs.length, 3);
  assert.ok(unavailableCalendarInputs.every(node => node.disabled === true), '身份不可用时仅禁用聊天历法控件');
  assert.ok(flatten(unavailableSettingsPage).some(node => node.textContent === '教程文档'), '全局设置和教程仍可显示');
  calendarChatId = readyCalendarChatId; savedCalendar = readyCalendar;
  panel.setEnabled(true);
  await panel.show();
  const readyCalendarInputs = flatten(view.children[0]).filter(node => ['4个月', '12个月', '特殊纪年名称'].includes(node.attributes?.['aria-label']));
  assert.ok(readyCalendarInputs.every(node => node.disabled === false), '聊天身份恢复后历法可编辑');
  assert.equal(calendarChanges.length, calendarChangesBeforeUnavailable, '打开或恢复设置页不得保存历法');
  profileTab.fire('click'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.getState().activeTab, 'profiles');
  const profileDeactivationsBeforeClose = calls.filter(([kind]) => kind === 'profiles-deactivate').length;

  for (const flags of [{ defaultPrevented: true }, { isComposing: true }]) {
    documentEvents.keydown({ key: 'Escape', ...flags });
    assert.equal(panel.getState().open, true, '已消费或组字中的Escape不关闭主面板');
  }

  dialogActive = true;
  documentEvents.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(dialogCancels, 1); assert.equal(panel.getState().open, true, 'Esc 应先关顶层自绘弹窗，不连带关闭面板');
  documentEvents.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(panel.getState().open, false);
  assert.equal(calls.filter(([kind]) => kind === 'profiles-deactivate').length, profileDeactivationsBeforeClose + 1, '从千人关闭时必须停用人物视图');
  await panel.show();
  body.fire('touchend', touchEvent({ changedTouches: [touch(80, 100)], target: swipeTarget }));
  assert.equal(panel.getState().activeTab, 'profiles'); assert.equal(panel.getState().screen, 'content', '重新打开后千人视图仍能正常激活，且不沿用关闭前的横滑状态');
  panel.close();
  await panel.show(); settingsTab.fire('click');
  assert.equal(timeReads, 0); assert.equal(timeOrganizes, 0);
  assert.equal(flatten(view).some(node => node.textContent === '整理时间事项' || node.textContent === '追踪事项清单'), false);
  assert.equal(timeListeners.size, 0); assert.equal(memoryListeners.size, 0);
  values.timeEvolutionEnabled = false;
  const closedTimeInput = flatten(view).find(node => node.id === 'qqj-settings-time').children.find(node => node.tag === 'input');
  closedTimeInput.checked = true; const closedTime = closedTimeInput.fire('change');
  panel.close(); await closedTime;
  assert.equal(apiSettingsDisposals, apiSettingsMounts, '关闭面板释放最后一个 API 进度订阅');
  assert.equal(wrapperDisposals, wrapperMounts, '关闭面板释放最后一个包裹值回显订阅');
  assert.ok(transferViews.length > 0 && transferViews.every(value => value.disposed), '切页、重绘与关闭均销毁导入导出视图');
  assert.equal(values.timeEvolutionEnabled, false); assert.equal(timeChanges, 4, '关面板取消确认，不开启时间推演');
  assert.equal(timeListeners.size, 0); assert.equal(memoryListeners.size, 0, '关面板解除时间与记忆订阅');
  panel.showStatus('保留模块错误空态');
  assert.equal(view.children[0]?.className, 'empty-state'); assert.equal(view.children[0]?.children[1]?.textContent, '保留模块错误空态', '删除小行后 showStatus 错误空态仍须保留');
  await panel.show(); settingsTab.fire('click');
  assert.ok(flatten(view.children[0]).some(node => node.id === 'qqj-settings-core-cache'), 'SillyTavern设置页显示缓存开关');
  eventTab.fire('click'); tauriTavern = true; settingsTab.fire('click');
  const ttCacheToggle = flatten(view.children[0]).find(node => node.id === 'qqj-settings-core-cache');
  assert.ok(ttCacheToggle, 'TT也显示同一core缓存开关');
  const ttCacheInput = flatten(ttCacheToggle).find(node => node.tag === 'input');
  ttCacheInput.checked = true; ttCacheInput.fire('change');
  assert.equal(values.coreCacheEnabled, true, 'TT可用现有设置选择启用缓存');
});


function panelGeometryFixture({ width = 1200, height = 900, chat = { left: 200, top: 60, width: 800, height: 720 }, visual = null, saved = {} } = {}) {
  const eventTarget = () => {
    const listeners = new Map();
    return {
      addEventListener(name, listener) { listeners.set(name, listener); },
      removeEventListener(name) { listeners.delete(name); },
      fire(name, event = {}) { listeners.get(name)?.(event); },
    };
  };
  const preferences = new Map(Object.entries(saved).map(([key, value]) => [key, JSON.stringify(value)]));
  const writes = [];
  const storage = { getItem: key => preferences.get(key), setItem(key, value) { writes.push([key, value]); preferences.set(key, value); } };
  const resizeObservers = [];
  const viewport = { ...eventTarget(), innerWidth: width, innerHeight: height,
    ResizeObserver: class { constructor(callback) { resizeObservers.push(callback); } observe() {} disconnect() {} },
    ...(visual ? { visualViewport: { ...eventTarget(), ...visual } } : {}) };
  const variables = new Map();
  const panel = { style: { setProperty: (key, value) => variables.set(key, value) }, classList: { add() {}, remove() {} },
    getBoundingClientRect() { return Object.fromEntries(['left', 'top', 'width', 'height'].map(key => [key, Number.parseFloat(this.style[key]) || 0])); } };
  const dragHandle = eventTarget(), resizeHandle = eventTarget();
  const nodes = { chat: { getBoundingClientRect: () => chat } };
  const documentRef = { getElementById: key => nodes[key] ?? null };
  const controller = createPanelGeometryController({ panel, dragHandle, resizeHandle, viewport, storage, documentRef });
  return { controller, panel, viewport, dragHandle, resizeHandle, variables, writes, nodes, resizeObservers, resizeChat: () => resizeObservers.forEach(callback => callback()), setChat: value => { chat = value; } };
}

test('主面板桌面恢复、拖动和调整尺寸使用整个可视视口及偏移', () => {
  const f = panelGeometryFixture({ visual: { offsetLeft: 100, offsetTop: 120, width: 900, height: 420 },
    saved: { [PANEL_SIZE_KEY]: { width: 1000, height: 900 }, [PANEL_POSITION_KEY]: { left: -40, top: 1000 } } });
  assert.deepEqual(f.panel.getBoundingClientRect(), { left: 110, top: 130, width: 880, height: 400 });
  assert.equal(f.writes.length, 0, '自动clamp保留原桌面偏好');
  f.dragHandle.fire('pointerdown', { pointerId: 1, clientX: 300, clientY: 150 });
  f.dragHandle.fire('pointermove', { pointerId: 1, clientX: 1800, clientY: 1500 });
  f.dragHandle.fire('pointerup', { pointerId: 1 });
  assert.deepEqual(f.panel.getBoundingClientRect(), { left: 110, top: 130, width: 880, height: 400 });
  f.resizeHandle.fire('pointerdown', { pointerId: 2, clientX: 990, clientY: 530 });
  f.resizeHandle.fire('pointermove', { pointerId: 2, clientX: 1800, clientY: 1500 });
  f.resizeHandle.fire('pointerup', { pointerId: 2 });
  assert.deepEqual(f.panel.getBoundingClientRect(), { left: 110, top: 130, width: 880, height: 400 });
  assert.deepEqual(f.writes.map(([key]) => key), [PANEL_POSITION_KEY, PANEL_SIZE_KEY]);
  f.controller.destroy();
});

test('主面板手机仅随可视视口变化，聊天区不影响尺寸且恢复不写桌面偏好', () => {
  const f = panelGeometryFixture({ width: 390, height: 844, chat: { left: 0, top: 50, width: 390, height: 700 },
    visual: { offsetLeft: 0, offsetTop: 100, width: 390, height: 500 } });
  assert.deepEqual(Object.fromEntries(f.variables), { '--qqj-panel-bounds-left': '0px', '--qqj-panel-bounds-top': '100px', '--qqj-panel-bounds-width': '390px', '--qqj-panel-bounds-height': '500px' });
  f.viewport.visualViewport.height = 300;
  f.viewport.visualViewport.fire('resize');
  assert.equal(f.variables.get('--qqj-panel-bounds-height'), '300px');
  f.viewport.visualViewport.offsetTop = 150;
  f.viewport.visualViewport.fire('scroll');
  assert.equal(f.variables.get('--qqj-panel-bounds-top'), '150px');
  f.setChat({ left: 10, top: 180, width: 370, height: 150 });
  f.viewport.fire('resize');
  assert.equal(f.variables.get('--qqj-panel-bounds-top'), '150px');
  assert.equal(f.variables.get('--qqj-panel-bounds-height'), '300px');
  assert.equal(f.writes.length, 0);
  f.controller.destroy();
});

test('390和320手机仅留视口边距，聊天和输入变化不调整面板', () => {
  for (const width of [390, 320]) {
    const f = panelGeometryFixture({ width, height: 844, chat: { left: 10, top: 50, width: width - 20, height: 700 } });
    assert.deepEqual(mobilePanelRect(width, 844), { left: 10, right: 10, width: width - 20, top: 20, height: 764, bottom: 60 });
    const bounds = Object.fromEntries(f.variables);
    f.setChat({ left: 10, top: 300, width: 100, height: 50 });
    f.nodes.form_sheld = { getBoundingClientRect: () => ({ top: 350, height: 400 }) };
    f.resizeChat(); f.controller.restore();
    assert.deepEqual(Object.fromEntries(f.variables), bounds);
    assert.equal(f.resizeObservers.length, 0, '不监听聊天区的尺寸');
    assert.equal(f.writes.length, 0);
    f.viewport.innerHeight = 400; f.viewport.fire('resize');
    assert.equal(f.variables.get('--qqj-panel-bounds-height'), '400px');
    assert.deepEqual(mobilePanelRect(width, 400, 10, 5), { left: 10, right: 10, width: width - 20, top: 20, height: 320, bottom: 60 });
    assert.deepEqual(mobilePanelRect(width, 400, 30, 25), { left: 10, right: 10, width: width - 20, top: 30, height: 320, bottom: 50 });
    assert.deepEqual(mobilePanelRect(width, 400, 50, 45), { left: 10, right: 10, width: width - 20, top: 50, height: 305, bottom: 45 });
    f.controller.destroy();
  }
});

test('桌面默认固定360×600，聊天区变化不移动窗口或中断拖动', () => {
  assert.equal(desktopPanelSize(1200, 700).height, 600);
  const f = panelGeometryFixture({ height: 700 });
  assert.deepEqual(f.panel.getBoundingClientRect(), { left: 820, top: 70, width: 360, height: 600 });
  const original = f.panel.getBoundingClientRect();
  f.setChat({ left: 500, top: 300, width: 200, height: 100 });
  f.resizeChat();
  assert.deepEqual(f.panel.getBoundingClientRect(), original);
  assert.equal(f.writes.length, 0);
  f.dragHandle.fire('pointerdown', { pointerId: 1, clientX: 830, clientY: 90 });
  f.resizeChat();
  f.dragHandle.fire('pointermove', { pointerId: 1, clientX: 20, clientY: 20 });
  f.dragHandle.fire('pointerup', { pointerId: 1 });
  assert.deepEqual(f.panel.getBoundingClientRect(), { left: 10, top: 10, width: 360, height: 600 });
  f.controller.restore();
  assert.deepEqual(f.panel.getBoundingClientRect(), { left: 10, top: 10, width: 360, height: 600 }, '重开恢复聊天区外的位置');
  f.controller.destroy();
});

test('桌面四向拖动及缩放可越过聊天区，浏览器缩小时仅临时clamp', () => {
  const f = panelGeometryFixture({ width: 1400, height: 1000, chat: { left: 500, top: 300, width: 400, height: 400 } });
  for (const [x, y, left, top] of [[-2000, 0, 10, 70], [4000, 0, 1030, 70], [0, -2000, 1030, 10], [0, 4000, 1030, 390]]) {
    f.dragHandle.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0 });
    f.dragHandle.fire('pointermove', { pointerId: 1, clientX: x, clientY: y });
    f.dragHandle.fire('pointerup', { pointerId: 1 });
    assert.deepEqual(f.panel.getBoundingClientRect(), { left, top, width: 360, height: 600 });
    f.controller.restore();
    assert.equal(f.panel.getBoundingClientRect().left, left);
    assert.equal(f.panel.getBoundingClientRect().top, top);
  }
  f.dragHandle.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0 });
  f.dragHandle.fire('pointermove', { pointerId: 1, clientX: -4000, clientY: -4000 });
  f.dragHandle.fire('pointerup', { pointerId: 1 });
  f.resizeHandle.fire('pointerdown', { pointerId: 2, clientX: 0, clientY: 0 });
  f.resizeHandle.fire('pointermove', { pointerId: 2, clientX: 650, clientY: 150 });
  f.resizeHandle.fire('pointerup', { pointerId: 2 });
  assert.deepEqual(f.panel.getBoundingClientRect(), { left: 10, top: 10, width: 1010, height: 750 });
  f.setChat({ left: 650, top: 450, width: 100, height: 50 });
  f.resizeChat(); f.controller.restore();
  assert.deepEqual(f.panel.getBoundingClientRect(), { left: 10, top: 10, width: 1010, height: 750 });
  const writes = f.writes.length;
  f.viewport.innerWidth = 700; f.viewport.innerHeight = 400; f.viewport.fire('resize');
  assert.deepEqual(f.panel.getBoundingClientRect(), { left: 10, top: 10, width: 680, height: 380 });
  f.viewport.innerWidth = 1400; f.viewport.innerHeight = 1000; f.viewport.fire('resize');
  assert.deepEqual(f.panel.getBoundingClientRect(), { left: 10, top: 10, width: 1010, height: 750 });
  assert.equal(f.writes.length, writes, '自动clamp不覆盖手动尺寸');
  f.controller.destroy();
});


test('手机再上抬10px受安全区约束，桌面默认与已存拖动位置沿原几何', async () => {
  assert.deepEqual(mobilePanelRect(390, 844, 44, 0), { left: 10, right: 10, width: 370, top: 44, height: 760, bottom: 40 });
  assert.deepEqual(mobilePanelRect(390, 844, 35, 25), { left: 10, right: 10, width: 370, top: 35, height: 764, bottom: 45 });
  assert.deepEqual(mobilePanelRect(390, 844, 50, 45), { left: 10, right: 10, width: 370, top: 50, height: 749, bottom: 45 });
  const fresh = panelGeometryFixture();
  for (let count = 0; count < 3; count += 1) { fresh.controller.restore(); assert.equal(fresh.panel.getBoundingClientRect().top, 70); }
  assert.equal(fresh.writes.length, 0); fresh.controller.destroy();
  const saved = panelGeometryFixture({ saved: { [PANEL_POSITION_KEY]: { left: 250, top: 155 } } });
  for (let count = 0; count < 3; count += 1) { saved.controller.restore(); assert.equal(saved.panel.getBoundingClientRect().top, 155); }
  assert.equal(saved.writes.length, 0); saved.controller.destroy();
  const source = await readFile(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  assert.ok(source.includes('top:calc(var(--qqj-panel-bounds-top,0px) + max(20px,env(safe-area-inset-top,0px)))'));
});


test('主宿主补偿文档包含块原点，滚动后仍保持原视口坐标', () => {
  const f = panelGeometryFixture();
  let origin = { left: -40, top: -500 };
  const host = { style: {}, getBoundingClientRect() {
    const values = this.style.transform?.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/);
    return { left: origin.left + Number(values?.[1] ?? 0), top: origin.top + Number(values?.[2] ?? 0) };
  } };
  f.panel.getRootNode = () => ({ host });
  f.controller.restore();
  assert.deepEqual(host.getBoundingClientRect(), { left: 0, top: 0 });
  assert.deepEqual(f.panel.getBoundingClientRect(), { left: 820, top: 70, width: 360, height: 600 });
  origin = { left: -90, top: -750 };
  f.viewport.fire('scroll');
  assert.deepEqual(host.getBoundingClientRect(), { left: 0, top: 0 });
  assert.equal(f.writes.length, 0);
  f.controller.destroy();
  origin = { left: -100, top: -900 }; f.viewport.fire('scroll');
  assert.notDeepEqual(host.getBoundingClientRect(), { left: 0, top: 0 }, '销毁配对解除文档滚动监听');
});
