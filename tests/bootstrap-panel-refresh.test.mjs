import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

async function loadBootstrap() {
  const context = createContext({ console });
  const source = await readFile(new URL('../src/bootstrap.js', import.meta.url), 'utf8');
  const entry = new SourceTextModule(source, { context, identifier: new URL('../src/bootstrap.js', import.meta.url).href });
  const factories = {
    './ui/panel.js': { createPanel: () => null },
    './ui/fab.js': { createFab: () => ({ host: null }) },
    './ui/wand-entry.js': { installWandEntry() {} },
    './ui/archive-v2-initialization-view.js': { createArchiveV2InitializationView: () => null },
    './ui/archive-v2-bond-view.js': { createArchiveV2BondView: () => null },
    './ui/archive-v2-source-permission-view.js': { createArchiveV2SourcePermissionView: () => null },
    './ui/v3-foundation-view.js': { createV3FoundationView: () => null },
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
    archiveV2ViewFactory: stubView,
    archiveV2BondViewFactory: stubView,
    v3FoundationViewFactory: () => ({ ...stubView(), deactivate() { deactivations.foundation += 1; } }),
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
