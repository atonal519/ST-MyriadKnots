import {isUuid} from '../identity.js';

export function validatePlaceSource(source) {
 const valid=ref=>ref&&typeof ref==='object'&&['body','worldbook','characterCard'].includes(ref.kind)&&typeof ref.quote==='string'&&ref.quote.length>0&&(ref.kind!=='body'||isUuid(ref.floorId));
 if(!valid(source)||source.references!==undefined&&(!Array.isArray(source.references)||source.references.some(ref=>!valid(ref)||ref.references!==undefined))||source.replacesItemIds!==undefined&&(!Array.isArray(source.replacesItemIds)||source.replacesItemIds.some(id=>!isUuid(id)))||source.knownFromFloorId!==undefined&&!isUuid(source.knownFromFloorId))throw new TypeError('地点来源格式无效。');
 return source;
}

export function locatePlaceQuote(content, quote, { allowWhitespace = false, allowOmission = false } = {}) {
  if (typeof content !== 'string' || typeof quote !== 'string' || !quote.trim()) return null;
  const offset = content.indexOf(quote);
  if (offset >= 0) return [{ quote, start: offset, end: offset + quote.length }];
  if (allowWhitespace) {
    const pattern = quote.trim().split(/\s+/u).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    const matches = [...content.matchAll(new RegExp(pattern, 'gu'))];
    if (matches.length === 1) return [{ quote: matches[0][0], start: matches[0].index, end: matches[0].index + matches[0][0].length }];
  }
  if (!allowOmission) return null;
  const segments = quote.split(/\u2026+|\.{3,}/u).map(segment => segment.trim());
  if (segments.length < 2 || segments.length > 8 || segments.some(segment => !segment || segment.length > 2000)) return null;
  const located = [];
  for (const segment of segments) {
    const start = content.indexOf(segment);
    if (start < 0 || content.indexOf(segment, start + 1) >= 0 || start < (located.at(-1)?.end ?? 0)) return null;
    located.push({ quote: segment, start, end: start + segment.length });
  }
  return located;
}
import { projectVectorSources } from './vector-source.js';
import { storedSourceUserInput } from './user-input-source.js';


export async function collectMissingPlaceSources({ entities, entityKeys, bodySources, floors, memoriesByFloor }) {
  const covered = new Set(bodySources.flatMap(source => source.placeKeys ?? []));
  const places = entities.filter(entity => entity.entityType === 'place' && entityKeys.has(entity.id));
  const needed = new Set(places.filter(entity => !covered.has(entityKeys.get(entity.id)) && entity.firstSeenFloorId).map(entity => entity.firstSeenFloorId));
  if (!needed.size) return [];
  const memories = [...new Map([...needed].flatMap(floorId => { const memory = memoriesByFloor.get(floorId); return memory ? [[memory.id, memory]] : []; })).values()];
  const { rawSources } = await projectVectorSources(memories, floors, { includeSummaries: false });
  const seen = new Set();
  return rawSources.flatMap(source => {
    if (!needed.has(source.floorId) || seen.has(source.floorId)) return [];
    seen.add(source.floorId);
    return [{ floorId: source.floorId, memoryId: source.floorMemoryId, sourceType: 'assistant', rawFingerprint: source.floorMemoryId,
      canonicalContent: source.canonicalContent, requiresExactQuote: true,
      placeKeys: places.filter(entity => entity.firstSeenFloorId === source.floorId).map(entity => entityKeys.get(entity.id)) }];
  });
}

function paragraphContext(content, names, quotes) {
  const paragraphs=[];let start=0;
  for(const match of content.matchAll(/\n[ \t]*\n/gu)){
    if(match.index>start)paragraphs.push({start,end:match.index});
    start=match.index+match[0].length;
  }
  if(start<content.length)paragraphs.push({start,end:content.length});
  const quoteRanges=quotes.flatMap(quote=>{
    const ranges=[];let at=content.indexOf(quote);
    while(at>=0){ranges.push({start:at,end:at+quote.length});at=content.indexOf(quote,at+Math.max(1,quote.length));}
    return ranges;
  });
  const selected=new Set();
  for(const [index,paragraph] of paragraphs.entries()){
    const text=content.slice(paragraph.start,paragraph.end).toLocaleLowerCase();
    if(names.some(name=>text.includes(name))||quoteRanges.some(range=>range.start<paragraph.end&&paragraph.start<range.end)){
      for(let neighbor=Math.max(0,index-1);neighbor<=Math.min(paragraphs.length-1,index+1);neighbor++)selected.add(neighbor);
    }
  }
  const ranges=[];
  for(const index of [...selected].sort((a,b)=>a-b)){
    const previous=ranges.at(-1),paragraph=paragraphs[index];
    if(previous&&previous.last===index-1){previous.end=paragraph.end;previous.last=index;}
    else ranges.push({...paragraph,last:index});
  }
  return ranges.map(({start,end})=>({content:content.slice(start,end),offset:start}));
}

export async function collectPlaceOrganizationSources({entities,entityKeys,places,bodySources,contextSources=bodySources,floors,memoriesByFloor,parentFacts=[]}) {
  const keysByFloor=new Map(),available=new Set(floors.map(floor=>floor.id));
  const add=(floorId,ids)=>{
    if(!available.has(floorId))return;
    const keys=keysByFloor.get(floorId)??new Set();
    for(const id of ids)if(entityKeys.has(id))keys.add(entityKeys.get(id));
    if(keys.size)keysByFloor.set(floorId,keys);
  };
  for(const entity of entities)if(entity.entityType==='place')add(entity.firstSeenFloorId,[entity.id]);
  for(const fact of parentFacts){
    const ids=[fact.placeEntityId,fact.parentEntityId];
    for(const ref of fact.evidenceRefs??[])add(ref.floorId,ids);
    for(const ref of fact.source?[fact.source,...(fact.source.references??[])]:[])if(ref.kind==='body')add(ref.floorId,ids);
  }
  const memories=[...new Map([...keysByFloor.keys()].flatMap(floorId=>{
    const memory=memoriesByFloor.get(floorId);return memory?[[memory.id,memory]]:[];
  })).values()];
  const {rawSources}=await projectVectorSources(memories,floors,{includeSummaries:false});
  const placesByKey=new Map(places.map(place=>[entityKeys.get(place.entityId),place]));
  const contexts=[],seen=new Set();
  const sameSource=(a,b)=>a.floorId===b.floorId&&(a.sourceType??'assistant')===(b.sourceType??'assistant')&&a.sourceSnapshotIndex===b.sourceSnapshotIndex;
  for(const source of rawSources){
    if(!keysByFloor.has(source.floorId)||seen.has(source.floorId))continue;
    seen.add(source.floorId);
    const memory=memoriesByFloor.get(source.floorId),base={floorId:source.floorId,memoryId:source.floorMemoryId,
      placeKeys:[...keysByFloor.get(source.floorId)],rawFingerprint:source.floorMemoryId,requiresExactQuote:true};
    const sources=[{...base,sourceType:'assistant',canonicalContent:source.canonicalContent},
      ...(storedSourceUserInput(memory,source.floorId)?.messages??[]).map((message,sourceSnapshotIndex)=>({...base,sourceType:'precedingUser',sourceSnapshotIndex,canonicalContent:message.content}))];
    for(const candidate of sources){
      const related=bodySources.filter(row=>sameSource(row,candidate));
      const placeKeys=new Set([...candidate.placeKeys,...related.flatMap(row=>row.placeKeys??[])]);
      const names=[...new Set([...placeKeys].flatMap(key=>{const place=placesByKey.get(key);return place?[place.displayName,...(place.aliases??[])]:[];})
        .filter(name=>typeof name==='string'&&name.length>=2).map(name=>name.toLocaleLowerCase()))];
      const quotes=contextSources.filter(row=>sameSource(row,candidate)).map(row=>row.canonicalContent);
      let ranges=paragraphContext(candidate.canonicalContent,names,quotes);
      if(!ranges.length&&candidate.sourceType==='assistant')ranges=[{content:candidate.canonicalContent,offset:0}];
      for(const range of ranges)contexts.push({...candidate,canonicalContent:range.content,sourceOffset:range.offset});
    }
  }
  const remaining=[];
  for(const row of bodySources){
    const context=contexts.find(candidate=>sameSource(row,candidate)&&candidate.canonicalContent.includes(row.canonicalContent));
    if(context)context.placeKeys=[...new Set([...context.placeKeys,...(row.placeKeys??[])])];
    else remaining.push({...row,placeKeys:[...(row.placeKeys??[])]});
  }
  return [...contexts,...remaining];
}
