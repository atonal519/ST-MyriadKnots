import {QIANCHUANG_MAP_REGIONS} from './qianchuang-map-regions.js';
import {QIANCHUANG_MAP_ANCHORS} from './qianchuang-map-anchors.js';
import {QIANCHUANG_MAP_ASSETS} from '../qianchuang-map-assets.js';
const box=(x,y,w,h)=>({x,y,w,h});
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
export function qianchuangMapLayout(basemap,groups){
 const profile=QIANCHUANG_MAP_ASSETS[basemap]?.regions??QIANCHUANG_MAP_REGIONS[basemap]??QIANCHUANG_MAP_REGIONS.modern,aspect=QIANCHUANG_MAP_ASSETS[basemap]?QIANCHUANG_MAP_ASSETS[basemap].width/QIANCHUANG_MAP_ASSETS[basemap].height:basemap==='town'?590/540:1,named=groups.filter(g=>g.entityId),count=Math.min(5,named.length),anchors=QIANCHUANG_MAP_ASSETS[basemap]?.anchors??QIANCHUANG_MAP_ANCHORS[basemap]??QIANCHUANG_MAP_ANCHORS.modern;
 const directCount=groups.filter(g=>!g.entityId).reduce((sum,g)=>sum+g.siteIds.length,0),reserve=count>0&&directCount>anchors.neutral.length,faceCount=reserve?Math.min(5,count+1):count;
 let regions=(profile.layouts[faceCount]??[]).map((region,i)=>({...region,slots:anchors.layouts[faceCount][i]})).sort((a,b)=>b.inset.w*b.inset.h-a.inset.w*a.inset.h),reserved=reserve?regions.shift():null;
 if(reserved){
  const available=[...regions].sort((a,b)=>b.slots.length-a.slots.length||b.inset.w*b.inset.h-a.inset.w*a.inset.h),assigned=[];
  named.slice(0,regions.length).map((group,index)=>({group,index})).sort((a,b)=>b.group.siteIds.length-a.group.siteIds.length).forEach(({index})=>{assigned[index]=available.shift();});regions=assigned;
 }
 // Extra independent sites borrow one complete existing face; their data has no invented parent.
 const floatingIds=groups.filter(g=>!g.entityId||named.indexOf(g)>=regions.length).flatMap(g=>g.siteIds),floatingInset=reserved?.inset??(count?profile.neutral:box(12,12,76,76)),floatingSlots=reserved?.slots??(count?anchors.neutral:anchors.all),floating=new Map(placeInSlots(floatingIds,floatingSlots,()=>spreadFloating(floatingIds,floatingInset,aspect)).map(point=>[point.id,point]));
 let index=0;
 return groups.map(group=>{
  if(!group.entityId||index>=regions.length)return {...group,contour:null,contours:[],inset:floatingInset,labelBox:null,points:group.siteIds.map(id=>floating.get(id))};
  const {contours,inset,slots}=regions[index++],labelHeight=Math.min(inset.h*.55,Math.max(5,inset.h*.32)),labelBox=box(inset.x,inset.y,inset.w,labelHeight),siteTop=labelHeight+(inset.h-labelHeight)*.15,siteBox=box(inset.x,inset.y+siteTop,inset.w,inset.h-siteTop);
  return {...group,contour:contours[0],contours,inset,labelBox,points:placeInSlots(group.siteIds,slots,()=>spread(group.siteIds,siteBox,aspect))};
 });
}
