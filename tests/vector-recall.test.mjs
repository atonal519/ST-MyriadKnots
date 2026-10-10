import test from 'node:test';
import assert from 'node:assert/strict';
import { createVectorApiClient, normalizeVectorConfig, resolveVectorConfig, VECTOR_DEFAULT_URL, VECTOR_DEFAULT_MODEL } from '../src/vector-api.js';
import { createVectorIndex, rawSourceChunks, VECTOR_INDEX_ID, VECTOR_SHARD_PREFIX } from '../src/v3/vector-index.js';
import { createVectorAutoUpdater } from '../src/v3/vector-auto-update.js';
import { projectVectorSources, rawWitnessValid, summaryCandidateText, summaryWitnessValid } from '../src/v3/vector-source.js';
import { readVectorSource } from '../src/v3/vector-source-reader.js';
import { projectRecallSource, selectRecallMemories } from '../src/v3/recall-source.js';
import { selectRecallWithLlm } from '../src/v3/recall-llm-selector.js';
import { addSemanticHistory, buildRecallHistoryCandidatePool, historySelectionContext, mergeSemanticHistoryPool } from '../src/v3/recall-selector.js';
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
  const records = new Map(), calls = []; let current = source, route = config;
  const client = { get: async (_collection, id) => {
    if (!records.has(id)) throw Object.assign(new Error('not_found'), { status: 404 });
    const { recordId: _recordId, ...envelope } = records.get(id);
    return structuredClone(envelope);
  },
    put: async (collection, id, data, revision) => {
      assert.equal(revision, records.get(id)?.revision ?? 0);
      const record = { recordId: id, revision: revision + 1, data: structuredClone(data) }; records.set(id, record); calls.push({ collection, id }); return record;
    } };
  const index = createVectorIndex({ client, api, configProvider: () => route, identityProvider: () => ({ chatId: source.chatId }), sourceProvider: async () => current });
  return { index, records, calls, client, setSource: value => { current = value; }, setConfig: value => { route = value; } };
}

async function rawFloor(source, seq, content = `第${seq}楼的原文苹果内容。`) {
  return { floorId: `floor-${seq}`, assistantSeq: seq, floorMemoryId: `memory-${seq}`, memoryFloorId: `floor-${seq}`,
    memoryAssistantSeq: seq, canonicalContent: content, fingerprint: await hash(content) };
}

async function vectorReachableFixture() {
  const content1 = '林在第一楼说苹果烘焙计划。';
  const content2 = '第二楼继续记录配方和实际准备。';
  const root = { chatId: 'chat', narrativeGeneration: 'generation', headCheckpointId: 'head-1', sourceSnapshotFingerprint: 'sha256:source-v1' };
  const floors = [
    { id: 'floor-1', assistantSeq: 1, content: { canonicalContent: content1 } },
    { id: 'floor-2', assistantSeq: 2, content: { canonicalContent: content2 } },
  ];
  const floorMemories = [{ id: 'memory-2', floorId: 'floor-2', recordStatus: 'active', sourceFloorIds: ['floor-1', 'floor-2'],
    sourceFloorSnapshots: [{ floorId: 'floor-1', canonicalContent: content1 }, { floorId: 'floor-2', canonicalContent: content2 }],
    summary: { effectiveSource: 'user', userText: '人工整理摘要供旧回执核验。' } }];
  return { status: 'ready', root, rootRevision: 1, checkpoint: { id: 'head-1' }, floors, floorMemories,
    entities: [], stateDeltas: [], currentStates: [], baseline: null };
}

function committedMemoryState(source, floors = source.rawSources) {
  return { status: 'ready', chatId: source.chatId, narrativeGeneration: source.narrativeGeneration,
    headCheckpointId: source.headCheckpointId ?? 'head', memorySnapshotStatus: 'ready', memorySyncStatus: 'idle', memoryWorkBusy: false,
    activeExtraction: false, qianshiHistoryActive: false,
    floors: floors.map(raw => ({ floorId: raw.floorId, assistantSeq: raw.assistantSeq, canonicalFingerprint: raw.fingerprint,
      rawFingerprint: raw.fingerprint, memoryId: raw.floorMemoryId, status: 'ready' })) };
}
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), '异步索引状态按时收敛');
}

test('旧摘要索引增量跳过时结束复制诊断状态', async () => {
  const source = await sourceFixture(); source.rawSources = [];
  const h = harness(source);
  const modelKey = await hash(JSON.stringify([config.url, config.model, config.dimensions]));
  const shardId = `${VECTOR_SHARD_PREFIX}${'a'.repeat(40)}`;
  const summary = '中性旧摘要';
  const witness = { sourceKind: 'userSummary', floorId: 'floor-1', assistantSeq: 1, floorMemoryId: 'memory-1',
    memoryFloorId: 'floor-1', memoryAssistantSeq: 1, offset: 0, length: 2,
    fingerprint: await hash(summary), textFingerprint: await hash(summary.slice(0, 2)) };
  h.records.set(shardId, { recordId: shardId, revision: 1, data: { schemaVersion: 1, recordType: 'vectorCache',
    chatId: source.chatId, narrativeGeneration: source.narrativeGeneration, modelKey, rows: [{ witness, vector: 'AACAPwAAAAA=' }] } });
  h.records.set(VECTOR_INDEX_ID, { recordId: VECTOR_INDEX_ID, revision: 1, data: { schemaVersion: 1, recordType: 'vectorCache',
    chatId: source.chatId, narrativeGeneration: source.narrativeGeneration, modelKey, dimensions: 2, shardIds: [shardId], chunkCount: 1 } });

  assert.deepEqual(await h.index.updateIncrementally(), { status: 'legacySummaryOnly' });
  const state = h.index.getState();
  assert.equal(state.active, false);
  assert.equal(state.updating, false);
  assert.equal(state.buildDiagnostic.status, 'skipped');
  assert.equal(state.buildDiagnostic.phase, 'cache');
});

test('不可用的自动更新器仍提供安全的空生命周期接口', () => {
  const updater = createVectorAutoUpdater();
  assert.equal(typeof updater.refresh, 'function');
  assert.doesNotThrow(() => updater.refresh());
  assert.doesNotThrow(() => updater.dispose());
});

test('向量原文reader逐次轻读root并仅借用完全匹配的已验证来源图', async () => {
  const reachable = await vectorReachableFixture(); reachable.cseUnavailable = true;
  let rootReads = 0, reachableReads = 0;
  const store = {
    readRoot: async () => { rootReads++; return { status: 'ready', data: reachable.root, revision: reachable.rootRevision }; },
    readReachable: async () => { rootReads++; reachableReads++; return reachable; },
  };
  const selected = selectRecallMemories(reachable);
  const expected = await projectVectorSources(selected.activeMemories, selected.floors, { includeSummaries: false });
  const fullRecall = await projectRecallSource(reachable, () => new Date('2026-10-08T00:00:00.000Z'));
  const warm = await readVectorSource({ store, targetIdentity: { chatId: 'chat' }, cachedReachable: reachable });
  assert.equal(warm.status, 'ready');
  assert.deepEqual(warm.rawSources, expected.rawSources);
  assert.deepEqual(warm.rawSources, fullRecall.rawSources, '薄读复用正式召回投影选出的同一原文、包括CSE不可用时的既有降级');
  assert.equal('summarySources' in warm, false, '索引reader不构造旧摘要见证材料');
  assert.deepEqual(warm.sourceReadAttempts, { lightweightRootReads: 1, reachableReads: 0, exitPoint: 'validatedSnapshot' });
  assert.equal(rootReads, 1); assert.equal(reachableReads, 0);

  const next = structuredClone(reachable);
  next.rootRevision = 2; next.root = { ...next.root, headCheckpointId: 'head-2', sourceSnapshotFingerprint: 'sha256:source-v2' };
  next.checkpoint = { id: 'head-2' };
  const missStore = { ...store,
    readRoot: async () => { rootReads++; return { status: 'ready', data: next.root, revision: next.rootRevision }; },
    readReachable: async () => { rootReads++; reachableReads++; return next; }, };
  const cold = await readVectorSource({ store: missStore, targetIdentity: { chatId: 'chat' }, cachedReachable: reachable });
  assert.equal(cold.status, 'ready');
  assert.deepEqual(cold.sourceReadAttempts, { lightweightRootReads: 1, reachableReads: 1, exitPoint: 'ready' });
  assert.equal(rootReads, 3, '冷fallback计入显式root读和原readReachable内部root读');
  assert.equal(reachableReads, 1, 'root版本不匹配只触发既有完整校验回退');
});

test('正式vector build两阶段都复用命中快照，不读完整图或完整召回DTO', async () => {
  const reachable = await vectorReachableFixture(), records = new Map();
  let rootReads = 0, reachableReads = 0, embeds = 0;
  const store = {
    readRoot: async () => { rootReads++; return { status: 'ready', data: reachable.root, revision: reachable.rootRevision }; },
    readReachable: async () => { reachableReads++; return reachable; },
  };
  const stages = [];
  const sourceProvider = async task => {
    stages.push(task.stage);
    return readVectorSource({ store, targetIdentity: task.targetIdentity, cachedReachable: reachable });
  };
  const client = { get: async (_collection, id) => {
    if (!records.has(id)) throw Object.assign(new Error('missing'), { status: 404 });
    const { recordId: _id, ...value } = records.get(id); return structuredClone(value);
  }, put: async (_collection, id, data, revision) => {
    const record = { recordId: id, revision: revision + 1, data: structuredClone(data) }; records.set(id, record); return record;
  } };
  const index = createVectorIndex({ client, configProvider: () => config, identityProvider: () => ({ chatId: 'chat' }),
    sourceProvider, api: { embed: async (_config, texts) => { embeds++; return vectors(texts); } } });
  assert.equal((await index.build()).status, 'ready');
  assert.deepEqual(stages, ['source', 'verification']);
  assert.equal(rootReads, 2, '每个阶段仍核对当前目标的轻量root');
  assert.equal(reachableReads, 0, '两阶段都借用与root revision/checkpoint/generation/fingerprint匹配的已验证图');
  assert.equal(embeds, 1, '原文仍按一个既有embedding批次处理');
  assert.equal(records.get(VECTOR_INDEX_ID).data.chunkCount > 0, true);
});

test('updater按目标保留一个最新轻量待处理项，不复制memory state', async t => {
  const source = await sourceFixture();
  let state = committedMemoryState(source), listeners = new Set(), releaseFirst, firstStarted;
  const started = new Promise(resolve => { firstStarted = resolve; });
  const memoryRuntime = { getState: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
  const received = [];
  const vectorRuntime = { getState: () => ({}), updateIncrementally: async task => {
    received.push(task);
    if (received.length === 1) { firstStarted(); await new Promise(resolve => { releaseFirst = resolve; }); }
    return { status: 'unchanged' };
  } };
  const auto = createVectorAutoUpdater({ memoryRuntime, vectorRuntime, configProvider: () => config });
  t.after(() => auto.dispose());
  await started;
  const other = { ...source, chatId: 'other-chat', rawSources: [...source.rawSources, await rawFloor(source, 2)] };
  state = committedMemoryState(other); for (const fn of listeners) fn(state);
  const newest = { ...other, rawSources: [...other.rawSources, await rawFloor(source, 3)] };
  state = committedMemoryState(newest); for (const fn of listeners) fn(state);
  releaseFirst();
  await waitFor(() => received.length === 2);
  assert.equal(received[0].targetIdentity.chatId, 'chat');
  assert.equal(received[1].targetIdentity.chatId, 'other-chat');
  assert.equal(received[1].sourceKey.includes('floor-3'), true, '同一待处理目标合并到最新原文签名');
  assert.equal('floors' in received[1], false, '队列项不保存完整楼状态');
});

test('插件停用时即便配置仍存在也不读取索引或发送向量请求', async () => {
  const source = await sourceFixture(); let enabled = false, reads = 0, embeds = 0;
  const index = createVectorIndex({ client: { get: async () => { reads++; throw Object.assign(new Error('missing'), { status: 404 }); },
    put: async () => { throw new Error('disabled path must not save'); } }, configProvider: () => config,
    identityProvider: () => ({ chatId: source.chatId }), isEnabled: () => enabled,
    sourceProvider: async () => source, api: { embed: async () => { embeds++; return [[1, 0]]; } } });
  const result = await index.query({ source, queryContext: { text: '苹果' } });
  assert.equal(result.diagnostic.status, 'disabled');
  assert.equal(reads, 0); assert.equal(embeds, 0);
});

test('查询保留已加载索引快照，不受另一目标增量替换warm slot影响', async () => {
  const sourceA = await sourceFixture();
  const sourceB = { ...await sourceFixture(), chatId: 'other-chat', narrativeGeneration: 'other-generation',
    rawSources: [{ ...(await rawFloor({ chatId: 'other-chat' }, 1, 'B来源原文。')), floorId: 'other-floor', floorMemoryId: 'other-memory', memoryFloorId: 'other-floor' }] };
  const records = new Map(), key = (collection, id) => `${collection}/${id}`;
  const client = { get: async (collection, id) => {
    const record = records.get(key(collection, id));
    if (!record) throw Object.assign(new Error('missing'), { status: 404 });
    const { recordId: _id, ...value } = record; return structuredClone(value);
  }, put: async (collection, id, data, revision) => {
    const record = { recordId: id, revision: revision + 1, data: structuredClone(data) };
    records.set(key(collection, id), record); return record;
  } };
  let resolveQuery, queryStarted; const started = new Promise(resolve => { queryStarted = resolve; });
  const api = { embed: async (_config, texts) => {
    if (texts[0] === 'QUERY') { queryStarted(); return new Promise(resolve => { resolveQuery = resolve; }); }
    return texts.map(text => text.startsWith('B来源') ? [1, 0, 0] : [1, 0]);
  } };
  const indexB = createVectorIndex({ client, api, configProvider: () => config, identityProvider: () => ({ chatId: sourceB.chatId }),
    sourceProvider: async () => sourceB });
  assert.equal((await indexB.build()).status, 'ready');
  const indexA = createVectorIndex({ client, api, configProvider: () => config, identityProvider: () => ({ chatId: sourceA.chatId }),
    sourceProvider: async ({ targetIdentity }) => targetIdentity.chatId === sourceB.chatId ? sourceB : sourceA });
  assert.equal((await indexA.build()).status, 'ready');
  const query = indexA.query({ source: sourceA, queryContext: { text: 'QUERY' } }); await started;
  assert.equal((await indexA.updateIncrementally({ targetIdentity: { chatId: sourceB.chatId } })).status, 'unchanged');
  resolveQuery([[1, 0]]);
  const result = await query;
  assert.equal(result.diagnostic.status, 'ready');
  assert.equal(result.candidates.length, 1, '查询按开始时加载的原目标2维索引完成');
  assert.equal(result.candidates[0].witness.floorId, 'floor-1');
});

test('后台增量复用完整旧shard：16变17只为新片请求embedding并写新shard与manifest', async () => {
  const source = await sourceFixture();
  source.rawSources = [];
  for (let seq = 1; seq <= 16; seq += 1) source.rawSources.push(await rawFloor(source, seq));
  let modelCalls = 0;
  const h = harness(source, { api: { embed: async (_config, texts) => { modelCalls += 1; return vectors(texts); } } });
  await h.index.build();
  assert.equal(modelCalls, 1);
  assert.equal(h.calls.length, 2, '首次建立一份shard和manifest');
  const initialShard = h.records.get(VECTOR_INDEX_ID).data.shardIds[0];

  const shardReads = [];
  const originalGet = h.client.get;
  h.client.get = async (collection, id) => { if (id.startsWith(VECTOR_SHARD_PREFIX)) shardReads.push(id); return originalGet(collection, id); };
  h.setSource({ ...source, rawSources: [...source.rawSources, await rawFloor(source, 17)] });
  const writesBefore = h.calls.length;
  const originalBtoa = globalThis.btoa; let encodedRows = 0;
  globalThis.btoa = (...args) => { encodedRows += 1; return originalBtoa(...args); };
  let result;
  try { result = await h.index.updateIncrementally(); } finally { globalThis.btoa = originalBtoa; }
  assert.equal(result.status, 'ready');
  assert.equal(encodedRows, 1, '只有新分片的1行进入实际 Float32 编码；既有16行复用旧shard');
  assert.equal(modelCalls, 2, '只为新片追加一次embedding请求');
  assert.equal(shardReads.includes(initialShard), false, '热缓存不读取未变旧shard；新shard的存在性检查可读');
  assert.equal(h.calls.length - writesBefore, 2, '只保存新增shard和一次manifest');
  assert.equal(h.records.get(VECTOR_INDEX_ID).data.shardIds[0], initialShard, '未变shard id仍由新manifest引用');

  const coldBase = harness(source); await coldBase.index.build();
  const coldOldShard = coldBase.records.get(VECTOR_INDEX_ID).data.shardIds[0];
  const coldReads = [], coldWrites = [];
  const originalColdGet = coldBase.client.get;
  const coldClient = { ...coldBase.client,
    get: async (collection, id) => { if (id.startsWith(VECTOR_SHARD_PREFIX)) coldReads.push(id); return originalColdGet(collection, id); },
    put: async (...args) => { coldWrites.push(args[1]); return coldBase.client.put(...args); } };
  let coldModelCalls = 0;
  const latest = { ...source, rawSources: [...source.rawSources, await rawFloor(source, 17)] };
  const cold = createVectorIndex({ client: coldClient, api: { embed: async (_config, texts) => { coldModelCalls += 1; return vectors(texts); } },
    configProvider: () => config, identityProvider: () => ({ chatId: source.chatId }), sourceProvider: async () => latest });
  assert.equal((await cold.updateIncrementally()).status, 'ready');
  assert.equal(coldModelCalls, 1, '冷状态只对缺少的新原文片段请求embedding');
  assert.equal(coldReads.filter(id => id === coldOldShard).length, 1, '冷状态恢复一次已提交旧shard');
  assert.equal(coldReads.length, 2, '另一次读取仅是新增shard的存在性检查');
  assert.equal(coldWrites.length, 2, '冷增量只PUT新增shard和manifest，不重写未变shard');
});

test('摘要记录ID变化但原文锚点不变时手动重建保留旧shard见证', async () => {
  const source = await sourceFixture(); let apiCalls = 0;
  const h = harness(source, { api: { embed: async (_config, texts) => { apiCalls++; return vectors(texts); } } });
  assert.equal((await h.index.build()).status, 'ready');
  const oldShardId = h.records.get(VECTOR_INDEX_ID).data.shardIds[0];
  assert.equal(h.calls.filter(value => value.id.startsWith(VECTOR_SHARD_PREFIX)).length, 1);

  const revisedSummary = structuredClone(source);
  revisedSummary.rawSources[0].floorMemoryId = 'memory-1-after-summary-edit';
  h.setSource(revisedSummary);
  assert.equal((await h.index.build()).status, 'ready');
  assert.equal(apiCalls, 1, 'FloorMemory 身份变化不改变同一楼原文的向量资格');
  assert.equal(h.calls.filter(value => value.id.startsWith(VECTOR_SHARD_PREFIX)).length, 1, '原shard不重写');
  assert.deepEqual(h.records.get(VECTOR_INDEX_ID).data.shardIds, [oldShardId]);
  assert.ok(h.records.has(oldShardId), 'manifest仍引用真实存在的原shard');
  assert.equal(h.records.get(oldShardId).data.rows[0].witness.floorMemoryId, source.rawSources[0].floorMemoryId,
    '见证仅规范化键顺序，保留旧FloorMemory身份值');
});

test('自动增量只跟随正式记忆快照；无需首次触发，无落盘前缀、重复通知或摘要ID重试', async t => {
  const source = await sourceFixture();
  const h = harness(source); let state = committedMemoryState(source), listeners = new Set();
  const memoryRuntime = { getState: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
  const emit = () => { for (const fn of listeners) fn(state); };
  let calls = 0;
  let sourceReads = 0;
  const index = createVectorIndex({ client: h.client, configProvider: () => config, identityProvider: () => ({ chatId: source.chatId }),
    sourceProvider: async () => { sourceReads += 1; return h.latest ?? source; }, api: { embed: async (_config, texts) => { calls += 1; return vectors(texts); } } });
  h.latest = source;
  const auto = createVectorAutoUpdater({ memoryRuntime, vectorRuntime: index, configProvider: () => config });
  t.after(() => auto.dispose());
  // updating is intentionally not exposed as busy before the manifest-eligibility GET;
  // await that first real attempt so the manual build below cannot race startup.
  await waitFor(() => sourceReads > 0);
  await waitFor(() => !index.getState().updating);
  assert.equal(calls, 0, '没有manifest时后台不得自动首次建索引');
  assert.notEqual(index.getState().status, 'building', '无首次建索引资格时不伪装为后台工作');
  assert.equal(index.getState().active, false, '设置页的建立按钮保持可用');
  await index.build();
  const initialCalls = calls;
  const readsBeforeCseOnly = sourceReads;
  state = { ...state, headCheckpointId: 'cse-only-checkpoint' }; emit(); await flush();
  assert.equal(sourceReads, readsBeforeCseOnly, '仅CSE checkpoint变化不排入原文索引更新');

  const second = await rawFloor(source, 2);
  h.latest = { ...source, rawSources: [...source.rawSources, second] };
  state = committedMemoryState(h.latest); emit();
  await waitFor(() => calls === initialCalls + 1);
  assert.equal(calls, initialCalls + 1, '新记忆落盘后补充一次');
  await waitFor(() => h.records.get(VECTOR_INDEX_ID).data.chunkCount === 2);
  emit(); await flush(); assert.equal(calls, initialCalls + 1, '重复通知合并');
  const putsBeforeSummaryRevision = h.calls.length;
  h.latest = { ...h.latest, rawSources: h.latest.rawSources.map(raw => ({ ...raw, floorMemoryId: `revised-${raw.floorMemoryId}` })) };
  state = { ...state, cseRevision: 9, floors: state.floors.map(floor => ({ ...floor, memoryId: `revised-${floor.memoryId}` })) };
  emit(); await waitFor(() => index.getState().updating); await waitFor(() => !index.getState().updating);
  assert.equal(calls, initialCalls + 1, '摘要/CSE和FloorMemory ID变化只做原文差集核验，不重算');
  assert.equal(h.calls.length, putsBeforeSummaryRevision, '纯摘要修订不重写shard或manifest');

  const third = await rawFloor(source, 3);
  h.latest = { ...h.latest, rawSources: [...h.latest.rawSources, third] };
  state = { ...state, floors: [...state.floors, { floorId: third.floorId, assistantSeq: third.assistantSeq, canonicalFingerprint: third.fingerprint, status: 'pending' }] };
  emit(); await flush(); assert.equal(calls, initialCalls + 1, '摘要尚未落盘的新楼不进入正式索引来源');
  state = committedMemoryState(h.latest); emit();
  await waitFor(() => calls === initialCalls + 2);
  assert.equal(calls, initialCalls + 2, '同一楼后续正式落盘仍会补索引');

  h.latest = { ...h.latest, rawSources: [] }; state = committedMemoryState(h.latest, []); emit();
  await waitFor(() => h.records.get(VECTOR_INDEX_ID).data.chunkCount === 0);
  assert.equal(h.records.get(VECTOR_INDEX_ID).data.chunkCount, 0, '刪除到无原文时提交空索引');
  const fourth = await rawFloor(source, 4); h.latest = { ...h.latest, rawSources: [fourth] };
  state = committedMemoryState(h.latest); emit();
  await waitFor(() => h.records.get(VECTOR_INDEX_ID).data.chunkCount === 1);
  assert.equal(h.records.get(VECTOR_INDEX_ID).data.chunkCount, 1, '空manifest仍可自动补回后续稳定楼');
  assert.equal(calls, initialCalls + 3);
});

test('主楼生成门控后由结束/停止单次唤醒；同快照折叠且生成期间不启动', async () => {
  const source = await sourceFixture(), h = harness(source);
  let state = committedMemoryState(source), listeners = new Set(), generationActive = true, apiCalls = 0;
  const memoryRuntime = { getState: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
  const emit = () => { for (const fn of listeners) fn(state); };
  const index = createVectorIndex({ client: h.client, configProvider: () => config, identityProvider: () => ({ chatId: source.chatId }),
    sourceProvider: async () => h.latest ?? source, api: { embed: async (_config, texts) => { apiCalls += 1; return vectors(texts); } } });
  h.latest = source; await index.build();
  const auto = createVectorAutoUpdater({ memoryRuntime, vectorRuntime: index,
    configProvider: () => config, isMainGenerationActive: () => generationActive });
  const second = await rawFloor(source, 2); h.latest = { ...source, rawSources: [...source.rawSources, second] };
  state = committedMemoryState(h.latest); emit(); await flush();
  auto.refresh(); await flush();
  assert.equal(apiCalls, 1, '生成中收到的新稳定快照及过早结束通知均不发请求');
  generationActive = false;
  auto.refresh();
  await waitFor(() => h.records.get(VECTOR_INDEX_ID).data.chunkCount === 2);
  auto.refresh(); auto.refresh(); await flush();
  assert.equal(apiCalls, 2, '结束/停止唤醒只补一次，新楼期间没有漏掉');
  assert.equal(h.records.get(VECTOR_INDEX_ID).data.chunkCount, 2);
  auto.dispose();
});

test('源读取暂未ready不锁住同源快照；真实API失败仍不会循环重试', async () => {
  const source = await sourceFixture(), h = harness(source); await h.index.build();
  let state = committedMemoryState(source), listeners = new Set(), sourceReady = false, sourceReads = 0;
  const memoryRuntime = { getState: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
  const emit = () => { for (const fn of listeners) fn(state); };
  const outcomes = [];
  const index = createVectorIndex({ client: h.client, configProvider: () => config, identityProvider: () => ({ chatId: source.chatId }),
    sourceProvider: async () => { sourceReads += 1; return sourceReady ? source : { status: 'loading' }; },
    api: { embed: async (_config, texts) => vectors(texts) } });
  const vectorRuntime = { getState: () => index.getState(), subscribe: fn => index.subscribe(fn), updateIncrementally: async task => {
    const result = await index.updateIncrementally(task); outcomes.push(result); return result;
  } };
  const auto = createVectorAutoUpdater({ memoryRuntime, vectorRuntime, configProvider: () => config });
  await waitFor(() => outcomes.length === 1);
  assert.equal(outcomes[0].status, 'notReady');
  assert.equal(sourceReads, 1, '未ready不会在同一轮自动重试');
  sourceReady = true; emit();
  await waitFor(() => outcomes.length === 2);
  assert.equal(outcomes[1].status, 'unchanged', '相同正式快照在后续真实ready通知后恢复核对');
  emit(); await flush();
  assert.equal(outcomes.length, 2, 'ready后的unchanged快照仍只检查一次');
  auto.dispose();
});

test('自动更新遇到挂起的新楼会串行合并，释放后继续处理最新稳定快照', async () => {
  const source = await sourceFixture(), h = harness(source); let state = committedMemoryState(source), listeners = new Set();
  const memoryRuntime = { getState: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
  const emit = () => { for (const fn of listeners) fn(state); };
  let calls = 0, active = 0, maximumActive = 0, release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const index = createVectorIndex({ client: h.client, configProvider: () => config, identityProvider: () => ({ chatId: source.chatId }),
    sourceProvider: async () => h.latest, api: { embed: async (_config, texts) => {
      calls += 1; active += 1; maximumActive = Math.max(maximumActive, active);
      try { if (texts.some(text => text.includes('第2楼'))) { entered(); await new Promise(resolve => { release = resolve; }); } return vectors(texts); }
      finally { active -= 1; }
    } } });
  h.latest = source; await index.build();
  const auto = createVectorAutoUpdater({ memoryRuntime, vectorRuntime: index, configProvider: () => config });
  const second = await rawFloor(source, 2); h.latest = { ...source, rawSources: [...source.rawSources, second] };
  state = committedMemoryState(h.latest); emit(); await started;
  const third = await rawFloor(source, 3); h.latest = { ...h.latest, rawSources: [...h.latest.rawSources, third] };
  state = committedMemoryState(h.latest); emit(); await flush();
  assert.equal(calls, 2, '新楼到达时不会并行发第二个embedding请求');
  assert.equal(maximumActive, 1);
  release();
  await waitFor(() => h.records.get(VECTOR_INDEX_ID).data.chunkCount === 3);
  assert.equal(calls, 3, '释放首项后处理最新快照中仍缺少的楼');
  assert.equal(maximumActive, 1, '同一索引始终单writer');
  auto.dispose();
});

test('显式手动取消锁住同快照；内部重置与后续真实新来源都可继续', async t => {
  const source = await sourceFixture(), h = harness(source); let state = committedMemoryState(source), listeners = new Set();
  const memoryRuntime = { getState: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
  const emit = () => { for (const fn of listeners) fn(state); };
  let entered; const started = new Promise(resolve => { entered = resolve; }); let apiCalls = 0;
  let sourceReads = 0;
  const index = createVectorIndex({ client: h.client, configProvider: () => config, identityProvider: () => ({ chatId: source.chatId }),
    sourceProvider: async () => { sourceReads += 1; return h.latest; }, api: { embed: async (_config, _texts, { signal } = {}) => {
      apiCalls += 1; entered(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }));
    } } });
  h.latest = source;
  const auto = createVectorAutoUpdater({ memoryRuntime, vectorRuntime: index, configProvider: () => config });
  t.after(() => auto.dispose());
  await waitFor(() => sourceReads > 0);
  await waitFor(() => !index.getState().updating);
  const manualBuild = index.build(); await started;
  const second = await rawFloor(source, 2); h.latest = { ...source, rawSources: [...source.rawSources, second] };
  state = committedMemoryState(h.latest); emit(); await flush();
  index.abortAll({ userInitiated: true }); await assert.rejects(manualBuild, { code: 'VECTOR_ABORTED' });
  emit(); await flush(); await flush();
  assert.equal(apiCalls, 1, '同批待处理通知不会在手动取消后重新发起后台API');
  assert.equal(h.records.has(VECTOR_INDEX_ID), false);
});

test('取消标记只通知一次；用户取消不吞新楼，普通配置/生命周期重置不冒充人工取消', async () => {
  for (const userInitiated of [true, false]) {
    const source = await sourceFixture(), h = harness(source); let state = committedMemoryState(source), listeners = new Set();
    const memoryRuntime = { getState: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
    const emit = () => { for (const fn of listeners) fn(state); };
    let calls = 0, firstPending = true, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const index = createVectorIndex({ client: h.client, configProvider: () => config, identityProvider: () => ({ chatId: source.chatId }),
      sourceProvider: async () => h.latest, api: { embed: async (_config, texts, { signal } = {}) => {
        calls += 1;
        if (firstPending && texts.some(text => text.includes('第2楼'))) {
          firstPending = false; entered();
          return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }));
        }
        return vectors(texts);
      } } });
    h.latest = source; await index.build();
    const autoOutcomes = [];
    const auto = createVectorAutoUpdater({ memoryRuntime, vectorRuntime: { getState: () => index.getState(), subscribe: fn => index.subscribe(fn), updateIncrementally: async task => {
      const outcome = await index.updateIncrementally(task); autoOutcomes.push(outcome); return outcome;
    } }, configProvider: () => config });
    const second = await rawFloor(source, 2); h.latest = { ...source, rawSources: [...source.rawSources, second] };
    state = committedMemoryState(h.latest); emit(); await started;
    index.abortAll({ userInitiated });
    await waitFor(() => !index.getState().updating);
    assert.equal(index.getState().cancelled, false, '取消标记不会粘在后续索引状态');
    assert.equal(index.getState().userCancelled, false, '人工意图只存在于取消通知');
    emit();
    if (userInitiated) {
      await flush();
      assert.equal(autoOutcomes.length, 2, '人工取消锁住同一快照');
      assert.equal(calls, 2);
    } else {
      await waitFor(() => autoOutcomes.length === 3);
      assert.notEqual(autoOutcomes[2].status, 'suppressed', '普通生命周期取消不在索引runtime留下同源取消锁');
      await waitFor(() => h.records.get(VECTOR_INDEX_ID).data.chunkCount === 2);
      assert.equal(calls, 3, '普通重置后的同源恢复仅补算尚未提交的新原文');
    }
    assert.equal(calls, userInitiated ? 2 : 3, userInitiated ? '同一来源不会被人工取消后立刻重试' : '普通重置会在后续通知重新核验同源');
    const third = await rawFloor(source, 3); h.latest = { ...h.latest, rawSources: [...h.latest.rawSources, third] };
    state = committedMemoryState(h.latest); emit();
    const deadline = Date.now() + 2000;
    while (h.records.get(VECTOR_INDEX_ID).data.chunkCount !== 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(h.records.get(VECTOR_INDEX_ID).data.chunkCount, 3,
      `新稳定来源应越过旧取消记录继续增量：${JSON.stringify({ userInitiated, calls, outcomes: autoOutcomes, status: index.getState().status, updating: index.getState().updating })}`);
    assert.equal(calls, userInitiated ? 3 : 4, '新稳定来源可越过旧取消/重置记录继续增量');
    auto.dispose();
  }
});

test('增量失败或manifest CAS冲突保留旧提交；同源不重试，来源真变后可继续', async () => {
  for (const failure of ['embedding', 'manifest']) {
    const source = await sourceFixture(), h = harness(source); await h.index.build();
    const oldManifest = structuredClone(h.records.get(VECTOR_INDEX_ID));
    const next = { ...source, rawSources: [...source.rawSources, await rawFloor(source, 2)] };
    let requests = 0, failOnce = true;
    const client = { ...h.client, put: async (collection, id, data, revision, options) => {
      if (failure === 'manifest' && id === VECTOR_INDEX_ID && failOnce) { failOnce = false; throw Object.assign(new Error('conflict'), { status: 409 }); }
      return h.client.put(collection, id, data, revision, options);
    } };
    const index = createVectorIndex({ client, configProvider: () => config, identityProvider: () => ({ chatId: source.chatId }), sourceProvider: async () => h.latest,
      api: { embed: async (_config, texts) => { requests += 1; if (failure === 'embedding' && failOnce) { failOnce = false; throw Object.assign(new Error('offline'), { status: 503 }); } return vectors(texts); } } });
    h.latest = next;
    const failed = await index.updateIncrementally();
    assert.equal(failed.status, 'error'); assert.deepEqual(h.records.get(VECTOR_INDEX_ID), oldManifest, '失败不替换旧manifest');
    assert.equal((await index.updateIncrementally()).status, 'suppressed', '相同原文集合失败后不循环请求');
    assert.equal(requests, 1);
    h.latest = { ...next, rawSources: [...next.rawSources, await rawFloor(source, 3)] };
    assert.equal((await index.updateIncrementally()).status, 'ready', '真实来源变化后可重新处理');
    assert.equal(h.records.get(VECTOR_INDEX_ID).data.chunkCount, 3);
  }
});

test('同一原文改向量认证配置后会按新配置键核验，不被取消状态吞掉', async () => {
  const source = await sourceFixture(), h = harness(source); let state = committedMemoryState(source), listeners = new Set(), route = config;
  const memoryRuntime = { getState: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
  const emit = () => { for (const fn of listeners) fn(state); };
  const outcomes = [];
  let resolveFirstOutcome, resolveSecondOutcome;
  const firstOutcome = new Promise(resolve => { resolveFirstOutcome = resolve; });
  const secondOutcome = new Promise(resolve => { resolveSecondOutcome = resolve; });
  const index = createVectorIndex({ client: h.client, configProvider: () => route, identityProvider: () => ({ chatId: source.chatId }), sourceProvider: async () => source,
    api: { embed: async (_config, texts) => vectors(texts) } });
  await index.build();
  const vectorRuntime = { getState: () => index.getState(), subscribe: fn => index.subscribe(fn), updateIncrementally: async task => {
    const result = await index.updateIncrementally(task); outcomes.push(result);
    if (outcomes.length === 1) resolveFirstOutcome(result);
    else if (outcomes.length === 2) resolveSecondOutcome(result);
    return result;
  } };
  const auto = createVectorAutoUpdater({ memoryRuntime, vectorRuntime, configProvider: () => route });
  await firstOutcome;
  assert.equal(outcomes[0].status, 'unchanged');
  route = { ...config, key: 'rotated-test-key' };
  index.abortAll();
  await secondOutcome;
  assert.equal(outcomes[1].status, 'unchanged', '认证配置变化可读取并复用同一模型的原文索引');
  emit(); await flush();
  assert.equal(outcomes.length, 2, '配置核验完成后不重复请求');
  auto.dispose();
});

test('后台embedding挂起期间旧manifest仍可召回，增量未提交且查询不等待', async () => {
  const source = await sourceFixture(), h = harness(source); await h.index.build();
  let entered, release; const started = new Promise(resolve => { entered = resolve; });
  const pendingVector = new Promise(resolve => { release = resolve; }); let calls = 0;
  const index = createVectorIndex({ client: h.client, api: { embed: async (_config, texts) => { calls += 1; if (texts.some(text => text.includes('第2楼'))) { entered(); return pendingVector; } return vectors(texts); } },
    configProvider: () => config, identityProvider: () => ({ chatId: source.chatId }), sourceProvider: async () => h.latest });
  h.latest = { ...source, rawSources: [...source.rawSources, await rawFloor(source, 2)] };
  const oldManifest = structuredClone(h.records.get(VECTOR_INDEX_ID));
  const update = index.updateIncrementally(); await started;
  assert.deepEqual(h.records.get(VECTOR_INDEX_ID), oldManifest, 'embedding期间不提前切manifest');
  const query = await index.query({ source: h.latest, queryContext: { text: '苹果' } });
  assert.ok(query.candidates.length, '查询继续使用已提交旧索引');
  assert.equal(query.candidates[0].witness.floorId, 'floor-1');
  assert.equal(calls, 2, '旧索引查询一次，新楼更新一次；没有额外等待更新');
  release([[0, 1]]); assert.equal((await update).status, 'ready');
});

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

test('共享后端重排JSON键后仍按确定shard续建并发布有效manifest', async () => {
  const sortKeys = value => Array.isArray(value) ? value.map(sortKeys) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])])) : value;
  const records = new Map(), batches = [];
  const client = createBackendClient({ baseUrl: 'https://offline.invalid', fetchImpl: async (url, options) => {
    const path = new URL(url).pathname;
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body), previous = records.get(path);
      assert.equal(body.expectedRevision, previous?.revision ?? 0);
      const stored = { schemaVersion: 1, revision: body.expectedRevision + 1, generationId: 'neutral-backend', data: sortKeys(body.data) };
      records.set(path, stored);
      return { ok: true, json: async () => structuredClone(stored) };
    }
    const value = records.get(path);
    return value ? { ok: true, json: async () => structuredClone(value) }
      : { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
  } });
  const source = await sourceFixture();
  source.rawSources[0].canonicalContent = 'N'.repeat(20800);
  source.rawSources[0].fingerprint = await hash(source.rawSources[0].canonicalContent);
  let failAt = 2;
  const api = createVectorApiClient({ fetchImpl: async (_url, options) => {
    const input = JSON.parse(options.body).input; batches.push(input);
    if (batches.length === failAt) return new Response(JSON.stringify({ error: { code: 'neutral_backend_resume_failure' } }), { status: 400 });
    return new Response(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 0] })) }), { status: 200 });
  } });
  const makeIndex = () => createVectorIndex({ client, api, configProvider: () => config,
    identityProvider: () => ({ chatId: source.chatId }), sourceProvider: async () => source });
  await assert.rejects(makeIndex().build(), error => error.code === 'VECTOR_HTTP_ERROR' && error.status === 400);
  assert.deepEqual(batches.map(input => input.length), [16, 16]);
  const collectionPath = '/v1/records/qianqianjie/chat-chat/';
  const storedRecords = () => [...records.entries()].filter(([path]) => path.startsWith(collectionPath)).map(([path, value]) => ({
    recordId: decodeURIComponent(path.slice(collectionPath.length)), revision: value.revision, data: structuredClone(value.data),
  }));
  const orphan = storedRecords().find(record => record.recordId.startsWith(VECTOR_SHARD_PREFIX));
  assert.ok(orphan);
  assert.deepEqual(Object.keys(orphan.data.rows[0].witness), Object.keys(orphan.data.rows[0].witness).sort(), '模拟共享存储按键序重排嵌套JSON');
  const reachable = { status: 'ready', root: { chatId: source.chatId, narrativeGeneration: source.narrativeGeneration },
    floors: [{ id: 'floor-1', assistantSeq: 1, content: { canonicalContent: source.rawSources[0].canonicalContent } }],
    floorMemories: [{ id: 'memory-1', floorId: 'floor-1', recordStatus: 'active', sourceFloorIds: ['floor-1'],
      summary: { effectiveSource: 'ai', aiText: '中性摘要' } }] };
  assert.deepEqual(await makeIndex().getResumableShardIds(reachable, storedRecords()), [orphan.recordId],
    '孤立批次经共享后端键重排后仍能按字段值识别');

  const beforeResume = batches.length; failAt = -1;
  const resumed = makeIndex();
  assert.equal((await resumed.build()).status, 'ready');
  assert.deepEqual(batches.slice(beforeResume).map(input => input.length), [16, 16, 16, 1], '新runtime续建跳过已存首批，只请求剩余49段');
  const manifest = storedRecords().find(record => record.recordId === VECTOR_INDEX_ID);
  assert.ok(manifest);
  assert.equal(manifest.data.shardIds.every(id => storedRecords().some(record => record.recordId === id)), true,
    '最终manifest每个引用均有实际持久shard');
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

test('失败后按精确持久shard续建；同runtime和新runtime均不重嵌已保存批次', async () => {
  async function interruptedBuild() {
    const source = await sourceFixture();
    source.rawSources[0].canonicalContent = Array.from({ length: 20800 }, (_, index) => String.fromCharCode(65 + index % 26)).join('');
    source.rawSources[0].fingerprint = await hash(source.rawSources[0].canonicalContent);
    const h = harness(source), batches = [];
    let failAt = 2;
    const api = createVectorApiClient({ fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body); batches.push(payload.input);
      if (batches.length === failAt) return new Response(JSON.stringify({ error: { code: 'neutral_batch_failure' } }), { status: 400 });
      return new Response(JSON.stringify({ data: payload.input.map((_, index) => ({ index, embedding: [index + 1, 1] })) }), { status: 200 });
    } });
    const create = () => createVectorIndex({ client: h.client, api, configProvider: () => config,
      identityProvider: () => ({ chatId: source.chatId }), sourceProvider: async () => source });
    const first = create();
    await assert.rejects(first.build(), error => error.code === 'VECTOR_HTTP_ERROR' && error.status === 400);
    const buildDiagnostic = first.getState().buildDiagnostic;
    assert.deepEqual({ status: buildDiagnostic.status, phase: buildDiagnostic.phase, batchNumber: buildDiagnostic.batchNumber,
      completedChunks: buildDiagnostic.completedChunks, totalChunks: buildDiagnostic.totalChunks, inputCount: buildDiagnostic.inputCount,
      inputCharacters: buildDiagnostic.inputCharacters, longestInputCharacters: buildDiagnostic.longestInputCharacters,
      errorCode: buildDiagnostic.errorCode, httpStatus: buildDiagnostic.httpStatus },
    { status: 'failed', phase: 'embedding', batchNumber: 2, completedChunks: 16, totalChunks: 65, inputCount: 16,
      inputCharacters: 6400, longestInputCharacters: 400, errorCode: 'VECTOR_HTTP_ERROR', httpStatus: 400 });
    assert.doesNotMatch(JSON.stringify(buildDiagnostic), /test-key|vector\.invalid|SECRET|苹果配方/u);
    assert.equal(h.records.has(VECTOR_INDEX_ID), false, '部分保存不能提前发布manifest');
    assert.equal([...h.records.keys()].filter(id => id.startsWith(VECTOR_SHARD_PREFIX)).length, 1);
    failAt = -1;
    const resumed = await first.build();
    assert.equal(resumed.status, 'ready');
    assert.deepEqual(batches.map(value => value.length), [16, 16, 16, 16, 16, 1]);
    assert.notDeepEqual(batches[2], batches[0], '同runtime续建跳过首个已保存batch');
    assert.ok(h.records.has(VECTOR_INDEX_ID));
    return { source, h, batches, create };
  }
  await interruptedBuild();

  const source = await sourceFixture();
  source.rawSources[0].canonicalContent = Array.from({ length: 20800 }, (_, index) => String.fromCharCode(65 + index % 26)).join('');
  source.rawSources[0].fingerprint = await hash(source.rawSources[0].canonicalContent);
  const h = harness(source), batches = [];
  let failAt = 2;
  const api = createVectorApiClient({ fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body); batches.push(payload.input);
    if (batches.length === failAt) return new Response(JSON.stringify({ error: { code: 'neutral_batch_failure' } }), { status: 400 });
    return new Response(JSON.stringify({ data: payload.input.map((_, index) => ({ index, embedding: [1, index + 1] })) }), { status: 200 });
  } });
  const create = () => createVectorIndex({ client: h.client, api, configProvider: () => config,
    identityProvider: () => ({ chatId: source.chatId }), sourceProvider: async () => source });
  await assert.rejects(create().build(), error => error.code === 'VECTOR_HTTP_ERROR' && error.status === 400);
  failAt = -1;
  assert.equal((await create().build()).status, 'ready', '全新runtime从持久batch续建');
  assert.deepEqual(batches.map(value => value.length), [16, 16, 16, 16, 16, 1]);
  assert.notDeepEqual(batches[2], batches[0]);
});

test('可复用旧向量重新组合成批时仍先持久化新shard；manifest失败后能读回重试', async () => {
  const source = await sourceFixture();
  const contents = ['A', 'B', 'C'].map(letter => letter.repeat(2560));
  source.rawSources = await Promise.all(contents.map((content, index) => rawFloor(source, index + 1, content)));
  const h = harness(source); let embedCalls = 0, failManifest = false, current = source;
  const client = { ...h.client, put: async (collection, id, data, revision, options) => {
    if (id === VECTOR_INDEX_ID && failManifest) { failManifest = false; throw Object.assign(new Error('temporary save failure'), { code: 'BACKEND_UNAVAILABLE' }); }
    return h.client.put(collection, id, data, revision, options);
  } };
  const index = createVectorIndex({ client, api: { embed: async (_config, texts) => { embedCalls++; return vectors(texts); } },
    configProvider: () => config, identityProvider: () => ({ chatId: source.chatId }), sourceProvider: async () => current });
  await index.build();
  const originalEmbedCalls = embedCalls;
  const originalManifest = h.records.get(VECTOR_INDEX_ID).data;
  const reordered = structuredClone(source);
  reordered.rawSources.reverse(); current = reordered; h.setSource(reordered);
  failManifest = true;
  await assert.rejects(index.build(), /索引保存失败/u);
  assert.equal(embedCalls, originalEmbedCalls, '旧raw witness和向量都可复用，不重发embedding');
  assert.equal(h.records.has(VECTOR_INDEX_ID), true);
  assert.deepEqual(h.records.get(VECTOR_INDEX_ID).data, originalManifest, 'manifest写失败保留原已发布索引');
  const pendingIds = [...h.records.keys()].filter(id => id.startsWith(VECTOR_SHARD_PREFIX) && !originalManifest.shardIds.includes(id));
  assert.ok(pendingIds.length > 0, '新组合shard在manifest写失败前已落盘');
  assert.ok(pendingIds.every(id => h.records.has(id)));
  assert.equal((await index.build()).status, 'ready', '同runtime重试能读取已写的新组合shard，不以revision 0覆盖');
  assert.equal(embedCalls, originalEmbedCalls);
  assert.ok(h.records.get(VECTOR_INDEX_ID).data.shardIds.every(id => h.records.has(id)), 'manifest不引用尚未写入的记录');
});

test('shard写失败不形成断点；原文或模型变化、损坏向量都重新embedding', async () => {
  const makeSource = async () => {
    const value = await sourceFixture();
    value.rawSources[0].canonicalContent = Array.from({ length: 5400 }, (_, index) => String.fromCharCode(65 + index % 26)).join('');
    value.rawSources[0].fingerprint = await hash(value.rawSources[0].canonicalContent);
    return value;
  };

  const writeSource = await makeSource(), writeHarness = harness(writeSource), writeBatches = [];
  let firstShardFailure = true;
  const failingClient = { ...writeHarness.client, put: async (collection, id, data, revision, options) => {
    if (firstShardFailure && id.startsWith(VECTOR_SHARD_PREFIX)) { firstShardFailure = false; throw Object.assign(new Error('write failed'), { code: 'BACKEND_UNAVAILABLE' }); }
    return writeHarness.client.put(collection, id, data, revision, options);
  } };
  const writeApi = { embed: async (_config, texts) => { writeBatches.push(texts); return vectors(texts); } };
  const writeIndex = createVectorIndex({ client: failingClient, api: writeApi, configProvider: () => config,
    identityProvider: () => ({ chatId: writeSource.chatId }), sourceProvider: async () => writeSource });
  await assert.rejects(writeIndex.build(), { code: 'VECTOR_SAVE_FAILED' });
  assert.equal(writeHarness.records.has(VECTOR_INDEX_ID), false);
  assert.equal([...writeHarness.records.keys()].filter(id => id.startsWith(VECTOR_SHARD_PREFIX)).length, 0);
  assert.equal((await writeIndex.build()).status, 'ready');
  assert.deepEqual(writeBatches.map(value => value.length), [16, 16, 1], '确认失败的16段只会在重试时重新请求，未确认写入不会被当作断点');

  async function partial() {
    const source = await makeSource(), h = harness(source), batches = [];
    const api = createVectorApiClient({ fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body); batches.push(payload.input);
      if (batches.length === 2) return new Response(JSON.stringify({ error: { code: 'neutral_failure' } }), { status: 400 });
      return new Response(JSON.stringify({ data: payload.input.map((_, index) => ({ index, embedding: [1, 0] })) }), { status: 200 });
    } });
    let route = config;
    const index = createVectorIndex({ client: h.client, api, configProvider: () => route,
      identityProvider: () => ({ chatId: source.chatId }), sourceProvider: async () => source });
    await assert.rejects(index.build(), { code: 'VECTOR_HTTP_ERROR' });
    return { source, h, batches, index, setRoute(value) { route = value; } };
  }
  const changedBody = await partial();
  changedBody.source.rawSources[0].canonicalContent += '真实新增正文。';
  changedBody.source.rawSources[0].fingerprint = await hash(changedBody.source.rawSources[0].canonicalContent);
  assert.equal((await changedBody.index.build()).status, 'ready');
  assert.deepEqual(changedBody.batches.map(value => value.length), [16, 1, 16, 1], '原文指纹改变时不复用旧断点');

  const changedModel = await partial();
  changedModel.setRoute({ ...config, model: 'changed-neutral-model' });
  assert.equal((await changedModel.index.build()).status, 'ready');
  assert.deepEqual(changedModel.batches.map(value => value.length), [16, 1, 16, 1], '模型owner改变时不复用旧断点');

  const corrupt = await partial();
  const shardId = [...corrupt.h.records.keys()].find(id => id.startsWith(VECTOR_SHARD_PREFIX));
  corrupt.h.records.get(shardId).data.rows[0].vector = 'not-base64';
  assert.equal((await corrupt.index.build()).status, 'ready');
  assert.deepEqual(corrupt.batches.map(value => value.length), [16, 1, 16, 1], '损坏向量批次重新embedding并修复记录');
});

test('存储清理仅保留当前模型/代际且原文见证匹配的未发布向量shard', async () => {
  const source = await sourceFixture();
  source.rawSources[0].canonicalContent = Array.from({ length: 18000 }, (_, index) => String.fromCharCode(65 + index % 26)).join('');
  source.rawSources[0].fingerprint = await hash(source.rawSources[0].canonicalContent);
  const h = harness(source); let apiCalls = 0;
  const api = createVectorApiClient({ fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body); apiCalls += 1;
    if (apiCalls === 2) return new Response(JSON.stringify({ error: { code: 'neutral_failure' } }), { status: 400 });
    return new Response(JSON.stringify({ data: payload.input.map((_, index) => ({ index, embedding: [1, 0] })) }), { status: 200 });
  } });
  const create = route => createVectorIndex({ client: h.client, api, configProvider: () => route,
    identityProvider: () => ({ chatId: source.chatId }), sourceProvider: async () => source });
  await assert.rejects(create(config).build(), { code: 'VECTOR_HTTP_ERROR' });
  const reachable = { status: 'ready', root: { chatId: source.chatId, narrativeGeneration: source.narrativeGeneration },
    floors: [{ id: 'floor-1', assistantSeq: 1, content: { canonicalContent: source.rawSources[0].canonicalContent } }],
    floorMemories: [{ id: 'memory-1', floorId: 'floor-1', recordStatus: 'active', sourceFloorIds: ['floor-1'],
      summary: { effectiveSource: 'ai', aiText: '中性摘要' } }] };
  const index = create(config), records = [...h.records.values()];
  const resumable = await index.getResumableShardIds(reachable, records);
  assert.equal(resumable.length, 1);
  const classified = await classifyStorageRecords(records, reachable, source.chatId, { resumableVectorShardIds: resumable });
  assert.equal(classified.stats.active.count, 1);
  assert.equal(classified.candidates.length, 0, '自动清理扫描不会删掉可精确续建的当前shard');

  const corrupted = structuredClone(records[0]); corrupted.data.rows[0].witness.textFingerprint = `sha256:${'0'.repeat(64)}`;
  assert.deepEqual(await index.getResumableShardIds(reachable, [corrupted]), [], '内容见证损坏则不续用');
  const otherModel = { ...config, model: 'other-neutral-model' };
  assert.deepEqual(await create(otherModel).getResumableShardIds(reachable, records), [], '其他模型的孤立shard不续用');
  const editedReachable = structuredClone(reachable);
  editedReachable.floors[0].content.canonicalContent += '正文真实变化';
  assert.deepEqual(await index.getResumableShardIds(editedReachable, records), [], '当前原文变化后旧孤立shard不续用');
});

test('HTTP 400仅投影短结构化字段和硅基trace id；巨大或挂起错误正文不覆盖状态/期限', async () => {
  let diagnostic = null;
  const traceId = 'sc_trace_20261010_12345678';
  const structured = createVectorApiClient({ fetchImpl: async () => new Response(JSON.stringify({
    error: { code: 'invalid_dimensions', type: 'invalid_request_error', param: 'dimensions', message: 'SECRET provider prose test-key' },
    data: { private: 'SECRET payload' },
  }), { status: 400, headers: { 'x-siliconcloud-trace-id': traceId } }) });
  await assert.rejects(structured.embed(config, ['中性输入'], { onDiagnostic: value => { diagnostic = value; } }), error => {
    assert.equal(error.code, 'VECTOR_HTTP_ERROR'); assert.equal(error.status, 400);
    assert.deepEqual(error.providerError, { code: 'invalid_dimensions', type: 'invalid_request_error', param: 'dimensions' });
    assert.doesNotMatch(error.message, /SECRET|test-key|provider prose/u); return true;
  });
  assert.equal(diagnostic.httpStatus, 400);
  assert.equal(diagnostic.providerRequestId, traceId);
  assert.deepEqual(diagnostic.providerError, { code: 'invalid_dimensions', type: 'invalid_request_error', param: 'dimensions' });
  assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET|test-key|provider prose|https:/u);

  const oversized = createVectorApiClient({ fetchImpl: async () => new Response(JSON.stringify({
    error: { code: 'too_large_wrapper', param: 'input' }, data: 'x'.repeat(12000),
  }), { status: 400, headers: { 'content-length': '12080' } }) });
  await assert.rejects(oversized.embed(config, ['中性输入']), error => error.code === 'VECTOR_HTTP_ERROR' && error.status === 400 && error.providerError === null);

  let unboundedTextReads = 0;
  const unknownLengthTextOnly = createVectorApiClient({ fetchImpl: async () => ({ ok: false, status: 400,
    headers: { get: () => null }, text: async () => { unboundedTextReads++; return JSON.stringify({ error: { code: 'should_not_read' } }); } }) });
  await assert.rejects(unknownLengthTextOnly.embed(config, ['中性输入']), error => error.code === 'VECTOR_HTTP_ERROR' && error.status === 400 && error.providerError === null);
  assert.equal(unboundedTextReads, 0, 'text-only response without bounded content length is skipped');

  let bodyCancelled = false;
  const stalled = createVectorApiClient({ fetchImpl: async () => ({ ok: false, status: 400, headers: { get: () => null },
    body: new ReadableStream({ cancel() { bodyCancelled = true; } }) }) });
  const started = Date.now();
  await assert.rejects(stalled.embed(config, ['中性输入'], { timeoutMs: 15 }), error => error.code === 'VECTOR_HTTP_ERROR' && error.status === 400);
  assert.ok(Date.now() - started < 1500, '已收到HTTP状态后错误正文诊断保持有界，不等原API deadline');
  assert.equal(bodyCancelled, true, '期限到时停止失败正文读取');

  let slowCancelled = false, sent = 0;
  const slow = createVectorApiClient({ fetchImpl: async () => ({ ok: false, status: 400, headers: { get: () => null },
    body: new ReadableStream({
      async pull(controller) { await new Promise(resolve => setTimeout(resolve, 100)); controller.enqueue(new TextEncoder().encode(`x${sent++}`)); },
      cancel() { slowCancelled = true; },
    }) }) });
  const slowStarted = Date.now();
  await assert.rejects(slow.embed(config, ['中性输入'], { timeoutMs: 10 }), error => error.code === 'VECTOR_HTTP_ERROR' && error.status === 400);
  assert.ok(Date.now() - slowStarted < 1500, '分块慢流共享单个错误正文总期限');
  assert.ok(slowCancelled);
});

test('向量原文分段不切开Unicode代理对且见证对应原文；Qwen请求保留400字符/16段合同', async () => {
  const sources = [];
  for (const [name, content] of [
    ['end-boundary', `${'A'.repeat(399)}🙂${'B'.repeat(4799)}`],
    ['start-boundary', `${'A'.repeat(319)}𠮷${'B'.repeat(4799)}`],
  ]) sources.push({ name, floorId: `floor-${name}`, assistantSeq: 1, floorMemoryId: `memory-${name}`,
    memoryFloorId: `floor-${name}`, memoryAssistantSeq: 1, canonicalContent: content, fingerprint: await hash(content) });
  for (const raw of sources) {
    const chunks = rawSourceChunks({ rawSources: [raw] });
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.text.length <= 400);
      assert.equal(raw.canonicalContent.slice(chunk.witness.offset, chunk.witness.offset + chunk.witness.length), chunk.text);
      assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(chunk.text), false, '每段都保留完整代理对');
      assert.equal(await rawWitnessValid({ ...chunk.witness, textFingerprint: await hash(chunk.text) }, { rawSources: [raw] }), true);
    }
  }
  const ascii = rawSourceChunks({ rawSources: [{ ...sources[0], canonicalContent: 'A'.repeat(1000) }] });
  assert.deepEqual(ascii.map(chunk => [chunk.witness.offset, chunk.witness.length]), [[0, 400], [320, 400], [640, 360]]);

  const productionChunks = rawSourceChunks({ rawSources: [sources[0]] });
  assert.equal(productionChunks.length, 16);
  let request;
  const api = createVectorApiClient({ fetchImpl: async (url, options) => {
    request = { url, method: options.method, payload: JSON.parse(options.body) };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: request.payload.input.map((_, index) => ({ index, embedding: Array(1024).fill(1) })) }) };
  } });
  const qwen = normalizeVectorConfig({ url: 'https://vector.invalid/v1', key: 'test-key', model: 'Qwen/Qwen3-Embedding-8B' });
  const result = await api.embed(qwen, productionChunks.map(chunk => chunk.text));
  assert.equal(request.payload.input.length, 16);
  assert.ok(request.payload.input.every(text => text.length <= 400));
  assert.ok(request.payload.input.every(text => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)));
  assert.equal(request.payload.encoding_format, 'float');
  assert.equal(request.payload.dimensions, 1024);
  assert.equal(result.length, 16);
  assert.equal(result[0].length, 1024);
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
    headers: { get: name => name.toLowerCase() === 'www-authenticate' ? challenge : name.toLowerCase() === 'content-length' ? String(new TextEncoder().encode(body).byteLength) : null }, text: async () => body });
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

test('真实源投影始终保留合格原文；旧人工摘要仅留给历史回执见证校验', async () => {
  const floors = [{ id: 'old', assistantSeq: 1 }, { id: 'anchor', assistantSeq: 4 }];
  const memories = [{ id: 'memory', floorId: 'anchor', sourceFloorIds: ['old', 'anchor'], sourceFloorSnapshots: [{ floorId: 'old', canonicalContent: '老楼原文' }, { floorId: 'anchor', canonicalContent: '归档楼原文' }], summary: { effectiveSource: 'ai', aiText: '旧AI摘要' } }];
  const projection = await projectVectorSources(memories, floors);
  assert.deepEqual(projection.rawSources.map(value => value.canonicalContent), ['老楼原文', '归档楼原文'], '聚合AI来源继续只读取各成员的专用快照');
  assert.equal(projection.rawSources[0].assistantSeq, 1); assert.equal(projection.rawSources[0].memoryAssistantSeq, 4); assert.equal(projection.rawSources[0].memoryFloorId, 'anchor');
  assert.deepEqual(projection.summarySources, []);
  memories[0].summary = { effectiveSource: 'user', userText: '用户只留下的钟楼线索', aiText: '旧AI摘要不能回捞' };
  const manual = await projectVectorSources(memories, floors);
  assert.equal(manual.rawSources.length, 2, '摘要来源变化不撤销各成员的合格原文');
  assert.deepEqual(manual.rawSources.map(value => value.canonicalContent), ['老楼原文', '归档楼原文']);
  assert.equal(manual.summarySources.length, 1, '旧回执仍能核对当时使用的人工摘要');
  assert.equal(manual.summarySources[0].floorId, 'anchor'); assert.equal(manual.summarySources[0].assistantSeq, 4);
  assert.equal(manual.summarySources[0].floorMemoryId, 'memory'); assert.equal(manual.summarySources[0].memoryFloorId, 'anchor');
  assert.equal(manual.summarySources[0].canonicalContent, '用户只留下的钟楼线索');
  assert.doesNotMatch(manual.summarySources[0].canonicalContent, /老楼原文|归档楼原文|旧AI摘要/u);
  const oldReceiptWitness = { sourceKind: 'userSummary', floorId: 'anchor', assistantSeq: 4, floorMemoryId: 'memory', memoryFloorId: 'anchor',
    memoryAssistantSeq: 4, fingerprint: manual.summarySources[0].fingerprint, offset: 0, length: 3, textFingerprint: await hash('用户只') };
  assert.equal(await summaryWitnessValid(oldReceiptWitness, manual), true, '旧摘要回执见证仍能按当前摘要校验');
  memories[0].summary.userText = '摘要后来再次校准';
  const editedProjection = await projectVectorSources(memories, floors);
  assert.equal(await summaryWitnessValid(oldReceiptWitness, editedProjection), false, '再次改摘要后旧摘要见证不再有效');
  memories[0].summary = { effectiveSource: 'user', userText: '' };
  const emptyManual = await projectVectorSources(memories, floors);
  assert.equal(emptyManual.rawSources.length, 2, '清空摘要仍保留原文资格');
  assert.deepEqual(emptyManual.summarySources, [], '空摘要不会制造历史摘要见证');
  memories[0].summary = { effectiveSource: 'ai' };
  assert.equal((await projectVectorSources(memories, floors.slice(1))).rawSources.length, 1);
  floors[0].content = { canonicalContent: '被编辑的新正文' };
  assert.equal((await projectVectorSources(memories, floors)).rawSources.length, 1);
});

test('旧单楼缺专用来源快照时回退已保存楼正文，并继续尊重空值和矛盾', async () => {
  const floor = { id: 'legacy-floor', assistantSeq: 1, content: { canonicalContent: '旧档保留的完整正文。' } };
  const memory = { id: 'legacy-memory', floorId: floor.id, summary: { effectiveSource: 'ai' } };
  const fallback = await projectVectorSources([memory], [floor]);
  assert.equal(fallback.rawSources.length, 1);
  assert.equal(fallback.rawSources[0].canonicalContent, floor.content.canonicalContent);
  assert.equal(fallback.rawSources[0].floorMemoryId, memory.id);

  assert.deepEqual((await projectVectorSources([memory], [{ id: floor.id, assistantSeq: 1 }])).rawSources, [], '缺归档楼原文时不猜来源');
  assert.equal((await projectVectorSources([{ ...memory, summary: { effectiveSource: 'user', userText: '人工校准' } }], [floor])).rawSources.length, 1, '人工摘要仍使用既有原文来源资格');
  assert.deepEqual((await projectVectorSources([{ ...memory, sourceCanonicalContent: '' }], [floor])).rawSources, [], '明确空的专用原文不被回退覆盖');
  assert.deepEqual((await projectVectorSources([{ ...memory, sourceCanonicalContent: '矛盾的专用原文。' }], [floor])).rawSources, [], '专用来源与归档原文矛盾时不以归档正文覆盖');

  const snapshot = await projectVectorSources([{ ...memory, sourceFloorSnapshots: [{ floorId: floor.id, canonicalContent: floor.content.canonicalContent }] }], [floor]);
  assert.equal(snapshot.rawSources.length, 1); assert.equal(snapshot.rawSources[0].canonicalContent, floor.content.canonicalContent, '专用快照仍按原优先级使用');
  assert.deepEqual((await projectVectorSources([{ ...memory, sourceFloorSnapshots: [{ floorId: floor.id, canonicalContent: '' }] }], [floor])).rawSources, [], '明确空的楼快照继续排除');
  assert.deepEqual((await projectVectorSources([{ ...memory, sourceFloorSnapshots: [{ floorId: floor.id, canonicalContent: '旧的不同正文。' }] }], [floor])).rawSources, [], '明确不一致的楼快照继续排除');

  const aggregate = await projectVectorSources([{ ...memory, floorId: 'aggregate-anchor', sourceFloorIds: ['legacy-floor', 'aggregate-anchor'] }], [floor,
    { id: 'aggregate-anchor', assistantSeq: 2, content: { canonicalContent: '聚合锚点正文。' } }]);
  assert.deepEqual(aggregate.rawSources, [], '聚合楼缺成员专用快照时不跨楼回退');
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

test('搬家复用已验证的A向量分片并以B身份查询，正文见证仍指向冻结楼', async () => {
  const reachable = await vectorReachableFixture();
  const selected = selectRecallMemories(reachable);
  const sourceProjection = await projectVectorSources(selected.activeMemories, selected.floors, { includeSummaries: false });
  const source = { status: 'ready', chatId: reachable.root.chatId, narrativeGeneration: reachable.root.narrativeGeneration,
    headCheckpointId: reachable.root.headCheckpointId, rawSources: sourceProjection.rawSources };
  const records = new Map(), client = {
    async get(collection, id) {
      const value = records.get(`${collection}/${id}`);
      if (!value) throw Object.assign(new Error('not_found'), { status: 404 });
      return structuredClone(value);
    },
    async put(collection, id, data, revision) {
      const key = `${collection}/${id}`, prior = records.get(key);
      assert.equal(prior?.revision ?? 0, revision);
      const value = { revision: revision + 1, data: structuredClone(data) };
      records.set(key, value); return structuredClone(value);
    },
  };
  const api = { embed: async (_config, texts) => vectors(texts) };
  const sourceIndex = createVectorIndex({ client, api, configProvider: () => config,
    identityProvider: () => ({ chatId: source.chatId }), sourceProvider: async () => source });
  await sourceIndex.build();
  const targetId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', targetGeneration = 'generation-b';
  const shardIds = await sourceIndex.copyPrefix({ chatId: source.chatId }, { chatId: targetId }, targetGeneration, reachable);
  assert.ok(shardIds.length > 0);
  const targetReachable = { ...reachable, root: { ...reachable.root, chatId: targetId, narrativeGeneration: targetGeneration } };
  const targetSelected = selectRecallMemories(targetReachable);
  const targetRaw = await projectVectorSources(targetSelected.activeMemories, targetSelected.floors, { includeSummaries: false });
  const targetSource = { status: 'ready', chatId: targetId, narrativeGeneration: targetGeneration, rawSources: targetRaw.rawSources };
  const targetIndex = createVectorIndex({ client, api, configProvider: () => config,
    identityProvider: () => ({ chatId: targetId }), sourceProvider: async () => targetSource });
  const result = await targetIndex.query({ source: targetSource, queryContext: { text: '苹果配方' } });
  assert.ok(result.candidates.length > 0, 'B实际查询读取已复制的索引并命中旧原文');
  assert.equal(await rawWitnessValid(result.candidates[0].witness, targetSource), true);
  assert.equal(records.get(`chat-${targetId}/${VECTOR_INDEX_ID}`).data.narrativeGeneration, targetGeneration);
  assert.equal(records.get(`chat-${targetId}/${VECTOR_INDEX_ID}`).data.chatId, targetId);
});

test('全人工摘要楼按原文建立索引；摘要正文不进入 embedding 或新摘要候选路径', async () => {
  const source = await sourceFixture();
  const summary = summaryCandidateText('用户手工摘要只保留了钟楼与黄油信息。');
  const original = '小岚与闻溪原文谈到苹果配方，次日闻溪带来黄油，当前仍未烘焙。'.repeat(12);
  const raw = async (floorId, assistantSeq, floorMemoryId, canonicalContent) => ({ floorId, assistantSeq, floorMemoryId, memoryFloorId: floorId,
    memoryAssistantSeq: assistantSeq, canonicalContent, fingerprint: await hash(canonicalContent) });
  const original3 = '第三楼的原文保留了苹果派后续。';
  source.rawSources = [await raw('floor-1', 1, 'memory-1', '第一楼原始苹果线索。'), await raw('floor-2', 2, 'memory-2', original),
    await raw('floor-3', 3, 'memory-3', original3)];
  source.floorMemories[0].summary = '第一楼人工摘要与原文不同。';
  source.floorMemories[1] = { ...source.floorMemories[1], summary,
    chronology: [{ normalized: '2047-10-25T10:30', sourceText: '2047年10月25日10:30' }],
    participants: [{ entityId: 'person-xiaolan', name: '小岚' }, { entityId: 'person-wenxi', name: '闻溪' }],
    locations: [{ entityId: 'tower-id', participantEntityIds: ['person-xiaolan', 'person-wenxi'], name: '钟楼', change: '曾约定会合' }] };
  source.floorMemories[2].summary = '';
  source.summarySources = [{ sourceKind: 'userSummary', floorId: 'floor-2', assistantSeq: 2, floorMemoryId: 'memory-2',
    memoryFloorId: 'floor-2', memoryAssistantSeq: 2, canonicalContent: summary, fingerprint: await hash(summary) }];
  source.summarySources = [{ sourceKind: 'userSummary', floorId: 'floor-2', assistantSeq: 2, floorMemoryId: 'memory-2',
    memoryFloorId: 'floor-2', memoryAssistantSeq: 2, canonicalContent: summary, fingerprint: await hash(summary) }];
  const h = harness(source); let embedCalls = 0; const embedded = [];
  const index = createVectorIndex({ client: h.client, api: { embed: async (_config, texts) => { embedCalls++; embedded.push(...texts); return vectors(texts); } },
    configProvider: () => config, identityProvider: () => ({ chatId: source.chatId }), sourceProvider: async () => source });
  const built = await index.build();
  assert.ok(built.chunkCount > 0, '人工摘要来源楼仍按其原文建立索引');
  assert.equal(embedCalls, 1);
  const result = await index.query({ source, queryContext: { text: '苹果' }, eligibleFloorMemoryIds: ['memory-2'] });
  assert.ok(result.candidates.length > 0);
  assert.ok(result.candidates.every(value => value.witness && !value.summaryWitness && original.includes(value.text)));
  assert.ok(embedded.every(text => source.rawSources.some(value => value.canonicalContent.includes(text))), '只将多个人工摘要楼的当前合格原文发送给embedding模拟API');
  assert.ok(embedded.some(text => text.includes(original.slice(0, 20))) && embedded.some(text => text.includes(original3)));
  assert.equal(embedded.some(text => text.includes('钟楼与黄油信息')), false);
  const context = historySelectionContext(source, { text: '不存在的词', latestUserText: '不存在的词' });
  const enriched = addSemanticHistory(context, result.candidates);
  assert.ok(enriched.semantic.every(value => value.kind === 'sourceFragment'));
  assert.equal(enriched.semantic.some(value => value._semanticSummary), false);
  const ordinary = [...context.summaries, ...(context.recentSummaries ?? [])].find(value => value.floorMemoryId === 'memory-2');
  assert.ok(ordinary && ordinary.text.includes(summary), '普通摘要召回仍以人工保存摘要为权威');
});

test('人工摘要改写产生新FloorMemory ID时复用原文向量；原文变化或删源楼仍失效', async () => {
  const source = await sourceFixture();
  source.rawSources[0].canonicalContent = `${source.rawSources[0].canonicalContent} 原始证词仍在。`;
  source.rawSources[0].fingerprint = await hash(source.rawSources[0].canonicalContent);
  const h = harness(source); let embedCalls = 0;
  const api = { embed: async (_config, texts) => { embedCalls++; return vectors(texts); } };
  const index = createVectorIndex({ client: h.client, api, configProvider: () => config, identityProvider: () => ({ chatId: source.chatId }), sourceProvider: async () => source });
  await index.build();
  const first = await index.query({ source, queryContext: { text: '苹果' }, eligibleFloorMemoryIds: ['memory-1'] });
  assert.ok(first.candidates.length);
  const revised = structuredClone(source), oldId = revised.floorMemories[0].floorMemoryId;
  revised.floorMemories[0].floorMemoryId = 'memory-1-after-summary-edit';
  revised.floorMemories[0].summary = '用户把摘要改得更清楚';
  revised.rawSources[0].floorMemoryId = 'memory-1-after-summary-edit';
  const matched = await index.query({ source: revised, queryContext: { text: '苹果' }, eligibleFloorMemoryIds: ['memory-1-after-summary-edit'] });
  assert.ok(matched.candidates.length, '摘要revision换ID后旧向量仍能找到同一原文楼');
  assert.ok(matched.candidates.every(value => value.witness.floorMemoryId === 'memory-1-after-summary-edit'));
  assert.equal(await rawWitnessValid(matched.candidates[0].witness, revised), true, '新候选见证绑定当前FloorMemory ID');
  const cold = createVectorIndex({ client: h.client, api, configProvider: () => config, identityProvider: () => ({ chatId: source.chatId }) });
  const coldMatch = await cold.query({ source: revised, queryContext: { text: '苹果' }, eligibleFloorMemoryIds: ['memory-1-after-summary-edit'] });
  assert.ok(coldMatch.candidates.length && coldMatch.candidates.every(value => value.witness.floorMemoryId === 'memory-1-after-summary-edit'),
    '冷加载旧落盘向量也绑定当前有效记忆ID');
  const beforeRebuild = embedCalls;
  h.setSource(revised);
  const rebuilt = await index.build();
  assert.equal(rebuilt.chunkCount, first.candidates.length || rebuilt.chunkCount);
  assert.equal(embedCalls, beforeRebuild, '手动重建从热缓存复用原文向量，不重新嵌入摘要');

  const restored = structuredClone(revised);
  restored.floorMemories[0].floorMemoryId = 'memory-1-restored-ai';
  restored.floorMemories[0].summary = '恢复AI摘要';
  restored.rawSources[0].floorMemoryId = 'memory-1-restored-ai';
  assert.ok((await index.query({ source: restored, queryContext: { text: '苹果' }, eligibleFloorMemoryIds: ['memory-1-restored-ai'] })).candidates.length,
    '恢复AI摘要后原文来源继续有效');
  const editedBody = structuredClone(restored);
  editedBody.rawSources[0].canonicalContent += '真实正文新增证据。';
  editedBody.rawSources[0].fingerprint = await hash(editedBody.rawSources[0].canonicalContent);
  assert.deepEqual((await index.query({ source: editedBody, queryContext: { text: '苹果' }, eligibleFloorMemoryIds: ['memory-1-restored-ai'] })).candidates, [], '真实原文变化撤销旧片');
  const deletedFloor = { ...restored, rawSources: [] };
  assert.deepEqual((await index.query({ source: deletedFloor, queryContext: { text: '苹果' } })).candidates, [], '删除来源楼后不保留旧片');
});

test('旧summaryWitness回执读取有效，但不会进入新的语义候选池', async () => {
  const source = await sourceFixture(), summary = '人工只保留了与小狐狸有关的完整摘要。';
  source.floorMemories[1] = { ...source.floorMemories[1], summary,
    chronology: [{ normalized: '2047-10-25', sourceText: '2047年10月25日' }],
    participants: [{ entityId: 'fox-id', name: '小狐狸' }], locations: [{ entityId: 'tower-id', participantEntityIds: ['fox-id'], name: '钟楼', change: '曾经到访' }] };
  const context = historySelectionContext(source, { text: '星际灯塔', latestUserText: '星际灯塔' });
  const summaryCandidate = context.summaries.find(value => value.floorMemoryId === 'memory-2');
  assert.ok(summaryCandidate); assert.equal(summaryCandidate.score, 0, '这个摘要不靠BM25命中');
  const summaryWitness = { sourceKind: 'userSummary', floorId: 'floor-2', assistantSeq: 2, floorMemoryId: 'memory-2', memoryFloorId: 'floor-2',
    memoryAssistantSeq: 2, fingerprint: await hash(summary), offset: 0, length: summary.length, textFingerprint: await hash(summary) };
  const enriched = addSemanticHistory(context, [{ text: summary, summaryWitness, similarity: 0.92 }]);
  assert.deepEqual(enriched.semantic, [], '历史摘要候选不作为新候选消费');
  const native = buildRecallHistoryCandidatePool({ source, queryContext: { text: '星际灯塔', latestUserText: '星际灯塔' }, historyContext: context });
  const pool = mergeSemanticHistoryPool(native, enriched);
  assert.equal(pool.candidates.some(value => value.value.summaryWitness), false);
  assert.ok(context.summaries.some(value => value.floorMemoryId === 'memory-2' && value.text === summary), '普通摘要仍由现有路径提供');
});

test('旧人工摘要only索引可读取但零候选/零查询API；同文混合缓存只用原文行', async () => {
  const summary = '苹果派的配方是六百克苹果和一百克黄油。这是当时的计划，尚未烤制。';
  const summarySource = { sourceKind: 'userSummary', floorId: 'floor-1', assistantSeq: 1, floorMemoryId: 'memory-1', memoryFloorId: 'floor-1',
    memoryAssistantSeq: 1, canonicalContent: summary, fingerprint: await hash(summary) };
  const oldWitness = { ...summarySource, offset: 0, length: summary.length, textFingerprint: await hash(summary) };
  const vector = Buffer.from(new Float32Array([1, 0]).buffer).toString('base64');
  const shardId = `${VECTOR_SHARD_PREFIX}${'a'.repeat(40)}`;
  const modelKey = await hash(JSON.stringify([config.url, config.model, config.dimensions]));
  const seedOldIndex = async (h, includeSameRawRow = false) => {
    const rawWitness = { floorId: 'floor-1', assistantSeq: 1, floorMemoryId: 'memory-1', memoryFloorId: 'floor-1', memoryAssistantSeq: 1,
      fingerprint: await hash(summary), offset: 0, length: summary.length, textFingerprint: await hash(summary) };
    h.records.set(VECTOR_INDEX_ID, { recordId: VECTOR_INDEX_ID, revision: 1, data: { schemaVersion: 1, recordType: 'vectorCache',
      chatId: 'chat', narrativeGeneration: 'generation', modelKey, dimensions: 2, shardIds: [shardId], chunkCount: 1 } });
    h.records.set(shardId, { recordId: shardId, revision: 1, data: { schemaVersion: 1, recordType: 'vectorCache',
      chatId: 'chat', narrativeGeneration: 'generation', modelKey, rows: [{ witness: oldWitness, vector }, ...(includeSameRawRow ? [{ witness: rawWitness, vector }] : [])] } });
  };

  const manualOnly = await sourceFixture(); manualOnly.rawSources = []; manualOnly.summarySources = [summarySource];
  const oldOnly = harness(manualOnly); await seedOldIndex(oldOnly); let oldOnlyCalls = 0;
  const oldOnlyReader = createVectorIndex({ client: oldOnly.client, api: { embed: async (_config, texts) => { oldOnlyCalls++; return vectors(texts); } },
    configProvider: () => config, identityProvider: () => ({ chatId: 'chat' }) });
  const empty = await oldOnlyReader.query({ source: manualOnly, queryContext: { text: '苹果' }, eligibleFloorMemoryIds: ['memory-2'] });
  assert.deepEqual(empty.candidates, []); assert.equal(empty.diagnostic.status, 'unindexed'); assert.equal(oldOnlyCalls, 0);

  const mixed = await sourceFixture(); mixed.summarySources = [summarySource];
  const mixedCache = harness(mixed); await seedOldIndex(mixedCache, true); let mixedCalls = 0;
  const mixedReader = createVectorIndex({ client: mixedCache.client, api: { embed: async (_config, texts) => { mixedCalls++; return vectors(texts); } },
    configProvider: () => config, identityProvider: () => ({ chatId: 'chat' }) });
  const result = await mixedReader.query({ source: mixed, queryContext: { text: '苹果' }, eligibleFloorMemoryIds: ['memory-1', 'memory-2'] });
  assert.ok(result.candidates.length); assert.ok(result.candidates.every(value => value.witness && !value.summaryWitness));
  assert.ok(result.candidates.every(value => value.witness.floorId === 'floor-1'), '混合旧缓存只使用原文来源行');
  assert.equal(mixedCalls, 1, '混合旧缓存仍只按一次原文查询请求');

  const rebuildCache = harness(mixed); await seedOldIndex(rebuildCache); let rebuildCalls = 0;
  const rebuilder = createVectorIndex({ client: rebuildCache.client, api: { embed: async (_config, texts) => { rebuildCalls++; return vectors(texts); } },
    configProvider: () => config, identityProvider: () => ({ chatId: 'chat' }), sourceProvider: async () => mixed });
  await rebuilder.build();
  assert.ok(rebuildCalls > 0, '即使旧人工摘要与原文完全同文，也不复用其摘要向量行');
  const rewrittenRows = rebuildCache.records.get(VECTOR_INDEX_ID).data.shardIds.flatMap(id => rebuildCache.records.get(id).data.rows);
  assert.ok(rewrittenRows.length && rewrittenRows.every(row => row.witness.sourceKind === undefined));
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

test('冷读期间模型或生命周期变更，旧读取按配置或显式重置处理', async () => {
  for (const action of ['model', 'epoch']) {
    const source = await sourceFixture(), h = harness(source); await h.index.build();
    let finish, entered, calls = 0, route = config;
    const started = new Promise(resolve => { entered = resolve; });
    const index = createVectorIndex({ client: { ...h.client, get: async (...args) => {
      if (args[1] === VECTOR_INDEX_ID) await new Promise(resolve => { finish = resolve; entered(); });
      return h.client.get(...args);
    } }, api: { embed: async (_config, texts) => { calls++; return vectors(texts); } },
      configProvider: () => route, identityProvider: () => ({ chatId: source.chatId }) });
    const pending = index.query({ source, queryContext: { text: '苹果' } }); await started;
    if (action === 'model') route = { ...config, model: 'other' };
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

test('不同聊天或纪元的来源不复用其他来源缓存；人工摘要撤来源后无旧命中', async () => {
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

test('构建期间来源被人工改掉时不提交旧索引', async () => {
  const source = await sourceFixture(), h = harness(source);
  let finish, entered, current = source; const started = new Promise(resolve => { entered = resolve; });
  const api = { embed: async () => new Promise(resolve => { finish = resolve; entered(); }) };
  const index = createVectorIndex({ client: h.client, api, configProvider: () => config,
    identityProvider: () => ({ chatId: source.chatId }), sourceProvider: async () => current });
  const build = index.build(); await started;
  current = { ...source, rawSources: [] };
  finish([[1, 0]]); await assert.rejects(build);
  assert.equal(h.records.has(VECTOR_INDEX_ID), false);
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
    if (options.onDiagnostic && options.timeoutMs === 15000) {
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

test('首个deadline边界遇到真实配置变更时不补发', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const change of ['config']) {
    const source = await sourceFixture(); let calls = 0, hold = false, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const api = createVectorApiClient({ fetchImpl: (_url, options) => {
      calls++; if (hold) return new Promise(() => entered());
      const input = JSON.parse(options.body).input;
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: vectors(input).map((embedding, index) => ({ index, embedding })) }) });
    } });
    const h = harness(source, { api }); await h.index.build(); hold = true;
    const pending = h.index.query({ source, queryContext: { text: '苹果' }, signal: new AbortController().signal }); await started;
    h.setConfig({ ...config, model: 'changed-model' });
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
