import { buildEntityIdentityDirectory, deriveUserIdentityProjection, projectFloorMemoryIdentityReferences, resolveIdentityEntityId } from './entity-identity.js';
import { selectRecallMemories } from './recall-source.js';
import { memorySourceFloorIds } from './memory-schema.js';
import { migrationPartition } from './migration-prefix.js';
import { isMemoryExcludedFloor } from './memory-exclusion.js';
import { projectPlaceFeatures, projectPlaceRelations } from './spatial-domain.js';
import { applyPlaceSnapshot, filterPlaceMemory, placeWorkspaceForPrefix } from './place-workspace.js';
import { coveredPlaceItemIds } from './place-foundation.js';

const frozen = values => Object.freeze(values.map(value => Object.freeze(value)));
const unknownPosition = () => Object.freeze({ status: 'unknown', placeEntityId: null, mapRootEntityId: null, isCurrent: false, sourceAssistantSeq: null });

// Presentation-only projection of the current reachable graph; it never reads or saves records.
export function projectQianchuangSnapshot(source, { identityProjection = null, throughAssistantSeq = Infinity } = {}) {
  const empty = { status: 'unavailable', chatId: null, narrativeGeneration: null, rootRevision: null, stableThroughAssistantSeq: 0,
    summarizedThroughAssistantSeq: 0, places: Object.freeze([]), containments: Object.freeze([]), mapRootIds: Object.freeze([]), unassignedPlaceIds: Object.freeze([]), userPosition: unknownPosition() };
  if (!source?.root || source.status && source.status !== 'ready') return Object.freeze(empty);
  const floors = (source.floors ?? []).filter(floor => Number.isSafeInteger(floor.assistantSeq) && floor.assistantSeq > 0 && floor.assistantSeq <= throughAssistantSeq);
  const seqById = new Map(floors.map(floor => [floor.id, floor.assistantSeq])), prefixIds = new Set(seqById.keys());
  if(Number.isFinite(throughAssistantSeq)&&identityProjection?.placeWorkspace)identityProjection={...identityProjection,placeWorkspace:{...placeWorkspaceForPrefix(identityProjection.placeWorkspace,prefixIds),foundation:undefined}};
  const partition = migrationPartition(source);
  const eligibleIds = new Set(floors.filter(floor => !isMemoryExcludedFloor(floor, null, source.checkpoint, { frozen: partition.isFrozenFloor(floor.id) })).map(floor => floor.id));
  const refs = item => (item.evidenceRefs ?? []).filter(ref => eligibleIds.has(ref.floorId));
  const origin = item => {
    const evidence = refs(item); if (!evidence.length) return null;
    const latest = evidence.reduce((a, b) => seqById.get(a.floorId) >= seqById.get(b.floorId) ? a : b);
    return { sourceFloorId: latest.floorId, sourceAssistantSeq: seqById.get(latest.floorId) };
  };
  const memories = selectRecallMemories(source).activeMemories.filter(memory => memorySourceFloorIds(memory).some(id => eligibleIds.has(id)));
  const knownSourceIds = new Set(memories.flatMap(memory => memorySourceFloorIds(memory).filter(id => eligibleIds.has(id))));
  const summarizedThroughAssistantSeq = Math.max(0, ...[...knownSourceIds].map(id => seqById.get(id)));
  const foundationRedirects = Object.fromEntries((source.entities ?? []).filter(entity => entity.status === 'merged'
    && (entity.recordStatus === undefined || entity.recordStatus === 'active') && entity.mergedIntoEntityId).map(entity => [entity.id, entity.mergedIntoEntityId]));
  const projection = deriveUserIdentityProjection({ ...source, floors, identityProjection: { ...(identityProjection ?? {}),
    identityRedirectsByEntityId: { ...foundationRedirects, ...(identityProjection?.identityRedirectsByEntityId ?? {}) } } });
  const projected = memories.map(memory => {
    const value = projectFloorMemoryIdentityReferences(memory, projection);
    if (!value.spatialFacts) return value;
    const spatialFacts = Object.fromEntries(['containments', 'positions', 'features', 'relations'].map(field => [field,
      (value.spatialFacts[field] ?? []).flatMap(item => { const evidenceRefs = refs(item); return evidenceRefs.length ? [{ ...item, evidenceRefs }] : []; })]));
    return { ...value, spatialFacts };
  });
  const mentionedIds = new Set();
  for (const memory of projected) {
    for (const location of memory.locations ?? []) if (origin(location) && location.entityId) mentionedIds.add(location.entityId);
    for (const edge of memory.spatialFacts?.containments ?? []) { mentionedIds.add(edge.placeEntityId); mentionedIds.add(edge.parentEntityId); }
    for (const item of [...(memory.spatialFacts?.features ?? []), ...(memory.spatialFacts?.positions ?? []), ...(memory.spatialFacts?.relations ?? [])]) {
      if (item.placeEntityId) mentionedIds.add(item.placeEntityId);
      for (const id of item.referencePlaceEntityIds ?? []) mentionedIds.add(id);
    }
  }
  const directory = buildEntityIdentityDirectory({ entities: source.entities ?? [], floorIds: prefixIds, floorOrder: seqById, identityProjection: projection });
  const places = directory.filter(entry => entry.entityType === 'place' && (entry.entity.firstSeenFloorId === null
    || knownSourceIds.has(entry.entity.firstSeenFloorId) || mentionedIds.has(entry.entityId))).map(entry => ({ entityId: entry.entityId,
    displayName: entry.displayName, aliases: Object.freeze([...entry.aliases]), parentEntityId: null, childEntityIds: [], mapRootEntityId: null,
    firstSeenAssistantSeq: seqById.get(entry.entity.firstSeenFloorId) ?? 0, features: [], relations: [] }));
  const byId = new Map(places.map(place => [place.entityId, place]));
  for (const feature of projectPlaceFeatures({ floorMemories: projected, floors, throughAssistantSeq })) {
    const place = byId.get(feature.placeEntityId);
    if (place) place.features.push({ itemId: feature.itemId, text: feature.text, sourceFloorId: feature.floorId, sourceAssistantSeq: feature.assistantSeq });
  }
  const relationRows = new Map();
  for (const item of projectPlaceRelations({floorMemories:projected,floors,throughAssistantSeq})) {
    if(coveredPlaceItemIds(projection.placeWorkspace,item.placeEntityId,'relation').has(item.itemId))continue;
    const sourceOrigin = origin(item);
    if (!sourceOrigin || !byId.has(item.placeEntityId) || item.referencePlaceEntityIds.some(id => !byId.has(id))) continue;
    const key = JSON.stringify([item.placeEntityId, item.kind, item.referencePlaceEntityIds, item.text]), prior = relationRows.get(key);
    if (!prior || prior.sourceAssistantSeq < sourceOrigin.sourceAssistantSeq) relationRows.set(key, { entityId: item.placeEntityId, itemId: item.itemId,
      kind: item.kind, text: item.text, referencePlaceEntityIds: Object.freeze([...item.referencePlaceEntityIds]), ...sourceOrigin });
  }
  for (const { entityId, ...row } of relationRows.values()) byId.get(entityId).relations.push(row);

  let userPosition = unknownPosition();
  const userId = projection.userEntityId, userVisible = directory.some(entry => entry.entityId === userId && entry.entityType === 'person');
  if (userVisible) {
    let latestSeq = 0, candidates = new Map();
    for (const memory of memories) for (const item of memory.spatialFacts?.positions ?? []) {
      if (resolveIdentityEntityId(item.subjectEntityId, projection) !== userId) continue;
      const sourceOrigin = origin(item); if (!sourceOrigin || sourceOrigin.sourceAssistantSeq < latestSeq) continue;
      const placeEntityId = item.placeEntityId ? resolveIdentityEntityId(item.placeEntityId, projection) : null;
      if (sourceOrigin.sourceAssistantSeq > latestSeq) { latestSeq = sourceOrigin.sourceAssistantSeq; candidates = new Map(); }
      if (!filterPlaceMemory({ floorId: memory.floorId, spatialFacts: { positions: [item] } }, projection.placeWorkspace).spatialFacts.positions.length) continue;
      candidates.set(JSON.stringify([item.status, placeEntityId]), { status: item.status, placeEntityId: byId.has(placeEntityId) ? placeEntityId : null, ...sourceOrigin });
    }
    if (candidates.size === 1) {
      const value = [...candidates.values()][0], mapRootEntityId = null;
      if (value.status === 'leftUnknown' || value.placeEntityId) userPosition = Object.freeze({ ...value, mapRootEntityId,
        atSummarizedEnd: value.sourceAssistantSeq === summarizedThroughAssistantSeq,
        isCurrent: value.status === 'confirmed' && value.sourceAssistantSeq === summarizedThroughAssistantSeq && Boolean(mapRootEntityId) });
    }
  }
  return applyPlaceSnapshot(Object.freeze({ status: 'ready', chatId: source.root.chatId, narrativeGeneration: source.root.narrativeGeneration, rootRevision: source.rootRevision ?? null,
    stableThroughAssistantSeq: Math.max(0, ...floors.map(floor => floor.assistantSeq)), summarizedThroughAssistantSeq,
    places: frozen(places.map(place => ({ ...place, childEntityIds: Object.freeze(place.childEntityIds), features: frozen(place.features), relations: frozen(place.relations) }))),
    containments: Object.freeze([]), mapRootIds: Object.freeze([]), unassignedPlaceIds: Object.freeze([]), userPosition }), projection.placeWorkspace, { floorOrder: seqById, memories:memories.map(value=>filterPlaceMemory(value,projection.placeWorkspace,id=>resolveIdentityEntityId(id,projection))),resolve:id=>resolveIdentityEntityId(id,projection) });
}
