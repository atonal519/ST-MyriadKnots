import { buildEntityIdentityDirectory, deriveUserIdentityProjection, projectFloorMemoryIdentityReferences, resolveIdentityEntityId } from './entity-identity.js';
import { selectRecallMemories } from './recall-source.js';
import { memorySourceFloorIds } from './memory-schema.js';
import { migrationPartition } from './migration-prefix.js';
import { isMemoryExcludedFloor } from './memory-exclusion.js';
import { projectPlaceFeatures } from './spatial-domain.js';
import { applyPlaceSnapshot, filterPlaceMemory } from './place-workspace.js';

const frozen = values => Object.freeze(values.map(value => Object.freeze(value)));
const unknownPosition = () => Object.freeze({ status: 'unknown', placeEntityId: null, mapRootEntityId: null, isCurrent: false, sourceAssistantSeq: null });

// Presentation-only projection of the current reachable graph; it never reads or saves records.
export function projectQianchuangSnapshot(source, { identityProjection = null, throughAssistantSeq = Infinity } = {}) {
  const empty = { status: 'unavailable', chatId: null, narrativeGeneration: null, rootRevision: null, stableThroughAssistantSeq: 0,
    summarizedThroughAssistantSeq: 0, places: Object.freeze([]), containments: Object.freeze([]), mapRootIds: Object.freeze([]), unassignedPlaceIds: Object.freeze([]), userPosition: unknownPosition() };
  if (!source?.root || source.status && source.status !== 'ready') return Object.freeze(empty);
  if(Number.isFinite(throughAssistantSeq)&&identityProjection?.placeWorkspace?.foundation)identityProjection={...identityProjection,placeWorkspace:{...identityProjection.placeWorkspace,foundation:undefined}};
  const floors = (source.floors ?? []).filter(floor => Number.isSafeInteger(floor.assistantSeq) && floor.assistantSeq > 0 && floor.assistantSeq <= throughAssistantSeq);
  const seqById = new Map(floors.map(floor => [floor.id, floor.assistantSeq])), prefixIds = new Set(seqById.keys());
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
  for (const memory of projected) for (const item of memory.spatialFacts?.relations ?? []) {
    const sourceOrigin = origin(item);
    if (!sourceOrigin || !byId.has(item.placeEntityId) || item.referencePlaceEntityIds.some(id => !byId.has(id))) continue;
    const key = JSON.stringify([item.placeEntityId, item.kind, item.referencePlaceEntityIds, item.text]), prior = relationRows.get(key);
    if (!prior || prior.sourceAssistantSeq < sourceOrigin.sourceAssistantSeq) relationRows.set(key, { entityId: item.placeEntityId, itemId: item.itemId,
      kind: item.kind, text: item.text, referencePlaceEntityIds: Object.freeze([...item.referencePlaceEntityIds]), ...sourceOrigin });
  }
  for (const { entityId, ...row } of relationRows.values()) byId.get(entityId).relations.push(row);

  // Read canonical raw parent intents so a newer ambiguity cannot revive an older parent.
  const latestParents = new Map();
  for (const memory of memories.map(value => filterPlaceMemory(value, projection.placeWorkspace))) for (const edge of memory.spatialFacts?.containments ?? []) {
    const placeEntityId = resolveIdentityEntityId(edge.placeEntityId, projection), parentEntityId = resolveIdentityEntityId(edge.parentEntityId, projection), sourceOrigin = origin(edge);
    if (!sourceOrigin || !byId.has(placeEntityId)) continue;
    const prior = latestParents.get(placeEntityId), seq = sourceOrigin.sourceAssistantSeq;
    if (!prior || seq > prior.seq) latestParents.set(placeEntityId, { seq, parents: new Map([[parentEntityId, sourceOrigin]]) });
    else if (seq === prior.seq) prior.parents.set(parentEntityId, sourceOrigin);
  }
  const parents = new Map([...latestParents].filter(([id, value]) => value.parents.size === 1 && !value.parents.has(id) && byId.has([...value.parents.keys()][0]))
    .map(([id, value]) => [id, [...value.parents.keys()][0]]));
  const cyclic = new Set();
  for (const start of parents.keys()) {
    const path = [], seen = new Set(); let id = start;
    while (parents.has(id)) {
      if (seen.has(id)) { path.forEach(value => cyclic.add(value)); break; }
      seen.add(id); path.push(id); id = parents.get(id);
    }
  }
  for (const id of cyclic) parents.delete(id);
  const containments = [];
  for (const [child, parent] of parents) {
    byId.get(child).parentEntityId = parent; byId.get(parent).childEntityIds.push(child);
    containments.push({ placeEntityId: child, parentEntityId: parent, ...latestParents.get(child).parents.get(parent) });
  }
  const mapRootIds = places.filter(place => !place.parentEntityId && place.childEntityIds.length).map(place => place.entityId);
  const rootFor = id => {
    let current = byId.get(id); if (!current) return null;
    while (current.parentEntityId) current = byId.get(current.parentEntityId);
    return current.childEntityIds.length ? current.entityId : null;
  };
  for (const place of places) place.mapRootEntityId = rootFor(place.entityId);
  const unassignedPlaceIds = places.filter(place => !place.mapRootEntityId).map(place => place.entityId);

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
      const value = [...candidates.values()][0], mapRootEntityId = value.status === 'leftUnknown' ? null : rootFor(value.placeEntityId);
      if (value.status === 'leftUnknown' || value.placeEntityId) userPosition = Object.freeze({ ...value, mapRootEntityId,
        atSummarizedEnd: value.sourceAssistantSeq === summarizedThroughAssistantSeq,
        isCurrent: value.status === 'confirmed' && value.sourceAssistantSeq === summarizedThroughAssistantSeq && Boolean(mapRootEntityId) });
    }
  }
  return applyPlaceSnapshot(Object.freeze({ status: 'ready', chatId: source.root.chatId, narrativeGeneration: source.root.narrativeGeneration, rootRevision: source.rootRevision ?? null,
    stableThroughAssistantSeq: Math.max(0, ...floors.map(floor => floor.assistantSeq)), summarizedThroughAssistantSeq,
    places: frozen(places.map(place => ({ ...place, childEntityIds: Object.freeze(place.childEntityIds), features: frozen(place.features), relations: frozen(place.relations) }))),
    containments: frozen(containments), mapRootIds: Object.freeze(mapRootIds), unassignedPlaceIds: Object.freeze(unassignedPlaceIds), userPosition }), projection.placeWorkspace, { floorOrder: seqById, memories: projected });
}
