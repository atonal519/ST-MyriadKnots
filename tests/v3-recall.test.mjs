import { RECALL_KNOWLEDGE_GUIDANCE } from '../src/v3/recall-text.js';
import { resolveProcessingPrompt } from '../src/internal-processing-prompt.js';
import test from 'node:test';
import { processingTransport } from './fixtures/processing-transport.mjs';
import assert from 'node:assert/strict';
import { formatChronologyAnchor, projectRecallSource, readRecallSource } from '../src/v3/recall-source.js';
import { buildRecallCseCandidatePool, buildRecallHistoryCandidatePool, buildRecallQueryContext, buildRecallQueryFrame, cseSelectionContext, estimateRecallTokens, formatRecallInjection, placeRecallBlocks, placeRecallText, historySelectionContext, recallBudget, selectRecall } from '../src/v3/recall-selector.js';
import { RECALL_LLM_SYSTEM_PROMPT, removeExactQianshiDuplicates, selectRecallWithLlm } from '../src/v3/recall-llm-selector.js';
import { captureCoreBodyWitness, createV3RecallRuntime, projectHistoricalRecallReceipt, renderedQianshiProgressText, RECALL_PROMPT_SLOT, RECALL_RECEIPT_KEY, RECALL_RECEIPT_SCHEMA_VERSION, RECALL_STRATEGY_VERSION } from '../src/v3/recall-runtime.js';
import { PREQUEL_PROMPT_SLOT } from '../src/v3/recall-prequel.js';
import { sha256 } from '../src/identity.js';
import { assessMemoryCoverageFromHost } from '../src/v3/memory-coverage.js';
import { scanAssistantCandidates } from '../src/v3/foundation-domain.js';
import { createExtractorEnvelope, normalizeExtractorResponse } from '../src/v3/extractor.js';
import { rankRecallDocuments, tokenizeRecallText } from '../src/v3/recall-ranking.js';
import { projectInlineRecallReceipt } from '../src/ui/inline-projection.js';
import { createCompactApiClient } from '../src/compact-api-client.js';
import { createTaskRouter } from '../src/api-routing.js';
import { createPrivateRecallDiagnostics, projectPrivateRecallDiagnostic } from '../src/private-recall-diagnostics.js';
import { createVectorIndex } from '../src/v3/vector-index.js';
import { summaryCandidateText, summaryWitnessValid } from '../src/v3/vector-source.js';
import { readLocationReference } from '../src/v3/location-reference.js';
import { MIGRATION_ALIAS_KEY } from '../src/v3/migration-prefix.js';
import { createAutoHideController, AUTO_HIDE_MARKER_KEY } from '../src/v3/auto-hide.js';
import { QIANSHI_RECALL_PROJECTION_VERSION, compileQianshiDelta, prepareQianshiRecallCandidates, projectQianshiCandidateSelection, projectQianshiRecall } from '../src/v3/qianshi-domain.js';

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
  ...(receipt.schemaVersion >= 13 && receipt.schemaVersion <= 14 ? [receipt.stateProgressions] : []),
  ...(receipt.schemaVersion >= 14 ? [receipt.timeDependencies] : []),
  ...(receipt.schemaVersion >= 15 && receipt.qianshiProgress ? [receipt.qianshiProgress] : []),
  ...(receipt.schemaVersion >= 18 ? [receipt.selectedLocationReferences, receipt.locationReferenceDependency] : []),
  ...(receipt.placeWorkspaceDependency !== undefined ? [receipt.placeWorkspaceDependency, receipt.selectedPlaces ?? []] : []),
]));
const stripSummaryWitnessesForLegacyReceipt = receipt => {
  for (const floor of receipt.selectedFloors ?? []) delete floor.summaryWitnesses;
  return receipt;
};

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

test('排除楼不进入召回正文引用或覆盖分母，全部排除时视为无待补楼', async () => {
  const value = reachable();
  value.floors = value.floors.map((floor, index) => ({ ...floor, hostLocator: { messageIndex: index },
    content: { rawFingerprint: `raw-${index}`, canonicalFingerprint: `canonical-${index}` } }));
  const snapshot = { chat: [
    { is_user: true, mes: '问题' },
    { is_user: false, mes: '不应进入召回的原文', extra: { qianqianjie_memory_excluded: true } },
  ] };
  const source = await projectRecallSource(value, () => new Date(NOW), sourceAttempts('ready'), snapshot);
  assert.deepEqual(source.bodyMatchRefs.map(ref => ref.floorId), [FLOOR1]);
  assert.deepEqual(source.coverage, { stableAiFloors: 1, stableThroughAssistantSeq: 2, rememberedAiFloors: 1,
    missingAssistantSeq: [], cseThroughAssistantSeq: 1, memoryComplete: true, cseCurrent: true });

  const allExcluded = reachable();
  allExcluded.floorMemories = [];
  allExcluded.stateDeltas = [];
  allExcluded.currentStates = [];
  allExcluded.floors = allExcluded.floors.map((floor, index) => ({ ...floor, hostLocator: { messageIndex: index } }));
  const allExcludedSnapshot = { chat: allExcluded.floors.map((_, index) => ({
    is_user: false, mes: `排除楼 ${index + 1}`, extra: { qianqianjie_memory_excluded: true },
  })) };
  const empty = await projectRecallSource(allExcluded, () => new Date(NOW), sourceAttempts('ready'), allExcludedSnapshot);
  assert.deepEqual(empty.bodyMatchRefs, []);
  assert.deepEqual(empty.coverage, { stableAiFloors: 0, stableThroughAssistantSeq: 2, rememberedAiFloors: 0,
    missingAssistantSeq: [], cseThroughAssistantSeq: 0, memoryComplete: true, cseCurrent: true });
});

test('主角人设基础资料不进入召回候选，剧情与人工状态保留且不修改原记录', async () => {
  const cases = [
    { name: '主角人设', evidence: ['userPersona'], origin: 'baseline', omitted: true },
    { name: '世界书', evidence: ['worldbook:1'], origin: 'baseline' },
    { name: '混合设定来源', evidence: ['userPersona', 'worldbook:1'], origin: 'baseline' },
    { name: '角色卡', evidence: ['characterCard'], origin: 'baseline' },
    { name: '混合证据', evidence: ['userPersona', 'canonicalContent'], origin: 'floor' },
    { name: '人工修改', evidence: ['userPersona'], origin: 'manual' },
    { name: '剧情变化', evidence: ['userPersona'], origin: 'floor' },
    { name: '旧资料无来源记录', evidence: null, origin: 'baseline' },
  ];
  const queryContext = { text: '阿裴，继续钟楼的约定', latestUserText: '阿裴，继续钟楼的约定', messageCount: 1 };
  for (const scenario of cases) {
    const value = reachable();
    value.entities[0].specialRole = 'user';
    const delta = value.stateDeltas[0], subject = delta.subjectSnapshots[0];
    const item = { ...subject.situational[0], id: '99999999-9999-4999-8999-999999999999', text: '开朗热情，重视社交边界', origin: scenario.origin };
    subject.core = [item];
    delta.fixedChanges[0].items.push({ category: 'core', action: 'add', before: null, after: item });
    if (scenario.evidence) delta.source = { calibrationAudit: [{ subjectEntityId: PERSON, category: 'core', action: 'add', text: item.text, evidence: scenario.evidence.map(source => ({ source, quote: item.text })) }] };
    const original = structuredClone(value);
    const source = await projectRecallSource(value, () => new Date(NOW));
    assert.equal(source.currentState[0].core.length, scenario.omitted ? 0 : 1, scenario.name);
    assert.equal(source.currentState[0].situational.length, 1, `${scenario.name}：剧情承诺保留`);
    assert.equal(source.cseChanges.some(change => change.after?.stateId === item.id), !scenario.omitted, `${scenario.name}：历史新增同步处理`);
    assert.deepEqual(value, original, `${scenario.name}：原始记忆不变`);
    if (scenario.omitted) {
      const pool = buildRecallCseCandidatePool({ source, queryContext });
      assert.doesNotMatch(pool.text, /开朗热情|社交边界/);
      const selected = selectRecall({ source, queryContext, contextSize: 12000 });
      assert.doesNotMatch(selected.injectionText, /开朗热情|社交边界/);
      assert.match(selected.injectionText, /雨夜承诺/);
    }
  }
});

test('过滤人设基础资料仍保留人物调整和移除的历史变化', async () => {
  const value = reachable(), delta = value.stateDeltas[0], subject = delta.subjectSnapshots[0];
  const item = { ...subject.situational[0], origin: 'baseline', text: '谨慎守约' };
  subject.core = [item]; subject.situational = [];
  delta.source = { calibrationAudit: [{ subjectEntityId: PERSON, category: 'core', action: 'refine', text: item.text, evidence: [{ source: 'userPersona', quote: item.text }] }] };
  delta.fixedChanges[0].items = [
    { category: 'core', action: 'refine', before: { ...item, text: '只信自己' }, after: item },
    { category: 'core', action: 'remove', before: { ...item, text: '隐瞒自己的身世' }, after: null },
  ];
  const source = await projectRecallSource(value, () => new Date(NOW));
  assert.equal(source.currentState[0].core.length, 0);
  assert.deepEqual(source.cseChanges.map(change => change.action), ['refine', 'remove']);
  assert.equal(source.cseChanges[0].before.text, '只信自己');
  assert.equal(source.cseChanges[1].before.text, '隐瞒自己的身世');
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

test('recall source 保存时间不改档，失配自动时间局部隔离，人工时间与无宿主快照保持可读', async () => {
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
  assert.equal(result.floorMemories.length, 0, '失配楼的自动时间不进入本轮候选');
  assert.equal(value.floorMemories[0].chronology.length, 1, '本轮隔离不删除已保存时间');
  result = await read(null);
  assert.equal(result.floorMemories[0].chronology.length, 1, '没有宿主快照也应保留已保存时间');

  value.run.diagnostics.floorProvenance[FLOOR1].timeEdited = true;
  result = await read(changed);
  assert.equal(result.floorMemories[0].chronology.length, 1, '人工时间优先于自动原文失配');
  delete value.run.diagnostics.floorProvenance[FLOOR1].timeEdited;
  delete value.run.diagnostics.floorProvenance[FLOOR1].rawFingerprint;
  result = await read(changed);
  assert.equal(result.floorMemories.length, 0, '无人工时间见证的失配旧楼仍只作本轮隔离');
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
  ...(patch.spatialFacts ? { spatialFacts: patch.spatialFacts } : {}),
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

test('空间事实保留来源楼锚点，并只沿锚点时点最新包含边补祖先', () => {
  const room = '99999999-7777-4777-8777-777777777771', east = '99999999-7777-4777-8777-777777777772', west = '99999999-7777-4777-8777-777777777773', campus = '99999999-7777-4777-8777-777777777774';
  const userId = '88888888-7777-4777-8777-777777777777';
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  const ref = (seq, quotedText) => ({ floorId: `floor-${seq}`, assistantSeq: seq, quotedText });
  memories[0] = recallMemory(1, { summary: '', spatialFacts: {
    positions: [{ subjectEntityId: userId, placeEntityId: room, status: 'confirmed', sourceRefs: [ref(1, '林岚在房间')] }],
    containments: [
      { placeEntityId: room, parentEntityId: east, sourceRefs: [ref(1, '房间位于东馆')] },
      { placeEntityId: east, parentEntityId: campus, sourceRefs: [ref(1, '东馆属于校园')] },
    ],
  } });
  memories[1] = recallMemory(2, { summary: '', spatialFacts: { positions: [
    { subjectEntityId: userId, placeEntityId: room, status: 'confirmed', sourceRefs: [ref(2, '林岚继续在房间')] },
  ], containments: [
    { placeEntityId: room, parentEntityId: west, sourceRefs: [ref(2, '房间改属西馆')] },
  ] } });
  const source = selectorSource({ memories });
  source.entities.push(...[
    [room, '房间'], [east, '东馆'], [west, '西馆'], [campus, '校园'],
  ].map(([entityId, displayName]) => ({ entityId, displayName, aliases: [], entityType: 'place', specialRole: 'none' })));
  const queryContext = { text: '林岚在房间', latestUserText: '林岚在房间', messageCount: 1 };
  const context = historySelectionContext(source, queryContext);
  const position = context.direct.find(value => value.kind === 'spatialPosition' && value.sourceAssistantSeq === 1);
  assert.ok(position, JSON.stringify(context.facts.map(value => [value.kind, value.text, value.sourceAssistantSeq])));
  const selected = selectRecall({ source, queryContext, historyContext: context, selectedHistoryCandidates: [position], contextSize: 12000 });
  assert.match(selected.injectionText, /来源楼当时.*位置[:：]林岚位于房间/u);
  const inline = projectInlineRecallReceipt({ ...selected, schemaVersion:18, strategyVersion:RECALL_STRATEGY_VERSION, selectedFloors:selected.floors.map(value=>({floorId:value.floorId,assistantSeq:value.assistantSeq,reasons:[]})), selectedStates:selected.states, selectedCseChanges:selected.cseChanges });
  assert.equal(inline.protocolRecognized,true);
  assert.ok(inline.objectItems.some(item=>item.text.includes('位置:林岚位于房间')||item.text.includes('位置：林岚位于房间')), '实际formatter的当时位置可由物页往返读取');
  assert.match(selected.injectionText, /房间 属于 东馆/u);
  assert.match(selected.injectionText, /东馆 属于 校园/u);
  assert.doesNotMatch(selected.injectionText, /房间 属于 西馆/u, '较新的关系不应覆盖较早位置锚点');

  const newerPosition = context.direct.find(value => value.kind === 'spatialPosition' && value.sourceAssistantSeq === 2);
  const latest = context.direct.find(value => value.kind === 'spatialContainment' && value.sourceAssistantSeq === 2);
  assert.ok(newerPosition, '较新来源楼也有可用位置锚点');
  assert.ok(latest, '锚点时最新的西馆边确实进入候选');
  const excluded = selectRecall({ source, queryContext, historyContext: context, selectedHistoryCandidates: [newerPosition], excludedHistoryCandidates: [latest], contextSize: 12000 });
  assert.doesNotMatch(excluded.injectionText, /房间 属于 (?:西馆|东馆)/u, '锚点时最新边被排除后不能回退到旧边');
});

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
  assert.equal(result.states.length, 0, '没有本轮正向证据的人物状态不因模型未排除而补位');
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

test('聚合摘要只有全成员被当前正文覆盖才排除，部分覆盖仍进入近期/远期筛选并留下可见诊断', () => {
  const memories = Array.from({ length: 12 }, (_, index) => recallMemory(index + 1, { summary: `普通摘要 ${index + 1}` }));
  memories[1] = { ...recallMemory(2, { summary: '雨夜将铜钥匙留在灰匣，次日取回' }),
    floorId: 'aggregate-floor-2', sourceFloorIds: ['aggregate-member-1', 'aggregate-floor-2'] };
  const source = selectorSource({ memories });
  source.bodyMatch = { coveredFloorIds: ['aggregate-member-1'] };
  const queryContext = { text: '铜钥匙灰匣次日取回', latestUserText: '铜钥匙灰匣次日取回', messageCount: 1 };
  const partialContext = historySelectionContext(source, queryContext);
  assert.ok(partialContext.oldMemories.some(memory => memory.floorId === 'aggregate-floor-2'));
  const partial = selectRecall({ source, queryContext });
  assert.ok(partial.floors.some(floor => floor.floorId === 'aggregate-floor-2'));
  assert.ok(partial.skipReasons.includes('partialAggregateBodyOverlap'));
  assert.equal(partial.skipReasons.includes('coreBodyDuplicate'), false);

  source.bodyMatch = { coveredFloorIds: ['aggregate-member-1', 'aggregate-floor-2'] };
  const fullyCovered = selectRecall({ source, queryContext });
  assert.equal(fullyCovered.floors.some(floor => floor.floorId === 'aggregate-floor-2'), false);
  assert.ok(fullyCovered.skipReasons.includes('coreBodyDuplicate'));
  assert.equal(fullyCovered.skipReasons.includes('partialAggregateBodyOverlap'), false);
});

test('Q 排重只比较最终客观旧事条目；完整相同才删，Q独有字段及 private/shared/narrative 保留', async () => {
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  memories[1] = recallMemory(2, { events: [{ title: '2026年9月3日', description: '钟楼钥匙已归还', candidateStatus: 'accepted' }] });
  const source = selectorSource({ memories });
  const queryContext = { text: '钟楼钥匙已归还', latestUserText: '钟楼钥匙已归还', messageCount: 1 };
  const selection = selectRecall({ source, queryContext });
  const objective = selection.floors.flatMap(floor => floor.items).find(item => item.category === 'objective');
  assert.match(objective?.text ?? '', /^2026年9月3日[:：]钟楼钥匙已归还$/u, '比较输入来自生产 selector 最终实际选中的客观条目');
  const exactProgress = { projectionVersion: 4,
    text: `[相关时间线]\n- ${objective.text}\n\n[当前待接续]\n- 仍需归还旧书；尚未记录完成。`,
    eventIds: ['same-event'], matterIds: ['pending-matter'] };
  const exact = removeExactQianshiDuplicates(exactProgress, selection);
  assert.equal(exact.text, '[当前待接续]\n- 仍需归还旧书；尚未记录完成。');
  const scopedExact = removeExactQianshiDuplicates({ ...exactProgress,
    text: `本轮千事资料来源截至：AI #10。\n\n[相关时间线]\n- ${objective.text}` }, selection);
  assert.equal(scopedExact.text, '', '千事正文被去重到没有材料时，不单独留下截止提示');
  assert.deepEqual(exact.eventIds, []);
  assert.deepEqual(exact.matterIds, ['pending-matter']);
  assert.equal(exact.characterCount, exact.text.length);

  source.qianshiCandidates = [qianshiCandidate('Q1', 'history', objective.text, { line: `- ${objective.text}` })];
  const integrated = await selectRecallWithLlm({ source, queryContext,
    generateUtilityTask: async () => ({ jsonData: { history_exclude_keys: [], state_exclude_keys: [] } }) });
  assert.ok(integrated.floors.flatMap(floor => floor.items).some(item => item.category === 'objective' && item.text === objective.text));
  assert.deepEqual(integrated.qianshiProgress.eventIds, [], '真实 LLM 选材完成后从实际入选 objective 中移除同一 Q 行');
  assert.deepEqual(integrated.qianshiProgress.matterIds, []);
  assert.equal(integrated.qianshiProgress.text, RECALL_KNOWLEDGE_GUIDANCE, '排重后无千事正文，仅保共用知情边界说明');

  const qHasUniqueStatus = removeExactQianshiDuplicates({ projectionVersion: 4,
    text: `[相关时间线]\n- ${objective.text}（后续又延期）`, eventIds: ['status-event'], matterIds: [] }, selection);
  assert.match(qHasUniqueStatus.text, /后续又延期/u);
  assert.deepEqual(qHasUniqueStatus.eventIds, ['status-event']);

  const qHasUniqueTime = removeExactQianshiDuplicates({ projectionVersion: 4,
    text: `[相关时间线]\n- 2026年9月4日：${objective.text}`, eventIds: ['time-event'], matterIds: [] }, selection);
  assert.match(qHasUniqueTime.text, /2026年9月4日/u);
  assert.deepEqual(qHasUniqueTime.eventIds, ['time-event']);

  const categoryCases = [
    ['private', { privateCognition: [{ ownerEntityId: PERSON, kind: 'belief', content: '蓝铜钥匙留在灰匣' }] }, '蓝铜钥匙留在灰匣'],
    ['shared', { commitments: [{ speakerEntityId: PERSON, targetEntityIds: ['88888888-7777-4777-8777-777777777777'], kind: 'promise', content: '蓝铜钥匙留在灰匣', status: 'accepted', exactAnchorId: null }] }, '蓝铜钥匙留在灰匣'],
    ['narrative', { summary: '蓝铜钥匙留在灰匣' }, '蓝铜钥匙留在灰匣'],
  ];
  for (const [category, patch] of categoryCases) {
    const categoryMemories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
    categoryMemories[1] = recallMemory(2, patch);
    const categorySelection = selectRecall({ source: selectorSource({ memories: categoryMemories }),
      queryContext: { text: '蓝铜钥匙留在灰匣', latestUserText: '蓝铜钥匙留在灰匣', messageCount: 1 } });
    const item = categorySelection.floors.flatMap(floor => floor.items).find(value => value.category === category);
    assert.ok(item, `${category} 需真实进入最终选择`);
    const retained = removeExactQianshiDuplicates({ projectionVersion: 4, text: `[相关时间线]\n- ${item.text}`,
      eventIds: [`${category}-event`], matterIds: [] }, categorySelection);
    assert.deepEqual(retained.eventIds, [`${category}-event`], `${category} 同字也不参与跨源删除`);
  }
});

test('真实摘要长度与小上下文下优先保最近楼，LLM 所见近期接续和最终注入一致', async () => {
  const memories = Array.from({ length: 32 }, (_, index) => recallMemory(index + 1, {
    summary: index >= 28 ? `近期${index + 1}：${String(index + 1).repeat(160)}` : '',
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

test('搬家来源的召回候选保留来源聊天楼号，不与B楼号混淆', () => {
  const source = runtimeFixture();
  source.bodyMatchRefs = [{ floorId: 'floor-2', frozen: true, sourceOrigin: { sourceMessageIndex: 1 } }];
  const pool = buildRecallHistoryCandidatePool({ source, queryContext: { text: '钟楼', latestUserText: '钟楼', messageCount: 1 } });
  assert.match(pool.text, /来源聊天第 1 楼 · AI #2/u);
});

test('统一预算不按单线八节点裁剪，高相关同线材料只受最终总预算约束', () => {
  const memories = Array.from({ length: 12 }, (_, index) => recallMemory(index + 1, { summary: index >= 8 ? `近期接续 ${index + 1}` : '' }));
  memories[1] = recallMemory(2, { events: Array.from({ length: 30 }, (_, index) => ({ title: `钥匙背景 ${index + 1}`, description: `钥匙因果链 ${index + 1}`, candidateStatus: 'accepted' })) });
  const states = Array.from({ length: 12 }, (_, index) => ({ text: `钥匙状态 ${index + 1}`, visibility: 'authorial', reason: '人物档案', origin: 'baseline', towardEntityId: null, sourceAssistantSeq: 12 }));
  const source = selectorSource({ memories, currentState: [{ subjectEntityId: PERSON, core: states, adaptive: [], situational: [] }] });
  source.coverage = { ...source.coverage, stableAiFloors: 12, stableThroughAssistantSeq: 12, rememberedAiFloors: 12, cseThroughAssistantSeq: 12 };
  const queryContext = { text: '钥匙因果链', latestUserText: '钥匙因果链', messageCount: 1 };
  const pool = buildRecallHistoryCandidatePool({ source, queryContext });
  const result = selectRecall({ source, queryContext, contextSize: 12000, selectedHistoryCandidates: pool.candidates });
  assert.equal(result.stages.recentSummaryCount, 4);
  assert.equal(result.stages.distantHistoryItemCount, 30, '高相关同线材料不再被八节点资格帽裁掉');
  assert.equal(result.states.length, 12);
  assert.equal(result.floors.reduce((sum, floor) => sum + floor.items.length, 0), 34);
  assert.ok(result.floors.flatMap(floor => floor.items).filter(item => item.storylineId !== 'recent').length >= 9);
  assert.ok(result.limits.estimatedTokenCount <= result.limits.estimatedTokenBudget);
  assert.equal(Object.hasOwn(result.limits, 'stateItemTarget'), false);
});

test('最终召回取消48历史/24人物资格帽并保持总预算与完整条目边界', () => {
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
  assert.equal(result.limits.maxFloors, null);
  assert.equal(result.limits.maxItems, null);
  assert.equal(result.limits.maxCharacters, 27500);
  assert.equal(Object.hasOwn(result.limits, 'stateItemTarget'), false);
  assert.equal(Object.hasOwn(result.limits, 'historyItemTarget'), false);
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
  assert.match(selected.injectionText, /主体：沈砚；对象：顾舟.*行动·完成：打开柜子；记录结果：取出地图/u);
  assert.match(selected.injectionText, /表达者：沈砚；接收者：顾舟.*北门可走/u);
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

test('65 楼盒子回归：相关历史保住第 50 楼盒子事件，零相关状态不补位', () => {
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
  assert.equal(result.states.length, 0, '只提到人物而没有内容关联的状态不补位');
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

test('同楼同文摘要在唯一事实零分时保留邻近召回资格', async () => {
  const memories = Array.from({ length: 10 }, (_, index) => recallMemory(index + 1, { summary: index >= 6 ? `近期接续 ${index + 1}` : '' }));
  memories[1] = recallMemory(2, { summary: '旧港口地图已收进档案' });
  memories[2] = recallMemory(3, {
    summary: '林岚交付：原定周五',
    events: [{ title: '林岚交付', description: '原定周五', candidateStatus: 'accepted' }],
  });
  const source = selectorSource({ memories });
  const queryContext = { text: '旧港口地图', latestUserText: '旧港口地图', messageCount: 1 };
  const context = historySelectionContext(source, queryContext);
  const duplicateFact = context.facts.find(value => value.floorId === 'floor-3' && value.kind === 'event');
  assert.equal(duplicateFact?.score, 0, '同楼事实没有本地检索资格');
  assert.equal(context.summaries.some(value => value.floorId === 'floor-3'), true, '零分事实不能提前剥掉同文摘要');

  const pool = buildRecallHistoryCandidatePool({ source, queryContext, historyContext: context });
  const nearby = pool.candidates.find(value => value.value.floorId === 'floor-3' && value.value.kind === 'summary');
  assert.equal(nearby?.sourceKind, 'adjacent');
  assert.ok(pool.candidates.length <= 48 && pool.text.length <= 24000, '恢复摘要资格仍受既有宽候选上限约束');

  const run = excluded => selectRecallWithLlm({ source, queryContext, contextSize: 12000,
    generateUtilityTask: async () => ({ jsonData: { history_exclude_keys: excluded, state_exclude_keys: [] } }),
  });
  const included = await run([]);
  assert.match(included.injectionText, /林岚交付[:：]原定周五/u, '最终注入必须包含可读更新摘要文本');
  assert.match(included.injectionText, /旧港口地图已收进档案/u, '邻近摘要随直接命中的锚一起进入');

  const excluded = await run([nearby.key]);
  assert.doesNotMatch(excluded.injectionText, /林岚交付[:：]原定周五/u, '模型明确排除后不从关联扩展重新带回摘要');
  assert.match(excluded.injectionText, /旧港口地图已收进档案/u, '排除邻近摘要不影响直接命中的锚');
});

test('M4旧钥匙承诺命中时保留同文弱词面改期摘要及明确作废日期', async () => {
  const userId = '88888888-7777-4777-8777-777777777777';
  const update = '原先那次交付改到2026年10月20日；原定时间作废，尚未交付。';
  const memories = Array.from({ length: 10 }, (_, index) => recallMemory(index + 1, { summary: index >= 6 ? `近期接续 ${index + 1}` : '' }));
  memories[1] = recallMemory(2, {
    summary: '林岚答应周五交钥匙',
    commitments: [{ speakerEntityId: PERSON, targetEntityIds: [userId], kind: 'promise', content: '周五交钥匙', status: 'made', exactAnchorId: null }],
  });
  memories[2] = recallMemory(3, {
    summary: update,
    commitments: [{ speakerEntityId: PERSON, targetEntityIds: [userId], kind: 'promise', content: update, status: 'made', exactAnchorId: null }],
  });
  const source = selectorSource({ memories });
  const queryContext = { text: '周五交钥匙现在还要交吗？什么时候？', latestUserText: '周五交钥匙现在还要交吗？什么时候？', messageCount: 1 };
  const context = historySelectionContext(source, queryContext);
  const previousPromise = context.facts.find(value => value.floorId === 'floor-2' && value.kind === 'commitment');
  const revisedPromise = context.facts.find(value => value.floorId === 'floor-3' && value.kind === 'commitment');
  assert.ok(previousPromise?.score > 0, '旧钥匙约定以实际承诺事实命中');
  assert.equal(revisedPromise?.score, 0, '改期承诺没有复述钥匙或周五，保持弱词面');
  assert.ok(context.summaries.some(value => value.floorId === 'floor-3'), '同文摘要在相邻入口前保留');

  const pool = buildRecallHistoryCandidatePool({ source, queryContext, historyContext: context });
  const updateCandidate = pool.candidates.find(value => value.value.floorId === 'floor-3' && value.value.kind === 'summary');
  assert.equal(updateCandidate?.sourceKind, 'adjacent');
  assert.ok(pool.candidates.some(value => value.value.floorId === 'floor-2' && value.value.kind === 'commitment'), '旧承诺事实作为直接命中进入宽候选');
  const result = await selectRecallWithLlm({ source, queryContext, contextSize: 12000,
    generateUtilityTask: async () => ({ jsonData: { history_exclude_keys: [], state_exclude_keys: [] } }),
  });
  assert.ok(result.floors.some(floor => floor.floorId === 'floor-2' && floor.items.some(value => value.kind === 'commitment')), '最终结果保留旧承诺事实');
  assert.match(result.injectionText, /周五交钥匙/u, '最终文本仍提供原承诺作为更新前指');
  assert.match(result.injectionText, /2026年10月20日/u, '最终文本保留明确改期日期');
  assert.match(result.injectionText, /原定时间作废/u, '最终文本保留明确作废约束');
});

test('历史与状态共享字符预算且不再按人物二十四项或单线八节点裁剪', () => {
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
  assert.ok(historyItems.length > 0, '相关历史参与统一预算');
  assert.ok(both.storylines.some(line => historyItems.filter(value => value.storylineId === line.storylineId).length > 8), '同线第九项以后仍可按价值入选');
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
  assert.ok(historyOnly.injectionText.length > 0, '历史使用统一总预算，不再受独立状态字符份额影响');
  assert.equal(Object.hasOwn(historyOnly.limits, 'historyCharacterTarget'), false);
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
  assert.equal(limited.states.length, 1);
  assert.equal(limited.states[0].text, '铁皮盒和红钥匙完整线索');
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
  assert.match(selected.injectionText, /当时未结事项:找到钟楼下的密门/);
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
  assert.match(transferResult.injectionText, /表达者：裴晚生；接收者：林岚；渠道：told；内容：原句「月落前离开」/);
  const commitmentResult = run('雨落三声暗号');
  const commitment = commitmentResult.floors.flatMap(floor => floor.items)[0];
  assert.equal(commitment.category, 'shared', '承诺原句继承合法接收者边界');
  assert.equal(commitment.status, 'made');
  assert.match(commitmentResult.injectionText, /历史承诺·当时已作出：约定以三声雨响作为暗号；原句「雨落三声」/);
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

test('selector 同分内容按类型价值统一竞争并只保留一份', () => {
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  memories[1] = recallMemory(2, { participants: [{ entityId: PERSON, presence: 'present' }], privateCognition: [{ ownerEntityId: PERSON, kind: 'thought', content: '冷静克制' }] });
  memories[2] = recallMemory(3, { participants: [{ entityId: PERSON, presence: 'present' }], privateCognition: [{ ownerEntityId: PERSON, kind: 'thought', content: '冷静克制' }] });
  const currentState = [{ subjectEntityId: PERSON, core: [{ text: '冷静克制', visibility: 'private', reason: '人设', origin: 'baseline', towardEntityId: null, sourceAssistantSeq: 1 }], adaptive: [], situational: [] }];
  const result = selectRecall({ source: selectorSource({ memories, currentState }), queryContext: { text: '阿裴是否仍然冷静克制', latestUserText: '阿裴是否仍然冷静克制', messageCount: 1 } });
  assert.equal(result.floors.length, 0);
  assert.match(result.injectionText, /冷静克制/);
  assert.equal(result.states.length, 1);
  assert.equal(result.stages.dropPersistent, 1);
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
  assert.doesNotMatch(result.injectionText, /叙事回顾可能含内心/);
  assert.equal(result.injectionText.split('叙事回顾可能含内心、计划或未完成事项').length - 1, 0);
  assert.equal(result.injectionText.split(secret).length - 1, 1);
});

test('selector summary-only 作为叙事回顾注入，并明确不代表所有人物知情', () => {
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  memories[1] = recallMemory(2, { summary: '钟楼暗门密码是海棠' });
  const result = selectRecall({ source: selectorSource({ memories }), queryContext: { text: '钟楼暗门密码是什么', latestUserText: '钟楼暗门密码是什么', messageCount: 1 } });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.floors[0].items.map(value => value.category), ['narrative']);
  assert.doesNotMatch(result.injectionText, /叙事回顾可能含内心、计划或未完成事项，不代表所有人物知情/);
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
  assert.match(result.injectionText, /行动·意图：intended 密门机关/);
  assert.match(result.injectionText, /行动·尝试：attempted 密门机关/);
  assert.match(result.injectionText, /行动·完成：completed 密门机关/);
  assert.match(result.injectionText, /行动·中断：interrupted 密门机关/);
  assert.match(result.injectionText, /行动·完成状态未知：uncertain 密门机关/);
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
  check('暗号甲', 'shared', /历史承诺·当时已作出：暗号甲/);
  check('暗号乙', 'shared', /历史承诺·当时已接受：暗号乙/);
  check('暗号丙', 'shared', /历史承诺·当时已拒绝：暗号丙/);
  check('暗号丁', 'private', /历史承诺·当时成立未定：暗号丁/);
  check('私下密门计划', 'private', /当时计划：私下密门计划/);
});

test('selector informationTransfer 明示 from/to 知情边界，甲只告诉乙不能写成当前丙知情', () => {
  const userId = '88888888-7777-4777-8777-777777777777';
  const otherId = '99999999-7777-4777-8777-777777777777';
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  memories[1] = recallMemory(2, { informationTransfers: [{ fromEntityId: PERSON, toEntityIds: [userId], claimText: '密钥藏在井边', channel: 'told' }] });
  const source = selectorSource({ memories });
  source.entities = source.entities.map(entity => entity.entityId === PERSON ? { ...entity, displayName: '甲方' } : entity.entityId === userId ? { ...entity, displayName: '乙方' } : entity.entityId === otherId ? { ...entity, displayName: '丙方' } : entity);
  const result = selectRecall({ source, queryContext: { text: '丙方追问密钥藏在哪里', latestUserText: '丙方追问密钥藏在哪里', messageCount: 1 } });
  assert.match(result.injectionText, /表达者：甲方；接收者：乙方；渠道：told；内容：密钥藏在井边/);
  assert.doesNotMatch(result.injectionText, /甲方 → 丙方|丙方[^\n]*知情/);
});

test('anti-omniscience 分桶且声明非指令；coverage 不完整时仅保留 Core，完整时才注入动态层', () => {
  const state = [{ subjectEntityId: PERSON, core: [{ text: '冷静克制', visibility: 'authorial', reason: '人设', origin: 'baseline', towardEntityId: null, sourceAssistantSeq: 1 }], adaptive: [{ text: '对林岚保持戒备', visibility: 'observable', reason: '冲突', origin: 'floor', towardEntityId: '88888888-7777-4777-8777-777777777777', sourceAssistantSeq: 5 }], situational: [{ text: '暗自恐惧', visibility: 'private', reason: '受伤', origin: 'floor', towardEntityId: null, sourceAssistantSeq: 5 }, { text: '未标注的内心秘密', reason: '旧数据缺字段', origin: 'floor', towardEntityId: null, sourceAssistantSeq: 5 }] }];
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  memories[1] = recallMemory(2, { participants: [{ entityId: PERSON, presence: 'present' }], privateCognition: [{ ownerEntityId: PERSON, kind: 'thought', content: '私下怀疑钟楼有埋伏' }], informationTransfers: [{ fromEntityId: PERSON, toEntityIds: ['88888888-7777-4777-8777-777777777777'], claimText: '他已明说钟楼不安全', channel: 'told' }] });
  const queryContext = { text: '阿裴说钟楼怎么办', latestUserText: '钟楼怎么办', messageCount: 1 };
  const complete = selectRecall({ source: selectorSource({ memories, currentState: state }), queryContext });
  assert.match(complete.injectionText, /本轮选中的历史资料与人物状态/u);
  assert.match(complete.injectionText, /\[私有资料；知情：裴晚生\] 私下怀疑钟楼有埋伏/u);
  assert.match(complete.injectionText, /表达者：裴晚生；接收者：林岚/);
  assert.doesNotMatch(complete.injectionText, /冷静克制/, '仅人物被提及不足以让零内容相关状态补位');
  assert.doesNotMatch(complete.injectionText, /暗自恐惧|未标注的内心秘密/, '零分动态状态不得作为补位进入');
  assert.doesNotMatch(complete.injectionText, /乙[^\n]*暗自恐惧/);
  const partial = selectRecall({ source: selectorSource({ complete: false, memories, currentState: state }), queryContext });
  assert.doesNotMatch(partial.injectionText, /冷静克制/);
  assert.doesNotMatch(partial.injectionText, /对林岚保持戒备|暗自恐惧/);
  assert.match(partial.injectionText, /覆盖说明.*当前没有可用的人物状态/);
  assert.ok(partial.stages.dropVisibility >= 2);
});

test('两种召回布局共享五类知情边界且保留来源主体与明确接收者', () => {
  const userId = '88888888-7777-4777-8777-777777777777';
  const otherId = '99999999-7777-4777-8777-777777777777';
  const source = selectorSource();
  const entityById = new Map(source.entities.map(value => [value.entityId, value]));
  const boundary = '人物状态记录：主体、态度对象、可见性。';
  const makeState = (stateId, subjectEntityId, subject, visibility, text, sourceAssistantSeq, storylineId) => ({
    stateId, subjectEntityId, subject, layer: 'situational', visibility, text, reason: '正文原句', toward: visibility === 'private' ? '乙' : null,
    towardEntityId: visibility === 'private' ? otherId : null, sourceAssistantSeq, sourceFloorId: `floor-${sourceAssistantSeq}`,
    sourceDeltaId: `delta-${sourceAssistantSeq}`, ...(storylineId ? { storylineId } : {}),
  });
  const build = withStoryline => {
    const storylineId = withStoryline ? 'line-knowledge' : null;
    const storyField = storylineId ? { storylineId } : {};
    const stateVisibilities = ['private', 'expressed', 'observable', 'shared', 'authorial'];
    const states = [PERSON, userId].flatMap((subjectEntityId, personIndex) => {
      const subject = entityById.get(subjectEntityId).displayName;
      return stateVisibilities.map((visibility, index) => makeState(`current-${personIndex}-${index}`, subjectEntityId, subject,
        visibility, `${subject}-${visibility}-current`, 9, storylineId));
    });
    const before = makeState('history-private', PERSON, '裴晚生', 'private', '此前私下不信任乙', 7, storylineId);
    const after = { ...makeState('history-expressed', PERSON, '裴晚生', 'expressed', '后来当面表达不信任乙', 8, storylineId), toward: '乙', towardEntityId: otherId };
    return formatRecallInjection({
      coverage: source.coverage,
      floors: [{ floorId: FLOOR1, assistantSeq: 8, chronology: [], items: [
        { category: 'private', ownerEntityId: PERSON, text: '裴晚生未公开的判断', ...storyField },
        { category: 'transfer', fromEntityId: PERSON, toEntityIds: [userId], kind: 'told', text: '钟楼钥匙在西侧抽屉', ...storyField },
      ] }],
      states,
      cseChanges: [{ deltaId: 'delta-change', assistantSeq: 8, subjectEntityId: PERSON, subject: '裴晚生', layer: 'adaptive', action: 'refine', before, after, ...storyField }],
      entityById,
      storylines: storylineId ? [{ storylineId, title: '旧事与人物状态', basis: '来源材料' }] : [],
    });
  };
  const layouts = [build(false), build(true)];
  for (const injection of layouts) {
    assert.equal(injection.split(boundary).length - 1, 1, '全局边界在每个布局中只出现一次');
    for (const subjectId of [PERSON, userId]) {
      const subjectName = entityById.get(subjectId).displayName;
      for (const visibility of ['private', 'expressed', 'observable', 'shared', 'authorial']) {
        assert.match(injection, new RegExp(`主体：${subjectName} / situational(?:，态度对象：乙)? / 可见性：${({ private:'私密',expressed:'已表达',observable:'可观察',shared:'已共享',authorial:'作者设定' })[visibility]}[^\\n]*${subjectName}-${visibility}-current`));
      }
    }
    assert.match(injection, /可见性：私密，态度对象：乙：此前私下不信任乙/);
    assert.match(injection, /可见性：已表达，态度对象：乙：后来当面表达不信任乙/);
    assert.match(injection, /表达者：裴晚生；接收者：林岚；渠道：told；内容：钟楼钥匙在西侧抽屉/);
    assert.doesNotMatch(injection, /裴晚生 → 乙|乙（仅列明接收者知情/);
    assert.match(injection, /裴晚生未公开的判断/);
  }
  assert.equal(layouts[0].split('\n').find(line => line === boundary), layouts[1].split('\n').find(line => line === boundary));
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
const qianshiCandidate = (key, kind, title, { eventId = `${key}-event`, matterId = `${key}-matter`, line = null, order = 0, assistantSeq = null } = {}) => ({
  key, kind, fact: { title, status: kind === 'pending' ? 'planned' : 'occurred' },
  eventIds: [eventId], matterIds: kind === 'pending' ? [matterId] : [],
  eventRows: kind === 'history' ? [{ eventId, matterId: null, matterStatus: null, order, ...(assistantSeq === null ? {} : { assistantSeq }), line: line ?? `- 时间未知：${title}` }] : [],
  pendingRows: kind === 'pending' ? [{ matterId, ...(assistantSeq === null ? {} : { assistantSeq }), line: line ?? `- ${title}；尚未记录完成。` }] : [],
});

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
  assert.equal(floorReads, 7, '不再额外建立两份旧楼地点标注索引，其余上下文与计数读取保留');
  assert.equal(currentStateReads, 1, '实际 CSE 候选同轮只应建立一次 CSE context');
  floorMemories = floorMemories.map((memory, index) => index === 0 ? { ...memory, summary: `${memory.summary} 第二轮新材料` } : memory);
  currentState = currentState.map(subject => ({ ...subject, situational: subject.situational.map(item => ({ ...item, text: `${item.text} 第二轮新材料` })) }));
  await run({ ...llmQuery, text: '第二轮新材料', latestUserText: '第二轮新材料' });
  assert.equal(floorReads, 14, '新调用按新查询和材料重新建立上下文及派生投影');
  assert.equal(currentStateReads, 2, '第二轮必须按新查询和新 CSE 材料重新建立上下文');
});

test('LLM 历史宽候选遵守48/24k总边界，可由任一类型占满且不发送BM25分数', () => {
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

test('LLM历史池先按来源楼分配首条，再按原顺序补同楼材料且预算失败不占楼名额', () => {
  const makeValue = ({ floor, seq, order, text, latestUser = 0, score = 1 }) => ({
    category: 'narrative', kind: 'event', text, floorId: `floor-${floor}`, floorMemoryId: `memory-${floor}`,
    assistantSeq: seq, sourceAssistantSeqs: [seq], score, priority: 100,
    branchScores: { latestUser }, entityBranchScores: {}, summaryScores: {}, _coreText: text,
    _subjectKey: '', _visibilityKey: 'narrative', _statusKey: `record-${floor}-${order}`, _sourceOrder: order,
    _chronology: [], _poolGroup: 'fact',
  });
  const source = { status: 'ready', bodyMatchRefs: [] };
  const historyContext = { entityById: new Map(), direct: [], adjacent: [], manualArtifacts: [] };
  for (let floor = 1; floor <= 42; floor += 1) {
    const records = floor === 1 ? 8 : 1;
    for (let order = 0; order < records; order += 1) historyContext.direct.push(makeValue({
      floor, seq: floor === 1 ? 100 : 100 - floor, order,
      text: `来源楼${floor}的独立材料${order}`, latestUser: floor === 1 ? 1 : 0.9,
    }));
  }
  const distributed = buildRecallHistoryCandidatePool({ source, queryContext: llmQuery, historyContext, maxCandidates: 36 });
  assert.equal(distributed.candidates.length, 36);
  assert.equal(new Set(distributed.candidates.map(candidate => candidate.value.floorId)).size, 36,
    '同楼的八条高排名材料不能先挤掉其他来源楼');
  assert.deepEqual(distributed.candidates.slice(0, 8).map(candidate => candidate.value.floorId),
    ['floor-1', 'floor-2', 'floor-3', 'floor-4', 'floor-5', 'floor-6', 'floor-7', 'floor-8']);

  const fewFloors = { ...historyContext, direct: historyContext.direct.filter(value => Number(value.floorId.slice(6)) <= 3) };
  const refilled = buildRecallHistoryCandidatePool({ source, queryContext: llmQuery, historyContext: fewFloors, maxCandidates: 7 });
  assert.equal(refilled.candidates.length, 7, '来源楼较少时第二遍仍用同楼材料补足候选数');
  assert.equal(refilled.candidates.filter(candidate => candidate.value.floorId === 'floor-1').length, 5,
    '第二遍按原顺位补回同楼独立记录');

  const budgetContext = { ...historyContext, direct: [
    makeValue({ floor: 'long', seq: 110, order: 0, text: '长材料'.repeat(120), latestUser: 1 }),
    makeValue({ floor: 'long', seq: 110, order: 1, text: '短的独立材料', latestUser: 0.8 }),
    makeValue({ floor: 'next', seq: 109, order: 0, text: '另一个来源楼的材料', latestUser: 0.95 }),
  ] };
  const budgeted = buildRecallHistoryCandidatePool({ source, queryContext: llmQuery, historyContext: budgetContext, maxCandidates: 2, maxCharacters: 360 });
  assert.equal(budgeted.candidates.length, 2);
  assert.deepEqual(budgeted.candidates.map(candidate => candidate.value.floorId), ['floor-next', 'floor-long'],
    '超长首选失败不占楼位；另一楼高分项先入池，之后仍按原排序让同楼低分短材料入池');
  assert.ok(budgeted.text.length <= 360);
  assert.match(budgeted.candidates[1].text, /短的独立材料/u, '字符预算失败后保留同楼原有可用材料文本');
});

test('Q 候选搭乘同一次 R/C 选材，当前故事时间可见且非法 Q 项局部过滤', async () => {
  const source = wideCandidateSource({ direct: 2 });
  source.qianshiCandidates = [
    qianshiCandidate('Q1', 'history', '已被普通历史充分覆盖的钟楼日常', { order: 0 }),
    qianshiCandidate('Q2', 'pending', '仍需归还钟楼钥匙'),
  ];
  source.qianshiProgress = {
    projectionVersion: 4,
    text: '[相关时间线]\n- 时间未知：已被普通历史充分覆盖的钟楼日常\n\n[当前待接续]\n- 仍需归还钟楼钥匙；尚未记录完成。',
    eventIds: ['Q1-event'], matterIds: ['Q2-matter'],
  };
  source.qianshiCurrentStoryTime = '大陆历1686年9月22日 20:30';
  let calls = 0, payload = null;
  const selected = await selectRecallWithLlm({ source, queryContext: llmQuery, generateUtilityTask: async options => {
    calls += 1; payload = JSON.parse(options.taskMessages[0].content);
    return { jsonData: { history_exclude_keys: [], state_exclude_keys: [], qianshi_exclude_keys: ['Q1'] } };
  } });
  assert.equal(calls, 1);
  assert.equal(payload.query.currentStoryTime, '大陆历1686年9月22日 20:30');
  assert.deepEqual(payload.qianshiCandidates.map(item => Object.keys(item).sort()), [['fact', 'key', 'kind'], ['fact', 'key', 'kind']]);
  assert.doesNotMatch(selected.qianshiProgress.text, /充分覆盖的钟楼日常/u);
  assert.match(selected.qianshiProgress.text, /\[相关跟进事项\][\s\S]*仍需归还钟楼钥匙/u);

  const cases = [
    [{ history_exclude_keys: [], state_exclude_keys: [] }, /充分覆盖的钟楼日常/u],
    [{ history_exclude_keys: [], state_exclude_keys: [], qianshi_exclude_keys: 'Q1' }, /仍需归还钟楼钥匙/u],
    [{ history_exclude_keys: [], state_exclude_keys: [], qianshi_exclude_keys: ['Q999', 7, 'Q1', 'Q1', 'R1', 'C1', null] }, /仍需归还钟楼钥匙/u],
    [{ history_exclude_keys: [], state_exclude_keys: [], qianshi_exclude_keys: [7, 'Q999', 'R1'] }, /充分覆盖的钟楼日常/u],
    [{ history_exclude_keys: [], state_exclude_keys: [], qianshi_exclude_keys: 'Q999' }, /充分覆盖的钟楼日常/u],
  ];
  for (const [jsonData, expected] of cases) {
    let caseCalls = 0;
    const result = await selectRecallWithLlm({ source, queryContext: llmQuery, generateUtilityTask: async () => { caseCalls += 1; return { jsonData }; } });
    assert.equal(caseCalls, 1);
    assert.match(result.qianshiProgress.text, expected);
  }
  for (const qianshi_exclude_keys of [{ bad: true }, null, 7, true]) {
    const kept = await selectRecallWithLlm({ source, queryContext: llmQuery,
      generateUtilityTask: async () => ({ jsonData: { history_exclude_keys: [], state_exclude_keys: [], qianshi_exclude_keys } }) });
    assert.match(kept.qianshiProgress.text, /仍需归还钟楼钥匙/u);
  }
});

test('同次可选 priority 只接受保留 R/C 键，去重封顶并按最终稳定身份报告入选', async () => {
  const source = wideCandidateSource({ direct: 14 });
  const pool = buildRecallHistoryCandidatePool({ source, queryContext: llmQuery });
  const excluded = pool.candidates.at(-1), accepted = pool.candidates.slice(0, 8);
  const priorityKeys = [accepted[0].key, accepted[1].key, accepted[0].key, excluded.key, 'P1', 'Q1', 'T1', 'R999', 7,
    ...pool.candidates.slice(2, 12).map(value => value.key)];
  let calls = 0;
  const result = await selectRecallWithLlm({ source, queryContext: llmQuery, generateUtilityTask: async options => {
    calls += 1;
    assert.match(options.systemPrompt, /最多 8 个键，不必填满/u);
    assert.match(options.systemPrompt, /不要用同主题的后期现状替代被问及的早期过程/u);
    return { jsonData: { history_exclude_keys: [excluded.key], state_exclude_keys: [], priority_keys: priorityKeys } };
  } });
  assert.equal(calls, 1, '可选 priority 不增加请求或重试');
  assert.deepEqual(result.selectorDiagnostic.priority, {
    status: 'applied', keys: accepted.map(value => value.key),
    selectedKeys: result.selectorDiagnostic.priority.selectedKeys, ignoredCount: 11,
  });
  assert.ok(result.selectorDiagnostic.priority.selectedKeys.every(key => accepted.some(value => value.key === key)));
  assert.ok(result.selectorDiagnostic.priority.selectedKeys.length > 0, '有效提示至少有一个稳定身份实际入选');
  assert.equal(JSON.stringify(result).includes('priority_keys'), false, '键提示不进入注入或回执材料');

  const noPriority = await selectRecallWithLlm({ source, queryContext: llmQuery, generateUtilityTask: async () => ({ jsonData: { history_exclude_keys: [excluded.key], state_exclude_keys: [] } }) });
  assert.equal(result.injectionText, noPriority.injectionText);
  assert.deepEqual(result.stages, noPriority.stages);
  assert.equal(noPriority.selectorDiagnostic.priority.status, 'missing');

  for (const [hint, expectedStatus] of [[[], 'empty'], [null, 'invalid'], ['R1', 'invalid'], [['R999'], 'invalid']]) {
    const replay = await selectRecallWithLlm({ source, queryContext: llmQuery, generateUtilityTask: async () => ({ jsonData: {
      history_exclude_keys: [excluded.key], state_exclude_keys: [], priority_keys: hint,
    } }) });
    assert.equal(replay.selectorDiagnostic.priority.status, expectedStatus);
    assert.equal(replay.injectionText, noPriority.injectionText);
    assert.deepEqual(replay.stages, noPriority.stages);
  }
  const unknownExclusion = await selectRecallWithLlm({ source, queryContext: llmQuery, generateUtilityTask: async () => ({ jsonData: {
    history_exclude_keys: ['R999'], state_exclude_keys: [], priority_keys: [accepted[0].key],
  } }) });
  assert.equal(unknownExclusion.selectorDiagnostic.historyExcludedCount, 0);
  assert.equal(unknownExclusion.selectorDiagnostic.historyRetainedCount, pool.candidates.length);
  assert.deepEqual(unknownExclusion.selectorDiagnostic.priority.keys, [accepted[0].key]);
});

test('正式选择器在预算竞争中先试合法 priority，保留CSE身份；真实时间项触发原序timeGuard', async () => {
  const source = wideCandidateSource({ direct: 30 });
  const queryContext = { ...llmQuery, text: '钟楼钥匙', latestUserText: '钟楼钥匙' };
  const pool = buildRecallHistoryCandidatePool({ source, queryContext });
  const oldest = [...pool.candidates].sort((a, b) => a.value.assistantSeq - b.value.assistantSeq)[0];
  const plain = selectRecall({ source, queryContext, contextSize: 1000, selectedHistoryCandidates: pool.candidates, selectedCseCandidates: [] });
  const prioritized = selectRecall({ source, queryContext, contextSize: 1000, selectedHistoryCandidates: pool.candidates, selectedCseCandidates: [],
    priorityCandidates: [{ key: oldest.key, stableKey: oldest.stableKey }] });
  const containsOldest = result => result.floors.some(floor => floor.floorId === oldest.value.floorId && floor.floorMemoryId === oldest.value.floorMemoryId);
  assert.equal(containsPlain(), false);
  assert.equal(containsOldest(prioritized), true, '预算竞争下正式选择器实际改变了入选材料');
  assert.deepEqual(prioritized.prioritySelection, { timeGuard: false, selectedKeys: [oldest.key] });
  assert.ok(prioritized.stages.estimatedTokenCount <= prioritized.stages.estimatedTokenBudget);
  const constrainedSource = wideCandidateSource({ direct: 8, long: true });
  constrainedSource.floorMemories.slice(0, 7).forEach((memory, index) => { memory.events[0].description = `${'很长的相关事实'.repeat(220)} ${index}`; });
  constrainedSource.floorMemories[7].events[0].description = '直接命中的相关事实 7';
  const constrainedPool = buildRecallHistoryCandidatePool({ source: constrainedSource, queryContext });
  const budgetHints = constrainedPool.candidates.slice(0, 8).map(value => ({ key: value.key, stableKey: value.stableKey }));
  const budgetLimited = selectRecall({ source: constrainedSource, queryContext, contextSize: 1000, selectedHistoryCandidates: constrainedPool.candidates, selectedCseCandidates: [], priorityCandidates: budgetHints });
  assert.ok(budgetLimited.prioritySelection.selectedKeys.length > 0);
  assert.ok(budgetLimited.prioritySelection.selectedKeys.length < budgetHints.length, '最终selectedKeys排除经接受但被原预算舍弃的提示');
  let utilityCalls = 0;
  const formalRun = priorityKeys => selectRecallWithLlm({ source, queryContext, contextSize: 1000, generateUtilityTask: async () => {
    utilityCalls += 1;
    return { jsonData: { history_exclude_keys: [], state_exclude_keys: [], ...(priorityKeys ? { priority_keys: priorityKeys } : {}) } };
  } });
  const formalPlain = await formalRun(null), formalPriority = await formalRun([oldest.key]);
  assert.equal(containsOldest(formalPlain), false);
  assert.equal(containsOldest(formalPriority), true, '同一次正式 LLM 入口的合法提示可改变真实入选');
  assert.equal(formalPriority.selectorDiagnostic.priority.status, 'applied');
  assert.deepEqual(formalPriority.selectorDiagnostic.priority.selectedKeys, [oldest.key]);
  assert.equal(utilityCalls, 2);
  function containsPlain() { return containsOldest(plain); }

  source.timeProjection = { corrections: {}, reminders: [{ itemId: 'priority-time-guard', type: 'deadline', subjectEntityId: PERSON,
    distance: 0, text: '钟楼钥匙今日必须归还' }] };
  const withTimePlain = selectRecall({ source, queryContext, contextSize: 1000, selectedHistoryCandidates: pool.candidates, selectedCseCandidates: [] });
  const withTimePriority = selectRecall({ source, queryContext, contextSize: 1000, selectedHistoryCandidates: pool.candidates, selectedCseCandidates: [],
    priorityCandidates: [{ key: oldest.key, stableKey: oldest.stableKey }] });
  assert.equal(withTimePriority.prioritySelection.timeGuard, true);
  assert.deepEqual(withTimePriority.timeDependencies.reminders.map(value => value.itemId), ['priority-time-guard'], 'timeGuard证据必须对应真实选中的时间提醒');
  assert.equal(withTimePriority.injectionText, withTimePlain.injectionText);
  assert.deepEqual(withTimePriority.stages, withTimePlain.stages);
  assert.deepEqual(withTimePriority.timeDependencies, withTimePlain.timeDependencies);

  const filteredAnnual = structuredClone(source);
  filteredAnnual.timeProjection = { corrections: {}, reminders: [{ itemId: 'far-annual', type: 'annual', subjectEntityId: PERSON,
    distance: 8, text: '远期纪念日' }] };
  const noCompetingTime = selectRecall({ source: filteredAnnual, queryContext, contextSize: 1000, selectedHistoryCandidates: pool.candidates,
    selectedCseCandidates: [], selectedAnnualReminderIds: [], priorityCandidates: [{ key: oldest.key, stableKey: oldest.stableKey }] });
  assert.equal(noCompetingTime.prioritySelection.timeGuard, false, '过滤掉的远期annual不得触发timeGuard');
  const unmatchedTime = structuredClone(source);
  unmatchedTime.timeProjection = { corrections: {}, reminders: [{ itemId: 'unmatched-time', type: 'other', subjectEntityId: PERSON,
    distance: 0, text: '完全无关的提醒' }] };
  const noScoringTime = selectRecall({ source: unmatchedTime, queryContext, contextSize: 1000, selectedHistoryCandidates: pool.candidates,
    selectedCseCandidates: [], priorityCandidates: [{ key: oldest.key, stableKey: oldest.stableKey }] });
  assert.equal(noScoringTime.prioritySelection.timeGuard, false, 'score为0且不进入竞争的时间候选不得触发timeGuard');
});

test('R/C 智能选材可排已充分覆盖的相关旧观察，同时保留独立后果与状态转折', async () => {
  const memories = Array.from({ length: 12 }, (_, index) => recallMemory(index + 1, {
    summary: index === 11 ? '裴晚生仍把蓝铜钥匙放在口袋' : '',
    events: index === 1
      ? [{ title:'反复观察钥匙', description:'裴晚生仍把蓝铜钥匙放在口袋', candidateStatus:'accepted' }]
      : index === 2 ? [{ title:'蓝铜钥匙失窃', description:'失窃导致钟楼门锁无法打开', candidateStatus:'accepted' }] : [],
  }));
  const duplicateState = recallState('duplicate-key-state', '仍把蓝铜钥匙放在口袋', 12);
  const before = recallState('before-report-state', '尚未决定如何处理钥匙失窃', 2);
  const after = recallState('after-report-state', '决定报警追查失窃者', 3);
  const source = selectorSource({ memories, currentState:[{ subjectEntityId:PERSON, core:[], adaptive:[duplicateState], situational:[after] }] });
  source.cseChanges = [{ deltaId:'report-turn', floorId:'floor-3', assistantSeq:3, subjectEntityId:PERSON, layer:'situational', action:'refine', before, after }];
  const queryContext = { ...llmQuery, text:'继续蓝铜钥匙失窃后的事', latestUserText:'继续蓝铜钥匙失窃后的事' };
  const historyPool = buildRecallHistoryCandidatePool({ source, queryContext });
  const csePool = buildRecallCseCandidatePool({ source, queryContext });
  const duplicateHistory = historyPool.candidates.find(value => value.value.text.includes('仍把蓝铜钥匙放在口袋'));
  const uniqueHistory = historyPool.candidates.find(value => value.value.text.includes('失窃导致钟楼门锁无法打开'));
  const duplicateCurrent = csePool.candidates.find(value => value.source === 'current' && value.value.stateId === duplicateState.stateId);
  const retainedCurrent = csePool.candidates.find(value => value.source === 'current' && value.value.stateId === after.stateId);
  const uniqueChange = csePool.candidates.find(value => value.source === 'change' && value.value.deltaId === 'report-turn');
  assert.ok(duplicateHistory && uniqueHistory && duplicateCurrent && retainedCurrent && uniqueChange, '合成材料必须真实进入同轮 R/C 候选');

  let payload;
  const result = await selectRecallWithLlm({ source, queryContext, generateUtilityTask:async options => {
    payload = JSON.parse(options.taskMessages[0].content);
    assert.match(options.systemPrompt, /已被 P、当前 C 或另一条保留材料充分表达/u);
    assert.match(options.systemPrompt, /真实起因、重要转折、独立后果和必要证据/u);
    assert.match(options.systemPrompt, /同主题、同人物或措辞相似不自动等于重复/u);
    return { jsonData:{ history_exclude_keys:[duplicateHistory.key], state_exclude_keys:[duplicateCurrent.key],
      priority_keys:[retainedCurrent.key, uniqueChange.key, duplicateCurrent.key] } };
  } });
  assert.match(payload.alreadyProvided.recentContinuation.at(-1).summary, /仍把蓝铜钥匙放在口袋/u);
  assert.equal(result.floors.some(floor => floor.assistantSeq === 2 && floor.items.some(item => item.text.includes('仍把蓝铜钥匙放在口袋'))), false);
  assert.equal(result.floors.some(floor => floor.items.some(item => item.text.includes('失窃导致钟楼门锁无法打开'))), true);
  assert.equal(result.states.some(value => value.stateId === duplicateState.stateId), false);
  assert.equal(result.cseChanges.some(value => value.deltaId === 'report-turn'), true);
  assert.deepEqual(result.selectorDiagnostic.priority.keys, [retainedCurrent.key, uniqueChange.key], 'current/change 使用经候选池校验的稳定身份，排除态不复活');
  assert.deepEqual(result.selectorDiagnostic.priority.selectedKeys, [retainedCurrent.key, uniqueChange.key], 'current与change都必须在最终身份集合中，而非空数组通过every');
  assert.equal(result.selectorDiagnostic.priority.ignoredCount, 1);
  assert.match(result.injectionText, /失窃导致钟楼门锁无法打开|决定报警追查失窃者/u);
});

test('Q-only 保持零 API，本地降级仍保留有界未竟提醒', async () => {
  const source = selectorSource();
  source.qianshiCandidates = [qianshiCandidate('Q1', 'pending', '旧日承诺仍未履行')];
  source.qianshiProgress = { projectionVersion: 4, text: '[当前待接续]\n- 旧日承诺仍未履行；尚未记录完成。', eventIds: [], matterIds: ['Q1-matter'] };
  let calls = 0;
  const selected = await selectRecallWithLlm({ source, queryContext: { ...llmQuery, text: '宇宙飞船', latestUserText: '宇宙飞船' },
    generateUtilityTask: async () => { calls += 1; } });
  assert.equal(calls, 0);
  assert.equal(selected.selectorDiagnostic.mode, 'local');
  assert.match(selected.qianshiProgress.text, /旧日承诺仍未履行/u);
});

test('Q 过滤后补位不会挤掉已供模型的 P，大 Q、小 context 与前情共享原总预算', async () => {
  const source = wideCandidateSource({ direct: 2 });
  source.qianshiCandidates = [
    qianshiCandidate('Q1', 'pending', '超长候选', { line: `- ${'超长'.repeat(2200)}；尚未记录完成。` }),
    qianshiCandidate('Q2', 'pending', '可补位候选', { line: `- ${'较短'.repeat(1250)}；尚未记录完成。` }),
  ];
  source.qianshiProgress = null;
  const reservedCharacters = 500, reservedTokens = 500;
  let payload = null, calls = 0;
  const selected = await selectRecallWithLlm({ source, queryContext: llmQuery, contextSize: 12000, reservedCharacters, reservedTokens,
    generateUtilityTask: async options => {
      calls += 1; payload = JSON.parse(options.taskMessages[0].content);
      return { jsonData: { history_exclude_keys: [], state_exclude_keys: [], qianshi_exclude_keys: ['Q1'] } };
    } });
  assert.equal(calls, 1);
  assert.ok(payload.alreadyProvided.recentContinuation.length > 0, 'planned P 必须按Q可占上限预留后实际提供');
  for (const item of payload.alreadyProvided.recentContinuation) assert.match(selected.injectionText, new RegExp(item.summary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
  assert.match(selected.qianshiProgress.text, /较短/u);
  const budget = recallBudget(12000);
  const qBlock = `\n\n<qqj_qianshi_progress>\n${selected.qianshiProgress.text}\n</qqj_qianshi_progress>`;
  assert.ok(selected.injectionText.length + qBlock.length + reservedCharacters <= budget.totalCharacters);
  assert.ok(estimateRecallTokens(selected.injectionText) + estimateRecallTokens(qBlock) + reservedTokens <= budget.totalTokens);
});

test('大量人物事实按相关性统一竞争而不套类型配额，fake LLM 选中后真实注入', async () => {
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
  assert.equal(pool.candidates.length, 48);
  assert.ok(pool.text.length <= 24000);
  assert.equal(new Set(pool.candidates.map(value => value.value.floorId)).size, 36, '每个相关旧来源楼先获得一条候选，再补同楼细节');
  for (const kind of ['summary', 'commitment', 'openLoop', 'event']) assert.ok(pool.candidates.some(value => value.value.kind === kind), `${kind} 按相关性竞争而不是类型配额`);
  assert.match(pool.text, /类型 summary/);
  assert.match(pool.text, /类型 commitment/);
  assert.match(pool.text, /类型 openLoop/);

  const retainedKeys = [
    pool.candidates.find(value => value.value.kind === 'summary').key,
    pool.candidates.find(value => value.value.kind === 'commitment').key,
    pool.candidates.find(value => value.value.kind === 'openLoop').key,
    pool.candidates.find(value => value.value.kind === 'event').key,
  ];
  let payload = null;
  const selected = await selectRecallWithLlm({ source, queryContext, generateUtilityTask: async options => {
    assert.doesNotMatch(options.systemPrompt, /8000/u, '本地总预算不得写入模型排除提示词');
    payload = JSON.parse(options.taskMessages[0].content);
    return { jsonData: { history_exclude_keys: pool.candidates.map(value => value.key).filter(key => !retainedKeys.includes(key)), state_exclude_keys: [] }, taskMetadata: { finishReason: 'stop' } };
  } });
  assert.equal(payload.candidates.length, 48);
  assert.ok(payload.candidates.some(value => value.fact.includes('类型 summary')));
  assert.ok(payload.candidates.some(value => value.fact.includes('类型 commitment')));
  assert.ok(payload.candidates.some(value => value.fact.includes('类型 openLoop')));
  assert.ok(payload.candidates.some(value => value.fact.includes('类型 event')));
  for (const kind of ['summary', 'commitment', 'openLoop', 'event']) assert.ok(selected.floors.some(floor => floor.items.some(item => item.kind === kind)), `${kind} 的明确保留项必须进入最终材料`);
  assert.doesNotMatch(selected.injectionText, /叙事回顾可能含内心、计划或未完成事项/);
  assert.match(selected.injectionText, /港口夜航承诺/);
  assert.match(selected.injectionText, /当时未结事项/u);
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
  assert.equal(calls[0].maxTokens, 8192);
  assert.deepEqual(calls[0].transportBudget, { remaining: 3, used: 0 });
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

test('LLM 排除忽略外层字段，合法重复去重且非法项不影响有效排除', async () => {
  const source = wideCandidateSource({ direct: 2 });
  source.currentState = [{ subjectEntityId: PERSON, core: [{ text: '始终谨慎守约', visibility: 'authorial', reason: '人物核心', origin: 'baseline', towardEntityId: null, sourceAssistantSeq: 1 }], adaptive: [], situational: [] }];
  const pool = buildRecallHistoryCandidatePool({ source, queryContext: llmQuery });
  const key = pool.candidates[0].key;
  const duplicate = await selectRecallWithLlm({ source, queryContext: llmQuery, generateUtilityTask: async () => ({ jsonData: { history_exclude_keys: [key, key], state_exclude_keys: [], explanation: '多余字段' } }) });
  assert.equal(duplicate.skipReasons.includes('historySelectionFallback'), false);
  assert.equal(duplicate.selectorDiagnostic.historyExcludedCount, 1);
  const mixed = await selectRecallWithLlm({ source, queryContext: llmQuery, generateUtilityTask: async () => ({ jsonData: {
    history_exclude_keys: ['R999', 'C1', 7, key, key, null], state_exclude_keys: [],
  } }) });
  assert.equal(mixed.selectorDiagnostic.historyExcludedCount, 1);
  assert.equal(mixed.injectionText, duplicate.injectionText);
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
  memories[7] = recallMemory(8, { summary: '密门计划的旧可见楼仍有一项独立变化。' });
  const source = selectorSource({ memories });
  source.bodyMatch = { coveredFloorIds: ['floor-7'], visibleFloorIds: ['floor-8'], recentBodyFloorIds: ['floor-7'] };
  const pool = buildRecallHistoryCandidatePool({ source, queryContext: { ...llmQuery, text: '密门计划', latestUserText: '密门计划' } });
  assert.match(pool.text, /私有资料；知情：裴晚生/);
  assert.match(pool.text, /当时计划/);
  assert.doesNotMatch(pool.text, /这条最近正文不该进入候选/);
  const context = historySelectionContext(source, { ...llmQuery, text: '密门计划', latestUserText: '密门计划' });
  assert.ok(context.recentSummaries.some(value => value.floorId === 'floor-8'), '四份续接摘要从近期原文基座之外独立保留');
  assert.equal(context.bodyCoveredFloorIds.has('floor-8'), false, '超出近期基座的旧可见楼仍有普通候选资格');
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
      calls += 1; assert.deepEqual(transportBudget, { remaining: 3, used: 0 });
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

test('明确选择的 add 仅在严格相同 current 最终入选时去重，不改真实变化或同字异源状态', () => {
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  memories[0] = recallMemory(1, {
    participants: [{ entityId: PERSON, presence: 'present' }],
    events: [{ title: '蓝铜账本入库', description: '蓝铜账本已经交入旧仓保管', candidateStatus: 'accepted' }],
  });
  const current = recallState('linked-current-dedup', '因蓝铜账本入库而继续守在旧仓门边', 1, {
    sourceFloorId: 'floor-1', sourceDeltaId: 'linked-add-dedup', towardEntityId: '88888888-7777-4777-8777-777777777777',
  });
  const differentSource = recallState('linked-current-other-source', current.text, 1, {
    sourceFloorId: 'floor-1', sourceDeltaId: 'linked-add-other', towardEntityId: '88888888-7777-4777-8777-777777777777',
  });
  const prior = recallState('linked-current-prior', '因蓝铜账本入库而在旧仓外等候', 1, {
    sourceFloorId: 'floor-1', sourceDeltaId: 'linked-refine-prior', towardEntityId: '88888888-7777-4777-8777-777777777777',
  });
  const source = selectorSource({ memories, currentState: [{ subjectEntityId: PERSON, core: [], adaptive: [current], situational: [] }] });
  source.cseChanges = [
    { deltaId: 'linked-add-dedup', floorId: 'floor-1', assistantSeq: 1, subjectEntityId: PERSON, layer: 'adaptive', action: 'add', before: null, after: current },
    { deltaId: 'linked-add-other', floorId: 'floor-1', assistantSeq: 1, subjectEntityId: PERSON, layer: 'adaptive', action: 'add', before: null, after: differentSource },
    { deltaId: 'linked-refine-current', floorId: 'floor-1', assistantSeq: 1, subjectEntityId: PERSON, layer: 'adaptive', action: 'refine', before: prior, after: current },
  ];
  const queryContext = { text: '蓝铜账本旧仓门边', latestUserText: '蓝铜账本旧仓门边', messageCount: 1 };
  const history = buildRecallHistoryCandidatePool({ source, queryContext }).candidates.find(value => value.value.floorId === 'floor-1' && value.value.kind === 'event');
  const cseCandidates = buildRecallCseCandidatePool({ source, queryContext }).candidates;
  const selectedChanges = cseCandidates.filter(value => value.source === 'change');
  const selectedCurrent = cseCandidates.find(value => value.source === 'current' && value.value.stateId === current.stateId);
  assert.ok(history && selectedCurrent);
  assert.equal(selectedChanges.length, 2, '同源 add 已在候选阶段由 current 表达');

  const withCurrent = selectRecall({ source, queryContext, contextSize: 12000, selectedHistoryCandidates: [history], selectedCseCandidates: [selectedCurrent, ...selectedChanges] });
  assert.equal(withCurrent.states.some(value => value.stateId === current.stateId), true);
  assert.equal(withCurrent.cseChanges.some(value => value.deltaId === 'linked-add-dedup'), false, '最终 current 已保留时才删除同来源同内容 add');
  assert.equal(withCurrent.cseChanges.some(value => value.deltaId === 'linked-add-other'), true, '同字但不同 state/source 的 add 仍是独立证据');
  assert.equal(withCurrent.cseChanges.some(value => value.deltaId === 'linked-refine-current'), true, '真实 refine 前后变化不能因 after 等于 current 被删除');

  const noCurrentSource = { ...source, currentState: [] };
  const withoutCurrentChanges = buildRecallCseCandidatePool({ source: noCurrentSource, queryContext }).candidates.filter(value => value.source === 'change');
  assert.equal(withoutCurrentChanges.length, 3);
  const withoutCurrent = selectRecall({ source: noCurrentSource, queryContext, contextSize: 12000, selectedHistoryCandidates: [history], selectedCseCandidates: withoutCurrentChanges });
  assert.equal(withoutCurrent.states.length, 0);
  assert.equal(withoutCurrent.cseChanges.some(value => value.deltaId === 'linked-add-dedup'), true, 'current 未入选时必须保留唯一 add 证据');
});

test('CSE 宽候选按统一相关性竞争，不再预留 current/change 各半名额', () => {
  const current = Array.from({ length:20 }, (_, index) => recallState(`current-key-${index}`, `钥匙核心状态 ${index}`, index + 1, { reason:'钥匙直接相关', visibility:'authorial' }));
  const source = selectorSource({ currentState:[{ subjectEntityId:PERSON, core:current, adaptive:[], situational:[] }] });
  source.cseChanges = Array.from({ length:20 }, (_, index) => ({
    deltaId:`change-key-${index}`, floorId:`change-floor-${index}`, assistantSeq:index + 30, subjectEntityId:PERSON, layer:'situational', action:'refine',
    before:recallState(`before-key-${index}`, `普通旧状态 ${index}`, index + 29),
    after:recallState(`after-key-${index}`, `钥匙变化状态 ${index}`, index + 30),
  }));
  const pool = buildRecallCseCandidatePool({ source, queryContext:{ text:'钥匙核心状态', latestUserText:'钥匙核心状态', messageCount:1 } });
  assert.equal(pool.candidates.length, 24);
  assert.ok(pool.limits.currentCandidates > 12, '更相关的 current 可以占用旧半区以外的名额');
  assert.equal(pool.limits.currentCandidates + pool.limits.changeCandidates, 24);
});

test('剧情线变化只复用前文已完整打印的同源 after，非紧邻 before 复用正文但保留各次依据', () => {
  const towardEntityId = '88888888-7777-4777-8777-777777777777';
  const stateA = { ...recallState('dedup-state-a', '仍把钥匙握在掌心', 4, { reason:'亲手接过钥匙后的完整依据甲', towardEntityId }), toward:'林岚' };
  const stateB = { ...recallState('dedup-state-b', '仍在门边等候', 4, { reason:'留在门边的完整依据乙', towardEntityId, visibility:'authorial' }), toward:'林岚' };
  const differentSource = { ...recallState('dedup-state-c', stateA.text, 6, { reason:'相同文字但不同来源与对象的独立依据', towardEntityId:'99999999-7777-4777-8777-777777777777' }), toward:'乙' };
  const change = (deltaId, assistantSeq, storylineId, action, before, after) => ({
    deltaId, assistantSeq, storylineId, subjectEntityId:PERSON, subject:'裴晚生', layer:'situational', action, before, after,
  });
  const injection = formatRecallInjection({
    coverage:selectorSource().coverage,
    floors:[], states:[],
    entityById:new Map(selectorSource().entities.map(value => [value.entityId, value])),
    storylines:[
      { storylineId:'line-a', title:'门边旧事', basis:'同一人物与门边状态' },
      { storylineId:'line-b', title:'另一条线', basis:'独立剧情线' },
    ],
    cseChanges:[
      change('delta-4-a', 4, 'line-a', 'add', null, stateA),
      change('delta-4-b', 4, 'line-a', 'add', null, stateB),
      change('delta-5-a', 5, 'line-a', 'remove', stateA, null),
      change('delta-5-b', 5, 'line-a', 'remove', stateB, null),
      change('delta-6-c', 6, 'line-a', 'remove', differentSource, null),
      change('delta-7-a', 7, 'line-b', 'remove', stateA, null),
    ],
  });
  const count = text => injection.split(text).length - 1;
  assert.equal(count('正文相同，完整正文见 AI #4 上述“之后”状态'), 2, '两项非紧邻同文 before 都应引用楼4已完整打印的 after');
  assert.equal(count(stateA.reason), 3, '完整 after 与两条 before 引用均保留各自依据');
  assert.equal(count(stateB.reason), 2, '完整 after 与 before 引用均保留各自依据');
  assert.equal(count('相同文字但不同来源与对象的独立依据'), 1);
  assert.equal(count('- [变化]'), 6, '不得删除任何变化');
  assert.match(injection, /可见性：私密，态度对象：林岚：正文相同，完整正文见 AI #4/);
  assert.match(injection, /可见性：作者设定，态度对象：林岚：正文相同，完整正文见 AI #4/);
  assert.match(injection, /可见性：私密，态度对象：乙：仍把钥匙握在掌心（依据：相同文字但不同来源与对象的独立依据/);
});

test('同一主体的同文之后状态复用正文，但保留每次理由和来源；归属不同则完整显示', () => {
  const targetA = '88888888-7777-4777-8777-777777777777';
  const targetB = '99999999-7777-4777-8777-777777777777';
  const text = '本周五把钥匙交给林岚';
  const first = recallState('body-50', text, 50, { reason: 'AI50依据：双方确认交付', visibility: 'observable', towardEntityId: targetA });
  const sameBodyNewReason = recallState('body-52', text, 52, { reason: 'AI52依据：再次核对交付时间', visibility: 'observable', towardEntityId: targetA });
  const differentTarget = recallState('body-target', text, 53, { reason: '对象不同的依据', visibility: 'observable', towardEntityId: targetB });
  const differentVisibility = recallState('body-visibility', text, 54, { reason: '知情范围不同的依据', visibility: 'private', towardEntityId: targetA });
  const differentOrigin = recallState('body-origin', text, 55, { reason: '来源类型不同的依据', visibility: 'observable', towardEntityId: targetA, origin: 'manual' });
  const sameNameOtherSubject = recallState('body-other-subject', text, 56, { reason: '另一主体的依据', visibility: 'observable', towardEntityId: targetA });
  const change = (deltaId, assistantSeq, subjectEntityId, before, after, layer = 'situational') => ({
    deltaId, assistantSeq, storylineId: 'delivery-line', subjectEntityId, subject: '裴晚生', layer, action: before ? 'update' : 'add', before, after,
  });
  const injection = formatRecallInjection({
    coverage: { ...selectorSource().coverage, stableThroughAssistantSeq: 70 }, floors: [], states: [],
    entityById: new Map([
      [PERSON, { entityId: PERSON, displayName: '裴晚生' }],
      [targetA, { entityId: targetA, displayName: '林岚' }],
      [targetB, { entityId: targetB, displayName: '乙' }],
      ['another-subject-id', { entityId: 'another-subject-id', displayName: '裴晚生' }],
    ]),
    storylines: [{ storylineId: 'delivery-line', title: '钥匙交付', basis: 'subject' }],
    cseChanges: [
      change('delta-50', 50, PERSON, null, first),
      change('delta-52', 52, PERSON, recallState('before-52', '原先尚未确定交付日', 51), sameBodyNewReason),
      change('delta-target', 53, PERSON, null, differentTarget),
      change('delta-visibility', 54, PERSON, null, differentVisibility),
      change('delta-origin', 55, PERSON, null, differentOrigin),
      change('delta-other-subject', 56, 'another-subject-id', null, sameNameOtherSubject),
    ],
  });
  const count = value => injection.split(value).length - 1;
  assert.equal(count(text), 5, '仅第二条完全同归属的正文省略；对象、可见范围、来源类型和主体不同的四条保留');
  assert.match(injection, /正文相同，完整正文见 AI #50[\s\S]*本条依据：AI52依据：再次核对交付时间/u);
  assert.match(injection, /AI #50[\s\S]*AI #52[\s\S]*AI #53[\s\S]*AI #54[\s\S]*AI #55[\s\S]*AI #56/u,
    '每条状态变化和对应来源楼均保留');
  for (const reason of ['双方确认交付', '再次核对交付时间', '对象不同的依据', '知情范围不同的依据', '来源类型不同的依据', '另一主体的依据']) {
    assert.match(injection, new RegExp(reason, 'u'), `依据不能因正文复用而丢失：${reason}`);
  }
});

test('召回范围用实际稳定楼序标注，不拿楼数冒充 assistantSeq', () => {
  const source = selectorSource();
  source.coverage.stableThroughAssistantSeq = 70;
  const injectionText = formatRecallInjection({ coverage: source.coverage,
    floors: [{ floorId: 'floor-1', assistantSeq: 19, chronology: [], items: [{ category: 'narrative', text: '雨夜承诺' }] }],
    states: [], cseChanges: [], entityById: new Map(), storylines: [] });
  assert.match(injectionText, /本轮资料范围：已稳定到 AI #70/u);
  assert.doesNotMatch(injectionText, /本轮资料范围：已稳定到 AI #8/u);
});

test('无剧情线变化按实际列表顺序复用同源 after，且不跨 storylineId 省略依据', () => {
  const stateA = { ...recallState('flat-state-a', '仍记得那枚书签', 8, { reason:'书签状态的完整依据' }), toward:null };
  const stateB = { ...recallState('flat-state-b', '仍保留旧信封', 8, { reason:'信封状态的完整依据', visibility:'authorial' }), toward:null };
  const change = (deltaId, assistantSeq, storylineId, action, before, after) => ({
    deltaId, assistantSeq, storylineId, subjectEntityId:PERSON, subject:'裴晚生', layer:'adaptive', action, before, after,
  });
  const injection = formatRecallInjection({
    coverage:selectorSource().coverage, floors:[], states:[], storylines:[], entityById:new Map(),
    cseChanges:[
      change('flat-8-a', 8, 'line-a', 'add', null, stateA),
      change('flat-8-b', 8, 'line-a', 'add', null, stateB),
      change('flat-9-a', 9, 'line-a', 'remove', stateA, null),
      change('flat-9-b', 9, 'line-a', 'remove', stateB, null),
      change('flat-10-a', 10, 'line-b', 'remove', stateA, null),
    ],
  });
  const count = text => injection.split(text).length - 1;
  assert.equal(count('正文相同，完整正文见 AI #8 上述“之后”状态'), 2);
  assert.equal(count(stateA.reason), 3, '另一 storylineId 的 before 不能引用 line-a 的 after，且每次保留依据');
  assert.equal(count(stateB.reason), 2, '同一 storyline 的 before 引用保留其依据');
  assert.equal(injection.match(/^- 主体：裴晚生 \/ adaptive \/ 来源 AI #/gmu)?.length, 5, '五条变化及其来源楼都应保留');
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
  assert.match(result.injectionText, /之后 [^\n]*正文与本线当前快照相同/);
  assert.ok(result.injectionText.indexOf('[来源 AI #42]') < result.injectionText.indexOf('[来源 AI #43]'));
  assert.ok(result.injectionText.indexOf('[来源 AI #43]') < result.injectionText.indexOf('[已保存人物状态依据]'), '历史变化按楼序排列，已保存快照最后');
  assert.doesNotMatch(result.injectionText, /左佐已经改变|应当变得|用户期待/);
});

test('智能选材只执行排除任务，旧 state_progressions 返回字段不会进入选择结果或注入', async () => {
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
  assert.equal(Object.hasOwn(result, 'stateProgressions'), false);
  assert.doesNotMatch(result.injectionText, /时间推演|控制冲动仍有余波/);
  assert.doesNotMatch(result.injectionText, /伪造建议/);
  assert.equal(Object.hasOwn(result.stages, 'stateProgressionCount'), false);
  assert.ok(result.stages.estimatedTokenCount <= result.stages.estimatedTokenBudget);
  assert.doesNotMatch(RECALL_LLM_SYSTEM_PROMPT, /state_progressions|source_state_key|time_basis/);

  if (evidence) {
    const excluded = await selectRecallWithLlm({ source, queryContext, contextSize:1000, generateUtilityTask: async () => ({ jsonData: {
      history_exclude_keys:[evidence.key], state_exclude_keys:[],
      state_progressions:[{ source_state_key:sourceState.key, evidence_keys:[evidence.key], time_basis:'过了一阵', suggestion:'这条证据已经被排除，不应保留'.repeat(20) }],
    } }) });
    assert.equal(Object.hasOwn(excluded, 'stateProgressions'), false);
    assert.doesNotMatch(excluded.injectionText, /这条证据已经被排除/);
  }
});

test('state_progressions 缺失、畸形或超长均不改变成功选材', async () => {
  const source = changingCseSource();
  const queryContext = { ...llmQuery, text:'左佐和辛夷的门锁', latestUserText:'左佐和辛夷的门锁' };
  const pool = buildRecallCseCandidatePool({ source, queryContext });
  const sourceState = pool.candidates.find(value => value.source === 'current');
  const missing = await selectRecallWithLlm({ source, queryContext, generateUtilityTask: async () => ({ jsonData:{ history_exclude_keys:[], state_exclude_keys:[] } }) });
  assert.equal(Object.hasOwn(missing, 'stateProgressions'), false);
  assert.ok(missing.states.length + missing.cseChanges.length > 0);
  const malformed = await selectRecallWithLlm({ source, queryContext, generateUtilityTask: async () => ({ jsonData:{ history_exclude_keys:[], state_exclude_keys:[], state_progressions:[null, { source_state_key:sourceState.key, evidence_keys:'bad', time_basis:'稍后', suggestion:'不应出现' }] } }) });
  assert.equal(Object.hasOwn(malformed, 'stateProgressions'), false);
  assert.ok(malformed.states.length + malformed.cseChanges.length > 0);
  const budgeted = await selectRecallWithLlm({ source, queryContext, contextSize:1000, generateUtilityTask: async () => ({ jsonData:{ history_exclude_keys:[], state_exclude_keys:[], state_progressions:[{ source_state_key:sourceState.key, evidence_keys:[], time_basis:'时间仍然模糊', suggestion:'很长的表现建议'.repeat(100) }] } }) });
  assert.equal(Object.hasOwn(budgeted, 'stateProgressions'), false);
  assert.ok(budgeted.stages.estimatedTokenCount <= budgeted.stages.estimatedTokenBudget);
});

test('旧推演返回字段不改变8000总预算，普通楼、状态、变化、剧情线与候选输入保持不变', async () => {
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
  source.timeProjection = { corrections: {}, reminders: [{ itemId:'important-time', type:'deadline', subjectEntityId:PERSON, distance:0, text:'蓝铜推演今天有约定事项尚未完成' }] };
  const ordinary = await run(false);
  const extended = await run(true);
  assert.equal(calls, 2, '每次选材仍只调用一次 utility');
  assert.deepEqual(payloads[1], payloads[0], '时间推演输出不得改变送入模型的普通候选');
  assert.equal(ordinary.stages.estimatedTokenBudget, 8000);
  assert.equal(ordinary.limits.maxCharacters, 27500);
  assert.ok(ordinary.stages.estimatedTokenCount <= ordinary.stages.estimatedTokenBudget);
  assert.equal(extended.stages.estimatedTokenBudget, 8000);
  assert.equal(extended.limits.maxCharacters, 27500);
  assert.deepEqual(extended.floors, ordinary.floors);
  assert.deepEqual(extended.states, ordinary.states);
  assert.deepEqual(extended.cseChanges, ordinary.cseChanges);
  assert.deepEqual(extended.storylines, ordinary.storylines);
  assert.equal(Object.hasOwn(extended, 'stateProgressions'), false);
  assert.equal(extended.injectionText, ordinary.injectionText, '旧返回字段必须被彻底忽略');
  assert.equal(extended.stages.timeReminderCount, 1, '旧字段不得令预先选入的时间提醒丢失');
  assert.deepEqual(extended.timeDependencies.reminders, ordinary.timeDependencies.reminders);
  assert.ok(extended.stages.estimatedTokenCount <= extended.stages.estimatedTokenBudget);
});

test('召回预算按小宿主上下文和前情预留收紧，旧推演候选参数被忽略', () => {
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
  assert.equal(small.stages.estimatedTokenBudget, 800);
  assert.equal(small.limits.maxCharacters, 800);
  assert.equal(Object.hasOwn(small, 'stateProgressions'), false);

  const reserved = selectRecall({ source, queryContext, contextSize:50000, reservedTokens:750, reservedCharacters:2500, selectedCseCandidates:csePool.candidates, stateProgressionCandidates:candidates });
  assert.equal(reserved.stages.estimatedTokenBudget, 7250);
  assert.equal(reserved.limits.maxCharacters, 25000);
  assert.equal(Object.hasOwn(reserved, 'stateProgressions'), false);
  assert.ok(reserved.stages.estimatedTokenCount <= reserved.stages.estimatedTokenBudget);
  assert.ok(reserved.limits.actualCharacters <= reserved.limits.maxCharacters);
});

test('相关时间参考与其他材料共用总预算，不再受600字符独立配额', () => {
  const source = selectorSource();
  source.timeProjection = { corrections:{}, reminders:Array.from({ length:10 }, (_, index) => ({
    itemId:`deadline-${index}`, type:'deadline', subjectEntityId:PERSON, distance:index % 7,
    text:`期限提醒 ${index + 1} ${'完整时间依据'.repeat(18)}`,
  })) };
  const result = selectRecall({ source, contextSize:50000, queryContext:{ text:'期限提醒', latestUserText:'期限提醒', messageCount:1 }, selectedHistoryCandidates:[], selectedCseCandidates:[] });
  assert.equal(result.timeDependencies.reminders.length, 10);
  assert.ok(result.timeDependencies.reminders.reduce((sum, value) => sum + value.text.length, 0) > 600);
  assert.ok(result.limits.actualCharacters <= result.limits.maxCharacters);
  assert.ok(result.limits.estimatedTokenCount <= result.limits.estimatedTokenBudget);
});

test('查询未提人物或生日时，七天内生日仍以日期依据参与竞争且不带入无关正文', () => {
  const memories = Array.from({ length:8 }, (_, index) => recallMemory(index + 1, {
    events:index === 1 ? [{ title:'旧港口闲谈', description:'多年前在港口讨论过天气', candidateStatus:'accepted' }] : [],
  }));
  const source = selectorSource({ memories });
  source.timeProjection = { corrections:{}, reminders:[
    { itemId:'near-birthday', type:'annual', subjectEntityId:PERSON, distance:2, text:'生日将在两天后到来' },
    { itemId:'due-deadline', type:'deadline', subjectEntityId:PERSON, distance:0, text:'约定今天已经到期' },
    { itemId:'far-birthday', type:'annual', subjectEntityId:PERSON, distance:8, text:'另一个纪念日还很远' },
    { itemId:'unknown-cycle', type:'cycle', subjectEntityId:PERSON, distance:null, text:'日期未知的周期事项' },
    { itemId:'ordinary-note', type:'note', subjectEntityId:PERSON, distance:0, text:'没有日期资格的普通备注' },
  ] };
  const result = selectRecall({ source, contextSize:12000, queryContext:{ text:'继续检查门锁', latestUserText:'继续检查门锁', messageCount:1 } });
  assert.deepEqual(result.timeDependencies.reminders.map(value => value.itemId), ['due-deadline', 'near-birthday']);
  assert.equal(result.floors.length, 0, '日期证据只救活有效提醒，不救活无关历史正文');
  assert.match(result.injectionText, /生日将在两天后到来/u);
  assert.doesNotMatch(result.injectionText, /旧港口闲谈|另一个纪念日|日期未知|普通备注/u);
});

test('临期日期证据参与统一主排序但不形成时间配额，强相关材料、远期未知与body边界保持', () => {
  const memories = Array.from({ length:80 }, (_, index) => recallMemory(index + 1, {
    summary:index === 79 ? '近期刚刚检查过门窗，仍在原地接续。' : '',
    events:[{ title:`普通观察 ${index + 1}`, description:`继续 ${'旧材料'.repeat(60)}`, candidateStatus:'accepted' }],
  }));
  const queryContext = { text:'继续', latestUserText:'继续', messageCount:1 };
  const weakSource = selectorSource({ memories });
  const weakCandidate = buildRecallHistoryCandidatePool({ source:weakSource, queryContext }).candidates[0];
  assert.ok(weakCandidate && weakCandidate.value.branchScores.latestUser > 0 && weakCandidate.value.branchScores.latestUser < 0.015,
    `合成弱匹配必须低于七日日期权重，实际为 ${weakCandidate?.value?.branchScores?.latestUser}`);

  const selectCase = reminders => {
    const source = selectorSource({ memories });
    source.timeProjection = { corrections:{}, reminders };
    return selectRecall({ source, contextSize:1000, queryContext, selectedHistoryCandidates:[weakCandidate], selectedCseCandidates:[] });
  };
  const competing = selectCase([
    { itemId:'due-now', type:'deadline', subjectEntityId:PERSON, distance:0, text:`今日到期 ${'时间依据'.repeat(100)}` },
    { itemId:'due-seven', type:'annual', subjectEntityId:PERSON, distance:7, text:`七日内纪念日 ${'日期依据'.repeat(100)}` },
  ]);
  assert.equal(competing.timeDependencies.reminders.length, 1, '总预算只能容纳一项时不得因同日或临期身份预留固定名额');
  assert.equal(competing.timeDependencies.reminders[0].itemId, 'due-now');
  assert.equal(competing.floors.some(floor => floor.items.some(item => item.text.includes('旧材料'))), false, '现有日期证据应能在主排序胜过微弱主题命中');
  assert.match(competing.injectionText, /近期刚刚检查过门窗/u, 'competition 前已装入的 P 近期接续不得被临期提醒挤退');

  const sevenDay = selectCase([
    { itemId:'due-seven-only', type:'annual', subjectEntityId:PERSON, distance:7, text:`七日内纪念日 ${'日期依据'.repeat(100)}` },
  ]);
  assert.deepEqual(sevenDay.timeDependencies.reminders.map(value => value.itemId), ['due-seven-only'], '七日边界的既有微弱日期权重仍参与主排序');
  assert.equal(sevenDay.floors.some(floor => floor.items.some(item => item.text.includes('旧材料'))), false);

  for (const reminder of [
    { itemId:'far', type:'deadline', subjectEntityId:PERSON, distance:8, text:`远期提醒 ${'日期依据'.repeat(60)}` },
    { itemId:'unknown', type:'cycle', subjectEntityId:PERSON, distance:null, text:`未知日期 ${'日期依据'.repeat(60)}` },
    { itemId:'body', type:'body', subjectEntityId:PERSON, distance:0, text:`身体推演 ${'日期依据'.repeat(60)}` },
  ]) {
    const result = selectCase([reminder]);
    assert.equal(result.timeDependencies.reminders.length, 0, reminder.itemId);
    assert.equal(result.floors.some(floor => floor.items.some(item => item.text.includes('旧材料'))), true, reminder.itemId);
  }

  const strongMemories = memories.map((memory, index) => index === 0 ? recallMemory(1, {
    events:[{ title:'蓝铜密钥独立后果', description:`蓝铜密钥令钟楼门锁失效 ${'关键事实'.repeat(60)}`, candidateStatus:'accepted' }],
  }) : memory);
  const strongSource = selectorSource({ memories:strongMemories });
  strongSource.timeProjection = { corrections:{}, reminders:[
    { itemId:'strong-due', type:'deadline', subjectEntityId:PERSON, distance:0, text:`今日到期 ${'时间依据'.repeat(100)}` },
  ] };
  const strongQuery = { text:'蓝铜密钥令钟楼门锁失效', latestUserText:'蓝铜密钥令钟楼门锁失效', messageCount:1 };
  const strongCandidate = buildRecallHistoryCandidatePool({ source:strongSource, queryContext:strongQuery }).candidates
    .find(value => value.value.text.includes('蓝铜密钥令钟楼门锁失效'));
  const strong = selectRecall({ source:strongSource, contextSize:1000, queryContext:strongQuery, selectedHistoryCandidates:[strongCandidate], selectedCseCandidates:[] });
  assert.equal(strong.timeDependencies.reminders.length, 0, '紧预算下强主题材料仍应胜过临期提醒');
  assert.match(strong.injectionText, /蓝铜密钥令钟楼门锁失效/u);
  assert.ok(strong.limits.actualCharacters <= strong.limits.maxCharacters);
  assert.ok(strong.limits.estimatedTokenCount <= strong.limits.estimatedTokenBudget);
});

test('旧推演字段无论引用未入选或过多证据都不会进入召回', async () => {
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
  assert.equal(Object.hasOwn(budgeted, 'stateProgressions'), false);
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
  assert.equal(Object.hasOwn(tooMany, 'stateProgressions'), false);
  assert.equal(tooMany.skipReasons.includes('historySelectionFallback'), false);
});

test('零本地正向证据的 CSE 不送 LLM 也不为凑量进入最终召回', async () => {
  const states = Array.from({ length: 7 }, (_, index) => recallState(`state-priority-${index + 1}`, `与查询无词面关系的状态 ${index + 1}`, index + 1));
  const source = selectorSource({ currentState: [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: states }] });
  const queryContext = { ...llmQuery, text: '宇宙飞船', latestUserText: '宇宙飞船' };
  const pool = buildRecallCseCandidatePool({ source, queryContext });
  assert.equal(pool.candidates.length, 0);
  let calls = 0;
  const result = await selectRecallWithLlm({ source, queryContext, contextSize: 12000, generateUtilityTask: async () => { calls += 1; return { jsonData: { history_exclude_keys: [], state_exclude_keys: [] } }; } });
  assert.equal(calls, 0);
  assert.equal(result.selectorDiagnostic.stateCandidateCount, 0);
  assert.equal(result.selectorDiagnostic.stateExcludedCount, null);
  assert.equal(result.selectorDiagnostic.stateRetainedCount, 0);
  assert.equal(result.states.length, 0);
});

test('同次年度选材不替换旧事选择，漏返年度保留键不会恢复人名匹配的生日', async () => {
  const source = changingCseSource({ withHistory: true });
  source.floorMemories = source.floorMemories.map(memory => memory.assistantSeq >= 5
    ? { ...memory, summary: `左佐在屋内等候，辛夷在院子休息（接续${memory.assistantSeq}）。` } : memory);
  source.timeProjection = { corrections: {}, reminders: [{ itemId: 'unknown-birthday', type: 'annual', subjectEntityId: PERSON,
    distance: null, rankText: '左佐 生日 霜月初三', text: '左佐 / 生日：原日期 霜月初三；当前日期关系不明确。', sourceSignature: 'annual-source' }] };
  const queryContext = { ...llmQuery, text: '左佐和辛夷的门锁', latestUserText: '左佐和辛夷的门锁' };
  let calls = 0;
  const run = retainOld => selectRecallWithLlm({ source, queryContext, generateUtilityTask: async options => {
    calls += 1;
    const payload = JSON.parse(options.taskMessages[0].content);
    assert.equal(payload.annualCandidates.length, 1);
    assert.equal(payload.alreadyProvided.recentContinuation.length, 4);
    const origin = payload.candidates.find(candidate => candidate.fact.includes('左佐早年买过一把旧门锁'));
    assert.ok(origin, '独立旧事实仍在同次候选中供语义判断');
    return { jsonData: { history_exclude_keys: payload.candidates.filter(candidate => !retainOld || candidate.key !== origin.key).map(candidate => candidate.key), state_exclude_keys: [] } };
  } });
  const retained = await run(true);
  assert.match(retained.injectionText, /左佐早年买过一把旧门锁/u);
  assert.equal(retained.timeDependencies.reminders.length, 0);
  assert.doesNotMatch(retained.injectionText, /生日/u);
  const excluded = await run(false);
  assert.doesNotMatch(excluded.injectionText, /左佐早年买过一把旧门锁|生日/u);
  assert.equal(calls, 2, '每轮各一次请求，年度判断不追加请求');
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
  const allInvalid = await selectRecallWithLlm({ source, queryContext, generateUtilityTask: async () => ({ jsonData: {
    history_exclude_keys: ['R999', 'C1', 7, null], state_exclude_keys: ['C999', 'R1', {}, false],
  } }) });
  assert.equal(allInvalid.selectorDiagnostic.historyExcludedCount, 0);
  assert.equal(allInvalid.selectorDiagnostic.stateExcludedCount, 0);
  assert.equal(allInvalid.selectorDiagnostic.historyRetainedCount, history.candidates.length);
  assert.equal(allInvalid.selectorDiagnostic.stateRetainedCount, cse.candidates.length);
  assert.equal(allInvalid.injectionText, result.injectionText);
});

test('一类候选漏答时使用另一类有效回答；双漏答仍失败而跨池项忽略', async () => {
  const source = changingCseSource({ withHistory: true });
  const queryContext = { ...llmQuery, text: '左佐辛夷旧门锁', latestUserText: '左佐辛夷旧门锁' };
  const history = buildRecallHistoryCandidatePool({ source, queryContext });
  const cse = buildRecallCseCandidatePool({ source, queryContext });
  for (const jsonData of [
    { history_exclude_keys: [history.candidates[0].key] },
    { state_exclude_keys: [cse.candidates[0].key] },
    { history_exclude_keys: [cse.candidates[0].key], state_exclude_keys: [history.candidates[0].key] },
  ]) {
    const result = await selectRecallWithLlm({ source, queryContext, generateUtilityTask: async () => ({ jsonData }) });
    assert.equal(result.selectorDiagnostic.mode, 'llm');
    assert.equal(result.skipReasons.includes('historySelectionFallback'), false);
  }
  for (const jsonData of [
    { selected_keys: [history.candidates[0].key, cse.candidates[0].key] },
  ]) {
    await assert.rejects(
      () => selectRecallWithLlm({ source, queryContext, generateUtilityTask: async () => ({ jsonData }) }),
      error => ['V3_RECALL_LLM_FIELDS_MISSING', 'V3_RECALL_LLM_KEYS_INVALID'].includes(error?.code),
      JSON.stringify(jsonData),
    );
  }
});

test('召回混合 R/C/Q 排除仅保留本池合法项、去重且不丢可用回答', async () => {
  const source = changingCseSource({ withHistory: true });
  source.qianshiCandidates = [qianshiCandidate('Q1', 'pending', '归还钟楼钥匙'), qianshiCandidate('Q2', 'pending', '核对钟楼账本')];
  const queryContext = { ...llmQuery, text: '左佐辛夷旧门锁', latestUserText: '左佐辛夷旧门锁' };
  const history = buildRecallHistoryCandidatePool({ source, queryContext });
  const cse = buildRecallCseCandidatePool({ source, queryContext });
  const r = history.candidates[0].key, c = cse.candidates[0].key;
  const clean = await selectRecallWithLlm({ source, queryContext, generateUtilityTask: async () => ({ jsonData: {
    history_exclude_keys: [r], state_exclude_keys: [c], qianshi_exclude_keys: ['Q1'],
  } }) });
  let calls = 0;
  const mixed = await selectRecallWithLlm({ source, queryContext, generateUtilityTask: async () => {
    calls += 1;
    return { jsonData: { history_exclude_keys: ['R999', c, 7, r, r, null],
      state_exclude_keys: ['C999', r, false, c, c, {}], qianshi_exclude_keys: ['Q999', r, c, 7, 'Q1', 'Q1'] } };
  } });
  assert.equal(calls, 1);
  assert.equal(mixed.selectorDiagnostic.historyExcludedCount, 1);
  assert.equal(mixed.selectorDiagnostic.stateExcludedCount, 1);
  assert.equal(mixed.injectionText, clean.injectionText);
  assert.equal(mixed.qianshiProgress.text, clean.qianshiProgress.text);
  assert.doesNotMatch(mixed.qianshiProgress.text, /归还钟楼钥匙/u);
  assert.match(mixed.qianshiProgress.text, /核对钟楼账本/u);
});

test('第一批选材隔离：坏可选Q原文年度字段保合法RC且只调用一次', async t => {
  for (const field of ['qianshi_exclude_keys', 'artifact_select_keys', 'annual_retain_keys']) {
    for (const hasQ of [false, true]) await t.test(`${field}/${hasQ}`, async () => {
      const source = changingCseSource({ withHistory: true });
      if (hasQ) source.qianshiCandidates = [qianshiCandidate('Q1', 'pending', '归还钟楼钥匙')];
      let calls = 0;
      const result = await selectRecallWithLlm({ source, queryContext: { ...llmQuery, text: '左佐辛夷旧门锁', latestUserText: '左佐辛夷旧门锁' }, generateUtilityTask: async () => {
        calls += 1; return { jsonData: { history_exclude_keys: [], state_exclude_keys: [], [field]: 7 } };
      } });
      assert.equal(calls, 1); assert.ok(result.injectionText);
      assert.ok(result.states.length || result.floors.length);
      if (hasQ) assert.match(result.qianshiProgress.text, /归还钟楼钥匙/);
    });
  }
});

test('召回排除的错误字段类型仍拒绝，不把结构错误当作空排除', async () => {
  const source = changingCseSource({ withHistory: true });
  const queryContext = { ...llmQuery, text: '左佐辛夷旧门锁', latestUserText: '左佐辛夷旧门锁' };
  for (const field of ['history_exclude_keys', 'state_exclude_keys']) {
    for (const value of [null, {}, 7, false, 'R1']) {
      await assert.rejects(selectRecallWithLlm({ source, queryContext, generateUtilityTask: async () => ({ jsonData: {
        history_exclude_keys: [], state_exclude_keys: [], [field]: value,
      } }) }), error => error?.code === 'V3_RECALL_LLM_SCHEMA_INVALID');
    }
  }
});

test('LLM 解析与传输失败保留安全路由诊断及请求估算，不保存模型正文或敏感值', async () => {
  const source = wideCandidateSource({ direct: 2 });
  const queryContext = { ...llmQuery, text: '蓝铜钥匙', latestUserText: '蓝铜钥匙' };
  const successful = await selectRecallWithLlm({ source, queryContext, generateUtilityTask: async () => ({
    jsonData: { history_exclude_keys: [], state_exclude_keys: [] },
    taskMetadata: { source: 'shared-recall-preset', sourceLabel: '测试', model: 'safe-model', finishReason: 'stop', transportAttempts: 1 },
  }) });
  assert.ok(successful.selectorDiagnostic.requestCharacters > 0, '成功回执也应保留本次安全请求规模');
  assert.ok(successful.selectorDiagnostic.requestEstimatedTokens > 0);
  let parseError;
  try { await selectRecallWithLlm({ source, queryContext, generateUtilityTask: async () => ({ textData: '正文秘密不是诊断', taskMetadata: { source: 'shared-recall-preset', sourceLabel: '测试', model: 'safe-model', finishReason: 'stop', transportAttempts: 1 } }) }); }
  catch (error) { parseError = error; }
  assert.equal(parseError.selectorDiagnostic.code, 'QQJ_COMPLETION_JSON');
  assert.equal(parseError.selectorDiagnostic.sourceStage, 'selector-parse');
  assert.equal(parseError.selectorDiagnostic.model, 'safe-model');
  assert.ok(parseError.selectorDiagnostic.requestCharacters > 0);
  assert.ok(parseError.selectorDiagnostic.requestEstimatedTokens > 0);
  assert.doesNotMatch(JSON.stringify(parseError.selectorDiagnostic), /正文秘密|api\.example|secret-123/u);

  let transportError;
  try { await selectRecallWithLlm({ source, queryContext, generateUtilityTask: async () => { throw Object.assign(new Error('网络失败'), { code: 'QQJ_NETWORK', taskMetadata: { source: 'shared-recall-preset', sourceLabel: '测试', model: 'sk-secret-123456789', transportAttempts: 2, sourceStage: 'utility-request' } }); } }); }
  catch (error) { transportError = error; }
  assert.equal(transportError.selectorDiagnostic.code, 'QQJ_NETWORK');
  assert.equal(transportError.selectorDiagnostic.transportAttempts, 2);
  assert.equal(transportError.selectorDiagnostic.sourceStage, 'utility-request');
  assert.doesNotMatch(JSON.stringify(transportError.selectorDiagnostic), /sk-secret/u);
});

test('近期正文见证按设置的 N 条未隐藏 AI 楼截取，且 auto-hide 开关不改变候选资格边界', async () => {
  const chat = [
    { is_user: false, is_system: false, mes: '旧一' },
    { is_user: false, is_system: false, mes: '旧二', is_system: true },
    { is_user: false, is_system: false, mes: '旧三' },
    { is_user: true, mes: '用户楼' },
    { is_user: false, is_system: false, mes: '新一' },
    { is_user: false, is_system: false, mes: '新二' },
  ];
  const fingerprint = value => Promise.resolve(`fp:${value}`);
  for (const [keepAiCount, expected] of [[1, ['新二']], [3, ['旧三', '新一', '新二']], [50, ['旧一', '旧三', '新一', '新二']]]) {
    const witness = await captureCoreBodyWitness(chat, {}, fingerprint, keepAiCount);
    assert.deepEqual(witness.map(value => value.rawContent), expected);
  }
});

test('排除楼不作为召回正文见证或近期查询上下文', async () => {
  const chat = [
    { is_user: true, is_system: false, mes: '之前的问题' },
    { is_user: false, is_system: false, mes: '不应进入记忆的回答', extra: { qianqianjie_memory_excluded: true } },
    { is_user: true, is_system: false, mes: '当前问题' },
    { is_user: false, is_system: false, mes: '最近回答' },
    { is_user: true, is_system: false, mes: '现在要问' },
  ];
  const witness = await captureCoreBodyWitness(chat, {}, value => Promise.resolve(`fp:${value}`), 5);
  assert.deepEqual(witness.map(item => item.rawContent), ['最近回答']);
  const frame = buildRecallQueryFrame({ coreChat: chat, assistantTurns: 2 });
  assert.equal(frame.messages.some(item => item.text.includes('不应进入记忆的回答')), false);
});

test('共享人物和稀有主题词不自动补入未选旧事，明确排除项不会复活', () => {
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
  assert.equal(linked.floors.some(value => value.assistantSeq === 1), false, '同人物和具体主题也不能自动追加未选旧事');
  assert.equal(linked.floors.some(value => value.assistantSeq === 3), false, '仅人物相同的早餐不得串入账本事务');
  assert.doesNotMatch(linked.injectionText, /同人物与主题：/u);
  const excludedResult = selectRecall({ source, queryContext, selectedHistoryCandidates: [anchor], excludedHistoryCandidates: [excluded] });
  assert.equal(excludedResult.floors.some(value => value.assistantSeq === 1), false, '明确排除的 fact 不得经同楼 summary 或其他条目复活');
  assert.equal(excludedResult.floors.some(value => value.assistantSeq === 2), false, '其他未选主题项也不补入');
});

test('历史 topic 关系标记仍按原语义格式化，冻结旧回执不丢来源说明', () => {
  const source = selectorSource({ memories: Array.from({ length: 8 }, (_, index) => recallMemory(index + 1)) });
  const selected = selectRecall({ source, queryContext: llmQuery });
  const oldFloors = [{ floorId: 'floor-1', assistantSeq: 1, items: [{
    kind: 'event', text: '蓝铜账本转交旧仓', relationEvidence: 'topic', relationTerms: ['蓝铜账本'],
    relationAnchorFloorId: 'floor-2', storylineId: 'old-line',
  }] }];
  const injection = formatRecallInjection({ ...selected, floors: oldFloors, states: [], cseChanges: [],
    entityById: new Map(source.entities.map(value => [value.entityId, value])),
    storylines: [{ storylineId: 'old-line', title: '账本旧线', basis: '冻结旧回执' }] });
  assert.match(injection, /蓝铜账本转交旧仓/);
  assert.match(injection, /同人物与主题：/u);
});

test('主题条目不自动补入，模型明确选择的独立事实仍可进入', () => {
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
  assert.equal(result.floors.some(value => value.assistantSeq === 1 || value.assistantSeq === 3), false);
  const explicit = pool.candidates.find(value => value.value.floorId === 'floor-1' && value.value.kind === 'observation');
  assert.ok(explicit);
  const retained = selectRecall({ source, queryContext, selectedHistoryCandidates: [anchor, explicit] });
  assert.equal(retained.floors.some(value => value.assistantSeq === 1), true);
  assert.equal(retained.floors.flatMap(value => value.items).some(value => value.relationEvidence === 'topic'), false);
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
  const anchor = pool.candidates.find(value => value.value.floorId === 'floor-1' && value.value.kind === 'commitment');
  assert.ok(anchor);
  const selectedObservations = pool.candidates.filter(value => value.value.floorId === 'floor-2' && value.value.text === '蓝铜账本红蜡封条');
  assert.equal(selectedObservations.length, 1);
  const result = selectRecall({ source, queryContext, contextSize: 12000, selectedHistoryCandidates: [anchor, ...selectedObservations] });
  const items = result.floors.flatMap(floor => floor.items);
  const anchorLine = items.find(value => value.text.includes('蓝铜账本') && value.kind === 'commitment')?.storylineId;
  assert.ok(anchorLine);
  assert.equal(items.some(value => value.storylineId === anchorLine && value.text === '蓝铜账本红蜡封条'), true, 'B 与原锚 A 有证据，应进入 A 线');
  assert.equal(items.some(value => value.storylineId === anchorLine && value.text === '红蜡封条暗门'), false, 'C 只与同楼 B 相关，不能借 B 二跳进入 A 线');
});

test('邻近摘要必须随稳定锚入选，模型排除锚后不能只留下关联外壳', () => {
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1, {
    summary: index === 1 ? '蓝铜账本已经封存' : index === 2 ? '窗外忽然下起细雨' : index >= 4 ? `近期接续 ${index + 1}` : '',
  }));
  const source = selectorSource({ memories });
  const queryContext = { text:'蓝铜账本', latestUserText:'蓝铜账本', messageCount:1 };
  const pool = buildRecallHistoryCandidatePool({ source, queryContext });
  const anchor = pool.candidates.find(value => value.value.floorId === 'floor-2');
  const nearby = pool.candidates.find(value => value.value.floorId === 'floor-3');
  assert.ok(anchor && nearby);
  assert.equal(nearby.sourceKind, 'adjacent');

  const withoutAnchor = selectRecall({ source, queryContext, selectedHistoryCandidates:[nearby] });
  assert.equal(withoutAnchor.floors.some(value => value.floorId === 'floor-3'), false);
  assert.ok(withoutAnchor.stages.relevanceFilteredCount >= 1);

  const withAnchor = selectRecall({ source, queryContext, selectedHistoryCandidates:[anchor, nearby] });
  assert.equal(withAnchor.floors.some(value => value.floorId === 'floor-2'), true);
  assert.equal(withAnchor.floors.some(value => value.floorId === 'floor-3'), true);
  assert.equal(withAnchor.floors.find(value => value.floorId === 'floor-3').items[0].relationEvidence, 'nearby');
});

test('总容量回压后来源关联项不能脱离已入选锚点独活', () => {
  const memories = Array.from({ length:20 }, (_, index) => recallMemory(index + 1, {
    summary:index >= 16 ? `近期接续 ${index + 1}` : '',
    events:index < 16 ? [{ title:`蓝铜锚点 ${index + 1}`, description:`蓝铜钥匙直接证据 ${index + 1} ${'甲'.repeat(80)}`, candidateStatus:'accepted' }] : [],
  }));
  const source = selectorSource({ memories });
  source.cseChanges = Array.from({ length:16 }, (_, index) => ({
    deltaId:`linked-delta-${index + 1}`, floorId:`floor-${index + 1}`, assistantSeq:index + 1, subjectEntityId:PERSON, layer:'situational', action:'add', before:null,
    after:recallState(`linked-state-${index + 1}`, `无词面关联的来源状态 ${index + 1} ${'乙'.repeat(80)}`, index + 1),
  }));
  const queryContext = { text:'蓝铜钥匙', latestUserText:'蓝铜钥匙', messageCount:1 };
  const pool = buildRecallHistoryCandidatePool({ source, queryContext });
  const result = selectRecall({ source, queryContext, contextSize:1800, selectedHistoryCandidates:pool.candidates });
  assert.ok(result.stages.budgetDroppedCount > 0);
  const historyByLine = new Map();
  for (const floor of result.floors) for (const item of floor.items) historyByLine.set(item.storylineId, [...(historyByLine.get(item.storylineId) ?? []), item]);
  for (const change of result.cseChanges.filter(value => value.relationEvidence === 'source')) {
    assert.ok(historyByLine.get(change.storylineId)?.some(value => !value.relationEvidence), '来源关联变化必须保留同线直接锚点');
  }
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

test('超过八个同主题节点时不按单线节点数裁剪，并把协议标题限制在签名上限内', () => {
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
  assert.ok(endpointLine.length > 8, '同线高相关节点只受最终总容量约束');
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

test('候选池保留48条模型输入，最终不按主题新增池外旧事但仍沿总容量', () => {
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
  assert.equal(result.floors.some(value => value.assistantSeq === 1), false, '仅同人物主题的池外事实不能在模型后新增');
  assert.equal(result.stages.linkedHistoryItemCount, 0);
  assert.ok(result.floors.flatMap(value => value.items).length > 48);
});

test('state/source 补来源摘要，配角变化只有明确选中才进入', () => {
  const other = '99999999-7777-4777-8777-777777777777';
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1, { summary: index >= 4 ? `近期接续 ${index + 1}` : '' }));
  memories[1] = recallMemory(2, { summary: '配角在旧仓交出蓝铜账本。', participants: [{ entityId: other, presence: 'present' }] });
  const linkedState = recallState('linked-current', '仍记得旧仓交接', 2, { sourceFloorId: 'floor-2', sourceDeltaId: 'delta-2' });
  const linkedChange = {
    deltaId: 'delta-2', floorId: 'floor-2', assistantSeq: 2, subjectEntityId: other, layer: 'adaptive', action: 'add', before: null,
    after: recallState('linked-other', '因交出账本而保持警惕', 2, { sourceFloorId: 'floor-2', sourceDeltaId: 'delta-2' }),
  };
  const source = selectorSource({ memories, currentState: [{ subjectEntityId: PERSON, core: [linkedState], adaptive: [], situational: [] }] });
  source.entities = source.entities.map(value => value.entityId === other ? {...value,displayName:'顾舟'} : value);
  source.cseChanges = [linkedChange];
  const queryContext = { text: '仍记得旧仓交接', latestUserText: '仍记得旧仓交接', messageCount: 1 };
  const csePool = buildRecallCseCandidatePool({ source, queryContext });
  const current = csePool.candidates.find(value => value.source === 'current');
  const stateLinked = selectRecall({ source, queryContext, selectedHistoryCandidates: [], selectedCseCandidates: [current] });
  assert.match(stateLinked.injectionText, /来源关联：配角在旧仓交出蓝铜账本/);

  const historyPool = buildRecallHistoryCandidatePool({ source, queryContext: { text: '蓝铜账本', latestUserText: '蓝铜账本', messageCount: 1 } });
  const history = historyPool.candidates.find(value => value.value.floorId === 'floor-2');
  const deltaLinked = selectRecall({ source, queryContext: { text: '蓝铜账本', latestUserText: '蓝铜账本', messageCount: 1 }, selectedHistoryCandidates: [history], selectedCseCandidates: [] });
  assert.equal(deltaLinked.cseChanges.some(value => value.subjectEntityId === other && value.assistantSeq === 2), false,
    '只同楼主题相关的未选配角变化不在模型后自动新增');
  const explicitQuery = { text: '顾舟因交出蓝铜账本而保持警惕', latestUserText: '顾舟因交出蓝铜账本而保持警惕', messageCount: 1 };
  const selectedChange = buildRecallCseCandidatePool({ source, queryContext: explicitQuery }).candidates.find(value => value.source === 'change');
  assert.ok(selectedChange, '配角成长应能成为模型明确选择的真实C候选');
  const explicitlySelected = selectRecall({ source, queryContext: explicitQuery, selectedHistoryCandidates: [history], selectedCseCandidates: [selectedChange] });
  assert.equal(explicitlySelected.cseChanges.length, 1);
  assert.equal(explicitlySelected.cseChanges[0].subjectEntityId, other);
  assert.equal(explicitlySelected.cseChanges[0].after.text, '因交出账本而保持警惕');
  assert.equal(explicitlySelected.cseChanges[0].after.visibility, linkedChange.after.visibility);
  assert.equal(explicitlySelected.stages.linkedCseChangeCount, 0, '明确选择的C不是自动关联补入');
});

test('池外 CSE 只补模型已选状态的直接相邻边，不沿状态链追溯全部旧变化', () => {
  const memories = Array.from({ length:8 }, (_, index) => recallMemory(index + 1, {
    summary:index >= 4 ? `近期接续 ${index + 1}` : '',
    events:index === 1 ? [{ title:'蓝铜账本', description:'蓝铜账本已经入库', candidateStatus:'accepted' }] : [],
    participants:index === 1 ? [{ entityId:PERSON, presence:'present' }] : [],
  }));
  const first = recallState('chain-first', '最初只在门外等候', 1, { sourceFloorId:'floor-1', sourceDeltaId:'chain-delta-1' });
  const middle = recallState('chain-middle', '后来改在走廊等候', 2, { sourceFloorId:'floor-2', sourceDeltaId:'chain-delta-2' });
  const current = recallState('chain-current', '当前警惕并守在门边', 3, { sourceFloorId:'floor-3', sourceDeltaId:'chain-delta-3' });
  const source = selectorSource({ memories, currentState:[{ subjectEntityId:PERSON, core:[], adaptive:[current], situational:[] }] });
  source.cseChanges = [
    { deltaId:'chain-delta-2', floorId:'floor-2', assistantSeq:2, subjectEntityId:PERSON, layer:'adaptive', action:'refine', before:first, after:middle },
    { deltaId:'chain-delta-3', floorId:'floor-3', assistantSeq:3, subjectEntityId:PERSON, layer:'adaptive', action:'refine', before:middle, after:current },
  ];
  const queryContext = { text:'蓝铜账本 当前警惕', latestUserText:'蓝铜账本 当前警惕', messageCount:1 };
  const history = buildRecallHistoryCandidatePool({ source, queryContext }).candidates.find(value => value.value.floorId === 'floor-2');
  const selectedCurrent = buildRecallCseCandidatePool({ source, queryContext }).candidates.find(value => value.source === 'current');
  const result = selectRecall({ source, queryContext, selectedHistoryCandidates:[history], selectedCseCandidates:[selectedCurrent] });
  assert.deepEqual(result.cseChanges.map(value => value.deltaId), ['chain-delta-3']);
  assert.equal(result.cseChanges[0].relationEvidence, 'source');
});

test('池外 CSE 相邻边按 before→after 定向连接，不把同侧兄弟误当连续推进', () => {
  const memories = Array.from({ length:8 }, (_, index) => recallMemory(index + 1, {
    summary:index >= 4 ? `近期接续 ${index + 1}` : '',
    events:index === 1 ? [{ title:'蓝铜账本', description:'蓝铜账本已经入库', candidateStatus:'accepted' }] : [],
    participants:index === 1 ? [{ entityId:PERSON, presence:'present' }] : [],
  }));
  const first = recallState('directed-first', '最初状态甲', 1, { sourceDeltaId:'directed-1' });
  const before = recallState('directed-before', '选中变化之前状态', 2, { sourceDeltaId:'directed-2' });
  const after = recallState('directed-after', '选中变化之后当前状态', 3, { sourceDeltaId:'directed-3' });
  const next = recallState('directed-next', '后续状态丁', 4, { sourceDeltaId:'directed-4' });
  const beforeSibling = recallState('directed-before-sibling', '从同一before分出的兄弟状态', 5, { sourceDeltaId:'directed-5' });
  const afterSibling = recallState('directed-after-sibling', '汇入同一after的兄弟状态', 6, { sourceDeltaId:'directed-6' });
  const change = (deltaId, assistantSeq, left, right) => ({ deltaId, floorId:`directed-floor-${assistantSeq}`, assistantSeq, subjectEntityId:PERSON, layer:'adaptive', action:'refine', before:left, after:right });
  const source = selectorSource({ memories });
  source.cseChanges = [
    change('directed-2', 2, first, before),
    change('directed-3', 3, before, after),
    change('directed-4', 4, after, next),
    change('directed-5', 5, before, beforeSibling),
    change('directed-6', 6, afterSibling, after),
  ];
  const queryContext = { text:'蓝铜账本 选中变化之后当前状态', latestUserText:'蓝铜账本 选中变化之后当前状态', messageCount:1 };
  const history = buildRecallHistoryCandidatePool({ source, queryContext }).candidates.find(value => value.value.floorId === 'floor-2');
  const selected = buildRecallCseCandidatePool({ source, queryContext }).candidates.find(value => value.value.deltaId === 'directed-3');
  assert.ok(history && selected);
  const result = selectRecall({ source, queryContext, selectedHistoryCandidates:[history], selectedCseCandidates:[selected] });
  assert.deepEqual(result.cseChanges.map(value => value.deltaId).sort(), ['directed-2', 'directed-3', 'directed-4']);
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

test('同次召回以冻结清洗正文建近期对照，前置长审核不挤掉真实剧情',async()=>{
 let captured=null;const h=createRuntimeHarness({selector:input=>{captured=input;return selectRecall(input);}});
 const body='林岚已经递出铅芯、拒绝交出整盒，现在数学课上被踢椅。';
 h.chat[0].mes=`<think>${'审核与重写草稿。'.repeat(1000)}</think><content>${body}</content>`;
 const raw=h.chat[0].mes;h.userMessage.mes='她刚才给过铅芯了，现在继续上课。';
 const result=await h.runtime.intercept(h.chat,20000,null,'normal');
 assert.equal(result.lastRecall.status,'ready');assert.ok(captured.queryContext.recentAssistantText.includes(body.normalize('NFKC')));
 assert.equal(captured.queryContext.recentAssistantText.includes('审核'),false);assert.equal(h.chat[0].mes,raw);
 assert.equal(captured.queryContext.latestUserText,h.userMessage.mes.normalize('NFKC'));
});

test('只有思考的尾AI不回退审核，query仍保原最近轮边界',async()=>{
 let captured=null;const h=createRuntimeHarness({selector:input=>{captured=input;return selectRecall(input);}});
 h.chat.splice(0,h.chat.length,{is_user:true,mes:'不应拉回的第一轮用户资料'},
  {is_user:false,mes:'更早故事'}, {is_user:true,mes:'不应拉回的第二轮用户资料'},
  {is_user:false,mes:'前一轮真实故事'}, {is_user:true,mes:'紧邻空AI的用户输入'},
  {is_user:false,mes:`<think>${'只有审核。'.repeat(1000)}</think>`},h.userMessage);
 const result=await h.runtime.intercept(h.chat,20000,null,'normal');
 assert.equal(result.lastRecall.status,'ready');assert.equal(captured.queryContext.recentAssistantText,'');
 assert.equal(captured.queryContext.previousUserText,'紧邻空AI的用户输入');
 assert.equal(captured.queryContext.text.includes('不应拉回'),false);assert.equal(captured.queryContext.text.includes('只有审核'),false);
});

test('同源原文与关联摘要在同次R键中可比较，明确排除摘要后本地不复活',async()=>{
 const source=runtimeFixture(),m=source.floorMemories.find(x=>x.floorId==='floor-2');
 m.summary='曾因一项未完成的约定外出，后来回到门前。';
 const raw='蓝色钥匙塞在松砖后，林岚为此暗自烦躁，但没有告诉任何人。';
 const witness={floorId:m.floorId,floorMemoryId:m.floorMemoryId,memoryFloorId:m.floorId,memoryAssistantSeq:m.assistantSeq,assistantSeq:m.assistantSeq,
  offset:0,length:raw.length,fingerprint:await fingerprintText(raw),textFingerprint:await fingerprintText(raw)};
 for(const keepMode of ['raw','summary']){
 let payload,calls=0;
 const selected=await selectRecallWithLlm({source,queryContext:buildRecallQueryContext({coreChat:[{is_user:true,mes:'蓝色钥匙在哪里？'}]}),contextSize:20000,
  semanticProvider:async()=>({candidates:[{text:raw,witness}]}),generateUtilityTask:async request=>{
   calls++;payload=JSON.parse(request.taskMessages[0].content);
   const group=payload.sourceGroups?.find(g=>g.rawKeys?.length&&g.summaryKeys?.length);
   assert.ok(group,'关联摘要必须和原文一起成为本次可见R/P对照');
   assert.ok(group.summaryKeys.every(key=>payload.candidates.some(c=>c.key===key&&c.fact.includes(m.summary.normalize('NFKC')))));
   const keep=keepMode==='raw'?group.rawKeys:group.summaryKeys;
   return {jsonData:{history_exclude_keys:payload.candidates.filter(c=>!keep.includes(c.key)).map(c=>c.key),state_exclude_keys:[]}};
  }});
 assert.equal(calls,1);const items=selected.floors.flatMap(x=>x.items);
 assert.equal(items.some(x=>x.rawWitness),keepMode==='raw');
 assert.equal(selected.floors.some(f=>f.floorId===m.floorId&&f.items.some(x=>x.kind==='summary')),keepMode==='summary');
 assert.equal(selected.injectionText.includes(m.summary.normalize('NFKC')),keepMode==='summary','明确保留的摘要必须入选，排除后不能本地补回');
 }
});

test('已保存情境状态注入写来源快照，长期Core和Adaptive仍参与',()=>{
 const item=(layer,text)=>({stateId:layer,subjectEntityId:PERSON,subject:'裴晚生',layer,text,visibility:'private',reason:'有据',sourceAssistantSeq:1});
 const output=formatRecallInjection({coverage:selectorSource().coverage,floors:[],cseChanges:[],entityById:new Map(),states:[item('core','稳定身份'),item('adaptive','稳定模式'),item('situational','此前等人')],
  storylines:[]});
 // The ordinary formatter is also used when a time rerender has no storyline plan.
 assert.match(output,/\[已保存场景快照\].*situational/u);assert.ok(output.includes('稳定身份'));assert.ok(output.includes('稳定模式'));
});

test('实际召回保最新swipe地点用于检索，但不独立注入并签空参考列表', async () => {
  const source = runtimeFixture();
  let selectorInput = null;
  const harness = createRuntimeHarness({ sourceReader: async () => structuredClone(source),
    reachableReader: async () => rawReachableFromSource(source),
    selector: input => { selectorInput = input; return selectRecall(input); } });
  const selected = '林岚仍住在卧室。<location>东区公寓·卧室</location><think><location>不应进入参考的住处</location></think>';
  harness.chat.splice(0, harness.chat.length,
    { is_user: true, is_system: false, mes: '之前继续' },
    { is_user: false, is_system: false, mes: '林岚仍住在卧室。', swipes: ['林岚仍住在卧室。<location>落选住所</location>', selected], swipe_id: 1 },
    harness.userMessage);
  harness.userMessage.mes = '接着说下去';
  const core = structuredClone(harness.chat);
  core[1].mes = '林岚仍住在卧室。';
  const result = await harness.runtime.intercept(core, 12000, null, 'normal');
  const receipt = harness.userMessage.extra[RECALL_RECEIPT_KEY];
  assert.equal(result.lastRecall.status, 'ready');
  assert.ok(selectorInput, '真实runtime应把候选交给正式selector');
  assert.deepEqual(receipt.selectedLocationReferences, []);
  assert.equal(receipt.stages.locationReferenceCount, 0);
  assert.doesNotMatch(result.lastRecall.injectionText, /东区公寓·卧室/u);
  assert.doesNotMatch(result.lastRecall.injectionText, /落选住所|不应进入参考的住处/u);
  assert.equal(selectorInput.source.bodyMatch.locationReferences[0].hostLocator.messageIndex, 1);
  assert.equal(selectorInput.source.bodyMatch.locationReferences[0].hostLocator.swipeId, 1);
  assert.equal(Object.hasOwn(selectorInput.source.bodyMatch.locationReferences[0], 'floorId'), false,
    '未归档的当前楼使用真实宿主定位，不伪造floorId');
  assert.equal(receipt.injectionText, latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT));
  harness.runtime.invalidate('simulateReload');
  const restored = await harness.runtime.restorePersistedReceipt();
  assert.equal(restored.lastRecall?.restoredReceipt, true, 'schema18 新字段必须参与封签并可恢复');
  assert.deepEqual(restored.lastRecall.selectedLocationReferences, receipt.selectedLocationReferences);
});

test('地点参考变化触发同用户重选，无关显示元数据变化仍复用原回执', async () => {
  let selectorCalls = 0;
  const source = runtimeFixture();
  const harness = createRuntimeHarness({ sourceReader: async () => structuredClone(source),
    selector: input => { selectorCalls += 1; return selectRecall(input); } });
  const firstText = '林岚仍住在卧室。<location>东区公寓·卧室</location>';
  harness.chat.splice(0, harness.chat.length,
    { is_user: true, is_system: false, mes: '之前继续' },
    { is_user: false, is_system: false, mes: '林岚仍住在卧室。', swipes: [firstText], swipe_id: 0 },
    harness.userMessage);
  harness.userMessage.mes = '接着说下去';
  const cleanCore = () => {
    const value = structuredClone(harness.chat);
    value[1].mes = '林岚仍住在卧室。';
    return value;
  };
  await harness.runtime.intercept(cleanCore(), 12000, null, 'normal');
  assert.equal(selectorCalls, 1);
  assert.doesNotMatch(harness.userMessage.extra[RECALL_RECEIPT_KEY].injectionText, /东区公寓·卧室/u);

  harness.chat[1].extra = { display: { color: 'teal' } };
  const metadataOnly = await harness.runtime.intercept(cleanCore(), 12000, null, 'regenerate');
  assert.equal(metadataOnly.lastRecall.reusedReceipt, true, '无关显示元数据不改变地点参考依赖');
  assert.equal(selectorCalls, 1);

  harness.chat[1].swipes[0] = '林岚仍住在卧室。<location>西区公寓·卧室</location>';
  const changed = await harness.runtime.intercept(cleanCore(), 12000, null, 'regenerate');
  assert.equal(changed.lastRecall.reusedReceipt, false, '地点标签变化进入同一回执依赖并重选');
  assert.equal(selectorCalls, 2);
  assert.doesNotMatch(changed.lastRecall.injectionText, /西区公寓·卧室/u);
  assert.doesNotMatch(changed.lastRecall.injectionText, /东区公寓·卧室/u);
  harness.chat[1].swipes.push(harness.chat[1].swipes[0]);
  harness.chat[1].swipe_id = 1;
  const sameFactNewSwipe = await harness.runtime.intercept(cleanCore(), 12000, null, 'regenerate');
  assert.equal(sameFactNewSwipe.lastRecall.reusedReceipt, false, '非空地点即使同字仍核对所选swipe定位');
  assert.equal(selectorCalls, 3);
});

test('continue仍从当前回复读取地点参考', async () => {
  let selectorInput = null;
  const source = runtimeFixture();
  const harness = createRuntimeHarness({ sourceReader: async () => structuredClone(source),
    reachableReader: async () => rawReachableFromSource(source),
    selector: input => { selectorInput = input; return selectRecall(input); } });
  harness.chat.splice(0, harness.chat.length,
    { is_user: true, is_system: false, mes: '之前继续' },
    { is_user: false, is_system: false, mes: '前序地点。<location>客房</location>' },
    harness.userMessage,
    { is_user: false, is_system: false, mes: '当前回复。<location>阳台</location>' });
  harness.userMessage.mes = '继续';
  await harness.runtime.intercept(structuredClone(harness.chat), 12000, null, 'continue');
  assert.deepEqual(selectorInput.source.bodyMatch.locationReferences.map(value => value.text), ['阳台']);
  harness.chat.at(-1).mes = '当前回复没有地点标注。';
  await harness.runtime.intercept(structuredClone(harness.chat), 12000, null, 'continue');
  assert.deepEqual(selectorInput.source.bodyMatch.locationReferences, [], '最新合格消息无地点时不回找前序客房');
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].locationReferenceDependency, 'null');
});

test('已保存与当前地点标注均不独立注入，历史来源数据保留', () => {
  const source = runtimeFixture();
  const locator = { messageIndex: 1, swipeId: 1, selectedSwipeIndex: 1 };
  const first = source.floorMemories.find(value => value.floorId === 'floor-2');
  first.locationReferences = [
    { text: '东区公寓·卧室', sourceFloorId: 'floor-2', assistantSeq: 2, hostLocator: locator },
  ];
  const second = source.floorMemories.find(value => value.floorId === 'floor-3');
  second.summary = '林岚在钟楼留下另一条约定。';
  second.participants = [{ entityId: PERSON, presence: 'present' }];
  second.locationReferences = [{ text: '东区公寓·卧室', sourceFloorId: 'floor-3', assistantSeq: 3, hostLocator: locator }];
  source.bodyMatch = { locationReferences: [{ text: '东区公寓·卧室', sourceFloorId: 'floor-2', assistantSeq: 2, hostLocator: locator }] };
  let sourceReferenceReads = 0;
  for (const memory of source.floorMemories) {
    const locationReferences = memory.locationReferences;
    Object.defineProperty(memory, 'locationReferences', { configurable: true, get() { sourceReferenceReads += 1; return locationReferences; } });
  }
  const queryContext = { text: '钟楼约定 林岚', latestUserText: '钟楼约定 林岚', messageCount: 1 };
  const pool = buildRecallHistoryCandidatePool({ source, queryContext });
  const candidates = pool.candidates.filter(value => ['floor-2', 'floor-3'].includes(value.value.floorId));
  const result = selectRecall({ source, queryContext, selectedHistoryCandidates: candidates, selectedCseCandidates: [] });
  assert.ok(result.floors.some(value => value.floorId === 'floor-2') && result.floors.some(value => value.floorId === 'floor-3'), '两条已选旧楼均提供地点参考');
  assert.deepEqual(result.locationReferences, []);
  assert.equal(result.stages.locationReferenceCount, 0);
  assert.equal(sourceReferenceReads, 0, '不为独立地点标注额外扫描记忆来源');
});

test('地点标注不占maxItems或预算，时间提醒仍沿原额度', () => {
  const queryContext = { text: '卧室 明天 归还钥匙', latestUserText: '卧室 明天 归还钥匙', messageCount: 1 };
  const source = selectorSource({ memories: [] });
  source.currentState = [];
  source.coverage = { ...source.coverage, stableAiFloors: 0, stableThroughAssistantSeq: 0, rememberedAiFloors: 0,
    missingAssistantSeq: [], cseThroughAssistantSeq: 0, memoryComplete: true, cseCurrent: true };
  source.bodyMatch = { locationReferences: [
    { text: '东区公寓·卧室', sourceFloorId: null, hostLocator: { messageIndex: 2 } },
    { text: '西区公寓·卧室', sourceFloorId: null, hostLocator: { messageIndex: 4 } },
  ] };
  const pure = selectRecall({ source, queryContext, maxItems: 1 });
  assert.equal(pure.locationReferences.length, 0);
  assert.equal(pure.stages.finalInjectionItemCount, 0);
  assert.ok(pure.limits.estimatedTokenCount <= pure.limits.estimatedTokenBudget);

  source.timeProjection = { fingerprint: 'tight-location-time', corrections: {}, reminders: [
    { itemId: 'return-key', type: 'deadline', text: '明天归还钥匙', rankText: '明天归还钥匙', sourceSignature: 'return-key' },
  ] };
  const mixed = selectRecall({ source, queryContext, maxItems: 1 });
  assert.equal(mixed.stages.finalInjectionItemCount, mixed.locationReferences.length + mixed.timeDependencies.reminders.length);
  assert.ok(mixed.stages.finalInjectionItemCount <= 1, '地点和时间参考共享同一 maxItems，不因新增来源越预算');
  assert.equal(mixed.timeDependencies.reminders.length, 1, '可命中的时间候选仍按既有选择优先进入本轮');
  assert.equal(mixed.locationReferences.length, 0, '时间占满紧预算时，不额外塞入地点参考');
  assert.ok(mixed.limits.estimatedTokenCount <= mixed.limits.estimatedTokenBudget);

  const largeRaw = Array.from({ length: 4 }, (_, index) => `<location>${String.fromCharCode(65 + index)}区公寓·${'卧室'.repeat(220)}${index}</location>`).join('\n');
  const parsed = readLocationReference(largeRaw);
  assert.equal(parsed.length, 4);
  assert.ok(parsed.every(value => value.length <= 500));
  assert.ok(parsed.reduce((sum, value) => sum + value.length, 0) <= 2000);
  source.bodyMatch = { locationReferences: parsed.map((text, index) => ({ text, sourceFloorId: null, hostLocator: { messageIndex: index } })) };
  source.timeProjection = null;
  const clipped = selectRecall({ source, queryContext, contextSize: 1200, maxItems: 8 });
  assert.deepEqual(clipped.locationReferences, [], '地点标签读取限制保留，但不再作为独立注入材料');
  assert.ok(clipped.limits.actualCharacters <= clipped.limits.maxCharacters);
  assert.ok(clipped.limits.estimatedTokenCount <= clipped.limits.estimatedTokenBudget);
});

test('无地点参照的纯时间提示保持既有边界与短格式', () => {
  const reminder = { itemId: 'time-only', text: 'AI #3 之后的期限：下周交付' };
  const timeText = formatRecallInjection({ coverage: selectorSource().coverage, floors: [], states: [], cseChanges: [],
    entityById: new Map(), timeReminders: [reminder], timeDependencies: { corrections: [], reminders: [] } });
  assert.match(timeText, /^<qqj_recalled_context>\n\[时间参考/u);
  assert.doesNotMatch(timeText, /以下都是作者侧资料|此前剧情档案与人物状态/u);
  const locationText = formatRecallInjection({ coverage: selectorSource().coverage, floors: [], states: [], cseChanges: [],
    entityById: new Map(), locationReferences: [{ text: '东区公寓·卧室', sourceFloorId: null, hostLocator: { messageIndex: 2 } }] });
  assert.match(locationText, /本轮选中的历史资料与人物状态/u);
});

test('recall source把已保存地点参考绑定到原Floor host locator', async () => {
  const reachable = await singleFloorReachable({ text: '林岚停在卧室。' });
  reachable.floorMemories[0].sourceLocationReference = ['东区公寓·卧室'];
  const source = await projectRecallSource(reachable, () => new Date(NOW));
  assert.deepEqual(source.floorMemories[0].locationReferences, [{ text: '东区公寓·卧室', sourceFloorId: 'floor-one', assistantSeq: 1,
    hostLocator: { messageIndex: 0, swipeId: null, selectedSwipeIndex: null } }]);
});

test('已保存楼的人工地点清除优先于当前原消息标签回退', async () => {
  const raw = '林岚仍住在卧室。<location>原人工清除的东区公寓·卧室</location>';
  const source = await runtimeSourceWithBodyRef(raw);
  const memory = source.floorMemories.find(item => item.floorId === 'floor-2');
  memory.locationReferenceSources = [{ sourceFloorId: 'floor-2', cleared: true }];
  source.bodyMatchRefs = [{ floorId: 'floor-2', floorMemoryId: memory.floorMemoryId, assistantSeq: 2,
    hostLocator: { messageIndex: 1, swipeId: null, selectedSwipeIndex: null }, rawFingerprint: await fingerprintText(raw), canonicalFingerprint: await fingerprintText('林岚仍住在卧室。') }];
  const harness = createRuntimeHarness({ sourceReader: async () => structuredClone(source),
    reachableReader: async () => rawReachableFromSource(source) });
  harness.chat.splice(0, harness.chat.length, { is_user: true, is_system: false, mes: '开始' },
    { is_user: false, is_system: false, mes: raw }, harness.userMessage);
  harness.userMessage.mes = '继续';
  const core = structuredClone(harness.chat);
  core[1].mes = '林岚仍住在卧室。';
  const result = await harness.runtime.intercept(core, 12000, null, 'normal');
  assert.equal(result.lastRecall.status, 'ready');
  assert.doesNotMatch(result.lastRecall.injectionText, /原人工清除的东区公寓/u);
  assert.deepEqual(harness.userMessage.extra[RECALL_RECEIPT_KEY].selectedLocationReferences, [],
    '对同一已归档来源明确清除后，当前raw不能复活该参考');
});

test('搬家 recall 正文去重只认唯一且内容匹配的 alias，不把A楼号误配到B同号正文', async () => {
  const oldText = 'A聊天第1楼的已记内容。', aliasId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const raw = await singleFloorReachable({ text: oldText });
  raw.floors[0].hostLocator.messageIndex = 1;
  raw.migrationDescriptor = { frozenFloorIds: ['floor-one'],
    floorOrigins: [{ floorId: 'floor-one', sourceChatId: CHAT, sourceHostChatId: 'host-chat-a', sourceMessageIndex: 1, swipeId: 5, selectedSwipeIndex: 5 }],
    carriedAliases: [{ aliasId, floorId: 'floor-one', targetMessageIndex: 3, rawFingerprint: raw.floors[0].content.rawFingerprint,
      canonicalFingerprint: raw.floors[0].content.canonicalFingerprint }] };
  for (const includeAlias of [true, false]) {
    let bodyMatch = null;
    const harness = createRuntimeHarness({ sourceReader: options => readRecallSource(options), reachableReader: async () => structuredClone(raw),
      selector: input => { bodyMatch = input.source.bodyMatch; return selectRecall(input); } });
    harness.chat.splice(0, harness.chat.length,
      { is_user: true, mes: '开始' },
      { is_user: false, mes: 'B聊天第1楼的不同内容。' },
      { is_user: true, mes: '继续' },
      ...(includeAlias ? [{ is_user: false, mes: oldText, extra: { [MIGRATION_ALIAS_KEY]: aliasId } }] : [{ is_user: false, mes: oldText }]),
      harness.userMessage);
    if (includeAlias) {
      harness.chat.splice(2, 1); // B 中删去前置 USER 后，alias从原位置3移到2；descriptor index仅是初始hint。
      const projected = await readRecallSource({ store: { readReachable: async () => structuredClone(raw) }, hostSnapshot: { chat: harness.chat, context: harness.context } });
      assert.equal(projected.bodyMatchRefs.find(ref => ref.floorId === 'floor-one')?.frozen, true);
    }
    await harness.runtime.intercept(structuredClone(harness.chat), 12000, null, 'normal');
    assert.equal(bodyMatch.recentBodyFloorIds.includes('floor-one'), includeAlias,
      includeAlias ? '原内容通过B唯一alias进入近期正文去重' : 'A source locator=1不得匹配B自己的不同index=1消息');
    assert.equal(bodyMatch.coveredFloorIds.includes('floor-one'), false, '只有近期正文alias不伪造本次history witness覆盖');
  }
});

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
  const privateState = { id: 'cse-state-private', text: '仍在钟楼等待赴约', visibility: 'private', reason: longReason, origin: 'floor', towardEntityId: 'cse-target-person', sourceFloorId: floors[0].id, sourceDeltaId: 'delta-add' };
  const stateDeltas = [
    { id: 'delta-add', floorId: floors[0].id, floorMemoryId: floorMemories[0].id, recordStatus: 'active', subjectSnapshots: [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: [privateState] }], fixedChanges: [{ subjectEntityId: PERSON, items: [{ category: 'situational', action: 'add', before: null, after: privateState }] }] },
    { id: removeDeltaId, floorId: floors[1].id, floorMemoryId: floorMemories[1].id, recordStatus: 'active', subjectSnapshots: [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: [] }], fixedChanges: [{ subjectEntityId: PERSON, items: [{ category: 'situational', action: 'remove', before: privateState, after: null }] }] },
  ];
  return {
    status: 'ready', rootRevision: 7,
    root: { chatId: CHAT, narrativeGeneration: GEN, headCheckpointId: 'cse-head' }, checkpoint: { id: 'cse-head' }, baseline: null,
    floors, floorMemories, stateDeltas, currentStates: [],
    entities: [
      { id: PERSON, entityType: 'person', displayName: '裴晚生', aliases: [{ name: '阿裴' }], specialRole: 'char', recordStatus: 'active', status: 'established' },
      { id: 'cse-target-person', entityType: 'person', displayName: '林岚', aliases: [], specialRole: 'none', recordStatus: 'active', status: 'established' },
    ],
  };
}

function createRuntimeHarness({ sourceReader, selector = selectRecall, useDefaultSelector = false, generateUtilityTask, processingPrompt, semanticProvider, queryBuilder = buildRecallQueryContext, saveChat = true, reachableReader, rootReader, prepareMemory, preparationTimeoutMs, snapshotHook, fingerprint, memoryStatus, manualMemorySnapshot, realtimeOrigin, notifyUser, identityProjectionProvider, placeWorkspaceDependencyProvider, timeProjectionProvider, qianshiProgressProvider, qianshiDeletionProvider, pluginVersion = TEST_PLUGIN_VERSION, prequel = null, recentBodyFloorLimit } = {}) {
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
    ...(processingPrompt ? { processingPrompt } : {}),
    ...(semanticProvider ? { semanticProvider } : {}),
    queryBuilder,
    ...(memoryStatus ? { memoryStatus } : {}),
    ...(manualMemorySnapshot ? { manualMemorySnapshot } : {}),
    ...(realtimeOrigin ? { realtimeOrigin } : {}),
    ...(notifyUser ? { notifyUser } : {}),
    ...(identityProjectionProvider ? { identityProjectionProvider } : {}),
    ...(placeWorkspaceDependencyProvider ? { placeWorkspaceDependencyProvider } : {}),
    ...(timeProjectionProvider ? { timeProjectionProvider } : {}),
    ...(qianshiProgressProvider ? { qianshiProgressProvider } : {}),
    ...(qianshiDeletionProvider ? { qianshiDeletionProvider } : {}),
    ...(prepareMemory ? { prepareMemory } : {}),
    ...(preparationTimeoutMs ? { preparationTimeoutMs } : {}),
    ...(recentBodyFloorLimit ? { recentBodyFloorLimit } : {}),
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

async function partialBindingFixture() {
  const messages = ['钟楼第一件旧事。', '他们定的是旧酒店。', '钟楼第三件旧事。'].map(mes => ({ is_user: false, is_system: false, is_hidden: true, mes }));
  const scanned = await scanAssistantCandidates(messages, { chatId: CHAT });
  const raw = await singleFloorReachable();
  raw.floors = scanned.map((candidate, index) => ({ id: `partial-floor-${index + 1}`, assistantSeq: index + 1,
    hostLocator: candidate.hostLocator, content: { rawFingerprint: candidate.rawFingerprint, canonicalFingerprint: candidate.canonicalFingerprint } }));
  raw.floorMemories = raw.floors.map((floor, index) => ({ id: `partial-memory-${index + 1}`, floorId: floor.id, recordStatus: 'active',
    summary: { effectiveSource: 'ai', aiText: ['钟楼第一件旧约。', '旧酒店的自动摘要。', '钟楼第三件旧约。'][index] }, ...emptyMemory }));
  return { raw, messages };
}

test('单楼无锚改字只隔离该楼自动材料，其他楼仍进入普通召回', async () => {
  const { raw, messages } = await partialBindingFixture();
  messages[1].mes = '他们定的是新酒店。';
  let selectedSource = null, calls = 0;
  const h = createRuntimeHarness({ sourceReader: options => readRecallSource(options), reachableReader: async () => structuredClone(raw),
    selector: input => { calls++; selectedSource = input.source; return selectRecall(input); } });
  h.chat.splice(0, h.chat.length, ...messages, h.userMessage);
  const result = await h.runtime.intercept([structuredClone(h.userMessage)], 12000, null, 'normal');
  assert.equal(calls, 1, '单楼待更新不能挡住选材器');
  assert.equal(result.lastRecall.status, 'ready', JSON.stringify(result.lastRecall));
  assert.match(result.lastRecall.injectionText, /钟楼第一件旧约|钟楼第三件旧约/u);
  assert.doesNotMatch(result.lastRecall.injectionText, /旧酒店/u);
  assert.deepEqual(selectedSource.floorMemories.map(memory => memory.floorId), ['partial-floor-1', 'partial-floor-3']);
  assert.deepEqual(selectedSource.readiness.unmatchedFloorIds, ['partial-floor-2']);
});

test('删除中间楼后已确认来源采用当前定位，旧索引不拖累其余召回', async () => {
  const { raw, messages } = await partialBindingFixture();
  let selectedSource = null;
  const h = createRuntimeHarness({ sourceReader: options => readRecallSource(options), reachableReader: async () => structuredClone(raw),
    selector: input => { selectedSource = input.source; return selectRecall(input); } });
  h.chat.splice(0, h.chat.length, messages[0], messages[2], h.userMessage);
  const result = await h.runtime.intercept([structuredClone(h.userMessage)], 12000, null, 'normal');
  assert.equal(result.lastRecall.status, 'ready', JSON.stringify(result.lastRecall));
  assert.equal(selectedSource.bodyMatchRefs.find(ref => ref.floorId === 'partial-floor-3').hostLocator.messageIndex, 1);
  assert.match(result.lastRecall.injectionText, /钟楼第三件旧约/u);
});

test('失配楼的手工摘要仍为准，手工清空不会回灌旧AI材料', async () => {
  for (const userText of ['钟楼人工改稿：改住新酒店。', '']) {
    const { raw, messages } = await partialBindingFixture();
    messages[1].mes = '他们定的是新酒店。';
    raw.floorMemories[1].summary = { effectiveSource: 'user', aiText: '旧酒店的自动摘要。', userText };
    raw.floorMemories[1].actions = [{ actorEntityId: PERSON, targetEntityIds: [], action: '旧酒店的自动行动。', result: '', completion: 'completed' }];
    const source = await projectRecallSource(raw, () => new Date(NOW), null, { context: { chatMetadata: { qianqianjie: { chatId: CHAT } } }, chat: messages });
    const memory = source.floorMemories.find(item => item.floorId === 'partial-floor-2');
    assert.ok(memory, '同chat手工稿独立于正文待更新保持可读');
    assert.equal(memory.summary, userText);
    assert.deepEqual(memory.actions, []);
    assert.equal(source.rawSources.some(item => item.floorId === 'partial-floor-2'), false);
  }
});

test('人工CSE冻结消费按稳定人物更新、清空及重填，四入口和冷票只选择一次', async t => {
  for (const legacy of [false, true]) await t.test(legacy ? '无renderPlan旧票' : '当前票', async () => {
  const raw = await singleFloorReachable({ summary: '阿裴在钟楼等待。' });
  raw.entities = reachable().entities;
  const state = text => ({ id: `manual-${text}`, text, reason: '人工校准', visibility: 'private', origin: 'manual',
    towardEntityId: null, sourceFloorId: raw.floors[0].id, sourceDeltaId: `delta-${text}` });
  let prior = state('人工信任旧值');
  const save = text => {
    const after = text ? state(text) : null;
    raw.stateDeltas = [{ id: after?.sourceDeltaId ?? 'delta-clear', floorId: raw.floors[0].id, floorMemoryId: raw.floorMemories[0].id,
      recordStatus: 'active', source: { manualSubjectEntityIds: [PERSON] },
      subjectSnapshots: [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: after ? [after] : [] }],
      fixedChanges: [{ subjectEntityId: PERSON, items: [{ category: 'situational', action: after ? 'update' : 'remove', before: prior, after }] }] }];
    raw.currentStates = [{ subjects: raw.stateDeltas[0].subjectSnapshots }];
    raw.rootRevision++;
    raw.root.headCheckpointId = raw.checkpoint.id = `head-${raw.rootRevision}`;
    prior = after;
  };
  save('人工信任旧值');
  let selections = 0;
  const h = createRuntimeHarness({ sourceReader: options => readRecallSource(options), reachableReader: async () => structuredClone(raw),
    manualMemorySnapshot: () => raw, selector: input => { selections++; return selectRecall(input); } });
  h.chat[0].is_hidden = true;
  let result = await h.runtime.intercept([structuredClone(h.userMessage)], 12000, null, 'normal');
  assert.match(result.lastRecall.injectionText, /人工信任旧值/u);
  const unselectedId = '99999999-9999-4999-8999-999999999999';
  raw.entities.push({ ...raw.entities[0], id: unselectedId, displayName: '裴晚生' });
  const unselected = { ...state('未选人物私密人工值'), id: 'unselected-manual' };
  raw.stateDeltas[0].source.manualSubjectEntityIds.push(unselectedId);
  raw.stateDeltas[0].subjectSnapshots.push({ subjectEntityId: unselectedId, core: [], adaptive: [], situational: [unselected] });
  raw.stateDeltas[0].fixedChanges.push({ subjectEntityId: unselectedId, items: [{ category: 'situational', action: 'add', before: null, after: unselected }] });
  raw.currentStates[0].subjects = raw.stateDeltas[0].subjectSnapshots;
  result = await h.runtime.intercept([structuredClone(h.userMessage)], 12000, null, 'continue');
  assert.doesNotMatch(result.lastRecall.injectionText, /未选人物私密人工值/u, '同名人物只按稳定ID保原选中范围');
  if (legacy) {
    await flushReceiptSave();
    const receipt = h.userMessage.extra[RECALL_RECEIPT_KEY];
    delete receipt.timeDependencies.renderPlan;
    receipt.receiptFingerprint = await receiptFingerprint(receipt);
    h.runtime.invalidate('legacy-manual-cse');
  }
  save('人工信任新值');
  for (const type of ['normal', 'regenerate', 'swipe', 'continue']) {
    result = await h.runtime.intercept([structuredClone(h.userMessage)], 12000, null, type);
    assert.equal(result.lastRecall.reusedReceipt, true);
    assert.match(result.lastRecall.injectionText, /人工信任新值/u);
    assert.doesNotMatch(result.lastRecall.injectionText, /人工信任旧值/u);
  }
  save(null);
  for (const type of ['normal', 'regenerate', 'swipe', 'continue']) {
    result = await h.runtime.intercept([structuredClone(h.userMessage)], 12000, null, type);
    assert.doesNotMatch(result.lastRecall.injectionText, /人工信任(?:旧值|新值)/u);
  }
  await flushReceiptSave();
  h.runtime.invalidate('cold-manual-cse');
  result = await h.runtime.intercept([structuredClone(h.userMessage)], 12000, null, 'regenerate');
  assert.equal(result.lastRecall.reusedReceipt, true);
  save('人工重新填写信任');
  result = await h.runtime.intercept([structuredClone(h.userMessage)], 12000, null, 'normal');
  assert.match(result.lastRecall.injectionText, /人工重新填写信任/u);
  const frozen = result.lastRecall.injectionText;
  raw.currentStates[0].subjects[0].situational = [{ ...state('后台自动新进展'), origin: 'floor' }];
  raw.rootRevision++;
  result = await h.runtime.intercept([structuredClone(h.userMessage)], 12000, null, 'continue');
  assert.equal(result.lastRecall.injectionText, frozen, '已采用的人工结果沿同USER冻结，后台自动变化不重选');
  const delta = raw.stateDeltas[0];
  const bulk = Array.from({ length: 300 }, (_, index) => ({ ...state(`人工条目${index}`), id: `bulk-${index}`, sourceDeltaId: 'delta-bulk' }));
  raw.stateDeltas = [{ ...delta, id: 'delta-bulk', subjectSnapshots: [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: bulk }],
    fixedChanges: [{ subjectEntityId: PERSON, items: [{ category: 'situational', action: 'remove', before: prior, after: null },
      ...bulk.map(after => ({ category: 'situational', action: 'add', before: null, after }))] }] }];
  raw.currentStates = [{ subjects: raw.stateDeltas[0].subjectSnapshots }];
  raw.rootRevision++;
  result = await h.runtime.intercept([structuredClone(h.userMessage)], 12000, null, 'normal');
  assert.match(result.lastRecall.injectionText, /人工条目/u);
  await flushReceiptSave();
  const receipt = h.userMessage.extra[RECALL_RECEIPT_KEY];
  assert.ok(receipt.selectedStates.length + receipt.selectedCseChanges.length <= 256);
  assert.ok([...receipt.selectedStates, ...receipt.selectedCseChanges].every(item => receipt.storylines.some(line => line.storylineId === item.storylineId)));
  h.runtime.invalidate('cold-count-limit');
  result = await h.runtime.intercept([structuredClone(h.userMessage)], 12000, null, 'regenerate');
  assert.equal(result.lastRecall.reusedReceipt, true, '人工多条结果按原计数和预算裁剪后冷票有效');
  assert.equal(selections, 1);
  });
});

test('人工楼内地点及参与人物在正文失配后独立保留，清空和自动资料按各自归属', async () => {
  for (const [manualLocations, manualParticipants] of [[true, false], [false, true], [true, true], [false, false]]) {
    const manual = manualLocations || manualParticipants;
    const { raw, messages } = await partialBindingFixture();
    raw.entities = [...reachable().entities, { id: 'place-library', entityType: 'place', displayName: '人工图书室', recordStatus: 'active', aliases: [] }];
    raw.floorMemories[1].locations = [{ entityId: 'place-library', name: '人工图书室', change: 'present', participantEntityIds: [PERSON] }];
    raw.floorMemories[1].participants = [{ entityId: PERSON }];
    raw.run = { diagnostics: { floorProvenance: { 'partial-floor-2': { locationsEdited: manualLocations, participantsEdited: manualParticipants } } } };
    if (manualLocations && manualParticipants) {
      raw.floorMemories[0].recordStatus = 'superseded';
      raw.floorMemories[1].sourceFloorIds = [raw.floors[0].id, raw.floors[1].id];
      messages[0].mes = '聚合成员原文已经改写。';
    } else messages[1].mes = '正文已改，人工资料仍有效。';
    let source = await projectRecallSource(raw, () => new Date(NOW), null, { context: { chatMetadata: { qianqianjie: { chatId: CHAT } } }, chat: messages });
    const memory = source.floorMemories.find(value => value.floorId === 'partial-floor-2');
    assert.equal(Boolean(memory), manual);
    if (manual) {
      assert.equal(memory.locations.length, Number(manualLocations));
      assert.equal(memory.participants.length, Number(manualParticipants));
      const selected = selectRecall({ source, queryContext: buildRecallQueryContext({ coreChat: [{ is_user: true, mes: '阿裴在人工图书室的情况如何？' }] }), contextSize: 12000 });
      if (manualLocations) assert.match(selected.injectionText, /人工图书室/u);
      assert.equal(memory.summary, '');
      raw.floorMemories[1].locations = [];
      raw.floorMemories[1].participants = [];
      source = await projectRecallSource(raw, () => new Date(NOW), null, { context: { chatMetadata: { qianqianjie: { chatId: CHAT } } }, chat: messages });
      assert.deepEqual(source.floorMemories.find(value => value.floorId === 'partial-floor-2').locations, []);
    }
  }
});

test('同USER手工摘要修订只更新有关冻结内容，不重新调用选材模型', async () => {
  const raw = await singleFloorReachable({ summary: '钟楼手工旧稿。' });
  raw.floorMemories[0].summary = { effectiveSource: 'user', aiText: 'AI原稿。', userText: '钟楼手工旧稿。' };
  let selections = 0;
  const h = createRuntimeHarness({ sourceReader: options => readRecallSource(options), reachableReader: async () => structuredClone(raw), manualMemorySnapshot: () => raw,
    selector: input => { selections++; return selectRecall(input); } });
  h.chat[0].is_hidden = true;
  const first = await h.runtime.intercept([structuredClone(h.userMessage)], 12000, null, 'normal');
  assert.match(first.lastRecall.injectionText, /钟楼手工旧稿/u);
  raw.floorMemories[0].id = 'memory-manual-revision';
  raw.floorMemories[0].summary.userText = '钟楼手工新稿：约定取消。';
  raw.rootRevision++;
  raw.root.headCheckpointId = raw.checkpoint.id = 'head-manual-revision';
  const revised = await h.runtime.intercept([structuredClone(h.userMessage)], 12000, null, 'regenerate');
  assert.equal(revised.lastRecall.status, 'ready', JSON.stringify(revised.lastRecall));
  assert.match(revised.lastRecall.injectionText, /钟楼手工新稿[:：]约定取消/u);
  assert.doesNotMatch(revised.lastRecall.injectionText, /钟楼手工旧稿|AI原稿/u);
  assert.equal(selections, 1, '人工更新不能增加选材请求');
});

test('旧版无renderPlan冻结票冷读后也采用当前人工新稿，清空与无关修改不回灌', async () => {
  const raw = await singleFloorReachable({ summary: '钟楼手工旧稿。' });
  const literal = '载体原文：\n[来源 AI #1]\n- [旧事] [叙事回顾] 字面原文必须保留。';
  const body = '街上已经安静。';
  raw.floors[0].content.canonicalContent = body;
  raw.floorMemories[0].sourceCanonicalContent = body;
  const rawWitness = { floorId: 'floor-one', floorMemoryId: 'memory-one', memoryFloorId: 'floor-one', assistantSeq: 1, memoryAssistantSeq: 1,
    fingerprint: raw.floors[0].content.canonicalFingerprint, offset: 0, length: body.length, textFingerprint: await fingerprintText(body) };
  let selections = 0;
  const h = createRuntimeHarness({ sourceReader: options => readRecallSource(options), reachableReader: async () => structuredClone(raw), manualMemorySnapshot: () => raw,
    selector: input => {
      selections++;
      const selection = structuredClone(selectRecall(input));
      const floor = selection.floors[0];
      floor.items.push({ kind: 'manualArtifact', category: 'objective', text: literal, exactText: literal, carrier: '测试原件', knownEntityIds: [], storylineId: floor.items[0].storylineId });
      floor.items.push({ kind: 'sourceFragment', category: 'narrative', text: `[历史原文；时间未标注] ${body}`, rawWitness, storylineId: floor.items[0].storylineId });
      selection.injectionText = formatRecallInjection({ ...selection, coverage: input.source.coverage, entityById: new Map() });
      return selection;
    } });
  h.chat[0].is_hidden = true;
  await h.runtime.intercept([structuredClone(h.userMessage)], 12000, null, 'normal');
  await flushReceiptSave();
  const old = h.userMessage.extra[RECALL_RECEIPT_KEY];
  delete old.timeDependencies.renderPlan;
  old.receiptFingerprint = await receiptFingerprint(old);
  h.runtime.invalidate('baseline-no-plan');
  raw.floorMemories[0].id = 'memory-manual-new';
  raw.floorMemories[0].summary = { effectiveSource: 'user', userText: '钟楼手工新稿。' };
  let result = await h.runtime.intercept([structuredClone(h.userMessage)], 12000, null, 'regenerate');
  assert.match(result.lastRecall.injectionText, /钟楼手工新稿/u);
  assert.doesNotMatch(result.lastRecall.injectionText, /钟楼手工旧稿/u);
  assert.ok(result.lastRecall.injectionText.includes(literal), '生产formatter的人工原文长度块逐字保留');
  assert.ok(result.lastRecall.injectionText.includes(`[历史原文；时间未标注] ${body}`), '同楼原文见证保原片段，只有摘要更新');
  assert.equal(selections, 1);
  const saved = result.lastRecall.injectionText;
  raw.floorMemories.push({ id: 'unrelated-manual', floorId: 'another-floor', recordStatus: 'active', summary: { effectiveSource: 'user', userText: '无关稿。' }, ...emptyMemory });
  result = await h.runtime.intercept([structuredClone(h.userMessage)], 12000, null, 'swipe');
  assert.equal(result.lastRecall.injectionText, saved);
  raw.floorMemories[0].id = 'memory-manual-empty';
  raw.floorMemories[0].summary.userText = '';
  result = await h.runtime.intercept([structuredClone(h.userMessage)], 12000, null, 'regenerate');
  assert.doesNotMatch(result.lastRecall.injectionText, /钟楼手工新稿|钟楼手工旧稿/u);
  assert.ok(result.lastRecall.injectionText.includes(literal));
  assert.equal(selections, 1);
});

test('删楼位移后记忆排除取当前候选，不借其他楼旧索引', async () => {
  const { raw, messages } = await partialBindingFixture();
  const fourth = { is_user: false, is_system: false, is_hidden: true, mes: '第四楼排除原文。', extra: { qianqianjie_memory_excluded: true } };
  const fourthCandidate = (await scanAssistantCandidates([...messages, fourth], { chatId: CHAT })).at(-1);
  raw.floors.push({ id: 'floor-four', assistantSeq: 4, hostLocator: fourthCandidate.hostLocator, content: { rawFingerprint: fourthCandidate.rawFingerprint, canonicalFingerprint: fourthCandidate.canonicalFingerprint } });
  raw.floorMemories.push({ id: 'memory-four', floorId: 'floor-four', recordStatus: 'active', summary: { effectiveSource: 'ai', aiText: '第四楼不应召回。' }, ...emptyMemory });
  const source = await projectRecallSource(raw, () => new Date(NOW), null, { context: { chatMetadata: { qianqianjie: { chatId: CHAT } } }, chat: [messages[0], messages[2], fourth] });
  assert.deepEqual(source.bodyMatchRefs.map(ref => [ref.floorId, ref.hostLocator.messageIndex]), [['partial-floor-1', 0], ['partial-floor-3', 1]]);
  assert.equal(source.floorMemories.some(memory => memory.floorId === 'floor-four'), false);
});

test('多组重复标记只隔离各自冲突楼，独立楼仍能确认', async () => {
  const { raw, messages } = await partialBindingFixture();
  const ids = [FLOOR1, FLOOR2, GEN];
  raw.floors.forEach((floor, index) => { floor.id = ids[index]; raw.floorMemories[index].floorId = floor.id; });
  messages.forEach((message, index) => { message.extra = { qianqianjie_floor: { schemaVersion: 1, chatId: CHAT, floorId: ids[index] } }; });
  const chat = [messages[0], structuredClone(messages[0]), messages[1], structuredClone(messages[1]), messages[2]];
  const source = await projectRecallSource(raw, () => new Date(NOW), null, { context: { chatMetadata: { qianqianjie: { chatId: CHAT } } }, chat });
  assert.deepEqual(source.floorMemories.map(memory => memory.floorId), [GEN]);
  assert.deepEqual(source.readiness.unmatchedFloorIds, [FLOOR1, FLOOR2]);
});

test('局部失配只撤对应自动状态及变化，后楼仍保其他来源状态', async () => {
  const { raw, messages } = await partialBindingFixture();
  [FLOOR1, FLOOR2, '77777777-0000-4000-8000-000000000001'].forEach((id, index) => { raw.floors[index].id = id; raw.floorMemories[index].floorId = id; });
  messages[1].mes = '他们定的是新酒店。';
  raw.baseline = { id: BASELINE };
  raw.entities = [{ id: PERSON, entityType: 'person', displayName: '裴晚生', aliases: [], specialRole: 'char', recordStatus: 'active', status: 'established' }];
  const item = (id, floorId, text) => ({ id, text, visibility: 'private', reason: '已保存依据', origin: 'floor', towardEntityId: null, sourceFloorId: floorId, sourceDeltaId: DELTA1 });
  const good = item(ITEM, raw.floors[0].id, '钟楼的可靠约定。');
  const stale = item('99999999-0000-4000-8000-000000000001', raw.floors[1].id, '旧酒店的失配状态。');
  raw.stateDeltas = [{ id: DELTA1, floorId: raw.floors[2].id, floorMemoryId: raw.floorMemories[2].id, recordStatus: 'active',
    subjectSnapshots: [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: [good, stale] }],
    fixedChanges: [{ subjectEntityId: PERSON, items: [good, stale].map(after => ({ category: 'situational', action: 'add', before: null, after })) }] }];
  const source = await projectRecallSource(raw, () => new Date(NOW), null, { context: { chatMetadata: { qianqianjie: { chatId: CHAT } } }, chat: messages });
  assert.deepEqual(source.currentState[0].situational.map(value => value.text), ['钟楼的可靠约定。']);
  assert.deepEqual(source.cseChanges.map(value => value.after.text), ['钟楼的可靠约定。']);
});

test('局部放行仍拒绝其他chat的图，人工稿不跨聊天进入选材', async () => {
  const raw = await singleFloorReachable();
  raw.root.chatId = GEN;
  raw.floorMemories[0].summary = { effectiveSource: 'user', userText: '其他聊天手工稿。' };
  let calls = 0;
  const h = createRuntimeHarness({ sourceReader: options => readRecallSource(options), reachableReader: async () => structuredClone(raw),
    selector: input => { calls++; return selectRecall(input); } });
  h.chat[0].is_hidden = true;
  const result = await h.runtime.intercept([structuredClone(h.userMessage)], 12000, null, 'normal');
  assert.equal(calls, 0);
  assert.equal(result.lastRecall.injectionText, '');
});

const latestPromptValue = (prompts, slot) => prompts.filter(call => call[0] === slot).at(-1)?.[1];
const flushReceiptSave = () => new Promise(resolve => setImmediate(resolve));

test('时间投影await后长正文尾部/默认swipe改变只撤时间；USER或聊天改变仍阻断', async () => {
  for (const change of ['raw', 'swipe', 'user', 'chat']) {
    let reads = 0, selections = 0, harness;
    harness = createRuntimeHarness({ timeProjectionProvider: async () => {
      reads += 1;
      const message = harness.chat[0];
      const projection = { fingerprint: 'same-clock', corrections: {}, reminders: [{ itemId: 'time-item', text: '阿裴 / 期限今天', sourceSignature: 'saved-source' }],
        currentBodyWitness: { hostLocator: { messageIndex: 0, swipeId: change === 'swipe' ? 0 : null, selectedSwipeIndex: change === 'swipe' ? 0 : null }, rawContent: change === 'swipe' ? message.swipes[0] : message.mes,
          canonicalContent: change === 'swipe' ? message.swipes[0] : message.mes } };
      if (reads === 2) {
        await Promise.resolve();
        queueMicrotask(() => {
          if (change === 'raw') message.mes += '时钟尾部改变';
          if (change === 'swipe') message.swipes[0] += '默认swipe改变';
          if (change === 'user') harness.userMessage.mes += '用户改变';
          if (change === 'chat') harness.context.chatMetadata.qianqianjie.chatId = GEN;
        });
      }
      return projection;
    }, selector: input => { selections += 1; return selectRecall(input); } });
    harness.chat[0].mes = '长正文'.repeat(1600);
    if (change === 'swipe') harness.chat[0].swipes = [harness.chat[0].mes];
    const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
    assert.equal(selections, 1, change);
    if (['user', 'chat'].includes(change)) { assert.equal(result.lastRecall.status, 'stale', change); assert.equal(latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT), '', change); }
    else {
      assert.equal(result.lastRecall.status, 'ready', change);
      assert.match(result.lastRecall.injectionText, /钟楼|承诺/, change);
      assert.doesNotMatch(result.lastRecall.injectionText, /期限今天/, change);
      const receipt = harness.userMessage.extra[RECALL_RECEIPT_KEY];
      assert.equal(receipt.timeDependencies.reminders.length, 0, change);
      assert.equal(receipt.injectionText, latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT), change);
    }
  }
});

test('恢复长原CSE后重新执行4000预算，实际条数/引用/签名均与重建结果一致', async () => {
  for (const constraint of ['total']) {
  const raw = reachable();
  raw.stateDeltas[0].subjectSnapshots[0].situational[0].text = '雨夜承诺仍然有效。'.repeat(300);
  raw.stateDeltas[0].fixedChanges[0].items[0].after.text = raw.stateDeltas[0].subjectSnapshots[0].situational[0].text;
  const source = await projectRecallSource(raw, () => new Date(NOW));
  let reads = 0, selections = 0;
  const harness = createRuntimeHarness({ sourceReader: async () => structuredClone(source), reachableReader: async () => structuredClone(raw),
    timeProjectionProvider: async () => {
      reads += 1;
      const state = source.currentState[0].situational[0];
      return { fingerprint: 'same-time', corrections: reads === 1 ? { [`${state.stateId}|${PERSON}|${state.sourceFloorId}`]: { itemId: 'time-item', text: '短时间校正', sourceSignature: 'saved-source' } } : {}, reminders: [] };
    }, selector: input => {
      selections += 1; const selection = selectRecall(input);
      return { ...selection, limits: { ...selection.limits,
        maxCharacters: selection.injectionText.length + 50, estimatedTokenBudget: estimateRecallTokens(selection.injectionText) + 30 } };
    } });
  const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const receipt = harness.userMessage.extra[RECALL_RECEIPT_KEY];
  assert.equal(selections, 1);
  assert.ok(receipt.injectionText.length <= receipt.timeDependencies.renderPlan.limits.maxCharacters);
  assert.ok(estimateRecallTokens(receipt.injectionText) <= receipt.timeDependencies.renderPlan.limits.estimatedTokenBudget);
  assert.doesNotMatch(receipt.injectionText, /短时间校正/);
  assert.equal(receipt.stages.stateCount, receipt.selectedStates.length);
  assert.equal(receipt.stages.selected, receipt.selectedFloors.length);
  assert.equal(receipt.stages.finalInjectionItemCount, receipt.timeDependencies.renderPlan.floors.reduce((sum, floor) => sum + floor.items.length, 0) + receipt.selectedStates.length + receipt.selectedCseChanges.length);
  assert.equal(result.lastRecall.injectionText, receipt.injectionText);
  assert.equal(receipt.receiptFingerprint, await receiptFingerprint(receipt));
  }
});

test('旧v12收据仍可历史查看，但当前v14必须重新选材', async () => {
  let selections = 0;
  const harness = createRuntimeHarness({ selector: input => { selections += 1; return selectRecall(input); } });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const old = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]); old.strategyVersion = 'continuity-v12'; old.receiptFingerprint = await receiptFingerprint(old);
  harness.runtime.invalidate('reload'); harness.userMessage.extra[RECALL_RECEIPT_KEY] = old;
  assert.equal((await projectHistoricalRecallReceipt(harness.userMessage, { chatId: CHAT, userMessageIndex: 1 })).injectionText, old.injectionText);
  const result = await harness.runtime.intercept(harness.chat, 12000, null, 'continue');
  assert.equal(result.lastRecall.reusedReceipt, false); assert.equal(selections, 2);
});

test('提交只核对真正选入的时间项；零依赖及未选项变化放行，所选时间失效只撤时间，普通层保留', async () => {
  for (const scenario of ['zero', 'unselected', 'unchanged', 'correctionText', 'correctionMissing', 'correctionSource', 'reminderText', 'reminderMissing', 'reminderSource', 'allMissing', 'unavailable', 'externalUnknown']) {
    const raw = reachable(); let projection, reads = 0, selected;
    const sourceReader = ({ now }) => readRecallSource({ now, store: { readReachable: async () => structuredClone(raw) } });
    const harness = createRuntimeHarness({ sourceReader, reachableReader: async () => structuredClone(raw),
      timeProjectionProvider: async source => {
        reads += 1;
        if (reads > 1 && scenario === 'unavailable') throw new Error('optional time unavailable');
        if (!projection) {
          const state = source.currentState[0].situational[0];
          projection = { fingerprint: 'initial-time', currentTime: { raw: '18:45' }, corrections: {}, reminders: [] };
          if (!['zero', 'externalUnknown'].includes(scenario)) {
            projection.corrections[`${state.stateId}|${PERSON}|${state.sourceFloorId}`] = { itemId: 'body-item', text: '原观察仍疲惫；当前推测可能恢复', sourceSignature: 'body-source' };
            projection.reminders.push({ itemId: 'deadline-item', text: '阿裴 / 约定尚未确认完成', sourceSignature: 'deadline-source' });
            projection.reminders.push({ itemId: 'unselected-item', text: '预算外参考'.repeat(10000), sourceSignature: 'other-source' });
          }
        }
        return structuredClone(projection);
      }, selector: input => {
        selected = selectRecall(input);
        projection.fingerprint = 'unrelated-new-time'; projection.currentTime.raw = '20:00';
        const correction = Object.values(projection.corrections)[0];
        if (scenario === 'unselected') projection.reminders.at(-1).text = '仍在预算外'.repeat(10000);
        if (scenario === 'correctionText') correction.text += '，新观察';
        if (scenario === 'correctionMissing') projection.corrections = {};
        if (scenario === 'correctionSource') correction.sourceSignature = 'new-body-source';
        if (scenario === 'reminderText') projection.reminders[0].text += '，改期';
        if (scenario === 'reminderMissing') projection.reminders.shift();
        if (scenario === 'reminderSource') projection.reminders[0].sourceSignature = 'new-deadline-source';
        if (scenario === 'allMissing') { projection.corrections = {}; projection.reminders = []; }
        if (scenario === 'externalUnknown') { const result = { ...selected }; delete result.timeDependencies; return result; }
        return selected;
      } });
    let abortCalls = 0;
    const result = await harness.runtime.intercept(harness.chat, 12000, value => { if (value === true) abortCalls += 1; }, 'normal');
    const allowed = scenario !== 'externalUnknown';
    assert.equal(result.lastRecall.status, allowed ? 'ready' : 'stale', scenario);
    assert.equal(abortCalls, 0, '引用变化沿用放弃旧注入、正文继续的现有行为');
    if (!allowed) { assert.ok(result.lastRecall.skipReasons.includes('selectedRefsChanged'), scenario); assert.equal(latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT), '', scenario); }
    if (allowed) {
      const receipt = harness.userMessage.extra[RECALL_RECEIPT_KEY];
      assert.equal(result.lastRecall.injectionText, latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT), scenario);
      assert.equal(receipt.injectionText, result.lastRecall.injectionText, scenario);
      assert.equal(receipt.stages.estimatedTokenCount, estimateRecallTokens(receipt.injectionText), scenario);
      if (scenario.startsWith('correction') || ['allMissing', 'unavailable'].includes(scenario)) {
        assert.match(receipt.injectionText, /始终记得雨夜承诺/, scenario);
        assert.equal(receipt.timeDependencies.corrections.length, 0, scenario);
        assert.doesNotMatch(receipt.injectionText, /当前推测可能恢复/, scenario);
      }
      if (scenario.startsWith('reminder') || ['allMissing', 'unavailable'].includes(scenario)) assert.equal(receipt.timeDependencies.reminders.length, 0, scenario);
    }
    if (scenario === 'zero') { assert.equal(reads, 1); assert.deepEqual(selected.timeDependencies, { mode: 'selected', corrections: [], reminders: [] }); }
    if (scenario === 'unselected') { assert.equal(selected.timeDependencies.reminders.length, 1); assert.equal(selected.timeDependencies.reminders[0].itemId, 'deadline-item'); }
  }
});

test('零时间依赖遇root推进只重新准备普通来源，不附带读取整份time', async () => {
  const source = runtimeFixture(); let reads = 0;
  const harness = createRuntimeHarness({ sourceReader: async () => structuredClone(source),
    rootReader: async () => ({ status: 'ready', revision: source.rootRevision, data: { chatId: source.chatId, narrativeGeneration: source.narrativeGeneration, headCheckpointId: source.headCheckpointId } }),
    timeProjectionProvider: async () => { reads += 1; return { fingerprint: `time-${reads}`, corrections: {}, reminders: [] }; },
    selector: input => { const selected = selectRecall(input); source.rootRevision += 1; source.headCheckpointId = 'advanced-checkpoint'; return selected; } });
  const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(result.lastRecall.status, 'ready'); assert.equal(reads, 1);
});

test('同 user 冻结回执复用不再读取时间投影，无关时间推进不改原注入', async () => {
  let reads = 0, selections = 0, live = { fingerprint: 'query-time', corrections: {}, reminders: [], currentTime: { raw: '18:45' } };
  const harness = createRuntimeHarness({ timeProjectionProvider: async () => {
    reads += 1; const captured = structuredClone(live);
    if (reads === 2) live = { ...live, fingerprint: 'unrelated-time-progress', currentTime: { raw: '20:00' } };
    return captured;
  }, selector: input => { selections += 1; return selectRecall(input); } });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(reads, 1); assert.deepEqual(harness.userMessage.extra[RECALL_RECEIPT_KEY].timeDependencies, { mode: 'selected', corrections: [], reminders: [] });
  const reused = await harness.runtime.intercept(harness.chat, 12000, null, 'continue');
  assert.equal(reused.lastRecall.status, 'ready'); assert.equal(reused.lastRecall.reusedReceipt, true);
  assert.equal(selections, 1); assert.equal(reads, 1, '冻结复用在任何时间 provider 之前完成');
});

test('同 user 冻结回执保留首次选中时间原文；旧schema13仍只作历史展示', async () => {
  for (const scenario of ['unchanged', 'correctionText', 'correctionMissing', 'reminderText', 'reminderMissing']) {
    const raw = reachable(); let projection, armed = false, checkReads = 0, selections = 0;
    const sourceReader = ({ now }) => readRecallSource({ now, store: { readReachable: async () => structuredClone(raw) } });
    const harness = createRuntimeHarness({ sourceReader, reachableReader: async () => structuredClone(raw),
      timeProjectionProvider: async source => {
        if (!projection) { const state = source.currentState[0].situational[0]; projection = { fingerprint: 'fixed-query-time', corrections: { [`${state.stateId}|${PERSON}|${state.sourceFloorId}`]: { itemId: 'body-item', text: '原观察仍疲惫；当前推测可能恢复', sourceSignature: 'body-source' } }, reminders: [{ itemId: 'deadline-item', text: '阿裴 / 约定尚未确认完成', sourceSignature: 'deadline-source' }] }; }
        if (armed && ++checkReads === 2) {
          if (scenario === 'correctionText') Object.values(projection.corrections)[0].text += '，新观察';
          if (scenario === 'correctionMissing') projection.corrections = {};
          if (scenario === 'reminderText') projection.reminders[0].text += '，改期';
          if (scenario === 'reminderMissing') projection.reminders = [];
          projection.fingerprint = 'changed-after-candidate';
        }
        return structuredClone(projection);
      }, selector: input => { selections += 1; return selectRecall(input); } });
    await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
    const receipt = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
    assert.equal(receipt.timeDependencies.corrections.length, 1); assert.equal(receipt.timeDependencies.reminders.length, 1);
    const old = stripSummaryWitnessesForLegacyReceipt(structuredClone(receipt)); old.schemaVersion = 13; delete old.timeDependencies; old.stateProgressions = []; old.stages.stateProgressionCount = 0; old.receiptFingerprint = await receiptFingerprint(old);
    const historical = await projectHistoricalRecallReceipt({ ...harness.userMessage, extra: { [RECALL_RECEIPT_KEY]: old } }, { chatId: CHAT, userMessageIndex: 1 });
    assert.equal(historical.schemaVersion, 13); assert.equal(projectInlineRecallReceipt(historical).protocolRecognized, true);
    armed = true;
    const reused = await harness.runtime.intercept(harness.chat, 12000, null, 'continue');
    assert.equal(selections, 1, '冻结复用不重新选材');
    assert.equal(reused.lastRecall.status, 'ready', scenario);
    assert.equal(reused.lastRecall.reusedReceipt, true);
    assert.equal(reused.lastRecall.injectionText, receipt.injectionText, scenario);
    assert.equal(latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT), receipt.injectionText, scenario);
    assert.equal(checkReads, 1, '冻结仅核原选时间的人工操作，普通自动投影变化保原文');
    if (scenario === 'unchanged') {
      harness.runtime.invalidate('simulateReload'); harness.userMessage.extra[RECALL_RECEIPT_KEY] = old;
      armed = false;
      const restored = await harness.runtime.restorePersistedReceipt(); assert.equal(restored.lastRecall.schemaVersion, 13);
      const fresh = await harness.runtime.intercept(harness.chat, 12000, null, 'continue');
      assert.equal(fresh.lastRecall.reusedReceipt, false); assert.equal(selections, 2);
      const missing = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]); delete missing.timeDependencies; missing.receiptFingerprint = await receiptFingerprint(missing);
      harness.runtime.invalidate('simulateReload'); harness.userMessage.extra[RECALL_RECEIPT_KEY] = missing;
      const rejected = await projectHistoricalRecallReceipt(harness.userMessage, { chatId: CHAT, userMessageIndex: 1 }); assert.equal(rejected, null);
      await harness.runtime.intercept(harness.chat, 12000, null, 'continue'); assert.equal(selections, 3);
    }
  }
});

test('签名时间校正首次提交后，同 user 的 CSE 后台推进仍完整复用原文', async () => {
  const raw = reachable(); let selections = 0;
  const sourceReader = ({ now }) => readRecallSource({ now, store: { readReachable: async () => structuredClone(raw) } });
  const harness = createRuntimeHarness({ sourceReader, reachableReader: async () => structuredClone(raw),
    timeProjectionProvider: async source => {
      const state = source.currentState[0].situational[0];
      return { fingerprint: 'fixed-time-reference', corrections: { [`${state.stateId}|${PERSON}|${state.sourceFloorId}`]: { text: '原观察仍疲惫；当前推测可能恢复', itemId: 'time-item' } }, reminders: [] };
    }, selector: input => { selections += 1; return selectRecall(input); } });
  const initial = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const receipt = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
  assert.equal(initial.lastRecall.status, 'ready');
  assert.equal(receipt.selectedStates[0].text, '始终记得雨夜承诺');
  assert.match(receipt.injectionText, /\[时间校正\].*当前推测可能恢复/u);
  const projected = projectInlineRecallReceipt(receipt);
  assert.equal(projected.timeReferenceItems.length, 1);
  assert.equal(projected.timeReferenceItems[0], receipt.injectionText.split('\n').find(line => line.startsWith('- [时间校正] ')).slice(2));
  const reused = await harness.runtime.intercept(harness.chat, 12000, null, 'continue');
  assert.equal(reused.lastRecall.reusedReceipt, true); assert.equal(selections, 1);
  raw.stateDeltas[0].subjectSnapshots[0].situational[0].text = '原CSE真实变更';
  const changed = await harness.runtime.intercept(harness.chat, 12000, null, 'continue');
  assert.equal(changed.lastRecall.reusedReceipt, true); assert.equal(selections, 1);
  assert.equal(changed.lastRecall.injectionText, receipt.injectionText);
});

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
  assert.equal(harness.runtime.getPromptSnapshot(), null);
  let state = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(state.lastRecall.status, 'ready');
  assert.equal(state.lastPrequel.status, 'ready');
  assert.ok(latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT));
  assert.ok(latestPromptValue(harness.prompts, PREQUEL_PROMPT_SLOT));
  assert.deepEqual(harness.runtime.getPromptSnapshot(), {
    chatId: CHAT,
    hostChatId: 'host-chat-a',
    recall: { text: latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT) },
    prequel: { text: latestPromptValue(harness.prompts, PREQUEL_PROMPT_SLOT) },
  });
  assert.equal(selectorInput.reservedCharacters, state.lastPrequel.estimatedCharacters);
  assert.equal(selectorInput.reservedTokens, state.lastPrequel.estimatedTokens);
  const budget = recallBudget(12000);
  assert.ok(state.lastRecall.injectionText.length + state.lastPrequel.estimatedCharacters <= budget.totalCharacters);
  assert.ok(estimateRecallTokens(state.lastRecall.injectionText) + state.lastPrequel.estimatedTokens <= budget.totalTokens);
  assert.equal(state.lastRecall.stages.estimatedTokenBudget, budget.totalTokens - state.lastPrequel.estimatedTokens);

  harness.handlers.get('generation-stopped')();
  assert.equal(latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT), '');
  assert.equal(latestPromptValue(harness.prompts, PREQUEL_PROMPT_SLOT), '');
  assert.equal(harness.runtime.getPromptSnapshot(), null);

  await harness.runtime.setEnabled(true);
  state = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(state.lastRecall.status, 'ready');
  assert.ok(latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT));
  assert.ok(latestPromptValue(harness.prompts, PREQUEL_PROMPT_SLOT));
  await harness.runtime.setEnabled(false);
  assert.equal(latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT), '');
  assert.equal(latestPromptValue(harness.prompts, PREQUEL_PROMPT_SLOT), '');
  assert.equal(harness.runtime.getPromptSnapshot(), null);
});

test('prompt 快照在选材完成前为空，生成结束后保留最近轮且下一轮与失效会清除', async () => {
  let release;
  const selection = new Promise(resolve => { release = resolve; });
  const harness = createRuntimeHarness({ prequel: '当前前情材料。', selector: () => selection });
  harness.handlers.get('generation-started')('normal');
  const pending = harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.runtime.getPromptSnapshot(), null, '选材未完成时没有已注册材料');
  release(selectRecall({ source: harness.source, queryContext: buildRecallQueryContext({ coreChat: harness.chat, assistantTurns: 1 }), contextSize: 12000 }));
  await pending;
  assert.equal(harness.runtime.getPromptSnapshot()?.recall.text, latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT));
  const prepared = harness.runtime.getPromptSnapshot();
  harness.handlers.get('generation-ended')();
  assert.deepEqual(harness.runtime.getPromptSnapshot(), prepared, '正常结束只清宿主槽，保留最近一次准备材料');

  const next = harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(harness.runtime.getPromptSnapshot(), null, '下一轮开始立刻清除上一轮材料');
  await next;
  assert.ok(harness.runtime.getPromptSnapshot());
  harness.runtime.invalidate('chatChanged');
  assert.equal(harness.runtime.getPromptSnapshot(), null);
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
  assert.ok(state.lastRecall.stages);
  assert.equal(state.lastRecall.selectionStatus, 'completed');
  assert.equal(state.lastRecall.attemptDiagnostics.length, 1);
  assert.equal(state.lastPrequel, null);
  assert.equal(abortCalls, 1);
  assert.equal(latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT), '');
  assert.equal(latestPromptValue(harness.prompts, PREQUEL_PROMPT_SLOT), '');
});

test('宿主清槽抛错时仍先清除旧 prompt 快照', async () => {
  const harness = createRuntimeHarness({ prequel: '旧轮前情。' });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.ok(harness.runtime.getPromptSnapshot());
  harness.context.setExtensionPrompt = () => { throw Object.assign(new Error('模拟宿主清槽失败'), { code: 'TEST_CLEAR_FAILED' }); };
  harness.runtime.invalidate('chatChanged');
  assert.equal(harness.runtime.getPromptSnapshot(), null);
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
  assert.deepEqual(notifications, []);
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
  assert.equal(selectorCalls, 1);
  assert.equal(harness.prompts.filter(call => call[0] === PREQUEL_PROMPT_SLOT && call[1]).length, 2);
  assert.equal(abortCalls, 1);
  assert.equal(result.lastRecall.status, 'error');
  assert.equal(result.lastPrequel, null);
  assert.equal(latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT), '');
  assert.equal(latestPromptValue(harness.prompts, PREQUEL_PROMPT_SLOT), '');
});

test('coreChat clone 只控制严格正文去重；近期原文基座按宿主当前可见楼计算', async () => {
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
  assert.deepEqual(hiddenMatch.recentBodyFloorIds, ['floor-2'], '近期候选基座来自宿主当前可见楼，而非 core clone 的隐藏标记');
  assert.doesNotMatch(hiddenResult.lastRecall.injectionText, /钟楼留下约定|钟楼等到天亮/);

  const duplicateSource = await runtimeSourceWithBodyRef();
  let duplicateMatch = null;
  const duplicate = createRuntimeHarness({ sourceReader: async () => structuredClone(duplicateSource), reachableReader: async () => rawReachableFromSource(duplicateSource), selector: input => { duplicateMatch = input.source.bodyMatch; return selectRecall(input); } });
  duplicate.chat.splice(1, 0, { is_user: false, is_system: false, mes: '街上已经安静。' });
  const duplicateResult = await duplicate.runtime.intercept([structuredClone(duplicate.chat[1]), duplicate.userMessage], 12000, null, 'normal');
  assert.deepEqual(duplicateMatch.coveredFloorIds, [], 'clone 新未提取 AI 与旧楼同文时不得猜成旧楼');
  assert.doesNotMatch(duplicateResult.lastRecall.injectionText, /钟楼留下约定|钟楼等到天亮/,
    'strict 正文匹配虽未成立，已在近期基座内的旧楼仍按候选资格排除');

  const swipeSource = await runtimeSourceWithBodyRef('街上已经安静。', { messageIndex: 0, swipeId: 0, selectedSwipeIndex: 0 });
  let swipeMatch = null;
  const swipe = createRuntimeHarness({ sourceReader: async () => structuredClone(swipeSource), reachableReader: async () => rawReachableFromSource(swipeSource), selector: input => { swipeMatch = input.source.bodyMatch; return selectRecall(input); } });
  swipe.chat[0] = { ...swipe.chat[0], swipes: ['街上已经安静。'], swipe_id: 0 };
  const regexCore = structuredClone(swipe.chat); regexCore[0].mes = '街上安静。';
  const swipeResult = await swipe.runtime.intercept(regexCore, 12000, null, 'normal');
  assert.deepEqual(swipeMatch.coveredFloorIds, [], 'core mes 已被改写时不得被残留 swipes 冒充完整正文');
  assert.doesNotMatch(swipeResult.lastRecall.injectionText, /钟楼留下约定|钟楼等到天亮/);

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
  assert.doesNotMatch(wrappedResult.lastRecall.injectionText, /钟楼留下约定|钟楼等到天亮/);
  await wrapped.runtime.intercept([structuredClone(wrapped.userMessage)], 12000, null, 'regenerate');
  assert.equal(wrappedSelectorCalls, 1, '同 user 的查询上下文变化仍完整复用首次结果');
});

test('同 user 的 core 去重集合变化不改写首次冻结回执', async () => {
  const source = await runtimeSourceWithBodyRef();
  let selectorCalls = 0;
  const harness = createRuntimeHarness({ sourceReader: async () => structuredClone(source), reachableReader: async () => rawReachableFromSource(source), selector: input => { selectorCalls += 1; return selectRecall(input); } });
  await harness.runtime.intercept(structuredClone(harness.chat), 12000, null, 'normal');
  const first = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
  assert.equal(first.schemaVersion, RECALL_RECEIPT_SCHEMA_VERSION);
  assert.equal(first.completionStatus, 'ready');
  await harness.runtime.intercept([structuredClone(harness.userMessage)], 12000, null, 'regenerate');
  const second = harness.userMessage.extra[RECALL_RECEIPT_KEY];
  assert.equal(selectorCalls, 1);
  assert.equal(second.bodyMatchFingerprint, first.bodyMatchFingerprint);
  assert.equal(second.receiptFingerprint, first.receiptFingerprint);
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

test('同 user 首次空回执冻结后，宿主楼可见性后台变化仍不重选', async () => {
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
  assert.equal(result.lastRecall.reusedReceipt, true);
  assert.equal(result.lastRecall.status, 'empty');
  assert.equal(hiddenReceipt.bodyMatchFingerprint, visibleReceipt.bodyMatchFingerprint);

  harness.chat[0].is_hidden = false;
  harness.handlers.get('message-edited')(harness.chat.length);
  result = await harness.runtime.intercept([structuredClone(harness.userMessage)], 12000, null, 'regenerate');
  assert.equal(result.lastRecall.reusedReceipt, true);
  assert.equal(result.lastRecall.status, 'empty');
  assert.doesNotMatch(result.lastRecall.injectionText, /钟楼/);
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].bodyMatchFingerprint, hiddenReceipt.bodyMatchFingerprint);
  assert.equal(selectorCalls, 1);
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

test('聚合摘要会守住全部成员楼，非锚点在选材中删除或提交点替换都零注入', async () => {
  const texts = ['聚合旧事的第一楼。', '聚合旧事的锚点楼。'];
  const fingerprints = await Promise.all(texts.map(fingerprintText));
  const raw = {
    status: 'ready', rootRevision: 1,
    root: { chatId: CHAT, narrativeGeneration: GEN, headCheckpointId: 'aggregate-head' },
    checkpoint: { id: 'aggregate-head' }, baseline: null,
    floors: [FLOOR1, FLOOR2].map((id, index) => ({
      id, assistantSeq: index + 1,
      hostLocator: { messageIndex: index, swipeId: null, selectedSwipeIndex: null },
      content: { rawFingerprint: fingerprints[index], canonicalFingerprint: fingerprints[index] },
    })),
    floorMemories: [{
      id: MEMORY1, floorId: FLOOR2, sourceFloorIds: [FLOOR1, FLOOR2], recordStatus: 'active',
      summary: { effectiveSource: 'ai', aiText: '裴晚生在钟楼留下旧约。' }, ...emptyMemory,
    }],
    entities: [], stateDeltas: [], currentStates: [],
  };
  for (const scenario of ['memberDeletedDuringSelection', 'memberReplacedAtCommit']) {
    let selectorFinished = false, snapshotsAfterSelection = 0;
    const harness = createRuntimeHarness({
      sourceReader: options => readRecallSource(options),
      reachableReader: async () => structuredClone(raw),
      rootReader: async () => ({ status: 'ready', revision: raw.rootRevision, data: structuredClone(raw.root) }),
      selector: input => {
        const selection = selectRecall(input);
        assert.deepEqual(selection.floors.map(value => value.floorMemoryId), [MEMORY1]);
        if (scenario === 'memberDeletedDuringSelection') Object.assign(harness.chat[0], { is_user: true, is_system: false, mes: '' });
        selectorFinished = true;
        return selection;
      },
      snapshotHook: () => {
        if (!selectorFinished || scenario !== 'memberReplacedAtCommit') return;
        snapshotsAfterSelection += 1;
        if (snapshotsAfterSelection === 2) harness.chat[0] = structuredClone(harness.chat[0]);
      },
    });
    harness.chat.splice(0, harness.chat.length,
      { is_user: false, is_system: false, is_hidden: true, mes: texts[0], extra: { qianqianjie_floor: { schemaVersion: 1, chatId: CHAT, floorId: FLOOR1 } } },
      { is_user: false, is_system: false, is_hidden: true, mes: texts[1], extra: { qianqianjie_floor: { schemaVersion: 1, chatId: CHAT, floorId: FLOOR2 } } },
      harness.userMessage,
    );
    const result = await harness.runtime.intercept([structuredClone(harness.userMessage)], 12000, null, 'normal');
    assert.equal(result.lastRecall.status, 'stale', scenario);
    assert.deepEqual(result.lastRecall.skipReasons, ['selectedRefsChanged'], scenario);
    assert.ok(harness.prompts.every(call => call[1] === ''), scenario);
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

test('已验证召回来源正常使用，quiet 不读来源且后续同 user normal 冻结复用', async () => {
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
  assert.equal(sourceReads, 2);
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

test('runtime normal 先完成一次 prompt commit，再后台保存一次 schema17 completed user 收据', async () => {
  let selectorCalls = 0;
  let completeSave;
  const harness = createRuntimeHarness({ selector: input => { selectorCalls += 1; return selectRecall(input); },
    saveChat: () => new Promise(resolve => { completeSave = resolve; }) });
  let abortCalls = 0;
  const result = await harness.runtime.intercept(harness.chat, 12000, () => { abortCalls += 1; }, 'normal');
  assert.equal(selectorCalls, 1);
  assert.equal(abortCalls, 0, '召回不得调用宿主 abort');
  assert.equal(harness.prompts[0][0], RECALL_PROMPT_SLOT);
  assert.equal(harness.prompts[0][1], '', '每次生成先清旧槽位');
  const injection = harness.prompts.find(call => call[1]);
  assert.ok(injection, '必须实际注入非空召回文本');
  assert.deepEqual(injection.slice(2), [23, 2, false, 47]);
  assert.match(injection[1], /<qqj_recalled_context>/);
  assert.equal(harness.saves, 1, '正常路径只在 prompt commit 后保存一次完成态回执');
  const receipt = harness.userMessage.extra?.[RECALL_RECEIPT_KEY];
  assert.equal(RECALL_RECEIPT_SCHEMA_VERSION, 18);
  assert.equal(receipt.schemaVersion, RECALL_RECEIPT_SCHEMA_VERSION);
  assert.equal(receipt.strategyVersion, RECALL_STRATEGY_VERSION);
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
  assert.equal(result.lastRecall.schemaVersion, RECALL_RECEIPT_SCHEMA_VERSION);
  assert.equal(result.lastRecall.reusedReceipt, false);
  assert.equal(result.lastRecall.receiptPersistence, 'saving');
  assert.equal(harness.runtime.getState().lastRecall.receiptSaveDiagnostic.step, 'receiptSaveWait');
  assert.equal(projectPrivateRecallDiagnostic(harness.runtime.getState(), null).receiptSaveDiagnostic.step, 'receiptSaveWait');
  completeSave();
  await flushReceiptSave();
  assert.equal(harness.runtime.getState().lastRecall.receiptPersistence, 'saveUnconfirmed');
  assert.equal(harness.runtime.getState().lastRecall.receiptSaveDiagnostic.step, 'receiptSaveReturned');
  assert.equal(result.lastRecall.stages.selected, 5);
  assert.equal(typeof result.lastRecall.timings.totalMs, 'number');
});

test('实时回执保留时间去重依据，重叠千事不再让楼内旧事按钮消失', async () => {
  const h = createRuntimeHarness({
    qianshiProgressProvider: () => ({ anchor: { narrativeGeneration: GEN, headCheckpointId: 'head' }, projectionVersion: 1,
      text: '[当前待接续]\n- 归还旧书；尚未记录完成。', eventIds: [], matterIds: ['matter-book'] }),
    timeProjectionProvider: () => ({ fingerprint: 'clock', corrections: {}, reminders: [{ itemId: 'book', text: '千事事项 / 归还旧书；刻度 / 明日归还',
      sourceSignature: 'book', qianshiRef: { matterId: 'matter-book', originEventId: 'origin-book' } }] }),
  });
  await h.runtime.intercept(h.chat, 12000, null, 'normal');
  const live = h.runtime.getState().lastRecall, saved = h.userMessage.extra[RECALL_RECEIPT_KEY];
  assert.deepEqual(live.timeDependencies, saved.timeDependencies);
  const projected = projectInlineRecallReceipt(live);
  assert.equal(projected.protocolRecognized, true); assert.equal(projected.historyGroups.length, live.selectedFloors.length);
  assert.ok(projected.historyGroups.length > 0);
});

test('人工删除只撤冻结千事对应行与关联刻度，普通召回保留且不重选；新回执不被旧标记反复撤', async () => {
  let deletions = [], selections = 0, sourceReads = 0, completeSave, saveCalls = 0;
  const h = createRuntimeHarness({ selector: input => { selections += 1; return selectRecall(input); },
    saveChat: () => ++saveCalls === 1 ? new Promise(resolve => { completeSave = resolve; }) : Promise.resolve(),
    sourceReader: async () => { sourceReads += 1; return structuredClone(h.source); },
    qianshiDeletionProvider: () => ({ chatId: CHAT, events: deletions }),
    qianshiProgressProvider: () => ({ anchor: { narrativeGeneration: GEN, headCheckpointId: 'head' }, projectionVersion: 1,
      text: `${deletions.length ? '[相关时间线]\n- 今日：保留记录' : '[相关时间线]\n- 旧日：误收录\n- 今日：保留记录'}\n\n[当前待接续]\n- 归还旧书；尚未记录完成。`,
      eventIds: deletions.length ? ['event-keep'] : ['event-delete', 'event-keep'], matterIds: ['matter-book'], deletedEvents: deletions }),
    timeProjectionProvider: () => ({ fingerprint: 'clock', corrections: {}, reminders: [{ itemId: 'book', text: '删除关联刻度', sourceSignature: 'book',
      qianshiRef: { matterId: 'matter-book', originEventId: 'event-delete' } }, { itemId: 'ordinary', text: '保留独立刻度', sourceSignature: 'ordinary' }] }),
  });
  await h.runtime.intercept(h.chat, 12000, null, 'normal');
  const original = structuredClone(h.userMessage.extra[RECALL_RECEIPT_KEY]);
  assert.match(original.injectionText, /误收录|删除关联刻度/u);
  deletions = [{ eventId: 'event-delete', matterId: 'matter-book' }];
  h.runtime.invalidate('qianshiManuallyDeleted');
  const reused = await h.runtime.intercept(h.chat, 12000, null, 'regenerate');
  assert.equal(reused.lastRecall.reusedReceipt, true); assert.equal(selections, 1); assert.equal(sourceReads, 2);
  assert.deepEqual(reused.lastRecall.selectedFloors, original.selectedFloors);
  assert.deepEqual(reused.lastRecall.selectedStates, original.selectedStates);
  assert.match(reused.lastRecall.injectionText, /保留记录|保留独立刻度/u);
  assert.doesNotMatch(reused.lastRecall.injectionText, /误收录|删除关联刻度|归还旧书/u);
  assert.deepEqual(h.userMessage.extra[RECALL_RECEIPT_KEY], original, '保留历史签名回执，只改变本次可用注入');
  const again = await h.runtime.intercept(h.chat, 12000, null, 'continue');
  assert.equal(again.lastRecall.injectionText, reused.lastRecall.injectionText); assert.equal(selections, 1);
  assert.equal(again.lastRecall.receiptPersistence, 'saving');
  const reuseWait = again.lastRecall.timings.totalMs;
  completeSave(); await flushReceiptSave();
  const settled = h.runtime.getState().lastRecall;
  assert.equal(settled.receiptPersistence, 'saveUnconfirmed');
  assert.equal(settled.timings.totalMs, reuseWait);
  assert.equal(settled.injectionText, again.lastRecall.injectionText, '旧保存只补状态，不能复活人工删除材料');
  assert.equal(h.saves, 1);
  // 新 user 首次选材已看到删除标记，后续冻结不把同一事项的新有效进展撤掉。
  h.userMessage.mes += ' 新输入'; h.source.qianshiDeletedEvents = deletions;
  await h.runtime.intercept(h.chat, 12000, null, 'normal');
  const next = h.runtime.getState().lastRecall.injectionText;
  await h.runtime.intercept(h.chat, 12000, null, 'regenerate');
  assert.equal(h.runtime.getState().lastRecall.injectionText, next);
});

test('千事当前进度计入普通召回预算并写入同一 schema15 回执与注入槽', async () => {
  let providerSource = null, providerContext = null, ordinarySelection = null;
  const harness = createRuntimeHarness({ selector: input => { ordinarySelection = selectRecall(input); return ordinarySelection; }, qianshiProgressProvider: (source, context) => { providerSource = source; providerContext = context; return ({
    anchor: { narrativeGeneration: GEN, headCheckpointId: 'head' },
    projectionVersion: 1,
    text: '[当前剧情进度]\n- [待办] 归还旧书；时间：明日：顾舟仍需归还档案室旧书',
    eventIds: ['event-qianshi-1'], matterIds: ['matter-qianshi-1'],
  }); } });
  const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.deepEqual([providerSource?.narrativeGeneration, providerSource?.headCheckpointId], [GEN, 'head']);
  assert.equal(result.lastRecall.status, 'ready');
  assert.match(result.lastRecall.injectionText, /<qqj_qianshi_progress>[\s\S]*归还旧书/u);
  const receipt = harness.userMessage.extra[RECALL_RECEIPT_KEY];
  assert.equal(receipt.schemaVersion, RECALL_RECEIPT_SCHEMA_VERSION);
  assert.equal(receipt.qianshiProgress.projectionVersion, 1);
  assert.equal(providerContext.queryContext.latestUserText, '阿裴,我们回钟楼赴约。');
  assert.deepEqual(receipt.qianshiProgress.eventIds, ['event-qianshi-1']);
  assert.equal(receipt.injectionText, latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT));
  const progressTokens = estimateRecallTokens(`\n\n<qqj_qianshi_progress>\n${receipt.qianshiProgress.text}\n</qqj_qianshi_progress>`);
  assert.equal(receipt.stages.estimatedTokenCount, estimateRecallTokens(receipt.injectionText));
  assert.equal(receipt.stages.qianshiTokenBudget, progressTokens);
  assert.equal(receipt.stages.estimatedTokenBudget, ordinarySelection.stages.estimatedTokenBudget + progressTokens);
  assert.equal(receipt.stages.estimatedTokenBudget <= 8000, true, '稀疏材料可少于上限，但不得突破原总额度');
});

test('runtime Q候选只用一次既有utility，provider初取与按所选ID复验恰各一次且同user冻结', async () => {
  const candidates = [
    qianshiCandidate('Q1', 'history', '已被R覆盖的钟楼旧日常', { assistantSeq: 49 }),
    qianshiCandidate('Q2', 'pending', '仍需归还钟楼钥匙', { assistantSeq: 50 }),
  ];
  let providerCalls = 0, utilityCalls = 0, payload = null;
  const providerContexts = [];
  const harness = createRuntimeHarness({
    useDefaultSelector: true,
    qianshiProgressProvider: (_source, context) => {
      providerCalls += 1; providerContexts.push({ queryContext: structuredClone(context.queryContext),
        ...(Object.hasOwn(context, 'selectedEventIds') ? { selectedEventIds: [...context.selectedEventIds], selectedMatterIds: [...context.selectedMatterIds],
          pendingHeader: context.pendingHeader, scopeLine: context.scopeLine } : {}) });
      const selected = Object.hasOwn(context, 'selectedEventIds');
      return { anchor: { narrativeGeneration: GEN, headCheckpointId: 'head' }, projectionVersion: QIANSHI_RECALL_PROJECTION_VERSION,
        text: selected ? `${context.scopeLine}\n\n${RECALL_KNOWLEDGE_GUIDANCE}\n\n${context.pendingHeader}\n- 仍需归还钟楼钥匙；尚未记录完成。`
          : '本轮千事资料来源截至：AI #50。\n\n[相关时间线]\n- 时间未知：已被R覆盖的钟楼旧日常\n\n[相关未完事项]\n- 仍需归还钟楼钥匙；尚未记录完成。',
        eventIds: selected ? [] : ['Q1-event'], matterIds: ['Q2-matter'],
        ...(!selected ? { candidates, currentStoryTime: '大陆历1686年9月22日 20:30' } : {}),
      };
    },
    generateUtilityTask: async options => {
      utilityCalls += 1;
      payload = JSON.parse(options.taskMessages[0].content);
      return { jsonData: { history_exclude_keys: [], state_exclude_keys: [], qianshi_exclude_keys: ['Q1'] } };
    },
  });
  const first = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(first.lastRecall.status, 'ready', JSON.stringify(first.lastRecall));
  const receipt = harness.userMessage.extra[RECALL_RECEIPT_KEY];
  assert.equal(utilityCalls, 1); assert.equal(providerCalls, 2);
  assert.equal(payload.query.currentStoryTime, '大陆历1686年9月22日 20:30', JSON.stringify({ qianshiCandidates: payload.qianshiCandidates, qianshiProgress: receipt.qianshiProgress, providerContexts }));
  assert.equal(Object.hasOwn(providerContexts[0], 'selectedEventIds'), false);
  assert.deepEqual(providerContexts[1].selectedEventIds, []);
  assert.deepEqual(providerContexts[1].selectedMatterIds, ['Q2-matter']);
  assert.equal(providerContexts[1].pendingHeader, '[相关跟进事项]', '新生成回执使用跟进事项背景标题');
  assert.equal(providerContexts[1].scopeLine, '本轮千事资料来源截至：AI #50。', '选中复验保留该回执的实际来源截止');
  assert.match(receipt.injectionText, /<qqj_recalled_context>/u);
  assert.match(receipt.injectionText, /仍需归还钟楼钥匙/u);
  assert.ok(receipt.qianshiProgress.text.startsWith(`本轮千事资料来源截至：AI #50。\n\n${RECALL_KNOWLEDGE_GUIDANCE}\n\n[相关跟进事项]`));
  assert.doesNotMatch(receipt.injectionText, /已被R覆盖的钟楼旧日常/u);
  assert.deepEqual(receipt.qianshiProgress.matterIds, ['Q2-matter']);

  const original = receipt.injectionText;
  const rerolled = await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(rerolled.lastRecall.reusedReceipt, true);
  assert.equal(rerolled.lastRecall.injectionText, original);
  assert.equal(utilityCalls, 1); assert.equal(providerCalls, 2, '同user重roll不得再读provider或重选');
});

test('同一资料的旧千事标题在正式runtime提交复验中保持原签名文本', async () => {
  const oldText = '[相关时间线]\n- 来源 AI #50：仍在处理钥匙交付\n\n[当前待接续]\n- 交回钟楼钥匙；尚未记录完成。';
  const contexts = [];
  const harness = createRuntimeHarness({
    selector: input => ({ ...selectRecall(input), qianshiProgress: input.source.qianshiProgress, skipReasons: ['existingSkip'] }),
    qianshiProgressProvider: (_source, context) => {
      contexts.push(context);
      const selected = Object.hasOwn(context, 'selectedEventIds');
      return { anchor: { narrativeGeneration: GEN, headCheckpointId: 'head' }, projectionVersion: 5,
        text: selected ? `[相关时间线]\n- 来源 AI #50：仍在处理钥匙交付\n\n${context.pendingHeader}\n- 交回钟楼钥匙；尚未记录完成。` : oldText,
        eventIds: ['event-key'], matterIds: ['matter-key'] };
    },
  });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const receipt = harness.userMessage.extra[RECALL_RECEIPT_KEY];
  assert.equal(contexts.length, 2);
  assert.equal(contexts[1].pendingHeader, '[当前待接续]');
  assert.equal(contexts[1].scopeLine, '');
  assert.equal(receipt.qianshiProgress.text, oldText);
  assert.match(receipt.injectionText, /<qqj_qianshi_progress>[\s\S]*\[当前待接续\][\s\S]*交回钟楼钥匙/u);
  assert.deepEqual(receipt.skipReasons, ['existingSkip'], '相同资料时不丢弃或新增千事跳过原因');
});

test('no-current已完成背景事实经正式provider、utility与回执复用后不误注未完成', async () => {
  const qFloor = { id: FLOOR1, chatId: CHAT, narrativeGeneration: GEN, assistantSeq: 1, hostLocator: { messageIndex: 2 },
    content: { canonicalContent: '中性钟楼赴约背景动作已完成' } };
  const qDelta = structuredClone(await compileQianshiDelta({ floor: qFloor, now: NOW, packet: { qianshi: { events: [
    { key: 'done-background', title: '钟楼赴约背景动作', description: '这条中性背景动作已经完成', status: 'inProgress', actionStatus: 'completed', matter: false },
  ], order: [] } } }));
  const qEvent = qDelta.events[0];
  qEvent.matterId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  qEvent.updatesMatter = false;
  const qReachable = { root: { chatId: CHAT, narrativeGeneration: GEN, headCheckpointId: 'qianshi-head' }, rootRevision: 1,
    floors: [qFloor], floorMemories: [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', floorId: qFloor.id, recordStatus: 'active', chronology: [], qianshiDelta: qDelta }], entities: [] };
  let providerCalls = 0, utilityCalls = 0, actualPayload = null;
  const harness = createRuntimeHarness({
    useDefaultSelector: true,
    qianshiProgressProvider: (_source, context) => {
      providerCalls += 1;
      const anchor = { narrativeGeneration: GEN, headCheckpointId: 'head' };
      if (Object.hasOwn(context, 'selectedEventIds')) {
        const recall = projectQianshiRecall(qReachable, { selectedEventIds: context.selectedEventIds, selectedMatterIds: context.selectedMatterIds });
        return { anchor, projectionVersion: QIANSHI_RECALL_PROJECTION_VERSION, ...recall };
      }
      const prepared = prepareQianshiRecallCandidates(qReachable, { queryContext: context.queryContext });
      return { anchor, projectionVersion: QIANSHI_RECALL_PROJECTION_VERSION, ...projectQianshiCandidateSelection(prepared.candidates), candidates: prepared.candidates };
    },
    generateUtilityTask: async options => {
      utilityCalls += 1;
      actualPayload = JSON.parse(options.taskMessages[0].content);
      return { jsonData: { history_exclude_keys: [], state_exclude_keys: [], qianshi_exclude_keys: [] } };
    },
  });
  harness.userMessage.mes = '阿裴，我们回钟楼赴约。';
  const first = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const receipt = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
  assert.equal(first.lastRecall.status, 'ready', JSON.stringify(first.lastRecall));
  assert.equal(providerCalls, 2, '正式provider先给候选，再按实际选中ID复验最终文本');
  assert.equal(utilityCalls, 1, '真实候选事实只交给一次本地固定utility');
  const qFact = actualPayload.qianshiCandidates.find(candidate => candidate.fact.title === '钟楼赴约背景动作')?.fact;
  assert.ok(qFact);
  assert.equal(Object.hasOwn(qFact, 'status'), false, 'utility收到的no-current事实没有伪整线状态');
  assert.equal(qFact.events[0].actionStatus, 'completed');
  assert.match(receipt.qianshiProgress.text, /钟楼赴约背景动作/u);
  assert.doesNotMatch(receipt.qianshiProgress.text, /此后尚未记录完成/u);
  assert.doesNotMatch(receipt.injectionText, /此后尚未记录完成/u);
  assert.match(receipt.qianshiProgress.text, /本轮千事资料来源截至：AI #1。/u, '仅Q候选的正常runtime入口也保留实际来源截止');
  assert.equal(receipt.qianshiProgress.projectionVersion, QIANSHI_RECALL_PROJECTION_VERSION);
  assert.match(first.lastRecall.injectionText, /钟楼赴约背景动作/u);

  harness.runtime.invalidate('read-back-saved-receipt');
  const restored = await harness.runtime.restorePersistedReceipt();
  assert.equal(restored.lastRecall.restoredReceipt, true, '模拟宿主extra中的schema18回执可读回');
  assert.equal(restored.lastRecall.injectionText, receipt.injectionText);
  const reused = await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(reused.lastRecall.reusedReceipt, true);
  assert.equal(reused.lastRecall.injectionText, receipt.injectionText);
  assert.equal(providerCalls, 2, '同user回执复用不重读provider');
  assert.equal(utilityCalls, 1, '同user回执复用不重跑utility');
});

test('候选与Q正文共用既有anchor守卫，选中事项提交前终态只撤Q而保留普通召回', async () => {
  for (const mode of ['wrong-anchor', 'selected-terminal']) {
    let providerCalls = 0, payload = null;
    const candidate = qianshiCandidate('Q1', 'pending', '仍待完成的旧约');
    const harness = createRuntimeHarness({
      useDefaultSelector: true,
      qianshiProgressProvider: (_source, context) => {
        providerCalls += 1;
        const selected = Object.hasOwn(context, 'selectedMatterIds');
        if (mode === 'wrong-anchor') return { anchor: { narrativeGeneration: 'wrong', headCheckpointId: 'wrong' }, projectionVersion: 4,
          text: '[当前待接续]\n- 不应越过anchor；尚未记录完成。', eventIds: [], matterIds: ['Q1-matter'], candidates: [candidate] };
        return { anchor: { narrativeGeneration: GEN, headCheckpointId: 'head' }, projectionVersion: 5,
          text: selected ? '' : '[当前待接续]\n- 仍待完成的旧约；尚未记录完成。', eventIds: [], matterIds: selected ? [] : ['Q1-matter'],
          ...(!selected ? { candidates: [candidate] } : {}) };
      },
      generateUtilityTask: async options => {
        payload = JSON.parse(options.taskMessages[0].content);
        return { jsonData: { history_exclude_keys: [], state_exclude_keys: [], qianshi_exclude_keys: [] } };
      },
    });
    const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
    const receipt = harness.userMessage.extra[RECALL_RECEIPT_KEY];
    assert.equal(providerCalls, 2);
    assert.match(result.lastRecall.injectionText, /<qqj_recalled_context>/u, mode);
    assert.equal(receipt.qianshiProgress, null, mode);
    assert.doesNotMatch(receipt.injectionText, /qqj_qianshi_progress|仍待完成的旧约|不应越过anchor/u, mode);
    if (mode === 'wrong-anchor') assert.deepEqual(payload.qianshiCandidates, []);
    else assert.equal(receipt.skipReasons.includes('optionalQianshiChanged'), true);
  }
});

test('只有实际选入的关联刻度合并当前待接续，历史链与未关联事项保留且楼内展示等于实注入', async () => {
  const qianshi = { anchor:{narrativeGeneration:GEN,headCheckpointId:'head'}, projectionVersion:2,
    text:'[相关时间线]\n- 9月1日：答应归还旧书\n- 9月2日：从书架取下旧书\n\n[当前待接续]\n- 从书架取下旧书；约定：9月3日；尚未记录完成。\n- 前往钟楼；尚未记录完成。',
    eventIds:['event-origin','event-progress'],matterIds:['matter-book','matter-tower'] };
  const time = {fingerprint:'time-1',corrections:{},reminders:[{itemId:'deadline-book',text:'千事事项 / 归还旧书；当前进展：从书架取下旧书；刻度 / 阿裴 / 明日归还',sourceSignature:'book-current',
    qianshiRef:{matterId:'matter-book',originEventId:'event-origin'}}]};
  const harness=createRuntimeHarness({timeProjectionProvider:async()=>structuredClone(time),qianshiProgressProvider:()=>structuredClone(qianshi)});
  const result=await harness.runtime.intercept(harness.chat,12000,null,'normal'), receipt=harness.userMessage.extra[RECALL_RECEIPT_KEY];
  assert.equal(receipt.timeDependencies.reminders.length,1); assert.deepEqual(receipt.timeDependencies.reminders[0].qianshiRef,time.reminders[0].qianshiRef);
  assert.match(result.lastRecall.injectionText,/千事事项 \/ 归还旧书/u);
  assert.match(result.lastRecall.injectionText,/9月1日：答应归还旧书[\s\S]*9月2日：从书架取下旧书/u,'历史起因和进展不因当前提醒合并而删除');
  assert.doesNotMatch(renderedQianshiProgressText(receipt.qianshiProgress,receipt.timeDependencies),/^- 从书架取下旧书；约定/mu);
  assert.match(renderedQianshiProgressText(receipt.qianshiProgress,receipt.timeDependencies),/^- 前往钟楼；尚未记录完成。/mu);
  const inline=projectInlineRecallReceipt({...receipt,status:'ready'});
  assert.equal(inline.qianshiProgressText,renderedQianshiProgressText(receipt.qianshiProgress,receipt.timeDependencies));
  assert.equal(receipt.stages.estimatedTokenCount,estimateRecallTokens(receipt.injectionText));
});

test('新旧未完事项标题都参与时间提醒抑制和删除后重投影', async () => {
  const timeDependencies = { reminders: [{ qianshiRef: { matterId: 'matter-book' } }] };
  const scope = '本轮千事资料来源截至：AI #50。';
  const oldText = '[相关时间线]\n- 起因：答应归还旧书\n\n[当前待接续]\n- 归还旧书；尚未记录完成。\n- 去钟楼；尚未记录完成。';
  const currentText = oldText.replace('[当前待接续]', '[相关未完事项]');
  const receipt = { text: currentText, matterIds: ['matter-book', 'matter-tower'] };
  const rendered = renderedQianshiProgressText(receipt, timeDependencies);
  assert.match(rendered, /\[相关时间线\][\s\S]*起因：答应归还旧书/u);
  assert.doesNotMatch(rendered, /\[相关未完事项\][^\n]*\n- 归还旧书/u, '新标题仍按事项 ID 隐藏已由关联刻度覆盖的行');
  assert.match(rendered, /\[相关未完事项\][\s\S]*去钟楼；尚未记录完成/u);
  assert.match(renderedQianshiProgressText({ ...receipt, text: oldText }, timeDependencies), /\[当前待接续\]/u,
    '保留历史旧标题回执的时间提醒处理');
  assert.equal(renderedQianshiProgressText({ text: '本轮千事资料来源截至：AI #50。\n\n[相关未完事项]\n- 归还旧书；尚未记录完成。', matterIds: ['matter-book'] }, timeDependencies), '',
    '唯一未完事项被对应提醒替代后不单独留下截止提示');

  let deleted = [];
  const qianshi = { anchor: { narrativeGeneration: GEN, headCheckpointId: 'head' }, projectionVersion: 5,
    text: `${scope}\n\n[相关时间线]\n- 起因：答应归还旧书\n\n[相关未完事项]\n- 归还旧书；尚未记录完成。\n- 去钟楼；尚未记录完成。`,
    eventIds: ['event-book'], matterIds: ['matter-book', 'matter-tower'], deletedEvents: deleted };
  const harness = createRuntimeHarness({
    qianshiProgressProvider: () => ({ ...structuredClone(qianshi), deletedEvents: structuredClone(deleted) }),
    qianshiDeletionProvider: () => ({ chatId: CHAT, events: structuredClone(deleted) }),
  });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.match(harness.userMessage.extra[RECALL_RECEIPT_KEY].injectionText, /\[相关未完事项\][\s\S]*去钟楼/u);
  deleted = [{ eventId: 'event-book', matterId: 'matter-book' }];
  harness.runtime.invalidate('qianshiManuallyDeleted');
  const reused = await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.doesNotMatch(reused.lastRecall.injectionText, /答应归还旧书|归还旧书/u);
  assert.match(reused.lastRecall.injectionText, /\[相关未完事项\][\s\S]*去钟楼；尚未记录完成/u,
    '删除旧事项只撤它对应的行，保留新标题下其他冻结事项');
  assert.match(reused.lastRecall.injectionText, /本轮千事资料来源截至：AI #50。/u,
    '删除其中一条后，仍有内容的千事块保留其来源范围');

  let allDeleted = [];
  const allDeletedQianshi = { ...qianshi, text: `${scope}\n\n[相关时间线]\n- 来源：旧书交付\n\n[相关未完事项]\n- 归还旧书；尚未记录完成。`,
    eventIds: ['event-book'], matterIds: ['matter-book'] };
  const allDeletedHarness = createRuntimeHarness({
    qianshiProgressProvider: () => ({ ...structuredClone(allDeletedQianshi), deletedEvents: structuredClone(allDeleted) }),
    qianshiDeletionProvider: () => ({ chatId: CHAT, events: structuredClone(allDeleted) }),
  });
  await allDeletedHarness.runtime.intercept(allDeletedHarness.chat, 12000, null, 'normal');
  allDeleted = [{ eventId: 'event-book', matterId: 'matter-book' }];
  allDeletedHarness.runtime.invalidate('qianshiManuallyDeleted');
  const deletedResult = await allDeletedHarness.runtime.intercept(allDeletedHarness.chat, 12000, null, 'regenerate');
  const allDeletedReceipt = allDeletedHarness.userMessage.extra[RECALL_RECEIPT_KEY];
  assert.doesNotMatch(deletedResult.lastRecall.injectionText, /本轮千事资料来源截至/u, '全部千事行删除后不保留单独的范围行');
  assert.match(allDeletedReceipt.qianshiProgress.text, /本轮千事资料来源截至/u, '只读删除后的当次投影不改写既有冻结回执');
});

test('关联刻度未进预算时不提前删除千事当前提醒', async () => {
  const qianshi={anchor:{narrativeGeneration:GEN,headCheckpointId:'head'},text:'[当前待接续]\n- 归还旧书；尚未记录完成。',eventIds:[],matterIds:['matter-book']};
  const time={fingerprint:'time-budget',corrections:{},reminders:[{itemId:'deadline-book',text:'预算外刻度'.repeat(10000),sourceSignature:'book-budget',qianshiRef:{matterId:'matter-book',originEventId:'event-origin'}}]};
  const harness=createRuntimeHarness({timeProjectionProvider:async()=>structuredClone(time),qianshiProgressProvider:()=>structuredClone(qianshi)});
  await harness.runtime.intercept(harness.chat,12000,null,'normal');
  const receipt=harness.userMessage.extra[RECALL_RECEIPT_KEY];
  assert.equal(receipt.timeDependencies.reminders.length,0);
  assert.match(receipt.injectionText,/\[当前待接续\][\s\S]*归还旧书；尚未记录完成/u);
});

test('提交前关联刻度失效恢复千事当前提醒，千事失效则只撤千事并保有效刻度', async () => {
  const qianshi={anchor:{narrativeGeneration:GEN,headCheckpointId:'head'},text:'[相关时间线]\n- 9月1日：答应归还旧书\n\n[当前待接续]\n- 归还旧书；尚未记录完成。',eventIds:['event-origin'],matterIds:['matter-book']};
  const reminder={itemId:'deadline-book',text:'千事事项 / 归还旧书；刻度 / 阿裴 / 明日归还',sourceSignature:'book-current',qianshiRef:{matterId:'matter-book',originEventId:'event-origin'}};
  {
    let reads=0;
    const harness=createRuntimeHarness({timeProjectionProvider:async()=>({fingerprint:`time-${++reads}`,corrections:{},reminders:reads===1?[structuredClone(reminder)]:[]}),qianshiProgressProvider:()=>structuredClone(qianshi)});
    await harness.runtime.intercept(harness.chat,12000,null,'normal');
    const receipt=harness.userMessage.extra[RECALL_RECEIPT_KEY];
    assert.equal(receipt.timeDependencies.reminders.length,0); assert.doesNotMatch(receipt.injectionText,/千事事项/u);
    assert.match(receipt.injectionText,/\[当前待接续\][\s\S]*归还旧书；尚未记录完成/u);
  }
  {
    let reads=0;
    const harness=createRuntimeHarness({timeProjectionProvider:async()=>({fingerprint:'time-stable',corrections:{},reminders:[structuredClone(reminder)]}),qianshiProgressProvider:()=>{
      reads+=1; return reads===1?structuredClone(qianshi):{...structuredClone(qianshi),text:'',eventIds:[],matterIds:[]};
    }});
    await harness.runtime.intercept(harness.chat,12000,null,'normal');
    const receipt=harness.userMessage.extra[RECALL_RECEIPT_KEY];
    assert.equal(receipt.qianshiProgress,null); assert.equal(receipt.timeDependencies.reminders.length,1);
    assert.match(receipt.injectionText,/千事事项 \/ 归还旧书/u); assert.doesNotMatch(receipt.injectionText,/qqj_qianshi_progress/u);
  }
});

test('提交前时间重格式化不重新引入独立地点标注并遵守预算', async () => {
  let reads = 0;
  const reminder = { itemId: 'return-key', type: 'deadline', text: '明天归还钥匙', rankText: '明天归还钥匙', sourceSignature: 'return-key' };
  const harness = createRuntimeHarness({ timeProjectionProvider: async () => {
    reads += 1;
    return reads === 1 ? { fingerprint: 'time-before', corrections: {}, reminders: [structuredClone(reminder)] }
      : { fingerprint: 'time-after', corrections: {}, reminders: [] };
  } });
  harness.chat.splice(0, harness.chat.length,
    { is_user: true, is_system: false, mes: '之前继续' },
    { is_user: false, is_system: false, mes: '林岚仍住在卧室。<location>东区公寓·卧室</location>' },
    harness.userMessage);
  harness.userMessage.mes = '明天归还钥匙';
  const core = structuredClone(harness.chat);
  core[1].mes = '林岚仍住在卧室。';
  const result = await harness.runtime.intercept(core, 12000, null, 'normal');
  const receipt = harness.userMessage.extra[RECALL_RECEIPT_KEY];
  assert.ok(reads >= 2, '实际提交校验发现时间投影变化并重格式化');
  assert.equal(receipt.timeDependencies.reminders.length, 0);
  assert.deepEqual(receipt.selectedLocationReferences, []);
  assert.doesNotMatch(result.lastRecall.injectionText, /东区公寓·卧室/u);
  assert.doesNotMatch(result.lastRecall.injectionText, /明天归还钥匙/u);
  assert.equal(receipt.stages.locationReferenceCount, receipt.selectedLocationReferences.length);
  assert.ok(receipt.stages.finalInjectionItemCount >= receipt.selectedLocationReferences.length);
  assert.ok(receipt.stages.estimatedTokenCount <= receipt.stages.estimatedTokenBudget);
});

test('千事总预算兼容新旧回执且不重复加，刷新只投影正确口径不改历史签名', async () => {
  const prequel = '钟楼旧约。'.repeat(400);
  const harness = createRuntimeHarness({ prequel, qianshiProgressProvider: () => ({ anchor: { narrativeGeneration: GEN, headCheckpointId: 'head' },
    text:'[当前剧情进度]\n- [待办] 归还旧书', eventIds:['event-1'], matterIds:['matter-1'] }) });
  const first = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const current = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
  const totalBudget = current.stages.estimatedTokenBudget;
  assert.equal(totalBudget + first.lastPrequel.estimatedTokens, recallBudget(12000).totalTokens, '前情仍独立占用原总额度');
  assert.equal(first.lastRecall.stages.estimatedTokenBudget, totalBudget);

  harness.runtime.invalidate('restore-current');
  let restored = await harness.runtime.restorePersistedReceipt();
  assert.equal(restored.lastRecall.stages.estimatedTokenBudget, totalBudget, '已修回执不得重复加千事额度');

  const legacy = structuredClone(current);
  legacy.stages.estimatedTokenBudget -= legacy.stages.qianshiTokenBudget;
  delete legacy.stages.qianshiTokenBudget;
  legacy.receiptFingerprint = await receiptFingerprint(legacy);
  harness.userMessage.extra[RECALL_RECEIPT_KEY] = legacy;
  harness.runtime.invalidate('restore-legacy');
  restored = await harness.runtime.restorePersistedReceipt();
  assert.equal(restored.lastRecall.restoredReceipt, true);
  assert.equal(restored.lastRecall.stages.estimatedTokenCount, legacy.stages.estimatedTokenCount);
  assert.equal(restored.lastRecall.stages.estimatedTokenBudget, totalBudget, '旧回执只读显示补齐千事额度');
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].stages.qianshiTokenBudget, undefined, '不得重写历史存档');
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].receiptFingerprint, legacy.receiptFingerprint, '不得改历史签名');
});

test('提交前千事进度变化只撤千事块，普通召回材料与本轮生成继续保留', async () => {
  let reads = 0; const queries = [];
  const harness = createRuntimeHarness({ qianshiProgressProvider: (_source, context) => {
    reads += 1;
    queries.push(structuredClone(context.queryContext));
    return { anchor: { narrativeGeneration: GEN, headCheckpointId: 'head' },
      text: reads === 1 ? '[当前剧情进度]\n- [待办] 归还旧书' : '', eventIds: reads === 1 ? ['event-1'] : [], matterIds: reads === 1 ? ['matter-1'] : [] };
  } });
  const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(reads, 2); assert.equal(result.lastRecall.status, 'ready');
  assert.match(result.lastRecall.injectionText, /<qqj_recalled_context>/u);
  assert.doesNotMatch(result.lastRecall.injectionText, /qqj_qianshi_progress|归还旧书/u);
  const receipt = harness.userMessage.extra[RECALL_RECEIPT_KEY];
  assert.equal(receipt.qianshiProgress, null);
  assert.equal(Object.hasOwn(receipt.stages, 'qianshiTokenBudget'), false);
  assert.equal(receipt.stages.estimatedTokenCount, estimateRecallTokens(receipt.injectionText));
  assert.equal(receipt.skipReasons.includes('optionalQianshiChanged'), true);
  assert.deepEqual(queries[1], queries[0], '提交复验必须使用初选同一轮 queryContext');
});

test('千事 projection 版本变化时同 user 仍逐字复用首次大清单', async () => {
  let version = 0, selections = 0;
  const harness = createRuntimeHarness({ selector: input => { selections += 1; return selectRecall(input); }, qianshiProgressProvider: () => ({
    anchor: { narrativeGeneration: GEN, headCheckpointId: 'head' }, projectionVersion: version,
    text: version === 0 ? '[当前剧情进度]\n- [待办] 旧大清单' : '[相关时间线]\n- 10月4日：新短版',
    eventIds: [`event-${version}`], matterIds: [`matter-${version}`],
  }) });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const original = harness.userMessage.extra[RECALL_RECEIPT_KEY].injectionText;
  assert.match(original, /旧大清单/u);
  version = 1;
  const reused = await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(selections, 1);
  assert.equal(reused.lastRecall.reusedReceipt, true, JSON.stringify(reused.lastRecall));
  assert.equal(reused.lastRecall.injectionText, original);
  assert.equal(latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT), original);
  assert.match(reused.lastRecall.injectionText, /旧大清单|qqj_qianshi_progress/u);
  assert.doesNotMatch(reused.lastRecall.injectionText, /新短版/u);
});

test('复用回执时千事变化不读取 provider、不重跑选材并保留首次完整块', async () => {
  let activeProgress = true, selections = 0;
  const harness = createRuntimeHarness({
    selector: input => { selections += 1; return selectRecall(input); },
    qianshiProgressProvider: () => ({ projectionVersion: QIANSHI_RECALL_PROJECTION_VERSION, anchor: { narrativeGeneration: GEN, headCheckpointId: 'head' },
      text: activeProgress ? '[当前剧情进度]\n- [待办] 归还旧书' : '', eventIds: activeProgress ? ['event-1'] : [], matterIds: activeProgress ? ['matter-1'] : [] }),
  });
  const first = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const original = first.lastRecall.injectionText;
  assert.equal(first.lastRecall.status, 'ready'); assert.equal(selections, 1);
  activeProgress = false;
  const reused = await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(selections, 1, '千事变化不得触发普通 selector 或额外 selector API');
  assert.equal(reused.lastRecall.status, 'ready'); assert.equal(reused.lastRecall.reusedReceipt, true);
  assert.equal(reused.lastRecall.injectionText, original);
  assert.match(reused.lastRecall.injectionText, /qqj_qianshi_progress|归还旧书/u);
});

test('摘要已齐但CSE欠尾时真实delta的私密移除跨 source/selector/schema15 保存恢复复用，delta变化后重选', async () => {
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
  assert.equal(receipt.schemaVersion, RECALL_RECEIPT_SCHEMA_VERSION);
  assert.equal(receipt.selectedStates.length, 0, '第二楼固定移除后，现存楼汇总确实为空');
  const removed = receipt.selectedCseChanges.find(value => value.action === 'remove');
  assert.ok(removed);
  assert.equal(removed.deltaId, 'delta-remove');
  assert.equal(removed.before.text, '仍在钟楼等待赴约');
  assert.equal(removed.before.toward, '林岚', '真实 runtime 保存所选变化侧的对象显示名');
  assert.equal(removed.before.visibility, 'private');
  assert.deepEqual({ stateId: removed.before.stateId, sourceFloorId: removed.before.sourceFloorId, sourceDeltaId: removed.before.sourceDeltaId }, {
    stateId: 'cse-state-private', sourceFloorId: 'cse-floor-1', sourceDeltaId: 'delta-add',
  });
  assert.ok(removed.before.reason.length > 1000, '合法长 reason 必须能进入自生成回执');
  assert.equal(removed.after, null);
  assert.match(receipt.injectionText, /\[来源 AI #2\][\s\S]*- \[变化\]/);
  assert.match(receipt.injectionText, /当时移除；之前 可见性：私密/);
  assert.doesNotMatch(receipt.injectionText, /“之前”只是被移除的旧状态，不是当前状态/);
  const inline = projectInlineRecallReceipt(receipt);
  assert.equal(inline.protocolRecognized, true);
  assert.ok(inline.historyItems.length > 0, '含CSE变化的剧情线协议仍须保留历史材料投影');
  assert.equal(inline.cseChangeItems.find(value => value.action === 'remove')?.before?.text, '仍在钟楼等待赴约');
  assert.equal(inline.cseChangeItems.find(value => value.action === 'remove')?.before?.toward, '林岚', '历史 reader 与楼内投影保留对象名');

  harness.runtime.invalidate('simulateReload');
  const restored = await harness.runtime.restorePersistedReceipt();
  assert.equal(restored.lastRecall.restoredReceipt, true);
  assert.equal(restored.lastRecall.selectedCseChanges.find(value => value.action === 'remove')?.before.reason, removed.before.reason);
  const reused = await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(reused.lastRecall.reusedReceipt, true);
  assert.equal(selectorCalls, 1, '来源未变时 schema15 回执应直接复用');

  reachable = cseLaggingReachable('delta-remove-new');
  const refreshed = await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(refreshed.lastRecall.reusedReceipt, true);
  assert.equal(selectorCalls, 1, '同 user 的 delta 后台推进不改写首次召回');
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].selectedCseChanges.find(value => value.action === 'remove')?.deltaId, 'delta-remove');
});

test('runtime 默认异步入口调用摘要路由，成功排除写入 schema15 回执并可复用', async () => {
  let calls = 0;
  const harness = createRuntimeHarness({
    useDefaultSelector: true,
    generateUtilityTask: async options => { calls += 1; assert.equal(options.transportBudget.remaining, 3); return { jsonData: { history_exclude_keys: [], state_exclude_keys: [] } }; },
  });
  const first = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(calls, 1);
  assert.equal(first.lastRecall.status, 'ready');
  const receipt = harness.userMessage.extra[RECALL_RECEIPT_KEY];
  assert.equal(receipt.schemaVersion, RECALL_RECEIPT_SCHEMA_VERSION);
  assert.equal(receipt.strategyVersion, RECALL_STRATEGY_VERSION);
  assert.equal(receipt.selectorDiagnostic.historyCandidateCount > 0, true);
  assert.equal(receipt.selectorDiagnostic.stateCandidateCount, 0);
  assert.equal(receipt.selectorDiagnostic.historyExcludedCount, 0);
  assert.equal(receipt.selectorDiagnostic.stateExcludedCount, 0);
  assert.equal(receipt.selectorDiagnostic.historyRetainedCount, receipt.selectorDiagnostic.historyCandidateCount);
  assert.equal(receipt.selectorDiagnostic.stateRetainedCount, 0);
  assert.ok(Number.isFinite(receipt.selectorDiagnostic.utilityRoundTripMs));
  assert.ok(Number.isFinite(receipt.selectorDiagnostic.localSelectionMs));
  const legacy = structuredClone(receipt);
  delete legacy.selectorDiagnostic.priority;
  legacy.receiptFingerprint = await receiptFingerprint(legacy);
  harness.userMessage.extra[RECALL_RECEIPT_KEY] = legacy;
  const historical = await projectHistoricalRecallReceipt(harness.userMessage, { chatId: CHAT, userMessageIndex: 1 });
  assert.equal(historical.injectionText, legacy.injectionText, '旧schema17回执缺priority时按原封签冷读');
  const reused = await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(calls, 1, '未变化的 regenerate 应复用新回执，不重复扣选材请求');
  assert.equal(reused.lastRecall.reusedReceipt, true);
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].receiptFingerprint, legacy.receiptFingerprint, '旧回执缺字段时不补默认值重封');
});

test('旧 state_progressions 不写入schema15；schema14仍可冷读但下一次生成必须重算', async () => {
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
  assert.equal(receipt.schemaVersion, RECALL_RECEIPT_SCHEMA_VERSION);
  assert.equal(Object.hasOwn(receipt, 'stateProgressions'), false);
  assert.equal(Object.hasOwn(first.lastRecall, 'stateProgressions'), false);
  assert.doesNotMatch(receipt.injectionText, /过了一阵；具体时长未知|保存时仍记得承诺→/);
  assert.deepEqual(graph, beforeGraph, '召回只写回执，不修改FloorMemory/CSE图');

  const old = stripSummaryWitnessesForLegacyReceipt(structuredClone(receipt));
  old.schemaVersion = 14;
  old.strategyVersion = 'continuity-v13';
  old.stateProgressions = [];
  old.stages.stateProgressionCount = 0;
  if (old.timeDependencies?.renderPlan) {
    old.timeDependencies.renderPlan.limits.ordinaryMaxCharacters = 16000;
    old.timeDependencies.renderPlan.limits.ordinaryEstimatedTokenBudget = 4000;
  }
  old.receiptFingerprint = await receiptFingerprint(old);
  const historical = await projectHistoricalRecallReceipt({ ...harness.userMessage, extra:{ [RECALL_RECEIPT_KEY]:old } }, { chatId:CHAT, userMessageIndex:1 });
  assert.equal(historical?.schemaVersion, 14);
  assert.equal(historical?.injectionText, old.injectionText);
  harness.userMessage.extra[RECALL_RECEIPT_KEY] = old;
  harness.runtime.invalidate('simulateReload');
  const restored = await harness.runtime.restorePersistedReceipt();
  assert.equal(restored.lastRecall.schemaVersion, 14);
  assert.equal(restored.lastRecall.legacyReadOnly, true);
  assert.equal(restored.lastRecall.restoredReceipt, true);
  const rerolled = await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(rerolled.lastRecall.reusedReceipt, false);
  assert.equal(rerolled.lastRecall.schemaVersion, RECALL_RECEIPT_SCHEMA_VERSION);
  assert.equal(calls, 2);
});

test('当前剧情线回执经 runtime 新算/复用/恢复及历史 projector 后仍完整渲染', async () => {
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
  assert.equal(first.lastRecall.schemaVersion, RECALL_RECEIPT_SCHEMA_VERSION);
  assert.equal(first.lastRecall.strategyVersion, RECALL_STRATEGY_VERSION);
  assert.equal(receipt.strategyVersion, RECALL_STRATEGY_VERSION);
  assert.deepEqual(receipt.storylines, selection.storylines);
  assert.equal(receipt.injectionText, selection.injectionText);
  const freshInline = projectInlineRecallReceipt(first.lastRecall);
  assert.equal(freshInline.protocolRecognized, true);
  assert.equal(freshInline.storylineGroups.length, selection.storylines.length);
  assert.equal(freshInline.historyItems.length, selection.floors.flatMap(value => value.items).length);
  assert.equal(freshInline.cseChangeItems.length, selection.cseChanges.length);

  const historical = await projectHistoricalRecallReceipt({ ...harness.userMessage, extra: { [RECALL_RECEIPT_KEY]: structuredClone(receipt) } }, { chatId: CHAT, userMessageIndex: 1 });
  assert.equal(historical.schemaVersion, RECALL_RECEIPT_SCHEMA_VERSION);
  assert.equal(projectInlineRecallReceipt(historical).protocolRecognized, true);
  assert.deepEqual(projectInlineRecallReceipt(historical).storylines, freshInline.storylines);

  const expanded = structuredClone(receipt), expandedStates = structuredClone(selection.states), expandedStorylines = structuredClone(selection.storylines);
  while (expandedStorylines.length < 9) {
    const order = expandedStorylines.length + 1, storylineId = `expanded-${order}`;
    const state = { stateId:`expanded-state-${order}`, storylineId, subjectEntityId:PERSON, subject:'裴晚生', layer:'situational', text:`扩展状态 ${order}`, reason:'测试依据', visibility:'authorial', origin:'manual', towardEntityId:null, toward:null, sourceFloorId:null, sourceDeltaId:null, sourceAssistantSeq:null };
    expandedStorylines.push({ storylineId, title:`扩展剧情线 ${order}`, basis:`扩展依据 ${order}` });
    expandedStates.push(state);
    expanded.selectedStates.push(state);
  }
  expanded.storylines = expandedStorylines;
  expanded.injectionText = formatRecallInjection({
    coverage: selection.coverage, floors: selection.floors, states: expandedStates, cseChanges: selection.cseChanges,
    entityById: new Map(source.entities.map(value => [value.entityId, value])), storylines: expandedStorylines,
    timeDependencies: { mode:'selected', corrections:[], reminders:[] },
  });
  expanded.receiptFingerprint = await receiptFingerprint(expanded);
  const expandedHistorical = await projectHistoricalRecallReceipt({ ...harness.userMessage, extra:{ [RECALL_RECEIPT_KEY]:expanded } }, { chatId:CHAT, userMessageIndex:1 });
  assert.equal(expandedHistorical.storylines.length, 9, '当前运行时历史校验不得沿用旧四线边界');
  const expandedHistoricalInline = projectInlineRecallReceipt(expandedHistorical);
  assert.equal(expandedHistoricalInline.protocolRecognized, true, '历史回执转展示状态后必须保留当前策略边界');
  assert.equal(expandedHistoricalInline.storylineGroups.length, 9);
  assert.equal(projectInlineRecallReceipt({ ...expandedHistorical, strategyVersion:'continuity-v14' }).storylineGroups.length, 0, 'v14 旧策略仍保持四线边界');

  const legacyV22 = structuredClone(expanded);
  legacyV22.strategyVersion = 'continuity-v22';
  while (legacyV22.selectedStates.length < 30) {
    const order = legacyV22.selectedStates.length + 1;
    legacyV22.selectedStates.push({ ...structuredClone(expanded.selectedStates.at(-1)), stateId:`legacy22-${order}`, text:`旧大容量状态 ${order}` });
  }
  legacyV22.injectionText = formatRecallInjection({ coverage:selection.coverage, floors:selection.floors, states:legacyV22.selectedStates,
    cseChanges:selection.cseChanges, entityById:new Map(source.entities.map(value=>[value.entityId,value])), storylines:expandedStorylines,
    timeDependencies:{mode:'selected',corrections:[],reminders:[]} });
  legacyV22.receiptFingerprint = await receiptFingerprint(legacyV22);
  const legacySignature = legacyV22.receiptFingerprint;
  const oldLarge = await projectHistoricalRecallReceipt({ ...harness.userMessage, extra:{[RECALL_RECEIPT_KEY]:legacyV22} }, {chatId:CHAT,userMessageIndex:1});
  assert.equal(oldLarge?.selectedStates.length, 30, 'v22旧大容量回执不能退到24条上限');
  assert.equal(projectInlineRecallReceipt(oldLarge).storylineGroups.length, 9, '正文投影复用v22大容量边界');
  assert.equal(legacyV22.receiptFingerprint, legacySignature, '历史读取保留旧签名');

  const oldSchema12 = stripSummaryWitnessesForLegacyReceipt(structuredClone(receipt));
  oldSchema12.schemaVersion = 12;
  delete oldSchema12.stateProgressions;
  delete oldSchema12.stages.stateProgressionCount;
  oldSchema12.receiptFingerprint = await receiptFingerprint(oldSchema12);
  const historical12 = await projectHistoricalRecallReceipt({ ...harness.userMessage, extra:{ [RECALL_RECEIPT_KEY]:oldSchema12 } }, { chatId:CHAT, userMessageIndex:1 });
  assert.equal(historical12.schemaVersion, 12);
  assert.equal(Object.hasOwn(historical12, 'stateProgressions'), false);
  assert.equal(projectInlineRecallReceipt(historical12).protocolRecognized, true);

  harness.userMessage.extra[RECALL_RECEIPT_KEY] = expanded;
  harness.runtime.invalidate('simulateReload');
  const restored = await harness.runtime.restorePersistedReceipt();
  assert.equal(restored.lastRecall.schemaVersion, RECALL_RECEIPT_SCHEMA_VERSION);
  assert.equal(restored.lastRecall.strategyVersion, RECALL_STRATEGY_VERSION);
  assert.equal(projectInlineRecallReceipt(restored.lastRecall).protocolRecognized, true);
  assert.equal(projectInlineRecallReceipt(restored.lastRecall).storylineGroups.length, 9);

  harness.userMessage.extra[RECALL_RECEIPT_KEY] = receipt;
  harness.runtime.invalidate('restoreOriginalForReuse');
  await harness.runtime.restorePersistedReceipt();
  const reused = await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(selectorCalls, 1);
  assert.equal(reused.lastRecall.schemaVersion, RECALL_RECEIPT_SCHEMA_VERSION);
  assert.equal(reused.lastRecall.strategyVersion, RECALL_STRATEGY_VERSION);
  assert.equal(reused.lastRecall.reusedReceipt, true);
  assert.equal(reused.lastRecall.injectionText, selection.injectionText);
  assert.equal(projectInlineRecallReceipt(reused.lastRecall).protocolRecognized, true);
  assert.deepEqual(projectInlineRecallReceipt(reused.lastRecall).storylines, freshInline.storylines);
});

test('schema15 continuity-v14 仍可只读恢复，但当前生成按 v15 重新选材', async () => {
  let selectorCalls = 0;
  const harness = createRuntimeHarness({ selector:input => { selectorCalls += 1; return selectRecall(input); } });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const legacy = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
  legacy.strategyVersion = 'continuity-v14';
  if (legacy.timeDependencies?.renderPlan) {
    legacy.timeDependencies.renderPlan.limits.maxCharacters = Math.min(16000, legacy.timeDependencies.renderPlan.limits.maxCharacters);
    legacy.timeDependencies.renderPlan.limits.estimatedTokenBudget = Math.min(4000, legacy.timeDependencies.renderPlan.limits.estimatedTokenBudget);
  }
  legacy.receiptFingerprint = await receiptFingerprint(legacy);
  harness.userMessage.extra[RECALL_RECEIPT_KEY] = legacy;
  harness.runtime.invalidate('simulateReload');
  const restored = await harness.runtime.restorePersistedReceipt();
  assert.equal(restored.lastRecall?.legacyReadOnly, true);
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].strategyVersion, 'continuity-v14');
  await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(selectorCalls, 2);
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].strategyVersion, RECALL_STRATEGY_VERSION);
});

test('schema18 continuity-v19 历史回执按旧签名读取，当前roll仅迁移重选一次到当前策略', async () => {
  let selectorCalls = 0;
  const harness = createRuntimeHarness({ selector: input => { selectorCalls += 1; return selectRecall(input); } });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const legacy = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
  legacy.strategyVersion = 'continuity-v19';
  legacy.receiptFingerprint = await receiptFingerprint(legacy);
  harness.userMessage.extra[RECALL_RECEIPT_KEY] = legacy;
  harness.runtime.invalidate('simulateReload');
  const historical = await harness.runtime.restorePersistedReceipt();
  assert.equal(historical.lastRecall?.legacyReadOnly, true);
  assert.equal(historical.lastRecall?.strategyVersion, 'continuity-v19');
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].receiptFingerprint, legacy.receiptFingerprint, '历史读取不改写v19签名');

  await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  const migrated = harness.userMessage.extra[RECALL_RECEIPT_KEY];
  assert.equal(selectorCalls, 2, 'v19旧冻结回执只触发一次正常选材');
  assert.equal(migrated.strategyVersion, RECALL_STRATEGY_VERSION);
  await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(selectorCalls, 2, '当前策略回执后续roll仍冻结复用');
});

test('schema18 continuity-v20 历史回执按原签名读取，当前roll仅迁移重选一次到当前策略', async () => {
  assert.equal(RECALL_STRATEGY_VERSION, 'continuity-v32');
  let selectorCalls = 0;
  const harness = createRuntimeHarness({ selector: input => { selectorCalls += 1; return selectRecall(input); } });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const legacy = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
  legacy.strategyVersion = 'continuity-v20';
  legacy.receiptFingerprint = await receiptFingerprint(legacy);
  harness.userMessage.extra[RECALL_RECEIPT_KEY] = legacy;
  harness.runtime.invalidate('simulateReload');
  const historical = await harness.runtime.restorePersistedReceipt();
  assert.equal(historical.lastRecall?.legacyReadOnly, true);
  assert.equal(historical.lastRecall?.strategyVersion, 'continuity-v20');
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].receiptFingerprint, legacy.receiptFingerprint, '读取不改写旧v20签名');

  await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  const migrated = harness.userMessage.extra[RECALL_RECEIPT_KEY];
  assert.equal(selectorCalls, 2, 'v20旧冻结回执只触发一次当前选材');
  assert.equal(migrated.strategyVersion, 'continuity-v32');
  await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(selectorCalls, 2, '新策略回执后续roll仍冻结复用');
});

test('continuity-v26旧选材只读保签名，下一次正常生成重选一次后复用当前策略',async()=>{
 assert.equal(RECALL_STRATEGY_VERSION,'continuity-v32');let selections=0;
 const h=createRuntimeHarness({selector:input=>{selections++;return selectRecall(input);}});await h.runtime.intercept(h.chat,12000,null,'normal');
 const old=structuredClone(h.userMessage.extra[RECALL_RECEIPT_KEY]);old.strategyVersion='continuity-v26';old.receiptFingerprint=await receiptFingerprint(old);h.userMessage.extra[RECALL_RECEIPT_KEY]=old;h.runtime.invalidate('simulateReload');
 const restored=await h.runtime.restorePersistedReceipt();assert.equal(restored.lastRecall.legacyReadOnly,true);assert.equal(restored.lastRecall.strategyVersion,'continuity-v26');assert.equal(selections,1,'只读展示不增加选材');assert.equal(h.userMessage.extra[RECALL_RECEIPT_KEY].receiptFingerprint,old.receiptFingerprint);
 await h.runtime.intercept(h.chat,12000,null,'regenerate');assert.equal(selections,2);assert.equal(h.userMessage.extra[RECALL_RECEIPT_KEY].strategyVersion,'continuity-v32');await h.runtime.intercept(h.chat,12000,null,'regenerate');assert.equal(selections,2);
});

test('continuity-v27旧选材只读保签名，下一次正常生成重选一次后复用当前策略',async()=>{
 assert.equal(RECALL_STRATEGY_VERSION,'continuity-v32');let selections=0;
 const h=createRuntimeHarness({selector:input=>{selections++;return selectRecall(input);}});await h.runtime.intercept(h.chat,12000,null,'normal');
 const old=structuredClone(h.userMessage.extra[RECALL_RECEIPT_KEY]);old.strategyVersion='continuity-v27';old.receiptFingerprint=await receiptFingerprint(old);h.userMessage.extra[RECALL_RECEIPT_KEY]=old;h.runtime.invalidate('simulateReload');
 const restored=await h.runtime.restorePersistedReceipt();assert.equal(restored.lastRecall.legacyReadOnly,true);assert.equal(restored.lastRecall.strategyVersion,'continuity-v27');assert.equal(selections,1,'只读展示不增加选材');assert.equal(h.userMessage.extra[RECALL_RECEIPT_KEY].receiptFingerprint,old.receiptFingerprint);
 await h.runtime.intercept(h.chat,12000,null,'regenerate');assert.equal(selections,2);assert.equal(h.userMessage.extra[RECALL_RECEIPT_KEY].strategyVersion,'continuity-v32');await h.runtime.intercept(h.chat,12000,null,'regenerate');assert.equal(selections,2);
});

test('schema18 continuity-v21 历史回执保留原签名，只迁移重选一次到当前策略', async () => {
  assert.equal(RECALL_STRATEGY_VERSION, 'continuity-v32');
  let selectorCalls = 0, projectionVersion = 4;
  const harness = createRuntimeHarness({ selector: input => { selectorCalls += 1; return selectRecall(input); },
    qianshiProgressProvider: () => ({ anchor: { narrativeGeneration: GEN, headCheckpointId: 'head' }, projectionVersion,
      text: projectionVersion === 4 ? '[相关时间线]\n- 旧投影下的已选事项' : '[相关时间线]\n- 当前投影下的已选事项', eventIds: ['q-event'], matterIds: [] }) });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const legacy = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
  assert.equal(legacy.qianshiProgress.projectionVersion, 4);
  legacy.strategyVersion = 'continuity-v21';
  legacy.receiptFingerprint = await receiptFingerprint(legacy);
  harness.userMessage.extra[RECALL_RECEIPT_KEY] = legacy;
  harness.runtime.invalidate('simulateReload');
  const historical = await harness.runtime.restorePersistedReceipt();
  assert.equal(historical.lastRecall?.legacyReadOnly, true);
  assert.equal(historical.lastRecall?.strategyVersion, 'continuity-v21');
  assert.equal(historical.lastRecall?.qianshiProgress.projectionVersion, 4, '旧Qianshi投影只读可见');
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].receiptFingerprint, legacy.receiptFingerprint, '旧v21签名只读保留');

  projectionVersion = 5;
  await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  const migrated = harness.userMessage.extra[RECALL_RECEIPT_KEY];
  assert.equal(selectorCalls, 2, '旧v21回执仅触发一次正常选材');
  assert.equal(migrated.strategyVersion, 'continuity-v32');
  assert.equal(migrated.qianshiProgress.projectionVersion, 5, '一次正常重选采用新投影');
  assert.match(migrated.qianshiProgress.text, /当前投影下的已选事项/u);
  await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(selectorCalls, 2, '新策略回执后续roll仍冻结复用');
});

test('schema18 continuity-v22 历史回执保留原签名，只迁移重选一次到当前策略', async () => {
  assert.equal(RECALL_STRATEGY_VERSION, 'continuity-v32');
  let selectorCalls = 0, projectionVersion = 4;
  const harness = createRuntimeHarness({ selector: input => { selectorCalls += 1; return selectRecall(input); },
    qianshiProgressProvider: () => ({ anchor: { narrativeGeneration: GEN, headCheckpointId: 'head' }, projectionVersion,
      text: projectionVersion === 4 ? '[相关时间线]\n- 旧投影下的已选事项' : '[相关时间线]\n- 当前投影下的已选事项', eventIds: ['q-event'], matterIds: [] }) });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const legacy = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
  assert.equal(legacy.qianshiProgress.projectionVersion, 4);
  legacy.strategyVersion = 'continuity-v22';
  legacy.receiptFingerprint = await receiptFingerprint(legacy);
  harness.userMessage.extra[RECALL_RECEIPT_KEY] = legacy;
  harness.runtime.invalidate('simulateReload');
  const historical = await harness.runtime.restorePersistedReceipt();
  assert.equal(historical.lastRecall?.legacyReadOnly, true);
  assert.equal(historical.lastRecall?.strategyVersion, 'continuity-v22');
  assert.equal(historical.lastRecall?.qianshiProgress.projectionVersion, 4, '旧Qianshi投影只读可见');
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].receiptFingerprint, legacy.receiptFingerprint, '旧v22签名只读保留');

  projectionVersion = 5;
  await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  const migrated = harness.userMessage.extra[RECALL_RECEIPT_KEY];
  assert.equal(selectorCalls, 2, '旧v22回执仅触发一次正常选材');
  assert.equal(migrated.strategyVersion, 'continuity-v32');
  assert.equal(migrated.qianshiProgress.projectionVersion, 5, '一次正常重选采用新投影');
  assert.match(migrated.qianshiProgress.text, /当前投影下的已选事项/u);
  await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(selectorCalls, 2, '新策略回执后续roll仍冻结复用');
});

test('当前策略回执保存N外的未覆盖楼；append自动隐藏后swipe和regenerate均按同回执冻结', async () => {
  const targetText = '抽签决定留宿：林岚去客房，顾舟去主卧。';
  const source = selectorSource({ memories: [
    recallMemory(1, { summary: '较早整理车站。' }),
    recallMemory(2, { summary: targetText }),
    recallMemory(3, { summary: '随后准备睡觉。' }),
    recallMemory(4, { summary: '后来熄灯休息。' }),
  ] });
  const bodyTexts = ['较早整理车站。', '抽签决定留宿：林岚去客房，顾舟去主卧。', '随后准备睡觉。', '后来熄灯休息。<location>客房</location>'];
  const chat = [];
  const fingerprints = await Promise.all(bodyTexts.map(fingerprintText));
  for (let index = 0; index < bodyTexts.length; index += 1) {
    chat.push({ is_user: true, is_system: false, mes: `继续第${index + 1}段` });
    chat.push({ is_user: false, is_system: false, mes: bodyTexts[index] });
  }
  let selectorCalls = 0, selectorBodyMatch = null, selectorLocationReferences = null;
  const harness = createRuntimeHarness({ sourceReader: async () => structuredClone(source),
    reachableReader: async () => rawReachableFromSource(source),
    selector: input => { selectorCalls += 1; selectorBodyMatch = input.source.bodyMatch; selectorLocationReferences = input.source.bodyMatch.locationReferences; return selectRecall(input); } });
  harness.chat.splice(0, harness.chat.length, ...chat, harness.userMessage);
  harness.context.chatId = 'host-chat-a';
  harness.userMessage.mes = '继续林岚去客房的安排。';
  source.bodyMatchRefs = source.floorMemories.map((memory, index) => ({
    floorId: memory.floorId, floorMemoryId: memory.floorMemoryId, assistantSeq: memory.assistantSeq,
    hostLocator: { messageIndex: index * 2 + 1, swipeId: null, selectedSwipeIndex: null },
    rawFingerprint: fingerprints[index], canonicalFingerprint: fingerprints[index],
  }));
  await harness.runtime.intercept(structuredClone(harness.chat), 12000, null, 'normal');
  assert.equal(selectorCalls, 1);
  const savedReceipt = harness.userMessage.extra[RECALL_RECEIPT_KEY];
  assert.equal(savedReceipt.strategyVersion, RECALL_STRATEGY_VERSION);
  assert.equal(savedReceipt.selectedFloors.some(floor => floor.floorId === 'floor-2'), false, 'N=3正文覆盖的第3条历史不重复注入');
  assert.equal(savedReceipt.injectionText.includes(targetText), false);
  assert.deepEqual(savedReceipt.selectedLocationReferences, []);
  assert.deepEqual(selectorLocationReferences.map(value => value.text), ['客房'], '地点标签仍用于现有设施资格与正文检索');
  assert.equal(selectorBodyMatch.witnessCount, 3, '正文匹配仍只使用用户设置的N条核心正文见证');
  assert.ok(selectorBodyMatch.recentBodyFloorIds.length <= 3);
  const originalSignature = savedReceipt.receiptFingerprint;

  const memoryState = {
    chatId: CHAT, memorySnapshotStatus: 'ready', floors: source.floorMemories.map((memory, index) => ({
      floorId: memory.floorId, assistantSeq: memory.assistantSeq, messageIndex: index * 2 + 1,
      memoryId: memory.floorMemoryId, status: 'ready', cse: { status: 'ready', deltaId: `delta-${index + 1}` },
    })),
  };
  const memoryListeners = new Set();
  const memoryRuntime = { getState: () => memoryState, subscribe(listener) { memoryListeners.add(listener); return () => memoryListeners.delete(listener); } };
  const settings = { get: () => ({ pluginEnabled: true, autoHideEnabled: true, autoHideKeepAiCount: 3 }) };
  const controller = createAutoHideController({
    hostAdapter: { snapshot: () => ({ chat: harness.chat, chatId: 'host-chat-a', context: harness.context }) },
    memoryRuntime, settings, logger: { warn() {} },
  });
  harness.chat.push({ is_user: false, is_system: false, mes: '新回复：大家按抽牌结果回房休息。<location>阳台</location>' });
  harness.context.executeSlashCommandsWithOptions = async command => {
    const [, kind, rangeText] = command.match(/^\/(hide|unhide) (\d+(?:-\d+)?)$/) ?? [];
    assert.ok(kind && rangeText);
    const [start, end = start] = rangeText.split('-').map(Number);
    for (let index = start; index <= end; index += 1) harness.chat[index].is_system = kind === 'hide';
  };
  for (const listener of memoryListeners) listener(memoryState);
  await controller.reconcile();
  const keptTarget = harness.chat.find(message => message.mes === targetText);
  assert.notEqual(keptTarget?.is_system, true, 'N+1保留槽位不得隐藏仍属于用户N条正文窗口的原文楼');
  const oldestFloor = harness.chat.find(message => message.mes === '较早整理车站。');
  assert.equal(oldestFloor?.is_system, true, '额外一槽仍允许更早且非正文覆盖的旧楼按既有规则隐藏');
  assert.equal(oldestFloor.extra?.[AUTO_HIDE_MARKER_KEY]?.chatId, CHAT);

  const swipeCore = harness.chat.filter(message => message.is_system !== true).map(message => structuredClone(message));
  assert.equal(swipeCore.pop().is_user, false, '模拟宿主swipe会先移除当前AI回复');
  assert.equal(swipeCore.some(message => message.mes === targetText), true, 'swipe移除当前AI后，用户N正文窗口内仍保留原休息安排');
  await harness.runtime.intercept(swipeCore, 12000, null, 'swipe');
  assert.equal(selectorCalls, 1, '当前v21回执在同user roll中冻结复用');
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].strategyVersion, RECALL_STRATEGY_VERSION);
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].receiptFingerprint, originalSignature, '冻结回执签名保持不变');
  assert.deepEqual(selectorLocationReferences.map(value => value.text), ['客房'], 'swipe沿用当前user之前的前序地点，不用待替换回复地点');
  assert.doesNotMatch(latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT), /阳台/u);
  assert.equal(latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT).includes(targetText), false, '正文仍在swipe核心上下文时不重复注入其摘要');

  harness.chat.pop();
  const regenerateCore = harness.chat.filter(message => message.is_system !== true).map(message => structuredClone(message));
  await harness.runtime.intercept(regenerateCore, 12000, null, 'regenerate');
  assert.equal(selectorCalls, 1, '同user swipe与regenerate均不再次选材');
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].receiptFingerprint, originalSignature);
  controller.dispose();
});

test('旧v18正文覆盖回执遇到已隐藏目标楼时v21只重选一次并恢复权威摘要、不恢复楼', async () => {
  const targetText = '分房安排：林岚去客房，顾舟去主卧。';
  for (const generationType of ['swipe', 'regenerate']) {
    const source = selectorSource({ memories: [
      recallMemory(1, { summary: targetText }),
      recallMemory(2, { summary: '之后收拾客厅。' }),
      recallMemory(3, { summary: '随后各自休息。' }),
    ] });
    const bodyTexts = [targetText, '之后收拾客厅。', '随后各自休息。<location>客房</location>'];
    const fingerprints = await Promise.all(bodyTexts.map(fingerprintText));
    const initialChat = [];
    for (let index = 0; index < bodyTexts.length; index += 1) initialChat.push(
      { is_user: true, is_system: false, mes: `继续${index + 1}` },
      { is_user: false, is_system: false, mes: bodyTexts[index] },
    );
    let selectorCalls = 0, lastLocationReferences = [];
    const harness = createRuntimeHarness({ sourceReader: async () => structuredClone(source),
      reachableReader: async () => rawReachableFromSource(source),
      selector: input => { selectorCalls += 1; lastLocationReferences = input.source.bodyMatch.locationReferences; return selectRecall(input); } });
    harness.chat.splice(0, harness.chat.length, ...initialChat, harness.userMessage);
    harness.context.chatId = 'host-chat-a';
    harness.userMessage.mes = '继续林岚去客房的安排。';
    source.bodyMatchRefs = source.floorMemories.map((memory, index) => ({
      floorId: memory.floorId, floorMemoryId: memory.floorMemoryId, assistantSeq: memory.assistantSeq,
      hostLocator: { messageIndex: index * 2 + 1, swipeId: null, selectedSwipeIndex: null },
      rawFingerprint: fingerprints[index], canonicalFingerprint: fingerprints[index],
    }));
    await harness.runtime.intercept(structuredClone(harness.chat), 12000, null, 'normal');
    assert.equal(selectorCalls, 1);
    let receipt = harness.userMessage.extra[RECALL_RECEIPT_KEY];
    assert.equal(receipt.selectedFloors.some(floor => floor.floorId === 'floor-1'), false, '首轮正文覆盖不重复注入目标摘要');
    assert.doesNotMatch(receipt.injectionText, /分房安排/u);
    receipt.strategyVersion = 'continuity-v18';
    receipt.receiptFingerprint = await receiptFingerprint(receipt);
    harness.runtime.invalidate('persistedV18');
    const historical = await harness.runtime.restorePersistedReceipt();
    assert.equal(historical.lastRecall?.legacyReadOnly, true);

    const ownedHiddenTarget = harness.chat.find(message => message.mes === targetText);
    ownedHiddenTarget.is_system = true;
    ownedHiddenTarget.extra = { [AUTO_HIDE_MARKER_KEY]: { schemaVersion: 1, chatId: CHAT } };
    harness.chat.push({ is_user: false, is_system: false, mes: '本轮回复将被移除。<location>阳台</location>' });
    let core;
    if (generationType === 'swipe') {
      core = harness.chat.filter(message => message.is_system !== true).map(message => structuredClone(message));
      assert.equal(core.pop().is_user, false);
    } else {
      harness.chat.pop();
      core = harness.chat.filter(message => message.is_system !== true).map(message => structuredClone(message));
    }
    assert.equal(core.some(message => message.mes === targetText), false, `${generationType}: 已隐藏目标正文不能被放回核心上下文`);

    await harness.runtime.intercept(core, 12000, null, generationType);
    receipt = harness.userMessage.extra[RECALL_RECEIPT_KEY];
    assert.equal(selectorCalls, 2, `${generationType}: 旧策略回执失效只重选一次`);
    assert.equal(receipt.strategyVersion, RECALL_STRATEGY_VERSION);
    assert.match(receipt.injectionText, /分房安排/u, `${generationType}: 当前权威摘要重新进入召回`);
    assert.deepEqual(lastLocationReferences.map(value => value.text), ['客房'], `${generationType}: 首次v21选择沿用当前user前的地点参考`);
    assert.doesNotMatch(receipt.injectionText, /阳台/u);
    assert.equal(ownedHiddenTarget.is_system, true, `${generationType}: 重选材不恢复已隐藏楼`);
    await harness.runtime.intercept(core, 12000, null, generationType);
    assert.equal(selectorCalls, 2, `${generationType}: v21后续同user roll复用回执`);
    assert.equal(ownedHiddenTarget.is_system, true);
  }
});

test('首次 fallback 回执可历史查看，且同 user regenerate 完整复用', async () => {
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
  assert.equal(selectorCalls, 1, '同 user 的 fallback 首次结果也不得重新选材');
  assert.equal(regenerated.lastRecall.reusedReceipt, true);
  assert.equal(regenerated.lastRecall.selectorDiagnostic.mode, 'fallback');
  assert.equal(regenerated.lastRecall.injectionText, first.lastRecall.injectionText);
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
  assert.deepEqual(budgets, [{ remaining: 3, used: 0 }, { remaining: 3, used: 0 }]);
  assert.equal(result.lastRecall.status, 'ready');
  assert.equal(result.lastRecall.selectorDiagnostic.mode, 'llm');
  assert.equal(abortCalls, 0);
  assert.deepEqual(notifications, [{ kind: 'warning', text: '记忆召回未完成，正在重试。' }]);
});

test('runtime LLM 编号局部无效仍首轮注入，不重试、不通知失败或停止正文', async () => {
  let calls = 0, abortCalls = 0;
  const notifications = [];
  const harness = createRuntimeHarness({ useDefaultSelector: true, notifyUser: value => notifications.push(value),
    generateUtilityTask: async options => {
      calls += 1;
      assert.deepEqual(options.transportBudget, { remaining: 3, used: 0 });
      return { jsonData: { history_exclude_keys: ['R999', 'C1', 7, null], state_exclude_keys: ['C999', 'R1', {}],
        qianshi_exclude_keys: ['Q999', 'R1', false] } };
    },
  });
  const result = await harness.runtime.intercept(harness.chat, 12000, value => { if (value === true) abortCalls += 1; }, 'normal');
  assert.equal(calls, 1);
  assert.equal(abortCalls, 0);
  assert.equal(result.lastRecall.status, 'ready');
  assert.equal(result.lastRecall.selectorDiagnostic.mode, 'llm');
  assert.equal(result.lastRecall.selectorDiagnostic.historyExcludedCount, 0);
  assert.equal(result.lastRecall.selectorDiagnostic.stateExcludedCount, 0);
  assert.ok(result.lastRecall.injectionText);
  assert.ok(harness.prompts.some(call => call[0] === RECALL_PROMPT_SLOT && call[1]));
  assert.deepEqual(notifications, []);
});

test('runtime LLM持续返回坏JSON时只调用utility两次，清槽并阻止正文API', async () => {
  const notifications = [];
  let calls = 0, abortCalls = 0, mainApiCalls = 0;
  const harness = createRuntimeHarness({
    useDefaultSelector: true,
    generateUtilityTask: async options => {
      calls += 1;
      assert.deepEqual(options.transportBudget, { remaining: 3, used: 0 });
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
  assert.equal(notifications[0].text, '记忆召回未完成，正在重试。');
  assert.match(notifications[1].text, /召回失败，已停止正文生成/);
});

test('runtime经真实utility路由与compact client遇到HTTP500时使用默认三次共同额度', async () => {
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
  assert.equal(fetchCalls, 3, '真实fetch共用默认1+2额度，不在外层重新开启');
  assert.equal(retryWaits, 2);
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
    assert.equal(selectorCalls, scenario === 'covered' ? 0 : 1, scenario);
    assert.equal(aborted, false, scenario);
    if (scenario === 'covered') assert.deepEqual(result.lastRecall.skipReasons, ['recentBodyOnly']);
    else assert.notEqual(result.lastRecall.status, 'skipped', scenario);
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
    prequel: '已导入的过去经历，继续验证既有旧档召回管线。',
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
    prequel: '已导入的过去经历，继续验证既有旧档召回管线。',
      prepareMemory: async ({ preferCached }) => {
        prepareCalls += 1;
        assert.equal(preferCached, prepareCalls === 1, kind);
        if (prepareCalls === 1) return kind === 'timeout' ? new Promise(() => {}) : { status: 'error' };
        return { status: 'ready', reachable: structuredClone(raw) };
      },
      preparationTimeoutMs: 50,
      sourceReader: async () => ({ status: 'unavailable' }),
      rootReader: async () => ({ status: 'ready', revision: raw.rootRevision, data: structuredClone(raw.root) }),
      notifyUser: value => notifications.push(value),
    });
    let abortCalls = 0;
    const result = await harness.runtime.intercept(harness.chat, 12000, value => { if (value === true) abortCalls += 1; }, 'normal');
    assert.equal(prepareCalls, 2, kind);
    assert.equal(abortCalls, 0, kind);
    assert.equal(['ready', 'empty'].includes(result.lastRecall.status), true, `${kind}: ${JSON.stringify(result.lastRecall)}`);
    assert.deepEqual(notifications, [{ kind: 'warning', text: '记忆召回未完成，正在重试。' }], kind);
  }

  const freshChat = createRuntimeHarness({
    prepareMemory: async () => ({ status: 'uninitialized' }),
    sourceReader: async () => ({ status: 'unavailable' }),
  });
  let abortCalls = 0;
  const result = await freshChat.runtime.intercept(freshChat.chat, 12000, value => { if (value === true) abortCalls += 1; }, 'normal');
  assert.equal(abortCalls, 0);
  assert.deepEqual(result.lastRecall.skipReasons, ['uninitialized']);
});

async function retrySelectorReachable() {
  const raw = rawReachableFromSource(runtimeFixture());
  const messages = await Promise.all(raw.floors.map(async (floor, index) => {
    const mes = `已保存的隐藏正文 ${index + 1}`;
    const contentFingerprint = await fingerprintText(mes);
    floor.hostLocator = { messageIndex: index, swipeId: null, selectedSwipeIndex: null };
    floor.content = { rawFingerprint: contentFingerprint, canonicalFingerprint: contentFingerprint };
    return { is_user: false, is_system: false, is_hidden: true, mes };
  }));
  return { raw, messages };
}

test('选材截断重试在同一准备期限内读取root，并把一致版本交给准备快路径', async () => {
  const { raw, messages } = await retrySelectorReachable();
  let prepareCalls = 0, rootCalls = 0, utilityCalls = 0;
  const harness = createRuntimeHarness({
    useDefaultSelector: true,
    prepareMemory: async ({ preferCached, rootResult }) => {
      prepareCalls += 1;
      assert.equal(preferCached, prepareCalls === 1);
      if (prepareCalls === 1) assert.equal(rootResult, null);
      else assert.deepEqual(rootResult, { status: 'ready', revision: raw.rootRevision, data: raw.root });
      return { status: 'ready', reachable: structuredClone(raw) };
    },
    rootReader: async () => { rootCalls += 1; return { status: 'ready', revision: raw.rootRevision, data: structuredClone(raw.root) }; },
    generateUtilityTask: async options => {
      utilityCalls += 1;
      assert.equal(options.maxTokens, 8192);
      if (utilityCalls === 1) throw Object.assign(new Error('模型输出疑似被截断。'), { code: 'QQJ_OUTPUT_TRUNCATED' });
      return { jsonData: { history_exclude_keys: [], state_exclude_keys: [] } };
    },
  });
  harness.chat.splice(0, harness.chat.length, ...messages, harness.userMessage);
  const result = await harness.runtime.intercept([structuredClone(harness.userMessage)], 12000, null, 'normal');
  assert.equal(prepareCalls, 2);
  assert.equal(utilityCalls, 2);
  assert.equal(rootCalls, 2, '第二轮来源准备与最终提交各在既有校验点读取一次root');
  assert.equal(result.lastRecall.status, 'ready');
});

test('重试读取root的技术失败与准备期限超时都不降级为旧快照成功', async () => {
  for (const kind of ['technical', 'timeout']) {
    const { raw, messages } = await retrySelectorReachable();
    let prepareCalls = 0, utilityCalls = 0, abortCalls = 0;
    const harness = createRuntimeHarness({
      useDefaultSelector: true,
      prepareMemory: async () => { prepareCalls += 1; return { status: 'ready', reachable: structuredClone(raw) }; },
      preparationTimeoutMs: 50,
      rootReader: kind === 'timeout'
        ? async () => new Promise(() => {})
        : async () => ({ status: 'unavailable', error: { code: 'ROOT_READ_FAILED', message: 'root读取失败' } }),
      generateUtilityTask: async () => {
        utilityCalls += 1;
        throw Object.assign(new Error('模型输出疑似被截断。'), { code: 'QQJ_OUTPUT_TRUNCATED' });
      },
    });
    harness.chat.splice(0, harness.chat.length, ...messages, harness.userMessage);
    const result = await harness.runtime.intercept([structuredClone(harness.userMessage)], 12000, value => { if (value === true) abortCalls += 1; }, 'normal');
    assert.equal(prepareCalls, 1, kind);
    assert.equal(utilityCalls, 1, kind);
    assert.equal(abortCalls, 1, kind);
    assert.equal(result.lastRecall.error.code, kind === 'timeout' ? 'V3_RECALL_MEMORY_PREPARATION_TIMEOUT' : 'ROOT_READ_FAILED', kind);
  }
});

test('准备连续超时后停止正文，迟到失败不得再启动召回降级读取', async () => {
  let releasePreparation;
  const preparation = new Promise(resolve => { releasePreparation = () => resolve({ status: 'error' }); });
  let sourceReads = 0;
  const harness = createRuntimeHarness({
    prepareMemory: () => preparation,
    preparationTimeoutMs: 50,
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
  let prepareCalls = 0, selectorCalls = 0, identityCalls = 0;
  const harness = createRuntimeHarness({
    prequel: '已导入的过去经历，继续验证既有旧档召回管线。',
    prepareMemory: async ({ preferCached }) => {
      prepareCalls += 1;
      assert.equal(preferCached, prepareCalls === 1);
      return { status: 'ready', reachable: structuredClone(prepareCalls === 1 ? initial : current) };
    },
    rootReader: async () => ({ status: 'ready', revision: 2, data: structuredClone(current.root) }),
    identityProjectionProvider: async () => { identityCalls += 1; return { identityRedirectsByEntityId: {}, deletedEntityIds: [] }; },
    selector: input => { selectorCalls += 1; return selectRecall(input); },
  });
  const result = await harness.runtime.intercept(structuredClone(harness.chat), 12000, null, 'normal');
  assert.equal(selectorCalls, 1);
  assert.equal(prepareCalls, 2, 'root 变化后必须 fresh 准备一次');
  assert.equal(identityCalls, prepareCalls, '有可投影记忆时，身份映射仍在每次准备后读取');
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
  const boundPhases = [];
  const unsubscribe = harness.runtime.subscribe(state => {
    if (state.activeRecall?.chatId === CHAT && state.activeRecall.userMessageIndex === 1 && boundPhases.at(-1) !== state.activeRecall.phase) boundPhases.push(state.activeRecall.phase);
  });
  const result = await harness.runtime.intercept(harness.chat, 12000, value => { if (value === true) abortCalls += 1; }, 'normal');
  unsubscribe();
  assert.equal(sourceCalls, 1);
  assert.equal(rootCalls, 2);
  assert.equal(selectorCalls, 1);
  assert.equal(abortCalls, 0);
  assert.equal(result.lastRecall.status, 'ready');
  assert.equal(result.lastRecall.diagnosticAttempt, 1);
  assert.equal(boundPhases.filter(phase => phase === 'input').length, 1, '本地提交重试不重新进入选材准备阶段');
  assert.equal(result.lastRecall.attemptDiagnostics[0].error, null);
  const rootPreparations = result.lastRecall.timings.preparationAttempts.filter(item => item.stage === 'root');
  assert.deepEqual(rootPreparations.map(item => item.status), ['unavailable', 'ready']);
});

test('提交前失败保首轮已选阶段，后续来源失败有独立归属且不冒充注入', async () => {
  let reads = 0, selected = 0, roots = 0;
  const harness = createRuntimeHarness({
    prequel: '已导入的过去经历，继续验证既有旧档召回管线。', sourceReader: async () => {
    if (++reads === 2) throw Object.assign(new Error('第二轮来源失败'), { code: 'TEST_SECOND_SOURCE_FAILED' });
    return structuredClone(runtimeFixture());
  }, rootReader: async () => ++roots === 1 ? { status: 'unavailable' } : { status: 'ready', revision: 2, data: { chatId: CHAT, narrativeGeneration: runtimeFixture().narrativeGeneration, headCheckpointId: runtimeFixture().headCheckpointId } }, selector: options => { selected += 1; return selectRecall(options); } });
  const state = (await harness.runtime.intercept(harness.chat, 12000, null, 'normal')).lastRecall;
  assert.equal(state.status, 'error'); assert.equal(selected, 1); assert.equal(state.diagnosticAttempt, 1);
  assert.ok(state.coverage); assert.ok(state.stages); assert.equal(state.selectionStatus, 'completed');
  assert.equal(state.diagnosticPhase, 'commit'); assert.equal(state.attemptDiagnostics.length, 1); assert.equal(reads, 2);
  assert.equal(state.error.code, 'TEST_SECOND_SOURCE_FAILED'); assert.equal(state.injectionText, ''); assert.deepEqual(state.selectedFloors, []);
  assert.ok(Number.isFinite(state.timings.selectorMs)); assert.equal(state.receiptPersistence, 'none'); assert.equal(harness.userMessage.extra?.[RECALL_RECEIPT_KEY], undefined);
  assert.ok(harness.prompts.every(call => !call[1]));
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
      assert.equal(result.lastTerminated.reason, 'selectedRefsChanged');
      assert.equal(result.lastTerminated.finalVerification.failure.reference.kind, 'floor');
      assert.equal(result.lastTerminated.finalVerification.failure.reference.index, 0);
      assert.equal(result.lastRecall.finalVerification.failure.step, 'selectedReference');
      assert.equal(result.lastRecall.sourceVerification.rootVerified, true);
      assert.equal(result.lastRecall.sourceVerification.selectedSource.revision, 1);
      assert.equal(result.lastRecall.sourceVerification.checkedRoot.revision, 2);
    }
  }
});

test('最终来源核验记录同文状态换ID的准确失败引用，不记录状态正文或reason', async () => {
  const original = reachable();
  const changed = structuredClone(original);
  const changedState = changed.stateDeltas[0].subjectSnapshots[0].situational[0];
  changedState.id = '77777777-8888-4777-8777-777777777777';
  changed.stateDeltas[0].fixedChanges[0].items[0].after.id = changedState.id;
  let reads = 0;
  const sourceReader = async () => readRecallSource({ store: { readReachable: async () => structuredClone(++reads === 1 ? original : changed) }, now: () => new Date(NOW) });
  const selector = input => {
    const result = selectRecall(input);
    const state = input.source.currentState[0].situational[0];
    return { ...result, states: [{ ...state, subjectEntityId: PERSON, subject: '裴晚生', layer: 'situational', toward: null,
      storylineId: '88888888-9999-4999-8999-888888888888' }],
    stages: { ...result.stages, stateCount: 1, currentStateCount: 1, finalInjectionItemCount: (result.floors ?? []).length + 1 } };
  };
  const harness = createRuntimeHarness({ sourceReader, selector });
  const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(result.lastRecall.status, 'stale', JSON.stringify(result.lastRecall));
  assert.deepEqual(result.lastRecall.skipReasons, ['selectedRefsChanged']);
  assert.deepEqual(result.lastRecall.finalVerification.failure.reference, {
    step: 'selectedReference', kind: 'state', index: 0, subjectEntityId: PERSON, layer: 'situational', stateId: ITEM,
    sourceFloorId: FLOOR1, sourceDeltaId: DELTA1, sourceAssistantSeq: 1,
  });
  assert.equal(result.lastTerminated.sourceVerification.rootVerified, null);
  assert.equal(result.lastTerminated.finalVerification.failure.reason, 'changed');
  const safe = projectPrivateRecallDiagnostic(result, null);
  assert.equal(safe.lastTerminated.finalVerification.failure.reference.stateId, ITEM);
  assert.doesNotMatch(JSON.stringify(safe), /始终记得雨夜承诺|亲口答应/u);
  assert.ok(harness.prompts.every(call => call[1] === ''));
});

test('最终来源引用日志区分rawWitness与CSE变更，均只保留索引和来源UUID', async () => {
  for (const kind of ['rawWitness', 'cseChange']) {
    const originalRaw = reachable();
    const changedRaw = structuredClone(originalRaw);
    if (kind === 'cseChange') {
      const after = changedRaw.stateDeltas[0].subjectSnapshots[0].situational[0];
      after.id = '77777777-8888-4777-8777-777777777777';
      changedRaw.stateDeltas[0].fixedChanges[0].items[0].after.id = after.id;
    }
    const project = raw => readRecallSource({ store: { readReachable: async () => structuredClone(raw) }, now: () => new Date(NOW) });
    const original = await project(originalRaw);
    const changed = await project(changedRaw);
    const sourceWithWitness = structuredClone(original);
    sourceWithWitness.rawSources = [{ floorId: FLOOR1, assistantSeq: 1, floorMemoryId: MEMORY1, memoryFloorId: FLOOR1, memoryAssistantSeq: 1,
      canonicalContent: '诊断测试见证片段', fingerprint: await fingerprintText('诊断测试见证片段') }];
    const changedSource = structuredClone(kind === 'rawWitness' ? original : changed);
    if (kind === 'rawWitness') changedSource.rawSources = [];
    const witness = { floorId: FLOOR1, assistantSeq: 1, floorMemoryId: MEMORY1, memoryFloorId: FLOOR1, memoryAssistantSeq: 1,
      offset: 0, length: '诊断测试见证片段'.length, fingerprint: await fingerprintText('诊断测试见证片段'), textFingerprint: await fingerprintText('诊断测试见证片段') };
    let reads = 0;
    const sourceReader = async () => structuredClone(++reads === 1 ? sourceWithWitness : changedSource);
    const selector = input => {
      const result = selectRecall(input);
      return kind === 'rawWitness'
        ? { ...result, states: [], cseChanges: [], floors: [...result.floors, { floorId: FLOOR1, floorMemoryId: MEMORY1, assistantSeq: 1, reasons: ['rawWitness'], items: [{ rawWitness: witness }] }] }
        : { ...result, states: [], cseChanges: [{ ...original.cseChanges[0], storylineId: '88888888-9999-4999-8999-888888888888' }] };
    };
    const harness = createRuntimeHarness({ sourceReader, selector });
    const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
    const reference = result.lastRecall.finalVerification.failure.reference;
    assert.equal(reference.kind, kind);
    if (kind === 'rawWitness') { assert.equal(reference.witnessIndex, 0); assert.equal(reference.floorId, FLOOR1); }
    else { assert.equal(reference.deltaId, DELTA1); assert.equal(reference.action, 'add'); }
    const safe = projectPrivateRecallDiagnostic(result, null);
    assert.equal(safe.lastTerminated.finalVerification.failure.reference.kind, kind);
    assert.doesNotMatch(JSON.stringify(safe), /诊断测试见证片段|亲口答应|始终记得雨夜承诺/u);
    assert.ok(harness.prompts.every(call => call[1] === ''));
  }
});

test('提交前fresh准备遇到并发根推进：核对准备后的当前根；旧快照、再变化和来源删除仍拒绝', async () => {
  for (const kind of ['advanced', 'oldSnapshot', 'changedAgain', 'removed']) {
    const initial = await singleFloorReachable({ revision: 1, head: 'head-before' });
    const captured = await singleFloorReachable({ revision: 2, head: 'head-after' });
    const prepared = structuredClone(captured); prepared.rootRevision = kind === 'oldSnapshot' ? 2 : 3;
    const current = structuredClone(prepared); current.rootRevision = kind === 'changedAgain' ? 4 : 3;
    if (kind === 'removed') { prepared.floors = []; prepared.floorMemories = []; }
    let prepareCalls = 0, rootCalls = 0, selectorCalls = 0;
    const harness = createRuntimeHarness({
      prepareMemory: async () => ({ status: 'ready', reachable: structuredClone(++prepareCalls === 1 ? initial : prepared) }),
      rootReader: async () => {
        const value = ++rootCalls === 1 ? (kind === 'oldSnapshot' ? current : captured) : current;
        return { status: 'ready', revision: value.rootRevision, data: structuredClone(value.root) };
      },
      selector: input => { selectorCalls++; return selectRecall(input); },
    });
    harness.chat[0].is_hidden = true;
    const result = await harness.runtime.intercept([structuredClone(harness.userMessage)], 12000, null, 'normal');
    assert.equal(selectorCalls, 1, '复核不能重新调用选材'); assert.equal(prepareCalls, 2); assert.equal(rootCalls, 2);
    assert.equal(result.lastRecall.status, kind === 'advanced' ? 'ready' : 'stale', kind);
    if (kind === 'advanced') {
      assert.ok(result.lastRecall.injectionText); assert.equal(harness.saves, 1);
    } else {
      assert.deepEqual(result.lastRecall.skipReasons, [kind === 'removed' ? 'selectedRefsChanged' : 'sourceUnavailable']);
      assert.ok(harness.prompts.every(call => !call[1])); assert.equal(harness.saves, 0);
    }
  }
});

test('fresh准备后的补充root读取失败不能提交已选材料，也不重新调用选材', async () => {
  const initial = await singleFloorReachable({ revision: 1, head: 'head-before' });
  const captured = await singleFloorReachable({ revision: 2, head: 'head-after' });
  const prepared = structuredClone(captured); prepared.rootRevision = 3;
  let prepareCalls = 0, rootCalls = 0, selectorCalls = 0, aborted = false;
  const harness = createRuntimeHarness({
    prepareMemory: async () => ({ status: 'ready', reachable: structuredClone(++prepareCalls === 1 ? initial : prepared) }),
    rootReader: async () => ++rootCalls === 1 ? { status: 'ready', revision: captured.rootRevision, data: structuredClone(captured.root) }
      : { status: 'unavailable', error: { code: 'ROOT_READ_FAILED', message: '根记录读取失败' } },
    selector: input => { selectorCalls++; return selectRecall(input); },
  });
  harness.chat[0].is_hidden = true;
  const result = await harness.runtime.intercept([structuredClone(harness.userMessage)], 12000, value => { aborted = value === true; }, 'normal');
  assert.equal(result.lastRecall.status, 'error'); assert.equal(result.lastRecall.error.code, 'ROOT_READ_FAILED');
  assert.equal(result.lastRecall.sourceVerification.rootStatus, 'unavailable');
  assert.equal(result.lastRecall.finalVerification.failure.step, 'sourcePreparation');
  assert.equal(result.lastRecall.finalVerification.failure.reason, 'sourceUnavailable');
  assert.equal(selectorCalls, 1); assert.equal(harness.saves, 0); assert.ok(harness.prompts.every(call => !call[1])); assert.equal(aborted, true);
});

test('fresh来源明确stale时保留来源版本、root核验阶段与sourceStale终止原因', async () => {
  const initial = await singleFloorReachable({ revision: 1, head: 'head-before' });
  let prepareCalls = 0, selectorCalls = 0;
  const harness = createRuntimeHarness({
    prequel: '已导入的过去经历，继续验证既有旧档召回管线。',
    prepareMemory: async () => ++prepareCalls === 1 ? { status: 'ready', reachable: structuredClone(initial) } : { status: 'stale' },
    rootReader: async () => ({ status: 'ready', revision: 2, data: { ...structuredClone(initial.root), headCheckpointId: 'head-after' } }),
    selector: input => { selectorCalls += 1; return selectRecall(input); },
  });
  const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(selectorCalls, 1); assert.equal(prepareCalls, 2);
  assert.deepEqual(result.lastRecall.skipReasons, ['sourceStale']);
  assert.equal(result.lastTerminated.reason, 'sourceStale');
  assert.equal(result.lastRecall.sourceVerification.preparationStatus, 'stale');
  assert.equal(result.lastRecall.sourceVerification.selectedSource.revision, 1);
  assert.equal(result.lastRecall.sourceVerification.checkedRoot.revision, 2);
  assert.equal(result.lastRecall.finalVerification.failure.step, 'sourcePreparation');
  assert.equal(result.lastRecall.finalVerification.failure.reason, 'sourceStale');
  assert.ok(harness.prompts.every(call => call[1] === ''));
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
    prequel: '已导入的过去经历，继续验证既有旧档召回管线。',
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

test('runtime 在LLM选材等待中STOP/ENDED/切聊会留最后步骤且不以fallback复活旧BM25', async () => {
  for (const [event, sourceEvent] of [['generation-stopped', 'GENERATION_STOPPED'], ['generation-ended', 'GENERATION_ENDED'], ['chat-changed', 'CHAT_CHANGED']]) {
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const harness = createRuntimeHarness({ useDefaultSelector: true,
      generateUtilityTask: async ({ signal }) => { entered(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })); },
    });
    harness.handlers.get('generation-started')('normal', null, false);
    const pending = harness.runtime.intercept(harness.chat, 12000, null, 'normal');
    await started;
    if (event === 'chat-changed') harness.context.chatMetadata.qianqianjie.chatId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    harness.handlers.get(event)();
    const result = await pending;
    if (event === 'chat-changed') assert.equal(result.recallStatus, 'idle', event);
    else {
      assert.equal(result.lastRecall.status, 'stale', event); assert.deepEqual(result.lastRecall.skipReasons, ['stopped']);
      assert.equal(result.lastRecall.terminationEvent, sourceEvent);
      assert.equal(result.lastRecall.diagnosticPhase, 'selecting');
      assert.equal(result.lastRecall.selectionStatus, 'incomplete');
      assert.equal(result.lastRecall.pendingStep, 'utilityTask');
      assert.equal(result.lastRecall.lastCompletedStep, 'candidateBuild');
      assert.ok(Number.isFinite(result.lastRecall.timings.totalMs));
      assert.equal(result.lastRecall.injectionText, '');
      assert.equal(result.lastRecall.receiptPersistence, 'none');
    }
    assert.ok(harness.prompts.every(call => call[1] === ''), event);
    assert.equal(harness.runtime.getState().lastTerminated.sourceEvent, sourceEvent, event);
    assert.equal(harness.runtime.getState().lastTerminated.pendingStep, 'utilityTask', event);
    assert.equal(harness.runtime.getState().lastTerminated.lastCompletedStep, 'candidateBuild', event);
    assert.equal(harness.saves, 0, event);
  }
});

test('来源准备途中停止会冻结在途阶段与计时，迟到准备不改终止回执', async () => {
  let enterPrepare, releasePrepare;
  const preparing = new Promise(resolve => { enterPrepare = resolve; });
  const latePreparation = new Promise(resolve => { releasePrepare = resolve; });
  const harness = createRuntimeHarness({ prepareMemory: () => { enterPrepare(); return latePreparation; } });
  harness.handlers.get('generation-started')('normal');
  const pending = harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  await preparing;
  harness.handlers.get('generation-stopped')();
  const result = await pending;
  const receipt = result.lastRecall;
  const preparation = receipt.timings.preparationAttempts?.at(-1);
  assert.equal(receipt.terminationEvent, 'GENERATION_STOPPED');
  assert.equal(receipt.diagnosticPhase, 'source');
  assert.equal(receipt.pendingStep, 'prepare');
  assert.equal(preparation?.stage, 'prepare');
  assert.equal(preparation?.status, 'inProgress');
  assert.ok(Number.isFinite(preparation?.prepareMs));
  assert.equal(preparation?.totalMs, undefined, '缺少准备起点时不把阶段和伪装成准备总耗时');
  assert.equal(receipt.injectionText, '');
  releasePrepare({ status: 'unavailable' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.runtime.getState().lastRecall, receipt);
  assert.equal(receipt.timings.preparationAttempts.at(-1).status, 'inProgress');
});

test('真实runtime与私有记录器在LLM挂起时保留向量阶段，STOP后留下细步且不留prompt', async t => {
  const source = runtimeFixture(), rawText = '钟楼旧约的现场正文。';
  source.rawSources = [{ floorId: source.floorMemories[0].floorId, assistantSeq: source.floorMemories[0].assistantSeq,
    floorMemoryId: source.floorMemories[0].floorMemoryId, memoryFloorId: source.floorMemories[0].floorId,
    memoryAssistantSeq: source.floorMemories[0].assistantSeq, canonicalContent: rawText, fingerprint: await fingerprintText(rawText) }];
  const records = new Map(); let resolveUtility, utilityStarted;
  const enteredUtility = new Promise(resolve => { utilityStarted = resolve; });
  const vectorConfig = { url: 'https://vector.invalid/v1', model: 'mock', key: 'sentinel-vector-key', dimensions: 2 };
  const vectorRuntime = createVectorIndex({ client: {
    async get(_collection, id) { if (!records.has(id)) throw Object.assign(new Error('missing'), { status: 404 }); return structuredClone(records.get(id)); },
    async put(_collection, id, data, revision) { const previous = records.get(id); assert.equal(revision, previous?.revision ?? 0);
      const result = { revision: revision + 1, data: structuredClone(data) }; records.set(id, result); return result; },
  }, configProvider: () => vectorConfig, identityProvider: () => ({ chatId: source.chatId }), sourceProvider: async () => source,
  api: { async embed(_config, texts, options = {}) {
    if (typeof options.onProgress === 'function') options.onProgress({ requestId: 'integration-vector-request', startedAt: new Date(NOW).toISOString(), inputCharacters: texts[0]?.length ?? 0,
      inputSha256: `sha256:${'a'.repeat(64)}`, deadlineMs: 15000, timeoutMs: 15000, phase: 'request', pendingStage: 'response_headers', lastSuccessfulStage: 'response_headers',
      responseHeadersMs: 23, httpStatus: 200 });
    return texts.map(() => [1, 0]);
  } } });
  await vectorRuntime.build();
  const store = new Map();
  const privateDiagnostics = createPrivateRecallDiagnostics({
    client: { async get(_collection, id) { if (!store.has(id)) throw { status: 404 }; return structuredClone(store.get(id)); },
      async put(_collection, id, data, revision) { const value = { revision: revision + 1, data: structuredClone(data) }; store.set(id, value); return value; } },
    recallRuntime: { getState: () => harness.runtime.getState(), subscribe: fn => harness.runtime.subscribe(fn) }, vectorRuntime,
    fetchImpl: async () => ({ ok: true, json: async () => ({ enabled: true }) }), isEnabled: () => true, random: () => 0, pollMs: 1000000, flushMs: 1000000,
  });
  t.after(privateDiagnostics.dispose);
  let harness;
  harness = createRuntimeHarness({ useDefaultSelector: true, sourceReader: async () => structuredClone(source),
    semanticProvider: input => vectorRuntime.query({ source: input.source, queryContext: input.queryContext, signal: input.signal }),
    generateUtilityTask: ({ signal }) => { utilityStarted(); return new Promise((resolve, reject) => {
      resolveUtility = resolve; signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }); } });
  await privateDiagnostics.start();
  harness.handlers.get('generation-started')('normal');
  const pending = harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  await enteredUtility;
  assert.equal(harness.runtime.getState().activeRecall.pendingStep, 'utilityTask');
  await privateDiagnostics.flush();
  const waiting = [...store.values()][0].data.events.at(-1).data;
  assert.equal(waiting.active.selectorProgress.pendingStep, 'utilityTask');
  assert.equal(waiting.vector.query.status, 'ready');
  assert.equal(waiting.vector.query.request.requestId, 'integration-vector-request');
  assert.equal(waiting.vector.query.request.httpStatus, 200);
  assert.doesNotMatch(JSON.stringify(waiting), /sentinel-vector-key|现场正文|requestBody|responseText/u);
  harness.handlers.get('generation-stopped')();
  const stopped = await pending;
  assert.equal(stopped.lastRecall.status, 'stale'); assert.ok(harness.prompts.every(call => call[1] === ''));
  await privateDiagnostics.flush();
  const final = [...store.values()][0].data.events.at(-1).data;
  assert.equal(final.lastTerminated.sourceEvent, 'GENERATION_STOPPED');
  assert.equal(final.lastTerminated.pendingStep, 'utilityTask');
  assert.equal(final.lastTerminated.lastCompletedStep, 'candidateBuild');
  resolveUtility?.({ jsonData: { history_exclude_keys: [], state_exclude_keys: [] } });
});

test('向量两次超时预算跨真实runtime外层重算，保留本地候选与双请求安全记录', async () => {
  const source = runtimeFixture(), text = '钟楼旧约的现场正文。', raw = source.floorMemories[0];
  source.rawSources = [{ floorId: raw.floorId, assistantSeq: raw.assistantSeq, floorMemoryId: raw.floorMemoryId,
    memoryFloorId: raw.floorId, memoryAssistantSeq: raw.assistantSeq, canonicalContent: text, fingerprint: await fingerprintText(text) }];
  const records = new Map(); let building = true, vectorCalls = 0, rootCalls = 0, utilityCalls = 0, localCandidateCounts = [];
  const vectorConfig = { url: 'https://vector.invalid/v1', model: 'mock', key: 'secret-vector-key', dimensions: 2 };
  const vectorRuntime = createVectorIndex({ client: {
    async get(_collection, id) { if (!records.has(id)) throw Object.assign(new Error('missing'), { status: 404 }); return structuredClone(records.get(id)); },
    async put(_collection, id, data, revision) { const previous = records.get(id); assert.equal(revision, previous?.revision ?? 0);
      const result = { revision: revision + 1, data: structuredClone(data) }; records.set(id, result); return result; },
  }, configProvider: () => vectorConfig, identityProvider: () => ({ chatId: source.chatId }), sourceProvider: async () => source,
  api: { async embed(_config, texts, options = {}) {
    if (building) return texts.map(() => [1, 0]);
    const index = ++vectorCalls, request = { requestId: `retry-request-${index}`, startedAt: new Date(NOW).toISOString(), inputCharacters: texts[0].length,
      inputSha256: `sha256:${'c'.repeat(64)}`, timeoutMs: 15000, deadlineMs: 15000, phase: 'aborted', pendingStage: 'aborted',
      lastSuccessfulStage: 'fetch_called', timeoutOrigin: 'vector_api_deadline', abortOrigin: 'vector_api_deadline', abortReason: 'timeout' };
    options.onProgress?.(request); options.onDiagnostic?.(request);
    throw Object.assign(new Error('safe timeout'), { code: 'VECTOR_TIMEOUT' });
  } } });
  await vectorRuntime.build(); building = false;
  const harness = createRuntimeHarness({ useDefaultSelector: true, sourceReader: async () => structuredClone(source),
    rootReader: async () => ++rootCalls === 1 ? { status: 'unavailable' }
      : { status: 'ready', revision: source.rootRevision, data: { chatId: source.chatId, narrativeGeneration: source.narrativeGeneration, headCheckpointId: source.headCheckpointId } },
    semanticProvider: input => vectorRuntime.query({ source: input.source, queryContext: input.queryContext, signal: input.signal }),
    generateUtilityTask: async ({ taskMessages }) => {
      utilityCalls++; const payload = JSON.parse(taskMessages[0].content); localCandidateCounts.push(payload.candidates.length);
      return { jsonData: { history_exclude_keys: [], state_exclude_keys: [] } };
    } });
  const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(result.lastRecall.status, 'ready'); assert.equal(result.lastRecall.diagnosticAttempt, 1);
  assert.equal(rootCalls, 2); assert.equal(utilityCalls, 1); assert.equal(vectorCalls, 2, '向量独立两次超时额度保持，提交重试不重复选材');
  assert.ok(localCandidateCounts.every(count => count > 0), '语义失败仍把本地候选送入既有LLM选材');
  const attempts = result.lastRecall.selectorDiagnostic.semantic.requestAttempts;
  assert.equal(attempts.length, 2); assert.deepEqual(attempts.map(item => item.requestId), ['retry-request-1', 'retry-request-2']);
  assert.ok(attempts.every(item => item.timeoutMs === 15000 && item.errorCode === 'VECTOR_TIMEOUT' && item.result === 'timeout' && item.lastSuccessfulStage === 'fetch_called'));
  assert.equal(result.lastRecall.selectorDiagnostic.semantic.requestCount, 2);
  assert.equal(result.lastRecall.selectorDiagnostic.semantic.retryOutcome, 'retry_failed');
  const safe = projectPrivateRecallDiagnostic(harness.runtime.getState(), vectorRuntime.getState());
  assert.equal(safe.last.selector.semantic.requestAttempts.length, 2); assert.equal(safe.vector.query.requestCount, 2);
  assert.equal(safe.vector.query.retryOutcome, 'retry_failed');
  assert.doesNotMatch(JSON.stringify(safe), /secret-vector-key|钟楼旧约的现场正文|canonicalContent|requestBody/u);
  assert.ok(harness.prompts.some(call => call[1]), '本地候选由既有LLM流程正常注入');
});

test('runtime completed-empty 是可持久化、可恢复的完成态，且不写非空 prompt', async () => {
  const harness = createRuntimeHarness({ selector: ({ source }) => ({
    status: 'empty', floors: [], states: [], coverage: source.coverage, injectionText: '',
    stages: { input: 1, candidates: 0, dropRecent: 0, dropPersistent: 0, dropVisibility: 0, selected: 0, recentSummaryCount: 0, distantHistoryItemCount: 0, stateCount: 0 },
    skipReasons: [],
  }) });
  const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(result.lastRecall.status, 'empty');
  assert.equal(result.lastRecall.receiptPersistence, 'saving');
  await flushReceiptSave();
  assert.equal(harness.runtime.getState().lastRecall.receiptPersistence, 'saveUnconfirmed');
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
  assert.equal(harness.runtime.getPromptSnapshot(), null, '仅恢复历史回执不得重新暴露已清除的 prompt 材料');
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

test('历史签名回执 schema16 与旧17仍可只读恢复，读取不重签或改写封签', async () => {
  const harness = createRuntimeHarness();
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const current = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
  for (const schemaVersion of [16, 17]) {
    const historical = stripSummaryWitnessesForLegacyReceipt(structuredClone(current));
    historical.schemaVersion = schemaVersion;
    for (const key of ['pendingStep', 'lastCompletedStep', 'stageTimings']) delete historical.selectorDiagnostic?.[key];
    if (historical.selectorDiagnostic?.semantic?.request) for (const key of ['requestId', 'inputSha256', 'deadlineMs', 'elapsedMs', 'deadlineOverrunMs', 'timeoutOrigin', 'abortOrigin', 'abortReason', 'networkCode', 'providerRequestId', 'pendingStage', 'lastSuccessfulStage']) delete historical.selectorDiagnostic.semantic.request[key];
    historical.receiptFingerprint = await receiptFingerprint(historical);
    const saved = structuredClone(historical);
    const projected = await projectHistoricalRecallReceipt({ ...harness.userMessage, extra: { [RECALL_RECEIPT_KEY]: historical } }, { chatId: CHAT, userMessageIndex: 1 });
    assert.equal(projected.schemaVersion, schemaVersion);
    assert.equal(projected.injectionText, historical.injectionText);
    harness.userMessage.extra[RECALL_RECEIPT_KEY] = historical;
    harness.runtime.invalidate(`schema${schemaVersion}Restore`);
    const restored = await harness.runtime.restorePersistedReceipt();
    assert.equal(restored.lastRecall.schemaVersion, schemaVersion);
    assert.deepEqual(harness.userMessage.extra[RECALL_RECEIPT_KEY], saved, '只读恢复不重签或改写历史封签');
  }
});

test('已发布 schema17 人工摘要见证回执保留真实结构并可只读恢复，不重签或改写落盘', async () => {
  const harness = createRuntimeHarness();
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const receipt = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
  receipt.schemaVersion = 17;
  receipt.strategyVersion = 'continuity-v17';
  delete receipt.selectedLocationReferences;
  delete receipt.locationReferenceDependency;
  assert.ok(receipt.selectedFloors.length);
  const floor = receipt.selectedFloors[0];
  floor.summaryWitnesses = [{ sourceKind: 'userSummary', floorId: floor.floorId, assistantSeq: floor.assistantSeq,
    floorMemoryId: floor.floorMemoryId, memoryFloorId: floor.floorId, memoryAssistantSeq: floor.assistantSeq,
    fingerprint: await fingerprintText('旧人工摘要完整内容'), offset: 0, length: 1, textFingerprint: await fingerprintText('旧') }];
  receipt.receiptFingerprint = await receiptFingerprint(receipt);
  const saved = structuredClone(receipt);
  harness.userMessage.extra[RECALL_RECEIPT_KEY] = receipt;
  const projected = await projectHistoricalRecallReceipt(harness.userMessage, { chatId: CHAT, userMessageIndex: 1 });
  assert.equal(projected?.schemaVersion, 17);
  assert.deepEqual(projected.selectedFloors[0].summaryWitnesses, floor.summaryWitnesses, '旧字段按真实结构保留供历史展示');
  harness.runtime.invalidate('restoreSchema17SummaryWitness');
  const restored = await harness.runtime.restorePersistedReceipt();
  assert.equal(restored.lastRecall.schemaVersion, 17);
  assert.deepEqual(harness.userMessage.extra[RECALL_RECEIPT_KEY], saved, '恢复不改写或重新签名原回执');
});

test('历史楼 projector 对旧 schema6/7/8/9 保持原签名展示和真实落盘恢复，但当前生成不能复用', async () => {
  for (const schemaVersion of [6, 7, 8, 9]) {
    let selectorCalls = 0;
    const harness = createRuntimeHarness({ selector: input => { selectorCalls += 1; return selectRecall(input); } });
    await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
    const old = stripSummaryWitnessesForLegacyReceipt(structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]));
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

test('旧 continuity-v1/v2 schema9 回执只读展示和恢复，但新生成必须运行 continuity-v12 排除', async () => {
  for (const oldStrategy of ['continuity-v1', 'continuity-v2']) {
  let selectorCalls = 0;
  const harness = createRuntimeHarness({ selector: input => { selectorCalls += 1; return selectRecall(input); } });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const old = stripSummaryWitnessesForLegacyReceipt(structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]));
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
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].strategyVersion, RECALL_STRATEGY_VERSION);
  }
});

test('旧 continuity-v10/v11 回执保留20000字符只读投影与冷恢复，新生成改用v12', async () => {
  for (const strategy of ['continuity-v10', 'continuity-v11']) {
  let selectorCalls = 0;
  const harness = createRuntimeHarness({ selector: input => { selectorCalls += 1; return selectRecall(input); } });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const old = stripSummaryWitnessesForLegacyReceipt(structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]));
  old.schemaVersion = 13;
  delete old.timeDependencies;
  old.stateProgressions = [];
  old.stages.stateProgressionCount = 0;
  old.strategyVersion = strategy;
  old.injectionText = old.injectionText.padEnd(17000, ' ');
  old.receiptFingerprint = await receiptFingerprint(old);
  const projected = await projectHistoricalRecallReceipt({ ...harness.userMessage, extra: { [RECALL_RECEIPT_KEY]: structuredClone(old) } }, { chatId: CHAT, userMessageIndex: 1 });
  assert.equal(projected?.restoredReceipt, true);
  assert.equal(projected?.injectionText, old.injectionText);
  assert.deepEqual(projected?.selectedFloors, old.selectedFloors);
  if (strategy === 'continuity-v11') {
    const withState = structuredClone(old);
    withState.selectedStates.push({ stateId:'legacy-state', storylineId:withState.storylines[0].storylineId, subjectEntityId:PERSON, subject:'裴晚生', layer:'core', text:'旧人物依据', reason:'', visibility:'private', towardEntityId:null, toward:null, sourceAssistantSeq:null });
    withState.receiptFingerprint = await receiptFingerprint(withState);
    assert.ok(await projectHistoricalRecallReceipt({ ...harness.userMessage, extra: { [RECALL_RECEIPT_KEY]:withState } }, { chatId:CHAT, userMessageIndex:1 }));
    for (const invalidate of [value => { delete value.selectedStates[0].stateId; }, value => { delete value.selectedStates[0].storylineId; }, value => { delete value.selectorDiagnostic.historyCandidateCount; }]) {
      const invalid = structuredClone(withState); invalidate(invalid); invalid.receiptFingerprint = await receiptFingerprint(invalid);
      assert.equal(await projectHistoricalRecallReceipt({ ...harness.userMessage, extra: { [RECALL_RECEIPT_KEY]: invalid } }, { chatId:CHAT, userMessageIndex:1 }), null, 'v11历史校验不得因策略升级而放宽');
    }
  }
  harness.userMessage.extra[RECALL_RECEIPT_KEY] = old;
  harness.runtime.invalidate('simulateReload');
  const restored = await harness.runtime.restorePersistedReceipt();
  assert.equal(restored.lastRecall?.legacyReadOnly, true);
  assert.equal(restored.lastRecall?.injectionText, old.injectionText);
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].strategyVersion, strategy, '只读恢复不得改写旧回执');
  await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(selectorCalls, 2, '旧 v10 回执不得被当前生成直接复用');
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].strategyVersion, RECALL_STRATEGY_VERSION);
  }
});

test('旧 schema10 continuity-v5 回执保留只读展示，当前生成不复用并升级到 v11', async () => {
  let selectorCalls = 0;
  const harness = createRuntimeHarness({ selector: input => { selectorCalls += 1; return selectRecall(input); } });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const old = stripSummaryWitnessesForLegacyReceipt(structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]));
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
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].strategyVersion, RECALL_STRATEGY_VERSION);
});

test('真实签名 schema11 continuity-v7 可历史投影与冷恢复，但 regenerate 必须重算 schema15 v14', async () => {
  let selectorCalls = 0, selectedSnapshot = null;
  const harness = createRuntimeHarness({ selector: input => { selectorCalls += 1; selectedSnapshot = selectRecall(input); return selectedSnapshot; } });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const old = stripSummaryWitnessesForLegacyReceipt(structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]));
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
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].schemaVersion, RECALL_RECEIPT_SCHEMA_VERSION);
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].strategyVersion, RECALL_STRATEGY_VERSION);
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
    if (armed && String(value).startsWith(`[${RECALL_RECEIPT_SCHEMA_VERSION},"${TEST_PLUGIN_VERSION}"`)) {
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
    if (armed && String(value).startsWith(`[${RECALL_RECEIPT_SCHEMA_VERSION},"${TEST_PLUGIN_VERSION}"`)) {
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
    if (armed && String(value).startsWith(`[${RECALL_RECEIPT_SCHEMA_VERSION},"${TEST_PLUGIN_VERSION}"`)) {
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
  assert.equal(state.lastRecall.reusedReceipt, true, '新 interceptor 接管后可直接复用当前 user 的合法回执');
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

test('runtime 绑定当前用户楼后立即通知 input 阶段，异步输入准备前不误报 source 或 selecting', async () => {
  let releaseFingerprint;
  const gate = new Promise(resolve => { releaseFingerprint = resolve; });
  let sourceCalls = 0, selectorCalls = 0;
  const harness = createRuntimeHarness({
    fingerprint: async value => { await gate; return fingerprintText(value); },
    sourceReader: async () => { sourceCalls += 1; return runtimeFixture(); },
    selector: input => { selectorCalls += 1; return selectRecall(input); },
  });
  const states = [];
  const unsubscribe = harness.runtime.subscribe(state => states.push(state));
  const running = harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.deepEqual(Object.fromEntries(['token', 'generationType', 'phase', 'chatId', 'userMessageIndex', 'pendingStep'].map(key => [key, states.at(-1)?.activeRecall?.[key]])),
    { token: 1, generationType: 'normal', phase: 'input', chatId: CHAT, userMessageIndex: 1, pendingStep: 'prequelSelection' });
  assert.deepEqual([sourceCalls, selectorCalls], [0, 0], '绑定通知不得提前开始来源读取或选择');
  releaseFingerprint();
  await running; unsubscribe();
  assert.ok(states.some(state => state.activeRecall?.phase === 'source'));
  assert.ok(states.some(state => state.activeRecall?.phase === 'selecting'));
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

test('同一 user 的 normal/regenerate/swipe/continue 复用首次选材并核当前辅助资料，删楼同字新对象才 fresh', async () => {
  const calls = { source: 0, root: 0, identity: 0, time: 0, qianshi: 0, selector: 0 };
  let queryRevision = 0;
  let currentSource = runtimeFixture();
  const queryBuilder = options => {
    const value = buildRecallQueryContext(options);
    return { ...value, text: `${value.text}\n后台查询版本 ${queryRevision}` };
  };
  const harness = createRuntimeHarness({
    queryBuilder,
    sourceReader: async () => { calls.source += 1; return structuredClone(currentSource); },
    rootReader: async () => { calls.root += 1; return { status: 'ready', revision: currentSource.rootRevision, data: {
      chatId: currentSource.chatId, narrativeGeneration: currentSource.narrativeGeneration, headCheckpointId: currentSource.headCheckpointId,
    } }; },
    identityProjectionProvider: async () => { calls.identity += 1; return { identityRedirectsByEntityId: {}, deletedEntityIds: [] }; },
    timeProjectionProvider: async () => { calls.time += 1; return { fingerprint: `time-${queryRevision}`, corrections: {}, reminders: [] }; },
    qianshiProgressProvider: source => { calls.qianshi += 1; return { anchor: { narrativeGeneration: source.narrativeGeneration, headCheckpointId: source.headCheckpointId },
      projectionVersion: queryRevision, text: `[当前剧情进度]\n- 首轮材料 ${queryRevision}`, eventIds: [`event-${queryRevision}`], matterIds: [`matter-${queryRevision}`] }; },
    selector: input => { calls.selector += 1; return selectRecall(input); },
  });
  const first = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const originalReceipt = structuredClone(harness.userMessage.extra[RECALL_RECEIPT_KEY]);
  const originalInjection = originalReceipt.injectionText;
  assert.equal(first.lastRecall.reusedReceipt, false);
  assert.match(originalInjection, /首轮材料 0/u);

  for (const key of Object.keys(calls)) calls[key] = 0;
  currentSource = { ...currentSource, rootRevision: currentSource.rootRevision + 1, headCheckpointId: 'background-head',
    currentState: [], floorMemories: currentSource.floorMemories.slice(1) };
  for (const type of ['normal', 'regenerate', 'swipe', 'continue']) {
    queryRevision += 1;
    harness.chat[0].mes = `后台正文已推进 ${queryRevision}`;
    const reused = await harness.runtime.intercept(harness.chat, 12000, null, type);
    assert.equal(reused.lastRecall.reusedReceipt, true, type);
    assert.equal(reused.lastRecall.injectionText, originalInjection, type);
    assert.equal(latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT), originalInjection, type);
  }
  assert.deepEqual(calls, { source: 0, root: 0, identity: 4, time: 0, qianshi: 4, selector: 0 }, '每次只核当前千事删除状态，不回读整图或重选材');
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].receiptFingerprint, originalReceipt.receiptFingerprint, '复用不得重签或重存原回执');

  harness.runtime.invalidate('simulateReload');
  await harness.runtime.restorePersistedReceipt();
  for (const key of Object.keys(calls)) calls[key] = 0;
  const restoredReuse = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(restoredReuse.lastRecall.reusedReceipt, true);
  assert.equal(restoredReuse.lastRecall.injectionText, originalInjection);
  assert.deepEqual(calls, { source: 0, root: 0, identity: 1, time: 0, qianshi: 1, selector: 0 }, '刷新后复票只核当前人工和删除投影，不回读整图或重选');

  const replacement = { is_user: true, is_system: false, mes: harness.userMessage.mes };
  harness.chat.splice(1, 1, replacement);
  harness.handlers.get('message-deleted')(harness.chat.length);
  for (const key of Object.keys(calls)) calls[key] = 0;
  const fresh = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(fresh.lastRecall.reusedReceipt, false);
  assert.equal(calls.selector, 1, '同字同索引的新 user 对象必须重新选材');
  assert.equal(calls.source > 0, true);
  assert.ok(replacement.extra?.[RECALL_RECEIPT_KEY]);
});

test('runtime 同 user 下人工映射后台变化不再改写首次回执', async () => {
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
  projection = { identityRedirectsByEntityId: { [PERSON]: '99999999-9999-4999-8999-999999999999' }, deletedEntityIds: [], manualAliasesByEntityId: { [PERSON]: ['新称'] } };
  const next = await harness.runtime.intercept(harness.chat, 12000, null, 'continue');
  assert.equal(selectorCalls, 1); assert.equal(next.lastRecall.reusedReceipt, true);
  assert.deepEqual(historicalReceipt.selectedFloors, harness.userMessage.extra[RECALL_RECEIPT_KEY].selectedFloors, '旧快照内容本身不因映射被原地改写');
});

test('runtime 拒绝篡改回执与 user 正文变化，但同 user 的 head/revision/引用推进冻结复用', async () => {
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
  const frozen = harness.userMessage.extra[RECALL_RECEIPT_KEY].injectionText;
  currentSource = { ...currentSource, headCheckpointId: 'changed-head', rootRevision: 2 };
  let result = await harness.runtime.intercept(harness.chat, 12000, null, 'continue');
  assert.equal(selectorCalls, 3, '同 user 的新 head 不触发重选');
  assert.equal(result.lastRecall.injectionText, frozen);
  currentSource = { ...currentSource, floorMemories: currentSource.floorMemories.filter(value => value.assistantSeq !== 2) };
  result = await harness.runtime.intercept(harness.chat, 12000, null, 'swipe');
  assert.equal(selectorCalls, 3, '同 user 的来源引用推进不触发重选');
  assert.equal(result.lastRecall.injectionText, frozen);
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

test('runtime 已有同 user 回执时 source 后续异常不再进入读取链', async () => {
  let fail = false, failedReads = 0, abortCalls = 0;
  const harness = createRuntimeHarness({ sourceReader: async () => {
    if (fail) { failedReads += 1; throw Object.assign(new Error('token=sk-secret-1234567890'), { code: 'SOURCE_FAILED' }); }
    return runtimeFixture();
  } });
  await harness.runtime.intercept(harness.chat, 12000, () => { abortCalls += 1; }, 'normal');
  assert.ok(harness.prompts.at(-1)[1]);
  fail = true;
  const result = await harness.runtime.intercept(harness.chat, 12000, () => { abortCalls += 1; }, 'normal');
  assert.equal(result.recallStatus, 'ready');
  assert.equal(result.lastRecall.reusedReceipt, true);
  assert.ok(result.lastRecall.injectionText);
  assert.equal(failedReads, 0);
  assert.equal(abortCalls, 0);
});

test('runtime 旧异步请求迟到不得覆盖或清除新 generation 的 prompt', async () => {
  let resolveFirst;
  const first = new Promise(resolve => { resolveFirst = resolve; });
  let markEntered; const entered = new Promise(resolve => { markEntered = resolve; });
  let calls = 0;
  const harness = createRuntimeHarness({ sourceReader: async () => { if (++calls === 1) { markEntered(); return first; } return runtimeFixture(); } });
  const oldRun = harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  await entered;
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

test('runtime 无 saveChat 时按 user 对象保留 session-only，assistant 后台变化仍复用', async () => {
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
  assert.equal(result.lastRecall.reusedReceipt, true);
  assert.equal(selectorCalls, 1);
  harness.chat[0].mes = 'assistant 正文真的改变';
  harness.handlers.get('message-edited')(harness.chat.length);
  assert.equal(harness.runtime.getState().lastRecall?.status, 'ready', '正文变化只失效活动数据，不抹历史展示');
  result = await harness.runtime.intercept(structuredClone(harness.chat), 12000, null, 'continue');
  assert.equal(result.lastRecall.reusedReceipt, true);
  assert.equal(selectorCalls, 1);
});

test('runtime 长聊天绑定只检查有界近期正文，不复制整张 playable 正文', async () => {
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
  assert.ok(oldMessageReads <= 20, `近期基座扫描必须有界，不得读取整张长聊天正文（实际读取 ${oldMessageReads} 条）`);
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
  assert.equal(fresh.lastRecall.receiptPersistence, 'saving');
  await flushReceiptSave();
  assert.equal(harness.runtime.getState().lastRecall.receiptPersistence, 'saveUnconfirmed');
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
  assert.equal(swallowedResult.lastRecall.receiptPersistence, 'saving');
  await flushReceiptSave();
  assert.equal(swallowed.runtime.getState().lastRecall.receiptPersistence, 'saveUnconfirmed');
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
  assert.equal(copiedResult.lastRecall.receiptPersistence, 'saving');
  await flushReceiptSave();
  assert.equal(copied.runtime.getState().lastRecall.receiptPersistence, 'saveUnconfirmed');
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

test('runtime 当前态回执保留合法原因长度，恢复后同用户重生成可复用', async () => {
  for (const reasonLength of [1000, 1001, 4000]) {
    const raw = reachable();
    const state = raw.stateDeltas[0].subjectSnapshots[0].situational[0];
    state.text = '仍记得钟楼赴约';
    state.reason = '证'.repeat(reasonLength);
    let selections = 0;
    const sourceReader = ({ now }) => readRecallSource({ store: { readReachable: async () => structuredClone(raw) }, now });
    const harness = createRuntimeHarness({
      sourceReader,
      reachableReader: async () => structuredClone(raw),
      queryBuilder: () => ({ text: '钟楼赴约', latestUserText: '钟楼赴约', latestUserCoreIndex: 1, messageCount: 1, assistantTurns: 0 }),
      selector: input => { selections += 1; return selectRecall(input); },
    });

    const first = await harness.runtime.intercept(harness.chat, 20000, null, 'normal');
    assert.equal(first.lastRecall.status, 'ready', `${reasonLength}字首轮应正常完成`);
    const receipt = harness.userMessage.extra[RECALL_RECEIPT_KEY];
    const selectedState = receipt.selectedStates.find(value => value.text === state.text);
    assert.equal(selectedState?.reason.length, reasonLength, `${reasonLength}字依据应完整进入已签回执`);
    const historical = await projectHistoricalRecallReceipt(harness.userMessage, { chatId: CHAT, userMessageIndex: 1 });
    assert.equal(historical?.selectedStates.find(value => value.text === state.text)?.reason.length, reasonLength,
      `${reasonLength}字依据应通过正式历史展示读取`);

    const reloaded = createRuntimeHarness({
      sourceReader,
      reachableReader: async () => structuredClone(raw),
      queryBuilder: () => ({ text: '钟楼赴约', latestUserText: '钟楼赴约', latestUserCoreIndex: 1, messageCount: 1, assistantTurns: 0 }),
      selector: input => { selections += 1; return selectRecall(input); },
    });
    reloaded.chat.splice(0, reloaded.chat.length, ...structuredClone(harness.chat));
    const restored = await reloaded.runtime.restorePersistedReceipt();
    assert.equal(restored.lastRecall?.restoredReceipt, true, `${reasonLength}字合法依据回执应能恢复`);
    assert.equal(restored.lastRecall.selectedStates.find(value => value.text === state.text)?.reason.length, reasonLength);

    const regenerated = await reloaded.runtime.intercept(reloaded.chat, 20000, null, 'regenerate');
    assert.equal(regenerated.lastRecall.reusedReceipt, true, `${reasonLength}字合法依据应能供同用户重生成复用`);
    assert.equal(selections, 1, `${reasonLength}字复用不应重新选材`);
    if (reasonLength === 4000) {
      const invalid = structuredClone(receipt);
      invalid.selectedStates.find(value => value.text === state.text).reason += '证';
      // 合成的超限字段夹具保留有效封签，只用于核验结构上限仍拒绝 4001 字。
      invalid.receiptFingerprint = await receiptFingerprint(invalid);
      const invalidReload = createRuntimeHarness({ sourceReader, reachableReader: async () => structuredClone(raw) });
      invalidReload.chat.splice(0, invalidReload.chat.length, ...structuredClone(reloaded.chat));
      const invalidUser = invalidReload.chat.find(message => message.is_user);
      invalidUser.extra[RECALL_RECEIPT_KEY] = invalid;
      assert.equal((await invalidReload.runtime.restorePersistedReceipt()).lastRecall, null, '超过既有4000字字段合同的回执仍须拒绝');
    }
  }
});

test('runtime 正文去重只为核心见证和最近可见楼核指纹，旧摘要保持可选', async () => {
  for (const floorCount of [8, 16]) for (const hideOldFloors of [false, true]) {
    const messageTexts = Array.from({ length: floorCount }, (_, index) => `The blue lighthouse key was recorded at floor ${index + 1}.`);
    const memories = messageTexts.map((_, index) => recallMemory(index + 1, { summary: `The blue lighthouse key appears in historical material ${index + 1}.` }));
    const source = selectorSource({ memories });
    source.readiness = { status: 'caughtUp', hostConfirmed: true, visibleSummaryFloorIds: memories.map(value => value.floorId) };
    source.bodyMatchRefs = [];
    for (let index = 0; index < floorCount; index += 1) {
      const text = messageTexts[index];
      source.bodyMatchRefs.push({
        floorId: `floor-${index + 1}`, floorMemoryId: `memory-${index + 1}`, assistantSeq: index + 1,
        hostLocator: { messageIndex: index, swipeId: null, selectedSwipeIndex: null },
        rawFingerprint: await fingerprintText(text), canonicalFingerprint: await fingerprintText(text),
      });
    }

    const measuredAttachHashes = [];
    let bodyMatch = null, selectorCalls = 0;
    const fingerprint = async value => {
      const text = String(value ?? '');
      if (messageTexts.includes(text) && (new Error().stack ?? '').includes('attachCoreBodyMatch')) measuredAttachHashes.push(text);
      return `sha256:${await sha256(text)}`;
    };
    const harness = createRuntimeHarness({
      sourceReader: async () => structuredClone(source),
      rootReader: async () => ({ status: 'ready', revision: source.rootRevision,
        data: { chatId: source.chatId, narrativeGeneration: source.narrativeGeneration, headCheckpointId: source.headCheckpointId } }),
      queryBuilder: () => ({ text: 'blue lighthouse key', latestUserText: 'blue lighthouse key', latestUserCoreIndex: 3, messageCount: 1, assistantTurns: 0 }),
      fingerprint,
      selector: input => { selectorCalls += 1; bodyMatch = structuredClone(input.source.bodyMatch); return selectRecall(input); },
    });
    const messages = messageTexts.map((mes, index) => ({ is_user: false, is_system: hideOldFloors && index < floorCount - 3, mes, swipe_id: null }));
    harness.chat.splice(0, harness.chat.length, ...messages, harness.userMessage);
    harness.userMessage.mes = 'Tell me about the blue lighthouse key.';

    const result = await harness.runtime.intercept(harness.chat.slice(-4), 20000, null, 'normal');
    assert.equal(result.lastRecall.status, 'ready', `${floorCount} 楼, hidden=${hideOldFloors}`);
    assert.equal(selectorCalls, 1);
    assert.deepEqual(bodyMatch.coveredFloorIds, [`floor-${floorCount - 2}`, `floor-${floorCount - 1}`, `floor-${floorCount}`]);
    assert.deepEqual(bodyMatch.recentBodyFloorIds, [`floor-${floorCount - 2}`, `floor-${floorCount - 1}`, `floor-${floorCount}`]);
    assert.deepEqual(result.lastRecall.selectedFloors.map(value => value.assistantSeq), Array.from({ length: floorCount - 3 }, (_, index) => index + 1),
      '未覆盖的旧摘要在楼层可见或普通隐藏时仍可按原顺序选入');
    assert.equal(measuredAttachHashes.length, 6, '正文核验只对最近三条可见楼各计算raw与canonical指纹');
  }
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
  assert.equal(result.lastRecall.receiptPersistence, 'saving');
  const readyWait = result.lastRecall.timings.totalMs;
  await flushReceiptSave();
  assert.equal(harness.runtime.getState().lastRecall.receiptPersistence, 'sessionOnly');
  assert.equal(harness.runtime.getState().lastRecall.receiptSaveDiagnostic.status, 'failed');
  assert.equal(projectPrivateRecallDiagnostic(harness.runtime.getState(), null).receiptSaveDiagnostic.status, 'failed');
  assert.equal(harness.runtime.getState().lastRecall.timings.totalMs, readyWait);
  assert.ok(harness.prompts.at(-1)[1], '最终回执保存失败不得反向清除已经 commit 的 prompt');
  assert.equal(harness.userMessage.extra.concurrentField, 'must-survive');
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY], undefined, '保存失败不得在聊天中留下半成品回执');
  const reused = await harness.runtime.intercept(harness.chat, 12000, null, 'continue');
  assert.equal(reused.lastRecall.reusedReceipt, true, '会话内 committed 证明仍可安全复用');
  assert.equal(reused.lastRecall.receiptPersistence, 'sessionOnly');
  assert.equal(harness.saves, 1, '复用不应再次保存');
});

test('runtime 诊断区分核验与宿主保存计时，不改变保存次数或历史回执格式', async t => {
  let tick = Date.now();
  t.mock.method(Date, 'now', () => tick);
  const harness = createRuntimeHarness({
    fingerprint: async value => { tick += 7; return fingerprintText(value); },
    selector: input => { tick += 13; return selectRecall(input); },
    saveChat: async () => { await flushReceiptSave(); tick += 120000; },
  });
  const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(result.lastRecall.status, 'ready'); assert.equal(harness.saves, 1);
  assert.equal(result.lastRecall.receiptPersistence, 'saving');
  assert.equal(result.lastRecall.timings.receiptMs, undefined);
  await flushReceiptSave();
  const settled = harness.runtime.getState().lastRecall;
  assert.equal(settled.timings.receiptMs, 120000);
  assert.equal(settled.timings.totalMs, result.lastRecall.timings.totalMs);
  assert.ok(settled.timings.totalMs < 120000);
  assert.ok(result.lastRecall.timings.commitMs >= 7);
  assert.equal(result.lastRecall.timings.selectorMs, 13);
  const stored = harness.userMessage.extra[RECALL_RECEIPT_KEY];
  assert.equal(stored.timings.commitMs, undefined); assert.equal(stored.timings.receiptMs, undefined);
  assert.equal(stored.requestDiagnosticId, undefined, '页面请求记录不进入历史回执');
  assert.equal(stored.schemaVersion, RECALL_RECEIPT_SCHEMA_VERSION);
});

test('runtime 首次 completed save 挂起立即 ready，同 user 复用后迟到失败只更新保存状态并回滚候选', async () => {
  let saveCalls = 0, selectorCalls = 0, rejectOldSave;
  const harness = createRuntimeHarness({
    selector: input => { selectorCalls += 1; return selectRecall(input); },
    saveChat: async () => {
      saveCalls += 1;
      if (saveCalls === 1) await new Promise((resolve, reject) => { rejectOldSave = reject; });
    },
  });
  const oldRun = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(typeof rejectOldSave, 'function');
  assert.equal(oldRun.activeRecall, null, '正文放行不等待悬挂的宿主保存');
  assert.equal(oldRun.lastRecall.status, 'ready');
  assert.equal(oldRun.lastRecall.receiptPersistence, 'saving');
  const newResult = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(newResult.lastRecall.status, 'ready');
  assert.equal(newResult.lastRecall.reusedReceipt, true);
  assert.equal(saveCalls, 1, '同 user 新 interceptor 不重复保存冻结回执');
  assert.equal(selectorCalls, 1, '同 user 冻结复用不再次选材');
  const originalFingerprint = harness.userMessage.extra[RECALL_RECEIPT_KEY].receiptFingerprint;
  harness.userMessage.extra.concurrentField = 'newer-extra';
  rejectOldSave(new Error('old save failed late'));
  await flushReceiptSave();
  const failed = harness.runtime.getState().lastRecall;
  assert.equal(failed.receiptPersistence, 'sessionOnly');
  assert.equal(failed.reusedReceipt, true);
  assert.equal(failed.timings.totalMs, newResult.lastRecall.timings.totalMs);
  assert.equal(failed.injectionText, newResult.lastRecall.injectionText);
  assert.equal(latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT), newResult.lastRecall.injectionText);
  assert.equal(harness.userMessage.extra.concurrentField, 'newer-extra');
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY], undefined, '唯一持久化失败后不得留下未确认回执');
  const session = await harness.runtime.intercept(harness.chat, 12000, null, 'continue');
  assert.equal(session.lastRecall.reusedReceipt, true);
  assert.equal(session.lastRecall.receiptPersistence, 'sessionOnly');
  assert.equal(session.lastRecall.injectionText, newResult.lastRecall.injectionText);
  assert.match(originalFingerprint, /^sha256:/);
  harness.runtime.invalidate('simulateReload');
  await harness.runtime.restorePersistedReceipt();
  assert.equal(harness.runtime.getState().lastRecall, null, 'session-only 回执刷新后不伪装成已落盘');
});

test('runtime 后台保存 resolve 可更新同 user 冻结复用，结束或停止后仍保留独立保存诊断', async () => {
  for (const ending of ['generation-ended', 'generation-stopped']) {
    let resolveSave, selections = 0;
    const h = createRuntimeHarness({ selector: input => { selections += 1; return selectRecall(input); },
      saveChat: () => new Promise(resolve => { resolveSave = resolve; }) });
    h.handlers.get('generation-started')('normal');
    const first = await h.runtime.intercept(h.chat, 12000, null, 'normal');
    assert.equal(first.lastRecall.receiptPersistence, 'saving');
    h.handlers.get(ending)();
    assert.equal(h.runtime.getState().lastRecall.status, 'ready', ending);
    assert.equal(h.runtime.getState().activeRecall, null, ending);
    resolveSave(); await flushReceiptSave();
    const settled = h.runtime.getState();
    assert.equal(settled.lastRecall.receiptPersistence, 'saveUnconfirmed', ending);
    assert.equal(typeof settled.lastRecall.timings.receiptMs, 'number', ending);
    assert.equal(settled.lastRecall.timings.totalMs, first.lastRecall.timings.totalMs, ending);
    assert.equal(settled.activeRecall, null, ending);
    assert.equal(latestPromptValue(h.prompts, RECALL_PROMPT_SLOT), '', '保存完成不得在生成收尾后重新注入');
    const reuse = await h.runtime.intercept(h.chat, 12000, null, 'continue');
    assert.equal(reuse.lastRecall.reusedReceipt, true);
    assert.equal(reuse.lastRecall.receiptPersistence, 'saveUnconfirmed');
    assert.equal(reuse.lastRecall.timings.receiptMs, settled.lastRecall.timings.receiptMs);
    assert.equal(reuse.lastRecall.timings.selectorMs, undefined, '复用不冒认旧选材计时');
    assert.equal(h.saves, 1); assert.equal(selections, 1);
  }
});

test('runtime 后台保存 resolve/reject 遇切聊、user 编辑或删除不得复活旧展示', async () => {
  for (const outcome of ['resolve', 'reject']) for (const change of ['chat', 'edit', 'delete', 'silentChat', 'silentUser']) {
    let resolveSave, rejectSave;
    const h = createRuntimeHarness({ saveChat: () => new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject; }) });
    await h.runtime.intercept(h.chat, 12000, null, 'normal');
    if (change === 'chat' || change === 'silentChat') {
      h.context.chatMetadata.qianqianjie.chatId = GEN;
      if (change === 'chat') h.handlers.get('chat-changed')();
    } else if (change === 'delete') {
      h.chat.splice(1, 1); h.handlers.get('message-deleted')(1);
    } else {
      h.userMessage.mes += ' 已编辑';
      if (change === 'edit') h.handlers.get('message-edited')(1);
    }
    const state = h.runtime.getState(), prompt = latestPromptValue(h.prompts, RECALL_PROMPT_SLOT);
    if (outcome === 'resolve') resolveSave(); else rejectSave(new Error('stale save rejected'));
    await flushReceiptSave();
    assert.equal(h.runtime.getState().lastRecall, state.lastRecall, `${outcome}/${change}`);
    assert.equal(h.runtime.getState().activeRecall, null, `${outcome}/${change}`);
    assert.equal(latestPromptValue(h.prompts, RECALL_PROMPT_SLOT), prompt, `${outcome}/${change}`);
    if (!change.startsWith('silent')) assert.equal(state.lastRecall, null, `${outcome}/${change}`);
  }
});

test('runtime 后台保存恰在同 user 冻结复用核验期间完成，放行状态读取最新结果', async () => {
  let resolveSave, duringReuse = false, selections = 0;
  const h = createRuntimeHarness({ selector: input => { selections += 1; return selectRecall(input); },
    saveChat: () => new Promise(resolve => { resolveSave = resolve; }),
    fingerprint: async value => {
      if (duringReuse && value.startsWith('[')) {
        duringReuse = false; resolveSave(); await flushReceiptSave();
      }
      return fingerprintText(value);
    } });
  const first = await h.runtime.intercept(h.chat, 12000, null, 'normal');
  assert.equal(first.lastRecall.receiptPersistence, 'saving');
  duringReuse = true;
  const reuse = await h.runtime.intercept(h.chat, 12000, null, 'regenerate');
  assert.equal(reuse.lastRecall.reusedReceipt, true);
  assert.equal(reuse.lastRecall.receiptPersistence, 'saveUnconfirmed');
  assert.equal(typeof reuse.lastRecall.timings.receiptMs, 'number');
  assert.equal(reuse.lastRecall.timings.selectorMs, undefined);
  assert.equal(h.runtime.getState().lastRecall, reuse.lastRecall);
  assert.equal(h.saves, 1); assert.equal(selections, 1);
});

test('runtime 旧保存迟到不得覆盖新 user 的状态或同指纹新封签 owner，并保留新 extra', async t => {
  t.mock.method(Date, 'now', () => 1000);
  for (const outcome of ['resolve', 'reject']) for (const change of ['newUser', 'editBack']) {
    const saves = []; let selections = 0;
    const h = createRuntimeHarness({ selector: input => { selections += 1; return selectRecall(input); },
      saveChat: () => new Promise((resolve, reject) => saves.push({ resolve, reject })) });
    await h.runtime.intercept(h.chat, 12000, null, 'normal');
    const previousReceipt = h.userMessage.extra[RECALL_RECEIPT_KEY];
    if (change === 'newUser') h.chat[1] = { is_user: true, is_system: false, mes: h.userMessage.mes };
    else {
      const text = h.userMessage.mes;
      h.userMessage.mes += ' 已编辑'; h.handlers.get('message-edited')(1);
      h.userMessage.mes = text; delete h.userMessage.extra[RECALL_RECEIPT_KEY];
    }
    const next = await h.runtime.intercept(h.chat, 12000, null, 'normal');
    const user = h.chat[1], nextReceipt = user.extra[RECALL_RECEIPT_KEY];
    assert.equal(nextReceipt.receiptFingerprint, previousReceipt.receiptFingerprint, '不同选材保存也可能有相同签名');
    assert.equal(selections, 2); assert.equal(h.saves, 2);
    user.extra.concurrentField = 'new-field';
    if (outcome === 'resolve') saves[0].resolve(); else saves[0].reject(new Error('old save rejected'));
    await flushReceiptSave();
    assert.equal(h.runtime.getState().lastRecall, next.lastRecall, `${outcome}/${change}`);
    assert.equal(user.extra[RECALL_RECEIPT_KEY], nextReceipt, '旧失败 CAS 不回滚新候选');
    assert.equal(user.extra.concurrentField, 'new-field');
    assert.equal(latestPromptValue(h.prompts, RECALL_PROMPT_SLOT), next.lastRecall.injectionText);
    saves[1].resolve(); await flushReceiptSave();
    assert.equal(h.runtime.getState().lastRecall.receiptPersistence, 'saveUnconfirmed');
    assert.equal(h.runtime.getState().lastRecall.timings.totalMs, next.lastRecall.timings.totalMs);
  }
});

test('runtime 保存失败只回滚自己仍拥有的原 candidate，保留并发替换的回执与 extra', async () => {
  let rejectSave;
  const h = createRuntimeHarness({ saveChat: () => new Promise((resolve, reject) => { rejectSave = reject; }) });
  const first = await h.runtime.intercept(h.chat, 12000, null, 'normal');
  const replacement = { externallyOwned: true };
  h.userMessage.extra = { ...h.userMessage.extra, [RECALL_RECEIPT_KEY]: replacement, otherPlugin: 'keep' };
  rejectSave(new Error('save rejected')); await flushReceiptSave();
  assert.equal(h.userMessage.extra[RECALL_RECEIPT_KEY], replacement);
  assert.equal(h.userMessage.extra.otherPlugin, 'keep');
  assert.equal(h.runtime.getState().lastRecall.receiptPersistence, 'sessionOnly');
  assert.equal(h.runtime.getState().lastRecall.timings.totalMs, first.lastRecall.timings.totalMs);
  assert.equal(latestPromptValue(h.prompts, RECALL_PROMPT_SLOT), first.lastRecall.injectionText);
  const reuse = await h.runtime.intercept(h.chat, 12000, null, 'continue');
  assert.equal(reuse.lastRecall.reusedReceipt, true); assert.equal(h.saves, 1);
});

test('runtime 同 user 编辑后两次后台保存均失败，正反交错跳过失败候选并还原原历史 extra', async () => {
  for (const history of [false, true]) for (const order of ['A-B', 'B-A']) {
    const pending = []; let saveCalls = 0, selections = 0;
    const h = createRuntimeHarness({ selector: input => { selections += 1; return selectRecall(input); },
      saveChat: () => {
        saveCalls += 1;
        if (history && saveCalls === 1) return;
        return new Promise((resolve, reject) => pending.push({ resolve, reject }));
      } });
    let historicalReceipt;
    if (history) {
      await h.runtime.intercept(h.chat, 12000, null, 'normal'); await flushReceiptSave();
      historicalReceipt = h.userMessage.extra[RECALL_RECEIPT_KEY];
      h.userMessage.mes += ' 第一轮编辑'; h.handlers.get('message-edited')(1);
    }
    h.userMessage.extra = { ...h.userMessage.extra, anotherPlugin: 'initial' };
    await h.runtime.intercept(h.chat, 12000, null, 'normal');
    const candidateA = h.userMessage.extra[RECALL_RECEIPT_KEY];
    h.userMessage.mes += ' 第二轮编辑'; h.handlers.get('message-edited')(1);
    const second = await h.runtime.intercept(h.chat, 12000, null, 'normal');
    const candidateB = h.userMessage.extra[RECALL_RECEIPT_KEY];
    assert.notEqual(candidateA, candidateB); assert.equal(pending.length, 2);
    assert.equal(selections, history ? 3 : 2);
    const prompt = latestPromptValue(h.prompts, RECALL_PROMPT_SLOT);
    h.userMessage.extra.anotherPlugin = 'concurrent-first';
    const firstIndex = order === 'A-B' ? 0 : 1, secondIndex = 1 - firstIndex;
    pending[firstIndex].reject(new Error('first completed save failed')); await flushReceiptSave();
    assert.equal(h.userMessage.extra[RECALL_RECEIPT_KEY], order === 'A-B' ? candidateB : candidateA,
      `${history}/${order}: 不回滚新候选，尚在途的前驱仍可暂时还原`);
    assert.equal(h.userMessage.extra.anotherPlugin, 'concurrent-first');
    const beforeLastFailure = h.runtime.getState().lastRecall;
    if (order === 'A-B') assert.equal(beforeLastFailure, second.lastRecall, '旧 A 失败不改 B owner 展示');
    else assert.equal(beforeLastFailure.receiptPersistence, 'sessionOnly');
    h.userMessage.extra.anotherPlugin = 'concurrent-second';
    pending[secondIndex].reject(new Error('second completed save failed')); await flushReceiptSave();
    assert.equal(h.userMessage.extra[RECALL_RECEIPT_KEY], historicalReceipt,
      `${history}/${order}: 双失败不能留下 A，已有历史 H 也不能丢失`);
    assert.equal(Object.hasOwn(h.userMessage.extra, RECALL_RECEIPT_KEY), history);
    assert.equal(h.userMessage.extra.anotherPlugin, 'concurrent-second');
    const settled = h.runtime.getState().lastRecall;
    assert.equal(settled.receiptPersistence, 'sessionOnly');
    assert.equal(settled.timings.totalMs, second.lastRecall.timings.totalMs);
    assert.equal(settled.injectionText, second.lastRecall.injectionText);
    assert.equal(latestPromptValue(h.prompts, RECALL_PROMPT_SLOT), prompt);
    if (order === 'B-A') assert.equal(settled, beforeLastFailure, '旧 A 最后失败也不能改 B 状态');
  }
});

test('runtime 前轮 A 保存正常返回而编辑后 B 失败时仍还原 A，pending 前驱后来成功也不改 B 状态', async () => {
  for (const order of ['A-B', 'B-A']) {
    const pending = [];
    const h = createRuntimeHarness({ saveChat: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
    await h.runtime.intercept(h.chat, 12000, null, 'normal');
    const candidateA = h.userMessage.extra[RECALL_RECEIPT_KEY];
    h.userMessage.mes += ' 编辑后新输入'; h.handlers.get('message-edited')(1);
    const second = await h.runtime.intercept(h.chat, 12000, null, 'normal');
    const candidateB = h.userMessage.extra[RECALL_RECEIPT_KEY];
    const prompt = latestPromptValue(h.prompts, RECALL_PROMPT_SLOT);
    h.userMessage.extra.anotherPlugin = 'must-survive';
    if (order === 'A-B') {
      pending[0].resolve(); await flushReceiptSave();
      assert.equal(h.runtime.getState().lastRecall, second.lastRecall);
      assert.equal(h.userMessage.extra[RECALL_RECEIPT_KEY], candidateB);
      pending[1].reject(new Error('B failed')); await flushReceiptSave();
    } else {
      pending[1].reject(new Error('B failed')); await flushReceiptSave();
      const failedB = h.runtime.getState().lastRecall;
      assert.equal(h.userMessage.extra[RECALL_RECEIPT_KEY], candidateA);
      pending[0].resolve(); await flushReceiptSave();
      assert.equal(h.runtime.getState().lastRecall, failedB);
    }
    assert.equal(h.userMessage.extra[RECALL_RECEIPT_KEY], candidateA);
    assert.equal(h.userMessage.extra.anotherPlugin, 'must-survive');
    assert.equal(h.runtime.getState().lastRecall.receiptPersistence, 'sessionOnly');
    assert.equal(h.runtime.getState().lastRecall.timings.totalMs, second.lastRecall.timings.totalMs);
    assert.equal(latestPromptValue(h.prompts, RECALL_PROMPT_SLOT), prompt);
  }
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


test('真实成员原文经 runtime/签名/冷读按成员楼展示；摘要revision新ID保持冻结回执，改原文后失效', async () => {
  const source = runtimeFixture();
  source.floorMemories = source.floorMemories.filter(memory => memory.floorId !== 'floor-1');
  const anchor = source.floorMemories.find(memory => memory.floorId === 'floor-2');
  anchor.sourceFloorIds = ['floor-1', 'floor-2']; anchor.sourceAssistantSeqs = [1, 2];
  anchor.chronology = [{ time: { kind: 'explicit', sourceText: '启航387年夏10日', normalized: null, precision: 'exact', relativeToAssistantSeq: null }, description: '归档楼时间' }];
  const text = '当年在钟楼交换了那把蓝色钥匙，这是尚未告知阿裴的打算。';
  const raw = { floorId: 'floor-1', assistantSeq: 1, floorMemoryId: anchor.floorMemoryId, memoryFloorId: anchor.floorId, memoryAssistantSeq: anchor.assistantSeq, canonicalContent: text, fingerprint: await fingerprintText(text) };
  source.rawSources = [raw];
  const witness = { ...raw, offset: 0, length: text.length, textFingerprint: await fingerprintText(text) }; delete witness.canonicalContent;
  let selections = 0, vectors = 0, manual = false, bodyChanged = false, semanticPriorityKey = null;
  let cacheEnabled = false, rootMismatch = false, cachedReachable = null, sourceReads = 0, rootReads = 0, prepareCalls = 0, reachableReads = 0;
  const revisedMemoryId = 'memory-2-after-summary-revision';
  const makeReachable = async () => {
    const currentSource = structuredClone(source);
    if (manual) {
      currentSource.floorMemories.find(memory => memory.floorId === 'floor-2').floorMemoryId = revisedMemoryId;
      currentSource.rawSources = currentSource.rawSources.map(value => ({ ...value, floorMemoryId: revisedMemoryId }));
      currentSource.rootRevision += 1; currentSource.headCheckpointId = 'head-after-summary-revision';
    }
    const reachable = rawReachableFromSource(currentSource);
    reachable.floors.push({ id: 'floor-1', assistantSeq: 1 });
    // This fixture's saved member bodies are absent from the tiny live host list.
    // Represent them as the existing immutable archive contract, not live floors.
    reachable.migrationDescriptor = { frozenFloorIds: reachable.floors.map(floor => floor.id) };
    const memory = reachable.floorMemories.find(memory => memory.floorId === 'floor-2');
    memory.sourceFloorIds = ['floor-1', 'floor-2'];
    memory.sourceFloorSnapshots = [{ floorId: 'floor-1', canonicalContent: text }, { floorId: 'floor-2', canonicalContent: '' }];
    if (manual) memory.summary = { effectiveSource: 'user', userText: '用户重新校准了钥匙相关摘要' };
    return reachable;
  };
  const reachableReader = async () => { reachableReads += 1; return makeReachable(); };
  const sourceReader = async () => {
    sourceReads += 1;
    const current = structuredClone(source);
    if (manual) {
      current.floorMemories.find(memory => memory.floorId === 'floor-2').floorMemoryId = revisedMemoryId;
      current.rawSources = [{ ...raw, floorMemoryId: revisedMemoryId }];
      current.rootRevision += 1; current.headCheckpointId = 'head-after-summary-revision';
    } else current.rawSources = [raw];
    if (bodyChanged) {
      const content = `${text} 正文确实发生变化。`;
      current.rawSources[0] = { ...current.rawSources[0], canonicalContent: content, fingerprint: await fingerprintText(content) };
    }
    current.sourceReadAttempts = { reachableReads: 1, exitPoint: 'ready' };
    return current;
  };
  const harness = createRuntimeHarness({ sourceReader, reachableReader, useDefaultSelector: true,
    rootReader: async () => {
      rootReads += 1;
      const current = cachedReachable ?? await makeReachable();
      return { status: 'ready', revision: current.rootRevision + (rootMismatch ? 1 : 0), data: structuredClone(current.root) };
    },
    prepareMemory: async options => {
      prepareCalls += 1;
      if (!cacheEnabled) return { status: 'unavailable' };
      assert.equal(options.allowRefresh, false, '冻结见证只借既有快照，不启动刷新');
      return { status: 'ready', reachable: cachedReachable };
    },
    semanticProvider: async () => { vectors++; return { candidates: [{ text, witness }], diagnostic: { status: 'ready', candidateCount: 1,
      requestCount: 0, retryOutcome: 'cancelled', requestAttempts: [{ requestId: 'cancelled-before-fetch', phase: 'request', pendingStage: 'aborted',
        lastSuccessfulStage: 'request_prepared', result: 'cancelled', errorCode: 'VECTOR_ABORTED' }], request: {
      phase: 'complete', startedAt: '2026-10-03T13:00:00.000Z', inputCharacters: 100, timeoutMs: 8000,
      fetchCallMs: 1, responseHeadersMs: 500, responseBodyMs: 510, durationMs: 511, httpStatus: 200,
      url: 'https://vector-private.invalid', key: 'vector-private-key', text: '向量查询私密正文',
    } } }; },
    generateUtilityTask: async request => { selections++; const payload = JSON.parse(request.taskMessages[0].content);
      semanticPriorityKey = payload.candidates.find(value => value.fact.includes('当年在钟楼交换'))?.key ?? null;
      assert.ok(semanticPriorityKey, '有效sourceFragment须以本次R候选键出现');
      return { jsonData: {
        history_exclude_keys: payload.candidates.filter(value => !value.fact.includes('蓝色钥匙')).map(value => value.key), state_exclude_keys: [], priority_keys: [semanticPriorityKey],
      } };
    },
  });
  const first = await harness.runtime.intercept(harness.chat, 20000, null, 'normal');
  assert.equal(first.lastRecall.status, 'ready');
  const receipt = harness.userMessage.extra[RECALL_RECEIPT_KEY];
  const actual = receipt.selectedFloors.find(value => value.rawWitnesses?.length);
  assert.equal(actual.floorId, 'floor-1'); assert.equal(actual.assistantSeq, 1); assert.equal(actual.floorMemoryId, 'memory-2');
  assert.equal(actual.rawWitnesses[0].memoryFloorId, 'floor-2'); assert.equal(actual.rawWitnesses[0].memoryAssistantSeq, 2);
  assert.equal(receipt.selectorDiagnostic.semantic.candidateCount, 1);
  assert.equal(receipt.selectorDiagnostic.semantic.requestCount, 0, '发出请求前取消的runtime回执不从attempt数组推造HTTP调用');
  assert.equal(receipt.selectorDiagnostic.semantic.requestAttempts[0].lastSuccessfulStage, 'request_prepared');
  assert.equal(receipt.selectorDiagnostic.semantic.request.phase, 'complete');
  assert.equal(receipt.selectorDiagnostic.semantic.request.inputCharacters, 100);
  assert.deepEqual(receipt.selectorDiagnostic.priority, { status: 'applied', keys: [semanticPriorityKey], selectedKeys: [semanticPriorityKey], ignoredCount: 0 });
  assert.doesNotMatch(JSON.stringify(receipt.selectorDiagnostic.semantic), /vector-private|向量查询私密正文/u);
  const projected = await projectHistoricalRecallReceipt(harness.userMessage, { chatId: CHAT, userMessageIndex: 1 });
  assert.equal(projected.status, 'ready');
  const inline = projectInlineRecallReceipt(projected);
  assert.deepEqual(projected.selectorDiagnostic.semantic.request, receipt.selectorDiagnostic.semantic.request);
  assert.ok(inline.historyGroups.some(group => group.assistantSeq === 1));
  assert.match(receipt.injectionText, /时间未标注/);
  cachedReachable = await makeReachable(); cacheEnabled = true;
  const beforeReuseReads = { sourceReads, rootReads, prepareCalls, reachableReads };
  const second = await harness.runtime.intercept(harness.chat, 20000, null, 'regenerate');
  assert.equal(second.lastRecall.reusedReceipt, true); assert.equal(vectors, 1); assert.equal(selections, 1);
  assert.equal(sourceReads, beforeReuseReads.sourceReads, '根版本匹配的快照投影不调用完整sourceReader');
  assert.equal(rootReads, beforeReuseReads.rootReads + 1, '快照复用仅增加一次轻量root读取');
  assert.equal(prepareCalls, beforeReuseReads.prepareCalls + 1);
  assert.equal(reachableReads, beforeReuseReads.reachableReads, '已准备快照不会再读取完整reachable图');
  assert.ok(Number.isFinite(second.lastRecall.timings.sourceMs), '来源阶段计时继续落在现有sourceMs字段');
  assert.deepEqual(second.lastRecall.timings.sourceReadAttempts, { reachableReads: 0, exitPoint: 'validatedSnapshot' });
  manual = true;
  cachedReachable = await makeReachable();
  const beforeSummaryEditReads = { sourceReads, rootReads, prepareCalls, reachableReads };
  const revised = await harness.runtime.intercept(harness.chat, 20000, null, 'swipe');
  assert.equal(revised.lastRecall.reusedReceipt, true, '摘要revision换FloorMemory ID不撤销原文冻结回执');
  assert.equal(sourceReads, beforeSummaryEditReads.sourceReads, '匹配的聚合原文快照允许摘要revision后的raw-only回执复用');
  assert.equal(rootReads, beforeSummaryEditReads.rootReads + 1); assert.equal(prepareCalls, beforeSummaryEditReads.prepareCalls + 1);
  assert.equal(reachableReads, beforeSummaryEditReads.reachableReads);
  rootMismatch = true;
  const beforeMismatchReads = { sourceReads, rootReads, prepareCalls, reachableReads };
  const rootMiss = await harness.runtime.intercept(harness.chat, 20000, null, 'swipe');
  assert.equal(rootMiss.lastRecall.reusedReceipt, true, 'root失配只跳过优化，不改变原冻结回执核验结果');
  assert.equal(sourceReads, beforeMismatchReads.sourceReads + 1, 'root与快照不一致时回退原sourceReader，合法旧原文回执仍可复用');
  assert.equal(rootReads, beforeMismatchReads.rootReads + 1); assert.equal(prepareCalls, beforeMismatchReads.prepareCalls + 1);
  assert.equal(reachableReads, beforeMismatchReads.reachableReads);
  assert.deepEqual(rootMiss.lastRecall.timings.sourceReadAttempts, { reachableReads: 1, exitPoint: 'ready' });
  rootMismatch = false;
  assert.equal(vectors, 1); assert.equal(selections, 1);
  bodyChanged = true;
  cacheEnabled = false;
  const beforeMissReads = { sourceReads, rootReads, prepareCalls, reachableReads };
  const invalidated = await harness.runtime.intercept(harness.chat, 20000, null, 'swipe');
  assert.notEqual(invalidated.lastRecall.status, 'ready', '真实原文变更仍撤销旧冻结回执');
  assert.equal(sourceReads, beforeMissReads.sourceReads + 1, '快照不可用后仍执行原完整来源读取');
  assert.equal(rootReads, beforeMissReads.rootReads + 1);
  assert.equal(prepareCalls, beforeMissReads.prepareCalls + 1);
  assert.equal(reachableReads, beforeMissReads.reachableReads);
  assert.deepEqual(invalidated.lastRecall.timings.sourceReadAttempts, { reachableReads: 1, exitPoint: 'ready' });
  assert.equal(vectors, 1); assert.equal(selections, 1);
});

test('准备期限覆盖身份、独立来源和提交root，诊断分attempt且迟到分支不继续读取', async t => {
  for (const kind of ['identity', 'read', 'commitRoot']) await t.test(kind, async sub => {
    if (kind === 'identity') sub.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const releases = []; let prepares = 0, reads = 0, selects = 0, aborts = 0;
    const pending = () => {
      const value = new Promise(resolve => releases.push(resolve));
      if (kind === 'identity') queueMicrotask(() => sub.mock.timers.tick(8000));
      return value;
    };
    const harness = createRuntimeHarness({ preparationTimeoutMs: kind === 'identity' ? 120000 : 10,
      ...(kind === 'identity' ? { identityProjectionProvider: pending, prepareMemory: () => { prepares += 1; return { status: 'unavailable' }; } } : {}),
      ...(kind === 'commitRoot' ? { rootReader: pending, prepareMemory: () => { prepares += 1; return { status: 'unavailable' }; } } : {}),
      sourceReader: () => { reads += 1; return kind === 'read' ? pending() : runtimeFixture(); },
      selector: options => { selects += 1; return selectRecall(options); } });
    const result = await harness.runtime.intercept(harness.chat, 12000, value => { if (value === true) aborts += 1; }, 'normal');
    if (kind === 'identity') {
      assert.equal(result.lastRecall.status, 'ready'); assert.equal(aborts, 0); assert.equal(selects, 1);
      const beforeReads = reads; for (const release of releases) release(null);
      await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, beforeReads);
      return;
    }
    assert.equal(result.lastRecall.status, 'error'); assert.equal(result.lastRecall.error.code, 'V3_RECALL_MEMORY_PREPARATION_TIMEOUT');
    assert.equal(aborts, 1); assert.equal(selects, kind === 'commitRoot' ? 1 : 0); assert.equal(harness.saves, 0);
    const attempts = result.lastRecall.attemptDiagnostics;
    assert.equal(attempts.length, kind === 'commitRoot' ? 1 : 2);
    for (const attempt of attempts) {
      const record = attempt.timings.preparationAttempts.at(-1);
      assert.equal(record.status, 'timeout'); assert.equal(record.stage, { identity: 'identity', read: 'read', commitRoot: 'root' }[kind]);
      assert.equal(attempt.pendingStep, record.stage);
      assert.notEqual(attempt.lastCompletedStep, record.stage, '准备失败步骤不能伪装成已完成');
      assert.ok(record.totalMs >= record.budgetMs - 2); assert.ok(record[`${record.stage}Ms`] >= record.budgetMs - 2);
      assert.ok(attempt.timings.preparationAttempts.length <= (kind === 'commitRoot' ? 3 : 2));
    }
    assert.deepEqual(attempts.map(attempt => attempt.phase), kind === 'commitRoot' ? ['commit'] : ['source', 'source']);
    const frozen = JSON.stringify(attempts), beforeReads = reads;
    for (const release of releases) release(kind === 'read' ? runtimeFixture() : null);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(prepares, kind === 'commitRoot' ? 1 : kind === 'identity' ? 2 : 0); assert.equal(reads, beforeReads); assert.equal(JSON.stringify(result.lastRecall.attemptDiagnostics), frozen);
    assert.equal(harness.prompts.some(call => call[1]?.includes('<qqj_recalled_context>')), false);
  });
});

test('默认准备期限允许首轮与fresh提交来源各耗时9200ms并仍核验后注入', async t => {
  let tick = Date.now();
  t.mock.method(Date, 'now', () => tick);
  const { raw: initial, messages } = await retrySelectorReachable();
  const current = structuredClone(initial);
  current.rootRevision += 1; current.root.headCheckpointId = 'head-after'; current.checkpoint = { id: 'head-after' };
  let prepareCalls = 0, rootCalls = 0, reachableReads = 0, sourceReads = 0;
  const harness = createRuntimeHarness({
    prepareMemory: async options => {
      prepareCalls += 1;
      if (prepareCalls === 1) assert.equal(options.preferCached, true);
      else { assert.equal(options.allowRefresh, false, 'fresh提交核验只读，不能触发后台刷新'); assert.equal(options.preferCached, false); }
      return { status: 'unavailable' };
    },
    rootReader: async () => { rootCalls += 1; return { status: 'ready', revision: current.rootRevision, data: structuredClone(current.root) }; },
    reachableReader: async () => { reachableReads += 1; return structuredClone(reachableReads === 1 ? initial : current); },
    sourceReader: async options => { sourceReads += 1; tick += 9200; return readRecallSource(options); },
  });
  harness.chat.splice(0, harness.chat.length, ...messages, harness.userMessage);
  const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(prepareCalls, 2, '首轮与新root fresh核验分别完成准备');
  assert.equal(sourceReads, 2); assert.equal(reachableReads, 2, 'fresh核验必须在缓存未命中后独立读取新来源');
  assert.equal(rootCalls, 1, 'fresh提交核验会先读取新的当前root');
  assert.equal(result.lastRecall.status, 'ready', JSON.stringify(result.lastRecall));
  assert.match(result.lastRecall.injectionText, /在钟楼等到天亮/u, '准备按时完成后仍需通过来源版本核验并实际注入已选事实');
  const attempts = result.lastRecall.timings.preparationAttempts;
  assert.deepEqual(attempts.map(record => record.phase), ['source', 'commit']);
  assert.ok(attempts.every(record => record.status === 'ready' && record.budgetMs === 120000 && record.readMs === 9200));
});

test('默认准备期限超时仍只进行两次来源尝试，迟到结果不被注入', async t => {
  let tick = Date.now(), reachableReads = 0, sourceReads = 0, selectorCalls = 0;
  t.mock.method(Date, 'now', () => tick);
  const { raw } = await retrySelectorReachable();
  const harness = createRuntimeHarness({
    reachableReader: async () => { reachableReads += 1; return structuredClone(raw); },
    sourceReader: async options => { sourceReads += 1; tick += 120001; return readRecallSource(options); },
    selector: options => { selectorCalls += 1; return selectRecall(options); },
  });
  let abortCalls = 0;
  const result = await harness.runtime.intercept(harness.chat, 12000, value => { if (value === true) abortCalls += 1; }, 'normal');
  assert.equal(sourceReads, 2, '默认准备超时后最多保留既有的一次重试');
  assert.equal(reachableReads, 2);
  assert.equal(selectorCalls, 0);
  assert.equal(abortCalls, 1, '两次准备超时后停止当前正文生成');
  assert.equal(result.lastRecall.status, 'error');
  assert.equal(result.lastRecall.error.code, 'V3_RECALL_MEMORY_PREPARATION_TIMEOUT');
  assert.equal(result.lastRecall.attemptDiagnostics.length, 2);
  assert.ok(result.lastRecall.attemptDiagnostics.every(attempt => {
    const record = attempt.timings.preparationAttempts.at(-1);
    return record.budgetMs === 120000 && record.stage === 'read' && record.status === 'timeout';
  }));
  assert.ok(harness.prompts.every(call => call[1] === ''));
});

test('准备取消立即结束且迟到identity不得继续来源读取', async () => {
  let releaseIdentity, enteredIdentity; const entered = new Promise(resolve => { enteredIdentity = resolve; });
  let prepares = 0, reads = 0;
  const harness = createRuntimeHarness({ preparationTimeoutMs: 1000,
    identityProjectionProvider: () => { enteredIdentity(); return new Promise(resolve => { releaseIdentity = resolve; }); },
    prepareMemory: () => { prepares += 1; return { status: 'unavailable' }; }, sourceReader: () => { reads += 1; return runtimeFixture(); } });
  harness.handlers.get('generation-started')('normal');
  const pending = harness.runtime.intercept(harness.chat, 12000, null, 'normal'); await entered;
  harness.handlers.get('generation-stopped')(); const result = await pending;
  assert.equal(result.lastRecall.status, 'stale'); assert.deepEqual(result.lastRecall.skipReasons, ['stopped']);
  releaseIdentity(null); await new Promise(resolve => setImmediate(resolve));
  assert.equal(prepares, 1); assert.equal(reads, 0, '辅助未完成前不预读整图'); assert.equal(harness.saves, 0);
  assert.equal(harness.prompts.some(call => call[1]?.includes('<qqj_recalled_context>')), false);
});

test('fresh只读来源仍拒绝成员删除、可见正文变化、再更新root与用户变化', async t => {
  for (const kind of ['member', 'body', 'rootAgain', 'user', 'chat', 'technical']) await t.test(kind, async () => {
    const old = await singleFloorReachable({ revision: 1, head: 'head-old' });
    const current = structuredClone(old); current.rootRevision = 2; current.root.headCheckpointId = 'head-new';
    if (kind === 'member') current.floorMemories = [];
    let prepares = 0, reads = 0, selects = 0, roots = 0;
    const harness = createRuntimeHarness({
      prepareMemory: options => { prepares += 1; if (prepares === 1) return { status: 'ready', reachable: structuredClone(old) };
        assert.equal(options.allowRefresh, false); return { status: 'unavailable' }; },
      rootReader: () => {
        roots += 1;
        return { status: 'ready', revision: kind === 'rootAgain' && roots > 1 ? 4 : 2,
          data: { ...current.root, ...(kind === 'rootAgain' && roots > 1 ? { headCheckpointId: 'head-four' } : {}) } };
      },
      reachableReader: () => {
        reads += 1;
        if (kind === 'technical') throw Object.assign(new Error('私密底层失败信息'), { code: 'BACKEND_TIMEOUT' });
        if (kind === 'body') harness.chat[1].mes = '被修改的当前可见正文';
        if (kind === 'user') harness.userMessage.mes = '用户已改变输入';
        if (kind === 'chat') harness.context.chatMetadata.qianqianjie.chatId = 'another-chat';
        if (kind === 'rootAgain') return { ...structuredClone(current), rootRevision: 3, root: { ...current.root, headCheckpointId: 'head-three' } };
        return structuredClone(current);
      }, sourceReader: options => readRecallSource(options), selector: options => { selects += 1; return selectRecall(options); } });
    harness.chat[0].is_hidden = true;
    if (kind === 'body') harness.chat.splice(1, 0, { is_user: false, is_system: false, mes: '当前可见场景正文' });
    const core = kind === 'body' ? [structuredClone(harness.chat[1]), structuredClone(harness.userMessage)] : [structuredClone(harness.userMessage)];
    const result = await harness.runtime.intercept(core, 12000, null, 'normal');
    assert.notEqual(result.lastRecall.status, 'ready'); assert.equal(harness.saves, 0);
    assert.equal(harness.prompts.some(call => call[1]?.includes('<qqj_recalled_context>')), false);
    assert.ok(reads >= 1);
    if (kind === 'rootAgain') assert.equal(result.lastRecall.attemptDiagnostics[0].timings.preparationAttempts.at(-1).status, 'stale');
    if (kind !== 'technical') assert.equal(selects, 1);
    else { assert.equal(result.lastRecall.error.code, 'BACKEND_TIMEOUT'); assert.equal(result.lastRecall.attemptDiagnostics.length, 1); }
  });
});

test('准备可选计时随新回执封签并历史恢复，复用不重读来源', async () => {
  let reads = 0, rootReads = 0, prepareCalls = 0;
  const source = runtimeFixture();
  const harness = createRuntimeHarness({ sourceReader: () => { reads += 1; return structuredClone(source); },
    rootReader: async () => { rootReads += 1; return { status: 'ready', revision: source.rootRevision, data: structuredClone({ chatId: source.chatId,
      narrativeGeneration: source.narrativeGeneration, headCheckpointId: source.headCheckpointId }) }; },
    prepareMemory: async () => { prepareCalls += 1; return { status: 'unavailable' }; } });
  const first = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(first.lastRecall.status, 'ready'); await flushReceiptSave();
  const receipt = harness.userMessage.extra[RECALL_RECEIPT_KEY];
  assert.deepEqual(receipt.timings.preparationAttempts.map(record => record.phase), ['source', 'commit']);
  const historical = await projectHistoricalRecallReceipt(harness.userMessage, { chatId: CHAT, userMessageIndex: 1 });
  assert.equal(historical.status, 'ready'); assert.deepEqual(historical.timings.preparationAttempts, receipt.timings.preparationAttempts);
  const count = { reads, rootReads, prepareCalls }; const reused = await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(reused.lastRecall.reusedReceipt, true); assert.equal(reads, count.reads);
  assert.equal(rootReads, count.rootReads, '无raw/summary witness的冻结回执不读取root');
  assert.equal(prepareCalls, count.prepareCalls, '无见证时不尝试借用prepared snapshot');
});

test('冻结旧摘要见证使用生产快照投影核验，摘要真实修订后仍失效', async () => {
  const source = runtimeFixture();
  const summary = '人工摘要记载：阿裴把蓝色钥匙放在钟楼。';
  let summaryText = summary, cachedReachable = null, sourceReads = 0, rootReads = 0, prepareCalls = 0;
  const sourceReader = async () => {
    sourceReads += 1;
    const value = structuredClone(source);
    const canonicalContent = summaryCandidateText(summaryText);
    value.summarySources = [{ sourceKind: 'userSummary', floorId: 'floor-2', assistantSeq: 2, floorMemoryId: 'memory-2',
      memoryFloorId: 'floor-2', memoryAssistantSeq: 2, canonicalContent, fingerprint: await fingerprintText(canonicalContent) }];
    return value;
  };
  const makeReachable = async revision => {
    const value = rawReachableFromSource(source);
    value.rootRevision = revision; value.root.headCheckpointId = `head-${revision}`; value.checkpoint.id = `head-${revision}`;
    const memory = value.floorMemories.find(item => item.floorId === 'floor-2');
    memory.summary = { effectiveSource: 'user', userText: summaryText };
    return value;
  };
  cachedReachable = await makeReachable(1);
  const harness = createRuntimeHarness({ sourceReader,
    rootReader: async () => { rootReads += 1; return { status: 'ready', revision: cachedReachable.rootRevision, data: structuredClone(cachedReachable.root) }; },
    reachableReader: async () => structuredClone(cachedReachable),
    prepareMemory: async options => { prepareCalls += 1; return options.allowRefresh === false ? { status: 'ready', reachable: cachedReachable } : { status: 'unavailable' }; } });
  const first = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(first.lastRecall.status, 'ready');
  await flushReceiptSave();
  const receipt = harness.userMessage.extra[RECALL_RECEIPT_KEY];
  const floor = receipt.selectedFloors.find(item => item.floorId === 'floor-2');
  assert.ok(floor, '准备摘要见证的目标楼实际存在于冻结回执');
  floor.summaryWitnesses = [{ sourceKind: 'userSummary', floorId: 'floor-2', assistantSeq: 2, floorMemoryId: floor.floorMemoryId,
    memoryFloorId: 'floor-2', memoryAssistantSeq: 2, fingerprint: await fingerprintText(summaryCandidateText(summary)), offset: 0, length: summaryCandidateText(summary).length,
    textFingerprint: await fingerprintText(summaryCandidateText(summary)) }];
  receipt.receiptFingerprint = await receiptFingerprint(receipt);
  const projectedSummary = await projectRecallSource(cachedReachable, () => new Date(NOW));
  assert.ok(await summaryWitnessValid(floor.summaryWitnesses[0], projectedSummary), JSON.stringify(projectedSummary.summarySources));
  harness.runtime.invalidate('installLegacySummaryWitnessFixture');
  const before = { sourceReads, rootReads, prepareCalls };
  const reused = await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(reused.lastRecall.reusedReceipt, true, JSON.stringify(reused.lastRecall));
  assert.equal(sourceReads, before.sourceReads, '匹配快照通过生产projectRecallSource重建summarySources');
  assert.equal(rootReads, before.rootReads + 1); assert.equal(prepareCalls, before.prepareCalls + 1);
  assert.deepEqual(reused.lastRecall.timings.sourceReadAttempts, { reachableReads: 0, exitPoint: 'validatedSnapshot' });
  summaryText = '人工摘要已修订：钥匙交给守门人。';
  cachedReachable = await makeReachable(2);
  const beforeRevision = { sourceReads, rootReads, prepareCalls };
  const invalidated = await harness.runtime.intercept(harness.chat, 12000, null, 'swipe');
  assert.notEqual(invalidated.lastRecall.status, 'ready', '旧summaryWitness不得越过真实摘要修订');
  assert.ok(invalidated.lastRecall.skipReasons.includes('selectedRefsChanged'));
  assert.equal(sourceReads, beforeRevision.sourceReads, '匹配新root的投影能直接发现摘要见证失效');
  assert.equal(rootReads, beforeRevision.rootReads + 1); assert.equal(prepareCalls, beforeRevision.prepareCalls + 1);
});

test('mixed原文与摘要首次提交按新root校验非raw归档，纯摘要失效而纯raw仍可用', async () => {
  const summaryOld = '旧摘要记载：阿裴把蓝色钥匙藏在钟楼北墙。';
  const summaryNew = '新摘要记载：蓝色钥匙已交给守门人。';
  const rawText = '钟楼北墙有一块松动的砖，阿裴把蓝色钥匙塞在砖后，准备等夜深再取。';
  const initial = runtimeFixture();
  const memory = initial.floorMemories.find(value => value.floorId === 'floor-2');
  memory.summary = summaryOld;
  const raw = { floorId: 'floor-2', assistantSeq: 2, floorMemoryId: memory.floorMemoryId, memoryFloorId: 'floor-2', memoryAssistantSeq: 2, canonicalContent: rawText, fingerprint: await fingerprintText(rawText) };
  initial.rawSources = [raw];
  let latest = structuredClone(initial), releaseSelection, selectedFloor;
  const selectedGate = new Promise(resolve => { releaseSelection = resolve; });
  const witness = { floorId: raw.floorId, assistantSeq: raw.assistantSeq, floorMemoryId: raw.floorMemoryId, memoryFloorId: raw.memoryFloorId,
    memoryAssistantSeq: raw.memoryAssistantSeq, offset: 0, length: rawText.length, fingerprint: raw.fingerprint, textFingerprint: await fingerprintText(rawText) };
  const makeSelector = mode => async input => {
    const result = await selectRecallWithLlm({ ...input,
      semanticProvider: async () => ({ candidates: [{ text: rawText, witness }] }),
      generateUtilityTask: async request => {
        const payload = JSON.parse(request.taskMessages[0].content);
        const rawKeys = payload.candidates.filter(value => value.fact.includes('[历史原文')).map(value => value.key);
        const keep = mode === 'raw-only' ? rawKeys : mode === 'summary-only' ? payload.candidates.filter(value => !rawKeys.includes(value.key)).map(value => value.key) : payload.candidates.map(value => value.key);
        return { jsonData: { history_exclude_keys: payload.candidates.filter(value => !keep.includes(value.key)).map(value => value.key), state_exclude_keys: [], priority_keys: keep } };
      },
    });
    const row = result.floors.find(value => value.floorId === 'floor-2');
    selectedFloor = row ? { floorId: row.floorId, floorMemoryId: row.floorMemoryId, items: row.items.map(value => ({ kind: value.kind, text: value.text, rawWitness: Boolean(value.rawWitness) })) } : null;
    await selectedGate;
    return result;
  };
  const harness = createRuntimeHarness({
    sourceReader: async () => structuredClone(latest),
    rootReader: async () => ({ status: 'ready', revision: latest.rootRevision, data: { chatId: latest.chatId, narrativeGeneration: latest.narrativeGeneration, headCheckpointId: latest.headCheckpointId } }),
    selector: makeSelector('mixed'),
  });
  harness.chat[0].mes = '在钟楼北墙找蓝色钥匙'; harness.userMessage.mes = '阿裴以前把蓝色钥匙藏在哪里？';
  const pending = harness.runtime.intercept(harness.chat, 20000, null, 'normal');
  for (let i = 0; i < 100 && !selectedFloor; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(selectedFloor?.items.some(value => value.rawWitness) && selectedFloor.items.some(value => !value.rawWitness), `正式 selector 必须同时选择同楼原文和摘要/事实: ${JSON.stringify(selectedFloor)}`);
  latest = structuredClone(latest);
  const revised = latest.floorMemories.find(value => value.floorId === 'floor-2');
  revised.floorMemoryId = 'memory-2-revised-summary'; revised.summary = summaryNew;
  latest.rawSources[0].floorMemoryId = revised.floorMemoryId;
  latest.rootRevision += 1; latest.headCheckpointId = 'head-after-summary-revision';
  releaseSelection();
  const result = await pending;
  const prompt = latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT) ?? '';
  assert.notEqual(result.lastRecall.status, 'ready');
  assert.equal(prompt.includes('旧摘要记载:阿裴把蓝色钥匙藏在钟楼北墙'), false, '新 root 后不注入旧摘要');
  assert.ok(result.lastRecall.skipReasons.includes('selectedRefsChanged'));
  assert.deepEqual(result.lastRecall.finalVerification.failure.reference, {
    step: 'selectedReference', kind: 'floor', index: 0, floorId: 'floor-2', floorMemoryId: 'memory-2', assistantSeq: 2,
  }, '混合楼摘要版本失效沿用已有 floor 诊断类型和定位字段');

  const control = async mode => {
    const base = runtimeFixture(); const baseMemory = base.floorMemories.find(value => value.floorId === 'floor-2');
    baseMemory.summary = summaryOld; if (mode === 'raw-only') baseMemory.commitments = [];
    base.rawSources = [{ ...raw, floorMemoryId: baseMemory.floorMemoryId }];
    let current = structuredClone(base), controlSelected = null, release;
    const gate = new Promise(resolve => { release = resolve; });
    const controlWitness = { ...witness, floorMemoryId: base.rawSources[0].floorMemoryId };
    const controlHarness = createRuntimeHarness({
      sourceReader: async () => structuredClone(current),
      rootReader: async () => ({ status: 'ready', revision: current.rootRevision, data: { chatId: current.chatId, narrativeGeneration: current.narrativeGeneration, headCheckpointId: current.headCheckpointId } }),
      selector: async input => {
        const selected = await selectRecallWithLlm({ ...input,
          semanticProvider: async () => ({ candidates: [{ text: rawText, witness: controlWitness }] }),
          generateUtilityTask: async request => {
            const payload = JSON.parse(request.taskMessages[0].content);
            const rawKeys = payload.candidates.filter(value => value.fact.includes('[历史原文')).map(value => value.key);
            const keep = mode === 'raw-only' ? rawKeys : payload.candidates.filter(value => !rawKeys.includes(value.key)).map(value => value.key);
            return { jsonData: { history_exclude_keys: payload.candidates.filter(value => !keep.includes(value.key)).map(value => value.key), state_exclude_keys: [], priority_keys: keep } };
          },
        });
        controlSelected = selected.floors.find(value => value.floorId === 'floor-2')?.items.map(value => ({ text: value.text, rawWitness: Boolean(value.rawWitness) })) ?? [];
        await gate; return selected;
      },
    });
    controlHarness.chat[0].mes = '在钟楼北墙找蓝色钥匙'; controlHarness.userMessage.mes = '阿裴以前把蓝色钥匙藏在哪里？';
    const running = controlHarness.runtime.intercept(controlHarness.chat, 20000, null, 'normal');
    for (let i = 0; i < 100 && !controlSelected; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
    current = structuredClone(current); const newMemory = current.floorMemories.find(value => value.floorId === 'floor-2');
    newMemory.floorMemoryId = `memory-2-${mode}-revised`; newMemory.summary = summaryNew;
    current.rawSources[0].floorMemoryId = newMemory.floorMemoryId; current.rootRevision += 1; current.headCheckpointId = `head-${mode}-revised`;
    release();
    const outcome = await running; const controlPrompt = latestPromptValue(controlHarness.prompts, RECALL_PROMPT_SLOT) ?? '';
    return { outcome, controlPrompt, controlSelected };
  };
  const summaryOnly = await control('summary-only');
  assert.notEqual(summaryOnly.outcome.lastRecall.status, 'ready');
  assert.equal(summaryOnly.controlPrompt.includes('旧摘要记载:阿裴把蓝色钥匙藏在钟楼北墙'), false);
  const rawOnly = await control('raw-only');
  assert.equal(rawOnly.outcome.lastRecall.status, 'ready');
  assert.equal(rawOnly.controlPrompt.includes('钟楼北墙有一块松动的砖'), true);
  assert.equal(rawOnly.controlPrompt.includes('旧摘要记载:阿裴把蓝色钥匙藏在钟楼北墙'), false);
});

test('同文同可见性CSE按toward保留不同对象，同一对象仍折叠且变化对象同样隔离', () => {
  const targetA = '88888888-7777-4777-8777-777777777777', targetB = '99999999-7777-4777-8777-777777777777';
  const queryContext = { text: '阿裴 林岚 乙 蓝色信封', latestUserText: '阿裴 林岚 乙 蓝色信封', recentAssistantText: '', previousUserText: '', messageCount: 1 };
  const state = (id, target, seq) => recallState(id, '把蓝色信封交给对方', seq, { visibility: 'private', towardEntityId: target });
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  memories[1] = recallMemory(2, { privateCognition: [{ ownerEntityId: PERSON, kind: 'thought', content: '把蓝色信封交给对方' }] });
  const base = selectorSource({ memories, currentState: [{ subjectEntityId: PERSON, core: [], adaptive: [state('toward-a', targetA, 7), state('toward-b', targetB, 8)], situational: [] }] });
  const pool = buildRecallCseCandidatePool({ source: base, queryContext });
  const selected = selectRecall({ source: base, queryContext, selectedCseCandidates: pool.candidates, contextSize: 16000 });
  assert.equal(pool.candidates.length, 2);
  assert.deepEqual(new Set(selected.states.map(value => value.towardEntityId)), new Set([targetA, targetB]));
  assert.equal(selected.stages.budgetDroppedCount, 0);

  const sameSource = structuredClone(base);
  sameSource.currentState[0].adaptive = [state('same-a', targetA, 7), state('same-b', targetA, 8)];
  const samePool = buildRecallCseCandidatePool({ source: sameSource, queryContext });
  const same = selectRecall({ source: sameSource, queryContext, selectedCseCandidates: samePool.candidates, contextSize: 16000 });
  assert.equal(same.states.length, 1, '同对象同文状态仍按原合同折叠');

  const changes = structuredClone(base); changes.currentState = [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: [] }];
  const after = (id, target, seq) => recallState(id, '保留蓝色信封', seq, { visibility: 'shared', towardEntityId: target });
  const before = (id, target, seq) => recallState(id, '暂不交出蓝色信封', seq, { visibility: 'shared', towardEntityId: target });
  changes.cseChanges = [targetA, targetB].map(target => ({ deltaId: 'shared-delta', floorId: 'floor-8', assistantSeq: 8, subjectEntityId: PERSON, layer: 'adaptive', action: 'refine', before: before(`before-${target}`, target, 7), after: after(`after-${target}`, target, 8) }));
  const changePool = buildRecallCseCandidatePool({ source: changes, queryContext });
  const changeSelection = selectRecall({ source: changes, queryContext, selectedCseCandidates: changePool.candidates, contextSize: 16000 });
  assert.equal(changePool.candidates.filter(value => value.source === 'change').length, 2);
  assert.deepEqual(new Set(changeSelection.cseChanges.map(value => value.after.towardEntityId)), new Set([targetA, targetB]));
  assert.equal(changeSelection.stages.budgetDroppedCount, 0);
});

test('前后变化只被after子串摘要覆盖时保留转折，完整摘要可去重', () => {
  const queryContext = { text: '阿裴对此态度后来发生了什么变化', latestUserText: '阿裴对此态度后来发生了什么变化', recentAssistantText: '', previousUserText: '', messageCount: 1 };
  const run = (summary, beforeText = '愿意解释', afterText = '不愿意解释') => {
    const source = selectorSource({ memories: Array.from({ length: 8 }, (_, index) => recallMemory(index + 1, { summary: index === 5 ? summary : '' })) });
    source.cseChanges = [{ deltaId: 'delta-attitude', floorId: 'floor-6', assistantSeq: 6, subjectEntityId: PERSON, layer: 'situational', action: 'refine',
      before: recallState('state-before', beforeText, 5, { sourceFloorId: 'floor-5', sourceDeltaId: 'delta-before' }),
      after: recallState('state-after', afterText, 6, { sourceFloorId: 'floor-6', sourceDeltaId: 'delta-attitude' }) }];
    const pool = buildRecallCseCandidatePool({ source, queryContext });
    const changes = pool.candidates.filter(value => value.source === 'change');
    return selectRecall({ source, queryContext, selectedCseCandidates: changes, contextSize: 16000 });
  };
  const partial = run('本楼后续：不愿意解释。');
  assert.equal(partial.stages.semanticDuplicateCount, 0);
  assert.equal(partial.cseChanges.length, 1);
  assert.match(partial.injectionText, /之前[^\n]*愿意解释[\s\S]*之后[^\n]*不愿意解释/u);
  const full = run('此前愿意解释，后来转为不愿意解释。');
  assert.equal(full.stages.semanticDuplicateCount, 1);
  assert.equal(full.cseChanges.length, 0, '摘要逐字覆盖两侧仍可去重');
  const noOverlap = run('最近明确拒绝录音。', '愿意接受录音访谈', '后来拒绝录音');
  assert.equal(noOverlap.cseChanges.length, 1, '仅有 after 的无重叠摘要不能抹去变化');

  const splitMemories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  splitMemories[4] = recallMemory(5, { summary: '愿意接受录音访谈。' });
  splitMemories[5] = recallMemory(6, { summary: '后来拒绝录音。' });
  const splitSource = selectorSource({ memories: splitMemories });
  splitSource.cseChanges = [{ deltaId: 'delta-split', floorId: 'floor-6', assistantSeq: 6, subjectEntityId: PERSON, layer: 'situational', action: 'refine',
    before: recallState('state-before-split', '愿意接受录音访谈', 5, { sourceFloorId: 'floor-5', sourceDeltaId: 'delta-split-before' }),
    after: recallState('state-after-split', '后来拒绝录音', 6, { sourceFloorId: 'floor-6', sourceDeltaId: 'delta-split' }) }];
  const splitPool = buildRecallCseCandidatePool({ source: splitSource, queryContext });
  const splitSelection = selectRecall({ source: splitSource, queryContext, selectedCseCandidates: splitPool.candidates.filter(value => value.source === 'change'), contextSize: 16000 });
  assert.equal(splitSelection.cseChanges.length, 0, '同源不同楼分别覆盖两侧时仍可去重');
  assert.equal(splitSelection.stages.semanticDuplicateCount, 1);
});

test('同次 LLM 选材只注入明确选中的人工载体全文，recent floors 和 live 回执均字面可见', async () => {
  const value = reachable();
  const npcA = 'aaaaaaaa-0000-4000-8000-000000000097', npcB = 'aaaaaaaa-0000-4000-8000-000000000098', userId = 'aaaaaaaa-0000-4000-8000-000000000099';
  value.entities.push(
    { id: npcA, entityType: 'person', displayName: '阿禾', aliases: [], specialRole: 'none', recordStatus: 'active', status: 'established' },
    { id: npcB, entityType: 'person', displayName: '小路', aliases: [], specialRole: 'none', recordStatus: 'active', status: 'established' },
    { id: userId, entityType: 'person', displayName: '你', aliases: [], specialRole: 'user', recordStatus: 'active', status: 'established' },
  );
  const textA = '第一张便笺：\n- AI #900：这行是原文\n<content>「甲」🙂';
  const textB = '第二张便笺：\n内容不同，不能因同名载体一起命中。';
  value.floorMemories[0].exactAnchors = [{ anchorId: 'aaaaaaaa-0000-4000-8000-000000000001', kind: 'other', exactText: textA, occurrence: 1,
    speakerEntityId: null, whyPreserve: '用户手填', manual: true, carrier: '手机便笺', knownEntityIds: [npcA, npcB], sourceFloorId: FLOOR1 }];
  value.floors.push({ id: '77777777-0000-4000-8000-000000000001', assistantSeq: 3 });
  value.floorMemories.push({ id: '77777777-0000-4000-8000-000000000002', floorId: '77777777-0000-4000-8000-000000000001', recordStatus: 'active',
    summary: { effectiveSource: 'ai', aiText: '另一张便笺的独立来源。' }, ...emptyMemory,
    exactAnchors: [{ anchorId: 'aaaaaaaa-0000-4000-8000-000000000002', kind: 'other', exactText: textB, occurrence: 1,
      speakerEntityId: null, whyPreserve: '用户手填', manual: true, carrier: '手机便笺', sourceFloorId: '77777777-0000-4000-8000-000000000001' }] });
  const source = await projectRecallSource(value, () => new Date(NOW), sourceAttempts('ready'));
  assert.equal(source.floorMemories[0].floorMemoryId, MEMORY1);
  const queryContext = { text: '手机便笺第一张里写了什么', latestUserText: '手机便笺第一张里写了什么', messageCount: 1 };
  const utility = async ({ taskMessages }) => {
    const payload = JSON.parse(taskMessages[0].content);
    const target = payload.candidates.find(candidate => candidate.fact.includes('第一张便笺'));
    assert.ok(target, 'recently saved source is offered to the same utility selection');
    assert.match(target.fact, /知情：阿禾、小路；不知情：其余人物/u, '候选精确保留两位明确知情NPC且未选人物未知');
    const otherArtifact = payload.candidates.filter(candidate => candidate.fact.includes('载体：手机便笺'));
    assert.equal(otherArtifact.length, 2, 'same-name carriers remain separate R candidates');
    assert.match(otherArtifact.find(candidate => candidate.fact.includes('第二张便笺')).fact, /知情：无；不知情：全部人物/u, '空知情名单在候选中明确保持为所有人未知');
    return { jsonData: { history_exclude_keys: payload.candidates.filter(candidate => candidate.key !== target.key).map(candidate => candidate.key),
      artifact_select_keys: ['R999', 'C1', 'Q1', 'T1', 7, target.key, target.key, null], state_exclude_keys: payload.cseContextGroups.flatMap(group => group.items.map(item => item.key)), priority_keys: [] } };
  };
  const selected = await selectRecallWithLlm({ source, queryContext, contextSize: 12000, generateUtilityTask: utility });
  assert.match(selected.injectionText, /原文载体「手机便笺」/);
  assert.match(selected.injectionText, /知情：阿禾、小路；不知情：其余人物/u);
  assert.doesNotMatch(selected.injectionText, /只有你知道|你知道这条原文/u, 'user不在知情名单时不能被注入为知情人');
  assert.ok(selected.injectionText.includes(textA), 'newlines, markup, punctuation, and emoji survive through injection');
  assert.equal(selected.injectionText.includes(textB), false, 'same-name source is not injected');
  const emptyScopeSelection = await selectRecallWithLlm({ source, queryContext, contextSize: 12000, generateUtilityTask: async ({ taskMessages }) => {
    const payload = JSON.parse(taskMessages[0].content), emptyArtifact = payload.candidates.find(candidate => candidate.fact.includes('第二张便笺'));
    return { jsonData: { history_exclude_keys: payload.candidates.filter(candidate => candidate.key !== emptyArtifact.key).map(candidate => candidate.key),
      artifact_select_keys: [emptyArtifact.key], state_exclude_keys: payload.cseContextGroups.flatMap(group => group.items.map(item => item.key)), priority_keys: [] } };
  } });
  assert.ok(emptyScopeSelection.injectionText.includes(textB));
  assert.match(emptyScopeSelection.injectionText, /知情：无；不知情：全部人物/u, '空知情名单在最终注入也明确为所有人物未知');
  const liveReceipt = { schemaVersion: 18, strategyVersion: RECALL_STRATEGY_VERSION, status: 'ready', injectionText: selected.injectionText,
    selectedFloors: selected.floors.map(({ floorId, assistantSeq, reasons }) => ({ floorId, assistantSeq, reasons })), selectedStates: [], selectedCseChanges: [],
    storylines: selected.storylines, stages: selected.stages };
  const projected = projectInlineRecallReceipt(liveReceipt);
  assert.equal(projected.protocolRecognized, true);
  assert.ok(projected.historyItems.some(item => item.text.includes(textA)), '有长度的多行原文作为完整块呈递');
  const legacy = projectInlineRecallReceipt({ ...liveReceipt, injectionText: selected.injectionText.replace(/\[人工原文｜\d+字符\]\n/gu, '') });
  assert.equal(legacy.rawReceiptAvailable, true);
  assert.equal(legacy.protocolRecognized, false, '旧无长度人工原文保留详细回执，不猜结构');
  assert.ok(legacy.injectionText.includes(textA));
  assert.ok(projected.injectionText.includes(textA), 'existing raw receipt expansion contains carrier and complete literal source');
  assert.equal(projected.injectionText.includes(textB), false);
  const persisted = createRuntimeHarness({ sourceReader: async () => structuredClone(source),
    reachableReader: async () => rawReachableFromSource(source), manualMemorySnapshot: () => rawReachableFromSource(source), selector: () => selected });
  persisted.userMessage.mes = queryContext.latestUserText;
  const saved = await persisted.runtime.intercept(structuredClone(persisted.chat), 12000, null, 'normal');
  assert.equal(saved.lastRecall.status, 'ready');
  await flushReceiptSave();
  const signed = structuredClone(persisted.userMessage.extra[RECALL_RECEIPT_KEY]);
  assert.ok(signed.injectionText.includes(textA));
  persisted.runtime.invalidate('reload');
  const restored = await persisted.runtime.restorePersistedReceipt();
  assert.equal(restored.lastRecall.restoredReceipt, true, '长度封装沿原回执签名与保存合同冷恢复');
  assert.equal(restored.lastRecall.injectionText, signed.injectionText);
  assert.ok(projectInlineRecallReceipt(restored.lastRecall).historyItems.some(item => item.text.includes(textA)));
  const noExplicitArtifact = await selectRecallWithLlm({ source, queryContext, contextSize: 12000, generateUtilityTask: async ({ taskMessages }) => {
    const payload = JSON.parse(taskMessages[0].content);
    return { jsonData: { history_exclude_keys: payload.candidates.map(candidate => candidate.key), artifact_select_keys: ['R999', 'C1', 'Q1', 'T1', 7, null],
      state_exclude_keys: payload.cseContextGroups.flatMap(group => group.items.map(item => item.key)), priority_keys: [] } };
  } });
  assert.equal(noExplicitArtifact.injectionText.includes(textA), false, 'ordinary unexcluded history does not count as a positive artifact selection');
});

test('人工原件的旧逐字事实只按明确归属收敛，不吞语义承诺或foreign anchor', () => {
  const text = '明晚九点在南门见。', uniqueText = '旧私密原句仅出现一次。', manualId = 'aaaaaaaa-0000-4000-8000-000000000041', foreignId = 'aaaaaaaa-0000-4000-8000-000000000042';
  const userId = '88888888-7777-4777-8777-777777777777', otherId = '99999999-7777-4777-8777-777777777777';
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  memories[0] = recallMemory(1, {
    exactAnchors: [
      { anchorId: manualId, kind: 'other', exactText: text, speakerEntityId: PERSON, manual: true, carrier: '给林岚的纸条', knownEntityIds: [userId] },
      { anchorId: foreignId, kind: 'other', exactText: text, speakerEntityId: PERSON },
      { anchorId: 'aaaaaaaa-0000-4000-8000-000000000043', kind: 'other', exactText: uniqueText, speakerEntityId: PERSON, manual: true, carrier: '另一个载体' },
    ],
    commitments: [
      { speakerEntityId: PERSON, targetEntityIds: [userId], kind: 'promise', content: text, status: 'made', exactAnchorId: manualId },
      { speakerEntityId: PERSON, targetEntityIds: [userId], kind: 'promise', content: text, status: 'made', exactAnchorId: foreignId },
      { speakerEntityId: PERSON, targetEntityIds: [userId], kind: 'promise', content: '答应替林岚保守秘密', status: 'made', exactAnchorId: manualId },
    ],
    privateCognition: [
      { ownerEntityId: PERSON, kind: 'thought', content: uniqueText },
      { ownerEntityId: otherId, kind: 'thought', content: uniqueText },
    ],
    informationTransfers: [
      { fromEntityId: PERSON, toEntityIds: [userId], claimText: uniqueText, channel: 'written' },
      { fromEntityId: otherId, toEntityIds: [userId], claimText: uniqueText, channel: 'written' },
    ],
  });
  const context = historySelectionContext(selectorSource({ memories }), { text, latestUserText: text, messageCount: 1 });
  const facts = context.facts;
  assert.equal(facts.filter(value => value.kind === 'commitment' && value.text.includes(text)).length, 1, `同 anchor 原件副本收敛后仍保留 foreign anchor 自身事实：${JSON.stringify(facts.filter(value => value.kind === 'commitment'))}`);
  assert.equal(facts.some(value => value.kind === 'commitment' && value.text.includes('答应替林岚保守秘密')), true, '语义承诺仍保留');
  assert.equal(facts.some(value => value.kind === 'thought' && value.ownerEntityId === PERSON && value.text.includes(uniqueText)), false, '唯一明确speaker归属的无ID逐字副本不旁路');
  assert.equal(facts.some(value => value.kind === 'thought' && value.ownerEntityId === otherId && value.text.includes(uniqueText)), true, '同文但不同owner仍是另一条事实');
  assert.equal(facts.some(value => value.category === 'transfer' && value.fromEntityId === PERSON && value.text.includes(uniqueText)), false, '唯一明确来源归属的信息传递全文也不旁路');
  assert.equal(facts.some(value => value.category === 'transfer' && value.fromEntityId === otherId && value.text.includes(uniqueText)), true, '同文但不同来源的信息传递事实保留');

  const foreignOnly = recallMemory(1, { exactAnchors: [
    { anchorId: manualId, kind: 'other', exactText: text, speakerEntityId: PERSON, manual: true, carrier: '修订后的纸条' },
    { anchorId: foreignId, kind: 'other', exactText: text, speakerEntityId: PERSON },
  ], commitments: [{ speakerEntityId: PERSON, targetEntityIds: [userId], kind: 'promise', content: text, status: 'made', exactAnchorId: manualId }] });
  const foreignFacts = historySelectionContext(selectorSource({ memories: [foreignOnly, ...memories.slice(1)] }), { text, latestUserText: text, messageCount: 1 }).facts;
  assert.ok(foreignFacts.some(value => value.kind === 'exactAnchor' && value.text.includes(`原句「${text}」`)),
    'foreign自动原件不会被仅指向manual anchor的同文承诺抢占或吞掉');
});

test('人工载体候选在大于48条普通R的既有限额内仍按现有召回相关度排序', () => {
  const memories = Array.from({ length: 55 }, (_, index) => recallMemory(index + 1, { events: [{ title: `普通旧事${index}`, description: `普通记录内容${index}`, candidateStatus: 'accepted' }] }));
  memories[0].exactAnchors = [{ anchorId: 'aaaaaaaa-0000-4000-8000-000000000011', kind: 'other', occurrence: 1, speakerEntityId: PERSON,
    whyPreserve: '用户手填', manual: true, carrier: '银杏桥账册', exactText: '目标载体记录：封存的黄铜钥匙。', sourceFloorId: memories[0].floorId }];
  memories[1].exactAnchors = [{ anchorId: 'aaaaaaaa-0000-4000-8000-000000000012', kind: 'other', occurrence: 1, speakerEntityId: null,
    whyPreserve: '用户手填', manual: true, carrier: '银杏桥账册', exactText: '另一来源载体记录：空白账页。', sourceFloorId: memories[1].floorId }];
  const pool = buildRecallHistoryCandidatePool({ source: selectorSource({ memories }), queryContext: { text: '裴晚生提到银杏桥账册封存的黄铜钥匙', latestUserText: '裴晚生提到银杏桥账册封存的黄铜钥匙', messageCount: 1 } });
  const artifacts = pool.candidates.filter(candidate => candidate.sourceKind === 'manualArtifact');
  assert.ok(artifacts.some(candidate => candidate.value.anchorId.endsWith('0011')));
  assert.ok(artifacts.find(candidate => candidate.value.anchorId.endsWith('0011')).value.entityBranchScores?.latestUser > 0,
    'known speaker contributes through the existing entity-ranked branch');
  assert.ok(artifacts.every(candidate => candidate.value.kind === 'manualArtifact' && candidate.stableKey.includes(candidate.value.anchorId)));
  assert.ok(pool.candidates.length <= 48);
});

test('人工原文被本次选择但预算不足时有准确省略原因且不会注入截断副本', () => {
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  memories[0].exactAnchors = [{ anchorId: 'aaaaaaaa-0000-4000-8000-000000000021', kind: 'other', occurrence: 1, speakerEntityId: null,
    whyPreserve: '用户手填', manual: true, carrier: '写给林岚的纸条', exactText: '请把完整内容留给我，不能截掉后当成可用信息。', sourceFloorId: memories[0].floorId }];
  const source = selectorSource({ memories });
  const queryContext = { text: '纸条完整内容', latestUserText: '纸条完整内容', messageCount: 1 };
  const historyContext = historySelectionContext(source, queryContext);
  const artifact = historyContext.manualArtifacts.find(value => value.anchorId.endsWith('0021'));
  assert.ok(artifact);
  const selected = selectRecall({ source, queryContext, historyContext, selectedHistoryCandidates: [artifact], contextSize: 1, reservedCharacters: 800 });
  assert.equal(selected.injectionText.includes('请把完整内容留给我'), false);
  assert.ok(selected.skipReasons.includes('manualArtifactBudget'));
  assert.ok(selected.stages.budgetDroppedCount > 0);
});


test('三种合法跟进标题沿runtime fresh复验保留原标题并参与抑制与精确去重', async () => {
  for (const header of ['[相关跟进事项]', '[相关未完事项]', '[当前待接续]']) {
    const text = `本轮千事资料来源截至：AI #50。\n\n[相关时间线]\n- 已归还旧书\n\n${header}\n- 继续关注旧书；已记录完成，当前仍继续关注。`;
    const progress = { text, eventIds:['event-book'], matterIds:['matter-book'] };
    const deduped = removeExactQianshiDuplicates(progress, { floors:[{items:[{category:'objective',text:'已归还旧书'}]}] });
    assert.match(deduped.text, /本轮千事资料来源截至/u, `${header}剩余跟进材料仍有来源范围`);
    assert.equal(deduped.text.includes(header), true);
    assert.equal(renderedQianshiProgressText({ text:`本轮千事资料来源截至：AI #50。\n\n${header}\n- 旧书`,matterIds:['matter-book'] },
      { reminders:[{qianshiRef:{matterId:'matter-book'}}] }), '', `${header}支持同事项重叠抑制`);
    const contexts=[];
    const h=createRuntimeHarness({ selector: input=>({...selectRecall(input),qianshiProgress:input.source.qianshiProgress}),
      qianshiProgressProvider:(_source,context)=>{
        contexts.push(context);
        return {anchor:{narrativeGeneration:GEN,headCheckpointId:'head'},projectionVersion:5,
          text:Object.hasOwn(context,'selectedEventIds')?text.replace(header,context.pendingHeader):text,
          eventIds:['event-book'],matterIds:['matter-book']};
      } });
    await h.runtime.intercept(h.chat,12000,null,'normal');
    const receipt=h.userMessage.extra[RECALL_RECEIPT_KEY];
    assert.equal(contexts[1].pendingHeader,header, 'fresh复验不能改冻结资料标题');
    assert.equal(receipt.qianshiProgress?.text,text);
    assert.equal(receipt.skipReasons.includes('optionalQianshiChanged'),false);
  }
});


test('无地点依赖统一为空并只读兼容旧空占位，真实地点仍触发重选', async () => {
  let selections = 0;
  const h = createRuntimeHarness({ selector: input => { selections += 1; return selectRecall(input); } });
  await h.runtime.intercept(h.chat, 12000, null, 'normal');
  const saved = structuredClone(h.userMessage.extra[RECALL_RECEIPT_KEY]);
  assert.equal(saved.locationReferenceDependency, 'null', '没有地点事实时不记录消息定位占位');
  const legacy = { ...saved, locationReferenceDependency: JSON.stringify({ values: [], hostLocator: { messageIndex: 0, swipeId: null, selectedSwipeIndex: null } }) };
  legacy.receiptFingerprint = await receiptFingerprint(legacy);
  h.userMessage.extra[RECALL_RECEIPT_KEY] = legacy;
  h.runtime.invalidate('coldRead');
  h.chat.push({ is_user: false, is_system: false, mes: '本次回复仍没有地点标注。' });
  const reused = await h.runtime.intercept(h.chat, 12000, null, 'continue');
  assert.equal(reused.lastRecall.reusedReceipt, true);
  assert.equal(selections, 1);
  assert.deepEqual(h.userMessage.extra[RECALL_RECEIPT_KEY], legacy, '兼容比较不改旧依赖与封签');
  h.chat.at(-1).mes += '<location>阳台</location>';
  const changed = await h.runtime.intercept(h.chat, 12000, null, 'continue');
  assert.equal(changed.lastRecall.reusedReceipt, false, '空地点与真实地点不能互相当成相同依赖');
  assert.equal(selections, 2);
  assert.doesNotMatch(changed.lastRecall.injectionText, /阳台/u);
});

test('current origin沿候选新回执和时间重格式化保留，旧缺字段签名只读兼容', async () => {
  const raw = reachable();
  const previous = raw.stateDeltas[0].subjectSnapshots[0].situational[0];
  const next = { ...previous, id: '77777777-1111-4111-8111-111111111110', text: '仍记得雨夜承诺并在钟楼等待赴约', sourceFloorId: FLOOR2, sourceDeltaId: '77777777-2222-4222-8222-222222222220' };
  raw.floorMemories.push({ ...structuredClone(raw.floorMemories[0]), id: '77777777-3333-4333-8333-333333333330', floorId: FLOOR2, summary: { effectiveSource: 'ai', aiText: '' } });
  raw.stateDeltas.push({ ...structuredClone(raw.stateDeltas[0]), id: '77777777-2222-4222-8222-222222222220', floorId: FLOOR2, floorMemoryId: '77777777-3333-4333-8333-333333333330',
    subjectSnapshots: [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: [next] }],
    fixedChanges: [{ subjectEntityId: PERSON, items: [{ category: 'situational', action: 'refine', before: previous, after: next }] }] });
  let timeReads = 0;
  const h = createRuntimeHarness({ useDefaultSelector: true,
    sourceReader: ({ now }) => readRecallSource({ store: { readReachable: async () => structuredClone(raw) }, now }),
    reachableReader: async () => structuredClone(raw),
    generateUtilityTask: async () => ({ jsonData: { history_exclude_keys: [], state_exclude_keys: [] } }),
    timeProjectionProvider: () => ({ fingerprint: `clock-${++timeReads}`, corrections: {}, reminders: timeReads === 1
      ? [{ itemId: 'origin-time', type: 'deadline', subjectEntityId: PERSON, distance: 0, text: '钟楼约定今天到期', sourceSignature: 'origin-clock' }] : [] }) });
  const result = await h.runtime.intercept(h.chat, 12000, null, 'normal');
  assert.equal(result.lastRecall.status, 'ready', JSON.stringify(result.lastRecall));
  const receipt = structuredClone(h.userMessage.extra[RECALL_RECEIPT_KEY]);
  assert.ok(receipt.skipReasons.includes('optionalTimeChanged'), '实际进入保存选材的时间重格式化消费者');
  assert.equal(receipt.selectedStates.find(value => value.stateId === next.id)?.origin, 'floor', JSON.stringify({ states: receipt.selectedStates, changes: receipt.selectedCseChanges }));
  assert.equal(receipt.injectionText.split(next.text).length - 1, 1, '变化after复用同源当前快照，前后变化及依据保留');
  assert.match(receipt.injectionText, /正文与本线当前快照相同/u);
  assert.ok(receipt.selectedCseChanges.some(value => value.action === 'refine' && value.after.stateId === next.id));
  const historical = await projectHistoricalRecallReceipt(h.userMessage, { chatId: CHAT, userMessageIndex: 1 });
  assert.equal(historical.selectedStates.find(value => value.stateId === next.id)?.origin, 'floor');
  assert.equal(historical.injectionText, receipt.injectionText);
  const legacy = structuredClone(receipt);
  for (const value of legacy.selectedStates) delete value.origin;
  legacy.receiptFingerprint = await receiptFingerprint(legacy);
  h.userMessage.extra[RECALL_RECEIPT_KEY] = legacy;
  const old = await projectHistoricalRecallReceipt(h.userMessage, { chatId: CHAT, userMessageIndex: 1 });
  assert.ok(old);
  assert.equal(old.selectedStates.some(value => Object.hasOwn(value, 'origin')), false);
  assert.equal(h.userMessage.extra[RECALL_RECEIPT_KEY].receiptFingerprint, legacy.receiptFingerprint, '读旧缺字段回执不能补值重签');
});


test('全局破限召回生产selector由实际transport取值，任务候选输出与计量保留', async () => {
  const source = wideCandidateSource({ direct: 3 }), queryContext = buildRecallQueryContext({ coreChat: [{ is_user: true, mes: '阿裴，我们回钟楼赴约。' }] });
  let previousPayload = null;
  for (const value of ['召回共用第一版', '召回共用第二版', '  \n ']) {
    let processing = value, sent;
    const transport = processingTransport({ processingPrompt: () => processing, respond: async options => {
        sent = options; processing = '请求途中修改';
        const payload = JSON.parse(options.taskMessages[0].content);
        if (previousPayload) assert.deepEqual(payload, previousPayload);
        previousPayload = payload;
        return { jsonData: { history_exclude_keys: [], state_exclude_keys: [], priority_keys: [] } };
      } });
    const result = await selectRecallWithLlm({ source, queryContext, contextSize: 65536, processingPrompt: () => processing,
      generateUtilityTask: options => transport.generate(options) });
    const prefix = resolveProcessingPrompt(value), dispatched = transport.bodies[0].messages[0].content;
    assert.equal(dispatched, `${prefix}\n\n${RECALL_LLM_SYSTEM_PROMPT}`);
    assert.equal(dispatched.split(prefix).length - 1, 1);
    assert.equal(sent.systemPrompt, RECALL_LLM_SYSTEM_PROMPT, 'selector仅准备业务prompt，共享前缀在实际派发时注入');
    assert.equal(transport.prefixReads(), 1);
    assert.equal(result.selectorDiagnostic.requestCharacters, sent.systemPrompt.length + sent.taskMessages[0].content.length);
    assert.equal(result.selectorDiagnostic.requestEstimatedTokens, estimateRecallTokens(`${sent.systemPrompt}\n${sent.taskMessages[0].content}`));
    assert.ok(result.injectionText.length > 0);
  }
});


test('全局破限召回runtime新请求取改值，同user冻结回执仍复用原签名', async () => {
  let processing = '运行时共用第一版'; const sent = [];
  const transport = processingTransport({ processingPrompt: () => processing, respond: async options => {
    sent.push(options); return { jsonData: { history_exclude_keys: [], state_exclude_keys: [] } };
  } });
  const h = createRuntimeHarness({ useDefaultSelector: true, processingPrompt: () => processing,
    generateUtilityTask: options => transport.generate(options) });
  await h.runtime.intercept(h.chat, 12000, null, 'normal'); await flushReceiptSave();
  const receipt = structuredClone(h.userMessage.extra[RECALL_RECEIPT_KEY]);
  assert.ok(transport.bodies[0].messages[0].content.startsWith(processing+'\n\n'));
  assert.equal(sent[0].systemPrompt, RECALL_LLM_SYSTEM_PROMPT);
  processing = '运行时共用第二版';
  const reused = await h.runtime.intercept(h.chat, 12000, null, 'continue');
  assert.equal(reused.lastRecall.reusedReceipt, true); assert.equal(sent.length, 1);
  assert.deepEqual(h.userMessage.extra[RECALL_RECEIPT_KEY], receipt);
  for (const value of ['运行时共用第二版', '  \n ']) {
    processing = value;
    h.chat.push({ is_user: false, mes: '钟楼仍有人等待。' }, { is_user: true, mes: '阿裴，我们回钟楼赴约。' });
    await h.runtime.intercept(h.chat, 12000, null, 'normal');
    const prefix = resolveProcessingPrompt(value), dispatched = transport.bodies.at(-1).messages[0].content;
    assert.equal(dispatched, `${prefix}\n\n${RECALL_LLM_SYSTEM_PROMPT}`);
    assert.equal(dispatched.split(prefix).length - 1, 1);
  }
  assert.equal(sent.length, 3); assert.equal(transport.bodies.length, 3); assert.equal(transport.prefixReads(), 3);
});


test('有效别名：新召回source只投影人工全集，历史事实和人物ID保持', async () => {
  const value = reachable(), original = structuredClone(value);
  const result = await projectRecallSource(value, () => new Date(NOW), sourceAttempts('ready'), null, {}, false,
    { profilesByEntityId: { [PERSON]: { aliases: '新称', manualFields: ['aliases'] } } });
  assert.deepEqual(result.entities[0].aliases, ['新称']);
  assert.equal(result.entities[0].entityId, PERSON);
  assert.deepEqual(value, original);
  const delta = await compileQianshiDelta({ floor: { ...value.floors[0], chatId: CHAT, narrativeGeneration: GEN }, now: NOW, entities: value.entities,
    identityProjection: { profilesByEntityId: { [PERSON]: { aliases: '新称', manualFields: ['aliases'] } } },
    packet: { qianshi: { events: [{ key: 'arrive', title: '抵达会场', description: '新称抵达会场', status: 'occurred', matter: false, people: ['新称'] }], order: [] } } });
  assert.equal(delta.events[0].people[0].entityId, PERSON);
  assert.equal(result.floorMemories[0].summary, original.floorMemories[0].summary.aiText);
});


test('所有已存人物统一按事实相关性竞争，NPC未点名和有向关系不受角色门禁', () => {
  const ids = ['88888888-7777-4777-8777-777777777777', PERSON, '99999999-7777-4777-8777-777777777777'];
  const make = roles => {
    const source = selectorSource({ currentState: ids.map((subjectEntityId, index) => ({ subjectEntityId, core: [], adaptive: [],
      situational: [recallState(`equal-${index}`, '钟楼钥匙仍未归还，正在等待接头', 2, { towardEntityId: ids[(index + 1) % 3] })] })) });
    source.entities = source.entities.map(entity => ({ ...entity, specialRole: roles[ids.indexOf(entity.entityId)] }));
    source.cseChanges = ids.map((subjectEntityId, index) => ({ subjectEntityId, deltaId: `delta-${index}`, floorId: 'floor-2', assistantSeq: 2, layer: 'situational', action: 'remove',
      before: recallState(`old-${index}`, '钟楼钥匙旧接头已取消', 2, { towardEntityId: ids[(index + 1) % 3] }), after: null }));
    return source;
  };
  const queryContext = { text: '钟楼钥匙的接头还要等吗', latestUserText: '钟楼钥匙的接头还要等吗' };
  let expected;
  for (const roles of [['user','char','none'], ['none','user','char'], ['char','none','user']]) {
    const source = make(roles), context = cseSelectionContext(source, queryContext), pool = buildRecallCseCandidatePool({ source, queryContext });
    assert.equal(context.states.length, 3); assert.equal(context.changes.length, 3);
    assert.equal(pool.candidates.length, 6);
    const order = pool.candidates.map(candidate => [candidate.value.subjectEntityId, candidate.value.towardEntityId ?? candidate.value.before?.towardEntityId, candidate.source]);
    if (expected) assert.deepEqual(order, expected, '仅互换角色标签不改变同事实排序'); else expected = order;
    const selected = selectRecall({ source, queryContext, contextSize: 30000 });
    assert.equal(selected.states.length, 3); assert.equal(selected.cseChanges.length, 3);
    assert.equal(new Set(selected.states.map(value => value.towardEntityId)).size, 3);
    assert.ok(selected.stages.estimatedTokenCount <= selected.stages.estimatedTokenBudget);
  }
});

test('长查询先保最新用户意图且不突破8000，独立姓名字段仍可识别', () => {
  const latest = '现在请去找乙核对钟楼钥匙';
  const query = buildRecallQueryContext({ coreChat: [
    { is_user: true, is_system: false, mes: '旧背景'.repeat(1500) },
    { is_user: false, is_system: false, mes: '旧回复'.repeat(1500) },
    { is_user: true, is_system: false, mes: latest },
  ] });
  assert.ok(query.text.endsWith(latest)); assert.ok(query.text.length <= 8000);
  assert.equal(query.latestUserText, latest); assert.equal(query.messageCount, 3);
});


test('未点名NPC承诺进入原同次LLM选材，无关NPC不挤占候选或预算', async () => {
  const npc = '99999999-7777-4777-8777-777777777777';
  const source = selectorSource({ currentState: [{ subjectEntityId: npc, core: [], adaptive: [],
    situational: [recallState('npc-promise', '港口救援的信号灯还未点亮，仍须履行接应承诺', 3, { towardEntityId: PERSON, visibility: 'expressed' })] }] });
  for (let index = 0; index < 40; index++) {
    const id = `unrelated-${index}`;
    source.entities.push({ entityId: id, displayName: `无关人物${index}`, aliases: [], entityType: 'person', specialRole: 'none' });
    source.currentState.push({ subjectEntityId: id, core: [], adaptive: [], situational: [recallState(`unrelated-state-${index}`, '桃园练习书法', 3)] });
  }
  let calls = 0;
  const result = await selectRecallWithLlm({ source, queryContext: { text: '港口救援信号灯的接应承诺怎么办', latestUserText: '港口救援信号灯的接应承诺怎么办' }, contextSize: 30000,
    generateUtilityTask: async options => {
      calls++;
      const payload = JSON.parse(options.taskMessages[0].content);
      assert.match(options.systemPrompt, /user、char标识和历史出场频次不提供选材优先权/);
      assert.ok(payload.cseContextGroups.some(group => group.subject === '乙' && group.items.some(item => JSON.stringify(item).includes('接应承诺'))));
      assert.ok(!JSON.stringify(payload.cseContextGroups).includes('桃园练习书法'));
      return { jsonData: { history_exclude_keys: [], state_exclude_keys: [], artifact_select_keys: [], annual_retain_keys: [], priority_keys: [] } };
    } });
  assert.equal(calls, 1); assert.match(result.injectionText, /仍须履行接应承诺/); assert.doesNotMatch(result.injectionText, /桃园练习书法/);
  assert.ok(result.limits.estimatedTokenCount <= result.limits.estimatedTokenBudget);
});


test('新聊全部历史仍在N正文时即使已有CSE也跳过整次召回，不复用旧早期回执', async () => {
  let calls = 0, semanticCalls = 0;
  const source = selectorSource({ memories: [recallMemory(1, { summary: '裴晚生准备回钟楼赴约。' })],
    currentState: [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: [recallState('early', '裴晚生准备回钟楼赴约', 1)] }] });
  source.bodyMatchRefs = [{ floorId: 'floor-1', floorMemoryId: 'memory-1', assistantSeq: 1, hostLocator: { messageIndex: 0, swipeId: null, selectedSwipeIndex: null },
    rawFingerprint: await fingerprintText('街上已经安静。'), canonicalFingerprint: await fingerprintText('街上已经安静。') }];
  const harness = createRuntimeHarness({ sourceReader: async () => structuredClone(source), reachableReader: async () => rawReachableFromSource(source),
    useDefaultSelector: true, recentBodyFloorLimit: () => 3,
    semanticProvider: async () => { semanticCalls++; return { candidates: [], diagnostic: { status: 'disabled' } }; },
    generateUtilityTask: async () => { calls++; throw Object.assign(new Error('不应进入180秒等待'), { code: 'QQJ_TIMEOUT' }); } });
  const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(result.lastRecall.status, 'skipped');
  assert.ok(result.lastRecall.skipReasons.includes('recentBodyOnly'));
  assert.match(projectInlineRecallReceipt(result.lastRecall).summary, /近期正文已覆盖，无需召回/);
  assert.equal(calls, 0); assert.equal(semanticCalls, 0);
  assert.equal(latestPromptValue(harness.prompts, RECALL_PROMPT_SLOT), '');
  assert.equal(harness.saves, 0);
});

async function earlyRecallHarness({ count = 1, keep = 3, type = 'normal', prequel = null, archived = false, missingCore = false, hidden = false } = {}) {
  const messages = [];
  for (let i = 1; i <= count; i++) messages.push({ is_user: false, is_system: false, mes: `裴晚生在钟楼等候，第${i}段正文。` }, { is_user: true, is_system: false, mes: `第${i}段用户输入` });
  const memories = Array.from({ length: count }, (_, index) => recallMemory(index + 1, { summary: '裴晚生在钟楼等候。' }));
  const source = selectorSource({ memories, currentState: [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: [recallState('early-state', '裴晚生在钟楼等候', Math.max(1, count))] }] });
  source.bodyMatchRefs = await Promise.all(memories.map(async (m, index) => ({ floorId: m.floorId, floorMemoryId: m.floorMemoryId, assistantSeq: m.assistantSeq,
    hostLocator: { messageIndex: index * 2, swipeId: null, selectedSwipeIndex: null }, rawFingerprint: await fingerprintText(messages[index * 2].mes), canonicalFingerprint: await fingerprintText(messages[index * 2].mes) })));
  if (archived) source.migrationDescriptor = { id: 'archive', frozenFloorIds: ['archived-f1'], carriedAliases: [] };
  let calls = 0, selections = 0;
  const h = createRuntimeHarness({ sourceReader: async () => structuredClone(source), reachableReader: async () => rawReachableFromSource(source), recentBodyFloorLimit: () => keep, prequel,
    selector: input => { selections++; return selectRecall(input); }, generateUtilityTask: async () => { calls++; throw new Error('selector must stay local'); } });
  h.chat.splice(0, h.chat.length, ...messages.slice(0, -1), h.userMessage);
  if (hidden) h.chat[0].is_system = true;
  if (['regenerate', 'swipe'].includes(type)) h.chat.push({ is_user: false, is_system: false, mes: '将被替换的旧答案，不是额外历史' });
  const core = structuredClone(h.chat);
  if (missingCore) core.splice(0, 1);
  return { ...h, source, core, type, get selections() { return selections; }, get calls() { return calls; } };
}

test('新聊免召回按可配N和生成前AI历史判断，开场白计数但user系统楼和目标旧答案不计', async () => {
  for (const spec of [
    { count: 1, keep: 1, skip: true }, { count: 2, keep: 1, skip: false },
    { count: 3, keep: 3, skip: true }, { count: 4, keep: 3, skip: false },
    { count: 5, keep: 5, skip: true }, { count: 6, keep: 5, skip: false },
    { count: 3, keep: 3, type: 'swipe', skip: true }, { count: 3, keep: 3, type: 'regenerate', skip: true },
  ]) {
    const h = await earlyRecallHarness(spec);
    // These do not become AI narrative history or push a short chat past N.
    h.chat.splice(h.chat.length - (['swipe', 'regenerate'].includes(spec.type) ? 2 : 1), 0, { is_user: true, is_system: false, mes: '额外用户续话' }, { is_user: false, is_system: true, extra: { type: 'narrator' }, mes: '系统事件' });
    const result = await h.runtime.intercept(structuredClone(h.chat), 12000, null, h.type);
    assert.equal(result.lastRecall.skipReasons.includes('recentBodyOnly'), spec.skip, JSON.stringify(spec));
    assert.equal(h.selections, spec.skip ? 0 : 1, JSON.stringify(spec));
  }
});

test('短宿主不抹归档或显式前情，正文缺失或隐藏不能冒充完整早期基座', async () => {
  for (const spec of [{ archived: true }, { prequel: '用户明确导入的过去经历：曾在钟楼许诺。' }, { missingCore: true }, { hidden: true }]) {
    const h = await earlyRecallHarness(spec);
    const result = await h.runtime.intercept(h.core, 12000, null, 'normal');
    assert.equal(result.lastRecall.skipReasons.includes('recentBodyOnly'), false, JSON.stringify(spec));
    assert.equal(h.selections, 1, JSON.stringify(spec));
    if (spec.prequel) assert.match(latestPromptValue(h.prompts, PREQUEL_PROMPT_SLOT), /用户明确导入的过去经历/);
  }
});

test('新聊早期已有非空冻结回执也先执行基座免召回', async () => {
  const h = await earlyRecallHarness({ prequel: '在钟楼的导入前情' });
  await h.runtime.intercept(h.core, 12000, null, 'normal');
  assert.equal(h.selections, 1); assert.ok(h.userMessage.extra[RECALL_RECEIPT_KEY].selectedStates.length);
  h.context.chatMetadata.qianqianjiePrequel = '';
  const result = await h.runtime.intercept(h.core, 12000, null, 'regenerate');
  assert.equal(result.lastRecall.status, 'skipped'); assert.equal(result.lastRecall.reusedReceipt, false);
  assert.ok(result.lastRecall.skipReasons.includes('recentBodyOnly')); assert.equal(h.selections, 1);
  assert.equal(latestPromptValue(h.prompts, RECALL_PROMPT_SLOT), '');
});

test('新聊mes与selected swipe不同仍按实际core正文免召回，旧非空回执不得绕过', async () => {
  const h = await earlyRecallHarness({ count: 2, keep: 3, prequel: '先生成合法旧回执的既有前情' });
  h.chat[0].mes += '\r\n开场白的第二段实际发送正文。\r\n';
  h.chat[0].swipes = ['旧候选零', '旧候选一', '源记录对应的开场swipe正文。']; h.chat[0].swipe_id = 2;
  h.source.bodyMatchRefs[0] = { ...h.source.bodyMatchRefs[0], hostLocator: { messageIndex: 0, swipeId: 2, selectedSwipeIndex: 2 },
    rawFingerprint: await fingerprintText(h.chat[0].swipes[2]), canonicalFingerprint: await fingerprintText(h.chat[0].swipes[2]) };
  const core = structuredClone(h.chat);
  await h.runtime.intercept(core, 12000, null, 'normal');
  const oldReceipt = h.userMessage.extra[RECALL_RECEIPT_KEY]; assert.ok(oldReceipt.selectedStates.length); assert.equal(h.selections, 1);
  h.context.chatMetadata.qianqianjiePrequel = '';
  const result = await h.runtime.intercept(core, 12000, null, 'normal');
  assert.equal(result.lastRecall.status, 'skipped'); assert.deepEqual(result.lastRecall.skipReasons, ['recentBodyOnly']);
  assert.equal(h.selections, 1); assert.equal(h.userMessage.extra[RECALL_RECEIPT_KEY], oldReceipt);
  assert.equal(latestPromptValue(h.prompts, RECALL_PROMPT_SLOT), '');
});

test('新聊已注册重生目标不算更早历史，N加一目标与首次生成同样免召回', async () => {
  for (const count of [2, 3, 4]) for (const type of ['regenerate', 'swipe']) {
    const h = await earlyRecallHarness({ count, keep: 3, prequel: '先建立合法旧回执的过去经历' });
    h.chat.splice((count - 1) * 2 - 1, 1, h.userMessage); h.chat.pop();
    const core = structuredClone(h.chat);
    await h.runtime.intercept(core, 12000, null, 'normal');
    const receipt = h.userMessage.extra[RECALL_RECEIPT_KEY]; assert.ok(receipt.selectedStates.length);
    h.context.chatMetadata.qianqianjiePrequel = '';
    const result = await h.runtime.intercept(core, 12000, null, type);
    assert.equal(result.lastRecall.status, 'skipped', `${count}/${type}`);
    assert.deepEqual(result.lastRecall.skipReasons, ['recentBodyOnly']); assert.equal(h.selections, 1);
    assert.equal(h.userMessage.extra[RECALL_RECEIPT_KEY], receipt);
    assert.equal(latestPromptValue(h.prompts, RECALL_PROMPT_SLOT), '');
  }
});

test('固定设施从body覆盖和近期楼照常形成行动条件候选并只用原一次选材', async () => {
  const room = 'aaaaaaaa-1111-4111-8111-000000000001';
  for (const featureSeq of [1, 6, 8]) {
    const value = reachable(); value.stateDeltas = []; value.baseline = null;
    value.entities.push({ id: room, entityType: 'place', displayName: '东区公寓卧室', aliases: [], specialRole: 'none', recordStatus: 'active', status: 'established' });
    value.floors = Array.from({ length: 8 }, (_, index) => ({ id: `${(index+1).toString(16).padStart(8,'0')}-0000-4000-8000-000000000001`, assistantSeq: index+1 }));
    value.floorMemories = value.floors.map((floor,index) => ({ ...structuredClone(emptyMemory), id: `${(index+1).toString(16).padStart(8,'0')}-0000-4000-8000-000000000002`, floorId: floor.id, recordStatus: 'active', summary: { effectiveSource: 'ai', aiText: '安静休息。' }, spatialFacts: { schemaVersion: 1, containments: [], positions: index===7 ? [{ subjectEntityId: PERSON, placeEntityId: room, status: 'confirmed', evidenceRefs: [{ floorId: floor.id, quotedText: '仍在卧室', occurrence: 1 }] }] : [], ...(index+1===featureSeq ? { features: [{ itemId: ITEM, placeEntityId: room, kind: 'stable', text: '房内有独立卫生间。', replacesItemIds: [], evidenceRefs: [{ floorId: floor.id, quotedText: '房内有独立卫生间', sourceType: 'precedingUser', sourceSnapshotIndex: 0, occurrence: 1 }] }] } : {}) } }));
    const source = await projectRecallSource(value, () => new Date(NOW));
    const covered = { ...source, bodyMatch: { recentBodyFloorIds: [value.floors[featureSeq-1].id] } };
    const queryContext = { text: '我先去洗漱。', latestUserText: '我先去洗漱。', messageCount: 1 };
    const pool = buildRecallHistoryCandidatePool({ source: covered, queryContext });
    assert.ok(pool.candidates.some(candidate => candidate.value.kind==='placeFeature' && candidate.text.includes('独立卫生间')), `来源AI#${featureSeq}应提供设施候选`);
    assert.ok(pool.limits.actualCandidates<=48); assert.ok(pool.text.length<=24000);
    let calls = 0;
    const selected = await selectRecallWithLlm({ source: covered, queryContext, contextSize: 12000, generateUtilityTask: async () => { calls++; return { jsonData: { history_exclude_keys: [], state_exclude_keys: [] } }; } });
    assert.equal(calls, 1); assert.match(selected.injectionText, /东区公寓卧室.*房内有独立卫生间/u);
  }
});

test('地点设施情境只认最新场景，纯提及不清场景，泛称不串同名房间并沿唯一父级', () => {
 const east='east-room',west='west-room',suite='east-suite';
 const feature=(itemId,placeEntityId,floorId,assistantSeq,text)=>({itemId,placeEntityId,kind:'stable',text,replacesItemIds:[],sourceRefs:[{floorId,assistantSeq,quotedText:text}]});
 const memories=[recallMemory(1,{spatialFacts:{containments:[],positions:[],features:[feature('west-feature',west,'floor-1',1,'西屋有壁炉。')]}}),recallMemory(2,{spatialFacts:{containments:[{placeEntityId:east,parentEntityId:suite,sourceRefs:[{floorId:'floor-2',assistantSeq:2}]}],positions:[{subjectEntityId:PERSON,placeEntityId:east,status:'confirmed',sourceRefs:[{floorId:'floor-2',assistantSeq:2}]}],features:[feature('east-feature',east,'floor-2',2,'房内有独立卫生间。'),feature('suite-feature',suite,'floor-2',2,'套房有全天热水。')]}}),recallMemory(3,{locations:[{entityId:'paris',name:'巴黎',change:'mentioned',participantEntityIds:[],sourceRefs:[{floorId:'floor-3',assistantSeq:3}]}]})];
 const source=selectorSource({memories});source.entities.push(...[{entityId:east,displayName:'东屋',aliases:['房间']},{entityId:west,displayName:'西屋',aliases:['房间','我的房间']},{entityId:suite,displayName:'东区套房',aliases:[]}].map(item=>({...item,entityType:'place'})));
 const kinds=text=>buildRecallHistoryCandidatePool({source,queryContext:{text,latestUserText:text,messageCount:1}}).candidates.filter(row=>row.value.kind==='placeFeature').map(row=>row.value.itemId).sort();
 assert.deepEqual(kinds('去洗漱。'),['east-feature','suite-feature'],'纯提及其它城市不清当前卧室，父级设施可用');
 assert.deepEqual(kinds('我的房间，去洗漱。'),['east-feature','suite-feature'],'房间泛称不能激活异地址的西屋');
 memories[2].spatialFacts={containments:[],positions:[{subjectEntityId:PERSON,placeEntityId:east,status:'leftUnknown',sourceRefs:[{floorId:'floor-3',assistantSeq:3}]}]};
 assert.deepEqual(kinds('去洗漱。'),[],'离开后不回退旧present或其它人物古老位置');
 assert.deepEqual(kinds('西屋的陈设'),['west-feature'],'显式具体地点仍可供询问历史地点条件');
});

test('聚合地点事实用成员来源序累计替换，早楼截止与缺省旧字段保持', async () => {
 const {projectPlaceFeatures}=await import('../src/v3/spatial-domain.js');
 const old={itemId:'old',placeEntityId:'east',kind:'stable',text:'有卫生间',replacesItemIds:[],sourceRefs:[{floorId:'member-1',assistantSeq:1,quotedText:'有卫生间'}]};
 const table={itemId:'desk',placeEntityId:'east',kind:'stable',text:'固定木桌',replacesItemIds:[],sourceRefs:[{floorId:'member-2',assistantSeq:2,quotedText:'固定木桌'}]};
 const removed={itemId:'removed',placeEntityId:'east',kind:'stable',text:'卫生间已拆除',replacesItemIds:['old'],sourceRefs:[{floorId:'member-3',assistantSeq:3,quotedText:'卫生间已拆除'}]};
 const memory=recallMemory(3,{spatialFacts:{containments:[],positions:[],features:[old,table,removed]}});memory.floorId='member-3';
 const before=structuredClone(memory);
 assert.deepEqual(projectPlaceFeatures({floorMemories:[memory],throughAssistantSeq:1}).map(item=>item.itemId),['old']);
 assert.deepEqual(projectPlaceFeatures({floorMemories:[memory]}).map(item=>item.itemId),['desk','removed']);
 assert.deepEqual(memory,before);assert.deepEqual(projectPlaceFeatures({floorMemories:[recallMemory(1)]}),[]);
});

test('v23旧回执只读兼容，正常新选材升级设施策略一次且随后复用', async () => {
 let calls=0;const h=createRuntimeHarness({selector:input=>{calls++;return selectRecall(input);}});
 await h.runtime.intercept(h.chat,12000,null,'normal');const receipt=structuredClone(h.userMessage.extra[RECALL_RECEIPT_KEY]);receipt.strategyVersion='continuity-v23';receipt.receiptFingerprint=await receiptFingerprint(receipt);h.userMessage.extra[RECALL_RECEIPT_KEY]=receipt;h.runtime.invalidate('legacy-feature-policy');
 const old=await h.runtime.restorePersistedReceipt();assert.equal(old.lastRecall.legacyReadOnly,true);assert.equal(h.userMessage.extra[RECALL_RECEIPT_KEY].receiptFingerprint,receipt.receiptFingerprint);
 await h.runtime.intercept(h.chat,12000,null,'regenerate');assert.equal(calls,2);assert.equal(h.userMessage.extra[RECALL_RECEIPT_KEY].strategyVersion,RECALL_STRATEGY_VERSION);
 await h.runtime.intercept(h.chat,12000,null,'regenerate');assert.equal(calls,2);
});

test('地点分型经真实DTO保留，临时与legacy只作历史候选不冒当前设施', async () => {
  const place = '98989898-9898-4989-8989-989898989898';
  const feature = (itemId, kind, text) => ({ itemId, placeEntityId: place, ...(kind ? { kind } : {}), text, replacesItemIds: [], evidenceRefs: [{ floorId: 'floor-1', quotedText: text }] });
  const value = reachable(); const floor = value.floors[0], memory = value.floorMemories[0];
  memory.spatialFacts = { schemaVersion: 1, containments: [], positions: [], features: [feature('stable', 'stable', '房内有固定书桌。'), feature('scene', 'temporary', '当时门外有访客等候。'), feature('legacy', null, '旧记录提到壁炉。')], relations: [{ itemId: 'relation', kind: 'relative', placeEntityId: place, referencePlaceEntityIds: [], text: '在走廊尽头。', evidenceRefs: [{ floorId: floor.id, quotedText: '在走廊尽头。' }] }] };
  for (const item of memory.spatialFacts.features) item.evidenceRefs[0].floorId = floor.id;
  value.entities.push({ id: place, entityType: 'place', displayName: '东屋', aliases: [], status: 'provisional', recordStatus: 'active', specialRole: 'none' });
  memory.locations = [{ entityId: place, name: '东屋', change: 'present', participantEntityIds: [], evidenceRefs: [{ floorId: floor.id, quotedText: '东屋' }] }];
  const source = await projectRecallSource(value, () => new Date(NOW));
  assert.deepEqual(source.floorMemories[0].spatialFacts.features.map(item => item.kind ?? null), ['stable', 'temporary', null]);
  assert.equal(source.floorMemories[0].spatialFacts.relations[0].text, '在走廊尽头。');
  const queryContext = { text: '东屋的书桌、访客和壁炉。', latestUserText: '东屋的书桌、访客和壁炉。', messageCount: 1 };
  const pool = buildRecallHistoryCandidatePool({ source, queryContext });
  const values = pool.candidates.map(row => row.value);
  assert.deepEqual(values.filter(value => value.kind === 'placeFeature').map(value => value.itemId), ['stable']);
  assert.ok(values.some(value => value.kind === 'placeScene' && /当时/u.test(value.text)));
  assert.ok(values.some(value => value.kind === 'placeDescription' && /持续性未标/u.test(value.text)));
  assert.ok(values.some(value => value.kind === 'spatialRelation' && /走廊尽头/u.test(value.text)));
  assert.ok(pool.limits.actualCandidates <= 48); assert.ok(pool.text.length <= 24000);
});

test('聚合历史地点描述与关系逐成员来源排正文覆盖并守截止', () => {
  const place = '东屋id', ref = n => ({ floorId: `member-${n}`, assistantSeq: n, quotedText: '东屋场景' });
  const memory = recallMemory(3, { spatialFacts: { containments: [], positions: [], features: [1,2,3].map(n => ({ itemId: `feature-${n}`, placeEntityId: place, ...(n===2 ? {kind:'temporary'} : {}), text: `东屋场景描述${n}`, replacesItemIds: [], sourceRefs: [ref(n)] })), relations: [1,2,3].map(n => ({ itemId: `relation-${n}`, kind: 'relative', placeEntityId: place, referencePlaceEntityIds: [], text: `东屋位置${n}`, sourceRefs: [ref(n)] })) } });
  memory.sourceFloorIds = ['member-1','member-2','member-3'];
  const source = selectorSource({ memories: [memory] }); source.coverage.stableThroughAssistantSeq = 2; source.bodyMatch = { recentBodyFloorIds: ['member-1'] };
  source.entities.push({ entityId: place, entityType: 'place', displayName: '东屋', aliases: [], specialRole:'none' });
  source.bodyMatchRefs = [{ floorId: 'member-2', frozen: true, sourceOrigin: { sourceMessageIndex: 4 } }];
  const pool = buildRecallHistoryCandidatePool({ source, queryContext: { text:'东屋场景位置', latestUserText:'东屋场景位置', messageCount:1 } });
  const values = pool.candidates.map(row=>row.value).filter(value=>['placeScene','placeDescription','spatialRelation'].includes(value.kind));
  assert.deepEqual(values.map(value=>value.itemId).sort(), ['feature-2','relation-2']);
  assert.ok(values.every(value=>value.sourceAssistantSeq===2));
  assert.ok(pool.candidates.filter(row=>['placeScene','placeDescription','spatialRelation'].includes(row.value.kind)).every(row=>/^来源聊天第 4 楼 · AI #2｜/u.test(row.text)), '实际候选头部与成员来源一致，不能标承载AI3');
  for (const withStoryline of [false, true]) {
    const items = values.map(value => ({ ...value, ...(withStoryline ? { storylineId: 'line-1' } : {}) }));
    const injection = formatRecallInjection({ coverage: source.coverage, floors: [{ floorId: memory.floorId, assistantSeq: 3, chronology: [{ time: { kind:'explicit', sourceText:'承载楼的错误时间' } }], items }], states: [], cseChanges: [], entityById: new Map(source.entities.map(entity=>[entity.entityId,entity])), storylines: withStoryline ? [{ storylineId:'line-1', title:'地点来源' }] : [] });
    assert.doesNotMatch(injection, /AI #3|承载楼的错误时间/u); assert.match(injection, /AI #2/u);
  }
});

test('当前和旧地点标注均不独立注入，历史事件仍可选',()=>{
  const source=selectorSource();source.floorMemories.forEach((memory,index)=>{memory.summary=`钟楼约定 林岚旧事${index+1}`;memory.locationReferences=[{text:`旧场地${index+1}`,sourceFloorId:memory.floorId,assistantSeq:index+1,hostLocator:{messageIndex:index}}];});
  source.bodyMatch={locationReferences:[{text:'汝矣岛新商场',sourceFloorId:null,assistantSeq:9,hostLocator:{messageIndex:20}}]};
  const queryContext={text:'钟楼约定 林岚',latestUserText:'钟楼约定 林岚',messageCount:1};
  const pool=buildRecallHistoryCandidatePool({source,queryContext});
  const result=selectRecall({source,queryContext,selectedHistoryCandidates:pool.candidates,selectedCseCandidates:[],contextSize:48000,maxItems:100});
  assert.deepEqual(result.locationReferences,[]);assert.equal(result.stages.locationReferenceCount,0);assert.ok(result.floors.length>0);
});

test('地点范围：新场地同泛名不能激活旧无范围通道的稳定设施',()=>{
  const passage='88888888-7777-4777-8777-777777777770';
  const old=recallMemory(1,{summary:'上岩洞员工通道曾安装固定铁门。',locations:[{name:'员工通道',entityId:passage,change:'present'}],locationReferences:[{text:'上岩洞商场中庭',sourceFloorId:'floor-1',assistantSeq:1}],spatialFacts:{containments:[],positions:[],features:[{itemId:'old-door',placeEntityId:passage,kind:'stable',text:'有固定铁门',replacesItemIds:[],sourceRefs:[{floorId:'floor-1',assistantSeq:1}]}]}});
  old.locationReferences=[{text:'上岩洞商场中庭',sourceFloorId:'floor-1',assistantSeq:1}];
  const source=selectorSource({memories:[old,recallMemory(2,{summary:'到达汝矣岛商场。'})]});
  source.entities.push({entityId:passage,entityType:'place',displayName:'员工通道',aliases:[],specialRole:'none'});source.bodyMatch={locationReferences:[{text:'汝矣岛商场·员工通道',sourceFloorId:null,hostLocator:{messageIndex:8}}]};
  const queryContext={text:'走员工通道继续前行',latestUserText:'走员工通道继续前行',messageCount:1};
  const context=historySelectionContext(source,queryContext);assert.equal(context.facts.some(item=>item.kind==='placeFeature'&&item.itemId==='old-door'),false);
  assert.ok(context.recentSummaries.some(item=>item.text.includes('上岩洞')),'旧事件摘要仍在历史材料');
});

test('地点范围：已确认异地且无header时，旧泛名稳定设施也只供历史用途',()=>{
  const oldId='88888888-7777-4777-8777-777777777770',newId='88888888-7777-4777-8777-777777777771';
  const old=recallMemory(1,{summary:'上岩洞员工通道有铁门。',spatialFacts:{containments:[],positions:[],features:[{itemId:'old-fixed',placeEntityId:oldId,kind:'stable',text:'有固定铁门',replacesItemIds:[],sourceRefs:[{floorId:'floor-1',assistantSeq:1}]}]}});
  const latest=recallMemory(2,{summary:'已进入汝矣岛员工通道。',spatialFacts:{containments:[],positions:[{subjectEntityId:PERSON,placeEntityId:newId,status:'confirmed',sourceRefs:[{floorId:'floor-2',assistantSeq:2}]}]}});
  const source=selectorSource({memories:[old,latest]});source.entities.push(...[[oldId,'员工通道'],[newId,'汝矣岛员工通道']].map(([entityId,displayName])=>({entityId,displayName,aliases:[],entityType:'place',specialRole:'none'})));
  const context=historySelectionContext(source,{text:'员工通道铁门',latestUserText:'员工通道铁门',messageCount:1});
  assert.equal(context.facts.some(item=>item.kind==='placeFeature'&&item.itemId==='old-fixed'),false);
  assert.ok(context.facts.some(item=>item.kind==='placeDescription'&&item.itemId==='old-fixed'&&item.text.includes('场地未核对')));
});

test('地点方位人工一条替换旧三条并进入真实候选/注入，清空后不复活', async () => {
  const room = '22223333-2222-4222-8222-222222222222';
  const graph = reachable();
  graph.entities.push({ ...graph.entities[0], id: room, entityType: 'place', specialRole: 'none', displayName: '道英房间', aliases: [] });
  graph.floorMemories[0].spatialFacts = { schemaVersion: 1, containments: [], positions: [], features: [], relations: [1, 2, 3].map((n) => ({
    itemId: `0000000${n}-2222-4222-8222-222222222222`, placeEntityId: room, kind: 'relative', referencePlaceEntityIds: [], text: `道英房间旧方位${n}`,
    evidenceRefs: [{ floorId: FLOOR1, quotedText: `道英房间旧方位${n}`, occurrence: 1, evidenceMode: 'explicit' }],
  })) };
  const workspace = { schemaVersion: 1, kind: 'qqj-v3-place-workspace', chatId: CHAT, deletionsByEntityId: {}, placesByEntityId: { [room]: {
    relations: '道英房间在一楼走廊末端', scopes: { relations: { knownThroughFloorId: FLOOR1, coveredFloorIds: [FLOOR1], coveredItemIds: [] } },
  } } };
  const queryContext = { text: '道英房间方位', latestUserText: '道英房间方位', messageCount: 1 };
  const before = await projectRecallSource(graph, () => new Date(NOW));
  assert.equal(buildRecallHistoryCandidatePool({ source: before, queryContext }).candidates.filter(c => c.value.kind === 'spatialRelation').length, 3);
  const after = await projectRecallSource(graph, () => new Date(NOW), null, null, {}, false, { placeWorkspace: workspace, placeWorkspaceRevision: 1 });
  const pool = buildRecallHistoryCandidatePool({ source: after, queryContext });
  assert.equal(pool.candidates.filter(c => c.value.kind === 'spatialRelation').length, 0);
  assert.equal(pool.candidates.filter(c => c.value.kind === 'manualPlace').length, 1);
  const selected = selectRecall({ source: after, queryContext, contextSize: 12000, selectedHistoryCandidates: pool.candidates });
  assert.match(selected.injectionText, /人工修订优先/u);
  assert.match(selected.injectionText, /一楼走廊末端/);
  assert.doesNotMatch(selected.injectionText, /旧方位/);
  assert.equal(selected.floors.some(f => f.floorId.startsWith('manual-place-')), false, '人工事实不冒充剧情楼');
  workspace.placesByEntityId[room].relations = '';
  const cleared = await projectRecallSource(graph, () => new Date(NOW), null, null, {}, false, { placeWorkspace: workspace, placeWorkspaceRevision: 2 });
  assert.equal(buildRecallHistoryCandidatePool({ source: cleared, queryContext }).candidates.some(c => ['manualPlace','spatialRelation'].includes(c.value.kind)), false);
});

test('当前地点同文成员归并来源，不同方位参照保独立成员并共占一席',()=>{
 const room='22223333-2222-4222-8222-222222222222',source=selectorSource(),text='设有床和卫浴。';
 source.entities.push({entityId:room,displayName:'示例房间',aliases:[],entityType:'place',specialRole:'none'});
 const facts=[1,2,3].map(n=>({itemId:`same-${n}`,kind:'feature',placeEntityId:room,text,source:{kind:'worldbook',locator:`entry:${n}`,quote:`来源${n}`}}));
 facts.push({itemId:'direction-a',kind:'relation',placeEntityId:room,text,relationKind:'relative',referencePlaceEntityIds:[PERSON],source:facts[0].source},{itemId:'direction-b',kind:'relation',placeEntityId:room,text,relationKind:'relative',referencePlaceEntityIds:[ITEM],source:facts[1].source});
 source.placeWorkspace={placesByEntityId:{},foundation:{entities:[],facts}};
 const rows=historySelectionContext(source,{text:'示例房间',latestUserText:'示例房间'}).facts.filter(f=>f.kind==='placeFoundation');
 assert.equal(rows.length,1);const members=rows[0]._placeMembers;assert.equal(members.length,3);const merged=members.find(r=>r.itemIds?.length===3);assert.ok(merged);assert.deepEqual(new Set(merged.itemIds),new Set(['same-1','same-2','same-3']));assert.deepEqual(new Set(merged.source.references.map(s=>s.locator)),new Set(['entry:1','entry:2','entry:3']));assert.deepEqual(members.slice(1).map(m=>m.referencePlaceEntityIds),[[PERSON],[ITEM]]);
});

test('自动当前方位覆盖旧五条进入正式召回DTO与候选，显式历史前缀仍可读原五条',async()=>{
 const room='22223333-2222-4222-8222-222222222222',graph=reachable(),ids=[1,2,3,4,5].map(n=>`0000000${n}-2222-4222-8222-222222222222`);
 graph.entities.push({...graph.entities[0],id:room,entityType:'place',specialRole:'none',displayName:'示例客房',aliases:[]});
 graph.floorMemories[0].spatialFacts={schemaVersion:1,features:[],positions:[],containments:[],relations:ids.map((itemId,i)=>({itemId,placeEntityId:room,kind:'relative',referencePlaceEntityIds:[],text:`旧方位${i}`,evidenceRefs:[{floorId:FLOOR1,quotedText:`旧方位${i}`,occurrence:1,evidenceMode:'explicit'}]}))};
 const workspace={schemaVersion:1,kind:'qqj-v3-place-workspace',chatId:CHAT,placesByEntityId:{},deletionsByEntityId:{},foundation:{schemaVersion:1,entities:[],facts:[{itemId:ITEM,kind:'relation',placeEntityId:room,text:'走廊末端。',knownFromFloorId:FLOOR2,replacesItemIds:ids,source:{kind:'body',floorId:FLOOR2,quote:'客房在走廊末端。'}}]}};
 const queryContext={text:'示例客房方位',latestUserText:'示例客房方位'},current=await projectRecallSource(graph,()=>new Date(NOW),null,null,{},false,{placeWorkspace:workspace});
 assert.equal(current.floorMemories[0].spatialFacts.relations.length,0);const pool=buildRecallHistoryCandidatePool({source:current,queryContext});assert.equal(pool.candidates.filter(c=>c.value.kind==='spatialRelation').length,0);assert.equal(pool.candidates.filter(c=>c.value.kind==='placeFoundation').length,1);
 const {placeWorkspaceForPrefix}=await import('../src/v3/place-workspace.js'),historical=await projectRecallSource(graph,()=>new Date(NOW),null,null,{},false,{placeWorkspace:placeWorkspaceForPrefix(workspace,new Set([FLOOR1]))});
 assert.equal(historical.floorMemories[0].spatialFacts.relations.length,5);assert.equal(buildRecallHistoryCandidatePool({source:historical,queryContext}).candidates.filter(c=>c.value.kind==='spatialRelation').length,5);assert.equal(graph.floorMemories[0].spatialFacts.relations.length,5);
});

test('辅助来源独立8秒预算到期仅隔离未完成类别，迟到结果不再继续读', async t => {
  for (const pending of ['people', 'places']) await t.test(pending, async sub => {
    sub.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let release, captured, reads = 0, aborts = 0;
    const source = runtimeFixture();
    const workspace = { placesByEntityId: {}, foundation: { entities: [], facts: [] } };
    const h = createRuntimeHarness({
      sourceReader: async () => { reads++; return structuredClone(source); },
      identityProjectionProvider: (_identity, options) => {
        options.onPartial?.({ unavailableSources: [pending], ...(pending === 'people' ? { placeWorkspace: workspace } : {}) });
        queueMicrotask(() => sub.mock.timers.tick(8000));
        return new Promise(resolve => { release = resolve; });
      }, selector: input => { captured = input.source; return selectRecall(input); } });
    const result = await h.runtime.intercept(h.chat, 12000, () => { aborts++; }, 'normal');
    assert.equal(result.lastRecall.status, 'ready'); assert.equal(aborts, 0);
    assert.deepEqual(captured.unavailableSources, [pending]);
    if (pending === 'people') { assert.equal(captured.currentState.length, 0); assert.deepEqual(captured.placeWorkspace, workspace); }
    else { assert.ok(captured.entities.some(entity => entity.entityType === 'person')); assert.equal(captured.placeWorkspace, null); }
    const after = reads; release({}); await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, after);
  });
});

test('辅助来源读取失败保留普通旧事并放行正文', async () => {
  let aborts = 0;
  const h = createRuntimeHarness({ identityProjectionProvider: async () => { throw new Error('辅助库读取失败'); },
    placeWorkspaceDependencyProvider: async () => { throw new Error('地点库读取失败'); } });
  const result = await h.runtime.intercept(h.chat, 12000, () => { aborts++; }, 'normal');
  assert.equal(result.lastRecall.status, 'ready');
  assert.ok(result.lastRecall.injectionText.includes('qqj_recalled_context'));
  assert.equal(aborts, 0);
});

test('无关地点revision变化仍复用同一旧事回执', async () => {
  let revision = 0, selections = 0;
  const harness = createRuntimeHarness({ placeWorkspaceDependencyProvider: async () => `${CHAT}:${revision}`, identityProjectionProvider: async () => ({ placeWorkspaceRevision: revision }), selector: input => { selections++; return selectRecall(input); } });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  await flushReceiptSave(); assert.equal(selections, 1);
  revision = 1; harness.runtime.invalidate('placeEdited');
  await harness.runtime.intercept(harness.chat, 12000, null, 'regenerate');
  assert.equal(selections, 1); assert.equal(harness.runtime.getState().lastRecall.reusedReceipt, true);
});

test('无选中地点的世界书许可变化继续复用旧事票',async()=>{
 const {placeWorkspaceDependency,filterPlaceFoundationSources}=await import('../src/v3/place-foundation.js');let excluded=false,selections=0;
 const workspace={foundation:{schemaVersion:1,entities:[],facts:[{itemId:'base-1',kind:'feature',placeEntityId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',text:'固定设施',knownFromFloorId:null,source:{kind:'worldbook',sourceName:'地图',locator:'地图:18',fingerprint:'sha256:fixture',quote:'固定设施'}}]}};
 const current=()=>filterPlaceFoundationSources(workspace,{filterWorldInfoSources:sources=>excluded?[]:sources});
 const h=createRuntimeHarness({placeWorkspaceDependencyProvider:()=>placeWorkspaceDependency(CHAT,1,current()),identityProjectionProvider:async()=>({placeWorkspaceRevision:1,placeWorkspace:current()}),selector:input=>{selections++;return selectRecall(input);}});
 await h.runtime.intercept(h.chat,12000,null,'normal');await flushReceiptSave();assert.equal(selections,1);
 excluded=true;await h.runtime.intercept(h.chat,12000,null,'regenerate');assert.equal(selections,1);assert.equal(h.runtime.getState().lastRecall.reusedReceipt,true);
});

test('召回新注入直陈当时承诺与可见性，态度对象不冒作接收者，地点不补不知情', () => {
  const userId = '88888888-7777-4777-8777-777777777777', otherId = '99999999-7777-4777-8777-777777777777';
  const memories = Array.from({length:8},(_,index)=>recallMemory(index+1));
  memories[0] = recallMemory(1, { commitments: [
    ...['made','accepted','refused','uncertain'].map(status=>({speakerEntityId:PERSON,targetEntityIds:[userId],kind:'promise',content:`归还钥匙-${status}`,status})),
    {speakerEntityId:PERSON,targetEntityIds:[],kind:'plan',content:'私下计划返乡',status:'made'},
    {speakerEntityId:PERSON,targetEntityIds:[userId],kind:'plan',content:'共同安排返乡',status:'accepted'},
  ], informationTransfers:[{fromEntityId:PERSON,toEntityIds:[otherId],claimText:'明日开门',channel:'spoken'}] });
  const source=selectorSource({memories}), query={text:'钥匙返乡明日开门',latestUserText:'钥匙返乡明日开门'};
  const context=historySelectionContext(source,query), facts=context.facts.filter(item=>item.floorId==='floor-1');
  const entityById=new Map(source.entities.map(entity=>[entity.entityId,entity]));
  const states=[{subjectEntityId:PERSON,subject:'裴晚生',towardEntityId:userId,toward:'林岚',layer:'situational',text:'显得疲惫',visibility:'observable',reason:'当时观察'}];
  const injection=formatRecallInjection({coverage:source.coverage,floors:[{assistantSeq:1,items:facts}],states,cseChanges:[],entityById,
    manualPlaces:[{kind:'placeFoundation',placeEntityId:'room',text:'客厅有沙发',source:{kind:'worldbook',locator:'院落:2'}}]});
  for(const label of ['历史承诺·当时已作出','历史承诺·当时已接受','历史承诺·当时已拒绝','历史承诺·当时成立未定','当时计划','当时共同接受的计划'])assert.ok(injection.includes(label),label);
  assert.match(injection,/可见性：可观察/u);assert.match(injection,/态度对象：林岚/u);
  assert.match(injection,/接收者：乙/u);
  assert.doesNotMatch(injection.split('\n').find(line=>line.includes('显得疲惫')),/接收者：林岚/u);
  assert.match(injection,/表达者：裴晚生。接收者：林岚。内容：历史承诺/u);
  assert.match(injection,/知情：裴晚生/u);assert.match(injection,/地点资料/u);assert.match(injection,/世界书设定：院落:2/u);
  assert.doesNotMatch(injection,/不代表|不得|不构成|未赋予|以后文为准|尚未履行/u);
  assert.doesNotMatch(injection,/林岚不知情|所有人物未知|待履行|状态：未完成/u);
});

test('人工原文与人工知情名单直列，正文中的不代表及原括号保持字面', () => {
  const raw='“不代表”是原信内容（保留这个括号）。';
  const entityById=new Map([[PERSON,{entityType:'person',displayName:'裴晚生'}],['other',{entityType:'person',displayName:'林岚'}]]);
  const injection=formatRecallInjection({coverage:{memoryComplete:true,cseCurrent:true},floors:[{assistantSeq:1,items:[{category:'objective',kind:'manualArtifact',carrier:'信件',exactText:raw,knownEntityIds:[PERSON]}]}],states:[],entityById});
  assert.ok(injection.includes(raw));assert.match(injection,/知情：裴晚生；不知情：其余人物/u);
  assert.doesNotMatch(injection,/说话人和user也不默认|包括未选中的user|该载体以本条人工修订内容为准/u);
});

function bundledPlaceSource({ long = false } = {}) {
 const room = '22223333-2222-4222-8222-222222222222';
 const parent = '22223333-2222-4222-8222-333333333333';
 const source = selectorSource();
 source.entities.push(...[[room, '示例客房'], [parent, '东院']].map(([entityId, displayName]) => ({ entityId, displayName, aliases: [], entityType: 'place', specialRole: 'none' })));
 const wb = { kind: 'worldbook', locator: '院落:3', quote: '客房有床和卫浴。' };
 const body = { kind: 'body', floorId: 'floor-8', quote: '客房位于东院走廊末端。' };
 source.placeWorkspace = { placesByEntityId: {}, foundation: { entities: [], facts: [
  { itemId: 'room-feature-a', kind: 'feature', placeEntityId: room, text: long ? '有床和卫浴。'.repeat(300) : '有床和卫浴。', source: wb },
  { itemId: 'room-feature-b', kind: 'feature', placeEntityId: room, text: long ? '有床和卫浴。'.repeat(300) : '有床和卫浴。', source: { ...wb, locator: '院落:4' } },
  { itemId: 'room-parent', kind: 'containment', placeEntityId: room, parentEntityId: parent, source: body },
  { itemId: 'room-relative', kind: 'relation', placeEntityId: room, text: '走廊末端。', relationKind: 'relative', referencePlaceEntityIds: [parent], source: body },
 ] } };
 return { source, room, parent, queryContext: { text: '示例客房', latestUserText: '示例客房', messageCount: 1 } };
}

test('自动清父是结构修订，不生成当前或历史未知父地点候选和注入', () => {
  const {source,room,queryContext}=bundledPlaceSource();
  source.placeWorkspace.foundation.facts=source.placeWorkspace.foundation.facts.map(fact=>fact.kind==='containment'?{...fact,parentEntityId:null,identityChange:'ownershipChanged',replacesItemIds:[]}:fact);
  source.floorMemories[0].spatialFacts={containments:[{itemId:'clear-1',placeEntityId:room,parentEntityId:null,identityChange:'ownershipChanged',replacesItemIds:[],sourceRefs:[{floorId:'floor-1',assistantSeq:1}]}],positions:[]};
  const context=historySelectionContext(source,queryContext);
  assert.equal(context.facts.some(item=>item.kind==='spatialContainment'),false);
  const pool=buildRecallHistoryCandidatePool({source,queryContext});
  const result=selectRecall({source,queryContext,selectedHistoryCandidates:pool.candidates,contextSize:12000});
  assert.doesNotMatch(result.injectionText,/未知人物|地点未知|所属地点/u);
  assert.match(result.injectionText,/有床和卫浴/u);
});

test('地点整包按稳定ID占一候选一名额，逐段来源与全部itemIds保留', () => {
 const { source, room, queryContext } = bundledPlaceSource();
 const context = historySelectionContext(source, queryContext);
 const rows = context.facts.filter(item => item.placeEntityId === room && item.kind === 'placeFoundation');
 assert.equal(rows.length, 1);
 assert.deepEqual(new Set(rows[0].itemIds), new Set(['room-feature-a', 'room-feature-b', 'room-parent', 'room-relative']));
 assert.equal(rows[0]._placeMembers.length, 3);
 assert.deepEqual(new Set(rows[0].source.references.filter(ref => ref.kind === 'worldbook').map(ref => ref.locator)), new Set(['院落:3', '院落:4']));
 const pool = buildRecallHistoryCandidatePool({ source, queryContext });
 assert.equal(pool.candidates.filter(item => item.value.placeEntityId === room).length, 1);
 const selected = selectRecall({ source, queryContext, selectedHistoryCandidates: pool.candidates, maxItems: 1, contextSize: 12000 });
 assert.equal(selected.stages.finalInjectionItemCount, 1);
 assert.equal(selected.manualPlaces.length, 3, '回执仍保存原成员而不新增结构');
 assert.equal(selected.injectionText.split('示例客房').length - 1, 1);
 for (const text of ['有床和卫浴。', '所属地点：东院', '走廊末端。', '院落:3', '已存正文地点资料']) assert.ok(selected.injectionText.includes(text), text);
 assert.equal(selected.manualPlaces[0].source.references.some(ref => ref.locator === '院落:4'), true, '历史引用完整保在成员，不新增来源包装');
 assert.ok(selected.limits.estimatedTokenCount <= selected.limits.estimatedTokenBudget);
});

test('地点整包同名异ID分开，部分人工覆盖与空值不回填自动旧字段', () => {
 const { source, room, queryContext } = bundledPlaceSource();
 source.placeWorkspace.placesByEntityId[room] = { description: '人工保留的书桌。', parentEntityId: null };
 const context = historySelectionContext(source, queryContext);
 const row = context.facts.find(item => item.placeEntityId === room && item._placeMembers);
 assert.ok(row);assert.equal(row.kind, 'placeFoundation', '混合资料不整体标成人工');
 assert.ok(row._placeMembers.some(item => item.kind === 'manualPlace' && item.text.includes('书桌')));
 assert.ok(row._placeMembers.some(item => item.kind === 'placeFoundation' && item.text.includes('走廊末端')));
 assert.ok(row._placeMembers.every(item => !item.text.includes('卫浴') && !item.text.includes('所属地点')));
 const selected = selectRecall({ source, queryContext, contextSize: 12000 });
 assert.match(selected.injectionText, /人工修订优先/u);assert.match(selected.injectionText, /走廊末端/u);assert.doesNotMatch(selected.injectionText, /卫浴|所属地点/u);
 source.placeWorkspace.placesByEntityId[room].description = '';
 assert.doesNotMatch(selectRecall({ source, queryContext }).injectionText, /卫浴|书桌/u);
 const other = '22223333-2222-4222-8222-444444444444';
 source.entities.push({ entityId: other, displayName: '示例客房', aliases: [], entityType: 'place', specialRole: 'none' });
 source.placeWorkspace.foundation.facts.push({ ...source.placeWorkspace.foundation.facts[3], placeEntityId: other, itemId: 'other-room' });
 source.bodyMatch = { locationReferences: [] };
 source.floorMemories[7].spatialFacts = { positions: [room, other].map(placeEntityId => ({ subjectEntityId: PERSON, placeEntityId, status: 'confirmed', sourceRefs: [{ floorId: 'floor-8', assistantSeq: 8 }] })), containments: [], features: [], relations: [] };
 const rows = historySelectionContext(source, queryContext).facts.filter(item => ['placeFoundation', 'manualPlace'].includes(item.kind));
 assert.deepEqual(new Set(rows.map(item => item.placeEntityId)), new Set([room, other]));
});

test('地点整包超候选或注入预算时整项跳过，不截简介或只留归属', () => {
 const { source, queryContext } = bundledPlaceSource({ long: true });
 const shortPool = buildRecallHistoryCandidatePool({ source, queryContext, maxCharacters: 500 });
 assert.equal(shortPool.candidates.length, 0);
 const selected = selectRecall({ source, queryContext, contextSize: 1000 });
 assert.equal(selected.manualPlaces.length, 0);
 assert.doesNotMatch(selected.injectionText, /示例客房|所属地点/u);
 assert.ok(selected.limits.actualCharacters <= selected.limits.maxCharacters);
});

test('地点整包同次LLM按一个R键保留或排除全部成员', async () => {
 const { source, queryContext } = bundledPlaceSource();let calls = 0;
 const run = excluded => selectRecallWithLlm({ source, queryContext, contextSize: 12000, generateUtilityTask: async options => {
  calls++;const payload = JSON.parse(options.taskMessages[0].content);
  assert.equal(payload.candidates.length, 1);
  assert.match(payload.candidates[0].fact, /有床和卫浴.*所属地点.*走廊末端/u);
  return { jsonData: { history_exclude_keys: excluded ? [payload.candidates[0].key] : [], state_exclude_keys: [] } };
 } });
 const kept = await run(false), omitted = await run(true);
 assert.equal(kept.stages.finalInjectionItemCount, 1);assert.equal(kept.manualPlaces.length, 3);
 assert.equal(omitted.manualPlaces.length, 0);assert.doesNotMatch(omitted.injectionText, /卫浴|所属地点|走廊末端/u);
 assert.equal(calls, 2);
});

test('地点整包时间失效重渲染按地点计数，紧预算整组撤回且冷读复用不重选', async () => {
 for (const tight of [false, true]) {
  const { source, queryContext } = bundledPlaceSource();
  source.identityProjection = { placeWorkspaceRevision: 1 };
  source.placeWorkspaceDependency = `${CHAT}:1`;
  let reads = 0, selections = 0;
  const h = createRuntimeHarness({ sourceReader: async () => structuredClone(source), reachableReader: async () => rawReachableFromSource(source),
   placeWorkspaceDependencyProvider: () => `${CHAT}:1`, identityProjectionProvider: () => ({ placeWorkspaceRevision: 1 }),
   queryBuilder: () => queryContext,
   timeProjectionProvider: () => ({ fingerprint: `clock-${++reads}`, corrections: {}, reminders: reads === 1
    ? [{ itemId: 'room-time', type: 'deadline', subjectEntityId: PERSON, distance: 0, text: '示例客房今天归还钥匙', sourceSignature: 'clock-source' }] : [] }),
   selector: input => { selections++;const selected = selectRecall(input);return tight ? { ...selected, limits: { ...selected.limits, maxCharacters: 0, estimatedTokenBudget: 0 } } : selected; },
  });
  await h.runtime.intercept(h.chat, 12000, null, 'normal');
  const saved = h.userMessage.extra[RECALL_RECEIPT_KEY];
  assert.ok(saved.skipReasons.includes('optionalTimeChanged'));
  assert.equal(saved.selectedPlaces.length, tight ? 0 : 3);
  assert.equal(saved.stages.finalInjectionItemCount, tight ? 0 : 1);
  assert.equal(saved.stages.distantHistoryItemCount, tight ? 0 : 1);
  assert.equal(saved.receiptFingerprint, await receiptFingerprint(saved));
  assert.equal(saved.injectionText.length <= saved.timeDependencies.renderPlan.limits.maxCharacters, true);
  if (tight) assert.doesNotMatch(saved.injectionText, /卫浴|所属地点|走廊末端/u);
  else { assert.match(saved.injectionText, /卫浴.*所属地点.*走廊末端/u);assert.equal(saved.injectionText.split('示例客房').length - 1, 1); }
  h.runtime.invalidate('cold-read');
  await h.runtime.restorePersistedReceipt();assert.equal(selections, 1);
  await h.runtime.intercept(h.chat, 12000, null, 'regenerate');assert.equal(selections, 1);
 }
});

test('地点整包v28旧回执只读保签名，正常生成到当前策略只重选一次', async () => {
 let selections = 0;
 const h = createRuntimeHarness({ selector: input => { selections++;return selectRecall(input); } });
 await h.runtime.intercept(h.chat, 12000, null, 'normal');
 const old = structuredClone(h.userMessage.extra[RECALL_RECEIPT_KEY]);old.strategyVersion = 'continuity-v28';old.receiptFingerprint = await receiptFingerprint(old);
 h.userMessage.extra[RECALL_RECEIPT_KEY] = old;h.runtime.invalidate('cold-read');
 const restored = await h.runtime.restorePersistedReceipt();assert.equal(restored.lastRecall.legacyReadOnly, true);assert.equal(restored.lastRecall.strategyVersion, 'continuity-v28');
 assert.deepEqual(h.userMessage.extra[RECALL_RECEIPT_KEY], old);assert.equal(selections, 1);
 await h.runtime.intercept(h.chat, 12000, null, 'regenerate');assert.equal(selections, 2);assert.equal(h.userMessage.extra[RECALL_RECEIPT_KEY].strategyVersion, 'continuity-v32');
 await h.runtime.intercept(h.chat, 12000, null, 'regenerate');assert.equal(selections, 2);
});


test('召回传输与选材格式共用连接重试次数，零次不再上层补发且高次不封死', async () => {
  for (const retryCount of [0, 1, 4]) for (const kind of ['network', 'format']) {
    let calls = 0;
    const route = { kind: 'independent', source: 'fixture', config: { url: 'https://fixture.invalid', key: 'fixture', model: 'fixture', qqjRetryCount: retryCount } };
    const client = createCompactApiClient({ retryWait: async () => {}, fetchImpl: async () => { calls++; if (kind === 'network') throw new TypeError('offline'); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '无合法选材' } }] }) }; } });
    const router = createTaskRouter({ resolver: { resolve: () => route, resolveUtility: () => route }, compactClient: client });
    const h = createRuntimeHarness({ useDefaultSelector: true, generateUtilityTask: router.generateUtilityTask });
    const result = await h.runtime.intercept(h.chat, 12000, () => {}, 'normal');
    assert.equal(calls, retryCount + 1, `${retryCount}/${kind}`); assert.equal(result.lastRecall.status, 'error'); assert.equal(result.lastRecall.injectionText, '');
  }
  for (const status of [400, 401, 403, 404, 422]) {
    let calls = 0;
    const route = { kind: 'independent', config: { url: 'https://fixture.invalid', key: 'fixture', qqjRetryCount: 4 } };
    const client = createCompactApiClient({ retryWait: async () => {}, fetchImpl: async () => { calls++; return { ok: false, status, text: async () => '' }; } });
    const router = createTaskRouter({ resolver: { resolve: () => route, resolveUtility: () => route }, compactClient: client });
    const h = createRuntimeHarness({ useDefaultSelector: true, generateUtilityTask: router.generateUtilityTask });
    await h.runtime.intercept(h.chat, 12000, () => {}, 'normal'); assert.equal(calls, 1, String(status));
  }
});


test('模型成功后prompt或root暂错只重本地提交，连接零次与两次均只发一个模型请求', async () => {
  for (const retryCount of [0, 2]) for (const kind of ['prompt', 'root']) {
    let fetches = 0, roots = 0, promptFailed = false;
    const source = runtimeFixture();
    const route = { kind: 'independent', config: { url: 'https://fixture.invalid', key: 'fixture', model: 'fixture', qqjRetryCount: retryCount } };
    const client = createCompactApiClient({ fetchImpl: async () => { fetches++; return { ok: true, status: 200, json: async () => ({choices:[{message:{content:'{"history_exclude_keys":[],"state_exclude_keys":[]}'}}]}) }; } });
    const router = createTaskRouter({ resolver: { resolve:()=>route, resolveUtility:()=>route }, compactClient:client });
    const h=createRuntimeHarness({useDefaultSelector:true,generateUtilityTask:router.generateUtilityTask,
      rootReader:async()=>kind==='root'&&++roots===1?{status:'unavailable'}:{status:'ready',revision:source.rootRevision,data:{chatId:source.chatId,narrativeGeneration:source.narrativeGeneration,headCheckpointId:source.headCheckpointId}}});
    if(kind==='prompt')h.context.setExtensionPrompt=(...args)=>{h.prompts.push(args);if(args[0]===RECALL_PROMPT_SLOT&&args[1]&&!promptFailed){promptFailed=true;throw Error('local prompt error');}};
    let aborted=0;const result=await h.runtime.intercept(h.chat,12000,()=>aborted++,'normal');
    assert.equal(result.lastRecall.status,'ready',`${retryCount}/${kind}`);assert.equal(fetches,1);assert.equal(aborted,0);assert.ok(latestPromptValue(h.prompts,RECALL_PROMPT_SLOT));
    if(kind==='root')assert.equal(roots,2);else assert.equal(promptFailed,true);
  }
});

test('底层AbortError即使未改operation信号也立即停止，零次与四次均不由召回外层重发',async()=>{
 for(const retryCount of [0,4]){
  let calls=0;const route={kind:'independent',config:{url:'https://fixture.invalid',key:'fixture',qqjRetryCount:retryCount}};
  const client=createCompactApiClient({retryWait:async()=>{},fetchImpl:async()=>{calls++;throw new DOMException('Stopped','AbortError');}});
  const router=createTaskRouter({resolver:{resolve:()=>route,resolveUtility:()=>route},compactClient:client});
  const h=createRuntimeHarness({useDefaultSelector:true,generateUtilityTask:router.generateUtilityTask});
  const result=await h.runtime.intercept(h.chat,12000,()=>{},'normal');assert.equal(calls,1);assert.equal(result.lastRecall.status,'stale');assert.equal(result.lastRecall.injectionText,'');
 }
});

test('普通召回不独立追加正文与已选旧楼地点标注，不占名额或字符且保摘要地点及档案',()=>{
 const {source,queryContext}=bundledPlaceSource();
 source.floorMemories[0].summary='示例客房内归还旧书，随后沿院路回去。';
 const refs=Array.from({length:3},(_,i)=>({text:`院落 / 旧客厅 / 第${i+1}段旧动线`,sourceFloorId:source.floorMemories[0].floorId,assistantSeq:1}));
 source.floorMemories[0].locationReferences=refs;source.bodyMatch={locationReferences:refs};
 const original=JSON.stringify(source),withRefs=selectRecall({source,queryContext,maxItems:16});
 const clean=structuredClone(source);clean.bodyMatch.locationReferences=[];for(const memory of clean.floorMemories)memory.locationReferences=[];
 const withoutRefs=selectRecall({source:clean,queryContext,maxItems:16});
 assert.deepEqual(withRefs.locationReferences,[]);assert.equal(withRefs.stages.locationReferenceCount,0);
 assert.equal(withRefs.injectionText,withoutRefs.injectionText);assert.equal(withRefs.stages.finalInjectionItemCount,withoutRefs.stages.finalInjectionItemCount);
 assert.equal(withRefs.limits.actualCharacters,withoutRefs.limits.actualCharacters);assert.doesNotMatch(withRefs.injectionText,/\[原消息地点标注/u);
 assert.match(withRefs.injectionText,/示例客房内归还旧书/u);assert.match(withRefs.injectionText,/床和卫浴/u);assert.match(withRefs.injectionText,/所属地点/u);
 assert.equal(JSON.stringify(source),original);
});

test('v29旧活动票据不复用，历史签名仍保地点整包与当时标注，新策略封签后正常复用',async()=>{
 const {source,queryContext}=bundledPlaceSource();let selections=0;
 const h=createRuntimeHarness({sourceReader:async()=>structuredClone(source),reachableReader:async()=>rawReachableFromSource(source),queryBuilder:()=>queryContext,
 selector:input=>{selections++;return selectRecall(input);}});
 await h.runtime.intercept(h.chat,12000,null,'normal');
 const old=structuredClone(h.userMessage.extra[RECALL_RECEIPT_KEY]);old.strategyVersion='continuity-v29';
 const members=selectRecall({source,queryContext}).manualPlaces;assert.equal(members.length,3);old.selectedPlaces=structuredClone(members);
 old.injectionText=old.injectionText.replace('</qqj_recalled_context>',placeRecallBlocks(members).join('\n')+'\n</qqj_recalled_context>');
 const ref={text:'东院 / 客房旧位置',sourceFloorId:'floor-8',assistantSeq:8,hostLocator:null};old.selectedLocationReferences=[ref];
 old.injectionText=old.injectionText.replace('</qqj_recalled_context>','[原消息地点标注]\n- 旧楼 AI #8：'+ref.text+'\n</qqj_recalled_context>');
 old.stages.locationReferenceCount=1;old.stages.finalInjectionItemCount+=1;old.receiptFingerprint=await receiptFingerprint(old);
 h.userMessage.extra[RECALL_RECEIPT_KEY]=old;h.runtime.invalidate('cold-read');const before=JSON.stringify(old);
 const restored=await h.runtime.restorePersistedReceipt();assert.equal(restored.lastRecall.legacyReadOnly,true);assert.equal(restored.lastRecall.strategyVersion,'continuity-v29');
 const historical=await projectHistoricalRecallReceipt(h.userMessage,{chatId:source.chatId,userMessageIndex:1});assert.ok(historical);assert.equal(historical.injectionText,old.injectionText);assert.equal(historical.selectedPlaces.length,3);assert.deepEqual(historical.selectedLocationReferences,[ref]);
 const shown=projectInlineRecallReceipt(historical);assert.equal(shown.protocolRecognized,true);assert.equal(shown.objectItems.filter(item=>item.id.startsWith('place:')).length,1);assert.equal(shown.objectItems.filter(item=>item.id.startsWith('location:')).length,1);
 assert.equal(JSON.stringify(h.userMessage.extra[RECALL_RECEIPT_KEY]),before);assert.equal(selections,1);
 await h.runtime.intercept(h.chat,12000,null,'regenerate');const fresh=h.userMessage.extra[RECALL_RECEIPT_KEY];
 assert.equal(selections,2);assert.equal(fresh.strategyVersion,'continuity-v32');assert.deepEqual(fresh.selectedLocationReferences,[]);assert.equal(fresh.stages.locationReferenceCount,0);assert.equal(fresh.receiptFingerprint,await receiptFingerprint(fresh));
 await h.runtime.intercept(h.chat,12000,null,'regenerate');assert.equal(selections,2);assert.equal(h.runtime.getState().lastRecall.reusedReceipt,true);
});

test('v30签名旧回执保持原注入与地点分组，下一正常生成切新策略后复用',async()=>{
 const {source,queryContext}=bundledPlaceSource();let calls=0;
 source.identityProjection={placeWorkspaceRevision:1,placeWorkspace:source.placeWorkspace};source.placeWorkspaceDependency=`${CHAT}:1`;
 const h=createRuntimeHarness({sourceReader:async()=>structuredClone(source),reachableReader:async()=>rawReachableFromSource(source),queryBuilder:()=>queryContext,placeWorkspaceDependencyProvider:()=>source.placeWorkspaceDependency,
  selector:input=>{calls++;return selectRecall(input);}});
 await h.runtime.intercept(h.chat,12000,null,'normal');
 const old=structuredClone(h.userMessage.extra[RECALL_RECEIPT_KEY]);assert.equal(old.selectedPlaces.length,3);old.strategyVersion='continuity-v30';
 old.injectionText=old.injectionText.replaceAll('[已保存场景快照]','[当前]');old.receiptFingerprint=await receiptFingerprint(old);
 h.userMessage.extra[RECALL_RECEIPT_KEY]=old;const before=JSON.stringify(old);h.runtime.invalidate('cold-v30');
 const historical=await projectHistoricalRecallReceipt(h.userMessage,{chatId:source.chatId,userMessageIndex:1});
 assert.ok(historical);assert.equal(historical.injectionText,old.injectionText);assert.deepEqual(historical.selectedPlaces,old.selectedPlaces);
 assert.equal(projectInlineRecallReceipt(historical).protocolRecognized,true);assert.equal(JSON.stringify(h.userMessage.extra[RECALL_RECEIPT_KEY]),before);
 await h.runtime.intercept(h.chat,12000,null,'regenerate');assert.equal(calls,2);assert.equal(h.userMessage.extra[RECALL_RECEIPT_KEY].strategyVersion,'continuity-v32');
 await h.runtime.intercept(h.chat,12000,null,'regenerate');assert.equal(calls,2);assert.equal(h.runtime.getState().lastRecall.reusedReceipt,true);
});


test('当前稳定设施同文在正式DTO和LLM中只一份，合并覆盖与同名异ID及历史场景边界保留',async()=>{
const id = n => `${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
const CHAT = id(100), GEN = id(101), ROOM = id(102), OLD = id(103), USER = id(104);
const TEXT = '房内有独立卫生间。';
const ref = n => ({ floorId: id(n), quotedText: TEXT, occurrence: 1 });
const feature = (n, placeEntityId = ROOM, kind = 'stable') => ({ itemId: id(200 + n), placeEntityId, kind, text: TEXT, replacesItemIds: [], evidenceRefs: [ref(n)] });
const foundation = (n, replacesItemIds = [], placeEntityId = ROOM) => ({ itemId: id(300 + n), kind: 'feature', placeEntityId, text: TEXT, knownFromFloorId: id(8), replacesItemIds,
  source: { kind: 'body', floorId: id(8), locator: `floor:${id(8)}`, quote: TEXT } });
const empty = () => ({ participants: [], locations: [], commitments: [], openLoops: [], exactAnchors: [], eventFragments: [], actions: [], observations: [], privateCognition: [], informationTransfers: [] });
const graph = () => ({ status: 'ready', rootRevision: 1, root: { chatId: CHAT, narrativeGeneration: GEN, headCheckpointId: id(400) }, checkpoint: { id: id(400) }, baseline: null,
  floors: Array.from({ length: 8 }, (_, i) => ({ id: id(i + 1), assistantSeq: i + 1 })),
  floorMemories: Array.from({ length: 8 }, (_, i) => ({ id: id(500 + i), floorId: id(i + 1), recordStatus: 'active', summary: { effectiveSource: 'ai', aiText: '' }, ...empty(),
    spatialFacts: { schemaVersion: 1, containments: [], positions: i === 7 ? [{ subjectEntityId: USER, placeEntityId: ROOM, status: 'confirmed', evidenceRefs: [{ ...ref(8), quotedText: '用户位于示例东屋' }] }] : [], features: [], relations: [] } })),
  entities: [{ id: USER, entityType: 'person', displayName: '用户', specialRole: 'user', aliases: [], status: 'established', recordStatus: 'active' },
    { id: ROOM, entityType: 'place', displayName: '示例东屋', specialRole: 'none', aliases: [], status: 'established', recordStatus: 'active' }], stateDeltas: [], currentStates: [] });
const workspace = facts => ({ schemaVersion: 1, kind: 'qqj-v3-place-workspace', chatId: CHAT, placesByEntityId: {}, deletionsByEntityId: {}, foundation: { schemaVersion: 1, entities: [], facts } });
const queryContext = { text: '示例东屋的独立卫生间', latestUserText: '示例东屋的独立卫生间', messageCount: 1 };
 for(const scenario of ['stable','foundation','redirect','different','temporary','same-name','manual-later','manual-different']){
  const raw=graph();raw.floorMemories[0].spatialFacts.features=[feature(1)];let ws=null;
  if(scenario==='stable')raw.floorMemories[1].spatialFacts.features=[feature(2)];
  if(scenario==='foundation')ws=workspace([foundation(1)]);
  if(scenario==='redirect'){raw.entities.push({...raw.entities[1],id:OLD,status:'merged',mergedIntoEntityId:ROOM});raw.floorMemories[0].spatialFacts.features=[feature(1,OLD)];ws=workspace([foundation(1,[feature(1).itemId])]);}
  if(scenario==='different')raw.floorMemories[1].spatialFacts.features=[{...feature(2),text:TEXT+'另有落地窗。'}];
  if(scenario==='temporary')raw.floorMemories[1].spatialFacts.features=[feature(2,ROOM,'temporary')];
  if(scenario.startsWith('manual-')){raw.floorMemories[1].spatialFacts.features=[{...feature(2),text:scenario==='manual-different'?TEXT+'另有新窗。':TEXT}];ws=workspace([]);ws.placesByEntityId[ROOM]={description:TEXT,scopes:{description:{knownThroughFloorId:id(1),coveredFloorIds:[id(1)],coveredItemIds:[feature(1).itemId]}}};}
  if(scenario==='same-name'){raw.entities.push({...raw.entities[1],id:OLD});raw.floorMemories[1].spatialFacts.features=[feature(2,OLD)];raw.floorMemories[7].spatialFacts.positions.push({...raw.floorMemories[7].spatialFacts.positions[0],subjectEntityId:id(105),placeEntityId:OLD});raw.entities.push({id:id(105),entityType:'person',displayName:'乙',specialRole:'none',status:'established',recordStatus:'active',aliases:[]});}
  const before=JSON.stringify(raw),source=await projectRecallSource(raw,()=>new Date(NOW),null,null,{},false,ws?{placeWorkspace:ws,placeWorkspaceRevision:1}:{});
  const pool=buildRecallHistoryCandidatePool({source,queryContext});const rows=pool.candidates.filter(row=>row.text.includes(TEXT));let payload;
  const selected=await selectRecallWithLlm({source,queryContext,contextSize:12000,generateUtilityTask:async options=>{payload=JSON.parse(options.taskMessages[0].content);return{jsonData:{history_exclude_keys:[],state_exclude_keys:[]}};}});
  const expected=['different','temporary','same-name','manual-different'].includes(scenario)?2:1;assert.equal(rows.length,expected,scenario);assert.equal(payload.candidates.filter(row=>row.fact.includes(TEXT)).length,expected,scenario);assert.equal(selected.injectionText.split(TEXT).length-1,expected,scenario);
  if(scenario==='stable')assert.deepEqual(new Set(rows[0].value.itemIds),new Set([feature(1).itemId,feature(2).itemId]));
  if(scenario==='foundation'){const row=rows[0].value._placeMembers[0];assert.deepEqual(new Set(row.itemIds),new Set([feature(1).itemId,foundation(1).itemId]));assert.ok(row.source.references.some(ref=>ref.floorId===id(1)));assert.ok(row.source.references.some(ref=>ref.floorId===id(8)));}
  if(scenario==='redirect')assert.equal(source.floorMemories[0].spatialFacts.features.length,0);
  assert.equal(JSON.stringify(raw),before);
 }
});

function exactPlaceClauseSource(){
 const value=bundledPlaceSource(),{source,room,parent}=value;
 const ref={kind:'worldbook',sourceName:'院落',locator:'院落:3',fingerprint:'sha256:place-fixture',quote:'客房位于本馆走廊末端，配有书架。'};
 source.placeWorkspace.foundation.facts=[
  {itemId:'parent-exact',kind:'containment',placeEntityId:room,parentEntityId:parent,source:structuredClone(ref)},
  {itemId:'long-exact',kind:'feature',placeEntityId:room,text:'位于本馆走廊末端，配有书架。',source:structuredClone(ref)},
  {itemId:'short-exact',kind:'relation',placeEntityId:room,text:'位于本馆走廊末端',referencePlaceEntityIds:[],source:structuredClone(ref)},
 ];return value;
}

test('已选地点B局部更新删除、无关C与展示编辑复用原票，选材在途不重跑', async t => {
  for (const scenario of ['unrelated', 'display', 'edit', 'delete', 'inFlight', 'legacy', 'manualScope', 'floorOnlyScope']) await t.test(scenario, async () => {
    const { source, room, queryContext } = exactPlaceClauseSource();
    if (['manualScope','floorOnlyScope'].includes(scenario)) { queryContext.messageCount = 20; source.floorMemories.at(-1).summary = '示例客房相关叙事'; }
    let workspace = structuredClone(source.placeWorkspace), selections = 0, selectedFloorId = null;
    if (scenario === 'floorOnlyScope') workspace.foundation.facts = [];
    const mutate = () => {
      workspace = structuredClone(workspace);
      if (scenario === 'unrelated') workspace.foundation.facts.push({ ...workspace.foundation.facts[1], itemId:'unrelated', placeEntityId: 'ccccdddd-cccc-4ccc-8ccc-ccccdddddddd', text:'无关地点C' });
      else if (scenario === 'display') workspace.mapStyle = 'campus-compact';
      else if (['manualScope','floorOnlyScope'].includes(scenario)) workspace.placesByEntityId[room] = { description:'本楼人工新地点描述', scopes:{ description:{ coveredFloorIds:[selectedFloorId], coveredItemIds:['old-feature'] } } };
      else if (scenario === 'delete') workspace.foundation.facts = [];
      else workspace.foundation.facts = [{ ...workspace.foundation.facts[1], text:'人工新地点资料' }];
    };
    const h = createRuntimeHarness({ queryBuilder: () => queryContext,
      sourceReader: async () => structuredClone({ ...source, placeWorkspace: workspace }),
      identityProjectionProvider: async () => ({ placeWorkspace: workspace, placeWorkspaceRevision: 2 }),
      selector: input => {
        selections++; const selected = structuredClone(selectRecall(input));
        if (['manualScope','floorOnlyScope'].includes(scenario)) {
          const floor = selected.floors[0]; selectedFloorId = floor.floorId;
          floor.items.push({kind:'placeFeature',category:'objective',placeEntityId:room,itemId:'old-feature',
            text:'当前地点设施：客房：旧设施独有',sourceRefs:[{floorId:floor.floorId}],storylineId:floor.items[0].storylineId});
          selected.injectionText = formatRecallInjection({...selected,coverage:input.source.coverage,entityById:new Map(input.source.entities.map(entity=>[entity.entityId,entity]))});
        }
        if (scenario === 'inFlight') mutate(); return selected;
      } });
    await h.runtime.intercept(h.chat, 12000, null, 'normal'); await flushReceiptSave();
    if (scenario === 'inFlight') {
      assert.match(h.runtime.getState().lastRecall.injectionText, /人工新地点资料/);
      assert.equal(selections, 1); return;
    }
    const saved = h.userMessage.extra[RECALL_RECEIPT_KEY];
    if (scenario === 'floorOnlyScope') assert.equal(saved.selectedPlaces?.length ?? 0,0);
    else assert.ok(saved.selectedPlaces.some(place => place.placeEntityId === room));
    if (scenario === 'legacy') { delete saved.timeDependencies.renderPlan; saved.receiptFingerprint = await receiptFingerprint(saved); h.runtime.invalidate(); }
    const before = saved.injectionText; mutate();
    await h.runtime.intercept(h.chat, 12000, null, 'regenerate');
    const result = h.runtime.getState().lastRecall; assert.equal(result.reusedReceipt, true); assert.equal(selections, 1);
    if (scenario === 'unrelated' || scenario === 'display') assert.equal(result.injectionText, before);
    else if (['manualScope','floorOnlyScope'].includes(scenario)) { assert.match(result.injectionText,/本楼人工新地点描述/); assert.equal(result.injectionText.includes('旧设施独有'),false); }
    else if (scenario === 'delete') assert.equal(result.injectionText.includes('配有书架'), false);
    else { assert.match(result.injectionText, /人工新地点资料/); assert.equal(result.injectionText.includes('配有书架'), false); }
  });
});

test('首次人物辅助源不可用仍保人工原文明确知情名单，只给人工块提供姓名', async () => {
  const source = runtimeFixture();
  source.floorMemories[0].exactAnchors = [{anchorId:'aaaa0000-0000-4000-8000-000000000010',kind:'other',manual:true,
    carrier:'钟楼账册',exactText:'钟楼账册必须保留原文。',knownEntityIds:[PERSON]}];
  let captured;
  const h = createRuntimeHarness({sourceReader:async()=>structuredClone(source),manualMemorySnapshot:()=>null,
    identityProjectionProvider:async()=>({unavailableSources:['people']}),
    queryBuilder:()=>({text:'裴晚生钟楼账册',latestUserText:'裴晚生钟楼账册',messageCount:20}),
    selector:input=>{captured=input.source;const pool=buildRecallHistoryCandidatePool(input);return selectRecall({...input,selectedHistoryCandidates:pool.candidates});}});
  const result = await h.runtime.intercept(h.chat,12000,null,'normal');
  assert.equal(result.lastRecall.status,'ready'); assert.equal(captured.entities.some(entity=>entity.entityType==='person'),false);
  assert.equal(captured.currentState.length,0); assert.match(result.lastRecall.injectionText,/知情：裴晚生；不知情：其余人物/);
  const invalid = structuredClone(h.userMessage.extra[RECALL_RECEIPT_KEY]);
  const artifact = invalid.timeDependencies.renderPlan.floors.flatMap(floor=>floor.items).find(item=>item.kind==='manualArtifact');
  assert.deepEqual(artifact.knownEntityNames,[[PERSON,'裴晚生']]);
  artifact.knownEntityNames[0][0]='foreign-person'; invalid.receiptFingerprint=await receiptFingerprint(invalid);
  h.userMessage.extra[RECALL_RECEIPT_KEY]=invalid;
  assert.equal(await projectHistoricalRecallReceipt(h.userMessage,{chatId:CHAT,userMessageIndex:1}),null);
});

test('辅助人物不可用重封plan保人工原文与冻结知情边界', async () => {
  const source = runtimeFixture(); let failed = false;
  source.floorMemories[0].exactAnchors = [{ anchorId:'aaaa0000-0000-4000-8000-000000000001', kind:'other', manual:true,
    carrier:'钟楼账册', exactText:'钟楼账册载体原文必须保留。', knownEntityIds:[PERSON] }];
  const h = createRuntimeHarness({sourceReader:async()=>structuredClone(source),manualMemorySnapshot:()=>null,
    identityProjectionProvider:async()=>failed ? {unavailableSources:['people']} : {},
    queryBuilder:()=>({text:'裴晚生钟楼账册',latestUserText:'裴晚生钟楼账册'}),
    selector: input => {
      const selection = structuredClone(selectRecall(input)), floor = selection.floors[0];
      floor.items.push({kind:'manualArtifact',category:'objective',carrier:'钟楼账册',exactText:'钟楼账册载体原文必须保留。',knownEntityIds:[PERSON],storylineId:floor.items[0].storylineId});
      selection.injectionText = formatRecallInjection({...selection,coverage:input.source.coverage,entityById:new Map(input.source.entities.map(entity=>[entity.entityId,entity]))});
      return selection;
    }});
  await h.runtime.intercept(h.chat,12000,null,'normal'); await flushReceiptSave();
  const before = h.userMessage.extra[RECALL_RECEIPT_KEY]; assert.ok(before.timeDependencies.renderPlan);
  assert.match(before.injectionText,/知情：裴晚生；不知情：其余人物/);
  failed = true; await h.runtime.intercept(h.chat,12000,null,'regenerate');
  const after = h.runtime.getState().lastRecall;
  assert.equal(after.reusedReceipt,true); assert.match(after.injectionText,/知情：裴晚生；不知情：其余人物/);
  assert.match(after.injectionText,/钟楼账册载体原文必须保留/);
  const { readManualArtifactBlocks } = await import('../src/v3/recall-text.js');
  assert.deepEqual([...readManualArtifactBlocks(after.injectionText).blocks.values()], [...readManualArtifactBlocks(before.injectionText).blocks.values()]);
});

test('旧无plan地点重封保护人工literal和历史raw行，人物源失败撤实际人物段', async () => {
  const { source, room, queryContext } = exactPlaceClauseSource();
  queryContext.text += ' 裴晚生客房'; queryContext.latestUserText += ' 裴晚生客房';
  source.currentState = [{ subjectEntityId: PERSON, displayName:'裴晚生', adaptive: [], core: [], situational: [{
    stateId:'legacy-state', text:'客房旧人物状态独有文本', visibility:'private', reason:'旧依据', origin:'floor',
    sourceFloorId:source.floorMemories[0].floorId, sourceAssistantSeq:1, towardEntityId:null }] }];
  let workspace = structuredClone(source.placeWorkspace), failed = false, selections = 0;
  const h = createRuntimeHarness({ queryBuilder: () => queryContext,
    sourceReader: async () => structuredClone({ ...source, placeWorkspace: workspace }),
    identityProjectionProvider: async () => ({ placeWorkspace: workspace, placeWorkspaceRevision: 1,
      ...(failed ? {unavailableSources:['people']} : {}) }),
    selector: input => {selections++; return selectRecall(input);} });
  await h.runtime.intercept(h.chat, 12000, null, 'normal'); await flushReceiptSave();
  const old = h.userMessage.extra[RECALL_RECEIPT_KEY]; assert.ok(old.selectedStates.length);
  delete old.timeDependencies.renderPlan;
  const literal = '[地点资料]\n- 这是人工载体原文，配有书架。\n[已保存人物状态依据]\n- 主体：原文字面，不应被当状态。';
  const raw = '- [旧事] [叙事回顾] [历史原文；时间未标注] [地点资料] 人物原话必须逐字保留。';
  old.injectionText = old.injectionText.replace('</qqj_recalled_context>', `- [旧事] （主体：裴晚生）：旧人物自动补充\n- [旧事] [私有资料；知情：裴晚生] 旧私有自动补充\n${raw}\n- [旧事] [人工原文｜${literal.length}字符]\n${literal}\n</qqj_recalled_context>`);
  old.receiptFingerprint = await receiptFingerprint(old); h.runtime.invalidate();
  workspace = structuredClone(workspace); workspace.foundation.facts = [{...workspace.foundation.facts[1],text:'新地点修订'}];
  workspace.placesByEntityId[room] = {description:'用户多行地点描述\n- [旧事] 用户手写的第二行'}; failed = true;
  await h.runtime.intercept(h.chat, 12000, null, 'regenerate');
  const result = h.runtime.getState().lastRecall;
  assert.equal(result.reusedReceipt, true); assert.equal(selections, 1);
  assert.ok(result.injectionText.includes(literal)); assert.ok(result.injectionText.includes(raw));
  assert.equal(result.injectionText.includes('旧人物自动补充'), false); assert.equal(result.injectionText.includes('旧私有自动补充'), false);
  assert.equal(result.injectionText.includes('旧人物状态独有文本'), false); assert.ok(result.injectionText.includes('用户多行地点描述\n- [旧事] 用户手写的第二行'));
});

test('地点同源完整短分句只输出一次，候选预算与注入共用且原成员来源全保',()=>{
 const {source,room,queryContext}=exactPlaceClauseSource(),before=structuredClone(source);
 const pool=buildRecallHistoryCandidatePool({source,queryContext});const row=pool.candidates.find(c=>c.value.placeEntityId===room);
 assert.ok(row);assert.equal(row.value.text.split('位于本馆走廊末端').length-1,1);
 const selected=selectRecall({source,queryContext,selectedHistoryCandidates:[row],maxItems:1,contextSize:12000});
 assert.equal(selected.injectionText.split('位于本馆走廊末端').length-1,1);assert.match(selected.injectionText,/位于本馆走廊末端，配有书架。/u);assert.match(selected.injectionText,/所属地点：东院/u);
 assert.equal(selected.manualPlaces.length,3);assert.deepEqual(new Set(selected.manualPlaces.map(x=>x.itemId)),new Set(['parent-exact','long-exact','short-exact']));assert.deepEqual(selected.manualPlaces.map(x=>x.source),before.placeWorkspace.foundation.facts.map(x=>x.source));
 assert.equal(selected.stages.finalInjectionItemCount,1);assert.equal(selected.limits.actualCharacters,selected.injectionText.length);assert.ok(row.value.text.length<placeRecallText(row.value._placeMembers,false).length);assert.deepEqual(source,before);
});

test('地点短分句不跨实体来源或人工折叠，否定可能及未完分句保持',()=>{
 const source={kind:'worldbook',locator:'地图:3',fingerprint:'sha256:fixture',quote:'原始资料。'};
 const short={kind:'placeFoundation',placeEntityId:'room',text:'客房：位于走廊末端',source};
 for(const text of ['不位于走廊末端，配有书架。','可能位于走廊末端，配有书架。','位于走廊末端但尚待核实。','位于走廊末端外侧，配有书架。']){
  const out=placeRecallText([short,{...short,text:'客房：'+text}]);assert.ok(out.includes('位于走廊末端；'+text),out);
 }
 for(const patch of [{placeEntityId:'other'},{kind:'manualPlace'},{source:{...source,locator:'地图:4'}},{source:{...source,quote:'另一段资料。'}},{source:{kind:'body',floorId:'floor-2',sourceType:'precedingUser',snapshotIndex:0,quote:'原始资料。'}}]){
  const out=placeRecallText([short,{...short,...patch,text:'客房：位于走廊末端，配有书架。'}]);assert.equal(out.split('位于走廊末端').length-1,2);
 }
 const body={kind:'body',floorId:'floor-2',sourceType:'precedingUser',snapshotIndex:0,quote:'原始资料。'};
 for(const patch of [{floorId:'floor-3'},{sourceType:'assistant'},{snapshotIndex:1}])assert.equal(placeRecallText([{...short,source:body},{...short,text:'客房：位于走廊末端，配有书架。',source:{...body,...patch}}]).split('位于走廊末端').length-1,2);
 for(const patch of [{manual:true},{manualArtifact:{exactText:'保留原文'}},{source:{...source,kind:'manual'}},{source:{...source,manual:true}}])for(const side of ['short','long']){
  const long={...short,text:'客房：位于走廊末端，配有书架。'},items=side==='short'?[{...short,...patch},long]:[short,{...long,...patch}];assert.equal(placeRecallText(items).split('位于走廊末端').length-1,2);
 }
 for(const text of ['位于走廊末端？','位于走廊末端?需核对','位于走廊末端！','位于走廊末端!再看一下']){const out=placeRecallText([short,{...short,text:'客房：'+text}]);assert.ok(out.includes('位于走廊末端；'+text),out);}
 for(const [small,long] of [['James 大楼','入口在 St. James 大楼'],['5米','高1.5米']])assert.equal(placeRecallText([{...short,text:'客房：'+small},{...short,text:'客房：'+long}]).split(small).length-1,2);
 const literal={...short,kind:'manualPlace',text:'客房：位于走廊末端；原文中的标点。'};assert.ok(placeRecallText([literal,{...short,text:'客房：位于走廊末端，配有书架。'}]).includes('位于走廊末端；原文中的标点。'));
});

test('v31同源重复旧票历史逐字读，新v32重新选材一次并完整封签复用',async()=>{
 const {source,queryContext}=exactPlaceClauseSource();source.identityProjection={placeWorkspaceRevision:1};source.placeWorkspaceDependency=CHAT+':1';let calls=0;
 const h=createRuntimeHarness({sourceReader:async()=>structuredClone(source),reachableReader:async()=>rawReachableFromSource(source),queryBuilder:()=>queryContext,placeWorkspaceDependencyProvider:()=>CHAT+':1',identityProjectionProvider:()=>({placeWorkspaceRevision:1}),selector:input=>{calls++;return selectRecall(input);}});
 await h.runtime.intercept(h.chat,12000,null,'normal');await flushReceiptSave();const old=structuredClone(h.userMessage.extra[RECALL_RECEIPT_KEY]);
 old.strategyVersion='continuity-v31';old.injectionText=formatRecallInjection({coverage:old.coverage,floors:[],states:[],cseChanges:[],manualPlaces:old.selectedPlaces,entityById:new Map(),deduplicatePlaces:false});old.stages.estimatedTokenCount=estimateRecallTokens(old.injectionText);old.receiptFingerprint=await receiptFingerprint(old);
 h.userMessage.extra[RECALL_RECEIPT_KEY]=old;h.runtime.invalidate('old-v31');const before=structuredClone(old);
 const historical=await projectHistoricalRecallReceipt(h.userMessage,{chatId:CHAT,userMessageIndex:1});assert.ok(historical);assert.equal(historical.injectionText,old.injectionText);assert.equal(old.injectionText.split('位于本馆走廊末端').length-1,2);
 const inline=projectInlineRecallReceipt(historical);assert.equal(inline.protocolRecognized,true);assert.equal(inline.objectItems.find(x=>x.placeEntityId).text.split('位于本馆走廊末端').length-1,2);assert.deepEqual(h.userMessage.extra[RECALL_RECEIPT_KEY],before);
 await h.runtime.restorePersistedReceipt();assert.equal(h.runtime.getState().lastRecall.legacyReadOnly,true);await h.runtime.intercept(h.chat,12000,null,'regenerate');assert.equal(calls,2);const fresh=h.userMessage.extra[RECALL_RECEIPT_KEY];assert.equal(fresh.strategyVersion,'continuity-v32');assert.equal(fresh.injectionText.split('位于本馆走廊末端').length-1,1);assert.equal(fresh.receiptFingerprint,await receiptFingerprint(fresh));assert.ok(await projectHistoricalRecallReceipt(h.userMessage,{chatId:CHAT,userMessageIndex:1}));
 await h.runtime.intercept(h.chat,12000,null,'continue');assert.equal(calls,2);assert.equal(h.runtime.getState().lastRecall.reusedReceipt,true);
});

test('276真实9200ms提交读取保已完成选材，生产identity分支只有一次独立读', async () => {
  const { raw: initial, messages } = await retrySelectorReachable();
  const current = structuredClone(initial); current.rootRevision += 1;
  current.root.headCheckpointId = 'head-276'; current.checkpoint = { id: 'head-276' };
  let prepares = 0, selects = 0, sourceReads = 0, graphReads = 0, aborts = 0;
  const h = createRuntimeHarness({
    prepareMemory: async () => ++prepares === 1 ? { status: 'ready', reachable: initial } : { status: 'unavailable' },
    rootReader: async () => ({ status: 'ready', revision: current.rootRevision, data: current.root }),
    reachableReader: async () => { graphReads++; return current; },
    identityProjectionProvider: async () => ({ unavailableSources: [] }),
    sourceReader: async options => { sourceReads++; await new Promise(resolve => setTimeout(resolve, 9200)); return readRecallSource(options); },
    selector: options => { selects++; return selectRecall(options); },
  });
  h.chat.splice(0, h.chat.length, ...messages, h.userMessage);
  const result = await h.runtime.intercept(h.chat, 12000, () => { aborts++; }, 'normal');
  assert.equal(result.lastRecall.status, 'ready', JSON.stringify(result.lastRecall));
  assert.equal(selects, 1); assert.equal(sourceReads, 1); assert.equal(graphReads, 1); assert.equal(aborts, 0);
  const commit = result.lastRecall.timings.preparationAttempts.find(row => row.phase === 'commit');
  assert.equal(commit.budgetMs, 120000); assert.ok(commit.readMs >= 9000, '真实时间等待覆盖现场8.6～9.2秒读取');
  assert.ok(result.lastRecall.injectionText);
});

test('276独立来源只读一次且实际投影应用人工身份与地点辅助资料', async () => {
  const { raw, messages } = await retrySelectorReachable();
  let reads = 0, sourceReads = 0, selected;
  const target = '99999999-9999-4999-8999-999999999999';
  raw.entities.push({ ...raw.entities[0], id: target, displayName: '人工保留姓名', aliases: [] });
  raw.floorMemories[0].participants = [{ entityId: PERSON }];
  const projection = { unavailableSources: [], identityRedirectsByEntityId: { [PERSON]: target },
    manualAliasesByEntityId: { [target]: ['人工别名'] }, deletedEntityIds: [],
    placeWorkspace: { foundation: { entities: [], facts: [{ itemId: 'manual-place', kind: 'feature',
      placeEntityId: 'room', text: '人工地点资料', source: { kind: 'manual', locator: 'fixture' } }] } } };
  const h = createRuntimeHarness({ prepareMemory: async () => ({ status: 'unavailable' }),
    reachableReader: async () => { reads++; return raw; },
    identityProjectionProvider: async () => projection,
    sourceReader: async options => { sourceReads++; assert.equal(options.identityProjection, projection); return readRecallSource(options); },
    selector: options => { selected = options.source; return selectRecall(options); },
    rootReader: async () => ({ status: 'ready', revision: raw.rootRevision, data: raw.root }),
  });
  h.chat.splice(0, h.chat.length, ...messages, h.userMessage);
  const result = await h.runtime.intercept(h.chat, 12000, null, 'normal');
  assert.equal(result.lastRecall.status, 'ready', JSON.stringify(result.lastRecall));
  assert.equal(sourceReads, 1); assert.equal(reads, 1);
  assert.deepEqual(selected.placeWorkspace, projection.placeWorkspace);
  assert.deepEqual(selected.unavailableSources ?? [], []);
  assert.equal(selected.entities.some(item => item.entityId === PERSON), false);
  assert.ok(selected.entities.find(item => item.entityId === target)?.aliases.includes('人工别名'));
  assert.deepEqual(selected.floorMemories[0].participants.map(item => item.entityId), [target]);
});


test('276核心读取取消和120s真实期限沿signal停止后续批次及注入', async t => {
  for (const kind of ['cancel', 'timeout']) await t.test(kind, async sub => {
    if (kind === 'timeout') sub.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let entered, reads = 0, aborted = 0, nextBatches = 0, selects = 0;
    const started = new Promise(resolve => { entered = resolve; });
    const h = createRuntimeHarness({ sourceReader: options => readRecallSource(options),
      reachableReader: async ({ signal }) => {
        reads++;
        assert.ok(signal instanceof AbortSignal, 'sourceReader到store.readReachable沿用准备信号');
        await new Promise(resolve => {
          signal.addEventListener('abort', () => { aborted++; resolve(); }, { once: true });
          entered();
          if (kind === 'timeout') queueMicrotask(() => sub.mock.timers.tick(120000));
        });
        signal.throwIfAborted();
        nextBatches++;
        return rawReachableFromSource(runtimeFixture());
      }, selector: options => { selects++; return selectRecall(options); } });
    h.handlers.get('generation-started')('normal');
    const pending = h.runtime.intercept(h.chat, 12000, null, 'normal');
    await started;
    if (kind === 'cancel') h.handlers.get('generation-stopped')();
    const result = await pending;
    assert.equal(result.lastRecall.status, kind === 'cancel' ? 'stale' : 'error');
    if (kind === 'timeout') assert.equal(result.lastRecall.error.code, 'V3_RECALL_MEMORY_PREPARATION_TIMEOUT');
    assert.equal(reads, kind === 'cancel' ? 1 : 2, '仅原有来源尝试，不新增重试');
    assert.equal(aborted, reads); assert.equal(nextBatches, 0); assert.equal(selects, 0);
    assert.equal(h.saves, 0); assert.ok(h.prompts.every(call => call[1] === ''));
  });
});

test('276近期限辅助挂起仍保已确认同根或精确prepared核心，零额外图读取', async t => {
  for (const kind of ['sameRoot', 'prepared', 'shortPrepared']) await t.test(kind, async sub => {
    sub.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { raw: initial, messages } = await retrySelectorReachable();
    const current = structuredClone(initial);
    current.rootRevision++; current.root.headCheckpointId = 'head-aux-deadline'; current.checkpoint.id = 'head-aux-deadline';
    let auxiliaryCalls = 0, sourceReads = 0, selects = 0, prepares = 0;
    const h = createRuntimeHarness({
      preparationTimeoutMs: kind === 'shortPrepared' ? 20 : 120000,
      ...(kind !== 'sameRoot' ? { prepareMemory: async () => {
        prepares++;
        if (prepares > 1 && kind !== 'shortPrepared') sub.mock.timers.tick(112500);
        return { status: 'ready', reachable: prepares === 1 ? initial : current };
      } } : {}),
      sourceReader: options => { sourceReads++; return readRecallSource(options); },
      reachableReader: async () => initial,
      rootReader: async () => {
        if (kind === 'sameRoot') sub.mock.timers.tick(112500);
        const value = kind === 'sameRoot' ? initial : current;
        return { status: 'ready', revision: value.rootRevision, data: value.root };
      },
      identityProjectionProvider: (_identity, options) => {
        auxiliaryCalls++;
        if (auxiliaryCalls === 1 && kind !== 'shortPrepared') return { unavailableSources: [] };
        options.onPartial({ unavailableSources: ['places'] });
        queueMicrotask(() => sub.mock.timers.tick(kind === 'shortPrepared' ? 20 : 7500));
        return new Promise(() => {});
      },
      selector: options => { selects++; return selectRecall(options); },
    });
    h.chat.splice(0, h.chat.length, ...messages, h.userMessage);
    const result = await h.runtime.intercept(h.chat, 12000, null, 'normal');
    assert.equal(result.lastRecall.status, 'ready', JSON.stringify(result.lastRecall));
    assert.equal(selects, 1); assert.equal(sourceReads, kind === 'sameRoot' ? 1 : 0);
    assert.equal(auxiliaryCalls, 2); assert.ok(result.lastRecall.injectionText);
    assert.equal(result.lastRecall.timings.preparationAttempts.at(-1).status, 'ready');
  });
});

test('276成功核心读取的signal保后台缓存verifyRoot可用', async () => {
  const { raw, messages } = await retrySelectorReachable();
  let verifyRoot, verified = 0;
  const h = createRuntimeHarness({ sourceReader: options => readRecallSource(options),
    reachableReader: async ({ signal }) => {
      verifyRoot = async () => { signal.throwIfAborted(); verified++; return { status: 'ready', revision: raw.rootRevision, data: raw.root }; };
      return raw;
    }, rootReader: async () => ({ status: 'ready', revision: raw.rootRevision, data: raw.root }) });
  h.chat.splice(0, h.chat.length, ...messages, h.userMessage);
  const result = await h.runtime.intercept(h.chat, 12000, null, 'normal');
  assert.equal(result.lastRecall.status, 'ready');
  assert.equal((await verifyRoot()).status, 'ready', '读取返回后缓存publish仍能核验root');
  assert.equal(verified, 1);
});


test('第一批选材隔离：真实年度独池坏可选字段退空，主答复缺失仍失败', async () => {
  const source = selectorSource({ memories: [], currentState: [] });
  source.timeProjection = { corrections: {}, reminders: [{ itemId: 'annual-only', type: 'annual', subjectEntityId: PERSON,
    distance: null, rankText: '裴晚生生日霜月初三', text: '裴晚生 / 生日：霜月初三', sourceSignature: 'annual-only' }] };
  let calls = 0;
  const result = await selectRecallWithLlm({ source, queryContext: { ...llmQuery, text: '裴晚生生日', latestUserText: '裴晚生生日' }, generateUtilityTask: async options => {
    calls += 1; const packet = JSON.parse(options.taskMessages[0].content);
    assert.equal(packet.candidates.length, 0); assert.equal(packet.annualCandidates.length, 1);
    return { jsonData: { history_exclude_keys: [], state_exclude_keys: [], annual_retain_keys: { bad: true } } };
  } });
  assert.equal(calls, 1); assert.equal(result.timeDependencies.reminders.length, 0);
  assert.doesNotMatch(result.injectionText, /霜月初三/);
  await assert.rejects(selectRecallWithLlm({ source, queryContext: { ...llmQuery, text: '裴晚生生日', latestUserText: '裴晚生生日' }, generateUtilityTask: async () => ({ jsonData: {} }) }),
    error => error.code === 'V3_RECALL_LLM_FIELDS_MISSING');
});


test('第一批选材隔离：真实人工原文候选坏选择退空，合法主材料照常注入', async () => {
  const value = reachable(), raw = '人工原文全文仅明确选择后可注入';
  value.floorMemories[0].exactAnchors = [{ anchorId: 'aaaaaaaa-0000-4000-8000-000000000001', kind: 'other', exactText: raw,
    occurrence: 1, speakerEntityId: null, whyPreserve: '人工记录', manual: true, carrier: '便笺', sourceFloorId: FLOOR1 }];
  const source = await projectRecallSource(value, () => new Date(NOW), sourceAttempts('ready'));
  let calls = 0;
  const result = await selectRecallWithLlm({ source, queryContext: { text: '阿裴的便笺', latestUserText: '阿裴的便笺', messageCount: 1 }, generateUtilityTask: async options => {
    calls += 1; const packet = JSON.parse(options.taskMessages[0].content);
    assert.ok(packet.candidates.some(candidate => candidate.fact.includes('载体：便笺')));
    return { jsonData: { history_exclude_keys: [], state_exclude_keys: [], artifact_select_keys: { bad: true } } };
  } });
  assert.equal(calls, 1); assert.ok(result.injectionText); assert.doesNotMatch(result.injectionText, new RegExp(raw));
});

test('知情范围：R承诺直陈表达接收范围，Q候选及注入保私下原描述', async () => {
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  const target = '88888888-7777-4777-8777-777777777777';
  memories[0] = recallMemory(1, { commitments: [{ speakerEntityId: PERSON, targetEntityIds: [target],
    kind: 'agreement', content: '周末清晨一起去看海', status: 'accepted', exactAnchorId: null }] });
  const source = selectorSource({ memories });
  const query = { text: '阿裴与林岚周末看海', latestUserText: '阿裴与林岚周末看海' };
  const context = historySelectionContext(source, query);
  const facts = context.facts.filter(value => value.kind === 'commitment');
  const entityById = new Map(source.entities.map(entity => [entity.entityId, entity]));
  const r = formatRecallInjection({ coverage: source.coverage, floors: [{ assistantSeq: 1, items: facts }], states: [], cseChanges: [], entityById });
  assert.match(r, /表达者：裴晚生/u); assert.match(r, /接收者：林岚/u);
  assert.match(r, /资料供作者理解剧情/u);
  const floor = { id: FLOOR1, chatId: CHAT, narrativeGeneration: GEN, assistantSeq: 1, hostLocator: { messageIndex: 0 }, content: { canonicalContent: '二人私下约好看海。' } };
  const delta = await compileQianshiDelta({ floor, now: NOW, packet: { qianshi: { events: [{ key: 'sea', title: '周末看海',
    description: '裴晚生与林岚二人私下对话约好同行，乙未参与对话。', people: ['裴晚生', '林岚'], status: 'planned', matter: true }], order: [] } } });
  const graph = { root: { chatId: CHAT, narrativeGeneration: GEN, headCheckpointId: 'head' }, floors: [floor],
    floorMemories: [{ id: MEMORY1, floorId: FLOOR1, recordStatus: 'active', chronology: [], qianshiDelta: delta }], entities: [] };
  const prepared = prepareQianshiRecallCandidates(graph, { queryContext: query });
  assert.ok(JSON.stringify(prepared.candidates).includes('二人私下对话'));
  const q = projectQianshiCandidateSelection(prepared.candidates);
  assert.match(q.text, /二人私下对话/u); assert.match(q.text, /乙未参与对话/u);
  assert.match(q.text, /人物知情依/u);
  assert.ok(q.characterCount <= 4000);
  source.qianshiCandidates = prepared.candidates; source.qianshiProgress = q;
  source.currentState = [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: [{ stateId: ITEM, text: '保留的人物状态',
    reason: '已存', visibility: 'private', origin: 'floor', towardEntityId: target, sourceFloorId: 'floor-8', sourceAssistantSeq: 8, sourceDeltaId: DELTA1 }] }];
  let calls = 0;
  const generate = async options => {
    calls++; const request = JSON.parse(options.taskMessages[0].content);
    assert.ok(JSON.stringify(request.qianshiCandidates).includes('二人私下对话'));
    assert.match(options.systemPrompt, /资料供作者理解剧情/u);
    return { jsonData: { history_exclude_keys: [], state_exclude_keys: [], qianshi_exclude_keys: [] } };
  };
  const combined = await selectRecallWithLlm({ source, queryContext: query, contextSize: 12000, generateUtilityTask: generate });
  assert.equal(calls, 1); assert.match(combined.injectionText, /接收者：林岚/u);
  assert.match(combined.qianshiProgress.text, /乙未参与对话/u);
  const only = await selectRecallWithLlm({ source: { ...source, floorMemories: [], currentState: [] }, queryContext: query, contextSize: 12000, generateUtilityTask: generate });
  assert.equal(calls, 1, 'Q-only沿既有本地选中，不增加模型请求'); assert.match(only.qianshiProgress.text, /二人私下对话/u);
  const manual = structuredClone(graph), event = manual.floorMemories[0].qianshiDelta.events[0];
  manual.floorMemories[0].qianshiDelta.manualEventOverrides = [{ eventId: event.id, description: '人工确认二人私下约定，乙未获告知。' }];
  assert.match(projectQianshiRecall(manual).text, /人工确认二人私下约定/u);
  const long = structuredClone(graph); long.floorMemories[0].qianshiDelta.events[0].description = '完整上下文'.repeat(780);
  const bounded = projectQianshiRecall(long, { characterBudget: 1000 });
  assert.ok(bounded.characterCount <= 1000); assert.deepEqual(bounded.matterIds, [], '完整上下文超预算时整条省略');
});

test('知情范围：旧冷热冻结票四入口更新R接收范围及已选Q上下文，仍只选择一次', async t => {
  for (const mode of ['current', 'legacy', 'legacyBudget']) await t.test(mode, async () => {
    const legacy = mode !== 'current', budgetFull = mode === 'legacyBudget';
    const floor = { id: FLOOR1, chatId: CHAT, narrativeGeneration: GEN, assistantSeq: 1, hostLocator: { messageIndex: 0 }, content: { canonicalContent: '二人私下约好看海。' } };
    const delta = await compileQianshiDelta({ floor, now: NOW, packet: { qianshi: { events: [{ key: 'sea', title: '周末私下看海', description: '裴晚生与林岚二人私下对话约好同行，乙未参与对话。', people: ['裴晚生', '林岚'], status: 'planned', matter: true }], order: [] } } });
    const graph = { root: { chatId: CHAT, narrativeGeneration: GEN, headCheckpointId: 'head' }, floors: [floor],
      floorMemories: [{ id: MEMORY1, floorId: FLOOR1, recordStatus: 'active', chronology: [], qianshiDelta: delta }], entities: [] };
    let selections = 0, selectedReads = 0;
    const h = createRuntimeHarness({ manualMemorySnapshot: () => null, selector: input => { selections++; return selectRecall(input); },
      qianshiProgressProvider: (_source, options) => {
        if (options.selectedMatterIds) selectedReads++;
        return { ...projectQianshiRecall(graph, options), anchor: { narrativeGeneration: GEN, headCheckpointId: 'head' } };
      } });
    h.source.floorMemories[1].commitments = [{ speakerEntityId: PERSON, targetEntityIds: [h.source.entities[1].entityId],
      kind: 'agreement', content: '周末清晨一起去看海', status: 'accepted', exactAnchorId: null }];
    await h.runtime.intercept(h.chat, 12000, null, 'normal'); await flushReceiptSave();
    const old = h.userMessage.extra[RECALL_RECEIPT_KEY];
    const oldQ = { projectionVersion: 6, text: '[相关跟进事项]\n- 周末私下看海；状态：待办；跟进：持续。', eventIds: old.qianshiProgress.eventIds, matterIds: old.qianshiProgress.matterIds };
    oldQ.fingerprint = await fingerprintText(JSON.stringify(oldQ));
    old.injectionText = old.injectionText.replace(/<qqj_qianshi_progress>[\s\S]*?<\/qqj_qianshi_progress>/u, `<qqj_qianshi_progress>\n${oldQ.text}\n</qqj_qianshi_progress>`)
      .replace(/资料供作者理解剧情。[^\n]*?原语义。/u, '')
      .replace('表达者：裴晚生。接收者：林岚。内容：', '裴晚生 → 林岚：');
    old.qianshiProgress = oldQ;
    old.stages.qianshiTokenBudget = estimateRecallTokens(`\n\n<qqj_qianshi_progress>\n${oldQ.text}\n</qqj_qianshi_progress>`);
    old.stages.estimatedTokenCount = estimateRecallTokens(old.injectionText);
    const literal = '某人说（甲 → 乙）：原句提到[已表达/已共享信息]。';
    if (legacy) {
      delete old.timeDependencies.renderPlan;
      old.injectionText = old.injectionText.replace('</qqj_recalled_context>', `- [旧事] ${literal}\n</qqj_recalled_context>`);
    }
    if (!legacy) assert.ok(old.timeDependencies.renderPlan, 'fixture requires production renderPlan');
    if (budgetFull) old.stages.estimatedTokenBudget = estimateRecallTokens(old.injectionText);
    const budget = old.stages.estimatedTokenBudget;
    old.receiptFingerprint = await receiptFingerprint(old);
    h.runtime.invalidate('knowledge-old-ticket');
    const reads = selectedReads;
    for (const type of ['normal', 'regenerate', 'swipe', 'continue']) {
      const result = await h.runtime.intercept(h.chat, 12000, null, type);
      assert.equal(result.lastRecall.reusedReceipt, true);
      if (budgetFull) {
        assert.equal(result.lastRecall.qianshiProgress, null, '完整Q上下文超原预算时整条省略');
        assert.ok(estimateRecallTokens(result.lastRecall.injectionText) <= budget);
      } else {
        assert.match(result.lastRecall.injectionText, /二人私下对话/u);
        assert.match(result.lastRecall.injectionText, /乙未参与对话/u);
      }
      if (legacy) {
        assert.match(result.lastRecall.injectionText, /裴晚生 → 林岚：/u, '无结构见证的grouped旧句保持字面');
        assert.ok(result.lastRecall.injectionText.includes(literal), '普通原句中的标题和箭头保持字面');
      }
      else {
        assert.match(result.lastRecall.injectionText, /表达者：裴晚生/u);
        assert.match(result.lastRecall.injectionText, /接收者：林岚/u);
      }
      assert.match(result.lastRecall.injectionText, budgetFull ? /作者资料按原描述/u : /资料供作者理解剧情/u);
      const inline = projectInlineRecallReceipt(result.lastRecall);
      assert.equal(inline.protocolRecognized, true, '新旧票仍经真实inline消费者识别');
      assert.equal(inline.objectItems.some(item => String(item.text ?? '').startsWith('资料供作者理解剧情')), false, '知情规则不伪装成千事条目');
      assert.equal(result.lastRecall.stages.estimatedTokenCount, estimateRecallTokens(result.lastRecall.injectionText));
    }
    assert.equal(selections, 1); assert.equal(selectedReads, reads + 1, '旧版Q仅按原已选ID升级一次');
    await flushReceiptSave(); h.runtime.invalidate('knowledge-new-ticket-cold');
    const cold = await h.runtime.intercept(h.chat, 12000, null, 'regenerate');
    assert.equal(cold.lastRecall.reusedReceipt, true); assert.equal(selections, 1);
  });
});

test('第二批冻结人物明确删除与归并按稳定ID到达CSE，四入口和冷读不重选', async t => {
  for (const mode of ['delete', 'merge', 'legacyDelete']) await t.test(mode, async () => {
    let projection = {}, selections = 0;
    const h = createRuntimeHarness({ manualMemorySnapshot: () => null, identityProjectionProvider: async () => projection,
      selector: input => { selections++; return selectRecall(input); } });
    const target = h.source.entities[2].entityId;
    h.source.currentState = [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: [{ stateId: ITEM,
      text: '冻结人物唯一人工状态', origin: 'manual', visibility: 'private', reason: '人工', towardEntityId: target,
      sourceFloorId: 'floor-8', sourceDeltaId: DELTA1, sourceAssistantSeq: 8 }] }];
    const first = await h.runtime.intercept(h.chat, 12000, null, 'normal');
    assert.match(first.lastRecall.injectionText, /冻结人物唯一人工状态/u);
    await flushReceiptSave();
    if (mode === 'legacyDelete') {
      const saved = h.userMessage.extra[RECALL_RECEIPT_KEY]; delete saved.timeDependencies.renderPlan;
      saved.receiptFingerprint = await receiptFingerprint(saved); h.runtime.invalidate('legacy-person-delete');
    }
    projection = mode === 'merge' ? { identityRedirectsByEntityId: { [PERSON]: target }, currentNamesByEntityId: { [target]: '合并保留人物' } }
      : { deletedEntityIds: [PERSON] };
    for (const type of ['normal', 'regenerate', 'swipe', 'continue']) {
      const result = await h.runtime.intercept(h.chat, 12000, null, type);
      assert.equal(result.lastRecall.reusedReceipt, true);
      if (mode === 'merge') {
        assert.ok(result.lastRecall.selectedStates.every(value => value.subjectEntityId === target));
        assert.match(result.lastRecall.injectionText, /合并保留人物/u);
      } else assert.doesNotMatch(result.lastRecall.injectionText, /冻结人物唯一人工状态/u);
    }
    await flushReceiptSave(); h.runtime.invalidate('person-operation-cold');
    const cold = await h.runtime.intercept(h.chat, 12000, null, 'regenerate');
    assert.equal(cold.lastRecall.reusedReceipt, true); assert.equal(selections, 1);
  });
});

test('千事时效旧冻结票四生成入口和冷读按原选ID补剧情时间且不重选', async t => {
  for (const legacy of [false, true]) await t.test(legacy ? '无plan旧票' : '有plan旧票', async () => {
    const floor = { id: FLOOR1, chatId: CHAT, narrativeGeneration: GEN, assistantSeq: 1, hostLocator: { messageIndex: 0 }, content: { canonicalContent: '两人约定日后归还书。' } };
    const delta = await compileQianshiDelta({ floor, now: NOW, packet: { qianshi: { events: [{ key: 'book', title: '日后归还书', description: '两人私下约定日后归还。', storyTime: '2024-03-18 07:45', scheduledTime: '2024-04-01', status: 'planned', following: true, matter: true }], order: [] } } });
    const graph = { root: { chatId: CHAT, narrativeGeneration: GEN, headCheckpointId: 'head' }, floors: [floor], entities: [], floorMemories: [{ id: MEMORY1, floorId: FLOOR1, recordStatus: 'active', chronology: [], qianshiDelta: delta }] };
    let selections = 0, selectedReads = 0;
    const h = createRuntimeHarness({ manualMemorySnapshot: () => null, selector: input => { selections++; return selectRecall(input); }, qianshiProgressProvider: (_source, options) => {
      if (options.selectedMatterIds) selectedReads++;
      return { ...projectQianshiRecall(graph, options), anchor: { narrativeGeneration: GEN, headCheckpointId: 'head' } };
    } });
    await h.runtime.intercept(h.chat, 12000, null, 'normal'); await flushReceiptSave();
    const receipt = h.userMessage.extra[RECALL_RECEIPT_KEY];
    const previous = { ...receipt.qianshiProgress, projectionVersion: 7, text: '[相关跟进事项]\n- 日后归还书；状态：待办；跟进：持续。' };
    delete previous.fingerprint; previous.fingerprint = await fingerprintText(JSON.stringify(previous));
    receipt.injectionText = receipt.injectionText.replace(/<qqj_qianshi_progress>[\s\S]*?<\/qqj_qianshi_progress>/u, `<qqj_qianshi_progress>\n${previous.text}\n</qqj_qianshi_progress>`);
    receipt.qianshiProgress = previous;
    receipt.stages.qianshiTokenBudget = estimateRecallTokens(`\n\n<qqj_qianshi_progress>\n${previous.text}\n</qqj_qianshi_progress>`);
    receipt.stages.estimatedTokenCount = estimateRecallTokens(receipt.injectionText);
    if (legacy) delete receipt.timeDependencies.renderPlan;
    receipt.receiptFingerprint = await receiptFingerprint(receipt);
    h.runtime.invalidate('temporal-old-receipt');
    const reads = selectedReads;
    for (const type of ['normal', 'regenerate', 'swipe', 'continue']) {
      const result = await h.runtime.intercept(h.chat, 12000, null, type);
      assert.equal(result.lastRecall.reusedReceipt, true);
      assert.match(result.lastRecall.injectionText, /最近剧情记录：2024-03-18 07:45（AI #1）/u);
      assert.match(result.lastRecall.injectionText, /记录状态：待办/u);
      assert.match(result.lastRecall.injectionText, /约定：2024-04-01/u);
      assert.equal(result.lastRecall.stages.estimatedTokenCount, estimateRecallTokens(result.lastRecall.injectionText));
    }
    await flushReceiptSave(); h.runtime.invalidate('temporal-current-receipt-cold');
    assert.equal((await h.runtime.intercept(h.chat, 12000, null, 'regenerate')).lastRecall.reusedReceipt, true);
    assert.equal(selections, 1);
    assert.equal(selectedReads, reads + 1);
  });
});

test('第六批时间召回：人工改写清空重填及删项贯通四入口冷热票，自动推进保原选择', async t => {
  for (const type of ['normal', 'regenerate', 'continue', 'swipe']) await t.test(type, async () => {
    let revision = null, label = '最初钟楼约定', available = true, selected = 0, observationKey = 'first';
    const provider = () => ({ fingerprint: revision ?? 'initial', corrections: {}, presentItemIds: available ? ['chosen'] : [],
      manualTimeItems: revision ? { chosen: { revision, revisionsByObservation: { first: null, [observationKey]: revision } } } : {},
      reminders: label ? [{ itemId: 'chosen', type: 'deadline', distance: 0, text: `阿裴 / ${label}`, rankText: '钟楼赴约',
        sourceSignature: JSON.stringify([PERSON, observationKey, []]) }] : [] });
    const options = { timeProjectionProvider: provider, selector: input => { selected++; return selectRecall(input); } };
    let h = createRuntimeHarness(options);
    await h.runtime.intercept(h.chat, 12000, null, 'normal');
    assert.match(h.runtime.getState().lastRecall.injectionText, /最初钟楼约定/u);
    label = '自动无关推进';
    await h.runtime.intercept(h.chat, 12000, null, type);
    assert.match(h.runtime.getState().lastRecall.injectionText, /最初钟楼约定/u);
    revision = 'manual-1'; observationKey = 'edit-1'; label = '人工钟楼改名';
    await h.runtime.intercept(h.chat, 12000, null, type);
    assert.match(h.runtime.getState().lastRecall.injectionText, /人工钟楼改名/u);
    revision = 'manual-2'; observationKey = 'edit-2'; label = '';
    await h.runtime.intercept(h.chat, 12000, null, type);
    assert.doesNotMatch(h.runtime.getState().lastRecall.injectionText, /人工钟楼改名|最初钟楼约定/u);
    const extra = structuredClone(h.userMessage.extra);
    h = createRuntimeHarness(options); h.userMessage.extra = extra;
    await h.runtime.intercept(h.chat, 12000, null, type);
    assert.doesNotMatch(h.runtime.getState().lastRecall.injectionText, /人工钟楼改名|最初钟楼约定/u);
    revision = 'manual-3'; observationKey = 'edit-3'; label = '人工重新填写';
    await h.runtime.intercept(h.chat, 12000, null, type);
    assert.match(h.runtime.getState().lastRecall.injectionText, /人工重新填写/u);
    available = false;
    await h.runtime.intercept(h.chat, 12000, null, type);
    assert.doesNotMatch(h.runtime.getState().lastRecall.injectionText, /人工重新填写/u);
    assert.equal(selected, 1);
    const receipt = h.userMessage.extra[RECALL_RECEIPT_KEY];
    assert.equal(receipt.injectionText, latestPromptValue(h.prompts, RECALL_PROMPT_SLOT));
    assert.equal(receipt.stages.estimatedTokenCount, estimateRecallTokens(receipt.injectionText));
  });
});

test('第六批时间召回：准备末次核验及冻结刷新等待及时响应停止，迟到结果不注入', async t => {
  for (const stage of ['prepare', 'verify', 'frozen']) for (const late of ['resolve', 'reject']) await t.test(`${stage}/${late}`, async () => {
    let reads = 0, armed = stage !== 'frozen', release, rejected, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const projection = { fingerprint: 'time', corrections: {}, presentItemIds: ['chosen'], manualTimeItems: {},
      reminders: [{ itemId: 'chosen', type: 'deadline', distance: 0, rankText: '钟楼赴约', text: '钟楼约定', sourceSignature: 'original' }] };
    const h = createRuntimeHarness({ timeProjectionProvider: () => {
      reads++;
      if (armed && (stage !== 'verify' || reads === 2)) { entered(); return new Promise((resolve, reject) => { release = resolve; rejected = reject; }); }
      return structuredClone(projection);
    } });
    if (stage === 'frozen') { await h.runtime.intercept(h.chat, 12000, null, 'normal'); armed = true; }
    const type = stage === 'frozen' ? 'regenerate' : 'normal';
    h.handlers.get('generation-started')(type);
    const pending = h.runtime.intercept(h.chat, 12000, null, type);
    await started; h.handlers.get('generation-stopped')();
    const result = await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('停止后仍等待时间来源')), 100))]);
    assert.equal(result.lastRecall.status, 'stale');
    const prompt = latestPromptValue(h.prompts, RECALL_PROMPT_SLOT);
    if (late === 'resolve') release(projection); else rejected(new Error('late time failure'));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(latestPromptValue(h.prompts, RECALL_PROMPT_SLOT), prompt);
    assert.equal(h.runtime.getActivityState().busy, false);
  });
});

test('第六批时间召回：年度设定提醒沿独立来源冻结，普通事项presence不删除年度项', async () => {
  let reads = 0, selections = 0;
  const h = createRuntimeHarness({ timeProjectionProvider: () => {
    reads++;
    return { fingerprint: 'annual', corrections: {}, presentItemIds: [], manualTimeItems: {},
      reminders: [{ itemId: 'annual:person:profile-birthday:0', type: 'annual', distance: 0,
        rankText: '阿裴生日', text: '阿裴生日就在今日', sourceSignature: 'annual-setting-source' }] };
  }, selector: input => { selections++; return selectRecall(input); } });
  await h.runtime.intercept(h.chat, 12000, null, 'normal');
  const first = h.runtime.getState().lastRecall.injectionText, before = reads;
  assert.match(first, /阿裴生日/u);
  const result = await h.runtime.intercept(h.chat, 12000, null, 'regenerate');
  assert.equal(result.lastRecall.injectionText, first);
  assert.equal(result.lastRecall.reusedReceipt, true);
  assert.equal(reads, before);
  assert.equal(selections, 1);
});

test('可选千事删除故障只撤本次Q及关联提醒，冻结四入口与旧票恢复不重选', async t => {
  for (const mode of ['regenerate', 'continue', 'swipe', 'cold', 'legacy', 'auxiliary-abort', 'reminders-only']) await t.test(mode, async () => {
    let unavailable = false, deletions = [], reads = 0, selections = 0, aborts = 0;
    const notifications = [];
    const deletionProvider = () => { reads++; if (unavailable) throw mode === 'auxiliary-abort' ? new DOMException('辅助读取取消', 'AbortError')
      : Object.assign(new Error('删除状态不可用'), { code: 'V3_MEMORY_FOUNDATION_NOT_READY' }); return { chatId: CHAT, events: deletions }; };
    const options = { selector: input => { selections++; return selectRecall(input); }, qianshiDeletionProvider: deletionProvider, notifyUser: value => notifications.push(value),
      qianshiProgressProvider: () => ({ anchor: { narrativeGeneration: GEN, headCheckpointId: 'head' }, projectionVersion: QIANSHI_RECALL_PROJECTION_VERSION,
        text: '[相关时间线]\n- 旧日：应删旧事\n- 今日：健康千事\n\n[当前待接续]\n- 原事项待办', eventIds: ['event-delete', 'event-keep'], matterIds: ['matter-book'] }),
      timeProjectionProvider: () => ({ fingerprint: 'clock', corrections: {}, reminders: [
        { itemId: 'book-time', text: '阿裴 / 关联事项提醒', sourceSignature: 'book-time', qianshiRef: { matterId: 'matter-book', originEventId: 'event-delete' } },
        { itemId: 'independent', text: '钟楼 / 独立时间提醒', sourceSignature: 'independent' },
      ] }),
    };
    if (mode === 'reminders-only') delete options.qianshiProgressProvider;
    const first = createRuntimeHarness(options);
    const initial = await first.runtime.intercept(first.chat, 12000, () => { aborts++; }, 'normal'); await flushReceiptSave(); first.handlers.get('generation-ended')();
    assert.match(initial.lastRecall.injectionText, /关联事项提醒[\s\S]*独立时间提醒/u);
    if (mode === 'legacy') {
      const receipt = first.userMessage.extra[RECALL_RECEIPT_KEY]; delete receipt.timeDependencies.renderPlan; delete receipt.qianshiDeletionWitness;
      receipt.receiptFingerprint = await receiptFingerprint(receipt); first.runtime.invalidate('legacy-fixture');
    }
    const original = structuredClone(first.userMessage.extra[RECALL_RECEIPT_KEY]);
    const h = mode === 'cold' ? createRuntimeHarness(options) : first;
    if (h !== first) h.userMessage.extra = structuredClone(first.userMessage.extra);
    unavailable = true; reads = 0;
    const degraded = await h.runtime.intercept(h.chat, 12000, () => { aborts++; }, ['continue', 'swipe'].includes(mode) ? mode : 'regenerate');
    assert.equal(degraded.lastRecall.status, 'ready'); assert.equal(aborts, 0); assert.equal(reads, 1); assert.equal(selections, 1); assert.deepEqual(notifications, []);
    assert.match(degraded.lastRecall.injectionText, /<qqj_recalled_context>[\s\S]*独立时间提醒/u);
    assert.doesNotMatch(degraded.lastRecall.injectionText, /qqj_qianshi_progress|关联事项提醒/u);
    assert.deepEqual(degraded.lastRecall.selectedFloors, initial.lastRecall.selectedFloors);
    assert.deepEqual(degraded.lastRecall.selectedStates, initial.lastRecall.selectedStates);
    assert.deepEqual(degraded.lastRecall.selectedCseChanges, initial.lastRecall.selectedCseChanges);
    assert.equal(degraded.lastRecall.stages.timeReminderCount, 1);
    assert.equal(degraded.lastRecall.injectionText, latestPromptValue(h.prompts, RECALL_PROMPT_SLOT));
    assert.equal(degraded.lastRecall.stages.estimatedTokenCount, estimateRecallTokens(degraded.lastRecall.injectionText));
    assert.equal(Object.hasOwn(degraded.lastRecall.stages, 'qianshiTokenBudget'), false);
    assert.equal(degraded.lastRecall.stages.finalInjectionItemCount, initial.lastRecall.stages.finalInjectionItemCount - 1);
    assert.equal(degraded.lastRecall.receiptPersistence, 'sessionOnly');
    assert.deepEqual(h.userMessage.extra[RECALL_RECEIPT_KEY], original, '瞬态降级不重写原成功签名票');
    unavailable = false; deletions = [{ eventId: 'event-delete', matterId: 'matter-book' }];
    const restored = await h.runtime.intercept(h.chat, 12000, () => { aborts++; }, 'continue');
    assert.equal(restored.lastRecall.status, 'ready'); assert.equal(selections, 1); assert.equal(reads, 2); assert.equal(aborts, 0);
    if (mode !== 'reminders-only') assert.match(restored.lastRecall.injectionText, /健康千事/u);
    assert.match(restored.lastRecall.injectionText, /独立时间提醒/u);
    assert.doesNotMatch(restored.lastRecall.injectionText, /应删旧事|原事项待办|关联事项提醒/u);
    assert.deepEqual(h.userMessage.extra[RECALL_RECEIPT_KEY], original);
  });
});

test('删除状态瞬态降级保人工摘要新稿及CSE清空，恢复后才沿正常票落盘', async t => {
  for (const legacy of [false, true]) await t.test(legacy ? 'legacy' : 'current', async () => {
    const raw = await singleFloorReachable({ summary: '人工旧摘要' }); raw.entities = reachable().entities;
    raw.floorMemories[0].summary = { effectiveSource: 'user', aiText: 'AI旧稿', userText: '人工旧摘要' };
    const oldState = { id: 'manual-old', text: '人工旧状态', reason: '人工', visibility: 'private', origin: 'manual', towardEntityId: null,
      sourceFloorId: raw.floors[0].id, sourceDeltaId: 'manual-delta-old' };
    raw.stateDeltas = [{ id: oldState.sourceDeltaId, floorId: raw.floors[0].id, floorMemoryId: raw.floorMemories[0].id, recordStatus: 'active',
      source: { manualSubjectEntityIds: [PERSON] }, subjectSnapshots: [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: [oldState] }],
      fixedChanges: [{ subjectEntityId: PERSON, items: [{ category: 'situational', action: 'add', before: null, after: oldState }] }] }];
    raw.currentStates = [{ subjects: raw.stateDeltas[0].subjectSnapshots }];
    let unavailable = false, selections = 0;
    const h = createRuntimeHarness({ sourceReader: options => readRecallSource(options), reachableReader: async () => structuredClone(raw), manualMemorySnapshot: () => raw,
      selector: input => { selections++; return selectRecall(input); }, qianshiDeletionProvider: () => { if (unavailable) throw new Error('optional unavailable'); return { chatId: CHAT, events: [] }; },
      qianshiProgressProvider: source => ({ anchor: { narrativeGeneration: source.narrativeGeneration, headCheckpointId: source.headCheckpointId }, projectionVersion: QIANSHI_RECALL_PROJECTION_VERSION,
        text: '[相关时间线]\n- 合法旧千事', eventIds: ['old-event'], matterIds: [] }),
    });
    h.chat[0].is_hidden = true;
    await h.runtime.intercept(h.chat, 12000, null, 'normal'); await flushReceiptSave(); h.handlers.get('generation-ended')();
    if (legacy) { const receipt = h.userMessage.extra[RECALL_RECEIPT_KEY]; delete receipt.timeDependencies.renderPlan; delete receipt.qianshiDeletionWitness;
      receipt.receiptFingerprint = await receiptFingerprint(receipt); h.runtime.invalidate('legacy-fixture'); }
    const original = structuredClone(h.userMessage.extra[RECALL_RECEIPT_KEY]); assert.match(original.injectionText, /人工旧状态/u);
    raw.floorMemories[0].id = 'memory-manual-current'; raw.floorMemories[0].summary.userText = '人工最新摘要';
    raw.rootRevision++; raw.root.headCheckpointId = raw.checkpoint.id = 'head-manual-current';
    raw.stateDeltas = [{ id: 'manual-clear', floorId: raw.floors[0].id, floorMemoryId: raw.floorMemories[0].id, recordStatus: 'active', source: { manualSubjectEntityIds: [PERSON] },
      subjectSnapshots: [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: [] }],
      fixedChanges: [{ subjectEntityId: PERSON, items: [{ category: 'situational', action: 'remove', before: oldState, after: null }] }] }];
    raw.currentStates = [{ subjects: raw.stateDeltas[0].subjectSnapshots }];
    unavailable = true;
    const degraded = await h.runtime.intercept(h.chat, 12000, null, 'regenerate'); await flushReceiptSave();
    assert.equal(degraded.lastRecall.status, 'ready'); assert.match(degraded.lastRecall.injectionText, /人工最新摘要/u);
    assert.doesNotMatch(degraded.lastRecall.injectionText, /人工旧摘要|人工旧状态|合法旧千事/u);
    assert.deepEqual(h.userMessage.extra[RECALL_RECEIPT_KEY], original); assert.equal(h.saves, 1);
    unavailable = false;
    const restored = await h.runtime.intercept(h.chat, 12000, null, 'continue'); await flushReceiptSave();
    assert.equal(restored.lastRecall.status, 'ready'); assert.match(restored.lastRecall.injectionText, /人工最新摘要[\s\S]*合法旧千事/u);
    assert.doesNotMatch(restored.lastRecall.injectionText, /人工旧摘要|人工旧状态/u); assert.equal(selections, 1);
    const saved = h.userMessage.extra[RECALL_RECEIPT_KEY]; assert.equal(saved.injectionText, restored.lastRecall.injectionText);
    const cold = createRuntimeHarness({ sourceReader: options => readRecallSource(options), reachableReader: async () => structuredClone(raw), manualMemorySnapshot: () => raw,
      selector: () => assert.fail('恢复后签名票应可冷复用') }); cold.chat[0].is_hidden = true; cold.userMessage.extra = structuredClone(h.userMessage.extra);
    assert.equal((await cold.runtime.intercept(cold.chat, 12000, null, 'continue')).lastRecall.reusedReceipt, true);
  });
});

test('千事删除读取等待中真正主取消仍清槽，不注入迟到可选结果', async () => {
  let blocked = false, entered, release, aborts = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const h = createRuntimeHarness({ qianshiProgressProvider: () => ({ anchor: { narrativeGeneration: GEN, headCheckpointId: 'head' }, projectionVersion: QIANSHI_RECALL_PROJECTION_VERSION,
    text: '[相关时间线]\n- 千事', eventIds: ['event'], matterIds: [] }), qianshiDeletionProvider: () => {
    if (!blocked) return { chatId: CHAT, events: [] }; entered(); return new Promise(resolve => { release = resolve; }); } });
  await h.runtime.intercept(h.chat, 12000, null, 'normal'); h.handlers.get('generation-ended')(); blocked = true;
  h.handlers.get('generation-started')('regenerate', {}, false);
  const task = h.runtime.intercept(h.chat, 12000, () => { aborts++; }, 'regenerate'); await started;
  h.handlers.get('generation-stopped')(); release({ chatId: CHAT, events: [] }); await task;
  assert.equal(aborts, 0);
  assert.equal(latestPromptValue(h.prompts, RECALL_PROMPT_SLOT), '');
});
