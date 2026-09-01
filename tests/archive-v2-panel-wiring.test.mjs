import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const settle = async () => {
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
};

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

async function loadBootstrapModule() {
  let source = await readFile(new URL('../src/bootstrap.js', import.meta.url), 'utf8');
  source = source.replace(/^import .*;\n/gm, '').replace('export function bootstrap', 'function bootstrap');
  const factory = new Function(
    'createPanel', 'safePeopleErrorCopy', 'createFab', 'installWandEntry', 'mapPeopleError', 'createArchiveV2InitializationView',
    `${source}\nreturn { bootstrap };`,
  );
  return factory(
    () => { throw new Error('测试必须注入 panelFactory'); },
    () => '人物识别失败，请稍后重试',
    () => ({ host: null }),
    () => {},
    () => '人物识别失败，请稍后重试',
    () => { throw new Error('测试必须注入 archiveV2ViewFactory'); },
  );
}

function bootstrapHarness({ initialEnabled = true, gate = null, withComposition = true } = {}) {
  const calls = { factory: 0, mount: 0, activate: 0, deactivate: 0, destroy: 0, load: 0, read: 0, formal: 0, people: 0, ai: 0, memoryInvalidate: 0, states: [], order: [] };
  let enabled = initialEnabled;
  let wandOpen;
  const events = {};
  const hosts = new Map();
  const documentRef = {
    activeElement: { focus() {} },
    body: { append(node) { hosts.set(node.id, node); } },
    getElementById: id => hosts.get(id) ?? null,
    addEventListener(name, handler) { events[name] = handler; },
    createElement() { return { className: '', textContent: '' }; },
  };
  const initializationView = {
    mount() { calls.mount += 1; calls.order.push('mount'); },
    activate() { calls.activate += 1; calls.read += 1; calls.order.push('activate'); return Promise.resolve({ status: 'uninitialized' }); },
    deactivate() { calls.deactivate += 1; calls.order.push('deactivate'); },
    destroy() { calls.destroy += 1; },
  };
  const archiveV2ViewFactory = options => {
    calls.factory += 1;
    assert.equal(options.documentRef, documentRef);
    assert.equal(options.memory, withComposition ? archiveV2Memory : undefined);
    assert.equal(options.dossier, withComposition ? archiveV2Dossier : undefined);
    return initializationView;
  };
  const archiveV2Memory = {
    inspect() {}, start() {}, getState() {}, invalidate() { calls.memoryInvalidate += 1; },
  };
  const archiveV2Dossier = { updatePerson() {}, renamePerson() {}, setFollowed() {}, invalidate() {} };
  let initializationOwner = false;
  let initializationActive = false;
  const panelFactory = options => {
    assert.equal(options.archiveV2InitializationView, withComposition ? initializationView : undefined);
    const host = { id: 'qqj-panel-host', hidden: true, style: {} };
    const panel = {
      host,
      root: { querySelector: () => null },
      show() { host.hidden = false; calls.order.push('show'); if (enabled && options.archiveV2InitializationView) void panel.showInitialization(); },
      close() {
        if (initializationActive) { initializationActive = false; initializationView.deactivate(); }
        host.hidden = true;
        options.onClose();
      },
      setState(value) { calls.states.push(value); calls.order.push(`state:${value?.status}`); },
      showInitialization() {
        calls.order.push('showInitialization');
        if (!initializationOwner) { initializationView.mount(); initializationOwner = true; }
        if (!initializationActive) { initializationActive = true; return initializationView.activate(); }
        return Promise.resolve(true);
      },
      invalidateInitialization() {
        if (initializationActive) { initializationActive = false; initializationView.deactivate(); }
      },
    };
    return panel;
  };
  const options = {
    settings: { isEnabled: () => enabled },
    formal: { getFormalState: async () => { calls.formal += 1; return { status: 'ready' }; } },
    people: { getPeople: async () => { calls.people += 1; return { status: 'ready' }; } },
    loadState: async () => {
      calls.load += 1; calls.order.push('load:start');
      if (gate) await gate.promise;
      calls.order.push('load:end');
      return { status: 'ready' };
    },
    documentRef,
    panelFactory,
    archiveV2ViewFactory,
    wandInstaller(open) { wandOpen = open; },
    ...(withComposition ? {
      archiveV2Composition: { flow: {}, readArchive() {}, currentIdentity() {} },
      archiveV2Memory,
      archiveV2Dossier,
    } : {}),
  };
  return {
    calls, events, documentRef, options,
    setEnabledValue(value) { enabled = value; },
    getWandOpen: () => wandOpen,
  };
}

class FakeNode {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.events = {};
    this.dataset = {};
    this.attributes = {};
    this.style = { setProperty: (name, value) => { this.style[name] = value; } };
    this.className = '';
    this.hidden = false;
    this.offsetParent = {};
    this._text = '';
    this._innerHTML = '';
    const classes = new Set();
    this.classList = {
      toggle: (name, force) => { if (force) classes.add(name); else classes.delete(name); },
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
    };
  }

  set innerHTML(value) { this._innerHTML = String(value); this.children = []; }
  get innerHTML() { return this._innerHTML; }
  set textContent(value) { this._text = String(value ?? ''); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent ?? '').join(''); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; this._text = ''; this._innerHTML = ''; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, handler) { (this.events[name] ||= []).push(handler); }
  fire(name, event = {}) {
    const value = { key: '', preventDefault() {}, currentTarget: this, target: this, ...event };
    return (this.events[name] || []).map(handler => handler(value));
  }
  focus() { globalThis.document.activeElement = this; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

class FakeRoot extends FakeNode {
  constructor() {
    super('shadow-root');
    this.nodes = {
      '.view': new FakeNode(),
      '.status-label': new FakeNode(),
      '.status-meta': new FakeNode(),
      '.status-dot': new FakeNode(),
      '.close': new FakeNode('button'),
      '.settings-btn': new FakeNode('button'),
      '.panel': new FakeNode(),
      '.topbar': new FakeNode(),
      '.panel-resize-handle': new FakeNode(),
    };
    this.tabs = ['people', 'bonds', 'milestones', 'knots'].map(name => {
      const tab = new FakeNode('button'); tab.dataset.tab = name; return tab;
    });
    this.activeElement = null;
  }

  querySelector(selector) { return this.nodes[selector] ?? null; }
  querySelectorAll(selector) {
    if (selector === '.tab') return this.tabs;
    if (selector.startsWith('button,input')) return [];
    return [];
  }
}

async function loadPanelModule() {
  let source = await readFile(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  source = source.replace(/^import .*;\n/gm, '')
    .replace('export const safePeopleErrorCopy', 'const safePeopleErrorCopy')
    .replace('export function createPanel', 'function createPanel');
  const factory = new Function('html', 'css', 'createPanelGeometryController', `${source}\nreturn { createPanel, safePeopleErrorCopy };`);
  return factory('', '', () => ({ restore() {}, cancelGesture() {} }));
}

async function panelHarness({ withView = true, activationError = null } = {}) {
  const previousDocument = globalThis.document;
  const previousAddEventListener = globalThis.addEventListener;
  const root = new FakeRoot();
  const documentEvents = {};
  const documentRef = {
    activeElement: null,
    createElement(tag) {
      const node = new FakeNode(tag);
      node.attachShadow = () => root;
      return node;
    },
  };
  globalThis.document = documentRef;
  globalThis.addEventListener = (name, handler) => { documentEvents[name] = handler; };
  let enabled = true;
  const calls = { mount: 0, activate: 0, deactivate: 0, destroy: 0 };
  const v2Root = new FakeNode('section'); v2Root.textContent = 'V2 初始化内容';
  const initializationView = {
    mount(container) { calls.mount += 1; container.append(v2Root); },
    activate() { calls.activate += 1; return activationError ? Promise.reject(activationError) : Promise.resolve({ status: 'uninitialized' }); },
    deactivate() { calls.deactivate += 1; },
    destroy() { calls.destroy += 1; },
  };
  const { createPanel } = await loadPanelModule();
  const panel = createPanel({
    settings: {
      isEnabled: () => enabled,
      get: () => ({ pluginEnabled: enabled, apiMode: 'auto', selectedSevenDaysPresetId: '' }),
      sharedPresets: () => [], sharedMainConfig: () => ({}), sharedSnapshotKey: () => '',
    },
    apiTools: { describe: () => ({ sevenDaysPresets: [] }) },
    ...(withView ? { archiveV2InitializationView: initializationView } : {}),
  });
  return {
    panel, root, view: root.nodes['.view'], calls, v2Root, documentEvents,
    setEnabled(value) { enabled = value; },
    cleanup() {
      panel.close();
      globalThis.document = previousDocument;
      globalThis.addEventListener = previousAddEventListener;
    },
  };
}

test('bootstrap 构造 factory 最多一次，构造期零 mount/activate/read，缺少 composition 保持旧行为', async () => {
  const { bootstrap } = await loadBootstrapModule();
  const wired = bootstrapHarness();
  bootstrap(wired.options);
  assert.deepEqual({ factory: wired.calls.factory, mount: wired.calls.mount, activate: wired.calls.activate, read: wired.calls.read }, { factory: 1, mount: 0, activate: 0, read: 0 });
  const legacy = bootstrapHarness({ withComposition: false });
  bootstrap(legacy.options);
  assert.deepEqual({ factory: legacy.calls.factory, mount: legacy.calls.mount, activate: legacy.calls.activate }, { factory: 0, mount: 0, activate: 0 });
});

test('总开关关闭 open 严格零 reload/mount/activate/read，disabled 页面不被 V2 接管', async () => {
  const { bootstrap } = await loadBootstrapModule();
  const harness = bootstrapHarness({ initialEnabled: false });
  bootstrap(harness.options);
  harness.getWandOpen()({});
  await settle();
  assert.equal(harness.calls.states.at(-1).status, 'disabled');
  assert.deepEqual(
    { load: harness.calls.load, formal: harness.calls.formal, people: harness.calls.people, ai: harness.calls.ai, mount: harness.calls.mount, activate: harness.calls.activate, read: harness.calls.read },
    { load: 0, formal: 0, people: 0, ai: 0, mount: 0, activate: 0, read: 0 },
  );
  assert.equal(harness.calls.order.includes('showInitialization'), false);
});

test('启用 open 立即 mount/activate，后台 reload 迟到不覆盖或重复 read', async () => {
  const { bootstrap } = await loadBootstrapModule();
  const gate = deferred();
  const harness = bootstrapHarness({ gate });
  bootstrap(harness.options);
  harness.getWandOpen()({});
  assert.equal(harness.calls.load, 1);
  assert.deepEqual({ mount: harness.calls.mount, activate: harness.calls.activate, read: harness.calls.read }, { mount: 1, activate: 1, read: 1 });
  assert.ok(harness.calls.order.indexOf('activate') < harness.calls.order.indexOf('load:start'));
  assert.equal(harness.calls.order.includes('load:end'), false);
  gate.resolve();
  await settle();
  assert.deepEqual({ mount: harness.calls.mount, activate: harness.calls.activate, read: harness.calls.read }, { mount: 1, activate: 1, read: 1 });
  harness.getWandOpen()({});
  await settle();
  assert.deepEqual({ mount: harness.calls.mount, activate: harness.calls.activate, read: harness.calls.read }, { mount: 1, activate: 1, read: 1 });
});

test('reload 未完成时 close 或 setEnabled(false)，当前视图失活且迟到结果不重新 activate', async () => {
  const { bootstrap } = await loadBootstrapModule();
  for (const mode of ['close', 'disable']) {
    const gate = deferred();
    const harness = bootstrapHarness({ gate });
    const instance = bootstrap(harness.options);
    harness.getWandOpen()({});
    await Promise.resolve();
    if (mode === 'close') instance.close();
    else { harness.setEnabledValue(false); instance.setEnabled(false); }
    gate.resolve();
    await settle();
    assert.equal(harness.calls.mount, 1, mode);
    assert.equal(harness.calls.activate, 1, mode);
    assert.equal(harness.calls.deactivate, 1, mode);
    assert.equal(harness.calls.destroy, 0, mode);
    if (mode === 'disable') assert.equal(harness.calls.states.at(-1).status, 'disabled');
  }
});

test('真实 panel 只管理 owner/lifecycle：普通 setState 不覆盖，invalidate 后新状态恢复', async () => {
  const harness = await panelHarness();
  try {
    assert.deepEqual(harness.calls, { mount: 0, activate: 0, deactivate: 0, destroy: 0 });
    harness.panel.show();
    await harness.panel.showInitialization();
    assert.deepEqual({ mount: harness.calls.mount, activate: harness.calls.activate }, { mount: 1, activate: 1 });
    assert.equal(harness.view.children[0], harness.v2Root);
    harness.panel.setState({ status: 'ready', people: { status: 'ready' } });
    assert.equal(harness.view.children[0], harness.v2Root);
    assert.deepEqual({ mount: harness.calls.mount, activate: harness.calls.activate }, { mount: 1, activate: 1 });
    harness.panel.invalidateInitialization();
    assert.equal(harness.calls.deactivate, 1);
    harness.panel.setState({ status: 'loading' });
    assert.equal(harness.calls.activate, 1);
    harness.panel.setState({ status: 'ready' });
    await settle();
    assert.deepEqual({ mount: harness.calls.mount, activate: harness.calls.activate }, { mount: 1, activate: 2 });
    assert.equal(harness.calls.destroy, 0);
  } finally { harness.cleanup(); }
});

test('真实 panel 关闭后重开由 show 立即恢复初始化页，迟到 setState 不抢占', async () => {
  const harness = await panelHarness();
  try {
    harness.panel.show(); await settle();
    harness.panel.close();
    harness.panel.setState({ status: 'loading' });
    harness.panel.show();
    assert.equal(harness.calls.activate, 2);
    harness.panel.setState({ status: 'ready' });
    await settle();
    assert.equal(harness.calls.activate, 2);
    assert.equal(harness.calls.mount, 1);
  } finally { harness.cleanup(); }
});

test('真实 bootstrap + panel 首次点击同步挂载 V2，后台 reload 迟到后内容仍归 V2', async () => {
  const previousDocument = globalThis.document, previousAddEventListener = globalThis.addEventListener;
  const root = new FakeRoot(), hosts = new Map(), gate = deferred();
  const documentRef = {
    activeElement: null,
    body: { append(node) { hosts.set(node.id, node); } },
    getElementById(id) { return hosts.get(id) ?? null; },
    addEventListener() {},
    createElement(tag) { const node = new FakeNode(tag); node.attachShadow = () => root; return node; },
  };
  globalThis.document = documentRef; globalThis.addEventListener = () => {};
  const calls = { mount: 0, activate: 0, load: 0 }, v2Root = new FakeNode('section'); v2Root.textContent = '真实首次点击 V2';
  const initializationView = {
    mount(container) { calls.mount += 1; container.append(v2Root); },
    activate() { calls.activate += 1; return Promise.resolve(true); },
    deactivate() {},
  };
  try {
    const [{ bootstrap }, { createPanel }] = await Promise.all([loadBootstrapModule(), loadPanelModule()]);
    let wandOpen;
    const settings = { isEnabled: () => true, get: () => ({ pluginEnabled: true, apiMode: 'auto', selectedSevenDaysPresetId: '' }), sharedPresets: () => [], sharedMainConfig: () => ({}), sharedSnapshotKey: () => '' };
    const instance = bootstrap({
      settings, documentRef, panelFactory: createPanel,
      archiveV2Composition: { flow: {}, readArchive() {}, currentIdentity() {} }, archiveV2Memory: {},
      archiveV2ViewFactory: () => initializationView,
      loadState: async () => { calls.load += 1; await gate.promise; return { status: 'ready' }; },
      wandInstaller(open) { wandOpen = open; },
    });
    wandOpen({});
    assert.deepEqual(calls, { mount: 1, activate: 1, load: 1 });
    assert.equal(root.nodes['.view'].children[0], v2Root);
    gate.resolve(); await settle();
    assert.equal(root.nodes['.view'].children[0], v2Root);
    assert.deepEqual({ mount: calls.mount, activate: calls.activate }, { mount: 1, activate: 1 });
    instance.close();
  } finally { globalThis.document = previousDocument; globalThis.addEventListener = previousAddEventListener; }
});

test('真实 panel 首次激活失败只显示通用诊断，不泄露原始异常', async () => {
  const harness = await panelHarness({ activationError: new Error('SECRET_CHAT_AND_KEY') });
  try {
    harness.panel.show(); await settle();
    assert.equal(harness.root.nodes['.status-label'].textContent, '千人档案暂不可用');
    assert.equal(harness.root.nodes['.status-meta'].textContent, 'INIT_VIEW_FAILED');
    assert.equal(harness.root.nodes['.status-dot'].className, 'status-dot warn');
    assert.doesNotMatch(`${harness.view.textContent}\n${harness.root.nodes['.status-label'].textContent}\n${harness.root.nodes['.status-meta'].textContent}`, /SECRET_CHAT_AND_KEY/);
  } finally { harness.cleanup(); }
});

test('真实 panel 的 close、关闭按钮、Shadow Escape 共用 deactivate，设置/其他 tab release 后返回重挂载', async () => {
  const harness = await panelHarness();
  try {
    harness.panel.show(); await harness.panel.showInitialization();
    harness.panel.close(); assert.equal(harness.calls.deactivate, 1);
    harness.panel.show(); await harness.panel.showInitialization(); assert.equal(harness.calls.mount, 1);
    harness.root.nodes['.close'].fire('click'); assert.equal(harness.calls.deactivate, 2);
    harness.panel.show(); await harness.panel.showInitialization();
    harness.root.fire('keydown', { key: 'Escape' }); assert.equal(harness.calls.deactivate, 3);

    harness.panel.show(); await harness.panel.showInitialization();
    harness.root.nodes['.settings-btn'].fire('click'); assert.equal(harness.calls.deactivate, 4);
    harness.root.nodes['.settings-btn'].fire('click'); await settle();
    assert.deepEqual({ mount: harness.calls.mount, activate: harness.calls.activate }, { mount: 2, activate: 5 });
    harness.root.tabs[1].fire('click'); assert.equal(harness.calls.deactivate, 5);
    harness.root.tabs[0].fire('click'); await settle();
    assert.deepEqual({ mount: harness.calls.mount, activate: harness.calls.activate }, { mount: 3, activate: 6 });
    assert.equal(harness.calls.destroy, 0);
  } finally { harness.cleanup(); }
});

test('真实 panel setState(disabled) 先失活并保留 flow 草稿，旧 panel 无 V2 依赖时仍可工作', async () => {
  const harness = await panelHarness();
  try {
    harness.panel.show(); await harness.panel.showInitialization();
    harness.setEnabled(false);
    harness.panel.setState({ status: 'disabled' });
    assert.equal(harness.calls.deactivate, 1);
    assert.equal(harness.calls.destroy, 0);
    assert.match(harness.view.textContent, /千千结现在是关闭的/);
  } finally { harness.cleanup(); }
  const legacy = await panelHarness({ withView: false });
  try {
    legacy.panel.show();
    legacy.panel.setState({ status: 'disabled' });
    assert.match(legacy.view.textContent, /千千结现在是关闭的/);
    assert.equal(await legacy.panel.showInitialization(), false);
  } finally { legacy.cleanup(); }
});

test('bootstrap document Escape 走 panel.close 公共路径并 deactivate，不 destroy', async () => {
  const { bootstrap } = await loadBootstrapModule();
  const harness = bootstrapHarness();
  bootstrap(harness.options);
  harness.getWandOpen()({});
  await settle();
  harness.events.keydown({ key: 'Escape' });
  assert.equal(harness.calls.deactivate, 1);
  assert.equal(harness.calls.destroy, 0);
  assert.equal(harness.calls.memoryInvalidate, 0);
});

test('index 窄装配只建一个 composition、复用依赖、按序统一失效且不新增宿主事件', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.equal((source.match(/createArchiveV2Composition\s*\(/g) || []).length, 1);
  assert.equal((source.match(/createArchiveV2MemoryComposition\s*\(/g) || []).length, 1);
  assert.equal((source.match(/createArchiveV2FollowedProfileComposition\s*\(/g) || []).length, 1);
  assert.match(source, /createArchiveV2Composition\(\{ client, contextProvider, generateTask: peopleTaskRouter\.generatePeopleTask, isEnabled: settings\.isEnabled \}\)/);
  assert.match(source, /createArchiveV2MemoryComposition\(\{ client, contextProvider, generateUtilityTask: peopleTaskRouter\.generateUtilityTask, isEnabled: settings\.isEnabled \}\)/);
  assert.match(source, /createArchiveV2FollowedProfileComposition\(\{ client, contextProvider, generateUtilityTask: peopleTaskRouter\.generateUtilityTask, isEnabled: settings\.isEnabled \}\)/);
  assert.match(source, /createArchiveV2DossierComposition\(\{ client, contextProvider, isEnabled: settings\.isEnabled \}\)/);
  assert.match(source, /archiveV2Composition: archiveV2/);
  assert.match(source, /archiveV2Memory/);
  const order = [
    'ui?.invalidateInitialization?.()', 'archiveV2FollowedProfiles.invalidate()', 'archiveV2Dossier.invalidate()', 'archiveV2Memory.invalidate()', 'archiveV2.invalidate()', 'peopleTaskRouter.abortAll()', 'apiTools.abortAll()',
    'people.invalidate()', 'sourceCatalog.invalidate()', 'stableFloors.invalidate()', 'peopleFoundation.invalidate()',
    'initialRelations.invalidate()', 'pendingReviews.invalidate()', 'orchestrator.invalidate()',
  ].map(text => source.indexOf(text));
  assert.ok(order.every(index => index >= 0));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(source, /for \(const operation of operations\)[\s\S]*try \{ operation\(\); \} catch/);
  assert.equal((source.match(/bindRerunEvents\s*\(/g) || []).length, 1);
  assert.doesNotMatch(source, /addEventListener\([^\n]*(CHAT_CHANGED|PERSONA_CHANGED)/);
});

test('接线边界不改 panel 业务，且 bootstrap 只把窄 V2 compositions 传给 view', async () => {
  const bootstrap = await readFile(new URL('../src/bootstrap.js', import.meta.url), 'utf8');
  const panel = await readFile(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  assert.match(bootstrap, /archiveV2ViewFactory\(\{ composition: archiveV2Composition, memory: archiveV2Memory, followedProfiles: archiveV2FollowedProfiles, dossier: archiveV2Dossier, documentRef \}\)/);
  assert.match(bootstrap, /archiveV2InitializationView,/);
  assert.doesNotMatch(panel, /archiveV2Composition|readArchive|recognizeCandidates|generateProfiles|commitInitialization/);
  assert.doesNotMatch(panel, /CHAT_CHANGED|PERSONA_CHANGED/);
});
