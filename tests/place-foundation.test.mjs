import test from 'node:test';
import assert from 'node:assert/strict';
import * as foundation from '../src/v3/place-foundation.js';
import { emptyPlaceWorkspace, validatePlaceWorkspace, applyPlaceSnapshot } from '../src/v3/place-workspace.js';
import { projectQianchuangSnapshot } from '../src/v3/qianchuang-domain.js';
import { expandPlaceParents } from '../src/v3/spatial-domain.js';
import {captureQianchuangCharacterSources} from '../src/place-worldbook-material.js';

const id=n=>`${n.toString(16).padStart(8,'0')}-0000-4000-8000-000000000000`;
const seed=(n,name)=>({schemaVersion:3,recordType:'entity',id:id(n),chatId:id(90),narrativeGeneration:id(91),entityType:'place',displayName:name,aliases:[],specialRole:'none',firstSeenFloorId:null,lastSeenFloorId:null,status:'provisional',mergedIntoEntityId:null,mergeEvidenceRefs:[],baselineClaimIds:[],createdAt:'2026-10-31T00:00:00.000Z',updatedAt:'2026-10-31T00:00:00.000Z',recordStatus:'active',supersedes:null});
const source={sourceKey:'worldbook-1',locator:'地图:18',fingerprint:'sha256:abc',content:'宿舍一楼设有客房。客房内有独立浴室。别馆一楼也设有客房。'};
const envelope={scope:{chatId:id(90),narrativeGeneration:id(91),batchId:id(92),floorId:id(93),placeCatalogBindings:[{entityKey:'place-1',entityId:id(1),labels:['宿舍']},{entityKey:'place-2',entityId:id(2),labels:['客房']}],parentEntityIdsByPlaceId:new Map([[id(2),new Set([id(1)])]]),placeWorldbookSources:[source]}};
const path={path:[{name:'宿舍',sameAsPlaceKey:'place-1'},{name:'一楼'},{name:'客房',sameAsPlaceKey:'place-2'}],source:'worldbook',sourceKey:'worldbook-1',exactQuote:'宿舍一楼设有客房。客房内有独立浴室。',description:'内有独立浴室。'};

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
