import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256, sha256Bytes } from '../src/identity.js';
import { foundationInputSnapshot, scanAssistantCandidates } from '../src/v3/foundation-domain.js';

test('缺少 WebCrypto subtle 时调用宿主 SHA 接口，并可完成生产指纹扫描', async () => {
  const previousCrypto = globalThis.crypto;
  const previousHost = globalThis.SillyTavern;
  const received = [];
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
  globalThis.SillyTavern = { libs: { sha256(bytes) { received.push(bytes); return createHash('sha256').update(bytes).digest('hex'); } } };
  try {
    for (const value of ['中文🙂', '\ud800']) {
      assert.equal(await sha256(value), createHash('sha256').update(String(value)).digest('hex'));
    }
    const candidates = await scanAssistantCandidates([
      { is_user: false, is_system: false, mes: '第一段🙂', swipes: ['第一段🙂'], swipe_id: 0 },
      { is_user: true, is_system: false, mes: '继续', send_date: '2026-09-13T00:00:00.000Z' },
    ], { chatId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    const snapshot = await foundationInputSnapshot(candidates, 1);
    assert.equal(candidates.length, 1);
    assert.match(candidates[0].rawFingerprint, /^sha256:[0-9a-f]{64}$/u);
    assert.match(snapshot.fingerprint, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(received.length > 2, true);
    assert.equal(received.every(bytes => bytes instanceof Uint8Array), true);
  } finally {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: previousCrypto });
    if (previousHost === undefined) delete globalThis.SillyTavern;
    else globalThis.SillyTavern = previousHost;
  }
});

test('字节SHA在WebCrypto与宿主路径均精确处理ArrayBuffer和带偏移的Uint8Array，字符串接口保持原编码', async () => {
  const previousCrypto = globalThis.crypto, previousHost = globalThis.SillyTavern;
  const textBytes = new TextEncoder().encode('中文🙂𠮷');
  const padded = new Uint8Array(textBytes.length + 4); padded.fill(255); padded.set(textBytes, 2);
  const bytes = padded.subarray(2, -2), expected = createHash('sha256').update(textBytes).digest('hex');
  globalThis.SillyTavern = { libs: { sha256(input) {
    assert.ok(input instanceof Uint8Array); return createHash('sha256').update(input).digest('hex');
  } } };
  try {
    for (const cryptoImpl of [previousCrypto, {}]) {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: cryptoImpl });
      assert.equal(await sha256Bytes(bytes), expected);
      assert.equal(await sha256Bytes(textBytes.buffer), expected);
      assert.equal(await sha256Bytes(new Uint8Array([0, 255, 128])), createHash('sha256').update(new Uint8Array([0, 255, 128])).digest('hex'));
      assert.equal(await sha256(new Uint8Array([1, 2])), createHash('sha256').update('1,2').digest('hex'));
    }
  } finally {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: previousCrypto });
    if (previousHost === undefined) delete globalThis.SillyTavern; else globalThis.SillyTavern = previousHost;
  }
});
