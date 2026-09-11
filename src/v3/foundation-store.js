import { isUuid } from '../identity.js';
import {
  validateFoundationCheckpoint,
  validateFoundationFloor,
  validateFoundationFloorContent,
  validateFoundationIndex,
  validateFoundationGraph,
  validateFoundationRoot,
  validateFoundationRun,
  sameFoundationRecordContent,
} from './foundation-schema.js';
import { reverseRefShardPrefix } from './foundation-domain.js';
import { projectEntityFloorBounds, validateEntityRecord, validateFloorMemory, validateMemoryGraph } from './memory-schema.js';
import { validateBaselineRecord, validateCurrentStateRecord, validateCseGraph, validateStateDeltaRecord } from './cse-schema.js';

export const V3_ROOT_RECORD_ID = 'v3-root';
export const V3_READ_MODES = Object.freeze({ full: 'full', runtime: 'runtime', projection: 'projection' });
const RECORD_PREFIX = Object.freeze({
  floor: 'v3-floor-',
  run: 'v3-run-',
  checkpoint: 'v3-checkpoint-',
  floorMemory: 'v3-floor-memory-',
  entity: 'v3-entity-',
  baseline: 'v3-baseline-',
  stateDelta: 'v3-state-delta-',
  currentState: 'v3-current-state-',
  index: 'v3-index-',
});

function fail(code) { throw Object.assign(new TypeError(code), { code }); }
function identity(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !isUuid(raw.chatId)) fail('V3_STORE_CONTEXT_INVALID');
  return Object.freeze({
    chatId: raw.chatId,
    hostChatId: String(raw.hostChatId ?? ''),
    characterLocator: String(raw.characterLocator ?? ''),
    personaLocator: String(raw.personaLocator ?? ''),
  });
}
function sameIdentity(left, right) {
  return left.chatId === right.chatId
    && left.hostChatId === right.hostChatId
    && left.characterLocator === right.characterLocator
    && left.personaLocator === right.personaLocator;
}
function validateEnvelope(envelope, validator, chatId) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
    || !Number.isSafeInteger(envelope.revision) || envelope.revision < 1) fail('V3_STORE_ENVELOPE_INVALID');
  return Object.freeze({ data: validator(envelope.data, { expectedChatId: chatId }), revision: envelope.revision });
}
function validatorFor(type) {
  const validator = { root: validateFoundationRoot, floor: validateFoundationFloor, floorMemory: validateFloorMemory, entity: validateEntityRecord, baseline: validateBaselineRecord, stateDelta: validateStateDeltaRecord, currentState: validateCurrentStateRecord, run: validateFoundationRun, checkpoint: validateFoundationCheckpoint, index: validateFoundationIndex }[type];
  if (!validator) fail('V3_STORE_RECORD_TYPE_INVALID');
  return validator;
}
function recordKey(record) {
  if (record.recordType === 'root') return V3_ROOT_RECORD_ID;
  if (record.recordType === 'index') return `${RECORD_PREFIX.index}${record.kind}-${record.shard}-${record.id}`;
  const prefix = RECORD_PREFIX[record.recordType];
  if (!prefix) fail('V3_STORE_RECORD_TYPE_INVALID');
  return `${prefix}${record.id}`;
}
function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function manifestMatchesIndexes(root, indexes, indexKeys) {
  const expected = Object.fromEntries(Object.keys(root.indexManifest).map(kind => [kind, []]));
  for (let index = 0; index < indexes.length; index += 1) {
    const bucket = indexes[index].kind === 'reverseRef' ? 'reverseRef'
      : indexes[index].kind === 'entity' ? 'entity' : 'floor';
    expected[bucket].push(indexKeys[index]);
  }
  const allKeys = Object.values(root.indexManifest).flat();
  if (new Set(allKeys).size !== allKeys.length) return false;
  return Object.keys(expected).every(kind => {
    const actual = root.indexManifest[kind];
    return actual.length === expected[kind].length
      && actual.every(key => expected[kind].includes(key));
  });
}

function activeFloorViews(floors, indexes) {
  const locators = new Map();
  const sequences = new Map();
  for (const index of indexes) {
    for (const entry of index.entries) {
      for (const ref of entry.refs) {
        if (index.kind === 'floorOrder' && ref.itemId) {
          try {
            const locator = JSON.parse(ref.itemId);
            if (locator && typeof locator === 'object') { locators.set(ref.recordId, locator); sequences.set(ref.recordId, Number(entry.key)); }
          } catch { /* malformed locator hints are rejected by graph refs, then ignored as an optional overlay */ }
        }
      }
    }
  }
  const ordered = [...floors].sort((left, right) => (sequences.get(left.id) ?? left.assistantSeq) - (sequences.get(right.id) ?? right.assistantSeq));
  return ordered.map((floor, index) => ({
    ...floor,
    assistantSeq: sequences.get(floor.id) ?? index + 1,
    predecessorFloorId: ordered[index - 1]?.id ?? null,
    hostLocator: locators.has(floor.id) ? { ...locators.get(floor.id) } : floor.hostLocator,
  }));
}

function buildReachableResult({
  root,
  rootRevision,
  checkpoint,
  runResult,
  floorResults,
  memoryResults,
  entityResults,
  baselineResult,
  deltaResults,
  currentStateResults,
  indexResults,
  indexesMissing = false,
  manifestNeedsReseal = false,
  indexesComplete,
  readMode,
  cseUnavailable = false,
}) {
  const indexes = indexResults.filter(result => result.status === 'ready').map(result => result.data);
  const floors = activeFloorViews(floorResults.map(result => result.data), indexes);
  const floorMemories = memoryResults.map(result => result.data);
  const stateDeltas = deltaResults.map(result => result.data);
  return {
    status: indexesMissing || manifestNeedsReseal ? 'needsReseal' : 'ready',
    root,
    rootRevision,
    checkpoint,
    run: runResult.data,
    runRevision: runResult.revision,
    floors,
    floorRevisions: Object.fromEntries(floorResults.map(result => [result.data.id, result.revision])),
    floorMemories,
    memoryRevisions: Object.fromEntries(memoryResults.map(result => [result.data.id, result.revision])),
    entities: projectEntityFloorBounds(entityResults.map(result => result.data), floors, floorMemories, stateDeltas),
    entityRevisions: Object.fromEntries(entityResults.map(result => [result.data.id, result.revision])),
    baseline: baselineResult?.data ?? null,
    baselineRevision: baselineResult?.revision ?? null,
    stateDeltas,
    deltaRevisions: Object.fromEntries(deltaResults.map(result => [result.data.id, result.revision])),
    currentStates: currentStateResults.map(result => result.data),
    currentStateRevisions: Object.fromEntries(currentStateResults.map(result => [result.data.id, result.revision])),
    indexes,
    indexesMissing: indexesMissing || manifestNeedsReseal,
    indexesComplete,
    readMode,
    ...(cseUnavailable ? { cseUnavailable: true } : {}),
  };
}

export async function reverseRefCandidateKeys(indexManifest, targetRecordId) {
  const prefix = await reverseRefShardPrefix(targetRecordId);
  const marker = `v3-index-reverseRef-${prefix}-`;
  return (Array.isArray(indexManifest?.reverseRef) ? indexManifest.reverseRef : [])
    .filter(key => String(key).startsWith(marker))
    .sort((left, right) => {
      const suffix = key => Number(String(key).slice(marker.length).split('-')[0]);
      return suffix(left) - suffix(right);
    });
}

export function createFoundationStore({ client, contextProvider, isEnabled = true } = {}) {
  if (typeof client?.get !== 'function' || typeof client?.put !== 'function') throw new TypeError('V3 store client 必须提供 get/put');
  if (typeof contextProvider !== 'function') throw new TypeError('V3 store contextProvider 必须是函数');
  let epoch = 0;
  const enabled = () => {
    try { return (typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true; }
    catch { return false; }
  };
  const capture = () => identity(contextProvider());
  const collection = current => `chat-${current.chatId}`;
  const operationState = operation => {
    if (operation.epoch !== epoch) return 'stale';
    if (!enabled()) return 'disabled';
    try { return sameIdentity(operation.identity, capture()) ? 'current' : 'stale'; }
    catch { return 'stale'; }
  };
  function execute(task) {
    if (!enabled()) return Promise.resolve({ status: 'disabled' });
    const operation = { epoch, identity: capture() };
    return (async () => {
      const before = operationState(operation);
      if (before !== 'current') return { status: before };
      try {
        const result = await task(operation.identity);
        const after = operationState(operation);
        return after === 'current' ? result : { status: after };
      } catch (error) {
        const after = operationState(operation);
        if (after !== 'current') return { status: after };
        throw error;
      }
    })();
  }
  async function read(identityValue, key, validator, missingStatus = 'missing') {
    try {
      const envelope = await client.get(collection(identityValue), key);
      const safe = validateEnvelope(envelope, validator, identityValue.chatId);
      if (validator === validateFoundationFloor) await validateFoundationFloorContent(safe.data, { expectedChatId: identityValue.chatId });
      return { status: 'ready', ...safe, recordId: key };
    } catch (error) {
      if (error?.status === 404) return { status: missingStatus };
      throw error;
    }
  }
  function readRoot() {
    return execute(current => read(current, V3_ROOT_RECORD_ID, validateFoundationRoot, 'uninitialized'));
  }
  function readRecord(recordType, idOrKey) {
    return execute(current => {
      const key = String(idOrKey).startsWith('v3-') ? String(idOrKey) : `${RECORD_PREFIX[recordType] ?? ''}${idOrKey}`;
      return read(current, key, validatorFor(recordType));
    });
  }
  function putRecord(record, { signal } = {}) {
    return execute(async current => {
      const validator = validatorFor(record?.recordType);
      const safe = validator(record, { expectedChatId: current.chatId });
      if (safe.recordType === 'floor') await validateFoundationFloorContent(safe, { expectedChatId: current.chatId });
      const key = recordKey(safe);
      try {
        const envelope = await client.put(collection(current), key, safe, 0, { signal });
        const saved = validateEnvelope(envelope, validator, current.chatId);
        if (!sameJson(saved.data, safe)) fail('V3_STORE_RESPONSE_MISMATCH');
        return { status: 'saved', ...saved, recordId: key };
      } catch (error) {
        if (error?.status !== 409) throw error;
        const winner = await read(current, key, validator);
        if (winner.status === 'ready' && sameFoundationRecordContent(winner.data, safe)) return { ...winner, status: 'reused', recordId: key };
        return { status: 'conflict', recordId: key };
      }
    });
  }
  function replaceRecord(record, expectedRevision, { signal } = {}) {
    return execute(async current => {
      const validator = validatorFor(record?.recordType);
      const safe = validator(record, { expectedChatId: current.chatId });
      if (safe.recordType === 'floor') await validateFoundationFloorContent(safe, { expectedChatId: current.chatId });
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail('V3_STORE_REVISION_INVALID');
      const key = recordKey(safe);
      try {
        const envelope = await client.put(collection(current), key, safe, expectedRevision, { signal });
        const saved = validateEnvelope(envelope, validator, current.chatId);
        if (!sameJson(saved.data, safe)) fail('V3_STORE_RESPONSE_MISMATCH');
        return { status: 'saved', ...saved, recordId: key };
      } catch (error) {
        if (error?.status === 409) return { status: 'conflict', recordId: key };
        throw error;
      }
    });
  }
  async function validateCommitGraph(current, root) {
    if (!root.headCheckpointId) fail('V3_STORE_CHECKPOINT_MISSING');
    const checkpointResult = await read(current, `${RECORD_PREFIX.checkpoint}${root.headCheckpointId}`, validateFoundationCheckpoint);
    if (checkpointResult.status !== 'ready') fail('V3_STORE_CHECKPOINT_MISSING');
    const checkpoint = checkpointResult.data;
    const readConcurrency = 16;
    async function readGroup(values, loader) {
      const results = new Array(values.length);
      let cursor = 0;
      let firstError = null;
      async function worker() {
        while (firstError === null) {
          const index = cursor;
          if (index >= values.length) return;
          cursor += 1;
          try { results[index] = await loader(values[index]); }
          catch (error) { firstError ??= error; }
        }
      }
      await Promise.all(Array.from({ length: Math.min(readConcurrency, values.length) }, () => worker()));
      if (firstError) throw firstError;
      return results;
    }
    const indexKeys = Object.values(root.indexManifest).flat();
    const settledGroups = await Promise.allSettled([
      readGroup(checkpoint.producedRefs.floors, id => read(current, `${RECORD_PREFIX.floor}${id}`, validateFoundationFloor)),
      readGroup(indexKeys, key => read(current, key, validateFoundationIndex)),
      read(current, `${RECORD_PREFIX.run}${checkpoint.runId}`, validateFoundationRun),
      readGroup(checkpoint.producedRefs.floorMemories, id => read(current, `${RECORD_PREFIX.floorMemory}${id}`, validateFloorMemory)),
      readGroup(checkpoint.producedRefs.entities, id => read(current, `${RECORD_PREFIX.entity}${id}`, validateEntityRecord)),
      root.baselineId ? read(current, `${RECORD_PREFIX.baseline}${root.baselineId}`, validateBaselineRecord) : Promise.resolve(null),
      readGroup(checkpoint.producedRefs.stateDeltas, id => read(current, `${RECORD_PREFIX.stateDelta}${id}`, validateStateDeltaRecord)),
      readGroup(checkpoint.producedRefs.currentStates, id => read(current, `${RECORD_PREFIX.currentState}${id}`, validateCurrentStateRecord)),
    ]);
    const rejected = settledGroups.find(result => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    const [floorResults, indexResults, runResult, memoryResults, entityResults, baselineResult, deltaResults, currentStateResults] = settledGroups.map(result => result.value);
    if (floorResults.some(result => result.status !== 'ready')) fail('V3_STORE_FLOOR_MISSING');
    if (indexResults.some(result => result.status !== 'ready')) fail('V3_STORE_INDEX_MISSING');
    if (runResult.status !== 'ready') fail('V3_STORE_RUN_MISSING');
    if (memoryResults.some(result => result.status !== 'ready')) fail('V3_STORE_FLOOR_MEMORY_MISSING');
    if (entityResults.some(result => result.status !== 'ready')) fail('V3_STORE_ENTITY_MISSING');
    if (baselineResult && baselineResult.status !== 'ready') fail('V3_STORE_BASELINE_MISSING');
    if (deltaResults.some(result => result.status !== 'ready')) fail('V3_STORE_STATE_DELTA_MISSING');
    if (currentStateResults.some(result => result.status !== 'ready')) fail('V3_STORE_CURRENT_STATE_MISSING');
    await validateCseGraph({
      root,
      checkpoint,
      run: runResult.data,
      floors: activeFloorViews(floorResults.map(result => result.data), indexResults.map(result => result.data)),
      floorMemories: memoryResults.map(result => result.data),
      entities: projectEntityFloorBounds(entityResults.map(result => result.data), activeFloorViews(floorResults.map(result => result.data), indexResults.map(result => result.data)), memoryResults.map(result => result.data), deltaResults.map(result => result.data)),
      indexes: indexResults.map(result => result.data),
      indexKeys,
      baseline: baselineResult?.data ?? null,
      stateDeltas: deltaResults.map(result => result.data),
      currentStates: currentStateResults.map(result => result.data),
    });
    return {
      checkpoint,
      runResult,
      floorResults,
      memoryResults,
      entityResults,
      baselineResult,
      deltaResults,
      currentStateResults,
      indexResults,
    };
  }
  function commitRoot(root, expectedRevision, { signal } = {}) {
    return execute(async current => {
      const safe = validateFoundationRoot(root, { expectedChatId: current.chatId });
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('V3_STORE_REVISION_INVALID');
      // Backing records are content-addressed and create-if-absent. The backend must keep them immutable
      // throughout this final read/validate/root-CAS sequence; the records API has no multi-record transaction.
      const validatedGraph = await validateCommitGraph(current, safe);
      try {
        const envelope = await client.put(collection(current), V3_ROOT_RECORD_ID, safe, expectedRevision, { signal });
        const saved = validateEnvelope(envelope, validateFoundationRoot, current.chatId);
        if (!sameJson(saved.data, safe)) fail('V3_STORE_RESPONSE_MISMATCH');
        return {
          status: 'saved',
          ...saved,
          recordId: V3_ROOT_RECORD_ID,
          reachable: buildReachableResult({
            root: saved.data,
            rootRevision: saved.revision,
            ...validatedGraph,
            indexesComplete: true,
            readMode: V3_READ_MODES.full,
          }),
        };
      } catch (error) {
        if (error?.status === 409) return { status: 'conflict' };
        throw error;
      }
    });
  }
  async function settleRun(record, expectedRevision, identityValue) {
    if (!enabled()) return { status: 'disabled' };
    const captured = identity(identityValue);
    const safe = validateFoundationRun(record, { expectedChatId: captured.chatId });
    if (!['stale', 'retryableError', 'cancelled'].includes(safe.phase)) fail('V3_STORE_SETTLE_PHASE_INVALID');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail('V3_STORE_REVISION_INVALID');
    try {
      const envelope = await client.put(collection(captured), recordKey(safe), safe, expectedRevision);
      const saved = validateEnvelope(envelope, validateFoundationRun, captured.chatId);
      if (!sameJson(saved.data, safe)) fail('V3_STORE_RESPONSE_MISMATCH');
      return { status: 'saved', ...saved, recordId: recordKey(safe) };
    } catch (error) {
      if (error?.status === 409) return { status: 'conflict', recordId: recordKey(safe) };
      throw error;
    }
  }
  async function readReachable({ mode = V3_READ_MODES.full, allowRecallCseFallback = false } = {}) {
    if (!Object.values(V3_READ_MODES).includes(mode)) fail('V3_STORE_READ_MODE_INVALID');
    const rootResult = await readRoot();
    if (rootResult.status !== 'ready') return rootResult;
    const root = rootResult.data;
    if (!root.headCheckpointId) return { ...rootResult, checkpoint: null, floors: [], indexes: [] };
    const checkpointResult = await readRecord('checkpoint', root.headCheckpointId);
    if (checkpointResult.status !== 'ready') fail('V3_STORE_CHECKPOINT_MISSING');
    const checkpoint = checkpointResult.data;
    if (checkpoint.narrativeGeneration !== root.narrativeGeneration || !checkpoint.capabilities.foundationReady) fail('V3_STORE_CHECKPOINT_MISMATCH');
    const runResult = await readRecord('run', checkpoint.runId);
    if (runResult.status !== 'ready') fail('V3_STORE_RUN_MISSING');
    const legacySnapshot = root.sourceSnapshotFingerprint === null
      || checkpoint.sourceSnapshotFingerprint === null
      || runResult.data.inputSnapshotFingerprint === null;
    const effectiveMode = legacySnapshot ? V3_READ_MODES.full : mode;
    const selectedIndexKeys = effectiveMode === V3_READ_MODES.full
      ? checkpoint.producedRefs.indexes
      : effectiveMode === V3_READ_MODES.runtime
        ? checkpoint.producedRefs.indexes.filter(key => String(key).startsWith('v3-index-floorOrder-') || String(key).startsWith('v3-index-fingerprint-'))
        : checkpoint.producedRefs.indexes.filter(key => String(key).startsWith('v3-index-floorOrder-'));
    const floorResults = await Promise.all(checkpoint.producedRefs.floors.map(id => readRecord('floor', id)));
    if (floorResults.some(result => result.status !== 'ready')) fail('V3_STORE_FLOOR_MISSING');
    const indexResults = await Promise.all(selectedIndexKeys.map(key => readRecord('index', key)));
    const indexesMissing = indexResults.some(result => result.status === 'missing');
    if (indexResults.some(result => !['ready', 'missing'].includes(result.status))) fail('V3_STORE_INDEX_UNAVAILABLE');
    if (indexesMissing && !legacySnapshot) fail('V3_STORE_INDEX_MISSING');
    const memoryResults = await Promise.all(checkpoint.producedRefs.floorMemories.map(id => readRecord('floorMemory', id)));
    if (memoryResults.some(result => result.status !== 'ready')) fail('V3_STORE_FLOOR_MEMORY_MISSING');
    const entityResults = await Promise.all(checkpoint.producedRefs.entities.map(id => readRecord('entity', id)));
    if (entityResults.some(result => result.status !== 'ready')) fail('V3_STORE_ENTITY_MISSING');
    let baselineResult;
    let deltaResults;
    let currentStateResults;
    let baselineFailed = false;
    let deltaFailed = false;
    let currentStateFailed = false;
    if (!allowRecallCseFallback) {
      baselineResult = root.baselineId ? await readRecord('baseline', root.baselineId) : null;
      if (baselineResult && baselineResult.status !== 'ready') fail('V3_STORE_BASELINE_MISSING');
      deltaResults = await Promise.all(checkpoint.producedRefs.stateDeltas.map(id => readRecord('stateDelta', id)));
      if (deltaResults.some(result => result.status !== 'ready')) fail('V3_STORE_STATE_DELTA_MISSING');
      currentStateResults = await Promise.all(checkpoint.producedRefs.currentStates.map(id => readRecord('currentState', id)));
      if (currentStateResults.some(result => result.status !== 'ready')) fail('V3_STORE_CURRENT_STATE_MISSING');
    } else {
      const [baselineSettled, deltaSettled, currentSettled] = await Promise.all([
        root.baselineId ? Promise.allSettled([readRecord('baseline', root.baselineId)]) : Promise.resolve([]),
        Promise.allSettled(checkpoint.producedRefs.stateDeltas.map(id => readRecord('stateDelta', id))),
        Promise.allSettled(checkpoint.producedRefs.currentStates.map(id => readRecord('currentState', id))),
      ]);
      const interrupted = [...baselineSettled, ...deltaSettled, ...currentSettled]
        .find(result => result.status === 'fulfilled' && ['stale', 'disabled'].includes(result.value?.status));
      if (interrupted) return { status: interrupted.value.status };
      const identityFailure = [...baselineSettled, ...deltaSettled, ...currentSettled]
        .find(result => result.status === 'rejected' && result.reason?.validationPath === 'chatId');
      if (identityFailure) throw identityFailure.reason;
      const ready = settled => settled.filter(result => result.status === 'fulfilled' && result.value?.status === 'ready').map(result => result.value);
      const failed = settled => settled.some(result => result.status === 'rejected' || result.value?.status !== 'ready');
      baselineFailed = failed(baselineSettled);
      deltaFailed = failed(deltaSettled);
      currentStateFailed = failed(currentSettled);
      [baselineResult] = ready(baselineSettled);
      deltaResults = ready(deltaSettled);
      currentStateResults = ready(currentSettled);
    }
    const indexes = indexResults.filter(result => result.status === 'ready').map(result => result.data);
    const indexKeys = indexResults.filter(result => result.status === 'ready').map(result => result.recordId);
    const indexesComplete = effectiveMode === V3_READ_MODES.full;
    const manifestNeedsReseal = indexesComplete && legacySnapshot && !manifestMatchesIndexes(root, indexes, indexKeys);
    const activeFloors = activeFloorViews(floorResults.map(result => result.data), indexes);
    const activeMemories = memoryResults.map(result => result.data);
    const activeDeltas = baselineFailed || deltaFailed ? [] : deltaResults.map(result => result.data);
    const activeEntities = projectEntityFloorBounds(entityResults.map(result => result.data), activeFloors, activeMemories, activeDeltas);
    const graphInput = {
      root,
      checkpoint,
      run: runResult.data,
      floors: activeFloors,
      floorMemories: activeMemories,
      entities: activeEntities,
      indexes,
      indexKeys,
      allowMissingIndexes: !indexesComplete || (indexesMissing && legacySnapshot), allowLegacySnapshot: true,
    };
    let cseUnavailable = false;
    if (!allowRecallCseFallback) {
      await validateCseGraph({ ...graphInput, baseline: baselineResult?.data ?? null, stateDeltas: activeDeltas, currentStates: currentStateResults.map(result => result.data) });
    } else {
      try {
        if (baselineFailed || deltaFailed) throw new TypeError('V3_RECALL_CSE_RECORD_UNAVAILABLE');
        try {
          if (currentStateFailed) throw new TypeError('V3_RECALL_CURRENT_STATE_UNAVAILABLE');
          await validateCseGraph({ ...graphInput, baseline: baselineResult?.data ?? null, stateDeltas: activeDeltas, currentStates: currentStateResults.map(result => result.data) });
        } catch {
          const checkpointWithoutCurrent = { ...checkpoint, producedRefs: { ...checkpoint.producedRefs, currentStates: [] } };
          await validateCseGraph({ ...graphInput, checkpoint: checkpointWithoutCurrent, baseline: baselineResult?.data ?? null, stateDeltas: activeDeltas, currentStates: [] });
          currentStateResults = [];
        }
      } catch {
        await validateMemoryGraph(graphInput);
        baselineResult = null;
        deltaResults = [];
        currentStateResults = [];
        cseUnavailable = true;
      }
    }
    return buildReachableResult({
      root,
      rootRevision: rootResult.revision,
      checkpoint,
      runResult,
      floorResults,
      memoryResults,
      entityResults,
      baselineResult,
      deltaResults,
      currentStateResults,
      indexResults,
      indexesMissing,
      manifestNeedsReseal,
      indexesComplete,
      readMode: effectiveMode,
      cseUnavailable,
    });
  }
  return Object.freeze({
    readRoot,
    readRecord,
    readReachable,
    putRecord,
    replaceRecord,
    settleRun,
    commitRoot,
    invalidate() { epoch += 1; },
    recordKey,
  });
}
