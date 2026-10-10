import test from 'node:test';
import assert from 'node:assert/strict';
import { compileQianshiDelta, createQianshiCandidateIndex, effectiveQianshiDelta, orderQianshiLineRecords, prepareQianshiCandidates, prepareQianshiRecallCandidates, projectQianshiCandidateSelection, projectQianshiGraph, projectQianshiRecall, projectQianshiTimeline, publicQianshiSnapshot } from '../src/v3/qianshi-domain.js';
import { projectTime, timeDistance, formatStoryTimeFields, storyTimeFields } from '../src/v3/time-engine.js';
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

test('一次性日常事件有自己的单记录线但不成为待接续事项，计划建立可持续事项线', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'drink', title: '喝水', description: '喝了一杯水', status: 'occurred', matter: false },
    { key: 'meet', title: '钟楼会面', description: '约好明晚在钟楼会面', status: 'planned', matter: true, scheduledTime: '明晚' },
  ], order: [] } } });
  assert.equal(delta.status, 'ready');
  assert.deepEqual(delta.events.map(event => [Boolean(event.matterId), event.updatesMatter]), [[true, false], [true, true]]);
  const projection = projectQianshiGraph({ root: { narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 1,
    floors: [source], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', source, delta)], entities: [] });
  assert.equal(projection.events.length, 2);
  assert.equal(projection.matters.length, 2);
  const oneOff = projection.matters.find(item => item.recordIds.includes(delta.events[0].id));
  assert.equal(oneOff.currentEventId, null);
  assert.deepEqual(oneOff.recordIds, [delta.events[0].id]);
  assert.match(projection.currentProgress.text, /钟楼会面/u);
  assert.doesNotMatch(projection.currentProgress.text, /喝水/u);
  const snapshot = publicQianshiSnapshot({ root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 1,
    floors: [source], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', source, delta)], entities: [] });
  assert.equal(snapshot.events[0].sourceMessageIndex, 2, '来源楼号沿用现有 hostLocator.messageIndex 显示惯例，不自行加一');
  assert.equal(snapshot.timeline.undatedEventIds.length, 2);
  const archived = publicQianshiSnapshot({ root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 1,
    floors: [source], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', source, delta)], entities: [], migrationDescriptor: {
      frozenFloorIds: [source.id], floorOrigins: [{ floorId: source.id, sourceChatId: CHAT, sourceHostChatId: 'source-file', sourceMessageIndex: 8 }], carriedAliases: [],
    } });
  assert.equal(archived.events[0].frozen, true);
  assert.equal(archived.events[0].sourceOrigin.sourceMessageIndex, 8, '千事年表明确保留来源聊天楼号');
});

test('编译分离局部动作与整线状态，倒叙进展保留事项链接且人工终态不重开', async () => {
  const first = floor('11111111-1111-4111-8111-111111111111', 1);
  const second = floor('22222222-2222-4222-8222-222222222222', 2);
  const originDelta = await compileQianshiDelta({ floor: first, now: NOW, packet: { qianshi: { events: [
    { key: 'return', title: '归还旧书', description: '准备归还旧书', status: 'inProgress', matter: true, storyTime: '2026-07-30 10:00' },
  ], order: [] } } });
  const origin = originDelta.events[0];
  const candidate = { key: 'candidate-1', kind: 'matter', matterId: origin.matterId, latestEventIds: [origin.id], latestStoryTime: '2026年7月30日 10:00' };
  const progress = await compileQianshiDelta({ floor: second, now: NOW, candidateBindings: [candidate], packet: { qianshi: { events: [
    { key: 'legacy', title: '倒叙提及', description: '后来回忆旧书', status: 'occurred', matter: false, storyTime: '2026-07-01 10:00', links: [{ candidateKey: candidate.key, kind: 'progress' }] },
    { key: 'new-shape', title: '本次整理', description: '动作完成但仍需继续', status: 'inProgress', actionStatus: 'completed', storyTime: '2026-07-31 10:00', links: [{ candidateKey: candidate.key, kind: 'progress' }] },
    { key: 'compatible-shape', title: '兼容格式', description: '另一条进展', lineStatus: 'inProgress', status: 'occurred', links: [{ candidateKey: candidate.key, kind: 'progress' }] },
  ], order: [] } } });
  assert.equal(progress.status, 'ready');
  assert.deepEqual(progress.events.map(event => [event.status, event.actionStatus ?? null, event.matterId, event.updatesMatter]), [
    ['occurred', null, origin.matterId, true], ['inProgress', 'completed', origin.matterId, true], ['inProgress', 'occurred', origin.matterId, true],
  ], '旧形状兼容且时间倒叙不会被本地编译器降成背景');

  const terminalOverride = { ...originDelta, trackingOverrides: [{ matterId: origin.matterId, following: true }],
    manualMatterStatusOverrides: [{ matterId: origin.matterId, status: 'completed' }] };
  const reachable = { root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: '33333333-3333-4333-8333-333333333333' }, rootRevision: 1,
    floors: [first], floorMemories: [memory('44444444-4444-4444-8444-444444444444', first, terminalOverride)], entities: [] };
  const matter = projectQianshiGraph(reachable).matters[0];
  assert.equal(matter.status, 'completed');
  assert.equal(matter.manualStatusOverride, 'completed');
  assert.equal(matter.following, false, 'tracking=true 不推翻人工终态');
  assert.equal(prepareQianshiCandidates(reachable, { canonicalContent: '继续归还旧书' }).request.length, 0,
    '精确提及与旧 tracking following 不能重新放入人工终态事项');

  const nonterminalOverride = { ...originDelta, manualMatterStatusOverrides: [{ matterId: origin.matterId, status: 'inProgress' }] };
  reachable.floorMemories = [memory('55555555-5555-4555-8555-555555555555', first, nonterminalOverride)];
  assert.equal(prepareQianshiCandidates(reachable, { canonicalContent: '继续归还旧书' }).request[0].status, 'inProgress',
    '人工非终态仍作为权威候选状态');
});

test('progress 不能把一次性旧事件升级成事项，context 与先后端点仍可引用旧事件', async () => {
  const first = floor('11111111-1111-4111-8111-111111111111', 73);
  const second = floor('22222222-2222-4222-8222-222222222222', 74);
  const oneOff = await compileQianshiDelta({ floor: first, now: NOW, packet: { qianshi: { events: [
    { key: 'fact', title: '收到旧信', description: '收到一封旧信', status: 'occurred', matter: false },
  ], order: [] } } });
  const prior = oneOff.events[0];
  const candidate = { key: 'candidate-1', kind: 'event', matterId: prior.matterId, latestEventIds: [prior.id], latestStoryTime: null };
  const invalid = await compileQianshiDelta({ floor: second, now: NOW, candidateBindings: [candidate], packet: { qianshi: { events: [
    { key: 'followup', title: '旧信后续', description: '又提到那封旧信', status: 'occurred', links: [{ candidateKey: candidate.key, kind: 'progress' }] },
  ], order: [] } } });
  assert.equal(invalid.status, 'pending', '只有无效 progress 时不生成一个看似成功的新线');
  assert.equal(invalid.events.length, 0);
  assert.match(invalid.reason, /一次性记录当作持续事项/u);

  const context = await compileQianshiDelta({ floor: second, now: NOW, candidateBindings: [candidate], packet: { qianshi: { events: [
    { key: 'context', title: '旧信补充', description: '补充说明那封旧信的来源', status: 'occurred', links: [{ candidateKey: candidate.key, kind: 'context' }] },
  ], order: [{ before: candidate.key, after: 'context' }] } } });
  assert.equal(context.status, 'ready');
  assert.equal(context.events[0].matterId, null, '一次性 singleton 的 context 只引用旧事件，不继承成事项线');
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
  assert.equal(delta.status, 'partial', '坏事件单项忽略，其余合法事件已入档并留下可见原因');
  assert.equal(delta.events.length, 1);
  const allInvalid = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'missing', title: '', description: '缺少标题', status: 'occurred' },
  ], order: [] } } });
  assert.equal(allInvalid.status, 'pending', '所有事件都无法编译时不伪称已完成');
  assert.match(allInvalid.reason, /缺少有效标题或说明/u);
  assert.doesNotMatch(allInvalid.reason, /QIANSHI_|events\[|progress|context|partial/u);
});

test('千事显式坏状态只拒绝对应事件，旧缺省与 lineStatus/status 别名仍可整理', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 76);
  const compiled = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'legacy', title: '旧格式事件', description: '旧存档没有提供状态', matter: false },
    { key: 'alias', title: '兼容格式事件', description: '整线与动作沿旧字段表达', lineStatus: 'inProgress', status: 'occurred', matter: true },
    { key: 'bad-line', title: '坏整线状态', description: '显式整线状态不可识别', status: 'finished-ish', matter: true },
    { key: 'bad-alias', title: '坏兼容动作状态', description: '显式动作状态不可识别', lineStatus: 'inProgress', status: 'maybe', matter: true },
    { key: 'bad-action', title: '坏新动作状态', description: '显式 actionStatus 不可识别', status: 'inProgress', actionStatus: 'maybe', matter: true },
  ], order: [] } } });
  assert.equal(compiled.status, 'partial');
  assert.deepEqual(compiled.events.map(event => [event.title, event.status, event.actionStatus ?? null]), [
    ['旧格式事件', 'occurred', null], ['兼容格式事件', 'inProgress', 'occurred'],
  ], '保留旧缺省回退和已支持的 lineStatus/status 字段兼容');
  assert.match(compiled.reason, /整线或动作状态无法识别/u);

  const allInvalid = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'bad', title: '坏状态事件', description: '显式错误状态不能回退成功', status: 'finished-ish' },
  ], order: [] } } });
  assert.equal(allInvalid.status, 'pending', '全坏状态不能冒充 empty 或 ready');
  assert.equal(allInvalid.events.length, 0);
  assert.match(allInvalid.reason, /整线或动作状态无法识别/u);
  assert.doesNotMatch(allInvalid.reason, /完成|empty|ready|QIANSHI_/u);
});

test('历史候选池能以命名空间 singleton 读取旧一次性事件供 context 使用，但拒绝将其当作 progress', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 73);
  const next = floor('22222222-2222-4222-8222-222222222222', 74);
  const compiled = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'fact', title: '收到旧信', description: '顾舟收到旧信并保存', status: 'occurred', matter: false },
  ], order: [] } } });
  const delta = validateQianshiDelta({ ...compiled, events: compiled.events.map(event => ({ ...event, matterId: null })) }, { floorId: source.id });
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
  assert.equal(progress.status, 'pending', '无效 progress link 不自动降级为新事项');
  assert.equal(progress.events.length, 0);
  assert.match(progress.reason, /一次性记录当作持续事项/u);
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

test('千事时间轴保留时间原文，只按明确可比的普通日期或同一特殊月份排序', () => {
  const event = (id, storyTime, parsedStoryTime = projectTime(storyTime)) => ({ id, storyTime, parsedStoryTime });
  const events = [
    event('aug', '大陆历1686年8月5日凌晨'),
    event('july-late', '1686-07-29 16:00'),
    event('july-early', '大陆历1686年7月29日14:15'),
    event('july-earlier-day', '大陆历1686年7月28日'),
    event('other-era', '星海历1687年7月1日'),
    event('unknown', '苍月祭后'),
    event('era-source', '纪元年10月4日', { ...projectTime('纪1年10月4日'), raw: '纪元年10月4日' }),
    event('era-source-next', '纪元年10月5日', { ...projectTime('纪1年10月5日'), raw: '纪元年10月5日' }),
    event('named-era-source', '星辉历纪元年霜月初四', { ...projectTime('纪1年10月4日'), raw: '星辉历纪元年霜月初四' }),
    event('bare-year-source', '3053年10月4日'),
  ];
  const timeline = projectQianshiTimeline({ events, relations: [{ type: 'progress', fromEventId: 'aug', toEventId: 'july-late' }] });
  const segmentFor = id => timeline.segments.find(segment => segment.groups.some(group => group.eventIds.includes(id)));
  assert.deepEqual(segmentFor('july-late').groups.flatMap(group => group.eventIds), ['july-late', 'bare-year-source'], '普通明确年月日跨年按真实公历日期顺序');
  assert.equal(segmentFor('aug').id, segmentFor('july-early').id, '同一具名纪年的数字年月进入同一完整年表排序域');
  assert.equal(segmentFor('july-early').groups[0].day, '28日', '同一特殊月份内仍按明确日号排序');
  assert.match(segmentFor('july-early').groups[0].period, /大陆历1686年7月/u, '完整年表标题保留原文纪年月线索');
  assert.deepEqual(segmentFor('july-early').groups.map(group => group.period), ['大陆历1686年7月', '大陆历1686年7月', '大陆历1686年8月']);
  assert.equal(timeline.segments.length, 5, '普通完整日期、具名纪年数字域及其他特殊时间身份分别成组');
  assert.equal(timeline.hasGlobalLatest, false, '存在不可比时间组时不伪造全局最近');
  assert.deepEqual(timeline.undatedEventIds, ['unknown']);
  const eraMonth = segmentFor('era-source').groups.find(group => group.eventIds.includes('era-source'));
  assert.deepEqual(segmentFor('era-source').groups.flatMap(group => group.eventIds), ['era-source', 'era-source-next'], '同一特殊纪年月份按日号排序');
  assert.equal(eraMonth.day, '4日', '具名历法沿用投影得到的月日');
  assert.equal(eraMonth.full, '纪元年10月4日', '具名纪年的完整原文仍保留');
});

test('完整年表用显式配置历法解析范围起点并合并同纪年数字月份', async () => {
  const source = floor('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa21', 21);
  const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'range', title: '跨月范围', description: '范围保留原文', status: 'occurred', matter: false, storyTime: '启航387年4月30日 23:00→启航387年5月1日 01:00' },
    { key: 'may', title: '五月单日', description: '同一纪年', status: 'occurred', matter: false, storyTime: '启航387年5月3日 17:30' },
    { key: 'april', title: '四月单日', description: '更早日期', status: 'occurred', matter: false, storyTime: '启航387年4月12日' },
    { key: 'clock', title: '纯钟点', description: '没有日期锚点', status: 'occurred', matter: false, storyTime: '18:30' },
    { key: 'other-prefix', title: '另一纪年', description: '不同前缀保持隔离', status: 'occurred', matter: false, storyTime: '异历387年5月2日' },
    { key: 'season', title: '具名季节', description: '季节月不并入数字月', status: 'occurred', matter: false, storyTime: '星历1年夏1日' },
  ], order: [] } } });
  const reachable = { root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 1,
    floors: [source], floorMemories: [memory('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', source, delta)], entities: [] };
  const calendar = { months: 12, prefix: '启航' };
  const configured = publicQianshiSnapshot(reachable, null, null, calendar);
  assert.equal(configured.timeline.segments.length, 3, '范围/单点在配置域排序，不同纪年前缀与季节月保持独立');
  const configuredSegment = configured.timeline.segments.find(segment => segment.id.startsWith('calendar:'));
  assert.equal(configuredSegment.label, '完整日期');
  assert.deepEqual(configuredSegment.groups.map(group => [group.period, group.day]), [
    ['启航387年4月', '12日'], ['启航387年4月', '30日'], ['启航387年5月', '3日'],
  ], '历法日期按实际年月日排序，范围按左端点归入四月30日');
  const aprilRange = configuredSegment.groups[1];
  assert.ok(aprilRange.eventIds.includes(configured.events.find(event => event.title === '跨月范围').id));
  assert.equal(configured.events.find(event => event.title === '跨月范围').storyTime, '启航387年4月30日 23:00→启航387年5月1日 01:00', '投影保留原始范围文本');
  assert.ok(configured.timeline.undatedEventIds.includes(delta.events.find(event => event.title === '纯钟点').id), '没有日期锚点的纯钟点不推测日期');
  assert.equal(configuredSegment.latestGroupId, configuredSegment.groups[2].id);
  assert.equal(configured.timeline.hasGlobalLatest, false, '存在未定日期的纯钟点时不宣称全局最近');
  const configuredIds = new Set(configuredSegment.groups.flatMap(group => group.eventIds));
  assert.equal(configuredIds.has(configured.events.find(event => event.title === '另一纪年').id), false);
  assert.equal(configuredIds.has(configured.events.find(event => event.title === '具名季节').id), false);

  const unconfigured = publicQianshiSnapshot(reachable);
  assert.match(configuredSegment.id, /^calendar:/u, '当前显式历法进入其已配置排序域');
  assert.match(unconfigured.timeline.segments[0].id, /^era-numeric:启航/u, '无配置时只按原有文本纪年身份排序，不冒充已配置历法');
});

test('四月制显式历法解析季节范围与单点，不把另一纪年前缀并入配置域', async () => {
  const source = floor('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa22', 22);
  const makeDelta = packet => compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: packet, order: [] } } });
  const calendar = { months: 4, prefix: '启航' };
  const events = [
    { key: 'season-single', title: '夏月单点', description: '四月制单点', status: 'occurred', matter: false, storyTime: '启航1年夏1日 08:00' },
    { key: 'season-range', title: '夏月范围', description: '四月制范围', status: 'occurred', matter: false, storyTime: '启航1年夏2日 10:00-10:30' },
    { key: 'season-same-day', title: '夏月同日单点', description: '与范围起点同日', status: 'occurred', matter: false, storyTime: '启航1年夏2日 10:15' },
  ];
  const delta = await makeDelta(events);
  const reachable = { root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 1,
    floors: [source], floorMemories: [memory('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', source, delta)], entities: [] };
  const configured = publicQianshiSnapshot(reachable, null, null, calendar);
  assert.equal(configured.timeline.segments.length, 1);
  assert.equal(configured.timeline.segments[0].id, 'calendar:[4,"启航"]:dated');
  assert.deepEqual(configured.timeline.segments[0].groups.map(group => [group.period, group.day]), [['启航1年2月', '1日'], ['启航1年2月', '2日']]);
  assert.equal(configured.timeline.hasGlobalLatest, true);
  assert.equal(configured.timeline.globalLatestGroupId, configured.timeline.segments[0].groups[1].id);
  assert.equal(configured.events.find(event => event.title === '夏月范围').storyTime, '启航1年夏2日 10:00-10:30');
  assert.equal(configured.timeline.segments[0].groups[1].eventIds.length, 2, '同日单点与范围起点进入同一日期组');
  assert.equal(new Set(configured.timeline.segments.flatMap(segment => segment.groups.flatMap(group => group.eventIds))).size, 3,
    '每条正式事件只进入一个日期组');

  const withOtherEra = await makeDelta([...events,
    { key: 'different-era', title: '不同纪年', description: '保持独立时间身份', status: 'occurred', matter: false, storyTime: '异历1年夏2日' },
  ]);
  reachable.floorMemories = [memory('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3', source, withOtherEra)];
  const separated = publicQianshiSnapshot(reachable, null, null, calendar);
  assert.equal(separated.timeline.segments.length, 2, '不匹配配置前缀的具名季节日期保留独立时间域');
  const configuredSegment = separated.timeline.segments.find(segment => segment.id.startsWith('calendar:'));
  const otherEraSegment = separated.timeline.segments.find(segment => segment.id.startsWith('special:'));
  assert.equal(configuredSegment.groups.flatMap(group => group.eventIds).length, 3);
  assert.deepEqual(otherEraSegment.groups.flatMap(group => group.eventIds), [withOtherEra.events[3].id]);
  assert.equal(separated.timeline.hasGlobalLatest, false, '两个不相容时间域不推断全局最近');
});

test('召回时间线沿用单楼已确认日期中的纯钟点且不推定月日或手工时间', () => {
  const events = [
    { id: 'anchored-clock', storyTime: '10:30', parsedStoryTime: projectTime('2047年10月25日 10:30') },
    { id: 'anchored-clock-with-floor-range', storyTime: '10:30', parsedStoryTime: {
      ...projectTime('10:30', projectTime('2047年10月25日')),
      rangeText: '2047年10月25日 周五10:30→2047年10月25日 周五11:15',
    } },
    { id: 'explicit-old-date', storyTime: '2047年10月24日 23:00', parsedStoryTime: projectTime('2047年10月24日 23:00') },
    { id: 'month-day', storyTime: '10月25日 12:00', parsedStoryTime: projectTime('10月25日 12:00') },
    { id: 'manual-clock-only', storyTime: '10:30', parsedStoryTime: projectTime('10:30') },
    { id: 'aggregate-clock-only', storyTime: '10:30', parsedStoryTime: projectTime('10:30') },
  ];
  const timeline = projectQianshiTimeline({ events, relations: [] });
  const segmentFor = id => timeline.segments.find(segment => segment.groups.some(group => group.eventIds.includes(id)));
  assert.equal(segmentFor('anchored-clock')?.id, 'dated', '普通楼的事件纯钟点沿用已锚定的楼日期');
  assert.equal(segmentFor('anchored-clock-with-floor-range')?.id, 'dated', '继承楼层范围的事件纯钟点仍沿用同一已锚定日期');
  const anchoredGroup = segmentFor('anchored-clock')?.groups.find(group => group.eventIds.includes('anchored-clock'));
  assert.equal(anchoredGroup?.period, '2047年10月', '归组日期是已确认的 2047-10-25');
  assert.equal(anchoredGroup?.day, '25日');
  const inheritedRangeGroup = segmentFor('anchored-clock-with-floor-range')?.groups.find(group => group.eventIds.includes('anchored-clock-with-floor-range'));
  assert.equal(inheritedRangeGroup?.period, anchoredGroup?.period, '是否携带楼层 rangeText 不改变钟点归组');
  assert.equal(inheritedRangeGroup?.day, anchoredGroup?.day);
  assert.equal(segmentFor('explicit-old-date')?.groups[0]?.day, '24日', '事件原文明确旧日期优先');
  assert.equal(segmentFor('month-day')?.id, 'month-day', '只有月日仍不猜年份');
  assert.ok(timeline.undatedEventIds.includes('manual-clock-only'), '仅手工填写钟点不继承旧日期');
  assert.ok(timeline.undatedEventIds.includes('aggregate-clock-only'), '聚合来源只有钟点仍未定');
});

test('正式图投影中纯钟点事件在有无楼层范围时都沿用该楼确认日期', async () => {
  const source = floor('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01', 1);
  const range = '2047年10月25日 周五10:30→2047年10月25日 周五11:15';
  const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'clock', title: '收到旧笛', description: '本楼纯钟点事件。', status: 'occurred', matter: false, storyTime: '10:30' },
  ], order: [] } } });
  const timelineFor = chronology => projectQianshiTimeline(projectQianshiGraph({ floors: [source], floorMemories: [
    { ...memory('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', source, delta), chronology },
  ], entities: [] }));
  const dated = timelineFor([{ time: { sourceText: '2047年10月25日', normalized: '2047年10月25日', kind: 'explicit' } }]);
  const ranged = timelineFor([{ time: { sourceText: range, normalized: null, kind: 'explicit' } }]);
  const groupFor = timeline => timeline.segments.flatMap(segment => segment.groups).find(group => group.eventIds.length)?.day;
  assert.equal(groupFor(dated), '25日', '不带楼层范围时纯钟点沿用已确认日期');
  assert.equal(groupFor(ranged), groupFor(dated), '楼层 rangeText 不应盖过事件原文纯钟点');
  assert.equal(ranged.undatedEventIds.length, 0);
});

test('千事时间轴可按末尾说明括注归组，括注时间不伪装成精确钟点', () => {
  const rawTimes = [
    ['described-clock', '1年夏1日 周一 18:00(匿名说明)'],
    ['parenthetical-clock', '1年夏1日 周一 (18:00)'],
    ['approximate-clock', '1年夏1日 周一（约18:00）'],
    ['conflicting-date', '1年夏1日 周一（1年夏2日）'],
  ];
  const events = rawTimes.map(([id, storyTime]) => ({ id, storyTime, parsedStoryTime: projectTime(storyTime) }));
  const timeline = projectQianshiTimeline({ events, relations: [] });
  const grouped = new Set(timeline.segments.flatMap(segment => segment.groups.flatMap(group => group.eventIds)));
  for (const [id] of rawTimes.slice(0, 3)) assert.equal(grouped.has(id), true, `${id} 按外层日期归组`);
  assert.equal(grouped.has('conflicting-date'), false, '括注日期冲突时保持未定');
  assert.deepEqual(timeline.undatedEventIds, ['conflicting-date']);
  assert.equal(events[0].storyTime, '1年夏1日 周一 18:00(匿名说明)', '时间线投影不改写存储原文');
});

test('千事保留带约略钟点的明确日期，但不按约略分钟排序；约略日期仍未定', async () => {
  const events = [
    { id: 'special-approx', storyTime: '1年夏1日 周一 18:00左右' },
    { id: 'special-prefix-approx', storyTime: '1年夏1日 周一 约18:00' },
    { id: 'special-exact', storyTime: '1年夏1日 周一 17:00' },
    { id: 'john-era-late', storyTime: '约翰历1年夏1日 18:00' },
    { id: 'john-era-early', storyTime: '约翰历1年夏1日 17:00' },
    { id: 'york-era-late', storyTime: '约克历1年夏1日 18:00' },
    { id: 'york-era-early', storyTime: '约克历1年夏1日 17:00' },
    { id: 'approx-era-word-late', storyTime: '大约历1年夏1日 18:00' },
    { id: 'approx-era-word-early', storyTime: '大约历1年夏1日 17:00' },
    { id: 'gregorian-approx', storyTime: '公历2026年5月10日 18:00左右' },
    { id: 'approx-date', storyTime: '2026年5月10日左右' },
    { id: 'approx-date-exact-clock', storyTime: '2026年5月10日左右 18:00' },
    { id: 'approx-date-approx-clock', storyTime: '2026年5月10日左右 18:00左右' },
    { id: 'prefix-approx-date', storyTime: '大约2026年5月10日 18:00' },
    { id: 'special-prefix-approx-date', storyTime: '大约1年夏1日 周一 18:00' },
    { id: 'approx-date-before-clock', storyTime: '1年夏1日 周一左右 18:00' },
    { id: 'paren-approx-date', storyTime: '2026年5月10日（左右）' },
    { id: 'paren-approx-date-clock', storyTime: '2026年5月10日（左右） 18:00' },
    { id: 'paren-special-approx-date', storyTime: '1年夏1日 周一（左右）' },
    { id: 'paren-approx-clock', storyTime: '2026年5月10日 18:00（左右）' },
    { id: 'paren-approx-clock-ascii', storyTime: '2026年5月10日 18:00 (左右)' },
    { id: 'ordinary-note-clock', storyTime: '2026年5月10日 18:00（补充说明）' },
    { id: 'clock-only', storyTime: '18:00左右' },
  ].map(event => ({ ...event, parsedStoryTime: projectTime(event.storyTime) }));
  const timeline = projectQianshiTimeline({ events, relations: [] });
  const groupFor = id => timeline.segments.flatMap(segment => segment.groups).find(group => group.eventIds.includes(id));
  assert.ok(groupFor('special-approx'), '具名历法的明确日期仍进入对应日期组');
  assert.ok(groupFor('special-prefix-approx'), '约在钟点前时保留具名历法日期');
  assert.ok(groupFor('gregorian-approx'), '公历明确日期仍进入对应日期组');
  for (const [lateId, earlyId] of [['john-era-late', 'john-era-early'], ['york-era-late', 'york-era-early'], ['approx-era-word-late', 'approx-era-word-early']]) {
    const group = groupFor(lateId);
    assert.ok(group?.eventIds.includes(earlyId), `${lateId} 保留具名纪年并按精确钟点排序`);
    assert.ok(group.eventIds.indexOf(earlyId) < group.eventIds.indexOf(lateId), `${lateId} 的 18:00 在 17:00 后`);
  }
  assert.equal(groupFor('special-approx').eventIds[0], 'special-approx', '约略钟点不把 18:00 当精确分钟排到 17:00 之后');
  assert.equal(events[1].parsedStoryTime.minute, null, '钟点前的约略词也不产生分钟');
  assert.equal(events[0].parsedStoryTime.minute, null, '约略分钟不进入共享时间投影');
  assert.equal(groupFor('approx-date'), undefined, '日期本身约略时不冒充确定日期');
  assert.equal(groupFor('approx-date-exact-clock'), undefined, '约略日期后接精确钟点仍留在未定组');
  assert.equal(groupFor('approx-date-approx-clock'), undefined, '约略日期和钟点均不提供精确日期');
  for (const id of ['prefix-approx-date', 'special-prefix-approx-date', 'approx-date-before-clock']) {
    assert.equal(groupFor(id), undefined, `${id} 的约略日期不能进入确定日期组`);
  }
  for (const id of ['paren-approx-date', 'paren-approx-date-clock', 'paren-special-approx-date']) {
    assert.equal(groupFor(id), undefined, `${id} 的日期约略括注不能进入确定日期组`);
  }
  assert.ok(groupFor('paren-approx-clock'), '钟点约略括注保留明确日期');
  assert.ok(groupFor('paren-approx-clock-ascii'), '英文括号内的钟点约略括注保留明确日期');
  assert.ok(groupFor('ordinary-note-clock'), '普通括注继续保留明确日期');
  assert.equal(events.find(event => event.id === 'paren-approx-clock').parsedStoryTime.minute, null);
  assert.equal(events.find(event => event.id === 'ordinary-note-clock').parsedStoryTime.minute, 18 * 60);
  assert.deepEqual(timeline.undatedEventIds, ['approx-date', 'approx-date-exact-clock', 'approx-date-approx-clock', 'prefix-approx-date', 'special-prefix-approx-date', 'approx-date-before-clock', 'paren-approx-date', 'paren-approx-date-clock', 'paren-special-approx-date', 'clock-only'], '约略日期和只有钟点的事件留在未定组');
  assert.equal(events[0].storyTime, '1年夏1日 周一 18:00左右', '保留原始时间文本');

  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'approx-recall', title: '蓝信会面约略时刻', description: '蓝信会面约略时刻记录', status: 'occurred', matter: false, storyTime: '1年夏1日 18:00左右' },
    { key: 'exact-recall', title: '蓝信会面精确时刻', description: '蓝信会面精确时刻记录', status: 'occurred', matter: false, storyTime: '1年夏1日 17:00' },
    { key: 'named-era-late-recall', title: '蓝信会面约翰历18时', description: '蓝信会面约翰历18时记录', status: 'occurred', matter: false, storyTime: '约翰历1年夏1日 18:00' },
    { key: 'named-era-early-recall', title: '蓝信会面约翰历17时', description: '蓝信会面约翰历17时记录', status: 'occurred', matter: false, storyTime: '约翰历1年夏1日 17:00' },
    { key: 'approx-date-recall', title: '蓝信会面日期范围时刻', description: '蓝信会面日期范围时刻记录', status: 'occurred', matter: false, storyTime: '2026年5月10日左右 18:00' },
    { key: 'prefix-approx-date-recall', title: '蓝信会面前置范围日期', description: '蓝信会面前置范围日期记录', status: 'occurred', matter: false, storyTime: '大约2026年5月10日 18:00' },
    { key: 'special-approx-date-recall', title: '蓝信会面特殊历法范围日期', description: '蓝信会面特殊历法范围日期记录', status: 'occurred', matter: false, storyTime: '大约1年夏1日 周一 18:00' },
    { key: 'trailing-approx-date-recall', title: '蓝信会面日期后置模糊词', description: '蓝信会面日期后置模糊词记录', status: 'occurred', matter: false, storyTime: '1年夏1日 周一左右 18:00' },
    { key: 'paren-approx-clock-recall', title: '蓝信会面括注约略时刻', description: '蓝信会面括注约略时刻记录', status: 'occurred', matter: false, storyTime: '2026年5月10日 18:00（左右）' },
    { key: 'paren-exact-clock-recall', title: '蓝信会面括注前精确时刻', description: '蓝信会面括注前精确时刻记录', status: 'occurred', matter: false, storyTime: '2026年5月10日 17:00' },
    { key: 'exact-date-recall', title: '蓝信会面确定日期时刻', description: '蓝信会面确定日期时刻记录', status: 'occurred', matter: false, storyTime: '2026年5月10日 17:00' },
  ], order: [] } } });
  const reachable = { floors: [source], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', source, delta)], entities: [] };
  const recall = projectQianshiRecall(reachable, { queryContext: { text: '蓝信会面', latestUserText: '蓝信会面' } });
  assert.match(recall.text, /蓝信会面约略时刻[\s\S]*蓝信会面精确时刻/u,
    '召回排序使用同一解析结果，约略18:00不会压过明确17:00形成伪顺序');
  assert.match(recall.text, /蓝信会面约翰历17时[\s\S]*蓝信会面约翰历18时/u,
    '以“约”开头的具名纪年仍按其精确钟点参与召回排序');
  assert.match(recall.text, /蓝信会面日期范围时刻[\s\S]*蓝信会面确定日期时刻/u,
    '约略日期加精确钟点不能冒充确定日期参与召回排序');
  assert.match(recall.text, /蓝信会面前置范围日期[\s\S]*蓝信会面确定日期时刻/u,
    '日期前置约略词不能变成纪年并参与召回排序');
  assert.match(recall.text, /蓝信会面特殊历法范围日期[\s\S]*蓝信会面确定日期时刻/u,
    '特殊历法日期前置约略词同样不能参与精确排序');
  assert.match(recall.text, /蓝信会面日期后置模糊词[\s\S]*蓝信会面确定日期时刻/u,
    '日期后的范围词不会因钟点存在而留下精确分钟排序');
  assert.match(recall.text, /蓝信会面括注约略时刻[\s\S]*蓝信会面括注前精确时刻/u,
    '钟点后的左右括注清除分钟排序，但保留日期');
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
  assert.equal(timeline.segments.find(segment => segment.groups.some(group => group.eventIds.includes(delta.events[2].id))).id, 'dated');
  assert.equal(timeline.segments.find(segment => segment.groups.some(group => group.eventIds.includes(delta.events[3].id))).id, 'dated');

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
  assert.equal(segmentFor('date-0'), 'dated');
  assert.equal(segmentFor('date-1'), 'dated');
  assert.equal(segmentFor('date-2'), 'dated');
  assert.equal(segmentFor('date-4'), 'dated');
  assert.equal(segmentFor('date-7'), 'dated', '400 年按普通年月日闰年规则接受二月二十九日');
  assert.deepEqual(timeline.undatedEventIds, ['date-3', 'date-5', 'date-6'], '非法显式日期不会退化成无年同月日');
  assert.equal(projectTime('994年2月28日').year, null, '共享时间推演默认仍不把三位数字改判为年份');
  assert.equal(projectTime('公历2024年2月29日').date, '2024-02-29', '具名公历和闰年合同不变');
});

test('已保存的季节历事件投影到日期组并保留事件原始时间', () => {
  const events = [
    { id: 'summer-start', storyTime: '1年夏1日' },
    { id: 'summer-later', storyTime: '1年夏27日' },
    { id: 'autumn-start', storyTime: '1年秋1日' },
  ];
  const timeline = projectQianshiTimeline({ events, relations: [] });
  assert.deepEqual(timeline.undatedEventIds, []);
  const groups = timeline.segments.flatMap(segment => segment.groups);
  assert.ok(groups.some(group => group.eventIds.includes('summer-start') && group.period === '1年夏'));
  assert.ok(groups.some(group => group.eventIds.includes('summer-later') && group.period === '1年夏'));
  assert.ok(groups.some(group => group.eventIds.includes('autumn-start') && group.period === '1年秋'));
  assert.deepEqual(events.map(event => event.storyTime), ['1年夏1日', '1年夏27日', '1年秋1日']);
});

test('千事日期主标签压缩至月日，完整日期和仅月日分组，详情原文与相对投影保留', () => {
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

test('千事时间轴普通日期按年月日排序、无年按月日排序并保留秒', () => {
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
  assert.equal(byId('yearless-nov-late').id, 'month-day');
  assert.deepEqual(byId('yearless-nov-late').groups.flatMap(group => group.eventIds), [
    'yearless-oct', 'yearless-nov-early', 'yearless-nov-late',
  ], '无年十一月整体晚于十月，且秒参与排序');
  assert.notEqual(byId('yearless-nov-late').id, byId('gregorian-latest').id, '无年与完整年份分别展示');
  assert.equal(byId('yearless-nov-late').label, '仅月日');
  assert.equal(timeline.undatedEventIds.includes('unanchored-relative'), true, '未锚定相对时间不排入精确时间轴');
  assert.equal(timeline.undatedEventIds.includes('scheduled-only'), true, 'scheduledTime不充当发生时间');
  assert.equal(timeline.hasGlobalLatest, false, '存在不可比区域时不声明唯一全局最近');
  assert.equal(timeline.segments.find(segment => segment.id === 'dated').groups.find(group => group.eventIds.includes('gregorian-latest')).full,
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

test('特殊具名时间只在同一月内排序，其他月不推断最近或先后', () => {
  const timeline = projectQianshiTimeline({ events: [
    { id: 'unknown-seconds', storyTime: '大陆历1686年7月29日 14:15' },
    { id: 'explicit-seconds', storyTime: '大陆历1686年7月29日 14:15:02' },
    { id: 'same-precision', storyTime: '大陆历1686年7月29日 14:15' },
    { id: 'next-special-month', storyTime: '大陆历1686年8月1日 09:00' },
    { id: 'other-era-different-day', storyTime: '星海历1686年7月28日 10:00' },
    { id: 'other-calendar', storyTime: '星海历1686年7月29日 14:15:00' },
  ], relations: [] });
  const mainland = timeline.segments.find(segment => segment.id.includes('大陆历'));
  assert.deepEqual(mainland.groups[0].eventIds, ['unknown-seconds', 'explicit-seconds', 'same-precision'], '秒精度不足时保持来源稳定顺序');
  assert.equal(timeline.hasGlobalLatest, false, '跨特定月份不能宣称唯一最近');
  assert.ok(timeline.segments.some(segment => segment.id.includes('星海历')), '特殊日期保留各自原文时间线索');
});

test('普通千事完整日期和旧无年日期按自然跨月计算，年末无年跨年不猜', () => {
  const dated = projectQianshiTimeline({ events: [
    { id: 'date-later-year', storyTime: '2027-01-01' }, { id: 'date-before-year-end', storyTime: '2026-12-31' },
  ], relations: [] });
  assert.deepEqual(dated.segments[0].groups.map(group => group.eventIds[0]), ['date-before-year-end', 'date-later-year']);
  const yearless = projectQianshiTimeline({ events: [
    { id: 'october', storyTime: '10月2日' }, { id: 'september', storyTime: '9月29日' },
  ], relations: [] });
  assert.deepEqual(yearless.segments[0].groups.map(group => group.eventIds[0]), ['september', 'october']);
  const yearBoundary = projectQianshiTimeline({ events: [
    { id: 'dec', storyTime: '12月31日' }, { id: 'jan', storyTime: '1月1日' },
  ], relations: [] });
  assert.equal(yearBoundary.hasGlobalLatest, false, '无年年末和年初不能推算跨年次序');
  assert.deepEqual(yearBoundary.segments[0].groups.map(group => group.eventIds[0]), ['dec', 'jan'], '不可推断时保留原来源顺序');
  assert.equal(yearBoundary.segments[0].latestGroupId, null, '不把任何一端标成不可信的段内最近');
});

test('千事全图为无年普通月日跨月建立隐式时间边，但不跨年环绕', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'october', title: '十月节点', description: '普通月日跨月', status: 'occurred', matter: false, storyTime: '10月2日' },
    { key: 'september', title: '九月节点', description: '普通月日跨月', status: 'occurred', matter: false, storyTime: '9月29日' },
  ], order: [] } } });
  const projection = projectQianshiGraph({ floors: [source], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', source, delta)], entities: [] });
  assert.deepEqual(projection.events.map(event => event.title), ['九月节点', '十月节点'], '无年普通日期按同年跨月先后排序');
  assert.equal(projection.orderGraph.filterEdges((_edge, attributes) => attributes.inferredFromExplicitTime).length, 1,
    '相邻日期通过隐式边界显式进入全图时序，不只在列表临时排序');
});

test('无年年末和年初混有可比日期时也不通过桶代表造跨年隐式先后', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'december', title: '年末', description: '无年边界', status: 'occurred', matter: false, storyTime: '12月31日' },
    { key: 'january-one', title: '年初一', description: '无年边界', status: 'occurred', matter: false, storyTime: '1月1日' },
    { key: 'january-two', title: '年初二', description: '无年边界', status: 'occurred', matter: false, storyTime: '1月2日' },
  ], order: [] } } });
  const projection = projectQianshiGraph({ floors: [source], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', source, delta)], entities: [] });
  assert.deepEqual(projection.events.map(event => event.title), ['年末', '年初一', '年初二'], '无可证跨年关系时保留楼内来源顺序');
  const eventByNode = new Map(projection.events.map(event => [`event:${event.id}`, event]));
  const inferred = projection.orderGraph.edges().filter(edge => projection.orderGraph.getEdgeAttribute(edge, 'inferredFromExplicitTime'))
    .map(edge => [projection.orderGraph.source(edge), projection.orderGraph.target(edge)]);
  assert.deepEqual(inferred.map(([from, to]) => [eventByNode.get(from)?.title, eventByNode.get(to)?.title]), [['年初一', '年初二']]);
  for (const [from, to] of inferred) assert.ok(timeDistance(eventByNode.get(from).parsedStoryTime, eventByNode.get(to).parsedStoryTime) > 0,
    '每条隐式先后边的真实事件端点必须可以直接比较');
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
  assert.equal(d2.events[0].updatesMatter, true, '发生时间倒叙不由编译器擅自把明确进展改成背景');
  assert.equal(d2.relations.filter(relation => relation.type === 'progress').length, 1);
  const reachable = { root: { narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 1,
    floors: [first, second], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', first, d1), memory('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', second, d2)], entities: [] };
  const projection = projectQianshiGraph(reachable);
  const matter = projection.matters.find(value => value.matterId === borrow.matterId);
  assert.equal(matter.latestEventIds.includes(d2.events[0].id), false);
  assert.equal(matter.eventIds.includes(d1.events[1].id), false, 'before 边不得把另一事项带进 progress traversal');
});

test('事项内不可比较时间保留来源顺序，同时可比较时间仍建立先后', async () => {
  const first = floor('11111111-1111-4111-8111-111111111111', 1);
  const d1 = await compileQianshiDelta({ floor: first, now: NOW, packet: { qianshi: { events: [
    { key: 'start', title: '安排会面', description: '约定会面', status: 'planned', matter: true, storyTime: '10月23日 08:05' },
  ], order: [] } } });
  const second = floor('22222222-2222-4222-8222-222222222222', 2), binding = { key: 'line', matterId: d1.events[0].matterId,
    latestEventIds: [d1.events[0].id], latestStoryTime: d1.events[0].storyTime, sourceFloorId: first.id, sourceAssistantSeq: 1 };
  const d2 = await compileQianshiDelta({ floor: second, now: NOW, candidateBindings: [binding], packet: { qianshi: { events: [
    { key: 'uncertain', title: '继续安排', description: '继续安排会面', status: 'inProgress', storyTime: '10月23日 08:40-08:45', links: [{ candidateKey: 'line', kind: 'progress' }] },
  ], order: [] } } });
  const third = floor('33333333-3333-4333-8333-333333333333', 3);
  const d3 = await compileQianshiDelta({ floor: third, now: NOW, candidateBindings: [{ ...binding, latestEventIds: [d2.events[0].id], latestStoryTime: d2.events[0].storyTime, sourceFloorId: second.id, sourceAssistantSeq: 2 }], packet: { qianshi: { events: [
    { key: 'advance', title: '会面开始', description: '会面开始', status: 'inProgress', storyTime: '10月23日 08:15', links: [{ candidateKey: 'line', kind: 'progress' }] },
  ], order: [] } } });
  const reachable = { floors: [first, second, third], floorMemories: [
    memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', first, d1), memory('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', second, d2),
    memory('ffffffff-ffff-4fff-8fff-ffffffffffff', third, d3),
  ], entities: [] };
  const matter = projectQianshiGraph(reachable).matters.find(value => value.matterId === d1.events[0].matterId);
  assert.deepEqual(matter.recordIds.map(id => [d1.events[0].id, d2.events[0].id, d3.events[0].id].indexOf(id)), [0, 1, 2]);
  assert.equal(matter.currentEventId, d3.events[0].id);
});

test('冷读和候选索引都不把无current的一次性或旧singleton送入matter绑定', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'owned-once', title: '一次性记录甲', description: '甲事件已经发生', status: 'occurred', matter: false },
    { key: 'legacy-once', title: '一次性记录乙', description: '乙事件已经发生', status: 'occurred', matter: false },
  ], order: [] } } });
  delta.events[1].matterId = null;
  const reachable = { root: { chatId: CHAT, narrativeGeneration: GENERATION }, floors: [source],
    floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', source, delta)], entities: [] };
  const options = { canonicalContent: '一次性记录甲 一次性记录乙' };
  const projection = projectQianshiGraph(reachable);
  assert.equal(projection.matters.every(matter => matter.currentEventId === null), true);
  assert.equal(prepareQianshiCandidates(reachable, options).request.length, 0);
  assert.equal(createQianshiCandidateIndex().prepare(reachable, options).request.length, 0);
});

test('晚楼误接旧progress边不会让明确更晚发生的完成态倒退', async () => {
  const first = floor('11111111-1111-4111-8111-111111111111', 1);
  const d1 = await compileQianshiDelta({ floor: first, now: NOW, packet: { qianshi: { events: [
    { key: 'complete', title: '确认抵达', description: '目标已经完成', status: 'completed', matter: true, storyTime: '2026-10-24 10:00' },
  ], order: [] } } });
  const second = floor('22222222-2222-4222-8222-222222222222', 2);
  const d2 = await compileQianshiDelta({ floor: second, now: NOW, candidateBindings: [{ key: 'line', matterId: d1.events[0].matterId,
    latestEventIds: [d1.events[0].id], latestStoryTime: d1.events[0].storyTime, sourceFloorId: first.id, sourceAssistantSeq: 1 }],
  packet: { qianshi: { events: [
    { key: 'old-recall', title: '回忆旧进度', description: '旧进度被晚楼误接', status: 'inProgress', storyTime: '2026-10-23 09:00', scheduledTime: '2035-01-01', links: [{ candidateKey: 'line', kind: 'progress' }] },
  ], order: [] } } });
  const old = d2.events[0];
  old.updatesMatter = true;
  old.matterId = d1.events[0].matterId;
  d2.relations.push({ id: '55555555-5555-4555-8555-555555555555', type: 'progress', fromEventId: d1.events[0].id,
    toEventId: old.id, certainty: 'explicit' });
  const projection = projectQianshiGraph({ floors: [first, second], floorMemories: [
    memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', first, d1), memory('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', second, d2),
  ], entities: [] });
  const matter = projection.matters.find(value => value.matterId === d1.events[0].matterId);
  assert.equal(matter.currentEventId, d1.events[0].id);
  assert.equal(matter.status, 'completed');
  assert.deepEqual(matter.recordIds, [old.id, d1.events[0].id]);
  assert.equal(projection.relations.some(relation => relation.fromEventId === d1.events[0].id && relation.toEventId === old.id), true);
  assert.equal(projection.events.find(event => event.id === old.id).status, 'inProgress');
});

test('候选索引扩展时复用冷投影的line current并保留背景记录', async () => {
  const first = floor('11111111-1111-4111-8111-111111111111', 1);
  const d1 = await compileQianshiDelta({ floor: first, now: NOW, packet: { qianshi: { events: [
    { key: 'complete', title: '档案核验完成', description: '核验已经完成', status: 'completed', matter: true, storyTime: '2026-10-24 10:00' },
  ], order: [] } } });
  const second = floor('22222222-2222-4222-8222-222222222222', 2);
  const d2 = await compileQianshiDelta({ floor: second, now: NOW, packet: { qianshi: { events: [
    { key: 'background', title: '旧线索回忆', description: '补充背景资料', status: 'occurred', matter: true, storyTime: '2026-10-23' },
  ], order: [] } } });
  d2.events[0].matterId = d1.events[0].matterId;
  d2.events[0].updatesMatter = false;
  const third = floor('33333333-3333-4333-8333-333333333333', 3);
  const d3 = await compileQianshiDelta({ floor: third, now: NOW, packet: { qianshi: { events: [
    { key: 'old', title: '误接旧续进', description: '晚楼补记了较早进展', status: 'inProgress', matter: true, storyTime: '前日 09:00' },
  ], order: [] } } });
  d3.events[0].matterId = d1.events[0].matterId;
  d3.events[0].updatesMatter = true;
  d3.relations.push({ id: '66666666-6666-4666-8666-666666666666', type: 'progress', fromEventId: d1.events[0].id,
    toEventId: d3.events[0].id, certainty: 'explicit' });
  const memories = [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', first, d1), memory('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', second, d2),
    { ...memory('ffffffff-ffff-4fff-8fff-ffffffffffff', third, d3), chronology: [{ time: { normalized: '2026-10-24' } }] }];
  const prefix = { root: { chatId: CHAT, narrativeGeneration: GENERATION }, floors: [first], floorMemories: [memories[0]], entities: [] };
  const reachable = { root: prefix.root, floors: [first, second, third], floorMemories: memories, entities: [] };
  let projections = 0;
  const index = createQianshiCandidateIndex({ projector: (...args) => { projections += 1; return projectQianshiGraph(...args); } });
  const options = { canonicalContent: '档案核验完成' };
  index.prepare(prefix, options);
  const incremental = index.prepare(reachable, options);
  const cold = prepareQianshiCandidates(reachable, options);
  assert.equal(projections, 1);
  assert.deepEqual(incremental, cold);
  assert.deepEqual(incremental.bindings[0].latestEventIds, [d1.events[0].id]);
  assert.equal(incremental.request[0].status, 'completed');
  const matter = projectQianshiGraph(reachable).matters.find(value => value.matterId === d1.events[0].matterId);
  assert.equal(matter.recordIds.includes(d2.events[0].id), true);
  assert.equal(matter.currentEventId, d1.events[0].id, '增量事件沿相同的主楼时间锚解析相对发生时间');
});

test('事项时间排序比较同日明确时分，缺钟点仍沿来源顺序', async () => {
  const floors = [1, 2, 3, 4, 5, 6].map((seq, index) => floor(`${index + 1}${String(index + 1).repeat(7)}-${index + 1}${String(index + 1).repeat(3)}-4${index + 1}${String(index + 1).repeat(2)}-8${index + 1}${String(index + 1).repeat(2)}-${String(index + 1).repeat(12)}`, seq));
  const deltas = [];
  const times = ['2026-10-24 10:00', '2026-10-24 09:00', '2026-10-24', '10月24日 10:00', '10月24日', '10月23日 09:00'];
  for (const [index, storyTime] of times.entries()) {
    const delta = await compileQianshiDelta({ floor: floors[index], now: NOW, packet: { qianshi: { events: [
      { key: `time-${index}`, title: `同日记录${index}`, description: '保留来源与故事时间', status: index === 0 ? 'completed' : 'inProgress',
        matter: true, storyTime, ...(index === 1 ? { scheduledTime: '2035-01-01' } : {}) },
    ], order: [] } } });
    if (index > 0 && index < 3) delta.events[0].matterId = deltas[0].events[0].matterId;
    if (index > 3) delta.events[0].matterId = deltas[3].events[0].matterId;
    deltas.push(delta);
  }
  const projection = projectQianshiGraph({ floors, floorMemories: deltas.map((delta, index) => memory(
    `${String(index + 4).repeat(8)}-${String(index + 4).repeat(4)}-4${index + 4}${String(index + 4).repeat(2)}-8${index + 4}${String(index + 4).repeat(2)}-${String(index + 4).repeat(12)}`, floors[index], delta)), entities: [] });
  const matter = projection.matters.find(value => value.matterId === deltas[0].events[0].matterId);
  assert.deepEqual(matter.recordIds, [deltas[1].events[0].id, deltas[0].events[0].id, deltas[2].events[0].id]);
  assert.equal(matter.currentEventId, deltas[2].events[0].id);
  assert.equal(projection.events.find(event => event.id === deltas[1].events[0].id).scheduledTime, '2035-01-01');
  const yearless = projection.matters.find(value => value.matterId === deltas[3].events[0].matterId);
  assert.deepEqual(yearless.recordIds, [deltas[5].events[0].id, deltas[3].events[0].id, deltas[4].events[0].id]);
});

test('年未知但月份明确的跨月进展按可比较日期排序，未知月份不并入月日桶', async () => {
  const floors = [floor('77777777-7777-4777-8777-777777777777', 7), floor('88888888-8888-4888-8888-888888888888', 8)];
  const newer = await compileQianshiDelta({ floor: floors[0], now: NOW, packet: { qianshi: { events: [
    { key: 'november', title: '十一月记录', description: '较新的事项进展', status: 'completed', matter: true, storyTime: '11月24日 09:00' },
  ], order: [] } } });
  const older = await compileQianshiDelta({ floor: floors[1], now: NOW, packet: { qianshi: { events: [
    { key: 'october', title: '十月记录', description: '较早的事项进展', status: 'inProgress', matter: true, storyTime: '10月24日 10:00' },
  ], order: [] } } });
  older.events[0].matterId = newer.events[0].matterId;
  const projection = projectQianshiGraph({ floors, floorMemories: [
    memory('99999999-9999-4999-8999-999999999999', floors[0], newer),
    memory('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab', floors[1], older),
  ], entities: [] });
  const matter = projection.matters.find(value => value.matterId === newer.events[0].matterId);
  assert.deepEqual(matter.recordIds, [older.events[0].id, newer.events[0].id]);
  assert.equal(matter.currentEventId, newer.events[0].id);

  const source = [
    { id: 'november', assistantSeq: 1, parsedStoryTime: { year: null, month: 11, monthDay: 24, minute: 9 * 60 } },
    { id: 'unknown-month', assistantSeq: 2, parsedStoryTime: { year: null, month: null, monthDay: 24, minute: null } },
    { id: 'october', assistantSeq: 3, parsedStoryTime: { year: null, month: 10, monthDay: 24, minute: 10 * 60 } },
  ];
  const order = orderQianshiLineRecords(source, new Map(source.map((event, index) => [event.id, index]))).map(event => event.id);
  assert.ok(order.indexOf('unknown-month') < order.indexOf('october'), '未知月份保持独立的来源回退，不被并入 11 月 24 日桶');
  assert.ok(order.indexOf('october') < order.indexOf('november'), '未知月份记录不能打断 10 月与 11 月之间的可比较约束');
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
  assert.equal(incremental.bindings[0].latestEventIds.length, 1, '旧分支在派生候选中固定为唯一当前事件');
  assert.equal(incremental.bindings[0].latestEventIds[0], compiled.events[0].id, '来源较晚的末端沿稳定楼序成为当前事件');
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
  assert.match(result.memory.qianshiDelta.reason, /1 项未能编译/u);
  assert.deepEqual(result.memory.qianshiDelta.events.map(event => event.title), ['取出钥匙', '打开侧门']);
  assert.deepEqual(result.memory.qianshiDelta.relations.map(relation => [relation.type, relation.fromEventId, relation.toEventId]), [
    ['before', result.memory.qianshiDelta.events[0].id, result.memory.qianshiDelta.events[1].id],
  ]);
});

test('千事 order 字符串列表按相邻事件编译，坏先后边不降级事件结果', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: {
    events: [
      { key: 'event-1', title: '拿起钥匙', description: '林岚拿起钟楼钥匙', status: 'occurred', matter: false },
      { key: 'event-2', title: '打开侧门', description: '林岚随后打开钟楼侧门', status: 'occurred', matter: false },
      { key: 'event-3', title: '进入钟楼', description: '林岚进入钟楼', status: 'occurred', matter: false },
    ],
    order: ['event-1', 'event-2', 'missing-event'],
  } } });

  assert.equal(delta.status, 'ready');
  assert.deepEqual(delta.relations.map(relation => [relation.type, relation.fromEventId, relation.toEventId]), [
    ['before', delta.events[0].id, delta.events[1].id],
  ]);
  assert.equal(delta.reason, null);

  const invalidEvent = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: {
    events: [
      { key: 'event-1', title: '拿起钥匙', description: '林岚拿起钟楼钥匙', status: 'occurred', matter: false },
      { key: 'event-2', title: '缺少描述' },
    ], order: [{ before: 'event-2', after: 'missing-event' }],
  } } });
  assert.equal(invalidEvent.status, 'partial', '坏事件被忽略，其他有效事件保留且有可见原因');
  assert.match(invalidEvent.reason, /缺少有效标题或说明/u);
  assert.equal(invalidEvent.events.length, 1);
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

test('召回候选只按自身可比时间排序，不借用同年其他事件的纪年身份', async () => {
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
    '普通日期不会因为同年存在具名纪年而改变时间身份');
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
  assert.deepEqual(projectQianshiRecall(base, { selectedEventIds: [d1.events[1].id, book.id], selectedMatterIds: [book.matterId],
    currentTime: { raw: 'unconsumed-current-time' } }), selected, 'selected-ID投影不读取currentTime，provider可省略该来源准备');
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
  assert.equal(d2.events[0].updatesMatter, true);
  assert.equal(d2.relations.some(relation => relation.type === 'progress'), true);
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
  for (const raw of ['大陆历1686年8月5日凌晨：真理秘律院彻底清算', '1686-07-24 16:00：三方联合绞杀真理秘律院核心',
    '大陆历1686年7月29日 14:15：命令返回真理秘律院签发扣押令', '大陆历1686年8月6日下午：探访完成真理秘律院收尾确认',
    '1686-10-29 17:00：北境真理秘律院新律法重任']) assert.ok(recall.text.includes(raw), `保留召回来源原文：${raw}`);
  assert.ok(recall.text.indexOf('1686-07-24 16:00：三方联合绞杀真理秘律院核心')
    < recall.text.indexOf('1686-10-29 17:00：北境真理秘律院新律法重任'), '普通明确年份仍在普通时间组内按日期排序');
});

test('明确日期冲突的 progress 仍可召回，普通与特殊日期各自保留', async () => {
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
  for (const raw of ['大陆历1686年8月5日 15:00：北境证据起点', '1686-07-29 13:00：北境证据旁证',
    '大陆历1686年7月29日 14:15：北境证据倒叙进展']) assert.ok(recall.text.includes(raw), `保留明确进展事件及其时间原文：${raw}`);
  assert.match(recall.text, /当前待接续[\s\S]*北境证据倒叙进展/u, '显式 progress 关系仍参与待接续投影');
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

test('旧 historyReview 事件只读进入图、召回和候选索引，duplicate 与坏边按旧合同处理', async () => {
  const first = floor('11111111-1111-4111-8111-111111111111', 1);
  const second = floor('22222222-2222-4222-8222-222222222222', 2);
  const compiled = await compileQianshiDelta({ floor: first, now: NOW, packet: { qianshi: { events: [
    { key: 'formal', title: '整理蓝皮档案', description: '顾舟答应整理蓝皮档案', status: 'planned', matter: true, object: '蓝皮档案' },
    { key: 'pending', title: '修补旧地图', description: '沈砚发现旧地图破损并准备修补', status: 'planned', matter: true, object: '旧地图' },
    { key: 'rejected', title: '焚毁旧信', description: '用户明确拒绝记录焚毁旧信', status: 'occurred', matter: false },
  ], order: [] } } });
  const [formalEvent, pendingEvent, rejectedEvent] = compiled.events;
  const link = { id: '33333333-3333-4333-8333-333333333333', type: 'before', fromEventId: pendingEvent.id,
    toEventId: '44444444-4444-4444-8444-444444444444', certainty: 'explicit' };
  const badLink = { ...link, id: '55555555-5555-4555-8555-555555555555', toEventId: '66666666-6666-4666-8666-666666666666' };
  const candidate = (event, decision, relations = []) => ({ candidateId: event.id, decision, event, relations,
    recommendedEventId: null, matchBasis: [] });
  const reviewed = validateQianshiDelta({ ...compiled, status: 'partial', reason: '旧版部分结果', events: [formalEvent], relations: [],
    historyReview: { rawFingerprint: `sha256:${'a'.repeat(64)}`, priorStatus: 'ready', priorReason: null,
      candidates: [candidate(formalEvent, 'new'), candidate(pendingEvent, 'pending', [link, badLink]), candidate(rejectedEvent, 'duplicate')] } }, { floorId: first.id });
  const later = await compileQianshiDelta({ floor: second, now: NOW, candidateBindings: [{ key: 'candidate-1', matterId: pendingEvent.matterId,
    latestEventIds: [pendingEvent.id], latestStoryTime: pendingEvent.storyTime, sourceFloorId: first.id, sourceAssistantSeq: 1 }], packet: { qianshi: { events: [
    { key: 'continue', title: '修补旧地图', description: '沈砚开始修补旧地图', status: 'inProgress', matter: true, object: '旧地图',
      links: [{ candidateKey: 'candidate-1', kind: 'progress' }] },
  ], order: [] } } });
  const foreignFloor = floor('99999999-9999-4999-8999-999999999999', 9);
  const foreignEvent = { ...pendingEvent, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab', sourceFloorId: foreignFloor.id, title: '不可达分支事实' };
  const foreignDelta = validateQianshiDelta({ schemaVersion: 1, status: 'pending', reason: '旧分支草稿', compiledAt: NOW,
    candidateStats: { count: 1, characters: 0 }, events: [], relations: [], historyReview: { rawFingerprint: `sha256:${'c'.repeat(64)}`,
      priorStatus: 'partial', priorReason: null, candidates: [candidate(foreignEvent, 'pending')] } }, { floorId: foreignFloor.id });
  const reachable = { root: { chatId: CHAT, narrativeGeneration: GENERATION }, floors: [first, second],
    floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', first, reviewed), memory('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', second, later),
      memory('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', foreignFloor, foreignDelta)], entities: [] };
  const projection = projectQianshiGraph(reachable);
  assert.deepEqual(projection.events.map(event => event.id).sort(), [formalEvent.id, pendingEvent.id, later.events[0].id].sort());
  assert.equal(projection.events.filter(event => event.id === formalEvent.id).length, 1, '已入账的 decision=new 不双计');
  assert.equal(projection.events.some(event => event.id === rejectedEvent.id), false, 'duplicate 保持排除');
  assert.equal(projection.events.some(event => event.id === foreignEvent.id), false, '不可达的分支楼不进入当前图');
  assert.ok(projection.relations.some(relation => relation.id === later.relations[0].id && relation.fromEventId === pendingEvent.id), '后楼能引用旧 pending ID');
  assert.equal(projection.relations.some(relation => relation.id === badLink.id), false, '无效端点只弃边');
  assert.ok(projection.diagnostics.danglingRelationIds.includes(badLink.id));
  assert.equal(projection.coverage.completeFloors, 2, '旧 partial 的有效存档仍按完成覆盖统计');
  const recall = projectQianshiRecall(reachable, { selectedEventIds: [formalEvent.id, pendingEvent.id] });
  assert.ok(recall.eventIds.includes(pendingEvent.id));
  assert.ok(projectQianshiTimeline(projection).undatedEventIds.includes(pendingEvent.id), '时间线与召回使用同一有效图');
  const index = createQianshiCandidateIndex();
  index.prepare({ ...reachable, floors: [first], floorMemories: [reachable.floorMemories[0]] }, { canonicalContent: '修补旧地图' });
  assert.deepEqual(index.prepare(reachable, { canonicalContent: '修补旧地图' }), prepareQianshiCandidates(reachable, { canonicalContent: '修补旧地图' }),
    '追加后楼时全量重建，既收旧候选也应用新引用');
  const pendingOnlyFloor = floor('77777777-7777-4777-8777-777777777777', 3);
  const pendingOnlyEvent = { ...pendingEvent, sourceFloorId: pendingOnlyFloor.id };
  const pendingOnly = validateQianshiDelta({ schemaVersion: 1, status: 'pending', reason: '旧草稿', compiledAt: NOW,
    candidateStats: { count: 1, characters: 0 }, events: [], relations: [], historyReview: { rawFingerprint: `sha256:${'b'.repeat(64)}`,
      priorStatus: 'partial', priorReason: '旧部分结果', candidates: [candidate(pendingOnlyEvent, 'pending')] } }, { floorId: pendingOnlyFloor.id });
  const pendingOnlyProjection = projectQianshiGraph({ ...reachable, floors: [...reachable.floors, pendingOnlyFloor],
    floorMemories: [...reachable.floorMemories, memory('88888888-8888-4888-8888-888888888888', pendingOnlyFloor, pendingOnly)] });
  assert.equal(pendingOnlyProjection.coverage.completeFloors, 3, '正式事件为空的旧 pending 草稿也按已存档覆盖');
  assert.equal(pendingOnlyProjection.coverage.pendingFloors, 0);
  assert.equal(effectiveQianshiDelta(memory('88888888-8888-4888-8888-888888888888', pendingOnlyFloor, pendingOnly)).events.length, 1);
});

test('同 ID 异内容的旧 pending 事件及其关系一起忽略，不把冲突边接到正式事件', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const compiled = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'origin', title: '打开密室', description: '顾舟计划打开密室', status: 'planned', matter: true, object: '密室' },
  ], order: [] } } });
  const formalEvent = compiled.events[0];
  const laterEvent = { ...formalEvent, id: '00000000-0000-4000-8000-000000000001', title: '继续搜索',
    description: '顾舟打开密室后继续搜索并完成探索', status: 'completed' };
  const conflictingCandidate = { ...formalEvent, description: '另一个版本的冲突候选事实' };
  const collisionRelation = { id: '33333333-3333-4333-8333-333333333333', type: 'progress', fromEventId: formalEvent.id,
    toEventId: laterEvent.id, certainty: 'explicit' };
  const delta = validateQianshiDelta({ ...compiled, status: 'ready', events: [formalEvent, laterEvent], relations: [],
    historyReview: { rawFingerprint: `sha256:${'d'.repeat(64)}`, priorStatus: 'ready', priorReason: null,
      candidates: [{ candidateId: conflictingCandidate.id, decision: 'pending', event: conflictingCandidate,
        relations: [collisionRelation], recommendedEventId: null, matchBasis: [] }] } }, { floorId: source.id });
  const reachable = { root: { chatId: CHAT, narrativeGeneration: GENERATION }, floors: [source],
    floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', source, delta)], entities: [] };
  const projection = projectQianshiGraph(reachable);
  assert.deepEqual(projection.events.map(event => event.id), [formalEvent.id, laterEvent.id], '正式 A 保持唯一，候选差异内容不覆盖');
  assert.equal(projection.relations.some(relation => relation.id === collisionRelation.id), false, '冲突候选的关系不重绑到正式 A');
  const projectedMatter = projection.matters.find(matter => matter.matterId === formalEvent.matterId);
  assert.equal(projectedMatter.latestEventIds.length, 1, '多末端旧关系派生出唯一当前事件');
  assert.deepEqual(new Set(projectedMatter.recordIds), new Set([formalEvent.id, laterEvent.id]), '所有旧记录仍保留在同一条线');
  assert.ok(projection.diagnostics.legacyReviewConflicts.some(value => value.kind === 'event' && value.id === formalEvent.id));
  const index = createQianshiCandidateIndex();
  const indexed = index.prepare(reachable, { canonicalContent: '打开密室继续搜索' });
  assert.deepEqual(indexed, prepareQianshiCandidates(reachable, { canonicalContent: '打开密室继续搜索' }));
  assert.equal(indexed.bindings.find(value => value.matterId === formalEvent.matterId)?.latestEventIds.length, 1,
    '索引不应用冲突候选的伪 progress 边并保持唯一当前事件');
  assert.deepEqual([...projectQianshiRecall(reachable, { selectedEventIds: [formalEvent.id, laterEvent.id] }).eventIds].sort(),
    [formalEvent.id, laterEvent.id].sort(), '召回仍保留正式事件与后续事件');
});

test('人工停止关注统一影响剧情进度、候选和待接续；恢复已完成事项不改历史状态', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'done', title: '归还旧书', description: '林岚已经归还旧书。', status: 'completed', matter: true, object: '旧书' },
  ], order: [] } } });
  const event = delta.events[0], matterId = event.matterId;
  const base = { root: { chatId: CHAT, narrativeGeneration: GENERATION }, rootRevision: 1, floors: [source],
    floorMemories: [memory('44444444-4444-4444-8444-444444444444', source, delta)], entities: [] };
  const stopped = { ...base, floorMemories: [memory('77777777-7777-4777-8777-777777777777', source,
    validateQianshiDelta({ ...delta, trackingOverrides: [{ matterId, following: false }] }, { floorId: source.id }))] };
  const projection = projectQianshiGraph(stopped);
  assert.equal(projection.events[0].status, 'completed', '人工完成不改写事件当时的状态');
  assert.equal(projection.matters[0].following, false);
  assert.equal(projection.currentProgress.text, '');
  assert.deepEqual(prepareQianshiCandidates(stopped, { canonicalContent: '继续归还旧书' }).request, []);
  assert.deepEqual(projectQianshiRecall(stopped, { selectedMatterIds: [matterId] }).matterIds, []);
  const index = createQianshiCandidateIndex();
  assert.equal(index.prepare(base, { canonicalContent: '归还旧书' }).request.length, 1);
  assert.deepEqual(index.prepare(stopped, { canonicalContent: '归还旧书' }).request, [], '楼记忆 revision 变化后增量候选索引重建并遵守人工停止');

  const restored = { ...base, floorMemories: [memory('88888888-8888-4888-8888-888888888888', source,
    validateQianshiDelta({ ...delta, trackingOverrides: [{ matterId, following: true }] }, { floorId: source.id }))] };
  const restoredProjection = projectQianshiGraph(restored);
  assert.equal(restoredProjection.matters[0].status, 'completed');
  assert.equal(restoredProjection.matters[0].following, true);
  assert.match(projectQianshiRecall(restored, { selectedMatterIds: [matterId] }).text, /已记录完成，当前仍继续关注/u);
  assert.equal(prepareQianshiCandidates(restored, { canonicalContent: '归还旧书' }).request[0].tracking, 'following');
  assert.equal(index.prepare(restored, { canonicalContent: '归还旧书' }).request[0].tracking, 'following', '自动已完成事项人工恢复后进入增量候选');
});

test('删除独立事件的首条、中间、末条或全部后，仅投影剩余事件且不回填空楼', async () => {
  const source = floor('77777777-7777-4777-8777-777777777777', 1);
  const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'one', title: '线索一', description: '经过一', status: 'occurred', matter: false },
    { key: 'two', title: '线索二', description: '经过二', status: 'occurred', matter: false },
    { key: 'three', title: '线索三', description: '经过三', status: 'occurred', matter: false },
    { key: 'four', title: '线索四', description: '经过四', status: 'occurred', matter: false },
  ], order: [{ before: 'one', after: 'two' }, { before: 'two', after: 'three' }, { before: 'three', after: 'four' }] } } });
  const baseline = { root: { chatId: CHAT, narrativeGeneration: GENERATION }, rootRevision: 1, floors: [source], entities: [] };
  for (const deletedCount of [1, 2, 3, 4]) {
    const deletedIds = delta.events.slice(0, deletedCount).map(event => event.id);
    const marked = validateQianshiDelta({ ...delta, deletedEventIds: deletedIds }, { floorId: source.id });
    const projected = projectQianshiGraph({ ...baseline, floorMemories: [memory('99999999-9999-4999-8999-999999999999', source, marked)] });
    assert.deepEqual(projected.events.map(event => event.id), delta.events.slice(deletedCount).map(event => event.id));
    assert.deepEqual(projected.diagnostics.danglingRelationIds, []);
    assert.equal(projected.coverage.completeFloors, 1, '删除到空的已处理楼仍不会重新进入补齐队列');
  }
});

test('人工删除只隐藏选中事件并清理其关系引用；删除后楼仍计为已检查，真实断链仍诊断', async () => {
  const firstFloor = floor('11111111-1111-4111-8111-111111111111', 1);
  const nextFloor = floor('22222222-2222-4222-8222-222222222222', 2);
  const first = await compileQianshiDelta({ floor: firstFloor, now: NOW, packet: { qianshi: { events: [
    { key: 'old', title: '旧线索', description: '已误收录的旧线索。', status: 'occurred', matter: false },
  ], order: [] } } });
  const later = await compileQianshiDelta({ floor: nextFloor, now: NOW, packet: { qianshi: { events: [
    { key: 'new', title: '新线索', description: '后来找到的新线索。', status: 'occurred', matter: false },
  ], order: [] } } });
  const oldEvent = first.events[0], newEvent = later.events[0];
  const firstWithRelation = validateQianshiDelta({ ...first, relations: [{ id: '33333333-3333-4333-8333-333333333333',
    type: 'before', fromEventId: oldEvent.id, toEventId: newEvent.id, certainty: 'explicit' }] }, { floorId: firstFloor.id });
  const deleted = validateQianshiDelta({ ...firstWithRelation, deletedEventIds: [oldEvent.id] }, { floorId: firstFloor.id });
  const reachable = { root: { chatId: CHAT, narrativeGeneration: GENERATION }, rootRevision: 1, floors: [firstFloor, nextFloor],
    floorMemories: [memory('44444444-4444-4444-8444-444444444444', firstFloor, deleted), memory('55555555-5555-4555-8555-555555555555', nextFloor, later)], entities: [] };
  const projection = projectQianshiGraph(reachable);
  assert.deepEqual(projection.events.map(item => item.id), [newEvent.id]);
  assert.deepEqual(projection.relations, []);
  assert.deepEqual(projection.diagnostics.danglingRelationIds, []);
  assert.equal(projection.coverage.completeFloors, 2, '删除掉最后一条事件的楼仍是已处理楼，不会重新进入历史补齐');

  const brokenEvent = { ...later.events[0], continuesFromEventIds: ['66666666-6666-4666-8666-666666666666'] };
  const broken = validateQianshiDelta({ ...later, events: [brokenEvent] }, { floorId: nextFloor.id });
  const genuinelyBroken = projectQianshiGraph({ ...reachable, floorMemories: [memory('44444444-4444-4444-8444-444444444444', firstFloor, first),
    memory('55555555-5555-4555-8555-555555555555', nextFloor, broken)] });
  assert.equal(genuinelyBroken.diagnostics.danglingContinuations.length, 1, '未被人工删除解释的断链仍可见');
});

test('重判 record-N 精确复用事件ID，原线起点可保matterId，显式拆线或有效候选可改归线', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const originalDelta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'old', title: '旧标题', description: '旧经过', status: 'inProgress', matter: true },
  ], order: [] } } });
  const original = originalDelta.events[0];
  const binding = { key: 'record-1', event: original, preserveMatterIdOnNewLine: true };
  const keptOrigin = await compileQianshiDelta({ floor: source, now: NOW, recordBindings: [binding], packet: { qianshi: { events: [
    { key: 'record-1', title: '旧标题', description: '旧经过', lineStatus: 'completed', actionStatus: 'occurred', matter: true },
  ], order: [] } } });
  assert.equal(keptOrigin.events[0].id, original.id, '旧记录ID不随改判状态重新生成');
  assert.equal(keptOrigin.events[0].matterId, original.matterId, '原matter origin可保留现存外部qianshiRef身份');
  assert.equal(keptOrigin.events[0].status, 'completed'); assert.equal(keptOrigin.events[0].actionStatus, 'occurred');

  const split = await compileQianshiDelta({ floor: source, now: NOW, recordBindings: [{ ...binding, preserveMatterIdOnNewLine: false }],
    packet: { qianshi: { events: [{ key: 'record-1', title: '旧标题', description: '旧经过', status: 'inProgress', matter: true }], order: [] } } });
  assert.equal(split.events[0].id, original.id); assert.notEqual(split.events[0].matterId, original.matterId, '后续记录显式开新线不会被冻结在旧matterId');

  const priorEventId = '33333333-3333-4333-8333-333333333333';
  const candidate = { key: 'candidate-1', kind: 'matter', matterId: '22222222-2222-4222-8222-222222222222', latestEventIds: [priorEventId] };
  const moved = await compileQianshiDelta({ floor: source, now: NOW, candidateBindings: [candidate], recordBindings: [binding],
    packet: { qianshi: { events: [{ key: 'record-1', title: '旧标题', description: '旧经过', status: 'inProgress', matter: true,
      links: [{ candidateKey: 'candidate-1', kind: 'progress' }] }], order: [] } } });
  assert.equal(moved.events[0].id, original.id); assert.equal(moved.events[0].matterId, candidate.matterId, '有效progress候选可将原记录移入新线');
  assert.deepEqual(moved.events[0].continuesFromEventIds, [priorEventId]);
  assert.equal(moved.relations[0].fromEventId, priorEventId, '重判关系锚点仍指向前序事件，不误连回本记录自身');

  const unknown = await compileQianshiDelta({ floor: source, now: NOW, recordBindings: [binding],
    packet: { qianshi: { events: [{ key: 'record-9', title: '不允许猜配', description: '编号不在精确绑定中', status: 'occurred', matter: false }], order: [] } } });
  assert.equal(unknown.status, 'pending'); assert.equal(unknown.events.length, 0, '未知record编号不会按文字或序号落到旧ID');
});


test('模型关联字段别名统一保留接续与背景含义，错误引用不降级为新线', async () => {
  const start = floor('11111111-1111-4111-8111-111111111111', 1);
  const next = floor('22222222-2222-4222-8222-222222222222', 2);
  const origin = await compileQianshiDelta({ floor: start, now: NOW, packet: { qianshi: { events: [
    { key: 'event-1', title: '归还旧书', description: '约好归还旧书', status: 'planned', matter: true },
  ] } } });
  const candidate = { key: 'candidate-1', kind: 'matter', matterId: origin.events[0].matterId,
    originEventId: origin.events[0].id, latestEventIds: [origin.events[0].id] };
  const variants = [
    { candidateKey: 'candidate-1', kind: 'progress' },
    { target: 'candidate-1', type: 'progress' },
    { to: 'candidate-1', type: 'progress' },
    { targetKey: 'candidate-1', type: 'progress' },
    { candidate: 'candidate-1', type: 'progress' },
  ];
  for (const link of variants) {
    const delta = await compileQianshiDelta({ floor: next, now: NOW, candidateBindings: [candidate], packet: { qianshi: { events: [
      { key: 'event-1', title: '完成交接', description: '旧书已经交还', status: 'completed', links: [link] },
    ] } } });
    assert.equal(delta.status, 'ready', JSON.stringify(link));
    const graph = projectQianshiGraph({ floors: [start, next], floorMemories: [memory('first', start, origin), memory('next', next, delta)] });
    assert.equal(graph.matters.length, 1, '接续别名不能拆成两条独立事项');
    assert.equal(graph.matters[0].status, 'completed');
    assert.equal(graph.matters[0].recordIds.length, 2);
    assert.equal(graph.diagnostics.progressEdges, 1);
  }
  const compile = link => compileQianshiDelta({ floor: next, now: NOW, candidateBindings: [candidate], packet: { qianshi: { events: [
    { key: 'event-1', title: '回忆交接', description: '想起归还旧书的约定', status: 'occurred', matter: false, links: [link] },
  ] } } });
  const context = await compile({ target: 'candidate-1', type: 'context' });
  assert.equal(context.status, 'ready');assert.equal(context.events[0].updatesMatter, false);
  assert.equal(context.relations.filter(r => r.type === 'progress').length, 0, '背景别名不能误作接续');
  for (const link of [{ target: 'candidate-missing', type: 'progress' }, { to: 'record-1', type: 'progress' }, { target: 'candidate-1', type: 'nonsense' }]) {
    const invalid = await compile(link);
    assert.equal(invalid.status, 'pending');assert.equal(invalid.events.length, 0, '无效引用或类型必须拒绝，不能静默开新线');
  }
});


test('模型状态写法兼容仍落规范值并串接事项，无法识别的值不猜测', async () => {
  const first = floor('11111111-1111-4111-8111-111111111111', 1);
  const next = floor('22222222-2222-4222-8222-222222222222', 2);
  const compile = (source, status, actionStatus, extra = {}) => compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'event-1', title: '旧书交接', description: '约好后继续交接旧书', status, actionStatus, matter: true, ...extra },
  ] } } });
  const canonical = await compile(first, 'inProgress', 'completed');
  for (const status of ['in_progress', 'in-progress', 'IN_PROGRESS', 'In Progress', 'ongoing', 'underway', '进行中']) {
    const actual = await compile(first, status, 'COMPLETED');
    assert.equal(actual.status, 'ready');assert.deepEqual(actual.events, canonical.events, '同一种状态的写法不改变事件或事项身份');
  }
  for (const [state, expected] of [['scheduled', 'planned'], ['todo', 'planned'], ['finished', 'completed'], ['done', 'completed'], ['canceled', 'cancelled'], ['happened', 'occurred'], ['unspecified', 'unknown']]) {
    const actual = await compile(first, state, state);assert.equal(actual.status, 'ready');
    assert.equal(actual.events[0].status, expected);assert.equal(actual.events[0].actionStatus, expected);
  }
  const start = canonical.events[0];
  const end = await compileQianshiDelta({ floor: next, now: NOW, candidateBindings: [{ key: 'candidate-1', kind: 'matter', matterId: start.matterId, latestEventIds: [start.id] }],
    packet: { qianshi: { events: [{ key: 'event-1', title: '交接完毕', description: '已经交还旧书', lineStatus: 'COMPLETED', status: 'IN_PROGRESS', links: [{ candidateKey: 'candidate-1', kind: 'progress' }] }] } } });
  const graph = projectQianshiGraph({ floors: [first, next], floorMemories: [memory('first', first, canonical), memory('next', next, end)] });
  assert.equal(graph.matters.length, 1);assert.equal(graph.matters[0].status, 'completed');assert.equal(graph.diagnostics.progressEdges, 1);
  assert.equal(end.events[0].actionStatus, 'inProgress', '兼容lineStatus/status的动作状态也统一');
  for (const value of ['maybe', {}, null]) {
    const invalid = await compile(first, value, 'completed');assert.equal(invalid.status, 'pending');assert.equal(invalid.events.length, 0);
  }
});


test('人工五格兼容具名纪年、季节月、闰月与中文数字，旧区间可再次编辑', () => {
  assert.equal(formatStoryTimeFields({ prefix: '启航', year: '叁佰捌拾柒', month: '贰月', day: '廿二', clock: '９：５至１０：０５' }), '启航387年2月22日 09:05~10:05');
  assert.equal(formatStoryTimeFields({ year: '1', month: '夏月', day: '初一', clock: '10:15-10:25' }), '1年夏月1日 10:15~10:25');
  assert.equal(formatStoryTimeFields({ prefix: '霜历', year: '12', month: '閏贰月', day: '40' }), '霜历12年闰2月40日');
  const draft = storyTimeFields('1年夏1日 周一 10:15-10:25');
  assert.deepEqual(draft, { prefix: '', year: '1', month: '夏', day: '1', clock: '10:15-10:25' });
  assert.equal(formatStoryTimeFields(draft), '1年夏1日 10:15~10:25');
  assert.equal(formatStoryTimeFields({}), null);
  assert.throws(() => formatStoryTimeFields({ clock: '25:00' }), /HH:mm/u);
});

test('人工日期、明确未知及仅时钟在全图、日期分组与增量候选中一致，不借楼层时间', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'date', title: '晚饭待办', description: '约好吃晚饭', status: 'planned', matter: true, storyTime: '2026-07-01 10:00' },
    { key: 'clear', title: '归还旧书', description: '准备归还旧书', status: 'planned', matter: true },
    { key: 'clock', title: '领新信', description: '准备领新信', status: 'planned', matter: true },
  ], order: [] } } });
  const overrides = [{ eventId: delta.events[0].id, storyTime: '启航387年4月7日 14:55~15:05' },
    { eventId: delta.events[1].id, storyTime: null }, { eventId: delta.events[2].id, storyTime: '09:30' }];
  const edited = validateQianshiDelta({ ...delta, manualEventOverrides: overrides }, { floorId: source.id });
  const stored = { ...memory('22222222-2222-4222-8222-222222222222', source, edited), chronology: [{ time: { normalized: '2026-07-02' } }] };
  const reachable = { root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: '33333333-3333-4333-8333-333333333333' }, rootRevision: 2,
    floors: [source], floorMemories: [stored], entities: [] };
  const graph = projectQianshiGraph(reachable);
  const first = graph.events.find(event => event.id === delta.events[0].id);
  assert.equal(first.storyTime, overrides[0].storyTime);
  assert.equal(first.parsedStoryTime.monthDay, 7);
  assert.equal(first.parsedStoryTime.clock, '14:55');
  assert.equal(first.timeManuallyEdited, true);
  for (const raw of delta.events.slice(1)) {
    const event = graph.events.find(item => item.id === raw.id);
    assert.equal(event.parsedStoryTime.date, null);
    assert.equal(event.parsedStoryTime.monthDay, null, '人工不完整日期不借来源楼补全');
  }
  assert.deepEqual(new Set(projectQianshiTimeline(graph).undatedEventIds), new Set(delta.events.slice(1).map(event => event.id)));
  const options = { canonicalContent: '晚饭待办 归还旧书 领新信' };
  const index = createQianshiCandidateIndex();
  index.prepare({ ...reachable, rootRevision: 1, floorMemories: [] }, options);
  assert.deepEqual(index.prepare(reachable, options), prepareQianshiCandidates(reachable, options), '热追加与完整读取使用相同人工时间');
  assert.deepEqual(stored.qianshiDelta.events, delta.events, '显示人工覆盖不改动原模型事件');
});

test('删首中尾与整线沿统一线性投影，人工整线状态优先且异常诊断可定位楼号', async () => {
  const floors = [1, 2, 3].map(n => floor(`${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`, n));
  let value = { status: 'ready', root: { chatId: CHAT, narrativeGeneration: GENERATION }, rootRevision: 1, floors: [], floorMemories: [], entities: [] };
  for (let i = 0; i < floors.length; i += 1) {
    const candidates = prepareQianshiCandidates(value, { canonicalContent: '归还旧书' });
    const delta = await compileQianshiDelta({ floor: floors[i], now: NOW, candidateBindings: candidates.bindings, packet: { qianshi: { events: [{ key: `e${i}`,
      title: ['归还旧书', '拿到旧书', '交还旧书'][i], description: `旧书进展${i}`, status: ['planned', 'inProgress', 'completed'][i],
      matter: true, ...(i ? { links: [{ candidateKey: candidates.request[0].key, kind: 'progress' }] } : {}) }], order: [] } } });
    value = { ...value, floors: [...value.floors, floors[i]], floorMemories: [...value.floorMemories, memory(`${String(i + 4).repeat(8)}-4444-4444-8444-444444444444`, floors[i], delta)] };
  }
  const original = projectQianshiGraph(value), ids = original.events.map(event => event.id), matterId = original.matters[0].matterId;
  assert.equal(original.matters.length, 1);
  for (const removed of [[ids[0]], [ids[1]], [ids[2]], ids]) {
    const next = { ...value, floorMemories: value.floorMemories.map(row => ({ ...row, qianshiDelta: { ...row.qianshiDelta,
      deletedEventIds: row.qianshiDelta.events.filter(event => removed.includes(event.id)).map(event => event.id) } })) };
    const projection = projectQianshiGraph(next), kept = ids.filter(id => !removed.includes(id));
    assert.deepEqual(projection.events.map(event => event.id), kept); assert.equal(projection.matters.length, kept.length ? 1 : 0);
    if (kept.length) { assert.equal(projection.matters[0].matterId, matterId); assert.equal(projection.matters[0].currentEventId, kept.at(-1)); }
    assert.deepEqual(projection.diagnostics.degradedFloorIds, []); assert.equal(projection.coverage.completeFloors, 3);
  }
  const manual = { ...value, floorMemories: value.floorMemories.map((row, i) => i ? row : { ...row,
    qianshiDelta: { ...row.qianshiDelta, deletedEventIds: [ids[0]], manualMatterStatusOverrides: [{ matterId, status: 'inProgress' }] } }) };
  assert.equal(projectQianshiGraph(manual).matters[0].status, 'inProgress');
  const broken = { ...value, floorMemories: value.floorMemories.map((row, i) => i !== 1 ? row : { ...row,
    qianshiDelta: { ...row.qianshiDelta, events: row.qianshiDelta.events.map(event => ({ ...event, continuesFromEventIds: ['99999999-9999-4999-8999-999999999999'] })) } }) };
  const publicView = publicQianshiSnapshot(broken);
  assert.equal(publicView.events.length, 3, '异常楼事件照常进入千事');
  assert.deepEqual(publicView.diagnostics.anomalyFloors[0], { floorId: floors[1].id, messageIndex: 4, assistantSeq: 2,
    eventIds: [ids[1]], reasons: ['找不到前序事件'] });
  const prefix = { ...value, floors: value.floors.slice(0, 1), floorMemories: value.floorMemories.slice(0, 1) };
  const deletedSuffix = { ...value, floors: value.floors.slice(0, 2), floorMemories: value.floorMemories.slice(0, 2).map((row, i) => i ? { ...row,
    qianshiDelta: { ...row.qianshiDelta, deletedEventIds: [ids[1]] } } : row) };
  const hot = createQianshiCandidateIndex(), cold = createQianshiCandidateIndex();
  hot.prepare(prefix, { canonicalContent: '旧书' });
  assert.deepEqual(hot.prepare(deletedSuffix, { canonicalContent: '旧书' }), cold.prepare(deletedSuffix, { canonicalContent: '旧书' }));
});
