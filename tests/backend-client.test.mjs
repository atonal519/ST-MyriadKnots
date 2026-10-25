import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { API_BASE } from '../src/constants.js';
import { createBackendClient } from '../src/backend-client.js';
import * as backendModule from '../src/backend-client.js';
import { publicErrorMessage } from '../src/public-error.js';

function withGlobals(values, callback) {
  const previous = new Map();
  for (const [key, value] of Object.entries({ fetch: globalThis.fetch, ...values })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  return Promise.resolve().then(callback).finally(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
}

const asBytes = body => typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);

test('batch PUT sends one acknowledged package and uses only cached capability', async () => {
  const calls = []; let active = 0, maxActive = 0;
  const client = createBackendClient({ fetchImpl: async (url, options) => {
    calls.push([url, options]); active++; maxActive = Math.max(maxActive, active);
    try {
      if (url.endsWith('/health')) return Response.json({ ok: true, api: { current: 1, supported: [1] }, capabilities: { records: true, optimisticRevision: true, recordBatchWrite: true } });
      const { records } = JSON.parse(options.body); assert.ok(Buffer.byteLength(options.body) <= 1048576);
      return Response.json(records.map(item => ({ recordId: item.recordId, status: 200, envelope: { revision: 1, data: item.data } })));
    } finally { active--; }
  } });
  const records = Array.from({ length: 64 }, (_, index) => ({ recordId: `r-${index}`, data: { text: `完整材料${index}` }, expectedRevision: 0 }));
  assert.equal(await client.putMany('chat', records), null); assert.equal(calls.length, 0, '不为批写新增健康探测');
  await client.health();
  const result = await client.putMany('chat', records);
  assert.deepEqual(result.map(item => item.envelope.data), records.map(item => item.data));
  assert.equal(calls.length, 2); assert.equal(calls[1][1].method, 'PUT'); assert.match(calls[1][0], /record-batch/); assert.equal(maxActive, 1);
  await assert.rejects(client.putMany('chat', [...records, records[0]])); assert.equal(calls.length, 2);
});

test('batch package iterator is UTF8-bounded, keeps order and sends oversized records singly', () => {
  assert.equal(typeof backendModule.recordWriteBatches, 'function');
  const entries = Array.from({ length: 129 }, (_, index) => ({ recordId: `r-${index}`, data: '字'.repeat(index === 64 ? 360000 : 6000), expectedRevision: 0 }));
  const seen = []; let single = 0, packets = 0;
  for (const group of backendModule.recordWriteBatches(entries)) {
    assert.ok(group.records.length <= 64);
    if (group.single) { single++; assert.equal(group.records.length, 1); assert.equal(group.records[0], entries[64]); }
    else { packets++; assert.ok(Buffer.byteLength(JSON.stringify({ records: group.records })) <= 1048576); }
    seen.push(...group.records);
  }
  assert.equal(single, 1); assert.ok(packets >= 4); assert.deepEqual(seen, entries);
  let consumed = 0;
  const lazy = backendModule.recordWriteBatches((function* () { for (let index = 0; index < 6400; index++) { consumed++; yield { recordId: `lazy-${index}`, data: {}, expectedRevision: 0 }; } })());
  assert.equal(lazy.next().value.records.length, 64); assert.equal(consumed, 65, '只生成当前包和下一条，不预制全部包字符串');
});

test('batch PUT HTTP or result errors never trigger a resend or single-write fallback', async () => {
  for (const mode of ['http', 'order', 'json']) {
    let writes = 0;
    const client = createBackendClient({ fetchImpl: async (url, options) => {
      if (url.endsWith('/health')) return Response.json({ ok: true, api: { current: 1, supported: [1] }, capabilities: { records: true, optimisticRevision: true, recordBatchWrite: true } });
      writes++; assert.equal(options.method, 'PUT');
      if (mode === 'http') return Response.json({}, { status: 500 });
      if (mode === 'json') return new Response('{');
      return Response.json([{ recordId: 'wrong', status: 200, envelope: { revision: 1, data: {} } }]);
    } });
    await client.health(); await assert.rejects(client.putMany('chat', [{ recordId: 'one', data: {}, expectedRevision: 0 }])); assert.equal(writes, 1);
  }
});

test('backend GET 超时会退出且不自动重试', async () => {
  let calls = 0;
  const fetchImpl = (_url, { signal }) => {
    calls += 1;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
  };
  const client = createBackendClient({ fetchImpl, timeoutMs: 5 });
  await assert.rejects(client.get('chat-x', 'meta'), error => error.name === 'TimeoutError'
    && error.code === 'BACKEND_TIMEOUT'
    && error.message.includes('读取记忆超时')
    && publicErrorMessage(error).includes('复制状态诊断'));
  assert.equal(calls, 1);
});

test('backend collection list 使用独立长超时，普通请求仍使用默认短超时', async () => {
  let calls = 0;
  const fetchImpl = (_url, { signal }) => new Promise((resolve, reject) => {
    calls += 1;
    const timer = setTimeout(() => resolve({ ok: true, status: 200, json: async () => [] }), 20);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
  });
  const client = createBackendClient({ fetchImpl, timeoutMs: 5, listTimeoutMs: 50 });
  await assert.rejects(client.get('chat-x', 'v3-root'), error => error.code === 'BACKEND_TIMEOUT');
  assert.deepEqual(await client.list('chat-x'), []);
  assert.equal(calls, 2);
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

test('backend HTTP 400 仅将短 error/message 写入诊断，解析失败仍保留原始 HTTP 错误', async () => {
  const responses = [
    { ok: false, status: 400, json: async () => ({ error: 'VALIDATION_ERROR', message: '字段格式无效', details: { private: 'PRIVATE_DETAIL' } }) },
    { ok: true, status: 200, json: async () => ({ ok: true }) },
    { ok: false, status: 400, json: async () => { throw new SyntaxError('PRIVATE_BAD_JSON'); } },
    { ok: false, status: 400, json: async () => '<html>PRIVATE_HTML</html>' },
  ];
  const client = createBackendClient({ fetchImpl: async () => responses.shift() });
  await assert.rejects(client.put('private-chat', 'v3-floor-memory-private', { private: 'PRIVATE_REQUEST' }, 0), error => error.status === 400 && error.message === '保存记忆失败（HTTP 400）。请到“记忆管理”页点击“复制状态诊断”反馈。');
  const valid = client.getDiagnosticSnapshot();
  assert.equal(valid.latestWrite.backendError, 'VALIDATION_ERROR');
  assert.equal(valid.lastFailure.backendMessage, '字段格式无效');
  assert.doesNotMatch(JSON.stringify(valid), /PRIVATE_DETAIL|PRIVATE_REQUEST|private-chat|v3-floor-memory-private/);
  await client.get('private-chat', 'v3-root');
  assert.equal(client.getDiagnosticSnapshot().latestRead.outcome, 'success');
  assert.deepEqual(client.getDiagnosticSnapshot().lastFailure, valid.lastFailure);

  await assert.rejects(client.put('private-chat', 'v3-floor-memory-private', {}, 0), error => error.status === 400 && error.message === '保存记忆失败（HTTP 400）。请到“记忆管理”页点击“复制状态诊断”反馈。');
  const malformed = client.getDiagnosticSnapshot();
  assert.equal(malformed.latestWrite.httpStatus, 400);
  assert.equal(malformed.latestWrite.backendError, undefined);
  assert.equal(malformed.latestWrite.backendMessage, undefined);

  await assert.rejects(client.put('private-chat', 'v3-floor-memory-private', {}, 0), error => error.status === 400 && error.message === '保存记忆失败（HTTP 400）。请到“记忆管理”页点击“复制状态诊断”反馈。');
  const nonJson = client.getDiagnosticSnapshot();
  assert.equal(nonJson.lastFailure.httpStatus, 400);
  assert.equal(nonJson.lastFailure.backendError, undefined);
  assert.equal(nonJson.lastFailure.backendMessage, undefined);
  assert.doesNotMatch(JSON.stringify(nonJson), /PRIVATE_BAD_JSON|PRIVATE_HTML/);
  assert.equal(createBackendClient({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) }).getDiagnosticSnapshot().lastFailure, null);
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

test('backend list/remove/permanent remove 使用当前 namespace、独立路径与精确 revision', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => options.method === 'DELETE' ? { trashId: 'trash' } : [] };
  };
  const client = createBackendClient({ fetchImpl, baseUrl: '/api/plugins/bainiaodata/v1', timeoutMs: 50 });
  assert.deepEqual(await client.list('chat/a b'), []);
  await client.remove('chat/a b', 'root/id', 7);
  await client.removePermanent('chat/a b', 'root/id', 8);
  assert.match(calls[0].url, /\/records\/qianqianjie\/chat%2Fa%20b$/);
  assert.match(calls[1].url, /\/records\/qianqianjie\/chat%2Fa%20b\/root%2Fid$/);
  assert.equal(calls[1].options.method, 'DELETE');
  assert.deepEqual(JSON.parse(calls[1].options.body), { expectedRevision: 7 });
  assert.match(calls[2].url, /\/records\/qianqianjie\/chat%2Fa%20b\/root%2Fid\/permanent$/);
  assert.equal(calls[2].options.method, 'DELETE');
  assert.deepEqual(JSON.parse(calls[2].options.body), { expectedRevision: 8 });
});

test('backend permanent remove 沿用普通请求超时与 HTTP 错误合同', async () => {
  const timeoutClient = createBackendClient({
    timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })),
  });
  await assert.rejects(timeoutClient.removePermanent('chat-x', 'v3-run-x', 1), error => error.code === 'BACKEND_TIMEOUT');

  let bodyReads = 0;
  const missingClient = createBackendClient({ fetchImpl: async () => ({ ok: false, status: 404, json: async () => { bodyReads += 1; return {}; } }) });
  await assert.rejects(missingClient.removePermanent('chat-x', 'v3-run-x', 1), error => error.status === 404);
  assert.equal(bodyReads, 0);
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
  await assert.rejects(httpClient.put('private', 'v3-entity-private', { private: 'PRIVATE_INPUT' }, 0), error => error.status === 409 && error.message === '保存记忆失败（HTTP 409）。请到“记忆管理”页点击“复制状态诊断”反馈。');
  const httpFailure = httpClient.getDiagnosticSnapshot().lastFailure;
  assert.equal(httpFailure.outcome, 'httpError'); assert.equal(httpFailure.httpStatus, 409);
  await httpClient.remove('private', 'v3-entity-private', 1);
  assert.deepEqual(httpClient.getDiagnosticSnapshot().lastFailure, httpFailure);
  assert.doesNotMatch(JSON.stringify(httpClient.getDiagnosticSnapshot()), /PRIVATE_HTTP_BODY|PRIVATE_INPUT|v3-entity-private/);
});

test('记忆存储连接失败用记忆操作说明，不沿用模型 API 地址指引', async () => {
  const cause = new TypeError('Failed to fetch');
  const client = createBackendClient({ fetchImpl: async () => { throw cause; } });
  await assert.rejects(client.get('chat-x', 'v3-root'), error => {
    assert.equal(error.cause, cause);
    assert.match(error.message, /^读取记忆失败，无法连接记忆存储服务/u);
    const visible = publicErrorMessage(error);
    assert.match(visible, /记忆存储服务/u);
    assert.match(visible, /记忆管理.*复制状态诊断/u);
    assert.doesNotMatch(visible, /API 地址|API Key/u);
    return true;
  });
  const snapshot = client.getDiagnosticSnapshot();
  assert.equal(snapshot.lastFailure.outcome, 'failure');
  assert.equal(snapshot.latestRead.recordType, 'root');
});

test('请求准备阶段失败保留真实原因，不误报为记忆存储连接失败', async () => {
  const cause = new Error('本地请求头配置失败');
  const client = createBackendClient({ headers: () => { throw cause; }, fetchImpl: async () => { throw new Error('不应调用'); } });
  await assert.rejects(client.get('chat-x', 'v3-root'), error => error === cause);
  assert.equal(client.getDiagnosticSnapshot().latestRead.outcome, 'failure');
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

test('默认 HTTP 大 PUT gzip 后无损往返，GET/DELETE/小 PUT 保持原请求体且记录安全字节诊断', async () => {
  await withGlobals({ __TAURITAVERN__: undefined, __TAURITAVERN_MAIN_READY__: undefined }, async () => {
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true, revision: options.method === 'PUT' ? 3 : undefined }) };
    };
    const client = createBackendClient();
    const data = {
      floorProvenance: Array.from({ length: 80 }, (_, index) => ({
        floorId: `楼层-${index}`, kind: 'source', text: '阿裴把蓝色钥匙塞在砖后。摘要仍保留完整诊断与时间来源。'.repeat(70),
        diagnostics: { selected: true, verification: '完整复核', elapsedMs: 1234 },
      })),
      summary: '关系记录🙂',
    };
    const expected = { data, expectedRevision: 7 };
    await client.put('chat-x', 'v3-root', data, 7);
    const put = calls[0];
    assert.equal(put.url, `${API_BASE}/v1/records/qianqianjie/chat-x/v3-root`);
    assert.equal(put.options.method, 'PUT');
    assert.equal(put.options.headers['Content-Type'], 'application/json');
    assert.equal(put.options.headers['Content-Encoding'], 'gzip');
    assert.ok(put.options.body instanceof Uint8Array);
    assert.deepEqual(JSON.parse(gunzipSync(asBytes(put.options.body)).toString('utf8')), expected);
    const write = client.getDiagnosticSnapshot().latestWrite;
    assert.equal(write.bodyBytes, Buffer.byteLength(JSON.stringify(expected)));
    assert.equal(write.encodedBodyBytes, put.options.body.byteLength);
    assert.equal(write.contentEncoding, 'gzip');
    assert.ok(write.encodedBodyBytes < write.bodyBytes);
    assert.doesNotMatch(JSON.stringify(client.getDiagnosticSnapshot()), /蓝色钥匙|v3-root|chat-x/);

    await client.put('chat-x', 'small', { value: '短记录' }, 0);
    const small = calls[1];
    assert.equal(typeof small.options.body, 'string');
    assert.equal(small.options.headers['Content-Encoding'], undefined);
    assert.equal(client.getDiagnosticSnapshot().latestWrite.contentEncoding, 'identity');
    assert.equal(client.getDiagnosticSnapshot().latestWrite.bodyBytes, Buffer.byteLength(small.options.body));
    assert.equal(client.getDiagnosticSnapshot().latestWrite.encodedBodyBytes, Buffer.byteLength(small.options.body));

    await client.get('chat-x', 'v3-root');
    await client.remove('chat-x', 'v3-root', 8);
    assert.equal(calls[2].options.headers['Content-Encoding'], undefined);
    assert.equal(calls[3].options.headers['Content-Encoding'], undefined);
    assert.equal(typeof calls[3].options.body, 'string');
    assert.deepEqual(client.getDiagnosticSnapshot().sinceClientCreatedRequestCounts, { get: 1, put: 2, delete: 1 });
  });
});

test('默认 HTTP 压缩准备不支持或失败时只发送一次原 JSON；显式自定义 baseUrl 仍不压缩', async () => {
  const large = { text: '保留完整存档🙂'.repeat(12000) };
  for (const Compression of [undefined, class { constructor() { throw new Error('compression unavailable'); } }]) {
    await withGlobals({ __TAURITAVERN__: undefined, __TAURITAVERN_MAIN_READY__: undefined, CompressionStream: Compression }, async () => {
      const calls = [];
      globalThis.fetch = async (_url, options) => { calls.push(options); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
      const client = createBackendClient();
      await client.put('chat-x', 'v3-root', large, 4);
      assert.equal(calls.length, 1);
      assert.equal(typeof calls[0].body, 'string');
      assert.equal(calls[0].headers['Content-Encoding'], undefined);
      assert.equal(client.getDiagnosticSnapshot().sinceClientCreatedRequestCounts.put, 1);
      assert.equal(client.getDiagnosticSnapshot().latestWrite.contentEncoding, 'identity');
    });
  }

  await withGlobals({ __TAURITAVERN__: undefined, __TAURITAVERN_MAIN_READY__: undefined }, async () => {
    const calls = [];
    globalThis.fetch = async (_url, options) => { calls.push(options); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
    const client = createBackendClient({ baseUrl: '/custom-backend' });
    await client.put('chat-x', 'v3-root', large, 4);
    assert.equal(calls.length, 1);
    assert.equal(typeof calls[0].body, 'string');
    assert.equal(calls[0].headers['Content-Encoding'], undefined);
    assert.equal(client.getDiagnosticSnapshot().latestWrite.contentEncoding, 'identity');
  });

  const injectedCalls = [];
  const injectedClient = createBackendClient({ fetchImpl: async (_url, options) => {
    injectedCalls.push(options);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  } });
  await injectedClient.put('chat-x', 'v3-root', large, 4);
  assert.equal(injectedCalls.length, 1);
  assert.equal(typeof injectedCalls[0].body, 'string');
  assert.equal(injectedCalls[0].headers['Content-Encoding'], undefined);
  assert.equal(injectedClient.getDiagnosticSnapshot().latestWrite.contentEncoding, 'identity');
});

test('默认 HTTP gzip 准备计入原请求时限和外部取消，取消后不启动迟到 fetch', async () => {
  let startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  class WaitingCompressionStream {
    constructor() {
      startedResolve();
      this.readable = new ReadableStream({ start() {} });
      this.writable = new WritableStream({ write() {} });
    }
  }
  await withGlobals({ __TAURITAVERN__: undefined, __TAURITAVERN_MAIN_READY__: undefined, CompressionStream: WaitingCompressionStream }, async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls += 1; return { ok: true, status: 200, json: async () => ({}) }; };
    const timeoutClient = createBackendClient({ timeoutMs: 12 });
    await assert.rejects(timeoutClient.put('chat-x', 'v3-root', { text: 'x'.repeat(40000) }, 0), error => error.code === 'BACKEND_TIMEOUT');
    assert.equal(fetchCalls, 0, '压缩阶段耗尽期限时不能迟到发出 PUT');
    assert.equal(timeoutClient.getDiagnosticSnapshot().latestWrite.outcome, 'timeout');
    assert.equal(timeoutClient.getDiagnosticSnapshot().latestWrite.encodedBodyBytes, undefined, '压缩尚未完成时不记录未准备好的传输体大小');
    assert.equal(timeoutClient.getDiagnosticSnapshot().sinceClientCreatedRequestCounts.put, 1);
  });

  const externalStarted = (() => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve }; })();
  class ExternalWaitingCompressionStream {
    constructor() {
      externalStarted.resolve();
      this.readable = new ReadableStream({ start() {} });
      this.writable = new WritableStream({ write() {} });
    }
  }
  await withGlobals({ __TAURITAVERN__: undefined, __TAURITAVERN_MAIN_READY__: undefined, CompressionStream: ExternalWaitingCompressionStream }, async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls += 1; return { ok: true, status: 200, json: async () => ({}) }; };
    const client = createBackendClient({ timeoutMs: 1000 });
    const controller = new AbortController();
    const pending = client.put('chat-x', 'v3-root', { text: 'y'.repeat(40000) }, 0, { signal: controller.signal });
    await externalStarted.promise;
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(fetchCalls, 0, '外部取消后不能再发出 PUT');
    assert.equal(client.getDiagnosticSnapshot().latestWrite.outcome, 'aborted');
    assert.equal(client.getDiagnosticSnapshot().sinceClientCreatedRequestCounts.put, 1);
  });
  await started;
});

test('同一模拟限速下默认 HTTP gzip 可在期限内上传，未压缩的大请求会超时且不重试', async () => {
  const data = { text: '压缩传输保留中文、完整历史诊断和来源。'.repeat(10000) };
  const requestBody = JSON.stringify({ data, expectedRevision: 12 });
  const limitRateFetch = async (_url, options) => {
    const bytes = asBytes(options.body);
    const duration = bytes.byteLength / 500_000 * 1000;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, duration);
      const abort = () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
      options.signal.addEventListener('abort', abort, { once: true });
    });
    const received = options.headers['Content-Encoding'] === 'gzip' ? gunzipSync(bytes) : bytes;
    assert.deepEqual(JSON.parse(received.toString('utf8')), { data, expectedRevision: 12 });
    return { ok: true, status: 200, json: async () => ({ revision: 13 }) };
  };
  const identityCalls = [];
  const identityClient = createBackendClient({ timeoutMs: 50, fetchImpl: async (url, options) => { identityCalls.push(options); return limitRateFetch(url, options); } });
  await assert.rejects(identityClient.put('chat-x', 'v3-root', data, 12), error => error.code === 'BACKEND_TIMEOUT');
  assert.equal(identityCalls.length, 1);

  await withGlobals({ __TAURITAVERN__: undefined, __TAURITAVERN_MAIN_READY__: undefined }, async () => {
    const compressedCalls = [];
    globalThis.fetch = async (url, options) => { compressedCalls.push(options); return limitRateFetch(url, options); };
    const compressedClient = createBackendClient({ timeoutMs: 50 });
    assert.deepEqual(await compressedClient.put('chat-x', 'v3-root', data, 12), { revision: 13 });
    assert.equal(compressedCalls.length, 1);
    assert.equal(compressedCalls[0].headers['Content-Encoding'], 'gzip');
    const snapshot = compressedClient.getDiagnosticSnapshot();
    assert.equal(snapshot.latestWrite.contentEncoding, 'gzip');
    assert.equal(snapshot.latestWrite.bodyBytes, Buffer.byteLength(requestBody));
    assert.ok(snapshot.latestWrite.encodedBodyBytes < snapshot.latestWrite.bodyBytes);
    assert.equal(snapshot.sinceClientCreatedRequestCounts.put, 1);
  });
});

test('默认 HTTP 压缩 PUT 对 409/400 保持原状态诊断且不明文重发', async () => {
  await withGlobals({ __TAURITAVERN__: undefined, __TAURITAVERN_MAIN_READY__: undefined }, async () => {
    const calls = [];
    let bodyReads = 0;
    globalThis.fetch = async (_url, options) => {
      calls.push(options);
      return calls.length === 1
        ? { ok: false, status: 409, json: async () => { bodyReads++; return {}; } }
        : { ok: false, status: 400, json: async () => { bodyReads++; return { error: 'VALIDATION_ERROR', message: '记录无效' }; } };
    };
    const client = createBackendClient();
    const large = { text: '完整存档与诊断'.repeat(6000) };
    await assert.rejects(client.put('chat-x', 'v3-root', large, 9), error => error.status === 409);
    assert.equal(client.getDiagnosticSnapshot().latestWrite.httpStatus, 409);
    assert.equal(client.getDiagnosticSnapshot().latestWrite.contentEncoding, 'gzip');
    await assert.rejects(client.put('chat-x', 'v3-root', large, 9), error => error.status === 400);
    assert.equal(client.getDiagnosticSnapshot().latestWrite.backendError, 'VALIDATION_ERROR');
    assert.equal(calls.length, 2, '每个失败 PUT 恰好发一次，不降级补发');
    assert.ok(calls.every(call => call.headers['Content-Encoding'] === 'gzip'));
    assert.equal(bodyReads, 1, '409保持不读取body，400仅读取一次原有短诊断');
    assert.deepEqual(client.getDiagnosticSnapshot().sinceClientCreatedRequestCounts, { get: 0, put: 2, delete: 0 });
  });
});

const batchHealth = capabilities => ({ ok: true, api: { current: 1, supported: [1] },
  capabilities: { records: true, optimisticRevision: true, ...capabilities } });

test('后端批量读取先协商能力并保留请求顺序与状态', async () => {
  const calls = [];
  const client = createBackendClient({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/v1/health')) return { ok: true, status: 200, json: async () => batchHealth({ recordBatchRead: true }) };
    return { ok: true, status: 200, json: async () => [
      { recordId: 'a', status: 200, envelope: { revision: 2, data: { value: 'A' } } },
      { recordId: 'b', status: 404, error: 'not_found', message: 'Record not found' },
    ] };
  } });
  assert.deepEqual(await client.getMany('chat-x', ['a', 'b']), [
    { recordId: 'a', status: 200, envelope: { revision: 2, data: { value: 'A' } } },
    { recordId: 'b', status: 404, error: 'not_found', message: 'Record not found' },
  ]);
  assert.match(calls[1].url, /\/v1\/record-batch\/qianqianjie\/chat-x$/);
  assert.deepEqual(JSON.parse(calls[1].options.body), { recordIds: ['a', 'b'] });
  assert.equal(client.getDiagnosticSnapshot().latestRead.method, 'POST');
  assert.equal(client.getDiagnosticSnapshot().sinceClientCreatedRequestCounts.post, 1);
});

test('旧后端无批量能力时按最多16路并发回落到单记录读取', async () => {
  let active = 0, maximum = 0;
  const calls = [];
  const client = createBackendClient({ fetchImpl: async (url, options) => {
    calls.push(url);
    if (url.endsWith('/v1/health')) return { ok: true, status: 200, json: async () => batchHealth({}) };
    active += 1; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active -= 1;
    const recordId = decodeURIComponent(url.split('/').at(-1));
    return { ok: true, status: 200, json: async () => ({ revision: 1, data: { recordId } }) };
  } });
  const ids = Array.from({ length: 20 }, (_, index) => `id-${index}`);
  const result = await client.getMany('chat-x', ids);
  assert.deepEqual(result.map(item => item.recordId), ids);
  assert.equal(result.every(item => item.status === 200), true);
  assert.ok(maximum > 1 && maximum <= 16);
  assert.equal(calls.length, 21);
});

test('批量读取拒绝与请求顺序或记录数不符的后端响应', async () => {
  const client = createBackendClient({ fetchImpl: async url => url.endsWith('/v1/health')
    ? { ok: true, status: 200, json: async () => batchHealth({ recordBatchRead: true }) }
    : { ok: true, status: 200, json: async () => [{ recordId: 'wrong', status: 200, envelope: { revision: 1, data: {} } }] } });
  await assert.rejects(client.getMany('chat-x', ['expected']), /后端批量读取结果无效/);
});

test('后端记录迭代使用轻量ID清单并按64条分批读取', async () => {
  const calls = [];
  const ids = Array.from({ length: 65 }, (_, index) => `id-${index}`);
  const client = createBackendClient({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/v1/health')) return { ok: true, status: 200, json: async () => batchHealth({ recordBatchRead: true, recordIdList: true }) };
    if (url.includes('/v1/record-ids/')) return { ok: true, status: 200, json: async () => ids };
    const recordIds = JSON.parse(options.body).recordIds;
    return { ok: true, status: 200, json: async () => recordIds.map(recordId => ({ recordId, status: 200, envelope: { revision: 1, data: { recordId } } })) };
  } });
  const records = [];
  for await (const record of client.iterRecords('chat-x')) records.push(record);
  assert.equal(records.length, 65);
  assert.deepEqual(records.map(record => record.recordId), ids);
  assert.equal(calls.filter(call => call.url.includes('/v1/record-batch/')).length, 2);
  assert.deepEqual(JSON.parse(calls.find(call => call.url.includes('/v1/record-batch/')).options.body).recordIds, ids.slice(0, 64));
});

test('记录迭代在旧后端能力缺失时保留 collection list 回落', async () => {
  const calls = [];
  const records = [{ recordId: 'a', revision: 1, data: { value: 1 } }];
  const client = createBackendClient({ fetchImpl: async (url, options) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => url.endsWith('/v1/health') ? batchHealth({}) : records };
  } });
  const result = [];
  for await (const record of client.iterRecords('chat-x')) result.push(record);
  assert.deepEqual(result, records);
  assert.equal(calls.some(url => url.endsWith('/v1/records/qianqianjie/chat-x')), true);
  assert.equal(calls.some(url => url.includes('/v1/record-ids/')), false);
});
