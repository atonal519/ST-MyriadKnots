import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { scanAssistantCandidates, createFloorRecord } from '../src/v3/foundation-domain.js';
import { readTimeBody, planTimeBody, timeBodyStart } from '../src/v3/time-body.js';
import { createTimeRuntime, createTimeStore, prepareTimeRequest } from '../src/v3/time-runtime.js';
import { compileTimeResponse, compileTimeEdit, replayTimeBatches, timeBodyReads, projectTime, TIME_INPUT_TOKENS, TIME_SYSTEM_PROMPT } from '../src/v3/time-engine.js';
import { estimateRecallTokens, selectRecall, buildRecallQueryContext } from '../src/v3/recall-selector.js';
import { projectInlineRecallReceipt } from '../src/ui/inline-projection.js';
const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', PERSON = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function backend() {
  const records = new Map(); return { records, client: { async get(c,id) { const result=records.get(`${c}/${id}`); if (!result) throw Object.assign(new Error('missing'),{status:404}); return structuredClone(result); },
    async put(c,id,data,revision,{signal}={}) { if(signal?.aborted) throw new DOMException('abort','AbortError'); const key=`${c}/${id}`, old=records.get(key); assert.equal(old?.revision??0,revision); const result={data:structuredClone(data),revision:revision+1}; records.set(key,result); return structuredClone(result); } } };
}
const raw = (i, body='陌生人阿岚的手腕擦伤仍疼痛。') => `<!-- QQJ-start | date=2026-05-${String(i+1).padStart(2,'0')} | weekday=周一 | time=08:00 -->${body}<!-- QQJ-end | date=2026-05-${String(i+1).padStart(2,'0')} | weekday=周一 | time=09:00 -->`;
async function harness({ count=2, unstable=false, generate=()=>({changes:[]}), sanitizer={}, tags='Ti' }={}) {
  let chatId=CHAT,on=true,calls=0,busy=true,cse=false,sync='idle', counter=0;
  const chat=[]; for(let i=0;i<count;i++) { chat.push({is_user:false,mes:raw(i)}); if(!unstable||i<count-1) chat.push({is_user:true,mes:'继续'}); }
  const source={status:'ready',root:{chatId:CHAT,narrativeGeneration:'gen',headCheckpointId:'head'},rootRevision:1,floors:[],floorMemories:[],stateDeltas:[],entities:[],capabilities:{}};
  async function seal() { const candidates=await scanAssistantCandidates(chat,{sanitizerOptions:sanitizer,chatId:CHAT}); source.floors=candidates.filter(candidate=>candidate.stabilityProof).map((candidate,i)=>createFloorRecord({candidate,id:`floor-${i+1}`,chatId:CHAT,narrativeGeneration:'gen'})); }
  await seal(); const back=backend(),store=createTimeStore(back),hostAdapter={snapshot:()=>({chat,chatId:'host',context:{chatMetadata:{qianqianjie:{chatId}}}})};
  const options={store,hostAdapter,newUuid:()=>`test-${++counter}`,foundationStore:{readRoot:async()=>({data:source.root})},session:{identity:()=>({chatId,hostChatId:'host'})},
    getReachable:()=>source,getMemoryState:()=>({memoryWorkBusy:busy,activeCse:cse?{}:null,memorySyncStatus:sync}),sanitizerOptions:()=>sanitizer,storyClockReferenceTags:()=>tags,isEnabled:()=>on,logger:{warn(){}},
    generateTimeTask:async task=>{calls++;assert.equal(task.transportBudget.remaining,1);assert.equal(task.transportRetries,0);assert.ok(estimateRecallTokens(task.systemPrompt+task.taskMessages[0].content)<=TIME_INPUT_TOKENS);return generate(JSON.parse(task.taskMessages[0].content),calls,task);}};
  let runtime=createTimeRuntime(options);
  return {source,chat,store,back,seal,hostAdapter,get runtime(){return runtime;},reload(){runtime=createTimeRuntime(options);return runtime;},calls:()=>calls,setChat:value=>chatId=value,setEnabled:value=>on=value,setSync:value=>sync=value,body:()=>readTimeBody(source,hostAdapter.snapshot(),{sanitizerOptions:sanitizer,storyClockReferenceTags:tags})};
}
const bodyModel = (request,patch={}) => ({changes:[{itemId:null,subjectEntityId:null,subjectName:'阿岚',type:'body',label:'手腕擦伤',observation:'手腕擦伤仍疼痛',occurrenceTime:'昨天',dueTime:'',periodDays:null,status:'active',stateRefs:[],progression:'疼痛可能逐渐减轻，仍待新观察确认',sourceKeys:[request.observations[0].sourceKey],...patch}]});

test('无摘要/CSE正文、新NPC由真实scanner登记，独立召回和楼内参考可见，人工编辑保正文依赖',async()=>{
  const h=await harness({generate:bodyModel}); const plan=await h.runtime.prepareHistoryPlan(); assert.equal(h.calls(),0); await h.runtime.organize(plan);assert.equal(h.calls(),1);
  const stored=await h.store.read(CHAT), body=await h.body(), item=replayTimeBatches(stored.batches,body)[0];assert.equal(item.subjectName,'阿岚');assert.match(item.subjectEntityId,/^time-person-/);assert.equal(item.projection.text,'疼痛可能逐渐减轻，仍待新观察确认');
  assert.equal(h.runtime.getState().coverage.checkedFloors,2);assert.equal(h.source.floorMemories.length,0);assert.equal(h.source.entities.length,0);
  const recall={status:'ready',chatId:CHAT,headCheckpointId:'head',rootRevision:1,bodyMatchRefs:h.source.floors.map(floor=>({floorId:floor.id,assistantSeq:floor.assistantSeq})),floorMemories:[],entities:[],currentState:[],cseChanges:[],identityProjection:{},coverage:{memoryComplete:false,cseCurrent:false},bodyMatch:{visibleFloorIds:[],summaryCoveredFloorIds:[]}};
  recall.timeProjection=await h.runtime.recallProjection(recall);assert.match(recall.timeProjection.reminders[0].text,/阿岚/);
  const selected=selectRecall({source:recall,queryContext:buildRecallQueryContext({coreChat:[{is_user:true,mes:'现在怎么样'}]}),contextSize:8192});assert.match(selected.injectionText,/阿岚.*手腕擦伤/);
  assert.equal(projectInlineRecallReceipt({schemaVersion:11,status:selected.status,injectionText:selected.injectionText,selectedFloors:selected.floors,selectedStates:selected.states}).timeReferenceCount,1);
  await h.runtime.editItem(item.id,{label:'人工名称'},item.observationKey);const edited=(await h.store.read(CHAT)).batches.at(-1);assert.equal(edited.dependencies[0].canonicalFingerprint,item.sourceRefs[0].canonicalFingerprint);assert.equal(h.calls(),1);
  h.reload();await h.runtime.refreshStatus();assert.equal(h.runtime.getState().trackedItems[0].label,'人工名称');
});

test('首次开启冻结未稳定实际当前AI，不扫前楼；稳定后只从当前楼读；无AI等待第一楼',async()=>{
  const h=await harness({count:3,unstable:true});await h.runtime.runBatch();assert.equal(h.calls(),0);const head=(await h.store.read(CHAT)).head;assert.equal(head.bodyStart.floorId,null);assert.equal(head.bodyStart.hostLocator.messageIndex,4);
  h.chat.push({is_user:true,mes:'继续'});await h.seal();await h.runtime.runBatch();assert.equal(h.calls(),1);const stored=await h.store.read(CHAT);assert.deepEqual(stored.batches[0].bodyReads.map(row=>row.floorId),['floor-3']);assert.equal(h.runtime.getState().coverage.checkedFloors,1);assert.equal(h.runtime.getState().coverage.startAssistantSeq,3);
  const empty=await harness({count:0});await empty.runtime.runBatch();assert.equal((await empty.store.read(CHAT)).head.bodyStart.awaitingFirst,true);empty.chat.push({is_user:false,mes:raw(0)},{is_user:true,mes:'继续'});await empty.seal();await empty.runtime.runBatch();assert.equal(empty.calls(),1);
});

test('打开与取消计划零API零标记，默认当前追踪不是历史授权；关闭重开保范围',async()=>{
  const h=await harness({count:4});await h.runtime.refreshStatus();assert.equal(h.calls(),0);assert.equal((await h.store.read(CHAT)).head,null);
  const preview=await h.runtime.prepareHistoryPlan();assert.equal(preview.floorCount,4);assert.equal(h.calls(),0);assert.equal((await h.store.read(CHAT)).head,null);
  await h.runtime.runBatch();assert.equal(h.calls(),1);assert.deepEqual((await h.store.read(CHAT)).batches[0].bodyReads.map(row=>row.floorId),['floor-4']);h.setEnabled(false);await h.runtime.stop();h.setEnabled(true);await h.runtime.runBatch();assert.equal(h.calls(),1);
});

test('20楼和完整预算、长楼分片、空成功留痕、第二批失败只补剩余范围',async()=>{
  const h=await harness({count:25,generate:(_,calls)=>{if(calls===2)throw new Error('synthetic');return {changes:[]};}});
  let plan=await h.runtime.prepareHistoryPlan();assert.ok(plan.groups.every(group=>new Set(group.map(row=>row.floorId)).size<=20));assert.ok(plan.batchCount>=2);await h.runtime.organize(plan);
  let stored=await h.store.read(CHAT);assert.equal(stored.batches.length,1);assert.equal(stored.batches[0].changes.length,0);plan=await h.runtime.prepareHistoryPlan();assert.equal(plan.floorCount,25-stored.batches[0].bodyReads.length);await h.runtime.organize(plan);assert.equal((await h.runtime.prepareHistoryPlan()).floorCount,0);
  const long=await harness({count:1});long.chat[0].mes=raw(0,'阿岚观察。\n'+ '长正文。'.repeat(10000));await long.seal();plan=await long.runtime.prepareHistoryPlan();assert.ok(plan.batchCount>1);assert.ok(plan.groups.flat().every(row=>row.to-row.from<row.totalCharacters));
  await long.runtime.organize(plan);stored=await long.store.read(CHAT);const reads=timeBodyReads(stored.batches,await long.body()).get('floor-1').sort((a,b)=>a.from-b.from);assert.equal(reads[0].from,0);assert.equal(reads.at(-1).to,reads[0].totalCharacters);assert.equal(long.runtime.getState().coverage.checkedFloors,1);assert.equal((await long.runtime.prepareHistoryPlan()).apiCalls,0);
});

test('30000完整输入预算优先整楼合批，辅助长材料按剩余空间且无旧字符上限',async()=>{
  const h=await harness({count:4});
  for(let i=0;i<4;i++) h.chat[i*2].mes=raw(i,'阿岚观察。\n'+'正文'.repeat(3000));
  await h.seal();const source=await h.body();
  source.entities=[{id:PERSON,entityType:'person',displayName:'阿岚',aliases:['冗长辅助材料'.repeat(10000)]}];
  source.floorMemories=source.floors.map(floor=>({id:`memory-${floor.id}`,floorId:floor.id,recordStatus:'active',summary:{effectiveSource:'user',userText:'辅助摘要'.repeat(10000)}}));
  const plan=planTimeBody(source,[],{history:true});assert.equal(plan.batchCount,1);assert.equal(plan.groups[0].length,4);
  for(const row of plan.groups[0]) {assert.equal(row.from,0);assert.equal(row.to,row.totalCharacters);}
  const prepared=await prepareTimeRequest(source,[],{fragments:plan.groups[0]});
  assert.ok(estimateRecallTokens(TIME_SYSTEM_PROMPT+JSON.stringify(prepared.request))<=TIME_INPUT_TOKENS);
  assert.deepEqual(prepared.request.observations.map(row=>row.description),source.bodyFloors.map(row=>row.content));
  const ascii=await harness({count:1});ascii.chat[0].mes=raw(0,'A'.repeat(90000));await ascii.seal();
  const asciiSource=await ascii.body(),asciiPlan=planTimeBody(asciiSource,[],{history:true});assert.equal(asciiPlan.batchCount,1);assert.equal(asciiPlan.groups[0][0].to,90000);
  const asciiRequest=await prepareTimeRequest(asciiSource,[],{fragments:asciiPlan.groups[0]});assert.ok(JSON.stringify(asciiRequest.request).length>24000);assert.ok(estimateRecallTokens(TIME_SYSTEM_PROMPT+JSON.stringify(asciiRequest.request))<=TIME_INPUT_TOKENS);
});

test('超长单楼在长元数据下完整分片，每批实际request不超完整预算、区间无漏无重',async()=>{
  const h=await harness({count:1});h.chat[0].mes=raw(0,('超长完整正文。\n').repeat(10000));await h.seal();
  const source=await h.body();source.root.chatId='长聊天身份'.repeat(1000);
  source.bodyFloors[0].rawFingerprint='长元数据'.repeat(1000);source.bodyFloors[0].timeSourceFingerprint='长时间元数据'.repeat(1000);
  const plan=planTimeBody(source,[],{history:true});assert.ok(plan.batchCount>1);
  const rows=plan.groups.flat();let cursor=0;for(const row of rows){assert.equal(row.from,cursor);cursor=row.to;assert.equal(row.description,source.bodyFloors[0].content.slice(row.from,row.to));}
  assert.equal(cursor,source.bodyFloors[0].content.length);
  for(const group of plan.groups){const prepared=await prepareTimeRequest(source,[],{fragments:group});assert.ok(estimateRecallTokens(TIME_SYSTEM_PROMPT+JSON.stringify(prepared.request))<=TIME_INPUT_TOKENS);}
});

test('已确认范围不被新楼扩展；摘要/CSE普通root推进不丢批；正文或身份变化迟到不写',async()=>{
  for(const change of ['head','body','chat']){
    let release,started;const wait=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);const h=await harness({generate:async()=>{started();await gate;return {changes:[]};}});
    const plan=await h.runtime.prepareHistoryPlan(), run=h.runtime.organize(plan);await wait;
    if(change==='head')h.source.root.headCheckpointId='new-summary-head';if(change==='body')h.chat[0].mes+='正文真的改了';if(change==='chat')h.setChat('other');release();await run;assert.equal((await h.store.read(CHAT)).batches.length,change==='head'?1:0,change);
  }
  const h=await harness({count:2});const plan=await h.runtime.prepareHistoryPlan();h.chat.push({is_user:false,mes:raw(2)},{is_user:true,mes:'继续'});await h.seal();await h.runtime.organize(plan);assert.equal(h.calls(),plan.apiCalls);assert.equal((await h.runtime.prepareHistoryPlan()).floorCount,1);
});

test('正文实际时间从raw自定义参考/嵌套保留取，不补现实年份；每批截止不是历史未来末楼',async()=>{
  const h=await harness({count:22,tags:'SceneTime',sanitizer:{keepTags:['keep']}});h.chat[0].mes='<outer><keep>阿岚受伤。</keep></outer><SceneTime>5月10日 08:00 → 5月11日 09:00</SceneTime>';await h.seal();const source=await h.body();assert.match(source.bodyFloors[0].content,/阿岚/);assert.equal(source.bodyFloors[0].observationTime.monthDay,11);assert.equal(source.bodyFloors[0].observationTime.year,null);
  const plan=await h.runtime.prepareHistoryPlan();const first=await prepareTimeRequest(source,[],{fragments:plan.groups[0]});assert.deepEqual(first.request.currentTime,plan.groups[0].at(-1).observationTime);assert.notEqual(first.request.currentTime.date,source.bodyFloors.at(-1).observationTime.date);
});

test('旧schema正常回放但coverage0；正文canonical严格、缺memoryId不能undefined误通过；人工旧材料不覆盖而新事实可更新',async()=>{
  const h=await harness({count:2});h.source.entities=[{id:PERSON,entityType:'person',displayName:'阿岚',aliases:[]}];const source=await h.body(),plan=planTimeBody(source,[],{history:true}),prepared=await prepareTimeRequest(source,[],{fragments:plan.groups[0]});
  const initial=await compileTimeResponse(bodyModel(prepared.request,{subjectEntityId:PERSON,type:'cycle',periodDays:28,progression:''}),prepared);
  const manual=await compileTimeEdit(initial.changes[0],{label:'人工名称',periodDays:5,status:'cancelled'},source,'manual');
  const same=await prepareTimeRequest(source,[initial,manual],{fragments:plan.groups[0]});const updated=await compileTimeResponse(bodyModel(same.request,{subjectEntityId:PERSON,itemId:manual.changes[0].id,type:'cycle',periodDays:28,label:'模型旧名',status:'active',progression:''}),same);
  assert.equal(updated.changes[0].label,'人工名称');assert.equal(updated.changes[0].periodDays,5);assert.equal(updated.changes[0].status,'cancelled');
  const newer=await prepareTimeRequest(source,[initial,manual],{fragments:[plan.groups[0][1]]});const fresh=await compileTimeResponse(bodyModel(newer.request,{subjectEntityId:PERSON,itemId:manual.changes[0].id,type:'cycle',periodDays:28,label:'新观察',progression:''}),newer);assert.equal(fresh.changes[0].label,'新观察');assert.equal(fresh.changes[0].previousObservationKey,manual.changes[0].observationKey);
  const legacy={...structuredClone(initial),dependencies:[{floorId:'floor-1',memoryId:'memory-1'}],bodyReads:undefined};const legacySource={...source,floorMemories:[{id:'memory-1',floorId:'floor-1',recordStatus:'active'}]};assert.equal(replayTimeBatches([legacy],legacySource).length,1);assert.equal(timeBodyReads([legacy],legacySource).size,0);
  assert.equal(replayTimeBatches([{...initial,dependencies:[{floorId:'floor-1'}]}],source).length,0);const changed=structuredClone(source);changed.floors[0].canonicalFingerprint='wrong';assert.equal(replayTimeBatches([initial],changed).length,0);
  const relative={...manual.changes[0],observationTime:projectTime('次日',projectTime('2026-05-10')),occurrenceTime:projectTime('昨天',projectTime('2026-05-11'))};const renamed=(await compileTimeEdit(relative,{label:'仅更名'},source,'rename')).changes[0];assert.deepEqual(renamed.observationTime,relative.observationTime);assert.deepEqual(renamed.occurrenceTime,relative.occurrenceTime);
});

test('分支仅有效前缀canonical、空changes成功覆盖；二次分支去manual断链不记checked，删尾与正文改动仅失效相关批',async()=>{
  const h=await harness({count:3});const source=await h.body(), groups=planTimeBody(source,[],{history:true}).groups[0];const batches=[];
  for(const fragment of groups){const prepared=await prepareTimeRequest(source,batches,{fragments:[fragment]});const batch=await compileTimeResponse({changes:[]},prepared,batches);batches.push(batch);await h.store.putBatch(CHAT,batch);}
  await h.store.putHead(CHAT,{schemaVersion:1,chatId:CHAT,batchIds:batches.map(batch=>batch.id),bodyStart:{floorId:'floor-1'}},0);
  await h.store.copyPrefix(CHAT,'child',h.source.floors.slice(0,2));const child=await h.store.read('child');assert.equal(child.batches.length,2);assert.equal(child.head.bodyStart.floorId,'floor-1');assert.equal(timeBodyReads(child.batches,{...source,floors:source.floors.slice(0,2)}).size,2);
  await h.store.copyPrefix('child','empty',[]);assert.equal((await h.store.read('empty')).batches.length,0);assert.equal((await h.store.read('empty')).head.lastAttemptTime,null);
  const changed=structuredClone(source);changed.floors[1].canonicalFingerprint='changed';assert.equal(timeBodyReads(batches,changed).size,2);
  const broken={...batches[1],changes:[{id:'missing-old',observationKey:'new',previousObservationKey:'manual-removed'}]};assert.equal(timeBodyReads([batches[0],broken],source).has('floor-2'),false);
});

test('完全重构单独授权全历史且CSE缺口不gate；无未读正文显式补算机会，成功同key仅一次，人工编辑重开',async()=>{
  const h=await harness({count:3});await h.runtime.authorizeHistory();assert.equal(h.runtime.getState().coverage.checkedFloors,3);
  const itemHost=await harness({count:2,generate:request=>request.observations.length?bodyModel(request,{progression:''}):{changes:[]}});await itemHost.runtime.organize(await itemHost.runtime.prepareHistoryPlan());let plan=await itemHost.runtime.prepareHistoryPlan();assert.equal(plan.supplement,true);await itemHost.runtime.organize(plan);assert.equal((await itemHost.runtime.prepareHistoryPlan()).apiCalls,0);
  const item=itemHost.runtime.getState().trackedItems[0];await itemHost.runtime.editItem(item.id,{label:'新人工名'},item.observationKey);assert.equal((await itemHost.runtime.prepareHistoryPlan()).apiCalls,1);
  const text=await readFile(new URL('../index.js',import.meta.url),'utf8');assert.match(text,/generateTimeTask: taskRouter.generateUtilityTask/);assert.doesNotMatch(text,/onMemoryBatchCommitted:.*timeRuntime/);
});

test('同楼分片两个新伤独立；继承NPC旧键沿显式itemId更新，后续实体同名不迁移旧链',async()=>{
  const h=await harness({count:1});const source=await h.body(), rows=planTimeBody(source,[],{history:true}).groups[0];let prepared=await prepareTimeRequest(source,[],{fragments:rows});const first=await compileTimeResponse(bodyModel(prepared.request,{progression:''}),prepared);
  prepared=await prepareTimeRequest(source,[first],{fragments:rows});const second=await compileTimeResponse(bodyModel(prepared.request,{label:'膝盖新伤',observation:'膝盖新伤',occurrenceTime:'今天',progression:''}),prepared);assert.notEqual(second.changes[0].id,first.changes[0].id);assert.equal(replayTimeBatches([first,second],source).length,2);
  const inherited={...source,root:{...source.root,chatId:'child'}};prepared=await prepareTimeRequest(inherited,[first],{fragments:rows});const update=await compileTimeResponse(bodyModel(prepared.request,{itemId:first.changes[0].id,progression:''}),prepared);assert.equal(update.changes[0].subjectEntityId,first.changes[0].subjectEntityId);assert.equal(update.changes[0].previousObservationKey,first.changes[0].observationKey);
  inherited.entities=[{id:PERSON,entityType:'person',displayName:'阿岚',aliases:[]}];prepared=await prepareTimeRequest(inherited,[first],{fragments:rows});const appeared=await compileTimeResponse(bodyModel(prepared.request,{subjectEntityId:PERSON,itemId:first.changes[0].id,progression:''}),prepared);assert.equal(appeared.changes[0].subjectEntityId,first.changes[0].subjectEntityId);
});

test('实际摘要API resolver接线，时间一批只走utility配置，不读analysis配置',async()=>{
  const {createTaskRouter}=await import('../src/api-routing.js');let utility=0,analysis=0;const router=createTaskRouter({resolver:{resolve:()=>{analysis++;return{kind:'independent',config:{model:'analysis'}};},resolveUtility:()=>{utility++;return{kind:'independent',config:{model:'summary'}};}},compactClient:{generateTask:async task=>{assert.equal(task.config.model,'summary');return {jsonData:{changes:[]}};}}});
  const h=await harness({generate:(_,__,task)=>router.generateUtilityTask(task)});await h.runtime.organize(await h.runtime.prepareHistoryPlan());assert.equal(utility,1);assert.equal(analysis,0);
});

test('停止在途零迟到batch，恢复只剩未读；旧key/空字段拒绝，保存head失败旧项保留且可重试，宿主UUID无需原生randomUUID',async()=>{
  let started,release;const begun=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);const h=await harness({generate:async()=>{started();await gate;return {changes:[]};}});const run=h.runtime.organize(await h.runtime.prepareHistoryPlan());await begun;const stopping=h.runtime.stop();release();await Promise.all([run,stopping]);assert.equal((await h.store.read(CHAT)).batches.length,0);assert.equal((await h.runtime.prepareHistoryPlan()).floorCount,2);
  const f=await harness({generate:bodyModel});await f.runtime.organize(await f.runtime.prepareHistoryPlan());const item=f.runtime.getState().trackedItems[0];await assert.rejects(f.runtime.editItem(item.id,{label:''},item.observationKey));await assert.rejects(f.runtime.editItem(item.id,{status:'paused'},'old-key'));
  let fail=true;const original=f.back.client.put;f.back.client.put=async(c,id,...args)=>{if(id==='v3-time-head'&&fail){fail=false;throw new Error('synthetic head failure');}return original(c,id,...args);};
  await assert.rejects(f.runtime.editItem(item.id,{label:'未写入'},item.observationKey));assert.equal(replayTimeBatches((await f.store.read(CHAT)).batches,await f.body())[0].label,item.label);
  const originalCrypto=globalThis.crypto;Object.defineProperty(globalThis,'crypto',{configurable:true,value:{subtle:originalCrypto.subtle}});try{await f.runtime.editItem(item.id,{label:'宿主UUID保存'},item.observationKey);}finally{Object.defineProperty(globalThis,'crypto',{configurable:true,value:originalCrypto});}
  assert.equal(f.runtime.getState().trackedItems[0].label,'宿主UUID保存');assert.equal(f.calls(),1);
});

test('正文canonical不变但raw时间注释在途改动拒绝；补算空fragment同样冻结当前时间见证；历史授权完成后新楼继续',async()=>{
  for(const supplement of [false,true]){
    let release,started;let phase='initial';const begun=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
    const h=await harness({generate:async request=>{if(phase==='initial')return bodyModel(request,{progression:''});started();await gate;return {changes:[]};}});
    if(supplement)await h.runtime.organize(await h.runtime.prepareHistoryPlan());phase='deferred';const before=await h.store.read(CHAT),plan=await h.runtime.prepareHistoryPlan(),run=h.runtime.organize(plan);await begun;
    const target=supplement?h.chat[2]:h.chat[0],canonical=(await h.body()).bodyFloors[supplement?1:0].canonicalFingerprint;target.mes=target.mes.replaceAll('2026-05-','2026-06-');assert.equal((await h.body()).bodyFloors[supplement?1:0].canonicalFingerprint,canonical);release();await run;assert.equal((await h.store.read(CHAT)).batches.length,before.batches.length);
  }
  const h=await harness({count:2});await h.runtime.authorizeHistory();assert.equal(h.calls(),1);h.chat.push({is_user:false,mes:raw(2)},{is_user:true,mes:'继续'});await h.seal();await h.runtime.runBatch();assert.equal(h.calls(),2);assert.equal(h.runtime.getState().coverage.checkedFloors,3);
});

test('来源ready且memory短sync自动照正文处理，无第二ready也不等CSE；关闭重开不join旧epoch启动读',async()=>{
  const h=await harness({count:1});h.setSync('syncing');const callbacks=new Set();h.runtime.bind({foundationRuntime:{subscribe:listener=>callbacks.add(listener)}});for(const callback of callbacks)callback({status:'ready'});await h.runtime.runBatch();assert.equal(h.calls(),1);h.setSync('idle');assert.equal(h.runtime.getState().trackedItems.length,0);
  const f=await harness({count:1});let release,started,first=true;const begun=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve),original=f.back.client.get;f.back.client.get=async(c,id)=>{if(id==='v3-time-head'&&first){first=false;started();await gate;}return original(c,id);};
  const old=f.runtime.runBatch();await begun;await f.runtime.stop();await f.runtime.runBatch();assert.equal(f.calls(),1);const written=JSON.stringify([...f.back.records]);release();await old;assert.equal(f.calls(),1);assert.equal(JSON.stringify([...f.back.records]),written);
});

test('仅正文时间标签修正使覆盖待补，原观察和人工字段/key不丢；重查成功恢复覆盖，无关排版不重查；分支现时间再核',async()=>{
  let model;const h=await harness({count:2,generate:request=>model?bodyModel(request,{subjectEntityId:model.subjectEntityId,itemId:null,type:'cycle',periodDays:28,label:'手腕擦伤',status:'active',progression:''}):bodyModel(request,{type:'cycle',periodDays:28,progression:''})});
  await h.runtime.organize(await h.runtime.prepareHistoryPlan());let item=h.runtime.getState().trackedItems[0];await h.runtime.editItem(item.id,{label:'人工名称',periodDays:5,status:'cancelled'},item.observationKey);model=(await h.store.read(CHAT)).batches.at(-1).changes[0];const oldKey=model.observationKey;
  h.chat[0].mes=h.chat[0].mes.replaceAll('2026-05-','2026-06-');let plan=await h.runtime.prepareHistoryPlan();assert.equal(plan.floorCount,1);assert.equal(replayTimeBatches((await h.store.read(CHAT)).batches,await h.body())[0].observationKey,oldKey);await h.runtime.organize(plan);item=replayTimeBatches((await h.store.read(CHAT)).batches,await h.body())[0];assert.equal(item.observationKey,oldKey);assert.equal(item.label,'人工名称');assert.equal(item.periodDays,5);assert.equal(item.status,'cancelled');assert.equal((await h.runtime.prepareHistoryPlan()).floorCount,0);
  const collisionPrepared=await prepareTimeRequest(await h.body(),(await h.store.read(CHAT)).batches,{fragments:plan.groups[0]});collisionPrepared.request.trackedItems=[];collisionPrepared.trackedRecords=[];
  const budgetOmitted=await compileTimeResponse(bodyModel(collisionPrepared.request,{itemId:null,type:'cycle',periodDays:28,label:'手腕擦伤',status:'active',progression:''}),collisionPrepared);assert.equal(budgetOmitted.changes[0].observationKey,oldKey);assert.equal(budgetOmitted.changes[0].status,'cancelled');
  h.chat[0].mes+='<!-- layout-only -->';assert.equal((await h.runtime.prepareHistoryPlan()).floorCount,0);
  await h.store.copyPrefix(CHAT,'child',h.source.floors);const copied=await h.store.read('child'),body=await h.body();assert.equal(timeBodyReads(copied.batches,body).size,2);body.floors[0].timeSourceFingerprint='different-child-clock';assert.equal(timeBodyReads(copied.batches,body).has('floor-1'),false);
});

test('确认停留期间当前楼已被自动成功读过，原冻结历史计划只发尚未读片段，不重复付费检查',async()=>{
  const received=[];const h=await harness({count:2,generate:request=>{received.push(request.observations.map(row=>row.floorId));return {changes:[]};}});const plan=await h.runtime.prepareHistoryPlan();await h.runtime.runBatch();assert.deepEqual(received[0],['floor-2']);await h.runtime.organize(plan);assert.deepEqual(received[1],['floor-1']);assert.equal((await h.runtime.prepareHistoryPlan()).apiCalls,0);
});

test('无新观察推算不能复活人工停止项或改名称周期；明确local旧itemId可省姓名仍沿旧主体',async()=>{
  const h=await harness({count:2}),source=await h.body(),rows=planTimeBody(source,[],{history:true}).groups[0],prepared=await prepareTimeRequest(source,[],{fragments:rows});const initial=await compileTimeResponse(bodyModel(prepared.request,{type:'cycle',periodDays:28,progression:''}),prepared),manual=await compileTimeEdit(initial.changes[0],{label:'人工名称',periodDays:5,status:'cancelled'},source,'manual');
  const next=await prepareTimeRequest(source,[initial,manual],{allowInitialProjection:true});const old=manual.changes[0];assert.equal(next.shouldRequest,false);const result=await compileTimeResponse({changes:[{itemId:old.id,subjectEntityId:old.subjectEntityId,type:'cycle',status:'active',sourceKeys:[],label:'旧名',periodDays:28,progression:'错误推算'}]},next);assert.equal(result.changes[0].label,'人工名称');assert.equal(result.changes[0].periodDays,5);assert.equal(result.changes[0].status,'cancelled');assert.equal(result.changes[0].projection,null);
});

test('默认先读当前完成项再补旧疼痛，旧历史保较新观察/停止key；未来证据抑制即使空changes也带依赖，过去分支待补',async()=>{
  for(const empty of [false,true]){
    let old;const h=await harness({count:2,generate:request=>old?empty?{changes:[]}:bodyModel(request,{itemId:old.id,subjectEntityId:old.subjectEntityId,status:'active',observation:'旧楼手腕仍疼痛'}):bodyModel(request,{status:'completed',observation:'当前手腕已恢复',progression:''})});
    h.chat[0].mes=raw(0,'阿岚手腕仍疼痛。');h.chat[2].mes=raw(1,'阿岚手腕已恢复。');await h.seal();await h.runtime.runBatch();old=(await h.store.read(CHAT)).batches[0].changes[0];assert.equal(old.observationTime.date,'2026-05-02');
    await h.runtime.organize(await h.runtime.prepareHistoryPlan());const stored=await h.store.read(CHAT),current=replayTimeBatches(stored.batches,await h.body())[0];assert.equal(current.status,'completed');assert.equal(current.observationKey,old.observationKey);assert.deepEqual(current.observationTime,old.observationTime);assert.equal(h.runtime.getState().coverage.checkedFloors,2);
    assert.ok(stored.batches[1].dependencies.some(ref=>ref.floorId==='floor-2'),'已发送的未来tracked证据必须成为依赖，空changes也不能冒充独立前楼检查');await h.store.copyPrefix(CHAT,`past-${empty}`,h.source.floors.slice(0,1));assert.equal((await h.store.read(`past-${empty}`)).batches.length,0);assert.equal(timeBodyReads((await h.store.read(`past-${empty}`)).batches,{...(await h.body()),floors:(await h.body()).floors.slice(0,1)}).size,0);
  }
});

test('观察F1但生成/人工批截止F2的未来上下文，旧F1重查不清当前projection；空changes也依赖F2防过去分支丢项',async()=>{
  const h=await harness({count:2,generate:bodyModel});await h.runtime.organize(await h.runtime.prepareHistoryPlan());const original=(await h.store.read(CHAT)).batches[0],old=original.changes[0];assert.equal(old.sourceRefs[0].floorId,'floor-1');assert.equal(old.projection.applicableFloorId,'floor-2');
  const source=await h.body(),row=planTimeBody(source,[],{history:true}).groups[0][0],prepared=await prepareTimeRequest(source,[original],{fragments:[row]});const empty=await compileTimeResponse({changes:[]},prepared);assert.ok(empty.dependencies.some(ref=>ref.floorId==='floor-2'));
  const unchanged=await compileTimeResponse(bodyModel(prepared.request,{itemId:old.id,subjectEntityId:old.subjectEntityId,progression:''}),prepared);assert.deepEqual(unchanged.changes[0].projection,old.projection);assert.ok(unchanged.dependencies.some(ref=>ref.floorId==='floor-2'));
  await h.store.putBatch(CHAT,empty);const stored=await h.store.read(CHAT);await h.store.putHead(CHAT,{...stored.head,batchIds:[...stored.head.batchIds,empty.id]},stored.revision);await h.store.copyPrefix(CHAT,'past-origin',h.source.floors.slice(0,1));assert.equal((await h.store.read('past-origin')).batches.length,0);
});
