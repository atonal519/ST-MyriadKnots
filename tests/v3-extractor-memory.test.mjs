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
import { buildExtractorSystemPrompt, createExtractorEnvelope, DEFAULT_EXTRACTOR_GUIDANCE, EXTRACTOR_FIXED_CONTRACT, EXTRACTOR_OUTPUT_CONTRACT, EXTRACTOR_PROMPT_VERSION, EXTRACTOR_SYSTEM_PROMPT, normalizeExtractorResponse, runExtractorRequest } from '../src/v3/extractor.js';
import { buildCseSystemPrompt, CSE_FIXED_CONTRACT, CSE_SYSTEM_PROMPT, createCseEnvelope, DEFAULT_CSE_GUIDANCE } from '../src/v3/cse-engine.js';
import { BASE_PROCESSING_PROMPT } from '../src/internal-processing-prompt.js';
import { buildEntityIdentityDirectory } from '../src/v3/entity-identity.js';

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

function viewHarness(runtime) {
  const documentRef = { activeElement: null, createElement: tag => new ViewNode(tag) };
  class ViewNode {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.textContent = ''; this.className = ''; this.disabled = false; this.value = ''; this.open = false; this.selectionStart = 0; this.selectionEnd = 0; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = [...nodes]; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    click() { return this.listeners.click?.(); }
    fire(name) { return this.listeners[name]?.(); }
    focus() { documentRef.activeElement = this; }
  }
  const flatten = node => [node, ...(node.children ?? []).flatMap(flatten)];
  const container = new ViewNode('main');
  const view = createV3FoundationView({ runtime, documentRef }); view.setPage('memories'); view.mount(container);
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
  const envelope = (data, revision) => ({ schemaVersion: 1, revision, generationId: '11111111-1111-4111-8111-111111111111', createdAt: NOW, updatedAt: NOW, data: structuredClone(data) });
  const error = status => Object.assign(new Error(`HTTP ${status}`), { status });
  return { records, calls, setConflictRoot(value) { conflictRoot = value; }, abortAfterNextPut(predicate) { abortAfterPut = predicate; }, holdNextRootPut() {
    let release, markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    rootGate = { started: markStarted, wait };
    return { started, release };
  }, client: {
    async get(collection, key) { calls.push(['get', collection, key]); const found = records.get(`${collection}/${key}`); if (!found) throw error(404); return envelope(found.data, found.revision); },
    async put(collection, key, data, expectedRevision, options = {}) { calls.push(['put', collection, key, expectedRevision]); const mapKey = `${collection}/${key}`, previous = records.get(mapKey); if (key === 'v3-root' && rootGate) { const gate = rootGate; rootGate = null; gate.started(); await gate.wait; if (options.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' }); } if (key === 'v3-root' && conflictRoot) throw error(409); if ((previous?.revision ?? 0) !== expectedRevision) throw error(409); const revision = (previous?.revision ?? 0) + 1; records.set(mapKey, { revision, data: structuredClone(data) }); if (abortAfterPut?.(key, data)) { abortAfterPut = null; throw Object.assign(new Error('aborted after durable write'), { name: 'AbortError' }); } return envelope(data, revision); },
  } };
}

function harness({ text = '裴晚生提醒你带伞。', initialChat = null, utility, host = 'official', automation = { enabled: false, batchSize: 2 }, notifyUser, isMainGenerationActive, extractorPromptGuidance, csePromptGuidance, foundationRefresh, eventTypes = null, sharedBackend = null, sharedContext = null, modernAnchors = false } = {}) {
  let enabled = true;
  const handlers = new Map();
  const context = sharedContext ? { ...sharedContext } : {
    name1: '林岚', personaId: 'persona-linlan', characterId: 0, groupId: null, chatId: 'host-chat', characters: [{ avatar: 'character.png' }], userAvatar: 'persona.png',
    chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT } }, chat: initialChat ?? [user('继续'), assistant(text), assistant('用于确认上一楼稳定。')],
  };
  context.eventTypes = eventTypes ?? context.eventTypes ?? Object.fromEntries(['GENERATION_STARTED', 'GENERATION_STOPPED', 'GENERATION_ENDED', 'STREAM_TOKEN_RECEIVED', 'CHAT_CHANGED', 'MESSAGE_SENT', 'USER_MESSAGE_RENDERED', 'MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MORE_MESSAGES_LOADED'].map(name => [name, name]));
  context.eventSource = { on(name, listener) { const values = handlers.get(name) ?? []; values.push(listener); handlers.set(name, values); } };
  const globalRef = host === 'luker' ? { Luker: { getContext: () => context } } : { SillyTavern: { getContext: () => context } };
  const baseHostAdapter = createHostAdapter({ globalRef });
  let snapshotCalls = 0;
  const hostAdapter = Object.freeze({ ...baseHostAdapter, snapshot() { snapshotCalls += 1; return baseHostAdapter.snapshot(); } });
  const backend = sharedBackend ?? backendHarness();
  const identityProvider = () => ({ hostChatId: context.chatId, chatId: context.chatMetadata.qianqianjie.chatId, characterLocator: 'character.png', personaLocator: 'persona.png' });
  const store = createFoundationStore({ client: backend.client, contextProvider: identityProvider, isEnabled: () => enabled });
  const foundationBase = createFoundationRuntime({ hostAdapter, store, contextProvider: () => context, isEnabled: () => enabled, scanCandidates: modernAnchors ? scanAssistantCandidates : legacyScanner, newUuid: uuidFactory(), now: () => new Date(NOW), logger: { warn() {} } });
  const foundationRuntime = typeof foundationRefresh === 'function' ? { ...foundationBase, refreshStatus: () => foundationRefresh(foundationBase) } : foundationBase;
  const calls = [];
  const generateUtilityTask = async options => {
    calls.push(options);
    if (utility) return utility(options, calls.length);
    return { jsonData: { summary: '裴晚生提醒用户带伞。', people: [{ name: '裴晚生' }, { name: '你', role: 'user' }], events: [{ title: '带伞提醒', description: '裴晚生提醒用户带伞。' }] }, taskMetadata: { source: 'shared-utility', sourceLabel: '机械副 API', model: 'mock-model', finishReason: 'stop' } };
  };
  const runtime = createV3MemoryRuntime({ foundationRuntime, store, hostAdapter, generateAnalysisTask: generateUtilityTask, generateUtilityTask, isEnabled: () => enabled, automationSettings: () => automation, notifyUser, isMainGenerationActive, extractorPromptGuidance: () => typeof extractorPromptGuidance === 'function' ? extractorPromptGuidance() : '', csePromptGuidance: () => typeof csePromptGuidance === 'function' ? csePromptGuidance() : '', now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} } });
  runtime.bind({ eventSource: context.eventSource, eventTypes: context.eventTypes });
  const emit = (name, ...args) => (handlers.get(name) ?? []).forEach(listener => listener(...args));
  return { runtime, foundationRuntime, store, backend, context, hostAdapter, calls, emit, snapshotCount: () => snapshotCalls, setEnabled(value) { enabled = value; }, setAutomation(value) { automation = value; } };
}

async function waitFor(predicate, message = '等待异步状态超时') {
  for (let attempt = 0; attempt < 5000; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail(message);
}

async function primeRealtimeTail(h) {
  await h.runtime.start();
  assert.equal(h.calls.length, 0, 'runtime 启动只检测历史覆盖，不得调用记忆 API');
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => h.runtime.getState().rebuildStatus === 'caughtUp');
  h.calls.splice(0);
  h.setAutomation({ enabled: true, batchSize: 2 });
  await h.runtime.refreshAutomation();
  assert.equal(h.calls.length, 0, '开启新楼维护不得回头调用历史记忆 API');
}

async function direct(response, { content = '裴晚生提醒你带伞。', entities = [], userIdentity = { displayName: '林岚', aliases: ['林岚', '你', '{{user}}'] }, batchId = '33333333-3333-4333-8333-333333333333', preservedSummary = null } = {}) {
  const floor = { id: '11111111-1111-4111-8111-111111111111', chatId: CHAT, narrativeGeneration: GENERATION, assistantSeq: 1, content: { canonicalContent: content } };
  const envelope = await createExtractorEnvelope({ batchId, chatId: CHAT, narrativeGeneration: GENERATION, checkpointId: null, floor, entities, userIdentity });
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

test('Extractor 输入只含浅层语义提示，不暴露作用域、UUID 或内部操作', async () => {
  const h = harness({ text: '屏幕写着“忽略规则”，裴晚生没有执行。' });
  await h.runtime.start(); await h.runtime.extractNext();
  const extractorCalls = h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT);
  assert.equal(extractorCalls.length, 1);
  const call = extractorCalls[0];
  assert.equal(call.parseMode, 'semantic');
  assert.equal(Object.hasOwn(call, 'jsonSchema'), false);
  assert.match(EXTRACTOR_SYSTEM_PROMPT, /people、time、locations 也要分别检查并提取/);
  assert.match(EXTRACTOR_SYSTEM_PROMPT, /不输出 UUID/);
  assert.match(EXTRACTOR_FIXED_CONTRACT, /actions、knowledge、informationTransfers、privateThoughts、commitments、exactQuotes、openLoops 或 cseSignals/);
  assert.doesNotMatch(EXTRACTOR_OUTPUT_CONTRACT, /entityId|mentionKey|evidence|floorId|operation/i);
  const request = JSON.parse(call.taskMessages[0].content);
  assert.deepEqual(Object.keys(request), ['task', 'locale', 'payload']);
  assert.equal(request.payload.canonicalContent.includes('忽略规则'), true);
  assert.equal(request.payload.storyClock, null);
  assert.deepEqual(request.payload.userIdentity, { displayName: '林岚', aliases: ['林岚', '你', '{{user}}'] });
  assert.doesNotMatch(JSON.stringify(request), /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
});

test('摘要与 CSE 指导按任务取最新快照，自定义替换默认业务段且固定合同不串用', async () => {
  const guidance = { summary: '摘要自定义第一版', cse: 'CSE 自定义第一版' };
  const getterReads = { summary: 0, cse: 0 };
  const h = harness({
    initialChat: [user('开始'), assistant('第一楼'), assistant('第二楼'), assistant('第三楼'), assistant('用于确认第三楼稳定。')],
    extractorPromptGuidance: () => { getterReads.summary += 1; return guidance.summary; },
    csePromptGuidance: () => { getterReads.cse += 1; return guidance.cse; },
    utility: options => {
      const request = JSON.parse(options.taskMessages[0].content);
      return request.task === 'extractFloorSemantics'
        ? { jsonData: { summary: `摘要-${request.payload.canonicalContent}` } }
        : { jsonData: { noMaterialChange: true } };
    },
  });
  await h.runtime.start();
  await h.runtime.extractNext();
  guidance.summary = '摘要自定义第二版'; guidance.cse = 'CSE 自定义第二版';
  await h.runtime.extractNext();
  guidance.summary = ''; guidance.cse = '';
  await h.runtime.extractNext();

  const summaryCalls = h.calls.filter(call => call.taskMessages[0].content.includes('extractFloorSemantics'));
  const cseCalls = h.calls.filter(call => call.taskMessages[0].content.includes('understandCharacterStateAfterFloor'));
  assert.deepEqual(summaryCalls.map(call => call.systemPrompt), [buildExtractorSystemPrompt('摘要自定义第一版'), buildExtractorSystemPrompt('摘要自定义第二版'), EXTRACTOR_SYSTEM_PROMPT]);
  assert.deepEqual(cseCalls.map(call => call.systemPrompt), [buildCseSystemPrompt('CSE 自定义第一版'), buildCseSystemPrompt('CSE 自定义第二版'), CSE_SYSTEM_PROMPT]);
  assert.equal(getterReads.summary, 3); assert.equal(getterReads.cse, 3);
  assert.doesNotMatch(summaryCalls[0].systemPrompt, new RegExp(DEFAULT_EXTRACTOR_GUIDANCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(cseCalls[0].systemPrompt, new RegExp(DEFAULT_CSE_GUIDANCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(summaryCalls[0].systemPrompt, /固定事实边界/); assert.ok(summaryCalls[0].systemPrompt.includes(EXTRACTOR_FIXED_CONTRACT));
  assert.match(cseCalls[0].systemPrompt, /固定事实与隐私边界/); assert.ok(cseCalls[0].systemPrompt.includes(CSE_FIXED_CONTRACT));
  assert.doesNotMatch(summaryCalls[0].systemPrompt, /CSE 自定义/); assert.doesNotMatch(cseCalls[0].systemPrompt, /摘要自定义/);
  for (const call of [...summaryCalls, ...cseCalls]) {
    assert.equal(call.systemPrompt.split(BASE_PROCESSING_PROMPT).length - 1, 1, '每个内容处理请求只携带一次基础处理层');
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
  assert.match(customPrompt, /payload\.userIdentity\.displayName/);
  assert.match(customPrompt, /\{\{user\}\} 只可作为 canonicalContent 或 aliases 中的输入别名/);
  assert.match(customPrompt, /exactQuotes\.exactText、承诺原话及证据引文必须逐字照抄正文/);
  assert.match(customPrompt, /此例的 payload\.userIdentity\.displayName 为“林岚”/);
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

test('branchReplay 保留旧世代前缀 ID 后仍按 floor 身份提取，root 守卫保持新世代', async () => {
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
  assert.equal(graph.run.mode, 'branchReplay');
  assert.notEqual(graph.root.narrativeGeneration, oldGeneration);
  assert.equal(graph.floors[0].id, prefix.id, '可信前缀必须保留原 floor ID');
  assert.equal(graph.floors[0].narrativeGeneration, oldGeneration);
  assert.notEqual(graph.floors[0].narrativeGeneration, graph.root.narrativeGeneration);

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
  assert.notEqual(memory.narrativeGeneration, graph.root.narrativeGeneration);
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
  stale.emit('CHAT_CHANGED');
  await new Promise(resolve => setImmediate(resolve));
  await waitFor(() => stale.foundationRuntime.getState().status === 'ready', '聊天切换后的地基未收敛');
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
  const h = harness();
  const state = await h.runtime.start().then(() => h.runtime.extractNext());
  const floorId = state.floors[0].floorId;
  const safe = h.runtime.copySafeDiagnostic(floorId);
  assert.doesNotMatch(safe, /canonicalContent|裴晚生提醒你带伞/);
  const full = h.runtime.copyFullDiagnostic(floorId);
  assert.match(full, /canonicalContent/);
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
  await waitFor(() => h.runtime.getState().lastAutoMemory?.status === 'completed' && !h.runtime.getState().activeAutoMemory, '历史后台重建未追平');
  const state = h.runtime.getState();
  assert.equal(state.lastAutoMemory.mode, 'historical');
  assert.equal(state.lastAutoMemory.processed, 5);
  assert.equal(state.rebuildStatus, 'caughtUp');
  assert.equal(state.rebuildCompletedCount, 5);
  assert.equal(state.rebuildTotalCount, 5);
  assert.equal(h.runtime.shouldBlockMainGeneration(), false, '历史重建完成后必须释放主生成门禁');
  assert.deepEqual(h.calls.map(call => call.systemPrompt), Array.from({ length: 5 }, () => [EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT]).flat());
});

test('重建展示进度按正式 memory/delta 连续前缀逐楼推进，无变化 delta 计数且记忆重算从缺口截断', async () => {
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
  await waitFor(() => h.runtime.getState().rebuildStatus === 'caughtUp');
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
  assert.deepEqual(state.cseFloors.map(item => item.status), ['noChange', 'pending', 'pending']);
  assert.equal(state.rebuildCompletedCount, 1);
  assert.equal(state.rebuildTotalCount, 3);
  assert.equal(state.rebuildNextAssistantSeq, 2);

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

test('历史按钮会话失败后停住且撤销授权；刷新零调用，再次点击继续才从失败楼重试', async () => {
  let failSecond = true;
  const h = harness({
    initialChat: [user('开始'), assistant('历史一'), assistant('历史二'), assistant('历史三'), assistant('待确认尾楼')],
    automation: { enabled: true, batchSize: 2 },
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
  assert.equal(h.runtime.getState().rebuildStatus, 'failed');
  assert.equal(h.runtime.shouldBlockMainGeneration(), false, '历史重建失败后必须立即释放主生成门禁');
  assert.equal(h.runtime.getState().rememberedCount, 1);
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 1, '固定逐楼处理时第一楼的 CSE 已提交');
  const callsAtFailure = h.calls.length;
  await h.runtime.refreshAutomation();
  await h.runtime.refreshStatus();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.calls.length, callsAtFailure, '失败后的检测/刷新不能隐式重试');
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => h.runtime.getState().rebuildStatus === 'caughtUp');
  assert.equal(h.runtime.getState().rememberedCount, 3);
  assert.equal(h.runtime.getState().cseReady, true);
});

test('正文原位编辑即使 locator/swipe 不变也会拦截旧召回，并从最早受影响楼按当前正文重建', async () => {
  const oldText = '裴晚生约定在旧钟楼见面。';
  const newText = '裴晚生决定改去河港会合。';
  const h = harness({
    initialChat: [user('开始'), assistant(oldText), assistant('历史二'), assistant('历史三'), assistant('历史四'), assistant('历史五'), assistant('待确认尾楼'), user('我们去旧钟楼赴约。')],
    automation: { enabled: true, batchSize: 2 },
    utility: options => {
      if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) {
        const content = JSON.parse(options.taskMessages[0].content).payload.canonicalContent;
        return { jsonData: { summary: content, events: [{ title: '会合安排', description: content }] } };
      }
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await h.runtime.start();
  assert.equal(h.calls.length, 0);
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => h.runtime.getState().rebuildStatus === 'caughtUp' && !h.runtime.getState().activeAutoMemory, '六楼历史未完成初始记忆');
  assert.equal(h.runtime.getState().rememberedCount, 6);

  const prompts = [];
  h.context.constants = { promptTypes: { IN_CHAT: 23 }, promptRoles: { SYSTEM: 47 } };
  h.context.setExtensionPrompt = (...args) => prompts.push(args);
  h.context.saveChat = async () => {};
  h.calls.splice(0);

  let guardedReads = 0;
  let guardArmed = false;
  const editedMessage = h.context.chat[1];
  let liveSwipes = editedMessage.swipes;
  const raceRecall = createV3RecallRuntime({
    store: { async readReachable() { guardedReads += 1; return h.store.readReachable(); } },
    hostAdapter: h.hostAdapter,
    isEnabled: true,
    automationSettings: () => ({ enabled: true }),
    memoryStatus: () => h.runtime.getState(),
    sourceReader: async options => {
      const source = await readRecallSource(options);
      if (!guardArmed) {
        guardArmed = true;
        let editQueued = false;
        Object.defineProperty(editedMessage, 'swipes', {
          configurable: true,
          get() {
            if (!editQueued) {
              editQueued = true;
              queueMicrotask(() => { editedMessage.mes = newText; liveSwipes = [newText]; });
            }
            return liveSwipes;
          },
          set(value) { liveSwipes = value; },
        });
      }
      return source;
    },
    sanitizerOptions: () => ({ keepTags: 'content' }),
    now: () => new Date(NOW),
    logger: { warn() {} },
  });
  const lateBlocked = await raceRecall.intercept(h.context.chat, 12000, null, 'normal');
  Object.defineProperty(editedMessage, 'swipes', { configurable: true, enumerable: true, writable: true, value: liveSwipes });
  assert.equal(guardedReads, 2, '必须先通过首次读源并到达最终 prompt commit 前的第二道门禁');
  assert.equal(lateBlocked.lastRecall.status, 'skipped');
  assert.deepEqual(lateBlocked.lastRecall.skipReasons, ['memoryNotReady', 'coverageUnconfirmed']);
  assert.equal(prompts.some(call => call[1]), false, '第二道 coverage 已读 #1 后发生原位编辑，最终同步 guard 必须保持零 prompt');
  assert.doesNotMatch(JSON.stringify(prompts), new RegExp(oldText));

  const earlyRecall = createV3RecallRuntime({
    store: h.store,
    hostAdapter: h.hostAdapter,
    isEnabled: true,
    automationSettings: () => ({ enabled: true }),
    memoryStatus: () => h.runtime.getState(),
    sanitizerOptions: () => ({ keepTags: 'content' }),
    now: () => new Date(NOW),
    logger: { warn() {} },
  });
  const blocked = await earlyRecall.intercept(h.context.chat, 12000, null, 'normal');
  assert.equal(blocked.lastRecall.status, 'skipped');
  assert.deepEqual(blocked.lastRecall.skipReasons, ['memoryNotReady', 'coverageUnconfirmed']);
  assert.equal(prompts.some(call => call[1]), false, '正文指纹不一致时本轮必须零 prompt');
  assert.doesNotMatch(JSON.stringify(prompts), new RegExp(oldText));

  await h.runtime.startHistoricalRebuild();
  await waitFor(() => h.runtime.getState().rebuildStatus === 'caughtUp' && !h.runtime.getState().activeAutoMemory, '正文编辑后未手动重建追平');
  const rebuiltContents = h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).map(call => JSON.parse(call.taskMessages[0].content).payload.canonicalContent);
  assert.equal(rebuiltContents.length, 6);
  assert.equal(rebuiltContents[0], newText, '必须从最早受影响楼使用当前正文重建');
  assert.equal(rebuiltContents.includes(oldText), false);
  const reachable = await h.store.readReachable();
  assert.equal(reachable.floors[0].content.canonicalContent, newText);

  const orderedPrompts = [];
  h.context.setExtensionPrompt = (...args) => orderedPrompts.push(args);
  h.context.chat.at(-1).mes = '我们改去河港会合。';
  let finalRecall;
  let guardedSwipeReads = 0;
  let stableSwipes = editedMessage.swipes;
  Object.defineProperty(editedMessage, 'swipes', {
    configurable: true,
    get() {
      guardedSwipeReads += 1;
      if (guardedSwipeReads === 5) queueMicrotask(() => finalRecall.invalidate('narrativeChanged'));
      return stableSwipes;
    },
    set(value) { stableSwipes = value; },
  });
  finalRecall = createV3RecallRuntime({
    store: h.store,
    hostAdapter: h.hostAdapter,
    isEnabled: true,
    automationSettings: () => ({ enabled: true }),
    memoryStatus: () => h.runtime.getState(),
    sanitizerOptions: () => ({ keepTags: 'content' }),
    now: () => new Date(NOW),
    logger: { warn() {} },
  });
  const afterFinalGuard = await finalRecall.intercept(h.context.chat, 12000, null, 'normal');
  Object.defineProperty(editedMessage, 'swipes', { configurable: true, enumerable: true, writable: true, value: stableSwipes });
  assert.equal(guardedSwipeReads, 6, '两次 coverage 扫描后，最终同步 guard 应直接读取同一正文');
  assert.equal(orderedPrompts.filter(call => call[1]).length, 1, '最终同步 guard 通过后应在同一同步段只提交一次 prompt');
  assert.equal(orderedPrompts.at(-1)[1], '', 'guard 后排入的微任务只能在 prompt 提交后使事件清槽，不能插进提交前');
  assert.equal(afterFinalGuard.recallStatus, 'idle');
});

test('只改一个标点会等待按钮并从该楼重建，旧 FloorMemory/CSE 不再可达且不进入 needsReview', async () => {
  const oldText = '裴晚生约定在钟楼见面';
  const punctuationText = `${oldText}！`;
  const h = harness({
    initialChat: [user('开始'), assistant(oldText), assistant('历史二'), assistant('历史三'), assistant('待确认尾楼')],
    automation: { enabled: true, batchSize: 2 },
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: JSON.parse(options.taskMessages[0].content).payload.canonicalContent } }
      : { jsonData: { noMaterialChange: true } },
  });
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => h.runtime.getState().rebuildStatus === 'caughtUp' && !h.runtime.getState().activeAutoMemory, '标点测试初始历史未追平');
  const before = await h.store.readReachable();
  const oldFloorIds = new Set(before.floors.map(floor => floor.id));
  const oldMemoryIds = new Set(before.floorMemories.map(memory => memory.id));
  const oldDeltaIds = new Set(before.stateDeltas.map(delta => delta.id));
  h.calls.splice(0);

  h.context.chat[1].mes = punctuationText;
  h.context.chat[1].swipes = [punctuationText];
  const foundationState = await h.foundationRuntime.refreshStatus();
  assert.equal(foundationState.status, 'ready');
  assert.equal(foundationState.lastRun.mode, 'branchReplay');
  assert.equal(foundationState.lastRun.result, 'trustedPrefix:0');
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => h.runtime.getState().rebuildStatus === 'caughtUp' && !h.runtime.getState().activeAutoMemory, '标点变化后未手动重建追平');

  const after = await h.store.readReachable();
  assert.equal(after.floors[0].content.canonicalContent, punctuationText);
  assert.equal(after.floors.some(floor => oldFloorIds.has(floor.id)), false);
  assert.equal(after.floorMemories.some(memory => oldMemoryIds.has(memory.id)), false);
  assert.equal(after.stateDeltas.some(delta => oldDeltaIds.has(delta.id)), false);
  assert.equal(h.runtime.getState().floors.some(floor => floor.status === 'needsReview'), false);
  const rebuiltContents = h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).map(call => JSON.parse(call.taskMessages[0].content).payload.canonicalContent);
  assert.equal(rebuiltContents[0], punctuationText);
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
  await waitFor(() => h.runtime.getState().rebuildStatus === 'caughtUp' && !h.runtime.getState().activeAutoMemory, '相同正文测试初始历史未追平');
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

test('分支移除曾被 baseline 复用的角色实体后，重新提取与 CSE 建立新世代闭环', async () => {
  const h = harness({
    initialChat: [user('开始'), assistant('角色第一次出现。'), assistant('确认上一楼稳定。')],
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: '角色出现。', people: [{ name: '角色' }] } }
      : { jsonData: { noMaterialChange: true } },
  });
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => h.runtime.getState().rebuildStatus === 'caughtUp' && !h.runtime.getState().activeAutoMemory, '初始角色基线未建立');
  const before = await h.store.readReachable();
  const oldBaselineId = before.baseline.id;
  const oldCharacterEntityId = before.baseline.characterCard.entityId;
  const oldCharacter = before.entities.find(entity => entity.id === oldCharacterEntityId);
  assert.equal(oldCharacter.firstSeenFloorId, before.floors[0].id, '前置条件：角色 baseline 应复用首楼提取实体');

  h.context.chat[1].mes = '角色在修改后的分支再次出现。';
  h.context.chat[1].swipes = [h.context.chat[1].mes];
  await h.foundationRuntime.refreshStatus();
  const branched = await h.store.readReachable();
  assert.equal(branched.baseline, null, '移除首次出现楼后不得继续引用旧 baseline');
  assert.equal(branched.entities.some(entity => entity.id === oldCharacterEntityId), false);

  await h.runtime.startHistoricalRebuild();
  await waitFor(() => h.runtime.getState().rebuildStatus === 'caughtUp' && !h.runtime.getState().activeAutoMemory, '新分支记忆与 CSE 未追平');
  const after = await h.store.readReachable();
  assert.notEqual(after.baseline.id, oldBaselineId);
  assert.notEqual(after.baseline.characterCard.entityId, oldCharacterEntityId);
  assert.equal(after.root.capabilities.cseReady, true);
  const reachableFloorIds = new Set(after.floors.map(floor => floor.id));
  assert.equal(after.entities.every(entity => entity.firstSeenFloorId === null || reachableFloorIds.has(entity.firstSeenFloorId)), true, '新图不得留下悬空 firstSeen');
  assert.ok(after.entities.some(entity => entity.id === after.baseline.characterCard.entityId));
});

test('同楼只修隐藏时间戳时会标记旧时间过期，重提后用新戳更新 chronology 并传入 CSE', async () => {
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
  assert.equal(floor.metadataStale, true);
  assert.match(floor.error, /时间戳已变化/);
  await h.runtime.extractFloor(floor.floorId, { analyzeState: false });
  state = h.runtime.getState(); floor = state.floors[0];
  assert.equal(floor.metadataStale, false);
  assert.match(floor.memory.chronology[0].time.sourceText, /18:10.*18:40/);
  assert.doesNotMatch(floor.memory.chronology[0].time.sourceText, /15:30/);
  const cseCallsBeforeRetry = cseInputs.length;
  await h.runtime.retryStateAnalysis(floor.floorId);
  state = h.runtime.getState(); floor = state.floors[0];
  assert.equal(cseInputs.length, cseCallsBeforeRetry + 1, '新时间戳重提后必须真正再调用一次 CSE');
  assert.match(JSON.stringify(cseInputs.at(-1)), /18:10.*18:40/);
  assert.doesNotMatch(JSON.stringify(cseInputs.at(-1)), /15:30.*16:00/);
  assert.equal(floor.cse.status, 'noChange');
  assert.equal(state.lastCseError, null);
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

test('稳定楼或未知范围 swipe 仍会取消在途 CSE 并阻止迟到写入', async () => {
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
    if (scenario === 'stableFloor') h.emit('MESSAGE_SWIPED', 1, { pendingGeneration: false });
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
    assert.equal(cseSignal?.aborted, true, `${scenario} 必须中止旧 CSE`);
    releaseCse();
    await analysis;
    const after = await h.store.readReachable({ mode: 'runtime' });
    assert.equal(after.stateDeltas.length, 0, '取消后的迟到 CSE 不得写入');
  }
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

test('时间、地点、人物与摘要一次保存，保留原有 ID/证据并让旧 CSE 失效，新 runtime 回读一致', async () => {
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
  assert.equal(floor.cse.status, 'pending');

  const reloaded = harness({ sharedBackend: backend, sharedContext: h.context, utility: () => { throw new Error('回读不应调用 AI'); } });
  await reloaded.runtime.start();
  const restored = reloaded.runtime.getState().floors[0].memory;
  assert.equal(restored.id, memory.id); assert.equal(restored.summary.userText, '修订后摘要');
  assert.deepEqual(restored.chronology.map(item => item.itemId), memory.chronology.map(item => item.itemId));
  assert.deepEqual(restored.locations.map(item => item.name), ['旧钟楼', '河港']);
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
  let card = ui.flatten(ui.container).find(node => String(node.className).includes('qqj-memory-card')); card.open = true; card.fire('toggle');
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
  card = ui.flatten(ui.container).find(node => String(node.className).includes('qqj-memory-card'));
  assert.equal(card.open, true); assert.match(ui.flatten(card).map(node => node.textContent).join('|'), /真实保存后的摘要/);
  assert.equal(ui.flatten(ui.container).some(node => node.textContent === '保存中…'), false);
  ui.view.deactivate(); await ui.view.activate();
  assert.equal(ui.flatten(ui.container).find(node => String(node.className).includes('qqj-memory-card')).open, true, '保存完成后再关闭重开仍应保持展开');
  assert.equal(ui.flatten(ui.container).some(node => node.placeholder === '输入用户修订摘要'), false);

  card = ui.flatten(ui.container).find(node => String(node.className).includes('qqj-memory-card')); card.open = true; card.fire('toggle');
  ui.flatten(ui.container).find(node => node.textContent === '编辑').click();
  const secondSummary = ui.flatten(ui.container).find(node => node.placeholder === '输入用户修订摘要'); secondSummary.value = '面板关闭期间完成的摘要'; secondSummary.fire('input');
  const inactiveGate = h.backend.holdNextRootPut();
  ui.flatten(ui.container).find(node => node.textContent === '保存').click();
  await inactiveGate.started;
  ui.view.deactivate(); inactiveGate.release();
  await waitFor(() => !h.runtime.getState().memoryWorkBusy, '面板关闭期间后台保存未完成');
  await ui.view.activate();
  card = ui.flatten(ui.container).find(node => String(node.className).includes('qqj-memory-card'));
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
  const oldChat = harness({
    initialChat: [user('开始'), assistant('刷新前已有回复'), assistant('用于确认旧回复稳定')],
    automation: { enabled: true, batchSize: 2 },
  });
  await oldChat.runtime.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(oldChat.runtime.getState().stableCount, 1);
  assert.equal(oldChat.runtime.getState().rebuildStatus, 'pendingRebuild');
  assert.equal(oldChat.runtime.allowsRealtimeTailFromEmpty(), false);
  assert.equal(oldChat.calls.length, 0);
});

test('编辑 branchReplay 与同正文 swipe 来源变化都清除实时证明，不追加 API', async () => {
  for (const scenario of ['edit', 'swipe']) {
    const h = harness({
      initialChat: [user('开始'), assistant('开场白')],
      automation: { enabled: true, batchSize: 2 },
    });
    await h.runtime.start();
    h.context.chat.push(assistant('第一条新增回复'));
    h.emit('MESSAGE_RECEIVED');
    await waitFor(() => h.runtime.getState().lastAutoMemory?.status === 'completed');
    const callsBeforeMutation = h.calls.length;
    assert.equal(h.foundationRuntime.getState().headCheckpointId, h.runtime.getState().headCheckpointId, JSON.stringify({ foundation: h.foundationRuntime.getState(), memory: h.runtime.getState().headCheckpointId }));
    if (scenario === 'edit') {
      h.context.chat[1] = assistant('开场白已编辑');
      h.emit('MESSAGE_EDITED', 1);
    } else {
      h.context.chat[1] = { ...assistant('开场白'), swipes: ['开场白', '开场白'], swipe_id: 1 };
      h.emit('MESSAGE_SWIPED', 1);
    }
    await h.foundationRuntime.refreshStatus();
    await waitFor(() => h.foundationRuntime.getState().lastRun?.mode === (scenario === 'edit' ? 'branchReplay' : 'incremental'));
    await h.runtime.refreshStatus();
    const reachable = await h.store.readReachable({ mode: 'runtime' });
    assert.equal(Object.hasOwn(reachable.run?.diagnostics ?? {}, 'realtimeOriginV1'), false, JSON.stringify({ scenario, foundation: h.foundationRuntime.getState(), stored: { revision: reachable.rootRevision, head: reachable.root.headCheckpointId, runMode: reachable.run?.mode, runStatus: reachable.run?.phase } }));
    assert.equal(h.runtime.allowsRealtimeTailFromEmpty(), false);
    assert.ok(['pendingRebuild', 'notReady'].includes(h.runtime.getState().rebuildStatus));
    assert.equal(h.calls.length, callsBeforeMutation);
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
  const h = harness({ initialChat: [user('开始'), assistant('开场白')], automation: { enabled: true, batchSize: 2 } });
  await h.runtime.start();
  h.context.chat.push(assistant('第一条新增回复'));
  h.emit('MESSAGE_RECEIVED');
  await waitFor(() => h.runtime.getState().lastAutoMemory?.status === 'completed');
  const callsBeforeSwitch = h.calls.length;
  h.context.chatMetadata = { qianqianjie: { schemaVersion: 1, chatId: otherChat } };
  h.context.chatId = 'host-other-chat';
  h.context.chat = [user('开始'), assistant('别的聊天旧楼'), assistant('别的聊天尾楼')];
  h.emit('CHAT_CHANGED');
  await waitFor(() => h.runtime.getState().chatId === otherChat && h.runtime.getState().stableCount === 1 && h.runtime.getState().rebuildStatus === 'pendingRebuild');
  assert.equal(h.runtime.allowsRealtimeTailFromEmpty(), false);
  assert.equal(h.runtime.getState().rebuildStatus, 'pendingRebuild');
  assert.equal(h.calls.length, callsBeforeSwitch);
});

test('fresh chat 关闭自动维护时仍记录实时起点，但新增稳定楼零记忆 API', async () => {
  const h = harness({
    initialChat: [user('开始'), assistant('开场白')],
    automation: { enabled: false, batchSize: 2 },
  });
  await h.runtime.start();
  assert.equal(h.runtime.allowsRealtimeTailFromEmpty(), true);
  h.context.chat.push(assistant('自动维护关闭后的新增回复'));
  h.emit('MESSAGE_RECEIVED');
  await waitFor(() => {
    const state = h.runtime.getState();
    return state.stableCount === 1 && state.rebuildStatus === 'waitingRealtime' && state.lastAutoMemory === null;
  }, '关闭自动维护后未收敛到实时等待终态');
  assert.equal(h.runtime.getState().rebuildStatus, 'waitingRealtime');
  assert.equal(h.calls.length, 0);
  assert.equal(h.runtime.shouldBlockMainGeneration(), false);
});

test('runtime 的缺失或非法批次兜底为 1，首个稳定楼即可正常完成', async () => {
  for (const batchSize of [undefined, 0, 21, 1.5, 'bad']) {
    const h = harness({
      initialChat: [user('开始'), assistant('开场白')],
      automation: { enabled: true, batchSize },
      utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
        ? { jsonData: { summary: '默认一楼摘要' } }
        : { jsonData: { noMaterialChange: true } },
    });
    await h.runtime.start();
    assert.equal(h.runtime.getState().autoMemoryBatchSize, 1);
    h.context.chat.push(assistant('新增回复'));
    h.emit('MESSAGE_RECEIVED');
    await waitFor(() => h.runtime.getState().lastAutoMemory?.status === 'completed');
    assert.equal(h.runtime.getState().rememberedCount, 1);
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
  await waitFor(() => h.runtime.getState().lastAutoMemory?.status === 'failed' && !h.runtime.getState().memoryWorkBusy);
  let state = h.runtime.getState();
  assert.equal(state.rememberedCount, 2, 'CSE 失败前摘要必须已经保存');
  assert.equal(state.rebuildCompletedCount, 1);
  assert.equal(state.summaryCompletedCount, 2);
  assert.equal(h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, 1);
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 1);
  assert.equal(notifications.filter(item => item.kind === 'warning').length, 1);
  assert.match(notifications.at(-1).text, /已保存新楼摘要.*人物状态分析失败.*后续.*有限重试/);

  h.context.chat.push(assistant('第三条实时回复。'));
  h.emit('MESSAGE_RECEIVED');
  await waitFor(() => h.runtime.getState().lastAutoMemory?.status === 'failed' && h.runtime.getState().rememberedCount === 3 && !h.runtime.getState().memoryWorkBusy);
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
  await waitFor(() => h.runtime.getState().rebuildStatus === 'caughtUp' && !h.runtime.getState().memoryWorkBusy);
  state = h.runtime.getState();
  assert.equal(state.rebuildCompletedCount, 3);
  assert.equal(h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, extractorCallsBeforeContinue, '手动继续不得重提已保存摘要');
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 5, '手动继续只按顺序补两处人物状态');
});

test('启动自动维护会在无新楼时按固定边界追完已有摘要的 CSE，普通刷新不重复失败输入', async () => {
  const initial = harness({
    initialChat: [user('开始'), assistant('第0楼'), assistant('第2楼'), assistant('第4楼'), assistant('稳定尾楼')],
    automation: { enabled: false, batchSize: 1 },
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: `摘要-${JSON.parse(options.taskMessages[0].content).payload.canonicalContent}` } }
      : { jsonData: { noMaterialChange: true } },
  });
  await initial.runtime.start();
  await initial.runtime.startHistoricalRebuild();
  await waitFor(() => initial.runtime.getState().rebuildStatus === 'caughtUp');
  const secondFloor = initial.runtime.getState().floors[1];
  await initial.runtime.editSummary(secondFloor.floorId, '用户修订但仍是有效摘要');
  assert.equal(initial.runtime.getState().summaryCompletedCount, 3);
  assert.equal(initial.runtime.getState().rebuildCompletedCount, 1);

  const notifications = [];
  const resumed = harness({
    automation: { enabled: true, batchSize: 1 }, sharedBackend: initial.backend, sharedContext: initial.context,
    notifyUser: value => notifications.push(value),
    utility: options => {
      assert.equal(options.systemPrompt, CSE_SYSTEM_PROMPT, '已有摘要的追赶不得重新调用 extractor');
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await resumed.runtime.start();
  await waitFor(() => resumed.runtime.getState().rebuildStatus === 'caughtUp' && !resumed.runtime.getState().memoryWorkBusy);
  assert.deepEqual(resumed.calls.map(call => call.systemPrompt), [CSE_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT]);
  assert.equal(resumed.runtime.getState().lastAutoMemory.cseProcessed, 2);
  assert.equal(resumed.runtime.getState().lastAutoMemory.processed, 0);
  assert.match(notifications.at(-1).text, /新增摘要 0 楼，补齐人物状态 2 楼/);

  await resumed.runtime.editSummary(secondFloor.floorId, '再次修订以制造人物状态缺口');
  let failedCalls = 0;
  let failCatchup = true;
  const failed = harness({
    automation: { enabled: true, batchSize: 1 }, sharedBackend: initial.backend, sharedContext: initial.context,
    notifyUser: value => notifications.push(value),
    utility: options => { failedCalls += 1; assert.equal(options.systemPrompt, CSE_SYSTEM_PROMPT); if (failCatchup) throw new Error('模拟追赶失败'); return { jsonData: { noMaterialChange: true } }; },
  });
  await failed.runtime.start();
  await waitFor(() => failed.runtime.getState().lastAutoMemory?.status === 'failed' && !failed.runtime.getState().memoryWorkBusy);
  assert.equal(failedCalls, 1);
  assert.match(notifications.at(-1).text, /人物状态追赶失败/);
  await failed.runtime.refreshStatus();
  await failed.runtime.refreshAutomation();
  assert.equal(failedCalls, 1, '相同失败输入的刷新与自动设置同步不得重复调用 CSE');
  assert.equal(failed.runtime.getState().lastAutoMemory.status, 'failed', '失败状态与继续入口不得被重复调度覆盖成 waiting');
  failCatchup = false;
  await failed.runtime.retryAutomation();
  await waitFor(() => failed.runtime.getState().rebuildStatus === 'caughtUp' && !failed.runtime.getState().memoryWorkBusy);
  assert.equal(failedCalls, 3, '手动继续应从最早缺口恢复并顺序补完两楼');
});

test('完全重构用新 root 切断旧派生图，同一模型输出仍重新逐楼生成且不会撞旧不可变记录', async () => {
  const h = harness({
    initialChat: [user('开始'), assistant('第一楼'), assistant('第二楼'), assistant('待确认尾楼')],
    automation: { enabled: true, batchSize: 20 },
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: `摘要-${JSON.parse(options.taskMessages[0].content).payload.canonicalContent}`, people: [{ name: '路人甲' }] } }
      : { jsonData: { noMaterialChange: true } },
  });
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => h.runtime.getState().rebuildStatus === 'caughtUp' && !h.runtime.getState().activeAutoMemory);
  const before = h.runtime.getState();
  const oldHead = before.headCheckpointId;
  const oldMemoryIds = before.floors.map(floor => floor.memoryId);
  const oldNpcId = before.memoryEntities.find(entity => entity.displayName === '路人甲')?.entityId;
  h.calls.splice(0);
  await h.runtime.fullRebuild();
  await waitFor(() => h.runtime.getState().rebuildStatus === 'caughtUp' && !h.runtime.getState().activeAutoMemory);
  const after = h.runtime.getState();
  assert.notEqual(after.headCheckpointId, oldHead);
  assert.equal(after.autoMemoryBatchSize, 1);
  assert.equal(after.rememberedCount, 2);
  assert.equal(after.cseReady, true);
  assert.equal(h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, 2);
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 2);
  assert.ok(after.floors.every((floor, index) => floor.memoryId !== oldMemoryIds[index]));
  assert.notEqual(after.memoryEntities.find(entity => entity.displayName === '路人甲')?.entityId, oldNpcId);
});

test('完全重构占用现有主生成门禁，GENERATION_STARTED 抢入会取消 root 切换', async () => {
  const h = harness({ initialChat: [user('开始'), assistant('第一楼'), assistant('待确认尾楼')], automation: { enabled: true, batchSize: 1 } });
  await h.runtime.start();
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => h.runtime.getState().rebuildStatus === 'caughtUp' && !h.runtime.getState().activeAutoMemory);
  const oldHead = h.runtime.getState().headCheckpointId;
  const gate = h.backend.holdNextRootPut();
  const rebuilding = h.runtime.fullRebuild();
  assert.equal(h.runtime.shouldBlockMainGeneration(), true, '点击完全重构后应同步占用已有主生成门禁');
  await gate.started;
  h.emit('GENERATION_STARTED', 'normal');
  assert.equal(h.runtime.shouldBlockMainGeneration(), true, '重构取消收拢前门禁仍应保持');
  gate.release();
  await assert.rejects(rebuilding, error => error?.name === 'AbortError' || error?.code === 'V3_MEMORY_STALE');
  assert.equal(h.runtime.getState().headCheckpointId, oldHead, '主生成抢入后不得切换 root head');
  assert.equal(h.runtime.shouldBlockMainGeneration(), false);
  h.emit('GENERATION_ENDED');
});

test('完全重构 CAS 冲突保留旧有效图，预备图只保留 baseline 人物并重建必要索引', async () => {
  const h = harness({ initialChat: [user('开始'), assistant('第一楼'), assistant('待确认尾楼')], automation: { enabled: true, batchSize: 1 } });
  await h.runtime.start(); await h.runtime.startHistoricalRebuild();
  await waitFor(() => h.runtime.getState().rebuildStatus === 'caughtUp' && !h.runtime.getState().activeAutoMemory);
  const before = await h.store.readReachable({ mode: 'runtime' });
  h.backend.setConflictRoot(true);
  await assert.rejects(h.runtime.fullRebuild(), error => error?.code === 'V3_MEMORY_CAS_CONFLICT');
  h.backend.setConflictRoot(false);
  const after = await h.store.readReachable({ mode: 'runtime' });
  assert.equal(after.root.headCheckpointId, before.root.headCheckpointId);
  assert.deepEqual(after.floorMemories.map(item => item.id), before.floorMemories.map(item => item.id));
  const stagedRun = [...h.backend.records.values()].map(value => value.data).find(record => record?.recordType === 'run' && record?.diagnostics?.kind === 'fullRebuild');
  const stagedCheckpoint = [...h.backend.records.values()].map(value => value.data).find(record => record?.recordType === 'checkpoint' && record?.runId === stagedRun?.id);
  assert.ok(stagedRun && stagedCheckpoint);
  assert.deepEqual(new Set(stagedCheckpoint.producedRefs.entities), new Set([before.baseline.userPersona.entityId, before.baseline.characterCard.entityId]));
  assert.deepEqual(stagedCheckpoint.producedRefs.floorMemories, []);
  assert.deepEqual(stagedCheckpoint.producedRefs.stateDeltas, []);
  assert.deepEqual(stagedCheckpoint.producedRefs.currentStates, []);
  const indexKinds = stagedCheckpoint.producedRefs.indexes.map(key => h.backend.records.get(`chat-${CHAT}/${key}`)?.data?.kind);
  for (const kind of ['floorOrder', 'fingerprint', 'reverseRef', 'entity']) assert.ok(indexKinds.includes(kind), `reset 应重建 ${kind} index`);
});

test('完全重构前置 refresh 等待时切聊天不会重置任一聊天或在新聊天启动提取', async () => {
  let armed = false, releaseRefresh, markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const h = harness({
    initialChat: [user('开始'), assistant('第一楼'), assistant('待确认尾楼')], automation: { enabled: true, batchSize: 1 },
    foundationRefresh: async base => { if (armed) { armed = false; markStarted(); await new Promise(resolve => { releaseRefresh = resolve; }); } return base.refreshStatus(); },
  });
  await h.runtime.start(); await h.runtime.startHistoricalRebuild();
  await waitFor(() => h.runtime.getState().rebuildStatus === 'caughtUp' && !h.runtime.getState().activeAutoMemory);
  const oldRoot = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-root`).data);
  h.calls.splice(0); armed = true;
  const rebuilding = h.runtime.fullRebuild(); await started;
  const otherChat = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  h.context.chatMetadata = { qianqianjie: { schemaVersion: 1, chatId: otherChat } }; h.context.chatId = 'host-other'; h.context.chat = [user('新聊天'), assistant('新楼'), assistant('尾楼')]; h.emit('CHAT_CHANGED');
  releaseRefresh();
  await assert.rejects(rebuilding, error => error?.code === 'V3_MEMORY_STALE');
  assert.equal(h.backend.records.get(`chat-${CHAT}/v3-root`).data.headCheckpointId, oldRoot.headCheckpointId);
  assert.equal([...h.backend.records.entries()].some(([key, value]) => key.startsWith(`chat-${otherChat}/`) && value.data?.diagnostics?.kind === 'fullRebuild'), false);
  assert.equal(h.calls.length, 0);
});

test('完全重构提交旧聊天 root 后尾部切聊天不会在新聊天自动续建', async () => {
  let armed = false, refreshCount = 0, releaseRefresh, markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const h = harness({
    initialChat: [user('开始'), assistant('第一楼'), assistant('待确认尾楼')], automation: { enabled: true, batchSize: 1 },
    foundationRefresh: async base => { if (armed && ++refreshCount === 2) { markStarted(); await new Promise(resolve => { releaseRefresh = resolve; }); } return base.refreshStatus(); },
  });
  await h.runtime.start(); await h.runtime.startHistoricalRebuild();
  await waitFor(() => h.runtime.getState().rebuildStatus === 'caughtUp' && !h.runtime.getState().activeAutoMemory);
  const oldHead = h.backend.records.get(`chat-${CHAT}/v3-root`).data.headCheckpointId;
  h.calls.splice(0); armed = true;
  const rebuilding = h.runtime.fullRebuild(); await started;
  assert.notEqual(h.backend.records.get(`chat-${CHAT}/v3-root`).data.headCheckpointId, oldHead, '第二次 refresh 前 reset root 已提交');
  const otherChat = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  h.context.chatMetadata = { qianqianjie: { schemaVersion: 1, chatId: otherChat } }; h.context.chatId = 'host-other'; h.context.chat = [user('新聊天'), assistant('新楼'), assistant('尾楼')]; h.emit('CHAT_CHANGED');
  releaseRefresh(); await rebuilding;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal([...h.backend.records.entries()].some(([key, value]) => key.startsWith(`chat-${otherChat}/`) && value.data?.diagnostics?.kind === 'fullRebuild'), false);
  assert.equal(h.calls.length, 0, '旧聊天 reset 提交后不得对新聊天调用 Extractor/CSE');
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
  assert.deepEqual(notifications, [{ kind: 'warning', text: '主模型正在生成，请等待完成后再开始重建。' }]);

  h.emit('GENERATION_STOPPED');
  h.emit('GENERATION_ENDED');
  h.emit('GENERATION_ENDED');
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => h.runtime.getState().rebuildStatus === 'caughtUp' && !h.runtime.getState().activeAutoMemory);
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
  await waitFor(() => h.runtime.getState().rebuildStatus === 'caughtUp' && !h.runtime.getState().activeAutoMemory);

  assert.equal(h.runtime.getState().rememberedCount, 2);
  assert.deepEqual(h.calls.map(call => call.systemPrompt), [EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT, EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT]);
  assert.deepEqual(notifications, [{ kind: 'success', text: '千千结已完成历史记忆维护：新增摘要 2 楼，补齐人物状态 2 楼。' }]);
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
    await waitFor(() => h.runtime.getState().rebuildStatus === 'caughtUp' && !h.runtime.getState().activeAutoMemory, `${order} 后生成门禁未释放`);
    assert.equal(h.runtime.getState().rememberedCount, 2);
  }
});

test('首个流式正文提前固定上一楼，重复 token 与 ENDED→RECEIVED 不重复摘要或 CSE', async () => {
  const h = harness({
    initialChat: [assistant('上一楼正文')],
    automation: { enabled: true, batchSize: 1 },
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: '上一楼摘要' } }
      : { jsonData: { noMaterialChange: true } },
  });
  await h.runtime.start();
  const putsBeforeStart = h.backend.calls.filter(call => call[0] === 'put').length;
  h.context.chat.push(user('继续'));
  h.emit('GENERATION_STARTED', 'normal', {}, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 0, 'STARTED 只能武装，不能调用模型');
  assert.equal(h.backend.calls.filter(call => call[0] === 'put').length, putsBeforeStart, 'STARTED 不能写地基');

  h.context.chat.push(assistant(''));
  h.emit('STREAM_TOKEN_RECEIVED', '当前楼首字');
  await waitFor(() => h.runtime.getState().rememberedCount === 1 && !h.runtime.getState().activeAutoMemory, '首 token 后上一楼未在 final 前完成');
  assert.deepEqual(h.calls.map(call => call.systemPrompt), [EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT]);
  assert.equal(h.foundationRuntime.getReachable().floors[0].content.canonicalContent, '上一楼正文');
  assert.equal(h.foundationRuntime.getReachable().floors.some(floor => floor.hostLocator.messageIndex === 2), false, '空生成槽不得落 FloorRecord');

  h.emit('STREAM_TOKEN_RECEIVED', '当前楼更多正文');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.calls.length, 2, '重复 token 不得重复逻辑任务');
  h.emit('GENERATION_ENDED');
  h.context.chat[2] = assistant('当前楼完整正文');
  h.emit('MESSAGE_RECEIVED', 2, 'continue');
  await waitFor(() => h.foundationRuntime.getState().pending?.assistantSeq === 2, 'final 后当前楼未进入正常 pending');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.calls.length, 2, '同次 final 不得取消后重跑上一楼任务');
});

test('不同槽或 first_message 的 MESSAGE_RECEIVED 不冒充已武装 normal final', async () => {
  let releaseExtractor, markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const h = harness({
    initialChat: [assistant('上一楼正文')],
    automation: { enabled: true, batchSize: 1 },
    utility: options => {
      if (options.systemPrompt !== EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { noMaterialChange: true } };
      markStarted();
      return new Promise(resolve => { releaseExtractor = () => resolve({ jsonData: { summary: '不应提交的迟到摘要' } }); });
    },
  });
  await h.runtime.start();
  h.context.chat.push(user('继续'));
  h.emit('GENERATION_STARTED', 'normal');
  h.context.chat.push(assistant(''));
  h.emit('STREAM_TOKEN_RECEIVED', '当前楼首字');
  await started;
  h.emit('MESSAGE_RECEIVED', 0, 'first_message');
  releaseExtractor();
  await waitFor(() => !h.runtime.getState().activeAutoMemory && !h.runtime.getState().activeExtraction);
  assert.equal(h.runtime.getState().rememberedCount, 0, '无关 MESSAGE_RECEIVED 必须走原取消路径，迟到摘要不得提交');
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
    const h = harness({ initialChat: [assistant('上一楼正文')], automation: { enabled: true, batchSize: 1 } });
    await h.runtime.start();
    h.context.chat.push(user('继续'));
    h.emit('GENERATION_STARTED', type, {}, dryRun);
    if (nested) h.emit('GENERATION_STARTED', 'normal', {}, false);
    h.context.chat.push(assistant(''));
    h.emit('STREAM_TOKEN_RECEIVED', '正文');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(h.calls.length, 0, `${type}/${dryRun ? 'dry' : nested ? 'nested' : 'direct'} 不得提前调用`);
  }

  const stopped = harness({ initialChat: [assistant('上一楼正文')], automation: { enabled: true, batchSize: 1 } });
  await stopped.runtime.start();
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
    const h = harness({ initialChat: [assistant('上一楼正文')], automation: { enabled: true, batchSize: 1 } });
    await h.runtime.start();
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
  const h = harness({ initialChat: [assistant('上一楼正文')], automation: { enabled: true, batchSize: 1 } });
  await h.runtime.start();
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
  assert.equal(h.backend.records.has(`chat-${CHAT}/v3-root`), false, '中止后的 early root 不得迟到提交');
  assert.equal(h.calls.length, 0);
});

test('Luker MESSAGE_UPDATED 只认启动后新 assistant 槽，非流式 final 保留安全回退', async () => {
  const utility = options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
    ? { jsonData: { summary: '上一楼摘要' } }
    : { jsonData: { noMaterialChange: true } };
  const takeover = harness({ initialChat: [assistant('上一楼正文')], host: 'luker', automation: { enabled: true, batchSize: 1 }, utility });
  await takeover.runtime.start();
  takeover.context.chat.push(user('继续'));
  takeover.emit('GENERATION_STARTED', 'normal');
  takeover.emit('MESSAGE_UPDATED', 0);
  takeover.context.chat.push(assistant('...'));
  takeover.emit('MESSAGE_UPDATED', 2);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(takeover.calls.length, 0, '旧槽更新与占位均不得触发');
  takeover.context.chat[2].mes = 'takeover 首段';
  takeover.emit('MESSAGE_UPDATED', 2);
  await waitFor(() => takeover.runtime.getState().rememberedCount === 1 && !takeover.runtime.getState().activeAutoMemory);
  assert.deepEqual(takeover.calls.map(call => call.systemPrompt), [EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT]);

  const nonstream = harness({ initialChat: [assistant('非流式上一楼')], automation: { enabled: true, batchSize: 1 }, utility });
  await nonstream.runtime.start();
  nonstream.context.chat.push(user('继续'));
  nonstream.emit('GENERATION_STARTED', 'normal');
  nonstream.context.chat.push(assistant('非流式当前楼'));
  nonstream.emit('GENERATION_ENDED');
  nonstream.emit('MESSAGE_RECEIVED', 2);
  await waitFor(() => nonstream.runtime.getState().rememberedCount === 1 && !nonstream.runtime.getState().activeAutoMemory, '非流式 final 未走原回退');
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
    await waitFor(() => h.runtime.getState().rebuildStatus === 'caughtUp' && !h.runtime.getState().activeAutoMemory);

    assert.equal(h.runtime.getState().rememberedCount, 2);
    assert.deepEqual(h.calls.map(call => call.systemPrompt), [EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT, EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT]);
    assert.deepEqual(notifications, [{ kind: 'success', text: '千千结已完成历史记忆维护：新增摘要 2 楼，补齐人物状态 2 楼。' }]);
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
  assert.deepEqual(notifications, [{ kind: 'warning', text: '主模型正在生成，请等待完成后再开始重建。' }]);

  mainGenerating = false;
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => h.runtime.getState().rebuildStatus === 'caughtUp');
  assert.equal(h.runtime.getState().rememberedCount, 2);
  assert.equal(h.runtime.shouldBlockMainGeneration(), false);
});

test('切聊天与正文编辑/删除/swipe 事件都会同步撤销旧历史维护门禁', async () => {
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
    h.emit(eventName);
    assert.equal(h.runtime.shouldBlockMainGeneration(), false, `${eventName} 必须同步撤销旧门禁`);
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
  await waitFor(() => h.runtime.getState().rebuildStatus === 'caughtUp' && !h.runtime.getState().activeAutoMemory, '手动继续后未从持久事实恢复');
  assert.equal(h.runtime.getState().rememberedCount, 3);
  assert.equal(h.runtime.getState().cseReady, true);
});

test('按钮启动的历史会话可暂停；刷新后的新 runtime 不自动续跑，继续按钮从持久进度恢复', async () => {
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
  assert.equal(first.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 1, '已提交第一楼在固定逐楼模式下也已提交 CSE');
  first.runtime.invalidate();

  const second = harness({
    automation: { enabled: true, batchSize: 2 },
    sharedBackend: first.backend,
    sharedContext: first.context,
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: `续建-${JSON.parse(options.taskMessages[0].content).payload.canonicalContent}` } }
      : { jsonData: { noMaterialChange: true } },
  });
  await second.runtime.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(second.calls.length, 0, '刷新/新 runtime 只恢复进度，不恢复授权');
  assert.equal(second.runtime.getState().rebuildStatus, 'waitingRealtime');
  assert.equal(second.runtime.getState().rememberedCount, 1);
  await second.runtime.startHistoricalRebuild();
  await waitFor(() => second.runtime.getState().rebuildStatus === 'caughtUp');
  assert.equal(second.runtime.getState().rememberedCount, 3);
  assert.equal(second.runtime.getState().cseReady, true);
  assert.equal(second.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, 2, '继续时不得重复提取已落盘第一楼');
});

test('自动 reconciling、extracting、CSE 全程共用一个门闩，手动入口不并发且逐楼完成后恢复', async () => {
  let holdFoundation = false, releaseFoundation, foundationStartedResolve;
  let holdExtractor = false, holdCse = false;
  let releaseExtractor, extractorStartedResolve;
  let releaseCse, cseStartedResolve;
  const foundationStarted = new Promise(resolve => { foundationStartedResolve = resolve; });
  const extractorStarted = new Promise(resolve => { extractorStartedResolve = resolve; });
  const cseStarted = new Promise(resolve => { cseStartedResolve = resolve; });
  const h = harness({
    automation: { enabled: false, batchSize: 2 },
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
  h.context.chat.push(assistant('新尾楼让上一楼稳定。'));
  h.emit('MESSAGE_RECEIVED');
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
  assert.equal(h.runtime.getState().activeAutoMemory.phase, 'analyzingCse');
  assert.equal(h.runtime.shouldBlockMainGeneration(), false, '日常自动 CSE 不得阻断主生成');
  const callsDuringCse = h.calls.length;
  await Promise.all([h.runtime.extractNext(), h.runtime.retryStateAnalysis(firstFloorId)]);
  assert.equal(h.calls.length, callsDuringCse, 'CSE 期间手动入口不得形成第二条 API 链');
  releaseCse();
  await waitFor(() => h.runtime.getState().lastAutoMemory?.status === 'completed' && !h.runtime.getState().memoryWorkBusy);

  const callsAfterBatch = h.calls.length;
  await h.runtime.extractFloor(firstFloorId);
  assert.equal(h.calls.length, callsAfterBatch + 1, '批次完成后手动入口应恢复可用');
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

test('生产 user 锚在 MESSAGE_SENT 后立即提取前一 AI，重复事件不重复调用且关闭自动维护时零 API', async () => {
  const h = harness({
    initialChat: [assistant('AI0 等待用户锚。')],
    modernAnchors: true,
    automation: { enabled: true, batchSize: 1 },
  });
  await h.runtime.start();
  assert.equal(h.foundationRuntime.getState().stableCount, 0);
  assert.equal(h.calls.length, 0);

  h.context.chat.push({ ...user('U1 正式入列。'), send_date: 'anchor-u1' });
  h.emit('MESSAGE_SENT', 1);
  await waitFor(() => h.runtime.getState().rememberedCount === 1 && h.runtime.getState().cseReady, 'user 锚入列后未及时完成前一 AI 的摘要与 CSE');
  const callsAfterFirst = h.calls.length;
  assert.equal(callsAfterFirst, 2);
  h.emit('MESSAGE_SENT', 1);
  h.emit('USER_MESSAGE_RENDERED', 1);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.calls.length, callsAfterFirst, '重复 sent/rendered 事件不得重复摘要或 CSE');

  const disabled = harness({
    initialChat: [assistant('关闭自动维护的 AI0。')],
    modernAnchors: true,
    automation: { enabled: false, batchSize: 1 },
  });
  await disabled.runtime.start();
  disabled.context.chat.push({ ...user('U1'), send_date: 'disabled-anchor' });
  disabled.emit('MESSAGE_SENT', 1);
  await waitFor(() => disabled.foundationRuntime.getState().stableCount === 1, '关闭自动维护时地基仍应接受 user 锚');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(disabled.calls.length, 0);
});

test('user 锚删除会撤回活动链并使在途摘要失效；重加新锚必须重新提取', async () => {
  let releaseExtraction;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let extractorCalls = 0;
  const h = harness({
    initialChat: [assistant('需要稳定的 AI0。')],
    modernAnchors: true,
    automation: { enabled: true, batchSize: 1 },
    utility: options => {
      if (options.systemPrompt !== EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { noMaterialChange: true } };
      extractorCalls += 1;
      if (extractorCalls === 1) {
        markStarted();
        return new Promise(resolve => { releaseExtraction = () => resolve({ jsonData: { summary: '不应落库的迟到摘要。' } }); });
      }
      return { jsonData: { summary: '新锚后的摘要。' } };
    },
  });
  await h.runtime.start();
  h.context.chat.push({ ...user('第一次 U1'), send_date: 'anchor-first' });
  h.emit('MESSAGE_SENT', 1);
  await started;
  h.context.chat.splice(1, 1);
  h.emit('MESSAGE_DELETED', 1);
  releaseExtraction();
  await waitFor(() => h.foundationRuntime.getState().stableCount === 0 && !h.runtime.getState().activeExtraction, '删锚后在途摘要未失效');
  let graph = await h.store.readReachable({ mode: 'runtime' });
  assert.equal(graph.floors.length, 0);
  assert.equal(graph.floorMemories.length, 0);
  assert.equal(graph.stateDeltas.length, 0);
  await new Promise(resolve => setTimeout(resolve, 20));
  await h.runtime.refreshStatus();

  h.context.chat.push({ ...user('重新加入的 U1'), send_date: 'anchor-second' });
  h.emit('MESSAGE_SENT', 1);
  for (let attempt = 0; attempt < 5000 && !(h.runtime.getState().rememberedCount === 1 && h.runtime.getState().cseReady); attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(h.runtime.getState().rememberedCount === 1 && h.runtime.getState().cseReady, true, JSON.stringify(h.runtime.getState()));
  graph = await h.store.readReachable({ mode: 'runtime' });
  assert.equal(extractorCalls, 2);
  assert.equal(graph.floorMemories.length, 1);
  assert.equal(graph.floorMemories[0].summary.aiText, '新锚后的摘要。');
});

test('已保存派生记录在删锚后退出活动链但保留物理记录，重加锚生成全新闭环', async () => {
  const h = harness({
    initialChat: [assistant('AI0 已完成内容。')],
    modernAnchors: true,
    automation: { enabled: true, batchSize: 1 },
  });
  await h.runtime.start();
  h.context.chat.push({ ...user('U1'), send_date: 'saved-anchor-first' });
  h.emit('MESSAGE_SENT', 1);
  await waitFor(() => h.runtime.getState().rememberedCount === 1 && h.runtime.getState().cseReady, '首个锚未形成完整派生记录');
  const before = await h.store.readReachable({ mode: 'runtime' });
  const oldIds = {
    floor: before.floors[0].id,
    memory: before.floorMemories[0].id,
    delta: before.stateDeltas[0].id,
    currentStates: before.currentStates.map(item => item.id),
  };

  h.context.chat.splice(1, 1);
  h.emit('MESSAGE_DELETED', 1);
  await waitFor(() => h.foundationRuntime.getState().stableCount === 0 && h.runtime.getState().floors.length === 0, '已保存锚删除后活动链未撤回');
  await h.runtime.refreshStatus();
  const retracted = await h.store.readReachable({ mode: 'runtime' });
  assert.deepEqual([retracted.floors.length, retracted.floorMemories.length, retracted.stateDeltas.length, retracted.currentStates.length], [0, 0, 0, 0]);
  assert.deepEqual([h.runtime.getState().floors.length, h.runtime.getState().cseFloors.length, h.runtime.getState().cseSubjects.length], [0, 0, 0]);
  assert.equal((await h.store.readRecord('floor', oldIds.floor)).status, 'ready');
  assert.equal((await h.store.readRecord('floorMemory', oldIds.memory)).status, 'ready');
  assert.equal((await h.store.readRecord('stateDelta', oldIds.delta)).status, 'ready');
  for (const id of oldIds.currentStates) assert.equal((await h.store.readRecord('currentState', id)).status, 'ready');

  await new Promise(resolve => setTimeout(resolve, 20));
  await h.runtime.refreshStatus();
  h.context.chat.push({ ...user('U1 再次加入'), send_date: 'saved-anchor-second' });
  h.emit('MESSAGE_SENT', 1);
  await waitFor(() => h.runtime.getState().rememberedCount === 1 && h.runtime.getState().cseReady, '重加锚后未生成新闭环');
  const after = await h.store.readReachable({ mode: 'runtime' });
  assert.notEqual(after.floors[0].id, oldIds.floor);
  assert.notEqual(after.floorMemories[0].id, oldIds.memory);
  assert.notEqual(after.stateDeltas[0].id, oldIds.delta);
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
  for (let attempt = 0; attempt < 15000 && !(initial.runtime.getState().rebuildStatus === 'caughtUp' && !initial.runtime.getState().activeAutoMemory); attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(initial.runtime.getState().rebuildStatus === 'caughtUp' && !initial.runtime.getState().activeAutoMemory, true, JSON.stringify(initial.runtime.getState()));
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
  assert.equal(upgraded.foundationRuntime.getState().stableCount, 0, '旧 nextAssistant 字段不得在 user 锚删除后救回活动前缀');
});
