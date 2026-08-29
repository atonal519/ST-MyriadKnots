import test from 'node:test';
import assert from 'node:assert/strict';
import { createPendingReviewAdapter, pendingReviewDigest } from '../src/pending-review.js';

const CHAT = '123e4567-e89b-42d3-a456-426614174000';
const CARD = '223e4567-e89b-42d3-a456-426614174001';
const USER = '323e4567-e89b-42d3-a456-426614174002';
const CHARACTER = '423e4567-e89b-42d3-a456-426614174003';
const OPERATION = '523e4567-e89b-42d3-a456-426614174004';
const GENERATION = '623e4567-e89b-42d3-a456-426614174005';
const DATE = '2026-08-29T00:00:00.000Z';
const collection = `chat-${CHAT}`;
const profiles = `chat-${CHAT}-people`;
const key = (name, id) => `${name}/${id}`;
const envelope = (data, revision = 1) => ({ schemaVersion: 1, revision, generationId: GENERATION, createdAt: DATE, updatedAt: DATE, data: structuredClone(data) });
const httpError = status => Object.assign(new Error(String(status)), { status });
const item = (overrides = {}) => ({
  id: `qqj-initial-v1:${'a'.repeat(64)}`, value: '林岚可能把守约视为关系底线', confidence: 0.72,
  sourceRefs: [{ kind: 'chat', locator: 'chat:floor-2', fingerprint: `sha256:${'b'.repeat(64)}`, anchor: '林岚回头' }],
  proposedLayer: 'interpretations', reason: '需要确认这是否属于长期稳定倾向', writerId: 'qianqianjie.initial-relation.v1',
  operationId: OPERATION, baselineDigest: `sha256:${'c'.repeat(64)}`, provenance: 'ai', state: 'pending_review', ...overrides,
});

function makeHarness({ subject = 'character', pending = item(), putHook } = {}) {
  const identityId = subject === 'user' ? USER : CHARACTER;
  const ctx = { characterId: 0, groupId: null, chatId: 'host-chat', characters: [{ avatar: 'char.png' }], userAvatar: 'me.png', chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT } } };
  const records = new Map([
    [key(collection, 'meta'), envelope({ schemaVersion: 1, kind: 'chat-profile', chatId: CHAT, cardId: CARD, personaId: USER, source: { card: { locator: 'char.png' }, persona: { locator: 'me.png' } }, status: 'ready' })],
    [key(collection, 'people-index'), envelope({ schemaVersion: 1, kind: 'people-index', chatId: CHAT, contractVersion: 3, confirmed: [{ identityId: CHARACTER, displayName: '林岚', selection: { status: 'selected' } }] })],
    [key(collection, 'people-state'), envelope({ schemaVersion: 1, kind: 'people-foundation-state', chatId: CHAT, cardId: CARD, personaId: USER, contractVersion: 1, source: { card: { locator: 'char.png' }, persona: { locator: 'me.png' } }, status: 'ready', activeMemberIds: [USER, CHARACTER], initializedMembers: [{ identityId: USER, subject: 'user', active: true }, { identityId: CHARACTER, subject: 'character', active: true }] })],
    [key(profiles, identityId), envelope({ schemaVersion: 1, peopleContractVersion: 1, kind: 'people-profile', chatId: CHAT, identityId, subject, displayName: subject === 'user' ? '旅人' : '林岚', sourceBinding: subject === 'user' ? { kind: 'persona', identityId: USER, locator: 'me.png' } : { kind: 'c-registry', identityId: CHARACTER }, sourceFacts: [{ id: 'source-existing', value: '旧事实' }], userFacts: [{ id: 'user-owned', value: '用户内容' }], interpretations: [{ id: 'ai-existing', value: '旧归纳' }], locks: [{ id: 'lock' }], pendingReview: [pending], futureExtension: { keep: true } })],
  ]);
  const calls = [];
  const client = {
    async get(name, id) { calls.push(['get', name, id]); const value = records.get(key(name, id)); if (!value) throw httpError(404); return structuredClone(value); },
    async put(name, id, data, revision) {
      calls.push(['put', name, id, structuredClone(data), revision]);
      if (putHook) return putHook({ name, id, data, revision, records, ctx });
      const current = records.get(key(name, id)); if (current?.revision !== revision) throw httpError(409);
      const next = envelope(data, revision + 1); records.set(key(name, id), next); return structuredClone(next);
    },
  };
  const adapter = createPendingReviewAdapter({ client, contextProvider: () => ctx });
  return { adapter, calls, records, ctx, identityId, pending };
}

const puts = harness => harness.calls.filter(call => call[0] === 'put');

test('accept 单次 CAS 精确移入目标层并保留其他层、锁与未知扩展', async () => {
  const h = makeHarness();
  const expectedItemDigest = await pendingReviewDigest(h.pending);
  const result = await h.adapter.resolvePendingReview({ identityId: h.identityId, pendingItemId: h.pending.id, decision: 'accept', expectedItemDigest });
  assert.equal(result.status, 'ready'); assert.equal(puts(h).length, 1); assert.equal(puts(h)[0][4], 1);
  const saved = h.records.get(key(profiles, h.identityId)).data;
  assert.equal(saved.pendingReview.length, 0); assert.equal(saved.interpretations.length, 2);
  const accepted = saved.interpretations.at(-1);
  assert.equal(accepted.id, h.pending.id); assert.equal(accepted.state, 'canon'); assert.equal(accepted.provenance, 'ai');
  assert.equal(accepted.proposedLayer, undefined); assert.equal(accepted.reason, undefined); assert.equal(accepted.writerId, h.pending.writerId);
  assert.equal(accepted.operationId, OPERATION); assert.equal(accepted.baselineDigest, h.pending.baselineDigest);
  assert.deepEqual(saved.userFacts, [{ id: 'user-owned', value: '用户内容' }]); assert.deepEqual(saved.locks, [{ id: 'lock' }]); assert.deepEqual(saved.futureExtension, { keep: true });
});

test('reject 单次 CAS 只移除目标 pending，不改变其他层', async () => {
  const h = makeHarness(); const before = structuredClone(h.records.get(key(profiles, h.identityId)).data);
  const result = await h.adapter.resolvePendingReview({ identityId: h.identityId, pendingItemId: h.pending.id, decision: 'reject', expectedItemDigest: await pendingReviewDigest(h.pending) });
  assert.equal(result.status, 'ready'); assert.equal(puts(h).length, 1);
  const saved = h.records.get(key(profiles, h.identityId)).data; assert.deepEqual(saved.pendingReview, []);
  for (const layer of ['sourceFacts', 'userFacts', 'interpretations', 'locks']) assert.deepEqual(saved[layer], before[layer]);
  assert.deepEqual(saved.futureExtension, before.futureExtension);
});

test('轻量首次生成 pending 无 confidence/anchor 时 accept 与 reject 均正常', async () => {
  const lightweight = item({ confidence: undefined, sourceRefs: [{ kind: 'chat', locator: 'chat:floor-2', fingerprint: `sha256:${'b'.repeat(64)}` }] });
  delete lightweight.confidence;
  const accepted = makeHarness({ pending: lightweight });
  assert.equal((await accepted.adapter.resolvePendingReview({ identityId: accepted.identityId, pendingItemId: lightweight.id, decision: 'accept', expectedItemDigest: await pendingReviewDigest(lightweight) })).status, 'ready');
  const saved = accepted.records.get(key(profiles, accepted.identityId)).data.interpretations.at(-1);
  assert.equal(saved.confidence, undefined); assert.equal(saved.sourceRefs[0].anchor, undefined);
  const rejected = makeHarness({ pending: lightweight });
  assert.equal((await rejected.adapter.resolvePendingReview({ identityId: rejected.identityId, pendingItemId: lightweight.id, decision: 'reject', expectedItemDigest: await pendingReviewDigest(lightweight) })).status, 'ready');
  assert.deepEqual(rejected.records.get(key(profiles, rejected.identityId)).data.pendingReview, []);
});

test('U 与 active C 可处理；未知/非 active、错 digest、foreign writer、未知层、重复 ID、错绑、未来 schema 均零 PUT', async t => {
  const user = makeHarness({ subject: 'user' });
  assert.equal((await user.adapter.resolvePendingReview({ identityId: USER, pendingItemId: user.pending.id, decision: 'accept', expectedItemDigest: await pendingReviewDigest(user.pending) })).status, 'ready');
  const cases = {
    unknown(h) { h.identityId = '723e4567-e89b-42d3-a456-426614174006'; },
    inactive(h) { const state = h.records.get(key(collection, 'people-state')).data; state.activeMemberIds = [USER]; state.initializedMembers[1].active = false; },
    digest(_h, args) { args.expectedItemDigest = `sha256:${'f'.repeat(64)}`; },
    writer(h) { h.records.get(key(profiles, h.identityId)).data.pendingReview[0].writerId = 'foreign.writer'; },
    layer(h) { h.records.get(key(profiles, h.identityId)).data.pendingReview[0].proposedLayer = 'userFacts'; },
    duplicate(h) { const profile = h.records.get(key(profiles, h.identityId)).data; profile.pendingReview.push(structuredClone(profile.pendingReview[0])); },
    binding(h) { h.records.get(key(profiles, h.identityId)).data.sourceBinding.identityId = USER; },
    future(h) { h.records.get(key(profiles, h.identityId)).data.peopleContractVersion = 2; },
    future_generation(h) { h.records.get(key(collection, 'people-state')).data.initialGeneration = { schemaVersion: 2, status: 'ready' }; },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
    const h = makeHarness(); const args = { identityId: h.identityId, pendingItemId: h.pending.id, decision: 'accept', expectedItemDigest: await pendingReviewDigest(h.pending) };
    mutate(h, args); args.identityId = h.identityId;
    const result = await h.adapter.resolvePendingReview(args);
    assert.equal(['mismatch', 'conflict', 'future_schema_readonly'].includes(result.status), true, result.status); assert.equal(puts(h).length, 0);
  });
});

test('CAS 409 后 accept 仅同成品可接受；异值与 reject 不确定均返回 conflict', async () => {
  const accepted = makeHarness({ putHook: ({ name, id, data, revision, records }) => { records.set(key(name, id), envelope(data, revision + 1)); throw httpError(409); } });
  const acceptedResult = await accepted.adapter.resolvePendingReview({ identityId: accepted.identityId, pendingItemId: accepted.pending.id, decision: 'accept', expectedItemDigest: await pendingReviewDigest(accepted.pending) });
  assert.equal(acceptedResult.status, 'ready'); assert.equal(acceptedResult.recovered, true);
  const divergent = makeHarness({ putHook: () => { throw httpError(409); } });
  assert.equal((await divergent.adapter.resolvePendingReview({ identityId: divergent.identityId, pendingItemId: divergent.pending.id, decision: 'accept', expectedItemDigest: await pendingReviewDigest(divergent.pending) })).status, 'conflict');
  const crossLayer = makeHarness({ putHook: ({ name, id, data, revision, records }) => {
    const duplicate = structuredClone(data.interpretations.find(candidate => candidate.id === item().id));
    const winner = { ...structuredClone(data), sourceFacts: [...data.sourceFacts, duplicate] };
    records.set(key(name, id), envelope(winner, revision + 1)); throw httpError(409);
  } });
  assert.equal((await crossLayer.adapter.resolvePendingReview({ identityId: crossLayer.identityId, pendingItemId: crossLayer.pending.id, decision: 'accept', expectedItemDigest: await pendingReviewDigest(crossLayer.pending) })).status, 'conflict');
  const duplicateTarget = makeHarness({ putHook: ({ name, id, data, revision, records }) => {
    const accepted = structuredClone(data.interpretations.find(candidate => candidate.id === item().id));
    const winner = { ...structuredClone(data), interpretations: [...data.interpretations, { ...accepted, value: '并发异值' }] };
    records.set(key(name, id), envelope(winner, revision + 1)); throw httpError(409);
  } });
  assert.equal((await duplicateTarget.adapter.resolvePendingReview({ identityId: duplicateTarget.identityId, pendingItemId: duplicateTarget.pending.id, decision: 'accept', expectedItemDigest: await pendingReviewDigest(duplicateTarget.pending) })).status, 'conflict');
  const rejected = makeHarness({ putHook: ({ name, id, data, revision, records }) => { records.set(key(name, id), envelope(data, revision + 1)); throw new Error('response lost'); } });
  assert.equal((await rejected.adapter.resolvePendingReview({ identityId: rejected.identityId, pendingItemId: rejected.pending.id, decision: 'reject', expectedItemDigest: await pendingReviewDigest(rejected.pending) })).status, 'conflict');
});

test('PUT 在途切 Persona 时旧档可完成 CAS，但返回 stale，不能给新页面显示成功', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = makeHarness({ putHook: async ({ name, id, data, revision, records }) => { await gate; const next = envelope(data, revision + 1); records.set(key(name, id), next); return structuredClone(next); } });
  const pending = h.adapter.resolvePendingReview({ identityId: h.identityId, pendingItemId: h.pending.id, decision: 'accept', expectedItemDigest: await pendingReviewDigest(h.pending) });
  while (puts(h).length === 0) await new Promise(resolve => setImmediate(resolve));
  h.ctx.userAvatar = 'other.png'; release();
  assert.equal((await pending).status, 'stale');
});
