import test from 'node:test';
import assert from 'node:assert/strict';
import { locatePlaceQuote, collectMissingPlaceSources } from '../src/v3/place-evidence.js';
import * as placeEvidence from '../src/v3/place-evidence.js';

test('194地点引用保原有省略号及空白匹配，恢复只保唯一正序短片段', () => {
  const content = '甲楼有客房。' + '中间剧情。'.repeat(500) + '客房里有书桌。';
  assert.deepEqual(locatePlaceQuote(content, '甲楼有客房。……客房里有书桌。', { allowOmission: true }).map(item => item.quote), ['甲楼有客房。', '客房里有书桌。']);
  for (const quote of ['甲楼……客房', '甲楼...客房']) assert.deepEqual(locatePlaceQuote(quote, quote, { allowOmission: true }).map(item => item.quote), [quote]);
  assert.deepEqual(locatePlaceQuote('甲楼\n\n有客房。', '甲楼 有客房。', { allowWhitespace: true, allowOmission: true }).map(item => item.quote), ['甲楼\n\n有客房。']);
});

test('整理来源覆盖已挂父地点的原始段落并吸收同源短句，角色和楼次不互吸收', async () => {
  assert.equal(typeof placeEvidence.collectPlaceOrganizationSources,'function');
  const text='第一段铺垫。\n\n甲城北边的旅店有客房。\n\n门口亮着灯。\n\n下一段过渡。\n\n无关人物闲聊。\n\n更远的闲聊。';
  const floors=[{id:'f1',assistantSeq:1,content:{canonicalContent:text}},{id:'f2',assistantSeq:2,content:{canonicalContent:'门口亮着灯。'}}];
  const m1={id:'m1',floorId:'f1',sourceCanonicalContent:text,sourceUserInputSnapshot:{messages:[{content:'旅店这次在甲城北边。',messageIndex:0}]}};
  const m2={id:'m2',floorId:'f2',sourceCanonicalContent:floors[1].content.canonicalContent};
  const args={entities:[{id:'room',entityType:'place',firstSeenFloorId:'f1'}],entityKeys:new Map([['room','place-1']]),places:[{entityId:'room',displayName:'旅店',aliases:[],parentEntityId:'wrong-parent'}],
    bodySources:[{evidenceKey:'old-1',floorId:'f1',sourceType:'assistant',canonicalContent:'门口亮着灯。',placeKeys:['place-1']},{evidenceKey:'old-2',floorId:'f2',sourceType:'assistant',canonicalContent:'门口亮着灯。',placeKeys:['place-1']}],
    floors,memoriesByFloor:new Map([['f1',m1],['f2',m2]]),parentFacts:[]};
  const before=JSON.stringify(args.bodySources),rows=await placeEvidence.collectPlaceOrganizationSources(args);
  const assistant=rows.filter(row=>row.floorId==='f1'&&row.sourceType==='assistant');assert.equal(assistant.length,1);assert.ok(assistant[0].canonicalContent.includes('甲城北边'));assert.ok(assistant[0].canonicalContent.includes('门口亮着灯。'));
  assert.ok(text.includes(assistant[0].canonicalContent),'只返回原连续文字');assert.ok(assistant[0].canonicalContent.length<text.length);assert.equal(assistant[0].requiresExactQuote,true);
  assert.equal(rows.filter(row=>row.floorId==='f1'&&row.canonicalContent==='门口亮着灯。').length,0,'同楼短quote被原连续上下文吸收');
  assert.ok(rows.some(row=>row.floorId==='f2'&&row.canonicalContent==='门口亮着灯。'),'跨楼同文仍保');
  const user=rows.find(row=>row.sourceType==='precedingUser');assert.equal(user.sourceSnapshotIndex,0);assert.equal(user.canonicalContent,'旅店这次在甲城北边。');assert.equal(JSON.stringify(args.bodySources),before);
  const finite=await placeEvidence.collectPlaceOrganizationSources({...args,floors:[floors[1]],memoriesByFloor:new Map([['f2',m2]])});assert.equal(finite.some(row=>row.floorId==='f1'&&row.requiresExactQuote),false);
});

test('整理父边来源使用聚合成员的专属AI与USER快照，不借锚楼或当前宿主补历史',async()=>{
  assert.equal(typeof placeEvidence.collectPlaceOrganizationSources,'function');
  const floors=[{id:'f1',assistantSeq:1,content:{canonicalContent:'甲城旅店旧址。'}},{id:'f2',assistantSeq:2,content:{canonicalContent:'甲城旅店迁入新楼。'}}];
  const memory={id:'aggregate',floorId:'f2',sourceFloorIds:['f1','f2'],sourceCanonicalContent:'不作为成员使用的全文',sourceUserInputSnapshot:{messages:[{content:'不能倒灌的锚USER'}]},sourceFloorSnapshots:[{floorId:'f1',canonicalContent:floors[0].content.canonicalContent},{floorId:'f2',canonicalContent:floors[1].content.canonicalContent,sourceUserInputSnapshot:{messages:[{content:'甲城旅店搬家了。'}]}}]};
  const args={entities:[{id:'room',entityType:'place',firstSeenFloorId:'f1'}],entityKeys:new Map([['room','place-1']]),places:[{entityId:'room',displayName:'旅店',aliases:[],parentEntityId:'building'}],bodySources:[],floors,memoriesByFloor:new Map([['f1',memory],['f2',memory]]),parentFacts:[{placeEntityId:'room',evidenceRefs:[{floorId:'f2',quotedText:'甲城旅店迁入新楼。'}]}]};
  const rows=await placeEvidence.collectPlaceOrganizationSources(args);assert.ok(rows.some(row=>row.floorId==='f2'&&row.sourceType==='assistant'));assert.ok(rows.some(row=>row.floorId==='f2'&&row.sourceType==='precedingUser'));
  assert.equal(rows.some(row=>row.floorId==='f1'&&row.sourceType==='precedingUser'),false);assert.equal(rows.some(row=>row.canonicalContent.includes('不能倒灌')),false);
  const missing={...memory,sourceFloorSnapshots:memory.sourceFloorSnapshots.slice(1)};
  const result=await placeEvidence.collectPlaceOrganizationSources({...args,memoriesByFloor:new Map([['f1',missing],['f2',missing]])});assert.equal(result.some(row=>row.floorId==='f1'),false);
});

test('194地点省略引用不接受重复、倒序、重叠、空片段、缺字或超出原预算', () => {
  for (const [content, quote] of [
    ['甲。甲。乙。', '甲。……乙。'], ['甲。乙。', '乙。……甲。'], ['甲乙丙', '甲乙……乙丙'],
    ['甲。乙。', '……甲。……乙。'], ['甲。乙。', '甲。……乙。……'], ['甲。乙。', '甲。……丙。'],
    ['甲。乙。', '甲。..乙。'], ['甲。乙。', '甲。……'],
    [Array.from({length:9},(_,i)=>`段${i}。`).join(''), Array.from({length:9},(_,i)=>`段${i}。`).join('……')],
    ['甲'.repeat(2001)+'乙。', '甲'.repeat(2001)+'……乙。'],
  ]) assert.equal(locatePlaceQuote(content, quote, { allowOmission: true }), null, quote.slice(0,40));
  assert.equal(locatePlaceQuote('甲。中间。乙。', '甲。……乙。'), null, '普通引用通道不默认恢复省略');
});

test('196只补缺证据地点精确firstSeen已存成员来源，同楼去重且不借聚合锚楼或失效原文',async()=>{
 const floors=[{id:'f1',assistantSeq:1,content:{canonicalContent:'第一楼地点原文。'}},{id:'f2',assistantSeq:2,content:{canonicalContent:'第二楼地点原文。'}}],memory={id:'memory-aggregate',floorId:'f2',sourceFloorIds:['f1','f2'],sourceCanonicalContent:'不可借用的聚合全文',sourceFloorSnapshots:[{floorId:'f1',canonicalContent:floors[0].content.canonicalContent},{floorId:'f2',canonicalContent:floors[1].content.canonicalContent}]};
 const entities=[{id:'e1',entityType:'place',firstSeenFloorId:'f1'},{id:'e2',entityType:'place',firstSeenFloorId:'f2'},{id:'e3',entityType:'place',firstSeenFloorId:'f1'}],entityKeys=new Map([['e1','place-1'],['e2','place-2'],['e3','place-3']]),bodySources=[{placeKeys:['place-2','place-3']}],memoriesByFloor=new Map([['f1',memory],['f2',memory]]);
 const result=await collectMissingPlaceSources({entities,entityKeys,bodySources,floors,memoriesByFloor});assert.equal(result.length,1);assert.equal(result[0].floorId,'f1');assert.equal(result[0].canonicalContent,'第一楼地点原文。');assert.deepEqual(result[0].placeKeys,['place-1','place-3']);assert.equal(result[0].requiresExactQuote,true);
 const unavailable=await collectMissingPlaceSources({entities,entityKeys,bodySources,floors:[{...floors[0],content:{canonicalContent:'已编辑的新正文'}},floors[1]],memoriesByFloor});assert.deepEqual(unavailable,[]);
 const missingMember={...memory,sourceFloorSnapshots:memory.sourceFloorSnapshots.slice(1)};assert.deepEqual(await collectMissingPlaceSources({entities,entityKeys,bodySources,floors,memoriesByFloor:new Map([['f1',missingMember]])}),[]);
 assert.deepEqual(await collectMissingPlaceSources({entities,entityKeys,bodySources,floors:[floors[1]],memoriesByFloor}),[]);
});
