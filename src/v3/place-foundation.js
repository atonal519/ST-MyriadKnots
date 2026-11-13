import { indexQianchuangWorldInfo } from '../place-worldbook-material.js';
import { cseWorldInfoKeyMatches } from '../cse-source-selection.js';
import { deterministicUuid } from './foundation-domain.js';
import { validateEntityRecord } from './memory-schema.js';
import { isUuid } from '../identity.js';
import { normalizePlaceFacilities, validQianchuangMapStyle, validQianchuangMapLayout, normalizeQianchuangMapLayout, normalizeQianchuangMapStyle } from '../qianchuang-display-hints.js';
import {selectQianchuangMapAsset} from '../qianchuang-map-assets.js';
import { locatePlaceQuote } from './place-evidence.js';
import { resolvePlaceParentBatch } from './place-parent.js';
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
  }).filter(Boolean);
}

function linkedBodyLeaf(entry, spatial, resolved, scope) {
  const source = resolved[0]?.body, nodes = new Map();
  const sameSource = refs => refs.length && refs.every(ref => ref.body
    && ref.body.floorId === source?.floorId && ref.body.sourceType === source?.sourceType
    && ref.body.sourceSnapshotIndex === source?.sourceSnapshotIndex);
  // The path already states the parent chain. Bind a unique declaration from
  // that same source without requiring the model to repeat its parent edges.
  for (const [depth, segment] of entry.path.entries()) {
    if (segment.placeKey || depth === entry.path.length - 1 && entry.placeKey) continue;
    const candidates = spatial.places.filter(place => typeof place?.name === 'string' && label(place.name) === label(segment.name));
    if (!candidates.length) continue;
    const place = candidates[0];
    if (!source || !sameSource(resolved) || candidates.length !== 1 || !/^place-mention-[1-9]\d*$/u.test(place?.key ?? '')
      || spatial.places.filter(other => other?.key === place.key).length !== 1
      || !(place.identity === 'new' ? !place.sameAsPlaceKey : place.identity === 'existing' && typeof place.sameAsPlaceKey === 'string' && place.sameAsPlaceKey.trim())
      || !sameSource(pathEvidence(place, scope))
      || segment.sameAsPlaceKey && segment.sameAsPlaceKey !== place.sameAsPlaceKey) return { conflict: true };
    nodes.set(depth, place);
  }
  return { leaf: nodes.get(entry.path.length - 1) ?? null, conflict: false, nodes };
}

const referencedSources = source => source?.references ?? (source ? [source] : []);

export const PLACE_CURRENT_GUIDANCE='地点description是本次已读资料合并后的完整、简洁当前简介，relations是完整当前方位说明，不是追加一段本楼复述。合并重复和同义说法，保留未改变的有效设施、布局和独立方位；新增或局部改造时只更新对应内容，不能因换书桌就丢床和卫浴。knownPlaces.description为已有合并简介，features为其余有来源事实；简介不作为可单项替换的known-feature。普通摘要在同一次输出placePaths中更新有真实新信息的地点，完整description/relations须保上述旧内容并合入本次变化；已有内容仅复述且无有效变化则省略字段，不重写。旧部分继续关联其原来源，exactQuote仅引用本次新增或变化的真实依据，不把旧陈设伪作本楼原句。人物临时在场、情绪、床单状态、灯光气味等现场不进入长期简介。显式整理还要把已有重复段落、多种同义方位视为需要归并的变化；即使无新增，也返回归并后的完整字段。省略保原，明确清空才返回空description或relations:[]。人工description/relations及空值优先。';

// These are the exact facts offered to this request, not every fact on their floors.
export function placeCurrentFactBindings(facts = []) {
 return facts.filter(fact=>isUuid(fact.itemId)&&isUuid(fact.placeEntityId)&&['feature','relation'].includes(fact.kind)).map(fact=>{
  const sources=fact.source?referencedSources(fact.source).map(({replacesItemIds,...source})=>source):(fact.evidenceRefs??[]).filter(ref=>ref.quotedText).map(ref=>({kind:'body',floorId:ref.floorId,locator:`floor:${ref.floorId}`,quote:ref.quotedText,...(ref.sourceType?{sourceType:ref.sourceType}:{}),...(ref.sourceSnapshotIndex!==undefined?{sourceSnapshotIndex:ref.sourceSnapshotIndex}:{})}));
  return {itemId:fact.itemId,placeEntityId:fact.placeEntityId,kind:fact.kind,text:fact.text,replacesItemIds:[...new Set([...(fact.replacesItemIds??[]),...(fact.source?.replacesItemIds??[])])],sources,
   ...(fact.source&&Array.isArray(fact.replacesItemIds)?{current:true,source:fact.source,knownFromFloorId:fact.knownFromFloorId}: {})};
 });
}

export function coveredPlaceItemIds(workspace,placeEntityId,kind) {
 const field=kind==='feature'?'description':kind==='containment'?'parentEntityId':'relations';
 if(Object.hasOwn(workspace?.placesByEntityId?.[placeEntityId]??{},field))return new Set();
 return new Set((workspace?.foundation?.facts??[]).filter(fact=>fact.kind===kind&&fact.placeEntityId===placeEntityId).flatMap(fact=>fact.replacesItemIds??[]));
}

export function placeParentFactBindings(memories = [], workspace = null, floorIds = null, resolve = id => id) {
 const rows = memories.flatMap(memory => (memory.spatialFacts?.containments ?? []).filter(edge => !floorIds
  || (edge.evidenceRefs ?? []).some(ref => floorIds.has(ref.floorId))));
 // The caller selects current versus prefix-scoped library; raw assertions retain their own floor bound.
 return [...rows,...effectiveFoundationFacts(workspace,memories).filter(fact=>fact.kind==='containment')]
  .filter(fact=>isUuid(fact.itemId)).map(fact=>({itemId:fact.itemId,placeEntityId:resolve(fact.placeEntityId),parentEntityId:fact.parentEntityId?resolve(fact.parentEntityId):null,
   replacesItemIds:fact.replacesItemIds??[]}));
}

function parentRevision(entityId,itemId,parentEntityId,source,scope) {
 const prior=(scope.placeParentFactBindings??[]).filter(fact=>fact.placeEntityId===entityId);
 return {itemId,kind:'containment',placeEntityId:entityId,parentEntityId,identityChange:'ownershipChanged',
  replacesItemIds:[...new Set(prior.flatMap(fact=>[fact.itemId,...(fact.replacesItemIds??[])]))].filter(id=>id!==itemId),
  knownFromFloorId:scope.floorId??null,source};
}

function currentFact(kind,entityId,itemId,text,source,scope,reuse=true) {
 const prior=(scope.placeCurrentFactBindings??[]).filter(fact=>fact.placeEntityId===entityId&&fact.kind===kind);
 const same=prior.find(fact=>fact.current&&fact.text===text);
 if(reuse&&same)return {itemId:same.itemId,kind,placeEntityId:entityId,text,knownFromFloorId:same.knownFromFloorId??null,replacesItemIds:same.replacesItemIds,source:same.source};
 const sources=[...referencedSources(source),...prior.flatMap(fact=>fact.sources??referencedSources(fact.source))];
 const references=[...new Map(sources.map(ref=>[JSON.stringify(ref),ref])).values()];
 return {itemId,kind,placeEntityId:entityId,text,knownFromFloorId:scope.floorId??null,
  replacesItemIds:[...new Set(prior.flatMap(fact=>[fact.itemId,...(fact.replacesItemIds??[])]))].filter(id=>id!==itemId),
  source:{...source,...(references.length>1?{references}:{})}};
}

export function completePlaceCurrentPatch(patch,memory) {
 const rows=placeCurrentFactBindings([...(memory.spatialFacts?.features??[]).filter(item=>item.kind==='stable').map(item=>({...item,kind:'feature'})),...(memory.spatialFacts?.relations??[]).map(item=>({...item,kind:'relation'}))]);
 return {...patch,facts:(patch.facts??[]).map(fact=>{
  if(!Array.isArray(fact.replacesItemIds))return fact;
  const field=fact.kind==='feature'?'features':'relations';
  if(!(memory.spatialFacts?.[field]??[]).some(item=>item.source&&item.placeEntityId===fact.placeEntityId&&item.text===fact.text))return fact;
  const current=currentFact(fact.kind,fact.placeEntityId,fact.itemId,fact.text,fact.source,{floorId:fact.knownFromFloorId,placeCurrentFactBindings:rows},false);
  return {...fact,replacesItemIds:[...new Set([...fact.replacesItemIds,...current.replacesItemIds])],source:current.source};
 })};
}

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
 for(const fact of value.facts)if(!isUuid(fact.itemId)||!isUuid(fact.placeEntityId)||!['place','containment','feature','relation'].includes(fact.kind)||fact.kind==='containment'&&!(isUuid(fact.parentEntityId)||fact.parentEntityId===null&&fact.identityChange==='ownershipChanged')
  ||Object.hasOwn(fact,'identityChange')&&!(fact.kind==='containment'&&fact.identityChange==='ownershipChanged'))throw new TypeError('地点索引结构无效。');
 for(const fact of value.facts)if(Object.hasOwn(fact,'replacesItemIds')&&(!(['feature','relation'].includes(fact.kind)||fact.kind==='containment'&&fact.identityChange==='ownershipChanged')||!Array.isArray(fact.replacesItemIds)||fact.replacesItemIds.some(id=>!isUuid(id)||id===fact.itemId)||new Set(fact.replacesItemIds).size!==fact.replacesItemIds.length))throw new TypeError('地点当前资料覆盖无效。');
 return value;
}

export function mergePlaceFoundation(workspace,patch={entities:[],facts:[]},removedItemIds=[]){
 const result=structuredClone(workspace),prior=result.foundation??{schemaVersion:1,entities:[],facts:[]};
 const entities=new Map(prior.entities.map(entity=>[entity.id,entity]));
 for(const entity of patch.entities??[])if(!entities.has(entity.id))entities.set(entity.id,entity);
 const replaced=new Set((patch.replaceFields??[]).map(value=>`${value.entityId}:${value.kind}`)),removed=new Set([...removedItemIds,...(patch.facts??[]).flatMap(fact=>fact.replacesItemIds??[])]);
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
 const sameFacts=prior.facts.length===facts.size&&prior.facts.every(fact=>JSON.stringify(facts.get(fact.itemId))===JSON.stringify(fact));
 result.foundation={schemaVersion:1,entities:[...entities.values()],facts:sameFacts?prior.facts:[...facts.values()]};
 if(validQianchuangMapStyle(patch.mapStyle))result.mapStyle=patch.mapStyle;
 return result;
}

export function filterPlaceFoundationSources(workspace,{filterWorldInfoSources=sources=>sources,floorIds=null}={}){
 if(!workspace?.foundation)return workspace;
 const facts=workspace.foundation.facts.filter(fact=>referencedSources(fact.source).every(source=>(source.kind!=='worldbook'||filterWorldInfoSources([{sourceName:source.sourceName??''}]).length)
  &&(source.kind!=='body'||!floorIds||floorIds.has(source.floorId)))&&(!floorIds||!Array.isArray(fact.replacesItemIds)||!fact.knownFromFloorId||floorIds.has(fact.knownFromFloorId)));
 const ids=new Set([...Object.keys(workspace.identityRedirectsByEntityId??{}),...Object.values(workspace.identityRedirectsByEntityId??{}),...facts.flatMap(fact=>[fact.placeEntityId,fact.parentEntityId,...(fact.referencePlaceEntityIds??[])].filter(Boolean))]);
 for(const [id,row]of Object.entries(workspace.placesByEntityId??{}))if(Object.keys(row.scopes??{}).length){ids.add(id);if(row.parentEntityId)ids.add(row.parentEntityId);}
 return {...workspace,foundation:{...workspace.foundation,facts,entities:workspace.foundation.entities.filter(entity=>ids.has(entity.id))}};
}

export function effectiveFoundationFacts(workspace,memories=[]){
 const canonical=id=>workspace?.identityRedirectsByEntityId?.[id]??id;
 const replaced=new Set(memories.flatMap(memory=>[...(memory.spatialFacts?.features??[]),...(memory.spatialFacts?.containments??[])].flatMap(fact=>fact.replacesItemIds??[])));
 return (workspace?.foundation?.facts??[]).filter(fact=>{
  if(replaced.has(fact.itemId))return false;
  const field=fact.kind==='containment'?'parentEntityId':fact.kind==='feature'?'description':'relations';
  return fact.kind==='place'||!Object.hasOwn(workspace.placesByEntityId?.[canonical(fact.placeEntityId)]??{},field);
 }).map(fact=>({...fact,placeEntityId:canonical(fact.placeEntityId),...(Object.hasOwn(fact,'parentEntityId')?{parentEntityId:canonical(fact.parentEntityId)}:{}),...(fact.referencePlaceEntityIds?{referencePlaceEntityIds:fact.referencePlaceEntityIds.map(canonical)}:{})}));
}

// Only the user's book exclusions participate in the existing revision receipt key.
export function placeWorkspaceDependency(chatId,revision,workspace){
 const books=[...new Set((workspace?.foundation?.facts??[]).flatMap(fact=>referencedSources(fact.source)).filter(source=>source.kind==='worldbook').map(source=>source.sourceName??''))].sort();
 return `${chatId}:${revision??0}${books.length?`:${JSON.stringify(books)}`:''}`;
}

// Replay explicit parent assertions together so later coarse ancestry cannot erase a known intermediate place.
export function projectPlaceParentLinks(memories, workspace, seqById, throughAssistantSeq = Infinity,
  libraryThroughAssistantSeq = throughAssistantSeq, { includeLocatedIn = false, resolve = id => id, baseIntents = [] } = {}) {
  const redirects = workspace?.identityRedirectsByEntityId ?? {};
  if (Object.keys(redirects).length) {
    const raw = projectPlaceParentLinks(memories, { ...workspace, identityRedirectsByEntityId: undefined }, seqById,
      throughAssistantSeq, libraryThroughAssistantSeq, { includeLocatedIn, baseIntents });
    const canonical = id => resolve(redirects[id] ?? id);
    const groups = new Map();
    for (const id of [...raw.keys(), ...Object.keys(redirects), ...Object.values(redirects)]) {
      const target = canonical(id), members = groups.get(target) ?? new Set(); members.add(id); groups.set(target, members);
    }
    const externalParent = (owner, target) => {
      const chain = [], seen = new Set([owner]); let current = owner;
      while (raw.get(current)?.parents.size === 1) {
        current = raw.get(current).parents.keys().next().value;
        if (seen.has(current)) return null;
        seen.add(current); chain.push(current);
      }
      let start = 0;
      for (const [index, id] of chain.entries()) if (canonical(id) === target) start = index + 1;
      return chain[start] ? canonical(chain[start]) : null;
    };
    const result = new Map();
    for (const [target, members] of groups) {
      const direct = raw.get(target);
      if (Object.hasOwn(workspace.placesByEntityId?.[target] ?? {}, 'parentEntityId') && workspace.placesByEntityId[target].parentEntityId === null) {
        result.set(target, { seq: Infinity, parents: new Map() }); continue;
      }
      let selected = null;
      for (const id of [target, ...Object.keys(redirects).filter(id => canonical(id) === target), ...members]) {
        const value = raw.get(id);
        if (!value) continue;
        if (id === target && value.cleared) { selected = value; break; }
        const parent = externalParent(id, target);
        if (!parent || parent === target) continue;
        const origin = value.parents.values().next().value;
        selected = { ...value, parents: new Map([[parent, origin]]) }; break;
      }
      result.set(target, selected ?? { ...(direct ?? { seq: 0 }), parents: new Map() });
    }
    return result;
  }
  const intents = [...baseIntents];
  for (const memory of memories) {
    if (memory.recordStatus && memory.recordStatus !== 'active') continue;
    const edges = [...(memory.spatialFacts?.containments ?? []), ...(includeLocatedIn ? (memory.spatialFacts?.relations ?? [])
      .filter(edge => edge.kind === 'locatedIn' && edge.referencePlaceEntityIds?.length === 1)
      .map(edge => ({ ...edge, parentEntityId: edge.referencePlaceEntityIds[0] })) : [])];
    for (const edge of edges) {
      const refs = (edge.evidenceRefs ?? edge.sourceRefs ?? []).map(ref => ({ ref,
        seq: ref.assistantSeq ?? seqById.get(ref.floorId) ?? (ref.floorId === memory.floorId ? memory.assistantSeq : 0) }))
        .filter(value => value.seq > 0 && value.seq <= throughAssistantSeq);
      if (!refs.length) continue;
      const latest = refs.reduce((a,b) => a.seq >= b.seq ? a : b);
      intents.push({ placeEntityId: resolve(edge.placeEntityId), parentEntityId: resolve(edge.parentEntityId), seq: latest.seq,
        itemId:edge.itemId,replacesItemIds:edge.replacesItemIds,identityChange:edge.identityChange,
        authority:edge.identityChange==='ownershipChanged'?1:0,sourceFloorId: latest.ref.floorId, sourceAssistantSeq: latest.seq });
    }
  }
  const prefix = Number.isFinite(libraryThroughAssistantSeq) ? filterPlaceFoundationSources(workspace,
    { floorIds: new Set([...seqById].filter(([,seq]) => seq <= libraryThroughAssistantSeq).map(([id]) => id)) }) : workspace;
  for (const fact of effectiveFoundationFacts(prefix).filter(fact => fact.kind === 'containment')) {
    const seq = seqById.get(fact.knownFromFloorId) ?? 0;
    if (seq <= libraryThroughAssistantSeq) intents.push({ placeEntityId: resolve(fact.placeEntityId), parentEntityId: resolve(fact.parentEntityId), seq,
      itemId:fact.itemId,replacesItemIds:fact.replacesItemIds,identityChange:fact.identityChange,
      sourceFloorId: fact.knownFromFloorId ?? null, sourceAssistantSeq: seq, authority: 1 });
  }
  const covered = new Set(intents.flatMap(intent => intent.replacesItemIds ?? []));
  const bySeq = new Map();
  for (const intent of intents) {
    if (!intent.placeEntityId || !intent.parentEntityId && !(intent.parentEntityId === null && intent.identityChange === 'ownershipChanged') || covered.has(intent.itemId)) continue;
    const rows = bySeq.get(intent.seq) ?? [];
    rows.push({ ...intent, origin: { sourceFloorId: intent.sourceFloorId, sourceAssistantSeq: intent.sourceAssistantSeq } });
    bySeq.set(intent.seq, rows);
  }
  const manualParents = new Map(Object.entries(workspace?.placesByEntityId ?? {}).filter(([id, row]) => !workspace?.identityRedirectsByEntityId?.[id] && Object.hasOwn(row, 'parentEntityId'))
    .map(([id, row]) => [resolve(id), new Map(row.parentEntityId ? [[resolve(row.parentEntityId), { manual: true }]] : [])]));
  const latest = new Map();
  for (const [seq, rows] of [...bySeq].sort(([a], [b]) => a - b)) {
    const { updates } = resolvePlaceParentBatch(rows, { previous: latest, manual: manualParents });
    for (const [child, value] of updates) latest.set(child, { seq, ...value });
  }
  for (const [id, parents] of manualParents) latest.set(id, { seq: Infinity, parents });
  return latest;
}

function makeSeed(id, name, scope, now) {
  return validateEntityRecord({ schemaVersion: 3, recordType: 'entity', id, chatId: scope.chatId, narrativeGeneration: scope.narrativeGeneration,
    entityType: 'place', displayName: name, aliases: [], specialRole: 'none', firstSeenFloorId: null, lastSeenFloorId: null, status: 'provisional',
    mergedIntoEntityId: null, mergeEvidenceRefs: [], baselineClaimIds: [], createdAt: now, updatedAt: now, recordStatus: 'active', supersedes: null });
}


export async function expandPlacePaths({ packet, envelope, existingEntities = [], now, persistBodyPaths = false, deferParentResolution = false }) {
  const result = copy(packet), scope = envelope.scope, entities = [...existingEntities], byId = new Map(entities.map(entity => [entity.id, entity]));
  const existingPlaceIds = new Set((scope.placeCatalogBindings??[]).map(binding=>binding.entityId));
  const bindings = [...(scope.placeCatalogBindings ?? [])], byKey = new Map(bindings.map(binding => [binding.entityKey, binding]));
  const parents = new Map(scope.parentEntityIdsByPlaceId ?? []), seenPaths = new Map(), facts = new Map(), isolated = [], replaceFields = [], displayMetadataBindings = [];
  const parentPathIndex = new Map(), factPathIndexes = new Map(), entityPathIndexes = new Map();
  let activePathIndex = -1;
  const recordFact = (itemId, fact) => {
    const owners = factPathIndexes.get(itemId) ?? new Set(); owners.add(activePathIndex); factPathIndexes.set(itemId, owners);
    facts.set(itemId, fact);
  };
  const input = result.spatialFacts;
  const spatial = input && typeof input === 'object' && !Array.isArray(input) ? input : (result.spatialFacts = { places: [], containments: [], positions: [] });
  if (input !== undefined && spatial !== input) isolated.push({ field: 'spatialFacts', index: -1, code: 'V3_EXTRACTOR_OBJECT_INVALID', path: 'spatialFacts' });
  for (const key of ['places','containments','features','relations']) {
    if (spatial[key] !== undefined && !Array.isArray(spatial[key])) {
      isolated.push({ field: `spatialFacts.${key}`, index: -1, code: 'V3_EXTRACTOR_ARRAY_INVALID', path: `spatialFacts.${key}` }); spatial[key] = [];
    }
  }
  spatial.places ??= []; spatial.containments ??= [];
  // Bind only original declarations; earlier expanded paths do not establish identity.
  const linkedInput={places:spatial.places.map(place=>place&&{...place})};

  const localPlace = key => {
    if (typeof key !== 'string' || !/^place-mention-[1-9]\d*$/u.test(key)) return null;
    const originals = linkedInput.places.filter(place => place?.key === key);
    if (originals.length !== 1) return null;
    return spatial.places.find(place => place?.key === key) ?? null;
  };
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
    activePathIndex = index;
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
    const clearParent=Object.hasOwn(entry,'parentPlaceKey');
    if(clearParent&&(entry.parentPlaceKey!==null||entry.identityChange!=='ownershipChanged'||entry.path.length!==1||!byKey.has(entry.path[0].sameAsPlaceKey))){
      isolated.push({field:'placePaths',index,code:'QQJ_PLACE_PATH_SCOPE_CONFLICT',path:`placePaths[${index}]`});continue;
    }
    const bodySource = resolved.every(ref => ref.body) ? resolved[0].body : null;
    const quote = resolved[0].source.quote;
    const bodyEvidence = bodySource ? { ...resolved[0].semantic,
      ...(resolved.length > 1 ? { _placePathEvidence: resolved.map(ref => ref.semantic) } : {}) } : {};
    const primary = resolved.find(ref => ref.source.kind === 'worldbook') ?? resolved[0];
    const autoSource = !bodySource || persistBodyPaths ? { ...primary.source,
      ...(resolved.length > 1 ? { references: resolved.map(ref => ref.source) } : {}) } : null;
    const explicitLeafKey = entry.placeKey ?? entry.path.at(-1).placeKey;
    const nodeKeys = entry.path.map((segment, depth) => depth === entry.path.length - 1 ? explicitLeafKey : segment.placeKey).filter(key => key !== undefined);
    const explicitNodes = new Map();
    let invalidLink = new Set(nodeKeys).size !== nodeKeys.length
      || Object.hasOwn(entry, 'placeKey') && !localPlace(entry.placeKey)
      || entry.placeKey && entry.path.at(-1).placeKey && entry.placeKey !== entry.path.at(-1).placeKey;
    for (const [depth, segment] of entry.path.entries()) {
      if (!Object.hasOwn(segment, 'placeKey')) continue;
      const linked = localPlace(segment.placeKey);
      if (!linked) invalidLink = true;
      else explicitNodes.set(depth, linked);
    }
    if (invalidLink) { isolated.push({ field: 'placePaths', index, code: 'QQJ_PLACE_PATH_IDENTITY_INVALID', path: `placePaths[${index}]` }); continue; }
    let leaf = explicitLeafKey ? localPlace(explicitLeafKey) : undefined;
    if (leaf) explicitNodes.set(entry.path.length - 1, leaf);
    let bridge = null;
    if (bodySource && !persistBodyPaths && !clearParent) {
      const linked=linkedBodyLeaf(entry,linkedInput,resolved,scope);
      if(linked.conflict){isolated.push({field:'placePaths',index,code:'QQJ_PLACE_PATH_IDENTITY_INVALID',path:`placePaths[${index}]`});continue;}
      leaf??=spatial.places.find(place=>place?.key===linked.leaf?.key);bridge=linked;
    }
    const segments = entry.path.map((segment, i) => {
      const linked = explicitNodes.get(i) ?? bridge?.nodes?.get(i) ?? (i === entry.path.length - 1 ? leaf : null);
      const linkedBinding = linked?.identity === 'existing' ? byKey.get(linked.sameAsPlaceKey) : null;
      if (linkedBinding && segment.sameAsPlaceKey && linkedBinding.entityId !== byKey.get(segment.sameAsPlaceKey)?.entityId) invalidLink = true;
      return { ...segment, ...(linked?.sameAsPlaceKey && !segment.sameAsPlaceKey ? { sameAsPlaceKey: linked.sameAsPlaceKey } : {}) };
    });
    if (invalidLink || segments.some(segment => segment.sameAsPlaceKey && !byKey.has(segment.sameAsPlaceKey))) {
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
    // Resolve path identities before deciding the batch containment constraints.
    const pathNodes = [], pathEntities = [], pathBindings = [...bindings], pathParents = new Map(parents), pathSeen = new Map(seenPaths);
    let parentId = null;
    for (const [depth, segment] of segments.entries()) {
      const name = segment.name.trim(), pathKey = JSON.stringify([parentId, label(name)]);
      const local = explicitNodes.get(depth) ?? bridge?.nodes?.get(depth);
      const localIdentity = linkedInput.places.find(place => place?.key === local?.key);
      let entityId = localIdentity?.identity === 'new' && !(scope.placeCatalogBindings ?? []).some(binding => binding.entityKey === segment.sameAsPlaceKey)
        ? await deterministicUuid(['v3-place-path-local', scope.chatId, scope.narrativeGeneration, scope.batchId, localIdentity.key])
        : byKey.get(segment.sameAsPlaceKey)?.entityId ?? pathSeen.get(pathKey);
      if (!entityId) {
        const matches = pathBindings.filter(binding => (binding.labels ?? []).some(value => label(value) === label(name))
          && (parentId ? pathParents.get(binding.entityId)?.has(parentId) : !pathParents.get(binding.entityId)?.size));
        if (matches.length === 1) entityId = matches[0].entityId;
      }
      if (!entityId && segment.mapLevel === 'city') {
        // A newly supplied country can extend an existing root city's ancestry.
        const matches = (scope.placeCatalogBindings ?? []).filter(binding => (binding.labels ?? []).some(value => label(value) === label(name)));
        if (matches.length === 1 && !originalParents.get(matches[0].entityId)?.size) entityId = matches[0].entityId;
      }
      if (!entityId) {
        entityId = await deterministicUuid(['v3-place-path', scope.chatId, scope.narrativeGeneration, scope.batchId, parentId, label(name)]);
      }
      if (!byId.has(entityId) && !pathEntities.some(entity => entity.id === entityId)) {
        pathEntities.push(makeSeed(entityId, name, scope, now));
        pathBindings.push({ entityKey: `place-path-${pathBindings.length + 1}`, entityId, entityType: 'place', specialRole: 'none', labels: [name] });
      }
      pathSeen.set(pathKey, entityId);pathNodes.push({ entityId, name, pathKey });
      if(parentId)pathParents.set(entityId,new Set([parentId]));parentId=entityId;
    }
    const lastKnownDepth = pathNodes.reduce((last,node,depth)=>existingPlaceIds.has(node.entityId)?depth:last,-1);
    if (pathNodes.some(node=>(scope.deletedPlaceIds??[]).includes(node.entityId))
      || envelope.request?.payload?.mode==='organize'&&pathNodes.some((node,depth)=>depth>lastKnownDepth)) {
      isolated.push({field:'placePaths',index,code:'QQJ_PLACE_PATH_SCOPE_CONFLICT',path:`placePaths[${index}]`});continue;
    }
    if(clearParent)pathParents.delete(pathNodes[0].entityId);
    if (new Set(pathNodes.map(node => node.entityId)).size !== pathNodes.length) {
      isolated.push({ field: 'placePaths', index, code: 'QQJ_PLACE_PATH_SCOPE_CONFLICT', path: `placePaths[${index}]` }); continue;
    }
    for (const { entityId } of pathNodes) {
      const owners = entityPathIndexes.get(entityId) ?? new Set(); owners.add(index); entityPathIndexes.set(entityId, owners);
    }
    for(const entity of pathEntities){entities.push(entity);freshEntities.push(entity);byId.set(entity.id,entity);}
    for(const binding of pathBindings.slice(bindings.length)){bindings.push(binding);byKey.set(binding.entityKey,binding);}
    for (const [depth, linked] of new Map([...(bridge?.nodes ?? []), ...explicitNodes])) {
      const node = pathNodes[depth], binding = bindings.find(binding => binding.entityId === node.entityId);
      const declaration = spatial.places.find(place => place?.key === linked.key);
      declaration.identity = 'existing'; declaration.sameAsPlaceKey = binding.entityKey;
      mentionById.set(node.entityId, linked.key);
    }
    if (bodySource && !persistBodyPaths) {
      // Explicit local edges can also bind declarations whose parent has a different surface name.
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
      const revision=envelope.request?.task==='organizePlaces'||depth===segments.length-1&&entry.identityChange==='ownershipChanged';
      const mapStyle=normalizeQianchuangMapStyle(segment.mapStyle),mapLayout=normalizeQianchuangMapLayout(segment.mapLayout,mapStyle);
      seenPaths.set(pathKey, entityId);
      const binding = bindings.find(binding => binding.entityId === entityId);
      if (depth === segments.length - 1 && leaf) { leaf.identity = 'existing'; leaf.sameAsPlaceKey = binding.entityKey; }
      let mention = mentionById.get(entityId);
      if (bodySource && !persistBodyPaths) {
        mention ??= depth === segments.length - 1 && explicitLeafKey ? explicitLeafKey : `place-mention-${++mentionIndex}`;
        const old = spatial.places.findIndex(place => place?.key === mention), prior = spatial.places[old];
        const surface = explicitNodes.get(depth)?.key === mention && typeof prior?.name === 'string' ? prior.name : name;
        const value = { ...(revision?{identityChange:'ownershipChanged'}:prior?.identityChange?{identityChange:prior.identityChange}:{}), ...(prior?.identityBasis ? { identityBasis: prior.identityBasis } : {}), ...(Array.isArray(prior?.aliases) ? { aliases: prior.aliases } : {}), key: mention, name: surface, identity: 'existing', sameAsPlaceKey: binding.entityKey, exactQuote: quote, ...bodyEvidence };
        if (old >= 0) spatial.places[old] = value; else spatial.places.push(value);
        mentionById.set(entityId, mention);
      }
      if (parentId) {
        parents.set(entityId, new Set([parentId]));
        if (bodySource && !persistBodyPaths) {
          if (!spatial.containments.some(edge => edge?.placeKey === mention && edge.parentPlaceKey === parentMention && edge.exactQuote === quote && edge.source === bodyEvidence.source && edge.sourceFloorKey === bodyEvidence.sourceFloorKey && edge.sourceSnapshotIndex === bodyEvidence.sourceSnapshotIndex)) spatial.containments.push({ placeKey: mention, parentPlaceKey: parentMention, exactQuote: quote, ...bodyEvidence, _placePathIndex: index });
        }
        else {
          const itemId = await deterministicUuid(['v3-worldbook-place', autoSource.locator, autoSource.fingerprint, entityId, parentId, 'containment']);
          parentPathIndex.set(itemId,index);
          recordFact(itemId, revision?parentRevision(entityId,itemId,parentId,autoSource,scope):{ itemId, kind: 'containment', placeEntityId: entityId, parentEntityId: parentId, knownFromFloorId: scope.floorId ?? null,source: autoSource });
        }
      }
      if(clearParent){
        parents.delete(entityId);
        if(bodySource&&!persistBodyPaths)spatial.containments.push({placeKey:mention,parentPlaceKey:null,...bodyEvidence,_placePathIndex:index});
        else{
          const itemId=await deterministicUuid(['v3-worldbook-place',autoSource.locator,autoSource.fingerprint,entityId,null,'containment']);
          parentPathIndex.set(itemId,index);
          recordFact(itemId,parentRevision(entityId,itemId,null,autoSource,scope));
          replaceFields.push({entityId,kind:'containment'});
        }
      }
      let displayFactItemId;
      if (autoSource || facilities !== undefined || mapStyle || mapLayout || ['area','site','interior'].includes(segment.mapRole) || [null,'city','country','scope'].includes(segment.mapLevel)) {
        const displaySource = autoSource ?? { ...primary.source, ...(resolved.length > 1 ? { references: resolved.map(ref => ref.source) } : {}) };
        const itemId = await deterministicUuid(['v3-worldbook-place', displaySource.locator, displaySource.fingerprint, entityId, 'place']);
        const value={ ...facts.get(itemId), itemId, kind: 'place', placeEntityId: entityId, ...(facilities !== undefined ? {facilities} : {}), ...(mapStyle?{mapStyle}:{}),...(mapLayout?{mapLayout}:{}), ...(['area','site','interior'].includes(segment.mapRole) ? { mapRole: segment.mapRole } : {}), ...([null,'city','country','scope'].includes(segment.mapLevel)?{mapLevel:segment.mapLevel}:{}), knownFromFloorId: scope.floorId ?? null,source:displaySource };
        const existing=scope.identityProjection?.placeWorkspace?.foundation?.facts??[],old=existing.find(fact=>fact.kind==='place'&&fact.placeEntityId===entityId),keys=['mapRole','mapLevel','facilities','mapStyle','mapLayout'].filter(key=>Object.hasOwn(value,key));
        const same=Object.hasOwn(scope,'placeCurrentFactBindings')&&old&&keys.every(key=>JSON.stringify(old[key])===JSON.stringify(value[key]));
        if(same||keys.length||!Object.hasOwn(scope,'placeCurrentFactBindings')||!existing.some(fact=>fact.placeEntityId===entityId)){
          const fact=same?old:value;replaceFields.push({entityId,kind:'place'});recordFact(fact.itemId,fact);displayFactItemId=fact.itemId;
        }
      }
      if (envelope.request?.task === 'organizePlaces' && ['mapLevel','mapStyle','mapLayout'].some(key => Object.hasOwn(segment,key))) {
        displayMetadataBindings.push({pathIndex:index,nodeIndex:depth,entityId,...(displayFactItemId?{itemId:displayFactItemId}:{})});
      }
      const manual=envelope.request?.payload?.knownPlaces?.find(place=>place.entityKey===binding?.entityKey)?.manualCurrentFacts??{};
      if (typeof description === 'string' && !Object.hasOwn(manual,'description')) {
        const text = description.trim();
        const source=autoSource??{...primary.source,...(resolved.length>1?{references:resolved.map(ref=>ref.source)}:{})};
        const itemId = await deterministicUuid(['v3-worldbook-place', source.locator, source.fingerprint, entityId, 'feature', text]);
        const prior=(scope.placeCurrentFactBindings??[]).filter(fact=>fact.placeEntityId===entityId&&fact.kind==='feature');
        const fact=currentFact('feature',entityId,itemId,text,source,scope,prior.length===1&&prior[0].current===true);recordFact(fact.itemId,fact);
      }
      for (const raw of Array.isArray(relations)&&!Object.hasOwn(manual,'relations') ? relations.length?relations:[''] : []) {
        const text = typeof raw === 'string' ? raw.trim() : '';if(typeof raw!=='string')continue;
        const source=autoSource??{...primary.source,...(resolved.length>1?{references:resolved.map(ref=>ref.source)}:{})};
        const itemId = await deterministicUuid(['v3-place-relation',source.locator,source.fingerprint,entityId,text]);
        const prior=(scope.placeCurrentFactBindings??[]).filter(fact=>fact.placeEntityId===entityId&&fact.kind==='relation'),texts=relations.length?relations.map(text=>text.trim()):[''];
        const unchanged=prior.length===texts.length&&prior.every(fact=>fact.current&&texts.includes(fact.text));
        const fact={...currentFact('relation',entityId,itemId,text,source,scope,unchanged),relationKind:'relative',referencePlaceEntityIds:[]};recordFact(fact.itemId,fact);
      }
      if(autoSource&&parentId)replaceFields.push({entityId,kind:'containment'});
      if(autoSource){
        if(!Object.hasOwn(scope,'placeCurrentFactBindings')){
          if(description!==undefined)replaceFields.push({entityId,kind:'feature'});
          if(relations!==undefined)replaceFields.push({entityId,kind:'relation'});
        }
      }
      parentId = entityId; parentMention = mention;
    }
  }
  if (!deferParentResolution) {
    const tokenFor = key => {
      const place = spatial.places.find(place => place?.key === key);
      return byKey.get(place?.sameAsPlaceKey)?.entityId ?? key;
    };
    const parentEdges = spatial.containments;
    const validBodyParent = edge => edge._placePathIndex !== undefined;
    const bodyIntents = parentEdges.flatMap(edge => !validBodyParent(edge) ? [] : [{
      placeEntityId: tokenFor(edge.placeKey), parentEntityId: edge.parentPlaceKey === null ? null : tokenFor(edge.parentPlaceKey),
      identityChange: spatial.places.find(place => place?.key === edge.placeKey)?.identityChange,
      authority: edge._placePathIndex === undefined ? 0 : 1, edge,
    }]);
    const foundationIntents = [...facts.values()].filter(fact => fact.kind === 'containment').map(fact => ({ ...fact, authority: 2 }));
    const previous = new Map([...originalParents].map(([id, parents]) => [id, { parents: new Map([...parents].map(parent => [parent, {}])) }]));
    const manual = new Map(Object.entries(scope.identityProjection?.placeWorkspace?.placesByEntityId ?? {}).filter(([, row]) => Object.hasOwn(row, 'parentEntityId'))
      .map(([id, row]) => [id, new Map(row.parentEntityId ? [[row.parentEntityId, { manual: true }]] : [])]));
    const decision = resolvePlaceParentBatch([...bodyIntents, ...foundationIntents], { previous, manual, preservePreviousRefinements: false });
    const validBody = new Set(bodyIntents.filter(intent => decision.compatible.has(intent)).map(intent => intent.edge));
    const keepParentEdge = edge => !bodyIntents.some(intent => intent.edge === edge) || validBody.has(edge) || decision.rejected.has(tokenFor(edge.placeKey));
    spatial.containments = spatial.containments.filter(keepParentEdge);
    for (const child of decision.rejected) if (bodyIntents.some(intent => intent.placeEntityId === child)) isolated.push({
      field: 'spatialFacts.places', index: -1, code: 'V3_EXTRACTOR_SPATIAL_PLACE_SCOPE_CONFLICT', path: 'spatialFacts.places',
    });
    for (const fact of foundationIntents) if (decision.rejected.has(fact.placeEntityId)) facts.delete(fact.itemId);
    const rejectedPathIndexes = new Set([...bodyIntents.filter(intent => decision.rejected.has(intent.placeEntityId)).map(intent => intent.edge._placePathIndex),
      ...foundationIntents.filter(intent => decision.rejected.has(intent.placeEntityId)).map(intent => parentPathIndex.get(intent.itemId))].filter(index => index !== undefined));
    for (const index of rejectedPathIndexes) isolated.push({ field: 'placePaths', index, code: 'QQJ_PLACE_PATH_SCOPE_CONFLICT', path: `placePaths[${index}]` });
    for (const [itemId, owners] of factPathIndexes) if ([...owners].every(index => rejectedPathIndexes.has(index))) facts.delete(itemId);
    const rejectedEntities = new Set([...entityPathIndexes].filter(([id, owners]) => freshEntities.some(entity => entity.id === id)
      && [...owners].every(index => rejectedPathIndexes.has(index))).map(([id]) => id));
    for (let index = freshEntities.length - 1; index >= 0; index -= 1) if (rejectedEntities.has(freshEntities[index].id)) freshEntities.splice(index, 1);
    for (let index = entities.length - 1; index >= 0; index -= 1) if (rejectedEntities.has(entities[index].id)) entities.splice(index, 1);
    for (let index = bindings.length - 1; index >= 0; index -= 1) if (rejectedEntities.has(bindings[index].entityId)) bindings.splice(index, 1);
    for (let index = replaceFields.length - 1; index >= 0; index -= 1) if (!([...facts.values()].some(fact => fact.placeEntityId === replaceFields[index].entityId && fact.kind === replaceFields[index].kind))) replaceFields.splice(index, 1);
    for (let index = displayMetadataBindings.length - 1; index >= 0; index -= 1) if (rejectedPathIndexes.has(displayMetadataBindings[index].pathIndex)) displayMetadataBindings.splice(index, 1);
  }
  delete result.placePaths;
  const mapStyle=normalizeQianchuangMapStyle(result.mapStyle);delete result.mapStyle;
  const ids = new Set([...facts.values()].flatMap(fact => [fact.placeEntityId, fact.parentEntityId]).filter(Boolean));
  return { packet: result, entities, freshEntities, foundationPatch: { schemaVersion: 1, entities: entities.filter(entity => ids.has(entity.id)), facts: [...facts.values()], replaceFields, ...(mapStyle?{mapStyle}:{}) },
    envelope: { ...envelope, request: { ...envelope.request, payload: { ...envelope.request?.payload,
      knownPlaces: bindings.map(binding => envelope.request?.payload?.knownPlaces?.find(place => place.entityKey === binding.entityKey) ?? { entityKey: binding.entityKey, displayName: byId.get(binding.entityId)?.displayName, entityType: 'place', aliases: [] }) } },
      scope: { ...scope, placeCatalogBindings: bindings, parentEntityIdsByPlaceId: originalParents } }, isolated, displayMetadataBindings, pathOrigins: { parentPathIndex, factPathIndexes } };
}

