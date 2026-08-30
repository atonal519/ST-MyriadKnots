import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPanelGeometryController, desktopPanelPosition, desktopPanelSize, mobilePanelRect } from '../src/ui/layout.js';

class FakeButton {
  constructor() { this.events = {}; this.disabled = false; }
  addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
  fire(name, event = {}) { for (const fn of this.events[name] || []) fn(event); }
  setPointerCapture() {}
  releasePointerCapture() {}
}
class FakeHost {
  constructor() { this.style = {}; this.button = new FakeButton(); this.shadowRoot = null; }
  attachShadow() { this.shadowRoot = { innerHTML: '', querySelector: () => this.button }; return this.shadowRoot; }
  getBoundingClientRect() { return { left: Number.parseFloat(this.style.left) || 0, top: Number.parseFloat(this.style.top) || 700, width: 36, height: 36 }; }
}

function installDom({ width = 900, height = 700, saved = null } = {}) {
  const listeners = {}; const store = new Map(saved ? [['qqj-fab-pos', JSON.stringify(saved)]] : []);
  globalThis.innerWidth = width; globalThis.innerHeight = height;
  globalThis.matchMedia = query => ({ matches: query.includes('540') && width <= 540 });
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  globalThis.addEventListener = (name, fn) => { (listeners[name] ||= []).push(fn); };
  globalThis.removeEventListener = () => {};
  globalThis.document = { createElement: () => new FakeHost() };
  return { listeners, store };
}

test('FAB 0/2/5px 仍点击，严格超过5px才拖动且拖动阻止 click', async () => {
  installDom(); const { createFab } = await import('../src/ui/fab.js'); let clicks = 0; const fab = createFab({ onClick: () => clicks++ }); const event = (x, y) => ({ clientX: x, clientY: y, pointerId: 1, preventDefault() { this.prevented = true; } });
  for (const delta of [0, 2, 5]) { fab.button.fire('pointerdown', event(100, 100)); fab.button.fire('pointermove', event(100 + delta, 100)); fab.button.fire('pointerup', event(100 + delta, 100)); fab.button.fire('click', event(100 + delta, 100)); }
  assert.equal(clicks, 3);
  fab.button.fire('pointerdown', event(100, 100)); const move = event(106, 100); fab.button.fire('pointermove', move); assert.equal(move.prevented, true); fab.button.fire('pointerup', event(106, 100)); fab.button.fire('click', event(106, 100)); assert.equal(clicks, 3);
});

test('FAB pointercancel 清理手势且 touch-action none', async () => {
  installDom(); const { createFab } = await import('../src/ui/fab.js'); let clicks = 0; const fab = createFab({ onClick: () => clicks++ }); assert.match(fab.root.innerHTML, /touch-action:none/); const e = (x, y) => ({ clientX: x, clientY: y, pointerId: 1, preventDefault() {} });
  fab.button.fire('pointerdown', e(1, 1)); fab.button.fire('pointermove', e(20, 1)); fab.button.fire('pointercancel'); fab.button.fire('click', e(20, 1)); assert.equal(clicks, 1);
});

test('FAB 仅桌面消费位置，移动端清除 inline 位置并按36px clamp', async () => {
  installDom({ saved: { x: 900, y: 700 } }); const { createFab } = await import('../src/ui/fab.js'); const fab = createFab(); assert.equal(fab.host.style.left, '864px'); assert.equal(fab.host.style.top, '664px');
  globalThis.innerWidth = 400; globalThis.innerHeight = 600; fab.onResize(); assert.equal(fab.host.style.left, ''); assert.equal(fab.host.style.top, 'calc(100dvh - 80px - 44px)'); assert.equal(fab.host.style.right, '14px');
});

test('构建产物可隔离加载且正式入口保留宿主桥接', async () => {
  const dist = await import('../dist/index.js?ui-seam=1');
  assert.equal(typeof dist.bootstrap, 'function');
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(source, /\.\/dist\/index\.js/);
  assert.doesNotMatch(await readFile(new URL('../dist/index.js', import.meta.url), 'utf8'), /personas\.js|\.\.\/\.\.\//);
});

test('正式 SVG、dialog 语义、来源徽标和 manifest 均在生产源中', async () => {
  const fab = await readFile(new URL('../src/ui/fab.js', import.meta.url), 'utf8');
  const panel = await readFile(new URL('../src/ui/panel.html', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.match(fab, /viewBox="0 0 64 64"/); assert.match(fab, /currentColor/); assert.match(panel, /role="dialog"/); assert.match(panel, /aria-modal="true"/); assert.match(panel, /source-badge/); assert.doesNotMatch(manifest.description, /无视觉 UI/);
});

test('生产构建包含桌面/手机窗口壳与独立正文滚动约束', async () => {
  const dist = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8');
  assert.match(dist, /width:720px/); assert.match(dist, /top:40px/); assert.match(dist, /right:20px/); assert.match(dist, /height:min\(780px,calc\(100dvh - 80px\)\)/);
  assert.match(dist, /pointer-events:none/); assert.match(dist, /pointer-events:auto/); assert.match(dist, /100dvw/); assert.match(dist, /safe-area-inset-top/); assert.match(dist, /border-radius:14px/); assert.match(dist, /min-height:0/); assert.match(dist, /overflow-y:auto/); assert.doesNotMatch(dist, /cssText="position:fixed;inset:0/); assert.doesNotMatch(dist, /@keyframes in\{from\{opacity:0;transform/);
});

test('生产入口保持初始隐藏，只有显式 show 打开且关闭退出命中测试', async () => {
  const bootstrap = await readFile(new URL('../src/bootstrap.js', import.meta.url), 'utf8');
  const panel = await readFile(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  assert.match(panel, /host\.hidden = true/); assert.match(bootstrap, /panel\.host\.style\.display = 'none'/); assert.match(bootstrap, /panel\.host\.style\.display = 'block'/); assert.match(panel, /host\.hidden = false/); assert.match(panel, /host\.hidden = true/); assert.match(panel, /aria-hidden/); assert.doesNotMatch(bootstrap, /setState\([^)]*show/);
  assert.match(panel, /renaming: '正在恢复人物改名'/); assert.match(panel, /上次改名尚未完成/); assert.match(bootstrap, /'renaming'/); assert.match(bootstrap, /人物改名恢复发生冲突/);
});

test('人物列表使用 DOM textContent/dataset，不把人物字段拼进 innerHTML', async () => {
  const panel = await readFile(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  assert.match(panel, /name\.textContent\s*=\s*item\.displayName/);
  assert.match(panel, /actionButton\('改名',\s*'edit',\s*item\.identityId\)/);
  assert.match(panel, /button\.dataset\[action\]\s*=\s*identityId/);
  assert.doesNotMatch(panel, /safeText\(item\.displayName\)/);
  assert.doesNotMatch(panel, /data-edit=.{0,30}safeText/);
});

test('手机窗口纯布局 seam 在320/390宽视口左右各10px，短屏仍保留 body 滚动', async () => {
  for (const [width, height] of [[320, 640], [390, 844]]) { const rect = mobilePanelRect(width, height); assert.equal(rect.left, 10); assert.equal(rect.width, width - 20); assert.equal(rect.right, 10); assert.equal(rect.top, 20); assert.equal(rect.height, height - 40); }
  const safe = mobilePanelRect(320, 640, 24, 12); assert.equal(safe.top, 44); assert.equal(safe.bottom, 32); assert.equal(safe.height, 564);
  const dist = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8'); assert.match(dist, /grid-template-rows:auto auto minmax\(0,1fr\) auto/); assert.match(dist, /\.body\{min-height:0/);
});

class GeometryTarget {
  constructor() { this.events = {}; }
  addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
  removeEventListener(name, fn) { this.events[name] = (this.events[name] || []).filter(item => item !== fn); }
  fire(name, event = {}) { for (const fn of this.events[name] || []) fn({ pointerId: 1, button: 0, clientX: 0, clientY: 0, target: this, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...event }); }
  setPointerCapture() { this.captured = true; }
  releasePointerCapture() { this.captured = false; }
  closest() { return null; }
}

class GeometryPanel extends GeometryTarget {
  constructor(viewport) {
    super(); this.viewport = viewport; this.style = {};
    const classes = new Set(); this.classList = { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) };
  }
  get offsetWidth() { return Number.parseFloat(this.style.width) || 0; }
  get offsetHeight() { return Number.parseFloat(this.style.height) || 0; }
  getBoundingClientRect() {
    const width = this.offsetWidth, height = this.offsetHeight;
    const left = this.style.left !== '' && this.style.left !== undefined ? Number.parseFloat(this.style.left) || 0 : this.viewport.innerWidth - width - (Number.parseFloat(this.style.right) || 0);
    return { left, top: Number.parseFloat(this.style.top) || 0, width, height };
  }
}

function geometryHarness({ width = 1920, height = 1080, saved = {} } = {}) {
  const store = new Map(Object.entries(saved));
  const viewport = new GeometryTarget(); viewport.innerWidth = width; viewport.innerHeight = height;
  let frameId = 0; const frames = new Map();
  viewport.requestAnimationFrame = fn => { const id = ++frameId; frames.set(id, fn); return id; };
  viewport.cancelAnimationFrame = id => frames.delete(id);
  viewport.flush = () => { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(); };
  const panel = new GeometryPanel(viewport), dragHandle = new GeometryTarget(), resizeHandle = new GeometryTarget();
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  const controller = createPanelGeometryController({ panel, dragHandle, resizeHandle, storage, viewport });
  return { controller, panel, dragHandle, resizeHandle, storage, store, viewport };
}

test('桌面几何覆盖 1920、1366 与 641，损坏和越界偏好安全回退或 clamp', () => {
  assert.deepEqual(desktopPanelSize(1920, 1080), { width: 720, height: 780, minWidth: 500, minHeight: 420, maxWidth: 1900, maxHeight: 1060 });
  assert.deepEqual(desktopPanelSize(1366, 768), { width: 720, height: 688, minWidth: 500, minHeight: 420, maxWidth: 1346, maxHeight: 748 });
  assert.deepEqual(desktopPanelSize(641, 700), { width: 621, height: 620, minWidth: 500, minHeight: 420, maxWidth: 621, maxHeight: 680 });
  assert.deepEqual(desktopPanelSize(1366, 768, { width: -1, height: '坏值' }).width, 720);
  assert.deepEqual(desktopPanelSize(1366, 768, { width: 9999, height: 9999 }).width, 1346);
  assert.deepEqual(desktopPanelPosition(1366, 768, 720, 688, { left: -900, top: 9999 }), { left: 10, top: 70 });
  const corrupt = geometryHarness({ saved: { 'qqj-panel-size': '{坏 JSON', 'qqj-panel-pos': '{坏 JSON' } }); assert.equal(corrupt.panel.style.width, '720px'); assert.equal(corrupt.panel.style.top, '40px');
});

test('桌面拖动仅主键且排除控件，超过 5px 才拖；cancel/lost capture 清理且位置不越界', () => {
  const harness = geometryHarness(), { dragHandle, panel, store } = harness;
  dragHandle.fire('pointerdown', { button: 2, clientX: 100, clientY: 100 }); dragHandle.fire('pointermove', { clientX: 300, clientY: 300 }); dragHandle.fire('pointerup'); assert.equal(store.has('qqj-panel-pos'), false);
  const control = { closest: () => ({}) }; dragHandle.fire('pointerdown', { target: control, clientX: 100, clientY: 100 }); dragHandle.fire('pointermove', { clientX: 300, clientY: 300 }); dragHandle.fire('pointerup'); assert.equal(store.has('qqj-panel-pos'), false);
  dragHandle.fire('pointerdown', { clientX: 100, clientY: 100 }); dragHandle.fire('pointermove', { clientX: 105, clientY: 100 }); dragHandle.fire('pointerup'); assert.equal(store.has('qqj-panel-pos'), false); assert.equal(panel.style.right, '20px');
  dragHandle.fire('pointerdown', { clientX: 100, clientY: 100 }); dragHandle.fire('pointermove', { clientX: -5000, clientY: -5000 }); dragHandle.fire('pointerup', { clientX: -5000, clientY: -5000 });
  assert.deepEqual(JSON.parse(store.get('qqj-panel-pos')), { left: 10, top: 10 }); assert.equal(panel.style.willChange, '');
  const saved = store.get('qqj-panel-pos'); dragHandle.fire('pointerdown', { clientX: 10, clientY: 10 }); dragHandle.fire('pointermove', { clientX: 100, clientY: 100 }); dragHandle.fire('pointercancel'); assert.equal(store.get('qqj-panel-pos'), saved); assert.equal(panel.classList.contains('is-gesturing'), false);
  dragHandle.fire('pointerdown', { clientX: 10, clientY: 10 }); dragHandle.fire('pointermove', { clientX: 100, clientY: 100 }); dragHandle.fire('lostpointercapture'); assert.equal(store.get('qqj-panel-pos'), saved);
  dragHandle.fire('pointerdown', { clientX: 10, clientY: 10 }); dragHandle.fire('pointermove', { clientX: 100, clientY: 100 }); harness.viewport.fire('resize'); assert.equal(panel.classList.contains('is-gesturing'), false); assert.equal(store.get('qqj-panel-pos'), saved);
});

test('桌面拉伸按视口和 500×420 clamp，只写设备偏好；临时缩屏与手机切换不污染保存值', () => {
  const harness = geometryHarness({ saved: { 'qqj-panel-size': JSON.stringify({ width: 900, height: 700 }), 'qqj-panel-pos': '{坏 JSON' } });
  const { panel, resizeHandle, viewport, store } = harness; assert.equal(panel.style.width, '900px'); assert.equal(panel.style.height, '700px'); assert.equal(panel.style.right, '20px');
  resizeHandle.fire('pointerdown', { clientX: 0, clientY: 0 }); resizeHandle.fire('pointermove', { clientX: -5000, clientY: -5000 }); resizeHandle.fire('pointerup', { clientX: -5000, clientY: -5000 });
  assert.equal(panel.style.width, '500px'); assert.equal(panel.style.height, '420px'); assert.deepEqual(JSON.parse(store.get('qqj-panel-size')), { width: 500, height: 420 });
  resizeHandle.fire('pointerdown', { clientX: 0, clientY: 0 }); resizeHandle.fire('pointermove', { clientX: 5000, clientY: 5000 }); resizeHandle.fire('pointerup', { clientX: 5000, clientY: 5000 });
  assert.equal(panel.style.width, '910px'); assert.equal(panel.style.height, '1030px'); assert.deepEqual(JSON.parse(store.get('qqj-panel-size')), { width: 910, height: 1030 });
  store.set('qqj-panel-size', JSON.stringify({ width: 900, height: 700 })); viewport.innerWidth = 800; viewport.innerHeight = 600; viewport.fire('resize');
  assert.equal(panel.style.width, '780px'); assert.equal(panel.style.height, '580px'); assert.deepEqual(JSON.parse(store.get('qqj-panel-size')), { width: 900, height: 700 });
  viewport.innerWidth = 640; viewport.innerHeight = 900; viewport.fire('resize');
  for (const property of ['left', 'top', 'right', 'width', 'height', 'maxWidth', 'maxHeight', 'transform']) assert.equal(panel.style[property], '');
  resizeHandle.fire('pointerdown', { clientX: 0, clientY: 0 }); resizeHandle.fire('pointermove', { clientX: 100, clientY: 100 }); resizeHandle.fire('pointerup'); assert.deepEqual(JSON.parse(store.get('qqj-panel-size')), { width: 900, height: 700 });
  viewport.innerWidth = 1920; viewport.innerHeight = 1080; viewport.fire('resize'); assert.equal(panel.style.width, '900px'); assert.equal(panel.style.height, '700px');
});

test('真实 dist bootstrap 生命周期：默认隐藏、唯一打开、关闭/Escape恢复焦点且 setState 不自动打开', async () => {
  const mod = await import('../dist/index.js?lifecycle=1'); const hosts = new Map(); const events = {}; let panelShow = 0; let panelClose = 0; let focusCount = 0; let formalReads = 0; let fabOpen; let wandOpen;
  const documentRef = { activeElement: { focus: () => { focusCount += 1; } }, body: { append(node) { hosts.set(node.id, node); } }, getElementById: id => hosts.get(id) || null, addEventListener: (name, fn) => { events[name] = fn; } };
  const panelFactory = ({ onClose }) => { const host = { id: 'qqj-panel-host', hidden: true, style: {}, __qqjInstance: null }; let trigger; const panel = { host, show: source => { trigger = source; panelShow += 1; host.hidden = false; }, close: () => { panelClose += 1; host.hidden = true; onClose(); trigger?.focus?.(); }, setState() {} }; host.__qqjInstance = panel; return panel; };
  const fabFactory = ({ onClick }) => { fabOpen = onClick; const host = { id: 'qqj-fab-host' }; return { host }; };
  const wandInstaller = onClick => { wandOpen = onClick; };
  const instance = mod.bootstrap({ formal: { initializeCard() {}, getFormalState: async () => { formalReads += 1; return { status: 'route_ready' }; } }, documentRef, panelFactory, fabFactory, wandInstaller }); const host = hosts.get('qqj-panel-host'); assert.equal(host.hidden, true); assert.equal(host.style.display, 'none'); instance.setState({ status: 'ready' }); assert.equal(host.hidden, true); fabOpen({ currentTarget: documentRef.activeElement }); assert.equal(panelShow, 1); assert.equal(host.hidden, false); await new Promise(resolve => setImmediate(resolve)); assert.equal(formalReads, 1); instance.close(); assert.equal(panelClose, 1); assert.equal(host.hidden, true); assert.equal(host.style.display, 'none'); assert.equal(focusCount, 1); wandOpen({ currentTarget: documentRef.activeElement }); assert.equal(panelShow, 2); await new Promise(resolve => setImmediate(resolve)); assert.equal(formalReads, 2); events.keydown({ key: 'Escape' }); assert.equal(panelClose, 2); const again = mod.bootstrap({ documentRef, panelFactory, fabFactory, wandInstaller }); assert.equal(again, instance); assert.equal(panelShow, 2);
});

test('生产 dist 只渲染有限诊断码，不包含异常透传模板', async () => {
  const dist = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8');
  for (const code of ['GREETING_INVALID', 'SCANNER_UNAVAILABLE', 'SCAN_FAILED', 'SCAN_RESULT_INVALID', 'ENTRY_INVALID', 'ROUTE_INVALID', 'UNKNOWN']) assert.match(dist, new RegExp(code));
  assert.match(dist, /来源扫描不可用/); assert.doesNotMatch(dist, /state\.message|state\.cause|error\.stack/);
});

test('真实 dist ready DOM：warning 与人物列表同显且不阻断', async () => {
  class Node {
    constructor() { this.children = []; this.events = {}; this.style = {}; this.hidden = false; this.offsetParent = {}; this.dataset = {}; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    setAttribute() {}
    addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
    querySelector(selector) { return this.nodes?.[selector] || null; }
    querySelectorAll() { return []; }
    focus() {}
    get textContent() { return this._text ?? this.children.map(item => item?.textContent ?? '').join(''); }
    set textContent(value) { this._text = String(value); }
    attachShadow() { const root = new Node(); root.nodes = { '.view': new Node(), '.status-label': new Node(), '.status-meta': new Node(), '.status-dot': new Node(), '.close': new Node() }; root.innerHTML = ''; this.shadowRoot = root; return root; }
  }
  const previousDocument = globalThis.document; const documentRef = { body: { append() {} }, getElementById: () => null, addEventListener() {}, createElement: () => new Node() };
  globalThis.document = documentRef;
  try {
    const mod = await import('../dist/index.js?source-stale-dom=1');
    const instance = mod.bootstrap({ documentRef, formal: {}, fabFactory: () => ({ host: new Node() }), wandInstaller: () => {} });
    instance.setState({ status: 'route_ready', people: { status: 'ready', warnings: [{ code: 'WORLDBOOK_VERSION_CHANGED' }], confirmed: [{ displayName: '确认人物' }], candidate: [{ name: '候选人物' }] } });
    const view = instance.host.shadowRoot.nodes['.view']; const content = view.textContent;
    assert.match(content, /部分原设来源当前不可用/); assert.match(content, /确认人物/); assert.match(content, /候选人物/); assert.doesNotMatch(content, /待刷新后重新读取|来源需要确认/);
  } finally { globalThis.document = previousDocument; }
});

test('真实 dist UI：识别失败警告色保留旧列表与操作，成功清错，部分归一化显示有限提示', async () => {
  class Node {
    constructor() { this.children = []; this.events = {}; this.style = {}; this.hidden = false; this.offsetParent = {}; this.dataset = {}; this.attributes = {}; this.className = ''; this.classList = { toggle: () => {} }; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; this._text = undefined; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
    fire(name, event = {}) { for (const fn of this.events[name] || []) fn(event); }
    descendants() { return this.children.flatMap(item => item instanceof Node ? [item, ...item.descendants()] : []); }
    querySelectorAll(selector) {
      if (selector.startsWith('[data-')) { const key = selector.slice(6, -1).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()); return this.descendants().filter(item => Object.hasOwn(item.dataset, key)); }
      if (selector === 'button,input,[href],[tabindex]:not([tabindex="-1"])') return this.descendants().filter(item => item.tagName === 'button' || item.tagName === 'input');
      if (selector.startsWith('.')) return this.descendants().filter(item => item.className.split(/\s+/).includes(selector.slice(1)));
      return [];
    }
    querySelector(selector) { return this.nodes?.[selector] || this.querySelectorAll(selector)[0] || null; }
    focus() {}
    get textContent() { return this._text ?? this.children.map(item => item?.textContent ?? '').join(''); }
    set textContent(value) { this._text = String(value); }
    set innerHTML(value) { this.markup = String(value); this.children = []; }
    get innerHTML() { return this.markup || ''; }
    attachShadow() { const root = new Node(); root.nodes = { '.view': new Node(), '.status-label': new Node(), '.status-meta': new Node(), '.status-dot': new Node(), '.close': new Node() }; root.nodes['.close'].tagName = 'button'; this.shadowRoot = root; return root; }
  }
  const previousDocument = globalThis.document; const hosts = []; const identityId = '123e4567-e89b-12d3-a456-426614174000'; let mode = 'fail';
  let current = { status: 'stale', contractVersion: 2, confirmed: [{ identityId, displayName: '旧版郑楠', selection: { status: 'unselected' } }], candidate: [], shelved: [] };
  const people = {
    getPeople: async () => current,
    identify: async () => {
      if (mode === 'fail') throw new Error('C 识别结果无可用人物');
      current = { ...current, status: 'ready', contractVersion: 3 };
      return { status: 'ready', warnings: [{ code: 'NORMALIZATION_ITEM_SKIPPED', count: 1 }] };
    },
    select: async () => { current = { ...current, confirmed: current.confirmed.map(item => ({ ...item, selection: { status: 'selected' } })) }; return current; },
    unselect: async () => current,
    shelve: async () => current,
    restore: async () => current,
  };
  const documentRef = { activeElement: null, body: { append(node) { hosts.push(node); } }, getElementById: () => null, addEventListener() {}, createElement: tag => { const node = new Node(); node.tagName = tag; return node; } };
  globalThis.document = documentRef;
  const settle = async () => { for (let index = 0; index < 6; index += 1) await new Promise(resolve => setImmediate(resolve)); };
  try {
    const mod = await import('../dist/index.js?recognition-failure-ui=1');
    const instance = mod.bootstrap({ documentRef, formal: { getFormalState: async () => ({ status: 'route_ready' }) }, people, wandInstaller: () => {} });
    instance.show(); await settle();
    const root = instance.host.shadowRoot, view = root.nodes['.view'];
    assert.equal(root.nodes['.status-label'].textContent, '人物识别失败，已保留旧列表'); assert.match(root.nodes['.status-dot'].className, /warn/);
    assert.match(view.textContent, /旧版郑楠/); assert.match(view.textContent, /人物识别结果格式无效/);
    view.querySelector('[data-select]').fire('click'); await settle(); assert.equal(root.nodes['.status-label'].textContent, '人物识别失败，已保留旧列表'); assert.match(view.textContent, /当前关注/);
    mode = 'success'; instance.show(); await settle();
    assert.equal(root.nodes['.status-label'].textContent, '来源已锚定，正式档案已就绪'); assert.match(root.nodes['.status-dot'].className, /warn/);
    assert.match(view.textContent, /部分人物格式已自动修正或跳过/); assert.doesNotMatch(view.textContent, /人物识别结果格式无效|已保留旧列表/); assert.equal(current.contractVersion, 3);
  } finally { globalThis.document = previousDocument; }
});

test('真实 dist 人物 UI：选择/取消、搁置/恢复与 candidate 分区均调用生产操作', async () => {
  class Node {
    constructor() { this.children = []; this.events = {}; this.style = {}; this.hidden = false; this.offsetParent = {}; this.dataset = {}; this.attributes = {}; this.className = ''; this.classList = { toggle: () => {} }; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; this._text = undefined; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
    fire(name, event = {}) { for (const fn of this.events[name] || []) fn(event); }
    descendants() { return this.children.flatMap(item => item instanceof Node ? [item, ...item.descendants()] : []); }
    querySelectorAll(selector) {
      if (selector.startsWith('[data-')) { const key = selector.slice(6, -1).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()); return this.descendants().filter(item => Object.hasOwn(item.dataset, key)); }
      if (selector === 'button,input,[href],[tabindex]:not([tabindex="-1"])') return this.descendants().filter(item => item.tagName === 'button' || item.tagName === 'input');
      if (selector.startsWith('.')) return this.descendants().filter(item => item.className.split(/\s+/).includes(selector.slice(1)));
      return [];
    }
    querySelector(selector) { return this.nodes?.[selector] || this.querySelectorAll(selector)[0] || null; }
    focus() {}
    get textContent() { return this._text ?? this.children.map(item => item?.textContent ?? '').join(''); }
    set textContent(value) { this._text = String(value); }
    set innerHTML(value) { this.markup = String(value); this.children = []; }
    get innerHTML() { return this.markup || ''; }
    attachShadow() { const root = new Node(); root.nodes = { '.view': new Node(), '.status-label': new Node(), '.status-meta': new Node(), '.status-dot': new Node(), '.close': new Node() }; root.nodes['.close'].tagName = 'button'; this.shadowRoot = root; return root; }
  }
  const previousDocument = globalThis.document, previousConfirm = globalThis.confirm; const hosts = [];
  const documentRef = { activeElement: null, body: { append(node) { hosts.push(node); } }, getElementById: () => null, addEventListener() {}, createElement: tag => { const node = new Node(); node.tagName = tag; return node; } };
  globalThis.document = documentRef; globalThis.confirm = () => true;
  try {
    const identityId = '123e4567-e89b-12d3-a456-426614174000'; const calls = [];
    let current = { status: 'stale', contractVersion: 2, confirmed: [{ identityId, displayName: '明确人物', selection: { status: 'unselected' } }], candidate: [{ name: '候选人物' }], shelved: [] };
    const people = {
      getPeople: async () => current,
      select: async ({ identityId: value }) => { calls.push(['select', value]); current = { ...current, confirmed: current.confirmed.map(item => ({ ...item, selection: { status: 'selected' } })) }; return current; },
      unselect: async ({ identityId: value }) => { calls.push(['unselect', value]); current = { ...current, confirmed: current.confirmed.map(item => ({ ...item, selection: { status: 'unselected' } })) }; return current; },
      shelve: async ({ identityId: value }) => { calls.push(['shelve', value]); current = { ...current, shelved: [{ ...current.confirmed[0], selection: { status: 'unselected' } }], confirmed: [] }; return current; },
      restore: async ({ identityId: value }) => { calls.push(['restore', value]); current = { ...current, confirmed: [{ ...current.shelved[0], selection: { status: 'unselected' } }], shelved: [] }; return current; },
    };
    const mod = await import('../dist/index.js?people-actions=1'); const instance = mod.bootstrap({ documentRef, formal: {}, people, wandInstaller: () => {} });
    instance.setState({ status: 'route_ready', people: current }); const view = instance.host.shadowRoot.nodes['.view'];
    assert.match(view.textContent, /选择.*只表示.*不代表已经恋爱/s); assert.match(view.textContent, /待判断人物/); assert.match(view.textContent, /候选人物/);
    view.querySelector('[data-select]').fire('click'); await new Promise(resolve => setImmediate(resolve)); assert.equal(view.querySelector('[data-unselect]').textContent, '取消选择');
    view.querySelector('[data-unselect]').fire('click'); await new Promise(resolve => setImmediate(resolve));
    view.querySelector('[data-shelve]').fire('click'); await new Promise(resolve => setImmediate(resolve)); assert.match(view.textContent, /已搁置人物（1）/);
    view.querySelector('[data-restore]').fire('click'); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [['select', identityId], ['unselect', identityId], ['shelve', identityId], ['restore', identityId]]); assert.match(view.textContent, /明确人物/); assert.equal(current.contractVersion, 2);
    current = { ...current, status: 'ready', contractVersion: 3, confirmed: [...current.confirmed, { identityId: '123e4567-e89b-12d3-a456-426614174001', displayName: '识别新增人物', selection: { status: 'unselected' } }] };
    instance.setState({ status: 'route_ready', people: current }); assert.match(view.textContent, /明确人物/); assert.match(view.textContent, /识别新增人物/);
  } finally { globalThis.document = previousDocument; globalThis.confirm = previousConfirm; }
});

test('真实 installWandEntry 入口外层横向单行、图标 class 内聚且点击键盘仍回调', async () => {
  const previousDocument = globalThis.document; const listeners = {}; let appended; let clicks = 0;
  const parent = { append(node) { appended = node; }, querySelector() { return null; } };
  globalThis.document = { querySelector: selector => selector === '#extensionsMenu' ? parent : null, createElement: () => { const node = { style: {}, className: '', events: {}, setAttribute() {}, addEventListener(name, fn) { this.events[name] = fn; }, remove() {}, innerHTML: '' }; Object.defineProperty(node, 'innerHTML', { set(value) { this.markup = value; this.icon = { className: 'fa-solid fa-link extensionsMenuExtensionButton' }; }, get() { return this.markup; } }); return node; }, body: null };
  try {
    const { installWandEntry } = await import('../src/ui/wand-entry.js?wand-seam=1'); installWandEntry(() => { clicks += 1; });
    assert.ok(appended); assert.doesNotMatch(appended.className, /extensionsMenuExtensionButton/); assert.match(appended.icon.className, /extensionsMenuExtensionButton/); assert.equal(appended.style.flexWrap, 'nowrap'); assert.equal(appended.style.whiteSpace, 'nowrap');
    appended.events.click({}); appended.events.keydown({ key: 'Enter', preventDefault() {} }); appended.events.keydown({ key: ' ', preventDefault() {} }); assert.equal(clicks, 3);
  } finally { globalThis.document = previousDocument; }
});

test('真实 dist bootstrap 默认无 FAB 且显式开关可恢复', async () => {
  const mod = await import('../dist/index.js?fab-flag-regression=1'); const appended = []; let wandOpen; let fabClicks = 0;
  const documentRef = { body: { append(node) { appended.push(node); } }, getElementById: () => null, createElement: () => ({ className: '', style: {}, append() {}, setAttribute() {}, attachShadow() { return { innerHTML: '', querySelector: () => ({ addEventListener() {} }) }; } }), addEventListener() {} };
  const panelFactory = () => ({ host: { id: 'qqj-panel-host', hidden: true, style: {}, __qqjInstance: null }, show() {}, close() {}, setState() {}, root: { querySelector() {} } });
  const wandInstaller = open => { wandOpen = open; };
  const first = mod.bootstrap({ documentRef, panelFactory, wandInstaller, fabFactory: ({ onClick }) => { fabClicks = onClick; return { host: { id: 'qqj-fab-host' } }; } });
  assert.equal(appended.some(node => node.id === 'qqj-fab-host'), false); assert.equal(first.fab.host, null); assert.equal(typeof wandOpen, 'function');
  const second = mod.bootstrap({ documentRef: { ...documentRef, getElementById: () => null, body: { append(node) { appended.push(node); } } }, panelFactory, wandInstaller, enableFab: true, fabFactory: ({ onClick }) => { fabClicks = onClick; return { host: { id: 'qqj-fab-host' } }; } });
  assert.equal(appended.some(node => node.id === 'qqj-fab-host'), true); assert.equal(typeof fabClicks, 'function'); assert.ok(second);
});
