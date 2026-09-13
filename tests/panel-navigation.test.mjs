import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { createV3FoundationView } from '../src/ui/v3-foundation-view.js';
import { openHelpGuide } from '../src/ui/help-guide.js';
import { publicErrorMessage } from '../src/public-error.js';

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
  querySelector() { return null; }
  focus() {}
}
const flatten = node => [node, ...(node.children ?? []).flatMap(flatten)];

test('真实面板入口按千人/千结/双丝网/设置映射视图，并恢复各页滚动位置', async () => {
  const [source, panelHtml, panelCss] = await Promise.all([
    readFile(new URL('../src/ui/panel.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/panel.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/panel.css', import.meta.url), 'utf8'),
  ]);
  const calls = [];
  const panelNode = new Node('section'), body = new Node('main'), view = new Node('div');
  const topbar = new Node('header'), resize = new Node('button'), close = new Node('button'), themeButton = new Node('button'), fabButton = new Node('button');
  const themeSvg = new Node('svg'); themeButton.querySelector = selector => selector === 'svg' ? themeSvg : null;
  const profileTab = new Node('button'), eventTab = new Node('button'), peopleTab = new Node('button'), settingsTab = new Node('button'); profileTab.dataset.tab = 'profiles'; eventTab.dataset.tab = 'events'; peopleTab.dataset.tab = 'people'; settingsTab.dataset.tab = 'settings';
  const nodeMap = new Map([['.panel', panelNode], ['.body', body], ['.view', view], ['.topbar', topbar], ['.panel-resize-handle', resize], ['.close', close], ['.theme-btn', themeButton], ['.fab-toggle-btn', fabButton]]);
  const root = { innerHTML: '', querySelector: selector => nodeMap.get(selector) ?? null, querySelectorAll: selector => selector === '.tab' ? [profileTab, eventTab, peopleTab, settingsTab] : [] };
  const host = new Node('host'); host.attachShadow = () => root;
  let firstElement = true;
  const documentEvents = {};
  const documentRef = { defaultView: { innerWidth: 390, matchMedia: () => ({ matches: true }) }, body: new Node('body'), createElement(tag) { if (firstElement) { firstElement = false; return host; } return new Node(tag); }, addEventListener(name, listener) { documentEvents[name] = listener; } };
  const drawerState = new Map();
  const drawer = ({ title, open = false, onToggle, id } = {}) => {
    const node = new Node('details'), drawerBody = new Node('div');
    node.drawerTitle = title; node.id = id; node.open = open; node.addEventListener('toggle', () => onToggle?.(node.open)); node.append(drawerBody);
    return { drawer: node, body: drawerBody };
  };
  const diagnostics = { starts: 0, stops: 0, marks: 0, records: [{ page: 'settings', defaultPrevented: false }] };
  const modules = {
    './panel.html?raw': { default: '' }, './panel.css?inline': { default: '' },
    './layout.js': { createPanelGeometryController: () => ({ restore() {}, cancelGesture() {} }) },
    './appearance.js': { createAppearanceController: ({ onChange }) => { const state = { mode: 'auto', effectiveTheme: 'day', palette: {} }; onChange?.(state); return { apply() { onChange?.(state); return state; }, getState: () => state, destroy() {} }; } },
    './settings-drawer.js': { createSettingsDrawer: drawer, createSettingsDrawerState: () => ({ open(key) { drawerState.set(key, true); }, set(key, value) { drawerState.set(key, value); }, isOpen: (key, fallback) => drawerState.has(key) ? drawerState.get(key) : fallback }) },
    './settings/api-settings.js': { createApiSettings: () => ({ node: new Node() }) },
    './settings/prompts-settings.js': { createPromptsSettings: () => ({ node: new Node() }) },
    './settings/appearance-settings.js': { createAppearanceSettings: () => ({ node: new Node() }) },
    './scroll-diagnostics.js': { createScrollDiagnostics: () => ({ start() { diagnostics.starts += 1; }, stop() { diagnostics.stops += 1; }, markQqjSwipeIntercepted() { diagnostics.marks += 1; }, snapshot: () => ({ schemaVersion: 1, records: diagnostics.records }) }) },
    './help-guide.js': { openHelpGuide },
    '../settings.js': { applyPluginEnabledImmediately: async ({ enabled }) => ({ enabled, stale: false }) },
    '../public-error.js': { publicErrorMessage },
  };
  const context = createContext({ console });
  const entry = new SourceTextModule(source, { context, identifier: new URL('../src/ui/panel.js', import.meta.url).href });
  await entry.link(specifier => new SyntheticModule(Object.keys(modules[specifier]), function initialize() { for (const [name, value] of Object.entries(modules[specifier])) this.setExport(name, value); }, { context, identifier: specifier }));
  await entry.evaluate();
  const foundationState = {
    status: 'ready', pluginEnabled: true, chatId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', foundationStatus: 'ready',
    stableCount: 0, rememberedCount: 0, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null,
    headCheckpointId: null, activeRun: null, activeExtraction: null, activeCse: null, lastRun: null, lastError: null,
    lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, cseReady: false, csePendingCount: 0,
    cseFailedCount: 0, baselineId: null, cseSubjects: [], floors: [], rebuildStatus: 'caughtUp',
  };
  const foundationRuntime = { getState: () => foundationState, refreshStatus: async () => foundationState, confirmLatest: async () => foundationState };
  const actualFoundationView = createV3FoundationView({ runtime: foundationRuntime, documentRef });
  let rejectFoundationActivation = false;
  const v3FoundationView = {
    setPage(value) { calls.push(['page', value]); actualFoundationView.setPage(value); },
    mount(target) { calls.push(['mount', target]); actualFoundationView.mount(target); },
    activate() { return rejectFoundationActivation ? Promise.reject(new Error('management offline')) : actualFoundationView.activate(); },
    deactivate() { calls.push(['deactivate']); actualFoundationView.deactivate(); },
  };
  const peopleProfilesView = {
    mount(target) { calls.push(['profiles-mount', target]); target.replaceChildren(new Node('profiles')); },
    async activate() { calls.push(['profiles-activate']); return { status: 'ready' }; },
    deactivate() { calls.push(['profiles-deactivate']); },
  };
  const values = { pluginEnabled: true, appearanceTheme: 'auto', fabShow: true, autoHideEnabled: false, autoHideKeepAiCount: 3 };
  const updates = [];
  const settings = { isEnabled: () => true, get: () => values, update(value) { Object.assign(values, value); updates.push(value); return value; } };
  let fabVisible = true, dialogActive = false, dialogCancels = 0, helpDialog = null, clipboardFail = false;
  const clipboardWrites = [];
  const autoHideApplies = [];
  let autoHideApplyStatus = null;
  const panel = entry.namespace.createPanel({ settings, v3FoundationView, peopleProfilesView, documentRef, navigatorRef: { clipboard: { async writeText(value) { clipboardWrites.push(value); if (clipboardFail) throw new Error('clipboard denied'); } } }, dialog: { setAppearance() {}, custom(options) { helpDialog = options; dialogActive = true; return Promise.resolve(true); }, closeAll() { dialogActive = false; }, hasActive: () => dialogActive, cancelTop() { dialogCancels += 1; dialogActive = false; } }, onFabShowChange: value => { fabVisible = value; }, onAutoHideChange: async value => { autoHideApplies.push(value); return autoHideApplyStatus ? { status: autoHideApplyStatus } : undefined; } });

  await panel.show();
  assert.equal(diagnostics.starts, 1); assert.match(root.innerHTML, /\.body\{[^}]*touch-action:pan-y/);
  assert.deepEqual(JSON.parse(panel.getUiDiagnostic()).records, diagnostics.records);
  assert.ok(calls.some(([kind]) => kind === 'profiles-activate'));
  body.scrollTop = 31; eventTab.fire('click');
  assert.equal(body.scrollTop, 0); assert.deepEqual(calls.filter(([kind]) => kind === 'page').at(-1), ['page', 'memories']);
  body.scrollTop = 71; peopleTab.fire('click');
  assert.equal(body.scrollTop, 0); assert.deepEqual(calls.at(-1), ['page', 'people']);
  body.scrollTop = 39; settingsTab.fire('click');
  assert.ok(calls.some(([kind, value]) => kind === 'page' && value === 'management'));
  assert.equal(view.children[0]?.className, 'settings-page', '设置页应真实占据面板内容容器');
  assert.equal(view.children[0]?.children.some(node => node.className === 'master-switch'), true, '设置首开不得被真实 setPage 重绘清掉总开关');
  const settingsGroups = view.children[0]?.children.filter(node => node.tag === 'details');
  assert.deepEqual(settingsGroups.map(node => node.drawerTitle), ['通用设置', '记忆设置', '教程与配置文件'], '设置页应有三个同级大抽屉');
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
  assert.equal(helpSections.length, 8); assert.equal(helpSections[0].open, true); assert.ok(helpSections.slice(1).every(node => node.open === false));
  assert.match(flatten(helpDialog.content).map(node => node.textContent).join('|'), /保留包裹符.*清洗包裹符.*人物状态重构/);
  dialogActive = false;
  const copyExample = flatten(documentation).find(node => node.tag === 'button' && node.textContent === '复制接口示例');
  copyExample.fire('click'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(clipboardWrites.length, 1); assert.match(clipboardWrites[0], /globalThis\.qqj_v3_public_bridge_v1/);
  assert.match(flatten(documentation).map(node => node.textContent).join('|'), /已复制/);
  clipboardFail = true; copyExample.fire('click'); await new Promise(resolve => setImmediate(resolve));
  let fallback = flatten(documentation).find(node => node.className === 'v3-diagnostic-fallback');
  assert.equal(fallback?.readOnly, true); assert.match(fallback?.value ?? '', /getSnapshot\(\)/);
  documentation.open = true; documentation.fire('toggle');
  await panel.show();
  const rerenderedPage = view.children[0], rerenderedDocumentation = rerenderedPage.children.filter(node => node.tag === 'details').at(-1);
  assert.equal(rerenderedDocumentation.drawerTitle, '教程与配置文件'); assert.equal(rerenderedDocumentation.open, true);
  fallback = flatten(rerenderedDocumentation).find(node => node.className === 'v3-diagnostic-fallback');
  assert.match(fallback?.value ?? '', /globalThis\.qqj_v3_public_bridge_v1/, '设置页重绘后保留手动复制文本');
  const memoryControls = settingsGroups[1].children[0].children;
  const autoHideInput = memoryControls.find(node => node.tag === 'label')?.children.find(node => node.tag === 'input');
  const keepInput = memoryControls.find(node => node.className === 'qqj-auto-hide-row')?.children.find(node => node.tag === 'input');
  assert.equal(autoHideInput?.checked, false); assert.equal(keepInput?.value, '3'); assert.equal(keepInput?.className, 'settings-input settings-num');
  assert.equal(memoryControls.find(node => node.className === 'qqj-auto-hide-row')?.children[0]?.textContent, '保留最近 AI 楼数');
  assert.equal(memoryControls.find(node => node.className === 'settings-hint'), undefined, '不展示固定解释，仍保留设置结果反馈');
  assert.match(panelCss, /\.settings-group-body\{[^}]*padding:0 12px 8px 26px/);
  assert.match(panelCss, /\.settings-sub-body\.settings-drawer-list\{gap:0;padding:0 2px\}/);
  assert.match(panelCss, /\.settings-sub>\.settings-sub-summary\{[^}]*min-height:36px;padding:8px 2px/);
  autoHideInput.checked = true; autoHideInput.fire('change'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(autoHideApplies.at(-1).enabled, true); assert.equal(autoHideApplies.at(-1).keepAiCount, 3);
  assert.equal(memoryControls.find(node => node.className?.split?.(' ').includes('settings-result'))?.textContent, '已开启；后续按最近 3 个 AI 楼保留，已隐藏楼保持隐藏。');
  keepInput.value = '6'; keepInput.fire('change'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(autoHideApplies.at(-1).enabled, true); assert.equal(autoHideApplies.at(-1).keepAiCount, 6);
  autoHideApplyStatus = 'disabled'; values.pluginEnabled = false; keepInput.value = '7'; keepInput.fire('change'); await new Promise(resolve => setImmediate(resolve));
  assert.match(memoryControls.find(node => node.className?.split?.(' ').includes('settings-result'))?.textContent ?? '', /重新启用千千结后生效/);
  autoHideApplyStatus = null; values.pluginEnabled = true;
  assert.equal(managementMount?.children[0]?.className, 'qqj-page qqj-management-page', '真实管理视图应挂载在设置页内部');
  body.scrollTop = 18; peopleTab.fire('click');
  assert.equal(body.scrollTop, 39, '从设置返回双丝网时恢复其滚动位置');
  assert.deepEqual(calls.filter(([kind]) => kind === 'mount').at(-1), ['mount', view], '返回内容页应重新挂载到主视图容器');
  assert.equal(view.children[0]?.className, 'qqj-page qqj-people-page', '返回内容页应移除设置 DOM 并呈现真实内容视图');
  eventTab.fire('click');
  assert.equal(body.scrollTop, 71, '回到千结时恢复千结滚动位置');
  profileTab.fire('click');
  assert.equal(body.scrollTop, 31, '回到千人时恢复千人滚动位置');

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
  assert.match(panelCss, /\.icon-btn svg\{width:18px;height:18px;[^}]*stroke-width:1\.8/);
  assert.doesNotMatch(panelCss, /@media\(max-width:640px\)[^}]*\.icon-btn\{width:30px/, '手机端不应再次缩小三枚顶部按钮的实际图形或点击框');
  assert.doesNotMatch(panelCss, /\.qqj-profile-switcher\{touch-action:pan-x\}/, '人物横条不得用pan-x-only阻断从条内起步的整页纵向滚动');
  assert.match(panelCss, /\.source-permission-list,.qqj-inline-select-options,.qqj-model-list-items\{touch-action:pan-y\}/, '内部纵向列表应保留自己的原生纵向滚动');
  for (const surface of [
    /\.icon-btn\{[^}]*background:var\(--panel\)/,
    /\.v3-memory-status\{[^}]*background:color-mix\([^}]*var\(--panel\)\)/,
    /\.v3-cse-current\{[^}]*background:color-mix\([^}]*var\(--panel\)\)/,
    /\.qqj-model-list-item\{[^}]*background:var\(--paper\)/,
    /button:disabled\{[^}]*background:var\(--line\)/,
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
  assert.ok(diagnostics.marks >= 2, 'QQJ横滑每次preventDefault都应显式标记给诊断模块');
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
  assert.equal(panel.getState().activeTab, 'people', '按钮起始横滑应进入双丝网');
  body.fire('touchstart', touchEvent({ touches: [touch(120, 100)], target: buttonTarget }));
  const buttonTapEnd = touchEvent({ changedTouches: [touch(120, 100)], target: buttonTarget }); body.fire('touchend', buttonTapEnd);
  if (!buttonTapEnd.defaultPrevented) buttonTarget.click();
  assert.equal(buttonClicks, 1, '同一按钮后续真实轻触不得被吞');

  body.fire('touchstart', { touches: [touch(260, 100)], target: swipeTarget });
  body.fire('touchend', { changedTouches: [touch(160, 105)], target: swipeTarget });
  assert.equal(panel.getState().screen, 'settings', '第三次左滑应进入设置页');
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
  profileTab.fire('click'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.getState().activeTab, 'profiles');
  const profileDeactivationsBeforeClose = calls.filter(([kind]) => kind === 'profiles-deactivate').length;

  dialogActive = true;
  documentEvents.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(dialogCancels, 1); assert.equal(panel.getState().open, true, 'Esc 应先关顶层自绘弹窗，不连带关闭面板');
  documentEvents.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(panel.getState().open, false);
  assert.equal(calls.filter(([kind]) => kind === 'profiles-deactivate').length, profileDeactivationsBeforeClose + 1, '从千人关闭时必须停用人物视图');
  assert.equal(diagnostics.stops, 1, '关闭面板应停止采集但由诊断模块保留既有记录');
  await panel.show();
  body.fire('touchend', touchEvent({ changedTouches: [touch(80, 100)], target: swipeTarget }));
  assert.equal(panel.getState().activeTab, 'profiles'); assert.equal(panel.getState().screen, 'content', '重新打开后千人视图仍能正常激活，且不沿用关闭前的横滑状态');
  panel.close(); assert.equal(diagnostics.starts, 3, '含一次设置页重绘核对与关闭后的重新打开'); assert.equal(diagnostics.stops, 2);
  panel.showStatus('保留模块错误空态');
  assert.equal(view.children[0]?.className, 'empty-state'); assert.equal(view.children[0]?.children[1]?.textContent, '保留模块错误空态', '删除小行后 showStatus 错误空态仍须保留');
});
