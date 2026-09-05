import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostAdapter } from '../src/v3/host-adapter.js';
import { createFoundationStore } from '../src/v3/foundation-store.js';
import { createFoundationRuntime } from '../src/v3/foundation-runtime.js';
import { createV3MemoryRuntime } from '../src/v3/memory-runtime.js';
import { EXTRACTOR_SYSTEM_PROMPT } from '../src/v3/extractor.js';
import {
  CSE_SYSTEM_PROMPT, captureCseBaseline, compileCseResponse, createCseEnvelope, replayCurrentState,
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

function backendHarness({ conflictRootPut = null } = {}) {
  const records = new Map();
  let rootPuts = 0;
  const envelope = (data, revision) => ({ schemaVersion: 1, revision, generationId: '99999999-1111-4111-8111-111111111111', createdAt: NOW, updatedAt: NOW, data: structuredClone(data) });
  const failure = status => Object.assign(new Error(`HTTP ${status}`), { status });
  return { records, getRootPuts: () => rootPuts, client: {
    async get(collection, key) { const found = records.get(`${collection}/${key}`); if (!found) throw failure(404); return envelope(found.data, found.revision); },
    async put(collection, key, data, expectedRevision) { const mapKey = `${collection}/${key}`, previous = records.get(mapKey); if (key === 'v3-root') { rootPuts += 1; if (rootPuts === conflictRootPut) throw failure(409); } if ((previous?.revision ?? 0) !== expectedRevision) throw failure(409); const revision = (previous?.revision ?? 0) + 1; records.set(mapKey, { revision, data: structuredClone(data) }); return envelope(data, revision); },
  } };
}

function runtimeHarness({ cse, host = 'official', backendOptions, clock = () => new Date(NOW) } = {}) {
  const handlers = new Map(), calls = [], backend = backendHarness(backendOptions);
  let enabled = true;
  const books = new Map([['当前书', { entries: { 1: { uid: 1, content: '<content>启用作者设定</content>' }, 2: { uid: 2, content: '禁用支线', disable: true } } }], ['未链接书', { entries: { 3: { uid: 3, content: '不得进入基线' } } }]]);
  const context = {
    name1: '林岚', name2: '裴晚生', personaId: 'persona-linlan', characterId: 0, groupId: null, chatId: 'host-chat',
    characters: [{ avatar: 'character.png', name: '裴晚生', data: { description: '角色描述', personality: '冷静克制', scenario: '雨夜', extensions: { world: '当前书' } } }],
    userAvatar: 'persona.png', powerUserSettings: { persona_description: '调查员林岚' },
    chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT } }, chat: [user('继续'), assistant('裴晚生提醒你带伞。'), assistant('用于确认上一楼稳定。')],
    async loadWorldInfoBatch(names) { return new Map(names.filter(name => books.has(name)).map(name => [name, books.get(name)])); },
    getWorldInfoNames() { return [...books.keys()]; }, async simulateWorldInfoActivation() { return { activatedEntries: [{ world: '当前书', uid: 1 }] }; },
    eventTypes: Object.fromEntries(['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MORE_MESSAGES_LOADED'].map(name => [name, name])),
    eventSource: { on(name, listener) { handlers.set(name, [...(handlers.get(name) ?? []), listener]); } },
  };
  const globalRef = host === 'luker' ? { Luker: { getContext: () => context } } : { SillyTavern: { getContext: () => context } };
  const hostAdapter = createHostAdapter({ globalRef });
  const store = createFoundationStore({ client: backend.client, contextProvider: () => ({ hostChatId: context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }), isEnabled: () => enabled });
  const foundationRuntime = createFoundationRuntime({ hostAdapter, store, contextProvider: () => context, isEnabled: () => enabled, now: clock, newUuid: uuidFactory(), logger: { warn() {} } });
  const generateUtilityTask = async options => {
    calls.push(options);
    if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) return { jsonData: { summary: '裴晚生提醒用户带伞。', people: [{ name: '你', role: 'user' }, { name: '裴晚生' }], commitments: [{ speaker: '裴晚生', targets: ['你'], content: '提醒带伞' }] }, taskMetadata: { source: 'test', sourceLabel: '测试 API', model: 'mock' } };
    return cse ? cse(options, calls) : { jsonData: { subjects: [{ subject: '主角', situational: [{ text: '记得带伞', visibility: 'private', reason: '收到提醒' }] }] }, taskMetadata: { source: 'test', sourceLabel: '测试 API', model: 'mock' } };
  };
  const runtime = createV3MemoryRuntime({ foundationRuntime, store, hostAdapter, generateUtilityTask, isEnabled: () => enabled, sanitizerOptions: () => ({ keepTags: 'content' }), now: clock, newUuid: uuidFactory(), logger: { warn() {} } });
  runtime.bind({ eventSource: context.eventSource, eventTypes: context.eventTypes });
  return { runtime, foundationRuntime, store, backend, context, calls, emit(name, ...args) { for (const listener of handlers.get(name) ?? []) listener(...args); }, setEnabled(value) { enabled = value; } };
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
  state = await h.runtime.editSummary(firstFloorId, '用户手工修订第一楼摘要', '校正事实');
  assert.deepEqual(state.cseFloors.map(item => item.status), ['pending', 'pending'], '手工修订前置完整投影同样使下游全部待分析');
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
  assert.ok(first.isolated.some(item => item.code === 'V3_CSE_OPTIONAL_ITEM_INVALID'));
  const previous = { id: 'aaaaaaaa-1111-4111-8111-111111111111', subjects: first.delta.subjectSnapshots.map(({ changeSummary, coreChallenges, ...subject }) => subject) };
  const envelope2 = createCseEnvelope({ floor: floor(FLOOR2, '第二楼'), floorMemory: memory(MEMORY2), baseline, currentState: previous, trackedSubjects: tracked, entities });
  const second = await compileCseResponse({ response: { subjects: [{ subject: '你', core: ['鲁莽'], adaptive: [{ text: '信任', toward: '甲' }, { text: '戒备', toward: '乙' }] }] }, envelope: envelope2, previousCurrentState: previous, now: NOW, deltaId: 'bbbbbbbb-1111-4111-8111-111111111111' });
  const frozen = second.delta.subjectSnapshots.find(item => item.subjectEntityId === USER);
  assert.equal(frozen.core[0].text, '谨慎');
  assert.match(frozen.coreChallenges.join('|'), /鲁莽/);
  assert.deepEqual(frozen.adaptive.map(item => item.towardEntityId), [A, B]);
});

test('已知 toward 同名仍按歧义失败隔离，不猜测绑定', async () => {
  const ambiguous = [...entities, { id: 'dddddddd-1111-4111-8111-111111111111', entityType: 'person', displayName: '丙', aliases: [{ name: '乙' }], specialRole: 'none' }];
  const envelope = createCseEnvelope({ floor: floor(FLOOR1, '歧义楼'), floorMemory: memory(MEMORY1), baseline, currentState: null, trackedSubjects: [entities[0]], entities: ambiguous });
  const result = await compileCseResponse({ response: { subjects: [{ subject: '你', adaptive: [{ text: '警惕', toward: '乙', visibility: 'observable' }] }] }, envelope, previousCurrentState: null, now: NOW, deltaId: 'eeeeeeee-1111-4111-8111-111111111111' });
  assert.deepEqual(result.delta.subjectSnapshots[0].adaptive, []);
  assert.ok(result.isolated.some(item => item.code === 'V3_CSE_TOWARD_UNBOUND'));
});

test('私密/authorial 不进入其他主体的 publicStateOfOthers；空 delta 也可重放为已分析', async () => {
  const current = { subjects: [
    { subjectEntityId: USER, core: [], adaptive: [], situational: [{ text: '用户私心', visibility: 'private', reason: '私密', origin: 'floor', towardEntityId: null, sourceFloorId: FLOOR1, sourceDeltaId: null }] },
    { subjectEntityId: A, core: [{ text: '作者设定', visibility: 'authorial', reason: '卡', origin: 'baseline', towardEntityId: null, sourceFloorId: null, sourceDeltaId: null }], adaptive: [], situational: [{ text: '公开动作', visibility: 'observable', reason: '看见', origin: 'floor', towardEntityId: null, sourceFloorId: FLOOR1, sourceDeltaId: null }] },
  ] };
  const envelope = createCseEnvelope({ floor: floor(FLOOR1, '正文'), floorMemory: memory(MEMORY1), baseline, currentState: current, trackedSubjects: entities.slice(0, 2), entities });
  const forUser = envelope.request.payload.previousState.find(item => item.subject === '林岚');
  assert.deepEqual(forUser.publicStateOfOthers[0].core, []);
  assert.deepEqual(forUser.publicStateOfOthers[0].situational.map(item => item.text), ['公开动作']);
  const compiled = await compileCseResponse({ response: { noMaterialChange: true }, envelope, previousCurrentState: null, now: NOW, deltaId: 'cccccccc-1111-4111-8111-111111111111' });
  assert.equal(compiled.delta.noMaterialChange, true);
  const replay = await replayCurrentState({ chatId: CHAT, narrativeGeneration: GEN, baselineId: baseline.id, floors: [floor(FLOOR1, '正文')], floorMemories: [{ ...memory(MEMORY1), floorId: FLOOR1, recordStatus: 'active' }], stateDeltas: [compiled.delta], now: NOW });
  assert.deepEqual(replay.appliedDeltaIds, [compiled.delta.id]);
});

test('缺失或未知 visibility 都编译为 private，不进入他人公开视图', async () => {
  const sourceEnvelope = createCseEnvelope({ floor: floor(FLOOR1, '私密楼'), floorMemory: memory(MEMORY1), baseline, currentState: null, trackedSubjects: [entities[1]], entities });
  const compiled = await compileCseResponse({ response: { subjects: [{ subject: '甲', situational: [{ text: '没说出的念头' }, { text: '未知可见性', visibility: 'omniscient' }, { text: '确实可见', visibility: 'observable' }] }] }, envelope: sourceEnvelope, previousCurrentState: null, now: NOW, deltaId: 'ffffffff-1111-4111-8111-111111111111' });
  assert.deepEqual(compiled.delta.subjectSnapshots[0].situational.map(item => item.visibility), ['private', 'private', 'observable']);
  const currentState = { subjects: [
    { subjectEntityId: USER, core: [], adaptive: [], situational: [] },
    ...compiled.delta.subjectSnapshots.map(({ changeSummary, coreChallenges, ...subject }) => subject),
  ] };
  const observerEnvelope = createCseEnvelope({ floor: floor(FLOOR2, '观察楼'), floorMemory: memory(MEMORY2), baseline, currentState, trackedSubjects: [entities[0]], entities });
  const publicItems = observerEnvelope.request.payload.previousState[0].publicStateOfOthers.flatMap(subject => subject.situational.map(item => item.text));
  assert.deepEqual(publicItems, ['确实可见']);
});

test('直接 baseline 捕获在 official 宿主缺少世界书 API 时安全降级', async () => {
  const ctx = { name1: '用户', name2: '角色', characterId: 0, characters: [{ name: '角色', data: {} }], chat: [] };
  const hostAdapter = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => ctx } } });
  const result = await captureCseBaseline({ hostAdapter, chatId: CHAT, narrativeGeneration: GEN, now: NOW });
  assert.equal(result.baseline.userPersona.name, '用户');
  assert.deepEqual(result.baseline.worldInfoSources, []);
});
