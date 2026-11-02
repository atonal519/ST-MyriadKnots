import { currentPlaceEntityIds, expandPlaceParents } from '../src/v3/spatial-domain.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as place from '../src/v3/place-workspace.js';
const chat='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222',parent='33333333-3333-4333-8333-333333333333';
const floor='44444444-4444-4444-8444-444444444444',next='55555555-5555-4555-8555-555555555555';
const workspace=()=>({schemaVersion:1,kind:'qqj-v3-place-workspace',chatId:chat,placesByEntityId:{[room]:{scopes:Object.fromEntries(['name','description','relations','parentEntityId'].map(key=>[key,{knownThroughFloorId:floor,coveredFloorIds:[floor],coveredItemIds:['old']}])),name:'校准房间',description:'独立卫浴',relations:'走廊末端',parentEntityId:parent}},deletionsByEntityId:{}});
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

test('后续只编辑方位不会推进旧描述覆盖范围',()=>{const current=workspace();current.placesByEntityId[room].scopes.relations={knownThroughFloorId:next,coveredFloorIds:[floor,next],coveredItemIds:['old','new']};const newer={floorId:next,spatialFacts:{features:[{itemId:'new',placeEntityId:room,text:'新增书桌',evidenceRefs:[{floorId:next}]}],relations:[]}};assert.equal(place.filterPlaceMemory(newer,current).spatialFacts.features[0].text,'新增书桌');});

test('删除只清已有来源，新楼重新提到地点可正常收录',()=>{const deleted={...workspace(),placesByEntityId:{},deletionsByEntityId:{[room]:{coveredFloorIds:[floor]}}};const old={floorId:floor,locations:[{entityId:room,name:'旧房间'}],spatialFacts:{positions:[{placeEntityId:room,evidenceRefs:[{floorId:floor}]}],features:[{placeEntityId:room,text:'旧床',evidenceRefs:[{floorId:floor}]}]}};const newer={floorId:next,locations:[{entityId:room,name:'新提到房间'}],spatialFacts:{features:[{placeEntityId:room,text:'新床',evidenceRefs:[{floorId:next}]}]}};assert.equal(place.filterPlaceMemory(old,deleted).locations.length,0);assert.equal(place.filterPlaceMemory(old,deleted).spatialFacts.features.length,0);assert.deepEqual(place.placeDeletionIdentityIds(deleted,{floors:[{id:floor}],floorMemories:[old]}),[room]);assert.deepEqual(place.placeDeletionIdentityIds(deleted,{floors:[{id:floor},{id:next}],floorMemories:[old,newer]}),[]);assert.equal(place.filterPlaceMemory(newer,deleted).spatialFacts.features[0].text,'新床');});

test('人工房间归一楼再归宿舍供当前场所和祖先遍历共用',()=>{const building='66666666-6666-4666-8666-666666666666';const current=workspace();current.placesByEntityId[parent]={parentEntityId:building,scopes:{parentEntityId:{knownThroughFloorId:floor,coveredFloorIds:[floor],coveredItemIds:[]}}};const memories=[{floorId:floor,spatialFacts:{positions:[{subjectEntityId:chat,placeEntityId:room,status:'confirmed',evidenceRefs:[{floorId:floor,assistantSeq:1}]}]}}];assert.deepEqual([...currentPlaceEntityIds(memories,1,[{id:floor,assistantSeq:1}],current)],[room,parent,building]);assert.deepEqual([...expandPlaceParents(new Set([room]),memories,1,[{id:floor,assistantSeq:1}],current)],[room,parent,building]);});

test('聚合记录只去掉已删除来源，未来来源仍保留且不带回旧引用',()=>{const current={...workspace(),placesByEntityId:{},deletionsByEntityId:{[room]:{coveredFloorIds:[floor]}}};const memory={floorId:next,spatialFacts:{features:[{placeEntityId:room,text:'床',evidenceRefs:[{floorId:floor},{floorId:next}]}]}};assert.deepEqual(place.filterPlaceMemory(memory,current).spatialFacts.features[0].evidenceRefs,[{floorId:next}]);});

test('地图层级人工null优先于自动city，前缀范围和独立字段保留',()=>{
 const data=workspace(),scope={knownThroughFloorId:floor,coveredFloorIds:[floor],coveredItemIds:[]};data.placesByEntityId[room].mapLevel=null;data.placesByEntityId[room].scopes.mapLevel=scope;assert.doesNotThrow(()=>place.validatePlaceWorkspace(data,chat));
 data.foundation={schemaVersion:1,entities:[],facts:[{itemId:next,kind:'place',placeEntityId:room,mapRole:'area',mapLevel:'city'}]};const base={chatId:chat,places:[{entityId:room,displayName:'上海',features:[],relations:[],parentEntityId:null,childEntityIds:[]}],userPosition:{}};const result=place.applyPlaceSnapshot(base,data);assert.equal(result.places[0].mapLevel,null);assert.equal(result.places[0].mapRole,'area');assert.equal(place.placeWorkspaceForPrefix(data,new Set([floor])).placesByEntityId[room].mapLevel,null);assert.equal(Object.hasOwn(place.placeWorkspaceForPrefix(data,new Set()).placesByEntityId[room],'mapLevel'),false);
});
