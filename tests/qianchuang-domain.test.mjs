import test from 'node:test';
import assert from 'node:assert/strict';
import * as domain from '../src/v3/qianchuang-domain.js';

const id=n=>`${n.toString(16).padStart(8,'0')}-0000-4000-8000-000000000000`;
const floor=n=>({id:id(100+n),assistantSeq:n,hostLocator:{messageIndex:n*2},recordStatus:'active'});
const entity=(n,name,extra={})=>({id:id(n),entityType:'place',displayName:name,aliases:[],specialRole:'none',firstSeenFloorId:id(101),lastSeenFloorId:id(104),status:'established',recordStatus:'active',...extra});
const ref=n=>({floorId:id(100+n),quotedText:'private evidence must not reach the view',occurrence:1,evidenceMode:'explicit'});
const edge=(n,child,parent,source=1)=>({itemId:id(n),placeEntityId:id(child),parentEntityId:id(parent),evidenceRefs:[ref(source)]});
const feature=(n,place,text,source=1,extra={})=>({itemId:id(n),placeEntityId:id(place),kind:'stable',text,replacesItemIds:[],evidenceRefs:[ref(source)],...extra});
const position=(n,place,source=1,status='confirmed',subject=9)=>({itemId:id(n),subjectEntityId:id(subject),placeEntityId:place===null?null:id(place),status,evidenceRefs:[ref(source)]});
const memory=(n,spatial={},extra={})=>({id:id(200+n),floorId:id(100+n),recordStatus:'active',summary:{aiText:'summary',userText:null,effectiveSource:'ai'},sourceCanonicalContent:'private body must not reach the view',participants:[],locations:[],spatialFacts:{schemaVersion:1,containments:[],positions:[],features:[],relations:[],...spatial},...extra});
const graph=(memories,entities=[entity(1,'青石馆'),entity(2,'书房'),entity(3,'内部通道')],count=4)=>({status:'ready',root:{chatId:id(90),narrativeGeneration:id(91),headCheckpointId:id(92)},rootRevision:7,checkpoint:{inputFingerprints:Array.from({length:count},(_,i)=>({floorId:id(101+i),memoryExcluded:false}))},floors:Array.from({length:count},(_,i)=>floor(i+1)),floorMemories:memories,entities});
const project=(value,options)=>{assert.equal(typeof domain.projectQianchuangSnapshot,'function','千窗应提供纯只读地点投影');return domain.projectQianchuangSnapshot(value,options);};

test('较粗祖先包含保留已明确细父链，真移动与人工父级仍可生效',()=>{
 const entities=[entity(1,'本馆'),entity(2,'三楼'),entity(3,'教室'),entity(4,'别馆')];
 const value=graph([memory(1,{containments:[edge(300,3,2),edge(301,2,1)]}),memory(2,{containments:[edge(302,3,1,2)]})],entities);
 assert.equal(project(value).places.find(p=>p.entityId===id(3)).parentEntityId,id(2));
 const moved=structuredClone(value);moved.floorMemories.push(memory(3,{containments:[edge(303,3,4,3)]}));
 assert.equal(project(moved).places.find(p=>p.entityId===id(3)).parentEntityId,id(4));
 assert.equal(project(moved,{throughAssistantSeq:2}).places.find(p=>p.entityId===id(3)).parentEntityId,id(2));
 const workspace={schemaVersion:1,kind:'qqj-v3-place-workspace',chatId:id(90),placesByEntityId:{[id(3)]:{parentEntityId:null,scopes:{}}},deletionsByEntityId:{}};
 assert.equal(project(value,{identityProjection:{placeWorkspace:workspace}}).places.find(p=>p.entityId===id(3)).parentEntityId,null);
});

test('旧资料细父链不会被后楼粗包含覆盖，取材与地图共用归属',async()=>{
 const {projectPlaceOwnership,expandPlaceParents}=await import('../src/v3/spatial-domain.js');
 const entities=[entity(1,'本馆'),entity(2,'三楼'),entity(3,'教室')];
 const value=graph([memory(1),memory(2,{containments:[edge(302,3,1,2)]})],entities);
 const fact=(n,child,parent)=>({itemId:id(n),placeEntityId:id(child),parentEntityId:id(parent),kind:'containment',knownFromFloorId:null,
   source:{kind:'worldbook',locator:'setting:1',quote:'教室在本馆三楼。'}});
 const workspace={schemaVersion:1,kind:'qqj-v3-place-workspace',chatId:id(90),placesByEntityId:{},deletionsByEntityId:{},foundation:{version:1,entities:[],facts:[fact(401,3,2),fact(402,2,1)]}};
 const snapshot=project(value,{identityProjection:{placeWorkspace:workspace}});
 assert.equal(snapshot.places.find(p=>p.entityId===id(3)).parentEntityId,id(2));
 assert.deepEqual([...projectPlaceOwnership(value.floorMemories,Infinity,value.floors,workspace).get(id(3))],[id(2)]);
 assert.deepEqual([...expandPlaceParents([id(3)],value.floorMemories,Infinity,value.floors,workspace)],[id(3),id(2),id(1)]);
});

test('同楼补足中间父链时粗包含不缩短，输入次序与人工祖先不改变结果',()=>{
 const entities=[entity(1,'本馆'),entity(2,'三楼'),entity(3,'教室')];
 for(const edges of [[edge(302,2,1,2),edge(303,3,1,2)],[edge(303,3,1,2),edge(302,2,1,2)]]){
  const value=graph([memory(1,{containments:[edge(300,3,2)]}),memory(2,{containments:edges})],entities);
  assert.equal(project(value).places.find(p=>p.entityId===id(3)).parentEntityId,id(2));
 }
 const value=graph([memory(1,{containments:[edge(300,3,2)]}),memory(2,{containments:[edge(303,3,1,2)]})],entities);
 const workspace={schemaVersion:1,kind:'qqj-v3-place-workspace',chatId:id(90),placesByEntityId:{[id(2)]:{parentEntityId:id(1),scopes:{}}},deletionsByEntityId:{}};
 assert.equal(project(value,{identityProjection:{placeWorkspace:workspace}}).places.find(p=>p.entityId===id(3)).parentEntityId,id(2));
});

test('地图只画有明确下级的根场地，未归属单例完整保留且不按名字猜',()=>{
 const snapshot=project(graph([memory(1,{containments:[edge(300,2,1)]})]));
 assert.deepEqual(snapshot.mapRootIds,[id(1)]);
 assert.deepEqual(snapshot.unassignedPlaceIds,[id(3)]);
 assert.deepEqual(snapshot.places.find(p=>p.entityId===id(1)).childEntityIds,[id(2)]);
 assert.equal(snapshot.places.find(p=>p.entityId===id(2)).mapRootEntityId,id(1));
 assert.equal(snapshot.places.length,3);
});

test('canonical合并与删除同时投影名称、父边及设施，同名不同身份不合并',()=>{
 const entities=[entity(1,'青石馆'),entity(2,'书房'),entity(3,'书房'),entity(4,'旧书房',{status:'merged',mergedIntoEntityId:id(2)}),entity(5,'已删除地点')];
 const snapshot=project(graph([memory(1,{containments:[edge(300,4,1),edge(301,5,1)],features:[feature(302,4,'靠窗设有书桌'),feature(303,5,'不应回显')]})],entities),{identityProjection:{deletedEntityIds:[id(5)]}});
 assert.deepEqual(snapshot.places.map(p=>p.entityId),[id(1),id(2),id(3)]);
 assert.equal(snapshot.places.find(p=>p.entityId===id(2)).features[0].text,'靠窗设有书桌');
 assert.deepEqual(snapshot.containments.map(e=>[e.placeEntityId,e.parentEntityId]),[[id(2),id(1)]]);
 assert.deepEqual(snapshot.unassignedPlaceIds,[id(3)]);
});

test('聚合摘要按实际sourceFloor截止，不用carrier号泄漏未来设施或父边',()=>{
 const aggregate=memory(4,{features:[feature(300,1,'原有书桌',1),feature(301,1,'后来新增屏风',4)],containments:[edge(302,2,1,1),edge(303,3,1,4)]},{sourceFloorIds:[id(101),id(104)]});
 const snapshot=project(graph([aggregate]),{throughAssistantSeq:2});
 assert.equal(snapshot.stableThroughAssistantSeq,2);
 assert.equal(snapshot.summarizedThroughAssistantSeq,1);
 assert.deepEqual(snapshot.places.find(p=>p.entityId===id(1)).features.map(x=>x.text),['原有书桌']);
 assert.deepEqual(snapshot.containments.map(x=>x.sourceAssistantSeq),[1]);
});

test('稳定设施按替换关系保留有效文本，临时与未标定材料不升级',()=>{
 const snapshot=project(graph([memory(1,{features:[feature(300,1,'旧书桌')]}),memory(2,{features:[feature(301,1,'新书桌',2,{replacesItemIds:[id(300)]}),feature(302,1,'临时布景',2,{kind:'temporary'}),feature(303,1,'旧格式未标定',2,{kind:undefined})]})]));
 assert.deepEqual(snapshot.places.find(p=>p.entityId===id(1)).features.map(x=>x.text),['新书桌']);
});

test('最新父级比较实际来源，而非聚合承载楼号',()=>{
 const entities=[entity(1,'甲馆'),entity(2,'房间'),entity(3,'乙馆')];
 const snapshot=project(graph([memory(4,{containments:[edge(300,2,1,1)]},{sourceFloorIds:[id(101),id(104)]}),memory(2,{containments:[edge(301,2,3,2)]})],entities));
 assert.equal(snapshot.places.find(p=>p.entityId===id(2)).parentEntityId,id(3));
 assert.equal(snapshot.containments[0].sourceAssistantSeq,2);
});

test('同源新多父不强选，跨楼新增环保原合法枝',()=>{
 const ambiguous=project(graph([memory(1,{containments:[edge(300,2,1),edge(301,2,3)]})]));
 assert.equal(ambiguous.containments.length,0);assert.equal(ambiguous.places.length,3);
 const cycle=project(graph([memory(1,{containments:[edge(300,1,2)]}),memory(2,{containments:[edge(301,2,1,2)]})]));
 assert.deepEqual(cycle.containments.map(edge=>[edge.placeEntityId,edge.parentEntityId]),[[id(1),id(2)]]);assert.equal(cycle.places.length,3);assert.deepEqual(cycle.mapRootIds,[id(2)]);
});

test('locatedIn/onFloor/relative保原文，均不制造物理父链',()=>{
 const relations=['locatedIn','onFloor','relative'].map((kind,i)=>({itemId:id(300+i),kind,placeEntityId:id(2),referencePlaceEntityIds:[id(1)],text:['位于青石馆','设在二层','在走廊尽头'][i],evidenceRefs:[ref(1)]}));
 const snapshot=project(graph([memory(1,{relations})]));
 assert.equal(snapshot.containments.length,0);assert.equal(snapshot.mapRootIds.length,0);
 assert.deepEqual(snapshot.places.find(p=>p.entityId===id(2)).relations.map(x=>x.text),relations.map(x=>x.text));
});

test('排除楼的设施不发布，普通进度字段不代替真实active摘要',()=>{
 const value=graph([memory(1,{features:[feature(300,1,'被排除的材料')]}),memory(2,{features:[feature(301,2,'可读材料',2)]})]);
 value.checkpoint.inputFingerprints[0].memoryExcluded=true;
 const snapshot=project(value);
 assert.equal(snapshot.places.flatMap(p=>p.features).some(x=>x.text==='被排除的材料'),false);
 assert.equal(snapshot.places.flatMap(p=>p.features).some(x=>x.text==='可读材料'),true);
});

const people=[entity(9,'用户',{entityType:'person',specialRole:'user'}),entity(10,'NPC',{entityType:'person'}),entity(1,'青石馆'),entity(2,'书房'),entity(3,'别处')];
test('最新已摘要楼的user confirmed才标当前，且沿真实包含定位组件',()=>{
 const snapshot=project(graph([memory(1,{containments:[edge(300,2,1)]}),memory(3,{positions:[position(301,2,3)]})],people));
 assert.equal(snapshot.userPosition.status,'confirmed');assert.equal(snapshot.userPosition.isCurrent,true);
 assert.equal(snapshot.userPosition.sourceAssistantSeq,3);assert.equal(snapshot.userPosition.mapRootEntityId,id(1));
});

test('人工登记相同父级后，最新室内位置按最终父树保持当前',()=>{
 const value=graph([memory(1,{containments:[edge(300,2,1)]}),memory(3,{positions:[position(301,2,3)]})],people);
 const workspace={schemaVersion:1,kind:'qqj-v3-place-workspace',chatId:id(90),placesByEntityId:{[id(2)]:{parentEntityId:id(1),scopes:{parentEntityId:{knownThroughFloorId:id(102),coveredFloorIds:[id(101),id(102)],coveredItemIds:[id(300)]}}}},deletionsByEntityId:{}};
 const before=structuredClone({value,workspace});assert.equal(project(value).userPosition.isCurrent,true);
 const snapshot=project(value,{identityProjection:{placeWorkspace:workspace}});
 assert.equal(snapshot.places.find(place=>place.entityId===id(2)).parentEntityId,id(1));
 assert.equal(snapshot.userPosition.placeEntityId,id(2));assert.equal(snapshot.userPosition.mapRootEntityId,id(1));
 assert.equal(snapshot.userPosition.status,'confirmed');assert.equal(snapshot.userPosition.atSummarizedEnd,true);assert.equal(snapshot.userPosition.isCurrent,true);
 assert.deepEqual({value,workspace},before);
});

test('仅整理父树恢复室内归属后，最新确认位置可成为当前',()=>{
 const value=graph([memory(1),memory(3,{positions:[position(301,2,3)]})],people);
 const workspace={schemaVersion:1,kind:'qqj-v3-place-workspace',chatId:id(90),placesByEntityId:{},deletionsByEntityId:{},foundation:{schemaVersion:1,entities:[],facts:[{kind:'containment',itemId:id(302),placeEntityId:id(2),parentEntityId:id(1),knownFromFloorId:id(101),source:{kind:'worldbook',sourceName:'示例地点',locator:'entry:1',quote:'青石馆内设书房。'}}]}};
 assert.equal(project(value).userPosition.isCurrent,false);
 const snapshot=project(value,{identityProjection:{placeWorkspace:workspace}});
 assert.equal(snapshot.userPosition.placeEntityId,id(2));assert.equal(snapshot.userPosition.mapRootEntityId,id(1));assert.equal(snapshot.userPosition.isCurrent,true);
});

test('最终父树恢复不点亮旧楼、旧位置、未知、歧义、删除或范围外位置',()=>{
 const workspace={schemaVersion:1,kind:'qqj-v3-place-workspace',chatId:id(90),placesByEntityId:{[id(2)]:{parentEntityId:id(1),scopes:{parentEntityId:{knownThroughFloorId:id(101),coveredFloorIds:[id(101)],coveredItemIds:[]}}}},deletionsByEntityId:{}};
 const cases=[
  {name:'旧楼confirmed',memories:[memory(1,{positions:[position(301,2)]}),memory(3,{features:[feature(302,2,'书桌',3)]})]},
  {name:'lastSeen',memories:[memory(3,{positions:[position(301,2,3,'lastSeen')]})]},
  {name:'leftUnknown',memories:[memory(3,{positions:[position(301,null,3,'leftUnknown')]})]},
  {name:'同楼歧义',memories:[memory(3,{positions:[position(301,2,3),position(302,3,3)]})]},
  {name:'删除位置',memories:[memory(3,{positions:[position(301,2,3)]})],deletedEntityIds:[id(2)]},
  {name:'删除父级',memories:[memory(3,{positions:[position(301,2,3)]})],deletedEntityIds:[id(1)]},
  {name:'有限历史不读未来位置',memories:[memory(1,{features:[feature(300,2,'书桌')]}),memory(3,{positions:[position(301,2,3)]})],throughAssistantSeq:2},
 ];
 for(const {name,memories,deletedEntityIds,throughAssistantSeq}of cases){
  const snapshot=project(graph(memories,people),{identityProjection:{placeWorkspace:workspace,deletedEntityIds},...(throughAssistantSeq?{throughAssistantSeq}:{})});
  assert.equal(snapshot.userPosition.isCurrent,false,name);
 }
});

test('更早user位置仅为上次位置，最新NPC或场景地点不会取代它',()=>{
 const value=graph([memory(1,{positions:[position(300,1)]}),memory(2,{positions:[position(301,3,2,'confirmed',10)]},{locations:[{entityId:id(3),name:'别处',change:'present',participantEntityIds:[id(10)],evidenceRefs:[ref(2)]}]})],people);
 const snapshot=project(value);assert.equal(snapshot.userPosition.placeEntityId,id(1));assert.equal(snapshot.userPosition.isCurrent,false);
 const noUser=project(graph([value.floorMemories[1]],people));assert.equal(noUser.userPosition.status,'unknown');
});

test('lastSeen与leftUnknown不复活旧confirmed，user canonical别名可投影',()=>{
 for(const status of ['lastSeen','leftUnknown']){
  const snapshot=project(graph([memory(1,{positions:[position(300,1)]}),memory(2,{positions:[position(301,status==='leftUnknown'?null:2,2,status,11)]})],[...people,entity(11,'旧用户',{entityType:'person',status:'merged',mergedIntoEntityId:id(9)})]));
  assert.equal(snapshot.userPosition.status,status);assert.equal(snapshot.userPosition.isCurrent,false);
  if(status==='leftUnknown')assert.equal(snapshot.userPosition.mapRootEntityId,null);
 }
 const left=project(graph([memory(1,{containments:[edge(310,2,1)]}),memory(2,{positions:[position(311,2,2,'leftUnknown')]})],people));
 assert.equal(left.userPosition.placeEntityId,id(2),'保留已离开的来源地点');assert.equal(left.userPosition.mapRootEntityId,null,'去向未知不回挂来源地图');
});

test('无图与已就绪空库区分，DTO不带正文和证据原句且不改输入',()=>{
 assert.equal(project(null).status,'unavailable');
 const value=graph([memory(1,{features:[feature(300,1,'书桌')]})]);const before=structuredClone(value),snapshot=project(value),text=JSON.stringify(snapshot);
 assert.equal(snapshot.status,'ready');assert.equal(project(graph([],[])).places.length,0);
 assert.equal(text.includes('private body'),false);assert.equal(text.includes('private evidence'),false);assert.deepEqual(value,before);
});

 test('新父已删除时不复活旧父，后来等权多父保原合法父',()=>{
 const value=graph([memory(1,{containments:[edge(300,2,1)]}),memory(2,{containments:[edge(301,2,3,2)]})]);
 assert.equal(project(value,{identityProjection:{deletedEntityIds:[id(3)]}}).places.find(p=>p.entityId===id(2)).parentEntityId,null);
 value.floorMemories[1].spatialFacts.containments.push(edge(302,2,1,2));
 assert.equal(project(value).places.find(p=>p.entityId===id(2)).parentEntityId,id(1));
 });

 test('新增合法包含后未归属地点自动进入组件，已有文本不丢失',()=>{
 const source=graph([memory(1,{features:[feature(300,2,'原有书桌')]})]);const before=project(source);assert.ok(before.unassignedPlaceIds.includes(id(2)));
 source.floorMemories.push(memory(2,{containments:[edge(301,2,1,2)]}));const after=project(source);assert.equal(after.unassignedPlaceIds.includes(id(2)),false);assert.equal(after.places.find(p=>p.entityId===id(2)).parentEntityId,id(1));assert.equal(after.places.find(p=>p.entityId===id(2)).features[0].text,'原有书桌');
 });

test('删除前user位置不会随新来源地点设施重现，保最新位置水位不回退',()=>{
 const entities=[entity(1,'宿舍'),entity(2,'A房间'),entity(3,'B房间'),entity(9,'用户',{entityType:'person',specialRole:'user'})];
 const source=graph([memory(1,{positions:[position(300,3,1)]}),memory(2,{positions:[position(301,2,2)]}),memory(3,{features:[feature(302,2,'新增书桌',3)]})],entities);
 const snapshot=project(source,{identityProjection:{placeWorkspace:{schemaVersion:1,kind:'qqj-v3-place-workspace',chatId:id(90),placesByEntityId:{},deletionsByEntityId:{[id(2)]:{coveredFloorIds:[id(101),id(102)]}}},placeWorkspaceRevision:1}});
 assert.ok(snapshot.places.some(place=>place.entityId===id(2)),'新来源设施让地点正常重收');assert.equal(snapshot.userPosition.status,'unknown');assert.equal(snapshot.userPosition.placeEntityId,null);
});

test('手工无role共同父含明确area子级时进入区域容器，楼层与独立建筑不误进',async()=>{
 const {projectQianchuangBrowse}=await import('../src/ui/qianchuang-browse.js'),node=(entityId,childEntityIds=[],mapRole=undefined,parentEntityId=null)=>({entityId,childEntityIds,mapRole,parentEntityId});
 const snapshot={mapRootIds:['top'],places:[node('top',['a','b']),node('a',['sa'],'area','top'),node('b',['sb'],'area','top'),node('sa',[],'site','a'),node('sb',[],'site','b')]},before=structuredClone(snapshot),browse=projectQianchuangBrowse(snapshot);assert.equal(browse.scopeId,'top');assert.deepEqual(browse.groups.map(g=>g.entityId),['a','b']);assert.deepEqual(browse.pinIds,['sa','sb']);assert.deepEqual(snapshot,before);
 assert.equal(projectQianchuangBrowse({mapRootIds:['top'],places:[node('top',['room']),node('room',[],'interior','top')]}).scopeId,null);
 assert.equal(projectQianchuangBrowse({mapRootIds:['top'],places:[node('top',['site']),node('site',[],'site','top')]}).scopeId,null);
 snapshot.places[0].childEntityIds=['a'];assert.equal(projectQianchuangBrowse(snapshot).scopeId,'a');snapshot.places[0].mapRole='site';assert.equal(projectQianchuangBrowse(snapshot).scopeId,null);
});
test('共同area容器的直属site留未命名组，不把范围父再画成子区域；叶area保原单区',async()=>{
 const {projectQianchuangBrowse}=await import('../src/ui/qianchuang-browse.js'),node=(entityId,childEntityIds=[],mapRole=undefined,parentEntityId=null)=>({entityId,childEntityIds,mapRole,parentEntityId});
 const snapshot={mapRootIds:['scope'],places:[node('scope',['a','b','site','room'],'area'),node('a',[],'area','scope'),node('b',[],'area','scope'),node('site',[],'site','scope'),node('room',[],undefined,'scope')]},before=structuredClone(snapshot),browse=projectQianchuangBrowse(snapshot);assert.equal(browse.scopeId,'scope');assert.deepEqual(browse.groups.map(g=>g.entityId),['a','b',null]);assert.deepEqual(browse.groups.at(-1).siteIds,['site','room']);assert.deepEqual(browse.treeRootIds,['a','b','site','room']);assert.deepEqual(snapshot,before);
 assert.deepEqual(projectQianchuangBrowse({mapRootIds:['scope'],places:[node('scope',['site'],'area'),node('site',[],'site','scope')]}).groups,[{entityId:'scope',siteIds:['site']}]);
});

test('当前简介与覆盖同时生效，有限历史仍只读原facts且未读同楼增量不被吞',()=>{
 const old=memory(1,{features:[feature(300,1,'原有床和卫浴')],relations:[{itemId:id(310),placeEntityId:id(1),kind:'relative',referencePlaceEntityIds:[],text:'走廊深处',evidenceRefs:[ref(1)]}]}),newer=memory(2,{features:[feature(301,1,'新增窗帘',2),feature(302,1,'未读独立净化器',2)]}),value=graph([old,newer]),before=JSON.stringify(value);
 const workspace={schemaVersion:1,kind:'qqj-v3-place-workspace',chatId:id(90),placesByEntityId:{},deletionsByEntityId:{},foundation:{schemaVersion:1,entities:[],facts:[{itemId:id(400),kind:'feature',placeEntityId:id(1),text:'床、卫浴和窗帘。',replacesItemIds:[id(300),id(301)],knownFromFloorId:id(102),source:{kind:'body',floorId:id(102),quote:'新增窗帘',references:[{kind:'body',floorId:id(101),quote:'原有床和卫浴'},{kind:'body',floorId:id(102),quote:'新增窗帘'}]}},{itemId:id(401),kind:'relation',placeEntityId:id(1),text:'走廊尽头',replacesItemIds:[id(310)],knownFromFloorId:id(102),source:{kind:'body',floorId:id(102),quote:'走廊尽头'}}]}};
 const current=project(value,{identityProjection:{placeWorkspace:workspace}}).places.find(p=>p.entityId===id(1));assert.deepEqual(current.features.map(f=>f.text),['未读独立净化器','床、卫浴和窗帘。']);assert.deepEqual(current.relations.map(f=>f.text),['走廊尽头']);
 const history=project(value,{identityProjection:{placeWorkspace:workspace},throughAssistantSeq:1}).places.find(p=>p.entityId===id(1));assert.deepEqual(history.features.map(f=>f.text),['原有床和卫浴']);assert.deepEqual(history.relations.map(f=>f.text),['走廊深处']);assert.equal(JSON.stringify(value),before);
});

test('分支地点库复制当前简介及覆盖，截止楼重落但原来源楼和Core原facts不改',async()=>{
 const {createPlaceWorkspaceStore,emptyPlaceWorkspace}=await import('../src/v3/place-workspace.js'),records=new Map(),targetChat=id(95),client={async get(c){if(!records.has(c))throw Object.assign(Error('missing'),{status:404});return structuredClone(records.get(c));},async put(c,key,data,revision){const row={data:structuredClone(data),revision:revision+1};records.set(c,row);return structuredClone(row);}},store=createPlaceWorkspaceStore({client});
 const workspace={...emptyPlaceWorkspace(id(90)),foundation:{schemaVersion:1,entities:[],facts:[{itemId:id(450),kind:'feature',placeEntityId:id(1),text:'床、卫浴与新窗。',replacesItemIds:[id(300)],knownFromFloorId:id(102),source:{kind:'body',floorId:id(102),quote:'后楼新增窗。'}}]}};await store.put({chatId:id(90)},workspace,0);const sourceBefore=JSON.stringify(records.get('chat-'+id(90)));
 const copied=await store.copy({chatId:id(90)},{chatId:targetChat},{targetFloors:[floor(1)],sourceEntities:[]});assert.equal(copied.data.foundation.facts[0].knownFromFloorId,id(101));assert.equal(copied.data.foundation.facts[0].source.floorId,id(102));assert.deepEqual(copied.data.foundation.facts[0].replacesItemIds,[id(300)]);
 const source=graph([memory(1,{features:[feature(300,1,'原床和卫浴')]})],undefined,1);source.root.chatId=targetChat;const result=project(source,{identityProjection:{placeWorkspace:copied.data}});assert.deepEqual(result.places.find(p=>p.entityId===id(1)).features.map(f=>f.text),['床、卫浴与新窗。']);assert.equal(source.floorMemories[0].spatialFacts.features[0].text,'原床和卫浴');assert.equal(JSON.stringify(records.get('chat-'+id(90))),sourceBefore);
});

test('合并简介的旧来源不把本批末尾才可用的全文提前带入聚合历史',()=>{
 const snapshot=feature(470,1,'床、卫浴和后加的窗帘',1,{source:{kind:'body',floorId:id(101),quote:'旧床',knownFromFloorId:id(104),references:[{kind:'body',floorId:id(101),quote:'旧床'},{kind:'body',floorId:id(104),quote:'新增窗帘'}]}}),value=graph([memory(4,{features:[snapshot]},{sourceFloorIds:[id(101),id(104)]})]);
 const early=project(value,{throughAssistantSeq:2});assert.equal(early.places.find(p=>p.entityId===id(1)).features.length,0);assert.equal(project(value).places.find(p=>p.entityId===id(1)).features[0].text,snapshot.text);
});
