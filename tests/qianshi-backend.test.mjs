import test from 'node:test';
import assert from 'node:assert/strict';
import { compileQianshiDelta, createQianshiCandidateIndex, prepareQianshiCandidates, prepareQianshiRecallCandidates, projectQianshiCandidateSelection, projectQianshiGraph, projectQianshiRecall, projectQianshiTimeline, publicQianshiSnapshot } from '../src/v3/qianshi-domain.js';
import { projectTime } from '../src/v3/time-engine.js';
import { createExtractorEnvelope, runExtractorRequest } from '../src/v3/extractor.js';
import { createPublicQianshiBridge } from '../src/v3/public-qianshi-bridge.js';
import { validateQianshiDelta } from '../src/v3/qianshi-schema.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GENERATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = '2026-09-16T00:00:00.000Z';
const floor = (id, assistantSeq) => ({ id, chatId: CHAT, narrativeGeneration: GENERATION, assistantSeq, hostLocator: { messageIndex: assistantSeq * 2 }, content: { canonicalContent: `第${assistantSeq}楼` } });
const memory = (id, source, qianshiDelta) => ({ id, floorId: source.id, recordStatus: 'active', chronology: [], qianshiDelta });

test('同一稳定人物在单个事件只建一条参与边，跨事件仍分别建边', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const personId = '22222222-2222-4222-8222-222222222222';
  const entity = { id: personId, entityType: 'person', displayName: '裴晚生', aliases: [{ name: '阿裴' }], specialRole: 'char',
    recordStatus: 'active', status: 'established', chatId: CHAT, narrativeGeneration: GENERATION };
  const packet = { qianshi: { events: [
    { key: 'arrive', title: '抵达会场', description: '裴晚生以阿裴之名赴会', status: 'occurred', matter: false, people: ['裴晚生', '阿裴'] },
    { key: 'leave', title: '离开会场', description: '阿裴独自离开', status: 'occurred', matter: false, people: ['阿裴'] },
  ], order: [] } };
  const originalPacket = structuredClone(packet);
  const delta = await compileQianshiDelta({ floor: source, now: NOW, entities: [entity], packet });
  assert.deepEqual(packet, originalPacket, '编译不改写输入 people');
  assert.deepEqual(delta.events[0].people, [{ entityId: personId, name: '裴晚生' }, { entityId: personId, name: '阿裴' }], '原始本名和别名都保留');
  const reachable = { root: { narrativeGeneration: GENERATION, headCheckpointId: '33333333-3333-4333-8333-333333333333' }, rootRevision: 1,
    floors: [source], floorMemories: [memory('44444444-4444-4444-8444-444444444444', source, delta)], entities: [entity] };
  const projection = projectQianshiGraph(reachable);
  assert.equal(projection.graph.filterEdges((_edge, attributes) => attributes.type === 'participates').length, 2);
  assert.deepEqual(projection.events[0].people, delta.events[0].people, '图投影不改写事件 people');
  assert.doesNotThrow(() => prepareQianshiCandidates(reachable, { canonicalContent: '继续会场剧情' }));
});

test('合法旧数据的 null 同名参与者去重，不同实体的同名参与者不合并', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const base = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'watch', title: '共同观看', description: '众人同时看向钟楼', status: 'occurred', matter: false },
  ], order: [] } } });
  const firstId = '22222222-2222-4222-8222-222222222222';
  const secondId = '33333333-3333-4333-8333-333333333333';
  const people = [{ entityId: null, name: '路人' }, { entityId: null, name: '路人' },
    { entityId: firstId, name: '守卫' }, { entityId: secondId, name: '守卫' }];
  const oldDataInput = { ...structuredClone(base), events: [{ ...structuredClone(base.events[0]), people }] };
  const originalInput = structuredClone(oldDataInput);
  const oldData = validateQianshiDelta(oldDataInput, { floorId: source.id });
  const reachable = { root: { narrativeGeneration: GENERATION, headCheckpointId: '44444444-4444-4444-8444-444444444444' }, rootRevision: 1,
    floors: [source], floorMemories: [memory('55555555-5555-4555-8555-555555555555', source, oldData)], entities: [] };
  const projection = projectQianshiGraph(reachable);
  const participationEdges = projection.graph.filterEdges((_edge, attributes) => attributes.type === 'participates');
  assert.equal(participationEdges.length, 3, 'null 同名合一，两个实体 ID 各自保留');
  assert.ok(projection.graph.hasEdge(`participates:${firstId}:${oldData.events[0].id}`));
  assert.ok(projection.graph.hasEdge(`participates:${secondId}:${oldData.events[0].id}`));
  assert.deepEqual(projection.events[0].people, people);
  assert.deepEqual(oldDataInput, originalInput, '校验和图投影均不改写旧事件输入');
});

test('跨楼重复关系按确定性 ID 合并且关系端点冲突拒绝投影', async () => {
  const floors = [1, 2, 3].map((value, index) => floor(`${String(value).repeat(8)}-${String(value).repeat(4)}-4${String(value).repeat(3)}-8${String(value).repeat(3)}-${String(value).repeat(12)}`, index + 1));
  const first = await compileQianshiDelta({ floor: floors[0], now: NOW, packet: { qianshi: { events: [
    { key: 'a', title: '事项甲', description: '事项甲', status: 'planned', matter: true },
    { key: 'b', title: '事项乙', description: '事项乙', status: 'planned', matter: true },
  ], order: [] } } });
  const [a, b] = first.events;
  const relationId = '55555555-5555-4555-8555-555555555555';
  const base = (source, event, relations) => validateQianshiDelta({ schemaVersion: 1, status: 'ready', reason: null, compiledAt: NOW,
    candidateStats: { count: 0, characters: 0 }, events: [event], relations }, { floorId: source.id });
  const event = (source, id, title) => ({ id, matterId: null, updatesMatter: false, title, description: title, status: 'occurred', storyTime: null, scheduledTime: null, people: [], object: null, sourceFloorId: source.id, continuesFromEventIds: [] });
  const repeatedStrong = { id: relationId, type: 'before', fromEventId: a.id, toEventId: b.id, certainty: 'strong' };
  const repeatedExplicit = { ...repeatedStrong, certainty: 'explicit' };
  const deltas = [first,
    base(floors[1], event(floors[1], '77777777-7777-4777-8777-777777777777', '旁支一'), [repeatedStrong]),
    base(floors[2], event(floors[2], '88888888-8888-4888-8888-888888888888', '旁支二'), [repeatedExplicit])];
  const reachable = { floors, floorMemories: deltas.map((delta, index) => memory(`aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${index}`, floors[index], delta)), entities: [] };
  const projection = projectQianshiGraph(reachable);
  assert.deepEqual(projection.relations.map(item => [item.id, item.certainty]), [[relationId, 'explicit']]);
  assert.equal(projection.graph.filterEdges((_edge, attributes) => attributes.type === 'before').length, 1);

  const conflicting = { ...repeatedExplicit, fromEventId: b.id, toEventId: a.id };
  reachable.floorMemories[2] = memory('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', floors[2], base(floors[2], event(floors[2], '88888888-8888-4888-8888-888888888888', '旁支二'), [conflicting]));
  assert.throws(() => projectQianshiGraph(reachable), error => error?.code === 'QIANSHI_RELATION_ID_CONFLICT');
});

test('一次性日常事件保持为独立事件，计划才建立事项', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'drink', title: '喝水', description: '喝了一杯水', status: 'occurred', matter: false },
    { key: 'meet', title: '钟楼会面', description: '约好明晚在钟楼会面', status: 'planned', matter: true, scheduledTime: '明晚' },
  ], order: [] } } });
  assert.equal(delta.status, 'ready');
  assert.deepEqual(delta.events.map(event => [event.matterId === null, event.updatesMatter]), [[true, false], [false, true]]);
  const projection = projectQianshiGraph({ root: { narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 1,
    floors: [source], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', source, delta)], entities: [] });
  assert.equal(projection.events.length, 2);
  assert.equal(projection.matters.length, 1);
  assert.match(projection.currentProgress.text, /钟楼会面/u);
  assert.doesNotMatch(projection.currentProgress.text, /喝水/u);
  const snapshot = publicQianshiSnapshot({ root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 1,
    floors: [source], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', source, delta)], entities: [] });
  assert.equal(snapshot.events[0].sourceMessageIndex, 2, '来源楼号沿用现有 hostLocator.messageIndex 显示惯例，不自行加一');
  assert.equal(snapshot.timeline.undatedEventIds.length, 2);
});

test('progress 不能把一次性旧事件升级成事项，context 与先后端点仍可引用旧事件', async () => {
  const first = floor('11111111-1111-4111-8111-111111111111', 73);
  const second = floor('22222222-2222-4222-8222-222222222222', 74);
  const oneOff = await compileQianshiDelta({ floor: first, now: NOW, packet: { qianshi: { events: [
    { key: 'fact', title: '收到旧信', description: '收到一封旧信', status: 'occurred', matter: false },
  ], order: [] } } });
  const prior = oneOff.events[0];
  const candidate = { key: 'candidate-1', matterId: prior.matterId, latestEventIds: [prior.id], latestStoryTime: null };
  const invalid = await compileQianshiDelta({ floor: second, now: NOW, candidateBindings: [candidate], packet: { qianshi: { events: [
    { key: 'followup', title: '旧信后续', description: '又提到那封旧信', status: 'occurred', links: [{ candidateKey: candidate.key, kind: 'progress' }] },
  ], order: [] } } });
  assert.equal(invalid.status, 'partial');
  assert.equal(invalid.events[0].matterId, null);
  assert.equal(invalid.events[0].updatesMatter, false);
  assert.deepEqual(invalid.events[0].continuesFromEventIds, []);
  assert.match(invalid.reason, /将一次性事件当作持续事项的进展.{1}应改为背景关联或补充先后顺序/u);

  const context = await compileQianshiDelta({ floor: second, now: NOW, candidateBindings: [candidate], packet: { qianshi: { events: [
    { key: 'context', title: '旧信补充', description: '补充说明那封旧信的来源', status: 'occurred', links: [{ candidateKey: candidate.key, kind: 'context' }] },
  ], order: [{ before: candidate.key, after: 'context' }] } } });
  assert.equal(context.status, 'ready');
  assert.equal(context.events[0].matterId, null);
  assert.equal(context.events[0].updatesMatter, false);
  assert.deepEqual(context.events[0].continuesFromEventIds, [prior.id]);
  assert.deepEqual(context.relations.map(relation => [relation.type, relation.fromEventId, relation.toEventId]), [['before', prior.id, context.events[0].id]]);
});

test('历史编译把事件校验路径转成中文楼内原因，不泄露 events 索引', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 75);
  const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'same', title: '原事件', description: '原事件正文', status: 'occurred' },
    { key: 'same', title: '重复标识事件', description: '重复标识正文', status: 'occurred' },
    { key: 'missing-copy', title: '', description: '缺少标题', status: 'occurred' },
  ], order: [] } } });
  assert.equal(delta.status, 'partial');
  assert.match(delta.reason, /第 2 件事件的内部标识与前面重复/u);
  assert.match(delta.reason, /第 3 件事件缺少有效标题或说明/u);
  assert.doesNotMatch(delta.reason, /QIANSHI_|events\[|progress|context|partial/u);
});

test('历史候选池能绑定旧的一次性事件供 context 使用，但拒绝将其当作 progress', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 73);
  const next = floor('22222222-2222-4222-8222-222222222222', 74);
  const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'fact', title: '收到旧信', description: '顾舟收到旧信并保存', status: 'occurred', matter: false },
  ], order: [] } } });
  const reachable = { floors: [source], floorMemories: [memory('33333333-3333-4333-8333-333333333333', source, delta)], entities: [] };
  const candidates = prepareQianshiCandidates(reachable, { canonicalContent: '顾舟收到旧信后续说明', includeEventContextCandidates: true });
  assert.equal(candidates.request[0].candidateType, 'event');
  assert.equal(candidates.bindings[0].matterId, null);
  const candidateKey = candidates.request[0].key;
  const context = await compileQianshiDelta({ floor: next, now: NOW, candidateBindings: candidates.bindings, packet: { qianshi: { events: [
    { key: 'context', title: '旧信补证', description: '补充顾舟收到旧信的来源', status: 'occurred', links: [{ candidateKey, kind: 'context' }] },
  ], order: [] } } });
  assert.equal(context.status, 'ready');
  assert.equal(context.events[0].continuesFromEventIds[0], delta.events[0].id);
  const progress = await compileQianshiDelta({ floor: next, now: NOW, candidateBindings: candidates.bindings, packet: { qianshi: { events: [
    { key: 'progress', title: '旧信进展', description: '把收到旧信视作持续事项进展', status: 'occurred', links: [{ candidateKey, kind: 'progress' }] },
  ], order: [] } } });
  assert.equal(progress.status, 'partial');
  assert.equal(progress.events[0].matterId, null);
  assert.equal(progress.events[0].updatesMatter, false);
});

test('新千事忽略重要输入，旧存档字段仍可读但不进入派生图或公开快照', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const baseEvent = { key: 'promise', title: '约定共同生活', description: '两人决定从此共同生活', status: 'planned', matter: true, storyTime: '2026-09-16' };
  const compile = important => compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    important === undefined ? { ...baseEvent } : { ...baseEvent, important },
  ], order: [] } } });
  const marked = await compile(true), rejected = await compile('true'), unmarked = await compile(false), omitted = await compile(undefined);
  for (const delta of [marked, rejected, unmarked, omitted]) assert.equal(Object.hasOwn(delta.events[0], 'important'), false);
  assert.deepEqual(new Set([marked.events[0].id, rejected.events[0].id, unmarked.events[0].id, omitted.events[0].id]).size, 1);

  const reachable = delta => ({ root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 1,
    floors: [source], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', source, delta)], entities: [] });
  assert.deepEqual(prepareQianshiCandidates(reachable(marked), { canonicalContent: '共同生活的约定' }), prepareQianshiCandidates(reachable(unmarked), { canonicalContent: '共同生活的约定' }));
  assert.deepEqual(prepareQianshiRecallCandidates(reachable(marked), { queryContext: { text: '共同生活', latestUserText: '共同生活' } }), prepareQianshiRecallCandidates(reachable(unmarked), { queryContext: { text: '共同生活', latestUserText: '共同生活' } }));
  assert.deepEqual(projectQianshiRecall(reachable(marked), { queryContext: { text: '共同生活', latestUserText: '共同生活' } }), projectQianshiRecall(reachable(unmarked), { queryContext: { text: '共同生活', latestUserText: '共同生活' } }));

  const oldStored = structuredClone(marked);
  oldStored.events[0].important = true;
  const validatedOld = validateQianshiDelta(oldStored, { floorId: source.id });
  assert.equal(validatedOld.events[0].important, true, '旧FM/schema继续接受optional boolean');
  assert.throws(() => validateQianshiDelta({ ...structuredClone(oldStored), events: [{ ...structuredClone(oldStored.events[0]), important: 'yes' }] }, { floorId: source.id }), /important/u);
  const oldProjection = projectQianshiGraph(reachable(validatedOld));
  assert.equal(Object.hasOwn(oldProjection.events[0], 'important'), false);
  assert.equal(Object.hasOwn(publicQianshiSnapshot(reachable(validatedOld)).events[0], 'important'), false);
});

test('完整前端年表一次提取排序键，可靠跨月与同日分钟优先，异历和未知时间不强排', () => {
  const event = (id, storyTime, parsedStoryTime = projectTime(storyTime)) => ({ id, storyTime, parsedStoryTime });
  const events = [
    event('aug', '大陆历1686年8月5日凌晨'),
    event('july-late', '1686-07-29 16:00'),
    event('july-early', '大陆历1686年7月29日14:15'),
    event('other-era', '星海历1687年7月1日'),
    event('unknown', '苍月祭后'),
    event('era-source', '纪元年10月4日', { ...projectTime('纪1年10月4日'), raw: '纪元年10月4日' }),
    event('era-source-next', '纪元年10月5日', { ...projectTime('纪1年10月5日'), raw: '纪元年10月5日' }),
    event('named-era-source', '星辉历纪元年霜月初四', { ...projectTime('纪1年10月4日'), raw: '星辉历纪元年霜月初四' }),
    event('bare-year-source', '3053年10月4日'),
  ];
  const timeline = projectQianshiTimeline({ events, relations: [{ type: 'progress', fromEventId: 'aug', toEventId: 'july-late' }] });
  assert.deepEqual(timeline.segments[0].groups.flatMap(group => group.eventIds), ['july-early', 'july-late', 'aug'], '可靠发生日期不能被反向 progress 或来源顺序压住');
  assert.equal(timeline.segments.length, 5, '不同明确纪年保持分段，裸数字保留原有独立分段');
  assert.deepEqual(timeline.segments.map(segment => segment.label), ['大陆历', '星海历', '年份已知，历法未注明', '纪元10月', '星辉历纪元霜月'],
    '可解析出年份的裸年份段排在未解析出年份的具名月份段前');
  assert.match(timeline.segments[0].groups[0].period, /大陆历1686年7月/u, '月份标题保留可读历法名');
  assert.equal(timeline.segments[0].groups[0].day, '29日', '主标签只显示日，年份和时分保留在 full');
  assert.equal(timeline.segments[0].groups[0].full, '1686-07-29 16:00', '详情原文保留完整日期和时分');
  assert.ok(timeline.segments[2].groups.some(group => group.day === '4日'), '裸数字年表也只显示日');
  assert.equal(timeline.hasGlobalLatest, false, '不可比历法不伪造全局最近');
  assert.deepEqual(timeline.undatedEventIds, ['unknown']);
  const eraMonth = timeline.segments[3].groups.find(group => group.eventIds.includes('era-source'));
  assert.deepEqual(timeline.segments[3].groups.flatMap(group => group.eventIds), ['era-source', 'era-source-next'], '旧纪1年派生字段不得覆盖原文身份，仍按原历法同月排序');
  assert.equal(eraMonth.day, '4日', '具名历法沿用投影得到的月日');
  assert.equal(eraMonth.full, '纪元年10月4日', '具名纪年的完整原文仍保留');
});

test('千事年表按真实成员楼和事件绝对时间投影，聚合 null/相对时间不借锚钟', async () => {
  const first = floor('11111111-1111-4111-8111-111111111111', 1);
  const anchor = floor('22222222-2222-4222-8222-222222222222', 2);
  const candidate = { key: 'old', matterId: '33333333-3333-4333-8333-333333333333', latestEventIds: [], latestStoryTime: '995-01-01' };
  const delta = await compileQianshiDelta({ floor: anchor, sourceFloorBindings: [
    { floorKey: 'floor-1', floorId: first.id }, { floorKey: 'floor-2', floorId: anchor.id },
  ], candidateBindings: [candidate], now: NOW, packet: { qianshi: { events: [
    { key: 'null-time', sourceFloorKey: 'floor-1', title: '无时间事件', description: '前楼没有事件级日期', status: 'occurred', matter: false },
    { key: 'relative-time', sourceFloorKey: 'floor-1', title: '相对事件', description: '前楼只写次日', status: 'occurred', matter: false, storyTime: '次日' },
    { key: 'old-year', sourceFloorKey: 'floor-1', title: '早年事件', description: '绝对日期早于候选事项', status: 'planned', matter: true, storyTime: '994年2月28日', links: [{ candidateKey: 'old', kind: 'progress' }] },
    { key: 'new-year', sourceFloorKey: 'floor-2', title: '晚年事件', description: '末楼的明确日期', status: 'occurred', matter: false, storyTime: '2205-03-01' },
    { key: 'old-plan', sourceFloorKey: 'floor-1', title: '共同待办', description: '共同待办的相同材料', status: 'planned', matter: true, storyTime: '994-03-02' },
    { key: 'new-plan', sourceFloorKey: 'floor-2', title: '共同待办', description: '共同待办的相同材料', status: 'planned', matter: true, storyTime: '994-03-02' },
  ], order: [] } } });
  assert.equal(delta.events[2].updatesMatter, true, '提取编译沿用旧短年份解释，显示解析在投影层单独处理');
  assert.equal(delta.events[2].matterId, candidate.matterId, '倒叙补证仍关联旧事项');

  const aggregateMemory = { ...memory('44444444-4444-4444-8444-444444444444', anchor, delta), sourceFloorIds: [first.id, anchor.id],
    chronology: [{ time: { normalized: '2205-03-01' } }] };
  const reachable = { root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: '55555555-5555-4555-8555-555555555555' }, rootRevision: 1,
    floors: [first, anchor], floorMemories: [aggregateMemory], entities: [] };
  const cold = projectQianshiGraph(reachable);
  assert.deepEqual(Object.fromEntries(delta.events.map(raw => [raw.id, cold.events.find(event => event.id === raw.id)?.assistantSeq])), {
    [delta.events[0].id]: 1, [delta.events[1].id]: 1, [delta.events[2].id]: 1,
    [delta.events[3].id]: 2, [delta.events[4].id]: 1, [delta.events[5].id]: 2,
  }, '聚合事件按来源成员楼取得真实楼序');
  assert.equal(cold.events[0].parsedStoryTime.date, null, 'null 不借聚合锚楼的完整 chronology');
  assert.equal(cold.events[1].parsedStoryTime.date, null, '相对时间不借锚钟推成绝对日期');
  const timeline = projectQianshiTimeline(cold);
  assert.deepEqual(timeline.undatedEventIds, [delta.events[0].id, delta.events[1].id]);
  assert.equal(timeline.segments.find(segment => segment.groups.some(group => group.eventIds.includes(delta.events[2].id))).id, 'bare');
  assert.equal(timeline.segments.find(segment => segment.groups.some(group => group.eventIds.includes(delta.events[3].id))).id, 'bare');

  const index = createQianshiCandidateIndex();
  const prefix = { ...reachable, floorMemories: [] };
  index.prepare(prefix, { canonicalContent: '早年事件' });
  const hot = index.prepare(reachable, { canonicalContent: '早年事件' });
  assert.deepEqual(hot, prepareQianshiCandidates(reachable, { canonicalContent: '早年事件' }), '热追加和冷投影的来源序及候选排序一致');
  const orderedCandidates = index.prepare(reachable, { canonicalContent: '共同待办' });
  assert.deepEqual(orderedCandidates.request.map(item => item.latestProgress.sourceAssistantSeq), [2, 1, 1], '热追加按成员楼序排列候选，并保留旧编译语义纳入的单楼进展');
  const missingMember = structuredClone(aggregateMemory);
  missingMember.qianshiDelta.events[0].sourceFloorId = '66666666-6666-4666-8666-666666666666';
  const missingProjection = projectQianshiGraph({ ...reachable, floorMemories: [missingMember] });
  assert.equal(missingProjection.events[0].assistantSeq, null, '来源成员楼缺失时不猜用锚楼楼序');
});

test('普通单楼倒叙判断保留旧的短年份解释', async () => {
  const source = floor('77777777-7777-4777-8777-777777777777', 1);
  const candidate = { key: 'current', matterId: '88888888-8888-4888-8888-888888888888', latestEventIds: [], latestStoryTime: '995-01-01' };
  const delta = await compileQianshiDelta({ floor: source, candidateBindings: [candidate], now: NOW, packet: { qianshi: { events: [
    { key: 'earlier', title: '较早日期补证', description: '普通单楼沿用既有时间解释', status: 'inProgress', matter: true,
      storyTime: '994-12-31', links: [{ candidateKey: 'current', kind: 'progress' }] },
  ], order: [] } } });
  assert.equal(delta.events[0].updatesMatter, true, '未启用短年份推演，事件继续推进事项');
  assert.equal(delta.events[0].matterId, candidate.matterId);
});

test('千事 opt-in 识别一至四位年份并拒绝非法日期，默认共享时间解析保持原样', () => {
  const events = ['994年2月28日', '994-03-01', '099-02-28', '099-02-29', '2024-02-29', '2023-02-29', '994-02-30', '400-02-29']
    .map((storyTime, index) => ({ id: `date-${index}`, storyTime }));
  const timeline = projectQianshiTimeline({ events, relations: [] });
  const segmentFor = id => timeline.segments.find(segment => segment.groups.some(group => group.eventIds.includes(id)))?.id ?? null;
  assert.equal(segmentFor('date-0'), 'bare');
  assert.equal(segmentFor('date-1'), 'bare');
  assert.equal(segmentFor('date-2'), 'bare');
  assert.equal(segmentFor('date-4'), 'bare');
  assert.equal(segmentFor('date-7'), 'bare', '400 年按公历闰年规则接受二月二十九日');
  assert.deepEqual(timeline.undatedEventIds, ['date-3', 'date-5', 'date-6'], '非法显式日期不会退化成无年同月日');
  assert.equal(projectTime('994年2月28日').year, null, '共享时间推演默认仍不把三位数字改判为年份');
  assert.equal(projectTime('公历2024年2月29日').date, '2024-02-29', '具名公历和闰年合同不变');
});

test('千事日期主标签压缩至月日，保留无年份旧数据、详情原文和相对日期投影', () => {
  const timeline = projectQianshiTimeline({ events: [
    { id: 'long-dated', storyTime: '大陆历1686年9月23日 21:45' },
    { id: 'legacy-yearless', storyTime: '9月22日 20:30' },
    { id: 'anchored-relative', storyTime: '次日', parsedStoryTime: projectTime('次日', projectTime('2026-05-10')) },
  ], relations: [] });
  assert.deepEqual(timeline.undatedEventIds, []);
  const groups = timeline.segments.flatMap(segment => segment.groups);
  const longDated = groups.find(group => group.eventIds.includes('long-dated'));
  assert.equal(longDated.day, '23日');
  assert.equal(longDated.full, '大陆历1686年9月23日 21:45');
  const legacy = groups.find(group => group.eventIds.includes('legacy-yearless'));
  assert.equal(legacy.day, '22日', '无年份旧存档仍由已有投影取出月日');
  assert.equal(legacy.full, '9月22日 20:30', '无年份旧存档的完整详情不丢时分');
  const relative = groups.find(group => group.eventIds.includes('anchored-relative'));
  assert.equal(relative.day, '11日', '相对日期沿用已锚定投影的日');
  assert.equal(relative.full, '2026-05-11', '相对日期的详情仍显示既有投影结果');
});

test('千事时间轴按发生时间排序、保留秒并隔离无年/未锚时间', () => {
  const event = (id, storyTime, parsedStoryTime = projectTime(storyTime), scheduledTime = null) => ({ id, storyTime, parsedStoryTime, scheduledTime });
  const events = [
    event('yearless-nov-late', '11月3日 12:34:56', undefined, '公历1900年1月1日'),
    event('gregorian-latest', '公历2010年11月3日 12:34:56'),
    event('gregorian-earliest', '公历2009年1月2日'),
    event('yearless-oct', '10月1日 23:00'),
    event('gregorian-second-early', '公历2010年11月3日 12:34:05'),
    event('yearless-nov-early', '11月3日 12:34:05'),
    event('unanchored-relative', '明日 08:00'),
    event('scheduled-only', null, undefined, '公历2099年12月31日 23:59:59'),
  ];
  const timeline = projectQianshiTimeline({ events, relations: [] });
  const byId = id => timeline.segments.find(segment => segment.groups.some(group => group.eventIds.includes(id)));
  assert.deepEqual(byId('gregorian-latest').groups.flatMap(group => group.eventIds), [
    'gregorian-earliest', 'gregorian-second-early', 'gregorian-latest',
  ], '跨年及同一分钟不同秒按完整发生时间递增');
  assert.equal(byId('yearless-nov-late').id, 'yearless');
  assert.deepEqual(byId('yearless-nov-late').groups.flatMap(group => group.eventIds), [
    'yearless-oct', 'yearless-nov-early', 'yearless-nov-late',
  ], '无年十一月整体晚于十月，且秒参与排序');
  assert.notEqual(byId('yearless-nov-late').id, byId('gregorian-latest').id, '无年与完整年份分别展示');
  assert.equal(byId('yearless-nov-late').label, '年份未明');
  assert.equal(timeline.undatedEventIds.includes('unanchored-relative'), true, '未锚定相对时间不排入精确时间轴');
  assert.equal(timeline.undatedEventIds.includes('scheduled-only'), true, 'scheduledTime不充当发生时间');
  assert.equal(timeline.hasGlobalLatest, false, '存在不可比区域时不声明唯一全局最近');
  assert.equal(timeline.segments.find(segment => segment.id === 'gregorian').groups.find(group => group.eventIds.includes('gregorian-latest')).full,
    '公历2010年11月3日 12:34:56', '展示保留原始秒');
});

test('千事时间范围按可识别的左侧起点入轴，整段原文继续展示', () => {
  const events = [
    { id: 'iso-range', storyTime: '2025-01-01 - 2025-01-02' },
    { id: 'year-day-range', storyTime: '2025年1月2日-3日' },
    { id: 'yearless-day-range', storyTime: '10月1日-3日' },
    { id: 'year-clock-range', storyTime: '2025年1月3日 09:30至10:30' },
    { id: 'yearless-clock-range', storyTime: '10月2日 09:30～11:00' },
    { id: 'clock-before-range', storyTime: '2025年1月5日 09:15' },
    { id: 'clock-hyphen-range', storyTime: '2025年1月5日 09:30-10:30' },
    { id: 'clock-after-range', storyTime: '2025年1月5日 10:00' },
    { id: 'floor-range', storyTime: null, parsedStoryTime: { ...projectTime('10月4日'), rangeText: '10月4日至10月5日' } },
  ];
  const timeline = projectQianshiTimeline({ events, relations: [] });
  const groupFor = id => timeline.segments.flatMap(segment => segment.groups).find(group => group.eventIds.includes(id));
  assert.deepEqual(timeline.undatedEventIds, [], '可识别起点的范围不落入未定区');
  assert.equal(groupFor('iso-range').day, '1日');
  assert.equal(groupFor('year-day-range').day, '2日');
  assert.equal(groupFor('yearless-day-range').day, '1日');
  assert.equal(groupFor('year-clock-range').day, '3日');
  assert.equal(groupFor('yearless-clock-range').day, '2日');
  assert.deepEqual(groupFor('clock-hyphen-range').eventIds, ['clock-before-range', 'clock-hyphen-range', 'clock-after-range'],
    '紧贴短横的时分范围按左侧09:30排序，且不把10:30终点当作发生时间');
  assert.equal(groupFor('floor-range').day, '4日', '楼层时间来源的范围也按左端点投影');
  for (const event of events.slice(0, 6)) assert.equal(groupFor(event.id).full, event.storyTime || event.parsedStoryTime.rangeText,
    '时间轴详情保留完整范围原文');
});

test('秒缺失的同分钟事件保持原顺序，具名历法仍独立', () => {
  const timeline = projectQianshiTimeline({ events: [
    { id: 'unknown-seconds', storyTime: '大陆历1686年7月29日 14:15' },
    { id: 'explicit-seconds', storyTime: '大陆历1686年7月29日 14:15:02' },
    { id: 'same-precision', storyTime: '大陆历1686年7月29日 14:15' },
    { id: 'other-calendar', storyTime: '星海历1686年7月29日 14:15:00' },
  ], relations: [] });
  const mainland = timeline.segments.find(segment => segment.id === 'named:大陆历');
  assert.deepEqual(mainland.groups[0].eventIds, ['unknown-seconds', 'explicit-seconds', 'same-precision'], '秒精度不足时保持来源稳定顺序');
  assert.ok(timeline.segments.some(segment => segment.id === 'named:星海历'), '不同具名历法不混排');
});

test('没有月日字段的自定义周序日期保留原有可用主标签', () => {
  const storyTime = '星历元年霜月第二个星期三';
  const time = { ...projectTime(storyTime), monthDay: null };
  const timeline = projectQianshiTimeline({ events: [{ id: 'custom-week', storyTime, parsedStoryTime: time }], relations: [] });
  assert.equal(timeline.segments[0].groups[0].day, storyTime);
  assert.equal(timeline.segments[0].groups[0].full, storyTime);
});

test('千事召回日期原文优先于解析投影，原文带时钟时不重复拼接', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'calendar', title: '纪年约定', description: '保留原始纪年', status: 'occurred', matter: false, storyTime: '三零五三年10月4日 08:00' },
  ], order: [] } } });
  const reachable = { root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 1,
    floors: [source], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', source, delta)], entities: [] };
  const recall = projectQianshiRecall(reachable, { selectedEventIds: [delta.events[0].id], selectedMatterIds: [] });
  assert.match(recall.text, /三零五三年10月4日 08:00：纪年约定/u);
  assert.doesNotMatch(recall.text, /08:00 08:00/u);
});

test('跨楼重复关系按确定性 ID 只投影一次，后值 certainty 生效且不同关系不丢', async () => {
  const floors = [1, 2, 3, 4].map((value, index) => floor(`${String(value).repeat(8)}-${String(value).repeat(4)}-4${String(value).repeat(3)}-8${String(value).repeat(3)}-${String(value).repeat(12)}`, index + 1));
  const first = await compileQianshiDelta({ floor: floors[0], now: NOW, packet: { qianshi: { events: [
    { key: 'a', title: '事项甲', description: '事项甲', status: 'planned', matter: true },
    { key: 'b', title: '事项乙', description: '事项乙', status: 'planned', matter: true },
  ], order: [] } } });
  const [a, b] = first.events;
  const relationId = '55555555-5555-4555-8555-555555555555';
  const otherRelationId = '66666666-6666-4666-8666-666666666666';
  const base = (source, event, relations) => validateQianshiDelta({ schemaVersion: 1, status: 'ready', reason: null, compiledAt: NOW,
    candidateStats: { count: 0, characters: 0 }, events: [event], relations }, { floorId: source.id });
  const event = (source, id, title) => ({ id, matterId: null, updatesMatter: false, title, description: title, status: 'occurred', storyTime: null, scheduledTime: null, people: [], object: null, sourceFloorId: source.id, continuesFromEventIds: [] });
  const repeatedStrong = { id: relationId, type: 'before', fromEventId: a.id, toEventId: b.id, certainty: 'strong' };
  const repeatedExplicit = { ...repeatedStrong, certainty: 'explicit' };
  const distinct = { id: otherRelationId, type: 'before', fromEventId: b.id, toEventId: a.id, certainty: 'explicit' };
  const deltas = [first,
    base(floors[1], event(floors[1], '77777777-7777-4777-8777-777777777777', '旁支一'), [repeatedStrong]),
    base(floors[2], event(floors[2], '88888888-8888-4888-8888-888888888888', '旁支二'), [repeatedExplicit]),
    base(floors[3], event(floors[3], '99999999-9999-4999-8999-999999999999', '旁支三'), [distinct])];
  const projection = projectQianshiGraph({ floors, floorMemories: deltas.map((delta, index) => memory(`aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${index}`, floors[index], delta)), entities: [] });
  assert.deepEqual(projection.relations.map(item => [item.id, item.certainty]), [[relationId, 'explicit'], [otherRelationId, 'explicit']]);
  assert.equal(projection.graph.filterEdges((_edge, attributes) => attributes.type === 'before').length, 2);

  const conflicting = { ...repeatedExplicit, fromEventId: b.id, toEventId: a.id };
  assert.throws(() => projectQianshiGraph({ floors: floors.slice(0, 3), floorMemories: [first,
    base(floors[1], event(floors[1], '77777777-7777-4777-8777-777777777777', '旁支一'), [repeatedStrong]),
    base(floors[2], event(floors[2], '88888888-8888-4888-8888-888888888888', '旁支二'), [conflicting]),
  ].map((delta, index) => memory(`bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${index}`, floors[index], delta)), entities: [] }), error => error?.code === 'QIANSHI_RELATION_ID_CONFLICT');

  const missing = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const dangling = { ...repeatedStrong, toEventId: missing };
  const damaged = projectQianshiGraph({ floors: floors.slice(0, 3), floorMemories: [first,
    base(floors[1], event(floors[1], '77777777-7777-4777-8777-777777777777', '旁支一'), [dangling]),
    base(floors[2], event(floors[2], '88888888-8888-4888-8888-888888888888', '旁支二'), [dangling]),
  ].map((delta, index) => memory(`cccccccc-cccc-4ccc-8ccc-ccccccccccc${index}`, floors[index], delta)), entities: [] });
  assert.deepEqual(damaged.diagnostics.degradedFloorIds, [floors[1].id, floors[2].id], '重复悬空关系仍要给每个来源楼记录降级');
  assert.deepEqual(damaged.diagnostics.danglingRelationIds, [relationId, relationId]);
  assert.deepEqual(damaged.diagnostics.danglingRelations.map(item => [item.floorId, item.relationId, item.fromEventId, item.toEventId, item.reason]), [
    [floors[1].id, relationId, a.id, missing, 'missing-event'], [floors[2].id, relationId, a.id, missing, 'missing-event'],
  ], '诊断提供来源楼和完整端点，修整可精确定位坏边');
  assert.equal(damaged.coverage.completeFloors, 1, '已断链的 ready 楼不再计入健康完成数');
});

test('同楼后列事件引用有效，聚合记忆坏 continues 按锚楼归类', () => {
  const first = floor('11111111-1111-4111-8111-111111111111', 1);
  const anchor = floor('22222222-2222-4222-8222-222222222222', 2);
  const event = (source, id, continuesFromEventIds = []) => ({ id, matterId: null, updatesMatter: false,
    title: id, description: id, status: 'occurred', storyTime: null, scheduledTime: null, people: [], object: null,
    sourceFloorId: source.id, continuesFromEventIds });
  const laterId = '33333333-3333-4333-8333-333333333333';
  const localDelta = { schemaVersion: 1, status: 'ready', reason: null, compiledAt: NOW,
    candidateStats: { count: 0, characters: 0 },
    events: [event(first, '44444444-4444-4444-8444-444444444444', [laterId]), event(first, laterId)], relations: [] };
  const local = projectQianshiGraph({ floors: [first], floorMemories: [{ ...memory('55555555-5555-4555-8555-555555555555', first, localDelta),
    sourceFloorIds: [first.id] }], entities: [] });
  assert.deepEqual(local.diagnostics.danglingContinuations, [], '全集收集完后再判定，合法的同楼后列引用不会被误隔离');
  assert.deepEqual(local.diagnostics.degradedFloorIds, []);

  const missingId = '66666666-6666-4666-8666-666666666666';
  const aggregateDelta = { ...localDelta, events: [event(first, '77777777-7777-4777-8777-777777777777', [missingId]), event(anchor, laterId)] };
  const aggregateMemory = { ...memory('88888888-8888-4888-8888-888888888888', anchor, aggregateDelta), sourceFloorIds: [first.id, anchor.id] };
  const aggregate = projectQianshiGraph({ floors: [first, anchor], floorMemories: [aggregateMemory], entities: [] });
  assert.deepEqual(aggregate.diagnostics.danglingContinuations.map(item => [item.floorId, item.memoryFloorId]), [[first.id, anchor.id]],
    '保留坏引用所在来源楼，同时标明唯一持有该聚合记忆的锚楼');
  assert.deepEqual(aggregate.diagnostics.degradedFloorIds, [anchor.id], '聚合记忆的降级归属锚楼');
  assert.equal(aggregate.coverage.degradedFloors, 1, 'coverage 只把有该聚合记忆的锚楼计为断链');
});

test('倒叙补证归入同一事项但不推进当前状态，progress 图不沿 before 串入其他事项', async () => {
  const first = floor('11111111-1111-4111-8111-111111111111', 1);
  const d1 = await compileQianshiDelta({ floor: first, now: NOW, packet: { qianshi: { events: [
    { key: 'borrow', title: '归还旧书', description: '顾舟答应归还旧书', status: 'planned', matter: true, storyTime: '2026-05-02' },
    { key: 'letter', title: '寄出信件', description: '沈砚准备寄出信件', status: 'planned', matter: true, storyTime: '2026-05-03' },
  ], order: [{ before: 'borrow', after: 'letter', certainty: 'explicit' }] } } });
  const borrow = d1.events[0], second = floor('22222222-2222-4222-8222-222222222222', 2);
  const d2 = await compileQianshiDelta({ floor: second, now: NOW, candidateBindings: [{ key: 'candidate-1', matterId: borrow.matterId,
    latestEventIds: [borrow.id], latestStoryTime: borrow.storyTime, sourceFloorId: first.id, sourceAssistantSeq: 1 }], packet: { qianshi: { events: [
    { key: 'memory', title: '借书缘由', description: '回忆当年借书是为查档案', status: 'occurred', storyTime: '2026-05-01', links: [{ candidateKey: 'candidate-1', kind: 'progress' }] },
  ], order: [] } } });
  assert.equal(d2.events[0].matterId, borrow.matterId);
  assert.equal(d2.events[0].updatesMatter, false);
  assert.equal(d2.relations.length, 0);
  const reachable = { root: { narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 1,
    floors: [first, second], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', first, d1), memory('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', second, d2)], entities: [] };
  const projection = projectQianshiGraph(reachable);
  const matter = projection.matters.find(value => value.matterId === borrow.matterId);
  assert.equal(matter.latestEventIds.includes(d2.events[0].id), false);
  assert.equal(matter.eventIds.includes(d1.events[1].id), false, 'before 边不得把另一事项带进 progress traversal');
});

test('候选使用中文 BM25，并同时携带事项起点和最新进展', async () => {
  const first = floor('11111111-1111-4111-8111-111111111111', 1);
  const d1 = await compileQianshiDelta({ floor: first, now: NOW, packet: { qianshi: { events: [
    { key: 'borrow', title: '归还旧书', description: '顾舟借了档案室的旧书并答应归还', status: 'planned', matter: true, storyTime: '2026-05-02' },
  ], order: [] } } });
  const second = floor('22222222-2222-4222-8222-222222222222', 2), original = d1.events[0];
  const d2 = await compileQianshiDelta({ floor: second, now: NOW, candidateBindings: [{ key: 'candidate-1', matterId: original.matterId,
    latestEventIds: [original.id], latestStoryTime: original.storyTime, sourceFloorId: first.id, sourceAssistantSeq: 1 }], packet: { qianshi: { events: [
    { key: 'delay', title: '归还延期', description: '归还时间延到明日', status: 'inProgress', storyTime: '2026-05-03', links: [{ candidateKey: 'candidate-1', kind: 'progress' }] },
  ], order: [] } } });
  const reachable = { root: { narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 1,
    floors: [first, second], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', first, d1), memory('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', second, d2)], entities: [] };
  const candidates = prepareQianshiCandidates(reachable, { canonicalContent: '顾舟翻开借来的旧书继续查档案' });
  assert.equal(candidates.request.length, 1);
  assert.match(candidates.request[0].origin.description, /借了档案室/u);
  assert.match(candidates.request[0].latestProgress.description, /延到明日/u);
});

test('千事候选索引只冷投影一次，顺序新楼增量结果与全量候选相同，前缀替换后重建', async () => {
  const first = floor('11111111-1111-4111-8111-111111111111', 1);
  const second = floor('22222222-2222-4222-8222-222222222222', 2);
  const d1 = await compileQianshiDelta({ floor: first, now: NOW, packet: { qianshi: { events: [
    { key: 'book', title: '归还旧书', description: '顾舟答应归还档案室旧书', status: 'planned', matter: true, object: '蓝皮档案' },
  ], order: [] } } });
  const d2 = await compileQianshiDelta({ floor: second, now: NOW, packet: { qianshi: { events: [
    { key: 'letter', title: '寄出红蜡信', description: '沈砚准备寄出红蜡信', status: 'planned', matter: true },
  ], order: [] } } });
  const reachable = { root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 1,
    floors: [first], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', first, d1)], entities: [] };
  let projections = 0;
  const index = createQianshiCandidateIndex({ projector: (...args) => { projections += 1; return projectQianshiGraph(...args); } });
  const options = { canonicalContent: '继续借书和信件安排' };
  index.prepare(reachable, options);
  reachable.floors.push(second);
  reachable.floorMemories.push(memory('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', second, d2));
  const incremental = index.prepare(reachable, options);
  assert.equal(projections, 1, '追加新楼只应用其 delta，不再重建完整图');
  assert.deepEqual(incremental, prepareQianshiCandidates(reachable, options));
  reachable.floorMemories[0] = memory('ffffffff-ffff-4fff-8fff-ffffffffffff', first, d1);
  index.prepare(reachable, options);
  assert.equal(projections, 2, '有效前缀身份改变后从权威前缀冷建');
  reachable.root.narrativeGeneration = '33333333-3333-4333-8333-333333333333';
  index.prepare(reachable, options);
  assert.equal(projections, 3, '聊天分支代次变化后冷建');
  reachable.root.chatId = 'other-chat';
  index.prepare(reachable, options);
  assert.equal(projections, 4, '聊天身份变化后冷建');
  index.prepare(reachable, { ...options, identityProjection: { version: 1 } });
  assert.equal(projections, 5, '人物身份投影变化后冷建');
  reachable.floors.pop(); reachable.floorMemories = reachable.floorMemories.filter(item => item.floorId !== second.id);
  index.prepare(reachable, { ...options, identityProjection: { version: 1 } });
  assert.equal(projections, 6, '删尾造成索引前缀缩短时冷建');
});

test('增量事项前沿只按有效 progress 边推进，失效 continuation ID 保留原端点', async () => {
  const first = floor('11111111-1111-4111-8111-111111111111', 1), second = floor('22222222-2222-4222-8222-222222222222', 2);
  const d1 = await compileQianshiDelta({ floor: first, now: NOW, packet: { qianshi: { events: [
    { key: 'start', title: '归还蓝皮档案', description: '顾舟答应归还蓝皮档案', status: 'planned', matter: true, object: '蓝皮档案' },
  ], order: [] } } });
  const origin = d1.events[0];
  const compiled = await compileQianshiDelta({ floor: second, now: NOW, candidateBindings: [{ key: 'candidate-1', matterId: origin.matterId,
    latestEventIds: [origin.id], latestStoryTime: origin.storyTime, sourceFloorId: first.id, sourceAssistantSeq: 1 }], packet: { qianshi: { events: [
    { key: 'later', title: '继续归还', description: '之后继续安排归还档案', status: 'inProgress', links: [{ candidateKey: 'candidate-1', kind: 'progress' }] },
  ], order: [] } } });
  const validReachable = { root: { chatId: CHAT, narrativeGeneration: GENERATION }, floors: [first],
    floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', first, d1)], entities: [] };
  const validIndex = createQianshiCandidateIndex();
  validIndex.prepare(validReachable);
  validReachable.floors.push(second);
  validReachable.floorMemories.push(memory('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', second, compiled));
  const validIncremental = validIndex.prepare(validReachable, { canonicalContent: '继续' });
  assert.deepEqual(validIncremental, prepareQianshiCandidates(validReachable, { canonicalContent: '继续' }));
  assert.deepEqual(validIncremental.bindings[0].latestEventIds, [compiled.events[0].id], '有效 progress 边将前沿推进到新事件');
  const brokenContinuation = validateQianshiDelta({ ...structuredClone(compiled), relations: [] }, { floorId: second.id });
  const reachable = { root: { chatId: CHAT, narrativeGeneration: GENERATION }, floors: [first],
    floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', first, d1)], entities: [] };
  const index = createQianshiCandidateIndex();
  index.prepare(reachable);
  reachable.floors.push(second);
  reachable.floorMemories.push(memory('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', second, brokenContinuation));
  const incremental = index.prepare(reachable, { canonicalContent: '继续' });
  const authoritative = prepareQianshiCandidates(reachable, { canonicalContent: '继续' });
  assert.deepEqual(incremental, authoritative);
  assert.deepEqual(incremental.bindings[0].latestEventIds, [compiled.events[0].id, origin.id], '没有有效 progress 边时旧事项端点仍是最新前沿之一');
});

test('终结事项只在正文明确提到完整标题或对象短语时重提', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'done', title: '归还蓝皮档案', description: '顾舟把蓝皮档案送回档案室', status: 'completed', matter: true, object: '蓝皮档案' },
  ], order: [] } } });
  const reachable = { root: { narrativeGeneration: GENERATION }, floors: [source], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', source, delta)], entities: [] };
  assert.equal(prepareQianshiCandidates(reachable, { canonicalContent: '今天终于有空，之前的事情也都处理了' }).request.length, 0);
  assert.equal(prepareQianshiCandidates(reachable, { canonicalContent: '那份蓝皮档案现在在哪' }).request.length, 1);
  assert.equal(prepareQianshiCandidates(reachable, { canonicalContent: '别的剧情', precedingUserInput: { messages: [{ content: '蓝皮档案现在在哪' }] } }).request.length, 1,
    '前置 USER 材料属于这次新楼的关联输入，可触发明确对象重提');
  const index = createQianshiCandidateIndex();
  assert.deepEqual(index.prepare(reachable, { canonicalContent: '别的剧情', precedingUserInput: { messages: [{ content: '蓝皮档案现在在哪' }] } }),
    prepareQianshiCandidates(reachable, { canonicalContent: '别的剧情', precedingUserInput: { messages: [{ content: '蓝皮档案现在在哪' }] } }));
});

test('删尾或分支前缀只投影仍可达楼，未来完成态不会残留', async () => {
  const first = floor('11111111-1111-4111-8111-111111111111', 1);
  const d1 = await compileQianshiDelta({ floor: first, now: NOW, packet: { qianshi: { events: [
    { key: 'start', title: '归还旧书', description: '顾舟答应归还旧书', status: 'planned', matter: true, storyTime: '2026-05-01' },
  ], order: [] } } });
  const original = d1.events[0];
  const makeProgress = async (source, key, description, status, prior) => compileQianshiDelta({ floor: source, now: NOW,
    candidateBindings: [{ key: 'candidate-1', matterId: original.matterId, latestEventIds: [prior.id], latestStoryTime: prior.storyTime,
      sourceFloorId: prior.sourceFloorId, sourceAssistantSeq: source.assistantSeq - 1 }], packet: { qianshi: { events: [
      { key, title: '归还旧书', description, status, matter: true, storyTime: `2026-05-0${source.assistantSeq}`,
        links: [{ candidateKey: 'candidate-1', kind: 'progress' }] },
    ], order: [] } } });
  const second = floor('22222222-2222-4222-8222-222222222222', 2);
  const d2 = await makeProgress(second, 'delay', '归还时间延后一天', 'inProgress', original);
  const third = floor('33333333-3333-4333-8333-333333333333', 3);
  const d3 = await makeProgress(third, 'done', '旧书已经归还', 'completed', d2.events[0]);
  const full = { root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 3,
    floors: [first, second, third], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', first, d1),
      memory('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', second, d2), memory('ffffffff-ffff-4fff-8fff-ffffffffffff', third, d3)], entities: [] };
  assert.equal(projectQianshiGraph(full).matters[0].status, 'completed');
  const prefix = projectQianshiGraph({ ...full, rootRevision: 4, floors: full.floors.slice(0, 2), floorMemories: full.floorMemories.slice(0, 2) });
  assert.equal(prefix.events.some(event => event.id === d3.events[0].id), false);
  assert.equal(prefix.matters[0].status, 'inProgress');
  assert.equal(prefix.events.some(event => event.id === original.id), true, '前缀来源事件保持稳定 ID');
});

test('千事字段整体无效只得到 pending，已成功摘要不触发额外模型重试', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const envelope = await createExtractorEnvelope({ batchId: '33333333-3333-4333-8333-333333333333', chatId: CHAT,
    narrativeGeneration: GENERATION, floor: source, userIdentity: { displayName: '林岚' } });
  let calls = 0;
  const result = await runExtractorRequest({ generateUtilityTask: async () => { calls += 1; return { jsonData: { summary: '林岚喝了一杯水。', qianshi: '坏字段' } }; },
    envelope, floor: source, expectedScope: envelope.scope, now: NOW });
  assert.equal(calls, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.memory.summary.aiText, '林岚喝了一杯水。');
  assert.equal(result.memory.qianshiDelta.status, 'pending');
});

test('摘要同次返回使用 event-N 局部编号，order 成功引用且坏事件不拖垮摘要', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const envelope = await createExtractorEnvelope({ batchId: '33333333-3333-4333-8333-333333333333', chatId: CHAT,
    narrativeGeneration: GENERATION, floor: source, userIdentity: { displayName: '林岚' } });
  let calls = 0;
  const result = await runExtractorRequest({ generateUtilityTask: async () => { calls += 1; return { jsonData: {
    summary: '林岚先取出钥匙，随后打开钟楼侧门。',
    qianshi: { events: [
      { key: 'event-1', title: '取出钥匙', description: '林岚取出钟楼钥匙', status: 'occurred', matter: false },
      { key: 'event-2', title: '打开侧门', description: '林岚随后打开钟楼侧门', status: 'occurred', matter: false },
      { key: 'event-3', title: '缺少描述' },
    ], order: [{ before: 'event-1', after: 'event-2', certainty: 'explicit' }] },
  } }; }, envelope, floor: source, expectedScope: envelope.scope, now: NOW });
  assert.equal(calls, 1);
  assert.equal(result.memory.summary.aiText, '林岚先取出钥匙，随后打开钟楼侧门。');
  assert.equal(result.memory.qianshiDelta.status, 'partial');
  assert.deepEqual(result.memory.qianshiDelta.events.map(event => event.title), ['取出钥匙', '打开侧门']);
  assert.deepEqual(result.memory.qianshiDelta.relations.map(relation => [relation.type, relation.fromEventId, relation.toEventId]), [
    ['before', result.memory.qianshiDelta.events[0].id, result.memory.qianshiDelta.events[1].id],
  ]);
});

test('千事 order 字符串列表按相邻事件编译，无效引用只产生局部 issue', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: {
    events: [
      { key: 'event-1', title: '拿起钥匙', description: '林岚拿起钟楼钥匙', status: 'occurred', matter: false },
      { key: 'event-2', title: '打开侧门', description: '林岚随后打开钟楼侧门', status: 'occurred', matter: false },
      { key: 'event-3', title: '进入钟楼', description: '林岚进入钟楼', status: 'occurred', matter: false },
    ],
    order: ['event-1', 'event-2', 'missing-event'],
  } } });

  assert.equal(delta.status, 'partial');
  assert.deepEqual(delta.relations.map(relation => [relation.type, relation.fromEventId, relation.toEventId]), [
    ['before', delta.events[0].id, delta.events[1].id],
  ]);
  assert.match(delta.reason, /先后关系 2 引用无效/u);
});

test('千事 order 字符串列表沿用 320 条关系上限', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const order = Array.from({ length: 321 }, (_, index) => index % 2 ? 'event-2' : 'event-1');
  order.push('missing-event');
  const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: {
    events: [
      { key: 'event-1', title: '拿起钥匙', description: '林岚拿起钟楼钥匙', status: 'occurred', matter: false },
      { key: 'event-2', title: '打开侧门', description: '林岚随后打开钟楼侧门', status: 'occurred', matter: false },
    ],
    order,
  } } });

  assert.equal(delta.status, 'ready', '第 321 条关系超出既有上限，不得让整楼变成 partial');
  assert.equal(delta.reason, null);
});

test('公共桥只返回深复制，读取和规划本身不隐式启动历史任务', async () => {
  let starts = 0;
  const snapshot = { status: 'ready', anchor: { headCheckpointId: 'head' }, events: [{ title: '原值' }] };
  const bridge = createPublicQianshiBridge({ memoryRuntime: {
    getQianshiSnapshot: () => snapshot,
    prepareQianshiHistory: async () => ({ status: 'empty', totalFloors: 0 }),
    startQianshiHistory: async () => { starts += 1; return { status: 'completed' }; },
    stopQianshiHistory: async () => ({ status: 'stopped' }),
  } });
  const copy = bridge.getSnapshot(); copy.events[0].title = '篡改';
  assert.equal(snapshot.events[0].title, '原值');
  await bridge.read(); await bridge.prepareHistory();
  assert.equal(starts, 0);
  await bridge.startHistory(); assert.equal(starts, 1);
});

test('注入短版随查询选择事项并沿已有 progress 图带入前因、进展和结果', async () => {
  const first = floor('11111111-1111-4111-8111-111111111111', 1);
  const d1 = await compileQianshiDelta({ floor: first, now: NOW, packet: { qianshi: { events: [
    { key: 'book', title: '借走蓝皮档案', description: '顾舟借走蓝皮档案并答应归还', status: 'planned', matter: true, storyTime: '2026-05-01 09:00' },
    { key: 'letter', title: '准备寄出红蜡信', description: '沈砚准备寄出红蜡信', status: 'planned', matter: true, storyTime: '2026-05-02 10:00' },
  ], order: [] } } });
  const book = d1.events[0], second = floor('22222222-2222-4222-8222-222222222222', 2);
  const d2 = await compileQianshiDelta({ floor: second, now: NOW, candidateBindings: [{ key: 'candidate-1', matterId: book.matterId,
    latestEventIds: [book.id], latestStoryTime: book.storyTime, sourceFloorId: first.id, sourceAssistantSeq: 1 }], packet: { qianshi: { events: [
    { key: 'book-delay', title: '蓝皮档案归还延期', description: '因查档案而延期归还', status: 'inProgress', matter: true, storyTime: '2026-05-03 11:00', links: [{ candidateKey: 'candidate-1', kind: 'progress' }] },
  ], order: [] } } });
  const delayed = d2.events[0], third = floor('33333333-3333-4333-8333-333333333333', 3);
  const d3 = await compileQianshiDelta({ floor: third, now: NOW, candidateBindings: [{ key: 'candidate-1', matterId: book.matterId,
    latestEventIds: [delayed.id], latestStoryTime: delayed.storyTime, sourceFloorId: second.id, sourceAssistantSeq: 2 }], packet: { qianshi: { events: [
    { key: 'book-done', title: '蓝皮档案已经归还', description: '顾舟把蓝皮档案还回档案室', status: 'completed', matter: true, storyTime: '2026-05-04 12:00', links: [{ candidateKey: 'candidate-1', kind: 'progress' }] },
  ], order: [] } } });
  const reachable = { root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 3,
    floors: [first, second, third], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', first, d1), memory('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', second, d2), memory('ffffffff-ffff-4fff-8fff-ffffffffffff', third, d3)], entities: [] };
  const bookRecall = projectQianshiRecall(reachable, { queryContext: { text: '蓝皮档案后来还了吗', latestUserText: '蓝皮档案后来还了吗' } });
  assert.match(bookRecall.text, /\[相关时间线\][\s\S]*2026-05-01 09:00：借走蓝皮档案[\s\S]*2026-05-03 11:00：蓝皮档案归还延期[\s\S]*2026-05-04 12:00：蓝皮档案已经归还/u);
  assert.match(bookRecall.text, /\[当前待接续\][\s\S]*准备寄出红蜡信；尚未记录完成。/u);
  const letterRecall = projectQianshiRecall(reachable, { queryContext: { text: '红蜡信寄出了吗', latestUserText: '红蜡信寄出了吗' } });
  assert.match(letterRecall.text, /2026-05-02 10:00：准备寄出红蜡信[\s\S]*\[当前待接续\][\s\S]*准备寄出红蜡信；尚未记录完成。/u);
  assert.doesNotMatch(letterRecall.text, /蓝皮档案/u);
});

test('未竟事项不受当前话题、旧日期、跨月或未知历法筛除，终态仍不冒充待办', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'old', title: '旧宴后归还餐盒', description: '很久以前答应归还餐盒', status: 'planned', matter: true, storyTime: '2026-05-01 12:00' },
    { key: 'overnight', title: '守住北门钥匙', description: '午夜前接下守钥匙的安排', status: 'inProgress', matter: true, storyTime: '2026-06-14 23:55' },
    { key: 'future', title: '前往钟楼换岗', description: '约好稍后前往钟楼换岗', status: 'planned', matter: true, storyTime: '2026-06-15 00:05', scheduledTime: '2026-06-15 00:30' },
    { key: 'unknown', title: '苍月祭后兑现承诺', description: '日期体系不明的旧承诺', status: 'planned', matter: true, storyTime: '苍月祭' },
    { key: 'done', title: '交回南门徽章', description: '南门徽章已经交回', status: 'completed', matter: true, storyTime: '2026-06-15 00:03' },
    { key: 'occurred', title: '一次性已发生的事实', description: '守夜时听见钟声', status: 'occurred', matter: false, storyTime: '2026-06-14 23:58' },
  ], order: [] } } });
  const reachable = { root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 1,
    floors: [source], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', source, delta)], entities: [] };
  const currentTime = projectTime('2026-06-15 00:05');
  const recall = projectQianshiRecall(reachable, { queryContext: { text: '继续现在的场景', latestUserText: '继续现在的场景' }, currentTime,
    recentStoryTimes: [projectTime('2026-06-14 23:45'), currentTime] });
  assert.match(recall.text, /\[当前待接续\]/u);
  for (const title of ['旧宴后归还餐盒', '守住北门钥匙', '前往钟楼换岗', '苍月祭后兑现承诺']) assert.match(recall.text, new RegExp(`${title}[^\n]*尚未记录完成`, 'u'));
  assert.match(recall.text, /前往钟楼换岗；约定：2026-06-15 00:30；尚未记录完成。/u);
  assert.doesNotMatch(recall.text, /交回南门徽章/u);
  assert.doesNotMatch(recall.text, /00:30：前往钟楼换岗/u, 'scheduledTime 不能冒充已经发生的时间');

  const old = projectQianshiRecall(reachable, { queryContext: { text: '旧宴后归还餐盒', latestUserText: '旧宴后归还餐盒' }, currentTime,
    recentStoryTimes: [projectTime('2026-06-14 23:45'), currentTime] });
  assert.match(old.text, /2026-05-01 12:00：旧宴后归还餐盒/u);
  assert.match(old.text, /\[当前待接续\][\s\S]*旧宴后归还餐盒；尚未记录完成。/u);

  const unknown = projectQianshiRecall(reachable, { queryContext: { text: '苍月祭承诺', latestUserText: '苍月祭承诺' }, currentTime,
    recentStoryTimes: [projectTime('2026-06-14 23:45'), currentTime] });
  assert.match(unknown.text, /苍月祭后兑现承诺/u);
  assert.match(unknown.text, /\[当前待接续\][\s\S]*苍月祭后兑现承诺；尚未记录完成。/u);

  const originQuestion = prepareQianshiRecallCandidates(reachable, { queryContext: { text: '很久以前答应归还餐盒', latestUserText: '为什么答应归还餐盒' } });
  const causeCandidate = originQuestion.candidates.find(candidate => candidate.kind === 'history' && candidate.eventRows.some(row => row.eventId === delta.events[0].id));
  assert.ok(causeCandidate, '直接问起因时，history 候选仍可带回未完事项的起因事件');
  assert.equal(originQuestion.candidates.find(candidate => candidate.kind === 'pending' && candidate.fact.title === '旧宴后归还餐盒').eventRows.length, 0,
    '同一事项的 pending 候选自身仍只表示当前状态');

  const completedQuery = prepareQianshiRecallCandidates(reachable, { queryContext: { text: '交回南门徽章', latestUserText: '交回南门徽章' } });
  assert.ok(completedQuery.candidates.some(candidate => candidate.kind === 'history' && candidate.fact.title === '交回南门徽章'),
    '直接问已结束事项时仍能选择其历史');
  const occurredQuery = prepareQianshiRecallCandidates(reachable, { queryContext: { text: '守夜时听见钟声', latestUserText: '守夜时听见钟声' } });
  assert.ok(occurredQuery.candidates.some(candidate => candidate.kind === 'history' && candidate.fact.title === '一次性已发生的事实'),
    '直接问一次性已发生事件时仍能走 Q-only 本地召回');
});

test('召回候选池有界且只把 planned/inProgress 作为未竟，所选 Q 可纯本地投影', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'old', title: '旧约仍待兑现', description: '很久以前留下的承诺', status: 'planned', matter: true, storyTime: '2020-01-01', important: true },
    { key: 'unknown', title: '异历事项仍在推进', description: '无法换算日期的事项', status: 'inProgress', matter: true, storyTime: '苍月祭后', important: false },
    { key: 'done', title: '已经办妥的事项', description: '此事已经完成', status: 'completed', matter: true, storyTime: '2026-06-15' },
    { key: 'cancelled', title: '明确取消的事项', description: '双方已经取消', status: 'cancelled', matter: true, storyTime: '2026-06-15' },
    { key: 'occurred', title: '只是已经发生的事实', description: '不应被当成完成或待办', status: 'occurred', matter: false, storyTime: '2026-06-15' },
  ], order: [] } } });
  const reachable = { root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 1,
    floors: [source], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', source, delta)], entities: [] };
  const pool = prepareQianshiRecallCandidates(reachable, { queryContext: { text: '继续眼前场景', latestUserText: '继续眼前场景' }, characterBudget: 1200 });
  assert.ok(pool.stats.characters <= 1200);
  assert.equal(pool.stats.count, pool.candidates.length);
  assert.deepEqual(pool.candidates.filter(item => item.kind === 'pending').map(item => item.fact.title).sort(), ['异历事项仍在推进', '旧约仍待兑现'].sort());
  const pending = pool.candidates.filter(item => item.kind === 'pending');
  assert.ok(pending.every(item => item.eventIds.length === 0 && item.eventRows.length === 0), '待接续候选只带当前状态，不附带起因/进展事件行');
  assert.ok(pending.every(item => !Object.hasOwn(item.fact, 'origin') && !Object.hasOwn(item.fact, 'latestProgress')),
    '发给选材模型的待接续候选不重播历史事件正文');
  assert.equal(JSON.stringify(pool.candidates).includes('important'), false);
  assert.equal(JSON.stringify(pool.candidates).includes('已经办妥的事项'), false);
  assert.equal(JSON.stringify(pool.candidates).includes('明确取消的事项'), false);
  assert.equal(JSON.stringify(pool.candidates).includes('只是已经发生的事实'), false);

  const retained = projectQianshiCandidateSelection(pool.candidates, { excludedKeys: [pool.candidates[0].key] });
  assert.equal(retained.text.includes(pool.candidates[0].fact.title), false);
  assert.match(retained.text, /\[当前待接续\][\s\S]*尚未记录完成/u);
  assert.ok(retained.text.length <= 4000);
});

test('召回候选只排序实际入池事件，未入池关系节点不改变顺序', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'later-source', title: '青铜暗号乙', description: '青铜暗号候选', status: 'occurred', matter: false },
    { key: 'hidden', title: '无关片段', description: '普通背景噪音', status: 'occurred', matter: false },
    { key: 'earlier-source', title: '青铜暗号甲', description: '青铜暗号候选', status: 'occurred', matter: false },
  ], order: [] } } });
  const [laterSource, hidden, earlierSource] = delta.events;
  const noise = Array.from({ length: 256 }, (_, index) => ({ ...structuredClone(hidden), id: `noise-${String(index).padStart(4, '0')}`,
    title: `无关片段${index}`, description: '普通背景噪音' }));
  const expandedDelta = { ...structuredClone(delta), events: [laterSource, ...noise, earlierSource], relations: [
    { id: 'hidden-progress-a', type: 'progress', fromEventId: earlierSource.id, toEventId: noise[0].id, certainty: 'explicit' },
    { id: 'hidden-progress-b', type: 'progress', fromEventId: noise[0].id, toEventId: laterSource.id, certainty: 'explicit' },
  ] };
  const reachable = { root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 1,
    floors: [source], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', source, expandedDelta)], entities: [] };
  const pool = prepareQianshiRecallCandidates(reachable, { queryContext: { text: '青铜暗号', latestUserText: '青铜暗号' } });
  assert.deepEqual(pool.candidates.map(candidate => candidate.fact.title).sort(), ['青铜暗号甲', '青铜暗号乙'].sort());
  assert.deepEqual(projectQianshiCandidateSelection(pool.candidates).eventIds, [laterSource.id, earlierSource.id],
    '只经未入池节点连通的 progress 关系不得进入候选排序图');
});

test('召回候选排序仍用全图辨认歧义历法，但未入池历法事件不是排序节点', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'bare-late', title: '银铃线索乙', description: '银铃线索候选', status: 'occurred', matter: false, storyTime: '1686-09-22' },
    { key: 'other-calendar', title: '异历背景', description: '不参与本轮候选', status: 'occurred', matter: false, storyTime: '星海历1686年7月1日' },
    { key: 'named-early', title: '银铃线索甲', description: '银铃线索候选', status: 'occurred', matter: false, storyTime: '大陆历1686年8月26日' },
  ], order: [] } } });
  const [bareLate, , namedEarly] = delta.events;
  const reachable = { root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 1,
    floors: [source], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', source, delta)], entities: [] };
  const pool = prepareQianshiRecallCandidates(reachable, { queryContext: { text: '银铃线索', latestUserText: '银铃线索' } });
  assert.deepEqual(pool.candidates.map(candidate => candidate.fact.title).sort(), ['银铃线索乙', '银铃线索甲']);
  assert.deepEqual(projectQianshiCandidateSelection(pool.candidates).eventIds, [bareLate.id, namedEarly.id],
    '同年存在两种显式历法时，未标历法日期不得借候选内单一历法被强排');
});

test('按保存 ID 顺序实时投影不受未选节点变化影响，选中事项终态或删除只移除对应行', async () => {
  const first = floor('11111111-1111-4111-8111-111111111111', 1);
  const d1 = await compileQianshiDelta({ floor: first, now: NOW, packet: { qianshi: { events: [
    { key: 'book', title: '答应归还旧书', description: '顾舟答应归还旧书', status: 'planned', matter: true, storyTime: '2026-05-01' },
    { key: 'bell', title: '钟楼敲响三声', description: '钟楼在夜里敲响', status: 'occurred', matter: false, storyTime: '2026-05-02' },
  ], order: [] } } });
  const book = d1.events[0];
  const base = { root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 1,
    floors: [first], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', first, d1)], entities: [] };
  const selected = projectQianshiRecall(base, { selectedEventIds: [d1.events[1].id, book.id], selectedMatterIds: [book.matterId] });
  assert.match(selected.text, /钟楼敲响三声[\s\S]*答应归还旧书/u, '显式 eventIds 顺序必须原样保留');
  assert.match(selected.text, /\[当前待接续\][\s\S]*答应归还旧书；尚未记录完成/u);

  const extra = floor('22222222-2222-4222-8222-222222222222', 2);
  const extraDelta = await compileQianshiDelta({ floor: extra, now: NOW, packet: { qianshi: { events: [
    { key: 'unselected', title: '未选中的新事项', description: '不应改变已经选择的投影', status: 'planned', matter: true, storyTime: '2026-05-03' },
  ], order: [] } } });
  const expanded = { ...base, rootRevision: 2, floors: [first, extra], floorMemories: [...base.floorMemories, memory('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', extra, extraDelta)] };
  assert.deepEqual(projectQianshiRecall(expanded, { selectedEventIds: selected.eventIds, selectedMatterIds: selected.matterIds }), selected);

  const doneFloor = floor('33333333-3333-4333-8333-333333333333', 3);
  const doneDelta = await compileQianshiDelta({ floor: doneFloor, now: NOW, candidateBindings: [{ key: 'candidate-1', matterId: book.matterId,
    latestEventIds: [book.id], latestStoryTime: book.storyTime, sourceFloorId: first.id, sourceAssistantSeq: 1 }], packet: { qianshi: { events: [
    { key: 'book-done', title: '旧书已经归还', description: '顾舟已经归还旧书', status: 'completed', matter: true, storyTime: '2026-05-04', links: [{ candidateKey: 'candidate-1', kind: 'progress' }] },
  ], order: [] } } });
  const completed = { ...base, rootRevision: 2, floors: [first, doneFloor], floorMemories: [...base.floorMemories, memory('ffffffff-ffff-4fff-8fff-ffffffffffff', doneFloor, doneDelta)] };
  const afterCompletion = projectQianshiRecall(completed, { selectedEventIds: selected.eventIds, selectedMatterIds: selected.matterIds });
  assert.match(afterCompletion.text, /答应归还旧书/u, '相关历史仍保留');
  assert.doesNotMatch(afterCompletion.text, /\[当前待接续\]|尚未记录完成/u, '终态事项不再冒充待办');
  assert.equal(projectQianshiRecall(base, { selectedEventIds: ['missing-event'], selectedMatterIds: ['missing-matter'] }).text, '');
});

test('无年份跨月倒叙补证不倒写事项当前状态', async () => {
  const first = floor('11111111-1111-4111-8111-111111111111', 1);
  const d1 = await compileQianshiDelta({ floor: first, now: NOW, packet: { qianshi: { events: [
    { key: 'current', title: '危机当前进展', description: '十一月已经进入当前处置阶段', status: 'inProgress', matter: true, storyTime: '11月1日 08:15' },
  ], order: [] } } });
  const current = d1.events[0], second = floor('22222222-2222-4222-8222-222222222222', 2);
  const d2 = await compileQianshiDelta({ floor: second, now: NOW, candidateBindings: [{ key: 'candidate-1', matterId: current.matterId,
    latestEventIds: [current.id], latestStoryTime: current.storyTime, sourceFloorId: first.id, sourceAssistantSeq: 1 }], packet: { qianshi: { events: [
    { key: 'memory', title: '危机前夜补证', description: '补叙十月末危机发生前的线索', status: 'occurred', storyTime: '10月31日 23:15', links: [{ candidateKey: 'candidate-1', kind: 'progress' }] },
  ], order: [] } } });
  assert.equal(d2.events[0].matterId, current.matterId);
  assert.equal(d2.events[0].updatesMatter, false);
  assert.equal(d2.relations.some(relation => relation.type === 'progress'), false);
  const projection = projectQianshiGraph({ root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 2,
    floors: [first, second], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', first, d1), memory('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', second, d2)], entities: [] });
  assert.equal(projection.matters[0].title, '危机当前进展');
  assert.equal(projection.matters[0].status, 'inProgress');
});

test('progress 顺序覆盖不可比历法写法，同事项相邻同标题只保留较晚节点', async () => {
  const first = floor('11111111-1111-4111-8111-111111111111', 1);
  const d1 = await compileQianshiDelta({ floor: first, now: NOW, packet: { qianshi: { events: [
    { key: 'wedding', title: '敲定大婚核心框架', description: '先完成大婚框架', status: 'completed', matter: true, storyTime: '大陆历1686年8月26日 16:30' },
  ], order: [] } } });
  const origin = d1.events[0], second = floor('22222222-2222-4222-8222-222222222222', 2);
  const d2 = await compileQianshiDelta({ floor: second, now: NOW, candidateBindings: [{ key: 'candidate-1', matterId: origin.matterId,
    latestEventIds: [origin.id], latestStoryTime: origin.storyTime, sourceFloorId: first.id, sourceAssistantSeq: 1 }], packet: { qianshi: { events: [
    { key: 'detail-1', title: '确认婚礼细节', description: '第一次确认婚礼细节', status: 'inProgress', matter: true, storyTime: '1686-09-22 20:00', links: [{ candidateKey: 'candidate-1', kind: 'progress' }] },
    { key: 'guest', title: '婚礼细节送交礼宾官', description: '礼宾官在两次确认之间收到婚礼细节', status: 'occurred', matter: false, storyTime: '1686-09-23 12:00' },
  ], order: [] } } });
  const middle = d2.events[0], third = floor('33333333-3333-4333-8333-333333333333', 3);
  const d3 = await compileQianshiDelta({ floor: third, now: NOW, candidateBindings: [{ key: 'candidate-1', matterId: origin.matterId,
    latestEventIds: [middle.id], latestStoryTime: middle.storyTime, sourceFloorId: second.id, sourceAssistantSeq: 2 }], packet: { qianshi: { events: [
    { key: 'detail-2', title: '确认婚礼细节', description: '第二次确认婚礼细节', status: 'inProgress', matter: true, storyTime: '1686-09-24 18:45', links: [{ candidateKey: 'candidate-1', kind: 'progress' }] },
  ], order: [] } } });
  const reachable = { root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 3,
    floors: [first, second, third], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', first, d1), memory('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', second, d2), memory('ffffffff-ffff-4fff-8fff-ffffffffffff', third, d3)], entities: [] };
  const recall = projectQianshiRecall(reachable, { queryContext: { text: '婚礼细节', latestUserText: '婚礼细节' } });
  assert.match(recall.text, /大陆历1686年8月26日 16:30：敲定大婚核心框架[\s\S]*1686-09-23 12:00：婚礼细节送交礼宾官[\s\S]*1686-09-24 18:45：确认婚礼细节/u);
  assert.doesNotMatch(recall.text, /1686-09-22 20:00：确认婚礼细节/u);
});

test('召回时间线按同一纪年的明确年月日排序，并兼容末尾时段和无前缀数字日期', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'purge', title: '真理秘律院彻底清算', description: '真理秘律院时间线', status: 'occurred', matter: false, storyTime: '大陆历1686年8月5日凌晨' },
    { key: 'siege', title: '三方联合绞杀真理秘律院核心', description: '真理秘律院时间线', status: 'occurred', matter: false, storyTime: '1686-07-24 16:00' },
    { key: 'visit', title: '探访完成真理秘律院收尾确认', description: '真理秘律院时间线', status: 'occurred', matter: false, storyTime: '大陆历1686年8月6日下午' },
    { key: 'seize', title: '命令返回真理秘律院签发扣押令', description: '真理秘律院时间线', status: 'occurred', matter: false, storyTime: '大陆历1686年7月29日14:15' },
    { key: 'north', title: '北境真理秘律院新律法重任', description: '真理秘律院时间线', status: 'planned', matter: true, storyTime: '1686-10-29 17:00' },
  ], order: [] } } });
  const reachable = { root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 1,
    floors: [source], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', source, delta)], entities: [] };
  const recall = projectQianshiRecall(reachable, { queryContext: { text: '真理秘律院时间线', latestUserText: '真理秘律院时间线' } });
  assert.equal(recall.projectionVersion, 4);
  assert.match(recall.text, /1686-07-24 16:00：三方联合绞杀真理秘律院核心[\s\S]*大陆历1686年7月29日 14:15：命令返回真理秘律院签发扣押令[\s\S]*大陆历1686年8月5日凌晨：真理秘律院彻底清算[\s\S]*大陆历1686年8月6日下午：探访完成真理秘律院收尾确认[\s\S]*1686-10-29 17:00：北境真理秘律院新律法重任/u);
});

test('明确日期覆盖冲突 progress，且同日分钟可与跨事项事件一起排序', async () => {
  const first = floor('11111111-1111-4111-8111-111111111111', 1);
  const d1 = await compileQianshiDelta({ floor: first, now: NOW, packet: { qianshi: { events: [
    { key: 'start', title: '北境证据起点', description: '北境证据时间线', status: 'inProgress', matter: true, storyTime: '大陆历1686年8月5日 15:00' },
    { key: 'middle', title: '北境证据旁证', description: '北境证据时间线', status: 'occurred', matter: false, storyTime: '1686-07-29 13:00' },
  ], order: [] } } });
  const origin = d1.events[0], second = floor('22222222-2222-4222-8222-222222222222', 2);
  const d2 = await compileQianshiDelta({ floor: second, now: NOW, candidateBindings: [{ key: 'candidate-1', matterId: origin.matterId,
    latestEventIds: [origin.id], latestStoryTime: origin.storyTime, sourceFloorId: first.id, sourceAssistantSeq: 1 }], packet: { qianshi: { events: [
    { key: 'earlier-progress', title: '北境证据倒叙进展', description: '北境证据时间线', status: 'inProgress', matter: true, storyTime: '大陆历1686年7月29日14:15', links: [{ candidateKey: 'candidate-1', kind: 'progress' }] },
  ], order: [] } } });
  const reachable = { root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 2,
    floors: [first, second], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', first, d1), memory('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', second, d2)], entities: [] };
  const recall = projectQianshiRecall(reachable, { queryContext: { text: '北境证据时间线', latestUserText: '北境证据时间线' } });
  assert.match(recall.text, /1686-07-29 13:00：北境证据旁证[\s\S]*大陆历1686年7月29日 14:15：北境证据倒叙进展[\s\S]*大陆历1686年8月5日 15:00：北境证据起点/u);
});

test('不同明确纪年和未知时间不互相猜测，保持既有来源顺序', async () => {
  const times = ['大陆历1686年8月5日', '木叶历1686年7月1日', '时间未知', '公元1686年6月1日'];
  const floorIds = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
  const memoryIds = ['dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'ffffffff-ffff-4fff-8fff-ffffffffffff', '99999999-9999-4999-8999-999999999999'];
  const floors = [], memories = [];
  for (let index = 0; index < times.length; index += 1) {
    const source = floor(floorIds[index], index + 1);
    const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
      { key: `calendar-${index}`, title: `纪年边界事件${index + 1}`, description: '纪年边界共同线索', status: 'occurred', matter: false, storyTime: times[index] },
    ], order: [] } } });
    floors.push(source); memories.push(memory(memoryIds[index], source, delta));
  }
  const reachable = { root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 4,
    floors, floorMemories: memories, entities: [] };
  const recall = projectQianshiRecall(reachable, { queryContext: { text: '纪年边界共同线索', latestUserText: '纪年边界共同线索' } });
  assert.match(recall.text, /大陆历1686年8月5日：纪年边界事件1[\s\S]*木叶历1686年7月1日：纪年边界事件2[\s\S]*时间未知：纪年边界事件3[\s\S]*公元1686年6月1日：纪年边界事件4/u);
});

test('同聊天未入选的第二纪年仍阻止无前缀日期误借纪年', async () => {
  const times = ['大陆历1686年8月5日', '木叶历1686年7月1日', '1686-07-24 16:00'];
  const titles = ['裁决线索清算', '无关异历事件', '裁决线索围剿'];
  const floorIds = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
  const memoryIds = ['dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'ffffffff-ffff-4fff-8fff-ffffffffffff'];
  const floors = [], memories = [];
  for (let index = 0; index < times.length; index += 1) {
    const source = floor(floorIds[index], index + 1);
    const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
      { key: `evidence-${index}`, title: titles[index], description: index === 1 ? '完全无关内容' : '裁决线索共同词', status: 'occurred', matter: false, storyTime: times[index] },
    ], order: [] } } });
    floors.push(source); memories.push(memory(memoryIds[index], source, delta));
  }
  const reachable = { root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 3,
    floors, floorMemories: memories, entities: [] };
  const recall = projectQianshiRecall(reachable, { queryContext: { text: '裁决线索共同词', latestUserText: '裁决线索共同词' } });
  assert.match(recall.text, /大陆历1686年8月5日：裁决线索清算[\s\S]*1686-07-24 16:00：裁决线索围剿/u);
  assert.doesNotMatch(recall.text, /无关异历事件/u);
});

test('多项近期待办和长文本时间线共享总预算时仍保留当前待接续', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const events = Array.from({ length: 48 }, (_, index) => ({
    key: `near-${index}`, title: `北境安排${index + 1}${'完整标题'.repeat(8)}`, description: `北境安排的详细记录${index + 1}${'背景'.repeat(20)}`,
    status: 'planned', matter: true, storyTime: `2026-06-15 00:${String(index % 10).padStart(2, '0')}`,
  }));
  const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events, order: [] } } });
  const reachable = { root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 1,
    floors: [source], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', source, delta)], entities: [] };
  const currentTime = projectTime('2026-06-15 00:10');
  const recall = projectQianshiRecall(reachable, { queryContext: { text: '北境安排', latestUserText: '北境安排' }, currentTime,
    recentStoryTimes: [projectTime('2026-06-14 23:50'), currentTime] });
  assert.match(recall.text, /\[相关时间线\]/u);
  assert.match(recall.text, /\[当前待接续\][\s\S]*尚未记录完成/u);
  assert.ok(recall.text.length <= 4000);
});
