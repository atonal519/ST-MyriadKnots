import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSettingsStore } from '../src/settings.js';

const configuredUi = id => ({ id, name: id, url: `https://${id}.example.test/v1`, key: `${id.toUpperCase()}_KEY`, model: `${id}-model`, excludeParams: [], timeoutSec: 30, stream: false });

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
  focus() { this.focused = true; }
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
    for (const [name, tag] of [['enabled', 'input'], ['api-preset', 'select'], ['utility-preset', 'select'], ['url', 'input'], ['key', 'input'], ['model', 'input'], ['exclude', 'textarea'], ['timeout', 'input'], ['stream', 'input']]) add(`[data-setting="${name}"]`, tag);
    for (const action of ['key-toggle', 'key-clear', 'preset-new', 'preset-update', 'preset-rename', 'preset-delete', 'save', 'test', 'models']) add(`[data-action="${action}"]`, 'button');
    add('.settings-result'); add('.model-results');
    const drawer = add('.settings-drawer', 'details'), subdrawer = add('.settings-subdrawer', 'details');
    drawer.open = /class="settings-drawer" open/.test(this.markup); subdrawer.open = /class="settings-subdrawer" open/.test(this.markup);
  }
  attachShadow() {
    const root = new Node('shadow-root'); this.shadowRoot = root; return root;
  }
}

test('真实 dist 设置 UI：共享完整预设双向读写、Key 默认不驻留 DOM、无来源标签且 test/models 同一选择', async () => {
  const previousDocument = globalThis.document, previousPrompt = globalThis.prompt, previousConfirm = globalThis.confirm, previousAddEventListener = globalThis.addEventListener; const extensionSettings = { qianqianjie: { pluginEnabled: false, apiMode: 'seven-preset', selectedSevenDaysPresetId: 'utility' }, 'schedule-planner': { utilityPresetId: 'utility', unknownTop: 'KEEP', apiPresets: [{ id: 'utility', name: '默认写作', url: 'https://api.example.test/v1', key: 'INHERITED_KEY', model: 'small-model', excludeParams: ['seed'], timeoutSec: 30, stream: false, unknownPreset: 'KEEP' }, { id: 'people', name: '人物识别', url: 'https://people.example.test/v1', key: 'PEOPLE_KEY', model: 'people-model', excludeParams: [], timeoutSec: 30, stream: false }] } };
  const settings = createSettingsStore({ extensionSettings, save() {} }); let formalReads = 0, peopleReads = 0, describeReads = 0, tests = 0, models = 0, enabledChanges = 0; const hosts = [];
  const documentRef = { activeElement: null, body: { append: node => hosts.push(node) }, getElementById: () => null, addEventListener() {}, createElement: tag => new Node(tag) };
  const promptedNames = ['抽屉预设', '抽屉预设已改名'], globalListeners = {}; globalThis.document = documentRef; globalThis.prompt = () => promptedNames.shift(); globalThis.confirm = () => true; globalThis.addEventListener = (name, fn) => { (globalListeners[name] ||= []).push(fn); };
  try {
    const { bootstrap } = await import('../dist/index.js?real-settings-ui=1'); let wandOpen;
    const apiTools = {
      describe: () => { describeReads += 1; return { source: 'shared-preset', sourceLabel: '不得进入 DOM 的来源', sevenDaysPresets: settings.sharedPresets() }; },
      testConnection: async selection => { tests += 1; assert.deepEqual(selection, { apiMode: 'seven-preset', selectedSevenDaysPresetId: 'people' }); return { ok: true, model: 'people-model' }; },
      fetchModels: async selection => { models += 1; assert.deepEqual(selection, { apiMode: 'seven-preset', selectedSevenDaysPresetId: 'people' }); return ['a-model', 'b-model']; },
    };
    const instance = bootstrap({ settings, apiTools, formal: { getFormalState: async () => { formalReads += 1; return { status: 'ready' }; } }, people: { getPeople: async () => { peopleReads += 1; return { status: 'ready' }; } }, documentRef, wandInstaller: open => { wandOpen = open; }, onPluginEnabledChange: async enabled => { enabledChanges += 1; assert.equal(enabled, true); } });
    wandOpen({}); await new Promise(resolve => setImmediate(resolve)); assert.equal(formalReads, 0); assert.equal(peopleReads, 0);
    const root = instance.host.shadowRoot, view = root.nodes['.view']; const openSettings = view.querySelector('.open-settings'); assert.ok(openSettings); await openSettings.fire('click');
    const apiPreset = view.nodes['[data-setting="api-preset"]'];
    assert.ok(describeReads >= 1); assert.deepEqual(apiPreset.children.map(item => [item.value, item.textContent]), [['', '主配置'], ['utility', '默认写作'], ['people', '人物识别']]); assert.equal(apiPreset.value, 'utility');
    const utilityPreset = view.nodes['[data-setting="utility-preset"]'];
    assert.deepEqual(utilityPreset.children.map(item => [item.value, item.textContent]), [['', '跟随主 API'], ['utility', '默认写作'], ['people', '人物识别']]); assert.equal(utilityPreset.value, 'utility');
    assert.match(view.markup, /副 API（记忆扫描）/);
    settings.upsertSharedPreset('外部新增', configuredUi('external'), 'external'); globalListeners.focus.at(-1)();
    assert.equal(view.nodes['[data-setting="api-preset"]'].children.some(item => item.value === 'external' && item.textContent === '外部新增'), true);
    const keyInput = view.nodes['[data-setting="key"]']; assert.equal(keyInput.type, 'password'); assert.equal(keyInput.value, ''); assert.equal(`${view.markup}\n${view.textContent}`.includes('INHERITED_KEY'), false);
    await view.nodes['[data-action="key-toggle"]'].fire('click'); assert.equal(keyInput.type, 'text'); assert.equal(keyInput.value, 'INHERITED_KEY'); await view.nodes['[data-action="key-toggle"]'].fire('click'); assert.equal(keyInput.type, 'password'); assert.equal(keyInput.value, '');
    assert.doesNotMatch(`${view.markup}\n${view.textContent}`, /API 来源|当前请求来源|继承来源|自动继承构画|构画预设|构画机械预设|构画配置只读继承|手动选择|本地预设|千千结本地 API|酒馆|不得进入 DOM 的来源/); assert.equal(view.nodes['[data-setting="source"]'], undefined);
    assert.match(view.markup, /<span>预设<\/span>/); assert.match(view.markup, />保存 API 配置<\/button>/);
    assert.equal(view.nodes['[data-action="test"]'].disabled, true); assert.equal(view.nodes['[data-action="models"]'].disabled, true);
    assert.match(view.markup, /<details class="settings-drawer"><summary><span>基础通用设置/); assert.match(view.markup, /<details class="settings-subdrawer"><summary><span>API/);
    const focusSelector = 'button,input,select,textarea,summary,[href],[tabindex]:not([tabindex="-1"])', generalSummary = new Node('summary'); generalSummary.textContent = '基础通用设置';
    const focusOrder = [root.nodes['.settings-btn'], root.nodes['.close'], ...root.nodeLists['.tab'], view.nodes['[data-setting="enabled"]'], generalSummary]; root.nodeLists[focusSelector] = focusOrder;
    let prevented = false; root.activeElement = view.nodes['[data-setting="enabled"]']; await root.events.keydown[0]({ key: 'Tab', preventDefault: () => { prevented = true; } }); assert.equal(prevented, false); assert.equal(focusOrder[0].focused, undefined);
    root.activeElement = generalSummary; await root.events.keydown[0]({ key: 'Tab', preventDefault: () => { prevented = true; } }); assert.equal(prevented, true); assert.equal(focusOrder[0].focused, true);
    await view.nodes['[data-action="test"]'].fire('click'); await view.nodes['[data-action="models"]'].fire('click'); assert.equal(tests + models, 0); assert.equal(view.nodes['.settings-result'].textContent, '');
    view.nodes['.settings-drawer'].open = true; view.nodes['.settings-subdrawer'].open = true;
    view.nodes['[data-setting="api-preset"]'].value = 'people'; await view.nodes['[data-setting="api-preset"]'].fire('change');
    view.nodes['[data-setting="utility-preset"]'].value = 'people'; await view.nodes['[data-setting="utility-preset"]'].fire('change');
    assert.equal(view.nodes['[data-setting="url"]'].value, 'https://people.example.test/v1'); assert.equal(view.nodes['[data-setting="model"]'].value, 'people-model'); assert.equal(view.nodes['[data-setting="key"]'].value, '');
    view.nodes['[data-setting="model"]'].value = 'people-model-edited'; view.nodes['[data-setting="enabled"]'].checked = true; await view.nodes['[data-action="save"]'].fire('click'); assert.equal(settings.isEnabled(), true); assert.equal(enabledChanges, 1);
    assert.equal(extensionSettings.qianqianjie.apiMode, 'seven-preset'); assert.equal(extensionSettings.qianqianjie.selectedSevenDaysPresetId, 'people'); assert.equal(view.nodes['[data-setting="api-preset"]'].value, 'people');
    assert.equal(settings.sharedUtilityPresetId(), 'people'); assert.equal(view.nodes['[data-setting="utility-preset"]'].value, 'people');
    assert.equal(settings.sharedPresets().find(item => item.id === 'people').model, 'people-model-edited'); assert.equal(extensionSettings['schedule-planner'].unknownTop, 'KEEP'); assert.equal(settings.sharedPresets().find(item => item.id === 'utility').unknownPreset, 'KEEP');
    assert.equal(view.nodes['.settings-drawer'].open, true); assert.equal(view.nodes['.settings-subdrawer'].open, true);
    await view.nodes['[data-action="test"]'].fire('click'); assert.equal(tests, 1); assert.match(view.nodes['.settings-result'].textContent, /连接成功/);
    await view.nodes['[data-action="models"]'].fire('click'); assert.equal(models, 1); assert.equal(view.nodes['.model-results'].children.length, 2); await view.nodes['.model-results'].children[1].fire('click'); assert.equal(view.nodes['[data-setting="model"]'].value, 'b-model');
    view.nodes['[data-setting="utility-preset"]'].value = ''; await view.nodes['[data-action="save"]'].fire('click'); assert.equal(settings.sharedUtilityPresetId(), ''); assert.equal(view.nodes['[data-setting="utility-preset"]'].value, '');
    extensionSettings['schedule-planner'].utilityPresetId = 'missing'; globalListeners.focus.at(-1)(); assert.equal(view.nodes['[data-setting="utility-preset"]'].value, '');
    await view.nodes['[data-action="preset-update"]'].fire('click'); assert.equal(settings.sharedPresets().find(item => item.id === 'people').model, 'b-model');
    await view.nodes['[data-action="preset-new"]'].fire('click'); const created = settings.get().selectedSevenDaysPresetId; assert.ok(created); assert.equal(settings.sharedPresets().find(item => item.id === created).name, '抽屉预设');
    await view.nodes['[data-action="preset-rename"]'].fire('click'); assert.equal(settings.sharedPresets().find(item => item.id === created).name, '抽屉预设已改名');
    await view.nodes['[data-action="preset-delete"]'].fire('click'); assert.equal(settings.sharedPresets().some(item => item.id === created), false); assert.equal(settings.get().apiMode, 'auto');
    assert.equal(view.nodes['.settings-drawer'].open, true); assert.equal(view.nodes['.settings-subdrawer'].open, true);
    await root.nodes['.settings-btn'].fire('click'); assert.equal(root.nodeLists['.tab'][0].className.includes('active'), true);
  } finally { globalThis.document = previousDocument; globalThis.prompt = previousPrompt; globalThis.confirm = previousConfirm; globalThis.addEventListener = previousAddEventListener; }
});

test('真实 dist 将设置放在标题栏、缩放把手固定右下角，并保留手机紧凑布局', async () => {
  const source = await readFile(new URL('../src/ui/panel.html', import.meta.url), 'utf8'), dist = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /<footer/); assert.match(source, /<header[\s\S]*settings-btn[\s\S]*close[\s\S]*<\/header>/); assert.match(source, /settings-btn[\s\S]*panel-resize-handle/); assert.match(source, /aria-label="打开千千结设置"/); assert.match(source, /aria-label="关闭"/);
  assert.equal((source.match(/panel-resize-handle/g) || []).length, 1); assert.equal((source.match(/settings-btn/g) || []).length, 1); assert.equal((source.match(/<svg/g) || []).length, 2);
  assert.match(dist, /settings-btn/); assert.match(dist, /grid-template-columns:minmax\(0,1fr\)/); assert.match(dist, /new-password/); assert.match(dist, /panel-resize-handle/); assert.match(dist, /position:absolute/); assert.match(dist, /@media ?(?:\(max-width:640px\)|\(width<=640px\))[^{]*\{[\s\S]*panel-resize-handle\{display:none/);
});

test('源 CSS 与真实 dist 同时保留主体主题和设置样式，防止整段覆盖', async () => {
  const css = await readFile(new URL('../src/ui/panel.css', import.meta.url), 'utf8');
  const dist = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8');
  for (const token of ['--panel:', '--panel-2:', '--ink:', '--soft:', '--faint:', '--line:', '--crimson:']) {
    assert.ok(css.includes(token), `源 CSS 缺少主题变量 ${token}`);
    assert.ok(dist.includes(token), `dist 缺少主题变量 ${token}`);
  }
  for (const selector of ['.topbar', '.brand', '.mark', '.status-line', '.empty', '.choice', '.module', '.people-list', '.person-card', '.settings-btn', '.settings-view', '.settings-drawer', '.settings-subdrawer', '.resize-grip']) {
    assert.ok(css.includes(selector), `源 CSS 缺少选择器 ${selector}`);
    assert.ok(dist.includes(selector), `dist 缺少选择器 ${selector}`);
  }
  assert.match(css, /:host\{text-shadow:none!important;isolation:isolate!important\}/); assert.doesNotMatch(css, /filter:none|backdrop-filter:none|mix-blend-mode:normal/);
  assert.equal((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length);
});

test('焦点陷阱包含可见 summary，关闭设置抽屉时只有从真实末项才回绕', async () => {
  const source = await readFile(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  assert.match(source, /querySelectorAll\('button,input,select,textarea,summary,\[href\],\[tabindex\]:not\(\[tabindex="-1"\]\)'\)/);
});
