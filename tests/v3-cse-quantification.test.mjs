import test from 'node:test';
import assert from 'node:assert/strict';
import { CSE_EMOTIONS, normalizeCseQuantification, advanceAdaptiveStrength, formatCseQuantification, isCseQuantificationOnlyChange } from '../src/v3/cse-quantification.js';

test('可选情绪独立稀疏规范化，坏维度局部跳过，保0且固定顺序', () => {
  assert.deepEqual(CSE_EMOTIONS, ['亲近', '满足', '兴奋', '松弛', '期待', '担忧', '恐惧', '失望', '悲伤', '不满', '反感', '羞怯', '愧疚', '嫉妒']);
  assert.deepEqual(normalizeCseQuantification({ emotions: { 反感: 70, 亲近: 65.26, 不满: 30, 满足: 0, 愧疚: '20', 担忧: 101, 恐惧: -1, 悲伤: NaN, 兴奋: Infinity, 未知: 40 } }, 'situational'),
    { emotions: { 亲近: 65.3, 满足: 0, 不满: 30, 反感: 70 } });
  for (const value of [null, [], {}, { emotions: {} }, { emotions: { 担忧: '30' } }]) assert.equal(normalizeCseQuantification(value, 'situational'), null);
  assert.equal(normalizeCseQuantification({ strength: 50, emotions: { 亲近: 60 } }, 'core'), null);
  assert.deepEqual(normalizeCseQuantification({ strength: 30.36, emotions: { 亲近: 60 } }, 'adaptive'), { strength: 30.4 });
});

test('成长按0.2跟随且单次±5，一位小数，未知旧值仅初始化', () => {
  for (const [before, target, expected] of [[30, 80, 35], [30, 50, 34], [30, 10, 26], [30, 32, 30.4], [0, 0, 0], [undefined, 70, 70], [null, 50, 50]]) {
    assert.equal(advanceAdaptiveStrength(before, target), expected);
  }
  for (const target of [undefined, null, '30', Infinity, -1, 101]) assert.equal(advanceAdaptiveStrength(30, target), null);
});


test('外露与情绪独立接纳，0与小数保留，独立外露可格式化且不改变归属', () => {
  for (const [expression, expected] of [[0, 0], [100, 100], [33.36, 33.4]]) {
    for (const emotions of [undefined, null, [], { 担忧: '30' }]) {
      assert.deepEqual(normalizeCseQuantification({ emotions, expression }, 'situational'), { expression: expected });
    }
  }
  for (const expression of [undefined, null, '20', NaN, Infinity, -1, 101]) {
    assert.deepEqual(normalizeCseQuantification({ emotions: { 担忧: 40 }, expression }, 'situational'), { emotions: { 担忧: 40 } });
    assert.equal(normalizeCseQuantification({ emotions: [], expression }, 'situational'), null);
  }
  assert.equal(normalizeCseQuantification({ expression: 30 }, 'core'), null);
  assert.deepEqual(normalizeCseQuantification({ strength: 50, expression: 30 }, 'adaptive'), { strength: 50 });
  assert.equal(formatCseQuantification({ quantification: { expression: 0 } }, 'situational'), '（外露程度：0）');
  assert.equal(formatCseQuantification({ quantification: { emotions: { 亲近: 65 }, expression: 20 } }, 'situational'), '（情绪强度：亲近65；外露程度：20）');
  const before = { text: '仍担忧乙', visibility: 'private', towardEntityId: '乙', reason: '尚未脱险', origin: 'floor', quantification: { emotions: { 担忧: 40 }, expression: 0 } };
  const after = { ...before, quantification: { emotions: { 担忧: 40 }, expression: 30 } };
  assert.equal(isCseQuantificationOnlyChange({ before, after, category: 'situational' }), true);
  assert.equal(isCseQuantificationOnlyChange({ before, after: { ...after, visibility: 'expressed' }, category: 'situational' }), false);
});
