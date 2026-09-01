import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ARCHIVE_V2_MEMORY_MANIFEST_RECORD_ID,
  createArchiveV2MemoryBatchRecordId,
  createArchiveV2MemoryStore,
} from '../src/archive-v2-memory-store.js';
import {
  createArchiveV2MemoryBatch,
  createArchiveV2MemoryManifest,
  createArchiveV2MemorySnapshot,
} from '../src/archive-v2-memory-foundation.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_CHAT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TIME = '2026-08-31T10:20:30.000Z';

const assistant = content => ({
  is_user: false, is_system: false, mes: content, swipe_id: 0, swipes: [content], extra: {},
});

function rawContext(contents = ['正文一', '正文二']) {
  return {
    characterId: 0,
    characters: [{ avatar: 'character.png' }],
    userAvatar: 'persona.png',
    chatId: 'host-chat',
    chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT } },
    chat: contents.map(assistant),
  };
}

function identity(overrides = {}) {
  return {
    hostChatId: 'host-chat',
    chatId: CHAT,
    characterLocator: 'character.png',
    personaLocator: 'persona.png',
    ...overrides,
  };
}

function envelope(data, revision = 1, overrides = {}) {
  return {
    schemaVersion: 1,
    revision,
    generationId: '11111111-1111-4111-8111-111111111111',
    createdAt: TIME,
    updatedAt: TIME,
    data: structuredClone(data),
    ...overrides,
  };
}

const httpError = status => Object.assign(new Error(`HTTP ${status}`), { status });
const emptyRows = () => ({ people: [], facts: [], relations: [], events: [] });

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('等待异步测试条件超时');
}

async function fixture() {
  const snapshot = await createArchiveV2MemorySnapshot(rawContext(), { maxFloorsPerBatch: 1 });
  const manifest = createArchiveV2MemoryManifest({ snapshot, scanId: 'scan-1', createdAt: TIME });
  const plan = snapshot.batches[0];
  const batch = createArchiveV2MemoryBatch({ manifest, plan, rows: emptyRows(), createdAt: TIME });
  const recordId = await createArchiveV2MemoryBatchRecordId({
    scanId: manifest.scanId,
    batchIndex: plan.batchIndex,
    sourceFingerprint: plan.sourceFingerprint,
  });
  return { snapshot, manifest, plan, batch, recordId };
}

function harness({ get, put, enabled = true } = {}) {
  let current = identity();
  const calls = [];
  const client = {
    async get(...args) {
      calls.push(['get', ...args]);
      if (get) return get(...args);
      throw httpError(404);
    },
    async put(...args) {
      calls.push(['put', ...args]);
      if (put) return put(...args);
      throw new Error('unexpected put');
    },
  };
  const store = createArchiveV2MemoryStore({
    client,
    contextProvider: () => current,
    isEnabled: typeof enabled === 'function' ? enabled : () => enabled,
  });
  return { store, calls, setContext(value) { current = value; } };
}

test('固定路径与 batch recordId 确定、隔离 scan 且满足后端长度限制', async () => {
  const { manifest, plan } = await fixture();
  const args = { scanId: manifest.scanId, batchIndex: plan.batchIndex, sourceFingerprint: plan.sourceFingerprint };
  const first = await createArchiveV2MemoryBatchRecordId(args);
  const second = await createArchiveV2MemoryBatchRecordId(args);
  const other = await createArchiveV2MemoryBatchRecordId({ ...args, scanId: 'scan-2' });
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.match(first, /^memory-batch-0-[0-9a-f]{64}$/);
  assert.ok(first.length <= 128 && Buffer.byteLength(first, 'utf8') <= 512);

  const h = harness();
  assert.deepEqual(await h.store.readManifest(), { status: 'uninitialized' });
  assert.deepEqual(h.calls[0], ['get', `chat-${CHAT}`, ARCHIVE_V2_MEMORY_MANIFEST_RECORD_ID]);
});

test('manifest 合法 envelope 安全复制，create 只用 revision 0，save 使用正 revision 且 409 不重试', async () => {
  const { manifest } = await fixture();
  let revision = 1;
  const h = harness({
    get: async () => envelope(manifest, revision),
    put: async (_collection, _recordId, data, expectedRevision) => {
      assert.equal(expectedRevision, revision === 1 ? 0 : 2);
      revision += 1;
      return envelope(data, revision);
    },
  });
  const read = await h.store.readManifest();
  assert.equal(read.status, 'ready');
  assert.equal(read.revision, 1);
  const created = await h.store.createManifest({ manifest });
  assert.equal(created.status, 'created');
  const saved = await h.store.saveManifest({ manifest, expectedRevision: 2 });
  assert.equal(saved.status, 'saved');
  assert.throws(() => { read.manifest.status = 'broken'; }, TypeError);
  assert.equal(read.manifest.status, 'scanning');

  let puts = 0;
  const conflict = harness({ put: async () => { puts += 1; throw httpError(409); } });
  assert.deepEqual(await conflict.store.createManifest({ manifest }), { status: 'conflict' });
  assert.deepEqual(await conflict.store.saveManifest({ manifest, expectedRevision: 1 }), { status: 'conflict' });
  assert.equal(puts, 2);
  await assert.rejects(conflict.store.saveManifest({ manifest, expectedRevision: 0 }), TypeError);
});

test('严格 envelope 拒绝 getter、循环、未知字段、错误 revision/kind/chat/plan/scan', async () => {
  const { manifest, plan, batch, recordId } = await fixture();
  const candidates = [];
  const getter = envelope(manifest);
  Object.defineProperty(getter, 'data', { enumerable: true, get() { throw new Error('SECRET'); } });
  candidates.push(getter);
  const circular = envelope(manifest);
  circular.self = circular;
  candidates.push(circular);
  candidates.push({ ...envelope(manifest), unknown: true });
  candidates.push(envelope(manifest, 0));
  candidates.push(envelope({ ...structuredClone(manifest), kind: 'wrong-kind' }));
  candidates.push(envelope({ ...structuredClone(manifest), chatId: OTHER_CHAT }));
  for (const candidate of candidates) {
    const h = harness({ get: async () => candidate });
    await assert.rejects(h.store.readManifest(), TypeError);
  }

  for (const changed of [
    { batch: { ...structuredClone(batch), scanId: 'scan-other' }, scanId: 'scan-1', plan },
    { batch, scanId: 'scan-other', plan },
    { batch, scanId: 'scan-1', plan: { ...structuredClone(plan), floorEnd: 99 } },
  ]) {
    const h = harness({ get: async () => envelope(changed.batch) });
    await assert.rejects(
      h.store.readBatch({ recordId, plan: changed.plan, expectedScanId: changed.scanId }),
      TypeError,
    );
  }
});

test('immutable batch PUT 只用 revision 0；409 后仅相同 winner 复用，不同 winner 冲突', async () => {
  const { plan, batch, recordId } = await fixture();
  const saved = harness({ put: async (_collection, _id, data, revision) => {
    assert.equal(revision, 0);
    return envelope(data);
  } });
  const result = await saved.store.putBatch({ recordId, batch, plan });
  assert.equal(result.status, 'saved');
  assert.equal(saved.calls.filter(call => call[0] === 'put').length, 1);

  for (const same of [true, false]) {
    let gets = 0;
    const winner = same ? batch : { ...structuredClone(batch), createdAt: '2026-08-31T10:20:31.000Z' };
    const h = harness({
      put: async () => { throw httpError(409); },
      get: async () => { gets += 1; return envelope(winner, 3); },
    });
    const reused = await h.store.putBatch({ recordId, batch, plan });
    assert.equal(reused.status, same ? 'reused' : 'conflict');
    assert.equal(gets, 1);
    assert.equal(h.calls.filter(call => call[0] === 'put').length, 1);
  }
});

test('404 batch 为 missing；身份、invalidate、disabled 的调用前后守卫不交付迟到值', async () => {
  const { plan, batch, recordId } = await fixture();
  const missing = harness();
  assert.deepEqual(
    await missing.store.readBatch({ recordId, plan, expectedScanId: 'scan-1' }),
    { status: 'missing' },
  );

  for (const mode of ['chat', 'character', 'persona', 'invalidate', 'disabled']) {
    let release;
    let enabled = true;
    const h = harness({
      enabled: () => enabled,
      get: () => new Promise(resolve => { release = () => resolve(envelope(batch)); }),
    });
    const pending = h.store.readBatch({ recordId, plan, expectedScanId: 'scan-1' });
    await waitUntil(() => typeof release === 'function');
    if (mode === 'chat') h.setContext(identity({ hostChatId: 'host-other', chatId: OTHER_CHAT }));
    if (mode === 'character') h.setContext(identity({ characterLocator: 'other.png' }));
    if (mode === 'persona') h.setContext(identity({ personaLocator: 'other.png' }));
    if (mode === 'invalidate') h.store.invalidate();
    if (mode === 'disabled') enabled = false;
    release();
    const result = await pending;
    assert.equal(result.status, mode === 'disabled' ? 'disabled' : 'stale');
  }

  const off = harness({ enabled: false });
  assert.deepEqual(await off.store.readManifest(), { status: 'disabled' });
  assert.equal(off.calls.length, 0);
});

test('模块只消费通用 get/put，不包含 delete/list/专用后端或 UI', async () => {
  const source = await readFile(new URL('../src/archive-v2-memory-store.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /backend-client|ST-BaiNiaoData|client\.delete\(|client\.list\(|document\.|querySelector|innerHTML/);
});
