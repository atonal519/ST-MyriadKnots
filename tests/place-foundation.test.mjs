import test from 'node:test';
import assert from 'node:assert/strict';
import * as foundation from '../src/v3/place-foundation.js';
import { emptyPlaceWorkspace, validatePlaceWorkspace, applyPlaceSnapshot, filterPlaceMemory as filterPlaceMemoryForCurrent } from '../src/v3/place-workspace.js';
import { projectQianchuangSnapshot } from '../src/v3/qianchuang-domain.js';
import { expandPlaceParents } from '../src/v3/spatial-domain.js';
import {captureQianchuangCharacterSources} from '../src/place-worldbook-material.js';

const id=n=>`${n.toString(16).padStart(8,'0')}-0000-4000-8000-000000000000`;
const seed=(n,name)=>({schemaVersion:3,recordType:'entity',id:id(n),chatId:id(90),narrativeGeneration:id(91),entityType:'place',displayName:name,aliases:[],specialRole:'none',firstSeenFloorId:null,lastSeenFloorId:null,status:'provisional',mergedIntoEntityId:null,mergeEvidenceRefs:[],baselineClaimIds:[],createdAt:'2026-10-31T00:00:00.000Z',updatedAt:'2026-10-31T00:00:00.000Z',recordStatus:'active',supersedes:null});
const source={sourceKey:'worldbook-1',locator:'地图:18',fingerprint:'sha256:abc',content:'宿舍一楼设有客房。客房内有独立浴室。别馆一楼也设有客房。'};
const envelope={scope:{chatId:id(90),narrativeGeneration:id(91),batchId:id(92),floorId:id(93),placeCatalogBindings:[{entityKey:'place-1',entityId:id(1),labels:['宿舍']},{entityKey:'place-2',entityId:id(2),labels:['客房']}],parentEntityIdsByPlaceId:new Map([[id(2),new Set([id(1)])]]),placeWorldbookSources:[source]}};
const path={path:[{name:'宿舍',sameAsPlaceKey:'place-1'},{name:'一楼'},{name:'客房',sameAsPlaceKey:'place-2'}],source:'worldbook',sourceKey:'worldbook-1',exactQuote:'宿舍一楼设有客房。客房内有独立浴室。',description:'内有独立浴室。'};

test('父级显式修订可改回祖先或撤销，普通粗述保细链，finite与人工及后续新父各守范围', () => {
  const f1=id(81),f2=id(82),f3=id(83),seq=new Map([[f1,1],[f2,2],[f3,3]]);
  const edge=(n,child,parent,floor)=>({itemId:id(n),placeEntityId:id(child),parentEntityId:id(parent),evidenceRefs:[{floorId:floor}]});
  const memories=[{floorId:f1,recordStatus:'active',spatialFacts:{containments:[edge(101,2,3,f1),edge(102,3,1,f1)]}}];
  const parent=(records,ws,through=Infinity)=>foundation.projectPlaceParentLinks(records,ws,seq,through,through).get(id(2));
  assert.equal([...parent([...memories,{floorId:f2,spatialFacts:{containments:[edge(103,2,1,f2)]}}],null).parents.keys()][0],id(3));
  const revision={itemId:id(104),kind:'containment',placeEntityId:id(2),parentEntityId:id(1),identityChange:'ownershipChanged',replacesItemIds:[id(101)],knownFromFloorId:f2,source:{kind:'worldbook',locator:'book:1',fingerprint:'sha256:abc',quote:'旧楼层归属有误。'}};
  const ws={...emptyPlaceWorkspace(id(90)),foundation:{schemaVersion:1,entities:[],facts:[revision]}};
  assert.equal([...parent(memories,ws).parents.keys()][0],id(1));
  assert.equal([...parent(memories,ws,1).parents.keys()][0],id(3),'有限历史不提前使用修订');
  const cleared={...ws,foundation:{...ws.foundation,facts:[{...revision,parentEntityId:null}]}};
  assert.equal(parent(memories,cleared).parents.size,0);assert.equal(parent(memories,cleared).cleared,true);
  const later=[...memories,{floorId:f3,spatialFacts:{containments:[edge(105,2,4,f3)]}}];
  assert.equal([...parent(later,cleared).parents.keys()][0],id(4),'自动未知不锁住后楼新父');
  const manual={...cleared,placesByEntityId:{[id(2)]:{parentEntityId:null}}};
  assert.equal(parent(later,manual).parents.size,0,'人工顶层仍优先');
  const retained=foundation.projectPlaceParentLinks(memories,cleared,new Map([[f1,1]]));
  assert.equal(retained.get(id(2)).parents.size,0,'当前库knownFrom退出Core时覆盖不复活旧父');
});

test('单节点path省略保父，明确ownershipChanged加parentPlaceKey:null才撤销并覆盖已读父边', async () => {
  const old={itemId:id(111),kind:'containment',placeEntityId:id(2),parentEntityId:id(1),knownFromFloorId:id(93),source:{kind:'worldbook',locator:source.locator,fingerprint:source.fingerprint,quote:source.content}};
  const ws={...emptyPlaceWorkspace(id(90)),foundation:{schemaVersion:1,entities:[seed(1,'宿舍'),seed(2,'客房')],facts:[old]}};
  const scope={...envelope.scope,identityProjection:{placeWorkspace:ws},placeParentFactBindings:[old]};
  const run=fields=>foundation.expandPlacePaths({packet:{placePaths:[{path:[{sameAsPlaceKey:'place-2'}],source:'worldbook',sourceKey:source.sourceKey,exactQuote:source.content,...fields}]},envelope:{request:{task:'organizePlaces',payload:{knownPlaces:[]}},scope},existingEntities:ws.foundation.entities,now:'2026-11-05T00:00:00Z',persistBodyPaths:true});
  const omitted=await run({});assert.equal(omitted.foundationPatch.facts.some(f=>f.kind==='containment'),false);
  const clear=await run({identityChange:'ownershipChanged',parentPlaceKey:null});assert.deepEqual(clear.isolated,[]);
  const fact=clear.foundationPatch.facts.find(f=>f.kind==='containment');assert.ok(fact);assert.equal(fact.parentEntityId,null);assert.equal(fact.identityChange,'ownershipChanged');assert.deepEqual(fact.replacesItemIds,[old.itemId]);
  const merged=foundation.mergePlaceFoundation(ws,clear.foundationPatch);assert.doesNotThrow(()=>validatePlaceWorkspace(merged,id(90)));
  assert.deepEqual(merged.foundation.facts.filter(f=>f.kind==='containment').map(f=>f.parentEntityId),[null]);
  const bad=await run({parentPlaceKey:null});assert.equal(bad.isolated.length,1,'空父不能省略修订意图');
});

test('196已有place key缺省名称沿捕获目录复用，显式空名和未知身份仍隔离',async()=>{
 const invoke=(segments,scope=envelope.scope)=>foundation.expandPlacePaths({packet:{placePaths:[{...path,path:segments}]},envelope:{request:{task:'organizePlaces'},scope},existingEntities:[seed(1,'宿舍'),seed(2,'客房')],now:'2026-11-02T00:00:00Z'});
 const result=await invoke([{sameAsPlaceKey:'place-1'},{name:'一楼'},{sameAsPlaceKey:'place-2'}]);
 assert.deepEqual(result.isolated,[]);assert.equal(result.entities.length,3);assert.equal(result.foundationPatch.facts.filter(f=>f.kind==='containment').at(-1).placeEntityId,id(2));assert.equal(result.foundationPatch.facts.filter(f=>f.kind==='containment')[0].parentEntityId,id(1));
 for(const segment of [{name:'',sameAsPlaceKey:'place-1'},{name:null,sameAsPlaceKey:'place-1'},{sameAsPlaceKey:'unknown'},{sameAsPlaceKey:'place-1',name:42}]){
  const bad=await invoke([segment,{name:'新叶'}]);assert.equal(bad.isolated.length,1);assert.equal(bad.foundationPatch.facts.length,0);assert.equal(bad.freshEntities.length,0);
 }
 const ambiguous=await invoke([{sameAsPlaceKey:'place-1'},{name:'新叶'}],{...envelope.scope,placeCatalogBindings:[...envelope.scope.placeCatalogBindings,{entityKey:'place-1',entityId:id(7),labels:['异地宿舍']}]});assert.equal(ambiguous.isolated.length,1);
});

test('196整理显式null纠正自动层级并跨合并冷读保留，省略保原且人工层级优先',async()=>{
 const run=fields=>foundation.expandPlacePaths({packet:{placePaths:[{...path,path:[{name:'宿舍',sameAsPlaceKey:'place-1',...fields}]}]},envelope:{...envelope,request:{task:'organizePlaces'}},existingEntities:[seed(1,'宿舍'),seed(2,'客房')],now:'2026-11-02T00:00:00Z'});
 const initial=foundation.mergePlaceFoundation(emptyPlaceWorkspace(id(90)),(await run({mapLevel:'scope',mapRole:'site'})).foundationPatch),correction=await run({mapLevel:null}),field=correction.foundationPatch.facts.find(f=>f.kind==='place');
 assert.equal(Object.hasOwn(field,'mapLevel'),true);assert.equal(field.mapLevel,null);
 let workspace=foundation.mergePlaceFoundation(initial,correction.foundationPatch);workspace=foundation.mergePlaceFoundation(workspace,(await run({})).foundationPatch);validatePlaceWorkspace(structuredClone(workspace),id(90));
 assert.equal(workspace.foundation.facts.find(f=>f.kind==='place').mapLevel,null);
 const snapshot={chatId:id(90),places:[{entityId:id(1),displayName:'宿舍',features:[],relations:[],childEntityIds:[],parentEntityId:null}],containments:[],userPosition:{status:'unknown'}};
 assert.equal(applyPlaceSnapshot(snapshot,structuredClone(workspace)).places[0].mapLevel,null);
 for(const level of ['scope',null]){const manual=structuredClone(workspace);manual.placesByEntityId[id(1)]={mapLevel:level,scopes:{mapLevel:{knownThroughFloorId:id(93),coveredFloorIds:[id(93)],coveredItemIds:[]}}};assert.equal(applyPlaceSnapshot(snapshot,manual).places[0].mapLevel,level);}
 workspace=foundation.mergePlaceFoundation(workspace,(await run({mapLevel:'city'})).foundationPatch);assert.equal(applyPlaceSnapshot(snapshot,workspace).places[0].mapLevel,'city');
 assert.deepEqual(workspace.foundation.entities.map(entity=>entity.id),initial.foundation.entities.map(entity=>entity.id));assert.deepEqual(workspace.foundation.facts.filter(f=>f.kind==='containment'),[]);
});

test('196补入的来源原文必须给短exactQuote，旧独立片段仍可只给key',async()=>{
 const short='宿舍内有客房。',full='之前剧情。'.repeat(500)+short+'之后剧情。'.repeat(500),binding={evidenceKey:'full-1',floorId:id(93),memoryId:id(94),sourceType:'assistant',rawFingerprint:'memory-94',canonicalContent:full,requiresExactQuote:true},scoped={scope:{...envelope.scope,sourceFloorBindings:[binding]}};
 const invoke=ref=>foundation.expandPlacePaths({packet:{placePaths:[{path:[{name:'宿舍',sameAsPlaceKey:'place-1'},{name:'客房',sameAsPlaceKey:'place-2'}],evidence:[ref]}]},envelope:scoped,existingEntities:[seed(1,'宿舍'),seed(2,'客房')],now:'2026-11-02T00:00:00Z',persistBodyPaths:true});
 for(const ref of [{source:'storedPlaceEvidence',sourceKey:'full-1'},{source:'storedPlaceEvidence',sourceKey:'full-1',exactQuote:full},{source:'storedPlaceEvidence',sourceKey:'full-1',exactQuote:'另一楼的场所'}]){const bad=await invoke(ref);assert.equal(bad.isolated.length,1);assert.equal(bad.foundationPatch.facts.length,0);}
 const good=await invoke({source:'storedPlaceEvidence',sourceKey:'full-1',exactQuote:short});assert.equal(good.isolated.length,0);assert.ok(good.foundationPatch.facts.every(f=>f.source.quote===short&&f.source.floorId===id(93)));
 binding.canonicalContent='宿舍'+' '.repeat(2500)+'内有客房。';const expandedWhitespace=await invoke({source:'storedPlaceEvidence',sourceKey:'full-1',exactQuote:'宿舍 内有客房。'});assert.equal(expandedWhitespace.isolated.length,1);assert.equal(expandedWhitespace.foundationPatch.facts.length,0);
});

test('196不同来源的自动层级可统一校对，null合并后旧来源省略更新不复活scope',async()=>{
 const entities=[seed(1,'宿舍'),seed(2,'客房')],first=await foundation.expandPlacePaths({packet:{placePaths:[{...path,path:[{name:'宿舍',sameAsPlaceKey:'place-1',mapLevel:'scope'}]}]},envelope,existingEntities:entities,now:'2026-11-02T00:00:00Z'}),old=foundation.mergePlaceFoundation(emptyPlaceWorkspace(id(90)),first.foundationPatch),before=JSON.stringify(old);
 const text='宿舍是首尔城内的普通住宅。',binding={evidenceKey:'evidence-1',floorId:id(93),memoryId:id(96),sourceType:'assistant',rawFingerprint:'memory-96',canonicalContent:text,requiresExactQuote:true};
 const next=await foundation.expandPlacePaths({packet:{placePaths:[{path:[{sameAsPlaceKey:'place-1',mapLevel:null}],source:'storedPlaceEvidence',sourceKey:'evidence-1',exactQuote:text}]},envelope:{request:{task:'organizePlaces'},scope:{...envelope.scope,sourceFloorBindings:[binding]}},existingEntities:entities,now:'2026-11-02T00:00:00Z',persistBodyPaths:true});
 assert.notEqual(first.foundationPatch.facts[0].itemId,next.foundationPatch.facts[0].itemId);let merged=foundation.mergePlaceFoundation(old,next.foundationPatch);assert.equal(JSON.stringify(old),before);assert.equal(merged.foundation.facts.find(f=>f.kind==='place').mapLevel,null);assert.equal(merged.foundation.facts.find(f=>f.kind==='place').source.quote,text);
 const omitted=await foundation.expandPlacePaths({packet:{placePaths:[{...path,path:[{name:'宿舍',sameAsPlaceKey:'place-1'}]}]},envelope,existingEntities:entities,now:'2026-11-02T00:00:00Z'});merged=foundation.mergePlaceFoundation(merged,omitted.foundationPatch);assert.equal(merged.foundation.facts.find(f=>f.kind==='place').mapLevel,null);assert.equal(merged.foundation.facts.find(f=>f.kind==='place').source.locator,source.locator);
 const snapshot={chatId:id(90),places:[{entityId:id(1),displayName:'宿舍',features:[],relations:[],childEntityIds:[],parentEntityId:null}],containments:[],userPosition:{status:'unknown'}};assert.equal(applyPlaceSnapshot(snapshot,validatePlaceWorkspace(JSON.parse(JSON.stringify(merged)),id(90))).places[0].mapLevel,null);
});

test('194地点路径省略引文只在显式单来源展开原短片段，不把中间剧情写入证据',async()=>{
 const text='甲楼内有客房。'+'剧情经过。'.repeat(500)+'客房内有书桌。',quote='甲楼内有客房。……客房内有书桌。';
 const entry={path:[{name:'甲楼'},{name:'客房'}],source:'worldbook',sourceKey:'worldbook-1',exactQuote:quote};
 const result=await foundation.expandPlacePaths({packet:{placePaths:[entry]},envelope:{scope:{...envelope.scope,placeCatalogBindings:[],parentEntityIdsByPlaceId:new Map(),placeWorldbookSources:[{...source,content:text}]}},now:'2026-11-02T00:00:00Z'});
 assert.deepEqual(result.isolated,[]);const evidence=result.foundationPatch.facts.find(f=>f.kind==='containment').source;
 assert.deepEqual(evidence.references.map(ref=>ref.quote),['甲楼内有客房。','客房内有书桌。']);
 assert.ok(evidence.references.every(ref=>ref.locator===source.locator));
 for(const sources of [[{...source,content:'甲楼内有客房。'},{...source,sourceKey:'worldbook-2',content:'客房内有书桌。'}],[{...source,content:text+'甲楼内有客房。'}]]){
  const invalid=await foundation.expandPlacePaths({packet:{placePaths:[entry]},envelope:{scope:{...envelope.scope,placeWorldbookSources:sources}},now:'2026-11-02T00:00:00Z'});assert.equal(invalid.isolated[0].code,'QQJ_PLACE_PATH_SOURCE_INVALID');
 }
});

function correctionFixture(){
 const entities=[seed(1,'甲楼'),seed(2,'客房'),seed(3,'乙楼'),seed(4,'城区'),seed(5,'内间')],parents=new Map([[id(1),new Set([id(4)])],[id(3),new Set([id(4)])],[id(2),new Set([id(3)])],[id(5),new Set([id(2)])]]),quote='甲楼和乙楼位于城区，客房实际位于甲楼，客房里有内间。';
 const base={scope:{...envelope.scope,parentEntityIdsByPlaceId:parents,placeCatalogBindings:entities.map((entity,index)=>({entityKey:`place-${index+1}`,entityId:entity.id,labels:[entity.displayName]})),placeWorldbookSources:[{...source,content:quote}]}},entry={path:[{name:'甲楼',sameAsPlaceKey:'place-1'},{name:'客房',sameAsPlaceKey:'place-2',description:'已有客房说明。',facilities:[]},{name:'内间',sameAsPlaceKey:'place-5'}],source:'worldbook',sourceKey:'worldbook-1',exactQuote:quote};
 const expand=(packet={placePaths:[entry]},task)=>foundation.expandPlacePaths({packet,envelope:{...base,request:{task}},existingEntities:entities,now:'2026-11-01T00:00:00Z',persistBodyPaths:true});
 return{entities,parents,entry,expand};
}

test('181显式整理可据原key纠正旧父，普通摘要保跨枝隔离，短prefix不抹祖先',async()=>{
 const h=correctionFixture();
 for(const packet of [{placePaths:[h.entry]},{task:'organizePlaces',placePaths:[h.entry]}]){const rejected=await h.expand(packet,'extractMemory');assert.equal(rejected.isolated[0].code,'QQJ_PLACE_PATH_SCOPE_CONFLICT');assert.equal(rejected.foundationPatch.facts.length,0);}
 const result=await h.expand(undefined,'organizePlaces');assert.equal(result.isolated.length,0);assert.equal(result.freshEntities.length,0);
 assert.deepEqual(result.foundationPatch.facts.filter(f=>f.kind==='containment').map(f=>[f.placeEntityId,f.parentEntityId]),[[id(2),id(1)],[id(5),id(2)]]);assert.deepEqual([...result.envelope.scope.parentEntityIdsByPlaceId.get(id(1))],[id(4)]);assert.equal(h.parents.get(id(2)).has(id(3)),true);
});

test('181改父成环整条隔离，不泄漏中间实体或半条facts，另一条照常保留',async()=>{
 const h=correctionFixture(),bad={...h.entry,path:[{name:'客房',sameAsPlaceKey:'place-2'},{name:'不应泄漏的楼层',description:'不应保存。'},{name:'乙楼',sameAsPlaceKey:'place-3'}]},self={...h.entry,path:[{name:'甲楼',sameAsPlaceKey:'place-1'},{name:'甲楼',sameAsPlaceKey:'place-1'}]},good={...h.entry,path:[{name:'资料室',description:'独立资料室。'}]},packet={placePaths:[bad,self,good]},before=structuredClone(packet);
 const result=await h.expand(packet,'organizePlaces');assert.deepEqual(result.isolated.map(row=>row.code),['QQJ_PLACE_PATH_SCOPE_CONFLICT','QQJ_PLACE_PATH_SCOPE_CONFLICT']);assert.deepEqual(result.freshEntities.map(entity=>entity.displayName),['资料室']);assert.deepEqual(result.foundationPatch.entities.map(entity=>entity.displayName),['资料室']);assert.ok(result.envelope.scope.placeCatalogBindings.every(binding=>!binding.labels.includes('不应泄漏的楼层')));assert.ok(result.foundationPatch.facts.every(f=>f.placeEntityId===result.freshEntities[0].id));assert.deepEqual(packet,before);
});

test('181整理父级校正保人工父级含null与人工空描述，身份UUID和子枝不变',async()=>{
 const h=correctionFixture(),result=await h.expand(undefined,'organizePlaces'),workspace=foundation.mergePlaceFoundation(emptyPlaceWorkspace(id(90)),result.foundationPatch),snapshot={chatId:id(90),places:h.entities.map(entity=>({entityId:entity.id,displayName:entity.displayName,aliases:[],features:[],relations:[],childEntityIds:[],parentEntityId:[...(h.parents.get(entity.id)??[])][0]??null})),containments:[],userPosition:{status:'unknown'}};
 for(const parentEntityId of [null,id(3)]){workspace.placesByEntityId[id(2)]={parentEntityId,description:'',scopes:{}};const projected=applyPlaceSnapshot(snapshot,workspace),room=projected.places.find(p=>p.entityId===id(2));assert.equal(room.parentEntityId,parentEntityId);assert.deepEqual(room.features,[]);assert.equal(projected.places.find(p=>p.entityId===id(5)).parentEntityId,id(2));assert.equal(projected.places.find(p=>p.entityId===id(1)).parentEntityId,id(4));assert.deepEqual(projected.places.map(p=>p.entityId),h.entities.map(p=>p.id));}
});

test('180每页环境提示沿原place保存稳定素材，缺省保留、布局变化重选，模型素材ID不采',async()=>{
 const expand=fields=>foundation.expandPlacePaths({packet:{placePaths:[{...path,path:[{name:'宿舍',sameAsPlaceKey:'place-1',mapLevel:'scope',...fields}]}]},envelope,existingEntities:[seed(1,'宿舍'),seed(2,'客房')],now:'2026-11-01T00:00:00Z'});
 const first=await expand({mapStyle:'sci-fi',mapLayout:'linear',mapAssetId:'model-invented-id'}),saved=foundation.mergePlaceFoundation(emptyPlaceWorkspace(id(90)),first.foundationPatch);assert.equal(saved.foundation.facts.find(row=>row.kind==='place').mapAssetId,'sci-fi-linear');
 const omitted=foundation.mergePlaceFoundation(saved,(await expand({})).foundationPatch);assert.equal(omitted.foundation.facts.find(row=>row.kind==='place').mapAssetId,'sci-fi-linear');
 const changed=foundation.mergePlaceFoundation(omitted,(await expand({mapStyle:'old-town',mapLayout:'inland'})).foundationPatch),hint=changed.foundation.facts.find(row=>row.kind==='place');assert.equal(hint.mapAssetId,'old-town-inland');assert.equal(hint.mapLevel,'scope');
 const invalid=await expand({mapStyle:'not-a-family',mapLayout:'bad-layout'});assert.equal(invalid.isolated.length,0);assert.equal(Object.hasOwn(invalid.foundationPatch.facts.find(row=>row.kind==='place'),'mapStyle'),false);
});

test('179角色仅捕获description和scenario且来源独立，原字段变更不改已捕获文本',async()=>{
 const context={characterId:0,characters:[{data:{description:'星舰设定',scenario:'边境基地',system_prompt:'不应进入材料',first_mes:'开场全文'}}]};
 const pending=captureQianchuangCharacterSources(context,'ship.png');context.characters[0].data.scenario='后来改动';const sources=await pending;
 assert.deepEqual(sources.map(row=>[row.sourceKey,row.kind,row.field,row.content]),[['card-description','characterCard','description','星舰设定'],['card-scenario','characterCard','scenario','边境基地']]);assert.ok(sources.every(row=>row.locator.startsWith('character:ship.png:')&&row.fingerprint.startsWith('sha256:')));
});

test('179角色独立引文、空坏条局部隔离与设施空值沿原place事实保存',async()=>{
 const card={sourceKey:'card-description',kind:'characterCard',field:'description',locator:'character:test:description',fingerprint:'sha256:card',content:'星舰设有休息舱，舱内有休憩软榻。'};
 const packet={mapStyle:'sci-fi',placePaths:[null,{path:[{name:'坏节点'}],evidence:[null]},{path:[{name:'星舰',facilities:[]},{name:'休息舱',facilities:[{icon:'sofa',label:'软榻'},{icon:'not-an-icon',label:'陈设'}]}],evidence:[{source:'characterCard',sourceKey:card.sourceKey,exactQuote:card.content}]}]};
 const result=await foundation.expandPlacePaths({packet,envelope:{scope:{...envelope.scope,floorId:null,characterCardSources:[card],placeCatalogBindings:[],parentEntityIdsByPlaceId:new Map()}},now:'2026-11-01T00:00:00Z'});
 assert.equal(result.isolated.length,2);assert.equal(result.foundationPatch.mapStyle,'sci-fi');assert.equal(Object.hasOwn(result.packet,'mapStyle'),false);
 const facts=result.foundationPatch.facts.filter(fact=>fact.kind==='place');assert.deepEqual(facts[0].facilities,[]);assert.deepEqual(facts[1].facilities,[{icon:'Sofa',label:'软榻'},{icon:'MapPin',label:'陈设'}]);assert.equal(facts[1].source.kind,'characterCard');assert.equal(facts[1].knownFromFloorId,null);
 const prior=foundation.mergePlaceFoundation(emptyPlaceWorkspace(id(90)),result.foundationPatch),replacement={...facts[1]};delete replacement.facilities;
 const kept=foundation.mergePlaceFoundation(prior,{entities:[],facts:[replacement],replaceFields:[{entityId:replacement.placeEntityId,kind:'place'}]});assert.deepEqual(kept.foundation.facts.find(fact=>fact.itemId===replacement.itemId).facilities,facts[1].facilities);assert.equal(kept.mapStyle,'sci-fi');
});

test('已存独立片段只给sourceKey可绑定原引文，显式空串及其它来源仍不补',async()=>{
 const content='宿舍一楼设有客房。客房内有独立浴室。',body={...envelope,scope:{...envelope.scope,sourceFloorBindings:[{evidenceKey:'evidence-1',floorId:id(93),memoryId:id(96),sourceType:'precedingUser',sourceSnapshotIndex:0,canonicalContent:content,rawFingerprint:'body-1'}]}};
 const invoke=(ref,override=body)=>foundation.expandPlacePaths({packet:{placePaths:[{...path,evidence:[ref]}]},envelope:override,existingEntities:[seed(1,'宿舍'),seed(2,'客房')],now:'2026-10-31T00:00:00.000Z',persistBodyPaths:true});
 const accepted=await invoke({source:'storedPlaceEvidence',sourceKey:'evidence-1'});assert.equal(accepted.isolated.length,0);const reference=accepted.foundationPatch.facts[0].source;assert.equal(reference.quote,content);assert.equal(reference.sourceType,'precedingUser');assert.equal(reference.sourceSnapshotIndex,0);assert.equal(reference.floorId,id(93));assert.equal(reference.memoryId,id(96));
 for(const ref of [{source:'storedPlaceEvidence',sourceKey:'evidence-1',exactQuote:''},{source:'storedPlaceEvidence',sourceKey:'unknown'},{source:'worldbook',sourceKey:'worldbook-1'},{source:'canonicalContent'}])assert.equal((await invoke(ref)).isolated.length,1);
 const duplicate={...body,scope:{...body.scope,sourceFloorBindings:[...body.scope.sourceFloorBindings,...body.scope.sourceFloorBindings]}};assert.equal((await invoke({source:'storedPlaceEvidence',sourceKey:'evidence-1'},duplicate)).isolated.length,1);
});

test('明确世界书路径补无描述中间楼层，保原建筑和房间UUID并独立留源',async()=>{
 const result=await foundation.expandPlacePaths({packet:{summary:'已进入客房。',placePaths:[path]},envelope,existingEntities:[seed(1,'宿舍'),seed(2,'客房')],now:'2026-10-31T00:00:00.000Z'});
 assert.equal(result.entities.length,3);
 const level=result.entities.find(x=>x.displayName==='一楼');assert.ok(level);
 assert.deepEqual(result.foundationPatch.facts.filter(x=>x.kind==='containment').map(x=>[x.placeEntityId,x.parentEntityId]),[[level.id,id(1)],[id(2),level.id]]);
 assert.equal(result.foundationPatch.facts.find(x=>x.kind==='feature').placeEntityId,id(2));
 assert.equal(JSON.stringify(result.packet).includes('宿舍一楼设有客房。'),false,'世界书不得转成正文spatialFacts');
 assert.equal(result.foundationPatch.facts[0].source.kind,'worldbook');
 assert.equal(result.foundationPatch.facts[0].source.locator,'地图:18');
 assert.equal(result.foundationPatch.facts[0].evidenceRefs,undefined);
});

test('不同建筑的同名房间不合并，同一路径重复不造平行节点',async()=>{
 const other={...path,exactQuote:'别馆一楼也设有客房。',description:undefined,path:[{name:'别馆'},{name:'一楼'},{name:'客房'}]};
 const result=await foundation.expandPlacePaths({packet:{placePaths:[path,path,other]},envelope,existingEntities:[seed(1,'宿舍'),seed(2,'客房')],now:'2026-10-31T00:00:00.000Z'});
 assert.equal(result.entities.length,6);assert.equal(result.entities.filter(x=>x.displayName==='客房').length,2);
 assert.equal(result.foundationPatch.facts.filter(x=>x.kind==='containment').length,4);
});

test('假来源或引文只隔离地点路径，不抹合法摘要，缺描述路径仍建层',async()=>{
 const result=await foundation.expandPlacePaths({packet:{summary:'合法摘要',placePaths:[{...path,sourceKey:'wrong'}, {...path,exactQuote:'不存在的原句'}, {...path,description:undefined}]},envelope,existingEntities:[seed(1,'宿舍'),seed(2,'客房')],now:'2026-10-31T00:00:00.000Z'});
 assert.equal(result.packet.summary,'合法摘要');assert.equal(result.isolated.length,2);assert.equal(result.entities.length,3);
 assert.equal(result.foundationPatch.facts.filter(x=>x.kind==='feature').length,0);
});

test('相关世界书按正文和既有地点取材，保完整条目上下文，不带禁用或无关条目',()=>{
 const candidate=(n,content,keys,extra={})=>({id:`worldbook:地图:${n}`,kind:'worldbook',locator:`地图:${n}`,fingerprint:`sha256:${n}`,primaryKeys:keys,content,...extra});
 const result=foundation.selectPlaceWorldbookSources({candidates:[candidate(1,source.content,['宿舍']),candidate(2,'人物性格',['人物']),candidate(3,'宿舍秘密',['宿舍'],{hostEnabled:false})],texts:['走进宿舍'],places:[]});
 assert.equal(result.length,1);assert.equal(result[0].content,source.content);assert.equal(result[0].sourceKey,'worldbook-1');
});

test('旧粗父边被同根整理细化，地图与祖先召回同图；人工空描述/顶层胜过基础',async()=>{
 const expanded=await foundation.expandPlacePaths({packet:{placePaths:[path]},envelope,existingEntities:[seed(1,'宿舍'),seed(2,'客房')],now:'2026-10-31T00:00:00.000Z'});
 const workspace=foundation.mergePlaceFoundation(emptyPlaceWorkspace(id(90)),expanded.foundationPatch), level=expanded.entities.find(x=>x.displayName==='一楼');
 const floors=[{id:id(93),assistantSeq:1}], evidenceRefs=[{floorId:id(93)}];
 const memory={id:id(95),floorId:id(93),recordStatus:'active',summary:{aiText:'进入客房。'},locations:[],spatialFacts:{containments:[{itemId:id(94),placeEntityId:id(2),parentEntityId:id(1),evidenceRefs}],features:[],relations:[],positions:[]}};
 const graph={status:'ready',root:{chatId:id(90),narrativeGeneration:id(91)},checkpoint:{inputFingerprints:[]},floors,floorMemories:[memory],entities:[seed(1,'宿舍'),seed(2,'客房')]};
 const options={identityProjection:{placeWorkspace:workspace,placeWorkspaceRevision:1}};
 const snapshot=projectQianchuangSnapshot(graph,options);
 assert.equal(snapshot.places.find(x=>x.entityId===id(2)).parentEntityId,level.id);
 assert.ok(expandPlaceParents(new Set([id(2)]),[memory],Infinity,floors,workspace).has(level.id));
 assert.equal(snapshot.places.find(x=>x.entityId===id(2)).features[0].text,path.description);
 workspace.placesByEntityId[id(2)]={description:'',parentEntityId:null,scopes:{description:{knownThroughFloorId:id(93),coveredFloorIds:[id(93)],coveredItemIds:[]},parentEntityId:{knownThroughFloorId:id(93),coveredFloorIds:[id(93)],coveredItemIds:[]}}};
 const edited=projectQianchuangSnapshot(graph,{identityProjection:{placeWorkspace:workspace,placeWorkspaceRevision:2}});
 assert.equal(edited.places.find(x=>x.entityId===id(2)).features.length,0);assert.equal(edited.places.find(x=>x.entityId===id(2)).parentEntityId,null);
 assert.deepEqual([...expandPlaceParents(new Set([id(2)]),[memory],Infinity,floors,workspace)],[id(2)]);
});

test('workspace保最小索引结构与seed聊天归属校验',()=>{
 const workspace=emptyPlaceWorkspace(id(90));workspace.foundation={schemaVersion:1,entities:[seed(1,'宿舍')],facts:[{itemId:id(70),kind:'feature',placeEntityId:id(1),knownFromFloorId:id(93),text:'有床',source:{kind:'worldbook',locator:'地图:1',fingerprint:'sha256:1',quote:'有床'}}]};
 assert.doesNotThrow(()=>validatePlaceWorkspace(workspace,id(90)));
 workspace.foundation.entities[0].chatId=id(98);assert.throws(()=>validatePlaceWorkspace(workspace,id(90)));
});

test('新建筑及同城兄弟楼不得借共同祖先抢走已知房间',async()=>{
 const existingEntities=[seed(1,'甲楼'),seed(2,'客房'),seed(3,'乙楼'),seed(4,'城区')];
 const bindings=existingEntities.map((entity,i)=>({entityKey:`place-${i+1}`,entityId:entity.id,labels:[entity.displayName]}));
 const scoped={scope:{...envelope.scope,placeCatalogBindings:bindings,parentEntityIdsByPlaceId:new Map([[id(1),new Set([id(4)])],[id(3),new Set([id(4)])],[id(2),new Set([id(3)])]])}};
 for (const segments of [[{name:'新甲楼'},{name:'一楼'},{name:'客房',sameAsPlaceKey:'place-2'}],[{name:'城区',sameAsPlaceKey:'place-4'},{name:'甲楼',sameAsPlaceKey:'place-1'},{name:'一楼'},{name:'客房',sameAsPlaceKey:'place-2'}]]) {
  const result=await foundation.expandPlacePaths({packet:{placePaths:[{...path,path:segments}]},envelope:scoped,existingEntities,now:'2026-10-31T00:00:00.000Z'});
  assert.equal(result.foundationPatch.facts.length,0);assert.equal(result.isolated[0].code,'QQJ_PLACE_PATH_SCOPE_CONFLICT');
 }
});

test('聚合来源相同引文无明确floorKey时隔离路径，不能默选首楼',async()=>{
 const text='宿舍一楼设有客房。';
 const scoped={scope:{...envelope.scope,sourceFloorBindings:[{floorKey:'floor-1',floorId:id(93),canonicalContent:text},{floorKey:'floor-2',floorId:id(94),canonicalContent:text}]}};
 const result=await foundation.expandPlacePaths({packet:{summary:'合法',placePaths:[{...path,source:'canonicalContent',exactQuote:text}]},envelope:scoped,existingEntities:[seed(1,'宿舍'),seed(2,'客房')],now:'2026-10-31T00:00:00.000Z'});
 assert.equal(result.packet.spatialFacts.containments.length,0);assert.equal(result.isolated.length,1);
});

test('整理片段引文保独立来源，不能跨片段拼成合法连续引文',async()=>{
 const scoped={scope:{...envelope.scope,sourceFloorBindings:[{evidenceKey:'evidence-1',floorId:id(93),sourceType:'assistant',rawFingerprint:'memory-1',canonicalContent:'宿舍设有一楼。'},{evidenceKey:'evidence-2',floorId:id(93),sourceType:'precedingUser',rawFingerprint:'memory-1',canonicalContent:'一楼设有客房。'}]}};
 const result=await foundation.expandPlacePaths({packet:{placePaths:[{...path,source:'storedPlaceEvidence',sourceKey:'evidence-1',exactQuote:'宿舍设有一楼。\n一楼设有客房。'}]},envelope:scoped,existingEntities:[seed(1,'宿舍'),seed(2,'客房')],now:'2026-10-31T00:00:00.000Z',persistBodyPaths:true});
 assert.equal(result.foundationPatch.facts.length,0);assert.equal(result.isolated.length,1);
});

test('零known地点仍取常驻物理地图，另有直接命中也保需要的内部地图，常驻人物不混入',()=>{
 const map={kind:'worldbook',id:'map',locator:'地图:18',fingerprint:'sha256:map',constant:true,primaryKeys:[],comment:'地图',content:JSON.stringify({物业名称:'Unit E',内部:{一楼:{描述:'起居区'}}})};
 const direct={kind:'worldbook',id:'city',locator:'地图:1',fingerprint:'sha256:city',primaryKeys:['城区'],comment:'城市概览',content:'城区有城门。'};
 const person={kind:'worldbook',id:'person',locator:'人物:1',fingerprint:'sha256:person',constant:true,primaryKeys:[],comment:'人物档案',content:JSON.stringify({姓名:'甲',性别:'男',性格:'安静',描述:'人物外观'})};
 for(const texts of [['回宿舍'],['城区里回宿舍']]){
  const sources=foundation.selectPlaceWorldbookSources({candidates:[map,direct,person],texts,places:[]});assert.ok(sources.some(source=>source.locator===map.locator));assert.equal(sources.some(source=>source.locator===person.locator),false);
 }
});

test('世界书宏原样取材与逐字留源，改名只更新独立身份参照而不伪造源版本',()=>{
 const content='{{user}}的房间内有书桌。',candidate={kind:'worldbook',locator:'地图:1',fingerprint:'sha256:raw',primaryKeys:['房间'],content};
 const first=foundation.selectPlaceWorldbookSources({candidates:[candidate],texts:['房间'],macros:{user:'林岚',char:'裴晚生'}})[0];
 const later=foundation.selectPlaceWorldbookSources({candidates:[candidate],texts:['房间'],macros:{user:'新名字',char:'裴晚生'}})[0];
 assert.equal(first.content,content);assert.equal(later.content,content);assert.equal(first.fingerprint,later.fingerprint);assert.equal(first.identityAliases.user,'林岚');assert.equal(later.identityAliases.user,'新名字');
});

test('人物key直中及常驻组织/协议不混入地点，未知自然文地点key仍保留',()=>{
 const make=(id,content,extra={})=>({id,kind:'worldbook',locator:id,fingerprint:'sha256:x',content,hostEnabled:true,...extra});
 const candidates=[make('person',JSON.stringify({character_meta:{},basic_information:{}}),{primaryKeys:['韩泰依'],comment:'<人物|韩泰依>'}),make('company',JSON.stringify({'企业概况':{描述:'商业集团'},'核心领导层':{}}),{constant:true}),make('romance',JSON.stringify({Poly_Romance_Profiles:{描述:'关系规则'}}),{constant:true}),make('language',JSON.stringify({Mandatory_Language_Protocol:{描述:'语言规则'}}),{constant:true}),make('room','客房内有书桌。',{primaryKeys:['宿舍']}),make('map',JSON.stringify({物业名称:'Unit E',一楼:{描述:'起居区'}}),{constant:true,comment:'地图'})];
 assert.deepEqual(foundation.selectPlaceWorldbookSources({candidates,texts:['韩泰依回宿舍'],places:[]}).map(source=>source.locator),['room','map']);
});


test('完整地域路径引用多份独立世界书，描述归各节点且展示提示不改变地点身份',async()=>{
 const sources=[{sourceKey:'worldbook-1',sourceName:'城市',locator:'城市:1',fingerprint:'sha256:city',content:'首尔龙山区汉南洞有宿舍。'},{sourceKey:'worldbook-2',sourceName:'住处',locator:'住处:2',fingerprint:'sha256:home',content:'宿舍一楼设有客房。客房内有独立浴室。'}];
 const result=await foundation.expandPlacePaths({packet:{placePaths:[{path:[{name:'首尔',mapRole:'area'},{name:'龙山区',mapRole:'area'},{name:'汉南洞',mapRole:'area'},{name:'宿舍',sameAsPlaceKey:'place-1',mapRole:'site',description:'汉南洞内的宿舍。'},{name:'一楼',mapRole:'interior'},{name:'客房',sameAsPlaceKey:'place-2',mapRole:'interior',description:'内有独立浴室。'}],evidence:sources.map(source=>({source:'worldbook',sourceKey:source.sourceKey,exactQuote:source.content}))}]},envelope:{...envelope,scope:{...envelope.scope,placeWorldbookSources:sources}},existingEntities:[seed(1,'宿舍'),seed(2,'客房')],now:'2026-10-31T00:00:00.000Z'});
 assert.equal(result.isolated.length,0);assert.equal(result.entities.length,6);const facts=result.foundationPatch.facts;assert.equal(facts.filter(fact=>fact.kind==='containment').length,5);assert.equal(facts.find(fact=>fact.kind==='feature'&&fact.placeEntityId===id(1)).text,'汉南洞内的宿舍。');assert.equal(facts.find(fact=>fact.kind==='feature'&&fact.placeEntityId===id(2)).text,'内有独立浴室。');assert.equal(facts.find(fact=>fact.kind==='place'&&fact.placeEntityId===id(1)).mapRole,'site');assert.equal(facts.find(fact=>fact.kind==='place'&&fact.placeEntityId===id(2)).mapRole,'interior');assert.equal(facts[0].source.references.length,2);assert.ok(facts.every(fact=>fact.evidenceRefs===undefined));
 const ws=foundation.mergePlaceFoundation(emptyPlaceWorkspace(id(90)),result.foundationPatch);const graph={status:'ready',root:{chatId:id(90),narrativeGeneration:id(91)},checkpoint:{inputFingerprints:[]},floors:[],floorMemories:[],entities:[seed(1,'宿舍'),seed(2,'客房')]};const projected=projectQianchuangSnapshot(graph,{identityProjection:{placeWorkspace:ws,placeWorkspaceRevision:1}});assert.equal(projected.places.find(place=>place.entityId===id(1)).mapRole,'site');
});

test('排版等价引文唯一定位回真实原文，保原行首空格；不存在或歧义仍隔离',async()=>{
 const content='北美老宅: |\n纽约布鲁克林独栋别墅，内设储藏室。';const quoted='北美老宅: |\n  纽约布鲁克林独栋别墅，内设储藏室。';
 const run=raw=>foundation.expandPlacePaths({packet:{placePaths:[{path:[{name:'北美老宅',description:'纽约布鲁克林独栋别墅。'},{name:'储藏室'}],source:'worldbook',sourceKey:'worldbook-1',exactQuote:quoted}]},envelope:{scope:{...envelope.scope,placeWorldbookSources:[{...source,content:raw}]}},existingEntities:[],now:'2026-10-31T00:00:00.000Z'});
 const result=await run(content);assert.equal(result.isolated.length,0);assert.ok(result.foundationPatch.facts.every(fact=>fact.source.quote===content));assert.equal(result.foundationPatch.facts.find(fact=>fact.kind==='feature').placeEntityId,result.entities.find(entity=>entity.displayName==='北美老宅').id);
 assert.equal((await run(content+'\n'+content)).isolated.length,1);assert.equal((await run('另一份不相关原文')).isolated.length,1);
});

test('共享区域在后续路径或partial补充省略mapRole时保已有展示提示',async()=>{
 const quote='首尔有甲楼与乙楼。',base={...envelope,scope:{...envelope.scope,placeCatalogBindings:[],parentEntityIdsByPlaceId:new Map(),placeWorldbookSources:[{...source,content:quote}]}};
 const result=await foundation.expandPlacePaths({packet:{placePaths:[{path:[{name:'首尔',mapRole:'area'},{name:'甲楼',mapRole:'site'}],source:'worldbook',sourceKey:'worldbook-1',exactQuote:quote},{path:[{name:'首尔'},{name:'乙楼',mapRole:'site'}],source:'worldbook',sourceKey:'worldbook-1',exactQuote:quote}]},envelope:base,existingEntities:[],now:'2026-10-31T00:00:00.000Z'});
 const city=result.entities.find(entity=>entity.displayName==='首尔'),row=result.foundationPatch.facts.find(fact=>fact.kind==='place'&&fact.placeEntityId===city.id);assert.equal(row.mapRole,'area');
 const workspace=foundation.mergePlaceFoundation(emptyPlaceWorkspace(id(90)),result.foundationPatch),{mapRole,...noRole}=row;
 const partial=foundation.mergePlaceFoundation(workspace,{entities:[],facts:[{...noRole,itemId:id(80)}],replaceFields:[{entityId:city.id,kind:'place'}]});assert.equal(partial.foundation.facts.find(fact=>fact.kind==='place'&&fact.placeEntityId===city.id).mapRole,'area');
});

test('可选city/country提示沿place fact保存，逐字段合并保旧role与level，未知提示不隔离路径',async()=>{
 const src={...source,content:'中国上海的青石馆内有客房。'},scope={scope:{...envelope.scope,placeWorldbookSources:[src]}};
 const r=await foundation.expandPlacePaths({packet:{placePaths:[{path:[{name:'中国',mapLevel:'country',mapRole:'area'},{name:'上海',mapLevel:'city',mapRole:'area'},{name:'青石馆',mapLevel:'bad',mapRole:'site'}],source:'worldbook',sourceKey:'worldbook-1',exactQuote:src.content}]},envelope:scope,existingEntities:[],now:'2026-11-01T00:00:00Z'});
 assert.equal(r.isolated.length,0);const byName=new Map(r.entities.map(e=>[e.displayName,e.id])),level=name=>r.foundationPatch.facts.find(f=>f.kind==='place'&&f.placeEntityId===byName.get(name));assert.equal(level('中国').mapLevel,'country');assert.equal(level('上海').mapLevel,'city');assert.equal(level('青石馆').mapLevel,undefined);
 const current=foundation.mergePlaceFoundation(emptyPlaceWorkspace(id(90)),r.foundationPatch),prior=level('上海'),next={...prior,itemId:id(199),mapLevel:undefined};delete next.mapLevel;const kept=foundation.mergePlaceFoundation(current,{entities:[],facts:[next],replaceFields:[{entityId:prior.placeEntityId,kind:'place'}]});assert.equal(kept.foundation.facts.find(f=>f.itemId===id(199)).mapLevel,'city');
 const changed={...next,itemId:id(198),mapLevel:'country'};delete changed.mapRole;const merged=foundation.mergePlaceFoundation(kept,{entities:[],facts:[changed],replaceFields:[{entityId:prior.placeEntityId,kind:'place'}]});assert.equal(merged.foundation.facts.find(f=>f.itemId===id(198)).mapRole,'area');assert.equal(merged.foundation.facts.find(f=>f.itemId===id(198)).mapLevel,'country');
});

test('外部已存图目录离线时原保存链保ID，环境提示真变化才沿原逻辑换图',()=>{
 const fact={itemId:id(201),kind:'place',placeEntityId:id(1),mapStyle:'modern',mapLayout:'inland',mapAssetId:'remote-persisted'},workspace={...emptyPlaceWorkspace(id(90)),foundation:{schemaVersion:1,entities:[seed(1,'已有范围')],facts:[fact]}};
 const unchanged=foundation.mergePlaceFoundation(workspace,{entities:[],facts:[{itemId:id(202),kind:'place',placeEntityId:id(1),facilities:[]}]});
 assert.equal(unchanged.foundation.facts.find(row=>row.itemId===id(202)).mapAssetId,'remote-persisted');assert.equal(workspace.foundation.facts[0].mapAssetId,'remote-persisted');
 const changed=foundation.mergePlaceFoundation(unchanged,{entities:[],facts:[{itemId:id(203),kind:'place',placeEntityId:id(1),mapStyle:'sci-fi',mapLayout:'linear'}]});assert.equal(changed.foundation.facts.find(row=>row.itemId===id(203)).mapAssetId,'sci-fi-linear');
});

test('正文完整地点简介进入自动资料并仅覆盖已读事实，旧来源保独立',async()=>{
 const old={itemId:id(401),placeEntityId:id(2),kind:'feature',text:'客房保留床和卫浴。',replacesItemIds:[id(400)],source:{kind:'body',floorId:id(93),locator:'floor:'+id(93),quote:'客房内原有床和卫浴。'}},quote='客房新增双层玻璃窗。';
 const scope={...envelope.scope,floorId:id(94),sourceFloorBindings:[{floorId:id(94),floorKey:'floor-1',sourceType:'assistant',canonicalContent:quote,rawFingerprint:'sha256:next'}],placeCurrentFactBindings:[old]};
 const result=await foundation.expandPlacePaths({packet:{placePaths:[{path:[{name:'客房',sameAsPlaceKey:'place-2',description:'客房有床、卫浴和双层玻璃窗。'}],source:'canonicalContent',sourceFloorKey:'floor-1',exactQuote:quote}]},envelope:{request:{task:'extractFloorSemantics'},scope},existingEntities:[seed(1,'宿舍'),seed(2,'客房')],now:'2026-11-03T00:00:00Z'});
 const fact=result.foundationPatch.facts.find(f=>f.kind==='feature');assert.ok(fact,'完整简介保存在自动地点资料');assert.deepEqual(new Set(fact.replacesItemIds),new Set([id(401),id(400)]));assert.equal(result.packet.spatialFacts.features?.length??0,0,'不把完整简介冒作本楼原始设施');assert.equal(fact.source.quote,quote);assert.ok(fact.source.references.some(ref=>ref.quote===old.source.quote&&ref.floorId===id(93)));assert.ok(fact.source.references.some(ref=>ref.quote===quote&&ref.floorId===id(94)));
});

test('当前简介覆盖按同地点同字段具体ID，后来同楼新项保留且人工字段仍优先',()=>{
 const fact={itemId:id(410),kind:'feature',placeEntityId:id(2),text:'床和卫浴。',knownFromFloorId:id(93),replacesItemIds:[id(411)],source:{kind:'body',floorId:id(93),quote:'床和卫浴。'}},workspace=foundation.mergePlaceFoundation(emptyPlaceWorkspace(id(90)),{entities:[],facts:[fact]});
 const mem={floorId:id(93),locations:[],spatialFacts:{features:[{itemId:id(411),placeEntityId:id(2),kind:'stable',text:'旧重复床',evidenceRefs:[{floorId:id(93)}]},{itemId:id(412),placeEntityId:id(2),kind:'stable',text:'后来新增净化器',evidenceRefs:[{floorId:id(93)}]}],relations:[],positions:[],containments:[]}};
 const filtered=filterPlaceMemoryForCurrent(mem,workspace);
 assert.deepEqual(filtered.spatialFacts.features.map(f=>f.itemId),[id(412)]);assert.deepEqual(mem.spatialFacts.features.map(f=>f.itemId),[id(411),id(412)]);
});

test('当前描述重复归并继承旧覆盖，省略和人工空值不解除已保存资料',async()=>{
 const quote='客房新增窗帘。',source={floorId:id(94),floorKey:'floor-1',sourceType:'assistant',canonicalContent:quote,rawFingerprint:'sha256:next'},original={itemId:id(420),placeEntityId:id(2),kind:'feature',text:'床和卫浴。',replacesItemIds:[id(419)],source:{kind:'body',floorId:id(93),quote:'原有床和卫浴。'}};
 const invoke=(fields,prior=[original],manual)=>foundation.expandPlacePaths({packet:{placePaths:[{path:[{name:'客房',sameAsPlaceKey:'place-2',...fields}],source:'canonicalContent',sourceFloorKey:'floor-1',exactQuote:quote}]},envelope:{request:{payload:{knownPlaces:[{entityKey:'place-2',manualCurrentFacts:manual??{}}]}},scope:{...envelope.scope,floorId:id(94),sourceFloorBindings:[source],placeCurrentFactBindings:foundation.placeCurrentFactBindings(prior)}},existingEntities:[seed(1,'宿舍'),seed(2,'客房')],now:'2026-11-03T00:00:00Z'});
 const first=await invoke({description:'床、卫浴和窗帘。'}),fact=first.foundationPatch.facts.find(f=>f.kind==='feature'),again=await invoke({description:fact.text},[fact]);assert.ok(again.foundationPatch.facts.find(f=>f.kind==='feature').replacesItemIds.includes(id(419)));assert.equal(again.foundationPatch.facts.find(f=>f.kind==='feature').replacesItemIds.includes(fact.itemId),false,'同ID不自覆盖');
 const workspace=foundation.mergePlaceFoundation(emptyPlaceWorkspace(id(90)),first.foundationPatch),omitted=await invoke({mapRole:'interior'},[fact]);assert.deepEqual(foundation.mergePlaceFoundation(workspace,omitted.foundationPatch).foundation.facts.filter(f=>f.kind==='feature'),workspace.foundation.facts.filter(f=>f.kind==='feature'));
 const manual=await invoke({description:'不应反改',relations:['不应反改']},[fact],{description:'',relations:''});assert.equal(manual.foundationPatch.facts.some(f=>['feature','relation'].includes(f.kind)),false);
 const empty=await invoke({description:'',relations:[]},[fact]);assert.ok(empty.foundationPatch.facts.find(f=>f.kind==='feature').replacesItemIds.includes(fact.itemId));
 const duplicate={itemId:id(421),placeEntityId:id(2),kind:'feature',text:fact.text,source:{kind:'worldbook',sourceName:'客房资料',locator:'entry:2',quote:'床、卫浴和窗帘。'}},independent={...duplicate,itemId:id(422),text:'新增独立书架。'};
 const consolidated=await invoke({description:fact.text},[fact,duplicate]),merged=consolidated.foundationPatch.facts.find(f=>f.kind==='feature');
 assert.equal(merged.itemId,fact.itemId);assert.ok(merged.replacesItemIds.includes(duplicate.itemId),'覆盖本次已读的独立同文旧项');assert.equal(merged.replacesItemIds.includes(independent.itemId),false,'未提供给本次请求的新设施不被覆盖');assert.ok(merged.source.references.some(ref=>ref.locator==='entry:2'));
});


test('本丸布局沿同次path兼容确定中文，原merge更正旧图且人工普通层级优先',async()=>{
 const content='示例院落设有主殿、居住院与庭园。',old={...emptyPlaceWorkspace(id(90)),foundation:{schemaVersion:1,entities:[seed(1,'示例院落')],facts:[{itemId:id(10),kind:'place',placeEntityId:id(1),mapLevel:'scope',mapStyle:'palace',mapLayout:'courtyard',mapAssetId:'palace-courtyard-garden'}]}};
 const scope={...envelope.scope,placeCatalogBindings:[{entityKey:'place-1',entityId:id(1),labels:['示例院落']}],placeWorldbookSources:[{...source,content}]};
 for(const layout of ['honmaru',' Honmaru ','本丸','和风院落','和风御殿','日式院落群']){
  const result=await foundation.expandPlacePaths({packet:{placePaths:[{path:[{name:'示例院落',sameAsPlaceKey:'place-1',mapLevel:'scope',mapStyle:'palace',mapLayout:layout}],source:'worldbook',sourceKey:'worldbook-1',exactQuote:content}]},envelope:{request:{task:'organizePlaces'},scope},existingEntities:[seed(1,'示例院落')],now:'2026-11-03T00:00:00Z'});
  assert.deepEqual(result.isolated,[]);const fact=result.foundationPatch.facts.find(f=>f.kind==='place');assert.equal(fact.mapLayout,'honmaru',layout);
  const merged=foundation.mergePlaceFoundation(old,result.foundationPatch);assert.equal(merged.foundation.facts.at(-1).mapAssetId,'palace-courtyard-honmaru');
  merged.placesByEntityId[id(1)]={mapLevel:null,scopes:{mapLevel:{knownThroughFloorId:id(93),coveredFloorIds:[id(93)],coveredItemIds:[]}}};
  const current=applyPlaceSnapshot({chatId:id(90),places:[{entityId:id(1),displayName:'示例院落',features:[],relations:[],childEntityIds:[],parentEntityId:null}],mapRootIds:[id(1)],unassignedPlaceIds:[],userPosition:{}},merged);assert.equal(current.places[0].mapLevel,null);
 }
 assert.equal(foundation.mergePlaceFoundation(old,{entities:[],facts:[]}).foundation.facts[0].mapAssetId,'palace-courtyard-garden');
 const {normalizeQianchuangMapLayout,validQianchuangMapLayout}=await import('../src/qianchuang-display-hints.js');assert.equal(normalizeQianchuangMapLayout('本丸','terrain'),undefined);assert.equal(normalizeQianchuangMapLayout('刀剑乱舞','palace'),undefined);assert.equal(validQianchuangMapLayout('本丸','palace'),false);
});

test('校园布局经同次path保存冷读，物理城市与楼层房间父链保持且普通学校不自动scope',async()=>{
 const content='示例市的示例学校有教学楼，教学楼二楼设教室。',entities=[seed(1,'示例市'),seed(2,'示例学校'),seed(3,'教学楼'),seed(4,'二楼'),seed(5,'教室')];
 const bindings=entities.map((entity,i)=>({entityKey:'place-'+(i+1),entityId:entity.id,labels:[entity.displayName]}));
 const scope={...envelope.scope,placeCatalogBindings:bindings,parentEntityIdsByPlaceId:new Map([[id(2),new Set([id(1)])],[id(3),new Set([id(2)])],[id(4),new Set([id(3)])],[id(5),new Set([id(4)])]]),placeWorldbookSources:[{...source,content}]};
 const make=(style,layout,level)=>foundation.expandPlacePaths({packet:{placePaths:[{path:entities.map((entity,i)=>({name:entity.displayName,sameAsPlaceKey:bindings[i].entityKey,...(i===0?{mapLevel:'city'}:i===1?{mapStyle:style,mapLayout:layout,...(level?{mapLevel:level}:{})}:{})})),source:'worldbook',sourceKey:'worldbook-1',exactQuote:content}]},envelope:{request:{task:'organizePlaces'},scope},existingEntities:entities});
 for(const[style,layout,canonical]of [['campus',' Compact ','compact'],['校园','园林校园','garden'],[' Campus ','综合大学','university'],['学校','compact','compact'],[' SCHOOL ','garden','garden']]){
  const expanded=await make(style,layout,'scope');assert.deepEqual(expanded.isolated,[]);
  const saved=foundation.mergePlaceFoundation(emptyPlaceWorkspace(id(90)),expanded.foundationPatch),cold=validatePlaceWorkspace(JSON.parse(JSON.stringify(saved)),id(90));
  const snapshot=applyPlaceSnapshot({chatId:id(90),places:entities.map((e,i)=>({entityId:e.id,displayName:e.displayName,features:[],relations:[],childEntityIds:[],parentEntityId:i?id(i):null})),userPosition:{}},cold);
  assert.equal(snapshot.places.find(p=>p.entityId===id(2)).mapAssetId,'campus-'+canonical);
  assert.deepEqual(snapshot.places.map(p=>p.parentEntityId),[null,id(1),id(2),id(3),id(4)]);
  cold.placesByEntityId[id(2)]={mapLevel:null,scopes:{}};
  assert.equal(applyPlaceSnapshot(snapshot,cold).places.find(p=>p.entityId===id(2)).mapLevel,null);
 }
 const plain=await make('campus',undefined,undefined),saved=foundation.mergePlaceFoundation(emptyPlaceWorkspace(id(90)),plain.foundationPatch),school=saved.foundation.facts.find(f=>f.kind==='place'&&f.placeEntityId===id(2));
 assert.equal(school.mapAssetId,'campus-compact');assert.equal(Object.hasOwn(school,'mapLevel'),false);
});

test('路径多引用保合法来源，加入错键/越源/不连续引文不改变单合法结果，全部失败仍隔离', async () => {
  const text = '宿舍内有客房。', entities = [seed(1,'宿舍'),seed(2,'客房')];
  const book = { ...source, content: text }, otherBook = { ...source, sourceKey: 'worldbook-2', locator: '地图:19', content: '另一所建筑。' };
  const body = { floorKey: 'floor-1', evidenceKey: 'evidence-1', floorId: id(93), memoryId: id(94), sourceType: 'assistant', rawFingerprint: 'memory-94', canonicalContent: text, requiresExactQuote: true, sourceUserInputSnapshot: { messages: [{ content: text }] } };
  const card = { sourceKey: 'card-scenario', content: text, field: 'scenario', locator: 'character:fixture:scenario', fingerprint: 'sha256:card' };
  const scope = { ...envelope.scope, placeWorldbookSources: [book,otherBook], characterCardSources: [card], sourceFloorBindings: [body] };
  const goodRefs = [
    { source: 'worldbook', sourceKey: book.sourceKey, exactQuote: text },
    { source: 'characterCard', sourceKey: card.sourceKey, exactQuote: text },
    { source: 'storedPlaceEvidence', sourceKey: body.evidenceKey, exactQuote: text },
    { source: 'canonicalContent', sourceFloorKey: body.floorKey, exactQuote: text },
    { source: 'precedingUserInput', sourceFloorKey: body.floorKey, sourceSnapshotIndex: 0, exactQuote: text },
  ];
  const badRefs = [
    { source: 'worldbook', sourceKey: 'not-provided', exactQuote: text },
    { source: 'worldbook', sourceKey: otherBook.sourceKey, exactQuote: text },
    { source: 'worldbook', sourceKey: book.sourceKey, exactQuote: '宿舍\n客房。' },
    { source: 'storedPlaceEvidence', sourceKey: body.evidenceKey },
    { source: 'precedingUserInput', sourceFloorKey: body.floorKey, sourceSnapshotIndex: 1, exactQuote: text },
    { source: 'knownPlaces', sourceKey: 'place-1', exactQuote: text }, null,
  ];
  const run = (refs, task, segments = [{ name:'宿舍',sameAsPlaceKey:'place-1' },{ name:'客房',sameAsPlaceKey:'place-2',mapStyle:'campus',mapLayout:'garden' }]) => foundation.expandPlacePaths({ packet: { placePaths: [{ path: segments, evidence: refs }] }, envelope: { request: { task }, scope }, existingEntities: entities, now: '2026-11-06T00:00:00Z', persistBodyPaths: task === 'organizePlaces' });
  for (const task of ['organizePlaces','extractFloorSemantics']) for (const good of goodRefs) {
    const single = await run([good],task), mixed = await run([badRefs[0],good,...badRefs.slice(1)],task);
    assert.deepEqual(single.isolated, []); assert.deepEqual(mixed.isolated, []);
    assert.deepEqual(mixed.foundationPatch, single.foundationPatch); assert.deepEqual(mixed.packet, single.packet);
    assert.deepEqual(mixed.displayMetadataBindings, single.displayMetadataBindings);
    for (const fact of mixed.foundationPatch.facts) for (const ref of [fact.source,...(fact.source.references ?? [])]) {
      assert.equal(ref.quote, text); assert.notEqual(ref.locator, otherBook.locator);
      if (ref.kind === 'body') assert.equal(ref.floorId, body.floorId);
    }
  }
  for (const refs of [[],badRefs,[badRefs[0]],[badRefs[1]]]) {
    const rejected = await run(refs,'organizePlaces');
    assert.equal(rejected.isolated[0].code,'QQJ_PLACE_PATH_SOURCE_INVALID'); assert.equal(rejected.foundationPatch.facts.length,0);
  }
  for (const [segments,code] of [
    [[{name:'宿舍',sameAsPlaceKey:'not-known'}],'QQJ_PLACE_PATH_IDENTITY_INVALID'],
    [[{name:'客房',sameAsPlaceKey:'place-2'},{name:'宿舍',sameAsPlaceKey:'place-1'}],'QQJ_PLACE_PATH_SCOPE_CONFLICT'],
  ]) {
    const rejected = await run([goodRefs[0],badRefs[0]],'organizePlaces',segments);
    assert.equal(rejected.isolated[0].code,code); assert.equal(rejected.foundationPatch.facts.length,0);
  }
});

test('地点合并父链：保target有效外父，折叠中间成员越过自父或子孙环，同批明确新父仍可更新', () => {
  const source=id(301), target=id(302), outer=id(303), alternate=id(304), child=id(305), f1=id(381), f2=id(382);
  const edge=(placeEntityId,parentEntityId,index,at=f1)=>({itemId:id(index),placeEntityId,parentEntityId,evidenceRefs:[{floorId:at}]});
  const memory=(floorId,containments)=>({floorId,recordStatus:'active',spatialFacts:{containments}});
  const workspace={...emptyPlaceWorkspace(id(90)),identityRedirectsByEntityId:{[source]:target}};
  const seq=new Map([[f1,1],[f2,2]]),resolve=value=>value===source?target:value;
  const preferred=foundation.projectPlaceParentLinks([memory(f1,[edge(target,outer,391)]),memory(f2,[edge(source,alternate,392,f2)])],workspace,seq,Infinity,Infinity,{resolve});
  assert.deepEqual([...preferred.get(target).parents.keys()],[outer]);
  const folded=foundation.projectPlaceParentLinks([memory(f1,[edge(target,child,393),edge(child,source,394),edge(source,outer,395)])],workspace,seq,Infinity,Infinity,{resolve});
  assert.deepEqual([...folded.get(target).parents.keys()],[outer]);
  assert.deepEqual([...folded.get(child).parents.keys()],[target]);
  const manual=structuredClone(workspace);manual.placesByEntityId[target]={parentEntityId:null,scopes:{parentEntityId:{knownThroughFloorId:f1,coveredFloorIds:[f1,f2],coveredItemIds:[]}}};
  assert.equal(foundation.projectPlaceParentLinks([memory(f1,[edge(source,outer,396)])],manual,seq,Infinity,Infinity,{resolve}).get(target).parents.size,0);
  const revised={...workspace,foundation:{schemaVersion:1,entities:[],facts:[{itemId:id(397),kind:'containment',placeEntityId:target,parentEntityId:alternate,identityChange:'ownershipChanged',knownFromFloorId:f2,source:{kind:'body',floorId:f2,quote:'明确新父。'}}]}};
  assert.deepEqual([...foundation.projectPlaceParentLinks([memory(f1,[edge(target,outer,398)])],revised,seq,Infinity,Infinity,{resolve}).get(target).parents.keys()],[alternate]);
});

const cityAncestorFixture = () => {
  const entities = [seed(1,'甲城'),seed(2,'甲宫'),seed(3,'城东'),seed(4,'甲府'),seed(5,'乙府')];
  const node = n => ({name:entities[n-1].displayName,sameAsPlaceKey:`place-${n}`});
  const city = () => ({name:'甲城',mapLevel:'city'}), country = () => ({name:'甲国',mapLevel:'country'});
  const paths = [[country(),city(),{name:'内城'},node(3)],[country(),city(),node(2)],[city(),node(2)],
    [city(),node(3)],[city(),node(3),node(4)],[city(),node(3),node(5)]];
  return {entities,paths};
};

test('显式城市补新国家祖先与原城市根路径共用唯一旧ID，粗细6路径不互相隔离', async () => {
  const {entities,paths}=cityAncestorFixture();
  const sources=paths.map((_,index)=>({sourceKey:`worldbook-${index+1}`,locator:`地图:${index}`,fingerprint:'sha256:abc',content:'甲国包含甲城。甲城内城的东侧是城东，甲府乙府属于城东。甲宫属于甲城。'}));
  const expanded=await foundation.expandPlacePaths({packet:{placePaths:paths.map((path,index)=>({path,source:'worldbook',sourceKey:sources[index].sourceKey,exactQuote:sources[index].content}))},
    envelope:{request:{task:'organizePlaces'},scope:{...envelope.scope,placeWorldbookSources:sources,
      placeCatalogBindings:entities.map((entity,index)=>({entityKey:`place-${index+1}`,entityId:entity.id,labels:[entity.displayName]})),
      parentEntityIdsByPlaceId:new Map([[id(4),new Set([id(3)])],[id(5),new Set([id(3)])]])}},existingEntities:entities,now:'2026-11-09T00:00:00Z',persistBodyPaths:true});
  assert.deepEqual(expanded.isolated,[]);
  assert.equal(expanded.entities.filter(entity=>entity.displayName==='甲城').length,1);
  assert.equal(expanded.entities.find(entity=>entity.displayName==='甲城').id,id(1));
  const workspace=foundation.mergePlaceFoundation(emptyPlaceWorkspace(id(90)),expanded.foundationPatch);
  const parents=foundation.projectPlaceParentLinks([],workspace,new Map());
  assert.equal(parents.get(id(2)).parents.keys().next().value,id(1));
  const inner=expanded.entities.find(entity=>entity.displayName==='内城');
  assert.equal(parents.get(id(3)).parents.keys().next().value,inner.id);
  assert.equal(parents.get(inner.id).parents.keys().next().value,id(1));
});

test('城市补祖先只复用无相反父的唯一旧城市，普通房间、同名歧义和人工父保持各自身份', async t => {
  const run=async({entities,parents=new Map(),child,workspace=emptyPlaceWorkspace(id(90))})=>{
    const source={sourceKey:'worldbook-1',locator:'中性地图:1',fingerprint:'sha256:abc',content:'甲国记录甲城。新馆里有阅览室。'};
    const expanded=await foundation.expandPlacePaths({packet:{placePaths:[{path:[{name:'新上级'},child],source:'worldbook',sourceKey:source.sourceKey,exactQuote:source.content}]},
      envelope:{request:{task:'organizePlaces'},scope:{...envelope.scope,placeCatalogBindings:entities.map((entity,index)=>({entityKey:`place-${index+1}`,entityId:entity.id,labels:[entity.displayName]})),parentEntityIdsByPlaceId:parents,placeWorldbookSources:[source],identityProjection:{placeWorkspace:workspace}}},
      existingEntities:entities,now:'2026-11-09T00:00:00Z',persistBodyPaths:true});
    return {expanded,workspace:foundation.mergePlaceFoundation(workspace,expanded.foundationPatch)};
  };
  await t.test('已有相反父级',async()=>{
    const {expanded}=await run({entities:[seed(1,'甲城'),seed(6,'旧国家')],parents:new Map([[id(1),new Set([id(6)])]]),child:{name:'甲城',mapLevel:'city'}});
    assert.equal(expanded.entities.filter(entity=>entity.displayName==='甲城').length,2);
    assert.ok(expanded.foundationPatch.facts.filter(fact=>fact.kind==='containment').every(fact=>fact.placeEntityId!==id(1)));
  });
  await t.test('多个同名城市',async()=>{
    const {expanded}=await run({entities:[seed(1,'甲城'),seed(6,'甲城')],child:{name:'甲城',mapLevel:'city'}});
    assert.equal(expanded.entities.filter(entity=>entity.displayName==='甲城').length,3);
    assert.ok(expanded.foundationPatch.facts.filter(fact=>fact.kind==='containment').every(fact=>![id(1),id(6)].includes(fact.placeEntityId)));
  });
  await t.test('普通同名房间',async()=>{
    const {expanded}=await run({entities:[seed(1,'阅览室')],child:{name:'阅览室',mapRole:'interior'}});
    assert.equal(expanded.entities.filter(entity=>entity.displayName==='阅览室').length,2);
    assert.ok(expanded.foundationPatch.facts.filter(fact=>fact.kind==='containment').every(fact=>fact.placeEntityId!==id(1)));
  });
  await t.test('显式sameAs优先',async()=>{
    const {expanded}=await run({entities:[seed(1,'甲城'),seed(6,'甲城')],child:{name:'甲城',mapLevel:'city',sameAsPlaceKey:'place-2'}});
    assert.equal(expanded.entities.filter(entity=>entity.displayName==='甲城').length,2);
    assert.ok(expanded.foundationPatch.facts.some(fact=>fact.kind==='containment'&&fact.placeEntityId===id(6)));
  });
  await t.test('人工顶层null',async()=>{
    const manual={...emptyPlaceWorkspace(id(90)),placesByEntityId:{[id(1)]:{parentEntityId:null,scopes:{parentEntityId:{knownThroughFloorId:id(93),coveredFloorIds:[id(93)],coveredItemIds:[]}}}}};
    const {expanded,workspace}=await run({entities:[seed(1,'甲城')],child:{name:'甲城',mapLevel:'city'},workspace:manual});
    assert.equal(expanded.entities.filter(entity=>entity.displayName==='甲城').length,1);
    assert.equal(foundation.projectPlaceParentLinks([],workspace,new Map()).get(id(1)).parents.size,0);
  });
});

test('整理模式只允许已有地点和缺失祖先，初始化删除path隔离不吞健康路径',async()=>{
 const entities=[seed(1,'宿舍'),seed(2,'客房')];
 const run=(mode,paths,deletedPlaceIds=[])=>foundation.expandPlacePaths({packet:{placePaths:paths},envelope:{request:{task:'organizePlaces',payload:{mode}},scope:{...envelope.scope,deletedPlaceIds}},existingEntities:entities,now:'2026-11-12T00:00:00Z',persistBodyPaths:true});
 const unrelated={path:[{name:'宿舍',sameAsPlaceKey:'place-1'},{name:'独立新亭'}],source:'worldbook',sourceKey:source.sourceKey,exactQuote:source.content};
 const organized=await run('organize',[path,unrelated]);assert.equal(organized.freshEntities.some(entity=>entity.displayName==='一楼'),true);assert.equal(organized.freshEntities.some(entity=>entity.displayName==='独立新亭'),false);assert.equal(organized.isolated.length,1);
 const initialized=await run('initialize',[path,{...unrelated,path:[{name:'健康新馆'}]}],[id(2)]);
 assert.equal(initialized.foundationPatch.facts.some(fact=>fact.placeEntityId===id(2)),false);assert.equal(initialized.freshEntities.some(entity=>entity.displayName==='健康新馆'),true);assert.equal(initialized.isolated.length,1);
});


test('Batch17 明确path与唯一同来源spatial声明省略选填key也统一父链及单节点简介', async t => {
 for(const sourceType of ['assistant','precedingUser']) for(const single of [false,true]) await t.test(`${sourceType}/${single?'single':'chain'}`,async()=>{
  const text='青石馆有灶房，灶房内有石灶。',binding={floorId:id(93),floorKey:'floor-1',canonicalContent:text,rawFingerprint:'sha256:body',...(sourceType==='precedingUser'?{sourceUserInputSnapshot:{messages:[{content:text}]}}:{})};
  const evidence={source:sourceType==='assistant'?'canonicalContent':'precedingUserInput',sourceFloorKey:'floor-1',...(sourceType==='precedingUser'?{sourceSnapshotIndex:0}:{}),exactQuote:text};
  const packet={summary:'合法摘要',spatialFacts:{places:[{key:'place-mention-1',name:'灶房',identity:'new',...evidence}],containments:[],positions:[]},placePaths:[{path:[...(single?[]:[{name:'青石馆'}]),{name:'灶房',description:'灶房内有石灶。'}],...evidence}]};
  const result=await foundation.expandPlacePaths({packet,envelope:{request:{task:'extractFloorSemantics'},scope:{...envelope.scope,placeCatalogBindings:[],parentEntityIdsByPlaceId:new Map(),sourceFloorBindings:[binding]}},now:'2026-11-13T00:00:00Z'});
  assert.deepEqual(result.isolated,[]);assert.equal(result.packet.spatialFacts.places.filter(p=>p.name==='灶房').length,1);
  assert.equal(result.packet.spatialFacts.containments.length,single?0:1);assert.ok(result.foundationPatch.facts.some(f=>f.kind==='feature'&&f.text==='灶房内有石灶。'));
 });
});
