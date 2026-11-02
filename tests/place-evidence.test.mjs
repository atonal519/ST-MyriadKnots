import test from 'node:test';
import assert from 'node:assert/strict';
import { locatePlaceQuote } from '../src/v3/place-evidence.js';

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
