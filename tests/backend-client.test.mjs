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

test('backend 成功响应头之后读取 body 超时仍记为 timeout，不会误报 success 或自动重试', async () => {
  let calls = 0;
  const client = createBackendClient({
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('body aborted'), { name: 'AbortError' })), { once: true })),
      };
    },
  });
  await assert.rejects(client.get('chat-x', 'v3-root'), error => error.name === 'TimeoutError' && error.code === 'BACKEND_TIMEOUT');
  const snapshot = client.getDiagnosticSnapshot();
  assert.equal(calls, 1);
  assert.deepEqual(snapshot.sinceClientCreatedRequestCounts, { get: 1, put: 0, delete: 0 });
  assert.equal(snapshot.latestRead.outcome, 'timeout');
  assert.equal(snapshot.latestRead.code, 'BACKEND_TIMEOUT');
  assert.equal(snapshot.lastFailure.sequence, snapshot.latestRead.sequence);
});

test('backend 成功响应的 body 外部中止和坏 JSON 都保留真实失败结果', async () => {
  const controller = new AbortController();
  const abortedClient = createBackendClient({
    timeoutMs: 1000,
    fetchImpl: async (_url, { signal }) => ({
      ok: true,
      status: 200,
      json: () => signal.aborted
        ? Promise.reject(Object.assign(new Error('body aborted'), { name: 'AbortError' }))
        : new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('body aborted'), { name: 'AbortError' })), { once: true })),
    }),
  });
  const pending = abortedClient.put('chat-x', 'v3-root', {}, 0, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  const aborted = abortedClient.getDiagnosticSnapshot();
  assert.deepEqual(aborted.sinceClientCreatedRequestCounts, { get: 0, put: 1, delete: 0 });
  assert.equal(aborted.latestWrite.outcome, 'aborted');

  const parseError = new SyntaxError('unexpected private body');
  const invalidClient = createBackendClient({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw parseError; } }) });
  await assert.rejects(invalidClient.get('chat-x', 'v3-root'), error => error === parseError);
  const invalid = invalidClient.getDiagnosticSnapshot();
  assert.equal(invalid.latestRead.outcome, 'failure');
  assert.equal(invalid.lastFailure.sequence, invalid.latestRead.sequence);
  assert.deepEqual(invalid.sinceClientCreatedRequestCounts, { get: 1, put: 0, delete: 0 });
});

test('backend 非成功 HTTP 不读取 JSON body，仍保留原状态诊断', async () => {
  let bodyReads = 0;
  const statuses = [500, 409, 404];
  const client = createBackendClient({ fetchImpl: async () => ({
    ok: false,
    status: statuses.shift(),
    json: async () => { bodyReads += 1; throw new SyntaxError('HTML、空体或坏 JSON'); },
  }) });
  await assert.rejects(client.get('chat-x', 'v3-root'), error => error.status === 500);
  assert.equal(client.getDiagnosticSnapshot().latestRead.httpStatus, 500);
  await assert.rejects(client.put('chat-x', 'v3-root', {}, 0), error => error.status === 409);
  assert.equal(client.getDiagnosticSnapshot().latestWrite.httpStatus, 409);
  await assert.rejects(client.remove('chat-x', 'v3-root', 1), error => error.status === 404);
  const snapshot = client.getDiagnosticSnapshot();
  assert.equal(snapshot.latestWrite.httpStatus, 404);
  assert.equal(snapshot.latestWrite.outcome, 'httpError');
  assert.equal(bodyReads, 0);
  assert.deepEqual(snapshot.sinceClientCreatedRequestCounts, { get: 1, put: 1, delete: 1 });
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

test('backend list/remove 使用当前 namespace 与精确 revision', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => options.method === 'DELETE' ? { trashId: 'trash' } : [] };
  };
  const client = createBackendClient({ fetchImpl, baseUrl: '/api/plugins/bainiaodata/v1', timeoutMs: 50 });
  assert.deepEqual(await client.list('chat/a b'), []);
  await client.remove('chat/a b', 'root/id', 7);
  assert.match(calls[0].url, /\/records\/qianqianjie\/chat%2Fa%20b$/);
  assert.match(calls[1].url, /\/records\/qianqianjie\/chat%2Fa%20b\/root%2Fid$/);
  assert.equal(calls[1].options.method, 'DELETE');
  assert.deepEqual(JSON.parse(calls[1].options.body), { expectedRevision: 7 });
});

test('backend 诊断按 client 生命周期统计 records 请求并只暴露固定记录类型', async () => {
  const privateCollection = 'chat-PRIVATE_COLLECTION';
  const privateBody = 'PRIVATE_RESPONSE_BODY';
  const fetchImpl = async url => ({
    ok: true,
    status: 200,
    json: async () => url.endsWith('/health')
      ? { ok: true, api: { current: 1, supported: [1] }, capabilities: { records: true, optimisticRevision: true } }
      : { privateBody },
  });
  const client = createBackendClient({ fetchImpl, timeoutMs: 50 });
  assert.deepEqual(client.getDiagnosticSnapshot(), {
    sinceClientCreatedRequestCounts: { get: 0, put: 0, delete: 0 }, latestRead: null, latestWrite: null, lastFailure: null,
  });
  await client.health();
  const cases = [
    ['v3-root', 'root'], ['v3-floor-memory-private', 'floorMemory'], ['v3-floor-private', 'floor'],
    ['v3-run-private', 'run'], ['v3-checkpoint-private', 'checkpoint'], ['v3-entity-private', 'entity'],
    ['v3-baseline-private', 'baseline'], ['v3-state-delta-private', 'stateDelta'],
    ['v3-current-state-private', 'currentState'], ['v3-index-private', 'index'],
    ['binding-private', 'binding'], ['v3-people-workspace', 'peopleWorkspace'], ['private-record-id', 'unknown'],
  ];
  for (const [recordId, recordType] of cases) {
    await client.get(privateCollection, recordId);
    assert.equal(client.getDiagnosticSnapshot().latestRead.recordType, recordType);
  }
  await client.list(privateCollection);
  await client.put(privateCollection, 'v3-entity-private', { privateBody }, 0);
  await client.remove(privateCollection, 'v3-floor-private', 1);
  const snapshot = client.getDiagnosticSnapshot();
  assert.deepEqual(snapshot.sinceClientCreatedRequestCounts, { get: cases.length + 1, put: 1, delete: 1 });
  assert.equal(snapshot.latestRead.recordType, 'collection');
  assert.equal(snapshot.latestWrite.method, 'DELETE');
  assert.equal(snapshot.latestWrite.recordType, 'floor');
  for (const record of [snapshot.latestRead, snapshot.latestWrite]) {
    assert.ok(Number.isSafeInteger(record.sequence) && record.sequence > 0);
    assert.ok(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0);
    assert.match(record.completedAt, /^\d{4}-/);
    assert.equal(record.outcome, 'success');
  }
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_COLLECTION|PRIVATE_RESPONSE_BODY|private-record-id/);
  snapshot.sinceClientCreatedRequestCounts.get = 999;
  snapshot.latestRead.recordType = 'tampered';
  const next = client.getDiagnosticSnapshot();
  assert.equal(next.sinceClientCreatedRequestCounts.get, cases.length + 1);
  assert.equal(next.latestRead.recordType, 'collection');
});

test('backend 诊断保留最近失败，后续成功不清除 timeout 与 HTTP 失败', async () => {
  let timeoutCalls = 0;
  const timeoutClient = createBackendClient({
    timeoutMs: 5,
    fetchImpl: (_url, { signal }) => {
      timeoutCalls += 1;
      if (timeoutCalls > 1) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('private timeout body')), { once: true }));
    },
  });
  await assert.rejects(timeoutClient.get('private-collection', 'v3-root'), error => error.name === 'TimeoutError' && error.code === 'BACKEND_TIMEOUT');
  const timeoutFailure = timeoutClient.getDiagnosticSnapshot().lastFailure;
  assert.equal(timeoutFailure.outcome, 'timeout'); assert.equal(timeoutFailure.code, 'BACKEND_TIMEOUT');
  await timeoutClient.get('private-collection', 'v3-root');
  const afterSuccess = timeoutClient.getDiagnosticSnapshot();
  assert.equal(afterSuccess.latestRead.outcome, 'success');
  assert.ok(afterSuccess.latestRead.sequence > timeoutFailure.sequence);
  assert.deepEqual(afterSuccess.lastFailure, timeoutFailure);
  assert.doesNotMatch(JSON.stringify(afterSuccess), /private timeout body|private-collection/);

  let httpCalls = 0;
  const httpClient = createBackendClient({ fetchImpl: async () => {
    httpCalls += 1;
    return httpCalls === 1
      ? { ok: false, status: 409, json: async () => ({ private: 'PRIVATE_HTTP_BODY' }) }
      : { ok: true, status: 200, json: async () => ({ ok: true }) };
  } });
  await assert.rejects(httpClient.put('private', 'v3-entity-private', { private: 'PRIVATE_INPUT' }, 0), error => error.status === 409 && error.message === '后端请求失败（HTTP 409）');
  const httpFailure = httpClient.getDiagnosticSnapshot().lastFailure;
  assert.equal(httpFailure.outcome, 'httpError'); assert.equal(httpFailure.httpStatus, 409);
  await httpClient.remove('private', 'v3-entity-private', 1);
  assert.deepEqual(httpClient.getDiagnosticSnapshot().lastFailure, httpFailure);
  assert.doesNotMatch(JSON.stringify(httpClient.getDiagnosticSnapshot()), /PRIVATE_HTTP_BODY|PRIVATE_INPUT|v3-entity-private/);
});

test('backend 外部取消保留原错误对象且诊断不复制错误内容', async () => {
  const original = Object.assign(new Error('PRIVATE_ABORT_MESSAGE'), { name: 'AbortError', code: 'PRIVATE_ABORT_CODE' });
  const client = createBackendClient({
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(original), { once: true })),
    timeoutMs: 1000,
  });
  const controller = new AbortController();
  const pending = client.list('PRIVATE_ABORT_COLLECTION', { signal: controller.signal });
  controller.abort('PRIVATE_ABORT_REASON');
  await assert.rejects(pending, error => error === original);
  const snapshot = client.getDiagnosticSnapshot();
  assert.equal(snapshot.latestRead.outcome, 'aborted');
  assert.equal(snapshot.latestRead.recordType, 'collection');
  assert.equal(snapshot.lastFailure.sequence, snapshot.latestRead.sequence);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_ABORT/);
});
