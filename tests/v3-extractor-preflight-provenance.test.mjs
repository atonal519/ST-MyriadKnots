import test from 'node:test';
import assert from 'node:assert/strict';
import { createV3MemoryRuntime } from '../src/v3/memory-runtime.js';
import { createMigrationDescriptor } from '../src/v3/migration-prefix.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOURCE_CHAT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GENERATION = '22222222-2222-4222-8222-222222222222';
const uuid = value => `${String(value).padStart(8, '0')}-0000-4000-8000-000000000000`;
const assistantText = '中性离线探针：人物沿走廊走到窗边。';
const assistant = { is_user: false, is_system: false, mes: assistantText, swipes: [assistantText], swipe_id: 0 };
const user = { is_user: true, is_system: false, mes: '继续。' };
const fingerprint = char => `sha256:${char.repeat(64)}`;

function makeFixture(frozenCount) {
  const frozenIds = Array.from({ length: frozenCount }, (_, index) => uuid(index + 1));
  const liveId = uuid(frozenCount + 1);
  const floorIds = [...frozenIds, liveId];
  const floors = floorIds.map((id, index) => {
    const frozen = index < frozenCount;
    const canonicalContent = frozen ? `中性来源楼 ${index + 1}。` : assistantText;
    return {
      id, chatId: CHAT, narrativeGeneration: GENERATION, assistantSeq: index + 1,
      predecessorFloorId: index ? floorIds[index - 1] : null,
      hostLocator: { messageIndex: frozen ? index * 2 + 1 : 1, swipeId: 0, selectedSwipeIndex: 0 },
      content: { canonicalContent, rawFingerprint: fingerprint('a'), canonicalFingerprint: fingerprint('b'),
        sanitizerFingerprint: fingerprint('c'), formatVersion: 1 },
      stability: { status: 'stable', stabilizedAt: '2026-10-15T00:00:00.000Z', stabilizedBy: 'manual' },
      recordStatus: 'active',
    };
  });
  const sourceSignature = fingerprint('1'), refreshedSignature = fingerprint('9');
  let provenance = Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`unrelated-${index}`, {
    timeEdited: false, storyClockSignature: fingerprint(String(index % 10)),
  }]));
  const run = { id: uuid(900001), chatId: CHAT, recordStatus: 'active', diagnostics: { floorProvenance: provenance } };
  const memories = floors.map((floor, index) => ({ id: `memory-${index + 1}`, chatId: CHAT, floorId: floor.id,
    sourceFloorIds: [floor.id], recordStatus: 'active', extractorVersion: 'offline-probe',
    summary: { effectiveSource: 'ai', aiText: '离线中性摘要。', userText: null }, chronology: [], locations: [], participants: [],
    actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [],
    exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] }));
  const root = { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: uuid(800001), baselineId: null,
    sourceSnapshotFingerprint: fingerprint('d'), status: 'ready', rootRevision: 1,
    indexManifest: Object.fromEntries(['floor', 'entity', 'event', 'claim', 'knowledge', 'episode', 'thread', 'state', 'anchor', 'reverseRef'].map(key => [key, []])),
    activeStateRefs: [], activeThreadRefs: [], stableBoundary: { assistantSeq: floors.length, floorId: liveId,
      canonicalFingerprint: floors.at(-1).content.canonicalFingerprint } };
  const reachable = { status: 'ready', rootRevision: 1, root,
    checkpoint: { id: root.headCheckpointId, producedRefs: { floorMemories: memories.map(item => item.id), entities: [],
      stateDeltas: [], currentStates: [], indexes: [] } }, run, floors, floorMemories: memories, entities: [], stateDeltas: [],
    currentStates: [], baseline: null, migrationDescriptor: null };
  if (frozenCount) {
    const frozenReachable = { ...reachable, floors: floors.slice(0, frozenCount), floorMemories: memories.slice(0, frozenCount) };
    reachable.migrationDescriptor = createMigrationDescriptor({ id: uuid(700001), chatId: CHAT,
      source: { chatId: SOURCE_CHAT, hostChatId: 'offline-source', characterLocator: 'character.png', personaLocator: 'persona.png',
        narrativeGeneration: GENERATION, headCheckpointId: uuid(700002), sourceSnapshotFingerprint: fingerprint('e'), rootRevision: 1 },
      reachable: frozenReachable,
      recordRefs: { floors: frozenIds, floorMemories: memories.slice(0, frozenCount).map(item => item.id), entities: [], baselineId: null,
        stateDeltas: [], currentStateIds: [], indexKeys: [], timeBatchIds: [], vectorShardIds: [], peopleWorkspaceId: null, peopleSnapshotIds: [] },
      createdAt: '2026-10-15T00:00:00.000Z' });
    provenance[frozenIds[0]] = { timeEdited: false, storyClockSignature: sourceSignature };
  }
  const foundationState = { status: 'ready', foundationStatus: 'ready', pending: null, canInitialize: false,
    inspectedStableCount: floors.length, stableCount: 1, headCheckpointId: root.headCheckpointId, lastError: null };
  const foundationRuntime = { start() {}, refreshStatus: async () => foundationState, confirmLatest: async () => foundationState,
    setEnabled() {}, bind() {}, getState: () => foundationState, getReachable: () => reachable, inspect: async () => foundationState };
  const calls = { utility: 0, writes: 0 };
  const store = { async readReachable() { return reachable; }, async readRecord() { return null; },
    async putRecord() { calls.writes++; throw new Error('unexpected storage write'); },
    async commitRoot() { calls.writes++; throw new Error('unexpected root write'); }, recordKey: () => 'offline-probe-record', invalidate: async () => {} };
  const runtime = createV3MemoryRuntime({ foundationRuntime, store,
    hostAdapter: { snapshot: () => ({ context: { chatMetadata: { qianqianjie: { chatId: CHAT } } }, chat: [user, assistant], userIdentity: null }) },
    generateAnalysisTask: async () => { throw new Error('analysis route should not run'); },
    generateUtilityTask: async () => { calls.utility++; throw new DOMException('request boundary captured offline', 'AbortError'); },
    isEnabled: true, automationSettings: () => ({ enabled: false, batchSize: 1 }), storyClockReferenceTags: () => '' });
  return { runtime, reachable, liveId, frozenId: frozenIds[0] ?? null, sourceSignature, refreshedSignature, calls, get provenance() { return provenance; },
    replaceProvenance(value) { provenance = value; run.diagnostics.floorProvenance = value; } };
}

function observeDependencyProvenanceClones(fixture) {
  const original = globalThis.structuredClone;
  const reachableGraphs = new WeakSet([fixture.reachable]);
  const provenanceMaps = new WeakSet([fixture.provenance]);
  const counts = [0, 0];
  const clonedFrozenSignatures = [[], []];
  let phase = 0;
  globalThis.structuredClone = (value, options) => {
    const dependencySnapshotCall = provenanceMaps.has(value) && new Error().stack?.includes('extractorDependencySnapshot');
    if (dependencySnapshotCall) counts[phase] += 1;
    const cloned = original(value, options);
    if (dependencySnapshotCall && fixture.frozenId) clonedFrozenSignatures[phase].push(cloned[fixture.frozenId]?.storyClockSignature ?? null);
    if (reachableGraphs.has(value)) {
      reachableGraphs.add(cloned);
      if (cloned?.run?.diagnostics?.floorProvenance) provenanceMaps.add(cloned.run.diagnostics.floorProvenance);
    }
    return cloned;
  };
  return { counts, clonedFrozenSignatures, restore() { globalThis.structuredClone = original; }, nextCall() { phase = 1; } };
}

test('extractor dependency preparation builds frozen provenance once per call and fresh on the next call', async () => {
  const fixture = makeFixture(3);
  assert.deepEqual(fixture.reachable.migrationDescriptor.sourceFloorProvenance, []);
  assert.deepEqual(fixture.reachable.migrationDescriptor.summarySources, []);
  const observer = observeDependencyProvenanceClones(fixture);
  try {
    await fixture.runtime.start();
    await fixture.runtime.extractFloor(fixture.liveId, { analyzeState: false });
    assert.equal(fixture.calls.utility, 1);
    assert.equal(observer.counts[0], 1);
    assert.deepEqual(observer.clonedFrozenSignatures[0], [fixture.sourceSignature]);

    const refreshed = { ...fixture.provenance, [fixture.frozenId]: { timeEdited: false, storyClockSignature: fixture.refreshedSignature } };
    fixture.replaceProvenance(refreshed);
    observer.nextCall();
    await fixture.runtime.extractFloor(fixture.liveId, { analyzeState: false });
    assert.equal(fixture.calls.utility, 2);
    assert.equal(observer.counts[1], 1);
    assert.deepEqual(observer.clonedFrozenSignatures[1], [fixture.refreshedSignature]);
    assert.equal(fixture.calls.writes, 0);
  } finally { observer.restore(); }
});

test('ordinary extraction with no frozen prefix never builds frozen provenance', async () => {
  const fixture = makeFixture(0);
  const observer = observeDependencyProvenanceClones(fixture);
  try {
    await fixture.runtime.start();
    await fixture.runtime.extractFloor(fixture.liveId, { analyzeState: false });
    assert.equal(fixture.calls.utility, 1);
    assert.equal(observer.counts[0], 0);
    assert.equal(fixture.calls.writes, 0);
  } finally { observer.restore(); }
});
