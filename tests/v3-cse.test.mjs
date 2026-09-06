import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostAdapter } from '../src/v3/host-adapter.js';
import { createFoundationStore } from '../src/v3/foundation-store.js';
import { createFoundationRuntime } from '../src/v3/foundation-runtime.js';
import { createV3MemoryRuntime } from '../src/v3/memory-runtime.js';
import { EXTRACTOR_SYSTEM_PROMPT } from '../src/v3/extractor.js';
import {
  CSE_COMPILER_VERSION, CSE_PROMPT_VERSION, CSE_SYSTEM_PROMPT, captureCseBaseline, compileCseResponse, createCseEnvelope, replayCurrentState, runCseRequest, selectTrackedSubjects,
} from '../src/v3/cse-engine.js';
import { stateFingerprint } from '../src/v3/cse-schema.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GEN = '22222222-2222-4222-8222-222222222222';
const FLOOR1 = '11111111-1111-4111-8111-111111111111';
const FLOOR2 = '22222222-1111-4111-8111-111111111111';
const MEMORY1 = '33333333-1111-4111-8111-111111111111';
const MEMORY2 = '44444444-1111-4111-8111-111111111111';
const USER = '55555555-1111-4111-8111-111111111111';
const A = '66666666-1111-4111-8111-111111111111';
const B = '77777777-1111-4111-8111-111111111111';
const NOW = '2026-09-03T00:00:00.000Z';
const assistant = mes => ({ is_user: false, is_system: false, mes, swipes: [mes], swipe_id: 0 });
const user = mes => ({ is_user: true, is_system: false, mes });
const uuidFactory = () => { let value = 100; return () => `${(++value).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`; };

function backendHarness({ conflictRootPut = null, beforeGet = null, beforePut = null } = {}) {
  const records = new Map();
  const getCalls = [];
  let rootPuts = 0;
  const envelope = (data, revision) => ({ schemaVersion: 1, revision, generationId: '99999999-1111-4111-8111-111111111111', createdAt: NOW, updatedAt: NOW, data: structuredClone(data) });
  const failure = status => Object.assign(new Error(`HTTP ${status}`), { status });
  return { records, getCalls, getRootPuts: () => rootPuts, client: {
    async get(collection, key) { getCalls.push(key); await beforeGet?.({ collection, key }); const found = records.get(`${collection}/${key}`); if (!found) throw failure(404); return envelope(found.data, found.revision); },
    async put(collection, key, data, expectedRevision) { const mapKey = `${collection}/${key}`, previous = records.get(mapKey); await beforePut?.({ collection, key, data, expectedRevision }); if (key === 'v3-root') { rootPuts += 1; if (rootPuts === conflictRootPut) throw failure(409); } if ((previous?.revision ?? 0) !== expectedRevision) throw failure(409); const revision = (previous?.revision ?? 0) + 1; records.set(mapKey, { revision, data: structuredClone(data) }); return envelope(data, revision); },
  } };
}

function runtimeHarness({ cse, extractor, host = 'official', backendOptions, clock = () => new Date(NOW), chat = null, chatWorldInfo = null, filterWorldInfoSources = sources => sources } = {}) {
  const handlers = new Map(), calls = [], backend = backendHarness(backendOptions);
  let enabled = true;
  const books = new Map([['当前书', { entries: { 1: { uid: 1, content: '<content>启用作者设定</content>' }, 2: { uid: 2, content: '禁用支线', disable: true } } }], ['聊天书', { entries: { 4: { uid: 4, content: '聊天书作者设定' } } }], ['未链接书', { entries: { 3: { uid: 3, content: '不得进入基线' } } }]]);
  const context = {
    name1: '林岚', name2: '裴晚生', personaId: 'persona-linlan', characterId: 0, groupId: null, chatId: 'host-chat',
    characters: [{ avatar: 'character.png', name: '裴晚生', data: { description: '角色描述', personality: '冷静克制', scenario: '雨夜', extensions: { world: '当前书' } } }],
    userAvatar: 'persona.png', powerUserSettings: { persona_description: '调查员林岚' },
    chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT }, ...(chatWorldInfo ? { world_info: chatWorldInfo } : {}) }, chat: chat ?? [user('继续'), assistant('裴晚生提醒你带伞。'), assistant('用于确认上一楼稳定。')],
    async loadWorldInfoBatch(names) { return new Map(names.filter(name => books.has(name)).map(name => [name, books.get(name)])); },
    getWorldInfoNames() { return [...books.keys()]; }, async simulateWorldInfoActivation() { return { activatedEntries: [{ world: '当前书', uid: 1 }] }; },
    eventTypes: Object.fromEntries(['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MORE_MESSAGES_LOADED'].map(name => [name, name])),
    eventSource: { on(name, listener) { handlers.set(name, [...(handlers.get(name) ?? []), listener]); } },
  };
  const globalRef = host === 'luker' ? { Luker: { getContext: () => context } } : { SillyTavern: { getContext: () => context } };
  const hostAdapter = createHostAdapter({ globalRef });
  const baseStore = createFoundationStore({ client: backend.client, contextProvider: () => ({ hostChatId: context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }), isEnabled: () => enabled });
  const readModes = [];
  const commitResults = [];
  const store = {
    ...baseStore,
    readReachable(options) { readModes.push(options?.mode ?? 'full'); return baseStore.readReachable(options); },
    async commitRoot(...args) { const result = await baseStore.commitRoot(...args); commitResults.push(result); return result; },
  };
  const foundationRuntime = createFoundationRuntime({ hostAdapter, store, contextProvider: () => context, isEnabled: () => enabled, now: clock, newUuid: uuidFactory(), logger: { warn() {} } });
  const generateUtilityTask = async options => {
    calls.push(options);
    if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) return extractor ? extractor(options, calls) : { jsonData: { summary: '裴晚生提醒用户带伞。', people: [{ name: '你', role: 'user' }, { name: '裴晚生' }], commitments: [{ speaker: '裴晚生', targets: ['你'], content: '提醒带伞' }] }, taskMetadata: { source: 'test', sourceLabel: '测试 API', model: 'mock' } };
    return cse ? cse(options, calls) : { jsonData: { subjects: [{ subject: '主角', situational: [{ text: '记得带伞', visibility: 'private', reason: '收到提醒' }] }] }, taskMetadata: { source: 'test', sourceLabel: '测试 API', model: 'mock' } };
  };
  const runtime = createV3MemoryRuntime({ foundationRuntime, store, hostAdapter, generateUtilityTask, isEnabled: () => enabled, filterWorldInfoSources, sanitizerOptions: () => ({ keepTags: 'content' }), now: clock, newUuid: uuidFactory(), logger: { warn() {} } });
  runtime.bind({ eventSource: context.eventSource, eventTypes: context.eventTypes });
  return { runtime, foundationRuntime, store, baseStore, backend, context, calls, commitResults, readModes, emit(name, ...args) { for (const listener of handlers.get(name) ?? []) listener(...args); }, setEnabled(value) { enabled = value; } };
}

const entities = [
  { id: USER, entityType: 'person', displayName: '林岚', aliases: [{ name: '你' }], specialRole: 'user' },
  { id: A, entityType: 'person', displayName: '甲', aliases: [{ name: 'A' }], specialRole: 'none' },
  { id: B, entityType: 'person', displayName: '乙', aliases: [{ name: 'B' }], specialRole: 'none' },
];
const baseline = { id: '88888888-1111-4111-8111-111111111111', userPersona: { entityId: USER, name: '林岚', description: '用户设定' }, characterCard: { entityId: A, name: '甲', description: '', personality: '', scenario: '' }, worldInfoSources: [{ sourceName: '世界', content: '作者事实', activated: true }] };
const memory = id => ({ id, summary: { effectiveSource: 'ai', aiText: '摘要' }, chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], cseSignals: [] });
const floor = (id, content) => ({ id, chatId: CHAT, narrativeGeneration: GEN, content: { canonicalContent: content } });

test('baseline 一次冻结，只有已链接且宿主启用的世界书进入；Luker 降级可用', async () => {
  const h = runtimeHarness({ host: 'luker' });
  let state = await h.runtime.start().then(() => h.runtime.extractNext());
  assert.equal(state.rememberedCount, 1);
  assert.ok(state.baselineId);
  const root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  const saved = h.backend.records.get(`chat-${CHAT}/v3-baseline-${root.baselineId}`).data;
  assert.deepEqual(saved.worldInfoSources.map(item => item.content), ['启用作者设定']);
  assert.equal(saved.worldInfoSources.some(item => /禁用支线|不得进入基线/.test(item.content)), false);
  const fingerprint = saved.fingerprint;
  h.context.powerUserSettings.persona_description = '事后变化不得漂移';
  state = await h.runtime.extractFloor(state.floors[0].floorId);
  assert.equal(state.cseFloors[0].status, 'pending', 're-extract 后旧 delta 失效且不自动重跑 AI');
  await h.runtime.retryStateAnalysis(state.floors[0].floorId);
  const same = h.backend.records.get(`chat-${CHAT}/v3-baseline-${root.baselineId}`).data;
  assert.equal(same.fingerprint, fingerprint);
  assert.equal(same.userPersona.description, '调查员林岚');
});

test('root 挂接冲突留下的合法同聊天 orphan baseline 可在时间变化后严格校验并接管', async () => {
  let tick = 0;
  const h = runtimeHarness({ backendOptions: { conflictRootPut: 3 }, clock: () => new Date(Date.parse(NOW) + tick++ * 1000) });
  let state = await h.runtime.start().then(() => h.runtime.extractNext());
  assert.equal(state.rememberedCount, 1);
  assert.equal(state.cseFloors[0].status, 'failed');
  let root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  assert.equal(root.baselineId, null);
  const orphanKeys = [...h.backend.records.keys()].filter(key => key.includes('/v3-baseline-'));
  assert.equal(orphanKeys.length, 1);
  const orphanFingerprint = h.backend.records.get(orphanKeys[0]).data.fingerprint;
  state = await h.runtime.retryStateAnalysis(state.floors[0].floorId);
  root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  assert.ok(root.baselineId);
  assert.equal(state.cseReady, true);
  assert.equal(h.backend.records.get(orphanKeys[0]).data.fingerprint, orphanFingerprint);
  assert.equal([...h.backend.records.keys()].filter(key => key.includes('/v3-baseline-')).length, 1);
});

test('自动 CSE 输入同时含正文、FloorMemory、previousState、baseline，且只提交一份对应 delta/current state', async () => {
  const h = runtimeHarness();
  const state = await h.runtime.start().then(() => h.runtime.extractNext());
  const cseCall = h.calls.find(call => call.systemPrompt === CSE_SYSTEM_PROMPT);
  assert.ok(cseCall);
  const request = JSON.parse(cseCall.taskMessages[0].content);
  assert.deepEqual(Object.keys(request.payload).slice(0, 4), ['canonicalContent', 'floorMemory', 'previousState', 'relevantBaseline']);
  assert.match(request.payload.canonicalContent, /裴晚生提醒你带伞/);
  assert.match(JSON.stringify(request.payload.floorMemory), /提醒用户带伞/);
  assert.equal(request.payload.relevantBaseline.worldInfo[0].visibility, 'authorial');
  assert.deepEqual(request.payload.trackedSubjects.map(item => item.name).sort(), ['林岚', '裴晚生'].sort(), 'user 永远追踪，承诺强证据自动追踪其他人物');
  assert.equal(state.cseReady, true);
  assert.equal(state.cseFloors[0].status, 'ready');
  const root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  const checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  assert.equal(checkpoint.producedRefs.stateDeltas.length, 1);
  assert.equal(checkpoint.producedRefs.currentStates.length, 1);
  const committed = h.commitResults.at(-1);
  assert.equal(committed.status, 'saved');
  assert.equal(committed.reachable.readMode, 'full');
  assert.equal(committed.reachable.indexesComplete, true);
  assert.equal(committed.reachable.indexesMissing, false);
  assert.equal(Object.keys(committed.reachable.floorRevisions).length, committed.reachable.floors.length);
  assert.equal(Object.keys(committed.reachable.memoryRevisions).length, committed.reachable.floorMemories.length);
  assert.equal(Object.keys(committed.reachable.deltaRevisions).length, committed.reachable.stateDeltas.length);
  const independentlyRead = await h.baseStore.readReachable();
  assert.deepEqual(committed.reachable.floors.map(item => item.hostLocator), independentlyRead.floors.map(item => item.hostLocator));
  assert.deepEqual(committed.reachable.floors.map(item => item.content.rawFingerprint), independentlyRead.floors.map(item => item.content.rawFingerprint));
  assert.deepEqual(committed.reachable, independentlyRead, 'CAS 返回快照必须与同一后端独立 full readReachable 完全同义');
});

test('重算早期楼的候选计数只看截至目标楼，目标前与本楼累计有效而未来人物不倒灌', async () => {
  const requests = [];
  const h = runtimeHarness({
    chat: [
      user('继续'),
      assistant('第一楼，无新人物。'),
      assistant('第二楼，乙第一次出现。'),
      assistant('第三楼，乙再次出现。'),
      assistant('第四楼，丙第一次出现。'),
      assistant('第五楼，丙再次出现。'),
      assistant('第六楼，用于确认第五楼稳定。'),
    ],
    extractor: options => {
      const content = JSON.parse(options.taskMessages[0].content).payload.canonicalContent;
      const people = content.includes('乙') ? [{ name: '乙', presence: 'present' }]
        : content.includes('丙') ? [{ name: '丙', presence: 'present' }] : [];
      return { jsonData: { summary: content, people }, taskMetadata: { source: 'test', sourceLabel: '测试 API', model: 'mock' } };
    },
    cse: options => {
      const request = JSON.parse(options.taskMessages[0].content);
      requests.push({ content: request.payload.canonicalContent, names: request.payload.trackedSubjects.map(item => item.name) });
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await h.runtime.start();
  let state;
  for (let index = 0; index < 5; index += 1) state = await h.runtime.extractNext();
  const third = state.floors.find(item => item.assistantSeq === 3);
  assert.ok(third);
  const initialThird = requests.find(item => item.content.includes('第三楼'));
  assert.deepEqual(initialThird.names.sort(), ['乙', '林岚'].sort(), '目标前一次加本楼一次应达到重复候选阈值');

  await h.runtime.retryStateAnalysis(third.floorId);
  const retriedThird = requests.at(-1);
  assert.match(retriedThird.content, /第三楼/);
  assert.deepEqual(retriedThird.names.sort(), ['乙', '林岚'].sort(), '目标后的丙即使出现两次也不得倒灌到第三楼候选');
});

test('每次显式重算都按当次整本排除构建新 CSE 请求；全排除、解除和旧 baseline 恢复均不改 baseline 指纹', async () => {
  let excluded = new Set();
  const h = runtimeHarness({
    chatWorldInfo: ['聊天书'],
    filterWorldInfoSources: sources => sources.filter(source => !excluded.has(source.sourceName)),
  });
  let state = await h.runtime.start().then(() => h.runtime.extractNext());
  const floorId = state.floors[0].floorId;
  const root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  const baselineRecord = h.backend.records.get(`chat-${CHAT}/v3-baseline-${root.baselineId}`).data;
  const baselineBefore = structuredClone(baselineRecord);
  const cseRequests = () => h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).map(call => JSON.parse(call.taskMessages[0].content));
  assert.deepEqual(cseRequests().at(-1).payload.relevantBaseline.worldInfo.map(source => source.source), ['当前书', '聊天书']);

  excluded = new Set(['当前书']);
  state = await h.runtime.retryStateAnalysis(floorId);
  assert.deepEqual(cseRequests().at(-1).payload.relevantBaseline.worldInfo.map(source => source.source), ['聊天书']);

  excluded = new Set(['当前书', '聊天书']);
  state = await h.runtime.retryStateAnalysis(floorId);
  assert.deepEqual(cseRequests().at(-1).payload.relevantBaseline.worldInfo, []);

  excluded = new Set();
  state = await h.runtime.retryStateAnalysis(floorId);
  assert.deepEqual(cseRequests().at(-1).payload.relevantBaseline.worldInfo.map(source => source.source), ['当前书', '聊天书']);
  assert.equal(cseRequests().length, 4, '每次重算都真实发起一次新模型请求，不复用旧请求');
  assert.deepEqual(h.backend.records.get(`chat-${CHAT}/v3-baseline-${root.baselineId}`).data, baselineBefore);
  assert.equal(state.cseReady, true);
});

test('createCseEnvelope 只替换本次请求的世界书视图，默认调用仍兼容 baseline 全量来源', () => {
  const filtered = baseline.worldInfoSources.slice(0, 0);
  const filteredEnvelope = createCseEnvelope({ floor: floor(FLOOR1, '正文'), floorMemory: memory(MEMORY1), baseline, currentState: null, trackedSubjects: [entities[0]], entities, worldInfoSources: filtered });
  const defaultEnvelope = createCseEnvelope({ floor: floor(FLOOR1, '正文'), floorMemory: memory(MEMORY1), baseline, currentState: null, trackedSubjects: [entities[0]], entities });
  assert.deepEqual(filteredEnvelope.request.payload.relevantBaseline.worldInfo, []);
  assert.deepEqual(defaultEnvelope.request.payload.relevantBaseline.worldInfo.map(source => source.source), ['世界']);
  assert.deepEqual(baseline.worldInfoSources.map(source => source.sourceName), ['世界']);
});

test('CSE 按主体整理角色相关证据，不把提及、指令对象、计划或信息发送者冒充人物已知', () => {
  const instructionMemory = {
    ...memory(MEMORY1),
    participants: [{ entityId: B, presence: 'mentioned' }],
    commitments: [{ speakerEntityId: USER, targetEntityIds: [A], kind: 'command', content: '让甲转告乙明早运货', status: 'made' }],
  };
  const instructionEnvelope = createCseEnvelope({ floor: floor(FLOOR1, '林岚让甲转告乙明早运货。'), floorMemory: instructionMemory, baseline, currentState: null, trackedSubjects: entities, entities });
  const evidenceBySubject = new Map(instructionEnvelope.request.payload.subjectRelevantEvidence.map(item => [item.subject, item]));
  assert.deepEqual(evidenceBySubject.get('乙').participants, [{ person: '乙', presence: 'mentioned', relationToSubject: ['participant'] }]);
  assert.equal(evidenceBySubject.get('乙').commitments, undefined, '正文字符串里的乙不会被正则猜成承诺对象或已知者');
  assert.equal(evidenceBySubject.get('乙').informationTransfers, undefined, '待转告没有伪造成实际送达');
  assert.deepEqual(evidenceBySubject.get('甲').commitments[0], {
    speaker: '林岚', targets: ['甲'], kind: 'command', content: '让甲转告乙明早运货', status: 'made', relationToSubject: ['target'],
  });

  const deliveredMemory = {
    ...memory(MEMORY2),
    informationTransfers: [{ fromEntityId: A, toEntityIds: [B], claimText: '明早运货', channel: 'told' }],
  };
  const deliveredEnvelope = createCseEnvelope({ floor: floor(FLOOR2, '甲随后当面告诉乙明早运货。'), floorMemory: deliveredMemory, baseline, currentState: null, trackedSubjects: entities.slice(1), entities });
  const deliveredBySubject = new Map(deliveredEnvelope.request.payload.subjectRelevantEvidence.map(item => [item.subject, item]));
  assert.deepEqual(deliveredBySubject.get('甲').informationTransfers[0].relationToSubject, ['sender']);
  assert.deepEqual(deliveredBySubject.get('乙').informationTransfers[0], { from: '甲', to: ['乙'], claim: '明早运货', channel: 'told', relationToSubject: ['recipient'] });

  const ownedMemory = {
    ...memory(MEMORY1),
    actions: [{ actorEntityId: A, targetEntityIds: [B], action: '计划次日运货', completion: 'intended', result: null }],
    observations: [{ subjectEntityId: A, kind: 'physical', description: '甲攥紧纸条' }],
    privateCognition: [{ ownerEntityId: A, kind: 'suspicion', content: '怀疑消息有误' }],
    commitments: [{ speakerEntityId: A, targetEntityIds: [], kind: 'plan', content: '次日再核对', status: 'made' }],
    cseSignals: [{ subjectEntityId: A, objectEntityId: B, signalType: 'trust', description: '甲暂时相信乙' }],
  };
  const owned = createCseEnvelope({ floor: floor(FLOOR1, '甲心里存疑，打算明日核对。'), floorMemory: ownedMemory, baseline, currentState: null, trackedSubjects: entities.slice(1), entities }).request.payload.subjectRelevantEvidence;
  const ownedBySubject = new Map(owned.map(item => [item.subject, item]));
  assert.deepEqual(ownedBySubject.get('甲').actions[0].relationToSubject, ['actor']);
  assert.equal(ownedBySubject.get('甲').actions[0].completion, 'intended');
  assert.deepEqual(ownedBySubject.get('乙').actions[0].relationToSubject, ['target']);
  assert.deepEqual(ownedBySubject.get('甲').privateCognition[0].relationToSubject, ['owner']);
  assert.equal(ownedBySubject.get('甲').privateCognition[0].visibility, 'private');
  assert.deepEqual(ownedBySubject.get('甲').commitments[0].relationToSubject, ['speaker']);
  assert.equal(ownedBySubject.get('甲').commitments[0].kind, 'plan');
  assert.deepEqual(ownedBySubject.get('乙').cseSignals[0].relationToSubject, ['object']);
});

test('稀疏 FloorMemory 不削弱正文，明确正文状态可编译且提示词升级不冒充编译器升级', async () => {
  const sparseMemory = memory(MEMORY1);
  const envelope = createCseEnvelope({ floor: floor(FLOOR1, '甲亲耳听见林岚说“明早出发”，并记住了时间。'), floorMemory: sparseMemory, baseline, currentState: null, trackedSubjects: [entities[1]], entities });
  assert.match(envelope.request.payload.canonicalContent, /亲耳听见/);
  assert.deepEqual(envelope.request.payload.subjectRelevantEvidence, [{ subject: '甲' }]);
  const compiled = await compileCseResponse({
    response: { subjects: [{ subject: '甲', situational: [{ reason: '正文明确写出甲亲耳听见并记住', text: '知道明早出发', visibility: 'private' }] }] },
    envelope,
    previousCurrentState: null,
    now: NOW,
    deltaId: '18181818-1818-4181-8181-181818181818',
  });
  assert.equal(compiled.delta.subjectSnapshots[0].situational[0].text, '知道明早出发');
  assert.equal(compiled.delta.subjectSnapshots[0].situational[0].reason, '正文明确写出甲亲耳听见并记住');
  assert.equal(compiled.delta.source.promptVersion, CSE_PROMPT_VERSION);
  assert.equal(compiled.delta.source.compilerVersion, CSE_COMPILER_VERSION);
  assert.equal(CSE_PROMPT_VERSION, 'qqj-v3-cse-prompt-6');
  assert.equal(CSE_COMPILER_VERSION, 'qqj-v3-cse-prompt-2/after-state-compiler-4');
  assert.match(CSE_SYSTEM_PROMPT, /未提供依据/);
  assert.doesNotMatch(CSE_SYSTEM_PROMPT, /"noMaterialChange"/);
});

test('CSE Phase A 最多 6 路并发，完成后仍按 run → checkpoint → root 屏障提交且只保留提交前 runtime 回读', async () => {
  const phaseTypes = new Set(['entity', 'stateDelta', 'currentState', 'index']);
  let measuring = false;
  let activePuts = 0;
  let maximumPuts = 0;
  let phaseStarts = 0;
  let phaseCompletions = 0;
  let releasePhase;
  let firstWaveResolve;
  let readMarker = 0;
  const phaseGate = new Promise(resolve => { releasePhase = resolve; });
  const firstWave = new Promise(resolve => { firstWaveResolve = resolve; });
  const barriers = [];
  let h;
  h = runtimeHarness({
    cse: () => {
      measuring = true;
      readMarker = h.readModes.length;
      return { jsonData: { noMaterialChange: true } };
    },
    backendOptions: {
      beforePut: async ({ data }) => {
        if (!measuring) return;
        if (phaseTypes.has(data.recordType)) {
          phaseStarts += 1;
          activePuts += 1;
          maximumPuts = Math.max(maximumPuts, activePuts);
          if (phaseStarts === 6) firstWaveResolve();
          await phaseGate;
          activePuts -= 1;
          phaseCompletions += 1;
          return;
        }
        barriers.push({ type: data.recordType, activePuts, phaseStarts, phaseCompletions });
      },
    },
  });

  const pending = h.runtime.start().then(() => h.runtime.extractNext());
  await firstWave;
  assert.equal(maximumPuts, 6);
  assert.equal(barriers.length, 0, '首批 Phase A 未完成前不得写 run/checkpoint/root');
  releasePhase();
  const state = await pending;

  assert.equal(state.cseReady, true);
  assert.ok(maximumPuts > 1 && maximumPuts <= 6);
  assert.deepEqual(barriers.map(item => item.type), ['run', 'checkpoint', 'root']);
  assert.ok(barriers.every(item => item.activePuts === 0 && item.phaseCompletions === item.phaseStarts));
  assert.deepEqual(h.readModes.slice(readMarker), ['runtime']);
});

test('CSE root 校验在 checkpoint 后跨记录类别并行，单类最多 16 路且全部读完才 CAS', async () => {
  const expectedKinds = new Set(['floor', 'index', 'run', 'floorMemory', 'entity', 'baseline', 'stateDelta', 'currentState']);
  const seenKinds = new Set();
  const activeByKind = new Map();
  const maximumByKind = new Map();
  const measuredKeys = [];
  const rootBarriers = [];
  let measuring = false;
  let checkpointRead = false;
  let activeReads = 0;
  let maximumReads = 0;
  let startedReads = 0;
  let completedReads = 0;
  let releaseReads;
  let allKindsResolve;
  const readGate = new Promise(resolve => { releaseReads = resolve; });
  const allKindsStarted = new Promise(resolve => { allKindsResolve = resolve; });
  const kindOf = key => {
    if (key.startsWith('v3-floor-memory-')) return 'floorMemory';
    if (key.startsWith('v3-floor-')) return 'floor';
    if (key.startsWith('v3-index-')) return 'index';
    if (key.startsWith('v3-run-')) return 'run';
    if (key.startsWith('v3-entity-')) return 'entity';
    if (key.startsWith('v3-baseline-')) return 'baseline';
    if (key.startsWith('v3-state-delta-')) return 'stateDelta';
    if (key.startsWith('v3-current-state-')) return 'currentState';
    return null;
  };
  const longChat = [user('继续'), ...Array.from({ length: 36 }, (_, index) => assistant(index === 0 ? '裴晚生提醒你带伞。' : `稳定楼 ${index + 1}`))];
  const h = runtimeHarness({
    chat: longChat,
    backendOptions: {
      beforeGet: async ({ key }) => {
        if (!measuring) return;
        measuredKeys.push(key);
        if (!checkpointRead) {
          assert.match(key, /^v3-checkpoint-/);
          checkpointRead = true;
          return;
        }
        const kind = kindOf(key);
        assert.ok(kind, `未知校验记录：${key}`);
        seenKinds.add(kind);
        startedReads += 1;
        activeReads += 1;
        maximumReads = Math.max(maximumReads, activeReads);
        const kindActive = (activeByKind.get(kind) ?? 0) + 1;
        activeByKind.set(kind, kindActive);
        maximumByKind.set(kind, Math.max(maximumByKind.get(kind) ?? 0, kindActive));
        if ([...expectedKinds].every(value => seenKinds.has(value))) allKindsResolve();
        await readGate;
        activeByKind.set(kind, activeByKind.get(kind) - 1);
        activeReads -= 1;
        completedReads += 1;
      },
      beforePut: async ({ data }) => {
        if (data.recordType === 'checkpoint' && data.capabilities.cseReady) measuring = true;
        if (measuring && data.recordType === 'root') rootBarriers.push({ activeReads, startedReads, completedReads });
      },
    },
  });

  const pending = h.runtime.start().then(() => h.runtime.extractNext());
  let timeoutId;
  await Promise.race([
    allKindsStarted,
    new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error('提交校验未跨全部记录类别启动')), 3000); }),
  ]);
  clearTimeout(timeoutId);
  assert.ok(activeReads > 16, '多个记录类别必须真实重叠，而非逐类串行');
  assert.ok(maximumReads <= 98, '八类并行的结构上限不得超过 6×16 + run/baseline');
  for (const kind of expectedKinds) assert.ok((maximumByKind.get(kind) ?? 0) <= 16, `${kind} 单类读取超过 16 路`);
  assert.deepEqual(rootBarriers, [], '读回校验仍在途时不得发 root CAS');
  releaseReads();
  const state = await pending;
  assert.equal(state.cseReady, true);
  assert.deepEqual(rootBarriers, [{ activeReads: 0, startedReads, completedReads: startedReads }]);

  const root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  const checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  const expectedKeys = [
    `v3-checkpoint-${checkpoint.id}`,
    ...checkpoint.producedRefs.floors.map(id => `v3-floor-${id}`),
    ...Object.values(root.indexManifest).flat(),
    `v3-run-${checkpoint.runId}`,
    ...checkpoint.producedRefs.floorMemories.map(id => `v3-floor-memory-${id}`),
    ...checkpoint.producedRefs.entities.map(id => `v3-entity-${id}`),
    `v3-baseline-${root.baselineId}`,
    ...checkpoint.producedRefs.stateDeltas.map(id => `v3-state-delta-${id}`),
    ...checkpoint.producedRefs.currentStates.map(id => `v3-current-state-${id}`),
  ];
  assert.deepEqual(measuredKeys.slice().sort(), expectedKeys.slice().sort(), '实际落盘回读集合必须完整且无多余读取');
});

test('CSE Phase A 首个 conflict 后停止领取新记录并等待在途写入，且不发布 run/checkpoint/root', async () => {
  const phaseTypes = new Set(['entity', 'stateDelta', 'currentState', 'index']);
  let measuring = false;
  let phaseStarts = 0;
  let activePuts = 0;
  let releaseConflict;
  let releaseInflight;
  let firstWaveResolve;
  const conflictGate = new Promise(resolve => { releaseConflict = resolve; });
  const inflightGate = new Promise(resolve => { releaseInflight = resolve; });
  const firstWave = new Promise(resolve => { firstWaveResolve = resolve; });
  const barriers = [];
  const h = runtimeHarness({
    cse: () => { measuring = true; return { jsonData: { noMaterialChange: true } }; },
    backendOptions: {
      beforePut: async ({ data }) => {
        if (!measuring) return;
        if (!phaseTypes.has(data.recordType)) { barriers.push(data.recordType); return; }
        phaseStarts += 1;
        activePuts += 1;
        const ordinal = phaseStarts;
        if (phaseStarts === 6) firstWaveResolve();
        if (ordinal === 1) {
          await conflictGate;
          activePuts -= 1;
          throw Object.assign(new Error('受控 Phase A conflict'), { status: 409 });
        }
        await inflightGate;
        activePuts -= 1;
      },
    },
  });

  let settled = false;
  const pending = h.runtime.start().then(() => h.runtime.extractNext()).finally(() => { settled = true; });
  await firstWave;
  releaseConflict();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(phaseStarts, 6, '发现首错后不得继续领取第 7 个 Phase A 记录');
  assert.equal(settled, false, '仍有在途写入时不得提前结束操作');
  assert.equal(activePuts, 5);
  assert.deepEqual(barriers, []);

  releaseInflight();
  const state = await pending;
  assert.equal(activePuts, 0);
  assert.equal(state.cseFloors[0].status, 'failed');
  assert.equal(state.lastCseError.code, 'V3_CSE_PERSIST_FAILED');
  assert.deepEqual(barriers, [], 'Phase A 失败后不得写 run/checkpoint/root');
});

test('CSE Phase A 六条写入在途时失效会停止领取、等待收拢且不发布新 root', async () => {
  const phaseTypes = new Set(['entity', 'stateDelta', 'currentState', 'index']);
  let measuring = false;
  let phaseStarts = 0;
  let activePuts = 0;
  let releaseInflight;
  let firstWaveResolve;
  const inflightGate = new Promise(resolve => { releaseInflight = resolve; });
  const firstWave = new Promise(resolve => { firstWaveResolve = resolve; });
  const barriers = [];
  const h = runtimeHarness({
    cse: () => { measuring = true; return { jsonData: { noMaterialChange: true } }; },
    backendOptions: {
      beforePut: async ({ data }) => {
        if (!measuring) return;
        if (!phaseTypes.has(data.recordType)) { barriers.push(data.recordType); return; }
        phaseStarts += 1;
        activePuts += 1;
        if (phaseStarts === 6) firstWaveResolve();
        await inflightGate;
        activePuts -= 1;
      },
    },
  });

  await h.runtime.start();
  let settled = false;
  const pending = h.runtime.extractNext().finally(() => { settled = true; });
  await firstWave;
  const rootBeforeInvalidation = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-root`).data);
  h.runtime.invalidate();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(phaseStarts, 6);
  assert.equal(activePuts, 6);
  assert.equal(settled, false, '失效后仍须等待已在途的六条写入收拢');
  assert.deepEqual(barriers, []);

  releaseInflight();
  await pending;
  assert.equal(activePuts, 0);
  assert.equal(phaseStarts, 6, '失效后不得领取第 7 个 Phase A 记录');
  assert.deepEqual(barriers, [], '失效后不得写 run/checkpoint/root');
  assert.deepEqual(h.backend.records.get(`chat-${CHAT}/v3-root`).data, rootBeforeInvalidation);
});

test('CSE 真实请求链只在 finish_reason=stop 且唯一缺人物右花括号时有限补齐', async () => {
  const trackedEntities = [...entities, ...Array.from({ length: 9 }, (_, index) => ({
    id: `${String(index + 4).padStart(8, '0')}-2222-4222-8222-${String(index + 4).padStart(12, '0')}`,
    entityType: 'person',
    displayName: `虚构人物-${index + 4}`,
    aliases: [],
    specialRole: 'none',
  }))];
  const envelope = createCseEnvelope({ floor: floor(FLOOR1, '虚构楼层正文'), floorMemory: memory(MEMORY1), baseline, currentState: null, trackedSubjects: trackedEntities, entities: trackedEntities });
  const packet = {
    subjects: trackedEntities.map((entity, index) => ({
      subject: entity.displayName,
      situational: [{ text: `虚构状态-${index + 1}`, visibility: 'observable', reason: `虚构证据-${index + 1}`, origin: 'floor' }],
      changeSummary: [`虚构变化-${index + 1}`],
    })),
    noMaterialChange: false,
  };
  const complete = JSON.stringify(packet);
  const missingAt = complete.lastIndexOf('}],"noMaterialChange"');
  assert.ok(missingAt > 0);
  const uniquelyRepairable = `${complete.slice(0, missingAt)}${complete.slice(missingAt + 1)}`;
  const fenced = `以下为结果：\n\`\`\`json\n${uniquelyRepairable}\n\`\`\``;
  const run = finishReason => runCseRequest({
    generateUtilityTask: async () => ({ textData: fenced, taskMetadata: finishReason === undefined ? {} : { finishReason } }),
    envelope,
    previousCurrentState: null,
    now: NOW,
    deltaId: '16161616-1616-4161-8161-161616161616',
  });

  const recovered = await run('stop');
  assert.equal(recovered.delta.subjectSnapshots.length, 12);
  assert.deepEqual(recovered.delta.subjectSnapshots.map(subject => subject.situational[0].text), Array.from({ length: 12 }, (_, index) => `虚构状态-${index + 1}`));
  assert.deepEqual(recovered.delta.subjectSnapshots[11].changeSummary, ['虚构变化-12']);
  assert.equal(recovered.metadata.finishReason, 'stop');

  await assert.rejects(run(), error => error.code === 'V3_CSE_FORMAT_INVALID');
  await assert.rejects(run('length'), error => error.code === 'V3_CSE_FORMAT_INVALID');

  const rejects = async response => assert.rejects(
    compileCseResponse({ response, finishReason: 'stop', envelope, previousCurrentState: null, now: NOW, deltaId: '17171717-1717-4171-8171-171717171717' }),
    error => error.code === 'V3_CSE_FORMAT_INVALID',
  );
  await rejects('{"subjects":[{"subject":"林岚","situational":[{"text":"未写完');
  await rejects('{"subjects":{"subject":"林岚"}');
  await rejects('{"subjects":[{"subject":"林岚"');
});

test('CSE 只把明确参与和 typed action/info 计入重复关联，普通单楼关联不扩成 strong', () => {
  const trackableEntities = entities.map(entity => ({ ...entity, recordStatus: 'active', status: 'established' }));
  const mentioned = { ...memory(MEMORY1), participants: [{ entityId: B, presence: 'mentioned' }] };
  const mentionedAgain = { ...memory(MEMORY2), participants: [{ entityId: B, presence: 'privateCognitionOnly' }] };
  assert.deepEqual(selectTrackedSubjects({ baseline, entities: trackableEntities, floorMemories: [mentioned, mentionedAgain], floorMemory: mentionedAgain }).map(item => item.id), [USER]);

  const actionOnce = { ...memory(MEMORY1), actions: [{ actorEntityId: B, targetEntityIds: [USER], action: '递交文件', completion: 'completed', result: null }] };
  assert.deepEqual(selectTrackedSubjects({ baseline, entities: trackableEntities, floorMemories: [actionOnce], floorMemory: actionOnce }).map(item => item.id), [USER], '普通单楼 action 只参与计数，不升级为 strong');
  const actionAgain = { ...memory(MEMORY2), actions: [{ actorEntityId: B, targetEntityIds: [USER], action: '取回回执', completion: 'completed', result: null }] };
  assert.deepEqual(selectTrackedSubjects({ baseline, entities: trackableEntities, floorMemories: [actionOnce, actionAgain], floorMemory: actionAgain }).map(item => item.id), [USER, B]);

  const infoOnce = { ...memory(MEMORY1), informationTransfers: [{ fromEntityId: B, toEntityIds: [USER], claimText: '车站改期', channel: 'written' }] };
  const infoAgain = { ...memory(MEMORY2), informationTransfers: [{ fromEntityId: B, toEntityIds: [USER], claimText: '新时刻表', channel: 'shown' }] };
  assert.deepEqual(selectTrackedSubjects({ baseline, entities: trackableEntities, floorMemories: [infoOnce], floorMemory: infoOnce }).map(item => item.id), [USER]);
  assert.deepEqual(selectTrackedSubjects({ baseline, entities: trackableEntities, floorMemories: [infoOnce, infoAgain], floorMemory: infoAgain }).map(item => item.id), [USER, B]);

  const remoteOnce = { ...memory(MEMORY1), participants: [{ entityId: B, presence: 'remote' }] };
  const remoteAgain = { ...memory(MEMORY2), participants: [{ entityId: B, presence: 'present' }] };
  assert.deepEqual(selectTrackedSubjects({ baseline, entities: trackableEntities, floorMemories: [remoteOnce, remoteAgain], floorMemory: remoteAgain }).map(item => item.id), [USER, B]);
});

test('CSE 失败不回滚 FloorMemory，并保留单独重试入口', async () => {
  let fail = true;
  const h = runtimeHarness({ cse: () => { if (fail) throw Object.assign(new Error('模拟 CSE 失败'), { code: 'CSE_TEST_FAIL' }); return { jsonData: { noMaterialChange: true } }; } });
  let state = await h.runtime.start().then(() => h.runtime.extractNext());
  assert.equal(state.rememberedCount, 1);
  assert.equal(state.cseFloors[0].status, 'failed');
  assert.equal(state.cseReady, false);
  fail = false;
  state = await h.runtime.retryStateAnalysis(state.floors[0].floorId);
  assert.equal(state.rememberedCount, 1);
  assert.equal(state.cseFloors[0].status, 'noChange');
  assert.equal(state.cseReady, true);
});

test('迟到 CSE 在聊天事件后不能污染 root，已成功 FloorMemory 仍独立存在', async () => {
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const h = runtimeHarness({ cse: () => new Promise(resolve => { release = () => resolve({ jsonData: { subjects: [{ subject: '你', situational: ['迟到状态'] }] } }); started(); }) });
  await h.runtime.start();
  const pending = h.runtime.extractNext();
  await waiting;
  h.emit('CHAT_CHANGED');
  release();
  await pending;
  const records = [...h.backend.records.keys()];
  assert.equal(records.some(key => key.includes('/v3-floor-memory-')), true);
  const root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  const checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  assert.equal(checkpoint.producedRefs.stateDeltas.length, 0);
});

test('正文分支回退只过滤不可达 delta 并本地重放，不调用 CSE API', async () => {
  const h = runtimeHarness();
  h.context.chat.push(assistant('第三楼用于确认第二楼稳定。'));
  let state = await h.runtime.start().then(() => h.runtime.extractNext());
  state = await h.runtime.extractNext();
  assert.equal(state.rememberedCount, 2);
  assert.equal(state.replayedCurrentState.appliedDeltaIds.length, 2);
  const callsBefore = h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length;
  h.context.chat[2].mes = '第二楼改成另一条分支。'; h.context.chat[2].swipes = ['第二楼改成另一条分支。'];
  h.emit('MESSAGE_EDITED', 2);
  state = await h.runtime.refreshStatus();
  const callsAfter = h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length;
  assert.equal(callsAfter, callsBefore);
  assert.equal(state.rememberedCount, 1);
  assert.equal(state.replayedCurrentState.appliedDeltaIds.length, 1);
  assert.equal(state.cseReady, true, '可信前缀的唯一 FloorMemory 仍有匹配 delta');
});

test('最早 FloorMemory 失效会截断全部后续投影；后楼不能越过缺口分析，也不会吃到未来状态', async () => {
  const h = runtimeHarness();
  h.context.chat.push(assistant('第三楼用于确认第二楼稳定。'));
  let state = await h.runtime.start().then(() => h.runtime.extractNext());
  state = await h.runtime.extractNext();
  assert.equal(state.replayedCurrentState.appliedDeltaIds.length, 2);
  const firstFloorId = state.floors[0].floorId, secondFloorId = state.floors[1].floorId;
  const cseCallsBefore = h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length;
  state = await h.runtime.extractFloor(firstFloorId);
  assert.deepEqual(state.cseFloors.map(item => item.status), ['pending', 'pending']);
  assert.equal(state.replayedCurrentState.appliedDeltaIds.length, 0);
  let root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  let checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  assert.deepEqual(checkpoint.producedRefs.stateDeltas, [], '从最早失效楼起截断，后续完整投影不得残留');
  state = await h.runtime.retryStateAnalysis(secondFloorId);
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, cseCallsBefore);
  assert.equal(state.cseFloors[1].status, 'pending');
  assert.match(state.cseFloors[1].error, /前面还有未分析或已失效的楼/);
  state = await h.runtime.retryStateAnalysis(firstFloorId);
  const firstRetryCall = h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).at(-1);
  assert.deepEqual(JSON.parse(firstRetryCall.taskMessages[0].content).payload.previousState, [], '较早楼只能看到目标楼之前的状态，不能未来倒灌');
  state = await h.runtime.retryStateAnalysis(secondFloorId);
  const secondRetryRequest = JSON.parse(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).at(-1).taskMessages[0].content);
  assert.ok(secondRetryRequest.payload.previousState.length > 0, '补齐连续前缀后才允许分析后楼');
  assert.equal(state.cseReady, true);
  root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  assert.equal(checkpoint.producedRefs.stateDeltas.length, 2);
  const firstMemory = state.floors[0].memory;
  state = await h.runtime.editMemory(firstFloorId, { summary: '用户手工修订第一楼摘要', chronology: firstMemory.chronology.map(item => ({ itemId: item.itemId, sourceText: item.time.sourceText ?? '', description: item.description })), locations: firstMemory.locations.map(item => ({ itemId: item.itemId, name: item.name })), participantEntityIds: firstMemory.participants.map(item => item.entityId), participantPresence: Object.fromEntries(firstMemory.participants.map(item => [item.entityId, item.presence])), revisionNote: '校正事实' });
  assert.deepEqual(state.cseFloors.map(item => item.status), ['pending', 'pending'], '前置楼整包元数据修订同样使下游全部待分析');
  assert.equal(state.replayedCurrentState.appliedDeltaIds.length, 0);
  root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  assert.deepEqual(checkpoint.producedRefs.stateDeltas, []);
});

test('前置楼 markError 后必须断开连续前缀，清空下游 delta 且不自动调用 CSE', async () => {
  const h = runtimeHarness();
  h.context.chat.push(assistant('第三楼用于确认第二楼稳定。'));
  let state = await h.runtime.start().then(() => h.runtime.extractNext());
  state = await h.runtime.extractNext();
  assert.equal(state.cseReady, true);
  assert.equal(state.replayedCurrentState.appliedDeltaIds.length, 2);
  const firstFloorId = state.floors[0].floorId;
  const secondFloorId = state.floors[1].floorId;
  const cseCallsBefore = h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length;
  state = await h.runtime.markError(firstFloorId);
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, cseCallsBefore, 'markError 只做本地断链');
  assert.equal(state.cseFloors[0].status, 'notApplicable');
  assert.equal(state.cseFloors[1].status, 'pending');
  assert.equal(state.replayedCurrentState.appliedDeltaIds.length, 0);
  let root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  let checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  assert.deepEqual(checkpoint.producedRefs.stateDeltas, []);
  state = await h.runtime.retryStateAnalysis(secondFloorId);
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, cseCallsBefore, '后楼不能越过 invalidated 前楼调用 CSE');
  assert.equal(state.cseFloors[1].status, 'pending');
  assert.match(state.cseFloors[1].error, /前面还有未分析或已失效的楼/);
  root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  assert.deepEqual(checkpoint.producedRefs.stateDeltas, []);
});

test('冷启动发现 CurrentState 与 delta 重放不一致时，以重放为准并报告诊断', async () => {
  const h = runtimeHarness();
  let state = await h.runtime.start().then(() => h.runtime.extractNext());
  const root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  const checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  const stateKey = `chat-${CHAT}/v3-current-state-${checkpoint.producedRefs.currentStates[0]}`;
  const stored = h.backend.records.get(stateKey);
  stored.data.subjects = [];
  stored.data.fingerprint = await stateFingerprint([], stored.data.appliedDeltaIds, stored.data.headFloorId);
  h.foundationRuntime.invalidate();
  h.runtime.invalidate();
  state = await h.runtime.refreshStatus();
  assert.ok(state.cseSubjects.length > 0, '界面采用可信 delta 的重放结果');
  assert.equal(state.mainCharacterDisplayName, '裴晚生');
  assert.equal(state.mainCharacterEntityId, h.backend.records.get(`chat-${CHAT}/v3-baseline-${root.baselineId}`).data.characterCard.entityId, '主角色只读投影必须来自既有 baseline');
  assert.equal(state.cseReplayDiagnostic.code, 'V3_CSE_REPLAY_MISMATCH');
});

test('浅层双语编译绑定唯一 user，A→B 分开，Core 后续冻结并记录 challenge', async () => {
  const tracked = entities.slice(0, 2);
  const envelope1 = createCseEnvelope({ floor: floor(FLOOR1, '第一楼'), floorMemory: memory(MEMORY1), baseline, currentState: null, trackedSubjects: tracked, entities });
  assert.deepEqual(envelope1.request.payload.trackedSubjects.map(item => item.name), ['林岚', '甲']);
  assert.deepEqual(envelope1.request.payload.knownPeople.map(item => item.name), ['林岚', '甲', '乙']);
  const first = await compileCseResponse({ response: { 人物: [{ 主体: '主角', 核心: [{ 内容: '谨慎', 可见性: '作者设定', 原因: '初始表现' }], 长期适应: [{ 内容: '保持戒备', 对谁: '乙', 可见性: '可观察', 原因: '冲突' }], 情境: { 内容: '紧张', 可见性: '私密', 原因: '当前危险' } }, { 主体: '甲', 长期适应: [{ 内容: '保护', 对谁: '乙' }, { 错误: true }] }] }, envelope: envelope1, previousCurrentState: null, now: NOW, deltaId: '99999999-1111-4111-8111-111111111111' });
  const userSnapshot = first.delta.subjectSnapshots.find(item => item.subjectEntityId === USER);
  const aSnapshot = first.delta.subjectSnapshots.find(item => item.subjectEntityId === A);
  assert.equal(first.delta.subjectSnapshots.filter(item => item.subjectEntityId === USER).length, 1);
  assert.equal(first.delta.subjectSnapshots.some(item => item.subjectEntityId === B), false, '已知 toward 对象不会被当成本楼完整追踪主体');
  assert.equal(userSnapshot.core[0].visibility, 'authorial');
  assert.equal(userSnapshot.adaptive[0].towardEntityId, B);
  assert.equal(aSnapshot.adaptive[0].towardEntityId, B, '可以指向本楼未追踪的已知人物');
  assert.equal(aSnapshot.adaptive[0].visibility, 'private', '缺失 visibility 必须绝对防全知');
  assert.equal(aSnapshot.adaptive[0].reason, '未提供依据', '缺 reason 的有效状态继续接收，但不能冒充已有正文依据');
  assert.equal(userSnapshot.core[0].reason, '初始表现', '模型明确给出的 reason 必须原样保留');
  assert.ok(first.isolated.some(item => item.code === 'V3_CSE_OPTIONAL_ITEM_INVALID'));
  const previous = { id: 'aaaaaaaa-1111-4111-8111-111111111111', subjects: first.delta.subjectSnapshots.map(({ changeSummary, coreChallenges, ...subject }) => subject) };
  const envelope2 = createCseEnvelope({ floor: floor(FLOOR2, '第二楼'), floorMemory: memory(MEMORY2), baseline, currentState: previous, trackedSubjects: tracked, entities });
  const second = await compileCseResponse({ response: { subjects: [{ subject: '你', core: ['鲁莽'], adaptive: [{ text: '信任', toward: '甲' }, { text: '戒备', toward: '乙' }] }] }, envelope: envelope2, previousCurrentState: previous, now: NOW, deltaId: 'bbbbbbbb-1111-4111-8111-111111111111' });
  const frozen = second.delta.subjectSnapshots.find(item => item.subjectEntityId === USER);
  assert.equal(frozen.core[0].text, '谨慎');
  assert.match(frozen.coreChallenges.join('|'), /鲁莽/);
  assert.deepEqual(frozen.adaptive.map(item => item.towardEntityId), [A, B]);
});

test('noMaterialChange 只由编译前后状态差异决定，模型自报不能覆盖实际结果', async () => {
  const tracked = [entities[0]];
  const firstEnvelope = createCseEnvelope({ floor: floor(FLOOR1, '第一楼'), floorMemory: memory(MEMORY1), baseline, currentState: null, trackedSubjects: tracked, entities });
  const first = await compileCseResponse({
    response: { subjects: [{ subject: '你', situational: [{ text: '保持戒备', visibility: 'private', reason: '第一楼证据', origin: 'floor' }] }] },
    envelope: firstEnvelope,
    previousCurrentState: null,
    now: NOW,
    deltaId: '12121212-1212-4121-8121-121212121212',
  });
  const previous = { id: '13131313-1313-4131-8131-131313131313', subjects: first.delta.subjectSnapshots };
  const secondEnvelope = createCseEnvelope({ floor: floor(FLOOR2, '第二楼'), floorMemory: memory(MEMORY2), baseline, currentState: previous, trackedSubjects: tracked, entities });
  const changed = await compileCseResponse({
    response: { noMaterialChange: true, subjects: [{ subject: '你', situational: [{ text: '已经放松', visibility: 'private', reason: '第二楼证据', origin: 'floor' }] }] },
    envelope: secondEnvelope,
    previousCurrentState: previous,
    now: NOW,
    deltaId: '14141414-1414-4141-8141-141414141414',
  });
  assert.equal(changed.delta.noMaterialChange, false, '实际快照有变化时不能接受模型自报的 true');
  const replay = await replayCurrentState({
    chatId: CHAT,
    narrativeGeneration: GEN,
    baselineId: baseline.id,
    floors: [floor(FLOOR1, '第一楼'), floor(FLOOR2, '第二楼')],
    floorMemories: [
      { ...memory(MEMORY1), floorId: FLOOR1, recordStatus: 'active' },
      { ...memory(MEMORY2), floorId: FLOOR2, recordStatus: 'active' },
    ],
    stateDeltas: [first.delta, changed.delta],
    now: NOW,
  });
  assert.deepEqual(replay.appliedDeltaIds, [first.delta.id, changed.delta.id]);
  assert.deepEqual(replay.subjects[0].situational.map(item => item.text), ['已经放松'], '变化快照仍照常进入重放结果');

  const unchanged = await compileCseResponse({
    response: { noMaterialChange: false, subjects: [{ subject: '你', situational: [{ text: '保持戒备', visibility: 'private', reason: '第一楼证据', origin: 'floor' }] }] },
    envelope: secondEnvelope,
    previousCurrentState: previous,
    now: NOW,
    deltaId: '15151515-1515-4151-8151-151515151515',
  });
  assert.equal(unchanged.delta.noMaterialChange, true, '实际快照无变化时仍由比较结果判为 true');
});

test('模型省略已有主体或分类时，compile 与 replay 都保留相应前态', async () => {
  const tracked = entities.slice(0, 2);
  const firstEnvelope = createCseEnvelope({ floor: floor(FLOOR1, '第一楼'), floorMemory: memory(MEMORY1), baseline, currentState: null, trackedSubjects: tracked, entities });
  const first = await compileCseResponse({
    response: { subjects: [
      { subject: '林岚', core: [{ reason: '第一楼', text: '谨慎', visibility: 'authorial' }], adaptive: [{ reason: '第一楼', text: '戒备甲', toward: '甲', visibility: 'private' }], situational: [{ reason: '第一楼', text: '紧张', visibility: 'private' }] },
      { subject: '甲', situational: [{ reason: '第一楼', text: '等候消息', visibility: 'private' }] },
    ] },
    envelope: firstEnvelope,
    previousCurrentState: null,
    now: NOW,
    deltaId: '19191919-1919-4191-8191-191919191919',
  });
  const previous = { id: '20202020-2020-4202-8202-202020202020', subjects: first.delta.subjectSnapshots };
  const secondEnvelope = createCseEnvelope({ floor: floor(FLOOR2, '第二楼'), floorMemory: memory(MEMORY2), baseline, currentState: previous, trackedSubjects: tracked, entities });
  const second = await compileCseResponse({
    response: { subjects: [{ subject: '林岚', situational: [{ reason: '第二楼', text: '已经放松', visibility: 'private' }] }] },
    envelope: secondEnvelope,
    previousCurrentState: previous,
    now: NOW,
    deltaId: '21212121-2121-4212-8212-212121212121',
  });
  const userSnapshot = second.delta.subjectSnapshots.find(item => item.subjectEntityId === USER);
  assert.deepEqual(userSnapshot.core.map(item => item.text), ['谨慎'], '省略 core 时沿用前态');
  assert.deepEqual(userSnapshot.adaptive.map(item => item.text), ['戒备甲'], '省略 adaptive 时沿用前态');
  assert.equal(second.delta.subjectSnapshots.some(item => item.subjectEntityId === A), false, '省略已有主体时不生成空状态覆盖前态');

  const replay = await replayCurrentState({
    chatId: CHAT,
    narrativeGeneration: GEN,
    baselineId: baseline.id,
    floors: [floor(FLOOR1, '第一楼'), floor(FLOOR2, '第二楼')],
    floorMemories: [{ ...memory(MEMORY1), floorId: FLOOR1, recordStatus: 'active' }, { ...memory(MEMORY2), floorId: FLOOR2, recordStatus: 'active' }],
    stateDeltas: [first.delta, second.delta],
    now: NOW,
  });
  assert.deepEqual(replay.subjects.find(item => item.subjectEntityId === USER).situational.map(item => item.text), ['已经放松']);
  assert.deepEqual(replay.subjects.find(item => item.subjectEntityId === A).situational.map(item => item.text), ['等候消息']);
});

test('已知 toward 同名仍按歧义失败隔离，不猜测绑定', async () => {
  const ambiguous = [...entities, { id: 'dddddddd-1111-4111-8111-111111111111', entityType: 'person', displayName: '丙', aliases: [{ name: '乙' }], specialRole: 'none' }];
  const envelope = createCseEnvelope({ floor: floor(FLOOR1, '歧义楼'), floorMemory: memory(MEMORY1), baseline, currentState: null, trackedSubjects: [entities[0]], entities: ambiguous });
  const result = await compileCseResponse({ response: { subjects: [{ subject: '你', adaptive: [{ text: '警惕', toward: '乙', visibility: 'observable' }] }] }, envelope, previousCurrentState: null, now: NOW, deltaId: 'eeeeeeee-1111-4111-8111-111111111111' });
  assert.deepEqual(result.delta.subjectSnapshots[0].adaptive, []);
  assert.ok(result.isolated.some(item => item.code === 'V3_CSE_TOWARD_UNBOUND'));
});

test('他人状态移入独立作者态上下文并保持隐私过滤；空 delta 也可重放为已分析', async () => {
  const current = { subjects: [
    { subjectEntityId: USER, core: [], adaptive: [], situational: [{ text: '用户私心', visibility: 'private', reason: '私密', origin: 'floor', towardEntityId: null, sourceFloorId: FLOOR1, sourceDeltaId: null }] },
    { subjectEntityId: A, core: [{ text: '作者设定', visibility: 'authorial', reason: '卡', origin: 'baseline', towardEntityId: null, sourceFloorId: null, sourceDeltaId: null }], adaptive: [], situational: [{ text: '公开动作', visibility: 'observable', reason: '看见', origin: 'floor', towardEntityId: null, sourceFloorId: FLOOR1, sourceDeltaId: null }] },
  ] };
  const envelope = createCseEnvelope({ floor: floor(FLOOR1, '正文'), floorMemory: memory(MEMORY1), baseline, currentState: current, trackedSubjects: entities.slice(0, 2), entities });
  const forUser = envelope.request.payload.previousState.find(item => item.subject === '林岚');
  assert.equal('publicStateOfOthers' in forUser, false);
  assert.deepEqual(Object.keys(forUser), ['subject', 'ownState']);
  const authorialForA = envelope.request.payload.authorialOtherStateContext.find(item => item.subject === '甲');
  assert.deepEqual(authorialForA.core, []);
  assert.deepEqual(authorialForA.situational.map(item => item.text), ['公开动作']);
  const compiled = await compileCseResponse({ response: { noMaterialChange: true }, envelope, previousCurrentState: null, now: NOW, deltaId: 'cccccccc-1111-4111-8111-111111111111' });
  assert.equal(compiled.delta.noMaterialChange, true);
  const replay = await replayCurrentState({ chatId: CHAT, narrativeGeneration: GEN, baselineId: baseline.id, floors: [floor(FLOOR1, '正文')], floorMemories: [{ ...memory(MEMORY1), floorId: FLOOR1, recordStatus: 'active' }], stateDeltas: [compiled.delta], now: NOW });
  assert.deepEqual(replay.appliedDeltaIds, [compiled.delta.id]);
});

test('缺失或未知 visibility 都编译为 private，不进入他人作者态连续性上下文', async () => {
  const sourceEnvelope = createCseEnvelope({ floor: floor(FLOOR1, '私密楼'), floorMemory: memory(MEMORY1), baseline, currentState: null, trackedSubjects: [entities[1]], entities });
  const compiled = await compileCseResponse({ response: { subjects: [{ subject: '甲', situational: [{ text: '没说出的念头' }, { text: '未知可见性', visibility: 'omniscient' }, { text: '确实可见', visibility: 'observable' }] }] }, envelope: sourceEnvelope, previousCurrentState: null, now: NOW, deltaId: 'ffffffff-1111-4111-8111-111111111111' });
  assert.deepEqual(compiled.delta.subjectSnapshots[0].situational.map(item => item.visibility), ['private', 'private', 'observable']);
  const currentState = { subjects: [
    { subjectEntityId: USER, core: [], adaptive: [], situational: [] },
    ...compiled.delta.subjectSnapshots.map(({ changeSummary, coreChallenges, ...subject }) => subject),
  ] };
  const observerEnvelope = createCseEnvelope({ floor: floor(FLOOR2, '观察楼'), floorMemory: memory(MEMORY2), baseline, currentState, trackedSubjects: [entities[0]], entities });
  const contextualItems = observerEnvelope.request.payload.authorialOtherStateContext.flatMap(subject => subject.situational.map(item => item.text));
  assert.deepEqual(contextualItems, ['确实可见']);
});

test('直接 baseline 捕获在 official 宿主缺少世界书 API 时安全降级', async () => {
  const ctx = { name1: '用户', name2: '角色', characterId: 0, characters: [{ name: '角色', data: {} }], chat: [] };
  const hostAdapter = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => ctx } } });
  const result = await captureCseBaseline({ hostAdapter, chatId: CHAT, narrativeGeneration: GEN, now: NOW });
  assert.equal(result.baseline.userPersona.name, '用户');
  assert.deepEqual(result.baseline.worldInfoSources, []);
});
