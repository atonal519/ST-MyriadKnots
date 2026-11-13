import {subscribeQianchuangMapCatalog,qianchuangMapCatalogRevision} from '../qianchuang-map-catalog.js';
import {projectQianchuangSheets,snapshotForCitySheet,placeMapLevel} from './qianchuang-city-sheets.js';
import {CITY_MAPS,createCityMapLoader,citySchematicLayout} from './qianchuang-city-maps.js';
import { projectQianchuangBrowse } from './qianchuang-browse.js';
import { createOperationMenuController } from './operation-menu-controller.js';
import { qianchuangIcon } from './qianchuang-icons.js';
import { createInlineSelect } from './inline-select.js';
import { QIANCHUANG_BASEMAPS } from './qianchuang-basemaps.js';
import { qianchuangMapLayout } from './qianchuang-map-layout.js';
import { publicErrorMessage } from '../public-error.js';
import {QIANCHUANG_MAP_ASSETS,qianchuangMapCandidates,selectQianchuangMapAsset} from '../qianchuang-map-assets.js';
import {createGenericMapLoader} from './qianchuang-map-loader.js';

import {qianchuangFacilityTags} from './qianchuang-facilities.js';
export {qianchuangFacilityTags};
// Existing saved preferences select the corresponding registered template.
const legacyBasemapAssets=Object.freeze({modern:'modern-inland',town:'old-town-inland',palace:'palace-axial','modern-town':'modern-town-plain','old-town':'old-town-plain','sci-fi':'sci-fi-linear'});
const osmMapAssetIds=new Set(['modern-inland','modern-coast','modern-radial','modern-town-plain','modern-town-river','modern-town-coast','old-town-inland','old-town-river','old-town-coast','old-town-plain','terrain-forest','terrain-coast','terrain-mountain','terrain-coast-relief','terrain-desert','terrain-snow','palace-axial','palace-courtyard-garden','palace-courtyard-honmaru','campus-compact','campus-garden','campus-university']);
const displayText = value => String(value ?? '').replace(/\s+/gu,' ').trim();
const defaultPlaceMapRole = ({mapLevel=null,parentRole=null}={}) =>
 ['city','country','scope'].includes(mapLevel)?'area':['site','interior'].includes(parentRole)?'interior':'site';

export function createQianchuangView({ runtime, settings, sessionStateProvider = null, prepareSession = null, dialog = null, userAvatarProvider = () => null, moduleUrl, loadCityMap = createCityMapLoader({moduleUrl}), loadGenericMap=createGenericMapLoader({moduleUrl}), documentRef = globalThis.document } = {}) {
  if (!runtime || ['getQianchuangSnapshot','prepareCurrent','subscribe'].some(key => typeof runtime[key] !== 'function')) throw new TypeError('千窗 runtime 无效');
  const operationMenus = createOperationMenuController(documentRef);
  const visitMenus = (node, action) => { if (String(node?.className ?? '').split(/\s+/u).includes('qqj-window-operation-menu')) operationMenus[action](node); for (const child of node?.children ?? []) visitMenus(child, action); };
  let container = null, active = false, unsubscribe = null, unsubscribeCatalog = null, epoch = 0, chatId = null, highlightedMapRootId = null, renderedRevision = null;
  let page, health, toolbar, search, searchClear, navigation, mapGroup, map, regions, areas, points, copyright, contents, position, rootRegion, drawer, drawerHead, directory, basemap = 'modern', preparing = false, failure = null;
  let snapshot = runtime.getQianchuangSnapshot(), byId = new Map(), openIds = new Set(), localSelections = new Map(), unassignedOpen = false, rootEntries = new Map(), orphanEntries = new Map(), markers = new Map();
  let markerKey=null,positionKey=null,browseScopeId=undefined,browse=null,mapBrowse=null,query='';
  let organizationController=null,organizationMode=null,organizeAction=null,initializeAction=null;
  let sheets=null,activeSheetId=null,sheetSnapshot=null,displayById=new Map(),sheetRow=null,assetDrawKey=null;
  let sheetSwitcher=null,sheetScrollLeft=0,lastCurrentSheetId=null;
  let sheetProjectionSource=null,sheetProjection=null,basemapGeometry=null,catalogRevision=qianchuangMapCatalogRevision();
  const currentSheet=()=>sheets?.sheets.find(sheet=>sheet.id===activeSheetId);
  const browseFor=id=>{
    const source=sheetSnapshot??snapshot,root=currentSheet()?.rootPlaceId??currentSheet()?.cityId;
    const legacyBoundary=root&&!source.places.some(place=>['area','site'].includes(place.mapRole));
    return projectQianchuangBrowse(source,id===undefined&&legacyBoundary?root:id);
  };
  const el = (tag, cls = '', text = '') => { const node = documentRef.createElement(tag); node.className = cls; if (text) node.textContent = text; return node; };
  const button = (cls, text, action) => { const node = el('button', cls, text); node.type = 'button'; node.addEventListener('click', action); return node; };
  let userAvatar=null;
  const svgNode=(tag,attributes={})=>{const node=documentRef.createElementNS('http://www.w3.org/2000/svg',tag);for(const[key,value]of Object.entries(attributes))node.setAttribute(key,String(value));return node;};
  function paintUserAvatar(state,progress){
    state.progress=progress;
    const d=state.small.map((point,i)=>(i?'L':'M')+point.map((n,k)=>(n+(state.large[i][k]-n)*progress).toFixed(3)).join(',')).join('')+'Z';state.outline.setAttribute('d',d);state.clipShape.setAttribute('d',d);
    state.outline.style.fill=`color-mix(in srgb,var(--panel) ${Math.min(100,progress*140)}%,var(--knot))`;
    state.outline.style.stroke=`color-mix(in srgb,var(--knot) ${progress*100}%,var(--panel))`;
    const fade=Math.max(0,Math.min(1,(progress-.35)/.6));
    state.image.style.opacity=String(state.ready?fade:0);state.fallback.style.opacity=String(state.ready?0:fade);state.hole.style.opacity=String(Math.max(0,1-progress*3));
    state.layer.hidden=progress===0&&!state.open;state.symbol.style.visibility=state.layer.hidden?'':'hidden';
  }
  function animateUserAvatar(state,open,immediate=false){
    const win=documentRef.defaultView;state.open=open;state.marker.setAttribute('aria-expanded',String(open));state.marker.setAttribute('data-avatar-open',String(open));
    state.marker.setAttribute('aria-label',`${userPositionLabel()}，${open?'收起':'展开'}用户头像`);
    if(state.frame)win?.cancelAnimationFrame(state.frame);state.frame=0;paintUserAvatar(state,state.progress);
    if(immediate||!win?.requestAnimationFrame||win.matchMedia?.('(prefers-reduced-motion:reduce)').matches){paintUserAvatar(state,open?1:0);return;}
    const start=state.progress,end=open?1:0,duration=open?260:240,began=win.performance.now();
    const tick=now=>{const t=Math.min(1,(now-began)/duration);paintUserAvatar(state,start+(end-start)*(1-Math.pow(1-t,3)));state.frame=t<1?win.requestAnimationFrame(tick):0;};
    state.frame=win.requestAnimationFrame(tick);
  }
  function closeUserAvatar(immediate=false,returnFocus=false){
    if(!userAvatar)return;animateUserAvatar(userAvatar,false,immediate);if(returnFocus)userAvatar.marker.focus?.({preventScroll:true});
  }
  function toggleUserAvatar(marker){
    if(userAvatar?.marker===marker&&userAvatar.open){closeUserAvatar();return;}
    if(userAvatar?.marker!==marker)closeUserAvatar(true);
    const symbol=marker.children[0],pin=symbol.getBoundingClientRect(),frame=map.getBoundingClientRect(),host=marker.getBoundingClientRect(),size=pin.width,anchorX=pin.left+pin.width/2-frame.left,anchorY=pin.top+pin.height*22/24-frame.top;
    if(userAvatar?.marker!==marker){
      const layer=el('span','qqj-window-user-avatar'),svg=svgNode('svg',{'aria-hidden':'true'}),outline=svgNode('path',{'class':'qqj-window-user-avatar-outline'}),image=svgNode('image',{'class':'qqj-window-user-avatar-image',width:80,height:80,preserveAspectRatio:'xMidYMid slice'}),fallback=svgNode('svg',{'class':'qqj-window-user-avatar-fallback',width:36,height:36,viewBox:'0 0 24 24'}),hole=svgNode('circle',{cx:0,cy:-12*size/24,r:3*size/24});
      const defs=svgNode('defs'),clip=svgNode('clipPath',{id:'qqj-window-user-avatar-clip',clipPathUnits:'userSpaceOnUse'}),clipShape=svgNode('path'),portrait=svgNode('g',{'clip-path':'url(#qqj-window-user-avatar-clip)'});clip.append(clipShape);defs.append(clip);
      fallback.innerHTML=qianchuangIcon('place');portrait.append(image,fallback);svg.append(defs,outline,portrait,hole);layer.append(svg);marker.append(layer);
      userAvatar={marker,symbol,layer,svg,outline,clipShape,image,fallback,hole,small:[],large:[],open:false,progress:0,frame:0,ready:false,url:null,failed:false};
      const state=userAvatar;image.addEventListener('load',()=>{state.ready=true;state.failed=false;paintUserAvatar(state,state.progress);});image.addEventListener('error',()=>{state.ready=false;state.failed=true;paintUserAvatar(state,state.progress);});
    }
    const state=userAvatar,direction=anchorY>=114?'up':frame.height-anchorY>=114?'down':anchorX<frame.width/2?'right':'left',horizontal=direction==='right'||direction==='left',offset=horizontal?Math.max(52,Math.min(frame.height-52,anchorY))-anchorY:Math.max(52,Math.min(frame.width-52,anchorX))-anchorX,dx=direction==='left'?-offset:offset,tail=Math.max(dx-34,Math.min(dx+34,0));
    const orient=(x,y)=>direction==='up'?[x,y]:direction==='down'?[x,-y]:direction==='right'?[-y,x]:[y,-x];
    state.layer.style.left=`${pin.left+pin.width/2-host.left}px`;state.layer.style.top=`${pin.top+pin.height*22/24-host.top}px`;
    const raw=svgNode('path',{d:'M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0Z'}),large=svgNode('path',{d:`M${dx+48} -62 L${dx+48} -28 Q${dx+48} -14 ${dx+34} -14 L${tail+9} -14 L0 0 L${tail-9} -14 L${dx-34} -14 Q${dx-48} -14 ${dx-48} -28 L${dx-48} -96 Q${dx-48} -110 ${dx-34} -110 L${dx+34} -110 Q${dx+48} -110 ${dx+48} -96 Z`});
    // 两形沿同向轮廓插值，头像尾尖始终留在原图钉尖端。
    const sample=(path,convert)=>{const length=path.getTotalLength();return Array.from({length:120},(_,i)=>convert(path.getPointAtLength(length*i/120)));};
    const align=points=>{let start=0;for(let i=1;i<points.length;i++)if(points[i][0]**2+points[i][1]**2<points[start][0]**2+points[start][1]**2)start=i;const aligned=points.slice(start).concat(points.slice(0,start));aligned[0]=[0,0];return aligned;};
    state.small=align(sample(raw,p=>[(p.x-12)*size/24,(p.y-22)*size/24]));state.large=align(sample(large,p=>orient(p.x,p.y)));
    const area=points=>points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p[0]*q[1]-p[1]*q[0];},0);if(Math.sign(area(state.small))!==Math.sign(area(state.large)))state.large=[state.large[0],...state.large.slice(1).reverse()];
    const bounds=[...state.small,...state.large],left=Math.min(...bounds.map(p=>p[0]))-4,top=Math.min(...bounds.map(p=>p[1]))-4,width=Math.max(...bounds.map(p=>p[0]))-left+4,height=Math.max(...bounds.map(p=>p[1]))-top+4;
    state.svg.setAttribute('viewBox',`${left} ${top} ${width} ${height}`);for(const[key,value]of Object.entries({left,top,width,height}))state.svg.style[key]=`${value}px`;state.hole.setAttribute('cy',String(-12*size/24));
    const center=orient(dx,-62);state.image.setAttribute('x',String(center[0]-40));state.image.setAttribute('y',String(center[1]-40));state.fallback.setAttribute('x',String(center[0]-18));state.fallback.setAttribute('y',String(center[1]-18));
    let url=null;try{url=userAvatarProvider();}catch{}url=typeof url==='string'?url.trim():'';
    if(url!==state.url||state.failed){state.url=url;state.ready=false;state.failed=false;if(url)state.image.setAttribute('href',url);}
    animateUserAvatar(state,true);
  }
  function drawBasemap() {
    if(!currentSheet()){assetDrawKey=null;mapGroup.hidden=true;map.replaceChildren(regions,areas,points);copyright.replaceChildren();copyright.hidden=true;return;}
    mapGroup.hidden=false;
    const real=CITY_MAPS[currentSheet()?.assetId],generic=QIANCHUANG_MAP_ASSETS[basemap],asset=real??generic??QIANCHUANG_BASEMAPS[basemap],key=chatId+':'+activeSheetId+':'+(real?.id??basemap);
    if(assetDrawKey===key)return;assetDrawKey=key;
    const reusedGeometry=basemapGeometry?.key===key;
    const geometry=reusedGeometry?basemapGeometry.node:el('div','qqj-window-geometry');
    map.style.setProperty('--qqj-window-map-aspect','1');map.style.setProperty('--qqj-window-map-width','100%');map.setAttribute('data-basemap',real?.id??basemap);map.setAttribute('data-map-mode',real?'real':'generic');
    map.setAttribute('data-map-library',String(!real&&!!generic));
    map.replaceChildren(geometry,regions,areas,points);copyright.replaceChildren();copyright.hidden=!real&&basemap!=='modern'&&!osmMapAssetIds.has(generic?.id);if(!copyright.hidden)copyright.textContent='© OpenStreetMap contributors · ODbL';
    if(reusedGeometry)return;
    if(real||generic){
      geometry.setAttribute('aria-busy','true');
      void (real?loadCityMap(real.id):loadGenericMap(generic.id)).then(svg=>{if(assetDrawKey!==key||map.children[0]!==geometry)return;geometry.innerHTML=svg;geometry.querySelector('svg')?.setAttribute('preserveAspectRatio','xMidYMid meet');geometry.setAttribute('aria-busy','false');basemapGeometry={key,node:geometry};},()=>{if(assetDrawKey!==key||map.children[0]!==geometry)return;geometry.textContent=real?'城市底图暂时无法读取，可继续浏览地点资料。':'底图暂时无法读取，可继续浏览地点资料。';geometry.setAttribute('aria-busy','false');});
    }else {geometry.innerHTML=`<svg viewBox="0 0 ${asset.width} ${asset.height}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${asset.markup}</svg>`;basemapGeometry={key,node:geometry};}
  }
  function selectSheet(id){
    if(!sheets?.sheets.some(sheet=>sheet.id===id))return;
    closeUserAvatar(true);
    activeSheetId=id;browseScopeId=undefined;query='';search.value='';highlightedMapRootId=null;localSelections.clear();openIds.clear();unassignedOpen=false;markerKey=null;renderData();update();
  }
  function renderSheets(){
    if(sheetSwitcher?.parentNode===sheetRow)sheetScrollLeft=Number(sheetSwitcher.scrollLeft)||0;
    const currentSheetId=snapshot.userPosition?.isCurrent===true?sheets.sheets.find(sheet=>sheet.id===sheets.placeSheets.get(snapshot.userPosition.placeEntityId))?.id:null;
    if(currentSheetId&&currentSheetId!==lastCurrentSheetId){sheetScrollLeft=0;lastCurrentSheetId=currentSheetId;}
    sheetSwitcher=null;
    sheetRow.replaceChildren();sheetRow.hidden=sheets.sheets.length<2;page.setAttribute('data-city-sheet',activeSheetId??'');
    if(!sheetRow.hidden){const bar=el('nav','qqj-profile-switcher qqj-window-city-switcher');bar.setAttribute('aria-label','地图');for(const sheet of sheets.sheets){const tab=button('qqj-profile-tab qqj-window-city-tab'+(sheet.id===activeSheetId?' active':''),sheet.label,()=>selectSheet(sheet.id));tab.setAttribute('data-city-sheet-target',sheet.id);tab.setAttribute('aria-pressed',String(sheet.id===activeSheetId));bar.append(tab);}sheetRow.append(bar);bar.scrollLeft=sheetScrollLeft;sheetScrollLeft=Number(bar.scrollLeft)||0;sheetSwitcher=bar;bar.addEventListener('scroll',()=>{if(sheetSwitcher===bar)sheetScrollLeft=Number(bar.scrollLeft)||0;});}
  }
  function resetChat(next) {
    if (chatId === next) return;
    if(active && !(preparing && chatId===null && next!==null)) { epoch++; preparing=false; failure=null; }
    organizationController?.abort();closeUserAvatar(true);userAvatar=null;
    sheetProjectionSource=null;sheetProjection=null;basemapGeometry=null;
    chatId = next;sheets=null;activeSheetId=null;sheetSnapshot=null;displayById=new Map();assetDrawKey=null;sheetSwitcher=null;sheetScrollLeft=0;lastCurrentSheetId=null; highlightedMapRootId = null; renderedRevision = null; openIds = new Set(); localSelections = new Map(); unassignedOpen=false;query='';if(search)search.value='';browseScopeId=undefined;browse=null;mapBrowse=null;markerKey=null;positionKey=null;byId = new Map();
    const savedBasemap=settings?.get?.()?.qianchuangBasemaps?.[chatId];basemap=legacyBasemapAssets[QIANCHUANG_BASEMAPS[savedBasemap]?savedBasemap:'modern'];
    drawBasemap();
  }
  function textFor(node, target) {
    const supplements=node.manualDescription?[]:node.worldInfoDescriptions??[],tags=node.facilities?.map(({icon,label})=>({key:icon,label}))??qianchuangFacilityTags(node.features,supplements),seen=new Set();
    if(tags.length){const row=el('div','qqj-window-tags');for(const tag of tags){const pill=el('span','qqj-window-tag'),icon=el('span','qqj-window-tag-icon');icon.innerHTML=qianchuangIcon(tag.key);pill.append(icon,el('span','',tag.label));row.append(pill);}target.append(row);}
    for(const items of [node.features,supplements,node.relations??[]])for(const item of items){const text=displayText(item.text);if(text&&!seen.has(text)){seen.add(text);target.append(el('p','qqj-window-copy',item.text));}}
  }
  function placeOperationMenu(node) {
    const menu = operationMenus.register(el('details', 'qqj-profile-menu qqj-window-operation-menu'));
    menu.setAttribute('data-place-menu', node.entityId); menu.addEventListener('click', event => event.stopPropagation?.());
    const trigger = el('summary', 'qqj-profile-menu-toggle', '⋮'); trigger.setAttribute('aria-label', `${node.displayName}操作`);
    const body = el('div', 'qqj-profile-menu-pop');
    const edit = button('qqj-profile-menu-action qqj-window-edit', '编辑', event => {
      event?.preventDefault?.(); event?.stopPropagation?.(); menu.open = false; openPlaceEditor(node);
    });
    edit.setAttribute('data-edit-place', node.entityId);
    const remove = button('qqj-profile-menu-action danger qqj-window-remove', '删除', async event => {
      event?.preventDefault?.(); event?.stopPropagation?.(); menu.open = false;
      const context = runtime.getPlaceEditContext(node.entityId);
      if (!await dialog.confirm({ title: '删除地点', body: `删除“${node.displayName}”已有资料？下级地点会保留为顶层地点。`, confirmText: '删除', danger: true })) return;
      try { await runtime.deletePlace(node.entityId, context); }
      catch (error) { await dialog.info?.({ title: '删除失败', body: publicErrorMessage(error, { fallback: '地点删除失败，请重试。' }) }); }
    });
    remove.setAttribute('data-place-delete', node.entityId); remove.disabled = !runtime.deletePlace || !dialog?.confirm;
    const top=button('qqj-profile-menu-action qqj-window-set-top-level','设为顶层地点',async event=>{
      event?.preventDefault?.();event?.stopPropagation?.();menu.open=false;
      try{await runtime.savePlace(node.entityId,{parentEntityId:null},runtime.getPlaceEditContext(node.entityId));}
      catch(error){await dialog.info?.({title:'设置失败',body:publicErrorMessage(error,{fallback:'地点保存失败，请重试。'})});}
    });top.setAttribute('data-place-top-level',node.entityId);
    body.append(edit, top, remove); menu.append(trigger, body); return menu;
  }
  function orderedPlaces(){
    const ordered=[],seen=new Set(),visit=id=>{if(seen.has(id)||!byId.has(id))return;seen.add(id);const place=byId.get(id);ordered.push(place);for(const child of place.childEntityIds)visit(child);};
    for(const id of snapshot.mapRootIds??[])visit(id);for(const id of snapshot.unassignedPlaceIds??[])visit(id);for(const id of byId.keys())visit(id);return ordered;
  }
  function placePath(place){const names=[place.displayName],seen=new Set([place.entityId]);let parent=byId.get(place.parentEntityId);while(parent&&!seen.has(parent.entityId)){seen.add(parent.entityId);names.unshift(parent.displayName);parent=byId.get(parent.parentEntityId);}return names.join(' / ');}
  function childPicker(parent,selected){
    const excluded=new Set([parent.entityId]),form=el('div','qqj-profile-field qqj-window-child-picker');
    let ancestor=byId.get(parent.parentEntityId);while(ancestor&&!excluded.has(ancestor.entityId)){excluded.add(ancestor.entityId);ancestor=byId.get(ancestor.parentEntityId);}
    form.append(el('p','settings-hint','选中的地点连同下级一起移入。'));
    const searchRow=el('div','qqj-inline-select-search-row'),input=el('input','settings-input qqj-inline-select-search-input');input.type='search';input.placeholder='搜索地点名称或路径';input.setAttribute('aria-label',input.placeholder);
    input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing&&event.keyCode!==229){event.preventDefault?.();event.stopPropagation?.();}});
    const choices=el('div','qqj-qianshi-people-choices'),rows=[],empty=el('p','qqj-qianshi-people-empty','没有匹配的地点。');empty.setAttribute('role','status');
    const filter=()=>{const words=displayText(input.value).toLocaleLowerCase().split(/\s+/u).filter(Boolean);let count=0;for(const item of rows){item.row.hidden=!words.every(word=>item.text.includes(word));if(!item.row.hidden)count++;}empty.hidden=count>0;};
    const clear=button('secondary-action compact qqj-inline-select-search-clear','清空',()=>{input.value='';filter();input.focus?.({preventScroll:true});});clear.setAttribute('aria-label','清空搜索');input.addEventListener('input',filter);searchRow.append(input,clear);form.append(searchRow);
    for(const place of orderedPlaces())if(!excluded.has(place.entityId)&&place.parentEntityId!==parent.entityId){
      const row=el('label','qqj-qianshi-person-choice'),checkbox=el('input'),label=placePath(place);checkbox.type='checkbox';checkbox.checked=false;checkbox.setAttribute('data-child-place',place.entityId);
      checkbox.addEventListener('change',()=>{if(checkbox.checked)selected.add(place.entityId);else selected.delete(place.entityId);});row.append(checkbox,el('span','',label));choices.append(row);rows.push({row,text:[label,...(place.aliases??[])].join(' ').toLocaleLowerCase()});
    }
    if(!rows.length)empty.textContent='暂无可添加的地点。';choices.append(empty);form.append(choices);filter();
    return {node:form,search:input};
  }
  function openPlaceEditor(node = null) {
    if (!dialog?.custom || !runtime.getPlaceEditContext) return;
    const context = runtime.getPlaceEditContext(node?.entityId ?? null);
    const original = { name: node?.displayName ?? '', parentEntityId: node?.parentEntityId ?? null,
      description: [...new Set([...(node?.features ?? []), ...(node?.worldInfoDescriptions ?? [])].map(item => item.text))].join('\n'),
      relations: (node?.relations ?? []).map(item => item.text).join('\n'),mapLevel:node?placeMapLevel(node):null,mapRole:node?.manualMapRole?node.mapRole:null };
    const draft = { ...original,...(!node?{mapRole:defaultPlaceMapRole()}: {}) }, childIds = new Set(), form = el('form', 'qqj-editor-dialog qqj-profile-form qqj-place-editor');
    let roleTouched=false,rolePicker;
    const syncDefaultRole=()=>{if(!node&&!roleTouched){draft.mapRole=defaultPlaceMapRole({mapLevel:draft.mapLevel,parentRole:byId.get(draft.parentEntityId)?.mapRole});rolePicker?.setValue(draft.mapRole);}};
    const field = (key, labelText, tag) => {
      const label = el('label', 'qqj-profile-field'), input = el(tag, 'settings-input');
      label.append(el('span', '', labelText)); input.value = draft[key]; input.setAttribute('data-place-field', key);
      if (key === 'name') input.maxLength = 500;
      if (tag === 'textarea') input.rows = key === 'description' ? 5 : 3;
      input.addEventListener('input', () => { draft[key] = input.value; }); label.append(input); form.append(label); return input;
    };
    field('name', '名称', 'input');
    const parentField = el('div', 'qqj-profile-field'); parentField.append(el('span', '', '所属地点'));
    const parentOptions = [{ value: '', label: '无（顶层地点）' }];
    const descendants = new Set(node ? [node.entityId] : []);
    for (const id of descendants) for (const child of byId.get(id)?.childEntityIds ?? []) descendants.add(child);
    for (const place of orderedPlaces()) if (!descendants.has(place.entityId)) parentOptions.push({ value: place.entityId, label: placePath(place) });
    const parent = createInlineSelect({ documentRef, options: parentOptions, value: original.parentEntityId ?? '', ariaLabel: '所属地点', searchable: true, searchPlaceholder: '搜索地点名称或路径', showChevron: false, onChange: value => { draft.parentEntityId = value || null; syncDefaultRole(); } });
    parent.node.setAttribute('data-place-field', 'parentEntityId'); parentField.append(parent.node); form.append(parentField);
    {
      const levelField=el('div','qqj-profile-field qqj-place-level-field');levelField.append(el('span','','地图层级'));
      const level=createInlineSelect({documentRef,options:[{value:'',label:'普通地点'},{value:'city',label:'城市'},{value:'country',label:'国家'},{value:'scope',label:'独立地图'}],value:original.mapLevel??'',ariaLabel:'地图层级',showChevron:false,onChange:value=>{draft.mapLevel=value||null;syncDefaultRole();}});level.node.setAttribute('data-place-field','mapLevel');levelField.append(level.node);form.append(levelField);
    }
    {
      const roleField=el('div','qqj-profile-field');roleField.append(el('span','','地点类型'));
      const labels={area:'区域',site:'场地',interior:'室内'},automatic=node&&!node.manualMapRole&&labels[node.mapRole]?`自动（当前：${labels[node.mapRole]}）`:'自动';
      rolePicker=createInlineSelect({documentRef,options:[{value:'',label:automatic},...Object.entries(labels).map(([value,label])=>({value,label}))],value:draft.mapRole??'',ariaLabel:'地点类型',showChevron:false,onSelect:value=>{draft.mapRole=value||null;roleTouched=true;}});
      rolePicker.node.setAttribute('data-place-field','mapRole');roleField.append(rolePicker.node);form.append(roleField);
    }
    if(node){
      const field=el('div','qqj-profile-field qqj-place-children-field'),picker=childPicker(node,childIds);
      const add=button('secondary-action compact qqj-window-add-children','添加子地点',()=>{picker.node.hidden=!picker.node.hidden;add.setAttribute('aria-expanded',String(!picker.node.hidden));if(!picker.node.hidden)picker.search.focus?.({preventScroll:true});});
      add.setAttribute('data-place-add-children',node.entityId);add.setAttribute('aria-expanded','false');picker.node.hidden=true;field.append(add,picker.node);form.append(field);
    }
    field('description', '地点描述', 'textarea'); field('relations', '方位说明', 'textarea');
    let saving = false;
    void dialog.custom({ title: node ? `编辑地点 · ${node.displayName}` : '新增地点', content: form, confirmText: '保存', cancelText: '取消', submit: async () => {
      if (saving) throw new Error('正在保存地点资料。');
      const changed = Object.fromEntries(Object.entries(draft).filter(([key,value])=>(node||key!=='mapLevel'||value!==null)&&(!node||value!==original[key])));
      if (!Object.keys(changed).length&&!childIds.size) return true;
      saving = true;
      try { if (node) await runtime.savePlace(node.entityId, changed, context,...(childIds.size?[{childIds:[...childIds]}]:[])); else await runtime.createPlace(changed, context); return true; }
      finally { saving = false; }
    } });
  }
  function mapAnchor(id) {
    let node=byId.get(id);while(node){if(mapBrowse?.pinIds.includes(node.entityId))return node.entityId;node=byId.get(node.parentEntityId);}return null;
  }
  function userMapAnchor() {
    const user=snapshot.userPosition;
    return ['confirmed','lastSeen'].includes(user?.status) && byId.has(user.placeEntityId) ? mapAnchor(user.placeEntityId) : null;
  }
  const userPositionLabel = () => `${snapshot.userPosition?.isCurrent?'当前位置':'上次位置'} · ${byId.get(snapshot.userPosition?.placeEntityId)?.displayName??'未知地点'}`;
  const selectionScope = node => mapAnchor(node.entityId) ?? 'unassigned';
  function chooseChild(id) {const node=byId.get(id);if(!node)return;localSelections.clear();localSelections.set(selectionScope(node),id);highlightedMapRootId=mapAnchor(id);syncSelection();}
  function syncSelection() {
    for(const[id,node]of markers)node.setAttribute('aria-pressed',String(id===highlightedMapRootId));
    for(const node of areas?.children??[])node.setAttribute('aria-pressed',String(node.getAttribute('data-scope-id')===browse?.scopeId));
    for(const[id,{group,summary}]of [...rootEntries,...orphanEntries]){const place=byId.get(id),selected=place&&localSelections.get(selectionScope(place))===id;summary.setAttribute('aria-current',String(Boolean(selected)));group.setAttribute('data-selected',String(Boolean(selected)));}
  }
  function expandTo(id) {
    let current=byId.get(id);
    while(current){const entry=rootEntries.get(current.entityId)??orphanEntries.get(current.entityId);if(entry)openIds.add(current.entityId);current=byId.get(current.parentEntityId);}
    if(orphanEntries.has(id)){unassignedOpen=true;drawer.open=true;}
    filterTree();chooseChild(id);
  }
  function selectRoot(id) {
    closeUserAvatar();
    if(!byId.has(id))return;
    const sheetId=sheets?.placeSheets.get(id);if(sheetId&&sheetId!==activeSheetId)selectSheet(sheetId);
    openIds.clear();unassignedOpen=false;query='';search.value='';
    if(!rootEntries.has(id)&&!orphanEntries.has(id)){browseScopeId=undefined;renderData();update();}
    expandTo(id);
  }
  function selectScope(id) {
    closeUserAvatar();
    browseScopeId=id;query='';search.value='';highlightedMapRootId=null;localSelections.clear();openIds.clear();unassignedOpen=false;
    if(browse?.scopeId===browseFor(id).scopeId)filterTree();else renderData();update();
  }
  function clearOnBlank(event) {
    for(let node=event.target;node&&node!==page;node=node.parentNode){
      const tag=String(node.tagName??node.tag??'').toLowerCase(),classes=String(node.className??'').split(/\s+/u);
      if(['button','summary','a','input','textarea','select','label','p','h3','small'].includes(tag)
        ||classes.some(name=>['qqj-inline-select','qqj-profile-menu','qqj-window-tags'].includes(name)))return;
    }
    selectScope(undefined);
  }
  function locate(id) {
    const place=byId.get(id);if(!place)return;
    selectRoot(id);
    const entry=rootEntries.get(id)??orphanEntries.get(id);entry?.summary?.scrollIntoView?.({block:'nearest'});
  }
  function treeNode(id,registry) {
    const node=byId.get(id),childIds=displayById.get(id)?.childEntityIds??node.childEntityIds,hasContent=childIds.length||node.features.length||(node.worldInfoDescriptions??[]).length||(node.relations??[]).length,group=el('details',`qqj-window-entry${childIds.length?' qqj-window-parent':' qqj-window-leaf'}${hasContent?' qqj-window-has-content':''}`),summary=el('summary','qqj-window-summary');
    const icon=el('span','qqj-window-title-icon');icon.innerHTML=qianchuangIcon('place');summary.append(icon,el('span','qqj-window-entry-name',node.displayName));if(dialog?.custom&&runtime.savePlace)summary.append(placeOperationMenu(node));
    group.setAttribute('data-place-id',id);summary.setAttribute('data-place-id',id);group.open=openIds.has(id);
    summary.addEventListener('click',()=>{if(!query.trim()){if(group.open)openIds.delete(id);else openIds.add(id);}chooseChild(id);});group.addEventListener('toggle',()=>{if(!query.trim()){if(group.open)openIds.add(id);else openIds.delete(id);}});
    const detail=el('div','qqj-window-inline-detail');textFor(node,detail);group.append(summary,detail);registry.set(id,{group,summary});
    if(childIds.length){const children=el('div','qqj-window-children');for(const child of childIds)children.append(treeNode(child,registry));group.append(children);}return group;
  }
  function filterTree() {
    const entries=new Map([...rootEntries,...orphanEntries]),words=query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean),visible=new Set();
    if(words.length)for(const [id]of entries){
      const node=byId.get(id),names=[node.displayName,...(node.aliases??[])];let ancestor=byId.get(node.parentEntityId);
      while(ancestor){names.unshift(ancestor.displayName);ancestor=byId.get(ancestor.parentEntityId);}
      const haystack=[...names,...node.features.map(item=>item.text),...(node.worldInfoDescriptions??[]).map(item=>item.text)].join(' ').toLocaleLowerCase();
      if(words.every(word=>haystack.includes(word))){let current=node;while(current){if(entries.has(current.entityId))visible.add(current.entityId);current=byId.get(current.parentEntityId);}}
    }
    for(const [id,{group}]of entries){group.hidden=Boolean(words.length)&&!visible.has(id);group.open=words.length?visible.has(id):openIds.has(id);}
    if(words.length&&[...orphanEntries.keys()].some(id=>visible.has(id)))drawer.open=true;else drawer.open=unassignedOpen;
    searchClear.hidden=!query;syncSelection();
  }
  function renderTree() {
    visitMenus(rootRegion,'unregister');rootEntries=new Map();
    const nodes=browse.treeRootIds.map(id=>{const node=treeNode(id,rootEntries);node.className+=' qqj-window-top-level';return node;});
    rootRegion.hidden=!nodes.length;rootRegion.replaceChildren(...nodes);visitMenus(rootRegion,'register');
  }
  function renderNavigation() {
    const trail=el('div','qqj-window-breadcrumbs');
    for(const id of browse.trail){const node=byId.get(id);trail.append(button('qqj-window-scope-link',node.displayName,()=>selectScope(id)));}
    const actions=el('div','qqj-window-navigation-actions');if(browse.scopeId&&dialog?.custom&&runtime.savePlace)actions.append(placeOperationMenu(byId.get(browse.scopeId)));
    visitMenus(navigation,'unregister');navigation.replaceChildren(trail,actions);navigation.hidden=!trail.children.length&&!actions.children.length;visitMenus(navigation,'register');
  }
  function renderData() {
    byId=new Map((snapshot.places??[]).map(node=>[node.entityId,node]));
    sheets=sheetProjection;if(!sheets.sheets.some(sheet=>sheet.id===activeSheetId)){activeSheetId=sheets.defaultSheetId;browseScopeId=undefined;}
    sheetSnapshot=snapshotForCitySheet(snapshot,sheets,activeSheetId);const unassigned=snapshotForCitySheet(snapshot,sheets,null),drawerIds=[...new Set([...(sheetSnapshot.unassignedPlaceIds??[]),...(unassigned.unassignedPlaceIds??[])])];
    displayById=new Map([...sheetSnapshot.places,...unassigned.places].map(node=>[node.entityId,node]));
    browse=browseFor(browseScopeId);mapBrowse=browseFor(undefined);
    if(currentSheet()?.rootPlaceId&&!browse.treeRootIds.length)browse={...browse,treeRootIds:[currentSheet().rootPlaceId]};
    renderSheets();drawBasemap();
    renderNavigation();
    const user=snapshot.userPosition,userAnchor=userMapAnchor();
    const nextMarkerKey=JSON.stringify([activeSheetId,currentSheet()?.assetId??basemap,mapBrowse.groups.map(group=>[group.entityId,byId.get(group.entityId)?.displayName,group.siteIds.map(id=>[id,byId.get(id)?.displayName])]),[userAnchor,Boolean(userAnchor&&user?.isCurrent)]]);
    if(nextMarkerKey!==markerKey){
      closeUserAvatar(true);userAvatar=null;
      markerKey=nextMarkerKey;markers=new Map();visitMenus(areas,'unregister');areas.replaceChildren();points.replaceChildren();
      const real=CITY_MAPS[currentSheet()?.assetId],layout=real?citySchematicLayout(real.id,mapBrowse.groups):qianchuangMapLayout(basemap,mapBrowse.groups,byId);
      regions.innerHTML=`<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${layout.filter(region=>region.contour).map(region=>`<path class="qqj-window-region-outline" d="${region.contours.map(ring=>`M${ring.map(point=>point.join(',')).join('L')}Z`).join('')}" fill-rule="evenodd"/>`).join('')}</svg>`;
      for(const region of layout){
        if(region.entityId&&region.labelBox){
          const node=byId.get(region.entityId),label=button('qqj-window-area-open',node.displayName,()=>selectScope(region.entityId)),safe=region.labelBox;
          const x=safe.x+safe.w/2,y=safe.y+safe.h/2,align=x<30?'start':x>70?'end':'center';
          const available=align==='start'?100-x:align==='end'?x:2*Math.min(x,100-x);
          label.setAttribute('data-scope-id',region.entityId);label.setAttribute('data-label-align',align);label.setAttribute('title',node.displayName);
          label.style.left=`${x}%`;label.style.top=`clamp(calc(.7em + 3px),${y}%,calc(100% - .7em - 3px))`;
          label.style.setProperty('--qqj-window-area-width',`${available}cqw`);areas.append(label);
        }
        for(const {id,x,y} of region.points){
          const marker=button('qqj-window-marker','',()=>{const current=snapshot.userPosition;if(userMapAnchor()===id){if(userAvatar?.marker!==marker||!userAvatar.open)selectRoot(current.placeEntityId);toggleUserAvatar(marker);}else selectRoot(id);});
          marker.setAttribute('aria-label',byId.get(id).displayName);marker.setAttribute('data-place-id',id);marker.setAttribute('data-label-align',x<30?'start':x>70?'end':'center');marker.setAttribute('data-label-above',String(y>70));marker.style.left=`${x}%`;marker.style.top=`${y}%`;const isUser=userAnchor===id,symbol=el('span',isUser?'qqj-window-current-pin':'qqj-window-dot');if(isUser){const label=userPositionLabel();marker.setAttribute('data-user-position',user.isCurrent?'current':'last');marker.setAttribute('aria-expanded','false');marker.setAttribute('aria-label',`${label}，展开用户头像`);marker.style.setProperty('--qqj-window-user-label-width',`${x<30?100-x:x>70?x:2*Math.min(x,100-x)}cqw`);symbol.innerHTML=qianchuangIcon('place');symbol.setAttribute('role','img');symbol.setAttribute('aria-label',label);symbol.setAttribute('title',label);}marker.append(symbol,el('span','qqj-window-marker-label',isUser?userPositionLabel():byId.get(id).displayName));points.append(marker);markers.set(id,marker);
        }
      }
      map.classList?.toggle?.('empty',!mapBrowse.pinIds.length);if(!mapBrowse.pinIds.length)points.append(el('p','qqj-window-map-empty',snapshot.places.length?'暂无场地点位，可浏览下方地点资料。':'尚无已记录地点。'));
    }
    if(userAnchor){
      const marker=markers.get(userAnchor),label=userPositionLabel();
      // A new room in the same visible site reuses its marker and open avatar.
      if(marker){marker.children[1].textContent=label;marker.children[0].setAttribute('aria-label',label);marker.children[0].setAttribute('title',label);marker.setAttribute('aria-label',`${label}，${marker.getAttribute('data-avatar-open')==='true'?'收起':'展开'}用户头像`);}
    }
    const nextPositionKey=JSON.stringify([user,byId.get(user?.placeEntityId)?.displayName]);
    if(nextPositionKey!==positionKey){positionKey=nextPositionKey;position.replaceChildren();
      if(user?.placeEntityId&&byId.has(user.placeEntityId)&&user.status!=='leftUnknown')position.append(button('qqj-window-position',userPositionLabel(),()=>locate(snapshot.userPosition?.placeEntityId)));
      if(user?.status==='leftUnknown')position.append(el('p','settings-hint','已离开，去向未知。'));position.hidden=!position.children.length;
    }
    renderTree();orphanEntries=new Map();
    drawer.hidden=!drawerIds.length;drawer.open=unassignedOpen;drawerHead.textContent=`未归属地点（${drawerIds.length}）`;
    visitMenus(directory,'unregister');directory.replaceChildren(...drawerIds.map(id=>treeNode(id,orphanEntries)));filterTree();
  }
  function update() {
    if(!container)return;
    const base=runtime.getQianchuangSnapshot();resetChat(base.chatId ?? null);
    const nextCatalogRevision=qianchuangMapCatalogRevision();
    if(catalogRevision!==nextCatalogRevision){
      catalogRevision=nextCatalogRevision;sheetProjectionSource=null;basemapGeometry=null;assetDrawKey=null;markerKey=null;renderedRevision=null;
    }
    if(!sheetProjectionSource||sheetProjectionSource.chatId!==base.chatId||sheetProjectionSource.projectionRevision!==base.projectionRevision
      ||sheetProjectionSource.places!==base.places||sheetProjectionSource.mapRootIds!==base.mapRootIds||sheetProjectionSource.userPosition!==base.userPosition){
      sheetProjectionSource=base;sheetProjection=projectQianchuangSheets(base);
    }
    const chosen=settings?.get?.()?.qianchuangBasemaps?.[chatId],projection=sheetProjection,sheet=projection.sheets.find(sheet=>sheet.id===activeSheetId)??projection.sheets.find(sheet=>sheet.id===projection.defaultSheetId),hint=base.places.find(place=>place.entityId===sheet?.rootPlaceId),automatic=hint?.mapStyle?selectQianchuangMapAsset({entityId:hint.entityId,style:hint.mapStyle,layout:hint.mapLayout,previousAssetId:sheet?.mapAssetId}):QIANCHUANG_MAP_ASSETS[sheet?.mapAssetId]?.id;
    const selectedBasemap=QIANCHUANG_BASEMAPS[chosen]||QIANCHUANG_MAP_ASSETS[chosen]?chosen:(QIANCHUANG_MAP_ASSETS[automatic]?automatic:null)??(QIANCHUANG_BASEMAPS[base.mapStyle]?base.mapStyle:qianchuangMapCandidates(hint?.mapStyle??base.mapStyle)[0]?.id??'modern');
    const nextBasemap=legacyBasemapAssets[selectedBasemap]??selectedBasemap;
    const styleChanged=basemap!==nextBasemap;basemap=nextBasemap;
    const needsRender=styleChanged||renderedRevision!==base.projectionRevision;
    snapshot=base;
    if(needsRender){renderedRevision=base.projectionRevision;renderData();}
    const status=failure?'error':preparing?'loading':snapshot.status;
    health.className=`qqj-page-health ${['error','needsReview'].includes(status)?'error':status==='ready'||status==='empty'?'healthy':'checking'}`;
    const copy=failure ?? snapshot.error ?? (status==='disabled'?'千千结已关闭':status==='loading'?'正在读取地点资料':status==='ready'?`${snapshot.places.length} 处地点 · 当前范围 ${browse?.pinIds.length??0} 处场地`:status==='empty'?'尚无地点，可点“初始化”补入世界书地点，或继续对话记录。':'当前聊天尚无地点资料。');
    health.textContent=copy;
  }
  function mount(target) {
    closeUserAvatar(true);userAvatar=null;operationMenus.deactivate();container=target;page=el('section','qqj-window-page');health=el('div','qqj-page-health');toolbar=el('div','qqj-window-toolbar');navigation=el('div','qqj-window-navigation');
    const searchRow=el('div','qqj-history-search');search=el('input','settings-input qqj-history-search-input');search.type='search';search.value=query;search.placeholder='搜索地点、描述或层级';search.setAttribute('aria-label',search.placeholder);
    searchClear=button('secondary-action qqj-history-search-clear','清除',()=>{selectScope(undefined);search.focus?.({preventScroll:true});});searchClear.hidden=!query;
    search.addEventListener('input',()=>{query=search.value;highlightedMapRootId=null;localSelections.clear();openIds.clear();const scope=browseFor(undefined).scopeId;if(browse?.scopeId!==scope){browseScopeId=undefined;renderData();update();}else filterTree();});searchRow.append(search,searchClear);
    position=el('div','qqj-window-user-position');const actions=el('div','qqj-window-toolbar-actions');toolbar.append(position,actions);page.addEventListener('click',clearOnBlank);page.addEventListener('keydown',event=>{if(event.key==='Escape'&&userAvatar?.open){event.preventDefault?.();event.stopPropagation?.();closeUserAvatar(false,true);}});
    if(runtime.organizePlaces&&dialog?.confirm){
      const syncActions=()=>{for(const [mode,node]of [['initialize',initializeAction],['organize',organizeAction]])if(node){const label=mode==='initialize'?'初始化':'整理';node.textContent=organizationController&&organizationMode===mode?`取消${label}`:label;node.disabled=Boolean(organizationController&&organizationMode!==mode);}};
      const action=mode=>async()=>{
        if(organizationController){if(organizationMode===mode)organizationController.abort();return;}
        const label=mode==='initialize'?'初始化':'整理',controller=new AbortController();organizationController=controller;organizationMode=mode;syncActions();
        try{
          const body=mode==='initialize'?'通读当前允许读取的世界书，补入尚未登记的地点与明确层级。调用一次摘要模型，保留已有剧情变化、人工修订和删除。可重复使用。':'根据已有地点及其已保存来源，合并同一地点的别名和重复资料，校对归属、简介、设施与底图。可补明确缺失上级。调用一次摘要模型，保留人工修订。';
          if(!await dialog.confirm({title:`${label}地点`,body,confirmText:label,cancelText:'取消'})||controller.signal.aborted)return;
          const result=await runtime.organizePlaces({mode,signal:controller.signal});
          if(result?.status==='skipped'&&['no-worldbook','no-places'].includes(result.reason))await dialog.info?.({title:`${label}地点`,body:result.reason==='no-worldbook'?'当前没有允许读取的世界书。':'当前没有可整理的地点。可先初始化或继续对话记录。'});
        }catch(error){if(error?.name!=='AbortError')await dialog.info?.({title:`${label}失败`,body:publicErrorMessage(error,{fallback:`地点${label}失败，原资料已保留。`})});}
        finally{if(organizationController===controller){organizationController=null;organizationMode=null;}syncActions();}
      };
      initializeAction=button('secondary-action compact qqj-window-initialize','初始化',action('initialize'));initializeAction.setAttribute('data-place-initialize','');initializeAction.setAttribute('title','从允许的世界书补充尚未登记地点，保留现有资料');
      organizeAction=button('secondary-action compact qqj-window-organize','整理',action('organize'));organizeAction.setAttribute('data-place-organize','');organizeAction.setAttribute('title','整理已有地点及其已保存来源，补齐明确缺失上级');
      actions.append(initializeAction,organizeAction);syncActions();
    }
    if(dialog?.custom&&runtime.createPlace){const add=button('secondary-action compact qqj-window-add','新增',()=>openPlaceEditor());add.setAttribute('data-place-create','');actions.append(add);}
    map=el('div','qqj-window-map');regions=el('div','qqj-window-regions');areas=el('div','qqj-window-areas');points=el('div','qqj-window-points');copyright=el('small','qqj-window-copyright');contents=el('div','qqj-window-contents');
    markerKey=null;positionKey=null;assetDrawKey=null;rootRegion=el('section','qqj-window-active-place');drawer=el('details','qqj-window-unassigned');drawerHead=el('summary','qqj-window-unassigned-summary');directory=el('div','qqj-window-directory');drawerHead.addEventListener('click',()=>{unassignedOpen=!drawer.open;});drawer.addEventListener('toggle',()=>{unassignedOpen=drawer.open;});drawer.append(drawerHead,directory);contents.append(rootRegion,drawer);
    mapGroup=el('div','qqj-window-map-group');const viewport=el('div','qqj-window-map-viewport');viewport.append(map);mapGroup.append(viewport,copyright);
    sheetRow=el('div','qqj-window-sheet-row');page.append(health,searchRow,toolbar,sheetRow,mapGroup,navigation,contents);container.replaceChildren(page);renderedRevision=null;update();
  }
  async function activate() {
    if(active){update();return {status:snapshot.status};}active=true;visitMenus(page,'register');operationMenus.activate();const mine=++epoch;
    unsubscribe=runtime.subscribe(()=>{if(active)update();});
    unsubscribeCatalog=subscribeQianchuangMapCatalog(()=>{if(active){renderedRevision=null;sheetProjectionSource=null;basemapGeometry=null;assetDrawKey=null;markerKey=null;update();}});preparing=true;failure=null;update();
    try{
      const session=sessionStateProvider?.();
      if(session?.status==='error')throw session.error;
      if(['idle','preparing'].includes(session?.status)&&prepareSession){const result=await prepareSession();if(!active||mine!==epoch)return {status:'stale'};if(result?.status!=='ready')return result;}
      if(!active||mine!==epoch)return {status:'stale'};
      if(!snapshot.chatId&&!sessionStateProvider)return {status:'empty'};
      const result=await runtime.prepareCurrent({preferCached:true});if(!active||mine!==epoch)return {status:'stale'};update();return result;
    }catch(error){if(active&&mine===epoch)failure=publicErrorMessage(error,{fallback:'地点资料暂时无法读取，请重试。'});return {status:'error'};}
    finally{if(active&&mine===epoch){preparing=false;update();}}
  }
  function deactivate(){closeUserAvatar(true);if(sheetSwitcher)sheetScrollLeft=Number(sheetSwitcher.scrollLeft)||0;sheetSwitcher=null;operationMenus.deactivate();active=false;epoch++;unsubscribe?.();unsubscribe=null;unsubscribeCatalog?.();unsubscribeCatalog=null;}
  return Object.freeze({mount,activate,deactivate});
}
