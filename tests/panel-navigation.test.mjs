import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { createV3FoundationView } from '../src/ui/v3-foundation-view.js';

class Node {
  constructor(tag = 'div') {
    this.tag = tag; this.children = []; this.listeners = {}; this.hidden = false; this.scrollTop = 0; this.dataset = {}; this.className = ''; this.textContent = '';
    this.classList = { toggle() {} };
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  fire(name) { return this.listeners[name]?.(); }
  setAttribute() {}
  focus() {}
}

test('真实面板入口按千人/千结/双丝网/设置映射视图，并恢复各页滚动位置', async () => {
  const source = await readFile(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const calls = [];
  const panelNode = new Node('section'), body = new Node('main'), view = new Node('div'), label = new Node('span');
  const topbar = new Node('header'), resize = new Node('button'), close = new Node('button'), settingsButton = new Node('button');
  const profileTab = new Node('button'), eventTab = new Node('button'), peopleTab = new Node('button'); profileTab.dataset.tab = 'profiles'; eventTab.dataset.tab = 'events'; peopleTab.dataset.tab = 'people';
  const nodeMap = new Map([['.panel', panelNode], ['.body', body], ['.view', view], ['.status-label', label], ['.topbar', topbar], ['.panel-resize-handle', resize], ['.close', close], ['.settings-btn', settingsButton]]);
  const root = { innerHTML: '', querySelector: selector => nodeMap.get(selector) ?? null, querySelectorAll: selector => selector === '.tab' ? [profileTab, eventTab, peopleTab] : [] };
  const host = new Node('host'); host.attachShadow = () => root;
  let firstElement = true;
  const documentRef = { defaultView: {}, body: new Node('body'), createElement(tag) { if (firstElement) { firstElement = false; return host; } return new Node(tag); }, addEventListener() {} };
  const drawer = () => { const node = new Node('details'), drawerBody = new Node('div'); node.append(drawerBody); return { drawer: node, body: drawerBody }; };
  const modules = {
    './panel.html?raw': { default: '' }, './panel.css?inline': { default: '' },
    './layout.js': { createPanelGeometryController: () => ({ restore() {}, cancelGesture() {} }) },
    './appearance.js': { applyAppearance() {} },
    './settings-drawer.js': { createSettingsDrawer: drawer, createSettingsDrawerState: () => ({ open() {}, set() {}, isOpen: (_key, fallback) => fallback }) },
    './settings/api-settings.js': { createApiSettings: () => ({ node: new Node() }) },
    './settings/prompts-settings.js': { createPromptsSettings: () => ({ node: new Node() }) },
    './settings/appearance-settings.js': { createAppearanceSettings: () => ({ node: new Node() }) },
    '../settings.js': { applyPluginEnabledImmediately: async ({ enabled }) => ({ enabled, stale: false }) },
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
  const v3FoundationView = {
    setPage(value) { calls.push(['page', value]); actualFoundationView.setPage(value); },
    mount(target) { calls.push(['mount', target]); actualFoundationView.mount(target); },
    activate() { return actualFoundationView.activate(); },
    deactivate() { calls.push(['deactivate']); actualFoundationView.deactivate(); },
  };
  const peopleProfilesView = {
    mount(target) { calls.push(['profiles-mount', target]); target.replaceChildren(new Node('profiles')); },
    async activate() { calls.push(['profiles-activate']); return { status: 'ready' }; },
    deactivate() { calls.push(['profiles-deactivate']); },
  };
  const settings = { isEnabled: () => true, get: () => ({ pluginEnabled: true }), update(value) { return value; } };
  const panel = entry.namespace.createPanel({ settings, v3FoundationView, peopleProfilesView, documentRef });

  await panel.show();
  assert.ok(calls.some(([kind]) => kind === 'profiles-activate'));
  body.scrollTop = 31; eventTab.fire('click');
  assert.equal(body.scrollTop, 0); assert.deepEqual(calls.filter(([kind]) => kind === 'page').at(-1), ['page', 'memories']);
  body.scrollTop = 71; peopleTab.fire('click');
  assert.equal(body.scrollTop, 0); assert.deepEqual(calls.at(-1), ['page', 'people']);
  body.scrollTop = 39; settingsButton.fire('click');
  assert.ok(calls.some(([kind, value]) => kind === 'page' && value === 'management'));
  assert.equal(view.children[0]?.className, 'settings-page', '设置页应真实占据面板内容容器');
  assert.equal(view.children[0]?.children.some(node => node.className === 'master-switch'), true, '设置首开不得被真实 setPage 重绘清掉总开关');
  assert.equal(view.children[0]?.children.filter(node => node.tag === 'details').length, 1, '设置首开只保留通用设置，周期设置已移除');
  const managementMount = view.children[0]?.children.find(node => node.className === 'qqj-settings-management');
  assert.equal(managementMount?.children[0]?.className, 'qqj-page qqj-management-page', '真实管理视图应挂载在设置页内部');
  body.scrollTop = 18; settingsButton.fire('click');
  assert.equal(body.scrollTop, 39, '从设置返回双丝网时恢复其滚动位置');
  assert.deepEqual(calls.filter(([kind]) => kind === 'mount').at(-1), ['mount', view], '返回内容页应重新挂载到主视图容器');
  assert.equal(view.children[0]?.className, 'qqj-page qqj-people-page', '返回内容页应移除设置 DOM 并呈现真实内容视图');
  eventTab.fire('click');
  assert.equal(body.scrollTop, 71, '回到千结时恢复千结滚动位置');
  profileTab.fire('click');
  assert.equal(body.scrollTop, 31, '回到千人时恢复千人滚动位置');
});
