import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createArchiveV2MemoryBatch,
  createArchiveV2MemoryManifest,
  createArchiveV2MemorySnapshot,
  validateArchiveV2MemoryManifest,
} from '../src/archive-v2-memory-foundation.js';
import { createArchiveV2MemoryPeopleResult } from '../src/archive-v2-memory-people-foundation.js';
import { createArchiveV2MemoryPeopleCommitter } from '../src/archive-v2-memory-people-commit.js';
import { createArchiveV2MemoryBatchRecordId } from '../src/archive-v2-memory-store.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TIME = '2026-09-01T01:02:03.000Z';
const assistant = content => ({ is_user: false, is_system: false, mes: content, swipe_id: 0, swipes: [content], extra: {} });

async function fixture() {
  const context = {
    characterId: 0, characters: [{ avatar: 'character.png' }], userAvatar: 'persona.png', chatId: 'host-chat',
    chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT } }, chat: [assistant('沈砚与陆离')],
  };
  const snapshot = await createArchiveV2MemorySnapshot(context);
  const base = createArchiveV2MemoryManifest({ snapshot, scanId: 'scan-people', createdAt: TIME });
  const plan = snapshot.batches[0];
  const batch = createArchiveV2MemoryBatch({
    manifest: base, plan, createdAt: TIME,
    rows: {
      people: [
        { localId: 'P1', displayName: '沈砚', aliases: [], sourceFloors: [0] },
        { localId: 'P2', displayName: '陆离', aliases: [], sourceFloors: [0] },
      ],
      facts: [], relations: [], events: [],
    },
  });
  const recordId = await createArchiveV2MemoryBatchRecordId({ scanId: base.scanId, batchIndex: 0, sourceFingerprint: plan.sourceFingerprint });
  const manifest = validateArchiveV2MemoryManifest({
    ...structuredClone(base), completedBatchIndexes: [0], status: 'ready',
    batchRefs: [{ batchIndex: 0, recordId, sourceFingerprint: plan.sourceFingerprint }],
  });
  const result = createArchiveV2MemoryPeopleResult({
    manifest, batches: [batch], createdAt: TIME,
    output: { people: [
      {
        localId: 'C1', displayName: '沈砚', aliases: ['阿砚'], recognitionReason: '独立人物',
        sourcePeopleRefs: [{ batchIndex: 0, localId: 'P1' }], recommendation: 'romance_candidate', recommendationReason: '有关系证据',
      },
      {
        localId: 'C2', displayName: '陆离', aliases: [], recognitionReason: '独立人物',
        sourcePeopleRefs: [{ batchIndex: 0, localId: 'P2' }], recommendation: 'background', recommendationReason: '只有背景记录',
      },
    ], userSourcePeopleRefs: [] },
  });
  return { manifest, batches: [batch], result };
}

const ids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
];
const identity = { characterLocator: 'character.png', personaLocator: 'persona.png', personaSummary: '' };

test('确认前不创建；确认后全部人物同一 archive-v2 恰好落档，选中关注、其余静默且 fields 为空', async () => {
  const data = await fixture();
  let createdArchive = null;
  let createIds = 0;
  const adapter = {
    async read() { return { status: 'uninitialized' }; },
    async create({ archive }) { createdArchive = archive; return { status: 'created', archive, revision: 1, warnings: [] }; },
  };
  const committer = createArchiveV2MemoryPeopleCommitter({
    archiveAdapter: adapter,
    createIdentityId: () => ids[createIds++],
    now: () => TIME,
  });
  assert.equal(createdArchive, null);
  const saved = await committer.commit({ ...data, selectedLocalIds: ['C1'], identity });
  assert.equal(saved.status, 'created');
  assert.equal(saved.followedCount, 1);
  assert.equal(saved.silentCount, 1);
  assert.deepEqual(createdArchive.people.order, ids);
  assert.equal(createdArchive.people.byId[ids[0]].followed, true);
  assert.equal(createdArchive.people.byId[ids[1]].followed, false);
  assert.deepEqual(createdArchive.people.byId[ids[0]].fields, {});
  assert.equal(createdArchive.people.byId[ids[0]].recommendation.value, 'romance_candidate');
  assert.equal(createdArchive.initialization.sources.length, 1);
  assert.equal(createdArchive.initialization.sources[0].content, '');
  assert.equal(Object.hasOwn(createdArchive, 'silentPeople'), false);
});

test('已有正式档案或 create CAS 冲突均不覆盖，候选不变且已有档案时不生成 UUID', async () => {
  const data = await fixture();
  let idCalls = 0;
  let createCalls = 0;
  const existing = createArchiveV2MemoryPeopleCommitter({
    archiveAdapter: {
      async read() { return { status: 'ready', archive: {}, revision: 1, warnings: [] }; },
      async create() { createCalls += 1; throw new Error('不应创建'); },
    },
    createIdentityId: () => { idCalls += 1; return ids[0]; },
    now: () => TIME,
  });
  assert.deepEqual(await existing.commit({ ...data, selectedLocalIds: ['C1'], identity }), { status: 'conflict' });
  assert.equal(idCalls, 0);
  assert.equal(createCalls, 0);

  let attempted = null;
  const conflict = createArchiveV2MemoryPeopleCommitter({
    archiveAdapter: {
      async read() { return { status: 'uninitialized' }; },
      async create({ archive }) { attempted = archive; return { status: 'conflict' }; },
    },
    createIdentityId: ({ localId }) => localId === 'C1' ? ids[0] : ids[1],
    now: () => TIME,
  });
  assert.deepEqual(await conflict.commit({ ...data, selectedLocalIds: ['C1'], identity }), { status: 'conflict' });
  assert.ok(attempted);
  assert.deepEqual(data.result.people.map(person => person.localId), ['C1', 'C2']);
});
