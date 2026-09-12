import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicMemoryBridge, formatPublicMemoryProjection, installPublicMemoryBridge, QQJ_PUBLIC_MEMORY_BRIDGE_KEY } from '../src/v3/public-memory-bridge.js';

const QQJ_CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GENERATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FLOOR1 = '11111111-1111-4111-8111-111111111111';
const FLOOR2 = '22222222-2222-4222-8222-222222222222';
const FLOOR3 = 'aaaaaaaa-1111-4111-8111-111111111111';
const MEMORY1 = '33333333-3333-4333-8333-333333333333';
const DELTA1 = '44444444-4444-4444-8444-444444444444';
const BASELINE = '55555555-5555-4555-8555-555555555555';
const PERSON = '66666666-6666-4666-8666-666666666666';
const ITEM = '77777777-7777-4777-8777-777777777777';
const identity = () => ({ hostChatId: 'host-chat', chatId: QQJ_CHAT, characterLocator: 'char.png', personaLocator: 'me.png' });
const source = () => ({
  status: 'ready', chatId: QQJ_CHAT, narrativeGeneration: 'generation', headCheckpointId: 'head', rootRevision: 7,
  coverage: { stableAiFloors: 20, rememberedAiFloors: 19, missingAssistantSeq: [20], cseThroughAssistantSeq: 19, memoryComplete: false, cseCurrent: false },
  entities: [
    { entityId: 'p1', entityType: 'person', displayName: '沈砚', aliases: ['阿砚'], specialRole: 'char' },
    { entityId: 'p2', entityType: 'person', displayName: '顾舟', aliases: [], specialRole: 'user' },
  ],
  floorMemories: [{
    assistantSeq: 1, summary: '用户修订后的长期摘要。', chronology: [{ time: { kind: 'relative', sourceText: '次日清晨', normalized: null, precision: 'unresolved', relativeToAssistantSeq: 7 }, description: '' }], events: [{ title: '雨夜会面', description: '二人在钟楼重逢。' }],
    actions: [{ actorEntityId: 'p1', targetEntityIds: ['p2'], action: '交出地图', completion: 'completed', result: '顾舟收下' }],
    commitments: [{ speakerEntityId: 'p1', targetEntityIds: ['p2'], kind: 'promise', content: '天亮前守住北门', status: 'accepted' }],
    openLoops: [{ description: '追兵身份仍未查明', ownerEntityIds: ['p1'] }],
    privateCognition: [{ ownerEntityId: 'p1', content: '不得对外暴露的原始内心全文' }],
  }],
  currentState: [{ subjectEntityId: 'p1', core: [{ text: '习惯独自承担风险', visibility: 'authorial', reason: '长期塑造', sourceAssistantSeq: 1 }], adaptive: [], situational: [{ text: '担心顾舟受伤', visibility: 'private', reason: '雨夜行动', sourceAssistantSeq: 19 }] }],
});

const emptyMemory = {
  participants: [], locations: [], commitments: [], openLoops: [], exactAnchors: [], eventFragments: [], actions: [], observations: [], privateCognition: [], informationTransfers: [],
};

function reachable({ revision = 7, head = '88888888-8888-4888-8888-888888888888', summary = '雨夜里约定下次在钟楼见。', cseUnavailable = false } = {}) {
  const stateItem = { id: ITEM, text: '始终记得雨夜承诺', visibility: 'private', reason: '亲口答应', origin: 'floor', towardEntityId: null, sourceFloorId: FLOOR1, sourceDeltaId: DELTA1 };
  return {
    status: 'ready', rootRevision: revision,
    root: { status: 'ready', chatId: QQJ_CHAT, narrativeGeneration: GENERATION, headCheckpointId: head, sourceSnapshotFingerprint: `snapshot-${revision}` },
    checkpoint: { id: head, narrativeGeneration: GENERATION, sourceSnapshotFingerprint: `snapshot-${revision}` }, baseline: { id: BASELINE }, run: {},
    floors: [{ id: FLOOR1, assistantSeq: 1 }, { id: FLOOR2, assistantSeq: 2 }],
    floorMemories: [{ id: MEMORY1, floorId: FLOOR1, recordStatus: 'active', summary: { effectiveSource: 'ai', aiText: summary }, ...emptyMemory }],
    entities: [{ id: PERSON, entityType: 'person', displayName: '裴晚生', aliases: [{ name: '阿裴' }], specialRole: 'char', recordStatus: 'active', status: 'established' }],
    stateDeltas: cseUnavailable ? [] : [{ id: DELTA1, floorId: FLOOR1, floorMemoryId: MEMORY1, recordStatus: 'active', subjectSnapshots: [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: [stateItem] }], fixedChanges: [{ subjectEntityId: PERSON, items: [{ category: 'situational', action: 'add', before: null, after: stateItem }] }] }],
    currentStates: [],
    ...(cseUnavailable ? { cseUnavailable: true } : {}),
  };
}

const rootEnvelope = value => ({ status: 'ready', revision: value.rootRevision, data: structuredClone(value.root) });
const readyFoundation = value => ({ getState: () => ({ status: 'ready' }), getReachable: () => value });

test('formatter 保留正式长期记忆和 CSE 可见性边界，不输出 privateCognition 原文', () => {
  const text = formatPublicMemoryProjection(source());
  assert.match(text, /用户修订后的长期摘要/);
  assert.match(text, /AI #1（相对时间（未解析；相对 AI #7）：次日清晨）/);
  assert.match(text, /雨夜会面/);
  assert.match(text, /沈砚 → 顾舟：完成「交出地图」/);
  assert.match(text, /承诺\/计划/);
  assert.match(text, /追兵身份仍未查明/);
  assert.match(text, /作者塑造参考，不代表任何人物知情/);
  assert.match(text, /仅 沈砚 本人知情/);
  assert.match(text, /仅连续到 AI #19，不代表当前完整状态/);
  assert.doesNotMatch(text, /不得对外暴露的原始内心全文/);
});

test('公共桥只调用正式 projection 读取，区分宿主 chatId 与 QQJ UUID，且不触发任何写入或 AI', async () => {
  let reads = 0, writes = 0, aiCalls = 0, saveChatCalls = 0, promptCalls = 0, receiptCalls = 0;
  const bridge = createPublicMemoryBridge({
    session: { getState: () => ({ status: 'ready', identity: identity() }), identity },
    store: {
      readReachable: async () => { reads += 1; return source(); },
      putRecord: async () => { writes += 1; }, replaceRecord: async () => { writes += 1; }, commitRoot: async () => { writes += 1; },
    },
    hostAdapter: { snapshot: () => ({ chatId: 'host-chat', chat: [] }) },
    isEnabled: () => true,
    readSource: async ({ store }) => store.readReachable(),
  });
  const result = await bridge.readMemory();
  assert.equal(result.status, 'ready');
  assert.equal(result.identity.hostChatId, 'host-chat');
  assert.equal(result.identity.qqjChatId, QQJ_CHAT);
  assert.notEqual(result.identity.hostChatId, result.identity.qqjChatId);
  assert.equal(reads, 1);
  assert.equal(writes + aiCalls + saveChatCalls + promptCalls + receiptCalls, 0);
});

test('同版本 ready 地基快照只核对一次 root 并直接走真实 projectRecallSource，公开结果与冷读一致', async () => {
  const value = reachable();
  let rootReads = 0, reachableReads = 0;
  const hostAdapter = { snapshot: () => ({ chatId: 'host-chat', chat: [] }) };
  const session = { getState: () => ({ status: 'ready', identity: identity() }), identity };
  const cold = await createPublicMemoryBridge({
    session,
    store: { readReachable: async () => structuredClone(value) },
    hostAdapter,
  }).readMemory();
  const warm = await createPublicMemoryBridge({
    session,
    store: {
      readRoot: async () => { rootReads += 1; return rootEnvelope(value); },
      readReachable: async () => { reachableReads += 1; throw new Error('同版本缓存命中不应重新 readReachable'); },
    },
    hostAdapter,
    foundationRuntime: readyFoundation(value),
  }).readMemory();

  assert.equal(warm.status, 'ready');
  assert.equal(rootReads, 1);
  assert.equal(reachableReads, 0);
  assert.deepEqual({ text: warm.text, anchor: warm.anchor, coverage: warm.coverage }, { text: cold.text, anchor: cold.anchor, coverage: cold.coverage });
  assert.match(warm.text, /雨夜里约定下次在钟楼见/);
  assert.match(warm.text, /始终记得雨夜承诺/);
});

test('公共桥 fresh 投影使用当前人工合并映射，旧称历史归保留人物且 toward 同步改写', async () => {
  const value = reachable();
  const target = '99999999-9999-4999-8999-999999999999';
  value.entities.push({ ...value.entities[0], id: target, displayName: '裴今生', aliases: [] });
  value.stateDeltas[0].subjectSnapshots[0].situational[0].towardEntityId = PERSON;
  const bridge = createPublicMemoryBridge({
    session: { getState: () => ({ status: 'ready', identity: identity() }), identity },
    store: { readReachable: async () => structuredClone(value) },
    hostAdapter: { snapshot: () => ({ chatId: 'host-chat', chat: [] }) },
    identityProjectionProvider: async () => ({ identityRedirectsByEntityId: { [PERSON]: target }, deletedEntityIds: [] }),
  });
  const result = await bridge.readMemory();
  assert.equal(result.status, 'ready'); assert.match(result.text, /裴今生（别名：裴晚生、阿裴）/);
  assert.match(result.text, /对象：裴今生/); assert.doesNotMatch(result.text, /- 裴晚生（/);
});

test('root 版本变化或无 ready 完整快照时沿用原 readRecallSource，并返回新版本', async () => {
  const cached = reachable();
  const changed = reachable({ revision: 8, head: '99999999-9999-4999-8999-999999999999', summary: '新版本钟楼记忆。' });
  let rootReads = 0, reachableReads = 0;
  const bridge = createPublicMemoryBridge({
    session: { getState: () => ({ status: 'ready', identity: identity() }), identity },
    store: {
      readRoot: async () => { rootReads += 1; return rootEnvelope(changed); },
      readReachable: async () => { reachableReads += 1; return structuredClone(changed); },
    },
    hostAdapter: { snapshot: () => ({ chatId: 'host-chat', chat: [] }) },
    foundationRuntime: readyFoundation(cached),
  });
  const result = await bridge.readMemory();
  assert.equal(result.status, 'ready');
  assert.match(result.text, /新版本钟楼记忆/);
  assert.deepEqual(result.anchor, { narrativeGeneration: GENERATION, headCheckpointId: changed.root.headCheckpointId, rootRevision: 8 });
  assert.equal(rootReads, 1);
  assert.equal(reachableReads, 1);

  let coldReads = 0;
  const noSnapshot = createPublicMemoryBridge({
    session: { getState: () => ({ status: 'ready', identity: identity() }), identity },
    store: { readReachable: async () => { coldReads += 1; return structuredClone(changed); } },
    hostAdapter: { snapshot: () => ({ chatId: 'host-chat', chat: [] }) },
    foundationRuntime: { getState: () => ({ status: 'idle' }), getReachable: () => cached },
  });
  assert.equal((await noSnapshot.readMemory()).status, 'ready');
  assert.equal(coldReads, 1);
});

test('同版本候选的 readRoot 报错不把旧快照当成功，旧格式 CSE fallback 冷读仍保留摘要', async () => {
  const cached = reachable();
  let reachableReads = 0;
  const failed = createPublicMemoryBridge({
    session: { getState: () => ({ status: 'ready', identity: identity() }), identity },
    store: {
      readRoot: async () => { throw new Error('root GET failed'); },
      readReachable: async () => { reachableReads += 1; return structuredClone(cached); },
    },
    hostAdapter: { snapshot: () => ({ chatId: 'host-chat', chat: [] }) },
    foundationRuntime: readyFoundation(cached),
  });
  const error = await failed.readMemory();
  assert.equal(error.status, 'error');
  assert.match(error.message, /root GET failed/);
  assert.equal(reachableReads, 0);

  const legacyCse = reachable({ cseUnavailable: true, summary: '旧格式仍可用的长期摘要。' });
  const fallback = await createPublicMemoryBridge({
    session: { getState: () => ({ status: 'ready', identity: identity() }), identity },
    store: { readReachable: async options => {
      assert.deepEqual(options, { mode: 'projection', allowRecallCseFallback: true });
      return structuredClone(legacyCse);
    } },
    hostAdapter: { snapshot: () => ({ chatId: 'host-chat', chat: [] }) },
  }).readMemory();
  assert.equal(fallback.status, 'ready');
  assert.match(fallback.text, /旧格式仍可用的长期摘要/);
  assert.doesNotMatch(fallback.text, /当前人物状态/);
});

test('关闭、未 ready 和切聊天迟到均返回简明状态，不自动 prepare 身份', async () => {
  let prepareCalls = 0, rootReads = 0, resolveRead;
  let current = identity();
  const session = {
    getState: () => ({ status: 'ready', identity: current }),
    identity: () => current,
    prepare: () => { prepareCalls += 1; },
  };
  const foundationRuntime = readyFoundation(reachable());
  const disabled = createPublicMemoryBridge({ session, store: { readRoot: async () => { rootReads += 1; }, readReachable: async () => source() }, hostAdapter: { snapshot: () => ({ chatId: 'host-chat', chat: [] }) }, foundationRuntime, isEnabled: false });
  assert.equal((await disabled.readMemory()).status, 'disabled');
  const notReady = createPublicMemoryBridge({ session: { ...session, getState: () => ({ status: 'idle' }) }, store: { readRoot: async () => { rootReads += 1; }, readReachable: async () => source() }, hostAdapter: { snapshot: () => ({ chatId: 'host-chat', chat: [] }) }, foundationRuntime });
  assert.equal((await notReady.readMemory()).status, 'not-ready');
  const pending = createPublicMemoryBridge({ session, store: { readReachable: () => new Promise(resolve => { resolveRead = resolve; }) }, hostAdapter: { snapshot: () => ({ chatId: current.hostChatId, chat: [] }) }, readSource: async ({ store }) => store.readReachable() });
  const task = pending.readMemory();
  current = { ...identity(), hostChatId: 'other-host-chat' };
  resolveRead(source());
  assert.equal((await task).status, 'stale');
  assert.equal(prepareCalls, 0);
  assert.equal(rootReads, 0);
});

test('getSnapshot 同步返回三分区副本，保留重分析中的人工摘要并区分 CSE 已知空与未知', () => {
  let memoryReads = 0, peopleReads = 0, forbiddenCalls = 0;
  const forbiddenCall = () => { forbiddenCalls += 1; throw new Error('getSnapshot 不得调用读取之外的入口'); };
  const stateItem = { id: ITEM, text: '仍在等待答复', visibility: 'private', reason: '已保存依据', origin: 'delta', towardEntityId: PERSON, towardDisplayName: '裴晚生', sourceFloorId: FLOOR1, sourceAssistantSeq: 1, internal: '不公开' };
  const beforeItem = { id: 'old-item', text: '原先保持距离', visibility: 'observable', reason: '旧依据', origin: 'delta', towardEntityId: PERSON, towardDisplayName: '裴晚生', sourceFloorId: FLOOR1, sourceAssistantSeq: 1 };
  const savedItem = { text: '楼内保存状态', visibility: 'expressed', reason: '当楼表达', origin: 'delta', towardEntityId: null, towardDisplayName: null, sourceFloorId: FLOOR1, sourceAssistantSeq: 1 };
  const memoryState = {
    status: 'running', chatId: QQJ_CHAT, memorySnapshotStatus: 'ready', memorySyncStatus: 'syncing', headCheckpointId: 'head-public', cseReady: false,
    cseSubjects: [{ subjectEntityId: PERSON, displayName: '裴晚生', core: [stateItem], adaptive: [], situational: [] }],
    floors: [{
      floorId: FLOOR1, messageIndex: 12, assistantSeq: 7, status: 'running', summary: '人工摘要第一行\n人工摘要第二行', summarySource: 'user', memory: { recordStatus: 'active', raw: '不公开' },
      cse: { status: 'running', deltaId: DELTA1, record: { fixedChangesAvailable: true, subjects: [{ subjectEntityId: PERSON, displayName: '裴晚生', changes: [{ category: 'situational', action: 'update', beforeText: '重复旧文本', afterText: '重复新文本', before: beforeItem, after: stateItem }] }], endStateSubjects: [{ subjectEntityId: PERSON, displayName: '裴晚生', core: [], adaptive: [], situational: [savedItem] }] } },
    }, {
      floorId: FLOOR2, messageIndex: 14, assistantSeq: 8, status: 'ready', summary: '旧楼摘要', summarySource: 'ai', memory: { recordStatus: 'active' },
      cse: { status: 'ready', deltaId: 'legacy-delta', record: { fixedChangesAvailable: false, subjects: [{ subjectEntityId: PERSON, displayName: '裴晚生', changes: [{ category: 'core', action: 'add', before: null, after: stateItem }] }], endStateSubjects: [{ subjectEntityId: PERSON, displayName: '裴晚生', core: [savedItem], adaptive: [], situational: [] }] } },
    }, {
      floorId: FLOOR3, messageIndex: 16, assistantSeq: 9, status: 'ready', summary: '零变化摘要', summarySource: 'ai', memory: { recordStatus: 'active' },
      cse: { status: 'noChange', deltaId: 'empty-delta', record: { fixedChangesAvailable: true, subjects: [], endStateSubjects: [] } },
    }],
  };
  const profile = { entityId: PERSON, name: '裴晚生', aliases: '阿裴', gender: '', notes: '保留全文资料', manualFields: ['notes'], source: 'manual', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z', privateProgress: '不公开' };
  const peopleState = { status: 'generating', chatId: QQJ_CHAT, revision: 9, people: [{ entityId: PERSON, displayName: '裴晚生', entityDisplayName: '旧称甲', aliases: ['阿裴'], specialRole: 'char', selected: true, profiled: true, profile, avatar: 'data:image/png;base64,PRIVATE' }] };
  const bridge = createPublicMemoryBridge({
    session: { getState: () => ({ status: 'ready', identity: identity() }), identity, prepare: forbiddenCall },
    store: { readReachable: forbiddenCall, readRoot: forbiddenCall, putRecord: forbiddenCall, replaceRecord: forbiddenCall, commitRoot: forbiddenCall },
    hostAdapter: { snapshot: forbiddenCall },
    memoryRuntime: { getState: () => { memoryReads += 1; return memoryState; }, refreshStatus: forbiddenCall, prepareCurrent: forbiddenCall, extractFloor: forbiddenCall, analyzeNextState: forbiddenCall },
    peopleRuntime: { getState: () => { peopleReads += 1; return peopleState; }, refresh: forbiddenCall, generateMissingProfiles: forbiddenCall, regenerateProfile: forbiddenCall },
  });

  const result = bridge.getSnapshot();
  assert.equal(result instanceof Promise, false);
  assert.equal(memoryReads, 1); assert.equal(peopleReads, 1);
  assert.equal(forbiddenCalls, 0, '不得读取 store、宿主正文或触发准备、刷新、摘要/CSE分析及人物生成');
  assert.deepEqual(result.identity, { hostChatId: 'host-chat', qqjChatId: QQJ_CHAT, characterLocator: 'char.png', personaLocator: 'me.png' });
  assert.deepEqual(result.memory, { status: 'ready', syncStatus: 'syncing', headCheckpointId: 'head-public', floors: [
    { floorId: FLOOR1, messageIndex: 12, assistantSeq: 7, summary: '人工摘要第一行\n人工摘要第二行', summarySource: 'user' },
    { floorId: FLOOR2, messageIndex: 14, assistantSeq: 8, summary: '旧楼摘要', summarySource: 'ai' },
    { floorId: FLOOR3, messageIndex: 16, assistantSeq: 9, summary: '零变化摘要', summarySource: 'ai' },
  ] });
  assert.equal(result.cse.ready, false, '部分 CSE 仍可在 cseReady=false 时公开');
  assert.equal(result.cse.currentSubjects[0].core[0].id, ITEM);
  assert.equal(Object.hasOwn(result.cse.currentSubjects[0].core[0], 'internal'), false);
  assert.deepEqual(result.cse.floors.map(floor => [floor.status, floor.changesKnown]), [['running', true], ['ready', false], ['noChange', true]]);
  assert.deepEqual(result.cse.floors[0].changes[0].changes[0], { category: 'situational', action: 'update', before: { id: 'old-item', text: '原先保持距离', visibility: 'observable', reason: '旧依据', origin: 'delta', towardEntityId: PERSON, towardDisplayName: '裴晚生', sourceFloorId: FLOOR1, sourceAssistantSeq: 1 }, after: { id: ITEM, text: '仍在等待答复', visibility: 'private', reason: '已保存依据', origin: 'delta', towardEntityId: PERSON, towardDisplayName: '裴晚生', sourceFloorId: FLOOR1, sourceAssistantSeq: 1 } });
  assert.equal(Object.hasOwn(result.cse.floors[0].changes[0].changes[0], 'beforeText'), false);
  assert.equal(result.cse.floors[1].changes, null, '旧记录逐项变化未知，不得冒充已确认零变化');
  assert.equal(result.cse.floors[1].savedSubjects[0].core[0].text, '楼内保存状态', '旧记录自身保存的楼内快照仍可读取');
  assert.deepEqual(result.cse.floors[2].changes, [], '新记录明确保存的零变化保持为空数组');
  assert.equal(result.cse.floors[0].savedSubjects[0].situational[0].id, null, '历史 DTO 未提供 id 时明确返回 null');
  assert.equal(result.people.status, 'generating'); assert.equal(result.people.revision, 9);
  assert.equal(result.people.items[0].profile.notes, '保留全文资料');
  assert.equal(Object.hasOwn(result.people.items[0], 'avatar'), false); assert.equal(Object.hasOwn(result.people.items[0].profile, 'privateProgress'), false);

  result.memory.floors[0].summary = '第三方篡改';
  result.cse.currentSubjects[0].core[0].text = '第三方篡改';
  result.cse.floors[0].changes[0].changes[0].after.text = '第三方篡改';
  result.people.items[0].aliases.push('第三方别名'); result.people.items[0].profile.notes = '第三方篡改';
  const again = bridge.getSnapshot();
  assert.equal(memoryReads, 2); assert.equal(peopleReads, 2);
  assert.equal(forbiddenCalls, 0);
  assert.equal(again.memory.floors[0].summary, '人工摘要第一行\n人工摘要第二行');
  assert.equal(again.cse.currentSubjects[0].core[0].text, '仍在等待答复');
  assert.equal(again.cse.floors[0].changes[0].changes[0].after.text, '仍在等待答复');
  assert.deepEqual(again.people.items[0].aliases, ['阿裴']); assert.equal(again.people.items[0].profile.notes, '保留全文资料');
  assert.deepEqual(peopleState.people[0].aliases, ['阿裴']); assert.equal(profile.notes, '保留全文资料');
});

test('getSnapshot 在关闭、未加载及聊天不匹配时不触发准备并让三个分区独立降级', () => {
  let memoryReads = 0, peopleReads = 0, prepares = 0;
  const base = {
    session: { getState: () => ({ status: 'ready', identity: identity() }), identity, prepare: () => { prepares += 1; } },
    store: { readReachable: async () => source() },
    hostAdapter: { snapshot: () => ({ chatId: 'host-chat', chat: [] }) },
    memoryRuntime: { getState: () => { memoryReads += 1; return { chatId: QQJ_CHAT, memorySnapshotStatus: 'unavailable', memorySyncStatus: 'syncing', headCheckpointId: 'wrong', floors: [], cseReady: false, cseSubjects: [] }; } },
    peopleRuntime: { getState: () => { peopleReads += 1; return { chatId: QQJ_CHAT, status: 'ready', revision: 3, people: [] }; } },
  };
  const disabled = createPublicMemoryBridge({ ...base, isEnabled: false });
  assert.equal(disabled.getSnapshot().status, 'disabled');
  assert.equal(memoryReads + peopleReads + prepares, 0, '关闭时不得读取任何 runtime getter');

  const partial = createPublicMemoryBridge(base).getSnapshot();
  assert.deepEqual(partial.memory, { status: 'unavailable', syncStatus: 'syncing', headCheckpointId: null, floors: [] });
  assert.deepEqual(partial.cse, { ready: false, currentSubjects: [], floors: [] });
  assert.deepEqual(partial.people, { status: 'ready', revision: 3, items: [] });

  const mismatch = createPublicMemoryBridge({
    ...base,
    memoryRuntime: { getState: () => { memoryReads += 1; return { chatId: 'other-chat', memorySnapshotStatus: 'ready', memorySyncStatus: 'idle', headCheckpointId: 'foreign', floors: [{ memory: { recordStatus: 'active' }, summary: '串档' }] }; } },
    peopleRuntime: { getState: () => { peopleReads += 1; return { chatId: 'other-chat', status: 'ready', revision: 10, people: [{ entityId: PERSON, displayName: '串档' }] }; } },
  }).getSnapshot();
  assert.deepEqual(mismatch.memory, { status: 'not-ready', syncStatus: 'idle', headCheckpointId: null, floors: [] });
  assert.deepEqual(mismatch.cse, { ready: false, currentSubjects: [], floors: [] });
  assert.deepEqual(mismatch.people, { status: 'not-ready', revision: null, items: [] });
  assert.equal(prepares, 0);
});

test('getSnapshot getter 异常只返回现有桥边界错误，不读取后续分区', () => {
  let peopleReads = 0;
  const bridge = createPublicMemoryBridge({
    session: { getState: () => ({ status: 'ready', identity: identity() }), identity },
    store: { readReachable: async () => source() },
    hostAdapter: { snapshot: () => ({ chatId: 'host-chat', chat: [] }) },
    memoryRuntime: { getState: () => { throw new Error('snapshot provider failed'); } },
    peopleRuntime: { getState: () => { peopleReads += 1; return {}; } },
  });
  assert.deepEqual(bridge.getSnapshot(), { status: 'error', message: 'snapshot provider failed', identity: { hostChatId: 'host-chat', qqjChatId: QQJ_CHAT, characterLocator: 'char.png', personaLocator: 'me.png' } });
  assert.equal(peopleReads, 0);
});

test('安装器只清理自己挂载的版本化桥', () => {
  const globalRef = {};
  const mount = installPublicMemoryBridge({ globalRef, session: { getState: () => ({ status: 'ready', identity: identity() }), identity }, store: { readReachable: async () => source() }, hostAdapter: { snapshot: () => ({ chatId: 'host-chat', chat: [] }) } });
  assert.equal(globalRef[QQJ_PUBLIC_MEMORY_BRIDGE_KEY], mount.bridge);
  assert.equal(typeof mount.bridge.getSnapshot, 'function');
  mount.cleanup();
  assert.equal(Object.hasOwn(globalRef, QQJ_PUBLIC_MEMORY_BRIDGE_KEY), false);
});
