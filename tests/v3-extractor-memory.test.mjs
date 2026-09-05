import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostAdapter } from '../src/v3/host-adapter.js';
import { createFoundationStore } from '../src/v3/foundation-store.js';
import { createFoundationRuntime } from '../src/v3/foundation-runtime.js';
import { createV3MemoryRuntime } from '../src/v3/memory-runtime.js';
import { createV3RecallRuntime } from '../src/v3/recall-runtime.js';
import { readRecallSource } from '../src/v3/recall-source.js';
import { createExtractorEnvelope, EXTRACTOR_OUTPUT_CONTRACT, EXTRACTOR_SYSTEM_PROMPT, normalizeExtractorResponse, runExtractorRequest } from '../src/v3/extractor.js';
import { CSE_SYSTEM_PROMPT } from '../src/v3/cse-engine.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GENERATION = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-09-02T00:00:00.000Z';
const assistant = mes => ({ is_user: false, is_system: false, mes, swipes: [mes], swipe_id: 0 });
const user = mes => ({ is_user: true, is_system: false, mes });
const uuidFactory = () => { let value = 0; return () => `${(++value).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`; };

function backendHarness() {
  const records = new Map();
  const calls = [];
  let conflictRoot = false;
  const envelope = (data, revision) => ({ schemaVersion: 1, revision, generationId: '11111111-1111-4111-8111-111111111111', createdAt: NOW, updatedAt: NOW, data: structuredClone(data) });
  const error = status => Object.assign(new Error(`HTTP ${status}`), { status });
  return { records, calls, setConflictRoot(value) { conflictRoot = value; }, client: {
    async get(collection, key) { calls.push(['get', collection, key]); const found = records.get(`${collection}/${key}`); if (!found) throw error(404); return envelope(found.data, found.revision); },
    async put(collection, key, data, expectedRevision) { calls.push(['put', collection, key, expectedRevision]); const mapKey = `${collection}/${key}`, previous = records.get(mapKey); if (key === 'v3-root' && conflictRoot) throw error(409); if ((previous?.revision ?? 0) !== expectedRevision) throw error(409); const revision = (previous?.revision ?? 0) + 1; records.set(mapKey, { revision, data: structuredClone(data) }); return envelope(data, revision); },
  } };
}

function harness({ text = '裴晚生提醒你带伞。', initialChat = null, utility, host = 'official', automation = { enabled: false, batchSize: 2 }, notifyUser, isMainGenerationActive, customGuidance, foundationRefresh, eventTypes = null, sharedBackend = null, sharedContext = null } = {}) {
  let enabled = true;
  const handlers = new Map();
  const context = sharedContext ?? {
    name1: '林岚', personaId: 'persona-linlan', characterId: 0, groupId: null, chatId: 'host-chat', characters: [{ avatar: 'character.png' }], userAvatar: 'persona.png',
    chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT } }, chat: initialChat ?? [user('继续'), assistant(text), assistant('用于确认上一楼稳定。')],
    eventTypes: eventTypes ?? Object.fromEntries(['GENERATION_STARTED', 'GENERATION_STOPPED', 'GENERATION_ENDED', 'CHAT_CHANGED', 'MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MORE_MESSAGES_LOADED'].map(name => [name, name])),
    eventSource: { on(name, listener) { const values = handlers.get(name) ?? []; values.push(listener); handlers.set(name, values); } },
  };
  const globalRef = host === 'luker' ? { Luker: { getContext: () => context } } : { SillyTavern: { getContext: () => context } };
  const hostAdapter = createHostAdapter({ globalRef });
  const backend = sharedBackend ?? backendHarness();
  const identityProvider = () => ({ hostChatId: context.chatId, chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' });
  const store = createFoundationStore({ client: backend.client, contextProvider: identityProvider, isEnabled: () => enabled });
  const foundationBase = createFoundationRuntime({ hostAdapter, store, contextProvider: () => context, isEnabled: () => enabled, newUuid: uuidFactory(), now: () => new Date(NOW), logger: { warn() {} } });
  const foundationRuntime = typeof foundationRefresh === 'function' ? { ...foundationBase, refreshStatus: () => foundationRefresh(foundationBase) } : foundationBase;
  const calls = [];
  const generateUtilityTask = async options => {
    calls.push(options);
    if (utility) return utility(options, calls.length);
    return { jsonData: { summary: '裴晚生提醒用户带伞。', people: [{ name: '裴晚生' }, { name: '你', role: 'user' }], events: [{ title: '带伞提醒', description: '裴晚生提醒用户带伞。' }] }, taskMetadata: { source: 'shared-utility', sourceLabel: '机械副 API', model: 'mock-model', finishReason: 'stop' } };
  };
  const runtime = createV3MemoryRuntime({ foundationRuntime, store, hostAdapter, generateUtilityTask, isEnabled: () => enabled, automationSettings: () => automation, notifyUser, isMainGenerationActive, customGuidance: () => typeof customGuidance === 'function' ? customGuidance() : '保持简洁', now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} } });
  runtime.bind({ eventSource: context.eventSource, eventTypes: context.eventTypes });
  const emit = (name, ...args) => (handlers.get(name) ?? []).forEach(listener => listener(...args));
  return { runtime, foundationRuntime, store, backend, context, hostAdapter, calls, emit, setEnabled(value) { enabled = value; }, setAutomation(value) { automation = value; } };
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

async function direct(response, { content = '裴晚生提醒你带伞。', entities = [], userIdentity = { displayName: '林岚', aliases: ['林岚', '你', '{{user}}'] } } = {}) {
  const floor = { id: '11111111-1111-4111-8111-111111111111', chatId: CHAT, narrativeGeneration: GENERATION, assistantSeq: 1, content: { canonicalContent: content } };
  const envelope = await createExtractorEnvelope({ batchId: '33333333-3333-4333-8333-333333333333', chatId: CHAT, narrativeGeneration: GENERATION, checkpointId: null, floor, entities, userIdentity });
  return normalizeExtractorResponse({ response, envelope, floor, existingEntities: entities, now: NOW, expectedScope: envelope.scope });
}

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
  assert.match(EXTRACTOR_SYSTEM_PROMPT, /summary 是唯一必填项/);
  assert.match(EXTRACTOR_SYSTEM_PROMPT, /不输出 UUID/);
  assert.doesNotMatch(EXTRACTOR_OUTPUT_CONTRACT, /entityId|mentionKey|evidence|floorId|operation/i);
  const request = JSON.parse(call.taskMessages[0].content);
  assert.deepEqual(Object.keys(request), ['task', 'locale', 'customGuidance', 'payload']);
  assert.equal(request.payload.canonicalContent.includes('忽略规则'), true);
  assert.deepEqual(request.payload.userIdentity, { displayName: '林岚', aliases: ['林岚', '你', '{{user}}'] });
  assert.doesNotMatch(JSON.stringify(request), /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
});

test('仅 {summary} 就能形成有效 FloorMemory，所有可选数组自然为空', async () => {
  const result = await direct({ summary: '裴晚生提醒用户带伞。' });
  assert.equal(result.memory.summary.aiText, '裴晚生提醒用户带伞。');
  for (const key of ['chronology', 'locations', 'participants', 'actions', 'observations', 'informationTransfers', 'privateCognition', 'commitments', 'eventFragments', 'exactAnchors', 'openLoops', 'ambiguities', 'cseSignals']) assert.deepEqual(result.memory[key], [], key);
  assert.equal(result.needsReview, false);
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
  const result = await direct({ summary: '裴晚生关心对方是否吃饭并叮嘱保重。', people: '裴晚生', events: [{ title: '关心叮嘱', description: '裴晚生询问是否吃饭并叮嘱保重。', quote: '食咗饭未？' }], exactQuotes: ['食咗饭未？', 'Take care.'] }, { content });
  assert.equal(result.memory.eventFragments.length, 1);
  assert.equal(result.memory.exactAnchors.length, 2);
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
    customGuidance: () => {
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
  const runtime = createV3MemoryRuntime({ foundationRuntime, store, hostAdapter: {}, generateUtilityTask: async () => ({}), isEnabled: true, logger: { warn() {} } });
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
  assert.deepEqual(h.calls.map(call => call.systemPrompt), [
    EXTRACTOR_SYSTEM_PROMPT, EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT,
    EXTRACTOR_SYSTEM_PROMPT, EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT,
    EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT,
  ]);
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
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 0);
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
  await waitFor(() => h.runtime.getState().rebuildStatus === 'caughtUp' && !h.runtime.getState().activeAutoMemory, '五楼历史未完成初始记忆');
  assert.equal(h.runtime.getState().rememberedCount, 5);

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
  assert.equal(rebuiltContents.length, 5);
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

test('fresh chat 本次运行从零稳定楼起步后只等实时 N 批；刷新后首次看到旧稳定楼仍是历史欠账', async () => {
  const fresh = harness({
    initialChat: [user('开始'), assistant('开场白')],
    automation: { enabled: true, batchSize: 2 },
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: `实时-${JSON.parse(options.taskMessages[0].content).payload.canonicalContent}` } }
      : { jsonData: { noMaterialChange: true } },
  });
  await fresh.runtime.start();
  assert.equal(fresh.runtime.getState().stableCount, 0);
  assert.equal(fresh.runtime.getState().rebuildStatus, 'caughtUp');
  assert.equal(fresh.runtime.allowsRealtimeTailFromEmpty(), true);
  assert.equal(fresh.calls.length, 0);

  fresh.context.chat.push(assistant('第一条新增回复'));
  fresh.emit('MESSAGE_RECEIVED');
  await waitFor(() => fresh.runtime.getState().lastAutoMemory?.status === 'waiting', 'fresh chat 的 N-1 实时尾部未进入等待态');
  assert.equal(fresh.runtime.getState().rebuildStatus, 'waitingRealtime');
  assert.equal(fresh.runtime.getState().stableCount, 1);
  assert.equal(fresh.calls.length, 0);
  assert.equal(fresh.runtime.shouldBlockMainGeneration(), false);

  fresh.context.chat.push(assistant('第二条新增回复'));
  fresh.emit('MESSAGE_RECEIVED');
  await waitFor(() => fresh.runtime.getState().lastAutoMemory?.status === 'completed', 'fresh chat 的首个实时整批未自动完成');
  assert.equal(fresh.runtime.getState().rememberedCount, 2);
  assert.equal(fresh.runtime.getState().cseReady, true);
  assert.deepEqual(fresh.calls.map(call => call.systemPrompt), [EXTRACTOR_SYSTEM_PROMPT, EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT]);
  assert.equal(fresh.runtime.shouldBlockMainGeneration(), false);

  fresh.runtime.invalidate();
  const refreshed = harness({
    automation: { enabled: true, batchSize: 2 },
    sharedBackend: fresh.backend,
    sharedContext: fresh.context,
  });
  await refreshed.runtime.start();
  assert.equal(refreshed.runtime.allowsRealtimeTailFromEmpty(), false, 'fresh 起点不得跨刷新持久化');

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
    initialChat: [user('开始'), assistant('历史一'), assistant('历史二'), assistant('待确认尾楼')],
    automation: { enabled: true, batchSize: 2 },
    isMainGenerationActive: () => false,
    notifyUser: value => notifications.push(value),
  });
  await h.runtime.start();
  h.emit('GENERATION_STARTED', 'normal', {}, true);
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => h.runtime.getState().rebuildStatus === 'caughtUp' && !h.runtime.getState().activeAutoMemory);

  assert.equal(h.runtime.getState().rememberedCount, 2);
  assert.deepEqual(h.calls.map(call => call.systemPrompt), [EXTRACTOR_SYSTEM_PROMPT, EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT]);
  assert.deepEqual(notifications, [{ kind: 'success', text: '千千结已完成 AI #1–2 的历史记忆重建。' }]);
  assert.equal(h.runtime.shouldBlockMainGeneration(), false);
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
    assert.deepEqual(h.calls.map(call => call.systemPrompt), [EXTRACTOR_SYSTEM_PROMPT, EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT]);
    assert.deepEqual(notifications, [{ kind: 'success', text: '千千结已完成 AI #1–2 的历史记忆重建。' }]);
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
  assert.equal(first.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 0);
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
  assert.equal(second.runtime.getState().rebuildStatus, 'pendingRebuild');
  assert.equal(second.runtime.getState().rememberedCount, 1);
  await second.runtime.startHistoricalRebuild();
  await waitFor(() => second.runtime.getState().rebuildStatus === 'caughtUp');
  assert.equal(second.runtime.getState().rememberedCount, 3);
  assert.equal(second.runtime.getState().cseReady, true);
  assert.equal(second.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).length, 2, '继续时不得重复提取已落盘第一楼');
});

test('面板未打开时累计到 N 才按整批 FloorMemory → 顺序 CSE 自动闭环，重复完成事件幂等', async () => {
  const notifications = [];
  const h = harness({
    automation: { enabled: false, batchSize: 2 },
    notifyUser: value => notifications.push(value),
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: `自动摘要-${JSON.parse(options.taskMessages[0].content).payload.canonicalContent}` } }
      : { jsonData: { noMaterialChange: true } },
  });
  await primeRealtimeTail(h);
  assert.equal(h.runtime.shouldBlockMainGeneration(), false, '日常自动维护不得开启主生成门禁');
  notifications.splice(0);

  h.context.chat.push(assistant('新尾楼让第二个 AI 楼稳定。'));
  h.emit('MESSAGE_RECEIVED');
  await waitFor(() => h.runtime.getState().lastAutoMemory?.status === 'waiting');
  assert.equal(h.calls.length, 0, '历史追平后的实时 N-1 尾部不能调用提取或 CSE');

  h.context.chat.push(assistant('再一楼让实时尾部达到批次门槛。'));
  h.emit('MESSAGE_RECEIVED');
  await waitFor(() => h.runtime.getState().lastAutoMemory?.status === 'completed', '自动批次未完成');
  assert.deepEqual(h.calls.map(call => call.systemPrompt), [EXTRACTOR_SYSTEM_PROMPT, EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT]);
  const completed = h.runtime.getState();
  assert.equal(completed.rememberedCount, 3);
  assert.equal(completed.cseReady, true);
  assert.deepEqual(completed.cseFloors.map(item => item.status), ['noChange', 'noChange', 'noChange']);
  assert.equal(notifications.length, 1);

  const callCount = h.calls.length;
  h.emit('MESSAGE_RECEIVED');
  await waitFor(() => !h.runtime.getState().activeAutoMemory && h.runtime.getState().status !== 'running');
  assert.equal(h.calls.length, callCount, '重复完成事件不得重复写同一楼');

  h.context.chat[2].mes = '第二个稳定 AI 楼已经重 Roll。';
  h.context.chat[2].swipes = ['第二个稳定 AI 楼已经重 Roll。'];
  const beforeSwipeCalls = h.calls.length;
  h.emit('MESSAGE_SWIPED', 2);
  await h.foundationRuntime.refreshStatus();
  await h.runtime.refreshStatus();
  assert.equal(h.runtime.getState().rebuildStatus, 'pendingRebuild');
  assert.equal(h.calls.length, beforeSwipeCalls, '历史变化只能检测，不能沿用自动维护授权偷跑');
  await h.runtime.startHistoricalRebuild();
  await waitFor(() => h.runtime.getState().lastAutoMemory?.mode === 'historical' && h.runtime.getState().rememberedCount === 3 && h.runtime.getState().cseReady, '按钮授权后应从可达边界重建');
  assert.equal(h.runtime.getState().replayedCurrentState.appliedDeltaIds.length, 3);

  h.context.chat.push(assistant('再一楼让回退后的两个正文稳定。'));
  h.emit('MESSAGE_RECEIVED');
  await waitFor(() => h.runtime.getState().lastAutoMemory?.status === 'waiting');
  assert.equal(h.runtime.getState().rebuildStatus, 'waitingRealtime');
});

test('N=2 时第二楼失败仍保持原批次，下次只重试第二楼且整批 FloorMemory 完成后才顺序 CSE', async () => {
  let failSecond = true;
  const h = harness({
    automation: { enabled: false, batchSize: 2 },
    utility: options => {
      if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) {
        const content = JSON.parse(options.taskMessages[0].content).payload.canonicalContent;
        if (content === '新尾楼让第二个 AI 楼稳定。' && failSecond) { failSecond = false; throw Object.assign(new Error('模拟第二楼提取失败'), { code: 'AUTO_TEST_FAILURE' }); }
        return { jsonData: { summary: `摘要-${content}` } };
      }
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await primeRealtimeTail(h);
  h.context.chat.push(assistant('新尾楼让第二个 AI 楼稳定。'));
  h.emit('MESSAGE_RECEIVED');
  await waitFor(() => h.runtime.getState().lastAutoMemory?.status === 'waiting');
  h.context.chat.push(assistant('再一楼让实时尾部达到批次门槛。'));
  h.emit('MESSAGE_RECEIVED');
  await waitFor(() => h.runtime.getState().lastAutoMemory?.status === 'failed');
  assert.equal(h.runtime.getState().lastAutoMemory.assistantSeq, 3);
  assert.equal(h.runtime.getState().rememberedCount, 2);
  assert.equal(h.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 0, '提取失败后不得越过当前批次调用 CSE');

  await h.runtime.retryAutomation();
  await waitFor(() => h.runtime.getState().lastAutoMemory?.status === 'completed');
  assert.equal(h.runtime.getState().rememberedCount, 3);
  assert.equal(h.runtime.getState().unprocessedCount, 0);
  assert.equal(h.runtime.getState().cseReady, true);
  const extractorContents = h.calls.filter(call => call.systemPrompt === EXTRACTOR_SYSTEM_PROMPT).map(call => JSON.parse(call.taskMessages[0].content).payload.canonicalContent);
  assert.deepEqual(extractorContents, ['用于确认上一楼稳定。', '新尾楼让第二个 AI 楼稳定。', '新尾楼让第二个 AI 楼稳定。']);
  assert.deepEqual(h.calls.slice(-2).map(call => call.systemPrompt), [CSE_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT]);

  h.setEnabled(false);
  await h.runtime.setEnabled(false);
  const callsBeforeDisabledEvent = h.calls.length;
  h.context.chat.push(assistant('关闭后的新回复。'));
  h.emit('MESSAGE_RECEIVED');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.calls.length, callsBeforeDisabledEvent, '关闭后不得调用提取或 CSE API');
  assert.equal(h.runtime.getState().pluginEnabled, false);
});

test('跨 runtime 从持久事实重建 N=2 失败批次，不会提前推进部分 CSE', async () => {
  let failSecond = true;
  const first = harness({
    automation: { enabled: false, batchSize: 2 },
    utility: options => {
      if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) {
        const content = JSON.parse(options.taskMessages[0].content).payload.canonicalContent;
        if (content === '新尾楼让第二个 AI 楼稳定。' && failSecond) { failSecond = false; throw Object.assign(new Error('模拟第二楼提取失败'), { code: 'AUTO_RESTART_TEST_FAILURE' }); }
        return { jsonData: { summary: `摘要-${content}` } };
      }
      return { jsonData: { noMaterialChange: true } };
    },
  });
  await primeRealtimeTail(first);
  first.context.chat.push(assistant('新尾楼让第二个 AI 楼稳定。'));
  first.emit('MESSAGE_RECEIVED');
  await waitFor(() => first.runtime.getState().lastAutoMemory?.status === 'waiting');
  first.context.chat.push(assistant('再一楼让实时尾部达到批次门槛。'));
  first.emit('MESSAGE_RECEIVED');
  await waitFor(() => first.runtime.getState().lastAutoMemory?.status === 'failed');
  assert.equal(first.runtime.getState().rememberedCount, 2);
  assert.equal(first.calls.filter(call => call.systemPrompt === CSE_SYSTEM_PROMPT).length, 0);
  first.runtime.invalidate();

  const second = harness({
    automation: { enabled: true, batchSize: 2 },
    sharedBackend: first.backend,
    sharedContext: first.context,
    utility: options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: `重建后摘要-${JSON.parse(options.taskMessages[0].content).payload.canonicalContent}` } }
      : { jsonData: { noMaterialChange: true } },
  });
  await second.runtime.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(second.calls.length, 0, '刷新后的新 runtime 不得自动续跑失败批次');
  assert.equal(second.runtime.getState().rebuildStatus, 'pendingRebuild');
  await second.runtime.startHistoricalRebuild();
  await waitFor(() => second.runtime.getState().lastAutoMemory?.status === 'completed', '手动继续后未从持久事实恢复原批次');
  assert.equal(second.runtime.getState().rememberedCount, 3);
  assert.equal(second.runtime.getState().cseReady, true);
  assert.deepEqual(second.calls.map(call => call.systemPrompt), [EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT]);
  assert.equal(JSON.parse(second.calls[0].taskMessages[0].content).payload.canonicalContent, '新尾楼让第二个 AI 楼稳定。', '已持久的批次第一楼不应重提取');

  const clean = harness({ automation: { enabled: true, batchSize: 2 } });
  await clean.runtime.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(clean.calls.length, 0);
  await clean.runtime.startHistoricalRebuild();
  await waitFor(() => clean.runtime.getState().lastAutoMemory?.status === 'completed');
  assert.equal(clean.runtime.getState().stableCount, 1);
  assert.deepEqual(clean.calls.map(call => call.systemPrompt), [EXTRACTOR_SYSTEM_PROMPT, CSE_SYSTEM_PROMPT], '没有完成前缀的旧聊天属于历史欠账，最后不足 N 也必须 flush');
});

test('自动 reconciling、extracting、CSE 全程共用一个门闩，手动入口不并发且批次后恢复', async () => {
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
  h.context.chat.push(assistant('新尾楼让第二个 AI 楼稳定。'));
  h.emit('MESSAGE_RECEIVED');
  await waitFor(() => h.runtime.getState().lastAutoMemory?.status === 'waiting');
  holdFoundation = true;
  holdExtractor = true;
  holdCse = true;
  h.context.chat.push(assistant('再一楼让实时尾部达到批次门槛。'));
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
