import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHostAdapter } from '../src/v3/host-adapter.js';
import { createFoundationStore } from '../src/v3/foundation-store.js';
import { createFoundationRuntime } from '../src/v3/foundation-runtime.js';
import { createV3MemoryRuntime, projectMemoryPersonEntities } from '../src/v3/memory-runtime.js';
import { scanAssistantCandidates } from '../src/v3/foundation-domain.js';
import { createV3RecallRuntime } from '../src/v3/recall-runtime.js';
import { createV3FoundationView } from '../src/ui/v3-foundation-view.js';
import { readRecallSource } from '../src/v3/recall-source.js';
import { historySelectionContext, selectRecall } from '../src/v3/recall-selector.js';
import { buildExtractorSystemPrompt, buildHighFloorExtractorSystemPrompt, createExtractorEnvelope, DEFAULT_EXTRACTOR_GUIDANCE, EXTRACTOR_FIXED_CONTRACT, EXTRACTOR_OUTPUT_CONTRACT, EXTRACTOR_PROMPT_VERSION, EXTRACTOR_SYSTEM_PROMPT, normalizeExtractorResponse, runExtractorRequest } from '../src/v3/extractor.js';
import { buildCseSystemPrompt, CSE_FIXED_CONTRACT, CSE_SYSTEM_PROMPT, createCseEnvelope, DEFAULT_CSE_GUIDANCE } from '../src/v3/cse-engine.js';
import { BASE_PROCESSING_PROMPT } from '../src/internal-processing-prompt.js';
import { buildEntityIdentityDirectory } from '../src/v3/entity-identity.js';
import { projectInlineMemoryFloor } from '../src/ui/inline-projection.js';
import { validateFloorMemory } from '../src/v3/memory-schema.js';
import { captureFloorVariableReference } from '../src/v3/floor-variable-reference.js';
import { createCompactApiClient } from '../src/compact-api-client.js';
import { createTaskRouter } from '../src/api-routing.js';
import { createChatIdentityCoordinator, CHAT_IDENTITY_COLLECTION } from '../src/chat-identity.js';
import { createChatSession } from '../src/chat-session.js';
import { createPluginLifecycle } from '../src/plugin-lifecycle.js';
import { createTimeRuntime, createTimeStore } from '../src/v3/time-runtime.js';
import { createQianshiCandidateIndex, prepareQianshiCandidates, projectQianshiGraph } from '../src/v3/qianshi-domain.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GENERATION = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-09-02T00:00:00.000Z';
const assistant = mes => ({ is_user: false, is_system: false, mes, swipes: [mes], swipe_id: 0 });
const user = mes => ({ is_user: true, is_system: false, mes, send_date: `test-user:${mes}` });
const legacyScanner = async (chat, options) => {
  const candidates = await scanAssistantCandidates(chat, options);
  return Object.freeze(candidates.map((candidate, index) => index < candidates.length - 1 || candidate.stabilityProof
    ? Object.freeze({ ...candidate, stabilityProof: Object.freeze({ kind: 'nextUser', messageIndex: candidate.hostLocator.messageIndex + 1, fingerprint: `sha256:${createHash('sha256').update(`legacy-memory-test-${index}`).digest('hex')}` }) })
    : candidate));
};
const uuidFactory = () => { let value = 0; return () => `${(++value).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`; };
const compactResponse = (content, status = 200) => status >= 400
  ? { ok: false, status, text: async () => '' }
  : { ok: true, status, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }] }) };
const taskRouter = fetchImpl => {
  const route = { kind: 'independent', source: 'test', sourceLabel: '测试 API', config: { url: 'https://api.example.test/v1', key: 'TEST_KEY', model: 'test-model', excludeParams: [], timeoutSec: 5, stream: false } };
  return createTaskRouter({ resolver: { resolve: () => route, resolveUtility: () => route }, compactClient: createCompactApiClient({ fetchImpl, retryWait: async () => {}, timeoutMs: () => 2 }) });
};

function viewHarness(runtime, { navigatorRef, pluginVersion = 'test', page = 'memories' } = {}) {
  const documentRef = { activeElement: null, createElement: tag => new ViewNode(tag) };
  class ViewNode {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.textContent = ''; this.className = ''; this.disabled = false; this.value = ''; this.open = false; this.selectionStart = 0; this.selectionEnd = 0; this.attributes = {}; }
    append(...nodes) { for (const node of nodes) { this.children.push(node); if (node instanceof ViewNode) node.parentNode = this; } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    click() { return this.listeners.click?.(); }
    fire(name) { return this.listeners[name]?.(); }
    focus() { documentRef.activeElement = this; }
    closest(selector) { for (let node = this; node; node = node.parentNode) if (selector.startsWith('.') && node.className.split(' ').includes(selector.slice(1))) return node; return null; }
    getBoundingClientRect() { return { top: 0, bottom: 100, height: 100 }; }
    descendants() { return this.children.flatMap(child => child instanceof ViewNode ? [child, ...child.descendants()] : []); }
    querySelector(selector) {
      const nodes = this.descendants();
      if (selector.startsWith('.')) return nodes.find(node => node.className.split(' ').includes(selector.slice(1))) ?? null;
      const attribute = selector.match(/^\[([^=]+)="([^"]*)"\]$/);
      return attribute ? nodes.find(node => node.attributes[attribute[1]] === attribute[2]) ?? null : null;
    }
  }
  const flatten = node => [node, ...(node.children ?? []).flatMap(flatten)];
  const container = new ViewNode('main');
  const view = createV3FoundationView({ runtime, documentRef, navigatorRef, pluginVersion }); view.setPage(page); view.mount(container);
  return { view, container, flatten };
}

test('人物选择投影只保留有效 person，主角色与用户仍可选择', () => {
  const people = projectMemoryPersonEntities([
    { id: 'user', entityType: 'person', displayName: '林岚', specialRole: 'user', recordStatus: 'active', status: 'active' },
    { id: 'character', entityType: 'person', displayName: '裴晚生', specialRole: 'character', recordStatus: 'active', status: 'active' },
    { id: 'place', entityType: 'place', displayName: '钟楼', recordStatus: 'active', status: 'active' },
    { id: 'merged', entityType: 'person', displayName: '旧人物', recordStatus: 'active', status: 'merged' },
  ]);
  assert.deepEqual(people.map(item => item.entityId), ['user', 'character']);
});

function backendHarness() {
  const records = new Map();
  const calls = [];
  let conflictRoot = false;
  let rootGate = null;
  let abortAfterPut = null;
  let beforePut = null;
  let afterPut = null;
  let beforeGet = null;
  const envelope = (data, revision) => ({ schemaVersion: 1, revision, generationId: '11111111-1111-4111-8111-111111111111', createdAt: NOW, updatedAt: NOW, data: structuredClone(data) });
  const error = status => Object.assign(new Error(`HTTP ${status}`), { status });
  return { records, calls, setConflictRoot(value) { conflictRoot = value; }, setBeforeGet(value) { beforeGet = value; }, setBeforePut(value) { beforePut = value; }, setAfterPut(value) { afterPut = value; }, abortAfterNextPut(predicate) { abortAfterPut = predicate; }, holdNextRootPut() {
    let release, markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    rootGate = { started: markStarted, wait };
    return { started, release };
  }, client: {
    async get(collection, key) { calls.push(['get', collection, key]); if (beforeGet) await beforeGet({ collection, key, records }); const found = records.get(`${collection}/${key}`); if (!found) throw error(404); return envelope(found.data, found.revision); },
    async put(collection, key, data, expectedRevision, options = {}) { calls.push(['put', collection, key, expectedRevision]); if (beforePut) await beforePut({ collection, key, data, expectedRevision }); const mapKey = `${collection}/${key}`; if (key === 'v3-root' && rootGate) { const gate = rootGate; rootGate = null; gate.started(); await gate.wait; if (options.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' }); } if (key === 'v3-root' && conflictRoot) throw error(409); const previous = records.get(mapKey); if ((previous?.revision ?? 0) !== expectedRevision) throw error(409); const revision = (previous?.revision ?? 0) + 1; records.set(mapKey, { revision, data: structuredClone(data) }); if (afterPut) await afterPut({ collection, key, data, expectedRevision, revision, records }); if (abortAfterPut?.(key, data)) { abortAfterPut = null; throw Object.assign(new Error('aborted after durable write'), { name: 'AbortError' }); } return envelope(data, revision); },
  } };
}

function browserStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const calls = [];
  return {
    values,
    calls,
    getItem(key) { calls.push(['getItem', key]); return values.get(key) ?? null; },
    setItem(key, value) { calls.push(['setItem', key, value]); values.set(key, value); },
    removeItem(key) { calls.push(['removeItem', key]); values.delete(key); },
  };
}

function harness({ text = '裴晚生提醒你带伞。', initialChat = null, utility, host = 'official', automation = { enabled: false, batchSize: 2 }, notifyUser, isMainGenerationActive, onAutomaticSummaryCommitted = () => {}, onMemoryBatchCommitted = () => {}, extractorPromptGuidance, csePromptGuidance, processingPrompt, storyClockReferenceTags = '', sanitizerOptions = () => ({}), foundationRefresh, foundationFetch = undefined, eventTypes = null, sharedBackend = null, sharedContext = null, modernAnchors = false, persistAnchors = null, readOnlyLifecycle = false, identityProjectionProvider = null, qianshiCandidatePreparer = undefined, qianshiCandidateIndexFactory = undefined, failureStorage = undefined, now = () => new Date(NOW) } = {}) {
  let enabled = true;
  const handlers = new Map();
  const warnings = [];
  const context = sharedContext ? { ...sharedContext } : {
    name1: '林岚', personaId: 'persona-linlan', characterId: 0, groupId: null, chatId: 'host-chat', characters: [{ avatar: 'character.png' }], userAvatar: 'persona.png',
    chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT } }, chat: initialChat ?? [user('继续'), assistant(text), assistant('用于确认上一楼稳定。')],
  };
  context.eventTypes = eventTypes ?? context.eventTypes ?? Object.fromEntries(['GENERATION_STARTED', 'GENERATION_STOPPED', 'GENERATION_ENDED', 'STREAM_TOKEN_RECEIVED', 'CHAT_CHANGED', 'CHAT_RENAMED', 'MESSAGE_SENT', 'USER_MESSAGE_RENDERED', 'MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MORE_MESSAGES_LOADED'].map(name => [name, name]));
  context.eventSource = { on(name, listener) { const values = handlers.get(name) ?? []; values.push(listener); handlers.set(name, values); } };
  const globalRef = host === 'luker' ? { Luker: { getContext: () => context } } : { SillyTavern: { getContext: () => context } };
  const baseHostAdapter = createHostAdapter({ globalRef });
  let snapshotCalls = 0;
  const hostAdapter = Object.freeze({ ...baseHostAdapter, snapshot() { snapshotCalls += 1; return baseHostAdapter.snapshot(); } });
  const backend = sharedBackend ?? backendHarness();
  const identityProvider = () => ({ hostChatId: context.chatId, chatId: context.chatMetadata.qianqianjie.chatId, characterLocator: 'character.png', personaLocator: 'persona.png' });
  const baseStore = createFoundationStore({ client: backend.client, contextProvider: identityProvider, isEnabled: () => enabled });
  const readReachableModes = [];
  const store = Object.freeze({
    ...baseStore,
    readReachable(options) {
      readReachableModes.push(options?.mode ?? 'full');
      return baseStore.readReachable(options);
    },
  });
  const currentSanitizerOptions = () => typeof sanitizerOptions === 'function' ? sanitizerOptions() : sanitizerOptions;
  const foundationBase = createFoundationRuntime({ hostAdapter, store, fetchImpl: foundationFetch, contextProvider: () => context, isEnabled: () => enabled, sanitizerOptions: currentSanitizerOptions, scanCandidates: modernAnchors ? scanAssistantCandidates : legacyScanner, newUuid: uuidFactory(), now: () => new Date(NOW), logger: { warn() {} } });
  const foundationRuntime = {
    ...foundationBase,
    ...(!readOnlyLifecycle ? { inspect: reason => foundationBase.reconcile(`testSetup:${reason}`) } : {}),
    ...(typeof foundationRefresh === 'function' ? { refreshStatus: () => foundationRefresh(foundationBase) } : {}),
  };
  const calls = [];
  const generateUtilityTask = async options => {
    calls.push(options);
    if (utility) {
      const request = JSON.parse(options.taskMessages[0].content);
      return utility(options, calls.length);
    }
    return { jsonData: { summary: '裴晚生提醒用户带伞。', people: [{ name: '裴晚生' }, { name: '你', role: 'user' }], events: [{ title: '带伞提醒', description: '裴晚生提醒用户带伞。' }] }, taskMetadata: { source: 'shared-utility', sourceLabel: '机械副 API', model: 'mock-model', finishReason: 'stop' } };
  };
  const runtime = createV3MemoryRuntime({ foundationRuntime, store, hostAdapter, generateAnalysisTask: generateUtilityTask, generateUtilityTask, isEnabled: () => enabled, automationSettings: () => automation, notifyUser, isMainGenerationActive, onAutomaticSummaryCommitted, onMemoryBatchCommitted, extractorPromptGuidance: () => typeof extractorPromptGuidance === 'function' ? extractorPromptGuidance() : '', csePromptGuidance: () => typeof csePromptGuidance === 'function' ? csePromptGuidance() : '', processingPrompt: () => typeof processingPrompt === 'function' ? processingPrompt() : (processingPrompt ?? ''), storyClockReferenceTags: () => typeof storyClockReferenceTags === 'function' ? storyClockReferenceTags() : storyClockReferenceTags, sanitizerOptions: currentSanitizerOptions, persistAnchors, identityProjectionProvider, ...(qianshiCandidatePreparer ? { qianshiCandidatePreparer } : {}), ...(qianshiCandidateIndexFactory ? { qianshiCandidateIndexFactory } : {}), failureStorage, now, newUuid: uuidFactory(), logger: { warn(...args) { warnings.push(args); } } });
  runtime.bind({ eventSource: context.eventSource, eventTypes: context.eventTypes });
  const emit = (name, ...args) => (handlers.get(name) ?? []).forEach(listener => listener(...args));
  return { runtime, foundationRuntime, store, backend, context, hostAdapter, calls, warnings, emit, readReachableModes, snapshotCount: () => snapshotCalls, setEnabled(value) { enabled = value; }, setAutomation(value) { automation = value; } };
}

async function waitFor(predicate, message = '等待异步状态超时') {
  for (let attempt = 0; attempt < 5000; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail(typeof message === 'function' ? message() : message);
}

const registeredGraphCaughtUp = state => state.stableCount > 0
  && state.summaryCompletedCount === state.stableCount
  && state.rebuildCompletedCount === state.stableCount
  && ['caughtUp', 'waitingRealtime'].includes(state.rebuildStatus);

async function primeRealtimeTail(h) {
  await h.runtime.start();
  assert.equal(h.calls.length, 0, 'runtime 启动只检测历史覆盖，不得调用记忆 API');
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => ['caughtUp', 'waitingRealtime'].includes(h.runtime.getState().rebuildStatus));
  h.calls.splice(0);
  h.setAutomation({ enabled: true, batchSize: 2 });
  await h.runtime.refreshAutomation();
  assert.equal(h.calls.length, 0, '开启新楼维护不得回头调用历史记忆 API');
}

test('连续 AI 显式确认后按楼顺序接入现有摘要流水，确认前与普通尾楼均不调用模型', async () => {
  const h = harness({
    modernAnchors: true,
    initialChat: [user('开始'), assistant('连续第一楼'), assistant('连续第二楼'), user('确认连续段'), assistant('普通尾楼')],
    automation: { enabled: false, batchSize: 1 },
    utility: options => {
      const request = JSON.parse(options.taskMessages[0].content);
      return request.task === 'extractFloorSemantics'
        ? { jsonData: { summary: `摘要：${request.payload.canonicalContent}` } }
        : { jsonData: { noMaterialChange: true } };
    },
  });
  await h.runtime.start();
  let state = h.runtime.getState();
  assert.equal(h.calls.length, 0, '没有用户确认时不得自动调用摘要模型');
  assert.deepEqual(state.consecutiveAssistantConfirmation.candidates.map(item => [item.messageIndex, item.confirmationRequired]), [[1, true], [2, false]]);
  const scope = structuredClone(state.consecutiveAssistantConfirmation);
  state = await h.runtime.confirmConsecutiveAssistants(scope);
  const extractorRequests = h.calls
    .map(call => JSON.parse(call.taskMessages[0].content))
    .filter(request => request.task === 'extractFloorSemantics');
  assert.deepEqual(extractorRequests.map(request => request.payload.canonicalContent), ['连续第一楼', '连续第二楼']);
  assert.deepEqual(state.floors.map(floor => [floor.messageIndex, floor.summary]), [[1, '摘要：连续第一楼'], [2, '摘要：连续第二楼']]);
  assert.deepEqual(state.unregisteredCandidates.map(item => [item.messageIndex, item.reason]), [[4, 'waitingNextUser']], '普通末尾 AI 不得被本次确认顺带登记');
  const resumed = harness({ modernAnchors: true, sharedBackend: h.backend, sharedContext: h.context,
    automation: { enabled: false, batchSize: 1 } });
  await resumed.runtime.start();
  const resumedState = resumed.runtime.getState();
  assert.equal(resumedState.rememberedCount, 2, '刷新重载后已确认各楼保持可达，不再反复卡住同一连续段');
  assert.deepEqual(resumedState.unregisteredCandidates.map(item => [item.messageIndex, item.reason]), [[4, 'waitingNextUser']]);
  assert.equal(resumed.calls.length, 0, '刷新重载只读取已保存结果，不重复调用模型');
});

test('正常逐楼摘要准备复用增量千事索引，连续新增楼只做一次完整投影', async () => {
  let projections = 0;
  const h = harness({ modernAnchors: true,
    initialChat: Array.from({ length: 4 }, (_, index) => [assistant(`普通楼 ${index + 1}`), user(`确认 ${index + 1}`)]).flat(),
    automation: { enabled: false, batchSize: 1 },
    qianshiCandidateIndexFactory: () => createQianshiCandidateIndex({ projector: (...args) => { projections += 1; return projectQianshiGraph(...args); } }),
    utility: options => JSON.parse(options.taskMessages[0].content).task === 'extractFloorSemantics'
      ? { jsonData: { summary: `摘要 ${JSON.parse(options.taskMessages[0].content).payload.canonicalContent}` } }
      : { jsonData: { noMaterialChange: true } },
  });
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()) && !h.runtime.getState().memoryWorkBusy);
  assert.equal(h.calls.filter(call => JSON.parse(call.taskMessages[0].content).task === 'extractFloorSemantics').length, 4);
  assert.equal(projections, 1, '正式逐楼摘要准备与依赖复核共用会话索引，不逐楼重建千事全图');
});

test('连续 AI 旧确认范围被拒绝时刷新候选并明确报错，不误报完成或调用模型', async () => {
  const h = harness({ modernAnchors: true,
    initialChat: [user('开始'), assistant('已见一'), assistant('已见二'), user('确认已见段'), assistant('当时的普通尾楼')],
    automation: { enabled: false, batchSize: 1 } });
  await h.runtime.start();
  const scope = structuredClone(h.runtime.getState().consecutiveAssistantConfirmation);
  h.context.chat.push(assistant('弹窗后新增'), user('新增楼的锚'));
  await assert.rejects(h.runtime.confirmConsecutiveAssistants(scope), error => error?.code === 'V3_MEMORY_STALE'
    && /确认范围已经变化/.test(error.message));
  assert.equal(h.calls.length, 0);
  assert.equal(h.runtime.getState().stableCount, 0);
  assert.ok(h.runtime.getState().consecutiveAssistantConfirmation.candidates.length > scope.candidates.length, '失败后应刷新并展示最新确认范围');
});

async function primeEarlyGenerationTail(h) {
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => ['caughtUp', 'waitingRealtime'].includes(h.runtime.getState().rebuildStatus));
  assert.equal(h.runtime.getState().rememberedCount, 1, '提前固定测试必须先有一楼有效记忆');
  h.calls.splice(0);
}

test('高楼压缩把 23 个连续 AI 楼按 10/10/3 写成三份记忆并各分析一次 CSE', async () => {
  const sourceBatchSizes = [];
  const h = harness({
    modernAnchors: true,
    initialChat: Array.from({ length: 23 }, (_, index) => [assistant(`高楼正文 ${index + 1}：共同原句`), { ...user(`确认 ${index + 1}`), send_date: `high-floor-${index + 1}` }]).flat(),
    automation: { enabled: false, batchSize: 1 },
    utility: options => {
      const request = JSON.parse(options.taskMessages[0].content);
      if (request.task === 'extractFloorSemantics') {
        sourceBatchSizes.push(request.payload.sourceFloors?.length ?? 1);
        assert.equal(options.systemPrompt, buildHighFloorExtractorSystemPrompt('', ''));
        return { jsonData: { summary: `压缩 ${sourceBatchSizes.length}`, ...(sourceBatchSizes.length === 1 ? { exactQuotes: [
          { text: '共同原句', sourceFloorKey: 'floor-1', why: '跨楼同句一' },
          { text: '共同原句', sourceFloorKey: 'floor-2', why: '跨楼同句二' },
        ] } : {}) } };
      }
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild({ aggregate: true });
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()) && !h.runtime.getState().activeAutoMemory,
    () => JSON.stringify(h.runtime.getState()));
  const graph = await h.store.readReachable({ mode: 'runtime' });
  assert.deepEqual(sourceBatchSizes, [10, 10, 3]);
  assert.deepEqual(graph.floorMemories.map(memory => memory.sourceFloorIds.length), [10, 10, 3]);
  assert.equal(graph.stateDeltas.length, 3);
  assert.equal(h.calls.length, 6);
  assert.equal(h.runtime.getState().stableCount, 23);
  assert.equal(h.runtime.getState().rememberedCount, 23);
  assert.equal(h.runtime.getState().floors.length, 3, '每批只显示一张范围记忆卡');
  const firstCard = h.runtime.getState().floors[0];
  const safeDiagnostic = h.runtime.copySafeDiagnostic(firstCard.floorId);
  assert.doesNotMatch(safeDiagnostic, /高楼正文/u);
  assert.doesNotMatch(safeDiagnostic, /sourceFloorSnapshots/u);
  assert.match(h.runtime.copyFullDiagnostic(firstCard.floorId), /高楼正文 1/u);
  assert.deepEqual(firstCard.memory.exactAnchors.map(anchor => anchor.sourceFloorId), firstCard.sourceFloorIds.slice(0, 2));
  const recallSource = await readRecallSource({ store: h.store, now: () => new Date(NOW) });
  assert.deepEqual(recallSource.floorMemories.map(memory => memory.sourceAssistantSeqs.length), [10, 10, 3]);
  const visibleMemberFloorId = recallSource.floorMemories[0].sourceFloorIds[3];
  const context = historySelectionContext({ ...recallSource, bodyMatch: { visibleFloorIds: [visibleMemberFloorId], coveredFloorIds: [] } },
    { text: '压缩', latestUserText: '压缩', recentAssistantText: '', previousUserText: '', messageCount: 1 });
  assert.equal([...context.oldMemories, ...context.recentWindow].some(memory => memory.floorId === recallSource.floorMemories[0].floorId), false,
    '正文覆盖范围内任一成员时整份压缩记忆都不得重复召回');
  const oldMemoryId = firstCard.memoryId;
  await h.runtime.extractFloor(firstCard.floorId);
  const reextracted = h.runtime.getState().floors.find(floor => floor.floorId === firstCard.floorId);
  assert.notEqual(reextracted.memoryId, oldMemoryId);
  assert.deepEqual(reextracted.sourceFloorIds, firstCard.sourceFloorIds);
  assert.deepEqual(sourceBatchSizes, [10, 10, 3, 10], '范围卡重新提取必须继续发送完整十楼而不是只取锚点楼');
  assert.equal(h.calls.length, 7, '范围重提沿用普通合同，不自动重算已有 CSE');
});

test('聚合旧摘要在清洗范围变化但原文未变时刷新恢复并给全部成员挂标', async () => {
  let keepTags = 'content,statusblock';
  let recovery = false;
  const anchorBatches = [];
  const seed = harness({
    modernAnchors: true,
    sanitizerOptions: () => ({ keepTags, extraTags: 'think' }),
    initialChat: Array.from({ length: 10 }, (_, index) => [
      assistant(`<content>旧楼正文 ${index + 1}</content><statusblock>旧状态 ${index + 1}</statusblock>`),
      { ...user(`确认 ${index + 1}`), send_date: `sanitizer-drift-${index + 1}` },
    ]).flat(),
    persistAnchors: async () => {},
    utility: options => JSON.parse(options.taskMessages[0].content).task === 'extractFloorSemantics'
      ? { jsonData: { summary: '十楼聚合摘要' } }
      : { jsonData: { noMaterialChange: true } },
  });
  await seed.runtime.start();
  await seed.runtime.startHistoricalRebuild({ aggregate: true });
  await waitFor(() => registeredGraphCaughtUp(seed.runtime.getState()) && !seed.runtime.getState().memoryWorkBusy);
  const before = await seed.store.readReachable({ mode: 'runtime' });
  assert.deepEqual(before.floorMemories.map(memory => memory.sourceFloorIds.length), [10]);
  assert.equal(seed.context.chat.filter(message => message.extra?.qianqianjie_floor).length, 0,
    '旧版事故夹具必须保留聚合成员均未挂标的状态');

  keepTags = 'content';
  const cold = harness({
    modernAnchors: true,
    readOnlyLifecycle: true,
    sharedBackend: seed.backend,
    sharedContext: seed.context,
    sanitizerOptions: () => ({ keepTags, extraTags: 'think' }),
    persistAnchors: async ({ chatId, bindings }) => {
      if (!recovery) return;
      anchorBatches.push(structuredClone(bindings));
      for (const binding of bindings) {
        const message = seed.context.chat[binding.messageIndex];
        message.extra = { ...(message.extra ?? {}), qianqianjie_floor: { schemaVersion: 1, chatId, floorId: binding.floorId } };
      }
    },
  });
  recovery = true;
  const rootBefore = structuredClone(seed.backend.records.get(`chat-${CHAT}/v3-root`));
  await cold.runtime.start();
  await waitFor(() => cold.runtime.getState().memorySyncStatus === 'idle');

  assert.equal(cold.foundationRuntime.getState().status, 'ready');
  assert.equal(cold.runtime.getState().memorySnapshotStatus, 'ready');
  assert.equal(cold.runtime.getState().memoryWorkBusy, false);
  assert.equal(cold.calls.length, 0, '恢复对应与挂标不得重新调用摘要或 CSE');
  assert.deepEqual(seed.backend.records.get(`chat-${CHAT}/v3-root`), rootBefore, '刷新恢复不得重写记忆图');
  assert.deepEqual(anchorBatches.map(bindings => bindings.length), [10]);
  assert.deepEqual(new Set(anchorBatches[0].map(binding => binding.floorId)), new Set(before.floorMemories[0].sourceFloorIds));
  assert.equal(seed.context.chat.filter(message => message.extra?.qianqianjie_floor).length, 10);
});

test('历史同版本循环复用已同步图，每份新摘要仍各执行一次必要后处理', async () => {
  let anchorSyncs = 0;
  const h = harness({
    modernAnchors: true,
    persistAnchors: async () => { anchorSyncs += 1; },
    initialChat: Array.from({ length: 20 }, (_, index) => [assistant(`复用读取 ${index + 1}`), { ...user(`确认 ${index + 1}`), send_date: `reuse-read-${index + 1}` }]).flat(),
    automation: { enabled: false, batchSize: 1 },
    utility: options => JSON.parse(options.taskMessages[0].content).task === 'extractFloorSemantics'
      ? { jsonData: { summary: '同版本批摘要' } }
      : { jsonData: { noMaterialChange: true } },
  });
  await h.runtime.start();
  const anchorsAfterStart = anchorSyncs;
  const fullReadsAfterStart = h.readReachableModes.length;
  await h.runtime.startHistoricalRebuild({ aggregate: true });
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()) && !h.runtime.getState().memoryWorkBusy);
  assert.equal(anchorSyncs - anchorsAfterStart, 2,
    '两份摘要提交各同步一次挂标，循环顶部和下一批准备不得重复执行相同版本后处理');
  assert.deepEqual(h.readReachableModes.slice(fullReadsAfterStart), ['runtime'],
    '两批历史只允许基线初始化所需的一次 runtime 整图读，循环与下一批准备不得重复读取');
  assert.equal(h.calls.length, 4);
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 2);
});

test('同版本但挂标同步未恢复时拒绝快路，完整同步成功后才发送下一摘要', async () => {
  let anchorSyncs = 0;
  const h = harness({
    modernAnchors: true,
    persistAnchors: async () => {
      anchorSyncs += 1;
      if (anchorSyncs === 1) throw Object.assign(new Error('模拟挂标失败'), { code: 'V3_MESSAGE_ANCHOR_SAVE_FAILED' });
    },
    initialChat: [assistant('同步失败首楼'), user('确认首楼'), assistant('同步恢复次楼'), user('确认次楼')],
    automation: { enabled: false, batchSize: 1 },
    utility: options => {
      if (JSON.parse(options.taskMessages[0].content).task === 'extractFloorSemantics') {
        if (h.calls.length > 1) assert.ok(anchorSyncs >= 2, '下一摘要发出前必须先重试同版本失败的同步');
        return { jsonData: { summary: '同步健康后摘要' } };
      }
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await h.runtime.start();
  const first = h.runtime.getState().floors[0];
  await h.runtime.extractFloor(first.floorId, { analyzeState: false });
  assert.equal(h.runtime.getState().lastExtractorError?.phase, 'anchor');
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()) && !h.runtime.getState().memoryWorkBusy);
  assert.ok(anchorSyncs >= 3, '失败后的完整同步与新摘要提交应分别执行挂标后处理');
  assert.notEqual(h.runtime.getState().lastExtractorError?.phase, 'anchor');
});

test('旧单楼 CSE 悬挂时高楼摘要仍连续保存，较早 CSE 不读取未来批次', async () => {
  let cseCalls = 0;
  let cseInFlight = 0;
  let maxCseInFlight = 0;
  let oldCseStartedResolve;
  let releaseOldCse;
  let oldCseReleased = false;
  const oldCseStarted = new Promise(resolve => { oldCseStartedResolve = resolve; });
  const sourceBatchSizes = [];
  const cseRequests = [];
  const h = harness({
    modernAnchors: true,
    initialChat: Array.from({ length: 22 }, (_, index) => [assistant(`流水正文 ${index + 1}`), { ...user(`确认 ${index + 1}`), send_date: `pipeline-${index + 1}` }]).flat(),
    automation: { enabled: false, batchSize: 1 },
    utility: async options => {
      const request = JSON.parse(options.taskMessages[0].content);
      if (request.task === 'extractFloorSemantics') {
        const sourceBatchSize = request.payload.sourceFloors?.length ?? 1;
        sourceBatchSizes.push(sourceBatchSize);
        if (sourceBatchSize > 1) {
          assert.equal(oldCseReleased, false, '两个新摘要请求都应在旧 CSE 返回前发出');
          return { jsonData: { summary: sourceBatchSizes.filter(size => size > 1).length === 1 ? '并行第一批摘要' : '并行第二批摘要' } };
        }
        return { jsonData: { summary: `旧单楼摘要 ${sourceBatchSizes.length}` } };
      }
      cseCalls += 1;
      cseInFlight += 1;
      maxCseInFlight = Math.max(maxCseInFlight, cseInFlight);
      cseRequests.push(structuredClone(request));
      if (cseCalls === 2) {
        oldCseStartedResolve();
        const response = await new Promise(resolve => {
          releaseOldCse = () => {
            oldCseReleased = true;
            resolve({ jsonData: { noMaterialChange: true } });
          };
        });
        cseInFlight -= 1;
        return response;
      }
      cseInFlight -= 1;
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await h.runtime.start();
  const first = h.runtime.getState().floors.find(floor => floor.assistantSeq === 1);
  await h.runtime.extractFloor(first.floorId);
  const second = h.runtime.getState().floors.find(floor => floor.assistantSeq === 2);
  await h.runtime.extractFloor(second.floorId, { analyzeState: false });
  const pending = h.runtime.startHistoricalRebuild({ aggregate: true });
  await oldCseStarted;
  await waitFor(() => sourceBatchSizes.filter(size => size > 1).length === 2
    && h.runtime.getState().rememberedCount === 22, () => JSON.stringify(h.runtime.getState()));
  assert.equal(oldCseReleased, false);
  assert.deepEqual(sourceBatchSizes, [1, 1, 10, 10]);
  assert.deepEqual([cseCalls, maxCseInFlight], [2, 1], '旧 CSE 悬挂期间不得启动第二路 CSE');
  const whileHeld = await h.store.readReachable({ mode: 'runtime' });
  assert.deepEqual([whileHeld.floorMemories.length, whileHeld.stateDeltas.length], [4, 1], '两份新摘要应先于旧 CSE 完成落盘');
  releaseOldCse();
  await pending;
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()));
  const graph = await h.store.readReachable({ mode: 'runtime' });
  assert.deepEqual([graph.floorMemories.length, graph.stateDeltas.length, cseCalls, maxCseInFlight], [4, 4, 4, 1]);
  const cseCanonicalContents = cseRequests.map(request => request.payload.canonicalContent);
  assert.match(cseCanonicalContents[0], /流水正文 1/u);
  assert.match(cseCanonicalContents[1], /流水正文 2/u);
  assert.doesNotMatch(JSON.stringify(cseRequests[1]), /并行第一批摘要|并行第二批摘要|流水正文 3|流水正文 13/u,
    '旧单楼 CSE 不得看到并发落盘的未来摘要或正文');
  assert.match(cseCanonicalContents[2], /流水正文 3/u);
  assert.doesNotMatch(JSON.stringify(cseRequests[2]), /并行第二批摘要|流水正文 13/u,
    '第一压缩批 CSE 不得看到已经保存的第二压缩批材料');
  assert.match(cseCanonicalContents[3], /流水正文 13/u);
  assert.ok(graph.floorMemories.some(memory => memory.summary?.aiText === '并行第一批摘要'));
  assert.ok(graph.floorMemories.some(memory => memory.summary?.aiText === '并行第二批摘要'));
});

test('普通历史 CSE 在途失败时合并新摘要唤醒额度，仍从原楼单路按序接续', async () => {
  let releaseDebt;
  let debtStartedResolve;
  let holdDebt = true;
  let cseInFlight = 0;
  let maxCseInFlight = 0;
  const debtStarted = new Promise(resolve => { debtStartedResolve = resolve; });
  const cseContents = [];
  const h = harness({
    initialChat: [user('开始'), assistant('基线楼'), assistant('欠账楼'), assistant('新摘要甲'), assistant('新摘要乙'), assistant('待确认尾楼')],
    automation: { enabled: false, batchSize: 1 },
    utility: async options => {
      const request = JSON.parse(options.taskMessages[0].content);
      if (request.task === 'extractFloorSemantics') return { jsonData: { summary: `摘要-${request.payload.canonicalContent}` } };
      cseContents.push(request.payload.canonicalContent);
      cseInFlight += 1;
      maxCseInFlight = Math.max(maxCseInFlight, cseInFlight);
      if (request.payload.canonicalContent === '欠账楼' && holdDebt) {
        holdDebt = false;
        debtStartedResolve();
        await new Promise(resolve => { releaseDebt = resolve; });
        cseInFlight -= 1;
        throw new Error('模拟在途欠账 CSE 失败');
      }
      cseInFlight -= 1;
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await h.runtime.start();
  const [baselineFloor, debtFloor] = h.runtime.getState().floors;
  await h.runtime.extractFloor(baselineFloor.floorId);
  await h.runtime.extractFloor(debtFloor.floorId, { analyzeState: false });
  const rebuilding = h.runtime.startHistoricalRebuild();
  await debtStarted;
  await waitFor(() => h.runtime.getState().rememberedCount === 4,
    () => JSON.stringify(h.runtime.getState().floors.map(floor => ({ seq: floor.assistantSeq, status: floor.status }))));
  assert.equal(cseInFlight, 1);
  releaseDebt();
  await rebuilding;
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()) && !h.runtime.getState().memoryWorkBusy);
  assert.deepEqual(cseContents, ['基线楼', '欠账楼', '欠账楼', '新摘要甲', '新摘要乙'],
    '失败后必须先重试原欠账楼，成功后才能处理后楼');
  assert.equal(maxCseInFlight, 1, '摘要提交期间也只能有一条 CSE 请求在途');
});

test('CSE 前置读取在途报错不吞掉同期新摘要额度，并从同一欠账楼恢复', async () => {
  let enableArm = false;
  let refreshCalls = 0;
  let holdRootRead = false;
  let held = false;
  let releaseRead;
  let readStartedResolve;
  let readFailures = 0;
  const readStarted = new Promise(resolve => { readStartedResolve = resolve; });
  const cseContents = [];
  const h = harness({
    initialChat: [user('开始'), assistant('同步基线'), assistant('同步欠账'), assistant('同步新甲'), assistant('同步新乙'), assistant('待确认尾楼')],
    automation: { enabled: false, batchSize: 1 },
    foundationRefresh: async base => {
      const state = await base.refreshStatus();
      if (enableArm && ++refreshCalls === 2) holdRootRead = true;
      return state;
    },
    utility: options => {
      const request = JSON.parse(options.taskMessages[0].content);
      if (request.task === 'extractFloorSemantics') return { jsonData: { summary: `摘要-${request.payload.canonicalContent}` } };
      cseContents.push(request.payload.canonicalContent);
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await h.runtime.start();
  const [baselineFloor, debtFloor] = h.runtime.getState().floors;
  await h.runtime.extractFloor(baselineFloor.floorId);
  await h.runtime.extractFloor(debtFloor.floorId, { analyzeState: false });
  h.backend.setBeforeGet(async ({ key }) => {
    if (!holdRootRead || held || key !== 'v3-root') return;
    held = true;
    readStartedResolve();
    await new Promise(resolve => { releaseRead = resolve; });
    readFailures += 1;
    throw Object.assign(new Error('模拟在途人物状态读取失败'), { code: 'BACKEND_TIMEOUT' });
  });
  enableArm = true;
  refreshCalls = 0;
  const rebuilding = h.runtime.startHistoricalRebuild();
  await readStarted;
  await waitFor(() => h.runtime.getState().rememberedCount === 4);
  releaseRead();
  await rebuilding;
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()) && !h.runtime.getState().memoryWorkBusy);
  assert.equal(readFailures, 1);
  assert.deepEqual(cseContents, ['同步基线', '同步欠账', '同步新甲', '同步新乙'],
    '前置读取失败本身不发模型请求，恢复后仍从原欠账楼开始且不重复成功楼');
  assert.equal(h.runtime.getState().memorySyncError, null);
});

test('删除压缩批内成员会回退到该批之前，丢弃本批与后续压缩摘要及依赖 CSE', async () => {
  const h = harness({
    modernAnchors: true,
    initialChat: Array.from({ length: 12 }, (_, index) => [assistant(`删楼范围 ${index + 1}`), { ...user(`确认 ${index + 1}`), send_date: `delete-range-${index + 1}` }]).flat(),
    automation: { enabled: false, batchSize: 1 },
    utility: options => JSON.parse(options.taskMessages[0].content).task === 'extractFloorSemantics'
      ? { jsonData: { summary: '范围摘要' } }
      : { jsonData: { noMaterialChange: true } },
  });
  h.context.chatMetadata.integrity = 'complete';
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild({ aggregate: true });
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()) && !h.runtime.getState().activeAutoMemory);
  const before = await h.store.readReachable({ mode: 'runtime' });
  assert.deepEqual([before.floorMemories.length, before.stateDeltas.length], [2, 2]);
  const removedFloorId = before.floorMemories[0].sourceFloorIds[4];
  const removed = before.floors.find(floor => floor.id === removedFloorId);
  h.context.chat.splice(removed.hostLocator.messageIndex, 1);
  await h.foundationRuntime.refreshStatus();
  await h.runtime.refreshStatus({ preferCached: false });
  const after = await h.store.readReachable({ mode: 'runtime' });
  assert.equal(after.floorMemories.some(memory => memory.id === before.floorMemories[0].id), false);
  assert.equal(after.floorMemories.some(memory => memory.id === before.floorMemories[1].id), false);
  assert.equal(after.floorMemories.length, 0);
  assert.equal(after.stateDeltas.length, 0, '被删批及其后的依赖人物状态必须一起回退');
});

test('删除压缩批成员会保留其后的普通单楼摘要，但清掉破损批起的全部 CSE', async () => {
  const h = harness({
    modernAnchors: true,
    initialChat: Array.from({ length: 11 }, (_, index) => [assistant(`聚合后单楼 ${index + 1}`), { ...user(`确认 ${index + 1}`), send_date: `aggregate-then-single-${index + 1}` }]).flat(),
    automation: { enabled: false, batchSize: 1 },
    utility: options => JSON.parse(options.taskMessages[0].content).task === 'extractFloorSemantics'
      ? { jsonData: { summary: '聚合后单楼摘要' } }
      : { jsonData: { noMaterialChange: true } },
  });
  h.context.chatMetadata.integrity = 'complete';
  await h.runtime.start();
  const finalFloor = h.runtime.getState().floors.find(floor => floor.assistantSeq === 11);
  await h.runtime.extractFloor(finalFloor.floorId);
  const finalMemoryId = h.runtime.getState().floors.find(floor => floor.floorId === finalFloor.floorId).memoryId;
  await h.runtime.startHistoricalRebuild({ aggregate: true });
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()) && !h.runtime.getState().activeAutoMemory);
  const before = await h.store.readReachable({ mode: 'runtime' });
  const aggregate = before.floorMemories.find(memory => memory.sourceFloorIds?.length === 10);
  assert.ok(aggregate);
  assert.equal(before.floorMemories.find(memory => memory.floorId === finalFloor.floorId)?.id, finalMemoryId);
  assert.deepEqual([before.floorMemories.length, before.stateDeltas.length], [2, 2]);
  const removed = before.floors.find(floor => floor.id === aggregate.sourceFloorIds[4]);
  h.context.chat.splice(removed.hostLocator.messageIndex, 1);
  await h.foundationRuntime.refreshStatus();
  await h.runtime.refreshStatus({ preferCached: false });
  const after = await h.store.readReachable({ mode: 'runtime' });
  assert.deepEqual(after.floorMemories.map(memory => memory.id), [finalMemoryId], '破损聚合后的普通单楼摘要必须保留');
  assert.equal(after.stateDeltas.length, 0, '从破损聚合起的全部 CSE 都必须清除，包括后续普通单楼 CSE');
});

test('高楼压缩首批 CSE 失败后由下一份摘要唤醒同楼并自动按序追平', async () => {
  let failCse = true;
  let extractorCalls = 0, cseCalls = 0;
  const h = harness({
    modernAnchors: true,
    initialChat: Array.from({ length: 20 }, (_, index) => [assistant(`续补范围 ${index + 1}`), { ...user(`确认 ${index + 1}`), send_date: `resume-range-${index + 1}` }]).flat(),
    automation: { enabled: false, batchSize: 1 },
    utility: options => {
      const task = JSON.parse(options.taskMessages[0].content).task;
      if (task === 'extractFloorSemantics') { extractorCalls += 1; return { jsonData: { summary: '已保存的范围摘要' } }; }
      cseCalls += 1;
      if (failCse) { failCse = false; throw new Error('模拟批末 CSE 失败'); }
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild({ aggregate: true });
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()));
  assert.deepEqual([h.runtime.getState().rememberedCount, extractorCalls, cseCalls], [20, 2, 3],
    '每份压缩摘要只提供一次机会，第二批提交应先重试第一批再处理第二批');
  assert.equal((await h.store.readReachable({ mode: 'runtime' })).stateDeltas.length, 2);
  await h.runtime.refreshStatus();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(cseCalls, 3, '同一摘要版本的刷新和通知不得制造额外重试');
});

test('高楼压缩摘要失败时整批不产生部分记忆并立即暂停', async () => {
  const h = harness({
    modernAnchors: true,
    initialChat: Array.from({ length: 10 }, (_, index) => [assistant(`失败范围 ${index + 1}`), { ...user(`确认 ${index + 1}`), send_date: `failed-range-${index + 1}` }]).flat(),
    automation: { enabled: false, batchSize: 1 },
    utility: options => {
      if (JSON.parse(options.taskMessages[0].content).task === 'extractFloorSemantics') throw new Error('模拟整批摘要失败');
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild({ aggregate: true });
  const graph = await h.store.readReachable({ mode: 'runtime' });
  assert.equal(h.runtime.getState().rebuildStatus, 'failed');
  assert.deepEqual([graph.floorMemories.length, graph.stateDeltas.length], [0, 0]);
  assert.equal(h.runtime.shouldBlockMainGeneration(), false);
  assert.equal(h.calls.length, 1);
});

test('压缩范围重提在途时编辑非末楼成员会拒绝迟到结果', async () => {
  let holdReextract = false, release, startedResolve, signal;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const h = harness({
    modernAnchors: true,
    initialChat: Array.from({ length: 10 }, (_, index) => [assistant(`守卫范围 ${index + 1}`), { ...user(`确认 ${index + 1}`), send_date: `guard-range-${index + 1}` }]).flat(),
    automation: { enabled: false, batchSize: 1 },
    utility: options => {
      const task = JSON.parse(options.taskMessages[0].content).task;
      if (task !== 'extractFloorSemantics') return { jsonData: { noMaterialChange: true } };
      if (!holdReextract) return { jsonData: { summary: '原范围摘要' } };
      signal = options.signal; startedResolve();
      return new Promise(resolve => { release = () => resolve({ jsonData: { summary: '不得写入的迟到范围摘要' } }); });
    },
  });
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild({ aggregate: true });
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()));
  const range = h.runtime.getState().floors[0];
  holdReextract = true;
  const pending = h.runtime.extractFloor(range.floorId);
  await started;
  const editedMessageIndex = range.sourceMessageIndexes[2];
  h.context.chat[editedMessageIndex] = assistant('批内非末楼已经编辑');
  h.emit('MESSAGE_EDITED', editedMessageIndex);
  await waitFor(() => signal?.aborted === true, '非末楼成员编辑必须取消整批在途重提');
  release();
  await pending;
  const graph = await h.store.readReachable({ mode: 'runtime' });
  assert.equal(graph.floorMemories.some(memory => memory.summary?.aiText === '不得写入的迟到范围摘要'), false);
});

test('已有单楼会截断高楼压缩分组，混合档续跑不覆盖也不重复调用', async () => {
  const sourceBatchSizes = [];
  const h = harness({
    modernAnchors: true,
    initialChat: Array.from({ length: 15 }, (_, index) => [assistant(`混合范围 ${index + 1}`), { ...user(`确认 ${index + 1}`), send_date: `mixed-range-${index + 1}` }]).flat(),
    automation: { enabled: false, batchSize: 1 },
    utility: options => {
      const request = JSON.parse(options.taskMessages[0].content);
      if (request.task === 'extractFloorSemantics') {
        sourceBatchSizes.push(request.payload.sourceFloors?.length ?? 1);
        return { jsonData: { summary: `混合摘要 ${sourceBatchSizes.length}` } };
      }
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await h.runtime.start();
  const standalone = h.runtime.getState().floors.find(floor => floor.assistantSeq === 6);
  await h.runtime.extractFloor(standalone.floorId, { analyzeState: false });
  const standaloneMemoryId = h.runtime.getState().floors.find(floor => floor.floorId === standalone.floorId).memoryId;
  await h.runtime.startHistoricalRebuild({ aggregate: true });
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()));
  const graph = await h.store.readReachable({ mode: 'runtime' });
  assert.deepEqual(sourceBatchSizes, [1, 5, 9]);
  assert.deepEqual(graph.floorMemories.map(memory => memory.sourceFloorIds?.length ?? 1), [5, 1, 9]);
  assert.equal(graph.floorMemories.find(memory => memory.floorId === standalone.floorId)?.id, standaloneMemoryId);
  const calls = h.calls.length;
  await h.runtime.startHistoricalRebuild({ aggregate: true });
  assert.equal(h.calls.length, calls, '已覆盖的混合档再次继续不得重复摘要或 CSE');
});

test('完整聊天删除已摘要中间楼时，前后楼唯一绑定后允许移除旧楼', async () => {
  const h = harness({ initialChat: [assistant('A'), assistant('B'), assistant('C'), user('稳定锚')] });
  h.context.chatMetadata.integrity = 'complete';
  await h.runtime.start();
  const before = h.runtime.getState().floors;
  const removed = before[1];
  await h.runtime.extractFloor(removed.floorId, { analyzeState: false });
  assert.equal(h.foundationRuntime.getReachable().floorMemories.some(memory => memory.floorId === removed.floorId), true);

  h.context.chat.splice(1, 1);
  const foundationState = await h.foundationRuntime.refreshStatus();
  assert.equal(foundationState.status, 'ready');
  assert.deepEqual(h.foundationRuntime.getReachable().floors.map(floor => floor.id), [before[0].floorId, before[2].floorId]);
  assert.equal(h.foundationRuntime.getReachable().floorMemories.some(memory => memory.floorId === removed.floorId), false);
});

function completeTailSwipe(h, text) {
  const messageIndex = h.context.chat.length - 1;
  const previous = h.context.chat[messageIndex]?.mes ?? '';
  h.context.chat[messageIndex] = { ...assistant(''), swipes: [previous, ''], swipe_id: 1 };
  h.emit('MESSAGE_SWIPED', messageIndex, { pendingGeneration: true, previousSwipeId: 0, nextSwipeId: 1 });
  h.emit('GENERATION_STARTED', 'swipe', {}, false);
  h.context.chat[messageIndex].swipes[1] = text;
  h.context.chat[messageIndex].mes = text;
  h.emit('GENERATION_ENDED');
  h.emit('MESSAGE_RECEIVED', messageIndex, 'swipe');
}

async function seedContinuousSummaryTail(debtCount) {
  const seed = harness({
    initialChat: [user('开始'), assistant('已完成前缀'), assistant('尾部欠账 1')],
    automation: { enabled: false, batchSize: 1 },
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: `摘要-${JSON.parse(options.taskMessages[0].content).payload.canonicalContent}` } }
      : { jsonData: { noMaterialChange: true } },
  });
  await seed.runtime.start();
  await seed.runtime.startHistoricalRebuild();
  await waitFor(() => ['caughtUp', 'waitingRealtime'].includes(seed.runtime.getState().rebuildStatus));
  for (let index = 2; index <= debtCount; index += 1) seed.context.chat.push(assistant(`尾部欠账 ${index}`));
  seed.context.chat.push(assistant('未稳定尾楼'));
  await seed.foundationRuntime.refreshStatus();
  await seed.runtime.refreshStatus();
  await waitFor(() => seed.runtime.getState().memorySyncStatus !== 'syncing', '新增稳定楼的后台覆盖检查未完成');
  assert.equal(seed.runtime.getState().summaryCompletedCount, 1);
  assert.equal(seed.runtime.getState().stableCount, debtCount + 1);
  seed.calls.splice(0);
  return seed;
}

async function seedMiddleSummaryGap() {
  const seed = await seedContinuousSummaryTail(2);
  const firstFloorId = seed.runtime.getState().floors[0].floorId;
  const lastFloorId = seed.runtime.getState().floors.at(-1).floorId;
  await seed.runtime.extractFloor(lastFloorId, { analyzeState: false });
  await seed.runtime.editSummary(firstFloorId, '修订前缀摘要以形成最早 CSE 待办');
  assert.equal(seed.runtime.getState().summaryCompletedCount, 2);
  assert.equal(seed.runtime.getState().rememberedCount, 2);
  seed.calls.splice(0);
  return seed;
}

async function direct(response, { content = '裴晚生提醒你带伞。', entities = [], userIdentity = { displayName: '林岚', aliases: ['林岚', '你', '{{user}}'] }, batchId = '33333333-3333-4333-8333-333333333333', preservedSummary = null, sourceUserInputSnapshot = null, storyClock = null } = {}) {
  const floor = { id: '11111111-1111-4111-8111-111111111111', chatId: CHAT, narrativeGeneration: GENERATION, assistantSeq: 1, content: { canonicalContent: content } };
  const envelope = await createExtractorEnvelope({ batchId, chatId: CHAT, narrativeGeneration: GENERATION, checkpointId: null, floor, entities, userIdentity, sourceUserInputSnapshot, storyClock });
  return normalizeExtractorResponse({ response, envelope, floor, existingEntities: entities, now: NOW, preservedSummary, expectedScope: envelope.scope });
}

test('新 user 实体在同批次保持确定，不同提取批次使用不同 ID', async () => {
  const response = { summary: '用户接过雨伞。', people: [{ name: '你', role: 'user' }] };
  const first = await direct(response, { batchId: '33333333-3333-4333-8333-333333333333' });
  const sameBatch = await direct(response, { batchId: '33333333-3333-4333-8333-333333333333' });
  const retry = await direct(response, { batchId: '44444444-4444-4444-8444-444444444444' });
  const firstUser = first.newEntities.find(item => item.specialRole === 'user');
  const sameBatchUser = sameBatch.newEntities.find(item => item.specialRole === 'user');
  const retryUser = retry.newEntities.find(item => item.specialRole === 'user');
  assert.ok(firstUser && sameBatchUser && retryUser);
  assert.equal(firstUser.id, sameBatchUser.id);
  assert.notEqual(firstUser.id, retryUser.id);
});

test('HostAdapter 优先 official 并为 official/Luker 提供同一宿主 user identity', () => {
  const official = { name1: '林岚', personaId: 'p-1', chat: [] };
  let fallbackReads = 0;
  const adapter = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => official }, Luker: { getContext: () => { fallbackReads += 1; return { name1: '错误' }; } } } });
  assert.deepEqual(adapter.getUserIdentity(), { displayName: '林岚', aliases: ['林岚', '你', '{{user}}'], personaIdentifier: 'p-1', source: 'SillyTavern' });
  assert.equal(fallbackReads, 0);
  const luker = createHostAdapter({ globalRef: { Luker: { getContext: () => ({ name1: '阿满', userAvatar: 'avatar.png', chat: [] }) } } });
  assert.equal(luker.snapshot().userIdentity.displayName, '阿满');
  assert.equal(luker.snapshot().userIdentity.source, 'Luker');
});

test('楼变量只读复制严格绑定目标消息当前 swipe，不读取最新楼或其他 swipe', () => {
  let forbiddenCalls = 0, slotWrites = 0;
  const selectedVariables = { stat_data: { hp: 7 }, ejsSaved: { mood: '戒备' } };
  for (const name of ['prepareContext', 'evalTemplate', 'allVariables', 'saveVariables']) {
    Object.defineProperty(selectedVariables, name, { enumerable: false, value() { forbiddenCalls += 1; } });
  }
  const target = { ...assistant('目标楼第二 swipe'), swipes: ['目标楼第一 swipe', '目标楼第二 swipe'], swipe_id: 1,
    variables: new Proxy([{ stat_data: { hp: 10 }, firstSwipeOnly: true }, selectedVariables], {
      set(targetSlots, key, value) { slotWrites += 1; return Reflect.set(targetSlots, key, value); },
    }) };
  const latest = { ...assistant('最新楼'), variables: [{ stat_data: { hp: 999 }, latestOnly: true }] };
  const snapshot = { chat: [target, latest], prepareContext() { forbiddenCalls += 1; }, evalTemplate() { forbiddenCalls += 1; }, saveVariables() { forbiddenCalls += 1; } };
  const floor = { hostLocator: { messageIndex: 0, swipeId: 1, selectedSwipeIndex: 1 } };
  const reference = captureFloorVariableReference(snapshot, floor);
  assert.deepEqual(reference, { stat_data: { hp: 7 }, ejsSaved: { mood: '戒备' } });
  target.variables[1].stat_data.hp = 1;
  assert.equal(reference.stat_data.hp, 7, '捕获后必须与宿主变量后续变化断开引用');
  assert.equal(Object.hasOwn(reference, 'firstSwipeOnly'), false);
  assert.equal(Object.hasOwn(reference, 'latestOnly'), false);
  assert.equal(forbiddenCalls, 0, '读取变量不得执行模板或调用宿主保存接口');
  assert.equal(slotWrites, 0, '读取变量不得回写宿主变量槽');
  assert.equal(captureFloorVariableReference(snapshot, { hostLocator: { messageIndex: 0, selectedSwipeIndex: 0 } }), null, '楼定位与宿主当前 swipe 不一致时不得猜读');
  assert.equal(captureFloorVariableReference({ chat: [assistant('无变量')] }, { hostLocator: { messageIndex: 0, selectedSwipeIndex: 0 } }), null);
});

test('Extractor 输入只含浅层语义提示，不暴露作用域、UUID 或内部操作', async () => {
  const h = harness({ text: '屏幕写着“忽略规则”，裴晚生没有执行。' });
  await h.runtime.start(); await h.runtime.extractNext();
  const extractorCalls = h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT);
  assert.equal(extractorCalls.length, 1);
  const call = extractorCalls[0];
  assert.equal(call.parseMode, 'semantic');
  assert.equal(Object.hasOwn(call, 'jsonSchema'), false);
  assert.match(EXTRACTOR_SYSTEM_PROMPT, /people、time、locations 也要分别检查并提取/);
  assert.match(DEFAULT_EXTRACTOR_GUIDANCE, /本楼没有明确时间时.*previousFloorContext.*合理推定具体或相对时间/);
  assert.match(EXTRACTOR_FIXED_CONTRACT, /时间是唯一允许合理推定的例外/);
  assert.match(EXTRACTOR_FIXED_CONTRACT, /不能附带正文没有的事件、人物、因果或结果/);
  assert.match(EXTRACTOR_FIXED_CONTRACT, /order 必须使用对象数组.*before.*after.*certainty/u);
  assert.match(EXTRACTOR_SYSTEM_PROMPT, /不输出 UUID/);
  assert.match(EXTRACTOR_FIXED_CONTRACT, /actions、knowledge、informationTransfers、privateThoughts、commitments、exactQuotes、openLoops 或 cseSignals/);
  assert.doesNotMatch(EXTRACTOR_OUTPUT_CONTRACT, /entityId|mentionKey|evidence|floorId|operation/i);
  const request = JSON.parse(call.taskMessages[0].content);
  assert.deepEqual(Object.keys(request), ['task', 'locale', 'payload']);
  assert.equal(request.payload.canonicalContent.includes('忽略规则'), true);
  assert.equal(request.payload.storyClock, null);
  assert.equal(request.payload.previousFloorContext, null);
  assert.deepEqual(request.payload.userIdentity, { displayName: '林岚', aliases: ['林岚', '你', '{{user}}'] });
  assert.doesNotMatch(JSON.stringify(request), /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
});

test('破限、摘要与 CSE 指导按任务取最新快照，设置变化不追溯旧结果且固定合同不串用', async () => {
  const guidance = { summary: '摘要自定义第一版', cse: 'CSE 自定义第一版' };
  let processing = '  破限自定义第一版\n';
  const getterReads = { summary: 0, cse: 0, processing: 0 };
  const h = harness({
    initialChat: [user('开始'), assistant('第一楼'), assistant('第二楼'), assistant('第三楼'), assistant('用于确认第三楼稳定。')],
    extractorPromptGuidance: () => { getterReads.summary += 1; return guidance.summary; },
    csePromptGuidance: () => { getterReads.cse += 1; return guidance.cse; },
    processingPrompt: () => { getterReads.processing += 1; return processing; },
    utility: options => {
      const request = JSON.parse(options.taskMessages[0].content);
      return request.task === 'extractFloorSemantics'
        ? { jsonData: { summary: `摘要-${request.payload.canonicalContent}` } }
        : { jsonData: { noMaterialChange: true } };
    },
  });
  await h.runtime.start();
  await h.runtime.extractNext();
  const firstMemoryId = h.runtime.getState().floors[0].memoryId;
  const firstDeltaId = h.runtime.getState().cseFloors[0].deltaId;
  assert.equal(h.runtime.getState().cseFloors[0].status, 'noChange');
  const callsAfterFirst = h.calls.length;
  processing = ' \n\t ';
  await h.runtime.refreshStatus();
  assert.equal(h.runtime.getState().floors[0].memoryId, firstMemoryId, '改破限设置不得撤销已保存摘要/CSE');
  assert.deepEqual([h.runtime.getState().cseFloors[0].deltaId, h.runtime.getState().cseFloors[0].status], [firstDeltaId, 'noChange'], '改破限设置不得把已保存 CSE 标回待处理');
  assert.equal(h.calls.length, callsAfterFirst, '改破限设置后的普通刷新不得调用模型');
  guidance.summary = '摘要自定义第二版'; guidance.cse = 'CSE 自定义第二版';
  await h.runtime.extractNext();
  guidance.summary = ''; guidance.cse = ''; processing = '破限自定义第三版';
  await h.runtime.extractNext();

  const summaryCalls = h.calls.filter(call => call.taskMessages[0].content.includes('extractFloorSemantics'));
  const cseCalls = h.calls.filter(call => call.taskMessages[0].content.includes('understandCharacterStateAfterFloor'));
  assert.deepEqual(summaryCalls.map(call => call.systemPrompt), [buildExtractorSystemPrompt('摘要自定义第一版', '  破限自定义第一版\n'), buildExtractorSystemPrompt('摘要自定义第二版', ' \n\t '), buildExtractorSystemPrompt('', '破限自定义第三版')]);
  assert.deepEqual(cseCalls.map(call => call.systemPrompt), [buildCseSystemPrompt('CSE 自定义第一版', '  破限自定义第一版\n'), buildCseSystemPrompt('CSE 自定义第二版', ' \n\t '), buildCseSystemPrompt('', '破限自定义第三版')]);
  assert.equal(getterReads.summary, 3); assert.equal(getterReads.cse, 3); assert.equal(getterReads.processing, 6);
  assert.doesNotMatch(summaryCalls[0].systemPrompt, new RegExp(DEFAULT_EXTRACTOR_GUIDANCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(cseCalls[0].systemPrompt, new RegExp(DEFAULT_CSE_GUIDANCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(summaryCalls[0].systemPrompt, /固定事实边界/); assert.ok(summaryCalls[0].systemPrompt.includes(EXTRACTOR_FIXED_CONTRACT));
  assert.match(cseCalls[0].systemPrompt, /固定事实与隐私边界/); assert.ok(cseCalls[0].systemPrompt.includes(CSE_FIXED_CONTRACT));
  assert.doesNotMatch(summaryCalls[0].systemPrompt, /CSE 自定义/); assert.doesNotMatch(cseCalls[0].systemPrompt, /摘要自定义/);
  for (const call of [summaryCalls[0], cseCalls[0]]) {
    assert.ok(call.systemPrompt.startsWith('  破限自定义第一版\n\n\n'), '自定义破限文本必须保留首尾空白并逐字置于系统提示开头');
    assert.equal(call.systemPrompt.split('破限自定义第一版').length - 1, 1);
    assert.equal(call.systemPrompt.includes(BASE_PROCESSING_PROMPT), false, '自定义破限文本必须替换内置默认');
  }
  for (const call of [summaryCalls[1], cseCalls[1]]) assert.equal(call.systemPrompt.split(BASE_PROCESSING_PROMPT).length - 1, 1, '纯空白应回退到内置默认且只出现一次');
  for (const call of [summaryCalls[2], cseCalls[2]]) {
    assert.ok(call.systemPrompt.startsWith('破限自定义第三版\n\n'));
    assert.equal(call.systemPrompt.split('破限自定义第三版').length - 1, 1);
    assert.equal(call.systemPrompt.includes(BASE_PROCESSING_PROMPT), false);
  }
  for (const call of [...summaryCalls, ...cseCalls]) {
    assert.doesNotMatch(call.systemPrompt, /sanctuary_override_directive/, '机械任务不得携带创作链强化层');
    assert.equal(Object.hasOwn(JSON.parse(call.taskMessages[0].content), 'customGuidance'), false, '旧通用附加残留不得发送');
  }
});

test('仅 {summary} 时形成有效 FloorMemory，并明确记录时间未明确', async () => {
  const result = await direct({ summary: '裴晚生提醒用户带伞。' });
  assert.equal(result.memory.summary.aiText, '裴晚生提醒用户带伞。');
  assert.equal(result.memory.chronology[0].time.kind, 'unknown');
  assert.equal(result.memory.chronology[0].time.sourceText, '时间未明确');
  for (const key of ['locations', 'participants', 'actions', 'observations', 'informationTransfers', 'privateCognition', 'commitments', 'eventFragments', 'exactAnchors', 'openLoops', 'ambiguities', 'cseSignals']) assert.deepEqual(result.memory[key], [], key);
  assert.equal(result.needsReview, false);
});

test('模型生成语义中的精确 user 宏使用实际用户名，逐字内容、结构字段和手写摘要保持原样', async () => {
  const content = '地点牌写着“{{user}}的房间”。稍后，{{user}}对沈砚说：“{{user}}会回来。”普通 user 与用户字样仍在。';
  const result = await direct({
    summary: '{{user}}与{{user}}会面；普通 user 与用户字样仍在。',
    people: [{ name: '{{user}}', role: 'user' }, { name: '沈砚' }],
    time: [{ sourceText: '{{user}}之后', description: '{{user}}之后继续', kind: 'relative', precision: 'unresolved' }],
    locations: [{ name: '{{user}}的房间', people: ['{{user}}', '沈砚'] }],
    events: [{ title: '{{user}}会面', description: '{{user}}与沈砚会面。' }],
    actions: [{ actor: '{{user}}', targets: ['沈砚'], action: '{{user}}告诉沈砚安排', result: '{{user}}完成说明', quote: '{{user}}会回来。' }],
    knowledge: [{ subject: '{{user}}', description: '{{user}}知道普通 user 字样。' }],
    informationTransfers: [{ from: '{{user}}', to: ['沈砚'], claimText: '{{user}}会回来', channel: 'told' }],
    privateThoughts: [{ holder: '{{user}}', thought: '{{user}}仍在考虑。' }],
    commitments: [{ issuer: '{{user}}', recipient: '沈砚', content: '{{user}}答应回来', exactQuote: '{{user}}会回来。' }],
    exactQuotes: [{ exactText: '{{user}}会回来。', speaker: '{{user}}', whyPreserve: '{{user}}的关键承诺' }],
    openLoops: [{ description: '{{user}}何时返回仍未解决', owners: ['{{user}}'] }],
    cseSignals: [{ subject: '{{user}}', object: '沈砚', signalType: 'trust', description: '{{user}}向沈砚作出承诺' }],
  }, { content, preservedSummary: { userText: '手写 {{user}} 摘要', effectiveSource: 'user' } });

  assert.equal(result.memory.summary.aiText, '林岚与林岚会面；普通 user 与用户字样仍在。');
  assert.equal(result.memory.summary.userText, '手写 {{user}} 摘要');
  assert.equal(result.memory.summary.effectiveSource, 'user');
  assert.equal(result.memory.chronology[0].description, '林岚之后继续');
  assert.equal(result.memory.chronology[0].time.sourceText, '{{user}}之后');
  assert.equal(result.memory.locations[0].name, '{{user}}的房间');
  assert.equal(result.memory.eventFragments[0].title, '林岚会面');
  assert.equal(result.memory.eventFragments[0].description, '林岚与沈砚会面。');
  assert.equal(result.memory.actions[0].action, '林岚告诉沈砚安排');
  assert.equal(result.memory.actions[0].result, '林岚完成说明');
  assert.equal(result.memory.observations[0].description, '林岚知道普通 user 字样。');
  assert.equal(result.memory.informationTransfers[0].claimText, '林岚会回来');
  assert.equal(result.memory.privateCognition[0].content, '林岚仍在考虑。');
  assert.equal(result.memory.commitments[0].content, '林岚答应回来');
  assert.equal(result.memory.openLoops[0].description, '林岚何时返回仍未解决');
  assert.equal(result.memory.cseSignals[0].description, '林岚向沈砚作出承诺');
  assert.equal(result.memory.exactAnchors[0].whyPreserve, '林岚的关键承诺');
  assert.equal(result.memory.exactAnchors[0].exactText, '{{user}}会回来。');
  assert.equal(result.memory.actions[0].evidenceRefs[0].quotedText, '{{user}}会回来。');
  assert.equal(result.memory.commitments[0].exactAnchorId, result.memory.exactAnchors[0].anchorId);
  assert.equal(result.newEntities.find(entity => entity.specialRole === 'user')?.displayName, '林岚');
  assert.equal(content.includes('{{user}}'), true, 'canonicalContent 测试输入必须保持原样');
});

test('空 displayName 不猜用户名，严格响应只改生成说明而保留证据引文', async () => {
  const emptyIdentity = await direct({ summary: '{{user}}提醒普通 user 与用户。' }, { userIdentity: { displayName: '', aliases: ['{{user}}'] } });
  assert.equal(emptyIdentity.memory.summary.aiText, '{{user}}提醒普通 user 与用户。');

  const emptyArrays = Object.fromEntries(['entityMentions', 'chronology', 'locations', 'participants', 'actions', 'observations', 'informationTransfers', 'privateCognition', 'commitments', 'eventFragments', 'exactAnchors', 'openLoops', 'ambiguities', 'cseSignals'].map(key => [key, []]));
  const strict = await direct({
    schemaVersion: 3,
    task: 'extractFloorMemory',
    promptVersion: EXTRACTOR_PROMPT_VERSION,
    floors: [{
      status: 'ok',
      summary: '{{user}}看到歧义。',
      summaryEvidence: [{ quoteSegments: ['{{user}}'], supports: '{{user}}是叙述对象', evidenceMode: 'explicit', sourceMentionKey: null }],
      ...emptyArrays,
      ambiguities: [{ question: '{{user}}是否离开？', possibleReadings: ['{{user}}已经离开', '{{user}}仍在现场'], evidence: [] }],
    }],
  }, { content: '{{user}}看到歧义。' });
  assert.equal(strict.memory.summaryEvidenceRefs[0].supports, '林岚是叙述对象');
  assert.equal(strict.memory.summaryEvidenceRefs[0].quotedText, '{{user}}');
  assert.equal(strict.memory.ambiguities[0].question, '林岚是否离开？');
  assert.deepEqual(strict.memory.ambiguities[0].possibleReadings, ['林岚已经离开', '林岚仍在现场']);
});

test('extractor 固定合同要求语义使用 displayName，并明确保护逐字内容', () => {
  const customPrompt = buildExtractorSystemPrompt('只记录本楼事实。');
  const highFloorPrompt = buildHighFloorExtractorSystemPrompt('', '');
  assert.match(customPrompt, /payload\.userIdentity\.displayName/);
  assert.match(customPrompt, /\{\{user\}\} 只可作为 canonicalContent、precedingUserInput 或 aliases 中的输入别名/);
  assert.match(customPrompt, /exactQuotes\.exactText、承诺原话及证据引文必须逐字照抄相应来源/);
  assert.match(customPrompt, /此例的 payload\.userIdentity\.displayName 为“林岚”/);
  for (const prompt of [customPrompt, highFloorPrompt]) {
    assert.match(prompt, /summary、time，以及 qianshi 的 storyTime 与 scheduledTime.*必须保留该年份或纪年/u);
    assert.match(prompt, /回忆、约定日期和年份未知的时间不得无依据套用当前故事年或现实年份/u);
    assert.match(prompt, /同一 sourceFloorKey（来源楼）的同一场景/);
    assert.match(prompt, /不得跨 sourceFloorKey 合并不同来源楼的事件/);
    assert.match(prompt, /没有新增事实、关系变化或事项进展的重复日常不另立事件/);
    assert.match(prompt, /新计划、事项的实质推进、完成、取消和其他关键变化仍须记录/u);
    assert.doesNotMatch(prompt, /important|关系转折（确认关系、决裂、重要承诺）|判定重要/u);
  }
  assert.doesNotMatch(customPrompt, /一次性日常事件也可记录/u);
  assert.doesNotMatch(EXTRACTOR_OUTPUT_CONTRACT, /important/u);
});

test('摘要语义保留完整故事年份与纪年，旧月日仍原样兼容', async () => {
  const result = await direct({
    summary: '公历2026年10月4日抵达，约定大陆历1687年1月2日再会。',
    time: [
      { sourceText: '2026年10月4日', description: '抵达', kind: 'explicit', precision: 'exact' },
      { sourceText: '大陆历1686年10月4日', description: '旧事', kind: 'explicit', precision: 'exact' },
      { sourceText: '10月5日', description: '年份未知的记录', kind: 'explicit', precision: 'exact' },
    ],
    qianshi: { events: [{ key: 'event-1', title: '约定再会', description: '约定次年再会', status: 'planned', matter: true,
      storyTime: '大陆历1686年10月4日', scheduledTime: '大陆历1687年1月2日' }], order: [] },
  });
  assert.deepEqual(result.memory.chronology.map(item => item.time.sourceText), ['2026年10月4日', '大陆历1686年10月4日', '10月5日']);
  assert.equal(result.memory.qianshiDelta.events[0].storyTime, '大陆历1686年10月4日');
  assert.equal(result.memory.qianshiDelta.events[0].scheduledTime, '大陆历1687年1月2日');
});

test('模型漏 time 时只从本楼开头或明确时间栏提取时间，不把段中回忆日期冒充当前时间', async () => {
  const explicit = await direct({ summary: '开场。' }, { content: '10月4日 15:30，钟声响起。' });
  assert.equal(explicit.memory.chronology[0].time.sourceText, '10月4日 15:30');
  assert.equal(explicit.memory.chronology[0].time.kind, 'explicit');
  const relative = await direct({ summary: '继续。' }, { content: '次日，众人继续赶路。' });
  assert.equal(relative.memory.chronology[0].time.sourceText, '次日');
  assert.equal(relative.memory.chronology[0].time.kind, 'relative');
  const recalled = await direct({ summary: '回忆。' }, { content: '他望着窗外，想起10月4日的旧事。' });
  assert.equal(recalled.memory.chronology[0].time.sourceText, '时间未明确');
  const appointment = await direct({ summary: '查看约定。' }, { content: '他翻开日历，写着约定日期：10月4日。' });
  assert.equal(appointment.memory.chronology[0].time.sourceText, '时间未明确');
});

test('正常 load 一次投影本楼正文明确时间，面板重复 getState 不重扫聊天', async () => {
  const h = harness({ text: '当前时间：10月4日 15:30\n钟声响起。' });
  await h.runtime.start();
  const floor = h.runtime.getState().floors[0];
  assert.equal(floor.timeFallback, '10月4日 15:30');
  const afterLoad = h.snapshotCount();
  h.runtime.getState(); h.runtime.getState(); h.runtime.getState();
  assert.equal(h.snapshotCount(), afterLoad, '界面读取缓存状态不得再次扫描宿主聊天');
});

test('浅层 people/events 由本地编译，“主角/你”绑定 name1 且 user ID 不来自模型', async () => {
  const result = await direct({
    summary: '裴晚生把伞交给主角。',
    people: [{ name: '裴晚生', aliases: '裴生', id: 'model-id' }, { name: '主角/你', role: 'user', entityId: 'attacker-id' }],
    events: { title: '交伞', description: '裴晚生把伞交给主角。', operation: 'delete' },
    chatId: 'evil-chat', floorId: 'evil-floor', operation: 'overwrite',
  }, { content: '裴晚生把伞交给主角。' });
  assert.equal(result.newEntities.length, 2);
  const userEntity = result.newEntities.find(entity => entity.specialRole === 'user');
  assert.equal(userEntity.displayName, '林岚');
  assert.ok(userEntity.aliases.some(alias => alias.name === '你'));
  assert.match(userEntity.id, /^[0-9a-f-]{36}$/);
  assert.notEqual(userEntity.id, 'attacker-id');
  assert.equal(result.memory.chatId, CHAT);
  assert.equal(result.memory.floorId, '11111111-1111-4111-8111-111111111111');
  assert.equal(result.memory.eventFragments.length, 1);
  const conflict = await direct({ summary: '裴晚生单独出场。', people: [{ name: '裴晚生', role: 'user' }] }, { content: '裴晚生单独出场。' });
  assert.equal(conflict.newEntities.length, 1);
  assert.equal(conflict.newEntities[0].displayName, '裴晚生');
  assert.equal(conflict.newEntities[0].specialRole, 'none');
  assert.ok(conflict.isolated.some(item => item.code === 'V3_EXTRACTOR_USER_ROLE_CONFLICT'));
});

test('浅层语义按人物绑定编译 presence、typed action/info、holder 与 issuer/recipient，并原样进入 CSE', async () => {
  const content = '沈砚虽在远处被提到，随后本人到场，把钥匙交给顾舟。他写信告诉顾舟暗门在钟楼，心里仍担心苏意，并答应顾舟天亮前回来。';
  const result = await direct({
    summary: '沈砚到场交出钥匙、传递暗门消息并作出承诺。',
    people: [
      { name: '沈砚', aliases: ['阿砚'], presence: 'mentioned' },
      { name: '沈砚', presence: 'present' },
      { name: '顾舟' },
      { name: '陆遥', presence: 'remote' },
      { name: '苏意', presence: 'privateCognitionOnly' },
      { name: '闻川', presence: '无法识别' },
    ],
    events: [{ title: '会面', description: '沈砚本人到场。' }],
    actions: [
      { actor: { name: '阿砚' }, targets: [{ name: '顾舟' }], action: '把钥匙交给顾舟' },
      { summary: '雨伞留在门边' },
      { actor: '不存在的人', action: '拿走钥匙' },
    ],
    informationTransfers: [
      { from: { name: '沈砚' }, recipient: { name: '顾舟' }, claimText: '暗门在钟楼', channel: 'written' },
      { from: '沈砚', to: '顾舟', claimText: '渠道不明的消息' },
    ],
    privateThoughts: [{ holder: { name: '阿砚' }, thought: '仍担心苏意' }, { holder: '不存在的人', thought: '不能公开降级' }],
    commitments: [{ issuer: { name: '沈砚' }, recipient: { name: '顾舟' }, content: '天亮前回来' }],
    cseSignals: [{ subject: { name: '沈砚' }, object: { name: '顾舟' }, signalType: 'trust', description: '沈砚把钥匙托付给顾舟' }],
  }, { content });
  const entityByName = new Map(result.newEntities.map(entity => [entity.displayName, entity]));
  const presenceByName = new Map(result.memory.participants.map(item => [result.newEntities.find(entity => entity.id === item.entityId)?.displayName, item.presence]));
  assert.deepEqual(Object.fromEntries(presenceByName), { '沈砚': 'present', '顾舟': 'mentioned', '陆遥': 'remote', '苏意': 'privateCognitionOnly', '闻川': 'mentioned' });
  assert.equal(result.memory.actions.length, 1);
  assert.equal(result.memory.actions[0].actorEntityId, entityByName.get('沈砚').id);
  assert.deepEqual(result.memory.actions[0].targetEntityIds, [entityByName.get('顾舟').id]);
  assert.equal(result.memory.actions[0].completion, 'uncertain');
  assert.equal(result.memory.actions[0].result, null);
  assert.deepEqual(result.memory.eventFragments.map(item => item.description), ['沈砚本人到场。', '雨伞留在门边']);
  assert.equal(result.memory.informationTransfers[0].fromEntityId, entityByName.get('沈砚').id);
  assert.deepEqual(result.memory.informationTransfers[0].toEntityIds, [entityByName.get('顾舟').id]);
  assert.equal(result.memory.informationTransfers[0].channel, 'written');
  assert.equal(result.memory.privateCognition[0].ownerEntityId, entityByName.get('沈砚').id);
  assert.equal(result.memory.commitments[0].speakerEntityId, entityByName.get('沈砚').id);
  assert.deepEqual(result.memory.commitments[0].targetEntityIds, [entityByName.get('顾舟').id]);
  assert.equal(result.memory.cseSignals[0].subjectEntityId, entityByName.get('沈砚').id);
  assert.equal(result.memory.cseSignals[0].objectEntityId, entityByName.get('顾舟').id);
  assert.ok(result.isolated.some(item => item.path === 'actions[2].actor'));
  assert.ok(result.isolated.some(item => item.path === 'informationTransfers[1].channel'));
  assert.ok(result.isolated.some(item => item.path === 'privateThoughts[1].owner'));
  const cseEnvelope = createCseEnvelope({
    floor: { id: result.memory.floorId, content: { canonicalContent: content } }, floorMemory: result.memory,
    baseline: { userPersona: { entityId: entityByName.get('顾舟').id, name: '顾舟', description: '' }, characterCard: { entityId: entityByName.get('沈砚').id, name: '沈砚', description: '', personality: '', scenario: '' }, worldInfoSources: [] },
    currentState: null, trackedSubjects: [entityByName.get('沈砚')], entities: result.newEntities,
  });
  assert.deepEqual(cseEnvelope.request.payload.floorMemory.actions[0], { actor: '沈砚', targets: ['顾舟'], action: '把钥匙交给顾舟', completion: 'uncertain', result: null });
  assert.deepEqual(cseEnvelope.request.payload.floorMemory.informationTransfers[0], { from: '沈砚', to: ['顾舟'], claim: '暗门在钟楼', channel: 'written' });
  assert.deepEqual(cseEnvelope.request.payload.floorMemory.privateCognition[0], { owner: '沈砚', kind: 'thought', content: '仍担心苏意', visibility: 'private' });
  assert.deepEqual(cseEnvelope.request.payload.floorMemory.cseSignals[0], { subject: '沈砚', object: '顾舟', type: 'trust', description: '沈砚把钥匙托付给顾舟' });
});

test('运行时首次需要时建立唯一 user Entity，重提取不重复创建', async () => {
  const h = harness({ utility: () => ({ jsonData: { summary: '裴晚生提醒你带伞。', people: [{ name: '你', role: 'user' }, { name: '裴晚生' }] } }) });
  let state = await h.runtime.start().then(() => h.runtime.extractNext());
  assert.equal(state.rememberedCount, 1, JSON.stringify(state.lastExtractorError));
  let root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  let checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  let entities = checkpoint.producedRefs.entities.map(id => h.backend.records.get(`chat-${CHAT}/v3-entity-${id}`).data);
  assert.equal(entities.filter(entity => entity.specialRole === 'user').length, 1);
  state = await h.runtime.extractFloor(state.floors[0].floorId);
  root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  entities = checkpoint.producedRefs.entities.map(id => h.backend.records.get(`chat-${CHAT}/v3-entity-${id}`).data);
  assert.equal(entities.filter(entity => entity.specialRole === 'user').length, 1);
});

test('人工身份映射贯穿真实 memory→extractor→保存链，模型误称 new 仍落到目标且旧称进入目录', async () => {
  let projection = {};
  const extractorPayloads = [];
  const h = harness({
    initialChat: [user('开始'), assistant('旧称甲首次出现。'), assistant('目标乙随后出现。'), assistant('旧称甲再次行动。'), assistant('用于确认上一楼稳定。')],
    identityProjectionProvider: async () => projection,
    utility: options => {
      const request = JSON.parse(options.taskMessages[0].content); extractorPayloads.push(structuredClone(request.payload));
      if (request.payload.canonicalContent.includes('首次')) return { jsonData: { summary: '旧称甲首次出现。', people: [{ name: '旧称甲', presence: 'present' }] } };
      if (request.payload.canonicalContent.includes('目标乙')) return { jsonData: { summary: '目标乙随后出现。', people: [{ name: '目标乙', presence: 'present' }] } };
      return { jsonData: { summary: '旧称甲再次行动。', people: [{ name: '旧称甲', presence: 'present' }], actions: [{ actor: '旧称甲', action: '再次行动' }] } };
    },
  });
  await h.runtime.start(); let state = h.runtime.getState();
  await h.runtime.extractFloor(state.floors[0].floorId, { analyzeState: false });
  await h.runtime.extractFloor(state.floors[1].floorId, { analyzeState: false });
  let reachable = await h.store.readReachable({ mode: 'runtime' });
  const source = reachable.entities.find(entity => entity.displayName === '旧称甲' && entity.status !== 'merged');
  const target = reachable.entities.find(entity => entity.displayName === '目标乙' && entity.status !== 'merged');
  projection = { identityRedirectsByEntityId: { [source.id]: target.id }, deletedEntityIds: [] };
  state = h.runtime.getState(); await h.runtime.extractFloor(state.floors[2].floorId, { analyzeState: false });
  reachable = await h.store.readReachable({ mode: 'runtime' });
  const third = reachable.floorMemories.find(memory => memory.floorId === state.floors[2].floorId && memory.recordStatus === 'active');
  assert.equal(third.participants[0].entityId, target.id); assert.equal(third.actions[0].actorEntityId, target.id);
  assert.equal(reachable.entities.filter(entity => entity.displayName === '旧称甲' && entity.status !== 'merged').length, 1, '人工映射不写回旧实体，也不新建第二个旧称实体');
  const lastCatalog = extractorPayloads.at(-1).knownPeople;
  assert.equal(lastCatalog.length, 1); assert.equal(lastCatalog[0].displayName, '目标乙'); assert.ok(lastCatalog[0].aliases.includes('旧称甲'));
});

test('人工身份映射纠正 legacy 的 new/uncertain 旧称并经真实 memory 保存，普通 uncertain 不建实体', async () => {
  let projection = {};
  const h = harness({
    initialChat: [user('开始'), assistant('旧称甲首次出现。'), assistant('目标乙随后出现。'), assistant('旧称甲与旧称甲别名再次行动，路人丙身份不明。'), assistant('用于确认上一楼稳定。')],
    identityProjectionProvider: async () => projection,
    utility: options => {
      const request = JSON.parse(options.taskMessages[0].content);
      if (request.payload.canonicalContent.includes('首次')) return { jsonData: { summary: '旧称甲首次出现。', people: [{ name: '旧称甲', aliases: ['旧称甲别名'], presence: 'present' }] } };
      if (request.payload.canonicalContent.includes('目标乙')) return { jsonData: { summary: '目标乙随后出现。', people: [{ name: '目标乙', presence: 'present' }] } };
      const emptyArrays = Object.fromEntries(['chronology', 'locations', 'observations', 'informationTransfers', 'privateCognition', 'commitments', 'eventFragments', 'exactAnchors', 'openLoops', 'ambiguities', 'cseSignals'].map(key => [key, []]));
      return { jsonData: {
        schemaVersion: 3,
        task: 'extractFloorMemory',
        promptVersion: EXTRACTOR_PROMPT_VERSION,
        floors: [{
          status: 'ok', summary: '旧称甲再次行动。', summaryEvidence: [], ...emptyArrays,
          entityMentions: [
            { mentionKey: 'mapped-new', surface: '旧称甲', aliases: [], entityType: 'person', identity: 'new', entityKey: null, evidence: [] },
            { mentionKey: 'mapped-uncertain', surface: '旧称甲别名', aliases: [], entityType: 'person', identity: 'uncertain', entityKey: null, evidence: [] },
            { mentionKey: 'ordinary-uncertain', surface: '路人丙', aliases: [], entityType: 'person', identity: 'uncertain', entityKey: null, evidence: [] },
          ],
          participants: [{ mentionKey: 'mapped-new', presence: 'present', evidence: [] }],
          actions: [{ actorMentionKey: 'mapped-uncertain', targetMentionKeys: [], action: '再次行动', completion: 'completed', result: null, evidence: [] }],
        }],
      } };
    },
  });
  await h.runtime.start(); let state = h.runtime.getState();
  await h.runtime.extractFloor(state.floors[0].floorId, { analyzeState: false });
  await h.runtime.extractFloor(state.floors[1].floorId, { analyzeState: false });
  let reachable = await h.store.readReachable({ mode: 'runtime' });
  const source = reachable.entities.find(entity => entity.displayName === '旧称甲' && entity.status !== 'merged');
  const target = reachable.entities.find(entity => entity.displayName === '目标乙' && entity.status !== 'merged');
  projection = { identityRedirectsByEntityId: { [source.id]: target.id }, deletedEntityIds: [] };
  state = h.runtime.getState(); await h.runtime.extractFloor(state.floors[2].floorId, { analyzeState: false });
  reachable = await h.store.readReachable({ mode: 'runtime' });
  const third = reachable.floorMemories.find(memory => memory.floorId === state.floors[2].floorId && memory.recordStatus === 'active');
  assert.equal(third.participants[0].entityId, target.id, 'legacy identity:new 的人工旧称应直接保存为目标人物');
  assert.equal(third.actions[0].actorEntityId, target.id, 'legacy identity:uncertain 的人工旧别名同样应保存为目标人物');
  assert.equal(reachable.entities.filter(entity => entity.displayName === '旧称甲' && entity.status !== 'merged').length, 1, '不得为 legacy new 再建旧称实体');
  assert.equal(reachable.entities.some(entity => entity.displayName === '路人丙'), false, '没有人工映射的 uncertain 仍保持未解析，不得建实体');
});

test('群体多称谓沿不可变 merged 目录复用，成员保持独立且早楼看不到未来别名', async () => {
  const csePayloads = [];
  const extractorPayloads = [];
  const h = harness({
    initialChat: [user('开始'), assistant('第0段：守夜人和张三、李四出现。'), assistant('第4段：门卫们再次出现。'), assistant('第8段：保安组继续值守。'), assistant('用于确认第8段稳定。')],
    utility: options => {
      const request = JSON.parse(options.taskMessages[0].content);
      if (request.task === 'understandCharacterStateAfterFloor') {
        csePayloads.push(request.payload);
        return { jsonData: { subjects: request.payload.trackedSubjects.map(subject => ({ subject: subject.name, situational: [{ text: `${subject.name}的独立状态`, reason: '本楼', visibility: 'private' }] })) } };
      }
      extractorPayloads.push(structuredClone(request.payload));
      const group = request.payload.knownPeople.find(person => person.entityKind === 'group');
      if (request.payload.canonicalContent.includes('第0段')) return { jsonData: { summary: '守夜人与两名成员出现。', people: [{ name: '守夜人', aliases: ['夜班保安', '张三', '李四'], entityKind: 'group', presence: 'present' }, { name: '张三', entityKind: 'individual', presence: 'present' }, { name: '李四', entityKind: 'individual', presence: 'present' }], actions: [{ actor: '张三', action: '检查门锁' }] } };
      if (request.payload.canonicalContent.includes('第4段')) return { jsonData: { summary: '门卫们再次出现。', people: [{ name: '门卫们', entityKind: 'group', sameAsEntityKey: group?.entityKey, presence: 'present' }, { name: '张三', entityKind: 'individual', presence: 'present' }, { name: '李四', entityKind: 'individual', presence: 'present' }] } };
      return { jsonData: { summary: '保安组继续值守。', people: [{ name: '保安组', entityKind: 'group', sameAsEntityKey: group?.entityKey, presence: 'present' }, { name: '张三', entityKind: 'individual', presence: 'present' }, { name: '李四', entityKind: 'individual', presence: 'present' }] } };
    },
  });
  await h.runtime.start();
  await h.runtime.extractNext();
  let cold = await h.store.readReachable({ mode: 'runtime' });
  const canonicalGroup = cold.entities.find(entity => entity.entityType === 'group' && entity.status !== 'merged');
  const firstMemory = cold.floorMemories.find(memory => memory.floorId === h.runtime.getState().floors[0].floorId);
  const firstZhang = cold.entities.find(entity => entity.entityType === 'person' && entity.displayName === '张三' && entity.status !== 'merged');
  assert.equal(firstMemory.actions[0].actorEntityId, firstZhang.id, '成员名必须优先绑定 individual，不能被群体 alias 抢占');
  const originalGroupEnvelope = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-entity-${canonicalGroup.id}`));
  await h.runtime.extractNext();
  await h.runtime.extractNext();
  cold = await h.store.readReachable({ mode: 'runtime' });
  const groups = cold.entities.filter(entity => entity.entityType === 'group');
  const people = cold.entities.filter(entity => entity.entityType === 'person' && ['张三', '李四'].includes(entity.displayName) && entity.status !== 'merged');
  assert.equal(groups.filter(entity => entity.status !== 'merged').length, 1);
  assert.deepEqual(new Set(groups.filter(entity => entity.status === 'merged').map(entity => entity.mergedIntoEntityId)), new Set([canonicalGroup.id]));
  assert.deepEqual(people.map(entity => entity.displayName).sort(), ['张三', '李四']);
  assert.deepEqual([...buildEntityIdentityDirectory({ entities: cold.entities }).find(entry => entry.entityId === canonicalGroup.id).labels].sort(), ['保安组', '夜班保安', '守夜人', '门卫们'].sort());
  assert.deepEqual(h.backend.records.get(`chat-${CHAT}/v3-entity-${canonicalGroup.id}`), originalGroupEnvelope, '学习别名不得原地修改 canonical Entity');
  assert.equal(csePayloads.every(payload => payload.knownPeople.every(person => !['守夜人', '门卫们', '保安组'].includes(person.name))), true, 'group 不得进入 CSE knownPeople/trackedSubjects');
  assert.equal(csePayloads.every(payload => payload.trackedSubjects.every(person => !['守夜人', '门卫们', '保安组'].includes(person.name))), true);
  const latestStates = cold.currentStates.at(-1)?.subjects ?? [];
  assert.ok(people.every(person => latestStates.some(subject => subject.subjectEntityId === person.id && subject.situational.some(item => item.text === `${person.displayName}的独立状态`))), '两个成员必须保持各自 CSE 状态');

  const reloaded = harness({ sharedBackend: h.backend, sharedContext: h.context, utility: () => { throw new Error('别名召回冷读不得调用模型'); } });
  const recallSource = await readRecallSource({ store: reloaded.store, now: () => new Date(NOW) });
  const recalledByAlias = selectRecall({ source: recallSource, queryContext: { text: '保安组最初如何守夜', latestUserText: '保安组最初如何守夜', messageCount: 1 }, contextSize: 12000 });
  const recalledByCanonical = selectRecall({ source: recallSource, queryContext: { text: '守夜人最初如何守夜', latestUserText: '守夜人最初如何守夜', messageCount: 1 }, contextSize: 12000 });
  assert.match(recalledByAlias.injectionText, /守夜人与两名成员出现/, '冷启动后新学 merged 别名必须能命中旧楼事实');
  assert.match(recalledByCanonical.injectionText, /守夜人与两名成员出现/, 'canonical 主名召回不得退化');
  const recallGroup = recallSource.entities.find(entity => entity.entityId === canonicalGroup.id);
  assert.deepEqual([...new Set([recallGroup.displayName, ...recallGroup.aliases])].sort(), ['保安组', '夜班保安', '守夜人', '门卫们'].sort());
  assert.equal(recallSource.entities.some(entity => entity.entityType === 'person' && entity.aliases.includes('保安组')), false, '统一目录仍须保持实体类型边界');

  const firstFloorId = h.runtime.getState().floors[0].floorId;
  await h.runtime.extractFloor(firstFloorId, { analyzeState: false });
  const firstRequests = extractorPayloads.filter(payload => payload.canonicalContent.includes('第0段'));
  const earlyLabels = firstRequests.at(-1).knownPeople.flatMap(person => [person.displayName, ...person.aliases]);
  assert.equal(earlyLabels.includes('门卫们') || earlyLabels.includes('保安组'), false, '重提早楼不得看到未来才学习的群体别名');
});

test('sameAs 只接受局部同类型精确绑定，错误键、用户冒绑与同名歧义均隔离', async () => {
  const base = (id, displayName, { specialRole = 'none', aliases = [] } = {}) => ({ id, chatId: CHAT, narrativeGeneration: GENERATION, entityType: 'person', displayName, aliases: aliases.map(name => ({ name })), specialRole, firstSeenFloorId: null, lastSeenFloorId: null, status: 'established', recordStatus: 'active' });
  const entities = [
    base('10000000-0000-4000-8000-000000000001', '裴晚生', { specialRole: 'char' }),
    base('10000000-0000-4000-8000-000000000002', '林岚', { specialRole: 'user' }),
    base('10000000-0000-4000-8000-000000000003', '甲', { aliases: ['共同称呼', '阿砚'] }),
    base('10000000-0000-4000-8000-000000000004', '乙', { aliases: ['共同称呼'] }),
  ];
  const result = await direct({
    summary: '身份绑定检查。',
    people: [
      { name: '裴先生', entityKind: 'individual', sameAsEntityKey: 'catalog-1' },
      { name: '晚生', entityKind: 'individual', sameAsEntityKey: 'catalog-1' },
      { name: '守卫组', entityKind: 'group', sameAsEntityKey: 'catalog-1' },
      { name: '冒名者', entityKind: 'individual', sameAsEntityKey: 'catalog-2' },
      { name: '共同称呼', entityKind: 'individual' },
      { name: '错误键', entityKind: 'individual', sameAsEntityKey: 'catalog-99' },
      { name: '阿', entityKind: 'individual' },
    ],
    actions: [{ actor: '裴先生', action: '确认身份' }],
  }, { entities, content: '裴先生确认身份，晚生点头；守卫组、冒名者、共同称呼、错误键与阿只是测试称谓。' });
  assert.equal(result.memory.participants.filter(item => item.entityId === entities[0].id).length, 1, '同一 canonical 的重复 mentions 应去重');
  assert.equal(result.memory.actions[0].actorEntityId, entities[0].id, 'char 的合法局部 sameAs 必须可用');
  const aliasRecords = result.newEntities.filter(entity => entity.status === 'merged');
  assert.equal(aliasRecords.length, 1);
  assert.equal(aliasRecords[0].mergedIntoEntityId, entities[0].id);
  assert.deepEqual([aliasRecords[0].displayName, ...aliasRecords[0].aliases.map(alias => alias.name)].sort(), ['晚生', '裴先生'].sort());
  assert.ok(result.newEntities.some(entity => entity.status !== 'merged' && entity.displayName === '阿'), '包含匹配不得把“阿”误并入“阿砚”');
  for (const code of ['V3_EXTRACTOR_ENTITY_TYPE_CONFLICT', 'V3_EXTRACTOR_USER_ROLE_CONFLICT', 'V3_EXTRACTOR_ENTITY_AMBIGUOUS', 'V3_EXTRACTOR_ENTITY_KEY_INVALID']) assert.ok(result.isolated.some(item => item.code === code), code);
  assert.equal(result.newEntities.some(entity => ['守卫组', '冒名者', '共同称呼', '错误键'].includes(entity.displayName)), false, '显式错误或歧义不能回退新建');
});

test('同名个人与群体、带标点的不同新名称均保持独立，同类重复和旧目录仍精确去重', async () => {
  const response = {
    summary: '猎隼特工与猎隼小队分头行动，A-B 与 AB 也各自出场。',
    people: [
      { name: '猎隼', aliases: ['猎隼特工'], entityKind: 'individual' },
      { name: '猎隼', aliases: ['猎隼小队'], entityKind: 'group' },
      { name: 'A-B', aliases: ['A-B备用'], entityKind: 'individual' },
      { name: 'A-B', entityKind: 'individual' },
      { name: 'AB', entityKind: 'individual' },
    ],
    actions: [
      { actor: '猎隼特工', action: '单独潜入' },
      { actor: '猎隼小队', action: '集体封锁' },
      { actor: 'A-B', action: '记录甲' },
      { actor: 'AB', action: '记录乙' },
    ],
  };
  const result = await direct(response, { content: '猎隼特工单独潜入，猎隼小队集体封锁；A-B 记录甲，AB 记录乙。' });
  const individual = result.newEntities.find(entity => entity.entityType === 'person' && entity.displayName === '猎隼');
  const group = result.newEntities.find(entity => entity.entityType === 'group' && entity.displayName === '猎隼');
  const punctuated = result.newEntities.find(entity => entity.displayName === 'A-B' && entity.status !== 'merged');
  const compact = result.newEntities.find(entity => entity.displayName === 'AB' && entity.status !== 'merged');
  assert.ok(individual && group && punctuated && compact);
  assert.notEqual(individual.id, group.id);
  assert.notEqual(punctuated.id, compact.id);
  assert.equal(result.newEntities.filter(entity => entity.displayName === 'A-B' && entity.status !== 'merged').length, 1, '同类型完整同名仍去重');
  assert.deepEqual(result.memory.actions.map(item => item.actorEntityId), [individual.id, group.id, punctuated.id, compact.id]);

  const known = { id: '10000000-0000-4000-8000-000000000099', chatId: CHAT, narrativeGeneration: GENERATION, entityType: 'person', displayName: '赤狐', aliases: [], specialRole: 'none', firstSeenFloorId: null, lastSeenFloorId: null, status: 'established', recordStatus: 'active' };
  const matched = await direct({ summary: '赤狐出场。', people: [{ name: '赤狐', entityKind: 'individual' }] }, { entities: [known], content: '赤狐出场。' });
  assert.equal(matched.newEntities.length, 0);
  assert.equal(matched.memory.participants[0].entityId, known.id);
});

test('code fence、前后说明、数组包裹、尾逗号、常见键别名与单值数组均可有限容错', async () => {
  const wrapped = '处理结果如下：\n```json\n[{"总结":"裴晚生提醒用户带伞。","角色":{"name":"裴晚生"},"事件":{"title":"提醒", "description":"裴晚生提醒用户带伞。",},}]\n```\n完毕。';
  const result = await direct(wrapped);
  assert.equal(result.memory.summary.aiText, '裴晚生提醒用户带伞。');
  assert.equal(result.newEntities[0].displayName, '裴晚生');
  assert.equal(result.memory.eventFragments.length, 1);
  const prose = await direct('裴晚生提醒用户带伞。');
  assert.equal(prose.memory.summary.aiText, '裴晚生提醒用户带伞。');
  const englishLabel = await direct('Summary: 裴晚生提醒用户带伞。');
  assert.equal(englishLabel.memory.summary.aiText, '裴晚生提醒用户带伞。');
  const chineseLabel = await direct('总结: 裴晚生提醒用户带伞。');
  assert.equal(chineseLabel.memory.summary.aiText, '裴晚生提醒用户带伞。');
  const explainedJson = await direct('说明：{"summary":"裴晚生提醒用户带伞。"} 完毕。');
  assert.equal(explainedJson.memory.summary.aiText, '说明：{"summary":"裴晚生提醒用户带伞。"} 完毕。');
  const floorWrapped = await direct({ floors: [{ summary: '楼层包裹摘要。' }] });
  assert.equal(floorWrapped.memory.summary.aiText, '楼层包裹摘要。');
});

test('中英/粤语原句与括号译文不会让整楼失败或待复核', async () => {
  const content = '裴晚生说：“食咗饭未？”*(吃饭了吗？)* 随后说“Take care.”（保重。）';
  const result = await direct({ summary: '裴晚生关心对方是否吃饭并叮嘱保重。', people: '裴晚生', events: [{ title: '关心叮嘱', description: '裴晚生询问是否吃饭并叮嘱保重。', quote: '食咗饭未？' }], exactQuotes: ['食咗饭未？', { exactText: 'Take care.', kind: 'other', speaker: '裴晚生', whyPreserve: '叮嘱原句' }] }, { content });
  assert.equal(result.memory.eventFragments.length, 1);
  assert.equal(result.memory.exactAnchors.length, 2);
  assert.equal(result.memory.exactAnchors[1].kind, 'other');
  assert.equal(result.memory.exactAnchors[1].speakerEntityId, result.newEntities[0].id);
  assert.equal(result.memory.exactAnchors[1].whyPreserve, '叮嘱原句');
  assert.equal(result.needsReview, false);
});

test('前置 USER 原句由本地定位写入来源，跨来源重复原句不猜测', async () => {
  const sourceUserInputSnapshot = { messages: [
    { content: '林岚握住他的手。', messageIndex: 0, swipeId: null, selectedSwipeIndex: null },
    { content: '林岚说：“暗号是归航。”', messageIndex: 1, swipeId: 1, selectedSwipeIndex: 1 },
  ] };
  const response = {
    summary: '林岚握住裴晚生的手并说出归航暗号；裴晚生随后回应。',
    people: [{ name: '林岚', role: 'user' }, { name: '裴晚生' }],
    actions: [{ actor: '林岚', targets: ['裴晚生'], action: '握住裴晚生的手', completion: 'completed', exactQuote: '握住他的手', source: 'precedingUserInput' }],
    commitments: [{ issuer: '林岚', recipient: '裴晚生', content: '使用归航作为暗号', kind: 'codePhrase', status: 'made', exactQuote: '暗号是归航', source: 'precedingUserInput' }],
    exactQuotes: [{ exactText: '暗号是归航', kind: 'codePhrase', speaker: '林岚', source: 'precedingUserInput' }],
  };
  const result = await direct(response, { content: '裴晚生回应：“暗号是归航。”', sourceUserInputSnapshot });
  assert.deepEqual(result.memory.sourceUserInputSnapshot, sourceUserInputSnapshot);
  assert.equal(result.memory.actions[0].evidenceRefs[0].sourceType, 'precedingUser');
  assert.equal(result.memory.actions[0].evidenceRefs[0].sourceSnapshotIndex, 0);
  assert.equal(result.memory.commitments[0].evidenceRefs[0].sourceSnapshotIndex, 1);
  assert.equal(result.memory.exactAnchors[0].sourceType, 'precedingUser');
  assert.equal(result.memory.exactAnchors[0].sourceSnapshotIndex, 1);
  assert.equal(result.memory.commitments[0].exactAnchorId, result.memory.exactAnchors[0].anchorId);

  const ambiguous = await direct({ summary: '双方说出同一句。', exactQuotes: ['暗号是归航'] }, { content: '裴晚生说：“暗号是归航。”', sourceUserInputSnapshot });
  assert.equal(ambiguous.memory.exactAnchors.length, 0, '跨 AI/USER 重复原句且无来源提示时不得猜来源');
  assert.ok(ambiguous.isolated.some(item => item.code === 'V3_EXTRACTOR_ANCHOR_NOT_FOUND'));
  const assistantOnly = await direct({ summary: '裴晚生说出暗号。', exactQuotes: [{ exactText: '暗号是归航', source: 'canonicalContent' }] }, { content: '裴晚生说：“暗号是归航。”', sourceUserInputSnapshot });
  assert.equal(assistantOnly.memory.exactAnchors[0].sourceType, 'assistant');
  assert.equal(Object.hasOwn(assistantOnly.memory.exactAnchors[0], 'sourceSnapshotIndex'), false);

  const legacy = structuredClone(assistantOnly.memory);
  delete legacy.sourceUserInputSnapshot;
  const validatedLegacy = validateFloorMemory(legacy, { expectedChatId: CHAT });
  assert.equal(Object.hasOwn(validatedLegacy, 'sourceUserInputSnapshot'), false, '旧记录缺字段应保持原结构，不得补默认值');
  const malformedOptionalReference = validateFloorMemory({ ...legacy, sourceVariableReference: ['不是楼变量对象'] }, { expectedChatId: CHAT });
  assert.equal(Object.hasOwn(malformedOptionalReference, 'sourceVariableReference'), false, '异常可选变量参考只跳过，不得令旧 FloorMemory 整条不可读');

  const outOfRange = structuredClone(result.memory);
  outOfRange.actions[0].evidenceRefs[0].sourceSnapshotIndex = sourceUserInputSnapshot.messages.length;
  assert.throws(() => validateFloorMemory(outOfRange, { expectedChatId: CHAT }), error => error?.code === 'V3_FLOORMEMORY_INVALID');
});

test('多行与连续空格原句经 normalize 和真实 runtime 保存后仍可逐字还原', async () => {
  const aiQuote = ' 保持\n  原样 ';
  const userQuote = ' 归航  暗号\n第二行 ';
  const content = `裴晚生说：“${aiQuote}。”`;
  const userText = `林岚说：“${userQuote}。”`;
  const sourceUserInputSnapshot = { messages: [{ content: userText, messageIndex: 0, swipeId: null, selectedSwipeIndex: null }] };
  const response = {
    summary: '裴晚生要求保持原样，林岚约定使用归航暗号。',
    people: [{ name: '裴晚生' }, { name: '林岚', role: 'user' }],
    actions: [{ actor: '裴晚生', action: '要求保持原样', exactQuote: aiQuote, source: 'canonicalContent' }],
    commitments: [{ issuer: '林岚', recipient: '裴晚生', content: '使用归航暗号', kind: 'codePhrase', exactQuote: userQuote, source: 'precedingUserInput' }],
    exactQuotes: [aiQuote, { exactText: userQuote, kind: 'codePhrase', speaker: '林岚', source: 'precedingUserInput' }],
  };
  const assertLiteralMemory = memory => {
    assert.equal(memory.actions[0].evidenceRefs[0].quotedText, aiQuote);
    assert.equal(memory.actions[0].evidenceRefs[0].occurrence, 1);
    assert.equal(memory.commitments[0].evidenceRefs[0].quotedText, userQuote);
    assert.equal(memory.commitments[0].evidenceRefs[0].sourceType, 'precedingUser');
    assert.equal(memory.exactAnchors[0].exactText, aiQuote);
    assert.equal(memory.exactAnchors[1].exactText, userQuote);
    assert.equal(memory.commitments[0].exactAnchorId, memory.exactAnchors[1].anchorId);
  };

  const normalized = await direct(response, { content, sourceUserInputSnapshot });
  assertLiteralMemory(normalized.memory);

  const h = harness({ initialChat: [user(userText), assistant(content), user('稳定确认')], utility: () => ({ jsonData: response }) });
  await h.runtime.start();
  const floorId = h.runtime.getState().floors[0].floorId;
  const state = await h.runtime.extractFloor(floorId, { analyzeState: false });
  const saved = state.floors.find(floor => floor.floorId === floorId)?.memory;
  assert.ok(saved, JSON.stringify(state.lastExtractorError));
  assertLiteralMemory(saved);
  const cold = await h.store.readReachable({ mode: 'runtime' });
  assertLiteralMemory(cold.floorMemories.find(memory => memory.floorId === floorId));
});

test('informationTransfers 的 source 只决定引文来源，不因键顺序冒充发送人', async () => {
  const sourceUserInputSnapshot = { messages: [{ content: '沈砚说：“暗门在钟楼。”顾舟发现：“门  开着。”', messageIndex: 0, swipeId: null, selectedSwipeIndex: null }] };
  const result = await direct({
    summary: '沈砚告知顾舟暗门位置，顾舟发现门开着。',
    people: [{ name: '沈砚' }, { name: '顾舟' }],
    informationTransfers: [
      { source: 'precedingUserInput', from: '沈砚', to: ['顾舟'], claimText: '暗门在钟楼', channel: 'told', exactQuote: '暗门在钟楼' },
      { from: '沈砚', source: 'precedingUserInput', to: ['顾舟'], claimText: '暗门在钟楼', channel: 'told', exactQuote: '暗门在钟楼' },
      { source: 'precedingUserInput', from: null, to: ['顾舟'], claimText: '门开着', channel: 'discovered', exactQuote: '门  开着' },
    ],
  }, { content: '裴晚生在远处等待。', sourceUserInputSnapshot });
  assert.equal(result.memory.informationTransfers.length, 3);
  const [sourceFirst, fromFirst, discovered] = result.memory.informationTransfers;
  assert.deepEqual(
    { from: sourceFirst.fromEntityId, to: sourceFirst.toEntityIds, claim: sourceFirst.claimText, channel: sourceFirst.channel, evidence: sourceFirst.evidenceRefs },
    { from: fromFirst.fromEntityId, to: fromFirst.toEntityIds, claim: fromFirst.claimText, channel: fromFirst.channel, evidence: fromFirst.evidenceRefs },
  );
  assert.equal(sourceFirst.evidenceRefs[0].sourceType, 'precedingUser');
  assert.equal(sourceFirst.evidenceRefs[0].sourceSnapshotIndex, 0);
  assert.equal(discovered.fromEntityId, null);
  assert.equal(discovered.evidenceRefs[0].quotedText, '门  开着');
  assert.equal(result.newEntities.some(entity => entity.displayName === 'precedingUserInput'), false);
});

test('坏可选条目、未知枚举、无法绑定人物与引文定位失败只降级当项', async () => {
  const result = await direct({
    summary: '裴晚生提醒用户带伞。', people: [{ name: '裴晚生' }, {}],
    locations: [{ name: '门口', change: '不存在枚举' }, {}], events: [{ title: '提醒', description: '裴晚生提醒用户带伞。' }, { title: '空事件' }],
    privateThoughts: [{ owner: '不存在的人', content: '私下想法' }],
    commitments: [{ speaker: '裴晚生', content: '明天回来', exactQuote: '正文里没有的承诺原话' }],
    exactQuotes: ['正文里没有的原句'],
  });
  assert.equal(result.memory.locations.length, 1);
  assert.equal(result.memory.locations[0].change, 'present');
  assert.equal(result.memory.eventFragments.length, 1);
  assert.equal(result.memory.exactAnchors.length, 0);
  assert.equal(result.memory.observations.length, 0, '幻觉引文不得改写成正式事实');
  assert.equal(result.memory.commitments.length, 1);
  assert.equal(result.memory.commitments[0].exactAnchorId, null);
  assert.ok(result.isolated.some(item => item.code === 'V3_EXTRACTOR_ANCHOR_NOT_FOUND'));
  assert.ok(result.isolated.length >= 4);
  assert.equal(result.needsReview, false);
});

test('可选项错误不会发起第二次格式修复 API', async () => {
  const floor = { id: '11111111-1111-4111-8111-111111111111', chatId: CHAT, narrativeGeneration: GENERATION, assistantSeq: 1, content: { canonicalContent: '裴晚生提醒你带伞。' } };
  const envelope = await createExtractorEnvelope({ batchId: '33333333-3333-4333-8333-333333333333', chatId: CHAT, narrativeGeneration: GENERATION, floor, userIdentity: { displayName: '林岚' } });
  const calls = [];
  const result = await runExtractorRequest({ generateUtilityTask: async options => { calls.push(options); return { jsonData: { summary: '裴晚生提醒用户带伞。', events: [{ title: '缺描述' }] } }; }, envelope, floor, expectedScope: envelope.scope, now: NOW });
  assert.equal(calls.length, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.memory.eventFragments.length, 0);
});

test('extractor 通过真实 compact 路由共享三次 HTTP 预算，格式失败可恢复且耗尽后保留最终诊断', async () => {
  const floor = { id: '11111111-1111-4111-8111-111111111111', chatId: CHAT, narrativeGeneration: GENERATION, assistantSeq: 1, content: { canonicalContent: '三次请求使用同一楼正文。' } };
  const envelope = await createExtractorEnvelope({ batchId: '32323232-3232-4232-8232-323232323232', chatId: CHAT, narrativeGeneration: GENERATION, floor, userIdentity: { displayName: '林岚' } });
  const bodies = [];
  const replies = ['{}', '{}', '{"summary":"第三次得到有效摘要。"}'];
  const router = taskRouter(async (_path, options) => { bodies.push(JSON.parse(options.body)); return compactResponse(replies.shift()); });
  const result = await runExtractorRequest({ generateUtilityTask: router.generateUtilityTask, envelope, floor, expectedScope: envelope.scope, now: NOW });
  assert.equal(bodies.length, 3);
  assert.equal(result.attempts, 3);
  assert.equal(result.transportAttempts, 3);
  assert.equal(result.memory.summary.aiText, '第三次得到有效摘要。');
  assert.deepEqual(bodies.map(body => body.messages), [bodies[0].messages, bodies[0].messages, bodies[0].messages], '每轮请求必须逐字复用同一输入');

  let failedFetches = 0;
  const failingRouter = taskRouter(async () => { failedFetches += 1; return compactResponse('{}'); });
  let failure;
  try { await runExtractorRequest({ generateUtilityTask: failingRouter.generateUtilityTask, envelope, floor, expectedScope: envelope.scope, now: NOW }); }
  catch (error) { failure = error; }
  assert.equal(failedFetches, 3);
  assert.equal(failure.code, 'V3_EXTRACTOR_SUMMARY_INVALID');
  assert.match(failure.message, /^已尝试 3 次仍失败：/);
  assert.equal(failure.extractorDiagnostics.attempts, 3);
  assert.equal(failure.extractorDiagnostics.transportAttempts, 3);
  assert.equal(failure.extractorDiagnostics.validationErrors.length, 3);
});

test('extractor 超时与空回复可在剩余预算内恢复，Abort 和认证错误立即停止', async () => {
  const floor = { id: '11111111-1111-4111-8111-111111111111', chatId: CHAT, narrativeGeneration: GENERATION, assistantSeq: 1, content: { canonicalContent: '请求边界验证。' } };
  const envelope = await createExtractorEnvelope({ batchId: '33323232-3232-4232-8232-323232323232', chatId: CHAT, narrativeGeneration: GENERATION, floor, userIdentity: { displayName: '林岚' } });

  let timeoutFetches = 0;
  const timeoutRouter = taskRouter(async (_path, options) => {
    timeoutFetches += 1;
    if (timeoutFetches === 1) return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    return compactResponse('{"summary":"超时后成功。"}');
  });
  const timed = await runExtractorRequest({ generateUtilityTask: timeoutRouter.generateUtilityTask, envelope, floor, expectedScope: envelope.scope, now: NOW });
  assert.equal(timeoutFetches, 2); assert.equal(timed.attempts, 2); assert.equal(timed.transportAttempts, 2);

  let emptyFetches = 0;
  const emptyRouter = taskRouter(async () => compactResponse(++emptyFetches === 1 ? '' : '{"summary":"空回复后成功。"}'));
  const emptied = await runExtractorRequest({ generateUtilityTask: emptyRouter.generateUtilityTask, envelope, floor, expectedScope: envelope.scope, now: NOW });
  assert.equal(emptyFetches, 2); assert.equal(emptied.attempts, 2); assert.equal(emptied.transportAttempts, 2);

  const controller = new AbortController();
  let abortFetches = 0;
  const abortRouter = taskRouter(async () => { abortFetches += 1; controller.abort(); return compactResponse('{}'); });
  await assert.rejects(runExtractorRequest({ generateUtilityTask: abortRouter.generateUtilityTask, envelope, floor, expectedScope: envelope.scope, now: NOW, signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(abortFetches, 1);

  let authFetches = 0;
  const authRouter = taskRouter(async () => { authFetches += 1; return compactResponse('', 401); });
  await assert.rejects(runExtractorRequest({ generateUtilityTask: authRouter.generateUtilityTask, envelope, floor, expectedScope: envelope.scope, now: NOW }), error => error.code === 'QQJ_AUTH');
  assert.equal(authFetches, 1);
});

test('extractor 真实 semantic 请求只在 stop 后共享修复缺失键引号', async () => {
  const floor = { id: '11111111-1111-4111-8111-111111111111', chatId: CHAT, narrativeGeneration: GENERATION, assistantSeq: 1, content: { canonicalContent: '裴晚生提醒你继续前进。' } };
  const envelope = await createExtractorEnvelope({ batchId: '34343434-3434-4434-8434-343434343434', chatId: CHAT, narrativeGeneration: GENERATION, floor, userIdentity: { displayName: '林岚' } });
  const malformed = '{"summary":"裴晚生提醒用户继续前进。","actions":[{"targets":[],action":"继续"}]}';
  const recovered = await runExtractorRequest({
    generateUtilityTask: async () => ({ textData: malformed, taskMetadata: { finishReason: 'stop' } }),
    envelope,
    floor,
    expectedScope: envelope.scope,
    now: NOW,
  });
  assert.equal(recovered.memory.summary.aiText, '裴晚生提醒用户继续前进。');
  assert.equal(recovered.metadata.finishReason, 'stop');
  const fenced = await runExtractorRequest({
    generateUtilityTask: async () => ({ textData: `结果：\n\`\`\`json\n${malformed}\n\`\`\`\n完毕。`, taskMetadata: { finishReason: 'stop' } }),
    envelope,
    floor,
    expectedScope: envelope.scope,
    now: NOW,
  });
  assert.equal(fenced.memory.summary.aiText, '裴晚生提醒用户继续前进。');
  const legalWrapped = await normalizeExtractorResponse({ response: '{"summary":"合法内部片段。"} 完毕。', finishReason: 'stop', envelope, floor, expectedScope: envelope.scope, now: NOW });
  assert.equal(legalWrapped.memory.summary.aiText, '合法内部片段。');
  await assert.rejects(
    runExtractorRequest({ generateUtilityTask: async () => ({ textData: malformed, taskMetadata: {} }), envelope, floor, expectedScope: envelope.scope, now: NOW }),
    error => error.code === 'V3_EXTRACTOR_SUMMARY_INVALID',
  );
  await assert.rejects(
    runExtractorRequest({ generateUtilityTask: async () => ({ textData: `${malformed} 完毕。`, taskMetadata: { finishReason: 'stop' } }), envelope, floor, expectedScope: envelope.scope, now: NOW }),
    error => error.code === 'V3_EXTRACTOR_SUMMARY_INVALID',
  );
});

test('extractor 在坏 schema 回显后只接受唯一合法业务 JSON，歧义或仅 schema 仍拒绝', async () => {
  const floor = { id: '11111111-1111-4111-8111-111111111111', chatId: CHAT, narrativeGeneration: GENERATION, assistantSeq: 1, content: { canonicalContent: '裴晚生提醒你继续前进。' } };
  const envelope = await createExtractorEnvelope({ batchId: '35353535-3535-4535-8535-353535353535', chatId: CHAT, narrativeGeneration: GENERATION, floor, userIdentity: { displayName: '林岚' } });
  const malformedSchema = '{"type":"object","required":["summary"],"properties":{"summary":{"type":"string"} "events":{"type":"array"}}}';
  const business = '{"summary":"裴晚生提醒用户继续前进。","events":[]}';
  let calls = 0;
  const recovered = await runExtractorRequest({
    generateUtilityTask: async () => {
      calls += 1;
      return { textData: `${malformedSchema}\n${business}`, taskMetadata: { finishReason: 'stop' } };
    },
    envelope,
    floor,
    expectedScope: envelope.scope,
    now: NOW,
  });
  assert.equal(calls, 1);
  assert.equal(recovered.attempts, 1);
  assert.equal(recovered.memory.summary.aiText, '裴晚生提醒用户继续前进。');

  await assert.rejects(
    normalizeExtractorResponse({ response: '{"summary":"候选甲。"}\n{"summary":"候选乙。"}', finishReason: 'stop', envelope, floor, expectedScope: envelope.scope, now: NOW }),
    error => error.code === 'V3_EXTRACTOR_SUMMARY_INVALID',
  );
  await assert.rejects(
    normalizeExtractorResponse({ response: malformedSchema, finishReason: 'stop', envelope, floor, expectedScope: envelope.scope, now: NOW }),
    error => error.code === 'V3_EXTRACTOR_SUMMARY_INVALID',
  );
});

test('摘要同义字段、常见嵌套与已返回语义可确定性降级，且不混入技术元数据', async () => {
  assert.equal((await direct({ 概述: '裴晚生提醒用户带伞。' })).memory.summary.aiText, '裴晚生提醒用户带伞。');
  assert.equal((await direct({ summary: '', overview: '空摘要后的有效概述。' })).memory.summary.aiText, '空摘要后的有效概述。');
  const fallback = await direct({
    events: [{ description: '裴晚生发现门外正在下雨。', id: 'af5b513f-c55f-586d-8ee3-1ff1ed230a48' }],
    actions: [{ action: '他把雨伞递给用户。', operation: 'overwrite' }],
    observations: [{ description: '伞面仍然干燥。' }],
    runId: 'v3-run-f77edea2-ed67-5b8f-835a-1a97eb13b28b',
    metadata: { description: '不得进入摘要', model: 'mock-model' },
  });
  assert.equal(fallback.memory.summary.aiText, '裴晚生发现门外正在下雨。；他把雨伞递给用户。；伞面仍然干燥。');
  assert.doesNotMatch(fallback.memory.summary.aiText, /events|actions|observations|runId|operation|af5b513f|mock-model|不得进入摘要/u);
  const nested = await direct({ response: { data: { result: { description: '裴晚生在门口停下。' } } } });
  assert.equal(nested.memory.summary.aiText, '裴晚生在门口停下。');
  const outerSummary = await direct({ overview: '外层概述优先保留。', data: { events: [{ description: '内层事件仍参与结构化编译。' }] } });
  assert.equal(outerSummary.memory.summary.aiText, '外层概述优先保留。');
  assert.equal(outerSummary.memory.eventFragments[0].description, '内层事件仍参与结构化编译。');
  assert.equal((await direct({ summary: '外层摘要不被空 data 吞掉。', data: null })).memory.summary.aiText, '外层摘要不被空 data 吞掉。');
  assert.equal((await direct({ summary: '外层摘要不被空 floors 吞掉。', floors: [] })).memory.summary.aiText, '外层摘要不被空 floors 吞掉。');
  assert.equal((await direct([{ description: '数组第一段。' }, { description: '数组第二段。' }])).memory.summary.aiText, '数组第一段。；数组第二段。');
  assert.equal((await direct({ data: [{ description: '包裹数组第一段。' }, { description: '包裹数组第二段。' }] })).memory.summary.aiText, '包裹数组第一段。；包裹数组第二段。');
  assert.equal((await direct('裴晚生提醒用户带伞。')).memory.summary.aiText, '裴晚生提醒用户带伞。');
  const bracketedNarrative = '他发现门牌[已损坏，编号是2026，随后离开，并说“hash: deadbeef”只是墙上的字。';
  assert.equal((await direct(bracketedNarrative)).memory.summary.aiText, bracketedNarrative);
});

test('只有完全没有可用语义文本才拒绝，损坏 JSON 仍不得降级为摘要', async () => {
  const eventFallback = await direct({ summary: '   ', events: [{ title: '提醒', description: '裴晚生提醒用户带伞。' }] });
  assert.equal(eventFallback.memory.summary.aiText, '裴晚生提醒用户带伞。');
  await assert.rejects(direct({ summary: 0 }), error => error.code === 'V3_EXTRACTOR_SUMMARY_INVALID');
  await assert.rejects(direct({ summary: false }), error => error.code === 'V3_EXTRACTOR_SUMMARY_INVALID');
  const bareHash = 'eadb6c9b820e7b3b';
  const rawUuid = 'af5b513f-c55f-586d-8ee3-1ff1ed230a48';
  for (const value of [bareHash, `sha256: ${bareHash}`, `runId=v3-run-${bareHash}`, rawUuid]) {
    await assert.rejects(direct(value), error => error.code === 'V3_EXTRACTOR_SUMMARY_INVALID');
    await assert.rejects(direct({ summary: value }), error => error.code === 'V3_EXTRACTOR_SUMMARY_INVALID');
  }
  await assert.rejects(direct({ runId: 'af5b513f-c55f-586d-8ee3-1ff1ed230a48', metadata: { description: '技术元数据不是剧情语义' } }), error => error.code === 'V3_EXTRACTOR_SUMMARY_INVALID');
  await assert.rejects(direct('{"summary":"裴晚生提醒用户带伞。"'), error => error.code === 'V3_EXTRACTOR_SUMMARY_INVALID');
  await assert.rejects(direct('[{"summary":"裴晚生提醒用户带伞。"}'), error => error.code === 'V3_EXTRACTOR_SUMMARY_INVALID');
  await assert.rejects(direct('{"摘要":"裴晚生提醒用户带伞。"'), error => error.code === 'V3_EXTRACTOR_SUMMARY_INVALID');
  await assert.rejects(direct('[{"概述":"裴晚生提醒用户带伞。"}'), error => error.code === 'V3_EXTRACTOR_SUMMARY_INVALID');
  const midStructureNarrative = '他看到墙上写着{"摘要":"旧记录"，但没有停下。';
  assert.equal((await direct(midStructureNarrative)).memory.summary.aiText, midStructureNarrative);
  const balancedMidStructureNarrative = '他看到墙上写着{"摘要":"旧记录"}，随后继续前行。';
  assert.equal((await direct(balancedMidStructureNarrative)).memory.summary.aiText, balancedMidStructureNarrative);
  const prose = await direct('裴晚生提醒用户带伞。');
  assert.equal(prose.memory.summary.aiText, '裴晚生提醒用户带伞。');
  const h = harness({ utility: () => ({ jsonData: { summary: '' } }) });
  const state = await h.runtime.start().then(() => h.runtime.extractNext());
  assert.equal(state.rememberedCount, 0);
  assert.equal(state.floors[0].memoryId, null);
  assert.equal(state.lastExtractorError.code, 'V3_EXTRACTOR_SUMMARY_INVALID');
});

test('本地 scope/正文指纹错位仍硬拒绝', async () => {
  const floor = { id: '11111111-1111-4111-8111-111111111111', chatId: CHAT, narrativeGeneration: GENERATION, assistantSeq: 1, content: { canonicalContent: '原文' } };
  const envelope = await createExtractorEnvelope({ batchId: '33333333-3333-4333-8333-333333333333', chatId: CHAT, narrativeGeneration: GENERATION, floor });
  await assert.rejects(normalizeExtractorResponse({ response: { summary: '摘要' }, envelope, floor: { ...floor, content: { canonicalContent: '被篡改' } }, existingEntities: [], now: NOW, expectedScope: envelope.scope }), error => error.code === 'V3_EXTRACTOR_LOCAL_SCOPE_INVALID');
});

test('单次提取固定源图快照，envelope 间隙替换 root 不再制造 LOCAL_SCOPE_INVALID', async () => {
  let h, originalRoot, swapped = false;
  h = harness({
    extractorPromptGuidance: () => {
      const graph = h.foundationRuntime.getReachable();
      originalRoot = graph.root;
      graph.root = { ...originalRoot, headCheckpointId: '44444444-4444-4444-8444-444444444444' };
      swapped = true;
      return '保持简洁';
    },
    utility: () => {
      assert.equal(swapped, true);
      h.foundationRuntime.getReachable().root = originalRoot;
      return { jsonData: { summary: '快照内摘要。' } };
    },
  });
  const state = await h.runtime.start().then(() => h.runtime.extractNext());
  assert.equal(state.rememberedCount, 1, JSON.stringify(state.lastExtractorError));
  assert.equal(state.lastExtractorError, null);
  assert.equal(state.floors[0].summary, '快照内摘要。');
});

test('未保存后楼正文变化仍保留既有 floor 身份，root 守卫保持当前世代', async () => {
  const h = harness({
    initialChat: [assistant('裴晚生提醒你带伞。'), assistant('旧的第二楼。'), assistant('用于确认第二楼稳定。')],
    utility: () => ({ jsonData: { summary: '裴晚生提醒用户带伞。', people: [{ name: '裴晚生' }, { name: '你', role: 'user' }] } }),
  });
  await h.runtime.start();
  const before = await h.store.readReachable();
  const prefix = before.floors[0];
  const oldGeneration = before.root.narrativeGeneration;

  h.context.chat[1] = assistant('改变后的第二楼。');
  await h.foundationRuntime.refreshStatus();
  await h.runtime.refreshStatus();
  let graph = await h.store.readReachable();
  assert.equal(graph.run.mode, 'incremental');
  assert.equal(graph.root.narrativeGeneration, oldGeneration);
  assert.equal(graph.floors[0].id, prefix.id, '可信前缀必须保留原 floor ID');
  assert.equal(graph.floors[0].narrativeGeneration, oldGeneration);
  assert.equal(graph.floors[0].narrativeGeneration, graph.root.narrativeGeneration);

  const state = await h.runtime.extractFloor(prefix.id, { analyzeState: false });
  assert.equal(state.rememberedCount, 1, JSON.stringify(state.lastExtractorError));
  assert.equal(state.lastExtractorError, null);
  graph = await h.store.readReachable();
  const memory = graph.floorMemories.find(item => item.floorId === prefix.id);
  const memoryUser = graph.entities.find(item => item.specialRole === 'user' && item.firstSeenFloorId === prefix.id);
  assert.ok(memory && memoryUser);
  assert.equal(memory.narrativeGeneration, prefix.narrativeGeneration);
  assert.equal(memoryUser.narrativeGeneration, prefix.narrativeGeneration);
  assert.equal(graph.run.narrativeGeneration, graph.root.narrativeGeneration);
  assert.equal(graph.checkpoint.narrativeGeneration, graph.root.narrativeGeneration);
  assert.equal(memory.narrativeGeneration, graph.root.narrativeGeneration);
});

test('提取期间 root revision 实质变化按 stale 丢弃且零写入', async () => {
  let release, startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const h = harness({ utility: () => new Promise(resolve => {
    release = () => resolve({ jsonData: { summary: '不应提交的迟到摘要。' } });
    startedResolve();
  }) });
  await h.runtime.start();
  const pending = h.runtime.extractNext();
  await started;
  const rootRecord = h.backend.records.get(`chat-${CHAT}/v3-root`);
  rootRecord.revision += 1;
  const writesBeforeRelease = h.backend.calls.filter(call => call[0] === 'put').length;
  release();
  await pending;
  const state = h.runtime.getState();
  assert.equal(state.rememberedCount, 0);
  assert.equal(state.lastExtractorError.code, 'V3_MEMORY_STALE');
  assert.equal(h.backend.calls.filter(call => call[0] === 'put').length, writesBeforeRelease, 'stale 结果不得写记录或提交 root');
});

test('用户手工摘要在重提取后仍保持 effective summary 优先', async () => {
  const h = harness();
  let state = await h.runtime.start().then(() => h.runtime.extractNext());
  const floorId = state.floors[0].floorId;
  state = await h.runtime.editSummary(floorId, '用户修订摘要', '手工纠正');
  const editedId = state.floors[0].memoryId;
  state = await h.runtime.extractFloor(floorId);
  assert.equal(state.floors[0].summary, '用户修订摘要');
  assert.equal(state.floors[0].summarySource, 'user');
  assert.equal(state.floors[0].memory.supersedes, editedId);
});

test('CAS 冲突与聊天切换守卫仍使旧结果不可达，stale extractor 零写入', async () => {
  const conflict = harness();
  await conflict.runtime.start();
  const rootBefore = structuredClone(conflict.backend.records.get(`chat-${CHAT}/v3-root`));
  conflict.backend.setConflictRoot(true);
  let state = await conflict.runtime.extractNext();
  assert.equal(state.rememberedCount, 0);
  assert.deepEqual(conflict.backend.records.get(`chat-${CHAT}/v3-root`), rootBefore);
  assert.equal(state.lastExtractorError.code, 'V3_MEMORY_CAS_CONFLICT');

  let release, startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const stale = harness({ utility: () => new Promise(resolve => { release = () => resolve({ jsonData: { summary: '迟到摘要' } }); startedResolve(); }) });
  await stale.runtime.start();
  const pending = stale.runtime.extractNext();
  await started;
  stale.context.chatMetadata = { qianqianjie: { schemaVersion: 1, chatId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } };
  stale.context.chatId = 'host-other-chat';
  stale.context.chat = [user('另一聊天'), assistant('另一聊天正文')];
  stale.emit('CHAT_CHANGED');
  await new Promise(resolve => setImmediate(resolve));
  await waitFor(() => ['ready', 'uninitialized'].includes(stale.foundationRuntime.getState().status), '聊天切换后的地基未收敛');
  const writesBeforeStaleRelease = stale.backend.calls.filter(call => call[0] === 'put').length;
  release();
  await pending;
  state = stale.runtime.getState();
  assert.equal(state.rememberedCount, 0);
  assert.equal(state.lastExtractorError.code, 'V3_MEMORY_STALE');
  assert.equal(stale.backend.calls.filter(call => call[0] === 'put').length, writesBeforeStaleRelease, '聊天变化后的 extractor 迟到结果不得写记录或提交 root');
});

test('special user 部分持久化后中断不会阻塞同楼重试，后续楼复用正式 user', async () => {
  const h = harness({
    initialChat: [user('继续'), assistant('裴晚生提醒你带伞。'), assistant('裴晚生再次提醒你检查行李。')],
    utility: options => {
      const request = JSON.parse(options.taskMessages.at(-1).content);
      if (request.task === 'extractFloorSemantics') return { jsonData: { summary: '裴晚生提醒用户做好准备。', people: [{ name: '裴晚生' }, { name: '你', role: 'user' }], events: [{ title: '提醒', description: '裴晚生提醒用户做好准备。' }] } };
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await h.runtime.start();
  const floorId = h.runtime.getState().floors[0].floorId;
  h.backend.abortAfterNextPut((_key, data) => data?.recordType === 'entity' && data.specialRole === 'user');
  let state = await h.runtime.extractFloor(floorId, { analyzeState: false });
  assert.equal(state.rememberedCount, 0);
  assert.equal(state.lastExtractorError.code, 'V3_MEMORY_STALE');
  const orphanUsers = [...h.backend.records.values()].map(item => item.data).filter(item => item?.recordType === 'entity' && item.specialRole === 'user');
  assert.equal(orphanUsers.length, 1, '模拟中断后应留下一个不可达 user 记录');
  let graph = await h.store.readReachable();
  assert.equal(graph.entities.length, 0);
  assert.equal(graph.floorMemories.length, 0);

  state = await h.runtime.extractFloor(floorId, { analyzeState: false });
  assert.equal(state.rememberedCount, 1, JSON.stringify(state.lastExtractorError));
  assert.equal(state.lastExtractorError, null);
  graph = await h.store.readReachable();
  let reachableUsers = graph.entities.filter(item => item.specialRole === 'user');
  assert.equal(reachableUsers.length, 1);
  assert.equal(graph.floorMemories.length, 1);
  assert.notEqual(reachableUsers[0].id, orphanUsers[0].id, '重试批次不得争用不可达孤儿 ID');

  h.context.chat.push(user('legacy test anchor'));
  await h.runtime.refreshStatus();
  const secondFloor = h.runtime.getState().floors.find(item => item.floorId !== floorId);
  assert.ok(secondFloor);
  state = await h.runtime.extractFloor(secondFloor.floorId, { analyzeState: false });
  assert.equal(state.rememberedCount, 2, JSON.stringify(state.lastExtractorError));
  graph = await h.store.readReachable();
  reachableUsers = graph.entities.filter(item => item.specialRole === 'user');
  assert.equal(reachableUsers.length, 1, '后续楼必须复用正式可达 user');
  assert.equal(graph.floorMemories.length, 2);
});

test('安全诊断隐藏正文，完整诊断仅在明确调用时暴露', async () => {
  const target = { ...assistant('裴晚生提醒你带伞。'), variables: [{ stat_data: { 剧情秘密: '钟楼钥匙在书柜后' } }] };
  const h = harness({ initialChat: [user('继续'), target, assistant('用于确认上一楼稳定。')] });
  const state = await h.runtime.start().then(() => h.runtime.extractNext());
  const floorId = state.floors[0].floorId;
  const safe = h.runtime.copySafeDiagnostic(floorId);
  assert.doesNotMatch(safe, /canonicalContent|裴晚生提醒你带伞/);
  assert.doesNotMatch(safe, /"content": "继续"/);
  assert.doesNotMatch(safe, /钟楼钥匙在书柜后|剧情秘密|sourceVariableReference/);
  assert.match(safe, /已隐藏用户原文/);
  const full = h.runtime.copyFullDiagnostic(floorId);
  assert.match(full, /canonicalContent/);
  assert.match(full, /"content": "继续"/);
  assert.match(full, /钟楼钥匙在书柜后/);
});

test('foundation reload 单飞会消费运行中到达的尾部 ready，旧 epoch 读取不回写', async () => {
  const listeners = new Set();
  let foundationState = { status: 'uninitialized', stableCount: 0, pending: null, chatId: CHAT };
  const foundationRuntime = {
    start: async () => foundationState,
    refreshStatus: async () => foundationState,
    confirmLatest: async () => foundationState,
    setEnabled: async () => foundationState,
    bind: () => true,
    getState: () => foundationState,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const graph = count => ({
    status: 'ready', rootRevision: count, root: { chatId: CHAT, headCheckpointId: `head-${count}`, narrativeGeneration: GENERATION, capabilities: {} },
    checkpoint: { id: `head-${count}` }, run: null, floorMemories: [], entities: [], stateDeltas: [], currentStates: [], baseline: null,
    floors: Array.from({ length: count }, (_, index) => ({ id: `${String(index + 1).padStart(8, '0')}-0000-4000-8000-000000000000`, assistantSeq: index + 1, hostLocator: { messageIndex: index + 1 }, content: { canonicalFingerprint: `sha256:${String(index + 1).padStart(64, '0')}` } })),
  });
  let current = { status: 'uninitialized' };
  let blocked = false, releaseBlocked, blockedStartedResolve;
  const blockedStarted = new Promise(resolve => { blockedStartedResolve = resolve; });
  const store = {
    async readReachable() {
      const captured = structuredClone(current);
      if (blocked) {
        blocked = false;
        blockedStartedResolve();
        await new Promise(resolve => { releaseBlocked = resolve; });
      }
      return captured;
    },
    async readRecord() { return { status: 'missing' }; }, async putRecord() { return { status: 'saved' }; }, async commitRoot() { return { status: 'saved' }; },
    recordKey(record) { return `${record.recordType}-${record.id}`; }, invalidate() {},
  };
  const eventHandlers = new Map();
  const eventTypes = Object.fromEntries(['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED'].map(name => [name, name]));
  const eventSource = { on(name, listener) { const values = eventHandlers.get(name) ?? []; values.push(listener); eventHandlers.set(name, values); } };
  const generateTask = async () => ({});
  const runtime = createV3MemoryRuntime({ foundationRuntime, store, hostAdapter: {}, generateAnalysisTask: generateTask, generateUtilityTask: generateTask, isEnabled: true, logger: { warn() {} } });
  runtime.bind({ eventSource, eventTypes });
  await runtime.start();
  assert.equal(eventHandlers.has('CHARACTER_MESSAGE_RENDERED'), false);
  const emitHost = name => (eventHandlers.get(name) ?? []).forEach(listener => listener());
  const emitFoundation = status => {
    foundationState = { ...foundationState, status, headCheckpointId: current.root?.headCheckpointId ?? null, stableCount: current.floors?.length ?? 0 };
    for (const listener of [...listeners]) listener(foundationState);
  };

  current = graph(2);
  blocked = true;
  emitHost('MESSAGE_RECEIVED');
  emitFoundation('ready');
  await blockedStarted;

  current = graph(3);
  emitHost('MESSAGE_RECEIVED');
  emitFoundation('running');
  emitFoundation('ready');
  releaseBlocked();
  for (let attempt = 0; attempt < 100 && runtime.getState().stableCount !== 3; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  const state = runtime.getState();
  assert.equal(state.stableCount, 3);
  assert.equal(state.headCheckpointId, 'head-3');
  assert.equal(state.floors.at(-1).checkpointId, 'head-3');
  assert.equal(state.floors.at(-1).assistantSeq, 3);
});

test('召回选材中root推进，精确ready快照绕过另一次挂起刷新且不重复整图读', async () => {
  const seed = harness({ initialChat: [user('继续'), assistant('裴晚生提醒带伞。'), assistant('钟楼仍在等待。'), assistant('确认上一楼稳定。')] });
  await seed.runtime.start(); const floors = seed.runtime.getState().floors;
  await seed.runtime.extractFloor(floors[0].floorId, { analyzeState: false });
  let held = false, inspectCalls = 0, releaseInspect, markHeld;
  const heldStarted = new Promise(resolve => { markHeld = resolve; });
  const foundationRuntime = { ...seed.foundationRuntime, inspect: async () => { inspectCalls += 1; if (held) { markHeld(); await new Promise(resolve => { releaseInspect = resolve; }); } return seed.foundationRuntime.getState(); } };
  const task = async () => { throw new Error('准备不应请求模型'); };
  const memory = createV3MemoryRuntime({ foundationRuntime, store: seed.store, hostAdapter: seed.hostAdapter, generateAnalysisTask: task, generateUtilityTask: task, now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} } });
  await memory.start(); await waitFor(() => memory.getState().memorySyncStatus === 'idle');
  seed.context.chat.push(user('带伞')); seed.context.constants = { promptTypes: { IN_CHAT: 1 }, promptRoles: { SYSTEM: 0 } }; seed.context.setExtensionPrompt = () => {};
  let refresh, selects = 0, beforeCommitInspects = 0, beforeCommitReads = 0; const prepareOptions = [];
  const recall = createV3RecallRuntime({ store: seed.store, hostAdapter: seed.hostAdapter, prepareMemory: options => { prepareOptions.push(options); return memory.prepareCurrent(options); },
    selector: async options => {
      selects += 1; await seed.runtime.extractFloor(floors[1].floorId, { analyzeState: false }); await memory.refreshStatus({ preferCached: false });
      await waitFor(() => memory.getState().memorySyncStatus === 'idle'); held = true; refresh = memory.refreshStatus({ preferCached: false }); await heldStarted;
      beforeCommitInspects = inspectCalls; beforeCommitReads = seed.readReachableModes.length; return selectRecall(options);
    }, pluginVersion: 'test-ready-root', now: () => new Date(NOW), logger: { warn() {} } });
  let timer;
  try {
    const result = await Promise.race([recall.intercept(structuredClone(seed.context.chat), 12000, null, 'normal'), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('精确快照不应等挂起刷新')), 800); })]);
    assert.equal(selects, 1); assert.equal(inspectCalls, beforeCommitInspects); assert.equal(seed.readReachableModes.length, beforeCommitReads);
    assert.equal(prepareOptions.at(-1).preferCached, false); assert.equal(prepareOptions.at(-1).rootResult.status, 'ready');
    assert.ok(['ready', 'empty'].includes(result.lastRecall.status)); assert.equal(result.lastRecall.selectionStatus, 'completed');
  } finally { clearTimeout(timer); releaseInspect?.(); await refresh; }
  const rootResult = await seed.store.readRoot();
  for (const change of [{ revision: rootResult.revision + 1 }, { data: { ...rootResult.data, narrativeGeneration: 'different' } }, { data: { ...rootResult.data, headCheckpointId: 'different' } }, { data: { ...rootResult.data, chatId: 'different' } }]) {
    held = false; const before = inspectCalls; await memory.prepareCurrent({ preferCached: false, rootResult: { ...rootResult, ...change } }); assert.equal(inspectCalls, before + 1, '不匹配仍走fresh');
  }
});

test('CHAT_CHANGED 与 start 并发发布同版本 foundation 快照时共用后台同步并收敛 coverage', async () => {
  const graph = {
    status: 'ready', rootRevision: 1,
    root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: '33333333-3333-4333-8333-333333333333', stableBoundary: { assistantSeq: 0 } },
    floors: [], floorMemories: [], entities: [], indexes: [], stateDeltas: [],
  };
  let foundationState = { status: 'idle' };
  let foundationListener = null;
  const foundationRuntime = {
    bind() {}, start() {}, refreshStatus() {}, confirmLatest() {}, setEnabled() {},
    getState: () => foundationState,
    getReachable: () => graph,
    subscribe(listener) { foundationListener = listener; },
    async inspect() {
      foundationState = { status: 'ready', chatId: CHAT, stableCount: 0 };
      foundationListener(foundationState);
      return foundationState;
    },
  };
  let reads = 0;
  const store = {
    async readReachable() { reads += 1; return structuredClone(graph); },
    readRecord() {}, putRecord() {}, commitRoot() {}, recordKey() {}, invalidate() {},
  };
  const handlers = new Map();
  const hostAdapter = { snapshot: () => ({ context: { chatMetadata: { qianqianjie: { chatId: CHAT } } }, chat: [], chatId: 'host-chat' }) };
  const runtime = createV3MemoryRuntime({ foundationRuntime, store, hostAdapter, generateAnalysisTask: async () => {}, generateUtilityTask: async () => {} });
  runtime.bind({ eventSource: { on(name, listener) { handlers.set(name, listener); } }, eventTypes: { CHAT_CHANGED: 'chat' } });

  handlers.get('chat')();
  await runtime.start();
  await new Promise(resolve => setImmediate(resolve));
  const state = runtime.getState();
  const prepared = await runtime.prepareCurrent();
  assert.equal(reads, 0, 'ready foundation 已发布的完整快照应直接复用，不再并发重复读图');
  assert.equal(state.memorySnapshotStatus, 'ready');
  assert.equal(state.memorySyncStatus, 'idle');
  assert.equal(state.summaryCoverageStatus, 'caughtUp');
  assert.equal(state.memorySyncError, null);
  assert.equal(prepared.reachable, graph, '同版本后台任务必须保持绑定同一份共享快照');
});

test('生产式冷启动等待真实身份认领后只读一次完整图并恢复已保存摘要', async () => {
  const seeded = harness({ automation: { enabled: false, batchSize: 1 } });
  let seededState = await seeded.runtime.start();
  seededState = await seeded.runtime.extractFloor(seededState.floors[0].floorId, { analyzeState: false });
  const expectedSummary = seededState.floors[0].summary;
  seeded.backend.records.set(`${CHAT_IDENTITY_COLLECTION}/binding-${CHAT}`, {
    revision: 1,
    data: {
      schemaVersion: 1, kind: 'qqj-chat-identity-binding', chatId: CHAT,
      owner: { hostChatId: seeded.context.chatId, characterLocator: 'character.png', personaLocator: 'persona.png' },
      state: 'ready', sourceChatId: null, createdAt: NOW, updatedAt: NOW,
    },
  });
  seeded.backend.calls.splice(0);

  let releaseBinding, markBindingStarted, held = true;
  const bindingStarted = new Promise(resolve => { markBindingStarted = resolve; });
  seeded.backend.setBeforeGet(async ({ collection, key }) => {
    if (!held || collection !== CHAT_IDENTITY_COLLECTION || key !== `binding-${CHAT}`) return;
    held = false; markBindingStarted();
    await new Promise(resolve => { releaseBinding = resolve; });
  });
  const context = {
    ...seeded.context,
    chat: structuredClone(seeded.context.chat),
    chatMetadata: structuredClone(seeded.context.chatMetadata),
  };
  const handlers = new Map();
  context.eventSource = { on(name, listener) { const values = handlers.get(name) ?? []; values.push(listener); handlers.set(name, values); } };
  const hostAdapter = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => context } } });
  const identityCoordinator = createChatIdentityCoordinator({
    client: seeded.backend.client,
    persist: async (raw, chatId) => { raw.chatMetadata.qianqianjie = { schemaVersion: 1, chatId }; return true; },
    freshUuid: uuidFactory(),
    now: () => new Date(NOW),
  });
  const session = createChatSession({ contextProvider: () => context, identityCoordinator });
  const store = createFoundationStore({ client: seeded.backend.client, contextProvider: () => session.identity() });
  let scanCalls = 0;
  const foundationRuntime = createFoundationRuntime({
    hostAdapter, store, contextProvider: () => context, prepareSession: () => session.prepare(),
    deferChatChangeRefreshUntilPrepared: true, scanCandidates: (...args) => { scanCalls += 1; return legacyScanner(...args); },
    newUuid: uuidFactory(), now: () => new Date(NOW), logger: { warn() {} },
  });
  let modelCalls = 0;
  const rejectModel = async () => { modelCalls += 1; throw new Error('冷启动只读不得调用模型'); };
  const memoryRuntime = createV3MemoryRuntime({
    foundationRuntime, store, hostAdapter, generateAnalysisTask: rejectModel, generateUtilityTask: rejectModel,
    automationSettings: () => ({ enabled: false, batchSize: 1 }), now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} },
  });
  const lifecycle = createPluginLifecycle({
    session,
    onPrepared: async ({ isCurrent }) => { if (isCurrent()) await memoryRuntime.start(); },
    getUi: () => null,
    logger: { warn() {} },
  });
  lifecycle.bind({ eventSource: context.eventSource, eventTypes: context.eventTypes });
  memoryRuntime.bind({ eventSource: context.eventSource, eventTypes: context.eventTypes });

  for (const listener of handlers.get('CHAT_CHANGED') ?? []) listener();
  await bindingStarted;
  assert.equal(memoryRuntime.getState().memorySnapshotStatus, 'syncing');
  assert.equal(memoryRuntime.getState().memorySyncStatus, 'syncing');
  assert.equal(foundationRuntime.getState().status, 'idle');
  assert.equal(scanCalls, 0, '身份完成前不得抢跑聊天扫描');
  assert.equal(seeded.backend.calls.some(call => call[1] === `chat-${CHAT}`), false, '身份完成前不得读取聊天记忆图');
  assert.equal(modelCalls, 0);

  releaseBinding();
  await waitFor(() => memoryRuntime.getState().memorySnapshotStatus === 'ready' && memoryRuntime.getState().memorySyncStatus === 'idle', '身份完成后冷启动记忆未收敛');
  const state = memoryRuntime.getState();
  assert.equal(state.floors[0].summary, expectedSummary);
  assert.equal(modelCalls, 0);
  assert.equal(scanCalls, 1, '身份完成后只扫描一次当前聊天');
  assert.equal(seeded.backend.calls.filter(call => call[0] === 'get' && call[1] === `chat-${CHAT}` && call[2] === 'v3-root').length, 1, '完整图 root 只应读取一次');
  assert.equal(seeded.backend.calls.filter(call => call[0] === 'get' && call[1] === `chat-${CHAT}` && call[2].startsWith('v3-checkpoint-')).length, 1, '完整图 checkpoint 只应读取一次');
});

test('后台同步进行中只复用同版本同模式任务，不同 root 版本仍独立接管并收敛', async () => {
  const seed = harness();
  let seeded = await seed.runtime.start();
  seeded = await seed.runtime.extractFloor(seeded.floors[0].floorId, { analyzeState: false });
  const firstGraph = await seed.store.readReachable({ mode: 'projection' });
  let foundationGraph = firstGraph;
  let foundationState = { ...seed.foundationRuntime.getState(), status: 'ready', foundationStatus: 'ready' };
  let releaseFirst;
  let markFirstStarted;
  let anchorCalls = 0;
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve; });
  const foundationRuntime = {
    bind() {}, start() {}, refreshStatus() {}, confirmLatest() {}, setEnabled() {},
    getState: () => foundationState,
    getReachable: () => foundationGraph,
    inspect: async () => foundationState,
  };
  const runtime = createV3MemoryRuntime({
    foundationRuntime,
    store: seed.store,
    hostAdapter: seed.hostAdapter,
    generateAnalysisTask: async () => {},
    generateUtilityTask: async () => {},
    persistAnchors: async () => {
      anchorCalls += 1;
      if (anchorCalls === 1) {
        markFirstStarted();
        await new Promise(resolve => { releaseFirst = resolve; });
      }
    },
    logger: { warn() {} },
  });

  const starting = runtime.start();
  await firstStarted;
  foundationGraph = structuredClone(firstGraph);
  await runtime.refreshStatus();
  assert.equal(anchorCalls, 1, '同版本不同对象不得重复启动挂标与 coverage 同步');

  const secondGraph = structuredClone(firstGraph);
  secondGraph.rootRevision += 1;
  secondGraph.root.headCheckpointId = '44444444-4444-4444-8444-444444444444';
  foundationGraph = secondGraph;
  foundationState = { ...foundationState, headCheckpointId: secondGraph.root.headCheckpointId };
  await runtime.refreshStatus();
  await waitFor(() => anchorCalls === 2 && runtime.getState().memorySyncStatus === 'idle', '新 root 版本未接管后台同步');
  releaseFirst();
  await starting;
  const prepared = await runtime.prepareCurrent();
  assert.equal(prepared.reachable, secondGraph);
  assert.equal(prepared.reachable.rootRevision, firstGraph.rootRevision + 1);
  assert.equal(runtime.getState().memorySyncStatus, 'idle');
  assert.equal(runtime.getState().memorySyncError, null);
});

test('记忆准备只在同 chat/epoch 合并，A 聊迟到不会覆盖已独立完成的 B 聊', async () => {
  const otherChat = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const graph = (chatId, head) => ({
    status: 'ready', rootRevision: 1,
    root: { chatId, headCheckpointId: head, narrativeGeneration: GENERATION, capabilities: {} },
    checkpoint: { id: head }, run: null, floors: [], floorMemories: [], entities: [], stateDeltas: [], currentStates: [], baseline: null,
  });
  let hostChatId = CHAT;
  let foundationReachable = graph(CHAT, 'head-a');
  let foundationState = { status: 'ready', foundationStatus: 'ready' };
  let inspectCalls = 0, releaseA, startA;
  const aStarted = new Promise(resolve => { startA = resolve; });
  const foundationRuntime = {
    start: async () => foundationState,
    async inspect() {
      inspectCalls += 1;
      const capturedChatId = hostChatId;
      if (capturedChatId === CHAT) {
        startA();
        await new Promise(resolve => { releaseA = resolve; });
      }
      return { ...foundationState, chatId: capturedChatId };
    },
    refreshStatus: async () => foundationState,
    confirmLatest: async () => foundationState,
    setEnabled: async () => foundationState,
    bind: () => true,
    getState: () => foundationState,
    getReachable: () => foundationReachable,
  };
  const store = {
    async readReachable() { throw new Error('provided reachable 不应重复读取'); },
    async readRecord() { return { status: 'missing' }; }, async putRecord() { return { status: 'saved' }; }, async commitRoot() { return { status: 'saved' }; },
    recordKey(record) { return `${record.recordType}-${record.id}`; }, invalidate() {},
  };
  const handlers = new Map();
  const eventSource = { on(name, listener) { const values = handlers.get(name) ?? []; values.push(listener); handlers.set(name, values); } };
  const hostAdapter = { snapshot: () => ({ context: { chatMetadata: { qianqianjie: { chatId: hostChatId } } }, chat: [] }) };
  const task = async () => ({});
  const runtime = createV3MemoryRuntime({ foundationRuntime, store, hostAdapter, generateAnalysisTask: task, generateUtilityTask: task, logger: { warn() {} } });
  runtime.bind({ eventSource, eventTypes: { CHAT_CHANGED: 'CHAT_CHANGED' } });

  const firstA = runtime.prepareCurrent({ preferCached: false });
  const secondA = runtime.prepareCurrent({ preferCached: false });
  await aStarted;
  assert.equal(inspectCalls, 1, '同 A 聊并发准备必须共用一次 inspect');

  hostChatId = otherChat;
  foundationReachable = graph(otherChat, 'head-b');
  for (const listener of handlers.get('CHAT_CHANGED') ?? []) listener();
  const preparedB = await runtime.prepareCurrent({ preferCached: false });
  assert.equal(preparedB.status, 'ready');
  assert.equal(preparedB.reachable.root.chatId, otherChat);
  assert.equal(inspectCalls, 2, '切 B 聊必须启动自己的 inspect');

  releaseA();
  await Promise.all([firstA, secondA]);
  const finalB = await runtime.prepareCurrent({ preferCached: true });
  assert.equal(finalB.reachable.root.chatId, otherChat);
  assert.equal(finalB.reachable.root.headCheckpointId, 'head-b');
  await waitFor(() => runtime.getState().memorySyncStatus !== 'syncing', 'B 聊后台同步未收敛');
  assert.equal(runtime.getState().memorySyncStatus, 'idle');
});

test('同 chat 的 CHAT_RENAMED/重复 CHAT_CHANGED 只触发同步，已验证摘要快照不清空', async () => {
  const h = harness();
  let state = await h.runtime.start();
  state = await h.runtime.extractFloor(state.floors[0].floorId, { analyzeState: false });
  const expectedSummary = state.floors[0].summary;
  for (const event of ['CHAT_RENAMED', 'CHAT_CHANGED']) {
    h.emit(event);
    const during = h.runtime.getState();
    assert.equal(during.memorySnapshotStatus, 'ready', event);
    assert.equal(during.floors[0].summary, expectedSummary, event);
    assert.equal(during.memorySyncStatus, 'syncing', event);
  }
});

test('冷启动未读完即首次 MESSAGE_SENT 时召回等待同一准备，可见楼由宿主正文负责且后续发送不承担恢复', async () => {
  const initialChat = [
    user('开始'),
    assistant('钟楼密钥旧约。'),
    assistant('第二段已保存旧事。'),
    assistant('近期正文甲。'),
    assistant('近期正文乙。'),
    assistant('尾部待确认正文。'),
  ];
  const seed = harness({
    initialChat,
    automation: { enabled: false, batchSize: 1 },
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: JSON.parse(options.taskMessages[0].content).payload.canonicalContent } }
      : { jsonData: { noMaterialChange: true } },
  });
  await seed.runtime.start();
  const seedFloors = seed.runtime.getState().floors;
  await seed.runtime.extractFloor(seedFloors[0].floorId, { analyzeState: false });
  await seed.runtime.extractFloor(seedFloors[1].floorId, { analyzeState: false });

  const cold = harness({
    sharedBackend: seed.backend,
    sharedContext: seed.context,
    automation: { enabled: false, batchSize: 1 },
    utility: () => { throw new Error('冷启动准备不得调用摘要/CSE模型'); },
  });
  let releaseRead, markReadStarted;
  const readStarted = new Promise(resolve => { markReadStarted = resolve; });
  let held = true;
  cold.backend.setBeforeGet(async ({ key }) => {
    if (held && key === 'v3-root') {
      held = false;
      markReadStarted();
      await new Promise(resolve => { releaseRead = resolve; });
    }
  });
  const starting = cold.runtime.start();
  await readStarted;
  cold.context.chat.push(user('请继续说钟楼密钥。'));
  cold.context.constants = { promptTypes: { IN_CHAT: 1 }, promptRoles: { SYSTEM: 0 } };
  cold.context.setExtensionPrompt = () => {};
  const firstUserIndex = cold.context.chat.length - 1;
  cold.emit('MESSAGE_SENT', firstUserIndex);
  let selectorCalls = 0, abortCalls = 0;
  const recall = createV3RecallRuntime({
    store: cold.store,
    hostAdapter: cold.hostAdapter,
    prepareMemory: options => cold.runtime.prepareCurrent(options),
    selector: input => { selectorCalls += 1; return selectRecall(input); },
    pluginVersion: '0.1.8-test',
    notifyUser: () => {},
    now: () => new Date(NOW),
    logger: { warn() {} },
  });
  const firstRecall = recall.intercept(structuredClone(cold.context.chat), 12000, value => { if (value === true) abortCalls += 1; }, 'normal');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(selectorCalls, 0, '首次发送应等待正在进行的冷启动准备');
  releaseRead();
  const first = await firstRecall;
  await starting;
  assert.equal(abortCalls, 0);
  assert.equal(selectorCalls, 1);
  assert.equal(first.lastRecall.status, 'empty', JSON.stringify(first.lastRecall));
  assert.doesNotMatch(first.lastRecall.injectionText, /钟楼密钥旧约/, '未隐藏楼由宿主正文负责，不重复注入其已存摘要');
  assert.equal(cold.calls.length, 0, '冷启动与召回不得触发摘要/CSE模型');

  cold.context.chat.push(user('第二次仍问钟楼密钥。'));
  const secondUserIndex = cold.context.chat.length - 1;
  cold.emit('MESSAGE_SENT', secondUserIndex);
  const second = await recall.intercept(structuredClone(cold.context.chat), 12000, value => { if (value === true) abortCalls += 1; }, 'normal');
  assert.equal(second.lastRecall.status, 'empty');
  assert.equal(selectorCalls, 2);
  assert.equal(abortCalls, 0);
  assert.equal(cold.calls.length, 0);
});

test('真实 store 冷读只为召回隔离坏 CSE，摘要仍可用且 strict 读取与坏记录保持不变', async () => {
  async function seededGraph() {
    const seeded = harness({
      modernAnchors: true,
      initialChat: [assistant('裴晚生在钟楼交付一把旧雨伞。'), user('请回忆钟楼旧雨伞。'), assistant('尚未稳定的尾楼。')],
      utility: options => {
        const request = JSON.parse(options.taskMessages[0].content);
        if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) return {
          jsonData: {
            summary: '裴晚生在钟楼交付一把旧雨伞。',
            people: [{ name: '裴晚生' }],
            actions: [{ actor: '裴晚生', action: '交付钟楼旧雨伞', completion: 'completed' }],
          },
        };
        const subject = request.payload.trackedSubjects[0]?.name;
        return { jsonData: subject ? { subjects: [{ subject, situational: [{ text: '记得钟楼旧雨伞', reason: '本楼明确交付', visibility: 'observable' }] }] } : { noMaterialChange: true } };
      },
    });
    await seeded.runtime.start();
    await seeded.runtime.extractNext();
    const reachable = await seeded.store.readReachable({ mode: 'runtime' });
    assert.equal(reachable.stateDeltas.length, 1);
    assert.equal(reachable.currentStates.length, 1);
    return { seeded, reachable };
  }

  const currentCase = await seededGraph();
  const currentKey = `chat-${CHAT}/v3-current-state-${currentCase.reachable.currentStates[0].id}`;
  const currentEnvelope = currentCase.seeded.backend.records.get(currentKey);
  currentEnvelope.data.fingerprint = `sha256:${'0'.repeat(64)}`;
  const putsBeforeCurrentRecall = currentCase.seeded.backend.calls.filter(call => call[0] === 'put').length;
  await assert.rejects(currentCase.seeded.store.readReachable({ mode: 'projection' }), /V3_CSE_GRAPH_CURRENT_FINGERPRINT_INVALID/);

  currentCase.seeded.context.chat[0].is_hidden = true;
  currentCase.seeded.context.constants = { promptTypes: { IN_CHAT: 1 }, promptRoles: { SYSTEM: 0 } };
  const prompts = [];
  currentCase.seeded.context.setExtensionPrompt = (...args) => prompts.push(args);
  const cold = harness({
    modernAnchors: true,
    sharedBackend: currentCase.seeded.backend,
    sharedContext: currentCase.seeded.context,
    utility: () => { throw new Error('坏 CSE 的只读召回不得调用模型'); },
  });
  let selectedSource = null;
  const recall = createV3RecallRuntime({
    store: cold.store,
    hostAdapter: cold.hostAdapter,
    prepareMemory: options => cold.runtime.prepareCurrent(options),
    selector: input => { selectedSource = input.source; return selectRecall(input); },
    pluginVersion: '0.1.8-test',
    now: () => new Date(NOW),
    logger: { warn() {} },
  });
  const recalled = await recall.intercept([structuredClone(cold.context.chat[1])], 12000, null, 'normal');
  assert.equal(recalled.lastRecall.status, 'ready', JSON.stringify(recalled.lastRecall));
  assert.match(recalled.lastRecall.injectionText, /裴晚生在钟楼交付一把旧雨伞/);
  assert.ok(selectedSource.currentState.some(subject => subject.situational.some(item => item.text === '记得钟楼旧雨伞')), `CurrentState 损坏时必须从合法 delta 重放状态：${JSON.stringify(selectedSource.currentState)}`);
  assert.deepEqual(selectedSource.degradedReasons, [], '成功重放合法 delta 不应误报 CSE 整体不可用');
  assert.ok(prompts.some(call => call[1].includes('裴晚生在钟楼交付一把旧雨伞')));
  assert.equal(cold.calls.length, 0);
  assert.equal(currentCase.seeded.backend.calls.filter(call => call[0] === 'put').length, putsBeforeCurrentRecall, '只读降级不得写回或提交');
  assert.equal(currentCase.seeded.backend.records.get(currentKey).data.fingerprint, `sha256:${'0'.repeat(64)}`);
  await assert.rejects(cold.store.readReachable({ mode: 'runtime' }), /V3_CSE_GRAPH_CURRENT_FINGERPRINT_INVALID/);

  const deltaCase = await seededGraph();
  const deltaKey = `chat-${CHAT}/v3-state-delta-${deltaCase.reachable.stateDeltas[0].id}`;
  deltaCase.seeded.backend.records.get(deltaKey).data.subjectSnapshots[0].subjectEntityId = '99999999-9999-4999-8999-999999999999';
  const putsBeforeDeltaRecall = deltaCase.seeded.backend.calls.filter(call => call[0] === 'put').length;
  await assert.rejects(deltaCase.seeded.store.readReachable({ mode: 'projection' }), /V3_CSE_GRAPH_ENTITY_REF_INVALID/);
  const deltaSource = await readRecallSource({ store: deltaCase.seeded.store, now: () => new Date(NOW) });
  assert.equal(deltaSource.status, 'ready');
  assert.deepEqual(deltaSource.degradedReasons, ['cseReplayUnavailable']);
  assert.deepEqual(deltaSource.currentState, []);
  assert.deepEqual(deltaSource.cseChanges, []);
  const deltaSelection = selectRecall({ source: deltaSource, queryContext: { text: '钟楼旧雨伞', latestUserText: '钟楼旧雨伞', messageCount: 1 }, contextSize: 12000 });
  assert.match(deltaSelection.injectionText, /裴晚生在钟楼交付一把旧雨伞/);
  assert.equal(deltaCase.seeded.backend.calls.filter(call => call[0] === 'put').length, putsBeforeDeltaRecall);
  assert.equal(deltaCase.seeded.backend.records.get(deltaKey).data.subjectSnapshots[0].subjectEntityId, '99999999-9999-4999-8999-999999999999');

  const coreCase = await seededGraph();
  const floorKey = `chat-${CHAT}/v3-floor-${coreCase.reachable.floors[0].id}`;
  coreCase.seeded.backend.records.get(floorKey).data.chatId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const putsBeforeCoreRead = coreCase.seeded.backend.calls.filter(call => call[0] === 'put').length;
  await assert.rejects(readRecallSource({ store: coreCase.seeded.store, now: () => new Date(NOW) }), /V3_FLOOR_INVALID/);
  assert.equal(coreCase.seeded.backend.calls.filter(call => call[0] === 'put').length, putsBeforeCoreRead, '核心归属错误不得被召回容错吞掉或修写');

  const cseIdentityCase = await seededGraph();
  const identityDeltaKey = `chat-${CHAT}/v3-state-delta-${cseIdentityCase.reachable.stateDeltas[0].id}`;
  cseIdentityCase.seeded.backend.records.get(identityDeltaKey).data.chatId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const putsBeforeIdentityRead = cseIdentityCase.seeded.backend.calls.filter(call => call[0] === 'put').length;
  await assert.rejects(readRecallSource({ store: cseIdentityCase.seeded.store, now: () => new Date(NOW) }), /V3_STATEDELTA_INVALID:chatId/);
  assert.equal(cseIdentityCase.seeded.backend.calls.filter(call => call[0] === 'put').length, putsBeforeIdentityRead, 'CSE 记录跨聊天也不得被当成普通 CSE 损坏降级');
});

test('后台 load 失败后成功刷新清旧读取错误并保留摘要，具体楼层失败不被清除', async () => {
  const seed = harness();
  let seedState = await seed.runtime.start();
  const floorId = seedState.floors[0].floorId;
  seedState = await seed.runtime.extractFloor(floorId, { analyzeState: false });
  const expectedSummary = seedState.floors[0].summary;
  const graph = await seed.store.readReachable({ mode: 'runtime' });

  const foundationListeners = new Set();
  const foundationState = { ...seed.foundationRuntime.getState(), status: 'ready', foundationStatus: 'ready' };
  const foundationRuntime = {
    start: async () => foundationState,
    refreshStatus: async () => foundationState,
    confirmLatest: async () => foundationState,
    setEnabled: async () => foundationState,
    bind: () => true,
    getState: () => foundationState,
    subscribe(listener) { foundationListeners.add(listener); return () => foundationListeners.delete(listener); },
  };
  let failNextLoad = false;
  const store = {
    async readReachable() {
      if (failNextLoad) {
        failNextLoad = false;
        throw Object.assign(new Error('当前聊天身份尚未完成后端认领'), { code: 'CHAT_SESSION_NOT_READY' });
      }
      return graph;
    },
    readRecord: (...args) => seed.store.readRecord(...args),
    putRecord: (...args) => seed.store.putRecord(...args),
    commitRoot: (...args) => seed.store.commitRoot(...args),
    recordKey: (...args) => seed.store.recordKey(...args),
    invalidate: (...args) => seed.store.invalidate(...args),
  };
  const handlers = new Map();
  const eventTypes = { MESSAGE_RECEIVED: 'MESSAGE_RECEIVED' };
  const eventSource = { on(name, listener) { const values = handlers.get(name) ?? []; values.push(listener); handlers.set(name, values); } };
  const generateTask = async () => { throw Object.assign(new Error('真实楼层提取失败'), { code: 'V3_EXTRACTOR_FAILED' }); };
  const runtime = createV3MemoryRuntime({ foundationRuntime, store, hostAdapter: seed.hostAdapter, generateAnalysisTask: generateTask, generateUtilityTask: generateTask, isEnabled: true, now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} } });
  runtime.bind({ eventSource, eventTypes });
  await runtime.start();

  failNextLoad = true;
  for (const listener of handlers.get('MESSAGE_RECEIVED') ?? []) listener(seed.context.chat.length - 1);
  for (const listener of foundationListeners) listener(foundationState);
  await waitFor(() => runtime.getState().lastExtractorError?.phase === 'load');
  const failed = runtime.getState();
  assert.equal(failed.memorySnapshotStatus, 'ready');
  assert.equal(failed.memorySyncStatus, 'error');
  assert.equal(failed.lastExtractorError.floorId, null);
  assert.equal(failed.lastExtractorError.code, 'CHAT_SESSION_NOT_READY');
  assert.equal(failed.floors[0].summary, expectedSummary, '读取失败期间不得丢掉已加载摘要');

  await runtime.refreshStatus();
  await waitFor(() => runtime.getState().lastExtractorError === null);
  const recovered = runtime.getState();
  assert.equal(recovered.memorySnapshotStatus, 'ready');
  assert.equal(recovered.lastExtractorError, null, '成功读取应清除已经恢复的无楼层 load 错误');
  assert.equal(recovered.floors[0].summary, expectedSummary, '成功刷新后摘要应保持');

  const extractionFailed = await runtime.extractFloor(floorId, { analyzeState: false });
  assert.equal(extractionFailed.lastExtractorError?.floorId, floorId);
  assert.equal(extractionFailed.lastExtractorError?.phase, 'retryableError');
  const afterOrdinaryLoad = await runtime.refreshStatus();
  assert.equal(afterOrdinaryLoad.lastExtractorError?.floorId, floorId);
  assert.equal(afterOrdinaryLoad.lastExtractorError?.phase, 'retryableError', '普通成功 load 不得清除具体楼层提取失败');
});

test('冷页 foundation needsReview 只读呈现同聊天已存摘要且零挂标写，恢复 ready 后正常收敛，异聊天不采纳', async () => {
  const seed = harness();
  let seeded = await seed.runtime.start();
  seeded = await seed.runtime.extractFloor(seeded.floors[0].floorId, { analyzeState: false });
  const expectedSummary = seeded.floors[0].summary;
  const graph = await seed.store.readReachable({ mode: 'projection' });
  const listeners = new Set();
  let foundationState = { ...seed.foundationRuntime.getState(), status: 'needsReview', foundationStatus: 'ready', chatId: CHAT, reviewReason: { code: 'fingerprintMismatch', assistantSeq: 1, expectedCount: 1, actualCount: 1 }, lastError: null };
  const foundationRuntime = {
    start: async () => foundationState,
    inspect: async () => foundationState,
    refreshStatus: async () => foundationState,
    confirmLatest: async () => foundationState,
    setEnabled: async () => foundationState,
    bind: () => true,
    getState: () => foundationState,
    getReachable: () => graph,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  let anchorWrites = 0;
  const task = async () => { throw new Error('只读加载不得调用模型'); };
  const runtime = createV3MemoryRuntime({ foundationRuntime, store: seed.store, hostAdapter: seed.hostAdapter, generateAnalysisTask: task, generateUtilityTask: task, persistAnchors: async () => { anchorWrites += 1; }, now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} } });
  runtime.bind({ eventSource: seed.context.eventSource, eventTypes: seed.context.eventTypes });
  const reviewed = await runtime.start();
  assert.equal(reviewed.status, 'needsReview');
  assert.equal(reviewed.memorySnapshotStatus, 'ready');
  assert.equal(reviewed.memorySyncStatus, 'needsReview');
  assert.equal(reviewed.floors[0].summary, expectedSummary);
  assert.equal(reviewed.reviewReason.code, 'fingerprintMismatch');
  assert.equal(anchorWrites, 0, 'needsReview 只读采纳不得写消息挂标');

  foundationState = { ...foundationState, status: 'ready', reviewReason: null };
  const recovered = await runtime.refreshStatus();
  await waitFor(() => runtime.getState().memorySyncStatus !== 'syncing');
  assert.equal(recovered.memorySnapshotStatus, 'ready');
  assert.equal(runtime.getState().memorySyncStatus, 'idle');
  assert.equal(runtime.getState().floors[0].summary, expectedSummary);

  const otherFoundation = { ...foundationRuntime, getState: () => ({ ...foundationState, status: 'needsReview', chatId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }), inspect: async () => ({ ...foundationState, status: 'needsReview', chatId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }) };
  const other = createV3MemoryRuntime({ foundationRuntime: otherFoundation, store: seed.store, hostAdapter: seed.hostAdapter, generateAnalysisTask: task, generateUtilityTask: task, persistAnchors: async () => { anchorWrites += 1; }, now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} } });
  const rejected = await other.start();
  assert.equal(rejected.memorySnapshotStatus, 'unavailable');
  assert.equal(rejected.floors.length, 0, '不同聊天的 foundation cache 不得呈现');
});

test('已有聊天启动、绑定、面板刷新与开启自动维护都只检测；按钮授权后连续重建并 flush 尾批', async () => {
  const h = harness({
    initialChat: [user('开始'), ...Array.from({ length: 6 }, (_, index) => assistant(`历史 AI ${index + 1}`))],
    automation: { enabled: true, batchSize: 2 },
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: `摘要-${JSON.parse(options.taskMessages[0].content).payload.canonicalContent}` } }
      : { jsonData: { noMaterialChange: true } },
  });
  await h.runtime.start();
  await h.runtime.refreshStatus();
  await h.runtime.refreshAutomation();
  h.emit('CHAT_CHANGED');
  await h.foundationRuntime.refreshStatus();
  await h.runtime.refreshStatus();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.calls.length, 0);
  assert.equal(h.runtime.getState().rebuildStatus, 'pendingRebuild');
  assert.equal(h.runtime.shouldBlockMainGeneration(), false, '仅检测到历史欠账不得锁主生成');
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => h.runtime.getState().lastAutoMemory?.status === 'completed' && !h.runtime.getState().activeAutoMemory,
    () => `历史后台重建未追平 ${JSON.stringify({ state: h.runtime.getState().lastAutoMemory, active: h.runtime.getState().activeAutoMemory, calls: h.calls.map(call => JSON.parse(call.taskMessages[0].content).task) })}`);
  const state = h.runtime.getState();
  assert.equal(state.lastAutoMemory.mode, 'historical');
  assert.equal(state.lastAutoMemory.processed, 5);
  assert.equal(state.rebuildStatus, 'waitingRealtime', '已追平全部登记楼后，唯一未登记尾 AI 仍等待下一条 user 确认');
  assert.equal(state.rebuildCompletedCount, 5);
  assert.equal(state.rebuildTotalCount, 5);
  assert.equal(h.runtime.shouldBlockMainGeneration(), false, '历史重建完成后必须释放主生成门禁');
  const summaryCalls = h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT);
  assert.equal(summaryCalls.length, 5, '历史续跑恢复为逐楼调用，一楼一次摘要请求');
  assert.deepEqual(summaryCalls.map(call => {
    const request = JSON.parse(call.taskMessages[0].content);
    assert.equal(Object.hasOwn(request, 'floors'), false, '单楼请求不得携带批量 floors 包');
    return request.payload.canonicalContent;
  }), Array.from({ length: 5 }, (_, index) => `历史 AI ${index + 1}`));
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 5);
  const cseContents = h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).map(call => JSON.parse(call.taskMessages[0].content).payload.canonicalContent);
  assert.deepEqual(cseContents, Array.from({ length: 5 }, (_, index) => `历史 AI ${index + 1}`));
});

test('重建展示进度按各楼 memory/delta 独立完成计数，摘要重提不使后楼失效', async () => {
  const h = harness({
    initialChat: [user('开始'), assistant('历史一'), assistant('历史二'), assistant('历史三'), assistant('待确认尾楼')],
    automation: { enabled: true, batchSize: 3 },
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: `摘要-${JSON.parse(options.taskMessages[0].content).payload.canonicalContent}` } }
      : { jsonData: { noMaterialChange: true } },
  });
  const progress = [];
  const unsubscribe = h.runtime.subscribe(state => {
    if (state.rebuildTotalCount !== 3) return;
    const value = [state.rebuildCompletedCount, state.rebuildNextAssistantSeq];
    if (!progress.length || progress.at(-1)[0] !== value[0] || progress.at(-1)[1] !== value[1]) progress.push(value);
  });

  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => ['caughtUp', 'waitingRealtime'].includes(h.runtime.getState().rebuildStatus));
  unsubscribe();
  let state = h.runtime.getState();
  assert.deepEqual(progress, [[0, 1], [1, 2], [2, 3], [3, null]]);
  assert.deepEqual(state.cseFloors.map(item => item.status), ['noChange', 'noChange', 'noChange']);
  assert.equal(state.rebuildCompletedCount, 3);
  assert.equal(state.rebuildTotalCount, 3);
  assert.equal(state.rebuildNextAssistantSeq, null);

  const secondFloorId = state.floors[1].floorId;
  const oldMemoryId = state.floors[1].memoryId;
  state = await h.runtime.extractFloor(secondFloorId);
  assert.notEqual(state.floors[1].memoryId, oldMemoryId);
  assert.deepEqual(state.cseFloors.map(item => item.status), ['noChange', 'noChange', 'noChange']);
  assert.equal(state.rebuildCompletedCount, 3);
  assert.equal(state.rebuildTotalCount, 3);
  assert.equal(state.rebuildNextAssistantSeq, null);

  h.runtime.invalidate();
  state = h.runtime.getState();
  assert.equal(state.rebuildCompletedCount, 0);
  assert.equal(state.rebuildTotalCount, 0);
  assert.equal(state.rebuildNextAssistantSeq, null);
});

test('memory refresh 复用 foundation 本轮 reachable，不重复读取同一份后端图', async () => {
  const h = harness();
  await h.runtime.start();
  const readsBefore = h.backend.calls.filter(call => call[0] === 'get').length;
  await h.runtime.refreshStatus();
  assert.equal(h.backend.calls.filter(call => call[0] === 'get').length, readsBefore);
});

test('单楼摘要提交只做 root 版本复核并复用 commitRoot 真回读结果', async () => {
  const h = harness();
  await h.runtime.start();
  const floorId = h.runtime.getState().floors[0].floorId;
  h.backend.calls.splice(0);
  const state = await h.runtime.extractFloor(floorId, { analyzeState: false });
  assert.equal(state.rememberedCount, 1, JSON.stringify(state.lastExtractorError));
  const gets = h.backend.calls.filter(call => call[0] === 'get');
  assert.equal(gets.filter(call => call[2] === 'v3-root').length, 2,
    '提取前投影确认与模型返回后的 root 版本复核各一次，不再提交后重读整图');
  assert.equal(gets.length, 5, '固定 fixture 同 root 复用后仅保留两次轻 root 核对及 commitRoot 对 checkpoint/run/index 的真读校验');
  assert.equal(h.backend.calls.filter(call => call[0] === 'put').length, 7,
    '固定 fixture 新提交只写两个人物、摘要、floorOrder、run、checkpoint 与 root');
  const indexPuts = h.backend.calls.filter(call => call[0] === 'put' && call[2].startsWith('v3-index-'));
  assert.equal(indexPuts.length, 1);
  assert.ok(indexPuts.every(call => call[2].startsWith('v3-index-floorOrder-')));
});

test('有效摘要在 index 保存失败后由手动重试复用，成功后立即清掉待保存结果', async () => {
  let clockTick = 0;
  const h = harness({ now: () => new Date(Date.parse(NOW) + clockTick++ * 1000) });
  await h.runtime.start();
  const floorId = h.runtime.getState().floors[0].floorId;
  let failIndexOnce = true;
  h.backend.setBeforePut(({ key }) => {
    if (!failIndexOnce || !key.startsWith('v3-index-')) return;
    failIndexOnce = false;
    throw Object.assign(new Error('index timeout'), { status: 504, code: 'BACKEND_TIMEOUT' });
  });

  let state = await h.runtime.extractFloor(floorId, { analyzeState: false });
  assert.equal(state.rememberedCount, 0);
  assert.equal(h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, 1);

  h.backend.setBeforePut(null);
  state = await h.runtime.extractFloor(floorId, { analyzeState: false });
  assert.equal(state.rememberedCount, 1, JSON.stringify(state.lastExtractorError));
  assert.equal(h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, 1,
    '同楼同依赖的手动重试必须直接保存已有有效结果');

  await h.runtime.extractFloor(floorId, { analyzeState: false });
  assert.equal(h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, 2,
    '正式提交成功后不得继续复用已经消费的待保存结果');
});

test('root 保存失败的待保存结果可跨过另一楼成功提交后继续复用', async () => {
  const h = harness({ initialChat: [assistant('第一楼'), assistant('第二楼'), assistant('用于确认第二楼稳定。')] });
  await h.runtime.start();
  const [firstFloor, secondFloor] = h.runtime.getState().floors;
  let failRootOnce = true;
  h.backend.setBeforePut(({ key }) => {
    if (!failRootOnce || key !== 'v3-root') return;
    failRootOnce = false;
    throw Object.assign(new Error('root timeout'), { status: 504, code: 'BACKEND_TIMEOUT' });
  });

  let state = await h.runtime.extractFloor(firstFloor.floorId, { analyzeState: false });
  assert.equal(state.rememberedCount, 0);
  h.backend.setBeforePut(null);
  state = await h.runtime.extractFloor(secondFloor.floorId, { analyzeState: false });
  assert.equal(state.rememberedCount, 1, JSON.stringify(state.lastExtractorError));
  state = await h.runtime.extractFloor(firstFloor.floorId, { analyzeState: false });
  assert.equal(state.rememberedCount, 2, JSON.stringify(state.lastExtractorError));
  assert.equal(h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, 2,
    '两楼各生成一次；第一楼保存重试不得产生第三次模型请求');
});

test('待保存期间处理提示变化会重新生成，并按新提示记录来源指纹', async () => {
  let currentProcessingPrompt = '处理提示第一版';
  const h = harness({ processingPrompt: () => currentProcessingPrompt });
  await h.runtime.start();
  const floorId = h.runtime.getState().floors[0].floorId;
  let failIndexOnce = true;
  h.backend.setBeforePut(({ key }) => {
    if (!failIndexOnce || !key.startsWith('v3-index-')) return;
    failIndexOnce = false;
    throw Object.assign(new Error('index timeout'), { status: 504, code: 'BACKEND_TIMEOUT' });
  });
  await h.runtime.extractFloor(floorId, { analyzeState: false });

  h.backend.setBeforePut(null);
  currentProcessingPrompt = '处理提示第二版';
  const state = await h.runtime.extractFloor(floorId, { analyzeState: false });
  assert.equal(state.rememberedCount, 1, JSON.stringify(state.lastExtractorError));
  assert.equal(h.calls.length, 2,
    '处理提示变化后旧结果不再适用，必须重新调用模型');
  const provenance = h.foundationRuntime.getReachable().run.diagnostics.floorProvenance[floorId];
  const expectedFingerprint = `sha256:${createHash('sha256').update(buildExtractorSystemPrompt('', currentProcessingPrompt)).digest('hex')}`;
  assert.equal(provenance.systemPromptFingerprint, expectedFingerprint);
});

test('invalidate 会清掉未保存结果，随后处理同楼重新调用模型', async () => {
  const h = harness();
  await h.runtime.start();
  const floorId = h.runtime.getState().floors[0].floorId;
  let failRootOnce = true;
  h.backend.setBeforePut(({ key }) => {
    if (!failRootOnce || key !== 'v3-root') return;
    failRootOnce = false;
    throw Object.assign(new Error('root timeout'), { status: 504, code: 'BACKEND_TIMEOUT' });
  });
  await h.runtime.extractFloor(floorId, { analyzeState: false });
  h.backend.setBeforePut(null);

  h.runtime.invalidate();
  await h.runtime.start();
  const currentFloorId = h.runtime.getState().floors[0].floorId;
  const state = await h.runtime.extractFloor(currentFloorId, { analyzeState: false });
  assert.equal(state.rememberedCount, 1, JSON.stringify(state.lastExtractorError));
  assert.equal(h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, 2,
    '运行时失效后不得复用上一生命周期的待保存结果');
});

test('单楼与下一楼从冷地基点击到 fake 请求都只准备一轮整图，轻 root 核对单独计数', async () => {
  for (const entry of ['floor', 'next']) {
    let h;
    let readsAtRequest = null;
    let getsAtRequest = null;
    h = harness({
      utility: options => {
        if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) {
          readsAtRequest = [...h.readReachableModes];
          getsAtRequest = h.backend.calls.filter(call => call[0] === 'get').map(call => call[2]);
        }
        return options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
          ? { jsonData: { summary: `${entry} 单轮准备摘要。` } }
          : { jsonData: { noMaterialChange: true } };
      },
    });
    await h.runtime.start();
    const floorId = h.runtime.getState().floors[0].floorId;
    h.foundationRuntime.invalidate();
    h.readReachableModes.splice(0);
    h.backend.calls.splice(0);
    if (entry === 'floor') await h.runtime.extractFloor(floorId, { analyzeState: false });
    else await h.runtime.extractNext();
    assert.deepEqual(readsAtRequest, ['runtime'], `${entry} 请求前必须只有一轮 runtime 整图读取`);
    assert.equal(getsAtRequest.filter(key => key === 'v3-root').length, 2, `${entry} 请求前应为整图内 root + 独立轻 root 各一次`);
    assert.equal(getsAtRequest.filter(key => key.startsWith('v3-checkpoint-')).length, 1, `${entry} 请求前 checkpoint 不得重复读取`);
  }
});

test('请求前 root 变化只重备一次，最终诊断记录点击到准备与请求发出的安全耗时', async () => {
  let h;
  let requestCount = 0;
  let modesAtRequest = null;
  h = harness({ utility: options => {
    if (options.systemPrompt !== EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { noMaterialChange: true } };
    requestCount += 1;
    modesAtRequest = [...h.readReachableModes];
    return { jsonData: { summary: 'root 重备后摘要。' } };
  } });
  await h.runtime.start();
  const floorId = h.runtime.getState().floors[0].floorId;
  h.readReachableModes.splice(0);
  h.backend.calls.splice(0);
  let armed = true;
  h.backend.setBeforeGet(({ collection, key, records }) => {
    if (!armed || key !== 'v3-root') return;
    armed = false;
    const record = records.get(`${collection}/${key}`);
    records.set(`${collection}/${key}`, { revision: record.revision + 1, data: structuredClone(record.data) });
  });
  const state = await h.runtime.extractFloor(floorId, { analyzeState: false });
  h.backend.setBeforeGet(null);
  assert.equal(requestCount, 1);
  assert.deepEqual(modesAtRequest, ['runtime'], 'root 变化时只补一次 runtime 图，不循环重读');
  const graph = await h.store.readReachable({ mode: 'runtime' });
  const timing = graph.run.diagnostics.floorProvenance[floorId].preflightTiming;
  assert.equal(timing.rootChecks, 2);
  assert.equal(timing.reprepareCount, 1);
  assert.equal(Number.isFinite(timing.prepareMs), true);
  assert.equal(Number.isFinite(timing.requestDispatchMs), true);
  assert.equal(timing.requestDispatchMs >= timing.prepareMs, true);
  assert.doesNotMatch(JSON.stringify(timing), /root 重备后摘要|裴晚生提醒你带伞|api.?key/i);
  assert.equal(state.rememberedCount, 1);
});

test('轻 root 等待期间切聊或正文变化都会在 fake 请求前作废', async () => {
  for (const scenario of ['chat', 'content']) {
    let requestCount = 0;
    const h = harness({ utility: () => { requestCount += 1; return { jsonData: { summary: '不应发送。' } }; } });
    await h.runtime.start();
    const floorId = h.runtime.getState().floors[0].floorId;
    let armed = true;
    h.backend.setBeforeGet(({ key }) => {
      if (!armed || key !== 'v3-root') return;
      armed = false;
      if (scenario === 'chat') h.context.chatMetadata.qianqianjie.chatId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      else h.context.chat[1] = { ...h.context.chat[1], mes: '请求前已经换掉的正文。', swipes: ['请求前已经换掉的正文。'], swipe_id: 0 };
    });
    await assert.rejects(
      h.runtime.extractFloor(floorId, { analyzeState: false }),
      error => ['V3_MEMORY_STALE', 'V3_MEMORY_PREFIX_CHANGED'].includes(error?.code),
    );
    assert.equal(requestCount, 0, `${scenario} 变化不得误发 fake 请求`);
    h.backend.setBeforeGet(null);
  }
});

test('下一楼准备完成后在 active 通知中切聊，旧 prepared 不会被新 epoch 消费', async () => {
  let requestCount = 0;
  const h = harness({ utility: () => { requestCount += 1; return { jsonData: { summary: '不应发送的旧 prepared。' } }; } });
  await h.runtime.start();
  let switched = false;
  const unsubscribe = h.runtime.subscribe(state => {
    if (switched || !state.activeExtraction) return;
    switched = true;
    h.context.chatMetadata.qianqianjie.chatId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  });
  const state = await h.runtime.extractNext();
  unsubscribe();
  assert.equal(switched, true);
  assert.equal(requestCount, 0);
  assert.equal(state.lastExtractorError?.code, 'V3_MEMORY_PREFIX_CHANGED');
});

test('摘要 prepared 记录最多四路并发，run/checkpoint 等独立写完后才开始', async () => {
  const h = harness();
  await h.runtime.start();
  const floorId = h.runtime.getState().floors[0].floorId;
  let active = 0;
  let maximum = 0;
  let started = 0;
  let release;
  let fourStarted;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { fourStarted = resolve; });
  h.backend.setBeforePut(async ({ key }) => {
    if (key === 'v3-root' || key.startsWith('v3-run-') || key.startsWith('v3-checkpoint-')) return;
    started += 1;
    active += 1;
    maximum = Math.max(maximum, active);
    if (started === 4) fourStarted();
    await gate;
    active -= 1;
  });
  h.backend.calls.splice(0);
  const pending = h.runtime.extractFloor(floorId, { analyzeState: false });
  await ready;
  assert.equal(maximum, 4);
  assert.equal(h.backend.calls.some(call => call[0] === 'put' && (call[2].startsWith('v3-run-') || call[2].startsWith('v3-checkpoint-'))), false);
  release();
  const state = await pending;
  assert.equal(state.rememberedCount, 1, JSON.stringify(state.lastExtractorError));
  assert.equal(active, 0);
});

test('历史按钮单楼失败后继续保存独立后楼并撤销授权；刷新零调用，再次点击只补失败楼', async () => {
  let failSecond = true;
  const automaticSummaryReceipts = [];
  const h = harness({
    initialChat: [user('开始'), assistant('历史一'), assistant('历史二'), assistant('历史三'), assistant('待确认尾楼')],
    automation: { enabled: true, batchSize: 2 },
    onAutomaticSummaryCommitted: receipt => { automaticSummaryReceipts.push(receipt); },
    utility: options => {
      if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) {
        const content = JSON.parse(options.taskMessages[0].content).payload.canonicalContent;
        if (content === '历史二' && failSecond) { failSecond = false; throw new Error('模拟历史第二楼失败'); }
        return { jsonData: { summary: `摘要-${content}` } };
      }
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  assert.equal(h.runtime.getState().rebuildStatus, 'partial');
  assert.equal(h.runtime.shouldBlockMainGeneration(), false, '历史重建失败后必须立即释放主生成门禁');
  assert.equal(h.runtime.getState().rememberedCount, 2, '失败楼后的独立摘要仍应在同批保存');
  assert.equal(automaticSummaryReceipts.length, 2, '仅两楼正式成功提交发出通知，失败楼不通知');
  assert.ok(automaticSummaryReceipts.every(receipt => receipt.chatId === CHAT
    && h.runtime.getState().floors.some(floor => floor.floorId === receipt.floorId && floor.memoryId === receipt.memoryId && floor.status === 'ready')),
  '自动通知必须携带当前 ready 摘要的 chatId/floorId/memoryId');
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 1, '人物状态只处理摘要缺口之前，失败后的独立摘要保留待后续补齐');
  const callsAtFailure = h.calls.length;
  await h.runtime.refreshAutomation();
  await h.runtime.refreshStatus();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.calls.length, callsAtFailure, '失败后的检测/刷新不能隐式重试');
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => ['caughtUp', 'waitingRealtime'].includes(h.runtime.getState().rebuildStatus));
  assert.equal(h.runtime.getState().rememberedCount, 3);
  assert.equal(automaticSummaryReceipts.length, 3, '失败楼后续成功时才补发一次通知');
  assert.equal(h.runtime.getState().cseReady, true);
});

test('历史按钮收到 foundation 返回错误时明确失败且零模型调用，再次点击可有界恢复', async () => {
  let failNextRefresh = false;
  const notifications = [];
  const h = harness({
    initialChat: [user('开始'), assistant('待补历史楼'), assistant('未稳定尾楼')],
    automation: { enabled: true, batchSize: 1 },
    notifyUser: value => notifications.push(value),
    foundationRefresh: async base => {
      if (failNextRefresh) {
        failNextRefresh = false;
        return { ...base.getState(), status: 'error', lastError: '模拟地基对账失败' };
      }
      return base.refreshStatus();
    },
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: '恢复后摘要' } }
      : { jsonData: { noMaterialChange: true } },
  });
  await h.runtime.start();
  failNextRefresh = true;
  await h.runtime.startHistoricalRebuild();
  assert.equal(h.runtime.getState().lastAutoMemory?.status, 'failed');
  assert.equal(h.runtime.getState().lastAutoMemory?.phase, 'reconciling');
  assert.equal(h.calls.length, 0);
  assert.match(notifications.at(-1)?.text ?? '', /历史记忆维护未开始.*模拟地基对账失败.*已保存的记忆保持不变/);
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()));
  assert.deepEqual(h.calls.map(call => call.systemPrompt), [EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT]);
});

test('编辑器保存后 canonical 正文相同不产生 divergence，也不调用重建 API', async () => {
  const h = harness({
    initialChat: [user('开始'), assistant('相同正文'), assistant('历史二'), assistant('待确认尾楼')],
    automation: { enabled: true, batchSize: 2 },
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: JSON.parse(options.taskMessages[0].content).payload.canonicalContent } }
      : { jsonData: { noMaterialChange: true } },
  });
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => ['caughtUp', 'waitingRealtime'].includes(h.runtime.getState().rebuildStatus) && !h.runtime.getState().activeAutoMemory, '相同正文测试初始历史未追平');
  const before = await h.store.readReachable();
  h.calls.splice(0);

  const foundationState = await h.foundationRuntime.refreshStatus();
  await h.runtime.retryAutomation();
  await new Promise(resolve => setTimeout(resolve, 20));
  const after = await h.store.readReachable();
  assert.equal(foundationState.status, 'ready');
  assert.equal(foundationState.lastRun.result, 'unchanged');
  assert.equal(after.root.narrativeGeneration, before.root.narrativeGeneration);
  assert.deepEqual(after.floors.map(floor => floor.id), before.floors.map(floor => floor.id));
  assert.equal(h.calls.length, 0);
});

test('同楼隐藏时间戳变化不撤销已存时间，摘要与 CSE 分别显式重提', async () => {
  const stamped = (start, end) => `<!-- QQJ-start | date=10月4日 | weekday=周二 | time=${start} -->裴晚生在钟楼等你。<!-- QQJ-end | date=10月4日 | weekday=周二 | time=${end} -->`;
  const cseInputs = [];
  const h = harness({
    initialChat: [user('继续'), assistant(stamped('15:30', '16:00')), assistant('确认上一楼稳定。')],
    utility: options => {
      if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { summary: '裴晚生在钟楼等待用户。', time: [{ sourceText: '错误时间', description: '不应保留' }], locations: [{ name: '钟楼', change: 'present' }], people: [{ name: '裴晚生', presence: 'present' }, { name: '你', role: 'user', presence: 'present' }] } };
      cseInputs.push(JSON.parse(options.taskMessages[0].content)); return { jsonData: { noMaterialChange: true } };
    },
  });
  await h.runtime.start(); await h.runtime.extractNext();
  let state = h.runtime.getState(), floor = state.floors[0];
  assert.equal(floor.memory.chronology.length, 1);
  assert.match(floor.memory.chronology[0].time.sourceText, /15:30.*16:00/);
  assert.doesNotMatch(floor.memory.chronology[0].time.sourceText, /错误时间/);
  assert.match(JSON.stringify(cseInputs.at(-1)), /15:30.*16:00/);

  h.context.chat[1].mes = stamped('18:10', '18:40');
  h.context.chat[1].swipes = [h.context.chat[1].mes];
  await h.runtime.refreshStatus(); state = h.runtime.getState(); floor = state.floors[0];
  assert.match(floor.memory.chronology[0].time.sourceText, /15:30.*16:00/);
  assert.equal(floor.error, null);
  const cseCallsBeforeRetry = cseInputs.length;
  await h.runtime.extractFloor(floor.floorId);
  state = h.runtime.getState(); floor = state.floors[0];
  assert.match(floor.memory.chronology[0].time.sourceText, /18:10.*18:40/);
  assert.doesNotMatch(floor.memory.chronology[0].time.sourceText, /15:30/);
  assert.equal(cseInputs.length, cseCallsBeforeRetry, '摘要重提不得自动重算已存 CSE');
  await h.runtime.retryStateAnalysis(floor.floorId);
  state = h.runtime.getState(); floor = state.floors[0];
  assert.equal(cseInputs.length, cseCallsBeforeRetry + 1, '显式人物状态重分析才调用一次 CSE');
  assert.match(JSON.stringify(cseInputs.at(-1)), /18:10.*18:40/);
  assert.doesNotMatch(JSON.stringify(cseInputs.at(-1)), /15:30.*16:00/);
  assert.equal(floor.cse.status, 'noChange');
  assert.equal(state.lastCseError, null);
});

test('同楼多段故事时间逐段生成稳定 chronology，完整区间不被悬空尾巴或模型时间覆盖', async () => {
  const span = (start, end) => `<!-- QQJ-start | date=10月30日 | weekday=周五 | time=${start} -->正文<!-- QQJ-end | date=10月30日 | weekday=周五 | time=${end} -->`;
  const stamped = `${span('12:45', '13:10')}过渡${span('14:30', '14:50')}<!-- QQJ-start | date=10月30日 | weekday=周五 | time=15:15 -->`;
  const h = harness({
    initialChat: [user('继续'), assistant(stamped), assistant('确认上一楼稳定。')],
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: '两段剧情摘要。', time: [{ sourceText: '错误时间', description: '不应保留' }] } }
      : { jsonData: { noMaterialChange: true } },
  });
  await h.runtime.start();
  const floorId = h.runtime.getState().floors[0].floorId;
  await h.runtime.extractFloor(floorId, { analyzeState: false });

  const payload = JSON.parse(h.calls.find(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).taskMessages[0].content).payload;
  assert.equal(payload.storyClock.complete, true);
  assert.deepEqual(payload.storyClock.pairs.map(pair => [pair.start.time, pair.end.time]), [['12:45', '13:10'], ['14:30', '14:50']]);
  const chronology = h.runtime.getState().floors[0].memory.chronology;
  assert.deepEqual(chronology.map(item => item.time.sourceText), ['10月30日 周五 12:45 → 10月30日 周五 13:10', '10月30日 周五 14:30 → 10月30日 周五 14:50']);
  assert.equal(new Set(chronology.map(item => item.itemId)).size, 2);
  assert.equal(chronology.some(item => /\|\s*date=/u.test(item.time.sourceText)), false);
  assert.equal(chronology.some(item => item.time.sourceText.includes('15:15') || item.time.sourceText.includes('错误时间')), false);

  const response = { summary: '两段剧情摘要。', time: [{ sourceText: '错误时间', description: '不应保留' }] };
  const first = await direct(response, { storyClock: payload.storyClock });
  const second = await direct(response, { storyClock: payload.storyClock });
  assert.deepEqual(first.memory.chronology.map(item => item.itemId), second.memory.chronology.map(item => item.itemId));
});

test('CSE 分析期间 pending-only 刷新不推进正式 root，假模型结果仍按原守卫提交', async () => {
  let releaseCse, markCseStarted;
  const cseStarted = new Promise(resolve => { markCseStarted = resolve; });
  const h = harness({
    initialChat: [assistant('稳定目标楼。'), assistant('待定尾楼旧版本。')],
    utility: options => {
      if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { summary: '稳定目标楼摘要。' } };
      markCseStarted();
      return new Promise(resolve => { releaseCse = () => resolve({ jsonData: { noMaterialChange: true } }); });
    },
  });
  await h.runtime.start();
  const floorId = h.runtime.getState().floors[0].floorId;
  await h.runtime.extractFloor(floorId, { analyzeState: false });

  const analysis = h.runtime.retryStateAnalysis(floorId);
  await cseStarted;
  const beforePending = await h.store.readReachable({ mode: 'runtime' });
  h.context.chat[1] = assistant('待定尾楼新版本。');
  await h.foundationRuntime.refreshStatus();
  const during = await h.store.readReachable({ mode: 'runtime' });
  assert.equal(during.rootRevision, beforePending.rootRevision);
  assert.equal(during.root.headCheckpointId, beforePending.root.headCheckpointId);

  releaseCse();
  await analysis;
  const after = await h.store.readReachable({ mode: 'runtime' });
  assert.equal(after.stateDeltas.length, 1);
  assert.equal(after.stateDeltas[0].floorId, floorId);
  assert.equal(h.runtime.getState().floors[0].cse.status, 'noChange');
  assert.equal(h.runtime.getState().lastCseError, null);
});

test('修复前稳定指纹首次刷新只对齐一次 head，保留楼、摘要与 API 调用次数', async () => {
  const h = harness({
    initialChat: [assistant('稳定正文。'), assistant('待定尾楼。')],
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: '已保存的稳定摘要。' } }
      : { jsonData: { noMaterialChange: true } },
  });
  await h.runtime.start();
  await h.runtime.extractNext();
  const before = await h.store.readReachable({ mode: 'runtime' });
  const callsBefore = h.calls.length;
  const candidates = await scanAssistantCandidates(h.context.chat);
  const oldPayload = {
    version: 1,
    stableCount: 1,
    latestStatus: 'pending',
    floors: candidates.slice(0, 1).map(candidate => ({
      assistantSeq: candidate.assistantSeq,
      rawFingerprint: candidate.rawFingerprint,
      canonicalFingerprint: candidate.canonicalFingerprint,
      sanitizerFingerprint: candidate.sanitizerFingerprint,
      messageIndex: candidate.hostLocator.messageIndex,
      swipeId: candidate.hostLocator.swipeId,
      selectedSwipeIndex: candidate.hostLocator.selectedSwipeIndex,
    })),
  };
  const oldFingerprint = `sha256:${createHash('sha256').update(JSON.stringify(oldPayload)).digest('hex')}`;
  assert.notEqual(oldFingerprint, before.root.sourceSnapshotFingerprint);

  const rootKey = `chat-${CHAT}/v3-root`;
  const rootEnvelope = h.backend.records.get(rootKey);
  const checkpointEnvelope = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${rootEnvelope.data.headCheckpointId}`);
  const runEnvelope = h.backend.records.get(`chat-${CHAT}/v3-run-${checkpointEnvelope.data.runId}`);
  rootEnvelope.data.sourceSnapshotFingerprint = oldFingerprint;
  checkpointEnvelope.data.sourceSnapshotFingerprint = oldFingerprint;
  runEnvelope.data.inputSnapshotFingerprint = oldFingerprint;
  const cached = structuredClone(h.foundationRuntime.getReachable());
  cached.root.sourceSnapshotFingerprint = oldFingerprint;
  cached.checkpoint.sourceSnapshotFingerprint = oldFingerprint;
  cached.run.inputSnapshotFingerprint = oldFingerprint;
  assert.equal(h.foundationRuntime.adoptReachable(cached), true);

  await h.runtime.refreshStatus();
  const aligned = await h.store.readReachable({ mode: 'runtime' });
  assert.equal(aligned.rootRevision, before.rootRevision + 1, '旧指纹首次刷新只推进一次 root revision');
  assert.notEqual(aligned.root.headCheckpointId, before.root.headCheckpointId, '旧指纹首次刷新应对齐新 head');
  assert.deepEqual(aligned.floors.map(floor => floor.id), before.floors.map(floor => floor.id));
  assert.deepEqual(aligned.floorMemories.map(memory => memory.id), before.floorMemories.map(memory => memory.id));
  assert.deepEqual(aligned.floorMemories.map(memory => memory.summary), before.floorMemories.map(memory => memory.summary));
  assert.equal(h.calls.length, callsBefore, '指纹对齐不得重新调用摘要或 CSE API');

  await h.runtime.refreshStatus();
  const second = await h.store.readReachable({ mode: 'runtime' });
  assert.equal(second.rootRevision, aligned.rootRevision, '第二次刷新必须保持 no-op');
  assert.equal(second.root.headCheckpointId, aligned.root.headCheckpointId);
  assert.deepEqual(second.floorMemories.map(memory => memory.id), before.floorMemories.map(memory => memory.id));
  assert.equal(h.calls.length, callsBefore);
});

test('4 楼摘要在途时 6 楼空 swipe 异步窗口不换稳定 head、不取消也不重复调用', async () => {
  let releaseTarget;
  let markTargetStarted;
  let targetSignal = null;
  let targetCalls = 0;
  const targetStarted = new Promise(resolve => { markTargetStarted = resolve; });
  const targetText = '四楼稳定待摘要。';
  const h = harness({
    initialChat: [
      assistant('零楼稳定。'),
      user('一楼用户输入。'),
      assistant('二楼稳定。'),
      user('三楼用户输入。'),
      assistant(targetText),
      user('五楼用户输入保持不动。'),
      assistant('六楼旧版本。'),
    ],
    automation: { enabled: true, batchSize: 1 },
    utility: options => {
      if (options.systemPrompt !== EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { noMaterialChange: true } };
      const content = JSON.parse(options.taskMessages[0].content).payload.canonicalContent;
      if (content !== targetText) return { jsonData: { summary: `${content}摘要` } };
      targetCalls += 1;
      if (targetCalls > 1) return { jsonData: { summary: '不应发生的重复四楼摘要。' } };
      targetSignal = options.signal;
      markTargetStarted();
      return new Promise(resolve => { releaseTarget = () => resolve({ jsonData: { summary: '四楼唯一摘要。' } }); });
    },
  });
  await h.runtime.start();
  const initialFloors = h.runtime.getState().floors;
  await h.runtime.extractFloor(initialFloors[0].floorId, { analyzeState: false });
  await h.runtime.extractFloor(initialFloors[1].floorId, { analyzeState: false });
  const target = h.runtime.getState().floors.find(floor => floor.messageIndex === 4);
  const extraction = h.runtime.extractFloor(target.floorId, { analyzeState: false });
  await targetStarted;
  const beforeTail = await h.store.readReachable({ mode: 'runtime' });

  h.context.chat[6] = { ...assistant(''), mes: '', swipes: ['六楼旧版本。', ''], swipe_id: 1 };
  h.emit('MESSAGE_SWIPED', 6, { pendingGeneration: true, previousSwipeId: 0, nextSwipeId: 1 });
  const reloadState = h.runtime.getState();
  assert.equal(reloadState.memorySnapshotStatus, 'ready');
  assert.equal(reloadState.memorySyncStatus, 'syncing', '同聊天已验证快照保持 ready，后台同步使用独立状态');
  assert.equal(projectInlineMemoryFloor(reloadState, 0).statusText, '摘要已保存', '保留可验证旧 floor 的窄路径应继续显示已确认摘要');
  assert.notEqual(projectInlineMemoryFloor(reloadState, 0).statusText, '等待本楼稳定');
  await waitFor(() => h.foundationRuntime.getState().status === 'ready' && h.foundationRuntime.getState().pending === null, '未进入真实空 swipe 地基窗口');
  const duringEmptyTail = await h.store.readReachable({ mode: 'runtime' });

  h.emit('GENERATION_STARTED', 'swipe', {}, false);
  h.context.chat[6] = { ...assistant('六楼新版本。'), swipes: ['六楼旧版本。', '六楼新版本。'], swipe_id: 1 };
  h.emit('GENERATION_ENDED');
  h.emit('MESSAGE_RECEIVED', 6, 'swipe');
  await waitFor(() => h.foundationRuntime.getState().status === 'ready' && h.foundationRuntime.getState().pending?.messageIndex === 6, '六楼完成后地基未恢复 pending');
  for (let attempt = 0; attempt < 100 && targetCalls < 2; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));

  assert.deepEqual({
    aborted: targetSignal?.aborted,
    targetCalls,
    rootRevisionStable: duringEmptyTail.rootRevision === beforeTail.rootRevision,
    headStable: duringEmptyTail.root.headCheckpointId === beforeTail.root.headCheckpointId,
    fingerprintStable: duringEmptyTail.root.sourceSnapshotFingerprint === beforeTail.root.sourceSnapshotFingerprint,
  }, {
    aborted: false,
    targetCalls: 1,
    rootRevisionStable: true,
    headStable: true,
    fingerprintStable: true,
  });

  releaseTarget();
  await extraction;
  await waitFor(() => !h.runtime.getState().activeExtraction && !h.runtime.getState().activeAutoMemory);
  const finalState = h.runtime.getState();
  const finalTarget = finalState.floors.find(floor => floor.messageIndex === 4);
  assert.equal(targetCalls, 1);
  assert.equal(finalTarget.summary, '四楼唯一摘要。');
  assert.equal(finalState.lastExtractorError, null);
});

test('同一尾槽连续两次合法空 swipe reroll 都不取消在途旧楼摘要', async () => {
  let releaseTarget;
  let markTargetStarted;
  let targetSignal = null;
  let targetCalls = 0;
  const targetStarted = new Promise(resolve => { markTargetStarted = resolve; });
  const targetText = '四楼连续 reroll 期间仍应稳定。';
  const h = harness({
    initialChat: [
      assistant('零楼稳定。'), user('一楼用户。'), assistant('二楼稳定。'), user('三楼用户。'),
      assistant(targetText), user('五楼固定用户输入。'), assistant('六楼旧版本。'),
    ],
    utility: options => {
      if (options.systemPrompt !== EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { noMaterialChange: true } };
      const content = JSON.parse(options.taskMessages[0].content).payload.canonicalContent;
      if (content !== targetText) return { jsonData: { summary: `${content}摘要` } };
      targetCalls += 1;
      targetSignal = options.signal;
      markTargetStarted();
      return new Promise(resolve => { releaseTarget = () => resolve({ jsonData: { summary: '连续 reroll 后成功摘要。' } }); });
    },
  });
  await h.runtime.start();
  const target = h.runtime.getState().floors.find(floor => floor.messageIndex === 4);
  const extraction = h.runtime.extractFloor(target.floorId, { analyzeState: false });
  await targetStarted;

  const reroll = async ({ previousText, nextText, previousSwipeId, nextSwipeId }) => {
    const swipes = previousSwipeId === 0 ? [previousText, ''] : ['六楼旧版本。', previousText, ''];
    h.context.chat[6] = { ...assistant(''), mes: '', swipes, swipe_id: nextSwipeId };
    h.emit('MESSAGE_SWIPED', 6, { pendingGeneration: true, previousSwipeId, nextSwipeId });
    await waitFor(() => h.foundationRuntime.getState().status === 'ready' && h.foundationRuntime.getState().pending === null, '连续 reroll 未进入空 swipe 窗口');
    h.emit('GENERATION_STARTED', 'swipe', {}, false);
    swipes[nextSwipeId] = nextText;
    h.context.chat[6] = { ...assistant(nextText), swipes, swipe_id: nextSwipeId };
    h.emit('GENERATION_ENDED');
    h.emit('MESSAGE_RECEIVED', 6, 'swipe');
    await waitFor(() => h.foundationRuntime.getState().status === 'ready'
      && h.foundationRuntime.getState().pending?.messageIndex === 6
      && h.foundationRuntime.getState().pending?.canonicalFingerprint, '连续 reroll 完成后 pending 未恢复');
  };

  await reroll({ previousText: '六楼旧版本。', nextText: '六楼新版本一。', previousSwipeId: 0, nextSwipeId: 1 });
  assert.equal(targetSignal?.aborted, false, '第一次合法尾楼 reroll 不得取消四楼摘要');
  await reroll({ previousText: '六楼新版本一。', nextText: '六楼新版本二。', previousSwipeId: 1, nextSwipeId: 2 });
  assert.equal(targetSignal?.aborted, false, '第二次合法尾楼 reroll 也不得取消四楼摘要');

  releaseTarget();
  await extraction;
  const finalTarget = h.runtime.getState().floors.find(floor => floor.messageIndex === 4);
  assert.equal(targetCalls, 1);
  assert.equal(finalTarget.summary, '连续 reroll 后成功摘要。');
  assert.equal(h.runtime.getState().lastExtractorError, null);
});

test('尾楼手动停止、选择已有 swipe 或删除 swipe 都不取消更早在途摘要', async () => {
  for (const scenario of ['stopped', 'selectExistingSwipe', 'deleteSwipe']) {
    let releaseTarget;
    let markTargetStarted;
    let targetSignal = null;
    const targetStarted = new Promise(resolve => { markTargetStarted = resolve; });
    const targetText = `四楼 ${scenario} 期间稳定。`;
    const h = harness({
      initialChat: [
        assistant('零楼稳定。'), user('一楼用户。'), assistant('二楼稳定。'), user('三楼用户。'),
        assistant(targetText), user('五楼固定用户输入。'), assistant('六楼旧版本。'),
      ],
      utility: options => {
        if (options.systemPrompt !== EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { noMaterialChange: true } };
        const content = JSON.parse(options.taskMessages[0].content).payload.canonicalContent;
        if (content !== targetText) return { jsonData: { summary: `${content}摘要` } };
        targetSignal = options.signal;
        markTargetStarted();
        return new Promise(resolve => { releaseTarget = () => resolve({ jsonData: { summary: `${scenario} 后摘要成功。` } }); });
      },
    });
    await h.runtime.start();
    const target = h.runtime.getState().floors.find(floor => floor.messageIndex === 4);
    const extraction = h.runtime.extractFloor(target.floorId, { analyzeState: false });
    await targetStarted;

    if (scenario === 'stopped') {
      h.context.chat[6] = { ...assistant(''), mes: '', swipes: ['六楼旧版本。', ''], swipe_id: 1 };
      h.emit('MESSAGE_SWIPED', 6, { pendingGeneration: true, previousSwipeId: 0, nextSwipeId: 1 });
      await waitFor(() => h.foundationRuntime.getState().status === 'ready' && h.foundationRuntime.getState().pending === null, '停止场景未进入空 swipe 窗口');
      h.emit('GENERATION_STARTED', 'swipe', {}, false);
      h.context.chat[6] = { ...assistant('六楼停止时已有正文。'), swipes: ['六楼旧版本。', '六楼停止时已有正文。'], swipe_id: 1 };
      h.emit('GENERATION_STOPPED');
      h.emit('MESSAGE_RECEIVED', 6, 'swipe');
    } else if (scenario === 'selectExistingSwipe') {
      h.context.chat[6] = { ...assistant('六楼已有版本。'), swipes: ['六楼旧版本。', '六楼已有版本。'], swipe_id: 1 };
      h.emit('MESSAGE_SWIPED', 6, { pendingGeneration: false, previousSwipeId: 0, nextSwipeId: 1 });
    } else {
      h.context.chat[6] = { ...assistant('六楼删除后版本。'), swipes: ['六楼删除后版本。'], swipe_id: 0 };
      h.emit('MESSAGE_SWIPE_DELETED', { messageId: 6, swipeId: 1, newSwipeId: 0 });
    }
    await waitFor(() => h.foundationRuntime.getState().status === 'ready'
      && h.foundationRuntime.getState().pending?.messageIndex === 6, `${scenario} 后地基未恢复尾楼 pending`);
    assert.equal(targetSignal?.aborted, false, `${scenario} 不得取消更早在途摘要`);

    releaseTarget();
    await extraction;
    const finalTarget = h.runtime.getState().floors.find(floor => floor.messageIndex === 4);
    assert.equal(finalTarget.summary, `${scenario} 后摘要成功。`);
    assert.equal(h.runtime.getState().lastExtractorError, null);
  }
});

test('未稳定尾楼 swipe、停止、接收与删除事件不取消更早稳定楼 CSE，尾楼仍保持 pending', async () => {
  for (const scenario of ['rerollStoppedAndReceived', 'selectExistingSwipe', 'deleteSwipe']) {
    let releaseCse, markCseStarted;
    const cseStarted = new Promise(resolve => { markCseStarted = resolve; });
    let cseSignal = null;
    const h = harness({
      initialChat: [user('继续'), assistant('稳定六楼。'), assistant('稳定八楼。'), assistant('待定十楼旧版本。')],
      utility: options => {
        if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { summary: '稳定楼摘要。' } };
        cseSignal = options.signal;
        markCseStarted();
        return new Promise(resolve => { releaseCse = () => resolve({ jsonData: { noMaterialChange: true } }); });
      },
    });
    await h.runtime.start();
    const [target, prerequisite] = h.runtime.getState().floors;
    await h.runtime.extractFloor(target.floorId, { analyzeState: false });
    await h.runtime.extractFloor(prerequisite.floorId, { analyzeState: false });
    const formalSnapshot = value => ({
      rootRevision: value.rootRevision,
      headCheckpointId: value.root.headCheckpointId,
      sourceSnapshotFingerprint: value.root.sourceSnapshotFingerprint,
      floors: value.floors.map(floor => ({ id: floor.id, canonicalFingerprint: floor.content.canonicalFingerprint })),
    });
    const analysis = h.runtime.retryStateAnalysis(target.floorId);
    await cseStarted;
    const beforeTailRefresh = await h.store.readReachable({ mode: 'runtime' });
    const oldPendingFingerprint = h.foundationRuntime.getState().pending.canonicalFingerprint;
    h.context.chat[3] = { ...assistant('待定十楼新版本。'), swipes: ['待定十楼旧版本。', '待定十楼新版本。'], swipe_id: 1 };
    if (scenario === 'rerollStoppedAndReceived') {
      h.emit('MESSAGE_SWIPED', 3, { pendingGeneration: true, previousSwipeId: 0, nextSwipeId: 1 });
      h.emit('GENERATION_STARTED', 'swipe', {}, false);
      h.emit('GENERATION_STOPPED');
      h.emit('MESSAGE_RECEIVED', 3, 'swipe');
    } else if (scenario === 'selectExistingSwipe') {
      h.emit('MESSAGE_SWIPED', 3, { pendingGeneration: false, previousSwipeId: 0, nextSwipeId: 1 });
    } else {
      h.emit('MESSAGE_SWIPE_DELETED', { messageId: 3, swipeId: 0, newSwipeId: 1 });
    }
    assert.equal(cseSignal?.aborted, false, `${scenario} 不得中止更早稳定楼 CSE`);
    await waitFor(() => h.foundationRuntime.getState().status === 'ready'
      && h.foundationRuntime.getState().pending?.canonicalFingerprint !== oldPendingFingerprint, `${scenario} 后地基未完成 pending 刷新`);
    const duringTailRefresh = await h.store.readReachable({ mode: 'runtime' });
    assert.deepEqual(formalSnapshot(duringTailRefresh), formalSnapshot(beforeTailRefresh), `${scenario} 的 pending 刷新不得改写正式 root 或稳定前缀`);
    assert.equal(duringTailRefresh.floors.some(floor => floor.hostLocator.messageIndex === 3), false);
    releaseCse();
    await analysis;

    const after = await h.store.readReachable({ mode: 'runtime' });
    assert.equal(after.floors.length, 2, `${scenario} 不得把正在处理的尾楼封入正式 root`);
    assert.equal(after.floors.some(floor => floor.hostLocator.messageIndex === 3), false);
    assert.equal(h.foundationRuntime.getState().pending?.messageIndex, 3);
    assert.equal(after.stateDeltas.some(delta => delta.floorId === target.floorId), true);
    assert.equal(h.runtime.getState().lastCseError, null);
  }
});

test('在途 CSE 使用已保存快照，宿主正文或无实质变化事件不撤销结果', async () => {
  for (const scenario of ['stableFloor', 'unknownRange', 'nextSwipeGeneration']) {
    let releaseCse, markCseStarted;
    const cseStarted = new Promise(resolve => { markCseStarted = resolve; });
    let cseSignal = null;
    const h = harness({
      initialChat: [user('继续'), assistant('稳定六楼。'), assistant('稳定八楼。'), assistant('待定十楼。')],
      utility: options => {
        if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { summary: '稳定楼摘要。' } };
        cseSignal = options.signal;
        markCseStarted();
        return new Promise(resolve => { releaseCse = () => resolve({ jsonData: { noMaterialChange: true } }); });
      },
    });
    await h.runtime.start();
    const [target] = h.runtime.getState().floors;
    await h.runtime.extractFloor(target.floorId, { analyzeState: false });
    const analysis = h.runtime.retryStateAnalysis(target.floorId);
    await cseStarted;
    if (scenario === 'stableFloor') {
      h.context.chat[1] = assistant('稳定六楼正文已改。');
      h.emit('MESSAGE_SWIPED', 1, { pendingGeneration: false });
    }
    else if (scenario === 'unknownRange') h.emit('MESSAGE_SWIPED');
    else {
      h.context.chat[3] = { ...assistant('待定十楼新版本。'), swipes: ['待定十楼。', '待定十楼新版本。'], swipe_id: 1 };
      h.emit('MESSAGE_SWIPED', 3, { pendingGeneration: true, previousSwipeId: 0, nextSwipeId: 1 });
      h.emit('GENERATION_STARTED', 'swipe', {}, false);
      h.emit('GENERATION_STOPPED');
      assert.equal(cseSignal?.aborted, false, '本次尾楼停止不得中止更早稳定楼 CSE');
      h.emit('GENERATION_STARTED', 'swipe', {}, false);
      h.emit('GENERATION_STOPPED');
      h.emit('MESSAGE_RECEIVED', 3, 'swipe');
    }
    const shouldAbort = false;
    assert.equal(cseSignal?.aborted, shouldAbort, shouldAbort
      ? `${scenario} 必须中止旧 CSE`
      : '已保存 FloorMemory 未变化时，宿主正文与无实质变化事件不得中止 CSE');
    releaseCse();
    await analysis;
    const after = await h.store.readReachable({ mode: 'runtime' });
    assert.equal(after.stateDeltas.length, shouldAbort ? 0 : 1,
      shouldAbort ? '取消后的迟到 CSE 不得写入' : '未被真实 roll 影响的较早 CSE 应正常保存');
  }
});

test('历史楼顺序提取只把最近已保存前楼的末段时间与摘要带给下一楼，并保存合理相对时间', async () => {
  const firstSummary = `前楼宴席记录：${'宾客依次离席，侍者收拾长桌。'.repeat(24)}裴晚生最后确认钟楼仍有人值守。`;
  const extractorRequests = [];
  const h = harness({
    initialChat: [
      user('开始'),
      assistant('十月四日晚九点，宴席结束。'),
      assistant('众人稍作休息后继续交谈。'),
      assistant('未来楼写着十二月二十日。'),
      assistant('用于确认未来楼稳定。'),
    ],
    utility: options => {
      if (options.systemPrompt !== EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { noMaterialChange: true } };
      const request = JSON.parse(options.taskMessages[0].content);
      extractorRequests.push(request);
      return request.payload.canonicalContent.includes('宴席结束')
        ? { jsonData: { summary: firstSummary, time: [{ sourceText: '十月四日晚九点', description: '宴席在十月四日晚九点结束', kind: 'explicit', normalized: '10月4日 21:00', precision: 'exact', evidence: '十月四日晚九点' }] } }
        : { jsonData: { summary: '众人在宴席结束后继续交谈。', time: [{ sourceText: '同日稍后', description: '众人在同日稍后继续交谈', kind: 'relative', normalized: null, precision: 'approximate', evidence: '稍作休息后' }] } };
    },
  });
  await h.runtime.start();
  const [firstFloor, secondFloor] = h.runtime.getState().floors;
  await h.runtime.extractFloor(firstFloor.floorId, { analyzeState: false });
  await h.runtime.extractFloor(secondFloor.floorId, { analyzeState: false });

  assert.equal(extractorRequests.length, 2, '两楼顺序提取仍只各发一次原有模型请求');
  assert.equal(extractorRequests[0].payload.previousFloorContext, null, '第一楼没有已保存前楼上下文');
  assert.deepEqual(extractorRequests[1].payload.previousFloorContext, {
    time: '十月四日晚九点',
    summaryTail: firstSummary.trim().slice(-300),
  });
  assert.equal(extractorRequests[1].payload.previousFloorContext.summaryTail.length, 300);
  assert.equal(extractorRequests[1].payload.precedingUserInput.length, 0, '前楼辅助上下文不得扩大 USER 来源');
  assert.equal(JSON.stringify(extractorRequests[1].payload.previousFloorContext).includes('十二月二十日'), false, '不得读取目标楼之后的未来楼');

  const state = h.runtime.getState();
  assert.equal(state.floors[0].memory.chronology[0].time.sourceText, '十月四日晚九点', '本楼明确时间保持最高锚');
  assert.equal(state.floors[1].memory.chronology[0].time.sourceText, '同日稍后');
  assert.equal(state.floors[1].memory.chronology[0].time.kind, 'relative', '模型合理相对时间沿原归一化保存');
  const graph = await h.store.readReachable({ mode: 'runtime' });
  const expectedFingerprint = `sha256:${createHash('sha256').update(JSON.stringify(extractorRequests[1].payload)).digest('hex')}`;
  assert.equal(graph.run.diagnostics.floorProvenance[secondFloor.floorId].semanticInputFingerprint, expectedFingerprint, '辅助上下文必须进入本次语义输入指纹');
});

test('残缺同楼时间戳进入同次提取并作非 exact 兜底，前序参照只取目标楼之前且不读取未来楼', async () => {
  const full = (date, start, end) => `<!-- myknots-start | date=${date} | weekday=周二 | time=${start} -->正文<!-- myknots-end | date=${date} | weekday=周二 | time=${end} -->`;
  const partial = '<!-- myknots-start | date=10月5日 | time=10:15 -->目标楼正文。';
  const h = harness({
    initialChat: [
      user('开始'),
      assistant(full('10月4日', '09:00', '09:30')),
      assistant(partial),
      assistant(full('12月20日', '20:00', '20:30')),
      assistant('待确认尾楼。'),
    ],
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: '目标楼摘要，模型未返回时间。' } }
      : { jsonData: { noMaterialChange: true } },
  });
  await h.runtime.start();
  const target = h.runtime.getState().floors[1];
  await h.runtime.extractFloor(target.floorId, { analyzeState: false });

  const extractorCalls = h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT);
  assert.equal(extractorCalls.length, 1, '残缺时间兜底不得增加额外模型请求');
  const payload = JSON.parse(extractorCalls[0].taskMessages[0].content).payload;
  assert.equal(payload.storyClock.complete, false);
  assert.equal(payload.storyClock.start.date, '10月5日');
  assert.equal(payload.storyClock.start.weekday, null);
  assert.equal(payload.storyClock.start.time, '10:15');
  assert.equal(payload.storyClock.end, null);
  assert.equal(payload.previousStoryClock.complete, true);
  assert.equal(payload.previousStoryClock.end.date, '10月4日');
  assert.equal(JSON.stringify(payload.previousStoryClock).includes('12月20日'), false, '不得把目标楼之后的时间戳作为前序参照');

  const memory = h.runtime.getState().floors[1].memory;
  assert.match(memory.chronology[0].time.sourceText, /10月5日.*10:15/);
  assert.notEqual(memory.chronology[0].time.precision, 'exact');
});

test('原文时间参考标签进入本楼与前楼语义输入，漏写时间时整段 unresolved 兜底且不读取未来楼', async () => {
  const h = harness({
    storyClockReferenceTags: 'Ti',
    initialChat: [
      user('开始'),
      assistant('<Slate><Ti>第三次忍界大战后某年·7月15日·18:00</Ti><content>前楼正文。</content></Slate>'),
      assistant('<Slate><Ti>0081年10月20日·清晨·06:12</Ti><content>目标正文。</content><Ti>0081年10月20日·午前·10:40</Ti></Slate>'),
      assistant('<Slate><Ti>0081年12月20日·晚上·20:30</Ti><content>未来楼正文。</content></Slate>'),
      assistant('用于确认上一楼稳定。'),
    ],
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: '目标楼摘要，模型未返回时间。' } }
      : { jsonData: { noMaterialChange: true } },
  });
  await h.runtime.start();
  const target = h.runtime.getState().floors[1];
  await h.runtime.extractFloor(target.floorId, { analyzeState: false });

  const extractorCalls = h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT);
  assert.equal(extractorCalls.length, 1, '标签时间参考不得增加模型请求');
  const payload = JSON.parse(extractorCalls[0].taskMessages[0].content).payload;
  assert.equal(payload.canonicalContent, '目标正文。');
  assert.equal(payload.storyClock.referenceText, '0081年10月20日·清晨·06:12\n0081年10月20日·午前·10:40');
  assert.equal(payload.storyClock.complete, false);
  assert.equal(payload.storyClock.start, null);
  assert.equal(payload.previousStoryClock.referenceText, '第三次忍界大战后某年·7月15日·18:00');
  assert.equal(JSON.stringify(payload.previousStoryClock).includes('12月20日'), false, '不得把目标楼之后的标签时间作为前序参照');

  const memory = h.runtime.getState().floors[1].memory;
  assert.equal(memory.chronology[0].time.sourceText, '0081年10月20日·清晨·06:12\n0081年10月20日·午前·10:40');
  assert.equal(memory.chronology[0].time.kind, 'unknown');
  assert.equal(memory.chronology[0].time.precision, 'unresolved');
});

test('模型已返回的正常 chronology 不被原文时间参考标签覆盖', async () => {
  const h = harness({
    storyClockReferenceTags: 'Ti',
    initialChat: [user('开始'), assistant('<Ti>时间不明</Ti><content>目标正文。</content>'), assistant('用于确认上一楼稳定。')],
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: '目标楼摘要。', time: [{ sourceText: '同日稍后', kind: 'relative', description: '同日稍后。' }] } }
      : { jsonData: { noMaterialChange: true } },
  });
  await h.runtime.start();
  const target = h.runtime.getState().floors[0];
  await h.runtime.extractFloor(target.floorId, { analyzeState: false });
  const memory = h.runtime.getState().floors[0].memory;
  assert.equal(memory.chronology[0].time.sourceText, '同日稍后');
  assert.equal(memory.chronology[0].time.kind, 'relative');
});

test('时间参考标签配置在单次提取内冻结，设置中途变化从下一次请求生效', async () => {
  let referenceTags = 'Ti';
  let extractorCount = 0;
  const h = harness({
    storyClockReferenceTags: () => referenceTags,
    initialChat: [
      user('开始'),
      assistant('<Ti>旧配置时间</Ti><content>第一楼正文。</content>'),
      assistant('<时标>新配置时间</时标><content>第二楼正文。</content>'),
      assistant('用于确认上一楼稳定。'),
    ],
    utility: options => {
      if (options.systemPrompt !== EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { noMaterialChange: true } };
      extractorCount += 1;
      if (extractorCount === 1) referenceTags = '时标';
      return { jsonData: { summary: `第 ${extractorCount} 楼摘要，模型未返回时间。` } };
    },
  });
  await h.runtime.start();
  let state = h.runtime.getState();
  await h.runtime.extractFloor(state.floors[0].floorId, { analyzeState: false });
  assert.equal(h.runtime.getState().floors[0].memory.chronology[0].time.sourceText, '旧配置时间', '在途设置变化不得作废或改写已冻结的本轮输入');
  await h.runtime.extractFloor(state.floors[1].floorId, { analyzeState: false });
  const payloads = h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).map(call => JSON.parse(call.taskMessages[0].content).payload);
  assert.equal(payloads[0].storyClock.referenceText, '旧配置时间');
  assert.equal(payloads[1].storyClock.referenceText, '新配置时间');
  assert.equal(h.runtime.getState().floors[1].memory.chronology[0].time.sourceText, '新配置时间');
});

test('时间、地点、人物与摘要一次保存，保留原有 ID/证据及已落盘 CSE，新 runtime 回读一致', async () => {
  const backend = backendHarness();
  const h = harness({ sharedBackend: backend, utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
    ? { jsonData: { summary: '原摘要', time: [{ sourceText: '当晚', description: '事情发生于当晚', evidence: '裴晚生提醒你带伞。' }], locations: [{ name: '钟楼', change: 'entered', people: ['裴晚生', '你'], evidence: '裴晚生提醒你带伞。' }], people: [{ name: '裴晚生', presence: 'present', evidence: '裴晚生提醒你带伞。' }, { name: '你', role: 'user', presence: 'present', evidence: '裴晚生提醒你带伞。' }] } }
    : { jsonData: { noMaterialChange: true } } });
  await h.runtime.start(); await h.runtime.extractNext();
  let state = h.runtime.getState(), floor = state.floors[0], memory = floor.memory;
  const entity = state.memoryEntities.find(item => item.displayName === '裴晚生'), userEntity = state.memoryEntities.find(item => item.specialRole === 'user');
  const chronologyId = memory.chronology[0].itemId, locationId = memory.locations[0].itemId;
  const oldChronologyEvidence = structuredClone(memory.chronology[0].evidenceRefs), oldLocation = structuredClone(memory.locations[0]);
  const oldParticipantEvidence = new Map(memory.participants.map(item => [item.entityId, structuredClone(item.evidenceRefs)]));
  const oldDeltaId = floor.cse.deltaId;
  await h.runtime.editMemory(floor.floorId, {
    summary: '修订后摘要',
    timeText: '次日清晨', timeChanged: true,
    locations: [{ itemId: locationId, name: '旧钟楼' }, { name: '河港' }],
    participantNames: [userEntity.displayName, entity.displayName, '新路人'], revisionNote: '核对原文',
  });
  state = h.runtime.getState(); floor = state.floors[0]; memory = floor.memory;
  assert.equal(memory.summary.userText, '修订后摘要'); assert.equal(memory.summary.revisionNote, '核对原文');
  assert.notEqual(memory.chronology[0].itemId, chronologyId); assert.equal(memory.locations[0].itemId, locationId);
  assert.deepEqual(memory.chronology[0].evidenceRefs, []); assert.equal(memory.chronology[0].time.kind, 'relative');
  assert.equal(memory.chronology[0].time.sourceText, '次日清晨'); assert.equal(memory.chronology.length, 1); assert.equal(memory.locations.length, 2);
  assert.equal(memory.locations[0].change, oldLocation.change); assert.deepEqual(memory.locations[0].participantEntityIds, oldLocation.participantEntityIds); assert.deepEqual(memory.locations[0].evidenceRefs, oldLocation.evidenceRefs);
  assert.deepEqual(memory.participants.slice(0, 2).map(item => item.entityId), [userEntity.entityId, entity.entityId]);
  for (const participant of memory.participants.slice(0, 2)) assert.deepEqual(participant.evidenceRefs, oldParticipantEvidence.get(participant.entityId));
  assert.equal(memory.participants[2].presence, 'mentioned'); assert.deepEqual(memory.participants[2].evidenceRefs, []);
  assert.ok(state.memoryEntities.some(item => item.displayName === '新路人'));
  assert.equal(floor.cse.deltaId, oldDeltaId);
  assert.equal(floor.cse.status, 'noChange');

  const reloaded = harness({ sharedBackend: backend, sharedContext: h.context, utility: () => { throw new Error('回读不应调用 AI'); } });
  await reloaded.runtime.start();
  const restored = reloaded.runtime.getState().floors[0].memory;
  assert.equal(restored.id, memory.id); assert.equal(restored.summary.userText, '修订后摘要');
  assert.deepEqual(restored.chronology.map(item => item.itemId), memory.chronology.map(item => item.itemId));
  assert.deepEqual(restored.locations.map(item => item.name), ['旧钟楼', '河港']);
});

test('摘要保存后正文普通编辑仍可人工修订摘要、时间、地点与人物', async () => {
  const h = harness({ modernAnchors: true, initialChat: [assistant('裴晚生提醒你带伞。'), user('确认这一楼'), assistant('待确认尾楼。')] });
  await h.runtime.start();
  await h.runtime.extractNext();
  const before = h.runtime.getState().floors[0];
  h.context.chat[before.messageIndex].extra = { qianqianjie_floor: { schemaVersion: 1, chatId: CHAT, floorId: before.floorId } };
  const editedRaw = '裴晚生改为提醒你带外套。';
  h.context.chat[before.messageIndex] = { ...h.context.chat[before.messageIndex], mes: editedRaw, swipes: [editedRaw], swipe_id: 0 };
  h.emit('MESSAGE_EDITED', before.messageIndex);
  await waitFor(() => h.foundationRuntime.getState().status === 'ready' && h.runtime.getState().floors.some(floor => floor.floorId === before.floorId), '正文普通编辑后地基未恢复可修订状态');
  const callsBeforeRevision = h.calls.length;

  await h.runtime.editMemory(before.floorId, {
    summary: '人工修订后的摘要',
    timeText: '次日清晨',
    originalTimeText: '时间未明确',
    timeChanged: true,
    locations: [{ name: '河港' }],
    participantNames: ['裴晚生', '新路人'],
  });

  const revised = h.runtime.getState().floors[0].memory;
  assert.equal(revised.summary.userText, '人工修订后的摘要');
  assert.equal(revised.chronology[0].time.sourceText, '次日清晨');
  assert.deepEqual(revised.locations.map(item => item.name), ['河港']);
  const names = new Map(h.runtime.getState().memoryEntities.map(entity => [entity.entityId, entity.displayName]));
  assert.deepEqual(revised.participants.map(item => names.get(item.entityId)), ['裴晚生', '新路人']);
  assert.equal(h.calls.length, callsBeforeRevision, '人工修订不得重新提取或调用模型');
});

test('时间输入改后又恢复原值只保存其他字段，不改 chronology 或误标人工时间', async () => {
  const h = harness();
  await h.runtime.start(); await h.runtime.extractNext();
  const before = h.runtime.getState().floors[0];
  const chronology = structuredClone(before.memory.chronology);
  const timeText = chronology.map(item => item.time?.sourceText || item.description).join('；');
  const entityNames = new Map(h.runtime.getState().memoryEntities.map(item => [item.entityId, item.displayName]));
  await h.runtime.editMemory(before.floorId, { summary: '只修摘要', timeText, originalTimeText: timeText, timeChanged: false, locations: before.memory.locations.map(item => ({ itemId: item.itemId, name: item.name })), participantNames: before.memory.participants.map(item => entityNames.get(item.entityId)).filter(Boolean) });
  const after = h.runtime.getState().floors[0];
  assert.deepEqual(after.memory.chronology, chronology);
  const reachable = await h.store.readReachable({ mode: 'runtime' });
  assert.equal(reachable.run.diagnostics.floorProvenance[before.floorId].timeEdited, false);
});

test('runtime 对完整元数据 no-op 不写记录、不前移 head 且不失效 CSE', async () => {
  const h = harness();
  await h.runtime.start(); await h.runtime.extractNext();
  let state = h.runtime.getState(), floor = state.floors[0];
  await h.runtime.editMemory(floor.floorId, { summary: '带旧说明的摘要', timeText: '时间未明确', originalTimeText: '时间未明确', timeChanged: false, locations: [], participantNames: state.memoryEntities.filter(entity => floor.memory.participants.some(item => item.entityId === entity.entityId)).map(entity => entity.displayName), revisionNote: '旧说明' });
  state = h.runtime.getState(); floor = state.floors[0];
  const before = await h.store.readReachable({ mode: 'runtime' });
  const cseStatusBefore = h.runtime.getState().floors[0].cse.status;
  const putsBefore = h.backend.calls.filter(call => call[0] === 'put').length;
  const apiBefore = h.calls.length;
  const names = new Map(state.memoryEntities.map(entity => [entity.entityId, entity.displayName]));
  await h.runtime.editMemory(floor.floorId, { summary: floor.summary, timeText: '时间未明确', originalTimeText: '时间未明确', timeChanged: false, locations: floor.memory.locations.map(item => ({ itemId: item.itemId, name: item.name })), participantNames: floor.memory.participants.map(item => names.get(item.entityId)).filter(Boolean), revisionNote: '' });
  const after = await h.store.readReachable({ mode: 'runtime' });
  assert.equal(h.backend.calls.filter(call => call[0] === 'put').length, putsBefore);
  assert.equal(h.calls.length, apiBefore);
  assert.equal(after.rootRevision, before.rootRevision); assert.equal(after.root.headCheckpointId, before.root.headCheckpointId);
  assert.deepEqual(after.floorMemories.map(item => item.id), before.floorMemories.map(item => item.id));
  assert.deepEqual(after.stateDeltas.map(item => item.id), before.stateDeltas.map(item => item.id));
  assert.equal(h.runtime.getState().floors[0].cse.status, cseStatusBefore);
});

test('真实 runtime 保存中关闭并重开，提交完成后立即退出编辑并保持展开', async () => {
  const h = harness();
  await h.runtime.start(); await h.runtime.extractNext();
  const ui = viewHarness(h.runtime);
  const registeredCard = () => ui.flatten(ui.container).find(node => String(node.className).includes('qqj-memory-card')
    && ui.flatten(node).some(child => child.textContent === '编辑' || child.placeholder === '输入用户修订摘要'));
  let card = registeredCard(); card.open = true; card.fire('toggle');
  ui.flatten(ui.container).find(node => node.textContent === '编辑').click();
  const summary = ui.flatten(ui.container).find(node => node.placeholder === '输入用户修订摘要'); summary.value = '真实保存后的摘要'; summary.fire('input');
  const gate = h.backend.holdNextRootPut();
  ui.flatten(ui.container).find(node => node.textContent === '保存').click();
  await gate.started;
  const saving = ui.flatten(ui.container).find(node => node.textContent === '保存中…'); assert.ok(saving); assert.equal(saving.disabled, true);
  ui.view.deactivate();
  await ui.view.activate();
  assert.ok(ui.flatten(ui.container).some(node => node.placeholder === '输入用户修订摘要'), '提交未完成时重开应继续显示本次草稿');
  gate.release();
  await waitFor(() => !h.runtime.getState().memoryWorkBusy && !ui.flatten(ui.container).some(node => node.placeholder === '输入用户修订摘要'), '真实保存完成后界面未退出编辑');
  card = registeredCard();
  assert.equal(card.open, true); assert.match(ui.flatten(card).map(node => node.textContent).join('|'), /真实保存后的摘要/);
  assert.equal(ui.flatten(ui.container).some(node => node.textContent === '保存中…'), false);
  ui.view.deactivate(); await ui.view.activate();
  assert.equal(registeredCard().open, true, '保存完成后再关闭重开仍应保持展开');
  assert.equal(ui.flatten(ui.container).some(node => node.placeholder === '输入用户修订摘要'), false);

  card = registeredCard(); card.open = true; card.fire('toggle');
  ui.flatten(ui.container).find(node => node.textContent === '编辑').click();
  const secondSummary = ui.flatten(ui.container).find(node => node.placeholder === '输入用户修订摘要'); secondSummary.value = '面板关闭期间完成的摘要'; secondSummary.fire('input');
  const inactiveGate = h.backend.holdNextRootPut();
  ui.flatten(ui.container).find(node => node.textContent === '保存').click();
  await inactiveGate.started;
  ui.view.deactivate(); inactiveGate.release();
  await waitFor(() => !h.runtime.getState().memoryWorkBusy, '面板关闭期间后台保存未完成');
  await ui.view.activate();
  card = registeredCard();
  assert.equal(card.open, true, '面板关闭期间保存完成后首次重开就应保持展开');
  assert.equal(ui.flatten(ui.container).some(node => node.placeholder === '输入用户修订摘要'), false);
  assert.match(ui.flatten(card).map(node => node.textContent).join('|'), /面板关闭期间完成的摘要/);
});

test('真实 runtime 保存 CAS 失败时保留草稿、显示错误并恢复按钮', async () => {
  const h = harness();
  await h.runtime.start(); await h.runtime.extractNext();
  const before = await h.store.readReachable({ mode: 'runtime' });
  const ui = viewHarness(h.runtime);
  const card = ui.flatten(ui.container).find(node => String(node.className).includes('qqj-memory-card')); card.open = true; card.fire('toggle');
  ui.flatten(ui.container).find(node => node.textContent === '编辑').click();
  const summary = ui.flatten(ui.container).find(node => node.placeholder === '输入用户修订摘要'); summary.value = '失败时保留的草稿'; summary.fire('input');
  h.backend.setConflictRoot(true);
  ui.flatten(ui.container).find(node => node.textContent === '保存').click();
  await waitFor(() => !h.runtime.getState().memoryWorkBusy && ui.flatten(ui.container).some(node => String(node.textContent).includes('保存失败')), '保存失败后界面未恢复');
  const after = await h.store.readReachable({ mode: 'runtime' });
  const restoredInput = ui.flatten(ui.container).find(node => node.placeholder === '输入用户修订摘要');
  assert.equal(restoredInput.value, '失败时保留的草稿');
  const save = ui.flatten(ui.container).find(node => node.textContent === '保存'); assert.ok(save); assert.equal(save.disabled, false);
  assert.equal(ui.flatten(ui.container).find(node => String(node.className).includes('qqj-memory-card')).open, true);
  assert.equal(after.rootRevision, before.rootRevision); assert.equal(after.root.headCheckpointId, before.root.headCheckpointId);
});

test('人物手填复用已有 alias，且同名歧义优先本楼原 participant', async () => {
  const h = harness({
    initialChat: [user('开始'), assistant('建立人物目录。'), assistant('甲在目标楼出现。'), assistant('待确认尾楼。')],
    utility: options => {
      if (options.systemPrompt !== EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { noMaterialChange: true } };
      const content = JSON.parse(options.taskMessages[0].content).payload.canonicalContent;
      return content.includes('建立人物目录')
        ? { jsonData: { summary: '建立目录。', people: [{ name: '甲', aliases: ['共同称呼'] }, { name: '乙', aliases: ['共同称呼'] }, { name: '裴晚生', aliases: ['裴生'] }] } }
        : { jsonData: { summary: '甲出现。', people: [{ name: '甲' }] } };
    },
  });
  await h.runtime.start();
  let state = h.runtime.getState();
  await h.runtime.extractFloor(state.floors[0].floorId, { analyzeState: false });
  state = h.runtime.getState();
  await h.runtime.extractFloor(state.floors[1].floorId, { analyzeState: false });
  state = h.runtime.getState();
  const target = state.floors[1];
  const personA = state.memoryEntities.find(entity => entity.displayName === '甲');
  const personB = state.memoryEntities.find(entity => entity.displayName === '乙');
  const aliasPerson = state.memoryEntities.find(entity => entity.displayName === '裴晚生');
  assert.ok(personA && personB && aliasPerson);
  assert.deepEqual(target.memory.participants.map(item => item.entityId), [personA.entityId], '前置条件：目标楼只有甲参与');
  const entityCount = state.memoryEntities.length;

  await h.runtime.editMemory(target.floorId, { summary: target.summary, participantNames: ['共同称呼', '裴生'], locations: [] });
  state = h.runtime.getState();
  const revised = state.floors[1].memory;
  assert.deepEqual(revised.participants.map(item => item.entityId), [personA.entityId, aliasPerson.entityId], '歧义称呼应先命中本楼甲，唯一 alias 应复用裴晚生');
  assert.equal(revised.participants.some(item => item.entityId === personB.entityId), false);
  assert.equal(state.memoryEntities.length, entityCount, '输入已有 alias 不得创建重复实体');
});

test('自动记忆关闭时 runtime 启动不调用历史提取或 CSE', async () => {
  const h = harness({
    initialChat: [user('开始'), assistant('历史一'), assistant('历史二'), assistant('待确认尾楼')],
    automation: { enabled: false, batchSize: 2 },
  });
  await h.runtime.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.calls.length, 0);
  assert.equal(h.runtime.getState().rebuildStatus, 'pendingRebuild');
});

test('没有来源证明的旧 completed0 保持历史授权边界且零 API', async () => {
  const notifications = [];
  const oldChat = harness({
    initialChat: [user('开始'), assistant('刷新前已有回复'), assistant('用于确认旧回复稳定')],
    automation: { enabled: true, batchSize: 2 },
    notifyUser: value => notifications.push(value),
  });
  await oldChat.runtime.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(oldChat.runtime.getState().stableCount, 1);
  assert.equal(oldChat.runtime.getState().rebuildStatus, 'pendingRebuild');
  assert.equal(oldChat.runtime.allowsRealtimeTailFromEmpty(), false);
  assert.equal(oldChat.calls.length, 0);
  assert.deepEqual(notifications, [{ kind: 'warning', text: '千千结发现需要用户确认的历史摘要缺口：从第 1 楼起还有 1 楼摘要未完成；这是历史缺口，不会自动补，请在记忆管理中点击继续。' }]);
  await oldChat.runtime.refreshAutomation();
  assert.equal(notifications.length, 1, '同一历史授权缺口的设置刷新不得重复提示');
});

test('中间摘要断档只读检查按实际缺失楼计数，后方已有摘要不计入未完成数量', async () => {
  for (const failCse of [false, true]) {
    const seed = await seedMiddleSummaryGap();
    const notifications = [];
    const resumed = harness({
      automation: { enabled: true, batchSize: 1 }, sharedBackend: seed.backend, sharedContext: seed.context,
      notifyUser: value => notifications.push(value),
      utility: options => {
        assert.equal(options.systemPrompt, CSE_SYSTEM_PROMPT);
        if (failCse) throw new Error('模拟中间断档前的 CSE 失败');
        return { jsonData: { noMaterialChange: true } };
      },
    });
    await resumed.runtime.start();
    const state = resumed.runtime.getState();
    assert.equal(state.summaryCompletedCount, 2);
    assert.equal(state.rememberedCount, 2);
    assert.equal(state.unprocessedCount, 1, '后方已有摘要不得重复计入摘要缺口');
    assert.equal(state.rebuildStatus, 'pendingRebuild');
    assert.equal(resumed.calls.length, 0, '启动只检查缺口，不得调用摘要或人物状态模型');
  }
});

test('失配标记与孤立标记都不能把旧聊天变成实时来源', async () => {
  const h = harness({
    initialChat: [user('开始'), assistant('旧楼'), assistant('尾楼')],
    automation: { enabled: true, batchSize: 2 },
  });
  await h.runtime.start();
  const reachable = await h.store.readReachable({ mode: 'runtime' });
  const collection = `chat-${CHAT}`;
  const reachableKey = `v3-run-${reachable.run.id}`;
  const currentEnvelope = h.backend.records.get(`${collection}/${reachableKey}`);
  currentEnvelope.data.diagnostics = { ...(currentEnvelope.data.diagnostics ?? {}), realtimeOriginV1: {
    chatId: reachable.root.chatId,
    narrativeGeneration: reachable.root.narrativeGeneration,
    sourceSnapshotFingerprint: `sha256:${'0'.repeat(64)}`,
  } };
  const orphanId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  h.backend.records.set(`${collection}/v3-run-${orphanId}`, { revision: 1, data: {
    ...structuredClone(reachable.run),
    id: orphanId,
    diagnostics: { realtimeOriginV1: {
      chatId: reachable.root.chatId,
      narrativeGeneration: reachable.root.narrativeGeneration,
      sourceSnapshotFingerprint: reachable.root.sourceSnapshotFingerprint,
    } },
  } });
  h.runtime.invalidate();
  const recreated = harness({ automation: { enabled: true, batchSize: 2 }, sharedBackend: h.backend, sharedContext: h.context });
  await recreated.runtime.start();
  assert.equal(recreated.runtime.allowsRealtimeTailFromEmpty(), false);
  assert.equal(recreated.runtime.getState().rebuildStatus, 'pendingRebuild');
  assert.equal(recreated.calls.length, 0);
});

test('同 runtime 切换到不同 chat 后不沿用实时来源证明', async () => {
  const otherChat = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const h = harness({ modernAnchors: true, initialChat: [user('开始'), assistant('开场白'), user('确认开场白'), assistant('待确认尾楼')], automation: { enabled: true, batchSize: 2 } });
  await primeRealtimeTail(h);
  h.context.chat.push(user('继续'));
  h.emit('MESSAGE_SENT', h.context.chat.length - 1);
  await waitFor(() => h.calls.length === 2 && !h.runtime.getState().memoryWorkBusy);
  const callsBeforeSwitch = h.calls.length;
  h.context.chatMetadata = { qianqianjie: { schemaVersion: 1, chatId: otherChat } };
  h.context.chatId = 'host-other-chat';
  h.context.chat = [user('开始'), assistant('别的聊天旧楼'), user('确认别的聊天旧楼'), assistant('别的聊天尾楼')];
  h.emit('CHAT_CHANGED');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(h.runtime.getState().chatId, null, '未初始化的新聊天不得沿用旧聊天记忆 ID');
  assert.equal(h.runtime.getState().canInitialize, true, JSON.stringify(h.runtime.getState()));
  assert.equal(h.calls.length, callsBeforeSwitch);
  assert.equal(h.backend.records.has(`chat-${otherChat}/v3-root`), false, '切到未初始化聊天只检查，不得自动写入新 root');
});

test('已初始化聊天关闭自动维护后，新增稳定楼保持等待且零记忆 API', async () => {
  const h = harness({
    initialChat: [user('开始'), assistant('开场白'), assistant('待确认尾楼')],
    automation: { enabled: false, batchSize: 2 },
  });
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => ['caughtUp', 'waitingRealtime'].includes(h.runtime.getState().rebuildStatus));
  h.calls.splice(0);
  assert.equal(h.runtime.getState().rememberedCount, 1, '测试前必须已经显式初始化有效记忆');
  h.context.chat.push(assistant('自动维护关闭后的新增回复'));
  h.emit('MESSAGE_RECEIVED');
  await waitFor(() => {
    const state = h.runtime.getState();
    return state.stableCount === 2 && state.rebuildStatus === 'waitingRealtime' && !state.memoryWorkBusy;
  }, '关闭自动维护后未收敛到实时等待终态');
  assert.equal(h.runtime.getState().summaryCompletedCount, 1);
  assert.equal(h.runtime.getState().rebuildStatus, 'waitingRealtime');
  assert.equal(h.calls.length, 0);
  assert.equal(h.runtime.shouldBlockMainGeneration(), false);
});

test('runtime 的缺失或非法批次兜底为 1，首个稳定楼即可正常完成', async () => {
  for (const batchSize of [undefined, 0, 21, 1.5, 'bad']) {
    const h = harness({
      modernAnchors: true,
      initialChat: [user('开始'), assistant('开场白'), user('确认开场白'), assistant('待确认尾楼')],
      automation: { enabled: true, batchSize },
      utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
        ? { jsonData: { summary: '默认一楼摘要' } }
        : { jsonData: { noMaterialChange: true } },
    });
    await h.runtime.start();
    assert.equal(h.runtime.getState().autoMemoryBatchSize, 1);
    await h.runtime.startHistoricalRebuild();
    await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()));
    h.calls.splice(0);
    h.context.chat.push(user('继续'));
    h.emit('MESSAGE_SENT', h.context.chat.length - 1);
    await waitFor(() => h.calls.length === 2 && !h.runtime.getState().memoryWorkBusy);
    assert.equal(h.runtime.getState().rememberedCount, 2);
    assert.deepEqual(h.calls.map(call => call.systemPrompt), [EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT]);
  }
});

test('CSE 失败不再拖停后续摘要，同一稳定快照只有限尝试且手动继续按序补齐', async () => {
  let cseCalls = 0;
  let failCse = true;
  const notifications = [];
  const h = harness({
    initialChat: [user('开始'), assistant('旧楼已由用户完成维护。'), assistant('第一条实时回复。')],
    automation: { enabled: false, batchSize: 1 },
    notifyUser: value => notifications.push(value),
    utility: options => {
      if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) {
        const content = JSON.parse(options.taskMessages[0].content).payload.canonicalContent;
        return { jsonData: { summary: `摘要-${content}` } };
      }
      cseCalls += 1;
      if (failCse && cseCalls > 1) throw Object.assign(new Error('模拟人物状态服务失败'), { transportAttempts: 3 });
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await primeRealtimeTail(h);
  notifications.splice(0);
  const completedOld = await h.store.readReachable({ mode: 'runtime' });
  assert.equal(Object.hasOwn(completedOld.run?.diagnostics ?? {}, 'realtimeOriginV1'), false, '用户完成的旧前缀不依赖 realtimeOrigin');

  h.context.chat.push(assistant('第二条实时回复。'));
  h.emit('MESSAGE_RECEIVED');
  await waitFor(() => h.runtime.getState().lastAutoMemory?.status === 'partial' && !h.runtime.getState().memoryWorkBusy);
  let state = h.runtime.getState();
  assert.equal(state.rememberedCount, 2, 'CSE 失败前摘要必须已经保存');
  assert.equal(state.rebuildCompletedCount, 1);
  assert.equal(state.summaryCompletedCount, 2);
  assert.equal(h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, 1);
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 1);
  assert.equal(notifications.filter(item => item.kind === 'warning').length, 1);
  assert.match(notifications.at(-1).text, /人物状态分析失败.*后续.*有限重试/);

  h.context.chat.push(assistant('第三条实时回复。'));
  h.emit('MESSAGE_RECEIVED');
  await waitFor(() => h.runtime.getState().lastAutoMemory?.status === 'partial' && h.runtime.getState().rememberedCount === 3 && !h.runtime.getState().memoryWorkBusy);
  state = h.runtime.getState();
  assert.equal(state.summaryCompletedCount, 3, '没有 realtimeOrigin 的正常已建前缀仍应继续补新摘要');
  assert.equal(state.rebuildCompletedCount, 1, '旧 CSE 缺口失败时不得越过它写后楼 delta');
  assert.equal(h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, 2);
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 2, '新稳定输入只重试最早 CSE 一次');

  const callsAtSettledSnapshot = h.calls.length;
  h.emit('MESSAGE_RECEIVED');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.calls.length, callsAtSettledSnapshot, '同一稳定快照重复事件不得重复摘要或 CSE');

  const warningsBeforeManualRetry = notifications.filter(item => item.kind === 'warning').length;
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => h.runtime.getState().lastAutoMemory?.status === 'failed' && !h.runtime.getState().memoryWorkBusy);
  assert.equal(notifications.filter(item => item.kind === 'warning').length, warningsBeforeManualRetry + 1, '同一快照下用户手动发起的新逻辑任务失败仍须提示一次');
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 3, '一次逻辑任务即使内部记录 3 次 transport，也只形成一次最终失败提示');

  failCse = false;
  const extractorCallsBeforeContinue = h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length;
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()) && !h.runtime.getState().memoryWorkBusy);
  state = h.runtime.getState();
  assert.equal(state.rebuildCompletedCount, 3);
  assert.equal(h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, extractorCallsBeforeContinue, '手动继续不得重提已保存摘要');
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 5, '手动继续只按顺序补两处人物状态');
});

test('历史 CSE 连续失败时每份新摘要只唤醒一次，无新摘要不自旋且继续只补人物状态', async () => {
  let failCse = true;
  const notifications = [];
  const h = harness({
    initialChat: [user('开始'), assistant('历史一'), assistant('历史二'), assistant('历史三'), assistant('待确认尾楼')],
    automation: { enabled: false, batchSize: 1 },
    notifyUser: value => notifications.push(value),
    utility: options => {
      if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) {
        const content = JSON.parse(options.taskMessages[0].content).payload.canonicalContent;
        return { jsonData: { summary: `摘要-${content}` } };
      }
      if (failCse) throw new Error('模拟首个历史 CSE 失败');
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => h.runtime.getState().lastAutoMemory?.status === 'partial' && !h.runtime.getState().memoryWorkBusy);
  let state = h.runtime.getState();
  assert.equal(h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, 3);
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 3,
    '首份摘要失败后，后两份成功摘要应各提供一次同楼重试机会');
  assert.equal(state.rememberedCount, 3, JSON.stringify({ floors: state.floors.map(floor => ({ status: floor.status, summary: floor.summary })), warnings: h.warnings }));
  assert.equal(state.summaryCompletedCount, 3);
  assert.deepEqual(state.floors.map(floor => floor.cse.status), ['failed', 'pending', 'pending']);
  assert.equal(state.lastAutoMemory.summarySaved, 3);
  assert.equal(state.lastAutoMemory.cseProcessed, 0);
  assert.equal(notifications.filter(item => item.kind === 'warning').length, 1, '同一次逻辑任务只提示一次最终失败');
  assert.match(notifications.find(item => item.kind === 'warning').text, /新摘要保存时会从本楼再试.*点击继续/);
  const memoryIds = state.floors.map(floor => floor.memoryId);
  const callsAtFailure = h.calls.length;
  await h.runtime.refreshStatus();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.calls.length, callsAtFailure, '没有新摘要提交时，刷新和状态通知都不得原地重试');
  assert.equal(notifications.filter(item => item.kind === 'warning').length, 1, '相同快照刷新不得重复失败通知');

  failCse = false;
  const extractorCalls = h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length;
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()) && !h.runtime.getState().memoryWorkBusy);
  state = h.runtime.getState();
  assert.equal(h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, extractorCalls, '继续补齐不得重提已保存摘要');
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 6, '继续补齐应从首个失败 CSE 开始按序完成三楼');
  assert.deepEqual(state.floors.map(floor => floor.memoryId), memoryIds, '继续补齐不得替换原三楼摘要记录');
  assert.deepEqual(state.floors.map(floor => floor.cse.status), ['noChange', 'noChange', 'noChange']);
});

test('CSE 前置读取或成功落盘后的同步失败只停本次 drain，新摘要提交后接续且不重算已保存楼', async t => {
  for (const failurePoint of ['beforeCse', 'afterCseCommit']) await t.test(failurePoint, async () => {
    let historicalSummaryStarted = false;
    let failNextRootRead = false;
    let failureArmed = false;
    let deltaWritten = false;
    let readFailures = 0;
    const cseContents = [];
    const h = harness({
      initialChat: [user('开始'), assistant('初始化前缀'), assistant('批楼甲'), assistant('批楼乙'), assistant('批楼丙'), user('稳定')],
      utility: options => {
        const request = JSON.parse(options.taskMessages[0].content);
        if (request.task === 'extractFloorSemantics') {
          if (request.payload.canonicalContent === '批楼甲') historicalSummaryStarted = true;
          return { jsonData: { summary: request.payload.canonicalContent } };
        }
        cseContents.push(request.payload.canonicalContent);
        return { jsonData: { noMaterialChange: true } };
      } });
    h.backend.setBeforePut(({ key }) => {
      if (!historicalSummaryStarted || failureArmed) return;
      if (failurePoint === 'beforeCse' && key === 'v3-root') {
        failureArmed = true;
        failNextRootRead = true;
      } else if (failurePoint === 'afterCseCommit') {
        if (key.startsWith('v3-state-delta-')) deltaWritten = true;
        if (deltaWritten && key === 'v3-root') {
          failureArmed = true;
        }
      }
    });
    h.backend.setBeforeGet(({ key }) => {
      if (!failNextRootRead || key !== 'v3-root') return;
      failNextRootRead = false;
      readFailures += 1;
      throw Object.assign(new Error('受控读取超时'), { code: 'BACKEND_TIMEOUT' });
    });
    await h.runtime.start();
    await h.runtime.startHistoricalRebuild();
    await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()) && !h.runtime.getState().memoryWorkBusy,
      () => `${failurePoint} 未恢复 ${JSON.stringify({ state: h.runtime.getState().lastAutoMemory,
        floors: h.runtime.getState().floors.map(floor => ({ status: floor.status, cse: floor.cse.status })),
        readFailures, cseContents, warnings: h.warnings })}`);
    assert.equal(readFailures, failurePoint === 'beforeCse' ? 1 : 0,
      'CSE 已提交的验证图应直接复用，不再安排一次提交后整图读取');
    assert.deepEqual(cseContents, ['初始化前缀', '批楼甲', '批楼乙', '批楼丙'], '读取异常不能重发已保存楼的模型请求');
    assert.deepEqual(h.runtime.getState().floors.map(floor => floor.cse.status), Array(4).fill('noChange'));
    assert.equal(h.runtime.getState().cseFailedCount, 0);
    assert.equal(h.runtime.getState().memorySyncError, null);
  });
});

test('摘要人工修订不制造 CSE 欠账，重开与刷新均零模型调用', async () => {
  const initial = harness({
    initialChat: [user('开始'), assistant('第0楼'), assistant('第2楼'), assistant('第4楼'), assistant('稳定尾楼')],
    automation: { enabled: false, batchSize: 1 },
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: `摘要-${JSON.parse(options.taskMessages[0].content).payload.canonicalContent}` } }
      : { jsonData: { noMaterialChange: true } },
  });
  await initial.runtime.start();
  await initial.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(initial.runtime.getState()));
  const secondFloor = initial.runtime.getState().floors[1];
  await initial.runtime.editSummary(secondFloor.floorId, '用户修订但仍是有效摘要');
  assert.equal(initial.runtime.getState().summaryCompletedCount, 3);
  assert.equal(initial.runtime.getState().rebuildCompletedCount, 3);

  const resumed = harness({
    automation: { enabled: true, batchSize: 1 }, sharedBackend: initial.backend, sharedContext: initial.context,
    utility: () => { throw new Error('已完成记录不应调用模型'); },
  });
  await resumed.runtime.start();
  assert.equal(resumed.calls.length, 0);
  await resumed.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(resumed.runtime.getState()) && !resumed.runtime.getState().memoryWorkBusy);
  assert.deepEqual(resumed.calls, []);
  assert.equal(resumed.runtime.getState().lastAutoMemory.cseProcessed ?? 0, 0);
  assert.equal(resumed.runtime.getState().lastAutoMemory.processed, 0);
  await resumed.runtime.refreshStatus();
  await resumed.runtime.refreshAutomation();
  assert.deepEqual(resumed.calls, []);
});

test('启动与设置刷新只检查连续摘要尾账，手动继续才按楼补完摘要与 CSE', async () => {
  for (const [mode, debtCount] of [['startup', 3], ['refresh', 4]]) {
    const seed = await seedContinuousSummaryTail(debtCount);
    const resumed = harness({
      automation: { enabled: mode === 'startup', batchSize: 1 },
      sharedBackend: seed.backend,
      sharedContext: seed.context,
      utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
        ? { jsonData: { summary: `补齐-${JSON.parse(options.taskMessages[0].content).payload.canonicalContent}` } }
        : { jsonData: { noMaterialChange: true } },
    });
    await resumed.runtime.start();
    if (mode === 'refresh') {
      assert.equal(resumed.calls.length, 0);
      resumed.setAutomation({ enabled: true, batchSize: 1 });
      await resumed.runtime.refreshAutomation();
    }
    assert.equal(resumed.calls.length, 0, `${mode} 只检查，不应自动补连续摘要尾账`);
    await resumed.runtime.startHistoricalRebuild();
    await waitFor(() => registeredGraphCaughtUp(resumed.runtime.getState()) && !resumed.runtime.getState().memoryWorkBusy, `${mode} 未追平连续摘要尾账`);
    const requests = resumed.calls.map(call => ({ call, request: JSON.parse(call.taskMessages[0].content) }));
    const summaryRequests = requests.filter(({ request }) => request.task === 'extractFloorSemantics');
    assert.equal(summaryRequests.length, debtCount, '历史续跑必须按缺楼逐楼调用摘要');
    assert.ok(summaryRequests.every(({ request }) => !Object.hasOwn(request, 'floors')), '单楼请求不得残留批量 floors 包');
    assert.equal(requests.filter(({ request }) => request.task === 'understandCharacterStateAfterFloor').length, debtCount);
    const cseContents = resumed.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).map(call => JSON.parse(call.taskMessages[0].content).payload.canonicalContent);
    const summaryContents = summaryRequests.map(({ request }) => request.payload.canonicalContent);
    assert.deepEqual(cseContents, summaryContents, `${mode} 逐楼CSE必须保留摘要顺序`);
    assert.equal(resumed.runtime.getState().lastAutoMemory.processed, debtCount);
    assert.equal(resumed.runtime.getState().lastAutoMemory.cseProcessed, debtCount);
  }
});

test('首个 CSE 失败前已捕获摘要全部保存；提取失败跳过本楼继续独立后楼且同输入不循环调用', async () => {
  const cseSeed = await seedContinuousSummaryTail(4);
  const cseNotifications = [];
  const cseFailed = harness({
    automation: { enabled: true, batchSize: 1 }, sharedBackend: cseSeed.backend, sharedContext: cseSeed.context,
    notifyUser: value => cseNotifications.push(value),
    utility: options => {
      if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { summary: '连续尾部摘要' } };
      throw new Error('模拟首个 CSE 失败');
    },
  });
  await cseFailed.runtime.start();
  completeTailSwipe(cseFailed, '触发自动追赶的真实 roll');
  await waitFor(() => cseFailed.runtime.getState().lastAutoMemory?.status === 'partial' && !cseFailed.runtime.getState().memoryWorkBusy);
  assert.equal(cseFailed.runtime.getState().summaryCompletedCount, 5);
  assert.equal(cseFailed.calls.filter(call => JSON.parse(call.taskMessages[0].content).task === 'extractFloorSemantics').length, 4,
    '首个 CSE 失败时摘要仍应按楼继续推进');
  assert.equal(cseFailed.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 1);
  assert.match(cseNotifications.at(-1).text, /第 2 楼人物状态未完成，未完成摘要 0 楼.*后续有新稳定回复时会有限重试/);

  const extractorSeed = await seedContinuousSummaryTail(3);
  let extractorCalls = 0;
  let failExtractor = true;
  const extractorNotifications = [];
  const extractorFailed = harness({
    automation: { enabled: true, batchSize: 1 }, sharedBackend: extractorSeed.backend, sharedContext: extractorSeed.context,
    notifyUser: value => extractorNotifications.push(value),
    utility: options => {
      if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) {
        extractorCalls += 1;
        if (failExtractor && extractorCalls === 2) throw new Error('模拟第二楼提取失败');
        return { jsonData: { summary: '成功保存的尾部摘要' } };
      }
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await extractorFailed.runtime.start();
  completeTailSwipe(extractorFailed, '触发摘要失败的真实 roll');
  await waitFor(() => extractorFailed.runtime.getState().lastAutoMemory?.status === 'partial' && !extractorFailed.runtime.getState().memoryWorkBusy);
  assert.equal(extractorFailed.runtime.getState().summaryCompletedCount, 3, '摘要完成数按实际已保存楼统计，包含失败楼之后的独立成功楼');
  assert.equal(extractorFailed.runtime.getState().rememberedCount, 3, '失败楼后的独立摘要仍应保存');
  assert.equal(extractorFailed.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 2, '摘要失败不阻断其它已有摘要楼的独立 CSE');
  assert.match(extractorNotifications.at(-1).text, /部分完成.*摘要仍需重试/);
  const callsAtFailure = extractorFailed.calls.length;
  const noticesAtFailure = extractorNotifications.length;
  await extractorFailed.runtime.refreshStatus();
  await extractorFailed.runtime.refreshAutomation();
  extractorFailed.emit('MESSAGE_RECEIVED');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(extractorFailed.calls.length, callsAtFailure, '同一输入不得循环调用 extractor');
  assert.equal(extractorNotifications.length, noticesAtFailure, '同一输入不得重复提示');
  failExtractor = false;
  await extractorFailed.runtime.retryAutomation();
  await waitFor(() => registeredGraphCaughtUp(extractorFailed.runtime.getState()) && !extractorFailed.runtime.getState().memoryWorkBusy);
  assert.equal(extractorFailed.runtime.getState().summaryCompletedCount, 4, '用户手动继续后应从失败楼补齐');
  assert.equal(extractorFailed.runtime.getState().lastAutoMemory?.reason, 'manualHistoricalRebuild', '摘要历史缺口必须走已有的当前聊天补齐授权，不能给普通自动重试泛化权限');
});

test('同楼提取失败按聊天持久累计，后楼成功不清且本楼成功或真实删除才清', async () => {
  const otherKey = 'qqj_v3_floor_failures:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const storage = browserStorage({ [otherKey]: '{"keep":true}' });
  const failureByContent = new Map([['失败楼 B', true]]);
  let bFailures = 0;
  const utility = options => {
    if (options.systemPrompt !== EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { noMaterialChange: true } };
    const content = JSON.parse(options.taskMessages[0].content).payload.canonicalContent;
    if (failureByContent.get(content)) {
      if (content === '失败楼 B') bFailures += 1;
      throw Object.assign(new Error(content === '失败楼 B' ? `B 最近失败原因 ${bFailures}` : `${content} 最近失败原因`), { code: `TEST_${content.at(-1)}_FAILED` });
    }
    return { jsonData: { summary: `摘要-${content}` } };
  };
  const initialChat = [user('开始'), assistant('待处理楼 A'), assistant('失败楼 B'), assistant('成功楼 C'), assistant('待确认尾楼')];
  const first = harness({ initialChat, utility, failureStorage: storage });
  await first.runtime.start();
  const [floorA, floorB, floorC] = first.runtime.getState().floors;
  const key = storage.calls.find(call => call[0] === 'getItem')?.[1];
  assert.ok(key && key !== otherKey);
  assert.equal(storage.calls.filter(call => call[0] === 'getItem').length, 1);

  await first.runtime.extractFloor(floorB.floorId, { analyzeState: false });
  let state = first.runtime.getState();
  assert.equal(state.floors[1].status, 'failed');
  assert.match(state.floors[1].error, /连续失败 1 次；最近：B 最近失败原因 1/);
  await first.runtime.extractFloor(floorC.floorId, { analyzeState: false });
  state = first.runtime.getState();
  assert.equal(state.floors[2].status, 'ready');
  assert.match(state.floors[1].error, /连续失败 1 次/, '后楼成功不能清掉中间失败楼');
  await first.runtime.extractFloor(floorB.floorId, { analyzeState: false });
  assert.match(first.runtime.getState().floors[1].error, /连续失败 2 次；最近：B 最近失败原因 2/);

  const serialized = storage.values.get(key);
  const saved = JSON.parse(serialized);
  assert.deepEqual(Object.keys(saved).sort(), ['failures', 'narrativeGeneration']);
  assert.deepEqual(Object.keys(saved.failures), [floorB.floorId]);
  assert.equal(saved.failures[floorB.floorId].count, 2);
  assert.equal(saved.failures[floorB.floorId].code, 'TEST_B_FAILED');
  assert.doesNotMatch(serialized, /待处理楼 A|失败楼 B|成功楼 C|待确认尾楼|taskMessages|jsonData/u);
  const backendCallsBeforeProjection = first.backend.calls.length;
  first.runtime.getState(); first.runtime.getState();
  assert.equal(first.backend.calls.length, backendCallsBeforeProjection, '读取失败提示投影不能增加后端请求');
  await first.runtime.refreshStatus();
  assert.equal(storage.calls.filter(call => call[0] === 'getItem').length, 1, '同一聊天与代次重复 load 不得反复读取浏览器存储');
  first.runtime.invalidate();
  assert.equal(storage.values.has(key), true, '普通 invalidate 只清运行时投影，不能删除持久失败');

  const resumed = harness({ sharedBackend: first.backend, sharedContext: first.context, utility, failureStorage: storage });
  await resumed.runtime.start();
  state = resumed.runtime.getState();
  assert.equal(storage.calls.filter(call => call[0] === 'getItem').length, 2);
  assert.match(state.floors.find(floor => floor.floorId === floorB.floorId).error, /连续失败 2 次；最近：B 最近失败原因 2/, '刷新后必须恢复同楼次数与最近原因');
  assert.equal(state.floors.find(floor => floor.floorId === floorC.floorId).status, 'ready');

  failureByContent.set('待处理楼 A', true);
  await resumed.runtime.extractFloor(floorA.floorId, { analyzeState: false });
  failureByContent.set('失败楼 B', false);
  await resumed.runtime.extractFloor(floorB.floorId, { analyzeState: false });
  state = resumed.runtime.getState();
  assert.equal(state.floors.find(floor => floor.floorId === floorB.floorId).error, null);
  assert.match(state.floors.find(floor => floor.floorId === floorA.floorId).error, /连续失败 1 次/, '本楼成功只能清本楼，其他失败楼保留');

  const oldCSummary = state.floors.find(floor => floor.floorId === floorC.floorId).summary;
  failureByContent.set('成功楼 C', true);
  await resumed.runtime.extractFloor(floorC.floorId, { analyzeState: false });
  state = resumed.runtime.getState();
  const failedReextract = state.floors.find(floor => floor.floorId === floorC.floorId);
  assert.equal(failedReextract.status, 'ready');
  assert.equal(failedReextract.summary, oldCSummary, '已有摘要重提失败不能清空旧摘要');
  assert.match(failedReextract.error, /连续失败 1 次/);
  await resumed.runtime.editSummary(floorC.floorId, '人工修订后的 C 摘要');
  assert.equal(resumed.runtime.getState().floors.find(floor => floor.floorId === floorC.floorId).error, null, '人工修订成功应清本楼失败提示');

  resumed.runtime.invalidate({ deletedChatId: CHAT });
  assert.equal(storage.values.has(key), false, '真实删除失效后清当前聊天失败表');
  assert.equal(storage.values.get(otherKey), '{"keep":true}', '其他聊天的浏览器记录不能受影响');
});

test('失败提示存储损坏或不可写不阻断摘要流程，内存提示仍可使用', async () => {
  const calls = [];
  let fail = true;
  const failureStorage = {
    getItem() { calls.push('get'); return '{bad-json'; },
    setItem() { calls.push('set'); throw new Error('storage denied'); },
    removeItem() { calls.push('remove'); throw new Error('storage denied'); },
  };
  const h = harness({ failureStorage, utility: options => {
    if (options.systemPrompt !== EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { noMaterialChange: true } };
    if (fail) throw new Error('可选存储不可写时的提取失败');
    return { jsonData: { summary: '随后成功保存。' } };
  } });
  await h.runtime.start();
  const floorId = h.runtime.getState().floors[0].floorId;
  await h.runtime.extractFloor(floorId, { analyzeState: false });
  assert.match(h.runtime.getState().floors[0].error, /连续失败 1 次.*可选存储不可写时的提取失败/);
  assert.deepEqual(calls, ['get', 'set']);
  fail = false;
  await h.runtime.extractFloor(floorId, { analyzeState: false });
  assert.equal(h.runtime.getState().floors[0].status, 'ready');
  assert.equal(h.runtime.getState().floors[0].error, null);
  assert.deepEqual(calls, ['get', 'set', 'remove']);
});

test('CSE 楼级失败跨刷新累计并按楼清除，旧有效 delta 重析失败仍保持可用', async () => {
  const storage = browserStorage();
  let failA = true;
  let failSummaryC = false;
  const utility = options => {
    const content = JSON.parse(options.taskMessages[0].content).payload.canonicalContent;
    if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) {
      if (failSummaryC && content === '历史三') throw Object.assign(new Error('受控摘要 C 失败'), { code: 'TEST_SUMMARY_C_FAILED' });
      return { jsonData: { summary: `摘要-${content}` } };
    }
    if (failA && content === '历史一') throw Object.assign(new Error('受控 CSE A 失败'), { code: 'TEST_CSE_A_FAILED' });
    return { jsonData: { noMaterialChange: true } };
  };
  const first = harness({
    initialChat: [user('开始'), assistant('历史一'), assistant('历史二'), assistant('历史三'), assistant('待确认尾楼')],
    automation: { enabled: false, batchSize: 1 }, utility, failureStorage: storage,
  });
  await first.runtime.start();
  await first.runtime.startHistoricalRebuild();
  let state = first.runtime.getState();
  const [floorA, floorB, floorC] = state.floors;
  await first.runtime.retryStateAnalysis(floorA.floorId);
  await first.runtime.retryStateAnalysis(floorB.floorId);
  state = first.runtime.getState();
  assert.equal(state.floors[0].cse.status, 'failed');
  assert.equal(state.floors[1].cse.status, 'noChange');
  assert.match(state.floors[0].cse.error, /连续失败 4 次/);
  failSummaryC = true;
  await first.runtime.extractFloor(floorC.floorId, { analyzeState: false });
  const key = [...storage.values.keys()][0];
  let saved = JSON.parse(storage.values.get(key));
  assert.equal(saved.cseFailures[floorA.floorId].count, 4);
  assert.equal(saved.failures[floorC.floorId].count, 1);
  assert.doesNotMatch(storage.values.get(key), /历史一|历史二|历史三|taskMessages|jsonData|api/u);

  first.runtime.invalidate();
  const resumed = harness({ sharedBackend: first.backend, sharedContext: first.context, automation: { enabled: false, batchSize: 1 }, utility, failureStorage: storage });
  await resumed.runtime.start();
  state = resumed.runtime.getState();
  assert.equal(state.floors[0].cse.status, 'failed');
  assert.match(state.floors[0].cse.error, /连续失败 4 次.*受控 CSE A 失败/);
  assert.equal(state.floors[1].cse.status, 'noChange');
  assert.match(state.floors[2].error, /连续失败 1 次.*受控摘要 C 失败/);
  assert.equal(state.lastCseError.floorId, floorA.floorId);

  failA = false;
  await resumed.runtime.retryStateAnalysis(floorA.floorId);
  state = resumed.runtime.getState();
  assert.equal(state.floors[0].cse.status, 'noChange');
  assert.equal(state.floors[0].cse.error, null);
  assert.match(state.floors[2].error, /连续失败 1 次/, 'CSE 本楼成功不得清摘要失败提示');
  saved = JSON.parse(storage.values.get(key));
  assert.equal(saved.cseFailures, undefined);
  assert.equal(saved.failures[floorC.floorId].count, 1);

  failA = true;
  await resumed.runtime.retryStateAnalysis(floorA.floorId);
  state = resumed.runtime.getState();
  assert.equal(state.floors[0].cse.status, 'noChange', '已有有效 delta 重析失败仍保持可用');
  assert.match(state.floors[0].cse.error, /受控 CSE A 失败/);
});

test('自动任务外层错误跨刷新保留，暂停不清且仅在后续批次正常完成后清除', async () => {
  const storage = browserStorage();
  let failCse = false;
  let armedOuter = false;
  let armedRefreshCalls = 0;
  let holdNewSummary = false;
  let releaseSummary;
  let markSummaryStarted;
  const summaryStarted = new Promise(resolve => { markSummaryStarted = resolve; });
  const utility = options => {
    const content = JSON.parse(options.taskMessages[0].content).payload.canonicalContent;
    if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) {
      if (holdNewSummary && content === '新增历史楼') return new Promise(resolve => { releaseSummary = () => resolve({ jsonData: { summary: '新增历史摘要' } }); markSummaryStarted(); });
      return { jsonData: { summary: `摘要-${content}` } };
    }
    if (failCse && content === '历史一') throw Object.assign(new Error('保留到刷新后的 CSE 错误'), { code: 'TEST_CSE_REANALYZE_FAILED' });
    return { jsonData: { noMaterialChange: true } };
  };
  const h = harness({
    initialChat: [user('开始'), assistant('历史一'), assistant('待确认尾楼')],
    automation: { enabled: false, batchSize: 1 }, utility, failureStorage: storage,
    foundationRefresh: async base => {
      if (armedOuter && ++armedRefreshCalls === 2) throw Object.assign(new Error('自动任务外层受控失败'), { code: 'TEST_AUTO_OUTER_FAILED' });
      return base.refreshStatus();
    },
  });
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  const firstFloorId = h.runtime.getState().floors[0].floorId;
  failCse = true;
  await h.runtime.retryStateAnalysis(firstFloorId);
  assert.equal(h.runtime.getState().floors[0].cse.status, 'noChange');

  h.context.chat.push(user('继续'), assistant('新增历史楼'), assistant('新尾楼'));
  await h.foundationRuntime.refreshStatus();
  await h.runtime.refreshStatus();
  armedOuter = true;
  await h.runtime.startHistoricalRebuild();
  let state = h.runtime.getState();
  assert.match(state.lastAutomationError?.message ?? '', /连续失败 1 次.*自动任务外层受控失败/);
  const key = [...storage.values.keys()][0];
  let saved = JSON.parse(storage.values.get(key));
  assert.equal(saved.automationFailure.phase, 'reconciling');
  assert.equal(saved.cseFailures[firstFloorId].count, 1);

  armedOuter = false;
  h.runtime.invalidate();
  await h.runtime.start();
  await h.runtime.refreshStatus();
  state = h.runtime.pauseHistoricalRebuild();
  assert.match(state.lastAutomationError?.message ?? '', /自动任务外层受控失败/, 'load、refresh 与暂停不得清外层错误');

  holdNewSummary = true;
  const paused = h.runtime.startHistoricalRebuild();
  await summaryStarted;
  h.runtime.pauseHistoricalRebuild();
  releaseSummary();
  await paused;
  assert.match(h.runtime.getState().lastAutomationError?.message ?? '', /自动任务外层受控失败/, '取消中的单楼结果不得清外层错误');

  holdNewSummary = false;
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()) && !h.runtime.getState().memoryWorkBusy);
  state = h.runtime.getState();
  assert.equal(state.lastAutomationError, null);
  assert.match(state.floors[0].cse.error, /保留到刷新后的 CSE 错误/, '正常批次只清外层错误，不得误清既有 CSE 楼级提示');
  saved = JSON.parse(storage.values.get(key));
  assert.equal(saved.automationFailure, undefined);
  assert.equal(saved.cseFailures[firstFloorId].count, 1);
});

test('合法跨楼重复千事关系只投影一次并让自动高楼继续到模拟提取与保存', async () => {
  let extractorCalls = 0;
  const utility = options => {
    const request = JSON.parse(options.taskMessages[0].content);
    if (request.task !== 'extractFloorSemantics') return { jsonData: { noMaterialChange: true } };
    extractorCalls += 1;
    const title = ['事项甲', '事项乙', '旁支丙', '旁支丁'][extractorCalls - 1] ?? `后续 ${extractorCalls}`;
    const qianshi = { events: [{ key: `event-${extractorCalls}`, title, description: `${title}的固定测试描述`, status: 'planned', matter: true }], order: [] };
    if (extractorCalls >= 3 && extractorCalls <= 4) {
      const byTitle = new Map(request.payload.qianshiCandidates.map(item => [item.title, item.key]));
      assert.ok(byTitle.get('事项甲') && byTitle.get('事项乙'), '后续楼必须通过真实候选目录引用前两项');
      qianshi.order.push({ before: byTitle.get('事项甲'), after: byTitle.get('事项乙'), certainty: 'explicit' });
    }
    return { jsonData: { summary: `摘要-${title}`, qianshi } };
  };
  const h = harness({
    modernAnchors: true,
    initialChat: Array.from({ length: 4 }, (_, index) => [assistant(`种子楼 ${index + 1}`), user(`确认种子 ${index + 1}`)]).flat().concat(assistant('种子尾楼')),
    automation: { enabled: false, batchSize: 1 }, utility,
  });
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()) && !h.runtime.getState().memoryWorkBusy);
  assert.equal(extractorCalls, 4);
  const seeded = await h.store.readReachable({ mode: 'runtime' });
  const relationIds = seeded.floorMemories.flatMap(memory => memory.qianshiDelta?.relations ?? []).map(relation => relation.id);
  assert.equal(relationIds.length, 2); assert.equal(new Set(relationIds).size, 1, '两个合法 delta 应形成同一确定性关系 ID');

  h.context.chat.pop();
  for (let index = 0; index < 10; index += 1) h.context.chat.push(assistant(`待压缩楼 ${index + 1}`), user(`确认待压缩 ${index + 1}`));
  h.context.chat.push(assistant('新的待确认尾楼'));
  await h.foundationRuntime.refreshStatus();
  await h.runtime.refreshStatus();
  const utilityCallsBefore = h.calls.length;
  h.backend.calls.splice(0);
  await h.runtime.startHistoricalRebuild({ aggregate: true });
  const state = h.runtime.getState();
  assert.equal(extractorCalls, 5, '重复关系去重后必须到达一次高楼模拟提取');
  assert.equal(h.calls.length, utilityCallsBefore + 2, '高楼摘要与批末 CSE 各走一次既有模拟调用');
  assert.ok(h.backend.calls.some(call => call[0] === 'put'), '模拟结果必须沿真实提交链保存');
  assert.equal(state.lastExtractorError, null);
  assert.equal(state.lastAutomationError, null);
  assert.equal(state.rememberedCount, 14);
  const projected = prepareQianshiCandidates(await h.store.readReachable({ mode: 'runtime' }));
  assert.ok(projected.stats.count >= 2, '重复关系不能丢失其关联事项');
});

test('准备期受控重复边异常贯通持久、重载、累计与两种复制方式，成功后清除', async () => {
  const storage = browserStorage();
  let failPreparation = false;
  const qianshiCandidatePreparer = (...args) => {
    if (!failPreparation) return prepareQianshiCandidates(...args);
    const error = new Error('Graph.addDirectedEdgeWithKey: PRIVATE_BODY entity=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa https://api.example.test/v1?key=SECRET edge already exists in the graph.');
    error.name = 'UsageGraphError';
    throw error;
  };
  const utility = options => JSON.parse(options.taskMessages[0].content).task === 'extractFloorSemantics'
    ? { jsonData: { summary: '安全摘要' } }
    : { jsonData: { noMaterialChange: true } };
  const h = harness({ modernAnchors: true, initialChat: [assistant('种子楼'), user('确认种子'), assistant('种子尾楼')], automation: { enabled: false, batchSize: 1 }, utility, qianshiCandidatePreparer, failureStorage: storage });
  await h.runtime.start(); await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()) && !h.runtime.getState().memoryWorkBusy);
  h.context.chat.pop();
  for (let index = 0; index < 10; index += 1) h.context.chat.push(assistant(`待压缩 ${index + 1}`), user(`确认 ${index + 1}`));
  h.context.chat.push(assistant('新尾楼'));
  await h.foundationRuntime.refreshStatus(); await h.runtime.refreshStatus();
  h.backend.calls.splice(0); const callsBefore = h.calls.length; failPreparation = true;
  await h.runtime.startHistoricalRebuild({ aggregate: true });
  const state = h.runtime.getState();
  assert.equal(h.calls.length, callsBefore); assert.equal(h.backend.calls.filter(call => call[0] === 'put').length, 0);
  assert.equal(state.lastExtractorError, null);
  assert.deepEqual({ phase: state.lastAutomationError.phase, prepareStep: state.lastAutomationError.prepareStep, name: state.lastAutomationError.name, code: state.lastAutomationError.code, detail: state.lastAutomationError.detail, count: state.lastAutomationError.count }, {
    phase: 'extracting', prepareStep: 'qianshiCandidates', name: 'UsageGraphError', code: 'V3_AUTO_MEMORY_FAILED', detail: 'Graphology 检测到重复图边。', count: 1,
  });
  assert.match(state.lastAutomationError.location, /^src\/v3\/memory-runtime\.js:\d+:\d+$/u);
  const key = [...storage.values.keys()][0], serializedFailure = storage.values.get(key);
  assert.doesNotMatch(serializedFailure, /事项甲|事项乙|旁支|33333333|relation:|https?:|TEST_KEY/u);
  assert.doesNotMatch(serializedFailure, /PRIVATE_BODY|aaaaaaaa-aaaa|SECRET|api\.example/u);
  const saved = JSON.parse(serializedFailure).automationFailure;
  const savedEnvelope = JSON.parse(serializedFailure);
  assert.deepEqual({ phase: saved.phase, prepareStep: saved.prepareStep, name: saved.name, code: saved.code, detail: saved.detail, location: saved.location, count: saved.count }, {
    phase: 'extracting', prepareStep: 'qianshiCandidates', name: 'UsageGraphError', code: 'V3_AUTO_MEMORY_FAILED',
    detail: 'Graphology 检测到重复图边。', location: state.lastAutomationError.location, count: 1,
  });

  h.runtime.invalidate();
  const resumed = harness({ sharedBackend: h.backend, sharedContext: h.context, automation: { enabled: false, batchSize: 1 }, utility, qianshiCandidatePreparer, failureStorage: storage });
  await resumed.runtime.start();
  assert.deepEqual(resumed.runtime.getState().lastAutomationError, state.lastAutomationError, '重载必须恢复同一份受控诊断');
  await resumed.runtime.startHistoricalRebuild({ aggregate: true });
  assert.equal(resumed.runtime.getState().lastAutomationError.count, 2, '相同准备失败仍沿现有语义累计');

  let clipboardValue = '';
  const clipboardUi = viewHarness(resumed.runtime, { page: 'management', pluginVersion: '0.4.2', navigatorRef: { clipboard: { writeText: async value => { clipboardValue = value; } } } });
  clipboardUi.flatten(clipboardUi.container).find(node => node.textContent === '复制状态诊断').click();
  await new Promise(resolve => setImmediate(resolve));
  const clipboardDiagnostic = JSON.parse(clipboardValue);
  assert.equal(clipboardDiagnostic.formatVersion, 2); assert.equal(clipboardDiagnostic.pluginVersion, '0.4.2');
  assert.deepEqual(clipboardDiagnostic.memory.lastAutomationError, {
    present: true, name: 'UsageGraphError', code: 'V3_AUTO_MEMORY_FAILED', phase: 'extracting', count: 2,
    prepareStep: 'qianshiCandidates', detail: 'Graphology 检测到重复图边。', location: state.lastAutomationError.location,
    lastFailedAt: state.lastAutomationError.lastFailedAt,
  });
  const fallbackUi = viewHarness(resumed.runtime, { page: 'management', pluginVersion: '0.4.2', navigatorRef: { clipboard: { writeText: async () => { throw new Error('clipboard denied'); } } } });
  fallbackUi.flatten(fallbackUi.container).find(node => node.textContent === '复制状态诊断').click();
  await new Promise(resolve => setImmediate(resolve));
  const fallback = fallbackUi.flatten(fallbackUi.container).find(node => node.className === 'v3-diagnostic-fallback');
  assert.equal(fallback?.readOnly, true);
  assert.deepEqual(JSON.parse(fallback.value).memory.lastAutomationError, clipboardDiagnostic.memory.lastAutomationError, '手机 fallback 必须得到同一诊断字段');
  assert.doesNotMatch(fallback.value, /PRIVATE_BODY|aaaaaaaa-aaaa|SECRET|api\.example|\/home\/admin/u);

  failPreparation = false;
  await resumed.runtime.startHistoricalRebuild({ aggregate: true });
  await waitFor(() => registeredGraphCaughtUp(resumed.runtime.getState()) && !resumed.runtime.getState().memoryWorkBusy);
  assert.equal(resumed.runtime.getState().lastAutomationError, null);
  assert.equal(storage.values.has(key), false, '成功后沿既有语义删除整份空失败提示');

  storage.values.set(key, JSON.stringify({ ...savedEnvelope, automationFailure: {
    count: 3, lastReason: '旧版通用错误', code: 'UsageGraphError', phase: 'extracting', lastFailedAt: NOW,
  } }));
  resumed.runtime.invalidate();
  const legacy = harness({ sharedBackend: h.backend, sharedContext: h.context, automation: { enabled: false, batchSize: 1 }, utility, qianshiCandidatePreparer, failureStorage: storage });
  await legacy.runtime.start();
  assert.deepEqual(legacy.runtime.getState().lastAutomationError, {
    code: null, name: 'UsageGraphError', message: `连续失败 3 次；最近：旧版通用错误（${NOW}）`, phase: 'extracting', prepareStep: null,
    detail: null, location: null, count: 3, lastFailedAt: NOW,
  }, '旧0.4.0/0.4.1失败提示可恢复已有类型，新字段如实null');
});

test('准备期身份目录异常标记真实步骤，不会全部退化成交接阶段', async () => {
  let failIdentity = false;
  const identityProjectionProvider = async () => {
    if (failIdentity) throw new TypeError('PRIVATE_BODY https://api.example.test/?key=SECRET');
    return null;
  };
  const utility = options => JSON.parse(options.taskMessages[0].content).task === 'extractFloorSemantics'
    ? { jsonData: { summary: '安全摘要' } }
    : { jsonData: { noMaterialChange: true } };
  const h = harness({ modernAnchors: true, initialChat: [assistant('种子楼'), user('确认种子'), assistant('种子尾楼')], automation: { enabled: false, batchSize: 1 }, utility, identityProjectionProvider });
  await h.runtime.start(); await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()) && !h.runtime.getState().memoryWorkBusy);
  h.context.chat.pop();
  for (let index = 0; index < 10; index += 1) h.context.chat.push(assistant(`待压缩 ${index + 1}`), user(`确认 ${index + 1}`));
  h.context.chat.push(assistant('新尾楼'));
  await h.foundationRuntime.refreshStatus(); await h.runtime.refreshStatus();
  const callsBefore = h.calls.length; h.backend.calls.splice(0); failIdentity = true;
  await h.runtime.startHistoricalRebuild({ aggregate: true });
  assert.equal(h.calls.length, callsBefore); assert.equal(h.backend.calls.filter(call => call[0] === 'put').length, 0);
  assert.deepEqual({
    phase: h.runtime.getState().lastAutomationError.phase,
    prepareStep: h.runtime.getState().lastAutomationError.prepareStep,
    name: h.runtime.getState().lastAutomationError.name,
    code: h.runtime.getState().lastAutomationError.code,
    detail: h.runtime.getState().lastAutomationError.detail,
  }, { phase: 'extracting', prepareStep: 'identityDirectory', name: 'TypeError', code: 'V3_AUTO_MEMORY_FAILED', detail: '类型检查失败。' });
});

test('准备期时间来源异常经持久、重载与复制仍精确归类 timeSources', async () => {
  const storage = browserStorage();
  let failTimeSources = false;
  const storyClockReferenceTags = () => {
    if (failTimeSources) throw new TypeError('PRIVATE_TIME https://api.example.test/?key=SECRET');
    return '';
  };
  const utility = options => JSON.parse(options.taskMessages[0].content).task === 'extractFloorSemantics'
    ? { jsonData: { summary: '安全摘要' } }
    : { jsonData: { noMaterialChange: true } };
  const options = { automation: { enabled: false, batchSize: 1 }, utility, storyClockReferenceTags, failureStorage: storage };
  const h = harness({ ...options, modernAnchors: true, initialChat: [assistant('种子楼'), user('确认种子'), assistant('种子尾楼')] });
  await h.runtime.start(); await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()) && !h.runtime.getState().memoryWorkBusy);
  h.context.chat.pop();
  for (let index = 0; index < 10; index += 1) h.context.chat.push(assistant(`待压缩 ${index + 1}`), user(`确认 ${index + 1}`));
  h.context.chat.push(assistant('新尾楼'));
  await h.foundationRuntime.refreshStatus(); await h.runtime.refreshStatus();
  failTimeSources = true;
  await h.runtime.startHistoricalRebuild({ aggregate: true });
  const failure = h.runtime.getState().lastAutomationError;
  assert.deepEqual({ phase: failure.phase, prepareStep: failure.prepareStep, name: failure.name, code: failure.code, detail: failure.detail }, {
    phase: 'extracting', prepareStep: 'timeSources', name: 'TypeError', code: 'V3_AUTO_MEMORY_FAILED', detail: '类型检查失败。',
  });
  const serialized = [...storage.values.values()][0];
  assert.equal(JSON.parse(serialized).automationFailure.prepareStep, 'timeSources');
  assert.doesNotMatch(serialized, /PRIVATE_TIME|SECRET|api\.example/u);

  h.runtime.invalidate();
  failTimeSources = false;
  const resumed = harness({ ...options, sharedBackend: h.backend, sharedContext: h.context });
  await resumed.runtime.start();
  assert.deepEqual(resumed.runtime.getState().lastAutomationError, failure, '重载必须恢复同一时间步骤诊断');
  let clipboardValue = '';
  const ui = viewHarness(resumed.runtime, { page: 'management', pluginVersion: '0.4.2', navigatorRef: { clipboard: { writeText: async value => { clipboardValue = value; } } } });
  ui.flatten(ui.container).find(node => node.textContent === '复制状态诊断').click();
  await new Promise(resolve => setImmediate(resolve));
  const copied = JSON.parse(clipboardValue).memory.lastAutomationError;
  assert.equal(copied.prepareStep, 'timeSources');
  assert.equal(copied.location, failure.location);
  assert.doesNotMatch(clipboardValue, /PRIVATE_TIME|SECRET|api\.example/u);
});

test('捕获 A/B/C 补 B 期间另一实例完成新 D，仍按捕获楼 ID 补完 B 的 CSE', async () => {
  const seed = await seedMiddleSummaryGap();
  const initialFloors = seed.runtime.getState().floors;
  await seed.runtime.retryStateAnalysis(initialFloors[2].floorId);
  let releaseB, markBStarted;
  const bStarted = new Promise(resolve => { markBStarted = resolve; });
  const primary = harness({
    automation: { enabled: true, batchSize: 1 }, sharedBackend: seed.backend, sharedContext: seed.context,
    utility: options => {
      if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) {
        markBStarted();
        return new Promise(resolve => { releaseB = () => resolve({ jsonData: { summary: 'B 补齐摘要' } }); });
      }
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await primary.runtime.start();
  const rebuilding = primary.runtime.startHistoricalRebuild();
  await bStarted;

  seed.context.chat.push(user('让新 D 稳定'));
  const writer = harness({
    automation: { enabled: false, batchSize: 1 }, sharedBackend: seed.backend, sharedContext: seed.context,
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: '另一实例保存的新 D' } }
      : { jsonData: { noMaterialChange: true } },
  });
  await writer.runtime.start();
  const dFloor = writer.runtime.getState().floors.at(-1);
  assert.equal(dFloor.status, 'unprocessed');
  await writer.runtime.extractFloor(dFloor.floorId);
  assert.equal(writer.runtime.getState().rebuildCompletedCount, 3, 'A/C/D 已完成时总完成数恰好等于捕获 A/B/C 的长度');

  releaseB();
  await rebuilding;
  await waitFor(() => !primary.runtime.getState().memoryWorkBusy);
  const final = primary.runtime.getState();
  const bFloorId = initialFloors[1].floorId;
  assert.equal(final.floors.find(floor => floor.floorId === bFloorId)?.status, 'ready');
  assert.ok(final.cseFloors.find(floor => floor.floorId === bFloorId)?.deltaId, '后来完成的 D 不得抵掉捕获范围内 B 的 CSE 待办');
  assert.equal(primary.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, 1);
  assert.equal(primary.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 1);
});

test('CSE 等待期间到达的新稳定楼不混入当前边界，当前失败后由新输入只触发一次后续追赶', async () => {
  const seed = await seedContinuousSummaryTail(1);
  let cseCalls = 0;
  let releaseFirstCse;
  let firstCseStartedResolve;
  const firstCseStarted = new Promise(resolve => { firstCseStartedResolve = resolve; });
  const notifications = [];
  const resumed = harness({
    automation: { enabled: true, batchSize: 1 }, sharedBackend: seed.backend, sharedContext: seed.context,
    notifyUser: value => notifications.push(value),
    utility: options => {
      if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { summary: '固定边界摘要' } };
      cseCalls += 1;
      if (cseCalls === 1) {
        firstCseStartedResolve();
        return new Promise((resolve, reject) => { releaseFirstCse = () => reject(new Error('模拟边界内 CSE 失败')); });
      }
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await resumed.runtime.start();
  completeTailSwipe(resumed, '触发边界追赶的真实 roll');
  await firstCseStarted;
  resumed.emit('GENERATION_STARTED', 'normal');
  resumed.context.chat.push(assistant('运行期间新增的未稳定尾楼'));
  resumed.emit('STREAM_TOKEN_RECEIVED', '运行期间新增正文');
  releaseFirstCse();
  await waitFor(() => registeredGraphCaughtUp(resumed.runtime.getState()) && !resumed.runtime.getState().memoryWorkBusy, '新输入没有触发后续单次追赶');
  resumed.emit('GENERATION_ENDED');
  resumed.emit('MESSAGE_RECEIVED', resumed.context.chat.length - 1, 'normal');
  assert.equal(resumed.runtime.getState().summaryCompletedCount, 3);
  assert.equal(resumed.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, 2, '当前边界与后续新增楼应各提取一次');
  assert.equal(cseCalls, 3, '最早 CSE 失败一次后只重试一次，再顺序处理新增楼');
  assert.equal(notifications.filter(item => item.kind === 'warning').length, 1, '旧边界失败只提示一次');
});

test('CSE 重构锁定已有摘要前缀并逐楼替换状态链，不调用摘要模型', async () => {
  let rebuilding = false, measuredRebuildReads = false, h;
  h = harness({
    initialChat: [user('开始'), assistant('第一楼'), assistant('第二楼'), assistant('未摘要尾楼')],
    automation: { enabled: true, batchSize: 20 },
    utility: options => {
      const request = JSON.parse(options.taskMessages[0].content);
      if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) {
        assert.equal(rebuilding, false, 'CSE 重构期间不得调用摘要模型');
        return { jsonData: { summary: `保留摘要-${request.payload.canonicalContent}`, people: [{ name: '裴晚生' }] } };
      }
      if (rebuilding && !measuredRebuildReads) {
        measuredRebuildReads = true;
        h.readReachableModes.splice(0);
        h.backend.calls.splice(0);
      }
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()));
  const currentState = h.runtime.getState();
  const editedSubject = currentState.cseSubjects[0];
  assert.ok(editedSubject && currentState.currentStateId && currentState.currentStateFingerprint);
  await h.runtime.correctSubjectState(editedSubject.subjectEntityId, {
    expectedCurrentStateId: currentState.currentStateId,
    expectedCurrentStateFingerprint: currentState.currentStateFingerprint,
    core: editedSubject.core,
    adaptive: editedSubject.adaptive,
    situational: [...editedSubject.situational, { text: '人工纠正的临时状态', reason: '用户输入', visibility: 'private', towardEntityId: null }],
  });
  const before = await h.store.readReachable({ mode: 'runtime' });
  const beforeMemory = before.floorMemories.map(item => [item.id, item.summary]);
  const beforeDeltaIds = before.stateDeltas.map(item => item.id);
  assert.equal(beforeMemory.length, 2);
  assert.equal(beforeDeltaIds.length, 2);
  assert.ok(before.stateDeltas.at(-1).source.manualSubjectEntityIds?.length, '重构前先形成一条 CSE 人工纠正');

  h.calls.splice(0);
  rebuilding = true;
  await h.runtime.rebuildCse(CHAT);
  const rebuildReadModes = [...h.readReachableModes];
  const rebuildRootGets = h.backend.calls.filter(call => call[0] === 'get' && call[1] === `chat-${CHAT}` && call[2] === 'v3-root');
  assert.equal(rebuildReadModes.filter(mode => mode === 'projection').length, 0, '每楼提交成功后不得再次读取整份 projection 图');
  assert.equal(rebuildReadModes.filter(mode => mode === 'runtime').length, 0, '已提交快照与同版本轻 root 核对足够，不得退回整份 runtime 图');
  assert.equal(rebuildRootGets.length, 3, '重构入口核验发生在首楼请求前；请求后只保留首楼提交前、次楼开始及提交前的轻 root 核对');
  const after = await h.store.readReachable({ mode: 'runtime' });
  const cseRequests = h.calls.filter(options => options.systemPrompt === CSE_SYSTEM_PROMPT)
    .map(options => JSON.parse(options.taskMessages[0].content).payload.canonicalContent);
  assert.deepEqual(cseRequests, ['第一楼', '第二楼'], '只处理点击时已有摘要的连续前缀，并按楼序执行');
  assert.equal(h.calls.filter(options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, 0);
  assert.deepEqual(after.floorMemories.map(item => [item.id, item.summary]), beforeMemory, '摘要记录及内容保持不变');
  assert.equal(after.stateDeltas.length, 2);
  assert.ok(after.stateDeltas.every((item, index) => item.id !== beforeDeltaIds[index]), '每楼旧 CSE 均被新链替换');
  assert.ok(after.stateDeltas.every(item => !item.source.manualSubjectEntityIds?.length), 'CSE 人工纠正随旧链被覆盖');
  assert.equal(after.run.diagnostics.cseRebuild?.status, 'completed');
  assert.deepEqual(after.run.diagnostics.cseRebuild?.completedFloorIds, after.floors.slice(0, 2).map(item => item.id));
  assert.equal(h.runtime.getState().cseRebuildStatus, 'completed');
  assert.equal(h.runtime.getState().cseRebuildCompletedCount, 2);
});

test('CSE 重构首楼失败保留旧链，专用继续仍只重算 CSE', async () => {
  let mode = 'seed';
  const h = harness({
    initialChat: [user('开始'), assistant('第一楼'), assistant('第二楼'), assistant('未摘要尾楼')],
    automation: { enabled: true, batchSize: 20 },
    utility: options => {
      const request = JSON.parse(options.taskMessages[0].content);
      if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) {
        if (mode !== 'seed') assert.fail('CSE 重构继续不得调用摘要模型');
        return { jsonData: { summary: `保留摘要-${request.payload.canonicalContent}` } };
      }
      if (mode === 'failFirst') throw new Error('模拟首楼 CSE 失败');
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()));
  const before = await h.store.readReachable({ mode: 'runtime' });
  const beforeDeltaIds = before.stateDeltas.map(item => item.id);
  const beforeHead = before.root.headCheckpointId;

  h.calls.splice(0); mode = 'failFirst';
  await h.runtime.rebuildCse(CHAT);
  const failed = await h.store.readReachable({ mode: 'runtime' });
  assert.equal(h.runtime.getState().cseRebuildStatus, 'failed');
  assert.equal(h.runtime.getState().cseRebuildCompletedCount, 0);
  assert.equal(h.runtime.getState().cseRebuildNextAssistantSeq, 1);
  assert.match(h.runtime.getState().cseRebuildError, /模拟首楼 CSE 失败/);
  assert.equal(failed.root.headCheckpointId, beforeHead, '首楼失败前不得切换有效 root');
  assert.deepEqual(failed.stateDeltas.map(item => item.id), beforeDeltaIds, '首楼失败保留完整旧 CSE 链');

  h.calls.splice(0); mode = 'resume';
  await h.runtime.resumeCseRebuild(CHAT);
  assert.equal(h.runtime.getState().cseRebuildStatus, 'completed');
  assert.equal(h.calls.filter(options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, 0);
  assert.equal(h.calls.filter(options => options.systemPrompt === CSE_SYSTEM_PROMPT).length, 2);
});

test('CSE 重构成功一楼后可暂停，并从持久进度恢复剩余 CSE', async () => {
  let mode = 'seed', rebuildCseCalls = 0, releaseSecond, markSecondStarted;
  const secondStarted = new Promise(resolve => { markSecondStarted = resolve; });
  const h = harness({
    initialChat: [user('开始'), assistant('第一楼'), assistant('第二楼'), assistant('第三楼'), assistant('未摘要尾楼')],
    automation: { enabled: true, batchSize: 20 },
    utility: async options => {
      const request = JSON.parse(options.taskMessages[0].content);
      if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) {
        if (mode !== 'seed') assert.fail('CSE 重构暂停期间不得调用摘要模型');
        return { jsonData: { summary: `保留摘要-${request.payload.canonicalContent}` } };
      }
      if (mode === 'pause') {
        rebuildCseCalls += 1;
        if (rebuildCseCalls === 2) {
          markSecondStarted();
          await new Promise(resolve => { releaseSecond = resolve; });
        }
      }
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()));
  const originalMemories = (await h.store.readReachable({ mode: 'runtime' })).floorMemories.map(item => [item.id, item.summary]);

  h.calls.splice(0); mode = 'pause';
  const rebuilding = h.runtime.rebuildCse(CHAT);
  await secondStarted;
  h.runtime.pauseCseRebuild();
  releaseSecond();
  await rebuilding;
  assert.equal(h.runtime.getState().cseRebuildStatus, 'paused');
  assert.equal(h.runtime.getState().cseRebuildCompletedCount, 1, '只记录已经提交成功的第一楼');
  const paused = await h.store.readReachable({ mode: 'runtime' });
  assert.equal(paused.run.diagnostics.cseRebuild?.status, 'active');
  assert.deepEqual(paused.run.diagnostics.cseRebuild?.completedFloorIds, [paused.floors[0].id]);

  let resumedExtractorCalls = 0, resumedCseCalls = 0;
  const resumed = harness({
    sharedBackend: h.backend,
    sharedContext: h.context,
    automation: { enabled: true, batchSize: 20 },
    utility: options => {
      if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) resumedExtractorCalls += 1;
      else resumedCseCalls += 1;
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await resumed.runtime.start();
  assert.equal(resumed.runtime.getState().cseRebuildStatus, 'paused', '刷新后从 run diagnostics 恢复专用 CSE 作业');
  assert.equal(resumed.runtime.getState().cseRebuildCompletedCount, 1);
  resumed.readReachableModes.splice(0);
  resumed.backend.calls.splice(0);
  await resumed.runtime.resumeCseRebuild(CHAT);
  assert.equal(resumed.runtime.getState().cseRebuildStatus, 'completed');
  assert.equal(resumed.readReachableModes.filter(mode => ['projection', 'runtime', 'full'].includes(mode)).length, 0, '同版本继续重构不得重复读取整图');
  assert.equal(resumed.backend.calls.filter(call => call[0] === 'get' && call[1] === `chat-${CHAT}` && call[2] === 'v3-root').length, 5, '继续入口一次 root，加两楼各自开始与提交前 root 核对');
  assert.equal(resumedExtractorCalls, 0);
  assert.equal(resumedCseCalls, 2, '恢复时只处理未提交的后两楼');
  const after = await resumed.store.readReachable({ mode: 'runtime' });
  assert.deepEqual(after.floorMemories.map(item => [item.id, item.summary]), originalMemories);
});

test('CSE 重构 root 已耐久但暂停发生在 adopt 前，继续时按持久进度跳过已提交楼', async () => {
  let mode = 'seed';
  const h = harness({
    initialChat: [user('开始'), assistant('第一楼'), assistant('第二楼'), assistant('第三楼'), assistant('未摘要尾楼')],
    automation: { enabled: true, batchSize: 20 },
    utility: options => {
      const request = JSON.parse(options.taskMessages[0].content);
      if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) {
        assert.equal(mode, 'seed');
        return { jsonData: { summary: `保留摘要-${request.payload.canonicalContent}` } };
      }
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()));

  h.calls.splice(0);
  mode = 'rebuild';
  h.backend.abortAfterNextPut(key => {
    if (key !== 'v3-root') return false;
    h.runtime.pauseCseRebuild();
    return true;
  });
  await h.runtime.rebuildCse(CHAT);
  assert.equal(h.runtime.getState().cseRebuildStatus, 'paused');
  assert.equal(h.runtime.getState().cseRebuildCompletedCount, 0, 'adopt 前内存尚不知道已耐久的第一楼');
  const durable = await h.store.readReachable({ mode: 'runtime' });
  assert.deepEqual(durable.run.diagnostics.cseRebuild?.completedFloorIds, [durable.floors[0].id]);

  await h.runtime.resumeCseRebuild(CHAT);
  assert.equal(h.runtime.getState().cseRebuildStatus, 'completed');
  const cseContents = h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT)
    .map(call => JSON.parse(call.taskMessages[0].content).payload.canonicalContent);
  assert.deepEqual(cseContents, ['第一楼', '第二楼', '第三楼'], '继续不得重复调用已耐久提交的第一楼');
  assert.equal(h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, 0);
});

test('CSE 重构跳过中间摘要缺口，独立重析前后已有摘要楼且不补摘要', async () => {
  const h = await seedMiddleSummaryGap();
  const before = await h.store.readReachable({ mode: 'runtime' });
  assert.equal(before.floorMemories.filter(item => item.recordStatus === 'active').length, 2, '夹具必须有前后摘要与中间缺口');
  h.calls.splice(0);
  await h.runtime.rebuildCse(CHAT);
  const cseCalls = h.calls.filter(options => options.systemPrompt === CSE_SYSTEM_PROMPT);
  assert.equal(cseCalls.length, 2, '中间摘要缺口不得阻断后楼独立重析');
  assert.equal(h.calls.filter(options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, 0, '不得为缺口补摘要');
  assert.deepEqual(cseCalls.map(call => JSON.parse(call.taskMessages[0].content).payload.canonicalContent), ['已完成前缀', '尾部欠账 2']);
  assert.equal(h.runtime.getState().cseRebuildTotalCount, 2);
  assert.equal(h.runtime.getState().cseRebuildStatus, 'completed');
  const after = await h.store.readReachable({ mode: 'runtime' });
  assert.deepEqual(after.floorMemories.map(item => item.id), before.floorMemories.map(item => item.id));
});

test('跨摘要缺口的 CSE 重构暂停后补上缺口，仍按原楼 ID 计划只恢复剩余目标', async () => {
  const h = await seedMiddleSummaryGap();
  const floors = h.runtime.getState().floors;
  const missingFloor = floors.find(item => item.status !== 'ready');
  h.calls.splice(0);
  h.backend.abortAfterNextPut(key => {
    if (key !== 'v3-root') return false;
    h.runtime.pauseCseRebuild();
    return true;
  });
  await h.runtime.rebuildCse(CHAT);
  assert.equal(h.runtime.getState().cseRebuildStatus, 'paused');
  await h.runtime.extractFloor(missingFloor.floorId, { analyzeState: false });
  assert.equal(h.runtime.getState().cseRebuildTotalCount, 2, '补上的中间摘要不加入已捕获的 CSE 重构范围');
  await h.runtime.resumeCseRebuild(CHAT);
  const cseContents = h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT)
    .map(call => JSON.parse(call.taskMessages[0].content).payload.canonicalContent);
  assert.deepEqual(cseContents, ['已完成前缀', '尾部欠账 2']);
  assert.equal(h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, 1);
  assert.equal(h.runtime.getState().cseRebuildStatus, 'completed');
});

test('冷读把跨代实体视图投影到当前首见楼，不改后端实体记录', async () => {
  const h = harness({
    initialChat: [user('开始'), assistant('裴晚生在门口等待。'), assistant('未摘要尾楼')],
    automation: { enabled: true, batchSize: 20 },
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: '裴晚生在门口等待。', people: [{ name: '裴晚生' }] } }
      : { jsonData: { noMaterialChange: true } },
  });
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()));
  const root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  const checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  assert.equal(checkpoint.producedRefs.floors.length, 1);
  const nextGeneration = '77777777-7777-4777-8777-777777777777';
  const floorRecord = h.backend.records.get(`chat-${CHAT}/v3-floor-${checkpoint.producedRefs.floors[0]}`).data;
  const memoryRecord = h.backend.records.get(`chat-${CHAT}/v3-floor-memory-${checkpoint.producedRefs.floorMemories[0]}`).data;
  const deltaRecord = h.backend.records.get(`chat-${CHAT}/v3-state-delta-${checkpoint.producedRefs.stateDeltas[0]}`).data;
  floorRecord.narrativeGeneration = nextGeneration;
  memoryRecord.narrativeGeneration = nextGeneration;
  deltaRecord.narrativeGeneration = nextGeneration;
  const storedEntities = checkpoint.producedRefs.entities.map(id => h.backend.records.get(`chat-${CHAT}/v3-entity-${id}`).data);
  const referencedStored = storedEntities.find(entity => entity.id === deltaRecord.subjectSnapshots[0]?.subjectEntityId);
  assert.ok(referencedStored);
  const storedGeneration = referencedStored.narrativeGeneration;
  const deletedFirstFloorId = '66666666-6666-4666-8666-666666666666';
  referencedStored.firstSeenFloorId = deletedFirstFloorId;
  referencedStored.lastSeenFloorId = deletedFirstFloorId;

  const cold = await h.store.readReachable({ mode: 'runtime' });
  assert.equal(cold.status, 'ready');
  const projected = cold.entities.find(entity => entity.id === referencedStored.id);
  assert.equal(projected.firstSeenFloorId, floorRecord.id);
  assert.equal(projected.narrativeGeneration, nextGeneration, '视图代次跟随当前首见楼');
  const persisted = h.backend.records.get(`chat-${CHAT}/v3-entity-${referencedStored.id}`).data;
  assert.equal(persisted.narrativeGeneration, storedGeneration, '读取投影不得写回旧实体记录');
  assert.equal(persisted.firstSeenFloorId, deletedFirstFloorId);
});

test('GENERATION_STARTED 抢在 isGenerating 变真前仍拒绝历史授权，STOPPED/ENDED 后可幂等恢复', async () => {
  let blockHistoricalRefresh = false;
  let releaseRefresh;
  let refreshStartedResolve;
  const refreshStarted = new Promise(resolve => { refreshStartedResolve = resolve; });
  const notifications = [];
  const h = harness({
    initialChat: [user('开始'), assistant('历史一'), assistant('历史二'), assistant('待确认尾楼')],
    automation: { enabled: true, batchSize: 2 },
    isMainGenerationActive: () => false,
    notifyUser: value => notifications.push(value),
    foundationRefresh: async base => {
      if (blockHistoricalRefresh) {
        blockHistoricalRefresh = false;
        refreshStartedResolve();
        await new Promise(resolve => { releaseRefresh = resolve; });
      }
      return base.refreshStatus();
    },
  });
  await h.runtime.start();

  blockHistoricalRefresh = true;
  const rejected = h.runtime.startHistoricalRebuild();
  await refreshStarted;
  h.emit('GENERATION_STARTED', 'normal');
  releaseRefresh();
  await rejected;

  assert.equal(h.calls.length, 0, '正式生成开始后不得授予历史 API 权限');
  assert.equal(h.runtime.shouldBlockMainGeneration(), false, '既有正常生成不得被后来取得的维护门禁误杀');
  assert.match(notifications[0].text, /从第 1 楼起还有 2 楼摘要未完成.*不会自动补/);
  assert.deepEqual(notifications[1], { kind: 'warning', text: '主模型正在生成，请等待完成后再开始重建。' });

  h.emit('GENERATION_STOPPED');
  h.emit('GENERATION_ENDED');
  h.emit('GENERATION_ENDED');
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()) && !h.runtime.getState().activeAutoMemory);
  assert.equal(h.runtime.getState().rememberedCount, 2);
  assert.equal(h.runtime.shouldBlockMainGeneration(), false);
});

test('dry-run GENERATION_STARTED 不会占用主生成事实，历史按钮仍可正常刷新并追平', async () => {
  const notifications = [];
  const h = harness({
    initialChat: [user('开始'), assistant('历史一'), user('中途指令'), assistant('历史二'), assistant('待确认尾楼')],
    automation: { enabled: true, batchSize: 2 },
    isMainGenerationActive: () => false,
    notifyUser: value => notifications.push(value),
  });
  await h.runtime.start();
  h.emit('GENERATION_STARTED', 'normal', {}, true);
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()) && !h.runtime.getState().activeAutoMemory);

  assert.equal(h.runtime.getState().rememberedCount, 2);
  assert.deepEqual(h.calls.map(call => call.systemPrompt), [EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT, EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT]);
  assert.match(notifications[0].text, /从第 1 楼起还有 2 楼摘要未完成.*不会自动补/);
  assert.deepEqual(notifications[1], { kind: 'info', text: '千千结开始补齐 2 楼摘要（从第 1 楼起）。' });
  assert.deepEqual(notifications[2], { kind: 'success', text: '千千结已完成历史记忆维护：新增摘要 2 楼，补齐人物状态 2 楼。' });
  assert.equal(h.runtime.shouldBlockMainGeneration(), false);
});

test('不配对的嵌套 STARTED 不泄漏真实生成生命周期，唯一 ENDED 后历史入口正常释放', async () => {
  for (const order of ['nestedDry', 'dryBeforeReal', 'nestedContinue', 'nestedNormal']) {
    const h = harness({
      initialChat: [user('开始'), assistant('历史一'), assistant('历史二'), assistant('待确认尾楼')],
      automation: { enabled: true, batchSize: 2 },
      isMainGenerationActive: () => false,
    });
    await h.runtime.start();
    if (order === 'nestedDry') {
      h.emit('GENERATION_STARTED', 'normal', {}, false);
      h.emit('GENERATION_STARTED', 'normal', {}, true);
    } else if (order === 'dryBeforeReal') {
      h.emit('GENERATION_STARTED', 'normal', {}, true);
      h.emit('GENERATION_STARTED', 'normal', {}, false);
    } else {
      h.emit('GENERATION_STARTED', 'normal', {}, false);
      h.emit('GENERATION_STARTED', order === 'nestedContinue' ? 'continue' : 'normal', {}, false);
    }
    h.emit('GENERATION_ENDED');
    await h.runtime.startHistoricalRebuild();
    await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()) && !h.runtime.getState().activeAutoMemory, `${order} 后生成门禁未释放`);
    assert.equal(h.runtime.getState().rememberedCount, 2);
  }
});

test('有稳定历史的未初始化聊天在流式首 token 时只检查，不提前写地基或调用记忆模型', async () => {
  const h = harness({ initialChat: [assistant('未初始化历史楼'), user('已确认历史楼')], automation: { enabled: true, batchSize: 1 }, readOnlyLifecycle: true });
  await h.runtime.start();
  h.context.chat.push(user('继续'));
  h.emit('GENERATION_STARTED', 'normal');
  h.context.chat.push(assistant(''));
  h.emit('STREAM_TOKEN_RECEIVED', '首 token');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.calls.length, 0);
  assert.equal(h.backend.records.has(`chat-${CHAT}/v3-root`), false);
});

test('首个流式正文提前固定上一楼，重复 token 与 ENDED→RECEIVED 不重复摘要或 CSE', async () => {
  const h = harness({
    initialChat: [assistant('已建楼'), assistant('上一楼正文')],
    automation: { enabled: true, batchSize: 1 },
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: '上一楼摘要' } }
      : { jsonData: { noMaterialChange: true } },
  });
  await primeEarlyGenerationTail(h);
  const putsBeforeStart = h.backend.calls.filter(call => call[0] === 'put').length;
  h.context.chat.push(user('继续'));
  h.emit('GENERATION_STARTED', 'normal', {}, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 0, 'STARTED 只能武装，不能调用模型');
  assert.equal(h.backend.calls.filter(call => call[0] === 'put').length, putsBeforeStart, 'STARTED 不能写地基');

  h.context.chat.push(assistant(''));
  h.emit('STREAM_TOKEN_RECEIVED', '当前楼首字');
  await waitFor(() => h.runtime.getState().rememberedCount === 2 && !h.runtime.getState().activeAutoMemory, '首 token 后上一楼未在 final 前完成');
  assert.deepEqual(h.calls.map(call => call.systemPrompt), [EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT]);
  assert.equal(h.foundationRuntime.getReachable().floors.at(-1).content.canonicalContent, '上一楼正文');
  assert.equal(h.foundationRuntime.getReachable().floors.some(floor => floor.hostLocator.messageIndex === 3), false, '空生成槽不得落 FloorRecord');

  h.emit('STREAM_TOKEN_RECEIVED', '当前楼更多正文');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.calls.length, 2, '重复 token 不得重复逻辑任务');
  h.emit('GENERATION_ENDED');
  h.context.chat[3] = assistant('当前楼完整正文');
  h.emit('MESSAGE_RECEIVED', 3, 'continue');
  await waitFor(() => h.foundationRuntime.getState().pending?.assistantSeq === 3, 'final 后当前楼未进入正常 pending');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.calls.length, 2, '同次 final 不得取消后重跑上一楼任务');
});

test('提前固定只接受真实新 AI 槽，空 is_system narrator 不触发自动任务', async () => {
  const h = harness({
    initialChat: [assistant('已建楼'), assistant('上一楼正文')],
    automation: { enabled: true, batchSize: 1 },
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: '上一楼摘要' } }
      : { jsonData: { noMaterialChange: true } },
  });
  await primeEarlyGenerationTail(h);
  h.context.chat.push(user('继续'));
  h.emit('GENERATION_STARTED', 'normal', {}, false);
  h.context.chat.push({ is_user: false, is_system: '', mes: '宿主旁白', extra: { type: 'narrator' } });
  h.emit('STREAM_TOKEN_RECEIVED', '旁白首字');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.calls.length, 0, 'narrator 槽不得提前固定上一楼或触发记忆任务');

  h.context.chat.push(assistant(''));
  h.emit('STREAM_TOKEN_RECEIVED', '真实 AI 首字');
  await waitFor(() => h.runtime.getState().rememberedCount === 2 && !h.runtime.getState().activeAutoMemory);
  assert.deepEqual(h.calls.map(call => call.systemPrompt), [EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT]);
});

test('不同槽或 first_message 的 MESSAGE_RECEIVED 不冒充已武装 normal final', async () => {
  let releaseExtractor, markStarted;
  let extractorCalls = 0;
  const started = new Promise(resolve => { markStarted = resolve; });
  const h = harness({
    initialChat: [assistant('已建楼'), assistant('上一楼正文')],
    automation: { enabled: true, batchSize: 1 },
    utility: options => {
      if (options.systemPrompt !== EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { noMaterialChange: true } };
      extractorCalls += 1;
      if (extractorCalls === 1) return { jsonData: { summary: '已建楼摘要' } };
      markStarted();
      return new Promise(resolve => { releaseExtractor = () => resolve({ jsonData: { summary: '不应提交的迟到摘要' } }); });
    },
  });
  await primeEarlyGenerationTail(h);
  h.context.chat.push(user('继续'));
  h.emit('GENERATION_STARTED', 'normal');
  h.context.chat.push(assistant(''));
  h.emit('STREAM_TOKEN_RECEIVED', '当前楼首字');
  await started;
  h.emit('MESSAGE_RECEIVED', 0, 'first_message');
  releaseExtractor();
  await waitFor(() => !h.runtime.getState().activeAutoMemory && !h.runtime.getState().activeExtraction);
  assert.equal(h.runtime.getState().rememberedCount, 1, '无关 MESSAGE_RECEIVED 必须走原取消路径，迟到摘要不得提交');
});

test('提前触发忽略空正文、非 normal、dry-run、嵌套 token 与停止后的迟到 token', async () => {
  const cases = [
    ['regenerate', false, false],
    ['swipe', false, false],
    ['continue', false, false],
    ['quiet', false, false],
    ['impersonate', false, false],
    ['normal', true, false],
    ['normal', false, true],
  ];
  for (const [type, dryRun, nested] of cases) {
    const h = harness({ initialChat: [assistant('已建楼'), assistant('上一楼正文')], automation: { enabled: true, batchSize: 1 } });
    await primeEarlyGenerationTail(h);
    h.context.chat.push(user('继续'));
    h.emit('GENERATION_STARTED', type, {}, dryRun);
    if (nested) h.emit('GENERATION_STARTED', 'normal', {}, false);
    h.context.chat.push(assistant(''));
    h.emit('STREAM_TOKEN_RECEIVED', '正文');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(h.calls.length, 0, `${type}/${dryRun ? 'dry' : nested ? 'nested' : 'direct'} 不得提前调用`);
  }

  const stopped = harness({ initialChat: [assistant('已建楼'), assistant('上一楼正文')], automation: { enabled: true, batchSize: 1 } });
  await primeEarlyGenerationTail(stopped);
  stopped.context.chat.push(user('继续'));
  stopped.emit('GENERATION_STARTED', 'normal');
  stopped.context.chat.push(assistant(''));
  stopped.emit('GENERATION_STOPPED');
  stopped.emit('STREAM_TOKEN_RECEIVED', '停止后的迟到正文');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(stopped.calls.length, 0);
});

test('切聊天及正文结构事件会撤销提前武装，迟到 token 不得写入或调用模型', async () => {
  for (const mutation of ['CHAT_CHANGED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED']) {
    const h = harness({ initialChat: [assistant('已建楼'), assistant('上一楼正文')], automation: { enabled: true, batchSize: 1 } });
    await primeEarlyGenerationTail(h);
    h.context.chat.push(user('继续'));
    h.emit('GENERATION_STARTED', 'normal');
    h.context.chat.push(assistant(''));
    if (mutation === 'CHAT_CHANGED') {
      h.context.chatId = 'host-other';
      h.context.chatMetadata = { qianqianjie: { schemaVersion: 1, chatId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } };
    }
    h.emit(mutation, 0);
    h.emit('STREAM_TOKEN_RECEIVED', '迟到正文');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(h.calls.length, 0, `${mutation} 后不得触发旧楼任务`);
  }
});

test('STOPPED 会中止已在 root 提交点等待的提前地基，释放后不新增稳定楼', async () => {
  const h = harness({ initialChat: [assistant('已建楼'), assistant('上一楼正文')], automation: { enabled: true, batchSize: 1 } });
  await primeEarlyGenerationTail(h);
  h.context.chat.push(user('继续'));
  h.emit('GENERATION_STARTED', 'normal');
  h.context.chat.push(assistant(''));
  const gate = h.backend.holdNextRootPut();
  h.emit('STREAM_TOKEN_RECEIVED', '当前楼首字');
  await gate.started;
  h.emit('GENERATION_STOPPED');
  gate.release();
  await waitFor(() => !h.runtime.getState().activeAutoMemory && !h.runtime.getState().activeExtraction);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.foundationRuntime.getReachable().floors.length, 1, '中止后的 early root 不得迟到提交新楼');
  assert.equal(h.calls.length, 0);
});

test('MESSAGE_SENT 确认上一楼后，Luker 更新与非流式 final 不会重复提取', async () => {
  const utility = options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
    ? { jsonData: { summary: '上一楼摘要' } }
    : { jsonData: { noMaterialChange: true } };
  const takeover = harness({ modernAnchors: true, initialChat: [assistant('已建楼'), user('确认已建楼'), assistant('上一楼正文')], host: 'luker', automation: { enabled: true, batchSize: 1 }, utility });
  await primeEarlyGenerationTail(takeover);
  takeover.context.chat.push(user('继续'));
  takeover.emit('MESSAGE_SENT', 3);
  await waitFor(() => takeover.runtime.getState().rememberedCount === 2 && !takeover.runtime.getState().activeAutoMemory);
  assert.deepEqual(takeover.calls.map(call => call.systemPrompt), [EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT]);
  takeover.emit('GENERATION_STARTED', 'normal');
  takeover.emit('MESSAGE_UPDATED', 0);
  takeover.context.chat.push(assistant('...'));
  takeover.emit('MESSAGE_UPDATED', 4);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(takeover.calls.length, 2, '旧槽更新与占位均不得重复提取');
  takeover.context.chat[4].mes = 'takeover 首段';
  takeover.context.chat[4].swipes[0] = 'takeover 首段';
  takeover.emit('MESSAGE_UPDATED', 4);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(takeover.calls.length, 2, '当前楼首段也不得重复提取已由 user 确认的上一楼');

  const nonstream = harness({ modernAnchors: true, initialChat: [assistant('已建楼'), user('确认已建楼'), assistant('非流式上一楼')], automation: { enabled: true, batchSize: 1 }, utility });
  await primeEarlyGenerationTail(nonstream);
  nonstream.context.chat.push(user('继续'));
  nonstream.emit('MESSAGE_SENT', 3);
  await waitFor(() => nonstream.runtime.getState().rememberedCount === 2 && !nonstream.runtime.getState().activeAutoMemory);
  nonstream.emit('GENERATION_STARTED', 'normal');
  nonstream.context.chat.push(assistant('非流式当前楼'));
  nonstream.emit('GENERATION_ENDED');
  nonstream.emit('MESSAGE_RECEIVED', 4);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(nonstream.calls.map(call => call.systemPrompt), [EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT]);
});

test('生成生命周期常量不齐时整体回退 isGenerating，不会产生只开不关的临时状态', async () => {
  const ordinaryEvents = Object.fromEntries(['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MORE_MESSAGES_LOADED'].map(name => [name, name]));
  for (const lifecycleEvents of [
    { GENERATION_STARTED: 'GENERATION_STARTED', GENERATION_STOPPED: 'GENERATION_STOPPED' },
    { GENERATION_STARTED: 'GENERATION_STARTED', GENERATION_ENDED: 'GENERATION_ENDED' },
  ]) {
    const notifications = [];
    const h = harness({
      initialChat: [user('开始'), assistant('历史一'), assistant('历史二'), assistant('待确认尾楼')],
      automation: { enabled: true, batchSize: 2 },
      isMainGenerationActive: () => false,
      notifyUser: value => notifications.push(value),
      eventTypes: { ...ordinaryEvents, ...lifecycleEvents },
    });
    await h.runtime.start();
    h.emit('GENERATION_STARTED', 'normal');
    await h.runtime.startHistoricalRebuild();
    await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()) && !h.runtime.getState().activeAutoMemory);

    assert.equal(h.runtime.getState().rememberedCount, 2);
    assert.deepEqual(h.calls.map(call => call.systemPrompt), [EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT, EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT]);
    assert.match(notifications[0].text, /从第 1 楼起还有 2 楼摘要未完成.*不会自动补/);
    assert.deepEqual(notifications[1], { kind: 'info', text: '千千结开始补齐 2 楼摘要（从第 1 楼起）。' });
    assert.deepEqual(notifications[2], { kind: 'success', text: '千千结已完成历史记忆维护：新增摘要 2 楼，补齐人物状态 2 楼。' });
    assert.equal(h.runtime.shouldBlockMainGeneration(), false);
  }
});

test('主模型正在生成时拒绝启动历史维护；结束后按钮可正常授权并完成', async () => {
  let mainGenerating = true;
  const notifications = [];
  const h = harness({
    initialChat: [user('开始'), assistant('历史一'), assistant('历史二'), assistant('待确认尾楼')],
    automation: { enabled: true, batchSize: 2 },
    isMainGenerationActive: () => mainGenerating,
    notifyUser: value => notifications.push(value),
  });
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  assert.equal(h.calls.length, 0);
  assert.equal(h.runtime.shouldBlockMainGeneration(), false);
  assert.match(notifications[0].text, /从第 1 楼起还有 2 楼摘要未完成.*不会自动补/);
  assert.deepEqual(notifications[1], { kind: 'warning', text: '主模型正在生成，请等待完成后再开始重建。' });

  mainGenerating = false;
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()));
  assert.equal(h.runtime.getState().rememberedCount, 2);
  assert.equal(h.runtime.shouldBlockMainGeneration(), false);
});

test('真实切聊天与目标正文编辑/删除/swipe 都会撤销旧历史维护门禁', async () => {
  for (const eventName of ['CHAT_CHANGED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED']) {
    let release;
    let startedResolve;
    const started = new Promise(resolve => { startedResolve = resolve; });
    const h = harness({
      initialChat: [user('开始'), assistant('历史一'), assistant('历史二'), assistant('待确认尾楼')],
      automation: { enabled: true, batchSize: 2 },
      utility: options => {
        if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT && !release) {
          startedResolve();
          return new Promise(resolve => { release = () => resolve({ jsonData: { summary: '事件后迟到摘要' } }); });
        }
        return options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT ? { jsonData: { summary: '摘要' } } : { jsonData: { noMaterialChange: true } };
      },
    });
    await h.runtime.start();
    const rebuilding = h.runtime.startHistoricalRebuild();
    await started;
    assert.equal(h.runtime.shouldBlockMainGeneration(), true, `${eventName} 前应处于维护态`);
    if (eventName === 'CHAT_CHANGED') {
      h.context.chatId = 'host-other';
      h.context.chatMetadata = { qianqianjie: { schemaVersion: 1, chatId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } };
      h.context.chat = [user('另一聊天'), assistant('另一聊天正文')];
    } else if (eventName === 'MESSAGE_DELETED') {
      h.context.chat.splice(1, 1);
    } else {
      h.context.chat[1] = assistant(`被 ${eventName} 改写的目标正文`);
    }
    h.emit(eventName, 1);
    await waitFor(() => h.runtime.shouldBlockMainGeneration() === false, `${eventName} 必须在依赖复核后撤销旧门禁`);
    release();
    await rebuilding;
    await waitFor(() => !h.runtime.getState().activeAutoMemory, `${eventName} 后旧作业未退出`);
  }
});

test('历史未完整时收到新回复，即使自动维护开启也只更新缺口检测，不偷跑重建', async () => {
  const h = harness({
    initialChat: [user('开始'), assistant('历史一'), assistant('历史二'), assistant('待确认尾楼')],
    automation: { enabled: true, batchSize: 2 },
  });
  await h.runtime.start();
  h.context.chat.push(assistant('让上一楼稳定的新回复'));
  h.emit('MESSAGE_RECEIVED');
  await h.foundationRuntime.refreshStatus();
  await h.runtime.refreshStatus();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.calls.length, 0);
  assert.equal(h.runtime.getState().rebuildStatus, 'pendingRebuild');
  assert.equal(h.runtime.getState().rebuildNextAssistantSeq, 1);
});

test('历史重建中关闭会使旧响应失效，重新开启后从 reachable 事实继续而不串档', async () => {
  let releaseFirst;
  let firstStartedResolve;
  let hold = true;
  const firstStarted = new Promise(resolve => { firstStartedResolve = resolve; });
  const h = harness({
    initialChat: [user('开始'), assistant('历史一'), assistant('历史二'), assistant('历史三'), assistant('待确认尾楼')],
    automation: { enabled: true, batchSize: 2 },
    utility: options => {
      if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT && hold) {
        hold = false;
        firstStartedResolve();
        return new Promise(resolve => { releaseFirst = () => resolve({ jsonData: { summary: '迟到旧摘要' } }); });
      }
      return options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT ? { jsonData: { summary: '恢复后摘要' } } : { jsonData: { noMaterialChange: true } };
    },
  });
  await h.runtime.start();
  const rebuilding = h.runtime.startHistoricalRebuild();
  await firstStarted;
  assert.equal(h.runtime.shouldBlockMainGeneration(), true);
  h.setEnabled(false);
  const disabling = h.runtime.setEnabled(false);
  assert.equal(h.runtime.shouldBlockMainGeneration(), false, '关闭插件必须立即释放主生成门禁');
  releaseFirst();
  await Promise.all([disabling, rebuilding]);
  await waitFor(() => !h.runtime.getState().activeAutoMemory);
  assert.equal(h.runtime.getState().rememberedCount, 0, '关闭前的迟到响应不得提交');
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 0);

  h.setEnabled(true);
  await h.runtime.setEnabled(true);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.calls.length, 1, '重新开启不得恢复已经失效的运行时授权');
  assert.equal(h.runtime.getState().rebuildStatus, 'pendingRebuild');
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()) && !h.runtime.getState().activeAutoMemory, '手动继续后未从持久事实恢复');
  assert.equal(h.runtime.getState().rememberedCount, 3);
  assert.equal(h.runtime.getState().cseReady, true);
});

test('按钮启动的历史会话暂停后，当前会话的设置刷新与新消息事件都不自动恢复，手动继续可恢复', async () => {
  let releaseSecond;
  let secondStartedResolve;
  const secondStarted = new Promise(resolve => { secondStartedResolve = resolve; });
  const first = harness({
    initialChat: [user('开始'), assistant('历史一'), assistant('历史二'), assistant('历史三'), assistant('待确认尾楼')],
    automation: { enabled: true, batchSize: 2 },
    utility: options => {
      if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) {
        const content = JSON.parse(options.taskMessages[0].content).payload.canonicalContent;
        if (content === '历史二' && !releaseSecond) {
          secondStartedResolve();
          return new Promise(resolve => { releaseSecond = () => resolve({ jsonData: { summary: '不应提交的迟到第二楼' } }); });
        }
        return { jsonData: { summary: `摘要-${content}` } };
      }
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await first.runtime.start();
  const rebuilding = first.runtime.startHistoricalRebuild();
  await secondStarted;
  assert.equal(first.runtime.getState().rememberedCount, 1, '暂停前已经落盘的第一楼应保留');
  assert.equal(first.runtime.shouldBlockMainGeneration(), true);
  first.runtime.pauseHistoricalRebuild();
  assert.equal(first.runtime.shouldBlockMainGeneration(), false, '暂停按钮必须同步释放主生成门禁');
  releaseSecond();
  await rebuilding;
  await waitFor(() => !first.runtime.getState().activeAutoMemory);
  assert.equal(first.runtime.getState().rebuildStatus, 'paused');
  assert.equal(first.runtime.getState().rememberedCount, 1);
  assert.equal(first.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 1, '暂停保留首楼已完成初始化CSE，不得继续后楼');
  const callsAtPause = first.calls.length;
  await first.runtime.refreshAutomation();
  first.emit('GENERATION_STARTED', 'normal');
  first.context.chat.push(assistant('暂停期间新增的未稳定尾楼'));
  first.emit('STREAM_TOKEN_RECEIVED', '暂停期间新增正文');
  first.emit('GENERATION_ENDED');
  first.emit('MESSAGE_RECEIVED', first.context.chat.length - 1, 'normal');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(first.calls.length, callsAtPause, '显式暂停后设置刷新与新消息事件都不得恢复 API');
  assert.equal(first.runtime.getState().lastAutoMemory.status, 'paused');

  await first.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(first.runtime.getState()) && !first.runtime.getState().activeAutoMemory);
  assert.equal(first.runtime.getState().rememberedCount, 4);
  assert.equal(first.runtime.getState().cseReady, true);
});

test('自动 reconciling、extracting、CSE 全程共用一个门闩，手动入口不并发且逐楼完成后恢复', async () => {
  let holdFoundation = false, releaseFoundation, foundationStartedResolve;
  let holdExtractor = false, holdCse = false;
  let releaseExtractor, extractorStartedResolve;
  let releaseCse, cseStartedResolve;
  const foundationStarted = new Promise(resolve => { foundationStartedResolve = resolve; });
  const extractorStarted = new Promise(resolve => { extractorStartedResolve = resolve; });
  const cseStarted = new Promise(resolve => { cseStartedResolve = resolve; });
  const automaticSummaryReceipts = [];
  const h = harness({
    modernAnchors: true,
    initialChat: [user('开始'), assistant('已建楼'), user('确认已建楼'), assistant('待确认尾楼')],
    automation: { enabled: false, batchSize: 2 },
    onAutomaticSummaryCommitted: receipt => { automaticSummaryReceipts.push(receipt); },
    foundationRefresh: async base => {
      if (holdFoundation) {
        holdFoundation = false;
        foundationStartedResolve();
        await new Promise(resolve => { releaseFoundation = resolve; });
      }
      return base.refreshStatus();
    },
    utility: options => {
      if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) {
        if (holdExtractor && !releaseExtractor) return new Promise(resolve => { releaseExtractor = () => resolve({ jsonData: { summary: '自动提取摘要' } }); extractorStartedResolve(); });
        return { jsonData: { summary: '自动提取摘要' } };
      }
      if (holdCse && !releaseCse) return new Promise(resolve => { releaseCse = () => resolve({ jsonData: { noMaterialChange: true } }); cseStartedResolve(); });
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await primeRealtimeTail(h);
  const firstFloorId = h.runtime.getState().floors[0].floorId;
  holdFoundation = true;
  holdExtractor = true;
  holdCse = true;
  h.context.chat.push(user('确认待处理尾楼。'));
  h.emit('MESSAGE_SENT', h.context.chat.length - 1);
  await foundationStarted;
  assert.equal(h.runtime.getState().activeAutoMemory.phase, 'reconciling');
  assert.equal(h.runtime.shouldBlockMainGeneration(), false, '日常自动 reconciling 不得阻断主生成');
  await Promise.all([h.runtime.extractNext(), h.runtime.retryStateAnalysis(firstFloorId)]);
  assert.equal(h.calls.length, 0, 'reconciling 期间手动入口不得越过共享门闩');
  releaseFoundation();

  await extractorStarted;
  assert.equal(h.runtime.getState().activeAutoMemory.phase, 'extracting');
  assert.equal(h.runtime.shouldBlockMainGeneration(), false, '日常自动 extracting 不得阻断主生成');
  const callsDuringExtraction = h.calls.length;
  await Promise.all([h.runtime.extractFloor(firstFloorId), h.runtime.analyzeNextState()]);
  assert.equal(h.calls.length, callsDuringExtraction, 'extracting 期间手动入口不得形成第二条 API 链');
  releaseExtractor();

  await cseStarted;
  assert.equal(automaticSummaryReceipts.length, 2, '自动摘要正式提交后按两楼各通知一次人物资料维护');
  assert.ok(automaticSummaryReceipts.every(receipt => receipt.chatId === CHAT
    && h.runtime.getState().floors.some(floor => floor.floorId === receipt.floorId && floor.memoryId === receipt.memoryId && floor.status === 'ready')));
  assert.equal(h.runtime.getState().activeAutoMemory.phase, 'analyzingCse');
  assert.equal(h.runtime.shouldBlockMainGeneration(), false, '日常自动 CSE 不得阻断主生成');
  const callsDuringCse = h.calls.length;
  await Promise.all([h.runtime.extractNext(), h.runtime.retryStateAnalysis(firstFloorId)]);
  assert.equal(h.calls.length, callsDuringCse, 'CSE 期间手动入口不得形成第二条 API 链');
  releaseCse();
  await waitFor(() => h.runtime.getState().lastAutoMemory?.status === 'completed' && !h.runtime.getState().memoryWorkBusy);

  const callsAfterBatch = h.calls.length;
  await h.runtime.extractFloor(firstFloorId);
  assert.equal(h.calls.length, callsAfterBatch + 1, '批次完成后摘要入口恢复，但不自动重算已存 CSE');
  assert.equal(automaticSummaryReceipts.length, 2, '手动单楼提取不得冒充自动摘要通知');
  await h.runtime.editSummary(firstFloorId, '人工修订后的摘要');
  assert.equal(automaticSummaryReceipts.length, 2, '人工摘要修订不得触发人物资料维护');
});

test('历史欠账期间开启自动维护只改设置，不在手动作业结束后偷跑历史', async () => {
  let releaseManual;
  let manualStartedResolve;
  const manualStarted = new Promise(resolve => { manualStartedResolve = resolve; });
  let hold = true;
  const h = harness({
    initialChat: [user('开始'), assistant('历史一'), assistant('历史二'), assistant('待确认尾楼')],
    automation: { enabled: false, batchSize: 2 },
    utility: options => {
      if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT && hold) {
        hold = false;
        manualStartedResolve();
        return new Promise(resolve => { releaseManual = () => resolve({ jsonData: { summary: '手动完成第一楼' } }); });
      }
      return options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT ? { jsonData: { summary: '自动完成后续楼' } } : { jsonData: { noMaterialChange: true } };
    },
  });
  await h.runtime.start();
  const firstFloorId = h.runtime.getState().floors[0].floorId;
  const manual = h.runtime.extractFloor(firstFloorId, { analyzeState: false });
  await manualStarted;

  h.setAutomation({ enabled: true, batchSize: 2 });
  await Promise.all([h.runtime.refreshAutomation(), h.runtime.refreshAutomation(), h.runtime.refreshAutomation()]);
  assert.equal(h.runtime.getState().activeMemoryWork.kind, 'manual');
  releaseManual();
  await manual;
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, 1);
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 0);
  assert.equal(h.runtime.getState().rebuildStatus, 'pendingRebuild');
  assert.equal(h.runtime.getState().lastAutoMemory, null);
});

test('手动 workRun 忙碌期间关闭自动记忆会清掉旧待触发，不在结束后补跑', async () => {
  let releaseManual;
  let manualStartedResolve;
  const manualStarted = new Promise(resolve => { manualStartedResolve = resolve; });
  const h = harness({
    initialChat: [user('开始'), assistant('历史一'), assistant('历史二'), assistant('待确认尾楼')],
    automation: { enabled: false, batchSize: 2 },
    utility: options => {
      if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT && !releaseManual) {
        manualStartedResolve();
        return new Promise(resolve => { releaseManual = () => resolve({ jsonData: { summary: '仅完成手动作业' } }); });
      }
      return options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT ? { jsonData: { summary: '不应发生的自动提取' } } : { jsonData: { noMaterialChange: true } };
    },
  });
  await h.runtime.start();
  const manual = h.runtime.extractFloor(h.runtime.getState().floors[0].floorId, { analyzeState: false });
  await manualStarted;
  h.setAutomation({ enabled: true, batchSize: 2 });
  await h.runtime.refreshAutomation();
  h.setAutomation({ enabled: false, batchSize: 2 });
  await h.runtime.refreshAutomation();
  releaseManual();
  await manual;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, 1);
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 0);
  assert.equal(h.runtime.getState().lastAutoMemory, null);
});

test('新档 0 楼在首条 user 锚后初始化，并在 2 楼到达时只摘要 0 楼', async () => {
  const h = harness({
    initialChat: [assistant('AI0 新档开场。')],
    modernAnchors: true,
    automation: { enabled: true, batchSize: 1 },
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: '0 楼开场摘要。' } }
      : { jsonData: { noMaterialChange: true } },
  });
  await h.runtime.start();
  assert.equal(h.runtime.allowsRealtimeTailFromEmpty(), true, '新空档启动后应留下实时来源证明');
  assert.deepEqual(h.runtime.getState().unregisteredCandidates, [
    { assistantSeq: 1, messageIndex: 0, reason: 'waitingNextUser' },
  ]);

  h.context.chat.push({ ...user('U1 确认开场。'), send_date: 'new-chat-anchor-u1' });
  h.emit('MESSAGE_SENT', 1);
  await waitFor(() => h.foundationRuntime.getState().stableCount === 1
    && h.runtime.getState().floors.length === 1, '首条 user 锚后新档 root 未被内存层接收');
  assert.equal(h.foundationRuntime.getState().stableCount, 1);
  assert.equal(h.backend.records.has(`chat-${CHAT}/v3-root`), true, '首条 user 锚应允许新空档登记 0 楼');

  h.context.chat.push(assistant('AI2 尚待下一条 user 确认。'));
  h.emit('MESSAGE_RECEIVED', 2);
  await waitFor(() => h.runtime.getState().rememberedCount === 1 && h.runtime.getState().cseReady, '新档 0 楼未自动完成摘要');
  const extractorCalls = h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT);
  assert.equal(extractorCalls.length, 1, '0 楼只能自动摘要一次');
  const extractorRequest = JSON.parse(extractorCalls[0].taskMessages[0].content);
  assert.equal(extractorRequest.task, 'extractFloorSemantics');
  assert.equal(Object.hasOwn(extractorRequest, 'floors'), false, '实时新楼同样必须走单楼请求');
  const state = h.runtime.getState();
  assert.equal(state.floors[0].messageIndex, 0);
  assert.equal(state.floors[0].memory.recordStatus, 'active');
  assert.deepEqual(state.unregisteredCandidates, [
    { assistantSeq: 2, messageIndex: 2, reason: 'waitingNextUser' },
  ], '2 楼仍须等待下一条 user 消息，不得抢跑摘要');
});

test('有稳定历史的未初始化聊天只暴露继续入口；显式建档后新 user 锚自动补齐且重复事件去重', async () => {
  const h = harness({
    initialChat: [assistant('历史 AI0。'), user('历史 U1。')],
    modernAnchors: true,
    automation: { enabled: true, batchSize: 1 },
    readOnlyLifecycle: true,
  });
  await h.runtime.start();
  assert.equal(h.runtime.getState().canInitialize, true);
  assert.equal(h.calls.length, 0);
  h.context.chat.push(assistant('历史 AI2。'), { ...user('U3 只触发检查。'), send_date: 'history-anchor-u3' });
  h.emit('MESSAGE_SENT', 3);
  await waitFor(() => h.foundationRuntime.getState().status === 'uninitialized'
    && h.foundationRuntime.getState().inspectedStableCount === 2, '未初始化聊天的新 user 锚未完成只读检查');
  assert.equal(h.calls.length, 0, '未初始化的历史聊天不得自动调用模型');
  assert.equal([...h.backend.records.keys()].some(key => key.endsWith('/v3-root')), false, '未初始化的历史聊天不得写记忆图');

  await h.runtime.startHistoricalRebuild();
  await waitFor(() => h.runtime.getState().rememberedCount === 2 && h.runtime.getState().cseReady, '显式继续未完成历史建档');
  const callsAfterFirst = h.calls.length;
  assert.equal(callsAfterFirst, 4);

  h.context.chat.push(assistant('AI4 等待新锚。'), { ...user('U5 正式入列。'), send_date: 'anchor-u5' });
  h.emit('MESSAGE_SENT', 5);
  await waitFor(() => h.runtime.getState().rememberedCount === 3 && h.runtime.getState().cseReady, '已初始化聊天的新 user 锚未自动补齐');
  const callsAfterSecond = h.calls.length;
  assert.equal(callsAfterSecond, callsAfterFirst + 2);
  h.emit('MESSAGE_SENT', 5);
  h.emit('USER_MESSAGE_RENDERED', 5);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.calls.length, callsAfterSecond, '重复 sent/rendered 事件不得重复摘要或 CSE');

  const disabled = harness({
    initialChat: [assistant('关闭自动维护的 AI0。')],
    modernAnchors: true,
    automation: { enabled: false, batchSize: 1 },
    readOnlyLifecycle: true,
  });
  await disabled.runtime.start();
  disabled.context.chat.push({ ...user('U1'), send_date: 'disabled-anchor' });
  disabled.emit('MESSAGE_SENT', 1);
  await waitFor(() => disabled.foundationRuntime.getState().canInitialize === true, '关闭自动维护时也应只读发现稳定候选');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(disabled.calls.length, 0);
  assert.equal([...disabled.backend.records.keys()].some(key => key.endsWith('/v3-root')), false);
});

test('24 楼旧 nextAssistant 数据在真实 user 邻接下原代升级，保留 floor/memory/delta 且零重提取', async () => {
  const chat = Array.from({ length: 24 }, (_, index) => [
    assistant(`旧档 AI-${index + 1}`),
    { ...user(`旧档 U-${index + 1}`), send_date: `legacy-anchor-${index + 1}` },
  ]).flat();
  const initial = harness({
    initialChat: chat,
    automation: { enabled: true, batchSize: 24 },
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: '旧档已保存摘要。' } }
      : { jsonData: { noMaterialChange: true } },
  });
  await initial.runtime.start();
  await initial.runtime.startHistoricalRebuild();
  for (let attempt = 0; attempt < 15000 && !(registeredGraphCaughtUp(initial.runtime.getState()) && !initial.runtime.getState().activeAutoMemory); attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(registeredGraphCaughtUp(initial.runtime.getState()) && !initial.runtime.getState().activeAutoMemory, true, JSON.stringify(initial.runtime.getState()));
  const before = await initial.store.readReachable({ mode: 'runtime' });
  assert.deepEqual([before.floors.length, before.floorMemories.length, before.stateDeltas.length], [24, 24, 24]);
  const beforeIds = {
    generation: before.root.narrativeGeneration,
    floors: before.floors.map(item => item.id),
    memories: before.floorMemories.map(item => item.id),
    deltas: before.stateDeltas.map(item => item.id),
  };

  for (const envelope of initial.backend.records.values()) {
    if (envelope.data.recordType === 'floor') {
      envelope.data.stability.stabilizedBy = 'nextAssistant';
      delete envelope.data.stability.proof;
    }
    if (envelope.data.recordType === 'checkpoint') {
      for (const item of envelope.data.inputFingerprints) delete item.stabilityFingerprint;
    }
  }
  const upgraded = harness({
    automation: { enabled: true, batchSize: 24 },
    modernAnchors: true,
    sharedBackend: initial.backend,
    sharedContext: initial.context,
  });
  await upgraded.runtime.start();
  await waitFor(() => upgraded.foundationRuntime.getState().status === 'ready');
  const after = await upgraded.store.readReachable({ mode: 'runtime' });
  assert.equal(after.root.narrativeGeneration, beforeIds.generation);
  assert.deepEqual(after.floors.map(item => item.id), beforeIds.floors);
  assert.deepEqual(after.floorMemories.map(item => item.id), beforeIds.memories);
  assert.deepEqual(after.stateDeltas.map(item => item.id), beforeIds.deltas);
  assert.ok(after.checkpoint.inputFingerprints.every(item => /^sha256:[0-9a-f]{64}$/u.test(item.stabilityFingerprint)));
  assert.equal(upgraded.calls.length, 0, '旧档升级只能重封口，不得重跑摘要或 CSE');

  upgraded.context.chat.splice(1, 1);
  await upgraded.foundationRuntime.refreshStatus();
  assert.equal(upgraded.foundationRuntime.getState().stableCount, 24, '已保存楼在 user 删除后仍由永久身份保持稳定');
});

test('旧楼摘要在途时追加后置 user 锚可推进稳定 head，提交只合入最新图且模型仅调用一次', async () => {
  let release, startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  let extractorCalls = 0;
  const h = harness({
    initialChat: [assistant('目标旧楼。'), user('目标稳定锚。'), assistant('等待新锚的后楼。')],
    modernAnchors: true,
    utility: options => {
      if (options.systemPrompt !== EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { noMaterialChange: true } };
      extractorCalls += 1;
      startedResolve();
      return new Promise(resolve => { release = () => resolve({ jsonData: { summary: '旧楼唯一摘要。' } }); });
    },
  });
  await h.runtime.start();
  const target = h.runtime.getState().floors[0];
  const pending = h.runtime.extractFloor(target.floorId, { analyzeState: false });
  await started;
  h.context.chat.push({ ...user('让后楼稳定的新锚。'), send_date: 'suffix-anchor' });
  h.emit('MESSAGE_SENT', 3);
  await waitFor(() => h.foundationRuntime.getState().status === 'ready' && h.foundationRuntime.getState().stableCount === 2, '后置 user 锚未推进稳定 head');
  const suffixFloorId = h.foundationRuntime.getReachable().floors[1].id;
  release();
  await pending;
  const graph = await h.store.readReachable({ mode: 'runtime' });
  assert.equal(extractorCalls, 1);
  assert.deepEqual(graph.floors.map(floor => floor.id), [target.floorId, suffixFloorId]);
  assert.equal(graph.floorMemories.find(memory => memory.floorId === target.floorId)?.summary.aiText, '旧楼唯一摘要。');
  assert.equal(graph.root.stableBoundary.floorId, suffixFloorId, '摘要提交不得把 head 倒退回旧楼');
});

test('同目标人工摘要阻止旧模型覆盖；CAS 期间新后缀触发一次有界重基且不重复 API', async () => {
  let blockSecond = false, releaseSecond, secondStartedResolve;
  const secondStarted = new Promise(resolve => { secondStartedResolve = resolve; });
  let extractorCalls = 0;
  const contextChat = [assistant('目标楼。'), user('目标锚。'), assistant('等待后置锚。')];
  const primary = harness({
    initialChat: contextChat,
    modernAnchors: true,
    utility: options => {
      if (options.systemPrompt !== EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { noMaterialChange: true } };
      extractorCalls += 1;
      if (!blockSecond) return { jsonData: { summary: '初始摘要。' } };
      secondStartedResolve();
      return new Promise(resolve => { releaseSecond = () => resolve({ jsonData: { summary: '不应覆盖人工摘要。' } }); });
    },
  });
  await primary.runtime.start();
  const targetId = primary.runtime.getState().floors[0].floorId;
  await primary.runtime.extractFloor(targetId, { analyzeState: false });
  blockSecond = true;
  const stale = primary.runtime.extractFloor(targetId, { analyzeState: false });
  await secondStarted;
  const editor = harness({ sharedBackend: primary.backend, sharedContext: primary.context, modernAnchors: true });
  await editor.runtime.start();
  await editor.runtime.editSummary(targetId, '并发人工摘要。', '用户优先');
  releaseSecond();
  await stale;
  let graph = await primary.store.readReachable({ mode: 'runtime' });
  assert.equal(graph.floorMemories.find(memory => memory.floorId === targetId)?.summary.userText, '并发人工摘要。');
  assert.equal(primary.runtime.getState().lastExtractorError?.code, 'V3_MEMORY_PREFIX_CHANGED');

  let releaseThird, thirdStartedResolve;
  const thirdStarted = new Promise(resolve => { thirdStartedResolve = resolve; });
  blockSecond = false;
  primary.setAutomation({ enabled: false, batchSize: 1 });
  const rebasing = harness({
    sharedBackend: primary.backend,
    sharedContext: primary.context,
    modernAnchors: true,
    utility: options => {
      if (options.systemPrompt !== EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { noMaterialChange: true } };
      extractorCalls += 1;
      thirdStartedResolve();
      return new Promise(resolve => { releaseThird = () => resolve({ jsonData: { summary: 'CAS 后摘要。' } }); });
    },
  });
  await rebasing.runtime.start();
  const casPending = rebasing.runtime.extractFloor(targetId, { analyzeState: false });
  await thirdStarted;
  const gate = primary.backend.holdNextRootPut();
  releaseThird();
  await gate.started;
  primary.context.chat.push({ ...user('CAS 期间追加锚。'), send_date: 'cas-suffix-anchor' });
  const foundationWriter = harness({ sharedBackend: primary.backend, sharedContext: primary.context, modernAnchors: true });
  await foundationWriter.runtime.start();
  const suffixFloorId = foundationWriter.foundationRuntime.getReachable().floors[1].id;
  gate.release();
  await casPending;
  graph = await rebasing.store.readReachable({ mode: 'runtime' });
  assert.equal(graph.root.stableBoundary.floorId, suffixFloorId, JSON.stringify({ suffixFloorId, boundary: graph.root.stableBoundary.floorId, floors: graph.floors.map(floor => [floor.id, floor.hostLocator.messageIndex, floor.content.canonicalContent]) }));
  assert.equal(graph.floors.length, 2);
  assert.equal(graph.floorMemories.find(memory => memory.floorId === targetId)?.summary.aiText, 'CAS 后摘要。');
  assert.equal(extractorCalls, 3, '人工冲突与 CAS 重基都不得重复调用模型');
});

test('未初始化长聊天的启动、刷新、切聊、新楼与 roll 全部只检查且零记忆图写入', async () => {
  const h = harness({
    initialChat: [user('开始'), assistant('旧楼一'), user('锚一'), assistant('旧楼二'), user('锚二'), assistant('未稳定尾楼')],
    modernAnchors: true,
    automation: { enabled: true, batchSize: 1 },
    readOnlyLifecycle: true,
  });
  await h.runtime.start();
  await h.runtime.refreshStatus();
  await h.runtime.refreshAutomation();
  h.emit('CHAT_CHANGED');
  await waitFor(() => h.runtime.getState().canInitialize === true, `未初始化切聊未回到可建档：${JSON.stringify(h.runtime.getState())}`);
  h.context.chat.push(assistant('新增 AI 仍不得自动建档'));
  h.emit('MESSAGE_RECEIVED', h.context.chat.length - 1);
  h.emit('GENERATION_STARTED', 'swipe', {}, false);
  h.context.chat[h.context.chat.length - 1] = { ...assistant('未初始化 roll 新结果'), swipes: ['新增 AI 仍不得自动建档', '未初始化 roll 新结果'], swipe_id: 1 };
  h.emit('GENERATION_ENDED');
  h.emit('MESSAGE_RECEIVED', h.context.chat.length - 1, 'swipe');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(h.calls.length, 0);
  assert.equal([...h.backend.records.keys()].some(key => key.endsWith('/v3-root')), false);
  assert.equal(h.runtime.getState().canInitialize, true);
});

test('swipe STOPPED 后迟到 final 不消费真实欠账，下一次真实 swipe 仍可补齐', async () => {
  const seed = await seedContinuousSummaryTail(1);
  const h = harness({ automation: { enabled: true, batchSize: 1 }, sharedBackend: seed.backend, sharedContext: seed.context, readOnlyLifecycle: true });
  await h.runtime.start();
  const messageIndex = h.context.chat.length - 1;
  const previous = h.context.chat[messageIndex].mes;
  h.context.chat[messageIndex] = { ...assistant(''), swipes: [previous, ''], swipe_id: 1 };
  h.emit('MESSAGE_SWIPED', messageIndex, { pendingGeneration: true, previousSwipeId: 0, nextSwipeId: 1 });
  h.emit('GENERATION_STARTED', 'swipe', {}, false);
  h.context.chat[messageIndex].swipes[1] = '已停止 swipe 的迟到正文';
  h.context.chat[messageIndex].mes = '已停止 swipe 的迟到正文';
  h.emit('GENERATION_STOPPED');
  h.emit('MESSAGE_RECEIVED', messageIndex, 'swipe');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(h.calls.length, 0, '停止后的 swipe final 不得借已有欠账调用模型');

  h.context.chat[messageIndex].swipes.push('');
  h.context.chat[messageIndex].swipe_id = 2;
  h.context.chat[messageIndex].mes = '';
  h.emit('MESSAGE_SWIPED', messageIndex, { pendingGeneration: true, previousSwipeId: 1, nextSwipeId: 2 });
  h.emit('GENERATION_STARTED', 'swipe', {}, false);
  h.context.chat[messageIndex].swipes[2] = '下一次真实 swipe 正文';
  h.context.chat[messageIndex].mes = '下一次真实 swipe 正文';
  h.emit('GENERATION_ENDED');
  h.emit('MESSAGE_RECEIVED', messageIndex, 'swipe');
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()) && !h.runtime.getState().memoryWorkBusy);
  assert.deepEqual(h.calls.map(call => call.systemPrompt), [EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT]);
});

test('normal STOPPED 后迟到 final 不消费真实欠账，下一次真实 normal 仍可补齐', async () => {
  const seed = await seedContinuousSummaryTail(1);
  const h = harness({ automation: { enabled: true, batchSize: 1 }, sharedBackend: seed.backend, sharedContext: seed.context, readOnlyLifecycle: true });
  await h.runtime.start();
  h.emit('GENERATION_STARTED', 'normal', {}, false);
  h.context.chat.push(assistant('已停止 normal 的迟到正文'));
  const stoppedIndex = h.context.chat.length - 1;
  h.emit('GENERATION_STOPPED');
  h.emit('MESSAGE_RECEIVED', stoppedIndex, 'normal');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(h.calls.length, 0, '停止后的 normal final 不得借已有欠账调用模型');

  h.emit('GENERATION_STARTED', 'normal', {}, false);
  h.context.chat.push(assistant('下一次真实 normal 正文'));
  const completedIndex = h.context.chat.length - 1;
  h.emit('GENERATION_ENDED');
  h.emit('MESSAGE_RECEIVED', completedIndex, 'normal');
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()) && !h.runtime.getState().memoryWorkBusy);
  assert.ok(h.calls.length > 0, '下一次真实 normal 必须获得新的自动补齐授权');
  assert.equal(h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length,
    h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length);
});

test('已落盘 marker 在删除后置 user 后永久保留 floor/memory/CSE，且零模型重调', async () => {
  let context;
  const persistAnchors = async ({ chatId, bindings }) => {
    for (const binding of bindings) {
      const message = context.chat[binding.messageIndex];
      message.extra = { ...(message.extra ?? {}), qianqianjie_floor: { schemaVersion: 1, chatId, floorId: binding.floorId } };
    }
  };
  const h = harness({
    initialChat: [assistant('永久正文'), user('继续'), assistant('待确认尾楼')], modernAnchors: true, persistAnchors,
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: `摘要-${JSON.parse(options.taskMessages[0].content).payload.canonicalContent}` } }
      : { jsonData: { noMaterialChange: true } },
  });
  context = h.context;
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()));
  const before = h.runtime.getState().floors[0];
  const beforeCse = h.runtime.getState().cseFloors[0];
  assert.equal(context.chat[0].extra.qianqianjie_floor.floorId, before.floorId);
  h.calls.splice(0);
  context.chat.splice(1, 1);
  await h.foundationRuntime.refreshStatus();
  await h.runtime.refreshStatus();
  const after = h.runtime.getState().floors[0];
  const afterCse = h.runtime.getState().cseFloors[0];
  assert.deepEqual([after.floorId, after.memoryId, afterCse.deltaId], [before.floorId, before.memoryId, beforeCse.deltaId]);
  assert.equal(h.calls.length, 0);
});

test('marker 保存失败后删后置 user 仍保留已提交记忆并只重试挂标', async () => {
  const h = harness({
    initialChat: [assistant('唯一旧正文'), user('继续'), assistant('待确认尾楼')], modernAnchors: true,
    persistAnchors: async () => { const error = new Error('marker write failed'); error.code = 'V3_MESSAGE_ANCHOR_SAVE_FAILED'; throw error; },
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT ? { jsonData: { summary: '已保存摘要' } } : { jsonData: { noMaterialChange: true } },
  });
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()));
  const before = h.runtime.getState().floors[0];
  const beforeCse = h.runtime.getState().cseFloors[0];
  assert.equal(h.runtime.getState().lastExtractorError?.phase, 'anchor');
  h.calls.splice(0);
  h.context.chat[0] = { ...h.context.chat[0], mes: '唯一旧正文<!--宿主新包装-->', swipes: ['唯一旧正文<!--宿主新包装-->'] };
  h.context.chat.splice(1, 1);
  await h.foundationRuntime.refreshStatus();
  await h.runtime.refreshStatus();
  const after = h.runtime.getState().floors[0];
  assert.deepEqual([after.floorId, after.memoryId, h.runtime.getState().cseFloors[0].deltaId], [before.floorId, before.memoryId, beforeCse.deltaId]);
  assert.equal(h.calls.length, 0);
  assert.equal(h.runtime.getState().lastExtractorError?.phase, 'anchor');
  assert.notEqual(h.runtime.getState().summaryCoverageStatus, 'unknown');
  assert.equal(h.runtime.getState().summaryCompletedCount, h.runtime.getState().stableCount);
});

test('后置 foreign marker 不得让未挂标的已摘要前缀归零或被完整聊天删除', async () => {
  const h = harness({
    initialChat: [assistant('永久前缀 A'), user('继续'), assistant('待确认尾楼')], modernAnchors: true,
    persistAnchors: async () => { const error = new Error('marker write failed'); error.code = 'V3_MESSAGE_ANCHOR_SAVE_FAILED'; throw error; },
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT ? { jsonData: { summary: '永久前缀摘要' } } : { jsonData: { noMaterialChange: true } },
  });
  h.context.chatMetadata.integrity = 'complete';
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()));
  const before = h.foundationRuntime.getReachable();
  assert.equal(before.floorMemories.length, 1);
  assert.equal(h.context.chat[0].extra?.qianqianjie_floor, undefined, '夹具必须保持前缀 marker 落盘失败');

  h.context.chat[2].extra = { qianqianjie_floor: { schemaVersion: 1, chatId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', floorId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } };
  h.context.chat.splice(1, 1);
  const state = await h.foundationRuntime.refreshStatus();
  const after = h.foundationRuntime.getReachable();

  assert.equal(state.status, 'needsReview');
  assert.equal(state.reviewReason?.markerStatus, 'foreign');
  assert.deepEqual(after.floors.map(floor => floor.id), before.floors.map(floor => floor.id));
  assert.deepEqual(after.floorMemories.map(memory => memory.id), before.floorMemories.map(memory => memory.id));
  assert.deepEqual(after.stateDeltas.map(delta => delta.id), before.stateDeltas.map(delta => delta.id));
});

test('正文编辑后的明确摘要重提不碰 CSE，显式 CSE 重分析只换本楼', async () => {
  let context;
  const persistAnchors = async ({ chatId, bindings }) => {
    for (const binding of bindings) context.chat[binding.messageIndex].extra = { ...(context.chat[binding.messageIndex].extra ?? {}), qianqianjie_floor: { schemaVersion: 1, chatId, floorId: binding.floorId } };
  };
  const h = harness({
    initialChat: [assistant('旧正文'), user('继续'), assistant('待确认尾楼')], modernAnchors: true, persistAnchors,
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: `摘要-${JSON.parse(options.taskMessages[0].content).payload.canonicalContent}` } }
      : { jsonData: { noMaterialChange: true } },
  });
  context = h.context;
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()));
  const old = h.runtime.getState().floors[0];
  const oldDeltaId = h.runtime.getState().cseFloors[0].deltaId;
  context.chat[0] = { ...context.chat[0], mes: '编辑后正文', swipes: ['编辑后正文'] };
  await h.foundationRuntime.refreshStatus();
  await h.runtime.refreshStatus();
  assert.deepEqual([h.runtime.getState().floors[0].floorId, h.runtime.getState().floors[0].memoryId, h.runtime.getState().cseFloors[0].deltaId], [old.floorId, old.memoryId, oldDeltaId]);
  h.calls.splice(0);
  await h.runtime.extractFloor(old.floorId);
  const requests = h.calls.map(call => ({ systemPrompt: call.systemPrompt, payload: JSON.parse(call.taskMessages[0].content).payload }));
  assert.deepEqual(requests.map(request => request.systemPrompt), [EXTRACTOR_SYSTEM_PROMPT]);
  assert.equal(requests[0].payload.canonicalContent, '编辑后正文');
  const replaced = h.runtime.getState().floors[0];
  let replacedDeltaId = h.runtime.getState().cseFloors[0].deltaId;
  assert.notEqual(replaced.memoryId, old.memoryId);
  assert.equal(replacedDeltaId, oldDeltaId);
  await h.runtime.retryStateAnalysis(old.floorId);
  replacedDeltaId = h.runtime.getState().cseFloors[0].deltaId;
  assert.notEqual(replacedDeltaId, oldDeltaId);
  assert.equal(JSON.parse(h.calls.at(-1).taskMessages[0].content).payload.canonicalContent, '编辑后正文');
  h.calls.splice(0);
  context.chat[0] = { ...context.chat[0], mes: '再次编辑但不重提', swipes: ['再次编辑但不重提'] };
  await h.foundationRuntime.refreshStatus();
  await h.runtime.refreshStatus();
  assert.deepEqual([h.runtime.getState().floors[0].memoryId, h.runtime.getState().cseFloors[0].deltaId], [replaced.memoryId, replacedDeltaId]);
  assert.equal(h.calls.length, 0);

});

test('删除中间 AI 后保留后楼 memory/delta 与历史来源，并支持摘要再改及三种模式冷读', async () => {
  let context;
  const persistAnchors = async ({ chatId, bindings }) => {
    for (const binding of bindings) context.chat[binding.messageIndex].extra = { ...(context.chat[binding.messageIndex].extra ?? {}), qianqianjie_floor: { schemaVersion: 1, chatId, floorId: binding.floorId } };
  };
  const h = harness({
    initialChat: [assistant('第一楼'), user('一'), assistant('第二楼'), user('二'), assistant('第三楼'), user('三'), assistant('待确认尾楼')],
    modernAnchors: true, persistAnchors,
    utility: options => {
      const request = JSON.parse(options.taskMessages[0].content);
      if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { summary: `摘要-${request.payload.canonicalContent}`, people: request.payload.canonicalContent === '第二楼' ? [{ name: '裴晚生' }, { name: '路人乙' }] : [{ name: '裴晚生' }] } };
      if (request.payload.canonicalContent === '第二楼') return { jsonData: { subjects: [{ subject: request.payload.trackedSubjects[0].name, adaptive: [{ text: '仍信任路人乙', toward: '路人乙', visibility: 'observable', reason: '第二楼建立关系' }], situational: [{ text: '第二楼留下的状态', reason: '第二楼事件', visibility: 'observable' }] }] } };
      if (request.payload.canonicalContent === '第三楼') return { jsonData: { subjects: [{ subject: request.payload.trackedSubjects[0].name, adaptive: [], situational: [{ text: '第三楼独立状态', reason: '第三楼事件', visibility: 'observable' }] }] } };
      return { jsonData: { noMaterialChange: true } };
    },
  });
  context = h.context;
  context.chatMetadata.integrity = 'complete';
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()));
  const before = h.runtime.getState();
  const survivorFloor = before.floors[2];
  const removedFloor = before.floors[1];
  const oldDeltaByFloor = new Map(h.foundationRuntime.getReachable().stateDeltas.map(delta => [delta.floorId, structuredClone(delta)]));
  const historicalRelation = oldDeltaByFloor.get(survivorFloor.floorId).fixedChanges
    .flatMap(subject => subject.items).find(item => item.action === 'remove' && item.before?.text === '仍信任路人乙');
  assert.ok(historicalRelation?.before?.towardEntityId, `后楼固定变化必须以关系对象保存已删除来源楼的人物引用：${JSON.stringify(oldDeltaByFloor.get(survivorFloor.floorId).fixedChanges)}`);
  const beforeItems = h.foundationRuntime.getReachable().stateDeltas.flatMap(delta => delta.subjectSnapshots.flatMap(subject => [...subject.core, ...subject.adaptive, ...subject.situational]));
  assert.ok(beforeItems.some(item => item.sourceFloorId === removedFloor.floorId), '删除前必须真实存在来自中间楼的继承状态引用');
  context.chat.splice(2, 1);
  await h.foundationRuntime.refreshStatus();
  await h.runtime.refreshStatus();
  const after = h.runtime.getState();
  assert.deepEqual(after.floors.map(item => item.floorId), [before.floors[0].floorId, survivorFloor.floorId]);
  assert.deepEqual(after.floors.map(item => item.assistantSeq), [1, 2], '删除中间楼后幸存楼按当前顺序顶号');
  assert.deepEqual(after.floors.map(item => item.messageIndex), [0, 3], '顶号只更新当前宿主位置映射');
  assert.equal(after.floors[1].memoryId, survivorFloor.memoryId);
  const survivorSummaryProjection = projectInlineMemoryFloor(after, 3);
  assert.deepEqual([survivorSummaryProjection.floorId, survivorSummaryProjection.assistantSeq, survivorSummaryProjection.summary], [survivorFloor.floorId, 2, '摘要-第三楼'], '摘要显示使用幸存楼的新顺序与当前宿主位置');
  assert.deepEqual(after.cseFloors.map(item => item.deltaId), [oldDeltaByFloor.get(before.floors[0].floorId).id, oldDeltaByFloor.get(survivorFloor.floorId).id]);
  assert.ok(after.cseSubjects.flatMap(subject => [...subject.core, ...subject.adaptive, ...subject.situational])
    .some(item => item.sourceFloorId === survivorFloor.floorId && item.sourceAssistantSeq === 2), 'CSE 显示楼号与同一幸存 floorId 的当前顺序一致');
  const reachable = h.foundationRuntime.getReachable();
  assert.deepEqual(reachable.stateDeltas, [oldDeltaByFloor.get(before.floors[0].floorId), oldDeltaByFloor.get(survivorFloor.floorId)], '幸存 delta 必须逐字保留');
  const preservedRelation = reachable.stateDeltas.flatMap(delta => delta.fixedChanges ?? [])
    .flatMap(subject => subject.items).find(item => item.before?.text === '仍信任路人乙');
  assert.equal(preservedRelation?.before?.sourceFloorId, removedFloor.floorId, '幸存固定变化保留已删除来源楼的历史出处');
  await h.runtime.editSummary(survivorFloor.floorId, '删除来源楼后的幸存摘要修订');
  assert.equal(h.runtime.getState().cseFloors[1].deltaId, oldDeltaByFloor.get(survivorFloor.floorId).id);
  for (const mode of ['projection', 'runtime', 'full']) {
    const cold = await h.store.readReachable({ mode });
    assert.equal(cold.status, 'ready');
    assert.deepEqual(cold.floors.map(floor => [floor.id, floor.assistantSeq, floor.hostLocator.messageIndex]), [[before.floors[0].floorId, 1, 0], [survivorFloor.floorId, 2, 3]], `${mode} 冷读保持顶号后的当前楼序与宿主位置`);
    assert.deepEqual(cold.stateDeltas, [oldDeltaByFloor.get(before.floors[0].floorId), oldDeltaByFloor.get(survivorFloor.floorId)], `${mode} 顶号不得改写幸存 delta`);
    assert.ok(cold.entities.some(entity => entity.id === historicalRelation.before.towardEntityId), `${mode} 冷读必须保留固定关系引用的人物`);
  }
});

test('不完整分页快照不会删除活动图，恢复完整证明后才允许真实删除', async () => {
  let context;
  const persistAnchors = async ({ chatId, bindings }) => {
    for (const binding of bindings) context.chat[binding.messageIndex].extra = { ...(context.chat[binding.messageIndex].extra ?? {}), qianqianjie_floor: { schemaVersion: 1, chatId, floorId: binding.floorId } };
  };
  const fullChat = [assistant('第一楼'), user('一'), assistant('第二楼'), user('二'), assistant('待确认尾楼')];
  const h = harness({ initialChat: fullChat, modernAnchors: true, persistAnchors,
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT ? { jsonData: { summary: '摘要', people: [{ name: '裴晚生' }] } } : { jsonData: { noMaterialChange: true } } });
  context = h.context;
  context.chatMetadata.integrity = 'complete';
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()));
  const rootBefore = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-root`));
  const completeSnapshot = structuredClone(context.chat);
  context.chat = context.chat.slice(0, 2);
  delete context.chatMetadata.integrity;
  const partial = await h.foundationRuntime.refreshStatus();
  assert.equal(partial.status, 'error');
  assert.match(partial.lastError, /没有完整加载证明/);
  assert.deepEqual(h.backend.records.get(`chat-${CHAT}/v3-root`), rootBefore);
  context.chat = completeSnapshot;
  context.chat.splice(2, 1);
  context.chatMetadata.integrity = 'complete';
  const deleted = await h.foundationRuntime.refreshStatus();
  assert.equal(deleted.status, 'ready');
  assert.equal(h.foundationRuntime.getReachable().floors.length, 1);
});

test('删除提交遇到 root CAS 冲突不会改写 winner 的全部活动记录', async () => {
  let context;
  const persistAnchors = async ({ chatId, bindings }) => {
    for (const binding of bindings) context.chat[binding.messageIndex].extra = { ...(context.chat[binding.messageIndex].extra ?? {}), qianqianjie_floor: { schemaVersion: 1, chatId, floorId: binding.floorId } };
  };
  const h = harness({ initialChat: [assistant('第一楼'), user('一'), assistant('第二楼'), user('二'), assistant('待确认尾楼')], modernAnchors: true, persistAnchors,
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT ? { jsonData: { summary: '摘要', people: [{ name: '裴晚生' }] } } : { jsonData: { noMaterialChange: true } } });
  context = h.context;
  context.chatMetadata.integrity = 'complete';
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()));
  const rootKey = `chat-${CHAT}/v3-root`;
  const rootBefore = structuredClone(h.backend.records.get(rootKey));
  const checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${rootBefore.data.headCheckpointId}`).data;
  const prefixed = (field, prefix) => checkpoint.producedRefs[field].map(id => `chat-${CHAT}/${prefix}${id}`);
  const activeKeys = [rootKey, `chat-${CHAT}/v3-checkpoint-${checkpoint.id}`, `chat-${CHAT}/v3-run-${checkpoint.runId}`,
    ...prefixed('floors', 'v3-floor-'), ...prefixed('floorMemories', 'v3-floor-memory-'), ...prefixed('entities', 'v3-entity-'),
    ...prefixed('stateDeltas', 'v3-state-delta-'), ...prefixed('currentStates', 'v3-current-state-'),
    ...(h.foundationRuntime.getReachable().baseline ? [`chat-${CHAT}/v3-baseline-${h.foundationRuntime.getReachable().baseline.id}`] : []),
    ...checkpoint.producedRefs.indexes.map(key => `chat-${CHAT}/${key}`)];
  const winner = new Map([...new Set(activeKeys)].filter(key => h.backend.records.has(key)).map(key => [key, structuredClone(h.backend.records.get(key))]));
  h.backend.setConflictRoot(true);
  context.chat.splice(2, 1);
  await h.foundationRuntime.refreshStatus();
  for (const [key, value] of winner) assert.deepEqual(h.backend.records.get(key), value, key);
});

test('冷读拒绝不属于持久提取快照的 exactAnchor 篡改', async () => {
  const h = harness({
    initialChat: [assistant('他说：“关键原句”。'), user('继续'), assistant('待确认尾楼')],
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: '他说出关键原句。', exactQuotes: [{ exactText: '关键原句', whyPreserve: '关键措辞' }] } }
      : { jsonData: { noMaterialChange: true } },
  });
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()));
  const memoryId = h.runtime.getState().floors[0].memoryId;
  const stored = h.backend.records.get(`chat-${CHAT}/v3-floor-memory-${memoryId}`);
  assert.ok(stored.data.exactAnchors.length > 0);
  stored.data.exactAnchors[0].exactText = '正文中不存在的篡改原句';
  await assert.rejects(h.store.readReachable({ mode: 'full' }), error => error.code === 'V3_MEMORY_GRAPH_ANCHOR_INVALID');
});

test('摘要请求发出后目标楼或依赖前文变化会中止迟到结果且零提交', async () => {
  for (const scenario of ['editTarget', 'editPrefix']) {
    let release, startedResolve;
    const started = new Promise(resolve => { startedResolve = resolve; });
    let signal = null;
    const h = harness({
      initialChat: [assistant('依赖前楼。'), user('前楼锚。'), assistant('提取目标楼。'), user('目标锚。'), assistant('未稳定尾楼。')],
      utility: options => {
        if (options.systemPrompt !== EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { noMaterialChange: true } };
        signal = options.signal;
        startedResolve();
        return new Promise(resolve => { release = () => resolve({ jsonData: { summary: '不得迟到提交。' } }); });
      },
    });
    await h.runtime.start();
    const target = h.runtime.getState().floors.find(item => item.messageIndex === 2);
    const pending = h.runtime.extractFloor(target.floorId, { analyzeState: false });
    await started;
    const messageIndex = scenario === 'editTarget' ? 2 : 0;
    h.context.chat[messageIndex] = assistant(`${scenario} 已变化。`);
    h.emit('MESSAGE_EDITED', messageIndex);
    await waitFor(() => signal?.aborted === true, `${scenario} 未及时中止在途请求`);
    release();
    const state = await pending;
    const graph = await h.store.readReachable({ mode: 'runtime' });
    assert.equal(graph.floorMemories.some(memory => memory.floorId === target.floorId), false, `${scenario} 迟到摘要不得提交`);
    assert.match(state.lastExtractorError?.code ?? '', /V3_MEMORY_(?:STALE|PREFIX_CHANGED|ABORTED)/u);
  }
});

test('第76楼摘要已由第77楼user一次确认后，删除user与第78楼纯后缀不取消请求', async () => {
  let release, startedResolve, signal;
  let extractorCalls = 0;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const prefix = Array.from({ length: 76 }, (_, index) => ({ is_user: false, is_system: true, mes: `系统占位 ${index}`, extra: { type: 'system' } }));
  const h = harness({
    modernAnchors: true,
    initialChat: [...prefix, assistant('第76楼目标正文。'), user('第77楼一次性确认。'), assistant('第78楼尚未提取正文。')],
    utility: options => {
      if (options.systemPrompt !== EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { noMaterialChange: true } };
      extractorCalls += 1;
      signal = options.signal;
      startedResolve();
      return new Promise(resolve => { release = () => resolve({ jsonData: { summary: '第76楼摘要成功。' } }); });
    },
  });
  await h.runtime.start();
  const target = h.runtime.getState().floors.find(floor => floor.messageIndex === 76);
  assert.ok(target, '第76楼必须先由第77楼user确认成可提取目标');
  const pending = h.runtime.extractFloor(target.floorId, { analyzeState: false });
  await started;

  h.context.chat.splice(77);
  h.emit('MESSAGE_DELETED', 77, {
    kind: 'delete', deletedPlayableSeqFrom: 2, deletedPlayableSeqTo: 3, deletedAssistantSeqFrom: 2, deletedAssistantSeqTo: 2,
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(signal?.aborted, false, '删除实际请求输入之后的user/AI不得取消第76楼摘要');

  release();
  await pending;
  await waitFor(() => h.runtime.getState().floors.some(floor => floor.messageIndex === 76 && floor.summary === '第76楼摘要成功。'));
  assert.equal(extractorCalls, 1, '后缀删除不得重复调用摘要模型');
  assert.equal(h.runtime.getState().lastExtractorError, null);
});

test('删除正在摘要的第76楼目标本身会中止请求且迟到结果零提交', async () => {
  let release, startedResolve, signal;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const prefix = Array.from({ length: 76 }, (_, index) => ({ is_user: false, is_system: true, mes: `系统占位 ${index}`, extra: { type: 'system' } }));
  const h = harness({
    modernAnchors: true,
    initialChat: [...prefix, assistant('第76楼将被删除。'), user('第77楼确认。'), assistant('第78楼尾部。')],
    utility: options => {
      if (options.systemPrompt !== EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { noMaterialChange: true } };
      signal = options.signal;
      startedResolve();
      return new Promise(resolve => { release = () => resolve({ jsonData: { summary: '不得保存的迟到摘要。' } }); });
    },
  });
  await h.runtime.start();
  const target = h.runtime.getState().floors.find(floor => floor.messageIndex === 76);
  const pending = h.runtime.extractFloor(target.floorId, { analyzeState: false });
  await started;
  h.context.chat.splice(76);
  h.emit('MESSAGE_DELETED', 76, { kind: 'delete', deletedPlayableSeqFrom: 1, deletedPlayableSeqTo: 3, deletedAssistantSeqFrom: 1, deletedAssistantSeqTo: 2 });
  await waitFor(() => signal?.aborted === true, '删除目标楼必须及时中止在途摘要');
  release();
  await pending;
  const graph = await h.store.readReachable({ mode: 'runtime' });
  assert.equal(graph.floorMemories.some(memory => memory.floorId === target.floorId), false);
});

test('摘要捕获目标 AI 前连续有效 USER，保留当前 swipe，并在 AI 或真实 system 处停止', async () => {
  const selectedUser = { ...user('未选版本'), swipes: ['未选版本', '已选版本'], swipe_id: 1 };
  const continuous = harness({ initialChat: [user('第一段'), selectedUser, assistant('目标 AI'), user('稳定确认')] });
  await continuous.runtime.start();
  const target = continuous.runtime.getState().floors[0];
  await continuous.runtime.extractFloor(target.floorId, { analyzeState: false });
  assert.deepEqual(target && continuous.runtime.getState().floors[0].memory.sourceUserInputSnapshot, { messages: [
    { content: '第一段', messageIndex: 0, swipeId: null, selectedSwipeIndex: null },
    { content: '已选版本', messageIndex: 1, swipeId: 1, selectedSwipeIndex: 1 },
  ] });
  const extractorRequest = JSON.parse(continuous.calls[0].taskMessages[0].content);
  assert.deepEqual(extractorRequest.payload.precedingUserInput.map(item => item.content), ['第一段', '已选版本']);
  assert.equal(continuous.foundationRuntime.getReachable().floors[0].content.canonicalContent, '目标 AI', 'AI canonicalContent 必须保持纯 AI 正文');

  const afterAi = harness({ initialChat: [user('更早 USER'), assistant('前一 AI'), assistant('目标 AI'), user('稳定确认')] });
  await afterAi.runtime.start();
  const second = afterAi.runtime.getState().floors.at(-1);
  await afterAi.runtime.extractFloor(second.floorId, { analyzeState: false });
  assert.equal(afterAi.runtime.getState().floors.at(-1).memory.sourceUserInputSnapshot, null, '连续 AI 不得复用更早 USER');

  const systemBarrier = harness({ initialChat: [user('更早 USER'), { is_user: false, is_system: true, mes: '宿主事件', extra: { type: 'system' } }, assistant('目标 AI'), user('稳定确认')] });
  await systemBarrier.runtime.start();
  await systemBarrier.runtime.extractFloor(systemBarrier.runtime.getState().floors[0].floorId, { analyzeState: false });
  assert.equal(systemBarrier.runtime.getState().floors[0].memory.sourceUserInputSnapshot, null);

  const hidden = harness({ initialChat: [{ ...user('自动隐藏 USER'), is_system: true, extra: { qianqianjieAutoHide: { schemaVersion: 1, chatId: CHAT } } }, assistant('目标 AI'), user('稳定确认')] });
  await hidden.runtime.start();
  await hidden.runtime.extractFloor(hidden.runtime.getState().floors[0].floorId, { analyzeState: false });
  assert.equal(hidden.runtime.getState().floors[0].memory.sourceUserInputSnapshot.messages[0].content, '自动隐藏 USER');

  const conflictingSystem = harness({ initialChat: [
    { ...user('带冲突标记的真实 system'), is_system: true, extra: { type: 'system', qianqianjieAutoHide: { schemaVersion: 1, chatId: CHAT } } },
    assistant('目标 AI'), user('稳定确认'),
  ] });
  await conflictingSystem.runtime.start();
  await conflictingSystem.runtime.extractFloor(conflictingSystem.runtime.getState().floors[0].floorId, { analyzeState: false });
  assert.equal(conflictingSystem.runtime.getState().floors[0].memory.sourceUserInputSnapshot, null, '真实 system 即使残留 auto-hide 标记也必须形成边界');

  const manual = harness({ initialChat: [user('首次快照'), assistant('目标 AI'), user('稳定确认')] });
  await manual.runtime.start();
  const manualFloorId = manual.runtime.getState().floors[0].floorId;
  await manual.runtime.extractFloor(manualFloorId, { analyzeState: false });
  assert.equal(manual.runtime.getState().floors[0].memory.sourceUserInputSnapshot.messages[0].content, '首次快照');
  manual.context.chat[0].mes = '手动重提的新快照';
  await manual.runtime.refreshStatus();
  assert.equal(manual.runtime.getState().floors[0].memory.sourceUserInputSnapshot.messages[0].content, '首次快照', '普通刷新不得因 USER 改写而自动重摘');
  await manual.runtime.extractFloor(manualFloorId, { analyzeState: false });
  assert.equal(manual.runtime.getState().floors[0].memory.sourceUserInputSnapshot.messages[0].content, '手动重提的新快照');
});

test('摘要在途 USER 编辑、删除和后置确认删除都提交捕获快照，目标 AI marker 重绑后守卫仍有效', async () => {
  async function runScenario(mutate) {
    let release;
    let startedResolve;
    const started = new Promise(resolve => { startedResolve = resolve; });
    const h = harness({
      modernAnchors: true,
      initialChat: [user('前置一'), user('前置二'), assistant('目标 AI 正文'), user('后置稳定确认')],
      utility: () => new Promise(resolve => { release = () => resolve({ jsonData: { summary: '冻结快照摘要。' } }); startedResolve(); }),
    });
    await h.runtime.start();
    const target = h.runtime.getState().floors[0];
    h.context.chat[target.messageIndex].extra = { qianqianjie_floor: { schemaVersion: 1, chatId: CHAT, floorId: target.floorId } };
    const pending = h.runtime.extractFloor(target.floorId, { analyzeState: false });
    await started;
    const request = JSON.parse(h.calls[0].taskMessages[0].content);
    assert.deepEqual(request.payload.precedingUserInput.map(item => item.content), ['前置一', '前置二']);
    mutate(h, target);
    await new Promise(resolve => setTimeout(resolve, 20));
    release();
    const state = await pending;
    const memory = state.floors.find(item => item.floorId === target.floorId)?.memory;
    assert.ok(memory, JSON.stringify(state.lastExtractorError));
    assert.deepEqual(memory.sourceUserInputSnapshot.messages.map(item => item.content), ['前置一', '前置二']);
    assert.equal(memory.summary.aiText, '冻结快照摘要。');
  }

  await runScenario(h => {
    h.context.chat[0].mes = '编辑后的前置一';
    h.emit('MESSAGE_EDITED', 0);
  });
  await runScenario(h => {
    h.context.chat.splice(1, 1);
    h.emit('MESSAGE_DELETED', 1);
    h.context.chat.splice(0, 1);
    h.emit('MESSAGE_DELETED', 0);
  });
  await runScenario((h, target) => {
    h.context.chat.splice(target.messageIndex + 1, 1);
    h.emit('MESSAGE_DELETED', target.messageIndex + 1);
  });
});


test('时间接线：历史多楼摘要与CSE完成后只通知一批，不逐楼请求', async () => {
  const batches = [];
  const h = harness({ initialChat: [
    { is_user: false, mes: '裴晚生第一天手腕受伤。' }, { is_user: true, mes: '继续' },
    { is_user: false, mes: '裴晚生第二天手腕仍痛。' }, { is_user: true, mes: '继续' },
    { is_user: false, mes: '裴晚生第三天创口已干。' }, { is_user: true, mes: '继续' },
  ], utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
    ? { jsonData: { summary: '裴晚生的手腕伤势随时间变化。', people: [{ name: '裴晚生' }, { name: '林岚', role: 'user' }] } }
    : { jsonData: { noMaterialChange: true } }, onMemoryBatchCommitted: receipt => { batches.push(receipt); } });
  await h.runtime.start();
  assert.equal(batches.length, 0);
  await h.runtime.startHistoricalRebuild();
  assert.equal(h.runtime.getState().rememberedCount, 3);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].historical, true);
});

test('历史流水真实请求重叠，摘要先/CSE先提交都保全图且各链最多一请求', async t => {
  for (const winner of ['summary', 'cse']) await t.test(winner, async () => {
    let releaseSummary, releaseCse, summaryStarted, cseStarted;
    const summaryGate = new Promise(resolve => { releaseSummary = resolve; });
    const cseGate = new Promise(resolve => { releaseCse = resolve; });
    const summaryStart = new Promise(resolve => { summaryStarted = resolve; });
    const cseStart = new Promise(resolve => { cseStarted = resolve; });
    const active = { summary: 0, cse: 0 }, max = { summary: 0, cse: 0 }, order = [], summaries = [], batches = [];
    const h = harness({ initialChat: [user('开始'), ...['流水一', '流水二', '流水三', '流水四', '流水五'].map(assistant), user('确认')],
      onAutomaticSummaryCommitted: receipt => summaries.push(receipt),
      onMemoryBatchCommitted: receipt => { assert.deepEqual(active, { summary: 0, cse: 0 }); batches.push(receipt); },
      utility: async options => {
        const request = JSON.parse(options.taskMessages[0].content);
        const kind = request.task === 'extractFloorSemantics' ? 'summary' : 'cse';
        const payload = request.payload;
        const content = payload.canonicalContent;
        active[kind] += 1; max[kind] = Math.max(max[kind], active[kind]); order.push(`${kind}:${content}`);
        try {
          if (kind === 'summary' && content === '流水三') { summaryStarted(); await summaryGate; }
          if (kind === 'cse' && content === '流水二') { cseStarted(); await cseGate; }
          return kind === 'summary' ? { jsonData: { summary: `摘要-${content}`,
            ...(content === '流水三' ? { people: [{ name: '后楼客人' }] } : {}) } }
            : { jsonData: { subjects: payload.trackedSubjects.map(subject => ({ subject: subject.name, situational: [{ text: `${content}的有效状态`, reason: content, visibility: 'observable' }] })) } };
        } finally { active[kind] -= 1; }
      } });
    await h.runtime.start();
    const running = h.runtime.startHistoricalRebuild();
    await Promise.all([summaryStart, cseStart]);
    assert.deepEqual(active, { summary: 1, cse: 1 }, 'S(n+1)与CSE(n)真实同时在途');
    assert.equal(batches.length, 0);
    assert.ok(order.indexOf('cse:流水二') < order.indexOf('summary:流水三'), '首楼基线初始化后，下一楼摘要与前一楼 CSE 流水并行');
    if (winner === 'summary') {
      releaseSummary();
      await waitFor(() => h.runtime.getState().rememberedCount === 5);
      assert.equal(batches.length, 0, '摘要结束时CSE仍在途，不提前通知时间任务');
      releaseCse();
    } else {
      releaseCse();
      await waitFor(() => ['ready', 'noChange'].includes(h.runtime.getState().floors[1]?.cse?.status));
      assert.equal(h.runtime.getState().rememberedCount, 2);
      releaseSummary();
    }
    await running;
    assert.deepEqual(max, { summary: 1, cse: 1 });
    assert.equal(summaries.length, 5);
    assert.equal(batches.length, 1);
    assert.deepEqual(order.filter(value => value.startsWith('cse:')), ['cse:流水一', 'cse:流水二', 'cse:流水三', 'cse:流水四', 'cse:流水五']);
    const graph = await h.store.readReachable({ mode: 'runtime' });
    assert.equal(graph.status, 'ready'); assert.equal(graph.floorMemories.length, 5); assert.equal(graph.stateDeltas.length, 5);
    assert.ok(graph.entities.some(entity => entity.displayName === '后楼客人'), '后摘要实体不丢，早CSE不被未来实体影响');
  });
});

test('历史流水双在途暂停或切聊，两路迟到结果均不提交', async t => {
  for (const cancellation of ['pause', 'chat', 'commitWait']) await t.test(cancellation, async () => {
    let releaseSummary, releaseCse, summaryStarted, cseStarted;
    const summaryGate = new Promise(resolve => { releaseSummary = resolve; });
    const cseGate = new Promise(resolve => { releaseCse = resolve; });
    const summaryStart = new Promise(resolve => { summaryStarted = resolve; });
    const cseStart = new Promise(resolve => { cseStarted = resolve; });
    const batches = [];
    const h = harness({ initialChat: [user('开始'), ...['取消一', '取消二', '取消三', '取消四', '取消五'].map(assistant), user('确认')],
      onMemoryBatchCommitted: receipt => batches.push(receipt),
      utility: async options => {
        const request = JSON.parse(options.taskMessages[0].content);
        const summary = request.task === 'extractFloorSemantics';
        const content = request.payload.canonicalContent;
        if (summary && content === '取消三') { summaryStarted(); await summaryGate; }
        if (!summary && content === '取消二') { cseStarted(); await cseGate; }
        return summary ? { jsonData: { summary: `摘要-${content}` } } : { jsonData: { noMaterialChange: true } };
      } });
    await h.runtime.start();
    const running = h.runtime.startHistoricalRebuild();
    await Promise.all([summaryStart, cseStart]);
    const rootEntry = [...h.backend.records.entries()].find(([key]) => key.endsWith('/v3-root'));
    const durableRoot = structuredClone(rootEntry[1]);
    let rootGate;
    if (cancellation === 'commitWait') {
      rootGate = h.backend.holdNextRootPut();
      releaseSummary();
      await rootGate.started;
      releaseCse();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(h.backend.records.get(rootEntry[0]), durableRoot, '摘要持有提交门，CSE不得先提交覆盖');
    }
    if (cancellation === 'chat') {
      h.context.chatId = 'host-other';
      h.context.chatMetadata = { qianqianjie: { schemaVersion: 1, chatId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } };
      h.context.chat = [user('另一聊天'), assistant('另一正文')];
      h.emit('CHAT_CHANGED');
    } else h.runtime.pauseHistoricalRebuild();
    await waitFor(() => !h.runtime.shouldBlockMainGeneration());
    releaseSummary(); releaseCse(); rootGate?.release();
    await running;
    assert.deepEqual(h.backend.records.get(rootEntry[0]), durableRoot, '暂停或切聊后，持锁及等待提交的两路结果均不改旧root');
    assert.equal(batches.length, 0, '取消批次不触发时间任务');
    assert.equal(h.calls.length, 5, '停止后不启动额外请求');
  });
});

test('刷新中断后手动补最后CSE才通知时间并落盘，非最后、失败和已ready重析不通知', async () => {
  const seed = harness({ initialChat: [user('开始'), ...['林岚伤后观察', '林岚时间推进', '林岚当前观察'].map((text, index) => assistant(`<!-- QQJ-start | date=2026-09-15 | weekday=周二 | time=${8 + index}:00 -->${text}<!-- QQJ-end | date=2026-09-15 | weekday=周二 | time=${9 + index}:00 -->`)), user('确认')],
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT ? { jsonData: { summary: '林岚手腕擦伤仍可见', people: [{ name: '林岚', role: 'user' }], observations: [{ subject: '林岚', kind: 'injury', description: '手腕擦伤' }] } } : { jsonData: { noMaterialChange: true } } });
  await seed.runtime.start();
  for (const floor of seed.runtime.getState().floors) await seed.runtime.extractFloor(floor.floorId, { analyzeState: false });
  await seed.runtime.analyzeNextState();
  let fail = true, timeCalls = 0, timePromise;
  const receipts = [];
  const timeStore = createTimeStore({ client: seed.backend.client });
  let resumed;
  const time = createTimeRuntime({ store: timeStore, foundationStore: seed.store, hostAdapter: seed.hostAdapter, session: { identity: () => ({ chatId: CHAT }) }, isEnabled: () => true, logger: { warn() {} },
    getReachable: () => resumed.foundationRuntime.getReachable(), getMemoryState: () => resumed.runtime.getState(),
    generateTimeTask: async options => { timeCalls += 1; const request = JSON.parse(options.taskMessages[0].content), source = request.observations[0]; assert.ok(source, '真实摘要身体观察进入时间任务'); return { changes: [{ itemId: null, sourceKeys: [source.sourceKey], subjectEntityId: request.people[0].entityId, type: 'body', label: '手腕擦伤', observation: '擦伤仍可见', occurrenceTime: '', dueTime: '', status: 'active', stateRefs: [] }] }; } });
  resumed = harness({ sharedBackend: seed.backend, sharedContext: seed.context,
    utility: () => { if (fail) throw new Error('受控CSE失败'); return { jsonData: { noMaterialChange: true } }; },
    onMemoryBatchCommitted: receipt => { assert.equal(resumed.runtime.getState().memoryWorkBusy, false); receipts.push(receipt); timePromise = time.runBatch(receipt); } });
  await resumed.runtime.start();
  await resumed.runtime.analyzeNextState();
  assert.equal(receipts.length, 0, '失败不通知');
  fail = false;
  await resumed.runtime.analyzeNextState();
  assert.equal(receipts.length, 0, '仍有最后缺口不通知');
  const last = resumed.runtime.getState().floors.at(-1);
  await resumed.runtime.retryStateAnalysis(last.floorId);
  await timePromise;
  assert.equal(receipts.length, 1); assert.equal(timeCalls, 1);
  const stored = await timeStore.read(CHAT);
  assert.ok(stored.head); assert.equal(stored.batches.length, 1);
  await resumed.runtime.retryStateAnalysis(last.floorId);
  await resumed.runtime.refreshStatus();
  assert.equal(receipts.length, 1, '已ready重析或刷新不自动时间任务');
});

test('手动最后CSE取消不通知，时间开关关闭仍不调用时间模型', async () => {
  let release;
  const h = harness({ utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT ? { jsonData: { summary: '摘要' } } : new Promise(resolve => { release = () => resolve({ jsonData: { noMaterialChange: true } }); }), onMemoryBatchCommitted: () => assert.fail('取消不得通知时间') });
  await h.runtime.start(); await h.runtime.extractFloor(h.runtime.getState().floors[0].floorId, { analyzeState: false });
  const running = h.runtime.analyzeNextState();
  await waitFor(() => release); h.runtime.invalidate(); release(); await running;
  let calls = 0;
  const off = createTimeRuntime({ store: {}, foundationStore: {}, hostAdapter: {}, session: { identity: () => ({ chatId: CHAT }) }, isEnabled: () => false, generateAnalysisTask: () => { calls += 1; } });
  await off.runBatch({ chatId: CHAT, historical: true });
  assert.equal(calls, 0);
});

test('千事历史计划只读，显式开始后每批一次请求并逐楼替换同一 FloorMemory 字段', async () => {
  let mode = 'summary';
  const h = harness({ initialChat: [user('开始'), assistant('顾舟答应明天归还旧书。'), assistant('沈砚约好后天去钟楼。'), user('稳定')],
    utility: options => {
      if (mode === 'summary') return options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
        ? { jsonData: { summary: '本楼已有摘要。' } }
        : { jsonData: { noMaterialChange: true } };
      const request = JSON.parse(options.taskMessages[0].content);
      return { jsonData: { floors: request.floors.map((value, index) => ({ floorKey: value.floorKey, qianshi: { events: [{
        key: `event-${index + 1}`, title: index ? '钟楼会面' : '归还旧书', description: index ? '约好后天去钟楼' : '答应明天归还旧书',
        status: 'planned', matter: true, scheduledTime: index ? '后天' : '明天', links: [],
      }], order: [] } })) } };
    } });
  await h.runtime.start();
  for (const value of h.runtime.getState().floors) await h.runtime.extractFloor(value.floorId);
  await h.runtime.editSummary(h.runtime.getState().floors[0].floorId, '人工修订摘要。');
  assert.ok(h.runtime.getQianshiSnapshot().coverage.pendingFloors >= 2);
  const beforeHistory = await h.store.readReachable({ mode: 'runtime' });
  const preservedSummaries = beforeHistory.floorMemories.map(value => [value.floorId, structuredClone(value.summary)]);
  const preservedCse = structuredClone(beforeHistory.stateDeltas);
  const beforePlanCalls = h.calls.length;
  const plan = await h.runtime.prepareQianshiHistory();
  assert.equal(h.calls.length, beforePlanCalls, 'prepareHistory 不调用模型');
  assert.equal(plan.totalFloors, 2); assert.equal(plan.batchCount, 1);
  mode = 'history';
  const result = await h.runtime.startQianshiHistory(plan.planId);
  assert.equal(h.calls.length, beforePlanCalls + 1, '同一批只调用一次模型');
  assert.match(h.calls.at(-1).systemPrompt, /同一场景同一事项的连续动作合成一件完整事件/u);
  assert.match(h.calls.at(-1).systemPrompt, /事件正文必须放在 description 字段.*不得用 chatSummary 等自造字段替代 description/u);
  assert.match(h.calls.at(-1).systemPrompt, /links 中最多一个 candidateKey.*同一叙事影响多个旧事项时，按事项分别写成独立事件/u);
  assert.match(h.calls.at(-1).systemPrompt, /不得跨 floorKey 合并事件来源/u);
  assert.doesNotMatch(h.calls.at(-1).systemPrompt, /important|关系转折（确认关系、决裂、重要承诺）/u);
  assert.match(h.calls.at(-1).systemPrompt, /已有故事年份或纪年时必须保留.*不得猜当前故事年或现实年份/u);
  assert.match(h.calls.at(-1).systemPrompt, /qianshi\.order 必须是对象数组.*before.*after.*certainty/u);
  assert.equal(result.status, 'completed'); assert.equal(result.processedFloors, 2);
  const snapshot = h.runtime.getQianshiSnapshot();
  assert.equal(snapshot.coverage.completeFloors, 2);
  assert.equal(snapshot.matters.length, 2);
  assert.deepEqual(snapshot.events.map(value => value.description), ['答应明天归还旧书', '约好后天去钟楼'], '合成历史回执中的 description 正常编译并落盘');
  const afterHistory = await h.store.readReachable({ mode: 'runtime' });
  assert.deepEqual(afterHistory.floorMemories.map(value => [value.floorId, value.summary]), preservedSummaries, '历史补齐逐字保留 AI/人工摘要');
  assert.deepEqual(afterHistory.stateDeltas, preservedCse, '历史补齐不改写已落盘 CSE');
});

test('千事历史补齐用项目 JSON 解析器处理单围栏七楼结果并保留旧响应字段', async () => {
  let mode = 'summary';
  const initialChat = [user('开始')];
  for (let index = 1; index <= 7; index += 1) initialChat.push(assistant(`第${index}楼约定归还旧书。`), user(`稳定${index}`));
  const h = harness({ initialChat, utility: options => {
    if (mode === 'summary') return { jsonData: { summary: '旧摘要。', qianshi: { events: [
      { key: 'old-valid', title: '旧书约定', description: '约定归还旧书', status: 'planned', matter: true },
      { key: 'old-invalid', title: '缺少描述' },
    ], order: [] } } };
    const request = JSON.parse(options.taskMessages[0].content);
    const packet = { floors: request.floors.map(value => ({ floorKey: value.floorKey, qianshi: { events: [
      { key: 'event-1', title: `第${value.assistantSeq}楼事项`, description: `第${value.assistantSeq}楼约定归还旧书`, status: 'planned', matter: true },
    ], order: [] } })) };
    return { textData: `本批结果：\n\`\`\`json\n${JSON.stringify(packet)}\n\`\`\`\n请查收。`, taskMetadata: { finishReason: 'stop' } };
  } });
  await h.runtime.start();
  for (const floor of h.runtime.getState().floors) await h.runtime.extractFloor(floor.floorId, { analyzeState: false });
  assert.equal(h.runtime.getQianshiSnapshot().coverage.partialFloors, 7);
  const before = await h.store.readReachable({ mode: 'runtime' });
  const summaries = before.floorMemories.map(memory => [memory.floorId, structuredClone(memory.summary)]);
  const plan = await h.runtime.prepareQianshiHistory();
  assert.equal(plan.totalFloors, 7); assert.equal(plan.batchCount, 1);
  mode = 'history';
  const result = await h.runtime.startQianshiHistory(plan.planId);
  assert.equal(result.status, 'completed'); assert.equal(result.processedFloors, 7); assert.equal(result.calls, 1);
  const after = await h.store.readReachable({ mode: 'runtime' });
  assert.equal(h.runtime.getQianshiSnapshot().coverage.completeFloors, 7);
  assert.equal(after.floorMemories.filter(memory => memory.qianshiDelta?.status === 'ready').length, 7);
  assert.deepEqual(after.floorMemories.map(memory => [memory.floorId, memory.summary]), summaries, '只替换千事字段，旧摘要不变');
});

test('千事历史兼容裸 JSON、前后说明及旧 data/responseText 字段', async () => {
  const responseShapes = [
    ['裸 textData JSON', packet => ({ textData: JSON.stringify(packet) })],
    ['前后说明', packet => ({ textData: `以下是结果：${JSON.stringify(packet)}处理完成。`, taskMetadata: { finishReason: 'stop' } })],
    ['旧 data 对象', packet => ({ data: packet })],
    ['旧 responseText 围栏', packet => ({ responseText: `\`\`\`json\n${JSON.stringify(packet)}\n\`\`\``, taskMetadata: { finishReason: 'stop' } })],
  ];
  for (const [shape, wrap] of responseShapes) {
    let mode = 'summary';
    const h = harness({ initialChat: [user('开始'), assistant('顾舟答应归还旧书。'), user('稳定')], utility: options => {
      if (mode === 'summary') return { jsonData: { summary: '原摘要。', qianshi: { events: [
        { key: 'old-valid', title: '旧书约定', description: '顾舟答应归还旧书', status: 'planned', matter: true },
        { key: 'old-invalid', title: '缺少描述' },
      ], order: [] } } };
      return wrap({ floors: [{ floorKey: 'floor-1', qianshi: { events: [
        { key: 'event-1', title: '归还旧书', description: '顾舟答应归还旧书', status: 'planned', matter: true },
      ], order: [] } }] });
    } });
    await h.runtime.start();
    const floor = h.runtime.getState().floors[0];
    await h.runtime.extractFloor(floor.floorId, { analyzeState: false });
    const plan = await h.runtime.prepareQianshiHistory(); mode = 'history';
    const result = await h.runtime.startQianshiHistory(plan.planId);
    assert.equal(result.status, 'completed', `${shape} 应沿既有编译链落盘`);
    assert.equal(result.processedFloors, 1);
    assert.equal(h.runtime.getQianshiSnapshot().coverage.completeFloors, 1);
  }
});

test('千事历史多围栏、截断、坏文本与 AbortError 不覆盖旧 partial 记录', async () => {
  for (const [label, historyResult, expectedStatus] of [
    ['空文本', { textData: '' }, 'partial'],
    ['非法纯文本', { textData: '这不是 JSON' }, 'partial'],
    ['多份 JSON 围栏', { textData: '\`\`\`json\n{"floors":[]}\n\`\`\`\n\`\`\`json\n{"floors":[]}\n\`\`\`' }, 'partial'],
    ['未闭合围栏', { textData: '\`\`\`json\n{"floors":[]}' }, 'partial'],
    ['finishReason 标记截断', { textData: '{"floors":[]}', taskMetadata: { finishReason: 'length' } }, 'partial'],
    ['AbortError', () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, null],
  ]) {
    let mode = 'summary';
    const h = harness({ initialChat: [user('开始'), assistant('顾舟答应归还旧书。'), user('稳定')], utility: options => {
      if (mode === 'summary') return { jsonData: { summary: '顾舟答应归还旧书。', qianshi: { events: [
        { key: 'old-valid', title: '旧书约定', description: '顾舟答应归还旧书', status: 'planned', matter: true },
        { key: 'old-invalid', title: '缺少描述' },
      ], order: [] } } };
      return typeof historyResult === 'function' ? historyResult() : historyResult;
    } });
    await h.runtime.start();
    const floor = h.runtime.getState().floors[0];
    await h.runtime.extractFloor(floor.floorId, { analyzeState: false });
    const before = await h.store.readReachable({ mode: 'runtime' });
    const oldDelta = structuredClone(before.floorMemories.find(memory => memory.floorId === floor.floorId).qianshiDelta);
    const putCount = h.backend.calls.filter(call => call[0] === 'put').length;
    const plan = await h.runtime.prepareQianshiHistory(); mode = 'history';
    const result = await h.runtime.startQianshiHistory(plan.planId);
    if (expectedStatus) assert.equal(result.status, expectedStatus, `${label} 应保留原失败合同`);
    assert.equal(result.processedFloors, 0);
    const after = await h.store.readReachable({ mode: 'runtime' });
    assert.deepEqual(after.floorMemories.find(memory => memory.floorId === floor.floorId).qianshiDelta, oldDelta, `${label} 不得覆盖原 partial`);
    assert.equal(h.backend.calls.filter(call => call[0] === 'put').length, putCount, `${label} 不得落盘`);
  }
});

test('千事历史计划跳过已经 ready 的楼', async () => {
  let mode = 'summary';
  const h = harness({ initialChat: [user('开始'), assistant('顾舟答应归还旧书。'), user('稳定')], utility: options => {
    if (mode === 'summary') return { jsonData: { summary: '顾舟答应归还旧书。', qianshi: { events: [
      { key: 'event-1', title: '归还旧书', description: '顾舟答应归还旧书', status: 'planned', matter: true },
    ], order: [] } } };
    assert.fail('ready 楼不应再次调用千事历史模型');
  } });
  await h.runtime.start();
  const floor = h.runtime.getState().floors[0];
  await h.runtime.extractFloor(floor.floorId, { analyzeState: false });
  assert.equal(h.runtime.getQianshiSnapshot().coverage.completeFloors, 1);
  const callsBefore = h.calls.length;
  const plan = await h.runtime.prepareQianshiHistory();
  assert.equal(plan.totalFloors, 0);
  assert.equal(plan.apiCalls, 0);
  mode = 'history';
  const result = await h.runtime.startQianshiHistory(plan.planId);
  assert.equal(result.status, 'completed');
  assert.equal(h.calls.length, callsBefore);
});

test('千事预览遇到待同步正文或孤儿锚只读拒绝，修复仍走记忆管理刷新入口', async t => {
  for (const fault of ['pendingSync', 'orphanAnchor']) await t.test(fault, async () => {
    const seed = harness({ modernAnchors: true,
      initialChat: [user('开始'), assistant('顾舟答应归还旧书。'), user('稳定')],
      persistAnchors: async ({ chatId, bindings }) => { for (const binding of bindings) {
        const message = seed.context.chat[binding.messageIndex]; message.extra ??= {};
        message.extra.qianqianjie_floor = { schemaVersion: 1, chatId, floorId: binding.floorId };
      } },
      utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
        ? { jsonData: { summary: '已有摘要。', qianshi: { events: [{ key: 'event-1', title: '归还旧书',
          description: '顾舟答应归还旧书', status: 'planned', matter: true }], order: [] } } }
        : { jsonData: { noMaterialChange: true } } });
    await seed.runtime.start();
    await seed.runtime.extractFloor(seed.runtime.getState().floors[0].floorId, { analyzeState: false });
    if (fault === 'pendingSync') {
      seed.context.chat.push(assistant('需要先同步的新稳定楼。'), user('确认新楼'));
    } else {
      seed.context.chat[1].extra ??= {};
      seed.context.chat[1].extra.qianqianjie_floor = { schemaVersion: 1, chatId: CHAT, floorId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' };
    }
    const h = harness({ modernAnchors: true, readOnlyLifecycle: true, sharedBackend: seed.backend, sharedContext: seed.context });
    await h.runtime.start();
    const putsBefore = h.backend.calls.filter(call => call[0] === 'put').length;
    const callsBefore = h.calls.length;
    await assert.rejects(h.runtime.prepareQianshiHistory(), error => error?.code === 'V3_MEMORY_FOUNDATION_NOT_READY');
    assert.equal(h.backend.calls.filter(call => call[0] === 'put').length, putsBefore, `${fault} 只读预览不得提交 foundation 或 anchor`);
    assert.equal(h.calls.length, callsBefore, `${fault} 只读预览不得调用 API`);
  });
});

test('ready 断链楼只在确认后本地隔离坏边，保留事件与摘要并继续补齐', async () => {
  const initialChat = [user('开始'), assistant('顾舟答应归还旧书。'), user('稳定')];
  const seed = harness({ initialChat, utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
    ? { jsonData: { summary: '旧摘要必须保留。', qianshi: { events: [{ key: 'event-1', title: '归还旧书', description: '顾舟答应归还旧书', status: 'planned', matter: true }], order: [] } } }
    : { jsonData: { noMaterialChange: true } } });
  await seed.runtime.start();
  const floor = seed.runtime.getState().floors[0];
  await seed.runtime.extractFloor(floor.floorId, { analyzeState: false });
  const before = await seed.store.readReachable({ mode: 'runtime' });
  const oldMemory = before.floorMemories.find(value => value.floorId === floor.floorId);
  const storedKey = `chat-${CHAT}/v3-floor-memory-${oldMemory.id}`;
  const stored = seed.backend.records.get(storedKey);
  const damaged = structuredClone(stored.data);
  const missingId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  damaged.qianshiDelta.relations = [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', type: 'before',
    fromEventId: damaged.qianshiDelta.events[0].id, toEventId: missingId, certainty: 'explicit' }];
  seed.backend.records.set(storedKey, { ...stored, data: damaged });
  const repaired = harness({ sharedBackend: seed.backend, sharedContext: seed.context, utility: options => {
    if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { summary: '不应重提摘要。' } };
    assert.equal(repaired.runtime.getQianshiSnapshot().coverage.partialFloors, 1, 'API调用前，本地修整应先落盘为 partial');
    assert.equal(repaired.runtime.getQianshiSnapshot().events[0].id, oldMemory.qianshiDelta.events[0].id, '本地修整保留原事件 ID');
    assert.equal(repaired.runtime.getQianshiSnapshot().relations.length, 0, 'API调用前只隔离坏边');
    throw new Error('受控历史提取失败');
  } });
  await repaired.runtime.start();
  assert.equal(repaired.runtime.getQianshiSnapshot().coverage.degradedFloors, 1);
  const putsBeforePlan = seed.backend.calls.filter(call => call[0] === 'put').length;
  const callsBeforePlan = repaired.calls.length;
  const plan = await repaired.runtime.prepareQianshiHistory();
  assert.equal(plan.totalFloors, 1); assert.equal(plan.localRepairFloors, 1); assert.equal(plan.apiCalls, 1);
  assert.equal(seed.backend.calls.filter(call => call[0] === 'put').length, putsBeforePlan, '计划预览不得写入');
  assert.equal(repaired.calls.length, callsBeforePlan, '计划预览不得调用 API');
  const result = await repaired.runtime.startQianshiHistory(plan.planId);
  assert.equal(result.status, 'partial');
  const after = await repaired.store.readReachable({ mode: 'runtime' });
  const current = after.floorMemories.find(value => value.floorId === floor.floorId);
  assert.equal(current.qianshiDelta.status, 'partial');
  assert.deepEqual(current.qianshiDelta.events.map(value => value.id), oldMemory.qianshiDelta.events.map(value => value.id));
  assert.equal(current.qianshiDelta.relations.length, 0);
  assert.equal(current.summary.aiText, '旧摘要必须保留。');
  assert.equal(seed.backend.records.has(storedKey), true, '旧 FloorMemory 仍作为 supersedes 历史记录保留');
});

test('重提旧楼若更换仍被后楼引用的事件 ID，只保存摘要并保留旧千事', async () => {
  let initialEvent = 0;
  const initialChat = [user('开始'), assistant('第一楼事实。'), assistant('第二楼事实。'), user('稳定')];
  const seed = harness({ initialChat, utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
    ? { jsonData: { summary: '旧摘要。', qianshi: { events: [{ key: 'event-1', title: `旧事件 ${++initialEvent}`,
      description: '第一楼已记录的事件', status: 'occurred', matter: false }], order: [] } } }
    : { jsonData: { noMaterialChange: true } } });
  await seed.runtime.start();
  const floors = seed.runtime.getState().floors;
  await seed.runtime.extractFloor(floors[0].floorId, { analyzeState: false });
  await seed.runtime.extractFloor(floors[1].floorId, { analyzeState: false });
  const before = await seed.store.readReachable({ mode: 'runtime' });
  const first = before.floorMemories.find(value => value.floorId === floors[0].floorId);
  const firstEventId = first.qianshiDelta.events[0].id;
  const second = before.floorMemories.find(value => value.floorId === floors[1].floorId);
  const relation = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', type: 'before', fromEventId: firstEventId,
    toEventId: second.qianshiDelta.events[0].id, certainty: 'explicit' };
  const secondKey = `chat-${CHAT}/v3-floor-memory-${second.id}`, storedSecond = seed.backend.records.get(secondKey);
  seed.backend.records.set(secondKey, { ...storedSecond, data: { ...storedSecond.data,
    qianshiDelta: { ...storedSecond.data.qianshiDelta, relations: [relation] } } });
  const notices = [];
  const retry = harness({ sharedBackend: seed.backend, sharedContext: seed.context, notifyUser: notice => notices.push(notice),
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: '重提后的新摘要。', qianshi: { events: [{ key: 'event-new', title: '改写后的新事件',
        description: '第一楼的新版本事件', status: 'occurred', matter: false }], order: [] } } }
      : { jsonData: { noMaterialChange: true } } });
  await retry.runtime.start();
  await retry.runtime.extractFloor(floors[0].floorId, { analyzeState: false });
  const after = await retry.store.readReachable({ mode: 'runtime' });
  const savedFirst = after.floorMemories.find(value => value.floorId === floors[0].floorId);
  assert.equal(savedFirst.summary.aiText, '重提后的新摘要。', '跨楼关系失败不能吞掉摘要');
  assert.equal(savedFirst.qianshiDelta.events[0].id, firstEventId, '被后楼引用的旧千事保留');
  assert.equal(retry.runtime.getQianshiSnapshot().coverage.degradedFloors, 0, '后楼关系仍指向有效事件');
  assert.ok(notices.some(notice => /摘要已保存，但新千事结果漏掉了仍被后楼引用的事件/u.test(notice.text)), '用户可见千事替换被拒原因');
  const latestSecond = after.floorMemories.find(value => value.floorId === floors[1].floorId), latestSecondKey = `chat-${CHAT}/v3-floor-memory-${latestSecond.id}`;
  const storedLatestSecond = seed.backend.records.get(latestSecondKey);
  seed.backend.records.set(latestSecondKey, { ...storedLatestSecond, data: { ...storedLatestSecond.data,
    qianshiDelta: { ...storedLatestSecond.data.qianshiDelta, relations: [] } } });
  const independent = harness({ sharedBackend: seed.backend, sharedContext: seed.context,
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: '允许独立更换千事。', qianshi: { events: [{ key: 'independent-event', title: '无外部引用的新事件',
        description: '第一楼已更新', status: 'occurred', matter: false }], order: [] } } }
      : { jsonData: { noMaterialChange: true } } });
  await independent.runtime.start(); await independent.runtime.extractFloor(floors[0].floorId, { analyzeState: false });
  const independentSaved = (await independent.store.readReachable({ mode: 'runtime' })).floorMemories.find(value => value.floorId === floors[0].floorId);
  assert.notEqual(independentSaved.qianshiDelta.events[0].id, firstEventId, '没有其他楼引用旧事件时允许替换千事');
});

test('重提旧楼若同 ID 改变事项对象会破坏后楼 progress，只保存摘要并保留旧千事', async () => {
  const initialChat = [user('开始'), assistant('顾舟计划归还旧书。'), assistant('沈砚接过旧书继续处理。'), user('稳定')];
  const seed = harness({ initialChat, utility: options => {
    const request = JSON.parse(options.taskMessages[0].content);
    if (request.task !== 'extractFloorSemantics') return { jsonData: { noMaterialChange: true } };
    if (request.payload.canonicalContent.includes('计划归还')) return { jsonData: { summary: '旧计划摘要。', qianshi: { events: [{
      key: 'old', title: '归还旧书', description: '顾舟计划归还旧书', status: 'planned', matter: true, object: '旧书',
    }], order: [] } } };
    const candidate = request.payload.qianshiCandidates?.[0];
    return { jsonData: { summary: '后楼摘要。', qianshi: { events: [{ key: 'followup', title: '沈砚继续处理旧书',
      description: '沈砚接过旧书继续处理', status: 'inProgress', matter: true,
      ...(candidate ? { links: [{ candidateKey: candidate.key, kind: 'progress' }] } : {}) }], order: [] } } };
  } });
  await seed.runtime.start();
  const floors = seed.runtime.getState().floors;
  for (const floor of floors) await seed.runtime.extractFloor(floor.floorId, { analyzeState: false });
  const before = await seed.store.readReachable({ mode: 'runtime' });
  const firstBefore = before.floorMemories.find(memory => memory.floorId === floors[0].floorId).qianshiDelta.events[0];
  assert.equal(projectQianshiGraph(before).relations.filter(relation => relation.type === 'progress').length, 1);
  const notices = [];
  const retry = harness({ sharedBackend: seed.backend, sharedContext: seed.context, notifyUser: notice => notices.push(notice),
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: '同 ID 但对象已变的摘要。', qianshi: { events: [{ key: 'old', title: '归还旧书',
        description: '顾舟计划归还旧书', status: 'planned', matter: true, object: '新箱子' }], order: [] } } }
      : { jsonData: { noMaterialChange: true } } });
  await retry.runtime.start();
  await retry.runtime.extractFloor(floors[0].floorId, { analyzeState: false });
  const after = await retry.store.readReachable({ mode: 'runtime' });
  const savedFirst = after.floorMemories.find(memory => memory.floorId === floors[0].floorId);
  assert.equal(savedFirst.qianshiDelta.events[0].id, firstBefore.id, '对象变化不改变事件 ID');
  assert.equal(savedFirst.qianshiDelta.events[0].object, '旧书', '同 ID 的旧事项语义仍被保留');
  assert.equal(savedFirst.qianshiDelta.events[0].matterId, firstBefore.matterId);
  assert.equal(savedFirst.summary.aiText, '同 ID 但对象已变的摘要。', '千事拒绝仍保留新摘要');
  assert.equal(projectQianshiGraph(after).relations.filter(relation => relation.type === 'progress').length, 1);
  assert.ok(notices.some(notice => /使其他楼原本有效的进展关系失效/u.test(notice.text)), '用户可见跨楼进展守卫原因');
});

test('同批前楼替换事项语义后跳过仍使用旧候选的后楼', async () => {
  let mode = 'summary';
  const h = harness({ initialChat: [user('开始'), assistant('顾舟计划归还旧书。'), assistant('沈砚接过旧书继续处理。'), user('稳定')],
    utility: options => {
      if (mode === 'summary') return { jsonData: { summary: '旧摘要。', qianshi: { events: [{ key: 'old', title: '归还旧书',
        description: '顾舟计划归还旧书', status: 'planned', matter: true, object: '旧书' }, { key: 'invalid', title: '缺少描述' }], order: [] } } };
      const request = JSON.parse(options.taskMessages[0].content);
      const secondKeys = request.floors.find(value => value.assistantSeq === 2)?.qianshiCandidateKeys ?? [];
      assert.ok(secondKeys.length, '后楼候选键来自本批开始时的旧事项语义');
      return { jsonData: { floors: request.floors.map(value => value.assistantSeq === 1
        ? { floorKey: value.floorKey, qianshi: { events: [{ key: 'old', title: '归还旧书', description: '顾舟计划归还旧书',
          status: 'planned', matter: true, object: '新箱子' }], order: [] } }
        : { floorKey: value.floorKey, qianshi: { events: [{ key: 'followup', title: '沈砚继续处理旧书',
          description: '沈砚接过旧书继续处理', status: 'inProgress', matter: true,
          links: [{ candidateKey: secondKeys[0], kind: 'progress' }] }], order: [] } }) } };
    } });
  await h.runtime.start();
  for (const floor of h.runtime.getState().floors) await h.runtime.extractFloor(floor.floorId, { analyzeState: false });
  const before = await h.store.readReachable({ mode: 'runtime' });
  const prior = before.floorMemories.find(memory => memory.floorId === h.runtime.getState().floors[0].floorId).qianshiDelta.events[0];
  const priorSecondDelta = structuredClone(before.floorMemories.find(memory => memory.floorId === h.runtime.getState().floors[1].floorId).qianshiDelta);
  const plan = await h.runtime.prepareQianshiHistory();
  assert.equal(plan.batchCount, 1);
  mode = 'history';
  const result = await h.runtime.startQianshiHistory(plan.planId);
  assert.equal(result.status, 'partial');
  assert.match(result.message, /前楼事项在本批处理中发生变化/u);
  const after = await h.store.readReachable({ mode: 'runtime' });
  const first = after.floorMemories.find(memory => memory.floorId === h.runtime.getState().floors[0].floorId);
  const second = after.floorMemories.find(memory => memory.floorId === h.runtime.getState().floors[1].floorId);
  assert.equal(first.qianshiDelta.events[0].id, prior.id, '替换事件仍保留旧 ID');
  assert.equal(first.qianshiDelta.events[0].object, '新箱子', '前楼本批替换按新语义保存');
  assert.deepEqual(second.qianshiDelta, priorSecondDelta, '后楼原记录保持不变，没有提交基于过期候选的新关系');
});

test('同批前楼同 ID 同 matterId 改时间和人物后不复用冻结候选', async () => {
  let mode = 'summary';
  const h = harness({ initialChat: [user('开始'), assistant('顾舟在六月计划归还旧书。'), assistant('沈砚接过旧书继续处理。'), user('稳定')],
    utility: options => {
      if (mode === 'summary') return { jsonData: { summary: '旧摘要。', qianshi: { events: [{ key: 'old', title: '归还旧书',
        description: '顾舟计划归还旧书', status: 'planned', matter: true, object: '旧书', storyTime: '六月', people: ['顾舟'] },
        { key: 'invalid', title: '缺少描述' }], order: [] } } };
      const request = JSON.parse(options.taskMessages[0].content);
      const secondKeys = request.floors.find(value => value.assistantSeq === 2)?.qianshiCandidateKeys ?? [];
      assert.ok(secondKeys.length);
      return { jsonData: { floors: request.floors.map(value => value.assistantSeq === 1
        ? { floorKey: value.floorKey, qianshi: { events: [{ key: 'old', title: '归还旧书', description: '顾舟计划归还旧书',
          status: 'planned', matter: true, object: '旧书', storyTime: '七月', people: ['沈砚'] }], order: [] } }
        : { floorKey: value.floorKey, qianshi: { events: [{ key: 'followup', title: '沈砚继续处理旧书',
          description: '沈砚接过旧书继续处理', status: 'inProgress', matter: true,
          links: [{ candidateKey: secondKeys[0], kind: 'progress' }] }], order: [] } }) } };
    } });
  await h.runtime.start();
  for (const floor of h.runtime.getState().floors) await h.runtime.extractFloor(floor.floorId, { analyzeState: false });
  const before = await h.store.readReachable({ mode: 'runtime' });
  const firstFloorId = h.runtime.getState().floors[0].floorId, secondFloorId = h.runtime.getState().floors[1].floorId;
  const prior = before.floorMemories.find(memory => memory.floorId === firstFloorId).qianshiDelta.events[0];
  const priorSecondDelta = structuredClone(before.floorMemories.find(memory => memory.floorId === secondFloorId).qianshiDelta);
  const plan = await h.runtime.prepareQianshiHistory(); assert.equal(plan.batchCount, 1);
  mode = 'history';
  const result = await h.runtime.startQianshiHistory(plan.planId);
  assert.equal(result.status, 'partial');
  assert.match(result.message, /受影响楼已跳过；请重新准备计划/u);
  const after = await h.store.readReachable({ mode: 'runtime' });
  const first = after.floorMemories.find(memory => memory.floorId === firstFloorId).qianshiDelta.events[0];
  const second = after.floorMemories.find(memory => memory.floorId === secondFloorId).qianshiDelta;
  assert.equal(first.id, prior.id);
  assert.equal(first.matterId, prior.matterId, '更改展示属性不改变 matterId');
  assert.equal(first.storyTime, '七月');
  assert.deepEqual(first.people.map(person => person.name), ['沈砚']);
  assert.deepEqual(second, priorSecondDelta, '依赖旧 storyTime/people 的后楼没有提交');
});

test('同批前楼新事件绑定可供后楼引用并成功保存', async () => {
  let mode = 'summary';
  const seed = harness({ initialChat: [user('开始'), assistant('第一楼新约定。'), assistant('第二楼继续这项约定。'), user('稳定')],
    utility: options => mode === 'summary' ? { jsonData: { summary: '已有摘要。' } } : { jsonData: { noMaterialChange: true } } });
  await seed.runtime.start();
  for (const floor of seed.runtime.getState().floors) await seed.runtime.extractFloor(floor.floorId, { analyzeState: false });
  const before = await seed.store.readReachable({ mode: 'runtime' });
  for (const memory of before.floorMemories) {
    const key = `chat-${CHAT}/v3-floor-memory-${memory.id}`, stored = seed.backend.records.get(key);
    const { qianshiDelta: _oldDelta, ...legacyData } = stored.data;
    seed.backend.records.set(key, { ...stored, data: legacyData });
  }
  const history = harness({ sharedBackend: seed.backend, sharedContext: seed.context,
    utility: options => {
      const request = JSON.parse(options.taskMessages[0].content);
      const second = request.floors.find(value => value.assistantSeq === 2);
      assert.ok(second, '同一批包含后楼');
      assert.deepEqual(second.qianshiCandidateKeys, [], '请求候选池开始时没有旧事项');
      return { jsonData: { floors: request.floors.map(value => value.assistantSeq === 1
        ? { floorKey: value.floorKey, qianshi: { events: [{ key: 'new', title: '新约定', description: '第一楼建立新约定', status: 'planned', matter: true }], order: [] } }
        : { floorKey: value.floorKey, qianshi: { events: [{ key: 'continue', title: '继续新约定', description: '第二楼继续第一楼约定',
          status: 'inProgress', matter: true, links: [{ candidateKey: 'floor-1:new', kind: 'progress' }] }], order: [] } }) } };
    } });
  await history.runtime.start();
  const plan = await history.runtime.prepareQianshiHistory();
  assert.equal(plan.batchCount, 1);
  mode = 'history';
  const result = await history.runtime.startQianshiHistory(plan.planId);
  assert.equal(result.status, 'completed');
  const after = await history.store.readReachable({ mode: 'runtime' });
  assert.equal(projectQianshiGraph(after).relations.filter(relation => relation.type === 'progress').length, 1,
    '新鲜 earlierBindings 可以让同批后楼建立有效 progress 关系');
  assert.equal(projectQianshiGraph(after).diagnostics.degradedFloorIds.length, 0);
});

test('CAS 重试会在最新图验证无旧千事的历史补齐候选，前楼事件并发移除后只保存摘要', async () => {
  const initialChat = [user('开始'), assistant('顾舟计划归还旧书。'), user('确认第一楼'), assistant('顾舟带着旧书来到车站。'), user('确认第二楼')];
  const seed = harness({ initialChat, utility: options => {
    const request = JSON.parse(options.taskMessages[0].content);
    if (request.task === 'extractFloorSemantics') return request.payload.canonicalContent.includes('计划归还')
      ? { jsonData: { summary: '旧书归还计划。', qianshi: { events: [{ key: 'prior', title: '归还旧书', description: '顾舟计划归还旧书', status: 'planned', matter: true }], order: [] } } }
      : { jsonData: { summary: '车站旧摘要。' } };
    return { jsonData: { noMaterialChange: true } };
  } });
  await seed.runtime.start();
  const floors = seed.runtime.getState().floors;
  for (const floor of floors) await seed.runtime.extractFloor(floor.floorId, { analyzeState: false });
  const seeded = await seed.store.readReachable({ mode: 'runtime' });
  const legacyTarget = seeded.floorMemories.find(memory => memory.floorId === floors[1].floorId);
  const legacyKey = `chat-${CHAT}/v3-floor-memory-${legacyTarget.id}`, storedLegacy = seed.backend.records.get(legacyKey);
  const { qianshiDelta: _oldDelta, ...legacyData } = storedLegacy.data;
  seed.backend.records.set(legacyKey, { ...storedLegacy, data: legacyData });
  assert.equal((await seed.store.readReachable({ mode: 'runtime' })).floorMemories.find(memory => memory.floorId === floors[1].floorId).qianshiDelta, undefined,
    '真实旧格式 FloorMemory 确实没有千事 delta');

  const history = harness({ sharedBackend: seed.backend, sharedContext: seed.context,
    utility: async options => {
      const request = JSON.parse(options.taskMessages[0].content);
      const candidate = request.qianshiCandidates?.[0];
      assert.ok(candidate?.key, '历史请求使用最新图里的前楼事项候选');
      return { jsonData: { floors: request.floors.map(value => ({ floorKey: value.floorKey, qianshi: { events: [{
        key: 'late-progress', title: '车站归还旧书', description: '顾舟在车站归还旧书，推进旧约定', status: 'completed',
        matter: true, links: [{ candidateKey: candidate.key, kind: 'progress' }],
      }], order: [] } })) } };
    } });
  const removal = harness({ sharedBackend: seed.backend, sharedContext: seed.context,
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: '前楼更新为没有有效事件。', qianshi: { events: [], order: [] } } }
      : { jsonData: { noMaterialChange: true } } });
  await history.runtime.start(); await removal.runtime.start();
  const plan = await history.runtime.prepareQianshiHistory();
  assert.equal(plan.totalFloors, 1);
  let raced = false;
  seed.backend.setBeforePut(async ({ key }) => {
    if (!String(key).includes('v3-root') || raced) return;
    raced = true;
    const sourceFloor = removal.runtime.getState().floors[0];
    await removal.runtime.extractFloor(sourceFloor.floorId, { analyzeState: false });
  });
  const result = await history.runtime.startQianshiHistory(plan.planId);
  seed.backend.setBeforePut(null);
  assert.equal(raced, true, '历史写 root 前真实并发提交前楼更新，令首轮 CAS 冲突');
  assert.equal(result.status, 'partial', '最新图已不含被引用事件，历史千事结果拒绝而任务如实部分完成');
  const after = await history.store.readReachable({ mode: 'runtime' });
  const target = after.floorMemories.find(memory => memory.floorId === floors[1].floorId);
  assert.equal(target.summary.aiText, '车站旧摘要。', '旧目标摘要仍保留');
  assert.equal(target.qianshiDelta, undefined, '旧目标原本没有千事，新结果中的过期跨楼引用也不得落盘');
  assert.equal(after.floorMemories.find(memory => memory.floorId === floors[0].floorId).qianshiDelta.events.length, 0, 'CAS winner 确实已移除候选事件');
});

test('CAS 重试重新计算千事拒绝结果，入站关系并发移除后不留虚假失败', async () => {
  const initialChat = [user('开始'), assistant('顾舟计划归还旧书。'), user('确认第一楼'), assistant('沈砚接过旧书继续处理。'), user('确认第二楼')];
  const seed = harness({ initialChat, utility: options => {
    const request = JSON.parse(options.taskMessages[0].content);
    if (request.task !== 'extractFloorSemantics') return { jsonData: { noMaterialChange: true } };
    if (request.payload.canonicalContent.includes('计划归还')) return { jsonData: { summary: '原计划摘要。', qianshi: { events: [
      { key: 'old', title: '归还旧书', description: '顾舟计划归还旧书', status: 'planned', matter: true }, { key: 'bad', title: '缺失描述' },
    ], order: [] } } };
    const candidate = request.payload.qianshiCandidates?.[0];
    return { jsonData: { summary: '后楼原摘要。', qianshi: { events: [{ key: 'followup', title: '沈砚继续处理旧书',
      description: '沈砚接过旧书继续处理', status: 'inProgress', matter: true,
      ...(candidate ? { links: [{ candidateKey: candidate.key, kind: 'progress' }] } : {}) }], order: [] } } };
  } });
  await seed.runtime.start();
  const floors = seed.runtime.getState().floors;
  for (const floor of floors) await seed.runtime.extractFloor(floor.floorId, { analyzeState: false });
  const before = await seed.store.readReachable({ mode: 'runtime' });
  assert.equal(before.floorMemories.find(memory => memory.floorId === floors[0].floorId).qianshiDelta.status, 'partial');
  assert.equal(projectQianshiGraph(before).diagnostics.degradedFloorIds.length, 0);
  const firstEventId = projectQianshiGraph(before).events.find(event => event.sourceFloorId === floors[0].floorId).id;
  assert.ok(projectQianshiGraph(before).events.find(event => event.sourceFloorId === floors[1].floorId).continuesFromEventIds.includes(firstEventId));

  const history = harness({ sharedBackend: seed.backend, sharedContext: seed.context,
    utility: options => {
      const request = JSON.parse(options.taskMessages[0].content);
      return { jsonData: { floors: request.floors.map(value => ({ floorKey: value.floorKey, qianshi: { events: [{
        key: 'replacement', title: '归还旧书进展', description: '旧书已交接处理', status: 'completed', matter: false,
      }], order: [] } })) } };
    } });
  const removeInbound = harness({ sharedBackend: seed.backend, sharedContext: seed.context,
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: '后楼移除旧事项连接。', qianshi: { events: [{ key: 'followup', title: '沈砚继续处理旧书',
        description: '沈砚接过旧书继续处理', status: 'inProgress', matter: true }], order: [] } } }
      : { jsonData: { noMaterialChange: true } } });
  await history.runtime.start(); await removeInbound.runtime.start();
  const plan = await history.runtime.prepareQianshiHistory();
  assert.equal(plan.totalFloors, 1);
  let raced = false;
  seed.backend.setBeforePut(async ({ key }) => {
    if (!String(key).includes('v3-root') || raced) return;
    raced = true;
    await removeInbound.runtime.extractFloor(floors[1].floorId, { analyzeState: false });
  });
  const result = await history.runtime.startQianshiHistory(plan.planId);
  seed.backend.setBeforePut(null);
  assert.equal(raced, true, '提交点执行真实后楼更新，令历史首轮 CAS 冲突');
  assert.equal(result.status, 'completed', '新图已移除所有入站关系后，重试安全替换千事');
  const after = await history.store.readReachable({ mode: 'runtime' });
  const first = after.floorMemories.find(memory => memory.floorId === floors[0].floorId);
  assert.equal(first.qianshiDelta.events[0].title, '归还旧书进展');
  assert.equal(first.summary.aiText, '原计划摘要。');
  assert.equal(projectQianshiGraph(after).diagnostics.degradedFloorIds.length, 0);
});

test('聚合 FloorMemory 中间来源楼的坏 continuation 按锚楼进入历史修整计划', async () => {
  const initialChat = Array.from({ length: 10 }, (_, index) => [assistant(`聚合成员 ${index + 1} 记录归还旧书。`), user(`确认 ${index + 1}`)]).flat();
  const seed = harness({ initialChat, utility: options => {
    const request = JSON.parse(options.taskMessages[0].content);
    if (request.task === 'extractFloorSemantics') return { jsonData: { summary: '十楼高楼压缩摘要。', qianshi: { events: [{
      key: 'middle-event', title: '归还旧书', description: '第五个聚合成员确认归还旧书', status: 'planned', matter: true,
      sourceFloorKey: 'floor-5',
    }], order: [] } } };
    return { jsonData: { noMaterialChange: true } };
  } });
  await seed.runtime.start();
  await seed.runtime.startHistoricalRebuild({ aggregate: true });
  await waitFor(() => ['caughtUp', 'waitingRealtime'].includes(seed.runtime.getState().rebuildStatus));
  const before = await seed.store.readReachable({ mode: 'runtime' });
  const aggregateMemory = before.floorMemories[0];
  assert.equal(aggregateMemory.sourceFloorIds.length, 10);
  const sourceMemberId = aggregateMemory.sourceFloorIds[4], anchorFloorId = aggregateMemory.floorId;
  const key = `chat-${CHAT}/v3-floor-memory-${aggregateMemory.id}`, stored = seed.backend.records.get(key);
  const damaged = structuredClone(stored.data), event = damaged.qianshiDelta.events[0];
  event.continuesFromEventIds = ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'];
  seed.backend.records.set(key, { ...stored, data: damaged });
  let historyModelCalls = 0;
  const cold = harness({ sharedBackend: seed.backend, sharedContext: seed.context,
    utility: () => { historyModelCalls += 1; throw new Error('聚合 FloorMemory 不得调用历史替换模型'); } });
  await cold.runtime.start();
  const snapshot = cold.runtime.getQianshiSnapshot();
  assert.equal(snapshot.coverage.degradedFloors, 1, '聚合记忆只让其锚楼计入断链覆盖');
  assert.equal(snapshot.diagnostics.degradedFloorIds[0], anchorFloorId);
  assert.notEqual(anchorFloorId, sourceMemberId);
  const putsBefore = seed.backend.calls.filter(call => call[0] === 'put').length;
  const plan = await cold.runtime.prepareQianshiHistory();
  assert.equal(plan.totalFloors, 1);
  assert.equal(plan.localRepairFloors, 1);
  assert.equal(plan.apiCalls, 0, '聚合 FloorMemory 的确认计划不创建模型替换批次');
  assert.equal(plan.aggregateSkippedFloors.length, 1, '计划明确列出因成员来源保护而跳过模型替换的锚楼');
  assert.equal(plan.aggregateSkippedFloors[0].floorId, anchorFloorId);
  assert.equal(seed.backend.calls.filter(call => call[0] === 'put').length, putsBefore, '聚合断链计划仍是零写预览');
  const result = await cold.runtime.startQianshiHistory(plan.planId);
  assert.equal(result.status, 'partial');
  assert.match(result.message, /由多个正文楼聚合，模型替换已跳过以保留成员来源/u);
  assert.equal(historyModelCalls, 0, '确认后只执行本地坏引用隔离，不调用历史模型替换');
  const after = await cold.store.readReachable({ mode: 'runtime' });
  const repaired = after.floorMemories.find(memory => memory.floorId === anchorFloorId);
  assert.equal(repaired.qianshiDelta.status, 'partial');
  assert.equal(repaired.sourceFloorIds.length, 10);
  assert.deepEqual(repaired.sourceFloorIds, aggregateMemory.sourceFloorIds);
  assert.equal(repaired.qianshiDelta.events[0].sourceFloorId, sourceMemberId, '隔离继续保留聚合成员的原始事件来源');
  assert.deepEqual(repaired.qianshiDelta.events[0].continuesFromEventIds, []);
});

test('千事历史显式停止后只重新规划未完成楼，不重发已成功楼', async () => {
  let mode = 'summary', historyCalls = 0, releaseSecond, markSecondStarted;
  const secondStarted = new Promise(resolve => { markSecondStarted = resolve; });
  const secondWait = new Promise(resolve => { releaseSecond = resolve; });
  const longA = `第一楼-${'甲'.repeat(10000)}`, longB = `第二楼-${'乙'.repeat(10000)}`;
  const historyResponse = options => {
    const request = JSON.parse(options.taskMessages[0].content);
    return { jsonData: { floors: request.floors.map(value => ({ floorKey: value.floorKey, qianshi: { events: [{ key: 'event-1', title: `事项${value.assistantSeq}`,
      description: `第${value.assistantSeq}楼事项`, status: 'planned', matter: true }], order: [] } })) } };
  };
  const h = harness({ initialChat: [user('开始'), assistant(longA), assistant(longB), user('稳定')], utility: async options => {
    if (mode === 'summary') return { jsonData: { summary: '已有摘要。' } };
    historyCalls += 1;
    if (historyCalls === 2) { markSecondStarted(); await secondWait; }
    return historyResponse(options);
  } });
  await h.runtime.start();
  for (const value of h.runtime.getState().floors) await h.runtime.extractFloor(value.floorId, { analyzeState: false });
  mode = 'history';
  const firstPlan = await h.runtime.prepareQianshiHistory({ maxInputTokens: 4000 });
  assert.equal(firstPlan.batchCount, 2, '夹具应把两楼规划为两个批次');
  const running = h.runtime.startQianshiHistory(firstPlan.planId);
  await secondStarted;
  const stopping = h.runtime.stopQianshiHistory();
  releaseSecond();
  const [stopped] = await Promise.all([running, stopping]);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.processedFloors, 1);
  const firstCompleted = h.runtime.getQianshiSnapshot().events.map(value => value.sourceFloorId);
  assert.equal(firstCompleted.length, 1);
  const resumePlan = await h.runtime.prepareQianshiHistory({ maxInputTokens: 4000 });
  assert.equal(resumePlan.totalFloors, 1, '重新规划只包含未完成楼');
  assert.equal(resumePlan.apiCalls, 1);
  const resumed = await h.runtime.startQianshiHistory(resumePlan.planId);
  assert.equal(resumed.status, 'completed');
  assert.equal(h.runtime.getQianshiSnapshot().coverage.completeFloors, 2);
  assert.equal(h.runtime.getQianshiSnapshot().events.filter(value => firstCompleted.includes(value.sourceFloorId)).length, 1, '已成功楼没有重复提取');
});

test('千事历史整体无效返回保留已有 partial 合法事件，不把失败楼计作完成', async () => {
  let mode = 'summary';
  const h = harness({ initialChat: [user('开始'), assistant('顾舟答应归还旧书。'), user('稳定')], utility: () => mode === 'summary'
    ? { jsonData: { summary: '顾舟答应归还旧书。', qianshi: { events: [
      { key: 'valid', title: '归还旧书', description: '顾舟答应归还旧书', status: 'planned', matter: true },
      { key: 'invalid', title: '缺少描述' },
    ], order: [] } } }
    : { jsonData: { floors: [{ floorKey: 'floor-1', qianshi: '坏字段' }] } } });
  await h.runtime.start();
  const target = h.runtime.getState().floors[0];
  await h.runtime.extractFloor(target.floorId, { analyzeState: false });
  const before = h.runtime.getQianshiSnapshot();
  assert.equal(before.coverage.partialFloors, 1); assert.equal(before.events.length, 1);
  const plan = await h.runtime.prepareQianshiHistory(); mode = 'history';
  const result = await h.runtime.startQianshiHistory(plan.planId);
  assert.equal(result.status, 'partial'); assert.equal(result.processedFloors, 0);
  const after = h.runtime.getQianshiSnapshot();
  assert.equal(after.coverage.partialFloors, 1); assert.deepEqual(after.events, before.events);
});

test('千事历史请求切换聊天后立即失去发布资格，迟到返回不写旧聊也不污染新聊状态', async () => {
  let mode = 'summary', releaseHistory, markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const wait = new Promise(resolve => { releaseHistory = resolve; });
  const h = harness({ initialChat: [user('开始'), assistant('顾舟答应归还旧书。'), user('稳定')], utility: async options => {
    if (mode === 'summary') return { jsonData: { summary: '顾舟答应归还旧书。' } };
    markStarted(); await wait;
    const request = JSON.parse(options.taskMessages[0].content);
    return { jsonData: { floors: [{ floorKey: request.floors[0].floorKey, qianshi: { events: [{ key: 'event-1', title: '归还旧书', description: '顾舟答应归还旧书', status: 'planned', matter: true }], order: [] } }] } };
  } });
  await h.runtime.start();
  const target = h.runtime.getState().floors[0];
  await h.runtime.extractFloor(target.floorId, { analyzeState: false });
  const beforeMemoryId = h.foundationRuntime.getReachable().floorMemories.find(value => value.floorId === target.floorId).id;
  const plan = await h.runtime.prepareQianshiHistory(); mode = 'history';
  const run = h.runtime.startQianshiHistory(plan.planId); await started;
  h.context.chatMetadata.qianqianjie.chatId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  h.emit('CHAT_CHANGED');
  await waitFor(() => h.runtime.getQianshiSnapshot().status === 'not-ready');
  releaseHistory();
  const result = await run;
  assert.equal(result.status, 'stopped');
  h.context.chatMetadata.qianqianjie.chatId = CHAT;
  const stored = await h.store.readReachable({ mode: 'runtime' });
  assert.equal(stored.floorMemories.find(value => value.floorId === target.floorId).id, beforeMemoryId);
});


test('手动刷新既成缺 integrity 尾删档经过完整读回恢复摘要与CSE，普通refresh只inspect', async () => {
  let h, reads = 0, failAnchorWrites = false;
  h = harness({ readOnlyLifecycle: true, modernAnchors: true,
    initialChat: [assistant('第一楼'), user('一'), assistant('第二楼'), user('二'), assistant('第三楼'), user('三')],
    foundationFetch: async () => { reads++; return { ok: true, json: async () => [{ chat_metadata: structuredClone(h.context.chatMetadata) }, ...structuredClone(h.context.chat)] }; },
    persistAnchors: async ({ chatId, bindings }) => {
      if (failAnchorWrites) throw Object.assign(new Error('模拟消息标识保存失败'), { code: 'V3_MESSAGE_ANCHOR_SAVE_FAILED' });
      for (const binding of bindings) h.context.chat[binding.messageIndex].extra = { ...(h.context.chat[binding.messageIndex].extra ?? {}), qianqianjie_floor: { schemaVersion: 1, chatId, floorId: binding.floorId } };
    },
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT ? { jsonData: { summary: '摘要', people: [{ name: '裴晚生' }] } } : { jsonData: { noMaterialChange: true } } });
  h.context.chatMetadata.integrity = 'complete';
  await h.runtime.start(); await h.runtime.startHistoricalRebuild();
  await waitFor(() => registeredGraphCaughtUp(h.runtime.getState()));
  const full = h.foundationRuntime.getReachable(), root = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-root`));
  const entitySemantics = values => values.map(({ firstSeenFloorId, lastSeenFloorId, ...value }) => value);
  const preservedPrefix = structuredClone({ floors: full.floors.slice(0, 2), floorMemories: full.floorMemories.slice(0, 2),
    stateDeltas: full.stateDeltas.slice(0, 2), entities: entitySemantics(full.entities), baseline: full.baseline });
  const callCount = h.calls.length;
  delete h.context.chat[0].extra.qianqianjie_floor;
  failAnchorWrites = true;
  await h.runtime.refreshStatus({ preferCached: false });
  await waitFor(() => h.runtime.getState().memorySyncStatus !== 'syncing');
  assert.equal(h.runtime.getState().lastExtractorError?.phase, 'anchor');
  assert.equal(h.runtime.getState().memorySyncStatus, 'error');
  failAnchorWrites = false;
  delete h.context.chatMetadata.integrity; h.context.chat.splice(4);
  await h.runtime.refreshStatus({ preferCached: false });
  await waitFor(() => h.runtime.getState().memorySyncStatus !== 'syncing');
  assert.equal(reads, 0); assert.equal(h.runtime.getState().memorySyncStatus, 'needsReview');
  assert.deepEqual(h.backend.records.get(`chat-${CHAT}/v3-root`), root);
  await h.runtime.refreshStatus({ preferCached: false, recoverTailDeletion: true, reconcileFoundation: true });
  await waitFor(() => h.runtime.getState().memorySyncStatus !== 'syncing');
  const after = h.runtime.getState(), cut = h.foundationRuntime.getReachable();
  assert.equal(reads, 1); assert.equal(after.memorySyncStatus, 'idle'); assert.equal(after.stableCount, 2);
  assert.equal(after.lastExtractorError, null); assert.equal(after.memorySyncError, null);
  assert.ok(h.context.chat[0].extra.qianqianjie_floor, '幸存前缀缺失的标识必须真实重试成功后才清除旧错误');
  assert.deepEqual({ floors: cut.floors, floorMemories: cut.floorMemories, stateDeltas: cut.stateDeltas,
    entities: entitySemantics(cut.entities), baseline: cut.baseline }, preservedPrefix, '恢复只回退已删除尾楼，旧前缀摘要、CSE、人物与基线保持不变');
  assert.deepEqual(cut.floorMemories, full.floorMemories.slice(0, 2));
  assert.deepEqual(cut.stateDeltas, full.stateDeltas.slice(0, 2));
  assert.equal(h.calls.length, callCount, '恢复不调用模型');

  delete h.context.chat[0].extra.qianqianjie_floor;
  failAnchorWrites = true;
  await h.runtime.refreshStatus({ preferCached: false });
  await waitFor(() => h.runtime.getState().memorySyncStatus !== 'syncing');
  h.context.chat.splice(2);
  await h.runtime.refreshStatus({ preferCached: false, recoverTailDeletion: true, reconcileFoundation: true });
  await waitFor(() => h.runtime.getState().memorySyncStatus !== 'syncing');
  assert.equal(h.runtime.getState().memorySyncStatus, 'error');
  assert.equal(h.runtime.getState().lastExtractorError?.phase, 'anchor');
  assert.equal(h.context.chat[0].extra.qianqianjie_floor, undefined, '幸存前缀保存仍失败时不得假报 idle');
  failAnchorWrites = false;
  await h.runtime.refreshStatus({ preferCached: false });
  await waitFor(() => h.runtime.getState().memorySyncStatus !== 'syncing');
  assert.equal(h.runtime.getState().memorySyncStatus, 'idle');
  assert.ok(h.context.chat[0].extra.qianqianjie_floor, '后续保存恢复时沿用既有挂标重试并清除错误');

  delete h.context.chat[0].extra.qianqianjie_floor;
  failAnchorWrites = true;
  await h.runtime.refreshStatus({ preferCached: false });
  await waitFor(() => h.runtime.getState().memorySyncStatus !== 'syncing');
  failAnchorWrites = false;
  h.context.chat.splice(0);
  await h.runtime.refreshStatus({ preferCached: false, recoverTailDeletion: true, reconcileFoundation: true });
  await waitFor(() => h.runtime.getState().memorySyncStatus !== 'syncing');
  assert.equal(reads, 3);
  assert.equal(h.runtime.getState().stableCount, 0);
  assert.equal(h.runtime.getState().memorySyncStatus, 'idle');
  assert.equal(h.runtime.getState().lastExtractorError, null);
  assert.equal(h.runtime.getState().memorySyncError, null);
  assert.equal(h.calls.length, callCount, '连续尾删与删空恢复都不得调用模型');
});
