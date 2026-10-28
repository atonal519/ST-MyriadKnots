import { readTimeBody } from '../src/v3/time-body.js';
import { replayTimeBatches } from '../src/v3/time-engine.js';
import { createPeopleWorkspaceRuntime } from '../src/v3/people-workspace.js';
import { PEOPLE_PROFILE_FIELDS } from '../src/v3/people-profile-fields.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTransfer, parseMemoryPackage, transferWitness } from '../src/memory-transfer.js';
import { createFoundationStore } from '../src/v3/foundation-store.js';
import { createFoundationRuntime } from '../src/v3/foundation-runtime.js';
import { createV3MemoryRuntime } from '../src/v3/memory-runtime.js';
import { createHostAdapter } from '../src/v3/host-adapter.js';
import { createChatSession } from '../src/chat-session.js';
import { createChatIdentityCoordinator } from '../src/chat-identity.js';
import { EXTRACTOR_SYSTEM_PROMPT } from '../src/v3/extractor.js';
import { sha256 } from '../src/identity.js';
import { stableJson } from '../src/memory-transfer-json.js';
import { writeMemoryBundle } from '../src/memory-transfer-bundle.js';
import { MEMORY_VOLUME_BYTES } from '../src/memory-transfer-volumes.js';
import { createTimeRuntime, createTimeStore } from '../src/v3/time-runtime.js';
import { createMigrationDescriptor } from '../src/v3/migration-prefix.js';
import { createPeopleWorkspaceStore } from '../src/v3/people-workspace.js';
const SOURCE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = '2026-09-05T00:00:00.000Z';
const assistant = mes => ({ is_user: false, is_system: false, mes, swipes: [mes], swipe_id: 0 });
const user = mes => ({ is_user: true, is_system: false, mes, send_date: `test-user:${mes}` });
const uuidFactory = () => { let value = 1000; return () => `${(++value).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`; };

function backendHarness() {
  const records = new Map();
  const calls = [];
  const failure = status => Object.assign(new Error(`HTTP ${status}`), { status });
  const envelope = (data, revision) => ({ revision, data: structuredClone(data), createdAt: NOW, updatedAt: NOW });
  const client = {
    async list(collection) { return [...records].filter(([key]) => key.startsWith(`${collection}/`)).map(([key, value]) => ({ recordId: key.slice(collection.length + 1), ...envelope(value.data, value.revision) })); },
    async get(collection, key) {
      calls.push(['get', collection, key]);
      const value = records.get(`${collection}/${key}`);
      if (!value) throw failure(404);
      return envelope(value.data, value.revision);
    },
    async getMany(collection, recordIds) {
      calls.push(['getMany', collection, recordIds]);
      return recordIds.map(recordId => {
        const value = records.get(`${collection}/${recordId}`);
        return value ? { recordId, status: 200, envelope: envelope(value.data, value.revision) }
          : { recordId, status: 404 };
      });
    },
    async put(collection, key, data, expectedRevision) {
      calls.push(['put', collection, key]);
      const mapKey = `${collection}/${key}`;
      const previous = records.get(mapKey);
      if ((previous?.revision ?? 0) !== expectedRevision) throw failure(409);
      const revision = (previous?.revision ?? 0) + 1;
      records.set(mapKey, { revision, data: structuredClone(data) });
      return envelope(data, revision);
    },
  };
  return { records, calls, client };
}

const TARGET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const IMPORTED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
async function fixture({ excluded = false, body = '她把钥匙放进木盒。', wrappers = {}, chat = null, extractIndex = 0, transferOptions = {} } = {}) {
  const backend = backendHarness();
  let currentWrappers = wrappers;
  const sanitizerOptions = () => currentWrappers;
  const ctx = context('old-chat', SOURCE, chat ?? [user('旧档开场'), assistant(body), user('继续'), assistant('最新一楼'), user('钥匙呢？')]);
  if (excluded) ctx.chat[3].extra = { qianqianjie_memory_excluded: true };
  let selected = ctx;
  const host = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => selected } } });
  const store = createFoundationStore({ client: backend.client, contextProvider: () => identity(ctx.chatId, SOURCE) });
  const foundation = createFoundationRuntime({ hostAdapter: host, store, contextProvider: () => ctx, sanitizerOptions, newUuid: uuidFactory(), logger: { warn() {} } });
  await foundation.start();
  const memory = createV3MemoryRuntime({ foundationRuntime: foundation, store, hostAdapter: host, sanitizerOptions,
    automationSettings: () => ({ enabled: false, batchSize: 1 }), newUuid: uuidFactory(), logger: { warn() {} },
    generateAnalysisTask: async () => ({ jsonData: { noMaterialChange: true } }),
    generateUtilityTask: async options => ({ jsonData: options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT ? { summary: '钥匙在木盒里。' } : { noMaterialChange: true } }) });
  await memory.start();
  await memory.extractFloor(memory.getState().floors[extractIndex].floorId, { analyzeState: false });
  await memory.analyzeNextState();
  const graph = await store.readReachable({ mode: 'full' });
  const coordinator = createChatIdentityCoordinator({ client: backend.client });
  await backend.client.put('chat-identity-bindings', `binding-${SOURCE}`, { schemaVersion: 1, kind: 'qqj-chat-identity-binding', chatId: SOURCE,
    owner: { hostChatId: ctx.chatId, characterLocator: 'character.png', personaLocator: 'persona.png' }, state: 'ready', sourceChatId: null, createdAt: NOW, updatedAt: NOW }, 0);
  // A real session checks the new binding on import; no mocked identity acceptance.
  const session = createChatSession({ contextProvider: () => selected, identityCoordinator: coordinator });
  await session.prepare();
  let api = targetChatApi(selected);
  const runtime = createMemoryTransfer({ client: backend.client, session, hostAdapter: host, sanitizerOptions, freshUuid: () => IMPORTED, ...transferOptions,
    fetchImpl: (...args) => api.fetch(...args), onSettled: async options => {
      session.invalidate(); await session.prepare(); await transferOptions.onSettled?.(options);
    } });
  const exported = await runtime.exportCurrent();
  return { backend, ctx, host, graph, memory, foundation, store, runtime, exported, session,
    async target({ changed = false, savedQqj = null } = {}) {
      selected = context('imported-chat', TARGET, structuredClone(ctx.chat), 'updated-avatar.png');
      selected.name2 = '新版角色'; selected.characters[0].name = '新版角色'; selected.characters[0].data.description = '作者更新后的设定';
      if (changed) selected.chat[1].mes = '改写的正文';
      if (savedQqj) { selected.chatMetadata.qianqianjie = structuredClone(savedQqj); api = targetChatApi(selected); }
      await session.prepare(); if (!savedQqj) api = targetChatApi(selected); return selected;
    }, get api() { return api; }, setApi(value) { api = value; }, select(value) { selected = value; }, setWrappers(value) { currentWrappers = value; },
  };
}

function streamingFixture(f) {
  const list = f.backend.client.list, scans = [];
  f.backend.client.iterRecords = async function* (collection, options = {}) {
    scans.push({ collection, options });
    assert.equal(options.requireStreaming, true, 'large transfers require the bounded backend iterator');
    for (const record of await list(collection)) yield record;
  };
  f.backend.client.list = async () => assert.fail('volume transfer must not load a whole collection');
  return scans;
}
async function volumeFiles(runtime, options = { partBytes: 4096 }) {
  const files = [];
  for await (const output of runtime.exportVolumes(options)) {
    const file = new File([output.blob], output.filename);
    if (!output.manifest) file.text = () => assert.fail('binary volumes must be read by bounded byte ranges');
    files.push(file);
  }
  assert.ok(files.at(-1).name.endsWith('.qqj-memory.index.json'), 'the final file seals the completed archive');
  return files;
}

test('volume export validates the tail in bounded batches and reports every finishing phase before its manifest', async () => {
  const chat = [user('开始')];
  for (let index = 0; index < 130; index++) chat.push(assistant(`第${index + 1}份记录。`), user(`继续${index}`));
  const f = await fixture({ chat }); streamingFixture(f);
  const progress = [], before = structuredClone([...f.backend.records]);
  f.backend.calls.length = 0;
  const files = await volumeFiles(f.runtime, { partBytes: 512, onProgress: value => progress.push(value) });
  const batches = f.backend.calls.filter(call => call[0] === 'getMany');
  assert.ok(batches.some(call => call[2].length === 64), 'tail graph validation must use the existing batch API');
  for (const [, collection, ids] of batches) {
    assert.ok(ids.length <= 64);
    const rawBytes = ids.reduce((sum, id) => sum + Buffer.byteLength(JSON.stringify(f.backend.records.get(`${collection}/${id}`).data)), 0);
    assert.ok(rawBytes <= MEMORY_VOLUME_BYTES);
  }
  assert.deepEqual([...new Set(progress.map(value => value.phase))], ['records', 'graph', 'auxiliary', 'conversation', 'avatars', 'verify', 'manifest']);
  assert.ok(progress.some(value => value.phase === 'graph' && value.completed >= 130));
  assert.ok(progress.some(value => value.phase === 'verify' && value.completed > 0));
  assert.deepEqual(progress.at(-1), { phase: 'manifest', completed: 1, total: 1 });
  for (const value of progress) assert.ok(Number.isSafeInteger(value.completed) && value.completed >= 0
    && (value.total === null || Number.isSafeInteger(value.total) && value.total >= 0));
  assert.deepEqual([...f.backend.records], before, 'export validation never writes formal records');
  const manifest = await files.at(-1).text(); assert.doesNotMatch(manifest, /onProgress/);
  const plan = await f.runtime.previewVolumes(files); assert.equal(plan.messages, chat.length);
});

test('volume graph batches account for UTF8 bytes and read an oversized record alone', async () => {
  const chat = [user('开始'), assistant('已记忆的小楼。'), user('继续')];
  for (const count of [1500000, 1500000, 3000000]) chat.push(assistant('甲'.repeat(count)), user('继续下一楼'));
  const f = await fixture({ chat }); streamingFixture(f);
  const floorIds = f.graph.floors.slice(1).map(floor => `v3-floor-${floor.id}`);
  const sizes = new Map(floorIds.map(id => [id, Buffer.byteLength(JSON.stringify(f.backend.records.get(`chat-${SOURCE}/${id}`).data))]));
  assert.ok(sizes.get(floorIds[0]) < MEMORY_VOLUME_BYTES && sizes.get(floorIds[0]) * 2 > MEMORY_VOLUME_BYTES);
  assert.ok(sizes.get(floorIds[2]) > MEMORY_VOLUME_BYTES);
  const batchRead = f.backend.client.getMany;
  f.backend.client.getMany = async (collection, ids, options) => {
    assert.ok(ids.length <= 64);
    assert.ok(ids.reduce((sum, id) => sum + Buffer.byteLength(JSON.stringify(f.backend.records.get(`${collection}/${id}`).data)), 0) <= MEMORY_VOLUME_BYTES);
    assert.equal(ids.includes(floorIds[2]), false, 'a single record larger than one volume must not enter getMany');
    return batchRead(collection, ids, options);
  };
  f.backend.calls.length = 0;
  let manifest = false;
  for await (const file of f.runtime.exportVolumes()) if (file.manifest) manifest = true;
  assert.equal(manifest, true);
  const batches = f.backend.calls.filter(call => call[0] === 'getMany');
  assert.ok(batches.some(call => call[2].includes(floorIds[0])));
  assert.ok(batches.some(call => call[2].includes(floorIds[1])));
  assert.equal(batches.some(call => call[2].includes(floorIds[0]) && call[2].includes(floorIds[1])), false);
  assert.equal(f.backend.calls.filter(call => call[0] === 'get' && call[2] === floorIds[2]).length, 1);
});

test('volume export still rejects a new auxiliary record discovered in its second complete scan', async () => {
  const f = await fixture(), list = f.backend.client.list, progress = [];
  let scans = 0, manifest = false;
  f.backend.client.iterRecords = async function* (collection) {
    scans++;
    if (scans === 2) {
      const id = 'v3-time-batch-dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      f.backend.records.set(`${collection}/${id}`, { revision: 1, data: { schemaVersion: 1, chatId: SOURCE, id, changes: [] } });
    }
    yield* await list(collection);
  };
  await assert.rejects(async () => {
    for await (const file of f.runtime.exportVolumes({ partBytes: 512, onProgress: value => progress.push(value) })) manifest ||= file.manifest;
  }, /导出期间记忆发生变化/);
  assert.equal(scans, 2); assert.equal(manifest, false);
  assert.ok(progress.some(value => value.phase === 'verify'));
  assert.equal(f.runtime.getState().active, false);
});

test('volume export cancels an in-flight graph batch and releases its captured session', async () => {
  const f = await fixture(); streamingFixture(f);
  const original = f.backend.client.getMany;
  let announce;
  const started = new Promise(resolve => { announce = resolve; });
  f.backend.client.getMany = async (collection, ids, { signal }) => {
    if (ids.length === 1 && ids[0] === 'v3-root') return original(collection, ids);
    announce();
    await new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const iterator = f.runtime.exportVolumes({ partBytes: 512 });
  const consuming = (async () => { for await (const unused of iterator) {} })();
  const rejected = assert.rejects(consuming, error => error.name === 'AbortError');
  await started; await iterator.return(); await rejected;
  assert.equal(f.runtime.getState().active, false); assert.equal(f.session.identity().chatId, SOURCE);
});

test('volume graph batches preserve missing, HTTP, transport and revision-change failures without a manifest', async t => {
  for (const fault of ['missing', 'http', 'transport', 'revision']) await t.test(fault, async () => {
    const f = await fixture(); streamingFixture(f);
    const original = f.backend.client.getMany, before = structuredClone([...f.backend.records]);
    const failure = new Error('batch transport failed'); let reads = 0, manifest = false;
    f.backend.client.getMany = async (...args) => {
      if (args[1].length === 1 && args[1][0] === 'v3-root') return original(...args);
      reads++;
      if (fault === 'transport') throw failure;
      const results = await original(...args);
      if (fault === 'revision') results[0].envelope.revision++;
      else results[0] = { recordId: results[0].recordId, status: fault === 'missing' ? 404 : 500 };
      return results;
    };
    await assert.rejects(async () => {
      for await (const file of f.runtime.exportVolumes({ partBytes: 512 })) manifest ||= file.manifest;
    }, error => fault === 'transport' ? error === failure : fault === 'revision'
      ? /导出期间记忆发生变化/.test(error.message) : error.status === (fault === 'missing' ? 404 : 500));
    assert.equal(reads, 1, 'a failed graph batch is not retried or reread through single GET');
    assert.equal(manifest, false); assert.equal(f.runtime.getState().active, false); assert.equal(f.api.saves, 0);
    assert.deepEqual([...f.backend.records], before);
  });
});

test('batched and legacy single-read volume exports are byte-identical after manual summary and prequel edits', async () => {
  const f = await fixture({ transferOptions: { now: () => new Date(NOW) } }); streamingFixture(f);
  await f.memory.editSummary(f.memory.getState().floors[0].floorId, '用户手改：钥匙仍在衣袋中。');
  f.ctx.chatMetadata.qianqianjiePrequel = '用户手填的前情'; f.api.reloadFromContext();
  const before = structuredClone([...f.backend.records]), options = { partBytes: 512 };
  const batched = await volumeFiles(f.runtime, options), getMany = f.backend.client.getMany;
  delete f.backend.client.getMany;
  let legacy;
  try { legacy = await volumeFiles(f.runtime, options); }
  finally { f.backend.client.getMany = getMany; }
  assert.deepEqual(batched.map(file => file.name), legacy.map(file => file.name));
  for (let index = 0; index < batched.length; index++) {
    assert.deepEqual(new Uint8Array(await batched[index].arrayBuffer()), new Uint8Array(await legacy[index].arrayBuffer()));
  }
  assert.deepEqual([...f.backend.records], before, 'both paths keep all source records and manual fields unchanged');
});

test('单文件流式包经正式runtime预览导入和撤销，保留人工摘要与前情', async () => {
  const f = await fixture(); streamingFixture(f);
  const floorId = f.memory.getState().floors[0].floorId;
  await f.memory.editSummary(floorId, '用户手填：钥匙在衣袋中。');
  f.ctx.chatMetadata.qianqianjiePrequel = '手动前情'; f.api.reloadFromContext();
  const chunks = []; let closed = false;
  const metadata = await writeMemoryBundle(f.runtime.exportVolumes({ partBytes: 512 }), {
    async write(blob) { chunks.push(blob); }, async close() { closed = true; }, async abort() { assert.fail('完整导出不能中止'); },
  });
  assert.equal(closed, true);
  const file = new File(chunks, metadata.filename);
  assert.match(file.name, /\.qqj-memory$/);
  file.arrayBuffer = () => assert.fail('预览不得读取整个大文件');
  file.text = () => assert.fail('预览不得把大文件读成文本');
  const before = structuredClone(f.ctx.chat);
  const plan = await f.runtime.previewVolumes([file]);
  await f.runtime.importPreview(plan);
  assert.equal(f.ctx.chatMetadata.qianqianjiePrequel, '手动前情');
  assert.deepEqual(f.ctx.chat.map(message => message.mes), before.map(message => message.mes));
  const restoredSummary = [...f.backend.records.values()].map(record => record.data)
    .find(record => record.chatId === IMPORTED && record.recordType === 'floorMemory');
  assert.equal(restoredSummary.summary.userText, '用户手填：钥匙在衣袋中。');
  await f.runtime.undo();
  assert.equal(f.ctx.chatMetadata.qianqianjie.chatId, SOURCE);
  assert.equal(f.ctx.chatMetadata.qianqianjiePrequel, '手动前情');
});

test('volume runtime round trip streams records and preserves memory, time, people, vectors and host fields', async () => {
  const calendars = new Map([[SOURCE, { months: 4, prefix: '测试历' }], [TARGET, { months: 12, prefix: '旧历' }]]);
  const f = await fixture({ excluded: true, transferOptions: { captureCalendar: id => calendars.get(id) ?? null,
    persistCalendar: async (id, calendar) => calendars.set(id, calendar) } }), scans = streamingFixture(f);
  f.ctx.chat[1].extra ??= {}; f.ctx.chat[1].extra.variables = { keeps: 'source variable' };
  f.ctx.chatMetadata.qianqianjiePrequel = '手动前情';
  f.api.reloadFromContext();
  const people = { schemaVersion: 3, kind: 'qqj-v3-people-workspace', chatId: SOURCE,
    selectedEntityIds: [], personOrderEntityIds: [], profilesByEntityId: {}, avatarsByEntityId: {}, avatarSourcesByEntityId: {},
    identityRedirectsByEntityId: {}, deletedEntityIds: [], profileMaterialProgressByEntityId: {}, createdAt: NOW, updatedAt: NOW };
  const batchId = 'v3-time-batch-dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  await f.backend.client.put(`chat-${SOURCE}`, 'v3-people-workspace', people, 0);
  await f.backend.client.put(`chat-${SOURCE}`, batchId, { schemaVersion: 1, chatId: SOURCE, id: batchId, changes: [] }, 0);
  await f.backend.client.put(`chat-${SOURCE}`, 'v3-time-head', { schemaVersion: 1, chatId: SOURCE, batchIds: [batchId], bodyStart: 0 }, 0);
  await f.backend.client.put(`chat-${SOURCE}`, 'qqj-vector-index', { schemaVersion: 1, recordType: 'vectorCache', chatId: SOURCE,
    narrativeGeneration: f.graph.root.narrativeGeneration, modelKey: `sha256:${'a'.repeat(64)}`, dimensions: 1024, shardIds: [], chunkCount: 0 }, 0);
  const before = structuredClone([...f.backend.records]);
  const files = await volumeFiles(f.runtime); assert.ok(files.length > 2);
  assert.deepEqual([...f.backend.records], before, 'export is read-only');
  const target = await f.target(); target.chatMetadata.otherPlugin = { keep: true }; f.api.reloadFromContext();
  const preview = await f.runtime.previewVolumes(files);
  assert.equal(preview.messages, target.chat.length); assert.equal(preview.summaries, 1); assert.equal(preview.states, 1);
  assert.equal(f.api.saves, 0);
  const result = await f.runtime.importPreview(preview);
  assert.equal(result.chatId, IMPORTED); assert.equal(f.session.identity().chatId, IMPORTED);
  assert.equal(target.chatMetadata.qianqianjiePrequel, '手动前情');
  assert.deepEqual(calendars.get(IMPORTED), { months: 4, prefix: '测试历' });
  assert.deepEqual(target.chatMetadata.otherPlugin, { keep: true });
  assert.deepEqual(target.chat[1].extra.variables, { keeps: 'source variable' });
  assert.equal(target.chat[3].extra.qianqianjie_memory_excluded, true);
  for (const id of ['v3-people-workspace', batchId, 'v3-time-head', 'qqj-vector-index']) {
    const original = f.backend.records.get(`chat-${SOURCE}/${id}`).data;
    assert.deepEqual(f.backend.records.get(`chat-${IMPORTED}/${id}`).data, { ...original, chatId: IMPORTED });
  }
  const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const cold = createFoundationRuntime({ hostAdapter: f.host, store, contextProvider: () => target, newUuid: uuidFactory(), logger: { warn() {} } });
  assert.equal((await cold.start()).status, 'ready');
  const restored = await store.readReachable({ mode: 'full' });
  assert.deepEqual(restored.floorMemories.map(item => item.summary), f.graph.floorMemories.map(item => item.summary));
  assert.deepEqual(restored.stateDeltas.map(item => item.id), f.graph.stateDeltas.map(item => item.id));
  assert.equal(f.backend.records.get(`chat-${IMPORTED}/self-use-memory-transfer-rollback-v1`).data.streaming, true);
  await f.runtime.undo(); assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET);
  assert.deepEqual(calendars.get(TARGET), { months: 12, prefix: '旧历' });
  assert.ok(scans.some(scan => scan.collection === `chat-${IMPORTED}`), 'new-copy and undo checks use the same bounded iterator');
});

test('volume runtime preserves avatar bytes and crops while uploading shared originals once', async () => {
  const f = await fixture(); streamingFixture(f);
  const personId = '33333333-3333-4333-8333-333333333333';
  const originalPath = '/user/images/qqj-avatars/qqj-avatar-volume-source.png';
  const newPath = '/user/images/qqj-avatars/qqj-avatar-volume-imported.png';
  const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 255, 128, 17]);
  const crop = { aspectRatio: 1, zoom: 1.2, offsetX: 0.1, offsetY: -0.1 }, thumbnail = 'data:image/png;base64,iVBORw0KGgo=';
  const workspace = { schemaVersion: 3, kind: 'qqj-v3-people-workspace', chatId: SOURCE,
    selectedEntityIds: [personId], personOrderEntityIds: [personId], profilesByEntityId: {},
    avatarsByEntityId: { [personId]: thumbnail }, avatarSourcesByEntityId: { [personId]: { path: originalPath, mimeType: 'image/png', crop } },
    identityRedirectsByEntityId: {}, deletedEntityIds: [], profileMaterialProgressByEntityId: {}, createdAt: NOW, updatedAt: NOW };
  const snapshotId = 'v3-people-snapshot-44444444-4444-4444-8444-444444444444';
  await f.backend.client.put(`chat-${SOURCE}`, 'v3-people-workspace', workspace, 0);
  await f.backend.client.put(`chat-${SOURCE}`, snapshotId, { schemaVersion: 1, kind: 'qqj-v3-frozen-people-snapshot', chatId: SOURCE, sourceChatId: SOURCE, workspace: structuredClone(workspace) }, 0);
  const images = new Map([[originalPath, imageBytes]]), uploads = [];
  const withImages = api => ({ ...api, async fetch(url, options = {}) {
    if (images.has(url)) return { ok: true, async arrayBuffer() { return images.get(url).slice().buffer; } };
    if (url === '/api/images/upload') {
      const bytes = Uint8Array.from(atob(JSON.parse(options.body).image), char => char.charCodeAt(0));
      uploads.push(bytes); images.set(newPath, bytes); return { ok: true, async json() { return { path: newPath }; } };
    }
    return api.fetch(url, options);
  } });
  f.setApi(withImages(f.api)); const files = await volumeFiles(f.runtime);
  await f.target(); f.setApi(withImages(f.api));
  await f.runtime.importPreview(await f.runtime.previewVolumes(files));
  assert.equal(uploads.length, 1); assert.deepEqual(uploads[0], imageBytes);
  for (const id of ['v3-people-workspace', snapshotId]) {
    const value = f.backend.records.get(`chat-${IMPORTED}/${id}`).data, people = value.workspace ?? value;
    assert.equal(people.chatId, IMPORTED); assert.equal(people.avatarsByEntityId[personId], thumbnail);
    assert.deepEqual(people.avatarSourcesByEntityId[personId], { path: newPath, mimeType: 'image/png', crop });
  }
});

test('volume runtime undo retains imported auxiliary edits and cancellation releases the captured session', async () => {
  const f = await fixture(); streamingFixture(f);
  const timeStore = createTimeStore({ client: f.backend.client });
  await timeStore.putHead(SOURCE, { schemaVersion: 1, chatId: SOURCE, batchIds: [] }, 0);
  const cancelled = f.runtime.exportVolumes({ partBytes: 1024 });
  assert.equal((await cancelled.next()).done, false); assert.equal(f.runtime.getState().active, true);
  await cancelled.return(); assert.equal(f.runtime.getState().active, false); assert.equal(f.session.identity().chatId, SOURCE);
  const files = await volumeFiles(f.runtime), target = await f.target();
  await f.runtime.importPreview(await f.runtime.previewVolumes(files));
  const beforeRoot = structuredClone(f.backend.records.get(`chat-${IMPORTED}/v3-root`));
  const head = f.backend.records.get(`chat-${IMPORTED}/v3-time-head`);
  await timeStore.putHead(IMPORTED, { ...head.data, bodyStart: 1 }, head.revision);
  const before = structuredClone([...f.backend.records]), saves = f.api.saves;
  await assert.rejects(f.runtime.undo(), /导入后的.*已变化/);
  assert.deepEqual(f.backend.records.get(`chat-${IMPORTED}/v3-root`), beforeRoot);
  assert.equal(target.chatMetadata.qianqianjie.chatId, IMPORTED); assert.equal(f.api.saves, saves);
  assert.deepEqual([...f.backend.records], before);
});

test('volume runtime cancellation aborts an in-flight backend read before releasing the session', async () => {
  const f = await fixture(); streamingFixture(f);
  let announce;
  const started = new Promise(resolve => { announce = resolve; });
  f.backend.client.iterRecords = async function* (_collection, { signal, requireStreaming }) {
    assert.equal(requireStreaming, true); assert.ok(signal);
    announce();
    await new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const exporting = f.runtime.exportVolumes(), pending = exporting.next();
  const rejected = assert.rejects(pending, error => error.name === 'AbortError');
  await started; await exporting.return(); await rejected;
  assert.equal(f.runtime.getState().active, false); assert.equal(f.session.identity().chatId, SOURCE);
  assert.equal(f.api.saves, 0);
});

test('volume runtime rejects missing or mixed volumes and changed chat without publishing memory', async t => {
  for (const change of ['missing', 'mixed', 'chat']) await t.test(change, async () => {
    const f = await fixture(); streamingFixture(f);
    let files = await volumeFiles(f.runtime); const target = await f.target();
    if (change === 'missing') files = files.filter((_, index) => index !== 0);
    if (change === 'mixed') {
      const replacement = new Uint8Array(await files[0].arrayBuffer()); replacement[0] ^= 1;
      files[0] = new File([replacement], files[0].name);
    }
    if (change === 'chat') { target.chat[1].mes = '另一份正文'; f.api.reloadFromContext(); }
    const before = structuredClone([...f.backend.records]);
    await assert.rejects(f.runtime.previewVolumes(files));
    assert.deepEqual([...f.backend.records], before); assert.equal(f.api.saves, 0);
    assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET);
  });
});

test('volume runtime rechecks cleaning settings and failed staging keeps the current chat intact', async t => {
  for (const change of ['wrappers', 'write']) await t.test(change, async () => {
    const wrappers = { keepTags: 'scene', extraTags: 'thinking' };
    const f = await fixture({ body: '<scene>她把钥匙放进木盒。</scene><thinking>思考内容</thinking>', wrappers });
    streamingFixture(f);
    const files = await volumeFiles(f.runtime), target = await f.target();
    const plan = await f.runtime.previewVolumes(files);
    if (change === 'wrappers') f.setWrappers({});
    if (change === 'write') {
      const put = f.backend.client.put;
      f.backend.client.put = async (...args) => { if (args[0] === `chat-${IMPORTED}` && args[1].startsWith('v3-floor-memory-')) throw new Error('test write failed'); return put(...args); };
    }
    await assert.rejects(f.runtime.importPreview(plan));
    assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET); assert.equal(f.api.saves, 0);
    await assert.rejects(f.runtime.importPreview(plan), /预览已失效/);
  });
});

test('volume runtime rechecks bytes after preview before any import write', async () => {
  const f = await fixture(); streamingFixture(f);
  const files = await volumeFiles(f.runtime), target = await f.target();
  const plan = await f.runtime.previewVolumes(files), part = files.find(file => !file.name.endsWith('.json'));
  const originalArrayBuffer = part.arrayBuffer.bind(part);
  part.arrayBuffer = async () => {
    const bytes = new Uint8Array(await originalArrayBuffer()); bytes[0] ^= 1; return bytes.buffer;
  };
  const records = structuredClone([...f.backend.records]), chat = structuredClone(target.chat), metadata = structuredClone(target.chatMetadata);
  await assert.rejects(f.runtime.importPreview(plan), /已变化|校验失败/);
  assert.deepEqual([...f.backend.records], records);
  assert.deepEqual(target.chat, chat); assert.deepEqual(target.chatMetadata, metadata);
  assert.equal(f.api.saves, 0);
});

test('volume runtime settled callback distinguishes bounded operations from ordinary transfers', async () => {
  const legacyModes = [];
  const legacy = await fixture({ transferOptions: { onSettled: options => legacyModes.push(options.streaming) } });
  assert.deepEqual(legacyModes, [false]); legacyModes.length = 0;
  const exported = await legacy.runtime.exportCurrent();
  await legacy.target(); await legacy.runtime.importPreview(await legacy.runtime.preview(exported.text)); await legacy.runtime.undo();
  assert.deepEqual(legacyModes, [false, false, false], 'ordinary export, import and undo retain their normal refresh');

  const modes = [];
  const modern = await fixture({ transferOptions: { onSettled: options => modes.push(options.streaming) } });
  assert.deepEqual(modes, [false]); modes.length = 0; streamingFixture(modern);
  const files = await volumeFiles(modern.runtime);
  const cancelled = modern.runtime.exportVolumes({ partBytes: 1024 });
  assert.equal((await cancelled.next()).done, false); await cancelled.return();
  await modern.target(); await modern.runtime.importPreview(await modern.runtime.previewVolumes(files)); await modern.runtime.undo();
  assert.deepEqual(modes, [true, true, true, true], 'completed export, cancelled export, import and undo use the bounded refresh');

  const failedModes = [];
  const failed = await fixture({ transferOptions: { onSettled: options => failedModes.push(options.streaming) } });
  streamingFixture(failed); const failedFiles = await volumeFiles(failed.runtime); failedModes.length = 0;
  await failed.target(); const failedPlan = await failed.runtime.previewVolumes(failedFiles);
  const put = failed.backend.client.put;
  failed.backend.client.put = async (...args) => { if (args[0] === `chat-${IMPORTED}`) throw new Error('test staging failure'); return put(...args); };
  await assert.rejects(failed.runtime.importPreview(failedPlan), /test staging failure/);
  assert.deepEqual(failedModes, [true], 'failed staged import also avoids reloading the complete graph');
  assert.equal(failed.api.saves, 0); assert.equal(failed.session.identity().chatId, TARGET);
});

test('real memory and CSE round trip onto an updated card, without analysis calls or original writes', async () => {
  const f = await fixture(), target = await f.target();
  const original = JSON.stringify([...f.backend.records].filter(([key]) => key.startsWith(`chat-${SOURCE}/`)));
  const plan = await f.runtime.preview(f.exported.text);
  assert.equal(plan.summaries, 1); assert.equal(plan.states, 1);
  assert.equal(f.api.saves, 0);
  await f.runtime.importPreview(plan);
  assert.equal(target.chatMetadata.qianqianjie.chatId, IMPORTED);
  assert.deepEqual(f.api.persistedHeader.chat_metadata.qianqianjie.file, target.chatMetadata.qianqianjie.file);
  assert.equal(f.session.identity().chatId, IMPORTED);
  assert.equal(JSON.stringify([...f.backend.records].filter(([key]) => key.startsWith(`chat-${SOURCE}/`))), original);
  const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const foundation = createFoundationRuntime({ hostAdapter: f.host, store, contextProvider: () => target, newUuid: uuidFactory(), logger: { warn() {} } });
  assert.equal((await foundation.start()).status, 'ready');
  const restored = await store.readReachable({ mode: 'full' });
  assert.deepEqual(restored.floorMemories.map(item => item.summary), f.graph.floorMemories.map(item => item.summary));
  assert.equal(restored.stateDeltas.length, f.graph.stateDeltas.length);
  const memory = createV3MemoryRuntime({ foundationRuntime: foundation, store, hostAdapter: f.host,
    automationSettings: () => ({ enabled: false, batchSize: 1 }), newUuid: uuidFactory(), logger: { warn() {} },
    generateAnalysisTask: async () => assert.fail('must not reanalyze'), generateUtilityTask: async () => assert.fail('must not resummarize') });
  await memory.start();
  assert.equal(memory.getState().rememberedCount, 1);
  await f.runtime.undo();
  assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET);
  assert.ok(f.backend.records.has(`chat-${IMPORTED}/v3-root`), 'undo preserves imported memory too');
});

function coldSwipeTarget(f, target, prepare = () => {}) {
  const message = target.chat[1], anchor = { schemaVersion: 1, chatId: SOURCE, floorId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
  message.swipes = [message.mes, '未选中的另一版回复', '仍未加载的回复'];
  message.swipe_id = 0;
  message.swipe_info = [{ extra: structuredClone(message.extra ?? {}) }, { extra: { qianqianjie_floor: anchor, keep: '未选回复资料' } }, { extra: { keep: '冷回复资料' } }];
  prepare(message);
  f.api.reloadFromContext();
  let source, sourceId = 0, reloads = 0;
  const load = () => {
    // TT's source is an opened immutable file, not the latest pathname content.
    source = f.api.persistedMessages; sourceId++;
    target.chat.splice(0, target.chat.length, ...structuredClone(source));
    target.chatMetadata = f.api.persistedHeader.chat_metadata;
    const current = target.chat[1];
    for (let index = 1; index < current.swipes.length; index++) { current.swipes[index] = null; current.swipe_info[index] = null; }
    current.tt_swipe_cold = { sourceId, record: 2 };
  };
  target.reloadCurrentChat = async () => { reloads++; load(); };
  load();
  return { reloads: () => reloads, hydrate() {
    const current = target.chat[1], original = source[1];
    for (const key of ['swipes', 'swipe_info']) for (let i = 0; i < original[key].length; i++) current[key][i] ??= structuredClone(original[key][i]);
    delete current.tt_swipe_cold;
  } };
}

test('TT cold swipe placeholders import and reload the saved source without hydrating all replies', async t => {
  for (const format of ['ordinary', 'volume']) await t.test(format, async () => {
    const f = await fixture(); let files;
    if (format === 'volume') { streamingFixture(f); files = await volumeFiles(f.runtime); }
    const target = await f.target(), cold = coldSwipeTarget(f, target);
    const preview = format === 'volume' ? await f.runtime.previewVolumes(files) : await f.runtime.preview(f.exported.text);
    const result = await f.runtime.importPreview(preview);
    assert.equal(result.reload, false); assert.equal(cold.reloads(), 1);
    assert.equal(f.session.identity().chatId, IMPORTED);
    assert.equal(target.chat[1].swipes[1], null); assert.equal(target.chat[1].swipe_info[1], null, '保持宿主冷回复，不把历史正文全部装回页面');
    assert.equal(f.api.persistedMessages[1].swipe_info[1].extra.qianqianjie_floor, undefined);
    cold.hydrate();
    assert.equal(target.chat[1].swipe_info[1].extra.qianqianjie_floor, undefined, '新source不能回填旧QQJ锚点');
    assert.equal(target.chat[1].swipe_info[1].extra.keep, '未选回复资料');
    f.api.reloadFromContext();
    assert.equal(f.api.persistedHeader.chat_metadata.qianqianjie.chatId, IMPORTED);
    assert.equal(f.api.persistedMessages[1].extra.qianqianjie_floor.chatId, IMPORTED);
    const graph = await createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() }).readReachable({ mode: 'full' });
    assert.equal(graph.status, 'ready'); assert.equal(graph.floorMemories.length, 1);
  });
});

test('TT cold swipe undo reloads the restored source and preserves original alternative metadata', async t => {
  for (const format of ['ordinary', 'volume']) await t.test(format, async () => {
    const f = await fixture(); let files;
    if (format === 'volume') { streamingFixture(f); files = await volumeFiles(f.runtime); }
    const target = await f.target(), cold = coldSwipeTarget(f, target);
    const original = f.api.persistedMessages;
    const preview = format === 'volume' ? await f.runtime.previewVolumes(files) : await f.runtime.preview(f.exported.text);
    await f.runtime.importPreview(preview); await f.runtime.undo();
    assert.equal(cold.reloads(), 2); assert.equal(f.session.identity().chatId, TARGET);
    assert.equal(target.chat[1].swipe_info[1], null);
    cold.hydrate();
    assert.deepEqual(target.chat[1].swipe_info[1], original[1].swipe_info[1]);
    assert.deepEqual(f.api.persistedMessages[1].swipe_info[1], original[1].swipe_info[1]);
  });
});

test('TT cold swipe comparison preserves live selected and loaded QQJ edits and requires a real placeholder', async t => {
  const changes = {
    loaded: target => { target.chat[1].swipe_info[1] = { extra: { qianqianjie_memory_excluded: true } }; target.chat[1].swipes[1] = '未选中的另一版回复'; },
    selected: target => { target.chat[1].swipe_info[0].extra.qianqianjie_memory_excluded = true; },
    noReference: target => { delete target.chat[1].tt_swipe_cold; },
    invalidReference: target => { target.chat[1].tt_swipe_cold.sourceId = 'not-a-resource'; },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
    const f = await fixture(), target = await f.target(); coldSwipeTarget(f, target); change(target);
    const plan = await f.runtime.preview(f.exported.text), before = f.backend.calls.filter(call => call[0] === 'put').length;
    await assert.rejects(f.runtime.importPreview(plan), /当前聊天尚未保存完成/);
    assert.equal(f.backend.calls.filter(call => call[0] === 'put').length, before); assert.equal(f.api.saves, 0);
  });
});

test('TT cold swipe import still stops page edits and saved ownership changes during staging', async t => {
  for (const format of ['ordinary', 'volume']) for (const location of ['page', 'file']) await t.test(`${format}: ${location}`, async () => {
    const f = await fixture(); let files;
    if (format === 'volume') { streamingFixture(f); files = await volumeFiles(f.runtime); }
    const target = await f.target(), cold = coldSwipeTarget(f, target), api = f.api;
    let staged = false;
    f.setApi({ ...api, async fetch(url, options) {
      const response = await api.fetch(url, options);
      if (staged && location === 'file' && url === '/api/chats/get') {
        const payload = await response.json(); payload[2].swipe_info[1].extra.qianqianjie_memory_excluded = true;
        return { ok: true, async json() { return payload; } };
      }
      return response;
    } });
    const put = f.backend.client.put;
    f.backend.client.put = async (...args) => {
      const result = await put(...args);
      if (args[0] === `chat-${IMPORTED}` && !staged) {
        staged = true;
        if (location === 'page') { target.chat[1].swipe_info[1] = { extra: { qianqianjie_memory_excluded: true } }; target.chat[1].swipes[1] = '未选中的另一版回复'; }
      }
      return result;
    };
    const plan = format === 'volume' ? await f.runtime.previewVolumes(files) : await f.runtime.preview(f.exported.text);
    await assert.rejects(f.runtime.importPreview(plan), location === 'page' ? /聊天已切换或内容有变化/ : /聊天文件在导入期间有变化/);
    assert.equal(api.saves, 0); assert.equal(cold.reloads(), 0); assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET);
  });
});

test('TT cold reload preserves live nonQQJ edits created while the saved copy is published', async () => {
  const f = await fixture(), target = await f.target();
  target.chatMetadata.otherPlugin = { remove: true }; target.chat[1].legacyFlag = 'remove';
  target.chat[1].extra = { ...target.chat[1].extra, removeMe: true };
  const api = targetChatApi(target, { afterSave() {
    delete target.chatMetadata.otherPlugin; delete target.chat[1].legacyFlag; delete target.chat[1].extra.removeMe;
    target.chatMetadata.pocketPhone = { createdWhileSaving: true };
    target.chat[1].extra = { ...target.chat[1].extra, variables: { createdWhileSaving: true } };
    target.chat[1].swipes[1] = '保存时手改的未选回复';
    target.chat[1].swipe_info[1] = { extra: { pocketPhone: { createdWhileSaving: true } } };
  } });
  f.setApi(api); const cold = coldSwipeTarget(f, target);
  await f.runtime.importPreview(await f.runtime.preview(f.exported.text));
  assert.equal(cold.reloads(), 1);
  assert.deepEqual(target.chatMetadata.pocketPhone, { createdWhileSaving: true });
  assert.equal(Object.hasOwn(target.chatMetadata, 'otherPlugin'), false); assert.equal(Object.hasOwn(target.chat[1], 'legacyFlag'), false);
  assert.equal(Object.hasOwn(target.chat[1].extra, 'removeMe'), false);
  assert.deepEqual(target.chat[1].extra.variables, { createdWhileSaving: true });
  assert.equal(target.chat[1].swipes[1], '保存时手改的未选回复');
  assert.deepEqual(target.chat[1].swipe_info[1].extra.pocketPhone, { createdWhileSaving: true });
  assert.equal(Object.hasOwn(target.chat[1].swipe_info[1].extra, 'keep'), false);
  assert.equal(target.chat[1].swipe_info[1].extra.qianqianjie_floor, undefined);
  assert.equal(target.chat[1].swipes[2], null); assert.equal(target.chat[1].swipe_info[2], null);
  cold.hydrate();
  assert.equal(target.chat[1].swipes[1], '保存时手改的未选回复');
  assert.equal(target.chat[1].swipe_info[1].extra.qianqianjie_floor, undefined);
});

test('TT cold reload merges unsaved drafts with newer listener additions changes and deletions', async t => {
  const baseline = { draftChanged: 'saved', draftDeleted: 'saved', listenerChanged: 'saved', listenerDeleted: 'saved', conflict: 'saved',
    nested: { draftChanged: 'saved', draftDeleted: 'saved', listenerChanged: 'saved', listenerDeleted: 'saved', conflict: 'saved', stable: 'saved' } };
  const expected = { draftChanged: 'draft', draftAdded: 'draft', listenerChanged: 'listener', listenerAdded: 'listener', conflict: 'listener',
    nested: { draftChanged: 'draft', draftAdded: 'draft', listenerChanged: 'listener', listenerAdded: 'listener', conflict: 'listener', stable: 'saved' } };
  const containers = target => [target.chat[1], target.chat[1].extra, target.chatMetadata,
    target.chat[1].swipe_info[1], target.chat[1].swipe_info[1].extra];
  const edit = (value, source) => {
    value[`${source}Added`] = source; value[`${source}Changed`] = source; delete value[`${source}Deleted`]; value.conflict = source;
    value.nested[`${source}Added`] = source; value.nested[`${source}Changed`] = source; delete value.nested[`${source}Deleted`]; value.nested.conflict = source;
  };
  const fields = [...Object.keys(baseline), 'draftAdded', 'listenerAdded'];
  for (const format of ['ordinary', 'volume']) for (const operation of ['import', 'undo']) await t.test(`${format}: ${operation}`, async () => {
    const f = await fixture(); let files;
    if (format === 'volume') { streamingFixture(f); files = await volumeFiles(f.runtime); }
    const target = await f.target();
    if (operation === 'undo') {
      const cold = coldSwipeTarget(f, target);
      await f.runtime.importPreview(format === 'volume' ? await f.runtime.previewVolumes(files) : await f.runtime.preview(f.exported.text));
      cold.hydrate();
    }
    target.chat[1].extra ??= {};
    for (const value of [target.chat[1], target.chat[1].extra, target.chatMetadata]) Object.assign(value, structuredClone(baseline));
    let loadedAlternative;
    const api = targetChatApi(target, { afterSave() {
      target.chat[1].swipes[1] = '保存期间未选回复草稿';
      target.chat[1].swipe_info[1] = structuredClone(loadedAlternative);
      for (const value of containers(target)) edit(value, 'draft');
    } });
    f.setApi(api);
    const cold = coldSwipeTarget(f, target, message => {
      Object.assign(message.swipe_info[1], structuredClone(baseline));
      Object.assign(message.swipe_info[1].extra, structuredClone(baseline));
      delete message.swipe_info[1].extra.qianqianjie_floor;
    });
    loadedAlternative = api.persistedMessages[1].swipe_info[1];
    const reload = target.reloadCurrentChat;
    let refreshedReference, listenerFailure;
    target.reloadCurrentChat = async () => {
      try {
        await reload();
        target.chat[1].swipes[1] = '重载监听器最新未选回复';
        target.chat[1].swipe_info[1] = structuredClone(api.persistedMessages[1].swipe_info[1]);
        for (const value of containers(target)) edit(value, 'listener');
        refreshedReference = structuredClone(target.chat[1].tt_swipe_cold);
      } catch (error) { listenerFailure = error; throw error; }
    };
    const result = operation === 'undo' ? await f.runtime.undo()
      : await f.runtime.importPreview(format === 'volume' ? await f.runtime.previewVolumes(files) : await f.runtime.preview(f.exported.text));
    assert.equal(listenerFailure, undefined);
    assert.equal(result.reload, false);
    for (const [index, value] of containers(target).entries()) {
      assert.deepEqual(Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])), expected, `container ${index}`);
    }
    assert.equal(target.chatMetadata.qianqianjie.chatId, operation === 'undo' ? TARGET : IMPORTED);
    assert.deepEqual(target.chat[1].tt_swipe_cold, refreshedReference);
    assert.equal(target.chat[1].swipes[1], '重载监听器最新未选回复');
    assert.equal(target.chat[1].swipes[2], null); assert.equal(target.chat[1].swipe_info[2], null);
    cold.hydrate();
    assert.equal(target.chat[1].swipes[1], '重载监听器最新未选回复');
    assert.equal(target.chat[1].swipe_info[2].extra.keep, '冷回复资料');
  });
});

test('TT cold reload never restores captured live fields into a different selected chat', async () => {
  const f = await fixture(), target = await f.target(); coldSwipeTarget(f, target);
  target.chat[1].extra = { ...target.chat[1].extra, variables: { capturedChat: true } };
  const other = context('other', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', [assistant('另一个聊天')]);
  other.chatMetadata.otherPlugin = { otherChat: true };
  const reload = target.reloadCurrentChat;
  target.reloadCurrentChat = async () => { await reload(); f.select(other); };
  const result = await f.runtime.importPreview(await f.runtime.preview(f.exported.text));
  assert.equal(result.reload, true); assert.equal(f.api.persistedHeader.chat_metadata.qianqianjie.chatId, IMPORTED);
  assert.equal(other.chatMetadata.qianqianjie.chatId, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  assert.deepEqual(other.chatMetadata.otherPlugin, { otherChat: true });
  assert.equal(other.chat[0].mes, '另一个聊天'); assert.equal(other.chat[0].extra?.variables, undefined);
});

test('derived file ownership from session preparation permits import, cold load and undo', async t => {
  const stored = [
    ['missing file', { schemaVersion: 2, chatId: TARGET }],
    ['old file', { schemaVersion: 2, chatId: TARGET, file: { characterLocator: 'old-avatar.png', hostChatId: 'old-file' } }],
    ['legacy schema', { schemaVersion: 1, chatId: TARGET }],
  ];
  for (const format of ['ordinary', 'volume']) for (const [name, savedQqj] of stored) await t.test(`${format}: ${name}`, async () => {
    const f = await fixture(); let files;
    if (format === 'volume') { streamingFixture(f); files = await volumeFiles(f.runtime); }
    const target = await f.target({ savedQqj });
    assert.deepEqual(f.api.persistedHeader.chat_metadata.qianqianjie, savedQqj, 'the file was captured before prepare updated live metadata');
    assert.deepEqual(target.chatMetadata.qianqianjie, { ...savedQqj, schemaVersion: 2,
      file: { characterLocator: 'updated-avatar.png', hostChatId: 'imported-chat' } });
    assert.equal(f.api.saves, 0, 'identity preparation must not save the entire chat');
    const plan = format === 'volume' ? await f.runtime.previewVolumes(files) : await f.runtime.preview(f.exported.text);
    const result = await f.runtime.importPreview(plan);
    assert.equal(result.summaries, 1); assert.equal(f.session.identity().chatId, IMPORTED);
    const cold = await createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() }).readReachable({ mode: 'full' });
    assert.equal(cold.status, 'ready'); assert.equal(cold.root.chatId, IMPORTED);
    assert.deepEqual(cold.floorMemories.map(item => item.summary), f.graph.floorMemories.map(item => item.summary));
    let firstRead = true;
    const undoApi = targetChatApi(target, { beforeGet({ header }) {
      if (firstRead) { firstRead = false; delete header.chat_metadata.qianqianjie.file; }
    } });
    f.setApi(undoApi); await f.runtime.undo();
    assert.equal(f.session.identity().chatId, TARGET);
    assert.deepEqual(undoApi.persistedHeader.chat_metadata.qianqianjie, savedQqj);
  });
});

test('derived file ownership never hides real saved story or QQJ changes', async t => {
  const changes = {
    body: ({ messages }) => { messages[1].mes = '存档中另一段正文'; },
    selectedReply: ({ messages }) => { messages[1].swipes.push('存档中另一条选中回复'); messages[1].swipe_id = 1; },
    ownedMessage: ({ messages }) => { messages[1].extra ??= {}; messages[1].extra.qianqianjie_memory_excluded = true; },
    prequel: ({ header }) => { header.chat_metadata.qianqianjiePrequel = '存档中尚未同步的人工前情'; },
    qqjBusiness: ({ header }) => { header.chat_metadata.qianqianjie.manualNote = '存档中的业务字段'; },
    unknownSchema: ({ header }) => { header.chat_metadata.qianqianjie.schemaVersion = 3; },
  };
  for (const format of ['ordinary', 'volume']) for (const [name, change] of Object.entries(changes)) await t.test(`${format}: ${name}`, async () => {
    const f = await fixture(); let files;
    if (format === 'volume') { streamingFixture(f); files = await volumeFiles(f.runtime); }
    const target = await f.target({ savedQqj: { schemaVersion: 2, chatId: TARGET } });
    f.setApi(targetChatApi(target, { beforeGet: change }));
    const plan = format === 'volume' ? await f.runtime.previewVolumes(files) : await f.runtime.preview(f.exported.text);
    const before = f.backend.calls.filter(call => call[0] === 'put').length;
    await assert.rejects(f.runtime.importPreview(plan), /当前聊天尚未保存完成/);
    assert.equal(f.backend.calls.filter(call => call[0] === 'put').length, before);
    assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET); assert.equal(f.api.saves, 0);
  });
});

test('saved file ownership changed during staging still prevents publication', async t => {
  for (const format of ['ordinary', 'volume']) await t.test(format, async () => {
    const f = await fixture(); let files;
    if (format === 'volume') { streamingFixture(f); files = await volumeFiles(f.runtime); }
    const target = await f.target({ savedQqj: { schemaVersion: 2, chatId: TARGET } });
    let staged = false;
    const api = targetChatApi(target, { beforeGet({ header }) {
      if (staged) header.chat_metadata.qianqianjie.file = { characterLocator: 'another-avatar.png', hostChatId: 'another-file' };
    } });
    f.setApi(api);
    const put = f.backend.client.put;
    f.backend.client.put = async (...args) => { const result = await put(...args); if (args[0] === `chat-${IMPORTED}`) staged = true; return result; };
    const plan = format === 'volume' ? await f.runtime.previewVolumes(files) : await f.runtime.preview(f.exported.text);
    await assert.rejects(f.runtime.importPreview(plan), /聊天文件在导入期间有变化/);
    assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET); assert.equal(api.saves, 0);
  });
});

test('a preview can be retried when import is rejected before entering its task', async t => {
  for (const format of ['ordinary', 'volume']) for (const phase of ['busy', 'quiesce']) await t.test(`${format}: ${phase}`, async () => {
    let busy = false, failQuiesce = false;
    const f = await fixture({ transferOptions: { isBusy: () => busy, quiesce: async () => {
      if (failQuiesce) throw new Error('test quiesce failed');
    } } });
    let files;
    if (format === 'volume') { streamingFixture(f); files = await volumeFiles(f.runtime); }
    const target = await f.target();
    const plan = format === 'volume' ? await f.runtime.previewVolumes(files) : await f.runtime.preview(f.exported.text);
    const writes = f.backend.calls.filter(call => call[0] === 'put').length;
    busy = phase === 'busy'; failQuiesce = phase === 'quiesce';
    await assert.rejects(f.runtime.importPreview(plan), phase === 'busy' ? /请等待聊天生成/ : /test quiesce failed/);
    assert.equal(f.backend.calls.filter(call => call[0] === 'put').length, writes);
    assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET); assert.equal(f.api.saves, 0);
    busy = false; failQuiesce = false;
    const result = await f.runtime.importPreview(plan);
    assert.equal(result.summaries, 1); assert.equal(target.chatMetadata.qianqianjie.chatId, IMPORTED);
    assert.equal(f.session.identity().chatId, IMPORTED);
    await assert.rejects(f.runtime.importPreview(plan), /预览已失效/);
  });
});

test('tampering, missing graph records, incompatible chat and consumed previews are rejected', async () => {
  const f = await fixture(); await f.target({ changed: true });
  await assert.rejects(f.runtime.preview(f.exported.text), /当前聊天与记忆包不一致/);
  const damaged = JSON.parse(f.exported.text); damaged.prequel = 'tampered';
  await assert.rejects(parseMemoryPackage(damaged), /完整性/);
  damaged.records = damaged.records.filter(item => item.data.recordType !== 'floorMemory');
  const { checksum, ...payload } = damaged; damaged.checksum = await sha256(stableJson(payload));
  await assert.rejects(parseMemoryPackage(damaged));
  const target = await f.target(); const plan = await f.runtime.preview(f.exported.text);
  target.chat.push(user('new message'));
  await assert.rejects(f.runtime.importPreview(plan), /有变化/);
  assert.equal(f.api.saves, 0);
  target.chat.pop(); await f.runtime.importPreview(plan);
  await assert.rejects(f.runtime.importPreview(plan), /预览已失效/);
});

test('staging failure and a chat switch never publish over the old or another chat', async () => {
  const f = await fixture(); const target = await f.target();
  const plan = await f.runtime.preview(f.exported.text), put = f.backend.client.put;
  f.backend.client.put = async (...args) => { if (args[0] === `chat-${IMPORTED}`) throw new Error('disk full'); return put(...args); };
  await assert.rejects(f.runtime.importPreview(plan), /disk full/);
  assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET); assert.equal(f.api.saves, 0);
  await assert.rejects(f.runtime.importPreview(plan), /预览已失效/);
  f.backend.client.put = put;
  const next = await f.runtime.preview(f.exported.text);
  f.backend.client.put = async (...args) => {
    const result = await put(...args); f.select(context('other', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', [assistant('other')])); return result;
  };
  await assert.rejects(f.runtime.importPreview(next), /切换/); assert.equal(f.api.saves, 0);
});


test('undo refuses changed conversation and export excludes settings and credentials', async () => {
  const f = await fixture();
  await f.backend.client.put(`chat-${SOURCE}`, 'unrelated-api-settings', { key: 'SECRET' }, 0);
  const file = await f.runtime.exportCurrent(); assert.ok(!file.text.includes('SECRET'));
  const target = await f.target(); await f.runtime.importPreview(await f.runtime.preview(file.text));
  target.chat.push(user('new story'));
  await assert.rejects(f.runtime.undo(), /继续聊天/);
  assert.equal(target.chatMetadata.qianqianjie.chatId, IMPORTED);
});

test('host save failure leaves the previous identity and source collection untouched', async () => {
  const f = await fixture(), target = await f.target(), api = f.api;
  const plan = await f.runtime.preview(f.exported.text);
  f.setApi({ fetch: (url, options) => url === '/api/chats/save' ? Promise.resolve({ ok: false, status: 409 }) : api.fetch(url, options) });
  await assert.rejects(f.runtime.importPreview(plan), /聊天文件未能保存/);
  assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET);
  assert.equal(api.persistedHeader.chat_metadata.qianqianjie.chatId, TARGET);
  assert.ok(f.backend.records.has(`chat-${SOURCE}/v3-root`));
});

test('switching while host save completes publishes only to the captured file', async () => {
  const f = await fixture(), target = await f.target();
  const other = context('other', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', [assistant('other')]);
  const api = targetChatApi(target, { afterSave: () => f.select(other) }); f.setApi(api);
  const result = await f.runtime.importPreview(await f.runtime.preview(f.exported.text));
  assert.equal(result.reload, true); assert.equal(api.persistedHeader.chat_metadata.qianqianjie.chatId, IMPORTED);
  assert.equal(other.chat[0].mes, 'other'); assert.notEqual(other.chatMetadata.qianqianjie.chatId, IMPORTED);
});

test('hidden messages, local time records, vector cache and arbitrary non-QQJ metadata survive transfer', async () => {
  const f = await fixture();
  f.ctx.chat[1].is_system = true; f.ctx.chat[1].extra ??= {}; f.ctx.chat[1].extra.qianqianjieAutoHide = { schemaVersion: 1, chatId: SOURCE };
  f.ctx.chat[1].extra.variables = { home: 'new home' }; f.ctx.chatMetadata.otherPlugin = { enabled: true };
  await f.backend.client.put(`chat-${SOURCE}`, 'v3-time-head', { schemaVersion: 1, chatId: SOURCE, batchIds: [], bodyStart: 0 }, 0);
  await f.backend.client.put(`chat-${SOURCE}`, 'qqj-vector-index', { schemaVersion: 1, recordType: 'vectorCache', chatId: SOURCE,
    narrativeGeneration: f.graph.root.narrativeGeneration, modelKey: `sha256:${'a'.repeat(64)}`, dimensions: 1024, shardIds: [], chunkCount: 0 }, 0);
  const file = await f.runtime.exportCurrent(); const target = await f.target();
  target.chatMetadata.otherPlugin = { targetValue: true }; f.api.reloadFromContext();
  await f.runtime.importPreview(await f.runtime.preview(file.text));
  assert.equal(target.chat[1].is_system, true); assert.equal(target.chat[1].extra.qianqianjieAutoHide.chatId, IMPORTED);
  assert.deepEqual(target.chat[1].extra.variables, { home: 'new home' }); assert.deepEqual(target.chatMetadata.otherPlugin, { targetValue: true });
  assert.equal(f.backend.records.get(`chat-${IMPORTED}/v3-time-head`).data.chatId, IMPORTED);
  assert.equal(f.backend.records.get(`chat-${IMPORTED}/qqj-vector-index`).data.modelKey, `sha256:${'a'.repeat(64)}`);
});

test('import finishes without rereading a populated collection and keeps returned auxiliary revisions', async () => {
  const f = await fixture();
  await f.backend.client.put(`chat-${SOURCE}`, 'v3-time-head', { schemaVersion: 1, chatId: SOURCE, batchIds: [], bodyStart: 0 }, 0);
  const exported = await f.runtime.exportCurrent(), target = await f.target();
  const list = f.backend.client.list, put = f.backend.client.put;
  let emptyLists = 0;
  f.backend.client.list = async collection => {
    if (collection === `chat-${IMPORTED}`) {
      if ([...f.backend.records.keys()].some(key => key.startsWith(`${collection}/`))) {
        throw Object.assign(new Error('读取记忆超时'), { code: 'BACKEND_TIMEOUT' });
      }
      emptyLists += 1;
    }
    return list(collection);
  };
  f.backend.client.put = async (...args) => {
    const result = await put(...args);
    if (args[0] === `chat-${IMPORTED}` && args[1] === 'v3-time-head') {
      f.backend.records.get(`${args[0]}/${args[1]}`).revision = 7;
      return { ...result, revision: 7 };
    }
    return result;
  };
  await f.runtime.importPreview(await f.runtime.preview(exported.text));
  assert.equal(emptyLists, 1);
  assert.equal(target.chatMetadata.qianqianjie.chatId, IMPORTED);
  assert.deepEqual(f.backend.records.get(`chat-${IMPORTED}/self-use-memory-transfer-rollback-v1`).data.importedAuxiliaryRevisions,
    { 'v3-time-head': 7 });
  const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const foundation = createFoundationRuntime({ hostAdapter: f.host, store, contextProvider: () => target, newUuid: uuidFactory(), logger: { warn() {} } });
  assert.equal((await foundation.start()).status, 'ready');
  const memory = createV3MemoryRuntime({ foundationRuntime: foundation, store, hostAdapter: f.host,
    automationSettings: () => ({ enabled: false, batchSize: 1 }), newUuid: uuidFactory(), logger: { warn() {} },
    generateAnalysisTask: async () => assert.fail('cold import must not reanalyze'),
    generateUtilityTask: async () => assert.fail('cold import must not resummarize') });
  await memory.start();
  assert.equal(memory.getState().rememberedCount, 1);
  assert.deepEqual((await store.readReachable({ mode: 'full' })).floorMemories.map(item => item.summary),
    f.graph.floorMemories.map(item => item.summary));
  f.backend.client.list = list;
  await f.runtime.undo();
  assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET);
});

test('time batch IDs round trip with their head and migration references', async t => {
  for (const legacy of [false, true]) await t.test(legacy ? 'legacy 32hex' : 'UUID from actual time edit', async () => {
    const f = await fixture({ body: '阿岚把钥匙放进木盒。' });
    const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
    const timeStore = createTimeStore({ client: f.backend.client });
    let editedBatchId, deletedItemId = null;
    if (legacy) {
      editedBatchId = `v3-time-batch-${'a'.repeat(32)}`;
      await timeStore.putBatch(SOURCE, { schemaVersion: 1, chatId: SOURCE, id: editedBatchId, changes: [] });
      await timeStore.putHead(SOURCE, { schemaVersion: 1, chatId: SOURCE, batchIds: [editedBatchId] }, 0);
    } else {
      const time = createTimeRuntime({ store: timeStore, foundationStore: store, hostAdapter: f.host, session: f.session,
        getReachable: () => f.graph, getMemoryState: () => ({ memorySyncStatus: 'idle' }), isEnabled: () => true,
        newUuid: uuidFactory(), logger: { warn() {} }, generateTimeTask: async task => {
          const request = JSON.parse(task.taskMessages[0].content);
          return { changes: request.currentReview ? request.trackedItems.map(item => ({ itemId: item.id, assessmentReason: '等待后续观察' }))
            : [{ itemId: null, subjectEntityId: null, subjectName: '阿岚', type: 'deadline', label: '归还钥匙', observation: '钥匙在木盒里',
              occurrenceTime: '', dueTime: '', periodDays: null, status: 'active', stateRefs: [], progression: '', sourceKeys: [request.observations[0].sourceKey] }] };
        } });
      await time.organize(await time.prepareHistoryPlan());
      const timeState = time.getState();
      assert.ok(timeState.trackedItems?.length, JSON.stringify(timeState));
      const item = timeState.trackedItems[0];
      await time.editItem(item.id, { label: '人工修订的钥匙事项' }, item.observationKey);
      editedBatchId = (await timeStore.read(SOURCE)).head.batchIds.at(-1);
      assert.match(editedBatchId, /^v3-time-batch-[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i);
      assert.equal(time.getState().trackedItems[0].label, '人工修订的钥匙事项');
      const edited = time.getState().trackedItems[0];
      await time.editItem(edited.id, { status: 'cancelled' }, edited.observationKey);
      const stopped = time.getState().stoppedItems[0];
      const beforeDelete = await timeStore.read(SOURCE);
      f.backend.client.health = async () => ({ capabilities: { permanentDelete: true } });
      f.backend.client.removePermanent = async (collection, id, revision) => {
        const key = `${collection}/${id}`;
        assert.equal(f.backend.records.get(key)?.revision, revision);
        f.backend.records.delete(key);
        return { ok: true };
      };
      await time.deleteItems([{ itemId: stopped.id, observationKey: stopped.observationKey }]);
      deletedItemId = stopped.id;
      const afterDelete = await timeStore.read(SOURCE);
      const removedBatchIds = beforeDelete.head.batchIds.filter(id => !afterDelete.head.batchIds.includes(id));
      assert.ok(removedBatchIds.length > 0);
      assert.ok(removedBatchIds.every(id => !f.backend.records.has(`chat-${SOURCE}/${id}`)));
      assert.equal(afterDelete.head.pendingDeletionRecords, undefined);
      assert.equal(time.getState().trackedItems.length, 0);
      assert.equal(time.getState().stoppedItems.length, 0);
      editedBatchId = afterDelete.head.batchIds.at(-1);
    }
    const before = await timeStore.read(SOURCE);
    const descriptor = createMigrationDescriptor({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', chatId: SOURCE,
      source: f.session.identity(), reachable: f.graph, timeBatchIds: before.head.batchIds,
      sourceTimeHeadSnapshots: [{ sourceChatId: SOURCE, head: before.head }], createdAt: NOW });
    await store.putRecord(descriptor);
    const root = await store.readRoot();
    await store.commitRoot({ ...root.data, migrationDescriptorId: descriptor.id }, root.revision);

    const exported = await f.runtime.exportCurrent();
    const parsed = await parseMemoryPackage(exported.text);
    assert.deepEqual(parsed.graph.migrationDescriptor.recordRefs.timeBatchIds, before.head.batchIds);
    assert.deepEqual(parsed.value.records.find(record => record.id === 'v3-time-head').data, before.head);
    assert.deepEqual(parsed.value.records.find(record => record.id === editedBatchId).data, before.batches.at(-1));
    const damaged = structuredClone(parsed.value);
    damaged.records = damaged.records.filter(record => record.id !== editedBatchId);
    const { checksum: _checksum, ...payload } = damaged;
    damaged.checksum = await sha256(stableJson(payload));
    await assert.rejects(parseMemoryPackage(damaged), /缺少关联的时间、人物或向量记录/);

    await f.target();
    await f.runtime.importPreview(await f.runtime.preview(exported.text));
    const imported = await createTimeStore({ client: f.backend.client }).read(IMPORTED);
    assert.deepEqual(imported.head, { ...before.head, chatId: IMPORTED });
    assert.deepEqual(imported.batches, before.batches.map(batch => ({ ...batch, chatId: IMPORTED })));
    if (deletedItemId) assert.ok(imported.batches.every(batch => batch.changes.every(item => item.id !== deletedItemId)));
    const reexported = await parseMemoryPackage((await f.runtime.exportCurrent()).text);
    assert.deepEqual(reexported.graph.migrationDescriptor.recordRefs.timeBatchIds, before.head.batchIds);
    assert.deepEqual(reexported.graph.migrationDescriptor.sourceTimeHeadSnapshots, descriptor.sourceTimeHeadSnapshots);
    assert.deepEqual(reexported.value.records.find(record => record.id === editedBatchId).data, imported.batches.at(-1));
    f.backend.records.delete(`chat-${IMPORTED}/${editedBatchId}`);
    await assert.rejects(f.runtime.exportCurrent(), /缺少关联的时间、人物或向量记录/);
  });
});

test('saved manual summary and people fields including explicit blanks survive import and reexport', async () => {
  const f = await fixture();
  const floorId = f.graph.floorMemories[0].floorId;
  await f.memory.editSummary(floorId, '人工确认钥匙由阿岚保管。', '核对原文');
  const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const before = await store.readReachable({ mode: 'full' });
  const expectedSummary = before.floorMemories.find(memory => memory.floorId === floorId).summary;
  assert.equal(expectedSummary.effectiveSource, 'user');
  assert.equal(expectedSummary.userText, '人工确认钥匙由阿岚保管。');
  const personId = '33333333-3333-4333-8333-333333333333';
  const peopleStore = createPeopleWorkspaceStore({ client: f.backend.client });
  const saved = await peopleStore.put(f.session.identity(), {
    schemaVersion: 3, kind: 'qqj-v3-people-workspace', chatId: SOURCE,
    selectedEntityIds: [personId], personOrderEntityIds: [personId],
    profilesByEntityId: { [personId]: { entityId: personId, name: '人工姓名', aliases: '', appearance: '',
      manualFields: ['name', 'aliases', 'appearance'], source: 'manual', createdAt: NOW, updatedAt: NOW } },
    avatarsByEntityId: {}, identityRedirectsByEntityId: {}, deletedEntityIds: [], profileMaterialProgressByEntityId: {}, createdAt: NOW, updatedAt: NOW,
  }, 0);
  const expectedProfile = saved.data.profilesByEntityId[personId];
  const exported = await f.runtime.exportCurrent();
  await f.target();
  await f.runtime.importPreview(await f.runtime.preview(exported.text));
  const imported = await store.readReachable({ mode: 'full' });
  assert.deepEqual(imported.floorMemories.find(memory => memory.floorId === floorId).summary, expectedSummary);
  const importedProfile = (await peopleStore.read(f.session.identity())).data.profilesByEntityId[personId];
  assert.deepEqual(importedProfile, expectedProfile);
  assert.equal(importedProfile.source, 'manual');
  assert.equal(importedProfile.aliases, '');
  assert.equal(importedProfile.appearance, '');
  assert.deepEqual(importedProfile.manualFields, ['name', 'aliases', 'appearance']);
  const reexported = await parseMemoryPackage((await f.runtime.exportCurrent()).text);
  assert.deepEqual(reexported.graph.floorMemories.find(memory => memory.floorId === floorId).summary, expectedSummary);
  assert.deepEqual(reexported.value.records.find(record => record.id === 'v3-people-workspace').data.profilesByEntityId[personId], expectedProfile);
});

test('staging preserves unrelated live metadata, variables and unselected replies', async () => {
  const f = await fixture(), target = await f.target();
  target.chat[1].swipes.push('old unselected reply');
  target.chat[1].swipe_info = [{ extra: { variables: { before: true } } }, { extra: { pocketPhone: { before: true } } }];
  f.api.reloadFromContext();
  const plan = await f.runtime.preview(f.exported.text), put = f.backend.client.put;
  let changed = false;
  f.backend.client.put = async (...args) => {
    const result = await put(...args);
    if (!changed && args[0] === `chat-${IMPORTED}` && args[1] !== 'v3-root') {
      changed = true;
      target.chatMetadata.otherPlugin = { duringStaging: true };
      target.chatMetadata.pocketPhone = { unread: 4 };
      target.chatMetadata.integrity = 'latest-staging-integrity';
      target.chat[1].extra ??= {}; target.chat[1].extra.variables = { duringStaging: true };
      target.chat[1].swipes[1] = 'new unselected reply';
      target.chat[1].swipe_info[1].extra.pocketPhone = { duringStaging: true };
      f.api.reloadFromContext();
    }
    return result;
  };
  const result = await f.runtime.importPreview(plan);
  assert.equal(result.reload, false); assert.equal(changed, true);
  assert.deepEqual(f.api.persistedHeader.chat_metadata.otherPlugin, { duringStaging: true });
  assert.deepEqual(target.chatMetadata.pocketPhone, { unread: 4 });
  assert.deepEqual(f.api.persistedMessages[1].extra.variables, { duringStaging: true });
  assert.equal(f.api.persistedMessages[1].swipes[1], 'new unselected reply');
  assert.deepEqual(target.chat[1].swipe_info[1].extra.pocketPhone, { duringStaging: true });
});

test('publish merges QQJ into latest file and preserves fields created in live state while saving', async () => {
  const f = await fixture(), target = await f.target(); let gets = 0;
  const api = targetChatApi(target, {
    beforeGet({ header, messages }) {
      if (++gets !== 2) return;
      header.chat_metadata.otherPlugin = { diskOnly: true };
      header.chat_metadata.integrity = 'latest-file-integrity';
      header.unrelatedHeader = 'disk header';
      messages[1].extra ??= {}; messages[1].extra.diskOnly = { retained: true };
      messages[1].swipes.push('disk unselected');
      messages[1].swipe_info = [{ extra: { diskVariable: 1 } }, { extra: { diskVariable: 2 } }];
    },
    afterSave() {
      target.chatMetadata.pocketPhone = { createdWhileSaving: true };
      target.chat[1].extra ??= {}; target.chat[1].extra.liveOnly = { createdWhileSaving: true };
      target.chat[1].swipe_info = [{ extra: { liveVariable: true } }];
    },
  });
  f.setApi(api);
  const result = await f.runtime.importPreview(await f.runtime.preview(f.exported.text));
  assert.equal(result.reload, false); assert.equal(api.saves, 1);
  assert.deepEqual(api.persistedHeader.chat_metadata.otherPlugin, { diskOnly: true });
  assert.equal(api.persistedHeader.unrelatedHeader, 'disk header');
  assert.deepEqual(api.persistedMessages[1].extra.diskOnly, { retained: true });
  assert.equal(api.persistedMessages[1].swipes[1], 'disk unselected');
  assert.deepEqual(api.persistedMessages[1].swipe_info[1].extra, { diskVariable: 2 });
  assert.deepEqual(target.chatMetadata.pocketPhone, { createdWhileSaving: true });
  assert.deepEqual(target.chat[1].extra.liveOnly, { createdWhileSaving: true });
  assert.deepEqual(target.chat[1].swipe_info[0].extra, { liveVariable: true });
  assert.equal(target.chatMetadata.qianqianjie.chatId, IMPORTED);
});

test('staging still rejects changed body, selected reply and QQJ ownership', async t => {
  for (const change of ['body', 'selected', 'selectedSameText', 'anchor', 'qqjHeader']) await t.test(change, async () => {
    const f = await fixture(), target = await f.target(), plan = await f.runtime.preview(f.exported.text), put = f.backend.client.put;
    let changed = false;
    f.backend.client.put = async (...args) => {
      const result = await put(...args);
      if (!changed && args[0] === `chat-${IMPORTED}` && args[1] !== 'v3-root') {
        changed = true;
        if (change === 'body') target.chat[1].mes = 'changed story';
        if (change.startsWith('selected')) { target.chat[1].swipes.push(change === 'selected' ? 'changed selected reply' : target.chat[1].mes); target.chat[1].swipe_id = 1; }
        if (change === 'anchor') { target.chat[1].extra ??= {}; target.chat[1].extra.qianqianjie_floor = { schemaVersion: 1, chatId: TARGET, floorId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }; }
        if (change === 'qqjHeader') target.chatMetadata.qianqianjiePrequel = 'changed QQJ prequel';
      }
      return result;
    };
    await assert.rejects(f.runtime.importPreview(plan), /变化|切换/);
    assert.equal(f.api.saves, 0);
    assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET);
  });
});

test('core staging uses the existing batch store and commits root last, while batch failure never publishes', async t => {
  for (const failBatch of [false, true]) await t.test(failBatch ? 'failed batch' : 'successful batch', async () => {
    const f = await fixture(), target = await f.target(); const put = f.backend.client.put;
    let batches = 0;
    f.backend.client.putMany = async (collection, records) => {
      batches += 1; assert.ok(records.length <= 64); assert.ok(Buffer.byteLength(JSON.stringify({ records })) <= 1048576);
      assert.ok(records.every(record => record.recordId !== 'v3-root' && record.expectedRevision === 0));
      if (failBatch) return records.map(record => ({ recordId: record.recordId, status: 500, error: 'storage_error', message: 'offline fixture failure' }));
      const result = [];
      for (const record of records) result.push({ recordId: record.recordId, status: 200,
        envelope: await put(collection, record.recordId, record.data, record.expectedRevision) });
      return result;
    };
    const plan = await f.runtime.preview(f.exported.text);
    if (failBatch) {
      await assert.rejects(f.runtime.importPreview(plan)); assert.ok(batches > 0);
      assert.equal(f.api.saves, 0); assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET);
      assert.equal(f.backend.records.has(`chat-${IMPORTED}/v3-root`), false);
    } else {
      await f.runtime.importPreview(plan); assert.ok(batches > 0);
      const writes = f.backend.calls.filter(call => call[0] === 'put' && call[1] === `chat-${IMPORTED}` && call[2] !== 'self-use-memory-transfer-rollback-v1');
      assert.equal(writes.at(-1)[2], 'v3-root');
      const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
      const graph = await store.readReachable({ mode: 'full' });
      assert.equal(graph.status, 'ready'); assert.equal(graph.floorMemories.length, 1); assert.equal(graph.stateDeltas.length, 1);
    }
  });
});

test('V1 and V2 package witness hashes retain the original wire definition', async () => {
  const chat = [
    { is_user: true, mes: 'a\r\nb', send_date: 't', name: 'User', extra: { otherPlugin: true } },
    { is_user: false, is_system: true, mes: 'visible', swipes: ['unused', 'visible'], swipe_id: 1, extra: { qianqianjieAutoHide: { schemaVersion: 1 } } },
    { is_user: false, mes: 'narration', extra: { type: 'narrator' } },
  ];
  assert.deepEqual(await transferWitness(chat, { version: 1 }), ['6acc6d630762173128b1e72303676b1912a3dd47504a11f6af03515ad61a958e', '461e53fdb9a9056e74d1cec873b0bcb39fae01c677098c26a6a859f8c59c69df', 'e22a432a340f100be6a9c67507f5fffbe6c6182becbe4cad7c8c792060dbc105']);
  assert.deepEqual(await transferWitness(chat, { version: 2 }), ['3d9492e91127bd5661f3eee328c8df12659ac2ffdf0ce40e9bf4dab3ec1164d4', 'f2d6e9d6e5f6d2ce216bc59ee86f0aaf2190619300745a9d9b63a92597cfd85b', '1440e4db2b18bdd06ef56c298c09c092b03655760677d840ba8b4d561f162d50']);
});

test('new rollback uses V2 and undo preserves unrelated fields and unselected replies', async () => {
  const f = await fixture(), target = await f.target();
  await f.runtime.importPreview(await f.runtime.preview(f.exported.text));
  const rollback = f.backend.records.get(`chat-${IMPORTED}/self-use-memory-transfer-rollback-v1`).data;
  assert.equal(rollback.witnessVersion, 2);
  target.chatMetadata.otherPlugin = { afterImport: true };
  target.chat[1].extra.variables = { afterImport: true };
  target.chat[1].swipes.push('new unrelated alternative');
  target.chat[1].swipe_info = [{ extra: { liveVariables: true } }, { extra: { pocketPhone: true } }];
  f.api.reloadFromContext();
  await f.runtime.undo();
  assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET);
  assert.deepEqual(target.chatMetadata.otherPlugin, { afterImport: true });
  assert.deepEqual(target.chat[1].extra.variables, { afterImport: true });
  assert.equal(f.api.persistedMessages[1].swipes[1], 'new unrelated alternative');
  assert.deepEqual(target.chat[1].swipe_info[1].extra, { pocketPhone: true });
});

test('existing rollback without witnessVersion remains readable as V1', async () => {
  const f = await fixture(), target = await f.target();
  await f.runtime.importPreview(await f.runtime.preview(f.exported.text));
  const rollback = f.backend.records.get(`chat-${IMPORTED}/self-use-memory-transfer-rollback-v1`).data;
  delete rollback.witnessVersion; rollback.importedMessages = await transferWitness(target.chat, { version: 1 });
  await f.runtime.undo(); assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET);
});

test('undo rejects an advanced memory root even when story text is unchanged', async () => {
  const f = await fixture(), target = await f.target();
  await f.runtime.importPreview(await f.runtime.preview(f.exported.text));
  const root = f.backend.records.get(`chat-${IMPORTED}/v3-root`);
  root.data.updatedAt = '2026-10-27T00:00:00.000Z'; root.revision += 1;
  const saves = f.api.saves;
  await assert.rejects(f.runtime.undo(), /记忆.*变化|记忆.*更新/);
  assert.equal(f.api.saves, saves); assert.equal(target.chatMetadata.qianqianjie.chatId, IMPORTED);
});

test('an unanchored changed source has no proven binding for export', async () => {
  const f = await fixture(); f.ctx.chat[1].mes = 'changed'; f.ctx.chat[1].swipes[0] = 'changed';
  await assert.rejects(f.runtime.exportCurrent(), /记忆中的楼层.*绑定/);
});

test('cross-host timestamp, visibility, absent/default swipe index and unselected history changes preserve real memory/CSE', async () => {
  const f = await fixture(), target = await f.target();
  target.chat[0].send_date = 1790000000000; target.chat[0].name = 'renamed persona';
  target.chat[2].send_date = 'different host timestamp representation';
  target.chat[4].send_date = '2026-10-15T01:00:00.000Z';
  target.chat[1].is_system = true; // native import may omit the QQJ auto-hide marker
  target.chat[1].swipes = ['unused alternative', target.chat[1].mes]; target.chat[1].swipe_id = 1;
  target.chat[1].swipe_info = [{ extra: { unrelated: true } }, { extra: { variables: { retained: true } } }];
  delete target.chat[3].swipes; delete target.chat[3].swipe_id;
  f.api.reloadFromContext();
  await f.runtime.importPreview(await f.runtime.preview(f.exported.text));
  const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const foundation = createFoundationRuntime({ hostAdapter: f.host, store, contextProvider: () => target, newUuid: uuidFactory(), logger: { warn() {} } });
  assert.equal((await foundation.start()).status, 'ready');
  const restored = await store.readReachable({ mode: 'full' });
  assert.deepEqual(restored.floorMemories.map(item => item.id), f.graph.floorMemories.map(item => item.id));
  assert.deepEqual(restored.stateDeltas.map(item => item.id), f.graph.stateDeltas.map(item => item.id));
  assert.equal(target.chat[1].swipe_id, 1); assert.equal(target.chat[0].send_date, 1790000000000);
  assert.deepEqual(target.chat[1].swipe_info[1].extra, { variables: { retained: true } });
  const memory = createV3MemoryRuntime({ foundationRuntime: foundation, store, hostAdapter: f.host,
    automationSettings: () => ({ enabled: false, batchSize: 1 }), newUuid: uuidFactory(), logger: { warn() {} },
    generateAnalysisTask: async () => assert.fail('must not reanalyze'), generateUtilityTask: async () => assert.fail('must not resummarize') });
  await memory.start(); assert.equal(memory.getState().rememberedCount, 1);
});

test('V2 diagnostics identify counts and the first differing story floor, including user edits and rerolls', async () => {
  const f = await fixture();
  let target = await f.target(); target.chat[0].mes = 'different user message';
  await assert.rejects(f.runtime.preview(f.exported.text), /第 0 楼.*发言方、正文/);
  target = await f.target(); target.chat[1].swipes.push('actually different selected answer'); target.chat[1].swipe_id = 1;
  await assert.rejects(f.runtime.preview(f.exported.text), /第 1 楼/);
  target = await f.target(); target.chat.push(user('new'));
  await assert.rejects(f.runtime.preview(f.exported.text), /当前 6 条，记忆包 5 条/);
  target = await f.target(); target.chat[0].is_user = false;
  await assert.rejects(f.runtime.preview(f.exported.text), /第 0 楼/);
  assert.equal(f.api.saves, 0);
});

test('V1 stays readable when exact, and asks for a new export when the mixed hash cannot prove equality', async () => {
  const f = await fixture(), old = JSON.parse(f.exported.text);
  old.formatVersion = 1; old.messages = await transferWitness(f.ctx.chat, { version: 1 });
  const { checksum, ...payload } = old; old.checksum = await sha256(stableJson(payload));
  let target = await f.target(); assert.equal((await f.runtime.preview(old)).messages, 5);
  target.chat[0].send_date = 'timestamp changed';
  await assert.rejects(f.runtime.preview(old), /旧版记忆包.*第 0 楼.*重新导出/);
  target = await f.target(); await f.runtime.importPreview(await f.runtime.preview(old));
  await f.runtime.undo(); assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET);
});



function context(hostChatId, qqjChatId, chat, characterAvatar = 'character.png') {
  const value = {
    name1: '林岚', name2: '裴晚生', characterId: 0, groupId: null, chatId: hostChatId,
    characters: [{ avatar: characterAvatar, name: '裴晚生', data: { description: '角色描述', personality: '克制', scenario: '雨夜' } }],
    userAvatar: 'persona.png', powerUserSettings: { persona_description: '调查员' },
    chatMetadata: { qianqianjie: { schemaVersion: 2, chatId: qqjChatId } }, chat,
    async saveMetadata() {}, async saveChat() { return true; }, getRequestHeaders() { return {}; },
    getWorldInfoNames() { return []; }, async loadWorldInfoBatch() { return new Map(); },
  };
  return value;
}

function identity(hostChatId, chatId, characterLocator = 'character.png') {
  return { hostChatId, chatId, characterLocator, personaLocator: 'persona.png' };
}

function targetChatApi(context, { afterSave = null, beforeGet = null, hasIntegrity = true } = {}) {
  let header = { chat_metadata: structuredClone(context.chatMetadata) };
  if (!hasIntegrity) delete header.chat_metadata.integrity;
  let messages = structuredClone(context.chat);
  let saves = 0;
  return {
    get saves() { return saves; },
    get persistedHeader() { return structuredClone(header); },
    get persistedMessages() { return structuredClone(messages); },
    reloadFromContext() {
      header = { chat_metadata: structuredClone(context.chatMetadata) };
      messages = structuredClone(context.chat);
    },
    async fetch(url, options = {}) {
      if (url === '/api/chats/get') {
        await beforeGet?.({ header, messages });
        return { ok: true, async json() { return [{ ...structuredClone(header) }, ...structuredClone(messages)]; } };
      }
      assert.equal(url, '/api/chats/save');
      const body = JSON.parse(options.body);
      assert.equal(body.force, false);
      assert.equal(body.ch_name, context.name2);
      const currentIntegrity = header.chat_metadata?.integrity;
      if (currentIntegrity !== undefined) assert.equal(body.chat[0]?.chat_metadata?.integrity, currentIntegrity, '宿主保存必须携带当前 integrity');
      header = structuredClone(body.chat[0]);
      messages = structuredClone(body.chat.slice(1));
      saves += 1;
      if (hasIntegrity) header.chat_metadata.integrity = `test-integrity-${saves}`;
      else delete header.chat_metadata.integrity;
      afterSave?.({ header, messages, saves });
      return { ok: true, async json() { return hasIntegrity ? { integrity: header.chat_metadata.integrity } : {}; } };
    },
  };
}

test('unknown package records are rejected before any import writes', async () => {
  const f = await fixture();
  const invalid = JSON.parse(f.exported.text);
  assert.equal(invalid.format, 'qqj-core-chat-memory');
  invalid.records.push({ id: 'unknown-record', data: { chatId: SOURCE } });
  const { checksum, ...payload } = invalid;
  invalid.checksum = await sha256(stableJson(payload));
  await f.target();
  const before = f.backend.calls.length;
  await assert.rejects(f.runtime.preview(invalid), /不支持/);
  assert.equal(f.backend.calls.slice(before).some(call => call[0] === 'put'), false);
});


test('export collects all core records through the actual batch read shape', async () => {
  const f = await fixture();
  assert.ok(f.backend.calls.some(call => call[0] === 'getMany'));
  f.ctx.chatMetadata.transientCallback = () => {};
  const exported = await f.runtime.exportCurrent();
  const { graph } = await parseMemoryPackage(exported.text);
  assert.deepEqual(graph.floors.map(item => item.id), f.graph.floors.map(item => item.id));
  assert.deepEqual(graph.floorMemories.map(item => item.id), f.graph.floorMemories.map(item => item.id));
  assert.deepEqual(graph.stateDeltas.map(item => item.id), f.graph.stateDeltas.map(item => item.id));
  assert.equal(exported.text.includes('transientCallback'), false);
});

test('import replaces target exclusions and undo restores the previous marker', async () => {
  const f = await fixture(), target = await f.target();
  target.chat[1].extra ??= {};
  target.chat[1].extra.qianqianjie_memory_excluded = true;
  f.api.reloadFromContext();
  await f.runtime.importPreview(await f.runtime.preview(f.exported.text));
  assert.equal(target.chat[1].extra.qianqianjie_memory_excluded, undefined);
  const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const foundation = createFoundationRuntime({ hostAdapter: f.host, store, contextProvider: () => target, newUuid: uuidFactory(), logger: { warn() {} } });
  assert.equal((await foundation.start()).status, 'ready');
  await f.runtime.undo();
  assert.equal(target.chat[1].extra.qianqianjie_memory_excluded, true);
});

test('source exclusion markers survive a native import that omits them', async () => {
  const f = await fixture({ excluded: true }), target = await f.target();
  assert.equal(f.graph.checkpoint.inputFingerprints[1].memoryExcluded, true);
  delete target.chat[3].extra.qianqianjie_memory_excluded;
  f.api.reloadFromContext();
  await f.runtime.importPreview(await f.runtime.preview(f.exported.text));
  assert.equal(target.chat[3].extra.qianqianjie_memory_excluded, true);
  const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const foundation = createFoundationRuntime({ hostAdapter: f.host, store, contextProvider: () => target, newUuid: uuidFactory(), logger: { warn() {} } });
  assert.equal((await foundation.start()).status, 'ready');
  await f.runtime.undo();
  assert.equal(target.chat[3].extra.qianqianjie_memory_excluded, undefined);
});

test('0.9.9 matter overrides, deletion marks and captured variables round trip intact', async () => {
  const f = await fixture();
  const memory = structuredClone(f.graph.floorMemories[0]);
  const matterId = '11111111-1111-4111-8111-111111111111';
  memory.qianshiDelta = { schemaVersion: 1, status: 'empty', reason: null, compiledAt: NOW,
    candidateStats: { count: 0, characters: 0 }, events: [], relations: [],
    trackingOverrides: [{ matterId, following: false }],
    manualMatterStatusOverrides: [{ matterId, status: 'completed' }],
    deletedEventIds: ['22222222-2222-4222-8222-222222222222'] };
  memory.sourceVariableReference = { stat_data: { 剧情: { 钥匙: '木盒', 进度: 2 } }, ejsSaved: { season: '秋' } };
  const sourceRecord = [...f.backend.records].find(([, value]) => value.data.recordType === 'floorMemory' && value.data.id === memory.id);
  assert.ok(sourceRecord);
  sourceRecord[1].data = memory;
  const exported = await f.runtime.exportCurrent();
  await f.target();
  await f.runtime.importPreview(await f.runtime.preview(exported.text));
  const stored = [...f.backend.records].find(([recordKey, value]) => recordKey.startsWith(`chat-${IMPORTED}/`) && value.data.recordType === 'floorMemory' && value.data.id === memory.id)[1].data;
  assert.deepEqual(stored.qianshiDelta, memory.qianshiDelta);
  assert.deepEqual(stored.sourceVariableReference, memory.sourceVariableReference);
});

test('people thumbnails, original image bytes and crop migrate to new host paths', async () => {
  const f = await fixture();
  const personId = '33333333-3333-4333-8333-333333333333';
  const originalPath = '/user/images/qqj-avatars/qqj-avatar-original.png';
  const newPath = '/user/images/qqj-avatars/qqj-avatar-imported.png';
  const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128]);
  const thumbnail = 'data:image/png;base64,iVBORw0KGgo=';
  const crop = { aspectRatio: 1, zoom: 1.5, offsetX: 0.25, offsetY: -0.1 };
  const workspace = { schemaVersion: 3, kind: 'qqj-v3-people-workspace', chatId: SOURCE,
    selectedEntityIds: [personId], personOrderEntityIds: [personId], profilesByEntityId: {},
    avatarsByEntityId: { [personId]: thumbnail }, avatarSourcesByEntityId: { [personId]: { path: originalPath, mimeType: 'image/png', crop } },
    identityRedirectsByEntityId: {}, deletedEntityIds: [], profileMaterialProgressByEntityId: {}, createdAt: NOW, updatedAt: NOW };
  await f.backend.client.put(`chat-${SOURCE}`, 'v3-people-workspace', workspace, 0);
  const snapshotId = 'v3-people-snapshot-44444444-4444-4444-8444-444444444444';
  await f.backend.client.put(`chat-${SOURCE}`, snapshotId, { schemaVersion: 1, kind: 'qqj-v3-frozen-people-snapshot', chatId: SOURCE, sourceChatId: SOURCE, workspace: structuredClone(workspace) }, 0);
  const images = new Map([[originalPath, imageBytes]]), uploads = [];
  const withImages = api => ({ ...api, async fetch(url, options = {}) {
    if (images.has(url)) return { ok: true, async arrayBuffer() { return images.get(url).slice().buffer; } };
    if (url === '/api/images/upload') {
      const payload = JSON.parse(options.body);
      const bytes = Uint8Array.from(atob(payload.image), value => value.charCodeAt(0));
      uploads.push(bytes); images.set(newPath, bytes);
      return { ok: true, async json() { return { path: newPath }; } };
    }
    return api.fetch(url, options);
  } });
  f.setApi(withImages(f.api));
  const exported = await f.runtime.exportCurrent();
  assert.deepEqual(JSON.parse(exported.text).avatarImages, [{ path: originalPath, mimeType: 'image/png', data: Buffer.from(imageBytes).toString('base64') }]);
  await f.target(); f.setApi(withImages(f.api));
  await f.runtime.importPreview(await f.runtime.preview(exported.text));
  assert.equal(uploads.length, 1, 'shared originals are uploaded once for current and frozen workspaces');
  assert.deepEqual(uploads[0], imageBytes);
  for (const id of ['v3-people-workspace', snapshotId]) {
    const record = f.backend.records.get(`chat-${IMPORTED}/${id}`).data;
    const people = id === 'v3-people-workspace' ? record : record.workspace;
    assert.equal(people.chatId, IMPORTED);
    assert.equal(people.avatarsByEntityId[personId], thumbnail);
    assert.deepEqual(people.avatarSourcesByEntityId[personId], { path: newPath, mimeType: 'image/png', crop });
  }
  const reexported = JSON.parse((await f.runtime.exportCurrent()).text);
  assert.deepEqual(reexported.avatarImages, [{ path: newPath, mimeType: 'image/png', data: Buffer.from(imageBytes).toString('base64') }]);
});


test('wrapper-only edits export and restore existing memory without rewriting source records', async () => {
  const f = await fixture();
  const original = structuredClone([...f.backend.records]);
  f.ctx.chat[1].mes = f.ctx.chat[1].swipes[0] = '她把钥匙放进木盒。<!--仅修改包装-->';
  const exported = await f.runtime.exportCurrent();
  assert.deepEqual([...f.backend.records], original);
  const { graph } = await parseMemoryPackage(exported.text);
  assert.deepEqual(graph.floorMemories, f.graph.floorMemories);
  await f.target();
  await f.runtime.importPreview(await f.runtime.preview(exported.text));
  const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const restored = await store.readReachable({ mode: 'full' });
  assert.deepEqual(restored.floorMemories.map(item => item.summary), f.graph.floorMemories.map(item => item.summary));
  assert.deepEqual(restored.stateDeltas.map(item => item.id), f.graph.stateDeltas.map(item => item.id));
  const reexported = await parseMemoryPackage((await f.runtime.exportCurrent()).text);
  assert.deepEqual(reexported.graph.floorMemories.map(item => item.id), f.graph.floorMemories.map(item => item.id));
});

test('custom wrapper-only edits round trip and reexport with matching rules', async () => {
  const wrappers = { keepTags: 'scene', extraTags: 'thinking' };
  const f = await fixture({ body: '<scene>她把钥匙放进木盒。</scene><thinking>旧思考</thinking>', wrappers });
  f.ctx.chat[1].mes = f.ctx.chat[1].swipes[0] = '<scene>她把钥匙放进木盒。</scene><thinking>新思考</thinking>';
  const exported = await f.runtime.exportCurrent();
  await f.target();
  await f.runtime.importPreview(await f.runtime.preview(exported.text));
  const reexported = await parseMemoryPackage((await f.runtime.exportCurrent()).text);
  assert.deepEqual(reexported.graph.floorMemories.map(item => item.id), f.graph.floorMemories.map(item => item.id));
  assert.deepEqual(reexported.graph.stateDeltas.map(item => item.id), f.graph.stateDeltas.map(item => item.id));
});

test('different custom wrapper rules reject preview until source and destination agree', async () => {
  const wrappers = { keepTags: 'scene', extraTags: 'thinking' };
  const f = await fixture({ body: '<scene>她把钥匙放进木盒。</scene><thinking>旧思考</thinking>', wrappers });
  f.ctx.chat[1].mes = f.ctx.chat[1].swipes[0] = '<scene>她把钥匙放进木盒。</scene><thinking>新思考</thinking>';
  const exported = await f.runtime.exportCurrent();
  await f.target(); f.setWrappers({});
  const before = structuredClone([...f.backend.records]);
  await assert.rejects(f.runtime.preview(exported.text), /记忆中的楼层无法确认绑定/);
  assert.deepEqual([...f.backend.records], before);
  assert.equal(f.api.saves, 0);
  f.setWrappers(wrappers);
  await f.runtime.importPreview(await f.runtime.preview(exported.text));
  const reexported = await parseMemoryPackage((await f.runtime.exportCurrent()).text);
  assert.deepEqual(reexported.graph.floorMemories.map(item => item.id), f.graph.floorMemories.map(item => item.id));
});

test('wrapper rules changed after preview reject import before any persistent write', async () => {
  const wrappers = { keepTags: 'scene', extraTags: 'thinking' };
  const f = await fixture({ body: '<scene>她把钥匙放进木盒。</scene><thinking>旧思考</thinking>', wrappers });
  const exported = await f.runtime.exportCurrent();
  const target = await f.target();
  const plan = await f.runtime.preview(exported.text);
  const recordsBefore = structuredClone([...f.backend.records]);
  const chatBefore = structuredClone(target.chat);
  const metadataBefore = structuredClone(target.chatMetadata);
  const savesBefore = f.api.saves;

  f.setWrappers({});
  await assert.rejects(f.runtime.importPreview(plan), /记忆中的楼层无法确认绑定/);
  assert.deepEqual([...f.backend.records], recordsBefore, 'rechecking the source must not write backend records');
  assert.deepEqual(target.chat, chatBefore, 'rechecking the source must not alter host messages');
  assert.deepEqual(target.chatMetadata, metadataBefore, 'rechecking the source must not alter host metadata');
  assert.equal(f.api.saves, savesBefore, 'rechecking the source must not save the host chat');

  f.setWrappers(wrappers);
  await f.runtime.importPreview(await f.runtime.preview(exported.text));
  const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const cold = createFoundationRuntime({ hostAdapter: f.host, store, contextProvider: () => target, sanitizerOptions: () => wrappers, newUuid: uuidFactory(), logger: { warn() {} } });
  assert.equal((await cold.start()).status, 'ready');
  const restored = await store.readReachable({ mode: 'full' });
  assert.deepEqual(restored.floorMemories.map(memory => memory.id), f.graph.floorMemories.map(memory => memory.id));
  const reexported = await parseMemoryPackage((await f.runtime.exportCurrent()).text);
  assert.deepEqual(reexported.graph.floorMemories.map(memory => memory.id), f.graph.floorMemories.map(memory => memory.id));
});

test('equivalent wrapper settings change after preview still permit import', async () => {
  const f = await fixture();
  const exported = await f.runtime.exportCurrent();
  await f.target();
  const plan = await f.runtime.preview(exported.text);
  f.setWrappers({ extraTags: 'unused-tag' });
  const result = await f.runtime.importPreview(plan);
  assert.equal(result.chatId, IMPORTED);
  const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const restored = await store.readReachable({ mode: 'full' });
  assert.deepEqual(restored.floorMemories.map(memory => memory.id), f.graph.floorMemories.map(memory => memory.id));
});

test('retained anchored memories round trip after host body or selected reply changes', async t => {
  for (const change of ['body', 'selected']) await t.test(change, async () => {
    const f = await fixture(), first = f.graph.floors[0];
    f.ctx.chat[1].extra = { qianqianjie_floor: { schemaVersion: 1, chatId: SOURCE, floorId: first.id } };
    if (change === 'selected') {
      f.ctx.chat[1].swipes.push('宿主当前选中的另一条回答。');
      f.ctx.chat[1].swipe_id = 1;
      f.ctx.chat[1].mes = f.ctx.chat[1].swipes[1];
    } else f.ctx.chat[1].mes = f.ctx.chat[1].swipes[0] = '宿主保留的新正文，已有记忆不重做。';
    assert.equal((await f.foundation.refreshStatus()).status, 'ready');
    const retained = await f.store.readReachable({ mode: 'full' });
    assert.equal(retained.floors[0].content.canonicalContent, first.content.canonicalContent);
    const before = structuredClone([...f.backend.records]);
    const exported = await f.runtime.exportCurrent();
    assert.deepEqual([...f.backend.records], before, 'export copies the retained graph without refreshing its contents');
    assert.deepEqual(Object.keys(JSON.parse(exported.text)).sort(), [
      'format', 'formatVersion', 'pluginVersion', 'exportedAt', 'source', 'messages', 'markers', 'records', 'prequel', 'calendar', 'checksum',
    ].sort(), 'no source settings snapshot or new package field');
    const target = await f.target();
    target.chat[1].extra.qianqianjie_floor = { schemaVersion: 1, chatId: TARGET, floorId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
    f.api.reloadFromContext();
    await f.runtime.importPreview(await f.runtime.preview(exported.text));
    const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
    const cold = createFoundationRuntime({ hostAdapter: f.host, store, contextProvider: () => target, newUuid: uuidFactory(), logger: { warn() {} } });
    assert.equal((await cold.start()).status, 'ready');
    const restored = await store.readReachable({ mode: 'full' });
    assert.deepEqual(restored.floorMemories.map(memory => memory.summary), retained.floorMemories.map(memory => memory.summary));
    assert.deepEqual(restored.stateDeltas.map(delta => delta.id), retained.stateDeltas.map(delta => delta.id));
    assert.equal(restored.floors[0].content.canonicalContent, first.content.canonicalContent);
    const again = await parseMemoryPackage((await f.runtime.exportCurrent()).text);
    assert.deepEqual(again.graph.floorMemories.map(memory => memory.id), retained.floorMemories.map(memory => memory.id));
  });
});

test('moved floor bindings export markers at actual positions and survive a cold import', async () => {
  const f = await fixture();
  for (const floor of f.graph.floors) f.ctx.chat[floor.hostLocator.messageIndex].extra = {
    qianqianjie_floor: { schemaVersion: 1, chatId: SOURCE, floorId: floor.id },
  };
  f.ctx.chat.unshift(user('宿主前插的一条消息'));
  assert.equal((await f.foundation.inspect('moved-export')).status, 'ready');
  assert.equal((await f.store.readReachable({ mode: 'full' })).floors[0].hostLocator.messageIndex, 1, 'stored graph has not rebound yet');
  const before = structuredClone([...f.backend.records]);
  const exported = await f.runtime.exportCurrent();
  assert.deepEqual([...f.backend.records], before);
  const value = JSON.parse(exported.text);
  assert.equal(value.markers[1].extra.qianqianjie_floor, undefined);
  assert.equal(value.markers[2].extra.qianqianjie_floor.floorId, f.graph.floors[0].id);
  const target = await f.target();
  for (const message of target.chat) if (message.extra) delete message.extra.qianqianjie_floor;
  f.api.reloadFromContext();
  await f.runtime.importPreview(await f.runtime.preview(exported.text));
  const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const cold = createFoundationRuntime({ hostAdapter: f.host, store, contextProvider: () => target, newUuid: uuidFactory(), logger: { warn() {} } });
  assert.equal((await cold.start()).status, 'ready');
  const restored = await store.readReachable({ mode: 'full' });
  assert.equal(restored.floors[0].hostLocator.messageIndex, 2);
  assert.deepEqual(restored.floorMemories.map(memory => memory.id), f.graph.floorMemories.map(memory => memory.id));
  const again = await parseMemoryPackage((await f.runtime.exportCurrent()).text);
  assert.equal(again.value.markers[2].extra.qianqianjie_floor.floorId, f.graph.floors[0].id);
});

test('missing, foreign, conflicting and duplicated bindings do not export retained memories', async t => {
  for (const kind of ['missing', 'foreign', 'conflict', 'duplicate']) await t.test(kind, async () => {
    const f = await fixture(), first = f.graph.floors[0];
    f.ctx.chat[1].mes = f.ctx.chat[1].swipes[0] = '无法按正文重新匹配的宿主内容。';
    if (kind !== 'missing') f.ctx.chat[1].extra = { qianqianjie_floor: { schemaVersion: 1,
      chatId: kind === 'foreign' ? TARGET : SOURCE,
      floorId: kind === 'conflict' ? 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' : first.id } };
    if (kind === 'duplicate') f.ctx.chat[3].extra = { qianqianjie_floor: { ...f.ctx.chat[1].extra.qianqianjie_floor } };
    const before = structuredClone([...f.backend.records]);
    await assert.rejects(f.runtime.exportCurrent(), /楼层.*绑定|记忆中的楼层/);
    assert.deepEqual([...f.backend.records], before);
  });
});


test('only repeated manual summary edits at message six survive cold import and reexport', async () => {
  const f = await fixture({ extractIndex: 3, chat: [assistant('第零楼'), user('继续一'), assistant('第二楼'), user('继续三'),
    assistant('第四楼'), user('继续五'), assistant('她把钥匙放进木盒。'), user('继续七'), assistant('最新尾楼')] });
  const floor = f.graph.floors.find(item => item.hostLocator.messageIndex === 6);
  assert.ok(floor);
  const beforeBody = structuredClone(f.ctx.chat);
  await f.memory.editSummary(floor.id, '人工摘要第一稿。');
  await f.memory.editSummary(floor.id, '人工摘要第二稿，钥匙仍由她保管。');
  assert.deepEqual(f.ctx.chat, beforeBody, 'editing summaries does not edit chat text or selected replies');
  const retained = await f.store.readReachable({ mode: 'full' });
  const expected = retained.floorMemories.find(item => item.floorId === floor.id);
  assert.equal(expected.summary.userText, '人工摘要第二稿，钥匙仍由她保管。');
  const before = structuredClone([...f.backend.records]);
  const exported = await f.runtime.exportCurrent();
  assert.deepEqual([...f.backend.records], before);
  const target = await f.target();
  await f.runtime.importPreview(await f.runtime.preview(exported.text));
  const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const foundation = createFoundationRuntime({ hostAdapter: f.host, store, contextProvider: () => target, newUuid: uuidFactory(), logger: { warn() {} } });
  const cold = createV3MemoryRuntime({ foundationRuntime: foundation, store, hostAdapter: f.host,
    automationSettings: () => ({ enabled: false, batchSize: 1 }), newUuid: uuidFactory(), logger: { warn() {} },
    generateAnalysisTask: async () => assert.fail('loading imported state does not analyze again'),
    generateUtilityTask: async () => assert.fail('loading imported summaries does not call a model') });
  await cold.start();
  assert.equal(cold.getState().floors.find(item => item.floorId === floor.id).summary, expected.summary.userText);
  const again = await parseMemoryPackage((await f.runtime.exportCurrent()).text);
  assert.deepEqual(again.graph.floorMemories.find(item => item.floorId === floor.id).summary, expected.summary);
  assert.equal(again.graph.floors.find(item => item.id === floor.id).hostLocator.messageIndex, 6);
});

test('existing swipe representations and mes fields retain their selected-body semantics', async t => {
  for (const shape of ['without-swipes', 'with-swipes', 'mes-diverges']) await t.test(shape, async () => {
    const f = await fixture();
    if (shape === 'without-swipes') { delete f.ctx.chat[1].swipes; delete f.ctx.chat[1].swipe_id; }
    if (shape === 'mes-diverges') f.ctx.chat[1].mes = '宿主当前展示文字，选中候选仍为原文。';
    const exported = await f.runtime.exportCurrent();
    const target = await f.target();
    if (shape === 'without-swipes') { target.chat[1].swipes = [target.chat[1].mes]; target.chat[1].swipe_id = 0; }
    if (shape === 'with-swipes') { delete target.chat[1].swipes; delete target.chat[1].swipe_id; }
    f.api.reloadFromContext();
    await f.runtime.importPreview(await f.runtime.preview(exported.text));
    const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
    const cold = createFoundationRuntime({ hostAdapter: f.host, store, contextProvider: () => target, newUuid: uuidFactory(), logger: { warn() {} } });
    assert.equal((await cold.start()).status, 'ready');
    const again = await parseMemoryPackage((await f.runtime.exportCurrent()).text);
    assert.deepEqual(again.graph.floorMemories.map(item => item.summary), f.graph.floorMemories.map(item => item.summary));
    if (shape === 'mes-diverges') assert.equal(target.chat[1].mes, f.ctx.chat[1].mes);
  });
});

test('frozen history exports without its old chat body and survives cold import', async () => {
  const f = await fixture();
  const descriptor = createMigrationDescriptor({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', chatId: SOURCE,
    source: f.session.identity(), reachable: f.graph, createdAt: NOW });
  await f.store.putRecord(descriptor);
  const root = await f.store.readRoot();
  await f.store.commitRoot({ ...root.data, migrationDescriptorId: descriptor.id }, root.revision);
  f.ctx.chat.splice(0, f.ctx.chat.length, user('新聊天的开场'), assistant('尚未稳定的新尾楼'));
  const before = structuredClone([...f.backend.records]);
  const exported = await f.runtime.exportCurrent();
  assert.deepEqual([...f.backend.records], before);
  const parsed = await parseMemoryPackage(exported.text);
  assert.deepEqual(parsed.graph.migrationDescriptor.frozenFloorIds, f.graph.floors.map(item => item.id));
  assert.equal(parsed.value.markers.some(item => item.extra.qianqianjie_floor), false, 'frozen floors get no fabricated current-chat markers');
  const target = await f.target();
  await f.runtime.importPreview(await f.runtime.preview(exported.text));
  const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const cold = createFoundationRuntime({ hostAdapter: f.host, store, contextProvider: () => target, newUuid: uuidFactory(), logger: { warn() {} } });
  assert.equal((await cold.start()).status, 'ready');
  const again = await parseMemoryPackage((await f.runtime.exportCurrent()).text);
  assert.deepEqual(again.graph.floorMemories.map(item => item.id), f.graph.floorMemories.map(item => item.id));
  assert.deepEqual(again.graph.stateDeltas.map(item => item.id), f.graph.stateDeltas.map(item => item.id));
  assert.deepEqual(again.graph.migrationDescriptor.frozenFloorIds, descriptor.frozenFloorIds);
});

test('aggregate source snapshots remain historical when anchored member bodies change', async () => {
  const chat = [user('开场')];
  for (let index = 0; index < 5; index++) chat.push(assistant(`第${index}份正文`), user(`继续${index}`));
  chat.push(assistant('尚未稳定的尾楼'));
  const f = await fixture({ chat });
  const memory = createV3MemoryRuntime({ foundationRuntime: f.foundation, store: f.store, hostAdapter: f.host,
    automationSettings: () => ({ enabled: false, batchSize: 1 }), newUuid: uuidFactory(), logger: { warn() {} },
    generateAnalysisTask: async () => ({ jsonData: { noMaterialChange: true } }),
    generateUtilityTask: async () => ({ jsonData: { summary: '历史多楼合并摘要。' } }) });
  await memory.start();
  await memory.startHistoricalRebuild({ aggregate: true });
  const retained = await f.store.readReachable({ mode: 'full' });
  const aggregate = retained.floorMemories.find(item => item.sourceFloorIds?.length > 1);
  assert.ok(aggregate, JSON.stringify(memory.getState().lastAutoMemory));
  for (const floor of retained.floors) f.ctx.chat[floor.hostLocator.messageIndex].extra = {
    qianqianjie_floor: { schemaVersion: 1, chatId: SOURCE, floorId: floor.id },
  };
  const member = retained.floors.find(item => item.id === aggregate.sourceFloorIds[0]);
  f.ctx.chat[member.hostLocator.messageIndex].mes = f.ctx.chat[member.hostLocator.messageIndex].swipes[0] = '宿主保留已修改的成员正文。';
  const before = structuredClone([...f.backend.records]);
  const exported = await f.runtime.exportCurrent();
  assert.deepEqual([...f.backend.records], before);
  const target = await f.target();
  await f.runtime.importPreview(await f.runtime.preview(exported.text));
  const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const cold = createFoundationRuntime({ hostAdapter: f.host, store, contextProvider: () => target, newUuid: uuidFactory(), logger: { warn() {} } });
  assert.equal((await cold.start()).status, 'ready');
  const again = await parseMemoryPackage((await f.runtime.exportCurrent()).text);
  const restored = again.graph.floorMemories.find(item => item.id === aggregate.id);
  assert.deepEqual(restored.sourceFloorSnapshots, aggregate.sourceFloorSnapshots);
  assert.deepEqual(restored.summary, aggregate.summary);
});

test('undo restores only unchanged candidate replies without transplanting old anchors', async t => {
  for (const change of ['unchanged', 'replaced', 'reordered']) await t.test(change, async () => {
    const f = await fixture(), target = await f.target();
    const oldAnchor = { schemaVersion: 1, chatId: TARGET, floorId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
    target.chat[1].swipes.push('原先的候选甲', '原先的候选乙');
    target.chat[1].swipe_info = [{ extra: {} }, { extra: { qianqianjie_floor: oldAnchor } }, { extra: {} }];
    f.api.reloadFromContext();
    await f.runtime.importPreview(await f.runtime.preview(f.exported.text));
    if (change === 'replaced') target.chat[1].swipes[1] = '后来替换的候选';
    if (change === 'reordered') [target.chat[1].swipes[1], target.chat[1].swipes[2]] = [target.chat[1].swipes[2], target.chat[1].swipes[1]];
    target.chat[1].swipe_info[1].extra.otherPlugin = { retained: true };
    f.api.reloadFromContext();
    const selected = target.chat[1].swipes[0];
    await f.runtime.undo();
    assert.equal(target.chat[1].swipes[0], selected);
    assert.deepEqual(target.chat[1].swipe_info[1].extra.qianqianjie_floor, change === 'unchanged' ? oldAnchor : undefined);
    assert.deepEqual(f.api.persistedMessages[1].swipe_info[1].extra.qianqianjie_floor, change === 'unchanged' ? oldAnchor : undefined);
    assert.deepEqual(target.chat[1].swipe_info[1].extra.otherPlugin, { retained: true });
    assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET);
  });
});


test('public manual timeline edits and summary survive import and reexport without models', async () => {
  const f = await fixture(), sourceChatId = f.session.identity().chatId;
  const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const foundation = createFoundationRuntime({ hostAdapter: f.host, store, contextProvider: () => f.ctx, newUuid: uuidFactory(), logger: { warn() {} } });
  await foundation.start();
  const packet = { summary: '钥匙事项与木盒记录。', qianshi: { events: [
    { key: 'matter', title: '归还钥匙', description: '她准备归还钥匙。', status: 'planned', matter: true, storyTime: '2026-04-05 08:00', scheduledTime: '2026-04-06 09:00', object: '钥匙' },
    { key: 'kept', title: '取出木盒', description: '她取出了木盒。', status: 'occurred', matter: false, storyTime: '2026-04-05 09:00' },
    { key: 'unknown', title: '时间待核对', description: '手动清空时间的记录。', status: 'occurred', matter: false, storyTime: '2026-04-05 09:30' },
    { key: 'wrong', title: '误记记录', description: '需要手动删除的误记。', status: 'occurred', matter: false, storyTime: '2026-04-05 10:00' },
  ], order: [] } };
  let allowModel = true, modelCalls = 0;
  const generate = async () => {
    assert.equal(allowModel, true, 'manual timeline edits and transfer must not call models');
    modelCalls += 1;
    return { jsonData: packet };
  };
  const memory = createV3MemoryRuntime({ foundationRuntime: foundation, store, hostAdapter: f.host,
    automationSettings: () => ({ enabled: false, batchSize: 1 }), generateUtilityTask: generate, generateAnalysisTask: generate,
    newUuid: uuidFactory(), logger: { warn() {} } });
  await memory.start();
  await memory.extractFloor(f.graph.floors[0].id, { analyzeState: false });
  allowModel = false;
  const callsBefore = modelCalls, chatBefore = structuredClone(f.ctx.chat);
  const initial = memory.getQianshiSnapshot();
  const origin = initial.events.find(event => event.title === '归还钥匙');
  const kept = initial.events.find(event => event.title === '取出木盒');
  const unknown = initial.events.find(event => event.title === '时间待核对');
  const wrong = initial.events.find(event => event.title === '误记记录');
  const editInput = event => ({ eventId: event.id,
    expected: { memoryId: event.sourceFloorMemoryId, title: event.title, description: event.description, object: event.object,
      status: event.status, actionStatus: event.actionStatus ?? event.status, storyTime: event.storyTime, scheduledTime: event.scheduledTime },
    title: event.title, description: event.description, object: event.object });
  await memory.editQianshiEventText({ ...editInput(origin), status: 'inProgress', actionStatus: 'occurred', storyTime: '2026-04-07 12:34:56', scheduledTime: null });
  let matter = memory.getQianshiSnapshot().matters.find(item => item.matterId === origin.matterId);
  await memory.setQianshiMatterFollowing({ matterId: matter.matterId, following: false, expectedFollowing: matter.following });
  matter = memory.getQianshiSnapshot().matters.find(item => item.matterId === origin.matterId);
  await memory.setQianshiMatterStatus({ matterId: matter.matterId, status: 'completed', expectedStatus: matter.status, expectedManualStatus: matter.manualStatusOverride });
  await memory.deleteQianshiEvent({ eventId: wrong.id });
  await memory.editQianshiEventText({ ...editInput(memory.getQianshiSnapshot().events.find(event => event.id === unknown.id)), storyTime: null });
  await memory.editSummary(f.graph.floors[0].id, '人工改写摘要，保留手改时间线。');
  const before = memory.getQianshiSnapshot(), sourceGraph = await store.readReachable({ mode: 'full' });
  const sourceMemory = sourceGraph.floorMemories.find(item => item.floorId === f.graph.floors[0].id);
  const timelineIds = snapshot => snapshot.timeline.segments.flatMap(segment => segment.groups.flatMap(group => group.eventIds));
  assert.deepEqual(timelineIds(before), [kept.id, origin.id], 'manual time changes determine timeline ordering');
  assert.deepEqual(before.timeline.undatedEventIds, [unknown.id]);
  assert.ok(sourceMemory.qianshiDelta.deletedEventIds.includes(wrong.id));
  assert.deepEqual(f.ctx.chat, chatBefore);
  assert.equal(modelCalls, callsBefore);
  const sourceRecordsBefore = structuredClone([...f.backend.records].filter(([key]) => key.startsWith(`chat-${sourceChatId}/`)));
  const exported = await f.runtime.exportCurrent();
  const target = await f.target();
  await f.runtime.importPreview(await f.runtime.preview(exported.text));
  const reexported = await parseMemoryPackage((await f.runtime.exportCurrent()).text);
  const transferred = reexported.graph.floorMemories.find(item => item.floorId === sourceMemory.floorId);
  assert.deepEqual(transferred.qianshiDelta, sourceMemory.qianshiDelta);
  assert.deepEqual(transferred.summary, sourceMemory.summary);
  const targetStore = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const targetFoundation = createFoundationRuntime({ hostAdapter: f.host, store: targetStore, contextProvider: () => target, newUuid: uuidFactory(), logger: { warn() {} } });
  await targetFoundation.start();
  const targetMemory = createV3MemoryRuntime({ foundationRuntime: targetFoundation, store: targetStore, hostAdapter: f.host,
    automationSettings: () => ({ enabled: false, batchSize: 1 }), generateUtilityTask: generate, generateAnalysisTask: generate,
    newUuid: uuidFactory(), logger: { warn() {} } });
  await targetMemory.start();
  const after = targetMemory.getQianshiSnapshot();
  for (const field of ['events', 'matters', 'relations', 'timeline', 'currentProgress']) assert.deepEqual(after[field], before[field]);
  assert.deepEqual([...f.backend.records].filter(([key]) => key.startsWith(`chat-${sourceChatId}/`)), sourceRecordsBefore);
  assert.equal(modelCalls, callsBefore);
});

test('manual memory fields and linked exact text survive transfer without source or model changes', async () => {
  const originalQuote = '八点在东门', secondQuote = '备用会面地点';
  const f = await fixture({ body: `裴晚生留下字条“${originalQuote}”，另一张写着“${secondQuote}”。` });
  const sourceChatId = f.session.identity().chatId;
  const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const foundation = createFoundationRuntime({ hostAdapter: f.host, store, contextProvider: () => f.ctx, newUuid: uuidFactory(), logger: { warn() {} } });
  await foundation.start();
  const packet = { summary: '裴晚生留下约定字条。', people: [{ name: '裴晚生' }, { name: '林岚', role: 'user' }],
    commitments: [{ issuer: '裴晚生', content: originalQuote, exactQuote: originalQuote }],
    privateCognition: [{ owner: '裴晚生', content: originalQuote, visibility: 'private' }],
    informationTransfers: [{ from: '裴晚生', to: ['林岚'], claimText: originalQuote, channel: 'written', exactQuote: originalQuote }],
    exactQuotes: [{ exactText: originalQuote, speaker: '裴晚生' }, { exactText: secondQuote, speaker: '裴晚生' }] };
  let allowModel = true, calls = 0;
  const generate = async () => { assert.equal(allowModel, true); calls += 1; return { jsonData: packet }; };
  const memory = createV3MemoryRuntime({ foundationRuntime: foundation, store, hostAdapter: f.host,
    automationSettings: () => ({ enabled: false, batchSize: 1 }), generateUtilityTask: generate, generateAnalysisTask: generate,
    newUuid: uuidFactory(), logger: { warn() {} } });
  await memory.start(); await memory.extractFloor(f.graph.floors[0].id, { analyzeState: false });
  allowModel = false;
  const callsBefore = calls, chatBefore = structuredClone(f.ctx.chat);
  const initial = memory.getState().floors[0], anchor = initial.memory.exactAnchors.find(item => item.exactText === originalQuote);
  const removed = initial.memory.exactAnchors.find(item => item.exactText === secondQuote);
  const userId = memory.getState().memoryEntities.find(item => item.specialRole === 'user').entityId;
  const revisedQuote = '明早九点在西门\n<content>保留字面标签</content>!?';
  await memory.editMemory(initial.floorId, { summary: '手工核对的摘要。', revisionNote: '手动修订完整资料',
    timeText: '2026年10月28日 09:15', originalTimeText: '时间未明确', timeChanged: true,
    locations: [{ name: '手填西门' }], participantNames: ['裴晚生', '林岚', '手工新增人物'],
    exactAnchors: [{ anchorId: anchor.anchorId, carrier: '裴晚生的字条', exactText: revisedQuote, knownEntityIds: [userId] }] });
  const state = memory.getState(), saved = state.floors[0].memory;
  assert.equal(saved.chronology[0].time.sourceText, '2026年10月28日 09:15');
  assert.equal(saved.locations[0].name, '手填西门');
  assert.ok(state.memoryEntities.some(item => item.displayName === '手工新增人物' && saved.participants.some(participant => participant.entityId === item.entityId)));
  assert.equal(saved.exactAnchors[0].exactText, revisedQuote);
  assert.deepEqual(saved.exactAnchors[0].knownEntityIds, [userId]);
  assert.ok(saved.suppressedExactAnchorIds.includes(anchor.anchorId));
  assert.ok(saved.suppressedExactAnchorIds.includes(removed.anchorId));
  assert.equal(saved.commitments[0].content, revisedQuote);
  assert.equal(saved.privateCognition[0].content, revisedQuote);
  assert.equal(saved.informationTransfers[0].claimText, revisedQuote);
  await memory.restoreAi(initial.floorId);
  assert.equal(memory.getState().floors[0].memory.summary.effectiveSource, 'ai');
  await memory.editSummary(initial.floorId, '最终人工摘要。', '最终人工修订说明');
  const sourceGraph = await store.readReachable({ mode: 'full' });
  const sourceMemory = sourceGraph.floorMemories.find(item => item.floorId === initial.floorId);
  const sourceRecordsBefore = structuredClone([...f.backend.records].filter(([key]) => key.startsWith(`chat-${sourceChatId}/`)));
  const exported = await f.runtime.exportCurrent(); await f.target();
  await f.runtime.importPreview(await f.runtime.preview(exported.text));
  const reexported = await parseMemoryPackage((await f.runtime.exportCurrent()).text);
  const transferred = reexported.graph.floorMemories.find(item => item.floorId === sourceMemory.floorId);
  assert.deepEqual({ ...transferred, chatId: sourceChatId }, sourceMemory);
  assert.deepEqual(reexported.graph.entities.map(item => ({ ...item, chatId: sourceChatId })), sourceGraph.entities);
  assert.deepEqual(f.ctx.chat, chatBefore);
  assert.deepEqual([...f.backend.records].filter(([key]) => key.startsWith(`chat-${sourceChatId}/`)), sourceRecordsBefore);
  assert.equal(calls, callsBefore);
});

test('manual character state add edit and explicit clear survive transfer and cold reload without models', async () => {
  const f = await fixture(), sourceChatId = f.session.identity().chatId;
  const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const foundation = createFoundationRuntime({ hostAdapter: f.host, store, contextProvider: () => f.ctx, newUuid: uuidFactory(), logger: { warn() {} } });
  await foundation.start();
  const generate = async () => assert.fail('manual correction and transfer must not invoke models');
  const memory = createV3MemoryRuntime({ foundationRuntime: foundation, store, hostAdapter: f.host,
    automationSettings: () => ({ enabled: false, batchSize: 1 }), generateUtilityTask: generate, generateAnalysisTask: generate,
    newUuid: uuidFactory(), logger: { warn() {} } });
  await memory.start();
  let state = memory.getState(), subject = state.cseSubjects[0];
  const otherId = f.graph.entities.find(item => item.entityType === 'person' && item.id !== subject.subjectEntityId).id;
  const editInput = (state, subject, patch) => ({ expectedCurrentStateId: state.currentStateId, expectedCurrentStateFingerprint: state.currentStateFingerprint,
    core: subject.core.map(item => ({ itemId: item.id, text: item.text, visibility: item.visibility, towardEntityId: null })),
    adaptive: subject.adaptive.map(item => ({ itemId: item.id, text: item.text, visibility: item.visibility, towardEntityId: item.towardEntityId ?? null })),
    situational: subject.situational.map(item => ({ itemId: item.id, text: item.text, visibility: item.visibility, towardEntityId: item.towardEntityId ?? null })), ...patch });
  state = await memory.correctSubjectState(subject.subjectEntityId, editInput(state, subject, {
    core: [{ itemId: null, text: '人工核心性格', visibility: 'authorial', towardEntityId: null }],
    adaptive: [{ itemId: null, text: '手工新增信任关系', visibility: 'private', towardEntityId: otherId }],
    situational: [{ itemId: null, text: '等待归还钥匙', visibility: 'observable', towardEntityId: null }] }));
  subject = state.cseSubjects.find(item => item.subjectEntityId === subject.subjectEntityId);
  state = await memory.correctSubjectState(subject.subjectEntityId, editInput(state, subject, { core: [],
    situational: [{ itemId: subject.situational[0].id, text: '已经收好钥匙', visibility: 'private', towardEntityId: null }] }));
  subject = state.cseSubjects.find(item => item.subjectEntityId === subject.subjectEntityId);
  assert.deepEqual(subject.core, []);
  assert.equal(subject.adaptive[0].towardEntityId, otherId);
  assert.equal(subject.situational[0].text, '已经收好钥匙');
  const sourceGraph = await store.readReachable({ mode: 'full' });
  const sourceRecordsBefore = structuredClone([...f.backend.records].filter(([key]) => key.startsWith(`chat-${sourceChatId}/`)));
  const exported = await f.runtime.exportCurrent(), target = await f.target();
  await f.runtime.importPreview(await f.runtime.preview(exported.text));
  const reexported = await parseMemoryPackage((await f.runtime.exportCurrent()).text);
  assert.deepEqual(reexported.graph.stateDeltas.map(item => ({ ...item, chatId: sourceChatId })), sourceGraph.stateDeltas);
  assert.deepEqual(reexported.graph.currentStates.map(item => ({ ...item, chatId: sourceChatId })), sourceGraph.currentStates);
  const targetStore = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const targetFoundation = createFoundationRuntime({ hostAdapter: f.host, store: targetStore, contextProvider: () => target, newUuid: uuidFactory(), logger: { warn() {} } });
  await targetFoundation.start();
  const targetMemory = createV3MemoryRuntime({ foundationRuntime: targetFoundation, store: targetStore, hostAdapter: f.host,
    automationSettings: () => ({ enabled: false, batchSize: 1 }), generateUtilityTask: generate, generateAnalysisTask: generate,
    newUuid: uuidFactory(), logger: { warn() {} } });
  await targetMemory.start();
  const restoredSubject = targetMemory.getState().cseSubjects.find(item => item.subjectEntityId === subject.subjectEntityId);
  for (const layer of ['core', 'adaptive', 'situational']) assert.deepEqual(restoredSubject[layer], subject[layer]);
  assert.deepEqual([...f.backend.records].filter(([key]) => key.startsWith(`chat-${sourceChatId}/`)), sourceRecordsBefore);
});


test('explicitly cleared memory time places participants and exact text remain cleared after transfer', async () => {
  const f = await fixture(), sourceChatId = f.session.identity().chatId;
  const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const foundation = createFoundationRuntime({ hostAdapter: f.host, store, contextProvider: () => f.ctx, newUuid: uuidFactory(), logger: { warn() {} } });
  await foundation.start();
  const generate = async () => assert.fail('manual clearing and transfer must not call models');
  const memory = createV3MemoryRuntime({ foundationRuntime: foundation, store, hostAdapter: f.host,
    automationSettings: () => ({ enabled: false, batchSize: 1 }), generateUtilityTask: generate, generateAnalysisTask: generate,
    newUuid: uuidFactory(), logger: { warn() {} } });
  await memory.start();
  const floor = memory.getState().floors[0];
  await memory.editMemory(floor.floorId, { summary: floor.summary, timeText: '2026年10月28日 09:15', originalTimeText: '时间未明确', timeChanged: true,
    locations: [{ name: '准备清空的地点' }], participantNames: ['准备清空的参与人'],
    exactAnchors: [{ anchorId: null, carrier: '准备清空的便条', exactText: '手工便条全文', knownEntityIds: [] }] });
  await memory.editMemory(floor.floorId, { summary: floor.summary, timeText: '', originalTimeText: '2026年10月28日 09:15', timeChanged: true,
    locations: [], participantNames: [], exactAnchors: [] });
  const sourceGraph = await store.readReachable({ mode: 'full' }), sourceMemory = sourceGraph.floorMemories.find(item => item.floorId === floor.floorId);
  assert.equal(sourceMemory.chronology[0].time.kind, 'unknown');
  assert.equal(sourceMemory.chronology[0].time.sourceText, '时间未明确');
  for (const field of ['locations', 'participants', 'exactAnchors']) assert.deepEqual(sourceMemory[field], []);
  const exported = await f.runtime.exportCurrent(); await f.target();
  await f.runtime.importPreview(await f.runtime.preview(exported.text));
  const reexported = await parseMemoryPackage((await f.runtime.exportCurrent()).text);
  assert.deepEqual({ ...reexported.graph.floorMemories.find(item => item.floorId === floor.floorId), chatId: sourceChatId }, sourceMemory);
});

test('manual error marking is preserved by transfer without regenerating or deleting memory', async () => {
  const f = await fixture(), sourceChatId = f.session.identity().chatId;
  const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const foundation = createFoundationRuntime({ hostAdapter: f.host, store, contextProvider: () => f.ctx, newUuid: uuidFactory(), logger: { warn() {} } });
  await foundation.start();
  const generate = async () => assert.fail('manual error marking and transfer must not call models');
  const memory = createV3MemoryRuntime({ foundationRuntime: foundation, store, hostAdapter: f.host,
    automationSettings: () => ({ enabled: false, batchSize: 1 }), generateUtilityTask: generate, generateAnalysisTask: generate,
    newUuid: uuidFactory(), logger: { warn() {} } });
  await memory.start();
  const floorId = memory.getState().floors[0].floorId;
  await memory.markError(floorId);
  const sourceGraph = await store.readReachable({ mode: 'full' }), sourceMemory = sourceGraph.floorMemories.find(item => item.floorId === floorId);
  assert.equal(sourceMemory.recordStatus, 'invalidated');
  const exported = await f.runtime.exportCurrent(); await f.target();
  const preview = await f.runtime.preview(exported.text);
  assert.equal(preview.summaries, 0);
  await f.runtime.importPreview(preview);
  const reexported = await parseMemoryPackage((await f.runtime.exportCurrent()).text);
  assert.deepEqual({ ...reexported.graph.floorMemories.find(item => item.floorId === floorId), chatId: sourceChatId }, sourceMemory);
});

test('manual prequel calendar and explicit clears survive transfer and undo without changing other chats', async t => {
  for (const prequel of ['人工前情：旧案已结，钥匙仍在木盒。', '', null]) await t.test(String(prequel), async () => {
    const calendars = new Map([[SOURCE, { months: 4, prefix: '启航' }], [TARGET, { months: 12, prefix: '旧历' }]]);
    if (prequel === null) calendars.delete(SOURCE);
    const f = await fixture({ transferOptions: {
      captureCalendar: chatId => calendars.get(chatId) ?? null,
      persistCalendar: async (chatId, calendar) => { calendars.set(chatId, structuredClone(calendar)); },
    } });
    if (prequel !== null) f.ctx.chatMetadata.qianqianjiePrequel = prequel;
    const sourceRecords = structuredClone([...f.backend.records]);
    const exported = await f.runtime.exportCurrent();
    assert.deepEqual([...f.backend.records], sourceRecords);
    const target = await f.target();
    target.chatMetadata.qianqianjiePrequel = '导入前目标聊天的手工前情';
    f.api.reloadFromContext();
    await f.runtime.importPreview(await f.runtime.preview(exported.text));
    assert.equal(target.chatMetadata.qianqianjiePrequel, prequel === null ? undefined : prequel);
    assert.deepEqual(calendars.get(TARGET), { months: 12, prefix: '旧历' });
    assert.deepEqual(calendars.get(SOURCE), prequel === null ? undefined : { months: 4, prefix: '启航' });
    const reexported = await parseMemoryPackage((await f.runtime.exportCurrent()).text);
    assert.equal(reexported.value.prequel, prequel);
    assert.deepEqual(reexported.value.calendar, prequel === null ? null : { months: 4, prefix: '启航' });
    await f.runtime.undo();
    assert.equal(target.chatMetadata.qianqianjiePrequel, '导入前目标聊天的手工前情');
    assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET);
    assert.deepEqual(calendars.get(TARGET), { months: 12, prefix: '旧历' });
  });
});


test('all manual people fields, selections, order, avatar and merge deletion chains survive cold transfer', async t => {
  const f = await fixture();
  const names = ['人物甲', '人物乙', '人物丙', '人物丁', '人物戊', '人物己', '人物庚', '人物辛'];
  await f.memory.editMemory(f.graph.floors[0].id, { summary: f.memory.getState().floors[0].summary, participantNames: names });
  const sourceBody = structuredClone(f.ctx.chat);
  const peopleStore = createPeopleWorkspaceStore({ client: f.backend.client });
  let modelCalls = 0;
  const noModel = async () => { modelCalls += 1; assert.fail('manual people transfer must not request a model'); };
  const people = createPeopleWorkspaceRuntime({ store: peopleStore, session: f.session,
    foundationRuntime: f.foundation, foundationStore: f.store, hostAdapter: f.host, memoryRuntime: f.memory,
    generateUtilityTask: noModel, sourcePermissions: { filterCandidates: ({ candidates }) => candidates },
    contextProvider: () => f.ctx, logger: { warn() {} } });
  t.after(() => people.destroy());
  await people.refresh();
  const ids = names.map(name => people.getState().people.find(person => person.entityDisplayName === name)?.entityId);
  assert.ok(ids.every(Boolean), JSON.stringify(people.getState().people.map(person => person.entityDisplayName)));
  for (const [index, id] of ids.entries()) {
    const fields = Object.fromEntries(PEOPLE_PROFILE_FIELDS.map(field => [field, `${names[index]}-${field}-人工值`]));
    await people.saveProfile(id, fields, { manualFields: PEOPLE_PROFILE_FIELDS });
  }
  const [a, b, c, d, e, g, h, i] = ids;
  await people.saveProfile(a, { aliases: '', notes: '', appearance: '' }, { manualFields: ['aliases', 'notes', 'appearance'] });
  const cleared = people.getState().profilesByEntityId[a];
  for (const field of PEOPLE_PROFILE_FIELDS) {
    assert.equal(cleared[field], ['aliases', 'notes', 'appearance'].includes(field) ? '' : `${names[0]}-${field}-人工值`, field);
    assert.ok(cleared.manualFields.includes(field), field);
  }
  assert.equal(cleared.source, 'manual');
  await people.saveAvatar(a, 'data:image/png;base64,QUFB');
  await people.saveAvatar(b, 'data:image/png;base64,QkJC');
  await people.saveAvatar(c, 'data:image/png;base64,Q0ND');
  await people.saveAvatar(d, 'data:image/png;base64,RERE');
  await people.saveAvatar(e, 'data:image/png;base64,RUVF');
  await people.setSelectedEntityIds(ids);
  await people.setPersonOrderEntityIds([...ids].reverse());
  const sourceProfile = structuredClone(people.getState().profilesByEntityId[b]);
  const targetName = people.getState().profilesByEntityId[c].name;
  await people.mergePeople(b, c, 'source');
  assert.equal(people.getState().profilesByEntityId[c].name, targetName);
  for (const field of PEOPLE_PROFILE_FIELDS.filter(field => field !== 'name')) assert.equal(people.getState().profilesByEntityId[c][field], sourceProfile[field], field);
  assert.equal(people.getState().avatarsByEntityId[c], 'data:image/png;base64,QkJC');
  const chosenTarget = structuredClone(people.getState().profilesByEntityId[e]);
  await people.mergePeople(d, e, 'target');
  for (const field of PEOPLE_PROFILE_FIELDS) assert.equal(people.getState().profilesByEntityId[e][field], chosenTarget[field], field);
  assert.equal(people.getState().avatarsByEntityId[e], 'data:image/png;base64,RUVF');
  await people.mergePeople(g, h, 'source');
  await people.mergePeople(h, i, 'target');
  assert.equal(people.getState().identityRedirectsByEntityId[g], i);
  assert.equal(people.getState().identityRedirectsByEntityId[h], i);
  await people.deletePerson(i);
  await people.setSelectedEntityIds([a, c, e]);
  await people.setPersonOrderEntityIds([e, c, a]);
  people.invalidate();
  await people.refresh();
  const beforeState = people.getState();
  assert.deepEqual(beforeState.selectedEntityIds, [a, c, e]);
  assert.deepEqual(beforeState.personOrderEntityIds, [e, c, a]);
  for (const id of [b, d, g, h, i]) assert.equal(beforeState.people.some(person => person.entityId === id), false);
  assert.ok(beforeState.deletedEntityIds.includes(i));
  const sourceWorkspace = (await peopleStore.read(f.session.identity())).data;
  const sourceRecords = structuredClone([...f.backend.records].filter(([key]) => key.startsWith(`chat-${SOURCE}/`)));
  people.destroy();
  const exported = await f.runtime.exportCurrent();
  assert.deepEqual(JSON.parse(exported.text).records.find(record => record.id === 'v3-people-workspace').data, sourceWorkspace);
  assert.deepEqual(f.ctx.chat, sourceBody);
  assert.deepEqual([...f.backend.records].filter(([key]) => key.startsWith(`chat-${SOURCE}/`)), sourceRecords);
  const target = await f.target();
  await f.runtime.importPreview(await f.runtime.preview(exported.text));
  const targetStore = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const targetFoundation = createFoundationRuntime({ hostAdapter: f.host, store: targetStore, contextProvider: () => target, newUuid: uuidFactory(), logger: { warn() {} } });
  await targetFoundation.start();
  const targetMemory = createV3MemoryRuntime({ foundationRuntime: targetFoundation, store: targetStore, hostAdapter: f.host,
    automationSettings: () => ({ enabled: false, batchSize: 1 }), generateUtilityTask: noModel, generateAnalysisTask: noModel,
    newUuid: uuidFactory(), logger: { warn() {} } });
  await targetMemory.start();
  const targetPeople = createPeopleWorkspaceRuntime({ store: peopleStore, session: f.session,
    foundationRuntime: targetFoundation, foundationStore: targetStore, hostAdapter: f.host, memoryRuntime: targetMemory,
    generateUtilityTask: noModel, sourcePermissions: { filterCandidates: ({ candidates }) => candidates },
    contextProvider: () => target, logger: { warn() {} } });
  t.after(() => targetPeople.destroy());
  await targetPeople.refresh();
  const actual = targetPeople.getState();
  for (const field of ['selectedEntityIds', 'personOrderEntityIds', 'profilesByEntityId', 'avatarsByEntityId', 'identityRedirectsByEntityId', 'deletedEntityIds']) assert.deepEqual(actual[field], beforeState[field], field);
  for (const id of [b, d, g, h, i]) assert.equal(actual.people.some(person => person.entityId === id), false, 'merged and deleted people do not reappear');
  assert.deepEqual(actual.people.map(person => person.entityId), beforeState.people.map(person => person.entityId));
  assert.deepEqual((await peopleStore.read(f.session.identity())).data, { ...sourceWorkspace, chatId: IMPORTED });
  const again = await parseMemoryPackage((await f.runtime.exportCurrent()).text);
  assert.deepEqual(again.value.records.find(record => record.id === 'v3-people-workspace').data, { ...sourceWorkspace, chatId: IMPORTED });
  assert.deepEqual(f.ctx.chat, sourceBody);
  assert.deepEqual([...f.backend.records].filter(([key]) => key.startsWith(`chat-${SOURCE}/`)), sourceRecords);
  assert.equal(modelCalls, 0);
});


test('所有时间事项人工字段经公开编辑与冷加载完整迁移', async () => {
  const body = '<!-- QQJ-start | date=2026-05-01 | weekday=周一 | time=08:00 -->阿岚的手腕擦伤仍疼，阿雪的膝盖擦伤。阿岚每七天检查伤口，并约好五月十日归还钥匙。<!-- QQJ-end | date=2026-05-01 | weekday=周一 | time=09:00 -->';
  const f = await fixture({ body, chat: [{ is_user: false, is_system: false, mes: body, swipes: [body], swipe_id: 0 }, { is_user: true, is_system: false, mes: '继续', send_date: 'manual-time-test' }] });
  const foundationStore = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const timeStore = createTimeStore({ client: f.backend.client });
  let allowModel = true, calls = 0;
  const generate = async task => {
    assert.equal(allowModel, true, '人工编辑、迁移及冷读不得请求模型'); calls += 1;
    const request = JSON.parse(task.taskMessages[0].content);
    if (request.currentReview) return { changes: request.trackedItems.map(item => ({ itemId: item.id, progression: item.type === 'deadline' ? '' : '可能仍有轻微不适，恢复尚未确认。', assessmentReason: item.type === 'deadline' ? '等待归还观察' : '' })) };
    return { changes: [
      ['阿岚', 'body', '手腕擦伤', '手腕擦伤仍疼痛', null, ''],
      ['阿雪', 'body', '膝盖擦伤', '膝盖擦伤', null, ''],
      ['阿岚', 'cycle', '伤口检查', '每七天检查伤口', 7, ''],
      ['阿岚', 'deadline', '归还钥匙', '约定归还钥匙', null, '2026-05-10 12:00'],
    ].map(([subjectName, type, label, observation, periodDays, dueTime]) => ({ itemId: null, subjectEntityId: null, subjectName, type, label, observation, occurrenceTime: '2026-05-01 08:00', dueTime, periodDays, status: 'active', stateRefs: [], progression: type === 'deadline' ? '' : '仍待后续观察确认。', sourceKeys: [request.observations[0].sourceKey] })) };
  };
  const options = { store: timeStore, foundationStore, hostAdapter: f.host, session: f.session, getReachable: () => f.graph,
    getMemoryState: () => ({ memorySyncStatus: 'idle' }), isEnabled: () => true, newUuid: uuidFactory(), logger: { warn() {} }, generateTimeTask: generate };
  const time = createTimeRuntime(options);
  await time.organize(await time.prepareHistoryPlan());
  assert.equal(time.getState().trackedItems.length, 4);
  allowModel = false;
  const seededCalls = calls;
  const all = () => [...time.getState().trackedItems, ...time.getState().stoppedItems];
  const byLabel = label => all().find(item => item.label === label);
  const edit = async (item, fields) => { await time.editItem(item.id, fields, item.observationKey); return all().find(value => value.id === item.id); };
  let bodyItem = byLabel('手腕擦伤');
  assert.ok(bodyItem.projection, '正文带真实时间，模型种子应产生当前有效推测');
  bodyItem = await edit(bodyItem, { projectionText: '人工修订：仍有轻微不适，是否恢复尚待确认。' });
  assert.equal(bodyItem.projection, '人工修订：仍有轻微不适，是否恢复尚待确认。');
  bodyItem = await edit(bodyItem, { subjectEntityId: byLabel('膝盖擦伤').subjectEntityId });
  assert.equal(bodyItem.subjectEntityId, byLabel('膝盖擦伤').subjectEntityId);
  assert.equal(bodyItem.projection, '人工修订：仍有轻微不适，是否恢复尚待确认。');
  const deadline = await edit(byLabel('归还钥匙'), { label: '人工期限名称', observation: '人工核实：钥匙仍在木盒，等待归还。',
    observationTime: '2026-05-01 09:15', occurrenceTime: '2026-04-30 20:00', dueTime: '2026-05-12 18:00', periodDays: 3, status: 'paused' });
  assert.equal(deadline.observationTime.date, '2026-05-01'); assert.equal(deadline.occurrenceTime.date, '2026-04-30'); assert.equal(deadline.dueTime.date, '2026-05-12');
  assert.equal(deadline.label, '人工期限名称'); assert.equal(deadline.observation, '人工核实：钥匙仍在木盒，等待归还。'); assert.equal(deadline.periodDays, 3); assert.equal(deadline.status, 'paused');
  let cycle = await edit(byLabel('伤口检查'), { periodDays: 9, occurrenceTime: '2026-05-02 08:00' });
  assert.equal(cycle.periodDays, 9);
  await time.editItems([bodyItem, cycle].map(item => ({ itemId: item.id, observationKey: item.observationKey, fields: { status: 'paused' } })));
  const paused = all().filter(item => [bodyItem.id, cycle.id].includes(item.id)); assert.ok(paused.every(item => item.status === 'paused'));
  await time.editItems(paused.map(item => ({ itemId: item.id, observationKey: item.observationKey, fields: { status: 'active' } })));
  await edit(all().find(item => item.id === deadline.id), { status: 'completed' });
  await edit(all().find(item => item.id === deadline.id), { status: 'active' });
  // Final independent projection edit survives as a user value alongside edited facts.
  // Pausing correctly clears its estimate; another body item still retains a valid projection.
  const otherBody = byLabel('膝盖擦伤'); assert.ok(otherBody.projection);
  await edit(otherBody, { projectionText: '人工保留的当前膝盖推测。' });
  assert.equal(calls, seededCalls);
  const before = await timeStore.read(SOURCE);
  const beforeBody = await readTimeBody(f.graph, f.host.snapshot());
  const expectedItems = replayTimeBatches(before.batches, beforeBody);
  const exported = await f.runtime.exportCurrent();
  await f.target(); await f.runtime.importPreview(await f.runtime.preview(exported.text));
  const importedStore = createTimeStore({ client: f.backend.client });
  const importedGraph = await createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() }).readReachable({ mode: 'full' });
  const cold = createTimeRuntime({ ...options, store: importedStore, getReachable: () => importedGraph });
  await cold.refreshStatus({ force: true });
  const after = await importedStore.read(IMPORTED);
  assert.deepEqual(after.head, { ...before.head, chatId: IMPORTED });
  assert.deepEqual(after.batches, before.batches.map(batch => ({ ...batch, chatId: IMPORTED })));
  const importedBody = await readTimeBody(importedGraph, f.host.snapshot());
  assert.deepEqual(replayTimeBatches(after.batches, importedBody), expectedItems);
  assert.equal([...cold.getState().trackedItems, ...cold.getState().stoppedItems].find(item => item.label === '膝盖擦伤').projection, '人工保留的当前膝盖推测。');
  const reexported = JSON.parse((await f.runtime.exportCurrent()).text);
  assert.deepEqual(reexported.records.find(item => item.id === 'v3-time-head').data, after.head);
  for (const batch of after.batches) assert.deepEqual(reexported.records.find(item => item.id === batch.id).data, batch);
  assert.equal(calls, seededCalls);
  return { seededCalls, manualEditsWithoutModel: true, items: expectedItems.length, timeBatches: after.batches.length,
    fields: ['label', 'observation', 'observationTime', 'occurrenceTime', 'dueTime', 'periodDays', 'subjectEntityId', 'status', 'projectionText'], publicApis: ['editItem', 'editItems', 'refreshStatus'] };
});

test('公开排除楼入口的标记导入与撤销完整往返', async () => {
  const f = await fixture();
  const result = await f.memory.setMemoryExcluded(3, true);
  assert.equal(result.status, 'persisted');
  assert.equal(f.ctx.chat[3].extra.qianqianjie_memory_excluded, true);
  f.api.reloadFromContext();
  const exported = await f.runtime.exportCurrent();
  const target = await f.target(); delete target.chat[3].extra.qianqianjie_memory_excluded; f.api.reloadFromContext();
  await f.runtime.importPreview(await f.runtime.preview(exported.text));
  assert.equal(target.chat[3].extra.qianqianjie_memory_excluded, true);
  await f.runtime.undo(); assert.equal(target.chat[3].extra.qianqianjie_memory_excluded, undefined);
  return { publicApi: 'memory.setMemoryExcluded', importedAndUndone: true };
});

test('人工解除时间事项归并经迁移冷加载保留独立事项', async () => {
  const chat = [];
  for (let n = 1; n <= 3; n += 1) {
    const body = `<!-- QQJ-start | date=2026-05-0${n} | weekday=周一 | time=08:00 -->阿岚同一场景中手腕和膝盖都有轻微擦伤。<!-- QQJ-end | date=2026-05-0${n} | weekday=周一 | time=09:00 -->`;
    chat.push({ is_user: false, is_system: false, mes: body, swipes: [body], swipe_id: 0 }, { is_user: true, is_system: false, mes: '继续', send_date: `merge-${n}` });
  }
  const f = await fixture({ chat }), timeStore = createTimeStore({ client: f.backend.client });
  const foundationStore = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  let calls = 0, allowModel = true;
  const options = { store: timeStore, foundationStore, hostAdapter: f.host, session: f.session, getReachable: () => f.graph, getMemoryState: () => ({ memorySyncStatus: 'idle' }),
    isEnabled: () => true, newUuid: uuidFactory(), logger: { warn() {} }, generateTimeTask: async task => {
      assert.equal(allowModel, true); calls += 1; const request = JSON.parse(task.taskMessages[0].content);
      if (request.currentReview) return { changes: request.trackedItems.map(item => ({ itemId: item.id, progression: '共同影响可能仍然存在，待新观察确认。', assessmentReason: '' })),
        merges: [{ itemId: request.trackedItems[0].id, mergedItemIds: [request.trackedItems[1].id], description: '同一场景的共同轻微影响，保留手腕与膝盖各自观察。' }] };
      return { changes: request.observations.map((row, n) => ({ itemId: null, subjectEntityId: null, subjectName: '阿岚', type: 'body', label: `轻微影响${n}`, observation: n === 0 ? '同一场景手腕擦伤' : '同一场景膝盖擦伤',
        occurrenceTime: '', dueTime: '', periodDays: null, status: 'active', stateRefs: [], progression: '', sourceKeys: [row.sourceKey] })) };
    } };
  const time = createTimeRuntime(options); await time.organize(await time.prepareHistoryPlan());
  let member = time.getState().stoppedItems.find(item => item.mergedInto); assert.ok(member, JSON.stringify(time.getState()));
  const parentId = member.mergedInto, memberId = member.id; allowModel = false; const seededCalls = calls;
  await time.editItem(member.id, { status: 'active', label: '人工恢复为独立事项' }, member.observationKey);
  const restored = time.getState().trackedItems.find(item => item.id === memberId), parent = time.getState().trackedItems.find(item => item.id === parentId);
  assert.equal(restored.mergedInto, null); assert.equal(parent.hasMergedMembers, false); assert.equal(parent.mergeDescription, null); assert.equal(parent.projection, null);
  const before = await timeStore.read(SOURCE), expected = replayTimeBatches(before.batches, await readTimeBody(f.graph, f.host.snapshot()));
  const exported = await f.runtime.exportCurrent(); await f.target(); await f.runtime.importPreview(await f.runtime.preview(exported.text));
  const graph = await createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() }).readReachable({ mode: 'full' });
  const importedStore = createTimeStore({ client: f.backend.client }), cold = createTimeRuntime({ ...options, store: importedStore, getReachable: () => graph }); await cold.refreshStatus({ force: true });
  const after = await importedStore.read(IMPORTED); assert.deepEqual(after.head, { ...before.head, chatId: IMPORTED }); assert.deepEqual(after.batches, before.batches.map(batch => ({ ...batch, chatId: IMPORTED })));
  assert.deepEqual(replayTimeBatches(after.batches, await readTimeBody(graph, f.host.snapshot())), expected);
  assert.equal(cold.getState().trackedItems.find(item => item.id === memberId).label, '人工恢复为独立事项');
  const reexported = JSON.parse((await f.runtime.exportCurrent()).text); for (const batch of after.batches) assert.deepEqual(reexported.records.find(item => item.id === batch.id).data, batch);
  assert.equal(calls, seededCalls); return { publicApi: 'editItem(status=active)', manualUnmergePreserved: true, seededCalls, timeBatches: after.batches.length };
});

test('undo preserves new manual people time calendar and prequel edits when the core root is unchanged', async t => {
  for (const field of ['people', 'time', 'calendar', 'prequel']) await t.test(field, async () => {
    const calendars = new Map();
    const f = await fixture({ transferOptions: {
      captureCalendar: chatId => calendars.get(chatId) ?? null,
      persistCalendar: async (chatId, calendar) => calendars.set(chatId, calendar),
    } });
    const target = await f.target();
    await f.runtime.importPreview(await f.runtime.preview(f.exported.text));
    const root = structuredClone(f.backend.records.get(`chat-${IMPORTED}/v3-root`));
    if (field === 'people') {
      await createPeopleWorkspaceStore({ client: f.backend.client }).put(f.session.identity(), {
        schemaVersion: 3, kind: 'qqj-v3-people-workspace', chatId: IMPORTED, selectedEntityIds: [], personOrderEntityIds: [],
        profilesByEntityId: {}, avatarsByEntityId: {}, avatarSourcesByEntityId: {}, identityRedirectsByEntityId: {},
        deletedEntityIds: [], profileMaterialProgressByEntityId: {}, createdAt: NOW, updatedAt: NOW,
      }, 0);
    }
    if (field === 'time') {
      const store = createTimeStore({ client: f.backend.client }), id = 'v3-time-batch-dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      await store.putBatch(IMPORTED, { schemaVersion: 1, chatId: IMPORTED, id, changes: [] });
      await store.putHead(IMPORTED, { schemaVersion: 1, chatId: IMPORTED, batchIds: [id] }, 0);
    }
    if (field === 'calendar') calendars.set(IMPORTED, { months: 4, prefix: '人工改历' });
    if (field === 'prequel') { target.chatMetadata.qianqianjiePrequel = '导入后新写的人工前情'; f.api.reloadFromContext(); }
    assert.deepEqual(f.backend.records.get(`chat-${IMPORTED}/v3-root`), root);
    const records = structuredClone([...f.backend.records]), saves = f.api.saves;
    await assert.rejects(f.runtime.undo(), /导入后的.*已变化/);
    assert.equal(target.chatMetadata.qianqianjie.chatId, IMPORTED);
    assert.deepEqual([...f.backend.records], records);
    assert.equal(f.api.saves, saves);
    if (field === 'calendar') assert.deepEqual(calendars.get(IMPORTED), { months: 4, prefix: '人工改历' });
    if (field === 'prequel') assert.equal(target.chatMetadata.qianqianjiePrequel, '导入后新写的人工前情');
  });
});

test('undo preserves changes and deletion of imported auxiliary records while the core root is unchanged', async t => {
  for (const change of ['edit', 'delete']) await t.test(change, async () => {
    const f = await fixture();
    const timeStore = createTimeStore({ client: f.backend.client });
    await timeStore.putHead(SOURCE, { schemaVersion: 1, chatId: SOURCE, batchIds: [], bodyStart: 0 }, 0);
    const exported = await f.runtime.exportCurrent(), target = await f.target();
    await f.runtime.importPreview(await f.runtime.preview(exported.text));
    const root = structuredClone(f.backend.records.get(`chat-${IMPORTED}/v3-root`));
    const key = `chat-${IMPORTED}/v3-time-head`, importedHead = f.backend.records.get(key);
    if (change === 'edit') await timeStore.putHead(IMPORTED, { ...importedHead.data, bodyStart: 1 }, importedHead.revision);
    else f.backend.records.delete(key);
    assert.deepEqual(f.backend.records.get(`chat-${IMPORTED}/v3-root`), root);
    const records = structuredClone([...f.backend.records]), saves = f.api.saves;
    await assert.rejects(f.runtime.undo(), /导入后的.*已变化/);
    assert.equal(target.chatMetadata.qianqianjie.chatId, IMPORTED);
    assert.deepEqual([...f.backend.records], records);
    assert.equal(f.api.saves, saves);
  });
});
