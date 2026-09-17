import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTime, projectTimeSource, effectiveTime, timeDistance, timeHours, shiftTime, bodyProjectionDue, validTimeProjection, prepareTimeBatch, compileTimeResponse, timeFingerprint, timeBodyReads, timeRecallProjection } from '../src/v3/time-engine.js';
import { readTimeBody } from '../src/v3/time-body.js';
import { scanAssistantCandidates, createFloorRecord } from '../src/v3/foundation-domain.js';

const oldTime = raw => ({ raw, date:null, day:null, year:null, month:null, monthDay:null, minute:null, clock:null });

test('汉字/全角日期、初廿卅、省略日号和紧邻时钟，仍守公历有效性', () => {
  for (const value of ['七月十七10:30','７月１７日１０：３０','7月17号10:30']) {
    const time = projectTime(value);
    assert.equal(time.monthDay,17); assert.equal(time.clock,'10:30'); assert.equal(time.year,null); assert.equal(time.raw,value);
  }
  for (const value of ['二〇二六年七月十七','二千零二十六年七月十七日','２０２６年７月１７日']) assert.equal(projectTime(value).date,'2026-07-17');
  assert.equal(projectTime('七月初五').monthDay,5);
  assert.equal(projectTime('七月廿三').monthDay,23);
  assert.equal(projectTime('七月卅一').monthDay,31);
  for (const value of ['2026-02-30','二〇二六年二月三十','四月卅一','十三月初一','任意叙述','时间未知','木叶历七年霜月']) assert.equal(projectTime(value).date,null,value);
  assert.equal(projectTime('2024-02-29').date,'2024-02-29');
  assert.equal(projectTime('公元2026年7月17日').date,'2026-07-17');
  const anchor=projectTime('2026-07-17 10:30');
  assert.equal(projectTime('三天后',anchor).date,'2026-07-20');
  assert.equal(projectTime('两星期前',anchor).date,'2026-07-03');
  assert.equal(projectTime('昨天',anchor).date,'2026-07-16');
});

test('命名月、纪年与闰月独立身份，只算确认的同月日序', () => {
  const leap=projectTime('闰七月初五 08:00');
  assert.equal(timeDistance(leap,projectTime('闰七月初七')),2);
  assert.equal(timeDistance(leap,projectTime('七月初七')),null);
  assert.equal(timeDistance(projectTime('闰月初五'),projectTime('闰月初七')),2);
  assert.equal(timeDistance(projectTime('闰月初五'),leap),null);
  const a=projectTime('星际007年秋月三十五 10:30'), b=projectTime('星际007年秋月三十七 20:30');
  assert.equal(a.day,null); assert.equal(a.year,7); assert.equal(a.monthDay,35); assert.match(a.date,/星际/); assert.equal(a.raw,'星际007年秋月三十五 10:30');
  assert.equal(timeHours(a,b),58);
  for (const value of ['星际008年秋月三十七','星际007年霜月三十七','木叶历七年秋月三十七','秋月三十七','2007年7月17日']) assert.equal(timeDistance(a,projectTime(value)),null);
  assert.equal(projectTime('昨天',a).monthDay,34);
  assert.equal(shiftTime(a,3).date,null,'未知月长不能判定是否跨月');
  assert.equal(projectTime('昨天',projectTime('秋月初一')).date,null);
});

test('第N个星期保完整身份且不是第N日，同星期差7天、其他间隔未知', () => {
  const a=projectTime('星际007年秋月第二个星期三 10:30');
  assert.equal(a.monthDay,null); assert.equal(a.weekOrdinal,2); assert.equal(a.weekday,3); assert.match(a.date,/星期三/);
  assert.equal(timeDistance(a,projectTime('星际007年秋月第二个星期三')),0);
  assert.equal(timeHours(a,projectTime('星际007年秋月第三个星期三 20:30')),178);
  assert.equal(timeDistance(a,projectTime('星际007年秋月第三个星期四')),null);
  assert.equal(timeDistance(a,projectTime('星际007年霜月第二个星期三')),null);
  assert.equal(timeDistance(a,projectTime('星际007年秋月初二')),null);
});

test('旧date:null在计算/有效推测/模型DTO/编译/召回获得统一视图，存储和观察键不变', async () => {
  const observed=oldTime('七月十七10:30'), current=projectTime('7月19日20:30');
  const primary={id:'main',subjectEntityId:'person',subjectName:'甲',type:'body',label:'擦伤',status:'active',observation:'仍有不适',observationKey:'old-key',observationTime:observed,occurrenceTime:observed,dueTime:oldTime(''),sourceRefs:[{floorId:'floor',canonicalFingerprint:'body'}],stateRefs:[],mergedItemIds:['member']};
  const member={...primary,id:'member',mergedItemIds:[],status:'paused',mergedInto:'main'};
  const cycle={...primary,id:'cycle',type:'cycle',mergedItemIds:[],periodDays:28,dueTime:oldTime('8月14日10:30')};
  const reachable={root:{chatId:'chat'},floors:[{id:'floor',assistantSeq:1,canonicalFingerprint:'body'}],floorMemories:[],entities:[],bodyTimes:new Map([['floor',current]])};
  const batches=[{cutoffFloorId:'floor',cutoffAssistantSeq:1,dependencies:[],changes:[primary,member,cycle],sourceKeys:[]}];
  const before=structuredClone(batches);
  assert.equal(timeHours(observed,current),58); assert.equal(bodyProjectionDue(observed,current),true);
  assert.equal(effectiveTime(observed).date,'7月17日（年份未明）');
  const structured=projectTime('2026-07-17'); assert.equal(effectiveTime(structured),structured);
  assert.equal(validTimeProjection({...primary,projection:{observationKey:'old-key',applicableTime:oldTime('7月19日20:30'),text:'仍可能不适'}},current),true);
  const prepared=await prepareTimeBatch(reachable,batches,{currentReview:true,allowInitialProjection:true});
  const dto=prepared.request.trackedItems.find(item=>item.id==='main');
  assert.equal(dto.observationTime.monthDay,17); assert.equal(dto.observationElapsedHours,58); assert.equal(dto.mergedObservations[0].observationTime.monthDay,17);
  const compiled=await compileTimeResponse({changes:prepared.request.trackedItems.map(item=>({itemId:item.id,progression:'可能逐步减轻，未确认恢复',assessmentReason:''}))},prepared,batches);
  assert.equal(compiled.changes.find(item=>item.id==='main').reviewAssessment,null);
  assert.deepEqual(compiled.changes.find(item=>item.id==='main').observationTime,observed);
  assert.deepEqual(compiled.changes.find(item=>item.id==='cycle').dueTime,cycle.dueTime);
  assert.equal(compiled.changes.find(item=>item.id==='main').observationKey,'old-key');
  const reminders=timeRecallProjection(compiled.changes,{entities:[],currentState:[],identityProjection:{}},current).reminders;
  assert.match(reminders.find(item=>item.itemId==='main').text,/距发生2天/);assert.doesNotMatch(reminders.find(item=>item.itemId==='main').text,/58小时/);
  assert.deepEqual(batches,before); assert.deepEqual(observed,oldTime('七月十七10:30'));
  reachable.bodyTimes.set('floor',projectTime('星际007年霜月初五'));
  const incomparable=await prepareTimeBatch(reachable,batches,{currentReview:true,allowInitialProjection:true});
  const unknown=await compileTimeResponse({changes:[{itemId:'main',progression:'可能减轻',assessmentReason:''}]},incomparable,batches);
  assert.match(unknown.changes[0].reviewAssessment.reason,/间隔不明/);
});

test('旧正文来源指纹含独立旧anchor链，覆盖继续有效且时间改动仍使覆盖失效', async () => {
  const raws=['七月十七10:30','次日 11:30','2026-07-19 20:30','21:30'];
  const chat=raws.flatMap(raw=>[{is_user:false,mes:`<Ti>${raw}</Ti>甲仍有不适。`},{is_user:true,mes:'继续'}]);
  const candidates=await scanAssistantCandidates(chat,{chatId:'chat'});
  const reachable={root:{chatId:'chat'},floors:candidates.map((candidate,index)=>createFloorRecord({candidate,id:`floor${index}`,chatId:'chat',narrativeGeneration:'gen'})),floorMemories:[]};
  const source=await readTimeBody(reachable,{chat},{storyClockReferenceTags:'Ti'});
  const expected=[await timeFingerprint([null,null,raws[0]]),await timeFingerprint([null,'11:30',raws[1]]),await timeFingerprint(['2026-07-19','20:30',null]),await timeFingerprint(['2026-07-19','21:30',null])];
  assert.deepEqual(source.bodyFloors.map(body=>body.timeSourceFingerprint),expected);
  assert.equal(source.bodyFloors[0].observationTime.monthDay,17); assert.equal(source.bodyFloors[1].observationTime.monthDay,18);
  const body=source.bodyFloors[0], batch={cutoffFloorId:body.floorId,dependencies:[],sourceKeys:[],changes:[],bodyReads:[{floorId:body.floorId,canonicalFingerprint:body.canonicalFingerprint,timeSourceFingerprint:expected[0],from:0,to:body.content.length,totalCharacters:body.content.length}]};
  assert.equal(timeBodyReads([batch],source).get(body.floorId).length,1);
  chat[0].mes=chat[0].mes.replace(raws[0],'七月十八10:30');
  const changed=await readTimeBody(reachable,{chat},{storyClockReferenceTags:'Ti'});
  assert.notEqual(changed.bodyFloors[0].timeSourceFingerprint,expected[0]); assert.equal(timeBodyReads([batch],changed).size,0);
  assert.equal(projectTimeSource(raws[0]).date,null);
});


test('末尾星期注记保汉字日期/纪年/闰月身份，失败时不退成普通numeric日期', () => {
  for (const suffix of [' 周三',' 星期三','，周三','(星期三)','（周三）','周三']) {
    const raw=`星际007年3月5日${suffix}`;
    const time=projectTime(raw);
    assert.match(time.date,/星际/); assert.equal(time.year,7); assert.equal(time.monthDay,5); assert.equal(time.day,null); assert.equal(time.raw,raw);
    assert.equal(timeDistance(time,projectTime(`木叶历7年3月6日${suffix.replaceAll('三','四')}`)),null);
    assert.equal(projectTime(`二〇二六年七月十七日${suffix}`).date,'2026-07-17');
    const leap=projectTime(`闰3月5日${suffix}`);
    assert.match(leap.date,/闰/); assert.equal(timeDistance(leap,projectTime('3月6日')),null);
  }
  assert.equal(projectTime('星际007年秋月第二个星期三').weekOrdinal,2);
  assert.equal(projectTime('星际007年秋月第二个星期三（周三）').weekOrdinal,2);
  assert.equal(projectTime('星际007年3月5日 原因未知').date,null);
  assert.equal(projectTime('闰3月5日 原因未知').date,null);
  assert.equal(projectTimeSource('星际007年3月5日 周三').date,'3月5日（年份未明）','来源专用旧算法不修改');
});
