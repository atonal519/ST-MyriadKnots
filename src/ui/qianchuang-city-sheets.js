import {cityMapForPlace,cityMapsForPlaceAddresses} from './qianchuang-city-maps.js';
const key=value=>String(value??'').normalize('NFKC').trim().toLocaleLowerCase();
const countries=new Set(['中国','中國','中华人民共和国','China','美国','美國','US','USA','United States','United States of America','韩国','韓國','대한민국','Korea','South Korea','日本','Japan'].map(key));
const otherCities=new Set(['香港','Hong Kong'].map(key));
export function placeMapLevel(place){
 if(Object.hasOwn(place,'mapLevel')&&[null,'city','country','scope'].includes(place.mapLevel))return place.mapLevel;
 if(['site','interior'].includes(place.mapRole))return null;
 const labels=[place.displayName,...(place.aliases??[])].map(key);
 return cityMapForPlace(place)||labels.some(label=>otherCities.has(label))?'city':labels.some(label=>countries.has(label))?'country':null;
}
export function projectQianchuangSheets(snapshot){
 const places=snapshot.places??[],byId=new Map(places.map(p=>[p.entityId,p])),order=[],seen=new Set(),visit=id=>{if(seen.has(id)||!byId.has(id))return;seen.add(id);order.push(byId.get(id));for(const child of byId.get(id).childEntityIds??[])visit(child);};
 for(const id of snapshot.mapRootIds??[])visit(id);for(const id of snapshot.unassignedPlaceIds??[])visit(id);for(const p of places)visit(p.entityId);
 const countryIds=new Set(places.filter(p=>placeMapLevel(p)==='country').map(p=>p.entityId)),boundaryNodes=order.filter(p=>['city','scope'].includes(placeMapLevel(p))),boundaryIds=new Set(boundaryNodes.map(p=>p.entityId)),placeSheets=new Map();
 if(!boundaryNodes.length&&!countryIds.size&&(snapshot.mapRootIds??[]).some(id=>byId.has(id))){
  const addressCities=new Set(places.flatMap(cityMapsForPlaceAddresses).map(city=>city.id)),assetId=addressCities.size===1?[...addressCities][0]:null;
  return{sheets:[{id:'legacy',label:'地点',cityId:null,assetId,placeIds:places.map(p=>p.entityId)}],placeSheets:new Map(places.map(p=>[p.entityId,'legacy'])),countryIds,defaultSheetId:'legacy'};
 }
 for(const p of places){if(countryIds.has(p.entityId))continue;let node=p;const visited=new Set();while(node&&!boundaryIds.has(node.entityId)&&!visited.has(node.entityId)){visited.add(node.entityId);node=byId.get(node.parentEntityId);}placeSheets.set(p.entityId,node&&boundaryIds.has(node.entityId)?node.entityId:null);}
 const sheets=[];
 for(const p of boundaryNodes){
  const placeIds=places.filter(n=>placeSheets.get(n.entityId)===p.entityId).map(n=>n.entityId);
  const content=[...(p.features??[]).filter(item=>item.kind===undefined||item.kind==='stable'),...(p.relations??[])].some(item=>typeof item.text==='string'&&item.text.trim())||(p.facilities??[]).length;
  if(placeIds.some(id=>!boundaryIds.has(id)&&!countryIds.has(id))||placeMapLevel(p)==='scope'&&content)sheets.push({id:p.entityId,rootPlaceId:p.entityId,cityId:placeMapLevel(p)==='city'?p.entityId:null,label:p.displayName,assetId:placeMapLevel(p)==='city'?cityMapForPlace(p)?.id??null:null,mapAssetId:p.mapAssetId??null,placeIds});
  else placeSheets.set(p.entityId,null);
 }
 return{sheets,placeSheets,countryIds,placeOrder:order.map(p=>p.entityId),defaultSheetId:placeSheets.get(snapshot.userPosition?.placeEntityId)??sheets[0]?.id??null};
}
export function snapshotForCitySheet(snapshot,projection,id){
 if(id==='legacy')return snapshot;
 if(projection.sheets.some(sheet=>sheet.id==='legacy'))return{...snapshot,mapRootIds:[]};
 const sheet=projection.sheets.find(s=>s.id===id),ids=new Set(sheet?.placeIds??[...projection.placeSheets].filter(([,sheetId])=>sheetId===null).map(([placeId])=>placeId)),byId=new Map((snapshot.places??[]).map(p=>[p.entityId,p]));
 const places=(snapshot.places??[]).filter(p=>ids.has(p.entityId)).map(p=>{let parent=byId.get(p.parentEntityId);while(parent&&projection.countryIds.has(parent.entityId))parent=byId.get(parent.parentEntityId);return{...p,parentEntityId:parent&&ids.has(parent.entityId)?parent.entityId:null,childEntityIds:[]};}),visible=new Map(places.map(p=>[p.entityId,p]));
 const children=id=>(byId.get(id)?.childEntityIds??[]).flatMap(child=>projection.countryIds.has(child)?children(child):visible.has(child)?[child]:[]);
 for(const p of places)p.childEntityIds=children(p.entityId);
 const rootPlaceId=sheet?.rootPlaceId??sheet?.cityId;
 if(rootPlaceId){const root=visible.get(rootPlaceId);root.parentEntityId=null;root.mapRole=placeMapLevel(root)==='scope'||places.some(p=>p.entityId!==root.entityId&&['area','site'].includes(p.mapRole))?'area':undefined;}
 const roots=rootPlaceId?[rootPlaceId]:[];
 // A directory branch stays accessible without becoming a map root or point.
 return{...snapshot,places,mapRootIds:roots,unassignedPlaceIds:sheet?(snapshot.unassignedPlaceIds??[]).filter(id=>ids.has(id)&&!roots.includes(id)):projection.placeOrder.filter(id=>visible.has(id)&&!visible.get(id).parentEntityId)};
}
