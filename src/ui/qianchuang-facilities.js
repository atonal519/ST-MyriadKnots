import {QIANCHUANG_FACILITY_TERMS} from './qianchuang-facility-terms.js';
import {qianchuangIconNames,qianchuangIconName,qianchuangIconCanonicalName} from './qianchuang-icons.js';
const normalize=value=>String(value??'').normalize('NFKC').toLocaleLowerCase();
const nameWords=name=>name.replace(/([a-z0-9])([A-Z])/gu,'$1 $2').replace(/([A-Z])([A-Z][a-z])/gu,'$1 $2').split(/\s+/u);
const englishNames=new Map(qianchuangIconNames.map(name=>[normalize(name).replace(/[\s_-]+/gu,''),name]));
const maxNameWords=Math.max(...qianchuangIconNames.map(name=>nameWords(name).length));
const uiWords=new Set(['X','Copy','CopyCheck','CopyPlus','Save','SaveAll','Undo','Undo2','Redo','Redo2','Import','Export','Download','Upload','Search','Menu','Settings','Check','Plus','Minus','Delete','RefreshCw','RefreshCcw']);
const legacyOrder=['bath','laundry','kitchen','dining','rest','storage','work'];
const legacy=new Map(legacyOrder.map(key=>[qianchuangIconCanonicalName(key),key]));
const terms=QIANCHUANG_FACILITY_TERMS.flatMap(row=>row.terms.map(term=>({...row,term:normalize(term),icon:qianchuangIconCanonicalName(row.icon)})));
const independentBath=/独立(?:且)?(?:干湿分离)?(?:的)?(?:卫浴|浴室|卫生间)(?:空间)?/gu;
const plans=/计划|打算|准备|想要|希望|将来|将要|拟建|待装|如果|临时|\b(?:planned|planning|proposed)\b/iu;
const predicates=/(没有|不设|未配备|未设置|不提供|未安装|未装|缺少|尚无|并无|不含|设有|配有|备有|带有|装有|放有|拥有|配备|有|走进|走向|走到|前往|来到|进入|正在|寻找|坐在|躺在|站在|清洗|使用|睡在|拿起|去|\bwithout\b|\bno\b)/giu;
const negative=/^(?:没有|不设|未配备|未设置|不提供|未安装|未装|缺少|尚无|并无|不含|without|no)$/iu;
const positive=/^(?:设有|配有|备有|带有|装有|放有|拥有|配备|有)$/u;
function statusFor(context,after,prior){
 if(plans.test(context))return 'uncertain';
 let status=prior;
 for(const match of context.matchAll(predicates))status=negative.test(match[0])?'negative':positive.test(match[0])?'positive':'uncertain';
 // A bare 无 only negates its next object, not compounds such as 无框、无线、无障碍.
 if(/无\s*$/u.test(context))status='negative';
 if(/^(?:并)?(?:不存在|缺失|未安装|未建成|未配备|尚未安装)|^\s*not\s+(?:installed|available)/iu.test(after.trim()))return 'negative';
 if(plans.test(after.trim().split(/[、和与及]/u)[0])&&/^(?:计划|打算|准备|将|拟|待)/u.test(after.trim()))return 'uncertain';
 return status;
}
function clauseHits(text){
 const value=normalize(text),hits=[];
 for(const row of terms){let start=value.indexOf(row.term);while(start>=0){const end=start+row.term.length;if(!(row.term==='床'&&/[头边柜单]/u.test(value[end]??'')))hits.push({...row,start,end,chinese:true,label:row.term==='独卫'?'独立卫浴':row.label});start=value.indexOf(row.term,end);}}
 for(const match of text.matchAll(independentBath))hits.push({icon:qianchuangIconCanonicalName('bath'),key:'bath',label:'独立卫浴',start:match.index,end:match.index+match[0].length,chinese:true});
 const words=[...text.matchAll(/[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*/gu)];
 for(let i=0;i<words.length;i++)for(let count=1;count<=maxNameWords&&i+count<=words.length;count++){
  const first=words[i],last=words[i+count-1],start=first.index,end=last.index+last[0].length,phrase=text.slice(start,end);
  if(!/^[A-Za-z0-9\s_-]+$/u.test(phrase))break;
  const name=englishNames.get(normalize(phrase).replace(/[\s_-]+/gu,''));if(!name||name.length===1||uiWords.has(name))continue;
  hits.push({icon:qianchuangIconCanonicalName(name),key:name,label:nameWords(name).join(' '),start,end,chinese:false});
 }
 hits.sort((a,b)=>a.start-b.start||(b.end-b.start)-(a.end-a.start)||Number(b.chinese)-Number(a.chinese));
 const selected=[];for(const hit of hits)if(!selected.some(prior=>prior.start<=hit.start&&prior.end>=hit.end))selected.push(hit);
 return selected;
}
function evidence(items){
 const found=new Map();let order=0;
 for(const item of items.filter(item=>item.kind===undefined||item.kind==='stable'))for(const clause of String(item.text??'').split(/[，,。；;！？\n]|但是|不过|但/gu)){
  const hits=clauseHits(clause);let status='positive',end=0;
  for(let i=0;i<hits.length;i++){const hit=hits[i];status=statusFor(clause.slice(end,hit.start),clause.slice(hit.end,hits[i+1]?.start),status);const rows=found.get(hit.icon)??[];rows.push({...hit,status,order:order++});found.set(hit.icon,rows);end=hit.end;}
 }
 return found;
}
export function qianchuangFacilityTags(features=[],supplements=[]){
 const primary=evidence(features),secondary=evidence(supplements),result=[];
 for(const icon of new Set([...primary.keys(),...secondary.keys()])){
  const matches=(primary.get(icon)??secondary.get(icon)).filter(hit=>hit.status==='positive');if(!matches.length)continue;
  const chosen=[...matches].sort((a,b)=>Number(b.chinese)-Number(a.chinese)||(b.end-b.start)-(a.end-a.start)||a.order-b.order)[0];
  result.push({key:legacy.get(icon)??chosen.key,label:chosen.label,order:Math.min(...matches.map(hit=>hit.order))});
 }
 return result.sort((a,b)=>{const ai=legacyOrder.indexOf(a.key),bi=legacyOrder.indexOf(b.key);return (ai<0?legacyOrder.length:ai)-(bi<0?legacyOrder.length:bi)||a.order-b.order;}).map(({key,label})=>({key,label}));
}
