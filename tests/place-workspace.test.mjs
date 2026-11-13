import { currentPlaceEntityIds, expandPlaceParents } from '../src/v3/spatial-domain.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as place from '../src/v3/place-workspace.js';
const chat='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222',parent='33333333-3333-4333-8333-333333333333';
const floor='44444444-4444-4444-8444-444444444444',next='55555555-5555-4555-8555-555555555555';
const workspace=()=>({schemaVersion:1,kind:'qqj-v3-place-workspace',chatId:chat,placesByEntityId:{[room]:{scopes:Object.fromEntries(['name','description','relations','parentEntityId'].map(key=>[key,{knownThroughFloorId:floor,coveredFloorIds:[floor],coveredItemIds:['old']}])),name:'校准房间',description:'独立卫浴',relations:'走廊末端',parentEntityId:parent}},deletionsByEntityId:{}});
test('自动方位覆盖沿共享材料过滤，有限历史仍读旧方位且独立新项保留',()=>{
 const memory={floorId:floor,spatialFacts:{relations:[{itemId:'old-relation',placeEntityId:room,kind:'relative',text:'旧方位',evidenceRefs:[{floorId:floor}]},{itemId:'independent-relation',placeEntityId:room,kind:'relative',text:'另一个出口',evidenceRefs:[{floorId:floor}]}]}};
 const data={...workspace(),placesByEntityId:{},foundation:{schemaVersion:1,entities:[],facts:[{itemId:parent,kind:'relation',placeEntityId:room,text:'走廊末端',knownFromFloorId:next,replacesItemIds:['old-relation'],source:{kind:'body',floorId:next,quote:'走廊末端'}}]}};
 assert.deepEqual(place.filterPlaceMemory(memory,data).spatialFacts.relations.map(r=>r.itemId),['independent-relation']);
 const historical=place.placeWorkspaceForPrefix(data,new Set([floor]));assert.deepEqual(place.filterPlaceMemory(memory,historical).spatialFacts.relations.map(r=>r.itemId),['old-relation','independent-relation']);assert.equal(memory.spatialFacts.relations.length,2);
});
test('地点CAS保存重载与冷读缓存按chat隔离，人工空值保留',async()=>{
 const records=new Map();let reads=0,writes=0;const client={async get(c,id){reads++;if(!records.has(c))throw Object.assign(Error('missing'),{status:404});return structuredClone(records.get(c));},async put(c,id,data,revision){writes++;const old=records.get(c);assert.equal(revision,old?.revision??0);const r={data:structuredClone(data),revision:revision+1};records.set(c,r);return r;}};
 const store=place.createPlaceWorkspaceStore({client});assert.equal((await store.read({chatId:chat})).revision,0);await store.read({chatId:chat});assert.equal(reads,1);
 const data=workspace();data.placesByEntityId[room].description='';await store.put({chatId:chat},data,0);assert.equal((await store.read({chatId:chat})).data.placesByEntityId[room].description,'');assert.equal(writes,1);
 store.invalidate(chat);assert.equal((await store.read({chatId:chat})).revision,1);assert.equal(reads,2);assert.equal((await store.read({chatId:parent})).data,null);
});
test('人工改旧卫浴和方位只覆盖已知范围，新楼独立书桌继续入有效事实',()=>{
 const old={floorId:floor,spatialFacts:{containments:[],positions:[],features:[{itemId:'old',placeEntityId:room,text:'旧卫浴',evidenceRefs:[{floorId:floor}]}],relations:[1,2,3].map(n=>({itemId:'r'+n,placeEntityId:room,text:'旧方位'+n,referencePlaceEntityIds:[parent],evidenceRefs:[{floorId:floor}]}))}};
 const newer={floorId:next,spatialFacts:{containments:[],positions:[],features:[{itemId:'new',placeEntityId:room,text:'新增书桌',replacesItemIds:[],evidenceRefs:[{floorId:next}]},{itemId:'overwrite',placeEntityId:room,text:'自动反改',replacesItemIds:['old'],evidenceRefs:[{floorId:next}]}],relations:[]}};
 assert.equal(place.filterPlaceMemory(old,workspace()).spatialFacts.relations.length,0);assert.equal(place.filterPlaceMemory(old,workspace()).spatialFacts.features.length,0);
 assert.deepEqual(place.filterPlaceMemory(newer,workspace()).spatialFacts.features.map(x=>x.text),['新增书桌']);assert.equal(old.spatialFacts.features.length,1);
 const prior=place.placeWorkspaceForPrefix(workspace(),new Set());assert.equal(place.filterPlaceMemory(old,prior).spatialFacts.features.length,1);
});
test('人工描述/方位清空无旧事实，父级调整和删除保留孩子',()=>{
 const base={status:'ready',chatId:chat,places:[{entityId:parent,displayName:'楼',features:[],relations:[],parentEntityId:null,childEntityIds:[room]},{entityId:room,displayName:'房',features:[],relations:[],parentEntityId:parent,childEntityIds:[]}],mapRootIds:[parent],unassignedPlaceIds:[],userPosition:{placeEntityId:room}};
 const current=workspace();current.placesByEntityId[room].description='';current.placesByEntityId[room].relations='';current.placesByEntityId[room].parentEntityId=null;current.deletionsByEntityId={[parent]:{coveredFloorIds:[floor]}};base.places=base.places.filter(place=>place.entityId!==parent);const result=place.applyPlaceSnapshot(base,current);
 assert.equal(result.places.length,1);assert.equal(result.places[0].parentEntityId,null);assert.equal(result.places[0].displayName,'校准房间');assert.deepEqual(result.places[0].features,[]);assert.deepEqual(result.places[0].relations,[]);assert.deepEqual(result.mapRootIds,[room]);assert.deepEqual(result.unassignedPlaceIds,[]);
});
test('临时位置DTO没有摘要末楼时点时，恢复父树不推为当前',()=>{
 const base={chatId:chat,places:[{entityId:parent,features:[],relations:[],parentEntityId:null,childEntityIds:[]},{entityId:room,features:[],relations:[],parentEntityId:null,childEntityIds:[]}],userPosition:{status:'confirmed',placeEntityId:room,isCurrent:true}};
 const result=place.applyPlaceSnapshot(base,workspace());
 assert.equal(result.userPosition.mapRootEntityId,parent);assert.equal(result.userPosition.isCurrent,false);
});

test('后续只编辑方位不会推进旧描述覆盖范围',()=>{const current=workspace();current.placesByEntityId[room].scopes.relations={knownThroughFloorId:next,coveredFloorIds:[floor,next],coveredItemIds:['old','new']};const newer={floorId:next,spatialFacts:{features:[{itemId:'new',placeEntityId:room,text:'新增书桌',evidenceRefs:[{floorId:next}]}],relations:[]}};assert.equal(place.filterPlaceMemory(newer,current).spatialFacts.features[0].text,'新增书桌');});

test('删除只清已有来源，新楼重新提到地点可正常收录',()=>{const deleted={...workspace(),placesByEntityId:{},deletionsByEntityId:{[room]:{coveredFloorIds:[floor]}}};const old={floorId:floor,locations:[{entityId:room,name:'旧房间'}],spatialFacts:{positions:[{placeEntityId:room,evidenceRefs:[{floorId:floor}]}],features:[{placeEntityId:room,text:'旧床',evidenceRefs:[{floorId:floor}]}]}};const newer={floorId:next,locations:[{entityId:room,name:'新提到房间'}],spatialFacts:{features:[{placeEntityId:room,text:'新床',evidenceRefs:[{floorId:next}]}]}};assert.equal(place.filterPlaceMemory(old,deleted).locations.length,0);assert.equal(place.filterPlaceMemory(old,deleted).spatialFacts.features.length,0);assert.deepEqual(place.placeDeletionIdentityIds(deleted,{floors:[{id:floor}],floorMemories:[old]}),[room]);assert.deepEqual(place.placeDeletionIdentityIds(deleted,{floors:[{id:floor},{id:next}],floorMemories:[old,newer]}),[]);assert.equal(place.filterPlaceMemory(newer,deleted).spatialFacts.features[0].text,'新床');});

test('人工房间归一楼再归宿舍供当前场所和祖先遍历共用',()=>{const building='66666666-6666-4666-8666-666666666666';const current=workspace();current.placesByEntityId[parent]={parentEntityId:building,scopes:{parentEntityId:{knownThroughFloorId:floor,coveredFloorIds:[floor],coveredItemIds:[]}}};const memories=[{floorId:floor,spatialFacts:{positions:[{subjectEntityId:chat,placeEntityId:room,status:'confirmed',evidenceRefs:[{floorId:floor,assistantSeq:1}]}]}}];assert.deepEqual([...currentPlaceEntityIds(memories,1,[{id:floor,assistantSeq:1}],current)],[room,parent,building]);assert.deepEqual([...expandPlaceParents(new Set([room]),memories,1,[{id:floor,assistantSeq:1}],current)],[room,parent,building]);});

test('聚合记录只去掉已删除来源，未来来源仍保留且不带回旧引用',()=>{const current={...workspace(),placesByEntityId:{},deletionsByEntityId:{[room]:{coveredFloorIds:[floor]}}};const memory={floorId:next,spatialFacts:{features:[{placeEntityId:room,text:'床',evidenceRefs:[{floorId:floor},{floorId:next}]}]}};assert.deepEqual(place.filterPlaceMemory(memory,current).spatialFacts.features[0].evidenceRefs,[{floorId:next}]);});

test('地图层级人工null优先于自动city，前缀范围和独立字段保留',()=>{
 const data=workspace(),scope={knownThroughFloorId:floor,coveredFloorIds:[floor],coveredItemIds:[]};data.placesByEntityId[room].mapLevel=null;data.placesByEntityId[room].scopes.mapLevel=scope;assert.doesNotThrow(()=>place.validatePlaceWorkspace(data,chat));
 data.foundation={schemaVersion:1,entities:[],facts:[{itemId:next,kind:'place',placeEntityId:room,mapRole:'area',mapLevel:'city'}]};const base={chatId:chat,places:[{entityId:room,displayName:'上海',features:[],relations:[],parentEntityId:null,childEntityIds:[]}],userPosition:{}};const result=place.applyPlaceSnapshot(base,data);assert.equal(result.places[0].mapLevel,null);assert.equal(result.places[0].mapRole,'area');assert.equal(place.placeWorkspaceForPrefix(data,new Set([floor])).placesByEntityId[room].mapLevel,null);assert.equal(Object.hasOwn(place.placeWorkspaceForPrefix(data,new Set()).placesByEntityId[room],'mapLevel'),false);
});

test('189前缀统一裁正文facts和孤立seed，长期源不按整理时点删除，人工有效seed保留',()=>{
 const makeSeed=(id,name)=>({schemaVersion:3,recordType:'entity',id,chatId:chat,narrativeGeneration:chat,entityType:'place',displayName:name,aliases:[],specialRole:'none',firstSeenFloorId:null,lastSeenFloorId:null,status:'provisional',mergedIntoEntityId:null,mergeEvidenceRefs:[],baselineClaimIds:[],createdAt:'2026-11-02T00:00:00Z',updatedAt:'2026-11-02T00:00:00Z',recordStatus:'active',supersedes:null});
 const data=place.emptyPlaceWorkspace(chat),body={kind:'body',floorId:next},book={kind:'worldbook',sourceName:'书'},card={kind:'characterCard',field:'scenario'};
 data.foundation={schemaVersion:1,entities:[makeSeed(room,'后楼房间'),makeSeed(parent,'长期范围')],facts:[{itemId:room,kind:'place',placeEntityId:room,mapRole:'site',source:body,knownFromFloorId:next},{itemId:floor,kind:'feature',placeEntityId:room,text:'后楼设施',source:{...body,references:[{kind:'body',floorId:floor},body]}},{itemId:parent,kind:'place',placeEntityId:parent,mapLevel:'scope',source:book,knownFromFloorId:next},{itemId:chat,kind:'feature',placeEntityId:parent,text:'长期角色设定',source:card,knownFromFloorId:next}]};
 const before=structuredClone(data),prefix=place.placeWorkspaceForPrefix(data,new Set([floor]));assert.deepEqual(prefix.foundation.facts.map(f=>f.itemId),[parent,chat]);assert.deepEqual(prefix.foundation.entities.map(e=>e.id),[parent]);assert.deepEqual(data,before);
 data.placesByEntityId[room]={createdEntity:makeSeed(room,'后楼房间'),name:'人工保留',scopes:{name:{knownThroughFloorId:floor,coveredFloorIds:[floor],coveredItemIds:[]}}};
 const pinned=place.placeWorkspaceForPrefix(data,new Set([floor]));assert.equal(pinned.placesByEntityId[room].createdEntity.id,room);assert.ok(pinned.foundation.entities.some(e=>e.id===room));
 data.deletionsByEntityId[room]={knownThroughFloorId:next,coveredFloorIds:[floor,next],coveredItemIds:[]};assert.equal(Object.hasOwn(place.placeWorkspaceForPrefix(data,new Set([floor])).deletionsByEntityId,room),false);
});

test('189地点工作区复制按前缀和目标身份冷读，目标已有人工结果不重写',async()=>{
 const records=new Map(),client={async get(c,id){const value=records.get(c+'/'+id);if(!value)throw Object.assign(Error('missing'),{status:404});return structuredClone(value);},async put(c,id,data,rev){const key=c+'/'+id;assert.equal(rev,records.get(key)?.revision??0);const value={data:structuredClone(data),revision:rev+1};records.set(key,value);return structuredClone(value);}};
 const store=place.createPlaceWorkspaceStore({client}),source=workspace();source.placesByEntityId[room].description='';source.mapStyle='old-town';source.deletionsByEntityId[parent]={knownThroughFloorId:floor,coveredFloorIds:[floor],coveredItemIds:[]};await store.put({chatId:chat},source,0);const sourceBytes=JSON.stringify(records.get('chat-'+chat+'/v3-place-workspace'));
 const copied=await store.copy({chatId:chat},{chatId:next},{floorIds:new Set([floor]),narrativeGeneration:next});assert.equal(copied.data.chatId,next);assert.equal(copied.data.placesByEntityId[room].description,'');assert.equal(copied.data.placesByEntityId[room].parentEntityId,parent);assert.equal(copied.data.mapStyle,'old-town');assert.ok(copied.data.deletionsByEntityId[parent]);
 const target=structuredClone(copied.data);target.placesByEntityId[room].description='目标手改';await store.put({chatId:next},target,copied.revision);await store.copy({chatId:chat},{chatId:next},{floorIds:new Set([floor])});store.invalidate();assert.equal((await store.read({chatId:next})).data.placesByEntityId[room].description,'目标手改');assert.equal(JSON.stringify(records.get('chat-'+chat+'/v3-place-workspace')),sourceBytes);
});

test('189人工地点类型覆盖自动类别，null恢复自动且按前缀作用',()=>{
 const base={chatId:chat,places:[{entityId:room,mapRole:'interior',features:[],relations:[],childEntityIds:[],parentEntityId:null}],mapRootIds:[],unassignedPlaceIds:[room]},data=place.emptyPlaceWorkspace(chat),scope={knownThroughFloorId:floor,coveredFloorIds:[floor],coveredItemIds:[]};
 data.placesByEntityId[room]={mapRole:'site',scopes:{mapRole:scope}};place.validatePlaceWorkspace(data,chat);
 assert.equal(place.applyPlaceSnapshot(base,data).places[0].mapRole,'site');assert.equal(place.applyPlaceSnapshot(base,data).places[0].manualMapRole,true);
 assert.equal(place.applyPlaceSnapshot(base,place.placeWorkspaceForPrefix(data,new Set())).places[0].mapRole,'interior');
 data.placesByEntityId[room].mapRole=null;place.validatePlaceWorkspace(data,chat);const auto=place.applyPlaceSnapshot(base,data).places[0];assert.equal(auto.mapRole,'interior');assert.equal(auto.manualMapRole,false);
 data.placesByEntityId[room].mapRole='room';assert.throws(()=>place.validatePlaceWorkspace(data,chat));
});

test('地点合并身份后的自动覆盖、人工空清和删除沿声明redirect生效，原记录不变',()=>{
 const old='99999999-9999-4999-8999-999999999999',resolve=id=>id===old?room:id;
 const memory={floorId:floor,spatialFacts:{features:[{itemId:'old-feature',kind:'stable',placeEntityId:old,text:'旧设施',evidenceRefs:[{floorId:floor}]}],relations:[{itemId:'old-relation',placeEntityId:old,text:'旧方位',referencePlaceEntityIds:[],evidenceRefs:[{floorId:floor}]}],containments:[],positions:[]}};
 const original=JSON.stringify(memory),ws={...workspace(),placesByEntityId:{},foundation:{facts:[{itemId:'new',kind:'feature',placeEntityId:room,text:'归并设施',replacesItemIds:['old-feature'],source:{kind:'body',floorId:next,quote:'归并设施'}}]}};
 assert.equal(place.filterPlaceMemory(memory,ws,resolve).spatialFacts.features.length,0);
 const manual=workspace();manual.placesByEntityId[room].description='';manual.placesByEntityId[room].relations='';assert.equal(place.filterPlaceMemory(memory,manual,resolve).spatialFacts.features.length,0);assert.equal(place.filterPlaceMemory(memory,manual,resolve).spatialFacts.relations.length,0);
 const deleted={...ws,foundation:{facts:[]},deletionsByEntityId:{[room]:{coveredFloorIds:[floor]}}};assert.equal(place.filterPlaceMemory(memory,deleted,resolve).spatialFacts.features.length,0);
 const oldManual={...manual,placesByEntityId:{[old]:manual.placesByEntityId[room]}};assert.equal(place.filterPlaceMemory(memory,oldManual,resolve).spatialFacts.features.length,0);
 assert.equal(place.filterPlaceMemory(memory,ws).spatialFacts.features.length,1,'不提供redirect时仍按原身份合同');assert.equal(JSON.stringify(memory),original);
});

test('地点显式合并编译：链归一与重复幂等，坏键多目标和环局部隔离',()=>{
 const bindings=[room,parent,floor,next].map((entityId,index)=>({entityKey:`p${index}`,entityId}));
 const plan=place.compilePlaceMerges([{sourceKey:'p0',targetKey:'p1'},{sourceKey:'p1',targetKey:'p2'},{sourceKey:'p0',targetKey:'p1'},{sourceKey:'missing',targetKey:'p3'}],bindings);
 assert.deepEqual(plan.redirects,{[room]:floor,[parent]:floor});assert.equal(plan.order.length,2);assert.equal(plan.order[0].source,parent);assert.equal(plan.isolated.length,1);
 for(const entries of [[{sourceKey:'p0',targetKey:'p1'},{sourceKey:'p0',targetKey:'p2'}],[{sourceKey:'p0',targetKey:'p1'},{sourceKey:'p1',targetKey:'p0'}]]){
  const bad=place.compilePlaceMerges([...entries,{sourceKey:'p2',targetKey:'p3'}],bindings);assert.deepEqual(bad.redirects,{[floor]:next});assert.equal(bad.isolated.length,2);
 }
 assert.deepEqual(place.compilePlaceMerges(undefined,bindings),{redirects:{},order:[],isolated:[]});
});

test('地点合并人工资料：target空值优先source补缺，作用域并集和原稿保留',async()=>{
 const {normalizeIdentityProjection,resolveIdentityEntityId}=await import('../src/v3/entity-identity.js');
 const data=workspace(),scope={knownThroughFloorId:next,coveredFloorIds:[next],coveredItemIds:['source-old']};
 data.placesByEntityId[parent]={description:'',parentEntityId:null,scopes:{description:structuredClone(scope),parentEntityId:structuredClone(scope)}};
 const plan=place.compilePlaceMerges([{sourceKey:'source',targetKey:'target'}],[{entityKey:'source',entityId:room},{entityKey:'target',entityId:parent}]);
 const projection=normalizeIdentityProjection({placeWorkspace:{...data,identityRedirectsByEntityId:plan.redirects}}),resolve=id=>resolveIdentityEntityId(id,projection);
 const merged=place.applyPlaceMerges(data,plan,{resolve});
 assert.equal(merged.placesByEntityId[parent].description,'');assert.equal(merged.placesByEntityId[parent].parentEntityId,null);assert.equal(merged.placesByEntityId[parent].relations,'走廊末端');
 assert.deepEqual(new Set(merged.placesByEntityId[parent].scopes.description.coveredItemIds),new Set(['source-old','old']));
 assert.deepEqual(merged.placesByEntityId[room],data.placesByEntityId[room]);assert.equal(place.manualPlaceFacts(merged).length,1);assert.doesNotThrow(()=>place.validatePlaceWorkspace(merged,chat));
});

test('地点redirect读入统一身份同时保旧非法输入兼容，workspace拒循环而旧包仍可读',async()=>{
 const {normalizeIdentityProjection,resolveIdentityEntityId}=await import('../src/v3/entity-identity.js');
 for(const value of ['abc',[room,parent]])assert.deepEqual(normalizeIdentityProjection({identityRedirectsByEntityId:value}).identityRedirectsByEntityId,{});
 const data={...workspace(),identityRedirectsByEntityId:{[room]:parent}};const projection=normalizeIdentityProjection({placeWorkspace:data});assert.equal(resolveIdentityEntityId(room,projection),parent);
 data.identityRedirectsByEntityId[parent]=room;assert.throws(()=>place.validatePlaceWorkspace(data,chat));
});

test('地点合并人工父：映射自父沿已有链找外父，target人工null仍优先',async()=>{
 const {normalizeIdentityProjection,resolveIdentityEntityId}=await import('../src/v3/entity-identity.js');
 const data=workspace(),scope=data.placesByEntityId[room].scopes.parentEntityId;
 data.placesByEntityId[parent]={parentEntityId:room,scopes:{parentEntityId:structuredClone(scope)}};
 data.placesByEntityId[room].parentEntityId=next;
 const plan=place.compilePlaceMerges([{sourceKey:'s',targetKey:'t'}],[{entityKey:'s',entityId:room},{entityKey:'t',entityId:parent}]);
 const projection=normalizeIdentityProjection({placeWorkspace:{...data,identityRedirectsByEntityId:plan.redirects}}),resolve=id=>resolveIdentityEntityId(id,projection);
 const merged=place.applyPlaceMerges(data,plan,{resolve,parents:new Map([[parent,room],[room,next]])});
 assert.equal(merged.placesByEntityId[parent].parentEntityId,next);
});

test('纯地点合并分支和导入往返：无manual或fact也保source旧名与target身份种子',async()=>{
 const {normalizeIdentityProjection,buildEntityIdentityDirectory,resolveIdentityEntityId}=await import('../src/v3/entity-identity.js');
 const makeSeed=(id,name)=>({schemaVersion:3,recordType:'entity',id,chatId:chat,narrativeGeneration:chat,entityType:'place',displayName:name,aliases:[],specialRole:'none',firstSeenFloorId:floor,lastSeenFloorId:floor,status:'provisional',mergedIntoEntityId:null,mergeEvidenceRefs:[],baselineClaimIds:[],createdAt:'2026-11-07T00:00:00Z',updatedAt:'2026-11-07T00:00:00Z',recordStatus:'active',supersedes:null});
 const entities=[makeSeed(room,'旧公寓'),makeSeed(parent,'新家')],records=new Map(),client={async get(collection,key){const value=records.get(collection+'/'+key);if(!value)throw Object.assign(Error('missing'),{status:404});return structuredClone(value);},async put(collection,key,data,revision){const value={data:structuredClone(data),revision:revision+1};records.set(collection+'/'+key,value);return structuredClone(value);}};
 const store=place.createPlaceWorkspaceStore({client}),data={...place.emptyPlaceWorkspace(chat),identityRedirectsByEntityId:{[room]:parent}};await store.put({chatId:chat},data,0);
 const copied=await store.copy({chatId:chat},{chatId:next},{sourceEntities:entities,targetFloors:[{id:next,assistantSeq:1}],narrativeGeneration:next});
 assert.deepEqual(new Set(copied.data.foundation.entities.map(entity=>entity.id)),new Set([room,parent]));
 const projection=normalizeIdentityProjection({placeWorkspace:copied.data});assert.equal(resolveIdentityEntityId(room,projection),parent);
 const directory=buildEntityIdentityDirectory({entities:[],identityProjection:projection});assert.equal(directory.length,1);assert.equal(directory[0].entityId,parent);assert.ok(directory[0].aliases.includes('旧公寓'));
 const roundTrip=place.rehomePlaceWorkspace(JSON.parse(JSON.stringify(place.validatePlaceWorkspace(copied.data,next))),chat,chat);const scoped=place.placeWorkspaceForPrefix(roundTrip,new Set([floor]));assert.deepEqual(new Set(scoped.foundation.entities.map(entity=>entity.id)),new Set([room,parent]));assert.equal(scoped.identityRedirectsByEntityId[room],parent);assert.ok(scoped.foundation.entities.every(entity=>entity.chatId===chat&&entity.narrativeGeneration===chat));
});

test('地点合并多源人工同字段：近target先承接，同级模型原序，target已有空值保留',async()=>{
 const {normalizeIdentityProjection,resolveIdentityEntityId}=await import('../src/v3/entity-identity.js');
 const scope = { knownThroughFloorId: floor, coveredFloorIds: [floor], coveredItemIds: [] };
 const data = {
  ...place.emptyPlaceWorkspace(chat),
  placesByEntityId: {
   [room]: { description: '远源', scopes: { description: structuredClone(scope) } },
   [parent]: { description: '近源', scopes: { description: structuredClone(scope) } },
  },
 };
 const bindings=[room,parent,next].map((entityId,index)=>({entityKey:`k${index}`,entityId})),plan=place.compilePlaceMerges([{sourceKey:'k0',targetKey:'k1'},{sourceKey:'k1',targetKey:'k2'}],bindings);
 const projection=normalizeIdentityProjection({placeWorkspace:{...data,identityRedirectsByEntityId:plan.redirects}}),resolve=id=>resolveIdentityEntityId(id,projection);
 assert.equal(place.applyPlaceMerges(data,plan,{resolve}).placesByEntityId[next].description,'近源');
 const sameLevel=place.compilePlaceMerges([{sourceKey:'k0',targetKey:'k2'},{sourceKey:'k1',targetKey:'k2'}],bindings);assert.equal(place.applyPlaceMerges(data,sameLevel,{resolve}).placesByEntityId[next].description,'远源');
 data.placesByEntityId[next]={description:'',scopes:{description:structuredClone(scope)}};assert.equal(place.applyPlaceMerges(data,plan,{resolve}).placesByEntityId[next].description,'');
});


test('prefix copy retains a deleted place identity only when its deletion scope travels', () => {
 const seed={schemaVersion:3,recordType:'entity',id:room,chatId:chat,narrativeGeneration:parent,entityType:'place',displayName:'旧屋',aliases:[],specialRole:'none',firstSeenFloorId:null,lastSeenFloorId:null,status:'provisional',mergedIntoEntityId:null,mergeEvidenceRefs:[],baselineClaimIds:[],createdAt:'2026-11-12T00:00:00.000Z',updatedAt:'2026-11-12T00:00:00.000Z',recordStatus:'active',supersedes:null};
 const data={...workspace(),placesByEntityId:{[room]:{scopes:{},createdEntity:seed}},
   deletionsByEntityId:{[room]:{knownThroughFloorId:next,coveredFloorIds:[floor,next],coveredItemIds:[]}}};
 place.validatePlaceWorkspace(data,chat);
 const before=structuredClone(data);
 const retained=place.placeWorkspaceForPrefix(data,new Set([floor,next]));
 place.validatePlaceWorkspace(retained,chat);
 assert.deepEqual(retained.placesByEntityId[room].createdEntity,seed);
 assert.deepEqual(retained.deletionsByEntityId[room].coveredFloorIds,[floor,next]);
 const prior=place.placeWorkspaceForPrefix(data,new Set([floor]));
 assert.equal(prior.placesByEntityId[room].createdEntity,undefined);
 assert.equal(prior.deletionsByEntityId[room],undefined);
 assert.deepEqual(data,before);
});

test('328地点保存真未存与状态不明均不伪成功，正常读取可承接耐久结果',async t=>{
 for(const durable of [false,true])await t.test(durable?'已存但确认也失败':'确实未存',async()=>{
  let saved=null,blocked=false;const fault=()=>Object.assign(Error('network'),{code:'BACKEND_NETWORK'});
  const store=place.createPlaceWorkspaceStore({client:{get:async()=>{if(blocked)throw fault();if(!saved)throw Object.assign(Error('missing'),{status:404});return structuredClone(saved);},put:async(c,id,data)=>{if(durable)saved={revision:1,data:structuredClone(data)};blocked=true;throw fault();}}});
  await store.read({chatId:chat});await assert.rejects(store.put({chatId:chat},workspace(),0),{code:'BACKEND_NETWORK'});blocked=false;
  const next=await store.read({chatId:chat});assert.equal(next.revision,durable?1:0);
 });
});

test('328地点丢回执确认接受原生JSON键重排，真实字段差异仍拒绝',async t=>{
 const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,reorder(value[key])])):value;
 for(const changed of [false,true])await t.test(changed?'字段真实变化':'等值键重排',async()=>{
  let saved;const store=place.createPlaceWorkspaceStore({client:{put:async(c,id,data)=>{saved=reorder(data);if(changed)saved.placesByEntityId[room].description='后来人工';throw Object.assign(Error('lost'),{code:'BACKEND_NETWORK'});},get:async()=>({revision:1,data:saved})}});
  if(changed)await assert.rejects(store.put({chatId:chat},workspace(),0),{code:'BACKEND_NETWORK'});else assert.equal((await store.put({chatId:chat},workspace(),0)).revision,1);
 });
});
