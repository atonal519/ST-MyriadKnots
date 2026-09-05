import test from 'node:test';
import assert from 'node:assert/strict';
import { readRecallSource } from '../src/v3/recall-source.js';
import { buildRecallQueryContext, selectRecall } from '../src/v3/recall-selector.js';
import { createV3RecallRuntime, RECALL_PROMPT_SLOT, RECALL_RECEIPT_KEY, RECALL_RECEIPT_SCHEMA_VERSION } from '../src/v3/recall-runtime.js';
import { sha256 } from '../src/identity.js';
import { assessMemoryCoverageFromHost } from '../src/v3/memory-coverage.js';
import { scanAssistantCandidates } from '../src/v3/foundation-domain.js';

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
const fingerprintText = async value => `sha256:${await sha256(String(value ?? ''))}`;

const receiptFingerprint = async receipt => fingerprintText(JSON.stringify([
  receipt.schemaVersion, receipt.pluginVersion, receipt.chatId, receipt.narrativeGeneration,
  receipt.userMessageIndex, receipt.userContentFingerprint, receipt.queryFingerprint, receipt.generationType,
  receipt.selectedFloors, receipt.selectedStates, receipt.coverage, receipt.injectionText, receipt.stages, receipt.skipReasons, receipt.completionStatus, receipt.createdAt,
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
    stateDeltas: [{ id: DELTA1, floorId: FLOOR1, floorMemoryId: MEMORY1, recordStatus: 'active', subjectSnapshots: [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: [stateItem] }] }],
    currentStates: [{ subjects: [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: [{ ...stateItem, text: '不可信的存储幽灵状态' }] }] }],
  };
}

const sourceAttempts = exitPoint => ({ reachableReads: 1, exitPoint });

test('recall source 只输出 reachable 窄 DTO，局部重放而不信任 stored CurrentState', async () => {
  const value = reachable();
  const store = { readReachable: async () => structuredClone(value) };
  const result = await readRecallSource({ store, now: () => new Date(NOW) });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.coverage, { stableAiFloors: 2, stableThroughAssistantSeq: 2, rememberedAiFloors: 1, missingAssistantSeq: [2], cseThroughAssistantSeq: 1, memoryComplete: false, cseCurrent: false });
  assert.equal(result.currentState[0].situational[0].text, '始终记得雨夜承诺');
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
  floorId: `floor-${assistantSeq}`, floorMemoryId: `memory-${assistantSeq}`, assistantSeq, summary: patch.summary ?? `第 ${assistantSeq} 楼普通摘要`,
  participants: patch.participants ?? [], locations: patch.locations ?? [], commitments: patch.commitments ?? [], openLoops: patch.openLoops ?? [], exactAnchors: patch.exactAnchors ?? [], events: patch.events ?? [], actions: patch.actions ?? [], observations: patch.observations ?? [], privateCognition: patch.privateCognition ?? [], informationTransfers: patch.informationTransfers ?? [],
});

function selectorSource({ complete = true, memories = null, currentState = null } = {}) {
  const floorMemories = memories ?? Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  return {
    status: 'ready', chatId: CHAT, narrativeGeneration: GEN, headCheckpointId: 'head', rootRevision: 1,
    coverage: { stableAiFloors: 8, stableThroughAssistantSeq: 8, rememberedAiFloors: complete ? 8 : 6, missingAssistantSeq: complete ? [] : [7, 8], cseThroughAssistantSeq: complete ? 8 : 6, memoryComplete: complete, cseCurrent: complete },
    entities: [
      { entityId: PERSON, entityType: 'person', displayName: '裴晚生', aliases: ['阿裴'], specialRole: 'char' },
      { entityId: '88888888-7777-4777-8777-777777777777', entityType: 'person', displayName: '林岚', aliases: ['小岚'], specialRole: 'user' },
      { entityId: '99999999-7777-4777-8777-777777777777', entityType: 'person', displayName: '乙', aliases: [], specialRole: 'none' },
    ],
    floorMemories,
    currentState: currentState ?? [],
  };
}

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

test('selector 命中人名/别名、中文地点、承诺、open loop 与 exact quote，排除近 3 楼后按故事顺序注入', () => {
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  memories[1] = recallMemory(2, {
    summary: '裴晚生在钟楼留下约定。', participants: [{ entityId: PERSON, presence: 'present' }],
    locations: [{ name: '钟楼', change: 'present', entityId: null, participantEntityIds: [PERSON] }],
    commitments: [{ speakerEntityId: PERSON, targetEntityIds: [], kind: 'codePhrase', content: '雨落三声后钟楼见', status: 'made', exactAnchorId: null }],
    openLoops: [{ description: '找到钟楼下的密门', ownerEntityIds: [PERSON] }],
  });
  memories[3] = recallMemory(4, { exactAnchors: [{ anchorId: 'anchor', kind: 'codePhrase', exactText: '雨落：三声', speakerEntityId: PERSON, whyPreserve: '暗号原句' }] });
  memories[6] = recallMemory(7, { summary: '近期钟楼内容不应重复召回', participants: [{ entityId: PERSON, presence: 'present' }] });
  const source = selectorSource({ memories });
  const queryContext = buildRecallQueryContext({ coreChat: [{ is_user: false, is_system: false, mes: '他们刚离开街口。' }, { is_user: true, is_system: false, mes: '阿裴，去钟楼说“雨落：三声”，别忘了密门和约定。' }] });
  const selected = selectRecall({ source, queryContext, contextSize: 12000 });
  assert.deepEqual(selected.floors.map(value => value.assistantSeq), [2, 4], '最终按 assistantSeq 排列而不是得分顺序');
  assert.equal(selected.floors.some(value => value.assistantSeq >= 6), false, '必须排除最近 3 个 AI 楼');
  assert.match(selected.injectionText, /裴晚生|阿裴|钟楼/);
  assert.match(selected.injectionText, /雨落三声后钟楼见/);
  assert.match(selected.injectionText, /未结事项[:：]找到钟楼下的密门/);
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
  const result = selectRecall({
    source: selectorSource({ memories }),
    queryContext: { text: '暗门后有人，月落前离开；暗号是雨落三声。不要相信镜子。无边界秘密是什么？', latestUserText: '回忆这些原句', messageCount: 1 },
  });
  const bySeq = new Map(result.floors.map(floor => [floor.assistantSeq, floor]));
  assert.deepEqual(bySeq.get(1).items.map(value => value.category), ['private'], '内心同文原句只属于 owner-private');
  assert.deepEqual(bySeq.get(2).items.map(value => value.category), ['transfer'], '定向传话原句只继承 from→to 边界');
  assert.equal(bySeq.get(2).items[0].fromEntityId, PERSON);
  assert.deepEqual(bySeq.get(2).items[0].toEntityIds, [userId]);
  assert.equal(bySeq.get(3).items[0].category, 'shared', '承诺原句继承合法接收者边界');
  assert.equal(bySeq.get(3).items[0].status, 'made');
  assert.deepEqual(bySeq.get(4).items.map(value => value.category), ['private'], '只有 speaker 的孤立原句保守归 speaker-private');
  assert.equal(bySeq.has(5), false, '没有 speaker 或 typed 边界的原句只用于匹配，不得注入');
  assert.equal(result.floors.flatMap(floor => floor.items).some(value => value.kind === 'exactAnchor' && value.category === 'objective'), false);
  assert.match(result.injectionText, /裴晚生 → 林岚（仅列明接收者知情，渠道：told）：原句「月落前离开」/);
  assert.match(result.injectionText, /已作出（不代表已履行）：约定以三声雨响作为暗号；原句「雨落三声」/);
  assert.match(result.injectionText, /仅该人物可用的原句「不要相信镜子」/);
  assert.doesNotMatch(result.injectionText, /无边界秘密/);
});

test('selector 无可靠命中不凑数；楼数、总项和字符上限均生效', () => {
  const empty = selectRecall({ source: selectorSource(), queryContext: { text: '完全无关的宇宙飞船', latestUserText: '宇宙飞船', messageCount: 1 } });
  assert.deepEqual(empty.floors, []);
  assert.equal(empty.status, 'empty');
  const memories = Array.from({ length: 15 }, (_, index) => recallMemory(index + 1, { summary: `钥匙线索 ${index + 1}`, openLoops: [{ description: `用钥匙打开第 ${index + 1} 道门`, ownerEntityIds: [] }] }));
  const source = selectorSource({ memories }); source.coverage = { ...source.coverage, stableAiFloors: 15, stableThroughAssistantSeq: 15, rememberedAiFloors: 15, cseThroughAssistantSeq: 15 };
  const result = selectRecall({ source, queryContext: { text: '用钥匙开门', latestUserText: '用钥匙开门', messageCount: 1 }, contextSize: 1800 });
  assert.ok(result.floors.length <= 8);
  assert.ok(result.floors.flatMap(value => value.items).length + result.states.length <= 18);
  assert.ok(result.injectionText.length <= result.limits.maxCharacters);
  assert.deepEqual(result.floors.map(value => value.assistantSeq), [...result.floors.map(value => value.assistantSeq)].sort((a, b) => a - b));
});

test('selector 去掉与当前常驻状态或其他候选重复的旧楼内容，不浪费召回额度', () => {
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  memories[1] = recallMemory(2, { summary: '旧楼人物概览', participants: [{ entityId: PERSON, presence: 'present' }], privateCognition: [{ ownerEntityId: PERSON, kind: 'thought', content: '裴晚生冷静克制' }] });
  memories[2] = recallMemory(3, { summary: '另一楼人物概览', participants: [{ entityId: PERSON, presence: 'present' }], privateCognition: [{ ownerEntityId: PERSON, kind: 'thought', content: '裴晚生冷静克制' }] });
  const currentState = [{ subjectEntityId: PERSON, core: [{ text: '裴晚生冷静克制', visibility: 'authorial', reason: '人设', origin: 'baseline', towardEntityId: null, sourceAssistantSeq: 1 }], adaptive: [], situational: [] }];
  const result = selectRecall({ source: selectorSource({ memories, currentState }), queryContext: { text: '阿裴现在如何', latestUserText: '阿裴现在如何', messageCount: 1 } });
  assert.deepEqual(result.floors, []);
  assert.equal(result.states.length, 1);
  assert.equal(result.stages.dropPersistent, 2);
  assert.ok(result.skipReasons.includes('persistentStateDuplicate'));
});

test('selector summary 仅用于匹配打分；与 privateCognition 同文时只保留 owner-private', () => {
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  const secret = '钟楼暗门密码是海棠';
  memories[1] = recallMemory(2, {
    summary: secret,
    participants: [{ entityId: PERSON, presence: 'present' }],
    privateCognition: [{ ownerEntityId: PERSON, kind: 'thought', content: secret }],
  });
  const result = selectRecall({ source: selectorSource({ memories }), queryContext: { text: '阿裴还记得钟楼暗门密码吗', latestUserText: '阿裴还记得钟楼暗门密码吗', messageCount: 1 } });
  assert.equal(result.floors.length, 1);
  assert.deepEqual(result.floors[0].items.map(value => value.category), ['private']);
  assert.match(result.injectionText, /\[裴晚生 的私有认知（仅可用于 裴晚生）\]/);
  assert.doesNotMatch(result.injectionText, /\[客观相关旧事\]/);
  assert.equal(result.injectionText.split(secret).length - 1, 1, '同文摘要不得再升级为公共事实或重复注入');
});

test('selector summary-only 无法确定知情边界时宁可不注入', () => {
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  memories[1] = recallMemory(2, { summary: '钟楼暗门密码是海棠' });
  const result = selectRecall({ source: selectorSource({ memories }), queryContext: { text: '钟楼暗门密码是什么', latestUserText: '钟楼暗门密码是什么', messageCount: 1 } });
  assert.equal(result.status, 'empty');
  assert.deepEqual(result.floors, []);
  assert.equal(result.injectionText, '');
});

test('selector 为 action 所有 completion 枚举保留明确完成度，未完成不得写成完成', () => {
  const completions = ['intended', 'attempted', 'completed', 'interrupted', 'uncertain'];
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  completions.forEach((completion, index) => {
    memories[index] = recallMemory(index + 1, { actions: [{ actorEntityId: PERSON, targetEntityIds: [], action: `${completion} 密门机关`, completion, result: null }] });
  });
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
  const result = selectRecall({ source: selectorSource({ memories }), queryContext: { text: '阿裴的暗号和密门计划', latestUserText: '阿裴的暗号和密门计划', messageCount: 1 } });
  const items = result.floors.flatMap(floor => floor.items);
  assert.equal(items.find(value => value.status === 'made' && value.commitmentKind === 'promise').category, 'shared');
  assert.equal(items.find(value => value.status === 'accepted').category, 'shared');
  assert.equal(items.find(value => value.status === 'refused').category, 'shared');
  assert.equal(items.find(value => value.status === 'uncertain').category, 'private');
  assert.equal(items.find(value => value.commitmentKind === 'plan').category, 'private');
  assert.match(result.injectionText, /已作出（不代表已履行）：暗号甲/);
  assert.match(result.injectionText, /已接受并成立（不代表已履行）：暗号乙/);
  assert.match(result.injectionText, /已拒绝（不构成承诺）：暗号丙/);
  assert.match(result.injectionText, /是否成立不确定（不得当作有效承诺）：暗号丁/);
  assert.match(result.injectionText, /计划（不代表已告知或已完成）：私下密门计划/);
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
  assert.match(complete.injectionText, /裴晚生 的私有认知（仅可用于 裴晚生）/);
  assert.match(complete.injectionText, /已表达\/已共享信息/);
  assert.match(complete.injectionText, /暗自恐惧/);
  assert.match(complete.injectionText, /situational \/ private，仅可用于该人物：未标注的内心秘密/);
  assert.doesNotMatch(complete.injectionText, /乙[^\n]*暗自恐惧/);
  const partial = selectRecall({ source: selectorSource({ complete: false, memories, currentState: state }), queryContext });
  assert.match(partial.injectionText, /冷静克制/);
  assert.doesNotMatch(partial.injectionText, /对林岚保持戒备|暗自恐惧/);
  assert.match(partial.injectionText, /覆盖说明.*动态状态未被当作当前事实/);
  assert.ok(partial.stages.dropVisibility >= 2);
});

function runtimeFixture() {
  const memories = Array.from({ length: 8 }, (_, index) => recallMemory(index + 1));
  memories[1] = recallMemory(2, {
    summary: '裴晚生曾在钟楼留下约定。',
    participants: [{ entityId: PERSON, presence: 'present' }],
    commitments: [{ speakerEntityId: PERSON, targetEntityIds: [], kind: 'promise', content: '在钟楼等到天亮', status: 'made', exactAnchorId: null }],
  });
  return selectorSource({ memories });
}

function rawReachableFromSource(source) {
  return {
    status: 'ready', rootRevision: source.rootRevision,
    root: { chatId: source.chatId, narrativeGeneration: source.narrativeGeneration, headCheckpointId: source.headCheckpointId },
    checkpoint: { id: source.headCheckpointId }, baseline: null,
    floors: source.floorMemories.map(memory => ({ id: memory.floorId, assistantSeq: memory.assistantSeq })),
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

function createRuntimeHarness({ sourceReader, selector = selectRecall, queryBuilder = buildRecallQueryContext, saveChat = true, reachableReader, snapshotHook, fingerprint, automationSettings, memoryStatus, historicalMaintenance, realtimeOrigin, notifyUser } = {}) {
  const prompts = [];
  const handlers = new Map();
  const userMessage = { is_user: true, is_system: false, mes: '阿裴，我们回钟楼赴约。' };
  const chat = [{ is_user: false, is_system: false, mes: '街上已经安静。' }, userMessage];
  const context = {
    chatMetadata: { qianqianjie: { chatId: CHAT } },
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
    store: { readReachable: reachableReader ?? (async () => rawReachableFromSource(source)) },
    hostAdapter,
    sourceReader: sourceReader ?? (async () => structuredClone(source)),
    selector,
    queryBuilder,
    ...(automationSettings ? { automationSettings } : {}),
    ...(memoryStatus ? { memoryStatus } : {}),
    ...(historicalMaintenance ? { historicalMaintenance } : {}),
    ...(realtimeOrigin ? { realtimeOrigin } : {}),
    ...(notifyUser ? { notifyUser } : {}),
    ...(fingerprint ? { fingerprint } : {}),
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
  assert.equal((await assessMemoryCoverageFromHost({ reachable: { ...base, floorMemories: [], stateDeltas: [] }, snapshot })).status, 'historicalDebt');
  const empty = { ...base, floors: floors.slice(0, 1), floorMemories: [], stateDeltas: [] };
  const oneStable = { ...snapshot, chat: chat.slice(0, 2) };
  assert.equal((await assessMemoryCoverageFromHost({ reachable: empty, snapshot: oneStable })).status, 'historicalDebt');
  assert.equal((await assessMemoryCoverageFromHost({ reachable: empty, snapshot: oneStable, realtimeOrigin: true })).status, 'realtimeTail');
});

test('历史维护门禁在正式 interceptor 前门禁同步 abort 主生成，quiet 不受影响', async () => {
  const notifications = [];
  let maintenance = true;
  let sourceReads = 0;
  const harness = createRuntimeHarness({
    historicalMaintenance: () => maintenance,
    notifyUser: value => notifications.push(value),
    sourceReader: async () => { sourceReads += 1; return runtimeFixture(); },
  });
  let aborted = false;
  let mainApiCalls = 0;
  await harness.runtime.intercept(harness.chat, 12000, value => { aborted = value === true; }, 'normal');
  if (!aborted) mainApiCalls += 1;
  assert.equal(aborted, true);
  assert.equal(mainApiCalls, 0);
  assert.equal(sourceReads, 0, '门禁必须先于召回读取和主 API 请求');
  assert.deepEqual(harness.runtime.getState().lastRecall.skipReasons, ['memoryRebuilding']);
  assert.deepEqual(notifications, [{ kind: 'warning', text: '历史记忆正在重建，请等待完成或先暂停重建。' }]);

  let quietAborted = false;
  await harness.runtime.intercept(harness.chat, 12000, value => { quietAborted = value === true; }, 'quiet');
  assert.equal(quietAborted, false);
  assert.deepEqual(harness.runtime.getState().lastRecall.skipReasons, ['quiet']);

  maintenance = false;
  let retryAborted = false;
  await harness.runtime.intercept(harness.chat, 12000, value => { retryAborted = value === true; }, 'normal');
  assert.equal(retryAborted, false);
  assert.equal(sourceReads, 1);
});

test('历史记忆未就绪时召回只记录明确门禁状态，零 prompt 注入且不阻断 interceptor 完成', async () => {
  for (const [memory, automation, expected] of [
    [{ activeAutoMemory: { phase: 'extracting' } }, true, ['memoryRebuilding']],
    [{ lastAutoMemory: { status: 'failed' } }, true, ['memoryNotReady', 'memoryRebuildFailed']],
    [null, false, ['memoryNotReady', 'historicalRebuildRequired']],
  ]) {
    let selectorCalls = 0;
    const source = { ...runtimeFixture(), readiness: { status: 'historicalDebt' } };
    const harness = createRuntimeHarness({
      sourceReader: async () => structuredClone(source),
      selector: input => { selectorCalls += 1; return selectRecall(input); },
      automationSettings: () => ({ enabled: automation }),
      memoryStatus: () => memory,
    });
    const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
    assert.equal(result.lastRecall.status, 'skipped');
    assert.deepEqual(result.lastRecall.skipReasons, expected);
    assert.equal(result.lastRecall.userMessageIndex, 1);
    assert.equal(selectorCalls, 0);
    assert.equal(harness.saves, 0);
    assert.ok(harness.prompts.every(call => call[1] === ''));
  }
});

test('受最近正文保护的连续实时尾部不会被历史门禁提前拦截', async () => {
  let selectorCalls = 0;
  const harness = createRuntimeHarness({
    sourceReader: async () => ({ ...runtimeFixture(), readiness: { status: 'realtimeTail' } }),
    automationSettings: () => ({ enabled: true }),
    memoryStatus: () => null,
    selector: () => { selectorCalls += 1; throw new Error('selector-reached'); },
  });
  const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(selectorCalls, 1);
  assert.equal(result.lastRecall.status, 'error');
  assert.deepEqual(result.lastRecall.skipReasons, ['error']);
});

test('runtime normal 先完成一次 prompt commit，再最多保存一次 completed user 收据且不产生 pending', async () => {
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
  assert.equal(RECALL_RECEIPT_SCHEMA_VERSION, 5, '双阶段 pending 协议退出后旧收据必须失效');
  assert.equal(receipt.schemaVersion, 5);
  assert.equal(receipt.chatId, CHAT);
  assert.equal(Object.hasOwn(receipt, 'headCheckpointId'), false);
  assert.equal(Object.hasOwn(receipt, 'rootRevision'), false);
  assert.equal(receipt.userMessageIndex, 1);
  assert.match(receipt.userContentFingerprint, /^sha256:/);
  assert.match(receipt.queryFingerprint, /^sha256:/);
  assert.match(receipt.receiptFingerprint, /^sha256:/);
  assert.equal(receipt.completionStatus, 'ready');
  assert.equal(Object.hasOwn(receipt, 'promptCommitted'), false);
  assert.deepEqual(receipt.selectedFloors.map(value => value.assistantSeq), [2]);
  assert.equal(result.lastRecall.reusedReceipt, false);
  assert.equal(result.lastRecall.receiptPersistence, 'persisted');
  assert.equal(result.lastRecall.stages.selected, 1);
  assert.equal(typeof result.lastRecall.timings.totalMs, 'number');
});

test('runtime completed-empty 是可持久化、可恢复的完成态，且不写非空 prompt', async () => {
  const harness = createRuntimeHarness({ selector: ({ source }) => ({
    status: 'empty', floors: [], states: [], coverage: source.coverage, injectionText: '',
    stages: { input: 1, candidates: 0, dropRecent: 0, dropPersistent: 0, dropVisibility: 0, selected: 0 },
    skipReasons: [],
  }) });
  const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(result.lastRecall.status, 'empty');
  assert.equal(result.lastRecall.receiptPersistence, 'persisted');
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
    let harness;
    harness = createRuntimeHarness({
      reachableReader: async () => {
        const value = rawReachableFromSource(harness.source);
        if (kind === 'chat') harness.context.chatMetadata.qianqianjie.chatId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
        if (kind === 'user') harness.userMessage.mes = '最终校验前已经换成另一条用户正文';
        if (kind === 'narrative') value.root.narrativeGeneration = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
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
  const sourceReader = ({ now }) => readRecallSource({ now, store: { readReachable: async () => structuredClone(initial) } });
  const harness = createRuntimeHarness({
    sourceReader,
    reachableReader: async () => structuredClone(changed),
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

test('runtime 刷新后从最新 user 楼恢复合法 schema5 completed 回执，仅作历史展示且不碰 prompt/save/source', async () => {
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
  assert.equal(result.lastRecall.receiptPersistence, 'persisted');
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
  assert.equal(sourceCalls, 1);

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
    if (armed && String(value).startsWith('[5,"0.2.27"')) {
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
    if (armed && String(value).startsWith('[5,"0.2.27"')) {
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
    if (armed && String(value).startsWith('[5,"0.2.27"')) {
      enteredDigest();
      await new Promise(resolve => { releaseDigest = resolve; });
    }
    return fingerprintText(value);
  };
  const harness = createRuntimeHarness({ fingerprint });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  const originalInjection = harness.userMessage.extra[RECALL_RECEIPT_KEY].injectionText;
  harness.chat.push({ is_user: false, is_system: false, mes: '生成后的 AI 正文。' });
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
  const harness = createRuntimeHarness({ sourceReader: async () => (++sourceCalls === 1 ? runtimeFixture() : pendingSource) });
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

test('runtime regenerate/swipe/continue 复用合法收据，不重新调用 selector 或重复持久化', async () => {
  let selectorCalls = 0;
  const harness = createRuntimeHarness({ selector: input => { selectorCalls += 1; return selectRecall(input); } });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  harness.chat.push({ is_user: false, is_system: false, mes: '本次生成出的 AI 正文，continue 时已在 user 楼之后。' });
  for (const type of ['regenerate', 'swipe', 'continue']) {
    const result = await harness.runtime.intercept(harness.chat, 12000, null, type);
    assert.equal(result.lastRecall.reusedReceipt, true, type);
    assert.equal(result.lastRecall.generationType, type);
  }
  assert.equal(selectorCalls, 1);
  assert.equal(harness.saves, 1);
  assert.equal(harness.prompts.filter(call => call[1]).length, 4);
});

test('runtime 内容或已选引用改变时拒绝旧收据，但 head/revision 正常推进仍复用', async () => {
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
  assert.equal(selectorCalls, 3, 'head/revision 正常推进但叙事和已选引用仍有效时必须复用');
  currentSource = { ...currentSource, floorMemories: currentSource.floorMemories.filter(value => value.assistantSeq !== 2) };
  await harness.runtime.intercept(harness.chat, 12000, null, 'swipe');
  assert.equal(selectorCalls, 4, '选中引用不再存在时必须重算');
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

test('runtime 对真实 sourceUnavailable/sourceStale 继续 fail-open，并保留读取次数诊断', async () => {
  for (const [status, reason] of [['unavailable', 'sourceUnavailable'], ['stale', 'sourceStale']]) {
    let selectorCalls = 0;
    const attempts = sourceAttempts(status === 'stale' ? 'stale' : 'unavailable');
    const harness = createRuntimeHarness({
      sourceReader: async () => ({ status, sourceReadAttempts: attempts }),
      selector: () => { selectorCalls += 1; throw new Error('不可执行 selector'); },
    });
    const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
    assert.deepEqual(result.lastRecall.skipReasons, [reason]);
    assert.deepEqual(result.lastRecall.timings.sourceReadAttempts, attempts);
    assert.equal(selectorCalls, 0);
    assert.equal(harness.saves, 0);
    assert.ok(harness.prompts.every(call => call[1] === ''));
  }
});

test('runtime source/selector 异常整体 fail-open，清旧注入并只暴露安全错误', async () => {
  let fail = false, abortCalls = 0;
  const harness = createRuntimeHarness({ sourceReader: async () => {
    if (fail) throw Object.assign(new Error('token=sk-secret-1234567890'), { code: 'SOURCE_FAILED' });
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
  assert.equal(abortCalls, 0);
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
  const harness = createRuntimeHarness({ sourceReader: async () => (++calls === 1 ? runtimeFixture() : inner) });
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

test('runtime 无 saveChat 时保留 session-only；新增 assistant 与 extra/隐藏变化不妨碍复用，旧正文变化才重算', async () => {
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
  assert.equal(result.lastRecall.reusedReceipt, false);
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

test('runtime 用 live 最小 frame 守卫克隆 coreChat：extra/隐藏与远期正文不取消，相关正文变化零注入', async () => {
  for (const change of ['metadataOnly', 'distantContent', 'relevantContent']) {
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
      harness.chat[2].is_hidden = true;
    } else if (change === 'distantContent') harness.chat[0].mes = '远期 assistant 正文已变化，但不影响本轮 query frame';
    else harness.chat[2].mes = '相关 assistant live 正文已变化';
    harness.handlers.get('message-edited')(harness.chat.length);
    if (change !== 'relevantContent') assert.equal(harness.runtime.getState().recallStatus, 'running');
    releaseSource(runtimeFixture());
    const result = await run;
    if (change !== 'relevantContent') {
      assert.equal(result.lastRecall.status, 'ready');
      assert.ok(harness.prompts.at(-1)[1]);
    } else {
      assert.equal(result.recallStatus, 'idle');
      assert.ok(harness.prompts.every(call => call[1] === ''));
    }
  }
});

test('runtime 成功落盘后释放完整 session 回执，只从 user 楼持久化回执复用', async () => {
  let selectorCalls = 0;
  const harness = createRuntimeHarness({ selector: input => { selectorCalls += 1; return selectRecall(input); } });
  await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  delete harness.userMessage.extra[RECALL_RECEIPT_KEY];
  const result = await harness.runtime.intercept(harness.chat, 12000, null, 'continue');
  assert.equal(result.lastRecall.reusedReceipt, false);
  assert.equal(selectorCalls, 2);
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
  let head = 'head', revision = 1;
  const source = runtimeFixture();
  source.headCheckpointId = head;
  source.rootRevision = revision;
  const harness = createRuntimeHarness({
    sourceReader: async () => {
      queueMicrotask(() => { head = 'head-after-source'; revision = 2; });
      return structuredClone(source);
    },
    reachableReader: async () => { const value = rawReachableFromSource(source); value.rootRevision = revision; value.root.headCheckpointId = head; value.checkpoint.id = head; return value; },
  });
  const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(result.lastRecall.status, 'ready');
  assert.ok(harness.prompts.at(-1)[1]);
  assert.equal(harness.saves, 1);
});

test('runtime 另一插件修改 assistant extra、隐藏状态并保存聊天时不误判当前 user 召回失效', async () => {
  let harness;
  harness = createRuntimeHarness({
    reachableReader: async () => {
      harness.chat[0].extra = { anotherPlugin: { refreshed: true } };
      harness.chat[0].is_hidden = true;
      return rawReachableFromSource(harness.source);
    },
  });
  const result = await harness.runtime.intercept(harness.chat, 12000, null, 'normal');
  assert.equal(result.lastRecall.status, 'ready');
  assert.equal(harness.saves, 1);
  assert.ok(harness.prompts.at(-1)[1]);
  assert.equal(harness.userMessage.extra[RECALL_RECEIPT_KEY].completionStatus, 'ready');
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
