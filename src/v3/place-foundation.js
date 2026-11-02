import { indexQianchuangWorldInfo } from '../place-worldbook-material.js';
import { cseWorldInfoKeyMatches } from '../cse-source-selection.js';
import { deterministicUuid } from './foundation-domain.js';
import { validateEntityRecord } from './memory-schema.js';
import { isUuid } from '../identity.js';
import { normalizePlaceFacilities, validQianchuangMapStyle, validQianchuangMapLayout } from '../qianchuang-display-hints.js';
import {selectQianchuangMapAsset} from '../qianchuang-map-assets.js';
import { locatePlaceQuote } from './place-evidence.js';
const label=value=>String(value??'').normalize('NFKC').trim().toLocaleLowerCase();
const copy=value=>structuredClone(value);

function pathEvidence(entry, scope) {
  if (!entry || typeof entry !== 'object') return [];
  const requested = Array.isArray(entry.evidence) ? entry.evidence : [entry];
  return requested.flatMap(ref => {
    if (!ref || typeof ref !== 'object') return [null];
    if (ref.source === 'characterCard') {
      const card=scope.characterCardSources?.find(source=>source.sourceKey===ref.sourceKey),segments=locatePlaceQuote(card?.content,ref.exactQuote,{allowWhitespace:true,allowOmission:Boolean(ref.sourceKey)});
      return segments ? segments.map(({quote})=>({source:{kind:'characterCard',field:card.field,locator:card.locator,fingerprint:card.fingerprint,quote}})) : [null];
    }
    if (ref.source === 'worldbook') {
      const book = scope.placeWorldbookSources?.find(source => source.sourceKey === ref.sourceKey), segments = locatePlaceQuote(book?.content, ref.exactQuote, {allowWhitespace:true,allowOmission:Boolean(ref.sourceKey)});
      return segments ? segments.map(({quote})=>({ source: { kind: 'worldbook', sourceName: book.sourceName ?? '', locator: book.locator, fingerprint: book.fingerprint, quote } })) : [null];
    }
    if (!['canonicalContent','precedingUserInput','storedPlaceEvidence'].includes(ref.source)) return [null];
    const choices = (scope.sourceFloorBindings ?? []).flatMap(binding => ref.source === 'precedingUserInput'
      ? (binding.sourceUserInputSnapshot?.messages ?? []).map((message, sourceSnapshotIndex) => ({ ...binding, canonicalContent: message.content, sourceType: 'precedingUser', sourceSnapshotIndex }))
      : [{ ...binding, sourceType: binding.sourceType ?? 'assistant' }]);
    const candidates = choices.filter(binding => ref.source === 'storedPlaceEvidence' ? binding.evidenceKey === ref.sourceKey
      : (!ref.sourceFloorKey || binding.floorKey === ref.sourceFloorKey) && (!Number.isSafeInteger(ref.sourceSnapshotIndex) || binding.sourceSnapshotIndex === ref.sourceSnapshotIndex));
    const match = allowOmission => candidates.flatMap(binding => {
      if(binding.requiresExactQuote&&(typeof ref.exactQuote!=='string'||!ref.exactQuote.trim()||ref.exactQuote.length>2000))return [];
      const segments=locatePlaceQuote(binding.canonicalContent,ref.source === 'storedPlaceEvidence' && !Object.hasOwn(ref,'exactQuote') ? binding.canonicalContent : ref.exactQuote,{allowWhitespace:true,allowOmission});
      if(binding.requiresExactQuote&&segments?.some(segment=>segment.quote.length>2000))return [];
      return segments?[{binding,segments}]:[];
    });
    const strict = match(false), matches = strict.length ? strict : (ref.sourceFloorKey || ref.source === 'storedPlaceEvidence' && ref.sourceKey) ? match(true) : [];
    if (matches.length !== 1) return [null];
    const { binding, segments } = matches[0];
    return segments.map(({quote})=>({ body: binding, source: { kind: 'body', floorId: binding.floorId, sourceType: binding.sourceType,
      ...(binding.sourceSnapshotIndex !== undefined ? { sourceSnapshotIndex: binding.sourceSnapshotIndex } : {}),
      ...(binding.memoryId ? { memoryId: binding.memoryId } : {}), locator: `floor:${binding.floorId}`, fingerprint: binding.rawFingerprint, quote },
      semantic: { source: binding.sourceType === 'precedingUser' ? 'precedingUserInput' : 'canonicalContent', sourceFloorKey: binding.floorKey,
        ...(binding.sourceType === 'precedingUser' ? { sourceSnapshotIndex: binding.sourceSnapshotIndex } : {}), exactQuote: quote } }));
  });
}

function linkedBodyLeaf(entry, spatial, resolved, scope) {
  const name = entry.path.at(-1).name.trim(), candidates = spatial.places.filter(place => typeof place?.name === 'string' && place.name.trim() === name);
  if (!candidates.length) return { leaf: null, conflict: false };
  const validPlace=place=>/^place-mention-[1-9]\d*$/u.test(place?.key??'')&&spatial.places.filter(other=>other?.key===place.key).length===1
    &&(place.identity==='new'?!place.sameAsPlaceKey:place.identity==='existing'&&typeof place.sameAsPlaceKey==='string'&&Boolean(place.sameAsPlaceKey.trim()));
  const source = resolved[0]?.body;
  if (candidates.length !== 1 || !validPlace(candidates[0]) || !source || entry.path.length < 2 || resolved.some(ref => ref.body?.floorId !== source.floorId || ref.body.sourceType !== 'assistant')) return { leaf: null, conflict: true };
  const ranges = refs => {
    if (!refs.length || refs.some(ref => !ref?.body || ref.body.floorId !== source.floorId || ref.body.sourceType !== 'assistant' || ref.semantic.sourceFloorKey !== source.floorKey)) return null;
    return refs.map(ref => {
      const start=source.canonicalContent.indexOf(ref.source.quote);
      return start<0||source.canonicalContent.indexOf(ref.source.quote,start+1)>=0?null:{start,end:start+ref.source.quote.length};
    });
  };
  const pathRanges=ranges(resolved),overlap=(a,b)=>a.start<b.end&&b.start<a.end,contains=(a,b)=>a.start<=b.start&&a.end>=b.end;
  if(!pathRanges||pathRanges.some(range=>!range))return {leaf:null,conflict:true};
  let child=candidates[0];
  const linkedEdges=new Set(),nodes=new Map([[entry.path.length-1,child]]);
  for(let depth=entry.path.length-1;depth>0;depth--){
    const parents=new Set(spatial.containments.filter(edge=>edge?.placeKey===child.key).map(edge=>edge.parentPlaceKey));
    if(!parents.size)break;
    if(parents.size!==1)return {leaf:null,conflict:true};
    const parentKey=[...parents][0],parentsByKey=spatial.places.filter(place=>place?.key===parentKey),parent=parentsByKey[0];
    if(parentsByKey.length!==1||!validPlace(parent)||typeof parent.name!=='string'||parent.name.trim()!==entry.path[depth-1].name.trim())return {leaf:null,conflict:true};
    const childRanges=ranges(pathEvidence(child,scope)),parentRanges=ranges(pathEvidence(parent,scope));
    const evidence=spatial.containments.filter(edge=>edge?.placeKey===child.key&&edge.parentPlaceKey===parentKey).flatMap(edge=>pathEvidence(edge,scope)),edgeRanges=ranges(evidence);
    if(!childRanges||!parentRanges||!edgeRanges||[...childRanges,...parentRanges,...edgeRanges].some(range=>!range)
      || !childRanges.some(a=>edgeRanges.some(b=>overlap(a,b)))||!parentRanges.some(a=>edgeRanges.some(b=>overlap(a,b)))
      || pathRanges.some(range=>!edgeRanges.some(edge=>contains(edge,range))||![...childRanges,...parentRanges].some(node=>contains(node,range))))return {leaf:null,conflict:true};
    linkedEdges.add(`${child.key}:${parent.key}`);nodes.set(depth-1,parent);child=parent;
  }
  for(const [depth,place]of nodes)if(entry.path[depth].sameAsPlaceKey&&entry.path[depth].sameAsPlaceKey!==place.sameAsPlaceKey)return {leaf:null,conflict:true};
  return {leaf:linkedEdges.size?candidates[0]:null,conflict:!linkedEdges.size,linkedEdges,nodes};
}

const referencedSources = source => source?.references ?? (source ? [source] : []);

export function selectPlaceWorldbookSources({ candidates = [], macros = {}, texts = [], places = [], organize = false } = {}) {
  const names = places.flatMap(place => [place.displayName, ...(place.aliases ?? [])]).filter(Boolean);
  const scanText = [...texts, ...names].join('\n');
  const eligible = candidates.filter(candidate => candidate.kind === 'worldbook' && candidate.hostEnabled !== false && candidate.availability !== 'disabled');
  const nonPlace = candidate => {
    const metadata=[candidate.entryLabel,candidate.comment,candidate.title].filter(Boolean).join(' ');
    if(/地图|地点|场所|区域|建筑|住所|location|map|scene|place/iu.test(metadata))return false;
    let keys=[];try{const value=JSON.parse(candidate.content);if(value&&!Array.isArray(value)&&typeof value==='object')keys=Object.keys(value);}catch{}
    return /人物[|｜]|人物档案|角色档案|人物设定|character profile|persona/iu.test(metadata)
      || keys.some(key=>/character_meta|basic_information|physical_appearance|psychological_profile|profiles?$|protocol|^rules?$|人物|角色|企业概况|核心领导层/iu.test(key));
  };
  const direct = eligible.filter(candidate => !nonPlace(candidate)&&((candidate.primaryKeys ?? []).some(key => cseWorldInfoKeyMatches(scanText,key,{macros}))
    || names.some(name=>name.length>1&&String(candidate.content??'').includes(name))));
  const physical = candidate => {
    const records=indexQianchuangWorldInfo({candidates:[candidate],macros});
    const metadata=[candidate.entryLabel,candidate.comment,candidate.title].filter(Boolean).join(' ');
    return /地图|地点|场所|区域|建筑|住所|location|map|scene|place/iu.test(metadata)
      || records.some(record=>record.texts.length&&record.names.length);
  };
  const selected=organize?eligible:[...new Set([...direct,...eligible.filter(candidate=>candidate.constant===true&&!nonPlace(candidate)&&physical(candidate))])];
  return selected
    .map((candidate, index) => ({ sourceKey: `worldbook-${index + 1}`, kind: 'worldbook', locator: candidate.locator ?? candidate.id,
      sourceName: candidate.world ?? candidate.sourceName ?? '', fingerprint: candidate.fingerprint, content: String(candidate.content ?? ''),
      identityAliases: { user: String(macros.user ?? ''), char: String(macros.char ?? '') } }));
}

export function validatePlaceFoundation(value,chatId){
 if(!value||value.schemaVersion!==1||!Array.isArray(value.entities)||!Array.isArray(value.facts))throw new TypeError('地点索引格式无效。');
 for(const entity of value.entities)if(validateEntityRecord(entity,{expectedChatId:chatId}).entityType!=='place')throw new TypeError('地点索引归属无效。');
 for(const fact of value.facts)if(!isUuid(fact.itemId)||!isUuid(fact.placeEntityId)||!['place','containment','feature','relation'].includes(fact.kind)||fact.kind==='containment'&&!isUuid(fact.parentEntityId))throw new TypeError('地点索引结构无效。');
 return value;
}

export function mergePlaceFoundation(workspace,patch={entities:[],facts:[]},removedItemIds=[]){
 const result=structuredClone(workspace),prior=result.foundation??{schemaVersion:1,entities:[],facts:[]};
 const entities=new Map(prior.entities.map(entity=>[entity.id,entity]));
 for(const entity of patch.entities??[])if(!entities.has(entity.id))entities.set(entity.id,entity);
 const replaced=new Set((patch.replaceFields??[]).map(value=>`${value.entityId}:${value.kind}`)),removed=new Set(removedItemIds);
 const hints=new Map();for(const fact of [...prior.facts,...(patch.facts??[])])if(fact.kind==='place'){
  const row=hints.get(fact.placeEntityId)??{};
  if(['area','site','interior'].includes(fact.mapRole))row.mapRole=fact.mapRole;
  if([null,'city','country','scope'].includes(fact.mapLevel))row.mapLevel=fact.mapLevel;
  if(Object.hasOwn(fact,'facilities'))row.facilities=fact.facilities;
  if(validQianchuangMapStyle(fact.mapStyle)){if(row.mapStyle!==fact.mapStyle)delete row.mapAssetId;row.mapStyle=fact.mapStyle;if(!validQianchuangMapLayout(row.mapLayout,row.mapStyle))delete row.mapLayout;}
  if(validQianchuangMapLayout(fact.mapLayout,row.mapStyle??workspace.mapStyle)){if(row.mapLayout!==fact.mapLayout)delete row.mapAssetId;row.mapLayout=fact.mapLayout;}
  if(fact.mapAssetId&&!row.mapAssetId)row.mapAssetId=fact.mapAssetId;
  hints.set(fact.placeEntityId,row);
 }
 const usedAssetIds=[...hints.values()].map(row=>row.mapAssetId).filter(Boolean);
 for(const [entityId,row]of hints)if(row.mapStyle){row.mapAssetId=selectQianchuangMapAsset({entityId,style:row.mapStyle,layout:row.mapLayout,previousAssetId:row.mapAssetId,usedAssetIds});if(row.mapAssetId)usedAssetIds.push(row.mapAssetId);}
 const facts=new Map(prior.facts.filter(fact=>!replaced.has(`${fact.placeEntityId}:${fact.kind}`)&&!removed.has(fact.itemId)).map(fact=>[fact.itemId,fact]));
 for(const fact of patch.facts??[])facts.set(fact.itemId,fact.kind==='place'?{...fact,...hints.get(fact.placeEntityId)}:fact);
 result.foundation={schemaVersion:1,entities:[...entities.values()],facts:[...facts.values()]};
 if(validQianchuangMapStyle(patch.mapStyle))result.mapStyle=patch.mapStyle;
 return result;
}

export function filterPlaceFoundationSources(workspace,{filterWorldInfoSources=sources=>sources,floorIds=null}={}){
 if(!workspace?.foundation)return workspace;
 const facts=workspace.foundation.facts.filter(fact=>referencedSources(fact.source).every(source=>(source.kind!=='worldbook'||filterWorldInfoSources([{sourceName:source.sourceName??''}]).length)
  &&(source.kind!=='body'||!floorIds||floorIds.has(source.floorId))));
 const ids=new Set(facts.flatMap(fact=>[fact.placeEntityId,fact.parentEntityId,...(fact.referencePlaceEntityIds??[])].filter(Boolean)));
 for(const [id,row]of Object.entries(workspace.placesByEntityId??{}))if(Object.keys(row.scopes??{}).length){ids.add(id);if(row.parentEntityId)ids.add(row.parentEntityId);}
 return {...workspace,foundation:{...workspace.foundation,facts,entities:workspace.foundation.entities.filter(entity=>ids.has(entity.id))}};
}

export function effectiveFoundationFacts(workspace,memories=[]){
 const replaced=new Set(memories.flatMap(memory=>(memory.spatialFacts?.features??[]).flatMap(feature=>feature.replacesItemIds??[])));
 return (workspace?.foundation?.facts??[]).filter(fact=>{
  if(replaced.has(fact.itemId))return false;
  const field=fact.kind==='containment'?'parentEntityId':fact.kind==='feature'?'description':'relations';
  return fact.kind==='place'||!Object.hasOwn(workspace.placesByEntityId?.[fact.placeEntityId]??{},field);
 });
}

// Only the user's book exclusions participate in the existing revision receipt key.
export function placeWorkspaceDependency(chatId,revision,workspace){
 const books=[...new Set((workspace?.foundation?.facts??[]).flatMap(fact=>referencedSources(fact.source)).filter(source=>source.kind==='worldbook').map(source=>source.sourceName??''))].sort();
 return `${chatId}:${revision??0}${books.length?`:${JSON.stringify(books)}`:''}`;
}

export function mergeFoundationParents(latest,workspace,seqById,throughAssistantSeq=Infinity){
 const prefix=filterPlaceFoundationSources(workspace,{floorIds:new Set([...seqById].filter(([,seq])=>seq<=throughAssistantSeq).map(([id])=>id))});
 for(const fact of effectiveFoundationFacts(prefix).filter(fact=>fact.kind==='containment')){
  const seq=seqById.get(fact.knownFromFloorId)??0,prior=latest.get(fact.placeEntityId);
  if(seq<=throughAssistantSeq&&(!prior||(prior.seq??0)<=seq))latest.set(fact.placeEntityId,{seq,parents:new Set([fact.parentEntityId])});
 }
 return latest;
}

function makeSeed(id, name, scope, now) {
  return validateEntityRecord({ schemaVersion: 3, recordType: 'entity', id, chatId: scope.chatId, narrativeGeneration: scope.narrativeGeneration,
    entityType: 'place', displayName: name, aliases: [], specialRole: 'none', firstSeenFloorId: null, lastSeenFloorId: null, status: 'provisional',
    mergedIntoEntityId: null, mergeEvidenceRefs: [], baselineClaimIds: [], createdAt: now, updatedAt: now, recordStatus: 'active', supersedes: null });
}


export async function expandPlacePaths({ packet, envelope, existingEntities = [], now, persistBodyPaths = false }) {
  const result = copy(packet), scope = envelope.scope, entities = [...existingEntities], byId = new Map(entities.map(entity => [entity.id, entity]));
  const bindings = [...(scope.placeCatalogBindings ?? [])], byKey = new Map(bindings.map(binding => [binding.entityKey, binding]));
  const parents = new Map(scope.parentEntityIdsByPlaceId ?? []), seenPaths = new Map(), facts = new Map(), isolated = [], replaceFields = [];
  const input = result.spatialFacts;
  const spatial = input && typeof input === 'object' && !Array.isArray(input) ? input : (result.spatialFacts = { places: [], containments: [], positions: [] });
  if (input !== undefined && spatial !== input) isolated.push({ field: 'spatialFacts', index: -1, code: 'V3_EXTRACTOR_OBJECT_INVALID', path: 'spatialFacts' });
  for (const key of ['places','containments','features','relations']) {
    if (spatial[key] !== undefined && !Array.isArray(spatial[key])) {
      isolated.push({ field: `spatialFacts.${key}`, index: -1, code: 'V3_EXTRACTOR_ARRAY_INVALID', path: `spatialFacts.${key}` }); spatial[key] = [];
    }
  }
  spatial.places ??= []; spatial.containments ??= [];
  // Only the model's original local edges can link an omitted leaf key; a path
  // expanded earlier in this pass cannot supply evidence for another path.
  const linkedInput={places:spatial.places.map(place=>place&&{...place}),containments:[...spatial.containments]};
  let mentionIndex = Math.max(0, ...spatial.places.map(place => Number(/place-mention-(\d+)$/u.exec(place?.key)?.[1]) || 0));
  const mentionById = new Map();
  for (const place of spatial.places) {
    const binding = place?.identity === 'existing' && byKey.get(place.sameAsPlaceKey);
    if (binding && !mentionById.has(binding.entityId)) mentionById.set(binding.entityId, place.key);
  }
  const freshEntities = [];
  const originalParents = scope.parentEntityIdsByPlaceId ?? new Map();
  const lineage = entityId => { const ids = new Set(); let current = entityId; while (current && !ids.has(current)) { ids.add(current); const next = originalParents.get(current); current = next?.size === 1 ? [...next][0] : null; } return ids; };
  for (const [index, rawEntry] of (Array.isArray(result.placePaths) ? result.placePaths : []).entries()) {
    const entry=Array.isArray(rawEntry?.path)?{...rawEntry,path:rawEntry.path.map(segment=>{
      if(!segment||typeof segment!=='object'||Object.hasOwn(segment,'name')||typeof segment.sameAsPlaceKey!=='string')return segment;
      const matches=(scope.placeCatalogBindings??[]).filter(binding=>binding.entityKey===segment.sameAsPlaceKey),binding=matches.length===1?matches[0]:null;
      const name=binding?.labels?.[0];
      return typeof name==='string'&&byId.get(binding.entityId)?.entityType==='place'?{...segment,name}:segment;
    })}:rawEntry;
    const resolved = pathEvidence(entry, scope);
    if (!entry || !Array.isArray(entry.path) || !entry.path.length || entry.path.length > 12 || !resolved.length || resolved.some(ref => !ref)
      || entry.path.some(segment => !segment || typeof segment.name !== 'string' || !segment.name.trim() || segment.name.length > 500)) {
      isolated.push({ field: 'placePaths', index, code: 'QQJ_PLACE_PATH_SOURCE_INVALID', path: `placePaths[${index}]` }); continue;
    }
    const bodySource = resolved.every(ref => ref.body) ? resolved[0].body : null;
    const quote = resolved[0].source.quote;
    const bodyEvidence = bodySource ? { ...resolved[0].semantic,
      ...(resolved.length > 1 ? { _placePathEvidence: resolved.map(ref => ref.semantic) } : {}) } : {};
    const primary = resolved.find(ref => ref.source.kind === 'worldbook') ?? resolved[0];
    const autoSource = !bodySource || persistBodyPaths ? { ...primary.source,
      ...(resolved.length > 1 ? { references: resolved.map(ref => ref.source) } : {}) } : null;
    let leaf = typeof entry.placeKey === 'string' ? spatial.places.find(place => place?.key === entry.placeKey) : undefined;
    let bridge = null;
    if (!entry.placeKey && bodySource && !persistBodyPaths) {
      const linked=linkedBodyLeaf(entry,linkedInput,resolved,scope);
      if(linked.conflict){isolated.push({field:'placePaths',index,code:'QQJ_PLACE_PATH_IDENTITY_INVALID',path:`placePaths[${index}]`});continue;}
      leaf=spatial.places.find(place=>place?.key===linked.leaf?.key);bridge=linked;
    }
    const segments = entry.path.map((segment, i) => {
      const linked = bridge?.nodes?.get(i) ?? (i === entry.path.length - 1 ? leaf : null);
      return { ...segment, ...(linked?.sameAsPlaceKey && !segment.sameAsPlaceKey ? { sameAsPlaceKey: linked.sameAsPlaceKey } : {}) };
    });
    if (segments.some(segment => segment.sameAsPlaceKey && !byKey.has(segment.sameAsPlaceKey))) {
      isolated.push({ field: 'placePaths', index, code: 'QQJ_PLACE_PATH_IDENTITY_INVALID', path: `placePaths[${index}]` }); continue;
    }
    let knownPrefix = null, scopeConflict = false;
    for (const [depth, segment] of segments.entries()) {
      const exact = bindings.filter(binding => (binding.labels ?? []).some(value => label(value) === label(segment.name)));
      const id = byKey.get(segment.sameAsPlaceKey)?.entityId ?? (depth === 0 && exact.length === 1 ? exact[0].entityId : null);
      if (depth > 0 && id && originalParents.get(id)?.size && (!knownPrefix || !lineage(id).has(knownPrefix))) scopeConflict = true;
      if (id) knownPrefix = id;
    }
    if (scopeConflict && entry.identityChange !== 'ownershipChanged' && envelope.request?.task !== 'organizePlaces') {
      isolated.push({ field: 'placePaths', index, code: 'QQJ_PLACE_PATH_SCOPE_CONFLICT', path: `placePaths[${index}]` }); continue;
    }
    // Explicit organization can correct a known parent; resolve once before publishing any part of a cyclic path.
    const pathNodes = [], pathEntities = [], pathBindings = [...bindings], pathParents = new Map(parents), pathSeen = new Map(seenPaths);
    let parentId = null;
    for (const segment of segments) {
      const name = segment.name.trim(), pathKey = JSON.stringify([parentId, label(name)]);
      let entityId = byKey.get(segment.sameAsPlaceKey)?.entityId ?? pathSeen.get(pathKey);
      if (!entityId) {
        const matches = pathBindings.filter(binding => (binding.labels ?? []).some(value => label(value) === label(name))
          && (parentId ? pathParents.get(binding.entityId)?.has(parentId) : !pathParents.get(binding.entityId)?.size));
        if (matches.length === 1) entityId = matches[0].entityId;
      }
      if (!entityId) {
        entityId = await deterministicUuid(['v3-place-path', scope.chatId, scope.narrativeGeneration, scope.batchId, parentId, label(name)]);
        pathEntities.push(makeSeed(entityId, name, scope, now));
        pathBindings.push({ entityKey: `place-path-${pathBindings.length + 1}`, entityId, entityType: 'place', specialRole: 'none', labels: [name] });
      }
      pathSeen.set(pathKey, entityId);pathNodes.push({ entityId, name, pathKey });
      if(parentId)pathParents.set(entityId,new Set([parentId]));parentId=entityId;
    }
    const cyclic=pathNodes.some(({entityId})=>{const seen=new Set();let id=entityId;while(id){if(seen.has(id))return true;seen.add(id);const next=pathParents.get(id);id=next?.size===1?[...next][0]:null;}return false;});
    if(cyclic){isolated.push({field:'placePaths',index,code:'QQJ_PLACE_PATH_SCOPE_CONFLICT',path:`placePaths[${index}]`});continue;}
    for(const entity of pathEntities){entities.push(entity);freshEntities.push(entity);byId.set(entity.id,entity);}
    for(const binding of pathBindings.slice(bindings.length)){bindings.push(binding);byKey.set(binding.entityKey,binding);}
    if (bodySource && !persistBodyPaths) {
      // The linked leaf and its explicit parent edges identify new path nodes;
      // a shared name by itself does not bind two places.
      let linked = leaf;
      for (let depth = pathNodes.length - 1; linked && depth >= 0; depth -= 1) {
        const node = pathNodes[depth], binding = byKey.get(linked.sameAsPlaceKey);
        if (binding && binding.entityId !== node.entityId) break;
        mentionById.set(node.entityId, linked.key);
        if (!depth) break;
        const parentKeys = new Set(spatial.containments.filter(edge => edge?.placeKey === linked.key).map(edge => edge.parentPlaceKey));
        const parent = pathNodes[depth - 1];
        const matches = spatial.places.filter(place => place && parentKeys.has(place.key) &&
          (byKey.get(place.sameAsPlaceKey)?.entityId === parent.entityId || place.identity === 'new' && label(place.name) === label(parent.name)));
        linked = matches.length === 1 ? matches[0] : null;
      }
    }
    parentId=null;let parentMention=null;
    for (const [depth, segment] of segments.entries()) {
      const {entityId,name,pathKey}=pathNodes[depth];
      const description = typeof segment.description === 'string' ? segment.description : depth === segments.length - 1 ? entry.description : undefined;
      const relations = Array.isArray(segment.relations) ? segment.relations : depth === segments.length - 1 ? entry.relations : undefined;
      const facilities = normalizePlaceFacilities(segment.facilities);
      const mapStyle=validQianchuangMapStyle(segment.mapStyle)?segment.mapStyle:undefined,mapLayout=validQianchuangMapLayout(segment.mapLayout,mapStyle)?segment.mapLayout:undefined;
      seenPaths.set(pathKey, entityId);
      const binding = bindings.find(binding => binding.entityId === entityId);
      if (depth === segments.length - 1 && leaf) { leaf.identity = 'existing'; leaf.sameAsPlaceKey = binding.entityKey; }
      let mention = mentionById.get(entityId);
      if (bodySource && !persistBodyPaths) {
        mention ??= depth === segments.length - 1 && entry.placeKey ? entry.placeKey : `place-mention-${++mentionIndex}`;
        const old = spatial.places.findIndex(place => place?.key === mention), prior = spatial.places[old];
        const value = { ...(prior?.identityChange ? { identityChange: prior.identityChange } : {}), ...(prior?.identityBasis ? { identityBasis: prior.identityBasis } : {}), ...(Array.isArray(prior?.aliases) ? { aliases: prior.aliases } : {}), key: mention, name, identity: 'existing', sameAsPlaceKey: binding.entityKey, exactQuote: quote, ...bodyEvidence };
        if (old >= 0) spatial.places[old] = value; else spatial.places.push(value);
        mentionById.set(entityId, mention);
      }
      if (parentId) {
        parents.set(entityId, new Set([parentId]));
        if (bodySource && !persistBodyPaths) {
          if (!bridge?.linkedEdges?.has(`${mention}:${parentMention}`) && !spatial.containments.some(edge => edge?.placeKey === mention && edge.parentPlaceKey === parentMention && edge.exactQuote === quote && edge.source === bodyEvidence.source && edge.sourceFloorKey === bodyEvidence.sourceFloorKey && edge.sourceSnapshotIndex === bodyEvidence.sourceSnapshotIndex)) spatial.containments.push({ placeKey: mention, parentPlaceKey: parentMention, exactQuote: quote, ...bodyEvidence });
        }
        else {
          const itemId = await deterministicUuid(['v3-worldbook-place', autoSource.locator, autoSource.fingerprint, entityId, parentId, 'containment']);
          facts.set(itemId, { itemId, kind: 'containment', placeEntityId: entityId, parentEntityId: parentId, knownFromFloorId: scope.floorId ?? null,
            source: autoSource });
        }
      }
      if (autoSource || facilities !== undefined || mapStyle || mapLayout || ['area','site','interior'].includes(segment.mapRole) || [null,'city','country','scope'].includes(segment.mapLevel)) {
        const displaySource = autoSource ?? { ...primary.source, ...(resolved.length > 1 ? { references: resolved.map(ref => ref.source) } : {}) };
        replaceFields.push({ entityId, kind: 'place' });
        const itemId = await deterministicUuid(['v3-worldbook-place', displaySource.locator, displaySource.fingerprint, entityId, 'place']);
        facts.set(itemId, { ...facts.get(itemId), itemId, kind: 'place', placeEntityId: entityId, ...(facilities !== undefined ? {facilities} : {}), ...(mapStyle?{mapStyle}:{}),...(mapLayout?{mapLayout}:{}), ...(['area','site','interior'].includes(segment.mapRole) ? { mapRole: segment.mapRole } : {}), ...([null,'city','country','scope'].includes(segment.mapLevel)?{mapLevel:segment.mapLevel}:{}), knownFromFloorId: scope.floorId ?? null,
          source: displaySource });
      }
      if (typeof description === 'string' && description.trim()) {
        const text = description.trim();
        if (bodySource && !persistBodyPaths) (spatial.features ??= []).push({ placeKey: mention, key: `feature-${(spatial.features?.length ?? 0) + 1}`, kind: 'stable', text, replacesKeys: [], exactQuote: quote, ...bodyEvidence });
        else {
          const itemId = await deterministicUuid(['v3-worldbook-place', autoSource.locator, autoSource.fingerprint, entityId, 'feature', text]);
          facts.set(itemId, { itemId, kind: 'feature', placeEntityId: entityId, text, knownFromFloorId: scope.floorId ?? null,
            source: autoSource });
        }
      }
      for (const raw of Array.isArray(relations) ? relations : []) {
        const text = typeof raw === 'string' ? raw.trim() : ''; if (!text) continue;
        if (bodySource && !persistBodyPaths) (spatial.relations ??= []).push({ kind: 'relative', placeKey: mention, referencePlaceKeys: [], text, exactQuote: quote, ...bodyEvidence });
        else {
          const itemId = await deterministicUuid(['v3-place-relation',autoSource.locator,autoSource.fingerprint,entityId,text]);
          facts.set(itemId, { itemId,kind:'relation',relationKind:'relative',placeEntityId:entityId,text,referencePlaceEntityIds:[],knownFromFloorId:scope.floorId??null,source:autoSource });
        }
      }
      if(autoSource&&parentId)replaceFields.push({entityId,kind:'containment'});
      if(autoSource){
        if(description!==undefined)replaceFields.push({entityId,kind:'feature'});
        if(relations!==undefined)replaceFields.push({entityId,kind:'relation'});
      }
      parentId = entityId; parentMention = mention;
    }
  }
  delete result.placePaths;
  const mapStyle=validQianchuangMapStyle(result.mapStyle)?result.mapStyle:undefined;delete result.mapStyle;
  const ids = new Set([...facts.values()].flatMap(fact => [fact.placeEntityId, fact.parentEntityId]).filter(Boolean));
  return { packet: result, entities, freshEntities, foundationPatch: { schemaVersion: 1, entities: entities.filter(entity => ids.has(entity.id)), facts: [...facts.values()], replaceFields, ...(mapStyle?{mapStyle}:{}) },
    envelope: { ...envelope, request: { ...envelope.request, payload: { ...envelope.request?.payload,
      knownPlaces: bindings.map(binding => envelope.request?.payload?.knownPlaces?.find(place => place.entityKey === binding.entityKey) ?? { entityKey: binding.entityKey, displayName: byId.get(binding.entityId)?.displayName, entityType: 'place', aliases: [] }) } },
      scope: { ...scope, placeCatalogBindings: bindings, parentEntityIdsByPlaceId: parents } }, isolated };
}

