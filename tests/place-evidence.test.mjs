import test from 'node:test';
import assert from 'node:assert/strict';
import { locatePlaceQuote, collectMissingPlaceSources } from '../src/v3/place-evidence.js';

test('194地点引用保原有省略号及空白匹配，恢复只保唯一正序短片段', () => {
  const content = '甲楼有客房。' + '中间剧情。'.repeat(500) + '客房里有书桌。';
  assert.deepEqual(locatePlaceQuote(content, '甲楼有客房。……客房里有书桌。', { allowOmission: true }).map(item => item.quote), ['甲楼有客房。', '客房里有书桌。']);
  for (const quote of ['甲楼……客房', '甲楼...客房']) assert.deepEqual(locatePlaceQuote(quote, quote, { allowOmission: true }).map(item => item.quote), [quote]);
  assert.deepEqual(locatePlaceQuote('甲楼\n\n有客房。', '甲楼 有客房。', { allowWhitespace: true, allowOmission: true }).map(item => item.quote), ['甲楼\n\n有客房。']);
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
