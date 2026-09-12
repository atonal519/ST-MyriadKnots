import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHostAdapter } from '../src/v3/host-adapter.js';
import { createFoundationStore } from '../src/v3/foundation-store.js';
import { createFoundationRuntime } from '../src/v3/foundation-runtime.js';
import { createV3MemoryRuntime } from '../src/v3/memory-runtime.js';
import { EXTRACTOR_SYSTEM_PROMPT } from '../src/v3/extractor.js';
import {
  CSE_CALIBRATION_VERSION, CSE_COMPILER_VERSION, CSE_PROMPT_VERSION, CSE_SYSTEM_PROMPT, buildCseSystemPrompt, captureCseBaseline, compileCseResponse, createCseEnvelope, createManualCseCorrection, deriveCseTimeline, replayCurrentState, runCseRequest, selectTrackedSubjects,
} from '../src/v3/cse-engine.js';
import { stateFingerprint, validateStateDeltaRecord } from '../src/v3/cse-schema.js';
import { scanAssistantCandidates } from '../src/v3/foundation-domain.js';

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
const legacyScanner = async (chat, options) => {
  const candidates = await scanAssistantCandidates(chat, options);
  return Object.freeze(candidates.map((candidate, index) => index < candidates.length - 1 || candidate.stabilityProof
    ? Object.freeze({ ...candidate, stabilityProof: Object.freeze({ kind: 'nextUser', messageIndex: candidate.hostLocator.messageIndex + 1, fingerprint: `sha256:${createHash('sha256').update(`legacy-cse-test-${index}`).digest('hex')}` }) })
    : candidate));
};
const uuidFactory = () => { let value = 100; return () => `${(++value).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`; };

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(message);
}

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

function runtimeHarness({ cse, extractor, host = 'official', backendOptions, sharedBackend = null, clock = () => new Date(NOW), chat = null, chatWorldInfo = null, filterWorldInfoSources = sources => sources } = {}) {
  const handlers = new Map(), calls = [], backend = sharedBackend ?? backendHarness(backendOptions);
  let enabled = true;
  const books = new Map([['当前书', { entries: { 1: { uid: 1, constant: true, content: '<content>启用作者设定</content>' }, 2: { uid: 2, constant: true, content: '禁用支线', disable: true } } }], ['聊天书', { entries: { 4: { uid: 4, constant: true, content: '聊天书作者设定' } } }], ['未链接书', { entries: { 3: { uid: 3, constant: true, content: '不得进入基线' } } }]]);
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
  const foundationRuntime = createFoundationRuntime({ hostAdapter, store, contextProvider: () => context, isEnabled: () => enabled, scanCandidates: legacyScanner, now: clock, newUuid: uuidFactory(), logger: { warn() {} } });
  const generateUtilityTask = async options => {
    calls.push({ ...options, testRoute: 'utility' });
    assert.equal(options.systemPrompt, EXTRACTOR_SYSTEM_PROMPT, 'Extractor 必须只走摘要路由');
    return extractor ? extractor(options, calls) : { jsonData: { summary: '裴晚生提醒用户带伞。', people: [{ name: '你', role: 'user' }, { name: '裴晚生' }], commitments: [{ speaker: '裴晚生', targets: ['你'], content: '提醒带伞' }] }, taskMetadata: { source: 'test-utility', sourceLabel: '测试摘要 API', model: 'summary-mock' } };
  };
  const generateAnalysisTask = async options => {
    calls.push({ ...options, testRoute: 'analysis' });
    assert.equal(options.systemPrompt, CSE_SYSTEM_PROMPT, 'CSE 必须只走分析路由');
    return cse ? cse(options, calls) : { jsonData: { subjects: [{ subject: '主角', situational: [{ text: '记得带伞', visibility: 'private', reason: '收到提醒' }] }] }, taskMetadata: { source: 'test-analysis', sourceLabel: '测试分析 API', model: 'analysis-mock' } };
  };
  const runtime = createV3MemoryRuntime({ foundationRuntime, store, hostAdapter, generateAnalysisTask, generateUtilityTask, isEnabled: () => enabled, filterWorldInfoSources, sanitizerOptions: () => ({ keepTags: 'content' }), now: clock, newUuid: uuidFactory(), logger: { warn() {} } });
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

test('baseline 一次冻结；摘要重提不自动改 CSE，显式重分析才读取新来源', async () => {
  const h = runtimeHarness({ host: 'luker' });
  let state = await h.runtime.start().then(() => h.runtime.extractNext());
  const firstMemoryId = state.floors[0].memoryId;
  const firstDeltaId = state.cseFloors[0].deltaId;
  assert.equal(state.rememberedCount, 1);
  assert.ok(state.baselineId);
  const root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  const saved = h.backend.records.get(`chat-${CHAT}/v3-baseline-${root.baselineId}`).data;
  assert.deepEqual(saved.worldInfoSources.map(item => item.content), ['启用作者设定']);
  assert.equal(saved.worldInfoSources.some(item => /禁用支线|不得进入基线/.test(item.content)), false);
  const fingerprint = saved.fingerprint;
  h.context.powerUserSettings.persona_description = '事后变化不得漂移';
  h.context.characters[0].data.description = '事后更新的角色描述';
  h.context.chatMetadata.note_prompt = '事后更新的作者注释';
  h.context.chat[0].mes = '手动重提后的作者输入';
  state = await h.runtime.extractFloor(state.floors[0].floorId);
  assert.notEqual(state.floors[0].memoryId, firstMemoryId, '明确重提应产生绑定新 USER 快照的新 memory id');
  assert.equal(state.cseFloors[0].deltaId, firstDeltaId, '明确重提摘要不得自动替换已落盘 CSE');
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 1);
  state = await h.runtime.retryStateAnalysis(state.floors[0].floorId);
  assert.notEqual(state.cseFloors[0].deltaId, firstDeltaId, '只有显式 CSE 重分析才替换目标楼');
  const latestRequest = JSON.parse(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).at(-1).taskMessages[0].content);
  assert.deepEqual(latestRequest.payload.currentUserInput, { source: 'currentUserInput', messages: [{ sourceSnapshotIndex: 0, messageIndex: 0, content: '手动重提后的作者输入' }] });
  assert.equal(latestRequest.payload.relevantBaseline.userPersona.description, '事后变化不得漂移');
  assert.equal(latestRequest.payload.relevantBaseline.characterCard.description, '事后更新的角色描述');
  assert.equal(latestRequest.payload.relevantBaseline.authorNote.content, '事后更新的作者注释');
  assert.ok(latestRequest.payload.evidenceSourceCatalog.some(item => item.source === 'authorNote' && item.kind === 'authorialReference'));
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
  assert.deepEqual(request.payload.currentUserInput, { source: 'currentUserInput', messages: [{ sourceSnapshotIndex: 0, messageIndex: 0, content: '继续' }] });
  assert.ok(request.payload.evidenceSourceCatalog.some(item => item.source === 'currentUserInput' && item.kind === 'userInput'));
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

test('摘要与 CSE 复用目标楼冻结变量快照，宿主后续改值不倒灌且无变量时不增空字段', async () => {
  const target = { ...assistant('裴晚生提醒你带伞。'), swipes: ['第一 swipe 不采用。', '裴晚生提醒你带伞。'], swipe_id: 1,
    variables: [{ stat_data: { 裴晚生: { 情绪: '错误 swipe' } }, wrongSwipeOnly: true }, { stat_data: { 裴晚生: { 情绪: '担忧' } }, ejsSaved: { weather: '雨' } }] };
  const latest = { ...assistant('用于确认上一楼稳定。'), variables: [{ stat_data: { 裴晚生: { 情绪: '最新楼' } }, latestOnly: true }] };
  let capturedExtractorPayload;
  const h = runtimeHarness({
    chat: [user('继续'), target, latest],
    extractor: options => {
      capturedExtractorPayload = JSON.parse(options.taskMessages[0].content).payload;
      target.variables[0].stat_data.裴晚生.情绪 = '事后平静';
      return { jsonData: { summary: '裴晚生担忧用户淋雨并提醒带伞。', people: [{ name: '你', role: 'user' }, { name: '裴晚生' }], commitments: [{ speaker: '裴晚生', targets: ['你'], content: '提醒带伞' }] } };
    },
  });
  const state = await h.runtime.start().then(() => h.runtime.extractNext());
  assert.deepEqual(capturedExtractorPayload.auxiliaryStateSnapshot, { stat_data: { 裴晚生: { 情绪: '担忧' } }, ejsSaved: { weather: '雨' } });
  const stored = h.runtime.getState().floors.find(item => item.floorId === state.floors[0].floorId).memory;
  assert.deepEqual(stored.sourceVariableReference, capturedExtractorPayload.auxiliaryStateSnapshot);
  const cseRequest = JSON.parse(h.calls.find(call => call.systemPrompt === CSE_SYSTEM_PROMPT).taskMessages[0].content);
  assert.deepEqual(cseRequest.payload.auxiliaryStateSnapshot, capturedExtractorPayload.auxiliaryStateSnapshot);
  assert.equal(cseRequest.payload.evidenceSourceCatalog.some(item => item.source === 'auxiliaryStateSnapshot'), false, '辅助变量不得升级为可引用证据源');
  assert.equal(JSON.stringify(cseRequest.payload).includes('事后平静'), false);

  const without = runtimeHarness();
  await without.runtime.start().then(() => without.runtime.extractNext());
  const requests = without.calls.map(call => JSON.parse(call.taskMessages[0].content));
  assert.ok(requests.every(request => !Object.hasOwn(request.payload, 'auxiliaryStateSnapshot')), '无变量时保持原有 payload 形状');
});

test('人工纠正以末 delta 为锚不可变替换，支持增删清空 core、连续多人、冷读与后续 CSE 前态', async () => {
  const h = runtimeHarness({
    cse: options => {
      const request = JSON.parse(options.taskMessages[0].content);
      if (request.payload.canonicalContent.includes('后续楼')) return { jsonData: { noMaterialChange: true } };
      return { jsonData: { subjects: [
        { subject: '林岚', core: [{ text: '谨慎', visibility: 'authorial', reason: '既有表现' }], situational: [{ text: '记得带伞', visibility: 'private', reason: '收到提醒' }] },
        { subject: '裴晚生', situational: [{ text: '等待回应', visibility: 'observable', reason: '已经提醒' }] },
      ] } };
    },
  });
  let state = await h.runtime.start().then(() => h.runtime.extractNext());
  const initialCalls = h.calls.length;
  const initialRoot = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-root`));
  const initialCheckpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${initialRoot.data.headCheckpointId}`).data;
  const initialDeltaId = initialCheckpoint.producedRefs.stateDeltas.at(-1);
  const initialDeltaKey = `chat-${CHAT}/v3-state-delta-${initialDeltaId}`;
  const initialDelta = structuredClone(h.backend.records.get(initialDeltaKey).data);
  const savedBaseline = h.backend.records.get(`chat-${CHAT}/v3-baseline-${initialRoot.data.baselineId}`).data;
  const initialUser = state.cseSubjects.find(subject => subject.subjectEntityId === savedBaseline.userPersona.entityId);
  const initialChar = state.cseSubjects.find(subject => subject.subjectEntityId === savedBaseline.characterCard.entityId);
  assert.ok(initialUser && initialChar);
  const userEntityId = initialUser.subjectEntityId;
  const charEntityId = initialChar.subjectEntityId;

  const editPayload = (subject, patch = {}) => ({
    expectedCurrentStateId: state.currentStateId,
    expectedCurrentStateFingerprint: state.currentStateFingerprint,
    core: subject.core.map(item => ({ itemId: item.id, text: item.text, visibility: item.visibility, towardEntityId: null })),
    adaptive: subject.adaptive.map(item => ({ itemId: item.id, text: item.text, visibility: item.visibility, towardEntityId: item.towardEntityId ?? null })),
    situational: subject.situational.map(item => ({ itemId: item.id, text: item.text, visibility: item.visibility, towardEntityId: item.towardEntityId ?? null })),
    ...patch,
  });
  const staleReceipt = { id: state.currentStateId, fingerprint: state.currentStateFingerprint };
  state = await h.runtime.correctSubjectState(userEntityId, editPayload(initialUser, {
    core: [],
    adaptive: [{ itemId: null, text: '逐渐信任裴晚生', visibility: 'private', towardEntityId: initialChar.subjectEntityId }],
    situational: [{ itemId: initialUser.situational[0].id, text: '已经收好雨伞', visibility: 'private', towardEntityId: null }, { itemId: null, text: '准备出门', visibility: 'observable', towardEntityId: null }],
  }));
  assert.equal(h.calls.length, initialCalls, '人工保存不得调用模型');
  const correctedUser = state.cseSubjects.find(subject => subject.subjectEntityId === userEntityId);
  assert.deepEqual(correctedUser.core, [], 'manual subject 标记必须允许清空已有 core');
  assert.deepEqual(correctedUser.adaptive.map(item => [item.text, item.towardEntityId, item.origin, item.reason]), [['逐渐信任裴晚生', initialChar.subjectEntityId, 'manual', '用户纠正当前状态']]);
  assert.deepEqual(correctedUser.situational.map(item => item.text), ['已经收好雨伞', '准备出门']);
  let root = h.backend.records.get(`chat-${CHAT}/v3-root`);
  let checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.data.headCheckpointId}`).data;
  let replacement = h.backend.records.get(`chat-${CHAT}/v3-state-delta-${checkpoint.producedRefs.stateDeltas.at(-1)}`).data;
  assert.equal(replacement.supersedes, initialDeltaId);
  assert.equal(replacement.previousCurrentStateId, initialDelta.previousCurrentStateId, '替代 delta 必须保留原锚前态引用');
  assert.deepEqual(replacement.source.manualSubjectEntityIds, [userEntityId]);
  const oldCharItem = initialDelta.subjectSnapshots.find(subject => subject.subjectEntityId === initialChar.subjectEntityId).situational[0];
  const rebasedCharItem = replacement.subjectSnapshots.find(subject => subject.subjectEntityId === initialChar.subjectEntityId).situational[0];
  assert.equal(rebasedCharItem.id, oldCharItem.id, '纠正一人不得改写同楼其他人物的已存状态项');
  assert.equal(rebasedCharItem.sourceDeltaId, oldCharItem.sourceDeltaId, '旧 sourceDeltaId 作为历史出处保留');
  assert.deepEqual(h.backend.records.get(initialDeltaKey).data, initialDelta, '旧 delta 不得被原地修改');

  const currentChar = state.cseSubjects.find(subject => subject.subjectEntityId === initialChar.subjectEntityId);
  const firstManualUserItemId = correctedUser.adaptive[0].id;
  state = await h.runtime.correctSubjectState(initialChar.subjectEntityId, editPayload(currentChar, {
    core: [{ itemId: null, text: '克制负责', visibility: 'authorial', towardEntityId: null }],
    situational: [],
  }));
  assert.deepEqual(state.cseSubjects.find(subject => subject.subjectEntityId === userEntityId).adaptive.map(item => item.text), ['逐渐信任裴晚生'], '连续修正另一人物必须保留此前人工状态');
  assert.deepEqual(state.cseSubjects.find(subject => subject.subjectEntityId === initialChar.subjectEntityId).core.map(item => item.text), ['克制负责']);
  checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${h.backend.records.get(`chat-${CHAT}/v3-root`).data.headCheckpointId}`).data;
  replacement = h.backend.records.get(`chat-${CHAT}/v3-state-delta-${checkpoint.producedRefs.stateDeltas.at(-1)}`).data;
  assert.deepEqual(new Set(replacement.source.manualSubjectEntityIds), new Set([userEntityId, initialChar.subjectEntityId]));
  const twiceRebasedUserItem = replacement.subjectSnapshots.find(subject => subject.subjectEntityId === userEntityId).adaptive[0];
  assert.equal(twiceRebasedUserItem.id, firstManualUserItemId, '连续修正另一人物不得改写已固定的人工条目');

  const withCore = state.cseSubjects.find(subject => subject.subjectEntityId === initialChar.subjectEntityId);
  state = await h.runtime.correctSubjectState(initialChar.subjectEntityId, editPayload(withCore, { core: [] }));
  assert.deepEqual(state.cseSubjects.find(subject => subject.subjectEntityId === initialChar.subjectEntityId).core, [], '重复人工修正仍须允许清空 core');
  const rootPutsBeforeNoop = h.backend.getRootPuts();
  const noChangeSubject = state.cseSubjects.find(subject => subject.subjectEntityId === userEntityId);
  state = await h.runtime.correctSubjectState(userEntityId, editPayload(noChangeSubject));
  assert.equal(h.backend.getRootPuts(), rootPutsBeforeNoop, '同内容保存不得写新 root');

  await assert.rejects(() => h.runtime.correctSubjectState(userEntityId, { ...editPayload(noChangeSubject), expectedCurrentStateId: staleReceipt.id, expectedCurrentStateFingerprint: staleReceipt.fingerprint }), error => error.code === 'V3_CSE_MANUAL_STALE');
  assert.equal(h.backend.getRootPuts(), rootPutsBeforeNoop, '过期草稿不得覆盖当前状态');

  const cold = runtimeHarness({ sharedBackend: h.backend, chat: h.context.chat });
  state = await cold.runtime.start();
  assert.deepEqual(state.cseSubjects.find(subject => subject.subjectEntityId === userEntityId).adaptive.map(item => item.text), ['逐渐信任裴晚生']);
  assert.deepEqual(state.cseSubjects.find(subject => subject.subjectEntityId === initialChar.subjectEntityId).core, []);
  h.context.chat.push(assistant('后续楼用于读取人工纠正前态。'), assistant('确认后续楼稳定。'));
  await h.runtime.refreshStatus();
  await h.runtime.extractNext();
  const nextRequest = JSON.parse(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).at(-1).taskMessages[0].content);
  assert.ok(nextRequest.payload.previousState.some(subject => subject.subject === '林岚' && subject.ownState.adaptive.some(item => item.text === '逐渐信任裴晚生')), '后续模型分析必须读取人工纠正后的前态');
  assert.ok(nextRequest.payload.previousState.some(subject => subject.subject === '林岚' && subject.coreUserEdited === true && subject.ownState.core.length === 0), '人工清空 Core 后也必须继续标记为用户已编辑，不能被旧 baseline 自动补回');
  assert.equal(h.backend.records.get(`chat-${CHAT}/v3-root`).revision > initialRoot.revision, true);
});

test('人工纠正可追加末 delta 未携带主体，并识别情境对象的无变、改向与清空', async () => {
  const envelope = createCseEnvelope({ floor: floor(FLOOR1, '甲在场。'), floorMemory: memory(MEMORY1), baseline, currentState: null, trackedSubjects: [entities[1]], entities });
  const compiled = await compileCseResponse({
    response: { subjects: [{ subject: '甲', situational: [{ text: '正在观察', visibility: 'observable', reason: '正文' }] }] },
    envelope,
    previousCurrentState: null,
    now: NOW,
    deltaId: '13131313-1313-4131-8131-131313131313',
  });
  assert.equal(compiled.delta.subjectSnapshots.some(subject => subject.subjectEntityId === B), false);
  const currentState = {
    subjects: [
      ...compiled.delta.subjectSnapshots.map(subject => ({ subjectEntityId: subject.subjectEntityId, core: subject.core, adaptive: subject.adaptive, situational: subject.situational })),
      { subjectEntityId: B, core: [], adaptive: [], situational: [] },
    ],
  };
  const corrected = await createManualCseCorrection({
    anchorDelta: compiled.delta,
    currentState,
    subjectEntityId: B,
    edits: { core: [], adaptive: [], situational: [{ itemId: null, text: '等待甲的决定', visibility: 'private', towardEntityId: A }] },
    allowedTowardEntityIds: [A, B],
    deltaId: '14141414-1414-4141-8141-141414141414',
    now: NOW,
  });
  assert.equal(corrected.status, 'ready');
  assert.equal(corrected.delta.subjectSnapshots.at(-1).subjectEntityId, B);
  assert.deepEqual(corrected.delta.source.manualSubjectEntityIds, [B]);
  const replayed = await replayCurrentState({
    chatId: CHAT,
    narrativeGeneration: GEN,
    baselineId: baseline.id,
    floors: [floor(FLOOR1, '甲在场。')],
    floorMemories: [{ ...memory(MEMORY1), floorId: FLOOR1, recordStatus: 'active' }],
    stateDeltas: [corrected.delta],
    now: NOW,
  });
  const replayedB = replayed.subjects.find(subject => subject.subjectEntityId === B);
  assert.deepEqual(replayedB.situational.map(item => [item.text, item.towardEntityId]), [['等待甲的决定', A]]);
  const sameEdits = { core: [], adaptive: [], situational: replayedB.situational.map(item => ({ itemId: item.id, text: item.text, visibility: item.visibility, towardEntityId: item.towardEntityId })) };
  const unchanged = await createManualCseCorrection({ anchorDelta: corrected.delta, currentState: replayed, subjectEntityId: B, edits: sameEdits, allowedTowardEntityIds: [A, B], deltaId: '15151515-1414-4141-8141-141414141414', now: NOW });
  assert.equal(unchanged.status, 'unchanged', '情境对象未变时不得误建人工 delta');
  const redirected = await createManualCseCorrection({ anchorDelta: corrected.delta, currentState: replayed, subjectEntityId: B, edits: { ...sameEdits, situational: [{ ...sameEdits.situational[0], towardEntityId: B }] }, allowedTowardEntityIds: [A, B], deltaId: '16161616-1414-4141-8141-141414141414', now: NOW });
  const redirectedB = redirected.delta.subjectSnapshots.find(subject => subject.subjectEntityId === B);
  assert.equal(redirectedB.situational[0].towardEntityId, B, '只改同一文字的对象也必须形成变更');
  const redirectedCurrent = { ...replayed, subjects: replayed.subjects.map(subject => subject.subjectEntityId === B ? redirectedB : subject) };
  const cleared = await createManualCseCorrection({ anchorDelta: redirected.delta, currentState: redirectedCurrent, subjectEntityId: B, edits: { ...sameEdits, situational: [{ itemId: redirectedB.situational[0].id, text: '等待甲的决定', visibility: 'private', towardEntityId: null }] }, allowedTowardEntityIds: [A, B], deltaId: '17171717-1414-4141-8141-141414141414', now: NOW });
  assert.equal(cleared.status, 'ready'); assert.equal(cleared.delta.subjectSnapshots.find(subject => subject.subjectEntityId === B).situational[0].towardEntityId, null, '清空对象必须持久化为 null');
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

test('作者注释进入最新请求与证据目录，但不能单独作为 Core 新增依据', async () => {
  const requestSources = {
    userPersona: { ...baseline.userPersona, description: '最新用户设定' },
    characterCard: { ...baseline.characterCard, description: '最新角色设定' },
    worldInfoSources: [],
    authorNote: { content: '后续写作时让甲更加果断。' },
    fingerprint: 'sha256:source-snapshot',
  };
  const envelope = createCseEnvelope({ floor: floor(FLOOR1, '甲停在门前。'), floorMemory: memory(MEMORY1), baseline, currentState: null, trackedSubjects: [entities[1]], entities, requestSources });
  assert.equal(envelope.request.payload.relevantBaseline.userPersona.description, '最新用户设定');
  assert.equal(envelope.request.payload.relevantBaseline.authorNote.content, requestSources.authorNote.content);
  assert.ok(envelope.request.payload.evidenceSourceCatalog.some(item => item.source === 'authorNote' && item.kind === 'authorialReference'));
  assert.equal(envelope.scope.sourceSnapshotFingerprint, requestSources.fingerprint);
  const compiled = await compileCseResponse({
    response: { subjects: [{ subject: '甲', additions: { core: [{ text: '性格果断', evidence: [{ source: 'authorNote', quote: '让甲更加果断' }] }] } }] },
    envelope,
    previousCurrentState: null,
    now: NOW,
    deltaId: '90909090-1111-4111-8111-909090909090',
  });
  assert.equal(compiled.delta.subjectSnapshots[0].core.length, 0);
  assert.ok(compiled.isolated.some(item => item.code === 'V3_CSE_CALIBRATION_EVIDENCE_INSUFFICIENT'));

  const legacyDirect = await compileCseResponse({
    response: { subjects: [{ subject: '甲', core: [{ text: '性格果断', evidence: [{ source: 'authorNote', quote: '让甲更加果断' }] }] }] },
    envelope,
    previousCurrentState: null,
    now: NOW,
    deltaId: '91919191-1111-4111-8111-919191919191',
  });
  assert.equal(legacyDirect.delta.subjectSnapshots[0].core.length, 0, '旧 direct Core 也不得绕过 authorNote 证据边界');
  assert.ok(legacyDirect.isolated.some(item => item.code === 'V3_CSE_CALIBRATION_EVIDENCE_INSUFFICIENT'));

  const groundedDirect = await compileCseResponse({
    response: { subjects: [{ subject: '甲', core: [{ text: '遵循最新角色设定', evidence: [{ source: 'characterCard', quote: '最新角色设定' }] }] }] },
    envelope,
    previousCurrentState: null,
    now: NOW,
    deltaId: '92929292-1111-4111-8111-929292929292',
  });
  assert.deepEqual(groundedDirect.delta.subjectSnapshots[0].core.map(item => item.text), ['遵循最新角色设定'], '作者注释存在时，有其他明确作者设定证据的旧 direct Core 仍可兼容');
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

test('稀疏 FloorMemory 不削弱正文，明确正文状态可编译且提示词与编译器版本同步升级', async () => {
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
  assert.equal(CSE_PROMPT_VERSION, 'qqj-v3-cse-prompt-15');
  assert.equal(CSE_COMPILER_VERSION, 'qqj-v3-cse-prompt-2/calibration-compiler-10');
  assert.match(CSE_SYSTEM_PROMPT, /单次情绪、动作或台词默认只支持 Situational/);
  assert.match(CSE_SYSTEM_PROMPT, /人物被提及不等于本人在场/);
  assert.match(CSE_SYSTEM_PROMPT, /这条主要回答人物现在怎样、处境如何，还是此刻怎样对待某人/);
  assert.match(CSE_SYSTEM_PROMPT, /另一人只是背景、原因或事件参与者，还是这项态度或相处反应的明确对象/);
  assert.match(CSE_SYSTEM_PROMPT, /两条独立且分别有正文依据的信息，需要拆开表达，还是同一信息的重复描述/);
  assert.match(CSE_SYSTEM_PROMPT, /不能只因一个行为有受事者就自动判为关系态度，也不能把行为一律排除出关系反应/);
  assert.match(CSE_SYSTEM_PROMPT, /对各方使用同一判断标准/);
  assert.match(CSE_SYSTEM_PROMPT, /private 只表示可见性，明确的私密态度仍可填写 toward/);
  assert.match(CSE_SYSTEM_PROMPT, /previousState 中旧 toward 也必须按本楼证据审视，不得盲从/);
  assert.match(CSE_SYSTEM_PROMPT, /单方 A→B 不得自动镜像成 B→A/);
  assert.match(CSE_SYSTEM_PROMPT, /最新作者设定、明确用户纠正和本楼正文/);
  assert.match(CSE_SYSTEM_PROMPT, /根级 changeSummary\/summary 不会被当作人物状态/);
  assert.equal(compiled.delta.source.calibrationVersion, CSE_CALIBRATION_VERSION);
  assert.throws(() => validateStateDeltaRecord({ ...compiled.delta, source: { ...compiled.delta.source, calibrationVersion: 2 } }, { expectedChatId: CHAT }), error => error.code === 'V3_STATEDELTA_INVALID');
  assert.match(CSE_SYSTEM_PROMPT, /未提供依据/);
  assert.doesNotMatch(CSE_SYSTEM_PROMPT, /"noMaterialChange"/);
});

test('生产 CSE 请求 seam 固定样例可并存自身无对象与行为关系对象，且自定义引导不覆盖固定边界合同', async () => {
  const envelope = createCseEnvelope({
    floor: floor(FLOOR1, '甲困倦放松地闭眼入睡；乙伸手叫醒他时，他立刻推开对方的手，明确说“别碰我”。'),
    floorMemory: memory(MEMORY1),
    baseline,
    currentState: null,
    trackedSubjects: [entities[1]],
    entities,
  });
  let sentSystemPrompt = '';
  const result = await runCseRequest({
    generateAnalysisTask: async options => {
      sentSystemPrompt = options.systemPrompt;
      return { jsonData: { subjects: [{ subject: '甲', situational: [
        { text: '困倦放松，正在入睡', visibility: 'private', reason: '正文写出困倦放松并闭眼入睡' },
        { text: '拒绝乙触碰', toward: '乙', visibility: 'observable', reason: '推开乙的手并明确说别碰我' },
      ] }] } };
    },
    envelope,
    previousCurrentState: null,
    now: NOW,
    deltaId: '25252525-2525-4252-8252-252525252525',
    promptGuidance: '自定义人物状态分析要求',
  });
  assert.match(sentSystemPrompt, /自定义人物状态分析要求/);
  assert.doesNotMatch(sentSystemPrompt, /你是“千千结”的人物状态理解器/);
  assert.match(sentSystemPrompt, /这条主要回答人物现在怎样、处境如何，还是此刻怎样对待某人/);
  assert.match(sentSystemPrompt, /关系反应可以通过明确指向对方的言语和行为表现/);
  assert.deepEqual(result.delta.subjectSnapshots[0].situational.map(item => [item.text, item.towardEntityId, item.visibility]), [
    ['困倦放松，正在入睡', null, 'private'],
    ['拒绝乙触碰', B, 'observable'],
  ]);
});

test('CSE Phase A 并发写入保留记录，完成后仍按 run → checkpoint → root 屏障提交且同 root 不整图回读', async () => {
  const phaseTypes = new Set(['entity', 'stateDelta', 'currentState', 'index']);
  const expectedPhaseTypes = new Set(['stateDelta', 'currentState', 'index']);
  const observedPhaseTypes = new Set();
  let measuring = false;
  let activePuts = 0;
  let maximumPuts = 0;
  let phaseStarts = 0;
  let phaseCompletions = 0;
  let releasePhase;
  let firstWaveResolve;
  let readMarker = 0;
  let backendReadMarker = 0;
  const phaseGate = new Promise(resolve => { releasePhase = resolve; });
  const firstWave = new Promise(resolve => { firstWaveResolve = resolve; });
  const barriers = [];
  let h;
  h = runtimeHarness({
    cse: () => {
      measuring = true;
      readMarker = h.readModes.length;
      backendReadMarker = h.backend.getCalls.length;
      return { jsonData: { noMaterialChange: true } };
    },
    backendOptions: {
      beforePut: async ({ data }) => {
        if (!measuring) return;
        if (phaseTypes.has(data.recordType)) {
          phaseStarts += 1;
          observedPhaseTypes.add(data.recordType);
          activePuts += 1;
          maximumPuts = Math.max(maximumPuts, activePuts);
          if ([...expectedPhaseTypes].every(type => observedPhaseTypes.has(type))) firstWaveResolve();
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
  assert.equal(maximumPuts, expectedPhaseTypes.size);
  assert.equal(barriers.length, 0, '首批 Phase A 未完成前不得写 run/checkpoint/root');
  releasePhase();
  const state = await pending;

  assert.equal(state.cseReady, true);
  assert.deepEqual([...observedPhaseTypes].sort(), [...expectedPhaseTypes].sort());
  assert.deepEqual(barriers.map(item => item.type), ['run', 'checkpoint', 'root']);
  assert.ok(barriers.every(item => item.activePuts === 0 && item.phaseCompletions === item.phaseStarts));
  assert.deepEqual(h.readModes.slice(readMarker), []);
  assert.equal(h.backend.getCalls.slice(backendReadMarker).filter(key => key === 'v3-root').length >= 1, true);
});

test('CSE 等待模型期间只追加后楼及后楼摘要时按原前缀提交，并保留最新后缀图', async () => {
  let releaseCse;
  let markStarted;
  const cseStarted = new Promise(resolve => { markStarted = resolve; });
  const h = runtimeHarness({
    cse: () => new Promise(resolve => {
      releaseCse = () => resolve({ jsonData: { noMaterialChange: true } });
      markStarted();
    }),
  });
  const firstPending = h.runtime.start().then(() => h.runtime.extractNext());
  await cseStarted;
  const targetFloorId = h.runtime.getState().floors[0].floorId;

  h.context.chat.push(assistant('追加回复使原尾楼成为稳定后缀。'));
  const suffixWriter = runtimeHarness({ sharedBackend: h.backend, chat: h.context.chat });
  await suffixWriter.runtime.start();
  await suffixWriter.foundationRuntime.refreshStatus();
  await suffixWriter.runtime.refreshStatus();
  const suffixFloor = suffixWriter.runtime.getState().floors.at(-1);
  assert.notEqual(suffixFloor.floorId, targetFloorId);
  await suffixWriter.runtime.extractFloor(suffixFloor.floorId, { analyzeState: false });
  const beforeRelease = await suffixWriter.store.readReachable({ mode: 'runtime' });
  const suffixMemory = beforeRelease.floorMemories.find(item => item.floorId === suffixFloor.floorId && item.recordStatus === 'active');
  assert.ok(suffixMemory);

  releaseCse();
  await firstPending;
  const after = await h.store.readReachable({ mode: 'runtime' });
  assert.deepEqual(after.floors.map(item => item.id), beforeRelease.floors.map(item => item.id));
  assert.ok(after.floorMemories.some(item => item.id === suffixMemory.id), 'CSE 提交不得丢失并发新增的后缀摘要');
  assert.equal(after.stateDeltas.length, 1);
  assert.equal(after.stateDeltas[0].floorId, targetFloorId);
  assert.equal(h.runtime.getState().lastCseError, null);
});

test('CSE 模型在途时固定本次来源，后续重算才读取更新的人设、角色卡和作者注释', async () => {
  let releaseFirst;
  let markStarted;
  let callCount = 0;
  const requests = [];
  const started = new Promise(resolve => { markStarted = resolve; });
  const h = runtimeHarness({
    cse: options => {
      requests.push(JSON.parse(options.taskMessages[0].content));
      callCount += 1;
      if (callCount === 1) return new Promise(resolve => { releaseFirst = () => resolve({ jsonData: { noMaterialChange: true } }); markStarted(); });
      return { jsonData: { noMaterialChange: true } };
    },
  });
  const pending = h.runtime.start().then(() => h.runtime.extractNext());
  await started;
  h.context.powerUserSettings.persona_description = '模型在途时更新的人设';
  h.context.characters[0].data.description = '模型在途时更新的角色描述';
  h.context.chatMetadata.note_prompt = '模型在途时更新的作者注释';
  releaseFirst();
  let state = await pending;
  assert.equal(state.cseReady, true, '来源在模型调用后变化不应使已冻结请求失效');
  assert.equal(requests[0].payload.relevantBaseline.userPersona.description, '调查员林岚');
  assert.equal(requests[0].payload.relevantBaseline.characterCard.description, '角色描述');
  assert.equal(requests[0].payload.relevantBaseline.authorNote, null);

  const floorId = state.floors[0].floorId;
  state = await h.runtime.extractFloor(floorId);
  assert.equal(requests.length, 1, '摘要重提不得自动再次分析已有 CSE');
  state = await h.runtime.retryStateAnalysis(floorId);
  assert.equal(state.cseFloors[0].status, 'noChange');
  assert.equal(state.cseReady, true);
  assert.equal(requests[1].payload.relevantBaseline.userPersona.description, '模型在途时更新的人设');
  assert.equal(requests[1].payload.relevantBaseline.characterCard.description, '模型在途时更新的角色描述');
  assert.equal(requests[1].payload.relevantBaseline.authorNote.content, '模型在途时更新的作者注释');
  const root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  const savedBaseline = h.backend.records.get(`chat-${CHAT}/v3-baseline-${root.baselineId}`).data;
  assert.equal(savedBaseline.userPersona.description, '调查员林岚', '请求来源更新不得回写 immutable baseline');
  const checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  const run = h.backend.records.get(`chat-${CHAT}/v3-run-${checkpoint.runId}`).data;
  assert.ok(run.diagnostics.sourceSelection.sourceFingerprint.startsWith('sha256:'));
  assert.equal(JSON.stringify(run.diagnostics.sourceSelection).includes('模型在途时更新'), false, '提交诊断不得保存来源正文');
});

test('CSE 关联世界书读取失败时不调用分析 API，并保留不含正文的内部诊断', async () => {
  const h = runtimeHarness();
  h.context.characters[0].data.extensions.world = '缺失书';
  const state = await h.runtime.start().then(() => h.runtime.extractNext());
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 0);
  assert.equal(state.cseFloors[0].status, 'failed');
  assert.equal(state.lastCseError.code, 'V3_CSE_SOURCE_READ_FAILED');
  assert.deepEqual(state.lastCseError.diagnostics.missingBooks, ['缺失书']);
  assert.equal(JSON.stringify(state.lastCseError.diagnostics).includes('启用作者设定'), false);
});

test('CSE 等待模型期间目标活动摘要被替换时保持 stale，旧结果不写入新 root', async () => {
  let releaseCse;
  let markStarted;
  const cseStarted = new Promise(resolve => { markStarted = resolve; });
  const h = runtimeHarness({
    cse: () => new Promise(resolve => {
      releaseCse = () => resolve({ jsonData: { noMaterialChange: true } });
      markStarted();
    }),
  });
  const firstPending = h.runtime.start().then(() => h.runtime.extractNext());
  await cseStarted;
  const targetFloorId = h.runtime.getState().floors[0].floorId;
  const competing = runtimeHarness({ sharedBackend: h.backend, chat: h.context.chat });
  await competing.runtime.start();
  await competing.runtime.editSummary(targetFloorId, '并发替换后的有效摘要');
  const changed = await competing.store.readReachable({ mode: 'runtime' });
  const changedMemoryId = changed.floorMemories.find(item => item.floorId === targetFloorId && item.recordStatus === 'active')?.id;

  releaseCse();
  await firstPending;
  const after = await h.store.readReachable({ mode: 'runtime' });
  assert.equal(after.floorMemories.find(item => item.floorId === targetFloorId && item.recordStatus === 'active')?.id, changedMemoryId);
  assert.equal(after.stateDeltas.length, 0, '目标摘要改变后迟到 CSE 不得写入 delta');
  assert.equal(h.runtime.getState().lastCseError?.code, 'V3_CSE_STALE');
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

test('精简辅助索引后缺任一业务记录仍不能提交 root', async () => {
  const cases = [
    ['floorMemories', 'v3-floor-memory-', 'V3_STORE_FLOOR_MEMORY_MISSING'],
    ['entities', 'v3-entity-', 'V3_STORE_ENTITY_MISSING'],
    ['stateDeltas', 'v3-state-delta-', 'V3_STORE_STATE_DELTA_MISSING'],
    ['currentStates', 'v3-current-state-', 'V3_STORE_CURRENT_STATE_MISSING'],
  ];
  for (const [field, prefix, code] of cases) {
    const h = runtimeHarness();
    await h.runtime.start().then(() => h.runtime.extractNext());
    const rootKey = `chat-${CHAT}/v3-root`;
    const rootEnvelope = structuredClone(h.backend.records.get(rootKey));
    const checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${rootEnvelope.data.headCheckpointId}`).data;
    const recordId = checkpoint.producedRefs[field][0];
    assert.ok(recordId, `${field} fixture 应包含业务记录`);
    h.backend.records.delete(`chat-${CHAT}/${prefix}${recordId}`);
    const rootPutsBefore = h.backend.getRootPuts();
    await assert.rejects(h.store.commitRoot(rootEnvelope.data, rootEnvelope.revision), error => error?.code === code);
    assert.equal(h.backend.getRootPuts(), rootPutsBefore, `${field} 缺失时不得发 root PUT`);
    assert.deepEqual(h.backend.records.get(rootKey), rootEnvelope);
  }
});

test('CSE Phase A 首个 conflict 后停止领取新记录并等待在途写入，且不发布 run/checkpoint/root', async () => {
  const phaseTypes = new Set(['entity', 'stateDelta', 'currentState', 'index']);
  const expectedPhaseTypes = new Set(['stateDelta', 'currentState', 'index']);
  const observedPhaseTypes = new Set();
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
        observedPhaseTypes.add(data.recordType);
        activePuts += 1;
        const ordinal = phaseStarts;
        if ([...expectedPhaseTypes].every(type => observedPhaseTypes.has(type))) firstWaveResolve();
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
  const startedBeforeConflict = phaseStarts;
  assert.equal(startedBeforeConflict, expectedPhaseTypes.size);
  releaseConflict();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(phaseStarts, startedBeforeConflict, '发现首错后不得继续领取新的 Phase A 记录');
  assert.equal(settled, false, '仍有在途写入时不得提前结束操作');
  assert.equal(activePuts, startedBeforeConflict - 1);
  assert.deepEqual(barriers, []);

  releaseInflight();
  const state = await pending;
  assert.equal(activePuts, 0);
  assert.equal(state.cseFloors[0].status, 'failed');
  assert.equal(state.lastCseError.code, 'V3_CSE_PERSIST_FAILED');
  assert.deepEqual(barriers, [], 'Phase A 失败后不得写 run/checkpoint/root');
});

test('CSE Phase A 全批保留记录在途时失效会等待收拢且不发布新 root', async () => {
  const phaseTypes = new Set(['entity', 'stateDelta', 'currentState', 'index']);
  const expectedPhaseTypes = new Set(['stateDelta', 'currentState', 'index']);
  const observedPhaseTypes = new Set();
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
        observedPhaseTypes.add(data.recordType);
        activePuts += 1;
        if ([...expectedPhaseTypes].every(type => observedPhaseTypes.has(type))) firstWaveResolve();
        await inflightGate;
        activePuts -= 1;
      },
    },
  });

  await h.runtime.start();
  let settled = false;
  const pending = h.runtime.extractNext().finally(() => { settled = true; });
  await firstWave;
  const startedBeforeInvalidation = phaseStarts;
  assert.equal(startedBeforeInvalidation, expectedPhaseTypes.size);
  const rootBeforeInvalidation = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-root`).data);
  h.runtime.invalidate();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(phaseStarts, startedBeforeInvalidation);
  assert.equal(activePuts, startedBeforeInvalidation);
  assert.equal(settled, false, '失效后仍须等待已在途的整批写入收拢');
  assert.deepEqual(barriers, []);

  releaseInflight();
  await pending;
  assert.equal(activePuts, 0);
  assert.equal(phaseStarts, startedBeforeInvalidation, '失效后不得领取新的 Phase A 记录');
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
    generateAnalysisTask: async () => ({ textData: fenced, taskMetadata: finishReason === undefined ? {} : { finishReason } }),
    envelope,
    previousCurrentState: null,
    now: NOW,
    deltaId: '16161616-1616-4161-8161-161616161616',
  });

  const recovered = await run('stop');
  assert.equal(recovered.delta.subjectSnapshots.length, 12);
  assert.deepEqual(recovered.delta.subjectSnapshots.map(subject => subject.situational[0].text), Array.from({ length: 12 }, (_, index) => `虚构状态-${index + 1}`));
  assert.deepEqual(recovered.delta.subjectSnapshots[11].changeSummary, ['新增情境状态：虚构状态-12（信息范围：可观察；来源：本楼）']);
  assert.equal(recovered.metadata.finishReason, 'stop');

  const symbolPacket = '{"subjects":[{"subject":"林岚",situational:[{"text":"保持警觉","visibility":"observable"}]}]}';
  const symbolRecovered = await runCseRequest({
    generateAnalysisTask: async () => ({ textData: symbolPacket, taskMetadata: { finishReason: 'stop' } }),
    envelope,
    previousCurrentState: null,
    now: NOW,
    deltaId: '18181818-1818-4181-8181-181818181818',
  });
  assert.equal(symbolRecovered.delta.subjectSnapshots[0].situational[0].text, '保持警觉');
  const fencedSymbolRecovered = await compileCseResponse({
    response: `说明如下：\n\`\`\`json\n${symbolPacket}\n\`\`\`\n完毕。`,
    finishReason: 'stop',
    envelope,
    previousCurrentState: null,
    now: NOW,
    deltaId: '20202020-2020-4202-8202-202020202020',
  });
  assert.equal(fencedSymbolRecovered.delta.subjectSnapshots[0].situational[0].text, '保持警觉');
  const legalWrapped = '说明：{"subjects":[{"subject":"林岚","situational":[{"text":"合法片段"}]}]} 完毕。';
  const legalWrappedResult = await compileCseResponse({ response: legalWrapped, finishReason: 'stop', envelope, previousCurrentState: null, now: NOW, deltaId: '21212121-2121-4212-8212-212121212121' });
  assert.equal(legalWrappedResult.delta.subjectSnapshots[0].situational[0].text, '合法片段');
  await assert.rejects(
    compileCseResponse({ response: symbolPacket, envelope, previousCurrentState: null, now: NOW, deltaId: '19191919-1919-4191-8191-191919191919' }),
    error => error.code === 'V3_CSE_FORMAT_INVALID',
  );
  await assert.rejects(
    compileCseResponse({ response: `说明：${symbolPacket} 完毕。`, finishReason: 'stop', envelope, previousCurrentState: null, now: NOW, deltaId: '22222222-2222-4222-8222-222222222222' }),
    error => error.code === 'V3_CSE_FORMAT_INVALID',
  );

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

test('CSE 最终机器合同明确 JSON 字符转义，合法引用解码后保持原文字面且歧义坏串仍拒绝', async () => {
  const canonicalContent = '甲写下："路径是 C:\\tmp\\note"\n随后换行。';
  const quote = '"路径是 C:\\tmp\\note"\n随后换行';
  const envelope = createCseEnvelope({
    floor: floor(FLOOR1, canonicalContent),
    floorMemory: memory(MEMORY1),
    baseline,
    currentState: null,
    trackedSubjects: [entities[1]],
    entities,
  });
  let sentSystemPrompt = '';
  const packet = JSON.stringify({
    subjects: [{
      subject: '甲',
      additions: { adaptive: [{ text: '会精确记录路径', evidence: [{ source: 'canonicalContent', quote }] }] },
    }],
  });
  const result = await runCseRequest({
    generateAnalysisTask: async options => { sentSystemPrompt = options.systemPrompt; return { textData: `\`\`\`json\n${packet}\n\`\`\``, taskMetadata: { finishReason: 'stop' } }; },
    envelope,
    previousCurrentState: null,
    now: NOW,
    deltaId: '23232323-2323-4232-8232-232323232323',
  });
  assert.ok(sentSystemPrompt.includes(String.raw`英文双引号写成 \"`));
  assert.ok(sentSystemPrompt.includes(String.raw`反斜杠写成 \\`));
  assert.ok(sentSystemPrompt.includes(String.raw`实际换行写成 \n`));
  assert.equal(result.isolated.length, 0);
  assert.equal(result.delta.source.calibrationAudit[0].evidence[0].quote, quote, 'JSON 解码后必须逐字恢复英文双引号、反斜杠和实际换行');

  const ambiguous = '{"subjects":[{"subject":"甲","additions":{"adaptive":[{"text":"会记录","evidence":[{"source":"canonicalContent","quote":"他说"路径""}]}]}}]}';
  await assert.rejects(
    compileCseResponse({ response: ambiguous, finishReason: 'stop', envelope, previousCurrentState: null, now: NOW, deltaId: '24242424-2424-4242-8242-242424242424' }),
    error => error.code === 'V3_CSE_FORMAT_INVALID',
  );
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
  h.context.chatId = 'host-other-chat';
  h.context.chatMetadata.qianqianjie = { schemaVersion: 1, chatId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
  h.emit('CHAT_CHANGED');
  release();
  await pending;
  const records = [...h.backend.records.keys()];
  assert.equal(records.some(key => key.includes('/v3-floor-memory-')), true);
  const root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  const checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  assert.equal(checkpoint.producedRefs.stateDeltas.length, 0);
});

test('摘要与人物状态逐楼独立，显式重分析只替换目标楼', async () => {
  const h = runtimeHarness();
  h.context.chat.push(assistant('第三楼用于确认第二楼稳定。'));
  let state = await h.runtime.start().then(() => h.runtime.extractNext());
  state = await h.runtime.extractNext();
  assert.equal(state.replayedCurrentState.appliedDeltaIds.length, 2);
  const firstFloorId = state.floors[0].floorId, secondFloorId = state.floors[1].floorId;
  const originalDeltaIds = state.cseFloors.map(item => item.deltaId);
  const cseCallsBefore = h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length;
  state = await h.runtime.extractFloor(firstFloorId);
  assert.deepEqual(state.cseFloors.map(item => item.deltaId), originalDeltaIds);
  assert.equal(state.replayedCurrentState.appliedDeltaIds.length, 2);
  let root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  let checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  assert.deepEqual(checkpoint.producedRefs.stateDeltas, originalDeltaIds, '摘要重提不改任何楼的 CSE');
  state = await h.runtime.retryStateAnalysis(secondFloorId);
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, cseCallsBefore + 1);
  assert.equal(state.cseFloors[0].deltaId, originalDeltaIds[0]);
  assert.notEqual(state.cseFloors[1].deltaId, originalDeltaIds[1]);
  assert.equal(state.cseFloors[1].status, 'noChange');
  const secondRetryRequest = JSON.parse(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).at(-1).taskMessages[0].content);
  assert.ok(secondRetryRequest.payload.previousState.length > 0, '显式重分析仍可读取当时可用的前态上下文');
  assert.equal(state.cseReady, true);
  root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  assert.equal(checkpoint.producedRefs.stateDeltas.length, 2);
  const laterDeltaId = state.cseFloors[1].deltaId;
  const laterDeltaBeforeEarlyRetry = structuredClone(h.backend.records.get(`chat-${CHAT}/v3-state-delta-${laterDeltaId}`).data);
  state = await h.runtime.retryStateAnalysis(firstFloorId);
  assert.equal(state.cseFloors[1].deltaId, laterDeltaId, '重分析早期楼不得替换后楼 delta');
  assert.deepEqual(h.backend.records.get(`chat-${CHAT}/v3-state-delta-${laterDeltaId}`).data, laterDeltaBeforeEarlyRetry, '重分析早期楼后，后楼固定记录必须逐字不变');
  const firstMemory = state.floors[0].memory;
  const beforeMemoryEditDeltaIds = state.cseFloors.map(item => item.deltaId);
  state = await h.runtime.editMemory(firstFloorId, { summary: '用户手工修订第一楼摘要', chronology: firstMemory.chronology.map(item => ({ itemId: item.itemId, sourceText: item.time.sourceText ?? '', description: item.description })), locations: firstMemory.locations.map(item => ({ itemId: item.itemId, name: item.name })), participantEntityIds: firstMemory.participants.map(item => item.entityId), participantPresence: Object.fromEntries(firstMemory.participants.map(item => [item.entityId, item.presence])), revisionNote: '校正事实' });
  assert.equal(state.replayedCurrentState.appliedDeltaIds.length, 2);
  root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  assert.deepEqual(checkpoint.producedRefs.stateDeltas, beforeMemoryEditDeltaIds, '整包摘要修订也不改已落盘 CSE');
});

test('前置楼摘要失效不连坐已落盘 CSE，后楼可独立显式重分析', async () => {
  const h = runtimeHarness();
  h.context.chat.push(assistant('第三楼用于确认第二楼稳定。'));
  let state = await h.runtime.start().then(() => h.runtime.extractNext());
  state = await h.runtime.extractNext();
  assert.equal(state.cseReady, true);
  assert.equal(state.replayedCurrentState.appliedDeltaIds.length, 2);
  const firstFloorId = state.floors[0].floorId;
  const secondFloorId = state.floors[1].floorId;
  const cseCallsBefore = h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length;
  const oldDeltaIds = state.cseFloors.map(item => item.deltaId);
  state = await h.runtime.markError(firstFloorId);
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, cseCallsBefore, 'markError 只做本地断链');
  assert.equal(state.cseFloors[0].status, 'ready');
  assert.equal(state.cseFloors[1].status, 'noChange');
  assert.equal(state.replayedCurrentState.appliedDeltaIds.length, 2);
  let root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  let checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  assert.deepEqual(checkpoint.producedRefs.stateDeltas, oldDeltaIds);
  h.calls.splice(0);
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => ['caughtUp', 'waitingRealtime'].includes(h.runtime.getState().rebuildStatus) && !h.runtime.getState().memoryWorkBusy);
  state = h.runtime.getState();
  assert.equal(h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, 1, '补齐摘要缺口只调用摘要模型');
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 0, '已有 delta 的楼不因摘要补齐而重跑 CSE');
  assert.deepEqual(state.cseFloors.map(item => item.deltaId), oldDeltaIds);
  assert.equal(state.rebuildCompletedCount, 2);
  state = await h.runtime.retryStateAnalysis(secondFloorId);
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 1, '后楼可独立显式重分析');
  assert.notEqual(state.cseFloors[1].deltaId, oldDeltaIds[1]);
  assert.equal(state.cseFloors[0].deltaId, oldDeltaIds[0]);
  root = h.backend.records.get(`chat-${CHAT}/v3-root`).data;
  checkpoint = h.backend.records.get(`chat-${CHAT}/v3-checkpoint-${root.headCheckpointId}`).data;
  assert.deepEqual(checkpoint.producedRefs.stateDeltas.map(id => id === oldDeltaIds[0]), [true, false]);
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
  await h.runtime.refreshStatus();
  await waitFor(() => h.runtime.getState().memorySyncStatus !== 'syncing', '冷启动 CSE 重放未完成');
  state = h.runtime.getState();
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

test('情境对象只按已知人物与唯一别名绑定，方向独立且 core 不接受对象', async () => {
  const envelope = createCseEnvelope({ floor: floor(FLOOR1, '林岚警惕乙；甲等待林岚，乙只是被提到。'), floorMemory: memory(MEMORY1), baseline, currentState: null, trackedSubjects: entities.slice(0, 2), entities });
  const result = await compileCseResponse({
    response: { subjects: [
      { subject: '林岚', core: [{ text: '谨慎', toward: '乙' }], situational: [{ text: '此刻警惕乙', toward: '乙' }, { text: '仍然头痛' }, { text: '无法绑定', toward: '第三人' }] },
      { subject: '甲', situational: [{ text: '等待林岚回应', toward: '你' }] },
    ] },
    envelope, previousCurrentState: null, now: NOW, deltaId: '91919191-1111-4111-8111-111111111111',
  });
  const userState = result.delta.subjectSnapshots.find(subject => subject.subjectEntityId === USER);
  const aState = result.delta.subjectSnapshots.find(subject => subject.subjectEntityId === A);
  assert.equal(userState.core[0].towardEntityId, null, 'Core 必须保持无对象');
  assert.deepEqual(userState.situational.map(item => [item.text, item.towardEntityId]), [['此刻警惕乙', B], ['仍然头痛', null]]);
  assert.match(userState.changeSummary.join('|'), /情境状态.*此刻警惕乙.*对象：乙/, 'timeline 文字摘要须保留情境对象');
  assert.deepEqual(aState.situational.map(item => [item.text, item.towardEntityId]), [['等待林岚回应', USER]], 'A→用户不得生成用户→A镜像');
  assert.ok(result.isolated.some(item => item.field === 'situational' && item.code === 'V3_CSE_TOWARD_UNBOUND'));
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

test('非空分类全部无效时保留旧状态，只有显式空数组清空，好坏混合使用合法项', async () => {
  const tracked = [entities[0]];
  const initialEnvelope = createCseEnvelope({ floor: floor(FLOOR1, '第一楼'), floorMemory: memory(MEMORY1), baseline, currentState: null, trackedSubjects: tracked, entities });
  const initial = await compileCseResponse({
    response: { subjects: [{ subject: '林岚', adaptive: [{ text: '仍会谨慎观察', toward: '甲' }], situational: [{ text: '感到疲惫' }] }] },
    envelope: initialEnvelope, previousCurrentState: null, now: NOW, deltaId: '71717171-1111-4111-8111-717171717171',
  });
  const previous = { id: '72727272-1111-4111-8111-727272727272', subjects: initial.delta.subjectSnapshots };
  const nextEnvelope = createCseEnvelope({ floor: floor(FLOOR2, '第二楼'), floorMemory: memory(MEMORY2), baseline, currentState: previous, trackedSubjects: tracked, entities });

  const allInvalid = await compileCseResponse({
    response: { subjects: [{ subject: '林岚', core: null, adaptive: [{}, { text: '对象无法绑定', toward: '不存在的人' }], situational: {} }] },
    envelope: nextEnvelope, previousCurrentState: previous, now: NOW, deltaId: '73737373-1111-4111-8111-737373737373',
  });
  assert.deepEqual(allInvalid.delta.subjectSnapshots[0].adaptive.map(item => item.text), ['仍会谨慎观察']);
  assert.deepEqual(allInvalid.delta.subjectSnapshots[0].situational.map(item => item.text), ['感到疲惫']);
  assert.equal(allInvalid.delta.noMaterialChange, true);
  assert.deepEqual(allInvalid.delta.subjectSnapshots[0].changeSummary, []);
  assert.ok(allInvalid.isolated.some(item => item.code === 'V3_CSE_OPTIONAL_ITEM_INVALID'));
  assert.ok(allInvalid.isolated.some(item => item.code === 'V3_CSE_TOWARD_UNBOUND'));

  const explicitEmpty = await compileCseResponse({
    response: { subjects: [{ subject: '林岚', adaptive: [], situational: [] }] },
    envelope: nextEnvelope, previousCurrentState: previous, now: NOW, deltaId: '74747474-1111-4111-8111-747474747474',
  });
  assert.deepEqual(explicitEmpty.delta.subjectSnapshots[0].adaptive, []);
  assert.deepEqual(explicitEmpty.delta.subjectSnapshots[0].situational, []);

  const mixed = await compileCseResponse({
    response: { subjects: [{ subject: '林岚', adaptive: [{}, { text: '改为审慎合作', toward: '甲' }] }] },
    envelope: nextEnvelope, previousCurrentState: previous, now: NOW, deltaId: '75757575-1111-4111-8111-757575757575',
  });
  assert.deepEqual(mixed.delta.subjectSnapshots[0].adaptive.map(item => item.text), ['改为审慎合作']);
});

test('英文大小写与全角姓名统一绑定主体和 toward，歧义仍不猜', async () => {
  const alice = { id: '76767676-1111-4111-8111-767676767676', entityType: 'person', displayName: 'Alice', aliases: [], specialRole: 'none' };
  const bob = { id: '77767676-1111-4111-8111-777676767676', entityType: 'person', displayName: 'Bob', aliases: [], specialRole: 'none' };
  const envelope = createCseEnvelope({ floor: floor(FLOOR1, 'Alice 正在关注 Bob。'), floorMemory: memory(MEMORY1), baseline, currentState: null, trackedSubjects: [alice], entities: [alice, bob] });
  const compiled = await compileCseResponse({
    response: { subjects: [{ subject: 'ａｌｉｃｅ', adaptive: [{ text: '保持关注', toward: 'ＢＯＢ' }] }] },
    envelope, previousCurrentState: null, now: NOW, deltaId: '78787878-1111-4111-8111-787878787878',
  });
  assert.equal(compiled.delta.subjectSnapshots[0].subjectEntityId, alice.id);
  assert.equal(compiled.delta.subjectSnapshots[0].adaptive[0].towardEntityId, bob.id);

  const duplicateBob = { ...bob, id: '79797979-1111-4111-8111-797979797979', displayName: 'BOB' };
  const ambiguousEnvelope = createCseEnvelope({ floor: floor(FLOOR1, 'Alice 正在关注 Bob。'), floorMemory: memory(MEMORY1), baseline, currentState: null, trackedSubjects: [alice], entities: [alice, bob, duplicateBob] });
  const ambiguous = await compileCseResponse({ response: { subjects: [{ subject: 'alice', adaptive: [{ text: '保持关注', toward: 'bob' }] }] }, envelope: ambiguousEnvelope, previousCurrentState: null, now: NOW, deltaId: '80808080-1111-4111-8111-808080808080' });
  assert.deepEqual(ambiguous.delta.subjectSnapshots[0].adaptive, []);
  assert.ok(ambiguous.isolated.some(item => item.code === 'V3_CSE_TOWARD_UNBOUND'));
});

test('已知 toward 同名仍按歧义失败隔离，不猜测绑定', async () => {
  const ambiguous = [...entities, { id: 'dddddddd-1111-4111-8111-111111111111', entityType: 'person', displayName: '丙', aliases: [{ name: '乙' }], specialRole: 'none' }];
  const envelope = createCseEnvelope({ floor: floor(FLOOR1, '歧义楼'), floorMemory: memory(MEMORY1), baseline, currentState: null, trackedSubjects: [entities[0]], entities: ambiguous });
  const result = await compileCseResponse({ response: { subjects: [{ subject: '你', adaptive: [{ text: '警惕', toward: '乙', visibility: 'observable' }] }] }, envelope, previousCurrentState: null, now: NOW, deltaId: 'eeeeeeee-1111-4111-8111-111111111111' });
  assert.deepEqual(result.delta.subjectSnapshots[0].adaptive, []);
  assert.ok(result.isolated.some(item => item.code === 'V3_CSE_TOWARD_UNBOUND'));
});

test('模型输出 manual 来源仍按普通楼层编译，不能伪造人工纠正标记', async () => {
  const envelope = createCseEnvelope({ floor: floor(FLOOR1, '甲做出决定。'), floorMemory: memory(MEMORY1), baseline, currentState: null, trackedSubjects: [entities[1]], entities });
  const result = await compileCseResponse({
    response: { subjects: [{ subject: '甲', situational: [{ text: '已经决定', visibility: 'observable', reason: '正文', origin: 'manual' }] }] },
    envelope,
    previousCurrentState: null,
    now: NOW,
    deltaId: '15151515-1515-4151-8151-151515151515',
  });
  assert.equal(result.delta.subjectSnapshots[0].situational[0].origin, 'floor');
  assert.equal(result.delta.source.manualSubjectEntityIds, undefined);
});

test('CSE 只消费目标前缀内的有效 merged 别名并绑定回 canonical person，group 不参与', async () => {
  const scopedEntities = entities.map(entity => ({ ...entity, chatId: CHAT, narrativeGeneration: GEN, firstSeenFloorId: entity.id === USER ? null : FLOOR1, status: 'established', recordStatus: 'active' }));
  const mergedAlias = { ...scopedEntities[2], id: 'eeeeeeee-1111-4111-8111-111111111111', displayName: '小乙', aliases: [{ name: '乙先生' }], status: 'merged', mergedIntoEntityId: B };
  const group = { ...scopedEntities[2], id: 'ffffffff-1111-4111-8111-111111111111', displayName: '守卫们', entityType: 'group', aliases: [], status: 'established', mergedIntoEntityId: null };
  const envelope = createCseEnvelope({ floor: floor(FLOOR1, '林岚开始信任小乙。'), floorMemory: memory(MEMORY1), baseline, currentState: null, trackedSubjects: [scopedEntities[0]], entities: [...scopedEntities, mergedAlias, group] });
  assert.ok(envelope.request.payload.knownPeople.find(person => person.name === '乙').aliases.includes('小乙'));
  assert.equal(envelope.request.payload.knownPeople.some(person => person.name === '守卫们'), false);
  const result = await compileCseResponse({ response: { subjects: [{ subject: '林岚', adaptive: [{ text: '逐渐信任', toward: '乙先生', visibility: 'private', reason: '正文' }], situational: [{ text: '此刻留意', toward: '小乙', visibility: 'observable', reason: '正文' }] }] }, envelope, previousCurrentState: null, now: NOW, deltaId: 'abababab-1111-4111-8111-111111111111' });
  assert.equal(result.delta.subjectSnapshots[0].adaptive[0].towardEntityId, B);
  assert.equal(result.delta.subjectSnapshots[0].situational[0].towardEntityId, B, '情境对象沿用同一有效 merged 别名绑定');
});

test('他人状态移入独立作者态上下文并保持隐私过滤；空 delta 也可重放为已分析', async () => {
  const current = { subjects: [
    { subjectEntityId: USER, core: [], adaptive: [], situational: [{ text: '用户私心', visibility: 'private', reason: '私密', origin: 'floor', towardEntityId: null, sourceFloorId: FLOOR1, sourceDeltaId: null }] },
    { subjectEntityId: A, core: [{ text: '作者设定', visibility: 'authorial', reason: '卡', origin: 'baseline', towardEntityId: null, sourceFloorId: null, sourceDeltaId: null }], adaptive: [], situational: [{ text: '公开动作', visibility: 'observable', reason: '看见', origin: 'floor', towardEntityId: null, sourceFloorId: FLOOR1, sourceDeltaId: null }] },
  ] };
  const envelope = createCseEnvelope({ floor: floor(FLOOR1, '正文'), floorMemory: memory(MEMORY1), baseline, currentState: current, trackedSubjects: entities.slice(0, 2), entities });
  const forUser = envelope.request.payload.previousState.find(item => item.subject === '林岚');
  assert.equal('publicStateOfOthers' in forUser, false);
  assert.deepEqual(Object.keys(forUser), ['subject', 'coreUserEdited', 'ownState']);
  assert.equal(forUser.coreUserEdited, false);
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

test('review/additions 连续校准会收窄错误 Adaptive，后续 keep 保留纠正后的 ID 与来源', async () => {
  const floor3 = '31313131-1111-4111-8111-313131313131';
  const memory3 = '32323232-1111-4111-8111-323232323232';
  const floor4 = '43434343-1111-4111-8111-434343434343';
  const memory4 = '44434343-1111-4111-8111-444343434343';
  const firstEnvelope = createCseEnvelope({ floor: floor(FLOOR1, '林岚这一次在压力下退让。'), floorMemory: memory(MEMORY1), baseline, currentState: null, trackedSubjects: [entities[0]], entities });
  const first = await compileCseResponse({
    response: { subjects: [{ subject: '林岚', additions: {
      core: [{ text: '重视独立判断', visibility: 'authorial', reason: '用户设定明确', evidence: [{ source: 'userPersona', quote: '用户设定' }] }],
      adaptive: [{ text: '遇到冲突便一味退让', visibility: 'private', reason: '本楼表现', evidence: [{ source: 'canonicalContent', quote: '这一次在压力下退让' }] }],
    } }] },
    envelope: firstEnvelope, previousCurrentState: null, now: NOW, deltaId: '33333333-1111-4111-8111-333333333333',
  });
  const initial = first.delta.subjectSnapshots[0];
  assert.deepEqual(initial.core.map(item => item.text), ['重视独立判断']);
  assert.match(initial.core[0].reason, /userPersona.*用户设定/);

  const previous = { id: '34343434-1111-4111-8111-343434343434', subjects: first.delta.subjectSnapshots };
  const secondEnvelope = createCseEnvelope({ floor: floor(FLOOR2, '她拒绝签字并夺回文件，只在体力受制时暂时停手。'), floorMemory: memory(MEMORY2), baseline, currentState: previous, trackedSubjects: [entities[0]], entities });
  const second = await compileCseResponse({
    response: { subjects: [{ subject: '林岚', review: {
      core: [{ previousText: '重视独立判断', action: 'keep' }],
      adaptive: [{ previousText: '遇到冲突便一味退让', action: 'refine', text: '体力受制时可能暂时让步', visibility: 'private', reason: '反例限制了旧泛化', evidence: [{ source: 'canonicalContent', quote: '拒绝签字并夺回文件' }] }],
    } }] },
    envelope: secondEnvelope, previousCurrentState: previous, now: NOW, deltaId: '35353535-1111-4111-8111-353535353535',
  });
  const narrowed = second.delta.subjectSnapshots[0];
  assert.equal(narrowed.core[0].id, initial.core[0].id, 'keep 必须复用旧 Core 对象');
  assert.notEqual(narrowed.adaptive[0].id, initial.adaptive[0].id, 'refine 才创建新项');
  assert.equal(narrowed.adaptive[0].text, '体力受制时可能暂时让步');
  assert.deepEqual(narrowed.changeSummary, ['调整长期适应：遇到冲突便一味退让（信息范围：私密；来源：本楼） → 体力受制时可能暂时让步（信息范围：私密；来源：本楼）']);

  const replayed2 = await replayCurrentState({
    chatId: CHAT, narrativeGeneration: GEN, baselineId: baseline.id,
    floors: [floor(FLOOR1, '林岚这一次在压力下退让。'), floor(FLOOR2, '她拒绝签字并夺回文件，只在体力受制时暂时停手。')],
    floorMemories: [{ ...memory(MEMORY1), floorId: FLOOR1, recordStatus: 'active' }, { ...memory(MEMORY2), floorId: FLOOR2, recordStatus: 'active' }],
    stateDeltas: [first.delta, second.delta], now: NOW,
  });
  const correctedItem = replayed2.subjects[0].adaptive[0];
  const thirdEnvelope = createCseEnvelope({ floor: floor(floor3, '此楼没有改变该长期模式的新事实。'), floorMemory: memory(memory3), baseline, currentState: replayed2, trackedSubjects: [entities[0]], entities });
  const third = await compileCseResponse({ response: { subjects: [{ subject: '林岚', review: { adaptive: [{ previousText: '体力受制时可能暂时让步', action: 'keep' }] } }] }, envelope: thirdEnvelope, previousCurrentState: replayed2, now: NOW, deltaId: '36363636-1111-4111-8111-363636363636' });
  assert.equal(third.delta.subjectSnapshots[0].adaptive[0].id, correctedItem.id);
  assert.equal(third.delta.subjectSnapshots[0].adaptive[0].sourceDeltaId, correctedItem.sourceDeltaId);
  assert.deepEqual(third.delta.subjectSnapshots[0].changeSummary, []);
  const thirdState = { id: '45454545-1111-4111-8111-454545454545', subjects: third.delta.subjectSnapshots };
  const fourthEnvelope = createCseEnvelope({ floor: floor(floor4, '她已摆脱外力限制，旧模式不再适用。'), floorMemory: memory(memory4), baseline, currentState: thirdState, trackedSubjects: [entities[0]], entities });
  const fourth = await compileCseResponse({ response: { subjects: [{ subject: '林岚', review: { adaptive: [{ previousText: '体力受制时可能暂时让步', action: 'remove', reason: '限制条件已结束', evidence: [{ source: 'canonicalContent', quote: '已摆脱外力限制' }] }] } }] }, envelope: fourthEnvelope, previousCurrentState: thirdState, now: NOW, deltaId: '46464646-1111-4111-8111-464646464646' });
  assert.deepEqual(fourth.delta.subjectSnapshots[0].adaptive, []);
  assert.deepEqual(fourth.delta.subjectSnapshots[0].changeSummary, ['移除长期适应：体力受制时可能暂时让步（信息范围：私密；来源：本楼）']);
  assert.deepEqual(fourth.delta.source.calibrationAudit[0], {
    subjectEntityId: USER, category: 'adaptive', action: 'remove', previousText: '体力受制时可能暂时让步', previousTowardEntityId: null,
    text: null, towardEntityId: null, reason: '限制条件已结束', evidence: [{ source: 'canonicalContent', quote: '已摆脱外力限制' }],
  });
});

test('校准证据必须能定位且符合 Core 来源边界，manual Core 只有 currentUserInput 可改', async () => {
  const initialEnvelope = createCseEnvelope({ floor: floor(FLOOR1, '甲与林岚各自作出选择。'), floorMemory: memory(MEMORY1), baseline, currentState: null, trackedSubjects: entities.slice(0, 2), entities });
  const initial = await compileCseResponse({ response: { subjects: [
    { subject: '林岚', additions: { core: [{ text: '重视自主', evidence: [{ source: 'userPersona', quote: '用户设定' }] }] } },
    { subject: '甲', additions: { core: [{ text: '遵守作者事实', evidence: [{ source: 'worldbook:1', quote: '作者事实' }] }] } },
  ] }, envelope: initialEnvelope, previousCurrentState: null, now: NOW, deltaId: '37373737-1111-4111-8111-373737373737' });
  const initialState = { id: '38383838-1111-4111-8111-383838383838', subjects: initial.delta.subjectSnapshots };
  const manual = await createManualCseCorrection({
    anchorDelta: initial.delta,
    currentState: initialState,
    subjectEntityId: USER,
    edits: {
      core: [{ itemId: initialState.subjects[0].core[0].id, text: '人工确认的自主边界', visibility: 'private', towardEntityId: null }],
      adaptive: [], situational: [],
    },
    allowedTowardEntityIds: [USER, A], deltaId: '39393939-1111-4111-8111-393939393939', now: NOW,
  });
  assert.equal(manual.delta.source.calibrationVersion, 1, '人工替换必须继承新版完整快照标记');
  const replayed = await replayCurrentState({ chatId: CHAT, narrativeGeneration: GEN, baselineId: baseline.id, floors: [floor(FLOOR1, '甲与林岚各自作出选择。')], floorMemories: [{ ...memory(MEMORY1), floorId: FLOOR1, recordStatus: 'active' }], stateDeltas: [manual.delta], now: NOW });
  assert.deepEqual(replayed.subjects.find(subject => subject.subjectEntityId === A).core.map(item => item.text), ['遵守作者事实'], '手改一人后，另一人物同楼新版 Core 仍须重放');

  const correctionInput = { messageIndex: 2, content: '作者说明：林岚并非回避冲突，而是会明确维护自己的决定。' };
  const protectedEnvelope = createCseEnvelope({ floor: floor(FLOOR2, '林岚继续行动。'), floorMemory: memory(MEMORY2), baseline, currentState: replayed, trackedSubjects: [entities[0]], entities, currentUserInput: correctionInput, coreUserEditedSubjectEntityIds: [USER] });
  assert.equal(protectedEnvelope.request.payload.previousState[0].coreUserEdited, true);
  assert.equal(protectedEnvelope.request.payload.trackedSubjects[0].coreUserEdited, true);
  const baselineRejected = await compileCseResponse({ response: { subjects: [{ subject: '林岚', review: { core: [{ previousText: '人工确认的自主边界', action: 'refine', text: '被旧设定覆盖', evidence: [{ source: 'userPersona', quote: '用户设定' }] }] } }] }, envelope: protectedEnvelope, previousCurrentState: replayed, now: NOW, deltaId: '40404040-1111-4111-8111-404040404040' });
  assert.deepEqual(baselineRejected.delta.subjectSnapshots[0].core.map(item => item.text), ['人工确认的自主边界']);
  assert.ok(baselineRejected.isolated.some(item => item.code === 'V3_CSE_CALIBRATION_EVIDENCE_INSUFFICIENT'));

  const userCorrected = await compileCseResponse({ response: { subjects: [{ subject: '林岚', review: { core: [{ previousText: '人工确认的自主边界', action: 'refine', text: '会明确维护自己的决定', evidence: [{ source: 'currentUserInput', quote: '会明确维护自己的决定' }] }] } }] }, envelope: protectedEnvelope, previousCurrentState: replayed, now: NOW, deltaId: '41414141-1111-4111-8111-414141414141' });
  assert.deepEqual(userCorrected.delta.subjectSnapshots[0].core.map(item => item.text), ['会明确维护自己的决定']);
  assert.match(userCorrected.delta.subjectSnapshots[0].core[0].reason, /currentUserInput/);

  const replayedCorrection = await replayCurrentState({
    chatId: CHAT, narrativeGeneration: GEN, baselineId: baseline.id,
    floors: [floor(FLOOR1, '甲与林岚各自作出选择。'), floor(FLOOR2, '林岚继续行动。')],
    floorMemories: [{ ...memory(MEMORY1), floorId: FLOOR1, recordStatus: 'active' }, { ...memory(MEMORY2), floorId: FLOOR2, recordStatus: 'active' }],
    stateDeltas: [manual.delta, userCorrected.delta], now: NOW,
  });
  assert.deepEqual(replayedCorrection.subjects.find(subject => subject.subjectEntityId === USER).core.map(item => item.text), ['会明确维护自己的决定']);
  const nextFloorEnvelope = createCseEnvelope({ floor: floor('47474747-1111-4111-8111-474747474747', '下一楼没有新的作者纠正。'), floorMemory: memory('48484848-1111-4111-8111-484848484848'), baseline, currentState: replayedCorrection, trackedSubjects: [entities[0]], entities, coreUserEditedSubjectEntityIds: [USER] });
  const rollbackRejected = await compileCseResponse({ response: { subjects: [{ subject: '林岚', review: { core: [{ previousText: '会明确维护自己的决定', action: 'refine', text: '被旧设定再次覆盖', evidence: [{ source: 'userPersona', quote: '用户设定' }] }] } }] }, envelope: nextFloorEnvelope, previousCurrentState: replayedCorrection, now: NOW, deltaId: '49494949-1111-4111-8111-494949494949' });
  assert.deepEqual(rollbackRejected.delta.subjectSnapshots[0].core.map(item => item.text), ['会明确维护自己的决定'], '已接受的 user Core 纠正不能在下一楼被旧 baseline 改回');
  assert.ok(rollbackRejected.isolated.some(item => item.code === 'V3_CSE_CALIBRATION_EVIDENCE_INSUFFICIENT'));

  const inventedQuote = await compileCseResponse({ response: { subjects: [{ subject: '林岚', additions: { adaptive: [{ text: '凭空新增', evidence: [{ source: 'canonicalContent', quote: '正文不存在的句子' }] }] } }] }, envelope: protectedEnvelope, previousCurrentState: replayed, now: NOW, deltaId: '42424242-1111-4111-8111-424242424242' });
  assert.equal(inventedQuote.delta.subjectSnapshots[0].adaptive.length, 0);
  assert.ok(inventedQuote.isolated.some(item => item.code === 'V3_CSE_EVIDENCE_UNLOCATED'));
});

test('校准证据只统一明确引号样式，并把审计引用保存为来源原句', async () => {
  const quotedBaseline = structuredClone(baseline);
  quotedBaseline.worldInfoSources = [{ sourceName: '世界', content: '设定写道：“我爱你”，这句话不得改写。', activated: true }];
  const envelope = createCseEnvelope({ floor: floor(FLOOR1, '甲保持沉默。'), floorMemory: memory(MEMORY1), baseline: quotedBaseline, currentState: null, trackedSubjects: [entities[1]], entities });
  const compiled = await compileCseResponse({
    response: { subjects: [{ subject: '甲', additions: { adaptive: [
      { text: '会直接表达爱意', toward: '乙', evidence: [{ source: 'worldbook:1', quote: '"我爱你"' }] },
      { text: '会否定爱意', toward: '乙', evidence: [{ source: 'worldbook:1', quote: '"我不爱你"' }] },
      { text: '会向未知对象表达', toward: '不存在的人', evidence: [{ source: 'worldbook:1', quote: '"我爱你"' }] },
    ] } }] },
    envelope, previousCurrentState: null, now: NOW, deltaId: '65656565-1111-4111-8111-656565656565',
  });
  assert.deepEqual(compiled.delta.subjectSnapshots[0].adaptive.map(item => item.text), ['会直接表达爱意']);
  assert.deepEqual(compiled.delta.source.calibrationAudit[0].evidence, [{ source: 'worldbook:1', quote: '“我爱你”' }]);
  assert.match(compiled.delta.subjectSnapshots[0].adaptive[0].reason, /worldbook:1「“我爱你”」/);
  assert.ok(compiled.isolated.some(item => item.code === 'V3_CSE_EVIDENCE_UNLOCATED'));
  assert.ok(compiled.isolated.some(item => item.code === 'V3_CSE_TOWARD_UNBOUND'));
  assert.equal(JSON.stringify(compiled.delta).includes('我不爱你'), false);
});

test('同一校准操作跳过坏证据并使用合法证据，独立操作与前20条上限不被连坐', async () => {
  const oldAdaptive = {
    id: '60606060-1111-4111-8111-606060606060',
    text: '会谨慎信任他人', visibility: 'private', reason: '旧依据', origin: 'floor', towardEntityId: null,
    sourceFloorId: FLOOR1, sourceDeltaId: '61616161-1111-4111-8111-616161616161',
  };
  const previous = { id: '62626262-1111-4111-8111-626262626262', subjects: [{ subjectEntityId: A, core: [], adaptive: [oldAdaptive], situational: [] }] };
  const content = '本楼明确只否定无条件服从。甲仍会先核对事实。';
  const envelope = createCseEnvelope({ floor: floor(FLOOR2, content), floorMemory: memory(MEMORY2), baseline, currentState: previous, trackedSubjects: [entities[1]], entities });
  const mixed = await compileCseResponse({
    response: { subjects: [{
      subject: '甲',
      review: { adaptive: [{ previousText: oldAdaptive.text, action: 'refine', text: '在风险中会核对后再信任', evidence: [
        { source: 'canonicalContent', quote: '只否定无条件服从' },
        { source: 'canonicalContent', quote: '正文不存在的多次正向证明' },
      ] }] },
      additions: { adaptive: [{ text: '遇到风险会先核对事实', evidence: [{ source: 'canonicalContent', quote: '仍会先核对事实' }] }] },
    }] },
    envelope, previousCurrentState: previous, now: NOW, deltaId: '63636363-1111-4111-8111-636363636363',
  });
  assert.deepEqual(mixed.delta.subjectSnapshots[0].adaptive.map(item => item.text), ['在风险中会核对后再信任', '遇到风险会先核对事实']);
  assert.ok(mixed.isolated.some(item => item.code === 'V3_CSE_EVIDENCE_UNLOCATED'));
  assert.equal(mixed.isolated.some(item => item.code === 'V3_CSE_CALIBRATION_EVIDENCE_INSUFFICIENT'), false);
  assert.deepEqual(mixed.delta.source.calibrationAudit.map(item => [item.action, item.text]), [['refine', '在风险中会核对后再信任'], ['add', '遇到风险会先核对事实']]);

  const fullyGrounded = await compileCseResponse({
    response: { subjects: [{ subject: '甲', review: { adaptive: [{ previousText: oldAdaptive.text, action: 'refine', text: '在风险中会核对后再信任', evidence: [
      { source: 'canonicalContent', quote: '只否定无条件服从' },
      { source: 'canonicalContent', quote: '仍会先核对事实' },
    ] }] } }] },
    envelope, previousCurrentState: previous, now: NOW, deltaId: '64646464-1111-4111-8111-646464646464',
  });
  assert.deepEqual(fullyGrounded.delta.subjectSnapshots[0].adaptive.map(item => item.text), ['在风险中会核对后再信任']);
  assert.equal(fullyGrounded.isolated.length, 0);
  assert.deepEqual(fullyGrounded.delta.subjectSnapshots[0].changeSummary, ['调整长期适应：会谨慎信任他人（信息范围：私密；来源：本楼） → 在风险中会核对后再信任（信息范围：私密；来源：本楼）']);

  const overLimit = await compileCseResponse({
    response: { subjects: [{ subject: '甲', review: { adaptive: [{ previousText: oldAdaptive.text, action: 'refine', text: '只采用上限内合法证据', evidence: [
      { source: 'canonicalContent', quote: '只否定无条件服从' },
      ...Array.from({ length: 20 }, () => ({ source: 'canonicalContent', quote: '正文不存在的引用' })),
    ] }] } }] },
    envelope, previousCurrentState: previous, now: NOW, deltaId: '81818181-1111-4111-8111-818181818181',
  });
  assert.deepEqual(overLimit.delta.subjectSnapshots[0].adaptive.map(item => item.text), ['只采用上限内合法证据']);
  assert.equal(overLimit.delta.source.calibrationAudit[0].evidence.length, 1);
});

test('动态编译可固定超过 360 条合法逐项变化且不截断', async () => {
  const nextId = uuidFactory();
  const sourceDeltaId = nextId();
  const makePrevious = (category, index) => ({
    id: nextId(), text: `旧${category}-${index}`, visibility: 'private', reason: '旧楼已保存', origin: 'floor',
    towardEntityId: null, sourceFloorId: FLOOR1, sourceDeltaId,
  });
  const previous = {
    id: nextId(),
    subjects: [{
      subjectEntityId: A,
      core: [],
      adaptive: Array.from({ length: 120 }, (_, index) => makePrevious('长期', index)),
      situational: Array.from({ length: 120 }, (_, index) => makePrevious('情境', index)),
    }],
  };
  const envelope = createCseEnvelope({
    floor: floor(FLOOR2, '甲的长期与情境状态在本楼整体更新。'), floorMemory: memory(MEMORY2), baseline,
    currentState: previous, trackedSubjects: [entities[1]], entities,
  });
  const compiled = await compileCseResponse({
    response: { subjects: [{
      subject: '甲',
      adaptive: Array.from({ length: 120 }, (_, index) => `新长期-${index}`),
      situational: Array.from({ length: 120 }, (_, index) => `新情境-${index}`),
    }] },
    envelope, previousCurrentState: previous, now: NOW, deltaId: nextId(),
  });
  assert.equal(compiled.delta.fixedChanges[0].items.length, 480);
  assert.equal(validateStateDeltaRecord(compiled.delta, { expectedChatId: CHAT }).fixedChanges[0].items.length, 480);
});

test('逐楼 timeline 只报告编译后实际变化，覆盖拒绝摘要、Situational 增改删、历史截止与重建 ID', async () => {
  const firstEnvelope = createCseEnvelope({ floor: floor(FLOOR1, '甲连续两次核对后仍保持警惕。'), floorMemory: memory(MEMORY1), baseline, currentState: null, trackedSubjects: [entities[1]], entities });
  const first = await compileCseResponse({
    response: { changeSummary: '根级摘要不得参与', subjects: [{ subject: '甲', additions: { adaptive: [{ text: '遇事会反复核对', evidence: [{ source: 'canonicalContent', quote: '连续两次核对' }] }] }, situational: [{ text: '保持警惕', visibility: 'private', reason: '本楼结尾' }], changeSummary: ['模型声称建立长期习惯'] }] },
    envelope: firstEnvelope, previousCurrentState: null, now: NOW, deltaId: '50505050-1111-4111-8111-505050505050',
  });
  const firstWithoutRootSummary = await compileCseResponse({
    response: { subjects: [{ subject: '甲', additions: { adaptive: [{ text: '遇事会反复核对', evidence: [{ source: 'canonicalContent', quote: '连续两次核对' }] }] }, situational: [{ text: '保持警惕', visibility: 'private', reason: '本楼结尾' }], changeSummary: ['模型声称建立长期习惯'] }] },
    envelope: firstEnvelope, previousCurrentState: null, now: NOW, deltaId: '50505050-1111-4111-8111-505050505050',
  });
  assert.deepEqual(firstWithoutRootSummary.delta, first.delta, '根级摘要存在与否不能改变编译结果');
  const previous = { id: '51515151-1111-4111-8111-515151515151', subjects: first.delta.subjectSnapshots };
  const secondEnvelope = createCseEnvelope({ floor: floor(FLOOR2, '甲松开握紧的手，暂时平静下来。'), floorMemory: memory(MEMORY2), baseline, currentState: previous, trackedSubjects: [entities[1]], entities });
  const second = await compileCseResponse({
    response: { changeSummary: '另一个根级摘要', subjects: [{ subject: '甲', review: { adaptive: [{ previousText: '遇事会反复核对', action: 'refine', text: '从不再核对', evidence: [{ source: 'canonicalContent', quote: '正文里没有这句话' }] }] }, situational: [{ text: '暂时平静', visibility: 'private', reason: '松开握紧的手' }], changeSummary: ['长期习惯已经成功反转'] }] },
    envelope: secondEnvelope, previousCurrentState: previous, now: NOW, deltaId: '52525252-1111-4111-8111-525252525252',
  });
  assert.equal(second.delta.source.isolationSummary.count, second.isolated.length);
  assert.deepEqual(second.delta.source.isolationSummary.codes, ['V3_CSE_EVIDENCE_UNLOCATED', 'V3_CSE_CALIBRATION_EVIDENCE_INSUFFICIENT']);
  const timeline = deriveCseTimeline([first.delta, second.delta]);
  assert.ok(timeline[0].changes[0].items.some(item => item.category === 'situational' && item.action === 'add'));
  assert.deepEqual(timeline[1].changes[0].items.map(item => [item.category, item.action, item.before?.text, item.after?.text]), [
    ['situational', 'update', '保持警惕', '暂时平静'],
  ]);
  assert.equal(JSON.stringify(timeline[1]).includes('长期习惯已经成功反转'), false, '被拒操作的模型摘要不能进入实际变化');
  assert.deepEqual(timeline[0].endStateSubjects[0].situational.map(item => item.text), ['保持警惕'], '旧楼结束态不能混入后楼');
  assert.deepEqual(timeline[1].endStateSubjects[0].situational.map(item => item.text), ['暂时平静']);

  const changedSummary = structuredClone(second.delta);
  changedSummary.subjectSnapshots[0].changeSummary = ['完全不同的模型说明'];
  assert.deepEqual(deriveCseTimeline([first.delta, changedSummary])[1].changes, timeline[1].changes, '人物或根级摘要差异不改变实际 timeline');

  const rebuiltIds = structuredClone(second.delta);
  const frozenRebuiltChanges = structuredClone(rebuiltIds.fixedChanges);
  rebuiltIds.id = '53535353-1111-4111-8111-535353535353'; rebuiltIds.floorId = '54545454-1111-4111-8111-545454545454';
  for (const category of ['core', 'adaptive', 'situational']) for (const item of rebuiltIds.subjectSnapshots[0][category]) {
    item.id = item.id === second.delta.subjectSnapshots[0][category][0]?.id ? '55535353-1111-4111-8111-555353535353' : item.id;
    item.sourceDeltaId = rebuiltIds.id; item.sourceFloorId = rebuiltIds.floorId;
  }
  rebuiltIds.fixedChanges = frozenRebuiltChanges;
  const idTimeline = deriveCseTimeline([first.delta, second.delta, rebuiltIds]);
  assert.deepEqual(idTimeline[2].changes, timeline[1].changes, '固定变化不因前序或快照 ID 改写而重新推导');

  const removed = structuredClone(rebuiltIds);
  removed.id = '56565656-1111-4111-8111-565656565656'; removed.floorId = '57575757-1111-4111-8111-575757575757'; removed.subjectSnapshots[0].situational = [];
  const removedTimeline = deriveCseTimeline([first.delta, second.delta, rebuiltIds, removed]);
  assert.deepEqual(removedTimeline[3].changes, timeline[1].changes, '快照被外部改动也不得反向改写已固定历史变化');
});

test('timeline 与 replay 共用 legacy Core 保护，manual override 可生效且旧 isolation 字段保持未知兼容', async () => {
  const envelope = createCseEnvelope({ floor: floor(FLOOR1, '甲作出选择。'), floorMemory: memory(MEMORY1), baseline, currentState: null, trackedSubjects: [entities[1]], entities });
  const compiled = await compileCseResponse({ response: { subjects: [{ subject: '甲', core: [{ text: '坚持己见', visibility: 'private', reason: '首次状态' }] }] }, envelope, previousCurrentState: null, now: NOW, deltaId: '58585858-1111-4111-8111-585858585858' });
  const legacyFirst = structuredClone(compiled.delta); delete legacyFirst.source.calibrationVersion; delete legacyFirst.fixedChanges;
  const legacyOverwrite = structuredClone(legacyFirst);
  legacyOverwrite.id = '59595959-1111-4111-8111-595959595959'; legacyOverwrite.floorId = FLOOR2; legacyOverwrite.floorMemoryId = MEMORY2;
  legacyOverwrite.subjectSnapshots[0].core[0] = { ...legacyOverwrite.subjectSnapshots[0].core[0], id: '60606060-1111-4111-8111-606060606060', text: '轻易动摇', sourceFloorId: FLOOR2, sourceDeltaId: legacyOverwrite.id };
  const protectedTimeline = deriveCseTimeline([legacyFirst, legacyOverwrite]);
  assert.equal(protectedTimeline[1].noMaterialChange, false, 'legacy 保留原记录的 noMaterialChange 语义');
  assert.deepEqual(protectedTimeline[1].endStateSubjects[0].core.map(item => item.text), ['轻易动摇'], '本楼结束态只展示该楼已保存快照');
  const protectedReplay = await replayCurrentState({
    chatId: CHAT,
    narrativeGeneration: GEN,
    baselineId: baseline.id,
    floors: [{ id: FLOOR1 }, { id: FLOOR2 }],
    floorMemories: [],
    stateDeltas: [legacyFirst, legacyOverwrite],
    now: NOW,
  });
  assert.deepEqual(protectedReplay.subjects[0].core.map(item => item.text), ['坚持己见'], '全局聚合仍保留 legacy Core 保护');
  const manualOverwrite = structuredClone(legacyOverwrite); manualOverwrite.id = '61616161-1111-4111-8111-616161616161'; manualOverwrite.source.manualSubjectEntityIds = [A];
  const manualTimeline = deriveCseTimeline([legacyFirst, manualOverwrite]);
  assert.deepEqual(manualTimeline[1].changes, [], 'legacy 缺固定字段时不借前楼伪造 before/remove');
  assert.deepEqual(manualTimeline[1].endStateSubjects[0].core.map(item => item.text), ['轻易动摇'], 'legacy 快照仍参与当前态汇总');

  const withIsolation = structuredClone(compiled.delta);
  withIsolation.source.isolationSummary = { count: 2, codes: ['V3_CSE_OPTIONAL_ITEM_INVALID'] };
  assert.equal(validateStateDeltaRecord(withIsolation, { expectedChatId: CHAT }).source.isolationSummary.count, 2);
  delete withIsolation.source.isolationSummary;
  assert.equal(validateStateDeltaRecord(withIsolation, { expectedChatId: CHAT }).source.isolationSummary, undefined, '旧 delta 缺字段表示未知');
  withIsolation.source.isolationSummary = { count: 1, codes: ['V3_CSE_NOT_CONTROLLED'] };
  assert.throws(() => validateStateDeltaRecord(withIsolation, { expectedChatId: CHAT }), error => error.code === 'V3_STATEDELTA_INVALID');

  const fullyIsolated = await compileCseResponse({ response: { subjects: [{ subject: '甲', adaptive: [{ text: '' }], changeSummary: ['模型声称已经写入'] }] }, envelope, previousCurrentState: null, now: NOW, deltaId: '62626262-1111-4111-8111-626262626262' });
  const isolatedTimeline = deriveCseTimeline([fullyIsolated.delta]);
  assert.equal(isolatedTimeline[0].noMaterialChange, true);
  assert.equal(isolatedTimeline[0].changes.length, 0);
  assert.deepEqual(fullyIsolated.delta.source.isolationSummary, { count: 1, codes: ['V3_CSE_OPTIONAL_ITEM_INVALID'] });
});

test('真实 runtime 投影保留情境对象名称且只暴露有效变化与安全隔离摘要', async () => {
  const h = runtimeHarness({ cse: () => ({ jsonData: { changeSummary: '根级成功说明', subjects: [{ subject: '主角', adaptive: [{ text: '' }], situational: [{ text: '记得带伞', toward: '裴晚生', visibility: 'private', reason: '收到提醒' }], changeSummary: ['核心人格已经改变'] }] } }) });
  let state = await h.runtime.start().then(() => h.runtime.extractNext());
  state = await h.runtime.retryStateAnalysis(state.floors[0].floorId);
  const record = state.cseFloors[0].record;
  assert.equal(state.cseFloors[0].status, 'ready');
  assert.deepEqual(record.subjects[0].changes.map(change => ({ category: change.category, action: change.action, beforeText: change.beforeText, afterText: change.afterText })), [{ category: 'situational', action: 'add', beforeText: null, afterText: '记得带伞' }]);
  assert.equal(record.subjects[0].changes[0].after.reason, '收到提醒');
  assert.equal(record.subjects[0].changes[0].after.towardDisplayName, '裴晚生');
  assert.equal(JSON.stringify(record).includes('核心人格已经改变'), false);
  assert.deepEqual(record.isolationSummary, { count: 1, codes: ['V3_CSE_OPTIONAL_ITEM_INVALID'] });
  assert.deepEqual(record.endStateSubjects[0].situational.map(item => item.text), ['记得带伞']);
  assert.equal(state.cseSubjects[0].situational[0].towardDisplayName, '裴晚生');
});

test('runtime 的 CSE 只读 FloorMemory 冻结 USER；宿主改动不影响在途提交，0 楼与非紧邻均不借更早输入', async () => {
  let releaseCse;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const h = runtimeHarness({ chat: [user('原始作者输入'), assistant('第一楼。'), assistant('确认第一楼。')], cse: () => new Promise(resolve => { releaseCse = () => resolve({ jsonData: { noMaterialChange: true } }); markStarted(); }) });
  const pending = h.runtime.start().then(() => h.runtime.extractNext());
  await started;
  const request = JSON.parse(h.calls.find(call => call.systemPrompt === CSE_SYSTEM_PROMPT).taskMessages[0].content);
  assert.deepEqual(request.payload.currentUserInput, { source: 'currentUserInput', messages: [{ sourceSnapshotIndex: 0, messageIndex: 0, content: '原始作者输入' }] });
  h.context.chat.splice(0, 1);
  h.emit('MESSAGE_DELETED', 0);
  releaseCse();
  await pending;
  const reachable = await h.store.readReachable({ mode: 'runtime' });
  assert.equal(reachable.stateDeltas.length, 1);
  assert.equal(h.runtime.getState().lastCseError, null);

  const zero = runtimeHarness({ chat: [assistant('零号位置的 AI 楼。'), assistant('确认。')] });
  await zero.runtime.start().then(() => zero.runtime.extractNext());
  const zeroRequest = JSON.parse(zero.calls.find(call => call.systemPrompt === CSE_SYSTEM_PROMPT).taskMessages[0].content);
  assert.equal(zeroRequest.payload.currentUserInput, null);

  const notAdjacent = runtimeHarness({ chat: [user('更早输入'), assistant('第一楼。'), assistant('第二楼。'), assistant('确认第二楼。')] });
  await notAdjacent.runtime.start().then(() => notAdjacent.runtime.extractNext());
  await notAdjacent.runtime.extractNext();
  const cseRequests = notAdjacent.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).map(call => JSON.parse(call.taskMessages[0].content));
  assert.equal(cseRequests.at(-1).payload.currentUserInput, null, '上一条为 AI 时不能越过它借用更早 user');

  const multiple = runtimeHarness({ chat: [user('连续输入一'), user('连续输入二'), assistant('合并回应。'), assistant('确认合并回应。')] });
  await multiple.runtime.start().then(() => multiple.runtime.extractNext());
  const multipleRequest = JSON.parse(multiple.calls.find(call => call.systemPrompt === CSE_SYSTEM_PROMPT).taskMessages[0].content);
  assert.deepEqual(multipleRequest.payload.currentUserInput, { source: 'currentUserInput', messages: [
    { sourceSnapshotIndex: 0, messageIndex: 0, content: '连续输入一' },
    { sourceSnapshotIndex: 1, messageIndex: 1, content: '连续输入二' },
  ] });

  const autoHidden = runtimeHarness({ chat: [
    { is_user: true, is_system: true, extra: { qianqianjieAutoHide: { schemaVersion: 1, chatId: CHAT } }, mes: '自动隐藏但仍是作者输入' },
    assistant('读取隐藏作者输入。'),
    assistant('确认读取。'),
  ] });
  await autoHidden.runtime.start().then(() => autoHidden.runtime.extractNext());
  const autoHiddenRequest = JSON.parse(autoHidden.calls.find(call => call.systemPrompt === CSE_SYSTEM_PROMPT).taskMessages[0].content);
  assert.deepEqual(autoHiddenRequest.payload.currentUserInput, { source: 'currentUserInput', messages: [{ sourceSnapshotIndex: 0, messageIndex: 0, content: '自动隐藏但仍是作者输入' }] });

  const trueSystem = runtimeHarness({ chat: [
    { is_user: true, is_system: true, extra: { type: 'narrator' }, mes: '宿主 system 消息' },
    assistant('不把 system 当作者输入。'),
    assistant('确认排除。'),
  ] });
  await trueSystem.runtime.start().then(() => trueSystem.runtime.extractNext());
  const trueSystemRequest = JSON.parse(trueSystem.calls.find(call => call.systemPrompt === CSE_SYSTEM_PROMPT).taskMessages[0].content);
  assert.equal(trueSystemRequest.payload.currentUserInput, null, '带宿主 extra.type 的真实 system 不能成为作者输入');
});
