import test from'node:test';import assert from'node:assert/strict';
import {QIANCHUANG_MAP_ASSETS,qianchuangMapCandidates,selectQianchuangMapAsset}from'../src/qianchuang-map-assets.js';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createGenericMapLoader} from '../src/ui/qianchuang-map-loader.js';
import {QIANCHUANG_MAP_STYLES,normalizeQianchuangMapLayout,normalizeQianchuangMapStyle,validQianchuangMapLayout} from '../src/qianchuang-display-hints.js';
const realTemplateIds=['modern-coast','modern-radial','modern-town-plain','modern-town-river','modern-town-coast','old-town-inland','old-town-river','old-town-coast','old-town-plain','terrain-forest','terrain-coast','terrain-mountain','terrain-coast-relief','terrain-desert','terrain-snow','palace-axial','palace-courtyard-garden'];

test('真实片区保留人居路网与来源，SVG样式只作用于千窗根',()=>{
 const sources=new Map(JSON.parse(readFileSync(new URL('../assets/maps-library/sources.json',import.meta.url),'utf8')).map(row=>[row.id,row]));
 for(const id of realTemplateIds){
  const asset=QIANCHUANG_MAP_ASSETS[id],source=sources.get(id),svg=readFileSync(new URL('../assets/maps-library/'+asset.file,import.meta.url),'utf8');
  assert.match(String(source.license),/ODbL/u,id);assert.match(source.sourceSha256,/^[a-f0-9]{64}$/u,id);assert.match(svg,/OpenStreetMap contributors/u,id);
  assert.match(svg,/class="map-building"/u,id);assert.match(svg,/class="map-road-/u,id);assert.match(svg,/var\(--ql-water\)/u,id);
  assert.doesNotMatch(svg,/<(?:linearGradient|radialGradient|image|script)\b|href="https?:/u,id);
  const style=svg.match(/<style>([\s\S]*?)<\/style>/u)?.[1];assert.ok(style,id);
  for(const match of style.matchAll(/([^{}]+)\{/gu))for(const selector of match[1].split(','))assert.ok(selector.trim().startsWith('.qqj-generic-basemap '),id+' '+selector);
 }
});
test('本地SVG根可直接插入HTML并保SVG命名空间',()=>{
 for(const asset of Object.values(QIANCHUANG_MAP_ASSETS)){
  const svg=readFileSync(new URL('../assets/maps-library/'+asset.file,import.meta.url),'utf8');
  assert.match(svg,/^<svg\s/u,asset.id);assert.doesNotMatch(svg,/<\/?(?:ns\d+|svg):(?:svg|g|path|use)\b/u,asset.id);
 }
});
test('现成源素材可用，既有兼容ID优先，未采用手绘草稿',()=>{
 assert.equal(Object.keys(QIANCHUANG_MAP_ASSETS).length,24);assert.equal(qianchuangMapCandidates('terrain').length,6);
 const first=selectQianchuangMapAsset({entityId:'arbitrary-a',style:'modern'});
 assert.equal(selectQianchuangMapAsset({entityId:'renamed-or-reordered',style:'modern',previousAssetId:first}),first);assert.equal(selectQianchuangMapAsset({entityId:'arbitrary-a',style:'terrain',layout:'snow',previousAssetId:first}),'terrain-snow');assert.ok(qianchuangMapCandidates('town').every(asset=>asset.family==='old-town'));
});
test('异星环境共用真实地表源，缺专属素材也不退成科幻设施',()=>{
 for(const layout of ['organic','rocky']){
  const id=selectQianchuangMapAsset({entityId:'unnamed-independent-world',style:'alien',layout,previousAssetId:'sci-fi-linear'});
  assert.equal(QIANCHUANG_MAP_ASSETS[id].family,'terrain');assert.ok(qianchuangMapCandidates('alien',layout).length);
  assert.equal(selectQianchuangMapAsset({entityId:'rename',style:'alien',layout,previousAssetId:id}),id);
 }
 assert.ok(qianchuangMapCandidates('terrain','forest-river').every(asset=>asset.layout==='forest'));
 assert.ok(qianchuangMapCandidates('terrain','grassland').every(asset=>asset.family==='terrain'));
});

test('舰内方形取景保稳定ID、来源和等比显示',()=>{
 const asset=QIANCHUANG_MAP_ASSETS['sci-fi-linear'];assert.equal(asset.width,1120);assert.equal(asset.height,1120);
 const svg=readFileSync(new URL('../assets/maps-library/'+asset.file,import.meta.url),'utf8');assert.match(svg,/Robert Pearce \/ Eric B\. Smith/u);assert.match(svg,/mask id="deck-water"/u);assert.doesNotMatch(svg,/<foreignObject|<script|href="https?:/u);
 assert.equal(selectQianchuangMapAsset({entityId:'arbitrary-facility',style:'sci-fi',layout:'ring',previousAssetId:asset.id}),asset.id);
});

test('184新甲板按当前文件SHA单次读取，几何不进入主模块',async()=>{
 const asset=QIANCHUANG_MAP_ASSETS['sci-fi-linear'],svg=readFileSync(new URL('../assets/maps-library/'+asset.file,import.meta.url),'utf8'),calls=[];assert.equal(createHash('sha256').update(svg).digest('hex'),asset.sha256);
 const load=createGenericMapLoader({moduleUrl:'https://offline.invalid/plugin/dist/qqj-app.js',fetchImpl:async url=>{calls.push(url);return{ok:true,text:async()=>svg};}});
 const[a,b]=await Promise.all([load(asset.id),load(asset.id)]);assert.equal(a,svg);assert.equal(b,svg);assert.deepEqual(calls,['https://offline.invalid/plugin/assets/maps-library/'+asset.file+'?v='+asset.sha256.slice(0,16)]);
 const source=readFileSync(new URL('../src/qianchuang-map-assets.js',import.meta.url),'utf8');assert.doesNotMatch(source,/data:image\/png;base64/u);
});

 test('187新增布局按题材与地貌选择，已有选图保持且静态短标签可索引',()=>{
 assert.equal(qianchuangMapCandidates('modern').length,3);assert.equal(qianchuangMapCandidates('modern-town').length,3);assert.equal(qianchuangMapCandidates('old-town').length,4);
 assert.deepEqual(qianchuangMapCandidates('old-town','coast').map(a=>a.id),['old-town-coast']);assert.deepEqual(qianchuangMapCandidates('modern-town','coast').map(a=>a.id),['modern-town-coast']);
 assert.equal(selectQianchuangMapAsset({entityId:'arbitrary-renamed-root',style:'modern',layout:'inland',previousAssetId:'modern-inland'}),'modern-inland');
 for(const asset of Object.values(QIANCHUANG_MAP_ASSETS)){assert.ok(asset.shortTags.length>1,asset.id);assert.equal(new Set(asset.shortTags).size,asset.shortTags.length,asset.id);}
 });

 test('宫苑与舰图继续可选，既有选择保持',()=>{
 const expected={'sci-fi-ring-life':'16b53652141e4369e8bb724289cfcc58833ca5830ac1292475ff8c96b5043b96'};
 for(const[id,sha]of Object.entries(expected)){const asset=QIANCHUANG_MAP_ASSETS[id];assert.ok(asset,id);assert.equal(asset.sha256,sha);assert.equal(createHash('sha256').update(readFileSync(new URL('../assets/maps-library/'+asset.file,import.meta.url))).digest('hex'),sha);}
 assert.deepEqual(qianchuangMapCandidates('palace','courtyard').map(a=>a.id),['palace-courtyard-garden']);assert.deepEqual(qianchuangMapCandidates('sci-fi','ring').map(a=>a.id),['sci-fi-ring-life']);
 for(const[style,layout,previous]of[['palace','courtyard','palace-axial'],['sci-fi','ring','sci-fi-linear']])assert.equal(selectQianchuangMapAsset({entityId:'existing-root',style,layout,previousAssetId:previous}),previous);
 });


test('本丸专用语义布局唯一命中，普通宫苑不随机混入，省略提示保已有选择',()=>{
 const id='palace-courtyard-honmaru';assert.deepEqual(qianchuangMapCandidates('palace','honmaru').map(a=>a.id),[id]);
 assert.deepEqual(qianchuangMapCandidates('palace','courtyard').map(a=>a.id),['palace-courtyard-garden']);
 assert.equal(qianchuangMapCandidates('palace').some(a=>a.id===id),false);assert.equal(qianchuangMapCandidates('palace','unknown').some(a=>a.id===id),false);
 assert.equal(selectQianchuangMapAsset({entityId:'scope',style:'palace',layout:'honmaru'}),id);assert.equal(selectQianchuangMapAsset({entityId:'renamed',style:'palace',previousAssetId:id}),id);
 const asset=QIANCHUANG_MAP_ASSETS[id];assert.ok(asset.anchors.all.length>=24);assert.ok(asset.anchors.layouts[5].every(pool=>pool.length>=3));
 assert.equal(createHash('sha256').update(readFileSync(new URL('../assets/maps-library/'+asset.file,import.meta.url))).digest('hex'),'f87e63d642f65c6a643ea24d0c1bf507d14ce7edf2c49db78e2abb589a32334f');
});

test('校园三布局按实际空间选图且保已验SVG字节与旧图候选',()=>{
 const expected={compact:'9df73cb508142b44c7a4b707a705340f56e51eb952f9a2ac568fb29313a1269d',garden:'1822119617df62f4d3bb282ecec7762548d16f7e13f4e0e9e139d44a36744dd9',university:'39f454986fb30ba515e0ad1a617761e95b986ee46fd8b0ae758f80f0b3cbe2e0'};
 for(const[layout,sha]of Object.entries(expected)){
  const id='campus-'+layout,asset=QIANCHUANG_MAP_ASSETS[id];assert.ok(asset,id);
  assert.deepEqual(qianchuangMapCandidates('campus',layout).map(a=>a.id),[id]);
  assert.equal(selectQianchuangMapAsset({entityId:'independent-campus',style:'campus',layout}),id);
  assert.equal(asset.width,1000);assert.equal(asset.height,1000);assert.equal(asset.sha256,sha);
  assert.equal(createHash('sha256').update(readFileSync(new URL('../assets/maps-library/'+asset.file,import.meta.url))).digest('hex'),sha);
 }
 assert.equal(qianchuangMapCandidates('modern').length,3);assert.equal(qianchuangMapCandidates('modern-town').length,3);
 assert.deepEqual(qianchuangMapCandidates('campus').map(a=>a.id),['campus-compact']);
 assert.deepEqual(qianchuangMapCandidates('campus','unknown').map(a=>a.id),['campus-compact']);
 assert.equal(selectQianchuangMapAsset({entityId:'school-name-is-not-a-router',style:'modern',previousAssetId:'modern-inland'}),'modern-inland');
});

test('校园布局仅在mapLayout内归一明确中英文，不按普通学校或私立身份猜版式',()=>{
 const style=QIANCHUANG_MAP_STYLES.find(row=>row.id==='campus');assert.deepEqual(style.layouts,['compact','garden','university']);
 for(const[layout,values]of Object.entries({compact:['compact',' Compact ','紧凑校园','紧凑校区'],garden:['garden',' GARDEN ','园林校园','园区型校区'],university:['university',' University ','综合大学','综合大学校园']}))for(const value of values){assert.equal(normalizeQianchuangMapLayout(value,'campus'),layout,value);}
 for(const value of ['学校','高中','私立学校','公立学校'])assert.equal(normalizeQianchuangMapLayout(value,'campus'),undefined,value);
 assert.equal(normalizeQianchuangMapLayout('综合大学','modern'),undefined);assert.equal(validQianchuangMapLayout('紧凑校园','campus'),false);
 for(const value of ['campus',' Campus ','校园','校区','学校','school',' SCHOOL '])assert.equal(normalizeQianchuangMapStyle(value),'campus');
 for(const value of ['高中','私立学校'])assert.equal(normalizeQianchuangMapStyle(value),undefined);
});

test('图库全部为原生方形，SVG画幅、元数据和可见点位共用坐标',()=>{
 for(const asset of Object.values(QIANCHUANG_MAP_ASSETS)){
  const svg=readFileSync(new URL('../assets/maps-library/'+asset.file,import.meta.url),'utf8');
  const viewport=svg.match(/<svg\b[^>]*\bviewBox="([^"]+)"/u)[1].split(/\s+/u).map(Number);
  assert.equal(asset.width,asset.height,asset.id);
  assert.equal(viewport[2],viewport[3],asset.id);
  assert.equal(viewport[2],asset.width,asset.id);
  assert.equal(createHash('sha256').update(svg).digest('hex'),asset.sha256,asset.id);
  for(const point of [...asset.anchors.all,...asset.anchors.neutral,...Object.values(asset.anchors.layouts).flat(2)]){
   assert.ok(point.every(value=>value>=0&&value<=100),asset.id+' '+point);
  }
  for(const rows of Object.values(asset.regions.layouts))for(const region of rows){
   assert.ok(region.inset.w>0&&region.inset.h>0,asset.id);
   for(const ring of region.contours)assert.ok(ring.every(point=>point.every(value=>value>=0&&value<=100)),asset.id);
  }
 }
});



test('真实路网与主地形线沿现主题使用非缩放线宽',()=>{
 for(const id of realTemplateIds){
  const svg=readFileSync(new URL('../assets/maps-library/'+QIANCHUANG_MAP_ASSETS[id].file,import.meta.url),'utf8'),style=svg.match(/<style>([\s\S]*?)<\/style>/u)[1];
  const lines=[...style.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].filter(match=>/map-(?:road-|river|ridge)/u.test(match[1]));
  assert.ok(lines.length>0,id);assert.ok(lines.every(match=>match[2].includes('vector-effect:non-scaling-stroke')),id);
  assert.match(style,/var\(--blue\)/u,id);assert.match(style,/var\(--paper\)/u,id);
 }
});
