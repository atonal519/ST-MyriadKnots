import test from 'node:test';import assert from 'node:assert/strict';import * as world from '../src/ui/qianchuang-worldbook.js';
const p=(id,name,aliases=[],parent=null,root=null)=>({entityId:id,displayName:name,aliases,parentEntityId:parent,mapRootEntityId:root,childEntityIds:[],features:[],relations:[]});
const snapshot={status:'ready',chatId:'chat',places:[p('a','石桥园',['Unit K'],null,'a'),p('entry','Unit K 玄关',['玄关'],'a','a'),p('living','Penthouse Unit K 客厅',['客厅']),p('studio','二楼综合录音室',['综合录音室'],'a','a'),p('own','走廊尽头林川房间',['林川房间'],'a','a')],mapRootIds:['a'],unassignedPlaceIds:['living']};
const candidate=(value,extra={})=>({kind:'worldbook',id:'book:1',fingerprint:'hash',hostEnabled:true,availability:'enabled',primaryKeys:[],content:JSON.stringify(value),...extra});
const project=(value=snapshot,candidates=[],macros={})=>{assert.equal(typeof world.projectQianchuangWorldInfo,'function');return world.projectQianchuangWorldInfo(value,{candidates,macros});};
const descriptions=(value,id)=>value.places.find(p=>p.entityId===id).worldInfoDescriptions??[];

test('空key多层JSON按具名节点补五处本节点物理字段，父子与人物材料不串',()=>{
 const entry=candidate({'不动产概要':{'物业名称':'Stone Bridge (石桥) Penthouse Unit K','类型':'两层住宅','开发商':'PRIVATE_COMPANY'},'下层生活区':{'1. 玄关 (Entrance)':{'特征':['感应灯','全镜面鞋柜'],'常客':['PRIVATE_PERSON']},'2. 客厅 (Living Room)':{'布局':'下沉式空间','家具':['沙发','长桌'],'特殊':'PRIVATE_PLOT'},'3. 林川的房间':{'布局':'安静角落','使用者':'PRIVATE_PERSON'}},'上层工作区':{'1. 综合录音室 (Studio)':{'设备':['专业调音台','隔音棚'],'使用者':['PRIVATE_PERSON']}}});
 const before=structuredClone(snapshot),value=project(snapshot,[entry]);assert.deepEqual(snapshot,before);assert.equal(value.places.length,5);
 for(const id of ['a','entry','living','studio','own'])assert.ok(descriptions(value,id).length,id);
 assert.deepEqual(descriptions(value,'a').map(v=>v.text),['两层住宅']);assert.deepEqual(descriptions(value,'studio').map(v=>v.text),['专业调音台','隔音棚']);assert.equal(JSON.stringify(value).includes('PRIVATE_'),false);
});
test('同名不同父仅按明确物理scope消歧，未知归属不猜与邻楼不串',()=>{
 const value={...snapshot,places:[p('a','石桥园',[],null,'a'),p('b','松园',[],null,'b'),p('ra','东侧书房',['书房'],'a','a'),p('rb','西侧书房',['书房'],'b','b')],mapRootIds:['a','b']};
 const result=project(value,[candidate({'石桥园':{'书房':{'描述':'甲书桌'}},'松园':{'书房':{'描述':'乙书桌'}}})]);assert.equal(descriptions(result,'ra')[0].text,'甲书桌');assert.equal(descriptions(result,'rb')[0].text,'乙书桌');
 const unknown=project(value,[candidate({'不明甲楼':{'书房':{'描述':'不应挂入'}},'不明乙楼':{'书房':{'描述':'不应挂入'}}})]);assert.equal(unknown.places.flatMap(p=>p.worldInfoDescriptions??[]).length,0);
 const sole={...value,places:value.places.filter(p=>p.entityId!=='rb')};assert.equal(project(sole,[candidate({'不明甲楼':{'书房':{'描述':'甲'}},'不明乙楼':{'书房':{'描述':'乙'}}})]).places.flatMap(p=>p.worldInfoDescriptions??[]).length,0,'多个来源父scope未知时不混贴唯一短名');
});
test('物业标识有完整边界，专属房间只允许完整同owner同根唯一命名变体',()=>{
 assert.equal(descriptions(project(snapshot,[candidate({'物业名称':'Other Penthouse Unit KK','类型':'不能按Unit K子串挂入'})]),'a').length,0);
 for(const [name,target] of [['林的房间','走廊尽头林川房间'],['林川的客房','走廊尽头林川房间'],['林川和林河的房间','走廊尽头林川房间'],['林川的房间','随意前缀林川房间']]){
  const value={...snapshot,places:snapshot.places.map(p=>p.entityId==='own'?{...p,displayName:target,aliases:[]}:p)};
  assert.equal(descriptions(project(value,[candidate({'石桥园':{[name]:{'布局':'不可猜配'}}})]),'own').length,0,name);
 }
 const missing={...snapshot,places:snapshot.places.map(p=>p.entityId==='own'?{...p,parentEntityId:null,mapRootEntityId:null}:p)};assert.equal(descriptions(project(missing,[candidate({'石桥园':{'林川的房间':{'布局':'缺父不能猜'}}})]),'own').length,0);
 const duplicate={...snapshot,places:[...snapshot.places,p('other','走廊最深处林川房间',[],'a','a')]};assert.equal(descriptions(project(duplicate,[candidate({'石桥园':{'林川的房间':{'布局':'重复不能猜'}}})]),'own').length,0);
});
test('宏在JSON解析后静态替换，禁用/坏JSON/人物脚本不贴，原文不改且精确文本去重',()=>{
 const user='林“川”',value={...snapshot,places:[p('a','石桥园',[],null,'a'),p('r',`${user}的房间`,[],'a','a')]};
 const entry=candidate({'石桥园':{'{{user}}的房间':{'描述':'{{char}}的书桌','设备':['书桌','书桌'],'使用者':user}}});const result=project(value,[entry],{user,char:'合成角色'});
 assert.deepEqual(descriptions(result,'r').map(x=>x.text),['合成角色的书桌','书桌']);assert.ok(result.places.find(p=>p.entityId==='r').parentEntityId==='a');
 for(const entry of [candidate({'石桥园':{'描述':'disabled'}},{hostEnabled:false}),candidate({'石桥园':{'描述':'disabled'}},{availability:'disabled'}),candidate({}, {content:'<% throw new Error("never execute") %>'}),candidate({'名称':'石桥园','性格':'PERSON','外观':'不能当地点'}),candidate({'石桥园':{'描述':'<% if (condition) { %>conditional<% } %>'}})])assert.equal(descriptions(project(snapshot,[entry]),'a').length,0);
});

test('独立entry精确primaryKey可给无名JSON根描述，scope可穿过中间容器而显式歧义不丢失',()=>{
 assert.equal(descriptions(project(snapshot,[candidate({'描述':'独立条目原文'},{primaryKeys:['石桥园']})]),'a')[0]?.text,'独立条目原文');
 const places=[p('a','甲苑',['Unit K'],null,'a'),p('b','乙苑',['Unit K'],null,'b'),p('ra','甲书房',['书房'],'a','a'),p('rb','乙书房',['书房'],'b','b')],value={...snapshot,places,mapRootIds:['a','b']};
 const scoped=project(value,[candidate({'甲苑':{'下层':{'书房':{'描述':'甲桌'}}},'乙苑':{'下层':{'书房':{'描述':'乙桌'}}}})]);
 assert.equal(descriptions(scoped,'ra')[0]?.text,'甲桌');assert.equal(descriptions(scoped,'rb')[0]?.text,'乙桌');
 const sole={...value,places:places.filter(p=>p.entityId!=='rb')};const ambiguous=project(sole,[candidate({'概要':{'物业名称':'Other House Unit K'},'下层':{'书房':{'描述':'不能越过物业歧义'}}})]);
 assert.equal(ambiguous.places.flatMap(p=>p.worldInfoDescriptions??[]).length,0);
});

test('secondaryKeys只是额外触发条件，不作地点身份或覆盖人物primaryKey',()=>{
 const value=project(snapshot,[candidate({'描述':'不应贴到地点的人物故事'},{primaryKeys:['林川'],secondaryKeys:['石桥园']})]);
 assert.equal(descriptions(value,'a').length,0);
});

test('明确另一个已知根被拒时，其子节点不退回外层旧根',()=>{
 const value={...snapshot,places:[p('a','甲苑',[],null,'a'),p('b','乙苑',[],null,'b'),p('ra','甲书房',['书房'],'a','a'),p('rb','乙书房',['书房'],'b','b')],mapRootIds:['a','b']};
 const result=project(value,[candidate({'甲苑':{'乙苑':{'书房':{'描述':'不能落回甲书房'}}}})]);
 assert.equal(result.places.flatMap(p=>p.worldInfoDescriptions??[]).length,0);
});
