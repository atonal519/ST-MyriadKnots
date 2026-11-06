import { manualPlaceFacts } from './place-workspace.js';
import { projectPlaceParentLinks } from './place-foundation.js';
import { identityLabelKey } from './entity-identity.js';
const GENERIC_PLACE_ALIAS_KEYS = new Set(['房间', '卧室', '客厅', '厨房', '浴室', '卫生间', '起居室', '走廊', '宿舍', '我的房间']);
export const isGenericPlaceAlias = label => GENERIC_PLACE_ALIAS_KEYS.has(identityLabelKey(label));
// Current facilities are a projection of source-owned facts, never a second place store.
const refsFor = item => item.evidenceRefs ?? item.sourceRefs ?? [];
const memoryId = memory => memory.id ?? memory.floorMemoryId;
function projectPlaceFacts({ floorMemories = [], floors = [], throughAssistantSeq = Infinity, includeEmpty = false } = {},field) {
  if (!floorMemories.some(memory => memory.spatialFacts?.[field]?.some(feature => field!=='features'||feature.kind === 'stable'))) return Object.freeze([]);
  const seqById = new Map(floors.map(floor => [floor.id ?? floor.floorId, floor.assistantSeq]));
  for (const memory of floorMemories) if (!seqById.has(memory.floorId)) seqById.set(memory.floorId, memory.assistantSeq);
  for (const memory of floorMemories) for (const feature of memory.spatialFacts?.[field] ?? []) for (const ref of refsFor(feature)) {
    if (!seqById.has(ref.floorId) && Number.isSafeInteger(ref.assistantSeq)) seqById.set(ref.floorId, ref.assistantSeq);
  }
  const rows = [];
  for (const memory of floorMemories) {
    if (memory.recordStatus && memory.recordStatus !== 'active') continue;
    for (const feature of memory.spatialFacts?.[field] ?? []) {
      if (field==='features'&&feature.kind !== 'stable') continue;
      if(feature.source){const available=feature.source.knownFromAssistantSeq??seqById.get(feature.source.knownFromFloorId??memory.floorId)??memory.assistantSeq;if(!Number.isSafeInteger(available)||available>throughAssistantSeq)continue;}
      const evidence = refsFor(feature).filter(ref => Number.isSafeInteger(seqById.get(ref.floorId)) && seqById.get(ref.floorId) <= throughAssistantSeq);
      if (!evidence.length) continue;
      const latest = evidence.reduce((left, right) => seqById.get(left.floorId) > seqById.get(right.floorId) ? left : right);
      const sourceTime = (memory.chronology ?? []).filter(item => !item.evidenceRefs?.length || item.evidenceRefs.some(ref => ref.floorId === latest.floorId))
        .map(item => item.time?.sourceText || item.time?.normalized || item.description).filter(Boolean).join('；');
      rows.push({ ...feature, floorId: latest.floorId, floorMemoryId: memoryId(memory), carrierFloorId: memory.floorId, carrierAssistantSeq: memory.assistantSeq ?? seqById.get(memory.floorId), assistantSeq: seqById.get(latest.floorId), sourceTime,
        evidenceRefs: evidence, sourceRefs: evidence, order: rows.length });
    }
  }
  rows.sort((a, b) => a.assistantSeq - b.assistantSeq || a.order - b.order);
  const byId = new Map(rows.map(row => [row.itemId, row])), replaced = new Set();
  for (const row of rows) for (const id of [...(row.replacesItemIds??[]),...(row.source?.replacesItemIds??[])]) {
    const prior = byId.get(id);
    if (prior && prior.placeEntityId === row.placeEntityId && (prior.assistantSeq < row.assistantSeq || prior.assistantSeq === row.assistantSeq && prior.order < row.order)) replaced.add(id);
  }
  return Object.freeze(rows.filter(row => !replaced.has(row.itemId)&&(row.text||includeEmpty)).map(({ order, ...row }) => Object.freeze(row)));
}

export const projectPlaceFeatures=options=>projectPlaceFacts(options,'features');
export const projectPlaceRelations=options=>projectPlaceFacts(options,'relations');

// Only the latest explicit scene can supply an unmentioned current place.
export function currentPlaceEntityIds(floorMemories = [], throughAssistantSeq = Infinity, floors = [], placeWorkspace = null) {
  const seqById = new Map(floors.map(floor => [floor.id, floor.assistantSeq]));
  const rows = [];
  for (const memory of floorMemories) {
    if (memory.recordStatus && memory.recordStatus !== 'active') continue;
    for (const kind of ['positions', 'locations']) for (const item of kind === 'positions' ? memory.spatialFacts?.positions ?? [] : memory.locations ?? []) {
      if (kind === 'locations' && item.change === 'mentioned') continue;
      const refs = refsFor(item);
      const seq = refs.length ? Math.max(...refs.map(ref => ref.assistantSeq ?? seqById.get(ref.floorId) ?? (ref.floorId === memory.floorId ? memory.assistantSeq : 0))) : memory.assistantSeq ?? seqById.get(memory.floorId);
      if (Number.isSafeInteger(seq) && seq > 0 && seq <= throughAssistantSeq) rows.push({ item, kind, seq });
    }
  }
  const latest = Math.max(0, ...rows.map(row => row.seq));
  const atEnd = rows.filter(row => row.seq === latest), positions = atEnd.filter(row => row.kind === 'positions');
  return expandPlaceParents(new Set((positions.length ? positions.filter(row => row.item.status === 'confirmed').map(row => row.item.placeEntityId)
    : atEnd.filter(row => ['present', 'entered'].includes(row.item.change)).map(row => row.item.entityId)).filter(Boolean)), floorMemories, throughAssistantSeq, floors, placeWorkspace);
}


export function placeSourceLocationReference(memory, sourceFloorId = memory.floorId) {
  if (Array.isArray(memory.sourceFloorSnapshots)) return memory.sourceFloorSnapshots.find(snapshot => snapshot.floorId === sourceFloorId)?.locationReference ?? [];
  if (Array.isArray(memory.locationReferences)) return memory.locationReferences.filter(ref => ref.sourceFloorId === sourceFloorId).map(ref => ref.text);
  return sourceFloorId === memory.floorId ? memory.sourceLocationReference ?? [] : [];
}

// Ownership is source-bounded identity context; locatedIn does not become a physical containment.
export function projectPlaceOwnership(floorMemories = [], throughAssistantSeq = Infinity, floors = [], placeWorkspace = null, libraryThroughAssistantSeq = throughAssistantSeq) {
  const seqById = new Map(floors.map(floor => [floor.id ?? floor.floorId, floor.assistantSeq]));
  const latest = projectPlaceParentLinks(floorMemories, placeWorkspace, seqById, throughAssistantSeq, libraryThroughAssistantSeq, { includeLocatedIn: true });
  const result = new Map([...latest].filter(([,value])=>!value.cleared).map(([id,value]) => [id,new Set(value.parents.keys())]));
  const unresolved = new Set();
  for (const [id, parents] of result) {
    const visited = new Set([id]); let next = parents;
    while (next?.size === 1) {
      const parent = next.values().next().value;
      if (visited.has(parent)) { visited.forEach(value => unresolved.add(value)); break; }
      visited.add(parent); next = result.get(parent);
    }
  }
  for (const id of unresolved) result.set(id, new Set());
  return result;
}

export function expandPlaceParents(placeIds, floorMemories, throughAssistantSeq = Infinity, floors = [], placeWorkspace = null) {
  const seqById = new Map(floors.map(floor => [floor.id, floor.assistantSeq]));
  const latestParents = projectPlaceParentLinks(floorMemories, placeWorkspace, seqById, throughAssistantSeq);
  const result = new Set(placeIds);
  for (const id of result) {
    const parents = latestParents.get(id)?.parents;
    if (parents?.size === 1) result.add(parents.keys().next().value);
  }
  return result;
}
