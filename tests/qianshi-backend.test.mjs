import test from 'node:test';
import assert from 'node:assert/strict';
import { compileQianshiDelta, prepareQianshiCandidates, projectQianshiGraph, projectQianshiRecall } from '../src/v3/qianshi-domain.js';
import { projectTime } from '../src/v3/time-engine.js';
import { createExtractorEnvelope, runExtractorRequest } from '../src/v3/extractor.js';
import { createPublicQianshiBridge } from '../src/v3/public-qianshi-bridge.js';
import { validateQianshiDelta } from '../src/v3/qianshi-schema.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GENERATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = '2026-09-16T00:00:00.000Z';
const floor = (id, assistantSeq) => ({ id, chatId: CHAT, narrativeGeneration: GENERATION, assistantSeq, content: { canonicalContent: `第${assistantSeq}楼` } });
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
  assert.doesNotMatch(bookRecall.text, /红蜡信|当前待接续/u);
  const letterRecall = projectQianshiRecall(reachable, { queryContext: { text: '红蜡信寄出了吗', latestUserText: '红蜡信寄出了吗' } });
  assert.match(letterRecall.text, /准备寄出红蜡信（此后尚未记录完成）/u);
  assert.doesNotMatch(letterRecall.text, /蓝皮档案|当前待接续/u);
});

test('当前待接续用正文时间跨度跨午夜计算，排除跨月旧项并把未来约定留作待办', async () => {
  const source = floor('11111111-1111-4111-8111-111111111111', 1);
  const delta = await compileQianshiDelta({ floor: source, now: NOW, packet: { qianshi: { events: [
    { key: 'old', title: '旧宴后归还餐盒', description: '很久以前答应归还餐盒', status: 'planned', matter: true, storyTime: '2026-05-01 12:00' },
    { key: 'overnight', title: '守住北门钥匙', description: '午夜前接下守钥匙的安排', status: 'inProgress', matter: true, storyTime: '2026-06-14 23:55' },
    { key: 'future', title: '前往钟楼换岗', description: '约好稍后前往钟楼换岗', status: 'planned', matter: true, storyTime: '2026-06-15 00:05', scheduledTime: '2026-06-15 00:30' },
    { key: 'unknown', title: '苍月祭后兑现承诺', description: '日期体系不明的旧承诺', status: 'planned', matter: true, storyTime: '苍月祭' },
    { key: 'done', title: '交回南门徽章', description: '南门徽章已经交回', status: 'completed', matter: true, storyTime: '2026-06-15 00:03' },
  ], order: [] } } });
  const reachable = { root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, rootRevision: 1,
    floors: [source], floorMemories: [memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', source, delta)], entities: [] };
  const currentTime = projectTime('2026-06-15 00:05');
  const recall = projectQianshiRecall(reachable, { queryContext: { text: '继续现在的场景', latestUserText: '继续现在的场景' }, currentTime,
    recentStoryTimes: [projectTime('2026-06-14 23:45'), currentTime] });
  assert.match(recall.text, /\[当前待接续\][\s\S]*前往钟楼换岗；约定：2026-06-15 00:30；尚未记录完成。[\s\S]*守住北门钥匙/u);
  assert.doesNotMatch(recall.text, /旧宴后归还餐盒|苍月祭后兑现承诺|交回南门徽章/u);
  assert.match(recall.text, /2026-06-15 00:05：前往钟楼换岗/u);
  assert.doesNotMatch(recall.text, /00:30：前往钟楼换岗/u, 'scheduledTime 不能冒充已经发生的时间');

  const old = projectQianshiRecall(reachable, { queryContext: { text: '旧宴后归还餐盒', latestUserText: '旧宴后归还餐盒' }, currentTime,
    recentStoryTimes: [projectTime('2026-06-14 23:45'), currentTime] });
  assert.match(old.text, /2026-05-01 12:00：旧宴后归还餐盒（此后尚未记录完成）/u);
  assert.doesNotMatch(old.text, /\[当前待接续\][\s\S]*旧宴后归还餐盒/u);

  const unknown = projectQianshiRecall(reachable, { queryContext: { text: '苍月祭承诺', latestUserText: '苍月祭承诺' }, currentTime,
    recentStoryTimes: [projectTime('2026-06-14 23:45'), currentTime] });
  assert.match(unknown.text, /苍月祭后兑现承诺（此后尚未记录完成）/u);
  assert.doesNotMatch(unknown.text, /\[当前待接续\][\s\S]*苍月祭后兑现承诺/u);
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
  assert.equal(recall.projectionVersion, 2);
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
  assert.match(recall.text, /大陆历1686年8月5日：纪年边界事件1[\s\S]*木叶历1686年7月1日：纪年边界事件2[\s\S]*时间未知：纪年边界事件3[\s\S]*1686-06-01：纪年边界事件4/u);
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
