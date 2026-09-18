import { sha256 } from '../identity.js';
import { sanitizeSensitiveText, sanitizeTaskMetadata } from './safe-metadata.js';
import { projectRecallSource, readRecallSource } from './recall-source.js';
import { buildRecallQueryContext, buildRecallQueryFrame, formatRecallInjection, estimateRecallTokens } from './recall-selector.js';
import { selectRecallWithLlm } from './recall-llm-selector.js';
import { selectAssistantMessage } from './foundation-domain.js';
import { inspectMessageFloorAnchor } from './message-floor-anchor.js';
import { sanitizeMemoryContent } from '../memory-content-sanitizer.js';
import { PREQUEL_METADATA_KEY, PREQUEL_PROMPT_SLOT, selectPrequel } from './recall-prequel.js';
import { publicErrorMessage } from '../public-error.js';

export const RECALL_PROMPT_SLOT = 'qqj_v3_recalled_context';
export const RECALL_RECEIPT_KEY = 'qqj_v3_recall_receipt';
export const RECALL_RECEIPT_SCHEMA_VERSION = 15;
export const RECALL_STRATEGY_VERSION = 'continuity-v15';
const RECALL_PROMPT_DEPTH = 2;
const IDENTIFIED_RECALL_STRATEGIES = [RECALL_STRATEGY_VERSION, 'continuity-v14', 'continuity-v13', 'continuity-v12', 'continuity-v11'];

const SUPPORTED_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue']);
const REUSE_TYPES = new Set(['regenerate', 'swipe', 'continue']);
const MAX_STOPPED_GENERATION_CHAINS = 16;
const MAX_RECEIPT_FLOORS = 256;
const MAX_RECEIPT_STATES = 256;
const MAX_RECEIPT_CSE_CHANGES = 256;
const MAX_RECEIPT_STORYLINES = 256;
const LEGACY_MAX_RECEIPT_FLOORS = 48;
const LEGACY_MAX_RECEIPT_STATES = 24;
const LEGACY_MAX_RECEIPT_CSE_CHANGES = 24;
const LEGACY_MAX_RECEIPT_STORYLINES = 4;
const MAX_RECEIPT_STATE_PROGRESSIONS = 8;
const MAX_RECEIPT_SKIP_REASONS = 32;
const nowIso = now => { const value = now()?.toISOString?.() ?? String(now()); if (!Number.isFinite(Date.parse(value))) throw new TypeError('V3_RECALL_TIME_INVALID'); return value; };
const clean = (value, maximum = 500) => sanitizeSensitiveText(String(value ?? '')).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);
const clone = value => structuredClone(value);
const hashText = async value => `sha256:${await sha256(String(value ?? ''))}`;
const currentChatId = snapshot => String(snapshot?.context?.chatMetadata?.qianqianjie?.chatId ?? '').trim();
const currentHostChatId = snapshot => String(snapshot?.chatId ?? snapshot?.context?.chatId ?? snapshot?.context?.getCurrentChatId?.() ?? '').trim();
const currentPrequelText = snapshot => typeof snapshot?.context?.chatMetadata?.[PREQUEL_METADATA_KEY] === 'string' ? snapshot.context.chatMetadata[PREQUEL_METADATA_KEY] : '';
const isPlayableUser = message => message && message.is_user === true && message.is_system !== true && typeof message.mes === 'string' && message.mes.trim();
const FINAL_REASONS = new Set(['chatChanged', 'userChanged', 'narrativeChanged', 'selectedRefsChanged', 'sourceStale', 'sourceUnavailable', 'stopped', 'superseded', 'disabled']);

function latestUser(snapshot) {
  const chat = snapshot?.chat ?? [];
  for (let index = chat.length - 1; index >= 0; index -= 1) if (isPlayableUser(chat[index])) return { index, message: chat[index] };
  return null;
}

const liveRecallFrameKey = snapshot => JSON.stringify(buildRecallQueryFrame({ coreChat: snapshot?.chat, assistantTurns: 1 }).messages.map(message => [message.role, message.text]));

function sourceRefsValid(receipt, source) {
  if (!Array.isArray(source?.floorMemories) || !Array.isArray(source?.currentState) || !Array.isArray(receipt?.selectedFloors) || !Array.isArray(receipt?.selectedStates) || !Array.isArray(receipt?.selectedCseChanges)) return false;
  const sourceChanges = Array.isArray(source.cseChanges) ? source.cseChanges : [];
  const memories = new Map(source.floorMemories.map(memory => [`${memory.floorId}|${memory.floorMemoryId}|${memory.assistantSeq}`, memory]));
  if (!receipt.selectedFloors.every(value => value && typeof value === 'object' && memories.has(`${value.floorId}|${value.floorMemoryId}|${value.assistantSeq}`))) return false;
  const subjects = new Map(source.currentState.map(subject => [subject.subjectEntityId, subject]));
  if (!receipt.selectedStates.every(value => {
    if (!value || typeof value !== 'object' || !['core', 'adaptive', 'situational'].includes(value.layer)) return false;
    const subject = subjects.get(value.subjectEntityId);
    return Array.isArray(subject?.[value.layer]) && subject[value.layer].some(item => (
      item.text === value.text && item.visibility === value.visibility && item.reason === value.reason
      && item.towardEntityId === (value.towardEntityId ?? null) && item.sourceAssistantSeq === (value.sourceAssistantSeq ?? null)
      && (!value.stateId || (item.stateId === value.stateId && (item.sourceFloorId ?? null) === (value.sourceFloorId ?? null) && (item.sourceDeltaId ?? null) === (value.sourceDeltaId ?? null)))
    ));
  })) return false;
  const stateEqual = (left, right) => left === null ? right === null : Boolean(right
    && left.text === right.text && left.visibility === right.visibility && left.reason === right.reason
    && left.origin === right.origin && (left.towardEntityId ?? null) === (right.towardEntityId ?? null)
    && (left.sourceAssistantSeq ?? null) === (right.sourceAssistantSeq ?? null)
    && (!left.stateId || (left.stateId === right.stateId && (left.sourceFloorId ?? null) === (right.sourceFloorId ?? null) && (left.sourceDeltaId ?? null) === (right.sourceDeltaId ?? null))));
  const entityNames = new Map((source.entities ?? []).map(entity => [entity.entityId, entity.displayName]));
  return receipt.selectedCseChanges.every(value => value.subject === entityNames.get(value.subjectEntityId) && sourceChanges.some(change => change.deltaId === value.deltaId
    && change.floorId === value.floorId && change.assistantSeq === value.assistantSeq
    && change.subjectEntityId === value.subjectEntityId && change.layer === value.layer && change.action === value.action
    && stateEqual(value.before, change.before) && stateEqual(value.after, change.after)));
}

function selectedSourceFloorIds({ selectedFloors = [], selectedStates = [], selectedCseChanges = [] }, source) {
  const floorIds = new Set();
  const deltaFloorIds = new Map((source?.cseChanges ?? []).map(change => [change.deltaId, change.floorId]));
  const memoriesByAnchor = new Map((source?.floorMemories ?? []).map(memory => [memory.floorId, memory]));
  const memoriesByRef = new Map((source?.floorMemories ?? []).map(memory => [`${memory.floorId}|${memory.floorMemoryId}`, memory]));
  const addMemory = memory => {
    for (const floorId of memory?.sourceFloorIds?.length ? memory.sourceFloorIds : [memory?.floorId]) {
      if (typeof floorId === 'string' && floorId) floorIds.add(floorId);
    }
  };
  const addFloor = value => {
    if (typeof value !== 'string' || !value) return;
    floorIds.add(value);
    addMemory(memoriesByAnchor.get(value));
  };
  const addDelta = value => addFloor(deltaFloorIds.get(value));
  for (const value of selectedFloors) {
    const memory = memoriesByRef.get(`${value?.floorId}|${value?.floorMemoryId}`);
    if (memory) addMemory(memory); else addFloor(value?.floorId);
  }
  for (const value of selectedStates) { addFloor(value?.sourceFloorId); addDelta(value?.sourceDeltaId); }
  for (const value of selectedCseChanges) {
    addFloor(value?.floorId);
    addFloor(value?.before?.sourceFloorId); addDelta(value?.before?.sourceDeltaId);
    addFloor(value?.after?.sourceFloorId); addDelta(value?.after?.sourceDeltaId);
  }
  return floorIds;
}

function captureSelectedSourceGuards(receipt, source, snapshot) {
  if (source?.readiness?.hostConfirmed !== true) return Object.freeze([]);
  const expectedFloorIds = selectedSourceFloorIds(receipt, source);
  if (!expectedFloorIds.size) return Object.freeze([]);
  if (!Array.isArray(snapshot?.chat)) return null;
  const sourceRefs = new Map((source.bodyMatchRefs ?? []).map(ref => [ref.floorId, ref]));
  const guards = [];
  for (const floorId of expectedFloorIds) {
    const ref = sourceRefs.get(floorId);
    const messageIndex = ref?.hostLocator?.messageIndex;
    const message = Number.isSafeInteger(messageIndex) ? snapshot.chat[messageIndex] : null;
    const selected = selectAssistantMessage(message);
    if (!ref || !selected || selected.swipeId !== ref.hostLocator.swipeId
      || selected.selectedSwipeIndex !== ref.hostLocator.selectedSwipeIndex) return null;
    const anchor = inspectMessageFloorAnchor(message, source.chatId);
    if (anchor.status === 'valid' && anchor.anchor.floorId === floorId) {
      guards.push(Object.freeze({ mode: 'marker', floorId, message }));
    } else if (anchor.status === 'none') {
      guards.push(Object.freeze({ mode: 'locator', floorId, message, hostLocator: ref.hostLocator }));
    } else return null;
  }
  const markedFloorIds = new Set(guards.filter(guard => guard.mode === 'marker').map(guard => guard.floorId));
  if (markedFloorIds.size) {
    const counts = new Map([...markedFloorIds].map(floorId => [floorId, 0]));
    for (const message of snapshot.chat) {
      if (!selectAssistantMessage(message)) continue;
      const anchor = inspectMessageFloorAnchor(message, source.chatId);
      if (anchor.status === 'valid' && counts.has(anchor.anchor.floorId)) counts.set(anchor.anchor.floorId, counts.get(anchor.anchor.floorId) + 1);
    }
    if ([...counts.values()].some(count => count !== 1)) return null;
  }
  return Object.freeze(guards);
}

function selectedSourceGuardsCurrent(guards, chatId, snapshot) {
  if (!Array.isArray(guards) || !Array.isArray(snapshot?.chat)) return false;
  const markedFloorIds = new Set(guards.filter(guard => guard.mode === 'marker').map(guard => guard.floorId));
  const markerMatches = new Map([...markedFloorIds].map(floorId => [floorId, []]));
  if (markedFloorIds.size) {
    for (const message of snapshot.chat) {
      if (!selectAssistantMessage(message)) continue;
      const anchor = inspectMessageFloorAnchor(message, chatId);
      if (anchor.status === 'valid' && markerMatches.has(anchor.anchor.floorId)) markerMatches.get(anchor.anchor.floorId).push(message);
    }
  }
  return guards.every(guard => {
    if (guard.mode === 'marker') {
      const values = markerMatches.get(guard.floorId) ?? [];
      return values.length === 1 && values[0] === guard.message;
    }
    const message = snapshot.chat[guard.hostLocator.messageIndex];
    const selected = selectAssistantMessage(message);
    return message === guard.message && inspectMessageFloorAnchor(message, chatId).status === 'none'
      && selected?.swipeId === guard.hostLocator.swipeId
      && selected?.selectedSwipeIndex === guard.hostLocator.selectedSwipeIndex;
  });
}

const legacyReceiptMaterial = receipt => [
  receipt.schemaVersion, receipt.pluginVersion, receipt.chatId, receipt.narrativeGeneration, receipt.headCheckpointId, receipt.rootRevision,
  receipt.userMessageIndex, receipt.userContentFingerprint, receipt.queryFingerprint, receipt.generationType,
  receipt.selectedFloors, receipt.selectedStates, receipt.coverage, receipt.injectionText, receipt.stages, receipt.skipReasons, receipt.completionStatus, receipt.createdAt,
];
const receiptMaterial = receipt => receipt.schemaVersion >= 15 && receipt.qianshiProgress
  ? [...legacyReceiptMaterial(receipt), receipt.bodyMatchFingerprint, receipt.strategyVersion, receipt.selectedCseChanges, receipt.selectorDiagnostic, receipt.timings, receipt.storylines, receipt.timeDependencies, receipt.qianshiProgress]
  : receipt.schemaVersion >= 15
  ? [...legacyReceiptMaterial(receipt), receipt.bodyMatchFingerprint, receipt.strategyVersion, receipt.selectedCseChanges, receipt.selectorDiagnostic, receipt.timings, receipt.storylines, receipt.timeDependencies]
  : receipt.schemaVersion >= 14
  ? [...legacyReceiptMaterial(receipt), receipt.bodyMatchFingerprint, receipt.strategyVersion, receipt.selectedCseChanges, receipt.selectorDiagnostic, receipt.timings, receipt.storylines, receipt.stateProgressions, receipt.timeDependencies]
  : receipt.schemaVersion >= 13
  ? [...legacyReceiptMaterial(receipt), receipt.bodyMatchFingerprint, receipt.strategyVersion, receipt.selectedCseChanges, receipt.selectorDiagnostic, receipt.timings, receipt.storylines, receipt.stateProgressions]
  : receipt.schemaVersion >= 12
  ? [...legacyReceiptMaterial(receipt), receipt.bodyMatchFingerprint, receipt.strategyVersion, receipt.selectedCseChanges, receipt.selectorDiagnostic, receipt.timings, receipt.storylines]
  : receipt.schemaVersion >= 10
  ? [...legacyReceiptMaterial(receipt), receipt.bodyMatchFingerprint, receipt.strategyVersion, receipt.selectedCseChanges, receipt.selectorDiagnostic, receipt.timings]
  : receipt.schemaVersion >= 9 ? [...legacyReceiptMaterial(receipt), receipt.bodyMatchFingerprint, receipt.strategyVersion]
  : receipt.schemaVersion >= 8 ? [...legacyReceiptMaterial(receipt), receipt.bodyMatchFingerprint] : legacyReceiptMaterial(receipt);

const boundedString = (value, maximum, { empty = false } = {}) => typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
const optionalBoundedString = (value, maximum) => value === null || boundedString(value, maximum);
const nonNegativeInteger = value => Number.isSafeInteger(value) && value >= 0;
const optionalPositiveInteger = value => value === null || (Number.isSafeInteger(value) && value > 0);
const finiteDuration = value => Number.isFinite(value) && value >= 0;
function timeDependenciesValid(value, { correctionLimit = MAX_RECEIPT_STATES } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.mode === 'projection') return optionalBoundedString(value.fingerprint, 200);
  const itemValid = item => item && typeof item === 'object' && !Array.isArray(item)
    && boundedString(item.itemId, 500) && boundedString(item.text, 20000)
    && optionalBoundedString(item.sourceSignature, 20000);
  return value.mode === 'selected' && Array.isArray(value.corrections) && value.corrections.length <= correctionLimit
    && value.corrections.every(item => itemValid(item) && boundedString(item.key, 1600))
    && Array.isArray(value.reminders)
    && value.reminders.every(itemValid);
}

function timeDependenciesCurrent(value, projection) {
  if (!timeDependenciesValid(value)) return false;
  if (value.mode === 'projection') return value.fingerprint === (projection?.fingerprint ?? null);
  const sameItem = (saved, current) => current && saved.itemId === current.itemId && saved.text === current.text
    && saved.sourceSignature === (current.sourceSignature ?? null);
  return value.corrections.every(item => sameItem(item, projection?.corrections?.[item.key]))
    && value.reminders.every(item => (projection?.reminders ?? []).some(current => sameItem(item, current)));
}

const qianshiBlock = value => value?.text ? `<qqj_qianshi_progress>\n${value.text}\n</qqj_qianshi_progress>` : '';
const appendQianshiProgress = (text, value) => [String(text ?? '').trim(), qianshiBlock(value)].filter(Boolean).join('\n\n');
const qianshiTokenBudget = value => estimateRecallTokens(qianshiBlock(value));
const reservedQianshiTokenBudget = value => value?.text ? estimateRecallTokens(`\n\n${qianshiBlock(value)}`) : 0;
const stagesWithQianshiBudget = (stages, value) => {
  if (!stages || !value?.text) return stages;
  const tokens = qianshiTokenBudget(value);
  if (Number.isSafeInteger(stages.qianshiTokenBudget)) return stages;
  return { ...stages, estimatedTokenBudget: (Number.isSafeInteger(stages.estimatedTokenBudget) ? stages.estimatedTokenBudget : 0) + tokens, qianshiTokenBudget: tokens };
};
const stagesWithoutQianshi = (stages, value, injectionText) => {
  if (!stages) return stages;
  const reserved = Number.isSafeInteger(stages.qianshiTokenBudget) ? stages.qianshiTokenBudget : 0;
  const next = { ...stages, estimatedTokenCount: estimateRecallTokens(injectionText), estimatedTokenBudget: Math.max(0, (Number.isSafeInteger(stages.estimatedTokenBudget) ? stages.estimatedTokenBudget : 0) - reserved) };
  delete next.qianshiTokenBudget;
  return next;
};
const removeQianshiProgress = (text, value) => {
  const block = qianshiBlock(value);
  const source = String(text ?? '');
  return block && source.endsWith(block) ? source.slice(0, -block.length).trimEnd() : source;
};
const qianshiProgressCurrent = (saved, current) => !saved || Boolean(current && saved.fingerprint === current.fingerprint);

// Re-render only the saved selection. A lost time estimate restores the saved CSE.
function withoutStaleTime(receipt, source, projection) {
  const saved = receipt.timeDependencies;
  if (saved.mode !== 'selected' || !saved.renderPlan) return null;
  const same = (item, live) => live && item.itemId === live.itemId && item.text === live.text && item.sourceSignature === (live.sourceSignature ?? null);
  const corrections = Object.fromEntries(saved.corrections.filter(item => same(item, projection?.corrections?.[item.key])).map(item => [item.key, item]));
  const reminders = saved.reminders.filter(item => (projection?.reminders ?? []).some(live => same(item, live)));
  const floors = clone(saved.renderPlan.floors), states = clone(receipt.selectedStates), changes = clone(receipt.selectedCseChanges);
  const limits = saved.renderPlan.limits;
  const entityById = new Map((source.entities ?? []).map(entity => [entity.entityId, entity]));
  let text, ordinaryText, dependencies, storylines;
  const render = () => {
    const active = new Set([...floors.flatMap(floor => floor.items), ...states, ...changes].map(value => value.storylineId));
    storylines = receipt.storylines.filter(line => active.has(line.storylineId));
    dependencies = { mode: 'selected', corrections: [], reminders: [] };
    ordinaryText = formatRecallInjection({ coverage: receipt.coverage, floors, states, cseChanges: changes, storylines, entityById,
      timeProjection: { corrections }, timeReminders: reminders, timeDependencies: dependencies });
    text = appendQianshiProgress(ordinaryText, receipt.qianshiProgress);
  };
  render();
  let budgetDropped = 0;
  const trimmedHistoryFloors = new Set();
  while (ordinaryText.length > limits.maxCharacters || estimateRecallTokens(ordinaryText) > limits.estimatedTokenBudget) {
    if (reminders.length) reminders.pop();
    else if (floors.length) { const floor = floors.at(-1); trimmedHistoryFloors.add(floor.floorId); floor.items.pop(); if (!floor.items.length) floors.pop(); }
    else if (changes.length) changes.pop();
    else if (states.length) states.pop();
    else break;
    budgetDropped += 1;
    render();
  }
  render();
  dependencies.renderPlan = { floors, limits };
  const history = floors.flatMap(floor => floor.items);
  const originalHistory = saved.renderPlan.floors.flatMap(floor => floor.items);
  const recentDropped = originalHistory.filter(item => item.recallSection === 'recent').length - history.filter(item => item.recallSection === 'recent').length;
  const distantDropped = originalHistory.length - history.length - recentDropped;
  const stages = receipt.stages ? { ...stagesWithQianshiBudget(receipt.stages, receipt.qianshiProgress), selected: floors.length, recentSummaryCount: history.filter(item => item.recallSection === 'recent').length,
    distantHistoryItemCount: history.filter(item => item.recallSection !== 'recent').length,
    linkedHistoryItemCount: history.filter(item => item.recallSection !== 'recent' && ['source', 'topic'].includes(item.relationEvidence)).length,
    linkedCseChangeCount: changes.filter(item => item.relationEvidence === 'source').length, stateCount: states.length, currentStateCount: states.length, cseChangeCount: changes.length,
    storylineCount: storylines.length, timeReminderCount: dependencies.reminders.length, timeCorrectionCount: dependencies.corrections.length,
    finalInjectionItemCount: history.length + states.length + changes.length + dependencies.reminders.length,
    estimatedTokenCount: estimateRecallTokens(text), optionalTimeDropped: (receipt.stages.optionalTimeDropped ?? 0) + saved.corrections.length + saved.reminders.length - dependencies.corrections.length - dependencies.reminders.length,
    recentSummaryDroppedByBudget: (receipt.stages.recentSummaryDroppedByBudget ?? 0) + recentDropped,
    distantHistoryDroppedByBudget: (receipt.stages.distantHistoryDroppedByBudget ?? 0) + distantDropped,
    budgetDroppedCount: (receipt.stages.budgetDroppedCount ?? 0) + budgetDropped } : null;
  return { ...receipt, selectedFloors: floors.map(({ floorId, floorMemoryId, assistantSeq, reasons }) => ({ floorId, floorMemoryId, assistantSeq, reasons })), selectedStates: states,
    selectedCseChanges: changes, storylines, timeDependencies: dependencies, injectionText: text, completionStatus: text ? 'ready' : 'empty', stages,
    selectorDiagnostic: receipt.selectorDiagnostic ? { ...receipt.selectorDiagnostic, historyRetainedCount: history.length, stateRetainedCount: states.length + changes.length } : null,
    skipReasons: [...new Set([...receipt.skipReasons, 'optionalTimeChanged'])] };
}
const selectorDiagnosticSnapshot = value => {
  const api = sanitizeTaskMetadata(value);
  return Object.freeze({
    mode: ['llm', 'fallback', 'local'].includes(value?.mode) ? value.mode : 'local',
    code: value?.code ? clean(value.code, 120) : null,
    httpStatus: Number.isSafeInteger(value?.httpStatus) && value.httpStatus >= 0 ? value.httpStatus : null,
    formatStage: value?.formatStage ? clean(value.formatStage, 80) : null,
    finishReason: clean(value?.finishReason ?? api.finishReason, 32),
    source: api.source,
    sourceLabel: api.sourceLabel,
    model: api.model,
    transportAttempts: Number.isSafeInteger(value?.transportAttempts) && value.transportAttempts >= 0 ? value.transportAttempts : api.transportAttempts,
    durationMs: Math.max(0, Math.floor(Number(value?.durationMs) || 0)),
    utilityRoundTripMs: finiteDuration(value?.utilityRoundTripMs) ? Math.floor(value.utilityRoundTripMs) : null,
    localSelectionMs: finiteDuration(value?.localSelectionMs) ? Math.floor(value.localSelectionMs) : null,
    historyCandidateCount: nonNegativeInteger(value?.historyCandidateCount) ? value.historyCandidateCount : null,
    stateCandidateCount: nonNegativeInteger(value?.stateCandidateCount) ? value.stateCandidateCount : null,
    historyModelSelectedCount: nonNegativeInteger(value?.historyModelSelectedCount) ? value.historyModelSelectedCount : null,
    stateModelSelectedCount: nonNegativeInteger(value?.stateModelSelectedCount) ? value.stateModelSelectedCount : null,
    historyExcludedCount: nonNegativeInteger(value?.historyExcludedCount) ? value.historyExcludedCount : null,
    stateExcludedCount: nonNegativeInteger(value?.stateExcludedCount) ? value.stateExcludedCount : null,
    historyRetainedCount: nonNegativeInteger(value?.historyRetainedCount) ? value.historyRetainedCount : null,
    stateRetainedCount: nonNegativeInteger(value?.stateRetainedCount) ? value.stateRetainedCount : null,
  });
};
const receiptTimingSnapshot = timings => Object.freeze({
  inputMs: Math.max(0, Number(timings.inputMs) || 0),
  sourceMs: Math.max(0, Number(timings.sourceMs) || 0),
  selectorMs: Math.max(0, Number(timings.selectorMs) || 0),
  ...(timings.sourceReadAttempts ? { sourceReadAttempts: clone(timings.sourceReadAttempts) } : {}),
});
const stateChangeSideValid = (value, { identifiersRequired = false } = {}) => value === null || (value && typeof value === 'object' && !Array.isArray(value)
  && (!identifiersRequired || boundedString(value.stateId, 500))
  && (value.stateId === undefined || optionalBoundedString(value.stateId, 500))
  && (value.sourceFloorId === undefined || optionalBoundedString(value.sourceFloorId, 500))
  && (value.sourceDeltaId === undefined || optionalBoundedString(value.sourceDeltaId, 500))
  && boundedString(value.text, 4000) && ['private', 'observable', 'expressed', 'shared', 'authorial'].includes(value.visibility)
  && boundedString(value.reason, 4000, { empty: true }) && ['baseline', 'floor', 'reasonableProgression', 'manual'].includes(value.origin)
  && optionalBoundedString(value.towardEntityId, 500) && optionalPositiveInteger(value.sourceAssistantSeq));
function receiptShapeValid(receipt, { historical = false } = {}) {
  const expandedSelection = receipt?.strategyVersion === RECALL_STRATEGY_VERSION;
  const receiptFloorLimit = expandedSelection ? MAX_RECEIPT_FLOORS : LEGACY_MAX_RECEIPT_FLOORS;
  const receiptStateLimit = expandedSelection ? MAX_RECEIPT_STATES : LEGACY_MAX_RECEIPT_STATES;
  const receiptChangeLimit = expandedSelection ? MAX_RECEIPT_CSE_CHANGES : LEGACY_MAX_RECEIPT_CSE_CHANGES;
  const receiptStorylineLimit = expandedSelection ? MAX_RECEIPT_STORYLINES : LEGACY_MAX_RECEIPT_STORYLINES;
  if (receipt?.schemaVersion >= 14 && !timeDependenciesValid(receipt.timeDependencies, { correctionLimit: receiptStateLimit })) return false;
  const plan = receipt?.timeDependencies?.renderPlan;
  if (plan && (!Array.isArray(plan.floors) || plan.floors.length > receiptFloorLimit
    || !plan.floors.every(floor => Array.isArray(floor.items) && floor.items.every(item => item && boundedString(item.text, 4000)))
    || !nonNegativeInteger(plan.limits?.maxCharacters) || plan.limits.maxCharacters > (expandedSelection ? 32000 : 20000)
    || !nonNegativeInteger(plan.limits?.estimatedTokenBudget) || plan.limits.estimatedTokenBudget > (expandedSelection ? 8000 : receipt.schemaVersion >= 15 ? 4000 : 5000)
    || (receipt.schemaVersion === 14 && (!nonNegativeInteger(plan.limits?.ordinaryMaxCharacters) || plan.limits.ordinaryMaxCharacters > 16000
      || !nonNegativeInteger(plan.limits?.ordinaryEstimatedTokenBudget) || plan.limits.ordinaryEstimatedTokenBudget > 4000))
    || JSON.stringify(plan).length > 200000)) return false;
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
    || (receipt.schemaVersion >= 9 && (historical
      ? ![RECALL_STRATEGY_VERSION, 'continuity-v14', 'continuity-v13', 'continuity-v12', 'continuity-v11', 'continuity-v10', 'continuity-v9', 'continuity-v8', 'continuity-v7', 'continuity-v6', 'continuity-v5', 'continuity-v4', 'continuity-v3', 'continuity-v2', 'continuity-v1'].includes(receipt.strategyVersion)
      : receipt.strategyVersion !== RECALL_STRATEGY_VERSION))
    || !SUPPORTED_TYPES.has(receipt.generationType)
    || !Array.isArray(receipt.selectedFloors) || receipt.selectedFloors.length > receiptFloorLimit
    || !Array.isArray(receipt.selectedStates) || receipt.selectedStates.length > receiptStateLimit
    || !Array.isArray(receipt.skipReasons) || receipt.skipReasons.length > MAX_RECEIPT_SKIP_REASONS
    || !boundedString(receipt.injectionText, expandedSelection ? 32000 : ['continuity-v13', 'continuity-v12', 'continuity-v11', 'continuity-v10'].includes(receipt.strategyVersion) ? 20000 : 16000, { empty: true })
    || !boundedString(receipt.receiptFingerprint, 200)
    || !boundedString(receipt.createdAt, 100) || !Number.isFinite(Date.parse(receipt.createdAt))
    || (receipt.completionStatus === 'ready') !== Boolean(receipt.injectionText)) return false;
  if (receipt.schemaVersion >= 15 && receipt.qianshiProgress !== undefined && receipt.qianshiProgress !== null) {
    const value = receipt.qianshiProgress;
    if (!value || typeof value !== 'object' || Array.isArray(value) || !boundedString(value.fingerprint, 200)
      || (value.projectionVersion !== undefined && !nonNegativeInteger(value.projectionVersion))
      || !boundedString(value.text, 4000) || !Array.isArray(value.eventIds) || value.eventIds.length > 160
      || !Array.isArray(value.matterIds) || value.matterIds.length > 160
      || !value.eventIds.every(id => boundedString(id, 500)) || !value.matterIds.every(id => boundedString(id, 500))) return false;
  }
  if (!receipt.selectedFloors.every(value => value && typeof value === 'object' && !Array.isArray(value)
    && boundedString(value.floorId, 500) && boundedString(value.floorMemoryId, 500)
    && Number.isSafeInteger(value.assistantSeq) && value.assistantSeq > 0
    && Array.isArray(value.reasons) && value.reasons.length <= 32
    && value.reasons.every(reason => boundedString(reason, 500)))) return false;
  if (!receipt.selectedStates.every(value => value && typeof value === 'object' && !Array.isArray(value)
    && (!IDENTIFIED_RECALL_STRATEGIES.includes(receipt.strategyVersion) || (boundedString(value.stateId, 500) && boundedString(value.storylineId, 80)))
    && (value.stateId === undefined || optionalBoundedString(value.stateId, 500))
    && (value.sourceFloorId === undefined || optionalBoundedString(value.sourceFloorId, 500))
    && (value.sourceDeltaId === undefined || optionalBoundedString(value.sourceDeltaId, 500))
    && boundedString(value.subjectEntityId, 500) && boundedString(value.subject, 500)
    && ['core', 'adaptive', 'situational'].includes(value.layer)
    && optionalBoundedString(value.towardEntityId, 500) && optionalBoundedString(value.toward, 500)
    && boundedString(value.text, 4000) && boundedString(value.reason, 1000, { empty: true })
    && ['private', 'observable', 'expressed', 'shared', 'authorial'].includes(value.visibility)
    && optionalPositiveInteger(value.sourceAssistantSeq))) return false;
  if (receipt.schemaVersion >= 10) {
    if (!Array.isArray(receipt.selectedCseChanges) || receipt.selectedCseChanges.length > receiptChangeLimit
      || receipt.selectedStates.length + receipt.selectedCseChanges.length > receiptChangeLimit
      || !receipt.selectedCseChanges.every(value => value && typeof value === 'object' && !Array.isArray(value)
        && boundedString(value.deltaId, 500) && boundedString(value.floorId, 500) && Number.isSafeInteger(value.assistantSeq) && value.assistantSeq > 0
        && boundedString(value.subjectEntityId, 500) && boundedString(value.subject, 500)
        && ['core', 'adaptive', 'situational'].includes(value.layer) && ['add', 'remove', 'update', 'refine'].includes(value.action)
        && stateChangeSideValid(value.before, { identifiersRequired: IDENTIFIED_RECALL_STRATEGIES.includes(receipt.strategyVersion) })
        && stateChangeSideValid(value.after, { identifiersRequired: IDENTIFIED_RECALL_STRATEGIES.includes(receipt.strategyVersion) })
        && (!IDENTIFIED_RECALL_STRATEGIES.includes(receipt.strategyVersion) || boundedString(value.storylineId, 80)))) return false;
    const diagnostic = receipt.selectorDiagnostic;
    if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)
      || !['llm', 'fallback', 'local'].includes(diagnostic.mode)
      || !optionalBoundedString(diagnostic.code, 120) || !(diagnostic.httpStatus === null || nonNegativeInteger(diagnostic.httpStatus))
      || !optionalBoundedString(diagnostic.formatStage, 80) || !boundedString(diagnostic.finishReason, 32, { empty: true })
      || !boundedString(diagnostic.source, 80) || !boundedString(diagnostic.sourceLabel, 160) || !boundedString(diagnostic.model, 160)
      || !(diagnostic.transportAttempts === null || nonNegativeInteger(diagnostic.transportAttempts)) || !finiteDuration(diagnostic.durationMs)
      || !(diagnostic.utilityRoundTripMs === null || diagnostic.utilityRoundTripMs === undefined || finiteDuration(diagnostic.utilityRoundTripMs))
      || !(diagnostic.localSelectionMs === null || diagnostic.localSelectionMs === undefined || finiteDuration(diagnostic.localSelectionMs))
      || (IDENTIFIED_RECALL_STRATEGIES.includes(receipt.strategyVersion) && !['historyCandidateCount', 'stateCandidateCount', 'historyExcludedCount', 'stateExcludedCount', 'historyRetainedCount', 'stateRetainedCount'].every(key => diagnostic[key] === null || nonNegativeInteger(diagnostic[key])))) return false;
    const timings = receipt.timings;
    if (!timings || typeof timings !== 'object' || Array.isArray(timings)
      || !['inputMs', 'sourceMs', 'selectorMs'].every(key => finiteDuration(timings[key]))
      || (timings.sourceReadAttempts !== null && timings.sourceReadAttempts !== undefined
        && (typeof timings.sourceReadAttempts !== 'object' || Array.isArray(timings.sourceReadAttempts)
          || !nonNegativeInteger(timings.sourceReadAttempts.reachableReads) || !boundedString(timings.sourceReadAttempts.exitPoint, 120)))) return false;
  }
  if (receipt.schemaVersion >= 12 && (!Array.isArray(receipt.storylines) || receipt.storylines.length > receiptStorylineLimit
    || !receipt.storylines.every(value => value && typeof value === 'object' && !Array.isArray(value)
      && boundedString(value.storylineId, 80) && boundedString(value.title, 160) && boundedString(value.basis, 500))
    || new Set(receipt.storylines.map(value => value.storylineId)).size !== receipt.storylines.length
    || !receipt.selectedStates.every(value => receipt.storylines.some(line => line.storylineId === value.storylineId))
    || !receipt.selectedCseChanges.every(value => receipt.storylines.some(line => line.storylineId === value.storylineId)))) return false;
  if (receipt.schemaVersion >= 13 && receipt.schemaVersion <= 14) {
    const selectedStateKeys = new Set(receipt.selectedStates.map(value => `${value.stateId}|${value.subjectEntityId}|${value.sourceFloorId ?? ''}`));
    const selectedEvidence = new Set([
      ...receipt.selectedFloors.map(value => `history|${value.floorId}|${value.assistantSeq}`),
      ...receipt.selectedStates.map(value => `state|${value.sourceFloorId ?? ''}|${value.sourceAssistantSeq ?? ''}`),
      ...receipt.selectedCseChanges.map(value => `change|${value.floorId}|${value.assistantSeq}`),
    ]);
    if (!Array.isArray(receipt.stateProgressions) || receipt.stateProgressions.length > MAX_RECEIPT_STATE_PROGRESSIONS
      || !receipt.stateProgressions.every(value => value && typeof value === 'object' && !Array.isArray(value)
        && boundedString(value.subjectEntityId, 500) && boundedString(value.subject, 500)
        && optionalBoundedString(value.towardEntityId, 500) && optionalBoundedString(value.toward, 500)
        && boundedString(value.savedText, 4000) && ['private', 'observable', 'expressed', 'shared', 'authorial'].includes(value.visibility)
        && boundedString(value.sourceStateId, 500) && optionalBoundedString(value.sourceFloorId, 500) && optionalPositiveInteger(value.sourceAssistantSeq)
        && boundedString(value.timeBasis, 300) && boundedString(value.suggestion, 600)
        && selectedStateKeys.has(`${value.sourceStateId}|${value.subjectEntityId}|${value.sourceFloorId ?? ''}`)
        && Array.isArray(value.evidence) && value.evidence.length <= 6
        && value.evidence.every(item => item && typeof item === 'object' && !Array.isArray(item)
          && ['history', 'state', 'change'].includes(item.kind) && optionalBoundedString(item.floorId, 500)
          && optionalPositiveInteger(item.assistantSeq)
          && selectedEvidence.has(`${item.kind}|${item.floorId ?? ''}|${item.assistantSeq ?? ''}`)))) return false;
  }
  if (receipt.coverage !== null && (typeof receipt.coverage !== 'object' || Array.isArray(receipt.coverage)
    || !['stableAiFloors', 'stableThroughAssistantSeq', 'rememberedAiFloors', 'cseThroughAssistantSeq'].every(key => nonNegativeInteger(receipt.coverage[key]))
    || typeof receipt.coverage.memoryComplete !== 'boolean' || typeof receipt.coverage.cseCurrent !== 'boolean'
    || !Array.isArray(receipt.coverage.missingAssistantSeq) || receipt.coverage.missingAssistantSeq.length > 10000
    || !receipt.coverage.missingAssistantSeq.every(value => Number.isSafeInteger(value) && value > 0))) return false;
  if (receipt.stages !== null && (typeof receipt.stages !== 'object' || Array.isArray(receipt.stages)
    || !['input', 'candidates', 'dropRecent', 'dropPersistent', 'dropVisibility', 'selected'].every(key => nonNegativeInteger(receipt.stages[key]))
    || (receipt.schemaVersion >= 9 && !['recentSummaryCount', 'distantHistoryItemCount', 'stateCount'].every(key => nonNegativeInteger(receipt.stages[key])))
    || (receipt.schemaVersion >= 10 && !['currentStateCount', 'cseChangeCount'].every(key => nonNegativeInteger(receipt.stages[key])))
    || (receipt.schemaVersion >= 11 && !['linkedHistoryItemCount', 'linkedCseChangeCount', 'budgetDroppedCount', 'finalInjectionItemCount'].every(key => nonNegativeInteger(receipt.stages[key])))
    || (receipt.schemaVersion >= 12 && !['storylineCount', 'estimatedTokenCount', 'estimatedTokenBudget'].every(key => nonNegativeInteger(receipt.stages[key])))
    || (receipt.stages.qianshiTokenBudget !== undefined && (!receipt.qianshiProgress || !nonNegativeInteger(receipt.stages.qianshiTokenBudget)
      || receipt.stages.qianshiTokenBudget !== reservedQianshiTokenBudget(receipt.qianshiProgress)))
    || (receipt.schemaVersion >= 13 && receipt.schemaVersion <= 14 && !nonNegativeInteger(receipt.stages.stateProgressionCount)))) return false;
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
      || !sourceRefsValid(snapshot, source)
      || !timeDependenciesCurrent(snapshot.timeDependencies, source.timeProjection)) return null;
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
    if (!receiptShapeValid(snapshot, { historical: true })
      || ![6, 7, 8, 9, 10, 11, 12, 13, 14, RECALL_RECEIPT_SCHEMA_VERSION].includes(snapshot.schemaVersion)
      || snapshot.chatId !== chatId
      || snapshot.userMessageIndex !== userIndex
      || snapshot.userContentFingerprint !== userFingerprint
      || snapshot.receiptFingerprint !== await fingerprint(JSON.stringify(receiptMaterial(snapshot)))) return null;
    return snapshot;
  } catch {
    return null;
  }
}

function stateFromReceipt(receipt, { generationType = receipt.generationType, restoredReceipt = false, reusedReceipt = !restoredReceipt, timings = null } = {}) {
  return Object.freeze({
    schemaVersion: receipt.schemaVersion,
    strategyVersion: receipt.strategyVersion,
    status: receipt.completionStatus,
    userMessageIndex: receipt.userMessageIndex,
    generationType,
    coverage: receipt.coverage,
    selectedFloors: Object.freeze(clone(receipt.selectedFloors ?? [])),
    selectedStates: Object.freeze(clone(receipt.selectedStates ?? [])),
    selectedCseChanges: Object.freeze(clone(receipt.selectedCseChanges ?? [])),
    qianshiProgress: receipt.qianshiProgress ? Object.freeze(clone(receipt.qianshiProgress)) : null,
    storylines: Object.freeze(clone(receipt.storylines ?? [])),
    selectorDiagnostic: receipt.selectorDiagnostic ? Object.freeze(clone(receipt.selectorDiagnostic)) : null,
    injectionText: receipt.injectionText,
    reusedReceipt,
    restoredReceipt,
    receiptPersistence: restoredReceipt ? 'chatRecord' : receipt.receiptPersistence ?? 'chatRecord',
    stages: stagesWithQianshiBudget(receipt.stages, receipt.qianshiProgress) ?? null,
    timings: timings ? Object.freeze({ ...timings }) : receipt.timings ? Object.freeze(clone(receipt.timings)) : null,
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
    schemaVersion: receipt.schemaVersion,
    status: receipt.injectionText ? 'ready' : 'empty',
    userMessageIndex: Number.isSafeInteger(receipt.userMessageIndex) ? receipt.userMessageIndex : null,
    generationType: SUPPORTED_TYPES.has(receipt.generationType) ? receipt.generationType : null,
    coverage: receipt.coverage && typeof receipt.coverage === 'object' && !Array.isArray(receipt.coverage) ? clone(receipt.coverage) : null,
    selectedFloors: Object.freeze(clone(selectedFloors)),
    selectedStates: Object.freeze(clone(selectedStates)),
    selectedCseChanges: Object.freeze([]),
    storylines: Object.freeze([]),
    selectorDiagnostic: null,
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
  if ([6, 7, 8, 9, 10, 11, 12, 13, 14, RECALL_RECEIPT_SCHEMA_VERSION].includes(receipt.schemaVersion)) {
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
  const visibleFloorIds = [...new Set(source.readiness?.visibleSummaryFloorIds ?? [])].sort();
  const visibleFloorIdSet = new Set(visibleFloorIds);
  const verified = [];
  for (const ref of source.bodyMatchRefs ?? []) {
    if (visibleFloorIdSet.has(ref.floorId)) continue;
    const liveMessage = snapshot?.chat?.[ref.hostLocator?.messageIndex];
    const selected = selectAssistantMessage(liveMessage);
    if (!selected || selected.swipeId !== ref.hostLocator.swipeId || selected.selectedSwipeIndex !== ref.hostLocator.selectedSwipeIndex) continue;
    const canonical = sanitizeMemoryContent(selected.rawContent, sanitizerOptions);
    const [rawFingerprint, canonicalFingerprint] = await Promise.all([fingerprint(selected.rawContent), fingerprint(canonical)]);
    if (rawFingerprint !== ref.rawFingerprint || canonicalFingerprint !== ref.canonicalFingerprint) continue;
    verified.push({ ...ref, liveMessage, liveIndex: ref.hostLocator.messageIndex, rawContent: selected.rawContent, canonicalContent: canonical, key: `${rawFingerprint}|${canonicalFingerprint}` });
  }
  const materialFor = covered => ({
    version: 3,
    covered: covered.map(item => [item.floorId, item.floorMemoryId, item.assistantSeq, item.rawFingerprint, item.canonicalFingerprint]),
    visibleFloorIds,
  });
  const resultFor = async covered => Object.freeze({
    fingerprint: await fingerprint(JSON.stringify(materialFor(covered))),
    witnessCount: witness.length,
    matchedCount: covered.length,
    coveredFloorIds: Object.freeze(covered.map(item => item.floorId)),
    coveredRefs: Object.freeze(covered.map(item => Object.freeze({ floorId: item.floorId, floorMemoryId: item.floorMemoryId, assistantSeq: item.assistantSeq }))),
    visibleFloorIds: Object.freeze(visibleFloorIds),
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
  for (const item of witness) {
    const key = `${item.rawFingerprint}|${item.canonicalFingerprint}`;
    const identity = verified.find(ref => ref.liveMessage === item.message && ref.key === key);
    const liveMatches = witnessCounts.get(key) === 1
      ? liveCandidates.filter(candidate => candidate.rawContent === item.rawContent && candidate.canonicalContent === item.canonicalContent)
      : [];
    const cloneLive = liveMatches.length === 1 ? liveMatches[0] : null;
    const match = identity ?? (cloneLive ? verified.find(ref => ref.liveIndex === cloneLive.liveIndex && ref.key === key) : null);
    if (match) tentative.push({ coreIndex: item.coreIndex, match, identity: Boolean(identity) });

  }
  tentative.sort((left, right) => left.coreIndex - right.coreIndex);
  const covered = [];
  let previousSeq = 0;
  for (const entry of tentative) {
    if (entry.match.assistantSeq <= previousSeq) continue;
    covered.push(entry.match);
    previousSeq = entry.match.assistantSeq;
  }
  return resultFor(covered);
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

export function createV3RecallRuntime({ store, hostAdapter, generateUtilityTask = null, isEnabled = true, memoryStatus = () => null, prepareMemory = null, preparationTimeoutMs = 5000, realtimeOrigin = () => false, notifyUser = null, sourceReader = readRecallSource, selector = null, queryBuilder = buildRecallQueryContext, fingerprint = hashText, sanitizerOptions = () => ({}), identityProjectionProvider = null, timeProjectionProvider = null, qianshiProgressProvider = null, now = () => new Date(), pluginVersion, logger = console } = {}) {
  if (!store || typeof store.readReachable !== 'function') throw new TypeError('V3 recall store 无效');
  if (!hostAdapter || typeof hostAdapter.snapshot !== 'function') throw new TypeError('V3 recall host adapter 无效');
  if (typeof fingerprint !== 'function') throw new TypeError('V3 recall fingerprint 无效');
  let epoch = 0, generationSerial = 0, stoppedEndDebt = 0, active = null, slotOwner = null, prequelSlotActive = false, promptSnapshot = null, lastRecall = null, lastPrequel = null, lastError = null, lastRecallBinding = null, enabledOverride = null;
  const subscribers = new Set(), generationQueue = [];
  let sessionReceipt = null;
  const enabled = () => { try { return enabledOverride ?? ((typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true); } catch { return false; } };
  const currentSanitizerOptions = () => { try { return typeof sanitizerOptions === 'function' ? sanitizerOptions() : sanitizerOptions; } catch { return {}; } };
  const hasRealtimeOrigin = () => { try { return (typeof realtimeOrigin === 'function' ? realtimeOrigin() : realtimeOrigin) === true; } catch { return false; } };
  const selectionRunner = typeof selector === 'function'
    ? selector
    : input => selectRecallWithLlm({ ...input, generateUtilityTask, signal: input.signal });
  const readinessReasons = source => {
    if (!source?.readiness || source.readiness.status === 'caughtUp') return [];
    if (source.readiness.status === 'unknown' && source.readiness.hostConfirmed !== true) return ['memoryNotReady', 'coverageUnconfirmed'];
    const pendingSummaryFloorIds = source.readiness.summaryMissingFloorIds
      ?? (source.readiness.summaryPendingFloorIds ?? []).filter(floorId => !source.floorMemories?.some(memory => memory.floorId === floorId));
    const visibleFloorIds = new Set(source.readiness.visibleSummaryFloorIds ?? source.bodyMatch?.visibleFloorIds ?? []);
    if (source.readiness.summaryStatus === 'caughtUp') return [];
    if (source.readiness.hostConfirmed === true && pendingSummaryFloorIds.length
      && pendingSummaryFloorIds.every(floorId => visibleFloorIds.has(floorId))) return [];
    const memory = (() => { try { return typeof memoryStatus === 'function' ? memoryStatus() : memoryStatus; } catch { return null; } })();
    if (memory?.lastAutoMemory?.status === 'failed') return ['memoryNotReady', 'memoryRebuildFailed'];
    return ['memoryNotReady', 'historicalRebuildRequired'];
  };
  const technicalSourceError = source => {
    const status = String(source?.status ?? '');
    if (!['timeout', 'unavailable', 'error', 'loading'].includes(status)) return null;
    const detail = typeof source?.error === 'string' ? source.error : source?.error?.message;
    const code = source?.error?.code ?? (status === 'timeout' ? 'V3_RECALL_MEMORY_PREPARATION_TIMEOUT' : 'V3_RECALL_SOURCE_UNAVAILABLE');
    return Object.assign(new Error(detail || (status === 'timeout' ? '当前聊天记忆在 5 秒内未准备完成。' : '当前聊天记忆暂时无法读取。')), { code });
  };
  async function basePreparedSource(snapshot, sanitizerSnapshot, { fresh = false, operation = null, rootResult = null } = {}) {
    const identityProjection = typeof identityProjectionProvider === 'function' ? await identityProjectionProvider() : null;
    if (typeof prepareMemory === 'function') {
      let timer = null;
      let expired = false;
      const timeout = Symbol('memoryPreparationTimeout');
      let outcome;
      try {
        outcome = await Promise.race([
          Promise.resolve().then(async () => {
            let latestRoot = rootResult;
            if (fresh && latestRoot === null && typeof store.readRoot === 'function') {
              latestRoot = await store.readRoot();
              const rootError = technicalSourceError(latestRoot);
              if (rootError) throw rootError;
              if (expired || (operation && (operation.token !== epoch || operation.controller.signal.aborted))) return { prepared: { status: 'stale' }, fallback: null };
            }
            const prepared = await prepareMemory({ preferCached: !fresh, rootResult: latestRoot });
            if (prepared?.status === 'ready' && prepared.reachable?.root) return { prepared, fallback: null };
            if (['disabled', 'stale'].includes(prepared?.status)) return { prepared, fallback: null };
            if (expired || (operation && (operation.token !== epoch || operation.controller.signal.aborted))) return { prepared, fallback: null };
            const fallback = await sourceReader({ store, now, hostSnapshot: snapshot, sanitizerOptions: sanitizerSnapshot, realtimeOrigin: hasRealtimeOrigin(), identityProjection: identityProjection?.data ?? identityProjection });
            return { prepared, fallback };
          }),
          new Promise(resolve => { timer = setTimeout(() => { expired = true; resolve(timeout); }, Math.max(1, Number(preparationTimeoutMs) || 5000)); }),
        ]);
      } catch (error) {
        return Object.freeze({ status: 'unavailable', error: Object.freeze({ code: clean(error?.code ?? error?.name ?? 'V3_RECALL_SOURCE_UNAVAILABLE', 120), message: clean(error?.message ?? '记忆准备失败。') }), sourceReadAttempts: Object.freeze({ reachableReads: 0, exitPoint: 'memoryPreparationFailed' }) });
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
      if (outcome === timeout) return Object.freeze({ status: 'timeout', sourceReadAttempts: Object.freeze({ reachableReads: 0, exitPoint: 'memoryPreparationTimeout' }) });
      const { prepared, fallback } = outcome;
      if (prepared?.status === 'ready' && prepared.reachable?.root) {
        return projectRecallSource(prepared.reachable, now, Object.freeze({ reachableReads: 0, exitPoint: 'validatedSnapshot' }), snapshot, sanitizerSnapshot, hasRealtimeOrigin(), identityProjection?.data ?? identityProjection);
      }
      if (fallback?.status === 'ready' || fallback?.status === 'stale') return fallback;
      const status = prepared?.status === 'error' ? 'unavailable' : prepared?.status ?? 'unavailable';
      return Object.freeze({ status, sourceReadAttempts: Object.freeze({ reachableReads: 0, exitPoint: 'memoryPreparation' }) });
    }
    return sourceReader({ store, now, hostSnapshot: snapshot, sanitizerOptions: sanitizerSnapshot, realtimeOrigin: hasRealtimeOrigin(), identityProjection: identityProjection?.data ?? identityProjection });
  }
  async function attachQianshiProgress(source, queryContext, hostSnapshot = null) {
    if (source?.status !== 'ready') return source;
    let qianshiProgress = null;
    if (typeof qianshiProgressProvider === 'function') try {
      const value = await qianshiProgressProvider(source, { queryContext, hostSnapshot });
      const anchorMatches = value?.anchor?.headCheckpointId === source.headCheckpointId && value?.anchor?.narrativeGeneration === source.narrativeGeneration;
      if (anchorMatches && typeof value?.text === 'string' && value.text.trim()) {
        const material = { projectionVersion: Number.isSafeInteger(value.projectionVersion) ? value.projectionVersion : 0,
          text: value.text.trim().slice(0, 4000), eventIds: [...new Set(value.eventIds ?? [])].slice(0, 160), matterIds: [...new Set(value.matterIds ?? [])].slice(0, 160) };
        qianshiProgress = Object.freeze({ ...material, fingerprint: await fingerprint(JSON.stringify(material)) });
      }
    } catch (error) { logger?.warn?.('[qianqianjie] optional qianshi projection failed', { code: error?.code ?? error?.name ?? 'QQJ_QIANSHI_READ_FAILED' }); }
    return Object.freeze({ ...source, qianshiProgress });
  }
  async function preparedSource(snapshot, sanitizerSnapshot, options = {}) {
    let source = await basePreparedSource(snapshot, sanitizerSnapshot, options);
    if (source?.status !== 'ready') return source;
    let timeProjection = null;
    if (typeof timeProjectionProvider === 'function') try { timeProjection = await timeProjectionProvider(source); }
    catch (error) { logger?.warn?.('[qianqianjie] optional time projection failed', { code: error?.code ?? error?.name ?? 'QQJ_TIME_READ_FAILED' }); }
    return Object.freeze({ ...source, timeProjection });
  }
  const notify = () => { const state = getState(); for (const listener of subscribers) { try { listener(state); } catch { /* listener isolation */ } } return state; };
  const promptSlot = (slot, value, owner = null, checkedContext = null, binding = null) => {
    const context = checkedContext ?? hostAdapter.snapshot().context;
    const setter = context?.setExtensionPrompt;
    if (typeof setter !== 'function') throw Object.assign(new Error('宿主不支持 setExtensionPrompt。'), { code: 'V3_RECALL_PROMPT_UNAVAILABLE' });
    const position = context.constants?.promptTypes?.IN_CHAT ?? 1;
    const role = context.constants?.promptRoles?.SYSTEM ?? 0;
    if (slot === PREQUEL_PROMPT_SLOT) prequelSlotActive = Boolean(value);
    const text = String(value ?? '');
    setter(slot, text, position, RECALL_PROMPT_DEPTH, false, role);
    if (text) {
      const current = promptSnapshot?.owner === owner ? promptSnapshot : null;
      promptSnapshot = Object.freeze({
        owner,
        chatId: binding?.chatId ?? current?.chatId ?? null,
        hostChatId: binding?.hostChatId ?? current?.hostChatId ?? null,
        recallText: slot === RECALL_PROMPT_SLOT ? text : current?.recallText ?? '',
        prequelText: slot === PREQUEL_PROMPT_SLOT ? text : current?.prequelText ?? '',
      });
      slotOwner = owner;
    } else if (promptSnapshot) {
      const next = Object.freeze({
        ...promptSnapshot,
        recallText: slot === RECALL_PROMPT_SLOT ? '' : promptSnapshot.recallText,
        prequelText: slot === PREQUEL_PROMPT_SLOT ? '' : promptSnapshot.prequelText,
      });
      promptSnapshot = next.recallText || next.prequelText ? next : null;
    }
  };
  const prompt = (value, owner = null, checkedContext = null, binding = null) => promptSlot(RECALL_PROMPT_SLOT, value, owner, checkedContext, binding);
  const promptPrequel = (value, owner = null, checkedContext = null, binding = null) => promptSlot(PREQUEL_PROMPT_SLOT, value, owner, checkedContext, binding);
  const clearSlot = (owner, { preserveSnapshot = false } = {}) => {
    if (owner !== undefined && slotOwner !== null && slotOwner !== owner) return false;
    const preparedSnapshot = preserveSnapshot ? promptSnapshot : null;
    if (!preserveSnapshot) promptSnapshot = null;
    try {
      const context = hostAdapter.snapshot().context;
      prompt('', null, context); if (prequelSlotActive) promptPrequel('', null, context);
      slotOwner = null; return true;
    }
    catch (error) { logger?.warn?.('[qianqianjie] V3 recall prompt cleanup failed', { code: error?.code ?? error?.name ?? 'V3_RECALL_CLEAR_FAILED' }); return false; }
    finally { if (preserveSnapshot) promptSnapshot = preparedSnapshot; }
  };
  const sessionKey = ({ source, userIndex, userFingerprint, queryFingerprint }) => [source.chatId, source.narrativeGeneration, source.headCheckpointId, source.rootRevision,
    JSON.stringify(source.identityProjection ?? {}), userIndex, userFingerprint, queryFingerprint, source.bodyMatch?.fingerprint ?? ''].join('|');

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
      lastPrequel,
      lastRecallBinding: lastRecallBinding ? Object.freeze({ chatId: lastRecallBinding.chatId, userMessageIndex: lastRecallBinding.userMessageIndex }) : null,
      lastRecallError: lastError,
    });
  }

  function getPromptSnapshot() {
    if (!promptSnapshot) return null;
    return Object.freeze({
      chatId: promptSnapshot.chatId,
      hostChatId: promptSnapshot.hostChatId,
      recall: Object.freeze({ text: promptSnapshot.recallText }),
      prequel: Object.freeze({ text: promptSnapshot.prequelText }),
    });
  }

  function getPrequel() {
    const snapshot = hostAdapter.snapshot();
    return Object.freeze({ hostChatId: currentHostChatId(snapshot) || null, text: currentPrequelText(snapshot) });
  }

  async function savePrequel(value) {
    const text = String(value ?? '');
    const snapshot = hostAdapter.snapshot();
    const hostChatId = currentHostChatId(snapshot);
    const context = snapshot.context;
    if (!hostChatId) throw Object.assign(new Error('请先打开一个可保存的聊天。'), { code: 'V3_PREQUEL_CHAT_UNAVAILABLE' });
    if (typeof context?.saveChatMetadata !== 'function' && typeof context?.saveMetadata !== 'function') throw Object.assign(new Error('宿主不支持聊天元数据保存。'), { code: 'V3_PREQUEL_SAVE_UNAVAILABLE' });
    const metadata = context.chatMetadata;
    const hadPrevious = Object.hasOwn(metadata, PREQUEL_METADATA_KEY);
    const previous = metadata[PREQUEL_METADATA_KEY];
    if (text.trim()) metadata[PREQUEL_METADATA_KEY] = text;
    else delete metadata[PREQUEL_METADATA_KEY];
    try {
      if (typeof context.saveChatMetadata === 'function') {
        const saved = await context.saveChatMetadata();
        if (saved !== true) throw Object.assign(new Error('聊天元数据未能持久化。'), { code: 'V3_PREQUEL_SAVE_FAILED' });
      } else await context.saveMetadata();
    } catch (error) {
      if (context.chatMetadata === metadata) {
        if (hadPrevious) metadata[PREQUEL_METADATA_KEY] = previous;
        else delete metadata[PREQUEL_METADATA_KEY];
      }
      throw error;
    }
    invalidate('prequelSaved');
    return Object.freeze({ hostChatId, text: text.trim() ? text : '' });
  }

  const prequelState = (operation, { error = null } = {}) => {
    const selection = operation?.prequelSelection;
    if (!selection?.injectionText && !error) return null;
    return Object.freeze({
      status: error ? 'error' : 'ready',
      hostChatId: operation.hostChatId || null,
      userMessageIndex: operation.user?.index ?? null,
      generationType: operation.type,
      injectionText: error ? '' : selection.injectionText,
      fragmentIndexes: Object.freeze(error ? [] : [...selection.fragmentIndexes]),
      estimatedCharacters: error ? 0 : selection.estimatedCharacters,
      estimatedTokens: error ? 0 : selection.estimatedTokens,
      characterBudget: selection?.characterBudget ?? 0,
      tokenBudget: selection?.tokenBudget ?? 0,
      error,
      createdAt: nowIso(now),
    });
  };

  function commitPrequelIfCurrent(operation) {
    if (!operation?.prequelSelection?.injectionText) return { ok: true, committed: false, snapshot: null };
    if (operation.token !== epoch || operation.controller.signal.aborted) return { ok: false, reason: abortReason(operation) };
    const snapshot = hostAdapter.snapshot();
    const user = latestUser(snapshot);
    if (currentHostChatId(snapshot) !== operation.hostChatId) return { ok: false, reason: 'chatChanged' };
    if (user?.index !== operation.user.index || user.message !== operation.user.message || user.message.mes !== operation.userText) return { ok: false, reason: 'userChanged' };
    if (liveRecallFrameKey(snapshot) !== operation.liveFrameKey) return { ok: false, reason: 'narrativeChanged' };
    promptPrequel(operation.prequelSelection.injectionText, operation.token, snapshot.context, { chatId: operation.chatId, hostChatId: operation.hostChatId });
    return { ok: true, committed: true, snapshot, user };
  }

  async function persistReceipt(snapshot, user, receipt) {
    const context = snapshot.context;
    if (typeof context?.saveChat !== 'function') return 'sessionOnly';
    const currentExtra = user.message.extra && typeof user.message.extra === 'object' && !Array.isArray(user.message.extra) ? user.message.extra : {};
    const hadPrevious = Object.hasOwn(currentExtra, RECALL_RECEIPT_KEY);
    const previousReceipt = currentExtra[RECALL_RECEIPT_KEY];
    const candidate = clone(receipt);
    user.message.extra = { ...currentExtra, [RECALL_RECEIPT_KEY]: candidate };
    try { await context.saveChat(); return 'saveUnconfirmed'; }
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
    return [session, stored].filter((value, index, values) => value && typeof value === 'object' && values.indexOf(value) === index);
  }

  async function commitPromptIfCurrent({ operation, source, receipt, selectedFloors, selectedStates, selectedCseChanges = [], timeDependencies, userIndex, userFingerprint, hostGuard, injectionText }) {
    let finalReceipt = receipt, liveTime;
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
    const verifyHostCoverage = source.readiness !== null && source.readiness !== undefined;
    const canReadRoot = typeof store.readRoot === 'function';
    const rootResult = canReadRoot ? await store.readRoot() : null;
    const rootError = canReadRoot ? technicalSourceError(rootResult) : null;
    if (rootError) throw rootError;
    let currentSource = source;
    const sameRoot = rootResult?.status === 'ready'
      && rootResult.revision === source.rootRevision
      && rootResult.data?.chatId === source.chatId
      && rootResult.data?.narrativeGeneration === source.narrativeGeneration
      && rootResult.data?.headCheckpointId === source.headCheckpointId;
    if (!sameRoot) {
      if (canReadRoot) currentSource = await basePreparedSource(verifyHostCoverage ? before : null, currentSanitizerOptions(), { fresh: true, operation, rootResult });
      else {
        currentSource = await sourceReader({
          store,
          now,
          hostSnapshot: verifyHostCoverage ? before : null,
          sanitizerOptions: currentSanitizerOptions(),
          realtimeOrigin: hasRealtimeOrigin(),
        });
      }
      if (currentSource?.status !== 'ready') {
        const sourceError = technicalSourceError(currentSource);
        if (sourceError) throw sourceError;
        return { ok: false, reason: currentSource?.status === 'stale' ? 'sourceStale' : 'sourceUnavailable' };
      }
      if (canReadRoot && (currentSource.rootRevision !== rootResult.revision
        || currentSource.chatId !== rootResult.data?.chatId
        || currentSource.narrativeGeneration !== rootResult.data?.narrativeGeneration
        || currentSource.headCheckpointId !== rootResult.data?.headCheckpointId)) return { ok: false, reason: 'sourceUnavailable' };
      if (currentSource.chatId !== source.chatId) return { ok: false, reason: 'chatChanged' };
      if (currentSource.narrativeGeneration !== source.narrativeGeneration) return { ok: false, reason: 'narrativeChanged' };
      currentSource = Object.freeze({ ...currentSource, bodyMatch: await attachCoreBodyMatch(currentSource, operation.coreBodyWitness, before, operation.sanitizerOptions, fingerprint) });
    }
    if (!timeDependenciesValid(timeDependencies)) return { ok: false, reason: 'selectedRefsChanged' };
    if (timeDependencies.mode === 'projection' || timeDependencies.corrections.length || timeDependencies.reminders.length) {
      liveTime = currentSource.timeProjection;
      if (typeof timeProjectionProvider === 'function') {
        try { liveTime = await timeProjectionProvider(currentSource); }
        catch (error) { liveTime = null; logger?.warn?.('[qianqianjie] optional time projection check failed', { code: error?.code ?? error?.name ?? 'QQJ_TIME_READ_FAILED' }); }
      }
      if (!timeDependenciesCurrent(timeDependencies, liveTime)) {
        finalReceipt = withoutStaleTime(receipt, currentSource, liveTime);
        if (!finalReceipt) return { ok: false, reason: 'selectedRefsChanged' };
        injectionText = finalReceipt.injectionText;
      }
    }
    currentSource = await attachQianshiProgress(Object.freeze({ ...currentSource, timeProjection: liveTime ?? currentSource.timeProjection }), operation.queryContext, before);
    if (!qianshiProgressCurrent(finalReceipt.qianshiProgress, currentSource.qianshiProgress)) {
      injectionText = removeQianshiProgress(injectionText, finalReceipt.qianshiProgress);
      finalReceipt = { ...finalReceipt, qianshiProgress: null, injectionText,
        stages: stagesWithoutQianshi(finalReceipt.stages, finalReceipt.qianshiProgress, injectionText),
        completionStatus: injectionText ? 'ready' : 'empty',
        skipReasons: [...new Set([...(finalReceipt.skipReasons ?? []), 'optionalQianshiChanged'])] };
    }
    if (!sourceRefsValid({ selectedFloors, selectedStates, selectedCseChanges }, currentSource)) return { ok: false, reason: 'selectedRefsChanged' };
    const selectedSourceGuards = captureSelectedSourceGuards({ selectedFloors, selectedStates, selectedCseChanges }, currentSource, before);
    if (selectedSourceGuards === null) return { ok: false, reason: 'selectedRefsChanged' };
    const bodyGuardSanitizer = currentSanitizerOptions();
    const coveredBodyGuards = await captureCoveredBodyGuards(source, currentSource, before, bodyGuardSanitizer, fingerprint);
    if (coveredBodyGuards === null) return { ok: false, reason: 'narrativeChanged' };
    if (operation.token !== epoch || operation.controller.signal.aborted) return { ok: false, reason: abortReason(operation) };
    // This is the final synchronous commit point. No promise/microtask boundary may be
    // inserted between the host-visible snapshot checks and setExtensionPrompt.
    const after = hostAdapter.snapshot();
    const afterUser = latestUser(after);
    const selectedSourcesCurrent = selectedSourceGuardsCurrent(selectedSourceGuards, source.chatId, after);
    const current = operation.token === epoch
      && !operation.controller.signal.aborted
      && currentHostChatId(after) === operation.hostChatId
      && currentChatId(after) === source.chatId
      && afterUser?.index === userIndex
      && afterUser.message === hostGuard.userMessage
      && afterUser.message === beforeUser.message
      && afterUser.message.mes === hostGuard.userText
      && liveRecallFrameKey(after) === operation.liveFrameKey
      && selectedSourcesCurrent
      && coveredBodyGuardsCurrent(coveredBodyGuards, after, bodyGuardSanitizer);
    if (!current) {
      if (operation.token !== epoch || operation.controller.signal.aborted) return { ok: false, reason: abortReason(operation) };
      if (currentChatId(after) !== source.chatId) return { ok: false, reason: 'chatChanged' };
      if (afterUser?.index !== userIndex || afterUser?.message !== hostGuard.userMessage || afterUser?.message?.mes !== hostGuard.userText) return { ok: false, reason: 'userChanged' };
      if (!selectedSourcesCurrent) return { ok: false, reason: 'selectedRefsChanged' };
      return { ok: false, reason: 'narrativeChanged' };
    }
    if (liveTime?.currentBodyWitness) {
      const witness = liveTime.currentBodyWitness;
      const message = after.chat?.[witness.hostLocator.messageIndex];
      if (!message || message.is_system === true || message.is_hidden === true || message.hidden === true
        || !coveredBodyGuardsCurrent([witness], after, bodyGuardSanitizer)) {
        finalReceipt = withoutStaleTime(finalReceipt, currentSource, null);
        if (!finalReceipt) return { ok: false, reason: 'selectedRefsChanged' };
        injectionText = finalReceipt.injectionText;
      }
    }
    const binding = { chatId: source.chatId, hostChatId: operation.hostChatId };
    if (injectionText) prompt(injectionText, operation.token, after.context, binding);
    if (operation.prequelSelection?.injectionText) {
      promptPrequel(operation.prequelSelection.injectionText, operation.token, after.context, binding);
      operation.prequelCommitted = true;
    }
    return { ok: true, snapshot: after, user: afterUser, receipt: finalReceipt };
  }

  function runtimeDiagnostic(operation, timings, retainCompleted = false) {
    const attempts = operation.diagnostics ?? [];
    const latest = [...attempts].reverse();
    const chosen = retainCompleted ? latest.find(value => ['completed', 'receiptCandidate', 'reused'].includes(value.selectionStatus)) ?? latest.find(value => value.coverage) ?? attempts.at(-1) : attempts.at(-1);
    return { coverage: chosen?.coverage ?? null, stages: chosen?.stages ?? null, selectorDiagnostic: chosen?.selectorDiagnostic ?? null,
      selectionStatus: chosen?.selectionStatus ?? 'notStarted', diagnosticAttempt: chosen?.attempt ?? null, diagnosticPhase: chosen?.phase ?? operation.phase,
      attemptDiagnostics: Object.freeze(attempts.map(value => Object.freeze({ attempt: value.attempt, phase: value.phase, selectionStatus: value.selectionStatus,
        coverage: value.coverage, stages: value.stages, selectorDiagnostic: value.selectorDiagnostic, error: value.error ?? null, timings: clone(value.timings ?? timings) }))),
      timings: Object.freeze({ ...(chosen?.timings ?? timings), totalMs: Date.now() - operation.started }) };
  }

  async function intercept(coreChat, contextSize, abort, rawType) {
    const token = ++epoch;
    active?.controller.abort('superseded');
    clearSlot();
    const type = SUPPORTED_TYPES.has(rawType) ? rawType : rawType === undefined ? 'normal' : String(rawType ?? 'normal');
    const lifecycle = generationQueue.find(value => value.token === null && value.type === type);
    if (lifecycle) lifecycle.token = token;
    const operation = { token, type, phase: 'input', controller: new AbortController(), started: Date.now(), diagnostics: [] };
    lastRecall = null; lastPrequel = null; lastRecallBinding = null;
    active = operation; lastError = null; notify();
    const timings = {};
    const stopForFinalSafety = reason => {
      if (!['chatChanged', 'userChanged', 'stopped', 'superseded', 'disabled'].includes(reason)) {
        try { notifyUser?.({ kind: 'warning', text: '生成前记忆来源发生变化，本轮已放弃旧记忆注入，正文继续生成。' }); } catch { /* notification must not affect recall */ }
      }
      return finishStale(operation, timings, reason);
    };
    const coreInput = Array.isArray(coreChat) ? coreChat : [];
    coreChat = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      for (const key of Object.keys(timings)) delete timings[key];
      const diagnostic = { attempt: attempt + 1, phase: 'input', selectionStatus: 'notStarted', coverage: null, stages: null, selectorDiagnostic: null, started: Date.now() };
      operation.diagnostics.push(diagnostic);
      try {
      if (lifecycle?.stopped) return finishStale(operation, timings, 'stopped');
      if (!enabled()) return finishSkipped(operation, 'disabled', timings);
      if (!SUPPORTED_TYPES.has(type)) return finishSkipped(operation, ['quiet', 'impersonate'].includes(type) ? type : 'unsupportedGenerationType', timings);
      const before = hostAdapter.snapshot();
      const user = latestUser(before);
      if (!user) return finishSkipped(operation, 'emptyUserInput', timings);
      operation.user = user;
      operation.chatId = currentChatId(before);
      operation.hostChatId = currentHostChatId(before);
      operation.userText = user.message.mes;
      operation.liveFrameKey = liveRecallFrameKey(before);
      const sanitizerSnapshot = currentSanitizerOptions();
      const queryContext = queryBuilder({ coreChat: coreInput, assistantTurns: 1 });
      operation.queryContext = queryContext;
      operation.prequelSourceText = currentPrequelText(before);
      operation.prequelSelection = selectPrequel({ text: operation.prequelSourceText, queryContext, contextSize });
      const coreBodyWitness = await captureCoreBodyWitness(coreInput, sanitizerSnapshot, fingerprint);
      operation.coreBodyWitness = coreBodyWitness;
      operation.sanitizerOptions = sanitizerSnapshot;
      const hostGuard = { userMessage: user.message, userText: user.message.mes };
      if (!queryContext.latestUserText) return finishSkipped(operation, 'emptyUserInput', timings);
      const inputStarted = Date.now();
      const [userFingerprint, baseQueryFingerprint] = await Promise.all([fingerprint(user.message.mes), fingerprint(queryContext.text)]);
      timings.inputMs = Date.now() - inputStarted;
      operation.phase = diagnostic.phase = 'source'; notify();
      const sourceStarted = Date.now();
      const readSource = await preparedSource(before, sanitizerSnapshot, { fresh: attempt > 0, operation });
      let source = readSource?.status === 'ready'
        ? Object.freeze({ ...readSource, bodyMatch: await attachCoreBodyMatch(readSource, coreBodyWitness, before, sanitizerSnapshot, fingerprint) })
        : readSource;
      if (source?.status === 'ready') source = await attachQianshiProgress(source, queryContext, before);
      timings.sourceMs = Date.now() - sourceStarted;
      if (source?.sourceReadAttempts) timings.sourceReadAttempts = clone(source.sourceReadAttempts);
      if (source?.status === 'ready') diagnostic.coverage = clone(source.coverage);
      if (source.status !== 'ready') {
        const reason = source.status === 'timeout' ? 'memoryPreparationTimeout'
          : source.sourceReadAttempts?.exitPoint === 'memoryPreparationFailed' ? 'memoryPreparationFailed'
            : source.status === 'stale' ? 'sourceStale' : 'sourceUnavailable';
        const sourceError = technicalSourceError(source);
        if (sourceError) throw sourceError;
        const prequelCommit = commitPrequelIfCurrent(operation);
        if (!prequelCommit.ok) return finishStale(operation, timings, prequelCommit.reason);
        operation.prequelCommitted = prequelCommit.committed;
        if (source.status !== 'uninitialized') {
          const detail = publicErrorMessage(source.error, { fallback: source.error ? '记忆来源读取失败。' : '' });
          try { notifyUser?.({ kind: 'warning', text: `${source.status === 'timeout' ? '当前聊天记忆在 5 秒内未准备完成' : '当前聊天记忆暂时无法读取'}，本轮不注入普通记忆，正文继续生成。${detail ? ` ${detail}` : ''}` }); } catch { /* notification must not affect recall */ }
        }
        return finishSkipped(operation, reason, timings);
      }
      const partialReasons = readinessReasons(source);
      if (source.readiness?.status === 'unknown' && source.readiness.hostConfirmed !== true) {
        try { notifyUser?.({ kind: 'warning', text: '当前聊天记忆与正文的对应关系尚未确认，本轮不注入无法核实归属的记忆，正文继续生成。' }); } catch { /* notification must not affect recall */ }
        const prequelCommit = commitPrequelIfCurrent(operation);
        if (!prequelCommit.ok) return finishStale(operation, timings, prequelCommit.reason);
        operation.prequelCommitted = prequelCommit.committed;
        return finishSkipped(operation, partialReasons.length ? partialReasons : ['memoryNotReady', 'coverageUnconfirmed'], timings);
      }
      if (partialReasons.length) {
        source = Object.freeze({ ...source, degradedReasons: Object.freeze([...new Set([...(source.degradedReasons ?? []), ...partialReasons])]) });
      }
      const projection = source.identityProjection ?? {};
      const hasIdentityProjection = Object.keys(projection.identityRedirectsByEntityId ?? {}).length > 0
        || (projection.deletedEntityIds ?? []).length > 0;
      const prequelQueryFingerprint = operation.prequelSelection.injectionText
        ? await fingerprint(JSON.stringify([baseQueryFingerprint, operation.prequelSelection.injectionText, operation.prequelSelection.estimatedTokens, operation.prequelSelection.estimatedCharacters]))
        : baseQueryFingerprint;
      const identityQueryFingerprint = hasIdentityProjection
        ? await fingerprint(JSON.stringify([prequelQueryFingerprint, projection]))
        : prequelQueryFingerprint;
      const queryFingerprint = source.timeProjection?.fingerprint
        ? await fingerprint(JSON.stringify([identityQueryFingerprint, source.timeProjection.fingerprint])) : identityQueryFingerprint;
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
          if (snapshot?.selectorDiagnostic?.mode === 'fallback') continue;
          if (snapshot) { candidate = snapshot; break; }
        }
        if (candidate) {
          diagnostic.selectionStatus = 'receiptCandidate'; diagnostic.coverage = clone(candidate.coverage); diagnostic.stages = clone(candidate.stages); diagnostic.selectorDiagnostic = clone(candidate.selectorDiagnostic);
          operation.phase = diagnostic.phase = 'commit';
          const committed = await commitPromptIfCurrent({ operation, source, receipt: candidate, selectedFloors: candidate.selectedFloors, selectedStates: candidate.selectedStates, selectedCseChanges: candidate.selectedCseChanges, timeDependencies: candidate.timeDependencies, userIndex: user.index, userFingerprint, hostGuard, injectionText: candidate.injectionText });
          if (!committed.ok) return stopForFinalSafety(committed.reason);
          if (committed.receipt !== candidate) {
            candidate = { ...committed.receipt, receiptFingerprint: await fingerprint(JSON.stringify(receiptMaterial(committed.receipt))) };
            if (token !== epoch || operation.controller.signal.aborted) return finishStale(operation, timings);
            candidate.receiptPersistence = await persistReceipt(committed.snapshot, committed.user, candidate);
            if (token !== epoch || operation.controller.signal.aborted) return finishStale(operation, timings);
            sessionReceipt = Object.freeze({ key, receipt: candidate });
          }
          diagnostic.stages = clone(candidate.stages);
          diagnostic.selectorDiagnostic = clone(candidate.selectorDiagnostic);
          if (partialReasons.length) {
            try { notifyUser?.({ kind: 'warning', text: candidate.injectionText
              ? '当前聊天仍有摘要或人物状态缺口；本轮已使用能确认归属的已保存记忆，正文继续生成。'
              : '当前聊天仍有摘要或人物状态缺口；本轮没有找到可注入的已保存记忆，正文继续生成。' }); } catch { /* notification must not affect recall */ }
          }
          if (token !== epoch || operation.controller.signal.aborted) return finishStale(operation, timings);
          timings.totalMs = Date.now() - operation.started;
          const displayedCandidate = partialReasons.length ? { ...candidate, skipReasons: [...new Set([...(candidate.skipReasons ?? []), ...partialReasons])] } : candidate;
          diagnostic.selectionStatus = 'reused'; diagnostic.timings = clone(timings);
          lastRecall = Object.freeze({ ...stateFromReceipt(displayedCandidate, { generationType: type, timings }), ...runtimeDiagnostic(operation, timings) });
          if (operation.prequelCommitted) lastPrequel = prequelState(operation);
          bindLastRecall(committed.snapshot, committed.user); lastError = null; active = null; notify(); return getState();
        }
      }
      operation.phase = diagnostic.phase = 'selecting'; diagnostic.selectionStatus = 'incomplete'; notify();
      const selectorStarted = Date.now();
      let selection;
      const qianshiCharacters = qianshiBlock(source.qianshiProgress).length;
      const qianshiTokens = reservedQianshiTokenBudget(source.qianshiProgress);
      try { selection = await selectionRunner({ source, queryContext, contextSize, signal: operation.controller.signal,
        reservedTokens: operation.prequelSelection.estimatedTokens + qianshiTokens,
        reservedCharacters: operation.prequelSelection.estimatedCharacters + qianshiCharacters }); }
      finally { timings.selectorMs = Date.now() - selectorStarted; }
      if (token !== epoch || operation.controller.signal.aborted) return finishStale(operation, timings);
      let receiptBase = {
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
        qianshiProgress: source.qianshiProgress ? clone(source.qianshiProgress) : null,
        timeDependencies: clone(selection.timeDependencies ?? { mode: 'projection', fingerprint: source.timeProjection?.fingerprint ?? null }),
        selectedFloors: selection.floors.map(value => ({ floorId: value.floorId, floorMemoryId: value.floorMemoryId, assistantSeq: value.assistantSeq, reasons: [...value.reasons] })),
        selectedStates: selection.states.map(value => ({
          stateId: value.stateId, sourceFloorId: value.sourceFloorId, sourceDeltaId: value.sourceDeltaId,
          subjectEntityId: value.subjectEntityId, subject: value.subject, layer: value.layer,
          towardEntityId: value.towardEntityId, toward: value.toward, text: value.text, reason: value.reason,
          visibility: value.visibility, sourceAssistantSeq: value.sourceAssistantSeq, storylineId: value.storylineId,
        })),
        selectedCseChanges: (selection.cseChanges ?? []).map(value => ({
          deltaId: value.deltaId, floorId: value.floorId, assistantSeq: value.assistantSeq,
          subjectEntityId: value.subjectEntityId, subject: value.subject, layer: value.layer, action: value.action,
          storylineId: value.storylineId,
          relationEvidence: value.relationEvidence,
          before: value.before ? { stateId: value.before.stateId, sourceFloorId: value.before.sourceFloorId, sourceDeltaId: value.before.sourceDeltaId, text: value.before.text, visibility: value.before.visibility, reason: value.before.reason, origin: value.before.origin, towardEntityId: value.before.towardEntityId, sourceAssistantSeq: value.before.sourceAssistantSeq } : null,
          after: value.after ? { stateId: value.after.stateId, sourceFloorId: value.after.sourceFloorId, sourceDeltaId: value.after.sourceDeltaId, text: value.after.text, visibility: value.after.visibility, reason: value.after.reason, origin: value.after.origin, towardEntityId: value.after.towardEntityId, sourceAssistantSeq: value.after.sourceAssistantSeq } : null,
        })),
        storylines: (selection.storylines ?? []).map(value => ({ storylineId: value.storylineId, title: value.title, basis: value.basis })),
        selectorDiagnostic: selectorDiagnosticSnapshot(selection.selectorDiagnostic),
        coverage: clone(selection.coverage ?? source.coverage),
        injectionText: appendQianshiProgress(selection.injectionText, source.qianshiProgress),
        stages: selection.stages ? {
          ...clone(selection.stages),
          stateCount: Number.isSafeInteger(selection.stages.stateCount) ? selection.stages.stateCount : selection.states.length,
          timeReminderCount: selection.stages.timeReminderCount ?? 0,
          timeCorrectionCount: selection.stages.timeCorrectionCount ?? 0,
          timeBudgetDropped: selection.stages.timeBudgetDropped ?? 0,
          currentStateCount: Number.isSafeInteger(selection.stages.currentStateCount) ? selection.stages.currentStateCount : selection.states.length,
          cseChangeCount: Number.isSafeInteger(selection.stages.cseChangeCount) ? selection.stages.cseChangeCount : (selection.cseChanges ?? []).length,
          linkedHistoryItemCount: Number.isSafeInteger(selection.stages.linkedHistoryItemCount) ? selection.stages.linkedHistoryItemCount : 0,
          linkedCseChangeCount: Number.isSafeInteger(selection.stages.linkedCseChangeCount) ? selection.stages.linkedCseChangeCount : 0,
          budgetDroppedCount: Number.isSafeInteger(selection.stages.budgetDroppedCount) ? selection.stages.budgetDroppedCount : 0,
          finalInjectionItemCount: Number.isSafeInteger(selection.stages.finalInjectionItemCount)
            ? selection.stages.finalInjectionItemCount
            : selection.floors.reduce((sum, floor) => sum + (floor.items?.length ?? 1), 0) + selection.states.length + (selection.cseChanges ?? []).length,
          storylineCount: Number.isSafeInteger(selection.stages.storylineCount) ? selection.stages.storylineCount : (selection.storylines ?? []).length,
          estimatedTokenCount: estimateRecallTokens(appendQianshiProgress(selection.injectionText, source.qianshiProgress)),
          estimatedTokenBudget: (Number.isSafeInteger(selection.stages.estimatedTokenBudget) ? selection.stages.estimatedTokenBudget : 0) + qianshiTokens,
          ...(source.qianshiProgress ? { qianshiTokenBudget: qianshiTokens } : {}),
        } : null,
        timings: receiptTimingSnapshot(timings),
        skipReasons: [...new Set([...(selection.skipReasons ?? []), ...partialReasons])],
        createdAt: nowIso(now),
      };
      if (receiptBase.timeDependencies.mode === 'selected' && (receiptBase.timeDependencies.corrections.length || receiptBase.timeDependencies.reminders.length) && selection.limits) {
        receiptBase.timeDependencies.renderPlan = { floors: selection.floors.map(({ floorId, floorMemoryId, assistantSeq, reasons, chronology, items }) => ({ floorId, floorMemoryId, assistantSeq, reasons: [...reasons], chronology: clone(chronology),
          items: items.map(({ rankScore, rankBranches, rankEntityBranches, ...item }) => clone(item)) })), limits: { maxCharacters: selection.limits.maxCharacters, estimatedTokenBudget: selection.limits.estimatedTokenBudget } };
      }
      receiptBase.completionStatus = receiptBase.injectionText ? 'ready' : 'empty';
      diagnostic.selectionStatus = 'completed'; diagnostic.coverage = clone(receiptBase.coverage); diagnostic.stages = clone(receiptBase.stages); diagnostic.selectorDiagnostic = clone(receiptBase.selectorDiagnostic);
      operation.phase = diagnostic.phase = 'commit';
      const committed = await commitPromptIfCurrent({ operation, source, receipt: receiptBase, selectedFloors: receiptBase.selectedFloors, selectedStates: receiptBase.selectedStates, selectedCseChanges: receiptBase.selectedCseChanges, timeDependencies: receiptBase.timeDependencies, userIndex: user.index, userFingerprint, hostGuard, injectionText: receiptBase.injectionText });
      if (!committed.ok) return stopForFinalSafety(committed.reason);
      receiptBase = committed.receipt;
      diagnostic.stages = clone(receiptBase.stages);
      diagnostic.selectorDiagnostic = clone(receiptBase.selectorDiagnostic);
      if (partialReasons.length) {
        try { notifyUser?.({ kind: 'warning', text: receiptBase.injectionText
          ? '当前聊天仍有摘要或人物状态缺口；本轮已使用能确认归属的已保存记忆，正文继续生成。'
          : '当前聊天仍有摘要或人物状态缺口；本轮没有找到可注入的已保存记忆，正文继续生成。' }); } catch { /* notification must not affect recall */ }
      }
      if (token !== epoch || operation.controller.signal.aborted) return finishStale(operation, timings);
      const sealedReceipt = Object.freeze({ ...receiptBase, receiptFingerprint: await fingerprint(JSON.stringify(receiptMaterial(receiptBase))) });
      if (token !== epoch || operation.controller.signal.aborted) return finishStale(operation, timings);
      operation.phase = diagnostic.phase = 'receipt'; notify();
      const sessionCandidate = Object.freeze({ key, receipt: Object.freeze({ ...sealedReceipt, receiptPersistence: 'sessionOnly' }) });
      sessionReceipt = sessionCandidate;
      const receiptStarted = Date.now();
      const receiptPersistence = await persistReceipt(committed.snapshot, committed.user, sealedReceipt);
      timings.receiptMs = Date.now() - receiptStarted;
      const receipt = Object.freeze({ ...sealedReceipt, receiptPersistence });
      if (sessionReceipt === sessionCandidate) {
        sessionReceipt = Object.freeze({ key, receipt });
      }
      if (token !== epoch || operation.controller.signal.aborted) return finishStale(operation, timings);
      timings.totalMs = Date.now() - operation.started;
      diagnostic.timings = clone(timings);
      lastRecall = Object.freeze({ ...stateFromReceipt(receipt, { generationType: type, reusedReceipt: false, timings }), ...runtimeDiagnostic(operation, timings) });
      if (operation.prequelCommitted) lastPrequel = prequelState(operation);
      bindLastRecall(committed.snapshot, committed.user);
      lastError = null; active = null; notify(); return getState();
      } catch (error) {
      if (token !== epoch || operation.controller.signal.aborted) return finishStale(operation, timings);
      clearSlot(token);
      operation.prequelCommitted = false;
      lastPrequel = null;
      const safe = Object.freeze({ code: clean(error?.code ?? error?.name ?? 'V3_RECALL_FAILED', 120), message: clean(error?.message ?? '召回失败，已安全停止。', 500) });
      diagnostic.error = safe; diagnostic.timings = clone({ ...timings, totalMs: Date.now() - diagnostic.started });
      if (attempt === 0) {
        try { notifyUser?.({ kind: 'warning', text: '记忆召回未完成，正在重试一次。' }); } catch { /* notification must not affect recall */ }
        continue;
      }
      lastError = safe;
      lastRecall = Object.freeze({ status: 'error', userMessageIndex: operation.user?.index ?? null, generationType: type, coverage: null, selectedFloors: Object.freeze([]), selectedStates: Object.freeze([]), selectedCseChanges: Object.freeze([]), selectorDiagnostic: null, injectionText: '', reusedReceipt: false, restoredReceipt: false, receiptPersistence: 'none', stages: null, ...runtimeDiagnostic(operation, timings, true), skipReasons: Object.freeze(['error']), error: safe, createdAt: nowIso(now) });
      bindOperationRecall(operation);
      try { notifyUser?.({ kind: 'warning', text: `记忆召回重试后仍失败，已停止正文生成：${publicErrorMessage({ code: safe.code, message: safe.message }, { fallback: '记忆召回失败，请稍后重试。' })}` }); } catch { /* notification must not affect recall */ }
      active = null;
      if (typeof abort === 'function') abort(true);
      logger?.warn?.('[qianqianjie] V3 recall failed after retry', { code: safe.code }); notify(); return getState();
      }
    }
  }

  function finishSkipped(operation, reason, timings) {
    if (operation.token !== epoch) return finishStale(operation, timings);
    timings.totalMs = Date.now() - operation.started;
    const reasons = Array.isArray(reason) ? reason : [reason];
    lastRecall = Object.freeze({ status: 'skipped', userMessageIndex: operation.user?.index ?? null, generationType: operation.type, coverage: null, selectedFloors: Object.freeze([]), selectedStates: Object.freeze([]), selectedCseChanges: Object.freeze([]), selectorDiagnostic: null, injectionText: '', reusedReceipt: false, restoredReceipt: false, receiptPersistence: 'none', stages: null, ...runtimeDiagnostic(operation, timings), skipReasons: Object.freeze([...reasons]), error: null, createdAt: nowIso(now) });
    if (operation.prequelCommitted) lastPrequel = prequelState(operation);
    bindOperationRecall(operation);
    active = null; notify(); return getState();
  }

  function finishStale(operation, timings, reason = abortReason(operation)) {
    if (active === operation) active = null;
    if (operation.token === epoch) {
      clearSlot(operation.token);
      lastRecall = Object.freeze({ status: 'stale', userMessageIndex: operation.user?.index ?? null, generationType: operation.type, coverage: null, selectedFloors: Object.freeze([]), selectedStates: Object.freeze([]), selectedCseChanges: Object.freeze([]), selectorDiagnostic: null, injectionText: '', reusedReceipt: false, restoredReceipt: false, receiptPersistence: 'none', stages: null, ...runtimeDiagnostic(operation, timings), skipReasons: Object.freeze([FINAL_REASONS.has(reason) ? reason : 'narrativeChanged']), error: null, createdAt: nowIso(now) }); lastPrequel = null;
      bindOperationRecall(operation);
      notify();
    }
    return getState();
  }

  function invalidate(reason = 'invalidated') {
    epoch += 1; active?.controller.abort(FINAL_REASONS.has(reason) ? reason : 'superseded'); active = null; sessionReceipt = null; generationQueue.length = 0; stoppedEndDebt = 0; clearSlot();
    lastRecall = null; lastPrequel = null; lastRecallBinding = null; lastError = null; notify();
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
    lastRecall = Object.freeze({ status: 'stale', userMessageIndex: operation.user?.index ?? null, generationType: operation.type, coverage: null, selectedFloors: Object.freeze([]), selectedStates: Object.freeze([]), selectedCseChanges: Object.freeze([]), selectorDiagnostic: null, injectionText: '', reusedReceipt: false, restoredReceipt: false, receiptPersistence: 'none', stages: null, timings: Object.freeze({ totalMs: Date.now() - operation.started }), skipReasons: Object.freeze([reason]), error: null, createdAt: nowIso(now) }); lastPrequel = null;
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
    if (generation && slotOwner === generation.token) clearSlot(generation.token, { preserveSnapshot: true });
    else if (!generation && slotOwner !== null && !active) clearSlot(slotOwner, { preserveSnapshot: true });
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
      if (!receiptSnapshot && [6, 7, 8, 9, 10, 11, 12, 13, 14, RECALL_RECEIPT_SCHEMA_VERSION].includes(receipt.schemaVersion)) {
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
  function clearCurrent() { clearSlot(); lastRecall = null; lastPrequel = null; lastRecallBinding = null; lastError = null; notify(); return getState(); }
  return Object.freeze({ intercept, bind, setEnabled, clearCurrent, restorePersistedReceipt, getPrequel, savePrequel, getState, getPromptSnapshot, invalidate, subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); } });
}
