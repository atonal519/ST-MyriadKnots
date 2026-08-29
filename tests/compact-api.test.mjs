import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompactApiClient, normalizeApiUrl, parseJsonOutput } from '../src/compact-api-client.js';

const config = overrides => ({ url: 'https://api.example.test', key: 'TEST_KEY', model: 'compact-model', excludeParams: [], timeoutSec: 5, stream: false, ...overrides });
const jsonResponse = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const sseResponse = chunks => {
  const encoder = new TextEncoder(); let index = 0;
  return { ok: true, status: 200, body: { getReader: () => ({ read: async () => index < chunks.length ? { done: false, value: encoder.encode(chunks[index++]) } : { done: true } }) } };
};

test('Base URL 规范化且独立请求只含紧凑 system/user、schema 与代理字段', async () => {
  assert.equal(normalizeApiUrl('https://api.example.test/'), 'https://api.example.test/v1'); assert.equal(normalizeApiUrl('https://api.example.test/v1/chat/completions'), 'https://api.example.test/v1');
  let request;
  const client = createCompactApiClient({ headers: () => ({ 'X-Test': 'yes' }), fetchImpl: async (path, options) => { request = { path, options, body: JSON.parse(options.body) }; return jsonResponse({ choices: [{ message: { content: '{"confirmed":[],"candidate":[],"discarded":[]}' } }] }); } });
  const result = await client.generateTask({ config: config(), taskMessages: [{ role: 'user', content: '冻结来源：人物甲' }, { role: 'assistant', content: '后续聊天正文' }], jsonSchema: { name: 'people', value: { type: 'object' }, strict: true } });
  assert.deepEqual(result.jsonData, { confirmed: [], candidate: [], discarded: [] }); assert.equal(request.path, '/api/backends/chat-completions/generate');
  assert.equal(request.body.reverse_proxy, 'https://api.example.test/v1'); assert.equal(request.body.proxy_password, 'TEST_KEY'); assert.equal(request.body.model, 'compact-model');
  assert.deepEqual(request.body.messages.map(item => item.role), ['system', 'user']); assert.match(request.body.messages[1].content, /冻结来源/); assert.doesNotMatch(JSON.stringify(request.body.messages), /后续聊天正文|sanctuary|jailbreak/i);
  assert.equal(request.body.response_format.type, 'json_schema'); assert.equal(request.body.response_format.json_schema.name, 'people'); assert.equal(request.body.temperature, 0.2); assert.equal(request.body.max_tokens, 12000);
});

test('任务可注入独立 system 文案并显式传递 maxTokens，默认人物 system 行为不变', async () => {
  const bodies = []; const client = createCompactApiClient({ fetchImpl: async (_path, options) => { bodies.push(JSON.parse(options.body)); return jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] }); } });
  await client.generateTask({ config: config(), systemPrompt: 'RELATION SYSTEM {{user}} {{char}}', taskMessages: [{ role: 'user', content: 'x' }], maxTokens: 16000 });
  await client.generateTask({ config: config(), taskMessages: [{ role: 'user', content: 'x' }] });
  assert.equal(bodies[0].messages[0].content, 'RELATION SYSTEM {{user}} {{char}}'); assert.equal(bodies[0].max_tokens, 16000);
  assert.match(bodies[1].messages[0].content, /extract people only/i);
});

test('剔除参数不允许删除代理必需字段，可明确删除 response_format', async () => {
  let body; const client = createCompactApiClient({ fetchImpl: async (path, options) => { body = JSON.parse(options.body); return jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] }); } });
  await client.generateTask({ config: config({ excludeParams: ['model', 'messages', 'proxy_password', 'chat_completion_source', 'reverse_proxy', 'temperature', 'response_format'] }), taskMessages: [{ role: 'user', content: 'x' }], jsonSchema: { name: 'x', value: { type: 'object' } } });
  for (const key of ['model', 'messages', 'proxy_password', 'chat_completion_source', 'reverse_proxy']) assert.equal(Object.hasOwn(body, key), true);
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
  for (const [status, code] of [[401, 'QQJ_AUTH'], [404, 'QQJ_NOT_FOUND'], [429, 'QQJ_RATE_LIMIT'], [503, 'QQJ_SERVER']]) {
    let calls = 0; const client = createCompactApiClient({ retryWait: async () => {}, fetchImpl: async () => { calls += 1; return jsonResponse({}, status); } });
    await assert.rejects(client.generateTask({ config: config(), taskMessages: [] }), error => error.code === code && !error.message.includes('TEST_KEY'));
    assert.equal(calls, status === 429 || status >= 500 ? 3 : 1);
  }
});

test('模型列表与测试连接走安全代理；短测试不含聊天、人物或档案数据', async () => {
  const requests = []; const client = createCompactApiClient({ fetchImpl: async (path, options) => { const body = JSON.parse(options.body); requests.push({ path, body }); return path.endsWith('/status') ? jsonResponse({ data: [{ id: 'z-model' }, { id: 'a-model' }] }) : jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] }); } });
  assert.deepEqual(await client.fetchModels({ config: config() }), ['a-model', 'z-model']); assert.deepEqual(await client.testConnection({ config: config() }), { ok: true, model: 'compact-model' });
  assert.equal(requests[0].path, '/api/backends/chat-completions/status'); const testBody = requests[1].body; assert.equal(testBody.max_tokens, 48); assert.equal(testBody.temperature, 0); assert.equal(testBody.stream, false);
  assert.doesNotMatch(JSON.stringify(testBody.messages), /人物甲|档案|worldbook|greeting|聊天正文/i); assert.equal(testBody.messages.length, 2);
});
