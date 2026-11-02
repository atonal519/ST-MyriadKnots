import { isUuid } from './identity.js';
import {
  validateFoundationRoot, validateFoundationCheckpoint, validateFoundationRun,
  validateFoundationFloorContent, validateFoundationIndex, validateFoundationGraphReferences,
} from './v3/foundation-schema.js';
import {
  validateFloorMemory, validateEntityRecord, memorySourceFloorIds,
  collectFloorMemoryEntityIds, collectStateDeltaEntityIds,
} from './v3/memory-schema.js';
import { validateBaselineRecord, validateStateDeltaRecord, validateCurrentStateRecord, stateFingerprint } from './v3/cse-schema.js';
import { validateMigrationDescriptor, migrationDescriptorRecordKey } from './v3/migration-prefix.js';

const fail = code => { throw Object.assign(new TypeError(code), { code }); };
const validators = {
  root: validateFoundationRoot, checkpoint: validateFoundationCheckpoint, run: validateFoundationRun,
  floor: validateFoundationFloorContent, index: validateFoundationIndex,
  floorMemory: validateFloorMemory, entity: validateEntityRecord,
  baseline: validateBaselineRecord, stateDelta: validateStateDeltaRecord,
  currentState: validateCurrentStateRecord, migrationDescriptor: validateMigrationDescriptor,
};
const prefixes = {
  root: 'v3-root', checkpoint: 'v3-checkpoint-', run: 'v3-run-', floor: 'v3-floor-', index: 'v3-index-',
  floorMemory: 'v3-floor-memory-', entity: 'v3-entity-', baseline: 'v3-baseline-',
  stateDelta: 'v3-state-delta-', currentState: 'v3-current-state-', migrationDescriptor: 'v3-migration-',
};
const keyFor = value => value.recordType === 'root' ? 'v3-root'
  : value.recordType === 'index' ? `v3-index-${value.kind}-${value.shard}-${value.id}`
    : value.recordType === 'migrationDescriptor' ? migrationDescriptorRecordKey(value.id)
      : `${prefixes[value.recordType]}${value.id}`;
export { keyFor as transferRecordKey };
const floorMetadata = floor => ({ id: floor.id, narrativeGeneration: floor.narrativeGeneration,
  assistantSeq: floor.assistantSeq, predecessorFloorId: floor.predecessorFloorId, hostLocator: floor.hostLocator,
  content: { rawFingerprint: floor.content.rawFingerprint, canonicalFingerprint: floor.content.canonicalFingerprint,
    sanitizerFingerprint: floor.content.sanitizerFingerprint }, stability: floor.stability });

function activeFloors(floors, indexes) {
  const locators = new Map(), sequences = new Map();
  for (const index of indexes) for (const entry of index.entries) for (const ref of entry.refs) {
    if (index.kind !== 'floorOrder' || !ref.itemId) continue;
    try {
      const locator = JSON.parse(ref.itemId);
      if (locator && typeof locator === 'object') { locators.set(ref.recordId, locator); sequences.set(ref.recordId, Number(entry.key)); }
    } catch { /* The shared graph validator rejects an invalid locator below. */ }
  }
  const ordered = [...floors].sort((left, right) => (sequences.get(left.id) ?? left.assistantSeq) - (sequences.get(right.id) ?? right.assistantSeq));
  return ordered.map((floor, index) => ({ ...floor, assistantSeq: sequences.get(floor.id) ?? index + 1,
    predecessorFloorId: ordered[index - 1]?.id ?? null, hostLocator: locators.get(floor.id) ?? floor.hostLocator }));
}

function hasOccurrence(content, quote, wanted) {
  if (typeof content !== 'string') return false;
  let occurrence = 0, offset = -1;
  while ((offset = content.indexOf(quote, offset + 1)) !== -1) if (++occurrence === wanted) return true;
  return false;
}

// Validation retains IDs, ordering and binding metadata; record bodies are read
// on demand, checked in their original form, and released after the current item.
export async function validateTransferGraph({ chatId, recordIds, readRecord, readRecords }) {
  const idList = Array.from(recordIds), ids = new Set(idList), checked = new Set();
  if (ids.size !== idList.length) fail('V3_TRANSFER_RECORD_DUPLICATE');
  async function read(id, type, load = readRecord) {
    if (!ids.has(id)) fail('V3_TRANSFER_RECORD_MISSING');
    const input = await load(id);
    if (!input || input.recordType !== type) fail('V3_TRANSFER_RECORD_TYPE_INVALID');
    const value = await validators[type](input, { expectedChatId: chatId });
    if (keyFor(value) !== id) fail('V3_TRANSFER_RECORD_KEY_INVALID');
    checked.add(id);
    return value;
  }
  async function* readGroup(recordIds, type) {
    if (!recordIds.length) return;
    const typeFor = id => typeof type === 'function' ? type(id) : type;
    if (!readRecords) {
      for (const id of recordIds) yield await read(id, typeFor(id));
      return;
    }
    const missing = recordIds.findIndex(id => !ids.has(id));
    const group = missing < 0 ? recordIds : recordIds.slice(0, missing);
    let position = 0;
    if (group.length) for await (const input of readRecords(group)) {
      if (position >= group.length) fail('V3_TRANSFER_RECORD_KEY_INVALID');
      const id = group[position++];
      yield await read(id, typeFor(id), () => input);
    }
    if (position !== group.length) fail('V3_TRANSFER_RECORD_TYPE_INVALID');
    if (missing >= 0) fail('V3_TRANSFER_RECORD_MISSING');
  }
  const root = await read('v3-root', 'root');
  if (!root.headCheckpointId || root.activeRunId) fail('V3_TRANSFER_GRAPH_NOT_READY');
  const checkpoint = await read(`v3-checkpoint-${root.headCheckpointId}`, 'checkpoint');
  if (checkpoint.narrativeGeneration !== root.narrativeGeneration || !checkpoint.capabilities.foundationReady) fail('V3_STORE_CHECKPOINT_MISMATCH');
  const run = await read(`v3-run-${checkpoint.runId}`, 'run');
  const migrationDescriptor = root.migrationDescriptorId ? await (async () => {
    const descriptor = await read(migrationDescriptorRecordKey(root.migrationDescriptorId), 'migrationDescriptor');
    return { id: descriptor.id, chatId: descriptor.chatId, source: descriptor.source,
      frozenFloorIds: descriptor.frozenFloorIds, floorOrigins: descriptor.floorOrigins, carriedAliases: descriptor.carriedAliases,
      summarySources: descriptor.summarySources, sourceFloorProvenance: descriptor.sourceFloorProvenance, recordRefs: descriptor.recordRefs };
  })() : null;
  const indexes = [];
  for await (const index of readGroup(checkpoint.producedRefs.indexes, 'index')) indexes.push(index);
  const floorMetas = [];
  for await (const floor of readGroup(checkpoint.producedRefs.floors.map(id => `v3-floor-${id}`), 'floor')) floorMetas.push(floorMetadata(floor));
  const floors = activeFloors(floorMetas, indexes), floorsById = new Map(floors.map(floor => [floor.id, floor]));
  const floorOrder = new Map(floors.map((floor, index) => [floor.id, index]));
  const entities = new Map();
  for await (const entity of readGroup(checkpoint.producedRefs.entities.map(id => `v3-entity-${id}`), 'entity')) {
    entities.set(entity.id, { id: entity.id, entityType: entity.entityType, narrativeGeneration: entity.narrativeGeneration,
      firstSeenFloorId: entity.firstSeenFloorId, lastSeenFloorId: entity.lastSeenFloorId });
  }
  await validateFoundationGraphReferences({ root, checkpoint, run, floors, indexes,
    indexKeys: checkpoint.producedRefs.indexes, entityIds: [...entities.keys()], allowLegacySnapshot: true });
  const expectedManifest = Object.fromEntries(Object.keys(root.indexManifest).map(kind => [kind, []]));
  for (let index = 0; index < indexes.length; index++) {
    const kind = indexes[index].kind === 'reverseRef' ? 'reverseRef' : indexes[index].kind === 'entity' ? 'entity' : 'floor';
    expectedManifest[kind].push(checkpoint.producedRefs.indexes[index]);
  }
  if (Object.keys(expectedManifest).some(kind => root.indexManifest[kind].length !== expectedManifest[kind].length
    || root.indexManifest[kind].some(key => !expectedManifest[kind].includes(key)))) fail('V3_TRANSFER_GRAPH_NOT_READY');

  const bounds = new Map();
  const addBound = (floorId, entityId) => {
    if (!floorsById.has(floorId) || !isUuid(entityId)) return;
    const previous = bounds.get(entityId), position = floorOrder.get(floorId);
    bounds.set(entityId, { first: previous && floorOrder.get(previous.first) < position ? previous.first : floorId,
      last: previous && floorOrder.get(previous.last) > position ? previous.last : floorId });
  };
  const requireEntity = id => { if (!entities.has(id)) fail('V3_MEMORY_GRAPH_ENTITY_REF_INVALID'); };
  const seenMemoryFloors = new Set(), activeMemoryFloors = new Set();
  let summaryCount = 0;
  for await (const memory of readGroup(checkpoint.producedRefs.floorMemories.map(id => `v3-floor-memory-${id}`), 'floorMemory')) {
    const floor = floorsById.get(memory.floorId);
    if (!floor || memory.narrativeGeneration !== floor.narrativeGeneration || seenMemoryFloors.has(memory.floorId)) fail('V3_MEMORY_GRAPH_FLOOR_REF_INVALID');
    seenMemoryFloors.add(memory.floorId);
    const sourceIds = memorySourceFloorIds(memory);
    if (sourceIds.some(sourceId => !floorsById.has(sourceId))
      || sourceIds.some((sourceId, index) => index > 0 && floorOrder.get(sourceId) !== floorOrder.get(sourceIds[index - 1]) + 1)) fail('V3_MEMORY_GRAPH_FLOOR_REF_INVALID');
    for (const entityId of collectFloorMemoryEntityIds(memory, { includeReviewCandidates: false })) requireEntity(entityId);
    for (const anchor of memory.exactAnchors) for (const entityId of anchor.knownEntityIds ?? []) {
      if (entities.get(entityId)?.entityType !== 'person') fail('V3_MEMORY_GRAPH_ENTITY_TYPE_INVALID');
    }
    for (const entityId of collectFloorMemoryEntityIds(memory)) addBound(memory.floorId, entityId);
    if (sourceIds.length > 1) {
      const addEvidenceBounds = (evidenceRefs, entityIds) => {
        for (const evidence of evidenceRefs ?? []) for (const entityId of entityIds) addBound(evidence.floorId ?? memory.floorId, entityId);
      };
      for (const evidence of memory.summaryEvidenceRefs) addEvidenceBounds([evidence], [evidence.sourceEntityId]);
      const fields = [['locations', item => [item.entityId, ...(item.participantEntityIds ?? [])]],
        ['participants', item => [item.entityId]], ['actions', item => [item.actorEntityId, ...(item.targetEntityIds ?? [])]],
        ['observations', item => [item.subjectEntityId]], ['informationTransfers', item => [item.fromEntityId, ...(item.toEntityIds ?? [])]],
        ['privateCognition', item => [item.ownerEntityId]], ['commitments', item => [item.speakerEntityId, ...(item.targetEntityIds ?? [])]],
        ['openLoops', item => item.ownerEntityIds ?? []], ['cseSignals', item => [item.subjectEntityId, item.objectEntityId]]];
      for (const [field, idsFor] of fields) for (const item of memory[field]) addEvidenceBounds(item.evidenceRefs, idsFor(item));
      for (const anchor of memory.exactAnchors) addEvidenceBounds([{ floorId: anchor.sourceFloorId ?? memory.floorId }], [anchor.speakerEntityId, ...(anchor.knownEntityIds ?? [])]);
    }
    let sourceFloorId = null, sourceContent = null;
    const sourceFor = async source => {
      const floorId = source?.floorId ?? source?.sourceFloorId ?? memory.floorId;
      const snapshot = memory.sourceFloorSnapshots?.find(item => item.floorId === floorId);
      if (source?.sourceType === 'precedingUser') return snapshot?.sourceUserInputSnapshot?.messages?.[source.sourceSnapshotIndex]?.content
        ?? (floorId === memory.floorId ? memory.sourceUserInputSnapshot?.messages?.[source.sourceSnapshotIndex]?.content : null);
      const captured = snapshot?.canonicalContent ?? (floorId === memory.floorId ? memory.sourceCanonicalContent : null);
      if (captured !== null && captured !== undefined) return captured;
      if (!floorsById.has(floorId)) return null;
      if (sourceFloorId !== floorId) {
        sourceContent = (await read(`v3-floor-${floorId}`, 'floor')).content.canonicalContent;
        sourceFloorId = floorId;
      }
      return sourceContent;
    };
    const evidenceRefs = [...memory.summaryEvidenceRefs];
    for (const field of ['chronology', 'locations', 'participants', 'actions', 'observations', 'informationTransfers', 'privateCognition', 'commitments', 'eventFragments', 'openLoops', 'ambiguities', 'cseSignals']) {
      for (const item of memory[field]) evidenceRefs.push(...(item.evidenceRefs ?? []));
    }
    for (const field of ['containments', 'positions']) for (const item of memory.spatialFacts?.[field] ?? []) evidenceRefs.push(...item.evidenceRefs);
    for (const evidence of evidenceRefs) if (!hasOccurrence(await sourceFor(evidence), evidence.quotedText, evidence.occurrence)) fail('V3_MEMORY_GRAPH_EVIDENCE_INVALID');
    for (const item of memory.spatialFacts?.containments ?? []) {
      if (entities.get(item.placeEntityId)?.entityType !== 'place' || entities.get(item.parentEntityId)?.entityType !== 'place') fail('V3_MEMORY_GRAPH_ENTITY_TYPE_INVALID');
    }
    for (const item of memory.spatialFacts?.positions ?? []) {
      if (!['person', 'group'].includes(entities.get(item.subjectEntityId)?.entityType)
        || (item.placeEntityId && entities.get(item.placeEntityId)?.entityType !== 'place')) fail('V3_MEMORY_GRAPH_ENTITY_TYPE_INVALID');
    }
    for (const anchor of memory.exactAnchors) if (anchor.manual !== true
      && !hasOccurrence(await sourceFor(anchor), anchor.exactText, anchor.occurrence)) fail('V3_MEMORY_GRAPH_ANCHOR_INVALID');
    if (memory.recordStatus === 'active') { activeMemoryFloors.add(memory.floorId); if (memory.summary) summaryCount++; }
  }
  const memoryReady = activeMemoryFloors.size > 0;
  if (checkpoint.capabilities.memoryReady !== memoryReady || root.capabilities.memoryReady !== memoryReady) fail('V3_MEMORY_GRAPH_CAPABILITY_INVALID');
  const baselineId = root.baselineId ? (await read(`v3-baseline-${root.baselineId}`, 'baseline')).id : null;
  const seenDeltaFloors = new Set(), deltaIds = new Set();
  let previousDeltaFloorIndex = -1, stateCount = 0;
  for await (const delta of readGroup(checkpoint.producedRefs.stateDeltas.map(id => `v3-state-delta-${id}`), 'stateDelta')) {
    const position = floorOrder.get(delta.floorId);
    if (position === undefined || position <= previousDeltaFloorIndex) fail('V3_CSE_GRAPH_DELTA_ORDER_INVALID');
    previousDeltaFloorIndex = position;
    if (!baselineId || delta.baselineId !== baselineId || seenDeltaFloors.has(delta.floorId)) fail('V3_CSE_GRAPH_DELTA_REF_INVALID');
    seenDeltaFloors.add(delta.floorId); deltaIds.add(delta.id);
    for (const entityId of collectStateDeltaEntityIds(delta)) if (!entities.has(entityId)) fail('V3_CSE_GRAPH_ENTITY_REF_INVALID');
    for (const subject of delta.subjectSnapshots) {
      addBound(delta.floorId, subject.subjectEntityId);
      for (const item of [...subject.core, ...subject.adaptive, ...subject.situational]) if (item.towardEntityId) addBound(delta.floorId, item.towardEntityId);
    }
    for (const subject of delta.fixedChanges ?? []) {
      addBound(delta.floorId, subject.subjectEntityId);
      for (const change of subject.items) for (const item of [change.before, change.after]) if (item?.towardEntityId) addBound(delta.floorId, item.towardEntityId);
    }
    if (delta.recordStatus === 'active') stateCount++;
  }
  if (checkpoint.producedRefs.currentStates.length > 1) fail('V3_CSE_GRAPH_CURRENT_REF_INVALID');
  for await (const state of readGroup(checkpoint.producedRefs.currentStates.map(id => `v3-current-state-${id}`), 'currentState')) {
    if (!baselineId || state.baselineId !== baselineId || state.appliedDeltaIds.some(deltaId => !deltaIds.has(deltaId))) fail('V3_CSE_GRAPH_CURRENT_REF_INVALID');
    if (state.fingerprint !== await stateFingerprint(state.subjects, state.appliedDeltaIds, state.headFloorId)) fail('V3_CSE_GRAPH_CURRENT_FINGERPRINT_INVALID');
  }
  const cseReady = activeMemoryFloors.size > 0 && [...activeMemoryFloors].every(id => seenDeltaFloors.has(id));
  if (checkpoint.capabilities.cseReady !== cseReady || root.capabilities.cseReady !== cseReady) fail('V3_CSE_GRAPH_CAPABILITY_INVALID');
  for (const entity of entities.values()) {
    const projected = bounds.get(entity.id);
    const firstFloorId = projected?.first ?? ((entity.firstSeenFloorId === null || floorsById.has(entity.firstSeenFloorId))
      && (entity.lastSeenFloorId === null || floorsById.has(entity.lastSeenFloorId)) ? entity.firstSeenFloorId : null);
    const generation = projected ? floorsById.get(projected.first).narrativeGeneration : entity.narrativeGeneration;
    if (firstFloorId && !floorsById.has(firstFloorId)) fail('V3_MEMORY_GRAPH_ENTITY_FLOOR_INVALID');
    if (firstFloorId && generation !== floorsById.get(firstFloorId).narrativeGeneration) fail('V3_MEMORY_GRAPH_ENTITY_GENERATION_INVALID');
  }
  const unvisitedTypes = Object.keys(prefixes).filter(type => type !== 'root').sort((left, right) => prefixes[right].length - prefixes[left].length);
  const unvisitedType = id => id === 'v3-root' ? 'root' : unvisitedTypes.find(candidate => id.startsWith(prefixes[candidate]));
  for await (const value of readGroup([...ids].filter(id => !checked.has(id) && unvisitedType(id)), unvisitedType)) { /* Validate unreferenced core records too. */ }
  return { status: 'ready', root, checkpoint, run, migrationDescriptor, floors, indexes, summaryCount, stateCount };
}
