import { identityLabelKey } from '../v3/entity-identity.js';
import { indexQianchuangWorldInfo } from '../place-worldbook-material.js';
export { indexQianchuangWorldInfo } from '../place-worldbook-material.js';
const key=value=>identityLabelKey(String(value??'').replace(/\s+/gu,' '));
const whole = (value,label,{suffix=false}={}) => {
  const source=key(value),needle=key(label);if(!needle)return false;
  let offset=source.indexOf(needle);
  while(offset>=0){const before=source[offset-1],after=source[offset+needle.length];if((!before||!/[\p{L}\p{N}_]/u.test(before))&&(!after||!/[\p{L}\p{N}_]/u.test(after))&&(!suffix||!source.slice(offset+needle.length).trim()))return true;offset=source.indexOf(needle,offset+1);}return false;
};

export function projectQianchuangWorldInfo(snapshot,{candidates=[],macros={},index=null}={}) {
  if(!snapshot?.places)return snapshot;
  const records=index??indexQianchuangWorldInfo({candidates,macros}),byId=new Map(snapshot.places.map(place=>[place.entityId,place])),roots=new Set(snapshot.mapRootIds??[]),labels=new Map();
  const placeNames=place=>[place.displayName,...(place.aliases??[])];
  for(const place of snapshot.places)for(const name of placeNames(place)){const label=key(name);if(!labels.has(label))labels.set(label,new Set());labels.get(label).add(place.entityId);}
  function directIds(record){const ids=new Set(record.names.flatMap(name=>[...(labels.get(key(name))??[])]));
    for(const full of record.propertyNames)for(const place of snapshot.places)if(roots.has(place.entityId))for(const alias of place.aliases??[]){
      if(/^[\p{ASCII}]+$/u.test(alias)&&(/\d/u.test(alias)||/\S+\s+\S+/u.test(alias))&&whole(full,alias,{suffix:true}))ids.add(place.entityId);
    }return [...ids];}
  const AMBIGUOUS=Symbol('unresolved property scope');
  const propertyOwners=records.map(record=>{if(!record.propertyNames.length)return null;const ids=directIds(record);return ids.length===1?ids[0]:AMBIGUOUS;});
  const siblingOwners=new Map();records.forEach((record,i)=>{if(record.parent===null||!propertyOwners[i])return;if(!siblingOwners.has(record.parent))siblingOwners.set(record.parent,new Set());siblingOwners.get(record.parent).add(propertyOwners[i]);});
  const contexts=new Map();for(const record of records)for(const name of record.names){const label=key(name);if(!contexts.has(label))contexts.set(label,new Set());contexts.get(label).add(JSON.stringify([record.sourceKey,record.path.slice(0,-1)]));}
  const projected=[],descriptions=new Map(),seenByPlace=new Map();
  const descendant=(id,scope)=>{const seen=new Set();let current=byId.get(id);while(current&&!seen.has(current.entityId)){if(current.entityId===scope)return true;seen.add(current.entityId);current=byId.get(current.parentEntityId);}return false;};
  function compatible(id,scope){if(scope===AMBIGUOUS)return false;if(!scope)return true;if(descendant(id,scope))return true;const place=byId.get(id),owner=byId.get(scope);
    return !place.mapRootEntityId&&roots.has(scope)&&placeNames(owner).some(label=>placeNames(place).some(name=>whole(name,label)));
  }
  function exclusiveRoom(record,scope){const ownerRoot=byId.get(scope)?.mapRootEntityId??(roots.has(scope)?scope:null);if(!ownerRoot)return[];
    const ids=new Set();for(const name of record.names){const match=/^(.{1,60})的(?:房间|卧室)$/u.exec(key(name));if(!match||/[和与及、,，/&]/u.test(match[1]))continue;
      const owner=match[1];for(const place of snapshot.places){if(place.mapRootEntityId!==ownerRoot||!compatible(place.entityId,scope))continue;
        for(const target of placeNames(place)){const value=key(target).replace(/^(?:走廊尽头|走廊最深处)/u,'');if(value===`${owner}房间`||value===`${owner}的房间`||value===`${owner}卧室`||value===`${owner}的卧室`)ids.add(place.entityId);}
      }
    }return [...ids];
  }
  records.forEach((record,i)=>{
    const siblings=siblingOwners.get(i),inherited=record.parent===null?null:projected[record.parent]?.scope;
    const siblingScope=siblings?.has(AMBIGUOUS)||siblings?.size>1?AMBIGUOUS:siblings?.size===1?[...siblings][0]:null;
    const scope=inherited===AMBIGUOUS?AMBIGUOUS:propertyOwners[i]??siblingScope??inherited;
    const declared=directIds(record);let ids=declared.filter(id=>compatible(id,scope));
    if(scope&&declared.length&&!ids.length){projected[i]={entityId:null,scope:AMBIGUOUS};return;}
    if(!ids.length)ids=exclusiveRoom(record,scope);
    const parentResolved=record.parent!==null&&projected[record.parent]?.entityId;
    const ambiguousSource=!scope&&!parentResolved&&!propertyOwners[i]&&record.names.some(name=>(contexts.get(key(name))?.size??0)>1);
    const entityId=ids.length===1&&!ambiguousSource?ids[0]:null;
    projected[i]={entityId,scope:entityId??scope};
    if(!entityId)return;
    if(!descriptions.has(entityId)){descriptions.set(entityId,[]);seenByPlace.set(entityId,new Set());}
    for(const text of record.texts){const normalized=key(text);if(seenByPlace.get(entityId).has(normalized))continue;seenByPlace.get(entityId).add(normalized);descriptions.get(entityId).push({text,sourceKey:record.sourceKey,path:[...record.path],fingerprint:record.fingerprint});}
  });
  return {...snapshot,places:snapshot.places.map(place=>({...place,worldInfoDescriptions:place.manualDescription?[]:descriptions.get(place.entityId)??[]}))};
}
