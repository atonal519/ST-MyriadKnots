import { sha256 } from '../identity.js';
import { rawWitnessShape, rawWitnessValid, summaryWitnessShape, summaryWitnessValid } from './vector-source.js';
import { sanitizeSensitiveText, sanitizeTaskMetadata } from './safe-metadata.js';
import { projectRecallSource, readRecallSource } from './recall-source.js';
import { buildRecallQueryContext, buildRecallQueryFrame, formatRecallInjection, estimateRecallTokens } from './recall-selector.js';
import { selectRecallWithLlm } from './recall-llm-selector.js';
import { selectAssistantMessage } from './foundation-domain.js';
import { inspectMessageFloorAnchor } from './message-floor-anchor.js';
import { sanitizeMemoryContent } from '../memory-content-sanitizer.js';
import { PREQUEL_METADATA_KEY, PREQUEL_PROMPT_SLOT, selectPrequel } from './recall-prequel.js';
import { publicErrorMessage } from '../public-error.js';
import { normalizeAutoHideKeepAiCount } from '../settings.js';
import { createRecallRequestDiagnostic } from './recall-request-diagnostic.js';

export const RECALL_PROMPT_SLOT = 'qqj_v3_recalled_context';
export const RECALL_RECEIPT_KEY = 'qqj_v3_recall_receipt';
export const RECALL_RECEIPT_SCHEMA_VERSION = 17;
export const RECALL_STRATEGY_VERSION = 'continuity-v17';
const RECALL_PROMPT_DEPTH = 2;
const IDENTIFIED_RECALL_STRATEGIES = [RECALL_STRATEGY_VERSION, 'continuity-v16', 'continuity-v15', 'continuity-v14', 'continuity-v13', 'continuity-v12', 'continuity-v11'];

const SUPPORTED_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue']);
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
// 单次来源准备共用一个期限覆盖身份、root、读取与投影；期限内结束仍须完成后续来源版本核验。
const DEFAULT_PREPARATION_TIMEOUT_MS = 8000;
const RECALL_PRIORITY_STATUSES = new Set(['missing', 'empty', 'invalid', 'applied', 'timeGuard']);
const safePriorityKeys = values => Array.isArray(values) && values.length <= 8
  && values.every(key => typeof key === 'string' && /^[RC]\d{1,4}$/u.test(key))
  && new Set(values).size === values.length;
const priorityDiagnosticValid = value => value === undefined || (value && typeof value === 'object' && !Array.isArray(value)
  && RECALL_PRIORITY_STATUSES.has(value.status) && safePriorityKeys(value.keys) && safePriorityKeys(value.selectedKeys)
  && value.selectedKeys.every(key => value.keys.includes(key))
  && Number.isSafeInteger(value.ignoredCount) && value.ignoredCount >= 0 && value.ignoredCount <= 10000
  && (['missing', 'empty', 'invalid'].includes(value.status) ? value.keys.length === 0 : value.keys.length > 0));
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

async function sourceRefsValid(receipt, source, onInvalid = () => {}, selectedFloorsForValidation = null) {
  // 失败回调只附带首个可定位引用，不参与下面的布尔判定或读取链。
  const fail = reference => { try { onInvalid(reference); } catch { /* 诊断不能改变来源校验结果。 */ } return false; };
  if (!Array.isArray(source?.floorMemories) || !Array.isArray(source?.currentState) || !Array.isArray(receipt?.selectedFloors) || !Array.isArray(receipt?.selectedStates) || !Array.isArray(receipt?.selectedCseChanges)) return fail({ step: 'shape' });
  const sourceChanges = Array.isArray(source.cseChanges) ? source.cseChanges : [];
  const memories = new Map(source.floorMemories.map(memory => [`${memory.floorId}|${memory.floorMemoryId}|${memory.assistantSeq}`, memory]));
  for (let index = 0; index < receipt.selectedFloors.length; index += 1) {
    const value = receipt.selectedFloors[index];
    if (!value || typeof value !== 'object') return fail({ step: 'selectedReference', kind: 'floor', index });
    if (value.rawWitnesses?.length) {
      // 原文成员楼以实际楼号展示，所有权仍核对归档记忆；见证随回执签名并重新核验。
      for (let witnessIndex = 0; witnessIndex < value.rawWitnesses.length; witnessIndex += 1) {
        const witness = value.rawWitnesses[witnessIndex];
        if (witness.floorId !== value.floorId || witness.assistantSeq !== value.assistantSeq || witness.floorMemoryId !== value.floorMemoryId
          || !await rawWitnessValid(witness, source)) {
          return fail({ step: 'selectedReference', kind: 'rawWitness', index, witnessIndex, floorId: value.floorId, floorMemoryId: value.floorMemoryId,
            assistantSeq: value.assistantSeq, memoryFloorId: witness?.memoryFloorId });
        }
      }
      // 首次提交中的混合楼还依赖摘要/事实；原文见证不能替它们沿用已替换的归档版本。
      const selectedItems = selectedFloorsForValidation?.find(floor => floor?.floorId === value.floorId)?.items ?? [];
      if (selectedItems.some(item => !item.rawWitness) && !memories.has(`${value.floorId}|${value.floorMemoryId}|${value.assistantSeq}`)) {
        return fail({ step: 'selectedReference', kind: 'floor', index, floorId: value.floorId, floorMemoryId: value.floorMemoryId, assistantSeq: value.assistantSeq });
      }
    } else if (!memories.has(`${value.floorId}|${value.floorMemoryId}|${value.assistantSeq}`)) return fail({ step: 'selectedReference', kind: 'floor', index, floorId: value.floorId, floorMemoryId: value.floorMemoryId, assistantSeq: value.assistantSeq });
    // schema17旧回执可能含摘要向量见证；只按当前摘要校验其历史可恢复性。
    for (let witnessIndex = 0; witnessIndex < (value.summaryWitnesses ?? []).length; witnessIndex += 1) {
      const witness = value.summaryWitnesses[witnessIndex];
      if (!summaryWitnessShape(witness) || witness.floorId !== value.floorId || witness.assistantSeq !== value.assistantSeq
        || witness.floorMemoryId !== value.floorMemoryId || !memories.has(`${witness.memoryFloorId}|${witness.floorMemoryId}|${witness.memoryAssistantSeq}`)
        || !await summaryWitnessValid(witness, source)) return fail({ step: 'selectedReference', kind: 'summaryWitness', index, witnessIndex,
          floorId: value.floorId, floorMemoryId: value.floorMemoryId, assistantSeq: value.assistantSeq, memoryFloorId: witness?.memoryFloorId });
    }
  }
  const subjects = new Map(source.currentState.map(subject => [subject.subjectEntityId, subject]));
  for (let index = 0; index < receipt.selectedStates.length; index += 1) {
    const value = receipt.selectedStates[index];
    let valid = Boolean(value && typeof value === 'object' && ['core', 'adaptive', 'situational'].includes(value.layer));
    const subject = value && typeof value === 'object' ? subjects.get(value.subjectEntityId) : null;
    valid = valid && Array.isArray(subject?.[value.layer]) && subject[value.layer].some(item => (
      item.text === value.text && item.visibility === value.visibility && item.reason === value.reason
      && item.towardEntityId === (value.towardEntityId ?? null) && item.sourceAssistantSeq === (value.sourceAssistantSeq ?? null)
      && (!value.stateId || (item.stateId === value.stateId && (item.sourceFloorId ?? null) === (value.sourceFloorId ?? null) && (item.sourceDeltaId ?? null) === (value.sourceDeltaId ?? null)))
    ));
    if (!valid) return fail({ step: 'selectedReference', kind: 'state', index, subjectEntityId: value?.subjectEntityId, layer: value?.layer,
      stateId: value?.stateId, sourceFloorId: value?.sourceFloorId, sourceDeltaId: value?.sourceDeltaId, sourceAssistantSeq: value?.sourceAssistantSeq });
  }
  const stateEqual = (left, right) => left === null ? right === null : Boolean(right
    && left.text === right.text && left.visibility === right.visibility && left.reason === right.reason
    && left.origin === right.origin && (left.towardEntityId ?? null) === (right.towardEntityId ?? null)
    && (left.sourceAssistantSeq ?? null) === (right.sourceAssistantSeq ?? null)
    && (!left.stateId || (left.stateId === right.stateId && (left.sourceFloorId ?? null) === (right.sourceFloorId ?? null) && (left.sourceDeltaId ?? null) === (right.sourceDeltaId ?? null))));
  const entityNames = new Map((source.entities ?? []).map(entity => [entity.entityId, entity.displayName]));
  for (let index = 0; index < receipt.selectedCseChanges.length; index += 1) {
    const value = receipt.selectedCseChanges[index];
    if (!(value.subject === entityNames.get(value.subjectEntityId) && sourceChanges.some(change => change.deltaId === value.deltaId
    && change.floorId === value.floorId && change.assistantSeq === value.assistantSeq
    && change.subjectEntityId === value.subjectEntityId && change.layer === value.layer && change.action === value.action
    && stateEqual(value.before, change.before) && stateEqual(value.after, change.after)))) return fail({ step: 'selectedReference', kind: 'cseChange', index,
      deltaId: value?.deltaId, floorId: value?.floorId, assistantSeq: value?.assistantSeq, subjectEntityId: value?.subjectEntityId, layer: value?.layer, action: value?.action });
  }
  return true;
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
    if (value?.rawWitnesses?.length) { for (const witness of value.rawWitnesses) floorIds.add(witness.floorId); }
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

const receiptFloorRef = ({ floorId, floorMemoryId, assistantSeq, reasons, items = [] }) => {
  const rawWitnesses = items.map(item => item.rawWitness).filter(Boolean);
  return { floorId, floorMemoryId, assistantSeq, reasons: [...reasons], ...(rawWitnesses.length ? { rawWitnesses: clone(rawWitnesses) } : {}) };
};

const legacyReceiptMaterial = receipt => [
  receipt.schemaVersion, receipt.pluginVersion, receipt.chatId, receipt.narrativeGeneration, receipt.headCheckpointId, receipt.rootRevision,
  receipt.userMessageIndex, receipt.userContentFingerprint, receipt.queryFingerprint, receipt.generationType,
  receipt.selectedFloors, receipt.selectedStates, receipt.coverage, receipt.injectionText, receipt.stages, receipt.skipReasons, receipt.completionStatus, receipt.createdAt,
];
const baseReceiptMaterial = receipt => receipt.schemaVersion >= 15 && receipt.qianshiProgress
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
// 删除见证是可选的签名扩展，旧回执维持原签名；只记录选中事项的删除指纹，不复制全档删除清单。
const receiptMaterial = receipt => receipt.qianshiDeletionWitness === undefined ? baseReceiptMaterial(receipt)
  : [...baseReceiptMaterial(receipt), receipt.qianshiDeletionWitness];
async function qianshiDeletionWitness(receipt, deletedEvents, fingerprint) {
  const matterIds = [...new Set([...(receipt.qianshiProgress?.matterIds ?? []),
    ...(receipt.timeDependencies?.reminders ?? []).map(item => item.qianshiRef?.matterId).filter(Boolean)])];
  const byMatter = new Map();
  for (const event of deletedEvents) byMatter.set(event.matterId, [...(byMatter.get(event.matterId) ?? []), event.eventId]);
  return Promise.all(matterIds.map(async matterId => ({ matterId,
    fingerprint: await fingerprint(JSON.stringify([...(byMatter.get(matterId) ?? [])].sort())) })));
}

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
    && optionalBoundedString(item.sourceSignature, 20000)
    && (item.qianshiRef === undefined || item.qianshiRef && typeof item.qianshiRef === 'object' && !Array.isArray(item.qianshiRef)
      && boundedString(item.qianshiRef.matterId, 500) && boundedString(item.qianshiRef.originEventId, 500));
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

export function renderedQianshiProgressText(value, timeDependencies = null) {
  const source = typeof value?.text === 'string' ? value.text : '';
  const suppressed = new Set((timeDependencies?.reminders ?? []).map(item => item.qianshiRef?.matterId).filter(Boolean));
  if (!source || !suppressed.size || !Array.isArray(value?.matterIds) || !value.matterIds.length) return source;
  let matterIndex = 0;
  return source.split(/\n\n/u).map(section => {
    const lines = section.split('\n');
    if (lines[0] !== '[当前待接续]') return section;
    const kept = lines.slice(1).filter(line => {
      if (!line.startsWith('- ')) return true;
      const matterId = value.matterIds[matterIndex++];
      return !suppressed.has(matterId);
    });
    return kept.some(line => line.startsWith('- ')) ? [lines[0], ...kept].join('\n') : '';
  }).filter(Boolean).join('\n\n');
}
const qianshiBlock = (value, timeDependencies = null) => {
  const content = renderedQianshiProgressText(value, timeDependencies);
  return content ? `<qqj_qianshi_progress>\n${content}\n</qqj_qianshi_progress>` : '';
};
const appendQianshiProgress = (text, value, timeDependencies = null) => [String(text ?? '').trim(), qianshiBlock(value, timeDependencies)].filter(Boolean).join('\n\n');
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
const removeQianshiProgress = (text, value, timeDependencies = null) => {
  const block = qianshiBlock(value, timeDependencies);
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
    text = appendQianshiProgress(ordinaryText, receipt.qianshiProgress, dependencies);
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
  return { ...receipt, selectedFloors: floors.map(receiptFloorRef), selectedStates: states,
    selectedCseChanges: changes, storylines, timeDependencies: dependencies, injectionText: text, completionStatus: text ? 'ready' : 'empty', stages,
    selectorDiagnostic: receipt.selectorDiagnostic ? { ...receipt.selectorDiagnostic, historyRetainedCount: history.length, stateRetainedCount: states.length + changes.length } : null,
    skipReasons: [...new Set([...receipt.skipReasons, 'optionalTimeChanged'])] };
}
const selectorDiagnosticSnapshot = value => {
  const api = sanitizeTaskMetadata(value);
  const request = value?.semantic?.request;
  // 向量诊断进入原回执与封签，只复制白名单计数，旧回执无需新增字段。
  const projectVectorRequest = item => item && (['request', 'response', 'validation', 'complete'].includes(item.phase) || ['request_prepared', 'fetch_call_start', 'fetch_called', 'response_headers', 'response_body', 'aborted'].includes(item.pendingStage)) ? {
    phase: ['request', 'response', 'validation', 'complete'].includes(item.phase) ? item.phase : null,
    pendingStage: ['request_prepared', 'fetch_call_start', 'fetch_called', 'response_headers', 'response_body', 'complete', 'aborted'].includes(item.pendingStage) ? item.pendingStage : null,
    requestId: typeof item.requestId === 'string' && /^[a-z0-9-]{1,80}$/iu.test(item.requestId) ? item.requestId : null,
    startedAt: typeof item.startedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(item.startedAt) ? item.startedAt : null,
    inputCharacters: nonNegativeInteger(item.inputCharacters) ? item.inputCharacters : null,
    inputSha256: typeof item.inputSha256 === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/u.test(item.inputSha256) ? item.inputSha256 : null,
    httpStatus: Number.isSafeInteger(item.httpStatus) && item.httpStatus >= 100 && item.httpStatus <= 599 ? item.httpStatus : null,
    deadlineMs: finiteDuration(item.deadlineMs ?? item.timeoutMs) ? item.deadlineMs ?? item.timeoutMs : null,
    timeoutMs: finiteDuration(item.timeoutMs ?? item.deadlineMs) ? item.timeoutMs ?? item.deadlineMs : null,
    elapsedMs: finiteDuration(item.elapsedMs ?? item.durationMs) ? item.elapsedMs ?? item.durationMs : null,
    durationMs: finiteDuration(item.durationMs ?? item.elapsedMs) ? item.durationMs ?? item.elapsedMs : null,
    deadlineOverrunMs: finiteDuration(item.deadlineOverrunMs) ? item.deadlineOverrunMs : null,
    lastSuccessfulStage: ['request_prepared', 'fetch_called', 'response_headers', 'response_body', 'validated'].includes(item.lastSuccessfulStage) ? item.lastSuccessfulStage : null,
    timeoutOrigin: item.timeoutOrigin === 'vector_api_deadline' ? item.timeoutOrigin : null,
    abortOrigin: ['caller_signal', 'client_abort_all', 'vector_api_deadline'].includes(item.abortOrigin) ? item.abortOrigin : null,
    abortReason: ['stopped', 'superseded', 'chatChanged', 'userChanged', 'narrativeChanged', 'disabled', 'invalidated', 'timeout', 'indexReset', 'external'].includes(item.abortReason) ? item.abortReason : null,
    result: ['running', 'succeeded', 'timeout', 'failed', 'cancelled'].includes(item.result) ? item.result : null,
    errorCode: typeof item.errorCode === 'string' && /^VECTOR_[A-Z0-9_]{1,80}$/u.test(item.errorCode) ? item.errorCode : null,
    networkCode: typeof item.networkCode === 'string' && /^(?:UND_ERR_[A-Z0-9_]{1,56}|ERR_[A-Z0-9_]{2,56}|ECONN[A-Z0-9_]{2,56}|E(?:AI_AGAIN|ADDRNOTAVAIL|AFNOSUPPORT|HOSTUNREACH|NETUNREACH|PIPE|TIMEDOUT)|ENOTFOUND|ETIMEDOUT)$/u.test(item.networkCode) ? item.networkCode : null,
    providerRequestId: typeof item.providerRequestId === 'string' && (/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(item.providerRequestId) || /^[a-f0-9]{16,64}$/iu.test(item.providerRequestId)) ? item.providerRequestId : null,
    ...Object.fromEntries(['fetchCallMs', 'responseHeadersMs', 'responseBodyMs'].map(key => [key, finiteDuration(item[key]) ? item[key] : null])),
  } : null;
  const vectorRequest = projectVectorRequest(request);
  const vectorRequestAttempts = Array.isArray(value?.semantic?.requestAttempts)
    ? value.semantic.requestAttempts.slice(0, 2).map(projectVectorRequest).filter(Boolean) : null;
  const vectorRequestCount = nonNegativeInteger(value?.semantic?.requestCount) ? Math.min(2, value.semantic.requestCount) : null;
  return Object.freeze({
    mode: ['llm', 'fallback', 'local'].includes(value?.mode) ? value.mode : 'local',
    ...(value?.stageTimings && typeof value.stageTimings === 'object' ? { stageTimings: Object.freeze(Object.fromEntries(['semanticQuery', 'candidateBuild', 'utilityTask', 'responseParse', 'localSelection'].map(key => [key, finiteDuration(value.stageTimings[key]) ? value.stageTimings[key] : null]))) } : {}),
    ...(typeof value?.pendingStep === 'string' && ['semanticQuery', 'candidateBuild', 'utilityTask', 'responseParse', 'localSelection'].includes(value.pendingStep) ? { pendingStep: value.pendingStep } : {}),
    ...(typeof value?.lastCompletedStep === 'string' && ['semanticQuery', 'candidateBuild', 'utilityTask', 'responseParse', 'localSelection'].includes(value.lastCompletedStep) ? { lastCompletedStep: value.lastCompletedStep } : {}),
    ...(value?.semantic ? { semantic: { status: clean(value.semantic.status, 80), candidateCount: Math.min(12, Math.max(0, Number(value.semantic.candidateCount) || 0)), durationMs: Math.max(0, Number(value.semantic.durationMs) || 0),
      ...(vectorRequest ? { request: vectorRequest } : {}),
      ...(vectorRequestAttempts?.length ? { requestAttempts: vectorRequestAttempts, requestCount: vectorRequestCount,
        retryOutcome: ['not_retried', 'retrying', 'retry_succeeded', 'retry_failed', 'cancelled', 'budget_exhausted'].includes(value.semantic.retryOutcome) ? value.semantic.retryOutcome : null } : {}) } } : {}),
    code: value?.code ? clean(value.code, 120) : null,
    httpStatus: Number.isSafeInteger(value?.httpStatus) && value.httpStatus >= 0 ? value.httpStatus : null,
    formatStage: value?.formatStage ? clean(value.formatStage, 80) : null,
    finishReason: clean(value?.finishReason ?? api.finishReason, 32),
    source: api.source,
    sourceLabel: api.sourceLabel,
    model: api.model,
    transportAttempts: Number.isSafeInteger(value?.transportAttempts) && value.transportAttempts >= 0 ? value.transportAttempts : api.transportAttempts,
    sourceStage: clean(value?.sourceStage ?? api.sourceStage, 80),
    requestCharacters: nonNegativeInteger(value?.requestCharacters) ? value.requestCharacters : null,
    requestEstimatedTokens: nonNegativeInteger(value?.requestEstimatedTokens) ? value.requestEstimatedTokens : null,
    // Keep this absent on older receipts; adding a default would change their sealed digest.
    ...(priorityDiagnosticValid(value?.priority) && value?.priority !== undefined ? { priority: Object.freeze({
      status: value.priority.status, keys: Object.freeze([...value.priority.keys]), selectedKeys: Object.freeze([...value.priority.selectedKeys]),
      ignoredCount: Math.min(10000, value.priority.ignoredCount),
    }) } : {}),
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
  ...(timings.preparationAttempts ? { preparationAttempts: clone(timings.preparationAttempts) } : {}),
});
const PREPARATION_STAGES = ['identity', 'root', 'prepare', 'read', 'projection'];
const PREPARATION_DURATIONS = ['totalMs', 'budgetMs', ...PREPARATION_STAGES.map(stage => `${stage}Ms`)];
const preparationTimingsValid = value => value === undefined || (Array.isArray(value) && value.length <= 2 && value.every(item => item
  && ['source', 'commit'].includes(item.phase) && ['cached', 'fresh'].includes(item.mode)
  && PREPARATION_STAGES.includes(item.stage) && ['ready', 'timeout', 'stale', 'unavailable', 'disabled'].includes(item.status)
  && PREPARATION_DURATIONS.every(key => finiteDuration(item[key]))));
const stateChangeSideValid = (value, { identifiersRequired = false } = {}) => value === null || (value && typeof value === 'object' && !Array.isArray(value)
  && (!identifiersRequired || boundedString(value.stateId, 500))
  && (value.stateId === undefined || optionalBoundedString(value.stateId, 500))
  && (value.sourceFloorId === undefined || optionalBoundedString(value.sourceFloorId, 500))
  && (value.sourceDeltaId === undefined || optionalBoundedString(value.sourceDeltaId, 500))
  && boundedString(value.text, 4000) && ['private', 'observable', 'expressed', 'shared', 'authorial'].includes(value.visibility)
  && boundedString(value.reason, 4000, { empty: true }) && ['baseline', 'floor', 'reasonableProgression', 'manual'].includes(value.origin)
  && optionalBoundedString(value.towardEntityId, 500) && optionalPositiveInteger(value.sourceAssistantSeq));
function receiptShapeValid(receipt, { historical = false } = {}) {
  const expandedSelection = [RECALL_STRATEGY_VERSION, 'continuity-v16', 'continuity-v15'].includes(receipt?.strategyVersion);
  const receiptFloorLimit = expandedSelection ? MAX_RECEIPT_FLOORS : LEGACY_MAX_RECEIPT_FLOORS;
  const receiptStateLimit = expandedSelection ? MAX_RECEIPT_STATES : LEGACY_MAX_RECEIPT_STATES;
  const receiptChangeLimit = expandedSelection ? MAX_RECEIPT_CSE_CHANGES : LEGACY_MAX_RECEIPT_CSE_CHANGES;
  const receiptStorylineLimit = expandedSelection ? MAX_RECEIPT_STORYLINES : LEGACY_MAX_RECEIPT_STORYLINES;
  if (receipt?.qianshiDeletionWitness !== undefined && (!Array.isArray(receipt.qianshiDeletionWitness)
    || receipt.qianshiDeletionWitness.length > 160 + receiptStateLimit
    || !receipt.qianshiDeletionWitness.every(value => value && boundedString(value.matterId, 500) && boundedString(value.fingerprint, 200)))) return false;
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
      ? ![RECALL_STRATEGY_VERSION, 'continuity-v16', 'continuity-v15', 'continuity-v14', 'continuity-v13', 'continuity-v12', 'continuity-v11', 'continuity-v10', 'continuity-v9', 'continuity-v8', 'continuity-v7', 'continuity-v6', 'continuity-v5', 'continuity-v4', 'continuity-v3', 'continuity-v2', 'continuity-v1'].includes(receipt.strategyVersion)
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
    && (value.rawWitnesses === undefined || receipt.schemaVersion >= 17 && Array.isArray(value.rawWitnesses) && value.rawWitnesses.length > 0 && value.rawWitnesses.length <= 12
      && value.rawWitnesses.every(witness => rawWitnessShape(witness) && witness.floorId === value.floorId && witness.floorMemoryId === value.floorMemoryId && witness.assistantSeq === value.assistantSeq))
    // schema17旧回执继续按原形状读取；新 receiptFloorRef 不再写入该历史字段。
    && (value.summaryWitnesses === undefined || receipt.schemaVersion >= 17 && Array.isArray(value.summaryWitnesses) && value.summaryWitnesses.length <= 12
      && value.summaryWitnesses.every(witness => summaryWitnessShape(witness) && witness.floorId === value.floorId && witness.floorMemoryId === value.floorMemoryId && witness.assistantSeq === value.assistantSeq))
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
      || (IDENTIFIED_RECALL_STRATEGIES.includes(receipt.strategyVersion) && !['historyCandidateCount', 'stateCandidateCount', 'historyExcludedCount', 'stateExcludedCount', 'historyRetainedCount', 'stateRetainedCount'].every(key => diagnostic[key] === null || nonNegativeInteger(diagnostic[key])))
      || !(diagnostic.requestCharacters === null || diagnostic.requestCharacters === undefined || nonNegativeInteger(diagnostic.requestCharacters))
      || !(diagnostic.requestEstimatedTokens === null || diagnostic.requestEstimatedTokens === undefined || nonNegativeInteger(diagnostic.requestEstimatedTokens))
      || !priorityDiagnosticValid(diagnostic.priority)
      || !(diagnostic.sourceStage === undefined || boundedString(diagnostic.sourceStage, 80, { empty: true }))) return false;
    const timings = receipt.timings;
    if (!timings || typeof timings !== 'object' || Array.isArray(timings)
      || !['inputMs', 'sourceMs', 'selectorMs'].every(key => finiteDuration(timings[key]))
      || !preparationTimingsValid(timings.preparationAttempts)
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
      || ![6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, RECALL_RECEIPT_SCHEMA_VERSION].includes(snapshot.schemaVersion)
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
    // 实时楼内展示需沿用同一时间去重依据，否则千事尾块对不上会连带隐藏已召回旧事。
    timeDependencies: receipt.timeDependencies ? Object.freeze(clone(receipt.timeDependencies)) : null,
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
  if ([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, RECALL_RECEIPT_SCHEMA_VERSION].includes(receipt.schemaVersion)) {
    const snapshot = await historicalSignedReceiptValid(receipt, {
      chatId: chatId.trim(),
      userIndex: userMessageIndex,
      userFingerprint: await fingerprint(message.mes),
    }, fingerprint);
    return snapshot ? stateFromReceipt(snapshot, { restoredReceipt: true }) : null;
  }
  return legacyStateFromReceipt(receipt, { chatId: chatId.trim(), userIndex: userMessageIndex });
}

export async function captureCoreBodyWitness(coreChat, sanitizerOptions, fingerprint, maximumFloors = 3) {
  const chat = Array.isArray(coreChat) ? coreChat : [];
  const selected = [];
  // The same N that guides optional auto-hide defines recall's raw-body base,
  // even when auto-hide is off; it never changes which messages the host sends.
  for (let index = chat.length - 1; index >= 0 && selected.length < normalizeAutoHideKeepAiCount(maximumFloors); index -= 1) {
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

async function attachCoreBodyMatch(source, witness, snapshot, sanitizerOptions, fingerprint, maximumFloors = 3) {
  // Recent-body overlap is trusted only when message position, selected swipe, and raw/canonical fingerprints agree.
  const visibleFloorIds = [...new Set(source.readiness?.visibleSummaryFloorIds ?? [])].sort();
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
  const recentVisibleMessageIndexes = new Set();
  let recentVisibleCount = 0;
  for (let index = (snapshot?.chat?.length ?? 0) - 1; index >= 0 && recentVisibleCount < normalizeAutoHideKeepAiCount(maximumFloors); index -= 1) {
    const message = snapshot.chat[index];
    if (!message || message.is_system === true || message.is_hidden === true || message.hidden === true) continue;
    const selected = selectAssistantMessage(message);
    if (!selected?.rawContent?.trim() || !sanitizeMemoryContent(selected.rawContent, sanitizerOptions)) continue;
    recentVisibleMessageIndexes.add(index);
    recentVisibleCount += 1;
  }
  const recentVisibleFloorIds = [...new Set(verified.filter(ref => recentVisibleMessageIndexes.has(ref.liveIndex)).map(ref => ref.floorId))].sort();
  const materialFor = (covered, recentBodyFloorIds) => ({
    version: 3,
    covered: covered.map(item => [item.floorId, item.floorMemoryId, item.assistantSeq, item.rawFingerprint, item.canonicalFingerprint]),
    visibleFloorIds,
    recentBodyFloorIds,
  });
  const resultFor = async covered => {
    const recentBodyFloorIds = Object.freeze([...new Set([...covered.map(item => item.floorId), ...recentVisibleFloorIds])].sort());
    return Object.freeze({
    fingerprint: await fingerprint(JSON.stringify(materialFor(covered, recentBodyFloorIds))),
    witnessCount: witness.length,
    matchedCount: covered.length,
    coveredFloorIds: Object.freeze(covered.map(item => item.floorId)),
    coveredRefs: Object.freeze(covered.map(item => Object.freeze({ floorId: item.floorId, floorMemoryId: item.floorMemoryId, assistantSeq: item.assistantSeq }))),
    visibleFloorIds: Object.freeze(visibleFloorIds),
    recentBodyFloorIds,
  });
  };
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

export function createV3RecallRuntime({ store, hostAdapter, generateUtilityTask = null, isEnabled = true, memoryStatus = () => null, prepareMemory = null, preparationTimeoutMs = DEFAULT_PREPARATION_TIMEOUT_MS, realtimeOrigin = () => false, recentBodyFloorLimit = () => 3, notifyUser = null, sourceReader = readRecallSource, selector = null, semanticProvider = null, queryBuilder = buildRecallQueryContext, fingerprint = hashText, sanitizerOptions = () => ({}), identityProjectionProvider = null, timeProjectionProvider = null, qianshiProgressProvider = null, qianshiDeletionProvider = null, now = () => new Date(), pluginVersion, logger = console } = {}) {
  if (!store || typeof store.readReachable !== 'function') throw new TypeError('V3 recall store 无效');
  if (!hostAdapter || typeof hostAdapter.snapshot !== 'function') throw new TypeError('V3 recall host adapter 无效');
  if (typeof fingerprint !== 'function') throw new TypeError('V3 recall fingerprint 无效');
  let epoch = 0, generationSerial = 0, stoppedEndDebt = 0, active = null, slotOwner = null, prequelSlotActive = false, promptSnapshot = null, lastRecall = null, lastPrequel = null, lastError = null, lastRecallBinding = null, enabledOverride = null;
  const subscribers = new Set(), generationQueue = [];
  const requestDiagnostic = createRecallRequestDiagnostic();
  const receiptSaveCandidates = new WeakMap();
  let sessionReceipt = null, lastRecallReceiptOwner = null, lastTerminated = null;
  const enabled = () => { try { return enabledOverride ?? ((typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true); } catch { return false; } };
  const currentSanitizerOptions = () => { try { return typeof sanitizerOptions === 'function' ? sanitizerOptions() : sanitizerOptions; } catch { return {}; } };
  const hasRealtimeOrigin = () => { try { return (typeof realtimeOrigin === 'function' ? realtimeOrigin() : realtimeOrigin) === true; } catch { return false; } };
  const selectionRunner = typeof selector === 'function'
    ? selector
    : input => selectRecallWithLlm({ ...input, generateUtilityTask, semanticProvider, signal: input.signal });
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
    return Object.assign(new Error(detail || (status === 'timeout' ? '当前聊天记忆准备超时。' : '当前聊天记忆暂时无法读取。')), { code });
  };
  const matchesSourceRoot = (value, root) => root?.status === 'ready'
    && root.revision === value.rootRevision && root.data?.chatId === value.chatId
    && root.data?.narrativeGeneration === value.narrativeGeneration && root.data?.headCheckpointId === value.headCheckpointId;
  const sourceVersion = value => value && typeof value === 'object' ? { chatId: value.chatId ?? value.data?.chatId ?? null,
    narrativeGeneration: value.narrativeGeneration ?? value.data?.narrativeGeneration ?? null,
    revision: value.rootRevision ?? value.revision ?? null, headCheckpointId: value.headCheckpointId ?? value.data?.headCheckpointId ?? null } : null;
  async function basePreparedSource(snapshot, sanitizerSnapshot, { fresh = false, operation = null, rootResult = null, sourceToVerify = null } = {}) {
    const started = Date.now(), budgetMs = Math.max(1, Number(preparationTimeoutMs) || DEFAULT_PREPARATION_TIMEOUT_MS);
    const timing = { phase: sourceToVerify ? 'commit' : 'source', mode: fresh ? 'fresh' : 'cached', stage: 'identity', status: 'unavailable', totalMs: 0, budgetMs,
      identityMs: 0, rootMs: 0, prepareMs: 0, readMs: 0, projectionMs: 0 };
    const timeout = Symbol('memoryPreparationTimeout'), stale = Symbol('memoryPreparationStale');
    let timer = null, closed = false, stepStarted = null, abortListener;
    // 最终fresh核验只留来源版本与阶段，不复制材料；这份诊断不参与来源比较。
    const sourceVerification = sourceToVerify ? { phase: 'commit', mode: fresh ? 'fresh' : 'cached', step: 'root', sourceStatus: sourceToVerify.status,
      preparationStatus: null, rootStatus: null, rootVerified: null, selectedSource: sourceVersion(sourceToVerify), checkedRoot: null } : null;
    const updateSourceVerification = patch => {
      if (!sourceVerification || !operation) return;
      Object.assign(sourceVerification, patch);
      operation.sourceVerification = { ...sourceVerification };
    };
    const check = () => {
      if (operation && (operation.token !== epoch || operation.controller.signal.aborted)) throw stale;
      if (closed || Date.now() - started >= budgetMs) throw timeout;
    };
    const step = async (stage, read) => {
      check(); timing.stage = stage; stepStarted = Date.now();
      updateSourceVerification({ step: stage });
      if (operation) { operation.currentPreparation = timing; advanceOperation(operation, stage); }
      try {
        const value = await read(); check();
        if (stage === 'root') updateSourceVerification({ rootStatus: value?.status ?? 'unavailable', checkedRoot: sourceVersion(value) });
        if (stage === 'prepare') updateSourceVerification({ preparationStatus: value?.status ?? 'unavailable' });
        return value;
      }
      finally {
        if (!closed && stepStarted !== null) timing[`${stage}Ms`] += Date.now() - stepStarted;
        stepStarted = null;
      }
    };
    const run = async () => {
      let latestRoot = rootResult;
      const canReadRoot = typeof store.readRoot === 'function';
      if (canReadRoot && (sourceToVerify || fresh && latestRoot === null && typeof prepareMemory === 'function')) {
        latestRoot = await step('root', () => store.readRoot());
        const rootError = technicalSourceError(latestRoot);
        if (rootError) throw rootError;
      }
      if (sourceToVerify && matchesSourceRoot(sourceToVerify, latestRoot)) {
        updateSourceVerification({ sourceStatus: sourceToVerify.status, rootVerified: true, step: 'root' });
        return sourceToVerify;
      }
      const identityProjection = typeof identityProjectionProvider === 'function' ? await step('identity', () => identityProjectionProvider()) : null;
      let result, prepared;
      if (typeof prepareMemory === 'function') {
        // fresh 校验不启动后台维护；可借同目标的已在途准备，否则独立核验已完成 checkpoint。
        prepared = await step('prepare', () => prepareMemory({ preferCached: !fresh, rootResult: latestRoot, allowRefresh: !fresh, reuseInFlight: fresh && !sourceToVerify }));
        if (prepared?.status === 'ready' && prepared.reachable?.root) {
          result = await step('projection', () => projectRecallSource(prepared.reachable, now, Object.freeze({ reachableReads: 0, exitPoint: 'validatedSnapshot' }), snapshot, sanitizerSnapshot, hasRealtimeOrigin(), identityProjection?.data ?? identityProjection));
        } else if (['disabled', 'stale'].includes(prepared?.status)) return prepared;
      }
      if (!result) {
        result = await step('read', () => sourceReader({ store, now, hostSnapshot: snapshot, sanitizerOptions: sanitizerSnapshot, realtimeOrigin: hasRealtimeOrigin(), identityProjection: identityProjection?.data ?? identityProjection }));
        if (typeof prepareMemory === 'function' && !['ready', 'stale'].includes(result?.status) && !result?.error) {
          result = Object.freeze({ status: prepared?.status === 'error' ? 'unavailable' : prepared?.status ?? 'unavailable', sourceReadAttempts: Object.freeze({ reachableReads: 0, exitPoint: 'memoryPreparation' }) });
        }
      }
      if (sourceToVerify && canReadRoot && result?.status === 'ready' && !matchesSourceRoot(result, latestRoot)) {
        // 后台可能在只读准备期间发布新根；仅补一次轻量读，仍拒绝旧快照或再次变化。
        const afterPreparation = await step('root', () => store.readRoot());
        const rootError = technicalSourceError(afterPreparation);
        if (rootError) throw rootError;
        if (!matchesSourceRoot(result, afterPreparation)) {
          updateSourceVerification({ sourceStatus: result.status, rootStatus: afterPreparation?.status ?? 'unavailable', checkedRoot: sourceVersion(afterPreparation), rootVerified: false, step: 'root' });
          return Object.freeze({ ...result, rootVerified: false });
        }
        updateSourceVerification({ sourceStatus: result.status, rootStatus: afterPreparation?.status ?? 'unavailable', checkedRoot: sourceVersion(afterPreparation), rootVerified: true, step: 'root' });
      }
      if (sourceToVerify) updateSourceVerification({ sourceStatus: result?.status ?? 'unavailable', rootVerified: canReadRoot ? (matchesSourceRoot(result, latestRoot) ? true : false) : null });
      return result;
    };
    let result;
    try {
      // 全部准备等待共用期限；同步执行仍可能延后计时器。超时/取消后每个 await 边界阻止迟到分支启动后续读取。
      result = await Promise.race([Promise.resolve().then(run), new Promise(resolve => { timer = setTimeout(() => resolve(timeout), budgetMs); }),
        ...(operation ? [new Promise(resolve => { abortListener = () => resolve(stale); operation.controller.signal.addEventListener('abort', abortListener, { once: true }); })] : [])]);
      if (result === timeout || result === stale) result = Object.freeze({ status: result === timeout ? 'timeout' : 'stale', sourceReadAttempts: Object.freeze({ reachableReads: 0, exitPoint: result === timeout ? 'memoryPreparationTimeout' : 'stale' }) });
    } catch (error) {
      result = error === timeout || error === stale
        ? Object.freeze({ status: error === timeout ? 'timeout' : 'stale', sourceReadAttempts: Object.freeze({ reachableReads: 0, exitPoint: error === timeout ? 'memoryPreparationTimeout' : 'stale' }) })
        : Object.freeze({ status: 'unavailable', error: Object.freeze({ code: clean(error?.code ?? error?.name ?? 'V3_RECALL_SOURCE_UNAVAILABLE', 120), message: clean(error?.message ?? '记忆准备失败。') }), sourceReadAttempts: Object.freeze({ reachableReads: 0, exitPoint: 'memoryPreparationFailed' }) });
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (abortListener) operation.controller.signal.removeEventListener('abort', abortListener);
      if (stepStarted !== null) timing[`${timing.stage}Ms`] += Date.now() - stepStarted;
      closed = true;
      timing.totalMs = Date.now() - started;
      if (sourceToVerify) updateSourceVerification({ sourceStatus: result?.status ?? 'unavailable', rootVerified: result?.rootVerified === false ? false : sourceVerification.rootVerified });
      timing.status = result?.rootVerified === false ? 'stale' : ['ready', 'timeout', 'stale', 'disabled'].includes(result?.status) ? result.status : 'unavailable';
      if (operation?.timings) (operation.timings.preparationAttempts ??= []).push(Object.freeze(timing));
      if (operation) { operation.currentPreparation = null; notify(); }
    }
    return result;
  }
  async function sealQianshiProgress(value) {
    if (typeof value?.text !== 'string' || !value.text.trim()) return null;
    const material = { projectionVersion: Number.isSafeInteger(value.projectionVersion) ? value.projectionVersion : 0,
      text: value.text.trim().slice(0, 4000), eventIds: [...new Set(value.eventIds ?? [])].slice(0, 160), matterIds: [...new Set(value.matterIds ?? [])].slice(0, 160) };
    return Object.freeze({ ...material, fingerprint: await fingerprint(JSON.stringify(material)) });
  }
  async function attachQianshiProgress(source, queryContext, hostSnapshot = null, selection = null) {
    if (source?.status !== 'ready') return source;
    let qianshiProgress = null;
    if (typeof qianshiProgressProvider === 'function') try {
      const value = await qianshiProgressProvider(source, { queryContext, hostSnapshot,
        ...(selection ? { selectedEventIds: selection.eventIds ?? [], selectedMatterIds: selection.matterIds ?? [] } : {}) });
      const anchorMatches = value?.anchor?.headCheckpointId === source.headCheckpointId && value?.anchor?.narrativeGeneration === source.narrativeGeneration;
      if (anchorMatches) qianshiProgress = await sealQianshiProgress(value);
      const qianshiCandidates = anchorMatches && !selection && Array.isArray(value?.candidates) ? Object.freeze(clone(value.candidates)) : Object.freeze([]);
      const qianshiCurrentStoryTime = anchorMatches && typeof value?.currentStoryTime === 'string' ? value.currentStoryTime : null;
      return Object.freeze({ ...source, qianshiProgress, qianshiCandidates, qianshiCurrentStoryTime,
        qianshiDeletedEvents: anchorMatches ? value.deletedEvents ?? [] : [] });
    } catch (error) { logger?.warn?.('[qianqianjie] optional qianshi projection failed', { code: error?.code ?? error?.name ?? 'QQJ_QIANSHI_READ_FAILED' }); }
    return Object.freeze({ ...source, qianshiProgress, qianshiCandidates: Object.freeze([]) });
  }
  async function preparedSource(snapshot, sanitizerSnapshot, options = {}) {
    let source = await basePreparedSource(snapshot, sanitizerSnapshot, options);
    if (source?.status !== 'ready') return source;
    let timeProjection = null;
    if (typeof timeProjectionProvider === 'function') try { if (options.operation) advanceOperation(options.operation, 'timeProjection'); timeProjection = await timeProjectionProvider(source); }
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

  const diagnosticSteps = ['input', 'source', 'identity', 'root', 'prepare', 'read', 'projection', 'timeProjection', 'bodyWitness', 'qianshiProgress', 'queryContext', 'prequelSelection', 'receiptValidation', 'receiptSourceVerification',
    'semanticQuery', 'candidateBuild', 'utilityTask', 'responseParse', 'localSelection', 'qianshiSeal', 'commitVerification', 'deletionWitness', 'receiptSeal', 'receiptSaveCall', 'receiptSaveWait', 'receiptSaveReturned', 'receiptSaveFailed', 'complete'];
  function advanceOperation(operation, step) {
    if (active !== operation || !diagnosticSteps.includes(step)) return;
    if (operation.step && operation.step !== step) operation.lastCompletedStep = operation.step;
    operation.step = step;
    operation.stepStarted = Date.now();
    const diagnostic = operation.diagnostics?.at(-1);
    if (diagnostic) { diagnostic.pendingStep = step; diagnostic.lastCompletedStep = operation.lastCompletedStep; }
    notify();
  }
  const safeTerminationReason = value => ['stopped', 'superseded', 'chatChanged', 'userChanged', 'narrativeChanged', 'disabled', 'invalidated', 'selectedRefsChanged', 'sourceStale', 'sourceUnavailable'].includes(value) ? value : 'invalidated';
  const safeTerminationEvent = value => ['GENERATION_STOPPED', 'GENERATION_ENDED', 'interceptorSuperseded', 'CHAT_CHANGED', 'CHAT_RENAMED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'runtimeDisabled', 'runtimeInvalidate', 'finalSafetyGuard'].includes(value) ? value : 'runtimeInvalidate';
  function retainTerminated(operation, reason, sourceEvent) {
    if (!operation) return;
    const attempts = (operation.diagnostics ?? []).map(value => ({ attempt: Number.isSafeInteger(value.attempt) ? value.attempt : null,
      phase: ['input', 'source', 'selecting', 'commit', 'receipt'].includes(value.phase) ? value.phase : null,
      selectionStatus: ['notStarted', 'incomplete', 'receiptCandidate', 'reused', 'completed'].includes(value.selectionStatus) ? value.selectionStatus : null,
      coverage: value.coverage && typeof value.coverage === 'object' ? clone(value.coverage) : null,
      stages: value.stages && typeof value.stages === 'object' ? clone(value.stages) : null,
      selectorDiagnostic: value.selectorDiagnostic ? selectorDiagnosticSnapshot(value.selectorDiagnostic) : null,
      pendingStep: diagnosticSteps.includes(value.pendingStep) ? value.pendingStep : null,
      lastCompletedStep: diagnosticSteps.includes(value.lastCompletedStep) ? value.lastCompletedStep : null,
      error: value.error ? { code: clean(value.error.code, 120), httpStatus: Number.isSafeInteger(value.error.httpStatus) ? value.error.httpStatus : null } : null,
      timings: clone(value.timings ?? operation.timings ?? {}) }));
    lastTerminated = Object.freeze({ status: 'terminated', chatId: operation.chatId ?? null, generationType: operation.type,
      userMessageIndex: operation.user?.index ?? null, reason: safeTerminationReason(reason), sourceEvent: safeTerminationEvent(sourceEvent),
      terminatedAt: nowIso(now), phase: ['input', 'source', 'selecting', 'commit', 'receipt'].includes(operation.phase) ? operation.phase : null,
      pendingStep: diagnosticSteps.includes(operation.step) ? operation.step : null,
      lastCompletedStep: diagnosticSteps.includes(operation.lastCompletedStep) ? operation.lastCompletedStep : null,
      requestDiagnosticId: operation.requestDiagnosticId ?? null, roundStartedAt: new Date(operation.started).toISOString(),
      sourceVerification: operation.sourceVerification ? clone(operation.sourceVerification) : null,
      finalVerification: operation.finalVerification ? clone(operation.finalVerification) : null,
      timings: clone(operation.timings ?? {}), attempts: Object.freeze(attempts) });
  }

  function getState() {
    return Object.freeze({
      recallStatus: active ? 'running' : lastRecall?.status ?? (lastError ? 'error' : 'idle'),
      activeRecall: active ? Object.freeze({ token: active.token, generationType: active.type, phase: active.phase, pendingStep: active.step ?? null,
        lastCompletedStep: active.lastCompletedStep ?? null, pendingStepMs: active.stepStarted ? Math.max(0, Date.now() - active.stepStarted) : null,
        timings: clone(active.timings ?? {}), currentPreparation: active.currentPreparation ? clone(active.currentPreparation) : null,
        selectorProgress: active.selectorProgress ? clone(active.selectorProgress) : null,
        chatId: active.chatId ?? null, userMessageIndex: active.user?.index ?? null }) : null,
      lastRecall,
      // 只给独立私有诊断消费；记录自带 chatId，展示端可按当前聊天过滤，后台不能丢失切聊前的终止证据。
      lastTerminated,
      receiptSaveDiagnostic: sessionReceipt?.receiptSaveDiagnostic ?? null,
      lastPrequel,
      lastRecallBinding: lastRecallBinding ? Object.freeze({ chatId: lastRecallBinding.chatId, userMessageIndex: lastRecallBinding.userMessageIndex }) : null,
      lastRecallError: lastError,
      requestDiagnostic: requestDiagnostic.snapshot(active?.requestDiagnosticId ?? lastRecall?.requestDiagnosticId),
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

  async function persistReceipt(snapshot, user, receipt, onSaveProgress = null) {
    const context = snapshot.context;
    if (typeof context?.saveChat !== 'function') return 'sessionOnly';
    const currentExtra = user.message.extra && typeof user.message.extra === 'object' && !Array.isArray(user.message.extra) ? user.message.extra : {};
    const hadPrevious = Object.hasOwn(currentExtra, RECALL_RECEIPT_KEY);
    const previousReceipt = currentExtra[RECALL_RECEIPT_KEY];
    const candidate = clone(receipt);
    const saveCandidate = { status: 'saving', hadPrevious, previousReceipt };
    receiptSaveCandidates.set(candidate, saveCandidate);
    user.message.extra = { ...currentExtra, [RECALL_RECEIPT_KEY]: candidate };
    try {
      try { onSaveProgress?.('receiptSaveCall'); } catch {}
      const pending = context.saveChat();
      try { onSaveProgress?.('receiptSaveWait'); } catch {}
      await pending;
      try { onSaveProgress?.('receiptSaveReturned'); } catch {}
      // 后继回滚遇正常返回候选即停止；释放其更早历史，避免反复编辑把旧大回执串留在页面内。
      saveCandidate.status = 'returned'; saveCandidate.hadPrevious = false; saveCandidate.previousReceipt = null;
      return 'saveUnconfirmed';
    }
    catch (error) {
      saveCandidate.status = 'failed';
      const rawCode = String(error?.code ?? error?.name ?? 'V3_RECALL_RECEIPT_SAVE_FAILED');
      const code = /^(?:V3_|VECTOR_|BACKEND_|QQJ_|UND_ERR_|ERR_)[A-Z0-9_]{1,90}$/u.test(rawCode) || /^E[A-Z0-9_]{2,60}$/u.test(rawCode) ? rawCode : 'V3_RECALL_RECEIPT_SAVE_FAILED';
      try { onSaveProgress?.('receiptSaveFailed', code); } catch {}
      const latestExtra = user.message.extra;
      if (latestExtra && typeof latestExtra === 'object' && !Array.isArray(latestExtra) && latestExtra[RECALL_RECEIPT_KEY] === candidate) {
        const rolledBack = { ...latestExtra };
        // 编辑后的保存可覆盖仍在途的前轮候选；回滚跳过已失败前驱，避免双失败交错复活未保存回执。
        // 前驱仍在途或正常返回时保留原候选，继续失败则由其自身 CAS 回到更早历史；记录只留页面内。
        let rollback = saveCandidate;
        while (rollback.hadPrevious) {
          const predecessor = receiptSaveCandidates.get(rollback.previousReceipt);
          if (predecessor?.status !== 'failed') break;
          rollback = predecessor;
        }
        if (rollback.hadPrevious) rolledBack[RECALL_RECEIPT_KEY] = rollback.previousReceipt;
        else delete rolledBack[RECALL_RECEIPT_KEY];
        user.message.extra = rolledBack;
      }
      logger?.warn?.('[qianqianjie] V3 recall receipt persistence failed', { code: error?.code ?? error?.name ?? 'V3_RECALL_RECEIPT_SAVE_FAILED' });
      return 'sessionOnly';
    }
  }

  function receiptCandidates(user) {
    const stored = user.message.extra?.[RECALL_RECEIPT_KEY];
    const session = sessionReceipt?.userMessage === user.message ? sessionReceipt.receipt : null;
    return [session, stored].filter((value, index, values) => value && typeof value === 'object' && values.indexOf(value) === index);
  }

  function finishReceiptPersistence(owner, receiptPersistence, receiptMs, receiptSaveDiagnostic = null) {
    // 保存属于首次封签的 user，而非生成 epoch；同 user 冻结复用仍能接收结果，切聊／编辑／新选材则失效。
    if (sessionReceipt?.owner !== owner) return;
    const snapshot = hostAdapter.snapshot(), user = latestUser(snapshot);
    if (currentChatId(snapshot) !== owner.chatId || currentHostChatId(snapshot) !== owner.hostChatId
      || user?.message !== owner.userMessage || user.message.mes !== owner.userText) return;
    sessionReceipt = Object.freeze({ ...sessionReceipt, receiptMs,
      receipt: Object.freeze({ ...sessionReceipt.receipt, receiptPersistence }),
      ...(receiptSaveDiagnostic ? { receiptSaveDiagnostic: Object.freeze({ ...receiptSaveDiagnostic }) } : {}) });
    if (lastRecallReceiptOwner !== owner || !lastRecall || active
      || lastRecallBinding?.message !== user.message || lastRecallBinding.text !== owner.userText) return;
    // 只补保存诊断，不重建冻结材料；人工删除后的过滤、放行计时及结束／停止后的展示均保持。
    lastRecall = Object.freeze({ ...lastRecall, receiptPersistence,
      ...(receiptSaveDiagnostic ? { receiptSaveDiagnostic: Object.freeze({ ...receiptSaveDiagnostic }) } : {}),
      timings: Object.freeze({ ...lastRecall.timings, receiptMs }) });
    notify();
  }

  function updateReceiptSave(owner, startedMs, step, errorCode = null) {
    if (sessionReceipt?.owner !== owner) return null;
    const snapshot = hostAdapter.snapshot(), user = latestUser(snapshot);
    if (currentChatId(snapshot) !== owner.chatId || currentHostChatId(snapshot) !== owner.hostChatId
      || user?.message !== owner.userMessage || user.message.mes !== owner.userText) return null;
    const status = step === 'receiptSaveReturned' ? 'returned' : step === 'receiptSaveFailed' ? 'failed' : 'running';
    const diagnostic = Object.freeze({ chatId: owner.chatId, status, step, startedAt: new Date(startedMs).toISOString(), elapsedMs: Math.max(0, Date.now() - startedMs),
      errorCode: errorCode && (/^(?:V3_|VECTOR_|BACKEND_|QQJ_|UND_ERR_|ERR_)[A-Z0-9_]{1,90}$/u.test(errorCode) || /^E[A-Z0-9_]{2,60}$/u.test(errorCode)) ? errorCode : null });
    sessionReceipt = Object.freeze({ ...sessionReceipt, receiptSaveDiagnostic: diagnostic });
    if (lastRecallReceiptOwner === owner && lastRecall && !active) lastRecall = Object.freeze({ ...lastRecall, receiptSaveDiagnostic: diagnostic });
    notify();
    return diagnostic;
  }

  async function withoutDeletedQianshi(receipt) {
    if (typeof qianshiDeletionProvider !== 'function' || !receipt.qianshiProgress
      && !(receipt.timeDependencies?.reminders ?? []).some(item => item.qianshiRef)) return receipt;
    const deletion = await qianshiDeletionProvider();
    if (deletion.chatId !== receipt.chatId) throw Object.assign(new Error('当前聊天已变化。'), { code: 'V3_RECALL_CHAT_CHANGED' });
    const deletedIds = new Set(deletion.events.map(event => event.eventId));
    const witness = await qianshiDeletionWitness(receipt, deletion.events, fingerprint);
    const prior = new Map((receipt.qianshiDeletionWitness ?? []).map(value => [value.matterId, value.fingerprint]));
    const affectedMatters = new Set();
    for (const value of witness) {
      if (prior.has(value.matterId) ? prior.get(value.matterId) !== value.fingerprint
        : deletion.events.some(event => event.matterId === value.matterId)) affectedMatters.add(value.matterId);
    }
    const oldQianshi = receipt.qianshiProgress;
    const eventIds = (oldQianshi?.eventIds ?? []).filter(id => !deletedIds.has(id));
    const matterIds = (oldQianshi?.matterIds ?? []).filter(id => !affectedMatters.has(id));
    const savedTime = receipt.timeDependencies;
    const reminders = (savedTime?.reminders ?? []).filter(item => !affectedMatters.has(item.qianshiRef?.matterId));
    if (eventIds.length === (oldQianshi?.eventIds?.length ?? 0) && matterIds.length === (oldQianshi?.matterIds?.length ?? 0)
      && reminders.length === (savedTime?.reminders?.length ?? 0)) return receipt;
    // 只撤回明确删除涉及的行，不加入新材料、不重跑模型；普通摘要/CSE 与其余冻结材料逐字保留。
    let qianshi = null;
    if (oldQianshi) {
      const retainedText = oldQianshi.text.split(/\n\n/u).map(section => {
        const lines = section.split('\n'), ids = lines[0] === '[相关时间线]' ? oldQianshi.eventIds
          : lines[0] === '[当前待接续]' ? oldQianshi.matterIds : null;
        if (!ids) return '';
        const kept = new Set(lines[0] === '[相关时间线]' ? eventIds : matterIds);
        const rows = lines.slice(1).filter((line, index) => kept.has(ids[index]));
        return rows.length ? [lines[0], ...rows].join('\n') : '';
      }).filter(Boolean).join('\n\n');
      qianshi = await sealQianshiProgress({ ...oldQianshi, text: retainedText, eventIds, matterIds });
    }
    let ordinaryText = removeQianshiProgress(receipt.injectionText, oldQianshi, savedTime);
    const timeDependencies = savedTime?.mode === 'selected' ? { ...savedTime, reminders } : savedTime;
    if (reminders.length !== (savedTime?.reminders?.length ?? 0)) {
      const timeBlock = rows => rows.length ? ['[时间参考（当前推测及预计/期限节点尚未获正文确认，不代表已经发生或完成）]',
        ...rows.map(item => `- ${item.text}`)].join('\n') + '\n' : '';
      const suffix = `${timeBlock(savedTime.reminders)}</qqj_recalled_context>`;
      if (ordinaryText.endsWith(suffix)) ordinaryText = ordinaryText.slice(0, -suffix.length) + `${timeBlock(reminders)}</qqj_recalled_context>`;
      if (ordinaryText === '<qqj_recalled_context>\n</qqj_recalled_context>') ordinaryText = '';
    }
    const injectionText = appendQianshiProgress(ordinaryText, qianshi, timeDependencies);
    const removedReminders = (savedTime?.reminders?.length ?? 0) - reminders.length;
    const stages = receipt.stages ? { ...receipt.stages, estimatedTokenCount: estimateRecallTokens(injectionText),
      timeReminderCount: reminders.length, finalInjectionItemCount: Math.max(0, (receipt.stages.finalInjectionItemCount ?? 0) - removedReminders) } : null;
    return { ...receipt, qianshiProgress: qianshi, timeDependencies, injectionText, stages,
      completionStatus: injectionText ? 'ready' : 'empty', skipReasons: [...new Set([...receipt.skipReasons, 'qianshiManuallyDeleted'])] };
  }

  function commitFrozenReceiptIfCurrent({ operation, receipt, userIndex, hostGuard }) {
    if (operation.token !== epoch || operation.controller.signal.aborted) return { ok: false, reason: abortReason(operation) };
    // 人工删除的撤回在此前完成；普通冻结复用不重读来源、时间投影或重选千事。
    // user 消息对象是生命周期边界；最后守卫与注入同步完成，迟到请求不能跨过提交点。
    const snapshot = hostAdapter.snapshot();
    const user = latestUser(snapshot);
    const current = operation.token === epoch
      && !operation.controller.signal.aborted
      && currentHostChatId(snapshot) === operation.hostChatId
      && currentChatId(snapshot) === receipt.chatId
      && user?.index === userIndex
      && user.message === hostGuard.userMessage
      && user.message.mes === hostGuard.userText
      && liveRecallFrameKey(snapshot) === operation.liveFrameKey;
    if (!current) {
      if (operation.token !== epoch || operation.controller.signal.aborted) return { ok: false, reason: abortReason(operation) };
      if (currentHostChatId(snapshot) !== operation.hostChatId || currentChatId(snapshot) !== receipt.chatId) return { ok: false, reason: 'chatChanged' };
      if (user?.index !== userIndex || user?.message !== hostGuard.userMessage || user?.message?.mes !== hostGuard.userText) return { ok: false, reason: 'userChanged' };
      return { ok: false, reason: 'narrativeChanged' };
    }
    const binding = { chatId: receipt.chatId, hostChatId: operation.hostChatId };
    if (receipt.injectionText) prompt(receipt.injectionText, operation.token, snapshot.context, binding);
    if (operation.prequelSelection?.injectionText) {
      promptPrequel(operation.prequelSelection.injectionText, operation.token, snapshot.context, binding);
      operation.prequelCommitted = true;
    }
    return { ok: true, snapshot, user };
  }

  async function commitPromptIfCurrent({ operation, source, receipt, selectedFloors, selectedFloorsForValidation, selectedStates, selectedCseChanges = [], timeDependencies, userIndex, userFingerprint, hostGuard, injectionText }) {
    let finalReceipt = receipt, liveTime;
    const markVerificationFailure = (step, reason, reference = null) => {
      operation.finalVerification = { ...(operation.sourceVerification ?? {}), step, failure: { step, reason, ...(reference ? { reference } : {}) } };
    };
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
    let currentSource = await basePreparedSource(verifyHostCoverage ? before : null, currentSanitizerOptions(), { fresh: true, operation, sourceToVerify: source });
    if (currentSource !== source) {
      if (currentSource?.status !== 'ready') {
        const reason = currentSource?.status === 'stale' ? 'sourceStale' : 'sourceUnavailable';
        markVerificationFailure('sourcePreparation', reason);
        const sourceError = technicalSourceError(currentSource);
        if (sourceError) throw sourceError;
        return { ok: false, reason };
      }
      if (currentSource.rootVerified === false) { markVerificationFailure('rootVerification', 'sourceUnavailable'); return { ok: false, reason: 'sourceUnavailable' }; }
      if (currentSource.chatId !== source.chatId) return { ok: false, reason: 'chatChanged' };
      if (currentSource.narrativeGeneration !== source.narrativeGeneration) return { ok: false, reason: 'narrativeChanged' };
      currentSource = Object.freeze({ ...currentSource, bodyMatch: await attachCoreBodyMatch(currentSource, operation.coreBodyWitness, before, operation.sanitizerOptions, fingerprint, recentBodyFloorLimit()) });
    }
    if (!timeDependenciesValid(timeDependencies)) { markVerificationFailure('timeDependencies', 'invalid'); return { ok: false, reason: 'selectedRefsChanged' }; }
    if (timeDependencies.mode === 'projection' || timeDependencies.corrections.length || timeDependencies.reminders.length) {
      liveTime = currentSource.timeProjection;
      if (typeof timeProjectionProvider === 'function') {
        try { advanceOperation(operation, 'timeProjection'); liveTime = await timeProjectionProvider(currentSource); }
        catch (error) { liveTime = null; logger?.warn?.('[qianqianjie] optional time projection check failed', { code: error?.code ?? error?.name ?? 'QQJ_TIME_READ_FAILED' }); }
      }
      if (!timeDependenciesCurrent(timeDependencies, liveTime)) {
        finalReceipt = withoutStaleTime(receipt, currentSource, liveTime);
        if (!finalReceipt) { markVerificationFailure('timeDependencies', 'changed'); return { ok: false, reason: 'selectedRefsChanged' }; }
        injectionText = finalReceipt.injectionText;
      }
    }
    advanceOperation(operation, 'qianshiProgress');
    currentSource = await attachQianshiProgress(Object.freeze({ ...currentSource, timeProjection: liveTime ?? currentSource.timeProjection }), operation.queryContext, before,
      { eventIds: finalReceipt.qianshiProgress?.eventIds ?? [], matterIds: finalReceipt.qianshiProgress?.matterIds ?? [] });
    if (!qianshiProgressCurrent(finalReceipt.qianshiProgress, currentSource.qianshiProgress)) {
      injectionText = removeQianshiProgress(injectionText, finalReceipt.qianshiProgress, finalReceipt.timeDependencies);
      finalReceipt = { ...finalReceipt, qianshiProgress: null, injectionText,
        stages: stagesWithoutQianshi(finalReceipt.stages, finalReceipt.qianshiProgress, injectionText),
        completionStatus: injectionText ? 'ready' : 'empty',
        skipReasons: [...new Set([...(finalReceipt.skipReasons ?? []), 'optionalQianshiChanged'])] };
    }
    let failedReference = null;
    if (!await sourceRefsValid({ selectedFloors, selectedStates, selectedCseChanges }, currentSource, reference => { failedReference = reference; }, selectedFloorsForValidation)) {
      markVerificationFailure(failedReference?.step ?? 'selectedReference', 'changed', failedReference);
      return { ok: false, reason: 'selectedRefsChanged' };
    }
    const selectedSourceGuards = captureSelectedSourceGuards({ selectedFloors, selectedStates, selectedCseChanges }, currentSource, before);
    if (selectedSourceGuards === null) { markVerificationFailure('sourceBodyGuard', 'changed'); return { ok: false, reason: 'selectedRefsChanged' }; }
    const bodyGuardSanitizer = currentSanitizerOptions();
    const coveredBodyGuards = await captureCoveredBodyGuards(source, currentSource, before, bodyGuardSanitizer, fingerprint);
    if (coveredBodyGuards === null) { markVerificationFailure('coveredBodyGuard', 'changed'); return { ok: false, reason: 'narrativeChanged' }; }
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
      if (!selectedSourcesCurrent) { markVerificationFailure('finalSync', 'selectedSourceChanged'); return { ok: false, reason: 'selectedRefsChanged' }; }
      markVerificationFailure('finalSync', 'narrativeChanged');
      return { ok: false, reason: 'narrativeChanged' };
    }
    if (liveTime?.currentBodyWitness) {
      const witness = liveTime.currentBodyWitness;
      const message = after.chat?.[witness.hostLocator.messageIndex];
      if (!message || message.is_system === true || message.is_hidden === true || message.hidden === true
        || !coveredBodyGuardsCurrent([witness], after, bodyGuardSanitizer)) {
        finalReceipt = withoutStaleTime(finalReceipt, currentSource, null);
        if (!finalReceipt) { markVerificationFailure('timeBodyWitness', 'changed'); return { ok: false, reason: 'selectedRefsChanged' }; }
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
      pendingStep: diagnosticSteps.includes(operation.step) ? operation.step : null,
      lastCompletedStep: diagnosticSteps.includes(operation.lastCompletedStep) ? operation.lastCompletedStep : null,
      selectorProgress: operation.selectorProgress ? clone(operation.selectorProgress) : null,
      requestDiagnosticId: operation.requestDiagnosticId, roundStartedAt: new Date(operation.started).toISOString(),
      sourceVerification: operation.sourceVerification ? clone(operation.sourceVerification) : null,
      finalVerification: operation.finalVerification ? clone(operation.finalVerification) : null,
      attemptDiagnostics: Object.freeze(attempts.map(value => Object.freeze({ attempt: value.attempt, phase: value.phase, selectionStatus: value.selectionStatus,
        pendingStep: diagnosticSteps.includes(value.pendingStep) ? value.pendingStep : null,
        lastCompletedStep: diagnosticSteps.includes(value.lastCompletedStep) ? value.lastCompletedStep : null,
        coverage: value.coverage, stages: value.stages, selectorDiagnostic: value.selectorDiagnostic, error: value.error ?? null, timings: clone(value.timings ?? timings) }))),
      timings: Object.freeze({ ...(chosen?.timings ?? timings), totalMs: Date.now() - operation.started }) };
  }

  async function intercept(coreChat, contextSize, abort, rawType) {
    const token = ++epoch;
    if (active) { retainTerminated(active, 'superseded', 'interceptorSuperseded'); active.controller.abort('superseded'); }
    clearSlot();
    const type = SUPPORTED_TYPES.has(rawType) ? rawType : rawType === undefined ? 'normal' : String(rawType ?? 'normal');
    const lifecycle = generationQueue.find(value => value.token === null && value.type === type);
    if (lifecycle) lifecycle.token = token;
    const operation = { token, type, phase: 'input', step: 'input', lastCompletedStep: null, stepStarted: Date.now(), controller: new AbortController(), started: Date.now(), diagnostics: [],
      requestDiagnosticId: enabled() && SUPPORTED_TYPES.has(type) ? lifecycle?.requestDiagnosticId ?? requestDiagnostic.start() : null };
    lastRecall = null; lastPrequel = null; lastRecallBinding = null; lastRecallReceiptOwner = null;
    active = operation; lastError = null; notify();
    const timings = {};
    operation.timings = timings;
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
      const diagnostic = { attempt: attempt + 1, phase: 'input', pendingStep: 'input', lastCompletedStep: operation.lastCompletedStep, selectionStatus: 'notStarted', coverage: null, stages: null, selectorDiagnostic: null, started: Date.now() };
      operation.phase = 'input';
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
      notify();
      advanceOperation(operation, 'queryContext');
      const queryContext = queryBuilder({ coreChat: coreInput, assistantTurns: 1 });
      operation.queryContext = queryContext;
      operation.prequelSourceText = currentPrequelText(before);
      advanceOperation(operation, 'prequelSelection');
      operation.prequelSelection = selectPrequel({ text: operation.prequelSourceText, queryContext, contextSize });
      const hostGuard = { userMessage: user.message, userText: user.message.mes };
      if (!queryContext.latestUserText) return finishSkipped(operation, 'emptyUserInput', timings);
      const inputStarted = Date.now();
      const userFingerprint = await fingerprint(user.message.mes);
      timings.inputMs = Date.now() - inputStarted;
      let candidate = null, candidateOwner = null;
      advanceOperation(operation, 'receiptValidation');
      for (const value of receiptCandidates(user)) {
        const owner = value === sessionReceipt?.receipt ? sessionReceipt.owner : null;
        const snapshot = await persistedReceiptValid(value, { chatId: operation.chatId, userIndex: user.index, userFingerprint, pluginVersion }, fingerprint);
        if (snapshot) { candidate = snapshot; candidateOwner = owner; break; }
      }
      if (candidate?.selectedFloors.some(value => value.rawWitnesses?.length || value.summaryWitnesses?.length)) {
        // 冻结复用不查询向量；原文见证及旧摘要回执仍按各自来源重新核验。
        advanceOperation(operation, 'receiptSourceVerification');
        const sourceStarted = Date.now();
        const sanitizerSnapshot = currentSanitizerOptions();
        const realtime = hasRealtimeOrigin();
        let fresh = null;
        // 仅借用根版本完全匹配的既有快照；未命中时继续原来源读取，不等待后台准备。
        if (typeof store.readRoot === 'function' && typeof prepareMemory === 'function') {
          try {
            const rootResult = await store.readRoot();
            if (rootResult?.status === 'ready') {
              const prepared = await prepareMemory({ rootResult, allowRefresh: false });
              const reachable = prepared?.status === 'ready' ? prepared.reachable : null;
              const root = reachable?.root;
              const rootMatches = Boolean(root && reachable.status === 'ready'
                && candidate.chatId === operation.chatId
                && rootResult.data?.chatId === operation.chatId
                && rootResult.revision === reachable.rootRevision
                && rootResult.data?.chatId === root.chatId
                && rootResult.data?.narrativeGeneration === root.narrativeGeneration
                && rootResult.data?.headCheckpointId === root.headCheckpointId
                && rootResult.data?.sourceSnapshotFingerprint === root.sourceSnapshotFingerprint);
              if (rootMatches) {
                const projected = await projectRecallSource(reachable, now,
                  Object.freeze({ reachableReads: 0, exitPoint: 'validatedSnapshot' }), before, sanitizerSnapshot, realtime);
                if (projected?.status === 'ready'
                  && projected.chatId === rootResult.data.chatId
                  && projected.narrativeGeneration === rootResult.data.narrativeGeneration
                  && projected.rootRevision === rootResult.revision
                  && projected.headCheckpointId === rootResult.data.headCheckpointId) fresh = projected;
              }
            }
          } catch { /* 快照读取仅为加速；任何未命中都保留原来源读取合同。 */ }
        }
        if (!fresh) fresh = await sourceReader({ store, now, hostSnapshot: before, sanitizerOptions: sanitizerSnapshot, realtimeOrigin: realtime });
        timings.sourceMs = Date.now() - sourceStarted;
        if (fresh?.sourceReadAttempts) timings.sourceReadAttempts = clone(fresh.sourceReadAttempts);
        for (const value of candidate.selectedFloors) {
          for (const witness of value.rawWitnesses ?? []) if (!await rawWitnessValid(witness, fresh)) return stopForFinalSafety('selectedRefsChanged');
          for (const witness of value.summaryWitnesses ?? []) if (!await summaryWitnessValid(witness, fresh)) return stopForFinalSafety('selectedRefsChanged');
        }
      }
      if (candidate) {
        const commitStarted = Date.now();
        if (typeof qianshiDeletionProvider === 'function' && (candidate.qianshiProgress || (candidate.timeDependencies?.reminders ?? []).some(item => item.qianshiRef))) advanceOperation(operation, 'deletionWitness');
        candidate = await withoutDeletedQianshi(candidate);
        diagnostic.selectionStatus = 'receiptCandidate'; diagnostic.coverage = clone(candidate.coverage); diagnostic.stages = clone(candidate.stages); diagnostic.selectorDiagnostic = clone(candidate.selectorDiagnostic);
        operation.phase = diagnostic.phase = 'commit'; advanceOperation(operation, 'commitVerification');
        const committed = commitFrozenReceiptIfCurrent({ operation, receipt: candidate, userIndex: user.index, hostGuard });
        if (!committed.ok) return stopForFinalSafety(committed.reason);
        timings.commitMs = Date.now() - commitStarted;
        timings.totalMs = Date.now() - operation.started;
        // 保存可能在复用核验的 await 中完成；读取同一 owner 的最新保存状态，避免重新显示 saving。
        if (candidateOwner && sessionReceipt?.owner === candidateOwner) {
          candidate = { ...candidate, receiptPersistence: sessionReceipt.receipt.receiptPersistence };
          if (sessionReceipt.receiptMs !== undefined) timings.receiptMs = sessionReceipt.receiptMs;
        }
        diagnostic.selectionStatus = 'reused'; diagnostic.timings = clone(timings);
        advanceOperation(operation, 'complete'); operation.lastCompletedStep = 'complete'; operation.step = null; operation.stepStarted = null;
        lastRecall = Object.freeze({ ...stateFromReceipt(candidate, { generationType: type, timings }), ...runtimeDiagnostic(operation, timings) });
        lastRecallReceiptOwner = candidateOwner;
        if (operation.prequelCommitted) lastPrequel = prequelState(operation);
        bindLastRecall(committed.snapshot, committed.user); lastError = null; active = null; notify(); return getState();
      }
      const sanitizerSnapshot = currentSanitizerOptions();
      advanceOperation(operation, 'bodyWitness');
      const [coreBodyWitness, baseQueryFingerprint] = await Promise.all([
        captureCoreBodyWitness(coreInput, sanitizerSnapshot, fingerprint, recentBodyFloorLimit()),
        fingerprint(queryContext.text),
      ]);
      operation.coreBodyWitness = coreBodyWitness;
      operation.sanitizerOptions = sanitizerSnapshot;
      operation.phase = diagnostic.phase = 'source'; notify();
      advanceOperation(operation, 'source');
      const sourceStarted = Date.now();
      const readSource = await preparedSource(before, sanitizerSnapshot, { fresh: attempt > 0, operation });
      let source = readSource;
      if (readSource?.status === 'ready') {
        advanceOperation(operation, 'bodyWitness');
        source = Object.freeze({ ...readSource, bodyMatch: await attachCoreBodyMatch(readSource, coreBodyWitness, before, sanitizerSnapshot, fingerprint, recentBodyFloorLimit()) });
      }
      if (source?.status === 'ready') { advanceOperation(operation, 'qianshiProgress'); source = await attachQianshiProgress(source, queryContext, before); }
      timings.sourceMs = Date.now() - sourceStarted;
      if (source?.sourceReadAttempts) timings.sourceReadAttempts = clone(source.sourceReadAttempts);
      if (source?.status === 'ready') diagnostic.coverage = clone(source.coverage);
      if (source.status !== 'ready') {
        // Technical source failures take the bounded retry path; a valid but uninitialized source can be skipped normally.
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
          try { notifyUser?.({ kind: 'warning', text: `${source.status === 'timeout' ? '当前聊天记忆在准备期限内未准备完成' : '当前聊天记忆暂时无法读取'}，本轮不注入普通记忆，正文继续生成。${detail ? ` ${detail}` : ''}` }); } catch { /* notification must not affect recall */ }
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
      operation.phase = diagnostic.phase = 'selecting'; diagnostic.selectionStatus = 'incomplete'; advanceOperation(operation, 'semanticQuery'); notify();
      const selectorStarted = Date.now();
      let selection;
      const initialQianshiCharacters = source.qianshiProgress?.text ? `\n\n${qianshiBlock(source.qianshiProgress)}`.length : 0;
      const initialQianshiTokens = reservedQianshiTokenBudget(source.qianshiProgress);
      try { selection = await selectionRunner({ source, queryContext, contextSize, signal: operation.controller.signal,
        recentBodyFloorCount: normalizeAutoHideKeepAiCount(recentBodyFloorLimit()),
        reservedTokens: operation.prequelSelection.estimatedTokens + initialQianshiTokens,
        reservedCharacters: operation.prequelSelection.estimatedCharacters + initialQianshiCharacters,
        onProgress: value => {
          if (active !== operation || token !== epoch) return;
          operation.selectorProgress = value;
          if (value.pendingStep) advanceOperation(operation, value.pendingStep);
          else { operation.lastCompletedStep = value.lastCompletedStep; operation.step = null; operation.stepStarted = null; notify(); }
        } }); }
      finally { timings.selectorMs = Date.now() - selectorStarted; }
      if (token !== epoch || operation.controller.signal.aborted) return finishStale(operation, timings);
      if (Object.hasOwn(selection, 'qianshiProgress')) {
        advanceOperation(operation, 'qianshiSeal');
        source = Object.freeze({ ...source, qianshiProgress: await sealQianshiProgress(selection.qianshiProgress) });
      }
      const qianshiTokens = reservedQianshiTokenBudget(source.qianshiProgress);
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
        selectedFloors: selection.floors.map(receiptFloorRef),
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
        injectionText: appendQianshiProgress(selection.injectionText, source.qianshiProgress, selection.timeDependencies),
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
          estimatedTokenCount: estimateRecallTokens(appendQianshiProgress(selection.injectionText, source.qianshiProgress, selection.timeDependencies)),
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
      const commitStarted = Date.now();
      operation.phase = diagnostic.phase = 'commit';
      advanceOperation(operation, 'commitVerification');
      let committed;
      try { committed = await commitPromptIfCurrent({ operation, source, receipt: receiptBase, selectedFloors: receiptBase.selectedFloors, selectedFloorsForValidation: selection.floors, selectedStates: receiptBase.selectedStates, selectedCseChanges: receiptBase.selectedCseChanges, timeDependencies: receiptBase.timeDependencies, userIndex: user.index, userFingerprint, hostGuard, injectionText: receiptBase.injectionText }); }
      finally { timings.commitMs = Date.now() - commitStarted; }
      if (!committed.ok) return stopForFinalSafety(committed.reason);
      receiptBase = { ...committed.receipt, timings: receiptTimingSnapshot(timings) };
      if (typeof qianshiDeletionProvider === 'function') { advanceOperation(operation, 'deletionWitness'); receiptBase.qianshiDeletionWitness = await qianshiDeletionWitness(receiptBase, source.qianshiDeletedEvents ?? [], fingerprint); }
      diagnostic.stages = clone(receiptBase.stages);
      diagnostic.selectorDiagnostic = clone(receiptBase.selectorDiagnostic);
      if (partialReasons.length) {
        try { notifyUser?.({ kind: 'warning', text: receiptBase.injectionText
          ? '当前聊天仍有摘要或人物状态缺口；本轮已使用能确认归属的已保存记忆，正文继续生成。'
          : '当前聊天仍有摘要或人物状态缺口；本轮没有找到可注入的已保存记忆，正文继续生成。' }); } catch { /* notification must not affect recall */ }
      }
      if (token !== epoch || operation.controller.signal.aborted) return finishStale(operation, timings);
      advanceOperation(operation, 'receiptSeal');
      const sealedReceipt = Object.freeze({ ...receiptBase, receiptFingerprint: await fingerprint(JSON.stringify(receiptMaterial(receiptBase))) });
      if (token !== epoch || operation.controller.signal.aborted) return finishStale(operation, timings);
      // 核验包括来源复核、删除见证和封签。准备完成立即放行，宿主原 saveChat 在后台完成。
      timings.commitMs = Date.now() - commitStarted;
      operation.phase = diagnostic.phase = 'receipt';
      const receiptPersistence = typeof committed.snapshot.context?.saveChat === 'function' ? 'saving' : 'sessionOnly';
      const owner = Object.freeze({ chatId: operation.chatId, hostChatId: operation.hostChatId,
        userMessage: committed.user.message, userText: operation.userText });
      const receipt = Object.freeze({ ...sealedReceipt, receiptPersistence });
      sessionReceipt = Object.freeze({ userMessage: committed.user.message, owner, receipt });
      timings.totalMs = Date.now() - operation.started;
      advanceOperation(operation, 'complete');
      operation.lastCompletedStep = 'complete'; operation.step = null; operation.stepStarted = null;
      diagnostic.timings = clone(timings);
      lastRecall = Object.freeze({ ...stateFromReceipt(receipt, { generationType: type, reusedReceipt: false, timings }), ...runtimeDiagnostic(operation, timings) });
      if (operation.prequelCommitted) lastPrequel = prequelState(operation);
      bindLastRecall(committed.snapshot, committed.user);
      lastRecallReceiptOwner = owner;
      lastError = null; active = null;
      if (receiptPersistence === 'saving') {
        const receiptStarted = Date.now();
        // 保留原候选 extra 与失败 CAS 回滚；不等待宿主 Promise、不重试，也不反向撤已提交 prompt。
        void persistReceipt(committed.snapshot, committed.user, sealedReceipt, (step, errorCode) => updateReceiptSave(owner, receiptStarted, step, errorCode)).then(persistence => {
          const saveDiagnostic = sessionReceipt?.owner === owner ? sessionReceipt.receiptSaveDiagnostic : null;
          finishReceiptPersistence(owner, persistence, Date.now() - receiptStarted, saveDiagnostic);
        }).catch(error => logger?.warn?.('[qianqianjie] V3 recall receipt status update failed', { code: error?.code ?? error?.name ?? 'V3_RECALL_RECEIPT_STATUS_FAILED' }));
      }
      notify(); return getState();
      } catch (error) {
      if (token !== epoch || operation.controller.signal.aborted) return finishStale(operation, timings);
      clearSlot(token);
      operation.prequelCommitted = false;
      lastPrequel = null;
      const taskMetadata = sanitizeTaskMetadata(error?.taskMetadata);
      const safe = Object.freeze({ code: clean(error?.code ?? error?.name ?? 'V3_RECALL_FAILED', 120), message: clean(error?.message ?? '召回失败，已安全停止。', 500),
        source: taskMetadata.source, sourceLabel: taskMetadata.sourceLabel, model: taskMetadata.model,
        sourceStage: error?.selectorDiagnostic?.sourceStage || taskMetadata.sourceStage || diagnostic.phase,
        httpStatus: Number.isSafeInteger(error?.httpStatus ?? error?.status) ? error.httpStatus ?? error.status : taskMetadata.httpStatus,
        formatStage: clean(error?.formatStage ?? taskMetadata.formatStage, 80), finishReason: taskMetadata.finishReason,
        transportAttempts: Number.isSafeInteger(error?.transportAttempts ?? taskMetadata.transportAttempts) ? error.transportAttempts ?? taskMetadata.transportAttempts : null });
      if (error?.selectorDiagnostic) diagnostic.selectorDiagnostic = selectorDiagnosticSnapshot(error.selectorDiagnostic);
      diagnostic.error = safe; diagnostic.timings = clone({ ...timings, totalMs: Date.now() - diagnostic.started });
      if (attempt === 0) {
        try { notifyUser?.({ kind: 'warning', text: '记忆召回未完成，正在重试一次。' }); } catch { /* notification must not affect recall */ }
        // 失败阶段留在本 attempt 的快照中；下一次重试从新步骤开始，不把失败误记为成功完成。
        operation.step = null; operation.stepStarted = null;
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
    const failedPreparation = timings.preparationAttempts?.at(-1)?.status !== 'ready'
      && ['identity', 'root', 'prepare', 'read', 'projection'].includes(operation.step);
    if (!failedPreparation) { advanceOperation(operation, 'complete'); operation.lastCompletedStep = 'complete'; operation.step = null; operation.stepStarted = null; }
    const reasons = Array.isArray(reason) ? reason : [reason];
    lastRecall = Object.freeze({ status: 'skipped', userMessageIndex: operation.user?.index ?? null, generationType: operation.type, coverage: null, selectedFloors: Object.freeze([]), selectedStates: Object.freeze([]), selectedCseChanges: Object.freeze([]), selectorDiagnostic: null, injectionText: '', reusedReceipt: false, restoredReceipt: false, receiptPersistence: 'none', stages: null, ...runtimeDiagnostic(operation, timings), skipReasons: Object.freeze([...reasons]), error: null, createdAt: nowIso(now) });
    if (operation.prequelCommitted) lastPrequel = prequelState(operation);
    bindOperationRecall(operation);
    active = null; notify(); return getState();
  }

  function finishStale(operation, timings, reason = abortReason(operation)) {
    if (active === operation && ['chatChanged', 'userChanged', 'narrativeChanged', 'selectedRefsChanged', 'sourceStale', 'sourceUnavailable', 'stopped', 'superseded', 'disabled'].includes(reason)) retainTerminated(operation, reason, 'finalSafetyGuard');
    if (active === operation) active = null;
    if (operation.token === epoch) {
      clearSlot(operation.token);
      lastRecall = Object.freeze({ status: 'stale', userMessageIndex: operation.user?.index ?? null, generationType: operation.type, coverage: null, selectedFloors: Object.freeze([]), selectedStates: Object.freeze([]), selectedCseChanges: Object.freeze([]), selectorDiagnostic: null, injectionText: '', reusedReceipt: false, restoredReceipt: false, receiptPersistence: 'none', stages: null, ...runtimeDiagnostic(operation, timings), skipReasons: Object.freeze([FINAL_REASONS.has(reason) ? reason : 'narrativeChanged']), error: null, createdAt: nowIso(now) }); lastPrequel = null;
      bindOperationRecall(operation);
      notify();
    }
    return getState();
  }

  function invalidate(reason = 'invalidated', sourceEvent = 'runtimeInvalidate') {
    if (active) retainTerminated(active, reason, sourceEvent);
    requestDiagnostic.clear();
    epoch += 1; active?.controller.abort(FINAL_REASONS.has(reason) ? reason : 'superseded'); active = null;
    // 人工删除撤在途注入，但保留首次选材回执；下一次重生只剔除明确删除材料。
    if (reason !== 'qianshiManuallyDeleted') sessionReceipt = null;
    generationQueue.length = 0; stoppedEndDebt = 0; clearSlot();
    lastRecall = null; lastPrequel = null; lastRecallBinding = null; lastRecallReceiptOwner = null; lastError = null; notify();
  }

  function onGenerationStarted(type, _params, dryRun) {
    if (dryRun === true) return;
    const generationType = String(type ?? 'normal');
    const previous = generationQueue.at(-1);
    const chainId = generationType === 'continue' && previous && !previous.stopped ? previous.chainId : ++generationSerial;
    generationQueue.push({ token: null, type: generationType, chainId, stopped: false,
      requestDiagnosticId: enabled() && SUPPORTED_TYPES.has(generationType) ? requestDiagnostic.start() : null });
  }
  function cancelGenerationOperation(generation, reason = 'stopped') {
    if (!generation || active?.token !== generation.token) return false;
    const operation = active;
    retainTerminated(operation, reason, generation.sourceEvent ?? 'GENERATION_STOPPED');
    epoch += 1;
    active.controller.abort(reason);
    active = null;
    if (slotOwner === generation.token) clearSlot(generation.token);
    lastRecall = Object.freeze({ status: 'stale', userMessageIndex: operation.user?.index ?? null, generationType: operation.type, coverage: null, selectedFloors: Object.freeze([]), selectedStates: Object.freeze([]), selectedCseChanges: Object.freeze([]), selectorDiagnostic: null, injectionText: '', reusedReceipt: false, restoredReceipt: false, receiptPersistence: 'none', stages: null, requestDiagnosticId: operation.requestDiagnosticId,
      roundStartedAt: new Date(operation.started).toISOString(), timings: Object.freeze({ totalMs: Date.now() - operation.started }), skipReasons: Object.freeze([reason]), error: null, createdAt: nowIso(now) }); lastPrequel = null;
    bindOperationRecall(operation);
    notify();
    return true;
  }
  function onGenerationStopped() {
    const generation = [...generationQueue].reverse().find(value => value.token === active?.token)
      ?? [...generationQueue].reverse().find(value => value.token === slotOwner)
      ?? generationQueue.at(-1);
    if (!generation) { if (slotOwner !== null) clearSlot(slotOwner); return; }
    requestDiagnostic.finish(generation.requestDiagnosticId);
    if (!cancelGenerationOperation(generation ? { ...generation, sourceEvent: 'GENERATION_STOPPED' } : generation) && slotOwner === generation.token) clearSlot(generation.token);
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
    requestDiagnostic.finish(generation?.requestDiagnosticId);
    if (first) for (let index = generationQueue.length - 1; index >= 0; index -= 1) if (generationQueue[index].chainId === first.chainId) generationQueue.splice(index, 1);
    if (generation?.stopped) return;
    if (cancelGenerationOperation(generation ? { ...generation, sourceEvent: 'GENERATION_ENDED' } : generation)) return;
    if (generation && slotOwner === generation.token) clearSlot(generation.token, { preserveSnapshot: true });
    else if (!generation && slotOwner !== null && !active) clearSlot(slotOwner, { preserveSnapshot: true });
  }

  function bind({ eventSource, eventTypes = {} } = {}) {
    if (!eventSource?.on) return;
    const on = (name, handler) => { const event = eventTypes[name]; if (event) eventSource.on(event, handler); };
    on('GENERATION_STARTED', onGenerationStarted);
    on('GENERATION_STOPPED', onGenerationStopped);
    on('GENERATION_ENDED', onGenerationEnded);
    on('CHAT_CHANGED', () => invalidate('chatChanged', 'CHAT_CHANGED'));
    on('CHAT_RENAMED', () => invalidate('chatChanged', 'CHAT_RENAMED'));
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
      if (active && activeReason) retainTerminated(active, activeReason, name);
      epoch += 1;
      if (activeReason) {
        active.controller.abort(activeReason);
        active = null;
        sessionReceipt = null;
      }
      clearSlot();
      if (parentChanged) { sessionReceipt = null; lastRecall = null; lastRecallBinding = null; lastRecallReceiptOwner = null; lastError = null; }
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
      if (!receiptSnapshot && [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, RECALL_RECEIPT_SCHEMA_VERSION].includes(receipt.schemaVersion)) {
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

  async function setEnabled(value) { enabledOverride = value === true; if (!enabledOverride) invalidate('disabled', 'runtimeDisabled'); return getState(); }
  function clearCurrent() { clearSlot(); lastRecall = null; lastPrequel = null; lastRecallBinding = null; lastRecallReceiptOwner = null; lastError = null; notify(); return getState(); }
  return Object.freeze({ intercept, bind, setEnabled, clearCurrent, restorePersistedReceipt, getPrequel, savePrequel, getState, getPromptSnapshot, invalidate, subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); } });
}
