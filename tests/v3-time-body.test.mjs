import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { scanAssistantCandidates, createFloorRecord } from '../src/v3/foundation-domain.js';
import { readTimeBody, planTimeBody, timeBodyStart } from '../src/v3/time-body.js';
import { createTimeRuntime, createTimeStore, prepareTimeRequest } from '../src/v3/time-runtime.js';
import { compileTimeResponse, compileTimeEdit, replayTimeBatches, timeBodyReads, timeItemFailures, projectTime, validTimeProjection, timeRecallProjection, TIME_INPUT_TOKENS, TIME_SYSTEM_PROMPT } from '../src/v3/time-engine.js';
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
const reviewModel = (request,patch={}) => ({changes:request.trackedItems.map(item=>({itemId:item.id,progression:'截至当前可能仍有轻微不适，未确认恢复。',assessmentReason:'',...patch}))});
const bodyModel = (request,patch={}) => request.currentReview ? reviewModel(request,patch) : ({changes:[{itemId:null,subjectEntityId:null,subjectName:'阿岚',type:'body',label:'手腕擦伤',observation:'手腕擦伤仍疼痛',occurrenceTime:'昨天',dueTime:'',periodDays:null,status:'active',stateRefs:[],progression:'疼痛可能逐渐减轻，仍待新观察确认',sourceKeys:[request.observations[0].sourceKey],...patch}]});
const rankedItem = (id,{type='deadline',label=id,observation=label,dueTime='',status='active',projection=null}={}) => ({
  id,subjectEntityId:PERSON,subjectName:'阿岚',type,label,status,observation,observationKey:`key-${id}`,
  observationTime:projectTime('2026-05-01'),occurrenceTime:projectTime('2026-05-01'),dueTime:projectTime(dueTime),periodDays:null,sourceRefs:[],stateRefs:[],projection,
});
const rankedSeed = (source,changes,{id='rank-seed',cutoff=source.bodyFloors[0]}={}) => ({schemaVersion:1,chatId:CHAT,id,signature:id,currentTime:cutoff.observationTime,
  cutoffFloorId:cutoff.floorId,cutoffAssistantSeq:cutoff.assistantSeq,sourceKeys:[],dependencies:[],bodyReads:[],changes});

test('召回时钟取未摘要可见正文；覆盖49变50不推进时间，同root正文或默认swipe变化不复用旧缓存', async () => {
  const h = await harness({ count: 50 });
  h.chat[96].mes = '<Ti>7月19日 20:30</Ti>此前正文。';
  h.chat[98].mes = '<Ti>7月19日 21:40</Ti>最新正文。';
  await h.seal();
  const refs = h.source.floors.map(floor => ({ floorId: floor.id, assistantSeq: floor.assistantSeq }));
  const recall = { status: 'ready', chatId: CHAT, headCheckpointId: 'head', rootRevision: 1, bodyMatchRefs: refs.slice(0,49), floorMemories: [], entities: [], currentState: [], cseChanges: [], identityProjection: {} };
  const first = await h.runtime.recallProjection(recall);
  assert.equal(first.currentTime.clock, '21:40');
  assert.equal(first.currentBodyWitness.hostLocator.messageIndex, 98);
  recall.bodyMatchRefs = refs; recall.headCheckpointId = 'summary-50'; recall.rootRevision = 2;
  const complete = await h.runtime.recallProjection(recall);
  assert.deepEqual(complete.currentTime, first.currentTime);
  assert.equal(complete.fingerprint, first.fingerprint);
  h.chat[98].mes = '<Ti>7月19日 22:10</Ti>最新正文改动。';
  assert.equal((await h.runtime.recallProjection(recall)).currentTime.clock, '22:10');
  h.chat[98].swipes = [h.chat[98].mes];
  assert.equal((await h.runtime.recallProjection(recall)).currentTime.clock, '22:10');
  h.chat[98].swipes[0] = '<Ti>7月19日 22:40</Ti>默认swipe正文改动。';
  assert.equal((await h.runtime.recallProjection(recall)).currentTime.clock, '22:40');
  h.chat[98].is_hidden = true;
  assert.equal((await h.runtime.recallProjection(recall)).currentTime.clock, '20:30');
  assert.equal(h.calls(), 0);
});

test('无摘要/CSE正文、新NPC由真实scanner登记，独立召回和楼内参考可见，人工编辑保正文依赖',async()=>{
  const h=await harness({generate:bodyModel}); const plan=await h.runtime.prepareHistoryPlan(); assert.equal(h.calls(),0); await h.runtime.organize(plan);assert.equal(h.calls(),2);
  const stored=await h.store.read(CHAT), body=await h.body(), item=replayTimeBatches(stored.batches,body)[0];assert.equal(item.subjectName,'阿岚');assert.match(item.subjectEntityId,/^time-person-/);assert.equal(item.projection.text,'截至当前可能仍有轻微不适，未确认恢复。');
  assert.equal(h.runtime.getState().coverage.checkedFloors,2);assert.equal(h.source.floorMemories.length,0);assert.equal(h.source.entities.length,0);
  const recall={status:'ready',chatId:CHAT,headCheckpointId:'head',rootRevision:1,bodyMatchRefs:h.source.floors.map(floor=>({floorId:floor.id,assistantSeq:floor.assistantSeq})),floorMemories:[],entities:[],currentState:[],cseChanges:[],identityProjection:{},coverage:{memoryComplete:false,cseCurrent:false},bodyMatch:{visibleFloorIds:[],summaryCoveredFloorIds:[]}};
  recall.timeProjection=await h.runtime.recallProjection(recall);assert.match(recall.timeProjection.reminders[0].text,/阿岚/);
  const selected=selectRecall({source:recall,queryContext:buildRecallQueryContext({coreChat:[{is_user:true,mes:'现在怎么样'}]}),contextSize:8192});assert.match(selected.injectionText,/阿岚.*手腕擦伤/);
  assert.equal(projectInlineRecallReceipt({schemaVersion:11,status:selected.status,injectionText:selected.injectionText,selectedFloors:selected.floors,selectedStates:selected.states}).timeReferenceCount,1);
  await h.runtime.editItem(item.id,{label:'人工名称'},item.observationKey);const edited=(await h.store.read(CHAT)).batches.at(-1);assert.equal(edited.dependencies[0].canonicalFingerprint,item.sourceRefs[0].canonicalFingerprint);assert.equal(h.calls(),2);
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
  const h=await harness({count:2});const plan=await h.runtime.prepareHistoryPlan();h.chat.push({is_user:false,mes:raw(2)},{is_user:true,mes:'继续'});await h.seal();await h.runtime.organize(plan);assert.equal(h.calls(),plan.bodyBatchCount);assert.equal((await h.runtime.prepareHistoryPlan()).floorCount,1);
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
  const itemHost=await harness({count:2,generate:request=>request.currentReview?reviewModel(request):bodyModel(request,{progression:''})});await itemHost.runtime.organize(await itemHost.runtime.prepareHistoryPlan());let plan=await itemHost.runtime.prepareHistoryPlan();assert.equal(plan.apiCalls,0);
  const item=itemHost.runtime.getState().trackedItems[0];await itemHost.runtime.editItem(item.id,{label:'新人工名'},item.observationKey);assert.equal((await itemHost.runtime.prepareHistoryPlan()).apiCalls,1);
  const text=await readFile(new URL('../index.js',import.meta.url),'utf8');assert.match(text,/generateTimeTask: taskRouter.generateUtilityTask/);assert.doesNotMatch(text,/onMemoryBatchCommitted:.*timeRuntime/);
});

test('同楼分片两个新伤独立；继承NPC旧键沿显式itemId更新，后续实体同名不迁移旧链',async()=>{
  const h=await harness({count:1});const source=await h.body(), rows=planTimeBody(source,[],{history:true}).groups[0];let prepared=await prepareTimeRequest(source,[],{fragments:rows});const first=await compileTimeResponse(bodyModel(prepared.request,{progression:''}),prepared);
  prepared=await prepareTimeRequest(source,[first],{fragments:rows});const second=await compileTimeResponse(bodyModel(prepared.request,{label:'膝盖新伤',observation:'膝盖新伤',occurrenceTime:'今天',progression:''}),prepared);assert.notEqual(second.changes[0].id,first.changes[0].id);assert.equal(replayTimeBatches([first,second],source).length,2);
  const inherited={...source,root:{...source.root,chatId:'child'}};prepared=await prepareTimeRequest(inherited,[first],{fragments:rows});const update=await compileTimeResponse(bodyModel(prepared.request,{itemId:first.changes[0].id,progression:''}),prepared);assert.equal(update.changes[0].subjectEntityId,first.changes[0].subjectEntityId);assert.equal(update.changes[0].previousObservationKey,first.changes[0].observationKey);
  inherited.entities=[{id:PERSON,entityType:'person',displayName:'阿岚',aliases:[]},{id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',entityType:'person',displayName:'阿岚',aliases:[]}];prepared=await prepareTimeRequest(inherited,[first],{fragments:rows});const appeared=await compileTimeResponse(bodyModel(prepared.request,{subjectEntityId:PERSON,itemId:first.changes[0].id,progression:''}),prepared);assert.equal(appeared.changes[0].subjectEntityId,first.changes[0].subjectEntityId);
});

test('人物目录同名由有效ID消歧；无ID或ID姓名相悖单项隔离并保合法项',async()=>{
  const h=await harness({count:1}),source=await h.body(),other='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  source.entities=[{id:PERSON,entityType:'person',displayName:'阿岚',aliases:['小岚']},{id:other,entityType:'person',displayName:'阿岚',aliases:['阿夏']}];
  const rows=planTimeBody(source,[],{history:true}).groups[0],prepared=await prepareTimeRequest(source,[],{fragments:rows});
  const change=patch=>bodyModel(prepared.request,{progression:'',...patch}).changes[0];
  const validPerson=change({subjectEntityId:PERSON,subjectName:'阿岚',label:'甲方事项'});
  const ambiguous=change({subjectEntityId:null,subjectName:'阿岚',label:'姓名歧义事项'});
  const validOther=change({subjectEntityId:other,subjectName:'阿岚',label:'乙方事项'});
  const conflicting=change({subjectEntityId:PERSON,subjectName:'阿夏',label:'身份冲突事项'});
  const partial=await compileTimeResponse({changes:[validPerson,ambiguous,validOther,conflicting]},prepared);
  assert.equal(partial.status,'partial');assert.deepEqual(partial.changes.map(item=>item.subjectEntityId),[PERSON,other]);assert.deepEqual(partial.itemErrors,[{index:2,reason:'时间事项人物归属不明确。'},{index:4,reason:'时间事项人物归属不明确。'}]);assert.deepEqual(partial.bodyReads,[]);
  await assert.rejects(compileTimeResponse({changes:[ambiguous]},prepared),error=>error.code==='QQJ_TIME_INVALID'&&error.itemErrors[0].reason==='时间事项人物归属不明确。');
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
  assert.equal(f.runtime.getState().trackedItems[0].label,'宿主UUID保存');assert.equal(f.calls(),2);
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


test('短来源与完整键精确等价，未知单项隔离，全坏与顶层坏仍失败，空成功覆盖',async()=>{
  const h=await harness(),source=await h.body(),fragments=planTimeBody(source,[],{history:true}).groups[0];
  const prepared=await prepareTimeRequest(source,[],{fragments});assert.deepEqual(prepared.request.observations.map(row=>row.sourceKey),['S1','S2']);
  const short=await compileTimeResponse(bodyModel(prepared.request),prepared);
  const full=await compileTimeResponse(bodyModel(prepared.request,{sourceKeys:[prepared.sourceKeys[0]]}),prepared);
  assert.deepEqual(short.changes,full.changes);assert.equal(short.changes[0].sourceRefs[0].sourceKey,prepared.sourceKeys[0]);
  const bad={...bodyModel(prepared.request).changes[0],sourceKeys:['S99']};
  const partial=await compileTimeResponse({changes:[bodyModel(prepared.request).changes[0],bad]},prepared);
  assert.equal(partial.status,'partial');assert.equal(partial.changes.length,1);assert.deepEqual(partial.bodyReads,[]);
  assert.deepEqual(partial.itemErrors,[{index:2,reason:'来源编号未在本次请求中出现。'}]);assert.equal(timeBodyReads([partial],source).size,0);
  assert.equal(replayTimeBatches([partial],source).length,1);assert.ok(partial.dependencies.some(ref=>ref.floorId==='floor-1'));
  await assert.rejects(compileTimeResponse({changes:[bad]},prepared),error=>error.code==='QQJ_TIME_INVALID'&&error.itemErrors[0].index===1);
  await assert.rejects(compileTimeResponse({changes:null},prepared));await assert.rejects(compileTimeResponse('not JSON',prepared));
  const programError={get type(){throw new TypeError('internal');}};await assert.rejects(compileTimeResponse({changes:[bodyModel(prepared.request).changes[0],programError]},prepared),TypeError);
  const empty=await compileTimeResponse({changes:[]},prepared);assert.equal(empty.status,undefined);assert.equal(timeBodyReads([empty],source).size,2);
});

test('partial续查来源重编号与数组换序保真实ID/观察及人工停止，遗漏旧项不删除，分支保来源',async()=>{
  const h=await harness({count:3}),source=await h.body(),rows=planTimeBody(source,[],{history:true}).groups[0];
  let prepared=await prepareTimeRequest(source,[],{fragments:rows.slice(1)});
  const initial=await compileTimeResponse({changes:[bodyModel(prepared.request,{sourceKeys:['S1','S2']}).changes[0],bodyModel(prepared.request,{sourceKeys:['unknown']}).changes[0]]},prepared);
  const manual=await compileTimeEdit(initial.changes[0],{label:'人工保留',status:'paused'},source,'manual');
  prepared=await prepareTimeRequest(source,[initial,manual],{fragments:rows});
  const retry=await compileTimeResponse(bodyModel(prepared.request,{sourceKeys:['S3','S2'],observation:'模型换了说法'}),prepared,[initial,manual]);
  assert.equal(retry.changes[0].id,initial.changes[0].id);assert.equal(retry.changes[0].observationKey,manual.changes[0].observationKey);
  assert.equal(retry.changes[0].label,'人工保留');assert.equal(retry.changes[0].status,'paused');assert.equal(replayTimeBatches([initial,manual,retry],source).length,1);
  const empty=await compileTimeResponse({changes:[]},prepared,[initial,manual]);assert.equal(replayTimeBatches([initial,manual,empty],source).length,1);
  await h.store.putBatch(CHAT,initial);await h.store.putHead(CHAT,{schemaVersion:1,chatId:CHAT,batchIds:[initial.id]},0);
  await h.store.copyPrefix(CHAT,'child',source.floors);const child=await h.store.read('child');assert.equal(child.batches[0].status,'partial');assert.equal(child.head.lastRun.status,'partial');assert.equal(child.head.lastRun.cutoffFloorId,child.batches[0].cutoffFloorId);assert.equal(timeBodyReads(child.batches,source).size,0);
  await h.store.copyPrefix(CHAT,'short-child',source.floors.slice(0,1));assert.equal((await h.store.read('short-child')).batches.length,0);
});

test('partial停批与后台/重载守卫，手动续查合法旧项保留，saving阶段与存储异常如实失败',async()=>{
  let h;h=await harness({count:25,generate:async(request,calls)=>{
    if(calls===1){void h.runtime.runBatch();return {changes:[bodyModel(request).changes[0],bodyModel(request,{sourceKeys:['S99']}).changes[0]]};}
    return request.currentReview ? reviewModel(request) : {changes:[]};
  }});
  const phases=[];h.runtime.subscribe(state=>phases.push(state.phase));await h.runtime.organize(await h.runtime.prepareHistoryPlan());
  await new Promise(resolve=>setImmediate(resolve));assert.equal(h.calls(),1);assert.ok(phases.includes('saving'));
  let stored=await h.store.read(CHAT);assert.equal(stored.head.lastRun.status,'partial');assert.equal(stored.batches.length,1);assert.equal(h.runtime.getState().coverage.checkedFloors,0);assert.match(h.runtime.getState().last.message,/第2项/);
  await h.runtime.runBatch();h.reload();await h.runtime.runBatch();await h.runtime.refreshStatus({force:true});assert.equal(h.calls(),1);assert.equal(h.runtime.getState().last.status,'partial');
  await h.runtime.organize(await h.runtime.prepareHistoryPlan());stored=await h.store.read(CHAT);assert.equal(stored.head.lastRun.status,'completed');assert.equal(replayTimeBatches(stored.batches,await h.body()).length,1);assert.equal((await h.runtime.prepareHistoryPlan()).floorCount,0);
  const broken=await harness({generate:request=>({changes:[bodyModel(request).changes[0],bodyModel(request,{sourceKeys:['S99']}).changes[0]]})});
  broken.back.client.put=async(c,id,data,revision,options)=>{if(id.startsWith('v3-time-batch-'))throw new Error('storage failed');const key=`${c}/${id}`;const result={data:structuredClone(data),revision:revision+1};broken.back.records.set(key,result);return result;};await broken.runtime.organize(await broken.runtime.prepareHistoryPlan());assert.equal(broken.runtime.getState().last.status,'failed');assert.equal((await broken.store.read(CHAT)).batches.length,0);
});

test('partial同正文不自动重发，新增正文仍正常处理且保留先前成功项',async()=>{
  const h=await harness({count:1,generate:(request,calls)=>{
    if(calls===1)return {changes:[bodyModel(request).changes[0],bodyModel(request,{sourceKeys:['S99']}).changes[0]]};
    const next=bodyModel(request,{subjectName:'沈砚',label:'膝伤',observation:'沈砚膝伤仍疼痛'});
    next.changes[0].sourceKeys=[request.observations.at(-1).sourceKey];return next;
  }});
  await h.runtime.runBatch();let stored=await h.store.read(CHAT);assert.equal(stored.head.lastRun.status,'partial');assert.equal(h.calls(),1);
  await h.runtime.runBatch();h.reload();await h.runtime.runBatch();await h.runtime.refreshStatus({force:true});assert.equal(h.calls(),1,'同一正文的partial不得自动重发');
  h.chat.push({is_user:false,mes:raw(1,'沈砚膝伤仍疼痛。')},{is_user:true,mes:'继续'});await h.seal();await h.runtime.runBatch();
  stored=await h.store.read(CHAT);assert.equal(h.calls(),2,'真实新增正文应继续一次正常请求');assert.equal(stored.head.lastRun.status,'completed');
  assert.deepEqual(replayTimeBatches(stored.batches,await h.body()).map(item=>item.label).sort(),['手腕擦伤','膝伤']);
  await h.runtime.runBatch();assert.equal(h.calls(),2,'新正文处理完成后重复通知仍不额外请求');
});

test('旧partial按原截止楼恢复尝试范围，不把升级后新增正文误标为已处理',async()=>{
  const h=await harness({count:1,generate:(request,calls)=>{
    if(calls===1)return {changes:[bodyModel(request).changes[0],bodyModel(request,{sourceKeys:['S99']}).changes[0]]};
    const next=bodyModel(request,{subjectName:'沈砚',label:'膝伤',observation:'沈砚膝伤仍疼痛',progression:''});next.changes[0].sourceKeys=[request.observations.at(-1).sourceKey];return next;
  }});
  await h.runtime.runBatch();let stored=await h.store.read(CHAT);assert.equal(stored.head.lastRun.status,'partial');assert.equal(h.calls(),1);
  const legacy={...stored.head,lastRun:{...stored.head.lastRun}};delete legacy.lastRun.sourceScope;await h.store.putHead(CHAT,legacy,stored.revision);
  h.chat.push({is_user:false,mes:raw(1,'沈砚膝伤仍疼痛。')},{is_user:true,mes:'继续'});await h.seal();h.reload();await h.runtime.runBatch();
  stored=await h.store.read(CHAT);assert.equal(h.calls(),2);assert.equal(stored.head.lastRun.cutoffFloorId,'floor-2');
  await h.runtime.runBatch();assert.equal(h.calls(),2,'升级迁移后的同一新正文不得再次请求');
});


test('无新正文当前收尾partial保明确手动重试机会，完整成功才完成',async()=>{
  const h=await harness({generate:(request,calls)=>request.currentReview ? calls===2 ? {changes:[{...reviewModel(request).changes[0],assessmentReason:'时间依据不足',progression:''},{itemId:'unknown',progression:'无效'}]} : reviewModel(request) : bodyModel(request,{progression:''})});
  await h.runtime.organize(await h.runtime.prepareHistoryPlan());let stored=await h.store.read(CHAT);
  assert.equal(stored.head.lastRun.status,'partial');assert.equal(stored.head.lastRun.initialProjectionCheckedSignature,undefined);assert.equal(h.calls(),2);
  await h.runtime.runBatch();assert.equal(h.calls(),2);h.reload();let plan=await h.runtime.prepareHistoryPlan();assert.equal(plan.supplement,true);assert.equal(plan.retryCurrentReview,true);assert.equal(plan.apiCalls,1);
  await h.runtime.organize(plan);stored=await h.store.read(CHAT);assert.equal(h.calls(),3);assert.equal(stored.head.lastRun.status,'completed');assert.equal((await h.runtime.prepareHistoryPlan()).apiCalls,0);assert.equal(h.runtime.getState().trackedItems.length,1);
});


async function seedTimeItems(h,count=19,{paused=0,observation='仍有局部不适'}={}) {
  const source=await h.body(),fragments=planTimeBody(source,[],{history:true}).groups.flat();const batches=[];
  for(let from=0;from<count;from+=40){const prepared=await prepareTimeRequest(source,batches,{fragments});const batch=await compileTimeResponse({changes:Array.from({length:Math.min(40,count-from)},(_,i)=>bodyModel(prepared.request,{label:`事项${from+i}`,observation,status:from+i<paused?'paused':'active',progression:''}).changes[0])},prepared,batches);batch.id=`seed-${from}`;batches.push(batch);await h.store.putBatch(CHAT,batch);}
  await h.store.putHead(CHAT,{schemaVersion:1,chatId:CHAT,batchIds:batches.map(batch=>batch.id)},0);return {source,batches};
}

test('partial错误精确挂到事项，人工编辑保留、移除收敛，后续模型成功清除',async()=>{
  const partialReply=request=>({changes:reviewModel(request).changes.map((change,index)=>index?{...change,sourceKeys:['S1']}:change)});
  const removed=await harness({generate:partialReply});await seedTimeItems(removed,3);await removed.runtime.organize(await removed.runtime.prepareHistoryPlan());
  let state=removed.runtime.getState(),failed=state.trackedItems.find(item=>item.failureReason);assert.equal(state.last.status,'partial');assert.match(failed.failureReason,/当前评估只能更新/);
  await removed.runtime.editItem(failed.id,{label:'人工保留的名称'},failed.observationKey);state=removed.runtime.getState();failed=state.trackedItems.find(item=>item.id===failed.id);assert.equal(failed.label,'人工保留的名称');assert.ok(failed.failureReason,'人工编辑不能冒充模型评估成功');
  await removed.runtime.editItem(failed.id,{status:'cancelled'},failed.observationKey);state=removed.runtime.getState();assert.equal(state.last.status,'partial','移除一个失败项不能清掉另一个失败');assert.equal(state.stoppedItems.find(item=>item.id===failed.id).failureReason,null);
  const remaining=state.trackedItems.find(item=>item.failureReason);await removed.runtime.editItem(remaining.id,{status:'cancelled'},remaining.observationKey);state=removed.runtime.getState();assert.equal(state.last.status,'completed');assert.match(state.last.message,/未完成事项已移除/);

  let call=0;const retried=await harness({generate:request=>++call===1?partialReply(request):reviewModel(request)});const retrySeed=await seedTimeItems(retried,2);await retried.runtime.organize(await retried.runtime.prepareHistoryPlan());
  const partial=(await retried.store.read(CHAT)).batches.at(-1),legacy=structuredClone(partial);delete legacy.resolvedItemIds;for(const error of legacy.itemErrors)delete error.itemIds;
  assert.equal(timeItemFailures([...retrySeed.batches,legacy],retrySeed.source).size,1,'旧currentReview可由真实选中集合推导失败事项');
  await retried.runtime.organize(await retried.runtime.prepareHistoryPlan());assert.equal(retried.runtime.getState().trackedItems.some(item=>item.failureReason),false,'后续有效模型评估应清除失败标记');

  const unknown=await harness({generate:request=>({changes:[reviewModel(request).changes[0],{itemId:'unknown',progression:'无效',assessmentReason:''}]})});await seedTimeItems(unknown,2);await unknown.runtime.organize(await unknown.runtime.prepareHistoryPlan());
  state=unknown.runtime.getState();const beforeCoverage=structuredClone(state.coverage),knownFailure=state.trackedItems.find(item=>item.failureReason);assert.equal(state.last.status,'partial');
  await unknown.runtime.editItem(knownFailure.id,{status:'cancelled'},knownFailure.observationKey);state=unknown.runtime.getState();assert.equal(state.last.status,'partial','无法定位的错误必须保留批次partial');assert.deepEqual(state.coverage,beforeCoverage,'人工移除不能把正文覆盖缺口写平');
});

test('历史N批加一次收尾，19active逐项评估，冻结稳定当前不被未稳定新尾楼阻止',async()=>{
  const requests=[];const h=await harness({count:25,unstable:true,generate:request=>{requests.push(request);return request.currentReview?reviewModel(request):bodyModel(request,{label:`第${request.observations[0].assistantSeq}项`,progression:''});}});
  const plan=await h.runtime.prepareHistoryPlan();assert.equal(plan.apiCalls,plan.bodyBatchCount+1);assert.equal(plan.currentWitness.assistantSeq,24);
  await h.runtime.organize(plan);assert.equal(h.calls(),plan.apiCalls);assert.equal(requests.filter(request=>request.currentReview).length,1);assert.equal(requests.at(-1).observations.length,0);assert.equal(requests.at(-1).context.length,0);assert.equal(requests.at(-1).cutoffFloorId,'floor-24');
  assert.equal(h.runtime.getState().coverage.pendingFloors,1);assert.equal((await h.store.read(CHAT)).head.currentReviewAttempt.status,'completed');
  const old=await harness({generate:reviewModel});await seedTimeItems(old,19);const one=await old.runtime.prepareHistoryPlan();assert.equal(one.apiCalls,1);assert.equal(one.bodyBatchCount,0);await old.runtime.organize(one);
  const stored=await old.store.read(CHAT);assert.equal(stored.batches.at(-1).currentReview.updated,19);assert.equal(stored.batches.at(-1).changes.length,19);assert.equal(old.runtime.getState().trackedItems.filter(item=>item.projection).length,19);
  await old.runtime.organize(one);old.reload();await old.runtime.runBatch();assert.equal(old.calls(),1);assert.equal((await old.runtime.prepareHistoryPlan()).apiCalls,0);
});

test('收尾排除停止项，最多现40项/预算优先且遗漏可见，未知时间说明不足，保人工字段',async()=>{
  const h=await harness();const {source,batches}=await seedTimeItems(h,45,{paused:2});
  let prepared=await prepareTimeRequest(source,batches,{currentReview:true,allowInitialProjection:true});assert.equal(prepared.trackedRecords.length,40);assert.equal(prepared.omitted,3);assert.ok(prepared.trackedRecords.every(item=>item.status==='active'));assert.ok(estimateRecallTokens(prepared.systemPrompt+JSON.stringify(prepared.request))<=30000);
  const batch=await compileTimeResponse(reviewModel(prepared.request,{progression:'',assessmentReason:'没有后续观察，无法判断。'}),prepared,batches);assert.equal(batch.currentReview.insufficient,40);assert.equal(batch.currentReview.omitted,3);assert.equal(batch.changes[0].observationKey,prepared.trackedRecords[0].observationKey);
  prepared=await prepareTimeRequest(source,batches,{currentReview:true,allowInitialProjection:true,inputTokens:1500});assert.ok(prepared.omitted>3);assert.ok(estimateRecallTokens(prepared.systemPrompt+JSON.stringify(prepared.request))<=1500);
  const first=batches[0].changes[2],manual=await compileTimeEdit(first,{label:'人工名称',periodDays:7,status:'active'},source,'manual'),manualBatches=[batches[0],manual];prepared=await prepareTimeRequest(source,manualBatches,{currentReview:true,allowInitialProjection:true});
  const reviewed=await compileTimeResponse(reviewModel(prepared.request,{label:'错误改名',observation:'模型新事实',occurrenceTime:'今天',periodDays:28,status:'completed'}),prepared,manualBatches);const changed=reviewed.changes.find(item=>item.id===first.id);assert.equal(changed.label,'人工名称');assert.equal(changed.observation,manual.changes[0].observation);assert.equal(changed.periodDays,7);assert.equal(changed.status,'active');
  const unknown=structuredClone(source);unknown.bodyTimes=new Map(unknown.floors.map(floor=>[floor.id,projectTime('')]));unknown.bodyFloors=unknown.bodyFloors.map(body=>({...body,observationTime:projectTime('')}));prepared=await prepareTimeRequest(unknown,batches,{currentReview:true,allowInitialProjection:true});const noTime=await compileTimeResponse(reviewModel(prepared.request),prepared,batches);assert.ok(noTime.changes.every(item=>item.reviewAssessment&&!item.projection));
});

test('时间事项按当前正文相关性、临近日期和待评估状态排序，不给身体零间隔或未知日期假到期',async()=>{
  const h=await harness({count:2}),source=await h.body(),cutoff=source.bodyFloors.at(-1);
  const items=[
    rankedItem('unrelated',{label:'整理旧书',observation:'整理旧书架',dueTime:'2026-05-20'}),
    rankedItem('body',{type:'body',label:'肩膀状态',observation:'肩膀仍需观察',dueTime:'2026-05-02'}),
    rankedItem('near',{label:'临近归还',observation:'归还借物',dueTime:'2026-05-03'}),
    rankedItem('relevant',{label:'手腕复查',observation:'手腕擦伤复查安排',dueTime:'2026-05-20'}),
    rankedItem('unknown',{label:'日期不明',observation:'没有确定日期'}),
  ];
  const batches=[rankedSeed(source,items,{cutoff})];
  const query={...cutoff,description:'阿岚今天手腕擦伤复查怎么样'};
  let prepared=await prepareTimeRequest(source,batches,{fragments:[query]});
  assert.equal(prepared.trackedRecords[0].id,'relevant');
  prepared=await prepareTimeRequest(source,batches,{fragments:[{...query,description:'完全不同的话题'}]});
  assert.equal(prepared.trackedRecords[0].id,'near');
  assert.ok(prepared.trackedRecords.findIndex(item=>item.id==='body')<prepared.trackedRecords.findIndex(item=>item.id==='unknown'));
  const reviewItems=[rankedItem('garden',{label:'修整花园',observation:'花园杂草'}),rankedItem('wrist',{label:'手腕擦伤',observation:'手腕仍疼痛'})];
  prepared=await prepareTimeRequest(source,[rankedSeed(source,reviewItems,{id:'review-query',cutoff})],{cutoffBody:cutoff,currentReview:true,allowInitialProjection:true});
  assert.equal(prepared.trackedRecords[0].id,'wrist','收尾无fragments时使用当前cutoff正文');
});

test('单槽成功轮次会轮换长期未送审项，空changes仍记实际送审，编译失败不推进',async()=>{
  const h=await harness({count:1}),source=await h.body(),fragment={...source.bodyFloors[0],description:'重点检查手腕复查'};
  const padding='较长事项说明'.repeat(110),items=[
    rankedItem('first',{label:'手腕复查',observation:`手腕擦伤复查 ${padding}`}),
    rankedItem('second',{label:'整理票据',observation:`整理票据 ${padding}`}),
    rankedItem('last',{label:'归还钥匙',observation:`归还钥匙 ${padding}`}),
  ];
  const batches=[rankedSeed(source,items)];
  const unrestricted=await prepareTimeRequest(source,batches,{fragments:[fragment]});
  const oneRequest=structuredClone(unrestricted.request);oneRequest.trackedItems=oneRequest.trackedItems.slice(0,1);
  const oneSlot=estimateRecallTokens(unrestricted.systemPrompt+JSON.stringify(oneRequest))+300;
  const seen=[];
  for(let round=0;round<8;round++){
    const prepared=await prepareTimeRequest(source,batches,{fragments:[fragment],inputTokens:oneSlot});
    assert.equal(prepared.trackedRecords.length,1);seen.push(prepared.trackedRecords[0].id);
    const delivered=await compileTimeResponse({changes:[]},prepared,batches);delivered.id=`delivered-${round}`;
    assert.deepEqual(delivered.selectedItemIds,[prepared.trackedRecords[0].id]);assert.equal(delivered.changes.length,0);batches.push(delivered);
  }
  assert.ok(seen.includes('last'),`末项应在有限成功轮次内送审：${seen.join(',')}`);
  const small=rankedItem('small',{label:'普通小项',observation:'可放入预算的小事项'}),smallOnly=await prepareTimeRequest(source,[rankedSeed(source,[small],{id:'small-seed'})],{fragments:[fragment]});
  const smallRequest=structuredClone(smallOnly.request);smallRequest.trackedItems=smallRequest.trackedItems.slice(0,1);
  const skipBudget=estimateRecallTokens(smallOnly.systemPrompt+JSON.stringify(smallRequest))+300;
  const giant=rankedItem('giant',{label:'重点检查手腕',observation:'重点检查手腕'.repeat(5000)});
  const skipped=await prepareTimeRequest(source,[rankedSeed(source,[giant,small],{id:'giant-seed'})],{fragments:[fragment],inputTokens:skipBudget});
  assert.deepEqual(skipped.trackedRecords.map(item=>item.id),['small'],'单项超预算后继续尝试后项');
  const failedPrepared=await prepareTimeRequest(source,batches,{cutoffBody:source.bodyFloors[0],currentReview:true,allowInitialProjection:true,inputTokens:oneSlot});
  const failedId=failedPrepared.trackedRecords[0].id;
  await assert.rejects(compileTimeResponse({changes:[{itemId:'not-selected',progression:'无效'}]},failedPrepared,batches),/均无效/u);
  const unchanged=await prepareTimeRequest(source,batches,{cutoffBody:source.bodyFloors[0],currentReview:true,allowInitialProjection:true,inputTokens:oneSlot});
  assert.equal(unchanged.trackedRecords[0].id,failedId);
});

test('轮换只统计当前cutoff以前的有效批次，并兼容旧review选中记录',async()=>{
  const h=await harness({count:2}),source=await h.body(),first=source.bodyFloors[0],second=source.bodyFloors[1];
  const items=[rankedItem('sent',{label:'普通事项甲',observation:'相同材料'}),rankedItem('waiting',{label:'普通事项乙',observation:'相同材料'})];
  const batches=[rankedSeed(source,items,{cutoff:first})];
  for(let round=0;round<4;round++) batches.push({schemaVersion:1,chatId:CHAT,id:`old-review-${round}`,signature:`old-${round}`,currentTime:first.observationTime,
    cutoffFloorId:first.floorId,cutoffAssistantSeq:first.assistantSeq,sourceKeys:[],dependencies:[],bodyReads:[],changes:[],currentReview:{selectedItemIds:['sent']}});
  batches.push({schemaVersion:1,chatId:CHAT,id:'invalid-branch',signature:'invalid',currentTime:first.observationTime,cutoffFloorId:first.floorId,cutoffAssistantSeq:first.assistantSeq,
    sourceKeys:[],dependencies:[{floorId:first.floorId,canonicalFingerprint:'not-this-branch'}],bodyReads:[],changes:[],selectedItemIds:['waiting']});
  batches.push({schemaVersion:1,chatId:CHAT,id:'future',signature:'future',currentTime:second.observationTime,cutoffFloorId:second.floorId,cutoffAssistantSeq:second.assistantSeq,
    sourceKeys:[],dependencies:[],bodyReads:[],changes:[],selectedItemIds:['waiting']});
  const prepared=await prepareTimeRequest(source,batches,{cutoffBody:first,currentReview:true,allowInitialProjection:true});
  assert.equal(prepared.trackedRecords[0].id,'waiting');
});

test('停止项只保留正文相关性与稳定顺序，不能靠调度加分长期挤占活跃项',async()=>{
  const h=await harness({count:1}),source=await h.body(),topics=Array.from({length:8},(_,index)=>`topic${index}`),fragment={...source.bodyFloors[0],description:topics.join(' ')};
  const stopped=topics.map((topic,index)=>rankedItem(`stopped-${index}`,{label:topic,observation:`${topic} 旧事项`,status:'paused'}));
  const active=rankedItem('active',{label:'idle',observation:'idle'}),batches=[rankedSeed(source,[...stopped,active],{id:'stopped-seed'})];
  let edited=stopped[0];for(let index=0;index<4;index++){const manual=await compileTimeEdit(edited,{},source,`manual-no-round-${index}`);batches.push(manual);edited=manual.changes[0];}
  const wide=await prepareTimeRequest(source,batches,{fragments:[fragment]});
  assert.equal(wide.trackedRecords.length,stopped.length+1);assert.ok(wide.trackedRecords.some(item=>item.status==='paused'),'宽预算仍保留停止项作为防重复上下文');assert.ok(wide.trackedRecords[0].id.startsWith('stopped-'),'人工编辑批不能推进模型送审轮次');
  const oneRequest=structuredClone(wide.request);oneRequest.trackedItems=oneRequest.trackedItems.slice(0,1);
  const oneSlot=estimateRecallTokens(wide.systemPrompt+JSON.stringify(oneRequest))+300,seen=[];
  for(let round=0;round<7&&!seen.includes(active.id);round++){
    const prepared=await prepareTimeRequest(source,batches,{fragments:[fragment],inputTokens:oneSlot});assert.equal(prepared.trackedRecords.length,1);seen.push(prepared.trackedRecords[0].id);
    const delivered=await compileTimeResponse({changes:[]},prepared,batches);delivered.id=`stopped-round-${round}`;batches.push(delivered);
  }
  assert.ok(seen[0].startsWith('stopped-'),'正文相关停止项仍可作上下文');assert.ok(seen.includes(active.id),`活跃项应靠等待分取得单槽送审机会：${seen.join(',')}`);
});

test('当前新观察零经过小时仍可评估，未答事项partial不假称全部更新，不凭空新增',async()=>{
  const h=await harness({count:1}),{source,batches}=await seedTimeItems(h,3);const prepared=await prepareTimeRequest(source,batches,{currentReview:true,allowInitialProjection:true});assert.equal(prepared.request.trackedItems[0].observationElapsedHours,0);
  const batch=await compileTimeResponse({changes:[reviewModel(prepared.request).changes[0],{...reviewModel(prepared.request).changes[1],progression:'',assessmentReason:'原观察不足。'}]},prepared,batches);
  assert.equal(batch.status,'partial');assert.equal(batch.currentReview.updated,1);assert.equal(batch.currentReview.insufficient,1);assert.ok(batch.changes[0].projection);assert.equal(batch.itemErrors[0].index,3);assert.equal(replayTimeBatches([...batches,batch],source).length,3);
  const nextPrepared=await prepareTimeRequest(source,[...batches,batch],{currentReview:true,allowInitialProjection:true});const uncertain=await compileTimeResponse(reviewModel(nextPrepared.request,{progression:'',assessmentReason:'没有充分依据。'}),nextPrepared,[...batches,batch]);const priorEstimate=uncertain.changes.find(item=>item.id===batch.changes[0].id);assert.equal(priorEstimate.projection.text,batch.changes[0].projection.text);assert.equal(validTimeProjection(priorEstimate,nextPrepared.request.currentTime),false);
  await assert.rejects(compileTimeResponse({changes:[]},prepared,batches));await assert.rejects(compileTimeResponse({changes:[{itemId:'new',progression:'凭空新增'}]},prepared,batches));
});

test('收尾失败/取消提前消费，通知重载不重试，同确认不重复，新确认明确再授权',async()=>{
  for(const kind of ['fail','cancel']){
    let started,release;const begun=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
    const h=await harness({generate:async request=>{started();await gate;if(kind==='fail')throw new Error('synthetic model error');return reviewModel(request);}});await seedTimeItems(h,3);
    const plan=await h.runtime.prepareHistoryPlan(),run=h.runtime.organize(plan);await begun;const attempted=await h.store.read(CHAT);assert.equal(attempted.head.currentReviewAttempt.status,'running');
    const stopping=kind==='cancel'?h.runtime.stop():Promise.resolve();release();await Promise.all([run,stopping]);
    h.reload();await h.runtime.runBatch();await h.runtime.organize(plan);assert.equal(h.calls(),1);const retry=await h.runtime.prepareHistoryPlan();assert.equal(retry.retryCurrentReview,true);assert.equal(retry.apiCalls,1);
    await h.runtime.organize(retry);assert.equal(h.calls(),2);
  }
});

test('全重构历史授权等待原稳定范围绑定，一次收尾后新楼常规处理不再加一',async()=>{
  const requests=[];const h=await harness({count:3,unstable:true,generate:request=>{requests.push(request);return request.currentReview?reviewModel(request):bodyModel(request,{progression:''});}});
  const floors=h.source.floors;h.source.floors=[];await h.runtime.authorizeHistory();assert.equal(h.calls(),0);
  h.source.floors=[floors[0]];await h.runtime.runBatch();assert.equal(h.calls(),1);assert.equal(requests[0].currentReview,undefined);
  h.source.floors=floors;await h.runtime.runBatch();assert.equal(h.calls(),3);assert.equal(requests[2].currentReview,true);assert.equal(requests[2].cutoffFloorId,'floor-2');
  await h.runtime.runBatch();assert.equal(h.calls(),3);h.chat.push({is_user:true,mes:'继续'});await h.seal();await h.runtime.runBatch();assert.equal(h.calls(),4);assert.equal(requests[3].currentReview,undefined);
  const empty=await harness({count:0});await empty.runtime.authorizeHistory();empty.chat.push({is_user:false,mes:raw(0)},{is_user:true,mes:'继续'});await empty.seal();await empty.runtime.runBatch();assert.equal(empty.calls(),1);
});


async function seedMergeItems(h) {
  const source=await h.body(),rows=planTimeBody(source,[],{history:true}).groups.flat(),prepared=await prepareTimeRequest(source,[],{fragments:rows});
  const observations=['共同经历中的手腕轻微影响','共同经历中的膝盖轻微影响','之后碎杯造成的独立划伤'];
  const batch=await compileTimeResponse({changes:observations.map((observation,i)=>bodyModel(prepared.request,{label:`事项${i}`,observation,progression:'',sourceKeys:[prepared.request.observations[i].sourceKey]}).changes[0])},prepared);
  batch.id='merge-seed';await h.store.putBatch(CHAT,batch);await h.store.putHead(CHAT,{schemaVersion:1,chatId:CHAT,batchIds:[batch.id]},0);return {source,rows,batches:[batch],items:batch.changes};
}
const mergeProposal=(main,member,description='同一场景共同原因的轻微影响，手腕与膝盖分别保留原日期。')=>({itemId:main.id,mergedItemIds:[member.id],description});
async function saveTimeBatch(h,batch){const stored=await h.store.read(CHAT);await h.store.putBatch(CHAT,batch);await h.store.putHead(CHAT,{...stored.head,batchIds:[...stored.head.batchIds,batch.id]},stored.revision);}

test('同响应归并共同经历保来源/日期与人工原观察，独立原因保留，后续仅主项跟进/召回',async()=>{
  const h=await harness({count:3}),{source,rows,batches,items}=await seedMergeItems(h);let prepared=await prepareTimeRequest(source,batches,{fragments:rows});
  const batch=await compileTimeResponse({changes:[],merges:[mergeProposal(items[0],items[1])]},prepared,batches);
  const replay=replayTimeBatches([...batches,batch],source),main=replay.find(item=>item.id===items[0].id),member=replay.find(item=>item.id===items[1].id);
  assert.equal(main.observation,items[0].observation);assert.deepEqual(main.observationTime,items[0].observationTime);assert.deepEqual(main.occurrenceTime,items[0].occurrenceTime);assert.equal(main.sourceRefs.length,2);assert.equal(member.mergedInto,main.id);assert.equal(member.status,'paused');assert.deepEqual(member.observationTime,items[1].observationTime);assert.equal(replay.find(item=>item.id===items[2].id).status,'active');
  prepared=await prepareTimeRequest(source,[...batches,batch],{currentReview:true,allowInitialProjection:true});assert.equal(prepared.request.trackedItems.length,2);assert.equal(prepared.request.trackedItems.some(item=>item.id===member.id),false);assert.equal(prepared.request.trackedItems.find(item=>item.id===main.id).mergedObservations[0].observation,member.observation);
  const review=await compileTimeResponse(reviewModel(prepared.request),prepared,[...batches,batch]);const projected=timeRecallProjection(replayTimeBatches([...batches,batch,review],source),{entities:[],currentState:[],identityProjection:{}},prepared.request.currentTime);assert.equal(projected.reminders.length,2);assert.equal(projected.reminders.some(item=>item.itemId===member.id),false);assert.match(projected.reminders.find(item=>item.itemId===main.id).text,/归并共同经历：.*手腕与膝盖.*当前推测/);
});

test('N+1同次归并成员算已处理，不漏答，不需要单独API',async()=>{
  let proposal;const h=await harness({count:3,generate:request=>({changes:reviewModel(request).changes.filter(change=>change.itemId!==proposal.mergedItemIds[0]),merges:[proposal]})});const {items}=await seedMergeItems(h);proposal=mergeProposal(items[0],items[1]);
  const plan=await h.runtime.prepareHistoryPlan();assert.equal(plan.apiCalls,1);await h.runtime.organize(plan);const stored=await h.store.read(CHAT),batch=stored.batches.at(-1);
  assert.equal(h.calls(),1);assert.equal(batch.status,undefined);assert.equal(batch.currentReview.updated,2);assert.equal(batch.currentReview.merged,1);assert.equal(h.runtime.getState().trackedItems.length,2);assert.match(h.runtime.getState().last.message,/归并退出 1 项/);
});

test('错误组隔离不暂停从项，合法独立变化保存；归并回放坏前置键全组不应用',async()=>{
  const h=await harness({count:3}),{source,rows,batches,items}=await seedMergeItems(h),prepared=await prepareTimeRequest(source,batches,{fragments:rows});
  const independent=bodyModel(prepared.request,{itemId:items[2].id,sourceKeys:[],status:'cancelled'}).changes[0];
  const badMain=bodyModel(prepared.request,{itemId:items[0].id,sourceKeys:['unknown']}).changes[0];
  const pausedMember=bodyModel(prepared.request,{itemId:items[1].id,sourceKeys:[],status:'paused'}).changes[0];
  const partial=await compileTimeResponse({changes:[badMain,pausedMember,independent],merges:[mergeProposal(items[0],items[1])]},prepared,batches);
  assert.equal(partial.status,'partial');assert.deepEqual(partial.bodyReads,[]);assert.equal(partial.changes.length,1);assert.equal(partial.changes[0].id,items[2].id);assert.equal(replayTimeBatches([...batches,partial],source).find(item=>item.id===items[1].id).status,'active');
  const reviewPrepared=await prepareTimeRequest(source,batches,{currentReview:true,allowInitialProjection:true}),reviewChanges=reviewModel(reviewPrepared.request).changes;
  const reviewPartial=await compileTimeResponse({changes:reviewChanges.map(change=>change.itemId===items[0].id?{...change,sourceKeys:['unknown']}:change),merges:[mergeProposal(items[0],items[1])]},reviewPrepared,batches);
  assert.deepEqual(reviewPartial.changes.map(item=>item.id),[items[2].id]);assert.equal(reviewPartial.currentReview.updated,1);assert.equal(reviewPartial.currentReview.insufficient,0);assert.equal(reviewPartial.currentReview.merged,0);assert.equal(reviewPartial.status,'partial');
  const valid=await compileTimeResponse({changes:[independent],merges:[mergeProposal(items[0],items[1])]},prepared,batches);const broken=structuredClone(valid);broken.changes.find(item=>item.id===items[1].id).previousObservationKey='broken';const replay=replayTimeBatches([...batches,broken],source);assert.equal(replay.find(item=>item.id===items[0].id).mergedItemIds,undefined);assert.equal(replay.find(item=>item.id===items[1].id).status,'active');assert.equal(replay.find(item=>item.id===items[2].id).status,'cancelled');
  for(const merges of [[mergeProposal(items[0],items[0])],[mergeProposal(items[0],items[1]),mergeProposal(items[2],items[1])],[{...mergeProposal(items[0],items[1]),mergedItemIds:['unknown']}]] ) {
    if(merges.some(group=>group.itemId===items[2].id)) await assert.rejects(compileTimeResponse({changes:[independent],merges},prepared,batches),error=>error.code==='QQJ_TIME_INVALID');
    else {const value=await compileTimeResponse({changes:[independent],merges},prepared,batches);assert.equal(value.status,'partial');assert.equal(value.mergeGroups,undefined);}
  }
});

test('连续归并写时展平，旧从项ID/同来源重试沿最终主项，原身份key稳定',async()=>{
  const h=await harness({count:3}),{source,rows,batches,items}=await seedMergeItems(h);let prepared=await prepareTimeRequest(source,batches,{fragments:rows});const first=await compileTimeResponse({changes:[],merges:[mergeProposal(items[0],items[1])]},prepared,batches);
  prepared=await prepareTimeRequest(source,[...batches,first],{fragments:rows});const again=await compileTimeResponse({changes:[],merges:[mergeProposal(items[0],items[1],'同义描述不应刷新观察')]},prepared,[...batches,first]);assert.equal(again.changes.find(item=>item.id===items[0].id).observationKey,first.changes.find(item=>item.id===items[0].id).observationKey);
  const second=await compileTimeResponse({changes:[],merges:[mergeProposal(items[2],items[0])]},prepared,[...batches,first]);let replay=replayTimeBatches([...batches,first,second],source);assert.equal(replay.filter(item=>item.status==='active').length,1);assert.equal(replay.find(item=>item.id===items[1].id).mergedInto,items[2].id);assert.deepEqual(new Set(replay.find(item=>item.id===items[2].id).mergedItemIds),new Set([items[0].id,items[1].id]));
  prepared=await prepareTimeRequest(source,[...batches,first,second],{currentReview:true,allowInitialProjection:true});const oldId=await compileTimeResponse({changes:[{itemId:items[1].id,progression:'共同经历当前仍待观察。'}]},prepared,[...batches,first,second]);assert.equal(oldId.changes[0].id,items[2].id);
  prepared=await prepareTimeRequest(source,[...batches,first,second],{fragments:[rows[1]]});const retry=await compileTimeResponse(bodyModel(prepared.request,{label:items[1].label,observation:items[1].observation}),prepared,[...batches,first,second]);assert.equal(retry.changes[0].id,items[2].id);assert.equal(retry.changes[0].sourceIdentity,items[2].sourceIdentity);assert.equal(replayTimeBatches([...batches,first,second,retry],source).filter(item=>item.status==='active').length,1);
});

test('人工解除归并原ID独立，主项描述推测失效，旧观察不能立即重归并，新事实可继续',async()=>{
  const h=await harness({count:3}),{source,rows,batches,items}=await seedMergeItems(h);let prepared=await prepareTimeRequest(source,batches,{fragments:rows});const merge=await compileTimeResponse({changes:[],merges:[mergeProposal(items[0],items[1])]},prepared,batches);await saveTimeBatch(h,merge);await h.runtime.refreshStatus();const merged=h.runtime.getState().stoppedItems[0];assert.equal(merged.mergedInto,items[0].id);
  await h.runtime.editItem(merged.id,{status:'active',label:'人工独立更正'},merged.observationKey);const stored=await h.store.read(CHAT);let replay=replayTimeBatches(stored.batches,await h.body());const restored=replay.find(item=>item.id===merged.id),main=replay.find(item=>item.id===items[0].id);assert.equal(restored.mergedInto,null);assert.equal(restored.id,items[1].id);assert.equal(main.mergedItemIds.length,0);assert.equal(main.mergeDescription,null);assert.equal(main.projection,null);assert.equal(h.calls(),0);
  prepared=await prepareTimeRequest(await h.body(),stored.batches,{currentReview:true,allowInitialProjection:true});assert.equal(prepared.request.trackedItems.find(item=>item.id===restored.id).label,'人工独立更正');const rejected=await compileTimeResponse({...reviewModel(prepared.request),merges:[mergeProposal(main,restored)]},prepared,stored.batches);assert.equal(rejected.status,'partial');assert.equal(rejected.mergeGroups,undefined);
  h.chat.push({is_user:false,mes:raw(3,'阿岚独立事项出现新观察。')},{is_user:true,mes:'继续'});await h.seal();const fresh=await h.body();const fragment=planTimeBody(fresh,stored.batches,{history:true}).groups.flat().find(row=>row.floorId==='floor-4');prepared=await prepareTimeRequest(fresh,stored.batches,{fragments:[fragment]});const update=bodyModel(prepared.request,{itemId:restored.id,label:restored.label,observation:'新观察仍有轻微影响'}).changes[0];const allowed=await compileTimeResponse({changes:[update],merges:[mergeProposal(main,restored)]},prepared,stored.batches);assert.ok(allowed.mergeGroups);assert.equal(allowed.changes.find(item=>item.id===restored.id).mergedInto,main.id);
});

test('人工编辑仍归并暂停的从项观察与时间，同步使主项旧共同描述及推测失效',async()=>{
  const h=await harness({count:3}),{source,rows,batches,items}=await seedMergeItems(h);let prepared=await prepareTimeRequest(source,batches,{fragments:rows});
  const merge=await compileTimeResponse({changes:[],merges:[mergeProposal(items[0],items[1])]},prepared,batches);await saveTimeBatch(h,merge);
  prepared=await prepareTimeRequest(source,[...batches,merge],{currentReview:true,allowInitialProjection:true});const review=await compileTimeResponse(reviewModel(prepared.request),prepared,[...batches,merge]);await saveTimeBatch(h,review);await h.runtime.refreshStatus();
  const priorItems=replayTimeBatches([...batches,merge,review],source),priorMain=priorItems.find(item=>item.id===items[0].id);
  const mainEdit=await compileTimeEdit({...priorMain,stateRefs:[{stateId:'linked',sourceFloorId:'floor-1'}]},{observation:'人工更正主项原观察',observationTime:'2026-05-09 09:00'},source,'manual-main',priorItems),editedMain=mainEdit.changes[0];
  assert.equal(editedMain.mergeDescription,null);assert.equal(editedMain.mergeEvidenceKey,null);assert.equal(editedMain.projection,null);assert.deepEqual(editedMain.mergedItemIds,[items[1].id]);
  const correction=timeRecallProjection([editedMain],{entities:[],currentState:[{subjectEntityId:editedMain.subjectEntityId,core:[{stateId:'linked',sourceFloorId:'floor-1',text:'原状态'}],adaptive:[],situational:[]}],identityProjection:{}},prepared.request.currentTime).corrections;
  assert.match(Object.values(correction)[0].text,/人工更正主项原观察/);assert.equal(Object.values(correction)[0].text.includes(priorMain.mergeDescription),false);
  const editedPrepared=await prepareTimeRequest(source,[...batches,merge,review,mainEdit],{currentReview:true,allowInitialProjection:true});assert.equal(editedPrepared.request.trackedItems.find(item=>item.id===priorMain.id).mergeDescription,null);assert.equal(editedPrepared.request.trackedItems.find(item=>item.id===priorMain.id).mergedObservations[0].itemId,items[1].id);
  const member=h.runtime.getState().stoppedItems.find(item=>item.id===items[1].id);await h.runtime.editItem(member.id,{observation:'人工确认膝盖影响已更正',observationTime:'2026-05-09 12:00'},member.observationKey);
  const stored=await h.store.read(CHAT),edited=stored.batches.at(-1),replayed=replayTimeBatches(stored.batches,source),main=replayed.find(item=>item.id===items[0].id),currentMember=replayed.find(item=>item.id===member.id);
  assert.equal(edited.changes.length,2);assert.deepEqual(new Set(edited.mergeGroups[0].itemIds),new Set([main.id,member.id]));assert.equal(currentMember.status,'paused');assert.equal(currentMember.mergedInto,main.id);assert.equal(currentMember.observation,'人工确认膝盖影响已更正');assert.equal(currentMember.observationTime.date,'2026-05-09');assert.deepEqual(main.mergedItemIds,[member.id]);assert.equal(main.mergeDescription,null);assert.equal(main.projection,null);assert.equal(main.observation,items[0].observation);assert.equal(h.calls(),0);
  prepared=await prepareTimeRequest(source,stored.batches,{currentReview:true,allowInitialProjection:true});assert.equal(prepared.request.trackedItems.find(item=>item.id===main.id).mergedObservations[0].observation,currentMember.observation);assert.equal(timeRecallProjection(replayed,{entities:[],currentState:[],identityProjection:{}},prepared.request.currentTime).reminders.some(item=>item.itemId===main.id),false);
  const broken=structuredClone(edited);broken.changes.find(item=>item.id===member.id).previousObservationKey='changed';const unchanged=replayTimeBatches([...batches,merge,review,broken],source);assert.equal(unchanged.find(item=>item.id===member.id).observation,member.observation);assert.ok(unchanged.find(item=>item.id===main.id).projection);
});

test('完整归并前缀才继承，旧记录正常回放，人工当前版本输入保留且合并不撤纠正',async()=>{
  const h=await harness({count:3}),{source,rows,batches,items}=await seedMergeItems(h);const manual=await compileTimeEdit(items[0],{label:'人工名称',observation:'人工修订的当前观察'},source,'manual');const prepared=await prepareTimeRequest(source,[...batches,manual],{fragments:rows});assert.equal(prepared.request.trackedItems.find(item=>item.id===items[0].id).observation,'人工修订的当前观察');
  const merge=await compileTimeResponse({changes:[],merges:[mergeProposal(items[0],items[1])]},prepared,[...batches,manual]);assert.equal(merge.changes.find(item=>item.id===items[0].id).observation,'人工修订的当前观察');await saveTimeBatch(h,manual);await saveTimeBatch(h,merge);
  await h.store.copyPrefix(CHAT,'merge-child',source.floors);const child=await h.store.read('merge-child');assert.equal(replayTimeBatches(child.batches,source).filter(item=>item.status==='active').length,2);assert.ok(child.batches.at(-1).mergeGroups);
  const changed=source.floors.map(floor=>floor.id==='floor-2'?{...floor,canonicalFingerprint:'changed'}:floor);await h.store.copyPrefix(CHAT,'merge-broken-child',changed);assert.equal((await h.store.read('merge-broken-child')).batches.some(batch=>batch.mergeGroups),false);
});


test('旧观察解析恢复计算但completed收尾签名未变仍不重开，面板使用有效视图',async()=>{
  const h=await harness({generate:bodyModel});
  h.chat[0].mes='<Ti>七月十七10:30</Ti>阿岚手腕擦伤仍疼痛。';
  h.chat[2].mes='<Ti>7月19日20:30</Ti>阿岚仍有不适。';
  await h.seal();await h.runtime.organize(await h.runtime.prepareHistoryPlan());assert.equal(h.calls(),2);
  for(const envelope of h.back.records.values()) for(const item of envelope.data.changes??[]) {
    item.observationTime={raw:'七月十七10:30',date:null,day:null,year:null,month:null,monthDay:null,minute:null,clock:null};
    item.projection=null;item.reviewAssessment={reason:'缺少明确时间，无法可靠判断当前进展。',applicableTime:projectTime('7月19日20:30'),observationKey:item.observationKey};
  }
  h.reload();await h.runtime.refreshStatus();
  assert.equal(h.runtime.getState().trackedItems[0].observationElapsedHours,58);
  assert.equal(h.runtime.getState().trackedItems[0].observationTime.monthDay,17);
  const plan=await h.runtime.prepareHistoryPlan();assert.equal(plan.floorCount,0);assert.equal(plan.currentReview,false);assert.equal(plan.apiCalls,0);
  assert.equal(h.calls(),2,'读取计算视图不调用模型或改变重试策略');
});
