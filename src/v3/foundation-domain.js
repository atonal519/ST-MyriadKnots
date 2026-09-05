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
    version: 1,
    stableCount,
    latestStatus: stableCount === source.length ? 'confirmed' : 'pending',
    floors: source.map(candidate => ({
      assistantSeq: candidate.assistantSeq,
      rawFingerprint: candidate.rawFingerprint,
      canonicalFingerprint: candidate.canonicalFingerprint,
      sanitizerFingerprint: candidate.sanitizerFingerprint,
      messageIndex: candidate.hostLocator?.messageIndex ?? null,
      swipeId: candidate.hostLocator?.swipeId ?? null,
      selectedSwipeIndex: candidate.hostLocator?.selectedSwipeIndex ?? null,
    })),
  };
  return Object.freeze({ payload: Object.freeze(payload), fingerprint: await prefixedHash(JSON.stringify(payload)) });
}

export async function reverseRefShardPrefix(recordId) {
  return (await sha256(String(recordId))).slice(0, 2);
}

export function selectAssistantMessage(message) {
  if (!message || typeof message !== 'object' || message.is_user !== false) return null;
  if (message.is_system === true && message.extra?.type) return null;
  if (Array.isArray(message.swipes)) {
    const selectedSwipeIndex = Number.isSafeInteger(message.swipe_id) ? message.swipe_id : 0;
    const selected = message.swipes[selectedSwipeIndex];
    if (typeof selected !== 'string') return null;
    return { rawContent: normalizeRaw(selected), swipeId: message.swipe_id ?? selectedSwipeIndex, selectedSwipeIndex };
  }
  if (typeof message.mes !== 'string') return null;
  return { rawContent: normalizeRaw(message.mes), swipeId: message.swipe_id ?? null, selectedSwipeIndex: null };
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
  stabilizedBy = 'nextAssistant',
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
    stability: { status: 'stable', stabilizedAt: now, stabilizedBy },
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
  });
}
