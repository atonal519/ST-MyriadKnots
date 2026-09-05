import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompactApiClient, normalizeApiUrl, parseJsonOutput } from '../src/compact-api-client.js';
import { createArchiveV2TaskRouter } from '../src/api-routing.js';

const config = overrides => ({ url: 'https://api.example.test', key: 'TEST_KEY', model: 'compact-model', excludeParams: [], timeoutSec: 5, stream: false, ...overrides });
const jsonResponse = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const sseResponse = chunks => {
  const encoder = new TextEncoder(); let index = 0;
  return { ok: true, status: 200, body: { getReader: () => ({ read: async () => index < chunks.length ? { done: false, value: encoder.encode(chunks[index++]) } : { done: true } }) } };
};

test('未注入 fetch 时在请求发生时读取宿主最新实现，显式注入不受全局替换影响', async () => {
  const previousFetch = globalThis.fetch;
  let earlyCalls = 0, lateCalls = 0, injectedCalls = 0, globalCalls = 0;
  try {
    globalThis.fetch = async () => { earlyCalls += 1; throw new Error('不应调用提前存在的 fetch'); };
    const dynamic = createCompactApiClient();
    globalThis.fetch = async () => { lateCalls += 1; return jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] }); };
    assert.deepEqual((await dynamic.generateTask({ config: config(), taskMessages: [] })).jsonData, { ok: true });
    assert.deepEqual({ earlyCalls, lateCalls }, { earlyCalls: 0, lateCalls: 1 });

    const injected = createCompactApiClient({ fetchImpl: async () => { injectedCalls += 1; return jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] }); } });
    globalThis.fetch = async () => { globalCalls += 1; throw new Error('显式注入时不应调用全局 fetch'); };
    assert.deepEqual((await injected.generateTask({ config: config(), taskMessages: [] })).jsonData, { ok: true });
    assert.deepEqual({ injectedCalls, globalCalls }, { injectedCalls: 1, globalCalls: 0 });

    globalThis.fetch = undefined;
    const unavailable = createCompactApiClient();
    await assert.rejects(unavailable.generateTask({ config: config(), taskMessages: [] }), error => error.message === 'fetch 不可用');
  } finally { globalThis.fetch = previousFetch; }
});

test('Base URL 规范化且独立请求只含紧凑 system/user、schema 与代理字段', async () => {
  assert.equal(normalizeApiUrl('https://api.example.test/'), 'https://api.example.test/v1'); assert.equal(normalizeApiUrl('https://api.example.test/v1/chat/completions'), 'https://api.example.test/v1');
  let request;
  const client = createCompactApiClient({ headers: () => ({ 'X-Test': 'yes' }), fetchImpl: async (path, options) => { request = { path, options, body: JSON.parse(options.body) }; return jsonResponse({ choices: [{ message: { content: '{"confirmed":[],"candidate":[],"discarded":[]}' } }] }); } });
  const result = await client.generateTask({ config: config(), taskMessages: [{ role: 'user', content: '冻结来源：人物甲' }, { role: 'assistant', content: '后续聊天正文' }], jsonSchema: { name: 'people', value: { type: 'object' }, strict: true } });
  assert.deepEqual(result.jsonData, { confirmed: [], candidate: [], discarded: [] }); assert.equal(request.path, '/api/backends/chat-completions/generate');
  assert.equal(request.body.reverse_proxy, 'https://api.example.test/v1'); assert.equal(request.body.proxy_password, 'TEST_KEY'); assert.equal(request.body.model, 'compact-model');
  assert.deepEqual(request.body.messages.map(item => item.role), ['system', 'user']); assert.match(request.body.messages[1].content, /冻结来源/); assert.doesNotMatch(JSON.stringify(request.body.messages), /后续聊天正文|sanctuary|jailbreak/i);
  assert.deepEqual(request.body.json_schema, { name: 'people', value: { type: 'object' }, strict: true }); assert.equal(Object.hasOwn(request.body, 'response_format'), false); assert.equal(request.body.temperature, 0.2); assert.equal(request.body.max_tokens, 12000);
});

test('任务可注入独立 system 文案并显式传递 maxTokens，默认人物 system 行为不变', async () => {
  const bodies = []; const client = createCompactApiClient({ fetchImpl: async (_path, options) => { bodies.push(JSON.parse(options.body)); return jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] }); } });
  await client.generateTask({ config: config(), systemPrompt: 'RELATION SYSTEM {{user}} {{char}}', taskMessages: [{ role: 'user', content: 'x' }], maxTokens: 16000 });
  await client.generateTask({ config: config(), taskMessages: [{ role: 'user', content: 'x' }] });
  assert.equal(bodies[0].messages[0].content, 'RELATION SYSTEM {{user}} {{char}}'); assert.equal(bodies[0].max_tokens, 16000);
  assert.match(bodies[1].messages[0].content, /extract people only/i);
});

test('剔除参数不允许删除代理与 schema 必需字段，且不发送上游 response_format', async () => {
  let body; const client = createCompactApiClient({ fetchImpl: async (path, options) => { body = JSON.parse(options.body); return jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] }); } });
  await client.generateTask({ config: config({ excludeParams: ['model', 'messages', 'proxy_password', 'chat_completion_source', 'reverse_proxy', 'json_schema', 'temperature', 'response_format'] }), taskMessages: [{ role: 'user', content: 'x' }], jsonSchema: { name: 'x', value: { type: 'object' } } });
  for (const key of ['model', 'messages', 'proxy_password', 'chat_completion_source', 'reverse_proxy', 'json_schema']) assert.equal(Object.hasOwn(body, key), true);
  assert.equal(Object.hasOwn(body, 'temperature'), false); assert.equal(Object.hasOwn(body, 'response_format'), false);
});

test('流式 SSE 与非流式 JSON 都经生产解析 seam，空输出/坏 JSON 安全失败', async () => {
  const streaming = createCompactApiClient({ fetchImpl: async () => sseResponse(['data: {"choices":[{"delta":{"content":"{\\"ok\\":"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"true}"}}]}\n\ndata: [DONE]\n\n']) });
  assert.deepEqual((await streaming.generateTask({ config: config({ stream: true }), taskMessages: [] })).jsonData, { ok: true });
  for (const content of ['', '```json\nnot-json\n```']) {
    const client = createCompactApiClient({ fetchImpl: async () => jsonResponse({ choices: [{ message: { content } }] }) });
    await assert.rejects(client.generateTask({ config: config(), taskMessages: [] }), error => /^QQJ_(EMPTY|COMPLETION_JSON)$/.test(error.code) && !error.message.includes('TEST_KEY'));
  }
});

test('semantic parseMode 把模型原文交给业务 normalizer，不被通用严格 JSON 解析提前拦截', async () => {
  const content = '说明\n```json\n[{"summary":"有效摘要",}]\n```\n完毕';
  const client = createCompactApiClient({ fetchImpl: async () => jsonResponse({ choices: [{ message: { content } }] }) });
  const result = await client.generateTask({ config: config(), taskMessages: [], parseMode: 'semantic' });
  assert.equal(result.textData, content);
  assert.equal(Object.hasOwn(result, 'jsonData'), false);
  const router = createArchiveV2TaskRouter({
    resolver: { resolve: () => ({ kind: 'independent', source: 'main', sourceLabel: '主配置', config: config() }), resolveUtility: () => ({ kind: 'independent', source: 'utility', sourceLabel: '副配置', config: config() }) },
    compactClient: client,
  });
  const routed = await router.generateUtilityTask({ taskMessages: [], parseMode: 'semantic' });
  assert.equal(routed.textData, content);
  assert.equal(routed.taskMetadata.source, 'utility');
});

test('completion JSON 兼容纯对象、完整围栏、单个说明围栏与唯一平衡对象', () => {
  const expected = { schemaVersion: 1, patches: [] };
  for (const value of [
    JSON.stringify(expected),
    '```json\n{"schemaVersion":1,"patches":[]}\n```',
    '以下是结果：\n```json\n{"schemaVersion":1,"patches":[]}\n```\n请查收。',
    '以下是唯一结果： {"schemaVersion":1,"patches":[]} 请查收。',
  ]) assert.deepEqual(parseJsonOutput(value), expected);
});

test('completion JSON 拒绝多对象、顶层数组和普通乱码；未闭合对象/围栏判截断', () => {
  for (const value of ['{"a":1} 和 {"b":2}', '[{"a":1}]', '普通乱码']) {
    assert.throws(() => parseJsonOutput(value), error => error.code === 'QQJ_COMPLETION_JSON' && error.formatStage === 'completion_json');
  }
  for (const value of ['说明 {"a":1', '```json\n{"a":1}']) {
    assert.throws(() => parseJsonOutput(value), error => error.code === 'QQJ_OUTPUT_TRUNCATED' && error.formatStage === 'output_truncated');
  }
});

test('finish_reason=stop 时只纠正结构尾部唯一缺失的对象右花括号', async () => {
  const recovered = parseJsonOutput('{"people":[{"person":"P1"}]', { finishReason: 'stop' });
  assert.deepEqual(recovered, { people: [{ person: 'P1' }] });
  assert.deepEqual(
    parseJsonOutput('{"people":[{"person":"P1"]}', { finishReason: 'stop' }),
    { people: [{ person: 'P1' }] },
  );
  for (const value of ['{"people":[{"person":"P1"}', '{"people":[{"person":"P1}]}']) {
    assert.throws(
      () => parseJsonOutput(value, { finishReason: 'stop' }),
      error => error.code === 'QQJ_OUTPUT_TRUNCATED',
    );
  }
  const client = createCompactApiClient({ fetchImpl: async () => jsonResponse({
    choices: [{ finish_reason: 'stop', message: { content: '{"people":[{"person":"P1"}]' } }],
  }) });
  assert.deepEqual((await client.generateTask({ config: config(), taskMessages: [] })).jsonData, { people: [{ person: 'P1' }] });
});

test('HTTP JSON、SSE event 与 finish_reason 截断使用独立安全阶段', async () => {
  const http = createCompactApiClient({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('SECRET body'); } }) });
  await assert.rejects(http.generateTask({ config: config(), taskMessages: [] }), error => error.code === 'QQJ_HTTP_RESPONSE_JSON' && error.formatStage === 'http_response_json' && !String(error.message).includes('SECRET'));
  const sse = createCompactApiClient({ fetchImpl: async () => sseResponse(['data: {bad event}\n\n']) });
  await assert.rejects(sse.generateTask({ config: config({ stream: true }), taskMessages: [] }), error => error.code === 'QQJ_STREAM_EVENT_JSON' && error.formatStage === 'stream_event_json');
  const truncated = createCompactApiClient({ fetchImpl: async () => jsonResponse({ choices: [{ finish_reason: 'length', message: { content: '{"ok":true}' } }] }) });
  await assert.rejects(truncated.generateTask({ config: config(), taskMessages: [] }), error => error.code === 'QQJ_OUTPUT_TRUNCATED' && error.formatStage === 'output_truncated' && error.finishReason === 'length');
});

test('timeout、主动 abort、401/404/429/5xx 均映射为有限脱敏错误', async () => {
  const hanging = createCompactApiClient({ timeoutMs: () => 5, fetchImpl: async (path, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })) });
  await assert.rejects(hanging.generateTask({ config: config(), taskMessages: [] }), error => error.code === 'QQJ_TIMEOUT');
  const controller = new AbortController(); controller.abort(); await assert.rejects(hanging.generateTask({ config: config(), taskMessages: [], signal: controller.signal }), error => error.name === 'AbortError');
  for (const [status, code] of [[401, 'QQJ_AUTH'], [403, 'QQJ_AUTH'], [404, 'QQJ_NOT_FOUND'], [429, 'QQJ_RATE_LIMIT'], [503, 'QQJ_SERVER']]) {
    let calls = 0; const client = createCompactApiClient({ retryWait: async () => {}, fetchImpl: async () => { calls += 1; return jsonResponse({}, status); } });
    await assert.rejects(client.generateTask({ config: config(), taskMessages: [] }), error => error.code === code && !error.message.includes('TEST_KEY'));
    assert.equal(calls, status === 429 || status >= 500 ? 3 : 1);
  }
});

test('HTTP 400/422 只保留标识符与模板化摘要，不泄露正文、Key、URL 或请求体', async () => {
  let calls = 0;
  const storyEcho = '明确叙事，林岑伸手取走钥匙。';
  const badRequest = createCompactApiClient({ fetchImpl: async () => {
    calls += 1;
    return jsonResponse({ error: { code: 400, status: 'INVALID_ARGUMENT', message: `Request contains an invalid argument. canonicalContent=${storyEcho}; credential=TEST_KEY; url=https://api.example.test; requestBody=DO_NOT_COPY_BODY` }, requestBody: 'DO_NOT_COPY_BODY' }, 400);
  } });
  await assert.rejects(badRequest.generateTask({ config: config(), taskMessages: [] }), error => {
    assert.equal(error.code, 'QQJ_REQUEST_FORMAT');
    assert.equal(error.status, 400); assert.equal(error.httpStatus, 400);
    assert.deepEqual(error.providerError, { code: '400', status: 'INVALID_ARGUMENT', message: '上游拒绝了请求参数' });
    assert.doesNotMatch(JSON.stringify(error.providerError), /林岑|钥匙|canonicalContent|DO_NOT_COPY_BODY|TEST_KEY|api\.example\.test|requestBody/);
    return true;
  });
  assert.equal(calls, 1, '400 参数错误不应盲目重试');

  const unsafeText = `Authorization: Bearer TEST_KEY at https://api.example.test ${'request payload '.repeat(600)}`;
  const unprocessable = createCompactApiClient({ fetchImpl: async () => ({ ok: false, status: 422, text: async () => unsafeText }) });
  await assert.rejects(unprocessable.generateTask({ config: config(), taskMessages: [] }), error => {
    assert.equal(error.code, 'QQJ_REQUEST_FORMAT'); assert.equal(error.httpStatus, 422);
    assert.deepEqual(error.providerError, { message: '上游认证或权限检查失败' });
    assert.doesNotMatch(JSON.stringify(error), /TEST_KEY|api\.example\.test|request payload/);
    return true;
  });

  const exactSecret = createCompactApiClient({ fetchImpl: async () => jsonResponse({ error: { message: 'credential TEST_KEY failed' } }, 400) });
  await assert.rejects(exactSecret.generateTask({ config: config(), taskMessages: [] }), error => error.providerError.message === '上游认证或权限检查失败' && !JSON.stringify(error).includes('TEST_KEY'));

  const longText = 'invalid field '.repeat(100);
  const encoder = new TextEncoder(); let reads = 0, cancelled = false;
  const bounded = createCompactApiClient({ fetchImpl: async () => ({ ok: false, status: 422, body: { getReader: () => ({ read: async () => { reads += 1; return { done: false, value: encoder.encode(longText.repeat(10)) }; }, cancel: async () => { cancelled = true; } }) } }) });
  await assert.rejects(bounded.generateTask({ config: config(), taskMessages: [] }), error => error.providerError.message === '上游拒绝了请求参数');
  assert.equal(reads, 1); assert.equal(cancelled, true, '错误体达到上限后应停止继续读取');

  const malformed = createCompactApiClient({ fetchImpl: async () => ({ ok: false, status: 400, text: async () => '{"error":{"message":"partial request body DO_NOT_COPY_BODY"' }) });
  await assert.rejects(malformed.generateTask({ config: config(), taskMessages: [] }), error => error.providerError.message === '上游返回了无法安全解析的错误 JSON' && !JSON.stringify(error).includes('DO_NOT_COPY_BODY'));
});

test('模型列表与测试连接走安全代理；短测试不含聊天、人物或档案数据', async () => {
  const requests = []; const client = createCompactApiClient({ fetchImpl: async (path, options) => { const body = JSON.parse(options.body); requests.push({ path, body }); return path.endsWith('/status') ? jsonResponse({ data: [{ id: 'z-model' }, { id: 'a-model' }] }) : jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] }); } });
  assert.deepEqual(await client.fetchModels({ config: config() }), ['a-model', 'z-model']); assert.deepEqual(await client.testConnection({ config: config() }), { ok: true, model: 'compact-model' });
  assert.equal(requests[0].path, '/api/backends/chat-completions/status'); const testBody = requests[1].body; assert.equal(testBody.max_tokens, 48); assert.equal(testBody.temperature, 0); assert.equal(testBody.stream, false);
  assert.doesNotMatch(JSON.stringify(testBody.messages), /人物甲|档案|worldbook|greeting|聊天正文/i); assert.equal(testBody.messages.length, 2); assert.equal(Object.hasOwn(testBody, 'json_schema'), false);
  assert.match(testBody.messages[0].content, /JSON text connection check/);
});
