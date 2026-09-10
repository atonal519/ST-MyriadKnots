import { sha256 } from '../identity.js';
import { sanitizeSensitiveText } from './safe-metadata.js';
import { coverageHostGuardCurrent } from './memory-coverage.js';
import { projectRecallSource, readRecallSource } from './recall-source.js';
import { buildRecallQueryContext, buildRecallQueryFrame } from './recall-selector.js';
import { selectRecallWithLlm } from './recall-llm-selector.js';
import { selectAssistantMessage } from './foundation-domain.js';
import { inspectMessageFloorAnchor } from './message-floor-anchor.js';
import { sanitizeMemoryContent } from '../memory-content-sanitizer.js';

export const RECALL_PROMPT_SLOT = 'qqj_v3_recalled_context';
export const RECALL_RECEIPT_KEY = 'qqj_v3_recall_receipt';
export const RECALL_RECEIPT_SCHEMA_VERSION = 9;
export const RECALL_STRATEGY_VERSION = 'continuity-v1';

const SUPPORTED_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue']);
const MAIN_GENERATION_TYPES = new Set([...SUPPORTED_TYPES, 'impersonate']);
const REUSE_TYPES = new Set(['regenerate', 'swipe', 'continue']);
const MAX_STOPPED_GENERATION_CHAINS = 16;
const MAX_RECEIPT_FLOORS = 8;
const MAX_RECEIPT_STATES = 18;
const MAX_RECEIPT_SKIP_REASONS = 32;
const nowIso = now => { const value = now()?.toISOString?.() ?? String(now()); if (!Number.isFinite(Date.parse(value))) throw new TypeError('V3_RECALL_TIME_INVALID'); return value; };
const clean = (value, maximum = 500) => sanitizeSensitiveText(String(value ?? '')).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);
const clone = value => structuredClone(value);
const hashText = async value => `sha256:${await sha256(String(value ?? ''))}`;
const currentChatId = snapshot => String(snapshot?.context?.chatMetadata?.qianqianjie?.chatId ?? '').trim();
const isPlayableUser = message => message && message.is_user === true && message.is_system !== true && typeof message.mes === 'string' && message.mes.trim();
const FINAL_REASONS = new Set(['chatChanged', 'userChanged', 'narrativeChanged', 'selectedRefsChanged', 'sourceStale', 'sourceUnavailable', 'stopped', 'superseded', 'disabled']);

function latestUser(snapshot) {
  const chat = snapshot?.chat ?? [];
  for (let index = chat.length - 1; index >= 0; index -= 1) if (isPlayableUser(chat[index])) return { index, message: chat[index] };
  return null;
}

const liveRecallFrameKey = snapshot => JSON.stringify(buildRecallQueryFrame({ coreChat: snapshot?.chat, assistantTurns: 1 }).messages.map(message => [message.role, message.text]));

function sourceRefsValid(receipt, source) {
  if (!Array.isArray(source?.floorMemories) || !Array.isArray(source?.currentState) || !Array.isArray(receipt?.selectedFloors) || !Array.isArray(receipt?.selectedStates)) return false;
  const memories = new Map(source.floorMemories.map(memory => [`${memory.floorId}|${memory.floorMemoryId}|${memory.assistantSeq}`, memory]));
  if (!receipt.selectedFloors.every(value => value && typeof value === 'object' && memories.has(`${value.floorId}|${value.floorMemoryId}|${value.assistantSeq}`))) return false;
  const subjects = new Map(source.currentState.map(subject => [subject.subjectEntityId, subject]));
  return receipt.selectedStates.every(value => {
    if (!value || typeof value !== 'object' || !['core', 'adaptive', 'situational'].includes(value.layer)) return false;
    const subject = subjects.get(value.subjectEntityId);
    return Array.isArray(subject?.[value.layer]) && subject[value.layer].some(item => item.text === value.text && item.visibility === value.visibility && item.towardEntityId === (value.towardEntityId ?? null) && item.sourceAssistantSeq === (value.sourceAssistantSeq ?? null));
  });
}

const legacyReceiptMaterial = receipt => [
  receipt.schemaVersion, receipt.pluginVersion, receipt.chatId, receipt.narrativeGeneration, receipt.headCheckpointId, receipt.rootRevision,
  receipt.userMessageIndex, receipt.userContentFingerprint, receipt.queryFingerprint, receipt.generationType,
  receipt.selectedFloors, receipt.selectedStates, receipt.coverage, receipt.injectionText, receipt.stages, receipt.skipReasons, receipt.completionStatus, receipt.createdAt,
];
const receiptMaterial = receipt => receipt.schemaVersion >= 9
  ? [...legacyReceiptMaterial(receipt), receipt.bodyMatchFingerprint, receipt.strategyVersion]
  : receipt.schemaVersion >= 8 ? [...legacyReceiptMaterial(receipt), receipt.bodyMatchFingerprint] : legacyReceiptMaterial(receipt);

const boundedString = (value, maximum, { empty = false } = {}) => typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
const optionalBoundedString = (value, maximum) => value === null || boundedString(value, maximum);
const nonNegativeInteger = value => Number.isSafeInteger(value) && value >= 0;
const optionalPositiveInteger = value => value === null || (Number.isSafeInteger(value) && value > 0);
function receiptShapeValid(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || !['ready', 'empty'].includes(receipt.completionStatus)
    || !boundedString(receipt.pluginVersion, 120)
    || !boundedString(receipt.chatId, 500)
    || !boundedString(receipt.narrativeGeneration, 500)
    || !boundedString(receipt.headCheckpointId, 500)
    || !Number.isSafeInteger(receipt.rootRevision) || receipt.rootRevision < 1
    || !nonNegativeInteger(receipt.userMessageIndex)
    || !boundedString(receipt.userContentFingerprint, 200)
    || !boundedString(receipt.queryFingerprint, 200)
    || (receipt.schemaVersion >= 8 && !boundedString(receipt.bodyMatchFingerprint, 200))
    || (receipt.schemaVersion >= 9 && receipt.strategyVersion !== RECALL_STRATEGY_VERSION)
    || !SUPPORTED_TYPES.has(receipt.generationType)
    || !Array.isArray(receipt.selectedFloors) || receipt.selectedFloors.length > MAX_RECEIPT_FLOORS
    || !Array.isArray(receipt.selectedStates) || receipt.selectedStates.length > MAX_RECEIPT_STATES
    || !Array.isArray(receipt.skipReasons) || receipt.skipReasons.length > MAX_RECEIPT_SKIP_REASONS
    || !boundedString(receipt.injectionText, 12000, { empty: true })
    || !boundedString(receipt.receiptFingerprint, 200)
    || !boundedString(receipt.createdAt, 100) || !Number.isFinite(Date.parse(receipt.createdAt))
    || (receipt.completionStatus === 'ready') !== Boolean(receipt.injectionText)) return false;
  if (!receipt.selectedFloors.every(value => value && typeof value === 'object' && !Array.isArray(value)
    && boundedString(value.floorId, 500) && boundedString(value.floorMemoryId, 500)
    && Number.isSafeInteger(value.assistantSeq) && value.assistantSeq > 0
    && Array.isArray(value.reasons) && value.reasons.length <= 32
    && value.reasons.every(reason => boundedString(reason, 500)))) return false;
  if (!receipt.selectedStates.every(value => value && typeof value === 'object' && !Array.isArray(value)
    && boundedString(value.subjectEntityId, 500) && boundedString(value.subject, 500)
    && ['core', 'adaptive', 'situational'].includes(value.layer)
    && optionalBoundedString(value.towardEntityId, 500) && optionalBoundedString(value.toward, 500)
    && boundedString(value.text, 4000) && boundedString(value.reason, 1000, { empty: true })
    && ['private', 'observable', 'expressed', 'shared', 'authorial'].includes(value.visibility)
    && optionalPositiveInteger(value.sourceAssistantSeq))) return false;
  if (receipt.coverage !== null && (typeof receipt.coverage !== 'object' || Array.isArray(receipt.coverage)
    || !['stableAiFloors', 'stableThroughAssistantSeq', 'rememberedAiFloors', 'cseThroughAssistantSeq'].every(key => nonNegativeInteger(receipt.coverage[key]))
    || typeof receipt.coverage.memoryComplete !== 'boolean' || typeof receipt.coverage.cseCurrent !== 'boolean'
    || !Array.isArray(receipt.coverage.missingAssistantSeq) || receipt.coverage.missingAssistantSeq.length > 10000
    || !receipt.coverage.missingAssistantSeq.every(value => Number.isSafeInteger(value) && value > 0))) return false;
  if (receipt.stages !== null && (typeof receipt.stages !== 'object' || Array.isArray(receipt.stages)
    || !['input', 'candidates', 'dropRecent', 'dropPersistent', 'dropVisibility', 'selected'].every(key => nonNegativeInteger(receipt.stages[key]))
    || (receipt.schemaVersion >= 9 && !['recentSummaryCount', 'distantHistoryItemCount', 'stateCount'].every(key => nonNegativeInteger(receipt.stages[key]))))) return false;
  return receipt.skipReasons.every(reason => boundedString(reason, 120));
}

async function receiptValid(receipt, { source, userIndex, userFingerprint, queryFingerprint, pluginVersion }, fingerprint = hashText) {
  try {
    const snapshot = clone(receipt);
    if (!receiptShapeValid(snapshot)
      || snapshot.schemaVersion !== RECALL_RECEIPT_SCHEMA_VERSION
      || snapshot.pluginVersion !== pluginVersion
      || snapshot.chatId !== source.chatId
      || snapshot.narrativeGeneration !== source.narrativeGeneration
      || snapshot.headCheckpointId !== source.headCheckpointId
      || snapshot.rootRevision !== source.rootRevision
      || snapshot.userMessageIndex !== userIndex
      || snapshot.userContentFingerprint !== userFingerprint
      || snapshot.queryFingerprint !== queryFingerprint
      || snapshot.bodyMatchFingerprint !== source.bodyMatch?.fingerprint
      || snapshot.receiptFingerprint !== await fingerprint(JSON.stringify(receiptMaterial(snapshot)))
      || !sourceRefsValid(snapshot, source)) return null;
    return snapshot;
  } catch {
    return null;
  }
}

async function persistedReceiptValid(receipt, { chatId, userIndex, userFingerprint, pluginVersion }, fingerprint = hashText) {
  try {
    const snapshot = clone(receipt);
    if (!receiptShapeValid(snapshot)
      || snapshot.schemaVersion !== RECALL_RECEIPT_SCHEMA_VERSION
      || snapshot.pluginVersion !== pluginVersion
      || snapshot.chatId !== chatId
      || snapshot.userMessageIndex !== userIndex
      || snapshot.userContentFingerprint !== userFingerprint
      || snapshot.receiptFingerprint !== await fingerprint(JSON.stringify(receiptMaterial(snapshot)))) return null;
    return snapshot;
  } catch {
    return null;
  }
}

async function historicalSignedReceiptValid(receipt, { chatId, userIndex, userFingerprint }, fingerprint = hashText) {
  try {
    const snapshot = clone(receipt);
    if (!receiptShapeValid(snapshot)
      || ![6, 7, 8, RECALL_RECEIPT_SCHEMA_VERSION].includes(snapshot.schemaVersion)
      || snapshot.chatId !== chatId
      || snapshot.userMessageIndex !== userIndex
      || snapshot.userContentFingerprint !== userFingerprint
      || snapshot.receiptFingerprint !== await fingerprint(JSON.stringify(receiptMaterial(snapshot)))) return null;
    return snapshot;
  } catch {
    return null;
  }
}

function stateFromReceipt(receipt, { generationType = receipt.generationType, restoredReceipt = false, timings = null } = {}) {
  return Object.freeze({
    status: receipt.completionStatus,
    userMessageIndex: receipt.userMessageIndex,
    generationType,
    coverage: receipt.coverage,
    selectedFloors: Object.freeze(clone(receipt.selectedFloors ?? [])),
    selectedStates: Object.freeze(clone(receipt.selectedStates ?? [])),
    injectionText: receipt.injectionText,
    reusedReceipt: !restoredReceipt,
    restoredReceipt,
    receiptPersistence: restoredReceipt ? 'persisted' : receipt.receiptPersistence ?? 'persisted',
    stages: receipt.stages ?? null,
    timings: timings ? Object.freeze({ ...timings }) : null,
    skipReasons: Object.freeze([...(receipt.skipReasons ?? [])]),
    error: null,
    createdAt: receipt.createdAt,
  });
}

function legacyStateFromReceipt(receipt, { chatId, userIndex }) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || receipt.schemaVersion !== 4
    || receipt.chatId !== chatId
    || (receipt.userMessageIndex !== undefined && receipt.userMessageIndex !== null && receipt.userMessageIndex !== userIndex)
    || typeof receipt.injectionText !== 'string') return null;
  const selectedFloors = Array.isArray(receipt.selectedFloors) ? receipt.selectedFloors.filter(value => value && typeof value === 'object' && !Array.isArray(value)) : [];
  const selectedStates = Array.isArray(receipt.selectedStates) ? receipt.selectedStates.filter(value => value && typeof value === 'object' && !Array.isArray(value)) : [];
  return Object.freeze({
    status: receipt.injectionText ? 'ready' : 'empty',
    userMessageIndex: Number.isSafeInteger(receipt.userMessageIndex) ? receipt.userMessageIndex : null,
    generationType: SUPPORTED_TYPES.has(receipt.generationType) ? receipt.generationType : null,
    coverage: receipt.coverage && typeof receipt.coverage === 'object' && !Array.isArray(receipt.coverage) ? clone(receipt.coverage) : null,
    selectedFloors: Object.freeze(clone(selectedFloors)),
    selectedStates: Object.freeze(clone(selectedStates)),
    injectionText: receipt.injectionText,
    reusedReceipt: false,
    restoredReceipt: true,
    legacyReadOnly: true,
    receiptPersistence: 'legacyReadOnly',
    stages: receipt.stages && typeof receipt.stages === 'object' && !Array.isArray(receipt.stages) ? clone(receipt.stages) : null,
    timings: null,
    skipReasons: Object.freeze(Array.isArray(receipt.skipReasons) ? receipt.skipReasons.filter(value => typeof value === 'string') : []),
    error: null,
    createdAt: typeof receipt.createdAt === 'string' && Number.isFinite(Date.parse(receipt.createdAt)) ? receipt.createdAt : null,
  });
}

export async function projectHistoricalRecallReceipt(message, { chatId, userMessageIndex, fingerprint = hashText } = {}) {
  if (!message || typeof message !== 'object' || typeof message.mes !== 'string'
    || typeof chatId !== 'string' || !chatId.trim()
    || !Number.isSafeInteger(userMessageIndex) || userMessageIndex < 0
    || typeof fingerprint !== 'function') return null;
  const receipt = message.extra?.[RECALL_RECEIPT_KEY];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
  if ([6, 7, 8, RECALL_RECEIPT_SCHEMA_VERSION].includes(receipt.schemaVersion)) {
    const snapshot = await historicalSignedReceiptValid(receipt, {
      chatId: chatId.trim(),
      userIndex: userMessageIndex,
      userFingerprint: await fingerprint(message.mes),
    }, fingerprint);
    return snapshot ? stateFromReceipt(snapshot, { restoredReceipt: true }) : null;
  }
  return legacyStateFromReceipt(receipt, { chatId: chatId.trim(), userIndex: userMessageIndex });
}

async function captureCoreBodyWitness(coreChat, sanitizerOptions, fingerprint) {
  const chat = Array.isArray(coreChat) ? coreChat : [];
  const selected = [];
  for (let index = chat.length - 1; index >= 0 && selected.length < 3; index -= 1) {
    const message = chat[index];
    if (!message || message.is_system === true || message.is_hidden === true || message.hidden === true) continue;
    if (message.is_user !== false || typeof message.mes !== 'string') continue;
    const rawContent = message.mes.replace(/\r\n?/g, '\n');
    if (!rawContent.trim()) continue;
    const canonical = sanitizeMemoryContent(rawContent, sanitizerOptions);
    if (!canonical) continue;
    selected.push(Object.freeze({
      coreIndex: index, message, rawContent, canonicalContent: canonical,
      rawFingerprint: await fingerprint(rawContent),
      canonicalFingerprint: await fingerprint(canonical),
    }));
  }
  return Object.freeze(selected.reverse());
}

async function attachCoreBodyMatch(source, witness, snapshot, sanitizerOptions, fingerprint) {
  const verified = [];
  for (const ref of source.bodyMatchRefs ?? []) {
    const liveMessage = snapshot?.chat?.[ref.hostLocator?.messageIndex];
    const selected = selectAssistantMessage(liveMessage);
    if (!selected || selected.swipeId !== ref.hostLocator.swipeId || selected.selectedSwipeIndex !== ref.hostLocator.selectedSwipeIndex) continue;
    const canonical = sanitizeMemoryContent(selected.rawContent, sanitizerOptions);
    const [rawFingerprint, canonicalFingerprint] = await Promise.all([fingerprint(selected.rawContent), fingerprint(canonical)]);
    if (rawFingerprint !== ref.rawFingerprint || canonicalFingerprint !== ref.canonicalFingerprint) continue;
    verified.push({ ...ref, liveMessage, liveIndex: ref.hostLocator.messageIndex, rawContent: selected.rawContent, canonicalContent: canonical, key: `${rawFingerprint}|${canonicalFingerprint}` });
  }
  const materialFor = (covered, readinessCovered) => ({
    version: 2,
    witnesses: witness.map(item => [item.coreIndex, item.rawFingerprint, item.canonicalFingerprint]),
    covered: covered.map(item => [item.floorId, item.floorMemoryId, item.assistantSeq, item.rawFingerprint, item.canonicalFingerprint]),
    readinessCovered: readinessCovered.map(item => [item.floorId, item.floorMemoryId, item.assistantSeq, item.rawFingerprint, item.canonicalFingerprint]),
  });
  const resultFor = async (covered, readinessCovered = covered) => Object.freeze({
    fingerprint: await fingerprint(JSON.stringify(materialFor(covered, readinessCovered))),
    witnessCount: witness.length,
    matchedCount: covered.length,
    coveredFloorIds: Object.freeze(covered.map(item => item.floorId)),
    coveredRefs: Object.freeze(covered.map(item => Object.freeze({ floorId: item.floorId, floorMemoryId: item.floorMemoryId, assistantSeq: item.assistantSeq }))),
    readinessMatchedCount: readinessCovered.length,
    readinessCoveredFloorIds: Object.freeze(readinessCovered.map(item => item.floorId)),
    readinessCoveredRefs: Object.freeze(readinessCovered.map(item => Object.freeze({ floorId: item.floorId, floorMemoryId: item.floorMemoryId, assistantSeq: item.assistantSeq }))),
  });
  if (!verified.length || !witness.length) return resultFor([]);
  const liveCandidates = [];
  for (let liveIndex = 0; liveIndex < (snapshot?.chat?.length ?? 0); liveIndex += 1) {
    const liveMessage = snapshot.chat[liveIndex];
    if (!liveMessage || liveMessage.is_system === true || liveMessage.is_hidden === true || liveMessage.hidden === true) continue;
    const selected = selectAssistantMessage(liveMessage);
    if (!selected?.rawContent?.trim()) continue;
    const canonicalContent = sanitizeMemoryContent(selected.rawContent, sanitizerOptions);
    if (!canonicalContent) continue;
    liveCandidates.push({ liveIndex, liveMessage, rawContent: selected.rawContent, canonicalContent });
  }
  const witnessCounts = new Map();
  for (const item of witness) {
    const key = `${item.rawFingerprint}|${item.canonicalFingerprint}`;
    witnessCounts.set(key, (witnessCounts.get(key) ?? 0) + 1);
  }
  const tentative = [];
  const readinessTentative = [];
  const canonicalWitnessCounts = new Map();
  const canonicalRefCounts = new Map();
  for (const item of witness) canonicalWitnessCounts.set(item.canonicalFingerprint, (canonicalWitnessCounts.get(item.canonicalFingerprint) ?? 0) + 1);
  for (const ref of verified) canonicalRefCounts.set(ref.canonicalFingerprint, (canonicalRefCounts.get(ref.canonicalFingerprint) ?? 0) + 1);
  for (const item of witness) {
    const key = `${item.rawFingerprint}|${item.canonicalFingerprint}`;
    const identity = verified.find(ref => ref.liveMessage === item.message && ref.key === key);
    const liveMatches = witnessCounts.get(key) === 1
      ? liveCandidates.filter(candidate => candidate.rawContent === item.rawContent && candidate.canonicalContent === item.canonicalContent)
      : [];
    const cloneLive = liveMatches.length === 1 ? liveMatches[0] : null;
    const match = identity ?? (cloneLive ? verified.find(ref => ref.liveIndex === cloneLive.liveIndex && ref.key === key) : null);
    if (match) tentative.push({ coreIndex: item.coreIndex, match, identity: Boolean(identity) });

    const marker = inspectMessageFloorAnchor(item.message, source.chatId);
    const readinessEligible = marker.status !== 'invalid' && marker.status !== 'foreign';
    let readinessMatch = readinessEligible ? match : null;
    if (!readinessMatch && readinessEligible && canonicalWitnessCounts.get(item.canonicalFingerprint) === 1 && canonicalRefCounts.get(item.canonicalFingerprint) === 1) {
      readinessMatch = verified.find(ref => ref.canonicalFingerprint === item.canonicalFingerprint
        && (marker.status === 'none' || marker.anchor.floorId === ref.floorId)) ?? null;
    }
    if (!readinessMatch && readinessEligible) {
      const linked = verified.filter(ref => {
        const markerMatch = marker.status === 'valid' && marker.anchor.floorId === ref.floorId;
        const sharedExtra = marker.status === 'none' && item.message?.extra && typeof item.message.extra === 'object' && item.message.extra === ref.liveMessage?.extra;
        const sharedSwipes = marker.status === 'none' && Array.isArray(item.message?.swipes) && item.message.swipes === ref.liveMessage?.swipes;
        return markerMatch || sharedExtra || sharedSwipes;
      });
      if (linked.length === 1) {
        const ref = linked[0];
        const bodySurvives = item.rawContent.includes(ref.rawContent)
          || item.canonicalContent.includes(ref.canonicalContent);
        if (bodySurvives) readinessMatch = ref;
      }
    }
    if (readinessMatch) readinessTentative.push({ coreIndex: item.coreIndex, match: readinessMatch });
  }
  tentative.sort((left, right) => left.coreIndex - right.coreIndex);
  const covered = [];
  let previousSeq = 0;
  for (const entry of tentative) {
    if (entry.match.assistantSeq <= previousSeq) continue;
    covered.push(entry.match);
    previousSeq = entry.match.assistantSeq;
  }
  readinessTentative.sort((left, right) => left.coreIndex - right.coreIndex);
  const readinessCovered = [];
  previousSeq = 0;
  for (const entry of readinessTentative) {
    if (entry.match.assistantSeq <= previousSeq) continue;
    readinessCovered.push(entry.match);
    previousSeq = entry.match.assistantSeq;
  }
  return resultFor(covered, readinessCovered);
}

const sameBodyRef = (left, right) => Boolean(left && right
  && left.assistantSeq === right.assistantSeq
  && left.rawFingerprint === right.rawFingerprint
  && left.canonicalFingerprint === right.canonicalFingerprint
  && left.hostLocator?.messageIndex === right.hostLocator?.messageIndex
  && left.hostLocator?.swipeId === right.hostLocator?.swipeId
  && left.hostLocator?.selectedSwipeIndex === right.hostLocator?.selectedSwipeIndex);

async function captureCoveredBodyGuards(source, currentSource, snapshot, sanitizerOptions, fingerprint) {
  const sourceRefs = new Map((source.bodyMatchRefs ?? []).map(ref => [`${ref.floorId}|${ref.assistantSeq}`, ref]));
  const currentRefs = currentSource.bodyMatchRefs ?? [];
  const guards = [];
  for (const covered of source.bodyMatch?.coveredRefs ?? []) {
    const key = `${covered.floorId}|${covered.assistantSeq}`;
    const original = sourceRefs.get(key);
    const current = currentRefs.find(ref => sameBodyRef(original, ref));
    if (!sameBodyRef(original, current)) return null;
    const message = snapshot?.chat?.[current.hostLocator.messageIndex];
    const selected = selectAssistantMessage(message);
    if (!selected || selected.swipeId !== current.hostLocator.swipeId || selected.selectedSwipeIndex !== current.hostLocator.selectedSwipeIndex) return null;
    const canonicalContent = sanitizeMemoryContent(selected.rawContent, sanitizerOptions);
    const [rawFingerprint, canonicalFingerprint] = await Promise.all([fingerprint(selected.rawContent), fingerprint(canonicalContent)]);
    if (rawFingerprint !== current.rawFingerprint || canonicalFingerprint !== current.canonicalFingerprint) return null;
    guards.push(Object.freeze({
      hostLocator: current.hostLocator,
      rawContent: selected.rawContent,
      canonicalContent,
    }));
  }
  const guardedLocators = new Set(guards.map(guard => JSON.stringify(guard.hostLocator)));
  for (const covered of currentSource.bodyMatch?.readinessCoveredRefs ?? []) {
    const current = currentRefs.find(ref => ref.floorId === covered.floorId && ref.assistantSeq === covered.assistantSeq);
    if (!current) return null;
    const locatorKey = JSON.stringify(current.hostLocator);
    if (guardedLocators.has(locatorKey)) continue;
    const selected = selectAssistantMessage(snapshot?.chat?.[current.hostLocator.messageIndex]);
    if (!selected || selected.swipeId !== current.hostLocator.swipeId || selected.selectedSwipeIndex !== current.hostLocator.selectedSwipeIndex) return null;
    const canonicalContent = sanitizeMemoryContent(selected.rawContent, sanitizerOptions);
    const [rawFingerprint, canonicalFingerprint] = await Promise.all([fingerprint(selected.rawContent), fingerprint(canonicalContent)]);
    if (rawFingerprint !== current.rawFingerprint || canonicalFingerprint !== current.canonicalFingerprint) return null;
    guards.push(Object.freeze({ hostLocator: current.hostLocator, rawContent: selected.rawContent, canonicalContent }));
    guardedLocators.add(locatorKey);
  }
  return Object.freeze(guards);
}

function coveredBodyGuardsCurrent(guards, snapshot, sanitizerOptions) {
  return guards.every(guard => {
    const selected = selectAssistantMessage(snapshot?.chat?.[guard.hostLocator.messageIndex]);
    return Boolean(selected
      && selected.swipeId === guard.hostLocator.swipeId
      && selected.selectedSwipeIndex === guard.hostLocator.selectedSwipeIndex
      && selected.rawContent === guard.rawContent
      && sanitizeMemoryContent(selected.rawContent, sanitizerOptions) === guard.canonicalContent);
  });
}

export function createV3RecallRuntime({ store, hostAdapter, generateUtilityTask = null, isEnabled = true, automationSettings = () => ({ enabled: false }), memoryStatus = () => null, prepareMemory = null, preparationTimeoutMs = 5000, historicalMaintenance = () => false, realtimeOrigin = () => false, notifyUser = null, sourceReader = readRecallSource, selector = null, queryBuilder = buildRecallQueryContext, fingerprint = hashText, sanitizerOptions = () => ({}), now = () => new Date(), pluginVersion = '0.2.27', logger = console } = {}) {
  if (!store || typeof store.readReachable !== 'function') throw new TypeError('V3 recall store 无效');
  if (!hostAdapter || typeof hostAdapter.snapshot !== 'function') throw new TypeError('V3 recall host adapter 无效');
  if (typeof fingerprint !== 'function') throw new TypeError('V3 recall fingerprint 无效');
  let epoch = 0, generationSerial = 0, stoppedEndDebt = 0, active = null, slotOwner = null, lastRecall = null, lastError = null, lastRecallBinding = null, enabledOverride = null;
  const subscribers = new Set(), generationQueue = [];
  let sessionReceipt = null;
  const enabled = () => { try { return enabledOverride ?? ((typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true); } catch { return false; } };
  const currentSanitizerOptions = () => { try { return typeof sanitizerOptions === 'function' ? sanitizerOptions() : sanitizerOptions; } catch { return {}; } };
  const maintenanceActive = () => { try { return (typeof historicalMaintenance === 'function' ? historicalMaintenance() : historicalMaintenance) === true; } catch { return false; } };
  const hasRealtimeOrigin = () => { try { return (typeof realtimeOrigin === 'function' ? realtimeOrigin() : realtimeOrigin) === true; } catch { return false; } };
  const selectionRunner = typeof selector === 'function'
    ? selector
    : input => selectRecallWithLlm({ ...input, generateUtilityTask, signal: input.signal });
  const readinessReasons = source => {
    if (!source?.readiness || source.readiness.status === 'caughtUp') return [];
    if (source.readiness.status === 'unknown' && source.readiness.hostConfirmed !== true) return ['memoryNotReady', 'coverageUnconfirmed'];
    const coveredFloorIds = new Set(source.bodyMatch?.readinessCoveredFloorIds ?? source.bodyMatch?.coveredFloorIds ?? []);
    const pendingSummaryFloorIds = source.readiness.summaryPendingFloorIds ?? [];
    if (source.readiness.summaryStatus === 'caughtUp') return [];
    if (source.readiness.hostConfirmed === true && pendingSummaryFloorIds.length
      && pendingSummaryFloorIds.every(floorId => coveredFloorIds.has(floorId))) return [];
    const memory = (() => { try { return typeof memoryStatus === 'function' ? memoryStatus() : memoryStatus; } catch { return null; } })();
    if (memory?.lastAutoMemory?.status === 'failed') return ['memoryNotReady', 'memoryRebuildFailed'];
    return ['memoryNotReady', 'historicalRebuildRequired'];
  };
  async function preparedSource(snapshot, sanitizerSnapshot, { fresh = false } = {}) {
    if (typeof prepareMemory === 'function') {
      let timer = null;
      const timeout = Symbol('memoryPreparationTimeout');
      let prepared;
      try {
        prepared = await Promise.race([
          Promise.resolve().then(() => prepareMemory({ preferCached: !fresh })),
          new Promise(resolve => { timer = setTimeout(() => resolve(timeout), Math.max(1, Number(preparationTimeoutMs) || 5000)); }),
        ]);
      } catch (error) {
        return Object.freeze({ status: 'unavailable', blockGeneration: !fresh, error: clean(error?.message ?? '记忆准备失败。'), sourceReadAttempts: Object.freeze({ reachableReads: 0, exitPoint: 'memoryPreparationFailed' }) });
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
      if (prepared === timeout) return Object.freeze({ status: 'timeout', blockGeneration: !fresh, sourceReadAttempts: Object.freeze({ reachableReads: 0, exitPoint: 'memoryPreparationTimeout' }) });
      if (prepared?.status === 'ready' && prepared.reachable?.root) {
        return projectRecallSource(prepared.reachable, now, Object.freeze({ reachableReads: 0, exitPoint: 'validatedSnapshot' }), snapshot, sanitizerSnapshot, hasRealtimeOrigin());
      }
      const status = prepared?.status === 'error' ? 'unavailable' : prepared?.status ?? 'unavailable';
      return Object.freeze({ status, blockGeneration: !fresh && status !== 'uninitialized', sourceReadAttempts: Object.freeze({ reachableReads: 0, exitPoint: 'memoryPreparation' }) });
    }
    return sourceReader({ store, now, hostSnapshot: snapshot, sanitizerOptions: sanitizerSnapshot, realtimeOrigin: hasRealtimeOrigin() });
  }
  const notify = () => { const state = getState(); for (const listener of subscribers) { try { listener(state); } catch { /* listener isolation */ } } return state; };
  const prompt = (value, owner = null, checkedContext = null) => {
    const context = checkedContext ?? hostAdapter.snapshot().context;
    const setter = context?.setExtensionPrompt;
    if (typeof setter !== 'function') throw Object.assign(new Error('宿主不支持 setExtensionPrompt。'), { code: 'V3_RECALL_PROMPT_UNAVAILABLE' });
    const position = context.constants?.promptTypes?.IN_CHAT ?? 1;
    const role = context.constants?.promptRoles?.SYSTEM ?? 0;
    setter(RECALL_PROMPT_SLOT, String(value ?? ''), position, 1, false, role);
    slotOwner = value ? owner : null;
  };
  const clearSlot = owner => {
    if (owner !== undefined && slotOwner !== null && slotOwner !== owner) return false;
    try { prompt('', null); return true; }
    catch (error) { logger?.warn?.('[qianqianjie] V3 recall prompt cleanup failed', { code: error?.code ?? error?.name ?? 'V3_RECALL_CLEAR_FAILED' }); return false; }
  };
  const sessionKey = ({ source, userIndex, userFingerprint, queryFingerprint }) => [source.chatId, source.narrativeGeneration, source.headCheckpointId, source.rootRevision, userIndex, userFingerprint, queryFingerprint, source.bodyMatch?.fingerprint ?? ''].join('|');

  const bindLastRecall = (snapshot, user) => {
    lastRecallBinding = snapshot && user ? Object.freeze({ chatId: currentChatId(snapshot), userMessageIndex: user.index, message: user.message, text: user.message.mes }) : null;
  };
  const bindOperationRecall = operation => {
    lastRecallBinding = operation?.user ? Object.freeze({ chatId: operation.chatId, userMessageIndex: operation.user.index, message: operation.user.message, text: operation.userText }) : null;
  };
  const abortReason = operation => {
    const reason = operation?.controller?.signal?.reason;
    return FINAL_REASONS.has(reason) ? reason : operation?.token !== epoch ? 'superseded' : 'narrativeChanged';
  };

  function getState() {
    return Object.freeze({
      recallStatus: active ? 'running' : lastRecall?.status ?? (lastError ? 'error' : 'idle'),
      activeRecall: active ? Object.freeze({ token: active.token, generationType: active.type, phase: active.phase, chatId: active.chatId ?? null, userMessageIndex: active.user?.index ?? null }) : null,
      lastRecall,
      lastRecallBinding: lastRecallBinding ? Object.freeze({ chatId: lastRecallBinding.chatId, userMessageIndex: lastRecallBinding.userMessageIndex }) : null,
      lastRecallError: lastError,
    });
  }

  async function persistReceipt(snapshot, user, receipt) {
    const context = snapshot.context;
    if (typeof context?.saveChat !== 'function') return 'sessionOnly';
    const currentExtra = user.message.extra && typeof user.message.extra === 'object' && !Array.isArray(user.message.extra) ? user.message.extra : {};
    const hadPrevious = Object.hasOwn(currentExtra, RECALL_RECEIPT_KEY);
    const previousReceipt = currentExtra[RECALL_RECEIPT_KEY];
    const candidate = clone(receipt);
    user.message.extra = { ...currentExtra, [RECALL_RECEIPT_KEY]: candidate };
    try { await context.saveChat(); return 'persisted'; }
    catch (error) {
      const latestExtra = user.message.extra;
      if (latestExtra && typeof latestExtra === 'object' && !Array.isArray(latestExtra) && latestExtra[RECALL_RECEIPT_KEY] === candidate) {
        const rolledBack = { ...latestExtra };
        if (hadPrevious) rolledBack[RECALL_RECEIPT_KEY] = previousReceipt;
        else delete rolledBack[RECALL_RECEIPT_KEY];
        user.message.extra = rolledBack;
      }
      logger?.warn?.('[qianqianjie] V3 recall receipt persistence failed', { code: error?.code ?? error?.name ?? 'V3_RECALL_RECEIPT_SAVE_FAILED' });
      return 'sessionOnly';
    }
  }

  function receiptCandidates(user, key) {
    const stored = user.message.extra?.[RECALL_RECEIPT_KEY];
    const session = sessionReceipt?.key === key ? sessionReceipt.receipt : null;
    return [stored, session].filter((value, index, values) => value && typeof value === 'object' && values.indexOf(value) === index);
  }

  async function commitPromptIfCurrent({ operation, source, selectedFloors, selectedStates, userIndex, userFingerprint, hostGuard, injectionText }) {
    if (operation.token !== epoch || operation.controller.signal.aborted) return { ok: false, reason: abortReason(operation) };
    const before = hostAdapter.snapshot();
    const beforeUser = latestUser(before);
    if (currentChatId(before) !== source.chatId) return { ok: false, reason: 'chatChanged' };
    if (beforeUser?.index !== userIndex || beforeUser?.message !== hostGuard.userMessage) return { ok: false, reason: 'userChanged' };
    if (beforeUser.message.mes !== hostGuard.userText) return { ok: false, reason: 'userChanged' };
    if (liveRecallFrameKey(before) !== operation.liveFrameKey) return { ok: false, reason: 'narrativeChanged' };
    const currentUserFingerprint = await fingerprint(beforeUser.message.mes);
    if (currentUserFingerprint !== userFingerprint) return { ok: false, reason: 'userChanged' };
    if (operation.token !== epoch || operation.controller.signal.aborted) return { ok: false, reason: abortReason(operation) };
      const enforceReadiness = source.readiness !== null && source.readiness !== undefined;
      const canReadRoot = typeof store.readRoot === 'function';
      const rootResult = canReadRoot ? await store.readRoot() : null;
      let currentSource = source;
      const sameRoot = rootResult?.status === 'ready'
        && rootResult.revision === source.rootRevision
        && rootResult.data?.chatId === source.chatId
        && rootResult.data?.narrativeGeneration === source.narrativeGeneration
        && rootResult.data?.headCheckpointId === source.headCheckpointId;
      if (!sameRoot) {
        if (canReadRoot) currentSource = await preparedSource(enforceReadiness ? before : null, currentSanitizerOptions(), { fresh: true });
        else {
          const reachable = await store.readReachable({ mode: 'projection' });
          currentSource = ['ready', 'needsReseal'].includes(reachable?.status) && reachable?.root
            ? await projectRecallSource(reachable, now, null, enforceReadiness ? before : null, currentSanitizerOptions(), hasRealtimeOrigin())
            : Object.freeze({ status: reachable?.status === 'stale' ? 'stale' : 'unavailable' });
        }
        if (currentSource?.status !== 'ready') return { ok: false, reason: currentSource?.status === 'stale' ? 'sourceStale' : 'sourceUnavailable' };
        if (currentSource.chatId !== source.chatId) return { ok: false, reason: 'chatChanged' };
        if (currentSource.narrativeGeneration !== source.narrativeGeneration) return { ok: false, reason: 'narrativeChanged' };
        currentSource = Object.freeze({ ...currentSource, bodyMatch: await attachCoreBodyMatch(currentSource, operation.coreBodyWitness, before, operation.sanitizerOptions, fingerprint) });
      }
    if (!sourceRefsValid({ selectedFloors, selectedStates }, currentSource)) return { ok: false, reason: 'selectedRefsChanged' };
    const notReady = enforceReadiness ? readinessReasons(currentSource) : [];
    if (notReady.length) return { ok: false, notReady: true, reasons: notReady };
    const bodyGuardSanitizer = currentSanitizerOptions();
    const coveredBodyGuards = await captureCoveredBodyGuards(source, currentSource, before, bodyGuardSanitizer, fingerprint);
    if (coveredBodyGuards === null) return { ok: false, reason: 'narrativeChanged' };
    if (operation.token !== epoch || operation.controller.signal.aborted) return { ok: false, reason: abortReason(operation) };
    // This is the final synchronous commit point. No promise/microtask boundary may be
    // inserted between the host-visible snapshot checks and setExtensionPrompt.
    const after = hostAdapter.snapshot();
    const afterUser = latestUser(after);
    const current = operation.token === epoch
      && !operation.controller.signal.aborted
      && currentChatId(after) === source.chatId
      && afterUser?.index === userIndex
      && afterUser.message === hostGuard.userMessage
      && afterUser.message === beforeUser.message
      && afterUser.message.mes === hostGuard.userText
      && liveRecallFrameKey(after) === operation.liveFrameKey
      && coveredBodyGuardsCurrent(coveredBodyGuards, after, bodyGuardSanitizer);
    if (!current) {
      if (operation.token !== epoch || operation.controller.signal.aborted) return { ok: false, reason: abortReason(operation) };
      if (currentChatId(after) !== source.chatId) return { ok: false, reason: 'chatChanged' };
      if (afterUser?.index !== userIndex || afterUser?.message !== hostGuard.userMessage || afterUser?.message?.mes !== hostGuard.userText) return { ok: false, reason: 'userChanged' };
      return { ok: false, reason: 'narrativeChanged' };
    }
    const finalNotReady = enforceReadiness ? readinessReasons(currentSource) : [];
    if (finalNotReady.length) return { ok: false, notReady: true, reasons: finalNotReady };
    if (enforceReadiness && !coverageHostGuardCurrent(currentSource.readiness, after)) {
      return { ok: false, notReady: true, reasons: ['memoryNotReady', 'coverageUnconfirmed'] };
    }
    if (injectionText) prompt(injectionText, operation.token, after.context);
    return { ok: true, snapshot: after, user: afterUser };
  }

  async function intercept(coreChat, contextSize, abort, rawType) {
    const token = ++epoch;
    active?.controller.abort('superseded');
    clearSlot();
    const type = SUPPORTED_TYPES.has(rawType) ? rawType : rawType === undefined ? 'normal' : String(rawType ?? 'normal');
    const lifecycle = generationQueue.find(value => value.token === null && value.type === type);
    if (lifecycle) lifecycle.token = token;
    const operation = { token, type, phase: 'input', controller: new AbortController(), started: Date.now() };
    lastRecall = null; lastRecallBinding = null;
    active = operation; lastError = null; notify();
    const timings = {};
    const stopForMemoryReadiness = reasons => {
      if (typeof abort === 'function') abort(true);
      try { notifyUser?.({ kind: 'error', text: '当前聊天记忆尚未准备完成，本次生成已停止；用户输入仍保留，请在记忆管理中查看状态后重试。' }); } catch { /* notification must not affect the gate */ }
      return finishSkipped(operation, reasons, timings);
    };
    const stopForFinalSafety = reason => {
      if (!['chatChanged', 'userChanged', 'stopped', 'superseded', 'disabled'].includes(reason)) {
        if (typeof abort === 'function') abort(true);
        try { notifyUser?.({ kind: 'error', text: '生成前的记忆最终核验未通过，本次生成已停止；用户输入仍保留，请稍后重试。' }); } catch { /* notification must not affect the gate */ }
      }
      return finishStale(operation, timings, reason);
    };
    try {
      if (lifecycle?.stopped) return finishStale(operation, timings, 'stopped');
      if (!enabled()) return finishSkipped(operation, 'disabled', timings);
      if (!SUPPORTED_TYPES.has(type)) return finishSkipped(operation, ['quiet', 'impersonate'].includes(type) ? type : 'unsupportedGenerationType', timings);
      const before = hostAdapter.snapshot();
      const user = latestUser(before);
      if (!user) return finishSkipped(operation, 'emptyUserInput', timings);
      operation.user = user;
      operation.chatId = currentChatId(before);
      operation.userText = user.message.mes;
      operation.liveFrameKey = liveRecallFrameKey(before);
      const sanitizerSnapshot = currentSanitizerOptions();
      const coreInput = Array.isArray(coreChat) ? coreChat : [];
      const queryContext = queryBuilder({ coreChat: coreInput, assistantTurns: 1 });
      const coreBodyWitness = await captureCoreBodyWitness(coreInput, sanitizerSnapshot, fingerprint);
      operation.coreBodyWitness = coreBodyWitness;
      operation.sanitizerOptions = sanitizerSnapshot;
      coreChat = null;
      const hostGuard = { userMessage: user.message, userText: user.message.mes };
      if (!queryContext.latestUserText) return finishSkipped(operation, 'emptyUserInput', timings);
      const inputStarted = Date.now();
      const [userFingerprint, queryFingerprint] = await Promise.all([fingerprint(user.message.mes), fingerprint(queryContext.text)]);
      timings.inputMs = Date.now() - inputStarted;
      operation.phase = 'source'; notify();
      const sourceStarted = Date.now();
      const readSource = await preparedSource(before, sanitizerSnapshot);
      const source = readSource?.status === 'ready'
        ? Object.freeze({ ...readSource, bodyMatch: await attachCoreBodyMatch(readSource, coreBodyWitness, before, sanitizerSnapshot, fingerprint) })
        : readSource;
      timings.sourceMs = Date.now() - sourceStarted;
      if (source?.sourceReadAttempts) timings.sourceReadAttempts = clone(source.sourceReadAttempts);
      if (source.status !== 'ready') {
        if (source.blockGeneration && SUPPORTED_TYPES.has(type)) {
          if (typeof abort === 'function') abort(true);
          const timeout = source.status === 'timeout';
          try { notifyUser?.({ kind: 'error', text: timeout ? '当前聊天记忆在 5 秒内未准备完成，本次生成已停止；用户输入仍保留，请稍后重试。' : `当前聊天记忆读取失败，本次生成已停止；用户输入仍保留。${source.error ? ` ${source.error}` : ''}` }); } catch { /* notification must not affect the gate */ }
          return finishSkipped(operation, timeout ? 'memoryPreparationTimeout' : 'memoryPreparationFailed', timings);
        }
        return finishSkipped(operation, source.status === 'stale' ? 'sourceStale' : 'sourceUnavailable', timings);
      }
      const notReady = readinessReasons(source);
      if (notReady.length) return stopForMemoryReadiness(notReady);
      const afterSource = hostAdapter.snapshot();
      const afterUser = latestUser(afterSource);
      if (token !== epoch || operation.controller.signal.aborted) return finishStale(operation, timings);
      if (currentChatId(afterSource) !== source.chatId) return finishStale(operation, timings, 'chatChanged');
      if (afterUser?.index !== user.index || afterUser?.message !== hostGuard.userMessage || await fingerprint(afterUser?.message?.mes) !== userFingerprint) return finishStale(operation, timings, 'userChanged');
      const key = sessionKey({ source, userIndex: user.index, userFingerprint, queryFingerprint });
      if (sessionReceipt?.key !== key) sessionReceipt = null;
      if (REUSE_TYPES.has(type)) {
        let candidate = null;
        for (const value of receiptCandidates(afterUser, key)) {
          const snapshot = await receiptValid(value, { source, userIndex: user.index, userFingerprint, queryFingerprint, pluginVersion }, fingerprint);
          if (snapshot) { candidate = snapshot; break; }
        }
        if (candidate) {
          const committed = await commitPromptIfCurrent({ operation, source, selectedFloors: candidate.selectedFloors, selectedStates: candidate.selectedStates, userIndex: user.index, userFingerprint, hostGuard, injectionText: candidate.injectionText });
          if (!committed.ok) return committed.notReady ? stopForMemoryReadiness(committed.reasons) : stopForFinalSafety(committed.reason);
          if (token !== epoch || operation.controller.signal.aborted) return finishStale(operation, timings);
          timings.totalMs = Date.now() - operation.started;
          lastRecall = stateFromReceipt(candidate, { generationType: type, timings }); bindLastRecall(committed.snapshot, committed.user); lastError = null; active = null; notify(); return getState();
        }
      }
      operation.phase = 'selecting'; notify();
      const selectorStarted = Date.now();
      const selection = await selectionRunner({ source, queryContext, contextSize, signal: operation.controller.signal });
      timings.selectorMs = Date.now() - selectorStarted;
      if (token !== epoch || operation.controller.signal.aborted) return finishStale(operation, timings);
      const receiptBase = {
        schemaVersion: RECALL_RECEIPT_SCHEMA_VERSION,
        pluginVersion,
        chatId: source.chatId,
        narrativeGeneration: source.narrativeGeneration,
        headCheckpointId: source.headCheckpointId,
        rootRevision: source.rootRevision,
        userMessageIndex: user.index,
        userContentFingerprint: userFingerprint,
        queryFingerprint,
        bodyMatchFingerprint: source.bodyMatch.fingerprint,
        strategyVersion: RECALL_STRATEGY_VERSION,
        generationType: type,
        selectedFloors: selection.floors.map(value => ({ floorId: value.floorId, floorMemoryId: value.floorMemoryId, assistantSeq: value.assistantSeq, reasons: [...value.reasons] })),
        selectedStates: selection.states.map(value => ({ subjectEntityId: value.subjectEntityId, subject: value.subject, layer: value.layer, towardEntityId: value.towardEntityId, toward: value.toward, text: value.text, reason: value.reason, visibility: value.visibility, sourceAssistantSeq: value.sourceAssistantSeq })),
        coverage: clone(selection.coverage ?? source.coverage),
        injectionText: selection.injectionText,
        stages: clone(selection.stages ?? null),
        skipReasons: [...(selection.skipReasons ?? [])],
        createdAt: nowIso(now),
      };
      receiptBase.completionStatus = receiptBase.injectionText ? 'ready' : 'empty';
      const committed = await commitPromptIfCurrent({ operation, source, selectedFloors: receiptBase.selectedFloors, selectedStates: receiptBase.selectedStates, userIndex: user.index, userFingerprint, hostGuard, injectionText: receiptBase.injectionText });
      if (!committed.ok) return committed.notReady ? stopForMemoryReadiness(committed.reasons) : stopForFinalSafety(committed.reason);
      if (token !== epoch || operation.controller.signal.aborted) return finishStale(operation, timings);
      if (receiptBase.skipReasons.includes('historySelectionFallback')) {
        try { notifyUser?.({ kind: 'warning', text: '历史智能选材暂时不可用，本次已使用本地关键词召回。' }); } catch { /* notification must not affect recall */ }
      }
      const sealedReceipt = Object.freeze({ ...receiptBase, receiptFingerprint: await fingerprint(JSON.stringify(receiptMaterial(receiptBase))) });
      if (token !== epoch || operation.controller.signal.aborted) return finishStale(operation, timings);
      operation.phase = 'receipt'; notify();
      const sessionCandidate = Object.freeze({ key, receipt: Object.freeze({ ...sealedReceipt, receiptPersistence: 'sessionOnly' }) });
      sessionReceipt = sessionCandidate;
      const receiptStarted = Date.now();
      const receiptPersistence = await persistReceipt(committed.snapshot, committed.user, sealedReceipt);
      timings.receiptMs = Date.now() - receiptStarted;
      const receipt = Object.freeze({ ...sealedReceipt, receiptPersistence });
      if (sessionReceipt === sessionCandidate) {
        sessionReceipt = receiptPersistence === 'persisted' ? null : Object.freeze({ key, receipt });
      }
      if (token !== epoch || operation.controller.signal.aborted) return finishStale(operation, timings);
      timings.totalMs = Date.now() - operation.started;
      lastRecall = Object.freeze({ status: receipt.completionStatus, userMessageIndex: user.index, generationType: type, coverage: receipt.coverage, selectedFloors: Object.freeze(clone(receipt.selectedFloors)), selectedStates: Object.freeze(clone(receipt.selectedStates)), injectionText: receipt.injectionText, reusedReceipt: false, restoredReceipt: false, receiptPersistence, stages: receipt.stages, timings: Object.freeze({ ...timings }), skipReasons: Object.freeze([...receipt.skipReasons]), error: null, createdAt: receipt.createdAt });
      bindLastRecall(committed.snapshot, committed.user);
      lastError = null; active = null; notify(); return getState();
    } catch (error) {
      if (token !== epoch || operation.controller.signal.aborted) return finishStale(operation, timings);
      clearSlot(token);
      const safe = Object.freeze({ code: clean(error?.code ?? error?.name ?? 'V3_RECALL_FAILED', 120), message: clean(error?.message ?? '召回失败，已安全跳过。', 500) });
      lastError = safe;
      lastRecall = Object.freeze({ status: 'error', userMessageIndex: null, generationType: type, coverage: null, selectedFloors: Object.freeze([]), selectedStates: Object.freeze([]), injectionText: '', reusedReceipt: false, restoredReceipt: false, receiptPersistence: 'none', stages: null, timings: Object.freeze({ ...timings, totalMs: Date.now() - operation.started }), skipReasons: Object.freeze(['error']), error: safe, createdAt: nowIso(now) });
      bindOperationRecall(operation);
      active = null; logger?.warn?.('[qianqianjie] V3 recall failed open', { code: safe.code }); notify(); return getState();
    }
  }

  function finishSkipped(operation, reason, timings) {
    if (operation.token !== epoch) return finishStale(operation, timings);
    timings.totalMs = Date.now() - operation.started;
    const reasons = Array.isArray(reason) ? reason : [reason];
    lastRecall = Object.freeze({ status: 'skipped', userMessageIndex: operation.user?.index ?? null, generationType: operation.type, coverage: null, selectedFloors: Object.freeze([]), selectedStates: Object.freeze([]), injectionText: '', reusedReceipt: false, restoredReceipt: false, receiptPersistence: 'none', stages: null, timings: Object.freeze({ ...timings }), skipReasons: Object.freeze([...reasons]), error: null, createdAt: nowIso(now) });
    bindOperationRecall(operation);
    active = null; notify(); return getState();
  }

  function finishStale(operation, timings, reason = abortReason(operation)) {
    if (active === operation) active = null;
    if (operation.token === epoch) {
      clearSlot(operation.token);
      lastRecall = Object.freeze({ status: 'stale', userMessageIndex: operation.user?.index ?? null, generationType: operation.type, coverage: null, selectedFloors: Object.freeze([]), selectedStates: Object.freeze([]), injectionText: '', reusedReceipt: false, restoredReceipt: false, receiptPersistence: 'none', stages: null, timings: Object.freeze({ ...timings, totalMs: Date.now() - operation.started }), skipReasons: Object.freeze([FINAL_REASONS.has(reason) ? reason : 'narrativeChanged']), error: null, createdAt: nowIso(now) });
      bindOperationRecall(operation);
      notify();
    }
    return getState();
  }

  function invalidate(reason = 'invalidated') {
    epoch += 1; active?.controller.abort(FINAL_REASONS.has(reason) ? reason : 'superseded'); active = null; sessionReceipt = null; generationQueue.length = 0; stoppedEndDebt = 0; clearSlot();
    lastRecall = null; lastRecallBinding = null; lastError = null; notify();
  }

  function onGenerationStarted(type, _params, dryRun) {
    if (dryRun === true) return;
    const generationType = String(type ?? 'normal');
    const previous = generationQueue.at(-1);
    const chainId = generationType === 'continue' && previous && !previous.stopped ? previous.chainId : ++generationSerial;
    generationQueue.push({ token: null, type: generationType, chainId, stopped: false });
  }
  function cancelGenerationOperation(generation, reason = 'stopped') {
    if (!generation || active?.token !== generation.token) return false;
    const operation = active;
    epoch += 1;
    active.controller.abort(reason);
    active = null;
    if (slotOwner === generation.token) clearSlot(generation.token);
    lastRecall = Object.freeze({ status: 'stale', userMessageIndex: operation.user?.index ?? null, generationType: operation.type, coverage: null, selectedFloors: Object.freeze([]), selectedStates: Object.freeze([]), injectionText: '', reusedReceipt: false, restoredReceipt: false, receiptPersistence: 'none', stages: null, timings: Object.freeze({ totalMs: Date.now() - operation.started }), skipReasons: Object.freeze([reason]), error: null, createdAt: nowIso(now) });
    bindOperationRecall(operation);
    notify();
    return true;
  }
  function onGenerationStopped() {
    const generation = [...generationQueue].reverse().find(value => value.token === active?.token)
      ?? [...generationQueue].reverse().find(value => value.token === slotOwner)
      ?? generationQueue.at(-1);
    if (!generation) { if (slotOwner !== null) clearSlot(slotOwner); return; }
    if (!cancelGenerationOperation(generation) && slotOwner === generation.token) clearSlot(generation.token);
    for (const value of generationQueue) if (value.chainId === generation.chainId) value.stopped = true;
    const stoppedChainIds = [...new Set(generationQueue.filter(value => value.stopped).map(value => value.chainId))];
    while (stoppedChainIds.length > MAX_STOPPED_GENERATION_CHAINS) {
      const obsolete = stoppedChainIds.shift();
      for (let index = generationQueue.length - 1; index >= 0; index -= 1) if (generationQueue[index].chainId === obsolete) generationQueue.splice(index, 1);
      stoppedEndDebt = Math.min(Number.MAX_SAFE_INTEGER, stoppedEndDebt + 1);
    }
  }
  function onGenerationEnded() {
    if (stoppedEndDebt > 0) { stoppedEndDebt -= 1; return; }
    const first = generationQueue[0];
    const chain = first ? generationQueue.filter(value => value.chainId === first.chainId) : [];
    const generation = chain.at(-1) ?? null;
    if (first) for (let index = generationQueue.length - 1; index >= 0; index -= 1) if (generationQueue[index].chainId === first.chainId) generationQueue.splice(index, 1);
    if (generation?.stopped) return;
    if (cancelGenerationOperation(generation)) return;
    if (generation && slotOwner === generation.token) clearSlot(generation.token);
    else if (!generation && slotOwner !== null && !active) clearSlot(slotOwner);
  }

  function bind({ eventSource, eventTypes = {} } = {}) {
    if (!eventSource?.on) return;
    const on = (name, handler) => { const event = eventTypes[name]; if (event) eventSource.on(event, handler); };
    on('GENERATION_STARTED', onGenerationStarted);
    on('GENERATION_STOPPED', onGenerationStopped);
    on('GENERATION_ENDED', onGenerationEnded);
    on('CHAT_CHANGED', () => invalidate('chatChanged'));
    on('CHAT_RENAMED', () => invalidate('chatChanged'));
    for (const name of ['MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED']) on(name, () => {
      const current = hostAdapter.snapshot();
      const user = latestUser(current);
      const parentChanged = Boolean(lastRecallBinding) && (
        currentChatId(current) !== lastRecallBinding.chatId
        || user?.message !== lastRecallBinding.message
        || user?.message?.mes !== lastRecallBinding.text
      );
      let activeReason = null;
      if (active) {
        if (currentChatId(current) !== active.chatId) activeReason = 'chatChanged';
        else if (user?.message !== active.user?.message || user?.message?.mes !== active.userText) activeReason = 'userChanged';
        else if (liveRecallFrameKey(current) !== active.liveFrameKey) activeReason = 'narrativeChanged';
      }
      if (!parentChanged && !activeReason) return;
      epoch += 1;
      if (activeReason) {
        active.controller.abort(activeReason);
        active = null;
        sessionReceipt = null;
      }
      clearSlot();
      if (parentChanged) { sessionReceipt = null; lastRecall = null; lastRecallBinding = null; lastError = null; }
      notify();
    });
  }

  async function restorePersistedReceipt() {
    try {
      const restoreEpoch = epoch;
      if (!enabled() || active || lastRecall) return getState();
      const before = hostAdapter.snapshot();
      const user = latestUser(before);
      const chatId = currentChatId(before);
      const receipt = user?.message?.extra?.[RECALL_RECEIPT_KEY];
      if (!user || !chatId || !receipt || typeof receipt !== 'object') return getState();
      const messageText = user.message.mes;
      const persistedUserFingerprint = await fingerprint(messageText);
      let receiptSnapshot = receipt.schemaVersion === RECALL_RECEIPT_SCHEMA_VERSION
        ? await persistedReceiptValid(receipt, { chatId, userIndex: user.index, userFingerprint: persistedUserFingerprint, pluginVersion }, fingerprint)
        : null;
      if (!receiptSnapshot && [6, 7, 8].includes(receipt.schemaVersion)) {
        const historical = await historicalSignedReceiptValid(receipt, { chatId, userIndex: user.index, userFingerprint: persistedUserFingerprint }, fingerprint);
        if (historical) receiptSnapshot = Object.freeze({ ...stateFromReceipt(historical, { restoredReceipt: true }), legacyReadOnly: true });
      }
      if (!receiptSnapshot) receiptSnapshot = legacyStateFromReceipt(receipt, { chatId, userIndex: user.index });
      if (!receiptSnapshot) return getState();
      const after = hostAdapter.snapshot();
      const afterUser = latestUser(after);
      if (restoreEpoch !== epoch || active || lastRecall
        || currentChatId(after) !== chatId
        || afterUser?.index !== user.index
        || afterUser.message !== user.message
        || afterUser.message.extra?.[RECALL_RECEIPT_KEY] !== receipt
        || afterUser.message.mes !== messageText) return getState();
      lastRecall = receiptSnapshot.legacyReadOnly ? receiptSnapshot : stateFromReceipt(receiptSnapshot, { restoredReceipt: true });
      bindLastRecall(after, afterUser);
      lastError = null;
      notify();
      return getState();
    } catch (error) {
      logger?.warn?.('[qianqianjie] V3 persisted recall receipt ignored', { code: clean(error?.code ?? error?.name ?? 'V3_RECALL_RECEIPT_RESTORE_FAILED', 120) });
      return getState();
    }
  }

  async function setEnabled(value) { enabledOverride = value === true; if (!enabledOverride) invalidate('disabled'); return getState(); }
  function clearCurrent() { clearSlot(); lastRecall = null; lastRecallBinding = null; lastError = null; notify(); return getState(); }
  return Object.freeze({ intercept, bind, setEnabled, clearCurrent, restorePersistedReceipt, getState, invalidate, subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); } });
}
