import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCHIVE_V2_CANDIDATE_REVIEW_KIND,
  ARCHIVE_V2_CANDIDATE_REVIEW_SCHEMA_VERSION,
  ARCHIVE_V2_SELECTED_PEOPLE_PLAN_KIND,
  ArchiveV2CandidateReviewError,
  buildArchiveV2SelectedPeoplePlan,
  createArchiveV2CandidateReview,
  mergeArchiveV2Candidates,
  removeArchiveV2Candidate,
  renameArchiveV2Candidate,
  setArchiveV2CandidateAliases,
  setArchiveV2CandidateSelected,
} from '../src/archive-v2-candidate-review.js';

const CHAT = '11111111-1111-4111-8111-111111111111';
const SOURCE_FP = `sha256:${'f'.repeat(64)}`;
const ref = (locator, fingerprint = `sha256:${'a'.repeat(64)}`) => ({ kind: 'card', locator, fingerprint });
const candidate = (candidateId, displayName, overrides = {}) => ({
  candidateId,
  displayName,
  aliases: [],
  reason: `${displayName} 的识别依据。`,
  sourceRefs: [ref(`card:${candidateId}`)],
  ...overrides,
});
const draft = (candidates = [candidate('c1', '沈砚'), candidate('c2', '阿福')], overrides = {}) => ({
  schemaVersion: 1,
  kind: 'myriad-knots-candidate-draft',
  chatId: CHAT,
  sourceFingerprint: SOURCE_FP,
  candidates,
  ...overrides,
});

test('合法草稿创建默认全未选的深拷贝整理态', () => {
  const input = draft([candidate('c1', '沈砚', { aliases: ['阿砚'] })]);
  const review = createArchiveV2CandidateReview(input);
  assert.deepEqual(review, {
    schemaVersion: ARCHIVE_V2_CANDIDATE_REVIEW_SCHEMA_VERSION,
    kind: ARCHIVE_V2_CANDIDATE_REVIEW_KIND,
    chatId: CHAT,
    sourceFingerprint: SOURCE_FP,
    candidates: [{ ...candidate('c1', '沈砚', { aliases: ['阿砚'] }), selected: false }],
  });
  review.candidates[0].aliases.push('外部修改');
  review.candidates[0].sourceRefs[0].locator = 'changed';
  assert.deepEqual(input.candidates[0].aliases, ['阿砚']);
  assert.equal(input.candidates[0].sourceRefs[0].locator, 'card:c1');
});

test('schema、kind、身份、字段、来源字段和重复 ID 被严格拒绝', () => {
  const invalid = [
    draft([], { schemaVersion: 2 }),
    draft([], { kind: 'wrong' }),
    draft([], { chatId: '' }),
    draft([], { sourceFingerprint: 'wrong' }),
    { ...draft([]), loading: true },
    draft([{ ...candidate('c1', '甲'), content: '正文' }]),
    draft([{ ...candidate('c1', '甲'), selected: false }]),
    draft([{ ...candidate('c1', '甲'), sourceRefs: [{ ...ref('x'), content: '正文' }] }]),
    draft([{ ...candidate('c1', '甲'), sourceRefs: [{ ...ref('x'), status: 'ready' }] }]),
    draft([candidate('same', '甲'), candidate('same', '乙')]),
    draft([candidate('x'.repeat(201), '甲')]),
  ];
  for (const value of invalid) {
    assert.throws(() => createArchiveV2CandidateReview(value), ArchiveV2CandidateReviewError);
  }
});

test('选择与取消选择均返回新对象且不改变输入', () => {
  const review = createArchiveV2CandidateReview(draft());
  const before = structuredClone(review);
  const selected = setArchiveV2CandidateSelected(review, 'c1', true);
  const cancelled = setArchiveV2CandidateSelected(selected, 'c1', false);
  assert.equal(selected.candidates[0].selected, true);
  assert.equal(cancelled.candidates[0].selected, false);
  assert.deepEqual(review, before);
  assert.notEqual(selected, review);
  assert.notEqual(cancelled, selected);
  assert.throws(() => setArchiveV2CandidateSelected(review, 'missing', true), ArchiveV2CandidateReviewError);
});

test('改名只改变显示名，旧名不自动成为别名；空名和超长原始名拒绝', () => {
  const review = createArchiveV2CandidateReview(draft([
    candidate('c1', '旧名', { aliases: ['已有别名'] }),
  ]));
  const renamed = renameArchiveV2Candidate(review, 'c1', '  新名  ');
  assert.equal(renamed.candidates[0].displayName, '新名');
  assert.deepEqual(renamed.candidates[0].aliases, ['已有别名']);
  assert.equal(renamed.candidates[0].aliases.includes('旧名'), false);
  assert.equal(review.candidates[0].displayName, '旧名');
  for (const name of ['', '   ', '人'.repeat(121), `${' '.repeat(1000)}人`]) {
    assert.throws(() => renameArchiveV2Candidate(review, 'c1', name), ArchiveV2CandidateReviewError);
  }
});

test('别名清理、NFKC 去重、排除显示名，并执行数量和原始长度上限', () => {
  const review = createArchiveV2CandidateReview(draft([candidate('c1', '沈砚')]));
  const updated = setArchiveV2CandidateAliases(review, 'c1', [' 阿砚 ', 'Ａ', 'a', ' A ', '沈砚', '沉砚']);
  assert.deepEqual(updated.candidates[0].aliases, ['阿砚', 'Ａ', '沉砚']);
  assert.deepEqual(review.candidates[0].aliases, []);
  assert.throws(
    () => setArchiveV2CandidateAliases(review, 'c1', Array.from({ length: 13 }, (_, index) => `别名${index}`)),
    ArchiveV2CandidateReviewError,
  );
  assert.throws(
    () => setArchiveV2CandidateAliases(review, 'c1', [`${' '.repeat(1000)}别名`]),
    ArchiveV2CandidateReviewError,
  );
});

test('显式合并保留目标 ID/位置/显示名/reason，合并选择、别名和去重引用', () => {
  const shared = ref('shared');
  let review = createArchiveV2CandidateReview(draft([
    candidate('target', '目标', { aliases: ['主角'], reason: '目标依据', sourceRefs: [shared] }),
    candidate('source-a', '旧名甲', { aliases: ['甲', '主角'], sourceRefs: [shared, ref('a', `sha256:${'b'.repeat(64)}`)] }),
    candidate('source-b', '旧名乙', { aliases: ['乙', '目标'], sourceRefs: [ref('b', `sha256:${'c'.repeat(64)}`)] }),
    candidate('other', '其他'),
  ]));
  review = setArchiveV2CandidateSelected(review, 'source-a', true);
  const merged = mergeArchiveV2Candidates(review, { targetId: 'target', sourceIds: ['source-a', 'source-b'] });
  assert.deepEqual(merged.candidates.map(item => item.candidateId), ['target', 'other']);
  const target = merged.candidates[0];
  assert.equal(target.candidateId, 'target');
  assert.equal(target.displayName, '目标');
  assert.equal(target.reason, '目标依据');
  assert.equal(target.selected, true);
  assert.deepEqual(target.aliases, ['主角', '旧名甲', '甲', '旧名乙', '乙']);
  assert.deepEqual(target.sourceRefs.map(item => item.locator), ['shared', 'a', 'b']);
  assert.equal(Object.hasOwn(target, 'mergedFrom'), false);
  assert.equal(review.candidates.length, 4);
});

test('自合并、重复/缺失来源、缺失目标和空来源均拒绝且输入不变', () => {
  const review = createArchiveV2CandidateReview(draft());
  const before = structuredClone(review);
  const invalid = [
    { targetId: 'c1', sourceIds: [] },
    { targetId: 'c1', sourceIds: ['c1'] },
    { targetId: 'c1', sourceIds: ['c2', 'c2'] },
    { targetId: 'c1', sourceIds: ['missing'] },
    { targetId: 'missing', sourceIds: ['c2'] },
  ];
  for (const options of invalid) {
    assert.throws(() => mergeArchiveV2Candidates(review, options), ArchiveV2CandidateReviewError);
    assert.deepEqual(review, before);
  }
});

test('删除候选保持其余顺序，缺失 ID 抛出可识别错误', () => {
  const review = createArchiveV2CandidateReview(draft([
    candidate('c1', '甲'), candidate('c2', '乙'), candidate('c3', '丙'),
  ]));
  const removed = removeArchiveV2Candidate(review, 'c2');
  assert.deepEqual(removed.candidates.map(item => item.candidateId), ['c1', 'c3']);
  assert.deepEqual(review.candidates.map(item => item.candidateId), ['c1', 'c2', 'c3']);
  assert.throws(() => removeArchiveV2Candidate(review, 'missing'), error => (
    error instanceof ArchiveV2CandidateReviewError
    && error.code === 'ARCHIVE_V2_CANDIDATE_REVIEW_NOT_FOUND'
  ));
});

test('已选清单只按原序输出已选项，identityId 直接等于 candidateId 且无正文', () => {
  let review = createArchiveV2CandidateReview(draft([
    candidate('c1', '甲'), candidate('c2', '乙'), candidate('c3', '丙'),
  ]));
  review = setArchiveV2CandidateSelected(review, 'c3', true);
  review = setArchiveV2CandidateSelected(review, 'c1', true);
  const plan = buildArchiveV2SelectedPeoplePlan(review);
  assert.equal(plan.kind, ARCHIVE_V2_SELECTED_PEOPLE_PLAN_KIND);
  assert.deepEqual(plan.people.map(item => [item.identityId, item.displayName]), [['c1', '甲'], ['c3', '丙']]);
  assert.equal(JSON.stringify(plan).includes('识别依据。'), true);
  assert.equal(JSON.stringify(plan).includes('content'), false);
  assert.ok(plan.people.every(item => !Object.hasOwn(item, 'selected')));
  assert.equal(review.candidates[1].selected, false);
});

test('同名候选在用户显式合并前保持共存', () => {
  const review = createArchiveV2CandidateReview(draft([
    candidate('same-a', '同名'), candidate('same-b', '同名'),
  ]));
  assert.equal(review.candidates.length, 2);
  assert.deepEqual(review.candidates.map(item => item.candidateId), ['same-a', 'same-b']);
});

test('空选择输出合法空清单且无副作用', () => {
  const review = createArchiveV2CandidateReview(draft());
  const before = structuredClone(review);
  const plan = buildArchiveV2SelectedPeoplePlan(review);
  assert.deepEqual(plan, {
    schemaVersion: 1,
    kind: ARCHIVE_V2_SELECTED_PEOPLE_PLAN_KIND,
    chatId: CHAT,
    sourceFingerprint: SOURCE_FP,
    people: [],
  });
  assert.deepEqual(review, before);
});

test('纯内存操作不调用 AI、后端或宿主', () => {
  const calls = { ai: 0, backend: 0, host: 0 };
  const dependencies = {
    generateTask: () => { calls.ai += 1; },
    put: () => { calls.backend += 1; },
    saveMetadata: () => { calls.host += 1; },
  };
  let review = createArchiveV2CandidateReview(draft());
  review = setArchiveV2CandidateSelected(review, 'c1', true);
  review = renameArchiveV2Candidate(review, 'c1', '新名');
  review = setArchiveV2CandidateAliases(review, 'c1', ['别名']);
  buildArchiveV2SelectedPeoplePlan(review);
  assert.deepEqual(calls, { ai: 0, backend: 0, host: 0 });
  assert.equal(typeof dependencies.generateTask, 'function');
});

test('连续操作与输出之间不存在可变引用泄漏', () => {
  const first = createArchiveV2CandidateReview(draft([candidate('c1', '甲', { aliases: ['别名'] })]));
  const second = setArchiveV2CandidateSelected(first, 'c1', true);
  const plan = buildArchiveV2SelectedPeoplePlan(second);
  second.candidates[0].aliases.push('第二态修改');
  second.candidates[0].sourceRefs[0].locator = 'second-changed';
  plan.people[0].aliases.push('清单修改');
  plan.people[0].sourceRefs[0].locator = 'plan-changed';
  assert.deepEqual(first.candidates[0].aliases, ['别名']);
  assert.equal(first.candidates[0].sourceRefs[0].locator, 'card:c1');
  assert.deepEqual(plan.people[0].aliases, ['别名', '清单修改']);
  assert.equal(second.candidates[0].sourceRefs[0].locator, 'second-changed');
});
