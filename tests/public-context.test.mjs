import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicMemoryBridge } from '../src/v3/public-memory-bridge.js';
import { createFoundationRuntime } from '../src/v3/foundation-runtime.js';
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
function fixture({ query = '', profileA = '人工档案甲', profileB = '人工档案乙', profileAFields = {}, cse = [state(personA, '甲的私密状态'), state(personB, '乙的私密状态')], currentStateStatus = 'ready', peoplePrepared = true } = {}) {
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
    peopleRuntime: peoplePrepared ? { getState: () => ({ status: 'ready', chatId: identity.chatId, revision: 4, people: [
      { entityId: personA, displayName: '同名人物', aliases: [], profile: { name: profileA, notes: '甲的档案', ...profileAFields } },
      { entityId: personB, displayName: '同名人物', aliases: [], profile: { name: profileB, notes: '乙的档案' } },
    ] }) } : null,
    readWorldInfoProvider: async () => ({ status: 'ready', worldbook: [{ uid: 'book::1', comment: '灯塔', keys: ['灯塔'], content: '原文\n保留格式', constant: true, position: 0 }] }),
    generateModel: () => { calls.model++; },
    readSource: async () => { calls.sourceReader++; return { status: 'ready' }; },
  });
  return { bridge, calls, reachable };
}

test('bounded summary selection keeps up to twenty complete relevant memories in source order', async () => {
  const h = fixture();
  h.reachable.floors = Array.from({ length: 1000 }, (_, i) => ({ id: `floor-${i + 1}`, assistantSeq: i + 1 }));
  h.reachable.floorMemories = h.reachable.floors.map((floor, i) => memory(`m-${i + 1}`, `灯塔线索${i + 1}：${'核对灯塔来信中的线索。'.repeat(12)}完整结束${i + 1}。`, i + 1));
  const value = await h.bridge.readContext({ query: '灯塔线索', maxSummaries: 20, recentSummaries: 3, summaryCharacters: 8000, maxCharacters: 12000 });
  const sequences = [...value.routerText.matchAll(/AI #(\d+)/g)].map(match => Number(match[1]));
  assert.equal(sequences.length, 20);
  assert.deepEqual(sequences, Array.from({ length: 20 }, (_, i) => 981 + i));
  for (const seq of sequences) assert.ok(value.routerText.includes(h.reachable.floorMemories[seq - 1].summary.userText));
  assert.ok(value.routerText.length <= 8000);
  assert.ok(value.coverage.selectedCharacters <= 12000);
  assert.equal(h.calls.sourceReader, 0); assert.equal(h.calls.model, 0);
});

test('an explicit story topic uses the existing scorer without being drowned by recent narrative', async () => {
  const h = fixture();
  h.reachable.floorMemories[0].summary.userText = '她已经明确告诉他，本月二十八日是自己的生日。';
  h.reachable.floorMemories[1].summary.userText = '雨夜经过石桥，在山路上寻找药材，核对来信，商量周末乘车去海边。';
  const value = await h.bridge.readContext({ query: '雨夜 石桥 山路 药材 来信 周末 乘车 海边', focusQuery: '二十八日 生日', maxSummaries: 1, summaryCharacters: 8000 });
  assert.match(value.routerText, /已经明确告诉他/);
  assert.doesNotMatch(value.routerText, /雨夜经过石桥/);
  assert.equal(h.calls.sourceReader, 0); assert.equal(h.calls.model, 0);
});

test('participant names resolve from the loaded core while the people panel remains unprepared', async () => {
  const h = fixture({ peoplePrepared: false });
  Object.assign(h.reachable.entities[0], { displayName: '林岚', specialRole: 'user' });
  Object.assign(h.reachable.entities[1], { displayName: '周宁', specialRole: 'char' });
  assert.deepEqual(h.bridge.getPeopleSnapshot().people.items, []);
  const value = await h.bridge.readContext({ query: '灯塔钥匙', participantNames: ['林岚', '周宁'], maxSummaries: 20, summaryCharacters: 8000 });
  assert.deepEqual(value.selectedEntityIds, [personA, personB]);
  assert.deepEqual(value.actors.map(actor => actor.displayName), ['林岚', '周宁']);
  assert.match(value.actors[0].stateText, /甲的私密状态/);
  assert.doesNotMatch(value.actors[1].stateText, /甲的私密状态/);
  assert.equal(h.calls.currentState, 1); assert.equal(h.calls.sourceReader, 0); assert.equal(h.calls.model, 0);
});

test('a small recent-summary fallback shares the same budget and resolves current people without another read', async () => {
  const h = fixture({ peoplePrepared: false });
  Object.assign(h.reachable.entities[0], { displayName: '林岚', specialRole: 'user' });
  Object.assign(h.reachable.entities[1], { displayName: '周宁', specialRole: 'none' });
  h.reachable.floorMemories[0].summary.userText = '林岚已告知生日日期。';
  h.reachable.floorMemories[2].summary.userText = '林岚和周宁已经在码头交谈，约定周末见面。';
  const value = await h.bridge.readContext({ query: '生日', focusQuery: '生日', participantNames: ['林岚', '学校'], maxSummaries: 2, recentSummaries: 1, summaryCharacters: 8000 });
  assert.match(value.routerText, /已告知生日日期/);
  assert.match(value.routerText, /已经在码头交谈/);
  assert.equal((value.routerText.match(/人工摘要（/g) || []).length, 2);
  assert.deepEqual(value.selectedEntityIds, [personA, personB]);
  assert.equal(h.calls.currentState, 1); assert.equal(h.calls.sourceReader, 0); assert.equal(h.calls.model, 0);
});

function delayedFoundation({ loadStatus = 'ready', fail = false, inspectAvailable = true, wrongOwner = false } = {}) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = { inspect: [], reads: 0, forbidden: 0, actors: 0 };
  let enabled = true;
  let owner = { ...identity, chatId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
  const context = { chatId: owner.hostChatId, characterId: 0, characters: [{ avatar: owner.characterLocator }], userAvatar: owner.personaLocator,
    chatMetadata: { qianqianjie: { schemaVersion: 2, chatId: owner.chatId } }, chat: [] };
  const source = fixture().reachable;
  const reachable = { ...source, root: { ...source.root, chatId: wrongOwner ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : owner.chatId },
    floors: [], floorMemories: [], entities: [], stateDeltas: [], currentStates: [], indexes: [] };
  const forbidden = () => { calls.forbidden++; throw Error('readContext must not prepare, generate or write'); };
  const store = { readReachable: async () => { calls.reads++; await gate; if (fail) throw Error('synthetic read failure'); return loadStatus === 'ready' ? reachable : { status: loadStatus }; },
    readRecord: forbidden, putRecord: forbidden, replaceRecord: forbidden, settleRun: forbidden, commitRoot: forbidden, invalidate: forbidden, recordKey: forbidden };
  const runtime = createFoundationRuntime({ store, contextProvider: () => context,
    hostAdapter: { snapshot: () => ({ chatId: context.chatId, chat: [], context }) }, fetchImpl: forbidden, logger: { warn() {} } });
  const foundation = { ...runtime, inspect: inspectAvailable ? (reason, options) => { calls.inspect.push({ reason, options }); return runtime.inspect(reason, options); } : undefined };
  const bridge = createPublicMemoryBridge({ session: { getState: () => ({ status: 'ready', identity: owner }), identity: () => owner, prepare: forbidden },
    store, hostAdapter: { snapshot: forbidden }, foundationRuntime: foundation, isEnabled: () => enabled,
    memoryRuntime: { getCurrentSubjectStates: () => { calls.actors++; return { status: 'ready', subjects: [] }; } } });
  return { bridge, foundation, calls, release, setOwner: value => { owner = { ...owner, ...value }; }, disable: () => { enabled = false; } };
}

test('readContext waits for the existing cold inspect after session status is already ready', async () => {
  const h = delayedFoundation();
  const loading = h.foundation.inspect('memoryRefresh', { allowCached: false });
  assert.equal(h.bridge.getStatus().status, 'ready');
  let settled = false;
  const pending = h.bridge.readContext({ query: '灯塔' }).then(value => { settled = true; return value; });
  await Promise.resolve(); await Promise.resolve();
  const wasPending = !settled;
  h.release(); await loading; const result = await pending;
  assert.equal(wasPending, true, 'the first caller must join the pending stored-data inspection');
  assert.equal(result.status, 'ready'); assert.equal(h.calls.reads, 1);
  assert.equal(h.calls.inspect.length, 2); assert.equal(h.calls.inspect[1].options.allowCached, true);
  assert.equal(h.calls.forbidden, 0);
});

test('concurrent cold readContext calls reuse the real foundation inspection queue', async () => {
  const h = delayedFoundation();
  const requests = [h.bridge.readContext({ query: '甲' }), h.bridge.readContext({ query: '乙' })];
  await Promise.resolve(); await Promise.resolve(); h.release();
  const results = await Promise.all(requests);
  assert.deepEqual(results.map(value => value.status), ['ready', 'ready']);
  assert.equal(h.calls.reads, 1, 'actual foundation.inspect coalesces both calls into one projection read');
  assert.equal(h.calls.inspect.length, 2); assert.ok(h.calls.inspect.every(call => call.options.allowCached === true));
  assert.equal(h.calls.forbidden, 0);
});

test('a complete snapshot keeps the original direct path without another inspect', async () => {
  const h = delayedFoundation(); h.release(); await h.foundation.inspect('seed'); h.calls.inspect.length = 0;
  const result = await h.bridge.readContext();
  assert.equal(result.status, 'ready'); assert.equal(h.calls.inspect.length, 0); assert.equal(h.calls.reads, 1); assert.equal(h.calls.forbidden, 0);
});

test('readContext preserves not-ready and real read failures without preparation or retries', async () => {
  for (const options of [{ loadStatus: 'uninitialized' }, { fail: true }, { inspectAvailable: false }]) {
    const h = delayedFoundation(options); const pending = h.bridge.readContext(); h.release();
    const result = await pending;
    assert.equal(result.status, options.fail ? 'error' : 'not-ready'); assert.equal(result.routerText, ''); assert.deepEqual(result.actors, []);
    assert.equal(h.calls.inspect.length, options.inspectAvailable === false ? 0 : 1); assert.equal(h.calls.forbidden, 0);
  }
});

test('readContext rechecks all session identity fields after awaiting a cold inspection', async () => {
  for (const change of [{ hostChatId: 'other-host' }, { chatId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, { characterLocator: 'other-card' }, { personaLocator: 'other-persona' }]) {
    const h = delayedFoundation(), pending = h.bridge.readContext();
    await Promise.resolve(); h.setOwner(change); h.release(); const result = await pending;
    assert.equal(result.status, 'stale'); assert.equal(result.routerText, ''); assert.deepEqual(result.actors, []);
    assert.equal(h.calls.actors, 0); assert.equal(h.calls.forbidden, 0);
  }
});

test('disabling during cold inspection does not continue into actor projections', async () => {
  const h = delayedFoundation(), pending = h.bridge.readContext();
  await Promise.resolve(); h.disable(); h.release(); const result = await pending;
  assert.equal(result.status, 'disabled'); assert.equal(result.routerText, ''); assert.deepEqual(result.actors, []);
  assert.equal(h.calls.actors, 0); assert.equal(h.calls.forbidden, 0);
});

test('a complete foundation snapshot must belong to the captured QQJ chat', async () => {
  const h = delayedFoundation({ wrongOwner: true }); h.release(); await h.foundation.inspect('seed');
  const result = await h.bridge.readContext();
  assert.equal(result.status, 'stale'); assert.equal(result.routerText, ''); assert.deepEqual(result.actors, []); assert.equal(h.calls.actors, 0);
});

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


test('新增稳定资料贯通公开档案与上下文，纯人类过滤仅限阅读界面', async () => {
  const fields = {
    bloodType: 'AB型', zodiac: '天秤座', weight: '61公斤', nationality: '架空北境国籍',
    birthplace: '临川', residence: '松风镇', languages: '通用语', skills: '钟表修理',
    mbti: 'INFJ', enneagram: '5w4', alignment: '中立善良', species: '人类',
  };
  const { bridge, calls } = fixture({ profileAFields: fields });
  const profile = bridge.getPeopleSnapshot().people.items.find(item => item.entityId === personA).profile;
  for (const [field, value] of Object.entries(fields)) assert.equal(profile[field], value, field);
  const context = await bridge.readContext({ entityIds: [personA], maxCharacters: 12000 });
  for (const [field, value] of Object.entries(fields)) assert.ok(context.actors[0].profileText.includes(`- ${field}：${value}`), field);
  assert.equal(calls.model, 0);
});
