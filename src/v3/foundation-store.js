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
import { migrationDescriptorRecordKey, validateMigrationDescriptor } from './migration-prefix.js';

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
  migrationDescriptor: 'v3-migration-',
  index: 'v3-index-',
});
const CONFIRMED_CONTENT_TYPES = new Set(['floor', 'floorMemory', 'entity', 'baseline', 'stateDelta', 'currentState', 'migrationDescriptor']);
const CACHED_CONTENT_TYPES = new Set(['floor', 'floorMemory', 'entity', 'stateDelta', 'index']);
const READ_CONCURRENCY = 16;

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
  const value = { data: validator(envelope.data, { expectedChatId: chatId }), revision: envelope.revision,
    generationId: typeof envelope.generationId === 'string' ? envelope.generationId : null };
  Object.defineProperty(value, 'rawEnvelope', { value: envelope, enumerable: false });
  return Object.freeze(value);
}
function validatorFor(type) {
  const validator = { root: validateFoundationRoot, floor: validateFoundationFloor, floorMemory: validateFloorMemory, entity: validateEntityRecord, baseline: validateBaselineRecord, stateDelta: validateStateDeltaRecord, currentState: validateCurrentStateRecord, run: validateFoundationRun, checkpoint: validateFoundationCheckpoint, index: validateFoundationIndex, migrationDescriptor: validateMigrationDescriptor }[type];
  if (!validator) fail('V3_STORE_RECORD_TYPE_INVALID');
  return validator;
}
function recordKey(record) {
  if (record.recordType === 'root') return V3_ROOT_RECORD_ID;
  if (record.recordType === 'index') return `${RECORD_PREFIX.index}${record.kind}-${record.shard}-${record.id}`;
  if (record.recordType === 'migrationDescriptor') return migrationDescriptorRecordKey(record.id);
  const prefix = RECORD_PREFIX[record.recordType];
  if (!prefix) fail('V3_STORE_RECORD_TYPE_INVALID');
  return `${prefix}${record.id}`;
}
function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function cacheWitness(root, rootEnvelope) {
  if (typeof rootEnvelope?.generationId !== 'string' || !root.headCheckpointId) return null;
  return Object.freeze({ formatVersion: 1, generationId: rootEnvelope.generationId, revision: rootEnvelope.revision,
    headCheckpointId: root.headCheckpointId, narrativeGeneration: root.narrativeGeneration,
    sourceSnapshotFingerprint: root.sourceSnapshotFingerprint });
}
function cacheRecordRefs(checkpoint, selectedIndexIds = checkpoint.producedRefs.indexes) {
  const refs = checkpoint.producedRefs;
  return {
    floor: refs.floors.map(id => `${RECORD_PREFIX.floor}${id}`),
    floorMemory: refs.floorMemories.map(id => `${RECORD_PREFIX.floorMemory}${id}`),
    entity: refs.entities.map(id => `${RECORD_PREFIX.entity}${id}`),
    stateDelta: refs.stateDeltas.map(id => `${RECORD_PREFIX.stateDelta}${id}`),
    index: refs.indexes.filter(id => selectedIndexIds.includes(id)),
  };
}

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
  migrationDescriptor = undefined,
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
    ...(migrationDescriptor ? { migrationDescriptor } : {}),
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

export function createFoundationStore({ client, contextProvider, isEnabled = true, coreRecordCache = null } = {}) {
  if (typeof client?.get !== 'function' || typeof client?.put !== 'function') throw new TypeError('V3 store client 必须提供 get/put');
  if (typeof contextProvider !== 'function') throw new TypeError('V3 store contextProvider 必须是函数');
  const confirmedContent = new Map();
  const stagedCoreRecords = new Map();
  const identityViewBorrowers = new Map();
  const enabled = () => {
    try { return (typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true; }
    catch { return false; }
  };
  const capture = () => identity(contextProvider());
  const collection = current => `chat-${current.chatId}`;
  const confirmedKey = (current, key) => `${collection(current)}\u0000${key}`;
  const stageCoreRecord = (current, key, recordType, envelope, cacheScope) => {
    if (!cacheScope || !CACHED_CONTENT_TYPES.has(recordType) || !envelope || typeof envelope.generationId !== 'string' || !Number.isSafeInteger(envelope.revision)) return;
    stagedCoreRecords.set(confirmedKey(current, key), { recordId: key, envelope });
  };
  const confirmedCopy = value => ({ status: 'ready', data: structuredClone(value.data), revision: value.revision, generationId: value.generationId ?? null, recordId: value.recordId });
  const rememberConfirmed = (current, value) => {
    if (value?.status !== 'ready' || !CONFIRMED_CONTENT_TYPES.has(value.data?.recordType)) return value;
    confirmedContent.set(confirmedKey(current, value.recordId), confirmedCopy(value));
    return value;
  };
  const readConfirmed = (current, key, validator) => {
    const value = confirmedContent.get(confirmedKey(current, key));
    return value ? Promise.resolve(confirmedCopy(value)) : read(current, key, validator);
  };
  const pruneConfirmed = (current, root, checkpoint) => {
    const keep = new Set([
      ...checkpoint.producedRefs.floors.map(id => `${RECORD_PREFIX.floor}${id}`),
      ...checkpoint.producedRefs.floorMemories.map(id => `${RECORD_PREFIX.floorMemory}${id}`),
      ...checkpoint.producedRefs.entities.map(id => `${RECORD_PREFIX.entity}${id}`),
      ...(root.baselineId ? [`${RECORD_PREFIX.baseline}${root.baselineId}`] : []),
      ...checkpoint.producedRefs.stateDeltas.map(id => `${RECORD_PREFIX.stateDelta}${id}`),
      ...checkpoint.producedRefs.currentStates.map(id => `${RECORD_PREFIX.currentState}${id}`),
      ...(root.migrationDescriptorId ? [`${RECORD_PREFIX.migrationDescriptor}${root.migrationDescriptorId}`] : []),
    ].map(key => confirmedKey(current, key)));
    const prefix = `${collection(current)}\u0000`;
    for (const key of confirmedContent.keys()) if (key.startsWith(prefix) && !keep.has(key)) confirmedContent.delete(key);
  };
  const clearConfirmedIdentity = current => {
    const prefix = `${collection(current)}\u0000`;
    for (const key of confirmedContent.keys()) if (key.startsWith(prefix)) confirmedContent.delete(key);
  };
  const clearStagedIdentity = current => {
    const prefix = `${collection(current)}\u0000`;
    for (const key of stagedCoreRecords.keys()) if (key.startsWith(prefix)) stagedCoreRecords.delete(key);
  };
  const operationState = () => enabled() ? 'current' : 'disabled';
  function execute(task, fixedIdentity = null) {
    if (!enabled()) return Promise.resolve({ status: 'disabled' });
    const operation = { identity: fixedIdentity ?? capture(), fixedIdentity: fixedIdentity !== null, cacheScope: null, cacheVersion: null, cacheWitness: null, cacheManifest: null, cacheObserved: null, cacheHits: 0 };
    try { operation.cacheVersion = coreRecordCache?.captureIdentityVersion?.(operation.identity) ?? null; } catch { operation.cacheVersion = null; }
    return (async () => {
      try { operation.cacheScope = await coreRecordCache?.scopeFor?.(operation.identity) ?? null; } catch { operation.cacheScope = null; }
      const before = operationState(operation);
      if (before !== 'current') return { status: before };
      try {
        const result = await task(operation.identity, operation);
        const after = operationState(operation);
        return after === 'current' ? result : { status: after };
      } catch (error) {
        const after = operationState(operation);
        if (after !== 'current') return { status: after };
        throw error;
      }
    })();
  }
  async function readMany(operation, values, reader, { settled = false } = {}) {
    const items = Array.from(values ?? []);
    const results = new Array(items.length);
    let cursor = 0;
    let firstError = null;
    async function worker() {
      while (firstError === null) {
        const before = operationState(operation);
        if (before !== 'current') { firstError = Object.assign(new Error(`V3_${before.toUpperCase()}`), { operationStatus: before }); return; }
        const index = cursor;
        if (index >= items.length) return;
        cursor += 1;
        if (settled) {
          try { results[index] = { status: 'fulfilled', value: await reader(items[index], index) }; }
          catch (reason) { results[index] = { status: 'rejected', reason }; }
        } else {
          try { results[index] = await reader(items[index], index); }
          catch (error) { firstError ??= error; return; }
        }
        const after = operationState(operation);
        if (after !== 'current') { firstError ??= Object.assign(new Error(`V3_${after.toUpperCase()}`), { operationStatus: after }); return; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, () => worker()));
    if (firstError) throw firstError;
    return results;
  }
  async function read(identityValue, key, validator, missingStatus = 'missing', cacheRead = null) {
    if (cacheRead?.manifest && cacheRead.recordType && operationState(cacheRead.operation) === 'current') {
      try {
        const cachedEnvelope = await coreRecordCache.readRecord(cacheRead.operation.cacheScope, cacheRead.witness, cacheRead.recordType, key, cacheRead.operation.cacheManifest);
        if (cachedEnvelope) {
          try {
            const safe = validateEnvelope(cachedEnvelope, validator, identityValue.chatId);
            if (validator === validateFoundationFloor) await validateFoundationFloorContent(safe.data, { expectedChatId: identityValue.chatId });
            cacheRead.operation.cacheHits += 1;
            const result = { status: 'ready', ...safe, recordId: key };
            Object.defineProperty(result, 'rawEnvelope', { value: cachedEnvelope, enumerable: false });
            return rememberConfirmed(identityValue, result);
        } catch {
            await coreRecordCache.removeRecord?.(cacheRead.operation.cacheScope, cacheRead.witness, cacheRead.recordType, key);
          }
        }
      } catch { /* IDB errors are misses; the formal store remains authoritative. */ }
    }
    try {
      const envelope = await client.get(collection(identityValue), key);
      const safe = validateEnvelope(envelope, validator, identityValue.chatId);
      if (validator === validateFoundationFloor) await validateFoundationFloorContent(safe.data, { expectedChatId: identityValue.chatId });
      if (cacheRead?.operation?.cacheScope && cacheRead.witness && cacheRead.recordType && safe.rawEnvelope) {
        cacheRead.operation.cacheObserved ??= new Map();
        cacheRead.operation.cacheObserved.set(`${cacheRead.recordType}\u0000${key}`, { recordId: key, envelope: safe.rawEnvelope });
      }
      const result = { status: 'ready', ...safe, recordId: key };
      Object.defineProperty(result, 'rawEnvelope', { value: envelope, enumerable: false });
      return rememberConfirmed(identityValue, result);
    } catch (error) {
      if (error?.status === 404) return { status: missingStatus };
      throw error;
    }
  }
  async function verifyCacheRootGeneration(current) {
    try {
      const envelope = await client.get(collection(current), V3_ROOT_RECORD_ID);
      const root = validateEnvelope(envelope, validateFoundationRoot, current.chatId);
      return { generationId: root.generationId, revision: root.revision };
    } catch (error) {
      if (error?.status === 404) return { generationId: null, revision: null };
      throw error;
    }
  }
  function readRoot(identityOverride = null) {
    return execute(current => read(current, V3_ROOT_RECORD_ID, validateFoundationRoot, 'uninitialized'), identityOverride);
  }
  function readRecord(recordType, idOrKey, identityOverride = null) {
    return execute(current => {
      const key = String(idOrKey).startsWith('v3-') ? String(idOrKey) : `${RECORD_PREFIX[recordType] ?? ''}${idOrKey}`;
      return read(current, key, validatorFor(recordType));
    }, identityOverride);
  }
  function putRecord(record, { signal } = {}, identityOverride = null) {
    return execute(async (current, operation) => {
      const validator = validatorFor(record?.recordType);
      const safe = validator(record, { expectedChatId: current.chatId });
      if (safe.recordType === 'floor') await validateFoundationFloorContent(safe, { expectedChatId: current.chatId });
      const key = recordKey(safe);
      try {
        const envelope = await client.put(collection(current), key, safe, 0, { signal });
        const saved = validateEnvelope(envelope, validator, current.chatId);
        if (!sameJson(saved.data, safe)) fail('V3_STORE_RESPONSE_MISMATCH');
        const result = { status: 'saved', ...saved, recordId: key };
        rememberConfirmed(current, { ...result, status: 'ready' });
        stageCoreRecord(current, key, safe.recordType, saved.rawEnvelope, operation.cacheScope);
        return result;
      } catch (error) {
        if (error?.status !== 409) throw error;
        const winner = await read(current, key, validator);
        if (winner.status === 'ready' && sameFoundationRecordContent(winner.data, safe)) {
          stageCoreRecord(current, key, safe.recordType, winner.rawEnvelope, operation.cacheScope);
          return { ...winner, status: 'reused', recordId: key };
        }
        return { status: 'conflict', recordId: key };
      }
    }, identityOverride);
  }
  function replaceRecord(record, expectedRevision, { signal } = {}, identityOverride = null) {
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
    }, identityOverride);
  }
  async function validateCommitGraph(current, root) {
    if (!root.headCheckpointId) fail('V3_STORE_CHECKPOINT_MISSING');
    let migrationDescriptorResult = null;
    if (root.migrationDescriptorId) {
      migrationDescriptorResult = await readConfirmed(current, `${RECORD_PREFIX.migrationDescriptor}${root.migrationDescriptorId}`, validateMigrationDescriptor);
      if (migrationDescriptorResult.status !== 'ready' || migrationDescriptorResult.data.id !== root.migrationDescriptorId) fail('V3_STORE_MIGRATION_DESCRIPTOR_MISSING');
    }
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
      readGroup(checkpoint.producedRefs.floors, id => readConfirmed(current, `${RECORD_PREFIX.floor}${id}`, validateFoundationFloor)),
      readGroup(indexKeys, key => read(current, key, validateFoundationIndex)),
      read(current, `${RECORD_PREFIX.run}${checkpoint.runId}`, validateFoundationRun),
      readGroup(checkpoint.producedRefs.floorMemories, id => readConfirmed(current, `${RECORD_PREFIX.floorMemory}${id}`, validateFloorMemory)),
      readGroup(checkpoint.producedRefs.entities, id => readConfirmed(current, `${RECORD_PREFIX.entity}${id}`, validateEntityRecord)),
      root.baselineId ? readConfirmed(current, `${RECORD_PREFIX.baseline}${root.baselineId}`, validateBaselineRecord) : Promise.resolve(null),
      readGroup(checkpoint.producedRefs.stateDeltas, id => readConfirmed(current, `${RECORD_PREFIX.stateDelta}${id}`, validateStateDeltaRecord)),
      readGroup(checkpoint.producedRefs.currentStates, id => readConfirmed(current, `${RECORD_PREFIX.currentState}${id}`, validateCurrentStateRecord)),
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
      migrationDescriptor: migrationDescriptorResult?.data ?? null,
    };
  }
  function commitRoot(root, expectedRevision, { signal, awaitCoreCachePublish = false } = {}, identityOverride = null) {
    return execute(async (current, operation) => {
      const safe = validateFoundationRoot(root, { expectedChatId: current.chatId });
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('V3_STORE_REVISION_INVALID');
      // 根入口提交前先读取并校验图记录，再执行根 CAS；两步没有跨记录事务，后端须保证这段期间图记录不可改写。
      let validatedGraph;
      try { validatedGraph = await validateCommitGraph(current, safe); }
      catch (error) { clearStagedIdentity(current); throw error; }
      try {
        const envelope = await client.put(collection(current), V3_ROOT_RECORD_ID, safe, expectedRevision, { signal });
        const saved = validateEnvelope(envelope, validateFoundationRoot, current.chatId);
        if (!sameJson(saved.data, safe)) fail('V3_STORE_RESPONSE_MISMATCH');
        pruneConfirmed(current, saved.data, validatedGraph.checkpoint);
        const reachableCore = [
          ...validatedGraph.floorResults, ...validatedGraph.memoryResults, ...validatedGraph.entityResults,
          ...validatedGraph.deltaResults, ...validatedGraph.indexResults,
        ];
        const stagePrefix = `${collection(current)}\u0000`;
        const staged = [];
        for (const record of reachableCore) {
          const item = stagedCoreRecords.get(confirmedKey(current, record.recordId));
          if (item?.envelope && item.envelope.revision === record.revision && item.envelope.generationId === record.generationId) staged.push(item);
        }
        if (operation.cacheScope && saved.generationId) {
          const witness = cacheWitness(saved.data, saved);
          let cachePublish = Promise.resolve();
          try {
            cachePublish = Promise.resolve(coreRecordCache?.publish?.(operation.cacheScope, witness, staged,
              cacheRecordRefs(validatedGraph.checkpoint), operation.cacheVersion, () => verifyCacheRootGeneration(current))).catch(() => {});
          } catch { /* A derived cache must not change a successful root save. */ }
          if (awaitCoreCachePublish) await cachePublish;
        }
        for (const key of stagedCoreRecords.keys()) if (key.startsWith(stagePrefix)) stagedCoreRecords.delete(key);
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
        clearStagedIdentity(current);
        if (error?.status === 409) return { status: 'conflict' };
        throw error;
      }
    }, identityOverride);
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
  async function readReachable({ mode = V3_READ_MODES.full, allowRecallCseFallback = false, identity: identityOverride = null, bypassCache = false } = {}) {
    if (!Object.values(V3_READ_MODES).includes(mode)) fail('V3_STORE_READ_MODE_INVALID');
    return execute(async (current, operation) => {
    const readType = (recordType, idOrKey) => {
      const key = String(idOrKey).startsWith('v3-') ? String(idOrKey) : `${RECORD_PREFIX[recordType] ?? ''}${idOrKey}`;
      const cachedType = ['floor', 'floorMemory', 'entity', 'stateDelta', 'index'].includes(recordType) ? recordType : null;
      return read(current, key, validatorFor(recordType), 'missing', cachedType && !bypassCache
        ? { operation, witness: operation.cacheWitness, manifest: operation.cacheManifest, recordType: cachedType }
        : null);
    };
    const rootResult = await read(current, V3_ROOT_RECORD_ID, validateFoundationRoot, 'uninitialized');
    if (rootResult.status !== 'ready') return rootResult;
    const root = rootResult.data;
    let migrationDescriptor = null;
    if (root.migrationDescriptorId) {
      const descriptorResult = await readConfirmed(current, `${RECORD_PREFIX.migrationDescriptor}${root.migrationDescriptorId}`, validateMigrationDescriptor);
      if (descriptorResult.status !== 'ready' || descriptorResult.data.id !== root.migrationDescriptorId) fail('V3_STORE_MIGRATION_DESCRIPTOR_MISSING');
      migrationDescriptor = descriptorResult.data;
    }
    if (!root.headCheckpointId) return { ...rootResult, checkpoint: null, floors: [], indexes: [], ...(migrationDescriptor ? { migrationDescriptor } : {}) };
    const checkpointResult = await readType('checkpoint', root.headCheckpointId);
    if (checkpointResult.status !== 'ready') fail('V3_STORE_CHECKPOINT_MISSING');
    const checkpoint = checkpointResult.data;
    if (checkpoint.narrativeGeneration !== root.narrativeGeneration || !checkpoint.capabilities.foundationReady) fail('V3_STORE_CHECKPOINT_MISMATCH');
    const runResult = await readType('run', checkpoint.runId);
    if (runResult.status !== 'ready') fail('V3_STORE_RUN_MISSING');
    if (operation.cacheScope && rootResult.generationId) {
      operation.cacheWitness = Object.freeze({
        formatVersion: 1,
        generationId: rootResult.generationId,
        revision: rootResult.revision,
        headCheckpointId: root.headCheckpointId,
        narrativeGeneration: root.narrativeGeneration,
        sourceSnapshotFingerprint: root.sourceSnapshotFingerprint,
      });
      if (coreRecordCache) operation.cacheObserved = new Map();
      if (!bypassCache) {
        try { operation.cacheManifest = await coreRecordCache?.readManifest?.(operation.cacheScope, operation.cacheWitness) ?? null; }
        catch { operation.cacheManifest = null; }
      }
    }
    const legacySnapshot = root.sourceSnapshotFingerprint === null
      || checkpoint.sourceSnapshotFingerprint === null
      || runResult.data.inputSnapshotFingerprint === null;
    const effectiveMode = legacySnapshot ? V3_READ_MODES.full : mode;
    const selectedIndexKeys = effectiveMode === V3_READ_MODES.full
      ? checkpoint.producedRefs.indexes
      : effectiveMode === V3_READ_MODES.runtime
        ? checkpoint.producedRefs.indexes.filter(key => String(key).startsWith('v3-index-floorOrder-') || String(key).startsWith('v3-index-fingerprint-'))
        : checkpoint.producedRefs.indexes.filter(key => String(key).startsWith('v3-index-floorOrder-'));
    const floorResults = await readMany(operation, checkpoint.producedRefs.floors, id => readType('floor', id));
    if (floorResults.some(result => result.status !== 'ready')) fail('V3_STORE_FLOOR_MISSING');
    const indexResults = await readMany(operation, selectedIndexKeys, key => readType('index', key));
    const indexesMissing = indexResults.some(result => result.status === 'missing');
    if (indexResults.some(result => !['ready', 'missing'].includes(result.status))) fail('V3_STORE_INDEX_UNAVAILABLE');
    if (indexesMissing && !legacySnapshot) fail('V3_STORE_INDEX_MISSING');
    const memoryResults = await readMany(operation, checkpoint.producedRefs.floorMemories, id => readType('floorMemory', id));
    if (memoryResults.some(result => result.status !== 'ready')) fail('V3_STORE_FLOOR_MEMORY_MISSING');
    const entityResults = await readMany(operation, checkpoint.producedRefs.entities, id => readType('entity', id));
    if (entityResults.some(result => result.status !== 'ready')) fail('V3_STORE_ENTITY_MISSING');
    let baselineResult;
    let deltaResults;
    let currentStateResults;
    let baselineFailed = false;
    let deltaFailed = false;
    let currentStateFailed = false;
    if (!allowRecallCseFallback) {
      baselineResult = root.baselineId ? await readType('baseline', root.baselineId) : null;
      if (baselineResult && baselineResult.status !== 'ready') fail('V3_STORE_BASELINE_MISSING');
      deltaResults = await readMany(operation, checkpoint.producedRefs.stateDeltas, id => readType('stateDelta', id));
      if (deltaResults.some(result => result.status !== 'ready')) fail('V3_STORE_STATE_DELTA_MISSING');
      currentStateResults = await readMany(operation, checkpoint.producedRefs.currentStates, id => readType('currentState', id));
      if (currentStateResults.some(result => result.status !== 'ready')) fail('V3_STORE_CURRENT_STATE_MISSING');
    } else {
      const baselineSettled = root.baselineId ? await readMany(operation, [root.baselineId], id => readType('baseline', id), { settled: true }) : [];
      const deltaSettled = await readMany(operation, checkpoint.producedRefs.stateDeltas, id => readType('stateDelta', id), { settled: true });
      const currentSettled = await readMany(operation, checkpoint.producedRefs.currentStates, id => readType('currentState', id), { settled: true });
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
    const indexesComplete = selectedIndexKeys.length === checkpoint.producedRefs.indexes.length;
    const manifestNeedsReseal = indexesComplete && legacySnapshot && !manifestMatchesIndexes(root, indexes, indexKeys);
    const activeFloors = activeFloorViews(floorResults.map(result => result.data), indexes);
    const activeMemories = memoryResults.map(result => result.data);
    const activeDeltas = baselineFailed || deltaFailed ? [] : deltaResults.map(result => result.data);
    let activeEntities;
    try { activeEntities = projectEntityFloorBounds(entityResults.map(result => result.data), activeFloors, activeMemories, activeDeltas); }
    catch (error) {
      if (operation.cacheHits > 0 && !bypassCache) return readReachable({ mode, allowRecallCseFallback, identity: current, bypassCache: true });
      throw error;
    }
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
      try {
        await validateCseGraph({ ...graphInput, baseline: baselineResult?.data ?? null, stateDeltas: activeDeltas, currentStates: currentStateResults.map(result => result.data) });
      } catch (error) {
        if (operation.cacheHits > 0 && !bypassCache) return readReachable({ mode, allowRecallCseFallback, identity: current, bypassCache: true });
        throw error;
      }
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
        if (operation.cacheHits > 0 && !bypassCache) return readReachable({ mode, allowRecallCseFallback, identity: current, bypassCache: true });
        await validateMemoryGraph(graphInput);
        baselineResult = null;
        deltaResults = [];
        currentStateResults = [];
        cseUnavailable = true;
      }
    }
    let reachable;
    try { reachable = buildReachableResult({
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
      migrationDescriptor,
    }); } catch (error) {
      if (operation.cacheHits > 0 && !bypassCache) return readReachable({ mode, allowRecallCseFallback, identity: current, bypassCache: true });
      throw error;
    }
    if (operation.cacheScope && operation.cacheWitness && reachable.status === 'ready' && !manifestNeedsReseal && !cseUnavailable) {
      const recordRefs = cacheRecordRefs(checkpoint, indexKeys);
      const missingManifestRefs = Object.entries(recordRefs).some(([type, ids]) => ids.some(id => !operation.cacheManifest?.recordRefs?.[type]?.includes(id)));
      void Promise.resolve(coreRecordCache?.maintain?.(operation.cacheScope)).catch(() => {});
      if (!operation.cacheManifest || (operation.cacheObserved?.size ?? 0) || missingManifestRefs) {
        void Promise.resolve(coreRecordCache?.publish?.(operation.cacheScope, operation.cacheWitness, [...(operation.cacheObserved?.values() ?? [])], recordRefs, operation.cacheVersion,
          () => verifyCacheRootGeneration(current))).catch(() => {});
      }
    }
    return reachable;
    }, identityOverride);
  }
  const forIdentity = identityValue => {
    const fixedIdentity = identity(identityValue);
    const leaseKey = collection(fixedIdentity);
    identityViewBorrowers.set(leaseKey, (identityViewBorrowers.get(leaseKey) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const remaining = Math.max(0, (identityViewBorrowers.get(leaseKey) ?? 1) - 1);
      if (remaining) { identityViewBorrowers.set(leaseKey, remaining); return; }
      identityViewBorrowers.delete(leaseKey);
      const stagedPrefix = `${leaseKey}\u0000`;
      for (const key of stagedCoreRecords.keys()) if (key.startsWith(stagedPrefix)) stagedCoreRecords.delete(key);
      try { if (!sameIdentity(fixedIdentity, capture())) clearConfirmedIdentity(fixedIdentity); }
      catch { clearConfirmedIdentity(fixedIdentity); }
    };
    return Object.freeze({
      readRoot: () => readRoot(fixedIdentity),
      readRecord: (recordType, idOrKey) => readRecord(recordType, idOrKey, fixedIdentity),
      readReachable: (options = {}) => readReachable({ ...options, identity: fixedIdentity }),
      putRecord: (record, options = {}) => putRecord(record, options, fixedIdentity),
      replaceRecord: (record, revision, options = {}) => replaceRecord(record, revision, options, fixedIdentity),
      settleRun: (record, revision) => settleRun(record, revision, fixedIdentity),
      commitRoot: (root, revision, options = {}) => commitRoot(root, revision, options, fixedIdentity),
      release,
      recordKey,
    });
  };
  return Object.freeze({
    readRoot,
    readRecord,
    readReachable,
    putRecord,
    replaceRecord,
    settleRun,
    commitRoot,
    forIdentity,
    invalidate() { confirmedContent.clear(); },
    recordKey,
  });
}
