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
