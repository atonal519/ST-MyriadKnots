import {qianchuangIconNames,qianchuangIconName} from './ui/qianchuang-icons.js';
import {QIANCHUANG_FACILITY_TERMS} from './ui/qianchuang-facility-terms.js';

export const QIANCHUANG_MAP_STYLES = Object.freeze([
 {id:'modern',label:'现代城市',tags:['现代','架空城市'],layouts:['inland','river','coast'],layoutLabels:{inland:'内陆街网、环向城区',river:'河道穿城',coast:'城市水岸、滨海街区'}},
 {id:'modern-town',label:'现代小城',tags:['现代','小城','低密街区'],layouts:['plain','river','hills','coast'],layoutLabels:{plain:'内陆小城、公共中心',river:'临水小城、规整街区',hills:'山麓小城',coast:'滨湾小城、斜向街区'}},
 {id:'old-town',label:'古风城镇',tags:['西幻','江湖','古风','架空城镇'],layouts:['inland','river','mountain','coast'],layoutLabels:{inland:'内陆城镇、平原田镇',river:'河谷聚落、桥与田野',mountain:'山地城镇',coast:'河口港镇、码头街巷'}},
 {id:'terrain',label:'自然地形（西幻、江湖、现代郊野或类地星球）',tags:['西幻','江湖','郊野','地表','类地星球'],layouts:['mountain','forest','forest-river','coast','snow','grassland','desert'],layoutLabels:{mountain:'山谷河流、等高线',forest:'森林山地','forest-river':'林地河谷',coast:'海岸原野、湾岸',snow:'北地湖群、山地',grassland:'平原郊野',desert:'荒漠沟壑'}},
 {id:'palace',label:'宫苑',tags:['宫廷','宫苑'],layouts:['axial','courtyard','honmaru'],layoutLabels:{axial:'中轴宫苑',courtyard:'院落宫苑、园林庄园',honmaru:'本丸、和风御殿、日式生活院落群；刀剑乱舞/刀剣乱舞/Touken Ranbu仅作题材参考，按本范围实际环境选择'}},
 {id:'sci-fi',label:'科幻设施、星舰或基地内部',tags:['科幻','舰内','设施内部'],layouts:['linear','ring'],layoutLabels:{linear:'甲板通道、生活舱',ring:'环状设施、联通舱区'}},
 {id:'alien',label:'特殊异星地表',tags:['科幻','异星','地表'],layouts:['rocky','organic'],layoutLabels:{rocky:'岩质山地、荒漠',organic:'生态地表、森林海岸'}},
]);
export const validQianchuangMapStyle = value => value==='town'||QIANCHUANG_MAP_STYLES.some(style=>style.id===value);
export const validQianchuangMapLayout = (value,style=null) => QIANCHUANG_MAP_STYLES.some(row=>(!style||row.id===(style==='town'?'old-town':style))&&row.layouts.includes(value));
export function normalizeQianchuangMapLayout(value,style=null){
 if(validQianchuangMapLayout(value,style))return value;
 if(typeof value!=='string')return undefined;
 const text=value.trim(),honmaru=text.toLowerCase()==='honmaru'||['本丸','和风院落','和风御殿','日式院落群'].includes(text);
 return honmaru&&validQianchuangMapLayout('honmaru',style)?'honmaru':undefined;
}
const iconNames=new Set(qianchuangIconNames);
export function normalizePlaceFacilities(value){
 if(!Array.isArray(value))return undefined;
 const found=new Map();
 for(const row of value){
  if(!row||typeof row.label!=='string'||!row.label.trim())continue;
  const label=row.label.trim(),name=qianchuangIconName(row.icon),icon=iconNames.has(name)?name:'MapPin';
  found.set(JSON.stringify([icon,label]),{icon,label});
 }
 return [...found.values()];
}
export const qianchuangFacilityDirectory = () => ({names:qianchuangIconNames,
 keywords:QIANCHUANG_FACILITY_TERMS.map(({icon,label,terms})=>({icon,label,terms}))});
