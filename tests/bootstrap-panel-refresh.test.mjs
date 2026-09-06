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
  let fabOptions, shows = 0, closes = 0; const appended = [];
  const fabHost = { style: {} };
  const bootstrap = await loadBootstrap({ './ui/fab.js': { createFab: options => { fabOptions = options; return { host: fabHost, setBusy() {} }; } } });
  const panel = { host: { hidden: true }, show() { shows += 1; this.host.hidden = false; return { status: 'ready' }; }, close() { closes += 1; this.host.hidden = true; }, setEnabled() {}, refresh: async () => ({ status: 'ready' }) };
  const stubView = () => ({ mount() {}, activate: async () => ({ status: 'ready' }), deactivate() {} });
  const instance = bootstrap({
    settings: { isEnabled: () => true }, enableFab: true,
    v3FoundationViewFactory: stubView, peopleProfilesViewFactory: stubView, peopleWorkspaceRuntime: { getState: () => ({}) },
    documentRef: { activeElement: null, defaultView: {}, getElementById: () => null, createElement: () => ({}), body: { append: node => appended.push(node) } },
    panelFactory: () => panel, wandInstaller() {},
  });
  assert.deepEqual(appended, [panel.host, fabHost]); assert.equal(typeof fabOptions.onClick, 'function');
  await fabOptions.onClick({ currentTarget: fabHost }); assert.equal(shows, 1); assert.equal(panel.host.hidden, false);
  await fabOptions.onClick({ currentTarget: fabHost }); assert.equal(closes, 1); assert.equal(panel.host.hidden, true);
  instance.setEnabled(false); assert.equal(fabHost.style.display, 'none'); instance.setEnabled(true); assert.equal(fabHost.style.display, '');
});
