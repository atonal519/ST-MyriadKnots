import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/identity.js';
import { validateArchiveV2 } from '../src/archive-v2.js';
import {
  ARCHIVE_V2_PROFILE_DRAFT_KIND,
  ARCHIVE_V2_PROFILE_FIELD_KEYS,
} from '../src/archive-v2-profile-generation.js';
import {
  ARCHIVE_V2_INITIALIZATION_REVIEW_KIND,
  ArchiveV2InitializationReviewError,
  buildInitializedArchiveV2,
  createArchiveV2InitializationReview,
  setArchiveV2InitializationField,
} from '../src/archive-v2-initialization-review.js';

const CHAT = '11111111-1111-4111-8111-111111111111';
const CONFIRMED_AT = '2026-08-31T10:20:30.000Z';
const IDENTITY = {
  characterLocator: 'char.png',
  personaLocator: 'persona.png',
  personaSummary: '用户 Persona 摘要',
};
const fingerprint = char => `sha256:${char.repeat(64).slice(0, 64)}`;
const source = (content, overrides = {}) => ({
  id: 'card:card:char.png#description',
  kind: 'card',
  locator: 'card:char.png#description',
  fingerprint: fingerprint('a'),
  label: '角色描述',
  content,
  selected: true,
  availability: 'card',
  ...overrides,
});
const sourceRef = value => ({
  kind: value.kind,
  locator: value.locator,
  fingerprint: value.fingerprint,
});

async function computeFingerprint(sources) {
  const selected = sources.filter(item => item.selected === true && item.availability !== 'disabled');
  const parts = [];
  for (const item of selected) {
    parts.push({
      kind: item.kind,
      locator: item.locator,
      fingerprint: item.fingerprint,
      contentFingerprint: `sha256:${await sha256(item.content)}`,
    });
  }
  return `sha256:${await sha256(JSON.stringify(parts))}`;
}

function aiField(value = '', refs = []) {
  return { value, origin: 'ai', sourceRefs: refs.map(ref => ({ ...ref })), userProtected: false };
}

function fields(ref) {
  return Object.fromEntries(ARCHIVE_V2_PROFILE_FIELD_KEYS.map(key => [
    key,
    key === 'gender' ? aiField('男性', [ref]) : aiField(),
  ]));
}

async function fixture({ ids = ['p1', 'p2'], extraSources = [] } = {}) {
  const sources = [
    source('沈砚：成年男性，性格沉静。'),
    source('阿福是重要配角。', {
      id: 'worldbook:book:1',
      kind: 'worldbook',
      locator: 'book:1',
      fingerprint: fingerprint('b'),
      availability: 'enabled',
    }),
    ...extraSources,
  ];
  const people = ids.map((identityId, index) => {
    const evidenceSource = sources[index % 2];
    const ref = sourceRef(evidenceSource);
    return {
      identityId,
      displayName: index === 0 ? '沈砚' : `人物${index + 1}`,
      aliases: index === 0 ? ['阿砚'] : [],
      recognitionReason: '初始化识别依据。',
      sourceRefs: [ref],
      fields: fields(ref),
    };
  });
  return {
    sources,
    draft: {
      schemaVersion: 1,
      kind: ARCHIVE_V2_PROFILE_DRAFT_KIND,
      chatId: CHAT,
      sourceFingerprint: await computeFingerprint(sources),
      people,
    },
  };
}

test('合法第五批草稿创建审核态并与输入深拷贝隔离', async () => {
  const f = await fixture();
  const review = createArchiveV2InitializationReview(f.draft);
  assert.equal(review.kind, ARCHIVE_V2_INITIALIZATION_REVIEW_KIND);
  assert.deepEqual(review.people, f.draft.people);
  review.people[0].aliases.push('外部修改');
  review.people[0].fields.gender.sourceRefs[0].locator = 'changed';
  assert.deepEqual(f.draft.people[0].aliases, ['阿砚']);
  assert.equal(f.draft.people[0].fields.gender.sourceRefs[0].locator, f.sources[0].locator);
});

test('修改字段转为用户所有、清空旧证据且其他字段保持不变', async () => {
  const f = await fixture();
  const review = createArchiveV2InitializationReview(f.draft);
  const updated = setArchiveV2InitializationField(review, {
    identityId: 'p1',
    field: 'gender',
    value: '  非二元  ',
  });
  assert.deepEqual(updated.people[0].fields.gender, {
    value: '非二元', origin: 'user', sourceRefs: [], userProtected: true,
  });
  assert.deepEqual(updated.people[0].fields.age, review.people[0].fields.age);
  assert.deepEqual(review.people[0].fields.gender, f.draft.people[0].fields.gender);
});

test('修改为空合法，非法字段、类型、超长值和不存在人物均拒绝', async () => {
  const f = await fixture();
  const review = createArchiveV2InitializationReview(f.draft);
  const emptied = setArchiveV2InitializationField(review, {
    identityId: 'p1', field: 'gender', value: '   ',
  });
  assert.deepEqual(emptied.people[0].fields.gender, {
    value: '', origin: 'user', sourceRefs: [], userProtected: true,
  });
  const cases = [
    { identityId: 'p1', field: 'currentGoal', value: '目标' },
    { identityId: 'p1', field: 'gender', value: 1 },
    { identityId: 'p1', field: 'gender', value: 'x'.repeat(1201) },
    { identityId: 'missing', field: 'gender', value: '男性' },
  ];
  for (const change of cases) {
    assert.throws(() => setArchiveV2InitializationField(review, change), ArchiveV2InitializationReviewError);
  }
  const nearLimit = structuredClone(f.draft);
  nearLimit.people = Array.from({ length: 10 }, (_, index) => ({
    ...structuredClone(f.draft.people[0]),
    identityId: `near-limit-${index}`,
    fields: Object.fromEntries(ARCHIVE_V2_PROFILE_FIELD_KEYS.map(key => [
      key,
      aiField('x'.repeat(999), [sourceRef(f.sources[0])]),
    ])),
  }));
  const nearLimitReview = createArchiveV2InitializationReview(nearLimit);
  assert.throws(() => setArchiveV2InitializationField(nearLimitReview, {
    identityId: 'near-limit-0', field: 'gender', value: 'x'.repeat(1200),
  }), ArchiveV2InitializationReviewError);
});

test('草稿与审核态固定键、十字段、所有权、重复 ID/ref 均严格拒绝', async () => {
  const f = await fixture();
  const invalidDrafts = [];
  invalidDrafts.push({ ...f.draft, loading: true });
  const missingField = structuredClone(f.draft);
  delete missingField.people[0].fields.age;
  invalidDrafts.push(missingField);
  const badOwnership = structuredClone(f.draft);
  badOwnership.people[0].fields.gender.userProtected = true;
  invalidDrafts.push(badOwnership);
  const userOwnedDraft = structuredClone(f.draft);
  userOwnedDraft.people[0].fields.gender = {
    value: '男性', origin: 'user', sourceRefs: [], userProtected: true,
  };
  invalidDrafts.push(userOwnedDraft);
  invalidDrafts.push({ ...f.draft, people: [f.draft.people[0], structuredClone(f.draft.people[0])] });
  const duplicateRef = structuredClone(f.draft);
  duplicateRef.people[0].sourceRefs.push(structuredClone(duplicateRef.people[0].sourceRefs[0]));
  invalidDrafts.push(duplicateRef);
  const contentRef = structuredClone(f.draft);
  contentRef.people[0].sourceRefs[0].content = '不得夹带正文';
  invalidDrafts.push(contentRef);
  const duplicateFieldRef = structuredClone(f.draft);
  duplicateFieldRef.people[0].fields.gender.sourceRefs.push(
    structuredClone(duplicateFieldRef.people[0].fields.gender.sourceRefs[0]),
  );
  invalidDrafts.push(duplicateFieldRef);
  const totalTooLong = structuredClone(f.draft);
  totalTooLong.people = Array.from({ length: 9 }, (_, index) => ({
    ...structuredClone(f.draft.people[0]),
    identityId: `long-${index}`,
    fields: Object.fromEntries(ARCHIVE_V2_PROFILE_FIELD_KEYS.map(key => [
      key,
      aiField('x'.repeat(1200), [sourceRef(f.sources[0])]),
    ])),
  }));
  invalidDrafts.push(totalTooLong);
  const cyclic = structuredClone(f.draft);
  cyclic.people[0].cycle = cyclic;
  invalidDrafts.push(cyclic);
  const symbolKey = structuredClone(f.draft);
  symbolKey[Symbol('hidden')] = true;
  invalidDrafts.push(symbolKey);
  const accessor = structuredClone(f.draft);
  Object.defineProperty(accessor.people[0], 'displayName', {
    enumerable: true,
    get() { throw new Error('不得执行 getter'); },
  });
  invalidDrafts.push(accessor);
  for (const draft of invalidDrafts) {
    assert.throws(() => createArchiveV2InitializationReview(draft), ArchiveV2InitializationReviewError);
  }

  const review = createArchiveV2InitializationReview(f.draft);
  const invalidReview = structuredClone(review);
  invalidReview.people[0].fields.gender = {
    value: '用户值', origin: 'user', sourceRefs: [], userProtected: false,
  };
  assert.throws(
    () => setArchiveV2InitializationField(invalidReview, { identityId: 'p1', field: 'age', value: '20' }),
    ArchiveV2InitializationReviewError,
  );
});

test('合法审核态组装完整 archive 并通过现有验证器', async () => {
  const f = await fixture();
  const review = createArchiveV2InitializationReview(f.draft);
  const archive = await buildInitializedArchiveV2({
    review, sources: f.sources, identity: IDENTITY, confirmedAt: CONFIRMED_AT,
  });
  assert.deepEqual(validateArchiveV2(archive, { expectedChatId: CHAT }), archive);
  assert.equal(archive.schemaVersion, 1);
  assert.equal(archive.kind, 'myriad-knots-archive');
  assert.deepEqual(archive.events, []);
  assert.deepEqual(archive.bonds, {});
  assert.deepEqual(archive.nextSteps, { items: [] });
  assert.deepEqual(archive.progress, { lastConfirmedFloor: null });
});

test('姓名和别名固定为用户保护，未修改基础字段保留 AI 所有权', async () => {
  const f = await fixture();
  const review = createArchiveV2InitializationReview(f.draft);
  const archive = await buildInitializedArchiveV2({
    review, sources: f.sources, identity: IDENTITY, confirmedAt: CONFIRMED_AT,
  });
  const person = archive.people.byId.p1;
  assert.deepEqual(person.displayName, {
    value: '沈砚', origin: 'user', sourceRefs: [sourceRef(f.sources[0])], userProtected: true,
  });
  assert.deepEqual(person.aliases, {
    value: ['阿砚'], origin: 'user', sourceRefs: [sourceRef(f.sources[0])], userProtected: true,
  });
  assert.equal(person.fields.gender.origin, 'ai');
  assert.equal(person.fields.gender.userProtected, false);
});

test('人物顺序稳定且 recognitionReason 不进入正式档案', async () => {
  const f = await fixture({ ids: ['p2', 'p1'] });
  const archive = await buildInitializedArchiveV2({
    review: createArchiveV2InitializationReview(f.draft),
    sources: f.sources,
    identity: IDENTITY,
    confirmedAt: CONFIRMED_AT,
  });
  assert.deepEqual(archive.people.order, ['p2', 'p1']);
  assert.deepEqual(Object.keys(archive.people.byId), ['p2', 'p1']);
  assert.equal(Object.hasOwn(archive.people.byId.p2, 'recognitionReason'), false);
});

test('保存全部确认来源的最小快照且去除所有运行态字段', async () => {
  const unused = source('未被人物引用，但属于确认边界。', {
    id: 'chat:floor:8:user',
    kind: 'chat',
    locator: 'floor:8:user',
    fingerprint: fingerprint('c'),
    label: '第 8 楼',
    availability: 'chat',
  });
  const f = await fixture({ extraSources: [unused] });
  const archive = await buildInitializedArchiveV2({
    review: createArchiveV2InitializationReview(f.draft),
    sources: f.sources,
    identity: IDENTITY,
    confirmedAt: CONFIRMED_AT,
  });
  assert.equal(archive.initialization.sources.length, 3);
  for (const item of archive.initialization.sources) {
    assert.deepEqual(Object.keys(item), ['kind', 'locator', 'fingerprint', 'content']);
    assert.equal(Object.hasOwn(item, 'selected'), false);
    assert.equal(Object.hasOwn(item, 'availability'), false);
    assert.equal(Object.hasOwn(item, 'id'), false);
  }
});

test('来源指纹、精确引用、选择状态和来源限制失配均拒绝', async () => {
  const f = await fixture();
  const review = createArchiveV2InitializationReview(f.draft);
  const cases = [];
  cases.push({ review, sources: f.sources.map((item, index) => index ? item : { ...item, content: `${item.content}变化` }) });
  const missingRef = structuredClone(review);
  missingRef.people[0].sourceRefs[0].fingerprint = fingerprint('f');
  cases.push({ review: missingRef, sources: f.sources });
  cases.push({ review, sources: f.sources.map((item, index) => index ? { ...item, availability: 'disabled' } : item) });
  cases.push({ review, sources: f.sources.map((item, index) => index ? { ...item, selected: false } : item) });
  cases.push({ review, sources: [source('x'.repeat(24001))] });
  cases.push({ review, sources: Array.from({ length: 6 }, (_, index) => source('x'.repeat(20001), {
    locator: `chat:${index}`,
    fingerprint: `sha256:${index.toString(16).padStart(64, '0')}`,
  })) });
  cases.push({ review, sources: Array.from({ length: 81 }, (_, index) => source('x', {
    locator: `card:${index}`,
    fingerprint: `sha256:${index.toString(16).padStart(64, '0')}`,
  })) });
  for (const value of cases) {
    await assert.rejects(buildInitializedArchiveV2({
      ...value, identity: IDENTITY, confirmedAt: CONFIRMED_AT,
    }), ArchiveV2InitializationReviewError);
  }
});

test('identity 固定键与 confirmedAt 有效 ISO 日期时间严格验证', async () => {
  const f = await fixture();
  const review = createArchiveV2InitializationReview(f.draft);
  const identities = [
    { ...IDENTITY, extra: true },
    { characterLocator: '', personaLocator: 'persona.png', personaSummary: '' },
    { characterLocator: 'char.png', personaLocator: 'persona.png' },
    { ...IDENTITY, personaSummary: 1 },
  ];
  for (const identity of identities) {
    await assert.rejects(buildInitializedArchiveV2({
      review, sources: f.sources, identity, confirmedAt: CONFIRMED_AT,
    }), ArchiveV2InitializationReviewError);
  }
  for (const confirmedAt of ['今天', '2026-02-30T00:00:00Z', '2026-08-31', new Date()]) {
    await assert.rejects(buildInitializedArchiveV2({
      review, sources: f.sources, identity: IDENTITY, confirmedAt,
    }), ArchiveV2InitializationReviewError);
  }
});

test('空人物不能创建审核态或正式档案', async () => {
  const f = await fixture();
  const emptyDraft = { ...f.draft, people: [] };
  assert.throws(() => createArchiveV2InitializationReview(emptyDraft), ArchiveV2InitializationReviewError);
  const review = {
    schemaVersion: 1,
    kind: ARCHIVE_V2_INITIALIZATION_REVIEW_KIND,
    chatId: CHAT,
    sourceFingerprint: f.draft.sourceFingerprint,
    people: [],
  };
  await assert.rejects(buildInitializedArchiveV2({
    review, sources: f.sources, identity: IDENTITY, confirmedAt: CONFIRMED_AT,
  }), ArchiveV2InitializationReviewError);
});

test('特殊 identityId 作为安全自有键，不污染 byId 原型', async () => {
  const f = await fixture({ ids: ['__proto__'] });
  const archive = await buildInitializedArchiveV2({
    review: createArchiveV2InitializationReview(f.draft),
    sources: f.sources,
    identity: IDENTITY,
    confirmedAt: CONFIRMED_AT,
  });
  assert.equal(Object.hasOwn(archive.people.byId, '__proto__'), true);
  assert.equal(archive.people.byId.__proto__.identityId, '__proto__');
  assert.equal(Object.getPrototypeOf(archive.people.byId), Object.prototype);
  assert.equal({}.polluted, undefined);
});

test('输入、审核态、正式档案无引用泄漏且不调用 adapter 或后端', async () => {
  const f = await fixture();
  const review = createArchiveV2InitializationReview(f.draft);
  let writes = 0;
  const archive = await buildInitializedArchiveV2({
    review,
    sources: f.sources,
    identity: IDENTITY,
    confirmedAt: CONFIRMED_AT,
    adapter: { create: () => { writes += 1; }, save: () => { writes += 1; } },
  });
  archive.initialization.sources[0].content = '外部改写';
  archive.people.byId.p1.fields.gender.sourceRefs[0].locator = 'changed';
  archive.people.byId.p1.aliases.value.push('新增');
  assert.equal(f.sources[0].content, '沈砚：成年男性，性格沉静。');
  assert.equal(review.people[0].fields.gender.sourceRefs[0].locator, f.sources[0].locator);
  assert.deepEqual(review.people[0].aliases, ['阿砚']);
  assert.notEqual(archive.people.byId.p1.sourceRefs, archive.people.byId.p1.displayName.sourceRefs);
  assert.notEqual(archive.people.byId.p1.displayName.sourceRefs, archive.people.byId.p1.aliases.sourceRefs);
  assert.equal(writes, 0);
});
