import test from 'node:test';
import assert from 'node:assert/strict';
import { createVectorApiClient, normalizeVectorConfig, resolveVectorConfig, VECTOR_DEFAULT_URL, VECTOR_DEFAULT_MODEL } from '../src/vector-api.js';
import { createVectorIndex, VECTOR_INDEX_ID, VECTOR_SHARD_PREFIX } from '../src/v3/vector-index.js';
import { projectVectorSources, rawWitnessValid } from '../src/v3/vector-source.js';
import { selectRecallWithLlm } from '../src/v3/recall-llm-selector.js';
import { createSettingsStore } from '../src/settings.js';
import { classifyStorageRecords } from '../src/storage-management.js';
import { sha256 } from '../src/identity.js';
import { createBackendClient } from '../src/backend-client.js';
import { projectPrivateRecallDiagnostic } from '../src/private-recall-diagnostics.js';

const hash = async text => `sha256:${await sha256(text)}`;
const flush = () => new Promise(resolve => setImmediate(resolve));
const config = { url: 'https://vector.invalid/v1', model: 'mock-embedding', key: 'test-key', dimensions: null };
const vectors = texts => texts.map(text => text.includes('苹果') ? [1, 0] : [0, 1]);
async function sourceFixture() {
  const floorMemories = Array.from({ length: 8 }, (_, i) => ({
    floorId: `floor-${i + 1}`, floorMemoryId: `memory-${i + 1}`, assistantSeq: i + 1, sourceFloorIds: [`floor-${i + 1}`],
    sourceAssistantSeqs: [i + 1], summary: `约定报告${i}，过往剧情。`, chronology: [], participants: [], locations: [], commitments: [], openLoops: [], exactAnchors: [], events: [], actions: [], observations: [], privateCognition: [], informationTransfers: [],
  }));
  const canonicalContent = '苹果派的配方是六百克苹果和一百克黄油。这是当时的计划，尚未烤制。';
  return { status: 'ready', chatId: 'chat', narrativeGeneration: 'generation', headCheckpointId: 'head', rootRevision: 1,
    floorMemories, currentState: [], cseChanges: [], entities: [], coverage: { stableAiFloors: 8, stableThroughAssistantSeq: 8, rememberedAiFloors: 8, missingAssistantSeq: [], cseThroughAssistantSeq: 0, memoryComplete: true, cseCurrent: false },
    rawSources: [{ floorId: 'floor-1', assistantSeq: 1, floorMemoryId: 'memory-1', memoryFloorId: 'floor-1', memoryAssistantSeq: 1, canonicalContent, fingerprint: await hash(canonicalContent) }],
  };
}
function harness(source, { api = { embed: async (_config, texts) => vectors(texts) } } = {}) {
  const records = new Map(), calls = []; let identity = { chatId: source.chatId }, current = source, route = config;
  const client = { get: async (_collection, id) => {
    if (!records.has(id)) throw Object.assign(new Error('not_found'), { status: 404 });
    const { recordId: _recordId, ...envelope } = records.get(id);
    return structuredClone(envelope);
  },
    put: async (collection, id, data, revision) => {
      assert.equal(revision, records.get(id)?.revision ?? 0);
      const record = { recordId: id, revision: revision + 1, data: structuredClone(data) }; records.set(id, record); calls.push({ collection, id }); return record;
    } };
  const index = createVectorIndex({ client, api, configProvider: () => route, identityProvider: () => identity, sourceProvider: async () => current });
  return { index, records, calls, client, setSource: value => { current = value; }, setIdentity: value => { identity = value; }, setConfig: value => { route = value; } };
}

test('白鳥 HTTP 合同：首次不存在返回404可建立，读取不带recordId的信封可恢复缓存', async () => {
  const records = new Map();
  const client = createBackendClient({ baseUrl: 'https://offline.invalid', fetchImpl: async (url, options) => {
    const [, namespace, collection, recordId] = new URL(url).pathname.match(/^\/v1\/records\/([^/]+)\/([^/]+)\/([^/]+)$/u);
    const key = `${namespace}/${collection}/${recordId}`;
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body), previous = records.get(key);
      assert.equal(body.expectedRevision, previous?.revision ?? 0);
      records.set(key, { schemaVersion: 1, revision: body.expectedRevision + 1, generationId: 'mock', data: body.data });
    }
    const value = records.get(key);
    return value ? { ok: true, json: async () => structuredClone(value) } : { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
  } });
  let modelCalls = 0;
  const source = await sourceFixture();
  const makeIndex = () => createVectorIndex({ client, api: { embed: async (_config, texts) => { modelCalls++; return vectors(texts); } },
    configProvider: () => config, identityProvider: () => ({ chatId: source.chatId }), sourceProvider: async () => source });
  await makeIndex().build();
  const stored = await client.get('chat-chat', VECTOR_INDEX_ID);
  assert.equal(stored.recordId, undefined, '白鳥 GET 返回记录信封，路径提供编号');
  const restored = makeIndex();
  assert.equal((await restored.query({ source, queryContext: { text: '苹果' } })).candidates.length, 1);
  assert.equal(restored.getState().status, 'ready');
  assert.equal((await restored.query({ source, queryContext: { text: '苹果' } })).candidates.length, 1);
  assert.equal(modelCalls, 2, '构建和查询各一次；恢复缓存不重建');
});

test('索引错误区分来源、缓存、向量和保存阶段；权限与冲突不视为未建立，提示不泄露正文', async () => {
  for (const phase of ['source', 'cache', 'embedding', 'verification', 'save']) {
    const source = await sourceFixture(), h = harness(source);
    let sourceReads = 0, modelCalls = 0;
    const status = phase === 'cache' ? 403 : phase === 'save' ? 409 : 500;
    const fail = () => { throw Object.assign(new Error('private body test-key'), { status }); };
    const index = createVectorIndex({
      client: { get: phase === 'cache' ? fail : h.client.get, put: phase === 'save' ? fail : h.client.put },
      api: { embed: async (_config, texts) => { modelCalls++; if (phase === 'embedding') fail(); return vectors(texts); } },
      configProvider: () => config, identityProvider: () => ({ chatId: source.chatId }),
      sourceProvider: async () => {
        sourceReads++;
        if (phase === 'source' || phase === 'verification' && sourceReads === 2) fail();
        return source;
      },
    });
    const labels = { source: '读取原文', cache: '读取索引', embedding: '生成向量', verification: '核验原文', save: '索引保存' };
    await assert.rejects(index.build(), error => error.code === `VECTOR_${phase.toUpperCase()}_FAILED`
      && error.message === `${labels[phase]}失败（HTTP ${status}），请重试。`);
    assert.equal(index.getState().status, 'error');
    assert.equal(index.getState().error.includes('test-key'), false);
    assert.equal(h.records.has(VECTOR_INDEX_ID), false);
    if (phase === 'source' || phase === 'cache') assert.equal(modelCalls, 0);
  }
});

test('保存阶段取消遵循后端 AbortSignal；不提交 manifest，也不显示保存失败', async () => {
  const source = await sourceFixture(), h = harness(source);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const index = createVectorIndex({
    client: { get: h.client.get, put: async (_collection, _id, _data, _revision, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      entered();
    }) },
    api: { embed: async (_config, texts) => vectors(texts) }, configProvider: () => config,
    identityProvider: () => ({ chatId: source.chatId }), sourceProvider: async () => source,
  });
  const build = index.build(); await started;
  index.abortAll();
  await assert.rejects(build, { code: 'VECTOR_ABORTED' });
  assert.equal(index.getState().status, 'idle');
  assert.equal(index.getState().error, '索引建立已取消。');
  assert.equal(h.records.has(VECTOR_INDEX_ID), false);
});

test('向量默认独立且初始关闭；留空 URL/模型使用硅基，显式失效预设不跟随分析', () => {
  const settings = createSettingsStore({ extensionSettings: {}, save: () => {} });
  assert.equal(resolveVectorConfig(settings), null);
  settings.update({ vectorEnabled: true, vectorKey: 'test-key' });
  assert.deepEqual(resolveVectorConfig(settings), { url: VECTOR_DEFAULT_URL, model: VECTOR_DEFAULT_MODEL, key: 'test-key', dimensions: 1024 });
  settings.update({ vectorPresetId: 'absent' });
  assert.throws(() => resolveVectorConfig(settings), { code: 'VECTOR_PRESET_MISSING' });
  assert.throws(() => normalizeVectorConfig({ url: 'https://user:secret@example.com', key: 'key' }), { code: 'VECTOR_CONFIG_INVALID' });
  assert.throws(() => normalizeVectorConfig({ key: '' }), { code: 'VECTOR_KEY_MISSING' });
});

test('标准 embeddings 请求批量、乱序回应、维度与归一化；不发送聊天参数', async () => {
  const requests = [];
  const api = createVectorApiClient({ fetchImpl: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ data: [{ index: 1, embedding: [0, 4] }, { index: 0, embedding: [3, 0] }] }) }; } });
  assert.deepEqual((await api.embed(config, ['苹果', '其他'])).map(vector => [...vector]), [[1, 0], [0, 1]]);
  assert.equal(requests[0].url, 'https://vector.invalid/v1/embeddings');
  assert.deepEqual(JSON.parse(requests[0].options.body), { model: config.model, input: ['苹果', '其他'], encoding_format: 'float' });
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-key');
});

test('正规讯飞 MaaS v1/v2 走宿主代理并透传手填模型、输入和凭证；硅基及相似域名仍直连', async () => {
  const requests = []; let hostHeaderReads = 0;
  const api = createVectorApiClient({ fetchImpl: async (url, options) => {
    requests.push({ url, options });
    const payload = JSON.parse(options.body), input = payload.input, dimensions = payload.dimensions ?? 3;
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: input.map((_, index) => ({ index,
      embedding: Array.from({ length: dimensions }, (_value, axis) => axis === index ? 1 : 0) })) }) };
  }, headers: () => { hostHeaderReads++; return { 'X-CSRF-Token': 'host-token', Authorization: 'do-not-forward', Cookie: 'do-not-forward' }; } });
  const xfyun = normalizeVectorConfig({ url: 'https://maas-api.cn-huabei-1.xf-yun.com/v2/embeddings', key: 'one-http-key', model: 'xop3qwen8bembedding' });
  assert.deepEqual((await api.embed(xfyun, ['测试输入', '第二项'])).map(vector => [...vector]), [[1, 0, 0], [0, 1, 0]]);
  assert.equal(requests[0].url, '/proxy/https%3A%2F%2Fmaas-api.cn-huabei-1.xf-yun.com%2Fv2%2Fembeddings');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer one-http-key');
  assert.equal(requests[0].options.headers['X-CSRF-Token'], 'host-token');
  assert.equal(requests[0].options.headers.Cookie, undefined);
  assert.deepEqual(JSON.parse(requests[0].options.body), { model: 'xop3qwen8bembedding', input: ['测试输入', '第二项'], encoding_format: 'float' });
  assert.equal(requests[0].options.signal instanceof AbortSignal, true);
  await api.embed(normalizeVectorConfig({ url: VECTOR_DEFAULT_URL, key: 'silicon-key' }), ['硅基直连']);
  await api.embed(normalizeVectorConfig({ url: 'https://maas-api.cn-huabei-1.xf-yun.com.evil.test/v2', key: 'other-key', model: 'custom' }), ['相似域名']);
  assert.equal(requests[1].url, `${VECTOR_DEFAULT_URL}/embeddings`);
  assert.equal(requests[1].options.headers['X-CSRF-Token'], undefined);
  assert.equal(hostHeaderReads, 1, '硅基直连不读取或发送宿主请求头');
  assert.equal(requests[2].url, 'https://maas-api.cn-huabei-1.xf-yun.com.evil.test/v2/embeddings');
});

test('讯飞代理关闭和 Basic 登录有专门提示；供应商 HTTP 与 JSON 错误不泄露正文', async () => {
  const xfyun = normalizeVectorConfig({ url: 'https://maas-api.cn-huabei-1.xf-yun.com/v1', key: 'test-key', model: 'xop3qwen8bembedding' });
  const response = (status, { body = '', challenge = null } = {}) => ({ ok: false, status,
    headers: { get: name => name.toLowerCase() === 'www-authenticate' ? challenge : null }, text: async () => body });
  const proxyOff = createVectorApiClient({ fetchImpl: async () => response(404, { body: 'CORS proxy is disabled. Enable it in config.yaml or use the --corsProxy flag.' }) });
  await assert.rejects(proxyOff.embed(xfyun, ['测试']), error => error.code === 'VECTOR_PROXY_DISABLED' && error.message === '请开启酒馆 CORS 代理并重启。');
  const basic = createVectorApiClient({ fetchImpl: async () => response(401, { challenge: 'Basic realm="SillyTavern"' }) });
  await assert.rejects(basic.embed(xfyun, ['测试']), { code: 'VECTOR_BASIC_AUTH_CONFLICT' });
  for (const status of [401, 403, 404]) {
    const provider = createVectorApiClient({ fetchImpl: async () => response(status, { body: 'private provider payload test-key' }) });
    await assert.rejects(provider.embed(xfyun, ['测试']), error => error.code === 'VECTOR_HTTP_ERROR'
      && error.message.includes(`HTTP ${status}`) && !error.message.includes('private provider') && !error.message.includes('test-key'));
  }
  const invalidJson = createVectorApiClient({ fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new SyntaxError('invalid JSON test-key'); } }) });
  await assert.rejects(invalidJson.embed(xfyun, ['测试']), { code: 'VECTOR_RESPONSE_JSON_INVALID', message: '向量接口返回的不是合法 JSON。' });
  const failedRead = createVectorApiClient({ fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new TypeError('private network failure'); } }) });
  await assert.rejects(failedRead.embed(xfyun, ['测试']), { code: 'VECTOR_RESPONSE_READ_FAILED', message: '读取向量接口响应失败。' });
  const directProvider = createVectorApiClient({ fetchImpl: async () => response(404, { body: 'CORS proxy is disabled. Enable it in config.yaml or use the --corsProxy flag.' }) });
  await assert.rejects(directProvider.embed(normalizeVectorConfig({ url: VECTOR_DEFAULT_URL, key: 'test-key' }), ['测试']), { code: 'VECTOR_HTTP_ERROR' });
});

test('错误/重复 index/非数值向量拒绝，供应商正文和 Key 不进入提示', async () => {
  for (const body of [ { data: [{ index: 0, embedding: [0, 0] }] }, { data: [{ index: 0, embedding: [NaN, 1] }] }, { data: [{ index: 7, embedding: [1, 0] }] } ]) {
    const api = createVectorApiClient({ fetchImpl: async () => ({ ok: true, json: async () => body }) });
    await assert.rejects(api.embed(config, ['苹果']), { code: 'VECTOR_RESPONSE_INVALID' });
  }
  const api = createVectorApiClient({ fetchImpl: async () => { throw new Error('secret test-key private body'); } });
  await assert.rejects(api.embed(config, ['苹果']), error => error.code === 'VECTOR_CONNECTION_FAILED' && !error.message.includes('test-key'));
});

test('真实源投影区分归档锚和实际成员；人工摘要、删除楼及不一致来源不进入索引', async () => {
  const floors = [{ id: 'old', assistantSeq: 1 }, { id: 'anchor', assistantSeq: 4 }];
  const memories = [{ id: 'memory', floorId: 'anchor', sourceFloorIds: ['old', 'anchor'], sourceFloorSnapshots: [{ floorId: 'old', canonicalContent: '老楼原文' }, { floorId: 'anchor', canonicalContent: '归档楼原文' }], summary: { effectiveSource: 'ai' } }];
  const raws = await projectVectorSources(memories, floors);
  assert.equal(raws[0].assistantSeq, 1); assert.equal(raws[0].memoryAssistantSeq, 4); assert.equal(raws[0].memoryFloorId, 'anchor');
  memories[0].summary.effectiveSource = 'user'; assert.deepEqual(await projectVectorSources(memories, floors), []);
  memories[0].summary.effectiveSource = 'ai'; assert.equal((await projectVectorSources(memories, floors.slice(1))).length, 1);
  floors[0].content = { canonicalContent: '被编辑的新正文' }; assert.equal((await projectVectorSources(memories, floors)).length, 1);
});

test('手动建索引：缓存不复制正文/Key；一次批量 API，查询验证见证并只返回旧楼', async () => {
  const source = await sourceFixture(), h = harness(source); let calls = 0;
  const api = { embed: async (_config, texts) => { calls++; return vectors(texts); } };
  const index = createVectorIndex({ client: h.client, api, configProvider: () => config, identityProvider: () => ({ chatId: 'chat' }), sourceProvider: async () => source });
  await index.build(); assert.equal(calls, 1);
  const persisted = JSON.stringify([...h.records.values()]);
  assert.equal(persisted.includes(source.rawSources[0].canonicalContent), false); assert.equal(persisted.includes('test-key'), false);
  const selected = await index.query({ source, queryContext: { text: '苹果配方' }, eligibleFloorMemoryIds: ['memory-1'] });
  assert.equal(selected.candidates.length, 1); assert.equal(calls, 2);
  assert.equal(await rawWitnessValid(selected.candidates[0].witness, source), true);
  const changed = structuredClone(source); changed.rawSources[0].canonicalContent += '被编辑'; changed.rawSources[0].fingerprint = await hash(changed.rawSources[0].canonicalContent);
  assert.equal((await index.query({ source: changed, queryContext: { text: '苹果配方' } })).candidates.length, 0);
  const covered = { ...source, bodyMatch: { recentBodyFloorIds: ['floor-1'] } };
  assert.equal((await index.query({ source: covered, queryContext: { text: '苹果配方' } })).candidates.length, 0);
  assert.equal(calls, 2, '没有合格片段不发送查询向量');
});

test('首轮召回等待读完现成索引后查询；不重建，不重复查询', async () => {
  const source = await sourceFixture(), h = harness(source); await h.index.build();
  let calls = 0, reads = 0;
  const index = createVectorIndex({ client: { ...h.client, get: async (...args) => { reads++; await flush(); return h.client.get(...args); } },
    api: { embed: async (_config, texts) => { calls++; return vectors(texts); } }, configProvider: () => config, identityProvider: () => ({ chatId: 'chat' }) });
  const first = await index.query({ source, queryContext: { text: '苹果' } });
  assert.equal(first.diagnostic.status, 'ready'); assert.equal(first.candidates.length, 1);
  assert.equal(index.getState().status, 'ready'); assert.equal(reads, 2); assert.equal(calls, 1);
  assert.equal((await index.query({ source, queryContext: { text: '苹果' } })).candidates.length, 1);
  assert.equal(reads, 2); assert.equal(calls, 1); assert.equal(h.calls.length, 2, '只读取已经落盘的 manifest 和 shard');
});

test('新增楼和 checkpoint 推进不要求重建；冷读旧索引仍可召回有效旧楼', async () => {
  const source = await sourceFixture(), h = harness(source); await h.index.build();
  const newer = structuredClone(source); newer.rootRevision++; newer.headCheckpointId = 'new-head';
  newer.rawSources.push({ ...source.rawSources[0], floorId: 'new-floor', floorMemoryId: 'new-memory', memoryFloorId: 'new-floor', assistantSeq: 9, memoryAssistantSeq: 9 });
  let calls = 0;
  const index = createVectorIndex({ client: h.client, api: { embed: async (_config, texts) => { calls++; return vectors(texts); } },
    configProvider: () => config, identityProvider: () => ({ chatId: source.chatId }) });
  const selected = await index.query({ source: newer, queryContext: { text: '苹果' } });
  assert.equal(selected.diagnostic.status, 'ready'); assert.equal(selected.candidates.length, 1);
  assert.equal(selected.candidates[0].witness.floorId, 'floor-1'); assert.equal(calls, 1);
});

test('冷读取消立即结束；并发查询不重复读取，迟到索引不补发该轮模型请求', async () => {
  const source = await sourceFixture(), h = harness(source); await h.index.build();
  let finish, entered, calls = 0, reads = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const index = createVectorIndex({ client: { ...h.client, get: async (...args) => {
    if (++reads === 1) await new Promise(resolve => { finish = resolve; entered(); });
    return h.client.get(...args);
  } }, api: { embed: async (_config, texts) => { calls++; return vectors(texts); } },
    configProvider: () => config, identityProvider: () => ({ chatId: source.chatId }) });
  const controller = new AbortController();
  const pending = index.query({ source, queryContext: { text: '苹果' }, signal: controller.signal }); await started;
  assert.equal((await index.query({ source, queryContext: { text: '苹果' } })).diagnostic.status, 'busy'); assert.equal(reads, 1);
  controller.abort(); assert.equal((await pending).diagnostic.status, 'VECTOR_ABORTED'); assert.equal(calls, 0);
  finish(); await flush();
  assert.equal(calls, 0); assert.equal(index.getState().status, 'ready');
  assert.equal((await index.query({ source, queryContext: { text: '苹果' } })).diagnostic.status, 'ready'); assert.equal(calls, 1);
});

test('读取超过五秒但在十五秒内完成，首轮仍使用索引', async t => {
  const source = await sourceFixture(), h = harness(source); await h.index.build();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish, entered, calls = 0, settled = false;
  const started = new Promise(resolve => { entered = resolve; });
  const index = createVectorIndex({ client: { ...h.client, get: async (...args) => {
    if (args[1] === VECTOR_INDEX_ID) await new Promise(resolve => { finish = resolve; entered(); });
    return h.client.get(...args);
  } }, api: { embed: async (_config, texts) => { calls++; return vectors(texts); } },
    configProvider: () => config, identityProvider: () => ({ chatId: source.chatId }) });
  const pending = index.query({ source, queryContext: { text: '苹果' } }).then(result => { settled = true; return result; }); await started;
  t.mock.timers.tick(11000); await flush(); assert.equal(settled, false); assert.equal(calls, 0);
  finish(); assert.equal((await pending).diagnostic.status, 'ready'); assert.equal(calls, 1);
});

test('索引读取有独立期限；超时诊断不冒充接口超时，迟到读取只供后续轮次', async t => {
  const source = await sourceFixture(), h = harness(source); await h.index.build();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish, entered, calls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const index = createVectorIndex({ client: { ...h.client, get: async (...args) => {
    if (args[1] === VECTOR_INDEX_ID) await new Promise(resolve => { finish = resolve; entered(); });
    return h.client.get(...args);
  } }, api: { embed: async (_config, texts) => { calls++; return vectors(texts); } },
    configProvider: () => config, identityProvider: () => ({ chatId: source.chatId }) });
  const pending = index.query({ source, queryContext: { text: '苹果' } }); await started;
  t.mock.timers.tick(15000);
  const failed = await pending;
  assert.equal(failed.diagnostic.status, 'VECTOR_INDEX_LOAD_TIMEOUT'); assert.equal(failed.diagnostic.request, undefined); assert.equal(calls, 0);
  finish(); await flush(); assert.equal(calls, 0);
  assert.equal((await index.query({ source, queryContext: { text: '苹果' } })).diagnostic.status, 'ready'); assert.equal(calls, 1);
});

test('冷读期间聊天、模型或生命周期变更，旧读取不参与查询', async () => {
  for (const action of ['chat', 'model', 'epoch']) {
    const source = await sourceFixture(), h = harness(source); await h.index.build();
    let finish, entered, calls = 0, route = config, identity = { chatId: source.chatId };
    const started = new Promise(resolve => { entered = resolve; });
    const index = createVectorIndex({ client: { ...h.client, get: async (...args) => {
      if (args[1] === VECTOR_INDEX_ID) await new Promise(resolve => { finish = resolve; entered(); });
      return h.client.get(...args);
    } }, api: { embed: async (_config, texts) => { calls++; return vectors(texts); } },
      configProvider: () => route, identityProvider: () => identity });
    const pending = index.query({ source, queryContext: { text: '苹果' } }); await started;
    if (action === 'chat') identity = { chatId: 'other' };
    else if (action === 'model') route = { ...config, model: 'other' };
    else {
      index.abortAll();
      const terminal = index.getState().query;
      assert.equal(terminal.status, 'cancelled'); assert.equal(terminal.pendingStep, 'indexLoad');
      assert.equal(terminal.abortOrigin, 'client_abort_all'); assert.equal(terminal.abortReason, 'indexReset');
    }
    finish(); const result = await pending; await flush();
    assert.ok(['changed', 'VECTOR_ABORTED'].includes(result.diagnostic.status));
    assert.equal(calls, 0); assert.equal(index.getState().status, 'idle');
  }
});

test('索引读取失败保留安全阶段与后端码，并继续既有 unavailable 回退', async () => {
  const source = await sourceFixture();
  const index = createVectorIndex({ client: { get: async () => { throw Object.assign(new Error('private body'), { code: 'BACKEND_UNAVAILABLE', status: 503 }); } },
    api: { embed: async () => { throw new Error('must not call'); } }, configProvider: () => config,
    identityProvider: () => ({ chatId: source.chatId }) });
  const result = await index.query({ source, queryContext: { text: '苹果' } });
  assert.equal(result.diagnostic.status, 'unavailable');
  assert.equal(index.getState().query.pendingStep, 'indexLoad');
  assert.equal(index.getState().query.load.exitReason, 'readFailed');
  assert.equal(index.getState().query.load.backendCode, 'BACKEND_UNAVAILABLE');
  assert.equal(index.getState().query.load.httpStatus, 503);
  assert.equal(JSON.stringify(index.getState()).includes('private body'), false);
});

test('模型/聊天/世代切换、人工摘要撤来源后不使用旧缓存', async () => {
  const source = await sourceFixture(), h = harness(source); await h.index.build();
  for (const changed of [ { ...source, chatId: 'other' }, { ...source, narrativeGeneration: 'other' }, { ...source, rawSources: [] } ]) {
    assert.equal((await h.index.query({ source: changed, queryContext: { text: '苹果' } })).candidates.length, 0);
  }
  h.setConfig({ ...config, model: 'other' });
  assert.equal((await h.index.query({ source, queryContext: { text: '苹果' } })).candidates.length, 0);
});

test('建索引进行中，召回立即走回退；取消后迟到结果不写 manifest', async () => {
  const source = await sourceFixture(); let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const h = harness(source, { api: { embed: async () => new Promise(resolve => { finish = resolve; entered(); }) } });
  const build = h.index.build(); await started;
  assert.equal((await h.index.query({ source, queryContext: { text: '苹果' } })).diagnostic.status, 'busy');
  h.index.abortAll(); finish([[1, 0]]);
  await assert.rejects(build, { code: 'VECTOR_ABORTED' }); assert.equal(h.records.has(VECTOR_INDEX_ID), false);
});

test('构建期间源被人工改掉或切聊天，不提交到当前聊天', async () => {
  for (const action of ['manual', 'chat']) {
    const source = await sourceFixture(), h = harness(source);
    let finish, entered; const started = new Promise(resolve => { entered = resolve; });
    const api = { embed: async () => new Promise(resolve => { finish = resolve; entered(); }) };
    const index = createVectorIndex({ client: h.client, api, configProvider: () => config, identityProvider: () => action === 'chat' ? identity : ({ chatId: 'chat' }), sourceProvider: async () => current });
    let current = source, identity = { chatId: 'chat' };
    const build = index.build(); await started;
    if (action === 'manual') current = { ...source, rawSources: [] }; else identity = { chatId: 'other' };
    finish([[1, 0]]); await assert.rejects(build);
    assert.equal(h.records.has(VECTOR_INDEX_ID), false);
  }
});

test('向量缓存由现有存储管理回收旧 shard，保留当前 manifest 引用', async () => {
  const source = await sourceFixture(), h = harness(source); await h.index.build();
  const firstShard = [...h.records.keys()].find(id => id.startsWith(VECTOR_SHARD_PREFIX));
  const orphan = structuredClone(h.records.get(firstShard)); orphan.recordId = `${VECTOR_SHARD_PREFIX}${'f'.repeat(40)}`;
  const stats = await classifyStorageRecords([...h.records.values(), orphan], { root: { narrativeGeneration: source.narrativeGeneration }, checkpoint: { producedRefs: {} } }, 'chat');
  assert.equal(stats.stats.active.count, 2); assert.deepEqual(stats.candidates.map(value => value.recordId), [orphan.recordId]);
  const changed = await classifyStorageRecords([...h.records.values()], { root: { narrativeGeneration: 'other' }, checkpoint: { producedRefs: {} } }, 'chat');
  assert.equal(changed.candidates.length, 2);
});

test('首轮冷读的语义片段通过同一 LLM 筛选进最终8k，归档锚时间不冒充实际楼时间', async () => {
  const source = await sourceFixture(), h = harness(source); await h.index.build();
  const restored = createVectorIndex({ client: h.client, api: { embed: async (_config, texts) => vectors(texts) },
    configProvider: () => config, identityProvider: () => ({ chatId: source.chatId }) });
  let payload;
  const selected = await selectRecallWithLlm({ source, queryContext: { text: '我要回忆烘焙配方', latestUserText: '我要回忆烘焙配方', recentAssistantText: '', previousUserText: '' }, contextSize: 20000,
    semanticProvider: input => restored.query(input), generateUtilityTask: async request => {
      payload = JSON.parse(request.taskMessages[0].content);
      return { jsonData: { history_exclude_keys: [], state_exclude_keys: [] } };
    } });
  assert.ok(payload.candidates.some(value => value.fact.includes('六百克苹果')));
  assert.ok(selected.injectionText.includes('六百克苹果')); assert.ok(selected.injectionText.includes('时间未标注'));
  assert.equal(selected.floors.find(value => value.floorId === 'floor-1').items.some(value => value.rawWitness), true);
  assert.ok(selected.limits.estimatedTokenBudget <= 8000); assert.ok(selected.stages.estimatedTokenCount <= 8000);
  assert.equal(selected.selectorDiagnostic.semantic.candidateCount, 1);
});

test('向量失败仍给 LLM 原来48条；有效语义时原候选36条与12片段，共享24000字符', async () => {
  const source = await sourceFixture();
  source.floorMemories[0].events = Array.from({ length: 70 }, (_, i) => ({ title: `苹果配方${i}`, description: `苹果配方${i}所用的原料与步骤`, candidateStatus: 'accepted' }));
  const queryContext = { text: '苹果配方', latestUserText: '苹果配方' };
  let count, texts;
  const generateUtilityTask = async request => { const payload = JSON.parse(request.taskMessages[0].content); count = payload.candidates.length; texts = payload.candidates; return { jsonData: { history_exclude_keys: [], state_exclude_keys: [] } }; };
  await selectRecallWithLlm({ source, queryContext, contextSize: 20000, semanticProvider: async () => { throw new Error('failed'); }, generateUtilityTask });
  assert.equal(count, 48);
  const raw = source.rawSources[0];
  const textsByChunk = Array.from({ length: 12 }, (_, i) => (`原文${i}苹果配方` + '资料'.repeat(220)).slice(0, 400));
  raw.canonicalContent = textsByChunk.join(''); raw.fingerprint = await hash(raw.canonicalContent);
  const candidates = await Promise.all(textsByChunk.map(async (text, i) => ({ text, witness: { floorId: raw.floorId, assistantSeq: raw.assistantSeq, floorMemoryId: raw.floorMemoryId, memoryFloorId: raw.memoryFloorId, memoryAssistantSeq: raw.memoryAssistantSeq, fingerprint: raw.fingerprint, offset: i * 400, length: text.length, textFingerprint: await hash(text) } })));
  for (const candidate of candidates) assert.equal(await rawWitnessValid(candidate.witness, source), true);
  await selectRecallWithLlm({ source, queryContext, contextSize: 20000, semanticProvider: async () => ({ candidates, diagnostic: { status: 'ready', candidateCount: 12 } }), generateUtilityTask });
  assert.equal(count, 48); assert.equal(texts.filter(row => row.fact.includes('sourceFragment')).length, 12);
  assert.ok(texts.reduce((sum, row) => sum + `${row.key}｜${row.fact}`.length + 1, 0) <= 24000);
});

test('已取消请求不发 API；不响应 abort 的传输也有硬超时且无重试', async () => {
  let calls = 0;
  const api = createVectorApiClient({ fetchImpl: async () => { calls++; return new Promise(() => {}); } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api.embed(config, ['苹果'], { signal: controller.signal }), { code: 'VECTOR_ABORTED' }); assert.equal(calls, 0);
  await assert.rejects(api.embed(config, ['苹果'], { timeoutMs: 10 }), { code: 'VECTOR_TIMEOUT' }); assert.equal(calls, 1);
});

test('向量诊断区分等待响应与读取结果；超时后的迟到响应不改已交付记录', async () => {
  let resolveFetch, calls = 0, snapshots = [];
  const api = createVectorApiClient({ fetchImpl: () => { calls++; return new Promise(resolve => { resolveFetch = resolve; }); } });
  await assert.rejects(api.embed(config, ['正文不可记录'], { timeoutMs: 10, onDiagnostic: value => snapshots.push(value) }), { code: 'VECTOR_TIMEOUT' });
  const waiting = snapshots[0];
  assert.equal(waiting.phase, 'request'); assert.equal(waiting.responseHeadersMs, null); assert.equal(waiting.responseBodyMs, null);
  assert.equal(waiting.inputCharacters, 6); assert.equal(waiting.timeoutMs, 10); assert.equal(calls, 1);
  resolveFetch({ ok: true, status: 200, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }) });
  await flush(); assert.equal(waiting.phase, 'request'); assert.equal(snapshots.length, 1);
  assert.doesNotMatch(JSON.stringify(waiting), /正文不可记录|test-key|vector\.invalid/u);
  const stalledBody = createVectorApiClient({ fetchImpl: async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) });
  await assert.rejects(stalledBody.embed(config, ['苹果'], { timeoutMs: 10, onDiagnostic: value => snapshots.push(value) }), { code: 'VECTOR_TIMEOUT' });
  assert.equal(snapshots[1].phase, 'response'); assert.equal(snapshots[1].httpStatus, 200);
  assert.ok(Number.isFinite(snapshots[1].responseHeadersMs)); assert.equal(snapshots[1].responseBodyMs, null);
  const completed = createVectorApiClient({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }) }) });
  await completed.embed(config, ['苹果'], { onDiagnostic: value => { snapshots.push(value); throw new Error('诊断不能中断召回'); } });
  assert.equal(snapshots[2].phase, 'complete'); assert.ok(Number.isFinite(snapshots[2].responseBodyMs));
});

test('向量查询在失败回退与成功时都传递请求阶段，复用查询不伪造新请求', async () => {
  const source = await sourceFixture(); let failQuery = true, queryCalls = 0;
  const request = { phase: 'request', pendingStage: 'fetch_called', lastSuccessfulStage: 'fetch_called', inputCharacters: 2, inputSha256: `sha256:${'d'.repeat(64)}`, timeoutMs: 15000, durationMs: 15000 };
  const h = harness(source, { api: { embed: async (_config, texts, options) => {
    if (options.onDiagnostic) {
      queryCalls++;
      options.onDiagnostic({ ...request, requestId: `test-request-${queryCalls}` });
      if (failQuery) throw Object.assign(new Error('timeout'), { code: 'VECTOR_TIMEOUT' });
    }
    return vectors(texts);
  } } });
  await h.index.build();
  const failed = await h.index.query({ source, queryContext: { text: '苹果' } });
  assert.equal(failed.diagnostic.status, 'VECTOR_TIMEOUT'); assert.equal(failed.diagnostic.request.phase, request.phase);
  assert.equal(failed.diagnostic.request.timeoutMs, request.timeoutMs); assert.equal(failed.diagnostic.request.durationMs, request.durationMs);
  assert.equal(queryCalls, 2); assert.equal(failed.diagnostic.requestCount, 2); assert.equal(failed.diagnostic.retryOutcome, 'retry_failed');
  assert.notEqual(failed.diagnostic.requestAttempts[0].requestId, failed.diagnostic.requestAttempts[1].requestId);
  failQuery = false;
  const success = await h.index.query({ source, queryContext: { text: '苹果' } });
  assert.equal(success.diagnostic.status, 'ready'); assert.equal(success.diagnostic.request.phase, request.phase);
  assert.equal(success.diagnostic.request.timeoutMs, request.timeoutMs); assert.equal(success.diagnostic.request.durationMs, request.durationMs);
  assert.equal(queryCalls, 3);
  const reused = await h.index.query({ source, queryContext: { text: '苹果' } });
  assert.equal(reused.diagnostic.status, 'ready'); assert.equal(reused.diagnostic.request, undefined);
});

test('真实查询首个15秒超时后补试成功，双请求指纹/ID保留且首个迟到响应被隔离', async t => {
  const source = await sourceFixture(); let calls = 0, hold = false;
  const pendingFetches = []; let firstStarted, secondStarted;
  const startedFirst = new Promise(resolve => { firstStarted = resolve; });
  const startedSecond = new Promise(resolve => { secondStarted = resolve; });
  const response = (body, id, resultVectors = vectors(body.input)) => ({ ok: true, status: 200,
    headers: { get: name => name === 'x-request-id' ? id : null },
    json: async () => ({ data: resultVectors.map((embedding, index) => ({ index, embedding })) }) });
  const api = createVectorApiClient({ fetchImpl: (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    if (!hold) return Promise.resolve(response(body, 'build-request-id-0001'));
    return new Promise(resolve => {
      pendingFetches.push({ resolve, body });
      (pendingFetches.length === 1 ? firstStarted : secondStarted)();
    });
  } });
  const h = harness(source, { api }); await h.index.build(); assert.equal(calls, 1);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); hold = true;
  const controller = new AbortController();
  const pending = h.index.query({ source, queryContext: { text: '苹果' }, signal: controller.signal }); await startedFirst;
  t.mock.timers.tick(15000); await flush(); await startedSecond;
  assert.equal(calls, 3, '第一次超时后只补发一次');
  pendingFetches[0].resolve(response(pendingFetches[0].body, 'late-first-request-0001', [[0, 1]])); await flush();
  pendingFetches[1].resolve(response(pendingFetches[1].body, 'bbbbbbbbbbbbbbbb'));
  const ready = await pending;
  assert.equal(ready.diagnostic.status, 'ready'); assert.equal(ready.candidates.length, 1);
  assert.equal(ready.diagnostic.requestCount, 2); assert.equal(ready.diagnostic.retryOutcome, 'retry_succeeded');
  assert.equal(ready.diagnostic.requestAttempts.length, 2);
  const [first, second] = ready.diagnostic.requestAttempts;
  assert.notEqual(first.requestId, second.requestId); assert.equal(first.inputSha256, second.inputSha256);
  assert.equal(first.timeoutMs, 15000); assert.equal(first.result, 'timeout'); assert.equal(first.errorCode, 'VECTOR_TIMEOUT');
  assert.equal(second.timeoutMs, 15000); assert.equal(second.result, 'succeeded'); assert.equal(second.providerRequestId, 'bbbbbbbbbbbbbbbb');
  assert.equal(ready.diagnostic.request.requestId, second.requestId, '旧字段始终指向最后一次真实请求');
  const cached = await h.index.query({ source, queryContext: { text: '苹果' }, signal: controller.signal });
  assert.equal(cached.diagnostic.status, 'ready'); assert.equal(cached.diagnostic.requestCount, 2); assert.equal(calls, 3, '同轮成功缓存不伪造第三次请求');
  const cachedNextRound = await h.index.query({ source, queryContext: { text: '苹果' }, signal: new AbortController().signal });
  assert.equal(cachedNextRound.diagnostic.status, 'ready'); assert.equal(cachedNextRound.diagnostic.request, undefined);
  assert.equal(cachedNextRound.diagnostic.requestCount, undefined); assert.equal(calls, 3, '新轮复用成功向量缓存不计作API调用');
  const exhausted = await h.index.query({ source, queryContext: { text: '新的查询' }, signal: controller.signal });
  assert.equal(exhausted.diagnostic.status, 'VECTOR_QUERY_BUDGET_EXHAUSTED'); assert.equal(exhausted.diagnostic.retryOutcome, 'budget_exhausted');
  assert.equal(exhausted.diagnostic.requestCount, 2); assert.equal(calls, 3, '预算耗尽时不伪造供应商超时或发送第三次请求');
});

test('双超时耗尽同一signal预算；outer query不发第三次，新signal可恢复', async t => {
  const source = await sourceFixture(); let calls = 0, hold = false, mode = 'stall';
  const pendingFetches = []; let enteredFirst, enteredSecond;
  const startedFirst = new Promise(resolve => { enteredFirst = resolve; }), startedSecond = new Promise(resolve => { enteredSecond = resolve; });
  const response = (body, id) => ({ ok: true, status: 200, headers: { get: name => name === 'x-request-id' ? id : null },
    json: async () => ({ data: vectors(body.input).map((embedding, index) => ({ index, embedding })) }) });
  const api = createVectorApiClient({ fetchImpl: (_url, options) => {
    calls++; const body = JSON.parse(options.body);
    if (hold && mode === 'stall') return new Promise(resolve => { pendingFetches.push({ resolve, body }); (pendingFetches.length === 1 ? enteredFirst : enteredSecond)(); });
    return Promise.resolve(response(body, `provider-request-${String(calls).padStart(4, '0')}`));
  } });
  const h = harness(source, { api }); await h.index.build();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); hold = true;
  const controller = new AbortController();
  const first = h.index.query({ source, queryContext: { text: '苹果' }, signal: controller.signal }); await startedFirst;
  t.mock.timers.tick(15000); await flush(); await startedSecond;
  t.mock.timers.tick(15000); const failed = await first;
  assert.equal(failed.diagnostic.status, 'VECTOR_TIMEOUT'); assert.equal(failed.diagnostic.requestCount, 2);
  assert.equal(failed.diagnostic.retryOutcome, 'retry_failed'); assert.equal(failed.diagnostic.requestAttempts.length, 2);
  assert.ok(failed.diagnostic.requestAttempts.every(item => item.result === 'timeout' && item.errorCode === 'VECTOR_TIMEOUT'));
  const secondInSameRound = await h.index.query({ source, queryContext: { text: '苹果' }, signal: controller.signal });
  assert.equal(secondInSameRound.diagnostic.status, 'VECTOR_TIMEOUT'); assert.equal(secondInSameRound.diagnostic.retryOutcome, 'retry_failed');
  assert.equal(calls, 3, '外层重算沿用同一预算');
  pendingFetches.forEach(item => item.resolve(response(item.body, 'late-timeout-response'))); await flush();
  mode = 'success'; const nextRound = await h.index.query({ source, queryContext: { text: '苹果' }, signal: new AbortController().signal });
  assert.equal(nextRound.diagnostic.status, 'ready'); assert.equal(nextRound.diagnostic.requestCount, 1); assert.equal(calls, 4);
});

test('查询补试期间取消立即停止；硬HTTP错误不自动补试', async t => {
  const source = await sourceFixture(); let calls = 0, hold = false, pendingResolve; const pendingRequests = [];
  let firstStarted, secondStarted;
  const firstWait = new Promise(resolve => { firstStarted = resolve; }), secondWait = new Promise(resolve => { secondStarted = resolve; });
  const api = createVectorApiClient({ fetchImpl: (_url, options) => {
    calls++; const body = JSON.parse(options.body);
    if (hold) return new Promise(resolve => { pendingRequests.push(resolve); pendingResolve = resolve; (pendingRequests.length === 1 ? firstStarted : secondStarted)(); });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: vectors(body.input).map((embedding, index) => ({ index, embedding })) }) });
  } });
  const h = harness(source, { api }); await h.index.build(); t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); hold = true;
  const controller = new AbortController(); const pending = h.index.query({ source, queryContext: { text: '苹果' }, signal: controller.signal });
  await firstWait; t.mock.timers.tick(15000); await flush(); await secondWait;
  controller.abort('stopped'); const cancelled = await pending;
  assert.equal(cancelled.diagnostic.status, 'VECTOR_ABORTED'); assert.equal(cancelled.diagnostic.requestCount, 2);
  assert.equal(cancelled.diagnostic.retryOutcome, 'cancelled'); assert.equal(calls, 3);
  pendingResolve({ ok: true, status: 200, json: async () => ({ data: vectors(['苹果']).map((embedding, index) => ({ index, embedding })) }) }); await flush();

  const resetSource = await sourceFixture(); let resetCalls = 0, holdReset = false, resetEntered;
  const resetStarted = new Promise(resolve => { resetEntered = resolve; });
  const resetApi = createVectorApiClient({ fetchImpl: (_url, options) => {
    resetCalls++; if (holdReset) return new Promise(() => resetEntered());
    const body = JSON.parse(options.body); return Promise.resolve({ ok: true, status: 200,
      json: async () => ({ data: vectors(body.input).map((embedding, index) => ({ index, embedding })) }) });
  } });
  const reset = harness(resetSource, { api: resetApi }); await reset.index.build(); holdReset = true;
  const resetting = reset.index.query({ source: resetSource, queryContext: { text: '苹果' } }); await resetStarted;
  reset.index.abortAll(); const resetResult = await resetting;
  assert.equal(resetResult.diagnostic.status, 'VECTOR_ABORTED'); assert.equal(resetResult.diagnostic.requestCount, 1);
  assert.equal(resetResult.diagnostic.retryOutcome, 'cancelled'); assert.equal(resetCalls, 2, 'abortAll不补发');

  let hardCalls = 0;
  const hardApi = createVectorApiClient({ fetchImpl: async (_url, options) => {
    hardCalls++; const body = JSON.parse(options.body);
    return hardCalls === 1
      ? { ok: true, status: 200, json: async () => ({ data: vectors(body.input).map((embedding, index) => ({ index, embedding })) }) }
      : { ok: false, status: 429, json: async () => ({ secret: 'do not retain' }) };
  } });
  const hard = harness(source, { api: hardApi }); await hard.index.build(); const signal = new AbortController().signal;
  const result = await hard.index.query({ source, queryContext: { text: '苹果' }, signal });
  assert.equal(result.diagnostic.status, 'VECTOR_HTTP_ERROR'); assert.equal(result.diagnostic.requestCount, 1); assert.equal(result.diagnostic.retryOutcome, 'not_retried');
  assert.equal(hardCalls, 2, '一次建索引请求加一次失败查询，无API层或召回层重试');
  await hard.index.query({ source, queryContext: { text: '苹果' }, signal }); assert.equal(hardCalls, 2, '硬错误记入同轮终态');
});

test('fetch调用前取消保留0次真实请求计数并安全投影attempt', async () => {
  const source = await sourceFixture(); let controller, fetchCalls = 0, building = true;
  const api = { async embed(_config, texts, { signal, onProgress } = {}) {
    if (building) return vectors(texts);
    onProgress?.({ requestId: 'cancelled-before-fetch', phase: 'request', pendingStage: 'request_prepared', lastSuccessfulStage: 'request_prepared' });
    controller.abort('stopped');
    if (signal.aborted) throw Object.assign(new Error('safe cancellation'), { code: 'VECTOR_ABORTED' });
    fetchCalls++;
    return vectors(texts);
  } };
  const h = harness(source, { api }); await h.index.build(); building = false;
  controller = new AbortController();
  const result = await h.index.query({ source, queryContext: { text: '苹果' }, signal: controller.signal });
  assert.equal(fetchCalls, 0, '准备阶段取消后不会进入实际fetch');
  assert.equal(result.diagnostic.requestCount, 0);
  assert.equal(result.diagnostic.requestAttempts.length, 1);
  assert.equal(result.diagnostic.requestAttempts[0].result, 'cancelled');
  assert.equal(result.diagnostic.requestAttempts[0].lastSuccessfulStage, 'request_prepared');
  const privateView = projectPrivateRecallDiagnostic({ recallStatus: 'stale', lastRecall: { status: 'stale', selectorDiagnostic: {
    mode: 'local', semantic: { status: result.diagnostic.status, ...result.diagnostic },
  } } }, h.index.getState());
  assert.equal(privateView.vector.query.requestCount, 0);
  assert.equal(privateView.vector.query.requestAttempts[0].result, 'cancelled');
  assert.equal(privateView.last.selector.semantic.requestCount, 0);
  assert.doesNotMatch(JSON.stringify(privateView), /test-key|苹果|https:\/\//u);
});

test('首个deadline边界遇到配置或聊天变更时不补发', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const change of ['config', 'identity']) {
    const source = await sourceFixture(); let calls = 0, hold = false, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const api = createVectorApiClient({ fetchImpl: (_url, options) => {
      calls++; if (hold) return new Promise(() => entered());
      const input = JSON.parse(options.body).input;
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: vectors(input).map((embedding, index) => ({ index, embedding })) }) });
    } });
    const h = harness(source, { api }); await h.index.build(); hold = true;
    const pending = h.index.query({ source, queryContext: { text: '苹果' }, signal: new AbortController().signal }); await started;
    if (change === 'config') h.setConfig({ ...config, model: 'changed-model' }); else h.setIdentity({ chatId: 'different-chat' });
    t.mock.timers.tick(15000); const result = await pending;
    assert.equal(result.diagnostic.status, 'changed', change); assert.equal(result.diagnostic.requestCount, 1, change); assert.equal(calls, 2, change);
  }
});

test('手动建立分批串行；重复建立复用当前有效向量，不增加模型请求', async () => {
  const source = await sourceFixture(); let active = 0, maximum = 0, calls = 0;
  source.rawSources[0].canonicalContent = '苹果派配方'.repeat(1400); source.rawSources[0].fingerprint = await hash(source.rawSources[0].canonicalContent);
  const h = harness(source, { api: { embed: async (_config, texts) => {
    assert.ok(texts.length <= 16); calls++; active++; maximum = Math.max(maximum, active); await flush(); active--; return vectors(texts);
  } } });
  await h.index.build(); assert.equal(maximum, 1); assert.ok(calls >= 2);
  const previousCalls = calls; await h.index.build(); assert.equal(calls, previousCalls);
});
