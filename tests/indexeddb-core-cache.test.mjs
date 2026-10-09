import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndexedDbCoreRecordCache } from '../src/v3/indexeddb-core-cache.js';
import { sha256 } from '../src/identity.js';
import { localForageHarness } from './helpers/indexeddb-harness.mjs';

const cacheOptions = h => ({ indexedDBProvider: () => h.indexedDB, keyRangeProvider: () => h.keyRange });

const witness = Object.freeze({ formatVersion: 1, generationId: 'generation-A', revision: 3, headCheckpointId: 'checkpoint-A', narrativeGeneration: 2, sourceSnapshotFingerprint: 'sha256:source-A' });
const floorEnvelope = (summary = '中性楼摘要') => ({ schemaVersion: 1, revision: 1, generationId: 'floor-generation', createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z', data: { recordType: 'floor', id: 'floor-a', chatId: '123e4567-e89b-42d3-a456-426614174000', summary } });

test('独立实例只选 INDEXEDDB；scope 隔离账户和 chat，精确 root manifest 才允许缓存命中', async () => {
  const h = localForageHarness();
  let handle = 'account-a';
  const cache = createIndexedDbCoreRecordCache({ localForage: h.localForage, ...cacheOptions(h), accountHandleProvider: () => handle, originProvider: () => 'https://tavern.invalid', ioTimeoutMs: 50 });
  const identity = { chatId: '123e4567-e89b-42d3-a456-426614174000' };
  const scope = await cache.scopeFor(identity);
  const before = await cache.readManifest(scope, witness);
  assert.equal(before, null);
  await cache.publish(scope, witness, [{ recordId: 'v3-floor-floor-a', envelope: floorEnvelope() }], { floor: ['v3-floor-floor-a'] });
  const manifest = await cache.readManifest(scope, witness);
  assert.deepEqual(manifest.recordRefs.floor, ['v3-floor-floor-a']);
  assert.deepEqual(await cache.readRecord(scope, witness, 'floor', 'v3-floor-floor-a', manifest), floorEnvelope());
  assert.equal(await cache.readManifest(scope, { ...witness, revision: 4 }), null);
  handle = 'account-b';
  assert.notEqual(await cache.scopeFor(identity), scope);
  assert.notEqual(await cache.scopeFor({ chatId: '223e4567-e89b-42d3-a456-426614174000' }), scope);
  assert.deepEqual(h.configs[0], { name: 'qqj-v3-core-cache', storeName: 'core_records', driver: 'INDEXEDDB' });
});

test('坏记录只失效自身并转为 miss，不被缓存层返回', async () => {
  const h = localForageHarness();
  const cache = createIndexedDbCoreRecordCache({ localForage: h.localForage, ...cacheOptions(h), accountHandleProvider: () => 'user', originProvider: () => 'https://tavern.invalid', ioTimeoutMs: 50 });
  const scope = await cache.scopeFor({ chatId: '123e4567-e89b-42d3-a456-426614174000' });
  await cache.publish(scope, witness, [{ recordId: 'v3-floor-floor-a', envelope: floorEnvelope() }], { floor: ['v3-floor-floor-a'] });
  const recordKey = [...h.data.keys()].find(key => key.startsWith('r:'));
  h.data.get(recordKey).envelope.data.summary = '被改坏的缓存值';
  const manifest = await cache.readManifest(scope, witness);
  assert.equal(await cache.readRecord(scope, witness, 'floor', 'v3-floor-floor-a', manifest), null);
  assert.equal(h.data.has(recordKey), false);
  assert.equal(cache.getStats().corruptions, 1);
});

test('容量预算包含记录和目录元数据；小预算可淘汰派生记录并保持准确miss', async () => {
  const h = localForageHarness();
  const cache = createIndexedDbCoreRecordCache({ localForage: h.localForage, ...cacheOptions(h), accountHandleProvider: () => 'user', originProvider: () => 'https://tavern.invalid', maxBytes: 1, ioTimeoutMs: 50 });
  const scope = await cache.scopeFor({ chatId: '123e4567-e89b-42d3-a456-426614174000' });
  await cache.publish(scope, witness, [{ recordId: 'v3-floor-floor-a', envelope: floorEnvelope() }], { floor: ['v3-floor-floor-a'] });
  assert.equal(await cache.readManifest(scope, witness), null);
  assert.equal(await cache.readRecord(scope, witness, 'floor', 'v3-floor-floor-a', { floor: ['v3-floor-floor-a'] }), null);
  assert.equal(cache.getStats().evictedRecords, 1);
});

test('后台目录维护完成迁移后立即执行已超限预算回收', async () => {
  const h = localForageHarness();
  const identity = { chatId: '123e4567-e89b-42d3-a456-426614174000' };
  const writer = createIndexedDbCoreRecordCache({ localForage: h.localForage, ...cacheOptions(h), accountHandleProvider: () => 'user', originProvider: () => 'https://tavern.invalid' });
  const scope = await writer.scopeFor(identity);
  assert.equal(await writer.publish(scope, witness, [{ recordId: 'v3-floor-floor-a', envelope: floorEnvelope() }], { floor: ['v3-floor-floor-a'] }), true);
  const boundedCache = createIndexedDbCoreRecordCache({ localForage: h.localForage, ...cacheOptions(h), accountHandleProvider: () => 'user', originProvider: () => 'https://tavern.invalid', maxBytes: 1 });
  assert.equal(await boundedCache.maintain(), true);
  assert.equal(await boundedCache.readManifest(scope, witness), null);
  assert.equal(boundedCache.getStats().estimatedBytes, 0);
  assert.equal(boundedCache.getStats().evictedRecords, 1);
});

test('目标真实删除先使缓存manifest失效，删除后才结束的旧发布不能重新建立可读manifest', async () => {
  const h = localForageHarness();
  const cache = createIndexedDbCoreRecordCache({ localForage: h.localForage, ...cacheOptions(h), accountHandleProvider: () => 'user', originProvider: () => 'https://tavern.invalid', ioTimeoutMs: 50 });
  const identity = { chatId: '123e4567-e89b-42d3-a456-426614174000' };
  const scope = await cache.scopeFor(identity);
  const version = cache.captureIdentityVersion(identity);
  assert.equal(await cache.publish(scope, witness, [{ recordId: 'v3-floor-floor-a', envelope: floorEnvelope() }], { floor: ['v3-floor-floor-a'] }, version), true);
  assert.equal(await cache.invalidateIdentity(identity), true);
  assert.equal(await cache.readManifest(scope, witness), null);
  assert.equal(await cache.readRecord(scope, witness, 'floor', 'v3-floor-floor-a', await cache.readManifest(scope, witness)), null, '没有exact-root manifest时不能读旧记录');
  assert.equal(await cache.publish(scope, witness, [{ recordId: 'v3-floor-floor-a', envelope: floorEnvelope() }], { floor: ['v3-floor-floor-a'] }, cache.captureIdentityVersion(identity), () => null), false, '真实删除后root核验不支持旧图重新发布');
});

test('同代际只保留最新两个成功manifest；generation变化需固定目标root核验', async () => {
  const h = localForageHarness();
  const cache = createIndexedDbCoreRecordCache({ localForage: h.localForage, ...cacheOptions(h), accountHandleProvider: () => 'user', originProvider: () => 'https://tavern.invalid', ioTimeoutMs: 50 });
  const scope = await cache.scopeFor({ chatId: '123e4567-e89b-42d3-a456-426614174000' });
  const publishAt = revision => cache.publish(scope, { ...witness, revision }, [{ recordId: 'v3-floor-floor-a', envelope: floorEnvelope(`revision-${revision}`) }], { floor: ['v3-floor-floor-a'] });
  assert.equal(await publishAt(3), true);
  assert.equal(await publishAt(4), true);
  assert.equal(await publishAt(5), true);
  assert.equal(await cache.readManifest(scope, { ...witness, revision: 3 }), null);
  assert.ok(await cache.readManifest(scope, { ...witness, revision: 4 }));
  assert.ok(await cache.readManifest(scope, { ...witness, revision: 5 }));
  assert.equal([...h.data.keys()].filter(key => key.startsWith(`v:${scope}:`)).length, 2);

  let proofCalls = 0;
  const nextGeneration = { ...witness, generationId: 'generation-B', revision: 1 };
  assert.equal(await cache.publish(scope, nextGeneration, [{ recordId: 'v3-floor-floor-b', envelope: floorEnvelope('new-generation') }], { floor: ['v3-floor-floor-b'] }, undefined, async () => { proofCalls += 1; return { generationId: 'generation-B', revision: 1 }; }), true);
  assert.equal(proofCalls, 1);
  assert.equal(await cache.readManifest(scope, { ...witness, revision: 5 }), null);
  const rejectedGeneration = { ...witness, generationId: 'generation-C', revision: 1 };
  assert.equal(await cache.publish(scope, rejectedGeneration, [{ recordId: 'v3-floor-floor-c', envelope: floorEnvelope('stale-generation') }], { floor: ['v3-floor-floor-c'] }, undefined, async () => ({ generationId: 'generation-B', revision: 1 })), false);
});

test('目录写事务失败会回滚manifest和目录，保留上一个可读版本', async () => {
  const h = localForageHarness();
  const cache = createIndexedDbCoreRecordCache({ localForage: h.localForage, ...cacheOptions(h), accountHandleProvider: () => 'user', originProvider: () => 'https://tavern.invalid', ioTimeoutMs: 50 });
  const identity = { chatId: '123e4567-e89b-42d3-a456-426614174000' }, scope = await cache.scopeFor(identity);
  const record = { recordId: 'v3-floor-floor-a', envelope: floorEnvelope() };
  assert.equal(await cache.publish(scope, witness, [record], { floor: [record.recordId] }), true);
  const next = { ...witness, revision: witness.revision + 1 };
  h.failNextPut(new Error('transaction abort after directory put'), `d:${scope}`);
  assert.equal(await cache.publish(scope, next, [record], { floor: [record.recordId] }), false);
  const reader = createIndexedDbCoreRecordCache({ localForage: h.localForage, ...cacheOptions(h), accountHandleProvider: () => 'user', originProvider: () => 'https://tavern.invalid', ioTimeoutMs: 50 });
  assert.ok(await reader.readManifest(scope, witness));
  assert.equal(await reader.readManifest(scope, next), null);
  assert.deepEqual(h.data.get(`d:${scope}`).items.map(item => item.revision), [witness.revision]);
});

test('旧版本manifest只读逐条目录清理；预算持久计数与sidecar估值相等', async () => {
  const h = localForageHarness();
  const scope = 'a'.repeat(64);
  const makeWitness = revision => ({ ...witness, revision });
  for (const revision of [2, 5, 4]) {
    const oldWitness = makeWitness(revision);
    const key = `v:${scope}:${await sha256(JSON.stringify([oldWitness.formatVersion, oldWitness.generationId, oldWitness.revision, oldWitness.headCheckpointId, oldWitness.narrativeGeneration, oldWitness.sourceSnapshotFingerprint]))}`;
    const value = { format: 'qqj-v3-core-cache-1', scope, witness: oldWitness, recordRefs: { floor: [], floorMemory: [], entity: [], stateDelta: [], index: [] }, updatedAt: revision };
    h.data.set(key, value);
    h.data.set(`s:${key}`, { recordKey: key, bytes: JSON.stringify(value).length, createdAt: revision });
  }
  const cache = createIndexedDbCoreRecordCache({ localForage: h.localForage, ...cacheOptions(h), accountHandleProvider: () => 'user', originProvider: () => 'https://tavern.invalid', ioTimeoutMs: 50 });
  assert.equal(await cache.publish(scope, makeWitness(5), [], { floor: [] }), true);
  const directory = h.data.get(`d:${scope}`);
  assert.deepEqual(directory.items.map(item => item.revision), [5, 4]);
  assert.equal(h.data.has(`s:v:${scope}:${await sha256(JSON.stringify([1, 'generation-A', 2, 'checkpoint-A', 2, 'sha256:source-A']))}`), false, '淘汰目录时同步清理sidecar');
  const counted = [...h.data.entries()].filter(([key]) => key.startsWith('s:')).reduce((sum, [, value]) => sum + (Number.isSafeInteger(value?.bytes) ? value.bytes : 0), 0);
  assert.equal(h.data.get('b:core-cache').estimatedBytes, counted);
  assert.equal(cache.getStats().estimatedBytes, counted);
});

test('legacy无sidecar的孤儿raw在有限迁移中删除后正式miss，重新publish补齐元数据并恢复命中', async () => {
  const h = localForageHarness();
  const identity = { chatId: '123e4567-e89b-42d3-a456-426614174000' };
  const cache = createIndexedDbCoreRecordCache({ localForage: h.localForage, ...cacheOptions(h), accountHandleProvider: () => 'user', originProvider: () => 'https://tavern.invalid', ioTimeoutMs: 50 });
  const scope = await cache.scopeFor(identity), recordId = 'v3-floor-floor-a';
  const manifestKey = `v:${scope}:${await sha256(JSON.stringify([witness.formatVersion, witness.generationId, witness.revision, witness.headCheckpointId, witness.narrativeGeneration, witness.sourceSnapshotFingerprint]))}`;
  const rawKey = `r:${scope}:${encodeURIComponent(witness.generationId)}:floor:${encodeURIComponent(recordId)}`;
  const envelope = floorEnvelope();
  h.data.set(manifestKey, { format: 'qqj-v3-core-cache-1', scope, witness, recordRefs: { floor: [recordId], floorMemory: [], entity: [], stateDelta: [], index: [] }, updatedAt: 1 });
  h.data.set(rawKey, { format: 'qqj-v3-core-cache-1', scope, rootGenerationId: witness.generationId, recordGenerationId: envelope.generationId,
    recordType: 'floor', recordId, revision: envelope.revision, digest: await sha256(JSON.stringify(envelope)), envelope });
  assert.equal(await cache.publish(scope, witness, [], { floor: [recordId] }), true, '迁移完成而不读取raw正文');
  const manifest = await cache.readManifest(scope, witness);
  assert.equal(await cache.readRecord(scope, witness, 'floor', recordId, manifest), null, '缺sidecar旧raw不再永久绕过预算');
  assert.equal(h.data.has(rawKey), false);
  assert.equal(await cache.publish(scope, witness, [{ recordId, envelope }], { floor: [recordId] }), true);
  const rebuiltManifest = await cache.readManifest(scope, witness);
  assert.deepEqual(await cache.readRecord(scope, witness, 'floor', recordId, rebuiltManifest), envelope);
  assert.ok(h.data.get(`s:${rawKey}`).bytes > JSON.stringify(envelope).length, '重建raw同时发布了计入包装和key的sidecar');
});

test('IndexedDB ready 挂起有限超时，不把缓存等待传给业务读取', async () => {
  const h = localForageHarness({ hangReady: true });
  const cache = createIndexedDbCoreRecordCache({ localForage: h.localForage, ...cacheOptions(h), accountHandleProvider: () => 'user', originProvider: () => 'https://tavern.invalid', ioTimeoutMs: 5 });
  const scope = await cache.scopeFor({ chatId: '123e4567-e89b-42d3-a456-426614174000' });
  const started = Date.now();
  assert.equal(await cache.readManifest(scope, witness), false);
  assert.ok(Date.now() - started < 100);
  assert.equal(cache.getStats().available, false);
});

test('ready 后record getItem超时会关闭本页缓存IO，后续大批读写不逐批等待且正式回源不受影响', async () => {
  const h = localForageHarness();
  let instance, getCalls = 0;
  const originalCreate = h.localForage.createInstance;
  h.localForage.createInstance = config => (instance = originalCreate(config));
  const cache = createIndexedDbCoreRecordCache({ localForage: h.localForage, ...cacheOptions(h), accountHandleProvider: () => 'neutral', originProvider: () => 'https://tavern.invalid', ioTimeoutMs: 10 });
  const scope = await cache.scopeFor({ chatId: '123e4567-e89b-42d3-a456-426614174000' });
  const id = 'v3-floor-floor-a';
  await cache.publish(scope, witness, [{ recordId: id, envelope: floorEnvelope() }], { floor: [id] });
  const manifest = await cache.readManifest(scope, witness);
  const normalGet = instance.getItem;
  instance.getItem = async key => key.startsWith('r:') ? new Promise(() => {}) : normalGet(key);
  const started = Date.now();
  assert.equal(await cache.readRecord(scope, witness, 'floor', id, manifest), null);
  const afterTimeoutCalls = getCalls;
  const misses = await Promise.all(Array.from({ length: 271 }, (_, index) => cache.readRecord(scope, witness, 'floor', `v3-floor-${index}`, manifest)));
  assert.ok(misses.every(value => value === null));
  assert.equal(getCalls, afterTimeoutCalls, '首个core I/O故障后不再对后续楼发送IDB请求');
  const records = Array.from({ length: 271 }, (_, index) => ({ recordId: `v3-floor-${index}`, envelope: floorEnvelope(String(index)) }));
  assert.equal(await cache.publish(scope, { ...witness, revision: 4 }, records, { floor: records.map(record => record.recordId) }), false);
  assert.equal(cache.getStats().writes, 1);
  assert.ok(Date.now() - started < 100, '缓存故障后的多楼读写必须在单次有限等待内收敛');
  assert.equal(cache.getStats().available, false);
});

test('失败诊断只保留安全字段；timeout 后底层 late success/error 只更新所属 first/last 结果', async () => {
  for (const lateResult of ['fulfilled', 'rejected']) {
    const h = localForageHarness();
    const originalCreate = h.localForage.createInstance;
    let instance;
    h.localForage.createInstance = config => (instance = originalCreate(config));
    const cache = createIndexedDbCoreRecordCache({ localForage: h.localForage, ...cacheOptions(h), accountHandleProvider: () => 'private-account', originProvider: () => 'https://private.invalid', ioTimeoutMs: 8 });
    const scope = await cache.scopeFor({ chatId: '123e4567-e89b-42d3-a456-426614174000' });
    await cache.publish(scope, witness, [{ recordId: 'v3-floor-floor-a', envelope: floorEnvelope('private body must not enter diagnostics') }], { floor: ['v3-floor-floor-a'] });
    const manifest = await cache.readManifest(scope, witness);
    const originalGet = instance.getItem;
    let finishOperation;
    instance.getItem = key => key.startsWith('r:') ? new Promise((resolve, reject) => { finishOperation = lateResult === 'fulfilled' ? () => resolve({ value: 'private body' }) : () => reject(Object.assign(new Error('private message'), { name: 'QuotaExceededError' })); }) : originalGet(key);
    assert.equal(await cache.readRecord(scope, witness, 'floor', 'v3-floor-floor-a', manifest), null);
    let failure = cache.getStats().lastFailure;
    assert.equal(failure.phase, 'record-read');
    assert.equal(failure.code, 'IDB_CACHE_TIMEOUT');
    assert.equal(failure.lateResult, 'pending');
    assert.equal(typeof failure.elapsedMs, 'number');
    assert.equal(typeof failure.deadlineLatenessMs, 'number');
    const failureElapsedMs = failure.elapsedMs, failureAt = failure.at;
    const safeText = JSON.stringify(cache.getStats());
    for (const secret of ['private-account', 'private.invalid', 'private body', 'private message', 'v3-floor-floor-a']) assert.equal(safeText.includes(secret), false);
    finishOperation();
    await new Promise(resolve => setTimeout(resolve, 0));
    failure = cache.getStats().lastFailure;
    assert.equal(failure.code, 'IDB_CACHE_TIMEOUT', '迟到拒绝不覆盖原超时原因');
    assert.equal(failure.lateResult, lateResult);
    assert.equal(failure.elapsedMs, failureElapsedMs, '晚完成不改写期限触发时的失败耗时');
    assert.equal(failure.at, failureAt, '晚完成不改写失败时间');
    assert.ok(failure.lateElapsedMs >= failure.elapsedMs, '晚完成耗时单独记录');
    assert.equal(typeof failure.lateAt, 'number');
  }
});

test('主线程延迟记录deadline实际迟到量；持久化拒绝保留标准错误名且不重复记录', async () => {
  const h = localForageHarness();
  const originalCreate = h.localForage.createInstance;
  let instance;
  h.localForage.createInstance = config => (instance = originalCreate(config));
  const cache = createIndexedDbCoreRecordCache({ localForage: h.localForage, ...cacheOptions(h), accountHandleProvider: () => 'neutral', originProvider: () => 'https://tavern.invalid', ioTimeoutMs: 10 });
  const identity = { chatId: '123e4567-e89b-42d3-a456-426614174000' };
  const scope = await cache.scopeFor(identity);
  await cache.publish(scope, witness, [{ recordId: 'v3-floor-floor-a', envelope: floorEnvelope() }], { floor: ['v3-floor-floor-a'] });
  const manifest = await cache.readManifest(scope, witness);
  const originalGet = instance.getItem;
  let signalRead, releaseRead;
  const started = new Promise(resolve => { signalRead = resolve; });
  instance.getItem = key => {
    if (!key.startsWith('r:')) return originalGet(key);
    signalRead();
    return new Promise(resolve => { releaseRead = resolve; });
  };
  const pendingRead = cache.readRecord(scope, witness, 'floor', 'v3-floor-floor-a', manifest);
  await started;
  const stallStart = performance.now();
  while (performance.now() - stallStart < 40) { /* simulate a long main-thread task */ }
  assert.equal(await pendingRead, null);
  const timeoutFailure = cache.getStats().lastFailure;
  assert.equal(timeoutFailure.code, 'IDB_CACHE_TIMEOUT');
  assert.ok(timeoutFailure.deadlineLatenessMs >= 20, `timer迟到应反映主线程阻塞，记录=${timeoutFailure.deadlineLatenessMs}ms`);
  releaseRead(null);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(cache.getStats().lastFailure.lateResult, 'fulfilled');
  assert.equal(cache.getStats().lastFailure.elapsedMs, timeoutFailure.elapsedMs, '迟到observer保留timer触发时长');
  assert.ok(cache.getStats().lastFailure.lateElapsedMs >= timeoutFailure.elapsedMs, '底层Promise完成时长单列');

  const h2 = localForageHarness();
  const originalCreate2 = h2.localForage.createInstance;
  let instance2;
  h2.localForage.createInstance = config => (instance2 = originalCreate2(config));
  const cache2 = createIndexedDbCoreRecordCache({ localForage: h2.localForage, ...cacheOptions(h2), accountHandleProvider: () => 'neutral', originProvider: () => 'https://tavern.invalid', ioTimeoutMs: 20 });
  const scope2 = await cache2.scopeFor(identity);
  assert.equal(await cache2.readManifest(scope2, witness), null);
  const quota = Object.assign(new Error('quota detail must not be copied'), { name: 'QuotaExceededError', code: 'QUOTA_EXCEEDED' });
  h2.failNextPut(quota, 'r:');
  assert.equal(await cache2.publish(scope2, witness, [{ recordId: 'v3-floor-floor-a', envelope: floorEnvelope() }], { floor: ['v3-floor-floor-a'] }), false);
  const stats = cache2.getStats();
  assert.equal(stats.writeFailures, 1);
  assert.equal(stats.firstFailure.phase, 'publish-record-transaction');
  assert.equal(stats.firstFailure.code, null, '非白名单自定义code不进入诊断');
  assert.equal(stats.firstFailure.name, 'QuotaExceededError');
  assert.deepEqual(stats.lastFailure, stats.firstFailure, 'worker catch不会重复记录同一个错误');
  assert.equal(JSON.stringify(stats).includes('quota detail'), false);

  const h3 = localForageHarness();
  const originalCreate3 = h3.localForage.createInstance;
  let instance3;
  h3.localForage.createInstance = config => (instance3 = originalCreate3(config));
  const cache3 = createIndexedDbCoreRecordCache({ localForage: h3.localForage, ...cacheOptions(h3), accountHandleProvider: () => 'neutral', originProvider: () => 'https://tavern.invalid', ioTimeoutMs: 20 });
  const scope3 = await cache3.scopeFor(identity);
  assert.equal(await cache3.readManifest(scope3, witness), null);
  const privateError = Object.assign(new Error('private details'), { name: 'PrivateStoreError', code: 'PRIVATE_STORE_CODE' });
  h3.failNextPut(privateError, 'r:');
  assert.equal(await cache3.publish(scope3, witness, [{ recordId: 'v3-floor-floor-a', envelope: floorEnvelope() }], { floor: ['v3-floor-floor-a'] }), false);
  assert.equal(cache3.getStats().firstFailure.code, null);
  assert.equal(cache3.getStats().firstFailure.name, 'Error');
  assert.equal(JSON.stringify(cache3.getStats()).includes('PrivateStoreError'), false);
});

test('旧I/O的late observer不覆盖之后发生的last failure', async () => {
  const h = localForageHarness();
  const originalCreate = h.localForage.createInstance;
  let instance;
  h.localForage.createInstance = config => (instance = originalCreate(config));
  const cache = createIndexedDbCoreRecordCache({ localForage: h.localForage, ...cacheOptions(h), accountHandleProvider: () => 'neutral', originProvider: () => 'https://tavern.invalid', ioTimeoutMs: 8 });
  const scope = await cache.scopeFor({ chatId: '123e4567-e89b-42d3-a456-426614174000' });
  await cache.publish(scope, witness, [{ recordId: 'v3-floor-floor-a', envelope: floorEnvelope() }], { floor: ['v3-floor-floor-a'] });
  const manifest = await cache.readManifest(scope, witness);
  const originalGet = instance.getItem;
  let releaseRecord, signalRecord, signalManifest;
  const recordStarted = new Promise(resolve => { signalRecord = resolve; });
  const manifestStarted = new Promise(resolve => { signalManifest = resolve; });
  instance.getItem = key => {
    if (key.startsWith('r:')) { signalRecord(); return new Promise(resolve => { releaseRecord = resolve; }); }
    if (key.startsWith('x:')) { signalManifest(); return new Promise(() => {}); }
    return originalGet(key);
  };
  const olderRead = cache.readRecord(scope, witness, 'floor', 'v3-floor-floor-a', manifest);
  await recordStarted;
  const newerRead = cache.readManifest(scope, witness);
  await manifestStarted;
  assert.deepEqual(await Promise.all([olderRead, newerRead]), [null, false]);
  const laterFailure = cache.getStats().lastFailure;
  assert.equal(laterFailure.phase, 'manifest-invalidation-read');
  releaseRecord(null);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(cache.getStats().lastFailure, laterFailure, '旧record完成只更新其own token，不替换较新的last failure');
});
