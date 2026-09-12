import test from 'node:test';
import assert from 'node:assert/strict';
import { formatChronologyAnchor, projectRecallSource, readRecallSource } from '../src/v3/recall-source.js';
import { buildRecallCseCandidatePool, buildRecallHistoryCandidatePool, buildRecallQueryContext, cseSelectionContext, estimateRecallTokens, formatRecallInjection, historySelectionContext, recallBudget, selectRecall } from '../src/v3/recall-selector.js';
import { selectRecallWithLlm } from '../src/v3/recall-llm-selector.js';
import { createV3RecallRuntime, projectHistoricalRecallReceipt, RECALL_PROMPT_SLOT, RECALL_RECEIPT_KEY, RECALL_RECEIPT_SCHEMA_VERSION } from '../src/v3/recall-runtime.js';
import { PREQUEL_PROMPT_SLOT } from '../src/v3/recall-prequel.js';
import { sha256 } from '../src/identity.js';
import { assessMemoryCoverageFromHost } from '../src/v3/memory-coverage.js';
import { scanAssistantCandidates } from '../src/v3/foundation-domain.js';
import { createExtractorEnvelope, normalizeExtractorResponse } from '../src/v3/extractor.js';
import { rankRecallDocuments, tokenizeRecallText } from '../src/v3/recall-ranking.js';
import { projectInlineRecallReceipt } from '../src/ui/inline-projection.js';
import { createCompactApiClient } from '../src/compact-api-client.js';
import { createTaskRouter } from '../src/api-routing.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FLOOR1 = '11111111-1111-4111-8111-111111111111';
const FLOOR2 = '22222222-2222-4222-8222-222222222222';
const MEMORY1 = '33333333-3333-4333-8333-333333333333';
const DELTA1 = '44444444-4444-4444-8444-444444444444';
const BASELINE = '55555555-5555-4555-8555-555555555555';
const PERSON = '66666666-6666-4666-8666-666666666666';
const ITEM = '77777777-7777-4777-8777-777777777777';
const NOW = '2026-09-03T00:00:00.000Z';
const TEST_PLUGIN_VERSION = '0.1.8-test';
const fingerprintText = async value => `sha256:${await sha256(String(value ?? ''))}`;

const receiptFingerprint = async receipt => fingerprintText(JSON.stringify([
  receipt.schemaVersion, receipt.pluginVersion, receipt.chatId, receipt.narrativeGeneration,
  receipt.headCheckpointId, receipt.rootRevision,
  receipt.userMessageIndex, receipt.userContentFingerprint, receipt.queryFingerprint, receipt.generationType,
  receipt.selectedFloors, receipt.selectedStates, receipt.coverage, receipt.injectionText, receipt.stages, receipt.skipReasons, receipt.completionStatus, receipt.createdAt,
  ...(receipt.schemaVersion >= 8 ? [receipt.bodyMatchFingerprint] : []),
  ...(receipt.schemaVersion >= 9 ? [receipt.strategyVersion] : []),
  ...(receipt.schemaVersion >= 10 ? [receipt.selectedCseChanges, receipt.selectorDiagnostic, receipt.timings] : []),
  ...(receipt.schemaVersion >= 12 ? [receipt.storylines] : []),
  ...(receipt.schemaVersion >= 13 ? [receipt.stateProgressions] : []),
]));

const emptyMemory = {
  participants: [], locations: [], commitments: [], openLoops: [], exactAnchors: [], eventFragments: [], actions: [], observations: [], privateCognition: [], informationTransfers: [],
};

function reachable({ head = '88888888-8888-4888-8888-888888888888', revision = 4 } = {}) {
  const stateItem = { id: ITEM, text: '始终记得雨夜承诺', visibility: 'private', reason: '亲口答应', origin: 'floor', towardEntityId: null, sourceFloorId: FLOOR1, sourceDeltaId: DELTA1 };
  return {
    status: 'ready', rootRevision: revision,
    root: { chatId: CHAT, narrativeGeneration: GEN, headCheckpointId: head }, checkpoint: { id: head }, baseline: { id: BASELINE },
    floors: [{ id: FLOOR1, assistantSeq: 1 }, { id: FLOOR2, assistantSeq: 2 }],
    floorMemories: [{ id: MEMORY1, floorId: FLOOR1, recordStatus: 'active', summary: { effectiveSource: 'ai', aiText: '雨夜里约定下次在钟楼见。' }, ...emptyMemory }],
    entities: [{ id: PERSON, entityType: 'person', displayName: '裴晚生', aliases: [{ name: '阿裴' }], specialRole: 'char', recordStatus: 'active', status: 'established' }],
    stateDeltas: [{ id: DELTA1, floorId: FLOOR1, floorMemoryId: MEMORY1, recordStatus: 'active', subjectSnapshots: [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: [stateItem] }], fixedChanges: [{ subjectEntityId: PERSON, items: [{ category: 'situational', action: 'add', before: null, after: stateItem }] }] }],
    currentStates: [{ subjects: [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: [{ ...stateItem, text: '不可信的存储幽灵状态' }] }] }],
  };
}

const sourceAttempts = exitPoint => ({ reachableReads: 1, exitPoint });

test('fresh recall source 将合并双方历史、主体与 toward 投影到保留人物，并只按同 ID 去重', async () => {
  const target = '99999999-9999-4999-8999-999999999999';
  const value = reachable();
  value.entities.push({ ...value.entities[0], id: target, displayName: '裴今生', aliases: [] });
  value.floorMemories[0].participants = [{ entityId: PERSON }, { entityId: target }];
  value.floorMemories[0].actions = [{ actorEntityId: PERSON, targetEntityIds: [PERSON, target], action: '并肩守门', completion: 'completed', result: '' }];
  value.stateDeltas[0].subjectSnapshots.push({ subjectEntityId: target, core: [], adaptive: [{ ...value.stateDeltas[0].subjectSnapshots[0].situational[0], id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', text: '记得旧称', towardEntityId: PERSON }], situational: [] });
  const projection = { identityRedirectsByEntityId: { [PERSON]: target }, deletedEntityIds: [] };
  const result = await projectRecallSource(value, () => new Date(NOW), sourceAttempts('ready'), null, {}, false, projection);
  assert.deepEqual(result.entities.map(item => item.entityId), [target]);
  assert.deepEqual(result.entities[0].aliases, ['裴晚生', '阿裴']);
  assert.deepEqual(result.floorMemories[0].participants.map(item => item.entityId), [target]);
  assert.deepEqual(result.floorMemories[0].actions[0].targetEntityIds, [target]);
  assert.deepEqual(result.currentState.map(item => item.subjectEntityId), [target]);
  assert.equal(result.currentState[0].adaptive[0].towardEntityId, target);
  assert.equal(result.cseChanges.every(item => item.subjectEntityId === target && (!item.after?.towardEntityId || item.after.towardEntityId === target)), true);
});

test('recall source 只输出 reachable 窄 DTO，局部重放而不信任 stored CurrentState', async () => {
  const value = reachable();
  const store = { readReachable: async () => structuredClone(value) };
  const result = await readRecallSource({ store, now: () => new Date(NOW) });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.coverage, { stableAiFloors: 2, stableThroughAssistantSeq: 2, rememberedAiFloors: 1, missingAssistantSeq: [2], cseThroughAssistantSeq: 1, memoryComplete: false, cseCurrent: true });
  assert.equal(result.currentState[0].situational[0].text, '始终记得雨夜承诺');
  assert.deepEqual({
    stateId: result.currentState[0].situational[0].stateId,
    sourceFloorId: result.currentState[0].situational[0].sourceFloorId,
    sourceDeltaId: result.currentState[0].situational[0].sourceDeltaId,
  }, { stateId: ITEM, sourceFloorId: FLOOR1, sourceDeltaId: DELTA1 });
  assert.deepEqual({
    stateId: result.cseChanges[0].after.stateId,
    sourceFloorId: result.cseChanges[0].after.sourceFloorId,
    sourceDeltaId: result.cseChanges[0].after.sourceDeltaId,
  }, { stateId: ITEM, sourceFloorId: FLOOR1, sourceDeltaId: DELTA1 });
  assert.equal(JSON.stringify(result).includes('不可信的存储幽灵状态'), false);
  assert.deepEqual(result.sourceReadAttempts, sourceAttempts('ready'));
  for (const forbidden of ['baseline', 'canonicalContent', 'diagnostics', 'stateDeltas', 'currentStates']) assert.equal(Object.hasOwn(result, forbidden), false, forbidden);
});

test('recall source stale/unavailable/disabled 与缺 root/checkpoint 单次读取后 fail-open', async () => {
  for (const [status, malformed, expectedStatus, exitPoint] of [['stale', false, 'stale', 'stale'], ['unavailable', false, 'unavailable', 'unavailable'], ['disabled', false, 'unavailable', 'unavailable'], ['ready', true, 'unavailable', 'unavailable']]) {
    let reads = 0, rootReads = 0;
    const result = await readRecallSource({
      store: {
        readReachable: async () => { reads += 1; return malformed ? { status: 'ready', root: reachable().root } : { status }; },
        readRoot: async () => { rootReads += 1; throw new Error('单快照读取不应调用 readRoot'); },
      },
      now: () => new Date(NOW),
    });
    assert.equal(result.status, expectedStatus);
    assert.deepEqual(result.sourceReadAttempts, sourceAttempts(exitPoint));
    assert.equal(reads, 1);
    assert.equal(rootReads, 0);
  }
});

test('recall source ready/needsReseal 都只消费一份 reachable，不读取独立 root seal', async () => {
  for (const status of ['ready', 'needsReseal']) {
    let reads = 0, rootReads = 0;
    const value = { ...reachable(), status };
    const result = await readRecallSource({
      store: {
        readReachable: async () => { reads += 1; return structuredClone(value); },
        readRoot: async () => { rootReads += 1; throw new Error('不应调用 readRoot'); },
      },
      now: () => new Date(NOW),
    });
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.sourceReadAttempts, sourceAttempts('ready'));
    assert.equal(reads, 1);
    assert.equal(rootReads, 0);
  }
});

test('recall source 不暴露 staged、superseded、孤儿或旧分支 FloorMemory', async () => {
  const value = reachable();
  value.floorMemories.push(
    { ...structuredClone(value.floorMemories[0]), id: 'aaaa1111-1111-4111-8111-111111111111', recordStatus: 'superseded', summary: { effectiveSource: 'ai', aiText: '旧 swipe' } },
    { ...structuredClone(value.floorMemories[0]), id: 'aaaa2222-2222-4222-8222-222222222222', floorId: FLOOR2, recordStatus: 'staged', summary: { effectiveSource: 'ai', aiText: '未提交 staged' } },
    { ...structuredClone(value.floorMemories[0]), id: 'aaaa3333-3333-4333-8333-333333333333', floorId: 'aaaa4444-4444-4444-8444-444444444444', recordStatus: 'active', summary: { effectiveSource: 'ai', aiText: '孤儿旧分支' } },
  );
  const result = await readRecallSource({ store: { readReachable: async () => structuredClone(value) }, now: () => new Date(NOW) });
  assert.equal(result.floorMemories.length, 1);
  assert.equal(result.floorMemories[0].summary, '雨夜里约定下次在钟楼见。');
  assert.doesNotMatch(JSON.stringify(result), /旧 swipe|未提交 staged|孤儿旧分支/);
});

test('recall source 永久投影已保存时间，正文变化、无宿主快照、人工与 legacy 均保留', async () => {
  const chat = [
    { is_user: false, is_system: false, mes: '第一楼原始正文' },
    { is_user: false, is_system: false, mes: '第二楼原始正文' },
  ];
  const candidates = await scanAssistantCandidates(chat);
  const value = reachable();
  value.floors = value.floors.map((floor, index) => ({ ...floor, hostLocator: candidates[index].hostLocator, content: { rawFingerprint: candidates[index].rawFingerprint, canonicalFingerprint: candidates[index].canonicalFingerprint } }));
  value.floorMemories[0].chronology = [{ itemId: ITEM, time: { kind: 'relative', sourceText: '次日清晨', normalized: null, precision: 'unresolved', relativeToFloorId: FLOOR2 }, description: '次日清晨', evidenceRefs: [] }];
  value.run = { diagnostics: { floorProvenance: { [FLOOR1]: { rawFingerprint: candidates[0].rawFingerprint, timeEdited: false } } } };
  const snapshot = { context: { chatMetadata: { qianqianjie: { chatId: CHAT } } }, chat };
  const read = hostSnapshot => readRecallSource({ store: { readReachable: async () => structuredClone(value) }, hostSnapshot, now: () => new Date(NOW) });

  let result = await read(snapshot);
  assert.equal(result.floorMemories[0].chronology.length, 1);
  assert.equal(result.floorMemories[0].chronology[0].time.relativeToAssistantSeq, 2);
  assert.equal(Object.hasOwn(result.floorMemories[0].chronology[0].time, 'relativeToFloorId'), false);

  const changed = structuredClone(snapshot); changed.chat[0].mes = '第一楼时间戳已变化';
  result = await read(changed);
  assert.equal(result.floorMemories[0].chronology.length, 1, '正文变化不得撤销已保存时间');
  result = await read(null);
  assert.equal(result.floorMemories[0].chronology.length, 1, '没有宿主快照也应保留已保存时间');

  value.run.diagnostics.floorProvenance[FLOOR1].timeEdited = true;
  result = await read(changed);
  assert.equal(result.floorMemories[0].chronology.length, 1, '人工时间优先于自动原文失配');
  delete value.run.diagnostics.floorProvenance[FLOOR1].timeEdited;
  delete value.run.diagnostics.floorProvenance[FLOOR1].rawFingerprint;
  result = await read(changed);
  assert.equal(result.floorMemories[0].chronology.length, 1, '旧档无 provenance raw 时保留既有时间');
});

test('共享时间 formatter 保留明确、相对、顺序、未知与不确定性，不推算年份或暴露 floorId', () => {
  const chronology = [
    { time: { kind: 'explicit', sourceText: '五月三日傍晚', normalized: null, precision: 'approximate', relativeToAssistantSeq: null }, description: '' },
    { time: { kind: 'relative', sourceText: '三小时后', normalized: null, precision: 'unresolved', relativeToAssistantSeq: 7 }, description: '' },
    { time: { kind: 'sequenceOnly', sourceText: '在会面之后', normalized: null, precision: 'unresolved', relativeToAssistantSeq: null }, description: '' },
    { time: { kind: 'unknown', sourceText: null, normalized: null, precision: 'unresolved', relativeToAssistantSeq: null }, description: '具体时间不明' },
  ];
  const text = formatChronologyAnchor(chronology);
  assert.match(text, /明确时间（约略）：五月三日傍晚/);
  assert.match(text, /相对时间（未解析；相对 AI #7）：三小时后/);
  assert.match(text, /先后顺序（未解析）：在会面之后/);
  assert.match(text, /时间未知（未解析）：具体时间不明/);
  assert.doesNotMatch(text, /20\d\d|floor-/);
  assert.equal(formatChronologyAnchor([]), '');
});

test('recall source 的 CSE 重放损坏时逐级退化，仍保留可用 FloorMemory 且不输出动态状态', async () => {
  const value = reachable();
  value.stateDeltas[0].subjectSnapshots[0].subjectEntityId = 'not-a-valid-entity-id';
  const result = await readRecallSource({ store: { readReachable: async () => structuredClone(value) }, now: () => new Date(NOW) });
  assert.equal(result.status, 'ready');
  assert.equal(result.floorMemories.length, 1);
  assert.deepEqual(result.currentState, []);
  assert.equal(result.coverage.cseCurrent, false);
  assert.deepEqual(result.degradedReasons, ['cseReplayUnavailable']);
});

const recallMemory = (assistantSeq, patch = {}) => ({
  floorId: `floor-${assistantSeq}`, floorMemoryId: `memory-${assistantSeq}`, assistantSeq, summary: Object.hasOwn(patch, 'summary') ? patch.summary : '',
  chronology: patch.chronology ?? [],
  participants: patch.participants ?? [], locations: patch.locations ?? [], commitments: patch.commitments ?? [], openLoops: patch.openLoops ?? [], exactAnchors: patch.exactAnchors ?? [], events: patch.events ?? [], actions: patch.actions ?? [], observations: patch.observations ?? [], privateCognition: patch.privateCognition ?? [], informationTransfers: patch.informationTransfers ?? [],
});

test('选中旧事才附带本楼时间，不参与候选匹配且计入最终字符预算', () => {
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  memories[1] = recallMemory(2, {
    chronology: [{ time: { kind: 'explicit', sourceText: '冬至夜约十一点', normalized: null, precision: 'approximate', relativeToAssistantSeq: null }, description: '' }],
    events: [{ title: '交付钥匙', description: '裴晚生把钟楼钥匙交给用户。', candidateStatus: 'accepted' }],
  });
  const withoutTimeQuery = selectRecall({ source: selectorSource({ memories }), queryContext: { text: '冬至夜十一点', latestUserText: '冬至夜十一点', messageCount: 1 }, contextSize: 1800 });
  assert.equal(withoutTimeQuery.status, 'empty', '时间文本不能单独把无事实命中的楼选入召回');
  const result = selectRecall({ source: selectorSource({ memories }), queryContext: { text: '钟楼钥匙', latestUserText: '钟楼钥匙', messageCount: 1 }, contextSize: 1800 });
  assert.match(result.injectionText, /AI #2（明确时间（约略）：冬至夜约十一点）/);
  assert.equal(result.limits.actualCharacters, result.injectionText.length);
  assert.ok(result.injectionText.length <= result.limits.maxCharacters);
});

function selectorSource({ complete = true, memories = null, currentState = null } = {}) {
  const floorMemories = memories ?? Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  const stableThroughAssistantSeq = floorMemories.at(-1)?.assistantSeq ?? 0;
  return {
    status: 'ready', chatId: CHAT, narrativeGeneration: GEN, headCheckpointId: 'head', rootRevision: 1,
    coverage: { stableAiFloors: floorMemories.length, stableThroughAssistantSeq, rememberedAiFloors: complete ? floorMemories.length : Math.max(0, floorMemories.length - 2), missingAssistantSeq: complete ? [] : [Math.max(1, stableThroughAssistantSeq - 1), stableThroughAssistantSeq], cseThroughAssistantSeq: complete ? stableThroughAssistantSeq : Math.max(0, stableThroughAssistantSeq - 2), memoryComplete: complete, cseCurrent: complete },
    entities: [
      { entityId: PERSON, entityType: 'person', displayName: '裴晚生', aliases: ['阿裴'], specialRole: 'char' },
      { entityId: '88888888-7777-4777-8777-777777777777', entityType: 'person', displayName: '林岚', aliases: ['小岚'], specialRole: 'user' },
      { entityId: '99999999-7777-4777-8777-777777777777', entityType: 'person', displayName: '乙', aliases: [], specialRole: 'none' },
    ],
    floorMemories,
    currentState: currentState ?? [],
  };
}

test('32 楼睡觉续写在 LLM 无明确排除时保留近期摘要与相关远期材料', async () => {
  const recent = ['准备周末出门旅行', '确认次日复诊预约', '工作冲突需要协调', '临睡前决定清晨出发'];
  const memories = Array.from({ length: 32 }, (_, index) => recallMemory(index + 1, {
    summary: index >= 28 ? recent[index - 28] : `第 ${index + 1} 楼远期摘要`,
    events: index === 3 ? [{ title: '旧日睡眠', description: '很久以前说过我先睡了，却因雷声失眠', candidateStatus: 'accepted' }] : [],
  }));
  const stateItems = Array.from({ length: 15 }, (_, index) => ({ text: `无关状态 ${index + 1}`, visibility: 'authorial', reason: '旧状态', origin: 'baseline', towardEntityId: null, sourceAssistantSeq: 32 }));
  const source = selectorSource({ memories, currentState: [{ subjectEntityId: PERSON, core: stateItems, adaptive: [], situational: [] }] });
  source.coverage = { ...source.coverage, stableAiFloors: 32, stableThroughAssistantSeq: 32, rememberedAiFloors: 32, cseThroughAssistantSeq: 32 };
  let calls = 0;
  const result = await selectRecallWithLlm({
    source,
    queryContext: { text: '我先睡了，明早继续', latestUserText: '我先睡了，明早继续', recentAssistantText: '', previousUserText: '', messageCount: 1 },
    generateUtilityTask: async () => { calls += 1; return { jsonData: { history_exclude_keys: [], state_exclude_keys: [] } }; },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.floors.map(value => value.assistantSeq), [4, 29, 30, 31, 32]);
  recent.forEach(summary => assert.match(result.injectionText, new RegExp(summary)));
  assert.equal(result.stages.recentSummaryCount, 4);
  assert.equal(result.stages.distantHistoryItemCount, 2);
  assert.ok(result.states.length <= result.limits.stateItemTarget);
  assert.match(result.injectionText, /\[剧情线 recent｜近期剧情接续\]/);
  assert.match(result.injectionText, /雷声失眠/);
});

test('近期摘要先排除空摘要与正文覆盖，再向更老的已存摘要补足4条', () => {
  const memories = Array.from({ length: 12 }, (_, index) => recallMemory(index + 1, { summary: `楼位摘要 ${index + 1}` }));
  memories[9] = recallMemory(10, { summary: '' });
  memories.splice(10, 1);
  const source = selectorSource({ memories });
  source.coverage = { ...source.coverage, stableAiFloors: 12, stableThroughAssistantSeq: 12, rememberedAiFloors: 11, missingAssistantSeq: [11], cseThroughAssistantSeq: 10, memoryComplete: false, cseCurrent: false };
  source.bodyMatch = { coveredFloorIds: ['floor-9'] };
  const result = selectRecall({ source, queryContext: { text: '完全不命中远期', latestUserText: '完全不命中远期', messageCount: 1 }, selectedHistoryCandidates: [] });
  assert.deepEqual(result.floors.map(value => value.assistantSeq), [6, 7, 8, 12]);
  assert.equal(result.stages.recentSummaryCount, 4);
  assert.doesNotMatch(result.injectionText, /楼位摘要 9|楼位摘要 10/);

  source.bodyMatch = { coveredFloorIds: ['floor-9', 'floor-12'] };
  const allUnavailable = selectRecall({ source, queryContext: { text: '完全不命中远期', latestUserText: '完全不命中远期', messageCount: 1 }, selectedHistoryCandidates: [] });
  assert.equal(allUnavailable.stages.recentSummaryCount, 4);
  assert.deepEqual(allUnavailable.floors.map(value => value.assistantSeq), [5, 6, 7, 8]);
});

test('真实摘要长度与小上下文下优先保最近楼，LLM 所见近期接续和最终注入一致', async () => {
  const memories = Array.from({ length: 32 }, (_, index) => recallMemory(index + 1, {
    summary: index >= 28 ? `近期${index + 1}：${String(index + 1).repeat(180)}` : '',
    events: index === 2 ? [{ title: '远期雨夜', description: '雨夜雨夜远期原因', candidateStatus: 'accepted' }] : [],
  }));
  const source = selectorSource({ memories });
  source.coverage = { ...source.coverage, stableAiFloors: 32, stableThroughAssistantSeq: 32, rememberedAiFloors: 32, cseThroughAssistantSeq: 32 };
  let payload;
  const result = await selectRecallWithLlm({ source, contextSize: 1000, queryContext: { text: '雨夜', latestUserText: '雨夜', messageCount: 1 }, generateUtilityTask: async options => {
    payload = JSON.parse(options.taskMessages[0].content);
    return { jsonData: { history_exclude_keys: [], state_exclude_keys: [] } };
  } });
  const finalRecent = result.floors.flatMap(floor => floor.items.filter(item => item.recallSection === 'recent').map(item => ({ assistantSeq: floor.assistantSeq, time: formatChronologyAnchor(floor.chronology) || null, summary: item.text, truncated: item.truncated })))
    .map((value, index) => ({ key:`P${index + 1}`, ...value }));
  assert.deepEqual(payload.alreadyProvided.recentContinuation, finalRecent);
  assert.deepEqual(finalRecent.map(value => value.assistantSeq), [32]);
  assert.equal(result.limits.maxCharacters, 800, '小上下文仍按既有动态预算收紧，不被16k上限撑大');
  assert.ok(result.injectionText.length <= result.limits.maxCharacters);
  assert.ok(result.stages.recentSummaryDroppedByBudget >= 1);
});

test('近期摘要混合长度时直接按总预算从最新楼向前选择，不让较老短摘要挤掉最新长摘要', () => {
  const summaries = [`较老一：${'甲'.repeat(72)}`, `较老二：${'乙'.repeat(72)}`, `较老三：${'丙'.repeat(72)}`, `最新楼：${'丁'.repeat(342)}`];
  const memories = summaries.map((summary, index) => recallMemory(index + 1, { summary }));
  const source = selectorSource({ memories });
  const result = selectRecall({ source, contextSize: 1000, queryContext: { text: '继续', latestUserText: '继续', messageCount: 1 }, selectedHistoryCandidates: [] });
  assert.equal(result.floors.some(floor => floor.assistantSeq === 4), true, '最新长摘要单独可进总预算时必须保留');
  assert.ok(result.injectionText.length <= result.limits.maxCharacters);
  assert.deepEqual(result.floors.map(floor => floor.assistantSeq), [...result.floors.map(floor => floor.assistantSeq)].sort((a, b) => a - b), '选定后仍按剧情时间呈现');
});

test('统一预算按少量剧情线裁剪节点，并继续遵守历史与人物材料安全上限', () => {
  const memories = Array.from({ length: 12 }, (_, index) => recallMemory(index + 1, { summary: index >= 8 ? `近期接续 ${index + 1}` : '' }));
  memories[1] = recallMemory(2, { events: Array.from({ length: 30 }, (_, index) => ({ title: `钥匙背景 ${index + 1}`, description: `钥匙因果链 ${index + 1}`, candidateStatus: 'accepted' })) });
  const states = Array.from({ length: 12 }, (_, index) => ({ text: `钥匙状态 ${index + 1}`, visibility: 'authorial', reason: '人物档案', origin: 'baseline', towardEntityId: null, sourceAssistantSeq: 12 }));
  const source = selectorSource({ memories, currentState: [{ subjectEntityId: PERSON, core: states, adaptive: [], situational: [] }] });
  source.coverage = { ...source.coverage, stableAiFloors: 12, stableThroughAssistantSeq: 12, rememberedAiFloors: 12, cseThroughAssistantSeq: 12 };
  const queryContext = { text: '钥匙因果链', latestUserText: '钥匙因果链', messageCount: 1 };
  const pool = buildRecallHistoryCandidatePool({ source, queryContext });
  const result = selectRecall({ source, queryContext, contextSize: 12000, selectedHistoryCandidates: pool.candidates });
  assert.equal(result.stages.recentSummaryCount, 4);
  assert.equal(result.stages.distantHistoryItemCount, 8, '同一剧情线最多保留八个代表节点');
  assert.equal(result.states.length, 12);
  assert.equal(result.floors.reduce((sum, floor) => sum + floor.items.length, 0), 12);
  assert.ok(result.storylines.length <= 4);
  assert.ok(result.limits.estimatedTokenCount <= result.limits.estimatedTokenBudget);
  assert.equal(result.limits.stateItemTarget, 24);
});

test('最终召回可跨越旧8楼/18项上限，同时保持48楼/48历史/24人物安全上限', () => {
  const memories = Array.from({ length: 16 }, (_, index) => recallMemory(index + 1, {
    summary: index >= 12 ? `容量钥匙近期接续 ${index + 1}` : '',
    events: index < 8 ? Array.from({ length: 3 }, (_, item) => ({
      title: `容量钥匙旧事 ${index + 1}-${item + 1}`,
      description: `容量钥匙因果证据 ${index + 1}-${item + 1}`,
      candidateStatus: 'accepted',
    })) : [],
  }));
  const states = Array.from({ length: 10 }, (_, index) => ({
    text: `容量钥匙人物状态 ${index + 1}`, visibility: 'authorial', reason: '人物档案', origin: 'baseline', towardEntityId: null, sourceAssistantSeq: 16,
  }));
  const source = selectorSource({ memories, currentState: [{ subjectEntityId: PERSON, core: states, adaptive: [], situational: [] }] });
  const queryContext = { text: '容量钥匙', latestUserText: '容量钥匙', messageCount: 1 };
  const pool = buildRecallHistoryCandidatePool({ source, queryContext });
  const byFloor = new Map();
  for (const candidate of pool.candidates.filter(value => value.value.kind === 'event' && value.value.assistantSeq <= 8)) {
    const values = byFloor.get(candidate.value.assistantSeq) ?? [];
    values.push(candidate); byFloor.set(candidate.value.assistantSeq, values);
  }
  const selectedHistoryCandidates = [
    ...Array.from({ length: 8 }, (_, index) => byFloor.get(index + 1)?.[0]),
    ...Array.from({ length: 6 }, (_, index) => byFloor.get(index + 1)?.[1]),
  ].filter(Boolean);
  assert.equal(selectedHistoryCandidates.length, 14, 'fixture必须提供14条跨8个远期楼的真实候选');
  const result = selectRecall({ source, queryContext, contextSize: 50000, selectedHistoryCandidates });
  const historyCount = result.floors.reduce((sum, floor) => sum + floor.items.length, 0);
  assert.ok(result.floors.length <= 12);
  assert.ok(historyCount <= 18);
  assert.ok(result.states.length <= 10);
  assert.ok(historyCount + result.states.length <= 28);
  assert.ok(result.floors.some(value => value.assistantSeq === 1), '长线必须保留最早端点');
  assert.ok(result.floors.some(value => value.assistantSeq === 8), '长线必须保留最新远期端点');
  assert.equal(result.stages.recentSummaryCount, 4);
  assert.equal(result.limits.maxFloors, 48);
  assert.equal(result.limits.maxItems, 48);
  assert.equal(result.limits.ordinaryMaxCharacters, 16000);
  assert.equal(result.limits.maxCharacters, 20000);
  assert.equal(result.limits.stateItemTarget, 24);
  assert.equal(result.limits.historyItemTarget, 48);
});

test('生产 normalize → recall source/selector 保留行动主体对象、完成结果与私有/共享人物边界', async () => {
  const canonicalContent = '沈砚打开柜子，把地图交给顾舟。他心里担心追兵，又写信告诉顾舟北门可走，并答应顾舟守到天亮。';
  const floor = { id: FLOOR1, chatId: CHAT, narrativeGeneration: GEN, assistantSeq: 1, content: { canonicalContent } };
  const envelope = await createExtractorEnvelope({ batchId: 'aaaaaaaa-1111-4111-8111-111111111111', chatId: CHAT, narrativeGeneration: GEN, floor, userIdentity: { displayName: '林岚', aliases: ['林岚', '你'] } });
  const normalized = await normalizeExtractorResponse({
    response: {
      summary: '沈砚取出地图交给顾舟，并传递北门消息。',
      people: [{ name: '沈砚', presence: 'present' }, { name: '顾舟', presence: 'present' }],
      actions: [{ actor: '沈砚', target: '顾舟', action: '打开柜子', completion: 'completed', result: '取出地图' }],
      privateThoughts: [{ holder: '沈砚', thought: '担心追兵' }],
      informationTransfers: [{ from: '沈砚', recipient: '顾舟', claimText: '北门可走', channel: 'written' }],
      commitments: [{ issuer: '沈砚', recipient: '顾舟', content: '守到天亮' }],
    },
    envelope, floor, existingEntities: [], now: NOW, expectedScope: envelope.scope,
  });
  const reachableValue = {
    status: 'ready', rootRevision: 1,
    root: { chatId: CHAT, narrativeGeneration: GEN, headCheckpointId: 'candidate-head' }, checkpoint: { id: 'candidate-head' }, baseline: null,
    floors: [floor], floorMemories: [normalized.memory], entities: normalized.newEntities, stateDeltas: [], currentStates: [],
  };
  const projected = await readRecallSource({ store: { readReachable: async () => structuredClone(reachableValue) }, now: () => new Date(NOW) });
  const dto = projected.floorMemories[0];
  const entityByName = new Map(projected.entities.map(entity => [entity.displayName, entity.entityId]));
  assert.equal(dto.actions[0].actorEntityId, entityByName.get('沈砚'));
  assert.deepEqual(dto.actions[0].targetEntityIds, [entityByName.get('顾舟')]);
  assert.equal(dto.actions[0].completion, 'completed');
  assert.equal(dto.actions[0].result, '取出地图');
  assert.equal(dto.privateCognition[0].ownerEntityId, entityByName.get('沈砚'));
  assert.deepEqual(dto.informationTransfers[0].toEntityIds, [entityByName.get('顾舟')]);
  assert.deepEqual(dto.commitments[0].targetEntityIds, [entityByName.get('顾舟')]);

  const floorMemories = [dto, ...Array.from({ length: 7 }, (_, index) => recallMemory(index + 2, { summary: index >= 3 ? `近期接续 ${index + 2}` : '' }))];
  const source = {
    ...projected,
    coverage: { stableAiFloors: 8, stableThroughAssistantSeq: 8, rememberedAiFloors: 8, missingAssistantSeq: [], cseThroughAssistantSeq: 8, memoryComplete: true, cseCurrent: true },
    floorMemories, currentState: [],
  };
  const selected = selectRecall({ source, queryContext: { text: '沈砚打开柜子、担心追兵后，顾舟拿到的地图和北门消息是什么？', latestUserText: '沈砚打开柜子、担心追兵后，顾舟拿到的地图和北门消息是什么？', messageCount: 1 } });
  const items = selected.floors.flatMap(value => value.items);
  const action = items.find(value => value.kind === 'action');
  assert.equal(action.actorEntityId, entityByName.get('沈砚'));
  assert.deepEqual(action.targetEntityIds, [entityByName.get('顾舟')]);
  assert.equal(action.completion, 'completed');
  assert.ok(items.some(value => value.category === 'private' && value.ownerEntityId === entityByName.get('沈砚')));
  assert.ok(items.some(value => value.category === 'transfer' && value.toEntityIds.includes(entityByName.get('顾舟'))));
  assert.match(selected.injectionText, /主体：沈砚；对象：顾舟.*已完成：打开柜子；记录结果：取出地图/u);
  assert.match(selected.injectionText, /沈砚 → 顾舟.*北门可走/u);
});

test('query 按最近 assistant turn 划窗，包含其间 user/assistant；N=0 只退化到最后 user', () => {
  const coreChat = [
    { is_user: false, is_system: false, mes: '旧 AI' },
    { is_user: true, is_system: false, mes: '第一个问题' },
    { is_user: false, is_system: false, mes: '最近 AI 答复' },
    { is_user: true, is_system: false, mes: '现在去钟楼' },
    { is_user: true, is_system: true, mes: '系统文本不可进入' },
  ];
  const one = buildRecallQueryContext({ coreChat, assistantTurns: 1 });
  assert.match(one.text, /第一个问题.*最近 AI 答复.*现在去钟楼/s);
  assert.doesNotMatch(one.text, /旧 AI|系统文本/);
  const zero = buildRecallQueryContext({ coreChat, assistantTurns: 0 });
  assert.equal(zero.text, '用户:现在去钟楼');
  const continued = buildRecallQueryContext({ coreChat: [...coreChat, { is_user: false, is_system: false, mes: '正在续写的 AI 回复不得改变原 user 收据查询' }], assistantTurns: 1 });
  assert.equal(continued.text, one.text, 'continue/regenerate 的 user 楼之后 assistant 内容不得让查询漂移');
});

test('BM25 使用中文双字与英文数字词，并且不会把全库泛词的低 IDF 命中放大到满分', () => {
  assert.deepEqual(tokenizeRecallText('铁皮盒 Alpha_7 2048'), ['铁皮', '皮盒', 'alpha_7', '2048']);
  const ranked = rankRecallDocuments({
    documents: Array.from({ length: 12 }, (_, index) => ({ id: index, text: `大家现在继续讨论普通事项 ${index}` })),
    queries: [{ key: 'latestUser', text: '现在怎么办', weight: 1 }],
  });
  assert.ok(Math.max(...ranked.map(value => value.branchScores.latestUser)) < 0.2, '全库共有的“现在”只能保留低 IDF 分数，不能归一成 1');
});

test('selector 独立归一最新 user / 最近 AI / 上一 user，当前话题权重大于相反背景', () => {
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  memories[0] = recallMemory(1, { events: [{ title: '铁皮盒', description: '铁皮饼干盒仍放在桌上', candidateStatus: 'accepted' }] });
  memories[1] = recallMemory(2, { events: [{ title: '雨伞', description: '蓝雨伞仍靠在门边', candidateStatus: 'accepted' }] });
  const result = selectRecall({
    source: selectorSource({ memories }),
    queryContext: { text: '旧话题雨伞；现在说铁皮饼干盒', latestUserText: '铁皮饼干盒还在桌上吗', recentAssistantText: '蓝雨伞靠在门边', previousUserText: '继续说蓝雨伞', messageCount: 3 },
  });
  const items = result.floors.flatMap(floor => floor.items);
  const box = items.find(value => value.text.includes('铁皮饼干盒'));
  const umbrella = items.find(value => value.text.includes('蓝雨伞'));
  assert.ok(box && umbrella);
  assert.ok(box.rankScore > umbrella.rankScore, '0.7 的本轮用户分路应压过合计 0.3 的背景分路');
  assert.ok(box.rankBranches.latestUser > 0);
  assert.ok(umbrella.rankBranches.recentAssistant > 0);
});

test('人物名只辅助该条事实的结构化主体/对象，人物提问可召回其承诺', () => {
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  memories[0] = recallMemory(1, {
    participants: [{ entityId: PERSON, presence: 'present' }],
    commitments: [{ speakerEntityId: PERSON, targetEntityIds: [], kind: 'promise', content: '守到天亮', status: 'made', exactAnchorId: null }],
    events: [{ title: '无关旧事', description: '陌生人在集市买了花', candidateStatus: 'accepted' }],
  });
  const result = selectRecall({ source: selectorSource({ memories }), queryContext: { text: '阿裴当时答应了什么？', latestUserText: '阿裴当时答应了什么？', messageCount: 1 } });
  const items = result.floors.flatMap(floor => floor.items);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'commitment');
  assert.match(result.injectionText, /守到天亮/u);
  assert.ok(items[0].rankEntityBranches.latestUser > 0);
  assert.doesNotMatch(result.injectionText, /陌生人在集市买了花/u, '人物名不能给同楼或其他楼的无关事实资格');
});

test('通用第二人称别名不参与事实人物辅助，逗号后的普通提问不会误召回 user 旧承诺', () => {
  const user = '88888888-7777-4777-8777-777777777777';
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  memories[0] = recallMemory(1, {
    participants: [{ entityId: user, presence: 'present' }],
    commitments: [{ speakerEntityId: user, targetEntityIds: [], kind: 'promise', content: '守到天亮', status: 'made', exactAnchorId: null }],
  });
  const result = selectRecall({ source: selectorSource({ memories }), queryContext: { text: '你，接下来怎么办？', latestUserText: '你，接下来怎么办？', messageCount: 1 } });
  assert.equal(result.floors.length, 0);
  assert.doesNotMatch(result.injectionText, /守到天亮/u);
});

test('65 楼盒子回归：历史优先保住第 50 楼盒子事件，状态不反向挤占历史', () => {
  const memories = Array.from({ length: 65 }, (_, index) => recallMemory(index + 1, { summary: `第 ${index + 1} 楼反复谈论港口与天气` }));
  memories[49] = recallMemory(50, {
    summary: '裴晚生把铁皮饼干盒留在桌上，之后众人又谈到港口。',
    events: [{ title: '留下铁皮盒', description: '铁皮饼干盒仍放在桌上，像剪不断的毛线团', candidateStatus: 'accepted' }],
    locations: [{ name: '港口', change: 'present', entityId: null, participantEntityIds: [PERSON] }],
  });
  const currentState = [{
    subjectEntityId: PERSON,
    core: Array.from({ length: 17 }, (_, index) => ({ text: `人物稳定状态 ${index + 1}`, visibility: 'authorial', reason: 'CSE 档案', origin: 'baseline', towardEntityId: null, sourceAssistantSeq: 49 })),
    adaptive: [], situational: [],
  }];
  const source = selectorSource({ memories, currentState });
  source.coverage = { stableAiFloors: 65, stableThroughAssistantSeq: 65, rememberedAiFloors: 65, missingAssistantSeq: [], cseThroughAssistantSeq: 65, memoryComplete: true, cseCurrent: true };
  const result = selectRecall({
    source,
    queryContext: { text: '背景一直谈港口与天气；现在问桌上的铁皮饼干盒', latestUserText: '铁皮饼干盒还放在桌上吗', recentAssistantText: '港口天气反复变化，港口仍有风', previousUserText: '先前一直聊港口', messageCount: 3 },
    contextSize: 12000,
  });
  assert.ok(result.states.length <= result.limits.stateItemTarget, '状态始终受原三分之一硬上限约束');
  assert.ok(result.floors.flatMap(floor => floor.items).length > 0, '相关历史先于状态使用总预算');
  assert.match(result.injectionText, /\[来源 AI #50[^\n]*\][\s\S]*铁皮饼干盒仍放在桌上/u);
  assert.match(result.injectionText, /地点[:：]港口/u, '背景分路明确提及的地点仍可作为相关事实保留');
  assert.ok(result.injectionText.length <= result.limits.maxCharacters);
});

test('近期摘要作为连续叙事单元，不再重复注入同楼碎片', () => {
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  memories[1] = recallMemory(2, {
    summary: '铁皮饼干盒留在桌上，窗外同时下起大雨。',
    events: [{ title: '铁皮盒', description: '铁皮饼干盒留在桌上', candidateStatus: 'accepted' }],
    observations: [{ subjectEntityId: null, kind: 'weather', description: '窗外下起大雨' }],
  });
  const result = selectRecall({ source: selectorSource({ memories }), queryContext: { text: '铁皮饼干盒在哪里', latestUserText: '铁皮饼干盒在哪里', messageCount: 1 } });
  const items = result.floors.flatMap(floor => floor.items);
  assert.deepEqual(items.map(value => value.kind), ['summary']);
  assert.match(result.injectionText, /叙事回顾/);
  assert.match(result.injectionText, /窗外同时下起大雨/u);
});

test('远期摘要只与同楼同文事实去重，同文不同楼与空摘要边界保持独立', () => {
  const memories = Array.from({ length: 10 }, (_, index) => recallMemory(index + 1, { summary: index >= 6 ? `近期接续 ${index + 1}` : '' }));
  memories[0] = recallMemory(1, {
    summary: '蓝铜账本',
    events: [{ title: '蓝铜', description: '账本', candidateStatus: 'accepted' }],
  });
  memories[1] = recallMemory(2, { summary: '蓝铜账本' });
  memories[2] = recallMemory(3, { summary: '', events: [{ title: '蓝铜', description: '账本', candidateStatus: 'accepted' }] });
  const pool = buildRecallHistoryCandidatePool({
    source: selectorSource({ memories }),
    queryContext: { text: '蓝铜账本', latestUserText: '蓝铜账本', messageCount: 1 },
  });
  assert.equal(pool.candidates.some(candidate => candidate.value.floorId === 'floor-1' && candidate.value.kind === 'summary'), false, '同楼同文事实应覆盖摘要');
  assert.equal(pool.candidates.some(candidate => candidate.value.floorId === 'floor-2' && candidate.value.kind === 'summary'), true, '不同楼的同文事实不能误删摘要');
  assert.equal(pool.candidates.some(candidate => candidate.value.floorId === 'floor-3' && candidate.value.kind === 'summary'), false, '空摘要仍不产生候选');
});

test('历史与状态共享字符预算，人物材料受二十四项安全上限', () => {
  const memories = Array.from({ length: 10 }, (_, index) => recallMemory(index + 1, {
    events: [{ title: `钥匙事件 ${index + 1}`, description: `第 ${index + 1} 把钥匙开启石门`, candidateStatus: 'accepted' }],
  }));
  const currentState = [{
    subjectEntityId: PERSON,
    core: Array.from({ length: 16 }, (_, index) => ({ text: `钥匙相关状态 ${index + 1}`, visibility: 'authorial', reason: 'CSE', origin: 'baseline', towardEntityId: null, sourceAssistantSeq: 1 })),
    adaptive: [], situational: [],
  }];
  const source = selectorSource({ memories, currentState });
  source.coverage = { ...source.coverage, stableAiFloors: 10, stableThroughAssistantSeq: 10, rememberedAiFloors: 10, cseThroughAssistantSeq: 10 };
  const both = selectRecall({ source, queryContext: { text: '钥匙石门', latestUserText: '钥匙石门', messageCount: 1 }, contextSize: 12000 });
  const historyItems = both.floors.flatMap(floor => floor.items);
  assert.ok(historyItems.length > 0 && historyItems.length <= 24, '相关历史先于人物状态使用统一预算');
  for (const line of both.storylines.filter(value => value.storylineId !== 'recent')) {
    assert.ok(historyItems.filter(value => value.storylineId === line.storylineId).length <= 8, '每条线只留八个代表节点');
  }
  assert.equal(both.states.length, 16);

  const stateOnly = selectRecall({ source: selectorSource({ memories: Array.from({ length: 8 }, (_, index) => recallMemory(index + 1)), currentState }), queryContext: { text: '钥匙状态', latestUserText: '钥匙状态', messageCount: 1 }, contextSize: 12000 });
  assert.equal(stateOnly.floors.length, 0);
  assert.equal(stateOnly.states.length, 16, '没有历史匹配时人物材料可使用统一预算空额');
});

test('统一字符预算允许人物与历史互用空余且总上限仍生效', () => {
  const longState = `长状态${'仍需保留'.repeat(56)}`;
  const stateOnly = selectRecall({
    source: selectorSource({
      memories: Array.from({ length: 8 }, (_, index) => recallMemory(index + 1)),
      currentState: [{ subjectEntityId: PERSON, core: [{ text: longState, visibility: 'authorial', reason: 'CSE', origin: 'baseline', towardEntityId: null, sourceAssistantSeq: 1 }], adaptive: [], situational: [] }],
    }),
    queryContext: { text: '长状态', latestUserText: '长状态', messageCount: 1 }, contextSize: 1000,
  });
  assert.equal(stateOnly.states.length, 1, '人物材料可使用历史侧空余字符');
  assert.ok(stateOnly.injectionText.length <= stateOnly.limits.maxCharacters);

  const longHistory = `长旧事${'仍需召回'.repeat(130)}`;
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  memories[0] = recallMemory(1, { events: [{ title: '长旧事', description: longHistory, candidateStatus: 'accepted' }] });
  const historyOnly = selectRecall({ source: selectorSource({ memories }), queryContext: { text: '长旧事', latestUserText: '长旧事', messageCount: 1 }, contextSize: 1800 });
  assert.equal(historyOnly.floors.flatMap(floor => floor.items).length, 1);
  assert.ok(historyOnly.injectionText.length > historyOnly.limits.historyCharacterTarget, '历史应能借用未使用的状态字符份额');
  assert.ok(historyOnly.injectionText.length <= historyOnly.limits.maxCharacters);
});

test('未最终入选的同文状态不能提前删除旧事；同文不同主体、可见性或状态均保留', () => {
  const other = '99999999-7777-4777-8777-777777777777';
  const user = '88888888-7777-4777-8777-777777777777';
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  memories[0] = recallMemory(1, { privateCognition: [{ ownerEntityId: PERSON, kind: 'thought', content: '铁皮盒' }] });
  memories[1] = recallMemory(2, { privateCognition: [{ ownerEntityId: other, kind: 'thought', content: '共同秘密' }] });
  memories[2] = recallMemory(3, { observations: [{ subjectEntityId: PERSON, kind: 'seen', description: '共同秘密' }] });
  memories[3] = recallMemory(4, { commitments: [
    { speakerEntityId: PERSON, targetEntityIds: [user], kind: 'promise', content: '守住秘密', status: 'made', exactAnchorId: null },
    { speakerEntityId: PERSON, targetEntityIds: [user], kind: 'promise', content: '守住秘密', status: 'refused', exactAnchorId: null },
  ] });
  const currentState = [{ subjectEntityId: PERSON, core: [
    { text: '铁皮盒和红钥匙完整线索', visibility: 'private', reason: '高相关状态', origin: 'baseline', towardEntityId: null, sourceAssistantSeq: 1 },
    { text: '铁皮盒', visibility: 'private', reason: '较短状态', origin: 'baseline', towardEntityId: null, sourceAssistantSeq: 1 },
    { text: '共同秘密', visibility: 'private', reason: '人物边界', origin: 'baseline', towardEntityId: null, sourceAssistantSeq: 1 },
  ], adaptive: [], situational: [] }];
  const limited = selectRecall({ source: selectorSource({ memories, currentState }), queryContext: { text: '铁皮盒和红钥匙', latestUserText: '铁皮盒和红钥匙', messageCount: 1 }, maxItems: 2, contextSize: 12000 });
  assert.equal(limited.states.length, 2);
  assert.match(limited.injectionText, /\[来源 AI #1[^\n]*\][\s\S]*铁皮盒/u, '未入选的短状态不得压掉同文旧事');

  const boundaries = selectRecall({ source: selectorSource({ memories, currentState }), queryContext: { text: '共同秘密以及守住秘密', latestUserText: '共同秘密以及守住秘密', messageCount: 1 }, contextSize: 12000 });
  const items = boundaries.floors.flatMap(floor => floor.items);
  assert.ok(items.some(value => value.category === 'private' && value.ownerEntityId === other), '同文但主体不同应保留');
  assert.ok(items.some(value => value.kind === 'observation' && value.category === 'objective'), '同文但可见性不同应保留');
  assert.equal(items.filter(value => value.kind === 'commitment' && value.text.includes('守住秘密')).length, 2, '同文但状态不同应保留');
});

test('selector 命中人名/别名、中文地点、承诺、open loop 与 exact quote，并按可靠 core 覆盖去重', () => {
  const memories = Array.from({ length: 12 }, (_, index) => recallMemory(index + 1, { summary: index >= 8 ? `近期连续摘要 ${index + 1}` : '' }));
  memories[1] = recallMemory(2, {
    summary: '裴晚生在钟楼留下约定。', participants: [{ entityId: PERSON, presence: 'present' }],
    locations: [{ name: '钟楼', change: 'present', entityId: null, participantEntityIds: [PERSON] }],
    commitments: [{ speakerEntityId: PERSON, targetEntityIds: [], kind: 'codePhrase', content: '雨落三声后钟楼见', status: 'made', exactAnchorId: null }],
    openLoops: [{ description: '找到钟楼下的密门', ownerEntityIds: [PERSON] }],
  });
  memories[3] = recallMemory(4, { exactAnchors: [{ anchorId: 'anchor', kind: 'codePhrase', exactText: '雨落：三声', speakerEntityId: PERSON, whyPreserve: '暗号原句' }] });
  memories[6] = recallMemory(7, { summary: '近期钟楼内容不应重复召回', participants: [{ entityId: PERSON, presence: 'present' }] });
  const source = selectorSource({ memories });
  source.bodyMatch = { coveredFloorIds: ['floor-6', 'floor-7', 'floor-8'] };
  const queryContext = buildRecallQueryContext({ coreChat: [{ is_user: false, is_system: false, mes: '他们刚离开街口。' }, { is_user: true, is_system: false, mes: '阿裴，去钟楼说“雨落：三声”，别忘了密门和约定。' }] });
  const selected = selectRecall({ source, queryContext, contextSize: 12000 });
  assert.deepEqual(selected.floors.map(value => value.assistantSeq), [2, 4, 9, 10, 11, 12], '最终按 assistantSeq 排列而不是得分顺序');
  assert.equal(selected.floors.some(value => [6, 7, 8].includes(value.assistantSeq)), false, '只排除已可靠证明进入 core 的楼');
  assert.match(selected.injectionText, /裴晚生|阿裴|钟楼/);
  assert.match(selected.injectionText, /雨落三声后钟楼见/);
  assert.match(selected.injectionText, /来源楼当时未结\(后文可能已推进,以后文为准\):找到钟楼下的密门/);
  assert.match(selected.injectionText, /原句「雨落：三声」/, 'exactAnchor 保留原始全角标点形态');
  assert.deepEqual(selectRecall({ source, queryContext, contextSize: 12000 }), selected, '相同输入必须完全确定');
});

test('selector exactAnchor 继承最严格 typed fact 边界；孤立原句不默认公开', () => {
  const userId = '88888888-7777-4777-8777-777777777777';
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  memories[0] = recallMemory(1, {
    exactAnchors: [{ anchorId: 'private-anchor', kind: 'wording', exactText: '暗门后有人', speakerEntityId: PERSON, whyPreserve: '内心原句' }],
    privateCognition: [{ ownerEntityId: PERSON, kind: 'thought', content: '暗门后有人' }],
  });
  memories[1] = recallMemory(2, {
    exactAnchors: [{ anchorId: 'transfer-anchor', kind: 'wording', exactText: '月落前离开', speakerEntityId: PERSON, whyPreserve: '传话原句' }],
    informationTransfers: [{ fromEntityId: PERSON, toEntityIds: [userId], claimText: '月落前离开', channel: 'told' }],
  });
  memories[2] = recallMemory(3, {
    exactAnchors: [{ anchorId: 'commitment-anchor', kind: 'codePhrase', exactText: '雨落三声', speakerEntityId: PERSON, whyPreserve: '暗号精度' }],
    commitments: [{ speakerEntityId: PERSON, targetEntityIds: [userId], kind: 'codePhrase', content: '约定以三声雨响作为暗号', status: 'made', exactAnchorId: 'commitment-anchor' }],
  });
  memories[3] = recallMemory(4, {
    exactAnchors: [{ anchorId: 'speaker-anchor', kind: 'wording', exactText: '不要相信镜子', speakerEntityId: PERSON, whyPreserve: '孤立原句' }],
  });
  memories[4] = recallMemory(5, {
    exactAnchors: [{ anchorId: 'boundaryless-anchor', kind: 'wording', exactText: '无边界秘密', speakerEntityId: null, whyPreserve: '不能猜公开性' }],
  });
  const run = text => selectRecall({ source: selectorSource({ memories }), queryContext: { text, latestUserText: text, messageCount: 1 } });
  const privateResult = run('暗门后有人');
  assert.deepEqual(privateResult.floors.flatMap(floor => floor.items).map(value => value.category), ['private'], '内心同文原句只属于 owner-private');
  const transferResult = run('月落前离开');
  const transfer = transferResult.floors.flatMap(floor => floor.items)[0];
  assert.equal(transfer.category, 'transfer', '定向传话原句只继承 from→to 边界');
  assert.equal(transfer.fromEntityId, PERSON);
  assert.deepEqual(transfer.toEntityIds, [userId]);
  assert.match(transferResult.injectionText, /裴晚生 → 林岚（仅列明接收者知情，渠道：told）：原句「月落前离开」/);
  const commitmentResult = run('雨落三声暗号');
  const commitment = commitmentResult.floors.flatMap(floor => floor.items)[0];
  assert.equal(commitment.category, 'shared', '承诺原句继承合法接收者边界');
  assert.equal(commitment.status, 'made');
  assert.match(commitmentResult.injectionText, /来源楼当时已作出（不代表如今尚未履行；以后文为准）：约定以三声雨响作为暗号；原句「雨落三声」/);
  const isolatedResult = run('不要相信镜子，无边界秘密是什么？');
  assert.deepEqual(isolatedResult.floors.flatMap(floor => floor.items).map(value => value.category), ['private'], '只有 speaker 的孤立原句保守归 speaker-private');
  assert.equal(isolatedResult.floors.flatMap(floor => floor.items).some(value => value.kind === 'exactAnchor' && value.category === 'objective'), false);
  assert.match(isolatedResult.injectionText, /仅该人物可用的原句「不要相信镜子」/);
  assert.doesNotMatch(isolatedResult.injectionText, /无边界秘密/);
});

test('selector 无可靠命中不凑数；楼数、总项和字符上限均生效', () => {
  const empty = selectRecall({ source: selectorSource(), queryContext: { text: '完全无关的宇宙飞船', latestUserText: '宇宙飞船', messageCount: 1 } });
  assert.deepEqual(empty.floors, []);
  assert.equal(empty.status, 'empty');
  const memories = Array.from({ length: 15 }, (_, index) => recallMemory(index + 1, { summary: `钥匙线索 ${index + 1}`, openLoops: [{ description: `用钥匙打开第 ${index + 1} 道门`, ownerEntityIds: [] }] }));
  const source = selectorSource({ memories }); source.coverage = { ...source.coverage, stableAiFloors: 15, stableThroughAssistantSeq: 15, rememberedAiFloors: 15, cseThroughAssistantSeq: 15 };
  const result = selectRecall({ source, queryContext: { text: '用钥匙开门', latestUserText: '用钥匙开门', messageCount: 1 }, contextSize: 1800 });
  assert.ok(result.floors.length <= 48);
  assert.ok(result.floors.flatMap(value => value.items).length <= 48);
  assert.ok(result.states.length + result.cseChanges.length <= 24);
  assert.ok(result.injectionText.length <= result.limits.maxCharacters);
  assert.deepEqual(result.floors.map(value => value.assistantSeq), [...result.floors.map(value => value.assistantSeq)].sort((a, b) => a - b));
});

test('selector 重复内容由优先进入的旧事保留，后选状态不反向淘汰历史', () => {
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  memories[1] = recallMemory(2, { participants: [{ entityId: PERSON, presence: 'present' }], privateCognition: [{ ownerEntityId: PERSON, kind: 'thought', content: '冷静克制' }] });
  memories[2] = recallMemory(3, { participants: [{ entityId: PERSON, presence: 'present' }], privateCognition: [{ ownerEntityId: PERSON, kind: 'thought', content: '冷静克制' }] });
  const currentState = [{ subjectEntityId: PERSON, core: [{ text: '冷静克制', visibility: 'private', reason: '人设', origin: 'baseline', towardEntityId: null, sourceAssistantSeq: 1 }], adaptive: [], situational: [] }];
  const result = selectRecall({ source: selectorSource({ memories, currentState }), queryContext: { text: '阿裴是否仍然冷静克制', latestUserText: '阿裴是否仍然冷静克制', messageCount: 1 } });
  assert.equal(result.floors.length, 1);
  assert.match(result.injectionText, /冷静克制/);
  assert.equal(result.states.length, 0);
  assert.equal(result.stages.dropPersistent, 2);
  assert.ok(result.skipReasons.includes('persistentStateDuplicate'));
});

test('近期 summary 与 privateCognition 同文时以叙事回顾边界单次注入', () => {
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  const secret = '钟楼暗门密码是海棠';
  memories[1] = recallMemory(2, {
    summary: secret,
    participants: [{ entityId: PERSON, presence: 'present' }],
    privateCognition: [{ ownerEntityId: PERSON, kind: 'thought', content: secret }],
  });
  const result = selectRecall({ source: selectorSource({ memories }), queryContext: { text: '阿裴还记得钟楼暗门密码吗', latestUserText: '阿裴还记得钟楼暗门密码吗', messageCount: 1 } });
  assert.equal(result.floors.length, 1);
  assert.deepEqual(result.floors[0].items.map(value => value.category), ['narrative']);
  assert.match(result.injectionText, /叙事回顾可能含内心/);
  assert.equal(result.injectionText.split('叙事回顾可能含内心、计划或未完成事项').length - 1, 1);
  assert.equal(result.injectionText.split(secret).length - 1, 1);
});

test('selector summary-only 作为叙事回顾注入，并明确不代表所有人物知情', () => {
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  memories[1] = recallMemory(2, { summary: '钟楼暗门密码是海棠' });
  const result = selectRecall({ source: selectorSource({ memories }), queryContext: { text: '钟楼暗门密码是什么', latestUserText: '钟楼暗门密码是什么', messageCount: 1 } });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.floors[0].items.map(value => value.category), ['narrative']);
  assert.match(result.injectionText, /叙事回顾可能含内心、计划或未完成事项，不代表所有人物知情/);
  assert.match(result.injectionText, /\[叙事回顾\]/);
  assert.match(result.injectionText, /钟楼暗门密码是海棠/);
});

test('selector 为 action 所有 completion 枚举保留明确完成度，未完成不得写成完成', () => {
  const completions = ['intended', 'attempted', 'completed', 'interrupted', 'uncertain'];
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  completions.forEach((completion, index) => {
    memories[index] = recallMemory(index + 1, { actions: [{ actorEntityId: PERSON, targetEntityIds: [], action: `${completion} 密门机关`, completion, result: null }] });
  });
  for (let index = 9; index <= 12; index += 1) memories.push(recallMemory(index));
  const result = selectRecall({ source: selectorSource({ memories }), queryContext: { text: '密门机关发生了什么', latestUserText: '密门机关发生了什么', messageCount: 1 } });
  assert.match(result.injectionText, /意图（尚未行动）：intended 密门机关/);
  assert.match(result.injectionText, /尝试过（未确认完成）：attempted 密门机关/);
  assert.match(result.injectionText, /已完成：completed 密门机关/);
  assert.match(result.injectionText, /行动中断：interrupted 密门机关/);
  assert.match(result.injectionText, /是否完成不确定：uncertain 密门机关/);
});

test('selector 保留 commitment status；拒绝/不确定不冒充有效承诺，私下 plan 不进入共享桶', () => {
  const userId = '88888888-7777-4777-8777-777777777777';
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  const values = [
    { kind: 'promise', status: 'made', content: '暗号甲', targetEntityIds: [userId] },
    { kind: 'agreement', status: 'accepted', content: '暗号乙', targetEntityIds: [userId] },
    { kind: 'promise', status: 'refused', content: '暗号丙', targetEntityIds: [userId] },
    { kind: 'promise', status: 'uncertain', content: '暗号丁', targetEntityIds: [userId] },
    { kind: 'plan', status: 'made', content: '私下密门计划', targetEntityIds: [] },
  ];
  values.forEach((value, index) => { memories[index] = recallMemory(index + 1, { commitments: [{ speakerEntityId: PERSON, exactAnchorId: null, ...value }] }); });
  for (let index = 9; index <= 12; index += 1) memories.push(recallMemory(index));
  const check = (text, expectedCategory, expectedText) => {
    const result = selectRecall({ source: selectorSource({ memories }), queryContext: { text, latestUserText: text, messageCount: 1 } });
    const item = result.floors.flatMap(floor => floor.items).find(value => value.text.includes(text));
    assert.equal(item?.category, expectedCategory);
    assert.match(result.injectionText, expectedText);
  };
  check('暗号甲', 'shared', /来源楼当时已作出（不代表如今尚未履行；以后文为准）：暗号甲/);
  check('暗号乙', 'shared', /来源楼当时已接受并成立（不代表如今尚未履行；以后文为准）：暗号乙/);
  check('暗号丙', 'shared', /来源楼当时已拒绝（不构成承诺；以后文为准）：暗号丙/);
  check('暗号丁', 'private', /来源楼当时是否成立不确定（不得当作有效承诺；以后文为准）：暗号丁/);
  check('私下密门计划', 'private', /来源楼当时的计划（不代表已告知、已完成或如今仍有效；以后文为准）：私下密门计划/);
});

test('selector informationTransfer 明示 from/to 知情边界，甲只告诉乙不能写成当前丙知情', () => {
  const userId = '88888888-7777-4777-8777-777777777777';
  const otherId = '99999999-7777-4777-8777-777777777777';
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  memories[1] = recallMemory(2, { informationTransfers: [{ fromEntityId: PERSON, toEntityIds: [userId], claimText: '密钥藏在井边', channel: 'told' }] });
  const source = selectorSource({ memories });
  source.entities = source.entities.map(entity => entity.entityId === PERSON ? { ...entity, displayName: '甲方' } : entity.entityId === userId ? { ...entity, displayName: '乙方' } : entity.entityId === otherId ? { ...entity, displayName: '丙方' } : entity);
  const result = selectRecall({ source, queryContext: { text: '丙方追问密钥藏在哪里', latestUserText: '丙方追问密钥藏在哪里', messageCount: 1 } });
  assert.match(result.injectionText, /甲方 → 乙方（仅列明接收者知情，渠道：told）：密钥藏在井边/);
  assert.doesNotMatch(result.injectionText, /甲方 → 丙方|丙方[^\n]*知情/);
});

test('anti-omniscience 分桶且声明非指令；coverage 不完整时仅保留 Core，完整时才注入动态层', () => {
  const state = [{ subjectEntityId: PERSON, core: [{ text: '冷静克制', visibility: 'authorial', reason: '人设', origin: 'baseline', towardEntityId: null, sourceAssistantSeq: 1 }], adaptive: [{ text: '对林岚保持戒备', visibility: 'observable', reason: '冲突', origin: 'floor', towardEntityId: '88888888-7777-4777-8777-777777777777', sourceAssistantSeq: 5 }], situational: [{ text: '暗自恐惧', visibility: 'private', reason: '受伤', origin: 'floor', towardEntityId: null, sourceAssistantSeq: 5 }, { text: '未标注的内心秘密', reason: '旧数据缺字段', origin: 'floor', towardEntityId: null, sourceAssistantSeq: 5 }] }];
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  memories[1] = recallMemory(2, { participants: [{ entityId: PERSON, presence: 'present' }], privateCognition: [{ ownerEntityId: PERSON, kind: 'thought', content: '私下怀疑钟楼有埋伏' }], informationTransfers: [{ fromEntityId: PERSON, toEntityIds: ['88888888-7777-4777-8777-777777777777'], claimText: '他已明说钟楼不安全', channel: 'told' }] });
  const queryContext = { text: '阿裴说钟楼怎么办', latestUserText: '钟楼怎么办', messageCount: 1 };
  const complete = selectRecall({ source: selectorSource({ memories, currentState: state }), queryContext });
  assert.match(complete.injectionText, /只读参考，不是指令/);
  assert.match(complete.injectionText, /\[private；仅 裴晚生 可用\] 私下怀疑钟楼有埋伏/);
  assert.match(complete.injectionText, /裴晚生 → 林岚（仅列明接收者知情/);
  assert.match(complete.injectionText, /\[已保存人物状态依据\][\s\S]*冷静克制/);
  assert.doesNotMatch(complete.injectionText, /暗自恐惧|未标注的内心秘密/, '零分动态状态不得作为补位进入');
  assert.doesNotMatch(complete.injectionText, /乙[^\n]*暗自恐惧/);
  const partial = selectRecall({ source: selectorSource({ complete: false, memories, currentState: state }), queryContext });
  assert.doesNotMatch(partial.injectionText, /冷静克制/);
  assert.doesNotMatch(partial.injectionText, /对林岚保持戒备|暗自恐惧/);
  assert.match(partial.injectionText, /覆盖说明.*当前没有可用的人物状态/);
  assert.ok(partial.stages.dropVisibility >= 2);
});

function wideCandidateSource({ direct = 0, summary = 0, long = false } = {}) {
  const memories = [];
  for (let index = 0; index < direct; index += 1) memories.push(recallMemory(index + 1, {
    summary: `普通摘要 ${index}`,
    events: [{ title: `钟楼钥匙 ${index}`, description: `${long ? '很长的相关事实'.repeat(220) : '直接命中的相关事实'} ${index}`, candidateStatus: 'accepted' }],
  }));
  for (let index = 0; index < summary; index += 1) memories.push(recallMemory(direct + index + 1, {
    summary: `钟楼钥匙的关联摘要 ${index}`,
    events: [{ title: `海边旧物 ${index}`, description: `摘要补入但事实自身不含查询词 ${index}`, candidateStatus: 'accepted' }],
  }));
  while (memories.length < 40) memories.push(recallMemory(memories.length + 1));
  for (let index = 36; index < 40; index += 1) memories[index] = recallMemory(index + 1, { summary: `近期连续摘要 ${index + 1}` });
  const source = selectorSource({ memories });
  source.coverage = { ...source.coverage, stableAiFloors: memories.length, stableThroughAssistantSeq: memories.length, rememberedAiFloors: memories.length, cseThroughAssistantSeq: memories.length };
  return source;
}

const llmQuery = { text: '钟楼钥匙', latestUserText: '钟楼钥匙', recentAssistantText: '', previousUserText: '', messageCount: 1 };

test('共享与独立选择上下文保持候选和最终结果等价，同一上下文连续采用不同排除集合不互相污染', () => {
  const source = changingCseSource({ withHistory: true });
  const queryContext = { ...llmQuery, text: '左佐和辛夷的钟楼门锁', latestUserText: '左佐和辛夷的钟楼门锁' };
  const historyContext = historySelectionContext(source, queryContext);
  const cseContext = cseSelectionContext(source, queryContext);
  const historyBefore = structuredClone(historyContext);
  const cseBefore = structuredClone(cseContext);

  const unsharedHistory = buildRecallHistoryCandidatePool({ source, queryContext });
  const sharedHistory = buildRecallHistoryCandidatePool({ source, queryContext, historyContext });
  const unsharedCse = buildRecallCseCandidatePool({ source, queryContext });
  const sharedCse = buildRecallCseCandidatePool({ source, queryContext, cseContext });
  assert.deepEqual(sharedHistory, unsharedHistory);
  assert.deepEqual(sharedCse, unsharedCse);
  assert.deepEqual(
    selectRecall({ source, queryContext, historyContext, cseContext }),
    selectRecall({ source, queryContext }),
  );

  const firstHistory = sharedHistory.candidates.slice(1);
  const firstCse = sharedCse.candidates.slice(0, -1);
  const firstExcludedHistory = sharedHistory.candidates.slice(0, 1), firstExcludedCse = sharedCse.candidates.slice(-1);
  const first = selectRecall({ source, queryContext, historyContext, cseContext, selectedHistoryCandidates: firstHistory, selectedCseCandidates: firstCse, excludedHistoryCandidates: firstExcludedHistory, excludedCseCandidates: firstExcludedCse });
  selectRecall({ source, queryContext, historyContext, cseContext, selectedHistoryCandidates: sharedHistory.candidates.slice(0, 1), selectedCseCandidates: sharedCse.candidates.slice(-1), excludedHistoryCandidates: sharedHistory.candidates.slice(1), excludedCseCandidates: sharedCse.candidates.slice(0, -1) });
  const firstAgain = selectRecall({ source, queryContext, historyContext, cseContext, selectedHistoryCandidates: firstHistory, selectedCseCandidates: firstCse, excludedHistoryCandidates: firstExcludedHistory, excludedCseCandidates: firstExcludedCse });
  assert.deepEqual(firstAgain, first);
  assert.deepEqual(historyContext, historyBefore);
  assert.deepEqual(cseContext, cseBefore);
});

test('真实 LLM 入口每轮只建立一份选择上下文，查询和材料变化后的下一轮重新建立', async () => {
  const source = changingCseSource({ withHistory: true });
  let floorReads = 0, currentStateReads = 0;
  let floorMemories = source.floorMemories;
  let currentState = source.currentState;
  Object.defineProperty(source, 'floorMemories', { configurable: true, enumerable: true, get() { floorReads += 1; return floorMemories; } });
  Object.defineProperty(source, 'currentState', { configurable: true, enumerable: true, get() { currentStateReads += 1; return currentState; } });
  const run = queryContext => selectRecallWithLlm({
    source,
    queryContext,
    generateUtilityTask: async () => ({ jsonData: { history_exclude_keys: [], state_exclude_keys: [] } }),
  });

  await run({ ...llmQuery, text: '左佐和辛夷的门锁', latestUserText: '左佐和辛夷的门锁' });
  assert.equal(floorReads, 8, '同轮只应读取一次 history context，并由预演、payload 与最终选择复用');
  assert.equal(currentStateReads, 1, '实际 CSE 候选同轮只应建立一次 CSE context');
  floorMemories = floorMemories.map((memory, index) => index === 0 ? { ...memory, summary: `${memory.summary} 第二轮新材料` } : memory);
  currentState = currentState.map(subject => ({ ...subject, situational: subject.situational.map(item => ({ ...item, text: `${item.text} 第二轮新材料` })) }));
  await run({ ...llmQuery, text: '第二轮新材料', latestUserText: '第二轮新材料' });
  assert.equal(floorReads, 16, '新调用必须按新查询和新材料重新建立上下文');
  assert.equal(currentStateReads, 2, '第二轮必须按新查询和新 CSE 材料重新建立上下文');
});

test('LLM 宽候选遵守 48/24k 与摘要12、continuity12、事实24配额及借额，且不发送BM25分数', () => {
  const directOnly = buildRecallHistoryCandidatePool({ source: wideCandidateSource({ direct: 60 }), queryContext: llmQuery });
  assert.equal(directOnly.candidates.length, 48);
  assert.ok(directOnly.candidates.every(value => value.source === 'fact'));
  assert.ok(directOnly.text.length <= 24000);
  assert.doesNotMatch(directOnly.text, /rankScore|branchScores|BM25/i);

  const mixed = buildRecallHistoryCandidatePool({ source: wideCandidateSource({ direct: 2, summary: 55 }), queryContext: llmQuery });
  assert.equal(mixed.candidates.length, 48);
  assert.equal(mixed.candidates.filter(value => value.source === 'fact').length, 2);
  assert.equal(mixed.candidates.filter(value => value.source === 'summary').length, 46, '事实池缺额应借给摘要池');

  const long = buildRecallHistoryCandidatePool({ source: wideCandidateSource({ direct: 60, long: true }), queryContext: llmQuery });
  assert.ok(long.candidates.length > 0 && long.candidates.length < 48);
  assert.equal(long.limits.actualCharacters, long.text.length);
  assert.ok(long.text.length <= 24000);
  assert.ok(long.candidates.every(value => value.text.includes('很长的相关事实')), '单条事实只能完整进入或完整跳过');
});

test('大量人物事实下 payload 保留12摘要、6承诺、6未结与24事实，fake LLM 选中后真实注入', async () => {
  const userId = '88888888-7777-4777-8777-777777777777';
  const memories = Array.from({ length: 40 }, (_, index) => recallMemory(index + 1, {
    summary: index < 20 ? `港口夜航摘要 ${index}` : `普通人物摘要 ${index}`,
    commitments: index < 10 ? [{ speakerEntityId: PERSON, targetEntityIds: [userId], kind: 'promise', content: `港口夜航承诺 ${index}`, status: 'made', exactAnchorId: null }] : [],
    openLoops: index >= 10 && index < 20 ? [{ description: `港口夜航未结事项 ${index}`, ownerEntityIds: [PERSON] }] : [],
    events: [{ title: `港口夜航人物片段 ${index}`, description: `裴晚生在港口记录第 ${index} 条情绪与动作`, candidateStatus: 'accepted' }],
  }));
  const source = selectorSource({ memories });
  source.coverage = { ...source.coverage, stableAiFloors: 40, stableThroughAssistantSeq: 40, rememberedAiFloors: 40, cseThroughAssistantSeq: 40 };
  const queryContext = { text: '港口夜航承诺和未结事项', latestUserText: '港口夜航承诺和未结事项', recentAssistantText: '', previousUserText: '', messageCount: 1 };
  const pool = buildRecallHistoryCandidatePool({ source, queryContext });
  assert.deepEqual(pool.limits.groupCandidates, { summary: 12, continuity: 12, fact: 24 });
  assert.equal(pool.candidates.filter(value => value.value.kind === 'commitment').length, 6);
  assert.equal(pool.candidates.filter(value => value.value.kind === 'openLoop').length, 6);
  assert.match(pool.text, /类型 summary/);
  assert.match(pool.text, /类型 commitment/);
  assert.match(pool.text, /类型 openLoop/);

  const retainedKeys = [
    pool.candidates.find(value => value.value.kind === 'summary').key,
    pool.candidates.find(value => value.value.kind === 'commitment').key,
    pool.candidates.find(value => value.value.kind === 'openLoop').key,
  ];
  let payload = null;
  const selected = await selectRecallWithLlm({ source, queryContext, generateUtilityTask: async options => {
    payload = JSON.parse(options.taskMessages[0].content);
    return { jsonData: { history_exclude_keys: pool.candidates.map(value => value.key).filter(key => !retainedKeys.includes(key)), state_exclude_keys: [] }, taskMetadata: { finishReason: 'stop' } };
  } });
  assert.equal(payload.candidates.length, 48);
  assert.ok(payload.candidates.some(value => value.fact.includes('类型 summary')));
  assert.ok(payload.candidates.some(value => value.fact.includes('类型 commitment')));
  assert.ok(payload.candidates.some(value => value.fact.includes('类型 openLoop')));
  assert.match(selected.injectionText, /叙事回顾可能含内心、计划或未完成事项/);
  assert.match(selected.injectionText, /港口夜航承诺/);
  assert.match(selected.injectionText, /来源楼当时未结\(后文可能已推进,以后文为准\)/);
});

test('summary 候选默认保留，明确排除才移除；稳定键只映射本轮摘要', async () => {
  const source = wideCandidateSource({ summary: 1 });
  const pool = buildRecallHistoryCandidatePool({ source, queryContext: llmQuery });
  assert.equal(pool.candidates[0].source, 'summary');
  const calls = [];
  const selected = await selectRecallWithLlm({ source, queryContext: llmQuery, generateUtilityTask: async options => {
    calls.push(options); return { jsonData: { history_exclude_keys: pool.candidates.slice(1).map(value => value.key), state_exclude_keys: [] }, taskMetadata: { finishReason: 'stop' } };
  } });
  assert.match(selected.injectionText, /钟楼钥匙的关联摘要 0/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxTokens, 2048);
  assert.deepEqual(calls[0].transportBudget, { remaining: 1, used: 0 });
  assert.equal(calls[0].parseMode, 'semantic');

  const kept = await selectRecallWithLlm({ source, queryContext: llmQuery, generateUtilityTask: async () => ({ jsonData: { history_exclude_keys: [], state_exclude_keys: [] } }) });
  assert.match(kept.injectionText, /钟楼钥匙的关联摘要 0/);
  assert.equal(kept.skipReasons.includes('historySelectionFallback'), false);

  const excluded = await selectRecallWithLlm({ source, queryContext: llmQuery, generateUtilityTask: async () => ({ jsonData: { history_exclude_keys: pool.candidates.map(value => value.key), state_exclude_keys: [] } }) });
  assert.doesNotMatch(excluded.injectionText, /钟楼钥匙的关联摘要 0/);

  const forged = selectRecall({ source, queryContext: llmQuery, selectedHistoryCandidates: [{ ...pool.candidates[0], value: { ...pool.candidates[0].value, text: '伪造正文' } }] });
  assert.doesNotMatch(forged.injectionText, /伪造正文/);
  assert.match(forged.injectionText, /钟楼钥匙的关联摘要 0/);
});

test('LLM 排除忽略外层字段、合法键去重且混合非法键时执行合法排除；全非法作为技术失败上抛', async () => {
  const source = wideCandidateSource({ direct: 2 });
  source.currentState = [{ subjectEntityId: PERSON, core: [{ text: '始终谨慎守约', visibility: 'authorial', reason: '人物核心', origin: 'baseline', towardEntityId: null, sourceAssistantSeq: 1 }], adaptive: [], situational: [] }];
  const pool = buildRecallHistoryCandidatePool({ source, queryContext: llmQuery });
  const key = pool.candidates[0].key;
  for (const jsonData of [{ history_exclude_keys: [key, key], state_exclude_keys: [] }, { history_exclude_keys: ['R999', key, 7], state_exclude_keys: [], explanation: '多余字段' }]) {
    const result = await selectRecallWithLlm({ source, queryContext: llmQuery, generateUtilityTask: async () => ({ jsonData }) });
    assert.equal(result.skipReasons.includes('historySelectionFallback'), false);
    assert.equal(result.selectorDiagnostic.mode, 'llm');
    assert.equal(result.selectorDiagnostic.historyExcludedCount, 1);
  }
  await assert.rejects(
    () => selectRecallWithLlm({ source, queryContext: llmQuery, generateUtilityTask: async () => ({ jsonData: { history_exclude_keys: ['R999', 7], state_exclude_keys: [] } }) }),
    error => error?.code === 'V3_RECALL_LLM_KEYS_INVALID',
  );
  let calls = 0;
  const none = await selectRecallWithLlm({ source: selectorSource(), queryContext: { ...llmQuery, text: '宇宙飞船', latestUserText: '宇宙飞船' }, generateUtilityTask: async () => { calls += 1; } });
  assert.equal(calls, 0);
  assert.equal(none.status, 'empty');
  assert.equal(none.selectorDiagnostic.utilityRoundTripMs, 0);
  assert.ok(Number.isFinite(none.selectorDiagnostic.localSelectionMs));
});

test('宽候选排除近期楼位与可靠证明确已在 core 正文中的远期楼，未映射远期楼仍保留', () => {
  const memories = Array.from({ length: 12 }, (_, index) => recallMemory(index + 1));
  memories[1] = recallMemory(2, { commitments: [{ speakerEntityId: PERSON, targetEntityIds: [], kind: 'plan', content: '密门计划只在心中推演', status: 'made', exactAnchorId: null }] });
  memories[6] = recallMemory(7, { events: [{ title: '密门计划近期变化', description: '这条最近正文不该进入候选', candidateStatus: 'accepted' }] });
  const source = selectorSource({ memories });
  source.bodyMatch = { coveredFloorIds: ['floor-7'] };
  const pool = buildRecallHistoryCandidatePool({ source, queryContext: { ...llmQuery, text: '密门计划', latestUserText: '密门计划' } });
  assert.match(pool.text, /私有内容；仅 裴晚生 可用/);
  assert.match(pool.text, /来源楼当时的计划（不代表已告知、已完成或如今仍有效；以后文为准）/);
  assert.doesNotMatch(pool.text, /这条最近正文不该进入候选/);
  delete source.bodyMatch;
  assert.match(buildRecallHistoryCandidatePool({ source, queryContext: { ...llmQuery, text: '密门计划', latestUserText: '密门计划' } }).text, /这条最近正文不该进入候选/);
});

test('LLM 选材不再创建15秒局部截止，等待现有API超时且外层operation abort仍向上取消', async () => {
  const source = wideCandidateSource({ direct: 2 });
  let localTimerCalls = 0, calls = 0, release;
  const pending = selectRecallWithLlm({
    source, queryContext: llmQuery,
    setTimer: () => { localTimerCalls += 1; },
    generateUtilityTask: async ({ transportBudget }) => {
      calls += 1; assert.deepEqual(transportBudget, { remaining: 1, used: 0 });
      return new Promise(resolve => { release = resolve; });
    },
  });
  await Promise.resolve();
  release({ jsonData: { history_exclude_keys: [], state_exclude_keys: [] }, taskMetadata: { source: 'test', sourceLabel: '测试API', model: 'slow-model', finishReason: 'stop', transportAttempts: 1 } });
  const selected = await pending;
  assert.equal(calls, 1);
  assert.equal(localTimerCalls, 0);
  assert.equal(selected.skipReasons.includes('historySelectionFallback'), false);
  assert.equal(selected.selectorDiagnostic.model, 'slow-model');
  assert.ok(Number.isFinite(selected.selectorDiagnostic.utilityRoundTripMs));
  assert.ok(Number.isFinite(selected.selectorDiagnostic.localSelectionMs));

  const operation = new AbortController();
  const aborted = selectRecallWithLlm({ source, queryContext: llmQuery, signal: operation.signal, generateUtilityTask: async ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })) });
  operation.abort('stopped');
  await assert.rejects(aborted, error => error?.name === 'AbortError');
});

test('LLM selector 分别记录含传输的接口往返与请求前后本地选材，且不增加utility调用', async () => {
  const source = wideCandidateSource({ direct:2 });
  let calls = 0;
  const selected = await selectRecallWithLlm({
    source, queryContext:llmQuery,
    generateUtilityTask:async () => {
      calls += 1;
      await new Promise(resolve => setTimeout(resolve, 20));
      return { jsonData:{ history_exclude_keys:[], state_exclude_keys:[] } };
    },
  });
  assert.equal(calls, 1);
  assert.ok(selected.selectorDiagnostic.utilityRoundTripMs >= 15);
  assert.ok(selected.selectorDiagnostic.localSelectionMs >= 0);
  assert.ok(selected.selectorDiagnostic.durationMs >= selected.selectorDiagnostic.utilityRoundTripMs);
  assert.ok(selected.selectorDiagnostic.durationMs >= selected.selectorDiagnostic.localSelectionMs);
});

const recallState = (stateId, text, sourceAssistantSeq, patch = {}) => ({
  stateId,
  text,
  visibility: patch.visibility ?? 'private',
  reason: patch.reason ?? '正文行为',
  origin: patch.origin ?? 'floor',
  towardEntityId: patch.towardEntityId ?? null,
  sourceFloorId: patch.sourceFloorId ?? `floor-${sourceAssistantSeq}`,
  sourceDeltaId: patch.sourceDeltaId ?? `delta-${sourceAssistantSeq}`,
  sourceAssistantSeq,
});

function changingCseSource({ withHistory = false } = {}) {
  const oldControl = recallState('state-old-control', '仍有强烈控制冲动', 30, { sourceFloorId: 'floor-30', sourceDeltaId: 'delta-30' });
  const allowedYard = recallState('state-yard', '因不愿重蹈覆辙而放弃反锁，允许辛夷去院子', 42, { sourceFloorId: 'floor-42', sourceDeltaId: 'delta-42' });
  const calledBack = recallState('state-called-back', '后来发短信要求辛夷回屋', 43, { sourceFloorId: 'floor-43', sourceDeltaId: 'delta-43' });
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  if (withHistory) memories[0] = recallMemory(1, { events: [{ title: '旧门锁', description: '左佐早年买过一把旧门锁', candidateStatus: 'accepted' }] });
  const source = selectorSource({ memories, currentState: [{ subjectEntityId: PERSON, core: [], adaptive: [oldControl], situational: [calledBack] }] });
  source.entities[0] = { ...source.entities[0], displayName: '左佐', aliases: ['左先生'] };
  source.entities[1] = { ...source.entities[1], displayName: '辛夷', aliases: [] };
  source.cseChanges = [
    { deltaId: 'delta-30', floorId: 'floor-30', assistantSeq: 30, subjectEntityId: PERSON, layer: 'adaptive', action: 'add', before: null, after: oldControl },
    { deltaId: 'delta-42', floorId: 'floor-42', assistantSeq: 42, subjectEntityId: PERSON, layer: 'situational', action: 'add', before: null, after: allowedYard },
    { deltaId: 'delta-43', floorId: 'floor-43', assistantSeq: 43, subjectEntityId: PERSON, layer: 'situational', action: 'refine', before: allowedYard, after: calledBack },
  ];
  return source;
}

test('CSE 候选按人物单份组织当前与时序变化，可靠同源 add/current 只保留当前键', () => {
  const source = changingCseSource();
  const pool = buildRecallCseCandidatePool({ source, queryContext: { ...llmQuery, text: '左佐和辛夷的门锁', latestUserText: '左佐和辛夷的门锁' } });
  assert.ok(pool.candidates.length <= 24);
  assert.ok(pool.text.length <= 12000);
  assert.equal(pool.limits.actualCharacters, JSON.stringify(pool.groups).length);
  const group = pool.groups.find(value => value.subject === '左佐');
  assert.ok(group);
  assert.deepEqual(group.items.map(value => value.kind), ['current', 'current', 'change', 'change']);
  assert.deepEqual(group.items.filter(value => value.kind === 'change').map(value => value.assistantSeq), [42, 43]);
  assert.equal(group.items.some(value => value.kind === 'change' && value.assistantSeq === 30), false, '同源 add/current 不重复占候选');
  assert.match(pool.text, /仍有强烈控制冲动/);
  assert.match(pool.text, /不愿重蹈覆辙/);
  assert.match(pool.text, /要求辛夷回屋/);

  const longStates = Array.from({ length: 24 }, (_, index) => recallState(`long-state-${index}`, `状态 ${index}`, index + 1, { reason: `完整依据 ${index} ${'甲'.repeat(1200)}` }));
  const longPool = buildRecallCseCandidatePool({ source: selectorSource({ currentState: [{ subjectEntityId: PERSON, core: longStates, adaptive: [], situational: [] }] }), queryContext: { ...llmQuery, text: '状态', latestUserText: '状态' } });
  assert.ok(longPool.candidates.length > 0 && longPool.candidates.length < 24, 'reason 等实际发送字段必须计入12k，单项只能完整加入或跳过');
  assert.equal(longPool.limits.actualCharacters, JSON.stringify(longPool.groups).length);
  assert.ok(longPool.limits.actualCharacters <= 12000);
  assert.ok(longPool.groups.flatMap(value => value.items).every(value => value.reason.length > 1200));
});

test('CSE-only 仍复用一次 LLM，反序选择变化后按楼序呈现且同源 after 指向当前快照', async () => {
  const source = changingCseSource();
  const queryContext = { ...llmQuery, text: '左佐和辛夷的门锁', latestUserText: '左佐和辛夷的门锁' };
  const pool = buildRecallCseCandidatePool({ source, queryContext });
  const current = pool.candidates.find(value => value.source === 'current' && value.value.text.includes('要求辛夷回屋'));
  const changes = pool.candidates.filter(value => value.source === 'change');
  let calls = 0, payload;
  const result = await selectRecallWithLlm({ source, queryContext, generateUtilityTask: async options => {
    calls += 1; payload = JSON.parse(options.taskMessages[0].content);
    assert.match(options.systemPrompt, /history_exclude_keys[\s\S]*state_exclude_keys/);
    assert.doesNotMatch(options.systemPrompt, /selected_keys/);
    return { jsonData: { history_exclude_keys: [], state_exclude_keys: [] } };
  } });
  assert.equal(calls, 1);
  assert.deepEqual(payload.candidates, []);
  assert.equal(payload.cseContextGroups.length > 0, true);
  assert.deepEqual({
    historyCandidates: result.selectorDiagnostic.historyCandidateCount,
    stateCandidates: result.selectorDiagnostic.stateCandidateCount,
    historyExcluded: result.selectorDiagnostic.historyExcludedCount,
    stateExcluded: result.selectorDiagnostic.stateExcludedCount,
    stateRetained: result.selectorDiagnostic.stateRetainedCount,
  }, { historyCandidates: 0, stateCandidates: pool.candidates.length, historyExcluded: 0, stateExcluded: 0, stateRetained: pool.candidates.length });
  assert.deepEqual(result.cseChanges.map(value => value.assistantSeq), [42, 43]);
  assert.deepEqual(result.storylines.map(value => value.title), ['相关人物状态补充']);
  assert.match(result.storylines[0].basis, /当前输入直接匹配以下已有人物状态材料/);
  assert.doesNotMatch(`${result.storylines[0].title}${result.storylines[0].basis}`, /来源关联旧事|引用这些来源/);
  assert.equal(result.injectionText.match(/后来发短信要求辛夷回屋/g)?.length, 1);
  assert.match(result.injectionText, /之后 见本线末尾当前快照（同一来源）/);
  assert.ok(result.injectionText.indexOf('[来源 AI #42]') < result.injectionText.indexOf('[来源 AI #43]'));
  assert.ok(result.injectionText.indexOf('[来源 AI #43]') < result.injectionText.indexOf('[已保存人物状态依据]'), '历史变化按楼序排列，已保存快照最后');
  assert.doesNotMatch(result.injectionText, /左佐已经改变|应当变得|用户期待/);
});

test('同一次选材调用可返回有来源时间的状态推演，坏条目与被排除证据不会留下孤立建议', async () => {
  const source = changingCseSource({ withHistory: true });
  source.floorMemories.push(recallMemory(43, {
    summary:'左佐入夜后仍要求辛夷回屋，随后剧情来到次日清晨。',
    chronology: [{ time: { kind:'relative', sourceText:'入夜后过了一阵', normalized:null, precision:'unresolved', relativeToAssistantSeq:42 }, description:'' }],
  }));
  source.coverage = { ...source.coverage, stableAiFloors:43, stableThroughAssistantSeq:43, rememberedAiFloors:source.floorMemories.length, cseThroughAssistantSeq:43, memoryComplete:false, cseCurrent:true };
  const queryContext = { ...llmQuery, text:'次日清晨，左佐准备开门', latestUserText:'次日清晨，左佐准备开门' };
  const historyPool = buildRecallHistoryCandidatePool({ source, queryContext });
  const csePool = buildRecallCseCandidatePool({ source, queryContext });
  const sourceState = csePool.candidates.find(value => value.source === 'current' && value.value.sourceFloorId === 'floor-43');
  const evidence = historyPool.candidates[0];
  let calls = 0, payload;
  const result = await selectRecallWithLlm({ source, queryContext, generateUtilityTask: async options => {
    calls += 1; payload = JSON.parse(options.taskMessages[0].content);
    const recentKey = payload.alreadyProvided.recentContinuation[0]?.key;
    return { jsonData: {
      history_exclude_keys: [], state_exclude_keys: [],
      state_progressions: [
        { source_state_key:sourceState.key, evidence_keys:recentKey ? [recentKey] : [], time_basis:'次日清晨；\n具体经过时长未明确', suggestion:'保存时仍要求辛夷回屋→\n此刻可表现为控制冲动仍有余波，但行动强度需以后文为准' },
        { source_state_key:'C999', evidence_keys:[], time_basis:'未知', suggestion:'伪造建议' },
      ],
    } };
  } });
  assert.equal(calls, 1);
  const payloadState = payload.cseContextGroups.flatMap(value => value.items).find(value => value.key === sourceState.key);
  assert.match(payloadState.sourceTime, /入夜后过了一阵/);
  assert.match(payload.alreadyProvided.recentContinuation[0].time, /入夜后过了一阵/);
  assert.match(payload.alreadyProvided.recentContinuation[0].key, /^P\d+$/);
  assert.equal(payload.query.latestUser, '次日清晨，左佐准备开门');
  assert.equal(result.stateProgressions.length, 1);
  assert.deepEqual({ subject:result.stateProgressions[0].subject, visibility:result.stateProgressions[0].visibility, sourceFloorId:result.stateProgressions[0].sourceFloorId }, { subject:'左佐', visibility:'private', sourceFloorId:'floor-43' });
  assert.match(result.injectionText, /时间推演（仅供作者续写表现参考，不是新剧情事实，也不表示任何角色已知）/);
  assert.match(result.injectionText, /接续上方 situational 当前状态/);
  assert.doesNotMatch(result.injectionText.split('[时间推演')[1], /后来发短信要求辛夷回屋/);
  assert.match(result.injectionText, /次日清晨； 具体经过时长未明确/);
  assert.doesNotMatch(result.injectionText, /→\n此刻/);
  assert.doesNotMatch(result.injectionText, /伪造建议/);
  assert.equal(result.stages.stateProgressionCount, 1);
  assert.ok(result.stages.estimatedTokenCount <= result.stages.estimatedTokenBudget);

  if (evidence) {
    const excluded = await selectRecallWithLlm({ source, queryContext, contextSize:1000, generateUtilityTask: async () => ({ jsonData: {
      history_exclude_keys:[evidence.key], state_exclude_keys:[],
      state_progressions:[{ source_state_key:sourceState.key, evidence_keys:[evidence.key], time_basis:'过了一阵', suggestion:'这条证据已经被排除，不应保留'.repeat(20) }],
    } }) });
    assert.deepEqual(excluded.stateProgressions, []);
    assert.doesNotMatch(excluded.injectionText, /这条证据已经被排除/);
  }
});

test('state_progressions 可缺失或逐条无效而不改变成功选材，预算不足时优先舍弃推演', async () => {
  const source = changingCseSource();
  const queryContext = { ...llmQuery, text:'左佐和辛夷的门锁', latestUserText:'左佐和辛夷的门锁' };
  const pool = buildRecallCseCandidatePool({ source, queryContext });
  const sourceState = pool.candidates.find(value => value.source === 'current');
  const missing = await selectRecallWithLlm({ source, queryContext, generateUtilityTask: async () => ({ jsonData:{ history_exclude_keys:[], state_exclude_keys:[] } }) });
  assert.deepEqual(missing.stateProgressions, []);
  assert.ok(missing.states.length + missing.cseChanges.length > 0);
  const malformed = await selectRecallWithLlm({ source, queryContext, generateUtilityTask: async () => ({ jsonData:{ history_exclude_keys:[], state_exclude_keys:[], state_progressions:[null, { source_state_key:sourceState.key, evidence_keys:'bad', time_basis:'稍后', suggestion:'不应出现' }] } }) });
  assert.deepEqual(malformed.stateProgressions, []);
  assert.ok(malformed.states.length + malformed.cseChanges.length > 0);
  const budgeted = await selectRecallWithLlm({ source, queryContext, contextSize:1000, generateUtilityTask: async () => ({ jsonData:{ history_exclude_keys:[], state_exclude_keys:[], state_progressions:[{ source_state_key:sourceState.key, evidence_keys:[], time_basis:'时间仍然模糊', suggestion:'很长的表现建议'.repeat(100) }] } }) });
  assert.deepEqual(budgeted.stateProgressions, []);
  assert.ok(budgeted.stages.estimatedTokenCount <= budgeted.stages.estimatedTokenBudget);
});

test('时间推演只使用普通材料之后的额外额度，普通楼、状态、变化、剧情线与候选输入保持不变', async () => {
  const memories = Array.from({ length:20 }, (_, index) => recallMemory(index + 1, {
    summary:index >= 16 ? `蓝铜推演近期 ${index + 1} ${'甲'.repeat(380)}` : '',
    events:index < 16 ? [{ title:`蓝铜推演旧事 ${index + 1}`, description:`同一剧情线证据 ${index + 1} ${'乙'.repeat(300)}`, candidateStatus:'accepted' }] : [],
  }));
  const state = recallState('progression-budget-state', `蓝铜推演状态 ${'丙'.repeat(120)}`, 20, { visibility:'authorial', sourceFloorId:'floor-20', sourceDeltaId:'delta-20' });
  const source = selectorSource({ memories, currentState:[{ subjectEntityId:PERSON, core:[state], adaptive:[], situational:[] }] });
  const queryContext = { ...llmQuery, text:'蓝铜推演同一剧情线', latestUserText:'蓝铜推演同一剧情线' };
  const payloads = [];
  let calls = 0;
  const run = includeProgression => selectRecallWithLlm({ source, queryContext, contextSize:50000, generateUtilityTask:async options => {
    calls += 1;
    const payload = JSON.parse(options.taskMessages[0].content);
    payloads.push(payload);
    const sourceState = payload.cseContextGroups.flatMap(value => value.items).find(value => value.kind === 'current' && value.text.includes('蓝铜推演状态'));
    assert.ok(sourceState);
    return { jsonData:{ history_exclude_keys:[], state_exclude_keys:[], ...(includeProgression ? { state_progressions:[{
      source_state_key:sourceState.key, evidence_keys:[], time_basis:'次日清晨，具体间隔未明确', suggestion:`可保留先前状态的余波 ${'丁'.repeat(480)}`,
    }] } : {}) } };
  } });
  const ordinary = await run(false);
  const extended = await run(true);
  assert.equal(calls, 2, '每次选材仍只调用一次 utility');
  assert.deepEqual(payloads[1], payloads[0], '时间推演输出不得改变送入模型的普通候选');
  assert.equal(ordinary.stages.ordinaryEstimatedTokenBudget, 4000);
  assert.equal(ordinary.limits.ordinaryMaxCharacters, 16000);
  assert.ok(ordinary.stages.estimatedTokenCount <= ordinary.stages.ordinaryEstimatedTokenBudget);
  assert.equal(extended.stages.estimatedTokenBudget, 5000);
  assert.equal(extended.limits.maxCharacters, 20000);
  assert.deepEqual(extended.floors, ordinary.floors);
  assert.deepEqual(extended.states, ordinary.states);
  assert.deepEqual(extended.cseChanges, ordinary.cseChanges);
  assert.deepEqual(extended.storylines, ordinary.storylines);
  assert.equal(extended.stateProgressions.length, 1);
  assert.ok(extended.stages.estimatedTokenCount > extended.stages.ordinaryEstimatedTokenBudget, 'fixture 必须证明推演使用了普通4000之外的额度');
  assert.ok(extended.stages.estimatedTokenCount <= extended.stages.estimatedTokenBudget);
});

test('推演扩展额度仍按小宿主上下文和前情预留收紧，超过最终总额度的推演继续未选入', () => {
  const source = changingCseSource();
  const queryContext = { ...llmQuery, text:'左佐和辛夷的门锁', latestUserText:'左佐和辛夷的门锁' };
  const csePool = buildRecallCseCandidatePool({ source, queryContext });
  const sourceState = csePool.candidates.find(value => value.source === 'current');
  const candidates = Array.from({ length:8 }, (_, index) => ({
    sourceStateStableKey:sourceState.stableKey,
    subjectEntityId:sourceState.value.subjectEntityId, subject:sourceState.value.subject, towardEntityId:sourceState.value.towardEntityId ?? null, toward:null,
    savedText:sourceState.value.text, visibility:sourceState.value.visibility, sourceStateId:sourceState.value.stateId,
    sourceFloorId:sourceState.value.sourceFloorId, sourceAssistantSeq:sourceState.value.sourceAssistantSeq,
    timeBasis:`时间依据 ${index + 1} ${'戊'.repeat(280)}`, suggestion:`表现建议 ${index + 1} ${'丁'.repeat(580)}`, evidence:[],
  }));
  const small = selectRecall({ source, queryContext, contextSize:1000, selectedCseCandidates:csePool.candidates, stateProgressionCandidates:candidates });
  assert.equal(small.stages.ordinaryEstimatedTokenBudget, 800);
  assert.equal(small.stages.estimatedTokenBudget, 800);
  assert.equal(small.limits.ordinaryMaxCharacters, 800);
  assert.equal(small.limits.maxCharacters, 800);
  assert.deepEqual(small.stateProgressions, []);

  const reserved = selectRecall({ source, queryContext, contextSize:50000, reservedTokens:750, reservedCharacters:2500, selectedCseCandidates:csePool.candidates, stateProgressionCandidates:candidates });
  assert.equal(reserved.stages.ordinaryEstimatedTokenBudget, 3250);
  assert.equal(reserved.stages.estimatedTokenBudget, 4250);
  assert.equal(reserved.limits.ordinaryMaxCharacters, 13500);
  assert.equal(reserved.limits.maxCharacters, 17500);
  assert.ok(reserved.stateProgressions.length < candidates.length);
  assert.ok(reserved.stages.budgetDroppedCount >= 1);
  assert.ok(reserved.stages.estimatedTokenCount <= reserved.stages.estimatedTokenBudget);
  assert.ok(reserved.limits.actualCharacters <= reserved.limits.maxCharacters);
});

test('来源状态幸存但证据因最终预算未入选时不留推演，超过六个真实证据也整条省略', async () => {
  const state = recallState('progress-source', '仍有疲惫余波', 1, { visibility:'private' });
  const longSource = selectorSource({
    memories:[
      recallMemory(1, { events:[{ title:'疲惫后文证据', description:`疲惫后文证据 ${'很长的正文证据'.repeat(500)}`, candidateStatus:'accepted' }] }),
      ...Array.from({ length:4 }, (_, index) => recallMemory(index + 2)),
    ],
    currentState:[{ subjectEntityId:PERSON, core:[state], adaptive:[], situational:[] }],
  });
  const queryContext = { ...llmQuery, text:'疲惫后文证据', latestUserText:'疲惫后文证据' };
  let referencedHistoryKey;
  const budgeted = await selectRecallWithLlm({ source:longSource, queryContext, contextSize:1000, generateUtilityTask:async options => {
    const payload = JSON.parse(options.taskMessages[0].content);
    referencedHistoryKey = payload.candidates[0]?.key;
    const sourceKey = payload.cseContextGroups.flatMap(value => value.items).find(value => value.kind === 'current')?.key;
    return { jsonData:{ history_exclude_keys:[], state_exclude_keys:[], state_progressions:[{ source_state_key:sourceKey, evidence_keys:[referencedHistoryKey], time_basis:'过了一阵', suggestion:'应由最终证据支撑的表现建议' }] } };
  } });
  assert.ok(referencedHistoryKey);
  assert.equal(budgeted.states.some(value => value.stateId === state.stateId), true, '来源C必须实际留在最终结果');
  assert.equal(budgeted.floors.some(value => value.items.some(item => item.text.includes('疲惫后文证据'))), false, '超长R证据必须确因最终预算未入选');
  assert.deepEqual(budgeted.stateProgressions, []);
  assert.doesNotMatch(budgeted.injectionText, /应由最终证据支撑的表现建议/);

  const manySource = selectorSource({
    memories:Array.from({ length:8 }, (_, index) => recallMemory(index + 1, { events:[{ title:`疲惫证据${index + 1}`, description:`疲惫证据${index + 1}仍与本轮有关`, candidateStatus:'accepted' }] })),
    currentState:[{ subjectEntityId:PERSON, core:[state], adaptive:[], situational:[] }],
  });
  let evidenceKeys = [];
  const tooMany = await selectRecallWithLlm({ source:manySource, queryContext:{ ...llmQuery, text:'疲惫证据', latestUserText:'疲惫证据' }, contextSize:12000, generateUtilityTask:async options => {
    const payload = JSON.parse(options.taskMessages[0].content);
    evidenceKeys = payload.candidates.slice(0, 7).map(value => value.key);
    const sourceKey = payload.cseContextGroups.flatMap(value => value.items).find(value => value.kind === 'current')?.key;
    return { jsonData:{ history_exclude_keys:[], state_exclude_keys:[], state_progressions:[{ source_state_key:sourceKey, evidence_keys:evidenceKeys, time_basis:'数段剧情之后', suggestion:'不应静默丢掉第七项后仍保留' }] } };
  } });
  assert.equal(evidenceKeys.length, 7);
  assert.ok(tooMany.floors.length > 0);
  assert.deepEqual(tooMany.stateProgressions, []);
  assert.equal(tooMany.skipReasons.includes('historySelectionFallback'), false);
});

test('LLM 无明确排除时保留全部低本地分 CSE，受二十四项上限并按人物时序展示', async () => {
  const states = Array.from({ length: 7 }, (_, index) => recallState(`state-priority-${index + 1}`, `与查询无词面关系的状态 ${index + 1}`, index + 1));
  const source = selectorSource({ currentState: [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: states }] });
  const queryContext = { ...llmQuery, text: '宇宙飞船', latestUserText: '宇宙飞船' };
  const pool = buildRecallCseCandidatePool({ source, queryContext });
  assert.equal(pool.candidates.length, 7);
  const result = await selectRecallWithLlm({ source, queryContext, contextSize: 12000, generateUtilityTask: async () => ({ jsonData: { history_exclude_keys: [], state_exclude_keys: [] } }) });
  assert.equal(result.selectorDiagnostic.stateCandidateCount, 7);
  assert.equal(result.selectorDiagnostic.stateExcludedCount, 0);
  assert.equal(result.selectorDiagnostic.stateRetainedCount, 7);
  assert.equal(result.states.length, 7);
  assert.deepEqual(new Set(result.states.map(value => value.stateId)), new Set(pool.candidates.map(value => value.value.stateId)));
});

test('同一次 LLM 分开排除 history/current/change，空排除、全排除与非法键沿新合同处理', async () => {
  const source = changingCseSource({ withHistory: true });
  const queryContext = { ...llmQuery, text: '左佐辛夷旧门锁', latestUserText: '左佐辛夷旧门锁' };
  const history = buildRecallHistoryCandidatePool({ source, queryContext });
  const cse = buildRecallCseCandidatePool({ source, queryContext });
  const result = await selectRecallWithLlm({ source, queryContext, generateUtilityTask: async () => ({ jsonData: { history_exclude_keys: [], state_exclude_keys: [] } }) });
  assert.equal(result.selectorDiagnostic.mode, 'llm');
  assert.match(result.injectionText, /左佐早年买过一把旧门锁/);
  assert.ok(result.states.length >= 1);
  assert.ok(result.cseChanges.length >= 1);
  assert.deepEqual({
    historyCandidates: result.selectorDiagnostic.historyCandidateCount,
    stateCandidates: result.selectorDiagnostic.stateCandidateCount,
    historyExcluded: result.selectorDiagnostic.historyExcludedCount,
    stateExcluded: result.selectorDiagnostic.stateExcludedCount,
    historyRetained: result.selectorDiagnostic.historyRetainedCount,
    stateRetained: result.selectorDiagnostic.stateRetainedCount,
  }, { historyCandidates: history.candidates.length, stateCandidates: cse.candidates.length, historyExcluded: 0, stateExcluded: 0, historyRetained: history.candidates.length, stateRetained: cse.candidates.length });
  const empty = await selectRecallWithLlm({ source, queryContext, generateUtilityTask: async () => ({ jsonData: { history_exclude_keys: history.candidates.map(value => value.key), state_exclude_keys: cse.candidates.map(value => value.key) } }) });
  assert.equal(empty.states.length, 0);
  assert.equal(empty.cseChanges.length, 0);
  assert.equal(empty.selectorDiagnostic.mode, 'llm');
  assert.equal(empty.selectorDiagnostic.historyRetainedCount, 0);
  assert.equal(empty.selectorDiagnostic.stateRetainedCount, 0);
  await assert.rejects(
    () => selectRecallWithLlm({ source, queryContext, generateUtilityTask: async () => ({ jsonData: { history_exclude_keys: ['R999'], state_exclude_keys: ['C999'] } }) }),
    error => error?.code === 'V3_RECALL_LLM_KEYS_INVALID',
  );
});

test('排除协议缺字段、旧 selected_keys 与跨池键均不冒充显式空排除，结构错误原样上抛', async () => {
  const source = changingCseSource({ withHistory: true });
  const queryContext = { ...llmQuery, text: '左佐辛夷旧门锁', latestUserText: '左佐辛夷旧门锁' };
  const history = buildRecallHistoryCandidatePool({ source, queryContext });
  const cse = buildRecallCseCandidatePool({ source, queryContext });
  const cases = [
    { history_exclude_keys: [history.candidates[0].key] },
    { state_exclude_keys: [cse.candidates[0].key] },
    { selected_keys: [history.candidates[0].key, cse.candidates[0].key] },
    { history_exclude_keys: [cse.candidates[0].key], state_exclude_keys: [history.candidates[0].key] },
  ];
  for (const jsonData of cases) {
    await assert.rejects(
      () => selectRecallWithLlm({ source, queryContext, generateUtilityTask: async () => ({ jsonData }) }),
      error => ['V3_RECALL_LLM_SCHEMA_INVALID', 'V3_RECALL_LLM_KEYS_INVALID'].includes(error?.code),
      JSON.stringify(jsonData),
    );
  }
});

test('关联补结要求人物交集与稀有主题词同时成立，明确排除的材料不会复活', () => {
  const memories = Array.from({ length: 10 }, (_, index) => recallMemory(index + 1, { summary: index >= 6 ? `近期接续 ${index + 1}` : '' }));
  memories[0] = recallMemory(1, {
    summary: '蓝铜账本带着红色火漆封条。', participants: [{ entityId: PERSON, presence: 'present' }],
    events: [{ title: '火漆封条', description: '蓝铜账本带着红色火漆封条', candidateStatus: 'accepted' }],
  });
  memories[1] = recallMemory(2, {
    summary: '蓝铜账本里夹着律师签字收据。', participants: [{ entityId: PERSON, presence: 'present' }],
    events: [{ title: '签字收据', description: '蓝铜账本里夹着律师签字收据', candidateStatus: 'accepted' }],
  });
  memories[2] = recallMemory(3, {
    summary: '裴晚生与朋友吃过早餐。', participants: [{ entityId: PERSON, presence: 'present' }],
    events: [{ title: '早餐', description: '裴晚生与朋友吃过早餐', candidateStatus: 'accepted' }],
  });
  memories[5] = recallMemory(6, {
    summary: '蓝铜账本连同律师签字收据和红色火漆封条被转交。', participants: [{ entityId: PERSON, presence: 'present' }],
    events: [{ title: '蓝铜账本后续', description: '蓝铜账本连同律师签字收据和红色火漆封条被转交', candidateStatus: 'accepted' }],
  });
  const source = selectorSource({ memories });
  const queryContext = { text: '律师手里的蓝铜账本', latestUserText: '律师手里的蓝铜账本', messageCount: 1 };
  const pool = buildRecallHistoryCandidatePool({ source, queryContext });
  const anchor = pool.candidates.find(value => value.value.floorId === 'floor-6' && value.value.kind === 'event');
  const excluded = pool.candidates.find(value => value.value.floorId === 'floor-1' && value.value.kind === 'event');
  assert.ok(anchor && excluded);
  const linked = selectRecall({ source, queryContext, selectedHistoryCandidates: [anchor] });
  assert.equal(linked.floors.some(value => value.assistantSeq === 1), true, '同人物且共享稀有主题词的前因应补入');
  assert.equal(linked.floors.some(value => value.assistantSeq === 3), false, '仅人物相同的早餐不得串入账本事务');
  assert.match(linked.injectionText, /同人物与具体主题词关联，不表示因果/);
  const excludedResult = selectRecall({ source, queryContext, selectedHistoryCandidates: [anchor], excludedHistoryCandidates: [excluded] });
  assert.equal(excludedResult.floors.some(value => value.assistantSeq === 1), false, '明确排除的 fact 不得经同楼 summary 或其他条目复活');
  assert.equal(excludedResult.floors.some(value => value.assistantSeq === 2), true, '排除靠前关联项后，后续合法关联仍应补入');
});

test('主题关联只补实际承载证据的条目，不被整楼摘要或单个套话 bigram 误导', () => {
  const memories = Array.from({ length: 10 }, (_, index) => recallMemory(index + 1, { summary: index >= 6 ? `近期接续 ${index + 1}` : '' }));
  memories[0] = recallMemory(1, {
    summary: '窗外的风吹了一整夜。', participants: [{ entityId: PERSON, presence: 'present' }],
    observations: [{ subjectEntityId: PERSON, description: '雷达失灵' }],
  });
  memories[2] = recallMemory(3, {
    summary: '他们后来处理了很多事情并继续上路。', participants: [{ entityId: PERSON, presence: 'present' }],
    observations: [{ subjectEntityId: PERSON, description: '后来处理了很多事情并继续讨论早餐菜单采购清单餐具摆放座位安排天气路线车辆油量衣服颜色' }],
  });
  memories[5] = recallMemory(6, {
    summary: '屋里仍然没有开灯。', participants: [{ entityId: PERSON, presence: 'present' }],
    observations: [{ subjectEntityId: PERSON, description: '后来处理了很多事情并继续追查雷达停摆原因核对频率波形天线电源接口线路日志时间坐标异常' }],
  });
  const source = selectorSource({ memories });
  const queryContext = { text: '雷达停摆', latestUserText: '雷达停摆', messageCount: 1 };
  const pool = buildRecallHistoryCandidatePool({ source, queryContext });
  const anchor = pool.candidates.find(value => value.value.floorId === 'floor-6' && value.value.kind === 'observation');
  assert.ok(anchor);
  const result = selectRecall({ source, queryContext, selectedHistoryCandidates: [anchor] });
  const linkedFloor = result.floors.find(value => value.assistantSeq === 1);
  assert.ok(linkedFloor, '短事实间共享的具体词应能建立关联');
  assert.equal(linkedFloor.items.some(value => value.kind === 'observation' && value.relationEvidence === 'topic'), true);
  assert.equal(linkedFloor.items.some(value => value.kind === 'summary' && value.relationEvidence === 'topic'), false, '无关摘要不得代替真正承载主题的事实');
  assert.equal(result.floors.some(value => value.assistantSeq === 3), false, '仅共享后来等套话不得关联');
});

test('剧情线后续附加始终只核原锚，同楼成员不能把无关二跳材料带进来', () => {
  const distraction = index => Array.from({ length: 10 }, (_, token) => `DISTRACTOR_${index}_${token}`).join(' ');
  const memories = Array.from({ length: 18 }, (_, index) => recallMemory(index + 1, {
    summary: index >= 14 ? `近期接续 ${index + 1}` : '', participants: [{ entityId: PERSON, presence: 'present' }],
  }));
  memories[0] = recallMemory(1, {
    participants: [{ entityId: PERSON, presence: 'present' }],
    commitments: [{ speakerEntityId: PERSON, targetEntityIds: [], kind: 'promise', content: '蓝铜账本', status: 'made', exactAnchorId: null }],
  });
  memories[1] = recallMemory(2, {
    participants: [{ entityId: PERSON, presence: 'present' }],
    observations: [
      { subjectEntityId: PERSON, description: '蓝铜账本红蜡封条' },
      { subjectEntityId: PERSON, description: '红蜡封条暗门' },
    ],
  });
  for (let index = 3; index <= 13; index += 1) memories[index - 1] = recallMemory(index, {
    participants: [{ entityId: PERSON, presence: 'present' }], observations: [{ subjectEntityId: PERSON, description: distraction(index) }],
  });
  const query = `蓝铜账本 红蜡封条 暗门 ${Array.from({ length: 11 }, (_, index) => distraction(index + 3)).join(' ')}`;
  const source = selectorSource({ memories });
  const queryContext = { text: query, latestUserText: query, messageCount: 1 };
  const pool = buildRecallHistoryCandidatePool({ source, queryContext });
  const result = selectRecall({ source, queryContext, contextSize: 12000, selectedHistoryCandidates: pool.candidates });
  const items = result.floors.flatMap(floor => floor.items);
  const anchorLine = items.find(value => value.text.includes('蓝铜账本') && value.kind === 'commitment')?.storylineId;
  assert.ok(anchorLine);
  assert.equal(items.some(value => value.storylineId === anchorLine && value.text === '蓝铜账本红蜡封条'), true, 'B 与原锚 A 有证据，应进入 A 线');
  assert.equal(items.some(value => value.storylineId === anchorLine && value.text === '红蜡封条暗门'), false, 'C 只与同楼 B 相关，不能借 B 二跳进入 A 线');
});

test('CSE 与历史同楼仍须有真实主题证据，看向不同对象不误并，查询点名的短强词可关联', () => {
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  memories[0] = recallMemory(1, {
    participants: [{ entityId: PERSON, presence: 'present' }],
    observations: [{ subjectEntityId: PERSON, description: '看向窗外' }],
  });
  const lookChange = {
    deltaId: 'delta-look', floorId: 'floor-1', assistantSeq: 1, subjectEntityId: PERSON, layer: 'situational', action: 'add', before: null,
    after: recallState('state-look', '看向门口', 1, { sourceFloorId: 'floor-1', sourceDeltaId: 'delta-look' }),
  };
  const lookSource = selectorSource({ memories }); lookSource.cseChanges = [lookChange];
  const lookQuery = { text: '裴晚生看向哪里', latestUserText: '裴晚生看向哪里', messageCount: 1 };
  const lookHistory = buildRecallHistoryCandidatePool({ source: lookSource, queryContext: lookQuery }).candidates.find(value => value.value.kind === 'observation');
  const lookCse = buildRecallCseCandidatePool({ source: lookSource, queryContext: lookQuery }).candidates.find(value => value.source === 'change');
  const lookResult = selectRecall({ source: lookSource, queryContext: lookQuery, selectedHistoryCandidates: [lookHistory], selectedCseCandidates: [lookCse] });
  const historyLine = lookResult.floors.flatMap(value => value.items).find(value => value.kind === 'observation')?.storylineId;
  const changeLine = lookResult.cseChanges.find(value => value.deltaId === 'delta-look')?.storylineId;
  assert.ok(historyLine && changeLine && historyLine !== changeLine, '同楼和同人物不能把不同注视对象拼成一条线');

  const outageMemories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  outageMemories[0] = recallMemory(1, { participants: [{ entityId: PERSON, presence: 'present' }], observations: [{ subjectEntityId: PERSON, description: '走廊断电' }] });
  const outageChange = {
    deltaId: 'delta-outage', floorId: 'floor-2', assistantSeq: 2, subjectEntityId: PERSON, layer: 'situational', action: 'add', before: null,
    after: recallState('state-outage', '查明断电', 2, { sourceFloorId: 'floor-2', sourceDeltaId: 'delta-outage' }),
  };
  const outageSource = selectorSource({ memories: outageMemories }); outageSource.cseChanges = [outageChange];
  const outageQuery = { text: '断电', latestUserText: '断电', messageCount: 1 };
  const outageHistory = buildRecallHistoryCandidatePool({ source: outageSource, queryContext: outageQuery }).candidates.find(value => value.value.kind === 'observation');
  const outageCse = buildRecallCseCandidatePool({ source: outageSource, queryContext: outageQuery }).candidates.find(value => value.source === 'change');
  const outageResult = selectRecall({ source: outageSource, queryContext: outageQuery, selectedHistoryCandidates: [outageHistory], selectedCseCandidates: [outageCse] });
  assert.equal(outageResult.floors[0].items[0].storylineId, outageResult.cseChanges[0].storylineId, '查询点名的具体短词仍可连接历史与变化');
});

test('超过八个同主题节点时每线保留最早与最新端点，并把协议标题限制在签名上限内', () => {
  const longToken = `ALPHA_${'9'.repeat(700)}`;
  const memories = Array.from({ length: 14 }, (_, index) => recallMemory(index + 1, {
    summary: index >= 10 ? `近期接续 ${index + 1}` : '',
    participants: [{ entityId: PERSON, presence: 'present' }],
    events: index < 10 ? [{ title: `蓝铜账本节点 ${index + 1}`, description: `蓝铜账本推进 ${index + 1}`, candidateStatus: 'accepted' }] : [],
  }));
  memories[4].events.push({ title: longToken, description: `蓝铜账本 ${longToken}`, candidateStatus: 'accepted' });
  const source = selectorSource({ memories });
  const queryContext = { text: `蓝铜账本 ${longToken}`, latestUserText: `蓝铜账本 ${longToken}`, messageCount: 1 };
  const pool = buildRecallHistoryCandidatePool({ source, queryContext });
  const selectedHistoryCandidates = pool.candidates.filter(value => value.value.kind === 'event');
  const result = selectRecall({ source, queryContext, contextSize: 12000, selectedHistoryCandidates });
  const distantByLine = new Map();
  for (const floor of result.floors) for (const value of floor.items.filter(itemValue => itemValue.recallSection === 'distant')) {
    distantByLine.set(value.storylineId, [...(distantByLine.get(value.storylineId) ?? []), floor.assistantSeq]);
  }
  const endpointLine = [...distantByLine.values()].find(values => values.includes(1) && values.includes(10));
  assert.ok(endpointLine, '同一长线必须同时保留最早与最新节点');
  assert.ok(endpointLine.length <= 8, '单线仍受八节点上限约束');
  assert.ok(result.storylines.every(value => value.title.length <= 160 && value.basis.length <= 500));
});

test('关联锚点按相关度与材料类别有界轮取，直接保留材料不被补结摘要挤出', () => {
  const memories = Array.from({ length: 18 }, (_, index) => recallMemory(index + 1, { summary: index >= 14 ? `近期接续 ${index + 1}` : `概括材料 ${index + 1}` }));
  memories[1] = recallMemory(2, {
    summary: '钟楼的墙面刚粉刷过。', participants: [{ entityId: PERSON, presence: 'present' }],
    commitments: [{ speakerEntityId: PERSON, targetEntityIds: [], kind: 'promise', content: '带蓝色印章去钟楼会合', status: 'made', exactAnchorId: null }],
  });
  memories[12] = recallMemory(13, {
    summary: '钟楼附近没有其他人。', participants: [{ entityId: PERSON, presence: 'present' }],
    events: [{ title: '印章到达', description: '蓝色印章被带到钟楼', candidateStatus: 'accepted' }],
  });
  const source = selectorSource({ memories });
  const queryContext = { text: '钟楼蓝色印章', latestUserText: '钟楼蓝色印章', messageCount: 1 };
  const pool = buildRecallHistoryCandidatePool({ source, queryContext });
  const anchor = pool.candidates.find(value => value.value.floorId === 'floor-2' && value.value.kind === 'commitment');
  const direct = pool.candidates.find(value => value.value.floorId === 'floor-13' && value.value.kind === 'event');
  assert.ok(anchor && direct);
  const result = selectRecall({ source, queryContext, contextSize: 1000, maxFloors: 6, selectedHistoryCandidates: [direct, anchor] });
  assert.equal(result.floors.some(value => value.assistantSeq === 13), true, '直接保留的材料应优先进入预算');
  assert.equal(result.floors.some(value => value.assistantSeq === 2), true, '未结/承诺类也应能成为锚点');
});

test('近期与少量高相关直接锚点之后优先补关联，48条直接保留不会使池外补结形同未用', () => {
  const memories = Array.from({ length: 55 }, (_, index) => recallMemory(index + 1, {
    summary: index >= 51 ? `近期接续 ${index + 1}` : '',
    participants: [{ entityId: PERSON, presence: 'present' }],
    events: index > 0 && index < 51 ? [{ title: `港口背景 ${index + 1}`, description: `港口环境记录 ${index + 1}`, candidateStatus: 'accepted' }] : [],
  }));
  memories[0] = recallMemory(1, { participants: [{ entityId: PERSON, presence: 'present' }], observations: [{ subjectEntityId: PERSON, description: '蓝铜账本封存' }] });
  memories[49] = recallMemory(50, { participants: [{ entityId: PERSON, presence: 'present' }], events: [{ title: '港口交接', description: '港口交接时携带蓝铜账本', candidateStatus: 'accepted' }] });
  const source = selectorSource({ memories });
  const queryContext = { text: '港口交接', latestUserText: '港口交接', messageCount: 1 };
  const pool = buildRecallHistoryCandidatePool({ source, queryContext });
  assert.equal(pool.candidates.length, 48);
  assert.equal(pool.candidates.some(value => value.value.floorId === 'floor-1'), false, '只有关联主题、不直接命中当前查询的旧事不在48候选内');
  const result = selectRecall({ source, queryContext, contextSize: 50000, selectedHistoryCandidates: pool.candidates });
  assert.equal(result.floors.some(value => value.assistantSeq === 1), true);
  assert.ok(result.stages.linkedHistoryItemCount >= 1);
  assert.ok(result.floors.flatMap(value => value.items).length <= 48);
});

test('state/source 明确链补来源摘要，并能带入未被查询点名配角的历史 delta', () => {
  const other = '99999999-7777-4777-8777-777777777777';
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1, { summary: index >= 4 ? `近期接续 ${index + 1}` : '' }));
  memories[1] = recallMemory(2, { summary: '配角在旧仓交出蓝铜账本。', participants: [{ entityId: other, presence: 'present' }] });
  const linkedState = recallState('linked-current', '仍记得旧仓交接', 2, { sourceFloorId: 'floor-2', sourceDeltaId: 'delta-2' });
  const linkedChange = {
    deltaId: 'delta-2', floorId: 'floor-2', assistantSeq: 2, subjectEntityId: other, layer: 'adaptive', action: 'add', before: null,
    after: recallState('linked-other', '因交出账本而保持警惕', 2, { sourceFloorId: 'floor-2', sourceDeltaId: 'delta-2' }),
  };
  const source = selectorSource({ memories, currentState: [{ subjectEntityId: PERSON, core: [linkedState], adaptive: [], situational: [] }] });
  source.cseChanges = [linkedChange];
  const queryContext = { text: '仍记得旧仓交接', latestUserText: '仍记得旧仓交接', messageCount: 1 };
  const csePool = buildRecallCseCandidatePool({ source, queryContext });
  const current = csePool.candidates.find(value => value.source === 'current');
  const stateLinked = selectRecall({ source, queryContext, selectedHistoryCandidates: [], selectedCseCandidates: [current] });
  assert.match(stateLinked.injectionText, /来源关联：配角在旧仓交出蓝铜账本/);

  const historyPool = buildRecallHistoryCandidatePool({ source, queryContext: { text: '蓝铜账本', latestUserText: '蓝铜账本', messageCount: 1 } });
  const history = historyPool.candidates.find(value => value.value.floorId === 'floor-2');
  const deltaLinked = selectRecall({ source, queryContext: { text: '蓝铜账本', latestUserText: '蓝铜账本', messageCount: 1 }, selectedHistoryCandidates: [history], selectedCseCandidates: [] });
  assert.equal(deltaLinked.cseChanges.some(value => value.subjectEntityId === other && value.assistantSeq === 2), true);
  assert.equal(deltaLinked.stages.linkedCseChangeCount, 1);
});

test('近期摘要与同源 CSE 完全重复时合并，CSE 独有事实仍保留', () => {
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1, { summary: index === 7 ? '已经归还蓝铜账本。' : '' }));
  const repeated = { deltaId: 'delta-repeat', floorId: 'floor-8', assistantSeq: 8, subjectEntityId: PERSON, layer: 'situational', action: 'add', before: null, after: recallState('repeat', '已经归还蓝铜账本', 8, { sourceFloorId: 'floor-8', sourceDeltaId: 'delta-repeat' }) };
  const unique = { deltaId: 'delta-unique', floorId: 'floor-8', assistantSeq: 8, subjectEntityId: PERSON, layer: 'adaptive', action: 'add', before: null, after: recallState('unique', '仍担心律师追问账本来源', 8, { sourceFloorId: 'floor-8', sourceDeltaId: 'delta-unique' }) };
  const source = selectorSource({ memories }); source.cseChanges = [repeated, unique];
  const queryContext = { text: '蓝铜账本律师', latestUserText: '蓝铜账本律师', messageCount: 1 };
  const pool = buildRecallCseCandidatePool({ source, queryContext });
  const result = selectRecall({ source, queryContext, selectedHistoryCandidates: [], selectedCseCandidates: pool.candidates });
  assert.equal(result.cseChanges.some(value => value.deltaId === 'delta-repeat'), false);
  assert.equal(result.cseChanges.some(value => value.deltaId === 'delta-unique'), true);
  assert.equal(result.stages.semanticDuplicateCount, 1);
});

function runtimeFixture() {
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1, { summary: index >= 4 ? `近期连续 ${index + 1}` : '' }));
  memories[1] = recallMemory(2, {
    summary: '裴晚生曾在钟楼留下约定。',
    participants: [{ entityId: PERSON, presence: 'present' }],
    commitments: [{ speakerEntityId: PERSON, targetEntityIds: [], kind: 'promise', content: '在钟楼等到天亮', status: 'made', exactAnchorId: null }],
  });
  return selectorSource({ memories });
}

async function runtimeSourceWithBodyRef(text = '街上已经安静。', locator = { messageIndex: 0, swipeId: null, selectedSwipeIndex: null }) {
  const source = runtimeFixture();
  source.bodyMatchRefs = [{
    floorId: 'floor-2', floorMemoryId: 'memory-2', assistantSeq: 2, hostLocator: locator,
    rawFingerprint: await fingerprintText(text), canonicalFingerprint: await fingerprintText(text),
  }];
  return source;
}

function rawReachableFromSource(source) {
  const bodyRefByFloor = new Map((source.bodyMatchRefs ?? []).map(ref => [ref.floorId, ref]));
  return {
    status: 'ready', rootRevision: source.rootRevision,
    root: { chatId: source.chatId, narrativeGeneration: source.narrativeGeneration, headCheckpointId: source.headCheckpointId },
    checkpoint: { id: source.headCheckpointId }, baseline: null,
    floors: source.floorMemories.map(memory => {
      const bodyRef = bodyRefByFloor.get(memory.floorId);
      return {
        id: memory.floorId, assistantSeq: memory.assistantSeq,
        ...(bodyRef ? {
          hostLocator: structuredClone(bodyRef.hostLocator),
          content: { rawFingerprint: bodyRef.rawFingerprint, canonicalFingerprint: bodyRef.canonicalFingerprint },
        } : {}),
      };
    }),
    floorMemories: source.floorMemories.map(memory => ({
      id: memory.floorMemoryId, floorId: memory.floorId, recordStatus: 'active',
      summary: { effectiveSource: 'ai', aiText: memory.summary },
      participants: memory.participants, locations: memory.locations, commitments: memory.commitments,
      openLoops: memory.openLoops, exactAnchors: memory.exactAnchors, eventFragments: memory.events,
      actions: memory.actions, observations: memory.observations, privateCognition: memory.privateCognition,
      informationTransfers: memory.informationTransfers,
    })),
    entities: source.entities.map(entity => ({ id: entity.entityId, entityType: entity.entityType, displayName: entity.displayName, aliases: entity.aliases.map(name => ({ name })), specialRole: entity.specialRole, recordStatus: 'active', status: 'established' })),
    stateDeltas: [], currentStates: [],
  };
}

async function singleFloorReachable({ text = '街上已经安静。', summary = '裴晚生曾在钟楼留下约定。', revision = 1, head = 'head-one', withMemory = true } = {}) {
  const rawFingerprint = await fingerprintText(text);
  const floor = {
    id: 'floor-one', assistantSeq: 1,
    hostLocator: { messageIndex: 0, swipeId: null, selectedSwipeIndex: null },
    content: { rawFingerprint, canonicalFingerprint: rawFingerprint },
  };
  return {
    status: 'ready', rootRevision: revision,
    root: { chatId: CHAT, narrativeGeneration: GEN, headCheckpointId: head },
    checkpoint: { id: head }, baseline: null, floors: [floor], entities: [], stateDeltas: [], currentStates: [],
    floorMemories: withMemory ? [{
      id: 'memory-one', floorId: floor.id, recordStatus: 'active',
      summary: { effectiveSource: 'ai', aiText: summary }, ...emptyMemory,
    }] : [],
  };
}

function cseLaggingReachable(removeDeltaId = 'delta-remove') {
  const floors = [1, 2, 3].map(assistantSeq => ({ id: `cse-floor-${assistantSeq}`, assistantSeq }));
  const floorMemories = floors.map(floor => ({
    id: `cse-memory-${floor.assistantSeq}`, floorId: floor.id, recordStatus: 'active',
    summary: { effectiveSource: 'ai', aiText: `钟楼赴约进展 ${floor.assistantSeq}` }, ...emptyMemory,
  }));
  const longReason = '当时的私密证据'.repeat(180);
  const privateState = { id: 'cse-state-private', text: '仍在钟楼等待赴约', visibility: 'private', reason: longReason, origin: 'floor', towardEntityId: null, sourceFloorId: floors[0].id, sourceDeltaId: 'delta-add' };
  const stateDeltas = [
    { id: 'delta-add', floorId: floors[0].id, floorMemoryId: floorMemories[0].id, recordStatus: 'active', subjectSnapshots: [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: [privateState] }], fixedChanges: [{ subjectEntityId: PERSON, items: [{ category: 'situational', action: 'add', before: null, after: privateState }] }] },
    { id: removeDeltaId, floorId: floors[1].id, floorMemoryId: floorMemories[1].id, recordStatus: 'active', subjectSnapshots: [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: [] }], fixedChanges: [{ subjectEntityId: PERSON, items: [{ category: 'situational', action: 'remove', before: privateState, after: null }] }] },
  ];
  return {
    status: 'ready', rootRevision: 7,
    root: { chatId: CHAT, narrativeGeneration: GEN, headCheckpointId: 'cse-head' }, checkpoint: { id: 'cse-head' }, baseline: null,
    floors, floorMemories, stateDeltas, currentStates: [],
    entities: [{ id: PERSON, entityType: 'person', displayName: '裴晚生', aliases: [{ name: '阿裴' }], specialRole: 'char', recordStatus: 'active', status: 'established' }],
  };
}

function createRuntimeHarness({ sourceReader, selector = selectRecall, useDefaultSelector = false, generateUtilityTask, queryBuilder = buildRecallQueryContext, saveChat = true, reachableReader, rootReader, prepareMemory, preparationTimeoutMs, snapshotHook, fingerprint, memoryStatus, realtimeOrigin, notifyUser, identityProjectionProvider, pluginVersion = TEST_PLUGIN_VERSION, prequel = null } = {}) {
  const prompts = [];
  const handlers = new Map();
  const userMessage = { is_user: true, is_system: false, mes: '阿裴，我们回钟楼赴约。' };
  const chat = [{ is_user: false, is_system: false, mes: '街上已经安静。' }, userMessage];
  const context = {
    ...(prequel !== null ? { chatId: 'host-chat-a' } : {}),
    chatMetadata: { qianqianjie: { chatId: CHAT }, ...(prequel !== null ? { qianqianjiePrequel: prequel } : {}) },
    constants: { promptTypes: { IN_CHAT: 23 }, promptRoles: { SYSTEM: 47 } },
    setExtensionPrompt(...args) { prompts.push(args); },
  };
  let saves = 0;
  if (saveChat) context.saveChat = async () => { saves += 1; if (typeof saveChat === 'function') await saveChat({ chat, userMessage, handlers }); };
  const source = runtimeFixture();
  let snapshots = 0;
  const contextWrappers = [];
  let currentSnapshotHook = snapshotHook;
  const hostAdapter = {
    snapshot: () => { const wrapper = { ...context, chat }; contextWrappers.push(wrapper); const value = { context: wrapper, chat }; snapshots += 1; currentSnapshotHook?.({ count: snapshots, value, chat, userMessage, handlers }); return value; },
  };
  const runtime = createV3RecallRuntime({
    store: {
      readReachable: reachableReader ?? (async () => rawReachableFromSource(source)),
      ...(rootReader ? { readRoot: rootReader } : {}),
    },
    hostAdapter,
    sourceReader: sourceReader ?? (async () => structuredClone(source)),
    ...(useDefaultSelector ? {} : { selector }),
    ...(generateUtilityTask ? { generateUtilityTask } : {}),
    queryBuilder,
    ...(memoryStatus ? { memoryStatus } : {}),
    ...(realtimeOrigin ? { realtimeOrigin } : {}),
    ...(notifyUser ? { notifyUser } : {}),
    ...(identityProjectionProvider ? { identityProjectionProvider } : {}),
    ...(prepareMemory ? { prepareMemory } : {}),
    ...(preparationTimeoutMs ? { preparationTimeoutMs } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    pluginVersion,
    now: () => new Date(NOW),
    logger: { warn() {} },
  });
  runtime.bind({
    eventSource: { on(event, handler) { handlers.set(event, handler); } },
    eventTypes: {
      GENERATION_STARTED: 'generation-started', GENERATION_STOPPED: 'generation-stopped', GENERATION_ENDED: 'generation-ended',
      CHAT_CHANGED: 'chat-changed', MESSAGE_EDITED: 'message-edited', MESSAGE_DELETED: 'message-deleted', MESSAGE_SWIPED: 'message-swiped', MESSAGE_SWIPE_DELETED: 'message-swipe-deleted',
    },
  });
  return { runtime, prompts, handlers, userMessage, chat, context, source, contextWrappers, setSnapshotHook(value) { currentSnapshotHook = value; }, get saves() { return saves; }, get snapshots() { return snapshots; } };
}

const latestPromptValue = (prompts, slot) => prompts.filter(call => call[0] === slot).at(-1)?.[1];

test('ready runtime 将实际前情预算传给 LLM selector，双槽合计不超过原总预算且 stop/disable 同步清理', async () => {
  let selectorInput = null;
  const prequel = `${'钟楼蓝铜钥匙的旧事。'.repeat(300)}最后仍约定在钟楼见面。`;
  const harness = createRuntimeHarness({
    prequel,
    selector: async input => {
      selectorInput = input;
      return selectRecallWithLlm({
        ...input,
        generateUtilityTask: async () => ({ jsonData: { history_exclude_keys: [], state_exclude_keys: [] }, taskMetadata: { finishReason: 'stop' } }),
      });
    },
  });
  let state = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(state.lastRecall.status, 'ready');
  assert.equal(state.lastPrequel.status, 'ready');
  assert.ok(latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT));
  assert.ok(latestPromptValue(harness.prompts, PREQUEL_PROMPT_SLOT));
  assert.equal(selectorInput.reservedCharacters, state.lastPrequel.estimatedCharacters);
  assert.equal(selectorInput.reservedTokens, state.lastPrequel.estimatedTokens);
  const budget = recallBudget(12000);
  assert.ok(state.lastRecall.injectionText.length + state.lastPrequel.estimatedCharacters <= budget.totalCharacters);
  assert.ok(estimateRecallTokens(state.lastRecall.injectionText) + state.lastPrequel.estimatedTokens <= budget.totalTokens);
  assert.equal(state.lastRecall.stages.ordinaryEstimatedTokenBudget, budget.totalTokens - state.lastPrequel.estimatedTokens);
  assert.ok(state.lastRecall.stages.estimatedTokenBudget >= state.lastRecall.stages.ordinaryEstimatedTokenBudget);

  harness.handlers.get('generation-stopped')();
  assert.equal(latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT), '');
  assert.equal(latestPromptValue(harness.prompts, PREQUEL_PROMPT_SLOT), '');

  await harness.runtime.setEnabled(true);
  state = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(state.lastRecall.status, 'ready');
  assert.ok(latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT));
  assert.ok(latestPromptValue(harness.prompts, PREQUEL_PROMPT_SLOT));
  await harness.runtime.setEnabled(false);
  assert.equal(latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT), '');
  assert.equal(latestPromptValue(harness.prompts, PREQUEL_PROMPT_SLOT), '');
});

test('普通槽已写入后的持续封签异常重试一次后清空双槽并停止正文', async () => {
  let harness;
  let abortCalls = 0;
  const fingerprint = async value => {
    if (harness?.prompts.some(call => call[0] === RECALL_PROMPT_SLOT && call[1])) throw Object.assign(new Error('模拟封签失败'), { code: 'TEST_RECEIPT_SEAL_FAILED' });
    return fingerprintText(value);
  };
  harness = createRuntimeHarness({ prequel: '裴晚生曾把蓝铜钥匙藏在钟楼。', fingerprint });
  const state = await harness.runtime.intercept(harness.chat, 12000, value => { if (value === true) abortCalls += 1; }, 'normal');
  assert.ok(harness.prompts.some(call => call[0] === RECALL_PROMPT_SLOT && call[1]), '异常必须发生在普通槽实际写入以后');
  assert.equal(state.lastRecall.status, 'error');
  assert.equal(state.lastRecall.injectionText, '');
  assert.equal(state.lastRecall.stages, null);
  assert.equal(state.lastPrequel, null);
  assert.equal(abortCalls, 1);
  assert.equal(latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT), '');
  assert.equal(latestPromptValue(harness.prompts, PREQUEL_PROMPT_SLOT), '');
});

test('普通 prompt 首次写入抛错会清槽并重试成功，不停止正文', async () => {
  const notifications = [];
  const harness = createRuntimeHarness({ notifyUser: value => notifications.push(value) });
  let failed = false, abortCalls = 0;
  harness.context.setExtensionPrompt = (...args) => {
    harness.prompts.push(args);
    if (args[0] === RECALL_PROMPT_SLOT && args[1] && !failed) {
      failed = true;
      throw Object.assign(new Error('模拟普通召回注入失败'), { code: 'TEST_RECALL_PROMPT_FAILED' });
    }
  };
  const state = await harness.runtime.intercept(harness.chat, 12000, value => { if (value === true) abortCalls += 1; }, 'normal');
  assert.equal(failed, true);
  assert.equal(state.lastRecall.status, 'ready');
  assert.equal(abortCalls, 0);
  assert.equal(latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT), state.lastRecall.injectionText);
  assert.deepEqual(notifications, [{ kind: 'warning', text: '记忆召回未完成，正在重试一次。' }]);
});

test('前情 prompt 持续写入失败时两轮都清空普通与前情槽并停止正文', async () => {
  let selectorCalls = 0, abortCalls = 0;
  const harness = createRuntimeHarness({
    prequel: '裴晚生曾把蓝铜钥匙藏在钟楼。',
    selector: input => { selectorCalls += 1; return selectRecall(input); },
  });
  harness.context.setExtensionPrompt = (...args) => {
    harness.prompts.push(args);
    if (args[0] === PREQUEL_PROMPT_SLOT && args[1]) throw Object.assign(new Error('模拟前情注入失败'), { code: 'TEST_PREQUEL_PROMPT_FAILED' });
  };
  const result = await harness.runtime.intercept(harness.chat, 12000, value => { if (value === true) abortCalls += 1; }, 'normal');
  assert.equal(selectorCalls, 2);
  assert.equal(abortCalls, 1);
  assert.equal(result.lastRecall.status, 'error');
  assert.equal(result.lastPrequel, null);
  assert.equal(latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT), '');
  assert.equal(latestPromptValue(harness.prompts, PREQUEL_PROMPT_SLOT), '');
});

test('coreChat clone 只控制严格正文去重；无宿主可见性投影时不得猜测排除摘要', async () => {
  const uniqueSource = await runtimeSourceWithBodyRef();
  let uniqueMatch = null;
  const unique = createRuntimeHarness({ sourceReader: async () => structuredClone(uniqueSource), reachableReader: async () => rawReachableFromSource(uniqueSource), selector: input => { uniqueMatch = input.source.bodyMatch; return selectRecall(input); } });
  const uniqueResult = await unique.runtime.intercept(structuredClone(unique.chat), 12000, null, 'normal');
  assert.deepEqual(uniqueMatch.coveredFloorIds, ['floor-2']);
  assert.doesNotMatch(uniqueResult.lastRecall.injectionText, /钟楼留下约定|钟楼等到天亮/);

  const hiddenSource = await runtimeSourceWithBodyRef();
  let hiddenMatch = null;
  const hidden = createRuntimeHarness({ sourceReader: async () => structuredClone(hiddenSource), reachableReader: async () => rawReachableFromSource(hiddenSource), selector: input => { hiddenMatch = input.source.bodyMatch; return selectRecall(input); } });
  const hiddenCore = structuredClone(hidden.chat); hiddenCore[0].is_system = true;
  const hiddenResult = await hidden.runtime.intercept(hiddenCore, 12000, null, 'normal');
  assert.deepEqual(hiddenMatch.coveredFloorIds, []);
  assert.match(hiddenResult.lastRecall.injectionText, /钟楼/, 'synthetic source 没有宿主可见性证明时不得只凭 core 隐藏猜测排除');

  const duplicateSource = await runtimeSourceWithBodyRef();
  let duplicateMatch = null;
  const duplicate = createRuntimeHarness({ sourceReader: async () => structuredClone(duplicateSource), reachableReader: async () => rawReachableFromSource(duplicateSource), selector: input => { duplicateMatch = input.source.bodyMatch; return selectRecall(input); } });
  duplicate.chat.splice(1, 0, { is_user: false, is_system: false, mes: '街上已经安静。' });
  const duplicateResult = await duplicate.runtime.intercept([structuredClone(duplicate.chat[1]), duplicate.userMessage], 12000, null, 'normal');
  assert.deepEqual(duplicateMatch.coveredFloorIds, [], 'clone 新未提取 AI 与旧楼同文时不得猜成旧楼');
  assert.match(duplicateResult.lastRecall.injectionText, /钟楼/);

  const swipeSource = await runtimeSourceWithBodyRef('街上已经安静。', { messageIndex: 0, swipeId: 0, selectedSwipeIndex: 0 });
  let swipeMatch = null;
  const swipe = createRuntimeHarness({ sourceReader: async () => structuredClone(swipeSource), reachableReader: async () => rawReachableFromSource(swipeSource), selector: input => { swipeMatch = input.source.bodyMatch; return selectRecall(input); } });
  swipe.chat[0] = { ...swipe.chat[0], swipes: ['街上已经安静。'], swipe_id: 0 };
  const regexCore = structuredClone(swipe.chat); regexCore[0].mes = '街上安静。';
  const swipeResult = await swipe.runtime.intercept(regexCore, 12000, null, 'normal');
  assert.deepEqual(swipeMatch.coveredFloorIds, [], 'core mes 已被改写时不得被残留 swipes 冒充完整正文');
  assert.match(swipeResult.lastRecall.injectionText, /钟楼/);

  const wrappedText = '街上已经安静。<!--宿主包装-->';
  const wrappedSource = await runtimeSourceWithBodyRef(wrappedText);
  wrappedSource.bodyMatchRefs[0].canonicalFingerprint = await fingerprintText('街上已经安静。');
  let wrappedMatch = null, wrappedSelectorCalls = 0;
  const wrapped = createRuntimeHarness({ sourceReader: async () => structuredClone(wrappedSource), reachableReader: async () => rawReachableFromSource(wrappedSource), selector: input => { wrappedSelectorCalls += 1; wrappedMatch = input.source.bodyMatch; return selectRecall(input); } });
  wrapped.chat[0].mes = wrappedText;
  const cleanedCore = structuredClone(wrapped.chat); cleanedCore[0].mes = '街上已经安静。';
  const wrappedResult = await wrapped.runtime.intercept(cleanedCore, 12000, null, 'normal');
  assert.deepEqual(wrappedMatch.coveredFloorIds, [], 'canonical 相同但 raw 已处理时仍不得省掉已保存摘要');
  assert.deepEqual(wrappedMatch.visibleFloorIds, [], 'synthetic source 不得凭 core 正文反推出宿主可见集合');
  assert.match(wrappedResult.lastRecall.injectionText, /钟楼/);
  await wrapped.runtime.intercept([structuredClone(wrapped.userMessage)], 12000, null, 'regenerate');
  assert.equal(wrappedSelectorCalls, 2, '查询上下文变化仍应重选，不能借 synthetic source 猜宿主可见性');
});

test('严格 core 去重集合变化会使当前回执失效', async () => {
  const source = await runtimeSourceWithBodyRef();
  let selectorCalls = 0;
  const harness = createRuntimeHarness({ sourceReader: async () => structuredClone(source), reachableReader: async () => rawReachableFromSource(source), selector: input => { selectorCalls += 1; return selectRecall(input); } });
  await harness.runtime.intercept(structuredClone(harness.chat), 12000, null, 'normal');
  const first = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
  assert.equal(first.schemaVersion, 13);
  assert.equal(first.completionStatus, 'ready');
  await harness.runtime.intercept([structuredClone(harness.userMessage)], 12000, null, 'regenerate');
  const second = harness.userMessage.extra[RECALL_RECEIPT_KEY];
  assert.equal(selectorCalls, 2);
  assert.notEqual(second.bodyMatchFingerprint, first.bodyMatchFingerprint);
  assert.notEqual(second.receiptFingerprint, first.receiptFingerprint);
  assert.equal(second.completionStatus, 'ready');
});

test('选材后已由 core 覆盖的旧正文变化时，提交守卫拒绝注入与回执', async () => {
  const source = await runtimeSourceWithBodyRef();
  const harness = createRuntimeHarness({
    sourceReader: async () => structuredClone(source),
    reachableReader: async () => rawReachableFromSource(source),
    selector: input => {
      const selection = selectRecall(input);
      harness.chat[0].mes = '选材后旧正文已经变化。';
      return selection;
    },
  });
  harness.chat.splice(1, 0, { is_user: false, is_system: false, mes: '较新的可见正文，不属于旧楼见证。' });
  const result = await harness.runtime.intercept([
    { is_user: false, is_system: false, mes: '街上已经安静。' },
    structuredClone(harness.userMessage),
  ], 12000, null, 'normal');
  assert.equal(result.lastRecall.status, 'stale');
  assert.deepEqual(result.lastRecall.skipReasons, ['narrativeChanged']);
  assert.ok(harness.prompts.every(call => call[1] === ''));
  assert.equal(harness.userMessage.extra?.[RECALL_RECEIPT_KEY], undefined);
});

test('覆盖推导区分历史欠账与最近 3 个可见 AI 楼保护下的连续实时尾部', async () => {
  const chat = Array.from({ length: 5 }, (_, index) => ({ is_user: false, is_system: false, mes: `AI-${index + 1}`, swipes: [`AI-${index + 1}`], swipe_id: 0 }));
  const candidates = await scanAssistantCandidates(chat);
  const floors = candidates.slice(0, 4).map((candidate, index) => ({ id: `floor-${index + 1}`, assistantSeq: index + 1, hostLocator: candidate.hostLocator, content: { rawFingerprint: candidate.rawFingerprint, canonicalFingerprint: candidate.canonicalFingerprint } }));
  const memories = floors.slice(0, 3).map((floor, index) => ({ id: `memory-${index + 1}`, floorId: floor.id, recordStatus: 'active' }));
  const deltas = floors.slice(0, 3).map((floor, index) => ({ id: `delta-${index + 1}`, floorId: floor.id, floorMemoryId: memories[index].id, recordStatus: 'active', subjectSnapshots: [] }));
  const base = { root: { chatId: CHAT }, floors, floorMemories: memories, stateDeltas: deltas };
  const snapshot = { context: { chatMetadata: { qianqianjie: { chatId: CHAT } } }, chat };
  assert.equal((await assessMemoryCoverageFromHost({ reachable: base, snapshot })).status, 'realtimeTail');
  const partial = structuredClone(base); partial.floorMemories.push({ id: 'memory-4', floorId: 'floor-4', recordStatus: 'active' });
  assert.equal((await assessMemoryCoverageFromHost({ reachable: partial, snapshot })).status, 'historicalDebt');
  const branchReplay = { ...base, run: { mode: 'branchReplay', result: 'trustedPrefix:1' } };
  assert.equal((await assessMemoryCoverageFromHost({ reachable: branchReplay, snapshot })).status, 'historicalDebt');
  const hidden = structuredClone(snapshot); hidden.chat[3].is_system = true;
  assert.equal((await assessMemoryCoverageFromHost({ reachable: base, snapshot: hidden })).status, 'historicalDebt');
  const narratedChat = [...chat.slice(0, 4), { is_user: false, is_system: '', mes: '宿主旁白', extra: { type: 'narrator' } }, chat[4]];
  const narratedCandidates = await scanAssistantCandidates(narratedChat);
  const narratedFloors = narratedCandidates.slice(0, 4).map((candidate, index) => ({ id: `narrated-floor-${index + 1}`, assistantSeq: index + 1, hostLocator: candidate.hostLocator, content: { rawFingerprint: candidate.rawFingerprint, canonicalFingerprint: candidate.canonicalFingerprint } }));
  const narratedMemories = narratedFloors.slice(0, 2).map((floor, index) => ({ id: `narrated-memory-${index + 1}`, floorId: floor.id, recordStatus: 'active' }));
  const narratedDeltas = narratedFloors.slice(0, 2).map((floor, index) => ({ id: `narrated-delta-${index + 1}`, floorId: floor.id, floorMemoryId: narratedMemories[index].id, recordStatus: 'active', subjectSnapshots: [] }));
  const narrated = { root: { chatId: CHAT }, floors: narratedFloors, floorMemories: narratedMemories, stateDeltas: narratedDeltas };
  const narratedSnapshot = { ...snapshot, chat: narratedChat };
  assert.equal((await assessMemoryCoverageFromHost({ reachable: narrated, snapshot: narratedSnapshot })).status, 'realtimeTail', 'narrator 不占最近 3 条可见 AI 窗口');
  assert.equal((await assessMemoryCoverageFromHost({ reachable: { ...base, floorMemories: [], stateDeltas: [] }, snapshot })).status, 'historicalDebt');
  const empty = { ...base, floors: floors.slice(0, 1), floorMemories: [], stateDeltas: [] };
  const oneStable = { ...snapshot, chat: chat.slice(0, 2) };
  assert.equal((await assessMemoryCoverageFromHost({ reachable: empty, snapshot: oneStable })).status, 'historicalDebt');
  assert.equal((await assessMemoryCoverageFromHost({ reachable: empty, snapshot: oneStable, realtimeOrigin: true })).status, 'realtimeTail');

  const longChat = Array.from({ length: 6 }, (_, index) => ({ is_user: false, is_system: false, mes: `长尾-${index + 1}`, swipes: [`长尾-${index + 1}`], swipe_id: 0 }));
  const longCandidates = await scanAssistantCandidates(longChat);
  const longFloors = longCandidates.slice(0, 5).map((candidate, index) => ({ id: `long-floor-${index + 1}`, assistantSeq: index + 1, hostLocator: candidate.hostLocator, content: { rawFingerprint: candidate.rawFingerprint, canonicalFingerprint: candidate.canonicalFingerprint } }));
  const longMemory = { id: 'long-memory-1', floorId: longFloors[0].id, recordStatus: 'active' };
  const longDelta = { id: 'long-delta-1', floorId: longFloors[0].id, floorMemoryId: longMemory.id, recordStatus: 'active', subjectSnapshots: [] };
  const longSnapshot = { context: { chatMetadata: { qianqianjie: { chatId: CHAT } } }, chat: longChat };
  const longTail = { root: { chatId: CHAT }, floors: longFloors, floorMemories: [longMemory], stateDeltas: [longDelta] };
  const longCoverage = await assessMemoryCoverageFromHost({ reachable: longTail, snapshot: longSnapshot });
  assert.equal(longCoverage.status, 'historicalDebt', '人物状态整体覆盖仍保留既有最近窗口规则');
  assert.equal(longCoverage.summaryStatus, 'realtimeTail', '有效摘要前缀后的连续纯尾欠账不受最近 3 楼限制');
  const middleGap = structuredClone(longTail);
  middleGap.floorMemories.push({ id: 'long-memory-3', floorId: longFloors[2].id, recordStatus: 'active' });
  assert.equal((await assessMemoryCoverageFromHost({ reachable: middleGap, snapshot: longSnapshot })).summaryStatus, 'historicalDebt', '中间断档仍需历史授权');
  assert.equal((await assessMemoryCoverageFromHost({ reachable: { ...longTail, run: { mode: 'branchReplay' } }, snapshot: longSnapshot })).summaryStatus, 'historicalDebt', 'branchReplay 不自动补历史摘要');
});

test('已注册多可见缺口不依赖三条 core 见证，pending 后已有摘要不误拦且隐藏历史仍可召回', async () => {
  const aiMessages = Array.from({ length: 6 }, (_, index) => ({
    is_user: false, is_system: false, mes: `宿主可见正文 ${index + 1}`, swipes: [`宿主可见正文 ${index + 1}`], swipe_id: 0,
    ...(index === 0 || index === 5 ? { is_hidden: true } : {}),
  }));
  const candidates = await scanAssistantCandidates(aiMessages, { chatId: CHAT });
  const floors = candidates.map((candidate, index) => ({
    id: `visible-floor-${index + 1}`, assistantSeq: index + 1, hostLocator: candidate.hostLocator,
    content: { rawFingerprint: candidate.rawFingerprint, canonicalFingerprint: candidate.canonicalFingerprint, canonicalContent: candidate.canonicalContent },
  }));
  const memories = [0, 5].map(index => ({
    id: `visible-memory-${index + 1}`, floorId: floors[index].id, recordStatus: 'active',
    summary: { effectiveSource: 'ai', aiText: `钟楼隐藏历史摘要 ${index + 1}` }, ...emptyMemory,
  }));
  const raw = {
    status: 'ready', rootRevision: 1,
    root: { chatId: CHAT, narrativeGeneration: GEN, headCheckpointId: 'visible-head' }, checkpoint: { id: 'visible-head' }, baseline: null,
    floors, floorMemories: memories, entities: [], stateDeltas: [], currentStates: [],
  };
  let projected = null, selectorCalls = 0, aborted = false;
  const harness = createRuntimeHarness({
    sourceReader: options => readRecallSource(options),
    reachableReader: async () => structuredClone(raw),
    selector: input => { selectorCalls += 1; projected = input.source; return selectRecall(input); },
  });
  harness.chat.splice(0, harness.chat.length, ...aiMessages, { ...harness.userMessage, mes: '钟楼历史如何衔接？' });
  const result = await harness.runtime.intercept([{ ...harness.userMessage, mes: '钟楼历史如何衔接？' }], 12000, value => { aborted = value === true; }, 'normal');
  assert.equal(selectorCalls, 1);
  assert.equal(aborted, false);
  assert.deepEqual(projected.readiness.summaryPendingFloorIds, floors.slice(1, 5).map(floor => floor.id), '摘要待办只包含真实缺失楼，不让中间缺口连坐后楼');
  assert.deepEqual(projected.readiness.summaryMissingFloorIds, floors.slice(1, 5).map(floor => floor.id), '已有摘要的第6楼不得被前缀pending误算为实际缺失');
  assert.deepEqual(projected.bodyMatch.visibleFloorIds, floors.slice(1, 5).map(floor => floor.id), '四个可见缺口不受core三条见证限制');
  assert.match(result.lastRecall.injectionText, /钟楼隐藏历史摘要 1|钟楼隐藏历史摘要 6/);
  assert.doesNotMatch(result.lastRecall.injectionText, /宿主可见正文/);
});

test('宿主楼从可见变隐藏后进入召回池，再次可见时旧 v3 回执不得复用', async () => {
  const raw = await singleFloorReachable({ text: '街上已经安静。', summary: '裴晚生曾在钟楼留下约定。' });
  let selectorCalls = 0;
  const harness = createRuntimeHarness({
    sourceReader: options => readRecallSource(options),
    reachableReader: async () => structuredClone(raw),
    selector: input => { selectorCalls += 1; return selectRecall(input); },
  });

  let result = await harness.runtime.intercept([structuredClone(harness.userMessage)], 12000, null, 'normal');
  const visibleReceipt = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
  assert.equal(result.lastRecall.status, 'empty');
  assert.doesNotMatch(result.lastRecall.injectionText, /钟楼/);

  harness.chat[0].is_hidden = true;
  harness.handlers.get('message-edited')(harness.chat.length);
  result = await harness.runtime.intercept([structuredClone(harness.userMessage)], 12000, null, 'regenerate');
  const hiddenReceipt = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
  assert.equal(result.lastRecall.reusedReceipt, false);
  assert.match(result.lastRecall.injectionText, /钟楼/);
  assert.notEqual(hiddenReceipt.bodyMatchFingerprint, visibleReceipt.bodyMatchFingerprint);

  harness.chat[0].is_hidden = false;
  harness.handlers.get('message-edited')(harness.chat.length);
  result = await harness.runtime.intercept([structuredClone(harness.userMessage)], 12000, null, 'regenerate');
  assert.equal(result.lastRecall.reusedReceipt, false);
  assert.equal(result.lastRecall.status, 'empty');
  assert.doesNotMatch(result.lastRecall.injectionText, /钟楼/);
  assert.notEqual(harness.userMessage.extra[RECALL_RECEIPT_KEY].bodyMatchFingerprint, hiddenReceipt.bodyMatchFingerprint);
  assert.equal(selectorCalls, 3);
});

test('多个连续未登记可见尾楼由宿主正文负责，并按宿主顺序获得独立 synthetic 序号', async () => {
  const raw = await singleFloorReachable({ text: '已经保存的隐藏前楼。', summary: '钟楼旧约已保存。' });
  let projected = null, aborted = false;
  const runtime = createRuntimeHarness({
    sourceReader: options => readRecallSource(options),
    reachableReader: async () => structuredClone(raw),
    selector: input => { projected = input.source; return selectRecall(input); },
  });
  runtime.chat.splice(0, runtime.chat.length,
    { is_user: false, is_system: false, is_hidden: true, mes: '已经保存的隐藏前楼。' },
    { is_user: false, is_system: false, mes: '未登记可见尾楼甲。' },
    { is_user: false, is_system: false, mes: '未登记可见尾楼乙。' },
    runtime.userMessage,
  );
  const result = await runtime.runtime.intercept([structuredClone(runtime.userMessage)], 12000, value => { aborted = value === true; }, 'normal');
  assert.equal(aborted, false);
  assert.match(result.lastRecall.injectionText, /钟楼旧约已保存/);
  assert.deepEqual(projected.readiness.unregisteredSummaryRefs.map(ref => ref.assistantSeq), [2, 3]);
  assert.deepEqual(projected.bodyMatch.visibleFloorIds, projected.readiness.unregisteredSummaryRefs.map(ref => ref.floorId));
});

test('readRoot 返回旧 root 后后台给可见尾楼正常挂标，不把 none→valid 误报 coverageUnconfirmed', async () => {
  const raw = await singleFloorReachable({ text: '已经保存的隐藏前楼。', summary: '钟楼旧约已保存。' });
  const tailText = '后台即将挂标的可见尾楼。';
  let markerWritten = false, aborted = false;
  const harness = createRuntimeHarness({
    sourceReader: options => readRecallSource(options),
    reachableReader: async () => structuredClone(raw),
    rootReader: async () => {
      const result = { status: 'ready', revision: raw.rootRevision, data: structuredClone(raw.root) };
      harness.chat[1].extra = { qianqianjie_floor: { schemaVersion: 1, chatId: CHAT, floorId: FLOOR2 } };
      markerWritten = true;
      return result;
    },
    selector: input => selectRecall(input),
  });
  harness.chat.splice(0, harness.chat.length,
    { is_user: false, is_system: false, is_hidden: true, mes: '已经保存的隐藏前楼。' },
    { is_user: false, is_system: false, mes: tailText },
    harness.userMessage,
  );
  const result = await harness.runtime.intercept([structuredClone(harness.userMessage)], 12000, value => { aborted = value === true; }, 'normal');
  assert.equal(markerWritten, true);
  assert.equal(aborted, false);
  assert.equal(result.lastRecall.status, 'ready', JSON.stringify(result.lastRecall));
  assert.match(result.lastRecall.injectionText, /钟楼旧约已保存/);
});

test('无 marker 且 raw 包装变化时，canonical 对应证明可穿过 readiness 与最终 guard 完成生成注入', async () => {
  const raw = await singleFloorReachable({ text: '永久正文<!--旧包装-->', summary: '裴晚生仍在钟楼等待。' });
  raw.floors[0].content.canonicalFingerprint = await fingerprintText('永久正文');
  let projected = null, aborted = false;
  const harness = createRuntimeHarness({
    sourceReader: options => readRecallSource(options),
    reachableReader: async () => structuredClone(raw),
    selector: input => { projected = input.source; return selectRecall(input); },
  });
  harness.chat[0].mes = '永久正文<!--宿主新包装-->';
  harness.chat[0].is_hidden = true;
  const result = await harness.runtime.intercept([structuredClone(harness.userMessage)], 12000, value => { aborted = value === true; }, 'normal');
  assert.equal(projected.readiness.hostConfirmed, true);
  assert.equal(projected.readiness.summaryStatus, 'caughtUp');
  assert.equal(aborted, false);
  assert.equal(result.lastRecall.status, 'ready', JSON.stringify(result.lastRecall));
  assert.match(result.lastRecall.injectionText, /钟楼等待/);
  assert.equal(result.lastRecall.skipReasons.includes('memoryNotReady'), false);
  assert.equal(result.lastRecall.skipReasons.includes('coverageUnconfirmed'), false);
});

test('未选尾楼的 foreign marker 不全局阻断；已选远期楼删除/换绑/重复或正文可见性变化会丢弃旧注入', async () => {
  for (const scenario of ['duplicate', 'foreign', 'selectedEdited', 'selectedForeign', 'selectedDeleted', 'hidden']) {
    const raw = await singleFloorReachable({ text: '已经保存的隐藏前楼。', summary: '钟楼旧约已保存。' });
    raw.floors[0].id = FLOOR1;
    raw.floorMemories[0].floorId = FLOOR1;
    let aborted = false;
    const harness = createRuntimeHarness({
      sourceReader: options => readRecallSource(options),
      reachableReader: async () => structuredClone(raw),
      rootReader: async () => ({ status: 'ready', revision: raw.rootRevision, data: structuredClone(raw.root) }),
      selector: input => {
        const selection = selectRecall(input);
        if (scenario === 'duplicate') {
          harness.chat[0].extra = { qianqianjie_floor: { schemaVersion: 1, chatId: CHAT, floorId: FLOOR1 } };
          harness.chat[1].extra = { qianqianjie_floor: { schemaVersion: 1, chatId: CHAT, floorId: FLOOR1 } };
        } else if (scenario === 'foreign') {
          harness.chat[1].extra = { qianqianjie_floor: { schemaVersion: 1, chatId: GEN, floorId: FLOOR2 } };
        } else if (scenario === 'selectedEdited') {
          harness.chat[0].extra = { qianqianjie_floor: { schemaVersion: 1, chatId: CHAT, floorId: FLOOR1 } };
          harness.chat[0].mes = '已落盘楼正文后来做过普通编辑。';
        } else if (scenario === 'selectedForeign') {
          harness.chat[0].extra = { qianqianjie_floor: { schemaVersion: 1, chatId: GEN, floorId: FLOOR1 } };
        } else if (scenario === 'selectedDeleted') {
          Object.assign(harness.chat[0], { is_user: true, is_system: false, mes: '' });
        } else harness.chat[1].is_hidden = true;
        return selection;
      },
    });
    harness.chat.splice(0, harness.chat.length,
      { is_user: false, is_system: false, is_hidden: true, mes: '已经保存的隐藏前楼。' },
      { is_user: false, is_system: false, mes: '本轮可见尾楼正文。' },
      harness.userMessage,
    );
    const result = await harness.runtime.intercept([structuredClone(harness.userMessage)], 12000, value => { aborted = value === true; }, 'normal');
    assert.equal(aborted, false, scenario);
    if (['duplicate', 'selectedForeign', 'selectedDeleted', 'hidden'].includes(scenario)) {
      assert.equal(result.lastRecall.status, 'stale', scenario);
      if (scenario !== 'hidden') assert.deepEqual(result.lastRecall.skipReasons, ['selectedRefsChanged']);
      assert.ok(harness.prompts.every(call => call[1] === ''), scenario);
    } else {
      assert.equal(result.lastRecall.status, 'ready', `${scenario}:${JSON.stringify(result.lastRecall.skipReasons)}`);
      assert.ok(harness.prompts.some(call => call[1]), scenario);
    }
  }
});

test('选材期间可见尾楼从 synthetic 升为正式楼并挂标，不误报 coverage 或正文变化', async () => {
  let raw = await singleFloorReachable({ text: '已经保存的隐藏前楼。', summary: '钟楼旧约已保存。' });
  const tailText = '本轮可见尾楼正文。';
  const tailFingerprint = await fingerprintText(tailText);
  let upgraded = false, aborted = false;
  const harness = createRuntimeHarness({
    sourceReader: options => readRecallSource(options),
    reachableReader: async () => structuredClone(raw),
    rootReader: async () => ({ status: 'ready', revision: raw.rootRevision, data: structuredClone(raw.root) }),
    selector: input => {
      const selection = selectRecall(input);
      harness.chat[1].extra = { qianqianjie_floor: { schemaVersion: 1, chatId: CHAT, floorId: FLOOR2 } };
      raw = {
        ...raw,
        rootRevision: 2,
        root: { ...raw.root, headCheckpointId: 'head-two' },
        checkpoint: { id: 'head-two' },
        floors: [...raw.floors, {
          id: FLOOR2, assistantSeq: 2,
          hostLocator: { messageIndex: 1, swipeId: null, selectedSwipeIndex: null },
          content: { rawFingerprint: tailFingerprint, canonicalFingerprint: tailFingerprint },
        }],
      };
      upgraded = true;
      return selection;
    },
  });
  harness.chat.splice(0, harness.chat.length,
    { is_user: false, is_system: false, is_hidden: true, mes: '已经保存的隐藏前楼。' },
    { is_user: false, is_system: false, mes: tailText },
    harness.userMessage,
  );
  const result = await harness.runtime.intercept([
    { is_user: false, is_system: false, mes: tailText },
    structuredClone(harness.userMessage),
  ], 12000, value => { aborted = value === true; }, 'normal');
  assert.equal(upgraded, true);
  assert.equal(aborted, false);
  assert.equal(result.lastRecall.status, 'ready', JSON.stringify(result.lastRecall));
  assert.match(result.lastRecall.injectionText, /钟楼旧约已保存/);
});

test('已验证召回来源正常使用，quiet 仍不读取来源', async () => {
  const notifications = [];
  let sourceReads = 0;
  const harness = createRuntimeHarness({
    notifyUser: value => notifications.push(value),
    sourceReader: async () => { sourceReads += 1; return runtimeFixture(); },
  });
  let aborted = false;
  let mainApiCalls = 0;
  await harness.runtime.intercept(harness.chat, 12000, value => { aborted = value === true; }, 'normal');
  if (!aborted) mainApiCalls += 1;
  assert.equal(aborted, false);
  assert.equal(mainApiCalls, 1);
  assert.equal(sourceReads, 2, '有效来源会在提交前以同一读取器复核，后台同步不应阻断召回');
  assert.equal(harness.runtime.getState().lastRecall.status, 'ready');
  assert.deepEqual(notifications, []);

  let quietAborted = false;
  await harness.runtime.intercept(harness.chat, 12000, value => { quietAborted = value === true; }, 'quiet');
  assert.equal(quietAborted, false);
  assert.deepEqual(harness.runtime.getState().lastRecall.skipReasons, ['quiet']);

  let retryAborted = false;
  await harness.runtime.intercept(harness.chat, 12000, value => { retryAborted = value === true; }, 'normal');
  assert.equal(retryAborted, false);
  assert.equal(sourceReads, 4);
});

test('历史摘要或 CSE 有缺口时使用同聊天已保存部分召回，不停止主生成', async () => {
  for (const [memory, expected] of [
    [{ activeAutoMemory: { phase: 'extracting', mode: 'historical' } }, ['memoryNotReady', 'historicalRebuildRequired']],
    [{ lastAutoMemory: { status: 'failed' } }, ['memoryNotReady', 'memoryRebuildFailed']],
    [null, ['memoryNotReady', 'historicalRebuildRequired']],
  ]) {
    let selectorCalls = 0;
    const source = { ...runtimeFixture(), readiness: { status: 'historicalDebt' } };
    const harness = createRuntimeHarness({
      sourceReader: async () => structuredClone(source),
      selector: input => { selectorCalls += 1; return selectRecall(input); },
      memoryStatus: () => memory,
    });
    let aborted = false;
    const result = await harness.runtime.intercept(harness.chat, 12000, value => { aborted = value === true; }, 'normal');
    assert.equal(result.lastRecall.status, 'ready');
    assert.deepEqual(expected.every(reason => result.lastRecall.skipReasons.includes(reason)), true);
    assert.equal(result.lastRecall.userMessageIndex, 1);
    assert.equal(selectorCalls, 1);
    assert.equal(aborted, false);
    assert.equal(harness.saves, 1);
    assert.ok(harness.prompts.some(call => call[1]));
  }
});

test('只有实时尾状态名时仍使用已保存部分召回且正文继续生成', async () => {
  let selectorCalls = 0;
  const harness = createRuntimeHarness({
    sourceReader: async () => ({ ...runtimeFixture(), readiness: { status: 'realtimeTail' } }),
    memoryStatus: () => null,
    selector: input => { selectorCalls += 1; return selectRecall(input); },
  });
  let aborted = false;
  const result = await harness.runtime.intercept(harness.chat, 12000, value => { aborted = value === true; }, 'normal');
  assert.equal(selectorCalls, 1);
  assert.equal(aborted, false);
  assert.equal(result.lastRecall.status, 'ready');
  assert.equal(result.lastRecall.skipReasons.includes('memoryNotReady'), true);
});

test('runtime normal 先完成一次 prompt commit，再最多保存一次 schema13 completed user 收据且不产生 pending', async () => {
  let selectorCalls = 0;
  const harness = createRuntimeHarness({ selector: input => { selectorCalls += 1; return selectRecall(input); } });
  let abortCalls = 0;
  const result = await harness.runtime.intercept(harness.chat, 12000, () => { abortCalls += 1; }, 'normal');
  assert.equal(selectorCalls, 1);
  assert.equal(abortCalls, 0, '召回不得调用宿主 abort');
  assert.equal(harness.prompts[0][0], RECALL_PROMPT_SLOT);
  assert.equal(harness.prompts[0][1], '', '每次生成先清旧槽位');
  const injection = harness.prompts.find(call => call[1]);
  assert.ok(injection, '必须实际注入非空召回文本');
  assert.deepEqual(injection.slice(2), [23, 1, false, 47]);
  assert.match(injection[1], /<qqj_recalled_context>/);
  assert.equal(harness.saves, 1, '正常路径只在 prompt commit 后保存一次完成态回执');
  const receipt = harness.userMessage.extra?.[RECALL_RECEIPT_KEY];
  assert.equal(RECALL_RECEIPT_SCHEMA_VERSION, 13);
  assert.equal(receipt.schemaVersion, 13);
  assert.equal(receipt.strategyVersion, 'continuity-v10');
  assert.equal(receipt.chatId, CHAT);
  assert.equal(receipt.headCheckpointId, harness.source.headCheckpointId);
  assert.equal(receipt.rootRevision, harness.source.rootRevision);
  assert.equal(receipt.userMessageIndex, 1);
  assert.match(receipt.userContentFingerprint, /^sha256:/);
  assert.match(receipt.queryFingerprint, /^sha256:/);
  assert.match(receipt.bodyMatchFingerprint, /^sha256:/);
  assert.match(receipt.receiptFingerprint, /^sha256:/);
  assert.equal(receipt.completionStatus, 'ready');
  assert.deepEqual(receipt.selectedCseChanges, []);
  assert.equal(receipt.selectorDiagnostic.mode, 'local');
  assert.equal(Number.isFinite(receipt.timings.selectorMs), true);
  assert.equal(Object.hasOwn(receipt, 'promptCommitted'), false);
  assert.deepEqual(receipt.selectedFloors.map(value => value.assistantSeq), [2, 5, 6, 7, 8]);
  assert.equal(result.lastRecall.schemaVersion, 13);
  assert.equal(result.lastRecall.reusedReceipt, false);
  assert.equal(result.lastRecall.receiptPersistence, 'saveUnconfirmed');
  assert.equal(result.lastRecall.stages.selected, 5);
  assert.equal(typeof result.lastRecall.timings.totalMs, 'number');
});

test('摘要已齐但CSE欠尾时真实delta的私密移除跨 source/selector/schema13 保存恢复复用，delta变化后重选', async () => {
  let reachable = cseLaggingReachable();
  let selectorCalls = 0, selectedSnapshot = null, sourceSnapshot = null;
  const sourceReader = async ({ now }) => { sourceSnapshot = await readRecallSource({ store: { readReachable: async () => structuredClone(reachable) }, now }); return sourceSnapshot; };
  const harness = createRuntimeHarness({
    sourceReader,
    reachableReader: async () => structuredClone(reachable),
    selector: input => { selectorCalls += 1; selectedSnapshot = selectRecall(input); return selectedSnapshot; },
  });
  const first = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(first.lastRecall.status, 'ready', JSON.stringify({ recall: first.lastRecall, selected: selectedSnapshot?.cseChanges, source: sourceSnapshot?.cseChanges }));
  const receipt = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
  assert.deepEqual(receipt.coverage, { stableAiFloors: 3, stableThroughAssistantSeq: 3, rememberedAiFloors: 3, missingAssistantSeq: [], cseThroughAssistantSeq: 2, memoryComplete: true, cseCurrent: true });
  assert.equal(receipt.schemaVersion, 13);
  assert.equal(receipt.selectedStates.length, 0, '第二楼固定移除后，现存楼汇总确实为空');
  const removed = receipt.selectedCseChanges.find(value => value.action === 'remove');
  assert.ok(removed);
  assert.equal(removed.deltaId, 'delta-remove');
  assert.equal(removed.before.text, '仍在钟楼等待赴约');
  assert.equal(removed.before.visibility, 'private');
  assert.deepEqual({ stateId: removed.before.stateId, sourceFloorId: removed.before.sourceFloorId, sourceDeltaId: removed.before.sourceDeltaId }, {
    stateId: 'cse-state-private', sourceFloorId: 'cse-floor-1', sourceDeltaId: 'delta-add',
  });
  assert.ok(removed.before.reason.length > 1000, '合法长 reason 必须能进入自生成回执');
  assert.equal(removed.after, null);
  assert.match(receipt.injectionText, /\[来源 AI #2\][\s\S]*- \[变化\]/);
  assert.match(receipt.injectionText, /当时移除；之前 private，仅可用于该人物/);
  assert.match(receipt.injectionText, /“之前”只是被移除的旧状态，不是当前状态/);
  const inline = projectInlineRecallReceipt(receipt);
  assert.equal(inline.protocolRecognized, true);
  assert.ok(inline.historyItems.length > 0, '含CSE变化的剧情线协议仍须保留历史材料投影');
  assert.equal(inline.cseChangeItems.find(value => value.action === 'remove')?.before?.text, '仍在钟楼等待赴约');

  harness.runtime.invalidate('simulateReload');
  const restored = await harness.runtime.restorePersistedReceipt();
  assert.equal(restored.lastRecall.restoredReceipt, true);
  assert.equal(restored.lastRecall.selectedCseChanges.find(value => value.action === 'remove')?.before.reason, removed.before.reason);
  const reused = await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(reused.lastRecall.reusedReceipt, true);
  assert.equal(selectorCalls, 1, '来源未变时 schema13 回执应直接复用');

  reachable = cseLaggingReachable('delta-remove-new');
  const refreshed = await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(refreshed.lastRecall.reusedReceipt, false);
  assert.equal(selectorCalls, 2, '所选 delta 身份变化后旧回执必须拒绝并重选');
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].selectedCseChanges.find(value => value.action === 'remove')?.deltaId, 'delta-remove-new');
});

test('runtime 默认异步入口调用摘要路由，成功排除写入 schema13 回执并可复用', async () => {
  let calls = 0;
  const harness = createRuntimeHarness({
    useDefaultSelector: true,
    generateUtilityTask: async options => { calls += 1; assert.equal(options.transportBudget.remaining, 1); return { jsonData: { history_exclude_keys: [], state_exclude_keys: [] } }; },
  });
  const first = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(calls, 1);
  assert.equal(first.lastRecall.status, 'ready');
  const receipt = harness.userMessage.extra[RECALL_RECEIPT_KEY];
  assert.equal(receipt.schemaVersion, 13);
  assert.equal(receipt.strategyVersion, 'continuity-v10');
  assert.equal(receipt.selectorDiagnostic.historyCandidateCount > 0, true);
  assert.equal(receipt.selectorDiagnostic.stateCandidateCount, 0);
  assert.equal(receipt.selectorDiagnostic.historyExcludedCount, 0);
  assert.equal(receipt.selectorDiagnostic.stateExcludedCount, 0);
  assert.equal(receipt.selectorDiagnostic.historyRetainedCount, receipt.selectorDiagnostic.historyCandidateCount);
  assert.equal(receipt.selectorDiagnostic.stateRetainedCount, 0);
  assert.ok(Number.isFinite(receipt.selectorDiagnostic.utilityRoundTripMs));
  assert.ok(Number.isFinite(receipt.selectorDiagnostic.localSelectionMs));
  const reused = await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(calls, 1, '未变化的 regenerate 应复用新回执，不重复扣选材请求');
  assert.equal(reused.lastRecall.reusedReceipt, true);
});

test('schema13 时间推演随同一回执落盘、冷读与重roll复用，不回写记忆或重复调用utility', async () => {
  const graph = reachable();
  const source = await readRecallSource({ store:{ readReachable:async () => structuredClone(graph) }, now:() => new Date(NOW) });
  const beforeGraph = structuredClone(graph);
  let calls = 0;
  const harness = createRuntimeHarness({
    useDefaultSelector:true,
    sourceReader:async () => structuredClone(source),
    reachableReader:async () => structuredClone(graph),
    queryBuilder:() => ({ text:'雨夜承诺过了一阵', latestUserText:'雨夜承诺过了一阵', recentAssistantText:'', previousUserText:'', messageCount:1 }),
    generateUtilityTask:async options => {
      calls += 1;
      const payload = JSON.parse(options.taskMessages[0].content);
      const current = payload.cseContextGroups.flatMap(value => value.items).find(value => value.kind === 'current');
      assert.ok(current);
      return { jsonData:{ history_exclude_keys:[], state_exclude_keys:[], state_progressions:[{
        source_state_key:current.key, evidence_keys:[], time_basis:'过了一阵；具体时长未知', suggestion:'保存时仍记得承诺→此刻可继续带着这份记忆行动，但不预设决定',
      }] } };
    },
  });
  const first = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const receipt = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
  assert.equal(calls, 1);
  assert.equal(receipt.schemaVersion, 13);
  assert.equal(receipt.stateProgressions.length, 1);
  assert.deepEqual(first.lastRecall.stateProgressions, receipt.stateProgressions);
  assert.match(receipt.injectionText, /过了一阵；具体时长未知/);
  assert.deepEqual(graph, beforeGraph, '推演只写召回回执，不修改FloorMemory/CSE图');
  const expanded = structuredClone(receipt);
  expanded.injectionText = '甲'.repeat(17000);
  expanded.receiptFingerprint = await receiptFingerprint(expanded);
  const expandedProjection = await projectHistoricalRecallReceipt({ ...harness.userMessage, extra:{ [RECALL_RECEIPT_KEY]:expanded } }, { chatId:CHAT, userMessageIndex:1 });
  assert.equal(expandedProjection?.injectionText.length, 17000, 'v10 推演总字符额度内的回执必须可历史投影');
  const oversized = { ...expanded, injectionText:'甲'.repeat(20001) };
  oversized.receiptFingerprint = await receiptFingerprint(oversized);
  assert.equal(await projectHistoricalRecallReceipt({ ...harness.userMessage, extra:{ [RECALL_RECEIPT_KEY]:oversized } }, { chatId:CHAT, userMessageIndex:1 }), null);
  harness.userMessage.extra[RECALL_RECEIPT_KEY] = expanded;
  harness.runtime.invalidate('simulateReload');
  const restored = await harness.runtime.restorePersistedReceipt();
  assert.deepEqual(restored.lastRecall.stateProgressions, receipt.stateProgressions);
  assert.equal(restored.lastRecall.restoredReceipt, true);
  assert.equal(restored.lastRecall.injectionText.length, 17000, 'v10 扩展额度内的回执必须可从聊天记录冷恢复');
  const rerolled = await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(rerolled.lastRecall.reusedReceipt, true);
  assert.deepEqual(rerolled.lastRecall.stateProgressions, receipt.stateProgressions);
  assert.equal(rerolled.lastRecall.injectionText.length, 17000, '冷恢复后的扩展回执必须可直接复用');
  assert.equal(calls, 1);
});

test('schema13 剧情线回执经 runtime 新算/复用/恢复及历史 projector 后仍完整渲染', async () => {
  const source = changingCseSource({ withHistory: true });
  const queryContext = { ...llmQuery, text: '左佐辛夷旧门锁', latestUserText: '左佐辛夷旧门锁' };
  const selection = selectRecall({ source, queryContext, contextSize: 12000 });
  assert.ok(selection.storylines.length > 0 && selection.storylines.length <= 4);
  assert.ok(selection.floors.length > 0);
  assert.ok(selection.states.length + selection.cseChanges.length > 0);
  let selectorCalls = 0;
  const harness = createRuntimeHarness({
    sourceReader: async () => structuredClone(source),
    rootReader: async () => ({ status: 'ready', revision: source.rootRevision, data: { chatId: source.chatId, narrativeGeneration: source.narrativeGeneration, headCheckpointId: source.headCheckpointId } }),
    selector: () => { selectorCalls += 1; return selection; },
  });
  const first = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const receipt = harness.userMessage.extra[RECALL_RECEIPT_KEY];
  assert.equal(first.lastRecall.status, 'ready');
  assert.equal(first.lastRecall.schemaVersion, 13);
  assert.equal(receipt.strategyVersion, 'continuity-v10');
  assert.deepEqual(receipt.storylines, selection.storylines);
  assert.equal(receipt.injectionText, selection.injectionText);
  const freshInline = projectInlineRecallReceipt(first.lastRecall);
  assert.equal(freshInline.protocolRecognized, true);
  assert.equal(freshInline.storylineGroups.length, selection.storylines.length);
  assert.equal(freshInline.historyItems.length, selection.floors.flatMap(value => value.items).length);
  assert.equal(freshInline.cseChangeItems.length, selection.cseChanges.length);

  const historical = await projectHistoricalRecallReceipt({ ...harness.userMessage, extra: { [RECALL_RECEIPT_KEY]: structuredClone(receipt) } }, { chatId: CHAT, userMessageIndex: 1 });
  assert.equal(historical.schemaVersion, 13);
  assert.equal(projectInlineRecallReceipt(historical).protocolRecognized, true);
  assert.deepEqual(projectInlineRecallReceipt(historical).storylines, freshInline.storylines);

  const oldSchema12 = structuredClone(receipt);
  oldSchema12.schemaVersion = 12;
  delete oldSchema12.stateProgressions;
  delete oldSchema12.stages.stateProgressionCount;
  oldSchema12.receiptFingerprint = await receiptFingerprint(oldSchema12);
  const historical12 = await projectHistoricalRecallReceipt({ ...harness.userMessage, extra:{ [RECALL_RECEIPT_KEY]:oldSchema12 } }, { chatId:CHAT, userMessageIndex:1 });
  assert.equal(historical12.schemaVersion, 12);
  assert.deepEqual(historical12.stateProgressions, []);
  assert.equal(projectInlineRecallReceipt(historical12).protocolRecognized, true);

  harness.runtime.invalidate('simulateReload');
  const restored = await harness.runtime.restorePersistedReceipt();
  assert.equal(restored.lastRecall.schemaVersion, 13);
  assert.equal(projectInlineRecallReceipt(restored.lastRecall).protocolRecognized, true);
  assert.deepEqual(projectInlineRecallReceipt(restored.lastRecall).storylines, freshInline.storylines);

  const reused = await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(selectorCalls, 1);
  assert.equal(reused.lastRecall.schemaVersion, 13);
  assert.equal(reused.lastRecall.reusedReceipt, true);
  assert.equal(reused.lastRecall.injectionText, selection.injectionText);
  assert.equal(projectInlineRecallReceipt(reused.lastRecall).protocolRecognized, true);
  assert.deepEqual(projectInlineRecallReceipt(reused.lastRecall).storylines, freshInline.storylines);
});

test('旧fallback回执仍可历史查看，但regenerate不再把它当本轮选材成功', async () => {
  let selectorCalls = 0;
  const harness = createRuntimeHarness({ selector: input => {
    selectorCalls += 1;
    const selected = selectRecall(input);
    if (selectorCalls !== 1) return selected;
    return {
      ...selected,
      selectorDiagnostic: { mode: 'fallback', code: 'OLD_SELECTOR_FAILED' },
      skipReasons: [...new Set([...(selected.skipReasons ?? []), 'historySelectionFallback'])],
    };
  } });
  const first = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(first.lastRecall.selectorDiagnostic.mode, 'fallback');
  const historical = await projectHistoricalRecallReceipt(harness.userMessage, { chatId: CHAT, userMessageIndex: 1 });
  assert.equal(historical.selectorDiagnostic.mode, 'fallback', '旧回执展示能力必须保留');
  const regenerated = await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(selectorCalls, 2, '旧fallback回执必须重新选材');
  assert.equal(regenerated.lastRecall.reusedReceipt, false);
  assert.equal(regenerated.lastRecall.selectorDiagnostic.mode, 'local');
});

test('runtime LLM首次网络失败后整体重试成功，每次utility仍只有一次transport budget', async () => {
  const notifications = [];
  const budgets = [];
  let calls = 0, abortCalls = 0;
  const harness = createRuntimeHarness({
    useDefaultSelector: true,
    generateUtilityTask: async options => {
      calls += 1;
      budgets.push(structuredClone(options.transportBudget));
      if (calls === 1) throw Object.assign(new Error('utility network unavailable'), { code: 'UTILITY_NETWORK_FAILED' });
      return { jsonData: { history_exclude_keys: [], state_exclude_keys: [] } };
    },
    notifyUser: value => notifications.push(value),
  });
  const result = await harness.runtime.intercept(harness.chat, 12000, value => { if (value === true) abortCalls += 1; }, 'normal');
  assert.equal(calls, 2);
  assert.deepEqual(budgets, [{ remaining: 1, used: 0 }, { remaining: 1, used: 0 }]);
  assert.equal(result.lastRecall.status, 'ready');
  assert.equal(result.lastRecall.selectorDiagnostic.mode, 'llm');
  assert.equal(abortCalls, 0);
  assert.deepEqual(notifications, [{ kind: 'warning', text: '记忆召回未完成，正在重试一次。' }]);
});

test('runtime LLM持续返回坏JSON时只调用utility两次，清槽并阻止正文API', async () => {
  const notifications = [];
  let calls = 0, abortCalls = 0, mainApiCalls = 0;
  const harness = createRuntimeHarness({
    useDefaultSelector: true,
    generateUtilityTask: async options => {
      calls += 1;
      assert.deepEqual(options.transportBudget, { remaining: 1, used: 0 });
      return { textData: '不是 JSON' };
    },
    notifyUser: value => notifications.push(value),
  });
  const result = await harness.runtime.intercept(harness.chat, 12000, value => { if (value === true) abortCalls += 1; }, 'normal');
  if (!abortCalls) mainApiCalls += 1;
  assert.equal(calls, 2);
  assert.equal(abortCalls, 1);
  assert.equal(mainApiCalls, 0, '宿主 abort 标记后正文 API 不得调用');
  assert.equal(result.lastRecall.status, 'error');
  assert.equal(result.lastRecall.injectionText, '');
  assert.equal(harness.saves, 0);
  assert.ok(harness.prompts.every(call => call[1] === ''));
  assert.equal(notifications.length, 2);
  assert.equal(notifications[0].text, '记忆召回未完成，正在重试一次。');
  assert.match(notifications[1].text, /重试后仍失败，已停止正文生成/);
});

test('runtime 经真实utility路由与compact client遇到HTTP 500时总共只发两次请求', async () => {
  let fetchCalls = 0, retryWaits = 0, abortCalls = 0;
  const compactClient = createCompactApiClient({
    retryWait: async () => { retryWaits += 1; },
    fetchImpl: async () => {
      fetchCalls += 1;
      return { ok: false, status: 500, text: async () => '' };
    },
  });
  const route = {
    kind: 'independent', source: 'test-utility', sourceLabel: '测试副 API',
    config: { url: 'https://api.example.test/v1', key: 'TEST_KEY', model: 'test-model', excludeParams: [], timeoutSec: 5, stream: false },
  };
  const router = createTaskRouter({
    resolver: { resolve: () => route, resolveUtility: () => route },
    compactClient,
  });
  const harness = createRuntimeHarness({ useDefaultSelector: true, generateUtilityTask: router.generateUtilityTask });
  const result = await harness.runtime.intercept(harness.chat, 12000, value => { if (value === true) abortCalls += 1; }, 'normal');
  assert.equal(fetchCalls, 2, '两轮各自的 transportBudget=1 必须压住 compact client 默认内部重试');
  assert.equal(retryWaits, 0);
  assert.equal(abortCalls, 1);
  assert.equal(result.lastRecall.status, 'error');
  assert.equal(result.lastRecall.error.code, 'QQJ_SERVER');
});

test('runtime 摘要和 CSE 局部缺口均使用可用部分，只有未确认归属的 unknown 跳过记忆', async () => {
  const projectedBase = runtimeFixture();
  projectedBase.floorMemories = [projectedBase.floorMemories[1]];
  projectedBase.coverage = { stableAiFloors: 1, stableThroughAssistantSeq: 2, rememberedAiFloors: 1, missingAssistantSeq: [], cseThroughAssistantSeq: 0, memoryComplete: true, cseCurrent: false };
  const reachableBase = structuredClone(projectedBase);
  reachableBase.bodyMatchRefs = [{
    floorId: 'floor-2', floorMemoryId: 'memory-2', assistantSeq: 2,
    hostLocator: { messageIndex: 0, swipeId: null, selectedSwipeIndex: null },
    rawFingerprint: await fingerprintText('街上已经安静。'), canonicalFingerprint: await fingerprintText('街上已经安静。'),
  }];
  projectedBase.bodyMatchRefs = structuredClone(reachableBase.bodyMatchRefs);
  for (const [summaryStatus, realtimeActive, readinessStatus, expectedReached] of [
    ['caughtUp', false, 'historicalDebt', true],
    ['realtimeTail', true, 'historicalDebt', true],
    ['realtimeTail', false, 'historicalDebt', true],
    ['historicalDebt', true, 'historicalDebt', true],
    ['caughtUp', false, 'unknown', false],
  ]) {
    let reached = 0;
    const source = { ...structuredClone(projectedBase), readiness: { status: readinessStatus, hostConfirmed: readinessStatus !== 'unknown', summaryStatus, summaryPendingFloorIds: summaryStatus === 'realtimeTail' ? ['floor-2'] : [], summaryMissingFloorIds: summaryStatus === 'realtimeTail' ? ['floor-2'] : [], visibleSummaryFloorIds: summaryStatus === 'realtimeTail' ? ['floor-2'] : [] } };
    const harness = createRuntimeHarness({
      sourceReader: async () => source,
      reachableReader: async () => rawReachableFromSource(reachableBase),
      memoryStatus: () => realtimeActive ? ({ activeAutoMemory: { mode: 'realtime', phase: 'extracting' } }) : null,
      selector: input => { reached += 1; return selectRecall(input); },
    });
    const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
    const label = `${readinessStatus}/${summaryStatus}/${realtimeActive}`;
    assert.equal(reached, expectedReached ? 1 : 0, label);
    assert.equal(expectedReached ? ['ready', 'empty'].includes(result.lastRecall.status) : result.lastRecall.status === 'skipped', true, label);
  }
});

test('唯一未登记可见尾不依赖 actual core 正文证明，缺失、重复或正则替换都不停止生成', async () => {
  const raw = await singleFloorReachable({ text: '已经保存的前楼。', summary: '钟楼旧约已保存。' });
  for (const scenario of ['covered', 'missing', 'duplicate', 'replaced']) {
    let selectorCalls = 0;
    const notifications = [];
    const harness = createRuntimeHarness({
      sourceReader: options => readRecallSource(options),
      reachableReader: async () => structuredClone(raw),
      notifyUser: value => notifications.push(value),
      selector: input => { selectorCalls += 1; return selectRecall(input); },
    });
    harness.chat.splice(0, harness.chat.length,
      { is_user: false, is_system: false, mes: '已经保存的前楼。' },
      { is_user: false, is_system: false, mes: '尚未登记的尾楼正文。' },
      harness.userMessage,
    );
    const core = scenario === 'covered'
      ? structuredClone(harness.chat)
      : scenario === 'missing'
        ? [structuredClone(harness.userMessage)]
        : scenario === 'duplicate'
          ? [{ is_user: false, is_system: false, mes: '尚未登记的尾楼正文。' }, { is_user: false, is_system: false, mes: '尚未登记的尾楼正文。' }, structuredClone(harness.userMessage)]
          : [{ is_user: false, is_system: false, mes: '正则处理后只剩另一段。' }, structuredClone(harness.userMessage)];
    let aborted = false;
    const result = await harness.runtime.intercept(core, 12000, value => { aborted = value === true; }, 'normal');
    assert.equal(selectorCalls, 1, scenario);
    assert.equal(aborted, false, scenario);
    assert.notEqual(result.lastRecall.status, 'skipped', scenario);
    assert.equal(notifications.length, 0, scenario);
  }
});

test('待摘要可见或隐藏缺口均不阻断已有同聊天记忆召回', async () => {
  for (const scenario of ['canonical', 'decorated', 'replaced', 'empty', 'coreHidden', 'hostHidden']) {
    const tailText = scenario === 'canonical' ? '尚未登记的尾楼正文。<!--宿主包装-->' : '尚未登记的尾楼正文。';
    const raw = await singleFloorReachable({ text: '已经保存的前楼。', summary: '钟楼旧约已保存。' });
    let selectorCalls = 0, bodyMatch = null, aborted = false;
    const harness = createRuntimeHarness({
      sourceReader: options => readRecallSource(options),
      reachableReader: async () => structuredClone(raw),
      selector: input => { selectorCalls += 1; bodyMatch = input.source.bodyMatch; return selectRecall(input); },
    });
    const sharedExtra = { hostSource: 'chat' };
    const tail = { is_user: false, is_system: false, mes: tailText, extra: sharedExtra };
    if (scenario === 'hostHidden') tail.is_hidden = true;
    harness.chat.splice(0, harness.chat.length,
      { is_user: false, is_system: false, mes: '已经保存的前楼。' },
      tail,
      harness.userMessage,
    );
    const transformed = scenario === 'canonical' ? '尚未登记的尾楼正文。'
      : scenario === 'decorated' ? '【楼层标题】\n尚未登记的尾楼正文。\n【推理注记】已完成。'
        : scenario === 'replaced' ? '【楼层标题】\n【推理注记】只有附加信息。' : scenario === 'empty' ? '   ' : tailText;
    const coreTail = { ...tail, mes: transformed, ...(scenario === 'coreHidden' ? { is_hidden: true } : {}) };
    const result = await harness.runtime.intercept([coreTail, { ...harness.userMessage }], 12000, value => { aborted = value === true; }, 'normal');
    assert.equal(selectorCalls, 1, scenario);
    assert.equal(aborted, false, scenario);
    assert.notEqual(result.lastRecall.status, 'skipped', scenario);
    if (scenario !== 'hostHidden') {
      assert.deepEqual(bodyMatch.coveredFloorIds, [], `${scenario}: 宽松来源关联不得污染严格去重`);
      assert.equal(bodyMatch.visibleFloorIds.some(floorId => floorId.startsWith('host-tail:1:')), true, scenario);
    }
  }
});

test('宽松就绪覆盖后 live 尾楼在选材期间变化会丢弃记忆注入但不停止正文', async () => {
  const raw = await singleFloorReachable({ text: '已经保存的前楼。', summary: '钟楼旧约已保存。' });
  let selectorCalls = 0, aborted = false;
  const harness = createRuntimeHarness({
    sourceReader: options => readRecallSource(options),
    reachableReader: async () => structuredClone(raw),
    selector: input => {
      selectorCalls += 1;
      const selection = selectRecall(input);
      harness.chat[1].mes = '选材期间尾楼正文已被替换。';
      return selection;
    },
  });
  const sharedExtra = { hostSource: 'chat' };
  const tail = { is_user: false, is_system: false, mes: '尚未登记的尾楼正文。', extra: sharedExtra };
  harness.chat.splice(0, harness.chat.length,
    { is_user: false, is_system: false, mes: '已经保存的前楼。' },
    tail,
    harness.userMessage,
  );
  const result = await harness.runtime.intercept([
    { ...tail, mes: '【楼层标题】\n尚未登记的尾楼正文。\n【推理注记】已完成。' },
    { ...harness.userMessage },
  ], 12000, value => { aborted = value === true; }, 'normal');
  assert.equal(selectorCalls, 1);
  assert.equal(aborted, false);
  assert.equal(result.lastRecall.status, 'stale');
  assert.deepEqual(result.lastRecall.skipReasons, ['narrativeChanged']);
  assert.ok(harness.prompts.every(call => call[1] === ''));
  assert.equal(harness.userMessage.extra?.[RECALL_RECEIPT_KEY], undefined);
});

test('真实 CSE 投影损坏只降级人物状态，已完整摘要仍可召回', async () => {
  const raw = await singleFloorReachable();
  raw.stateDeltas = [{
    id: 'broken-delta', floorId: 'floor-one', floorMemoryId: 'memory-one', recordStatus: 'active',
    subjectSnapshots: [{ subjectEntityId: PERSON, core: null, adaptive: [], situational: [] }],
  }];
  let selectorCalls = 0, aborted = false;
  const harness = createRuntimeHarness({
    sourceReader: options => readRecallSource(options),
    reachableReader: async () => structuredClone(raw),
    selector: input => { selectorCalls += 1; assert.deepEqual(input.source.currentState, []); return selectRecall(input); },
  });
  const result = await harness.runtime.intercept(structuredClone(harness.chat), 12000, value => { aborted = value === true; }, 'normal');
  assert.equal(selectorCalls, 1);
  assert.equal(aborted, false);
  assert.equal(result.lastRecall.status, 'empty');
});

test('首次准备超时或失败会 fresh 重试后成功，未初始化新聊天仍静默放行', async () => {
  const raw = await singleFloorReachable();
  for (const kind of ['timeout', 'failed']) {
    let prepareCalls = 0;
    const notifications = [];
    const harness = createRuntimeHarness({
      prepareMemory: async ({ preferCached }) => {
        prepareCalls += 1;
        assert.equal(preferCached, prepareCalls === 1, kind);
        if (prepareCalls === 1) return kind === 'timeout' ? new Promise(() => {}) : { status: 'error' };
        return { status: 'ready', reachable: structuredClone(raw) };
      },
      preparationTimeoutMs: 5,
      sourceReader: async () => ({ status: 'unavailable' }),
      rootReader: async () => ({ status: 'ready', revision: raw.rootRevision, data: structuredClone(raw.root) }),
      notifyUser: value => notifications.push(value),
    });
    let abortCalls = 0;
    const result = await harness.runtime.intercept(harness.chat, 12000, value => { if (value === true) abortCalls += 1; }, 'normal');
    assert.equal(prepareCalls, 2, kind);
    assert.equal(abortCalls, 0, kind);
    assert.equal(['ready', 'empty'].includes(result.lastRecall.status), true, `${kind}: ${JSON.stringify(result.lastRecall)}`);
    assert.deepEqual(notifications, [{ kind: 'warning', text: '记忆召回未完成，正在重试一次。' }], kind);
  }

  const freshChat = createRuntimeHarness({
    prepareMemory: async () => ({ status: 'uninitialized' }),
    sourceReader: async () => ({ status: 'unavailable' }),
  });
  let abortCalls = 0;
  const result = await freshChat.runtime.intercept(freshChat.chat, 12000, value => { if (value === true) abortCalls += 1; }, 'normal');
  assert.equal(abortCalls, 0);
  assert.deepEqual(result.lastRecall.skipReasons, ['sourceUnavailable']);
});

test('准备连续超时后停止正文，迟到失败不得再启动召回降级读取', async () => {
  let releasePreparation;
  const preparation = new Promise(resolve => { releasePreparation = () => resolve({ status: 'error' }); });
  let sourceReads = 0;
  const harness = createRuntimeHarness({
    prepareMemory: () => preparation,
    preparationTimeoutMs: 5,
    sourceReader: async () => { sourceReads += 1; return { status: 'unavailable' }; },
  });
  let abortCalls = 0;
  const result = await harness.runtime.intercept(harness.chat, 12000, value => { if (value === true) abortCalls += 1; }, 'normal');
  assert.deepEqual(result.lastRecall.skipReasons, ['error']);
  assert.equal(result.lastRecall.error.code, 'V3_RECALL_MEMORY_PREPARATION_TIMEOUT');
  assert.equal(abortCalls, 1);
  releasePreparation();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sourceReads, 0);
});

test('第一次后端准备失败、第二次utility失败时用尽同一两轮预算，不启动第三次', async () => {
  let sourceCalls = 0, utilityCalls = 0, abortCalls = 0;
  const harness = createRuntimeHarness({
    useDefaultSelector: true,
    sourceReader: async () => { sourceCalls += 1; return sourceCalls === 1 ? { status: 'unavailable' } : runtimeFixture(); },
    generateUtilityTask: async () => { utilityCalls += 1; throw Object.assign(new Error('第二轮 API 失败'), { code: 'UTILITY_FAILED' }); },
  });
  const result = await harness.runtime.intercept(harness.chat, 12000, value => { if (value === true) abortCalls += 1; }, 'normal');
  assert.equal(sourceCalls, 2);
  assert.equal(utilityCalls, 1);
  assert.equal(abortCalls, 1);
  assert.equal(result.lastRecall.error.code, 'UTILITY_FAILED');
});

test('准备挂起后取消或切聊天，迟到失败均不得启动召回降级读取', async () => {
  for (const mode of ['cancel', 'chatChanged']) {
    let releasePreparation;
    const preparation = new Promise(resolve => { releasePreparation = () => resolve({ status: 'error' }); });
    let sourceReads = 0;
    const harness = createRuntimeHarness({
      prepareMemory: () => preparation,
      sourceReader: async () => { sourceReads += 1; return { status: 'unavailable' }; },
    });
    const pending = harness.runtime.intercept(harness.chat, 12000, null, 'normal');
    await new Promise(resolve => setImmediate(resolve));
    if (mode === 'cancel') harness.runtime.invalidate('superseded');
    else harness.handlers.get('chat-changed')();
    releasePreparation();
    const result = await pending;
    assert.equal(result.lastRecall, null, mode);
    assert.equal(sourceReads, 0, mode);
  }
});

test('root 正常推进会 fresh 重投影并复核同一 actual core，不重跑 selector；新增摘要不使正文证明失效', async () => {
  const initial = await singleFloorReachable({ withMemory: false, revision: 1, head: 'head-before' });
  const current = await singleFloorReachable({ withMemory: true, revision: 2, head: 'head-after' });
  let prepareCalls = 0, selectorCalls = 0;
  const harness = createRuntimeHarness({
    prepareMemory: async ({ preferCached }) => {
      prepareCalls += 1;
      assert.equal(preferCached, prepareCalls === 1);
      return { status: 'ready', reachable: structuredClone(prepareCalls === 1 ? initial : current) };
    },
    rootReader: async () => ({ status: 'ready', revision: 2, data: structuredClone(current.root) }),
    selector: input => { selectorCalls += 1; return selectRecall(input); },
  });
  const result = await harness.runtime.intercept(structuredClone(harness.chat), 12000, null, 'normal');
  assert.equal(selectorCalls, 1);
  assert.equal(prepareCalls, 2, 'root 变化后必须 fresh 准备一次');
  assert.equal(result.lastRecall.status, 'empty');
});

test('最终提交前readRoot第一次技术失败会走同一整体重试，第二次成功后才注入', async () => {
  let sourceCalls = 0, rootCalls = 0, selectorCalls = 0, abortCalls = 0;
  const source = runtimeFixture();
  const harness = createRuntimeHarness({
    sourceReader: async () => { sourceCalls += 1; return structuredClone(source); },
    rootReader: async () => {
      rootCalls += 1;
      return rootCalls === 1
        ? { status: 'unavailable' }
        : { status: 'ready', revision: source.rootRevision, data: { chatId: source.chatId, narrativeGeneration: source.narrativeGeneration, headCheckpointId: source.headCheckpointId } };
    },
    selector: input => { selectorCalls += 1; return selectRecall(input); },
  });
  const result = await harness.runtime.intercept(harness.chat, 12000, value => { if (value === true) abortCalls += 1; }, 'normal');
  assert.equal(sourceCalls, 2);
  assert.equal(rootCalls, 2);
  assert.equal(selectorCalls, 2);
  assert.equal(abortCalls, 0);
  assert.equal(result.lastRecall.status, 'ready');
});

test('root 变化后 fresh winner 已删除选中楼时拒绝旧选择，正常无关推进仍允许注入', async () => {
  for (const removed of [false, true]) {
    const initial = await singleFloorReachable({ revision: 1, head: 'head-before' });
    const current = await singleFloorReachable({ revision: 2, head: 'head-after' });
    if (removed) { current.floors = []; current.floorMemories = []; }
    let prepareCalls = 0, selectorCalls = 0;
    const notifications = [];
    const harness = createRuntimeHarness({
      prepareMemory: async () => ({ status: 'ready', reachable: structuredClone(++prepareCalls === 1 ? initial : current) }),
      rootReader: async () => ({ status: 'ready', revision: 2, data: structuredClone(current.root) }),
      notifyUser: value => notifications.push(value),
      selector: input => { selectorCalls += 1; return selectRecall(input); },
    });
    harness.chat[0].is_hidden = true;
    let abortCalls = 0;
    const result = await harness.runtime.intercept([structuredClone(harness.userMessage)], 12000, value => { if (value === true) abortCalls += 1; }, 'normal');
    assert.equal(selectorCalls, 1, String(removed));
    assert.equal(prepareCalls, 2, String(removed));
    assert.equal(result.lastRecall.status, removed ? 'stale' : 'ready', String(removed));
    assert.equal(abortCalls, 0, String(removed));
    assert.equal(notifications.length, removed ? 1 : 0, String(removed));
    if (removed) {
      assert.deepEqual(result.lastRecall.skipReasons, ['selectedRefsChanged']);
      assert.ok(harness.prompts.every(call => call[1] === ''));
    }
  }
});

test('root 变化后的 fresh 准备失败会丢弃旧注入但正文继续', async () => {
  const initial = await singleFloorReachable();
  let prepareCalls = 0, abortCalls = 0;
  const notifications = [];
  const harness = createRuntimeHarness({
    prepareMemory: async () => ++prepareCalls === 1 ? { status: 'ready', reachable: structuredClone(initial) } : { status: 'error' },
    rootReader: async () => ({ status: 'ready', revision: 2, data: { ...structuredClone(initial.root), headCheckpointId: 'new-head' } }),
    notifyUser: value => notifications.push(value),
  });
  const result = await harness.runtime.intercept([structuredClone(harness.userMessage)], 12000, value => { if (value === true) abortCalls += 1; }, 'normal');
  assert.equal(result.lastRecall.status, 'stale');
  assert.deepEqual(result.lastRecall.skipReasons, ['sourceUnavailable']);
  assert.equal(abortCalls, 0);
  assert.equal(notifications.length, 1);
  assert.ok(harness.prompts.every(call => call[1] === ''));
});

test('root 变化后的 fresh 严格准备失败时可用同一次容错来源完成复核', async () => {
  const initial = await singleFloorReachable({ revision: 1, head: 'head-before' });
  const current = await singleFloorReachable({ revision: 2, head: 'head-after' });
  let prepareCalls = 0, fallbackReads = 0;
  const harness = createRuntimeHarness({
    prepareMemory: async () => ++prepareCalls === 1 ? { status: 'ready', reachable: structuredClone(initial) } : { status: 'error' },
    rootReader: async () => ({ status: 'ready', revision: 2, data: structuredClone(current.root) }),
    sourceReader: options => {
      fallbackReads += 1;
      return readRecallSource({ ...options, store: { readReachable: async () => structuredClone(current) } });
    },
  });
  const result = await harness.runtime.intercept(structuredClone(harness.chat), 12000, null, 'normal');
  assert.equal(prepareCalls, 2);
  assert.equal(fallbackReads, 1);
  assert.equal(result.lastRecall.status, 'empty', JSON.stringify(result.lastRecall));
});

test('runtime 在LLM选材等待中停止 generation 会丢弃结果，不以fallback复活旧BM25', async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const harness = createRuntimeHarness({
    useDefaultSelector: true,
    generateUtilityTask: async ({ signal }) => { entered(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })); },
  });
  harness.handlers.get('generation-started')('normal', null, false);
  const pending = harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  await started;
  harness.handlers.get('generation-stopped')();
  const result = await pending;
  assert.equal(result.lastRecall.status, 'stale');
  assert.deepEqual(result.lastRecall.skipReasons, ['stopped']);
  assert.ok(harness.prompts.every(call => call[1] === ''));
  assert.equal(harness.saves, 0);
});

test('runtime completed-empty 是可持久化、可恢复的完成态，且不写非空 prompt', async () => {
  const harness = createRuntimeHarness({ selector: ({ source }) => ({
    status: 'empty', floors: [], states: [], coverage: source.coverage, injectionText: '',
    stages: { input: 1, candidates: 0, dropRecent: 0, dropPersistent: 0, dropVisibility: 0, selected: 0, recentSummaryCount: 0, distantHistoryItemCount: 0, stateCount: 0 },
    skipReasons: [],
  }) });
  const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(result.lastRecall.status, 'empty');
  assert.equal(result.lastRecall.receiptPersistence, 'saveUnconfirmed');
  assert.equal(harness.saves, 1);
  assert.ok(harness.prompts.every(call => call[1] === ''));
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].completionStatus, 'empty');
  harness.runtime.invalidate('simulateReload');
  const restored = await harness.runtime.restorePersistedReceipt();
  assert.equal(restored.lastRecall.status, 'empty');
  assert.equal(restored.lastRecall.restoredReceipt, true);
  assert.equal(restored.recallStatus, 'empty');
  assert.notEqual(harness.contextWrappers.at(-1), harness.contextWrappers.at(-2), 'empty 恢复的前后 snapshot 必须使用不同 context wrapper');
});

test('runtime 最终校验对 chat、parent user、叙事 generation 和已选 FloorMemory 分别给出稳定原因并零注入', async () => {
  for (const [kind, expected] of [['chat', 'chatChanged'], ['user', 'userChanged'], ['narrative', 'narrativeChanged'], ['floorRef', 'selectedRefsChanged']]) {
    let harness, sourceCalls = 0;
    harness = createRuntimeHarness({
      sourceReader: async () => {
        const value = structuredClone(harness.source);
        sourceCalls += 1;
        if (sourceCalls === 1) return value;
        if (kind === 'chat') harness.context.chatMetadata.qianqianjie.chatId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
        if (kind === 'user') harness.userMessage.mes = '最终校验前已经换成另一条用户正文';
        if (kind === 'narrative') value.narrativeGeneration = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
        if (kind === 'floorRef') value.floorMemories = value.floorMemories.filter(memory => memory.floorId !== 'floor-2');
        return value;
      },
    });
    const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
    assert.equal(result.lastRecall.status, 'stale', kind);
    assert.deepEqual(result.lastRecall.skipReasons, [expected], kind);
    assert.ok(harness.prompts.every(call => call[1] === ''), kind);
    assert.equal(harness.saves, 0, kind);
  }
});

test('runtime 最终校验会拒绝内容身份已变化的已选 CSE 状态', async () => {
  const initial = reachable();
  const changed = structuredClone(initial);
  changed.stateDeltas[0].subjectSnapshots[0].situational[0].text = '已经变化的新状态';
  let sourceCalls = 0;
  const sourceReader = ({ now }) => readRecallSource({ now, store: { readReachable: async () => structuredClone(++sourceCalls === 1 ? initial : changed) } });
  const harness = createRuntimeHarness({
    sourceReader,
    selector: ({ source }) => ({
      status: 'ready', floors: [],
      states: [{ subjectEntityId: PERSON, subject: '裴晚生', layer: 'situational', towardEntityId: null, toward: null, ...source.currentState[0].situational[0] }],
      coverage: source.coverage, injectionText: '<qqj_recalled_context>旧状态</qqj_recalled_context>',
      stages: { input: 1, candidates: 1, dropRecent: 0, dropPersistent: 0, dropVisibility: 0, selected: 1 }, skipReasons: [],
    }),
  });
  const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(result.lastRecall.status, 'stale');
  assert.deepEqual(result.lastRecall.skipReasons, ['selectedRefsChanged']);
  assert.ok(harness.prompts.every(call => call[1] === ''));
});

test('runtime 将单次 reachable 来源读取带入可观察耗时诊断', async () => {
  const source = runtimeFixture();
  source.sourceReadAttempts = sourceAttempts('ready');
  const harness = createRuntimeHarness({ sourceReader: async () => structuredClone(source) });
  const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.deepEqual(result.lastRecall.timings.sourceReadAttempts, source.sourceReadAttempts);
});

test('runtime 刷新后从最新 user 楼恢复合法 schema12 completed 回执，仅作历史展示且不碰 prompt/save/source', async () => {
  let sourceCalls = 0, rootCalls = 0, currentHead = 'head', currentRevision = 1;
  const harness = createRuntimeHarness({
    sourceReader: async () => { sourceCalls += 1; return runtimeFixture(); },
    reachableReader: async () => { rootCalls += 1; const value = rawReachableFromSource(runtimeFixture()); value.rootRevision = currentRevision; value.root.headCheckpointId = currentHead; value.checkpoint.id = currentHead; return value; },
  });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const receipt = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
  harness.chat.push({ is_user: false, is_system: false, mes: '随后落盘的 AI 正文使当前 head 自然推进。' });
  currentHead = 'head-after-ai'; currentRevision = 2;
  harness.runtime.invalidate('simulateReload');
  const promptCount = harness.prompts.length;
  const saveCount = harness.saves;
  const sourceCount = sourceCalls;
  const rootCount = rootCalls;
  const result = await harness.runtime.restorePersistedReceipt();
  assert.equal(result.lastRecall.restoredReceipt, true);
  assert.equal(result.lastRecall.reusedReceipt, false);
  assert.equal(result.lastRecall.receiptPersistence, 'chatRecord');
  assert.deepEqual(result.lastRecall.selectedFloors, receipt.selectedFloors);
  assert.deepEqual(result.lastRecall.selectedStates, receipt.selectedStates);
  assert.deepEqual(result.lastRecall.coverage, receipt.coverage);
  assert.equal(result.lastRecall.injectionText, receipt.injectionText);
  assert.deepEqual(result.lastRecall.skipReasons, receipt.skipReasons);
  assert.equal(harness.prompts.length, promptCount, '恢复展示不得调用 setExtensionPrompt');
  assert.equal(harness.saves, saveCount, '恢复展示不得保存聊天');
  assert.equal(sourceCalls, sourceCount, '恢复展示不得重新读取当前 source/head');
  assert.equal(rootCalls, rootCount, '当前 head 已推进也不得拿实时 root 否定历史回执');
  assert.notEqual(harness.contextWrappers.at(-1), harness.contextWrappers.at(-2), 'ready 恢复的前后 snapshot 必须使用不同 context wrapper');
});

test('历史楼只读 projector 按每楼正文、chat、index 与自签回执核验，且不受当前插件版本推进影响', async () => {
  const harness = createRuntimeHarness();
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const receipt = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
  const index = receipt.userMessageIndex;
  const message = { is_user: true, is_system: false, mes: harness.userMessage.mes, extra: { [RECALL_RECEIPT_KEY]: receipt } };
  const projected = await projectHistoricalRecallReceipt(message, { chatId: CHAT, userMessageIndex: index });
  assert.equal(projected.restoredReceipt, true);
  assert.equal(projected.receiptPersistence, 'chatRecord');
  assert.equal(projected.injectionText, receipt.injectionText);
  assert.deepEqual(projected.selectedFloors, receipt.selectedFloors);
  assert.deepEqual(harness.runtime.getState().lastRecallBinding, { chatId: CHAT, userMessageIndex: index });

  assert.equal(await projectHistoricalRecallReceipt(message, { chatId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', userMessageIndex: index }), null);
  assert.equal(await projectHistoricalRecallReceipt(message, { chatId: CHAT, userMessageIndex: index + 1 }), null);
  const edited = { ...message, mes: `${message.mes}（已编辑）` };
  assert.equal(await projectHistoricalRecallReceipt(edited, { chatId: CHAT, userMessageIndex: index }), null);
  const changedPluginInCurrentCodeDoesNotMatter = await projectHistoricalRecallReceipt(message, { chatId: CHAT, userMessageIndex: index });
  assert.equal(changedPluginInCurrentCodeDoesNotMatter?.injectionText, receipt.injectionText);
  const tampered = structuredClone(message); tampered.extra[RECALL_RECEIPT_KEY].injectionText += '篡改';
  assert.equal(await projectHistoricalRecallReceipt(tampered, { chatId: CHAT, userMessageIndex: index }), null);
});

test('历史楼 projector 对旧 schema6/7/8/9 保持原签名展示和真实落盘恢复，但当前生成不能复用', async () => {
  for (const schemaVersion of [6, 7, 8, 9]) {
    let selectorCalls = 0;
    const harness = createRuntimeHarness({ selector: input => { selectorCalls += 1; return selectRecall(input); } });
    await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
    const old = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
    old.schemaVersion = schemaVersion;
    if (schemaVersion < 8) delete old.bodyMatchFingerprint;
    if (schemaVersion === 9) old.strategyVersion = 'continuity-v3';
    delete old.selectedCseChanges;
    delete old.selectorDiagnostic;
    delete old.timings;
    old.receiptFingerprint = await receiptFingerprint(old);
    const projected = await projectHistoricalRecallReceipt({ ...harness.userMessage, extra: { [RECALL_RECEIPT_KEY]: old } }, { chatId: CHAT, userMessageIndex: 1 });
    assert.equal(projected?.legacyReadOnly, undefined);
    assert.equal(projected?.restoredReceipt, true);
    assert.equal(projected?.injectionText, old.injectionText);

    harness.userMessage.extra[RECALL_RECEIPT_KEY] = old;
    harness.runtime.invalidate('simulateReload');
    const restored = await harness.runtime.restorePersistedReceipt();
    assert.equal(restored.lastRecall?.legacyReadOnly, true, `schema${schemaVersion} 只恢复历史展示`);
    await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
    assert.equal(selectorCalls, 2, `schema${schemaVersion} 不得作为当前生成可复用回执`);
  }
});

test('旧 continuity-v1/v2 schema9 回执只读展示和恢复，但新生成必须运行 continuity-v10 排除', async () => {
  for (const oldStrategy of ['continuity-v1', 'continuity-v2']) {
  let selectorCalls = 0;
  const harness = createRuntimeHarness({ selector: input => { selectorCalls += 1; return selectRecall(input); } });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const old = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
  old.schemaVersion = 9;
  old.strategyVersion = oldStrategy;
  delete old.selectedCseChanges;
  delete old.selectorDiagnostic;
  delete old.timings;
  old.receiptFingerprint = await receiptFingerprint(old);
  const projected = await projectHistoricalRecallReceipt({ ...harness.userMessage, extra: { [RECALL_RECEIPT_KEY]: old } }, { chatId: CHAT, userMessageIndex: 1 });
  assert.equal(projected?.restoredReceipt, true);
  assert.equal(projected?.injectionText, old.injectionText);
  harness.userMessage.extra[RECALL_RECEIPT_KEY] = old;
  harness.runtime.invalidate('simulateReload');
  const restored = await harness.runtime.restorePersistedReceipt();
  assert.equal(restored.lastRecall?.legacyReadOnly, true);
  await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(selectorCalls, 2, '旧策略回执不得作为新生成复用结果');
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].strategyVersion, 'continuity-v10');
  }
});

test('旧 continuity-v9 schema13 回执保留只读投影与冷恢复，regenerate 改用 continuity-v10', async () => {
  let selectorCalls = 0;
  const harness = createRuntimeHarness({ selector: input => { selectorCalls += 1; return selectRecall(input); } });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const old = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
  old.strategyVersion = 'continuity-v9';
  delete old.selectorDiagnostic.utilityRoundTripMs;
  delete old.selectorDiagnostic.localSelectionMs;
  delete old.stages.ordinaryEstimatedTokenBudget;
  old.receiptFingerprint = await receiptFingerprint(old);
  const projected = await projectHistoricalRecallReceipt({ ...harness.userMessage, extra: { [RECALL_RECEIPT_KEY]: structuredClone(old) } }, { chatId: CHAT, userMessageIndex: 1 });
  assert.equal(projected?.restoredReceipt, true);
  assert.equal(projected?.injectionText, old.injectionText);
  assert.deepEqual(projected?.selectedFloors, old.selectedFloors);
  harness.userMessage.extra[RECALL_RECEIPT_KEY] = old;
  harness.runtime.invalidate('simulateReload');
  const restored = await harness.runtime.restorePersistedReceipt();
  assert.equal(restored.lastRecall?.legacyReadOnly, true);
  assert.equal(restored.lastRecall?.injectionText, old.injectionText);
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].strategyVersion, 'continuity-v9', '只读恢复不得改写旧回执');
  await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(selectorCalls, 2, '旧 v9 回执不得被当前生成直接复用');
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].strategyVersion, 'continuity-v10');
});

test('旧 schema10 continuity-v5 回执保留只读展示，当前生成不复用并升级到 v10', async () => {
  let selectorCalls = 0;
  const harness = createRuntimeHarness({ selector: input => { selectorCalls += 1; return selectRecall(input); } });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const old = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
  old.schemaVersion = 10;
  old.strategyVersion = 'continuity-v5';
  for (const key of ['historyCandidateCount', 'stateCandidateCount', 'historyModelSelectedCount', 'stateModelSelectedCount']) delete old.selectorDiagnostic[key];
  old.receiptFingerprint = await receiptFingerprint(old);
  const projected = await projectHistoricalRecallReceipt({ ...harness.userMessage, extra: { [RECALL_RECEIPT_KEY]: old } }, { chatId: CHAT, userMessageIndex: 1 });
  assert.equal(projected?.restoredReceipt, true);
  assert.equal(projected?.schemaVersion, 10);
  assert.equal(projectInlineRecallReceipt(projected).floorCount, old.selectedFloors.length);
  harness.userMessage.extra[RECALL_RECEIPT_KEY] = old;
  harness.runtime.invalidate('simulateReload');
  const restored = await harness.runtime.restorePersistedReceipt();
  assert.equal(restored.lastRecall?.legacyReadOnly, true);
  assert.equal(restored.lastRecall?.schemaVersion, 10);
  await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(selectorCalls, 2);
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].strategyVersion, 'continuity-v10');
});

test('真实签名 schema11 continuity-v7 可历史投影与冷恢复，但 regenerate 必须重算 schema13 v10', async () => {
  let selectorCalls = 0, selectedSnapshot = null;
  const harness = createRuntimeHarness({ selector: input => { selectorCalls += 1; selectedSnapshot = selectRecall(input); return selectedSnapshot; } });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const old = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
  old.schemaVersion = 11;
  old.strategyVersion = 'continuity-v7';
  old.injectionText = formatRecallInjection({
    coverage: selectedSnapshot.coverage,
    floors: selectedSnapshot.floors,
    states: selectedSnapshot.states,
    cseChanges: selectedSnapshot.cseChanges,
    entityById: new Map(harness.source.entities.map(value => [value.entityId, value])),
  });
  delete old.storylines;
  old.selectedStates = old.selectedStates.map(({ storylineId: _storylineId, ...value }) => value);
  old.selectedCseChanges = old.selectedCseChanges.map(({ storylineId: _storylineId, ...value }) => value);
  for (const key of ['storylineCount', 'estimatedTokenCount', 'estimatedTokenBudget']) delete old.stages[key];
  old.receiptFingerprint = await receiptFingerprint(old);

  const projected = await projectHistoricalRecallReceipt({ ...harness.userMessage, extra: { [RECALL_RECEIPT_KEY]: structuredClone(old) } }, { chatId: CHAT, userMessageIndex: 1 });
  assert.equal(projected?.schemaVersion, 11);
  assert.equal(projected?.restoredReceipt, true);
  assert.equal(projectInlineRecallReceipt(projected).protocolRecognized, true);
  harness.userMessage.extra[RECALL_RECEIPT_KEY] = old;
  harness.runtime.invalidate('simulateReload');
  const restored = await harness.runtime.restorePersistedReceipt();
  assert.equal(restored.lastRecall?.schemaVersion, 11);
  assert.equal(restored.lastRecall?.legacyReadOnly, true);
  assert.equal(projectInlineRecallReceipt(restored.lastRecall).protocolRecognized, true);

  await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(selectorCalls, 2, 'schema11/v7只读回执不得被当前生成复用');
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].schemaVersion, 13);
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].strategyVersion, 'continuity-v10');
});

test('历史楼 projector 对 schema4 仅沿用既有 chat/index 只读边界，不迁移或伪造签名', async () => {
  const message = { is_user: true, mes: '旧楼正文', extra: { [RECALL_RECEIPT_KEY]: {
    schemaVersion: 4, chatId: CHAT, userMessageIndex: 7,
    injectionText: '<qqj_recalled_context>旧回执正文</qqj_recalled_context>',
    selectedFloors: [{ assistantSeq: 2 }, null], selectedStates: [],
  } } };
  const projected = await projectHistoricalRecallReceipt(message, { chatId: CHAT, userMessageIndex: 7 });
  assert.equal(projected.legacyReadOnly, true);
  assert.equal(projected.schemaVersion, 4);
  assert.equal(projected.injectionText.includes('旧回执正文'), true);
  assert.equal(await projectHistoricalRecallReceipt(message, { chatId: CHAT, userMessageIndex: 8 }), null);
  assert.equal(await projectHistoricalRecallReceipt(message, { chatId: 'wrong', userMessageIndex: 7 }), null);
});

test('runtime 从当前 user 楼宽松恢复 Schema 4 为只读历史，不注入、不保存且不进入 session receipt', async () => {
  let selectorCalls = 0, sourceCalls = 0;
  const harness = createRuntimeHarness({
    selector: input => { selectorCalls += 1; return selectRecall(input); },
    sourceReader: async () => { sourceCalls += 1; return runtimeFixture(); },
  });
  harness.userMessage.extra = { [RECALL_RECEIPT_KEY]: {
    schemaVersion: 4,
    chatId: CHAT,
    injectionText: '<qqj_recalled_context>Schema 4 历史正文</qqj_recalled_context>',
    selectedFloors: [{ assistantSeq: 2 }, null],
    selectedStates: [{ subject: '裴晚生', layer: 'core' }, null],
    promptCommitted: false,
  } };
  const promptCount = harness.prompts.length;
  const saveCount = harness.saves;
  const restored = await harness.runtime.restorePersistedReceipt();
  assert.equal(restored.lastRecall.legacyReadOnly, true);
  assert.equal(restored.lastRecall.userMessageIndex, null);
  assert.equal(restored.lastRecall.createdAt, null);
  assert.equal(restored.lastRecall.generationType, null);
  assert.equal(restored.lastRecall.injectionText.includes('Schema 4 历史正文'), true);
  assert.equal(harness.prompts.length, promptCount);
  assert.equal(harness.saves, saveCount);
  assert.equal(sourceCalls, 0);

  harness.runtime.clearCurrent();
  delete harness.userMessage.extra[RECALL_RECEIPT_KEY];
  await harness.runtime.intercept(harness.chat, 12000, null, 'continue');
  assert.equal(selectorCalls, 1, 'Schema 4 只读展示不得成为可复用 session receipt');
  assert.equal(sourceCalls, 2);

  harness.runtime.invalidate('nextCase');
  harness.userMessage.extra[RECALL_RECEIPT_KEY] = { schemaVersion: 4, chatId: 'wrong-chat', injectionText: '跨聊天旧记录' };
  await harness.runtime.restorePersistedReceipt();
  assert.equal(harness.runtime.getState().lastRecall, null);
  harness.userMessage.extra[RECALL_RECEIPT_KEY] = { schemaVersion: 4, chatId: CHAT, injectionText: { text: '不是字符串' } };
  await harness.runtime.restorePersistedReceipt();
  assert.equal(harness.runtime.getState().lastRecall, null);
});

test('runtime 恢复会拒绝 schema/plugin、回执内容、user 正文、chatId 或 fingerprint 不一致', async () => {
  const harness = createRuntimeHarness();
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const original = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
  harness.runtime.invalidate('simulateReload');
  const cases = [
    receipt => { receipt.schemaVersion = 3; },
    receipt => { receipt.pluginVersion = '0.0.0'; },
    receipt => { receipt.injectionText += '\n篡改'; },
    receipt => { receipt.receiptFingerprint = 'sha256:bad'; },
  ];
  for (const mutate of cases) {
    const receipt = structuredClone(original); mutate(receipt); harness.userMessage.extra[RECALL_RECEIPT_KEY] = receipt;
    await harness.runtime.restorePersistedReceipt();
    assert.equal(harness.runtime.getState().lastRecall, null);
  }
  harness.userMessage.extra[RECALL_RECEIPT_KEY] = structuredClone(original);
  harness.userMessage.mes += '正文已改';
  await harness.runtime.restorePersistedReceipt();
  assert.equal(harness.runtime.getState().lastRecall, null);
  harness.userMessage.mes = '阿裴，我们回钟楼赴约。';
  harness.context.chatMetadata.qianqianjie.chatId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  await harness.runtime.restorePersistedReceipt();
  assert.equal(harness.runtime.getState().lastRecall, null);
  harness.context.chatMetadata.qianqianjie.chatId = CHAT;
  harness.chat.push({ is_user: true, is_system: false, mes: '阿裴，我们回钟楼赴约。', extra: { [RECALL_RECEIPT_KEY]: structuredClone(original) } });
  await harness.runtime.restorePersistedReceipt();
  assert.equal(harness.runtime.getState().lastRecall, null, '即使正文相同，回执也不能跨 user 楼身份搬用');
});

test('runtime 即使畸形展示字段重算了完整指纹也拒绝恢复，UI 不会收到 null 楼项', async () => {
  const harness = createRuntimeHarness();
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const malformed = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
  malformed.selectedFloors = [null];
  malformed.receiptFingerprint = await receiptFingerprint(malformed);
  harness.userMessage.extra[RECALL_RECEIPT_KEY] = malformed;
  harness.runtime.invalidate('simulateReload');
  await harness.runtime.restorePersistedReceipt();
  assert.equal(harness.runtime.getState().lastRecall, null);
});

test('runtime restore 在指纹 await 期间原始回执变形时只使用同步隔离的已签快照', async () => {
  let armed = false, releaseDigest, enteredDigest;
  const entered = new Promise(resolve => { enteredDigest = resolve; });
  const fingerprint = async value => {
    if (armed && String(value).startsWith(`[13,"${TEST_PLUGIN_VERSION}"`)) {
      enteredDigest();
      await new Promise(resolve => { releaseDigest = resolve; });
    }
    return fingerprintText(value);
  };
  const harness = createRuntimeHarness({ fingerprint });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const originalInjection = harness.userMessage.extra[RECALL_RECEIPT_KEY].injectionText;
  harness.runtime.invalidate('simulateReload');
  armed = true;
  const restoring = harness.runtime.restorePersistedReceipt();
  await entered;
  harness.userMessage.extra[RECALL_RECEIPT_KEY].selectedFloors = [null];
  harness.userMessage.extra[RECALL_RECEIPT_KEY].injectionText = '未签名的中途篡改';
  releaseDigest();
  const result = await restoring;
  assert.equal(result.lastRecall?.restoredReceipt, true);
  assert.equal(result.lastRecall.injectionText, originalInjection);
  assert.ok(result.lastRecall.selectedFloors.every(value => value && typeof value === 'object'));
});

test('runtime restore 验签期间回执 key 换代时旧恢复安静退出，下一次只展示完整重签 NEW', async () => {
  let armed = false, releaseDigest, enteredDigest;
  const entered = new Promise(resolve => { enteredDigest = resolve; });
  const fingerprint = async value => {
    if (armed && String(value).startsWith(`[13,"${TEST_PLUGIN_VERSION}"`)) {
      enteredDigest();
      await new Promise(resolve => { releaseDigest = resolve; });
    }
    return fingerprintText(value);
  };
  const harness = createRuntimeHarness({ fingerprint });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const oldReceipt = harness.userMessage.extra[RECALL_RECEIPT_KEY];
  const newerReceipt = structuredClone(oldReceipt);
  newerReceipt.injectionText = '<qqj_recalled_context>完整重签的 NEW 回执</qqj_recalled_context>';
  newerReceipt.createdAt = '2026-09-03T00:00:01.000Z';
  newerReceipt.receiptFingerprint = await receiptFingerprint(newerReceipt);
  harness.runtime.invalidate('simulateReload');
  armed = true;
  const restoringOld = harness.runtime.restorePersistedReceipt();
  await entered;
  harness.userMessage.extra = { ...harness.userMessage.extra, [RECALL_RECEIPT_KEY]: newerReceipt };
  armed = false;
  releaseDigest();
  await restoringOld;
  assert.equal(harness.runtime.getState().lastRecall, null, 'key 已换代时 OLD 不得提交到展示状态');
  const restoredNew = await harness.runtime.restorePersistedReceipt();
  assert.equal(restoredNew.lastRecall?.restoredReceipt, true);
  assert.equal(restoredNew.lastRecall.injectionText, newerReceipt.injectionText);
  assert.notEqual(restoredNew.lastRecall.injectionText, oldReceipt.injectionText);
});

test('runtime reuse 在指纹 await 期间原地篡改回执时绝不注入未签文本', async () => {
  let armed = false, releaseDigest, enteredDigest;
  const entered = new Promise(resolve => { enteredDigest = resolve; });
  const fingerprint = async value => {
    if (armed && String(value).startsWith(`[13,"${TEST_PLUGIN_VERSION}"`)) {
      enteredDigest();
      await new Promise(resolve => { releaseDigest = resolve; });
    }
    return fingerprintText(value);
  };
  const harness = createRuntimeHarness({ fingerprint });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const originalInjection = harness.userMessage.extra[RECALL_RECEIPT_KEY].injectionText;
  armed = true;
  const reusing = harness.runtime.intercept(harness.chat, 12000, null, 'continue');
  await entered;
  harness.userMessage.extra[RECALL_RECEIPT_KEY].injectionText = '未签名恶意注入';
  harness.userMessage.extra[RECALL_RECEIPT_KEY].selectedFloors = [null];
  releaseDigest();
  const result = await reusing;
  assert.equal(result.lastRecall.reusedReceipt, true);
  assert.equal(result.lastRecall.injectionText, originalInjection);
  assert.equal(harness.prompts.at(-1)[1], originalInjection);
  assert.ok(harness.prompts.every(call => !String(call[1]).includes('未签名恶意注入')));
});

test('runtime 迟到恢复任务不能覆盖已开始并完成的新 interceptor', async () => {
  const harness = createRuntimeHarness();
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  harness.runtime.invalidate('simulateReload');
  let started = false, nextRun;
  harness.setSnapshotHook(() => {
    if (started) return;
    started = true;
    harness.setSnapshotHook(null);
    nextRun = harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  });
  await harness.runtime.restorePersistedReceipt();
  await nextRun;
  const state = harness.runtime.getState();
  assert.equal(state.lastRecall.status, 'ready');
  assert.equal(state.lastRecall.restoredReceipt, false);
  assert.equal(state.lastRecall.reusedReceipt, false);
});

test('runtime 新 interceptor 一开始就接管并隐藏已恢复的历史回执', async () => {
  let releaseSource;
  const pendingSource = new Promise(resolve => { releaseSource = resolve; });
  let sourceCalls = 0;
  const harness = createRuntimeHarness({ sourceReader: async () => (++sourceCalls <= 2 ? runtimeFixture() : pendingSource) });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  harness.runtime.invalidate('simulateReload');
  await harness.runtime.restorePersistedReceipt();
  assert.equal(harness.runtime.getState().lastRecall.restoredReceipt, true);
  const nextRun = harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(harness.runtime.getState().recallStatus, 'running');
  assert.equal(harness.runtime.getState().lastRecall, null);
  releaseSource(runtimeFixture());
  await nextRun;
  assert.equal(harness.runtime.getState().lastRecall.restoredReceipt, false);
});

test('runtime 未映射 core 新增不改变来源排除集，regenerate/swipe/continue 复用同一收据', async () => {
  let selectorCalls = 0;
  const harness = createRuntimeHarness({ selector: input => { selectorCalls += 1; return selectRecall(input); } });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  harness.chat.push({ is_user: false, is_system: false, mes: '本次生成出的 AI 正文，continue 时已在 user 楼之后。' });
  for (const [type, expectedReuse] of [['regenerate', true], ['swipe', true], ['continue', true]]) {
    const result = await harness.runtime.intercept(harness.chat, 12000, null, type);
    assert.equal(result.lastRecall.reusedReceipt, expectedReuse, type);
    assert.equal(result.lastRecall.generationType, type);
  }
  assert.equal(selectorCalls, 1);
  assert.equal(harness.saves, 1);
  assert.equal(harness.prompts.filter(call => call[1]).length, 4);
});

test('runtime 同 root 下人工映射变化会改 session key，新的召回重新选择且不改历史回执', async () => {
  let selectorCalls = 0;
  let projection = { identityRedirectsByEntityId: {}, deletedEntityIds: [] };
  const original = runtimeFixture();
  const harness = createRuntimeHarness({
    identityProjectionProvider: async () => structuredClone(projection),
    sourceReader: async ({ identityProjection }) => ({ ...structuredClone(original), identityProjection: structuredClone(identityProjection) }),
    selector: input => { selectorCalls += 1; return selectRecall(input); },
  });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const historicalReceipt = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
  projection = { identityRedirectsByEntityId: { [PERSON]: '99999999-9999-4999-8999-999999999999' }, deletedEntityIds: [] };
  const next = await harness.runtime.intercept(harness.chat, 12000, null, 'continue');
  assert.equal(selectorCalls, 2); assert.equal(next.lastRecall.reusedReceipt, false);
  assert.deepEqual(historicalReceipt.selectedFloors, harness.userMessage.extra[RECALL_RECEIPT_KEY].selectedFloors, '旧快照内容本身不因映射被原地改写');
});

test('runtime 内容、来源 head/revision 或已选引用改变时都拒绝旧收据', async () => {
  let selectorCalls = 0;
  let currentSource = runtimeFixture();
  const harness = createRuntimeHarness({
    sourceReader: async () => structuredClone(currentSource),
    reachableReader: async () => rawReachableFromSource(currentSource),
    selector: input => { selectorCalls += 1; return selectRecall(input); },
  });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  harness.runtime.invalidate('simulateReload');
  harness.userMessage.extra[RECALL_RECEIPT_KEY].injectionText = '已被篡改的注入';
  await harness.runtime.intercept(harness.chat, 12000, null, 'continue');
  assert.equal(selectorCalls, 2, '收据正文与完整性指纹不符必须重算');
  harness.userMessage.mes = '阿裴，我们现在回钟楼赴约。';
  harness.chat[1].mes = harness.userMessage.mes;
  await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(selectorCalls, 3, '用户内容变化必须重算');
  currentSource = { ...currentSource, headCheckpointId: 'changed-head', rootRevision: 2 };
  await harness.runtime.intercept(harness.chat, 12000, null, 'continue');
  assert.equal(selectorCalls, 4, '新 head 必须拒绝旧图生成的 ready/empty 收据');
  currentSource = { ...currentSource, floorMemories: currentSource.floorMemories.filter(value => value.assistantSeq !== 2) };
  await harness.runtime.intercept(harness.chat, 12000, null, 'swipe');
  assert.equal(selectorCalls, 5, '选中引用不再存在时必须重算');
});

test('runtime disabled/quiet/impersonate/无 user 均安全清槽跳过，且从不碰 source 或 abort', async () => {
  let sourceCalls = 0, abortCalls = 0;
  const harness = createRuntimeHarness({ sourceReader: async () => { sourceCalls += 1; return runtimeFixture(); } });
  await harness.runtime.setEnabled(false);
  let result = await harness.runtime.intercept(harness.chat, 12000, () => { abortCalls += 1; }, 'normal');
  assert.deepEqual(result.lastRecall.skipReasons, ['disabled']);
  await harness.runtime.setEnabled(true);
  for (const type of ['quiet', 'impersonate']) {
    result = await harness.runtime.intercept(harness.chat, 12000, () => { abortCalls += 1; }, type);
    assert.deepEqual(result.lastRecall.skipReasons, [type]);
  }
  harness.chat.splice(0, harness.chat.length, { is_user: false, is_system: false, mes: '只有 AI' });
  result = await harness.runtime.intercept(harness.chat, 12000, () => { abortCalls += 1; }, 'normal');
  assert.deepEqual(result.lastRecall.skipReasons, ['emptyUserInput']);
  assert.equal(sourceCalls, 0);
  assert.equal(abortCalls, 0);
  assert.ok(harness.prompts.every(call => call[1] === ''));
});

test('runtime 对真实 sourceUnavailable 重试后停止，sourceStale 仍按来源变化放行', async () => {
  for (const [status, reason, expectedCalls, expectedAborts] of [
    ['unavailable', 'error', 2, 1],
    ['stale', 'sourceStale', 1, 0],
  ]) {
    let selectorCalls = 0, sourceCalls = 0, abortCalls = 0;
    const attempts = sourceAttempts(status === 'stale' ? 'stale' : 'unavailable');
    const harness = createRuntimeHarness({
      sourceReader: async () => { sourceCalls += 1; return { status, sourceReadAttempts: attempts }; },
      selector: () => { selectorCalls += 1; throw new Error('不可执行 selector'); },
    });
    const result = await harness.runtime.intercept(harness.chat, 12000, value => { if (value === true) abortCalls += 1; }, 'normal');
    assert.deepEqual(result.lastRecall.skipReasons, [reason]);
    assert.deepEqual(result.lastRecall.timings.sourceReadAttempts, attempts);
    assert.equal(sourceCalls, expectedCalls);
    assert.equal(abortCalls, expectedAborts);
    assert.equal(selectorCalls, 0);
    assert.equal(harness.saves, 0);
    assert.ok(harness.prompts.every(call => call[1] === ''));
  }
});

test('runtime source异常整体只重试一次，清旧注入、停止正文并只暴露安全错误', async () => {
  let fail = false, failedReads = 0, abortCalls = 0;
  const harness = createRuntimeHarness({ sourceReader: async () => {
    if (fail) { failedReads += 1; throw Object.assign(new Error('token=sk-secret-1234567890'), { code: 'SOURCE_FAILED' }); }
    return runtimeFixture();
  } });
  await harness.runtime.intercept(harness.chat, 12000, () => { abortCalls += 1; }, 'normal');
  assert.ok(harness.prompts.at(-1)[1]);
  fail = true;
  const result = await harness.runtime.intercept(harness.chat, 12000, () => { abortCalls += 1; }, 'normal');
  assert.equal(result.recallStatus, 'error');
  assert.equal(result.lastRecall.injectionText, '');
  assert.equal(harness.prompts.at(-1)[1], '');
  assert.equal(result.lastRecallError.code, 'SOURCE_FAILED');
  assert.doesNotMatch(result.lastRecallError.message, /sk-secret/);
  assert.equal(failedReads, 2);
  assert.equal(abortCalls, 1);
});

test('runtime 旧异步请求迟到不得覆盖或清除新 generation 的 prompt', async () => {
  let resolveFirst;
  const first = new Promise(resolve => { resolveFirst = resolve; });
  let calls = 0;
  const harness = createRuntimeHarness({ sourceReader: async () => (++calls === 1 ? first : runtimeFixture()) });
  const oldRun = harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  await new Promise(resolve => setImmediate(resolve));
  const newRun = harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  await newRun;
  const newestPrompt = harness.prompts.at(-1)[1];
  assert.ok(newestPrompt);
  resolveFirst(runtimeFixture());
  await oldRun;
  assert.equal(harness.prompts.at(-1)[1], newestPrompt);
  assert.equal(harness.runtime.getState().lastRecall.status, 'ready');
});

test('runtime 旧 generation 的 END 不清新槽；新 generation END 才清理', async () => {
  const harness = createRuntimeHarness();
  harness.handlers.get('generation-started')('normal');
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  harness.handlers.get('generation-started')('normal');
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const newestPrompt = harness.prompts.at(-1)[1];
  harness.handlers.get('generation-ended')();
  assert.equal(harness.prompts.at(-1)[1], newestPrompt, '旧 generation 清理不得碰新槽');
  harness.handlers.get('generation-ended')();
  assert.equal(harness.prompts.at(-1)[1], '', '当前 generation 结束后必须清槽');
});

test('runtime 递归 normal→continue 多次 START 但最终单 END 会清整条链和当前槽', async () => {
  const harness = createRuntimeHarness();
  harness.handlers.get('generation-started')('normal');
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  harness.chat.push({ is_user: false, is_system: false, mes: '外层已生成片段' });
  harness.handlers.get('generation-started')('continue');
  await harness.runtime.intercept(harness.chat, 12000, null, 'continue');
  assert.ok(harness.prompts.at(-1)[1]);
  harness.handlers.get('generation-ended')();
  assert.equal(harness.prompts.at(-1)[1], '');
  harness.handlers.get('generation-ended')();
  assert.equal(harness.prompts.at(-1)[1], '', '多余旧 cleanup 也不得恢复或误清新内容');
});

test('runtime 内层 continue 读取中 STOP 会取消当前 token，不能错停外层后再迟到注入', async () => {
  let resolveInner, calls = 0;
  const inner = new Promise(resolve => { resolveInner = resolve; });
  const harness = createRuntimeHarness({ sourceReader: async () => (++calls <= 2 ? runtimeFixture() : inner) });
  harness.handlers.get('generation-started')('normal');
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  harness.handlers.get('generation-started')('continue');
  const continuing = harness.runtime.intercept(harness.chat, 12000, null, 'continue');
  await new Promise(resolve => setImmediate(resolve));
  harness.handlers.get('generation-stopped')();
  resolveInner(runtimeFixture());
  await continuing;
  assert.equal(harness.prompts.at(-1)[1], '');
  assert.equal(harness.prompts.filter(call => call[1]).length, 1, '内层 STOP 后不得出现第二次非空注入');
  assert.equal(harness.runtime.getState().activeRecall, null);
});

test('runtime STOP 后新 START 不受阻；迟到旧 END 只消费 tombstone，不清新槽', async () => {
  const harness = createRuntimeHarness();
  harness.handlers.get('generation-started')('normal');
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  harness.handlers.get('generation-stopped')();
  assert.equal(harness.prompts.at(-1)[1], '', 'STOP 必须先清理旧槽');
  harness.handlers.get('generation-started')('normal');
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const newestPrompt = harness.prompts.at(-1)[1];
  assert.ok(newestPrompt, '普通 STOP 不得阻碍下一次 START');
  harness.handlers.get('generation-ended')();
  assert.equal(harness.prompts.at(-1)[1], newestPrompt, '旧链迟到 END 只能消费已停止标识');
  harness.handlers.get('generation-ended')();
  assert.equal(harness.prompts.at(-1)[1], '', '新链自己的 END 才能清理新槽');
});

test('runtime 两个 START 都先于 interceptor 时仍给 generation 分配不同 token', async () => {
  const harness = createRuntimeHarness();
  harness.handlers.get('generation-started')('normal');
  harness.handlers.get('generation-started')('normal');
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const newestPrompt = harness.prompts.at(-1)[1];
  harness.handlers.get('generation-ended')();
  assert.equal(harness.prompts.at(-1)[1], newestPrompt, '先结束的旧 generation 不得清新 token');
  harness.handlers.get('generation-ended')();
  assert.equal(harness.prompts.at(-1)[1], '');
});

test('runtime 忽略 dry-run START；STOP 在读取完成前会取消本 generation，迟到结果不得注入', async () => {
  let resolveSource;
  const sourcePending = new Promise(resolve => { resolveSource = resolve; });
  const harness = createRuntimeHarness({ sourceReader: async () => sourcePending });
  harness.handlers.get('generation-started')('normal', {}, true);
  harness.handlers.get('generation-started')('normal', {}, false);
  const run = harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  await new Promise(resolve => setImmediate(resolve));
  harness.handlers.get('generation-stopped')();
  resolveSource(runtimeFixture());
  const result = await run;
  assert.ok(harness.prompts.every(call => call[1] === ''), 'STOP 后迟到 source 不得注入');
  assert.equal(harness.runtime.getState().activeRecall, null);
  assert.deepEqual(result.lastRecall.skipReasons, ['stopped']);
  harness.handlers.get('generation-ended')();
});

test('runtime START 后、interceptor 前收到 STOP 时消费 stopped lifecycle，绝不启动来源读取或注入', async () => {
  let sourceCalls = 0;
  const harness = createRuntimeHarness({ sourceReader: async () => { sourceCalls += 1; return runtimeFixture(); } });
  harness.handlers.get('generation-started')('normal');
  harness.handlers.get('generation-stopped')();
  const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(sourceCalls, 0);
  assert.deepEqual(result.lastRecall.skipReasons, ['stopped']);
  assert.ok(harness.prompts.every(call => call[1] === ''));
  harness.handlers.get('generation-ended')();
});

test('runtime 无 saveChat 时保留 session-only；未映射 core 新增复用，严格覆盖变化才重算', async () => {
  let selectorCalls = 0;
  const harness = createRuntimeHarness({ saveChat: false, selector: input => { selectorCalls += 1; return selectRecall(input); } });
  let result = await harness.runtime.intercept(structuredClone(harness.chat), 12000, null, 'normal');
  assert.equal(result.lastRecall.receiptPersistence, 'sessionOnly');
  harness.chat.push({ is_user: false, is_system: false, mes: '本轮正常追加的 assistant 正文。' });
  harness.handlers.get('message-edited')(harness.chat.length);
  result = await harness.runtime.intercept(structuredClone(harness.chat), 12000, null, 'continue');
  assert.equal(result.lastRecall.reusedReceipt, true);
  assert.equal(selectorCalls, 1);
  harness.chat[0].extra = { anotherPlugin: true };
  harness.chat[0].is_hidden = true;
  harness.handlers.get('message-edited')(harness.chat.length);
  assert.ok(harness.prompts.at(-1)[1]);
  assert.equal(harness.runtime.getState().lastRecall?.status, 'ready');
  result = await harness.runtime.intercept(structuredClone(harness.chat), 12000, null, 'continue');
  assert.equal(result.lastRecall.reusedReceipt, false);
  assert.equal(selectorCalls, 2);
  harness.chat[0].mes = 'assistant 正文真的改变';
  harness.handlers.get('message-edited')(harness.chat.length);
  assert.equal(harness.runtime.getState().lastRecall?.status, 'ready', '正文变化只失效活动数据，不抹历史展示');
  result = await harness.runtime.intercept(structuredClone(harness.chat), 12000, null, 'continue');
  assert.equal(result.lastRecall.reusedReceipt, true);
  assert.equal(selectorCalls, 2);
});

test('runtime 长聊天绑定不遍历或复制整张 playable 正文，只保留 parent user 最小事实', async () => {
  let oldMessageReads = 0;
  const queryBuilder = () => Object.freeze({
    text: '用户：阿裴，我们回钟楼赴约。',
    latestUserText: '阿裴，我们回钟楼赴约。',
    latestUserCoreIndex: 1,
    messageCount: 1,
    assistantTurns: 0,
  });
  const harness = createRuntimeHarness({ queryBuilder });
  const oldMessages = Array.from({ length: 500 }, (_, index) => {
    const message = { is_user: false, is_system: false };
    Object.defineProperty(message, 'mes', { enumerable: true, get() { oldMessageReads += 1; return `不应被召回运行时复制的旧正文 ${index}`; } });
    return message;
  });
  harness.chat.unshift(...oldMessages);
  const result = await harness.runtime.intercept(structuredClone(harness.chat.slice(-2)), 12000, null, 'normal');
  assert.equal(result.lastRecall.status, 'ready');
  assert.equal(oldMessageReads, 3, '三次 live 校验各只读取一条紧邻边界，不得遍历或复制整张长聊天正文');
});

test('runtime MESSAGE_DELETED 不把首参 chat.length 当下标；assistant 删除移位保留展示，parent user 删除/替换清展示', async () => {
  const shifted = createRuntimeHarness();
  await shifted.runtime.intercept(shifted.chat, 12000, null, 'normal');
  const completed = shifted.runtime.getState().lastRecall;
  shifted.chat.splice(0, 1);
  shifted.handlers.get('message-deleted')(shifted.chat.length);
  assert.equal(shifted.runtime.getState().lastRecall, completed, '删除早期 assistant 后 parent user 仍是同一对象，不受移动后的下标干扰');
  shifted.chat.splice(0, 1);
  shifted.handlers.get('message-deleted')(shifted.chat.length);
  assert.equal(shifted.runtime.getState().lastRecall, null, 'parent user 已不存在时必须清展示');

  const replaced = createRuntimeHarness();
  await replaced.runtime.intercept(replaced.chat, 12000, null, 'normal');
  replaced.chat[1] = { ...replaced.userMessage };
  replaced.handlers.get('message-edited')(replaced.chat.length);
  assert.equal(replaced.runtime.getState().lastRecall, null, '正文相同但 parent user 对象已替换也必须清展示');
});

test('runtime 用 live 最小 frame 守卫克隆 coreChat：extra/远期正文不取消，相关正文或隐藏变化零注入', async () => {
  for (const change of ['metadataOnly', 'distantContent', 'relevantHidden', 'relevantContent']) {
    let releaseSource;
    const pending = new Promise(resolve => { releaseSource = resolve; });
    const harness = createRuntimeHarness({ sourceReader: async () => pending });
    harness.chat.unshift(
      { is_user: false, is_system: false, mes: '远期 assistant 正文，不属于最近一个 turn。' },
      { is_user: true, is_system: false, mes: '远期 user 正文。' },
    );
    const clonedCoreChat = structuredClone(harness.chat);
    clonedCoreChat[2].mes = '宿主 regex 后交给 selector 的克隆正文，与 live 原文不要求全等。';
    const run = harness.runtime.intercept(clonedCoreChat, 12000, null, 'normal');
    await new Promise(resolve => setImmediate(resolve));
    if (change === 'metadataOnly') {
      harness.chat[2].extra = { anotherPlugin: { refreshed: true } };
    } else if (change === 'distantContent') harness.chat[0].mes = '远期 assistant 正文已变化，但不影响本轮 query frame';
    else if (change === 'relevantHidden') harness.chat[2].is_hidden = true;
    else harness.chat[2].mes = '相关 assistant live 正文已变化';
    harness.handlers.get('message-edited')(harness.chat.length);
    if (!['relevantHidden', 'relevantContent'].includes(change)) assert.equal(harness.runtime.getState().recallStatus, 'running');
    releaseSource(runtimeFixture());
    const result = await run;
    if (!['relevantHidden', 'relevantContent'].includes(change)) {
      assert.equal(result.lastRecall.status, 'ready');
      assert.ok(harness.prompts.at(-1)[1]);
    } else {
      assert.equal(result.recallStatus, 'idle');
      assert.ok(harness.prompts.every(call => call[1] === ''));
    }
  }
});

test('runtime 宿主保存正常返回后保留未确认 session 回执，消息 extra 消失时同页仍复用', async () => {
  let selectorCalls = 0;
  const harness = createRuntimeHarness({ selector: input => { selectorCalls += 1; return selectRecall(input); } });
  const fresh = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(fresh.lastRecall.receiptPersistence, 'saveUnconfirmed');
  delete harness.userMessage.extra[RECALL_RECEIPT_KEY];
  const result = await harness.runtime.intercept(harness.chat, 12000, null, 'continue');
  assert.equal(result.lastRecall.reusedReceipt, true);
  assert.equal(result.lastRecall.receiptPersistence, 'saveUnconfirmed');
  assert.equal(selectorCalls, 1);
});

test('宿主保存同样返回 undefined 时，只有聊天副本实际包含回执的新 runtime 才能恢复', async () => {
  const beforeSaveChat = null;
  const swallowed = createRuntimeHarness({ saveChat: async () => undefined });
  const originalOfflineChat = structuredClone(swallowed.chat);
  const swallowedResult = await swallowed.runtime.intercept(swallowed.chat, 12000, null, 'normal');
  assert.equal(swallowedResult.lastRecall.receiptPersistence, 'saveUnconfirmed');
  assert.equal(swallowed.saves, 1);

  let missingSourceReads = 0;
  const missingReload = createRuntimeHarness({ sourceReader: async () => { missingSourceReads += 1; return runtimeFixture(); } });
  missingReload.chat.splice(0, missingReload.chat.length, ...originalOfflineChat);
  const missing = await missingReload.runtime.restorePersistedReceipt();
  assert.equal(missing.lastRecall, beforeSaveChat);
  assert.equal(missingSourceReads, 0);
  assert.equal(missingReload.saves, 0);
  assert.equal(missingReload.prompts.length, 0);

  let persistedChat = null;
  const copied = createRuntimeHarness({ saveChat: async ({ chat }) => { persistedChat = structuredClone(chat); } });
  const copiedResult = await copied.runtime.intercept(copied.chat, 12000, null, 'normal');
  assert.equal(copiedResult.lastRecall.receiptPersistence, 'saveUnconfirmed');
  assert.ok(persistedChat?.[1]?.extra?.[RECALL_RECEIPT_KEY]);

  let restoredSourceReads = 0;
  const persistedReload = createRuntimeHarness({ sourceReader: async () => { restoredSourceReads += 1; return runtimeFixture(); } });
  persistedReload.chat.splice(0, persistedReload.chat.length, ...persistedChat);
  const restored = await persistedReload.runtime.restorePersistedReceipt();
  assert.equal(restored.lastRecall.restoredReceipt, true);
  assert.equal(restored.lastRecall.receiptPersistence, 'chatRecord');
  assert.equal(restoredSourceReads, 0);
  assert.equal(persistedReload.saves, 0);
  assert.equal(persistedReload.prompts.length, 0);
});

test('runtime generation end 只清 prompt 并保留展示；parent user 编辑与切聊天才清历史结果', async () => {
  const harness = createRuntimeHarness();
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const completed = harness.runtime.getState().lastRecall;
  harness.handlers.get('generation-ended')();
  assert.equal(harness.prompts.at(-1)[1], '');
  assert.equal(harness.runtime.getState().lastRecall, completed);

  harness.handlers.get('message-edited')(0, { messageIndex: 0 });
  assert.equal(harness.runtime.getState().lastRecall, completed, 'assistant 编辑不得抹掉上一轮完成展示');
  harness.userMessage.mes = '被编辑的 parent user 正文';
  harness.handlers.get('message-edited')(1, { messageIndex: 1 });
  assert.equal(harness.runtime.getState().lastRecall, null, 'parent user 编辑必须清除失效展示');

  harness.userMessage.mes = '阿裴，我们回钟楼赴约。';
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.ok(harness.runtime.getState().lastRecall);
  harness.handlers.get('chat-changed')();
  assert.equal(harness.runtime.getState().lastRecall, null);
  assert.equal(harness.prompts.at(-1)[1], '');
});

test('runtime source 返回后 head/revision 正常推进但叙事与已选引用仍有效时允许注入', async () => {
  let head = 'head', revision = 1, sourceReads = 0;
  const source = runtimeFixture();
  source.headCheckpointId = head;
  source.rootRevision = revision;
  const harness = createRuntimeHarness({
    sourceReader: async () => {
      sourceReads += 1;
      const value = structuredClone(source);
      if (sourceReads === 1) queueMicrotask(() => { head = 'head-after-source'; revision = 2; });
      else { value.headCheckpointId = head; value.rootRevision = revision; }
      return value;
    },
  });
  const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(sourceReads, 2, '无 readRoot 时提交前必须用同一 sourceReader 复核推进后的来源');
  assert.equal(result.lastRecall.status, 'ready');
  assert.ok(harness.prompts.at(-1)[1]);
  assert.equal(harness.saves, 1);
});

test('runtime 另一插件只改 assistant extra 不误判；读取期间相关正文变隐藏则拒绝旧结果', async () => {
  for (const hideRelevant of [false, true]) {
  let harness, sourceCalls = 0;
  harness = createRuntimeHarness({
    sourceReader: async () => {
      sourceCalls += 1;
      if (sourceCalls > 1) {
        harness.chat[0].extra = { anotherPlugin: { refreshed: true } };
        if (hideRelevant) harness.chat[0].is_hidden = true;
      }
      return structuredClone(harness.source);
    },
  });
  const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(result.lastRecall.status, hideRelevant ? 'stale' : 'ready');
  assert.equal(harness.saves, hideRelevant ? 0 : 1);
  if (hideRelevant) {
    assert.ok(harness.prompts.every(call => call[1] === ''));
    assert.equal(harness.userMessage.extra?.[RECALL_RECEIPT_KEY], undefined);
  } else {
    assert.ok(harness.prompts.at(-1)[1]);
    assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].completionStatus, 'ready');
  }
  }
});

test('runtime prompt 已 commit 后唯一一次完成态保存失败仍保留注入，降级 sessionOnly 且 CAS 回滚保留并发 extra', async () => {
  const harness = createRuntimeHarness({
    saveChat: async ({ userMessage }) => {
      userMessage.extra.concurrentField = 'must-survive';
      throw new Error('completed receipt save failed');
    },
  });
  const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(harness.saves, 1);
  assert.equal(result.lastRecall.status, 'ready');
  assert.equal(result.lastRecall.receiptPersistence, 'sessionOnly');
  assert.ok(harness.prompts.at(-1)[1], '最终回执保存失败不得反向清除已经 commit 的 prompt');
  assert.equal(harness.userMessage.extra.concurrentField, 'must-survive');
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY], undefined, '保存失败不得在聊天中留下半成品回执');
  const reused = await harness.runtime.intercept(harness.chat, 12000, null, 'continue');
  assert.equal(reused.lastRecall.reusedReceipt, true, '会话内 committed 证明仍可安全复用');
  assert.equal(reused.lastRecall.receiptPersistence, 'sessionOnly');
  assert.equal(harness.saves, 1, '复用不应再次保存');
});

test('runtime 旧 completed save 迟到失败时不得擦除新 interceptor 的 completed 回执或并发 extra', async () => {
  let saveCalls = 0, rejectOldSave;
  const harness = createRuntimeHarness({
    saveChat: async () => {
      saveCalls += 1;
      if (saveCalls === 1) await new Promise((resolve, reject) => { rejectOldSave = reject; });
    },
  });
  const oldRun = harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  while (!rejectOldSave) await new Promise(resolve => setImmediate(resolve));
  const newResult = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(newResult.lastRecall.status, 'ready');
  assert.equal(saveCalls, 2, '每个 interceptor 最多各保存一次 completed 回执');
  const newFingerprint = harness.userMessage.extra[RECALL_RECEIPT_KEY].receiptFingerprint;
  harness.userMessage.extra.concurrentField = 'newer-extra';
  rejectOldSave(new Error('old save failed late'));
  await oldRun;
  assert.equal(harness.userMessage.extra.concurrentField, 'newer-extra');
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].completionStatus, 'ready');
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].receiptFingerprint, newFingerprint, '旧失败只能回滚自己的精确 candidate');
  harness.runtime.invalidate('simulateReload');
  await harness.runtime.restorePersistedReceipt();
  assert.equal(harness.runtime.getState().lastRecall?.restoredReceipt, true, '新 committed 回执刷新后仍可恢复');
});

test('runtime 最终同步复核返回后若微任务使历史失效，事件先清槽，旧调用层不得再写 prompt', async () => {
  let armed = true;
  const harness = createRuntimeHarness({
    snapshotHook: ({ count, handlers, chat }) => {
      if (armed && count === 5) {
        armed = false;
        queueMicrotask(() => { chat[0].mes = '最终 commit 后 assistant 正文变化'; handlers.get('message-edited')(chat.length); });
      }
    },
  });
  const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(result.recallStatus, 'idle');
  assert.equal(harness.prompts.at(-1)[1], '', '宿主 await interceptor 恢复前，失效事件必须留下空槽');
  assert.equal(harness.prompts.filter(call => call[1]).length, 1, '最终同步 commit 可发生，但调用层不得在失效后第二次补写');
});
