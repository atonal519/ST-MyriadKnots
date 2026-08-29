import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSettingsStore } from '../src/settings.js';

class Node {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.events = {}; this.style = {}; this.dataset = {}; this.attributes = {}; this.className = ''; this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this.offsetParent = {}; this.type = tag === 'input' ? 'text' : '';
    this.classList = { toggle: (name, enabled) => { const set = new Set(this.className.split(/\s+/).filter(Boolean)); enabled ? set.add(name) : set.delete(name); this.className = [...set].join(' '); } };
  }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; this._text = undefined; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
  async fire(name, event = {}) { if (name === 'click' && this.disabled) return; event.currentTarget ||= this; event.target ||= this; for (const fn of this.events[name] || []) await fn(event); }
  focus() {}
  descendants() { return this.children.flatMap(item => item instanceof Node ? [item, ...item.descendants()] : []); }
  querySelector(selector) { return this.nodes?.[selector] || this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    if (this.nodeLists?.[selector]) return this.nodeLists[selector];
    if (selector.startsWith('.')) return this.descendants().filter(item => item.className.split(/\s+/).includes(selector.slice(1)));
    return [];
  }
  get textContent() { return this._text ?? this.children.map(item => item?.textContent ?? '').join(''); }
  set textContent(value) { this._text = String(value); }
  set innerHTML(value) {
    this.markup = String(value); this.children = []; this.nodes = {};
    if (this.markup.includes('qqj-dialog-title')) {
      this.nodes = { '.view': new Node(), '.status-label': new Node(), '.status-meta': new Node(), '.status-dot': new Node(), '.close': new Node('button'), '.settings-btn': new Node('button') };
      this.nodeLists = { '.tab': [new Node('button'), new Node('button'), new Node('button'), new Node('button')] }; this.nodes['.tab'] = this.nodeLists['.tab'][0];
    }
    if (this.markup.includes('settings-view')) this.installSettingsNodes();
    if (this.markup.includes('open-settings')) { const button = new Node('button'); button.className = 'open-settings'; this.nodes['.open-settings'] = button; this.children.push(button); }
  }
  get innerHTML() { return this.markup || ''; }
  installSettingsNodes() {
    const add = (selector, tag = 'div') => { const node = new Node(tag); this.nodes[selector] = node; this.children.push(node); return node; };
    for (const [name, tag] of [['enabled', 'input'], ['source', 'select'], ['local-preset', 'select'], ['url', 'input'], ['key', 'input'], ['model', 'input'], ['exclude', 'textarea'], ['timeout', 'input'], ['stream', 'input']]) add(`[data-setting="${name}"]`, tag);
    for (const action of ['key-toggle', 'key-clear', 'preset-new', 'preset-update', 'preset-rename', 'preset-delete', 'save', 'test', 'models']) add(`[data-action="${action}"]`, 'button');
    add('.api-source-label'); add('.settings-result'); add('.model-results');
  }
  attachShadow() {
    const root = new Node('shadow-root'); this.shadowRoot = root; return root;
  }
}

test('真实 dist 设置 UI：关闭态一步进入、右下角角标、Key 遮罩、连接测试、模型列表和单次重启', async () => {
  const previousDocument = globalThis.document; const extensionSettings = { qianqianjie: { pluginEnabled: false, apiMode: 'auto', apiKey: 'LOCAL_KEY' }, 'schedule-planner': { utilityPresetId: 'utility', apiPresets: [{ id: 'utility', name: '构画机械', url: 'https://api.example.test/v1', key: 'INHERITED_KEY', model: 'small-model', timeoutSec: 30 }] } };
  const settings = createSettingsStore({ extensionSettings, save() {} }); let formalReads = 0, peopleReads = 0, tests = 0, models = 0, enabledChanges = 0; const hosts = [];
  const documentRef = { activeElement: null, body: { append: node => hosts.push(node) }, getElementById: () => null, addEventListener() {}, createElement: tag => new Node(tag) };
  globalThis.document = documentRef;
  try {
    const { bootstrap } = await import('../dist/index.js?real-settings-ui=1'); let wandOpen;
    const apiTools = {
      describe: () => ({ source: 'seven-utility', sourceLabel: '构画机械预设 · 构画机械', configured: true, sevenDaysPresets: [{ id: 'utility', name: '构画机械' }] }),
      testConnection: async selection => { tests += 1; assert.deepEqual(selection, { apiMode: 'auto', selectedSevenDaysPresetId: '' }); return { ok: true, model: 'small-model' }; },
      fetchModels: async () => { models += 1; return ['a-model', 'b-model']; },
    };
    const instance = bootstrap({ settings, apiTools, formal: { getFormalState: async () => { formalReads += 1; return { status: 'ready' }; } }, people: { getPeople: async () => { peopleReads += 1; return { status: 'ready' }; } }, documentRef, wandInstaller: open => { wandOpen = open; }, onPluginEnabledChange: async enabled => { enabledChanges += 1; assert.equal(enabled, true); } });
    wandOpen({}); await new Promise(resolve => setImmediate(resolve)); assert.equal(formalReads, 0); assert.equal(peopleReads, 0);
    const root = instance.host.shadowRoot, view = root.nodes['.view']; const openSettings = view.querySelector('.open-settings'); assert.ok(openSettings); await openSettings.fire('click');
    const keyInput = view.nodes['[data-setting="key"]']; assert.equal(keyInput.type, 'password'); assert.equal(keyInput.value, ''); assert.equal(JSON.stringify(extensionSettings.qianqianjie).includes('INHERITED_KEY'), false);
    await view.nodes['[data-action="key-toggle"]'].fire('click'); assert.equal(keyInput.type, 'text'); assert.equal(keyInput.value, 'LOCAL_KEY'); await view.nodes['[data-action="key-toggle"]'].fire('click'); assert.equal(keyInput.type, 'password'); assert.equal(keyInput.value, '');
    assert.match(view.nodes['.api-source-label'].textContent, /构画机械预设/); assert.equal(view.nodes['[data-action="test"]'].disabled, true); assert.equal(view.nodes['[data-action="models"]'].disabled, true);
    await view.nodes['[data-action="test"]'].fire('click'); await view.nodes['[data-action="models"]'].fire('click'); assert.equal(tests + models, 0); assert.equal(view.nodes['.settings-result'].textContent, '');
    view.nodes['[data-setting="enabled"]'].checked = true; await view.nodes['[data-action="save"]'].fire('click'); assert.equal(settings.isEnabled(), true); assert.equal(enabledChanges, 1); assert.equal(extensionSettings.qianqianjie.apiKey, 'LOCAL_KEY');
    await view.nodes['[data-action="test"]'].fire('click'); assert.equal(tests, 1); assert.match(view.nodes['.settings-result'].textContent, /连接成功/);
    await view.nodes['[data-action="models"]'].fire('click'); assert.equal(models, 1); assert.equal(view.nodes['.model-results'].children.length, 2); await view.nodes['.model-results'].children[1].fire('click'); assert.equal(view.nodes['[data-setting="model"]'].value, 'b-model');
    await root.nodes['.settings-btn'].fire('click'); assert.equal(root.nodeLists['.tab'][0].className.includes('active'), true);
  } finally { globalThis.document = previousDocument; }
});

test('真实 dist 包含右下角设置热区、手机安全区与紧凑设置布局', async () => {
  const source = await readFile(new URL('../src/ui/panel.html', import.meta.url), 'utf8'), dist = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8');
  assert.match(source, /<footer[\s\S]*settings-btn[\s\S]*<\/footer>/); assert.match(dist, /settings-btn/); assert.match(dist, /flex:0 0 36px/); assert.match(dist, /safe-area-inset-bottom/); assert.match(dist, /grid-template-columns:minmax\(0,1fr\)/); assert.match(dist, /new-password/);
});

test('源 CSS 与真实 dist 同时保留主体主题和设置样式，防止整段覆盖', async () => {
  const css = await readFile(new URL('../src/ui/panel.css', import.meta.url), 'utf8');
  const dist = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8');
  for (const token of ['--panel:', '--panel-2:', '--ink:', '--soft:', '--faint:', '--line:', '--crimson:']) {
    assert.ok(css.includes(token), `源 CSS 缺少主题变量 ${token}`);
    assert.ok(dist.includes(token), `dist 缺少主题变量 ${token}`);
  }
  for (const selector of ['.topbar', '.brand', '.mark', '.status-line', '.empty', '.choice', '.module', '.footer', '.people-list', '.person-card', '.settings-btn', '.settings-view']) {
    assert.ok(css.includes(selector), `源 CSS 缺少选择器 ${selector}`);
    assert.ok(dist.includes(selector), `dist 缺少选择器 ${selector}`);
  }
  assert.equal((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length);
});
