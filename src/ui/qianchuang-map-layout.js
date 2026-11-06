import {QIANCHUANG_MAP_REGIONS} from './qianchuang-map-regions.js';
import {QIANCHUANG_MAP_ANCHORS} from './qianchuang-map-anchors.js';
import {QIANCHUANG_MAP_ASSETS} from '../qianchuang-map-assets.js';
const box=(x,y,w,h)=>({x,y,w,h});
const labelBoxFor=inset=>box(inset.x,inset.y,inset.w,Math.min(inset.h*.55,Math.max(5,inset.h*.32)));
function spread(ids,inset,aspect){
 const columns=Math.min(ids.length,Math.max(1,Math.round(Math.sqrt(ids.length*inset.w*aspect/inset.h)))),rows=Math.ceil(ids.length/columns);
 return ids.map((id,i)=>({id,x:inset.x+inset.w*((i%columns)+.5)/columns,y:inset.y+inset.h*(Math.floor(i/columns)+.5)/rows}));
}
function spreadFloating(ids,inset,aspect){
 const points=spread(ids,inset,aspect);
 if(ids.length===2){const axis=inset.w*aspect>inset.h?'x':'y',size=axis==='x'?inset.w:inset.h;points.forEach((point,i)=>{point[axis]=inset[axis]+size*(i?.85:.15);});}
 return points;
}
const placeInSlots=(ids,slots,fallback)=>ids.length<=slots.length?ids.map((id,i)=>({id,x:slots[i][0],y:slots[i][1]})):fallback();
function campusUse(node){
 const name=String(node?.displayName??'').normalize('NFKC').toLocaleLowerCase();
 const indoorRoom=!/室外|露天|\boutdoor\b/u.test(name)&&/室|\b(?:office|laboratory|lab|classroom|restroom)\b/u.test(name);
 if(indoorRoom||/室内|室內|楼|館|馆|堂|宿舍|厅|廳|店|\b(?:library|gym|gymnasium|hall|building|dormitory|shop|indoor|canteen|cafeteria)\b/u.test(name))return 'building';
 for(const[kind,pattern]of [['equestrian',/马术|馬術|\bequestrian\b/u],['tennis',/网球|網球|\btennis\b/u],['soccer',/足球|\b(?:soccer|football)\b/u],['basketball',/篮球|籃球|\bbasketball\b/u],['baseball',/棒球|\bbaseball\b/u],['athletics',/跑道|田径|田徑|\b(?:running track|athletics)\b/u]])if(pattern.test(name))return kind;
 return /操场|操場|运动场|運動場|体育场|體育場|球场|球場|\bsports field\b/u.test(name)?'any':'ground';
}
function placeCampusSlots(ids,slots,pool,byId,used,fallback,labelBoxes=[]){
 if(!pool)return placeInSlots(ids,slots,fallback);
 const outsideLabels=p=>labelBoxes.every(b=>p[0]<b.x||p[0]>b.x+b.w||p[1]<b.y||p[1]>b.y+b.h),distance=p=>used.length?Math.min(...used.map(q=>Math.max(Math.abs(p[0]-q[0]),Math.abs(p[1]-q[1])))):100;
 const positions=new Map(),priority=use=>use==='ground'?2:use==='building'?1:0;
 const ordered=ids.map((id,index)=>({id,index,use:campusUse(byId?.get(id))})).sort((a,b)=>priority(a.use)-priority(b.use)||a.index-b.index);
 for(const{id,use}of ordered){
  const ground=[...pool.ground,...pool.outdoorBackup];
  const tiers=use==='building'?[pool.building,pool.nearBuilding,ground,pool.backup]:use==='ground'?[ground]:[pool.sports[use]??[],ground];
  const unused=p=>!used.some(q=>p[0]===q[0]&&p[1]===q[1]);
  let point;
  for(const tier of tiers){
   const available=tier.filter(p=>outsideLabels(p)&&unused(p));
   if(!available.length)continue;
   point=available.find(p=>distance(p)>=9.3)??available.sort((a,b)=>distance(b)-distance(a))[0];break;
  }
  point??=tiers.flat().find(outsideLabels);
  positions.set(id,{id,x:point[0],y:point[1]});used.push(point);
 }
 return ids.map(id=>positions.get(id));
}
export function qianchuangMapLayout(basemap,groups,byId=null){
 const profile=QIANCHUANG_MAP_ASSETS[basemap]?.regions??QIANCHUANG_MAP_REGIONS[basemap]??QIANCHUANG_MAP_REGIONS.modern,aspect=QIANCHUANG_MAP_ASSETS[basemap]?QIANCHUANG_MAP_ASSETS[basemap].width/QIANCHUANG_MAP_ASSETS[basemap].height:basemap==='town'?590/540:1,named=groups.filter(g=>g.entityId),count=Math.min(5,named.length),anchors=QIANCHUANG_MAP_ASSETS[basemap]?.anchors??QIANCHUANG_MAP_ANCHORS[basemap]??QIANCHUANG_MAP_ANCHORS.modern;
 const placements=QIANCHUANG_MAP_ASSETS[basemap]?.family==='campus'?anchors.placements:null,used=[];
 const labelOnly=named.length>0&&named.every(group=>!group.siteIds.length)&&groups.some(group=>!group.entityId&&group.siteIds.length);
 const directCount=groups.filter(g=>!g.entityId).reduce((sum,g)=>sum+g.siteIds.length,0),reserve=count>0&&directCount>anchors.neutral.length,faceCount=reserve?Math.min(5,count+1):count;
 let regions=(profile.layouts[faceCount]??[]).map((region,i)=>({...region,slots:anchors.layouts[faceCount][i],placement:placements?.layouts?.[faceCount]?.[i]})).sort((a,b)=>b.inset.w*b.inset.h-a.inset.w*a.inset.h),reserved=reserve?regions.shift():null;
 if(reserved){
  const available=[...regions].sort((a,b)=>b.slots.length-a.slots.length||b.inset.w*b.inset.h-a.inset.w*a.inset.h),assigned=[];
  named.slice(0,regions.length).map((group,index)=>({group,index})).sort((a,b)=>b.group.siteIds.length-a.group.siteIds.length).forEach(({index})=>{assigned[index]=available.shift();});regions=assigned;
 }
 // Extra independent sites borrow one complete existing face; their data has no invented parent.
 // Empty area labels do not reserve a face from their direct sibling sites.
 const labelBoxes=labelOnly?regions.map(region=>labelBoxFor(region.inset)):[];
 const floatingIds=groups.filter(g=>!g.entityId||named.indexOf(g)>=regions.length).flatMap(g=>g.siteIds);
 const floatingInset=labelOnly?box(12,12,76,76):reserved?.inset??(count?profile.neutral:box(12,12,76,76));
 const floatingSlots=labelOnly?anchors.all.filter(([x,y])=>labelBoxes.every(b=>x<b.x||x>b.x+b.w||y<b.y||y>b.y+b.h)):reserved?.slots??(count?anchors.neutral:anchors.all);
 const floatingPool=labelOnly||!count?placements?.all:reserved?.placement??placements?.neutral;
 let floating=placements?null:new Map(placeInSlots(floatingIds,floatingSlots,()=>spreadFloating(floatingIds,floatingInset,aspect)).map(point=>[point.id,point]));
 let index=0;
 const result=groups.map(group=>{
  if(!group.entityId||index>=regions.length)return {...group,contour:null,contours:[],inset:floatingInset,labelBox:null,points:floating?group.siteIds.map(id=>floating.get(id)):[]};
  const {contours,inset,slots,placement}=regions[index++],labelBox=labelBoxFor(inset),labelHeight=labelBox.h,siteTop=labelHeight+(inset.h-labelHeight)*.15,siteBox=box(inset.x,inset.y+siteTop,inset.w,inset.h-siteTop);
  return {...group,contour:labelOnly?null:contours[0],contours:labelOnly?[]:contours,inset,labelBox,points:placeCampusSlots(group.siteIds,slots,placement,byId,used,()=>spread(group.siteIds,siteBox,aspect))};
 });
 if(placements){
  floating=new Map(placeCampusSlots(floatingIds,floatingSlots,floatingPool,byId,used,()=>spreadFloating(floatingIds,floatingInset,aspect),labelBoxes).map(point=>[point.id,point]));
  for(const group of result)if(!group.labelBox)group.points=group.siteIds.map(id=>floating.get(id));
 }
 return result;
}
