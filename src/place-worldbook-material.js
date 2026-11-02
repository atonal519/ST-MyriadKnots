import {sha256} from './identity.js';
import { replaceCseSourceMacros } from './cse-source-selection.js';
const key=value=>String(value??'').replace(/\s+/gu,' ').normalize('NFKC').trim().toLocaleLowerCase();
const PHYSICAL = new Set(['描述','布局','环境','面积','总面积','结构','外观','内饰','设施','设备','类型','地址','位置','安保','布局总览','特征','色调','家具','物品','description','layout','environment','area','structure','exterior','interior','facilities','equipment','type','address','location','security','features','furniture','items']);
const NAMES = new Set(['name','名称','地点名','物业名称','propertyname','property name']);
const PROPERTY = new Set(['物业名称','propertyname','property name']);
const EXCLUDED = new Set(['人物','人物档案','常客','使用者','相关成员','成员','开发商','互动','剧情','规则','特殊','特殊构造','特殊区域','people','person','persons','characters','character','members','users','occupants','developer','interactions','plot','rules','special','specialareas']);
const PERSON = new Set(['性别','性格','人物关系','gender','personality']);
const unsafe = value => /<%|<\/?script\b|\{\{/iu.test(value);
const namesFor = raw => {
  const name=String(raw??'').replace(/^\s*\d+\s*[.．、)]\s*/u,'').trim(),names=[name];
  const parens=[...name.matchAll(/[（(]([^()（）]+)[）)]/gu)];
  if(parens.length){names.push(name.replace(/[（(][^()（）]+[）)]/gu,' ').replace(/\s+/gu,' ').trim());for(const match of parens)names.push(match[1].trim());}
  return [...new Set(names.filter(Boolean))];
};
// Parse once per allowed catalog. Only direct physical values enter the display index.
export function indexQianchuangWorldInfo({candidates=[],macros={}}={}) {
  const records=[];
  for(const candidate of candidates){
    if(candidate.kind!=='worldbook'||candidate.hostEnabled===false||candidate.availability==='disabled')continue;
    let json;try{json=JSON.parse(candidate.content);}catch{continue;}
    if(!json||typeof json!=='object')continue;
    const replace=value=>replaceCseSourceMacros(value,macros);
    function walk(value,nodeName='',parent=null,path=[]){
      if(!value||typeof value!=='object')return;
      if(Array.isArray(value)){value.forEach((item,index)=>walk(item,'',parent,[...path,String(index)]));return;}
      const fields=Object.entries(value).map(([name,item])=>[replace(name),item]);
      if(fields.some(([name])=>PERSON.has(key(name))))return;
      const names=namesFor(replace(nodeName)),propertyNames=[];
      for(const[name,item]of fields)if(NAMES.has(key(name))&&typeof item==='string'){names.push(...namesFor(replace(item)));if(PROPERTY.has(key(name)))propertyNames.push(replace(item));}
      const texts=[];
      for(const[name,item]of fields)if(PHYSICAL.has(key(name))){for(const text of Array.isArray(item)?item:[item])if(typeof text==='string'){const value=replace(text).trim();if(value&&!unsafe(value))texts.push(value);}}
      const record={names:[...new Set(names.filter(name=>!unsafe(name)))],propertyNames,texts,parent,path,sourceKey:candidate.id??candidate.locator??'',fingerprint:candidate.fingerprint??null};
      const index=records.push(record)-1;
      for(const[name,item]of fields)if(item&&typeof item==='object'&&!PHYSICAL.has(key(name))&&!NAMES.has(key(name))&&!EXCLUDED.has(key(name)))walk(item,name,index,[...path,name]);
    }
    const rootIndex=records.length;walk(json);
    const root=Array.isArray(json)?null:records[rootIndex];
    if(root)root.names.push(...[...(candidate.primaryKeys??[]),candidate.entryLabel,candidate.comment,candidate.title].filter(value=>typeof value==='string').flatMap(value=>namesFor(replace(value))));
  }
  return records;
}


export async function captureQianchuangCharacterSources(context,characterLocator){
 const character=context?.characters?.[context.characterId];
 const fields=['description','scenario'].map(field=>({field,content:character?.data?.[field]??character?.[field]}))
  .filter(row=>typeof row.content==='string'&&row.content.trim());
 return Promise.all(fields.map(async({field,content})=>({sourceKey:`card-${field}`,kind:'characterCard',field,
  locator:`character:${characterLocator}:${field}`,fingerprint:`sha256:${await sha256(content)}`,content})));
}

