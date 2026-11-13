import {projectQianchuangSnapshot} from '../src/v3/qianchuang-domain.js';
import {startQianchuangMapCatalog} from '../src/qianchuang-map-catalog.js';
import {QIANCHUANG_MAP_ASSETS} from '../src/qianchuang-map-assets.js';
import {CITY_MAPS} from '../src/ui/qianchuang-city-maps.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as module from '../src/ui/qianchuang-view.js';
class Node {
 constructor(tag='div'){this.tag=tag;this.children=[];this.listeners={};this.attributes={};this.style={setProperty(k,v){this[k]=v;}};this.dataset={};this.className='';this.hidden=false;this.classList={add(){},remove(){}};}
 append(...nodes){for(const n of nodes){this.children.push(n);n.parentNode=this;}} replaceChildren(...nodes){this.children=[];this.append(...nodes);}
 setAttribute(k,v){this.attributes[k]=String(v);if(k==='class')this.className=String(v);}getAttribute(k){return this.attributes[k]??null;}addEventListener(k,f){this.listeners[k]=f;}fire(k,event={}){return this.listeners[k]?.({target:this,...event});}
 querySelector(selector){
  if(selector!=='svg'||!String(this.innerHTML??'').includes('<svg'))return null;
  if(this.svgSource!==this.innerHTML){
   this.svgSource=this.innerHTML;this.svgRoot=new SvgNode('svg');
   const tag=this.innerHTML.match(/<svg\b[^>]*>/)?.[0]??'';
   for(const match of tag.matchAll(/([\w:-]+)="([^"]*)"/g))this.svgRoot.setAttribute(match[1],match[2]);
  }
  return this.svgRoot;
 }
 getBoundingClientRect(){const size=this.tag==='span'?27.2:this.tag==='button'?44:400;return{left:0,top:0,width:size,height:size,right:size,bottom:size};}
 contains(n){return flat(this).includes(n);}getRootNode(){return {activeElement:null};}focus(){this.focusCalls=(this.focusCalls??0)+1;}scrollIntoView(options){this.scrollOptions=options;}remove(){this.parentNode.children=this.parentNode.children.filter(n=>n!==this);}
}
class SvgNode extends Node{getTotalLength(){return 120;}getPointAtLength(n){return{x:12+8*Math.cos(n/120*Math.PI*2),y:12+10*Math.sin(n/120*Math.PI*2)};}}
const flat=n=>[n,...n.children.flatMap(flat)];
const chat='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const place=(id,name,children=[],parent=null)=>({entityId:id,displayName:name,childEntityIds:children,parentEntityId:parent,mapRootEntityId:parent||children.length?'root':null,features:[{text:`${name}的已有设施`}],relations:[]});
const initial={status:'ready',chatId:chat,projectionRevision:1,places:[place('root','青石馆',['room']),place('room','书房',[],'root'),place('orphan','通道')],mapRootIds:['root'],unassignedPlaceIds:['orphan'],userPosition:{status:'unknown'}};

test('183实际地图共享折叠未归属树，搜索定位和手动挂父不造页或混点',async()=>{
 let editor;const saved=[],context={chatId:chat},data={...initial,places:[{...place('a','独立甲',['as']),mapLevel:'scope',mapRole:'area',mapAssetId:'sci-fi-linear'},{...place('as','甲场地',[],'a'),mapRole:'site'},{...place('b','独立乙',['bs']),mapLevel:'scope',mapRole:'area',mapAssetId:'terrain-coast'},{...place('bs','乙场地',[],'b'),mapRole:'site'},{...place('unknown','未定上级',['child']),mapRole:'area'},{...place('child','旧房间',[],'unknown'),mapRole:'site',features:[{text:'遗留线索'}]}],mapRootIds:['a','b','unknown'],unassignedPlaceIds:['unknown'],userPosition:{status:'lastSeen',placeEntityId:'child',isCurrent:false}},h=harness({snapshot:data,dialog:{custom(value){editor=value;return new Promise(()=>{});}},editingRuntime:{getPlaceEditContext:()=>context,savePlace:async(id,fields,scope)=>saved.push({id,fields,scope})}});
 await h.view.activate();const page=h.find('qqj-window-page')[0],geometry=h.find('qqj-window-geometry')[0],pins=()=>h.find('qqj-window-marker').map(n=>n.attributes['data-place-id']);assert.deepEqual(h.find('qqj-window-city-tab').map(n=>n.attributes['data-city-sheet-target']),['a','b']);assert.deepEqual(pins(),['as']);assert.equal(h.find('qqj-window-unassigned')[0].open,false);
 h.find('qqj-window-position')[0].fire('click');assert.equal(page.attributes['data-city-sheet'],'a');assert.equal(h.find('qqj-window-geometry')[0],geometry);assert.equal(h.find('qqj-window-unassigned')[0].open,true);assert.ok(flat(h.find('qqj-window-directory')[0]).find(n=>n.attributes['data-place-id']==='child').open);assert.deepEqual(pins(),['as']);
 const search=h.find('qqj-history-search-input')[0];search.value='遗留线索';search.fire('input');assert.equal(h.find('qqj-window-unassigned')[0].open,true);assert.equal(h.find('qqj-window-geometry')[0],geometry);
 h.find('qqj-window-city-tab').find(n=>n.attributes['data-city-sheet-target']==='b').fire('click');assert.deepEqual(pins(),['bs']);assert.ok(flat(h.find('qqj-window-directory')[0]).some(n=>n.attributes['data-place-id']==='child'));
 h.find('qqj-window-edit').find(n=>n.attributes['data-edit-place']==='child').fire('click');const parent=flat(editor.content).find(n=>n.attributes['data-place-field']==='parentEntityId'),options=flat(parent).filter(n=>n.className.split(' ').includes('qqj-inline-select-option'));assert.ok(options.some(n=>n.attributes['data-value']==='a'));assert.ok(options.some(n=>n.attributes['data-value']==='b'));options.find(n=>n.attributes['data-value']==='a').fire('click');await editor.submit();assert.deepEqual(saved,[{id:'child',fields:{parentEntityId:'a'},scope:context}]);assert.equal(h.writes.length,0);
 h.emit({projectionRevision:2,places:data.places.map(n=>n.entityId==='child'?{...n,parentEntityId:'a'}:n.entityId==='a'?{...n,childEntityIds:['as','child']}:n.entityId==='unknown'?{...n,childEntityIds:[]}:n)});assert.ok(!flat(h.find('qqj-window-directory')[0]).some(n=>n.attributes['data-place-id']==='child'));assert.deepEqual(pins(),['bs']);assert.deepEqual(h.find('qqj-window-city-tab').map(n=>n.attributes['data-city-sheet-target']),['a','b']);
});

test('183没有有效地图只保目录且不读底图，失效页回实际默认而不造other',async()=>{
 let loads=0;const noMap={...initial,places:[place('unknown','旧孤点')],mapRootIds:[],unassignedPlaceIds:['unknown'],userPosition:{status:'lastSeen',placeEntityId:'unknown',isCurrent:false}},h=harness({snapshot:noMap,loadCityMap:async()=>{loads++;return'<svg/>';},loadGenericMap:async()=>{loads++;return'<svg/>';}});await h.view.activate();assert.equal(h.find('qqj-window-map-group')[0].hidden,true);assert.equal(h.find('qqj-window-geometry').length,0);assert.equal(h.find('qqj-window-marker').length,0);assert.equal(loads,0);assert.equal(h.find('qqj-window-unassigned')[0].hidden,false);h.find('qqj-window-position')[0].fire('click');assert.equal(h.find('qqj-window-unassigned')[0].open,true);
 const a={...place('a','实际甲',['as']),mapLevel:'scope',mapRole:'area'},b={...place('b','实际乙',['bs']),mapLevel:'scope',mapRole:'area'};h.emit({projectionRevision:2,places:[a,{...place('as','场地甲',[],'a'),mapRole:'site'},b,{...place('bs','场地乙',[],'b'),mapRole:'site'},...noMap.places],mapRootIds:['a','b']});h.find('qqj-window-city-tab').find(n=>n.attributes['data-city-sheet-target']==='b').fire('click');h.emit({projectionRevision:3,places:[a,{...place('as','场地甲',[],'a'),mapRole:'site'},{...b,childEntityIds:[],mapLevel:'city'},...noMap.places],mapRootIds:['a']});assert.equal(h.find('qqj-window-page')[0].attributes['data-city-sheet'],'a');assert.equal(h.find('qqj-window-map-group')[0].hidden,false);assert.deepEqual(h.find('qqj-window-marker').map(n=>n.attributes['data-place-id']),['as']);assert.equal(h.writes.length,0);
});

test('180独立页默认下钻唯一地区链，逐页换素材与点位同切，叶说明无伪pin且迟到图不串页',async()=>{
 let resolveA,resolveB;const a=new Promise(resolve=>resolveA=resolve),b=new Promise(resolve=>resolveB=resolve);
 const data={...initial,places:[{...place('a','独立环境甲',['common']),mapLevel:'scope',mapRole:'area',mapAssetId:'sci-fi-linear'},{...place('common','共同区域',['d1','d2'],'a'),mapRole:'area'},{...place('d1','一区',['s1'],'common'),mapRole:'area'},{...place('d2','二区',['s2'],'common'),mapRole:'area'},{...place('s1','甲站',[],'d1'),mapRole:'site'},{...place('s2','乙站',[],'d2'),mapRole:'site'},{...place('b','独立环境乙'),mapLevel:'scope',mapAssetId:'modern-inland',features:[{text:'已有海岸说明。'}]}],mapRootIds:['a'],unassignedPlaceIds:['b'],userPosition:{status:'unknown',placeEntityId:'s1'}},h=harness({snapshot:data,loadGenericMap:id=>id==='sci-fi-linear'?a:b});await h.view.activate();
 assert.equal(h.find('qqj-window-map')[0].attributes['data-basemap'],'sci-fi-linear');assert.deepEqual(h.find('qqj-window-area-open').map(node=>node.attributes['data-scope-id']),['d1','d2']);assert.deepEqual(h.find('qqj-window-marker').map(node=>node.attributes['data-place-id']),['s1','s2']);
 flat(h.find('qqj-window-city-switcher')[0]).find(node=>node.attributes['data-city-sheet-target']==='b').fire('click');assert.equal(h.find('qqj-window-map')[0].attributes['data-basemap'],'modern-inland');assert.equal(h.find('qqj-window-marker').length,0);assert.ok(h.find('qqj-window-copy').some(node=>node.textContent==='已有海岸说明。'));
 resolveB('<svg data-preview="B"></svg>');await Promise.resolve();resolveA('<svg data-preview="A"></svg>');await Promise.resolve();await Promise.resolve();assert.match(h.find('qqj-window-geometry')[0].innerHTML,/data-preview="B"/);assert.equal(h.writes.length,0);
});

test('179同聊天自动换图重排点位，手动图优先，设施显式空和模型短标签优先',async()=>{
 const data={...initial,mapStyle:'modern-town',places:initial.places.map(node=>({...node,features:[{text:'设有沙发。'}],facilities:node.entityId==='root'?[{icon:'Armchair',label:'休憩软榻'}]:[]}))},h=harness({snapshot:data});await h.view.activate();assert.equal(h.find('qqj-window-map')[0].attributes['data-basemap'],'modern-town-plain');assert.deepEqual(h.find('qqj-window-tag').map(node=>node.children[1].textContent),['休憩软榻']);
 const old=h.find('qqj-window-marker')[0];h.emit({mapStyle:'sci-fi',projectionRevision:2});assert.equal(h.find('qqj-window-map')[0].attributes['data-basemap'],'sci-fi-linear');assert.notEqual(h.find('qqj-window-marker')[0],old);
 h.stored.qianchuangBasemaps[chat]='palace';h.emit({projectionRevision:3});assert.equal(h.find('qqj-window-map')[0].attributes['data-basemap'],'palace-axial');assert.equal(h.writes.length,0);
});
function harness({snapshot=initial,prepareSession=async()=>({status:'ready'}),sessionStateProvider=null,worldInfoProvider=null,dialog=null,editingRuntime={},loadCityMap=async()=>'<svg class="qqj-real-basemap"></svg>',loadGenericMap=async()=>'<svg class="qqj-generic-basemap"></svg>',userAvatarProvider=()=>null}={}){
 let value=structuredClone(snapshot),listeners=new Set(),prepares=0,writes=[];const stored={qianchuangBasemaps:{[other]:'town'},apiModel:'keep'};
 const runtime={getQianchuangSnapshot:()=>value,subscribe:f=>{listeners.add(f);return()=>listeners.delete(f);},prepareCurrent:async()=>{prepares++;return {status:'ready'};}};
 Object.assign(runtime,editingRuntime);
 const settings={get:()=>stored,update:p=>{writes.push(p);Object.assign(stored,p);}};
 const created=[];assert.equal(typeof module.createQianchuangView,'function');const view=module.createQianchuangView({runtime,settings,prepareSession,sessionStateProvider,worldInfoProvider,dialog,loadCityMap,loadGenericMap,userAvatarProvider,documentRef:{createElementNS:(_,tag)=>{const n=new SvgNode(tag);created.push(n);return n;},createElement:t=>{const n=new Node(t);created.push(n);return n;}}}),container=new Node();view.mount(container);
 return {view,container,runtime,writes,stored,created,get prepares(){return prepares;},emit(patch){value={...value,...patch};for(const f of listeners)f();},find:cls=>flat(container).filter(n=>n.className?.split(' ').includes(cls))};
}

test('六个旧底图保存值直接读取同用途图库且不改设置',async()=>{
 const aliases={modern:'modern-inland',town:'old-town-inland',palace:'palace-axial','modern-town':'modern-town-plain','old-town':'old-town-plain','sci-fi':'sci-fi-linear'};
 for(const[key,id]of Object.entries(aliases)){
  const loads=[],h=harness({loadGenericMap:async asset=>{loads.push(asset);return '<svg></svg>';}});await h.view.activate();await Promise.resolve();loads.length=0;
  h.stored.qianchuangBasemaps[other]=key;h.emit({...initial,chatId:other,projectionRevision:2});await Promise.resolve();
  assert.equal(h.find('qqj-window-map')[0].attributes['data-basemap'],id,key);assert.deepEqual(loads,[id],key);assert.equal(h.stored.qianchuangBasemaps[other],key);assert.equal(h.writes.length,0);
 }
});

test('新通用OSM素材沿原版权位置署名，舰内仍保设施来源',async()=>{
 for(const[id,style,layout]of [['modern-coast','modern','coast'],['terrain-forest','terrain','forest'],['palace-axial','palace','axial'],['sci-fi-linear','sci-fi','linear']]){
  const data={...initial,places:[{...place('scope','范围',['site']),mapLevel:'scope',mapRole:'area',mapStyle:style,mapLayout:layout,mapAssetId:id},{...place('site','场地',[],'scope'),mapRole:'site'}],mapRootIds:['scope'],unassignedPlaceIds:[]},h=harness({snapshot:data});await h.view.activate();
  assert.equal(h.find('qqj-window-map')[0].attributes['data-basemap'],id);assert.equal(h.find('qqj-window-copyright')[0].hidden,id==='sci-fi-linear',id);assert.equal(h.writes.length,0);
 }
});

test('切页快照同revision只画一次地点树，重挂复用已解析底图', async () => {
 let loads=0;
 const h=harness({snapshot:{...initial,mapStyle:'sci-fi'},loadGenericMap:async()=>{loads++;return '<svg data-parsed="cached"></svg>';}});
 const entry=h.find('qqj-window-entry')[0];
 await h.view.activate();
 assert.equal(h.find('qqj-window-entry')[0],entry);
 await Promise.resolve();await Promise.resolve();
 const geometry=h.find('qqj-window-geometry')[0];
 h.view.deactivate();h.view.mount(h.container);await h.view.activate();
 assert.equal(h.find('qqj-window-geometry')[0],geometry);
 assert.equal(loads,1);
 h.emit({projectionRevision:2,places:initial.places.map(node=>({...node,displayName:node.displayName+'改'}))});
 assert.notEqual(h.find('qqj-window-entry')[0],entry);
 assert.equal(h.find('qqj-window-geometry')[0],geometry);
});
test('196地图胶囊同聊天点击刷新重开保持横滚，切聊归零且不写设置',async()=>{
 const places=Array.from({length:8},(_,i)=>({...place(`scope-${i}`,`独立范围${i}`),mapLevel:'scope',mapRole:'area'})),data={...initial,places,mapRootIds:places.map(p=>p.entityId),unassignedPlaceIds:[]},h=harness({snapshot:data});await h.view.activate();
 const bar=()=>h.find('qqj-window-city-switcher')[0],page=()=>h.find('qqj-window-page')[0];bar().scrollLeft=156;bar().fire('scroll');h.find('qqj-window-city-tab').at(-1).fire('click');
 assert.equal(page().attributes['data-city-sheet'],'scope-7');assert.equal(h.find('qqj-window-city-tab').at(-1).attributes['aria-pressed'],'true');assert.equal(Number(bar().scrollLeft)||0,156);
 h.emit({projectionRevision:2});assert.equal(Number(bar().scrollLeft)||0,156);assert.equal(page().attributes['data-city-sheet'],'scope-7');
 h.view.deactivate();await h.view.activate();assert.equal(Number(bar().scrollLeft)||0,156);assert.equal(page().attributes['data-city-sheet'],'scope-7');
 h.emit({chatId:other,projectionRevision:3});assert.equal(Number(bar().scrollLeft)||0,0);assert.equal(h.writes.length,0);
});
test('地图点选展开必要树而不只留单一场地，展开子项保父DOM且不滚动抢焦点',async()=>{
 const data={...initial,places:[{...initial.places[0],childEntityIds:['room','room2']},initial.places[1],place('room2','次卧',[],'root'),initial.places[2],{...place('hall','公开大厅',['waiting']),mapRootEntityId:'hall'},place('waiting','待机室',[],'hall')],mapRootIds:['root','hall']};const h=harness({snapshot:data});await h.view.activate();const entry=id=>h.find('qqj-window-entry').find(node=>node.attributes['data-place-id']===id),marker=id=>h.find('qqj-window-marker').find(node=>node.attributes['data-place-id']===id);
 assert.deepEqual(h.find('qqj-window-top-level').map(node=>node.attributes['data-place-id']),['root','hall']);assert.equal(entry('hall').open,false);const geometry=h.find('qqj-window-geometry')[0],parent=entry('root'),pin=marker('hall');pin.fire('click');assert.equal(entry('hall').open,true);assert.equal(entry('waiting').open,false);marker('root').fire('click');assert.equal(entry('root'),parent);
 for(const id of ['room','room2']){entry(id).children[0].fire('click');entry(id).open=true;entry(id).fire('toggle');}assert.equal(entry('root'),parent);assert.equal(marker('hall'),pin);assert.equal(h.find('qqj-window-geometry')[0],geometry);assert.ok(flat(entry('room')).some(node=>node.textContent==='书房的已有设施'));assert.equal(h.created.some(node=>node.scrollOptions||node.focusCalls),false);assert.equal(h.writes.length,0);
});

test('地图换场地收起旧详情且仅保当前必要父链，普通树手动多开不变',async()=>{
 const data={...initial,places:[...initial.places,place('hall','大厅',['hall-room']),place('hall-room','大厅内室',[],'hall')],mapRootIds:['root','hall']};const h=harness({snapshot:data});await h.view.activate();
 const entry=id=>h.find('qqj-window-entry').find(node=>node.attributes['data-place-id']===id),pin=id=>h.find('qqj-window-marker').find(node=>node.attributes['data-place-id']===id);
 pin('root').fire('click');entry('room').children[0].fire('click');entry('room').open=true;entry('room').fire('toggle');assert.equal(entry('room').attributes['data-selected'],'true');
 pin('hall').fire('click');entry('hall-room').children[0].fire('click');entry('hall-room').open=true;entry('hall-room').fire('toggle');
 assert.deepEqual(h.find('qqj-window-entry').filter(node=>node.attributes['data-selected']==='true').map(node=>node.attributes['data-place-id']),['hall-room']);assert.equal(entry('room').open,false);assert.equal(entry('root').open,false);assert.equal(entry('hall').open,true);
 entry('root').children[0].fire('click');entry('root').open=true;entry('root').fire('toggle');assert.equal(entry('hall').open,true,'普通树手动多开保留');
 h.emit({projectionRevision:2});assert.equal(entry('room').open,false);assert.equal(entry('hall-room').open,true);assert.equal(entry('root').open,true);
 h.find('qqj-window-page')[0].fire('click');assert.equal(h.find('qqj-window-entry').some(node=>node.attributes['data-selected']==='true'||node.open),false);assert.equal(h.writes.length,0);
});

test('未归属默认折叠，通知/切根保开闭，新增归属自然移出且切聊重置',async()=>{
 const h=harness();await h.view.activate();let drawer=h.find('qqj-window-unassigned')[0];assert.equal(drawer.tag,'details');assert.equal(drawer.open,false);
 drawer.children[0].fire('click');drawer.open=true;const orphan=h.find('qqj-window-entry').find(n=>n.attributes['data-place-id']==='orphan');orphan.children[0].fire('click');
 assert.equal(h.find('qqj-window-marker')[0].attributes['aria-pressed'],'false','未归属浏览不强制选择场地');h.emit({projectionRevision:2});assert.equal(h.find('qqj-window-unassigned')[0].open,true);
 const moved={...initial,projectionRevision:3,places:initial.places.map(p=>p.entityId==='root'?{...p,childEntityIds:['room','orphan']}:p.entityId==='orphan'?{...p,parentEntityId:'root',mapRootEntityId:'root'}:p),unassignedPlaceIds:[]};h.emit(moved);
 assert.equal(h.find('qqj-window-unassigned')[0].hidden,true);h.find('qqj-window-marker')[0].fire('click');assert.ok(flat(h.find('qqj-window-active-place')[0]).some(n=>n.textContent==='通道的已有设施'));
 h.emit({...initial,chatId:other,projectionRevision:4});assert.equal(h.find('qqj-window-unassigned')[0].open,false);
});

test('设施胶囊只从肯定stable文字取短标签、去重保原文，否定计划与行动不打标签',async()=>{
 assert.equal(typeof module.qianchuangFacilityTags,'function');
 const features=[{text:'配有独立干湿分离卫浴和洗烘一体机。设有厨房与餐厅、双人床、衣柜和书桌。'},{text:'配有独立干湿分离卫浴和洗烘一体机。设有厨房与餐厅、双人床、衣柜和书桌。'}];
 const before=structuredClone(features),tags=module.qianchuangFacilityTags(features);assert.deepEqual(tags.map(t=>t.key),['bath','laundry','kitchen','dining','rest','storage','work']);assert.deepEqual(features,before);
 assert.deepEqual(module.qianchuangFacilityTags([{text:'没有独立卫浴，不设厨房，无洗衣机。'},{text:'计划添置双人床和书桌。'},{text:'配有洗衣机',kind:'temporary'},{text:'她走进厨房拿起杯子，随后去洗衣房寻找他。'}]),[]);
 const h=harness({snapshot:{...initial,places:[{...initial.places[0],features},...initial.places.slice(1)]}});await h.view.activate();
 assert.equal(h.find('qqj-window-tag').length,7);assert.equal(h.find('qqj-window-copy').filter(n=>n.textContent===features[0].text).length,1);assert.ok(h.find('qqj-window-tag')[0].children[0].innerHTML.includes('<svg'));
});
test('撤手动底图入口，普通通知保SVG且切聊仍读取已存底图不写设置',async()=>{
 const h=harness();await h.view.activate();await Promise.resolve();const map=h.find('qqj-window-map')[0],geometry=map.children[0],parent=h.find('qqj-window-leaf')[0];parent.open=false;
 assert.equal(geometry.querySelector('svg').getAttribute('preserveAspectRatio'),'xMidYMid meet');assert.equal(map.style['--qqj-window-map-aspect'],'1');assert.equal(h.find('qqj-window-navigation')[0].hidden,true);
 assert.equal(h.created.some(node=>node.attributes['aria-label']==='千窗底图'),false);assert.equal(h.find('qqj-window-basemap-field').length,0);assert.equal(h.find('qqj-window-copyright')[0].hidden,false);
 h.emit({syncing:true});assert.equal(h.find('qqj-window-map')[0].children[0],geometry);assert.equal(h.find('qqj-window-leaf')[0],parent);assert.equal(parent.open,false);
 h.emit({chatId:other,projectionRevision:2,places:[place('new-root','旧共同父',['new-site']),place('new-site','旧场地',[],'new-root')],mapRootIds:['new-root'],unassignedPlaceIds:[]});await Promise.resolve();assert.equal(h.find('qqj-window-copyright')[0].hidden,false,'旧town保存值承接真实图库并署名');assert.equal(map.style['--qqj-window-map-aspect'],'1');assert.equal(map.children[0].querySelector('svg').getAttribute('preserveAspectRatio'),'xMidYMid meet');h.emit({projectionRevision:3,places:[],mapRootIds:[],unassignedPlaceIds:[]});await Promise.resolve();assert.equal(h.find('qqj-window-marker').length,0);assert.equal(h.find('qqj-window-map-group')[0].hidden,true);assert.equal(h.writes.length,0);assert.equal(h.stored.apiModel,'keep');
 h.stored.qianchuangBasemaps.palaceChat='palace';h.emit({...initial,chatId:'palaceChat',projectionRevision:4});await Promise.resolve();assert.equal(map.style['--qqj-window-map-aspect'],'1');assert.equal(map.children[0].querySelector('svg').getAttribute('preserveAspectRatio'),'xMidYMid meet');
});
test('冷准备结束后已关闭或已切聊不会把旧异步画回，主页不准备存档',async()=>{
 let release;const gate=new Promise(r=>release=r);const h=harness({prepareSession:()=>gate,sessionStateProvider:()=>({status:'preparing'})});const pending=h.view.activate();h.view.deactivate();release({status:'ready'});await pending;assert.equal(h.prepares,0);
 const home=harness({snapshot:{...initial,status:'unavailable',chatId:null,places:[],mapRootIds:[],unassignedPlaceIds:[]},prepareSession:()=>{throw Error('主页不创建身份');}});await home.view.activate();assert.equal(home.prepares,0);
});

 test('首次身份准备转正式chat不会留下忙态，主动全折叠后投影更新保持折叠',async()=>{
 let release;const gate=new Promise(r=>release=r);const h=harness({snapshot:{...initial,status:'unavailable',chatId:null,projectionRevision:0,places:[],mapRootIds:[],unassignedPlaceIds:[]},sessionStateProvider:()=>({status:'preparing'}),prepareSession:()=>gate});
 const pending=h.view.activate();h.emit({...initial});release({status:'ready'});await pending;
 assert.ok(h.find('qqj-page-health')[0].textContent.includes('3 处地点'));
 const parent=h.find('qqj-window-leaf')[0];parent.open=false;parent.fire('toggle');h.emit({projectionRevision:2});assert.equal(h.find('qqj-window-leaf')[0].open,false);
 h.emit({projectionRevision:3,userPosition:{status:'leftUnknown'}});assert.equal(h.find('qqj-window-user-position')[0].children[0].textContent,'已离开，去向未知。');
 });

 test('激活直接显示runtime统一地点资料，ready且不再独立扫描世界书',async()=>{
 let reads=0;const data={...initial,places:[{...initial.places[0],features:[{text:'已整理世界书物理描述',sourceKind:'worldbook'}]},...initial.places.slice(1)]};
 const h=harness({snapshot:data,worldInfoProvider:async()=>{reads++;throw Error('view不得读书');}});
 const result=await h.view.activate();assert.equal(result.status,'ready');assert.equal(h.find('qqj-page-health')[0].className.includes('error'),false);assert.equal(reads,0);assert.ok(flat(h.container).some(n=>n.textContent==='已整理世界书物理描述'));
 h.emit({projectionRevision:2});h.find('qqj-window-marker')[0].fire('click');h.view.deactivate();await h.view.activate();assert.equal(reads,0);
 });
 test('切聊只采用新runtime投影，不调用UI世界书来源或保留旧描述',async()=>{
 let reads=0;const h=harness({worldInfoProvider:async()=>{reads++;return{};}});await h.view.activate();
 h.emit({chatId:other,projectionRevision:2,places:[],mapRootIds:[],unassignedPlaceIds:[]});assert.equal(h.find('qqj-window-entry').length,0);assert.equal(reads,0);
 });
 test('独立且干湿分离的卫浴空间可作肯定短标签，否定仍不标',()=>{
 assert.deepEqual(module.qianchuangFacilityTags([{text:'配有独立且干湿分离的卫浴空间。'}]),[{key:'bath',label:'独立卫浴'}]);
 assert.deepEqual(module.qianchuangFacilityTags([{text:'没有独立且干湿分离的卫浴空间。'}]),[]);
 });

test('设施胶囊和正文只采用runtime有效资料，旧UI世界书不能回填',async()=>{
 const h=harness({snapshot:{...initial,places:[{...initial.places[0],features:[{text:'没有独立卫生间。'}]},...initial.places.slice(1)]},worldInfoProvider:async()=>({chatId:chat,candidates:[{kind:'worldbook',content:'设有独立卫生间。'}]})});
 await h.view.activate();assert.equal(flat(h.container).some(n=>n.textContent==='独立卫浴'),false);assert.equal(flat(h.container).some(n=>n.textContent==='设有独立卫生间。'),false);
});

test('runtime资料更新保用户已选大厅，不切回宿舍或滚动抢焦点',async()=>{
 const data={...initial,places:[...initial.places,place('hall','大厅',['hall-room']),place('hall-room','大厅内室',[],'hall')],mapRootIds:['root','hall']};
 const h=harness({snapshot:data});await h.view.activate();h.find('qqj-window-marker').find(n=>n.attributes['data-place-id']==='hall').fire('click');
 h.emit({projectionRevision:2,places:data.places.map(node=>node.entityId==='root'?{...node,features:[{text:'更新的宿舍资料'}]}:node)});
 assert.equal(h.find('qqj-window-entry').find(n=>n.attributes['data-place-id']==='hall').open,true);assert.equal(h.find('qqj-window-marker').find(n=>n.attributes['data-place-id']==='hall').attributes['aria-pressed'],'true');assert.equal(h.created.some(n=>n.scrollOptions||n.focusCalls),false);
});

test('只有明确位置入口可切对应场所、展开目标并定位',async()=>{
 const h=harness({snapshot:{...initial,userPosition:{status:'lastSeen',placeEntityId:'room',mapRootEntityId:'root',isCurrent:false}}});await h.view.activate();h.find('qqj-window-position')[0].fire('click');const entry=h.find('qqj-window-entry').find(n=>n.attributes['data-place-id']==='room');assert.equal(entry.open,true);assert.deepEqual(entry.children[0].scrollOptions,{block:'nearest'});
});

test('当前位置图钉原位开合头像并展开最新子树，位置文字可滚动定位',async()=>{
 const data={...initial,places:[
  {...place('a','范围甲',['d1','d2']),mapLevel:'scope',mapRole:'area'},
  {...place('d1','一区',['site'],'a'),mapRole:'area'},{...place('d2','二区',['other-site'],'a'),mapRole:'area'},
  {...place('site','场地',['floor'],'d1'),mapRole:'site'},{...place('floor','二层',['room-a','room-b'],'site'),mapRole:'interior'},
  {...place('room-a','甲室',[],'floor'),mapRole:'interior'},{...place('room-b','乙室',['closet'],'floor'),mapRole:'interior'},{...place('closet','柜间',[],'room-b'),mapRole:'interior'},
  {...place('other-site','普通场地',[],'d2'),mapRole:'site'},
  {...place('b','范围乙',['b-site']),mapLevel:'scope',mapRole:'area'},{...place('b-site','乙场地',[],'b'),mapRole:'site'}
 ],mapRootIds:['a','b'],unassignedPlaceIds:[],userPosition:{status:'confirmed',placeEntityId:'room-a',isCurrent:true}},h=harness({snapshot:data});await h.view.activate();
 const entry=id=>h.find('qqj-window-entry').find(n=>n.attributes['data-place-id']===id),pin=id=>h.find('qqj-window-marker').find(n=>n.attributes['data-place-id']===id);
 h.find('qqj-window-city-tab').find(n=>n.attributes['data-city-sheet-target']==='b').fire('click');
 h.find('qqj-window-position')[0].fire('click');assert.equal(h.find('qqj-window-page')[0].attributes['data-city-sheet'],'a');
 for(const id of ['d1','site','floor','room-a'])assert.equal(entry(id).open,true);assert.equal(entry('room-a').attributes['data-selected'],'true');assert.deepEqual(entry('room-a').children[0].scrollOptions,{block:'nearest'});
 h.find('qqj-window-area-open').find(n=>n.attributes['data-scope-id']==='d2').fire('click');const beforeScroll=h.created.filter(n=>n.scrollOptions).length;pin('site').fire('click');
 assert.equal(pin('site').attributes['aria-expanded'],'true');assert.ok(entry('room-a'),'原位开头像同时恢复当前房间目录');for(const id of ['d1','site','floor','room-a'])assert.equal(entry(id).open,true);assert.equal(entry('room-a').attributes['data-selected'],'true');assert.equal(h.created.filter(n=>n.scrollOptions).length,beforeScroll);
 const currentPin=pin('site');h.emit({projectionRevision:2,userPosition:{status:'confirmed',placeEntityId:'room-b',isCurrent:true}});assert.equal(pin('site'),currentPin);
 currentPin.fire('click');assert.equal(currentPin.attributes['aria-expanded'],'false');assert.equal(entry('room-a').open,true,'关闭头像保留已展开目录');currentPin.fire('click');assert.equal(currentPin.attributes['aria-expanded'],'true');assert.equal(entry('room-b').attributes['data-selected'],'true');assert.equal(entry('room-b').open,true);assert.equal(entry('room-a').open,false);assert.equal(entry('closet').open,false);assert.equal(h.created.filter(n=>n.scrollOptions).length,beforeScroll);currentPin.fire('click');assert.equal(entry('room-b').open,true);h.find('qqj-window-position')[0].fire('click');assert.equal(entry('room-b').attributes['data-selected'],'true');assert.equal(entry('room-b').open,true);assert.equal(entry('room-a').open,false);assert.equal(entry('closet').open,false);assert.deepEqual(entry('room-b').children[0].scrollOptions,{block:'nearest'});
 pin('other-site').fire('click');assert.equal(entry('other-site').attributes['data-selected'],'true');assert.equal(entry('other-site').children[0].scrollOptions,undefined);assert.equal(h.writes.length,0);
});

test('右侧编辑不触发展开，通知与保存失败保草稿，仅保存修改字段',async()=>{
 let options,failed=true,writes=[];const context={chatId:chat,expectedRevision:0};const h=harness({dialog:{custom(value){options=value;return new Promise(()=>{});}},editingRuntime:{getPlaceEditContext:()=>context,async savePlace(id,fields,scope){writes.push({id,fields,scope});if(failed)throw Error('模拟失败');}}});await h.view.activate();h.find('qqj-window-marker')[0].fire('click');
 let stopped=0;h.find('qqj-window-edit').find(node=>node.attributes['data-edit-place']==='room').fire('click',{stopPropagation(){stopped++;},preventDefault(){stopped++;}});assert.equal(stopped,2);const form=options.content,description=flat(form).find(node=>node.attributes['data-place-field']==='description');description.value='人工卫浴';description.fire('input');
 h.emit({projectionRevision:2});assert.equal(options.content,form);assert.equal(description.value,'人工卫浴');await assert.rejects(options.submit(),/模拟失败/);assert.equal(description.value,'人工卫浴');failed=false;assert.equal(await options.submit(),true);assert.deepEqual(writes[1],{id:'room',fields:{description:'人工卫浴'},scope:context});
 const count=writes.length;h.find('qqj-window-edit').find(node=>node.attributes['data-edit-place']==='room').fire('click');assert.equal(writes.length,count,'打开和取消不写入');
});

test('地点复用三点菜单提供编辑与独立确认删除，取消不写且编辑弹窗无删除项',async()=>{
 let editor,confirmation,confirmed=false,deletes=[];const scope={chatId:chat,expectedRevision:0};
 const h=harness({dialog:{custom(options){editor=options;return new Promise(()=>{});},async confirm(options){confirmation=options;return confirmed;}},editingRuntime:{getPlaceEditContext:()=>scope,savePlace:async()=>{},deletePlace:async(id,context)=>{deletes.push({id,context});}}});await h.view.activate();h.find('qqj-window-marker')[0].fire('click');
 const menu=h.find('qqj-window-operation-menu').find(node=>node.attributes['data-place-menu']==='room');assert.equal(menu.tag,'details');assert.equal(menu.children[0].textContent,'⋮');
 menu.open=true;const edit=flat(menu).find(node=>node.attributes['data-edit-place']==='room');edit.fire('click');assert.equal(menu.open,false);assert.equal(flat(editor.content).some(node=>node.attributes['data-place-delete']),false);
 const remove=flat(menu).find(node=>node.attributes['data-place-delete']==='room');await remove.fire('click');assert.equal(deletes.length,0);assert.equal(confirmation.danger,true);confirmed=true;menu.open=true;await remove.fire('click');assert.equal(menu.open,false);assert.deepEqual(deletes,[{id:'room',context:scope}]);
});

test('所属地点在原编辑弹窗中搜索完整路径，排除自己子孙，选值只保存parentEntityId',async()=>{
 const data={...initial,places:[place('root','青石馆',['l1']),place('l1','一楼',['room'],'root'),place('room','书房',['corner'],'l1'),place('corner','内间',[],'room'),place('studio','工作室',['studio-l1']),place('studio-l1','一楼',[],'studio')],mapRootIds:['root','studio'],unassignedPlaceIds:[]};
 let editor,writes=[];const scope={chatId:chat,expectedRevision:0};const h=harness({snapshot:data,dialog:{custom(value){editor=value;return new Promise(()=>{});}},editingRuntime:{getPlaceEditContext:()=>scope,savePlace:async(id,fields,context)=>{writes.push({id,fields,context});}}});await h.view.activate();h.find('qqj-window-marker')[0].fire('click');h.find('qqj-window-edit').find(node=>node.attributes['data-edit-place']==='room').fire('click');
 const parent=flat(editor.content).find(node=>node.attributes['data-place-field']==='parentEntityId'),nodes=flat(parent),search=nodes.find(node=>node.className==='settings-input qqj-inline-select-search-input'),options=nodes.filter(node=>node.className.split(' ').includes('qqj-inline-select-option'));
 assert.equal(flat(editor.content).some(node=>node.tag==='select'),false);assert.equal(nodes.some(node=>node.className==='qqj-inline-select-chevron'),false);assert.equal(parent.value,'l1');assert.equal(options.find(node=>node.attributes['data-value']==='l1').textContent,'青石馆 / 一楼');assert.equal(options.some(node=>['room','corner'].includes(node.attributes['data-value'])),false);
 nodes.find(node=>node.className==='settings-input qqj-inline-select-trigger').fire('click');search.value='工作室 一楼';search.fire('input');assert.deepEqual(options.filter(node=>!node.hidden).map(node=>node.textContent),['工作室 / 一楼']);assert.equal(writes.length,0);
 options.find(node=>node.attributes['data-value']==='studio-l1').fire('click');assert.equal(parent.value,'studio-l1');assert.equal(writes.length,0);await editor.submit();assert.deepEqual(writes,[{id:'room',fields:{parentEntityId:'studio-l1'},context:scope}]);
});

test('千窗空白取消高亮并收详情，保当前建筑和DOM；文字控件点击与通知不误清',async()=>{
 const h=harness();await h.view.activate();h.find('qqj-window-marker')[0].fire('click');const page=h.find('qqj-window-page')[0],entry=h.find('qqj-window-entry').find(node=>node.attributes['data-place-id']==='room'),parent=h.find('qqj-window-entry').find(node=>node.attributes['data-place-id']==='root'),geometry=h.find('qqj-window-geometry')[0],marker=h.find('qqj-window-marker')[0];
 entry.children[0].fire('click');entry.open=true;entry.fire('toggle');const copy=flat(entry).find(node=>node.className==='qqj-window-copy');page.fire('click',{target:copy});assert.equal(entry.open,true);assert.equal(entry.attributes['data-selected'],'true');
 const focusCount=h.created.reduce((sum,node)=>sum+(node.focusCalls??0),0);
 page.fire('click',{target:geometry});assert.equal(entry.open,false);assert.equal(marker.attributes['aria-pressed'],'false');assert.equal(h.find('qqj-window-entry').find(node=>node.attributes['data-place-id']==='root'),parent);assert.equal(h.find('qqj-window-geometry')[0],geometry);assert.equal(h.find('qqj-window-entry').find(node=>node.attributes['data-place-id']==='room'),entry);
 h.emit({syncing:true});assert.equal(entry.open,false);assert.equal(marker.attributes['aria-pressed'],'false');marker.fire('click');assert.equal(marker.attributes['aria-pressed'],'true');assert.equal(h.find('qqj-window-entry').find(node=>node.attributes['data-place-id']==='room'),entry);assert.equal(entry.attributes['data-selected'],'false');assert.equal(h.find('qqj-window-entry').find(node=>node.attributes['data-place-id']==='root'),parent);assert.equal(h.created.some(node=>node.scrollOptions),false);assert.equal(h.created.reduce((sum,node)=>sum+(node.focusCalls??0),0),focusCount);assert.equal(h.writes.length,0);
});

test('全图底图及地名点位稳定，点地区只筛下方树，跨区与空白不重排地图',async()=>{
 const data={...initial,places:[{...place('city','首尔',['hannam','samseong']),mapRole:'area'},{...place('hannam','汉南洞',['hh','beauty'],'city'),mapRole:'area'},{...place('samseong','三成洞',['company'],'city'),mapRole:'area'},{...place('hh','HH宿舍',['l1'],'hannam'),mapRole:'site'},{...place('l1','一楼',['bedroom'],'hh'),mapRole:'interior'},{...place('bedroom','卧室',[],'l1'),mapRole:'interior'},{...place('beauty','美容室',['salon'],'hannam'),mapRole:'site'},{...place('salon','等候室',[],'beauty'),mapRole:'interior'},{...place('company','公司',['office'],'samseong'),mapRole:'site'},{...place('office','办公室',[],'company'),mapRole:'interior'}],mapRootIds:['city'],unassignedPlaceIds:[]};const before=structuredClone(data),h=harness({snapshot:data});await h.view.activate();
 const ids=cls=>h.find(cls).map(node=>node.attributes['data-place-id']);assert.deepEqual(ids('qqj-window-marker'),['hh','beauty','company']);assert.ok(h.find('qqj-page-health')[0].textContent.includes('当前范围 3 处场地'));assert.equal(h.find('qqj-window-area').length,0);assert.equal(h.find('qqj-window-area-open').length,2);assert.ok(h.find('qqj-window-area-open').every(node=>node.tag==='button'));assert.deepEqual(ids('qqj-window-top-level'),['hannam','samseong']);assert.ok(h.find('qqj-window-entry').every(node=>!node.open),'初始所有层级收起');
 const geometry=h.find('qqj-window-geometry')[0],markers=h.find('qqj-window-marker'),labels=h.find('qqj-window-area-open'),positions=markers.map(node=>[node.style.left,node.style.top]);assert.equal(h.find('qqj-window-scope-link').some(node=>node.textContent==='全部'),false);const page=h.find('qqj-window-page')[0];assert.ok(page.children.indexOf(h.find('qqj-window-navigation')[0])>page.children.indexOf(h.find('qqj-window-map-group')[0]),'真路径在地图下方，不挤动地图');
 h.find('qqj-window-marker').find(node=>node.attributes['data-place-id']==='beauty').fire('click');assert.deepEqual(ids('qqj-window-top-level'),['hannam','samseong']);assert.equal(h.find('qqj-window-entry').find(node=>node.attributes['data-place-id']==='beauty').open,true);assert.ok(h.find('qqj-window-entry').some(node=>node.attributes['data-place-id']==='salon'));const selected=h.find('qqj-window-entry').find(node=>node.attributes['data-place-id']==='beauty');
 h.find('qqj-window-page')[0].fire('click',{target:h.find('qqj-window-map')[0]});assert.deepEqual(ids('qqj-window-top-level'),['hannam','samseong']);assert.equal(h.find('qqj-window-entry').find(node=>node.attributes['data-place-id']==='beauty'),selected);assert.ok(h.find('qqj-window-entry').every(node=>!node.open));assert.equal(h.find('qqj-window-marker').filter(node=>node.attributes['aria-pressed']==='true').length,0);
 labels.find(node=>node.attributes['data-scope-id']==='hannam').fire('click');assert.deepEqual(ids('qqj-window-marker'),['hh','beauty','company']);assert.ok(h.find('qqj-page-health')[0].textContent.includes('当前范围 2 处场地'));assert.deepEqual(ids('qqj-window-top-level'),['hh','beauty']);
 labels.find(node=>node.attributes['data-scope-id']==='samseong').fire('click');assert.deepEqual(ids('qqj-window-top-level'),['company']);assert.equal(h.find('qqj-window-area-open').find(node=>node.attributes['data-scope-id']==='samseong').attributes['aria-pressed'],'true');
 for(const [index,node]of h.find('qqj-window-marker').entries()){assert.equal(node,markers[index]);assert.deepEqual([node.style.left,node.style.top],positions[index]);}assert.equal(h.find('qqj-window-geometry')[0],geometry);assert.deepEqual(h.find('qqj-window-area-open'),labels);
 h.find('qqj-window-page')[0].fire('click',{target:h.find('qqj-window-map')[0]});assert.deepEqual(ids('qqj-window-top-level'),['hannam','samseong']);assert.equal(h.find('qqj-window-geometry')[0],geometry);assert.deepEqual(data,before);assert.equal(h.writes.length,0);assert.equal(h.created.some(node=>node.scrollOptions||node.focusCalls),false);
 h.emit({projectionRevision:2,places:[...data.places.map(node=>node.entityId==='hannam'?{...node,childEntityIds:[...node.childEntityIds,'new-site']}:node),{...place('new-site','新场地',[],'hannam'),mapRole:'site'}]});const company=h.find('qqj-window-marker').find(node=>node.attributes['data-place-id']==='company');assert.deepEqual([company.style.left,company.style.top],positions[2],'另一区新增场地不把本区场地挪到别的全局slot');
});

test('partial仅有室内提示时不画室内pin，无场地父仍可从文字树编辑与查看下级',async()=>{
 let editor;const data={...initial,places:[{...place('floor','二楼',['room']),mapRole:'interior'},{...place('room','客房',[],'floor'),mapRole:'interior'}],mapRootIds:['floor'],unassignedPlaceIds:[]};const h=harness({snapshot:data,dialog:{custom(options){editor=options;return new Promise(()=>{});}},editingRuntime:{getPlaceEditContext:()=>({chatId:chat}),savePlace:async()=>{}}});await h.view.activate();
 assert.equal(h.find('qqj-window-marker').length,0);assert.equal(h.find('qqj-window-top-level')[0].attributes['data-place-id'],'floor');h.find('qqj-window-edit').find(node=>node.attributes['data-edit-place']==='floor').fire('click');assert.ok(editor);h.find('qqj-window-top-level')[0].children[0].fire('click');h.find('qqj-window-top-level')[0].open=true;assert.ok(h.find('qqj-window-entry').some(node=>node.attributes['data-place-id']==='room'));assert.equal(h.writes.length,0);
});

test('完整折叠树初始只露区域标题，区域建筑房间逐层开；主搜索保祖先，地图定位与blank回全部',async()=>{
 const data={...initial,places:[{...place('city','首尔',['hannam','samseong']),mapRole:'area'},{...place('hannam','汉南洞',['hh','beauty'],'city'),mapRole:'area'},{...place('samseong','三成洞',['company'],'city'),mapRole:'area'},{...place('hh','HH宿舍',['floor'],'hannam'),mapRole:'site'},{...place('floor','一楼',['room'],'hh'),mapRole:'interior'},{...place('room','书房',[],'floor'),mapRole:'interior',features:[{text:'设有书桌。'}]},{...place('beauty','美容室',[],'hannam'),mapRole:'site'},{...place('company','公司',[],'samseong'),mapRole:'site'}],mapRootIds:['city'],unassignedPlaceIds:[]};const h=harness({snapshot:data});await h.view.activate();const entry=id=>h.find('qqj-window-entry').find(node=>node.attributes['data-place-id']===id),toggle=id=>{const n=entry(id);n.children[0].fire('click');n.open=!n.open;n.fire('toggle');};
 assert.deepEqual(h.find('qqj-window-top-level').map(node=>node.attributes['data-place-id']),['hannam','samseong']);assert.ok(h.find('qqj-window-entry').every(node=>!node.open));assert.equal(h.find('qqj-window-overview').length,0);assert.equal(h.created.some(node=>node.attributes['aria-label']==='浏览范围'),false);
 toggle('hannam');assert.equal(entry('hh').open,false);toggle('hh');assert.equal(entry('floor').open,false);toggle('floor');toggle('room');assert.ok(flat(entry('room')).some(node=>node.textContent==='设有书桌。'));
 const search=h.find('qqj-history-search-input')[0];assert.equal(search.type,'search');search.value='汉南 书桌';search.fire('input');assert.equal(entry('hannam').hidden,false);assert.equal(entry('room').hidden,false);assert.equal(entry('samseong').hidden,true);assert.equal(entry('hh').open,true);h.find('qqj-history-search-clear')[0].fire('click');assert.ok(h.find('qqj-window-entry').every(node=>!node.open));
 h.find('qqj-window-area-open').find(node=>node.attributes['data-scope-id']==='hannam').fire('click');assert.deepEqual(h.find('qqj-window-top-level').map(node=>node.attributes['data-place-id']),['hh','beauty']);h.find('qqj-window-marker').find(node=>node.attributes['data-place-id']==='hh').fire('click');assert.equal(entry('hh').open,true);
 h.find('qqj-window-page')[0].fire('click',{target:h.find('qqj-window-map')[0]});assert.deepEqual(h.find('qqj-window-top-level').map(node=>node.attributes['data-place-id']),['hannam','samseong']);assert.ok(h.find('qqj-window-entry').every(node=>!node.open));assert.equal(h.find('qqj-window-marker').filter(node=>node.attributes['aria-pressed']==='true').length,0);assert.equal(h.writes.length,0);assert.equal(h.created.some(node=>node.scrollOptions),false);assert.equal(search.focusCalls,1,'仅显式清除按钮回焦搜索，blank不抢焦点');
});

test('编辑内添加子地点与字段共用草稿和保存，搜索保勾选，失败保草稿且菜单仅三项',async()=>{
 const data={...initial,places:[place('city','城',['root']),place('root','青石馆',['room'],'city'),place('room','书房',[],'root'),place('other','别馆',['other-room']),place('other-room','书房',[],'other'),place('loose','散点')],mapRootIds:['city','other'],unassignedPlaceIds:['loose']};
 let editor,dialogs=0,failed=true,saved=[];const scope={chatId:chat};const h=harness({snapshot:data,dialog:{custom(value){editor=value;dialogs++;return new Promise(()=>{});}},editingRuntime:{getPlaceEditContext:()=>scope,async savePlace(id,fields,context,options){saved.push({id,fields,context,options});if(failed)throw Error('合并模拟失败');}}});await h.view.activate();
 const menu=h.find('qqj-window-operation-menu').find(n=>n.attributes['data-place-menu']==='root');assert.deepEqual(flat(menu).filter(n=>n.tag==='button').map(n=>n.textContent),['编辑','设为顶层地点','删除']);
 h.find('qqj-window-edit').find(n=>n.attributes['data-edit-place']==='root').fire('click');const form=editor.content,nodes=flat(form),add=nodes.find(n=>n.attributes['data-place-add-children']==='root');assert.ok(add);const picker=nodes.find(n=>n.className.split(' ').includes('qqj-window-child-picker'));assert.equal(picker.tag,'div');assert.equal(picker.hidden,true);
 const description=nodes.find(n=>n.attributes['data-place-field']==='description');description.value='人工新描述';description.fire('input');add.fire('click');assert.equal(picker.hidden,false);assert.equal(dialogs,1);assert.equal(editor.content,form);assert.equal(description.value,'人工新描述');
 const checks=flat(picker).filter(n=>n.type==='checkbox'),search=flat(picker).find(n=>n.type==='search');assert.deepEqual(checks.map(n=>n.attributes['data-child-place']),['other','other-room','loose']);assert.ok(flat(picker).some(n=>n.textContent==='别馆 / 书房'));
 checks[0].checked=true;checks[0].fire('change');search.value='别馆 书房';search.fire('input');assert.equal(checks[0].parentNode.hidden,true);checks[1].checked=true;checks[1].fire('change');let blocked=0;search.fire('keydown',{key:'Enter',preventDefault(){blocked++;},stopPropagation(){blocked++;}});assert.equal(blocked,2);assert.equal(saved.length,0);search.fire('keydown',{key:'Enter',isComposing:true,preventDefault(){blocked++;}});assert.equal(blocked,2);
 flat(picker).find(n=>n.className.includes('qqj-inline-select-search-clear')).fire('click');assert.equal(checks[0].checked,true);assert.equal(checks[1].checked,true);assert.ok(checks.every(n=>!n.parentNode.hidden));add.fire('click');add.fire('click');assert.equal(checks[0].checked,true);assert.equal(saved.length,0,'字段和勾选在保存前都不写');
 await assert.rejects(editor.submit(),/合并模拟失败/);assert.equal(checks[0].checked,true);assert.equal(description.value,'人工新描述');failed=false;await editor.submit();assert.deepEqual(saved.at(-1),{id:'root',fields:{description:'人工新描述'},context:scope,options:{childIds:['other','other-room']}});
 const count=saved.length;h.find('qqj-window-edit').find(n=>n.attributes['data-edit-place']==='root').fire('click');await editor.submit();assert.equal(saved.length,count,'无修改不保存');
 const top=h.find('qqj-window-set-top-level').find(n=>n.attributes['data-place-top-level']==='loose');await top.fire('click');assert.deepEqual(saved.at(-1),{id:'loose',fields:{parentEntityId:null},context:scope,options:undefined});
});

test('父地点单选与添加子地点多选按真实树前序，同branch相邻且未归属置后',async()=>{
 const data={...initial,places:[place('corner','内间',[],'room'),place('other-room','二层',[],'other'),place('loose','散点'),place('room','一层',['corner'],'root'),place('other','别馆',['other-room']),place('root','青石馆',['room'])],mapRootIds:['root','other'],unassignedPlaceIds:['loose']};let editor;const h=harness({snapshot:data,dialog:{custom(value){editor=value;return new Promise(()=>{});}},editingRuntime:{getPlaceEditContext:()=>({chatId:chat}),savePlace:async()=>{},attachPlaceChildren:async()=>{}}});await h.view.activate();h.find('qqj-window-edit').find(n=>n.attributes['data-edit-place']==='room').fire('click');assert.deepEqual(flat(flat(editor.content).find(n=>n.attributes['data-place-field']==='parentEntityId')).filter(n=>n.className.split(' ').includes('qqj-inline-select-option')).map(n=>n.attributes['data-value']),['','root','other','other-room','loose']);h.find('qqj-window-edit').find(n=>n.attributes['data-edit-place']==='root').fire('click');flat(editor.content).find(n=>n.attributes['data-place-add-children']==='root').fire('click');assert.deepEqual(flat(editor.content).filter(n=>n.type==='checkbox').map(n=>n.attributes['data-child-place']),['corner','other','other-room','loose']);
});

test('城市sheet隐藏国家，默认位置城，手切/blank留城，跨城定位只开新链',async()=>{
 const data={...initial,places:[place('cn','中国',['sh','bj']),{...place('sh','上海',['sh-site'],'cn'),mapLevel:'city'},place('sh-site','上海馆',['sh-room'],'sh'),place('sh-room','上海内室',[],'sh-site'),{...place('bj','北京',['bj-site'],'cn'),mapLevel:'city'},place('bj-site','北京馆',['bj-room'],'bj'),place('bj-room','北京内室',[],'bj-site')],mapRootIds:['cn'],unassignedPlaceIds:[],userPosition:{status:'confirmed',isCurrent:true,placeEntityId:'sh-room'}};
 const h=harness({snapshot:data});await h.view.activate();const page=h.find('qqj-window-page')[0],switcher=()=>h.find('qqj-window-city-switcher')[0];assert.equal(page.attributes['data-city-sheet'],'sh');assert.equal(h.find('qqj-window-entry').some(n=>n.attributes['data-place-id']==='cn'),false);const select=id=>flat(switcher()).find(n=>n.attributes['data-city-sheet-target']===id).fire('click');select('bj');assert.equal(page.attributes['data-city-sheet'],'bj');h.emit({projectionRevision:2});assert.equal(page.attributes['data-city-sheet'],'bj');h.find('qqj-window-marker')[0].fire('click');page.fire('click',{target:h.find('qqj-window-geometry')[0]});assert.equal(page.attributes['data-city-sheet'],'bj');assert.ok(h.find('qqj-window-entry').every(n=>!n.open));h.find('qqj-window-position')[0].fire('click');assert.equal(page.attributes['data-city-sheet'],'sh');assert.equal(h.find('qqj-window-entry').find(n=>n.attributes['data-place-id']==='sh-room').open,true);assert.equal(h.find('qqj-window-scope-link').some(n=>n.textContent==='中国'),false);
});
test('慢城市底图A结果不盖已切B，mapLevel编辑普通null同原草稿保存',async()=>{
 let resolveA;const data={...initial,places:[{...place('sh','上海',['a']),mapLevel:'city'},place('a','甲',[],'sh'),{...place('bj','北京',['b']),mapLevel:'city'},place('b','乙',[],'bj')],mapRootIds:['sh','bj'],unassignedPlaceIds:[]};let editor,writes=[];const h=harness({snapshot:data,loadCityMap:id=>id==='shanghai'?new Promise(r=>resolveA=r):Promise.resolve('<svg data-test="B"></svg>'),dialog:{custom(value){editor=value;return new Promise(()=>{});}},editingRuntime:{getPlaceEditContext:()=>({chatId:chat}),savePlace:async(id,fields)=>writes.push({id,fields})}});await h.view.activate();flat(h.find('qqj-window-city-switcher')[0]).find(n=>n.attributes['data-city-sheet-target']==='bj').fire('click');await Promise.resolve();await Promise.resolve();resolveA('<svg data-test="A"></svg>');await Promise.resolve();await Promise.resolve();assert.ok(h.find('qqj-window-geometry')[0].innerHTML.includes('data-test="B"'));
 h.find('qqj-window-edit').find(n=>n.attributes['data-edit-place']==='bj').fire('click');const field=flat(editor.content).find(n=>n.attributes['data-place-field']==='mapLevel');assert.ok(field);flat(field).find(n=>n.attributes['data-value']==='').fire('click');await editor.submit();assert.deepEqual(writes,[{id:'bj',fields:{mapLevel:null}}]);
});

test('新增表单可同次选择城市或国家，默认普通不新增人工null，子地点仍仅编辑',async()=>{let editor,writes=[];const h=harness({dialog:{custom(v){editor=v;return new Promise(()=>{});}},editingRuntime:{getPlaceEditContext:()=>({chatId:chat}),createPlace:async fields=>writes.push(fields)}});await h.view.activate();h.find('qqj-window-add')[0].fire('click');let nodes=flat(editor.content);assert.equal(nodes.some(n=>n.className.split(' ').includes('qqj-window-add-children')),false);const name=nodes.find(n=>n.attributes['data-place-field']==='name');name.value='星槎港';name.fire('input');const level=nodes.find(n=>n.attributes['data-place-field']==='mapLevel');flat(level).find(n=>n.attributes['data-value']==='city').fire('click');await editor.submit();assert.equal(writes[0].mapLevel,'city');h.find('qqj-window-add')[0].fire('click');nodes=flat(editor.content);const nextName=nodes.find(n=>n.attributes['data-place-field']==='name');nextName.value='营地';nextName.fire('input');await editor.submit();assert.equal(Object.hasOwn(writes[1],'mapLevel'),false);});

test('旧地点直接地址接到真实底图读取，失败文字保地点树而不回退通用图',async()=>{
 const data={...initial,places:[{...place('district','汉南洞',['site']),mapRole:'area',features:[{text:'已有设施',source:{references:[{quote:'首尔特别市龙山区汉南洞'}]}}]},{...place('site','场地',[],'district'),mapRole:'site'}],mapRootIds:['district'],unassignedPlaceIds:[]};
 for(const fail of [false,true]){const calls=[],h=harness({snapshot:data,loadCityMap:async id=>{calls.push(id);if(fail)throw Error('offline failure');return '<svg data-address-basemap="loaded"></svg>';}});await h.view.activate();await Promise.resolve();const map=h.find('qqj-window-map')[0],geometry=h.find('qqj-window-geometry')[0];assert.deepEqual(calls,['seoul']);assert.equal(map.attributes['data-map-mode'],'real');assert.equal(map.attributes['data-basemap'],'seoul');assert.deepEqual(h.find('qqj-window-top-level').map(node=>node.attributes['data-place-id']),['site']);if(fail)assert.match(geometry.textContent,/城市底图.*无法读取/u);else assert.match(geometry.innerHTML,/data-address-basemap="loaded"/u);assert.equal(h.writes.length,0);}
});

test('空城市留共享未归属目录，不造页或孤点，实际城市地图保持',async()=>{
 const data={...initial,places:[place('bj','北京'),place('sh','上海',['hall']),place('hall','旧场地',[],'sh')],mapRootIds:['bj','sh'],unassignedPlaceIds:[]},h=harness({snapshot:data});await h.view.activate();assert.equal(h.find('qqj-window-city-tab').length,0);assert.equal(h.find('qqj-window-sheet-row')[0].hidden,true);assert.equal(h.find('qqj-window-page')[0].attributes['data-city-sheet'],'sh');assert.deepEqual(h.find('qqj-window-marker').map(n=>n.attributes['data-place-id']),['hall']);assert.ok(flat(h.find('qqj-window-directory')[0]).some(n=>n.attributes['data-place-id']==='bj'));assert.equal(h.find('qqj-window-unassigned')[0].hidden,false);assert.equal(h.writes.length,0);
});

test('读取新增通用底图保存值，无主页选择控件或设置写入',async()=>{
 for(const key of ['modern-town','old-town','sci-fi']){const h=harness();await h.view.activate();h.stored.qianchuangBasemaps[other]=key;h.emit({chatId:other,projectionRevision:2});assert.equal(h.find('qqj-window-map')[0].attributes['data-basemap'],{'modern-town':'modern-town-plain','old-town':'old-town-plain','sci-fi':'sci-fi-linear'}[key]);assert.equal(h.find('qqj-window-map')[0].attributes['data-map-mode'],'generic');assert.equal(h.find('qqj-window-basemap-field').length,0);assert.equal(h.writes.length,0);}
});

test('普通物件与修饰别称直接匹配设施，覆盖鞋柜镜子沙发地毯座椅电视',()=>{
 const features=[{text:'玄关设有大理石台面鞋柜与换鞋软凳、感应式照明和全镜面鞋柜墙。'},{text:'客厅配深灰羊毛地毯、超大型真皮沙发、玻璃茶几、85英寸壁挂电视与按摩椅；茶几下藏急救箱。'}],before=structuredClone(features),labels=module.qianchuangFacilityTags(features).map(x=>x.label);for(const label of ['鞋柜','镜子','沙发','地毯','座椅','电视','照明','茶几','急救'])assert.ok(labels.includes(label),label);assert.deepEqual(features,before);
});
test('完整图库名称参与匹配，普通UI动词和字母碎片不冒充设施',()=>{
 const keys=module.qianchuangFacilityTags([{text:'配有 MirrorRound、Refrigerator 和 alarm-clock。'}]).map(x=>x.key);for(const key of ['MirrorRound','Refrigerator','AlarmClock'])assert.ok(keys.includes(key),key);assert.deepEqual(module.qianchuangFacilityTags([{text:'复制 copy；变量 x 与 y。'}]),[]);
});
test('局部否定不误伤无框无障碍无线或同句肯定，日常使用保肯定设施',()=>{
 const labels=module.qianchuangFacilityTags([{text:'设有无框穿衣镜和无障碍通道，书桌配有无线路由器。'},{text:'设有洗衣机和烘干机供日常使用。'},{text:'无电视并设有沙发。'}]).map(x=>x.label);for(const label of ['镜子','无障碍','工作区','网络','洗衣/洗烘','沙发'])assert.ok(labels.includes(label),label);assert.equal(labels.includes('电视'),false);
 assert.deepEqual(module.qianchuangFacilityTags([{text:'没有鞋柜、地毯和沙发；未装穿衣镜；计划添置电视和冰箱。她走进厨房寻找杯子。'}]),[]);
});
test('主设施否定压住旧补充，人工清空不从旧补充复原',async()=>{
 assert.equal(module.qianchuangFacilityTags([{text:'没有沙发。'}],[{text:'配有沙发。'}]).some(t=>t.label==='沙发'),false);
 const h=harness({snapshot:{...initial,places:[{...initial.places[0],features:[],manualDescription:true,worldInfoDescriptions:[{text:'配有独立卫浴和沙发。'}]},...initial.places.slice(1)]}});await h.view.activate();assert.equal(h.find('qqj-window-tag').length,0);assert.equal(h.find('qqj-window-copy').some(n=>n.textContent==='配有独立卫浴和沙发。'),false);assert.equal(h.writes.length,0);
});

test('184旧sci-fi保存值与自动环境同走按需舰图及源比例',async()=>{
 const loads=[],h=harness({snapshot:{...initial,mapStyle:'sci-fi'},loadGenericMap:async id=>{loads.push(id);return'<svg data-ship="loaded"/>';}});await h.view.activate();await Promise.resolve();
 let map=h.find('qqj-window-map')[0];assert.equal(map.attributes['data-basemap'],'sci-fi-linear');assert.equal(map.style['--qqj-window-map-aspect'],'1');assert.deepEqual(loads,['sci-fi-linear']);
 h.stored.qianchuangBasemaps[chat]='sci-fi';h.emit({projectionRevision:2});assert.equal(h.find('qqj-window-map')[0].attributes['data-basemap'],'sci-fi-linear');assert.equal(h.find('qqj-window-map')[0].style['--qqj-window-map-aspect'],'1');assert.equal(h.writes.length,0);
});

test('189方位单独成为本级折叠详情，和描述归一去重',async()=>{
 const data={...initial,places:[{...place('root','区域',['room']),mapRole:'area',features:[]},{...place('room','大厅',[],'root'),mapRole:'site',features:[],relations:[{text:'位于\n走廊尽头'}]}],unassignedPlaceIds:[]};const h=harness({snapshot:data});await h.view.activate();const entry=h.find('qqj-window-entry').find(n=>n.attributes['data-place-id']==='room');assert.match(entry.className,/has-content/u);assert.equal(flat(entry).filter(n=>n.className==='qqj-window-copy'&&n.textContent==='位于\n走廊尽头').length,1);
 data.places[1].features=[{text:'位于 走廊尽头'}];h.emit({projectionRevision:2,places:data.places});assert.equal(h.find('qqj-window-copy').filter(n=>/位于/u.test(n.textContent)).length,1);
});
test('189新地点类型按父级默认且手选后不随所属变化，自动编辑仅释放类型',async()=>{
 let editor;const writes=[],data={...initial,places:[{...place('root','区域',['room']),mapRole:'area'},{...place('room','大厅',[],'root'),mapRole:'site'}],unassignedPlaceIds:[]};const h=harness({snapshot:data,dialog:{custom(v){editor=v;return new Promise(()=>{});}},editingRuntime:{getPlaceEditContext:()=>({chatId:chat}),createPlace:async fields=>writes.push(fields),savePlace:async(id,fields)=>writes.push({id,fields})}});await h.view.activate();
 const choose=(key,value)=>{const f=flat(editor.content).find(n=>n.attributes['data-place-field']===key);assert.ok(f,key);flat(f).find(n=>n.attributes['data-value']===value).fire('click');};
 h.find('qqj-window-add')[0].fire('click');choose('parentEntityId','room');await editor.submit();assert.equal(writes.at(-1).mapRole,'interior');
 h.find('qqj-window-add')[0].fire('click');choose('mapLevel','scope');await editor.submit();assert.equal(writes.at(-1).mapRole,'area');
 h.find('qqj-window-add')[0].fire('click');choose('mapRole','site');choose('parentEntityId','room');await editor.submit();assert.equal(writes.at(-1).mapRole,'site');
 h.find('qqj-window-edit').find(n=>n.attributes['data-edit-place']==='room').fire('click');choose('mapRole','interior');await editor.submit();assert.deepEqual(writes.at(-1),{id:'room',fields:{mapRole:'interior'}});
});

test('外部已存图目录离线时保地点与底图ID，页面使用已有同类背景且零写', async()=>{
 const data={...initial,places:initial.places.map(node=>node.entityId==='root'?{...node,mapLevel:'scope',mapRole:'area',mapStyle:'sci-fi',mapLayout:'linear',mapAssetId:'external-unavailable'}:node.entityId==='room'?{...node,mapRole:'site'}:node)},before=structuredClone(data),h=harness({snapshot:data});
 await h.view.activate();assert.equal(h.find('qqj-window-map')[0].attributes['data-basemap'],'sci-fi-linear');assert.equal(h.find('qqj-window-marker').length,1);assert.equal(h.writes.length,0);assert.deepEqual(data,before);
});


test('目录在千窗关闭期间新增城市，重开沿相同core版本更新底图且零写',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve),city={...structuredClone(CITY_MAPS.seoul),id:'reopen-city',label:'外部城市',aliases:['外部城市']};
 const client=startQianchuangMapCatalog({genericAssets:QIANCHUANG_MAP_ASSETS,cityAssets:CITY_MAPS,sanitizeSvg:value=>value,fetchImpl:async url=>({ok:true,json:()=>url.includes('/maps-real/')?gate:Promise.resolve([])})});
 const data={...initial,places:[{...place('city','外部城市',['site']),mapLevel:'city',mapRole:'area'},{...place('site','城内场地',[],'city'),mapRole:'site'}],mapRootIds:['city'],unassignedPlaceIds:[]},before=structuredClone(data),h=harness({snapshot:data});
 await h.view.activate();assert.notEqual(h.find('qqj-window-map')[0].attributes['data-basemap'],'reopen-city');h.view.deactivate();
 release({cities:[city]});await client.prepare();await h.view.activate();
 assert.equal(h.find('qqj-window-map')[0].attributes['data-basemap'],'reopen-city');assert.equal(h.writes.length,0);assert.deepEqual(data,before);h.view.deactivate();
});


test('头像现取现开，空白与离页关闭，错误图片不留破图且无设置写入',async()=>{
 let url='/User Avatars/first.png',reads=0;const h=harness({snapshot:{...initial,userPosition:{status:'confirmed',placeEntityId:'room',isCurrent:true}},userAvatarProvider:()=>{reads++;return url;}});await h.view.activate();
 const marker=()=>h.find('qqj-window-marker')[0],avatar=()=>h.find('qqj-window-user-avatar')[0],image=()=>h.find('qqj-window-user-avatar-image')[0];marker().fire('click');assert.equal(marker().attributes['aria-expanded'],'true');assert.equal(reads,1);assert.equal(image().getAttribute('href'),url);assert.equal(h.created.some(n=>n.scrollOptions),false);
 image().fire('error');assert.equal(image().style.opacity,'0');marker().fire('click');assert.equal(marker().attributes['aria-expanded'],'false');
 url='/User Avatars/second.png';marker().fire('click');assert.equal(image().getAttribute('href'),url);assert.equal(reads,2);h.find('qqj-window-page')[0].fire('click',{target:h.find('qqj-window-map')[0]});assert.equal(marker().attributes['aria-expanded'],'false');
 marker().fire('click');h.find('qqj-window-page')[0].fire('keydown',{key:'Escape',preventDefault(){},stopPropagation(){}});assert.equal(marker().attributes['aria-expanded'],'false');assert.equal(marker().focusCalls,1);
 marker().fire('click');h.view.deactivate();assert.equal(avatar().hidden,true);await h.view.activate();assert.equal(marker().attributes['aria-expanded'],'false');marker().fire('click');h.emit({projectionRevision:2,userPosition:{status:'leftUnknown',placeEntityId:null,isCurrent:false}});assert.equal(h.find('qqj-window-current-pin').length,0);assert.equal(h.find('qqj-window-user-avatar').length,0);assert.equal(h.writes.length,0);
});


test('各类底图共用铺满正方形canvas，加载根SVG与区域使用同一百分比坐标',async()=>{
 for(const style of ['modern','old-town','sci-fi']){
  const h=harness({snapshot:{...initial,mapStyle:style},loadGenericMap:async()=>'<svg viewBox="0 0 500 500" preserveAspectRatio="xMidYMid meet" class="qqj-generic-basemap"></svg>'});
  await h.view.activate();await Promise.resolve();
  const map=h.find('qqj-window-map')[0],geometry=h.find('qqj-window-geometry')[0];
  assert.equal(map.style['--qqj-window-map-aspect'],'1');assert.equal(map.style['--qqj-window-map-width'],'100%');
  if(style==='modern')assert.ok(geometry.innerHTML.includes('preserveAspectRatio="xMidYMid meet"'));
  else assert.equal(geometry.querySelector('svg').getAttribute('preserveAspectRatio'),'xMidYMid meet');
  for(const pin of h.find('qqj-window-marker')){assert.ok(parseFloat(pin.style.left)>=0&&parseFloat(pin.style.left)<=100);assert.ok(parseFloat(pin.style.top)>=0&&parseFloat(pin.style.top)<=100);}
  assert.equal(h.writes.length,0);h.view.deactivate();
 }
 const data={...initial,places:[{...place('city','上海',['site']),mapLevel:'city'},{...place('site','场地',[],'city'),mapRole:'site'}],mapRootIds:['city'],unassignedPlaceIds:[]};
 const h=harness({snapshot:data,loadCityMap:async()=>'<svg viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid meet" class="qqj-real-basemap"></svg>'});
 await h.view.activate();await Promise.resolve();const map=h.find('qqj-window-map')[0],svg=h.find('qqj-window-geometry')[0].querySelector('svg');
 assert.equal(map.style['--qqj-window-map-aspect'],'1');assert.equal(map.style['--qqj-window-map-width'],'100%');assert.equal(svg.getAttribute('preserveAspectRatio'),'xMidYMid meet');assert.equal(svg.getAttribute('viewBox'),'0 0 1000 1000');assert.equal(h.writes.length,0);
});

test('初始化紧邻原整理，交替一次调用、取消及失败均释放共用忙态', async()=>{
 const calls=[],confirmations=[];let release,fail=false;
 const h=harness({dialog:{confirm:async options=>{confirmations.push(options);return true;},info:async()=>{}},editingRuntime:{organizePlaces:options=>{calls.push(options);if(fail)return Promise.reject(new Error('fixture'));return new Promise((resolve,reject)=>{release=resolve;options.signal.addEventListener('abort',()=>reject(new DOMException('取消','AbortError')),{once:true});});}}});
 await h.view.activate();const actions=()=>h.find('qqj-window-toolbar-actions')[0].children;
 assert.deepEqual(actions().slice(0,2).map(node=>node.textContent),['初始化','整理']);
 const init=h.find('qqj-window-initialize')[0],organize=h.find('qqj-window-organize')[0];
 const first=init.fire('click');await Promise.resolve();assert.equal(calls.length,1);assert.equal(calls[0].mode,'initialize');assert.equal(init.textContent,'取消初始化');assert.equal(organize.disabled,true);
 init.fire('click');await first;assert.equal(init.textContent,'初始化');assert.equal(organize.disabled,false);
 const second=organize.fire('click');await Promise.resolve();assert.equal(calls.length,2);assert.equal(calls[1].mode,'organize');assert.equal(init.disabled,true);release();await second;
 fail=true;await init.fire('click');assert.equal(init.disabled,false);assert.equal(organize.disabled,false);assert.equal(organize.textContent,'整理');assert.match(confirmations[0].body,/世界书/);assert.match(confirmations[1].body,/已有地点/);
});


test('Batch18 混合角色保旧无role父pin，内室当前位置锚祖先且点击完整树零写',async()=>{
 const data={...initial,places:[{...place('scope','七绝门',['valley','mountain']),mapLevel:'scope',mapRole:'area'},{...place('valley','七绝门山谷',['yard'],'scope')},{...place('yard','竹舍院落',['room'],'valley'),mapRole:'interior'},{...place('room','东厢房',[],'yard'),mapRole:'interior'},{...place('mountain','鬼山',[],'scope'),mapRole:'site'}],mapRootIds:['scope'],unassignedPlaceIds:[],userPosition:{status:'confirmed',placeEntityId:'room',isCurrent:true}},before=structuredClone(data),h=harness({snapshot:data});
 await h.view.activate();const pins=h.find('qqj-window-marker');assert.deepEqual(pins.map(n=>n.attributes['data-place-id']),['valley','mountain']);assert.ok(h.find('qqj-page-health')[0].textContent.includes('2 处场地'));assert.equal(pins[0].children[0].className,'qqj-window-current-pin');
 pins[0].fire('click');assert.ok(h.find('qqj-window-entry').some(n=>n.attributes['data-place-id']==='room'));assert.deepEqual(data,before);assert.equal(h.writes.length,0);
});

test('Batch18 真实边缘地区六字名称保持可读token并朝内展开，热区不受inset缩小',async()=>{
 for(const [asset,count] of [['modern-town-coast',5],['terrain-coast',4],['terrain-snow',3]]){
  const areas=Array.from({length:count},(_,i)=>({...place('area-'+i,'常规六字地区',['site-'+i],'scope'),mapRole:'area'}));
  const data={...initial,places:[{...place('scope','地图范围',areas.map(a=>a.entityId)),mapLevel:'scope',mapRole:'area',mapAssetId:asset},...areas,...areas.map((a,i)=>({...place('site-'+i,'场地'+i,[],a.entityId),mapRole:'site'}))],mapRootIds:['scope'],unassignedPlaceIds:[],userPosition:{status:'unknown'}};
  const h=harness({snapshot:data});await h.view.activate();const labels=h.find('qqj-window-area-open');assert.equal(labels.length,count);
  for(const label of labels){assert.equal(label.style['--qqj-window-area-font'],undefined,'字号不再按inset压小');assert.equal(label.style.width,undefined,'button不占整块区域');assert.equal(label.style.height,undefined);assert.equal(label.attributes.title,'常规六字地区');const x=parseFloat(label.style.left),available=parseFloat(label.style['--qqj-window-area-width']);assert.equal(label.attributes['data-label-align'],x<30?'start':x>70?'end':'center');assert.ok(available*2.53>104,'253px视口可容纳六个16px汉字与文字padding');}
  assert.equal(h.writes.length,0);
 }
});


function batch19PositionSnapshot(tail='empty'){
 const id=n=>`${n.toString(16).padStart(8,'0')}-0000-4000-8000-000000000000`,f=n=>id(100+n),ref=n=>({floorId:f(n),quotedText:'原位置依据',occurrence:1,evidenceMode:'explicit'});
 const entities=[[1,'七绝门'],[2,'七绝门山谷'],[3,'竹舍院落'],[4,'东厢房'],[5,'鬼山'],[6,'另一范围'],[7,'另一场地'],[9,'用户']].map(([n,displayName])=>({id:id(n),entityType:n===9?'person':'place',displayName,aliases:[],specialRole:n===9?'user':'none',firstSeenFloorId:f(27),lastSeenFloorId:f(28),status:'established',recordStatus:'active'}));
 const pos=(n,status='confirmed',place=4)=>({itemId:id(300+n),subjectEntityId:id(9),placeEntityId:place===null?null:id(place),status,evidenceRefs:[ref(n)]});
 const memory=(n,positions=[])=>({id:id(200+n),floorId:f(n),recordStatus:'active',summary:{aiText:'普通摘要',userText:null,effectiveSource:'ai'},sourceCanonicalContent:'原正文',participants:[],locations:[],spatialFacts:{schemaVersion:1,containments:n===27?[[2,1],[3,2],[4,3],[5,1],[7,6]].map(([child,parent],i)=>({itemId:id(400+i),placeEntityId:id(child),parentEntityId:id(parent),evidenceRefs:[ref(27)]})):[],positions,features:[],relations:[]}});
 const memories=[memory(27,tail==='unknown'?[]:[pos(27)])];
 if(tail!=='current')memories.push(memory(28,tail==='lastSeen'?[pos(28,'lastSeen')]:tail.startsWith('left')?[pos(28,'leftUnknown')]:tail==='ambiguous'?[pos(28),{...pos(28,'confirmed',5),itemId:id(399)}]:[]));
 if(tail==='leftThenEmpty')memories.push(memory(29));
 const sequences=tail==='leftThenEmpty'?[27,28,29]:[27,28];
 const workspace={schemaVersion:1,kind:'qqj-v3-place-workspace',chatId:chat,placesByEntityId:{},deletionsByEntityId:{},foundation:{schemaVersion:1,entities:[],facts:[[1,'area','scope'],[3,'interior'],[4,'interior'],[5,'site'],[6,'area','scope'],[7,'site']].map(([n,mapRole,mapLevel],i)=>({itemId:id(500+i),kind:'place',placeEntityId:id(n),mapRole,...(mapLevel?{mapLevel}:{}),knownFromFloorId:null,source:{kind:'worldbook',locator:'fixture',quote:'地点资料'}}))}};
 const source={status:'ready',root:{chatId:chat,narrativeGeneration:id(91),headCheckpointId:id(92)},rootRevision:tail==='current'?1:2,checkpoint:{inputFingerprints:sequences.map(n=>({floorId:f(n),memoryExcluded:false}))},floors:sequences.map(n=>({id:f(n),assistantSeq:n,recordStatus:'active',hostLocator:{messageIndex:n*2}})),floorMemories:memories,entities};
 return{snapshot:projectQianchuangSnapshot(source,{identityProjection:{placeWorkspace:workspace,...(tail==='deleted'?{deletedEntityIds:[id(4)]}:{})}}),ids:{scope:id(1),valley:id(2),room:id(4),otherScope:id(6)},source,workspace};
}

test('Batch19 真投影27确认28空增量保上次位置标记，常显房间标签并沿头像及跨页定位',async()=>{
 const current=batch19PositionSnapshot('current'),last=batch19PositionSnapshot(),h=harness({snapshot:current.snapshot});
 assert.equal(current.snapshot.userPosition.isCurrent,true);assert.equal(last.snapshot.userPosition.isCurrent,false);assert.equal(last.snapshot.userPosition.placeEntityId,last.ids.room);
 await h.view.activate();const getPin=()=>h.find('qqj-window-marker').find(n=>n.attributes['data-place-id']===last.ids.valley),old=getPin();assert.equal(old.children[0].className,'qqj-window-current-pin');
 h.emit({...last.snapshot,projectionRevision:2});const pin=getPin();assert.equal(pin.attributes['data-user-position'],'last');assert.equal(pin.children[1].textContent,'上次位置 · 东厢房');assert.notEqual(pin,old,'current降为last时刷新真实标记状态');
 pin.fire('click');assert.equal(pin.attributes['aria-expanded'],'true');assert.equal(pin.attributes['data-avatar-open'],'true');assert.equal(h.find('qqj-window-entry').find(n=>n.attributes['data-place-id']===last.ids.room).attributes['data-selected'],'true');pin.fire('click');assert.equal(pin.attributes['data-avatar-open'],'false');
 h.find('qqj-window-city-tab').find(n=>n.attributes['data-city-sheet-target']===last.ids.otherScope).fire('click');assert.equal(h.find('qqj-window-marker').some(n=>n.attributes['data-user-position']),false);h.find('qqj-window-position')[0].fire('click');assert.equal(h.find('qqj-window-page')[0].attributes['data-city-sheet'],last.ids.scope);assert.equal(getPin().attributes['data-user-position'],'last');assert.equal(h.writes.length,0);
});

test('Batch19 真投影lastSeen可见，离开未知歧义删除不借旧确认造用户点',async()=>{
 for(const tail of ['lastSeen','leftUnknown','leftThenEmpty','unknown','ambiguous','deleted']){
  const {snapshot}=batch19PositionSnapshot(tail),before=structuredClone(snapshot),h=harness({snapshot});await h.view.activate();const pins=h.find('qqj-window-marker').filter(n=>n.attributes['data-user-position']);
  assert.equal(pins.length,tail==='lastSeen'?1:0,tail);if(tail==='lastSeen'){assert.equal(pins[0].attributes['data-user-position'],'last');assert.equal(pins[0].children[1].textContent,'上次位置 · 东厢房');}if(tail.startsWith('left'))assert.match(h.find('qqj-window-user-position')[0].children[0].textContent,/已离开/);
  assert.deepEqual(snapshot,before);assert.equal(h.writes.length,0);
 }
});


test('古风设施沿现成图标覆盖床榻陈列焚香屏风灯火与日常器物，不匹配孤字',()=>{
 const samples=[['罗汉榻','rest','床榻'],['竹榻和软榻与架子床','rest','床榻'],['博古架与多宝格','ShelvingUnit','陈列架'],['香炉','Flame','香炉'],['屏风','Columns3','屏风'],['油灯与烛台和灯笼','Flame','灯火'],['火炉和炭盆及泥炉','FlameKindling','炉火'],['茶案和书案与八仙桌','Table2','桌案'],['太师椅','Armchair','座椅'],['百子柜与中药柜','ShelvingUnit','药柜'],['盖碗与茶盏和紫砂壶','Coffee','茶具'],['陶瓮与酒坛','Amphora','陶瓮'],['木箱和妆奁','storage','箱笼']];
 for(const [words,key,label] of samples)assert.deepEqual(module.qianchuangFacilityTags([{text:`设有${words}。`}]),[{key,label}],words);
 assert.deepEqual(module.qianchuangFacilityTags([{text:'一灯如豆；案牍繁忙，炉石传说，太师门下，博古通今。'}]),[]);
 assert.deepEqual(module.qianchuangFacilityTags([{text:'没有罗汉榻、博古架、香炉、屏风和油灯。计划添置烛台和火炉。'},{text:'配有茶案和太师椅。',kind:'temporary'},{text:'她拿起茶盏，走向屏风寻找线索。'}]),[]);
});
test('古风与旧设施按同canonical去重，香炉油灯同场保一个标签且原文不改',()=>{
 const features=[{text:'设有罗汉榻和双人床、博古架与多宝格、香炉和油灯及烛台。'}],before=structuredClone(features);
 assert.deepEqual(module.qianchuangFacilityTags(features),[{key:'rest',label:'床榻'},{key:'ShelvingUnit',label:'陈列架'},{key:'Flame',label:'香炉'}]);
 assert.deepEqual(features,before);
 assert.deepEqual(module.qianchuangFacilityTags([{text:'设有油灯和香炉。'}]),[{key:'Flame',label:'灯火'}]);
 assert.deepEqual(module.qianchuangFacilityTags([{text:'设有双人床、衣柜和书桌、药柜。'}]).map(item=>item.key),['rest','storage','work','PillBottle']);
});
test('古风设施仅补省略facilities的展示，显式空列表与人工简介仍沿原合同',async()=>{
 const feature={text:'设有罗汉榻、博古架、香炉、油灯和屏风。'};
 for(const explicit of [false,true]){
  const places=initial.places.map(node=>({...node,features:node.entityId==='root'?[feature]:[],...(explicit?{facilities:[]}:{} )}));
  const h=harness({snapshot:{...initial,places}});await h.view.activate();
  assert.deepEqual(h.find('qqj-window-tag').map(node=>node.children[1].textContent),explicit?[]:['床榻','陈列架','香炉','屏风']);
  assert.equal(h.find('qqj-window-copy').some(node=>node.textContent===feature.text),true);
  assert.equal(h.writes.length,0);
 }
});
