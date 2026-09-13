import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function isolateBundle(hostGlobalName, { enabled = false, withExistingPanel = false, mainApi = 'openai', invokeTypes = [], initializeWithoutSubtle = false } = {}) {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  const bundlePath = process.env.QQJ_TEST_BUNDLE ? resolve(process.env.QQJ_TEST_BUNDLE) : resolve(root, manifest.js.split('?')[0]);
  const eventRegistrations = new Map();
  const backendRecords = new Map();
  let hostShaCalls = 0;
  const hostShaInputs = [];
  const host = {
    characterId: 0, groupId: null, chatId: 'host-chat', characters: [{ avatar: 'char.png' }], userAvatar: 'me.png',
    chatMetadata: enabled ? { qianqianjie: { schemaVersion: 1, chatId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } } : {},
    chat: initializeWithoutSubtle ? [
      { is_user: false, is_system: false, mes: '产物指纹🙂', swipes: ['产物指纹🙂'], swipe_id: 0 },
      { is_user: true, is_system: false, mes: '确认', send_date: '2026-09-13T00:00:00.000Z' },
    ] : [],
    mainApi,
    uuidv4: () => '11111111-1111-4111-8111-111111111111',
    async saveMetadata() {},
    getRequestHeaders: () => ({}), eventTypes: { CHAT_CHANGED: 'chat', PERSONA_CHANGED: 'persona' },
    eventSource: { on(name) { eventRegistrations.set(name, (eventRegistrations.get(name) ?? 0) + 1); } },
  };
  if (initializeWithoutSubtle) backendRecords.set('/api/plugins/st-bainiaodata/v1/records/qianqianjie/chat-identity-bindings/binding-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
    revision: 1,
    data: {
      schemaVersion: 1, kind: 'qqj-chat-identity-binding', chatId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      owner: { hostChatId: 'host-chat', characterLocator: 'char.png', personaLocator: 'me.png' },
      state: 'ready', sourceChatId: null, createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z',
    },
  });
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
    console, crypto: initializeWithoutSubtle ? {} : globalThis.crypto, TextEncoder, TextDecoder, URL, URLSearchParams, AbortController, DOMException, structuredClone, setTimeout, clearTimeout,
    fetch: async (url, options = {}) => {
      backendCalls += 1;
      if (initializeWithoutSubtle) {
        const record = backendRecords.get(String(url));
        return record
          ? { ok: true, status: 200, async json() { return structuredClone(record); } }
          : { ok: false, status: 404, async json() { return {}; } };
      }
      if (enabled) return { ok: false, status: 404, async json() { return {}; } };
      throw new Error('disabled isolation must not fetch');
    },
    ...(documentRef ? { document: documentRef, MutationObserver: class { constructor() { observerInstances += 1; } observe() {} disconnect() {} } } : {}),
    [hostGlobalName]: {
      getContext: () => host,
      ...(initializeWithoutSubtle ? { libs: { sha256(bytes) { hostShaCalls += 1; hostShaInputs.push(new Uint8Array(bytes)); return createHash('sha256').update(bytes).digest('hex'); } } } : {}),
    },
  });
  const cache = new Map();
  const synthetic = (identifier, exports) => new SyntheticModule(Object.keys(exports), function initialize() {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context, identifier });
  async function load(identifier) {
    if (cache.has(identifier)) return cache.get(identifier);
    const path = fileURLToPath(identifier);
    // Host imports use URL-root paths on Windows as well as POSIX.
    const hostPath = new URL(identifier).pathname.replace(new RegExp('^/[A-Za-z]:'), '');
    let module;
    if (hostPath === '/scripts/personas.js') module = synthetic(identifier, { user_avatar: 'me.png' });
    else if (hostPath === '/scripts/extensions.js') module = synthetic(identifier, { extension_settings: { qianqianjie: { pluginEnabled: enabled }, 'schedule-planner': {} }, extensionNames: [] });
    else if (hostPath === '/script.js') module = synthetic(identifier, { is_send_press: false, saveSettingsDebounced() {} });
    else if (hostPath === '/scripts/group-chats.js') module = synthetic(identifier, { is_group_generating: false });
    else if (hostPath === '/scripts/world-info.js') module = synthetic(identifier, { loadWorldInfo: async () => null, selected_world_info: [], world_info: {}, world_info_case_sensitive: false, world_info_match_whole_words: false, world_names: [] });
    else module = new SourceTextModule(await readFile(path, 'utf8'), { context, identifier });
    cache.set(identifier, module);
    return module;
  }
  const entryPath = process.env.QQJ_TEST_BUNDLE ? resolve(process.env.QQJ_TEST_BUNDLE) : bundlePath;
  const entry = await load(pathToFileURL(entryPath).href);
  await entry.link((specifier, referencing) => load(new URL(specifier, referencing.identifier).href));
  await entry.evaluate();
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  if (initializeWithoutSubtle) {
    for (let attempt = 0; attempt < 200 && hostShaCalls === 0; attempt += 1) {
      await new Promise(resolvePromise => setImmediate(resolvePromise));
    }
  }
  for (const type of invokeTypes) await context.qqj_v3_recall_interceptor([], 8192, () => { abortCalls += 1; }, type);
  const publicBridgeReadStatus = enabled ? null : (await context.qqj_v3_public_bridge_v1?.readMemory?.())?.status;
  const publicBridgeSnapshotType = typeof context.qqj_v3_public_bridge_v1?.getSnapshot;
  const publicBridgeSnapshotStatus = enabled ? null : context.qqj_v3_public_bridge_v1?.getSnapshot?.()?.status;
  return { status: entry.status, backendCalls, backendRecords, hostShaCalls, hostShaInputs, eventRegistrations, mesAppendCalls, message, styleAppendCalls, observerInstances, interceptorType: typeof context.qqj_v3_recall_interceptor, publicBridgeType: typeof context.qqj_v3_public_bridge_v1, publicBridgeReadStatus, publicBridgeSnapshotType, publicBridgeSnapshotStatus, promptCalls, abortCalls };
}

test('实际生产 bundle 缺少 crypto.subtle 时经宿主 SHA 完成身份认领与地基指纹扫描', async () => {
  const result = await isolateBundle('SillyTavern', { enabled: true, initializeWithoutSubtle: true });
  const bindings = [...result.backendRecords.values()].filter(record => record.data?.kind === 'qqj-chat-identity-binding');
  assert.equal(result.status, 'evaluated');
  assert.equal(result.hostShaCalls > 0, true, '实际 bundle 内部没有调用宿主 SHA 接口');
  assert.equal(bindings.length, 1, '实际 bundle 没有完成聊天身份认领');
  assert.equal(result.hostShaInputs.some(bytes => new TextDecoder().decode(bytes) === '产物指纹🙂'), true, '实际地基扫描没有计算正文指纹');
});

test('manifest 唯一加载 qqj-app，生产 bundle 无 V1 标记、相对 import 且可隔离加载', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  const cacheMatch = /^dist\/qqj-app\.js\?v=(\d{4})(\d{2})(\d{2})\.([1-9]\d*)-([a-f0-9]{16})$/.exec(manifest.js);
  assert.ok(cacheMatch, '生产 bundle 必须使用日期、递增序号与内容哈希组成的 cache key');
  const [, year, month, day] = cacheMatch;
  const cacheDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  assert.equal(cacheDate.toISOString().slice(0, 10), `${year}-${month}-${day}`, 'cache key 必须包含合法日期');
  assert.equal(manifest.generate_interceptor, 'qqj_v3_recall_interceptor');
  assert.equal(manifest.version, '0.1.19');
  const bundlePath = resolve(root, manifest.js.split('?')[0]);
  const bundleSource = await readFile(bundlePath, 'utf8');
  const bundleDigest = createHash('sha256').update(bundleSource).digest('hex');
  assert.equal(cacheMatch[5], bundleDigest.slice(0, 16), 'manifest cache key 必须随实际 bundle 内容变化，禁止漏 bump 假通过');
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
    const hostPath = new URL(identifier).pathname.replace(new RegExp('^/[A-Za-z]:'), '');
    let module;
    if (hostPath === '/scripts/personas.js') module = synthetic(identifier, { user_avatar: 'me.png' });
    else if (hostPath === '/scripts/extensions.js') module = synthetic(identifier, { extension_settings: { qianqianjie: { pluginEnabled: false }, 'schedule-planner': {} }, extensionNames: [] });
    else if (hostPath === '/script.js') module = synthetic(identifier, { is_send_press: false, saveSettingsDebounced() {} });
    else if (hostPath === '/scripts/group-chats.js') module = synthetic(identifier, { is_group_generating: false });
    else if (hostPath === '/scripts/world-info.js') module = synthetic(identifier, { loadWorldInfo: async () => null, selected_world_info: [], world_info: {}, world_info_case_sensitive: false, world_info_match_whole_words: false, world_names: [] });
    else module = new SourceTextModule(await readFile(path, 'utf8'), { context, identifier });
    cache.set(identifier, module);
    return module;
  }
  const entryPath = process.env.QQJ_TEST_BUNDLE ? resolve(process.env.QQJ_TEST_BUNDLE) : bundlePath;
  const entry = await load(pathToFileURL(entryPath).href);
  await entry.link((specifier, referencing) => load(new URL(specifier, referencing.identifier).href));
  assert.deepEqual((entry.moduleRequests || []).map(item => item.specifier), ['/scripts/personas.js', '/scripts/extensions.js', '/script.js', '/scripts/group-chats.js', '/scripts/world-info.js']);
  await entry.evaluate();
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.equal(entry.status, 'evaluated');
  assert.equal(aiCalls, 0);
  assert.equal(backendCalls, 0);
  assert.equal(metadataWrites, 0);
  assert.equal(registrations, 0);
  assert.equal(typeof eventHandlers.get('chat'), 'function');
  assert.equal(typeof eventHandlers.get('persona'), 'function');
  assert.equal(typeof eventHandlers.get('sent'), 'function');
  assert.equal(typeof eventHandlers.get('received'), 'function');
  eventHandlers.get('chat')();
  eventHandlers.get('persona')();
  eventHandlers.get('sent')();
  eventHandlers.get('received')();
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.equal(aiCalls, 0);
  assert.equal(backendCalls, 0);
  assert.equal(metadataWrites, 0);
});

test('生产入口行为接线：V3 memory 区分分析与摘要 API，session/lifecycle 与 recall 保持装配', async () => {
  const context = createContext({ console });
  const entrySource = await readFile(resolve(root, 'index.js'), 'utf8');
  const utilityTask = async () => ({ jsonData: 'utility' });
  const analysisTask = async () => ({ jsonData: 'analysis' });

  let v3MemoryOptions;
  let v3MemoryRuntime;
  let v3RecallOptions;
  let identityOptions;
  let sessionOptions;
  let lifecycleOptions;
  let peopleWorkspaceOptions;
  let peopleStoreOptions;
  let publicMemoryBridgeOptions;
  let autoHideOptions;
  let memoryManagementOptions;
  let chatMemoryManagement;
  let inlineRendererOptions;
  let hostAdapterOptions;
  const inlineEnabled = [];
  const backgroundStarts = [];
  const runtimeEnables = [];
  let bootstrapOptions;
  let compactOptions;
  let foundationOptions;
  let v3MemoryBindOptions;
  const sessionState = { status: 'preparing' };
  const anchorCalls = [];
  const persistAnchors = async options => { anchorCalls.push(options); return { status: 'persisted' }; };
  const productionEventSource = { on() {}, removeListener() {} };
  const productionEventTypes = { CHAT_CHANGED: 'chat', GENERATION_STARTED: 'generation-started', MESSAGE_SENT: 'sent' };
  const hostUuid = '123e4567-e89b-42d3-a456-426614174000';
  let hostUuidCalls = 0;
  const uuidv4 = () => { hostUuidCalls += 1; return hostUuid; };
  const modules = new Map();
  const define = (specifier, exports) => {
    const module = new SyntheticModule(Object.keys(exports), function initialize() {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context, identifier: `mock:${specifier}` });
    modules.set(specifier, module);
    return module;
  };
  define('/scripts/personas.js', { user_avatar: 'me.png' });
  define('/scripts/extensions.js', { extension_settings: { disabledExtensions: [] }, extensionNames: ['third-party/ST-SevenDaysCal'] });
  const scriptModule = define('/script.js', { is_send_press: false, saveSettingsDebounced() {} });
  const groupModule = define('/scripts/group-chats.js', { is_group_generating: false });
  const nativeWorld = { entries: {} };
  const nativeWorldSettings = { charLore: [] };
  define('/scripts/world-info.js', { loadWorldInfo: async () => nativeWorld, selected_world_info: ['全局书'], world_info: nativeWorldSettings, world_info_case_sensitive: true, world_info_match_whole_words: true, world_names: ['全局书'] });
  define('./manifest.json', { version: '0.1.9-test' });
  const backendSnapshot = { sinceClientCreatedRequestCounts: { get: 3, put: 1, delete: 0 }, latestRead: null, latestWrite: null, lastFailure: null };
  const backendClient = { getDiagnosticSnapshot: () => backendSnapshot };
  define('./src/backend-client.js', { createBackendClient: () => backendClient });
  define('./src/bootstrap.js', { bootstrap: options => { bootstrapOptions = options; return { refresh() {}, setEnabled() {} }; } });
  define('./src/settings.js', { createSettingsStore: () => ({ migrateLegacyApiSettings() {}, isEnabled: () => false, get: () => ({ generalPrompt: '旧通用附加残留', processingPrompt: '  破限接线\n', summaryPrompt: '摘要指导', csePrompt: 'CSE 指导', profilePrompt: '人物资料指导' }) }) });
  define('./src/api-routing.js', {
    createApiResolver: () => ({}),
    createApiTools: () => ({ abortAll() {} }),
    createTaskRouter: () => ({ generateAnalysisTask: analysisTask, generateUtilityTask: utilityTask, abortAll() {} }),
  });
  define('./src/compact-api-client.js', { createCompactApiClient: options => { compactOptions = options; return {}; } });
  define('./src/chat-session.js', { createChatSession: options => {
    sessionOptions = options;
    return { prepare: () => options.identityCoordinator.prepare(), identity: () => ({ chatId: 'test' }), invalidate() {}, getState: () => sessionState };
  } });
  define('./src/chat-identity.js', { createChatIdentityCoordinator: options => { identityOptions = options; return { prepare: () => options.freshUuid() }; } });
  define('./src/chat-memory-management.js', { createChatMemoryManagement: options => { memoryManagementOptions = options; chatMemoryManagement = { getState: () => ({ status: 'idle' }), deleteCurrent() {} }; return chatMemoryManagement; } });
  define('./src/plugin-lifecycle.js', {
    createPluginLifecycle: options => {
      lifecycleOptions = options;
      return {
        bind() {},
        async start() {},
        async setEnabled(value) {
          runtimeEnables.push(`lifecycle:${value}`);
          if (value === true) {
            await options.session.prepare();
            await options.onPrepared?.({ result: { status: 'ready', identity: { chatId: 'test' } }, isCurrent: () => true });
          }
        },
      };
    },
  });
  define('./src/source-permission.js', { createSourcePermissionController: () => ({}) });
  define('./src/v3/host-adapter.js', { createHostAdapter: options => { hostAdapterOptions = options; return { getContext: () => ({ eventSource: productionEventSource, eventTypes: productionEventTypes, uuidv4 }), snapshot: () => ({}) }; } });
  define('./src/v3/foundation-store.js', { createFoundationStore: () => ({}) });
  define('./src/v3/foundation-runtime.js', { createFoundationRuntime: options => { foundationOptions = options; return {}; } });
  define('./src/v3/memory-runtime.js', { createV3MemoryRuntime: options => { v3MemoryOptions = options; v3MemoryRuntime = { bind(bindOptions) { v3MemoryBindOptions = bindOptions; }, async start() { backgroundStarts.push('memory'); }, async setEnabled(value) { runtimeEnables.push(`memory:${value}`); }, getState: () => ({}), shouldBlockMainGeneration: () => false, allowsRealtimeTailFromEmpty: () => false }; return v3MemoryRuntime; } });
  define('./src/v3/message-floor-anchor.js', { persistMessageFloorAnchors: persistAnchors });
  define('./src/v3/recall-runtime.js', { createV3RecallRuntime: options => { v3RecallOptions = options; return { bind() {}, async setEnabled(value) { runtimeEnables.push(`recall:${value}`); }, async intercept() {}, getState: () => ({}) }; } });
  define('./src/v3/auto-hide.js', { createAutoHideController: options => { autoHideOptions = options; return { applySettings() {}, stop() {}, dispose() {} }; } });
  define('./src/ui/inline-renderer.js', { createInlineRenderer: options => { inlineRendererOptions = options; return { setEnabled(value) { inlineEnabled.push(value); }, destroy() {} }; } });
  const peopleWorkspaceRuntime = { async refresh(options) { backgroundStarts.push(['people', options]); }, async setEnabled(value) { runtimeEnables.push(`people:${value}`); }, invalidate() {}, getState: () => ({ status: 'ready' }) };
  define('./src/v3/people-workspace.js', {
    createPeopleWorkspaceStore: options => { peopleStoreOptions = options; return { read() {}, put() {} }; },
    createPeopleWorkspaceRuntime: options => { peopleWorkspaceOptions = options; return peopleWorkspaceRuntime; },
  });
  define('./src/v3/public-memory-bridge.js', { installPublicMemoryBridge: options => { publicMemoryBridgeOptions = options; return { bridge: {}, cleanup() {} }; } });
  define('./src/story-clock.js', { createMyKnotsStoryClockController: () => ({ refresh: () => ({ status: 'closed' }), getState: () => ({ status: 'closed' }), clear() {} }), createStoryClockStatusProjection: ({ controller, labelFor }) => options => ({ ...controller.refresh(options), label: labelFor(controller.getState()) }), extensionStoryClockState: () => ({ active: false, custom: false }) });

  const entry = new SourceTextModule(entrySource, { context, identifier: pathToFileURL(resolve(root, 'index.js')).href });
  await entry.link(specifier => {
    const dependency = modules.get(specifier);
    assert.ok(dependency, `未声明的生产入口依赖：${specifier}`);
    return dependency;
  });
  await entry.evaluate();
  await new Promise(resolvePromise => setImmediate(resolvePromise));

  assert.equal(v3MemoryOptions.generateAnalysisTask, analysisTask);
  assert.equal(v3MemoryOptions.generateUtilityTask, utilityTask);
  assert.notEqual(v3MemoryOptions.generateAnalysisTask, v3MemoryOptions.generateUtilityTask);
  assert.equal(await hostAdapterOptions.worldInfoBindings.loadWorldInfo('全局书'), nativeWorld);
  assert.deepEqual(hostAdapterOptions.worldInfoBindings.getSelectedWorldInfo(), ['全局书']);
  assert.equal(hostAdapterOptions.worldInfoBindings.getWorldInfoSettings(), nativeWorldSettings);
  assert.deepEqual(hostAdapterOptions.worldInfoBindings.getWorldInfoNames(), ['全局书']);
  assert.equal(hostAdapterOptions.worldInfoBindings.getDefaultCaseSensitive(), true);
  assert.equal(hostAdapterOptions.worldInfoBindings.getDefaultMatchWholeWords(), true);
  assert.equal(v3MemoryOptions.isMainGenerationActive(), false);
  scriptModule.setExport('is_send_press', true); assert.equal(v3MemoryOptions.isMainGenerationActive(), true, '单聊生成状态必须读取宿主实时导出');
  scriptModule.setExport('is_send_press', false); groupModule.setExport('is_group_generating', true); assert.equal(v3MemoryOptions.isMainGenerationActive(), true, '群聊生成状态必须参与同一 OR 判断');
  groupModule.setExport('is_group_generating', false); assert.equal(v3MemoryOptions.isMainGenerationActive(), false);
  assert.equal(Object.hasOwn(v3MemoryOptions, 'customGuidance'), false, '退役通用附加不得继续接入运行时');
  assert.equal(v3MemoryOptions.extractorPromptGuidance(), '摘要指导');
  assert.equal(v3MemoryOptions.csePromptGuidance(), 'CSE 指导');
  assert.equal(v3MemoryOptions.processingPrompt(), '  破限接线\n');
  assert.equal(typeof v3MemoryOptions.sanitizerOptions, 'function');
  assert.equal(v3MemoryOptions.persistAnchors, persistAnchors, '生产入口必须把真实消息挂标能力注入 memory runtime');
  assert.equal(Object.hasOwn(foundationOptions, 'persistAnchors'), false, 'foundation runtime 不得吞掉挂标能力');
  assert.deepEqual(await v3MemoryOptions.persistAnchors({ probe: true }), { status: 'persisted' });
  assert.deepEqual(anchorCalls, [{ probe: true }], '注入的挂标函数必须可由 memory runtime 实际调用');
  assert.equal(v3MemoryBindOptions.eventSource, productionEventSource);
  assert.equal(v3MemoryBindOptions.eventTypes.MESSAGE_SENT, 'sent', '生产 memory runtime 必须接到真实 user 消息事件');
  assert.equal(Object.hasOwn(identityOptions, 'sanitizerOptions'), false);
  assert.equal(Object.hasOwn(identityOptions, 'migrateFork'), false);
  assert.equal(context.crypto, undefined, '入口接线回归必须在浏览器 crypto.randomUUID 不可用时验证');
  assert.equal(identityOptions.freshUuid, foundationOptions.newUuid);
  assert.equal(identityOptions.freshUuid, v3MemoryOptions.newUuid, '身份、地基、记忆及其 CSE 必须共用宿主 UUID provider');
  assert.equal(foundationOptions.newUuid(), hostUuid);
  assert.equal(v3MemoryOptions.newUuid(), hostUuid);
  assert.equal(hostUuidCalls, 2);
  assert.equal(Object.hasOwn(v3MemoryOptions, 'generatePrimaryTask'), false);
  assert.equal(typeof sessionOptions.contextProvider, 'function');
  assert.ok(sessionOptions.identityCoordinator);
  assert.ok(lifecycleOptions.session);
  assert.equal(lifecycleOptions.aborters.length, 3);
  assert.ok(lifecycleOptions.aborters.includes(peopleWorkspaceRuntime));
  assert.equal(typeof lifecycleOptions.onPrepared, 'function', '生产入口必须把身份成功后的后台续接注入 lifecycle');
  assert.deepEqual(backgroundStarts, [], '插件初始关闭时不得绕过 lifecycle 单独启动 memory/people');
  await bootstrapOptions.onPluginEnabledChange(true);
  assert.equal(hostUuidCalls, 3, '关闭后打开插件的身份准备必须调用宿主 uuidv4 且不依赖浏览器 crypto.randomUUID');
  assert.equal(backgroundStarts[0], 'memory');
  assert.equal(backgroundStarts[1]?.[0], 'people');
  assert.equal(backgroundStarts[1]?.[1]?.refreshMemory, false, '人物 workspace 应复用刚完成的记忆快照');
  assert.equal(backgroundStarts.length, 2, '同一身份成功链只准备一次记忆和一次人物 workspace');
  assert.deepEqual(runtimeEnables, ['lifecycle:true', 'recall:true'], '启用链不得在 lifecycle 回调后重复 setEnabled 读取 memory/people');
  assert.equal(peopleStoreOptions.client, backendClient);
  assert.equal(peopleWorkspaceOptions.generateUtilityTask, utilityTask);
  assert.equal(peopleWorkspaceOptions.profilePromptGuidance(), '人物资料指导');
  assert.equal(peopleWorkspaceOptions.processingPrompt(), '  破限接线\n');
  assert.ok(peopleWorkspaceOptions.session); assert.ok(peopleWorkspaceOptions.foundationRuntime); assert.ok(peopleWorkspaceOptions.memoryRuntime);
  assert.equal(bootstrapOptions.peopleWorkspaceRuntime, peopleWorkspaceRuntime);
  assert.equal(bootstrapOptions.chatMemoryManagement, chatMemoryManagement);
  assert.deepEqual(bootstrapOptions.sessionStateProvider(), sessionState);
  assert.deepEqual(bootstrapOptions.backendDiagnosticProvider(), backendSnapshot);
  assert.equal(bootstrapOptions.pluginVersion, '0.1.9-test');
  assert.equal(bootstrapOptions.enableFab, true);
  assert.equal(typeof bootstrapOptions.subscribeDialogContextChange, 'function');
  assert.equal(bootstrapOptions.isSevenDaysAvailable(), true);
  assert.equal(typeof compactOptions.onBusyChange, 'function');
  assert.ok(publicMemoryBridgeOptions.session);
  assert.ok(publicMemoryBridgeOptions.store);
  assert.ok(publicMemoryBridgeOptions.hostAdapter);
  assert.equal(publicMemoryBridgeOptions.foundationRuntime, v3MemoryOptions.foundationRuntime, '公共记忆桥必须复用生产地基 runtime');
  assert.equal(publicMemoryBridgeOptions.memoryRuntime, v3MemoryRuntime, '结构化快照必须复用生产 memory runtime');
  assert.equal(publicMemoryBridgeOptions.peopleRuntime, peopleWorkspaceRuntime, '结构化快照必须复用生产 people runtime');
  assert.equal(typeof publicMemoryBridgeOptions.isEnabled, 'function');
  assert.equal(typeof publicMemoryBridgeOptions.sanitizerOptions, 'function');
  assert.ok(v3RecallOptions.store);
  assert.ok(v3RecallOptions.hostAdapter);
  assert.equal(v3RecallOptions.generateUtilityTask, utilityTask);
  assert.equal(Object.hasOwn(v3RecallOptions, 'processingPrompt'), false, '召回链不得接入破限提示词');
  assert.equal(v3RecallOptions.pluginVersion, '0.1.9-test', '生产回执版本必须由 manifest.version 单一注入');
  assert.ok(autoHideOptions.hostAdapter); assert.equal(autoHideOptions.memoryRuntime, v3MemoryRuntime);
  assert.equal(inlineRendererOptions.memoryRuntime, v3MemoryRuntime); assert.equal(inlineRendererOptions.recallRuntime.getState() !== undefined, true); assert.ok(inlineRendererOptions.hostAdapter);
  assert.deepEqual(inlineEnabled, [false, true], '入口初始按关闭状态停用楼内渲染，启用链再同步开启');
  assert.equal(memoryManagementOptions.client, backendClient); assert.equal(memoryManagementOptions.session, lifecycleOptions.session); assert.equal(memoryManagementOptions.memoryRuntime, v3MemoryRuntime); assert.equal(typeof memoryManagementOptions.isMainGenerationActive, 'function');
  assert.equal(typeof v3RecallOptions.isEnabled, 'function');
  assert.equal(Object.hasOwn(v3RecallOptions, 'historicalMaintenance'), false);
  assert.equal(typeof v3RecallOptions.realtimeOrigin, 'function');
  assert.equal(typeof context.qqj_v3_recall_interceptor, 'function');
});

test('生产 bundle 在 Luker-only 兼容全局下也可隔离加载，关闭时零后端请求', async () => {
  const result = await isolateBundle('Luker');
  assert.equal(result.status, 'evaluated');
  assert.equal(result.publicBridgeType, 'object');
  assert.equal(result.publicBridgeReadStatus, 'disabled');
  assert.equal(result.publicBridgeSnapshotType, 'function');
  assert.equal(result.publicBridgeSnapshotStatus, 'disabled');
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
  const clockCalls = result.promptCalls.filter(call => call[0] === 'myknots_story_clock');
  assert.deepEqual(clockCalls[0], ['myknots_story_clock', '']);
  assert.equal(clockCalls.length, 2);
  assert.match(clockCalls[1][1], /<!-- QQJ-start/);
  assert.match(clockCalls[1][1], /<!-- QQJ-end/);
  assert.deepEqual(clockCalls[1].slice(2), [17, 0, false, 29]);
});

test('生产 bundle 不向现有消息楼插入节点、样式或楼卡专属订阅', async () => {
  const result = await isolateBundle('SillyTavern', { withExistingPanel: true });
  assert.equal(result.status, 'evaluated');
  assert.equal(result.mesAppendCalls, 0);
  assert.deepEqual(result.message.children, []);
  assert.equal(result.message.className, 'mes user-owned');
  assert.equal(result.styleAppendCalls, 0);
  assert.equal(result.observerInstances, 0);
  assert.equal(result.eventRegistrations.get('chat'), 5, '保留 lifecycle、V3 foundation、V3 memory、V3 recall 与时间戳协调五份结构订阅');
  assert.equal(result.eventRegistrations.get('persona'), 1);
});

test('生产 bundle 的原生/Luker × Text/Chat 入口动态调用同一 recall seam，禁用时只清槽且绝不 abort', async () => {
  for (const hostGlobalName of ['SillyTavern', 'Luker']) for (const mainApi of ['openai', 'textgenerationwebui']) {
    const result = await isolateBundle(hostGlobalName, { mainApi, invokeTypes: ['normal', 'regenerate', 'swipe', 'continue'] });
    assert.equal(result.interceptorType, 'function', `${hostGlobalName}/${mainApi}`);
    assert.equal(result.abortCalls, 0, `${hostGlobalName}/${mainApi}`);
    assert.equal(result.backendCalls, 0, `${hostGlobalName}/${mainApi}`);
    const recallCalls = result.promptCalls.filter(call => call[0] === 'qqj_v3_recalled_context');
    const clockCalls = result.promptCalls.filter(call => call[0] === 'myknots_story_clock');
    assert.equal(recallCalls.length, 4, `${hostGlobalName}/${mainApi}`);
    for (const call of recallCalls) assert.deepEqual(call, ['qqj_v3_recalled_context', '', 17, 1, false, 29]);
    assert.deepEqual(clockCalls, [['myknots_story_clock', '']], `${hostGlobalName}/${mainApi}`);
  }
});
