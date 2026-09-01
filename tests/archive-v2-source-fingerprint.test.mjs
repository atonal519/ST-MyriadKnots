import test from 'node:test';
import assert from 'node:assert/strict';
import { computeArchiveV2SourceFingerprint } from '../src/archive-v2-source-fingerprint.js';

const sources = () => [
  {
    kind: 'card',
    locator: 'card:alpha#description',
    fingerprint: `sha256:${'a'.repeat(64)}`,
    content: '沈砚\nAlpha',
    ignoredMetadata: { selected: true },
  },
  {
    kind: 'worldbook',
    locator: 'book:1',
    fingerprint: `sha256:${'b'.repeat(64)}`,
    content: '阿福',
  },
];

test('共享指纹与旧算法已知向量完全一致', async () => {
  assert.equal(
    await computeArchiveV2SourceFingerprint(sources()),
    'sha256:f9570cf2304c2d68d0a78fd579b468b4023e0e0637920939344c8b3575c12cfd',
  );
});

test('指纹保持输入顺序敏感', async () => {
  const original = sources();
  const reversed = [...original].reverse();
  assert.notEqual(
    await computeArchiveV2SourceFingerprint(original),
    await computeArchiveV2SourceFingerprint(reversed),
  );
});

test('计算不修改来源及其额外元数据', async () => {
  const input = sources();
  const before = structuredClone(input);
  await computeArchiveV2SourceFingerprint(input);
  assert.deepEqual(input, before);
});

test('只拒绝缺少四个字符串字段的最小非法输入', async () => {
  for (const input of [
    null,
    {},
    [null],
    [{ kind: 'future', locator: 'x', fingerprint: 'fp' }],
    [{ kind: 'future', locator: 'x', fingerprint: 'fp', content: 1 }],
  ]) {
    await assert.rejects(computeArchiveV2SourceFingerprint(input), TypeError);
  }
  assert.match(
    await computeArchiveV2SourceFingerprint([
      { kind: 'future-kind', locator: '', fingerprint: '', content: '' },
    ]),
    /^sha256:[0-9a-f]{64}$/,
  );
});
