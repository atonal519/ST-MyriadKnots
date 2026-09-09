import { sha256 } from '../identity.js';
import { sanitizeMemoryContent } from '../memory-content-sanitizer.js';

export const FOUNDATION_CAPABILITIES = Object.freeze({
  foundationReady: true,
  memoryReady: false,
  cseReady: false,
  recallReady: false,
});

export const FOUNDATION_FORMAT_VERSION = 1;
const SANITIZER_VERSION = 'memory-content-sanitizer-v1';
const INPUT_SNAPSHOT_VERSION = 2;

const prefixedHash = async value => `sha256:${await sha256(value)}`;
const normalizeRaw = value => String(value ?? '').replace(/\r\n?/g, '\n');

export async function deterministicUuid(parts) {
  const digest = await sha256(JSON.stringify(parts));
  const hex = `${digest.slice(0, 12)}5${digest.slice(13, 16)}8${digest.slice(17, 32)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export async function foundationInputSnapshot(candidates, stableCount) {
  const source = Array.isArray(candidates) ? candidates : [];
  if (!Number.isSafeInteger(stableCount) || stableCount < 0 || stableCount > source.length) {
    throw new TypeError('V3_INPUT_SNAPSHOT_BOUNDARY_INVALID');
  }
  const payload = {
    version: INPUT_SNAPSHOT_VERSION,
    stableCount,
    latestStatus: stableCount === source.length ? 'confirmed' : 'pending',
    floors: source.slice(0, stableCount).map(candidate => ({
      assistantSeq: candidate.assistantSeq,
      rawFingerprint: candidate.rawFingerprint,
      canonicalFingerprint: candidate.canonicalFingerprint,
      sanitizerFingerprint: candidate.sanitizerFingerprint,
      messageIndex: candidate.hostLocator?.messageIndex ?? null,
      swipeId: candidate.hostLocator?.swipeId ?? null,
      selectedSwipeIndex: candidate.hostLocator?.selectedSwipeIndex ?? null,
      stabilityFingerprint: candidate.stabilityProof?.fingerprint ?? null,
    })),
  };
  const stablePrefix = {
    version: payload.version,
    stableCount: payload.stableCount,
    floors: payload.floors,
  };
  return Object.freeze({ payload: Object.freeze(payload), fingerprint: await prefixedHash(JSON.stringify(stablePrefix)) });
}

export function createCheckpointInputFingerprints(floors, { candidates = [], previous = [] } = {}) {
  const priorByFloorId = new Map((Array.isArray(previous) ? previous : []).map(item => [item?.floorId, item]));
  return (Array.isArray(floors) ? floors : []).map((floor, index) => {
    const stabilityFingerprint = candidates[index]?.stabilityProof?.fingerprint
      ?? priorByFloorId.get(floor.id)?.stabilityFingerprint
      ?? floor.stability?.proof?.fingerprint
      ?? null;
    return {
      floorId: floor.id,
      canonicalFingerprint: floor.content.canonicalFingerprint,
      ...(stabilityFingerprint ? { stabilityFingerprint } : {}),
    };
  });
}

export async function reverseRefShardPrefix(recordId) {
  return (await sha256(String(recordId))).slice(0, 2);
}

export const isHostNarratorMessage = message => Boolean(message && typeof message === 'object' && message.extra?.type === 'narrator');

export function selectAssistantMessage(message) {
  if (!message || typeof message !== 'object' || message.is_user !== false) return null;
  if (isHostNarratorMessage(message) || (message.is_system === true && message.extra?.type)) return null;
  if (Array.isArray(message.swipes)) {
    const selectedSwipeIndex = Number.isSafeInteger(message.swipe_id) ? message.swipe_id : 0;
    const selected = message.swipes[selectedSwipeIndex];
    if (typeof selected !== 'string') return null;
    return { rawContent: normalizeRaw(selected), swipeId: message.swipe_id ?? selectedSwipeIndex, selectedSwipeIndex };
  }
  if (typeof message.mes !== 'string') return null;
  return { rawContent: normalizeRaw(message.mes), swipeId: message.swipe_id ?? null, selectedSwipeIndex: null };
}

export function selectUserStabilityAnchor(message) {
  if (!message || typeof message !== 'object' || message.is_user !== true) return null;
  if (isHostNarratorMessage(message) || (message.is_system === true && message.extra?.type)) return null;
  return Object.freeze({
    sentAt: typeof message.send_date === 'string' || typeof message.send_date === 'number' ? String(message.send_date) : null,
    name: typeof message.name === 'string' ? message.name.trim().slice(0, 200) : '',
    isSystem: message.is_system === true,
  });
}

export async function sanitizerFingerprint(options = {}) {
  return prefixedHash(JSON.stringify([
    SANITIZER_VERSION,
    FOUNDATION_FORMAT_VERSION,
    String(options.keepTags ?? 'content'),
    String(options.extraTags ?? ''),
  ]));
}

export async function scanAssistantCandidates(chat, {
  sanitizerOptions = {},
  captureRawContent = false,
  yieldEvery = 50,
  yieldControl = () => new Promise(resolve => setTimeout(resolve, 0)),
  metrics,
} = {}) {
  const source = Array.isArray(chat) ? chat : [];
  const candidates = [];
  const sanitizerHash = await sanitizerFingerprint(sanitizerOptions);
  let assistantSeq = 0;
  let lastYieldAt = globalThis.performance?.now?.() ?? Date.now();
  let maximumChunkMs = 0;
  for (let messageIndex = 0; messageIndex < source.length; messageIndex += 1) {
    const selected = selectAssistantMessage(source[messageIndex]);
    if (!selected) continue;
    const canonicalContent = sanitizeMemoryContent(selected.rawContent, sanitizerOptions);
    if (!canonicalContent) continue;
    assistantSeq += 1;
    const [rawFingerprint, canonicalFingerprint] = await Promise.all([
      prefixedHash(selected.rawContent),
      prefixedHash(canonicalContent),
    ]);
    const anchor = selectUserStabilityAnchor(source[messageIndex + 1]);
    const stabilityProof = anchor ? Object.freeze({
      kind: 'nextUser',
      messageIndex: messageIndex + 1,
      fingerprint: await prefixedHash(JSON.stringify(anchor.sentAt
        ? ['sendDate', anchor.sentAt]
        : ['position', messageIndex + 1, anchor.name, anchor.isSystem])),
    }) : null;
    candidates.push(Object.freeze({
      assistantSeq,
      hostLocator: Object.freeze({
        messageIndex,
        swipeId: selected.swipeId,
        selectedSwipeIndex: selected.selectedSwipeIndex,
      }),
      ...(captureRawContent ? { rawContent: selected.rawContent } : {}),
      rawFingerprint,
      canonicalFingerprint,
      sanitizerFingerprint: sanitizerHash,
      canonicalContent,
      stabilityProof,
    }));
    if (assistantSeq % Math.max(1, yieldEvery) === 0) {
      const now = globalThis.performance?.now?.() ?? Date.now();
      maximumChunkMs = Math.max(maximumChunkMs, now - lastYieldAt);
      await yieldControl();
      lastYieldAt = globalThis.performance?.now?.() ?? Date.now();
    }
  }
  const finalNow = globalThis.performance?.now?.() ?? Date.now();
  maximumChunkMs = Math.max(maximumChunkMs, finalNow - lastYieldAt);
  if (metrics && typeof metrics === 'object') metrics.maximumChunkMs = maximumChunkMs;
  return Object.freeze(candidates);
}

export function findEarliestCanonicalDivergence(activeFloors, candidates, compareCount = Math.min(activeFloors.length, candidates.length)) {
  for (let index = 0; index < compareCount; index += 1) {
    if (activeFloors[index]?.content?.canonicalFingerprint !== candidates[index]?.canonicalFingerprint) return index + 1;
  }
  if (activeFloors.length !== candidates.length) return compareCount + 1;
  return null;
}

export function createFloorRecord({
  id,
  chatId,
  narrativeGeneration,
  candidate,
  predecessorFloorId = null,
  stabilizedBy = 'nextUser',
  runId,
  checkpointId = null,
  now,
  supersedes = null,
} = {}) {
  return {
    schemaVersion: 3,
    recordType: 'floor',
    id,
    chatId,
    narrativeGeneration,
    assistantSeq: candidate.assistantSeq,
    predecessorFloorId,
    hostLocator: { ...candidate.hostLocator },
    content: {
      canonicalContent: candidate.canonicalContent,
      rawFingerprint: candidate.rawFingerprint,
      canonicalFingerprint: candidate.canonicalFingerprint,
      sanitizerFingerprint: candidate.sanitizerFingerprint,
      formatVersion: FOUNDATION_FORMAT_VERSION,
    },
    stability: {
      status: 'stable', stabilizedAt: now, stabilizedBy,
      ...(candidate.stabilityProof ? { proof: { ...candidate.stabilityProof } } : {}),
    },
    processing: {
      sourceSaved: true,
      memoryReady: false,
      cseRequired: false,
      cseReady: false,
      recallReady: false,
      runId,
      checkpointId,
    },
    createdAt: now,
    updatedAt: now,
    recordStatus: 'staged',
    supersedes,
  };
}

export function candidateSummary(candidate) {
  if (!candidate) return null;
  return Object.freeze({
    assistantSeq: candidate.assistantSeq,
    messageIndex: candidate.hostLocator.messageIndex,
    canonicalFingerprint: candidate.canonicalFingerprint,
    stabilityProof: candidate.stabilityProof ? Object.freeze({ ...candidate.stabilityProof }) : null,
  });
}
