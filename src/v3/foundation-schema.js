import { isUuid, sha256 } from '../identity.js';
import { deterministicUuid, reverseRefShardPrefix } from './foundation-domain.js';

const HASH = /^sha256:[0-9a-f]{64}$/;
const CAPABILITY_KEYS = ['foundationReady', 'memoryReady', 'cseReady', 'recallReady'];
const PUBLIC_RECORD_TYPES = new Set(['root', 'run', 'checkpoint', 'floor', 'floorMemory', 'entity', 'index']);

function fail(code) { throw Object.assign(new TypeError(code), { code }); }
function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}
function array(value, code) { if (!Array.isArray(value)) fail(code); return value; }
function text(value, code, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || !value.trim()) fail(code);
  return value;
}
function uuid(value, code, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (!isUuid(value)) fail(code);
  return value;
}
function timestamp(value, code) { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(code); }
function fingerprint(value, code, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || !HASH.test(value)) fail(code);
  return value;
}
function integer(value, code, minimum = 0) { if (!Number.isSafeInteger(value) || value < minimum) fail(code); return value; }
function exact(value, keys, code) {
  object(value, code);
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
}
function jsonClone(value, active = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('V3_JSON_INVALID'); return value; }
  if (typeof value !== 'object' || active.has(value)) fail('V3_JSON_INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== 'string')) fail('V3_JSON_INVALID');
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const clone = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('V3_JSON_INVALID');
        clone.push(jsonClone(descriptor.value, active));
      }
      return clone;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail('V3_JSON_INVALID');
    const clone = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('V3_JSON_INVALID');
      clone[key] = jsonClone(descriptor.value, active);
    }
    return clone;
  } finally { active.delete(value); }
}

function canonicalJson(value) {
  const normalize = item => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]));
    }
    return item;
  };
  return JSON.stringify(normalize(jsonClone(value)));
}

export function sameFoundationRecordContent(left, right) {
  try { return canonicalJson(left) === canonicalJson(right); }
  catch { return false; }
}

function validateCapabilities(value, code) {
  exact(value, CAPABILITY_KEYS, code);
  if (value.foundationReady !== true || typeof value.memoryReady !== 'boolean' || typeof value.cseReady !== 'boolean' || value.recallReady !== false) fail(code);
}

function validateCommon(value, type) {
  if (value.schemaVersion !== 3 || value.recordType !== type || !PUBLIC_RECORD_TYPES.has(type)) fail(`V3_${type.toUpperCase()}_INVALID`);
  text(value.id, `V3_${type.toUpperCase()}_INVALID`);
  uuid(value.chatId, `V3_${type.toUpperCase()}_INVALID`);
  uuid(value.narrativeGeneration, `V3_${type.toUpperCase()}_INVALID`);
  timestamp(value.createdAt, `V3_${type.toUpperCase()}_INVALID`);
  timestamp(value.updatedAt, `V3_${type.toUpperCase()}_INVALID`);
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) fail(`V3_${type.toUpperCase()}_INVALID`);
  if (!['active', 'superseded', 'invalidated', 'staged'].includes(value.recordStatus)) fail(`V3_${type.toUpperCase()}_INVALID`);
  if (value.supersedes !== null) text(value.supersedes, `V3_${type.toUpperCase()}_INVALID`);
}

export function validateFoundationRoot(input, { expectedChatId } = {}) {
  const value = jsonClone(input);
  if (!Object.hasOwn(value, 'sourceSnapshotFingerprint')) value.sourceSnapshotFingerprint = null;
  exact(value, ['schemaVersion', 'recordType', 'id', 'chatId', 'narrativeGeneration', 'status', 'capabilities', 'headCheckpointId', 'sourceSnapshotFingerprint', 'stableBoundary', 'baselineId', 'activeRunId', 'indexManifest', 'activeStateRefs', 'activeThreadRefs', 'createdAt', 'updatedAt', 'recordStatus', 'supersedes'], 'V3_ROOT_INVALID');
  validateCommon(value, 'root');
  if (value.id !== 'root' || (expectedChatId && value.chatId !== expectedChatId)) fail('V3_ROOT_INVALID');
  if (!['uninitialized', 'initializing', 'ready', 'rebuilding', 'error'].includes(value.status)) fail('V3_ROOT_INVALID');
  validateCapabilities(value.capabilities, 'V3_ROOT_INVALID');
  uuid(value.headCheckpointId, 'V3_ROOT_INVALID', { nullable: true });
  fingerprint(value.sourceSnapshotFingerprint, 'V3_ROOT_INVALID', { nullable: true });
  exact(value.stableBoundary, ['assistantSeq', 'floorId', 'canonicalFingerprint'], 'V3_ROOT_INVALID');
  integer(value.stableBoundary.assistantSeq, 'V3_ROOT_INVALID');
  uuid(value.stableBoundary.floorId, 'V3_ROOT_INVALID', { nullable: true });
  fingerprint(value.stableBoundary.canonicalFingerprint, 'V3_ROOT_INVALID', { nullable: true });
  if ((value.stableBoundary.assistantSeq === 0) !== (value.stableBoundary.floorId === null)) fail('V3_ROOT_INVALID');
  if (value.baselineId !== null) text(value.baselineId, 'V3_ROOT_INVALID');
  uuid(value.activeRunId, 'V3_ROOT_INVALID', { nullable: true });
  exact(value.indexManifest, ['floor', 'entity', 'event', 'claim', 'knowledge', 'episode', 'thread', 'state', 'anchor', 'reverseRef'], 'V3_ROOT_INVALID');
  for (const refs of Object.values(value.indexManifest)) array(refs, 'V3_ROOT_INVALID').forEach(ref => text(ref, 'V3_ROOT_INVALID'));
  array(value.activeStateRefs, 'V3_ROOT_INVALID');
  array(value.activeThreadRefs, 'V3_ROOT_INVALID');
  if (value.recordStatus !== 'active' || value.supersedes !== null) fail('V3_ROOT_INVALID');
  return Object.freeze(value);
}

export function validateFoundationFloor(input, { expectedChatId } = {}) {
  const value = jsonClone(input);
  exact(value, ['schemaVersion', 'recordType', 'id', 'chatId', 'narrativeGeneration', 'assistantSeq', 'predecessorFloorId', 'hostLocator', 'content', 'stability', 'processing', 'createdAt', 'updatedAt', 'recordStatus', 'supersedes'], 'V3_FLOOR_INVALID');
  validateCommon(value, 'floor');
  uuid(value.id, 'V3_FLOOR_INVALID');
  if (expectedChatId && value.chatId !== expectedChatId) fail('V3_FLOOR_INVALID');
  integer(value.assistantSeq, 'V3_FLOOR_INVALID', 1);
  uuid(value.predecessorFloorId, 'V3_FLOOR_INVALID', { nullable: true });
  exact(value.hostLocator, ['messageIndex', 'swipeId', 'selectedSwipeIndex'], 'V3_FLOOR_INVALID');
  integer(value.hostLocator.messageIndex, 'V3_FLOOR_INVALID');
  if (value.hostLocator.swipeId !== null && !['string', 'number'].includes(typeof value.hostLocator.swipeId)) fail('V3_FLOOR_INVALID');
  if (value.hostLocator.selectedSwipeIndex !== null) integer(value.hostLocator.selectedSwipeIndex, 'V3_FLOOR_INVALID');
  exact(value.content, ['canonicalContent', 'rawFingerprint', 'canonicalFingerprint', 'sanitizerFingerprint', 'formatVersion'], 'V3_FLOOR_INVALID');
  if (typeof value.content.canonicalContent !== 'string' || !value.content.canonicalContent) fail('V3_FLOOR_INVALID');
  fingerprint(value.content.rawFingerprint, 'V3_FLOOR_INVALID');
  fingerprint(value.content.canonicalFingerprint, 'V3_FLOOR_INVALID');
  fingerprint(value.content.sanitizerFingerprint, 'V3_FLOOR_INVALID');
  integer(value.content.formatVersion, 'V3_FLOOR_INVALID', 1);
  exact(value.stability, ['status', 'stabilizedAt', 'stabilizedBy'], 'V3_FLOOR_INVALID');
  if (value.stability.status !== 'stable' || !['nextAssistant', 'manual'].includes(value.stability.stabilizedBy)) fail('V3_FLOOR_INVALID');
  timestamp(value.stability.stabilizedAt, 'V3_FLOOR_INVALID');
  exact(value.processing, ['sourceSaved', 'memoryReady', 'cseRequired', 'cseReady', 'recallReady', 'runId', 'checkpointId'], 'V3_FLOOR_INVALID');
  if (value.processing.sourceSaved !== true || [value.processing.memoryReady, value.processing.cseRequired, value.processing.cseReady, value.processing.recallReady].some(Boolean)) fail('V3_FLOOR_INVALID');
  uuid(value.processing.runId, 'V3_FLOOR_INVALID');
  uuid(value.processing.checkpointId, 'V3_FLOOR_INVALID', { nullable: true });
  return Object.freeze(value);
}

export async function validateFoundationFloorContent(input, { expectedChatId } = {}) {
  const floor = validateFoundationFloor(input, { expectedChatId });
  const canonicalFingerprint = `sha256:${await sha256(floor.content.canonicalContent)}`;
  if (floor.content.canonicalFingerprint !== canonicalFingerprint) fail('V3_GRAPH_FLOOR_CANONICAL_FINGERPRINT_INVALID');
  return floor;
}

export function validateFoundationRun(input, { expectedChatId } = {}) {
  const value = jsonClone(input);
  if (!Object.hasOwn(value, 'parentCheckpointId')) value.parentCheckpointId = null;
  if (!Object.hasOwn(value, 'inputSnapshotFingerprint')) value.inputSnapshotFingerprint = null;
  if (!Object.hasOwn(value, 'diagnostics')) value.diagnostics = null;
  exact(value, ['schemaVersion', 'recordType', 'id', 'chatId', 'narrativeGeneration', 'parentCheckpointId', 'inputSnapshotFingerprint', 'mode', 'sessionEpoch', 'inputFloorIds', 'phase', 'completedFloorIds', 'failedItems', 'preparedRecordRefs', 'diagnostics', 'startedAt', 'createdAt', 'updatedAt', 'recordStatus', 'supersedes'], 'V3_RUN_INVALID');
  validateCommon(value, 'run');
  uuid(value.id, 'V3_RUN_INVALID');
  if (expectedChatId && value.chatId !== expectedChatId) fail('V3_RUN_INVALID');
  uuid(value.parentCheckpointId, 'V3_RUN_INVALID', { nullable: true });
  fingerprint(value.inputSnapshotFingerprint, 'V3_RUN_INVALID', { nullable: true });
  if (!['initialize', 'incremental', 'localReextract', 'branchReplay', 'rebuild', 'cse'].includes(value.mode)) fail('V3_RUN_INVALID');
  integer(value.sessionEpoch, 'V3_RUN_INVALID');
  for (const list of [value.inputFloorIds, value.completedFloorIds]) array(list, 'V3_RUN_INVALID').forEach(id => uuid(id, 'V3_RUN_INVALID'));
  if (!['capturing', 'extracting', 'cse', 'validating', 'sealing', 'committing', 'completed', 'retryableError', 'cancelled', 'stale'].includes(value.phase)) fail('V3_RUN_INVALID');
  array(value.failedItems, 'V3_RUN_INVALID');
  array(value.preparedRecordRefs, 'V3_RUN_INVALID').forEach(ref => text(ref, 'V3_RUN_INVALID'));
  if (value.diagnostics !== null) jsonClone(object(value.diagnostics, 'V3_RUN_INVALID'));
  timestamp(value.startedAt, 'V3_RUN_INVALID');
  return Object.freeze(value);
}

export function validateFoundationCheckpoint(input, { expectedChatId } = {}) {
  const value = jsonClone(input);
  if (!Object.hasOwn(value, 'sourceSnapshotFingerprint')) value.sourceSnapshotFingerprint = null;
  exact(value, ['schemaVersion', 'recordType', 'id', 'chatId', 'narrativeGeneration', 'parentCheckpointId', 'runId', 'sourceSnapshotFingerprint', 'capabilities', 'floorRange', 'inputFingerprints', 'producedRefs', 'validation', 'sealedAt', 'createdAt', 'updatedAt', 'recordStatus', 'supersedes'], 'V3_CHECKPOINT_INVALID');
  validateCommon(value, 'checkpoint');
  uuid(value.id, 'V3_CHECKPOINT_INVALID');
  if (expectedChatId && value.chatId !== expectedChatId) fail('V3_CHECKPOINT_INVALID');
  uuid(value.parentCheckpointId, 'V3_CHECKPOINT_INVALID', { nullable: true });
  uuid(value.runId, 'V3_CHECKPOINT_INVALID');
  fingerprint(value.sourceSnapshotFingerprint, 'V3_CHECKPOINT_INVALID', { nullable: true });
  validateCapabilities(value.capabilities, 'V3_CHECKPOINT_INVALID');
  exact(value.floorRange, ['fromAssistantSeq', 'toAssistantSeq', 'floorIds'], 'V3_CHECKPOINT_INVALID');
  integer(value.floorRange.fromAssistantSeq, 'V3_CHECKPOINT_INVALID');
  integer(value.floorRange.toAssistantSeq, 'V3_CHECKPOINT_INVALID');
  const floorIds = array(value.floorRange.floorIds, 'V3_CHECKPOINT_INVALID');
  floorIds.forEach(id => uuid(id, 'V3_CHECKPOINT_INVALID'));
  if (floorIds.length !== value.floorRange.toAssistantSeq || (floorIds.length && value.floorRange.fromAssistantSeq !== 1)) fail('V3_CHECKPOINT_INVALID');
  array(value.inputFingerprints, 'V3_CHECKPOINT_INVALID').forEach(item => {
    exact(item, ['floorId', 'canonicalFingerprint'], 'V3_CHECKPOINT_INVALID');
    uuid(item.floorId, 'V3_CHECKPOINT_INVALID'); fingerprint(item.canonicalFingerprint, 'V3_CHECKPOINT_INVALID');
  });
  exact(value.producedRefs, ['floors', 'floorMemories', 'entities', 'events', 'claims', 'knowledge', 'stateDeltas', 'currentStates', 'stateProjections', 'episodes', 'threads', 'indexes'], 'V3_CHECKPOINT_INVALID');
  for (const refs of Object.values(value.producedRefs)) array(refs, 'V3_CHECKPOINT_INVALID').forEach(ref => text(ref, 'V3_CHECKPOINT_INVALID'));
  exact(value.validation, ['schemaValid', 'referencesValid', 'orderedReplayValid', 'stateFingerprint'], 'V3_CHECKPOINT_INVALID');
  if (value.validation.schemaValid !== true || value.validation.referencesValid !== true || value.validation.orderedReplayValid !== true) fail('V3_CHECKPOINT_INVALID');
  fingerprint(value.validation.stateFingerprint, 'V3_CHECKPOINT_INVALID');
  timestamp(value.sealedAt, 'V3_CHECKPOINT_INVALID');
  if (value.recordStatus !== 'active') fail('V3_CHECKPOINT_INVALID');
  return Object.freeze(value);
}

export function validateFoundationIndex(input, { expectedChatId } = {}) {
  const value = jsonClone(input);
  exact(value, ['schemaVersion', 'recordType', 'id', 'chatId', 'narrativeGeneration', 'kind', 'shard', 'sourceCheckpointId', 'entries', 'entryCount', 'contentFingerprint', 'createdAt', 'updatedAt', 'recordStatus', 'supersedes'], 'V3_INDEX_INVALID');
  validateCommon(value, 'index');
  if (expectedChatId && value.chatId !== expectedChatId) fail('V3_INDEX_INVALID');
  if (!['floorOrder', 'fingerprint', 'entity', 'reverseRef'].includes(value.kind)) fail('V3_INDEX_INVALID');
  text(value.shard, 'V3_INDEX_INVALID');
  uuid(value.sourceCheckpointId, 'V3_INDEX_INVALID');
  array(value.entries, 'V3_INDEX_INVALID').forEach(entry => {
    exact(entry, ['key', 'refs'], 'V3_INDEX_INVALID');
    text(entry.key, 'V3_INDEX_INVALID');
    const refs = array(entry.refs, 'V3_INDEX_INVALID');
    if (!refs.length) fail('V3_INDEX_INVALID');
    refs.forEach(ref => {
      exact(ref, ['recordType', 'recordId', 'itemId'], 'V3_INDEX_INVALID');
      text(ref.recordType, 'V3_INDEX_INVALID'); text(ref.recordId, 'V3_INDEX_INVALID');
      if (ref.itemId !== null) text(ref.itemId, 'V3_INDEX_INVALID');
    });
  });
  if (value.entryCount !== value.entries.length) fail('V3_INDEX_INVALID');
  fingerprint(value.contentFingerprint, 'V3_INDEX_INVALID');
  return Object.freeze(value);
}

export function validateFoundationRecord(value, options) {
  return ({ root: validateFoundationRoot, floor: validateFoundationFloor, run: validateFoundationRun, checkpoint: validateFoundationCheckpoint, index: validateFoundationIndex }[value?.recordType] ?? (() => fail('V3_RECORD_TYPE_INVALID')))(value, options);
}

function equalList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const indexContentFingerprint = async record => `sha256:${await sha256(JSON.stringify([record.kind, record.shard, record.entries]))}`;
const indexRecordKey = record => `v3-index-${record.kind}-${record.shard}-${record.id}`;
const shardParts = shard => {
  const match = /^([0-9a-f]{2})-(\d+)$/.exec(shard);
  return match ? { prefix: match[1], overflow: Number(match[2]) } : null;
};

export async function validateFoundationGraph({ root = null, checkpoint, run = null, floors = [], indexes = [], indexKeys = [], entityIds = [], allowMissingIndexes = false, allowLegacySnapshot = false } = {}) {
  const chatId = root?.chatId ?? checkpoint?.chatId;
  const safeRoot = root ? validateFoundationRoot(root, { expectedChatId: chatId }) : null;
  const safeCheckpoint = validateFoundationCheckpoint(checkpoint, { expectedChatId: chatId });
  const safeRun = run ? validateFoundationRun(run, { expectedChatId: chatId }) : null;
  const safeFloors = await Promise.all(floors.map(floor => validateFoundationFloorContent(floor, { expectedChatId: chatId })));
  const safeIndexes = indexes.map(index => validateFoundationIndex(index, { expectedChatId: chatId }));
  const floorIds = safeFloors.map(floor => floor.id);
  const floorIdSet = new Set(floorIds);
  const entityIdSet = new Set(entityIds);
  const floorById = new Map(safeFloors.map(floor => [floor.id, floor]));
  const legacySnapshot = safeCheckpoint.sourceSnapshotFingerprint === null
    || (safeRun && safeRun.inputSnapshotFingerprint === null)
    || (safeRoot && safeRoot.sourceSnapshotFingerprint === null);
  if (legacySnapshot && !allowLegacySnapshot) fail('V3_GRAPH_SOURCE_SNAPSHOT_MISSING');

  if (safeRoot && (safeRoot.headCheckpointId !== safeCheckpoint.id
    || safeRoot.narrativeGeneration !== safeCheckpoint.narrativeGeneration
    || (!legacySnapshot && safeRoot.sourceSnapshotFingerprint !== safeCheckpoint.sourceSnapshotFingerprint))) fail('V3_GRAPH_ROOT_MISMATCH');
  if (safeRun && (safeRun.id !== safeCheckpoint.runId
    || safeRun.narrativeGeneration !== safeCheckpoint.narrativeGeneration
    || (!legacySnapshot && safeRun.parentCheckpointId !== safeCheckpoint.parentCheckpointId)
    || (!legacySnapshot && safeRun.inputSnapshotFingerprint !== safeCheckpoint.sourceSnapshotFingerprint))) fail('V3_GRAPH_RUN_MISMATCH');
  if (!equalList(safeCheckpoint.floorRange.floorIds, floorIds)
    || safeCheckpoint.floorRange.toAssistantSeq !== safeFloors.length
    || safeCheckpoint.floorRange.fromAssistantSeq !== (safeFloors.length ? 1 : 0)) fail('V3_GRAPH_FLOOR_RANGE_INVALID');
  if (safeCheckpoint.inputFingerprints.length !== safeFloors.length) fail('V3_GRAPH_FINGERPRINT_LIST_INVALID');
  for (let index = 0; index < safeFloors.length; index += 1) {
    const floor = safeFloors[index];
    const input = safeCheckpoint.inputFingerprints[index];
    if (floor.assistantSeq !== index + 1
      || floor.predecessorFloorId !== (safeFloors[index - 1]?.id ?? null)) fail('V3_GRAPH_FLOOR_ORDER_INVALID');
    if (input.floorId !== floor.id || input.canonicalFingerprint !== floor.content.canonicalFingerprint) fail('V3_GRAPH_FINGERPRINT_LIST_INVALID');
  }
  const expectedStateFingerprint = `sha256:${await sha256(JSON.stringify([
    safeCheckpoint.narrativeGeneration,
    floorIds,
    safeFloors.map(floor => floor.content.canonicalFingerprint),
  ]))}`;
  if (safeCheckpoint.validation.stateFingerprint !== expectedStateFingerprint) fail('V3_GRAPH_STATE_FINGERPRINT_INVALID');
  if (safeRoot) {
    const boundary = safeFloors.at(-1) ?? null;
    if (safeRoot.stableBoundary.assistantSeq !== safeFloors.length
      || safeRoot.stableBoundary.floorId !== (boundary?.id ?? null)
      || safeRoot.stableBoundary.canonicalFingerprint !== (boundary?.content.canonicalFingerprint ?? null)) fail('V3_GRAPH_BOUNDARY_INVALID');
  }

  const expectedIndexKeys = safeCheckpoint.producedRefs.indexes;
  if (!allowMissingIndexes && !equalList(indexKeys, expectedIndexKeys)) fail('V3_GRAPH_INDEX_LIST_INVALID');
  if (indexKeys.some(key => !expectedIndexKeys.includes(key))) fail('V3_GRAPH_INDEX_LIST_INVALID');
  const floorOrderRefs = new Map();
  const floorOrderSequence = [];
  const reverseRefs = new Map();
  const rawRefs = new Map();
  const canonicalRefs = new Map();
  const entityRefs = new Set();
  const routedShardSizes = new Map();
  for (let index = 0; index < safeIndexes.length; index += 1) {
    const record = safeIndexes[index];
    const recordKey = indexKeys[index];
    if (record.sourceCheckpointId !== safeCheckpoint.id || record.narrativeGeneration !== safeCheckpoint.narrativeGeneration) fail('V3_GRAPH_INDEX_CHECKPOINT_INVALID');
    if (recordKey !== indexRecordKey(record)) fail('V3_GRAPH_INDEX_ROUTE_INVALID');
    if (record.id !== await deterministicUuid(['index', record.sourceCheckpointId, record.kind, record.shard, record.entries])) fail('V3_GRAPH_INDEX_ROUTE_INVALID');
    if (record.contentFingerprint !== await indexContentFingerprint(record)) fail('V3_GRAPH_INDEX_FINGERPRINT_INVALID');
    if (record.entryCount > 512) fail('V3_GRAPH_INDEX_SHARD_INVALID');
    const routed = record.kind === 'floorOrder' ? null : shardParts(record.shard);
    const legacyReverseShard = legacySnapshot && allowLegacySnapshot && record.kind === 'reverseRef' && /^\d+$/.test(record.shard);
    if (record.kind !== 'floorOrder' && !routed && !legacyReverseShard) fail('V3_GRAPH_INDEX_SHARD_INVALID');
    if (routed) {
      const routeKey = `${record.kind}:${routed.prefix}`;
      const sizes = routedShardSizes.get(routeKey) ?? new Map();
      if (sizes.has(routed.overflow)) fail('V3_GRAPH_INDEX_SHARD_INVALID');
      sizes.set(routed.overflow, record.entryCount);
      routedShardSizes.set(routeKey, sizes);
    }
    for (const entry of record.entries) {
      if (record.kind === 'reverseRef') {
        if (!floorIdSet.has(entry.key)) fail('V3_GRAPH_INDEX_REF_INVALID');
        if (!legacyReverseShard && routed.prefix !== await reverseRefShardPrefix(entry.key)) fail('V3_GRAPH_INDEX_SHARD_INVALID');
      }
      if (record.kind === 'floorOrder') {
        const assistantSeq = Number(entry.key);
        if (!Number.isSafeInteger(assistantSeq) || assistantSeq < 1
          || record.shard !== String(Math.floor((assistantSeq - 1) / 128))) fail('V3_GRAPH_FLOOR_ORDER_INDEX_INVALID');
      }
      if (record.kind === 'fingerprint') {
        fingerprint(entry.key, 'V3_GRAPH_FINGERPRINT_INDEX_INVALID');
        if (routed.prefix !== entry.key.slice('sha256:'.length, 'sha256:'.length + 2)) fail('V3_GRAPH_INDEX_SHARD_INVALID');
      }
      if (record.kind === 'entity') {
        fingerprint(entry.key, 'V3_GRAPH_ENTITY_INDEX_INVALID');
        if (routed.prefix !== entry.key.slice('sha256:'.length, 'sha256:'.length + 2)) fail('V3_GRAPH_INDEX_SHARD_INVALID');
      }
      for (const ref of entry.refs) {
        if (record.kind === 'reverseRef') {
          if (ref.recordType !== 'checkpoint' || ref.recordId !== safeCheckpoint.id || ref.itemId !== null) fail('V3_GRAPH_INDEX_REF_INVALID');
          if (reverseRefs.has(entry.key)) fail('V3_GRAPH_INDEX_COVERAGE_INVALID');
          reverseRefs.set(entry.key, ref.recordId);
          continue;
        }
        if (record.kind === 'entity') {
          if (ref.recordType !== 'entity' || !entityIdSet.has(ref.recordId) || ref.itemId !== null) fail('V3_GRAPH_INDEX_REF_INVALID');
          entityRefs.add(ref.recordId);
          continue;
        }
        if (ref.recordType !== 'floor' || !floorIdSet.has(ref.recordId)) fail('V3_GRAPH_INDEX_REF_INVALID');
        const floor = floorById.get(ref.recordId);
        if (record.kind === 'floorOrder') {
          if (entry.key !== String(floor.assistantSeq) || floorOrderRefs.has(floor.id)) fail('V3_GRAPH_FLOOR_ORDER_INDEX_INVALID');
          let locator;
          try { locator = JSON.parse(ref.itemId); } catch { fail('V3_GRAPH_FLOOR_ORDER_INDEX_INVALID'); }
          exact(locator, ['messageIndex', 'swipeId', 'selectedSwipeIndex'], 'V3_GRAPH_FLOOR_ORDER_INDEX_INVALID');
          integer(locator.messageIndex, 'V3_GRAPH_FLOOR_ORDER_INDEX_INVALID');
          if (locator.swipeId !== null && !['string', 'number'].includes(typeof locator.swipeId)) fail('V3_GRAPH_FLOOR_ORDER_INDEX_INVALID');
          if (locator.selectedSwipeIndex !== null) integer(locator.selectedSwipeIndex, 'V3_GRAPH_FLOOR_ORDER_INDEX_INVALID');
          floorOrderRefs.set(floor.id, entry.key);
          floorOrderSequence.push(floor.assistantSeq);
        }
        if (record.kind === 'fingerprint') {
          const expected = ref.itemId === 'canonical' ? floor.content.canonicalFingerprint : null;
          if (ref.itemId === 'canonical' && entry.key !== expected) fail('V3_GRAPH_FINGERPRINT_INDEX_INVALID');
          if (!['canonical', 'raw'].includes(ref.itemId)) fail('V3_GRAPH_FINGERPRINT_INDEX_INVALID');
          // FloorRecord is immutable. A raw-only/locator-only host edit is audited in the
          // checkpoint-scoped index snapshot, while canonical identity keeps the old floorId.
          const target = ref.itemId === 'canonical' ? canonicalRefs : rawRefs;
          if (target.has(floor.id)) fail('V3_GRAPH_INDEX_COVERAGE_INVALID');
          target.set(floor.id, entry.key);
        }
      }
    }
  }
  if (!allowMissingIndexes) {
    for (const sizes of routedShardSizes.values()) {
      const suffixes = [...sizes.keys()].sort((left, right) => left - right);
      if (suffixes.some((value, index) => value !== index)) fail('V3_GRAPH_INDEX_SHARD_INVALID');
      for (let index = 0; index < suffixes.length - 1; index += 1) {
        if (sizes.get(suffixes[index]) !== 512) fail('V3_GRAPH_INDEX_SHARD_INVALID');
      }
    }
  }
  if (!allowMissingIndexes && safeFloors.length && (
    floorOrderRefs.size !== safeFloors.length
    || reverseRefs.size !== safeFloors.length
    || canonicalRefs.size !== safeFloors.length
    || rawRefs.size !== safeFloors.length
  )) fail('V3_GRAPH_INDEX_COVERAGE_INVALID');
  if (!allowMissingIndexes && entityIdSet.size && entityRefs.size !== entityIdSet.size) fail('V3_GRAPH_ENTITY_INDEX_INVALID');
  if (!allowMissingIndexes && floorOrderSequence.some((value, index) => value !== index + 1)) fail('V3_GRAPH_FLOOR_ORDER_INDEX_INVALID');
  if (safeRoot) {
    const manifestKinds = Object.keys(safeRoot.indexManifest);
    const expectedManifest = Object.fromEntries(manifestKinds.map(kind => [kind, []]));
    for (let index = 0; index < safeIndexes.length; index += 1) {
      const record = safeIndexes[index];
      const bucket = record.kind === 'reverseRef' ? 'reverseRef'
        : record.kind === 'entity' ? 'entity' : 'floor';
      expectedManifest[bucket].push(indexKeys[index]);
    }
    const allManifestKeys = manifestKinds.flatMap(kind => safeRoot.indexManifest[kind]);
    if (new Set(allManifestKeys).size !== allManifestKeys.length) fail('V3_GRAPH_ROOT_INDEX_MANIFEST_INVALID');
    const legacyReseal = legacySnapshot && allowLegacySnapshot;
    const projectedRead = allowMissingIndexes && !legacyReseal;
    for (const kind of manifestKinds) {
      const actual = safeRoot.indexManifest[kind];
      const expected = expectedManifest[kind];
      if (projectedRead) {
        const inferredBucket = key => String(key).startsWith('v3-index-reverseRef-') ? 'reverseRef'
          : String(key).startsWith('v3-index-entity-') ? 'entity'
            : String(key).startsWith('v3-index-floorOrder-') || String(key).startsWith('v3-index-fingerprint-') ? 'floor'
              : null;
        if (actual.some(key => !expectedIndexKeys.includes(key) || inferredBucket(key) !== kind)
          || expected.some(key => !actual.includes(key))) fail('V3_GRAPH_ROOT_INDEX_MANIFEST_INVALID');
        continue;
      }
      if (legacyReseal) {
        const inferredBucket = key => String(key).startsWith('v3-index-reverseRef-') ? 'reverseRef'
          : String(key).startsWith('v3-index-floorOrder-') || String(key).startsWith('v3-index-fingerprint-') ? 'floor'
            : null;
        if (actual.some(key => !expected.includes(key)
          && !(allowMissingIndexes && expectedIndexKeys.includes(key) && inferredBucket(key) === kind))) {
          fail('V3_GRAPH_ROOT_INDEX_MANIFEST_INVALID');
        }
        continue;
      }
      if (actual.length !== expected.length
        || actual.some(key => !expected.includes(key))
        || expected.some(key => !actual.includes(key))) fail('V3_GRAPH_ROOT_INDEX_MANIFEST_INVALID');
    }
  }
  return Object.freeze({ schemaValid: true, referencesValid: true, orderedReplayValid: true });
}
