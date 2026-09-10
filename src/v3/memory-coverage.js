import { filterReachableDeltas } from './cse-engine.js';
import { isHostNarratorMessage, scanAssistantCandidates, selectAssistantMessage } from './foundation-domain.js';
import { inspectMessageFloorAnchor } from './message-floor-anchor.js';

export const RECENT_VISIBLE_AI_FLOORS = 3;
const HOST_GUARD = Symbol('qqjCoverageHostGuard');

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
    candidates: Object.freeze(hostCandidates.map(candidate => Object.freeze({
      messageIndex: candidate.hostLocator.messageIndex,
      swipeId: candidate.hostLocator.swipeId,
      selectedSwipeIndex: candidate.hostLocator.selectedSwipeIndex,
      rawContent: candidate.rawContent,
      rawFingerprint: candidate.rawFingerprint,
      floorId: candidate.messageAnchor?.status === 'valid' ? candidate.messageAnchor.anchor.floorId : null,
      expectedFloorId: expectedFloorByCandidate.get(candidate) ?? null,
      anchorStatus: candidate.messageAnchor?.status ?? 'invalid',
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
      || selected.rawContent !== expected.rawContent
      || visibleAssistant(current) !== expected.visible || !['none', 'valid'].includes(anchor.status)) return false;
    if (anchor.status === 'valid') {
      if (currentFloorIds.has(anchor.anchor.floorId)) return false;
      currentFloorIds.add(anchor.anchor.floorId);
    }
    if (expected.anchorStatus === 'valid') return anchor.status === 'valid' && anchor.anchor.floorId === expected.floorId;
    if (expected.expectedFloorId) return anchor.status === 'none' || anchor.anchor.floorId === expected.expectedFloorId;
    if (expected.visible) return true;
    return anchor.status === 'none';
  });
}

function activeMemoriesByFloor(reachable) {
  const groups = new Map();
  for (const memory of reachable?.floorMemories ?? []) {
    if (memory?.recordStatus !== 'active') continue;
    groups.set(memory.floorId, [...(groups.get(memory.floorId) ?? []), memory]);
  }
  return new Map([...groups].filter(([, values]) => values.length === 1).map(([floorId, values]) => [floorId, values[0]]));
}

function recentVisibleIndexes(chat) {
  const indexes = new Set();
  for (let index = chat.length - 1; index >= 0 && indexes.size < RECENT_VISIBLE_AI_FLOORS; index -= 1) {
    if (visibleAssistant(chat[index])) indexes.add(index);
  }
  return indexes;
}

function hostCoverageProof(reachable, snapshot, hostCandidates) {
  const chat = Array.isArray(snapshot?.chat) ? snapshot.chat : [];
  if (!reachable?.root?.chatId || currentChatId(snapshot) !== reachable.root.chatId || !Array.isArray(hostCandidates)) return null;
  const candidatesByFloorId = new Map();
  const candidatesByMessageIndex = new Map(hostCandidates.map(candidate => [candidate.hostLocator.messageIndex, candidate]));
  for (const candidate of hostCandidates) {
    if (candidate.messageAnchor?.status === 'none') continue;
    if (candidate.messageAnchor?.status !== 'valid' || candidatesByFloorId.has(candidate.messageAnchor.anchor.floorId)) return null;
    candidatesByFloorId.set(candidate.messageAnchor.anchor.floorId, candidate);
  }
  const matchedCandidates = new Set();
  const candidateByFloorId = new Map();
  for (const floor of reachable.floors ?? []) {
    const anchored = candidatesByFloorId.get(floor.id);
    if (anchored) { matchedCandidates.add(anchored); candidateByFloorId.set(floor.id, anchored); continue; }
    const candidate = candidatesByMessageIndex.get(floor.hostLocator?.messageIndex);
    if (!candidate || candidate.messageAnchor?.status !== 'none'
      || candidate.hostLocator.swipeId !== floor.hostLocator?.swipeId
      || candidate.hostLocator.selectedSwipeIndex !== floor.hostLocator?.selectedSwipeIndex
      || candidate.rawFingerprint !== floor.content?.rawFingerprint
      || candidate.canonicalFingerprint !== floor.content?.canonicalFingerprint) return null;
    matchedCandidates.add(candidate);
    candidateByFloorId.set(floor.id, candidate);
  }
  const unregistered = hostCandidates.filter(candidate => !matchedCandidates.has(candidate));
  if (unregistered.some(candidate => candidate.messageAnchor?.status !== 'none')) return null;
  const lastMatchedIndex = Math.max(-1, ...[...matchedCandidates].map(candidate => candidate.hostLocator.messageIndex));
  if (unregistered.some(candidate => candidate.hostLocator.messageIndex <= lastMatchedIndex)) return null;
  return Object.freeze({ unregistered: Object.freeze(unregistered), candidateByFloorId });
}

export function assessMemoryCoverage({ reachable, snapshot, hostCandidates, realtimeOrigin = false } = {}) {
  const hostProof = reachable?.root && Array.isArray(reachable.floors) ? hostCoverageProof(reachable, snapshot, hostCandidates) : null;
  if (!hostProof) {
    return Object.freeze({ status: 'unknown', completed: 0, total: reachable?.floors?.length ?? 0, nextAssistantSeq: null, pendingFloorIds: Object.freeze([]), realtimeProtected: false, hasPartialWork: false, summaryStatus: 'unknown', summaryCompleted: 0, summaryNextAssistantSeq: null, summaryPendingFloorIds: Object.freeze([]), summaryMissingFloorIds: Object.freeze([]), visibleSummaryFloorIds: Object.freeze([]), summaryRealtimeProtected: false, summaryHasPartialWork: false });
  }
  const floors = reachable.floors;
  const nextAssistantSeq = (floors.at(-1)?.assistantSeq ?? 0) + 1;
  const unregisteredSummaryRefs = Object.freeze(hostProof.unregistered.map((candidate, offset) => Object.freeze({
    floorId: `host-tail:${candidate.hostLocator.messageIndex}:${candidate.rawFingerprint}`,
    floorMemoryId: null,
    assistantSeq: nextAssistantSeq + offset,
    hostLocator: Object.freeze({ ...candidate.hostLocator }),
    rawFingerprint: candidate.rawFingerprint,
    canonicalFingerprint: candidate.canonicalFingerprint,
  })));
  const memoryByFloor = activeMemoriesByFloor(reachable);
  let summaryCompleted = 0;
  while (summaryCompleted < floors.length && memoryByFloor.has(floors[summaryCompleted].id)) summaryCompleted += 1;
  const summaryPending = floors.slice(summaryCompleted);
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
  const recent = recentVisibleIndexes(snapshot.chat);
  const summaryRealtimeProtected = summaryPending.length > 0 && (realtimeOrigin === true
    || summaryCompleted > 0
    || summaryPending.every(floor => recent.has(floor.hostLocator.messageIndex) && visibleAssistant(snapshot.chat[floor.hostLocator.messageIndex])));
  const summaryHasPartialWork = summaryPending.some(floor => memoryByFloor.has(floor.id));
  const branchRebuild = reachable.run?.mode === 'branchReplay';
  const summaryStatus = !summaryPending.length && !unregisteredSummaryRefs.length
    ? 'caughtUp'
    : (summaryCompleted > 0 || realtimeOrigin === true) && (summaryRealtimeProtected || unregisteredSummaryRefs.length > 0) && !summaryHasPartialWork && !branchRebuild ? 'realtimeTail' : 'historicalDebt';
  let deltaByFloor;
  try {
    deltaByFloor = new Map(filterReachableDeltas({ floors, floorMemories: reachable.floorMemories ?? [], stateDeltas: reachable.stateDeltas ?? [] }).map(delta => [delta.floorId, delta]));
  } catch {
    return Object.freeze({ status: 'unknown', hostConfirmed: true, completed: 0, total: floors.length, nextAssistantSeq: floors[0]?.assistantSeq ?? null, pendingFloorIds: Object.freeze(floors.map(floor => floor.id)), realtimeProtected: false, hasPartialWork: false, summaryStatus, summaryCompleted, summaryNextAssistantSeq: summaryPending[0]?.assistantSeq ?? unregisteredSummaryRefs[0]?.assistantSeq ?? null, summaryPendingFloorIds, summaryMissingFloorIds, visibleSummaryFloorIds, summaryRealtimeProtected, summaryHasPartialWork, unregisteredSummaryRefs });
  }
  let completed = 0;
  while (completed < floors.length) {
    const floor = floors[completed];
    const memory = memoryByFloor.get(floor.id);
    const delta = deltaByFloor.get(floor.id);
    if (!memory || !delta || delta.floorMemoryId !== memory.id) break;
    completed += 1;
  }
  const pending = floors.slice(completed);
  if (!pending.length && !unregisteredSummaryRefs.length) return Object.freeze({ status: 'caughtUp', hostConfirmed: true, completed, total: floors.length, nextAssistantSeq: null, pendingFloorIds: Object.freeze([]), realtimeProtected: false, hasPartialWork: false, summaryStatus: 'caughtUp', summaryCompleted, summaryNextAssistantSeq: null, summaryPendingFloorIds: Object.freeze([]), summaryMissingFloorIds, visibleSummaryFloorIds, summaryRealtimeProtected: false, summaryHasPartialWork: false, unregisteredSummaryRefs });
  const realtimeProtected = realtimeOrigin === true
    || pending.every(floor => recent.has(floor.hostLocator.messageIndex) && visibleAssistant(snapshot.chat[floor.hostLocator.messageIndex]));
  const hasPartialWork = pending.some(floor => memoryByFloor.has(floor.id) || deltaByFloor.has(floor.id));
  const status = (completed > 0 || realtimeOrigin === true) && realtimeProtected && !hasPartialWork && !branchRebuild ? 'realtimeTail' : 'historicalDebt';
  return Object.freeze({ status, hostConfirmed: true, completed, total: floors.length, nextAssistantSeq: pending[0]?.assistantSeq ?? unregisteredSummaryRefs[0]?.assistantSeq ?? null, pendingFloorIds: Object.freeze([...pending.map(floor => floor.id), ...unregisteredSummaryRefs.map(ref => ref.floorId)]), realtimeProtected, hasPartialWork, summaryStatus, summaryCompleted, summaryNextAssistantSeq: summaryPending[0]?.assistantSeq ?? unregisteredSummaryRefs[0]?.assistantSeq ?? null, summaryPendingFloorIds, summaryMissingFloorIds, visibleSummaryFloorIds, summaryRealtimeProtected, summaryHasPartialWork, unregisteredSummaryRefs });
}

export async function assessMemoryCoverageFromHost({ reachable, snapshot, sanitizerOptions = {}, captureGuard = false, realtimeOrigin = false } = {}) {
  try {
    const chatId = reachable?.root?.chatId ?? '';
    const hostCandidates = await scanAssistantCandidates(snapshot?.chat, { sanitizerOptions, chatId, captureRawContent: captureGuard });
    const coverage = assessMemoryCoverage({ reachable, snapshot, hostCandidates, realtimeOrigin });
    if (!captureGuard) return coverage;
    const guarded = { ...coverage };
    Object.defineProperty(guarded, HOST_GUARD, { value: captureHostGuard(snapshot, hostCandidates, hostCoverageProof(reachable, snapshot, hostCandidates)) });
    return Object.freeze(guarded);
  } catch {
    const unknown = { status: 'unknown', completed: 0, total: reachable?.floors?.length ?? 0, nextAssistantSeq: null, pendingFloorIds: Object.freeze([]), realtimeProtected: false, hasPartialWork: false, summaryStatus: 'unknown', summaryCompleted: 0, summaryNextAssistantSeq: null, summaryPendingFloorIds: Object.freeze([]), summaryMissingFloorIds: Object.freeze([]), visibleSummaryFloorIds: Object.freeze([]), summaryRealtimeProtected: false, summaryHasPartialWork: false };
    return Object.freeze(unknown);
  }
}
