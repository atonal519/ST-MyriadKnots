import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyArchiveV2, validateArchiveV2 } from '../src/archive-v2.js';
import {
  applyArchiveV2FollowedProfileDraft,
  ARCHIVE_V2_FOLLOWED_PROFILE_FIELD_KEYS,
  archiveV2FollowedProfilePrompt,
  createArchiveV2FollowedProfileDraft,
  createArchiveV2FollowedProfilePlan,
} from '../src/archive-v2-followed-profile-foundation.js';
import {
  createArchiveV2MemoryBatch,
  createArchiveV2MemoryManifest,
  createArchiveV2MemorySnapshot,
  validateArchiveV2MemoryManifest,
} from '../src/archive-v2-memory-foundation.js';
import { createArchiveV2MemoryPeopleResult } from '../src/archive-v2-memory-people-foundation.js';
import { createArchiveV2MemoryBatchRecordId } from '../src/archive-v2-memory-store.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FOLLOWED = '11111111-1111-4111-8111-111111111111';
const SILENT = '22222222-2222-4222-8222-222222222222';
const TIME = '2026-09-01T01:02:03.000Z';
const assistant = content => ({ is_user: false, is_system: false, mes: content, swipe_id: 0, swipes: [content], extra: {} });
const owned = (value, sourceRefs, userProtected = false) => ({ value, origin: userProtected ? 'user' : 'ai', sourceRefs, userProtected });
const hash = digit => `sha256:${digit.repeat(64)}`;

async function fixture() {
  const context = {
    characterId: 0, characters: [{ avatar: 'character.png' }], userAvatar: 'persona.png', chatId: 'host-chat',
    chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT } }, chat: [assistant('林少白出现。陆离路过。')],
  };
  const snapshot = await createArchiveV2MemorySnapshot(context);
  const base = createArchiveV2MemoryManifest({ snapshot, scanId: 'scan-profile', createdAt: TIME });
  const rows = {
    people: [
      { localId: 'P1', displayName: '林少白', aliases: [], sourceFloors: [0] },
      { localId: 'P2', displayName: '陆离', aliases: [], sourceFloors: [0] },
      { localId: 'P3', displayName: 'Charles', aliases: [], sourceFloors: [0] },
      { localId: 'P4', displayName: 'Ethan', aliases: [], sourceFloors: [0] },
    ],
    facts: [
      { subjectLocalId: 'P1', category: 'personality', value: '沉静', sourceFloors: [0] },
      { subjectLocalId: 'P3', category: 'identity', value: 'Charles 的独立事实', sourceFloors: [0] },
      { subjectLocalId: 'P4', category: 'identity', value: 'Ethan 的独立事实', sourceFloors: [0] },
    ],
    relations: [{ subjectLocalId: 'P1', objectKind: 'person', objectLocalId: 'P2', category: 'bond', summary: '林少白与陆离相识', sourceFloors: [0] }],
    events: [
      { localId: 'E1', title: '相遇', summary: '林少白与陆离相遇', participantLocalIds: ['P1', 'P2'], involvesUser: false, significance: 'major', sourceFloors: [0] },
      { localId: 'E2', title: 'Charles 独立事件', summary: 'Charles 单独行动', participantLocalIds: ['P3'], involvesUser: false, significance: 'supporting', sourceFloors: [0] },
      { localId: 'E3', title: 'Ethan 独立事件', summary: 'Ethan 单独行动', participantLocalIds: ['P4'], involvesUser: false, significance: 'supporting', sourceFloors: [0] },
    ],
  };
  const batch = createArchiveV2MemoryBatch({ manifest: base, plan: snapshot.batches[0], rows, createdAt: TIME });
  const recordId = await createArchiveV2MemoryBatchRecordId({
    scanId: base.scanId, batchIndex: 0, sourceFingerprint: snapshot.batches[0].sourceFingerprint,
  });
  const manifest = validateArchiveV2MemoryManifest({
    ...structuredClone(base), completedBatchIndexes: [0], status: 'ready',
    batchRefs: [{ batchIndex: 0, recordId, sourceFingerprint: batch.sourceFingerprint }],
  });
  const peopleResult = createArchiveV2MemoryPeopleResult({
    manifest, batches: [batch], createdAt: TIME,
    output: { people: [
      {
        localId: 'C1', displayName: '林少白', aliases: ['Charles', 'Ethan'], recognitionReason: '同一人物',
        sourcePeopleRefs: [
          { batchIndex: 0, localId: 'P1' },
          { batchIndex: 0, localId: 'P3' },
          { batchIndex: 0, localId: 'P4' },
        ], recommendation: 'romance_candidate', recommendationReason: '主线人物',
      },
      {
        localId: 'C2', displayName: '陆离', aliases: [], recognitionReason: '独立人物',
        sourcePeopleRefs: [{ batchIndex: 0, localId: 'P2' }], recommendation: 'background', recommendationReason: '路过',
      },
    ], userSourcePeopleRefs: [] },
  });
  const memoryRef = { kind: 'chat', locator: 'memory-batch:0', fingerprint: batch.sourceFingerprint };
  const archive = createEmptyArchiveV2({
    chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png', personaSummary: '',
  });
  archive.people = {
    order: [FOLLOWED, SILENT],
    byId: {
      [FOLLOWED]: {
        identityId: FOLLOWED, followed: true,
        displayName: owned('林少白', [memoryRef]), aliases: owned(['Charles', 'Ethan'], [memoryRef]),
        fields: { personality: owned('用户写定的性格', [], true) }, sourceRefs: [memoryRef],
      },
      [SILENT]: {
        identityId: SILENT, followed: false,
        displayName: owned('陆离', [memoryRef]), aliases: owned([], [memoryRef]), fields: {}, sourceRefs: [memoryRef],
      },
    },
  };
  return { manifest, batches: [batch], peopleResult, archive: validateArchiveV2(archive) };
}

function routeSources() {
  const source = (kind, locator, content, availability, selected = true, digit = 'a') => ({
    kind, locator, content, availability, selected, fingerprint: hash(digit),
  });
  return [
    source('card', 'card:character.png#description', '林少白的角色卡资料', 'card', true, '1'),
    source('greeting', 'greeting:0:2', '当前实际开场白', 'greeting', true, '2'),
    source('worldbook', '主世界:1', '常驻世界背景，不含姓名', 'activated', true, '3'),
    source('worldbook', '主世界:2', '林少白所属组织', 'enabled', true, '4'),
    source('worldbook', '主世界:3', 'Charles 与 Ethan 的其他 IF 线', 'enabled', true, '5'),
    source('worldbook', '主世界:4', '林少白的禁用支线', 'disabled', true, '6'),
    source('worldbook', '主世界:5', '林少白与陆离的共同设定', 'enabled', true, '7'),
  ];
}

test('计划只处理 followed，世界书采用激活或稳定姓名/别名规则', async () => {
  const data = await fixture();
  const plan = createArchiveV2FollowedProfilePlan({ ...data, revision: 7, sources: routeSources() });
  assert.equal(ARCHIVE_V2_FOLLOWED_PROFILE_FIELD_KEYS.length, 11);
  assert.deepEqual(plan.people.map(person => [person.person, person.identityId, person.displayName]), [['P1', FOLLOWED, '林少白']]);
  assert.deepEqual(plan.sources.filter(source => source.kind === 'worldbook').map(source => source.locator), ['主世界:1', '主世界:2', '主世界:3', '主世界:5']);
  assert.equal(plan.sources.some(source => source.locator === '主世界:3'), true);
  assert.equal(plan.sources.some(source => source.locator === '主世界:4'), false);
  const prompt = archiveV2FollowedProfilePrompt(plan);
  assert.match(prompt, /林少白|当前实际开场白|常驻世界背景/);
  assert.doesNotMatch(prompt, /11111111|memory-batch:|sha256:|主世界:2/);
  assert.match(prompt, /person|source|memory/);

  const memory = JSON.parse(plan.sources.find(source => source.kind === 'chat').content);
  assert.deepEqual(memory.people.map(person => person.localId), ['P1', 'P2']);
  assert.deepEqual(memory.facts.map(fact => fact.subjectLocalId), ['P1']);
  assert.deepEqual(memory.events.map(event => event.localId), ['E1']);
  assert.equal(memory.facts.some(fact => /Charles|Ethan/.test(fact.value)), false);
  assert.equal(memory.events.some(event => /Charles|Ethan/.test(event.title)), false);

  const withoutExplicitFollow = structuredClone(data.archive);
  delete withoutExplicitFollow.people.byId[SILENT].followed;
  const strictPlan = createArchiveV2FollowedProfilePlan({
    ...data, archive: validateArchiveV2(withoutExplicitFollow), revision: 7, sources: routeSources(),
  });
  assert.deepEqual(strictPlan.people.map(person => person.displayName), ['林少白']);
});

test('enabled 世界书按确认姓名绑定人物，跨人物引用会被校验器拒绝', async () => {
  const data = await fixture();
  data.archive.people.byId[SILENT].followed = true;
  const plan = createArchiveV2FollowedProfilePlan({
    ...data, archive: validateArchiveV2(data.archive), revision: 7, sources: routeSources(),
  });
  const personA = plan.people.find(person => person.displayName === '林少白');
  const personB = plan.people.find(person => person.displayName === '陆离');
  const onlyA = plan.sources.find(source => source.locator === '主世界:2');
  const both = plan.sources.find(source => source.locator === '主世界:5');
  const sharedActivated = plan.sources.find(source => source.locator === '主世界:1');
  assert.deepEqual(onlyA.people, [personA.person]);
  assert.equal(personA.sourceCodes.includes(onlyA.code), true);
  assert.equal(personB.sourceCodes.includes(onlyA.code), false);
  assert.equal(both, undefined, '同时命中多人物的非激活条目安全丢弃，避免串源');
  assert.deepEqual(sharedActivated.people, [personA.person, personB.person]);

  assert.throws(() => createArchiveV2FollowedProfileDraft({ plan, output: { people: [
    { person: personA.person, fields: [] },
    { person: personB.person, fields: [{ field: 'identity', text: '不应接受', evidence: [onlyA.code] }] },
  ] } }), error => error?.code === 'ARCHIVE_V2_FOLLOWED_PROFILE_SOURCE_MISMATCH');

  const valid = createArchiveV2FollowedProfileDraft({ plan, output: { people: [
    { person: personA.person, fields: [{ field: 'relationships', text: '与陆离有共同设定', evidence: [sharedActivated.code] }] },
    { person: personB.person, fields: [{ field: 'relationships', text: '与林少白有共同设定', evidence: [sharedActivated.code] }] },
  ] } });
  assert.deepEqual(valid.people.map(person => Object.keys(person.fields)), [['relationships'], ['relationships']]);
});

test('用户改名后仍按稳定顺序对应 memory 人物并用原姓名路由世界书', async () => {
  const data = await fixture();
  data.archive.people.byId[FOLLOWED].displayName = owned('用户改名林先生', data.archive.people.byId[FOLLOWED].sourceRefs, true);
  const plan = createArchiveV2FollowedProfilePlan({
    ...data, archive: validateArchiveV2(data.archive), revision: 7, sources: routeSources(),
  });
  assert.equal(plan.people[0].displayName, '用户改名林先生');
  assert.ok(plan.sources.some(source => source.locator === '主世界:2' && source.people.includes('P1')));
});

test('稀疏结果保留 11 字段中的有效项，逐字段丢弃未知/坏证据且串号阻断', async () => {
  const data = await fixture();
  const plan = createArchiveV2FollowedProfilePlan({ ...data, revision: 7, sources: routeSources() });
  const memoryCode = plan.sources.find(source => source.kind === 'chat').code;
  const draft = createArchiveV2FollowedProfileDraft({ plan, output: { people: [{ person: 'P1', fields: [
    { field: 'gender', text: '男性', evidence: [memoryCode] },
    { field: 'unknownField', text: '应丢弃', evidence: [memoryCode] },
    { field: 'appearance', text: '应丢弃', evidence: ['W999'] },
    { field: 'age', text: '', evidence: [] },
  ] }] } });
  assert.deepEqual(Object.keys(draft.people[0].fields), ['gender']);
  assert.equal(draft.people[0].fields.gender.origin, 'ai');
  assert.equal(draft.people[0].fields.gender.userProtected, false);
  assert.deepEqual(draft.people[0].fields.gender.sourceRefs, [{
    kind: 'chat', locator: 'memory-batch:0', fingerprint: data.batches[0].sourceFingerprint,
  }]);
  assert.throws(
    () => createArchiveV2FollowedProfileDraft({ plan, output: { people: [{ person: 'P2', fields: [] }] } }),
    /人物代号/,
  );
});

test('保存合并不覆盖 userProtected，静默人物不写字段', async () => {
  const data = await fixture();
  const plan = createArchiveV2FollowedProfilePlan({ ...data, revision: 7, sources: routeSources() });
  const sourceCode = plan.sources.find(source => source.kind === 'card').code;
  const draft = createArchiveV2FollowedProfileDraft({ plan, output: { people: [{ person: 'P1', fields: [
    { field: 'personality', text: 'AI 性格', evidence: [sourceCode] },
    { field: 'identity', text: '调查员', evidence: [sourceCode] },
    { field: 'nsfwPreferences', text: '尊重边界', evidence: [sourceCode] },
  ] }] } });
  const applied = applyArchiveV2FollowedProfileDraft({ archive: data.archive, revision: 7, draft });
  assert.equal(applied.protectedFieldCount, 1);
  assert.equal(applied.savedFieldCount, 2);
  assert.equal(applied.archive.people.byId[FOLLOWED].fields.personality.value, '用户写定的性格');
  assert.equal(applied.archive.people.byId[FOLLOWED].fields.identity.value, '调查员');
  assert.equal(applied.archive.people.byId[FOLLOWED].fields.nsfwPreferences.value, '尊重边界');
  assert.deepEqual(applied.archive.people.byId[SILENT].fields, {});
  assert.throws(() => applyArchiveV2FollowedProfileDraft({ archive: data.archive, revision: 8, draft }), /revision/);
});
