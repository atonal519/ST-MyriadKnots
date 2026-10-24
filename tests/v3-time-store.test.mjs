import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimeStore } from '../src/v3/time-runtime.js';
import { TIME_HEAD_ID } from '../src/v3/time-engine.js';

function fixture(count = 13) {
  const records = new Map(), calls = [];
  const key = (chat, id) => `chat-${chat}/${id}`;
  function seed(chat) {
    const ids = Array.from({ length: count }, (_, i) => `batch-${i}`);
    records.set(key(chat, TIME_HEAD_ID), { revision: 1, data: { schemaVersion: 1, chatId: chat, batchIds: ids } });
    for (const id of ids) records.set(key(chat, id), { revision: 1, data: { schemaVersion: 1, chatId: chat, id, label: chat } });
  }
  seed('one'); seed('two');
  const client = {
    async get(collection, id) {
      calls.push({ collection, id });
      const value = records.get(`${collection}/${id}`);
      if (!value) throw Object.assign(new Error('missing'), { status: 404 });
      await new Promise(resolve => setImmediate(resolve));
      return structuredClone(value);
    },
    async put(collection, id, data, revision) {
      assert.equal(records.get(`${collection}/${id}`)?.revision ?? 0, revision);
      const value = { revision: revision + 1, data: structuredClone(data) };
      records.set(`${collection}/${id}`, value);
      return structuredClone(value);
    },
    async removePermanent(collection, id) { records.delete(`${collection}/${id}`); },
  };
  return { records, calls, client, store: createTimeStore({ client }), key };
}

test('unchanged head is revalidated but 13 batches are fetched once across five reads', async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) await f.store.read('one');
  assert.equal(f.calls.filter(call => call.id === TIME_HEAD_ID).length, 5);
  assert.equal(f.calls.filter(call => call.id !== TIME_HEAD_ID).length, 13);
  const result = await f.store.read('one');
  result.batches[0].label = 'caller mutation'; result.batchRecords[0].revision = -1;
  const fresh = await f.store.read('one');
  assert.equal(fresh.batches[0].label, 'one'); assert.equal(fresh.batchRecords[0].revision, 1);
});

test('concurrent consumers share one read and receive independently owned snapshots', async () => {
  const f = fixture();
  const [a, b, c] = await Promise.all([f.store.read('one'), f.store.read('one'), f.store.read('one')]);
  assert.equal(f.calls.length, 14);
  a.head.batchIds.pop(); b.batches[0].label = 'mutated';
  assert.equal(c.head.batchIds.length, 13); assert.equal(c.batches[0].label, 'one');
});

test('时间冷读按64项批读且保留head顺序、revision与同次合并', async () => {
  for (const count of [0, 64, 65]) {
    const f = fixture(count), batchCalls = [];
    const ids = f.records.get(f.key('one', TIME_HEAD_ID)).data.batchIds;
    ids.reverse();
    for (let index = 0; index < ids.length; index++) f.records.get(f.key('one', ids[index])).revision = index + 2;
    f.client.getMany = async (collection, recordIds) => {
      batchCalls.push([...recordIds]);
      await new Promise(resolve => setImmediate(resolve));
      return recordIds.map(recordId => ({ recordId, status: 200, envelope: structuredClone(f.records.get(`${collection}/${recordId}`)) }));
    };
    const expected = await fixtureSnapshot(f, ids);
    const [a, b] = await Promise.all([f.store.read('one'), f.store.read('one')]);
    assert.deepEqual(a, expected); assert.deepEqual(b, expected);
    assert.deepEqual(batchCalls.map(part => part.length), count === 0 ? [] : count === 64 ? [64] : [64, 1]);
    assert.deepEqual(f.calls.map(call => call.id), [TIME_HEAD_ID], '冷读只逐GET确认head');
    a.batches.push({}); b.batchRecords[0] && (b.batchRecords[0].revision = -1);
    assert.deepEqual(await f.store.read('one'), expected, '缓存与调用方快照独立');
    assert.equal(batchCalls.length, Math.ceil(count / 64), '未变head不重读批次');
  }
});

async function fixtureSnapshot(f, ids) {
  const head = structuredClone(f.records.get(f.key('one', TIME_HEAD_ID)));
  const records = ids.map(id => structuredClone(f.records.get(f.key('one', id))));
  return { head: head.data, revision: head.revision, batches: records.map(record => record.data),
    batchRecords: records.map((record, index) => ({ id: ids[index], revision: record.revision, data: record.data })) };
}

test('时间批读保留缺失、归属、结构与HTTP失败，不发布部分快照', async () => {
  for (const fault of ['missing', 'owner', 'schema', 'recordId', 'shape', 'http', 'transport']) {
    const f = fixture(2), failure = new Error('transport unavailable');
    let broken = true, reads = 0;
    f.client.getMany = async (collection, ids) => {
      reads++;
      if (broken && fault === 'transport') throw failure;
      const result = ids.map(recordId => ({ recordId, status: 200, envelope: structuredClone(f.records.get(`${collection}/${recordId}`)) }));
      if (!broken) return result;
      if (fault === 'missing') result[1] = { recordId: ids[1], status: 404 };
      if (fault === 'owner') result[1].envelope.data.chatId = 'two';
      if (fault === 'schema') result[1].envelope.data.schemaVersion = 2;
      if (fault === 'recordId') result.reverse();
      if (fault === 'shape') result.pop();
      if (fault === 'http') result[1] = { recordId: ids[1], status: 500 };
      return result;
    };
    await assert.rejects(f.store.read('one'), error => fault === 'transport' ? error === failure
      : fault === 'http' ? error.status === 500 : /时间增量记录无效/u.test(error.message), fault);
    assert.equal(f.calls.length, 1, '失败不额外逐项GET或自动重试');
    broken = false;
    const loaded = await f.store.read('one');
    assert.equal(loaded.batches.length, 2); assert.equal(reads, 2, '失败结果未成为成功缓存');
  }
});

test('floor-reference query covers time head, batches, fragments, state refs and review projections', async () => {
  const f = fixture(1), target = 'floor-target', other = 'floor-other';
  const head = { schemaVersion: 1, chatId: 'one', batchIds: ['batch-0'], bodyStart: { floorId: other },
    lastRun: { cutoffFloorId: other, fragments: [{ floorId: other }], bodyReads: [{ floorId: other }],
      clockWitnesses: [{ floorId: other }], failedBodyAttempts: [{ cutoffFloorId: other, fragments: [{ floorId: other }] }] },
    currentReviewAttempt: { cutoffFloorId: other } };
  const batch = { schemaVersion: 1, chatId: 'one', id: 'batch-0', cutoffFloorId: other,
    dependencies: [{ floorId: other }], bodyReads: [{ floorId: other }], clockWitnesses: [{ floorId: other }],
    fragments: [{ floorId: other }], changes: [{ sourceRefs: [{ floorId: other }], stateRefs: [{ sourceFloorId: other }],
      reviewAssessment: { applicableFloorId: other }, projection: { applicableFloorId: other } }] };
  f.records.set(f.key('one', TIME_HEAD_ID), { revision: 2, data: head });
  f.records.set(f.key('one', 'batch-0'), { revision: 2, data: batch });
  assert.equal(await f.store.hasFloorReference('one', target), false);
  for (const [field, value] of [
    ['bodyStart', { floorId: target }],
    ['currentReviewAttempt', { cutoffFloorId: target }],
    ['lastRun', { cutoffFloorId: target }],
    ['lastRun-fragments', { ...head.lastRun, fragments: [{ floorId: target }] }],
    ['lastRun-bodyReads', { ...head.lastRun, bodyReads: [{ floorId: target }] }],
    ['lastRun-clockWitnesses', { ...head.lastRun, clockWitnesses: [{ floorId: target }] }],
    ['lastRun-failedBodyAttempts', { ...head.lastRun, failedBodyAttempts: [{ cutoffFloorId: other, fragments: [{ floorId: target }] }] }],
  ]) {
    const saved = field.startsWith('lastRun-') ? { ...head, lastRun: value } : { ...head, [field]: value };
    f.records.set(f.key('one', TIME_HEAD_ID), { revision: 3, data: saved });
    f.store.invalidate('one');
    assert.equal(await f.store.hasFloorReference('one', target), true, `time head ${field}`);
  }
  for (const mutate of [
    value => { value.cutoffFloorId = target; },
    value => { value.dependencies[0].floorId = target; },
    value => { value.bodyReads[0].floorId = target; },
    value => { value.clockWitnesses[0].floorId = target; },
    value => { value.fragments[0].floorId = target; },
    value => { value.changes[0].sourceRefs[0].floorId = target; },
    value => { value.changes[0].stateRefs[0].sourceFloorId = target; },
    value => { value.changes[0].reviewAssessment.applicableFloorId = target; },
    value => { value.changes[0].projection.applicableFloorId = target; },
  ]) {
    const saved = structuredClone(batch); mutate(saved);
    f.records.set(f.key('one', 'batch-0'), { revision: 3, data: saved });
    f.store.invalidate('one');
    assert.equal(await f.store.hasFloorReference('one', target), true);
  }
  assert.equal(await f.store.hasFloorReference('two', target), false, '另一聊天的 time head/batch 不应串用');
});

test('published edit and deletion are read fresh; identical IDs in another chat do not share data', async () => {
  const f = fixture(1);
  const original = await f.store.read('one');
  await f.store.putBatch('one', { schemaVersion: 1, chatId: 'one', id: 'edited', label: 'saved' });
  await f.store.putHead('one', { ...original.head, batchIds: ['edited'] }, original.revision);
  assert.equal((await f.store.read('one')).batches[0].label, 'saved');
  await f.store.removePermanent('one', 'batch-0', 1);
  assert.deepEqual((await f.store.read('one')).batches.map(batch => batch.id), ['edited']);
  assert.equal((await f.store.read('two')).batches[0].label, 'two');
  assert.equal((await f.store.read('one')).batches[0].label, 'saved');
  // Another tab publishes a head revision; the current tab must observe it.
  f.records.set(f.key('one', TIME_HEAD_ID), { revision: 3, data: { ...original.head, batchIds: [] } });
  assert.equal((await f.store.read('one')).batches.length, 0);
});

test('failed reads retry, a disappeared head clears the old snapshot, and failed writes invalidate', async () => {
  const f = fixture(1), saved = f.records.get(f.key('one', 'batch-0'));
  f.records.delete(f.key('one', 'batch-0'));
  await assert.rejects(f.store.read('one'), /时间增量记录无效/);
  f.records.set(f.key('one', 'batch-0'), saved);
  await f.store.read('one');
  f.records.delete(f.key('one', TIME_HEAD_ID));
  assert.equal((await f.store.read('one')).head, null);
  f.records.set(f.key('one', TIME_HEAD_ID), { revision: 1, data: { schemaVersion: 1, chatId: 'one', batchIds: ['batch-0'] } });
  f.records.get(f.key('one', 'batch-0')).data.label = 'restored';
  assert.equal((await f.store.read('one')).batches[0].label, 'restored');
  f.client.put = async () => { throw Object.assign(new Error('conflict'), { status: 409 }); };
  await assert.rejects(f.store.putHead('one', {}, 1), /conflict/);
  const before = f.calls.length;
  await f.store.read('one');
  assert.equal(f.calls.length - before, 2);
});

test('late reads from an invalidated epoch neither block new reads nor refill the cache', async () => {
  const f = fixture(1), original = f.client.get;
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), begun = new Promise(resolve => { started = resolve; });
  let first = true;
  f.client.get = async (collection, id) => {
    if (first && id === TIME_HEAD_ID) {
      first = false; const value = await original(collection, id); started(); await gate; return value;
    }
    return original(collection, id);
  };
  const old = f.store.read('one'); await begun;
  f.store.invalidate();
  await f.store.putHead('one', { schemaVersion: 1, chatId: 'one', batchIds: [] }, 1);
  assert.equal((await f.store.read('one')).batches.length, 0);
  release(); await old;
  assert.equal((await f.store.read('one')).batches.length, 0);
});
