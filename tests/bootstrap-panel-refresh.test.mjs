import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

async function loadBootstrap(overrides = {}) {
  const context = createContext({ console });
  const source = await readFile(new URL('../src/bootstrap.js', import.meta.url), 'utf8');
  const entry = new SourceTextModule(source, { context, identifier: new URL('../src/bootstrap.js', import.meta.url).href });
  const factories = {
    './ui/panel.js': { createPanel: () => null },
    './ui/fab.js': { createFab: () => ({ host: null }) },
    './ui/wand-entry.js': { installWandEntry() {} },
    './ui/source-permission-view.js': { createSourcePermissionView: () => null },
    './ui/v3-foundation-view.js': { createV3FoundationView: () => null },
    './ui/people-profiles-view.js': { createPeopleProfilesView: () => null },
    './ui/dialog.js': { createDialogManager: () => ({ host: null, confirm() {}, info() {}, setAppearance() {} }) },
    ...overrides,
  };
  await entry.link(specifier => new SyntheticModule(Object.keys(factories[specifier]), function initialize() {
    for (const [name, value] of Object.entries(factories[specifier])) this.setExport(name, value);
  }, { context, identifier: specifier }));
  await entry.evaluate();
  return entry.namespace.bootstrap;
}

async function harness(result) {
  const bootstrap = await loadBootstrap();
  const statuses = [];
  const deactivations = { foundation: 0 };
  const host = { hidden: true };
  const panel = {
    host,
    async show() { return result; },
    showStatus(text) { statuses.push(text); deactivations.foundation += 1; },
    setEnabled() {},
    refresh: async () => result,
  };
  const stubView = () => ({ mount() {}, activate: async () => ({ status: 'ready' }), deactivate() {} });
  const instance = bootstrap({
    settings: { isEnabled: () => true },
    v3FoundationViewFactory: () => ({ ...stubView(), deactivate() { deactivations.foundation += 1; } }),
    peopleProfilesViewFactory: stubView,
    peopleWorkspaceRuntime: { getState: () => ({ status: 'ready' }) },
    documentRef: { activeElement: null, getElementById: () => null, createElement: () => ({}), body: { append() {} } },
    panelFactory: () => panel,
    wandInstaller() {},
  });
  return { instance, statuses, deactivations };
}

test('bootstrap 保留 transient stale 时的已挂载面板，disabled 仍显示关闭状态', async () => {
  const stale = await harness({ status: 'stale' });
  await stale.instance.show();
  assert.deepEqual(stale.statuses, []);
  assert.equal(stale.deactivations.foundation, 0);

  const disabled = await harness({ status: 'disabled' });
  await disabled.instance.show();
  assert.deepEqual(disabled.statuses, ['千千结已关闭']);
  assert.equal(disabled.deactivations.foundation, 1);
});

test('bootstrap 只挂载一个悬浮球，点击切换面板且总开关同步显隐', async () => {
  let fabOptions, foundationOptions, panelOptions, shows = 0, closes = 0; const appended = [], bodyAppended = [], fabAppearances = [], inlineAppearances = [];
  const fabHost = { style: {} };
  const dialogHost = { id: 'dialog-host' };
  const bootstrap = await loadBootstrap({ './ui/fab.js': { createFab: options => { fabOptions = options; return { host: fabHost, setBusy() {}, setAppearance(value) { fabAppearances.push(value); } }; } } });
  const dayAppearance = { mode: 'auto', effectiveTheme: 'day', palette: { knot: '#b63745', line: '#dce2e5' } };
  const panel = { host: { hidden: true }, show() { shows += 1; this.host.hidden = false; return { status: 'ready' }; }, close() { closes += 1; this.host.hidden = true; }, setEnabled() {}, refresh: async () => ({ status: 'ready' }), getUiDiagnostic: () => '{"schemaVersion":1}', syncAppearance: () => dayAppearance };
  const stubView = () => ({ mount() {}, activate: async () => ({ status: 'ready' }), deactivate() {} });
  const current = { fabShow: true };
  const instance = bootstrap({
    settings: { isEnabled: () => true, get: () => current }, enableFab: true,
    v3FoundationViewFactory: options => { foundationOptions = options; return stubView(); }, peopleProfilesViewFactory: stubView, peopleWorkspaceRuntime: { getState: () => ({}) },
    documentRef: { activeElement: null, defaultView: {}, getElementById: () => null, createElement: () => ({}), documentElement: { append: node => appended.push(node) }, body: { append: node => bodyAppended.push(node) } },
    inlineRenderer: { setAppearance(value) { inlineAppearances.push(value); } },
    panelFactory: options => { panelOptions = options; return panel; }, dialogFactory: () => ({ host: dialogHost, confirm() {}, info() {}, setAppearance() {} }), wandInstaller() {},
  });
  assert.deepEqual(appended, [dialogHost], '弹窗 host 应挂在 documentElement，避免手机宿主 body 布局裁切');
  assert.deepEqual(bodyAppended, [panel.host, fabHost]); assert.equal(typeof fabOptions.onClick, 'function'); assert.equal(typeof foundationOptions.infoImpl, 'function');
  assert.equal(foundationOptions.uiDiagnosticProvider(), '{"schemaVersion":1}', '只读provider应在panel创建后导出界面诊断且不触发TDZ');
  assert.deepEqual(fabAppearances, [dayAppearance]); assert.deepEqual(inlineAppearances, [dayAppearance]);
  const nightAppearance = { mode: 'auto', effectiveTheme: 'night', palette: { knot: '#d9707a', line: '#2b363b' } };
  panelOptions.onAppearanceChange(nightAppearance);
  assert.equal(fabAppearances.at(-1), nightAppearance); assert.equal(inlineAppearances.at(-1), nightAppearance, '自动主题回调应同步楼内卡颜色');
  await fabOptions.onClick({ currentTarget: fabHost }); assert.equal(shows, 1); assert.equal(panel.host.hidden, false);
  await fabOptions.onClick({ currentTarget: fabHost }); assert.equal(closes, 1); assert.equal(panel.host.hidden, true);
  instance.setEnabled(false); assert.equal(fabHost.style.display, 'none'); instance.setEnabled(true); assert.equal(fabHost.style.display, '');
  current.fabShow = false; instance.setEnabled(true); assert.equal(fabHost.style.display, 'none', '悬浮球独立开关应与插件总开关共同决定显示');
});
