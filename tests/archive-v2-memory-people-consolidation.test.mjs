import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createArchiveV2MemoryBatch,
  createArchiveV2MemoryManifest,
  createArchiveV2MemorySnapshot,
  validateArchiveV2MemoryManifest,
} from '../src/archive-v2-memory-foundation.js';
import { createArchiveV2MemoryPeopleConsolidator } from '../src/archive-v2-memory-people-consolidation.js';
import { createArchiveV2MemoryBatchRecordId } from '../src/archive-v2-memory-store.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TIME = '2026-09-01T01:02:03.000Z';
const assistant = content => ({ is_user: false, is_system: false, mes: content, swipe_id: 0, swipes: [content], extra: {} });
const identity = () => ({ hostChatId: 'host-chat', chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' });

async function fixture() {
  const context = {
    characterId: 0, characters: [{ avatar: 'character.png' }], userAvatar: 'persona.png', chatId: 'host-chat',
    chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT } }, chat: [assistant('原始正文不会直接进入第二层')],
  };
  const snapshot = await createArchiveV2MemorySnapshot(context);
  const base = createArchiveV2MemoryManifest({ snapshot, scanId: 'scan-people', createdAt: TIME });
  const plan = snapshot.batches[0];
  const batch = createArchiveV2MemoryBatch({
    manifest: base,
    plan,
    rows: {
      people: [{ localId: 'P1', displayName: '沈砚', aliases: [], sourceFloors: [0] }],
      facts: [], relations: [], events: [],
    },
    createdAt: TIME,
  });
  const recordId = await createArchiveV2MemoryBatchRecordId({ scanId: base.scanId, batchIndex: 0, sourceFingerprint: plan.sourceFingerprint });
  const manifest = validateArchiveV2MemoryManifest({
    ...structuredClone(base), completedBatchIndexes: [0], status: 'ready',
    batchRefs: [{ batchIndex: 0, recordId, sourceFingerprint: plan.sourceFingerprint }],
  });
  return { manifest, batches: [batch] };
}

const validOutput = () => ({ people: [{
  localId: 'C1', displayName: '沈砚', aliases: [], recognitionReason: '独立人物',
  sourcePeopleRefs: [{ batchIndex: 0, localId: 'P1' }], recommendation: 'uncertain',
  recommendationReason: '没有足够恋爱证据',
}], userSourcePeopleRefs: [] });

function harness(response) {
  const calls = [];
  const consolidator = createArchiveV2MemoryPeopleConsolidator({
    contextProvider: identity,
    generateTask: async options => { calls.push(options); return typeof response === 'function' ? response(options) : response; },
    now: () => TIME,
  });
  return { consolidator, calls };
}

test('一次普通聊天请求完整携带批次表格，不传 jsonSchema、卡或世界书', async () => {
  const data = await fixture();
  const h = harness(options => {
    assert.equal(Object.hasOwn(options, 'jsonSchema'), false);
    assert.equal(options.includeCharacterCard, false);
    assert.equal(options.worldInfoSource, 'none');
    for (const token of [
      'localId', 'displayName', 'aliases', 'recognitionReason', 'sourcePeopleRefs',
      'userSourcePeopleRefs',
      'recommendation', 'recommendationReason', 'romance_candidate', 'important_supporting', 'background', 'uncertain',
      '不得读取、推断或声称读取角色卡、世界书', '全部输入 people 行', '当前用户/主角本人',
      '不得仅凭字符串猜测排除', '一个纯 JSON',
    ]) assert.ok(options.systemPrompt.includes(token), token);
    const input = JSON.parse(options.taskMessages[0].content);
    assert.deepEqual(input[0], { batchIndex: 0, ...data.batches[0].rows });
    assert.equal(JSON.stringify(input).includes('原始正文不会直接进入第二层'), false);
    return JSON.stringify(validOutput());
  });
  const result = await h.consolidator.consolidate(data);
  assert.equal(result.status, 'ready');
  assert.equal(result.result.people[0].displayName, '沈砚');
  assert.deepEqual(result.result.userSourcePeopleRefs, []);
  assert.equal(h.calls.length, 1);
});

test('普通 JSON 与单 fenced JSON 成功；缺字段、错引用、重复归属、额外字段均一次失败且不重试', async () => {
  const data = await fixture();
  for (const response of [JSON.stringify(validOutput()), `\`\`\`json\n${JSON.stringify(validOutput())}\n\`\`\``]) {
    const h = harness(response);
    assert.equal((await h.consolidator.consolidate(data)).status, 'ready');
    assert.equal(h.calls.length, 1);
  }
  const invalid = [
    { ...validOutput(), people: [{ ...validOutput().people[0], recommendationReason: undefined }] },
    { ...validOutput(), people: [{ ...validOutput().people[0], sourcePeopleRefs: [{ batchIndex: 0, localId: 'P9' }] }] },
    { ...validOutput(), people: [validOutput().people[0], { ...validOutput().people[0], localId: 'C2' }] },
    { ...validOutput(), people: [{ ...validOutput().people[0], extra: true }] },
  ];
  for (const output of invalid) {
    const h = harness({ jsonData: output });
    await assert.rejects(h.consolidator.consolidate(data), error => error.code === 'ARCHIVE_V2_MEMORY_PEOPLE_CONSOLIDATION_FORMAT');
    assert.equal(h.calls.length, 1);
  }
});

test('模块不含 schema transport、重试、卡/世界书采集或后端实现', async () => {
  const source = await readFile(new URL('../src/archive-v2-memory-people-consolidation.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /jsonSchema\s*:|collectSources|retry|client\.(?:get|put)|fetch\(/);
});
