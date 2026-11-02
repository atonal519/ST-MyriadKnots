import test from 'node:test';
import assert from 'node:assert/strict';
const {createFoundationStore}=await import('../src/v3/foundation-store.js');
const {createFoundationRuntime}=await import('../src/v3/foundation-runtime.js');
const {createHostAdapter}=await import('../src/v3/host-adapter.js');
const {createChatMemoryMigration}=await import('../src/chat-memory-migration.js');
const {createChatBranchInitializer}=await import('../src/v3/chat-branch-inheritance.js');
const {createPlaceWorkspaceStore,emptyPlaceWorkspace,placeWorkspaceForPrefix}=await import('../src/v3/place-workspace.js');
const {projectQianchuangSnapshot}=await import('../src/v3/qianchuang-domain.js');
const {deriveUserIdentityProjection}=await import('../src/v3/entity-identity.js');
const {expandPlacePaths,mergePlaceFoundation}=await import('../src/v3/place-foundation.js');

test('201搬家分支和删尾保最新地点库，显式历史前缀仍按出处裁',async()=>{
const NOW='2026-11-02T00:00:00.000Z';
const uid=n=>`${n.toString(16).padStart(8,'0')}-0000-4000-8000-000000000000`;
const A=uid(1),B=uid(2),ROOT=uid(10),LEAF=uid(11),DELETED=uid(12);let BODY;
let fresh=100;const freshUuid=()=>uid(++fresh);
const identity=(chatId,hostChatId='source-file')=>({chatId,hostChatId,characterLocator:'reader.png',personaLocator:'persona.png'});
const trace=[],records=new Map(),files=new Map();let rejectPlaceCopy=false;
const clone=structuredClone;
const client={
 async get(collection,id){trace.push(['get',collection,id]);const row=records.get(`${collection}/${id}`);if(!row)throw Object.assign(new Error('missing'),{status:404});return clone(row);},
 async put(collection,id,data,revision){trace.push(['put',collection,id]);if(rejectPlaceCopy&&collection!==`chat-${A}`&&id==='v3-place-workspace')throw new Error('place copy failure');const k=`${collection}/${id}`,prior=records.get(k);if((prior?.revision??0)!==revision)throw Object.assign(new Error('conflict'),{status:409});const row={data:clone(data),revision:revision+1,createdAt:NOW,updatedAt:NOW};records.set(k,row);return clone(row);},
 async list(collection){return [...records].filter(([key])=>key.startsWith(`${collection}/`)).map(([key,row])=>({...clone(row),recordId:key.slice(collection.length+1)}));}
};
const assistant=mes=>({is_user:false,is_system:false,mes,swipes:[mes],swipe_id:0});
const user=mes=>({is_user:true,is_system:false,mes,send_date:'fixed'});
const context=(chatId,chat)=>({chatId,name1:'用户',name2:'合成人物',characterId:0,groupId:null,characters:[{name:'合成人物',avatar:'reader.png'}],userAvatar:'persona.png',chat,chatMetadata:{qianqianjie:{schemaVersion:2,chatId:A}},getRequestHeaders:()=>({}),saveChat:async()=>true,saveMetadata:async()=>{},openCharacterChat:async()=>{}});
const raw=context('source-file',[user('开始'),assistant('中性测试楼'),user('继续'),assistant('后续中性楼'),user('继续后续')]);
const adapter=createHostAdapter({globalRef:{SillyTavern:{getContext:()=>raw}}});
const storeFor=id=>createFoundationStore({client,contextProvider:()=>id});
const store=storeFor(identity(A));
const foundation=createFoundationRuntime({hostAdapter:adapter,store,contextProvider:()=>raw,now:()=>new Date(NOW),newUuid:freshUuid,logger:{warn(){}}});
assert.equal((await foundation.start()).status,'ready');
const graph=await store.readReachable({mode:'runtime'}),floor=graph.floors[0];
assert.ok(floor);
for(const f of graph.floors)raw.chat[f.hostLocator.messageIndex].extra={qianqianjie_floor:{schemaVersion:1,chatId:A,floorId:f.id}};
const removedFloorId=graph.floors[1].id;
const scope={knownThroughFloorId:floor.id,coveredFloorIds:[floor.id],coveredItemIds:[]};
const entity=(id,name)=>({schemaVersion:3,recordType:'entity',id,chatId:A,narrativeGeneration:graph.root.narrativeGeneration,entityType:'place',displayName:name,aliases:[],specialRole:'none',firstSeenFloorId:null,lastSeenFloorId:null,status:'provisional',mergedIntoEntityId:null,mergeEvidenceRefs:[],baselineClaimIds:[],createdAt:NOW,updatedAt:NOW,recordStatus:'active',supersedes:null});
const ws=emptyPlaceWorkspace(A);
ws.placesByEntityId[ROOT]={createdEntity:entity(ROOT,'合成范围'),name:'手工范围名',parentEntityId:null,mapLevel:'scope',scopes:{name:scope,parentEntityId:scope,mapLevel:scope}};
ws.placesByEntityId[LEAF]={createdEntity:entity(LEAF,'合成场地'),description:'人工校准描述',parentEntityId:ROOT,scopes:{description:scope,parentEntityId:scope}};
ws.deletionsByEntityId[DELETED]={knownThroughFloorId:floor.id,coveredFloorIds:[floor.id],coveredItemIds:[]};
ws.mapStyle='sci-fi';
ws.foundation={schemaVersion:1,entities:[entity(DELETED,'已删除示例')],facts:[
 {itemId:uid(20),kind:'place',placeEntityId:ROOT,mapRole:'area',mapLevel:'scope',mapStyle:'sci-fi',mapLayout:'linear',mapAssetId:'sci-fi-linear',facilities:[{icon:'Sofa',label:'沙发'}],knownFromFloorId:floor.id,source:{kind:'worldbook',sourceName:'synthetic',locator:'entry:1',fingerprint:'synthetic',quote:'独立范围'}},
 {itemId:uid(21),kind:'containment',placeEntityId:LEAF,parentEntityId:ROOT,knownFromFloorId:floor.id,source:{kind:'worldbook',sourceName:'synthetic',locator:'entry:1',fingerprint:'synthetic',quote:'场地属于范围'}},
]};
const bodyQuote='后续楼明确：独立机舱内有沙发。';
const bodyPathEnvelope={request:{task:'organizePlaces',payload:{knownPlaces:[]}},scope:{chatId:A,narrativeGeneration:graph.root.narrativeGeneration,batchId:uid(1000),floorId:removedFloorId,parentEntityIdsByPlaceId:new Map(),placeCatalogBindings:[],sourceFloorBindings:[{evidenceKey:'stored-1',floorId:removedFloorId,floorKey:'floor-2',rawFingerprint:'synthetic-body',canonicalContent:bodyQuote,sourceType:'assistant'}]}};
const bodyExpansion=await expandPlacePaths({packet:{placePaths:[{path:[{name:'正文后楼地点',mapLevel:'scope',mapRole:'area',mapStyle:'sci-fi',mapLayout:'linear',facilities:[{icon:'Sofa',label:'沙发'}],description:'仅被删除后楼明确的设施'}],evidence:[{source:'storedPlaceEvidence',sourceKey:'stored-1',exactQuote:bodyQuote}]}]},envelope:bodyPathEnvelope,existingEntities:[],now:NOW,persistBodyPaths:true});
assert.equal(bodyExpansion.isolated.length,0);
BODY=bodyExpansion.freshEntities[0].id;
assert.equal(bodyExpansion.freshEntities[0].firstSeenFloorId,null);
Object.assign(ws,mergePlaceFoundation(ws,bodyExpansion.foundationPatch));
assert.ok(ws.foundation.facts.some(f=>f.placeEntityId===BODY&&f.source.kind==='body'&&f.knownFromFloorId===removedFloorId));
const places=createPlaceWorkspaceStore({client});await places.put(identity(A),ws,0);
const before=JSON.stringify([...records].filter(([k])=>k.startsWith(`chat-${A}/`)));
const snapshot=(g,w)=>projectQianchuangSnapshot(g,{identityProjection:{placeWorkspace:w,placeWorkspaceRevision:w?1:0}});
const sourceSnapshot=snapshot(graph,ws);
const fetchImpl=async(url,options={})=>{const body=JSON.parse(options.body??'{}'),key=body.file_name;if(url==='/api/chats/save'){files.set(key,clone(body.chat));return{ok:true,status:200,json:async()=>({})};}if(url==='/api/chats/get'){const file=files.get(key);return{ok:!!file,status:file?200:404,json:async()=>clone(file??{})};}throw new Error(`unexpected fake fetch ${url}`);};
files.set(raw.chatId,[{chat_metadata:clone(raw.chatMetadata)},...clone(raw.chat)]);
const session={identity:()=>identity(A),getState:()=>({status:'ready',identity:identity(A)}),suspend(){},resume(){},async prepare(){return {status:'ready',identity:identity(A)};}};
const migration=createChatMemoryMigration({client,session,hostAdapter:adapter,sourceStoreForIdentity:storeFor,listHostChats:async()=>[],freshUuid,now:()=>new Date(NOW),fetchImpl});
let start=trace.length;const moved=await migration.migrateCurrent(),migrationTrace=trace.slice(start);
const movedGraph=await storeFor(identity(moved.chatId,moved.hostChatId)).readReachable();
const movedPlaces=await places.read(identity(moved.chatId));
const branchRaw=context('branch-file',clone(raw.chat.slice(0,3)));
const branchAdapter=createHostAdapter({globalRef:{SillyTavern:{getContext:()=>branchRaw}}});
files.set(branchRaw.chatId,[{chat_metadata:clone(branchRaw.chatMetadata)},...clone(branchRaw.chat)]);
const init=createChatBranchInitializer({client,hostAdapter:branchAdapter,now:()=>new Date(NOW),fetchImpl});
start=trace.length;const branched=await init({raw:branchRaw,host:{hostChatId:branchRaw.chatId,characterAvatar:'reader.png',personaAvatar:'persona.png'},sourceChatId:A,targetChatId:B}),branchTrace=trace.slice(start);
const branchGraph=await storeFor(identity(B,branchRaw.chatId)).readReachable(),branchPlaces=await places.read(identity(B));
assert.equal(moved.status,'completed');assert.equal(branched.status,'inherited');
assert.ok(movedPlaces.data);assert.ok(branchPlaces.data);assert.equal(snapshot(movedGraph,movedPlaces.data).places.length,sourceSnapshot.places.length);assert.equal(snapshot(branchGraph,branchPlaces.data).places.length,sourceSnapshot.places.length);assert.equal(branched.inheritedFloors,1);assert.equal(movedPlaces.data.chatId,moved.chatId);assert.equal(branchPlaces.data.chatId,B);
assert.equal(JSON.stringify([...records].filter(([k])=>k.startsWith(`chat-${A}/`))),before);

for(const [data,g]of [[movedPlaces.data,movedGraph],[branchPlaces.data,branchGraph]])for(const entity of [...Object.values(data.placesByEntityId).flatMap(r=>r.createdEntity?[r.createdEntity]:[]),...(data.foundation?.entities??[])]){assert.equal(entity.chatId,g.root.chatId);assert.equal(entity.narrativeGeneration,g.root.narrativeGeneration);}
const edited=clone(branchPlaces.data);edited.placesByEntityId[LEAF].description='目标已有人工内容';await places.put(identity(B),edited,branchPlaces.revision);
await init({raw:branchRaw,host:{hostChatId:branchRaw.chatId,characterAvatar:'reader.png',personaAvatar:'persona.png'},sourceChatId:A,targetChatId:B});
assert.equal((await places.read(identity(B),{fresh:true})).data.placesByEntityId[LEAF].description,'目标已有人工内容');
// Required auxiliary data must precede publishing a new Core root or chat identity.
const filesBefore=files.size,traceBefore=trace.length;rejectPlaceCopy=true;
await assert.rejects(migration.migrateCurrent(),/place copy failure/);rejectPlaceCopy=false;
assert.equal(files.size,filesBefore);
const failedMigrationCollection=trace.slice(traceBefore).find(row=>row[0]==='put'&&row[2]==='v3-place-workspace')[1];
assert.equal(records.has(failedMigrationCollection+'/v3-root'),false);
const failedRaw=context('failed-branch-file',clone(raw.chat)),failedAdapter=createHostAdapter({globalRef:{SillyTavern:{getContext:()=>failedRaw}}}),failedChatId=uid(9000);
files.set(failedRaw.chatId,[{chat_metadata:clone(failedRaw.chatMetadata)},...clone(failedRaw.chat)]);
const failedInit=createChatBranchInitializer({client,hostAdapter:failedAdapter,now:()=>new Date(NOW),fetchImpl});rejectPlaceCopy=true;
await assert.rejects(failedInit({raw:failedRaw,host:{hostChatId:failedRaw.chatId,characterAvatar:'reader.png',personaAvatar:'persona.png'},sourceChatId:A,targetChatId:failedChatId}),/place copy failure/);rejectPlaceCopy=false;
assert.equal(records.has(`chat-${failedChatId}/v3-root`),false);assert.equal(files.get(failedRaw.chatId)[0].chat_metadata.qianqianjie.chatId,A);

// Actual Foundation tail truncation, using the same event evidence shape as MESSAGE_DELETED.
raw.chat.splice(3);
const tailResult=await foundation.reconcile('readerTail',{tailDeletion:{identity:{hostChatId:'source-file',chatId:A,characterLocator:'reader.png',personaLocator:'persona.png'},epoch:0,newLen:3}});
assert.equal(tailResult.status,'ready',JSON.stringify(tailResult));
const cutGraph=await store.readReachable({mode:'runtime'});
assert.equal(cutGraph.floors.length,1);
const projectedPrefix=deriveUserIdentityProjection({...cutGraph,identityProjection:{placeWorkspace:ws,placeWorkspaceRevision:1}});
const afterCut=snapshot(cutGraph,projectedPrefix.placeWorkspace);

assert.equal(afterCut.places.some(p=>p.entityId===BODY),true,'当前地点库不随删楼撤销');assert.ok(afterCut.places.some(p=>p.entityId===ROOT&&p.mapLevel==='scope'));
const historical=placeWorkspaceForPrefix(ws,new Set(cutGraph.floors.map(f=>f.id)));
assert.equal(snapshot(cutGraph,historical).places.some(p=>p.entityId===BODY),false);assert.equal(historical.foundation.facts.some(f=>f.source?.kind==='body'),false);
assert.equal(projectQianchuangSnapshot(cutGraph,{identityProjection:{placeWorkspace:ws},throughAssistantSeq:1}).places.some(p=>p.entityId===BODY),false,'显式历史视图仍按前缀取材');

});

for (const mode of ['auto-worldbook','auto-body','auto-late-body','manual-early','manual-full','manual-core-parent','auto-known-parent','auto-late-correction']) test(`201最新地点库沿正式分支独立承接：${mode}`,async()=>{
const NOW='2026-11-02T00:00:00.000Z';
const uid=n=>`${n.toString(16).padStart(8,'0')}-0000-4000-8000-000000000000`;
const A=uid(1),B=uid(2),ROOT=uid(10),LEAF=uid(11),DELETED=uid(12);let BODY;
let fresh=100;const freshUuid=()=>uid(++fresh);
const identity=(chatId,hostChatId='source-file')=>({chatId,hostChatId,characterLocator:'reader.png',personaLocator:'persona.png'});
const trace=[],records=new Map(),files=new Map();let rejectPlaceCopy=false;
const clone=structuredClone;
const client={
 async get(collection,id){trace.push(['get',collection,id]);const row=records.get(`${collection}/${id}`);if(!row)throw Object.assign(new Error('missing'),{status:404});return clone(row);},
 async put(collection,id,data,revision){trace.push(['put',collection,id]);if(rejectPlaceCopy&&collection!==`chat-${A}`&&id==='v3-place-workspace')throw new Error('place copy failure');const k=`${collection}/${id}`,prior=records.get(k);if((prior?.revision??0)!==revision)throw Object.assign(new Error('conflict'),{status:409});const row={data:clone(data),revision:revision+1,createdAt:NOW,updatedAt:NOW};records.set(k,row);return clone(row);},
 async list(collection){return [...records].filter(([key])=>key.startsWith(`${collection}/`)).map(([key,row])=>({...clone(row),recordId:key.slice(collection.length+1)}));}
};
const assistant=mes=>({is_user:false,is_system:false,mes,swipes:[mes],swipe_id:0});
const user=mes=>({is_user:true,is_system:false,mes,send_date:'fixed'});
const context=(chatId,chat)=>({chatId,name1:'用户',name2:'合成人物',characterId:0,groupId:null,characters:[{name:'合成人物',avatar:'reader.png'}],userAvatar:'persona.png',chat,chatMetadata:{qianqianjie:{schemaVersion:2,chatId:A}},getRequestHeaders:()=>({}),saveChat:async()=>true,saveMetadata:async()=>{},openCharacterChat:async()=>{}});
const raw=context('source-file',[user('开始'),assistant('合成范围包括合成场地，场地有沙发。'),user('继续'),assistant('后续中性楼'),user('继续后续')]);
const adapter=createHostAdapter({globalRef:{SillyTavern:{getContext:()=>raw}}});
const storeFor=id=>createFoundationStore({client,contextProvider:()=>id});
const store=storeFor(identity(A));
const foundation=createFoundationRuntime({hostAdapter:adapter,store,contextProvider:()=>raw,now:()=>new Date(NOW),newUuid:freshUuid,logger:{warn(){}}});
assert.equal((await foundation.start()).status,'ready');
let graph=await store.readReachable({mode:'runtime'});const floor=graph.floors[0];
assert.ok(floor);
for(const f of graph.floors)raw.chat[f.hostLocator.messageIndex].extra={qianqianjie_floor:{schemaVersion:1,chatId:A,floorId:f.id}};
const removedFloorId=graph.floors[1].id;
const scope={knownThroughFloorId:floor.id,coveredFloorIds:[floor.id],coveredItemIds:[]};
const entity=(id,name)=>({schemaVersion:3,recordType:'entity',id,chatId:A,narrativeGeneration:graph.root.narrativeGeneration,entityType:'place',displayName:name,aliases:[],specialRole:'none',firstSeenFloorId:null,lastSeenFloorId:null,status:'provisional',mergedIntoEntityId:null,mergeEvidenceRefs:[],baselineClaimIds:[],createdAt:NOW,updatedAt:NOW,recordStatus:'active',supersedes:null});

const {createExtractorEnvelope}=await import('../src/v3/extractor.js');
const {normalizeExtractorResponse}=await import('../src/v3/extractor.js');
const variant=mode,memoryIds=[];
for(const f of graph.floors){const envelope=await createExtractorEnvelope({batchId:f.id,chatId:A,narrativeGeneration:graph.root.narrativeGeneration,checkpointId:graph.checkpoint.id,floor:f});const ev={source:'canonicalContent',sourceFloorKey:envelope.request.payload.sourceFloorKey,exactQuote:f.content.canonicalContent};
const response=variant==='auto-late-correction'&&f.id===floor.id?{summary:'匿名已保存摘要',locations:[{name:'合成场地',change:'present'}],spatialFacts:{places:[{key:'place-mention-1',name:'旧范围',identity:'new',...ev},{key:'place-mention-2',name:'合成场地',identity:'new',...ev}],containments:[{placeKey:'place-mention-2',parentPlaceKey:'place-mention-1',...ev}]}}:{summary:'匿名已保存摘要'};
const compiled=await normalizeExtractorResponse({envelope,floor:f,response,existingEntities:[],now:NOW,expectedScope:envelope.scope});memoryIds.push(compiled.memory.id);await client.put(`chat-${A}`,`v3-floor-memory-${compiled.memory.id}`,compiled.memory,0);
for(const e of compiled.newEntities){await client.put(`chat-${A}`,`v3-entity-${e.id}`,e,0);records.get(`chat-${A}/v3-checkpoint-${graph.checkpoint.id}`).data.producedRefs.entities.push(e.id);} }
records.get(`chat-${A}/v3-checkpoint-${graph.checkpoint.id}`).data.producedRefs.floorMemories=memoryIds;
records.get(`chat-${A}/v3-checkpoint-${graph.checkpoint.id}`).data.capabilities.memoryReady=true;
records.get(`chat-${A}/v3-root`).data.capabilities.memoryReady=true;
graph=await storeFor(identity(A)).readReachable({mode:'runtime'});
assert.equal(graph.status,'ready');
const early=mode!=='manual-full';
let ws=emptyPlaceWorkspace(A),expectedRoot=ROOT,expectedLeaf=LEAF,knownParent=null;const knownLeaf=mode==='auto-late-correction'?graph.entities.find(e=>e.displayName==='合成场地'):null;
if(['auto-known-parent','manual-core-parent'].includes(mode)){
 knownParent={...entity(ROOT,'合成范围'),firstSeenFloorId:removedFloorId,lastSeenFloorId:removedFloorId};
 await client.put(`chat-${A}`,`v3-entity-${ROOT}`,knownParent,0);
 records.get(`chat-${A}/v3-checkpoint-${graph.checkpoint.id}`).data.producedRefs.entities.push(ROOT);
 graph=await storeFor(identity(A)).readReachable({mode:'runtime'});
}
const book={kind:'worldbook',sourceName:'synthetic',locator:'entry:1',fingerprint:'synthetic',quote:'已知地点'};
if(mode.startsWith('auto-')){
 const lateBody=mode==='auto-late-body',evidenceFloor=lateBody?graph.floors[1]:floor;const quote=knownLeaf?'合成场地现归合成范围。':evidenceFloor.content.canonicalContent,body=mode==='auto-body'||lateBody;
 const binding=body?{sourceFloorBindings:[{evidenceKey:'stored-1',floorId:evidenceFloor.id,floorKey:lateBody?'floor-2':'floor-1',rawFingerprint:evidenceFloor.content.rawFingerprint,canonicalContent:quote,sourceType:'assistant'}]}:{placeWorldbookSources:[{sourceKey:'worldbook-1',sourceName:'synthetic',locator:'entry:1',fingerprint:'synthetic',content:quote}]};
 const evidence=body?{source:'storedPlaceEvidence',sourceKey:'stored-1',exactQuote:quote}:{source:'worldbook',sourceKey:'worldbook-1',exactQuote:quote};
 const expansion=await expandPlacePaths({packet:{placePaths:[{path:[{name:'合成范围',...(knownParent?{sameAsPlaceKey:'place-1'}:{}),mapLevel:'scope',mapRole:'area',mapStyle:'sci-fi',mapLayout:'linear'},{name:'合成场地',...(knownLeaf?{sameAsPlaceKey:'place-2'}:{}),mapRole:'site',description:'场地有沙发',facilities:[{icon:'Sofa',label:'沙发'}]}],evidence:[evidence]}]},envelope:{request:{task:'organizePlaces'},scope:{chatId:A,narrativeGeneration:graph.root.narrativeGeneration,batchId:uid(1000),floorId:knownLeaf||lateBody?removedFloorId:floor.id,placeCatalogBindings:knownParent?[{entityKey:'place-1',entityId:ROOT,labels:['合成范围']}]:knownLeaf?[{entityKey:'place-2',entityId:knownLeaf.id,labels:['合成场地']}]:[],...binding}},existingEntities:knownParent?[knownParent]:knownLeaf?[knownLeaf]:[],now:NOW,persistBodyPaths:true});
 assert.deepEqual(expansion.isolated,[]);ws=mergePlaceFoundation(ws,expansion.foundationPatch);
 expectedRoot=knownParent?.id??expansion.freshEntities.find(e=>e.displayName==='合成范围').id;expectedLeaf=knownLeaf?.id??expansion.freshEntities.find(e=>e.displayName==='合成场地').id;
}else{
 const late={knownThroughFloorId:removedFloorId,coveredFloorIds:graph.floors.map(f=>f.id),coveredItemIds:[]};
 ws.placesByEntityId[ROOT]={...(knownParent?{}:{createdEntity:entity(ROOT,'人工共同范围')}),name:'人工共同范围',parentEntityId:null,mapLevel:'scope',scopes:{name:late,parentEntityId:late,mapLevel:late}};
 ws.foundation={schemaVersion:1,entities:[],facts:[]};
 for(let i=0;i<22;i++){const id=uid(200+i);ws.foundation.entities.push(entity(id,'匿名场地'+i));ws.foundation.facts.push({itemId:uid(300+i),kind:'place',placeEntityId:id,mapRole:'site',knownFromFloorId:floor.id,source:book});ws.placesByEntityId[id]={parentEntityId:ROOT,scopes:{parentEntityId:late}};}
 expectedLeaf=uid(200);
}
ws.mapStyle='sci-fi';
ws.deletionsByEntityId[DELETED]={knownThroughFloorId:removedFloorId,coveredFloorIds:graph.floors.map(f=>f.id),coveredItemIds:[]};
ws.foundation??={schemaVersion:1,entities:[],facts:[]};ws.foundation.entities.push(entity(DELETED,'已删除场地'));
ws.foundation.facts.push({itemId:uid(999),kind:'place',placeEntityId:DELETED,mapRole:'site',knownFromFloorId:removedFloorId,source:book});
const places=createPlaceWorkspaceStore({client});await places.put(identity(A),ws,0);
const before=JSON.stringify([...records].filter(([k])=>k.startsWith(`chat-${A}/`)));
const snapshot=(g,w)=>projectQianchuangSnapshot(g,{identityProjection:{placeWorkspace:w,placeWorkspaceRevision:1}});
const sourceSnapshot=snapshot(graph,ws);
const fetchImpl=async(url,options={})=>{const body=JSON.parse(options.body??'{}'),key=body.file_name;if(url==='/api/chats/save'){files.set(key,clone(body.chat));return{ok:true,status:200,json:async()=>({})};}if(url==='/api/chats/get'){const file=files.get(key);return{ok:!!file,status:file?200:404,json:async()=>clone(file??{})};}throw new Error(`unexpected fake fetch ${url}`);};
const branchRaw=context('branch-file',clone(early?raw.chat.slice(0,3):raw.chat));
const branchAdapter=createHostAdapter({globalRef:{SillyTavern:{getContext:()=>branchRaw}}});
files.set(branchRaw.chatId,[{chat_metadata:clone(branchRaw.chatMetadata)},...clone(branchRaw.chat)]);
const init=createChatBranchInitializer({client,hostAdapter:branchAdapter,now:()=>new Date(NOW),fetchImpl});
const branched=await init({raw:branchRaw,host:{hostChatId:branchRaw.chatId,characterAvatar:'reader.png',personaAvatar:'persona.png'},sourceChatId:A,targetChatId:B});
const target=await storeFor(identity(B,branchRaw.chatId)).readReachable(),targetPlaces=await places.read(identity(B)),result=snapshot(target,targetPlaces.data);
assert.equal(branched.status,'inherited');assert.equal(JSON.stringify([...records].filter(([k])=>k.startsWith(`chat-${A}/`))),before);

assert.equal(target.floorMemories.length,early?1:2,'摘要仍只来自实际复制范围');
assert.equal(target.stateDeltas.length,0,'不引入源后续CSE');
assert.deepEqual(targetPlaces.data.deletionsByEntityId,ws.deletionsByEntityId,'最新删除记录完整承接');
assert.equal(targetPlaces.data.mapStyle,'sci-fi');
assert.equal(result.places.some(p=>p.entityId===DELETED),false);
const rootRow=result.places.find(p=>p.entityId===expectedRoot),leafRow=result.places.find(p=>p.entityId===expectedLeaf);
if(mode.startsWith('auto-')){
 assert.equal(leafRow.parentEntityId,expectedRoot,'最新自动父级不被旧摘要父级盖回');
 assert.equal(rootRow.mapLevel,'scope');assert.equal(rootRow.mapStyle,'sci-fi');assert.equal(rootRow.mapLayout,'linear');
 assert.ok(leafRow.facilities.some(f=>f.icon==='Sofa'));assert.ok(leafRow.features.some(f=>f.text==='场地有沙发'));
}else{
 assert.equal(result.places.length,23);assert.equal(result.unassignedPlaceIds.length,0);assert.equal(leafRow.parentEntityId,ROOT);
}
if(mode==='auto-known-parent'){
 const tailRecords=new Map([...records].map(([key,value])=>[key,structuredClone(value)])),tailClient={
  async get(c,id){const value=tailRecords.get(c+'/'+id);if(!value)throw Object.assign(Error('missing'),{status:404});return structuredClone(value);},
  async put(c,id,data,revision){const key=c+'/'+id;assert.equal(revision,tailRecords.get(key)?.revision??0);const value={data:structuredClone(data),revision:revision+1,createdAt:NOW,updatedAt:NOW};tailRecords.set(key,value);return structuredClone(value);}
 },tailRaw=context('source-file',structuredClone(raw.chat));tailRaw.chat.splice(3);
 const tailAdapter=createHostAdapter({globalRef:{SillyTavern:{getContext:()=>tailRaw}}}),tailStore=createFoundationStore({client:tailClient,contextProvider:()=>identity(A)}),tailRuntime=createFoundationRuntime({hostAdapter:tailAdapter,store:tailStore,contextProvider:()=>tailRaw,now:()=>new Date(NOW),newUuid:freshUuid,logger:{warn(){}}});
 tailRuntime.adoptReachable(graph);const tailState=await tailRuntime.reconcile('201-current-tail',{tailDeletion:{identity:{hostChatId:'source-file',chatId:A,characterLocator:'reader.png',personaLocator:'persona.png'},epoch:0,newLen:3}});assert.equal(tailState.status,'ready',JSON.stringify(tailState));
 const cut=await tailStore.readReachable();assert.equal(cut.floors.length,1);
 for(const currentSource of [cut,{...cut,entities:[...cut.entities,knownParent]}]){const currentAfterCut=snapshot(currentSource,ws);assert.equal(currentAfterCut.places.find(p=>p.entityId===expectedLeaf).parentEntityId,expectedRoot,'当前库保身份，包括Core仍携带旧firstSeen锚的同UUID记录');}
}

if(knownParent){assert.equal(target.entities.some(e=>e.id===knownParent.id),false,'不拷未来Core实体图');const seed=targetPlaces.data.foundation.entities.find(e=>e.id===knownParent.id);assert.ok(seed,'只在地点库补同UUID身份');assert.equal(seed.firstSeenFloorId,null);assert.equal(seed.lastSeenFloorId,null);}
if(knownLeaf){
 assert.equal(sourceSnapshot.places.find(p=>p.entityId===expectedLeaf).parentEntityId,expectedRoot);
 const correction=targetPlaces.data.foundation.facts.find(f=>f.kind==='containment'&&f.placeEntityId===expectedLeaf);
 assert.equal(correction.knownFromFloorId,target.floors.at(-1).id,'缺失资料校准锚承接到分支基点');
 const old=graph.floorMemories.find(m=>m.floorId===floor.id),futureId=uid(9900),futureFloor={...target.floors[0],id:futureId,assistantSeq:2},futureMemory=structuredClone(old);
 futureMemory.id=uid(9901);futureMemory.floorId=futureId;futureMemory.sourceFloorIds=[futureId];
 for(const item of [...futureMemory.locations,...Object.values(futureMemory.spatialFacts).flat()])for(const ref of item.evidenceRefs??[])ref.floorId=futureId;
 const futureSource={...target,floors:[...target.floors,futureFloor],floorMemories:[...target.floorMemories,futureMemory]};
 const futureSnapshot=snapshot(futureSource,targetPlaces.data),oldParent=old.spatialFacts.containments[0].parentEntityId;
 assert.equal(futureSnapshot.places.find(p=>p.entityId===expectedLeaf).parentEntityId,oldParent,'目标后续更晚地点事实仍可更新父级');
}
const originalSources=ws.foundation.facts.map(f=>JSON.stringify(f.source));
assert.deepEqual(targetPlaces.data.foundation.facts.map(f=>JSON.stringify(f.source)),originalSources,'原始引文出处不重写');
const sheets=(await import('../src/ui/qianchuang-city-sheets.js')).projectQianchuangSheets(result);assert.ok(sheets.sheets.some(s=>s.id===expectedRoot));
const cold=createPlaceWorkspaceStore({client}),coldWorkspace=await cold.read(identity(B),{fresh:true});assert.deepEqual(snapshot(target,coldWorkspace.data),result,'冷读整树一致');
const edited=structuredClone(coldWorkspace.data);edited.placesByEntityId[expectedLeaf]??={scopes:{}};edited.placesByEntityId[expectedLeaf].description='分支独立描述';edited.placesByEntityId[expectedLeaf].scopes.description={knownThroughFloorId:target.floors.at(-1).id,coveredFloorIds:target.floors.map(f=>f.id),coveredItemIds:[]};
await places.put(identity(B),edited,coldWorkspace.revision);await init({raw:branchRaw,host:{hostChatId:branchRaw.chatId,characterAvatar:'reader.png',personaAvatar:'persona.png'},sourceChatId:A,targetChatId:B});
assert.equal((await cold.read(identity(B),{fresh:true})).data.placesByEntityId[expectedLeaf].description,'分支独立描述','已有目标不覆盖');
assert.equal(JSON.stringify([...records].filter(([k])=>k.startsWith(`chat-${A}/`))),before,'源记录逐字保持');
});
