import { filterReachableDeltas } from './cse-engine.js';
import { memorySourceFloorIds } from './memory-schema.js';
import { isHostNarratorMessage, scanAssistantCandidates, selectAssistantMessage } from './foundation-domain.js';
import { inspectMessageFloorAnchor } from './message-floor-anchor.js';
import { matchFloorCandidates } from './floor-binding.js';
import { migrationPartition, partitionScannedCandidates } from './migration-prefix.js';
import { isMemoryExcludedFloor, isMemoryExcludedMessage } from './memory-exclusion.js';

export const RECENT_VISIBLE_AI_FLOORS = 3;
const HOST_GUARD = Symbol('qqjCoverageHostGuard');
const HOST_BINDINGS = Symbol('qqjCoverageHostBindings');

export const memoryCoverageHostBindings = readiness => readiness?.[HOST_BINDINGS] ?? null;

const currentChatId = snapshot => String(snapshot?.context?.chatMetadata?.qianqianjie?.chatId ?? '').trim();
const visibleAssistant = message => message
  && message.is_user === false
  && !isHostNarratorMessage(message)
  && message.is_system !== true
  && message.is_hidden !== true
  && message.hidden !== true
  && typeof message.mes === 'string'
  && Boolean(message.mes.trim());

export function realtimeOriginFromReachable(reachable) {
  const root = reachable?.root;
  const marker = reachable?.run?.diagnostics?.realtimeOriginV1;
  if (!root || reachable?.run?.mode === 'branchReplay' || !marker || typeof marker !== 'object' || Array.isArray(marker)) return null;
  if (marker.chatId !== root.chatId
    || marker.narrativeGeneration !== root.narrativeGeneration
    || marker.sourceSnapshotFingerprint !== root.sourceSnapshotFingerprint) return null;
  return Object.freeze({
    chatId: marker.chatId,
    narrativeGeneration: marker.narrativeGeneration,
    sourceSnapshotFingerprint: marker.sourceSnapshotFingerprint,
  });
}

export function diagnosticsWithRealtimeOrigin(diagnostics, realtimeOrigin = null) {
  const next = diagnostics && typeof diagnostics === 'object' && !Array.isArray(diagnostics)
    ? structuredClone(diagnostics)
    : {};
  delete next.realtimeOriginV1;
  if (realtimeOrigin) next.realtimeOriginV1 = { ...realtimeOrigin };
  return next;
}

function captureHostGuard(snapshot, hostCandidates, hostProof = null) {
  const expectedFloorByCandidate = new Map();
  for (const [floorId, candidate] of hostProof?.candidateByFloorId ?? []) expectedFloorByCandidate.set(candidate, floorId);
  return Object.freeze({
    chatId: currentChatId(snapshot),
    candidates: Object.freeze(hostCandidates.filter(candidate => candidate.archiveCandidate !== true).map(candidate => Object.freeze({
      messageIndex: candidate.hostLocator.messageIndex,
      swipeId: candidate.hostLocator.swipeId,
      selectedSwipeIndex: candidate.hostLocator.selectedSwipeIndex,
      rawContent: candidate.rawContent,
      rawFingerprint: candidate.rawFingerprint,
      floorId: candidate.messageAnchor?.status === 'valid' ? candidate.messageAnchor.anchor.floorId : null,
      expectedFloorId: expectedFloorByCandidate.get(candidate) ?? null,
      anchorStatus: candidate.messageAnchor?.status ?? 'invalid',
      memoryExcluded: candidate.memoryExcluded === true,
      visible: visibleAssistant(snapshot.chat?.[candidate.hostLocator.messageIndex]),
    }))),
  });
}

export function coverageHostGuardCurrent(readiness, snapshot) {
  const guard = readiness?.[HOST_GUARD];
  if (!guard || guard.chatId !== currentChatId(snapshot) || !Array.isArray(guard.candidates) || !Array.isArray(snapshot?.chat)) return false;
  const currentFloorIds = new Set();
  return guard.candidates.every(expected => {
    const current = snapshot.chat[expected.messageIndex];
    const selected = selectAssistantMessage(current);
    const anchor = inspectMessageFloorAnchor(current, guard.chatId);
    if (!selected || selected.swipeId !== expected.swipeId || selected.selectedSwipeIndex !== expected.selectedSwipeIndex
      || visibleAssistant(current) !== expected.visible || isMemoryExcludedMessage(current) !== expected.memoryExcluded
      || !['none', 'valid'].includes(anchor.status)) return false;
    if (anchor.status === 'valid') {
      if (currentFloorIds.has(anchor.anchor.floorId)) return false;
      currentFloorIds.add(anchor.anchor.floorId);
    }
    if (expected.anchorStatus === 'valid') return anchor.status === 'valid' && anchor.anchor.floorId === expected.floorId;
    if (selected.rawContent !== expected.rawContent) return false;
    if (expected.expectedFloorId) return anchor.status === 'none' || anchor.anchor.floorId === expected.expectedFloorId;
    if (expected.visible) return true;
    return anchor.status === 'none';
  });
}

function activeMemoriesByFloor(reachable) {
  const groups = new Map();
  for (const memory of reachable?.floorMemories ?? []) {
    if (memory?.recordStatus !== 'active') continue;
    for (const floorId of memorySourceFloorIds(memory)) groups.set(floorId, [...(groups.get(floorId) ?? []), memory]);
  }
  return new Map([...groups].filter(([, values]) => values.length === 1).map(([floorId, values]) => [floorId, values[0]]));
}

function hostCoverageProof(reachable, snapshot, hostCandidates) {
  if (!reachable?.root?.chatId || currentChatId(snapshot) !== reachable.root.chatId || !Array.isArray(hostCandidates)) return null;
  const bindings = matchFloorCandidates(reachable.floors ?? [], hostCandidates);
  // A conflicting claim invalidates its floor, not independent successful matches.
  const claims = new Map();
  for (const candidate of hostCandidates) {
    const floorId = candidate.archiveCandidate ? candidate.archiveFloorId
      : candidate.messageAnchor?.status === 'valid' ? candidate.messageAnchor.anchor.floorId : null;
    if (floorId) claims.set(floorId, (claims.get(floorId) ?? 0) + 1);
  }
  const matches = bindings.matches.filter(match => (claims.get(match.floor.id) ?? 0) <= 1);
  const matchedCandidates = new Set(matches.map(match => match.candidate));
  const candidateByFloorId = new Map();
  for (const match of matches) candidateByFloorId.set(match.floor.id, match.candidate);
  const liveCandidates = hostCandidates.filter(candidate => candidate.archiveCandidate !== true);
  const lastMatchedIndex = Math.max(-1, ...[...matchedCandidates].filter(candidate => candidate.archiveCandidate !== true).map(candidate => candidate.hostLocator.messageIndex));
  const unmatchedFloorIds = Object.freeze((reachable.floors ?? []).filter(floor => !candidateByFloorId.has(floor.id)).map(floor => floor.id));
  // Partial correspondence is a read concern, not a new extraction queue.
  const unregistered = unmatchedFloorIds.length ? [] : liveCandidates.filter(candidate => !matchedCandidates.has(candidate) && candidate.memoryExcluded !== true
    && candidate.messageAnchor?.status === 'none' && candidate.hostLocator.messageIndex > lastMatchedIndex);
  return Object.freeze({ unregistered: Object.freeze(unregistered), candidateByFloorId, unmatchedFloorIds });
}

export function assessMemoryCoverage({ reachable, snapshot, hostCandidates, realtimeOrigin = false } = {}) {
  const hostProof = reachable?.root && Array.isArray(reachable.floors) ? hostCoverageProof(reachable, snapshot, hostCandidates) : null;
  const partition = migrationPartition(reachable);
  const floors = partition.liveFloors.filter(floor => (!hostProof || hostProof.candidateByFloorId.has(floor.id)) && hostProof?.candidateByFloorId.get(floor.id)?.canonicalContent !== '' && !isMemoryExcludedFloor(
    hostProof?.candidateByFloorId.has(floor.id) ? { ...floor, hostLocator: hostProof.candidateByFloorId.get(floor.id).hostLocator } : floor,
    snapshot?.chat, reachable?.checkpoint, {
    frozen: partition.isFrozenFloor(floor.id),
  }));
  if (!hostProof) {
    return Object.freeze({ status: 'unknown', completed: 0, total: floors.length, nextAssistantSeq: null, pendingFloorIds: Object.freeze([]), realtimeProtected: false, hasPartialWork: false, summaryStatus: 'unknown', summaryCompleted: 0, summaryNextAssistantSeq: null, summaryPendingFloorIds: Object.freeze([]), summaryMissingFloorIds: Object.freeze([]), visibleSummaryFloorIds: Object.freeze([]), summaryRealtimeProtected: false, summaryHasPartialWork: false });
  }
  const nextAssistantSeq = (reachable.floors.at(-1)?.assistantSeq ?? 0) + 1;
  const unregisteredSummaryRefs = Object.freeze(hostProof.unregistered.map((candidate, offset) => Object.freeze({
    floorId: `host-tail:${candidate.hostLocator.messageIndex}:${candidate.rawFingerprint}`,
    floorMemoryId: null,
    assistantSeq: candidate.assistantSeq ?? nextAssistantSeq + offset,
    hostLocator: Object.freeze({ ...candidate.hostLocator }),
    rawFingerprint: candidate.rawFingerprint,
    canonicalFingerprint: candidate.canonicalFingerprint,
  })));
  const memoryByFloor = activeMemoriesByFloor(reachable);
  const summaryCompleted = floors.filter(floor => memoryByFloor.has(floor.id)).length;
  const summaryPending = floors.filter(floor => !memoryByFloor.has(floor.id));
  const summaryPendingFloorIds = Object.freeze([
    ...summaryPending.map(floor => floor.id),
    ...unregisteredSummaryRefs.map(ref => ref.floorId),
  ]);
  const summaryMissingFloorIds = Object.freeze([
    ...floors.filter(floor => !memoryByFloor.has(floor.id)).map(floor => floor.id),
    ...unregisteredSummaryRefs.map(ref => ref.floorId),
  ]);
  const visibleSummaryFloorIds = Object.freeze([
    ...floors.filter(floor => visibleAssistant(snapshot.chat[hostProof.candidateByFloorId.get(floor.id)?.hostLocator.messageIndex])).map(floor => floor.id),
    ...unregisteredSummaryRefs.filter(ref => visibleAssistant(snapshot.chat[ref.hostLocator.messageIndex])).map(ref => ref.floorId),
  ]);
  const eligibleRecent = hostCandidates.filter(candidate => candidate.archiveCandidate !== true && candidate.memoryExcluded !== true
    && visibleAssistant(snapshot.chat[candidate.hostLocator.messageIndex])).slice(-RECENT_VISIBLE_AI_FLOORS);
  const recent = new Set(eligibleRecent.map(candidate => candidate.hostLocator.messageIndex));
  // A contiguous missing suffix may be protected as live work; a gap followed by saved floors remains historical debt.
  const summaryRealtimeProtected = summaryPending.length > 0 && (realtimeOrigin === true
    || summaryCompleted > 0
    || summaryPending.every(floor => recent.has(floor.hostLocator.messageIndex) && visibleAssistant(snapshot.chat[floor.hostLocator.messageIndex])));
  const firstSummaryGap = floors.findIndex(floor => !memoryByFloor.has(floor.id));
  const summaryHasPartialWork = firstSummaryGap >= 0 && floors.slice(firstSummaryGap + 1).some(floor => memoryByFloor.has(floor.id));
  const branchRebuild = reachable.run?.mode === 'branchReplay';
  const partial = hostProof.unmatchedFloorIds.length > 0;
  const summaryStatus = partial ? 'historicalDebt' : !summaryPending.length && !unregisteredSummaryRefs.length
    ? 'caughtUp'
    : (summaryCompleted > 0 || realtimeOrigin === true) && (summaryRealtimeProtected || unregisteredSummaryRefs.length > 0) && !summaryHasPartialWork && !branchRebuild ? 'realtimeTail' : 'historicalDebt';
  let deltaByFloor;
  try {
    const anchorMemory = new Map((reachable.floorMemories ?? []).filter(memory => memory.recordStatus === 'active').map(memory => [memory.floorId, memory]));
    deltaByFloor = new Map();
    for (const delta of filterReachableDeltas({ floors, floorMemories: reachable.floorMemories ?? [], stateDeltas: reachable.stateDeltas ?? [] })) {
      for (const floorId of memorySourceFloorIds(anchorMemory.get(delta.floorId))) deltaByFloor.set(floorId, delta);
    }
  } catch {
    return Object.freeze({ status: 'unknown', hostConfirmed: true, completed: 0, total: floors.length, nextAssistantSeq: floors[0]?.assistantSeq ?? null, pendingFloorIds: Object.freeze(floors.map(floor => floor.id)), realtimeProtected: false, hasPartialWork: false, summaryStatus, summaryCompleted, summaryNextAssistantSeq: summaryPending[0]?.assistantSeq ?? unregisteredSummaryRefs[0]?.assistantSeq ?? null, summaryPendingFloorIds, summaryMissingFloorIds, visibleSummaryFloorIds, summaryRealtimeProtected, summaryHasPartialWork, unregisteredSummaryRefs });
  }
  const completed = floors.filter(floor => memoryByFloor.has(floor.id) && deltaByFloor.has(floor.id)).length;
  const pending = floors.filter(floor => !memoryByFloor.has(floor.id) || !deltaByFloor.has(floor.id));
  if (!partial && !pending.length && !unregisteredSummaryRefs.length) return Object.freeze({ status: 'caughtUp', hostConfirmed: true, completed, total: floors.length, nextAssistantSeq: null, pendingFloorIds: Object.freeze([]), realtimeProtected: false, hasPartialWork: false, summaryStatus: 'caughtUp', summaryCompleted, summaryNextAssistantSeq: null, summaryPendingFloorIds: Object.freeze([]), summaryMissingFloorIds, visibleSummaryFloorIds, summaryRealtimeProtected: false, summaryHasPartialWork: false, unregisteredSummaryRefs });
  const realtimeProtected = realtimeOrigin === true
    || pending.every(floor => recent.has(floor.hostLocator.messageIndex) && visibleAssistant(snapshot.chat[floor.hostLocator.messageIndex]));
  const hasPartialWork = pending.some(floor => memoryByFloor.has(floor.id) || deltaByFloor.has(floor.id));
  const status = !partial && (completed > 0 || realtimeOrigin === true) && realtimeProtected && !hasPartialWork && !branchRebuild ? 'realtimeTail' : 'historicalDebt';
  return Object.freeze({ status, hostConfirmed: true, completed, total: floors.length, nextAssistantSeq: pending[0]?.assistantSeq ?? unregisteredSummaryRefs[0]?.assistantSeq ?? null, pendingFloorIds: Object.freeze([...pending.map(floor => floor.id), ...unregisteredSummaryRefs.map(ref => ref.floorId)]), realtimeProtected, hasPartialWork, summaryStatus, summaryCompleted, summaryNextAssistantSeq: summaryPending[0]?.assistantSeq ?? unregisteredSummaryRefs[0]?.assistantSeq ?? null, summaryPendingFloorIds, summaryMissingFloorIds, visibleSummaryFloorIds, summaryRealtimeProtected, summaryHasPartialWork, unregisteredSummaryRefs });
}

export async function assessMemoryCoverageFromHost({ reachable, snapshot, sanitizerOptions = {}, captureGuard = false, realtimeOrigin = false } = {}) {
  try {
    const chatId = reachable?.root?.chatId ?? '';
    const scanned = await scanAssistantCandidates(snapshot?.chat, { sanitizerOptions, chatId, captureRawContent: captureGuard });
    const hostCandidates = partitionScannedCandidates(reachable, snapshot?.chat, chatId, scanned).all;
    const coverage = assessMemoryCoverage({ reachable, snapshot, hostCandidates, realtimeOrigin });
    const bindings = hostCoverageProof(reachable, snapshot, hostCandidates);
    const guarded = { ...coverage, ...(bindings?.unmatchedFloorIds.length ? { unmatchedFloorIds: bindings.unmatchedFloorIds } : {}) };
    Object.defineProperty(guarded, HOST_BINDINGS, { value: bindings });
    if (captureGuard) Object.defineProperty(guarded, HOST_GUARD, { value: captureHostGuard(snapshot, hostCandidates, bindings) });
    return Object.freeze(guarded);
  } catch {
    const unknown = { status: 'unknown', completed: 0, total: reachable?.floors?.length ?? 0, nextAssistantSeq: null, pendingFloorIds: Object.freeze([]), realtimeProtected: false, hasPartialWork: false, summaryStatus: 'unknown', summaryCompleted: 0, summaryNextAssistantSeq: null, summaryPendingFloorIds: Object.freeze([]), summaryMissingFloorIds: Object.freeze([]), visibleSummaryFloorIds: Object.freeze([]), summaryRealtimeProtected: false, summaryHasPartialWork: false };
    return Object.freeze(unknown);
  }
}
