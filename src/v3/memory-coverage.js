import { filterReachableDeltas } from './cse-engine.js';
import { scanAssistantCandidates, selectAssistantMessage } from './foundation-domain.js';

export const RECENT_VISIBLE_AI_FLOORS = 3;
const HOST_GUARD = Symbol('qqjCoverageHostGuard');

const currentChatId = snapshot => String(snapshot?.context?.chatMetadata?.qianqianjie?.chatId ?? '').trim();
const visibleAssistant = message => message
  && message.is_user === false
  && message.is_system !== true
  && typeof message.mes === 'string'
  && Boolean(message.mes.trim());

function captureHostGuard(snapshot, hostCandidates) {
  return Object.freeze({
    chatId: currentChatId(snapshot),
    candidates: Object.freeze(hostCandidates.map(candidate => Object.freeze({
      messageIndex: candidate.hostLocator.messageIndex,
      swipeId: candidate.hostLocator.swipeId,
      selectedSwipeIndex: candidate.hostLocator.selectedSwipeIndex,
      rawContent: candidate.rawContent,
    }))),
  });
}

export function coverageHostGuardCurrent(readiness, snapshot) {
  const guard = readiness?.[HOST_GUARD];
  if (!guard || guard.chatId !== currentChatId(snapshot) || !Array.isArray(guard.candidates) || !Array.isArray(snapshot?.chat)) return false;
  return guard.candidates.every(expected => {
    const current = selectAssistantMessage(snapshot.chat[expected.messageIndex]);
    return current
      && current.swipeId === expected.swipeId
      && current.selectedSwipeIndex === expected.selectedSwipeIndex
      && current.rawContent === expected.rawContent;
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

function hostCoverageConfirmed(reachable, snapshot, hostCandidates) {
  const chat = Array.isArray(snapshot?.chat) ? snapshot.chat : [];
  if (!reachable?.root?.chatId || currentChatId(snapshot) !== reachable.root.chatId || !Array.isArray(hostCandidates)) return false;
  const candidatesByMessageIndex = new Map(hostCandidates.map(candidate => [candidate.hostLocator.messageIndex, candidate]));
  for (const floor of reachable.floors ?? []) {
    const candidate = candidatesByMessageIndex.get(floor.hostLocator?.messageIndex);
    if (!candidate
      || candidate.hostLocator.swipeId !== floor.hostLocator?.swipeId
      || candidate.hostLocator.selectedSwipeIndex !== floor.hostLocator?.selectedSwipeIndex
      || candidate.rawFingerprint !== floor.content?.rawFingerprint
      || candidate.canonicalFingerprint !== floor.content?.canonicalFingerprint) return false;
  }
  const hostAssistantCount = hostCandidates.length;
  return (reachable.floors?.length ?? 0) >= Math.max(0, hostAssistantCount - 1)
    && (reachable.floors?.length ?? 0) <= hostAssistantCount;
}

export function assessMemoryCoverage({ reachable, snapshot, hostCandidates, realtimeOrigin = false } = {}) {
  if (!reachable?.root || !Array.isArray(reachable.floors) || !hostCoverageConfirmed(reachable, snapshot, hostCandidates)) {
    return Object.freeze({ status: 'unknown', completed: 0, total: reachable?.floors?.length ?? 0, nextAssistantSeq: null, pendingFloorIds: Object.freeze([]), realtimeProtected: false, hasPartialWork: false });
  }
  const floors = reachable.floors;
  const memoryByFloor = activeMemoriesByFloor(reachable);
  let deltaByFloor;
  try {
    deltaByFloor = new Map(filterReachableDeltas({ floors, floorMemories: reachable.floorMemories ?? [], stateDeltas: reachable.stateDeltas ?? [] }).map(delta => [delta.floorId, delta]));
  } catch {
    return Object.freeze({ status: 'unknown', completed: 0, total: floors.length, nextAssistantSeq: floors[0]?.assistantSeq ?? null, pendingFloorIds: Object.freeze(floors.map(floor => floor.id)), realtimeProtected: false, hasPartialWork: false });
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
  if (!pending.length) return Object.freeze({ status: 'caughtUp', completed, total: floors.length, nextAssistantSeq: null, pendingFloorIds: Object.freeze([]), realtimeProtected: false, hasPartialWork: false });
  const recent = recentVisibleIndexes(snapshot.chat);
  const realtimeProtected = pending.every(floor => recent.has(floor.hostLocator.messageIndex) && visibleAssistant(snapshot.chat[floor.hostLocator.messageIndex]));
  const hasPartialWork = pending.some(floor => memoryByFloor.has(floor.id) || deltaByFloor.has(floor.id));
  const branchRebuild = reachable.run?.mode === 'branchReplay';
  const status = (completed > 0 || realtimeOrigin === true) && realtimeProtected && !hasPartialWork && !branchRebuild ? 'realtimeTail' : 'historicalDebt';
  return Object.freeze({ status, completed, total: floors.length, nextAssistantSeq: pending[0]?.assistantSeq ?? null, pendingFloorIds: Object.freeze(pending.map(floor => floor.id)), realtimeProtected, hasPartialWork });
}

export async function assessMemoryCoverageFromHost({ reachable, snapshot, sanitizerOptions = {}, captureGuard = false, realtimeOrigin = false } = {}) {
  try {
    const hostCandidates = await scanAssistantCandidates(snapshot?.chat, { sanitizerOptions, captureRawContent: captureGuard });
    const coverage = assessMemoryCoverage({ reachable, snapshot, hostCandidates, realtimeOrigin });
    if (!captureGuard) return coverage;
    const guarded = { ...coverage };
    Object.defineProperty(guarded, HOST_GUARD, { value: captureHostGuard(snapshot, hostCandidates) });
    return Object.freeze(guarded);
  } catch {
    const unknown = { status: 'unknown', completed: 0, total: reachable?.floors?.length ?? 0, nextAssistantSeq: null, pendingFloorIds: Object.freeze([]), realtimeProtected: false, hasPartialWork: false };
    return Object.freeze(unknown);
  }
}
