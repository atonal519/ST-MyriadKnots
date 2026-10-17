import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createV3MemoryRuntime } from '../src/v3/memory-runtime.js';
import { scanAssistantCandidates } from '../src/v3/foundation-domain.js';
import { createMigrationDescriptor } from '../src/v3/migration-prefix.js';

const CHAT_ID = 'a1111111-1111-4111-8111-111111111111';
const GENERATION = 'b2222222-2222-4222-8222-222222222222';
const CHECKPOINT = 'c3333333-3333-4333-8333-333333333333';
const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const emptyArrays = {
  chronology: [], locations: [], participants: [], actions: [], observations: [],
  informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [],
  exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [],
};

async function fixture(size, { migrated = false } = {}) {
  const chat = [];
  for (let seq = 1; seq <= size; seq += 1) {
    chat.push({ is_user: true, is_system: false, mes: `继续核对第${seq}份记录。` });
    chat.push({ is_user: false, is_system: false, mes: `林岚整理了第${seq}份普通记录。` });
    chat.push({ is_user: true, is_system: false, mes: `收到第${seq}份记录。` });
  }
  const candidates = await scanAssistantCandidates(chat, { chatId: CHAT_ID });
  assert.equal(candidates.length, size, 'fixture must contain the requested number of stable assistant floors');
  const floors = candidates.map((candidate, index) => ({
    id: `d${String(index + 1).padStart(7, '0')}-0000-4000-8000-000000000000`,
    assistantSeq: index + 1,
    hostLocator: candidate.hostLocator,
    content: {
      rawFingerprint: candidate.rawFingerprint,
      canonicalFingerprint: candidate.canonicalFingerprint,
      canonicalContent: candidate.canonicalContent,
    },
  }));
  const floorMemories = floors.map((floor, index) => ({
    id: `e${String(index + 1).padStart(7, '0')}-0000-4000-8000-000000000000`,
    floorId: floor.id,
    recordStatus: 'active',
    summary: { effectiveSource: 'ai', aiText: `第${index + 1}楼：林岚整理普通记录。` },
    ...structuredClone(emptyArrays),
  }));
  const reachable = {
    status: 'ready',
    rootRevision: 1,
    root: { chatId: CHAT_ID, narrativeGeneration: GENERATION, headCheckpointId: CHECKPOINT, sourceSnapshotFingerprint: digest(`source-${size}`) },
    checkpoint: { id: CHECKPOINT },
    baseline: null,
    floors,
    floorMemories,
    entities: [],
    stateDeltas: [],
    currentStates: [],
    run: null,
  };
  if (migrated) {
    const sourceChatId = 'f4444444-4444-4444-8444-444444444444';
    reachable.migrationDescriptor = createMigrationDescriptor({
      id: 'a5555555-5555-4555-8555-555555555555', chatId: CHAT_ID,
      source: { chatId: sourceChatId, hostChatId: 'source-host-chat', characterLocator: 'character.png', personaLocator: 'persona.png' },
      reachable,
      summarySources: [{ targetFloorId: floors[1].id, sourceFloorId: floors[0].id, sourceChatId,
        rawFingerprint: floors[0].content.rawFingerprint }],
      recordRefs: { floors: floors.map(floor => floor.id), floorMemories: floorMemories.map(memory => memory.id),
        entities: [], baselineId: null, stateDeltas: [], currentStateIds: [], indexKeys: [], timeBatchIds: [],
        vectorShardIds: [], peopleWorkspaceId: null, peopleSnapshotIds: [] },
      createdAt: '2026-10-17T00:00:00.000Z',
    });
  }
  const context = {
    chatId: `host-chat-${size}`,
    chatMetadata: { qianqianjie: { chatId: CHAT_ID } },
    chat,
    constants: { promptTypes: { IN_CHAT: 1 }, promptRoles: { SYSTEM: 0 } },
  };
  let foundationStateReads = 0;
  let inspectCalls = 0;
  const foundationRuntime = {
    async start() { return this.getState(); },
    async inspect() { inspectCalls += 1; return this.getState(); },
    async refreshStatus() { inspectCalls += 1; return this.getState(); },
    async confirmLatest() { return this.getState(); },
    async setEnabled() { return this.getState(); },
    bind() {},
    getState() {
      foundationStateReads += 1;
      return { status: 'ready', foundationStatus: 'ready', chatId: CHAT_ID, inspectedStableCount: size };
    },
    getReachable() { return reachable; },
  };
  const calls = { readReachable: 0, readRecord: 0, putRecord: 0, commitRoot: 0, invalidate: 0, network: 0, hostSnapshot: 0 };
  const store = {
    async readReachable() { calls.readReachable += 1; return reachable; },
    async readRecord() { calls.readRecord += 1; return { status: 'missing' }; },
    async putRecord() { calls.putRecord += 1; throw new Error('unexpected write during getState probe'); },
    async commitRoot() { calls.commitRoot += 1; throw new Error('unexpected commit during getState probe'); },
    recordKey: (_collection, id) => id,
    invalidate() { calls.invalidate += 1; },
  };
  const hostAdapter = { snapshot() { calls.hostSnapshot += 1; return { context, chat, chatId: context.chatId }; } };
  const runtime = createV3MemoryRuntime({
    foundationRuntime,
    store,
    hostAdapter,
    generateAnalysisTask: async () => { throw new Error('unexpected model call'); },
    generateUtilityTask: async () => { throw new Error('unexpected model call'); },
    isEnabled: () => true,
    automationSettings: () => ({ enabled: false, batchSize: 1 }),
    persistAnchors: null,
    now: () => new Date('2026-10-17T00:00:00.000Z'),
    logger: { warn() {} },
  });

  return { runtime, reachable, calls, getFoundationCounts: () => ({ foundationStateReads, inspectCalls }) };
}

function stateShape(state) { return JSON.parse(JSON.stringify(state)); }

async function once(size, instrument) {
  const h = await fixture(size);
  const started = await h.runtime.start();
  assert.equal(started.memorySnapshotStatus, 'ready');
  assert.equal(started.memorySyncStatus, 'idle');
  assert.equal(started.stableCount, size);
  assert.equal(started.floors.length, size);

  let iteratorCalls = 0;
  let yieldedElements = 0;
  if (instrument) {
    const floors = h.reachable.floors;
    const nativeIterator = Array.prototype[Symbol.iterator];
    Object.defineProperty(floors, Symbol.iterator, {
      configurable: true,
      value: function* countedFloorIterator() {
        iteratorCalls += 1;
        const iterator = nativeIterator.call(this);
        while (true) {
          const item = iterator.next();
          if (item.done) return;
          yieldedElements += 1;
          yield item.value;
        }
      },
    });
  }

  const beforeStore = { ...h.calls };
  const beforeFoundation = h.getFoundationCounts();
  const state = h.runtime.getState();
  const afterStore = { ...h.calls };
  const afterFoundation = h.getFoundationCounts();
  assert.equal(state.memorySnapshotStatus, 'ready');
  assert.equal(state.memorySyncStatus, 'idle');
  assert.equal(state.floors.length, size);
  return {
    shape: stateShape(state),
    iteratorCalls,
    yieldedElements,
    storeCallDelta: Object.fromEntries(Object.keys(beforeStore).map(key => [key, afterStore[key] - beforeStore[key]])),
    foundationCallDelta: Object.fromEntries(Object.keys(beforeFoundation).map(key => [key, afterFoundation[key] - beforeFoundation[key]])),
    outputFloorCount: state.floors.length,
    memoryStatus: state.memorySnapshotStatus,
    syncStatus: state.memorySyncStatus,
  };
}

test('actual memory runtime getState ordinary unmerged floors: compare one measured call at 8 and 16 floors', async () => {
  const results = [];
  for (const size of [8, 16]) {
    const uninstrumented = await once(size, false);
    const measured = await once(size, true);
    assert.deepEqual(measured.shape, uninstrumented.shape, `${size} floors: read-only instrumentation preserves the full serialized getState output`);
    assert.equal(measured.iteratorCalls, 1, `${size} floors: getState builds one local migration partition`);
    assert.equal(measured.yieldedElements, size, `${size} floors: the local partition copies each floor once`);
    assert.deepEqual(measured.storeCallDelta, { readReachable: 0, readRecord: 0, putRecord: 0, commitRoot: 0, invalidate: 0, network: 0, hostSnapshot: 0 });
    assert.deepEqual(measured.foundationCallDelta, { foundationStateReads: 1, inspectCalls: 0 });
    results.push({ floors: size, outputMatchesUninstrumented: true, iteratorCalls: measured.iteratorCalls,
      yieldedElements: measured.yieldedElements, storeCallDelta: measured.storeCallDelta,
      foundationCallDelta: measured.foundationCallDelta, outputFloorCount: measured.outputFloorCount,
      memoryStatus: measured.memoryStatus, syncStatus: measured.syncStatus });
  }
  console.log(`MEMORY_STATE_COUNT_RESULT ${JSON.stringify(results)}`);
});

test('actual memory runtime getState preserves migrated source origin and inherited summary metadata', async () => {
  const h = await fixture(2, { migrated: true });
  await h.runtime.start();
  const state = h.runtime.getState();
  const [source, inherited] = state.floors;
  assert.equal(source.frozen, true);
  assert.deepEqual(source.sourceOrigin, h.reachable.migrationDescriptor.floorOrigins[0]);
  assert.equal(inherited.frozen, true);
  assert.equal(inherited.inherited, true);
});

test('轻量activity快照不投影记忆楼层或调用存储', async () => {
  const h = await fixture(16);
  await h.runtime.start();
  const floors = h.reachable.floors, nativeIterator = Array.prototype[Symbol.iterator];
  let visited = 0;
  Object.defineProperty(floors, Symbol.iterator, { configurable: true, value: function* countedFloorIterator() {
    const iterator = nativeIterator.call(this);
    while (true) { const item = iterator.next(); if (item.done) return; visited += 1; yield item.value; }
  } });
  const storeBefore = { ...h.calls }, foundationBefore = h.getFoundationCounts();
  const state = h.runtime.getActivityState();
  assert.equal(state.status, 'ready'); assert.equal(state.stableCount, 16); assert.equal(state.memoryWorkBusy, false);
  assert.equal(state.activeExtraction, null); assert.equal(state.qianshiHistoryActive, false);
  assert.equal(Object.hasOwn(state, 'floors'), false); assert.equal(Object.hasOwn(state, 'cseSubjects'), false);
  assert.equal(visited, 16, 'activity projection partitions the loaded floor IDs once');
  const storeDelta = Object.fromEntries(Object.keys(storeBefore).map(key => [key, h.calls[key] - storeBefore[key]]));
  assert.deepEqual(storeDelta, { readReachable: 0, readRecord: 0, putRecord: 0, commitRoot: 0, invalidate: 0, network: 0, hostSnapshot: 0 });
  assert.deepEqual({ foundationStateReads: h.getFoundationCounts().foundationStateReads - foundationBefore.foundationStateReads,
    inspectCalls: h.getFoundationCounts().inspectCalls - foundationBefore.inspectCalls }, { foundationStateReads: 1, inspectCalls: 0 });
});
