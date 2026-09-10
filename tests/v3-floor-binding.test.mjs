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
