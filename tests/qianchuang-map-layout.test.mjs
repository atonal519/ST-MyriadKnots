import {QIANCHUANG_BASEMAPS} from '../src/ui/qianchuang-basemaps.js';
import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {qianchuangMapLayout} from '../src/ui/qianchuang-map-layout.js';
import {QIANCHUANG_MAP_ASSETS} from '../src/qianchuang-map-assets.js';
const inside=([x,y],poly)=>{let result=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const [ax,ay]=poly[i],[bx,by]=poly[j];if((ay>y)!==(by>y)&&x<(bx-ax)*(y-ay)/(by-ay)+ax)result=!result;}return result;};
const inRegion=(p,region)=>(region.contours??[region.contour]).reduce((yes,ring)=>yes!==inside(p,ring),false);
const corners=b=>[[b.x,b.y],[b.x+b.w,b.y],[b.x+b.w,b.y+b.h],[b.x,b.y+b.h]];

for(const layout of ['compact','garden','university'])test(`校园${layout}完整1至5区同坐标，标签/点不越区且增点不重排`,()=>{
 const id='campus-'+layout,asset=QIANCHUANG_MAP_ASSETS[id];assert.ok(asset);
 for(let count=1;count<=5;count++){
  const groups=Array.from({length:count},(_,i)=>({entityId:'area-'+i,siteIds:[i+'-a',i+'-b']}));groups.push({entityId:null,siteIds:['direct-a','direct-b']});
  const before=structuredClone(groups),out=qianchuangMapLayout(id,groups),named=out.filter(r=>r.contour);
  assert.deepEqual(groups,before);assert.equal(named.length,count);
  for(const r of named){for(const p of [...corners(r.inset),...corners(r.labelBox)])assert.ok(inRegion(p,r),`${count} label ${p}`);for(const p of r.points)assert.ok(inRegion([p.x,p.y],r));}
  for(const p of out.at(-1).points)assert.ok(named.every(r=>!inRegion([p.x,p.y],r)));
  const points=out.flatMap(r=>r.points);for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++)assert.ok(Math.max(Math.abs(points[i].x-points[j].x),Math.abs(points[i].y-points[j].y))*2.53>22,`${count} ${points[i].id}/${points[j].id}`);
 }
 const group={entityId:'area',siteIds:Array.from({length:12},(_,i)=>'site-'+i)},a=qianchuangMapLayout(id,[group])[0],b=qianchuangMapLayout(id,[{...group,siteIds:[...group.siteIds,'site-12']}])[0];
 assert.deepEqual(b.points.slice(0,12),a.points);assert.ok(asset.anchors.all.length>=24);
});
for(const basemap of ['modern','town','palace'])for(const count of [1,2,3,4,5])test(`${basemap} ${count}区：合并现有街区，整个label框与所属点在本区，direct在区外`,()=>{
 const groups=Array.from({length:count},(_,i)=>({entityId:`area-${i}`,siteIds:Array.from({length:i%4},(_,j)=>`site-${i}-${j}`)}));groups.push({entityId:null,siteIds:['direct-a','direct-b']});
 const before=structuredClone(groups),regions=qianchuangMapLayout(basemap,groups),named=regions.filter(r=>r.entityId);
 assert.equal(named.length,count);assert.deepEqual(regions.map(r=>r.entityId),groups.map(g=>g.entityId));assert.deepEqual(groups,before);
 for(const r of named){if(!r.contours?.length){assert.ok(named.every(region=>!region.points.length),'只允许全空area不占画面分区');assert.equal(r.contour,null);assert.ok(r.labelBox);continue;}assert.ok(r.contours.length,'静态原路轮廓包含全部rings');for(const p of corners(r.labelBox))assert.ok(inRegion(p,r),`${r.entityId} label ${p}`);for(const p of r.points)assert.ok(inRegion([p.x,p.y],r));}
 for(const p of regions.at(-1).points)assert.ok(named.every(r=>!inRegion([p.x,p.y],r)));
 for(let x=3.71;x<97;x+=3.31)for(let y=3.43;y<97;y+=3.73)assert.ok(named.filter(r=>inRegion([x,y],r)).length<=1);
 assert.deepEqual(qianchuangMapLayout(basemap,groups),regions);
});
test('现代与小城外缘取真实画面边缘，取消内缩矩形框',()=>{
 const groups=Array.from({length:5},(_,i)=>({entityId:`area-${i}`,siteIds:[]}));
 for(const key of ['modern','town'])assert.ok(qianchuangMapLayout(key,groups).some(r=>r.contours?.some(c=>c.some(([x,y])=>x===0||x===100||y===0||y===100))));
});
test('当前5区11点在窄图可逐点命中，44px按钮不盖住相邻点中心',()=>{
 const groups=[4,3,1,0,1].map((count,i)=>({entityId:`area-${i}`,siteIds:Array.from({length:count},(_,j)=>`site-${i}-${j}`)}));groups.push({entityId:null,siteIds:['direct-a','direct-b']});
 for(const basemap of ['modern','town','palace']){const points=qianchuangMapLayout(basemap,groups).flatMap(r=>r.points),width=basemap==='modern'?253:354,aspect=1;for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++)assert.ok(Math.abs(points[i].x-points[j].x)*width/100>22||Math.abs(points[i].y-points[j].y)*width/100/aspect>22,`${basemap} ${points[i].id}/${points[j].id}`);}
});
test('全是direct地点时不画空区域，保留所有场地',()=>{const [r]=qianchuangMapLayout('modern',[{entityId:null,siteIds:Array.from({length:12},(_,i)=>`site-${i}`)}]);assert.equal(r.contour,null);assert.equal(r.labelBox,null);assert.equal(r.points.length,12);});

test('地区超过地图五区上限时保留每个group及全部点，不扩新边界',()=>{
 const groups=Array.from({length:7},(_,i)=>({entityId:`area-${i}`,siteIds:[`site-${i}`]})),before=structuredClone(groups),regions=qianchuangMapLayout('modern',groups);
 assert.equal(regions.filter(r=>r.labelBox).length,5);assert.deepEqual(regions.map(r=>r.entityId),groups.map(g=>g.entityId));assert.deepEqual(regions.flatMap(r=>r.points.map(p=>p.id)),groups.flatMap(g=>g.siteIds));assert.deepEqual(groups,before);
});

test('当前现代建筑落点分散且追加地点保已有预置位置，区域轮廓与区名框保持稳定',()=>{
 const groups=[4,3,1,0,1].map((count,i)=>({entityId:`area-${i}`,siteIds:Array.from({length:count},(_,j)=>`site-${i}-${j}`)}));
 const before=qianchuangMapLayout('modern',groups),expanded=qianchuangMapLayout('modern',groups.map((g,i)=>i?g:{...g,siteIds:[...g.siteIds,'added']}));
 assert.ok(new Set(before[0].points.map(p=>p.y)).size>1,'地点不再集中成一排');assert.ok(new Set(before[0].points.map(p=>p.x)).size>2);
 assert.deepEqual(expanded[0].points.slice(0,4),before[0].points);assert.deepEqual(expanded.map(r=>r.contours),before.map(r=>r.contours));assert.deepEqual(expanded.map(r=>r.labelBox),before.map(r=>r.labelBox));
});
test('无具名区也使用分散的全图POI落点',()=>{
 for(const key of ['modern','town','palace']){const [r]=qianchuangMapLayout(key,[{entityId:null,siteIds:['a','b','c','d']}]);for(const axis of ['x','y'])assert.ok(Math.max(...r.points.map(p=>p[axis]))-Math.min(...r.points.map(p=>p[axis]))>=25,key+' '+axis);for(let i=0;i<r.points.length;i++)for(let j=i+1;j<r.points.length;j++)assert.ok(Math.max(Math.abs(r.points[i].x-r.points[j].x),Math.abs(r.points[i].y-r.points[j].y))>=8.7,key);}
});
test('合并为一个大区仍有足够预选落点，12增至13处场地保原落点',()=>{
 for(const key of ['modern','town','palace']){const group={entityId:'area',siteIds:Array.from({length:12},(_,i)=>`site-${i}`)},a=qianchuangMapLayout(key,[group])[0],b=qianchuangMapLayout(key,[{...group,siteIds:[...group.siteIds,'added']}])[0];assert.deepEqual(b.points.slice(0,12),a.points,key);}
});

test('4具名区加4未定场地借既有完整face，点不落named且253px可命中',()=>{
 const groups=[1,3,1,1].map((count,i)=>({entityId:`area-${i}`,siteIds:Array.from({length:count},(_,j)=>`site-${i}-${j}`)}));groups.push({entityId:null,siteIds:['d1','d2','d3','d4']});
 for(const key of ['modern','town','palace']){const result=qianchuangMapLayout(key,groups),named=result.filter(r=>r.contour),direct=result.at(-1).points;assert.equal(named.length,4);assert.ok(new Set(direct.map(p=>p.x)).size>2,'散点不再挤边缘单列');for(const p of direct)assert.ok(named.every(r=>!inRegion([p.x,p.y],r)));for(let i=0;i<direct.length;i++)for(let j=i+1;j<direct.length;j++)assert.ok(Math.abs(direct[i].x-direct[j].x)*2.53>22||Math.abs(direct[i].y-direct[j].y)*2.53/(1)>22);}
});

test('五具名区加两direct保留未改图基线，旧town沿登记素材分配',()=>{const hashes={"modern":"ce2ae3a7ba00eaf44dccc5389841b27650eccba90521d05e4505cebfe92059ce","palace":"1bbb70a33c282af8933024b40220509a29362e4e227ed4ac205122efe9f75782"};const groups=[4,3,1,0,1].map((n,i)=>({entityId:`area-${i}`,siteIds:Array.from({length:n},(_,j)=>`site-${i}-${j}`)}));groups.push({entityId:null,siteIds:['d1','d2']});for(const key of Object.keys(hashes))assert.equal(createHash('sha256').update(JSON.stringify(qianchuangMapLayout(key,groups))).digest('hex'),hashes[key]);assert.deepEqual(qianchuangMapLayout('town',groups),qianchuangMapLayout('old-town-inland',groups));});
test('借face后按点数匹配named容量，Fox全部10点在253px不互盖中心',()=>{
 const groups=[1,3,1,1].map((n,i)=>({entityId:`area-${i}`,siteIds:Array.from({length:n},(_,j)=>`site-${i}-${j}`)}));groups.push({entityId:null,siteIds:['d1','d2','d3','d4']});for(const key of ['modern','town','palace']){const result=qianchuangMapLayout(key,groups),points=result.flatMap(r=>r.points);assert.deepEqual(result.map(r=>r.entityId),groups.map(g=>g.entityId));for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++)assert.ok(Math.abs(points[i].x-points[j].x)*2.53>22||Math.abs(points[i].y-points[j].y)*2.53/(1)>22,`${key} ${points[i].id}/${points[j].id}`);}
});

for(const key of ['modern-town','old-town','sci-fi'])test(`${key}有独立底图和完整静态分区落点，增点保预置位置`,()=>{
 const asset=QIANCHUANG_BASEMAPS[key];assert.ok(asset,key);assert.equal(asset.width,1000);assert.equal(asset.height,1000);
 for(let n=1;n<=5;n++){
  const groups=Array.from({length:n},(_,i)=>({entityId:'area-'+i,siteIds:Array.from({length:i?2:4},(_,j)=>i+'-'+j)}));groups.push({entityId:null,siteIds:['d1','d2']});
  const regions=qianchuangMapLayout(key,groups),named=regions.filter(r=>r.contour);assert.equal(named.length,n);for(const r of named){for(const point of [...corners(r.labelBox),...corners(r.inset)])assert.ok(inRegion(point,r));for(const point of r.points)assert.ok(inRegion([point.x,point.y],r));}for(const point of regions.at(-1).points)assert.ok(named.every(r=>!inRegion([point.x,point.y],r)));
  for(let x=2.7;x<98;x+=4.3)for(let y=3.1;y<98;y+=4.1)assert.ok(named.filter(r=>inRegion([x,y],r)).length<=1);
 }
 const group={entityId:'area',siteIds:Array.from({length:12},(_,i)=>'s'+i)},a=qianchuangMapLayout(key,[group])[0],b=qianchuangMapLayout(key,[{...group,siteIds:[...group.siteIds,'added']}])[0];assert.deepEqual(b.points.slice(0,12),a.points);assert.equal(new Set(a.points.map(p=>p.x+','+p.y)).size,12);
});

test('三张新图的常见11点在253px地图可自然点击，热区不盖邻点中心',()=>{
 const groups=[4,3,1,0,1].map((n,i)=>({entityId:'area-'+i,siteIds:Array.from({length:n},(_,j)=>i+'-'+j)}));groups.push({entityId:null,siteIds:['d1','d2']});for(const key of ['modern-town','old-town','sci-fi']){const points=qianchuangMapLayout(key,groups).flatMap(r=>r.points);for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++)assert.ok(Math.max(Math.abs(points[i].x-points[j].x),Math.abs(points[i].y-points[j].y))*2.53>22,key+' '+points[i].id+'/'+points[j].id);}
});

test('三张新图地区文字中心保留可点击热区，不被本区或邻区44px地点按钮覆盖',()=>{
 for(const key of ['modern-town','old-town','sci-fi'])for(let count=1;count<=5;count++){const groups=Array.from({length:count},(_,i)=>({entityId:'a'+i,siteIds:[i+'-1',i+'-2']}));groups.push({entityId:null,siteIds:['d1','d2']});const regions=qianchuangMapLayout(key,groups),points=regions.flatMap(r=>r.points);for(const region of regions.filter(r=>r.labelBox)){const b=region.labelBox,cx=b.x+b.w/2,cy=b.y+b.h/2;for(const p of points)assert.ok(Math.max(Math.abs(p.x-cx),Math.abs(p.y-cy))*2.53>22,`${key} ${count} ${region.entityId} label/${p.id}`);}}
});

test('184甲板1至5区的实际点与标签沿同一静态舱区，公共点保区外',()=>{
 for(let n=1;n<=5;n++){
  const groups=Array.from({length:n},(_,i)=>({entityId:`area-${i}`,siteIds:Array.from({length:3},(_,j)=>`site-${i}-${j}`)}));groups.push({entityId:null,siteIds:['d1','d2','d3']});
  const regions=qianchuangMapLayout('sci-fi-linear',groups),named=regions.filter(r=>r.contour),points=regions.flatMap(r=>r.points);assert.equal(named.length,n);
  for(const r of named){for(const p of [...corners(r.inset),...corners(r.labelBox)])assert.ok(inRegion(p,r));for(const p of r.points)assert.ok(inRegion([p.x,p.y],r));const b=r.labelBox;for(const p of points)assert.ok(Math.hypot((p.x-b.x-b.w/2)*2.53,(p.y-b.y-b.h/2)*2.53)>22);}
  for(const p of regions.at(-1).points)assert.ok(named.every(r=>!inRegion([p.x,p.y],r)));
 }
});

test('184甲板16场地在253px保持自然点选空间及已有槽位',()=>{
 const counts=[10,0,1,2],groups=counts.map((count,i)=>({entityId:`area-${i}`,siteIds:Array.from({length:count},(_,j)=>`site-${i}-${j}`)}));groups.push({entityId:null,siteIds:['direct-a','direct-b','direct-c']});
 const regions=qianchuangMapLayout('sci-fi-linear',groups),points=regions.flatMap(r=>r.points);assert.equal(points.length,16);
 for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++)assert.ok(Math.hypot((points[i].x-points[j].x)*2.53,(points[i].y-points[j].y)*2.53)>22);
 const before=qianchuangMapLayout('sci-fi-linear',[{entityId:'area',siteIds:['a','b','c']}])[0],after=qianchuangMapLayout('sci-fi-linear',[{entityId:'area',siteIds:['a','b','c','d']}])[0];assert.deepEqual(after.points.slice(0,3),before.points);
});

test('空area与直属场地共存时空标签不抢分区，直属点沿全图安全池稳定分散',()=>{
 for(const basemap of ['campus-compact','campus-garden','campus-university','modern-radial','palace-courtyard-honmaru']){
  const asset=QIANCHUANG_MAP_ASSETS[basemap];assert.ok(asset,basemap);
  for(const count of [1,11,20]){
   const ids=Array.from({length:count},(_,i)=>'direct-'+i),groups=[{entityId:'empty-area',siteIds:[]},{entityId:null,siteIds:ids}],before=structuredClone(groups),out=qianchuangMapLayout(basemap,groups);
   assert.deepEqual(groups,before);assert.equal(out[0].contour,null);assert.deepEqual(out[0].contours,[]);assert.ok(out[0].labelBox);assert.deepEqual(out[0].points,[]);
   const b=out[0].labelBox,safe=(asset.anchors.placements?.all.ground??asset.anchors.all).filter(([x,y])=>!(x>=b.x&&x<=b.x+b.w&&y>=b.y&&y<=b.y+b.h));
   assert.ok(safe.length>=count,basemap+' available anchors');assert.deepEqual(out[1].points,ids.map((id,i)=>({id,x:safe[i][0],y:safe[i][1]})));
   if(count===11)assert.ok(new Set(out[1].points.map(p=>p.x)).size>2,basemap+' not two-column grid');
  }
  const a=qianchuangMapLayout(basemap,[{entityId:'empty-area',siteIds:[]},{entityId:null,siteIds:Array.from({length:11},(_,i)=>'site-'+i)}]);
  const b=qianchuangMapLayout(basemap,[{entityId:'empty-area',siteIds:[]},{entityId:null,siteIds:Array.from({length:12},(_,i)=>'site-'+i)}]);
  assert.deepEqual(b[1].points.slice(0,11),a[1].points);
  const overflow=qianchuangMapLayout(basemap,[{entityId:'empty-area',siteIds:[]},{entityId:null,siteIds:Array.from({length:asset.anchors.all.length+4},(_,i)=>'site-'+i)}]);
  assert.equal(overflow[1].points.length,asset.anchors.all.length+4);assert.ok(overflow[1].points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)));
 }
});

test('校园按明确短名称选楼体与同运动用途，室内优先且未知/无对应运动保持非sport安全池',()=>{
 for(const assetId of ['campus-compact','campus-garden','campus-university']){
  const asset=QIANCHUANG_MAP_ASSETS[assetId],pool=asset.anchors.placements?.all;assert.ok(pool,assetId);
  const pick=name=>qianchuangMapLayout(assetId,[{entityId:'area-label',siteIds:[]},{entityId:null,siteIds:['p']}],new Map([['p',{displayName:name}]]))[1].points[0];
  const contains=(rows,p)=>rows.some(([x,y])=>x===p.x&&y===p.y);
  for(const name of ['图书馆','体育馆','击剑馆','室内恒温泳池','公共休息室','办公室','实验室','食堂','Library','Indoor basketball court','Office']){
   const p=pick(name);assert.ok(contains(pool.building,p)||contains(pool.nearBuilding,p),assetId+' building '+name);
   assert.ok(contains(pool.backup,p),assetId+' building not sport');
  }
  const horse=pick('马术训练场');
  if(pool.sports.equestrian?.length)assert.ok(contains(pool.sports.equestrian,horse));else assert.ok(contains(pool.backup,horse),'no equestrian must not borrow another sport');
  for(const name of ['未分类场地','室外自习室'])assert.ok(contains(pool.outdoorBackup,pick(name)));
  for(const name of ['未分类场地','马术训练场']){const ids=Array.from({length:37},(_,i)=>'ground-'+i),byId=new Map(ids.map(id=>[id,{displayName:name}])),points=qianchuangMapLayout(assetId,[{entityId:null,siteIds:ids}],byId)[0].points;assert.equal(points.length,37);assert.ok(points.every(p=>contains(pool.outdoorBackup,p)||name==='马术训练场'&&contains(pool.sports.equestrian??[],p)));}
  const byId=new Map(Array.from({length:37},(_,i)=>['site-'+i,{displayName:i%3===0?'图书馆':i%3===1?'室内泳池':'未分类场地'}])),ids=[...byId.keys()],out=qianchuangMapLayout(assetId,[{entityId:null,siteIds:ids}],byId)[0];
  assert.deepEqual(out.points.map(p=>p.id),ids);assert.equal(new Set(out.points.map(p=>p.x+','+p.y)).size,ids.length);
  assert.ok(out.points.every(p=>contains(pool.backup,p)),assetId+' backup never ordinary grid on sport');
 }
});

test('校园一至五分区用途与备用坐标均保原owner，未修改输入或静态池',()=>{
 const contains=(rows,p)=>rows.some(([x,y])=>x===p.x&&y===p.y);
 for(const assetId of ['campus-compact','campus-garden','campus-university']){
  const asset=QIANCHUANG_MAP_ASSETS[assetId],before=JSON.stringify(asset.anchors);
  for(let count=1;count<=5;count++){
   const groups=Array.from({length:count},(_,i)=>({entityId:'area-'+i,siteIds:['library-'+i,'horse-'+i,'unknown-'+i]}));
   const byId=new Map(groups.flatMap(g=>[[g.siteIds[0],{displayName:'图书馆'}],[g.siteIds[1],{displayName:'马术训练场'}],[g.siteIds[2],{displayName:'未分类场地'}]]));
   const layout=qianchuangMapLayout(assetId,groups,byId);
   for(const region of layout){
    const index=asset.regions.layouts[count].findIndex(raw=>JSON.stringify(raw.contours)===JSON.stringify(region.contours)),pool=asset.anchors.placements.layouts[count][index];assert.ok(pool);
    for(const point of region.points){assert.ok(inRegion([point.x,point.y],region),'owner remains');assert.ok(contains(pool.backup,point)||point.id.startsWith('horse-')&&contains(pool.sports.equestrian??[],point));}
   }
  }
  assert.equal(JSON.stringify(asset.anchors),before);
 }
});

test('校园空标签和备用池耗用时仍避全部标签框，不因容量不足越回标签',()=>{
 for(const id of ['campus-compact','campus-garden','campus-university'])for(let count=1;count<=5;count++){
  const groups=[...Array.from({length:count},(_,i)=>({entityId:'empty-'+i,siteIds:[]})),{entityId:null,siteIds:Array.from({length:37},(_,i)=>'site-'+i)}];
  const out=qianchuangMapLayout(id,groups,new Map(groups.at(-1).siteIds.map(id=>[id,{displayName:'未分类场地'}]))),labels=out.map(r=>r.labelBox).filter(Boolean),points=out.at(-1).points;
  assert.equal(points.length,37);for(const p of points)assert.ok(labels.every(b=>p.x<b.x||p.x>b.x+b.w||p.y<b.y||p.y>b.y+b.h));
 }
});

test('重新方形构图的1至5区标签热区避全部地点中心，边缘点仍在画幅内',()=>{
 const assets=['old-town-inland','sci-fi-linear','old-town-river','old-town-plain','modern-radial','modern-town-river','palace-courtyard-garden','palace-courtyard-honmaru'];
 for(const asset of assets)for(let count=1;count<=5;count++){
  const groups=Array.from({length:count},(_,i)=>({entityId:'area-'+i,siteIds:Array.from({length:3},(_,j)=>`site-${i}-${j}`)}));
  groups.push({entityId:null,siteIds:['direct-a','direct-b']});
  const layout=qianchuangMapLayout(asset,groups),points=layout.flatMap(region=>region.points);
  assert.equal(points.length,count*3+2);
  for(const point of points)assert.ok(point.x>=0&&point.x<=100&&point.y>=0&&point.y<=100,asset);
  for(const region of layout.filter(region=>region.labelBox)){
   const b=region.labelBox;
   for(const point of points)assert.ok(point.x<b.x||point.x>b.x+b.w||point.y<b.y||point.y>b.y+b.h,`${asset} ${count} ${region.entityId}/${point.id}`);
  }
 }
});
