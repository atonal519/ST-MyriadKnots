import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackendClient } from '../src/backend-client.js';

test('backend GET 超时会退出且不自动重试', async () => {
  let calls = 0;
  const fetchImpl = (_url, { signal }) => {
    calls += 1;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
  };
  const client = createBackendClient({ fetchImpl, timeoutMs: 5 });
  await assert.rejects(client.get('chat-x', 'meta'), error => error.name === 'TimeoutError' && error.code === 'BACKEND_TIMEOUT');
  assert.equal(calls, 1);
});

test('backend 正常响应仍保持原 GET/PUT 合同', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  const client = createBackendClient({ fetchImpl, timeoutMs: 50 });
  await client.get('chat-x', 'meta'); await client.put('chat-x', 'meta', { value: 1 }, 0);
  assert.equal(calls.length, 2); assert.equal(calls[1].options.method, 'PUT'); assert.deepEqual(JSON.parse(calls[1].options.body), { data: { value: 1 }, expectedRevision: 0 });
});

test('backend PUT 可选 signal 传给 fetch，不传时仍兼容', async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const client = createBackendClient({ fetchImpl, timeoutMs: 50 });
  const controller = new AbortController();
  await client.put('chat-x', 'with-signal', { value: 1 }, 0, { signal: controller.signal });
  await client.put('chat-x', 'without-signal', { value: 2 }, 0);
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.notEqual(calls[0].signal, controller.signal);
  assert.ok(calls[1].signal instanceof AbortSignal);
});
