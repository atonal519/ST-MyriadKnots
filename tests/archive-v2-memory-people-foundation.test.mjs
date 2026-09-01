import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createArchiveV2MemoryBatch,
  createArchiveV2MemoryManifest,
  createArchiveV2MemorySnapshot,
  validateArchiveV2MemoryManifest,
} from '../src/archive-v2-memory-foundation.js';
import {
  createArchiveV2MemoryPeopleResult,
  validateArchiveV2MemoryPeopleResult,
} from '../src/archive-v2-memory-people-foundation.js';
import { createArchiveV2MemoryBatchRecordId } from '../src/archive-v2-memory-store.js';

export const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const TIME = '2026-09-01T01:02:03.000Z';

const assistant = content => ({
  is_user: false, is_system: false, mes: content, swipe_id: 0, swipes: [content], extra: {},
});

export async function peopleFixture() {
  const context = {
    characterId: 0,
    characters: [{ avatar: 'character.png' }],
    userAvatar: 'persona.png',
    chatId: 'host-chat',
    chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT } },
    chat: [assistant('沈砚帮助用户。'), assistant('阿砚再次出现。陆离路过。')],
  };
  const snapshot = await createArchiveV2MemorySnapshot(context, { maxFloorsPerBatch: 1 });
  const base = createArchiveV2MemoryManifest({ snapshot, scanId: 'scan-people', createdAt: TIME });
  const rows = [
    {
      people: [{ localId: 'P1', displayName: '沈砚', aliases: [], sourceFloors: [0] }],
      facts: [],
      relations: [{ subjectLocalId: 'P1', objectKind: 'user', objectLocalId: null, category: 'bond', summary: '帮助用户', sourceFloors: [0] }],
      events: [{ localId: 'E1', title: '相助', summary: '沈砚帮助用户', participantLocalIds: ['P1'], involvesUser: true, significance: 'major', sourceFloors: [0] }],
    },
    {
      people: [
        { localId: 'P1', displayName: '阿砚', aliases: ['沈砚'], sourceFloors: [1] },
        { localId: 'P2', displayName: '陆离', aliases: [], sourceFloors: [1] },
      ],
      facts: [{ subjectLocalId: 'P1', category: 'identity', value: '同一人物', sourceFloors: [1] }],
      relations: [],
      events: [],
    },
  ];
  const refs = [];
  const batches = [];
  for (const plan of snapshot.batches) {
    const batch = createArchiveV2MemoryBatch({ manifest: base, plan, rows: rows[plan.batchIndex], createdAt: TIME });
    const recordId = await createArchiveV2MemoryBatchRecordId({
      scanId: base.scanId,
      batchIndex: plan.batchIndex,
      sourceFingerprint: plan.sourceFingerprint,
    });
    refs.push({ batchIndex: plan.batchIndex, recordId, sourceFingerprint: plan.sourceFingerprint });
    batches.push(batch);
  }
  const manifest = validateArchiveV2MemoryManifest({
    ...structuredClone(base),
    completedBatchIndexes: [0, 1],
    status: 'ready',
    batchRefs: refs,
  });
  return { context, snapshot, manifest, batches };
}

export const validPeopleOutput = () => ({
  people: [
    {
      localId: 'C1', displayName: '沈砚', aliases: ['阿砚'], recognitionReason: '两批名字与事实连续',
      sourcePeopleRefs: [{ batchIndex: 0, localId: 'P1' }, { batchIndex: 1, localId: 'P1' }],
      recommendation: 'romance_candidate', recommendationReason: '与用户存在明确关系事件',
    },
    {
      localId: 'C2', displayName: '陆离', aliases: [], recognitionReason: '独立出现的人物',
      sourcePeopleRefs: [{ batchIndex: 1, localId: 'P2' }],
      recommendation: 'background', recommendationReason: '只有路过记录',
    },
  ],
  userSourcePeopleRefs: [],
});

test('严格归并全部输入人物并本地派生统计与推荐分组排序', async () => {
  const { manifest, batches } = await peopleFixture();
  const result = createArchiveV2MemoryPeopleResult({ manifest, batches, output: validPeopleOutput(), createdAt: TIME });
  assert.deepEqual(result.people.map(person => person.localId), ['C1', 'C2']);
  assert.deepEqual(result.people[0].statistics, {
    appearanceBatchCount: 2,
    sourceFloorCount: 2,
    userRelationBatchCount: 1,
    majorEventBatchCount: 1,
  });
  assert.deepEqual(result.people[1].statistics, {
    appearanceBatchCount: 1,
    sourceFloorCount: 1,
    userRelationBatchCount: 0,
    majorEventBatchCount: 0,
  });
  assert.deepEqual(validateArchiveV2MemoryPeopleResult(result, { manifest, batches }), result);
  assert.equal(Object.isFrozen(result.people), true);
});

test('用户来源用普通 localId 分类后不进入最终人物结果', async () => {
  const { manifest, batches } = await peopleFixture();
  const originalBatches = structuredClone(batches);
  const output = {
    people: [{
      localId: 'C1', displayName: '陆离', aliases: [], recognitionReason: '独立出现的人物',
      sourcePeopleRefs: [{ batchIndex: 1, localId: 'P2' }],
      recommendation: 'background', recommendationReason: '只有路过记录',
    }],
    userSourcePeopleRefs: [
      { batchIndex: 0, localId: 'P1' },
      { batchIndex: 1, localId: 'P1' },
    ],
  };
  const result = createArchiveV2MemoryPeopleResult({ manifest, batches, output, createdAt: TIME });
  assert.deepEqual(result.people.map(person => person.displayName), ['陆离']);
  assert.deepEqual(result.userSourcePeopleRefs, output.userSourcePeopleRefs);
  assert.equal(Object.isFrozen(result.userSourcePeopleRefs), true);
  assert.equal(result.schemaVersion, 2);
  assert.deepEqual(batches, originalBatches);
  assert.deepEqual(validateArchiveV2MemoryPeopleResult(result, { manifest, batches }), result);
});

test('持久化新结果缺少任意人物或用户来源引用均失败', async () => {
  const { manifest, batches } = await peopleFixture();
  const classified = createArchiveV2MemoryPeopleResult({
    manifest,
    batches,
    createdAt: TIME,
    output: {
      people: [{
        localId: 'C1', displayName: '沈砚', aliases: ['阿砚'], recognitionReason: '两批名字与事实连续',
        sourcePeopleRefs: [{ batchIndex: 0, localId: 'P1' }, { batchIndex: 1, localId: 'P1' }],
        recommendation: 'romance_candidate', recommendationReason: '与用户存在明确关系事件',
      }],
      userSourcePeopleRefs: [{ batchIndex: 1, localId: 'P2' }],
    },
  });
  const missingNpc = structuredClone(classified);
  missingNpc.people[0].sourcePeopleRefs.pop();
  missingNpc.people[0].statistics.appearanceBatchCount = 1;
  missingNpc.people[0].statistics.sourceFloorCount = 1;
  assert.throws(() => validateArchiveV2MemoryPeopleResult(missingNpc, { manifest, batches }));
  const missingUser = structuredClone(classified);
  missingUser.userSourcePeopleRefs.pop();
  assert.throws(() => validateArchiveV2MemoryPeopleResult(missingUser, { manifest, batches }));
});

test('旧版只兼容人物引用完整覆盖的结果，缺少任意来源时失败', async () => {
  const { manifest, batches } = await peopleFixture();
  const complete = structuredClone(createArchiveV2MemoryPeopleResult({
    manifest, batches, output: validPeopleOutput(), createdAt: TIME,
  }));
  complete.schemaVersion = 1;
  delete complete.userSourcePeopleRefs;
  const normalized = validateArchiveV2MemoryPeopleResult(complete, { manifest, batches });
  assert.equal(normalized.schemaVersion, 2);
  assert.deepEqual(normalized.userSourcePeopleRefs, []);

  const incomplete = structuredClone(complete);
  incomplete.people.pop();
  assert.throws(() => validateArchiveV2MemoryPeopleResult(incomplete, { manifest, batches }));
});

test('错误、重复、遗漏引用，错误推荐枚举、额外字段和伪造统计全部失败', async () => {
  const { manifest, batches } = await peopleFixture();
  const cases = [
    { ...validPeopleOutput(), people: validPeopleOutput().people.slice(0, 1) },
    { ...validPeopleOutput(), people: validPeopleOutput().people.map((person, index) => index ? { ...person, sourcePeopleRefs: [{ batchIndex: 0, localId: 'P1' }] } : person) },
    { ...validPeopleOutput(), people: validPeopleOutput().people.map((person, index) => index ? { ...person, sourcePeopleRefs: [{ batchIndex: 9, localId: 'P2' }] } : person) },
    { ...validPeopleOutput(), people: validPeopleOutput().people.map((person, index) => index ? { ...person, recommendation: 'love_interest' } : person) },
    { ...validPeopleOutput(), people: validPeopleOutput().people.map((person, index) => index ? { ...person, localId: 'C9' } : person) },
    { ...validPeopleOutput(), people: validPeopleOutput().people.map((person, index) => index ? { ...person, extra: true } : person) },
    { people: validPeopleOutput().people },
    { ...validPeopleOutput(), extra: true },
    { ...validPeopleOutput(), userSourcePeopleRefs: [{ batchIndex: 0, localId: 'P1' }] },
    { ...validPeopleOutput(), userSourcePeopleRefs: [{ batchIndex: 9, localId: 'P9' }] },
    { ...validPeopleOutput(), people: validPeopleOutput().people.slice(0, 1), userSourcePeopleRefs: [] },
  ];
  for (const output of cases) {
    assert.throws(() => createArchiveV2MemoryPeopleResult({ manifest, batches, output, createdAt: TIME }));
  }
  const valid = structuredClone(createArchiveV2MemoryPeopleResult({ manifest, batches, output: validPeopleOutput(), createdAt: TIME }));
  valid.people[0].statistics.sourceFloorCount = 99;
  assert.throws(() => validateArchiveV2MemoryPeopleResult(valid, { manifest, batches }));
});
