import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateRecallDiagnostics, projectPrivateRecallDiagnostic, PRIVATE_DIAGNOSTIC_COLLECTION } from '../src/private-recall-diagnostics.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
const fixture = () => ({ recallStatus: 'stale', lastRecallBinding: { chatId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  lastRecall: { status: 'stale', userMessageIndex: 103, createdAt: '2026-10-03T14:23:49.000Z', generationType: 'normal', diagnosticPhase: 'commit',
    skipReasons: ['sourceUnavailable', 'SECRET'], injectionText: '', receiptPersistence: 'none', selectedFloors: [{}],
    selectorDiagnostic: { mode: 'llm', model: 'SECRET' },
    attemptDiagnostics: [{ attempt: 1, phase: 'commit', error: { code: 'V3_RECALL_MEMORY_PREPARATION_TIMEOUT', message: 'SECRET' } }],
    timings: { selectorMs: 17000, commitMs: 3000, totalMs: 21000 }, stages: { estimatedTokenCount: 7936, estimatedTokenBudget: 8000 } },
  requestDiagnostic: { status: 'recording', id: 1, requests: [{ label: '更新聊天', startedAt: 100, responseStartedAt: 200, url: 'SECRET', body: 'SECRET' }] } });
function harness({ client, policy = { enabled: true }, initiallyEnabled = true, ...options } = {}) {
  let state = fixture(), enabled = initiallyEnabled, fetchCalls = 0;
  const listeners = new Set(), records = new Map(), writes = [];
  client ??= { async get(_collection, id) { if (!records.has(id)) throw { status: 404 }; return structuredClone(records.get(id)); },
    async put(collection, id, data, revision) { assert.equal(collection, PRIVATE_DIAGNOSTIC_COLLECTION); assert.equal(revision, records.get(id)?.revision ?? 0);
      const envelope = { revision: revision + 1, data: structuredClone(data) }; records.set(id, envelope); writes.push(envelope); return envelope; } };
  const channel = createPrivateRecallDiagnostics({ client, recallRuntime: { getState: () => state, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } },
    fetchImpl: async (_url, options) => { fetchCalls++; assert.equal(options.cache, 'no-store'); return { ok: true, json: async () => policy }; },
    isEnabled: () => enabled, random: () => 0, pollMs: 1000000, flushMs: 1000000,
    bundleUrl: 'https://private.invalid/qqj-app.js?v=20261003.9-test', ...options });
  return { channel, writes, records, listeners, setEnabled: value => { enabled = value; }, fetchCalls: () => fetchCalls,
    change(value) { state = value; for (const fn of listeners) fn(); } };
}

test('自动留存未写聊天的失效结果与HTTP时间，严格排除正文和凭证', async t => {
  const h = harness(); t.after(h.channel.dispose);
  assert.equal(await h.channel.start(), true);
  assert.equal(await h.channel.flush(), true);
  const event = h.writes[0].data.events[0].data;
  assert.deepEqual(event.last.skipReasons, ['sourceUnavailable']);
  assert.equal(event.last.timings.totalMs, 21000);
  assert.equal(event.requests.entries[0].responseStartedAt, 200);
  assert.equal(h.writes[0].data.bundleVersion, '20261003.9-test');
  assert.doesNotMatch(JSON.stringify(h.writes), /SECRET|private\.invalid|injectionText|responseText|message"|model"|url"|key"/u);
  const malformed = fixture(); malformed.lastRecall.timings.totalMs = Infinity; malformed.lastRecall.userMessageIndex = 'SECRET';
  const safe = projectPrivateRecallDiagnostic(malformed, { error: 'SECRET' });
  assert.equal(safe.last.timings.totalMs, null); assert.equal(safe.last.userMessageIndex, null);
  assert.doesNotMatch(JSON.stringify(safe), /SECRET/u);
});

test('停用及无私有开关时不采集；启用后定长留存、相同状态零重复写入，关闭后不再写', async t => {
  const off = harness({ policy: { enabled: false } }); t.after(off.channel.dispose);
  assert.equal(await off.channel.start(), false); await off.channel.flush(); assert.equal(off.writes.length, 0); assert.equal(off.listeners.size, 0);
  const h = harness({ initiallyEnabled: false }); t.after(h.channel.dispose);
  assert.equal(await h.channel.start(), false); assert.equal(h.fetchCalls(), 0);
  h.setEnabled(true); await h.channel.start(); await h.channel.flush();
  for (let i = 0; i < 5; i++) h.channel.capture(); await h.channel.flush(); assert.equal(h.writes.length, 1);
  for (let i = 0; i < 40; i++) { const next = fixture(); next.lastRecall.userMessageIndex = i; h.change(next); }
  await h.channel.flush(); assert.equal(h.writes.at(-1).data.events.length, 32); assert.equal(h.writes.at(-1).data.events[0].data.last.userMessageIndex, 8);
  h.setEnabled(false); h.change(fixture()); await h.channel.flush(); assert.equal(h.writes.length, 2);
  h.channel.dispose(); assert.equal(h.listeners.size, 0);
});

test('诊断写入未结束不会阻止新召回；期间新失效状态在下一次刷新保存，冲突及网络失败不抛回业务', async t => {
  let resolvePut, calls = 0, revision = 0, saved;
  const h = harness({ client: { async get() { return { revision }; }, async put(_collection, _id, data, expected) {
    assert.equal(expected, revision); calls++;
    if (calls === 1) await new Promise(resolve => { resolvePut = resolve; });
    if (calls === 3) throw { status: 409 };
    if (calls === 4) throw new Error('SECRET');
    saved = data; return { revision: ++revision }; } } }); t.after(h.channel.dispose);
  await h.channel.start(); const first = h.channel.flush(); await settle();
  const next = fixture(); next.lastRecall.userMessageIndex = 105; h.change(next);
  assert.equal(calls, 1); assert.equal(h.channel.flush(), first);
  resolvePut(); await first; await h.channel.flush(); assert.equal(saved.events.at(-1).data.last.userMessageIndex, 105);
  next.lastRecall.userMessageIndex = 107; h.change(next); assert.equal(await h.channel.flush(), false);
  next.lastRecall.userMessageIndex = 109; h.change(next); assert.equal(await h.channel.flush(), false);
  next.lastRecall.userMessageIndex = 111; h.change(next); assert.equal(await h.channel.flush(), true);
});

test('刷新销毁后迟到的诊断读取不能发起写入，也不再采集', async () => {
  let resolveRead, writes = 0;
  const h = harness({ client: { get: () => new Promise(resolve => { resolveRead = resolve; }), put: async () => { writes++; } } });
  await h.channel.start(); const pending = h.channel.flush(); await settle();
  h.channel.dispose(); resolveRead({ revision: 2 }); assert.equal(await pending, false);
  h.change(fixture()); assert.equal(writes, 0); assert.equal(h.listeners.size, 0);
});

test('自动记录页面前后台切换与连接阶段，销毁后移除监听；旧记录兼容为空', async t => {
  const callbacks = new Set();
  const documentRef = { visibilityState: 'visible', addEventListener(name, fn) { assert.equal(name, 'visibilitychange'); callbacks.add(fn); },
    removeEventListener(_name, fn) { callbacks.delete(fn); } };
  const h = harness({ documentRef }); t.after(h.channel.dispose);
  await h.channel.start(); await h.channel.flush();
  documentRef.visibilityState = 'hidden'; for (const fn of callbacks) fn(); await h.channel.flush();
  assert.equal(h.writes.at(-1).data.events.at(-1).data.pageVisibility, 'hidden');
  const next = fixture(); next.requestDiagnostic.requests[0] = { label: '生成请求', protocol: 'http/1.1', connectStartedAt: 100, connectFinishedAt: 220000, transferSize: 0 };
  h.change(next); await h.channel.flush();
  const request = h.writes.at(-1).data.events.at(-1).data.requests.entries[0];
  assert.equal(request.connectFinishedAt - request.connectStartedAt, 219900); assert.equal(request.protocol, 'http/1.1'); assert.equal(request.transferSize, 0);
  assert.equal(request.workerStartedAt, null);
  const bad = projectPrivateRecallDiagnostic({ requestDiagnostic: { requests: [{ label: '生成请求', protocol: 'SECRET', connectStartedAt: 'SECRET' }] } }, { visibilityState: 'SECRET' });
  assert.doesNotMatch(JSON.stringify(bad), /SECRET/u);
  h.channel.dispose(); assert.equal(callbacks.size, 0);
});

test('准备诊断只保有限子阶段枚举和数字，每attempt最多两条且不泄漏私密字段', () => {
  const state = fixture();
  const record = { phase: 'commit', mode: 'fresh', stage: 'prepare', status: 'timeout', totalMs: 5123, budgetMs: 5000,
    identityMs: 1, rootMs: 2, prepareMs: 5120, readMs: 0, projectionMs: 0, source: 'SECRET', url: 'SECRET', error: 'SECRET' };
  state.lastRecall.timings.preparationAttempts = [record];
  state.lastRecall.attemptDiagnostics[0].timings = { preparationAttempts: [record, { ...record, phase: 'source', stage: 'SECRET', rootMs: 'SECRET' }, record] };
  const result = projectPrivateRecallDiagnostic(state);
  assert.equal(result.last.timings.preparationAttempts[0].prepareMs, 5120);
  assert.equal(result.last.attempts[0].timings.preparationAttempts.length, 2);
  assert.equal(result.last.attempts[0].timings.preparationAttempts[1].stage, null);
  assert.equal(result.last.attempts[0].timings.preparationAttempts[1].rootMs, null);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|"url":|"source":|"error":"/u);
});
