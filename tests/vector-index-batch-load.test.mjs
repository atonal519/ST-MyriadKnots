import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/identity.js';
import { createBackendClient } from '../src/backend-client.js';
import { createTauriBackendFetch } from '../src/tauri-backend.js';
import { createVectorIndex, VECTOR_INDEX_ID, VECTOR_SHARD_PREFIX } from '../src/v3/vector-index.js';

const config = { url: 'https://vector.invalid/v1', model: 'fixture-model', key: 'fixture-key', dimensions: null };
const hash = async value => `sha256:${await sha256(value)}`;
async function fixture({ capability = true, getMany = true } = {}) {
  const source = { status: 'ready', chatId: 'vector-chat', narrativeGeneration: 'vector-generation', rawSources: [] };
  const records = new Map(), slots = new Map(), batches = [], requests = [], nativeReads = [];
  const modelKey = await hash(JSON.stringify([config.url, config.model, config.dimensions])), ids = [];
  for (let index = 0; index < 9; index++) {
    const text = `第${index + 1}楼保留的苹果配方。`, fingerprint = await hash(text);
    const raw = { floorId: `floor-${index}`, assistantSeq: index + 1, floorMemoryId: `memory-${index}`,
      memoryFloorId: `floor-${index}`, memoryAssistantSeq: index + 1, canonicalContent: text, fingerprint };
    source.rawSources.push(raw);
    const id = VECTOR_SHARD_PREFIX + String(index + 1).padStart(40, '0'); ids.push(id);
    records.set(id, { schemaVersion: 1, recordType: 'vectorCache', chatId: source.chatId, narrativeGeneration: source.narrativeGeneration, modelKey,
      rows: [{ witness: { floorId: raw.floorId, assistantSeq: raw.assistantSeq, floorMemoryId: raw.floorMemoryId,
        memoryFloorId: raw.memoryFloorId, memoryAssistantSeq: raw.memoryAssistantSeq, fingerprint, offset: 0, length: text.length, textFingerprint: fingerprint },
      vector: Buffer.from(new Float32Array([1, 0]).buffer).toString('base64') }] });
  }
  records.set(VECTOR_INDEX_ID, { schemaVersion: 1, recordType: 'vectorCache', chatId: source.chatId, narrativeGeneration: source.narrativeGeneration,
    modelKey, dimensions: 2, shardIds: ids, chunkCount: ids.length });
  let active = 0, maximum = 0, health = 0, embeddings = 0, beforeRead = null, failure = null, identity = { chatId: source.chatId };
  const key = options => `${options.namespace}/${options.table}/${options.key}`;
  const native = {
    async tryGetJson(options) {
      const value = slots.get(key(options)), slot = value?.serialized ? JSON.parse(value.serialized) : null;
      nativeReads.push(slot?.recordId ?? 'missing'); active++; maximum = Math.max(maximum, active);
      try { await beforeRead?.(slot); await new Promise(resolve => setImmediate(resolve)); return value ? { found: true, value: structuredClone(value) } : { found: false }; }
      finally { active--; }
    },
    async setJson(options) { slots.set(key(options), structuredClone(options.value)); },
    async deleteJson() { assert.fail('冷读取不能删除'); }, async listKeys() { assert.fail('不能扫描全集合'); }, async listTables() { return []; },
  };
  const nativeFetch = createTauriBackendFetch({ globalRef: { crypto: globalThis.crypto,
    __TAURITAVERN__: { ready: Promise.resolve(), api: { extension: { store: native } } } } });
  const client = createBackendClient({ fetchImpl: async (url, init = {}) => {
    requests.push({ url, method: init.method ?? 'GET' });
    if (url.endsWith('/health')) {
      health++; const response = await nativeFetch(url, init), body = await response.json();
      return { ...response, json: async () => ({ ...body, capabilities: { ...body.capabilities, recordBatchRead: capability } }) };
    }
    if (url.includes('/record-batch/') && init.method === 'POST') {
      const ids = JSON.parse(init.body).recordIds; batches.push(ids);
      if (failure === 'transport') throw Object.assign(new Error('read failed'), { code: 'BACKEND_FIXTURE_FAILURE' });
      const response = await nativeFetch(url, init), rows = await response.json();
      if (failure === 404 || failure === 500) rows[0] = { recordId: ids[0], status: failure, error: 'storage_error', message: 'Unavailable' };
      if (failure === 'order') rows.reverse();
      if (failure === 'schema') rows[0].envelope.data.schemaVersion = 999;
      if (failure === 'owner') rows[0].envelope.data.chatId = 'foreign-chat';
      if (failure === 'vector') rows[0].envelope.data.rows[0].vector = 'AAAA';
      return { ...response, json: async () => rows };
    }
    return nativeFetch(url, init);
  } });
  for (const [id, data] of records) await client.put(`chat-${source.chatId}`, id, data, 0);
  requests.length = nativeReads.length = 0; maximum = 0;
  const index = createVectorIndex({ client: getMany ? client : { get: (...args) => client.get(...args) },
    api: { async embed(_config, texts) { embeddings++; return texts.map(() => [1, 0]); } },
    configProvider: () => config, sourceProvider: async () => source, identityProvider: () => identity });
  return { source, ids, index, batches, requests, nativeReads, health: () => health, embeddings: () => embeddings, maximum: () => maximum,
    gateReads: callback => { beforeRead = callback; }, fail: value => { failure = value; }, setIdentity: value => { identity = value; } };
}
const query = f => f.index.query({ source: f.source, queryContext: { text: '当前苹果配方' } });
function idle(index) {
  return new Promise(resolve => {
    let unsubscribe = () => {};
    const done = () => { if (!index.getActivityState().busy) { unsubscribe(); resolve(); } };
    unsubscribe = index.subscribe(done); done();
  });
}

test('TT向量冷读按4片真实批请求，保持候选顺序与暖缓存', async () => {
  const f = await fixture(), result = await query(f);
  assert.equal(result.diagnostic.status, 'ready');
  assert.deepEqual(f.batches.map(ids => ids.length), [4, 4, 1]);
  assert.deepEqual(f.batches.flat(), f.ids);
  assert.equal(f.health(), 1, '首次批读主动发现native能力');
  assert.ok(f.maximum() > 1); assert.ok(f.maximum() <= 4);
  assert.deepEqual(result.candidates.map(candidate => candidate.witness.assistantSeq), Array.from({ length: 9 }, (_, i) => i + 1));
  assert.equal(f.requests.filter(request => request.url.includes('/records/') && request.method === 'GET').length, 1, '仅manifest保持单读');
  const reads = f.nativeReads.length;
  assert.deepEqual((await query(f)).candidates, result.candidates);
  assert.equal(f.nativeReads.length, reads); assert.equal(f.embeddings(), 1);
});

test('旧后端无batch能力与旧client无getMany均保留召回结果和四片上限', async () => {
  const expected = await query(await fixture());
  for (const options of [{ capability: false }, { getMany: false }]) {
    const f = await fixture(options), result = await query(f);
    assert.deepEqual(result.candidates, expected.candidates); assert.equal(result.diagnostic.status, 'ready');
    assert.equal(f.batches.length, 0); assert.ok(f.maximum() <= 4);
    assert.equal(f.nativeReads.length, 10);
    if (options.capability === false) assert.equal(f.health(), 1);
  }
});

test('批响应缺失、失败及损坏分片不发布部分索引或重试', async t => {
  for (const mode of [404, 500, 'transport', 'order', 'schema', 'owner', 'vector']) await t.test(String(mode), async () => {
    const f = await fixture(); f.fail(mode);
    const result = await query(f);
    assert.equal(result.diagnostic.status, 'unavailable'); assert.equal(f.embeddings(), 0);
    assert.equal(f.batches.length, 1, '失败不领下一包、不转逐条回读');
    const load = f.index.getState().query.load;
    assert.equal(load.exitReason, mode === 404 ? 'missing' : mode === 'schema' ? 'invalid' : mode === 'owner' ? 'ownerMismatch' : 'readFailed');
    if (mode === 500) assert.equal(load.httpStatus, 500);
    f.fail(null); assert.equal((await query(f)).diagnostic.status, 'ready', '下次明确查询重新完整读取，不保留部分索引');
  });
});

test('caller取消保留迟到暖索引但不补embedding；生命周期切档停止后续批次', { timeout: 5000 }, async t => {
  for (const reset of [false, true]) await t.test(reset ? '切档重置' : 'caller signal', async () => {
    const f = await fixture(); let announce, release;
    const entered = new Promise(resolve => { announce = resolve; }), gate = new Promise(resolve => { release = resolve; });
    f.gateReads(async slot => { if (slot?.recordId.startsWith(VECTOR_SHARD_PREFIX)) { announce(); await gate; } });
    const controller = new AbortController(), pending = f.index.query({ source: f.source, queryContext: { text: '当前苹果配方' }, signal: controller.signal });
    try {
      await entered;
      if (reset) { f.setIdentity({ chatId: 'other-chat' }); f.index.abortAll(); }
      else controller.abort();
      assert.equal((await pending).diagnostic.status, 'VECTOR_ABORTED'); assert.equal(f.embeddings(), 0);
      const settled = idle(f.index); release(); await settled;
      if (reset) { assert.equal(f.batches.length, 1); assert.equal(f.nativeReads.filter(id => id.startsWith(VECTOR_SHARD_PREFIX)).length, 4); assert.equal(f.index.getState().status, 'idle'); }
      else { assert.equal(f.batches.length, 3); assert.equal(f.index.getState().status, 'ready'); const reads = f.nativeReads.length;
        assert.equal((await query(f)).diagnostic.status, 'ready'); assert.equal(f.nativeReads.length, reads); assert.equal(f.embeddings(), 1); }
    } finally { release(); await Promise.allSettled([pending]); await idle(f.index); }
  });
});
