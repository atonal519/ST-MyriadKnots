import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyArchiveV2, validateArchiveV2 } from '../src/archive-v2.js';
import {
  createArchiveV2MemoryBatch,
  createArchiveV2MemoryManifest,
  createArchiveV2MemorySnapshot,
  validateArchiveV2MemoryManifest,
} from '../src/archive-v2-memory-foundation.js';
import { createArchiveV2MemoryPeopleResult } from '../src/archive-v2-memory-people-foundation.js';
import { createArchiveV2MemoryBatchRecordId } from '../src/archive-v2-memory-store.js';
import {
  createArchiveV2BondBatches,
  createArchiveV2BondSourcePlan,
  extractArchiveV2NativeSignalCandidates,
  stableArchiveV2BondBoundary,
} from '../src/archive-v2-bond-sources.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const TIME = '2026-09-01T01:02:03.000Z';
const hash = digit => `sha256:${digit.repeat(64)}`;
const owned = (value, refs) => ({ value, origin: 'ai', sourceRefs: refs, userProtected: false });
const assistant = (content, extra = {}) => ({ is_user: false, is_system: false, mes: content, swipe_id: 0, swipes: [content], extra: {}, ...extra });

async function fixture({ persona = 'U 是谨慎但主动的调查员。' } = {}) {
  const stable = assistant('林少白在雨夜向用户坦白，陆离保持距离。', {
    is_hidden: true,
    variables: [
      { stat_data: { 关系轴: { 林少白: { 好感: 18, 阶段: '熟悉' }, 陆离: { 信任: 3 } }, 游戏: { 金币: 20 } } },
      { stat_data: { NPC: [{ 姓名: '林少白', 亲密: '上升' }] } },
    ],
  });
  const tail = assistant('最新尾楼：林少白又作出新的承诺。', { variables: [{ stat_data: { 关系轴: { 林少白: { 好感: 99 } } } }] });
  const context = {
    characterId: 0,
    characters: [{ avatar: 'char.png' }],
    userAvatar: 'me.png',
    chatId: 'host-chat',
    chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT } },
    powerUserSettings: { persona_description: persona },
    chat: [
      assistant('开场：林少白与用户初见。'),
      { is_user: true, mes: '用户回应。' },
      stable,
      { mes: '未知角色楼' },
      tail,
    ],
  };
  const snapshot = await createArchiveV2MemorySnapshot(context);
  const base = createArchiveV2MemoryManifest({ snapshot, scanId: 'scan-bonds', createdAt: TIME });
  const rows = {
    people: [
      { localId: 'P1', displayName: '林少白', aliases: [], sourceFloors: [0, 2, 4] },
      { localId: 'P2', displayName: '陆离', aliases: [], sourceFloors: [2] },
      { localId: 'PU', displayName: '调查员 U', aliases: [], sourceFloors: [0, 2, 4] },
    ],
    facts: [
      { subjectLocalId: 'P1', category: 'status', value: '尾楼前已坦白', sourceFloors: [2] },
      { subjectLocalId: 'P1', category: 'status', value: '仅尾楼新承诺', sourceFloors: [4] },
      { subjectLocalId: 'P1', category: 'status', value: '混合稳定与尾楼的整行摘要', sourceFloors: [2, 4] },
      { subjectLocalId: 'P2', category: 'personality', value: '谨慎', sourceFloors: [2] },
      { subjectLocalId: 'PU', category: 'status', value: '用户愿意倾听', sourceFloors: [2] },
      { subjectLocalId: 'PU', category: 'status', value: '用户尾楼改变主意', sourceFloors: [4] },
    ],
    relations: [
      { subjectLocalId: 'P1', objectKind: 'user', objectLocalId: null, category: 'bond', summary: '向用户坦白', sourceFloors: [2] },
      { subjectLocalId: 'P2', objectKind: 'user', objectLocalId: null, category: 'boundary', summary: '保持距离', sourceFloors: [2] },
    ],
    events: [
      { localId: 'E1', title: '雨夜坦白', summary: '林少白坦白', participantLocalIds: ['P1'], involvesUser: true, significance: 'major', sourceFloors: [2] },
      { localId: 'E2', title: '陆离独处', summary: '陆离整理装备', participantLocalIds: ['P2'], involvesUser: true, significance: 'supporting', sourceFloors: [2] },
      { localId: 'E3', title: '混合事件', summary: '尾楼修改过的整行事件', participantLocalIds: ['P1'], involvesUser: true, significance: 'major', sourceFloors: [2, 4] },
    ],
  };
  const batch = createArchiveV2MemoryBatch({ manifest: base, plan: snapshot.batches[0], rows, createdAt: TIME });
  const recordId = await createArchiveV2MemoryBatchRecordId({ scanId: base.scanId, batchIndex: 0, sourceFingerprint: batch.sourceFingerprint });
  const manifest = validateArchiveV2MemoryManifest({
    ...structuredClone(base),
    status: 'ready',
    completedBatchIndexes: [0],
    batchRefs: [{ batchIndex: 0, recordId, sourceFingerprint: batch.sourceFingerprint }],
  });
  const peopleResult = createArchiveV2MemoryPeopleResult({
    manifest,
    batches: [batch],
    createdAt: TIME,
    output: {
      people: [
        { localId: 'C1', displayName: '林少白', aliases: [], recognitionReason: '同一人物', sourcePeopleRefs: [{ batchIndex: 0, localId: 'P1' }], recommendation: 'romance_candidate', recommendationReason: '主线' },
        { localId: 'C2', displayName: '陆离', aliases: [], recognitionReason: '独立人物', sourcePeopleRefs: [{ batchIndex: 0, localId: 'P2' }], recommendation: 'important_supporting', recommendationReason: '配角' },
      ],
      userSourcePeopleRefs: [{ batchIndex: 0, localId: 'PU' }],
    },
  });
  const memoryRef = { kind: 'chat', locator: 'memory-batch:0', fingerprint: batch.sourceFingerprint };
  const archive = createEmptyArchiveV2({ chatId: CHAT, characterLocator: 'char.png', personaLocator: 'me.png' });
  archive.people = {
    order: [ID1, ID2],
    byId: {
      [ID1]: { identityId: ID1, followed: true, displayName: owned('林少白', [memoryRef]), aliases: owned([], [memoryRef]), fields: { personality: owned('冷静', [memoryRef]) }, sourceRefs: [memoryRef] },
      [ID2]: { identityId: ID2, followed: true, displayName: owned('陆离', [memoryRef]), aliases: owned([], [memoryRef]), fields: {}, sourceRefs: [memoryRef] },
    },
  };
  return { context, archive: validateArchiveV2(archive), manifest, batches: [batch], peopleResult };
}

test('稳定边界对齐 memory：普通与 /hide AI 保留，user/未知角色排除，最新有效 AI 为尾楼', async () => {
  const data = await fixture();
  const chat = [
    assistant('普通 AI'),
    assistant('/hide 后的 AI 正文', { is_system: true }),
    { is_user: true, is_system: false, mes: '用户楼' },
    { mes: '未知角色楼' },
    assistant('最新 AI 尾楼'),
  ];
  const boundary = stableArchiveV2BondBoundary(chat);
  assert.deepEqual(boundary.validAiFloors, [0, 1, 4]);
  assert.equal(boundary.stableFloor, 1);
  assert.equal(boundary.latestFloor, 4);
  assert.equal(boundary.stableMessage.is_system, true);

  const fixtureBoundary = stableArchiveV2BondBoundary(data.context.chat);
  assert.equal(fixtureBoundary.stableMessage.is_hidden, true);
});

test('来源按人物严格分配，事实/关系/事件不串人，任一证据楼越界就丢弃整行', async () => {
  const data = await fixture();
  const routeSources = [
    { kind: 'card', locator: 'card:char#description', fingerprint: hash('1'), content: '角色卡共同规则', selected: true, availability: 'card' },
    { kind: 'worldbook', locator: '主世界:1', fingerprint: hash('2'), content: '林少白专属规则', selected: true, availability: 'enabled' },
    { kind: 'worldbook', locator: '主世界:2', fingerprint: hash('3'), content: '已激活共同规则', selected: true, availability: 'activated' },
  ];
  const plan = await createArchiveV2BondSourcePlan({ ...data, raw: data.context, revision: 5, routeSources });
  assert.equal(plan.updatedThroughFloor, 2);
  assert.deepEqual(plan.people.map(person => person.displayName), ['林少白', '陆离']);
  const memory = plan.sources.filter(source => source.kind === 'memory');
  assert.equal(memory.length, 2);
  for (const source of memory) {
    assert.match(source.content, /用户愿意倾听/);
    assert.doesNotMatch(source.content, /仅尾楼新承诺|用户尾楼改变主意|混合稳定与尾楼|尾楼修改过的整行事件/);
    const parsed = JSON.parse(source.content);
    assert.deepEqual(parsed.userSourcePeopleRefs, [{ batchIndex: 0, localId: 'PU' }]);
    assert.ok(parsed.events[0].sourceFloors.every(floor => floor <= 2));
  }
  const linMemory = JSON.parse(memory.find(source => source.people.includes(ID1)).content);
  const luMemory = JSON.parse(memory.find(source => source.people.includes(ID2)).content);
  assert.deepEqual(linMemory.facts.filter(row => row.subjectLocalId !== 'PU').map(row => row.subjectLocalId), ['P1']);
  assert.deepEqual(luMemory.facts.filter(row => row.subjectLocalId !== 'PU').map(row => row.subjectLocalId), ['P2']);
  assert.deepEqual(linMemory.relations.map(row => row.subjectLocalId), ['P1']);
  assert.deepEqual(luMemory.relations.map(row => row.subjectLocalId), ['P2']);
  assert.deepEqual(linMemory.events.map(row => row.localId), ['E1']);
  assert.deepEqual(luMemory.events.map(row => row.localId), ['E2']);
  const onlyLin = plan.sources.find(source => source.locator === '主世界:1');
  assert.deepEqual(onlyLin.people, [ID1]);
  assert.equal(plan.sources.find(source => source.locator === '主世界:2').people.length, 2);
  assert.equal(plan.sources.some(source => source.kind === 'persona'), true);
  assert.equal(plan.sources.some(source => source.kind === 'profile'), true);
  assert.equal(plan.sources.some(source => source.kind === 'native'), true);
  const linSignal = plan.sources.find(source => source.kind === 'native' && source.signal.path.includes('林少白'));
  const luSignal = plan.sources.find(source => source.kind === 'native' && source.signal.path.includes('陆离'));
  assert.deepEqual(linSignal.people, [ID1]);
  assert.deepEqual(luSignal.people, [ID2]);
  assert.equal(plan.sources.some(source => source.kind === 'native' && source.signal.path.includes('游戏')), false);

  const batches = createArchiveV2BondBatches(plan);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].people.map(person => person.person), ['P1', 'P2']);
  assert.equal(batches[0].sources.find(source => source.locator === '主世界:1').people.join(','), 'P1');
});

test('Persona 描述可用或为空；空值正常降级且不制造伪来源', async () => {
  const withPersona = await fixture();
  const plan = await createArchiveV2BondSourcePlan({ ...withPersona, raw: withPersona.context, revision: 5 });
  assert.match(plan.sources.find(source => source.kind === 'persona').content, /调查员/);
  const empty = await fixture({ persona: '' });
  const emptyPlan = await createArchiveV2BondSourcePlan({ ...empty, raw: empty.context, revision: 5 });
  assert.equal(emptyPlan.sources.some(source => source.kind === 'persona'), false);
});

test('已有档案改名后仍稳定对应人物与原名世界书，双人共享别名不串源', async () => {
  const data = await fixture();
  data.archive.people.byId[ID1].displayName = {
    value: '用户改名林先生', origin: 'user', sourceRefs: [], userProtected: true,
  };
  data.archive.people.byId[ID1].aliases = {
    value: ['小白', '共同称呼'], origin: 'user', sourceRefs: [], userProtected: true,
  };
  data.archive.people.byId[ID2].aliases = {
    value: ['共同称呼'], origin: 'user', sourceRefs: [], userProtected: true,
  };
  const routeSources = [
    { kind: 'worldbook', locator: '原名规则', fingerprint: hash('4'), content: '林少白专属作者关系阶段规则', selected: true, availability: 'enabled' },
    { kind: 'worldbook', locator: '档案别名规则', fingerprint: hash('5'), content: '小白专属边界规则', selected: true, availability: 'enabled' },
    { kind: 'worldbook', locator: '共享别名规则', fingerprint: hash('6'), content: '共同称呼专属规则', selected: true, availability: 'enabled' },
    { kind: 'worldbook', locator: '陆离规则', fingerprint: hash('7'), content: '陆离专属作者规则', selected: true, availability: 'enabled' },
  ];
  const plan = await createArchiveV2BondSourcePlan({ ...data, raw: data.context, revision: 5, routeSources });
  assert.deepEqual(plan.people.map(person => [person.identityId, person.displayName]), [
    [ID1, '用户改名林先生'], [ID2, '陆离'],
  ]);
  const linMemory = JSON.parse(plan.sources.find(source => source.kind === 'memory' && source.people.includes(ID1)).content);
  assert.deepEqual(linMemory.cSourcePeopleRefs, [{ batchIndex: 0, localId: 'P1' }]);
  assert.deepEqual(plan.sources.find(source => source.locator === '原名规则').people, [ID1]);
  assert.deepEqual(plan.sources.find(source => source.locator === '档案别名规则').people, [ID1]);
  assert.equal(plan.sources.some(source => source.locator === '共享别名规则'), false);
  assert.deepEqual(plan.sources.find(source => source.locator === '陆离规则').people, [ID2]);
});

test('多人原生变量用 NPC 同子树姓名/别名归属，无法归属的纯游戏变量丢弃；单人时保留未归属候选', async () => {
  const data = await fixture();
  data.context.chat[2].variables = [{ stat_data: {
    NPC: [
      { '姓名': '林少白', '亲密': '上升' },
      { name: '陆离', '信任': 7 },
      { '姓名': '陌生NPC', '亲密': 10 },
    ],
    '游戏': { '金币': 99 },
  } }];
  const plan = await createArchiveV2BondSourcePlan({ ...data, raw: data.context, revision: 5 });
  const natives = plan.sources.filter(source => source.kind === 'native');
  assert.deepEqual(natives.find(source => source.signal.path.includes('亲密')).people, [ID1]);
  assert.deepEqual(natives.find(source => source.signal.path.includes('信任')).people, [ID2]);
  assert.equal(natives.some(source => source.signal.path.includes('金币')), false);

  data.archive.people.order = [ID1];
  delete data.archive.people.byId[ID2];
  const single = await createArchiveV2BondSourcePlan({ ...data, raw: data.context, revision: 5 });
  assert.deepEqual(single.sources.find(source => source.kind === 'native' && source.signal.path.includes('金币')).people, [ID1]);
  assert.equal(single.sources.some(source => source.kind === 'native' && source.signal.ownerNames.includes('陌生NPC')), false);
  assert.equal(single.sources.some(source => source.kind === 'native' && source.signal.path.includes('NPC[2]')), false);
});

test('原生变量支持单轴、多轴、NPC 子树、纯游戏变量和无变量；深度/叶子/总 visited+queued 节点均有硬上限', async () => {
  const one = assistant('稳定楼', { variables: [{ stat_data: { 好感: 8 } }] });
  assert.deepEqual((await extractArchiveV2NativeSignalCandidates(one, 3)).map(item => [item.path, item.value]), [['variables[0].stat_data["好感"]', 8]]);
  const many = assistant('稳定楼', { variables: [
    { stat_data: { 好感: 8, 信任: 2 } },
    { stat_data: { NPC: [{ 姓名: '甲', 关系: '盟友' }], 游戏: { 金币: 10 } } },
  ] });
  const candidates = await extractArchiveV2NativeSignalCandidates(many, 3);
  assert.ok(candidates.some(item => item.path.includes('信任')));
  assert.ok(candidates.some(item => item.path.includes('NPC') && item.path.includes('[0]') && item.path.includes('关系')));
  assert.ok(candidates.some(item => item.path.includes('游戏') && item.path.includes('金币')));
  assert.deepEqual(await extractArchiveV2NativeSignalCandidates(assistant('无变量'), 3), []);

  let deep = { leaf: '过深' };
  for (let index = 0; index < 20; index += 1) deep = { next: deep };
  const wide = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`k${index}`, index]));
  const limited = await extractArchiveV2NativeSignalCandidates(assistant('异常', { variables: [{ stat_data: { deep, wide } }] }), 3);
  assert.ok(limited.length <= 120);
  assert.equal(limited.some(item => item.value === '过深'), false);

  let inspectedObjects = 0;
  const keys = Array.from({ length: 80 }, (_, index) => `b${index}`);
  const tree = depth => new Proxy({}, {
    ownKeys() { inspectedObjects += 1; return keys; },
    getOwnPropertyDescriptor(_target, key) {
      return { enumerable: true, configurable: true, value: depth === 0 ? Number(key.slice(1)) : tree(depth - 1) };
    },
  });
  await extractArchiveV2NativeSignalCandidates(assistant('多层宽树', { variables: [{ stat_data: tree(3) }] }), 3);
  assert.ok(inspectedObjects <= 800, `遍历对象数超限: ${inspectedObjects}`);
});
