import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function isolateBundle(hostGlobalName, { enabled = false, withExistingPanel = false, mainApi = 'openai', invokeTypes = [] } = {}) {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  const bundlePath = resolve(root, manifest.js.split('?')[0]);
  const eventRegistrations = new Map();
  const host = {
    characterId: 0, groupId: null, chatId: 'host-chat', characters: [{ avatar: 'char.png' }], userAvatar: 'me.png',
    chatMetadata: enabled ? { qianqianjie: { schemaVersion: 1, chatId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } } : {}, chat: [], mainApi,
    getRequestHeaders: () => ({}), eventTypes: { CHAT_CHANGED: 'chat', PERSONA_CHANGED: 'persona' },
    eventSource: { on(name) { eventRegistrations.set(name, (eventRegistrations.get(name) ?? 0) + 1); } },
  };
  let backendCalls = 0;
  let mesAppendCalls = 0;
  let styleAppendCalls = 0;
  let observerInstances = 0;
  let abortCalls = 0;
  const promptCalls = [];
  host.constants = { promptTypes: { IN_CHAT: 17 }, promptRoles: { SYSTEM: 29 } };
  host.setExtensionPrompt = (...args) => { promptCalls.push(args); };
  const message = {
    className: 'mes user-owned', dataset: { mesid: '0' }, children: [],
    getAttribute: name => name === 'mesid' ? '0' : null,
    querySelector: () => null,
    append(...nodes) { mesAppendCalls += nodes.length; this.children.push(...nodes); },
  };
  const existingPanel = { __qqjInstance: { show() {}, refresh() {}, setEnabled() {}, openMemory() {} } };
  const documentRef = withExistingPanel ? {
    body: { append() {} }, head: { append(...nodes) { styleAppendCalls += nodes.length; } },
    getElementById: id => id === 'qqj-panel-host' ? existingPanel : null,
    querySelectorAll: selector => selector === '.mes[mesid]' ? [message] : [],
    createElement: tag => ({ tag, dataset: {}, style: {}, children: [], append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = [...nodes]; }, addEventListener() {}, querySelector: () => null }),
  } : undefined;
  const context = createContext({
    console, crypto: globalThis.crypto, TextEncoder, TextDecoder, URL, URLSearchParams, AbortController, DOMException, structuredClone, setTimeout, clearTimeout,
    fetch: async () => {
      backendCalls += 1;
      if (enabled) return { ok: false, status: 404, async json() { return {}; } };
      throw new Error('disabled isolation must not fetch');
    },
    ...(documentRef ? { document: documentRef, MutationObserver: class { constructor() { observerInstances += 1; } observe() {} disconnect() {} } } : {}),
    [hostGlobalName]: { getContext: () => host },
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
    else if (path === '/scripts/extensions.js') module = synthetic(identifier, { extension_settings: { qianqianjie: { pluginEnabled: enabled }, 'schedule-planner': {} } });
    else if (path === '/script.js') module = synthetic(identifier, { isGenerating: () => false, saveSettingsDebounced() {} });
    else module = new SourceTextModule(await readFile(path, 'utf8'), { context, identifier });
    cache.set(identifier, module);
    return module;
  }
  const entry = await load(pathToFileURL(bundlePath).href);
  await entry.link((specifier, referencing) => load(new URL(specifier, referencing.identifier).href));
  await entry.evaluate();
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  for (const type of invokeTypes) await context.qqj_v3_recall_interceptor([], 8192, () => { abortCalls += 1; }, type);
  return { status: entry.status, backendCalls, eventRegistrations, mesAppendCalls, message, styleAppendCalls, observerInstances, interceptorType: typeof context.qqj_v3_recall_interceptor, promptCalls, abortCalls };
}

test('manifest 唯一加载 qqj-app，生产 bundle 无 V1 标记、相对 import 且可隔离加载', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  const cacheMatch = /^dist\/qqj-app\.js\?v=20260904\.3-([a-f0-9]{16})$/.exec(manifest.js);
  assert.ok(cacheMatch, '本批生产 bundle 必须使用新的 20260904.3 内容寻址 cache key');
  assert.equal(manifest.generate_interceptor, 'qqj_v3_recall_interceptor');
  assert.equal(manifest.version, '0.2.27');
  const bundlePath = resolve(root, manifest.js.split('?')[0]);
  const bundleSource = await readFile(bundlePath, 'utf8');
  const bundleDigest = createHash('sha256').update(bundleSource).digest('hex');
  assert.equal(cacheMatch[1], bundleDigest.slice(0, 16), 'manifest cache key 必须随实际 bundle 内容变化，禁止漏 bump 假通过');
  await assert.rejects(access(resolve(root, 'dist/index.js')));
  await assert.rejects(access(resolve(root, 'src/ui/v3-floor-cards.js')));
  await assert.rejects(access(resolve(root, 'src/v3/chat-fork-migrator.js')));
  assert.equal([...bundleSource.matchAll(/\b(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)/g)].length, 0);
  assert.equal(bundleSource.includes('createV3ChatForkMigrator'), false, '生产 bundle 不得残留跨聊天记忆搬运器');
  assert.equal(bundleSource.includes('qqj-v3-floor-card'), false, '生产 bundle 不得残留楼内卡片 DOM/CSS');
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
    constants: { promptTypes: { IN_CHAT: 1 }, promptRoles: { SYSTEM: 0 } },
    setExtensionPrompt() {},
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
    SillyTavern: { getContext: () => host },
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
    else if (path === '/script.js') module = synthetic(identifier, { isGenerating: () => false, saveSettingsDebounced() {} });
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
  assert.equal(typeof eventHandlers.get('received'), 'function');
  eventHandlers.get('chat')();
  eventHandlers.get('persona')();
  eventHandlers.get('received')();
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
  let v3MemoryOptions;
  let v3RecallOptions;
  let identityOptions;
  const inertComposition = () => ({ invalidate() {} });
  const modules = new Map();
  const define = (specifier, exports) => {
    modules.set(specifier, new SyntheticModule(Object.keys(exports), function initialize() {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context, identifier: `mock:${specifier}` }));
  };
  define('/scripts/personas.js', { user_avatar: 'me.png' });
  define('/scripts/extensions.js', { extension_settings: {} });
  const isGenerating = () => false;
  define('/script.js', { isGenerating, saveSettingsDebounced() {} });
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
  define('./src/chat-identity.js', { createChatIdentityCoordinator: options => { identityOptions = options; return { prepare() {} }; } });
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
  define('./src/v3/host-adapter.js', { createHostAdapter: () => ({ getContext: () => ({}), snapshot: () => ({}) }) });
  define('./src/v3/foundation-store.js', { createFoundationStore: () => ({}) });
  define('./src/v3/foundation-runtime.js', { createFoundationRuntime: () => ({ bind() {}, async start() {}, async setEnabled() {} }) });
  define('./src/v3/memory-runtime.js', { createV3MemoryRuntime: options => { v3MemoryOptions = options; return { bind() {}, async start() {}, async setEnabled() {}, getState: () => ({}), shouldBlockMainGeneration: () => false, allowsRealtimeTailFromEmpty: () => false }; } });
  define('./src/v3/recall-runtime.js', { createV3RecallRuntime: options => { v3RecallOptions = options; return { bind() {}, async setEnabled() {}, async intercept() {}, getState: () => ({}) }; } });

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
  assert.equal(v3MemoryOptions.generateUtilityTask, utilityTask);
  assert.equal(v3MemoryOptions.isMainGenerationActive, isGenerating);
  assert.equal(typeof v3MemoryOptions.sanitizerOptions, 'function');
  assert.equal(Object.hasOwn(identityOptions, 'sanitizerOptions'), false);
  assert.equal(Object.hasOwn(identityOptions, 'migrateFork'), false);
  assert.equal(Object.hasOwn(v3MemoryOptions, 'generatePrimaryTask'), false);
  assert.ok(v3RecallOptions.store);
  assert.ok(v3RecallOptions.hostAdapter);
  assert.equal(typeof v3RecallOptions.isEnabled, 'function');
  assert.equal(typeof v3RecallOptions.historicalMaintenance, 'function');
  assert.equal(typeof v3RecallOptions.realtimeOrigin, 'function');
  assert.equal(typeof context.qqj_v3_recall_interceptor, 'function');
});

test('生产 bundle 在 Luker-only 兼容全局下也可隔离加载，关闭时零后端请求', async () => {
  const result = await isolateBundle('Luker');
  assert.equal(result.status, 'evaluated');
  assert.equal(result.backendCalls, 0);
});

test('生产 bundle 在 Luker-only 且插件启用时真实进入身份绑定与旧 V3 root 核对路径', async () => {
  const result = await isolateBundle('Luker', { enabled: true });
  assert.equal(result.status, 'evaluated');
  assert.equal(result.backendCalls, 3, '依次读取绑定、核对旧 root，并尝试 CAS 认领');
});

test('生产 bundle 在 official-only 且插件启用时真实进入身份绑定与旧 V3 root 核对路径', async () => {
  const result = await isolateBundle('SillyTavern', { enabled: true });
  assert.equal(result.status, 'evaluated');
  assert.equal(result.backendCalls, 3, '依次读取绑定、核对旧 root，并尝试 CAS 认领');
});

test('生产 bundle 不向现有消息楼插入节点、样式或楼卡专属订阅', async () => {
  const result = await isolateBundle('SillyTavern', { withExistingPanel: true });
  assert.equal(result.status, 'evaluated');
  assert.equal(result.mesAppendCalls, 0);
  assert.deepEqual(result.message.children, []);
  assert.equal(result.message.className, 'mes user-owned');
  assert.equal(result.styleAppendCalls, 0);
  assert.equal(result.observerInstances, 0);
  assert.equal(result.eventRegistrations.get('chat'), 4, '仅保留 V2 lifecycle、V3 foundation、V3 memory、V3 recall 四份结构订阅');
  assert.equal(result.eventRegistrations.get('persona'), 1);
});

test('生产 bundle 的原生/Luker × Text/Chat 入口动态调用同一 recall seam，禁用时只清槽且绝不 abort', async () => {
  for (const hostGlobalName of ['SillyTavern', 'Luker']) for (const mainApi of ['openai', 'textgenerationwebui']) {
    const result = await isolateBundle(hostGlobalName, { mainApi, invokeTypes: ['normal', 'regenerate', 'swipe', 'continue'] });
    assert.equal(result.interceptorType, 'function', `${hostGlobalName}/${mainApi}`);
    assert.equal(result.abortCalls, 0, `${hostGlobalName}/${mainApi}`);
    assert.equal(result.backendCalls, 0, `${hostGlobalName}/${mainApi}`);
    assert.equal(result.promptCalls.length, 4, `${hostGlobalName}/${mainApi}`);
    for (const call of result.promptCalls) assert.deepEqual(call, ['qqj_v3_recalled_context', '', 17, 1, false, 29]);
  }
});
