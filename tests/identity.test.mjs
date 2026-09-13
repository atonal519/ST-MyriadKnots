import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256 } from '../src/identity.js';
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
