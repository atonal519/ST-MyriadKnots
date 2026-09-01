import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('manifest 唯一加载 qqj-app，生产 bundle 无 V1 标记、相对 import 且可隔离加载', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.js, 'dist/qqj-app.js?v=20260901.22');
  assert.equal(manifest.version, '0.2.27');
  const bundlePath = resolve(root, manifest.js.split('?')[0]);
  const bundleSource = await readFile(bundlePath, 'utf8');
  await assert.rejects(access(resolve(root, 'dist/index.js')));
  assert.equal([...bundleSource.matchAll(/\b(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)/g)].length, 0);
  for (const marker of ['qianqianjie-demo', 'identity-cards', 'identity-personas', 'chat-meta', 'initial-relation-generation', 'people-foundation']) {
    assert.equal(bundleSource.includes(marker), false, `bundle 残留 V1 标记：${marker}`);
  }

  const eventHandlers = new Map();
  let aiCalls = 0;
  let backendCalls = 0;
  let metadataWrites = 0;
  let registrations = 0;
  const host = {
    characterId: 0,
    groupId: null,
    chatId: 'host-chat',
    characters: [{ avatar: 'char.png' }],
    userAvatar: 'me.png',
    chatMetadata: {},
    chat: [],
    saveMetadata: async () => { metadataWrites += 1; },
    getRequestHeaders: () => ({}),
    eventTypes: { CHAT_CHANGED: 'chat', PERSONA_CHANGED: 'persona', MESSAGE_SENT: 'sent', MESSAGE_RECEIVED: 'received' },
    eventSource: { on: (name, handler) => eventHandlers.set(name, handler) },
    registerExtensionApi: () => { registrations += 1; },
    generateTask: async () => { aiCalls += 1; throw new Error('isolation load must not call AI'); },
  };
  const context = createContext({
    console,
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    AbortController,
    DOMException,
    structuredClone,
    setTimeout,
    clearTimeout,
    fetch: async () => { backendCalls += 1; throw new Error('isolation load must not fetch'); },
    Luker: { getContext: () => host },
  });
  const cache = new Map();
  const synthetic = (identifier, exports) => new SyntheticModule(Object.keys(exports), function initialize() {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context, identifier });
  async function load(identifier) {
    if (cache.has(identifier)) return cache.get(identifier);
    const path = fileURLToPath(identifier);
    let module;
    if (path === '/scripts/personas.js') module = synthetic(identifier, { user_avatar: 'me.png' });
    else if (path === '/scripts/extensions.js') module = synthetic(identifier, { extension_settings: { qianqianjie: { pluginEnabled: false }, 'schedule-planner': {} } });
    else if (path === '/script.js') module = synthetic(identifier, { saveSettingsDebounced() {} });
    else module = new SourceTextModule(await readFile(path, 'utf8'), { context, identifier });
    cache.set(identifier, module);
    return module;
  }
  const entry = await load(pathToFileURL(bundlePath).href);
  assert.deepEqual((entry.moduleRequests || []).map(item => item.specifier), ['/scripts/personas.js', '/scripts/extensions.js', '/script.js']);
  await entry.link((specifier, referencing) => load(new URL(specifier, referencing.identifier).href));
  await entry.evaluate();
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.equal(entry.status, 'evaluated');
  assert.equal(aiCalls, 0);
  assert.equal(backendCalls, 0);
  assert.equal(metadataWrites, 0);
  assert.equal(registrations, 0);
  assert.equal(typeof eventHandlers.get('chat'), 'function');
  assert.equal(typeof eventHandlers.get('persona'), 'function');
  assert.equal(eventHandlers.has('sent'), false);
  assert.equal(eventHandlers.has('received'), false);
  eventHandlers.get('chat')();
  eventHandlers.get('persona')();
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.equal(aiCalls, 0);
  assert.equal(backendCalls, 0);
  assert.equal(metadataWrites, 0);
});

test('生产入口行为接线：memory 同时收到主/副 API，关注人设只收到副 API', async () => {
  const context = createContext({ console });
  const entrySource = await readFile(resolve(root, 'index.js'), 'utf8');
  const primaryTask = async () => ({ jsonData: 'primary' });
  const utilityTask = async () => ({ jsonData: 'utility' });
  assert.notEqual(primaryTask, utilityTask);

  let memoryOptions;
  let followedOptions;
  let bondOptions;
  const inertComposition = () => ({ invalidate() {} });
  const modules = new Map();
  const define = (specifier, exports) => {
    modules.set(specifier, new SyntheticModule(Object.keys(exports), function initialize() {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context, identifier: `mock:${specifier}` }));
  };
  define('/scripts/personas.js', { user_avatar: 'me.png' });
  define('/scripts/extensions.js', { extension_settings: {} });
  define('/script.js', { saveSettingsDebounced() {} });
  define('./src/backend-client.js', { createBackendClient: () => ({}) });
  define('./src/bootstrap.js', { bootstrap: () => ({ refresh() {}, setEnabled() {} }) });
  define('./src/settings.js', { createSettingsStore: () => ({ migrateLegacyApiSettings() {}, isEnabled: () => false, get: () => ({}) }) });
  define('./src/api-routing.js', {
    createApiResolver: () => ({}),
    createApiTools: () => ({ abortAll() {} }),
    createArchiveV2TaskRouter: () => ({ generatePrimaryTask: primaryTask, generateUtilityTask: utilityTask, abortAll() {} }),
  });
  define('./src/compact-api-client.js', { createCompactApiClient: () => ({}) });
  define('./src/archive-v2-session.js', { createArchiveV2Session: () => ({ prepare() {} }) });
  define('./src/archive-v2-lifecycle.js', {
    createArchiveV2Lifecycle: () => ({ bind() {}, async start() {} }),
  });
  define('./src/archive-v2-composition.js', { createArchiveV2Composition: inertComposition });
  define('./src/archive-v2-memory-composition.js', {
    createArchiveV2MemoryComposition: options => { memoryOptions = options; return inertComposition(); },
  });
  define('./src/archive-v2-followed-profile-composition.js', {
    createArchiveV2FollowedProfileComposition: options => { followedOptions = options; return inertComposition(); },
  });
  define('./src/archive-v2-dossier-composition.js', { createArchiveV2DossierComposition: inertComposition });
  define('./src/archive-v2-bond-composition.js', {
    createArchiveV2BondComposition: options => { bondOptions = options; return inertComposition(); },
  });
  define('./src/archive-v2-source-permission.js', { createArchiveV2SourcePermissionController: () => ({}) });

  const entry = new SourceTextModule(entrySource, { context, identifier: pathToFileURL(resolve(root, 'index.js')).href });
  await entry.link(specifier => {
    const dependency = modules.get(specifier);
    assert.ok(dependency, `未声明的生产入口依赖：${specifier}`);
    return dependency;
  });
  await entry.evaluate();
  await new Promise(resolvePromise => setImmediate(resolvePromise));

  assert.equal(memoryOptions.generatePrimaryTask, primaryTask);
  assert.equal(memoryOptions.generateUtilityTask, utilityTask);
  assert.equal(followedOptions.generateUtilityTask, utilityTask);
  assert.equal(Object.hasOwn(followedOptions, 'generatePrimaryTask'), false);
  assert.equal(bondOptions.generateUtilityTask, utilityTask);
  assert.equal(Object.hasOwn(bondOptions, 'generatePrimaryTask'), false);
});
