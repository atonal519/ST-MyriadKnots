import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createArchiveV2MemoryBatch,
  createArchiveV2MemoryManifest,
  createArchiveV2MemorySnapshot,
  validateArchiveV2MemoryManifest,
} from '../src/archive-v2-memory-foundation.js';
import { createArchiveV2MemoryPeopleResult } from '../src/archive-v2-memory-people-foundation.js';
import {
  createArchiveV2MemoryBatchRecordId,
  createArchiveV2MemoryPeopleRecordId,
  createArchiveV2MemoryStore,
} from '../src/archive-v2-memory-store.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TIME = '2026-09-01T01:02:03.000Z';
const assistant = content => ({ is_user: false, is_system: false, mes: content, swipe_id: 0, swipes: [content], extra: {} });
const envelope = (data, revision = 1) => ({
  schemaVersion: 1, revision, generationId: '11111111-1111-4111-8111-111111111111',
  createdAt: TIME, updatedAt: TIME, data: structuredClone(data),
});
const httpError = status => Object.assign(new Error(`HTTP ${status}`), { status });

async function fixture() {
  const context = {
    characterId: 0, characters: [{ avatar: 'character.png' }], userAvatar: 'persona.png', chatId: 'host-chat',
    chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT } }, chat: [assistant('一'), assistant('二')],
  };
  const snapshot = await createArchiveV2MemorySnapshot(context, { maxFloorsPerBatch: 1 });
  const base = createArchiveV2MemoryManifest({ snapshot, scanId: 'scan-people', createdAt: TIME });
  const refs = [];
  const batches = [];
  for (const plan of snapshot.batches) {
    const localId = `P${plan.batchIndex + 1}`;
    const batch = createArchiveV2MemoryBatch({
      manifest: base, plan, createdAt: TIME,
      rows: { people: [{ localId, displayName: `人物${plan.batchIndex + 1}`, aliases: [], sourceFloors: [plan.floorStart] }], facts: [], relations: [], events: [] },
    });
    const recordId = await createArchiveV2MemoryBatchRecordId({ scanId: base.scanId, batchIndex: plan.batchIndex, sourceFingerprint: plan.sourceFingerprint });
    refs.push({ batchIndex: plan.batchIndex, recordId, sourceFingerprint: plan.sourceFingerprint });
    batches.push(batch);
  }
  const manifest = validateArchiveV2MemoryManifest({
    ...structuredClone(base), completedBatchIndexes: [0, 1], status: 'ready', batchRefs: refs,
  });
  const result = createArchiveV2MemoryPeopleResult({
    manifest, batches, createdAt: TIME,
    output: {
      people: [{
        localId: 'C1', displayName: '人物2', aliases: [], recognitionReason: '独立人物',
        sourcePeopleRefs: [{ batchIndex: 1, localId: batches[1].rows.people[0].localId }],
        recommendation: 'background', recommendationReason: '按记忆判断',
      }],
      userSourcePeopleRefs: [{ batchIndex: 0, localId: 'P1' }],
    },
  });
  return { context, snapshot, manifest, batches, result };
}

function harness(records = new Map()) {
  const calls = [];
  const key = (collection, recordId) => `${collection}/${recordId}`;
  const client = {
    async get(collection, recordId) {
      calls.push(['get', collection, recordId]);
      const value = records.get(key(collection, recordId));
      if (!value) throw httpError(404);
      return structuredClone(value);
    },
    async put(collection, recordId, data, expectedRevision) {
      calls.push(['put', collection, recordId, expectedRevision]);
      const recordKey = key(collection, recordId);
      if ((records.get(recordKey)?.revision ?? 0) !== expectedRevision) throw httpError(409);
      const saved = envelope(data, expectedRevision + 1);
      records.set(recordKey, saved);
      return structuredClone(saved);
    },
  };
  const store = createArchiveV2MemoryStore({
    client,
    contextProvider: () => ({ hostChatId: 'host-chat', chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' }),
  });
  return { store, calls, records, key };
}

test('ready manifest 严格读取全部 batch，people resultId 由 scan/fingerprint 确定且旧 scan 隔离', async () => {
  const data = await fixture();
  const h = harness();
  for (let index = 0; index < data.batches.length; index += 1) {
    h.records.set(h.key(`chat-${CHAT}`, data.manifest.batchRefs[index].recordId), envelope(data.batches[index]));
  }
  const read = await h.store.readReadyBatches({ manifest: data.manifest, plans: data.snapshot.batches });
  assert.equal(read.status, 'ready');
  assert.deepEqual(read.batches, data.batches);
  assert.equal(h.calls.filter(call => call[0] === 'get').length, 2);
  const first = await createArchiveV2MemoryPeopleRecordId(data.manifest);
  const second = await createArchiveV2MemoryPeopleRecordId(data.manifest);
  const other = await createArchiveV2MemoryPeopleRecordId({ ...data.manifest, scanId: 'scan-other' });
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.match(first, /^memory-people-[0-9a-f]{64}$/);
});

test('people candidate 404、首次 revision 0 保存、已有结果读取与 CAS winner 复用均不污染', async () => {
  const data = await fixture();
  const originalBatches = structuredClone(data.batches);
  const resultId = await createArchiveV2MemoryPeopleRecordId(data.manifest);
  const h = harness();
  assert.deepEqual(await h.store.readPeopleResult(data), { status: 'missing', recordId: resultId });
  const saved = await h.store.putPeopleResult(data);
  assert.equal(saved.status, 'saved');
  assert.deepEqual(h.calls.find(call => call[0] === 'put').slice(2), [resultId, 0]);
  const existing = await h.store.readPeopleResult(data);
  assert.equal(existing.status, 'ready');
  assert.deepEqual(existing.result, data.result);
  assert.deepEqual(existing.result.userSourcePeopleRefs, [{ batchIndex: 0, localId: 'P1' }]);
  assert.deepEqual(data.batches, originalBatches);

  const winner = structuredClone(data.result);
  winner.people[0].recommendationReason = '另一个合法并发结果';
  h.records.set(h.key(`chat-${CHAT}`, resultId), envelope(winner, 3));
  const reused = await h.store.putPeopleResult(data);
  assert.equal(reused.status, 'reused');
  assert.equal(reused.revision, 3);
  assert.equal(reused.result.people[0].recommendationReason, '另一个合法并发结果');
  assert.equal(h.records.get(h.key(`chat-${CHAT}`, resultId)).revision, 3);
});
