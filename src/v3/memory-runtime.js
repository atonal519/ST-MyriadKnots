import { newIdentityUuid, sha256 } from '../identity.js';
import { buildFoundationIndexes } from './foundation-runtime.js';
import { createCheckpointInputFingerprints, deterministicUuid, scanAssistantCandidates } from './foundation-domain.js';
import { validateFoundationCheckpoint, validateFoundationRoot, validateFoundationRun, V3_INDEX_LAYOUT_FLOOR_ORDER } from './foundation-schema.js';
import { buildExtractorSystemPrompt, buildHighFloorExtractorSystemPrompt, runExtractorRequest, createExtractorEnvelope, inferCanonicalCurrentTime, EXTRACTOR_PROMPT_VERSION, EXTRACTOR_VERSION } from './extractor.js';
import { memorySourceFloorIds, validateEntityRecord, validateFloorMemory } from './memory-schema.js';
import { sanitizeDiagnosticValue, sanitizeSensitiveText, sanitizeTaskMetadata } from './safe-metadata.js';
import { createCseRuntime } from './cse-runtime.js';
import { filterReachableDeltas, replayCurrentState } from './cse-engine.js';
import { validateCseGraph } from './cse-schema.js';
import { assessMemoryCoverageFromHost, diagnosticsWithRealtimeOrigin, realtimeOriginFromReachable } from './memory-coverage.js';
import { isHostNarratorMessage, selectAssistantMessage, selectUserStabilityAnchor } from './foundation-domain.js';
import { normalizeStoryClockReferenceTags, parseStoryClockEvidence, storyClockSignature } from '../story-clock.js';
import { parseJsonOutput } from '../compact-api-client.js';
import { sanitizeMemoryContent } from '../memory-content-sanitizer.js';
import { buildEntityIdentityDirectory, entitiesThroughFloorIds, normalizeIdentityProjection } from './entity-identity.js';
import { matchFloorCandidates } from './floor-binding.js';
import { inspectMessageFloorAnchor } from './message-floor-anchor.js';
import { captureFloorVariableReference } from './floor-variable-reference.js';
import { publicErrorMessage } from '../public-error.js';
import { compileQianshiDelta, createQianshiCandidateIndex, pendingQianshiDelta, prepareQianshiCandidates, prepareQianshiRecallCandidates, projectQianshiCandidateSelection, projectQianshiGraph, projectQianshiRecall, publicQianshiSnapshot, QIANSHI_CANDIDATE_CHARACTER_BUDGET, QIANSHI_HISTORY_INPUT_TOKENS, QIANSHI_HISTORY_OUTPUT_TOKENS, QIANSHI_RECALL_PROJECTION_VERSION } from './qianshi-domain.js';
import { validateQianshiDelta } from './qianshi-schema.js';
import { tokenizeRecallText } from './recall-ranking.js';
import { estimateRecallTokens } from './recall-selector.js';
import { markPreparationFailure, preparationFailureDiagnostic, preparationStepFor, storedPreparationDiagnostic } from './preparation-diagnostic.js';

const EVENTS = Object.freeze(['CHAT_CHANGED', 'CHAT_RENAMED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED']);
const HISTORY_MUTATION_EVENTS = new Set(['MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED']);
const MANUAL_HISTORY_REASON = 'manualHistoricalRebuild';
const MANUAL_CSE_REBUILD_REASON = 'manualCseRebuild';
const QIANSHI_HISTORY_SYSTEM_PROMPT = `你是“千千结”的千事历史提取器。只输出 JSON：{"floors":[{"floorKey":"floor-N","qianshi":{"events":[],"order":[]}}]}。每个 qianshi.order 必须是对象数组，例如 [{"before":"event-1","after":"event-2","certainty":"explicit"}]；只写材料明确支持的先后关系，引用键沿用本楼和候选键合同。顶层 qianshiCandidates 是本批共享候选池，每楼只能使用其 qianshiCandidateKeys 列出的键。候选 candidateType=event 表示一次性事件，只能用于 context 或先后关系端点；只有持续事项候选才能用于 progress。每个事件正文必须放在 description 字段，事件对象示例：{"key":"event-1","title":"事件标题","description":"事件正文","status":"occurred","matter":false}；不得用 chatSummary 等自造字段替代 description。每个事件最多关联一个旧事项候选（links 中最多一个 candidateKey）；同一叙事影响多个旧事项时，按事项分别写成独立事件，每个事件只链接对应的一个候选。逐楼提取，但每楼按对后续叙事有用的事件单位整理，不按每个动作逐条拆分；同一场景同一事项的连续动作合成一件完整事件，没有新增事实、关系变化或事项进展的重复日常不另立事件。新计划、事项实质推进、完成、取消和关键变化仍须记录。只有计划、持续事项 matter=true；带来新事实或变化的一次性事件可为 matter=false。links 使用 candidateKey 和 kind=progress|context，倒叙补证必须用 context；禁止把无效 progress 默默降级为 context。可让后楼引用同批更早楼事件，candidateKey 写“更早floorKey:该事件key”，不得跨 floorKey 合并事件来源。storyTime 是发生时间，scheduledTime 是预计时间；材料已有故事年份或纪年时必须保留，只有月日或相对时间时不得猜当前故事年或现实年份。不得改写摘要，不得输出人物资料。`;
const qianshiHistoryInputTokens = request => estimateRecallTokens(QIANSHI_HISTORY_SYSTEM_PROMPT + JSON.stringify(request));
const qianshiHistoryBudgetRequest = inputs => ({ task: 'extractQianshiHistoryV1',
  qianshiCandidates: inputs.map((_, index) => ({ key: `candidate-budget-${index + 1}`, candidateType: 'matter',
    title: '候'.repeat(QIANSHI_CANDIDATE_CHARACTER_BUDGET) })),
  floors: inputs.map(input => ({ ...input, qianshiCandidateKeys: [] })) });
const qianshiEventSemanticSignature = event => JSON.stringify({ id: event.id, matterId: event.matterId, updatesMatter: event.updatesMatter,
  title: event.title, description: event.description, status: event.status, storyTime: event.storyTime,
  scheduledTime: event.scheduledTime, people: event.people, object: event.object, sourceFloorId: event.sourceFloorId,
  continuesFromEventIds: event.continuesFromEventIds });
const qianshiEventText = event => [event.title, event.description, event.storyTime, event.scheduledTime, event.object,
  ...(event.people ?? []).map(person => person.name)].filter(Boolean).join(' ');
function qianshiHistoryMatch(candidate, existing) {
  const terms = value => new Set(tokenizeRecallText(qianshiEventText(value)).filter(token => token.length > 1));
  const left = terms(candidate), right = terms(existing), shared = [...left].filter(token => right.has(token));
  const shorter = Math.max(1, Math.min(left.size, right.size));
  return shared.length >= 2 && shared.length / shorter >= 0.15 ? shared.slice(0, 8) : null;
}
const PREPARED_WRITE_CONCURRENCY = 4;
const MEMORY_REBASE_ATTEMPTS = 2;
const STALE_MEMORY_CODES = new Set(['V3_MEMORY_STALE', 'V3_MEMORY_CANCELLED', 'V3_MEMORY_PREFIX_CHANGED']);
const emptyManifest = () => ({ floor: [], entity: [], event: [], claim: [], knowledge: [], episode: [], thread: [], state: [], anchor: [], reverseRef: [] });
const nowIso = now => { const value = now()?.toISOString?.() ?? String(now()); if (!Number.isFinite(Date.parse(value))) throw new TypeError('V3_MEMORY_TIME_INVALID'); return value; };
const monotonicNow = () => Number(globalThis.performance?.now?.() ?? Date.now());
const elapsedMs = started => Math.max(0, Math.round((monotonicNow() - started) * 1000) / 1000);
const hash = async value => `sha256:${await sha256(JSON.stringify(value))}`;
const clone = value => structuredClone(value);
const counts = memory => Object.fromEntries(['chronology', 'locations', 'participants', 'actions', 'observations', 'informationTransfers', 'privateCognition', 'commitments', 'eventFragments', 'exactAnchors', 'openLoops', 'ambiguities', 'cseSignals'].map(field => [field, memory?.[field]?.length ?? 0]));
const effectiveSummary = memory => memory?.summary?.effectiveSource === 'user' ? memory.summary.userText : memory?.summary?.aiText;
function previousFloorContext(source, floorIndex, memoryMap) {
  for (let index = floorIndex - 1; index >= 0; index -= 1) {
    const memory = memoryMap.get(source.floors[index].id);
    if (memory?.recordStatus !== 'active') continue;
    const lastTime = Array.isArray(memory.chronology) ? memory.chronology.at(-1)?.time : null;
    const sourceText = typeof lastTime?.sourceText === 'string' ? lastTime.sourceText.trim() : '';
    const normalized = typeof lastTime?.normalized === 'string' ? lastTime.normalized.trim() : '';
    const summary = typeof effectiveSummary(memory) === 'string' ? effectiveSummary(memory).trim() : '';
    return Object.freeze({ time: sourceText || normalized || null, summaryTail: summary ? summary.slice(-300) : null });
  }
  return null;
}
export function projectMemoryPersonEntities(entities = []) {
  return Object.freeze(entities
    .filter(entity => entity?.entityType === 'person' && entity.recordStatus === 'active' && entity.status !== 'merged' && entity.status !== 'invalidated')
    .map(entity => Object.freeze({ entityId: entity.id, displayName: entity.displayName, specialRole: entity.specialRole })));
}
const safeApi = value => sanitizeTaskMetadata(value);
const safeErrorMessage = value => {
  const sanitized = sanitizeSensitiveText(value ?? '提取失败，可重试。').slice(0, 500);
  return publicErrorMessage(sanitized, { fallback: '处理失败，请稍后重试。' });
};
const unknownCoverage = total => Object.freeze({ status: 'unknown', completed: 0, total, nextAssistantSeq: null, pendingFloorIds: Object.freeze([]), realtimeProtected: false, hasPartialWork: false, summaryStatus: 'unknown', summaryCompleted: 0, summaryNextAssistantSeq: null, summaryPendingFloorIds: Object.freeze([]), summaryRealtimeProtected: false, summaryHasPartialWork: false });
const emptyCaughtUpCoverage = () => Object.freeze({ status: 'caughtUp', completed: 0, total: 0, nextAssistantSeq: null, pendingFloorIds: Object.freeze([]), realtimeProtected: true, hasPartialWork: false, summaryStatus: 'caughtUp', summaryCompleted: 0, summaryNextAssistantSeq: null, summaryPendingFloorIds: Object.freeze([]), summaryRealtimeProtected: true, summaryHasPartialWork: false });
const normalizedName = value => String(value ?? '').trim().normalize('NFKC').toLocaleLowerCase('zh-Hans-CN');

function errorWith(code, message = code) { const error = new Error(message); error.code = code; return error; }
function currentMemoryMap(reachable) { return new Map((reachable?.floorMemories ?? []).map(memory => [memory.floorId, memory])); }
function repairableQianshiDelta(reachable, memory, nowValue) {
  const delta = memory?.qianshiDelta;
  if (!delta || !['ready', 'partial'].includes(delta.status) || !delta.events?.length) return null;
  const diagnostics = projectQianshiGraph(reachable).diagnostics;
  const brokenRelations = new Set((diagnostics.danglingRelations ?? []).filter(item => item.floorId === memory.floorId)
    .map(item => JSON.stringify([item.relationId, item.fromEventId, item.toEventId])));
  const brokenContinuations = new Map();
  for (const item of diagnostics.danglingContinuations ?? []) if ((item.memoryFloorId ?? item.floorId) === memory.floorId) {
    const sources = brokenContinuations.get(item.eventId) ?? new Set(); sources.add(item.sourceEventId); brokenContinuations.set(item.eventId, sources);
  }
  const relations = delta.relations.filter(relation => !brokenRelations.has(JSON.stringify([relation.id, relation.fromEventId, relation.toEventId])));
  const events = delta.events.map(event => {
    const sources = brokenContinuations.get(event.id);
    return sources ? { ...event, continuesFromEventIds: event.continuesFromEventIds.filter(id => !sources.has(id)) } : event;
  });
  if (relations.length === delta.relations.length && events.every((event, index) => event.continuesFromEventIds.length === delta.events[index].continuesFromEventIds.length)) return null;
  return { ...delta, status: 'partial', reason: '事件保留，失效引用已隔离，关系仍待补。', compiledAt: nowValue, events, relations };
}
function coveredMemoryMap(reachable) {
  const result = new Map();
  for (const memory of reachable?.floorMemories ?? []) {
    if (memory?.recordStatus !== 'active') continue;
    for (const floorId of memorySourceFloorIds(memory)) result.set(floorId, memory);
  }
  return result;
}
function floorProvenance(reachable) { return reachable?.run?.diagnostics?.floorProvenance && typeof reachable.run.diagnostics.floorProvenance === 'object' ? clone(reachable.run.diagnostics.floorProvenance) : {}; }
function sameHostLocator(left, right) {
  return left?.messageIndex === right?.messageIndex && left?.swipeId === right?.swipeId && left?.selectedSwipeIndex === right?.selectedSwipeIndex;
}
function currentRawSelection(hostAdapter, floor) {
  if (typeof hostAdapter?.snapshot !== 'function') return null;
  return rawSelectionFromSnapshot(hostAdapter.snapshot(), floor);
}
function rawSelectionFromSnapshot(snapshot, floor) {
  const messageIndex = floor?.hostLocator?.messageIndex;
  const message = snapshot.chat?.[messageIndex];
  const selected = selectAssistantMessage(message);
  if (selected && sameHostLocator(floor?.hostLocator, { messageIndex, swipeId: selected.swipeId, selectedSwipeIndex: selected.selectedSwipeIndex })) return selected;
  const rebound = (snapshot.chat ?? []).map((candidate, index) => ({ candidate, index, anchor: inspectMessageFloorAnchor(candidate, floor?.chatId) }))
    .filter(item => item.anchor.status === 'valid' && item.anchor.anchor.floorId === floor?.id);
  if (rebound.length !== 1) return null;
  const reboundSelected = selectAssistantMessage(rebound[0].candidate);
  if (!reboundSelected || floor.hostLocator.swipeId !== reboundSelected.swipeId || floor.hostLocator.selectedSwipeIndex !== reboundSelected.selectedSwipeIndex) return null;
  return reboundSelected;
}

function selectedUserInput(message, expectedChatId) {
  if (!message || typeof message !== 'object' || message.is_user !== true) return null;
  const autoHideMarker = message.extra?.qianqianjieAutoHide;
  const autoHidden = autoHideMarker?.schemaVersion === 1 && autoHideMarker.chatId === expectedChatId;
  const systemEvent = isHostNarratorMessage(message) || (message.is_system === true && Boolean(message.extra?.type));
  if (systemEvent || (message.is_system === true && !autoHidden)) return null;
  if (Array.isArray(message.swipes)) {
    const selectedSwipeIndex = Number.isSafeInteger(message.swipe_id) ? message.swipe_id : 0;
    const content = message.swipes[selectedSwipeIndex];
    if (typeof content !== 'string') return null;
    return Object.freeze({ content: content.replace(/\r\n?/g, '\n'), swipeId: message.swipe_id ?? selectedSwipeIndex, selectedSwipeIndex });
  }
  if (typeof message.mes !== 'string') return null;
  return Object.freeze({ content: message.mes.replace(/\r\n?/g, '\n'), swipeId: message.swipe_id ?? null, selectedSwipeIndex: null });
}

function capturePrecedingUserInputFromSnapshot(snapshot, floor, options) {
  const expectedChatId = floor?.chatId;
  if (String(snapshot.context?.chatMetadata?.qianqianjie?.chatId ?? '').trim() !== expectedChatId) return null;
  const targetIndex = floor?.hostLocator?.messageIndex;
  if (!Number.isSafeInteger(targetIndex) || !selectAssistantMessage(snapshot.chat?.[targetIndex])) return null;
  const messages = [];
  for (let messageIndex = targetIndex - 1; messageIndex >= 0; messageIndex -= 1) {
    const selected = selectedUserInput(snapshot.chat?.[messageIndex], expectedChatId);
    if (!selected) break;
    const content = sanitizeMemoryContent(selected.content, options);
    if (!content) break;
    messages.push(Object.freeze({ content, messageIndex, swipeId: selected.swipeId, selectedSwipeIndex: selected.selectedSwipeIndex }));
    if (messages.length >= 40) break;
  }
  messages.reverse();
  return messages.length ? Object.freeze({ messages: Object.freeze(messages) }) : null;
}
function capturePrecedingUserInputSnapshot(hostAdapter, floor, options) {
  return capturePrecedingUserInputFromSnapshot(hostAdapter.snapshot(), floor, options);
}
function clockEvidence(selected, referenceTags) {
  const clock = parseStoryClockEvidence(selected?.rawContent, referenceTags);
  if (!clock) return Object.freeze({ clock: null, signature: '', displayText: '' });
  if (typeof clock.referenceText === 'string') {
    const clockValue = Object.freeze({ complete: false, namespace: clock.namespace, start: null, end: null, referenceText: clock.referenceText });
    return Object.freeze({ signature: storyClockSignature(clock), clock: clockValue, displayText: clock.referenceText });
  }
  const compact = value => value ? Object.freeze({ raw: value.raw, date: value.date, weekday: value.weekday, time: value.time }) : null;
  const pairs = (clock.pairs ?? []).map(pair => Object.freeze({ start: compact(pair.startMeta), end: compact(pair.endMeta) }));
  const clockValue = Object.freeze({ complete: clock.complete === true, namespace: clock.namespace, start: compact(clock.startMeta), end: compact(clock.endMeta), ...(pairs.length > 1 ? { pairs: Object.freeze(pairs) } : {}) });
  const part = value => [value?.date, value?.weekday, value?.time].filter(Boolean).join(' ');
  return Object.freeze({
    signature: storyClockSignature(clock),
    clock: clockValue,
    displayText: pairs.length > 1
      ? pairs.map(pair => `${part(pair.start)} → ${part(pair.end)}`).join('；')
      : [...new Set([part(clockValue.start), part(clockValue.end)].filter(Boolean))].join(' → '),
  });
}

const SESSION_CANDIDATE_MAX_ENTRIES = 8;
const SESSION_CANDIDATE_MAX_CHARACTERS = 96000;
const FLOOR_FAILURE_STORAGE_PREFIX = 'qqj_v3_floor_failures:';
const normalizeAutoBatchSize = () => 1;
const floorFailureStorageKey = chatId => `${FLOOR_FAILURE_STORAGE_PREFIX}${chatId}`;

export function createQianshiSnapshotMemo(projector = publicQianshiSnapshot) {
  let cache = null;
  return (reachable, identityProjection, history) => {
    if (cache?.reachable !== reachable || cache.identityProjection !== identityProjection) {
      cache = { reachable, identityProjection, value: projector(reachable, null, identityProjection) };
    }
    return { ...cache.value, history };
  };
}

export function createV3MemoryRuntime({ foundationRuntime, store, hostAdapter, generateAnalysisTask, generateUtilityTask, isEnabled = true, automationSettings = () => ({ enabled: false, batchSize: 1 }), notifyUser = null, isMainGenerationActive = () => false, onAutomaticSummaryCommitted = () => {}, onMemoryBatchCommitted = () => {}, extractorPromptGuidance = () => '', csePromptGuidance = () => '', processingPrompt = () => '', storyClockReferenceTags = () => '', filterWorldInfoSources = sources => sources, sanitizerOptions = () => ({}), persistAnchors = null, identityProjectionProvider = null, qianshiCandidatePreparer = prepareQianshiCandidates, qianshiCandidateIndexFactory = createQianshiCandidateIndex, failureStorage = undefined, now = () => new Date(), newUuid = newIdentityUuid, logger = console } = {}) {
  if (!foundationRuntime || ['start', 'refreshStatus', 'confirmLatest', 'setEnabled', 'bind', 'getState'].some(name => typeof foundationRuntime[name] !== 'function')) throw new TypeError('V3 memory foundation runtime 无效');
  if (!store || ['readReachable', 'readRecord', 'putRecord', 'commitRoot', 'recordKey', 'invalidate'].some(name => typeof store[name] !== 'function')) throw new TypeError('V3 memory store 无效');
  if (typeof generateAnalysisTask !== 'function') throw new TypeError('V3 memory analysis route 无效');
  if (typeof generateUtilityTask !== 'function') throw new TypeError('V3 memory utility route 无效');
  let browserFailureStorage = failureStorage;
  if (browserFailureStorage === undefined) {
    try { browserFailureStorage = globalThis.localStorage; } catch { browserFailureStorage = null; }
  }
  let epoch = 0;
  let active = null;
  let reachable = null;
  let lastFailure = null;
  let bound = false;
  let awaitingFoundation = false;
  let foundationReload = null;
  let refreshInFlight = null;
  let memorySnapshotStatus = 'unavailable';
  let memorySyncStatus = 'idle';
  let memorySyncError = null;
  let backgroundSync = null;
  let backgroundSyncKey = null;
  let unsubscribeFoundation = null;
  let workRun = null;
  let autoScheduled = null;
  let autoEpoch = 0;
  let autoTriggerReason = null;
  let autoTriggerAuthorization = null;
  let lastAutoRun = null;
  let historicalAuthorization = null;
  let historicalAggregate = false;
  let cseRebuildPlan = null;
  let formalGenerationActive = false;
  let generationArm = null;
  let generationLifecycle = null;
  let stoppedGenerationFinal = null;
  let generationSequence = 0;
  let observedHostChatLength = 0;
  let establishedMemoryChatId = null;
  const grantedEventKeys = new Set();
  let suffixGenerationContext = null;
  let emptyRealtimeOrigin = null;
  let coverage = unknownCoverage(0);
  let lastAutomaticInputKey = null;
  let lastNoticeKey = null;
  let identityProjection = normalizeIdentityProjection();
  let timeFallbackByFloor = new Map();
  let failureScope = null;
  const sessionCandidates = new Map();
  const pendingResults = new Map();
  let qianshiHistoryPlan = null;
  let qianshiReviewedClosePlan = null;
  let qianshiHistoryRun = null;
  let qianshiHistoryState = Object.freeze({ status: 'idle', jobId: null, processedFloors: 0, totalFloors: 0, calls: 0, outcomes: [], pendingReviews: [], message: '' });
  const qianshiSnapshotMemo = createQianshiSnapshotMemo();
  const qianshiCandidateIndex = qianshiCandidatePreparer === prepareQianshiCandidates ? qianshiCandidateIndexFactory() : null;
  const subscribers = new Set();
  const currentReferenceTags = () => normalizeStoryClockReferenceTags(typeof storyClockReferenceTags === 'function' ? storyClockReferenceTags() : storyClockReferenceTags);
  const currentClockSignature = floor => clockEvidence(currentRawSelection(hostAdapter, floor), currentReferenceTags()).signature;
  let commitTail = Promise.resolve();
  const commitGate = task => {
    const pending = commitTail.then(task);
    commitTail = pending.catch(() => {});
    return pending;
  };
  const cseRuntime = createCseRuntime({ store, hostAdapter, generateAnalysisTask, isEnabled, commitGate, promptGuidance: csePromptGuidance, processingPrompt, filterWorldInfoSources, sanitizerOptions, storyClockSignatureForFloor: currentClockSignature, onGraphCommitted: value => {
    reachable = value;
    foundationRuntime.adoptReachable?.(value);
  }, onFailureHint: (value, floorId, failure) => failure ? rememberCseFloorFailure(value, failure) : clearCseFloorFailure(floorId, value), now, newUuid, logger });
  const setIdentityProjection = value => {
    identityProjection = normalizeIdentityProjection(value);
    cseRuntime.setIdentityProjection?.(identityProjection);
    return identityProjection;
  };
  const readIdentityProjection = async () => {
    if (typeof identityProjectionProvider !== 'function') return identityProjection;
    const value = await identityProjectionProvider();
    return setIdentityProjection(value?.data ?? value ?? {});
  };
  const enabled = () => { try { return (typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true; } catch { return false; } };
  const mainGenerationActive = () => {
    if (formalGenerationActive) return true;
    try { return (typeof isMainGenerationActive === 'function' ? isMainGenerationActive() : isMainGenerationActive) === true; } catch { return false; }
  };
  const currentHostChatId = () => { try { return String(hostAdapter.snapshot()?.context?.chatMetadata?.qianqianjie?.chatId ?? '').trim(); } catch { return ''; } };
  const failureScopeMatches = root => Boolean(root && failureScope?.chatId === root.chatId && failureScope.narrativeGeneration === root.narrativeGeneration);
  const readFailureHint = (entry, fallbackCode) => {
    if (!entry || typeof entry !== 'object' || !Number.isSafeInteger(entry.count) || entry.count < 1 || typeof entry.lastReason !== 'string') return null;
    return {
      count: entry.count,
      lastReason: safeErrorMessage(entry.lastReason),
      code: String(entry.code ?? fallbackCode).slice(0, 120),
      lastFailedAt: typeof entry.lastFailedAt === 'string' ? entry.lastFailedAt.slice(0, 80) : '',
    };
  };
  const readAutomationFailureHint = entry => {
    const common = readFailureHint(entry, 'V3_AUTO_MEMORY_FAILED');
    if (!common) return null;
    return { ...common, phase: String(entry.phase ?? 'unknown').slice(0, 80), ...storedPreparationDiagnostic(entry) };
  };
  const nextFailureHint = (previous, failure, fallbackCode) => ({
    count: Number.isSafeInteger(previous?.count) && previous.count > 0 ? previous.count + 1 : 1,
    lastReason: safeErrorMessage(failure.message),
    code: String(failure.code ?? fallbackCode).slice(0, 120),
    lastFailedAt: nowIso(now),
  });
  const savedFailureMessage = failure => failure ? `连续失败 ${failure.count} 次；最近：${failure.lastReason}${failure.lastFailedAt ? `（${failure.lastFailedAt}）` : ''}` : null;
  const readFailureScope = value => {
    const root = value?.root;
    if (!root?.chatId || !root.narrativeGeneration || failureScopeMatches(root)) return;
    const failures = {}, cseFailures = {};
    let automationFailure = null;
    try {
      const parsed = JSON.parse(browserFailureStorage?.getItem?.(floorFailureStorageKey(root.chatId)) || 'null');
      if (parsed?.narrativeGeneration === root.narrativeGeneration) {
        for (const floor of value.floors ?? []) {
          const summary = readFailureHint(parsed.failures?.[floor.id], 'V3_EXTRACTOR_FAILED');
          const cse = readFailureHint(parsed.cseFailures?.[floor.id], 'V3_CSE_FAILED');
          if (summary) failures[floor.id] = summary;
          if (cse) cseFailures[floor.id] = cse;
        }
        const savedAutomation = readAutomationFailureHint(parsed.automationFailure);
        if (savedAutomation) automationFailure = savedAutomation;
      }
    } catch { /* optional browser failure hints must not block memory */ }
    failureScope = { chatId: root.chatId, narrativeGeneration: root.narrativeGeneration, failures, cseFailures, automationFailure };
  };
  const writeFailureScope = (value = reachable) => {
    const root = value?.root;
    if (!root || !failureScopeMatches(root)) return;
    const activeFloorIds = new Set((value.floors ?? []).map(floor => floor.id));
    const failures = Object.fromEntries(Object.entries(failureScope.failures).filter(([floorId]) => activeFloorIds.has(floorId)));
    const cseFailures = Object.fromEntries(Object.entries(failureScope.cseFailures).filter(([floorId]) => activeFloorIds.has(floorId)));
    failureScope = { ...failureScope, failures, cseFailures };
    try {
      const key = floorFailureStorageKey(root.chatId);
      if (Object.keys(failures).length || Object.keys(cseFailures).length || failureScope.automationFailure) {
        const payload = { narrativeGeneration: root.narrativeGeneration };
        if (Object.keys(failures).length) payload.failures = failures;
        if (Object.keys(cseFailures).length) payload.cseFailures = cseFailures;
        if (failureScope.automationFailure) payload.automationFailure = failureScope.automationFailure;
        browserFailureStorage?.setItem?.(key, JSON.stringify(payload));
      }
      else browserFailureStorage?.removeItem?.(key);
    } catch { /* optional browser failure hints must not block memory */ }
  };
  const rememberFloorFailure = (value, failure) => {
    try {
      readFailureScope(value);
      if (!failureScopeMatches(value?.root)) return;
      const previous = failureScope.failures[failure.floorId];
      failureScope = { ...failureScope, failures: { ...failureScope.failures, [failure.floorId]: nextFailureHint(previous, failure, 'V3_EXTRACTOR_FAILED') } };
      writeFailureScope(value);
    } catch { /* optional browser failure hints must not replace the real extraction error */ }
  };
  const clearFloorFailure = (floorId, value = reachable) => {
    if (!failureScopeMatches(value?.root) || !Object.hasOwn(failureScope.failures, floorId)) return;
    const failures = { ...failureScope.failures };
    delete failures[floorId];
    failureScope = { ...failureScope, failures };
    writeFailureScope(value);
  };
  const rememberCseFloorFailure = (value, failure) => {
    try {
      readFailureScope(value);
      if (!failureScopeMatches(value?.root)) return;
      const previous = failureScope.cseFailures[failure.floorId];
      failureScope = { ...failureScope, cseFailures: { ...failureScope.cseFailures, [failure.floorId]: nextFailureHint(previous, failure, 'V3_CSE_FAILED') } };
      writeFailureScope(value);
    } catch { /* optional browser failure hints must not replace the real CSE error */ }
  };
  const clearCseFloorFailure = (floorId, value = reachable) => {
    if (!failureScopeMatches(value?.root) || !Object.hasOwn(failureScope.cseFailures, floorId)) return;
    const cseFailures = { ...failureScope.cseFailures };
    delete cseFailures[floorId];
    failureScope = { ...failureScope, cseFailures };
    writeFailureScope(value);
  };
  const rememberAutomationFailure = (value, failure) => {
    try {
      readFailureScope(value);
      if (!failureScopeMatches(value?.root)) return;
      failureScope = { ...failureScope, automationFailure: { ...nextFailureHint(failureScope.automationFailure, failure, 'V3_AUTO_MEMORY_FAILED'), phase: String(failure.phase ?? 'unknown').slice(0, 80), ...storedPreparationDiagnostic(failure) } };
      writeFailureScope(value);
    } catch { /* optional browser failure hints must not replace the real automation error */ }
  };
  const clearAutomationFailure = (value = reachable) => {
    if (!failureScopeMatches(value?.root) || !failureScope.automationFailure) return;
    failureScope = { ...failureScope, automationFailure: null };
    writeFailureScope(value);
  };
  const clearChatFailures = chatId => {
    const targetChatId = String(chatId ?? '').trim();
    if (!targetChatId) return;
    if (failureScope?.chatId === targetChatId) failureScope = { ...failureScope, failures: {}, cseFailures: {}, automationFailure: null };
    try { browserFailureStorage?.removeItem?.(floorFailureStorageKey(targetChatId)); } catch { /* optional browser failure hints */ }
  };
  async function ensureSavedAnchors(value, expectedEpoch = epoch) {
    if (!value?.root || typeof persistAnchors !== 'function' || expectedEpoch !== epoch) return true;
    try {
      const activeFloorIds = new Set((value.floorMemories ?? [])
        .filter(memory => memory.recordStatus === 'active')
        .flatMap(memorySourceFloorIds));
      const snapshot = hostAdapter.snapshot();
      const candidates = await scanAssistantCandidates(snapshot.chat, { sanitizerOptions: sanitizerOptions(), chatId: value.root.chatId });
      const matched = matchFloorCandidates(value.floors ?? [], candidates);
      if (matched.issue) {
        throw Object.assign(errorWith('V3_MESSAGE_ANCHOR_MIGRATION_UNPROVEN', '旧摘要无法唯一绑定到当前消息，已保留原记录并等待人工处理。'), {
          assistantSeq: matched.issue.assistantSeq,
          messageIndex: matched.issue.messageIndex,
          markerStatus: matched.issue.markerStatus,
          bindingIssue: matched.issue.code,
        });
      }
      const bindings = [];
      for (const [floorIndex, floor] of (value.floors ?? []).entries()) {
        if (!activeFloorIds.has(floor.id)) continue;
        const binding = matched.floorMatches.get(floorIndex);
        if (!binding) {
          const candidate = candidates[floorIndex] ?? null;
          throw Object.assign(errorWith('V3_MESSAGE_ANCHOR_MIGRATION_UNPROVEN', '旧摘要无法唯一绑定到当前消息，已保留原记录并等待人工处理。'), {
            floorId: floor.id,
            assistantSeq: floor.assistantSeq ?? null,
            messageIndex: candidate?.hostLocator?.messageIndex ?? floor.hostLocator?.messageIndex ?? null,
            markerStatus: candidate?.messageAnchor?.status ?? null,
            rawFingerprintMatches: candidate ? floor.content?.rawFingerprint === candidate.rawFingerprint : null,
            canonicalFingerprintMatches: candidate ? floor.content?.canonicalFingerprint === candidate.canonicalFingerprint : null,
          });
        }
        bindings.push({ messageIndex: binding.candidate.hostLocator.messageIndex, floorId: floor.id });
      }
      if (!bindings.length) {
        if (lastFailure?.phase === 'anchor') lastFailure = null;
        return true;
      }
      await persistAnchors({ hostAdapter, chatId: value.root.chatId, bindings });
      if (expectedEpoch !== epoch || currentHostChatId() !== value.root.chatId) return false;
      if (lastFailure?.phase === 'anchor') lastFailure = null;
      return true;
    } catch (error) {
      if (expectedEpoch === epoch && currentHostChatId() === value.root.chatId) {
        lastFailure = Object.freeze({ floorId: error?.floorId ?? null, runId: null, phase: 'anchor', code: error?.code ?? 'V3_MESSAGE_ANCHOR_SAVE_FAILED', message: safeErrorMessage(error?.message ?? '摘要已保存，但消息标识尚未持久化；刷新可重试，无需重新摘要。'),
          ...(['assistantSeq', 'messageIndex', 'markerStatus', 'bindingIssue', 'rawFingerprintMatches', 'canonicalFingerprintMatches']
            .filter(key => error?.[key] !== undefined).reduce((details, key) => ({ ...details, [key]: error[key] }), {})) });
      }
      return false;
    }
  }
  const automation = () => {
    try {
      const value = typeof automationSettings === 'function' ? automationSettings() : automationSettings;
      return Object.freeze({ enabled: value?.enabled === true, batchSize: normalizeAutoBatchSize(value?.batchSize) });
    } catch {
      return Object.freeze({ enabled: false, batchSize: 1 });
    }
  };
  const notify = () => { const snapshot = getState(); for (const listener of subscribers) { try { listener(snapshot); } catch { /* UI listener isolation */ } } return snapshot; };
  const markMemorySyncing = () => {
    memorySyncStatus = 'syncing';
    memorySyncError = null;
    if (!reachable) memorySnapshotStatus = 'syncing';
  };
  const currentInputKey = () => reachable?.root
    ? `${reachable.root.chatId}:${reachable.root.narrativeGeneration}:${reachable.root.sourceSnapshotFingerprint}:${reachable.root.stableBoundary?.floorId ?? ''}:${reachable.root.stableBoundary?.canonicalFingerprint ?? ''}`
    : null;
  const hasEstablishedMemory = () => Boolean(reachable?.floorMemories?.some(memory => memory?.recordStatus === 'active'));
  const hasEstablishedChat = () => Boolean(currentHostChatId() && establishedMemoryChatId === currentHostChatId());
  const hasExplicitInitializationIntent = () => hasEstablishedMemory() || hasEstablishedChat()
    || (automation().enabled && allowsRealtimeTailFromEmpty())
    || workRun?.kind === 'manual'
    || historicalAuthorization !== null
    || cseRebuildPlan !== null;
  const notifyOnce = (key, value) => {
    if (!key || key === lastNoticeKey) return false;
    lastNoticeKey = key;
    try { notifyUser?.(value); } catch { /* notification must not affect memory work */ }
    return true;
  };
  const floorMessageIndex = floor => Number.isSafeInteger(floor?.hostLocator?.messageIndex) ? floor.hostLocator.messageIndex : null;
  const floorCopy = floor => floorMessageIndex(floor) === null ? '楼号未提供' : `第 ${floorMessageIndex(floor)} 楼`;
  const summaryDebtCopy = ({ floor, count, retry }) => `从${floorCopy(floor)}起还有 ${Math.max(0, count)} 楼摘要未完成；${retry}`;
  const missingSummaryCount = floorSet => {
    const memoryMap = coveredMemoryMap(reachable);
    return (reachable?.floors ?? []).filter(floor => (!floorSet || floorSet.has(floor.id))
      && memoryMap.get(floor.id)?.recordStatus !== 'active').length;
  };
  const hasAutomaticCatchupWork = (state = getState()) => {
    const config = automation();
    const pendingSummaries = Math.max(0, state.stableCount - state.summaryCompletedCount);
    return config.enabled && ((state.summaryCoverageStatus === 'realtimeTail' && pendingSummaries >= config.batchSize)
      || state.cseFloors.some(floor => floor.status === 'pending'));
  };
  const notifyConfirmedSummaryBlock = (state = getState()) => {
    const config = automation();
    const unfinished = missingSummaryCount();
    if (!config.enabled || state.summaryCoverageStatus !== 'historicalDebt' || unfinished === 0
      || (['partial', 'failed'].includes(lastAutoRun?.status) && lastAutomaticInputKey === currentInputKey())
      || state.cseFloors.some(floor => floor.status === 'pending')) return false;
    const memoryMap = coveredMemoryMap(reachable);
    const firstPending = reachable?.floors?.find(floor => memoryMap.get(floor.id)?.recordStatus !== 'active') ?? null;
    return notifyOnce(`authorization:${currentInputKey()}:${firstPending?.id ?? 'unknown'}:${unfinished}`, {
      kind: 'warning',
      text: `千千结发现需要用户确认的历史摘要缺口：${summaryDebtCopy({ floor: firstPending, count: unfinished, retry: '这是历史缺口，不会自动补，请在记忆管理中点击继续。' })}`,
    });
  };
  const cancelAutomation = (reason = 'automationCancelled') => {
    autoEpoch += 1;
    autoTriggerReason = null;
    autoTriggerAuthorization = null;
    historicalAuthorization = null;
    historicalAggregate = false;
    if (workRun?.kind === 'auto') {
      if (workRun.mode === 'cseRebuild' && cseRebuildPlan?.status === 'running') cseRebuildPlan = { ...cseRebuildPlan, status: 'paused' };
      active?.controller.abort(reason);
      cseRuntime.cancelActive?.();
    }
  };
  const cancelEarlyStabilization = reason => { try { foundationRuntime.cancelEarlyStabilization?.(reason); } catch { /* foundation cancellation is best-effort */ } };
  const invalidate = ({ deletedChatId = null } = {}) => { if (deletedChatId) clearChatFailures(deletedChatId); cancelEarlyStabilization('memoryInvalidated'); cancelAutomation('memoryInvalidated'); qianshiHistoryRun?.controller.abort('memoryInvalidated'); qianshiHistoryRun = null; qianshiHistoryPlan = null; qianshiHistoryState = Object.freeze({ status: 'idle', jobId: null, processedFloors: 0, totalFloors: 0, calls: 0, message: '' }); qianshiCandidateIndex?.invalidate(); epoch += 1; active?.controller.abort('memoryInvalidated'); active = null; workRun = null; cseRebuildPlan = null; reachable = null; memorySnapshotStatus = 'unavailable'; memorySyncStatus = 'idle'; memorySyncError = null; backgroundSync = null; backgroundSyncKey = null; timeFallbackByFloor = new Map(); failureScope = null; coverage = unknownCoverage(0); emptyRealtimeOrigin = null; formalGenerationActive = false; generationArm = null; generationLifecycle = null; stoppedGenerationFinal = null; observedHostChatLength = 0; establishedMemoryChatId = null; grantedEventKeys.clear(); suffixGenerationContext = null; lastFailure = null; lastAutoRun = null; lastAutomaticInputKey = null; lastNoticeKey = null; awaitingFoundation = false; historicalAggregate = false; sessionCandidates.clear(); pendingResults.clear(); cseRuntime.invalidate(); notify(); };
  cseRuntime.subscribe(() => notify());
  function runManualWork(reason, task) {
    if (workRun) return Promise.resolve(getState());
    const operation = { kind: 'manual', reason, phase: reason, floorIds: [], promise: null, startedAt: nowIso(now), startedMonotonic: monotonicNow() };
    workRun = operation;
    notify();
    operation.promise = Promise.resolve().then(() => task(operation)).finally(() => {
      if (workRun === operation) workRun = null;
      notify();
      if (autoTriggerReason && scheduleAllowed(autoTriggerReason)) void scheduleAutomation(autoTriggerReason);
    });
    return operation.promise;
  }
  const rememberSessionCandidate = (floorId, value) => {
    const candidate = String(value ?? '').slice(0, 24000);
    if (!candidate) return;
    sessionCandidates.delete(floorId);
    sessionCandidates.set(floorId, candidate);
    let totalCharacters = [...sessionCandidates.values()].reduce((sum, item) => sum + item.length, 0);
    while (sessionCandidates.size > SESSION_CANDIDATE_MAX_ENTRIES || totalCharacters > SESSION_CANDIDATE_MAX_CHARACTERS) {
      const oldestKey = sessionCandidates.keys().next().value;
      if (oldestKey === undefined) break;
      totalCharacters -= sessionCandidates.get(oldestKey)?.length ?? 0;
      sessionCandidates.delete(oldestKey);
    }
  };
  const rememberPendingResult = (floorId, value) => {
    pendingResults.set(floorId, clone(value));
  };

  function floorState(floor, memoryMap, provenance) {
    const memory = memoryMap.get(floor.id) ?? null;
    const meta = provenance[floor.id] ?? null;
    const running = active?.floorId === floor.id;
    const savedFailure = failureScopeMatches(reachable?.root) ? failureScope.failures[floor.id] ?? null : null;
    const transientFailure = lastFailure?.floorId === floor.id ? lastFailure : null;
    const status = running ? 'running' : memory?.recordStatus === 'active'
      ? 'ready'
      : memory?.recordStatus === 'invalidated' ? 'error'
        : transientFailure || savedFailure ? 'failed' : 'unprocessed';
    const manualTime = meta?.timeEdited === true;
    const savedError = savedFailureMessage(savedFailure);
    const failureError = transientFailure && transientFailure.phase !== 'retryableError' ? transientFailure.message : savedError ?? transientFailure?.message;
    const sourceFloorIds = memory ? memorySourceFloorIds(memory) : [floor.id];
    const sourceFloors = sourceFloorIds.map(id => reachable?.floors?.find(item => item.id === id)).filter(Boolean);
    return Object.freeze({ floorId: floor.id, assistantSeq: floor.assistantSeq, messageIndex: floor.hostLocator.messageIndex,
      sourceFloorIds: Object.freeze([...sourceFloorIds]), sourceAssistantSeqs: Object.freeze(sourceFloors.map(item => item.assistantSeq)),
      sourceMessageIndexes: Object.freeze(sourceFloors.map(item => item.hostLocator.messageIndex)),
      canonicalFingerprint: floor.content.canonicalFingerprint, rawFingerprint: floor.content.rawFingerprint, status, memoryId: memory?.id ?? null, summary: effectiveSummary(memory) ?? '', summarySource: memory?.summary?.effectiveSource ?? null, aiSummary: memory?.summary?.aiText ?? '', revisionNote: memory?.summary?.revisionNote ?? null, extractorVersion: memory?.extractorVersion ?? EXTRACTOR_VERSION, counts: counts(memory), api: meta?.api ?? null, attempts: meta?.attempts ?? 0, runId: meta?.runId ?? null, checkpointId: reachable?.checkpoint?.id ?? null, manualTime, timeFallback: timeFallbackByFloor.get(floor.id) ?? '', error: failureError ?? (memory?.recordStatus === 'invalidated' ? '该楼记忆已标记错误，可重新提取。' : null), memory });
  }
  function persistedCseRebuildPlan(value) {
    const saved = value?.run?.diagnostics?.cseRebuild;
    if (!saved || saved.version !== 1 || saved.status !== 'active'
      || saved.chatId !== value?.root?.chatId || saved.narrativeGeneration !== value?.root?.narrativeGeneration
      || typeof saved.jobId !== 'string' || !saved.jobId || !Array.isArray(saved.targets) || !saved.targets.length
      || !Array.isArray(saved.completedFloorIds) || saved.completedFloorIds.length >= saved.targets.length) return null;
    const memoryMap = currentMemoryMap(value);
    const targets = [];
    for (let index = 0; index < saved.targets.length; index += 1) {
      const target = saved.targets[index], floor = value.floors?.find(item => item.id === target?.floorId), memory = floor ? memoryMap.get(floor.id) : null;
      if (!target || !floor || target.memoryId !== memory?.id || memory?.recordStatus !== 'active') return null;
      targets.push(Object.freeze({ floorId: target.floorId, memoryId: target.memoryId, assistantSeq: floor.assistantSeq }));
    }
    if (saved.completedFloorIds.some((floorId, index) => floorId !== targets[index]?.floorId)) return null;
    return Object.freeze({ jobId: saved.jobId, chatId: saved.chatId, narrativeGeneration: saved.narrativeGeneration, targets: Object.freeze(targets), nextIndex: saved.completedFloorIds.length, status: 'paused', error: null });
  }
  function persistedCseRebuildCompletedCount(value, plan) {
    const saved = value?.run?.diagnostics?.cseRebuild;
    if (!saved || saved.version !== 1 || saved.jobId !== plan?.jobId
      || saved.chatId !== plan?.chatId || saved.narrativeGeneration !== plan?.narrativeGeneration
      || !Array.isArray(saved.targets) || saved.targets.length !== plan.targets.length
      || !Array.isArray(saved.completedFloorIds) || saved.completedFloorIds.length > saved.targets.length) return null;
    if (saved.targets.some((target, index) => target?.floorId !== plan.targets[index]?.floorId
      || target?.memoryId !== plan.targets[index]?.memoryId)) return null;
    if (saved.completedFloorIds.some((floorId, index) => floorId !== plan.targets[index]?.floorId)) return null;
    return saved.completedFloorIds.length;
  }
  const cseRebuildDiagnostic = (plan, completedCount) => Object.freeze({
    version: 1,
    jobId: plan.jobId,
    chatId: plan.chatId,
    narrativeGeneration: plan.narrativeGeneration,
    targets: plan.targets.map(target => ({ floorId: target.floorId, memoryId: target.memoryId })),
    completedFloorIds: plan.targets.slice(0, completedCount).map(target => target.floorId),
    status: completedCount >= plan.targets.length ? 'completed' : 'active',
  });
  function getState() {
    const foundation = foundationRuntime.getState();
    const memoryMap = currentMemoryMap(reachable);
    const coverageMap = coveredMemoryMap(reachable);
    const provenance = floorProvenance(reachable);
    const floors = (reachable?.floors ?? [])
      .filter(floor => !coverageMap.has(floor.id) || coverageMap.get(floor.id)?.floorId === floor.id)
      .map(floor => floorState(floor, memoryMap, provenance));
    const stableCount = reachable?.floors?.length ?? 0;
    const rememberedCount = coverageMap.size;
    const rawCse = cseRuntime.getState();
    const savedCseFailures = failureScopeMatches(reachable?.root) ? failureScope.cseFailures : {};
    const visibleFloorIds = new Set(floors.map(item => item.floorId));
    const cseFloors = (rawCse.cseFloors ?? []).filter(item => visibleFloorIds.has(item.floorId)).map(item => {
      const savedFailure = savedCseFailures[item.floorId] ?? null;
      return Object.freeze({ ...item, status: item.status === 'pending' && savedFailure ? 'failed' : item.status, error: item.error ?? savedFailureMessage(savedFailure) });
    });
    const latestSavedCse = Object.entries(savedCseFailures).reduce((latest, current) => !latest || String(current[1].lastFailedAt).localeCompare(String(latest[1].lastFailedAt)) >= 0 ? current : latest, null);
    const savedCseError = latestSavedCse ? Object.freeze({ floorId: latestSavedCse[0], code: latestSavedCse[1].code, message: savedFailureMessage(latestSavedCse[1]), phase: 'retryableError', count: latestSavedCse[1].count, lastFailedAt: latestSavedCse[1].lastFailedAt }) : null;
    const cse = Object.freeze({ ...rawCse, cseFloors: Object.freeze(cseFloors), csePendingCount: cseFloors.filter(item => item.status === 'pending').length, cseFailedCount: cseFloors.filter(item => item.status === 'failed').length, lastCseError: rawCse.lastCseError ?? savedCseError });
    const cseByFloor = new Map(cseFloors.map(item => [item.floorId, item]));
    const combinedFloors = floors.map(item => Object.freeze({ ...item, cse: cseByFloor.get(item.floorId) ?? null }));
    const memoryEntities = projectMemoryPersonEntities(reachable?.entities ?? []);
    const cseByMemoryFloor = new Map(cseFloors.map(item => [item.floorId, item]));
    const rebuildCompletedCount = (reachable?.floors ?? []).filter(floor => {
      const memory = coverageMap.get(floor.id);
      return memory?.recordStatus === 'active' && cseByMemoryFloor.get(memory.floorId)?.deltaId;
    }).length;
    const rebuildNextAssistantSeq = (reachable?.floors ?? []).find(floor => {
      const memory = coverageMap.get(floor.id);
      return memory?.recordStatus !== 'active' || !cseByMemoryFloor.get(memory.floorId)?.deltaId;
    })?.assistantSeq ?? null;
    const summaryCompletedCount = Math.min(coverage.summaryCompleted ?? rememberedCount, stableCount);
    const cseRebuildResumable = ['paused', 'failed'].includes(cseRebuildPlan?.status);
    const rebuildHasActionableWork = (coverage.status !== 'unknown' && coverage.completed < coverage.total)
      || foundation.canInitialize === true || cseRebuildResumable;
    const auto = automation();
    const rebuildStatus = workRun?.kind === 'auto' && workRun.mode === 'historical' ? 'rebuilding'
        : foundation.canInitialize === true ? 'pendingRebuild'
          : ['failed', 'partial'].includes(lastAutoRun?.status) && coverage.status !== 'caughtUp' ? lastAutoRun.status
          : lastAutoRun?.status === 'paused' && coverage.status !== 'caughtUp' ? 'paused'
            : coverage.status === 'caughtUp' ? 'caughtUp'
              : coverage.status === 'realtimeTail' ? 'waitingRealtime'
              : coverage.status === 'historicalDebt' ? 'pendingRebuild' : 'notReady';
    const savedAutomation = failureScopeMatches(reachable?.root) ? failureScope.automationFailure : null;
    const lastAutomationError = savedAutomation ? Object.freeze({ code: savedAutomation.code, name: savedAutomation.name, message: savedFailureMessage(savedAutomation), phase: savedAutomation.phase, prepareStep: savedAutomation.prepareStep, detail: savedAutomation.detail, location: savedAutomation.location, count: savedAutomation.count, lastFailedAt: savedAutomation.lastFailedAt }) : null;
    return Object.freeze({ ...foundation, ...cse, status: workRun || active || cse.activeCse ? 'running' : foundation.status, memorySnapshotStatus, memorySyncStatus, memorySyncError, stableCount, rememberedCount, summaryCoverageStatus: coverage.summaryStatus, summaryCompletedCount, summaryNextAssistantSeq: coverage.summaryNextAssistantSeq, unprocessedCount: Math.max(0, stableCount - rememberedCount), reviewCount: 0, failedCount: floors.filter(item => ['error', 'failed'].includes(item.status)).length, floors: Object.freeze(combinedFloors), memoryEntities, memoryWorkBusy: workRun !== null, activeMemoryWork: workRun ? Object.freeze({ kind: workRun.kind, reason: workRun.reason, phase: workRun.phase, floorIds: Object.freeze([...workRun.floorIds]) }) : null, activeExtraction: active ? { floorId: active.floorId, floorIds: Object.freeze([...(active.floorIds ?? [active.floorId])].filter(Boolean)), runId: active.runId, phase: active.phase } : null, qianshiHistoryActive: qianshiHistoryRun !== null, lastExtractorError: lastFailure, lastAutomationError, autoMemoryEnabled: auto.enabled, autoMemoryBatchSize: auto.batchSize, rebuildStatus, rebuildCompletedCount, rebuildTotalCount: stableCount, rebuildNextAssistantSeq, rebuildHasActionableWork, highFloorHistoricalActive: workRun?.aggregateHistorical === true, cseRebuildStatus: cseRebuildPlan?.status ?? 'idle', cseRebuildCompletedCount: cseRebuildPlan?.nextIndex ?? 0, cseRebuildTotalCount: cseRebuildPlan?.targets.length ?? rememberedCount, cseRebuildNextAssistantSeq: cseRebuildPlan?.targets[cseRebuildPlan.nextIndex]?.assistantSeq ?? null, cseRebuildError: cseRebuildPlan?.error ?? null, activeAutoMemory: workRun?.kind === 'auto' ? Object.freeze({ reason: workRun.reason, phase: workRun.phase, mode: workRun.mode ?? 'realtime', aggregateHistorical: workRun.aggregateHistorical === true, cseBlocked: workRun.cseBlocked === true, floorIds: Object.freeze([...workRun.floorIds]) }) : null, lastAutoMemory: lastAutoRun, promptVersion: EXTRACTOR_PROMPT_VERSION, extractorVersion: EXTRACTOR_VERSION });
  }

  async function refreshCoverage(expectedEpoch = epoch) {
    const source = reachable;
    const realtimeOrigin = Boolean(realtimeOriginFromReachable(source) || (source?.root && emptyRealtimeOrigin
      && emptyRealtimeOrigin.chatId === source.root.chatId
      && (emptyRealtimeOrigin.narrativeGeneration === null || emptyRealtimeOrigin.narrativeGeneration === source.root.narrativeGeneration)));
    const next = source
      ? await assessMemoryCoverageFromHost({ reachable: source, snapshot: hostAdapter.snapshot(), sanitizerOptions: sanitizerOptions(), realtimeOrigin })
      : unknownCoverage(0);
    if (expectedEpoch === epoch && reachable === source) {
      coverage = next;
      if (realtimeOrigin && emptyRealtimeOrigin?.narrativeGeneration === null) {
        emptyRealtimeOrigin = Object.freeze({ chatId: source.root.chatId, narrativeGeneration: source.root.narrativeGeneration });
      }
    }
    return next;
  }
  async function load(expectedEpoch = epoch, providedReachable = null, { readOnlyReview = false, skipSavedAnchors = false, skipCoverage = false } = {}) {
    const supplied = providedReachable && !providedReachable.status
      ? { ...providedReachable, status: providedReachable.root ? 'ready' : 'uninitialized' }
      : providedReachable;
    const result = supplied ?? await store.readReachable({ mode: 'projection' });
    if (expectedEpoch !== epoch) return getState();
    let nextReachable = null;
    if (['ready', 'needsReseal'].includes(result.status)) nextReachable = result;
    else if (result.status === 'uninitialized') {
      nextReachable = null;
      const chatId = currentHostChatId();
      const foundation = foundationRuntime.getState();
      if (foundation?.status === 'uninitialized' && foundation.inspectedStableCount === 0 && chatId) {
        emptyRealtimeOrigin = Object.freeze({ chatId, narrativeGeneration: null });
        coverage = emptyCaughtUpCoverage();
      }
    }
    else throw errorWith('V3_MEMORY_LOAD_FAILED', `记忆图读取失败：${result.status}`);
    if (nextReachable?.root?.chatId && reachable?.root?.chatId === nextReachable.root.chatId
      && Number(reachable.rootRevision ?? 0) > Number(nextReachable.rootRevision ?? 0)) {
      nextReachable = reachable;
    }
    const syncKey = nextReachable
      ? `${nextReachable.root.chatId}:${nextReachable.rootRevision}:${nextReachable.root.headCheckpointId}:${readOnlyReview ? 'review' : 'ready'}:${skipSavedAnchors ? 'skipAnchors' : 'anchors'}:${skipCoverage ? 'skipCoverage' : 'coverage'}`
      : null;
    if (backgroundSync && backgroundSyncKey === syncKey) return getState();
    reachable = nextReachable;
    if (nextReachable?.root) readFailureScope(nextReachable);
    if (cseRebuildPlan?.chatId && cseRebuildPlan.chatId !== nextReachable?.root?.chatId) cseRebuildPlan = null;
    if (['paused', 'failed'].includes(cseRebuildPlan?.status)
      && !cseRebuildPlanCurrent(cseRebuildPlan, nextReachable)) cseRebuildPlan = null;
    if (cseRebuildPlan) {
      const durableCount = persistedCseRebuildCompletedCount(nextReachable, cseRebuildPlan);
      if (durableCount !== null && durableCount > cseRebuildPlan.nextIndex) {
        cseRebuildPlan = Object.freeze({ ...cseRebuildPlan, nextIndex: durableCount, status: durableCount >= cseRebuildPlan.targets.length ? 'completed' : cseRebuildPlan.status, error: null });
      }
    }
    if (!cseRebuildPlan && workRun?.mode !== 'cseRebuild') cseRebuildPlan = persistedCseRebuildPlan(nextReachable);
    if (nextReachable?.floorMemories?.some(memory => memory?.recordStatus === 'active')) establishedMemoryChatId = nextReachable.root.chatId;
    memorySnapshotStatus = 'ready';
    memorySyncStatus = nextReachable ? 'syncing' : 'idle';
    memorySyncError = null;
    timeFallbackByFloor = new Map();
    if (nextReachable && typeof hostAdapter?.snapshot === 'function') {
      const snapshot = hostAdapter.snapshot();
      observedHostChatLength = snapshot?.chat?.length ?? observedHostChatLength;
      for (const floor of nextReachable.floors ?? []) {
        const sameFloorClock = clockEvidence(rawSelectionFromSnapshot(snapshot, floor), currentReferenceTags()).displayText;
        timeFallbackByFloor.set(floor.id, sameFloorClock || inferCanonicalCurrentTime(floor.content?.canonicalContent)?.text || '');
      }
    } else {
      try { observedHostChatLength = hostAdapter.snapshot()?.chat?.length ?? observedHostChatLength; } catch { /* keep prior observation */ }
    }
    notify();
    if (!nextReachable) {
      cseRuntime.invalidate();
      backgroundSync = null;
      backgroundSyncKey = null;
      return getState();
    }
    backgroundSyncKey = syncKey;
    const source = nextReachable;
    const settlement = Promise.resolve().then(async () => {
      await cseRuntime.load(source);
      if (expectedEpoch !== epoch || reachable !== source) return;
      if (!readOnlyReview && !skipSavedAnchors) {
        await ensureSavedAnchors(source, expectedEpoch);
        if (expectedEpoch !== epoch || reachable !== source) return;
      }
      if (!skipCoverage) {
        await refreshCoverage(expectedEpoch);
        if (expectedEpoch !== epoch || reachable !== source) return;
      }
      const foundationState = foundationRuntime.getState();
      if (lastFailure?.floorId === null && ['load', 'foundation'].includes(lastFailure.phase)
        && [foundationState?.status, foundationState?.foundationStatus].includes('ready')) lastFailure = null;
      memorySyncStatus = readOnlyReview ? 'needsReview' : lastFailure?.phase === 'anchor' ? 'error' : 'idle';
      memorySyncError = readOnlyReview ? null : lastFailure?.phase === 'anchor' ? lastFailure : null;
      notify();
      if (!readOnlyReview && hasAutomaticCatchupWork() && lastAutoRun?.status === 'caughtUp'
        && lastAutomaticInputKey !== currentInputKey()) void scheduleAutomation('postBoundaryCatchup');
    }).catch(error => {
      if (expectedEpoch !== epoch || reachable !== source) return;
      memorySyncStatus = 'error';
      memorySyncError = Object.freeze({ code: error?.code ?? 'V3_MEMORY_SYNC_FAILED', message: safeErrorMessage(error?.message) });
      if (!lastFailure || ['load', 'foundation'].includes(lastFailure.phase)) {
        lastFailure = Object.freeze({ floorId: null, runId: null, phase: 'load', code: memorySyncError.code, attempts: 0, validationErrors: [], api: null, message: memorySyncError.message });
      }
      notify();
    }).finally(() => {
      if (backgroundSync === settlement) { backgroundSync = null; backgroundSyncKey = null; }
    });
    backgroundSync = settlement;
    return getState();
  }
  async function loadCurrent(expectedEpoch = epoch) {
    const stored = await store.readReachable({ mode: 'projection' });
    const foundationCurrent = foundationRuntime.getReachable?.() ?? null;
    const merged = stored.status === 'ready' && foundationCurrent?.rootRevision === stored.rootRevision && foundationCurrent?.root?.headCheckpointId === stored.root.headCheckpointId
      ? { ...stored, floors: foundationCurrent.floors }
      : stored;
    return load(expectedEpoch, merged);
  }
  async function performRefreshStatus({ preferCached = false, recoverTailDeletion = false, reconcileFoundation = false } = {}, expectedEpoch = epoch, expectedChatId = currentHostChatId()) {
    if (expectedEpoch !== epoch || expectedChatId !== currentHostChatId()) return getState();
    memorySyncStatus = 'syncing';
    memorySyncError = null;
    if (!reachable) memorySnapshotStatus = 'syncing';
    notify();
    let foundation = !recoverTailDeletion && reconcileFoundation && typeof foundationRuntime.refreshStatus === 'function'
      ? await foundationRuntime.refreshStatus('manualRefresh', { verifyRoot: true })
      : typeof foundationRuntime.inspect === 'function'
      ? await foundationRuntime.inspect('memoryRefresh', { allowCached: preferCached })
      : await foundationRuntime.refreshStatus();
    if (recoverTailDeletion && reconcileFoundation && foundation.status === 'error') {
      if (expectedEpoch !== epoch || expectedChatId !== currentHostChatId()) return getState();
      memorySyncStatus = 'error';
      memorySyncError = foundation.lastError ? Object.freeze({ code: 'V3_FOUNDATION_NOT_READY', message: safeErrorMessage(foundation.lastError) }) : null;
      if (!reachable) memorySnapshotStatus = 'error';
      return notify();
    }
    if (!preferCached && foundation.status === 'needsReview' && foundation.reviewReason?.code === 'markerMismatch'
      && foundation.reviewReason?.bindingIssue === 'markerConflict'
      && typeof foundationRuntime.recoverOrphanTailAnchor === 'function') {
      foundation = await foundationRuntime.recoverOrphanTailAnchor();
    }
    let tailRecovered = false;
    if (recoverTailDeletion && foundation.status === 'needsReview' && typeof foundationRuntime.recoverTailDeletion === 'function') {
      const beforeRecovery = foundation;
      foundation = await foundationRuntime.recoverTailDeletion();
      tailRecovered = beforeRecovery.status === 'needsReview' && foundation.status === 'ready';
    }
    if (recoverTailDeletion && reconcileFoundation && typeof foundationRuntime.refreshStatus === 'function') {
      foundation = await foundationRuntime.refreshStatus('manualRefresh', { verifyRoot: true });
    }
    if (expectedEpoch !== epoch || expectedChatId !== currentHostChatId()) return getState();
    if (!enabled() || foundation.status === 'disabled') { reachable = null; memorySnapshotStatus = 'unavailable'; memorySyncStatus = 'idle'; return notify(); }
    const foundationReachable = foundationRuntime.getReachable?.() ?? null;
    const reviewReadable = foundation.status === 'needsReview'
      && foundation.chatId === expectedChatId
      && foundationReachable?.root?.chatId === expectedChatId;
    if (reviewReadable) return load(expectedEpoch, foundationReachable, { readOnlyReview: true });
    if (!['ready', 'uninitialized'].includes(foundation.status)) {
      memorySyncStatus = foundation.status === 'error' ? 'error' : 'needsReview';
      memorySyncError = foundation.lastError ? Object.freeze({ code: 'V3_FOUNDATION_NOT_READY', message: safeErrorMessage(foundation.lastError) }) : null;
      if (!reachable) memorySnapshotStatus = foundation.status === 'error' ? 'error' : 'unavailable';
      return notify();
    }
    const retryRecoveredAnchors = tailRecovered && lastFailure?.phase === 'anchor';
    const reusable = !reachable || !foundationReachable
      || Number(foundationReachable.rootRevision ?? 0) >= Number(reachable.rootRevision ?? 0)
      ? foundationReachable
      : null;
    return load(expectedEpoch, reusable, { skipSavedAnchors: recoverTailDeletion && !retryRecoveredAnchors });
  }
  function refreshStatus(options = {}) {
    const preferCached = options.preferCached === true;
    const expectedEpoch = epoch;
    const expectedChatId = currentHostChatId();
    const sameScope = refreshInFlight?.epoch === expectedEpoch && refreshInFlight?.chatId === expectedChatId;
    if (refreshInFlight && sameScope) {
      if (options.recoverTailDeletion === true || options.reconcileFoundation === true && refreshInFlight.reconcileFoundation !== true || !preferCached && refreshInFlight.preferCached) {
        const predecessor = refreshInFlight.promise;
        const fresh = predecessor.then(() => performRefreshStatus({ ...options, preferCached: false }, expectedEpoch, expectedChatId));
        const entry = { preferCached: false, reconcileFoundation: options.reconcileFoundation === true, epoch: expectedEpoch, chatId: expectedChatId, promise: null };
        entry.promise = fresh.finally(() => { if (refreshInFlight === entry) refreshInFlight = null; });
        refreshInFlight = entry;
        return entry.promise;
      }
      return refreshInFlight.promise;
    }
    const pendingRefresh = Promise.resolve().then(() => performRefreshStatus(options, expectedEpoch, expectedChatId));
    const entry = { preferCached, reconcileFoundation: options.reconcileFoundation === true, epoch: expectedEpoch, chatId: expectedChatId, promise: null };
    entry.promise = pendingRefresh.finally(() => { if (refreshInFlight === entry) refreshInFlight = null; });
    refreshInFlight = entry;
    return entry.promise;
  }
  async function prepareCurrent({ preferCached = true, rootResult = null } = {}) {
    const hostChatId = currentHostChatId();
    const foundation = foundationRuntime.getState();
    const matchesRoot = value => rootResult?.status === 'ready' && value?.status === 'ready' && value.root?.chatId === hostChatId
      && rootResult.data?.chatId === hostChatId && value.rootRevision === rootResult.revision
      && value.root.narrativeGeneration === rootResult.data.narrativeGeneration && value.root.headCheckpointId === rootResult.data.headCheckpointId;
    if (enabled() && hostChatId && memorySnapshotStatus === 'ready' && foundation?.status === 'ready' && foundation.chatId === hostChatId
      && matchesRoot(reachable) && matchesRoot(foundationRuntime.getReachable?.())) return Object.freeze({ status: 'ready', reachable, memorySyncStatus });
    if (preferCached && hostChatId && reachable?.root?.chatId === hostChatId && memorySnapshotStatus === 'ready') {
      return Object.freeze({ status: 'ready', reachable, memorySyncStatus });
    }
    const state = await refreshStatus({ preferCached });
    const currentChatId = currentHostChatId();
    const foundationState = foundationRuntime.getState();
    const foundationReachable = foundationRuntime.getReachable?.() ?? null;
    const freshReady = preferCached || (foundationState?.status === 'ready'
      && foundationReachable?.root?.chatId === currentChatId
      && foundationReachable?.rootRevision === reachable?.rootRevision
      && foundationReachable?.root?.headCheckpointId === reachable?.root?.headCheckpointId);
    if (freshReady && currentChatId && reachable?.root?.chatId === currentChatId && memorySnapshotStatus === 'ready') {
      return Object.freeze({ status: 'ready', reachable, memorySyncStatus });
    }
    const status = state.memorySnapshotStatus === 'ready' ? 'uninitialized' : state.memorySnapshotStatus;
    return Object.freeze({ status, reachable: null, memorySyncStatus });
  }
  async function confirmLatest() { await foundationRuntime.confirmLatest(); return load(); }
  async function confirmConsecutiveAssistants(scope) {
    const requestedEpoch = epoch;
    const requestedChatId = currentHostChatId();
    const foundation = await foundationRuntime.confirmConsecutiveAssistants?.(scope);
    if (requestedEpoch !== epoch || requestedChatId !== currentHostChatId()) return getState();
    if (foundation?.status !== 'ready') {
      await refreshStatus({ preferCached: false });
      const scopeChanged = foundation?.status === 'stale';
      throw errorWith(scopeChanged ? 'V3_MEMORY_STALE' : 'V3_MEMORY_FOUNDATION_NOT_READY', scopeChanged
        ? '连续 AI 确认范围已经变化，请重新查看后再确认。'
        : safeErrorMessage(foundation?.lastError ?? '连续 AI 楼暂时无法确认，请刷新后重试。'));
    }
    await load(requestedEpoch, foundationRuntime.getReachable?.() ?? null);
    const settlement = backgroundSync;
    if (settlement) await settlement;
    if (requestedEpoch !== epoch || requestedChatId !== currentHostChatId()) return getState();
    return startHistoricalRebuild();
  }
  async function persistRecords(records, signal, { concurrency = PREPARED_WRITE_CONCURRENCY } = {}) {
    let cursor = 0;
    let firstError = null;
    async function worker() {
      while (firstError === null) {
        const index = cursor;
        if (index >= records.length) return;
        cursor += 1;
        try {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          const result = await store.putRecord(records[index], { signal });
          if (!['saved', 'reused'].includes(result.status)) throw errorWith('V3_MEMORY_PERSIST_FAILED', `记忆记录写入失败：${result.status}`);
        } catch (error) {
          firstError ??= error;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, records.length) }, () => worker()));
    if (firstError) throw firstError;
  }

  const currentUserIdentity = () => typeof hostAdapter?.getUserIdentity === 'function'
    ? hostAdapter.getUserIdentity()
    : hostAdapter?.snapshot?.().userIdentity ?? null;
  async function extractorDependencySnapshot(value, floorId, { userIdentity, promptGuidance, identityProjectionSnapshot = null,
    referenceTags = currentReferenceTags(), hostSnapshot = null } = {}) {
    const frozenReferenceTags = normalizeStoryClockReferenceTags(referenceTags);
    const targetIndex = value?.floors?.findIndex(floor => floor.id === floorId) ?? -1;
    if (targetIndex < 0 || !value?.root || !value?.checkpoint) return null;
    const prefix = value.floors.slice(0, targetIndex + 1);
    const floorDependencies = [];
    for (const floor of prefix) {
      const selected = hostSnapshot ? rawSelectionFromSnapshot(hostSnapshot, floor) : currentRawSelection(hostAdapter, floor);
      if (!selected) return null;
      floorDependencies.push({
        id: floor.id,
        chatId: floor.chatId,
        narrativeGeneration: floor.narrativeGeneration,
        assistantSeq: floor.assistantSeq,
        predecessorFloorId: floor.predecessorFloorId,
        hostLocator: floor.hostLocator,
        rawFingerprint: floor.content.rawFingerprint,
        canonicalFingerprint: floor.content.canonicalFingerprint,
        liveRawFingerprint: `sha256:${await sha256(selected.rawContent)}`,
        storyClockSignature: clockEvidence(selected, frozenReferenceTags).signature,
      });
    }
    const floorIds = new Set(prefix.map(floor => floor.id));
    const scopedEntities = entitiesThroughFloorIds(value.entities, floorIds)
      .map(({ firstSeenFloorId, lastSeenFloorId, ...entity }) => clone(entity)).sort((left, right) => left.id.localeCompare(right.id));
    return {
      chatId: value.root.chatId,
      targetFloorId: floorId,
      targetFloorGeneration: value.floors[targetIndex].narrativeGeneration,
      floorDependencies,
      targetMemory: clone(currentMemoryMap(value).get(floorId) ?? null),
      scopedEntities,
      userIdentity: clone(userIdentity ?? null),
      promptGuidance: String(promptGuidance ?? ''),
      storyClockReferenceTags: frozenReferenceTags,
      identityProjection: clone(identityProjectionSnapshot ?? await readIdentityProjection()),
    };
  }
  const dependencyMeaning = value => value ? {
    ...value,
    floorDependencies: value.floorDependencies?.map(item => ({ ...item, hostLocator: item.hostLocator ? { ...item.hostLocator, messageIndex: null } : item.hostLocator })),
  } : null;
  const sameExtractorDependency = (left, right) => Boolean(left && right && JSON.stringify(dependencyMeaning(left)) === JSON.stringify(dependencyMeaning(right)));

  async function qianshiDependencySnapshot(value, floorId, identityProjectionSnapshot = null, hostSnapshot = null) {
    const floorIndex = value?.floors?.findIndex(floor => floor.id === floorId) ?? -1;
    if (floorIndex < 0) return null;
    const floor = value.floors[floorIndex], selected = hostSnapshot ? rawSelectionFromSnapshot(hostSnapshot, floor) : currentRawSelection(hostAdapter, floor);
    if (!selected) return null;
    const prefixFloors = value.floors.slice(0, floorIndex);
    const prefixFloorIds = new Set(prefixFloors.map(item => item.id));
    const scopedEntities = entitiesThroughFloorIds(value.entities, new Set(value.floors.slice(0, floorIndex + 1).map(item => item.id)));
    const candidateSource = { ...value, floors: prefixFloors,
      floorMemories: value.floorMemories.filter(memory => prefixFloorIds.has(memory.floorId)), entities: scopedEntities };
    const candidateOptions = {
      canonicalContent: sanitizeMemoryContent(selected.rawContent, sanitizerOptions()),
      precedingUserInput: hostSnapshot
        ? capturePrecedingUserInputFromSnapshot(hostSnapshot, floor, sanitizerOptions())
        : capturePrecedingUserInputSnapshot(hostAdapter, floor, sanitizerOptions()),
      identityProjection: identityProjectionSnapshot ?? await readIdentityProjection(),
    };
    const candidates = qianshiCandidateIndex
      ? qianshiCandidateIndex.prepare(candidateSource, candidateOptions)
      : qianshiCandidatePreparer(candidateSource, candidateOptions);
    return clone({ request: candidates.request, bindings: candidates.bindings });
  }

  async function latestReachableForCommit(operation, preparedReachable = null) {
    let current = null;
    if (preparedReachable?.root && typeof store.readRoot === 'function') {
      const rootResult = await store.readRoot();
      if (samePreparedRoot(preparedReachable, rootResult)) current = preparedReachable;
    }
    current ??= await store.readReachable({ mode: 'runtime' });
    if (current.status !== 'ready') throw errorWith('V3_MEMORY_PREFIX_CHANGED', '当前记忆图尚未收敛，目标楼依赖前缀无法复核。');
    if (operation.epoch !== epoch || operation.controller?.signal?.aborted) throw errorWith('V3_MEMORY_CANCELLED', '操作已取消。');
    return current;
  }

  async function latestCompatibleReachable(operation, preparedReachable = null) {
    const current = await latestReachableForCommit(operation, preparedReachable);
    const dependency = await extractorDependencySnapshot(current, operation.floorId, {
      userIdentity: currentUserIdentity(),
      promptGuidance: operation.dependencySnapshot?.promptGuidance,
      identityProjectionSnapshot: await readIdentityProjection(),
      referenceTags: operation.dependencySnapshot?.storyClockReferenceTags,
    });
    if (!sameExtractorDependency(operation.dependencySnapshot, dependency)) {
      throw errorWith('V3_MEMORY_PREFIX_CHANGED', '目标楼或其依赖前文已经变化，迟到摘要不会写入。');
    }
    return current;
  }

  async function commitRevision(operation, { oldReachable, replacement, newEntities = [], provenanceEntry, action, validationErrors = [] }) {
    return commitGate(() => commitRevisionUnlocked(operation, { oldReachable, replacement, newEntities, provenanceEntry, action, validationErrors }));
  }

  async function commitRevisionUnlocked(operation, { oldReachable, replacement, newEntities, provenanceEntry, action, validationErrors }) {
    let current = await latestCompatibleReachable(operation, oldReachable);
    if (current.rootRevision !== oldReachable.rootRevision
      && current.root.headCheckpointId === oldReachable.root.headCheckpointId
      && current.root.sourceSnapshotFingerprint === oldReachable.root.sourceSnapshotFingerprint) {
      throw errorWith('V3_MEMORY_STALE', '后端入口记录版本已变化，但没有可验证的新后端数据，本次结果不会覆盖。');
    }
    delete operation.qianshiRejected;
    delete operation.qianshiRejectReason;
    delete operation.qianshiHistoryPriorDelta;
    delete operation.qianshiHistoryPartialDelta;
    delete operation.qianshiHistoryPartialMemoryId;
  for (let attempt = 0; attempt < MEMORY_REBASE_ATTEMPTS; attempt += 1) {
    delete operation.qianshiHistoryPriorDelta;
    delete operation.qianshiHistoryPartialDelta;
    delete operation.qianshiHistoryPartialMemoryId;
    let qianshiRejected = false, qianshiRejectReason = null;
    const floor = current.floors.find(item => item.id === replacement.floorId);
    const selected = floor ? currentRawSelection(hostAdapter, floor) : null;
    const liveRawFingerprint = selected ? `sha256:${await sha256(selected.rawContent)}` : null;
    if (!floor || floor.narrativeGeneration !== replacement.narrativeGeneration
      || (operation.floorRawFingerprint && liveRawFingerprint !== operation.floorRawFingerprint)) {
      throw errorWith('V3_MEMORY_PREFIX_CHANGED', '正文分支、稳定锚或时间戳已变化，本次结果已作废。');
    }
    if (operation.qianshiCandidateSnapshot?.length) {
      const liveEvents = new Map(projectQianshiGraph(current).events.map(event => [event.id, event]));
      const stale = operation.qianshiCandidateSnapshot.some(binding => binding.events.some(expected => {
        const event = liveEvents.get(expected.id);
        return !event || !expected.signature || qianshiEventSemanticSignature(event) !== expected.signature
          || (binding.kind === 'matter' && (event.matterId !== binding.matterId || !event.updatesMatter));
      }));
      if (stale) throw errorWith('QIANSHI_HISTORY_CANDIDATE_STALE', '提交期间实际引用的前楼事项语义已变化，本楼结果没有保存。');
    }
    if (operation.qianshiHistoryReconcileSnapshot) {
      const memory = currentMemoryMap(current).get(operation.floorId);
      if (!memory || memory.id !== operation.qianshiHistoryReconcileSnapshot.memoryId
        || JSON.stringify(memory.qianshiDelta?.historyReview) !== operation.qianshiHistoryReconcileSnapshot.review
        || JSON.stringify(memory.qianshiDelta?.events) !== operation.qianshiHistoryReconcileSnapshot.events
        || JSON.stringify(memory.qianshiDelta?.relations) !== operation.qianshiHistoryReconcileSnapshot.relations) {
        throw errorWith('QIANSHI_HISTORY_RECONCILE_STALE', '候选决定或千事关系在核对期间发生变化，本次状态没有保存。');
      }
    }
    let revisionReplacement = replacement;
    if (operation.qianshiDependency && replacement.qianshiDelta) {
      const currentQianshiDependency = await qianshiDependencySnapshot(current, replacement.floorId);
      if (JSON.stringify(currentQianshiDependency) !== JSON.stringify(operation.qianshiDependency)) {
        const qianshiDelta = pendingQianshiDelta(replacement.qianshiDelta, '摘要请求期间旧事项候选发生变化，千事结果待补。', operation.commitTimestamp ?? nowIso(now));
        const id = await deterministicUuid(['v3-memory-qianshi-pending', replacement.id, qianshiDelta.reason, current.root.headCheckpointId]);
        revisionReplacement = validateFloorMemory({ ...replacement, id, qianshiDelta }, { expectedChatId: replacement.chatId });
      }
    }
    const memoryByFloor = currentMemoryMap(current);
    const oldTarget = memoryByFloor.get(revisionReplacement.floorId);
    if (revisionReplacement.qianshiDelta) {
      const reviewDecisionPreservesGraph = ['qianshiHistoryReview', 'qianshiHistoryReconcile'].includes(action) && oldTarget?.qianshiDelta
        && JSON.stringify(revisionReplacement.qianshiDelta.events) === JSON.stringify(oldTarget.qianshiDelta.events)
        && JSON.stringify(revisionReplacement.qianshiDelta.relations) === JSON.stringify(oldTarget.qianshiDelta.relations);
      const replacedFloorIds = new Set(oldTarget ? memorySourceFloorIds(oldTarget) : [revisionReplacement.floorId]);
      const oldEventIds = new Set(oldTarget?.qianshiDelta?.events?.map(event => event.id) ?? []);
      const preservedByOtherFloors = new Set(), currentProjection = reviewDecisionPreservesGraph ? null : projectQianshiGraph(current);
      const validRelationSignatures = new Set(currentProjection?.relations.map(relation => JSON.stringify([relation.id, relation.type, relation.fromEventId, relation.toEventId])) ?? []);
      for (const memory of current.floorMemories ?? []) if (memory.recordStatus === 'active' && !replacedFloorIds.has(memory.floorId)) {
        for (const relation of memory.qianshiDelta?.relations ?? []) if (validRelationSignatures.has(JSON.stringify([relation.id, relation.type, relation.fromEventId, relation.toEventId]))) {
          if (oldEventIds.has(relation.fromEventId)) preservedByOtherFloors.add(relation.fromEventId);
          if (oldEventIds.has(relation.toEventId)) preservedByOtherFloors.add(relation.toEventId);
        }
      }
      for (const event of currentProjection?.events ?? []) if (!replacedFloorIds.has(event.sourceFloorId)) {
        for (const sourceId of event.continuesFromEventIds) if (oldEventIds.has(sourceId)) preservedByOtherFloors.add(sourceId);
      }
      const replacementEventIds = new Set(revisionReplacement.qianshiDelta.events.map(event => event.id));
      const missingReferencedIds = oldTarget?.qianshiDelta
        ? reviewDecisionPreservesGraph ? [] : [...preservedByOtherFloors].filter(id => !replacementEventIds.has(id)) : [];
      const availableEvents = new Map((currentProjection?.events ?? []).filter(event => !replacedFloorIds.has(event.sourceFloorId)).map(event => [event.id, event]));
      for (const event of revisionReplacement.qianshiDelta.events) availableEvents.set(event.id, event);
      const hasDanglingReplacementReference = !reviewDecisionPreservesGraph && (revisionReplacement.qianshiDelta.events.some(event => event.continuesFromEventIds.some(id => !availableEvents.has(id)))
        || revisionReplacement.qianshiDelta.relations.some(relation => {
          const fromEvent = availableEvents.get(relation.fromEventId), toEvent = availableEvents.get(relation.toEventId);
          return !fromEvent || !toEvent || (relation.type === 'progress'
            && (!fromEvent.matterId || fromEvent.matterId !== toEvent.matterId || !toEvent.updatesMatter));
        }));
      const externalValidProgressIds = new Set();
      for (const memory of current.floorMemories ?? []) if (!reviewDecisionPreservesGraph && memory.recordStatus === 'active' && !replacedFloorIds.has(memory.floorId)) {
        for (const relation of memory.qianshiDelta?.relations ?? []) if (relation.type === 'progress'
          && (oldEventIds.has(relation.fromEventId) || oldEventIds.has(relation.toEventId))
          && validRelationSignatures.has(JSON.stringify([relation.id, relation.type, relation.fromEventId, relation.toEventId]))) {
          externalValidProgressIds.add(relation.id);
        }
      }
      let invalidatedExternalProgress = false;
      if (!reviewDecisionPreservesGraph && externalValidProgressIds.size) {
        try {
          const candidateMemories = new Map(memoryByFloor);
          candidateMemories.set(revisionReplacement.floorId, revisionReplacement);
          const candidateProjection = projectQianshiGraph({ ...current, floorMemories: current.floors.map(item => candidateMemories.get(item.id)).filter(Boolean) });
          const remainingRelationIds = new Set(candidateProjection.relations.map(relation => relation.id));
          invalidatedExternalProgress = [...externalValidProgressIds].some(id => !remainingRelationIds.has(id));
        } catch { invalidatedExternalProgress = true; }
      }
      if ((missingReferencedIds.length || hasDanglingReplacementReference || invalidatedExternalProgress) && !reviewDecisionPreservesGraph) {
        qianshiRejected = true;
        qianshiRejectReason = missingReferencedIds.length
          ? '新千事结果漏掉了仍被后楼引用的事件，原千事记录已保留。'
          : invalidatedExternalProgress ? '替换后的千事会使其他楼原本有效的进展关系失效，原千事记录已保留。'
          : oldTarget?.qianshiDelta ? '新千事结果仍含有无法验证的关系引用，原千事记录已保留。'
            : '新千事结果含有无法验证的关系引用，千事未保存，可重新准备计划。';
        if (action === 'qianshiHistory' && oldTarget?.qianshiDelta) operation.qianshiHistoryPriorDelta = oldTarget.qianshiDelta;
        const id = await deterministicUuid(['v3-memory-qianshi-rejected', revisionReplacement.id, oldTarget?.id ?? null, current.root.headCheckpointId]);
        if (oldTarget?.qianshiDelta?.events?.length && action === 'qianshiHistory') {
          const partialDelta = validateQianshiDelta({ ...oldTarget.qianshiDelta, status: 'partial',
            reason: String(qianshiRejectReason).slice(0, 500), compiledAt: operation.commitTimestamp ?? nowIso(now) }, { floorId: floor.id });
          const partialId = await deterministicUuid(['v3-memory-qianshi-history-conflict-partial', revisionReplacement.id,
            oldTarget.id, partialDelta, current.root.headCheckpointId]);
          revisionReplacement = validateFloorMemory({ ...revisionReplacement, id: partialId, qianshiDelta: partialDelta,
            updatedAt: operation.commitTimestamp ?? nowIso(now), supersedes: oldTarget.id }, { expectedChatId: revisionReplacement.chatId });
          operation.qianshiHistoryPartialDelta = partialDelta;
          operation.qianshiHistoryPartialMemoryId = partialId;
        } else if (oldTarget?.qianshiDelta) revisionReplacement = validateFloorMemory({ ...revisionReplacement, id, qianshiDelta: oldTarget.qianshiDelta }, { expectedChatId: revisionReplacement.chatId });
        else {
          const { qianshiDelta: _discarded, ...summaryReplacement } = revisionReplacement;
          revisionReplacement = validateFloorMemory({ ...summaryReplacement, id }, { expectedChatId: revisionReplacement.chatId });
        }
      }
    }
    memoryByFloor.set(revisionReplacement.floorId, revisionReplacement);
    const floorMemories = current.floors.map(item => memoryByFloor.get(item.id)).filter(Boolean);
    const entitiesById = new Map(current.entities.map(entity => [entity.id, entity]));
    for (const entity of newEntities) {
      const existing = entitiesById.get(entity.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(entity)) throw errorWith('V3_MEMORY_PREFIX_CHANGED', '人物身份目录已被并发修改，本次结果不会覆盖新记录。');
      entitiesById.set(entity.id, entity);
    }
    const provisionalDeltas = filterReachableDeltas({ floors: current.floors, floorMemories, stateDeltas: current.stateDeltas ?? [] });
    const stateEntityIds = new Set(provisionalDeltas.flatMap(delta => [
      ...delta.subjectSnapshots.flatMap(subject => [subject.subjectEntityId, ...['adaptive', 'situational'].flatMap(category => subject[category].map(item => item.towardEntityId).filter(Boolean))]),
      ...(delta.fixedChanges ?? []).flatMap(subject => [subject.subjectEntityId, ...subject.items.flatMap(change => [change.before?.towardEntityId, change.after?.towardEntityId].filter(Boolean))]),
    ]));
    const baselineEntityIds = new Set(current.baseline ? [current.baseline.userPersona.entityId, current.baseline.characterCard.entityId] : []);
    const entities = [...entitiesById.values()].filter(entity => current.floors.some(item => item.id === entity.firstSeenFloorId) || floorMemories.some(memory => JSON.stringify(memory).includes(entity.id)) || stateEntityIds.has(entity.id) || baselineEntityIds.has(entity.id));
    const nowValue = operation.commitTimestamp ??= nowIso(now);
    const runId = await deterministicUuid(['v3-memory-commit-run', operation.runId, current.root.headCheckpointId, attempt]);
    const checkpointId = await deterministicUuid(['v3-memory-checkpoint', current.root.headCheckpointId, current.root.narrativeGeneration, action, revisionReplacement.id, entities.map(entity => entity.id), runId]);
    const indexes = await buildFoundationIndexes({ chatId: current.root.chatId, narrativeGeneration: current.root.narrativeGeneration, checkpointId, floors: current.floors, candidates: current.floors.map(floorItem => ({ hostLocator: floorItem.hostLocator, rawFingerprint: floorItem.content.rawFingerprint, canonicalFingerprint: floorItem.content.canonicalFingerprint })), entities, now: nowValue });
    const indexKeys = indexes.map(index => store.recordKey(index));
    const provenance = floorProvenance(current);
    provenance[revisionReplacement.floorId] = { ...provenanceEntry, runId, memoryId: revisionReplacement.id, action };
    let currentState = null;
    if (current.baseline) currentState = await replayCurrentState({ chatId: current.root.chatId, narrativeGeneration: current.root.narrativeGeneration, baselineId: current.baseline.id, floors: current.floors, floorMemories, stateDeltas: provisionalDeltas, now: nowValue, id: await deterministicUuid(['v3-cse-current-state', checkpointId]), previousId: current.currentStates?.at(-1)?.id ?? null });
    const preparedStateRefs = [...provisionalDeltas.map(delta => store.recordKey(delta)), ...(currentState ? [store.recordKey(currentState)] : [])];
    const runFloorIds = operation.floorIds?.length ? operation.floorIds : [revisionReplacement.floorId];
    const run = validateFoundationRun({ schemaVersion: 3, recordType: 'run', id: runId, chatId: current.root.chatId, narrativeGeneration: current.root.narrativeGeneration, parentCheckpointId: current.root.headCheckpointId, inputSnapshotFingerprint: current.root.sourceSnapshotFingerprint, mode: 'localReextract', sessionEpoch: operation.epoch, inputFloorIds: runFloorIds, phase: 'completed', completedFloorIds: runFloorIds, failedItems: [], preparedRecordRefs: [store.recordKey(revisionReplacement), ...newEntities.map(entity => store.recordKey(entity)), ...preparedStateRefs, ...indexKeys, `v3-checkpoint-${checkpointId}`], diagnostics: { ...diagnosticsWithRealtimeOrigin(null, realtimeOriginFromReachable(current)), kind: 'extractor', promptVersion: EXTRACTOR_PROMPT_VERSION, extractorVersion: EXTRACTOR_VERSION, floorProvenance: provenance, validationErrors: validationErrors.slice(-20) }, startedAt: operation.startedAt, createdAt: nowValue, updatedAt: nowValue, recordStatus: 'active', supersedes: null }, { expectedChatId: current.root.chatId });
    const memoryReady = floorMemories.some(memory => memory.recordStatus === 'active');
    const stateFingerprint = await hash([current.root.narrativeGeneration, current.floors.map(item => item.id), current.floors.map(item => item.content.canonicalFingerprint)]);
    const cseReady = memoryReady && floorMemories.filter(memory => memory.recordStatus === 'active').every(memory => provisionalDeltas.some(delta => delta.floorId === memory.floorId));
    const capabilities = { foundationReady: true, memoryReady, cseReady, recallReady: false };
    const checkpoint = validateFoundationCheckpoint({ schemaVersion: 3, recordType: 'checkpoint', id: checkpointId, chatId: current.root.chatId, narrativeGeneration: current.root.narrativeGeneration, parentCheckpointId: current.root.headCheckpointId, runId, sourceSnapshotFingerprint: current.root.sourceSnapshotFingerprint, indexLayout: V3_INDEX_LAYOUT_FLOOR_ORDER, capabilities, floorRange: { fromAssistantSeq: current.floors.length ? 1 : 0, toAssistantSeq: current.floors.length, floorIds: current.floors.map(item => item.id) }, inputFingerprints: createCheckpointInputFingerprints(current.floors, { previous: current.checkpoint?.inputFingerprints }), producedRefs: { floors: current.floors.map(item => item.id), floorMemories: floorMemories.map(item => item.id), entities: entities.map(item => item.id), events: [], claims: [], knowledge: [], stateDeltas: provisionalDeltas.map(item => item.id), currentStates: currentState ? [currentState.id] : [], stateProjections: [], episodes: [], threads: [], indexes: indexKeys }, validation: { schemaValid: true, referencesValid: true, orderedReplayValid: true, stateFingerprint }, sealedAt: nowValue, createdAt: nowValue, updatedAt: nowValue, recordStatus: 'active', supersedes: null }, { expectedChatId: current.root.chatId });
    const root = validateFoundationRoot({ ...current.root, capabilities, headCheckpointId: checkpointId, activeStateRefs: currentState ? [currentState.id] : [], indexManifest: { ...emptyManifest(), floor: indexKeys.filter(key => key.includes('-floorOrder-') || key.includes('-fingerprint-')), entity: indexKeys.filter(key => key.includes('-entity-')), reverseRef: indexKeys.filter(key => key.includes('-reverseRef-')) }, updatedAt: nowValue }, { expectedChatId: current.root.chatId });
    await validateCseGraph({ root, checkpoint, run, floors: current.floors, floorMemories, entities, indexes, indexKeys, baseline: current.baseline, stateDeltas: provisionalDeltas, currentStates: currentState ? [currentState] : [] });
    await persistRecords([...newEntities, revisionReplacement, ...(currentState ? [currentState] : []), ...indexes], operation.controller.signal);
    await persistRecords([run, checkpoint], operation.controller.signal, { concurrency: 1 });
    if (operation.epoch !== epoch || operation.controller.signal.aborted) throw errorWith('V3_MEMORY_CANCELLED', '操作已取消。');
    let committed;
    try { committed = await store.commitRoot(root, current.rootRevision, { signal: operation.controller.signal }); }
    catch (error) {
      if (!['qianshiHistory', 'qianshiHistoryReconcile'].includes(action)) throw error;
      try {
        const cold = await store.readReachable({ mode: 'runtime' });
        const saved = currentMemoryMap(cold).get(operation.floorId);
        const confirmed = cold.status === 'ready' && cold.rootRevision > current.rootRevision
          && cold.root?.chatId === current.root.chatId
          && cold.root?.sourceSnapshotFingerprint === current.root.sourceSnapshotFingerprint
          && cold.root.headCheckpointId === checkpointId && saved?.id === revisionReplacement.id
          && JSON.stringify(saved.qianshiDelta) === JSON.stringify(revisionReplacement.qianshiDelta);
        if (!confirmed) throw error;
        committed = { status: 'saved', revision: cold.rootRevision, reachable: cold };
      } catch {
        throw errorWith('QIANSHI_HISTORY_COMMIT_AMBIGUOUS', '千事结果的保存状态待核对；请刷新千事页确认，系统不会自动重试。');
      }
    }
    if (committed.status === 'conflict' && attempt + 1 < MEMORY_REBASE_ATTEMPTS) {
      current = await latestCompatibleReachable(operation);
      continue;
    }
    if (committed.status !== 'saved') throw errorWith(committed.status === 'conflict' ? 'V3_MEMORY_CAS_CONFLICT' : 'V3_MEMORY_COMMIT_FAILED', committed.status === 'conflict' ? '记忆提交连续遇到并发更新，未覆盖新数据。' : `记忆提交失败：${committed.status}`);
    operation.qianshiRejected = qianshiRejected;
    operation.qianshiRejectReason = qianshiRejectReason;
    reachable = committed.reachable;
    if (!reachable || reachable.status !== 'ready'
      || reachable.rootRevision !== committed.revision
      || reachable.root?.chatId !== current.root.chatId
      || reachable.root?.headCheckpointId !== checkpointId
      || reachable.root?.narrativeGeneration !== current.root.narrativeGeneration
      || reachable.root?.sourceSnapshotFingerprint !== current.root.sourceSnapshotFingerprint) {
      throw errorWith('V3_MEMORY_COLD_READ_FAILED', '记忆已提交，但提交结果缺少一致的冷读取校验。');
    }
    foundationRuntime.adoptReachable?.(reachable);
    clearFloorFailure(revisionReplacement.floorId, reachable);
    lastFailure = null;
    sessionCandidates.delete(revisionReplacement.floorId);
    pendingResults.delete(revisionReplacement.floorId);
    await cseRuntime.load(reachable);
    await ensureSavedAnchors(reachable, operation.epoch);
    await refreshCoverage(operation.epoch);
    if (operation.qianshiRejected) try {
      notifyUser?.({ kind: 'warning', text: `摘要已保存，但${operation.qianshiRejectReason}` });
    } catch { /* advisory only */ }
    return notify();
    }
    throw errorWith('V3_MEMORY_CAS_CONFLICT', '记忆提交连续遇到并发更新，未覆盖新数据。');
  }

  async function persistFailure(operation, error, oldReachable) {
    const details = error?.extractorDiagnostics ?? {};
    if (details.sessionCandidate) rememberSessionCandidate(operation.floorId, details.sessionCandidate);
    lastFailure = Object.freeze({ floorId: operation.floorId, runId: operation.runId, phase: 'retryableError', code: String(error?.code ?? 'V3_EXTRACTOR_FAILED').slice(0, 120), httpStatus: Number.isSafeInteger(details.httpStatus ?? error?.httpStatus ?? error?.status) ? (details.httpStatus ?? error.httpStatus ?? error.status) : null, providerError: sanitizeDiagnosticValue(details.providerError ?? error?.providerError ?? null), formatStage: details.formatStage ?? error?.formatStage ?? null, attempts: details.attempts ?? 1, transportAttempts: details.transportAttempts ?? null, validationErrors: sanitizeDiagnosticValue(details.validationErrors ?? []), api: safeApi(details.metadata ?? error?.taskMetadata), message: safeErrorMessage(error?.message) });
    rememberFloorFailure(oldReachable, lastFailure);
    try {
      const nowValue = nowIso(now);
      const run = validateFoundationRun({ schemaVersion: 3, recordType: 'run', id: operation.runId, chatId: oldReachable.root.chatId, narrativeGeneration: oldReachable.root.narrativeGeneration, parentCheckpointId: oldReachable.root.headCheckpointId, inputSnapshotFingerprint: oldReachable.root.sourceSnapshotFingerprint, mode: 'localReextract', sessionEpoch: operation.epoch, inputFloorIds: [operation.floorId], phase: 'retryableError', completedFloorIds: [], failedItems: [{ floorId: operation.floorId, stage: 'extractor', code: lastFailure.code, retryCount: Math.max(0, lastFailure.attempts - 1) }], preparedRecordRefs: [], diagnostics: { kind: 'extractor', promptVersion: EXTRACTOR_PROMPT_VERSION, extractorVersion: EXTRACTOR_VERSION, floorId: operation.floorId, responseFingerprint: details.responseFingerprint ?? null, api: lastFailure.api, attempts: lastFailure.attempts, transportAttempts: lastFailure.transportAttempts, httpStatus: lastFailure.httpStatus, providerError: lastFailure.providerError, formatStage: lastFailure.formatStage, validationErrors: lastFailure.validationErrors, preflightTiming: operation.preflightTiming ?? null }, startedAt: operation.startedAt, createdAt: nowValue, updatedAt: nowValue, recordStatus: 'staged', supersedes: null }, { expectedChatId: oldReachable.root.chatId });
      await store.putRecord(run, { signal: operation.controller.signal });
    } catch { /* failure audit is best effort; it must never move root */ }
    notify();
  }

  const extractionIntentCurrent = intent => intent.epoch === epoch && intent.chatId && currentHostChatId() === intent.chatId;
  const samePreparedRoot = (source, rootResult) => rootResult?.status === 'ready'
    && rootResult.revision === source?.rootRevision
    && rootResult.data?.chatId === source?.root?.chatId
    && rootResult.data?.headCheckpointId === source?.root?.headCheckpointId
    && rootResult.data?.narrativeGeneration === source?.root?.narrativeGeneration
    && rootResult.data?.sourceSnapshotFingerprint === source?.root?.sourceSnapshotFingerprint;

  const sameReachableVersion = (left, right) => Boolean(left?.root && right?.root
    && left.rootRevision === right.rootRevision
    && left.root.chatId === right.root.chatId
    && left.root.headCheckpointId === right.root.headCheckpointId
    && left.root.narrativeGeneration === right.root.narrativeGeneration
    && left.root.sourceSnapshotFingerprint === right.root.sourceSnapshotFingerprint);

  async function canReuseSynchronizedReachable(expectedEpoch, value) {
    const settlement = backgroundSync;
    if (settlement) await settlement;
    return expectedEpoch === epoch
      && sameReachableVersion(reachable, value)
      && memorySnapshotStatus === 'ready'
      && memorySyncStatus === 'idle'
      && coverage.status !== 'unknown'
      && lastFailure?.phase !== 'anchor';
  }

  async function prepareExtractorInput({ floorId = null, floorIds = null, selectNext = false, intent, manualWork }) {
    let rootChecks = 0;
    let prepareStep = 'synchronizing';
    try { for (let attempt = 0; attempt < 2; attempt += 1) {
      prepareStep = 'synchronizing';
      if (!extractionIntentCurrent(intent)) throw errorWith('V3_MEMORY_STALE', '聊天在提取准备期间已经变化，本次请求未发送。');
      const foundation = await foundationRuntime.refreshStatus();
      if (!extractionIntentCurrent(intent)) throw errorWith('V3_MEMORY_STALE', '聊天在后端数据同步期间已经变化，本次请求未发送。');
      if (foundation.status !== 'ready') throw errorWith('V3_MEMORY_FOUNDATION_NOT_READY', '后端数据尚未与当前正文完成同步，当前不能提取。');
      const preparedReachable = foundationRuntime.getReachable?.() ?? null;
      if (!await canReuseSynchronizedReachable(intent.epoch, preparedReachable)) await load(intent.epoch, preparedReachable?.root ? preparedReachable : null);
      const settlement = backgroundSync;
      if (settlement) await settlement;
      if (!extractionIntentCurrent(intent)) throw errorWith('V3_MEMORY_STALE', '聊天在记忆读取期间已经变化，本次请求未发送。');
      prepareStep = 'snapshotClone';
      const source = reachable ? clone(reachable) : null;
      const hostSnapshot = hostAdapter.snapshot();
      prepareStep = 'sourceSelection';
      const memoryMap = currentMemoryMap(source);
      const requestedFloors = Array.isArray(floorIds) && floorIds.length
        ? floorIds.map(id => source?.floors?.find(item => item.id === id))
        : null;
      if (requestedFloors?.some(item => !item) || requestedFloors?.length > 10) throw errorWith('V3_MEMORY_FLOOR_UNAVAILABLE', '高楼压缩只接受当前连续范围内最多 10 个稳定 AI 楼。');
      if (requestedFloors?.some((item, index) => index > 0 && source.floors.indexOf(item) !== source.floors.indexOf(requestedFloors[index - 1]) + 1)) throw errorWith('V3_MEMORY_FLOOR_UNAVAILABLE', '高楼压缩范围必须是连续的稳定 AI 楼。');
      const floor = requestedFloors?.at(-1) ?? (selectNext
        ? source?.floors?.find(item => memoryMap.get(item.id)?.recordStatus !== 'active')
        : source?.floors?.find(item => item.id === floorId));
      if (!floor) return selectNext ? null : (() => { throw errorWith('V3_MEMORY_FLOOR_UNAVAILABLE', '只允许提取当前后端快照中可用的稳定 AI 楼。'); })();
      const aggregateFloors = requestedFloors ?? [floor];
      const selectedSources = aggregateFloors.map(item => ({ floor: item, selected: rawSelectionFromSnapshot(hostSnapshot, item) }));
      if (selectedSources.some(item => !item.selected)) throw errorWith('V3_MEMORY_STALE', '当前压缩范围或所选候选回复已变化，请刷新后重试。');
      const selected = selectedSources.at(-1).selected;
      const sourceRawFingerprint = `sha256:${await sha256(selected.rawContent)}`;
      prepareStep = 'timeSources';
      const referenceTagsSnapshot = currentReferenceTags();
      prepareStep = 'sourceSanitization';
      const sourceFloors = selectedSources.map(({ floor: sourceFloor, selected: sourceSelected }) => {
        const canonicalContent = sanitizeMemoryContent(sourceSelected.rawContent, sanitizerOptions());
        const sourceUserInputSnapshot = capturePrecedingUserInputFromSnapshot(hostSnapshot, sourceFloor, sanitizerOptions());
        prepareStep = 'timeSources';
        const storyClockEvidence = clockEvidence(sourceSelected, referenceTagsSnapshot);
        prepareStep = 'sourceSanitization';
        return { floor: { ...sourceFloor, content: { ...sourceFloor.content, canonicalContent } }, selected: sourceSelected, canonicalContent,
          rawFingerprint: sourceFloor.content.rawFingerprint, sourceUserInputSnapshot, storyClockEvidence };
      });
      for (const entry of sourceFloors) entry.rawFingerprint = `sha256:${await sha256(entry.selected.rawContent)}`;
      prepareStep = 'timeSources';
      const aggregate = requestedFloors !== null;
      const canonicalContent = aggregate
        ? sourceFloors.map((entry, index) => `[floor-${index + 1} | AI #${entry.floor.assistantSeq} | message ${entry.floor.hostLocator.messageIndex}]\n${entry.canonicalContent}`).join('\n\n')
        : sourceFloors[0].canonicalContent;
      const liveFloor = { ...floor, content: { ...floor.content, canonicalContent, rawFingerprint: sourceRawFingerprint,
        canonicalFingerprint: `sha256:${await sha256(canonicalContent)}` } };
      const sourceClock = sourceFloors.at(-1).storyClockEvidence;
      const sourceUserInputSnapshot = sourceFloors.at(-1).sourceUserInputSnapshot;
      const sourceVariableReference = captureFloorVariableReference(hostSnapshot, floor);
      const userIdentity = currentUserIdentity();
      const runId = await deterministicUuid(['v3-extractor-run', source.root.headCheckpointId, floor.id, newUuid()]);
      const expectedScope = { batchId: runId, chatId: floor.chatId, narrativeGeneration: floor.narrativeGeneration, checkpointId: source.root.headCheckpointId, floorId: floor.id, rawContentFingerprint: sourceRawFingerprint };
      const floorIndex = source.floors.findIndex(item => item.id === floor.id);
      prepareStep = 'identityDirectory';
      const scopedEntities = entitiesThroughFloorIds(source.entities, new Set(source.floors.slice(0, floorIndex + 1).map(item => item.id)));
      const identityProjectionSnapshot = await readIdentityProjection();
      let previousStoryClock = null;
      prepareStep = 'timeSources';
      for (let index = floorIndex - 1; index >= 0 && !previousStoryClock; index -= 1) previousStoryClock = clockEvidence(rawSelectionFromSnapshot(hostSnapshot, source.floors[index]), referenceTagsSnapshot).clock;
      prepareStep = 'sourceSelection';
      const previousMemoryContext = previousFloorContext(source, floorIndex, memoryMap);
      const firstFloorIndex = source.floors.findIndex(item => item.id === aggregateFloors[0].id);
      const qianshiPrefixFloorIds = new Set(source.floors.slice(0, firstFloorIndex).map(item => item.id));
      prepareStep = 'qianshiCandidates';
      const candidateSource = { ...source, floors: source.floors.slice(0, firstFloorIndex),
        floorMemories: source.floorMemories.filter(memory => qianshiPrefixFloorIds.has(memory.floorId)), entities: scopedEntities };
      const candidateOptions = { canonicalContent, precedingUserInput: sourceUserInputSnapshot, identityProjection: identityProjectionSnapshot };
      const qianshiCandidates = !aggregate && qianshiCandidateIndex
        ? qianshiCandidateIndex.prepare(candidateSource, candidateOptions)
        : qianshiCandidatePreparer(candidateSource, candidateOptions);
      prepareStep = 'extractorEnvelope';
      const envelope = await createExtractorEnvelope({ ...expectedScope, floor: liveFloor,
        sourceFloors: aggregate ? sourceFloors.map(entry => ({ floor: { ...entry.floor, content: { ...entry.floor.content, rawFingerprint: entry.rawFingerprint } }, sourceUserInputSnapshot: entry.sourceUserInputSnapshot, storyClock: entry.storyClockEvidence.clock, storyClockSignature: entry.storyClockEvidence.signature })) : null,
        entities: scopedEntities, identityProjection: identityProjectionSnapshot, userIdentity, identityHints: [], storyClock: sourceClock.clock, previousStoryClock, previousFloorContext: previousMemoryContext, sourceUserInputSnapshot, sourceVariableReference, qianshiCandidates });
      const semanticInputFingerprint = await hash(envelope.request.payload);
      const promptGuidanceSnapshot = typeof extractorPromptGuidance === 'function' ? extractorPromptGuidance() : extractorPromptGuidance;
      const processingPromptSnapshot = typeof processingPrompt === 'function' ? processingPrompt() : processingPrompt;
      const verifiedUserIdentity = currentUserIdentity();
      prepareStep = 'dependencySnapshot';
      const dependencySnapshot = await extractorDependencySnapshot(source, floor.id, { userIdentity: verifiedUserIdentity,
        promptGuidance: promptGuidanceSnapshot, identityProjectionSnapshot, referenceTags: referenceTagsSnapshot, hostSnapshot });
      if (typeof store.readRoot === 'function') {
        prepareStep = 'rootCheck';
        const rootResult = await store.readRoot();
        rootChecks += 1;
        if (!extractionIntentCurrent(intent)) throw errorWith('V3_MEMORY_STALE', '聊天在版本核对期间已经变化，本次请求未发送。');
        if (!samePreparedRoot(source, rootResult)) {
          if (attempt + 1 >= 2) throw errorWith('V3_MEMORY_STALE', '后端入口记录在提取准备期间连续变化，本次请求未发送。');
          const latest = await store.readReachable({ mode: 'runtime' });
          if (latest.status !== 'ready') throw errorWith('V3_MEMORY_FOUNDATION_NOT_READY', '最新记忆图尚未收敛，本次请求未发送。');
          foundationRuntime.adoptReachable?.(latest);
          continue;
        }
      }
      const liveSelectionsCurrent = sourceFloors.every(entry => currentRawSelection(hostAdapter, entry.floor)?.rawContent === entry.selected.rawContent);
      if (!extractionIntentCurrent(intent) || JSON.stringify(userIdentity ?? null) !== JSON.stringify(verifiedUserIdentity ?? null)
        || !liveSelectionsCurrent || !dependencySnapshot) {
        throw errorWith('V3_MEMORY_PREFIX_CHANGED', '目标楼正文、身份或提示依赖在请求前已经变化，本次请求未发送。');
      }
      return {
        intent: Object.freeze({ ...intent }),
        source, floor: liveFloor, oldMemory: memoryMap.get(floor.id) ?? null, sourceRawFingerprint, sourceClock,
        userIdentity, promptGuidanceSnapshot, processingPromptSnapshot, dependencySnapshot, runId, expectedScope, scopedEntities,
        envelope, semanticInputFingerprint, selectedRawContent: selected.rawContent, sourceSelections: Object.freeze(sourceFloors.map(entry => Object.freeze({ floorId: entry.floor.id, rawContent: entry.selected.rawContent }))),
        sourceFloorIds: Object.freeze(aggregateFloors.map(item => item.id)), aggregate,
        qianshiDependency: aggregate ? null : clone({ request: qianshiCandidates.request, bindings: qianshiCandidates.bindings }),
        preflightTiming: Object.freeze({ prepareMs: elapsedMs(manualWork.startedMonotonic), rootChecks, reprepareCount: attempt }),
      };
    }
    throw errorWith('V3_MEMORY_STALE', '提取准备未能收敛，本次请求未发送。');
    }
    catch (error) { throw markPreparationFailure(error, prepareStep); }
  }

  async function extractFloorInternal(floorId, { analyzeState = true, preparedInput = null, manualWork, aggregate = false, floorIds = null } = {}) {
    if (!enabled()) return notify();
    if (active) return getState();
    let handedToExtractor = false;
    try {
    const timingWork = manualWork ?? { startedAt: nowIso(now), startedMonotonic: monotonicNow() };
    const intent = preparedInput?.intent ?? { epoch, chatId: currentHostChatId() };
    const prepared = preparedInput ?? await prepareExtractorInput({ floorId, floorIds, intent, manualWork: timingWork });
    if (!prepared) return getState();
    const { source, floor, oldMemory, sourceRawFingerprint, sourceClock, userIdentity, promptGuidanceSnapshot, processingPromptSnapshot, dependencySnapshot, expectedScope, scopedEntities, envelope, semanticInputFingerprint, qianshiDependency } = prepared;
    aggregate ||= prepared.aggregate === true;
    let pending = pendingResults.get(floor.id) ?? null;
    if (pending && (!sameExtractorDependency(pending.dependencySnapshot, dependencySnapshot)
      || pending.chatId !== source.root.chatId || pending.narrativeGeneration !== source.root.narrativeGeneration
      || pending.sourceRawFingerprint !== sourceRawFingerprint
      || pending.processingPrompt !== String(processingPromptSnapshot ?? ''))) {
      pendingResults.delete(floor.id);
      pending = null;
    }
    const runId = pending?.runId ?? prepared.runId;
    const preparedStillCurrent = () => extractionIntentCurrent(intent)
      && source.root.chatId === intent.chatId
      && prepared.sourceSelections.every(item => currentRawSelection(hostAdapter, source.floors.find(candidate => candidate.id === item.floorId))?.rawContent === item.rawContent)
      && JSON.stringify(currentUserIdentity() ?? null) === JSON.stringify(userIdentity ?? null);
    if (!preparedStillCurrent()) throw errorWith('V3_MEMORY_PREFIX_CHANGED', '聊天、目标楼或身份在请求前已经变化，本次请求未发送。');
    const operation = { floorId: floor.id, floorIds: [...prepared.sourceFloorIds], aggregate, floorFingerprint: floor.content.canonicalFingerprint, floorRawFingerprint: sourceRawFingerprint, storyClockSignature: sourceClock.signature, epoch: intent.epoch, controller: new AbortController(), runId, startedAt: pending?.startedAt ?? timingWork.startedAt, commitTimestamp: pending?.commitTimestamp ?? null, phase: pending ? 'committing' : 'extracting', dependencySnapshot, qianshiDependency, preflightTiming: Object.freeze({ ...prepared.preflightTiming, requestDispatchMs: elapsedMs(timingWork.startedMonotonic) }) };
    const releaseConfirmation = foundationRuntime.holdExtractionConfirmation?.(floor.id, runId) ?? null;
    active = operation; handedToExtractor = true; notify();
    let result = null;
    let summaryCommitted = false;
    try {
      if (!preparedStillCurrent()) throw errorWith('V3_MEMORY_PREFIX_CHANGED', '聊天、目标楼或身份在请求发出前已经变化，本次请求未发送。');
      operation.dependencyBoundaryMessageIndex = Math.max(...operation.dependencySnapshot.floorDependencies
        .map(item => item.hostLocator.messageIndex));
      operation.hostIdentity = generationIdentity(hostAdapter.snapshot());
      result = pending?.result ?? await runExtractorRequest({ generateUtilityTask, envelope, floor, existingEntities: scopedEntities, now: nowIso(now), supersedes: oldMemory?.id ?? null, preservedSummary: oldMemory?.summary?.effectiveSource === 'user' ? oldMemory.summary : null, expectedScope, promptGuidance: promptGuidanceSnapshot, processingPrompt: processingPromptSnapshot, aggregate, signal: operation.controller.signal });
      const replacement = validateFloorMemory({ ...result.memory, sourceStoryClockSignature: sourceClock.signature }, { expectedChatId: source.root.chatId });
      operation.phase = 'validating'; notify();
      const foundationAfter = await foundationRuntime.refreshStatus();
      if (foundationAfter.status !== 'ready') throw errorWith('V3_MEMORY_STALE', '后端数据在提取期间发生变化，本次结果已作废。');
      if (operation.epoch !== epoch || operation.controller.signal.aborted) throw errorWith('V3_MEMORY_CANCELLED', '聊天或正文已变化，迟到响应已丢弃。');
      operation.phase = 'committing'; notify();
      await commitRevision(operation, { oldReachable: source, replacement, newEntities: result.newEntities, provenanceEntry: { api: result.metadata, attempts: result.attempts, transportAttempts: result.transportAttempts, responseFingerprint: result.responseFingerprint, extractorVersion: replacement.extractorVersion, promptVersion: EXTRACTOR_PROMPT_VERSION, promptGuidanceFingerprint: `sha256:${await sha256(String(promptGuidanceSnapshot ?? ''))}`, systemPromptFingerprint: `sha256:${await sha256((aggregate ? buildHighFloorExtractorSystemPrompt : buildExtractorSystemPrompt)(promptGuidanceSnapshot, processingPromptSnapshot))}`, userIdentityFingerprint: `sha256:${await sha256(JSON.stringify(userIdentity ?? null))}`, semanticInputFingerprint, preflightTiming: operation.preflightTiming, needsReview: result.needsReview, rawFingerprint: sourceRawFingerprint, storyClockSignature: sourceClock.signature }, action: oldMemory ? 'reextract' : 'extract', validationErrors: result.validationErrors });
      summaryCommitted = true;
      if (analyzeState && !operation.controller.signal.aborted && operation.epoch === epoch) await cseRuntime.analyzeFloor(floor.id);
    } catch (error) {
      if (result && !summaryCommitted && error?.name !== 'AbortError' && !STALE_MEMORY_CODES.has(error?.code)) {
        rememberPendingResult(floor.id, { chatId: source.root.chatId, narrativeGeneration: source.root.narrativeGeneration, sourceRawFingerprint, processingPrompt: String(processingPromptSnapshot ?? ''), dependencySnapshot, runId: operation.runId, startedAt: operation.startedAt, commitTimestamp: operation.commitTimestamp, result });
      } else if (error?.name === 'AbortError' || STALE_MEMORY_CODES.has(error?.code)) pendingResults.delete(floor.id);
      if (error?.name !== 'AbortError' && !STALE_MEMORY_CODES.has(error?.code)) await persistFailure(operation, error, source);
      else lastFailure = Object.freeze({ floorId: operation.floorId, runId: operation.runId, phase: 'stale', code: error?.code === 'V3_MEMORY_PREFIX_CHANGED' ? 'V3_MEMORY_PREFIX_CHANGED' : 'V3_MEMORY_STALE', attempts: 0, validationErrors: [], api: null, message: safeErrorMessage(error?.message ?? '聊天、插件状态或正文分支已变化，迟到结果没有写入。') });
      logger?.warn?.('[qianqianjie] V3 extractor failed', { code: error?.code ?? error?.name ?? 'V3_EXTRACTOR_FAILED' });
    } finally {
      releaseConfirmation?.();
      if (active === operation) active = null;
      if (suffixGenerationContext?.runId === operation.runId) suffixGenerationContext = null;
    }
    return notify();
    } catch (error) {
      if (!handedToExtractor && !preparationStepFor(error)) markPreparationFailure(error, 'extractorHandoff');
      throw error;
    }
  }

  async function extractNextInternal(manualWork) {
    const intent = { epoch, chatId: currentHostChatId() };
    const preparedInput = await prepareExtractorInput({ selectNext: true, intent, manualWork });
    if (!preparedInput) return getState();
    return extractFloorInternal(preparedInput.floor.id, { preparedInput, manualWork });
  }
  async function reviseInternal(floorId, action, { userText = null, revisionNote = null, metadata = null } = {}) {
    if (active) return getState();
    const foundation = await foundationRuntime.refreshStatus();
    if (foundation.status !== 'ready') throw errorWith('V3_MEMORY_FOUNDATION_NOT_READY', '后端数据尚未与当前正文完成同步，当前不能修订。');
    await loadCurrent(epoch);
    const floor = reachable?.floors?.find(item => item.id === floorId), old = currentMemoryMap(reachable).get(floorId);
    if (!floor || !old) throw errorWith('V3_MEMORY_REVISION_UNAVAILABLE', '该楼还没有可修订的正式记忆。');
    const selectedAtRevision = currentRawSelection(hostAdapter, floor);
    const revisionRawContent = selectedAtRevision?.rawContent;
    const revisionRawFingerprint = typeof revisionRawContent === 'string' ? `sha256:${await sha256(revisionRawContent)}` : floor.content.rawFingerprint;
    const nowValue = nowIso(now);
    const revisionRunId = await deterministicUuid(['v3-memory-revision-run', old.id, action, nowValue, newUuid()]);
    const requestedSummary = String(metadata?.summary ?? userText ?? '').trim();
    const requestedRevisionNote = String(revisionNote ?? metadata?.revisionNote ?? '').trim();
    const summaryChanged = action === 'editMetadata' && requestedSummary !== String(effectiveSummary(old) ?? '').trim();
    let summary = action === 'edit' || summaryChanged ? { ...old.summary, userText: requestedSummary, effectiveSource: 'user', revisionNote: requestedRevisionNote || null }
      : action === 'restoreAi' ? { ...old.summary, userText: null, effectiveSource: 'ai', revisionNote: requestedRevisionNote || '恢复 AI 原摘要' }
        : action === 'editMetadata' ? old.summary
          : { ...old.summary, revisionNote: requestedRevisionNote || '用户标记错误' };
    if ((action === 'edit' || summaryChanged) && !summary.userText) throw errorWith('V3_MEMORY_SUMMARY_EMPTY', '摘要不能为空。');
    let chronology = old.chronology, locations = old.locations, participants = old.participants, newEntities = [], effectiveTimeChanged = false;
    if (action === 'editMetadata') {
      const priorTimeText = [...new Set(old.chronology.map(item => item.time?.sourceText || item.time?.normalized || item.description).map(value => String(value ?? '').trim()).filter(Boolean))].join('；');
      const requestedTimeText = String(metadata?.timeText ?? priorTimeText).trim().slice(0, 500);
      const originalTimeText = String(metadata?.originalTimeText ?? priorTimeText).trim().slice(0, 500);
      effectiveTimeChanged = metadata?.timeChanged === true && requestedTimeText !== originalTimeText;
      if (effectiveTimeChanged) chronology = [{ itemId: await deterministicUuid(['v3-user-chronology', revisionRunId, requestedTimeText]), time: { kind: /(?:随后|之后|此前|次日|翌日|当晚|片刻|小时|分钟|天后|周后)/u.test(requestedTimeText) ? 'relative' : requestedTimeText ? 'explicit' : 'unknown', sourceText: requestedTimeText || '时间未明确', normalized: null, precision: 'unresolved', relativeToFloorId: null }, description: requestedTimeText || '时间未明确', evidenceRefs: [] }];
      const existingLocations = new Map(old.locations.map(item => [item.itemId, item]));
      locations = [];
      for (const [index, item] of (Array.isArray(metadata?.locations) ? metadata.locations : []).slice(0, 80).entries()) {
        const name = String(item?.name ?? '').trim().slice(0, 500); if (!name) continue;
        const prior = existingLocations.get(item?.itemId) ?? null;
        locations.push({
          ...(prior ?? {}),
          itemId: prior?.itemId ?? await deterministicUuid(['v3-user-location', old.id, nowValue, index, name]),
          entityId: prior?.entityId ?? null,
          name,
          change: prior?.change ?? 'present',
          participantEntityIds: prior?.participantEntityIds ?? [],
          evidenceRefs: prior?.evidenceRefs ?? [],
        });
      }
      const activePeople = reachable.entities.filter(entity => entity.entityType === 'person' && entity.recordStatus === 'active' && entity.status !== 'merged' && entity.status !== 'invalidated');
      const existingParticipants = new Map(old.participants.map(item => [item.entityId, item]));
      const floorPeople = activePeople.filter(entity => existingParticipants.has(entity.id));
      const match = name => [...floorPeople, ...activePeople].find(entity => [entity.displayName, ...(entity.aliases ?? []).map(alias => alias.name)].some(label => normalizedName(label) === normalizedName(name)));
      const names = Array.isArray(metadata?.participantNames) ? [...new Set(metadata.participantNames.map(name => String(name ?? '').trim().slice(0, 500)).filter(Boolean))].slice(0, 80) : null;
      const selected = [];
      for (const name of names ?? []) {
        let entity = match(name);
        if (!entity) {
          const id = await deterministicUuid(['v3-user-person', revisionRunId, normalizedName(name)]);
          entity = validateEntityRecord({ schemaVersion: 3, recordType: 'entity', id, chatId: old.chatId, narrativeGeneration: old.narrativeGeneration, entityType: 'person', displayName: name, aliases: [{ name, normalized: normalizedName(name), kind: 'canonical', evidenceRefs: [], baselineClaimIds: [] }], specialRole: 'none', firstSeenFloorId: floor.id, lastSeenFloorId: floor.id, status: 'provisional', mergedIntoEntityId: null, mergeEvidenceRefs: [], baselineClaimIds: [], createdAt: nowValue, updatedAt: nowValue, recordStatus: 'active', supersedes: null }, { expectedChatId: old.chatId });
          newEntities.push(entity); activePeople.push(entity);
        }
        if (!selected.some(item => item.id === entity.id)) selected.push(entity);
      }
      if (names) {
        const unchanged = selected.length === old.participants.length && selected.every((entity, index) => entity.id === old.participants[index].entityId);
        if (!unchanged) participants = selected.map(entity => existingParticipants.get(entity.id) ?? { entityId: entity.id, presence: 'mentioned', evidenceRefs: [] });
      }
      const noteChanged = Boolean(requestedRevisionNote) && requestedRevisionNote !== String(old.summary.revisionNote ?? '').trim();
      const metadataChanged = summaryChanged || effectiveTimeChanged || newEntities.length > 0 || noteChanged || JSON.stringify(locations) !== JSON.stringify(old.locations) || JSON.stringify(participants) !== JSON.stringify(old.participants);
      if (!metadataChanged) return notify();
      if (!summaryChanged) summary = { ...old.summary, revisionNote: requestedRevisionNote || old.summary.revisionNote || '用户修订时间、地点或人物' };
    }
    const id = await deterministicUuid(['v3-memory-revision', old.id, action, summary, chronology, locations, participants, nowValue]);
    const qianshiDelta = effectiveTimeChanged && old.qianshiDelta
      ? pendingQianshiDelta(old.qianshiDelta, '本楼故事时间已人工修改，千事时间关系待重新提取。', nowValue)
      : old.qianshiDelta;
    const replacement = validateFloorMemory({ ...old, id, summary, chronology, locations, participants, ...(qianshiDelta ? { qianshiDelta } : {}), createdAt: nowValue, updatedAt: nowValue, recordStatus: action === 'markError' ? 'invalidated' : 'active', supersedes: old.id }, { expectedChatId: old.chatId });
    const operation = { floorId, floorFingerprint: floor.content.canonicalFingerprint, floorRawFingerprint: revisionRawFingerprint, epoch, controller: new AbortController(), runId: revisionRunId, startedAt: nowValue, phase: 'committing' };
    operation.dependencySnapshot = await extractorDependencySnapshot(reachable, floorId, { userIdentity: currentUserIdentity(), promptGuidance: '' });
    operation.dependencyBoundaryMessageIndex = Math.max(...(operation.dependencySnapshot?.floorDependencies ?? []).map(item => {
      const sourceFloor = reachable.floors.find(candidate => candidate.id === item.id);
      return sourceFloor?.stability?.proof?.messageIndex ?? item.hostLocator.messageIndex;
    }));
    operation.hostIdentity = generationIdentity(hostAdapter.snapshot());
    active = operation; notify();
    const priorAudit = floorProvenance(reachable)[floorId] ?? {};
    try { await commitRevision(operation, { oldReachable: reachable, replacement, newEntities, provenanceEntry: { api: priorAudit.api ?? null, attempts: priorAudit.attempts ?? 0, transportAttempts: priorAudit.transportAttempts ?? null, responseFingerprint: priorAudit.responseFingerprint ?? null, extractorVersion: priorAudit.extractorVersion ?? old.extractorVersion, needsReview: priorAudit.needsReview ?? false, rawFingerprint: priorAudit.rawFingerprint ?? floor.content.rawFingerprint, storyClockSignature: priorAudit.storyClockSignature ?? currentClockSignature(floor), timeEdited: priorAudit.timeEdited === true || (action === 'editMetadata' && effectiveTimeChanged) }, action }); }
    finally { active = null; }
    return notify();
  }
  const extractFloor = (floorId, options) => runManualWork('extracting', manualWork => {
    const memory = currentMemoryMap(reachable).get(floorId);
    const sourceFloorIds = memorySourceFloorIds(memory);
    return extractFloorInternal(floorId, { ...options, manualWork, aggregate: sourceFloorIds.length > 1, floorIds: sourceFloorIds.length > 1 ? sourceFloorIds : null });
  });
  const extractNext = () => runManualWork('extracting', manualWork => extractNextInternal(manualWork));
  const editSummary = (floorId, userText, revisionNote = '') => runManualWork('revising', () => reviseInternal(floorId, 'edit', { userText, revisionNote }));
  const editMemory = (floorId, metadata) => runManualWork('revising', () => reviseInternal(floorId, 'editMetadata', { metadata }));
  const restoreAi = floorId => runManualWork('revising', () => reviseInternal(floorId, 'restoreAi'));
  const markError = floorId => runManualWork('revising', () => reviseInternal(floorId, 'markError'));

  function diagnostic(floorId, { full = false } = {}) {
    const floor = reachable?.floors?.find(item => item.id === floorId);
    const view = getState().floors.find(item => item.floorId === floorId);
    if (!floor || !view) throw errorWith('V3_DIAGNOSTIC_FLOOR_MISSING', '找不到该楼诊断。');
    const memory = view.memory;
    const provenanceEntry = floorProvenance(reachable)[floorId] ?? {};
    const evidenceSafe = evidence => ({ ...evidence, quotedText: full ? evidence.quotedText : `[已隐藏原文 · ${evidence.quotedText.length} 字]` });
    const memoryCopy = memory ? clone(memory) : null;
    if (memoryCopy && !full) {
      delete memoryCopy.sourceCanonicalContent;
      delete memoryCopy.sourceFloorSnapshots;
      if (memoryCopy.sourceUserInputSnapshot) memoryCopy.sourceUserInputSnapshot.messages = memoryCopy.sourceUserInputSnapshot.messages.map(message => ({ ...message, content: `[已隐藏用户原文 · ${message.content.length} 字]` }));
      delete memoryCopy.sourceVariableReference;
      memoryCopy.summaryEvidenceRefs = memoryCopy.summaryEvidenceRefs.map(evidenceSafe);
      for (const field of ['chronology', 'locations', 'participants', 'actions', 'observations', 'informationTransfers', 'privateCognition', 'commitments', 'eventFragments', 'openLoops', 'ambiguities', 'cseSignals']) memoryCopy[field].forEach(item => { item.evidenceRefs = (item.evidenceRefs ?? []).map(evidenceSafe); });
      memoryCopy.exactAnchors = memoryCopy.exactAnchors.map(anchor => ({ ...anchor, exactText: `[已隐藏原文 · ${anchor.exactText.length} 字]` }));
    }
    const payload = { plugin: 'ST-QianQianJie', schemaVersion: 3, promptVersion: EXTRACTOR_PROMPT_VERSION, extractorVersion: provenanceEntry.extractorVersion ?? memory?.extractorVersion ?? EXTRACTOR_VERSION, chatId: reachable.root.chatId, narrativeGeneration: reachable.root.narrativeGeneration, floorId, runId: view.runId ?? lastFailure?.runId ?? null, checkpointId: reachable.root.headCheckpointId, memoryId: view.memoryId, status: view.status, stage: active?.floorId === floorId ? active.phase : (lastFailure?.floorId === floorId ? lastFailure.phase : 'settled'), api: view.api ?? lastFailure?.api ?? null, attempts: view.attempts || lastFailure?.attempts || 0, transportAttempts: provenanceEntry.transportAttempts ?? lastFailure?.transportAttempts ?? null, responseFingerprint: provenanceEntry.responseFingerprint ?? null, error: lastFailure?.floorId === floorId ? { code: lastFailure.code, httpStatus: lastFailure.httpStatus ?? null, providerError: lastFailure.providerError ?? null, formatStage: lastFailure.formatStage, validationErrors: lastFailure.validationErrors, message: lastFailure.message } : null, structuredCounts: view.counts, floorMemory: memoryCopy, ...(full ? { canonicalContent: floor.content.canonicalContent, sessionCandidate: sessionCandidates.get(floorId) ?? null } : {}) };
    return JSON.stringify(sanitizeDiagnosticValue(payload), null, 2);
  }
  const copySafeDiagnostic = floorId => diagnostic(floorId, { full: false });
  const copyFullDiagnostic = floorId => diagnostic(floorId, { full: true });

  async function runAutomationBatch(reason = 'stableAssistant', eventAuthorization = null) {
    const config = automation();
    const manualHistorical = reason === MANUAL_HISTORY_REASON;
    const aggregateHistorical = manualHistorical && historicalAggregate === true;
    const userInitiated = manualHistorical || reason === 'manualRetry' || Boolean(eventAuthorization);
    const authorizedChatId = manualHistorical ? historicalAuthorization : null;
    if (!enabled() || (!manualHistorical && !config.enabled) || (manualHistorical && !authorizedChatId)
      || (eventAuthorization && (!(hasEstablishedChat() || allowsRealtimeTailFromEmpty())
        || reachable?.root?.chatId !== eventAuthorization.chatId))
      || workRun || active || cseRuntime.getState().activeCse) return getState();
    const operation = { kind: 'auto', token: ++autoEpoch, reason, phase: 'reconciling', mode: manualHistorical ? 'historical' : 'realtime', aggregateHistorical, floorIds: [], promise: null };
    workRun = operation;
    notify();
    operation.promise = (async () => {
      let capturedInputKey = null;
      let capturedFloorIds = null;
      let processed = 0;
      let cseProcessed = 0;
      let fromAssistantSeq = null;
      let toAssistantSeq = null;
      const processedMessageIndexes = [];
      const summaryFailures = [];
      const failedSummaryFloorIds = new Set();
      let foundationRecoveryUsed = false;
      let cseDrain = null;
      let cseWakeRequested = false;
      let cseFailure = null;
      let cseSyncFailure = null;
      let summarySyncSerial = 0;
      let coverageSyncSerial = 0;
      try {
        const allowed = () => operation.token === autoEpoch && enabled() && (manualHistorical
          ? historicalAuthorization === authorizedChatId
          : automation().enabled);
        let historical = manualHistorical || eventAuthorization?.allowHistoricalDebt === true;
        const pipelineHistorical = manualHistorical;
        let startNotified = false;
        let resumed = false;
        const cseRolesReady = () => Boolean(reachable?.baseline && [reachable.baseline.userPersona.entityId, reachable.baseline.characterCard.entityId].every(id => reachable.entities.some(entity => entity.id === id)));
        const consumeCseWake = () => {
          if (!cseFailure) return true;
          if (cseFailure.serial >= summarySyncSerial) return false;
          cseFailure = null;
          operation.cseBlocked = false;
          return true;
        };
        const wakeCse = () => {
          if (!pipelineHistorical || !allowed() || !capturedFloorIds || !consumeCseWake()) return Promise.resolve();
          if (cseSyncFailure?.serial === summarySyncSerial) return Promise.resolve();
          if (cseDrain) { cseWakeRequested = true; return cseDrain; }
          let drainedSerial = summarySyncSerial;
          cseDrain = (async () => {
            let syncFloor = null;
            let recoveredCseSync = false;
            do {
              if (!consumeCseWake()) break;
              cseWakeRequested = false;
              if (cseSyncFailure?.serial < summarySyncSerial) recoveredCseSync = true;
              cseSyncFailure = null;
              drainedSerial = summarySyncSerial;
              const initializing = !cseRolesReady();
              while (allowed() && !cseFailure) {
                const views = getState().floors;
                const memoryMap = currentMemoryMap(reachable);
                const floor = reachable.floors.find(item => capturedFloorIds.includes(item.id)
                  && (!aggregateHistorical || memoryMap.get(item.id)?.recordStatus === 'active')
                  && !['ready', 'noChange'].includes(views.find(view => view.floorId === item.id)?.cse?.status));
                if (!floor || memoryMap.get(floor.id)?.recordStatus !== 'active') break;
                const attemptSerial = summarySyncSerial;
                try {
                  await cseRuntime.analyzeFloor(floor.id);
                  if (!allowed()) return;
                  const after = getState().floors.find(item => item.floorId === floor.id);
                  if (!['ready', 'noChange'].includes(after?.cse?.status)) {
                    cseFailure = { floor, serial: attemptSerial, message: getState().lastCseError?.message ?? 'CSE 分析失败；有新摘要保存时会从本楼再试，也可点击继续重建。' };
                    operation.cseBlocked = true;
                    break;
                  }
                  cseProcessed += 1;
                  syncFloor = floor;
                  if (initializing) break;
                } catch (error) {
                  if (!allowed()) return;
                  cseSyncFailure = { floor, serial: attemptSerial, message: safeErrorMessage(error?.message ?? '人物状态读取失败。') };
                  memorySyncStatus = 'error';
                  memorySyncError = Object.freeze({ code: String(error?.code ?? 'V3_MEMORY_SYNC_FAILED').slice(0, 120), message: cseSyncFailure.message });
                  operation.phase = 'syncing';
                  notify();
                  notifyOnce(`cseSync:${reason}:${capturedInputKey ?? currentInputKey()}:${floor.id}:${summarySyncSerial}`,
                    { kind: 'warning', text: `千千结读取人物状态材料时失败：${cseSyncFailure.message} 将在后续新摘要成功保存后接续。` });
                  break;
                }
              }
            } while (cseWakeRequested && allowed()
              && (!cseFailure || cseFailure.serial < summarySyncSerial)
              && cseSyncFailure?.serial !== summarySyncSerial);
            if (syncFloor && allowed() && !cseSyncFailure) {
              const coverageAttemptSerial = summarySyncSerial;
              try {
                await refreshCoverage(epoch);
                coverageSyncSerial = summarySyncSerial;
                if (recoveredCseSync) {
                  memorySyncStatus = 'idle';
                  memorySyncError = null;
                  recoveredCseSync = false;
                  notify();
                }
              } catch (error) {
                if (!allowed()) return;
                cseSyncFailure = { floor: syncFloor, serial: coverageAttemptSerial, message: safeErrorMessage(error?.message ?? '人物状态保存后同步失败。') };
                memorySyncStatus = 'error';
                memorySyncError = Object.freeze({ code: String(error?.code ?? 'V3_MEMORY_SYNC_FAILED').slice(0, 120), message: cseSyncFailure.message });
                operation.phase = 'syncing';
                notify();
                notifyOnce(`cseSync:${reason}:${capturedInputKey ?? currentInputKey()}:${syncFloor.id}:${summarySyncSerial}`,
                  { kind: 'warning', text: `千千结读取已保存的人物状态时失败：${cseSyncFailure.message} 将在后续新摘要成功保存后接续。` });
              }
            }
          })().finally(() => {
            cseDrain = null;
            if (cseWakeRequested && summarySyncSerial > drainedSerial && allowed()
              && (!cseFailure || cseFailure.serial < summarySyncSerial)
              && cseSyncFailure?.serial !== summarySyncSerial) void wakeCse();
          });
          return cseDrain;
        };
        while (allowed()) {
          operation.phase = 'reconciling';
          notify();
          const foundation = await foundationRuntime.refreshStatus();
          if (!allowed()) return getState();
          if (foundation.status !== 'ready') {
            if (!foundationRecoveryUsed && ['error', 'stale'].includes(foundation.status)) {
              foundationRecoveryUsed = true;
              continue;
            }
            throw errorWith('V3_MEMORY_FOUNDATION_NOT_READY', safeErrorMessage(foundation.lastError ?? '后端数据尚未就绪。'));
          }
          const foundationReachable = foundationRuntime.getReachable?.() ?? null;
          const reuseHistoricalSync = pipelineHistorical && await canReuseSynchronizedReachable(epoch, foundationReachable);
          if (!reuseHistoricalSync) await load(epoch, foundationReachable);
          const settlement = backgroundSync;
          if (settlement) await settlement;
          if (!allowed() || !reachable?.root) return getState();
          if (manualHistorical && reachable.root.chatId !== authorizedChatId) return getState();
          const assessment = coverage;
          if (assessment.status === 'unknown') throw errorWith('V3_MEMORY_COVERAGE_UNCONFIRMED', '当前聊天的可达覆盖尚未确认，历史重建已暂停。');
          capturedFloorIds ??= Object.freeze((reachable.floors ?? []).map(floor => floor.id));
          capturedInputKey ??= currentInputKey();
          const capturedFloorSet = new Set(capturedFloorIds);
          const capturedTotal = capturedFloorIds.length;
          const hasCapturedPending = (value, key) => (value?.[key] ?? []).some(floorId => capturedFloorSet.has(floorId));
          if (historical && !hasCapturedPending(assessment, 'pendingFloorIds') && !hasCapturedPending(assessment, 'summaryPendingFloorIds')) {
            if (cseDrain) await cseDrain;
            if (!allowed()) return getState();
            if (manualHistorical && historicalAuthorization === authorizedChatId) historicalAuthorization = null;
            if (manualHistorical) historicalAggregate = false;
            lastAutomaticInputKey = capturedInputKey;
            lastAutoRun = processed || cseProcessed
              ? Object.freeze({ status: 'completed', reason, mode: manualHistorical ? 'historical' : 'realtime', batchSize: config.batchSize, recovered: resumed, fromAssistantSeq, toAssistantSeq, processed, cseProcessed })
              : Object.freeze({ status: 'caughtUp', reason, mode: manualHistorical ? 'historical' : 'realtime', batchSize: config.batchSize, available: 0, fromAssistantSeq: null, toAssistantSeq: null, processed: 0 });
            clearAutomationFailure(reachable);
            if (processed || cseProcessed) try { notifyUser?.({ kind: 'success', text: manualHistorical
              ? `千千结已完成历史记忆维护：新增摘要 ${processed} 楼，补齐人物状态 ${cseProcessed} 楼。`
              : `千千结已自动维护完成：新增摘要 ${processed} 楼，补齐人物状态 ${cseProcessed} 楼。` }); } catch { /* notification must not affect committed memory */ }
            return notify();
          }
          const inputKey = currentInputKey();
          if (!userInitiated && lastAutomaticInputKey === inputKey) {
            if (['failed', 'partial'].includes(lastAutoRun?.status)) return notify();
            lastAutoRun = Object.freeze({ status: 'waiting', reason, mode: 'realtime', batchSize: config.batchSize, available: Math.max(0, assessment.total - assessment.completed), fromAssistantSeq: assessment.nextAssistantSeq, toAssistantSeq: reachable.floors.at(-1)?.assistantSeq ?? null, processed: 0, cseProcessed: 0 });
            return notify();
          }
          operation.mode = historical ? 'historical' : 'realtime';
          const memoryMap = currentMemoryMap(reachable);
          const summaryPendingIds = new Set(assessment.summaryPendingFloorIds ?? []);
          const summaryPending = (reachable.floors ?? [])
            .filter(floor => summaryPendingIds.has(floor.id) && capturedFloorSet.has(floor.id)
              && !failedSummaryFloorIds.has(floor.id)
              && memoryMap.get(floor.id)?.recordStatus !== 'active');
          const targets = historical
            ? aggregateHistorical
              ? (() => {
                  const first = summaryPending[0];
                  if (!first) return [];
                  const pendingSet = new Set(summaryPending.map(item => item.id));
                  const startIndex = reachable.floors.findIndex(item => item.id === first.id);
                  const result = [];
                  for (let index = startIndex; index < reachable.floors.length && result.length < 10; index += 1) {
                    const candidate = reachable.floors[index];
                    if (!pendingSet.has(candidate.id) || coveredMemoryMap(reachable).has(candidate.id)) break;
                    result.push(candidate);
                  }
                  return result;
                })()
              : summaryPending.slice(0, 1)
            : assessment.summaryStatus === 'realtimeTail' && summaryPending.length >= config.batchSize
              ? summaryPending.slice(0, config.batchSize)
              : [];
          resumed ||= historical ? assessment.hasPartialWork : assessment.summaryHasPartialWork;
          if (pipelineHistorical) {
            const initializing = !cseRolesReady();
            const pending = wakeCse();
            if (initializing) await pending;
            if (!allowed()) return getState();
          }
          if (targets.length) {
            if (!startNotified) {
              const unfinished = missingSummaryCount(capturedFloorSet);
              if (unfinished > 0) {
                const firstPending = targets[0];
                notifyOnce(`starting:${eventAuthorization?.id ?? reason}:${capturedInputKey ?? inputKey}:${firstPending.id}:${unfinished}`, {
                  kind: 'info', text: `千千结开始补齐 ${unfinished} 楼摘要（从${floorCopy(firstPending)}起）。`,
                });
              }
              startNotified = true;
            }
            operation.floorIds = targets.map(floor => floor.id);
            operation.phase = 'extracting';
            notify();
            if (aggregateHistorical) {
              const anchorFloor = targets.at(-1);
              if (!allowed()) return getState();
              await extractFloorInternal(anchorFloor.id, { analyzeState: false, aggregate: true, floorIds: targets.map(item => item.id) });
              if (!allowed()) return getState();
              const currentFloor = getState().floors.find(item => item.floorId === anchorFloor.id);
              if (!currentFloor?.memoryId || currentFloor.status !== 'ready') {
                const failure = Object.freeze({ floorId: anchorFloor.id, floorIds: Object.freeze(targets.map(item => item.id)), assistantSeq: anchorFloor.assistantSeq, messageIndex: anchorFloor.hostLocator?.messageIndex ?? null, floorLabel: `${floorCopy(targets[0])}至${floorCopy(anchorFloor)}`, message: getState().lastExtractorError?.message ?? '高楼压缩记忆提取失败，可重新选择高楼压缩后从本批重试。' });
                for (const item of targets) failedSummaryFloorIds.add(item.id);
                summaryFailures.push(failure);
                historicalAuthorization = null;
                historicalAggregate = false;
                lastAutomaticInputKey = capturedInputKey ?? inputKey;
                lastAutoRun = Object.freeze({ status: processed ? 'partial' : 'failed', reason, mode: operation.mode, phase: 'extracting', aggregateHistorical: true, batchSize: targets.length, floorId: anchorFloor.id, assistantSeq: anchorFloor.assistantSeq, processed, cseProcessed, summarySaved: processed, failedItems: Object.freeze([...summaryFailures]), message: failure.message });
                notifyOnce(`extractingAggregate:${reason}:${capturedInputKey ?? inputKey}:${anchorFloor.id}`, { kind: 'warning', text: `千千结高楼压缩失败：${failure.floorLabel}这一整批没有写入，任务已暂停。${safeErrorMessage(failure.message)}` });
                return notify();
              }
              onAutomaticSummaryCommitted({ chatId: reachable.root.chatId, floorId: anchorFloor.id, sourceFloorIds: targets.map(item => item.id), memoryId: currentFloor.memoryId });
              fromAssistantSeq ??= targets[0].assistantSeq;
              toAssistantSeq = anchorFloor.assistantSeq;
              processedMessageIndexes.push(...targets.map(item => item.hostLocator?.messageIndex));
              processed += targets.length;
              summarySyncSerial += 1;
              const initializing = !cseRolesReady();
              const pending = wakeCse();
              if (initializing) await pending;
            } else for (const floor of targets) {
              if (!allowed()) return getState();
              const memory = currentMemoryMap(reachable).get(floor.id);
              if (memory?.recordStatus !== 'active') await extractFloorInternal(floor.id, { analyzeState: false });
              if (!allowed()) return getState();
              const currentFloor = getState().floors.find(item => item.floorId === floor.id);
              if (!currentFloor?.memoryId || currentFloor.status !== 'ready') {
                const failure = Object.freeze({ floorId: floor.id, assistantSeq: floor.assistantSeq, messageIndex: floor.hostLocator?.messageIndex ?? null, floorLabel: floorCopy(floor), message: getState().lastExtractorError?.message ?? 'FloorMemory 提取失败，可点击继续重建后从本楼重试。' });
                failedSummaryFloorIds.add(floor.id);
                summaryFailures.push(failure);
                const unfinished = missingSummaryCount(capturedFloorSet);
                notifyOnce(`extracting:${reason}:${capturedInputKey ?? inputKey}:${floor.id}:${unfinished}`, { kind: 'warning', text: `千千结摘要提取失败：${summaryDebtCopy({ floor, count: unfinished, retry: '本批不会重复本楼，将继续尝试其他可独立处理的楼。' })} ${safeErrorMessage(failure.message)}` });
                continue;
              }
              onAutomaticSummaryCommitted({ chatId: reachable.root.chatId, floorId: floor.id, memoryId: currentFloor.memoryId });
              fromAssistantSeq ??= floor.assistantSeq;
              toAssistantSeq = floor.assistantSeq;
              processedMessageIndexes.push(floor.hostLocator?.messageIndex);
              processed += 1;
              if (pipelineHistorical) {
                summarySyncSerial += 1;
                const initializing = !cseRolesReady();
                const pending = wakeCse();
                if (initializing) await pending;
              }
            }
            if (!historical) continue;
          }
          if (historical && summaryFailures.length) {
            const pendingSummaryIds = new Set(coverage.summaryPendingFloorIds ?? []);
            const remainingIndependentSummary = (reachable.floors ?? [])
              .some(floor => pendingSummaryIds.has(floor.id) && capturedFloorSet.has(floor.id)
                && !failedSummaryFloorIds.has(floor.id)
                && currentMemoryMap(reachable).get(floor.id)?.recordStatus !== 'active');
            if (remainingIndependentSummary) continue;
          }
          if (!allowed()) return getState();
          let afterExtraction = coverage;
          if (afterExtraction.status === 'unknown') throw errorWith('V3_MEMORY_COVERAGE_UNCONFIRMED', '摘要保存后覆盖校验未确认，人物状态分析已暂停。');
          if (historical && hasCapturedPending(afterExtraction, 'summaryPendingFloorIds') && summaryFailures.length === 0) continue;
          if (pipelineHistorical) {
            await wakeCse();
            if (!allowed()) return getState();
            if (cseSyncFailure) {
              lastAutoRun = Object.freeze({ status: processed || cseProcessed ? 'partial' : 'failed', reason, mode: operation.mode,
                phase: 'syncing', batchSize: config.batchSize, floorId: cseSyncFailure.floor.id,
                assistantSeq: cseSyncFailure.floor.assistantSeq, processed, cseProcessed, summarySaved: processed,
                failedItems: Object.freeze([...summaryFailures]), message: cseSyncFailure.message });
              notifyOnce(`syncingCse:${reason}:${capturedInputKey ?? inputKey}:${cseSyncFailure.floor.id}:${summarySyncSerial}`,
                { kind: 'warning', text: `千千结已保存当前结果，但同步人物状态时读取失败：${safeErrorMessage(cseSyncFailure.message)} 后续有新的摘要成功保存时会再次接续。` });
              return notify();
            }
            if (coverageSyncSerial !== summarySyncSerial) {
              afterExtraction = await refreshCoverage(epoch);
              coverageSyncSerial = summarySyncSerial;
            } else afterExtraction = coverage;
            if (cseFailure) {
              const floor = cseFailure.floor;
              lastAutomaticInputKey = capturedInputKey ?? inputKey;
              lastAutoRun = Object.freeze({ status: processed || cseProcessed ? 'partial' : 'failed', reason, mode: operation.mode, phase: 'analyzingCse', batchSize: config.batchSize, floorId: floor.id, assistantSeq: floor.assistantSeq, processed, cseProcessed, summarySaved: processed, failedItems: Object.freeze([...summaryFailures]), message: cseFailure.message });
              notifyOnce(`analyzingCse:${reason}:${capturedInputKey ?? inputKey}:${floor.id}:${missingSummaryCount(capturedFloorSet)}`, { kind: 'warning', text: `千千结人物状态分析失败：${floorCopy(floor)}人物状态未完成；有新摘要保存时会从本楼再试，也可在记忆管理中点击继续。${safeErrorMessage(cseFailure.message)}` });
              return notify();
            }
            if (!summaryFailures.length) continue;
          }
          while (!pipelineHistorical && allowed() && hasCapturedPending(afterExtraction, 'pendingFloorIds')) {
            const activeMemories = currentMemoryMap(reachable);
            const pendingId = afterExtraction.pendingFloorIds.find(floorId => capturedFloorSet.has(floorId) && activeMemories.get(floorId)?.recordStatus === 'active');
            const floor = reachable.floors?.find(item => item.id === pendingId);
            if (!floor) break;
            operation.phase = 'analyzingCse';
            operation.floorIds = [...new Set([...operation.floorIds, floor.id])];
            notify();
            if (!allowed()) return getState();
            const before = getState().floors.find(item => item.floorId === floor.id);
            if (!['ready', 'noChange'].includes(before?.cse?.status)) await cseRuntime.analyzeFloor(floor.id);
            if (!allowed()) return getState();
            const after = getState().floors.find(item => item.floorId === floor.id);
            if (!['ready', 'noChange'].includes(after?.cse?.status)) {
              if (manualHistorical && historicalAuthorization === authorizedChatId) historicalAuthorization = null;
              lastAutomaticInputKey = capturedInputKey ?? inputKey;
              const cseStatus = processed > 0 || cseProcessed > 0 ? 'partial' : 'failed';
              lastAutoRun = Object.freeze({ status: cseStatus, reason, mode: operation.mode, phase: 'analyzingCse', batchSize: config.batchSize, floorId: floor.id, assistantSeq: floor.assistantSeq, messageIndex: floor.hostLocator?.messageIndex ?? null, processed, cseProcessed, summarySaved: processed, failedItems: Object.freeze([...summaryFailures]), message: getState().lastCseError?.message ?? 'CSE 分析失败，可点击继续重建后从本楼重试。' });
              const prefix = historical ? '千千结人物状态分析失败'
                : processed > 0 ? '千千结已保存新楼摘要，但最早待处理楼的人物状态分析失败'
                  : '千千结人物状态追赶失败';
              const unfinished = missingSummaryCount(capturedFloorSet);
              const retryCopy = unfinished > 0
                ? '相同内容不会自动重试，另有历史摘要缺口不会自动补，请在记忆管理中点击继续。'
                : '相同内容不会自动重试，后续有新稳定回复时会有限重试，也可现在点击继续。';
              notifyOnce(`analyzingCse:${reason}:${capturedInputKey ?? inputKey}:${floor.id}:${unfinished}`, { kind: 'warning', text: `${prefix}：${floorCopy(floor)}人物状态未完成，未完成摘要 ${unfinished} 楼；${retryCopy}${safeErrorMessage(lastAutoRun.message)}` });
              return notify();
            }
            cseProcessed += 1;
            await loadCurrent(epoch);
            afterExtraction = await refreshCoverage(epoch);
            if (afterExtraction.status === 'unknown') throw errorWith('V3_MEMORY_COVERAGE_UNCONFIRMED', '人物状态保存后覆盖校验未确认，自动追赶已暂停。');
          }
          if (summaryFailures.length) {
            if (manualHistorical && historicalAuthorization === authorizedChatId) historicalAuthorization = null;
            lastAutomaticInputKey = capturedInputKey ?? inputKey;
            const didCommit = processed > 0 || cseProcessed > 0;
            lastAutoRun = Object.freeze({ status: didCommit ? 'partial' : 'failed', reason, mode: operation.mode, phase: 'extracting', batchSize: config.batchSize, processed, cseProcessed, failedItems: Object.freeze([...summaryFailures]), available: missingSummaryCount(capturedFloorSet), fromAssistantSeq, toAssistantSeq, message: `${summaryFailures.length} 楼摘要未完成；${didCommit ? '已保存其他可独立完成的结果。' : '本批没有可保存的新结果。'}` });
            try { notifyUser?.({ kind: didCommit ? 'warning' : 'error', text: didCommit
              ? `千千结本批部分完成：已新增摘要 ${processed} 楼、补齐人物状态 ${cseProcessed} 楼；${summaryFailures.map(item => item.floorLabel).join('、')}摘要仍需重试。`
              : `千千结本批未完成：${summaryFailures.map(item => item.floorLabel).join('、')}摘要仍需重试，本批没有保存新结果。` }); } catch { /* notification must not affect committed memory */ }
            return notify();
          }
          if (!historical) {
            lastAutomaticInputKey = null;
            const summaryDebt = afterExtraction.summaryStatus === 'historicalDebt' && hasCapturedPending(afterExtraction, 'summaryPendingFloorIds');
            if (summaryDebt) {
              lastAutoRun = Object.freeze({ status: 'authorizationRequired', reason, mode: 'historical', phase: cseProcessed ? 'analyzingCse' : 'extracting', batchSize: config.batchSize, available: missingSummaryCount(capturedFloorSet), fromAssistantSeq: afterExtraction.summaryNextAssistantSeq, toAssistantSeq: reachable.floors.at(capturedTotal - 1)?.assistantSeq ?? null, processed, cseProcessed });
              const firstPending = reachable.floors?.find(floor => afterExtraction.summaryPendingFloorIds.includes(floor.id)) ?? null;
              const prefix = cseProcessed ? `千千结已补齐 ${cseProcessed} 楼人物状态；` : '千千结发现需要用户确认的历史摘要缺口：';
              notifyOnce(`authorization:${capturedInputKey ?? inputKey}:${firstPending?.id ?? 'unknown'}:${lastAutoRun.available}`, { kind: 'warning', text: `${prefix}${summaryDebtCopy({ floor: firstPending, count: lastAutoRun.available, retry: '这是历史缺口，不会自动补，请在记忆管理中点击继续。' })}` });
              return notify();
            }
            const summaryWaiting = hasCapturedPending(afterExtraction, 'summaryPendingFloorIds');
            if (summaryWaiting) {
              lastAutoRun = Object.freeze({ status: 'waiting', reason, mode: 'realtime', phase: cseProcessed ? 'analyzingCse' : 'extracting', batchSize: config.batchSize, available: missingSummaryCount(capturedFloorSet), fromAssistantSeq: afterExtraction.summaryNextAssistantSeq, toAssistantSeq: reachable.floors.at(capturedTotal - 1)?.assistantSeq ?? null, processed, cseProcessed });
              if (cseProcessed) try { notifyUser?.({ kind: 'success', text: `千千结已补齐 ${cseProcessed} 楼人物状态；新摘要继续等待稳定批次。` }); } catch { /* notification must not affect committed memory */ }
              return notify();
            }
            const didWork = processed > 0 || cseProcessed > 0;
            lastAutoRun = Object.freeze({ status: didWork ? 'completed' : 'caughtUp', reason, mode: 'realtime', phase: cseProcessed ? 'analyzingCse' : 'extracting', batchSize: config.batchSize, recovered: resumed, fromAssistantSeq, toAssistantSeq, processed, cseProcessed, cseCompleted: cseProcessed > 0 });
            clearAutomationFailure(reachable);
            if (didWork) try { notifyUser?.({ kind: 'success', text: `千千结已自动维护完成：新增摘要 ${processed} 楼，补齐人物状态 ${cseProcessed} 楼。` }); } catch { /* notification must not affect committed memory */ }
            return notify();
          }
        }
        return getState();
      } catch (error) {
        if (operation.token === autoEpoch) {
          if (manualHistorical && historicalAuthorization === authorizedChatId) historicalAuthorization = null;
          lastAutomaticInputKey = capturedInputKey ?? currentInputKey();
          const didCommit = processed > 0 || cseProcessed > 0;
          const diagnostic = preparationFailureDiagnostic(error);
          lastAutoRun = Object.freeze({ status: didCommit ? 'partial' : 'failed', reason, phase: operation.phase, batchSize: config.batchSize, floorId: operation.floorIds[0] ?? null, assistantSeq: null, processed, cseProcessed, failedItems: Object.freeze([...summaryFailures]), message: safeErrorMessage(error?.message ?? '自动记忆失败，将在下一次稳定回复后重试。') });
          rememberAutomationFailure(reachable, { message: lastAutoRun.message, code: diagnostic.code ?? 'V3_AUTO_MEMORY_FAILED', name: diagnostic.name, phase: operation.phase, prepareStep: diagnostic.prepareStep, detail: diagnostic.detail, location: diagnostic.location });
          const diagnosticCode = diagnostic.code ?? diagnostic.name ?? 'V3_AUTO_MEMORY_FAILED';
          logger?.warn?.('[qianqianjie] V3 automatic memory failed', { code: diagnosticCode });
          notifyOnce(`outer:${reason}:${capturedInputKey ?? currentInputKey()}:${operation.phase}:${diagnosticCode}`, { kind: didCommit ? 'warning' : 'error', text: `千千结自动记忆${didCommit ? '部分完成' : '未完成'}：已新增摘要 ${processed} 楼、补齐人物状态 ${cseProcessed} 楼；${lastAutoRun.message} 当前未完成摘要楼数无法可靠确认；相同内容不会自动重试，请在记忆管理中点击继续。` });
          notify();
        }
        return getState();
      } finally {
        if (cseDrain) await cseDrain;
        if (manualHistorical && historicalAuthorization === authorizedChatId) historicalAuthorization = null;
        if (workRun === operation) workRun = null;
        notify();
        if (operation.token === autoEpoch && (processed || cseProcessed) && lastAutoRun?.status === 'completed' && reachable?.root) {
          try { void onMemoryBatchCommitted({ chatId: reachable.root.chatId, headCheckpointId: reachable.root.headCheckpointId, historical: manualHistorical }); } catch { /* dedicated task does not affect committed memory */ }
        }
        const boundaryAdvanced = capturedInputKey !== null && capturedInputKey !== currentInputKey();
        if (!manualHistorical && operation.token === autoEpoch && hasAutomaticCatchupWork()
          && ((lastAutoRun?.status === 'waiting' && lastAutomaticInputKey !== currentInputKey()) || boundaryAdvanced)) {
          autoTriggerReason ??= 'postBoundaryCatchup';
        }
        if (autoTriggerReason && scheduleAllowed(autoTriggerReason)) void scheduleAutomation(autoTriggerReason, autoTriggerAuthorization);
      }
    })();
    return operation.promise;
  }

  function scheduleAllowed(reason) {
    if (!enabled()) return false;
    if (reason === MANUAL_HISTORY_REASON) return Boolean(historicalAuthorization);
    if (reason === 'manualRetry') return automation().enabled;
    return automation().enabled && lastAutoRun?.status !== 'paused';
  }

  function scheduleAutomation(reason = 'stableAssistant', authorization = null) {
    if (!scheduleAllowed(reason)) return Promise.resolve(getState());
    autoTriggerReason = reason;
    if (authorization) autoTriggerAuthorization = authorization;
    if (autoScheduled) return autoScheduled;
    autoScheduled = Promise.resolve().then(() => {
      if (workRun || active || cseRuntime.getState().activeCse) return getState();
      const nextReason = autoTriggerReason;
      const nextAuthorization = autoTriggerAuthorization;
      autoTriggerReason = null;
      autoTriggerAuthorization = null;
      return runAutomationBatch(nextReason, nextAuthorization);
    }).finally(() => {
      autoScheduled = null;
      if (autoTriggerReason && !workRun && !active && !cseRuntime.getState().activeCse && scheduleAllowed(autoTriggerReason)) void scheduleAutomation(autoTriggerReason, autoTriggerAuthorization);
    });
    return autoScheduled;
  }

  function refreshAutomation() {
    if (!enabled()) {
      cancelAutomation();
      return Promise.resolve(notify());
    }
    if (!automation().enabled) {
      if (autoTriggerReason !== MANUAL_HISTORY_REASON) autoTriggerReason = null;
      if (workRun?.kind === 'auto' && workRun.mode === 'realtime') {
        autoEpoch += 1;
        active?.controller.abort();
        cseRuntime.cancelActive?.();
      }
    } else {
      notifyConfirmedSummaryBlock();
    }
    return Promise.resolve(notify());
  }

  const generationIdentity = snapshot => Object.freeze({
    hostChatId: String(snapshot?.chatId ?? '').trim(),
    chatId: String(snapshot?.context?.chatMetadata?.qianqianjie?.chatId ?? '').trim(),
    narrativeGeneration: foundationRuntime.getState()?.narrativeGeneration ?? foundationRuntime.getReachable?.()?.root?.narrativeGeneration ?? null,
  });
  const sameGenerationIdentity = (arm, snapshot) => {
    const currentIdentity = generationIdentity(snapshot);
    return Boolean(arm && arm.hostChatId === currentIdentity.hostChatId && arm.chatId === currentIdentity.chatId
      && (arm.narrativeGeneration === null || arm.narrativeGeneration === currentIdentity.narrativeGeneration));
  };
  const sameHostChatIdentity = (expected, snapshot) => {
    const currentIdentity = generationIdentity(snapshot);
    return Boolean(expected && expected.hostChatId === currentIdentity.hostChatId && expected.chatId === currentIdentity.chatId);
  };
  const isAssistantSlot = message => Boolean(message && typeof message === 'object' && message.is_user === false
    && !isHostNarratorMessage(message) && !(message.is_system === true && message.extra?.type));
  const isValidSentUser = (snapshot, messageIndex) => Boolean(Number.isSafeInteger(messageIndex)
    && selectUserStabilityAnchor(snapshot?.chat?.[messageIndex])
    && isAssistantSlot(snapshot?.chat?.[messageIndex - 1]));
  const normalizedGenerationType = value => ['swipe', 'regenerate'].includes(value) ? value
    : [undefined, null, '', 'normal', 'continue'].includes(value) ? 'normal' : null;
  function captureGenerationLifecycle(type) {
    let snapshot;
    try { snapshot = hostAdapter.snapshot(); } catch { generationLifecycle = null; return; }
    const inferred = normalizedGenerationType(type)
      ?? (suffixGenerationContext?.kind === 'swipe' ? 'swipe' : null);
    if (!inferred) { generationLifecycle = null; return; }
    let targetMessageIndex = inferred === 'normal' ? null : (suffixGenerationContext?.messageIndex ?? null);
    if (!Number.isSafeInteger(targetMessageIndex)) {
      for (let index = snapshot.chat.length - 1; index >= 0; index -= 1) {
        if (isAssistantSlot(snapshot.chat[index])) { targetMessageIndex = index; break; }
      }
    }
    const selected = Number.isSafeInteger(targetMessageIndex) ? selectAssistantMessage(snapshot.chat[targetMessageIndex]) : null;
    generationLifecycle = Object.freeze({
      id: `generation:${++generationSequence}`,
      ...generationIdentity(snapshot),
      type: inferred,
      startChatLength: snapshot.chat.length,
      targetMessageIndex,
      startRawContent: selected?.rawContent ?? '',
      startSwipeId: selected?.swipeId ?? null,
      startSelectedSwipeIndex: selected?.selectedSwipeIndex ?? null,
      completed: false,
    });
  }
  function completedGenerationSlot(lifecycle, snapshot, messageIndex = null) {
    if (!lifecycle || lifecycle.completed || !sameGenerationIdentity(lifecycle, snapshot)) return null;
    if (lifecycle.type === 'normal') return newAssistantSlot(lifecycle, snapshot, { requireContent: true, messageIndex });
    const index = Number.isSafeInteger(messageIndex) ? messageIndex : lifecycle.targetMessageIndex;
    const selected = Number.isSafeInteger(index) ? selectAssistantMessage(snapshot.chat?.[index]) : null;
    if (!selected || !meaningfulText(selected.rawContent)) return null;
    const changed = selected.rawContent !== lifecycle.startRawContent
      || selected.swipeId !== lifecycle.startSwipeId
      || selected.selectedSwipeIndex !== lifecycle.startSelectedSwipeIndex;
    return changed ? Object.freeze({ messageIndex: index }) : null;
  }
  function grantEventCatchup(reason, eventId) {
    if (!eventId || grantedEventKeys.has(eventId) || !enabled() || !automation().enabled || !hasExplicitInitializationIntent() || lastAutoRun?.status === 'paused') return false;
    const chatId = reachable?.root?.chatId ?? establishedMemoryChatId;
    if (!chatId) return false;
    grantedEventKeys.add(eventId);
    while (grantedEventKeys.size > 24) grantedEventKeys.delete(grantedEventKeys.values().next().value);
    const authorization = Object.freeze({ id: eventId, chatId, allowHistoricalDebt: true });
    autoTriggerReason = reason;
    autoTriggerAuthorization = authorization;
    awaitingFoundation = true;
    markMemorySyncing();
    notify();
    return true;
  }
  function completeGeneration(reason, messageIndex = null) {
    const lifecycle = generationLifecycle;
    let snapshot;
    try { snapshot = hostAdapter.snapshot(); } catch { return false; }
    const slot = completedGenerationSlot(lifecycle, snapshot, messageIndex);
    if (!slot) return false;
    generationLifecycle = Object.freeze({ ...lifecycle, completed: true, messageIndex: slot.messageIndex });
    return grantEventCatchup(reason, lifecycle.id);
  }
  const eventMessageIndex = (name, args) => {
    if (['MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED'].includes(name)) return Number.isSafeInteger(args[0]) ? args[0] : null;
    if (name === 'MESSAGE_SWIPE_DELETED') return Number.isSafeInteger(args[0]?.messageId) ? args[0].messageId : null;
    return null;
  };
  function suffixBoundary(messageIndex, expected = null) {
    if (!enabled() || !active || !Number.isSafeInteger(messageIndex)
      || !Number.isSafeInteger(active.dependencyBoundaryMessageIndex)
      || messageIndex <= active.dependencyBoundaryMessageIndex) return null;
    let snapshot;
    try { snapshot = hostAdapter.snapshot(); } catch { return null; }
    if (!sameHostChatIdentity(active.hostIdentity, snapshot)) return null;
    if (expected && (expected.runId !== active.runId || expected.messageIndex !== messageIndex
      || expected.dependencyBoundaryMessageIndex !== active.dependencyBoundaryMessageIndex
      || !sameHostChatIdentity(expected, snapshot))) return null;
    return Object.freeze({
      hostChatId: active.hostIdentity.hostChatId,
      chatId: active.hostIdentity.chatId,
      runId: active.runId,
      messageIndex,
      dependencyBoundaryMessageIndex: active.dependencyBoundaryMessageIndex,
    });
  }
  const meaningfulText = value => {
    const text = typeof value === 'string' ? value.trim() : '';
    return text !== '' && text !== '...';
  };
  function isStoppedGenerationFinal(name, args, messageIndex = eventMessageIndex(name, args)) {
    const stopped = stoppedGenerationFinal;
    if (name !== 'MESSAGE_RECEIVED' || !stopped) return false;
    let snapshot;
    try { snapshot = hostAdapter.snapshot(); } catch { return false; }
    if (!sameGenerationIdentity(stopped, snapshot)) return false;
    const index = Number.isSafeInteger(messageIndex) ? messageIndex : snapshot.chat?.length - 1;
    const selected = Number.isSafeInteger(index) ? selectAssistantMessage(snapshot.chat?.[index]) : null;
    if (!selected || !meaningfulText(selected.rawContent)) return false;
    if (stopped.type === 'normal') return index === stopped.targetMessageIndex || index >= stopped.startChatLength;
    return index === stopped.targetMessageIndex;
  }
  function newAssistantSlot(arm, snapshot, { requireContent = false, messageIndex = null } = {}) {
    if (!arm || !Array.isArray(snapshot?.chat)) return null;
    const start = Math.max(0, arm.startChatLength);
    const indexes = Number.isSafeInteger(messageIndex) ? [messageIndex] : Array.from({ length: Math.max(0, snapshot.chat.length - start) }, (_, offset) => start + offset);
    for (const index of indexes) {
      if (index < start) continue;
      const message = snapshot.chat[index];
      if (!isAssistantSlot(message)) continue;
      const selected = selectAssistantMessage(message);
      if (requireContent && !meaningfulText(selected?.rawContent) && !meaningfulText(message.mes)) continue;
      return Object.freeze({ messageIndex: index });
    }
    return null;
  }
  function armEarlyGeneration(type) {
    generationArm = null;
    if (!enabled() || !automation().enabled || !hasExplicitInitializationIntent()
      || typeof foundationRuntime.stabilizeThrough !== 'function') return;
    if (!(type === undefined || type === null || type === '' || type === 'normal')) return;
    let snapshot;
    try { snapshot = hostAdapter.snapshot(); } catch { return; }
    const boundary = foundationRuntime.getState()?.pending;
    if (!boundary || !Number.isSafeInteger(boundary.assistantSeq) || !Number.isSafeInteger(boundary.messageIndex) || typeof boundary.canonicalFingerprint !== 'string') return;
    const prior = snapshot.chat?.[boundary.messageIndex];
    if (!isAssistantSlot(prior) || !meaningfulText(selectAssistantMessage(prior)?.rawContent)) return;
    generationArm = Object.freeze({
      ...generationIdentity(snapshot),
      boundary: Object.freeze({ assistantSeq: boundary.assistantSeq, messageIndex: boundary.messageIndex, canonicalFingerprint: boundary.canonicalFingerprint }),
      startChatLength: snapshot.chat.length,
      proven: false,
      messageIndex: null,
    });
  }
  function consumeEarlyProof({ text = null, messageIndex = null, requireContent = false } = {}) {
    const arm = generationArm;
    if (!arm || arm.proven || (text !== null && !meaningfulText(text))) return false;
    let snapshot;
    try { snapshot = hostAdapter.snapshot(); } catch { return false; }
    if (!sameGenerationIdentity(arm, snapshot)) { generationArm = null; cancelAutomation(); return false; }
    const slot = newAssistantSlot(arm, snapshot, { requireContent, messageIndex });
    if (!slot) return false;
    generationArm = Object.freeze({ ...arm, proven: true, messageIndex: slot.messageIndex });
    awaitingFoundation = true;
    markMemorySyncing();
    if (automation().enabled) autoTriggerReason = 'earlyStableAssistant';
    void Promise.resolve(foundationRuntime.stabilizeThrough(arm.boundary)).catch(error => {
      if (generationArm?.boundary !== arm.boundary) return;
      lastFailure = Object.freeze({ floorId: null, runId: null, phase: 'foundation', code: error?.code ?? 'V3_EARLY_FOUNDATION_FAILED', attempts: 0, validationErrors: [], api: null, message: safeErrorMessage(error?.message) });
      notify();
    });
    return true;
  }

  function bind({ eventSource, eventTypes } = hostAdapter.snapshot()) {
    try { observedHostChatLength = hostAdapter.snapshot()?.chat?.length ?? 0; } catch { observedHostChatLength = 0; }
    foundationRuntime.bind({ eventSource, eventTypes, allowAutomaticWrite: (name, args) => {
      const identityAllowed = ['CHAT_CHANGED', 'CHAT_RENAMED'].includes(name) ? hasEstablishedChat() : hasExplicitInitializationIntent();
      return identityAllowed && !isStoppedGenerationFinal(name, args);
    } });
    if (bound || !eventSource?.on || !eventTypes) return false;
    const drainFoundationReload = () => {
      if (foundationReload) return foundationReload;
      foundationReload = Promise.resolve().then(async () => {
        while (awaitingFoundation && enabled()) {
          const foundationState = foundationRuntime.getState();
          const foundationStatus = foundationState?.status;
          if (!['ready', 'uninitialized', 'needsReview'].includes(foundationStatus)) break;
          awaitingFoundation = false;
          const reloadEpoch = epoch;
          try {
            const foundationReachable = foundationRuntime.getReachable?.() ?? null;
            const readOnlyReview = foundationStatus === 'needsReview'
              && foundationState.chatId === currentHostChatId()
              && foundationReachable?.root?.chatId === currentHostChatId();
            if (foundationStatus === 'needsReview' && !readOnlyReview) {
              memorySyncStatus = 'needsReview';
              memorySyncError = null;
              if (!reachable) memorySnapshotStatus = 'unavailable';
              notify();
              continue;
            }
            await load(reloadEpoch, foundationStatus === 'uninitialized' ? null : foundationReachable, { readOnlyReview });
            const settlement = backgroundSync;
            if (settlement) await settlement;
            if (reloadEpoch === epoch && autoTriggerReason && scheduleAllowed(autoTriggerReason)) {
              const reason = autoTriggerReason;
              autoTriggerReason = null;
              void scheduleAutomation(reason);
            }
          } catch (error) {
            if (reloadEpoch !== epoch) continue;
            lastFailure = Object.freeze({ floorId: null, runId: null, phase: 'load', code: error?.code ?? 'V3_MEMORY_LOAD_FAILED', attempts: 0, validationErrors: [], api: null, message: safeErrorMessage(error?.message) });
            memorySyncStatus = 'error';
            memorySyncError = lastFailure;
            if (!reachable) memorySnapshotStatus = 'error';
            notify();
          }
        }
      }).finally(() => { foundationReload = null; });
      return foundationReload;
    };
    if (typeof foundationRuntime.subscribe === 'function') unsubscribeFoundation = foundationRuntime.subscribe(state => {
      if (!awaitingFoundation) return;
      if (['ready', 'uninitialized', 'needsReview'].includes(state?.status)) { void drainFoundationReload(); return; }
      if (!['running', 'idle'].includes(state?.status)) {
        awaitingFoundation = false;
        memorySyncStatus = state?.status === 'error' ? 'error' : 'needsReview';
        memorySyncError = state?.lastError ? Object.freeze({ code: 'V3_FOUNDATION_NOT_READY', message: safeErrorMessage(state.lastError) }) : null;
        if (!reachable) memorySnapshotStatus = state?.status === 'error' ? 'error' : 'unavailable';
        notify();
      }
    });
    const generationStoppedEvent = eventTypes.GENERATION_STOPPED;
    const generationEndedEvent = eventTypes.GENERATION_ENDED;
    const generationStartedEvent = eventTypes.GENERATION_STARTED;
    if (generationStartedEvent && generationStoppedEvent && generationEndedEvent) {
      eventSource.on(generationStartedEvent, (type, _options, dryRun) => {
        if (dryRun === true) return;
        stoppedGenerationFinal = null;
        if (suffixGenerationContext && ((suffixGenerationContext.kind === 'swipe' && type !== 'swipe')
          || (suffixGenerationContext.kind === 'normal' && ![undefined, null, '', 'normal', 'continue'].includes(type))
          || !suffixBoundary(suffixGenerationContext.messageIndex, suffixGenerationContext))) suffixGenerationContext = null;
        if (formalGenerationActive) {
          if (type === undefined || type === null || type === '' || type === 'normal') generationArm = null;
          return;
        }
        formalGenerationActive = true;
        captureGenerationLifecycle(type);
        armEarlyGeneration(type);
        if (active?.phase === 'resetting') { epoch += 1; active.controller.abort('generationStarted'); }
      });
      eventSource.on(generationStoppedEvent, () => {
        formalGenerationActive = false;
        generationArm = null;
        stoppedGenerationFinal = generationLifecycle;
        generationLifecycle = null;
        if (suffixGenerationContext && suffixGenerationContext.stopped !== true
          && suffixBoundary(suffixGenerationContext.messageIndex, suffixGenerationContext)) {
          suffixGenerationContext = Object.freeze({ ...suffixGenerationContext, stopped: true });
          awaitingFoundation = true;
          markMemorySyncing();
          notify();
          return;
        }
        suffixGenerationContext = null;
        cancelEarlyStabilization('generationStopped');
        cancelAutomation();
      });
      eventSource.on(generationEndedEvent, () => {
        formalGenerationActive = false;
        if (!generationArm?.proven) generationArm = null;
        if (completeGeneration('generationCompleted')) {
          void Promise.resolve(foundationRuntime.reconcile?.('GENERATION_ENDED'))
            .then(() => drainFoundationReload())
            .catch(error => {
              lastFailure = Object.freeze({ floorId: null, runId: null, phase: 'foundation', code: error?.code ?? 'V3_FOUNDATION_FAILED', attempts: 0, validationErrors: [], api: null, message: safeErrorMessage(error?.message) });
              notify();
            });
        }
      });
    }
    const streamTokenEvent = eventTypes.STREAM_TOKEN_RECEIVED;
    if (streamTokenEvent) eventSource.on(streamTokenEvent, text => { consumeEarlyProof({ text }); });
    const messageUpdatedEvent = eventTypes.MESSAGE_UPDATED;
    if (messageUpdatedEvent) eventSource.on(messageUpdatedEvent, messageIndex => { consumeEarlyProof({ messageIndex, requireContent: true }); });
    for (const name of EVENTS) {
      const eventName = eventTypes[name]; if (!eventName) continue;
      eventSource.on(eventName, (...args) => {
        const finalType = args[1];
        let eventSnapshot = null;
        if (name === 'MESSAGE_SENT') {
          try { eventSnapshot = hostAdapter.snapshot(); } catch { return; }
          if (!isValidSentUser(eventSnapshot, args[0])) return;
        }
        const messageIndex = eventMessageIndex(name, args);
        if (isStoppedGenerationFinal(name, args, messageIndex)) {
          suffixGenerationContext = null;
          awaitingFoundation = true;
          markMemorySyncing();
          notify();
          return;
        }
        if (HISTORY_MUTATION_EVENTS.has(name)) {
          const operation = active;
          if (operation && reachable?.root?.chatId === currentHostChatId()) {
            void extractorDependencySnapshot(reachable, operation.floorId, {
              userIdentity: currentUserIdentity(),
              promptGuidance: operation.dependencySnapshot?.promptGuidance,
              referenceTags: operation.dependencySnapshot?.storyClockReferenceTags,
            }).then(currentDependency => {
              if (active !== operation || sameExtractorDependency(operation.dependencySnapshot, currentDependency)) return;
              cancelEarlyStabilization('dependencyChanged');
              cancelAutomation('dependencyChanged');
              operation.controller.abort('dependencyChanged');
            }).catch(() => {
              if (active !== operation) return;
              cancelEarlyStabilization('dependencyCheckFailed');
              cancelAutomation('dependencyCheckFailed');
              operation.controller.abort('dependencyCheckFailed');
            });
          }
          awaitingFoundation = true;
          markMemorySyncing();
          notify();
          return;
        }
        const preservedSuffix = messageIndex === null ? null : suffixBoundary(messageIndex);
        if (preservedSuffix) {
          if (name === 'MESSAGE_SWIPED') suffixGenerationContext = Object.freeze({ ...preservedSuffix, kind: 'swipe', stopped: false });
          else if (name === 'MESSAGE_SENT') {
            suffixGenerationContext = Object.freeze({ ...preservedSuffix, kind: 'normal', stopped: false });
            grantEventCatchup('newUserAnchor', `user:${preservedSuffix.chatId}:${messageIndex}:${eventSnapshot?.chat?.[messageIndex]?.send_date ?? ''}`);
          } else if (name === 'MESSAGE_RECEIVED') {
            suffixGenerationContext = null;
            completeGeneration('generationCompleted', messageIndex);
          }
          awaitingFoundation = true;
          markMemorySyncing();
          notify();
          return;
        }
        const sameEarlyFinal = name === 'MESSAGE_RECEIVED' && generationArm?.proven
          && args[0] === generationArm.messageIndex
          && (finalType === undefined || finalType === null || finalType === '' || finalType === 'normal' || finalType === 'continue') && (() => {
          try {
            const snapshot = hostAdapter.snapshot();
            return sameGenerationIdentity(generationArm, snapshot)
              && Boolean(newAssistantSlot(generationArm, snapshot, { requireContent: true, messageIndex: generationArm.messageIndex }));
          } catch { return false; }
        })();
        if (sameEarlyFinal) {
          generationArm = null;
          if (!completeGeneration('generationCompleted', messageIndex)) {
            grantEventCatchup('newAssistant', `assistant:${generationIdentity(hostAdapter.snapshot()).chatId}:${messageIndex}:${observedHostChatLength}`);
          }
          return;
        }
        if (name === 'MESSAGE_SENT') {
          stoppedGenerationFinal = null;
          const key = `user:${generationIdentity(eventSnapshot).chatId}:${messageIndex}:${eventSnapshot?.chat?.[messageIndex]?.send_date ?? ''}`;
          grantEventCatchup('newUserAnchor', key);
          observedHostChatLength = Math.max(observedHostChatLength, eventSnapshot?.chat?.length ?? 0);
          awaitingFoundation = true;
          markMemorySyncing();
          notify();
          return;
        }
        if (name === 'MESSAGE_RECEIVED') {
          if (generationArm?.proven) {
            generationArm = null;
            generationLifecycle = null;
            cancelEarlyStabilization('mismatchedGenerationFinal');
            cancelAutomation();
          }
          try { eventSnapshot = hostAdapter.snapshot(); } catch {
            awaitingFoundation = true;
            markMemorySyncing();
            notify();
            return;
          }
          const lifecycleCompleted = completeGeneration('generationCompleted', messageIndex);
          const appendedIndex = Number.isSafeInteger(messageIndex) ? messageIndex : eventSnapshot.chat?.length - 1;
          const appended = Number.isSafeInteger(appendedIndex) && appendedIndex >= observedHostChatLength
            && isAssistantSlot(eventSnapshot.chat?.[appendedIndex])
            && meaningfulText(selectAssistantMessage(eventSnapshot.chat?.[appendedIndex])?.rawContent);
          if (!lifecycleCompleted && appended) {
            grantEventCatchup('newAssistant', `assistant:${generationIdentity(eventSnapshot).chatId}:${appendedIndex}:${observedHostChatLength}`);
          } else if (!lifecycleCompleted && ['swipe', 'regenerate'].includes(finalType)) {
            const selected = Number.isSafeInteger(appendedIndex) ? selectAssistantMessage(eventSnapshot.chat?.[appendedIndex]) : null;
            if (selected && meaningfulText(selected.rawContent)) grantEventCatchup('trustedGenerationFinal', `final:${finalType}:${appendedIndex}:${selected.swipeId ?? ''}:${selected.selectedSwipeIndex ?? ''}:${selected.rawContent}`);
          }
          observedHostChatLength = Math.max(observedHostChatLength, eventSnapshot.chat?.length ?? 0);
          awaitingFoundation = true;
          markMemorySyncing();
          notify();
          return;
        }
        if (['CHAT_CHANGED', 'CHAT_RENAMED'].includes(name)
          && reachable?.root?.chatId
          && reachable.root.chatId === currentHostChatId()) {
          awaitingFoundation = true;
          markMemorySyncing();
          notify();
          return;
        }
        generationArm = null;
        generationLifecycle = null;
        suffixGenerationContext = null;
        cancelEarlyStabilization(name);
        cancelAutomation(name);
        qianshiHistoryRun?.controller.abort(name);
        qianshiHistoryRun = null;
        qianshiHistoryPlan = null;
        qianshiHistoryState = Object.freeze({ status: 'idle', jobId: null, processedFloors: 0, totalFloors: 0, calls: 0, message: '' });
        epoch += 1;
        active?.controller.abort(name);
        active = null;
        workRun = null;
        memorySnapshotStatus = 'syncing';
        reachable = null;
        memorySyncStatus = 'syncing';
        memorySyncError = null;
        timeFallbackByFloor = new Map();
        coverage = unknownCoverage(0);
        lastFailure = null;
        sessionCandidates.clear();
        pendingResults.clear();
        cseRuntime.invalidate();
        awaitingFoundation = true;
        if (!['MESSAGE_SENT', 'MESSAGE_RECEIVED'].includes(name)) { emptyRealtimeOrigin = null; lastAutomaticInputKey = null; lastNoticeKey = null; }
        if (['MESSAGE_SENT', 'MESSAGE_RECEIVED'].includes(name) && automation().enabled) autoTriggerReason = name;
        if (name === 'CHAT_CHANGED' || name === 'CHAT_RENAMED' || HISTORY_MUTATION_EVENTS.has(name)) lastAutoRun = null;
        notify();
      });
    }
    bound = true; return true;
  }
  async function start() {
    if (!enabled()) return notify();
    await refreshStatus({ preferCached: false });
    const initialSettlement = backgroundSync;
    if (initialSettlement) await initialSettlement;
    void resumeQianshiHistoryReconciliations().catch(error => {
      logger.warn?.('[ST-QianQianJie] 千事审阅批次本地核对未能恢复', safeErrorMessage(error?.message));
    });
    const state = getState();
    notifyConfirmedSummaryBlock(state);
    return state;
  }
  async function setEnabled(value) {
    if (value !== true) { invalidate(); await foundationRuntime.setEnabled(value); return notify(); }
    if (typeof foundationRuntime.inspect === 'function') await foundationRuntime.inspect('memoryEnabled');
    else await foundationRuntime.setEnabled(value);
    return load();
  }
  async function startHistoricalRebuild(options = {}) {
    if (['paused', 'failed'].includes(cseRebuildPlan?.status)) {
      if (cseRebuildPlanCurrent(cseRebuildPlan)) return resumeCseRebuild(currentHostChatId());
      cseRebuildPlan = null;
    }
    while (autoScheduled || workRun?.promise) await (autoScheduled ?? workRun.promise);
    if (!enabled()) return notify();
    if (mainGenerationActive()) {
      try { notifyUser?.({ kind: 'warning', text: '主模型正在生成，请等待完成后再开始重建。' }); } catch { /* notification is advisory */ }
      return notify();
    }
    const foundation = await foundationRuntime.refreshStatus(MANUAL_HISTORY_REASON, { verifyRoot: true });
    if (foundation.status !== 'ready') {
      lastAutoRun = Object.freeze({ status: 'failed', reason: MANUAL_HISTORY_REASON, mode: 'historical', phase: 'reconciling', batchSize: automation().batchSize, floorId: null, assistantSeq: null, message: safeErrorMessage(foundation.lastError ?? '后端数据尚未就绪。') });
      try { notifyUser?.({ kind: 'error', text: `历史记忆维护未开始：${lastAutoRun.message} 已保存的记忆保持不变，请稍后点击继续补齐。` }); } catch { /* notification is advisory */ }
      return notify();
    }
    const foundationReachable = foundationRuntime.getReachable?.() ?? null;
    if (!await canReuseSynchronizedReachable(epoch, foundationReachable)) await load(epoch, foundationReachable);
    const settlement = backgroundSync;
    if (settlement) await settlement;
    const assessment = coverage;
    if (mainGenerationActive()) {
      try { notifyUser?.({ kind: 'warning', text: '主模型正在生成，请等待完成后再开始重建。' }); } catch { /* notification is advisory */ }
      return notify();
    }
    if (!reachable?.root || !['historicalDebt', 'realtimeTail'].includes(assessment.status)) return notify();
    historicalAuthorization = reachable.root.chatId;
    historicalAggregate = options?.aggregate === true;
    return scheduleAutomation(MANUAL_HISTORY_REASON);
  }
  const shouldBlockMainGeneration = () => Boolean(enabled() && (
    (historicalAuthorization && reachable?.root?.chatId === historicalAuthorization)
    || workRun?.mode === 'cseRebuild'
  ));
  const allowsRealtimeTailFromEmpty = () => Boolean(realtimeOriginFromReachable(reachable) || (emptyRealtimeOrigin && (reachable?.root
    ? emptyRealtimeOrigin.chatId === reachable.root.chatId
      && (emptyRealtimeOrigin.narrativeGeneration === null || emptyRealtimeOrigin.narrativeGeneration === reachable.root.narrativeGeneration)
    : emptyRealtimeOrigin.narrativeGeneration === null && emptyRealtimeOrigin.chatId === currentHostChatId())));
  function pauseHistoricalRebuild() {
    const wasHistorical = historicalAuthorization !== null || (workRun?.kind === 'auto' && workRun.mode === 'historical');
    const pausedOperationToken = workRun?.token ?? autoEpoch;
    historicalAuthorization = null;
    historicalAggregate = false;
    if (autoTriggerReason === MANUAL_HISTORY_REASON) autoTriggerReason = null;
    if (workRun?.kind === 'auto' && workRun.mode === 'historical') {
      autoEpoch += 1;
      active?.controller.abort();
      cseRuntime.cancelActive?.();
    }
    if (wasHistorical) {
      lastAutoRun = Object.freeze({ status: 'paused', reason: MANUAL_HISTORY_REASON, mode: 'historical', batchSize: automation().batchSize, available: Math.max(0, coverage.total - coverage.completed), fromAssistantSeq: coverage.nextAssistantSeq, toAssistantSeq: reachable?.floors?.at(-1)?.assistantSeq ?? null, processed: 0 });
      notifyOnce(`paused:${pausedOperationToken}:${currentInputKey()}:${coverage.nextAssistantSeq}`, { kind: 'info', text: '千千结历史记忆维护已暂停，可在记忆管理中点击继续恢复。' });
    }
    return notify();
  }
  function cseRebuildTargets(value) {
    const memoryMap = currentMemoryMap(value);
    const targets = [];
    for (const floor of value?.floors ?? []) {
      const memory = memoryMap.get(floor.id);
      if (memory?.recordStatus === 'active') targets.push(Object.freeze({ floorId: floor.id, memoryId: memory.id, assistantSeq: floor.assistantSeq }));
    }
    return Object.freeze(targets);
  }
  function cseRebuildPlanCurrent(plan, value = reachable) {
    if (!plan || plan.chatId !== value?.root?.chatId || plan.narrativeGeneration !== value?.root?.narrativeGeneration) return false;
    const currentByFloor = new Map(cseRebuildTargets(value).map(target => [target.floorId, target]));
    return plan.targets.every(target => currentByFloor.get(target.floorId)?.memoryId === target.memoryId);
  }
  function startCseRebuild(expectedChatId, { resume = false } = {}) {
    if (workRun) return Promise.resolve(getState());
    if (!enabled()) return Promise.resolve(notify());
    const requestedEpoch = epoch;
    const requestedChatId = String(expectedChatId ?? currentHostChatId()).trim();
    if (!requestedChatId || requestedChatId !== currentHostChatId()) return Promise.reject(errorWith('V3_CSE_REBUILD_STALE', '当前聊天已变化，CSE 重构未开始。'));
    if (mainGenerationActive()) {
      try { notifyUser?.({ kind: 'warning', text: '主模型正在生成，请等待完成后再重构 CSE。' }); } catch { /* notification is advisory */ }
      return Promise.resolve(notify());
    }
    const operation = { kind: 'auto', reason: MANUAL_CSE_REBUILD_REASON, mode: 'cseRebuild', token: ++autoEpoch, phase: 'reconciling', floorIds: [], promise: null };
    workRun = operation;
    notify();
    const allowed = () => workRun === operation && operation.token === autoEpoch && requestedEpoch === epoch
      && requestedChatId === currentHostChatId() && enabled() && !mainGenerationActive();
    operation.promise = (async () => {
      const foundation = await foundationRuntime.refreshStatus(MANUAL_CSE_REBUILD_REASON, { verifyRoot: true });
      if (!allowed()) return getState();
      if (foundation.status !== 'ready') throw errorWith('V3_MEMORY_FOUNDATION_NOT_READY', '后端数据尚未与当前正文完成同步，人物状态重构未开始。');
      await load(requestedEpoch, foundationRuntime.getReachable?.() ?? null);
      if (!allowed() || !reachable?.root) return getState();
      if (resume) {
        cseRebuildPlan ??= persistedCseRebuildPlan(reachable);
        if (!cseRebuildPlan || !['running', 'paused', 'failed'].includes(cseRebuildPlan.status)) throw errorWith('V3_CSE_REBUILD_NOT_RESUMABLE', '当前没有可继续的 CSE 重构。');
        const persistedCount = persistedCseRebuildCompletedCount(reachable, cseRebuildPlan);
        if (persistedCount !== null && persistedCount > cseRebuildPlan.nextIndex) {
          cseRebuildPlan = { ...cseRebuildPlan, nextIndex: persistedCount, status: persistedCount >= cseRebuildPlan.targets.length ? 'completed' : 'paused', error: null };
        }
        if (!cseRebuildPlanCurrent(cseRebuildPlan)) {
          cseRebuildPlan = null;
          throw errorWith('V3_CSE_REBUILD_TARGET_CHANGED', '摘要范围已经变化，旧计划已释放；已提交的人物状态保持不变，可重新开始 CSE 重构。');
        }
        cseRebuildPlan = { ...cseRebuildPlan, status: 'running', error: null };
      } else {
        const targets = cseRebuildTargets(reachable);
        cseRebuildPlan = Object.freeze({ jobId: newUuid(), chatId: reachable.root.chatId, narrativeGeneration: reachable.root.narrativeGeneration, targets, nextIndex: 0, status: targets.length ? 'running' : 'completed', error: null });
      }
      let plan = cseRebuildPlan;
      operation.floorIds = plan.targets.map(target => target.floorId);
      notify();
      while (allowed() && plan.nextIndex < plan.targets.length) {
        if (!cseRebuildPlanCurrent(plan)) throw errorWith('V3_CSE_REBUILD_TARGET_CHANGED', '摘要范围已经变化，CSE 重构已停止。');
        const target = plan.targets[plan.nextIndex];
        operation.phase = 'analyzingCse';
        operation.floorIds = [target.floorId];
        notify();
        const beforeDeltaId = cseRuntime.getState().cseFloors.find(item => item.floorId === target.floorId)?.deltaId ?? null;
        await cseRuntime.analyzeFloor(target.floorId, { cseRebuild: cseRebuildDiagnostic(plan, plan.nextIndex + 1), replaceExisting: true });
        if (!allowed()) {
          const committedReachable = requestedEpoch === epoch ? foundationRuntime.getReachable?.() ?? null : null;
          const committedCount = persistedCseRebuildCompletedCount(committedReachable, plan);
          if (committedCount !== null && committedCount > plan.nextIndex) {
            await load(requestedEpoch, committedReachable);
            await cseRuntime.load(committedReachable);
            cseRebuildPlan = Object.freeze({ ...plan, nextIndex: committedCount, status: committedCount >= plan.targets.length ? 'completed' : 'paused', error: null });
            notify();
          }
          return getState();
        }
        const after = cseRuntime.getState().cseFloors.find(item => item.floorId === target.floorId);
        if (!['ready', 'noChange'].includes(after?.status) || !after.deltaId || after.deltaId === beforeDeltaId) {
          const message = cseRuntime.getState().lastCseError?.message ?? `${floorCopy(reachable.floors.find(floor => floor.id === target.floorId))}人物状态分析失败。`;
          cseRebuildPlan = Object.freeze({ ...plan, status: 'failed', error: safeErrorMessage(message) });
          try { notifyUser?.({ kind: 'error', text: `CSE 重构在${floorCopy(reachable.floors.find(floor => floor.id === target.floorId))}暂停：${cseRebuildPlan.error} 可点击“继续 CSE 重构”重试。` }); } catch { /* notification must not affect saved progress */ }
          return notify();
        }
        await load(requestedEpoch, reachable);
        if (!allowed()) return getState();
        cseRebuildPlan = Object.freeze({ ...plan, nextIndex: plan.nextIndex + 1, status: plan.nextIndex + 1 >= plan.targets.length ? 'completed' : 'running', error: null });
        plan = cseRebuildPlan;
        notify();
      }
      if (allowed() && cseRebuildPlan?.status === 'completed') {
        try { void onMemoryBatchCommitted({ chatId: reachable.root.chatId, headCheckpointId: reachable.root.headCheckpointId, historical: true }); } catch { /* dedicated task is independent */ }
        try { notifyUser?.({ kind: 'success', text: `CSE 重构完成：已按顺序重新生成人物状态 ${cseRebuildPlan.targets.length} 楼；摘要保持不变。` }); } catch { /* notification must not affect saved progress */ }
      }
      return notify();
    })().catch(error => {
      if (workRun === operation && operation.token === autoEpoch) {
        cseRebuildPlan = cseRebuildPlan ? Object.freeze({ ...cseRebuildPlan, status: 'failed', error: safeErrorMessage(error?.message) }) : null;
        try { notifyUser?.({ kind: 'error', text: `CSE 重构未完成：${safeErrorMessage(error?.message)}${cseRebuildPlan ? ' 可点击“继续 CSE 重构”重试。' : ''}` }); } catch { /* notification must not affect saved progress */ }
      }
      return notify();
    }).finally(() => {
      if (workRun === operation) workRun = null;
      notify();
      if (autoTriggerReason && scheduleAllowed(autoTriggerReason)) void scheduleAutomation(autoTriggerReason, autoTriggerAuthorization);
    });
    return operation.promise;
  }
  const rebuildCse = expectedChatId => startCseRebuild(expectedChatId);
  const resumeCseRebuild = expectedChatId => startCseRebuild(expectedChatId, { resume: true });
  function pauseCseRebuild() {
    if (workRun?.mode !== 'cseRebuild') return notify();
    cseRebuildPlan = cseRebuildPlan ? Object.freeze({ ...cseRebuildPlan, status: 'paused', error: null }) : null;
    autoEpoch += 1;
    cseRuntime.cancelActive?.();
    try { notifyUser?.({ kind: 'info', text: 'CSE 重构已暂停，可在记忆管理中继续。' }); } catch { /* notification is advisory */ }
    return notify();
  }
  const retryAutomation = async () => {
    while (autoScheduled || workRun?.promise) await (autoScheduled ?? workRun.promise);
    const settlement = backgroundSync;
    if (settlement) await settlement;
    await refreshCoverage(epoch);
    if (['paused', 'failed'].includes(cseRebuildPlan?.status)) {
      if (cseRebuildPlanCurrent(cseRebuildPlan)) return resumeCseRebuild(currentHostChatId());
      cseRebuildPlan = null;
    }
    return coverage.status === 'historicalDebt' || coverage.summaryStatus === 'historicalDebt'
      ? startHistoricalRebuild()
      : scheduleAutomation('manualRetry');
  };
  async function runManualCse(floorId = null) {
    const requestedEpoch = epoch;
    let receipt = null;
    const result = await runManualWork('analyzingCse', async operation => {
      const hadGap = getState().floors.some(floor => (!floorId || floor.floorId === floorId) && floor.memoryId && !['ready', 'noChange'].includes(floor.cse?.status));
      const beforeHead = reachable?.root?.headCheckpointId;
      const chatId = reachable?.root?.chatId;
      operation.floorIds = floorId ? [floorId] : [];
      operation.phase = 'analyzingCse'; notify();
      if (floorId) await cseRuntime.analyzeFloor(floorId, { replaceExisting: true });
      else await cseRuntime.analyzeNext();
      if (requestedEpoch !== epoch || !enabled()) return notify();
      await loadCurrent(requestedEpoch);
      const after = getState();
      if (hadGap && requestedEpoch === epoch && reachable?.root?.chatId === chatId && reachable.root.headCheckpointId !== beforeHead
        && after.stableCount > 0 && after.summaryCompletedCount === after.stableCount && after.rebuildCompletedCount === after.stableCount) {
        receipt = { chatId, headCheckpointId: reachable.root.headCheckpointId, historical: true };
      }
      return notify();
    });
    if (receipt && requestedEpoch === epoch && enabled() && !workRun && reachable?.root?.chatId === receipt.chatId) {
      try { void onMemoryBatchCommitted(receipt); } catch { /* dedicated task is independent */ }
    }
    return result;
  }
  const analyzeNextState = () => runManualCse();
  const retryStateAnalysis = floorId => runManualCse(floorId);
  const correctSubjectState = (subjectEntityId, edits) => runManualWork('revisingCse', async operation => { operation.phase = 'revisingCse'; notify(); await cseRuntime.correctSubjectState({ subjectEntityId, ...edits }); return load(); });

  function persistentQianshiHistoryReviews(source = reachable) {
    if (!source?.root) return [];
    const memoryByFloor = currentMemoryMap(source), restored = [];
    for (const floor of source.floors) {
      const memory = memoryByFloor.get(floor.id), review = memory?.qianshiDelta?.historyReview;
      if (!review || review.rawFingerprint !== floor.content.rawFingerprint) continue;
      const events = review.candidates.filter(candidate => candidate.decision === 'pending').map(candidate => ({
        ...candidate.event, id: candidate.candidateId, relations: candidate.relations, recommendedEventId: candidate.recommendedEventId,
        matchBasis: candidate.matchBasis,
      }));
      if (events.length) restored.push({ floorId: floor.id, assistantSeq: floor.assistantSeq, memoryId: memory.id,
        rawFingerprint: review.rawFingerprint, chatId: source.root.chatId, narrativeGeneration: source.root.narrativeGeneration,
        rootSourceFingerprint: source.root.sourceSnapshotFingerprint, events,
        reason: memory.qianshiDelta.reason || '新事件与本楼旧记录存在可见文本重合，请审阅后决定。' });
    }
    return restored;
  }

  function persistentQianshiHistoryIssues(source = reachable) {
    if (!source?.root) return [];
    const memoryByFloor = currentMemoryMap(source);
    return source.floors.flatMap(floor => {
      const delta = memoryByFloor.get(floor.id)?.qianshiDelta, review = delta?.historyReview;
      return delta?.status === 'partial' && review?.rawFingerprint === floor.content.rawFingerprint
        && review.candidates.length && review.candidates.every(candidate => candidate.decision !== 'pending')
        ? [{ floorId: floor.id, assistantSeq: floor.assistantSeq, canAcceptCurrent: delta.status === 'partial',
          reconciliationStatus: review.reconciliationStatus,
          message: review.reconciliationStatus === 'partial' && review.reconciliationReason
            ? review.reconciliationReason : delta.reason || '已审候选仍待本地核对。' }] : [];
    });
  }

  function qianshiReviewBatchFloors(batchId, source = reachable) {
    if (!batchId || !source?.root) return [];
    const memoryByFloor = currentMemoryMap(source);
    return source.floors.filter(floor => {
      const review = memoryByFloor.get(floor.id)?.qianshiDelta?.historyReview;
      return review?.batchId === batchId && review.rawFingerprint === floor.content.rawFingerprint;
    }).map(floor => floor.id);
  }

  function qianshiReviewBatchReady(batchId, source = reachable) {
    const floorIds = qianshiReviewBatchFloors(batchId, source), memoryByFloor = currentMemoryMap(source);
    return floorIds.length > 0 && floorIds.every(floorId => {
      const review = memoryByFloor.get(floorId)?.qianshiDelta?.historyReview;
      return review?.candidates?.length > 0 && review.candidates.every(candidate => candidate.decision !== 'pending');
    }) ? floorIds : [];
  }

  function qianshiSnapshot() {
    if (!reachable?.root) return Object.freeze({ status: 'not-ready', message: '千事后端尚未准备好当前聊天。' });
    const history = { ...qianshiHistoryState, pendingReviews: persistentQianshiHistoryReviews(),
      persistedIssues: persistentQianshiHistoryIssues() };
    const snapshot = qianshiSnapshotMemo(reachable, identityProjection, history);
    const referenceFloorsByEvent = new Map(snapshot.events.map(event => [event.id, new Set()]));
    for (const event of snapshot.events) for (const id of event.continuesFromEventIds ?? []) referenceFloorsByEvent.get(id)?.add(event.sourceAssistantSeq);
    for (const relation of snapshot.relations) {
      referenceFloorsByEvent.get(relation.fromEventId)?.add(snapshot.events.find(event => event.id === relation.toEventId)?.sourceAssistantSeq);
      referenceFloorsByEvent.get(relation.toEventId)?.add(snapshot.events.find(event => event.id === relation.fromEventId)?.sourceAssistantSeq);
    }
    for (const review of snapshot.history.pendingReviews) for (const event of review.events) {
      event.recommendedEvent = snapshot.events.find(item => item.id === event.recommendedEventId) ?? null;
      if (event.recommendedEvent) {
        const refs = [...(referenceFloorsByEvent.get(event.recommendedEventId) ?? [])].filter(Number.isSafeInteger).sort((a, b) => a - b);
        event.recommendedEvent.referenceCount = refs.length;
        event.recommendedEvent.referenceAssistantSeqs = refs;
      }
    }
    return snapshot;
  }

  async function qianshiHistoryPriorEvidence(source, floor, memory, review, { userAcceptedCurrent = false } = {}) {
    if (userAcceptedCurrent) {
      const delta = memory.qianshiDelta;
      if (delta?.status !== 'partial' || !review.candidates.length
        || review.candidates.some(candidate => candidate.decision === 'pending')) return { reason: '本楼仍有未完成审阅，不能按当前结果结案。' };
      const active = (source.floorMemories ?? []).filter(value => value.recordStatus === 'active'
        && ['ready', 'partial'].includes(value.qianshiDelta?.status));
      const eventLists = active.map(value => value.qianshiDelta.events), allEvents = new Map();
      for (const events of eventLists) for (const event of events) {
        const existing = allEvents.get(event.id);
        if (existing && JSON.stringify(existing) !== JSON.stringify(event)
          && (existing.sourceFloorId === floor.id || event.sourceFloorId === floor.id)) {
          return { reason: '本楼事件标识与当前图中的另一条事件冲突，保持部分状态。' };
        }
        if (!existing) allEvents.set(event.id, event);
      }
      if (delta.events.some(event => event.continuesFromEventIds.some(id => !allEvents.has(id)))) {
        return { reason: '本楼事件仍有失效的续接目标，保持部分状态。' };
      }
      const targetRelations = new Set(delta.relations.map(relation => relation.id));
      const relationSignatures = new Map();
      const orderEdges = [];
      const pathExists = (from, to) => {
        const seen = new Set(), stack = [from];
        while (stack.length) {
          const current = stack.pop();
          if (current === to) return true;
          if (seen.has(current)) continue;
          seen.add(current);
          for (const edge of orderEdges) if (edge.from === current) stack.push(edge.to);
        }
        return false;
      };
      for (const value of active) for (const relation of value.qianshiDelta.relations) {
        const signature = JSON.stringify([relation.type, relation.fromEventId, relation.toEventId]);
        const previous = relationSignatures.get(relation.id);
        if (previous && previous.signature !== signature && (previous.floorId === floor.id || value.floorId === floor.id)) {
          return { reason: '本楼关系标识与当前图中的另一条关系冲突，保持部分状态。' };
        }
        if (!previous) relationSignatures.set(relation.id, { signature, floorId: value.floorId });
        const from = allEvents.get(relation.fromEventId), to = allEvents.get(relation.toEventId);
        const invalid = !from || !to || relation.type === 'progress'
          && (!from.matterId || from.matterId !== to.matterId || !to.updatesMatter);
        if (invalid) {
          if (value.floorId === floor.id) return { reason: '本楼仍有失效关系端点或进展语义，保持部分状态。' };
          continue;
        }
        if (relation.type === 'before') {
          if (pathExists(relation.toEventId, relation.fromEventId)) {
            if (value.floorId === floor.id && targetRelations.has(relation.id)) return { reason: '本楼仍有不可排序的先后关系，保持部分状态。' };
          } else orderEdges.push({ from: relation.fromEventId, to: relation.toEventId });
        }
      }
      const currentEvents = new Map(delta.events.map(event => [event.id, event]));
      const currentRelations = new Map(delta.relations.map(relation => [relation.id, relation]));
      const allEventIds = new Set(allEvents.keys());
      for (const candidate of review.candidates) {
        const candidateRelations = candidate.relations ?? [];
        if (candidate.decision === 'duplicate') {
          if (currentEvents.has(candidate.candidateId) || candidateRelations.some(relation => currentRelations.has(relation.id))) {
            return { reason: '已标为重复的候选仍有独立事件或关系入账，保持部分状态。' };
          }
          continue;
        }
        const saved = currentEvents.get(candidate.candidateId);
        if (!saved || JSON.stringify(saved) !== JSON.stringify(candidate.event)) {
          return { reason: '已接纳的新事件没有按待审版本完整保存，保持部分状态。' };
        }
        if (candidate.event.continuesFromEventIds.some(id => !allEventIds.has(id) || !saved.continuesFromEventIds.includes(id))) {
          return { reason: '已接纳事件的原续接目标缺失或未入账，保持部分状态。' };
        }
        for (const relation of candidateRelations) if (!allEventIds.has(relation.fromEventId) || !allEventIds.has(relation.toEventId)
          || JSON.stringify(currentRelations.get(relation.id)) !== JSON.stringify(relation)) {
          return { reason: '已接纳事件的候选关系端点或关系记录未完整入账，保持部分状态。' };
        }
      }
      return { priorStatus: delta.status, priorReason: delta.reason };
    }
    let prior = null, priorId = memory.supersedes, seen = new Set();
    for (let depth = 0; priorId && depth < 32; depth += 1) {
      if (seen.has(priorId)) return { reason: '旧版记录链存在循环，无法证明冲突前状态。' };
      seen.add(priorId);
      const record = await store.readRecord('floorMemory', priorId);
      if (record?.status !== 'ready' || !record.data) return { reason: '找不到冲突前的旧版千事记录，无法证明此前已完整。' };
      const candidate = record.data;
      if (candidate.chatId !== source.root.chatId || candidate.narrativeGeneration !== source.root.narrativeGeneration
        || candidate.floorId !== floor.id || candidate.recordType !== 'floorMemory') {
        return { reason: '冲突前记录与当前聊天、正文楼或分支不一致，无法证明此前已完整。' };
      }
      if (!candidate.sourceRawFingerprint || candidate.sourceCanonicalContent === undefined || candidate.sourceCanonicalContent === null) {
        return { reason: '冲突前记录缺少完整正文来源标记，无法证明它与当前楼相同。' };
      }
      if (candidate.sourceRawFingerprint !== floor.content.rawFingerprint
        || candidate.sourceCanonicalContent !== floor.content.canonicalContent) {
        return { reason: '冲突前记录的正文来源与当前楼不同，不能结清部分状态。' };
      }
      const priorReview = candidate.qianshiDelta?.historyReview;
      const sameReview = priorReview?.rawFingerprint === review.rawFingerprint
        && JSON.stringify(priorReview.candidates?.map(item => item.candidateId) ?? [])
          === JSON.stringify(review.candidates.map(item => item.candidateId));
      if (review.priorMemoryId && candidate.id === review.priorMemoryId) { prior = candidate; break; }
      if (review.priorMemoryId && !sameReview) return { reason: '历史审阅版本链没有连到记录的冲突前版本，无法证明此前已完整。' };
      if (!review.priorMemoryId && !sameReview) { prior = candidate; break; }
      priorId = candidate.supersedes;
    }
    if (!prior) return { reason: '旧版记录链超出核对范围，无法证明冲突前状态。' };
    const delta = prior.qianshiDelta;
    if (!delta || !['ready', 'empty'].includes(delta.status)) {
      return { reason: delta?.status === 'partial' && delta.reason
        ? `冲突前千事记录已经部分完成：${delta.reason}` : '冲突前千事记录不是已完整状态，不能结清部分状态。' };
    }
    if (review.priorStatus === 'partial' && review.priorReason !== delta.reason) {
      return { reason: review.priorReason
        ? `本轮历史编译还有未完成项：${review.priorReason}` : '本轮历史编译结果为部分完成，不能仅凭候选决定结清。' };
    }
    const priorByFloor = new Map((source.floorMemories ?? []).map(value => [value.floorId, value]));
    const baseline = { ...source, floorMemories: source.floorMemories.map(value => value.floorId === floor.id ? prior : value) };
    let before, current;
    try { before = projectQianshiGraph(baseline).diagnostics; current = projectQianshiGraph(source).diagnostics; }
    catch { return { reason: '冲突前或当前千事关系图无法通过结构核对。' }; }
    const graphHasFaults = diagnostics => diagnostics.degradedFloorIds.length
      || diagnostics.danglingRelationIds.length || diagnostics.danglingContinuationIds.length
      || diagnostics.discardedOrderRelations.length;
    if (graphHasFaults(before) || graphHasFaults(current)) {
      return { reason: '冲突前或当前千事图仍有断链、失效进展或不可排序关系，不能证明本楼已完整。' };
    }
    const currentMemory = priorByFloor.get(floor.id);
    const currentDelta = currentMemory?.qianshiDelta;
    if (!currentDelta || currentDelta.historyReview?.rawFingerprint !== review.rawFingerprint) {
      return { reason: '当前楼记录与待核对正文版本不一致，未结清部分状态。' };
    }
    const currentEvents = new Map(currentDelta.events.map(event => [event.id, event]));
    const currentRelations = new Map(currentDelta.relations.map(relation => [relation.id, relation]));
    if (delta.events.some(event => JSON.stringify(currentEvents.get(event.id)) !== JSON.stringify(event))
      || delta.relations.some(relation => JSON.stringify(currentRelations.get(relation.id)) !== JSON.stringify(relation))) {
      return { reason: '候选复核改动或遗漏了冲突前已保存的事件、关系，仍需保留部分状态。' };
    }
    const allEventIds = new Set(projectQianshiGraph(source).events.map(event => event.id));
    for (const candidate of review.candidates) {
      const candidateRelations = candidate.relations ?? [];
      if (candidate.decision === 'pending') return { reason: '仍有千事候选未完成审阅，暂不核对批次。' };
      if (candidate.decision === 'duplicate') {
        if (currentEvents.has(candidate.candidateId) || candidateRelations.some(relation => currentRelations.has(relation.id))) {
          return { reason: '已标为重复的候选仍有独立事件或关系入账，不能判为完整。' };
        }
        continue;
      }
      const saved = currentEvents.get(candidate.candidateId);
      if (!saved || JSON.stringify(saved) !== JSON.stringify(candidate.event)) {
        return { reason: '已接纳的新事件没有按待审版本完整保存。' };
      }
      if (candidate.event.continuesFromEventIds.some(id => !allEventIds.has(id) || !saved.continuesFromEventIds.includes(id))) {
        return { reason: '已接纳事件的原续接目标缺失或未入账。' };
      }
      for (const relation of candidateRelations) {
        if (!allEventIds.has(relation.fromEventId) || !allEventIds.has(relation.toEventId)
          || JSON.stringify(currentRelations.get(relation.id)) !== JSON.stringify(relation)) {
          return { reason: '已接纳事件的候选关系端点或关系记录未完整入账。' };
        }
      }
    }
    return { priorStatus: delta.status, priorReason: delta.reason };
  }

  async function reconcileQianshiHistoryFloors(floorIds, { operation = null, onProgress = null, batchId = null,
    userAcceptedCurrent = false, expectedItems = null } = {}) {
    const ownedOperation = !operation;
    if (ownedOperation) {
      if (qianshiHistoryRun) return { outcomes: [], skipped: true };
      operation = { jobId: newUuid(), controller: new AbortController() };
      qianshiHistoryRun = operation;
    }
    const outcomes = [];
    const publishOutcome = outcome => {
      const assistantSeq = outcome.assistantSeq ?? reachable?.floors?.find(floor => floor.id === outcome.floorId)?.assistantSeq
        ?? expectedItems?.get(outcome.floorId)?.assistantSeq;
      outcome = Number.isSafeInteger(assistantSeq) ? { ...outcome, assistantSeq } : outcome;
      outcomes.push(outcome); onProgress?.(outcome);
      if (ownedOperation) {
        qianshiHistoryState = Object.freeze({ status: 'running', jobId: operation.jobId, processedFloors: outcomes.length,
          totalFloors: floorIds.length, calls: 0, attemptedFloors: outcomes.length,
          savedCompleteFloors: outcomes.filter(item => item.status === 'saved-complete').length,
          savedPartialFloors: outcomes.filter(item => item.status === 'saved-partial').length,
          conflictFloors: 0, skippedFloors: 0, failedFloors: outcomes.filter(item => item.status === 'failed').length,
          outcomes: [...outcomes], pendingReviews: persistentQianshiHistoryReviews(),
          message: `正在本地核对已审候选；模型 API 调用 0 次（${outcomes.length}/${floorIds.length} 楼）。` });
        notify();
      }
    };
    if (ownedOperation) {
      qianshiHistoryState = Object.freeze({ status: 'running', jobId: operation.jobId, processedFloors: 0,
        totalFloors: floorIds.length, calls: 0, attemptedFloors: 0, savedCompleteFloors: 0,
        savedPartialFloors: 0, conflictFloors: 0, skippedFloors: 0, failedFloors: 0,
        outcomes: [], pendingReviews: persistentQianshiHistoryReviews(), message: '正在恢复已审候选批次的本地核对；不会调用模型 API。' });
      notify();
    }
    try {
      for (const floorId of [...new Set(floorIds)]) {
        if (operation.controller.signal.aborted) break;
        try {
          await loadCurrent(epoch);
          const source = reachable, floor = source?.floors?.find(value => value.id === floorId);
          const memory = floor && currentMemoryMap(source).get(floorId), review = memory?.qianshiDelta?.historyReview;
          if (!floor || !memory || !review || review.rawFingerprint !== floor.content.rawFingerprint
            || userAcceptedCurrent && (memory.qianshiDelta?.status !== 'partial' || !review.candidates.length
              || review.candidates.some(candidate => candidate.decision === 'pending'))
            || expectedItems && (expectedItems.get(floorId)?.memoryId !== memory.id
              || expectedItems.get(floorId)?.rawFingerprint !== floor.content.rawFingerprint)
            || review.candidates.some(candidate => candidate.decision === 'pending')
            || batchId && review.batchId !== batchId) {
            publishOutcome({ floorId, status: 'failed', reasonCode: 'QIANSHI_HISTORY_RECONCILE_STALE',
              message: '楼层、正文或候选批次已经变化；原记录保留。' }); continue;
          }
          if (!userAcceptedCurrent && ['ready', 'partial'].includes(review.reconciliationStatus)) {
            publishOutcome({ floorId, status: review.reconciliationStatus === 'ready' ? 'saved-complete' : 'saved-partial',
              reasonCode: review.reconciliationStatus === 'partial' ? 'QIANSHI_HISTORY_RECONCILE_PARTIAL' : null,
              message: review.reconciliationReason || memory.qianshiDelta.reason || '本楼已完成本地核对。' }); continue;
          }
          const evidence = await qianshiHistoryPriorEvidence(source, floor, memory, review, { userAcceptedCurrent });
          const isComplete = !evidence.reason;
          const nextStatus = isComplete ? (memory.qianshiDelta.events.length ? 'ready' : 'empty') : 'partial';
          const reason = evidence.reason ?? null;
          const delta = validateQianshiDelta({ ...memory.qianshiDelta, status: nextStatus, reason,
            compiledAt: nowIso(now), historyReview: { ...review,
              reconciliationStatus: isComplete ? 'ready' : 'partial', reconciliationReason: reason,
              ...(isComplete && userAcceptedCurrent ? { closureBasis: 'userAcceptedCurrent' } : {}) } }, { floorId });
          const nowValue = nowIso(now), replacement = validateFloorMemory({ ...memory,
            id: await deterministicUuid(['qianshi-history-reconciliation-v1', memory.id, delta]),
            qianshiDelta: delta, updatedAt: nowValue, supersedes: memory.id }, { expectedChatId: memory.chatId });
          const dependencySnapshot = await extractorDependencySnapshot(source, floorId, {
            userIdentity: currentUserIdentity(), promptGuidance: '', identityProjectionSnapshot: await readIdentityProjection() });
          const commitOperation = { floorId, floorRawFingerprint: floor.content.rawFingerprint, epoch,
            controller: operation.controller, runId: await deterministicUuid(['qianshi-history-reconcile-commit-v1', operation.jobId, floorId]),
            startedAt: nowValue, commitTimestamp: nowValue, dependencySnapshot,
            qianshiHistoryReconcileSnapshot: { memoryId: memory.id, review: JSON.stringify(review),
              events: JSON.stringify(memory.qianshiDelta.events), relations: JSON.stringify(memory.qianshiDelta.relations) } };
          await commitRevision(commitOperation, { oldReachable: source, replacement, newEntities: [],
            provenanceEntry: { ...(floorProvenance(source)[floorId] ?? {}), qianshiHistoryReconciliation: operation.jobId },
            action: 'qianshiHistoryReconcile', validationErrors: [] });
          publishOutcome({ floorId, status: isComplete ? 'saved-complete' : 'saved-partial',
            reasonCode: isComplete ? null : 'QIANSHI_HISTORY_RECONCILE_PARTIAL',
            message: reason || '候选、事件与关系均已本地核对，状态已结清。' });
        } catch (error) {
          if (error?.name === 'AbortError' || operation.controller.signal.aborted) break;
          publishOutcome({ floorId, status: 'failed', reasonCode: error?.code ?? 'QIANSHI_HISTORY_RECONCILE_FAILED',
            message: safeErrorMessage(error?.message ?? '本地核对失败；原状态保留，可继续核对。') });
        }
      }
      return { outcomes };
    } finally {
      if (ownedOperation && qianshiHistoryRun === operation) {
        const failed = outcomes.some(item => item.status === 'failed'), partial = outcomes.some(item => item.status === 'saved-partial');
        qianshiHistoryState = Object.freeze({ status: failed || partial ? 'partial' : 'completed', jobId: operation.jobId,
          processedFloors: outcomes.length, totalFloors: floorIds.length, calls: 0,
          attemptedFloors: outcomes.length, savedCompleteFloors: outcomes.filter(item => item.status === 'saved-complete').length,
          savedPartialFloors: outcomes.filter(item => item.status === 'saved-partial').length,
          conflictFloors: 0, skippedFloors: 0, failedFloors: outcomes.filter(item => item.status === 'failed').length,
          outcomes, pendingReviews: persistentQianshiHistoryReviews(),
          message: failed ? '本地核对已继续处理其他楼；失败楼保留原记录，可再次核对。'
            : partial ? '本地核对完成；未能证明完整的楼仍保留部分状态并显示原因。' : '本地零 API 核对完成。' });
        qianshiHistoryRun = null; notify();
      }
    }
  }

  async function resumeQianshiHistoryReconciliations() {
    const batchIds = [...new Set((reachable?.floorMemories ?? []).map(memory => memory.qianshiDelta?.historyReview)
      .filter(review => review?.batchId && review.reconciliationStatus === 'pending')
      .map(review => review.batchId))];
    for (const batchId of batchIds) {
      const floorIds = qianshiReviewBatchReady(batchId);
      if (floorIds.length) await reconcileQianshiHistoryFloors(floorIds, { batchId });
    }
  }

  async function prepareQianshiReviewedClose() {
    if (qianshiHistoryRun || workRun || active) throw errorWith('QIANSHI_HISTORY_RUNNING', '当前有千事或记忆任务运行，请稍后重试。');
    const foundation = await foundationRuntime.inspect('qianshiReviewedClosePreview', { allowCached: false });
    if (foundation.status !== 'ready') throw errorWith('V3_MEMORY_FOUNDATION_NOT_READY', '后端数据尚未与当前正文完成同步。');
    const source = foundationRuntime.getReachable();
    if (!source?.root || source.status !== 'ready') throw errorWith('QIANSHI_HISTORY_UNAVAILABLE', '当前聊天没有可用的后端快照。');
    const memoryByFloor = currentMemoryMap(source), items = [];
    for (const floor of source.floors) {
      const memory = memoryByFloor.get(floor.id), delta = memory?.qianshiDelta, review = delta?.historyReview;
      if (delta?.status !== 'partial' || !review || review.rawFingerprint !== floor.content.rawFingerprint
        || !review.candidates.length || review.candidates.some(candidate => candidate.decision === 'pending')) continue;
      items.push({ floorId: floor.id, assistantSeq: floor.assistantSeq, memoryId: memory.id,
        rawFingerprint: floor.content.rawFingerprint });
    }
    const planId = await deterministicUuid(['qianshi-reviewed-close-plan-v1', source.root.chatId,
      source.root.narrativeGeneration, source.root.headCheckpointId, source.rootRevision, items]);
    qianshiReviewedClosePlan = { planId, chatId: source.root.chatId, narrativeGeneration: source.root.narrativeGeneration,
      headCheckpointId: source.root.headCheckpointId, rootRevision: source.rootRevision,
      rootSourceFingerprint: source.root.sourceSnapshotFingerprint, items };
    return structuredClone({ status: items.length ? 'ready' : 'empty', planId, totalFloors: items.length,
      apiCalls: 0, modelFloors: 0, assistantSeqs: items.map(item => item.assistantSeq) });
  }

  async function startQianshiReviewedClose(planId = qianshiReviewedClosePlan?.planId) {
    if (qianshiHistoryRun || workRun || active) throw errorWith('QIANSHI_HISTORY_RUNNING', '当前有千事或记忆任务运行，请稍后重试。');
    const plan = qianshiReviewedClosePlan;
    if (!plan || planId !== plan.planId || !plan.items.length) throw errorWith('QIANSHI_HISTORY_PLAN_STALE', '请重新准备已审楼结案计划。');
    await loadCurrent(epoch);
    if (reachable?.root?.chatId !== plan.chatId || reachable.root.narrativeGeneration !== plan.narrativeGeneration
      || reachable.root.sourceSnapshotFingerprint !== plan.rootSourceFingerprint
      || reachable.root.headCheckpointId !== plan.headCheckpointId || reachable.rootRevision !== plan.rootRevision) {
      throw errorWith('QIANSHI_HISTORY_PLAN_STALE', '聊天、分支、正文或后端记录已变化；请重新准备结案计划。');
    }
    qianshiReviewedClosePlan = null;
    return reconcileQianshiHistoryFloors(plan.items.map(item => item.floorId), { userAcceptedCurrent: true,
      expectedItems: new Map(plan.items.map(item => [item.floorId, item])) });
  }

  async function prepareQianshiHistory({ maxInputTokens = QIANSHI_HISTORY_INPUT_TOKENS, maxOutputTokens = QIANSHI_HISTORY_OUTPUT_TOKENS } = {}) {
    if (qianshiHistoryRun) throw errorWith('QIANSHI_HISTORY_RUNNING', '千事历史补齐正在运行。');
    if (typeof foundationRuntime.inspect !== 'function' || typeof foundationRuntime.getReachable !== 'function') {
      throw errorWith('V3_MEMORY_FOUNDATION_NOT_READY', '当前后端不支持只读预览，请稍后重试。');
    }
    const foundation = await foundationRuntime.inspect('qianshiHistoryPreview', { allowCached: false });
    if (foundation.status !== 'ready') throw errorWith('V3_MEMORY_FOUNDATION_NOT_READY', '后端数据尚未与当前正文完成同步。');
    const previewReachable = foundationRuntime.getReachable();
    if (!previewReachable?.root || previewReachable.status !== 'ready') throw errorWith('QIANSHI_HISTORY_UNAVAILABLE', '当前聊天没有可用的后端快照。');
    const safeInput = Math.max(4000, Math.min(200000, Math.floor(Number(maxInputTokens) || QIANSHI_HISTORY_INPUT_TOKENS)));
    const safeOutput = Math.max(1000, Math.min(30000, Math.floor(Number(maxOutputTokens) || QIANSHI_HISTORY_OUTPUT_TOKENS)));
    const memoryByFloor = currentMemoryMap(previewReachable), items = [], unavailable = [];
    const aggregateSkippedFloors = [];
    const qianshiProjection = projectQianshiGraph(previewReachable);
    const degradedFloorIds = new Set(qianshiProjection.diagnostics.degradedFloorIds);
    for (const floor of previewReachable.floors) {
      const memory = memoryByFloor.get(floor.id);
      if (!memory) { unavailable.push({ floorId: floor.id, assistantSeq: floor.assistantSeq }); continue; }
      const repairDelta = degradedFloorIds.has(floor.id) ? repairableQianshiDelta(previewReachable, memory, nowIso(now)) : null;
      const storedReview = memory.qianshiDelta?.historyReview;
      if (storedReview?.rawFingerprint === floor.content.rawFingerprint && storedReview.candidates.length) {
        if (storedReview.candidates.every(candidate => candidate.decision !== 'pending')
          && memory.qianshiDelta.status === 'partial'
          && storedReview.reconciliationStatus === undefined) {
          items.push({ floorId: floor.id, assistantSeq: floor.assistantSeq, rawFingerprint: floor.content.rawFingerprint,
            memoryId: memory.id, repairDelta, localRepairOnly: true, reconciliationOnly: true });
          continue;
        }
        if (repairDelta) items.push({ floorId: floor.id, assistantSeq: floor.assistantSeq, rawFingerprint: floor.content.rawFingerprint,
          memoryId: memory.id, repairDelta, localRepairOnly: true });
        continue;
      }
      const aggregate = memorySourceFloorIds(memory).length > 1;
      if (['ready', 'empty'].includes(memory.qianshiDelta?.status) && !repairDelta
        && !(degradedFloorIds.has(floor.id) && memory.qianshiDelta?.status === 'ready')) continue;
      if (aggregate) aggregateSkippedFloors.push({ floorId: floor.id, assistantSeq: floor.assistantSeq });
      if (aggregate && !repairDelta) continue;
      const sourceCanonicalContent = memory.sourceCanonicalContent || floor.content.canonicalContent;
      const input = { floorKey: `floor-${floor.assistantSeq}`, assistantSeq: floor.assistantSeq, sourceCanonicalContent,
        sourceUserInputSnapshot: memory.sourceUserInputSnapshot ?? null,
        effectiveSummary: effectiveSummary(memory) || '', existingStatus: memory.qianshiDelta?.status ?? 'unprocessed' };
      items.push({ floorId: floor.id, assistantSeq: floor.assistantSeq, rawFingerprint: floor.content.rawFingerprint,
        memoryId: memory.id, repairDelta, localRepairOnly: aggregate, input });
    }
    const hasReconciliationItems = items.some(item => item.reconciliationOnly);
    const deferredItems = hasReconciliationItems ? items.filter(item => !item.reconciliationOnly) : [];
    if (hasReconciliationItems) {
      const reconciliationItems = items.filter(item => item.reconciliationOnly);
      items.splice(0, items.length, ...reconciliationItems);
    }
    const batches = [], budgetSkippedFloors = [];
    const estimateBatch = batchItems => qianshiHistoryInputTokens(qianshiHistoryBudgetRequest(batchItems.map(item => item.input)));
    for (const item of items.filter(value => !value.localRepairOnly)) {
      const singleFloorEstimate = estimateBatch([item]);
      if (singleFloorEstimate > safeInput) { item.budgetExceeded = true; budgetSkippedFloors.push({ floorId: item.floorId, assistantSeq: item.assistantSeq, estimatedInputTokens: singleFloorEstimate }); continue; }
      const last = batches.at(-1), proposedItems = [...(last?.items ?? []), item], proposedEstimate = estimateBatch(proposedItems);
      if (!last || (last.items.length && proposedEstimate > safeInput)) batches.push({ items: [item], tokenEstimate: singleFloorEstimate });
      else { last.items.push(item); last.tokenEstimate = proposedEstimate; }
    }
      const planId = await deterministicUuid(['qianshi-history-plan-v1', previewReachable.root.chatId, previewReachable.root.narrativeGeneration,
      previewReachable.root.headCheckpointId, items.map(item => [item.floorId, item.memoryId]), safeInput, safeOutput]);
    qianshiHistoryPlan = { planId, chatId: previewReachable.root.chatId, narrativeGeneration: previewReachable.root.narrativeGeneration,
      headCheckpointId: previewReachable.root.headCheckpointId, rootRevision: previewReachable.rootRevision,
      rootSourceFingerprint: previewReachable.root.sourceSnapshotFingerprint, maxInputTokens: safeInput, maxOutputTokens: safeOutput,
      items, batches, unavailable, aggregateSkippedFloors, budgetSkippedFloors };
    const localRepairFloors = items.filter(item => item.repairDelta).length;
    const modelFloors = batches.reduce((sum, batch) => sum + batch.items.length, 0);
    const reconciliationFloors = items.filter(item => item.reconciliationOnly).length;
    return structuredClone({ status: items.length ? 'ready' : 'empty', planId, totalFloors: items.length, batchCount: batches.length, apiCalls: batches.length,
      localRepairFloors, modelFloors,
      reconciliationFloors,
      localReconciliationOnly: hasReconciliationItems,
      deferredFloors: deferredItems.length,
      deferredModelFloors: deferredItems.filter(item => item.input && !item.localRepairOnly).length,
      estimatedInputTokens: batches.reduce((sum, batch) => sum + batch.tokenEstimate, 0), maxInputTokens: safeInput, maxOutputTokens: safeOutput,
      unavailableFloors: unavailable, budgetSkippedFloors, aggregateSkippedFloors, batches: batches.map((batch, index) => ({ index, floorCount: batch.items.length,
        assistantSeqs: batch.items.map(item => item.assistantSeq), estimatedInputTokens: batch.tokenEstimate })) });
  }

  async function startQianshiHistory(planId = qianshiHistoryPlan?.planId) {
    if (qianshiHistoryRun) return structuredClone(qianshiHistoryState);
    if (!qianshiHistoryPlan || planId !== qianshiHistoryPlan.planId) throw errorWith('QIANSHI_HISTORY_PLAN_STALE', '请重新准备千事历史补齐计划。');
    const plan = qianshiHistoryPlan, controller = new AbortController(), jobId = await deterministicUuid(['qianshi-history-job-v1', plan.planId, newUuid()]);
    const operation = { jobId, controller };
    let processedFloors = 0, calls = 0;
    qianshiHistoryRun = operation;
    const publishHistory = value => {
      if (qianshiHistoryRun !== operation) return false;
      qianshiHistoryState = Object.freeze(value); notify(); return true;
    };
    const outcomes = new Map(plan.items.map(item => [item.floorId, { floorId: item.floorId, assistantSeq: item.assistantSeq,
      status: item.budgetExceeded ? 'skipped' : 'skipped', reasonCode: item.budgetExceeded ? 'QIANSHI_HISTORY_INPUT_BUDGET' : null,
      message: item.budgetExceeded ? '完整请求超过输入预算；未调用模型。' : '等待处理。' }]));
    const pendingReviews = [];
    const historyState = (status, message = '') => {
      const rows = [...outcomes.values()].sort((left, right) => left.assistantSeq - right.assistantSeq);
      return { status, jobId, processedFloors, totalFloors: plan.items.length, calls,
        attemptedFloors: rows.filter(row => row.attempted).length,
        savedCompleteFloors: rows.filter(row => row.status === 'saved-complete').length,
        savedPartialFloors: rows.filter(row => row.status === 'saved-partial').length,
        conflictFloors: rows.filter(row => row.status === 'conflict-review').length,
        skippedFloors: rows.filter(row => row.status === 'skipped').length,
        failedFloors: rows.filter(row => row.status === 'failed').length,
        outcomes: rows.map(row => ({ ...row })), pendingReviews: persistentQianshiHistoryReviews(), message };
    };
      const setOutcome = (floorId, status, reasonCode, message, attempted = null) => {
      const row = outcomes.get(floorId);
      if (!row) return;
      row.status = status; row.reasonCode = reasonCode ?? null; row.message = message ?? '';
      if (attempted !== null) row.attempted = attempted;
      };
    qianshiHistoryState = Object.freeze(historyState('running', '正在重新读取并核对当前聊天与千事存档…'));
    notify();
    const task = (async () => {
      let failures = 0, staleCandidateFloors = 0;
      const repairFailures = new Set(), repairedFloorIds = new Set();
      let expectedHeadCheckpointId = plan.headCheckpointId, expectedRootRevision = plan.rootRevision;
      publishHistory(historyState('running', '正在重新读取并核对当前聊天与千事存档…'));
      await loadCurrent(epoch);
      if (reachable?.root?.chatId !== plan.chatId || reachable.root.narrativeGeneration !== plan.narrativeGeneration
        || reachable.root.sourceSnapshotFingerprint !== plan.rootSourceFingerprint
        || reachable.root.headCheckpointId !== expectedHeadCheckpointId || reachable.rootRevision !== expectedRootRevision) {
        throw errorWith('QIANSHI_HISTORY_PLAN_STALE', '聊天、分支或来源正文已经变化，历史补齐已停止。');
      }
      if (plan.items.some(value => value.repairDelta)) publishHistory(historyState('running', '正在本地修整已确认失效关系（不调用模型）…'));
      for (const item of plan.items.filter(value => value.repairDelta)) {
        if (controller.signal.aborted) break;
        const floor = reachable.floors.find(value => value.id === item.floorId), memory = currentMemoryMap(reachable).get(item.floorId);
        const currentRepair = memory && repairableQianshiDelta(reachable, memory, item.repairDelta.compiledAt);
        const sameRepair = currentRepair && JSON.stringify({ ...currentRepair, compiledAt: null }) === JSON.stringify({ ...item.repairDelta, compiledAt: null });
        if (!floor || !memory || memory.id !== item.memoryId || floor.content.rawFingerprint !== item.rawFingerprint || !sameRepair) {
          failures += 1; repairFailures.add(item.floorId); setOutcome(item.floorId, 'failed', 'QIANSHI_HISTORY_REPAIR_STALE', '本地关系修整输入已变化，原记录保留。'); item.repairDelta = null; continue;
        }
        const nowValue = nowIso(now), id = await deterministicUuid(['v3-qianshi-repair-memory', memory.id, currentRepair, plan.planId]);
        const replacement = validateFloorMemory({ ...memory, id, qianshiDelta: currentRepair, updatedAt: nowValue, supersedes: memory.id }, { expectedChatId: memory.chatId });
        const dependencySnapshot = await extractorDependencySnapshot(reachable, floor.id, { userIdentity: currentUserIdentity(), promptGuidance: '', identityProjectionSnapshot: await readIdentityProjection() });
        const commitOperation = { floorId: floor.id, floorRawFingerprint: floor.content.rawFingerprint, epoch, controller,
          runId: await deterministicUuid(['v3-qianshi-repair-commit', plan.planId, floor.id]), startedAt: nowValue,
          commitTimestamp: nowValue, dependencySnapshot };
        try {
          await commitRevision(commitOperation, { oldReachable: reachable, replacement, newEntities: [],
            provenanceEntry: { ...(floorProvenance(reachable)[floor.id] ?? {}), qianshiRepairPlanId: plan.planId },
            action: 'qianshiRepair', validationErrors: [] });
          item.memoryId = replacement.id;
          if (item.input) item.input.existingStatus = 'partial';
          repairedFloorIds.add(item.floorId);
          setOutcome(item.floorId, 'saved-partial', null, '已在本地隔离确证失效关系。');
          expectedHeadCheckpointId = reachable.root.headCheckpointId; expectedRootRevision = reachable.rootRevision;
        } catch (error) { failures += 1; repairFailures.add(item.floorId); setOutcome(item.floorId, 'failed', error?.code ?? 'QIANSHI_HISTORY_REPAIR_FAILED', safeErrorMessage(error?.message ?? '本地关系修整失败。')); item.repairDelta = null; }
      }
      const reconciliationItems = plan.items.filter(value => value.reconciliationOnly && !repairFailures.has(value.floorId));
      if (reconciliationItems.length) {
        publishHistory(historyState('running', `正在本地核对 ${reconciliationItems.length} 楼已审候选（不调用模型）…`));
        await reconcileQianshiHistoryFloors(reconciliationItems.map(item => item.floorId), { operation,
          onProgress: outcome => {
            setOutcome(outcome.floorId, outcome.status, outcome.reasonCode, outcome.message, true);
            if (outcome.status === 'failed' || outcome.status === 'saved-partial') failures += 1;
            processedFloors += 1;
            expectedHeadCheckpointId = reachable.root.headCheckpointId; expectedRootRevision = reachable.rootRevision;
            publishHistory(historyState('running', `已完成 ${processedFloors}/${plan.items.length} 楼本地核对；模型 API 调用 0 次。`));
          } });
      }
      for (const [batchIndex, batch] of plan.batches.entries()) {
        if (controller.signal.aborted) break;
        publishHistory(historyState('running', `正在重新核对第 ${batchIndex + 1}/${plan.batches.length} 批来源正文与存档…`));
        await loadCurrent(epoch);
        if (reachable?.root?.chatId !== plan.chatId || reachable.root.narrativeGeneration !== plan.narrativeGeneration
          || reachable.root.sourceSnapshotFingerprint !== plan.rootSourceFingerprint
          || (calls === 0 && (reachable.root.headCheckpointId !== expectedHeadCheckpointId || reachable.rootRevision !== expectedRootRevision))) {
          throw errorWith('QIANSHI_HISTORY_PLAN_STALE', '聊天、分支或来源正文已经变化，历史补齐已停止。');
        }
        publishHistory(historyState('running', `正在准备第 ${batchIndex + 1}/${plan.batches.length} 批候选…`));
        const identitySnapshot = await readIdentityProjection();
        const prepared = [];
        const preparedEventMap = new Map(projectQianshiGraph(reachable).events.map(event => [event.id, event]));
        for (const item of batch.items) {
          if (repairFailures.has(item.floorId)) continue;
          const floor = reachable.floors.find(value => value.id === item.floorId), memory = currentMemoryMap(reachable).get(item.floorId);
          if (!floor || !memory || floor.content.rawFingerprint !== item.rawFingerprint || memory.id !== item.memoryId) { failures += 1; setOutcome(item.floorId, 'failed', 'QIANSHI_HISTORY_FLOOR_STALE', '楼层摘要或正文已变化，本楼跳过。'); continue; }
          const floorIndex = reachable.floors.findIndex(value => value.id === floor.id), prefixFloors = reachable.floors.slice(0, floorIndex);
          const prefixIds = new Set(prefixFloors.map(value => value.id));
          const candidates = prepareQianshiCandidates({ ...reachable, floors: prefixFloors,
            floorMemories: reachable.floorMemories.filter(value => prefixIds.has(value.floorId)) },
          { canonicalContent: item.input.sourceCanonicalContent, precedingUserInput: item.input.sourceUserInputSnapshot,
            identityProjection: identitySnapshot, includeEventContextCandidates: true });
          const dependencySnapshot = await extractorDependencySnapshot(reachable, floor.id, { userIdentity: currentUserIdentity(), promptGuidance: '', identityProjectionSnapshot: identitySnapshot });
          prepared.push({ item, floor, memory, candidates, dependencySnapshot });
        }
        if (!prepared.length) continue;
        const sharedCandidates = [], sharedCandidateBySignature = new Map(), candidateKeysByFloor = new Map(), bindingsByFloor = new Map();
        const buildHistoryRequest = () => ({ task: 'extractQianshiHistoryV1', qianshiCandidates: sharedCandidates,
          floors: prepared.map(value => ({ ...value.item.input, qianshiCandidateKeys: candidateKeysByFloor.get(value.item.floorId) ?? [] })) });
        for (const value of prepared) {
          const floorKeys = [], floorBindings = [];
          candidateKeysByFloor.set(value.item.floorId, floorKeys); bindingsByFloor.set(value.item.floorId, floorBindings);
          for (const [index, candidate] of value.candidates.request.entries()) {
            const binding = value.candidates.bindings[index];
            if (!binding) continue;
            const { key: _localCandidateKey, ...candidateValue } = candidate;
            const signature = JSON.stringify({ candidate: candidateValue, matterId: binding.matterId, latestEventIds: binding.latestEventIds });
            const semanticEventIds = [...new Set([binding.originEventId, ...(binding.latestEventIds ?? [])].filter(Boolean))];
            const semanticSignatures = Object.fromEntries(semanticEventIds.map(id => [id,
              preparedEventMap.has(id) ? qianshiEventSemanticSignature(preparedEventMap.get(id)) : null]));
            let shared = sharedCandidateBySignature.get(signature), added = false;
            if (!shared) {
              const key = `candidate-${sharedCandidates.length + 1}`;
              shared = { key, candidate: { key, ...candidateValue }, binding: { ...binding, key } };
              sharedCandidateBySignature.set(signature, shared); sharedCandidates.push(shared.candidate); added = true;
            }
            floorKeys.push(shared.key); floorBindings.push({ ...shared.binding, semanticSignatures });
            if (qianshiHistoryInputTokens(buildHistoryRequest()) > plan.maxInputTokens) {
              floorKeys.pop(); floorBindings.pop();
              if (added) { sharedCandidates.pop(); sharedCandidateBySignature.delete(signature); }
            }
          }
        }
        const request = buildHistoryRequest();
        const systemPrompt = QIANSHI_HISTORY_SYSTEM_PROMPT;
        const requestTokens = qianshiHistoryInputTokens(request);
        if (requestTokens > plan.maxInputTokens) {
          failures += prepared.length;
          for (const value of prepared) setOutcome(value.item.floorId, 'failed', 'QIANSHI_HISTORY_INPUT_BUDGET',
            `完整请求估算 ${requestTokens} token，超过 ${plan.maxInputTokens}；未调用模型。`, false);
          publishHistory(historyState('running', '完整请求超出输入预算，未调用模型。'));
          continue;
        }
        let packet = null;
        try {
          calls += 1;
          for (const value of prepared) setOutcome(value.item.floorId, 'skipped', null, '模型请求已发出，等待逐楼结果。', true);
          publishHistory(historyState('running', `正在调用第 ${batchIndex + 1}/${plan.batches.length} 批模型任务…`));
          const result = await generateUtilityTask({ systemPrompt, taskMessages: [{ role: 'user', content: JSON.stringify(request) }],
            maxTokens: plan.maxOutputTokens, temperature: 0, signal: controller.signal, includeCharacterCard: false, worldInfoSource: 'none', parseMode: 'semantic' });
          const finishReason = result?.taskMetadata?.finishReason;
          packet = result?.jsonData ?? result?.data
            ?? (typeof result?.responseText === 'string' ? parseJsonOutput(result.responseText, { finishReason }) : null)
            ?? (typeof result?.textData === 'string' ? parseJsonOutput(result.textData, { finishReason }) : null);
        } catch (error) {
          if (error?.name === 'AbortError' || controller.signal.aborted) break;
          failures += prepared.length;
          for (const value of prepared) setOutcome(value.item.floorId, 'failed', error?.code ?? 'QIANSHI_HISTORY_BATCH_FAILED', safeErrorMessage(error?.message), true);
          publishHistory(historyState('running', `一批返回无法解析，已保留原记录：${safeErrorMessage(error?.message)}`));
          continue;
        }
        if (!packet || typeof packet !== 'object' || Array.isArray(packet) || !Array.isArray(packet.floors)) {
          failures += prepared.length;
          for (const value of prepared) setOutcome(value.item.floorId, 'failed', 'QIANSHI_HISTORY_RESPONSE_SHAPE', '批响应缺少楼层列表；本批原记录保持不变。', true);
          publishHistory(historyState('running', '批响应结构无效，已保留原记录。'));
          continue;
        }
        const responseCounts = new Map();
        for (const entry of packet.floors) {
          const key = String(entry?.floorKey ?? '');
          responseCounts.set(key, (responseCounts.get(key) ?? 0) + 1);
        }
        const returnedByKey = new Map(packet.floors.map(value => [String(value?.floorKey ?? ''), value]));
        const earlierBindings = [], changedMatterIds = new Set(), changedEventIds = new Set();
        for (const value of prepared) {
          if (controller.signal.aborted) break;
          const returned = returnedByKey.get(value.item.input.floorKey);
          const responseCount = responseCounts.get(value.item.input.floorKey) ?? 0;
          if (responseCount !== 1) {
            failures += 1;
            setOutcome(value.item.floorId, 'failed', responseCount ? 'QIANSHI_HISTORY_FLOOR_DUPLICATE' : 'QIANSHI_HISTORY_FLOOR_MISSING',
              responseCount ? '批响应重复返回本楼，已保留原记录。' : '批响应漏回本楼，已保留原记录。', true);
            continue;
          }
          const rawEvents = Array.isArray(returned?.qianshi?.events) ? returned.qianshi.events : Array.isArray(returned?.events) ? returned.events : [];
          const usedCandidateKeys = new Set([...rawEvents.flatMap(event => [
            ...(Array.isArray(event?.links) ? event.links.map(link => String(link?.candidateKey ?? link?.candidate ?? '')) : []),
            ...(Array.isArray(event?.continues) ? event.continues.map(String) : []),
            ...(Array.isArray(event?.continuesCandidates) ? event.continuesCandidates.map(String) : []),
            ...(Array.isArray(event?.relatedCandidates) ? event.relatedCandidates.map(String) : []),
          ]), ...(Array.isArray(returned?.qianshi?.order) ? returned.qianshi.order.flatMap(relation => typeof relation === 'string'
            ? [relation] : [relation?.before, relation?.after]) : [])].filter(Boolean));
          const liveEvents = new Map(projectQianshiGraph(reachable).events.map(event => [event.id, event]));
          const frozenBindingsStale = (bindingsByFloor.get(value.item.floorId) ?? []).some(binding => usedCandidateKeys.has(binding.key)
            && Object.entries(binding.semanticSignatures ?? {}).some(([id, signature]) => {
              const event = liveEvents.get(id);
              return !event || !signature || qianshiEventSemanticSignature(event) !== signature
                || (binding.matterId !== null && id !== binding.originEventId
                  && (event.matterId !== binding.matterId || !event.updatesMatter));
            }));
          const earlierBindingStale = earlierBindings.some(binding => usedCandidateKeys.has(binding.key)
            && (binding.stale || (binding.latestEventIds ?? []).some(id => {
              const event = liveEvents.get(id);
              return !event || (binding.kind === 'matter' && (event.matterId !== binding.matterId || !event.updatesMatter))
                || qianshiEventSemanticSignature(event) !== binding.semanticSignature;
            })));
          const staleCandidate = frozenBindingsStale || earlierBindingStale;
          if (staleCandidate) {
            failures += 1; staleCandidateFloors += 1;
            setOutcome(value.item.floorId, 'failed', 'QIANSHI_HISTORY_CANDIDATE_STALE', '本批实际引用的前楼事项语义已变化，本楼原记录保留。', true);
            publishHistory(historyState('running', '前楼事项在本批处理中发生变化，已停止受影响楼；请重新准备计划。'));
            continue;
          }
          let delta, compiledBindings = [];
          try {
            delta = await compileQianshiDelta({ packet: returned ?? null, floor: value.floor,
              candidateBindings: [...(bindingsByFloor.get(value.item.floorId) ?? []), ...earlierBindings],
              candidateStats: { count: (bindingsByFloor.get(value.item.floorId) ?? []).length,
                characters: sharedCandidates.filter(candidate => (candidateKeysByFloor.get(value.item.floorId) ?? []).includes(candidate.key))
                  .map(candidate => JSON.stringify(candidate)).join('\n').length },
              entities: reachable.entities, identityProjection: identitySnapshot, compiledBindings, now: nowIso(now) });
          } catch (error) { failures += 1; setOutcome(value.item.floorId, 'failed', error?.code ?? 'QIANSHI_HISTORY_COMPILE_FAILED', safeErrorMessage(error?.message ?? '千事编译失败。'), true); continue; }
          if (delta.status === 'pending') { failures += 1; setOutcome(value.item.floorId, 'failed', 'QIANSHI_HISTORY_DELTA_PENDING', delta.reason || '千事结果未通过编译。', true); continue; }
          const compiledStatus = delta.status;
          const priorDelta = value.memory.qianshiDelta, priorEvents = priorDelta?.events ?? [];
          const priorEventById = new Map(priorEvents.map(event => [event.id, event]));
          const remappedIds = new Map(), compiledEvents = [];
          for (const sourceEvent of delta.events) {
            const prior = priorEventById.get(sourceEvent.id);
            if (!prior) { compiledEvents.push({ ...sourceEvent }); continue; }
            const sameMeaning = JSON.stringify({ ...prior, id: null }) === JSON.stringify({ ...sourceEvent, id: null });
            if (sameMeaning) { remappedIds.set(sourceEvent.id, null); continue; }
            const aliasId = await deterministicUuid(['qianshi-history-event-alias-v1', value.floor.id, value.item.rawFingerprint, sourceEvent.id, sourceEvent]);
            remappedIds.set(sourceEvent.id, aliasId);
            compiledEvents.push({ ...sourceEvent, id: aliasId,
              ...(sourceEvent.matterId && sourceEvent.updatesMatter && !sourceEvent.continuesFromEventIds.length
                ? { matterId: await deterministicUuid(['qianshi-history-matter-alias-v1', aliasId, sourceEvent.object, sourceEvent.title]) } : {}) });
          }
          for (const event of compiledEvents) event.continuesFromEventIds = event.continuesFromEventIds.map(id => remappedIds.get(id) ?? id).filter(Boolean);
          const remapRelation = async relation => {
            const fromEventId = remappedIds.get(relation.fromEventId) ?? relation.fromEventId;
            const toEventId = remappedIds.get(relation.toEventId) ?? relation.toEventId;
            return { ...relation, id: await deterministicUuid(['qianshi-relation-v1', relation.type, fromEventId, toEventId]), fromEventId, toEventId };
          };
          const compiledRelations = await Promise.all(delta.relations.map(remapRelation));
          for (let bindingIndex = 0; bindingIndex < compiledBindings.length; bindingIndex += 1) {
            const binding = compiledBindings[bindingIndex];
            const sourceId = binding.event.id, mapped = remappedIds.get(sourceId);
            if (mapped === null) compiledBindings[bindingIndex] = { ...binding, event: { ...priorEventById.get(sourceId) } };
            else if (mapped) compiledBindings[bindingIndex] = { ...binding, event: compiledEvents.find(event => event.id === mapped) ?? binding.event };
          }
          const reviews = [];
          const directEvents = [], pendingEventIds = new Set();
          const referencedPriorEventIds = new Set();
          for (const memory of reachable.floorMemories ?? []) if (memory.recordStatus === 'active' && memory.floorId !== value.floor.id) {
            for (const relation of memory.qianshiDelta?.relations ?? []) {
              if (priorEventById.has(relation.fromEventId)) referencedPriorEventIds.add(relation.fromEventId);
              if (priorEventById.has(relation.toEventId)) referencedPriorEventIds.add(relation.toEventId);
            }
            for (const event of memory.qianshiDelta?.events ?? []) for (const id of event.continuesFromEventIds ?? []) {
              if (priorEventById.has(id)) referencedPriorEventIds.add(id);
            }
          }
          for (const event of compiledEvents) {
            const matches = priorEvents.map(old => ({ old, basis: qianshiHistoryMatch(event, old) })).filter(item => item.basis);
            if (!matches.length) { directEvents.push(event); continue; }
            const best = matches.sort((left, right) => right.basis.length - left.basis.length)[0];
            pendingEventIds.add(event.id);
            reviews.push({ candidateId: event.id, decision: 'pending', event,
              relations: compiledRelations.filter(relation => relation.fromEventId === event.id || relation.toEventId === event.id),
              recommendedEventId: best.old.id, matchBasis: best.basis.map(token => `共同词项“${token}”`) });
          }
          const priorRelations = priorDelta?.relations ?? [];
          const mergedRelations = [...priorRelations, ...compiledRelations.filter(relation => !pendingEventIds.has(relation.fromEventId) && !pendingEventIds.has(relation.toEventId))];
          const mergedEvents = [...priorEvents, ...directEvents];
          const reviewReason = reviews.some(review => referencedPriorEventIds.has(review.recommendedEventId))
            ? '存在相似候选待审阅；对应旧事件仍被后楼引用，旧事件及关系已保留。'
            : '存在相似候选待审阅。';
      const nextReview = reviews.length ? { rawFingerprint: value.item.rawFingerprint,
            batchId: jobId, priorMemoryId: value.memory.id, reconciliationStatus: 'pending', reconciliationReason: null,
            priorStatus: compiledStatus === 'partial' || priorDelta?.status === 'partial' ? 'partial' : 'ready',
            priorReason: compiledStatus === 'partial' ? delta.reason : priorDelta?.reason ?? null, candidates: reviews } : undefined;
          const status = reviews.length || delta.status === 'partial' ? 'partial'
            : mergedEvents.length ? 'ready' : 'empty';
          delta = validateQianshiDelta({ ...delta, status,
            reason: status === 'partial' ? String(delta.reason || (reviews.length ? reviewReason : '历史结果仍有未完成项目。')).slice(0, 500) : null,
            candidateStats: delta.candidateStats, events: mergedEvents,
            relations: [...new Map(mergedRelations.map(relation => [relation.id, relation])).values()],
            ...(nextReview ? { historyReview: nextReview } : {}) }, { floorId: value.floor.id });
          const usedBindings = [...(bindingsByFloor.get(value.item.floorId) ?? []), ...earlierBindings]
            .filter(binding => usedCandidateKeys.has(binding.key));
          const qianshiCandidateSnapshot = usedBindings.map(binding => ({ kind: binding.matterId ? 'matter' : 'event',
            matterId: binding.matterId ?? null,
            events: [...new Set([binding.originEventId, ...(binding.latestEventIds ?? [])].filter(Boolean))]
              .map(id => ({ id, signature: binding.semanticSignatures?.[id] ?? binding.semanticSignature ?? null })) }));
          const nowValue = nowIso(now), id = await deterministicUuid(['v3-qianshi-history-memory', value.memory.id, delta, jobId]);
          const replacement = validateFloorMemory({ ...value.memory, id, qianshiDelta: delta, updatedAt: nowValue,
            supersedes: value.memory.id }, { expectedChatId: value.memory.chatId });
          const commitOperation = { floorId: value.floor.id, floorRawFingerprint: value.floor.content.rawFingerprint, epoch,
            controller, qianshiCandidateSnapshot, runId: await deterministicUuid(['v3-qianshi-history-commit', jobId, value.floor.id]), startedAt: nowValue,
            commitTimestamp: null, dependencySnapshot: value.dependencySnapshot };
          try {
            const priorAudit = floorProvenance(reachable)[value.floor.id] ?? {};
            await commitRevision(commitOperation, { oldReachable: reachable, replacement, newEntities: [],
            provenanceEntry: { ...priorAudit, qianshiHistoryJobId: jobId }, action: 'qianshiHistory', validationErrors: [] });
            if (commitOperation.qianshiRejected) {
              failures += 1;
              const reason = commitOperation.qianshiRejectReason || '新事件冲突，旧千事记录已保留。';
              const currentMemory = currentMemoryMap(reachable).get(value.floor.id);
              const currentFloor = reachable.floors.find(item => item.id === value.floor.id);
              const oldDelta = commitOperation.qianshiHistoryPriorDelta ?? currentMemory?.qianshiDelta;
              const reviewEvents = delta.events.filter(event => !(oldDelta?.events ?? []).some(old => old.id === event.id));
              const atomicPartial = !oldDelta?.events?.length || (commitOperation.qianshiHistoryPartialMemoryId
                && currentMemory?.id === commitOperation.qianshiHistoryPartialMemoryId
                && currentMemory.qianshiDelta?.status === 'partial'
                && JSON.stringify(currentMemory.qianshiDelta.events) === JSON.stringify(oldDelta.events)
                && JSON.stringify(currentMemory.qianshiDelta.relations) === JSON.stringify(oldDelta.relations));
              const pendingReview = reviewEvents.length && atomicPartial && currentMemory?.qianshiDelta && currentFloor
                ? { floorId: value.floor.id, assistantSeq: value.floor.assistantSeq,
                  memoryId: currentMemory.id, rawFingerprint: currentFloor.content.rawFingerprint,
                  chatId: reachable.root.chatId, narrativeGeneration: reachable.root.narrativeGeneration,
                  rootSourceFingerprint: reachable.root.sourceSnapshotFingerprint,
                  priorStatus: commitOperation.qianshiHistoryPriorDelta?.status ?? oldDelta?.status ?? 'unprocessed',
                  candidateStatus: delta.status, events: reviewEvents, relations: delta.relations, reason } : null;
              if (pendingReview) pendingReviews.push(pendingReview);
              if (!atomicPartial) setOutcome(value.floor.id, 'failed', 'QIANSHI_HISTORY_COMMIT_AMBIGUOUS',
                `${reason} 冲突后的保存状态待核对；候选事件没有发布为待确认项。`, true);
              else setOutcome(value.floor.id, reviewEvents.length ? 'conflict-review' : 'saved-partial', 'QIANSHI_HISTORY_REPLACEMENT_CONFLICT',
                reviewEvents.length ? reason : `${reason} 没有可供独立确认的新事件；旧锚及依赖它的楼需要后续专门迁移。`, true);
              publishHistory(historyState('running', reason));
              continue;
            }
            processedFloors += 1;
            if (delta.status === 'partial' || reviews.length) failures += 1;
            const committedMatterIds = new Set((value.memory.qianshiDelta?.events ?? []).map(event => event.matterId).filter(Boolean));
            for (const { event } of compiledBindings) if (event.matterId && event.updatesMatter) committedMatterIds.add(event.matterId);
            for (const binding of earlierBindings) if (committedMatterIds.has(binding.matterId)) binding.stale = true;
            for (const event of value.memory.qianshiDelta?.events ?? []) {
              changedEventIds.add(event.id);
              if (event.matterId) changedMatterIds.add(event.matterId);
            }
            const savedEventsById = new Map((currentMemoryMap(reachable).get(value.floor.id)?.qianshiDelta?.events ?? []).map(event => [event.id, event]));
            compiledBindings.forEach(({ localKey, event: candidateEvent }) => {
              const savedEvent = savedEventsById.get(candidateEvent.id);
              if (!savedEvent) return;
              const event = savedEvent;
              if (event.matterId !== null && event.updatesMatter) {
                changedEventIds.add(event.id);
                changedMatterIds.add(event.matterId);
              }
              earlierBindings.push({
              key: `${value.item.input.floorKey}:${localKey}`, kind: event.matterId !== null && event.updatesMatter ? 'matter' : 'event',
              matterId: event.matterId, latestEventIds: [event.id], stale: false,
              semanticSignature: qianshiEventSemanticSignature(event),
              sourceFloorId: event.sourceFloorId, sourceAssistantSeq: value.floor.assistantSeq,
              latestStoryTime: event.storyTime, latestScheduledTime: event.scheduledTime });
            });
            setOutcome(value.item.floorId, reviews.length ? 'conflict-review' : delta.status === 'partial' ? 'saved-partial' : 'saved-complete',
              reviews.length ? 'QIANSHI_HISTORY_SIMILAR_REVIEW' : delta.status === 'partial' ? 'QIANSHI_HISTORY_COMPILE_PARTIAL' : null,
              reviews.length ? '已保存可直接入账的事件；相似候选已持久保存并等待审阅。'
                : delta.reason || (delta.status === 'partial' ? '已保存部分千事结果。' : '千事结果已完整保存。'), true);
          } catch (error) {
            failures += 1;
            if (error?.code === 'QIANSHI_HISTORY_CANDIDATE_STALE') staleCandidateFloors += 1;
            setOutcome(value.item.floorId, 'failed', error?.code ?? 'QIANSHI_HISTORY_COMMIT_FAILED', safeErrorMessage(error?.message ?? '单楼提交失败。'), true);
          }
          publishHistory(historyState('running', failures ? `${failures} 楼未补齐，可重新准备计划后继续。` : ''));
        }
      }
      const stopped = controller.signal.aborted, hasAggregateSkips = plan.aggregateSkippedFloors.length > 0 || plan.budgetSkippedFloors.length > 0;
      const aggregateRepairs = plan.aggregateSkippedFloors.filter(item => repairedFloorIds.has(item.floorId)).length;
      const failedAggregateRepairs = plan.aggregateSkippedFloors.filter(item => repairFailures.has(item.floorId)).length;
      const hasPendingReviews = persistentQianshiHistoryReviews().length > 0;
      staleCandidateFloors = Math.max(staleCandidateFloors,
        [...outcomes.values()].filter(row => row.reasonCode === 'QIANSHI_HISTORY_CANDIDATE_STALE').length);
      const finalStatus = stopped ? 'stopped' : failures || hasAggregateSkips || hasPendingReviews ? 'partial' : 'completed';
      const finalMessage = stopped ? '已停止。'
            : failures || hasAggregateSkips ? `${failures ? `${failures} 楼未补齐。` : ''}${staleCandidateFloors ? '前楼事项在本批处理中发生变化，受影响楼已跳过；请重新准备计划。' : ''}${plan.budgetSkippedFloors.length ? `${plan.budgetSkippedFloors.length} 楼超出完整输入预算，未调用模型。` : ''}${plan.aggregateSkippedFloors.length ? `${plan.aggregateSkippedFloors.length} 楼由多个正文楼聚合，模型替换已跳过以保留成员来源。${aggregateRepairs ? `其中 ${aggregateRepairs} 楼的确证坏引用已在本地隔离。` : ''}${failedAggregateRepairs ? `另有 ${failedAggregateRepairs} 楼本地隔离未成功，原记录保留；请重新准备计划。` : ''}` : ''}`
            : '历史千事补齐完成。';
      if (publishHistory(historyState(finalStatus, finalMessage))) qianshiHistoryPlan = null;
      return structuredClone(qianshiHistoryState);
    })().catch(error => {
      const failedState = historyState(controller.signal.aborted ? 'stopped' : 'failed', controller.signal.aborted ? '已停止。' : safeErrorMessage(error?.message));
      publishHistory(failedState);
      return structuredClone(failedState);
    }).finally(() => { if (qianshiHistoryRun === operation) qianshiHistoryRun = null; notify(); });
    operation.promise = task;
    return task;
  }

  async function stopQianshiHistory() {
    qianshiHistoryRun?.controller.abort('stopped');
    try { await qianshiHistoryRun?.promise; } catch { /* final state is reported below */ }
    return structuredClone(qianshiHistoryState);
  }

  async function confirmQianshiHistoryReview({ floorId, eventId, independent = false } = {}) {
    const preparedReachable = reachable;
    const expectedEpoch = epoch, snapshotReview = qianshiSnapshot().history.pendingReviews.find(item => item.floorId === floorId
      && item.events.some(event => event.id === eventId));
    if (!snapshotReview) throw errorWith('QIANSHI_HISTORY_REVIEW_STALE', '这条待审候选已处理或当前会话已变化。');
    const controller = new AbortController();
    const preparedFloor = preparedReachable?.floors?.find(item => item.id === floorId);
    const preparedMemory = preparedReachable && currentMemoryMap(preparedReachable).get(floorId);
    const preparedReview = preparedMemory?.qianshiDelta?.historyReview;
    const preparedSnapshotMatches = preparedReachable?.status === 'ready'
      && preparedReachable.root?.chatId === snapshotReview.chatId
      && preparedReachable.root?.narrativeGeneration === snapshotReview.narrativeGeneration
      && preparedReachable.root?.sourceSnapshotFingerprint === snapshotReview.rootSourceFingerprint
      && preparedFloor?.content.rawFingerprint === snapshotReview.rawFingerprint
      && preparedReview?.rawFingerprint === snapshotReview.rawFingerprint
      && preparedReview.candidates.some(candidate => candidate.candidateId === eventId && candidate.decision === 'pending');
    const canProbePreparedRoot = preparedSnapshotMatches && typeof store.readRoot === 'function'
      && expectedEpoch === epoch && currentHostChatId() === snapshotReview.chatId;
    if (canProbePreparedRoot) {
      const rootResult = await store.readRoot();
      if (expectedEpoch !== epoch || currentHostChatId() !== snapshotReview.chatId) {
        throw errorWith('QIANSHI_HISTORY_REVIEW_STALE', '聊天或待审楼层已经变化；候选没有保存。');
      }
      if (reachable === preparedReachable && samePreparedRoot(preparedReachable, rootResult)) reachable = preparedReachable;
      else await loadCurrent(expectedEpoch);
    } else await loadCurrent(expectedEpoch);
    const floor = reachable?.floors?.find(item => item.id === floorId), memory = currentMemoryMap(reachable).get(floorId);
    const currentReview = memory?.qianshiDelta?.historyReview;
    if (!floor || !memory || floor.content.rawFingerprint !== snapshotReview.rawFingerprint
      || reachable.root.chatId !== snapshotReview.chatId || reachable.root.narrativeGeneration !== snapshotReview.narrativeGeneration
      || reachable.root.sourceSnapshotFingerprint !== snapshotReview.rootSourceFingerprint
      || currentReview?.rawFingerprint !== floor.content.rawFingerprint) {
      throw errorWith('QIANSHI_HISTORY_REVIEW_STALE', '聊天、正文或待审楼层已经变化；候选没有保存。');
    }
    const savedCandidate = currentReview.candidates.find(candidate => candidate.candidateId === eventId);
    if (!savedCandidate) throw errorWith('QIANSHI_HISTORY_REVIEW_STALE', '持久候选已变化；请刷新后重新查看。');
    if (savedCandidate.decision !== 'pending') return structuredClone(qianshiSnapshot().history);
    const pendingCandidates = currentReview.candidates.filter(candidate => candidate.candidateId !== eventId && candidate.decision === 'pending');
    const projection = projectQianshiGraph(reachable), liveEvents = new Map(projection.events.map(event => [event.id, event]));
    let events = [...memory.qianshiDelta.events], relations = [...memory.qianshiDelta.relations];
    let incompleteRelation = false;
    if (independent) {
      const candidate = savedCandidate.event;
      const continuationIds = candidate.continuesFromEventIds.filter(id => liveEvents.has(id));
      events.push({ ...candidate, continuesFromEventIds: continuationIds });
      const validCandidateRelations = savedCandidate.relations.filter(relation =>
        liveEvents.has(relation.fromEventId) || relation.fromEventId === eventId
          ? liveEvents.has(relation.toEventId) || relation.toEventId === eventId : false);
      relations.push(...validCandidateRelations);
    }
    const candidates = currentReview.candidates.map(candidate => candidate.candidateId === eventId
      ? { ...candidate, decision: independent ? 'new' : 'duplicate' } : candidate);
    const allResolved = !pendingCandidates.length;
    const savedEventIds = new Set([...liveEvents.keys(), ...events.map(event => event.id)]);
    const savedRelationIds = new Set(relations.map(relation => relation.id));
    for (const candidate of candidates.filter(value => value.decision === 'new')) {
      const savedEvent = events.find(value => value.id === candidate.candidateId);
      if (!savedEvent || candidate.event.continuesFromEventIds.some(id => !savedEventIds.has(id)
        || !savedEvent.continuesFromEventIds.includes(id)) || candidate.relations.some(relation =>
        !savedEventIds.has(relation.fromEventId) || !savedEventIds.has(relation.toEventId) || !savedRelationIds.has(relation.id))) {
        incompleteRelation = true;
        break;
      }
    }
    const status = allResolved && !incompleteRelation ? currentReview.priorStatus : 'partial';
    const reason = incompleteRelation ? '已保存的独立事件仍有关系端点或关系未入账，本楼保持部分状态。' : currentReview.priorReason;
    const delta = validateQianshiDelta({ ...memory.qianshiDelta, status,
      reason: status === 'partial' ? String(reason || '仍有待处理的历史补齐项目。').slice(0, 500) : null,
      compiledAt: nowIso(now), events, relations: [...new Map(relations.map(relation => [relation.id, relation])).values()],
      historyReview: { ...currentReview, candidates } }, { floorId });
    const replacementId = await deterministicUuid(['qianshi-history-review-decision-v1', memory.id, eventId, independent, delta]);
    let replacement = validateFloorMemory({ ...memory, id: replacementId, qianshiDelta: delta,
      updatedAt: nowIso(now), supersedes: memory.id }, { expectedChatId: memory.chatId });
    const projectedAfterDecision = { ...reachable, floorMemories: reachable.floorMemories.map(item =>
      item.floorId === floorId ? replacement : item) };
    if (allResolved && status !== 'partial' && projectQianshiGraph(projectedAfterDecision).diagnostics.degradedFloorIds.includes(floorId)) {
      const incompleteDelta = validateQianshiDelta({ ...delta, status: 'partial',
        reason: '用户决定已保存，但本楼关系图仍有断链；请检查千事关系后再继续。' }, { floorId });
      replacement = validateFloorMemory({ ...replacement, id: await deterministicUuid(['qianshi-history-review-incomplete-graph-v1', replacementId]),
        qianshiDelta: incompleteDelta, updatedAt: nowIso(now), supersedes: memory.id }, { expectedChatId: memory.chatId });
    }
    const dependencySnapshot = await extractorDependencySnapshot(reachable, floorId, {
      userIdentity: currentUserIdentity(), promptGuidance: '', identityProjectionSnapshot: await readIdentityProjection() });
    const operation = { floorId, floorRawFingerprint: floor.content.rawFingerprint, epoch: expectedEpoch, controller,
      runId: await deterministicUuid(['v3-qianshi-history-review-commit-v2', floorId, eventId, independent, currentReview.rawFingerprint]),
      startedAt: nowIso(now), dependencySnapshot };
    const expectedCheckpointBefore = reachable.root.headCheckpointId;
    try {
      await commitRevision(operation, { oldReachable: reachable, replacement, newEntities: [],
        provenanceEntry: { ...(floorProvenance(reachable)[floorId] ?? {}), qianshiHistoryReviewFingerprint: currentReview.rawFingerprint },
        action: 'qianshiHistoryReview', validationErrors: [] });
    } catch (error) {
      try {
        const cold = await store.readReachable({ mode: 'runtime' });
        const saved = currentMemoryMap(cold).get(floorId), decision = saved?.qianshiDelta?.historyReview?.candidates
          ?.find(candidate => candidate.candidateId === eventId)?.decision;
        const savedGraph = projectQianshiGraph(cold);
        const confirmed = cold.status === 'ready' && cold.root?.chatId === snapshotReview.chatId
          && cold.root?.sourceSnapshotFingerprint === snapshotReview.rootSourceFingerprint
          && cold.root?.headCheckpointId !== expectedCheckpointBefore && decision === (independent ? 'new' : 'duplicate')
          && saved?.qianshiDelta?.historyReview?.rawFingerprint === snapshotReview.rawFingerprint
          && (!independent || savedGraph.events.some(item => item.id === eventId));
    if (!confirmed) throw error;
        reachable = cold;
      } catch {
        throw errorWith('QIANSHI_HISTORY_COMMIT_AMBIGUOUS', '保存状态尚未能从后端读回确认；候选保持待核对，请刷新后查看，不要重复点击。');
      }
    }
    if (operation.qianshiRejected) throw errorWith('QIANSHI_HISTORY_REVIEW_CONFLICT', operation.qianshiRejectReason || '当前完整图不接受此变更；候选决定没有保存。');
    const outcomeMessage = independent ? '已将候选保存为新事件。' : '已保存“这是重复，不保存”的决定；旧事件保持不变。';
    const savedDelta = currentMemoryMap(reachable).get(floorId)?.qianshiDelta;
    const hasPendingReview = savedDelta?.historyReview?.candidates?.some(candidate => candidate.decision === 'pending') === true;
    const outcomes = (qianshiHistoryState.outcomes ?? []).map(outcome => outcome.floorId !== floorId || outcome.status !== 'conflict-review' || hasPendingReview ? outcome : {
      ...outcome, status: savedDelta?.status === 'partial' ? 'saved-partial' : 'saved-complete',
      reasonCode: savedDelta?.status === 'partial' ? 'QIANSHI_HISTORY_COMPILE_PARTIAL' : null,
      message: savedDelta?.reason || outcomeMessage,
    });
    const counts = {
      savedCompleteFloors: outcomes.filter(outcome => outcome.status === 'saved-complete').length,
      savedPartialFloors: outcomes.filter(outcome => outcome.status === 'saved-partial').length,
      conflictFloors: outcomes.filter(outcome => outcome.status === 'conflict-review').length,
      skippedFloors: outcomes.filter(outcome => outcome.status === 'skipped').length,
      failedFloors: outcomes.filter(outcome => outcome.status === 'failed').length,
    };
    const historyStatus = qianshiHistoryState.status === 'partial' && !counts.failedFloors && !counts.conflictFloors
      && !counts.skippedFloors && !counts.savedPartialFloors && !persistentQianshiHistoryReviews().length ? 'completed' : qianshiHistoryState.status;
    qianshiHistoryState = Object.freeze({ ...qianshiHistoryState, ...counts, outcomes,
      status: historyStatus, message: outcomeMessage });
    notify();
    const batchId = currentReview.batchId, batchFloors = batchId ? qianshiReviewBatchReady(batchId) : [];
    if (batchFloors.length && batchFloors.some(id => currentMemoryMap(reachable).get(id)?.qianshiDelta?.historyReview?.reconciliationStatus === 'pending')) {
      void reconcileQianshiHistoryFloors(batchFloors, { batchId }).catch(error => {
        logger.warn?.('[ST-QianQianJie] 千事审阅批次本地核对失败', safeErrorMessage(error?.message));
      });
    }
    return structuredClone(qianshiSnapshot().history);
  }

  return Object.freeze({ bind, start, setEnabled, refreshAutomation, startHistoricalRebuild, pauseHistoricalRebuild, retryAutomation, rebuildCse, resumeCseRebuild, pauseCseRebuild, invalidate, refreshStatus, prepareCurrent, confirmLatest, confirmConsecutiveAssistants, extractNext, extractFloor, analyzeNextState, retryStateAnalysis, correctSubjectState, editSummary, editMemory, restoreAi, markError, copySafeDiagnostic, copyFullDiagnostic, shouldBlockMainGeneration, allowsRealtimeTailFromEmpty, setIdentityProjection,
    getQianshiSnapshot: () => structuredClone(qianshiSnapshot()), getQianshiRecall: ({ queryContext = null, currentTime = null, selectedEventIds = null, selectedMatterIds = null } = {}) => {
      if (!reachable?.root) return { projectionVersion: QIANSHI_RECALL_PROJECTION_VERSION, text: '', eventIds: [], matterIds: [], anchor: null };
      const anchor = { narrativeGeneration: reachable.root.narrativeGeneration, headCheckpointId: reachable.root.headCheckpointId, rootRevision: reachable.rootRevision };
      if (Array.isArray(selectedEventIds) || Array.isArray(selectedMatterIds)) {
        const recall = projectQianshiRecall(reachable, { identityProjection, selectedEventIds: selectedEventIds ?? [], selectedMatterIds: selectedMatterIds ?? [] });
        return structuredClone({ ...recall, anchor });
      }
      const prepared = prepareQianshiRecallCandidates(reachable, { queryContext, identityProjection });
      const recall = projectQianshiCandidateSelection(prepared.candidates);
      const storyDate = typeof currentTime?.date === 'string' && currentTime.date.trim() ? currentTime.date.trim()
        : typeof currentTime?.raw === 'string' && currentTime.raw.trim() ? currentTime.raw.trim() : '';
      const storyClock = typeof currentTime?.clock === 'string' && currentTime.clock.trim() && !storyDate.includes(currentTime.clock.trim()) ? currentTime.clock.trim() : '';
      return structuredClone({ ...recall, candidates: prepared.candidates, candidateStats: prepared.stats,
        currentStoryTime: [storyDate, storyClock].filter(Boolean).join(' ') || null, anchor });
    },
    prepareQianshiHistory, startQianshiHistory, prepareQianshiReviewedClose, startQianshiReviewedClose,
    stopQianshiHistory, confirmQianshiHistoryReview, getState, subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); } });
}
