import { stableJson } from '../memory-transfer-json.js';
import { validateEntityRecord } from './memory-schema.js';
import { isUuid } from '../identity.js';
import { validatePlaceFoundation, effectiveFoundationFacts, filterPlaceFoundationSources, coveredPlaceItemIds, projectPlaceParentLinks } from './place-foundation.js';
import { validQianchuangMapStyle } from '../qianchuang-display-hints.js';

export const PLACE_WORKSPACE_RECORD_ID = 'v3-place-workspace';
const fields = ['name', 'description', 'relations', 'parentEntityId', 'mapLevel', 'mapRole'];
const copy = value => structuredClone(value);
const fail = text => Object.assign(new Error(text), { code: 'QQJ_PLACE_WORKSPACE_INVALID' });
const own = (value, key) => Object.hasOwn(value ?? {}, key);
export const emptyPlaceWorkspace = chatId => ({ schemaVersion: 1, kind: 'qqj-v3-place-workspace', chatId, placesByEntityId: {}, deletionsByEntityId: {} });

export function rehomePlaceWorkspace(value,chatId,narrativeGeneration=null){
  const data={...copy(value),chatId};
  for(const entity of [...Object.values(data.placesByEntityId).flatMap(row=>row.createdEntity?[row.createdEntity]:[]),...(data.foundation?.entities??[])]){
    entity.chatId=chatId;if(narrativeGeneration)entity.narrativeGeneration=narrativeGeneration;
  }
  return data;
}

function latestPlaceLibrary(workspace, sourceEntities, targetFloors) {
  const data = copy(workspace), rows = data.placesByEntityId ?? {};
  const seeds = new Map((data.foundation?.entities ?? []).map(entity => [entity.id, entity]));
  const available = new Map([...sourceEntities, ...seeds.values(), ...Object.values(rows).flatMap(row => row.createdEntity ? [row.createdEntity] : [])]
    .filter(entity => entity.entityType === 'place').map(entity => [entity.id, entity]));
  const referenced = new Set([...Object.keys(data.identityRedirectsByEntityId ?? {}), ...Object.values(data.identityRedirectsByEntityId ?? {}), ...Object.keys(rows), ...Object.values(rows).map(row => row.parentEntityId),
    ...(data.foundation?.facts ?? []).flatMap(fact => [fact.placeEntityId, fact.parentEntityId, ...(fact.referencePlaceEntityIds ?? [])])].filter(Boolean));
  for (const id of referenced) {
    const entity = available.get(id);
    if (!entity) continue;
    if (!rows[id]?.createdEntity && !seeds.has(id)) seeds.set(id, copy(entity));
    if (entity.mergedIntoEntityId) referenced.add(entity.mergedIntoEntityId);
  }
  if (seeds.size) data.foundation = { ...(data.foundation ?? { schemaVersion: 1, facts: [] }), entities: [...seeds.values()] };
  // Library identities do not claim an appearance in the target's story floors.
  for (const entity of [...seeds.values(), ...Object.values(rows).flatMap(row => row.createdEntity ? [row.createdEntity] : [])]) {
    entity.firstSeenFloorId = null; entity.lastSeenFloorId = null;
  }
  const retained = new Set(targetFloors.map(floor => floor.id)), boundary = targetFloors.at(-1)?.id;
  // Inherited corrections take effect at the target boundary; their original source and quote stay intact.
  for (const fact of data.foundation?.facts ?? []) if (boundary && fact.knownFromFloorId && !retained.has(fact.knownFromFloorId)) {
    fact.knownFromFloorId = boundary;
  }
  return data;
}

export function validatePlaceWorkspace(value, chatId) {
  if (!value || value.schemaVersion !== 1 || value.kind !== 'qqj-v3-place-workspace' || !isUuid(chatId) || value.chatId !== chatId
    || !value.placesByEntityId || typeof value.placesByEntityId !== 'object' || Array.isArray(value.placesByEntityId)
    || !value.deletionsByEntityId || typeof value.deletionsByEntityId !== 'object' || Object.entries(value.deletionsByEntityId).some(([id, scope]) => !isUuid(id) || !Array.isArray(scope?.coveredFloorIds) || scope.coveredFloorIds.some(id => !isUuid(id)))) throw fail('地点资料归属或格式无效。');
  let normalizedRedirects = null;
  if (own(value, 'identityRedirectsByEntityId')) {
    const redirects = value.identityRedirectsByEntityId;
    if (!redirects || typeof redirects !== 'object' || Array.isArray(redirects)
      || Object.entries(redirects).some(([source, target]) => !isUuid(source) || !isUuid(target) || source === target)) throw fail('地点合并身份无效。');
    normalizedRedirects = {};
    for (const source of Object.keys(redirects)) {
      const seen = new Set([source]); let current = redirects[source];
      while (redirects[current]) { if (seen.has(current)) throw fail('地点合并身份形成循环。'); seen.add(current); current = redirects[current]; }
      normalizedRedirects[source] = current;
    }
  }
  if(value.foundation)validatePlaceFoundation(value.foundation,chatId);
  if(own(value,'mapStyle')&&!validQianchuangMapStyle(value.mapStyle))throw fail('地点底图提示无效。');
  for (const [id, row] of Object.entries(value.placesByEntityId)) {
    if (row?.createdEntity) validateEntityRecord(row.createdEntity, { expectedChatId: chatId });
    if (row?.createdEntity && (row.createdEntity.id !== id || row.createdEntity.chatId !== chatId || row.createdEntity.entityType !== 'place')) throw fail('新增地点身份无效。');
    if (!isUuid(id) || !row || !row.scopes || typeof row.scopes !== 'object'
      || fields.filter(key => own(row, key)).some(key => {
        const scope = row.scopes[key];
        return (key === 'parentEntityId' ? row[key] !== null && !isUuid(row[key]) : key==='mapLevel'?row[key]!==null&&!['city','country','scope'].includes(row[key]):key==='mapRole'?row[key]!==null&&!['area','site','interior'].includes(row[key]):typeof row[key] !== 'string')
          || !scope || !isUuid(scope.knownThroughFloorId) || !Array.isArray(scope.coveredFloorIds) || scope.coveredFloorIds.some(id => !isUuid(id))
          || !Array.isArray(scope.coveredItemIds) || scope.coveredItemIds.some(id => typeof id !== 'string' || !id);
      })) throw fail('地点人工修订格式无效。');
  }
  return Object.freeze({ ...copy(value), ...(normalizedRedirects ? { identityRedirectsByEntityId: normalizedRedirects } : {}) });
}

export function compilePlaceMerges(value, bindings = []) {
  const isolated = [], redirects = {}, order = [], byKey = new Map(bindings.map(binding => [binding.entityKey, binding.entityId]));
  const issue = (index, code) => isolated.push({ field: 'placeMerges', index, code, path: `placeMerges[${index}]` });
  if (value === undefined) return { redirects, order, isolated };
  if (!Array.isArray(value)) { issue(-1, 'QQJ_PLACE_MERGE_INVALID'); return { redirects, order, isolated }; }
  const outgoing = new Map();
  for (const [index, item] of value.entries()) {
    const source = byKey.get(item?.sourceKey), target = byKey.get(item?.targetKey);
    if (!source || !target || source === target) { issue(index, 'QQJ_PLACE_MERGE_INVALID'); continue; }
    const edges = outgoing.get(source) ?? [];
    edges.push({ target, index }); outgoing.set(source, edges);
  }
  for (const [source, edges] of outgoing) {
    const visited = new Set([source]); let target = source, distance = 0, invalid = null;
    while (outgoing.has(target)) {
      const next = new Set(outgoing.get(target).map(edge => edge.target));
      if (next.size !== 1) { invalid = 'QQJ_PLACE_MERGE_CONFLICT'; break; }
      target = next.values().next().value; distance += 1;
      if (visited.has(target)) { invalid = 'QQJ_PLACE_MERGE_CYCLE'; break; }
      visited.add(target);
    }
    if (invalid) { for (const edge of edges) issue(edge.index, invalid); continue; }
    redirects[source] = target; order.push({ source, target, distance, index: edges[0].index });
  }
  order.sort((a, b) => a.distance - b.distance || a.index - b.index);
  return { redirects: Object.fromEntries(order.map(item => [item.source, item.target])), order, isolated };
}

export function applyPlaceMerges(workspace, plan, { entities = [], parents = new Map(), resolve } = {}) {
  if (!plan.order.length) return workspace;
  const data = copy(workspace), rows = data.placesByEntityId;
  const combined = { ...(data.identityRedirectsByEntityId ?? {}), ...plan.redirects };
  const distance = source => {
    let count = 0, current = source;
    const seen = new Set();
    while (combined[current] && !seen.has(current)) {
      seen.add(current); current = combined[current]; count += 1;
    }
    return count;
  };
  data.identityRedirectsByEntityId = Object.fromEntries(Object.keys(combined).sort((a, b) => distance(a) - distance(b)).map(source => [source, resolve(combined[source])]));
  const parentOwner = new Map(Object.entries(rows).filter(([id, row]) => !data.identityRedirectsByEntityId[id] && own(row, 'parentEntityId')).map(([id]) => [id, id]));
  const originalParent = id => own(workspace.placesByEntityId[id], 'parentEntityId') ? workspace.placesByEntityId[id].parentEntityId : parents.get(id);
  const externalParent = (owner, target) => {
    const chain = [], seen = new Set([owner]); let current = originalParent(owner);
    while (current) {
      if (seen.has(current)) return null;
      seen.add(current); chain.push(current); current = originalParent(current);
    }
    let start = 0;
    for (const [index, id] of chain.entries()) if (resolve(id) === target) start = index + 1;
    return chain[start] ? resolve(chain[start]) : null;
  };
  const seeds = new Map((data.foundation?.entities ?? []).map(entity => [entity.id, entity]));
  const byId = new Map(entities.map(entity => [entity.id, entity]));
  for (const { source, target } of plan.order) {
    for (const id of [source, target]) if (!seeds.has(id) && byId.has(id)) seeds.set(id, copy(byId.get(id)));
    const sourceRow = rows[source];
    if (!sourceRow) continue;
    const targetRow = rows[target] ?? { scopes: {} };
    for (const field of fields) {
      if (!own(sourceRow, field)) continue;
      if (!own(targetRow, field)) {
        targetRow[field] = copy(sourceRow[field]);
        targetRow.scopes[field] = copy(sourceRow.scopes[field]);
        if (field === 'parentEntityId') parentOwner.set(target, source);
      }
      const scope = targetRow.scopes[field], inherited = sourceRow.scopes[field];
      scope.coveredFloorIds = [...new Set([...scope.coveredFloorIds, ...inherited.coveredFloorIds])];
      scope.coveredItemIds = [...new Set([...scope.coveredItemIds, ...inherited.coveredItemIds])];
    }
    rows[target] = targetRow;
  }
  for (const [id, row] of Object.entries(rows)) if (!data.identityRedirectsByEntityId[id] && row.parentEntityId) {
    row.parentEntityId = externalParent(parentOwner.get(id) ?? id, id);
  }
  data.foundation = { ...(data.foundation ?? { schemaVersion: 1, facts: [] }), entities: [...seeds.values()] };
  return data;
}

export function createPlaceWorkspaceStore({ client } = {}) {
  const cache = new Map();
  async function read(identity, { fresh = false } = {}) {
    const chatId = identity?.chatId;
    if (!isUuid(chatId)) throw fail('当前聊天身份不可用。');
    if (!fresh && cache.has(chatId)) return cache.get(chatId);
    const pending = (async () => {
      try {
        const envelope = await client.get(`chat-${chatId}`, PLACE_WORKSPACE_RECORD_ID);
        if (!Number.isSafeInteger(envelope.revision) || envelope.revision < 1) throw fail('地点资料版本无效。');
        return { data: validatePlaceWorkspace(envelope.data, chatId), revision: envelope.revision };
      } catch (error) { if (error?.status === 404) return { data: null, revision: 0 }; throw error; }
    })();
    cache.set(chatId, pending);
    try { return await pending; } catch (error) { if (cache.get(chatId) === pending) cache.delete(chatId); throw error; }
  }
  async function put(identity, data, expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw fail('地点资料版本无效。');
    const safe = validatePlaceWorkspace(data, identity?.chatId);
    try {
      const result = await client.put(`chat-${identity.chatId}`, PLACE_WORKSPACE_RECORD_ID, safe, expectedRevision);
      if (result.revision !== expectedRevision + 1) throw fail('地点资料保存版本无效。');
      const saved = { data: validatePlaceWorkspace(result.data, identity.chatId), revision: result.revision };
      cache.set(identity.chatId, Promise.resolve(saved)); return saved;
    } catch (error) {
      // A lost reply may follow a durable CAS. Confirm this exact write before
      // reporting failure or allocating another manual place identity.
      cache.delete(identity.chatId);
      try {
        const saved = await read(identity, { fresh: true });
        if (saved.revision === expectedRevision + 1 && stableJson(saved.data) === stableJson(safe)) return saved;
      } catch { cache.delete(identity.chatId); }
      throw error;
    }
  }
  async function copyFrom(sourceIdentity,targetIdentity,{floorIds=null,narrativeGeneration=null,sourceEntities=[],targetFloors=null}={}){
    const target=await read(targetIdentity,{fresh:true});if(target.data)return target;
    const source=await read(sourceIdentity,{fresh:true});if(!source.data)return null;
    const library=targetFloors?latestPlaceLibrary(source.data,sourceEntities,targetFloors):placeWorkspaceForPrefix(source.data,floorIds);
    const data=rehomePlaceWorkspace(library,targetIdentity.chatId,narrativeGeneration);
    return put(targetIdentity,data,target.revision);
  }
  return Object.freeze({ read, put, copy:copyFrom, invalidate(chatId) { if (chatId) cache.delete(chatId); else cache.clear(); } });
}

// The boundary records which knowledge the user edited, not a story evidence source.
export function placeWorkspaceForPrefix(workspace, floorIds = null) {
  if (!workspace || !floorIds) return workspace;
  const deletionsByEntityId = Object.fromEntries(Object.entries(workspace.deletionsByEntityId ?? {})
    .filter(([, scope]) => scope.knownThroughFloorId ? floorIds.has(scope.knownThroughFloorId) : scope.coveredFloorIds.some(id => floorIds.has(id)))
    .map(([id, scope]) => [id, { ...scope, coveredFloorIds: scope.coveredFloorIds.filter(id => floorIds.has(id)) }]));
  const scoped = { ...workspace, deletionsByEntityId,
    placesByEntityId: Object.fromEntries(Object.entries(workspace.placesByEntityId ?? {}).map(([id, row]) => {
      const scoped = { scopes: {}, ...(row.createdEntity ? { createdEntity: row.createdEntity } : {}) };
      for (const key of fields) if (own(row, key) && floorIds.has(row.scopes[key].knownThroughFloorId)) {
        scoped[key] = row[key]; scoped.scopes[key] = row.scopes[key];
      }
      if (row.createdEntity && !Object.keys(scoped.scopes).length && !deletionsByEntityId[id]) delete scoped.createdEntity;
      return [id, scoped];
    })),
  };
  return filterPlaceFoundationSources(scoped,{floorIds});
}

export function filterPlaceMemory(memory, workspace, resolve = id => id) {
  if (!workspace) return memory;
  const rows = workspace.placesByEntityId ?? {};
  const projectItem = (item, field) => {
    const placeIds = [...new Set([item.placeEntityId, resolve(item.placeEntityId)].filter(Boolean))];
    if (['description','relations','parentEntityId'].includes(field) && placeIds.some(id => coveredPlaceItemIds(workspace,id,field==='description'?'feature':field==='parentEntityId'?'containment':'relation').has(item.itemId))) return [];
    const scopes = placeIds.map(id => rows[id]).filter(row => own(row, field)).map(row => row.scopes[field]).filter(Boolean);
    if (scopes.some(scope => field === 'parentEntityId' || scope.coveredItemIds.includes(item.itemId) || (item.replacesItemIds ?? []).some(id => scope.coveredItemIds.includes(id)))) return [];
    const refKey = Array.isArray(item.evidenceRefs) ? 'evidenceRefs' : Array.isArray(item.sourceRefs) ? 'sourceRefs' : null;
    const refs = refKey ? item[refKey] : [{ floorId: memory.floorId }];
    const endpoints = [item.entityId, item.placeEntityId, item.parentEntityId, ...(item.referencePlaceEntityIds ?? [])];
    const kept = refs.filter(ref => !endpoints.flatMap(id => [id, resolve(id)]).some(id => workspace.deletionsByEntityId?.[id]?.coveredFloorIds.includes(ref.floorId)) && !scopes.some(scope => scope.coveredFloorIds.includes(ref.floorId)));
    if (!kept.length) return [];
    return [{ ...item, ...(refKey ? { [refKey]: kept } : {}) }];
  };
  const spatialFacts = memory.spatialFacts ? Object.fromEntries(['containments', 'positions', 'features', 'relations'].map(field => [field,
    (memory.spatialFacts[field] ?? []).flatMap(item => projectItem(item, field === 'features' ? 'description' : field === 'relations' ? 'relations' : field === 'containments' ? 'parentEntityId' : 'positions'))])) : null;
  return { ...memory, locations: (memory.locations ?? []).flatMap(item => projectItem(item, 'locations')).map(item => ({ ...item,
    ...(own(rows[item.entityId], 'name') ? { name: rows[item.entityId].name || '未命名地点' } : {}) })), ...(spatialFacts ? { spatialFacts } : {}) };
}

export function manualPlaceFacts(workspace) {
  return Object.entries(workspace?.placesByEntityId ?? {}).filter(([id]) => !workspace?.identityRedirectsByEntityId?.[id]).map(([entityId, row]) => ({ entityId, ...row }));
}

export function applyPlaceSnapshot(snapshot, workspace, {floorOrder=new Map(),memories=[],resolve=id=>id}={}) {
  workspace=workspace?.chatId===snapshot.chatId?workspace:null;
  const rows = workspace?.placesByEntityId ?? {};
  const base=effectiveFoundationFacts(workspace,memories);
  const parentLinks = projectPlaceParentLinks(memories, workspace, floorOrder, Infinity, Infinity,
    {resolve,baseIntents: (snapshot.containments ?? []).map(edge => ({ ...edge, seq: edge.sourceAssistantSeq ?? 0 })) });
  const places = snapshot.places.map(place => {
    const row = rows[place.entityId], result = { ...place, features: [...place.features], relations: [...place.relations], childEntityIds: [] };
    for(const fact of base.filter(fact=>fact.placeEntityId===place.entityId)){
      if(fact.kind==='place'&&['area','site','interior'].includes(fact.mapRole))result.mapRole=fact.mapRole;
      if(fact.kind==='place'&&[null,'city','country','scope'].includes(fact.mapLevel))result.mapLevel=fact.mapLevel;
      if(fact.kind==='place'&&own(fact,'facilities'))result.facilities=copy(fact.facilities);
      if(fact.kind==='place')for(const key of ['mapStyle','mapLayout','mapAssetId'])if(own(fact,key))result[key]=fact[key];
      if(fact.kind==='feature'&&fact.text)result.features.push({itemId:fact.itemId,text:fact.text,kind:'stable',source:fact.source});
      if(fact.kind==='relation'&&fact.text)result.relations.push({itemId:fact.itemId,text:fact.text,kind:'relative',referencePlaceEntityIds:[],source:fact.source});

    }
    if (own(row, 'name')) result.displayName = row.name || '未命名地点';
    const parent = parentLinks.get(place.entityId)?.parents;
    if (parent) result.parentEntityId = parent.size === 1 ? parent.keys().next().value : null;
    if (own(row, 'parentEntityId')) result.parentEntityId = row.parentEntityId?resolve(row.parentEntityId):null;
    if (own(row,'mapLevel'))result.mapLevel=row.mapLevel;
    result.manualMapRole=own(row,'mapRole')&&row.mapRole!==null;
    if(result.manualMapRole)result.mapRole=row.mapRole;
    if (own(row, 'description')) {
      result.manualDescription = true;
      if (row.description.trim()) result.features.unshift({ itemId: `manual-description-${place.entityId}`, text: row.description, kind: 'stable', manual: true });
    }
    if (own(row, 'relations')) result.relations.unshift(...row.relations.split(/\r?\n/u).map(text => text.trim()).filter(Boolean).map((text, index) => ({ itemId: `manual-relation-${place.entityId}-${index}`, text, kind: 'relative', referencePlaceEntityIds: [], manual: true })));
    return result;
  });
  const byId = new Map(places.map(place => [place.entityId, place]));
  for(const place of places)if(!byId.has(place.parentEntityId)||place.parentEntityId===place.entityId)place.parentEntityId=null;
  const cyclic=new Set();
  for(const place of places){
    const path=[],seen=new Set();let current=place;
    while(current?.parentEntityId){
      if(seen.has(current.entityId)){for(const id of path)cyclic.add(id);break;}
      seen.add(current.entityId);path.push(current.entityId);current=byId.get(current.parentEntityId);
    }
  }
  for(const id of cyclic)byId.get(id).parentEntityId=null;
  for (const place of places) if (place.parentEntityId) byId.get(place.parentEntityId).childEntityIds.push(place.entityId);
  for (const place of places) { let root = place; while (root.parentEntityId) root = byId.get(root.parentEntityId); place.mapRootEntityId = root.childEntityIds.length || own(rows[root.entityId], 'parentEntityId') && rows[root.entityId].parentEntityId === null ? root.entityId : null; }
  const user = byId.get(snapshot.userPosition?.placeEntityId);
  return Object.freeze({ ...snapshot, ...(validQianchuangMapStyle(workspace?.mapStyle)?{mapStyle:workspace.mapStyle}:{}), places, mapRootIds: places.filter(place => !place.parentEntityId && place.mapRootEntityId === place.entityId).map(place => place.entityId),
    unassignedPlaceIds: places.filter(place => !place.mapRootEntityId).map(place => place.entityId),
    containments: places.filter(place => place.parentEntityId).map(place => ({ placeEntityId: place.entityId, parentEntityId: place.parentEntityId,...parentLinks.get(place.entityId)?.parents.get(place.parentEntityId),...(own(rows[place.entityId],'parentEntityId')?{manual:true}:{}) })),
    userPosition: snapshot.userPosition ? { ...snapshot.userPosition, placeEntityId: user?.entityId ?? null, mapRootEntityId: snapshot.userPosition.status==='leftUnknown'?null:user?.mapRootEntityId??null, isCurrent: Boolean(user?.mapRootEntityId && snapshot.userPosition.status === 'confirmed' && snapshot.userPosition.atSummarizedEnd === true) } : snapshot.userPosition });
}

export function withCreatedPlaces(entities = [], workspace) {
  const ids = new Set(entities.map(entity => entity.id));
  const added=[...manualPlaceFacts(workspace).flatMap(row=>row.createdEntity?[row.createdEntity]:[]),...(workspace?.foundation?.entities??[])];
  const libraryIds = new Set(added.map(entity => entity.id));
  const libraryIdentity = entity => ({ ...entity, firstSeenFloorId: null, lastSeenFloorId: null });
  return [...entities.map(entity=>libraryIds.has(entity.id)?libraryIdentity(entity):entity),
    ...added.filter(entity=>{if(ids.has(entity.id))return false;ids.add(entity.id);return true;}).map(libraryIdentity)];
}

export function placeDeletionIdentityIds(workspace, source) {
  if (!workspace) return [];
  const visible = new Set((source.floors ?? []).map(floor => floor.id));
  return Object.entries(workspace.deletionsByEntityId ?? {}).filter(([entityId, scope]) => {
    for (const memory of (source.floorMemories ?? []).filter(memory => !memory.recordStatus || memory.recordStatus === 'active')) for (const item of [...(memory.locations ?? []), ...Object.values(memory.spatialFacts ?? {}).flatMap(value => Array.isArray(value) ? value : [])]) {
      if (![item.entityId, item.placeEntityId, item.parentEntityId, ...(item.referencePlaceEntityIds ?? [])].includes(entityId)) continue;
      const refs = item.evidenceRefs ?? [{ floorId: memory.floorId }];
      if (refs.some(ref => visible.has(ref.floorId) && !scope.coveredFloorIds.includes(ref.floorId))) return false;
    }
    return true;
  }).map(([id]) => id);
}
