import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTransferGraph } from '../src/memory-transfer-graph.js';
import { createFoundationStore } from '../src/v3/foundation-store.js';
import { createFoundationRuntime } from '../src/v3/foundation-runtime.js';
import { createV3MemoryRuntime } from '../src/v3/memory-runtime.js';
import { createHostAdapter } from '../src/v3/host-adapter.js';
import { EXTRACTOR_SYSTEM_PROMPT } from '../src/v3/extractor.js';
import { createMigrationDescriptor, partitionScannedCandidates } from '../src/v3/migration-prefix.js';
import { matchFloorCandidates } from '../src/v3/floor-binding.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = '2026-09-05T00:00:00.000Z';
const uuidFactory = () => { let id = 2000; return () => `${(++id).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`; };
async function fixture({ body = '钥匙放在木盒里。' } = {}) {
  const records = new Map(), revisions = new Map();
  const client = {
    async get(_collection, id) {
      if (!records.has(id)) throw Object.assign(new Error('missing'), { status: 404 });
      return { data: structuredClone(records.get(id)), revision: revisions.get(id) };
    },
    async put(_collection, id, data, expectedRevision) {
      const previous = revisions.get(id) ?? 0;
      if (previous !== expectedRevision) throw Object.assign(new Error('conflict'), { status: 409 });
      const revision = previous + 1; records.set(id, structuredClone(data)); revisions.set(id, revision);
      return { data: structuredClone(data), revision };
    },
  };
  const context = {
    name1: '访客', name2: '守门人', characterId: 0, groupId: null, chatId: 'graph-test', userAvatar: 'user.png',
    characters: [{ name: '守门人', avatar: 'character.png', data: { description: '守门人' } }],
    powerUserSettings: { persona_description: '访客' }, chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT } },
    chat: [{ is_user: true, mes: '开始', send_date: '2026-09-05' }, { is_user: false, mes: body, swipes: [body], swipe_id: 0 }, { is_user: true, mes: '继续', send_date: '2026-09-05T00:01:00' }],
    eventSource: { on() {} }, eventTypes: {}, async saveMetadata() {}, async saveChat() { return true; },
    getRequestHeaders() { return {}; }, getWorldInfoNames() { return []; }, async loadWorldInfoBatch() { return new Map(); },
  };
  const host = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => context } } });
  const store = createFoundationStore({ client, contextProvider: () => ({ chatId: CHAT }) });
  const foundation = createFoundationRuntime({ hostAdapter: host, store, contextProvider: () => context, newUuid: uuidFactory(), logger: { warn() {} } });
  await foundation.start();
  const memory = createV3MemoryRuntime({ foundationRuntime: foundation, store, hostAdapter: host,
    automationSettings: () => ({ enabled: false, batchSize: 1 }), newUuid: uuidFactory(), logger: { warn() {} },
    generateAnalysisTask: async () => ({ jsonData: { noMaterialChange: true } }),
    generateUtilityTask: async options => ({ jsonData: options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT ? { summary: '钥匙在木盒。' } : { noMaterialChange: true } }) });
  await memory.start(); await memory.extractFloor(memory.getState().floors[0].floorId, { analyzeState: false }); await memory.analyzeNextState();
  const graph = await store.readReachable({ mode: 'full' });
  assert.ok(graph.stateDeltas.length, JSON.stringify(memory.getState().lastCseError ?? memory.getState().cseFloors));
  const root = graph.root, checkpoint = graph.checkpoint;
  const ids = new Set(['v3-root', `v3-checkpoint-${checkpoint.id}`, `v3-run-${checkpoint.runId}`, ...(root.baselineId ? [`v3-baseline-${root.baselineId}`] : [])]);
  for (const [kind, prefix] of [['floors', 'v3-floor-'], ['floorMemories', 'v3-floor-memory-'], ['entities', 'v3-entity-'], ['stateDeltas', 'v3-state-delta-'], ['currentStates', 'v3-current-state-']]) for (const id of checkpoint.producedRefs[kind]) ids.add(`${prefix}${id}`);
  for (const id of checkpoint.producedRefs.indexes) ids.add(id);
  const run = (options = {}) => validateTransferGraph({ chatId: CHAT, recordIds: [...ids], readRecord: async id => structuredClone(records.get(id)), ...options });
  return { graph, records, ids, store, run };
}

test('stream graph validation uses real records and returns only compact floor binding metadata', async () => {
  const f = await fixture(), result = await f.run();
  assert.equal(result.root.headCheckpointId, f.graph.root.headCheckpointId);
  assert.equal(result.summaryCount, 1); assert.equal(result.stateCount, 1);
  assert.deepEqual(result.floors.map(floor => floor.id), f.graph.floors.map(floor => floor.id));
  assert.equal(Object.hasOwn(result.floors[0].content, 'canonicalContent'), false);
  assert.equal(Object.hasOwn(result, 'floorMemories'), false);
  assert.equal(Object.hasOwn(result, 'stateDeltas'), false);
});

test('stream graph batches each original record group while retaining single reads and the same validation result', async () => {
  const f = await fixture(), expected = await f.run(), groups = [], singles = [];
  const actual = await f.run({
    readRecord: async id => { singles.push(id); return structuredClone(f.records.get(id)); },
    async *readRecords(ids) {
      groups.push([...ids]);
      for (const id of ids) yield structuredClone(f.records.get(id));
    },
  });
  assert.deepEqual(actual, expected);
  const refs = f.graph.checkpoint.producedRefs;
  assert.deepEqual(groups.filter(ids => ids.length), [refs.indexes, refs.floors.map(id => `v3-floor-${id}`),
    refs.entities.map(id => `v3-entity-${id}`), refs.floorMemories.map(id => `v3-floor-memory-${id}`),
    refs.stateDeltas.map(id => `v3-state-delta-${id}`), refs.currentStates.map(id => `v3-current-state-${id}`)].filter(ids => ids.length));
  assert.deepEqual(singles.slice(0, 3), ['v3-root', `v3-checkpoint-${f.graph.checkpoint.id}`, `v3-run-${f.graph.run.id}`]);
  assert.ok(!singles.some(id => refs.indexes.includes(id)));
  assert.ok(singles.includes(`v3-baseline-${f.graph.root.baselineId}`));
});

test('stream graph batch failures preserve transport errors and close the source on original validation failures', async t => {
  await t.test('transport', async () => {
    const f = await fixture(), failure = Object.assign(new Error('HTTP 503'), { status: 503 }); let called = false;
    await assert.rejects(f.run({ async *readRecords() { called = true; throw failure; } }), error => error === failure);
    assert.equal(called, true);
  });
  for (const kind of ['body', 'evidence', 'currentFingerprint', 'missingFloor']) await t.test(kind, async () => {
    const f = await fixture(), floorId = `v3-floor-${f.graph.floors[0].id}`;
    if (kind === 'body') f.records.get(floorId).content.canonicalContent = '替换的正文';
    if (kind === 'evidence') f.records.get(`v3-floor-memory-${f.graph.floorMemories[0].id}`).summaryEvidenceRefs = [
      { floorId: f.graph.floors[0].id, anchorId: null, quotedText: '不在原文', occurrence: 1, evidenceMode: 'explicit', supports: 'summary', sourceEntityId: null },
    ];
    if (kind === 'currentFingerprint') f.records.get(`v3-current-state-${f.graph.currentStates[0].id}`).fingerprint = `sha256:${'0'.repeat(64)}`;
    if (kind === 'missingFloor') f.ids.delete(floorId);
    const legacy = await f.run().then(() => assert.fail('invalid fixture must fail'), error => error);
    let opened = 0, closed = 0;
    await assert.rejects(f.run({ async *readRecords(ids) {
      opened++;
      try { for (const id of ids) yield structuredClone(f.records.get(id)); }
      finally { closed++; }
    } }), error => error.code === legacy.code);
    assert.ok(opened > 0); assert.equal(closed, opened);
  });
});

test('stream graph rejects incomplete, extra and reordered batch records', async t => {
  for (const kind of ['short', 'extra', 'order']) await t.test(kind, async () => {
    const f = await fixture(); let changed = false;
    await assert.rejects(f.run({ async *readRecords(ids) {
      const values = ids.map(id => structuredClone(f.records.get(id)));
      if (!changed && ids.length > 1) {
        changed = true;
        if (kind === 'short') values.pop();
        if (kind === 'extra') values.push(values[0]);
        if (kind === 'order') [values[0], values[1]] = [values[1], values[0]];
      }
      yield* values;
    } }), error => error.code === (kind === 'short' ? 'V3_TRANSFER_RECORD_TYPE_INVALID' : 'V3_TRANSFER_RECORD_KEY_INVALID'));
    assert.equal(changed, true);
  });
});

test('stream graph batch validation retains single large records and random evidence source reads', async () => {
  const f = await fixture({ body: `钥匙放在木盒里。${'甲'.repeat(400000)}` });
  const memory = f.records.get(`v3-floor-memory-${f.graph.floorMemories[0].id}`), floorId = f.graph.floors[0].id;
  delete memory.sourceCanonicalContent; delete memory.sourceFloorSnapshots;
  memory.summaryEvidenceRefs = [{ floorId, anchorId: null, quotedText: '钥匙放在木盒里', occurrence: 1,
    evidenceMode: 'explicit', supports: 'summary', sourceEntityId: null }];
  const expected = await f.run(), singles = [];
  const actual = await f.run({
    readRecord: async id => { singles.push(id); return structuredClone(f.records.get(id)); },
    async *readRecords(ids) { for (const id of ids) yield structuredClone(f.records.get(id)); },
  });
  assert.deepEqual(actual, expected);
  assert.equal(singles.filter(id => id === `v3-floor-${floorId}`).length, 1, 'evidence lookup still uses the original on-demand floor read');
  assert.equal(Object.hasOwn(actual.floors[0].content, 'canonicalContent'), false);
});

test('stream graph validation rejects missing records, changed original content and invalid references', async t => {
  for (const change of ['missingFloor', 'body', 'boundary', 'evidence', 'anchor', 'currentFingerprint', 'deltaEntity']) await t.test(change, async () => {
    const f = await fixture();
    const floor = f.records.get(`v3-floor-${f.graph.floors[0].id}`);
    const memory = f.records.get(`v3-floor-memory-${f.graph.floorMemories[0].id}`);
    if (change === 'missingFloor') f.ids.delete(`v3-floor-${floor.id}`);
    if (change === 'body') floor.content.canonicalContent = '被替换的原文';
    if (change === 'boundary') f.records.get('v3-root').stableBoundary.assistantSeq += 1;
    if (change === 'evidence') memory.summaryEvidenceRefs = [{ floorId: floor.id, anchorId: null, quotedText: '不存在的引文', occurrence: 1, evidenceMode: 'explicit', supports: 'summary', sourceEntityId: null }];
    if (change === 'anchor') memory.exactAnchors = [{ anchorId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', kind: 'wording', speakerEntityId: null, exactText: '不存在的锚点', occurrence: 1, whyPreserve: '测试原文核对' }];
    if (change === 'currentFingerprint') f.records.get(`v3-current-state-${f.graph.currentStates[0].id}`).fingerprint = `sha256:${'0'.repeat(64)}`;
    if (change === 'deltaEntity') {
      const delta = f.records.get(`v3-state-delta-${f.graph.stateDeltas[0].id}`);
      delta.subjectSnapshots = [{ subjectEntityId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', core: [], adaptive: [], situational: [], changeSummary: [], coreChallenges: [] }];
    }
    const codes = { body: 'V3_GRAPH_FLOOR_CANONICAL_FINGERPRINT_INVALID', evidence: 'V3_MEMORY_GRAPH_EVIDENCE_INVALID',
      anchor: 'V3_MEMORY_GRAPH_ANCHOR_INVALID', currentFingerprint: 'V3_CSE_GRAPH_CURRENT_FINGERPRINT_INVALID', deltaEntity: 'V3_CSE_GRAPH_ENTITY_REF_INVALID' };
    await assert.rejects(f.run(), error => !codes[change] || error.code === codes[change]);
  });
});

test('stream graph validates saved assistant and preceding-user quotes and preserves manual anchors', async () => {
  const f = await fixture(), floor = f.graph.floors[0];
  const memory = f.records.get(`v3-floor-memory-${f.graph.floorMemories[0].id}`);
  memory.sourceCanonicalContent = '这是已保存的历史原文。';
  memory.sourceUserInputSnapshot = { messages: [{ content: '访客确认钥匙在木盒', messageIndex: 0, swipeId: null, selectedSwipeIndex: null }] };
  memory.summaryEvidenceRefs = [
    { floorId: floor.id, anchorId: null, quotedText: '历史原文', occurrence: 1, evidenceMode: 'explicit', supports: 'summary', sourceEntityId: null },
    { floorId: floor.id, anchorId: null, quotedText: '钥匙在木盒', occurrence: 1, evidenceMode: 'explicit', supports: 'summary', sourceEntityId: null, sourceType: 'precedingUser', sourceSnapshotIndex: 0 },
  ];
  memory.exactAnchors = [
    { anchorId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', kind: 'wording', exactText: '历史原文', occurrence: 1, speakerEntityId: null, whyPreserve: '保留已保存来源' },
    { anchorId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', kind: 'other', exactText: '用户自行补充的内容', occurrence: 1, speakerEntityId: null, whyPreserve: '用户手填', manual: true, carrier: '手填记录', knownEntityIds: [] },
  ];
  assert.equal((await f.store.readReachable({ mode: 'full' })).status, 'ready');
  assert.equal((await f.run()).summaryCount, 1);
  memory.summaryEvidenceRefs[1].occurrence = 2;
  await assert.rejects(f.run(), error => error.code === 'V3_MEMORY_GRAPH_EVIDENCE_INVALID');
});

test('stream graph retains frozen bindings while releasing historical prequel text', async () => {
  const f = await fixture();
  const descriptor = createMigrationDescriptor({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', chatId: CHAT,
    source: { chatId: CHAT, hostChatId: 'graph-test', characterLocator: 'character.png', personaLocator: 'user.png' },
    reachable: f.graph, sourcePrequelSnapshots: ['历史前情'.repeat(10000)], createdAt: NOW });
  const key = `v3-migration-${descriptor.id}`;
  f.records.set(key, descriptor); f.ids.add(key); f.records.get('v3-root').migrationDescriptorId = descriptor.id;
  const result = await f.run();
  assert.deepEqual(result.migrationDescriptor.frozenFloorIds, f.graph.floors.map(floor => floor.id));
  assert.equal(Object.hasOwn(result.migrationDescriptor, 'sourcePrequelSnapshots'), false);
  const candidates = partitionScannedCandidates(result, [], CHAT, []).all;
  assert.equal(matchFloorCandidates(result.floors, candidates).floorMatches.size, result.floors.length);
});

test('stream graph still validates core records outside the active checkpoint', async () => {
  const f = await fixture(), original = f.graph.floorMemories[0];
  const memory = { ...structuredClone(original), id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' };
  const key = `v3-floor-memory-${memory.id}`; f.records.set(key, memory); f.ids.add(key);
  assert.equal((await f.run()).summaryCount, 1);
  memory.summaryEvidenceRefs = null;
  await assert.rejects(f.run());
});

test('stream graph validates entity references in qianshi event people', async () => {
  const f = await fixture(), floor = f.graph.floors[0];
  const memory = f.records.get(`v3-floor-memory-${f.graph.floorMemories[0].id}`);
  const personId = f.graph.entities.find(entity => entity.entityType === 'person').id;
  memory.qianshiDelta = { schemaVersion: 1, status: 'ready', reason: null, compiledAt: NOW,
    candidateStats: { count: 1, characters: 20 }, relations: [],
    events: [{ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', matterId: null, updatesMatter: false,
      title: '归还钥匙', description: '守门人归还钥匙。', status: 'occurred', storyTime: null, scheduledTime: null,
      people: [{ entityId: personId, name: '守门人' }], object: '钥匙', sourceFloorId: floor.id, continuesFromEventIds: [] }] };
  assert.equal((await f.run()).summaryCount, 1);
  memory.qianshiDelta.events[0].people[0].entityId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  await assert.rejects(f.run(), error => error.code === 'V3_MEMORY_GRAPH_ENTITY_REF_INVALID');
});

test('stream graph validation preserves projected entity bounds and legacy source snapshot readers', async () => {
  const f = await fixture();
  for (const entityId of f.graph.checkpoint.producedRefs.entities) {
    const entity = f.records.get(`v3-entity-${entityId}`);
    entity.firstSeenFloorId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'; entity.lastSeenFloorId = entity.firstSeenFloorId;
  }
  f.records.get('v3-root').sourceSnapshotFingerprint = null;
  f.records.get(`v3-checkpoint-${f.graph.checkpoint.id}`).sourceSnapshotFingerprint = null;
  f.records.get(`v3-run-${f.graph.run.id}`).inputSnapshotFingerprint = null;
  const expected = await f.store.readReachable({ mode: 'full' }), actual = await f.run();
  assert.deepEqual(actual.floors.map(floor => floor.id), expected.floors.map(floor => floor.id));
});
