import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicMemoryBridge } from '../src/v3/public-memory-bridge.js';
import { scanWorldInfo } from '../src/world-info-scanner.js';
import { createSourcePermissionController } from '../src/source-permission.js';

const identity = { hostChatId: 'host', chatId: 'qqj-chat', characterLocator: 'card', personaLocator: 'persona' };
const floorId = 'floor-1';
const personA = 'entity-a';
const personB = 'entity-b';
const memory = (id, summary, seq, cognition = []) => ({
  id, floorId: `floor-${seq}`, recordStatus: 'active', assistantSeq: seq,
  summary: { effectiveSource: 'user', userText: summary, aiText: `模型摘要：${summary}` },
  actions: [], observations: [], informationTransfers: [], privateCognition: cognition, commitments: [], openLoops: [],
  chronology: [], events: [],
});
const state = (entityId, text, visibility = 'private') => ({
  subjectEntityId: entityId,
  core: [{ text, visibility, reason: '正式记录', sourceFloorId: floorId, sourceAssistantSeq: 1 }],
  adaptive: [], situational: [],
});
function fixture({ query = '', profileA = '人工档案甲', profileB = '人工档案乙', cse = [state(personA, '甲的私密状态'), state(personB, '乙的私密状态')], currentStateStatus = 'ready' } = {}) {
  const calls = { memoryState: 0, currentState: 0, getState: 0, getSnapshot: 0, model: 0, sourceReader: 0, prompt: 0 };
  const reachable = {
    status: 'ready', rootRevision: 1,
    root: { status: 'ready', chatId: identity.chatId, narrativeGeneration: 'gen', headCheckpointId: 'head', sourceSnapshotFingerprint: 'source' },
    checkpoint: { id: 'head', narrativeGeneration: 'gen', sourceSnapshotFingerprint: 'source' }, run: {}, baseline: { id: 'base' },
    floors: [1, 2, 3].map(n => ({ id: `floor-${n}`, assistantSeq: n })),
    floorMemories: [memory('m1', '人工摘要写着海边灯塔与旧船', 1, [{ ownerEntityId: personA, content: '甲独自藏起灯塔钥匙' }]), memory('m2', '雨夜里守住石桥', 2), memory('m3', '在山路上寻找药材', 3)],
    entities: [
      { id: personA, entityType: 'person', displayName: '同名人物', aliases: [], status: 'established', recordStatus: 'active' },
      { id: personB, entityType: 'person', displayName: '同名人物', aliases: [], status: 'established', recordStatus: 'active' },
    ], stateDeltas: [], currentStates: [],
  };
  const bridge = createPublicMemoryBridge({
    session: { getState: () => ({ status: 'ready', identity }), identity: () => identity },
    store: { readReachable: async () => { calls.sourceReader++; return structuredClone(reachable); } },
    hostAdapter: { snapshot: () => ({ chatId: identity.hostChatId, chat: [] }) },
    foundationRuntime: { getState: () => ({ status: 'ready' }), getReachable: () => reachable },
    memoryRuntime: { getState: () => { calls.memoryState++; return { status: 'idle' }; }, getCurrentSubjectStates: entityIds => { calls.currentState++; return { status: currentStateStatus, subjects: currentStateStatus === 'ready' ? entityIds.map(id => cse.find(value => value.subjectEntityId === id)).filter(Boolean) : [] }; } },
    peopleRuntime: { getState: () => ({ status: 'ready', chatId: identity.chatId, revision: 4, people: [
      { entityId: personA, displayName: '同名人物', aliases: [], profile: { name: profileA, notes: '甲的档案' } },
      { entityId: personB, displayName: '同名人物', aliases: [], profile: { name: profileB, notes: '乙的档案' } },
    ] }) },
    readWorldInfoProvider: async () => ({ status: 'ready', worldbook: [{ uid: 'book::1', comment: '灯塔', keys: ['灯塔'], content: '原文\n保留格式', constant: true, position: 0 }] }),
    generateModel: () => { calls.model++; },
    readSource: async () => { calls.sourceReader++; return { status: 'ready' }; },
  });
  return { bridge, calls, reachable };
}

test('public people snapshot reads only the maintained people projection and returns selected profiles', () => {
  const { bridge, calls } = fixture();
  assert.deepEqual(bridge.getPeopleSnapshot().people.items.map(value => value.profile.name), ['人工档案甲', '人工档案乙']);
  assert.equal(calls.memoryState, 0);
  assert.equal(calls.sourceReader, 0);
});

test('public context returns actor-owned materials, keeps identities distinct, and query changes selected memories', async () => {
  const first = fixture();
  const result = await first.bridge.readContext({ query: '灯塔 钥匙', entityIds: [personA, personB], maxCharacters: 12000 });
  assert.equal(result.status, 'ready', JSON.stringify(result));
  assert.equal(result.coverage.cseStatus, 'ready');
  assert.match(result.routerText, /人工摘要写着海边灯塔/);
  assert.doesNotMatch(result.routerText, /雨夜里守住石桥/);
  assert.match(result.actors.find(value => value.entityId === personA).memoryText, /甲独自藏起灯塔钥匙/);
  assert.doesNotMatch(result.actors.find(value => value.entityId === personB).memoryText + result.actors.find(value => value.entityId === personB).stateText, /甲独自藏起灯塔钥匙|甲的私密状态/);
  assert.match(result.actors.find(value => value.entityId === personB).stateText, /乙的私密状态/);
  const second = await first.bridge.readContext({ query: '山路 药材', entityIds: [personA, personB], maxCharacters: 12000 });
  assert.match(second.routerText, /山路上寻找药材/);
  assert.match(second.routerText, /在山路上寻找药材/);
  assert.doesNotMatch(second.routerText, /灯塔与旧船/);
  assert.equal(first.calls.memoryState, 0);
  assert.equal(first.calls.currentState, 2);
  assert.equal(first.calls.model + first.calls.prompt, 0);
  assert.equal(first.calls.sourceReader, 0);
});

test('CSE readiness is reported separately from context budget coverage', async () => {
  const { bridge } = fixture({ currentStateStatus: 'not-ready' });
  const result = await bridge.readContext({ entityIds: [personA], maxCharacters: 12000 });
  assert.equal(result.status, 'ready');
  assert.equal(result.coverage.cseStatus, 'not-ready');
  assert.equal(result.coverage.partial, false);
  assert.match(result.actors[0].profileText, /人工档案甲/);
});

test('public context bounds a large loaded snapshot without invoking full readers or UI projection', async () => {
  const { bridge, calls, reachable } = fixture();
  const initial = reachable.floors.length;
  for (let index = initial + 1; index <= 360; index++) {
    const floorId = `floor-${index}`;
    reachable.floors.push({ id: floorId, assistantSeq: index });
    reachable.floorMemories.push({ ...memory(`m${index}`, `河谷行程第${index}段`, index), floorId });
  }
  for (let index = 0; index < 24; index++) reachable.entities.push({ id: `entity-${index}`, entityType: 'person', displayName: `人物${index}`, recordStatus: 'active', status: 'established' });
  const result = await bridge.readContext({ query: '河谷行程', entityIds: reachable.entities.filter(value => value.entityType === 'person').map(value => value.id), maxCharacters: 12000 });
  assert.equal(result.status, 'ready');
  assert.equal(result.actors.length, 26);
  assert.ok(result.coverage.selectedCharacters <= result.coverage.maxCharacters);
  assert.equal(calls.currentState, 1);
  assert.equal(calls.memoryState + calls.sourceReader + calls.model + calls.prompt, 0);
});

test('public world info keeps source text and returns scanner records', async () => {
  const { bridge } = fixture();
  assert.deepEqual(await bridge.readWorldInfo(), { status: 'ready', identity: { hostChatId: 'host', qqjChatId: 'qqj-chat', characterLocator: 'card', personaLocator: 'persona' }, worldbook: [{ uid: 'book::1', comment: '灯塔', keys: ['灯塔'], content: '原文\n保留格式', constant: true, position: 0 }] });
});

test('按题资料保留态度对象和旧未结事项的来源语境', async () => {
  const attitude = state(personA, '甲只信任乙'); attitude.core[0].towardEntityId = personB;
  const { bridge, reachable } = fixture({ cse: [attitude, state(personB, '乙的状态')] });
  reachable.floorMemories[0].openLoops = [{ ownerEntityIds: [personA], description: '寻找失落的钥匙' }];
  const result = await bridge.readContext({ entityIds: [personA], query: '钥匙', maxCharacters: 12000 });
  const actor = result.actors[0];
  assert.match(actor.stateText, /态度对象：entity-b/);
  assert.match(actor.memoryText, /来源楼当时未结，后文可能已推进，以后文为准/);
  assert.match(actor.memoryText, /AI #1；记忆 m1/);
});

test('public world info uses the real scanner and excludes an entire book through QQJ permissions', async () => {
  const context = {
    characterId: 0,
    characters: [{ avatar: 'card.png', data: { extensions: { world: '排除书' } } }],
    chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: identity.chatId }, world_info: ['允许书'] },
    loadWorldInfoBatch: async names => new Map(names.map(name => [name, { entries: { 7: { uid: 7, comment: name, key: ['灯塔'], content: `${name}\n正文不清洗`, constant: true } } } ])),
    getWorldInfoNames: () => ['排除书', '允许书'],
  };
  const settings = { get: () => ({ sourceWorldInfoExcludedBooks: ['排除书'] }), update() {} };
  const permissions = createSourcePermissionController({ settings, contextProvider: () => context, bookNamesProvider: async () => [] });
  const scannerBridge = createPublicMemoryBridge({
    session: { getState: () => ({ status: 'ready', identity }), identity: () => identity },
    store: { readReachable: async () => { throw new Error('world info must not read memory'); } },
    hostAdapter: { snapshot: () => ({ chatId: identity.hostChatId, chat: [] }) },
    readWorldInfoProvider: async () => {
      const catalog = await scanWorldInfo(context, { complete: true, strict: true, includeCatalog: false, filterBookNames: names => permissions.filterWorldInfoSources(names.map(sourceName => ({ sourceName }))).map(source => source.sourceName) });
      return { status: 'ready', worldbook: catalog.entries.map(entry => ({ uid: entry.key, comment: entry.comment, keys: [...entry.primaryKeys, ...entry.secondaryKeys], content: entry.content, constant: entry.constant })) };
    },
  });
  const result = await scannerBridge.readWorldInfo();
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.worldbook.map(entry => entry.uid), ['允许书::7']);
  assert.equal(result.worldbook[0].content, '允许书\n正文不清洗');
});
