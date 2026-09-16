import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, webcrypto } from 'node:crypto';
import { CHAT_IDENTITY_COLLECTION } from '../src/chat-identity.js';
import { createHostAdapter } from '../src/v3/host-adapter.js';
import { createFoundationStore } from '../src/v3/foundation-store.js';
import { createFoundationRuntime } from '../src/v3/foundation-runtime.js';
import { createV3MemoryRuntime } from '../src/v3/memory-runtime.js';
import { EXTRACTOR_SYSTEM_PROMPT } from '../src/v3/extractor.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = '2026-09-14T00:00:00.000Z';
const user = mes => ({ is_user: true, is_system: false, mes, send_date: `test-user:${mes}` });
const assistant = mes => ({ is_user: false, is_system: false, mes, swipes: [mes], swipe_id: 0 });
const identity = (hostChatId, chatId) => ({ hostChatId, chatId, characterLocator: 'character.png', personaLocator: 'persona.png' });
const envelope = (data, revision) => ({ revision, data: structuredClone(data), createdAt: NOW, updatedAt: NOW });

function createRecordBackend() {
  const records = new Map();
  const failure = status => Object.assign(new Error(`HTTP ${status}`), { status });
  const client = {
    async get(collection, key) {
      const value = records.get(`${collection}/${key}`);
      if (!value) throw failure(404);
      return envelope(value.data, value.revision);
    },
    async put(collection, key, data, expectedRevision) {
      const mapKey = `${collection}/${key}`;
      const previous = records.get(mapKey);
      if ((previous?.revision ?? 0) !== expectedRevision) throw failure(409);
      const revision = (previous?.revision ?? 0) + 1;
      records.set(mapKey, { revision, data: structuredClone(data) });
      return envelope(data, revision);
    },
  };
  return { records, client };
}

function hostChat(hostChatId, qqjChatId, chat) {
  return {
    name1: '林岚', name2: '裴晚生', characterId: 0, groupId: null, chatId: hostChatId,
    characters: [{ avatar: 'character.png', name: '裴晚生', data: { description: '角色描述', personality: '克制', scenario: '雨夜' } }],
    userAvatar: 'persona.png', powerUserSettings: { persona_description: '调查员' },
    chatMetadata: { qianqianjie: { schemaVersion: 2, chatId: qqjChatId } }, chat,
    uuidv4: randomUUID, mainApi: 'openai',
    async saveMetadata() {}, async saveChat() { return true; },
    getRequestHeaders() { return {}; }, getWorldInfoNames() { return []; }, async loadWorldInfoBatch() { return new Map(); },
    constants: { promptTypes: { IN_CHAT: 1 }, promptRoles: { SYSTEM: 0 } }, setExtensionPrompt() {},
  };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 5));
  }
  assert.fail(message);
}

function snapshotSource(records) {
  return JSON.stringify([...records.entries()]
    .filter(([key]) => key.startsWith(`chat-${SOURCE}/`) || key === `${CHAT_IDENTITY_COLLECTION}/binding-${SOURCE}`)
    .sort(([left], [right]) => left.localeCompare(right)));
}

test('候选生产 bundle 经真实 CHAT_CHANGED 初始化同角色副本，目标 ready/root 可读且模型调用为零', async () => {
  const backend = createRecordBackend();
  let activeHost = hostChat('原聊天', SOURCE, [user('开始'), assistant('公共 A'), user('继续 A')]);
  const seedHostAdapter = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => activeHost } } });
  const sourceStore = createFoundationStore({ client: backend.client, contextProvider: () => identity('原聊天', SOURCE) });
  let seedUuid = 1000;
  const sourceFoundation = createFoundationRuntime({
    hostAdapter: seedHostAdapter, store: sourceStore, contextProvider: () => activeHost,
    now: () => new Date(NOW), newUuid: () => `${(++seedUuid).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
    logger: { warn() {} },
  });
  const sourceMemory = createV3MemoryRuntime({
    foundationRuntime: sourceFoundation, store: sourceStore, hostAdapter: seedHostAdapter,
    generateAnalysisTask: async options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: '公共 A 摘要', people: [{ name: '裴晚生', presence: 'present' }] }, taskMetadata: { source: 'test', sourceLabel: '测试', model: 'seed' } }
      : { jsonData: { subjects: [{ subject: '裴晚生', situational: [{ text: '公共 A 状态', visibility: 'observable', reason: '公共 A' }] }] }, taskMetadata: { source: 'test', sourceLabel: '测试', model: 'seed' } },
    generateUtilityTask: async options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: '公共 A 摘要', people: [{ name: '裴晚生', presence: 'present' }] }, taskMetadata: { source: 'test', sourceLabel: '测试', model: 'seed' } }
      : { jsonData: { subjects: [{ subject: '裴晚生', situational: [{ text: '公共 A 状态', visibility: 'observable', reason: '公共 A' }] }] }, taskMetadata: { source: 'test', sourceLabel: '测试', model: 'seed' } },
    now: () => new Date(NOW), newUuid: () => `${(++seedUuid).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
    logger: { warn() {} },
  });
  await sourceMemory.start();
  await sourceMemory.startHistoricalRebuild();
  await waitFor(() => ['caughtUp', 'waitingRealtime'].includes(sourceMemory.getState().rebuildStatus) && !sourceMemory.getState().activeAutoMemory, '源图准备失败');
  backend.records.set(`${CHAT_IDENTITY_COLLECTION}/binding-${SOURCE}`, {
    revision: 1,
    data: {
      schemaVersion: 1, kind: 'qqj-chat-identity-binding', chatId: SOURCE,
      owner: { hostChatId: '原聊天', characterLocator: 'character.png', personaLocator: 'persona.png' },
      state: 'ready', sourceChatId: null, createdAt: NOW, updatedAt: NOW,
    },
  });
  const sourceBefore = snapshotSource(backend.records);

  const listeners = new Map();
  const eventTypes = {
    CHAT_CHANGED: 'chat-changed', PERSONA_CHANGED: 'persona-changed', CHAT_RENAMED: 'chat-renamed',
    MESSAGE_SENT: 'message-sent', MESSAGE_RECEIVED: 'message-received', MESSAGE_EDITED: 'message-edited',
    MESSAGE_DELETED: 'message-deleted', MESSAGE_SWIPED: 'message-swiped', MESSAGE_SWIPE_DELETED: 'message-swipe-deleted',
    GENERATION_STARTED: 'generation-started', GENERATION_STOPPED: 'generation-stopped', GENERATION_ENDED: 'generation-ended',
  };
  const eventSource = {
    on(name, handler) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); },
    removeListener(name, handler) { listeners.set(name, (listeners.get(name) ?? []).filter(value => value !== handler)); },
  };
  activeHost.eventTypes = eventTypes;
  activeHost.eventSource = eventSource;
  let candidateAiCalls = 0;
  let hostAiCalls = 0;
  activeHost.generateTask = async () => { hostAiCalls += 1; throw new Error('候选分支不得调用模型'); };

  let context;
  const response = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    async json() { return runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(body))})`, context); },
  });
  const fetchImpl = async (url, options = {}) => {
    const path = String(url);
    if (path === '/api/characters/chats') return response(200, [{ file_id: '原聊天' }, { file_id: '复制聊天' }]);
    if (path === '/api/chats/get') return response(200, [{ chat_metadata: structuredClone(activeHost.chatMetadata) }, ...structuredClone(activeHost.chat)]);
    if (path.startsWith('/api/backends/')) {
      candidateAiCalls += 1;
      throw new Error('候选分支不得调用模型');
    }
    const prefix = '/api/plugins/st-bainiaodata/v1/records/qianqianjie/';
    if (!path.startsWith(prefix)) return response(404, {});
    const parts = path.slice(prefix.length).split('/').map(decodeURIComponent);
    if (parts.length !== 2) return response(404, {});
    const mapKey = `${parts[0]}/${parts[1]}`;
    const previous = backend.records.get(mapKey);
    if ((options.method ?? 'GET') === 'GET') return previous ? response(200, envelope(previous.data, previous.revision)) : response(404, {});
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body);
      if ((previous?.revision ?? 0) !== body.expectedRevision) return response(409, {});
      const revision = (previous?.revision ?? 0) + 1;
      backend.records.set(mapKey, { revision, data: structuredClone(body.data) });
      return response(200, envelope(body.data, revision));
    }
    return response(404, {});
  };

  context = createContext({
    console, crypto: webcrypto, TextEncoder, TextDecoder, URL, URLSearchParams, AbortController, DOMException,
    setTimeout, clearTimeout, fetch: fetchImpl,
    SillyTavern: { getContext: () => activeHost },
  });
  runInContext('globalThis.structuredClone = value => JSON.parse(JSON.stringify(value))', context);
  const moduleCache = new Map();
  const synthetic = (identifier, exports) => new SyntheticModule(Object.keys(exports), function initialize() {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context, identifier });
  async function load(identifier) {
    if (moduleCache.has(identifier)) return moduleCache.get(identifier);
    const path = fileURLToPath(identifier);
    const hostPath = new URL(identifier).pathname.replace(new RegExp('^/[A-Za-z]:'), '');
    let module;
    if (hostPath === '/scripts/personas.js') module = synthetic(identifier, { user_avatar: 'persona.png' });
    else if (hostPath === '/scripts/power-user.js') module = synthetic(identifier, { power_user: { persona_description: '' } });
    else if (hostPath === '/scripts/extensions.js') module = synthetic(identifier, { extension_settings: { qianqianjie: { pluginEnabled: true }, 'schedule-planner': {} }, extensionNames: [] });
    else if (hostPath === '/script.js') module = synthetic(identifier, { is_send_press: false, saveSettingsDebounced() {} });
    else if (hostPath === '/scripts/group-chats.js') module = synthetic(identifier, { is_group_generating: false });
    else if (hostPath === '/scripts/world-info.js') module = synthetic(identifier, { loadWorldInfo: async () => null, selected_world_info: [], world_info: {}, world_info_case_sensitive: false, world_info_match_whole_words: false, world_names: [] });
    else module = new SourceTextModule(await readFile(path, 'utf8'), { context, identifier });
    moduleCache.set(identifier, module);
    return module;
  }
  const candidatePath = resolve(process.env.QQJ_TEST_BUNDLE ?? resolve(root, 'dist/qqj-app.js'));
  const entry = await load(pathToFileURL(candidatePath).href);
  await entry.link((specifier, referencing) => load(new URL(specifier, referencing.identifier).href));
  await entry.evaluate();
  await waitFor(() => (listeners.get(eventTypes.CHAT_CHANGED)?.length ?? 0) > 0, '候选入口未注册 CHAT_CHANGED');

  activeHost = hostChat('复制聊天', SOURCE, [user('开始'), assistant('公共 A')]);
  activeHost.eventTypes = eventTypes;
  activeHost.eventSource = eventSource;
  activeHost.generateTask = async () => { hostAiCalls += 1; throw new Error('候选分支不得调用模型'); };
  for (const handler of listeners.get(eventTypes.CHAT_CHANGED) ?? []) handler();

  let targetBinding;
  await waitFor(() => {
    targetBinding = [...backend.records.values()].find(row => row.data?.kind === 'qqj-chat-identity-binding'
      && row.data.sourceChatId === SOURCE && row.data.owner?.hostChatId === '复制聊天' && row.data.state === 'ready');
    return Boolean(targetBinding);
  }, '候选入口未完成副本 binding');
  const targetChatId = targetBinding.data.chatId;
  const target = await createFoundationStore({ client: backend.client, contextProvider: () => identity('复制聊天', targetChatId) }).readReachable();
  assert.equal(target.status, 'ready');
  assert.equal(target.floorMemories[0].summary.aiText, '公共 A 摘要');
  assert.equal(activeHost.chatMetadata.qianqianjie.chatId, targetChatId);
  assert.equal(candidateAiCalls + hostAiCalls, 0);
  assert.equal(snapshotSource(backend.records), sourceBefore);
});
