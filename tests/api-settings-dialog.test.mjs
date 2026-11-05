import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiSettings } from '../src/ui/settings/api-settings.js';
import { createSettingsStore } from '../src/settings.js';
class Node {
  constructor(tag){this.tagName=tag;this.children=[];this.events={};this.attributes={};this.className='';this.value='';this.disabled=false;this.hidden=false;this.checked=false;this._text='';}
  append(...nodes){for(const node of nodes){this.children.push(node);node.parentNode=this;}}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  setAttribute(k,v){this.attributes[k]=String(v);}
  addEventListener(k,v){(this.events[k]??=[]).push(v);}
  async fire(k,event={}){if(this.disabled)return;for(const fn of this.events[k]??[])await fn({target:this,currentTarget:this,preventDefault(){},stopPropagation(){},...event});}
  click(){return this.fire('click');}
  focus(){doc.activeElement=this;}
  getRootNode(){return doc;}
  contains(n){return n===this||all(this).includes(n);}
  get textContent(){return this._text||this.children.map(n=>n.textContent).join('');}set textContent(v){this._text=String(v);}
  get classList(){return{add:v=>{this.className+=' '+v;},remove:v=>{this.className=this.className.split(' ').filter(x=>x!==v).join(' ');},contains:v=>this.className.split(' ').includes(v)}}
}
const doc={activeElement:null,createElement:tag=>new Node(tag)};
const all=n=>[n,...n.children.flatMap(all)];
const button=(n,name)=>all(n).find(x=>x.tagName==='button'&&(x.attributes['aria-label']===name||x.textContent===name));
const field=(n,name)=>all(n).find(x=>x.tagName==='label'&&x.children[0]?.textContent===name)?.children[1];
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function setup(){
 const data={'schedule-planner':{apiPresetActiveId:'p',utilityPresetId:'p',apiPresets:[{id:'p',name:'原预设',url:'https://old.invalid/v1',key:'saved-key',model:'old-model',excludeParams:['seed','top_p'],timeoutSec:70,stream:true,qqjTemperature:0,unknown:{keep:1}}]}};
 let saves=0,clock=123,saveImpl=()=>{};const settings=createSettingsStore({extensionSettings:data,save(){saves++;return saveImpl();},now:()=>clock++,random:()=>.2});
 settings.update({apiMode:'seven-preset',selectedSevenDaysPresetId:'p',summaryPresetId:'',recallPresetId:'',vectorPresetId:'p'});
 let active=null,resolveDialog;const dialogs={custom(options){active=options;return new Promise(resolve=>{resolveDialog=resolve;});},async save(){try{const value=await active.submit();active.onClose?.();active=null;resolveDialog(value);return true;}catch(error){active.error=error;return false;}},cancel(){active.onClose?.();active=null;resolveDialog(null);},get active(){return active;}};
 const calls=[];const apiTools={fetchModels:async selection=>{calls.push(['models',selection]);return ['model-a','model-b'];},testConnection:async selection=>{calls.push(['test',selection]);return{model:selection.config.model};}};
 const view=createApiSettings({settings,apiTools,documentRef:doc,customImpl:options=>dialogs.custom(options)});
 return{data,settings,view,dialogs,calls,apiTools,get saves(){return saves;},setSave(fn){saveImpl=fn;},open:async(role='analysis')=>{await button(view.node,'编辑'+({analysis:'分析',summary:'摘要',recall:'召回'}[role])+' API').fire('click');return dialogs.active.content;}};
}
test('外部只保三用途选择编辑与唯一全局新增，编辑跟随目标且取消零写',async()=>{
 const h=setup();assert.equal(all(h.view.node).filter(n=>n.tagName==='input'||n.tagName==='textarea').length,0);
 assert.equal(all(h.view.node).filter(n=>n.tagName==='button'&&n.textContent==='编辑').length,3);
 assert.equal(all(h.view.node).filter(n=>n.textContent==='新增 API'&&n.tagName==='button').length,1);
 const before=structuredClone(h.data),writes=h.saves,form=await h.open('recall');assert.match(h.dialogs.active.title,/召回/);assert.match(form.textContent,/跟随摘要/);
 assert.equal(field(form,'预设名称').value,'原预设');assert.equal(field(form,'Key').value,'');
 field(form,'URL').value='未保存';field(form,'Key').value='草稿';field(form,'预设名称').value='新名';h.dialogs.cancel();assert.deepEqual(h.data,before);assert.equal(h.saves,writes);assert.equal(h.calls.length,0);
});
test('编辑保存同时改名称和参数，保ID/跟随/未知字段与最新Key；失效目标不复活',async()=>{
 const h=setup(),form=await h.open('summary'),before=structuredClone(h.data.qianqianjie);field(form,'预设名称').value=' 新名称 ';field(form,'URL').value='https://edited.invalid/v1';
 h.data['schedule-planner'].apiPresets[0]={...h.data['schedule-planner'].apiPresets[0],key:'rotated-key',unknown:{keep:2}};
 const writes=h.saves;assert.equal(await h.dialogs.save(),true);assert.equal(h.saves,writes+1);
 const saved=h.settings.sharedPresets()[0];assert.equal(saved.id,'p');assert.equal(saved.name,'新名称');assert.equal(saved.key,'rotated-key');assert.deepEqual(saved.unknown,{keep:2});assert.deepEqual(h.data.qianqianjie,before);
 await h.open();h.data['schedule-planner'].apiPresets=[];assert.equal(await h.dialogs.save(),false);assert.match(h.dialogs.active.error.message,/不存在|失效/);assert.deepEqual(h.settings.sharedPresets(),[]);
});
test('新增保存才创建且不绑定用途，不借旧Key；失败保草稿且重试只建一份',async()=>{
 const h=setup(),before=structuredClone(h.data.qianqianjie),writes=h.saves;await button(h.view.node,'新增 API').fire('click');let form=h.dialogs.active.content;
 for(const label of ['预设名称','URL','Key'])assert.equal(field(form,label).value,'');
 field(form,'预设名称').value='新增连接';field(form,'URL').value='https://new.invalid/v1';field(form,'模型').children[0].value='new-model';
 assert.equal(await h.dialogs.save(),false);assert.equal(h.saves,writes);assert.match(h.dialogs.active.error.message,/Key|密钥/);
 field(form,'Key').value='new-key';h.setSave(()=>Promise.reject(Error('模拟保存失败')));
 assert.equal(await h.dialogs.save(),false);assert.equal(h.settings.sharedPresets().length,1);assert.equal(field(form,'Key').value,'new-key');assert.deepEqual(h.data.qianqianjie,before);
 h.setSave(()=>{});assert.equal(await h.dialogs.save(),true);assert.equal(h.settings.sharedPresets().length,2);assert.deepEqual(h.data.qianqianjie,before);assert.equal(h.data['schedule-planner'].apiPresetActiveId,'p');
});
test('高级默认折叠，非法JSON/温度阻止保存与显式工具；拉取搜索点选仅改草稿',async()=>{
 const h=setup(),form=await h.open();assert.equal(field(form,'排除参数').value,'seed\ntop_p');const advanced=all(form).find(n=>n.tagName==='details');assert.equal(Boolean(advanced.open),false);
 field(form,'附加参数（JSON）').value='{bad';await button(form,'测试').fire('click');assert.equal(h.calls.length,0);assert.equal(await h.dialogs.save(),false);
 field(form,'附加参数（JSON）').value='';field(form,'千千结温度（0–2）').value='3';assert.equal(await h.dialogs.save(),false);
 field(form,'千千结温度（0–2）').value='0';await button(form,'拉取模型').fire('click');assert.equal(h.calls[0][1].config.key,'saved-key');
 const choice=all(form).find(n=>n.attributes['data-model']==='model-b');await choice.fire('click');assert.equal(field(form,'模型').children[0].value,'model-b');assert.equal(h.settings.sharedPresets()[0].model,'old-model');
 await button(form,'测试').fire('click');assert.equal(h.calls.at(-1)[1].config.model,'model-b');assert.equal(await h.dialogs.save(),true);assert.equal(h.settings.sharedPresets()[0].qqjTemperature,0);
});
test('主配置固定名，另存只建副本不绑定；删除先内联确认，取消不丢原稿',async()=>{
 const h=setup();h.settings.update({apiMode:'auto',selectedSevenDaysPresetId:''});let form=await h.open();assert.equal(field(form,'预设名称').disabled,true);assert.equal(button(form,'删除').disabled,true);field(form,'URL').value='https://main.invalid/v1';field(form,'Key').value='main-key';field(form,'模型').children[0].value='main-model';await button(form,'另存为').fire('click');assert.ok(field(form,'副本名称'));field(form,'副本名称').value='主配置副本';await button(form,'保存副本').fire('click');assert.ok(h.settings.sharedPresets().some(p=>p.name==='主配置副本'));h.dialogs.cancel();
 form=await (async()=>{h.settings.update({apiMode:'seven-preset',selectedSevenDaysPresetId:'p'});return h.open();})();field(form,'预设名称').value='副本';field(form,'URL').value='https://copy.invalid/v1';const before=structuredClone(h.data.qianqianjie);
 await button(form,'另存为').fire('click');field(form,'副本名称').value='副本';await button(form,'保存副本').fire('click');assert.equal(h.settings.sharedPresets().length,3);assert.deepEqual(h.data.qianqianjie,before);assert.equal(h.dialogs.active.content,form);
 await button(form,'删除').fire('click');assert.ok(button(form,'确认删除'));await button(form,'返回编辑').fire('click');assert.equal(field(form,'URL').value,'https://copy.invalid/v1');
 await button(form,'删除').fire('click');await button(form,'确认删除').fire('click');assert.equal(h.settings.sharedPresets().some(p=>p.id==='p'),false);assert.equal(h.settings.get().apiMode,'auto');assert.equal(h.settings.get().vectorEnabled,false);assert.equal(button(form,'删除').disabled,true);await button(form,'另存为').fire('click');field(form,'副本名称').value='删后副本';await button(form,'保存副本').fire('click');assert.ok(h.settings.sharedPresets().some(p=>p.name==='删后副本'));assert.equal(h.settings.sharedPresets().some(p=>p.id==='p'),false);h.dialogs.cancel();
});
test('保存失败保既有参数且不覆盖此间并发字段',async()=>{
 const h=setup();const form=await h.open();field(form,'URL').value='https://draft.invalid';h.setSave(()=>{h.data['schedule-planner'].apiPresets=[{...h.data['schedule-planner'].apiPresets[0],concurrent:true}];return Promise.reject(Error('失败'));});
 assert.equal(await h.dialogs.save(),false);assert.equal(field(form,'URL').value,'https://draft.invalid');assert.equal(h.settings.sharedPresets()[0].concurrent,true);
});


test('保存等待真实完成且同步异常留窗，关闭旧窗后迟到模型不污染新窗',async()=>{
 const h=setup(),form=await h.open();field(form,'预设名称').value='新名';
 h.setSave(()=>{throw Error('同步失败');});assert.equal(await h.dialogs.save(),false);assert.equal(h.dialogs.active.content,form);assert.equal(field(form,'预设名称').value,'新名');assert.equal(h.settings.sharedPresets()[0].name,'原预设');
 let finish;h.setSave(()=>new Promise(resolve=>{finish=resolve;}));const saving=h.dialogs.save();await flush();assert.equal(h.dialogs.active.content,form);finish();assert.equal(await saving,true);assert.equal(h.dialogs.active,null);
 let release;h.apiTools.fetchModels=()=>new Promise(resolve=>{release=resolve;});const old=await h.open(),waiting=button(old,'拉取模型').fire('click');await flush();h.dialogs.cancel();const fresh=await h.open();release(['late-model']);await waiting;
 assert.equal(field(fresh,'模型').children[0].value,'old-model');assert.equal(all(fresh).find(n=>n.className==='qqj-model-list-section').hidden,true);h.dialogs.cancel();
});

test('模型搜索的Enter只保草稿，不触发主表单保存，IME继续由原输入处理',async()=>{
 const h=setup(),form=await h.open();await button(form,'拉取模型').fire('click');const search=all(form).find(n=>n.type==='search'),writes=h.saves;let stopped=false,prevented=false;
 await search.fire('keydown',{key:'Enter',preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});if(!stopped)await h.dialogs.save();
 assert.equal(prevented,true);assert.equal(h.saves,writes);assert.equal(h.dialogs.active.content,form);
 prevented=false;stopped=false;await search.fire('keydown',{key:'Enter',isComposing:true,preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});assert.equal(prevented,false);assert.equal(stopped,false);h.dialogs.cancel();
});
test('副本名称Enter只保存副本，保原预设/用途/编辑窗',async()=>{
 const h=setup(),form=await h.open(),original=structuredClone(h.settings.sharedPresets()[0]),refs=structuredClone(h.settings.get());field(form,'URL').value='https://copy-enter.invalid';await button(form,'另存为').fire('click');const copy=field(form,'副本名称');copy.value='Enter副本';let stopped=false;
 await copy.fire('keydown',{key:'Enter',preventDefault(){},stopPropagation(){stopped=true;}});await flush();if(!stopped)await h.dialogs.save();
 assert.ok(h.settings.sharedPresets().some(p=>p.name==='Enter副本'));assert.deepEqual(h.settings.sharedPresets().find(p=>p.id==='p'),original);assert.deepEqual(h.settings.get(),refs);assert.equal(h.dialogs.active.content,form);h.dialogs.cancel();
});

test('另存区展开后底部保存创建新ID副本，保原预设和用途并继承空Key', async () => {
 const h = setup(), form = await h.open('summary');
 const original = structuredClone(h.settings.sharedPresets()[0]);
 const refs = structuredClone(h.settings.get());
 const sharedRefs = { active: h.data['schedule-planner'].apiPresetActiveId, utility: h.data['schedule-planner'].utilityPresetId };
 const writes = h.saves;
 field(form, 'URL').value = 'https://footer-copy.invalid/v1';
 field(form, '模型').children[0].value = 'copy-model';
 await button(form, '另存为').fire('click');
 field(form, '副本名称').value = ' 底部保存副本 ';
 assert.equal(field(form, 'Key').value, '');
 assert.equal(await h.dialogs.save(), true);
 assert.equal(h.saves, writes + 1);
 assert.equal(h.settings.sharedPresets().length, 2);
 const copy = h.settings.sharedPresets().find(preset => preset.id !== original.id);
 assert.ok(copy?.id);
 assert.equal(copy.name, '底部保存副本');
 assert.equal(copy.url, 'https://footer-copy.invalid/v1');
 assert.equal(copy.model, 'copy-model');
 assert.equal(copy.key, original.key);
 assert.deepEqual(h.settings.sharedPresets().find(preset => preset.id === original.id), original);
 assert.deepEqual(h.settings.get(), refs);
 assert.deepEqual({ active: h.data['schedule-planner'].apiPresetActiveId, utility: h.data['schedule-planner'].utilityPresetId }, sharedRefs);
 assert.equal(h.dialogs.active, null);
 assert.equal(h.calls.length, 0);
});

test('取消另存后底部保存更新原预设，取消整个编辑零写入', async () => {
 const h = setup(), form = await h.open(), writes = h.saves;
 const refs = structuredClone(h.settings.get());
 await button(form, '另存为').fire('click');
 field(form, '副本名称').value = '取消的副本';
 await button(form, '取消另存').fire('click');
 field(form, '预设名称').value = '原项更新';
 field(form, 'URL').value = 'https://updated.invalid/v1';
 assert.equal(await h.dialogs.save(), true);
 assert.equal(h.saves, writes + 1);
 assert.equal(h.settings.sharedPresets().length, 1);
 assert.equal(h.settings.sharedPresets()[0].id, 'p');
 assert.equal(h.settings.sharedPresets()[0].name, '原项更新');
 assert.deepEqual(h.settings.get(), refs);
 const before = structuredClone(h.data), savedWrites = h.saves, next = await h.open();
 await button(next, '另存为').fire('click');
 field(next, '副本名称').value = '不保存';
 h.dialogs.cancel();
 assert.deepEqual(h.data, before);
 assert.equal(h.saves, savedWrites);
});

test('底部另存失败保副本草稿与原项，重试只新增一份', async () => {
 const h = setup(), form = await h.open();
 const original = structuredClone(h.settings.sharedPresets()[0]);
 const refs = structuredClone(h.settings.get());
 field(form, 'URL').value = 'https://retry-copy.invalid/v1';
 await button(form, '另存为').fire('click');
 field(form, '副本名称').value = '重试副本';
 h.setSave(() => Promise.reject(Error('模拟保存失败')));
 assert.equal(await h.dialogs.save(), false);
 assert.equal(h.dialogs.active.content, form);
 assert.equal(field(form, '副本名称').parentNode.parentNode.hidden, false);
 assert.equal(field(form, '副本名称').value, '重试副本');
 assert.equal(field(form, 'URL').value, 'https://retry-copy.invalid/v1');
 assert.deepEqual(h.settings.sharedPresets(), [original]);
 h.setSave(() => {});
 assert.equal(await h.dialogs.save(), true);
 assert.equal(h.settings.sharedPresets().length, 2);
 assert.equal(h.settings.sharedPresets().filter(preset => preset.name === '重试副本').length, 1);
 assert.deepEqual(h.settings.sharedPresets().find(preset => preset.id === original.id), original);
 assert.deepEqual(h.settings.get(), refs);
});


test('失败重试次数高级输入保零、校验草稿，取消与无关编辑不补写旧缺省', async () => {
  const h = setup(); let form = await h.open(); const retry = field(form, '失败重试次数');
  assert.ok(retry); assert.equal(retry.value, '2'); assert.equal(retry.min, '0'); assert.equal(retry.step, '1');
  const original = structuredClone(h.data); h.dialogs.cancel(); assert.deepEqual(h.data, original);
  form = await h.open(); field(form, '预设名称').value = '改名'; assert.equal(await h.dialogs.save(), true);
  assert.equal(Object.hasOwn(h.settings.sharedPresets()[0], 'qqjRetryCount'), false);
  form = await h.open();
  for (const invalid of ['', '-1', '0.5', String(Number.MAX_SAFE_INTEGER), 'Infinity']) {
    field(form, '失败重试次数').value = invalid; assert.equal(await h.dialogs.save(), false, invalid);
  }
  field(form, '失败重试次数').value = '0'; assert.equal(await h.dialogs.save(), true); assert.equal(h.settings.sharedPresets()[0].qqjRetryCount, 0);
  form = await h.open(); await button(form, '另存为').fire('click'); field(form, '副本名称').value = '零重试副本'; assert.equal(await h.dialogs.save(), true);
  assert.equal(h.settings.sharedPresets().find(p => p.name === '零重试副本').qqjRetryCount, 0);
});
