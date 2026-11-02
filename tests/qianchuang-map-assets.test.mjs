import test from'node:test';import assert from'node:assert/strict';
import {QIANCHUANG_MAP_ASSETS,qianchuangMapCandidates,selectQianchuangMapAsset}from'../src/qianchuang-map-assets.js';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createGenericMapLoader} from '../src/ui/qianchuang-map-loader.js';
test('本地SVG根可直接插入HTML并保SVG命名空间',()=>{
 for(const asset of Object.values(QIANCHUANG_MAP_ASSETS)){
  const svg=readFileSync(new URL('../assets/maps-library/'+asset.file,import.meta.url),'utf8');
  assert.match(svg,/^<svg\s/u,asset.id);assert.doesNotMatch(svg,/<\/?(?:ns\d+|svg):(?:svg|g|path|use)\b/u,asset.id);
 }
});
test('现成源素材可用，既有兼容ID优先，未采用手绘草稿',()=>{
 assert.equal(Object.keys(QIANCHUANG_MAP_ASSETS).length,18);assert.equal(qianchuangMapCandidates('terrain').length,6);
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

test('184舰内裁取保稳定ID且按实际源比例读取',()=>{
 const asset=QIANCHUANG_MAP_ASSETS['sci-fi-linear'];assert.equal(asset.width,1120);assert.equal(asset.height,1280);
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
