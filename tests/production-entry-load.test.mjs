import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { createContext, runInContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { normalizeStoryCalendar } from '../src/v3/calendar-rules.js';
import { ChatSessionError } from '../src/chat-session.js';
import { cloneHostJsonMetadata } from '../src/host-context.js';
import { createHostAdapter } from '../src/v3/host-adapter.js';
import { createFoundationStore } from '../src/v3/foundation-store.js';
import { createFoundationRuntime } from '../src/v3/foundation-runtime.js';
import { projectHistoricalRecallReceipt } from '../src/v3/recall-runtime.js';
import { createV3RecallRuntime } from '../src/v3/recall-runtime.js';
import { compileCseResponse } from '../src/v3/cse-engine.js';
import { estimateRecallTokens, recallBudget, selectRecall } from '../src/v3/recall-selector.js';
import { selectPrequel } from '../src/v3/recall-prequel.js';
import { readRecallSource } from '../src/v3/recall-source.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nativeJson = value => Array.isArray(value) ? value.map(nativeJson) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, nativeJson(value[key])])) : value;

async function readyFoundationRecords(hostGlobalName, host) {
  const records = new Map();
  const failed = status => Object.assign(new Error(`HTTP ${status}`), { status });
  const envelope = (data, revision) => ({ schemaVersion: 1, revision, generationId: '11111111-1111-4111-8111-111111111111',
    createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z', data: structuredClone(data) });
  const client = {
    async get(collection, key) {
      const value = records.get(`${collection}/${key}`);
      if (!value) throw failed(404);
      return envelope(value.data, value.revision);
    },
    async put(collection, key, data, expectedRevision) {
      const recordKey = `${collection}/${key}`, previous = records.get(recordKey);
      if ((previous?.revision ?? 0) !== expectedRevision) throw failed(409);
      const record = { revision: expectedRevision + 1, data: structuredClone(data) };
      records.set(recordKey, record);
      return envelope(record.data, record.revision);
    },
  };
  const hostAdapter = createHostAdapter({ globalRef: { [hostGlobalName]: { getContext: () => host } } });
  const identity = { hostChatId: host.chatId, chatId: host.chatMetadata.qianqianjie.chatId, characterLocator: 'char.png', personaLocator: 'me.png' };
  const store = createFoundationStore({ client, contextProvider: () => identity });
  const runtime = createFoundationRuntime({ hostAdapter, store, contextProvider: () => host,
    now: () => new Date('2026-09-13T00:00:00.000Z'), logger: { warn() {} },
    fetchImpl: async url => {
      if (String(url) === '/api/chats/get') return { ok: true, status: 200, async json() { return [
        { chat_metadata: structuredClone(host.chatMetadata) }, ...structuredClone(host.chat),
      ]; } };
      if (String(url) === '/api/chats/save') return { ok: true, status: 200, async json() { return { ok: true }; } };
      throw new Error(`unexpected offline fixture request: ${String(url)}`);
    },
  });
  const state = await runtime.start();
  assert.equal(state.status, 'ready', '正式foundation runtime应生成可读的真实checkpoint fixture');
  const reachable = await store.readReachable({ mode: 'projection', allowRecallCseFallback: true });
  assert.equal(reachable.status, 'ready');
  assert.ok(reachable.checkpoint, '召回来源必须有经正式Store验证的checkpoint');
  assert.equal(reachable.floors.length, 1);
  return records;
}

class ReceiptUiNode {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null; this.attributes = {}; this.dataset = {};
    this.className = ''; this._textContent = ''; this.hidden = false; this.disabled = false; this.style = {};
    this.listeners = new Map(); this.shadowRoot = null;
  }
  get textContent() { return this._textContent + this.children.map(child => child.textContent ?? '').join(''); }
  set textContent(value) { this.replaceChildren(); this._textContent = String(value ?? ''); }
  get classList() { return { contains: value => this.className.split(/\s+/u).includes(value) }; }
  get isConnected() {
    let node = this;
    while (node) { if (node.__documentRoot) return true; node = node.parentElement ?? node.host ?? null; }
    return false;
  }
  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === 'string' ? Object.assign(new ReceiptUiNode('#text'), { textContent: node }) : node;
      child.remove?.(); child.parentElement = this; this.children.push(child);
    }
  }
  replaceChildren(...nodes) { for (const child of this.children) child.parentElement = null; this.children = []; this._textContent = ''; this.append(...nodes); }
  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }
  setAttribute(name, value) {
    const text = String(value); this.attributes[name] = text;
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = text;
    if (name === 'id') this.id = text;
  }
  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
  addEventListener(name, handler) { const values = this.listeners.get(name) ?? []; values.push(handler); this.listeners.set(name, values); }
  emit(name, event = {}) { for (const handler of this.listeners.get(name) ?? []) handler({ currentTarget: this, target: this, ...event }); }
  click() { this.emit('click'); }
  focus() {}
  attachShadow() { const root = new ReceiptUiNode('shadow-root'); root.host = this; this.shadowRoot = root; return root; }
  matches(selector) {
    const tag = /^([a-z][a-z0-9-]*)/iu.exec(selector)?.[1];
    if (tag && this.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    const id = /#([\w-]+)/u.exec(selector)?.[1];
    if (id && this.id !== id) return false;
    for (const match of selector.matchAll(/\.([\w-]+)/gu)) if (!this.classList.contains(match[1])) return false;
    for (const match of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/gu)) {
      const value = this.getAttribute(match[1]);
      if (value === null || (match[2] !== undefined && value !== match[2])) return false;
    }
    return true;
  }
  querySelectorAll(selector) {
    const result = [];
    const visit = node => { for (const child of node.children) { if (child.matches(selector)) result.push(child); visit(child); } };
    visit(this); return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

class ReceiptUiDocument {
  constructor(messages) {
    this.body = new ReceiptUiNode('body'); this.body.__documentRoot = true;
    this.head = new ReceiptUiNode('head'); this.defaultView = globalThis;
    this.chat = new ReceiptUiNode('main'); this.chat.id = 'chat'; this.chat.setAttribute('id', 'chat'); this.body.append(this.chat);
    for (let index = 0; index < messages.length; index += 1) {
      const source = messages[index];
      const message = new ReceiptUiNode('div'); message.className = `mes${index === messages.length - 1 ? ' last_mes' : ''}${source.is_user ? ' user_mes' : ''}`;
      message.setAttribute('mesid', String(index)); message.setAttribute('is_user', String(source.is_user === true));
      const block = new ReceiptUiNode('div'); block.className = 'mes_block';
      const text = new ReceiptUiNode('div'); text.className = 'mes_text'; text.textContent = source.mes;
      block.append(text); message.append(block); this.chat.append(message);
    }
    this.panel = { __qqjInstance: { show() {}, refresh() {}, setEnabled() {}, openMemory() {} } };
  }
  createElement(tag) { return new ReceiptUiNode(tag); }
  getElementById(id) { return id === 'qqj-panel-host' ? this.panel : this.body.querySelector(`#${id}`); }
  querySelector(selector) { return this.body.matches(selector) ? this.body : this.body.querySelector(selector); }
  querySelectorAll(selector) { return [...(this.body.matches(selector) ? [this.body] : []), ...this.body.querySelectorAll(selector)]; }
}

async function generatedLegacyReceipt10(userMessage) {
  const chatId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const personId = '66666666-6666-4666-8666-666666666666';
  const empty = { chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const floorIds = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
  const memoryIds = ['44444444-4444-4444-8444-444444444441', '44444444-4444-4444-8444-444444444442', '44444444-4444-4444-8444-444444444443'];
  const deltaIds = ['55555555-5555-4555-8555-555555555551', '55555555-5555-4555-8555-555555555552', '55555555-5555-4555-8555-555555555553'];
  const floors = floorIds.map((id, index) => ({ id, assistantSeq: index + 1 }));
  const memories = floors.map((floor, index) => ({ id: memoryIds[index], floorId: floor.id, recordStatus: 'active', summary: { effectiveSource: 'ai', aiText: `旧楼摘要${floor.assistantSeq}` }, ...empty }));
  const privateState = { id: '77777777-7777-4777-8777-777777777771', text: '仍在钟楼等候', visibility: 'private', reason: '未公开的旧约', origin: 'floor', towardEntityId: null, sourceFloorId: floorIds[0], sourceDeltaId: deltaIds[0] };
  const headId = '88888888-8888-4888-8888-888888888888';
  const trackedBindings = [{ entityId: personId, labels: ['裴晚生', '阿裴'], specialRole: 'char' }];
  const compile = async (index, situational, previousCurrentState) => compileCseResponse({
    response: { subjects: [{ subject: '裴晚生', situational }] },
    envelope: { scope: { floorId: floorIds[index], floorMemoryId: memoryIds[index], chatId, narrativeGeneration: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', baselineId: '99999999-9999-4999-8999-999999999999', trackedBindings, knownBindings: trackedBindings, evidenceSources: [], coreUserEditedSubjectEntityIds: [] } },
    previousCurrentState, now: '2026-09-10T00:00:00.000Z', deltaId: deltaIds[index],
  });
  const first = await compile(0, [{ text: privateState.text, visibility: privateState.visibility, reason: privateState.reason },
    { text: '仍在钟楼保管赴约钥匙', visibility: 'private', reason: '为赴约留门' }], null);
  const second = await compile(1, [], { id: deltaIds[0], subjects: first.delta.subjectSnapshots });
  const third = await compile(2, [{ text: '已经回到钟楼准备赴约', visibility: 'private', reason: '重新履行旧约' }], { id: deltaIds[1], subjects: second.delta.subjectSnapshots });
  const reachable = { status: 'ready', rootRevision: 1,
    root: { chatId, narrativeGeneration: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', headCheckpointId: headId },
    checkpoint: { id: headId }, baseline: { id: '99999999-9999-4999-8999-999999999999' }, floors, floorMemories: memories,
    currentStates: [], entities: [{ id: personId, entityType: 'person', displayName: '裴晚生', aliases: [{ name: '阿裴' }], specialRole: 'char', recordStatus: 'active', status: 'established' }],
    stateDeltas: [first.delta, second.delta, third.delta] };
  const chat = [{ is_user: false, is_system: false, mes: '旧楼正文' }, userMessage];
  const context = { chatMetadata: { qianqianjie: { chatId } }, constants: { promptTypes: { IN_CHAT: 1 }, promptRoles: { SYSTEM: 0 } }, setExtensionPrompt() {}, async saveChat() {} };
  const runtime = createV3RecallRuntime({ store: { readReachable: async () => structuredClone(reachable) }, hostAdapter: { snapshot: () => ({ context, chat }) },
    sourceReader: ({ now }) => readRecallSource({ store: { readReachable: async () => structuredClone(reachable) }, now }),
    selector: selectRecall, pluginVersion: '0.1.8-test', now: () => new Date('2026-09-10T00:00:00.000Z'), logger: { warn() {} } });
  const generated = await runtime.intercept(chat, 12000, null, 'normal');
  assert.equal(generated.lastRecall.status, 'ready', '旧版签名材料应来自正式runtime封签');
  const receipt = structuredClone(userMessage.extra.qqj_v3_recall_receipt);
  receipt.schemaVersion = 10; receipt.strategyVersion = 'continuity-v5';
  receipt.selectedFloors = []; receipt.selectedStates = [];
  receipt.injectionText = '旧版召回原文：这段文本应按纯文本折叠展示。';
  receipt.selectedCseChanges = [{ deltaId: deltaIds[0], floorId: floorIds[0], assistantSeq: 1,
    subjectEntityId: personId, subject: '林岚', layer: 'situational', action: 'add', before: null,
    after: { text: '仍维持同一约定', visibility: 'private', reason: '持续状态', origin: 'floor', toward: '周宁',
      towardEntityId: '11111111-1111-4111-8111-111111111112', sourceAssistantSeq: null } }];
  for (const key of ['qianshiDeletionWitness', 'selectedLocationReferences', 'locationReferenceDependency', 'qianshiProgress', 'storylines', 'timeDependencies', 'stateProgressions']) delete receipt[key];
  receipt.userMessageIndex = 1;
  const digest = value => `sha256:${createHash('sha256').update(String(value ?? '')).digest('hex')}`;
  receipt.userContentFingerprint = digest(userMessage.mes);
  receipt.receiptFingerprint = digest(JSON.stringify([receipt.schemaVersion, receipt.pluginVersion, receipt.chatId, receipt.narrativeGeneration,
    receipt.headCheckpointId, receipt.rootRevision, receipt.userMessageIndex, receipt.userContentFingerprint, receipt.queryFingerprint,
    receipt.generationType, receipt.selectedFloors, receipt.selectedStates, receipt.coverage, receipt.injectionText, receipt.stages,
    receipt.skipReasons, receipt.completionStatus, receipt.createdAt, receipt.bodyMatchFingerprint, receipt.strategyVersion,
    receipt.selectedCseChanges, receipt.selectorDiagnostic, receipt.timings]));
  return receipt;
}

async function generatedCurrentReceipt18({ hostGlobalName, chat, userMessage, rootRecord, contextSize }) {
  const chatId = rootRecord.data.chatId;
  const narrativeGeneration = rootRecord.data.narrativeGeneration;
  const headCheckpointId = rootRecord.data.headCheckpointId;
  const personId = '99999999-9999-4999-8999-999999999991';
  const stateId = '99999999-9999-4999-8999-999999999992';
  const archiveText = `Archive ledger: ${'This is a neutral archival note about records and context. '.repeat(70)}`.slice(0, 3900);
  // A narrow source DTO keeps this bundle test on the real receipt producer and selector without inventing a saved floor summary.
  const source = {
    status: 'ready', rootRevision: rootRecord.revision,
    chatId, narrativeGeneration, headCheckpointId,
    coverage: { stableAiFloors: 0, stableThroughAssistantSeq: 0, rememberedAiFloors: 0, missingAssistantSeq: [], cseThroughAssistantSeq: 0, memoryComplete: true, cseCurrent: true },
    floors: [], floorMemories: [], bodyMatchRefs: [], cseChanges: [],
    entities: [{ entityId: personId, entityType: 'person', displayName: '林岚', aliases: [], specialRole: 'char' }],
    currentState: [{ subjectEntityId: personId, core: [{
      stateId, text: archiveText, visibility: 'authorial', reason: '持续设定', origin: 'baseline',
      towardEntityId: null, sourceFloorId: null, sourceDeltaId: null, sourceAssistantSeq: null,
    }], adaptive: [], situational: [] }],
    readiness: { status: 'caughtUp', hostConfirmed: true, summaryStatus: 'caughtUp', summaryMissingFloorIds: [], visibleSummaryFloorIds: [] },
    sourceReadAttempts: { reachableReads: 0, exitPoint: 'testSourceDto' },
  };
  const context = {
    chatId: 'host-chat', chatMetadata: { qianqianjie: { chatId } },
    constants: { promptTypes: { IN_CHAT: 1 }, promptRoles: { SYSTEM: 0 } },
    setExtensionPrompt() {}, async saveChat() { return true; },
  };
  const store = {
    async readReachable() { throw new Error('narrow DTO fixture should not read a graph'); },
    async readRoot() { return { status: 'ready', revision: rootRecord.revision, data: structuredClone(rootRecord.data) }; },
  };
  const runtimeWarnings = [];
  const runtime = createV3RecallRuntime({ store,
    hostAdapter: { snapshot: () => ({ context, chat }) },
    selector: selectRecall,
    sourceReader: async () => source,
    pluginVersion: JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8')).version,
    now: () => new Date('2026-09-13T00:00:00.000Z'), logger: { warn(...args) { runtimeWarnings.push(args.map(value => value instanceof Error
      ? { name: value.name, code: value.code ?? null, message: value.message, stack: value.stack }
      : value)); } },
  });
  const result = await runtime.intercept(chat, contextSize, null, 'normal');
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.equal(result.lastRecall.status, 'ready', `${hostGlobalName} 正式runtime应生成当前回执：${JSON.stringify({ status: result.lastRecall.status, skipReasons: result.lastRecall.skipReasons, stages: result.lastRecall.stages, coverage: result.lastRecall.coverage, error: result.lastRecall.error ?? null, warnings: runtimeWarnings })}`);
  const receipt = userMessage.extra?.qqj_v3_recall_receipt;
  assert.equal(receipt?.schemaVersion, 18, `${hostGlobalName} 预算输入应来自当前receipt producer`);
  assert.equal(receipt?.pluginVersion, JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8')).version);
  return { receipt, result };
}

async function isolateBundle(hostGlobalName, { enabled = false, coreCacheEnabled, withExistingPanel = false, legacyReceiptUi = false, legacyReceiptPrequelBudget = null, mainApi = 'openai', invokeTypes = [], invokeLocationReference = false, locationReferenceChat = false, initializeWithoutSubtle = false, allowIdentityWrites = false, unstableAi0 = false, withoutQqjIdentity = false, tauri = false, privateDiagnostics = false, startupBindFailure = false, metadataWithUncloneableField = false, metadataProxy = false } = {}) {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  const bundlePath = process.env.QQJ_TEST_BUNDLE ? resolve(process.env.QQJ_TEST_BUNDLE) : resolve(root, manifest.js.split('?')[0]);
  const eventRegistrations = new Map();
  const startupWarnings = [];
  const testConsole = { ...console, warn(...args) { startupWarnings.push(args); } };
  const backendRecords = new Map();
  const ttRecords = new Map();
  let backendWriteCalls = 0;
  let saveMetadataCalls = 0;
  let chatSaveCalls = 0;
  const ttKey = ({ namespace, table = 'main', key }) => `${namespace}/${table}/${key}`;
  const ttStore = {
    async tryGetJson(options) { const key = ttKey(options); return ttRecords.has(key) ? { found: true, value: structuredClone(ttRecords.get(key)) } : { found: false }; },
    async deleteJson(options) { ttRecords.delete(ttKey(options)); },
    async setJson(options) { ttRecords.set(ttKey(options), nativeJson(options.value)); },
    async listKeys({ namespace, table = 'main' }) { const prefix = `${namespace}/${table}/`; return [...ttRecords.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length)); },
    async listTables({ namespace }) { return [...new Set([...ttRecords.keys()].filter(key => key.startsWith(`${namespace}/`)).map(key => key.split('/')[1]))]; },
  };
  let hostShaCalls = 0;
  const hostShaInputs = [];
  let ai0BodyReads = 0;
  const ai0Text = '新聊天正在生成的 AI0 正文';
  const ai0Message = { is_user: false, is_system: false, get mes() { ai0BodyReads += 1; return ai0Text; }, swipes: [ai0Text], swipe_id: 0 };
  const hostChat = locationReferenceChat ? [
    { is_user: false, is_system: false, mes: '明天继续讨论住处。<location>东区公寓·卧室</location>', swipes: ['明天继续讨论住处。<location>东区公寓·卧室</location>'], swipe_id: 0 },
    { is_user: true, is_system: false, mes: '接着说下去', send_date: '2026-09-13T00:00:00.000Z', extra: {} },
  ] : legacyReceiptUi ? [
    { is_user: false, is_system: false, mes: legacyReceiptPrequelBudget ? '旧楼正文' : '昨晚讨论了住处和约定。', swipes: [legacyReceiptPrequelBudget ? '旧楼正文' : '昨晚讨论了住处和约定。'], swipe_id: 0 },
    { is_user: true, is_system: false, mes: legacyReceiptPrequelBudget ? '林岚，请继续 archive ledger 的归档说明。' : '继续刚才的话题。', send_date: '2026-09-13T00:00:00.000Z', extra: {} },
    ...(!legacyReceiptPrequelBudget ? [{ is_user: true, is_system: false, mes: '再接着说。', send_date: '2026-09-13T00:01:00.000Z', extra: {} }] : []),
  ] : unstableAi0 ? [ai0Message] : initializeWithoutSubtle ? [
    { is_user: false, is_system: false, mes: '产物指纹🙂', swipes: ['产物指纹🙂'], swipe_id: 0 },
    { is_user: true, is_system: false, mes: '确认', send_date: '2026-09-13T00:00:00.000Z' },
  ] : [];
  const host = {
    characterId: 0, groupId: null, chatId: 'host-chat', characters: [{ avatar: 'char.png', name: '角色' }], userAvatar: 'me.png',
    chatMetadata: enabled ? {
      qianqianjie: withoutQqjIdentity ? { schemaVersion: 1 } : { schemaVersion: 1, chatId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      ...(legacyReceiptPrequelBudget ? { qianqianjiePrequel: legacyReceiptPrequelBudget.text } : {}),
      ...(metadataWithUncloneableField ? { otherPlugin: { label: '保留字段', transient: () => 'not stored' } } : {}),
    } : {},
    chat: hostChat,
    mainApi,
    uuidv4: () => '11111111-1111-4111-8111-111111111111',
    async saveMetadata() { saveMetadataCalls += 1; },
    ...(locationReferenceChat ? { async saveChat() { chatSaveCalls += 1; return true; } } : {}),
    getRequestHeaders: () => ({}), eventTypes: { CHAT_CHANGED: 'chat', PERSONA_CHANGED: 'persona' },
    eventSource: { on(name) { if (startupBindFailure && name === 'chat') throw new TypeError('PRIVATE startup binding detail'); eventRegistrations.set(name, (eventRegistrations.get(name) ?? 0) + 1); } },
  };
  const readyRecords = locationReferenceChat || legacyReceiptUi ? await readyFoundationRecords(hostGlobalName, host) : null;
  if (legacyReceiptUi) {
    const receipt = legacyReceiptPrequelBudget
      ? (await generatedCurrentReceipt18({ hostGlobalName, chat: hostChat, userMessage: hostChat[1],
        rootRecord: readyRecords.get(`chat-${host.chatMetadata.qianqianjie.chatId}/v3-root`), contextSize: legacyReceiptPrequelBudget.contextSize })).receipt
      : await generatedLegacyReceipt10(hostChat[1]);
    hostChat[1].extra ??= {};
    hostChat[1].extra.qqj_v3_recall_receipt = receipt;
  }
  if (legacyReceiptUi) assert.equal(hostChat[1].extra.qqj_v3_recall_receipt?.schemaVersion, legacyReceiptPrequelBudget ? 18 : 10,
    'bundle启动前的回执必须由对应的正式当前/历史producer生成');
  const initialHistoricalReceiptSchemaVersion = legacyReceiptUi ? hostChat[1].extra.qqj_v3_recall_receipt.schemaVersion : null;
  const initialLegacyReceiptFingerprint = legacyReceiptUi ? hostChat[1].extra.qqj_v3_recall_receipt.receiptFingerprint : null;
  const initialBudgetReceipt = legacyReceiptPrequelBudget ? structuredClone(hostChat[1].extra.qqj_v3_recall_receipt) : null;
  const historicalReceiptCheck = legacyReceiptUi
    ? await projectHistoricalRecallReceipt(hostChat[1], { chatId: host.chatMetadata.qianqianjie.chatId, userMessageIndex: 1 }) : null;
  if (metadataProxy) host.chatMetadata = new Proxy(host.chatMetadata, {});
  let hostFile = { header: { chat_metadata: metadataWithUncloneableField ? JSON.parse(JSON.stringify(host.chatMetadata)) : structuredClone(host.chatMetadata) }, chat: structuredClone(host.chat) };
  const initialAi0BodyReads = ai0BodyReads;
  if ((initializeWithoutSubtle || locationReferenceChat || legacyReceiptUi) && !withoutQqjIdentity) backendRecords.set('/api/plugins/st-bainiaodata/v1/records/qianqianjie/chat-identity-bindings/binding-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
    revision: 1,
    data: {
      schemaVersion: 1, kind: 'qqj-chat-identity-binding', chatId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      owner: { hostChatId: 'host-chat', characterLocator: 'char.png', personaLocator: 'me.png' },
      state: 'ready', sourceChatId: null, createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z',
    },
  });
  if (locationReferenceChat || legacyReceiptUi) {
    for (const [key, record] of readyRecords) backendRecords.set(`/api/plugins/st-bainiaodata/v1/records/qianqianjie/${key}`, record);
  }
  let backendCalls = 0;
  let backendHealthCalls = 0;
  let backendDataCalls = 0;
  let backendTrashGcPostCalls = 0;
  let localForageCreateCalls = 0;
  let mesAppendCalls = 0;
  let styleAppendCalls = 0;
  let observerInstances = 0;
  let abortCalls = 0;
  const promptCalls = [];
  const unloads = [], privateRecords = new Map();
  host.constants = { promptTypes: { IN_CHAT: 17 }, promptRoles: { SYSTEM: 29 } };
  host.setExtensionPrompt = (...args) => { promptCalls.push(args); };
  const message = {
    className: 'mes user-owned', dataset: { mesid: '0' }, children: [],
    getAttribute: name => name === 'mesid' ? '0' : null,
    querySelector: () => null,
    append(...nodes) { mesAppendCalls += nodes.length; this.children.push(...nodes); },
  };
  const existingPanel = { __qqjInstance: { show() {}, refresh() {}, setEnabled() {}, openMemory() {} } };
  const receiptDocument = legacyReceiptUi ? new ReceiptUiDocument(hostChat) : null;
  const documentRef = legacyReceiptUi ? receiptDocument : withExistingPanel ? {
    body: { append() {} }, head: { append(...nodes) { styleAppendCalls += nodes.length; } },
    getElementById: id => id === 'qqj-panel-host' ? existingPanel : null,
    querySelectorAll: selector => selector === '.mes[mesid]' ? [message] : [],
    createElement: tag => ({ tag, dataset: {}, style: {}, children: [], append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = [...nodes]; }, addEventListener() {}, querySelector: () => null }),
  } : undefined;
  const context = createContext({
    ...(tauri ? { __TAURITAVERN__: { ready: Promise.resolve(), api: { extension: { store: ttStore } } } } : {}),
    console: testConsole, crypto: initializeWithoutSubtle ? {} : globalThis.crypto, TextEncoder, TextDecoder, URL, URLSearchParams, AbortController, DOMException, structuredClone, setTimeout, clearTimeout, setInterval, clearInterval,
    ...(privateDiagnostics ? { location: { origin: 'https://tavern.invalid' }, addEventListener(name, callback) { if (name === 'beforeunload') unloads.push(callback); } } : {}),
    fetch: async (url, options = {}) => {
      if (String(url) === '/api/chats/get') return hostFile
        ? { ok: true, status: 200, async json() { return [structuredClone(hostFile.header), ...structuredClone(hostFile.chat)]; } }
        : { ok: true, status: 200, async json() { return { new_chat: true }; } };
      if (String(url) === '/api/chats/save') {
        chatSaveCalls += 1;
        const body = JSON.parse(options.body), [header, ...chat] = body.chat;
        header.chat_metadata.integrity = 'host-integrity';
        hostFile = { header, chat };
        return { ok: true, status: 200, async json() { return { ok: true, integrity: 'host-integrity' }; } };
      }
      backendCalls += 1;
      if (options.method && options.method !== 'GET') backendWriteCalls += 1;
      const requestUrl = String(url);
      if (requestUrl.endsWith('/v1/health')) {
        backendHealthCalls += 1;
        if (backendRecords.size > 0) {
          return { ok: true, status: 200, async json() { return { ok: true, api: { current: 1, supported: [1] }, capabilities: { records: true, optimisticRevision: true, recordBatchRead: false, recordIdList: false } }; } };
        }
        return { ok: false, status: 404, async json() { return {}; } };
      }
      backendDataCalls += 1;
      if (options.method === 'POST' && /\/v1\/trash\/[^/]+\/collect-expired(?:\?|$)/u.test(requestUrl)) backendTrashGcPostCalls += 1;
      if (privateDiagnostics && String(url).endsWith('/diagnostics.local.json')) return { ok: true, json: async () => ({ enabled: true }) };
      if (privateDiagnostics && String(url).includes('/private-diagnostics/')) {
        if (options.method === 'PUT') {
          const body = JSON.parse(options.body), previous = privateRecords.get(String(url));
          assert.equal(body.expectedRevision, previous?.revision ?? 0);
          privateRecords.set(String(url), { revision: body.expectedRevision + 1, data: body.data });
        }
        const value = privateRecords.get(String(url));
        return value ? { ok: true, json: async () => structuredClone(value) } : { ok: false, status: 404 };
      }
      if (initializeWithoutSubtle || locationReferenceChat || legacyReceiptUi) {
        if (allowIdentityWrites && options.method === 'PUT' && String(url).includes('/chat-identity-bindings/')) {
          const body = JSON.parse(options.body), record = { revision: body.expectedRevision + 1, data: body.data };
          backendRecords.set(String(url), record);
          return { ok: true, status: 200, async json() { return structuredClone(record); } };
        }
        const record = backendRecords.get(String(url));
        return record
          ? { ok: true, status: 200, async json() { return locationReferenceChat || legacyReceiptUi ? vmJson(record) : structuredClone(record); } }
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
  const vmJson = value => runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(value))})`, context);
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
    else if (hostPath === '/scripts/user.js') module = synthetic(identifier, { getCurrentUserHandle: () => 'isolated-test-user' });
    else if (hostPath === '/lib.js') module = synthetic(identifier, { localforage: { INDEXEDDB: 'INDEXEDDB', createInstance: () => { localForageCreateCalls += 1; return { async ready() {}, async getItem() { return null; }, async setItem() {}, async removeItem() {}, async keys() { return []; } }; } } });
    else if (hostPath === '/scripts/power-user.js') module = synthetic(identifier, { power_user: { persona_description: '' } });
    else if (hostPath === '/scripts/extensions.js') {
      const qqjSettings = { pluginEnabled: enabled };
      if (coreCacheEnabled !== undefined) qqjSettings.coreCacheEnabled = coreCacheEnabled;
      module = synthetic(identifier, { extension_settings: { qianqianjie: qqjSettings, 'schedule-planner': {} }, extensionNames: [] });
    }
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
  if (tauri && enabled) {
    for (let attempt = 0; attempt < 100 && ttRecords.size === 0; attempt += 1) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 5));
    }
    assert.ok(ttRecords.size > 0, 'TT bundle must write through the native store');
    assert.ok([...ttRecords.values()].some(value => {
      const slot = value.format === 'qqj-tt-json-v2' ? JSON.parse(value.serialized) : value;
      return slot.current?.data?.kind === 'qqj-chat-identity-binding';
    }));
  }
  if (initializeWithoutSubtle) {
    for (let attempt = 0; attempt < 200 && hostShaCalls === 0; attempt += 1) {
      await new Promise(resolvePromise => setImmediate(resolvePromise));
    }
  }
  for (const type of invokeTypes) await context.qqj_v3_recall_interceptor([], 8192, () => { abortCalls += 1; }, type);
  let locationReferenceResult = null;
  if (invokeLocationReference) {
    const cleanedCore = hostChat.map(message => ({ ...message, mes: message.mes.replace(/<location>[\s\S]*?<\/location>/giu, '').trim() }));
    locationReferenceResult = await context.qqj_v3_recall_interceptor(cleanedCore, 8192, () => { abortCalls += 1; }, 'normal');
    await new Promise(resolvePromise => setImmediate(resolvePromise));
  }
  let legacyReceiptPrequelBudgetResult = null;
  if (legacyReceiptPrequelBudget) {
    const intercept = await context.qqj_v3_recall_interceptor(hostChat, legacyReceiptPrequelBudget.contextSize, () => { abortCalls += 1; }, 'regenerate');
    await new Promise(resolvePromise => setImmediate(resolvePromise));
    const lastSlot = name => promptCalls.filter(call => call[0] === name).at(-1)?.[1] ?? '';
    legacyReceiptPrequelBudgetResult = {
      intercept,
      recallSlot: lastSlot('qqj_v3_recalled_context'),
      prequelSlot: lastSlot('qqj_v3_prequel_context'),
      promptSnapshot: context.qqj_v3_public_bridge_v1?.getPromptSnapshot?.() ?? null,
      receipt: hostChat[1]?.extra?.qqj_v3_recall_receipt ?? null,
      initialReceiptFingerprint: initialLegacyReceiptFingerprint,
      initialReceipt: initialBudgetReceipt,
    };
  }
  if (privateDiagnostics) {
    try {
      for (let attempt = 0; attempt < 100 && privateRecords.size === 0; attempt++) await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
      assert.ok(privateRecords.size > 0, '实际包必须自动留存未保存的本轮状态');
    } finally { for (const cleanup of unloads) cleanup(); }
  }
  const publicBridgeReadStatus = enabled ? null : (await context.qqj_v3_public_bridge_v1?.readMemory?.())?.status;
  const publicBridgeSnapshotType = typeof context.qqj_v3_public_bridge_v1?.getSnapshot;
  const publicBridgeSnapshotStatus = enabled ? null : context.qqj_v3_public_bridge_v1?.getSnapshot?.()?.status;
  const publicBridgePromptSnapshotType = typeof context.qqj_v3_public_bridge_v1?.getPromptSnapshot;
  const publicBridgePromptSnapshotStatus = enabled ? null : context.qqj_v3_public_bridge_v1?.getPromptSnapshot?.()?.status;
  return { status: entry.status, get backendCalls() { return backendCalls; }, backendHealthCalls, backendDataCalls, backendTrashGcPostCalls, backendWriteCalls, saveMetadataCalls, chatSaveCalls, finalQqjMetadata: host.chatMetadata.qianqianjie ? { ...host.chatMetadata.qianqianjie } : null, hostChat, documentRef, receiptDocument, initialHistoricalReceiptSchemaVersion, historicalReceiptCheck, localForageCreateCalls, backendRecords, privateRecords, hostShaCalls, hostShaInputs, ai0BodyReadCount: ai0BodyReads - initialAi0BodyReads, eventRegistrations, startupWarnings, mesAppendCalls, message, styleAppendCalls, observerInstances, interceptorType: typeof context.qqj_v3_recall_interceptor, publicBridgeType: typeof context.qqj_v3_public_bridge_v1, getPublicSnapshot: () => context.qqj_v3_public_bridge_v1?.getSnapshot?.() ?? null, publicBridgeReadStatus, publicBridgeSnapshotType, publicBridgeSnapshotStatus, publicBridgePromptSnapshotType, publicBridgePromptSnapshotStatus, promptCalls, locationReferenceResult, legacyReceiptPrequelBudgetResult, abortCalls };
}

test('实际生产启动入口捕获首次 host event bind 异常并继续完成模块求值', async () => {
  const result = await isolateBundle('SillyTavern', { startupBindFailure: true });
  assert.equal(result.status, 'evaluated');
  assert.equal(result.startupWarnings.length, 1, 'startup catch 应记录一次原始入口失败');
  assert.equal(result.startupWarnings[0][0], '[qianqianjie] 身份或后端数据准备失败');
  assert.match(result.startupWarnings[0][1]?.stack ?? '', /dist\/qqj-app\.js/u);
});

test('实际生产包无需打开面板或保存聊天，私有通道自动记录本轮结果', async () => {
  const result = await isolateBundle('SillyTavern', { enabled: true, privateDiagnostics: true, invokeTypes: ['normal'] });
  const records = [...result.privateRecords.values()];
  assert.equal(records.length, 1);
  const latest = records[0].data.events.at(-1).data;
  assert.equal(latest.status, 'skipped');
  assert.equal(latest.last.receiptPersistence, 'none');
  assert.deepEqual(latest.last.skipReasons, ['emptyUserInput']);
  assert.doesNotMatch(JSON.stringify(records), /host-chat|char\.png|injectionText|apiKey/u);
});

test('TT production bundle boots and persists chat identity through native store without BaiNiao HTTP', async () => {
  const result = await isolateBundle('SillyTavern', { enabled: true, tauri: true });
  assert.equal(result.status, 'evaluated');
  assert.equal(result.backendCalls, 0);
  assert.equal(result.localForageCreateCalls, 0, 'TT生产入口始终不创建浏览器cache实例');
  assert.equal(result.interceptorType, 'function');
});

test('实际生产 bundle 缺少 crypto.subtle 时经宿主 SHA 完成身份认领与地基指纹扫描', async () => {
  const result = await isolateBundle('SillyTavern', { enabled: true, initializeWithoutSubtle: true });
  const bindings = [...result.backendRecords.values()].filter(record => record.data?.kind === 'qqj-chat-identity-binding');
  assert.equal(result.status, 'evaluated');
  assert.equal(result.hostShaCalls > 0, true, '实际 bundle 内部没有调用宿主 SHA 接口');
  assert.equal(bindings.length, 1, '实际 bundle 没有完成聊天身份认领');
  assert.equal(result.hostShaInputs.some(bytes => new TextDecoder().decode(bytes) === '产物指纹🙂'), true, '实际地基扫描没有计算正文指纹');
});

test('实际生产入口把只有 AI0 正文的新聊天留在待记录状态，不报身份尚未建立错误', async () => {
  for (const hostName of ['SillyTavern', 'Luker']) {
    const result = await isolateBundle(hostName, { enabled: true, initializeWithoutSubtle: true, unstableAi0: true });
    const bindings = [...result.backendRecords.values()].filter(record => record.data?.kind === 'qqj-chat-identity-binding');
    assert.equal(result.status, 'evaluated');
    assert.equal(result.startupWarnings.length, 0, `${hostName} 的正常待记录状态不能记为启动故障`);
    assert.equal(bindings.length, 1, `${hostName} 已有聊天名时仍应完成真实 QQJ 身份准备`);
    assert.ok(result.ai0BodyReadCount > 0, `${hostName} 生产入口应实际读取未稳定 AI0 正文`);
  }
});

test('实际生产入口为新卡正常准备身份，未稳定 AI0 仍不误报记忆读取失败', async () => {
  for (const hostName of ['SillyTavern', 'Luker']) {
    const result = await isolateBundle(hostName, { enabled: true, initializeWithoutSubtle: true, allowIdentityWrites: true, unstableAi0: true, withoutQqjIdentity: true });
    assert.equal(result.status, 'evaluated');
    assert.equal(result.startupWarnings.length, 0, `${hostName} 后端完成既有身份准备后不应留下读取错误`);
    assert.ok(result.backendWriteCalls > 0, `${hostName} 正常新卡流程应保存身份绑定`);
    assert.ok(result.chatSaveCalls > 0, `${hostName} 正常新卡流程应通过宿主聊天保存入口写入身份`);
    assert.equal([...result.backendRecords.values()].filter(record => record.data?.kind === 'qqj-chat-identity-binding').length, 1);
    assert.ok(result.finalQqjMetadata?.chatId, `${hostName} 已有宿主聊天后应按既有合同准备 QQJ 身份`);
    assert.ok(result.ai0BodyReadCount > 0, `${hostName} 生产扫描会读取正文但不把未稳定 AI0 封存`);
  }
});

test('实际生产 bundle 原生与 Luker 启动均能捕获含其他插件临时字段的宿主元数据', async () => {
  for (const hostGlobalName of ['SillyTavern', 'Luker']) {
    const result = await isolateBundle(hostGlobalName, {
      enabled: true, initializeWithoutSubtle: true, metadataWithUncloneableField: true,
      metadataProxy: hostGlobalName === 'Luker',
    });
    assert.equal(result.status, 'evaluated');
    assert.equal(result.startupWarnings.length, 0, `${hostGlobalName} 的实际启动不能在 metadata snapshot 中 DataCloneError`);
    assert.ok(result.backendCalls > 0, `${hostGlobalName} 的生产启动必须越过 session 捕获进入真实身份协调流程`);
  }
});

test('manifest 唯一加载 qqj-app，生产 bundle 无 V1 标记、相对 import 且可隔离加载', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  const cacheMatch = /^dist\/qqj-app\.js\?v=(\d{4})(\d{2})(\d{2})\.([1-9]\d*)-([a-f0-9]{16})$/.exec(manifest.js);
  assert.ok(cacheMatch, '生产 bundle 必须使用日期、递增序号与内容哈希组成的 cache key');
  const [, year, month, day] = cacheMatch;
  const cacheDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  assert.equal(cacheDate.toISOString().slice(0, 10), `${year}-${month}-${day}`, 'cache key 必须包含合法日期');
  assert.equal(manifest.generate_interceptor, 'qqj_v3_recall_interceptor');
  assert.equal(manifest.version, '0.8.0');
  assert.equal(typeof manifest.author, 'string', 'TT 2.2.0 installer requires author');
  assert.ok(manifest.author.length > 0);
  const bundlePath = resolve(root, manifest.js.split('?')[0]);
  const bundleSource = await readFile(bundlePath, 'utf8');
  const bundleDigest = createHash('sha256').update(bundleSource).digest('hex');
  assert.equal(cacheMatch[5], bundleDigest.slice(0, 16), 'manifest cache key 必须随实际 bundle 内容变化，禁止漏 bump 假通过');
  for (const marker of [manifest.version, 'prepareStep', 'qianshiCandidates', 'Graphology 检测到重复图边。', 'DataCloneError']) {
    assert.equal(bundleSource.includes(marker), true, `生产 bundle 缺少候选版本或安全准备诊断字段：${marker}`);
  }
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
    characters: [{ avatar: 'char.png', name: '角色' }],
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
    else if (hostPath === '/scripts/user.js') module = synthetic(identifier, { getCurrentUserHandle: () => 'isolated-test-user' });
    else if (hostPath === '/lib.js') module = synthetic(identifier, { localforage: { INDEXEDDB: 'INDEXEDDB', createInstance: () => ({ async ready() {}, async getItem() { return null; }, async setItem() {}, async removeItem() {}, async keys() { return []; } }) } });
    else if (hostPath === '/scripts/power-user.js') module = synthetic(identifier, { power_user: { persona_description: '' } });
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
  assert.deepEqual((entry.moduleRequests || []).map(item => item.specifier).filter(specifier => specifier !== '/scripts/power-user.js'), ['/scripts/personas.js', '/scripts/extensions.js', '/script.js', '/scripts/group-chats.js', '/scripts/world-info.js', '/lib.js', '/scripts/user.js']);
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
  const unloadCallbacks = [];
  const context = createContext({ console, setTimeout, clearTimeout, addEventListener: (name, callback) => { if (name === 'beforeunload') unloadCallbacks.push(callback); } });
  const toastCalls = [];
  let openMemoryCalls = 0;
  let confirmationCalls = 0;
  context.toastr = { warning: (...args) => { toastCalls.push(args); } };
  const entrySource = await readFile(resolve(root, 'index.js'), 'utf8');
  const utilityTask = async () => ({ jsonData: 'utility' });
  const analysisTask = async () => ({ jsonData: 'analysis' });
  const recallTask = async () => ({ jsonData: 'recall' });

  let vectorOptions, vectorClientOptions, vectorAutoOptions;
  const vectorRuntime = { getState: () => ({ status: 'idle' }), query: async value => value, abortAll() {}, subscribe: () => () => {} };
  const vectorApi = { embed: async () => [], abortAll() {} };
  let v3MemoryOptions;
  let v3MemoryRuntime;
  let v3RecallOptions;
  let v3RecallRuntime;
  let identityOptions;
  let hostChatListOptions;
  let sessionOptions;
  let lifecycleOptions;
  let peopleWorkspaceOptions;
  let peopleStoreOptions;
  let publicMemoryBridgeOptions;
  let publicQianshiBridgeOptions;
  let autoHideOptions;
  let memoryManagementOptions, memoryMigrationOptions, memoryMigrationRuntime;
  let chatMemoryManagement;
  let storageManagementOptions;
  let storageManagement;
  let inlineRendererOptions;
  let hostAdapterOptions;
  const inlineEnabled = [];
  const backgroundStarts = [];
  const runtimeEnables = [];
  const recallInvalidations = [];
  let bootstrapOptions;
  let compactOptions;
  let foundationOptions;
  let coreCacheOptions;
  let coreCacheFactoryCalls = 0;
  let historicalRebuildOptions;
  const foundationStoreOptions = [];
  let branchInitializerOptions;
  let v3MemoryBindOptions;
  const sessionState = { status: 'preparing' };
  let sessionIdentityError = null;
  const anchorCalls = [];
  const persistAnchors = async options => { anchorCalls.push(options); return { status: 'persisted' }; };
  const productionEventHandlers = new Map();
  const productionEventSource = {
    on(name, handler) { const handlers = productionEventHandlers.get(name) ?? new Set(); handlers.add(handler); productionEventHandlers.set(name, handlers); },
    removeListener(name, handler) { productionEventHandlers.get(name)?.delete(handler); },
  };
  const productionEventTypes = { CHAT_CHANGED: 'chat', GENERATION_STARTED: 'generation-started', MESSAGE_SENT: 'sent', GENERATION_STOPPED: 'generation-stopped', GENERATION_ENDED: 'generation-ended', GROUP_WRAPPER_FINISHED: 'group-wrapper-finished' };
  const hostUuid = '123e4567-e89b-42d3-a456-426614174000';
  let hostUuidCalls = 0;
  const uuidv4 = () => { hostUuidCalls += 1; return hostUuid; };
  const productionListHostChats = async () => ['host-chat'];
  const modules = new Map();
  const define = (specifier, exports) => {
    const module = new SyntheticModule(Object.keys(exports), function initialize() {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context, identifier: `mock:${specifier}` });
    modules.set(specifier, module);
    return module;
  };
  define('/scripts/personas.js', { user_avatar: 'me.png' });
  define('/scripts/user.js', { getCurrentUserHandle: () => 'isolated-test-user' });
  const hostLocalForage = { INDEXEDDB: 'INDEXEDDB', createInstance: () => ({ async ready() {}, async getItem() { return null; }, async setItem() {}, async removeItem() {}, async keys() { return []; } }) };
  define('/lib.js', { localforage: hostLocalForage });
  define('/scripts/power-user.js', { power_user: { persona_description: '' } });
  const peerExtensionSettings = { disabledExtensions: [], 'schedule-planner': {} };
  const peerExtensionNames = ['third-party/ST-SevenDaysCal'];
  define('/scripts/extensions.js', { extension_settings: peerExtensionSettings, extensionNames: peerExtensionNames });
  const scriptModule = define('/script.js', { is_send_press: false, saveSettingsDebounced() {} });
  const groupModule = define('/scripts/group-chats.js', { is_group_generating: false });
  const nativeWorld = { entries: {} };
  const nativeWorldSettings = { charLore: [] };
  define('/scripts/world-info.js', { loadWorldInfo: async () => nativeWorld, selected_world_info: ['全局书'], world_info: nativeWorldSettings, world_info_case_sensitive: true, world_info_match_whole_words: true, world_names: ['全局书'] });
  define('./manifest.json', { version: '0.1.9-test' });
  const backendSnapshot = { sinceClientCreatedRequestCounts: { get: 3, put: 1, delete: 0 }, latestRead: null, latestWrite: null, lastFailure: null };
  const backendClient = { getDiagnosticSnapshot: () => backendSnapshot };
  define('./src/backend-client.js', { createBackendClient: () => backendClient });
  define('./src/tauri-backend.js', { isTauriTavern: () => false });
  define('./src/private-recall-diagnostics.js', { createPrivateRecallDiagnostics: () => ({ start: async () => false, dispose() {} }) });
  define('./src/bootstrap.js', { bootstrap: options => { bootstrapOptions = options; return { refresh() {}, setEnabled() {}, openMemory() { openMemoryCalls += 1; } }; } });
  const productionSettings = { generalPrompt: '旧通用附加残留', processingPrompt: '  破限接线\n', summaryPrompt: '摘要指导', csePrompt: 'CSE 指导', profilePrompt: '人物资料指导', storyClockReferenceTags: 'Ti,时标', storyCalendars: {} };
  define('./src/settings.js', { createSettingsStore: () => ({ migrateLegacyApiSettings() {}, isEnabled: () => false, get: () => productionSettings, update: patch => Object.assign(productionSettings, patch) }) });
  define('./src/v3/calendar-rules.js', { normalizeStoryCalendar });
  define('./src/api-routing.js', {
    createApiResolver: () => ({}),
    createApiTools: () => ({ abortAll() {} }),
    createTaskRouter: () => ({ generateAnalysisTask: analysisTask, generateUtilityTask: utilityTask, generateRecallTask: recallTask, abortAll() {} }),
  });
  define('./src/compact-api-client.js', { createCompactApiClient: options => { compactOptions = options; return {}; } });
  define('./src/chat-session.js', { createChatSession: options => {
    sessionOptions = options;
    return { prepare: () => options.identityCoordinator.prepare(), identity: () => { if (sessionIdentityError) throw sessionIdentityError; return { chatId: 'test' }; }, invalidate() {}, getState: () => sessionState };
  } });
  define('./src/chat-identity.js', { createChatIdentityCoordinator: options => { identityOptions = options; return { prepare: () => options.freshUuid() }; } });
  define('./src/host-context.js', { cloneHostJsonMetadata, createHostChatList: options => { hostChatListOptions = options; return productionListHostChats; } });
  define('./src/chat-memory-management.js', { createChatMemoryManagement: options => { memoryManagementOptions = options; chatMemoryManagement = { getState: () => ({ status: 'idle' }), deleteCurrent() {} }; return chatMemoryManagement; } });
  define('./src/chat-memory-migration.js', { createChatMemoryMigration: options => { memoryMigrationOptions = options; memoryMigrationRuntime = { getState: () => ({ status: 'idle' }) }; return memoryMigrationRuntime; } });
  define('./src/storage-management.js', { createStorageManagement: options => { storageManagementOptions = options; storageManagement = { getState: () => ({ status: 'idle' }), scan() {}, cleanup() {}, setAutoEnabled() {}, subscribe() {}, dispose() {} }; return storageManagement; } });
  define('./src/plugin-lifecycle.js', {
    createPluginLifecycle: options => {
      lifecycleOptions = options;
      return {
        bind() {},
        async start() { if (failStartupLifecycleStart) { failStartupLifecycleStart = false; throw startupBindingError; } },
        async setEnabled(value) {
          runtimeEnables.push(`lifecycle:${value}`);
          if (value === true) {
            await options.session.prepare();
            void Promise.resolve(options.onPrepared?.({ result: { status: 'ready', identity: { chatId: 'test' } }, isCurrent: () => true, explicitEnable: true }))
              .catch(error => options.onDiagnostic?.(error, 'pluginEnable'));
          }
        },
      };
    },
  });
  define('./src/vector-api.js', { createVectorApiClient: options => { vectorClientOptions = options; return vectorApi; }, resolveVectorConfig: () => null });
  define('./src/v3/vector-index.js', { createVectorIndex: options => { vectorOptions = options; return vectorRuntime; } });
  let vectorWakeCount = 0;
  define('./src/v3/vector-auto-update.js', { createVectorAutoUpdater: options => { vectorAutoOptions = options; return { dispose() {}, refresh() { vectorWakeCount += 1; } }; } });
  define('./src/v3/recall-source.js', { readRecallSource: async options => options });
  define('./src/v3/vector-source-reader.js', { readVectorSource: async options => options });
  let scannedWorldInfoSources = null;
  define('./src/source-permission.js', { createSourcePermissionController: () => ({
    filterWorldInfoSources(sources) { return sources.filter(source => source.sourceName !== 'blocked-book'); },
  }) });
  define('./src/world-info-scanner.js', { scanWorldInfo: async (_context, options) => {
    scannedWorldInfoSources = options.filterBookNames(['blocked-book', 'allowed-book']);
    return { entries: [{ key: 'allowed-book::7', comment: '灯塔', primaryKeys: ['灯塔'], secondaryKeys: [], content: '世界书原文', constant: true }] };
  } });
  const productionHostContext = { eventSource: productionEventSource, eventTypes: productionEventTypes, uuidv4, getRequestHeaders: () => ({ 'X-CSRF-Token': 'token' }), groupId: null, characterId: 0, characters: [{ avatar: 'char.png', name: '角色' }] };
  define('./src/v3/host-adapter.js', {
    captureTargetChatCoordinates: (_snapshot, identity) => ({ hostChatId: identity.hostChatId, characterLocator: identity.characterLocator, characterName: '角色', avatarUrl: 'char.png', requestHeaders: {} }),
    createHostAdapter: options => { hostAdapterOptions = options; return { getContext: () => productionHostContext, getWorldInfoBindings: () => ({}), snapshot: () => ({}) }; },
  });
  define('./src/v3/foundation-store.js', { createFoundationStore: options => { foundationStoreOptions.push(options); return {}; } });
  define('./src/v3/historical-rebuild-task.js', { runHistoricalRebuildTask: async options => { historicalRebuildOptions = options; return { status: 'complete' }; } });
  define('./src/v3/historical-rebuild-sources.js', { captureHistoricalRebuildSources: async () => ({}) });
  let coreStats = { available: false };
  const coreRecordCache = { getStats: () => coreStats };
  define('./src/v3/indexeddb-core-cache.js', { createIndexedDbCoreRecordCache: options => { coreCacheFactoryCalls += 1; coreCacheOptions = options; return coreRecordCache; } });
  const productionReachable = { baseline: { userPersona: { entityId: 'user-id', name: '用户' } }, entities: [
    { id: 'awake-id', entityType: 'person', displayName: '在场人物' }, { id: 'sleep-id', entityType: 'person', displayName: '休眠人物' },
  ] };
  define('./src/v3/foundation-runtime.js', { createFoundationRuntime: options => { foundationOptions = options; return { getReachable: () => productionReachable }; } });
  define('./src/v3/entity-identity.js', {
    resolveIdentityEntityId: (entityId, projection = {}) => projection.identityRedirectsByEntityId?.[entityId] ?? entityId,
    isIdentityDeleted: (entityId, projection = {}) => (projection.deletedEntityIds ?? []).includes(entityId),
  });
  const branchInitializer = async () => ({ status: 'inherited' });
  define('./src/v3/chat-branch-inheritance.js', { createChatBranchInitializer: options => { branchInitializerOptions = options; return branchInitializer; }, copyLatestPeople: async () => null });
  let timeOptions, timeBindOptions, currentStoryContextReads = 0;
  let failStartupLifecycleStart = true;
  const startupBindingError = new TypeError('PRIVATE source startup binding detail');
  const qianshiRecallInputs = [];
  const timeBatches = [];
  let peopleWorkspaceListener = null;
  let calendarInvalidations = 0, calendarRefreshes = 0;
  const timeRuntime = { runBatch: receipt => { timeBatches.push(receipt); }, getState: () => ({}), getActivityState: () => ({ active: false }), invalidate() { calendarInvalidations += 1; }, async refreshStatus() { calendarRefreshes += 1; }, completeStoredUpdate() { timeOptions.onInvalidate?.(); }, recallProjection: async () => null, currentStoryContext: async () => { currentStoryContextReads += 1; return { currentTime: { raw: '5月3日' } }; }, stop: async () => {}, bind(options) { timeBindOptions = options; } };
  define('./src/v3/time-runtime.js', { createTimeStore: () => ({}), createTimeRuntime: options => { timeOptions = options; return timeRuntime; } });
  const memoryStartOptions = [];
  let failMemoryStart = false;
  define('./src/v3/memory-runtime.js', { createV3MemoryRuntime: options => { v3MemoryOptions = options; v3MemoryRuntime = { bind(bindOptions) { v3MemoryBindOptions = bindOptions; }, async start(startOptions) { memoryStartOptions.push(startOptions); backgroundStarts.push('memory'); if (failMemoryStart) throw new TypeError('PRIVATE late memory failure'); }, async setEnabled(value) { runtimeEnables.push(`memory:${value}`); }, async confirmConsecutiveAssistants() { confirmationCalls += 1; }, getState: () => ({}), getActivityState: () => ({ memoryWorkBusy: false, activeExtraction: false, activeCse: false, qianshiHistoryActive: false }), getQianshiRecall: input => { qianshiRecallInputs.push(input); return { text: '' }; }, shouldBlockMainGeneration: () => false, allowsRealtimeTailFromEmpty: () => false }; return v3MemoryRuntime; } });
  define('./src/v3/preparation-diagnostic.js', { preparationFailureDiagnostic: error => ({ prepareStep: null, name: error?.name ?? null, code: error?.code ?? null, detail: null, location: null }) });
  define('./src/v3/message-floor-anchor.js', { persistMessageFloorAnchors: persistAnchors, persistTargetChatIdentity: async () => ({ status: 'persisted' }) });
  define('./src/v3/recall-runtime.js', { createV3RecallRuntime: options => { v3RecallOptions = options; v3RecallRuntime = { bind() {}, async setEnabled(value) { runtimeEnables.push(`recall:${value}`); }, async intercept() {}, invalidate(reason) { recallInvalidations.push(reason); }, getState: () => ({}), getPromptSnapshot: () => null }; return v3RecallRuntime; } });
  define('./src/v3/auto-hide.js', { createAutoHideController: options => { autoHideOptions = options; return { applySettings() {}, stop() {}, dispose() {} }; } });
  define('./src/ui/inline-renderer.js', { createInlineRenderer: options => { inlineRendererOptions = options; return { setEnabled(value) { inlineEnabled.push(value); }, destroy() {} }; } });
  let peopleWorkspaceState = { status: 'ready', chatId: 'test',
    profilesByEntityId: { 'awake-id': { name: '在场人物', birthday: '1月1日' }, 'sleep-id': { name: '休眠人物', birthday: '2月2日' }, 'old-id': { name: '旧身份', birthday: '3月3日' }, 'deleted-id': { name: '已删除', birthday: '4月4日' } },
    identityRedirectsByEntityId: { 'old-id': 'awake-id' }, deletedEntityIds: ['deleted-id'], revision: 1, people: [{ entityId: 'awake-id' }] };
  const peopleWorkspaceRuntime = { async refresh(options) { backgroundStarts.push(['people', options]); }, async setEnabled(value) { runtimeEnables.push(`people:${value}`); }, invalidate() {}, getState: () => peopleWorkspaceState,
    subscribe(listener) { peopleWorkspaceListener = listener; return () => { peopleWorkspaceListener = null; }; } };
  define('./src/v3/people-workspace.js', {
    createPeopleWorkspaceStore: options => { peopleStoreOptions = options; return { read() {}, put() {} }; },
    createPeopleWorkspaceRuntime: options => { peopleWorkspaceOptions = options; return peopleWorkspaceRuntime; },
    projectAnnualPeople: (reachable, workspace) => {
      const projection = { identityRedirectsByEntityId: workspace.identityRedirectsByEntityId, deletedEntityIds: workspace.deletedEntityIds };
      const valid = new Set(reachable.entities.filter(entity => entity.entityType === 'person' && entity.specialRole !== 'user')
        .map(entity => projection.identityRedirectsByEntityId[entity.id] ?? entity.id)
        .filter(entityId => !projection.deletedEntityIds.includes(entityId)));
      const result = new Map();
      for (const [sourceId, profile] of Object.entries(workspace.profilesByEntityId)) {
        const entityId = projection.identityRedirectsByEntityId[sourceId] ?? sourceId;
        if (!valid.has(entityId) || projection.deletedEntityIds.includes(entityId) || result.has(entityId) && sourceId !== entityId) continue;
        result.set(entityId, { entityId, displayName: profile.name, profile });
      }
      return [...result.values()];
    },
  });
  define('./src/v3/public-memory-bridge.js', { installPublicMemoryBridge: options => { publicMemoryBridgeOptions = options; return { bridge: {}, cleanup() {} }; } });
  define('./src/v3/public-qianshi-bridge.js', { installPublicQianshiBridge: options => { publicQianshiBridgeOptions = options; return { bridge: {}, cleanup() {} }; } });
  define('./src/story-clock.js', { createMyKnotsStoryClockController: () => ({ refresh: () => ({ status: 'closed' }), getState: () => ({ status: 'closed' }), clear() {} }), createStoryClockStatusProjection: ({ controller, labelFor }) => options => ({ ...controller.refresh(options), label: labelFor(controller.getState()) }), extensionStoryClockState: () => ({ active: false, custom: false }) });

  const entry = new SourceTextModule(entrySource, { context, identifier: pathToFileURL(resolve(root, 'index.js')).href });
  await entry.link(specifier => {
    const dependency = modules.get(specifier);
    assert.ok(dependency, `未声明的生产入口依赖：${specifier}`);
    return dependency;
  });
  await entry.evaluate();
  await new Promise(resolvePromise => setImmediate(resolvePromise));

  const startupDiagnostic = nativeJson(bootstrapOptions.pluginDiagnosticProvider());
  assert.equal(startupDiagnostic.phase, 'startup');
  assert.equal(startupDiagnostic.failure.name, 'TypeError');
  assert.doesNotMatch(JSON.stringify(startupDiagnostic), /PRIVATE source startup binding detail/u, '真实 index startup provider 只给安全诊断字段');

  await vectorOptions.sourceProvider({ targetIdentity: { hostChatId: 'host-chat', chatId: 'test', characterLocator: 'char.png', personaLocator: 'me.png' } });
  assert.equal(memoryManagementOptions.vectorRuntime, vectorRuntime);
  assert.equal(memoryManagementOptions.memoryMigration, memoryMigrationRuntime);
  assert.equal(typeof memoryMigrationOptions.captureStoryCalendar, 'function');
  assert.equal(typeof memoryMigrationOptions.persistStoryCalendar, 'function');
  assert.equal(coreCacheOptions.localForage, hostLocalForage);
  assert.equal(coreCacheFactoryCalls, 1, '旧设置缺少新字段时仍沿默认开启路径创建单个cache实例');
  assert.equal(coreCacheOptions.accountHandleProvider(), 'isolated-test-user');
  assert.equal(foundationStoreOptions[0].coreRecordCache, coreRecordCache);
  assert.equal(foundationStoreOptions[1].coreRecordCache, coreRecordCache, '生产向量读取复用同一派生缓存实例');
  assert.deepEqual(vectorClientOptions.headers(), { 'X-CSRF-Token': 'token' }, '向量客户端从当前宿主上下文读取 CSRF 头');
  assert.equal(vectorOptions.api, vectorApi);
  assert.equal(typeof vectorOptions.identityProvider, 'function');
  assert.equal(typeof vectorOptions.sourceProvider, 'function');
  assert.equal(vectorAutoOptions.vectorRuntime, vectorRuntime);
  scriptModule.setExport('is_send_press', true);
  for (const eventName of ['generation-stopped', 'generation-ended', 'group-wrapper-finished']) {
    assert.equal(productionEventHandlers.get(eventName)?.size, 1, `${eventName} 唤醒接线必须注册一次`);
    for (const handler of productionEventHandlers.get(eventName)) handler();
  }
  assert.equal(vectorWakeCount, 0, '终止事件同步回调仍不抢在宿主释放生成门控前唤醒');
  scriptModule.setExport('is_send_press', false);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 0));
  assert.equal(vectorWakeCount, 1, '相邻停止、结束和群生成结束事件合并为一次稳定来源检查');
  for (const handler of productionEventHandlers.get('generation-stopped')) handler();
  for (const callback of unloadCallbacks) callback();
  await new Promise(resolvePromise => setTimeout(resolvePromise, 0));
  assert.equal(vectorWakeCount, 1, '卸载清除待执行唤醒，避免页面关闭后触碰运行时');
  assert.equal(['generation-stopped', 'generation-ended', 'group-wrapper-finished']
    .reduce((count, eventName) => count + (productionEventHandlers.get(eventName)?.size ?? 0), 0), 0, '卸载解除向量唤醒事件监听');
  assert.equal(bootstrapOptions.vectorApi, vectorApi);
  assert.equal(bootstrapOptions.vectorIndex, vectorRuntime);
  assert.ok(lifecycleOptions.aborters.includes(vectorRuntime));
  assert.ok(lifecycleOptions.aborters.includes(vectorApi));
  assert.equal(await v3RecallOptions.semanticProvider('vector-input'), 'vector-input');
  assert.equal(v3MemoryOptions.generateAnalysisTask, analysisTask);
  assert.equal(timeOptions.generateTimeTask, utilityTask);
  assert.equal(Object.hasOwn(timeOptions, 'generateAnalysisTask'), false);
  assert.equal(timeOptions.sanitizerOptions, v3MemoryOptions.sanitizerOptions);
  assert.equal(timeOptions.storyClockReferenceTags(), 'Ti,时标');
  assert.equal(timeOptions.annualSettingsProvider().people.map(person => person.entityId).sort().join(','), 'awake-id,sleep-id', '年度来源保留不在当前人物展示候选中的有效资料，并应用合并/删除规则');
  assert.equal(Object.hasOwn(timeOptions, 'onInvalidate'), false, '生产入口不得把普通刻度更新接成整轮召回失效');
  timeRuntime.completeStoredUpdate();
  assert.deepEqual(recallInvalidations, [], '刻度正常落盘不得取消正在进行的召回');
  assert.ok(timeBindOptions.foundationRuntime);
  assert.equal(timeBindOptions.eventSource, productionEventSource);
  assert.equal(timeOptions.isEnabled(), false);
  assert.equal(Object.hasOwn(v3MemoryOptions, 'onMemoryBatchCommitted'), false, '时间从foundation生命周期读正文，不等摘要CSE完成回调');
  assert.equal(timeBatches.length, 0);
  peopleWorkspaceListener({ ...peopleWorkspaceState });
  assert.equal(timeBatches.length, 0, '人物处理状态通知不重跑正文扫描与时间事项读取');
  const unchangedPeople = peopleWorkspaceState.people;
  peopleWorkspaceState = { ...peopleWorkspaceState, status: 'generating', people: unchangedPeople };
  peopleWorkspaceListener(peopleWorkspaceState);
  peopleWorkspaceState = { ...peopleWorkspaceState, status: 'ready', people: unchangedPeople };
  peopleWorkspaceListener(peopleWorkspaceState);
  assert.equal(timeBatches.length, 0, '同人物内容的忙碌/进度阶段结束不额外触发时间更新');
  peopleWorkspaceState = { ...peopleWorkspaceState, revision: 2,
    people: [{ entityId: 'awake-id', profile: { name: '在场人物', birthday: '2月2日' } }] };
  peopleWorkspaceListener(peopleWorkspaceState);
  assert.equal(timeBatches.length, 1, '人物资料/生日变化仍触发时间更新');
  assert.equal(timeBatches[0].chatId, 'test');
  timeBatches.length = 0;
  peopleWorkspaceState = { ...peopleWorkspaceState, revision: 3, identityRedirectsByEntityId: { 'former-id': 'awake-id' },
    people: [{ entityId: 'awake-id', profile: { name: '在场人物', birthday: '2月2日' } }] };
  peopleWorkspaceListener(peopleWorkspaceState);
  assert.equal(timeBatches.length, 1, '人物身份归并变化仍触发时间更新');
  timeBatches.length = 0;
  assert.equal(bootstrapOptions.calendarContextProvider().calendar, null);
  for (const code of ['CHAT_SESSION_DISABLED', 'CHAT_SESSION_NOT_READY', 'CHAT_SESSION_CONTEXT_INVALID', 'CHAT_SESSION_SUSPENDED']) {
    sessionIdentityError = new ChatSessionError('聊天身份暂不可用', code);
    assert.deepEqual(nativeJson(bootstrapOptions.calendarContextProvider()), { chatId: null, calendar: null }, `${code} 不得阻止设置页显示`);
    assert.equal(v3MemoryOptions.storyCalendarProvider(), null);
    assert.equal(timeOptions.storyCalendarProvider(), null);
    await assert.rejects(bootstrapOptions.onCalendarChange({ chatId: 'test', calendar: { months: 4, prefix: '启航' } }), error => error.code === code);
    assert.deepEqual(nativeJson(productionSettings.storyCalendars), {}, '身份不可用时不得保存历法');
    assert.equal(calendarInvalidations, 0); assert.equal(calendarRefreshes, 0);
  }
  sessionIdentityError = null;
  await bootstrapOptions.onCalendarChange({ chatId: 'test', calendar: { months: 4, prefix: '启航' } });
  assert.deepEqual(nativeJson(productionSettings.storyCalendars.test), { months: 4, prefix: '启航' });
  assert.equal(v3MemoryOptions.storyCalendarProvider().months, 4);
  productionSettings.storyCalendars.other = { months: 6, prefix: '远航' };
  assert.deepEqual(nativeJson(v3MemoryOptions.storyCalendarProvider('other')), { months: 6, prefix: '远航' }, '历史目标按其QQJ chatId读取已确认历法，不沿用当前可见聊天');
  assert.equal(v3MemoryOptions.storyCalendarProvider().months, 4, '无目标参数时仍沿用当前聊天历法');
  assert.equal(timeOptions.storyCalendarProvider().prefix, '启航');
  assert.equal(calendarInvalidations, 1); assert.equal(calendarRefreshes, 1);
  assert.equal(timeBatches.length, 0, '保存历法只刷新计算视图，不开启时间 API');
  await assert.rejects(bootstrapOptions.onCalendarChange({ chatId: 'other', calendar: { months: 12, prefix: '' } }), /聊天已变化/u);
  await assert.rejects(bootstrapOptions.onCalendarChange({ chatId: 'test', calendar: { months: 6, prefix: '' } }), /特殊年/u);
  assert.equal(memoryManagementOptions.timeRuntime, timeRuntime);
  const ledgerEnabled = bootstrapOptions.isSevenDaysLedgerInjectionEnabled;
  const peer = peerExtensionSettings['schedule-planner'];
  assert.equal(ledgerEnabled(), false, '共享预设对象不代表开启刻度注入');
  peer.ledgerCaptureEnabled = true; assert.equal(ledgerEnabled(), false, '仅自动标注不冲突');
  peer.ledgerInject = true; assert.equal(ledgerEnabled(), true, '点击时读取当前实际注入设置');
  for (const setting of ['pluginEnabled', 'injectEnabled']) { peer[setting] = false; assert.equal(ledgerEnabled(), false); delete peer[setting]; }
  peerExtensionSettings.disabledExtensions.push(peerExtensionNames[0]); assert.equal(ledgerEnabled(), false);
  peerExtensionSettings.disabledExtensions.length = 0;
  const installed = peerExtensionNames.pop(); assert.equal(ledgerEnabled(), false, '无安装不能仅按设置对象判冲突'); peerExtensionNames.push(installed);
  peer.characterExcludeAvatars = ['char.png']; assert.equal(ledgerEnabled(), false, '当前单聊角色排除生效');
  productionHostContext.groupId = 'group'; assert.equal(ledgerEnabled(), true, '群聊不套单人排除');
  productionHostContext.groupId = null; productionHostContext.characters[0].avatar = ''; peer.characterExcludeAvatars.push(''); assert.equal(ledgerEnabled(), true, '空avatar不作为角色排除');
  productionHostContext.characters[0].avatar = 'char.png'; peer.characterExcludeAvatars = 'prefix-char.png-suffix'; assert.equal(ledgerEnabled(), true, '非数组排除池不作字符串子串匹配'); peer.characterExcludeAvatars = [];
  peer.ledgerInject = false; assert.equal(ledgerEnabled(), false);
  assert.equal(typeof v3RecallOptions.timeProjectionProvider, 'function');
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
  assert.equal(v3MemoryOptions.storyClockReferenceTags(), 'Ti,时标');
  assert.equal(typeof v3MemoryOptions.sanitizerOptions, 'function');
  assert.equal(Object.hasOwn(v3MemoryOptions.sanitizerOptions(), 'storyClockReferenceTags'), false);
  assert.equal(v3MemoryOptions.persistAnchors, persistAnchors, '生产入口必须把真实消息挂标能力注入 memory runtime');
  assert.equal(Object.hasOwn(foundationOptions, 'persistAnchors'), false, 'foundation runtime 不得吞掉挂标能力');
  assert.equal(foundationOptions.deferChatChangeRefreshUntilPrepared, true, '生产切聊刷新必须等待 lifecycle 完成身份准备后再由 memory.start 读取');
  assert.deepEqual(await v3MemoryOptions.persistAnchors({ probe: true }), { status: 'persisted' });
  assert.deepEqual(anchorCalls, [{ probe: true }], '注入的挂标函数必须可由 memory runtime 实际调用');
  assert.equal(v3MemoryBindOptions.eventSource, productionEventSource);
  assert.equal(v3MemoryBindOptions.eventTypes.MESSAGE_SENT, 'sent', '生产 memory runtime 必须接到真实 user 消息事件');
  assert.equal(Object.hasOwn(identityOptions, 'sanitizerOptions'), false);
  assert.equal(Object.hasOwn(identityOptions, 'migrateFork'), false);
  assert.equal(identityOptions.listHostChats, productionListHostChats, '生产入口必须注入真实宿主聊天列表读取器');
  assert.equal(identityOptions.initializeBranch, branchInitializer, '生产入口必须把同角色副本初始化器注入身份准备链');
  assert.equal(branchInitializerOptions.client, backendClient);
  assert.equal(typeof branchInitializerOptions.hostAdapter.snapshot, 'function');
  assert.equal(branchInitializerOptions.sanitizerOptions, v3MemoryOptions.sanitizerOptions);
  assert.deepEqual(hostChatListOptions.headers(), { 'X-CSRF-Token': 'token' });
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
  assert.equal(lifecycleOptions.aborters.length, 5);
  assert.ok(lifecycleOptions.aborters.includes(peopleWorkspaceRuntime));
  assert.equal(typeof lifecycleOptions.onPrepared, 'function', '生产入口必须把身份成功后的后台续接注入 lifecycle');
  assert.deepEqual(backgroundStarts, [], '插件初始关闭时不得绕过 lifecycle 单独启动 memory/people');
  await bootstrapOptions.onPluginEnabledChange(true);
  assert.equal(hostUuidCalls, 3, '关闭后打开插件的身份准备必须调用宿主 uuidv4 且不依赖浏览器 crypto.randomUUID');
  assert.equal(backgroundStarts[0], 'memory');
  assert.equal(memoryStartOptions[0].explicitEnable, true, '真实总开关路径必须把一次性初始化意图传到 memory.start');
  assert.equal(memoryStartOptions[0].targetIdentity.chatId, 'test', '首次启用必须沿准备时身份固定目标');
  assert.equal(backgroundStarts[1]?.[0], 'people');
  assert.equal(backgroundStarts[1]?.[1]?.refreshMemory, false, '人物 workspace 应复用刚完成的记忆快照');
  assert.equal(backgroundStarts.length, 2, '同一身份成功链只准备一次记忆和一次人物 workspace');
  assert.deepEqual(runtimeEnables, ['lifecycle:true', 'recall:true'], '启用链不得在 lifecycle 回调后重复 setEnabled 读取 memory/people');
  assert.equal(peopleStoreOptions.client, backendClient);
  assert.equal(peopleWorkspaceOptions.generateUtilityTask, utilityTask);
  assert.equal(peopleWorkspaceOptions.profilePromptGuidance(), '人物资料指导');
  assert.equal(peopleWorkspaceOptions.processingPrompt(), '  破限接线\n');
  assert.equal(typeof peopleWorkspaceOptions.isMainGenerationActive, 'function', '首次人物整理需让过宿主主楼生成');
  assert.ok(peopleWorkspaceOptions.session); assert.ok(peopleWorkspaceOptions.foundationRuntime); assert.ok(peopleWorkspaceOptions.memoryRuntime);
  assert.equal(bootstrapOptions.peopleWorkspaceRuntime, peopleWorkspaceRuntime);
  assert.equal(bootstrapOptions.chatMemoryManagement, chatMemoryManagement);
  assert.equal(bootstrapOptions.storageManagement, storageManagement);
  assert.equal(storageManagementOptions.client, backendClient);
  assert.equal(storageManagementOptions.memoryRuntime, v3MemoryRuntime);
  assert.deepEqual(bootstrapOptions.sessionStateProvider(), sessionState);
  const claimsBeforeUiWait = hostUuidCalls;
  assert.equal(await bootstrapOptions.prepareSession(), hostUuid);
  assert.equal(hostUuidCalls, claimsBeforeUiWait + 1, '人物页等待入口必须调用现有 session.prepare');
  assert.deepEqual(nativeJson(bootstrapOptions.backendDiagnosticProvider()), { ...backendSnapshot, coreCache: { available: false, enabled: true } });
  coreStats = { available: false, firstFailure: { phase: 'record-read', code: 'IDB_CACHE_TIMEOUT', name: 'Error', elapsedMs: 900, deadlineLatenessMs: 12, lateResult: 'pending', lateElapsedMs: null, lateAt: null, at: 123 } };
  assert.deepEqual(nativeJson(bootstrapOptions.backendDiagnosticProvider()).coreCache, { ...coreStats, enabled: true }, '复制诊断区分cache实例启用与当前不可用状态，并保留安全failure字段');
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
  assert.equal(publicMemoryBridgeOptions.recallRuntime, v3RecallRuntime, '轻量 prompt 快照必须接入生产 recall runtime');
  assert.equal(publicQianshiBridgeOptions.memoryRuntime, v3MemoryRuntime, '千事公共桥必须复用生产 memory runtime');
  assert.equal(typeof publicMemoryBridgeOptions.isEnabled, 'function');
  assert.equal(typeof publicMemoryBridgeOptions.sanitizerOptions, 'function');
  const worldInfo = await publicMemoryBridgeOptions.readWorldInfoProvider();
  assert.deepEqual(scannedWorldInfoSources, ['allowed-book'], '生产入口将整本排除权限映射到 scanner 的书名过滤契约');
  assert.deepEqual(worldInfo.worldbook.map(entry => [entry.uid, entry.content]), [['allowed-book::7', '世界书原文']]);
  assert.ok(v3RecallOptions.store);
  assert.ok(v3RecallOptions.hostAdapter);
  assert.equal(v3RecallOptions.generateUtilityTask, recallTask);
  assert.deepEqual(await v3RecallOptions.qianshiProgressProvider(), { text: '' }, '初始候选仍从同一 memory runtime 读取千事进度');
  assert.equal(currentStoryContextReads, 1, '普通候选召回应保留当前故事时刻提取');
  assert.deepEqual(qianshiRecallInputs[0].currentTime, { raw: '5月3日' });
  const selectedContext = { selectedEventIds: ['saved-event'], selectedMatterIds: [] };
  assert.deepEqual(await v3RecallOptions.qianshiProgressProvider({ status: 'ready' }, selectedContext), { text: '' }, 'selected-only回执沿原保存ID投影');
  assert.equal(currentStoryContextReads, 1, 'selected-only回执不读取其投影不会消费的当前故事时刻');
  assert.equal(qianshiRecallInputs[1].selectedEventIds[0], 'saved-event');
  assert.equal(qianshiRecallInputs[1].selectedMatterIds.length, 0);
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
  v3MemoryOptions.notifyUser({ kind: 'warning', action: 'openMemory', text: '千千结：第 383 楼起等待确认。' });
  assert.equal(toastCalls.length, 1);
  assert.deepEqual(toastCalls[0].slice(0, 2), ['千千结：第 383 楼起等待确认。', undefined]);
  assert.deepEqual({ timeOut: toastCalls[0][2].timeOut, closeButton: toastCalls[0][2].closeButton }, { timeOut: 12000, closeButton: true });
  assert.equal(openMemoryCalls, 0);
  toastCalls[0][2].onclick();
  assert.equal(openMemoryCalls, 1, '提醒点击导航到既有千结入口');
  assert.equal(confirmationCalls, 0, '点击只导航，不直接确认连续 AI');
  failMemoryStart = true;
  await bootstrapOptions.onPluginEnabledChange(true);
  const asyncFailure = nativeJson(bootstrapOptions.pluginDiagnosticProvider());
  assert.equal(asyncFailure.phase, 'pluginEnable');
  assert.equal(asyncFailure.failure.name, 'TypeError', '后台 memory start 快速失败必须保留原异常类型');
  assert.doesNotMatch(JSON.stringify(asyncFailure), /PRIVATE late memory failure/u, '诊断不复制原始错误文本');
  await bootstrapOptions.onPluginEnabledChange(false);
  assert.equal(bootstrapOptions.pluginDiagnosticProvider(), null, '成功的后续总开关操作清除已知旧失败');

  productionSettings.coreCacheEnabled = false;
  const previousStoreCount = foundationStoreOptions.length;
  const disabledEntry = new SourceTextModule(entrySource, { context, identifier: pathToFileURL(resolve(root, 'index.js')).href });
  await disabledEntry.link(specifier => {
    const dependency = modules.get(specifier);
    assert.ok(dependency, `关闭cache的生产入口依赖未声明：${specifier}`);
    return dependency;
  });
  await disabledEntry.evaluate();
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.equal(coreCacheFactoryCalls, 1, '设置关闭后生产入口不创建第二个cache实例');
  await vectorOptions.sourceProvider({ targetIdentity: { hostChatId: 'host-chat', chatId: 'test', characterLocator: 'char.png', personaLocator: 'me.png' } });
  assert.equal(foundationStoreOptions.length, previousStoreCount + 2);
  assert.equal(foundationStoreOptions.at(-2).coreRecordCache, null, '关闭后主要Store接收null');
  assert.equal(foundationStoreOptions.at(-1).coreRecordCache, null, '关闭后向量来源Store接收null');
  assert.equal(memoryManagementOptions.coreRecordCache, null, '关闭后记忆管理失效消费者接收null');
  const inheritedCalendar = { months: 4, prefix: '启航' }, rebuiltTargetId = 'rebuild-target-without-calendar';
  await memoryManagementOptions.createHistoricalRebuild({ storyCalendar: inheritedCalendar });
  assert.equal(historicalRebuildOptions.coreRecordCache, null, '关闭后历史重建消费者接收null');
  assert.deepEqual(historicalRebuildOptions.storyCalendarForChat(rebuiltTargetId), inheritedCalendar, 'index生产入口为新身份继承开始时捕获的目标历法');
  assert.deepEqual(nativeJson(productionSettings.storyCalendars[rebuiltTargetId]), inheritedCalendar, '新身份历法经正式设置保存入口持久化');
  productionSettings.storyCalendars['preconfigured-rebuild-target'] = { months: 12, prefix: '远航' };
  assert.deepEqual(historicalRebuildOptions.storyCalendarForChat('preconfigured-rebuild-target'), { months: 12, prefix: '远航' }, '目标身份已有历法时保留该值');
  assert.deepEqual(nativeJson(bootstrapOptions.backendDiagnosticProvider()).coreCache, { available: false, enabled: false });
});

test('生产 bundle 在 Luker-only 兼容全局下也可隔离加载，关闭时零后端请求', async () => {
  const result = await isolateBundle('Luker');
  assert.equal(result.status, 'evaluated');
  assert.equal(result.publicBridgeType, 'object');
  assert.equal(result.publicBridgeReadStatus, 'disabled');
  assert.equal(result.publicBridgeSnapshotType, 'function');
  assert.equal(result.publicBridgeSnapshotStatus, 'disabled');
  assert.equal(result.publicBridgePromptSnapshotType, 'function');
  assert.equal(result.publicBridgePromptSnapshotStatus, 'disabled');
  assert.equal(result.backendCalls, 0);
  assert.equal(result.backendHealthCalls, 0);
  assert.equal(result.backendDataCalls, 0);
});

test('生产 bundle 在 Luker-only 且插件启用时真实进入身份绑定与旧 V3 root 核对路径', async () => {
  const result = await isolateBundle('Luker', { enabled: true });
  assert.equal(result.status, 'evaluated');
  assert.equal(result.backendDataCalls, 3, '依次读取绑定、核对旧 root，并尝试 CAS 认领');
  assert.equal(result.backendHealthCalls, 1, '旧后端 capability 只核对一次');
  assert.equal(result.backendTrashGcPostCalls, 0, '旧后端不支持时不能提交回收站清理请求');
  assert.equal(result.backendWriteCalls, 1, '仍只尝试一次身份 CAS');
});

test('生产 bundle 在 official-only 且插件启用时真实进入身份绑定与旧 V3 root 核对路径', async () => {
  const result = await isolateBundle('SillyTavern', { enabled: true });
  assert.equal(result.status, 'evaluated');
  assert.equal(result.backendDataCalls, 3, '依次读取绑定、核对旧 root，并尝试 CAS 认领');
  assert.equal(result.backendHealthCalls, 1, '旧后端 capability 只核对一次');
  assert.equal(result.backendTrashGcPostCalls, 0, '旧后端不支持时不能提交回收站清理请求');
  assert.equal(result.backendWriteCalls, 1, '仍只尝试一次身份 CAS');
  const clockCalls = result.promptCalls.filter(call => call[0] === 'myknots_story_clock');
  assert.deepEqual(clockCalls[0], ['myknots_story_clock', '']);
  assert.equal(clockCalls.length, 2);
  assert.match(clockCalls[1][1], /<!-- QQJ-start/);
  assert.match(clockCalls[1][1], /<!-- QQJ-end/);
  assert.deepEqual(clockCalls[1].slice(2), [17, 0, false, 29]);
});

test('生产dist在原生SillyTavern与Luker关闭缓存后不创建IndexedDB实例，正式身份存储入口仍运行', async () => {
  for (const host of ['SillyTavern', 'Luker']) {
    const result = await isolateBundle(host, { enabled: true, coreCacheEnabled: false });
    assert.equal(result.status, 'evaluated', `${host}生产包应正常启动`);
    assert.equal(result.localForageCreateCalls, 0, `${host}关闭设置不得创建localForage实例`);
    assert.equal(result.backendDataCalls, 3, `${host}正式身份/地基存储请求仍沿后端执行`);
    assert.equal(result.backendHealthCalls, 1, `${host}旧后端 capability 只核对一次`);
    assert.equal(result.backendTrashGcPostCalls, 0, `${host}旧后端不提交回收站清理请求`);
    assert.equal(result.backendWriteCalls, 1, `${host}正式身份存储仍只尝试一次 CAS`);
  }
});

test('生产 bundle 不向现有消息楼插入节点、样式或楼卡专属订阅', async () => {
  const result = await isolateBundle('SillyTavern', { withExistingPanel: true });
  assert.equal(result.status, 'evaluated');
  assert.equal(result.mesAppendCalls, 0);
  assert.deepEqual(result.message.children, []);
  assert.equal(result.message.className, 'mes user-owned');
  assert.equal(result.styleAppendCalls, 0);
  assert.equal(result.observerInstances, 0);
  assert.equal(result.eventRegistrations.get('chat'), 6, '保留 lifecycle、V3 foundation、V3 memory、V3 recall、时间推演与时间戳协调六份结构订阅');
  assert.equal(result.eventRegistrations.get('persona'), 2, '人物身份变动除 lifecycle 外还需使年度提醒缓存失效');
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
    for (const call of recallCalls) assert.deepEqual(call, ['qqj_v3_recalled_context', '', 17, 2, false, 29]);
    assert.deepEqual(clockCalls, [['myknots_story_clock', '']], `${hostGlobalName}/${mainApi}`);
  }
});

test('生产 bundle 的 native 与 Luker 入口将未清理正文中的地点标注送入真实召回提示与回执', async () => {
  for (const hostGlobalName of ['SillyTavern', 'Luker']) {
    const result = await isolateBundle(hostGlobalName, {
      enabled: true, locationReferenceChat: true, invokeLocationReference: true,
    });
    assert.equal(result.status, 'evaluated', `${hostGlobalName} bundle 应正常启动`);
    const prompt = result.promptCalls.filter(call => call[0] === 'qqj_v3_recalled_context').at(-1);
    assert.ok(prompt, `${hostGlobalName} 实际入口应调用 QQJ 召回槽`);
    assert.match(prompt[1], /东区公寓·卧室/u, `${hostGlobalName} 真实提示应包含来源地点参考（result=${JSON.stringify(result.locationReferenceResult)}，warnings=${JSON.stringify(result.startupWarnings.map(item => String(item[1]?.stack ?? item[1])))}，prompt=${JSON.stringify(prompt[1])}，receipt=${JSON.stringify(result.hostChat[1]?.extra?.qqj_v3_recall_receipt)}，backend=${result.backendDataCalls}/${result.backendWriteCalls}）`);
    const receipt = result.hostChat[1]?.extra?.qqj_v3_recall_receipt;
    assert.equal(receipt?.schemaVersion, 18, `${hostGlobalName} 应保存新版地点参考回执`);
    assert.ok(result.chatSaveCalls > 0, `${hostGlobalName} 应通过宿主保存入口持久化回执`);
    assert.ok(receipt?.selectedLocationReferences?.some(value => value.text === '东区公寓·卧室'), `${hostGlobalName} 回执应记录选中的地点参考`);
    assert.equal(receipt.injectionText, prompt[1], `${hostGlobalName} 已保存回执应与实际提示全文一致`);
    assert.match(receipt.injectionText, /东区公寓·卧室/u, `${hostGlobalName} 回执正文应与实际注入相符`);
    assert.equal(receipt.selectedLocationReferences[0].hostLocator.messageIndex, 0, `${hostGlobalName} 应保留真实宿主来源楼号`);
    assert.equal(Object.hasOwn(receipt.selectedLocationReferences[0], 'floorId'), false, `${hostGlobalName} 未摘要楼不能伪造floorId`);
  }
});

test('候选 bundle 的 native/Luker 旧回执复用让前情与普通召回共享预算并同步公开快照', async () => {
  const contextSize = 8192;
  const prequelText = Array.from({ length: 160 }, (_, index) =>
    `此前林岚在月台整理旧账，第${index + 1}段记录信件编号与后续约定。`
  ).join('\n');
  const standalonePrequel = selectPrequel({ text: prequelText, contextSize });
  assert.ok(standalonePrequel.injectionText.length > 0, '独立前情选择应产生可比较的格式化片段');
  for (const hostGlobalName of ['SillyTavern', 'Luker']) {
    const result = await isolateBundle(hostGlobalName, {
      enabled: true,
      legacyReceiptUi: true,
      legacyReceiptPrequelBudget: { contextSize, text: prequelText },
    });
    assert.equal(result.status, 'evaluated', `${hostGlobalName} bundle应启动`);
    assert.ok(result.historicalReceiptCheck?.restoredReceipt, `${hostGlobalName} 输入应是有效旧签名回执`);
    const measured = result.legacyReceiptPrequelBudgetResult;
    assert.equal(measured?.intercept?.lastRecall?.reusedReceipt, true, `${hostGlobalName} 应复用同一USER的旧回执`);
    assert.equal(measured?.receipt?.schemaVersion, 18, `${hostGlobalName} 不应重写当前回执版本`);
    assert.equal(measured?.receipt?.receiptFingerprint, measured?.initialReceiptFingerprint, `${hostGlobalName} 原回执签名保持不变`);
    const ordinaryInjectionText = measured?.initialReceipt?.injectionText ?? '';
    const budget = recallBudget(contextSize);
    assert.ok(ordinaryInjectionText.length > 0 && ordinaryInjectionText.length <= budget.totalCharacters,
      `${hostGlobalName} 首轮正式普通召回应非空且处于单独额度内`);
    assert.ok(estimateRecallTokens(ordinaryInjectionText) <= budget.totalTokens,
      `${hostGlobalName} 首轮正式普通召回应处于单独token额度内`);
    assert.match(ordinaryInjectionText, /林岚/u, `${hostGlobalName} 正式选择应匹配具名人物`);
    assert.match(ordinaryInjectionText, /archive ledger/iu, `${hostGlobalName} 正式选择应匹配查询主题`);
    assert.ok(ordinaryInjectionText.length + standalonePrequel.injectionText.length > budget.totalCharacters
      || estimateRecallTokens(ordinaryInjectionText) + standalonePrequel.estimatedTokens > budget.totalTokens,
    `${hostGlobalName} 未收紧的正式普通召回与独立前情应至少超出一种共同预算`);
    assert.equal(measured?.receipt?.injectionText, ordinaryInjectionText, `${hostGlobalName} 普通回执原文保持不变`);
    assert.equal(measured?.recallSlot, ordinaryInjectionText, `${hostGlobalName} 实际普通注入槽保留正式回执全文`);
    assert.equal(typeof measured?.prequelSlot, 'string', `${hostGlobalName} 应记录实际前情槽，即使剩余额度不足以注入片段`);
    assert.ok(measured.recallSlot.length + measured.prequelSlot.length <= budget.totalCharacters, `${hostGlobalName} 两槽字符不超共同预算`);
    assert.ok(estimateRecallTokens(measured.recallSlot) + estimateRecallTokens(measured.prequelSlot) <= budget.totalTokens, `${hostGlobalName} 两槽token不超共同预算`);
    assert.equal(measured.promptSnapshot?.recall?.text, measured.recallSlot, `${hostGlobalName} 公开普通召回快照应与注入槽一致`);
    assert.equal(measured.promptSnapshot?.prequel?.text, measured.prequelSlot, `${hostGlobalName} 公开前情快照应与注入槽一致`);
    console.log(`[prequel-budget] ${JSON.stringify({ host: hostGlobalName, ordinaryCharacters: ordinaryInjectionText.length,
      ordinaryTokens: estimateRecallTokens(ordinaryInjectionText), prequelCharacters: measured.prequelSlot.length,
      prequelTokens: estimateRecallTokens(measured.prequelSlot), combinedBudgetCharacters: budget.totalCharacters,
      combinedBudgetTokens: budget.totalTokens, untrimmedPrequelCharacters: standalonePrequel.injectionText.length,
      untrimmedPrequelTokens: standalonePrequel.estimatedTokens, reused: measured.intercept?.lastRecall?.reusedReceipt === true })}`);
  }
});

test('生产 bundle 的 native/Luker 默认历史reader将旧回执接入楼卡并按需展开原文与目标对象', async () => {
  for (const hostGlobalName of ['SillyTavern', 'Luker']) {
    const result = await isolateBundle(hostGlobalName, { enabled: true, legacyReceiptUi: true });
    assert.equal(result.status, 'evaluated', `${hostGlobalName} bundle 应正常启动`);
    assert.equal(result.initialHistoricalReceiptSchemaVersion, 10, '生产bundle启动前应提供旧schema10原始回执');
    assert.ok(result.historicalReceiptCheck?.restoredReceipt, `${hostGlobalName} 测试夹具必须是默认历史reader可读的旧签名回执`);
    let card;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const message = result.receiptDocument.chat.querySelectorAll('.mes')[1];
      const inlineHost = message?.querySelector('.mes_text')?.querySelector('[data-qqj-inline-host="true"]');
      card = inlineHost?.__qqjInlineCard;
      if (card?.recallUi?.events?.querySelector('.legacy-receipt')) break;
      await new Promise(resolvePromise => setImmediate(resolvePromise));
    }
    assert.ok(card, `${hostGlobalName} 应由实际inline renderer挂载用户楼卡`);
    let publicSnapshot = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      publicSnapshot = result.getPublicSnapshot();
      if (publicSnapshot?.memory?.status === 'ready' && publicSnapshot.memory.syncStatus === 'idle') break;
      await new Promise(resolvePromise => setImmediate(resolvePromise));
    }
    assert.equal(publicSnapshot?.memory?.status, 'ready', `${hostGlobalName} 的已有记忆投影应完成准备`);
    assert.equal(publicSnapshot.memory.syncStatus, 'idle', `${hostGlobalName} 的既有记忆同步应处于空闲状态`);
    await new Promise(resolvePromise => setImmediate(resolvePromise));
    card.toggle.click();
    let drawer = card.recallUi.events.querySelector('.legacy-receipt');
    assert.ok(drawer, `${hostGlobalName} 默认历史reader应识别签名schema10回执（startup=${JSON.stringify(result.startupWarnings.map(item => String(item[1]?.stack ?? item[1])))}；receipt=${JSON.stringify(result.hostChat[1]?.extra?.qqj_v3_recall_receipt)}；publicCheck=${JSON.stringify(result.historicalReceiptCheck)}）`);
    assert.equal(drawer.open, false, '原文默认折叠');
    assert.equal(drawer.querySelector('.legacy-receipt-copy'), null, '折叠时不构建完整原文节点');
    const backendCallsBeforeExpand = result.backendCalls;
    drawer.open = true; drawer.emit('toggle');
    const original = drawer.querySelector('.legacy-receipt-copy');
    assert.equal(original?.textContent, '旧版召回原文：这段文本应按纯文本折叠展示。', `${hostGlobalName} 展开显示已签回执原文`);
    card.recallUi.peopleTab.click();
    await new Promise(resolvePromise => setImmediate(resolvePromise));
    const changeRows = card.recallUi.people.querySelectorAll('.change-entry');
    assert.equal(changeRows.length, 1, `${hostGlobalName} 人物页应展示旧回执中的变化`);
    assert.match(changeRows[0].textContent, /→ 周宁：仍维持同一约定/u, `${hostGlobalName} 变化行应显示目标名称`);
    assert.doesNotMatch(changeRows[0].textContent, /11111111-1111-4111-8111-111111111112/u, '内部目标ID不展示');
    assert.equal(result.backendCalls, backendCallsBeforeExpand, '切页与展开原文不应发起额外后端请求');
  }
});
