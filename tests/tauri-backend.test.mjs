import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createTauriBackendFetch, isTauriTavern } from '../src/tauri-backend.js';
import { createBackendClient } from '../src/backend-client.js';
import { API_BASE } from '../src/constants.js';
import { createFoundationStore } from '../src/v3/foundation-store.js';
import { createFoundationRuntime } from '../src/v3/foundation-runtime.js';
import { createHostAdapter } from '../src/v3/host-adapter.js';

// Match serde_json's sorted maps, including nested objects, rather than a JS
// round-trip that accidentally preserves ordering across the native boundary.
const nativeJson = value => Array.isArray(value) ? value.map(nativeJson) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, nativeJson(value[key])])) : value;

// File-backed double of TT 2.2.0's public API. No real user files or model calls.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'qqj-tt-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let failWrite = false, failRead = false, writeCount = 0;
  const location = ({ namespace, table = 'main', key }) => {
    for (const value of [namespace, table, ...(key === undefined ? [] : [key])]) {
      assert.match(value, /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/);
      assert.ok(value.length < 200);
    }
    return key === undefined ? join(root, namespace, table) : join(root, namespace, table, `${key}.json`);
  };
  const names = async path => { try { return await readdir(path); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
  const store = {
    async tryGetJson(opts) {
      if (failRead) throw new Error('read failure');
      try { return { found: true, value: JSON.parse(await readFile(location(opts), 'utf8')) }; }
      catch (e) { if (e.code === 'ENOENT') return { found: false }; throw e; }
    },
    async setJson(opts) {
      if (failWrite) throw new Error('write failure');
      const path = location(opts);
      await mkdir(location({ ...opts, key: undefined }), { recursive: true });
      await writeFile(`${path}.tmp`, JSON.stringify(nativeJson(opts.value)));
      await rename(`${path}.tmp`, path);
      writeCount++;
    },
    async deleteJson(opts) {
      if (failWrite) throw new Error('write failure');
      await rm(location(opts));
      writeCount++;
    },
    async listKeys(opts) { return (await names(location(opts))).filter(n => n.endsWith('.json')).map(n => n.slice(0, -5)); },
    async listTables({ namespace }) { if (failRead) throw new Error('read failure'); return names(join(root, namespace)); },
  };
  const globalRef = { crypto: globalThis.crypto, __TAURITAVERN__: { ready: Promise.resolve(), api: { extension: { store } } } };
  const fetchImpl = createTauriBackendFetch({ globalRef });
  const client = createBackendClient({ fetchImpl });
  const request = (path, method = 'GET', body) => fetchImpl(`${API_BASE}/v1/${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { client, request, store, globalRef, root, fetchImpl, writes: () => writeCount,
    failWrite: value => { failWrite = value; }, failRead: value => { failRead = value; } };
}

test('TT health checks native IO; read/put/list survive a new client/runtime', async t => {
  const f = await fixture(t);
  assert.equal((await f.client.health()).storage.scope, 'tauritavern-data-root');
  const created = await f.client.put('聊天🙂', '记录'.repeat(64), { text: '记忆🙂', array: [null, 3] }, 0);
  assert.equal(created.revision, 1);
  const restarted = createBackendClient({ fetchImpl: createTauriBackendFetch({ globalRef: { ...f.globalRef } }) });
  assert.deepEqual(await restarted.get('聊天🙂', '记录'.repeat(64)), created);
  assert.deepEqual(await restarted.list('聊天🙂'), [{ recordId: '记录'.repeat(64), ...created }]);
  assert.deepEqual(await restarted.list('other'), []);
  f.failRead(true);
  await assert.rejects(f.client.health(), /read failure/);
});

test('TT preserves JSON field order through native save, cold read, list and trash restore', async t => {
  const f = await fixture(t);
  const value = { z: 1, a: [{ recordType: 'floor', recordId: 'test', itemId: null }], nested: { second: 2, first: 1 } };
  const saved = await f.client.put('c', 'r', value, 0);
  const cold = createBackendClient({ fetchImpl: createTauriBackendFetch({ globalRef: { ...f.globalRef } }) });
  assert.equal(JSON.stringify((await cold.get('c', 'r')).data), JSON.stringify(value));
  assert.equal(JSON.stringify((await cold.list('c'))[0].data), JSON.stringify(value));
  const deleted = await cold.remove('c', 'r', saved.revision);
  const response = await f.request(`trash/qianqianjie/${deleted.trashId}/restore`, 'POST');
  assert.equal(JSON.stringify((await response.json()).data), JSON.stringify(value));
  assert.equal(JSON.stringify((await cold.get('c', 'r')).data), JSON.stringify(value));
});

function foundationFor(client, context) {
  const store = createFoundationStore({ client, contextProvider: () => ({ hostChatId: context.chatId,
    chatId: context.chatMetadata.qianqianjie.chatId, characterLocator: 'char.png', personaLocator: 'me.png' }) });
  const runtime = createFoundationRuntime({ store, hostAdapter: createHostAdapter({ globalRef: { SillyTavern: { getContext: () => context } } }),
    contextProvider: () => context, logger: { warn() {} } });
  return { store, runtime };
}
const failedInitFixture = () => readFile(new URL('./fixtures/tt2-native-init-failure.json', import.meta.url), 'utf8').then(JSON.parse);
const nativeKey = text => `r-${createHash('sha256').update(text).digest('hex')}`;
async function seedLegacy(f, slot) {
  await f.store.setJson({ namespace: 'qqj-bainiao-v1', table: nativeKey(JSON.stringify([slot.namespace, slot.collection])),
    key: nativeKey(slot.recordId), value: slot });
}

test('TT first foundation initialization and cold graph read survive actual native key ordering', async t => {
  const f = await fixture(t);
  const { context } = await failedInitFixture();
  const { runtime } = foundationFor(f.client, context);
  const state = await runtime.start();
  assert.equal(state.status, 'ready', state.lastError);
  assert.equal(state.stableCount, 1);
  const { store } = foundationFor(createBackendClient({ fetchImpl: createTauriBackendFetch({ globalRef: { ...f.globalRef } }) }), context);
  const read = await store.readReachable();
  assert.equal(read.status, 'ready');
  assert.equal(read.floors.length, 1);
  assert.equal(read.indexes.length, 1);
});

test('TT retries the genuine tt.2 failed initialization without deleting records or changing old fingerprints', async t => {
  const f = await fixture(t);
  const { context, slots } = await failedInitFixture();
  for (const slot of slots) await seedLegacy(f, slot);
  const oldIndex = slots.find(slot => slot.current?.data?.recordType === 'index').current.data;
  const { runtime } = foundationFor(f.client, context);
  const state = await runtime.start();
  assert.equal(state.status, 'ready', state.lastError);
  assert.equal(state.stableCount, 1);
  const read = await foundationFor(f.client, context).store.readReachable();
  assert.equal(read.status, 'ready');
  assert.equal(read.indexes[0].id, oldIndex.id);
  assert.equal(read.indexes[0].contentFingerprint, oldIndex.contentFingerprint);
  const records = await f.client.list(slots[0].collection);
  for (const slot of slots) assert.ok(records.some(record => record.recordId === slot.recordId));
  assert.deepEqual(await (await f.request('trash/qianqianjie')).json(), []);
});

test('TT legacy index recovery cannot hide modified data or checksum mismatches', async t => {
  const f = await fixture(t);
  const { context, slots } = await failedInitFixture();
  const indexSlot = slots.find(slot => slot.current?.data?.recordType === 'index');
  indexSlot.current.data.entries[0].refs[0].itemId = 'tampered';
  for (const slot of slots) await seedLegacy(f, slot);
  const state = await foundationFor(f.client, context).runtime.start();
  assert.equal(state.status, 'error');
  await assert.rejects(f.client.get(indexSlot.collection, 'v3-root'), e => e.status === 404);
  assert.deepEqual((await f.client.get(indexSlot.collection, indexSlot.recordId)).data, indexSlot.current.data);
});

test('TT malformed serialized slots fail closed instead of becoming empty data', async t => {
  const f = await fixture(t);
  const namespace = 'qqj-bainiao-v1', table = nativeKey(JSON.stringify(['qianqianjie', 'c'])), key = nativeKey('r');
  await f.store.setJson({ namespace, table, key, value: { format: 'qqj-tt-json-v2', serialized: '{bad' } });
  await assert.rejects(f.client.get('c', 'r'), e => e.status === 500);
  await assert.rejects(f.client.put('c', 'r', 'replacement', 0), e => e.status === 500);
});

test('TT two clients racing on the same revision produce one success and one 409', async t => {
  const f = await fixture(t);
  const second = createBackendClient({ fetchImpl: createTauriBackendFetch({ globalRef: f.globalRef }) });
  const results = await Promise.allSettled([f.client.put('c', 'r', { n: 1 }, 0), second.put('c', 'r', { n: 2 }, 0)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.find(x => x.status === 'rejected').reason.status, 409);
  assert.equal((await f.client.get('c', 'r')).revision, 1);
  assert.equal(f.writes(), 1);
});

test('TT update preserves creation/generation and stale delete cannot erase data', async t => {
  const f = await fixture(t);
  const one = await f.client.put('c', 'r', { a: 1 }, 0);
  const two = await f.client.put('c', 'r', { a: 2 }, 1);
  assert.equal(two.createdAt, one.createdAt);
  assert.equal(two.generationId, one.generationId);
  assert.equal(two.revision, 2);
  await assert.rejects(f.client.remove('c', 'r', 1), e => e.status === 409);
  assert.deepEqual(await f.client.get('c', 'r'), two);
});

test('TT delete is one atomic write and trash restore preserves the original envelope', async t => {
  const f = await fixture(t);
  const one = await f.client.put('c', 'r', { a: 1 }, 0);
  const deleted = await f.client.remove('c', 'r', 1);
  assert.equal(f.writes(), 2);
  await assert.rejects(f.client.get('c', 'r'), e => e.status === 404);
  assert.deepEqual(await f.client.list('c'), []);
  const trash = await (await f.request('trash/qianqianjie')).json();
  assert.equal(trash[0].trashId, deleted.trashId);
  assert.equal(Object.hasOwn(trash[0], 'envelope'), false);
  const restored = await f.request(`trash/qianqianjie/${deleted.trashId}/restore`, 'POST');
  assert.deepEqual(await restored.json(), one);
  assert.deepEqual(await (await f.request('trash/qianqianjie')).json(), []);
});

test('TT delete/recreate preserves old generations; restore conflicts with new record', async t => {
  const f = await fixture(t);
  const one = await f.client.put('c', 'r', 'old', 0);
  const deleted = await f.client.remove('c', 'r', 1);
  const two = await f.client.put('c', 'r', 'new', 0);
  assert.notEqual(two.generationId, one.generationId);
  assert.equal((await f.request(`trash/qianqianjie/${deleted.trashId}/restore`, 'POST')).status, 409);
  await f.client.remove('c', 'r', 1);
  assert.equal((await (await f.request('trash/qianqianjie')).json()).length, 2);
});

test('TT tt.2 reads and updates the tt.1 on-disk format without moving old memory', async t => {
  const f = await fixture(t);
  const hash = text => `r-${createHash('sha256').update(text).digest('hex')}`;
  const saved = { schemaVersion: 1, revision: 7, generationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T01:00:00.000Z', data: { text: '旧版记忆', manual: '手动修订' } };
  const table = hash(JSON.stringify(['qianqianjie', 'old-chat']));
  const key = hash('v3-floor-memory-old');
  await f.store.setJson({ namespace: 'qqj-bainiao-v1', table, key, value: {
    format: 'qqj-tt-record-v1', namespace: 'qianqianjie', collection: 'old-chat', recordId: 'v3-floor-memory-old', current: saved, trash: [],
  } });
  assert.deepEqual(await f.client.get('old-chat', 'v3-floor-memory-old'), saved);
  assert.deepEqual(await f.client.list('old-chat'), [{ recordId: 'v3-floor-memory-old', ...saved }]);
  const updated = await f.client.put('old-chat', 'v3-floor-memory-old', { ...saved.data, added: '新版补充' }, 7);
  assert.equal(updated.revision, 8);
  assert.equal(updated.generationId, saved.generationId);
  assert.equal(updated.data.manual, '手动修订');
  assert.deepEqual(await f.store.listKeys({ namespace: 'qqj-bainiao-v1', table }), [key]);
});

test('TT permanent deletion releases the current file without creating trash and permits recreation', async t => {
  const f = await fixture(t);
  assert.equal((await f.client.health()).capabilities.permanentDelete, true);
  const old = await f.client.put('c', 'r', { text: 'obsolete' }, 0);
  assert.deepEqual(await f.client.removePermanent('c', 'r', 1), { permanentlyDeleted: true, deletedRevision: 1 });
  await assert.rejects(f.client.get('c', 'r'), e => e.status === 404);
  assert.deepEqual(await f.client.list('c'), []);
  assert.deepEqual(await (await f.request('trash/qianqianjie')).json(), []);
  const namespace = 'qqj-bainiao-v1';
  const [table] = await f.store.listTables({ namespace });
  assert.deepEqual(await f.store.listKeys({ namespace, table }), []);
  const created = await f.client.put('c', 'r', { text: 'new' }, 0);
  assert.notEqual(created.generationId, old.generationId);
  assert.equal(created.revision, 1);
});

test('TT permanent deletion preserves earlier trash generations across restart', async t => {
  const f = await fixture(t);
  const old = await f.client.put('c', 'r', { text: 'old generation' }, 0);
  const deleted = await f.client.remove('c', 'r', 1);
  await f.client.put('c', 'r', { text: 'permanently removed generation' }, 0);
  await f.client.removePermanent('c', 'r', 1);
  const fetchAfterRestart = createTauriBackendFetch({ globalRef: { ...f.globalRef } });
  const restored = await fetchAfterRestart(`${API_BASE}/v1/trash/qianqianjie/${deleted.trashId}/restore`, { method: 'POST' });
  assert.deepEqual(await restored.json(), old);
  assert.deepEqual(await f.client.get('c', 'r'), old);
});

test('TT permanent deletion refuses stale/missing/invalid requests and leaves data on native IO failure', async t => {
  const f = await fixture(t);
  const saved = await f.client.put('c', 'r', 'keep', 0);
  await assert.rejects(f.client.removePermanent('c', 'r', 0), e => e.status === 409);
  await assert.rejects(f.client.removePermanent('c', 'missing', 0), e => e.status === 404);
  await assert.rejects(f.client.removePermanent('c', 'r', -1), e => e.status === 400);
  assert.equal((await f.request('records/qianqianjie/c/r/permanent')).status, 405);
  assert.equal((await f.request('records/qianqianjie/c/r/other', 'DELETE', { expectedRevision: 1 })).status, 404);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.client.removePermanent('c', 'r', 1, { signal: controller.signal }), e => e.name === 'AbortError');
  f.failWrite(true);
  await assert.rejects(f.client.removePermanent('c', 'r', 1), /write failure/);
  assert.deepEqual(await f.client.get('c', 'r'), saved);
  f.failWrite(false);
  await f.client.remove('c', 'r', 1);
  const next = await f.client.put('c', 'r', 'keep with trash', 0);
  f.failWrite(true);
  await assert.rejects(f.client.removePermanent('c', 'r', 1), /write failure/);
  assert.deepEqual(await f.client.get('c', 'r'), next);
  assert.equal((await (await f.request('trash/qianqianjie')).json()).length, 1);
});

test('TT concurrent permanent cleanup cannot delete a newer revision', async t => {
  const f = await fixture(t);
  await f.client.put('c', 'r', 'old', 0);
  const second = createBackendClient({ fetchImpl: createTauriBackendFetch({ globalRef: f.globalRef }) });
  const [updated, removed] = await Promise.allSettled([
    f.client.put('c', 'r', 'new', 1), second.removePermanent('c', 'r', 1),
  ]);
  assert.equal(updated.status, 'fulfilled');
  assert.equal(removed.status, 'rejected');
  assert.equal(removed.reason.status, 409);
  assert.equal((await f.client.get('c', 'r')).data, 'new');
});

test('TT failed write/delete keeps prior data and produces no phantom trash', async t => {
  const f = await fixture(t);
  const old = await f.client.put('c', 'r', { text: 'keep' }, 0);
  f.failWrite(true);
  await assert.rejects(f.client.put('c', 'r', 'lose', 1), /write failure/);
  await assert.rejects(f.client.remove('c', 'r', 1), /write failure/);
  assert.deepEqual(await f.client.get('c', 'r'), old);
  assert.deepEqual(await (await f.request('trash/qianqianjie')).json(), []);
  f.failWrite(false);
  assert.equal((await f.client.put('c', 'r', 'recovered', 1)).revision, 2);
});

test('TT read failures and corrupt stored slots are never treated as missing data', async t => {
  const f = await fixture(t);
  await f.client.put('c', 'r', null, 0);
  f.failRead(true);
  await assert.rejects(f.client.put('c', 'r', {}, 0), /read failure/);
  f.failRead(false);
  const namespace = 'qqj-bainiao-v1';
  const [table] = await f.store.listTables({ namespace });
  const [key] = await f.store.listKeys({ namespace, table });
  await f.store.setJson({ namespace, table, key, value: null });
  await assert.rejects(f.client.put('c', 'r', {}, 0), e => e.status === 500);
});

test('TT rejects invalid revisions, paths and unsupported endpoints without writes', async t => {
  const f = await fixture(t);
  await assert.rejects(f.client.put('c', 'r', {}, -1), e => e.status === 400);
  await assert.rejects(f.client.put('c', '../r', {}, 0), e => e.status === 400);
  await assert.rejects(f.client.put('c', 'r', undefined, 0), e => e.status === 400);
  assert.equal((await f.fetchImpl('/api/other')).status, 400);
  assert.equal((await f.request('records/system-trash/c/r')).status, 400);
  assert.equal(f.writes(), 0);
});

test('TT aborted queued writes do not commit; the next operation remains usable', async t => {
  const f = await fixture(t);
  let release;
  f.globalRef.__TAURITAVERN__.ready = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  const pending = f.client.put('c', 'r', {}, 0, { signal: controller.signal });
  controller.abort(); release();
  await assert.rejects(pending, e => e.name === 'AbortError');
  assert.equal(f.writes(), 0);
  assert.equal((await f.client.put('c', 'r', {}, 0)).revision, 1);
});

test('TT ABI readiness is awaited and missing storage APIs fail explicitly', async t => {
  const f = await fixture(t);
  const globalRef = { __TAURITAVERN__: {} };
  globalRef.__TAURITAVERN__.ready = Promise.resolve().then(() => {
    globalRef.__TAURITAVERN__.api = { extension: { store: f.store } };
  });
  const client = createBackendClient({ fetchImpl: createTauriBackendFetch({ globalRef }) });
  assert.equal((await client.health()).ok, true);
  delete globalRef.__TAURITAVERN__.api;
  await assert.rejects(client.health(), /TT 本地存储接口不可用/);
  assert.equal(isTauriTavern(globalRef), true);
  assert.equal(isTauriTavern({}), false);
});

test('TT readiness timeout settles without a late queued write', async t => {
  const f = await fixture(t);
  let release;
  f.globalRef.__TAURITAVERN__.ready = new Promise(resolve => { release = resolve; });
  const client = createBackendClient({ fetchImpl: f.fetchImpl, timeoutMs: 5 });
  await assert.rejects(client.put('c', 'r', {}, 0), e => e.code === 'BACKEND_TIMEOUT');
  release();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.writes(), 0);
});

test('TT default routing selects local storage while explicit fetch injection is preserved', async t => {
  const f = await fixture(t);
  const previous = globalThis.__TAURITAVERN__;
  globalThis.__TAURITAVERN__ = f.globalRef.__TAURITAVERN__;
  t.after(() => { if (previous === undefined) delete globalThis.__TAURITAVERN__; else globalThis.__TAURITAVERN__ = previous; });
  assert.equal((await createBackendClient().health()).storage.scope, 'tauritavern-data-root');
  let count = 0;
  const client = createBackendClient({ fetchImpl: async () => { count++; return { ok: false, status: 418 }; } });
  await assert.rejects(client.get('c', 'r'), e => e.status === 418);
  assert.equal(count, 1);
});
