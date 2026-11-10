import { scanAssistantCandidates } from '../src/v3/foundation-domain.js';
import { assessMemoryCoverageFromHost, coverageHostGuardCurrent } from '../src/v3/memory-coverage.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchFloorCandidates } from '../src/v3/floor-binding.js';

const floor = (id, messageIndex, raw, canonical = raw) => ({
  id,
  assistantSeq: messageIndex + 1,
  hostLocator: { messageIndex, swipeId: null, selectedSwipeIndex: null },
  content: { rawFingerprint: raw, canonicalFingerprint: canonical, sanitizerFingerprint: 'sanitizer-old' },
});
const candidate = (messageIndex, raw, canonical = raw, messageAnchor = { status: 'none', anchor: null }) => ({
  assistantSeq: messageIndex + 1,
  messageAnchor,
  hostLocator: { messageIndex, swipeId: null, selectedSwipeIndex: null },
  rawFingerprint: raw,
  canonicalFingerprint: canonical,
  sanitizerFingerprint: 'sanitizer-new',
});

test('共享绑定按 marker、同位置 canonical、移动后唯一指纹依次证明对应', () => {
  const floors = [floor('floor-a', 0, 'raw-a', 'canonical-a'), floor('floor-b', 2, 'raw-b', 'canonical-b')];
  const values = [
    candidate(0, 'raw-a-wrapped', 'canonical-a'),
    candidate(6, 'raw-b', 'canonical-b'),
  ];
  const result = matchFloorCandidates(floors, values);
  assert.equal(result.issue, null);
  assert.deepEqual(result.matches.map(match => [match.floor.id, match.kind]), [
    ['floor-a', 'locatorCanonical'],
    ['floor-b', 'uniqueFingerprint'],
  ]);
  assert.equal(result.matches[0].rawFingerprintMatches, false);
  assert.equal(result.matches[0].canonicalFingerprintMatches, true);
});

test('同位置原文精确一致可跨清洗配置变化，离开原位置仍不得仅凭原文绑定', () => {
  const samePosition = matchFloorCandidates(
    [floor('floor-a', 0, 'raw-a', 'canonical-old')],
    [candidate(0, 'raw-a', 'canonical-new')],
  );
  assert.equal(samePosition.issue, null);
  assert.deepEqual(samePosition.matches.map(match => [match.floor.id, match.kind]), [['floor-a', 'locatorRaw']]);
  assert.equal(samePosition.matches[0].rawFingerprintMatches, true);
  assert.equal(samePosition.matches[0].canonicalFingerprintMatches, false);

  const moved = matchFloorCandidates(
    [floor('floor-a', 0, 'raw-a', 'canonical-old')],
    [candidate(2, 'raw-a', 'canonical-new')],
  );
  assert.deepEqual(moved.unmatchedFloorIndexes, [0]);
  assert.deepEqual(moved.unmatchedCandidateIndexes, [0]);

  const duplicateCandidate = matchFloorCandidates(
    [floor('floor-a', 0, 'raw-a', 'canonical-old')],
    [candidate(0, 'raw-a', 'canonical-new'), candidate(0, 'raw-a', 'canonical-new')],
  );
  assert.equal(duplicateCandidate.matches.length, 1);
  assert.deepEqual(duplicateCandidate.unmatchedCandidateIndexes, [1]);
});

test('valid marker 优先且允许正文变化，外来、冲突及重复 marker 均拒绝', () => {
  const floors = [floor('floor-a', 0, 'raw-a'), floor('floor-b', 2, 'raw-b')];
  const valid = status => ({ status, anchor: status === 'valid' ? { floorId: 'floor-b' } : null });
  const marked = matchFloorCandidates(floors, [candidate(9, 'changed', 'changed', valid('valid'))]);
  assert.deepEqual(marked.matches.map(match => [match.floor.id, match.kind]), [['floor-b', 'marker']]);

  assert.equal(matchFloorCandidates(floors, [candidate(0, 'raw-a', 'raw-a', valid('foreign'))]).issue.code, 'markerRejected');
  assert.equal(matchFloorCandidates(floors, [candidate(0, 'raw-a', 'raw-a', { status: 'valid', anchor: { floorId: 'missing' } })]).issue.code, 'markerConflict');
  assert.equal(matchFloorCandidates(floors, [
    candidate(0, 'one', 'one', valid('valid')),
    candidate(1, 'two', 'two', valid('valid')),
  ]).issue.code, 'duplicateMarker');
});

test('canonical 真异不绑定，重复正文离开原位置后不做歧义猜测', () => {
  const changed = matchFloorCandidates([floor('floor-a', 0, 'raw-a', 'canonical-a')], [candidate(0, 'raw-new', 'canonical-new')]);
  assert.deepEqual(changed.unmatchedFloorIndexes, [0]);
  assert.deepEqual(changed.unmatchedCandidateIndexes, [0]);

  const duplicate = matchFloorCandidates([
    floor('floor-a', 0, 'same', 'same'),
    floor('floor-b', 2, 'same', 'same'),
  ], [candidate(8, 'same', 'same')]);
  assert.equal(duplicate.issue.code, 'ambiguousFingerprint');

  const duplicateCandidates = matchFloorCandidates([floor('floor-a', 0, 'same', 'same')], [
    candidate(8, 'same', 'same'),
    candidate(9, 'same', 'same'),
  ]);
  assert.equal(duplicateCandidates.issue.code, 'ambiguousFingerprint');
});

test('valid marker 会先保留目标 floor，不会被更早的无 marker 候选抢占', () => {
  const floors = [floor('floor-a', 0, 'raw-a'), floor('floor-b', 2, 'raw-b')];
  const result = matchFloorCandidates(floors, [
    candidate(8, 'raw-b', 'raw-b'),
    candidate(2, 'changed', 'changed', { status: 'valid', anchor: { floorId: 'floor-b' } }),
  ]);
  assert.equal(result.issue, null);
  assert.equal(result.candidateMatches.has(0), false);
  assert.equal(result.candidateMatches.get(1).floor.id, 'floor-b');
});

test('后置坏 marker 会保留错误，同时不抹掉前方无 marker 的可靠绑定', () => {
  const result = matchFloorCandidates([floor('floor-a', 0, 'raw-a')], [
    candidate(0, 'raw-a', 'raw-a'),
    candidate(2, 'tail', 'tail', { status: 'foreign', anchor: { floorId: 'foreign-floor' } }),
  ]);
  assert.equal(result.issue.code, 'markerRejected');
  assert.equal(result.issue.candidateIndex, 1);
  assert.equal(result.candidateMatches.get(0).floor.id, 'floor-a');
  assert.equal(result.candidateMatches.get(0).kind, 'locatorCanonical');
});

test('局部绑定收集全部错误，重复楼标双方隔离且独立健康楼继续匹配', () => {
  const marker = id => ({ status: 'valid', anchor: { floorId: id } });
  const result = matchFloorCandidates([floor('a', 0, 'a'), floor('b', 2, 'b'), floor('c', 4, 'c')], [
    candidate(0, 'a', 'a', marker('a')), candidate(2, 'b', 'b', marker('a')),
    candidate(4, 'c', 'c', marker('c')), candidate(6, 'foreign', 'foreign', { status: 'foreign', anchor: { floorId: 'outside' } }),
  ]);
  assert.deepEqual(result.matches.map(match => match.floor.id), ['c']);
  assert.deepEqual(result.unmatchedFloorIndexes, [0, 1]);
  assert.deepEqual(result.issues.map(issue => issue.code), ['duplicateMarker', 'markerRejected']);
  assert.equal(result.issue.code, 'duplicateMarker');
});

test('局部外来当前楼不能夺走已验证归档来源的绑定', () => {
  const archived = { ...candidate(0, 'old'), archiveCandidate: true, archiveFloorId: 'a' };
  const claimant = candidate(5, 'new', 'new', { status: 'valid', anchor: { floorId: 'a' } });
  const result = matchFloorCandidates([floor('a', 0, 'old')], [archived, claimant]);
  assert.equal(result.issue.code, 'duplicateMarker');
  assert.deepEqual(result.matches.map(match => match.kind), ['archive']);
  assert.deepEqual(result.unmatchedCandidateIndexes, [1]);
});


test('局部来源guard只核健康证明，旁支后来重复声明健康楼仍使guard失效', async () => {
  const chatId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const chat = ids.map((id, index) => ({ is_user: false, is_system: false, mes: `正文${index}`, extra: {
    qianqianjie_floor: { schemaVersion: 1, chatId, floorId: id } } }));
  const candidates = await scanAssistantCandidates(chat, { chatId });
  const floors = candidates.map((candidate, index) => ({ id: ids[index], assistantSeq: index + 1,
    hostLocator: candidate.hostLocator, content: candidate }));
  chat[1].extra.qianqianjie_floor.chatId = other;
  const snapshot = { chat, context: { chatMetadata: { qianqianjie: { chatId } } } };
  const readiness = await assessMemoryCoverageFromHost({ reachable: { root: { chatId }, floors, floorMemories: [], stateDeltas: [] },
    snapshot, captureGuard: true });
  assert.equal(coverageHostGuardCurrent(readiness, snapshot), true);
  chat[1].extra.qianqianjie_floor = { schemaVersion: 1, chatId, floorId: ids[0] };
  assert.equal(coverageHostGuardCurrent(readiness, snapshot), false);
});
