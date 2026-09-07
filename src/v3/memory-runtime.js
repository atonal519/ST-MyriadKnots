import { newIdentityUuid, sha256 } from '../identity.js';
import { buildFoundationIndexes } from './foundation-runtime.js';
import { deterministicUuid } from './foundation-domain.js';
import { validateFoundationCheckpoint, validateFoundationRoot, validateFoundationRun } from './foundation-schema.js';
import { runExtractorRequest, createExtractorEnvelope, inferCanonicalCurrentTime, EXTRACTOR_PROMPT_VERSION, EXTRACTOR_VERSION } from './extractor.js';
import { validateEntityRecord, validateFloorMemory } from './memory-schema.js';
import { sanitizeDiagnosticValue, sanitizeSensitiveText, sanitizeTaskMetadata } from './safe-metadata.js';
import { createCseRuntime } from './cse-runtime.js';
import { filterReachableDeltas, replayCurrentState } from './cse-engine.js';
import { validateCseGraph } from './cse-schema.js';
import { assessMemoryCoverageFromHost, diagnosticsWithRealtimeOrigin, realtimeOriginFromReachable } from './memory-coverage.js';
import { selectAssistantMessage } from './foundation-domain.js';
import { parseSharedStoryClock, storyClockSignature } from '../story-clock.js';
import { entitiesThroughFloorIds } from './entity-identity.js';

const EVENTS = Object.freeze(['CHAT_CHANGED', 'CHAT_RENAMED', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED']);
const HISTORY_MUTATION_EVENTS = new Set(['MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED']);
const MANUAL_HISTORY_REASON = 'manualHistoricalRebuild';
const emptyManifest = () => ({ floor: [], entity: [], event: [], claim: [], knowledge: [], episode: [], thread: [], state: [], anchor: [], reverseRef: [] });
const nowIso = now => { const value = now()?.toISOString?.() ?? String(now()); if (!Number.isFinite(Date.parse(value))) throw new TypeError('V3_MEMORY_TIME_INVALID'); return value; };
const hash = async value => `sha256:${await sha256(JSON.stringify(value))}`;
const clone = value => structuredClone(value);
const counts = memory => Object.fromEntries(['chronology', 'locations', 'participants', 'actions', 'observations', 'informationTransfers', 'privateCognition', 'commitments', 'eventFragments', 'exactAnchors', 'openLoops', 'ambiguities', 'cseSignals'].map(field => [field, memory?.[field]?.length ?? 0]));
const effectiveSummary = memory => memory?.summary?.effectiveSource === 'user' ? memory.summary.userText : memory?.summary?.aiText;
export function projectMemoryPersonEntities(entities = []) {
  return Object.freeze(entities
    .filter(entity => entity?.entityType === 'person' && entity.recordStatus === 'active' && entity.status !== 'merged' && entity.status !== 'invalidated')
    .map(entity => Object.freeze({ entityId: entity.id, displayName: entity.displayName, specialRole: entity.specialRole })));
}
const safeApi = value => sanitizeTaskMetadata(value);
const safeErrorMessage = value => sanitizeSensitiveText(value ?? '提取失败，可重试。').slice(0, 500);
const unknownCoverage = total => Object.freeze({ status: 'unknown', completed: 0, total, nextAssistantSeq: null, pendingFloorIds: Object.freeze([]), realtimeProtected: false, hasPartialWork: false, summaryStatus: 'unknown', summaryCompleted: 0, summaryNextAssistantSeq: null, summaryPendingFloorIds: Object.freeze([]), summaryRealtimeProtected: false, summaryHasPartialWork: false });
const emptyCaughtUpCoverage = () => Object.freeze({ status: 'caughtUp', completed: 0, total: 0, nextAssistantSeq: null, pendingFloorIds: Object.freeze([]), realtimeProtected: true, hasPartialWork: false, summaryStatus: 'caughtUp', summaryCompleted: 0, summaryNextAssistantSeq: null, summaryPendingFloorIds: Object.freeze([]), summaryRealtimeProtected: true, summaryHasPartialWork: false });
const completedFloorCopy = indexes => indexes.length ? `第 ${indexes.join('、')} 楼` : '楼号未提供';
const normalizedName = value => String(value ?? '').trim().normalize('NFKC').toLocaleLowerCase('zh-Hans-CN');

function errorWith(code, message = code) { const error = new Error(message); error.code = code; return error; }
function currentMemoryMap(reachable) { return new Map((reachable?.floorMemories ?? []).map(memory => [memory.floorId, memory])); }
function floorProvenance(reachable) { return reachable?.run?.diagnostics?.floorProvenance && typeof reachable.run.diagnostics.floorProvenance === 'object' ? clone(reachable.run.diagnostics.floorProvenance) : {}; }
function sameHostLocator(left, right) {
  return left?.messageIndex === right?.messageIndex && left?.swipeId === right?.swipeId && left?.selectedSwipeIndex === right?.selectedSwipeIndex;
}
function currentRawSelection(hostAdapter, floor) {
  if (typeof hostAdapter?.snapshot !== 'function') return null;
  return rawSelectionFromSnapshot(hostAdapter.snapshot(), floor);
}
function rawSelectionFromSnapshot(snapshot, floor) {
  const message = snapshot.chat?.[floor?.hostLocator?.messageIndex];
  const selected = selectAssistantMessage(message);
  if (!selected || !sameHostLocator(floor?.hostLocator, { messageIndex: floor.hostLocator.messageIndex, swipeId: selected.swipeId, selectedSwipeIndex: selected.selectedSwipeIndex })) return null;
  return selected;
}
function clockEvidence(selected) {
  const clock = parseSharedStoryClock(selected?.rawContent);
  if (!clock) return Object.freeze({ clock: null, signature: '', displayText: '' });
  const compact = value => value ? Object.freeze({ raw: value.raw, date: value.date, weekday: value.weekday, time: value.time }) : null;
  const clockValue = Object.freeze({ complete: clock.complete === true, namespace: clock.namespace, start: compact(clock.startMeta), end: compact(clock.endMeta) });
  const part = value => [value?.date, value?.weekday, value?.time].filter(Boolean).join(' ');
  return Object.freeze({
    signature: storyClockSignature(clock),
    clock: clockValue,
    displayText: [...new Set([part(clockValue.start), part(clockValue.end)].filter(Boolean))].join(' → '),
  });
}

const SESSION_CANDIDATE_MAX_ENTRIES = 8;
const SESSION_CANDIDATE_MAX_CHARACTERS = 96000;
const normalizeAutoBatchSize = () => 1;

export function createV3MemoryRuntime({ foundationRuntime, store, hostAdapter, generateUtilityTask, isEnabled = true, automationSettings = () => ({ enabled: false, batchSize: 1 }), notifyUser = null, isMainGenerationActive = () => false, onFullRebuildCommitted = null, extractorPromptGuidance = () => '', csePromptGuidance = () => '', filterWorldInfoSources = sources => sources, sanitizerOptions = () => ({}), now = () => new Date(), newUuid = newIdentityUuid, logger = console } = {}) {
  if (!foundationRuntime || ['start', 'refreshStatus', 'confirmLatest', 'setEnabled', 'bind', 'getState'].some(name => typeof foundationRuntime[name] !== 'function')) throw new TypeError('V3 memory foundation runtime 无效');
  if (!store || ['readReachable', 'readRecord', 'putRecord', 'commitRoot', 'recordKey', 'invalidate'].some(name => typeof store[name] !== 'function')) throw new TypeError('V3 memory store 无效');
  if (typeof generateUtilityTask !== 'function') throw new TypeError('V3 memory utility route 无效');
  let epoch = 0;
  let active = null;
  let reachable = null;
  let lastFailure = null;
  let bound = false;
  let awaitingFoundation = false;
  let foundationReload = null;
  let unsubscribeFoundation = null;
  let workRun = null;
  let autoScheduled = null;
  let autoEpoch = 0;
  let autoTriggerReason = null;
  let lastAutoRun = null;
  let historicalAuthorization = null;
  let formalGenerationActive = false;
  let generationArm = null;
  let tailSwipeContext = null;
  let emptyRealtimeOrigin = null;
  let coverage = unknownCoverage(0);
  let lastAutomaticInputKey = null;
  let lastNoticeKey = null;
  let timeFallbackByFloor = new Map();
  const sessionCandidates = new Map();
  const subscribers = new Set();
  const currentClockSignature = floor => clockEvidence(currentRawSelection(hostAdapter, floor)).signature;
  const cseRuntime = createCseRuntime({ store, hostAdapter, generateUtilityTask, isEnabled, promptGuidance: csePromptGuidance, filterWorldInfoSources, sanitizerOptions, storyClockSignatureForFloor: currentClockSignature, onGraphCommitted: value => foundationRuntime.adoptReachable?.(value), now, newUuid, logger });
  const enabled = () => { try { return (typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true; } catch { return false; } };
  const mainGenerationActive = () => {
    if (formalGenerationActive) return true;
    try { return (typeof isMainGenerationActive === 'function' ? isMainGenerationActive() : isMainGenerationActive) === true; } catch { return false; }
  };
  const currentHostChatId = () => { try { return String(hostAdapter.snapshot()?.context?.chatMetadata?.qianqianjie?.chatId ?? '').trim(); } catch { return ''; } };
  const automation = () => {
    try {
      const value = typeof automationSettings === 'function' ? automationSettings() : automationSettings;
      return Object.freeze({ enabled: value?.enabled === true, batchSize: normalizeAutoBatchSize(value?.batchSize) });
    } catch {
      return Object.freeze({ enabled: false, batchSize: 1 });
    }
  };
  const notify = () => { const snapshot = getState(); for (const listener of subscribers) { try { listener(snapshot); } catch { /* UI listener isolation */ } } return snapshot; };
  const currentInputKey = () => reachable?.root ? `${reachable.root.chatId}:${reachable.root.narrativeGeneration}:${reachable.root.sourceSnapshotFingerprint}` : null;
  const notifyOnce = (key, value) => {
    if (!key || key === lastNoticeKey) return false;
    lastNoticeKey = key;
    try { notifyUser?.(value); } catch { /* notification must not affect memory work */ }
    return true;
  };
  const cancelAutomation = () => {
    autoEpoch += 1;
    autoTriggerReason = null;
    historicalAuthorization = null;
    if (workRun?.kind === 'auto') {
      active?.controller.abort();
      cseRuntime.cancelActive?.();
    }
  };
  const cancelEarlyStabilization = reason => { try { foundationRuntime.cancelEarlyStabilization?.(reason); } catch { /* foundation cancellation is best-effort */ } };
  const invalidate = () => { cancelEarlyStabilization('memoryInvalidated'); cancelAutomation(); epoch += 1; active?.controller.abort(); active = null; workRun = null; reachable = null; timeFallbackByFloor = new Map(); coverage = unknownCoverage(0); emptyRealtimeOrigin = null; formalGenerationActive = false; generationArm = null; tailSwipeContext = null; lastFailure = null; lastAutoRun = null; lastAutomaticInputKey = null; lastNoticeKey = null; awaitingFoundation = false; sessionCandidates.clear(); cseRuntime.invalidate(); notify(); };
  cseRuntime.subscribe(() => notify());
  function runManualWork(reason, task) {
    if (workRun) return Promise.resolve(getState());
    const operation = { kind: 'manual', reason, phase: reason, floorIds: [], promise: null };
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

  function floorState(floor, memoryMap, provenance) {
    const memory = memoryMap.get(floor.id) ?? null;
    const meta = provenance[floor.id] ?? null;
    const running = active?.floorId === floor.id;
    const status = running ? 'running' : memory?.recordStatus === 'active'
      ? 'ready'
      : memory?.recordStatus === 'invalidated' ? 'error'
        : lastFailure?.floorId === floor.id ? 'failed' : 'unprocessed';
    const metadataStale = Boolean(memory && typeof meta?.rawFingerprint === 'string' && meta.rawFingerprint !== floor.content.rawFingerprint);
    const manualTime = meta?.timeEdited === true;
    return Object.freeze({ floorId: floor.id, assistantSeq: floor.assistantSeq, messageIndex: floor.hostLocator.messageIndex, canonicalFingerprint: floor.content.canonicalFingerprint, rawFingerprint: floor.content.rawFingerprint, status, memoryId: memory?.id ?? null, summary: effectiveSummary(memory) ?? '', summarySource: memory?.summary?.effectiveSource ?? null, aiSummary: memory?.summary?.aiText ?? '', revisionNote: memory?.summary?.revisionNote ?? null, extractorVersion: memory?.extractorVersion ?? EXTRACTOR_VERSION, counts: counts(memory), api: meta?.api ?? null, attempts: meta?.attempts ?? 0, runId: meta?.runId ?? null, checkpointId: reachable?.checkpoint?.id ?? null, needsReview: status === 'needsReview', metadataStale, manualTime, timeFallback: timeFallbackByFloor.get(floor.id) ?? '', error: lastFailure?.floorId === floor.id ? lastFailure.message : (metadataStale ? manualTime ? '本楼正文时间戳已变化；人工时间仍保留，重新提取才会替换。' : '本楼正文时间戳已变化，请重新提取以更新本楼时间与后续人物状态。' : memory?.recordStatus === 'invalidated' ? '该楼记忆已标记错误，可重新提取。' : null), memory });
  }
  function getState() {
    const foundation = foundationRuntime.getState();
    const memoryMap = currentMemoryMap(reachable);
    const provenance = floorProvenance(reachable);
    const floors = (reachable?.floors ?? []).map(floor => floorState(floor, memoryMap, provenance));
    const stableCount = floors.length;
    const rememberedCount = floors.filter(item => ['ready', 'needsReview'].includes(item.status)).length;
    const cse = cseRuntime.getState();
    const cseByFloor = new Map((cse.cseFloors ?? []).map(item => [item.floorId, item]));
    const combinedFloors = floors.map(item => Object.freeze({ ...item, cse: cseByFloor.get(item.floorId) ?? null }));
    const memoryEntities = projectMemoryPersonEntities(reachable?.entities ?? []);
    let rebuildCompletedCount = 0;
    for (const floor of combinedFloors) {
      if (!floor.memoryId || floor.cse?.floorMemoryId !== floor.memoryId || !floor.cse?.deltaId) break;
      rebuildCompletedCount += 1;
    }
    const rebuildNextAssistantSeq = combinedFloors[rebuildCompletedCount]?.assistantSeq ?? null;
    const summaryCompletedCount = Math.min(coverage.summaryCompleted ?? rememberedCount, combinedFloors.length);
    const rebuildHasActionableWork = coverage.status !== 'unknown' && coverage.completed < coverage.total;
    const auto = automation();
    const rebuildStatus = workRun?.kind === 'auto' && workRun.mode === 'historical' ? 'rebuilding'
        : lastAutoRun?.status === 'failed' && coverage.status !== 'caughtUp' ? 'failed'
          : lastAutoRun?.status === 'paused' && coverage.status !== 'caughtUp' ? 'paused'
          : coverage.status === 'caughtUp' ? 'caughtUp'
            : coverage.status === 'realtimeTail' ? 'waitingRealtime'
              : coverage.status === 'historicalDebt' ? 'pendingRebuild' : 'notReady';
    return Object.freeze({ ...foundation, ...cse, status: workRun || active || cse.activeCse ? 'running' : foundation.status, stableCount, rememberedCount, summaryCoverageStatus: coverage.summaryStatus, summaryCompletedCount, summaryNextAssistantSeq: coverage.summaryNextAssistantSeq, unprocessedCount: floors.filter(item => ['unprocessed', 'error', 'failed'].includes(item.status)).length, reviewCount: floors.filter(item => item.status === 'needsReview').length, failedCount: floors.filter(item => ['error', 'failed'].includes(item.status)).length, floors: Object.freeze(combinedFloors), memoryEntities, memoryWorkBusy: workRun !== null, activeMemoryWork: workRun ? Object.freeze({ kind: workRun.kind, reason: workRun.reason, phase: workRun.phase, floorIds: Object.freeze([...workRun.floorIds]) }) : null, activeExtraction: active ? { floorId: active.floorId, runId: active.runId, phase: active.phase } : null, lastExtractorError: lastFailure, autoMemoryEnabled: auto.enabled, autoMemoryBatchSize: auto.batchSize, rebuildStatus, rebuildCompletedCount, rebuildTotalCount: combinedFloors.length, rebuildNextAssistantSeq, rebuildHasActionableWork, activeAutoMemory: workRun?.kind === 'auto' ? Object.freeze({ reason: workRun.reason, phase: workRun.phase, mode: workRun.mode ?? 'realtime', floorIds: Object.freeze([...workRun.floorIds]) }) : null, lastAutoMemory: lastAutoRun, promptVersion: EXTRACTOR_PROMPT_VERSION, extractorVersion: EXTRACTOR_VERSION });
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
  async function load(expectedEpoch = epoch, providedReachable = null) {
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
      if (foundation?.status === 'uninitialized' && foundation.stableCount === 0 && chatId) {
        emptyRealtimeOrigin = Object.freeze({ chatId, narrativeGeneration: null });
        coverage = emptyCaughtUpCoverage();
      }
    }
    else throw errorWith('V3_MEMORY_LOAD_FAILED', `记忆图读取失败：${result.status}`);
    if (nextReachable) await cseRuntime.load(nextReachable);
    if (expectedEpoch !== epoch) {
      cseRuntime.invalidate();
      return getState();
    }
    reachable = nextReachable;
    timeFallbackByFloor = new Map();
    if (nextReachable && typeof hostAdapter?.snapshot === 'function') {
      const snapshot = hostAdapter.snapshot();
      for (const floor of nextReachable.floors ?? []) {
        const sameFloorClock = clockEvidence(rawSelectionFromSnapshot(snapshot, floor)).displayText;
        timeFallbackByFloor.set(floor.id, sameFloorClock || inferCanonicalCurrentTime(floor.content?.canonicalContent)?.text || '');
      }
    }
    if (nextReachable) await refreshCoverage(expectedEpoch);
    if (expectedEpoch !== epoch) return getState();
    notify();
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
  async function refreshStatus() {
    const foundation = await foundationRuntime.refreshStatus();
    if (!enabled() || foundation.status === 'disabled') { reachable = null; return notify(); }
    if (!['ready', 'needsReview', 'uninitialized'].includes(foundation.status)) return notify();
    const foundationReachable = foundationRuntime.getReachable?.() ?? null;
    const reusable = !reachable || !foundationReachable
      || Number(foundationReachable.rootRevision ?? 0) >= Number(reachable.rootRevision ?? 0)
      ? foundationReachable
      : null;
    return load(epoch, reusable);
  }
  async function confirmLatest() { await foundationRuntime.confirmLatest(); return load(); }

  async function persistRecords(records, signal) {
    for (const record of records) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const result = await store.putRecord(record, { signal });
      if (!['saved', 'reused'].includes(result.status)) throw errorWith('V3_MEMORY_PERSIST_FAILED', `记忆记录写入失败：${result.status}`);
    }
  }

  async function commitRevision(operation, { oldReachable, replacement, newEntities = [], provenanceEntry, action, validationErrors = [] }) {
    let current = await store.readReachable();
    const foundationCurrent = foundationRuntime.getReachable?.() ?? null;
    if (current.status === 'ready' && foundationCurrent?.rootRevision === current.rootRevision && foundationCurrent?.root?.headCheckpointId === current.root.headCheckpointId) current = { ...current, floors: foundationCurrent.floors };
    if (current.status !== 'ready' || current.rootRevision !== oldReachable.rootRevision || current.root.headCheckpointId !== oldReachable.root.headCheckpointId || current.root.narrativeGeneration !== oldReachable.root.narrativeGeneration) throw errorWith('V3_MEMORY_STALE', '聊天记忆已变化，本次结果不会覆盖新版本。');
    const floor = current.floors.find(item => item.id === replacement.floorId);
    const selected = floor ? currentRawSelection(hostAdapter, floor) : null;
    const liveRawFingerprint = selected ? `sha256:${await sha256(selected.rawContent)}` : null;
    if (!floor || floor.content.canonicalFingerprint !== operation.floorFingerprint || (operation.floorRawFingerprint && (floor.content.rawFingerprint !== operation.floorRawFingerprint || liveRawFingerprint !== operation.floorRawFingerprint))) throw errorWith('V3_MEMORY_STALE', '正文分支或时间戳已变化，本次结果已作废。');
    const memoryByFloor = currentMemoryMap(current); memoryByFloor.set(replacement.floorId, replacement);
    const floorMemories = current.floors.map(item => memoryByFloor.get(item.id)).filter(Boolean);
    const entitiesById = new Map(current.entities.map(entity => [entity.id, entity])); newEntities.forEach(entity => entitiesById.set(entity.id, entity));
    const provisionalDeltas = filterReachableDeltas({ floors: current.floors, floorMemories, stateDeltas: current.stateDeltas ?? [] });
    const stateEntityIds = new Set(provisionalDeltas.flatMap(delta => delta.subjectSnapshots.flatMap(subject => [subject.subjectEntityId, ...subject.adaptive.map(item => item.towardEntityId).filter(Boolean)])));
    const baselineEntityIds = new Set(current.baseline ? [current.baseline.userPersona.entityId, current.baseline.characterCard.entityId] : []);
    const entities = [...entitiesById.values()].filter(entity => current.floors.some(item => item.id === entity.firstSeenFloorId) || floorMemories.some(memory => JSON.stringify(memory).includes(entity.id)) || stateEntityIds.has(entity.id) || baselineEntityIds.has(entity.id));
    const nowValue = nowIso(now);
    const runId = operation.runId;
    const checkpointId = await deterministicUuid(['v3-memory-checkpoint', current.root.headCheckpointId, current.root.narrativeGeneration, action, replacement.id, entities.map(entity => entity.id)]);
    const indexes = await buildFoundationIndexes({ chatId: current.root.chatId, narrativeGeneration: current.root.narrativeGeneration, checkpointId, floors: current.floors, candidates: current.floors.map(floorItem => ({ hostLocator: floorItem.hostLocator, rawFingerprint: floorItem.content.rawFingerprint, canonicalFingerprint: floorItem.content.canonicalFingerprint })), entities, now: nowValue });
    const indexKeys = indexes.map(index => store.recordKey(index));
    const provenance = floorProvenance(current);
    provenance[replacement.floorId] = { ...provenanceEntry, runId, memoryId: replacement.id, action };
    let currentState = null;
    if (current.baseline) currentState = await replayCurrentState({ chatId: current.root.chatId, narrativeGeneration: current.root.narrativeGeneration, baselineId: current.baseline.id, floors: current.floors, floorMemories, stateDeltas: provisionalDeltas, now: nowValue, id: await deterministicUuid(['v3-cse-current-state', checkpointId]), previousId: current.currentStates?.at(-1)?.id ?? null });
    const preparedStateRefs = [...provisionalDeltas.map(delta => store.recordKey(delta)), ...(currentState ? [store.recordKey(currentState)] : [])];
    const run = validateFoundationRun({ schemaVersion: 3, recordType: 'run', id: runId, chatId: current.root.chatId, narrativeGeneration: current.root.narrativeGeneration, parentCheckpointId: current.root.headCheckpointId, inputSnapshotFingerprint: current.root.sourceSnapshotFingerprint, mode: 'localReextract', sessionEpoch: operation.epoch, inputFloorIds: [replacement.floorId], phase: 'completed', completedFloorIds: [replacement.floorId], failedItems: [], preparedRecordRefs: [store.recordKey(replacement), ...newEntities.map(entity => store.recordKey(entity)), ...preparedStateRefs, ...indexKeys, `v3-checkpoint-${checkpointId}`], diagnostics: { ...diagnosticsWithRealtimeOrigin(null, realtimeOriginFromReachable(current)), kind: 'extractor', promptVersion: EXTRACTOR_PROMPT_VERSION, extractorVersion: EXTRACTOR_VERSION, floorProvenance: provenance, validationErrors: validationErrors.slice(-20) }, startedAt: operation.startedAt, createdAt: nowValue, updatedAt: nowValue, recordStatus: 'active', supersedes: null }, { expectedChatId: current.root.chatId });
    const memoryReady = floorMemories.some(memory => memory.recordStatus === 'active');
    const stateFingerprint = await hash([current.root.narrativeGeneration, current.floors.map(item => item.id), current.floors.map(item => item.content.canonicalFingerprint)]);
    const cseReady = memoryReady && floorMemories.filter(memory => memory.recordStatus === 'active').every(memory => provisionalDeltas.some(delta => delta.floorId === memory.floorId && delta.floorMemoryId === memory.id));
    const capabilities = { foundationReady: true, memoryReady, cseReady, recallReady: false };
    const checkpoint = validateFoundationCheckpoint({ schemaVersion: 3, recordType: 'checkpoint', id: checkpointId, chatId: current.root.chatId, narrativeGeneration: current.root.narrativeGeneration, parentCheckpointId: current.root.headCheckpointId, runId, sourceSnapshotFingerprint: current.root.sourceSnapshotFingerprint, capabilities, floorRange: { fromAssistantSeq: current.floors.length ? 1 : 0, toAssistantSeq: current.floors.length, floorIds: current.floors.map(item => item.id) }, inputFingerprints: current.floors.map(item => ({ floorId: item.id, canonicalFingerprint: item.content.canonicalFingerprint })), producedRefs: { floors: current.floors.map(item => item.id), floorMemories: floorMemories.map(item => item.id), entities: entities.map(item => item.id), events: [], claims: [], knowledge: [], stateDeltas: provisionalDeltas.map(item => item.id), currentStates: currentState ? [currentState.id] : [], stateProjections: [], episodes: [], threads: [], indexes: indexKeys }, validation: { schemaValid: true, referencesValid: true, orderedReplayValid: true, stateFingerprint }, sealedAt: nowValue, createdAt: nowValue, updatedAt: nowValue, recordStatus: 'active', supersedes: null }, { expectedChatId: current.root.chatId });
    const root = validateFoundationRoot({ ...current.root, capabilities, headCheckpointId: checkpointId, activeStateRefs: currentState ? [currentState.id] : [], indexManifest: { ...emptyManifest(), floor: indexKeys.filter(key => key.includes('-floorOrder-') || key.includes('-fingerprint-')), entity: indexKeys.filter(key => key.includes('-entity-')), reverseRef: indexKeys.filter(key => key.includes('-reverseRef-')) }, updatedAt: nowValue }, { expectedChatId: current.root.chatId });
    await validateCseGraph({ root, checkpoint, run, floors: current.floors, floorMemories, entities, indexes, indexKeys, baseline: current.baseline, stateDeltas: provisionalDeltas, currentStates: currentState ? [currentState] : [] });
    await persistRecords([...newEntities, replacement, ...(currentState ? [currentState] : []), ...indexes, run, checkpoint], operation.controller.signal);
    if (operation.epoch !== epoch || operation.controller.signal.aborted) throw errorWith('V3_MEMORY_STALE', '操作已取消。');
    const committed = await store.commitRoot(root, current.rootRevision, { signal: operation.controller.signal });
    if (committed.status !== 'saved') throw errorWith(committed.status === 'conflict' ? 'V3_MEMORY_CAS_CONFLICT' : 'V3_MEMORY_COMMIT_FAILED', committed.status === 'conflict' ? '记忆提交遇到并发更新，未覆盖新数据。' : `记忆提交失败：${committed.status}`);
    reachable = await store.readReachable();
    if (reachable.status !== 'ready') throw errorWith('V3_MEMORY_COLD_READ_FAILED', '记忆已提交，但冷读取校验失败。');
    foundationRuntime.adoptReachable?.(reachable);
    lastFailure = null;
    sessionCandidates.delete(replacement.floorId);
    await cseRuntime.load();
    await refreshCoverage(operation.epoch);
    return notify();
  }

  async function persistFailure(operation, error, oldReachable) {
    const details = error?.extractorDiagnostics ?? {};
    if (details.sessionCandidate) rememberSessionCandidate(operation.floorId, details.sessionCandidate);
    lastFailure = Object.freeze({ floorId: operation.floorId, runId: operation.runId, phase: 'retryableError', code: String(error?.code ?? 'V3_EXTRACTOR_FAILED').slice(0, 120), httpStatus: Number.isSafeInteger(details.httpStatus ?? error?.httpStatus ?? error?.status) ? (details.httpStatus ?? error.httpStatus ?? error.status) : null, providerError: sanitizeDiagnosticValue(details.providerError ?? error?.providerError ?? null), formatStage: details.formatStage ?? error?.formatStage ?? null, attempts: details.attempts ?? 1, transportAttempts: details.transportAttempts ?? null, validationErrors: sanitizeDiagnosticValue(details.validationErrors ?? []), api: safeApi(details.metadata ?? error?.taskMetadata), message: safeErrorMessage(error?.message) });
    try {
      const nowValue = nowIso(now);
      const run = validateFoundationRun({ schemaVersion: 3, recordType: 'run', id: operation.runId, chatId: oldReachable.root.chatId, narrativeGeneration: oldReachable.root.narrativeGeneration, parentCheckpointId: oldReachable.root.headCheckpointId, inputSnapshotFingerprint: oldReachable.root.sourceSnapshotFingerprint, mode: 'localReextract', sessionEpoch: operation.epoch, inputFloorIds: [operation.floorId], phase: 'retryableError', completedFloorIds: [], failedItems: [{ floorId: operation.floorId, stage: 'extractor', code: lastFailure.code, retryCount: Math.max(0, lastFailure.attempts - 1) }], preparedRecordRefs: [], diagnostics: { kind: 'extractor', promptVersion: EXTRACTOR_PROMPT_VERSION, extractorVersion: EXTRACTOR_VERSION, floorId: operation.floorId, responseFingerprint: details.responseFingerprint ?? null, api: lastFailure.api, attempts: lastFailure.attempts, transportAttempts: lastFailure.transportAttempts, httpStatus: lastFailure.httpStatus, providerError: lastFailure.providerError, formatStage: lastFailure.formatStage, validationErrors: lastFailure.validationErrors }, startedAt: operation.startedAt, createdAt: nowValue, updatedAt: nowValue, recordStatus: 'staged', supersedes: null }, { expectedChatId: oldReachable.root.chatId });
      await store.putRecord(run, { signal: operation.controller.signal });
    } catch { /* failure audit is best effort; it must never move root */ }
    notify();
  }

  async function extractFloorInternal(floorId, { analyzeState = true } = {}) {
    if (!enabled()) return notify();
    if (active) return getState();
    const foundationBefore = await foundationRuntime.refreshStatus();
    if (foundationBefore.status !== 'ready') throw errorWith('V3_MEMORY_FOUNDATION_NOT_READY', '正文地基尚未完成安全对账，当前不能提取。');
    await loadCurrent(epoch);
    const source = reachable ? clone(reachable) : null;
    const floor = source?.floors?.find(item => item.id === floorId);
    if (!floor) throw errorWith('V3_MEMORY_FLOOR_UNAVAILABLE', '只允许提取当前 root 可达的稳定 AI 楼。');
    const oldMemory = currentMemoryMap(source).get(floor.id) ?? null;
    const selected = currentRawSelection(hostAdapter, floor);
    if (!selected) throw errorWith('V3_MEMORY_STALE', '当前楼或所选重 Roll 已变化，请刷新后重试。');
    const sourceRawFingerprint = `sha256:${await sha256(selected.rawContent)}`;
    if (sourceRawFingerprint !== floor.content.rawFingerprint) throw errorWith('V3_MEMORY_STALE', '当前楼原始正文已变化，请刷新后重试。');
    const sourceClock = clockEvidence(selected);
    const operation = { floorId: floor.id, floorFingerprint: floor.content.canonicalFingerprint, floorRawFingerprint: sourceRawFingerprint, storyClockSignature: sourceClock.signature, epoch, controller: new AbortController(), runId: await deterministicUuid(['v3-extractor-run', source.root.headCheckpointId, floor.id, newUuid()]), startedAt: nowIso(now), phase: 'extracting' };
    active = operation; notify();
    try {
      const userIdentity = typeof hostAdapter?.getUserIdentity === 'function'
        ? hostAdapter.getUserIdentity()
        : hostAdapter?.snapshot?.().userIdentity ?? null;
      const expectedScope = { batchId: operation.runId, chatId: floor.chatId, narrativeGeneration: floor.narrativeGeneration, checkpointId: source.root.headCheckpointId, floorId: floor.id, rawContentFingerprint: sourceRawFingerprint };
      const floorIndex = source.floors.findIndex(item => item.id === floor.id);
      const scopedEntities = entitiesThroughFloorIds(source.entities, new Set(source.floors.slice(0, floorIndex + 1).map(item => item.id)));
      let previousStoryClock = null;
      for (let index = floorIndex - 1; index >= 0 && !previousStoryClock; index -= 1) previousStoryClock = clockEvidence(currentRawSelection(hostAdapter, source.floors[index])).clock;
      const envelope = await createExtractorEnvelope({ ...expectedScope, floor, entities: scopedEntities, userIdentity, identityHints: [], storyClock: sourceClock.clock, previousStoryClock });
      const promptGuidanceSnapshot = typeof extractorPromptGuidance === 'function' ? extractorPromptGuidance() : extractorPromptGuidance;
      const result = await runExtractorRequest({ generateUtilityTask, envelope, floor, existingEntities: scopedEntities, now: nowIso(now), supersedes: oldMemory?.id ?? null, preservedSummary: oldMemory?.summary?.effectiveSource === 'user' ? oldMemory.summary : null, expectedScope, promptGuidance: promptGuidanceSnapshot, signal: operation.controller.signal });
      operation.phase = 'validating'; notify();
      const foundationAfter = await foundationRuntime.refreshStatus();
      if (foundationAfter.status !== 'ready') throw errorWith('V3_MEMORY_STALE', '正文地基在提取期间发生变化，本次结果已作废。');
      if (operation.epoch !== epoch || operation.controller.signal.aborted) throw errorWith('V3_MEMORY_STALE', '聊天或正文已变化，迟到响应已丢弃。');
      operation.phase = 'committing'; notify();
      await commitRevision(operation, { oldReachable: source, replacement: result.memory, newEntities: result.newEntities, provenanceEntry: { api: result.metadata, attempts: result.attempts, transportAttempts: result.transportAttempts, responseFingerprint: result.responseFingerprint, extractorVersion: result.memory.extractorVersion, needsReview: result.needsReview, rawFingerprint: sourceRawFingerprint, storyClockSignature: sourceClock.signature }, action: oldMemory ? 'reextract' : 'extract', validationErrors: result.validationErrors });
      if (analyzeState && !oldMemory && !operation.controller.signal.aborted && operation.epoch === epoch) await cseRuntime.analyzeFloor(floor.id);
    } catch (error) {
      if (error?.name !== 'AbortError' && error?.code !== 'V3_MEMORY_STALE') await persistFailure(operation, error, source);
      else lastFailure = Object.freeze({ floorId: operation.floorId, runId: operation.runId, phase: 'stale', code: 'V3_MEMORY_STALE', attempts: 0, validationErrors: [], api: null, message: '聊天、插件状态或正文分支已变化，迟到结果没有写入。' });
      logger?.warn?.('[qianqianjie] V3 extractor failed', { code: error?.code ?? error?.name ?? 'V3_EXTRACTOR_FAILED' });
    } finally { if (active === operation) active = null; }
    return notify();
  }
  async function extractNextInternal() {
    const foundation = await foundationRuntime.refreshStatus();
    if (foundation.status !== 'ready') throw errorWith('V3_MEMORY_FOUNDATION_NOT_READY', '正文地基尚未完成安全对账，当前不能提取。');
    await loadCurrent(epoch);
    const map = currentMemoryMap(reachable);
    const floor = reachable?.floors?.find(item => map.get(item.id)?.recordStatus !== 'active');
    if (!floor) return getState();
    return extractFloorInternal(floor.id);
  }
  async function reviseInternal(floorId, action, { userText = null, revisionNote = null, metadata = null } = {}) {
    if (active) return getState();
    const foundation = await foundationRuntime.refreshStatus();
    if (foundation.status !== 'ready') throw errorWith('V3_MEMORY_FOUNDATION_NOT_READY', '正文地基尚未完成安全对账，当前不能修订。');
    await loadCurrent(epoch);
    const floor = reachable?.floors?.find(item => item.id === floorId), old = currentMemoryMap(reachable).get(floorId);
    if (!floor || !old) throw errorWith('V3_MEMORY_REVISION_UNAVAILABLE', '该楼还没有可修订的正式记忆。');
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
    const replacement = validateFloorMemory({ ...old, id, summary, chronology, locations, participants, createdAt: nowValue, updatedAt: nowValue, recordStatus: action === 'markError' ? 'invalidated' : 'active', supersedes: old.id }, { expectedChatId: old.chatId });
    const operation = { floorId, floorFingerprint: floor.content.canonicalFingerprint, floorRawFingerprint: floor.content.rawFingerprint, epoch, controller: new AbortController(), runId: revisionRunId, startedAt: nowValue, phase: 'committing' };
    active = operation; notify();
    const priorAudit = floorProvenance(reachable)[floorId] ?? {};
    try { await commitRevision(operation, { oldReachable: reachable, replacement, newEntities, provenanceEntry: { api: priorAudit.api ?? null, attempts: priorAudit.attempts ?? 0, transportAttempts: priorAudit.transportAttempts ?? null, responseFingerprint: priorAudit.responseFingerprint ?? null, extractorVersion: priorAudit.extractorVersion ?? old.extractorVersion, needsReview: priorAudit.needsReview ?? false, rawFingerprint: priorAudit.rawFingerprint ?? floor.content.rawFingerprint, storyClockSignature: priorAudit.storyClockSignature ?? currentClockSignature(floor), timeEdited: priorAudit.timeEdited === true || (action === 'editMetadata' && effectiveTimeChanged) }, action }); }
    finally { active = null; }
    return notify();
  }
  const extractFloor = (floorId, options) => runManualWork('extracting', () => extractFloorInternal(floorId, options));
  const extractNext = () => runManualWork('extracting', () => extractNextInternal());
  const editSummary = (floorId, userText, revisionNote = '') => runManualWork('revising', () => reviseInternal(floorId, 'edit', { userText, revisionNote }));
  const editMemory = (floorId, metadata) => runManualWork('revising', () => reviseInternal(floorId, 'editMetadata', { metadata }));
  const restoreAi = floorId => runManualWork('revising', () => reviseInternal(floorId, 'restoreAi'));
  const markError = floorId => runManualWork('revising', () => reviseInternal(floorId, 'markError'));

  async function resetDerivedGraph({ requestedEpoch = epoch, requestedChatId = currentHostChatId() } = {}) {
    if (!enabled()) return notify();
    if (mainGenerationActive()) throw errorWith('V3_MEMORY_GENERATION_ACTIVE', '主模型正在生成，请等待完成后再完全重构。');
    const resetContextCurrent = () => requestedEpoch === epoch && requestedChatId && currentHostChatId() === requestedChatId;
    if (!resetContextCurrent()) throw errorWith('V3_MEMORY_STALE', '聊天已变化，完全重构未开始。');
    const foundation = await foundationRuntime.refreshStatus();
    if (!resetContextCurrent()) throw errorWith('V3_MEMORY_STALE', '聊天已变化，完全重构未开始。');
    if (foundation.status !== 'ready') throw errorWith('V3_MEMORY_FOUNDATION_NOT_READY', '正文地基尚未完成安全对账，当前不能完全重构。');
    await loadCurrent(requestedEpoch);
    if (!resetContextCurrent()) throw errorWith('V3_MEMORY_STALE', '聊天已变化，完全重构未开始。');
    const source = reachable ? clone(reachable) : null;
    if (!source?.root || !source.checkpoint || source.root.chatId !== requestedChatId) throw errorWith('V3_MEMORY_RESET_UNAVAILABLE', '当前聊天尚无可重构的正文地基。');
    const operation = { floorId: null, floorFingerprint: null, floorRawFingerprint: null, epoch: requestedEpoch, controller: new AbortController(), runId: await deterministicUuid(['v3-full-rebuild-run', source.root.headCheckpointId, newUuid()]), startedAt: nowIso(now), phase: 'resetting' };
    active = operation; notify();
    try {
      const baselineIds = new Set(source.baseline ? [source.baseline.userPersona.entityId, source.baseline.characterCard.entityId] : []);
      const entities = [];
      for (const id of baselineIds) {
        let entity = source.entities.find(item => item.id === id) ?? null;
        if (!entity) { const result = await store.readRecord('entity', id); if (result.status === 'ready') entity = result.data; }
        if (!entity) throw errorWith('V3_MEMORY_BASELINE_ENTITY_MISSING', '基线人物记录缺失，未清空现有记忆。');
        entities.push(entity);
      }
      const checkpointId = await deterministicUuid(['v3-full-rebuild-checkpoint', operation.runId]);
      const nowValue = nowIso(now);
      const candidates = source.floors.map(floor => ({ hostLocator: floor.hostLocator, rawFingerprint: floor.content.rawFingerprint, canonicalFingerprint: floor.content.canonicalFingerprint }));
      const indexes = await buildFoundationIndexes({ chatId: source.root.chatId, narrativeGeneration: source.root.narrativeGeneration, checkpointId, floors: source.floors, candidates, entities, now: nowValue });
      const indexKeys = indexes.map(index => store.recordKey(index));
      const capabilities = { foundationReady: true, memoryReady: false, cseReady: false, recallReady: false };
      const stateFingerprint = await hash([source.root.narrativeGeneration, source.floors.map(item => item.id), source.floors.map(item => item.content.canonicalFingerprint)]);
      const run = validateFoundationRun({ schemaVersion: 3, recordType: 'run', id: operation.runId, chatId: source.root.chatId, narrativeGeneration: source.root.narrativeGeneration, parentCheckpointId: source.root.headCheckpointId, inputSnapshotFingerprint: source.root.sourceSnapshotFingerprint, mode: 'rebuild', sessionEpoch: operation.epoch, inputFloorIds: source.floors.map(item => item.id), phase: 'completed', completedFloorIds: [], failedItems: [], preparedRecordRefs: [...entities.map(entity => store.recordKey(entity)), ...indexKeys, `v3-checkpoint-${checkpointId}`], diagnostics: { kind: 'fullRebuild', floorProvenance: {} }, startedAt: operation.startedAt, createdAt: nowValue, updatedAt: nowValue, recordStatus: 'active', supersedes: null }, { expectedChatId: source.root.chatId });
      const checkpoint = validateFoundationCheckpoint({ schemaVersion: 3, recordType: 'checkpoint', id: checkpointId, chatId: source.root.chatId, narrativeGeneration: source.root.narrativeGeneration, parentCheckpointId: source.root.headCheckpointId, runId: operation.runId, sourceSnapshotFingerprint: source.root.sourceSnapshotFingerprint, capabilities, floorRange: { fromAssistantSeq: source.floors.length ? 1 : 0, toAssistantSeq: source.floors.length, floorIds: source.floors.map(item => item.id) }, inputFingerprints: source.floors.map(item => ({ floorId: item.id, canonicalFingerprint: item.content.canonicalFingerprint })), producedRefs: { floors: source.floors.map(item => item.id), floorMemories: [], entities: entities.map(item => item.id), events: [], claims: [], knowledge: [], stateDeltas: [], currentStates: [], stateProjections: [], episodes: [], threads: [], indexes: indexKeys }, validation: { schemaValid: true, referencesValid: true, orderedReplayValid: true, stateFingerprint }, sealedAt: nowValue, createdAt: nowValue, updatedAt: nowValue, recordStatus: 'active', supersedes: null }, { expectedChatId: source.root.chatId });
      const root = validateFoundationRoot({ ...source.root, status: 'ready', capabilities, headCheckpointId: checkpointId, activeRunId: null, activeStateRefs: [], activeThreadRefs: [], indexManifest: { ...emptyManifest(), floor: indexKeys.filter(key => key.includes('-floorOrder-') || key.includes('-fingerprint-')), entity: indexKeys.filter(key => key.includes('-entity-')), reverseRef: indexKeys.filter(key => key.includes('-reverseRef-')) }, updatedAt: nowValue }, { expectedChatId: source.root.chatId });
      await persistRecords([...entities, ...indexes, run, checkpoint], operation.controller.signal);
      if (operation.epoch !== epoch || operation.controller.signal.aborted || currentHostChatId() !== source.root.chatId || mainGenerationActive()) throw errorWith('V3_MEMORY_STALE', '聊天或正文状态已变化，完全重构未切换有效记忆。');
      const latest = await store.readReachable();
      if (latest.status !== 'ready' || latest.rootRevision !== source.rootRevision || latest.root.headCheckpointId !== source.root.headCheckpointId || latest.root.narrativeGeneration !== source.root.narrativeGeneration) throw errorWith('V3_MEMORY_CAS_CONFLICT', '记忆已被其他操作更新，完全重构未覆盖新版本。');
      const committed = await store.commitRoot(root, source.rootRevision, { signal: operation.controller.signal });
      if (committed.status !== 'saved') throw errorWith(committed.status === 'conflict' ? 'V3_MEMORY_CAS_CONFLICT' : 'V3_MEMORY_COMMIT_FAILED', committed.status === 'conflict' ? '记忆提交遇到并发更新，旧有效图保持不变。' : `完全重构提交失败：${committed.status}`);
      sessionCandidates.clear(); lastFailure = null; lastAutoRun = null; emptyRealtimeOrigin = null;
      await onFullRebuildCommitted?.({ chatId: source.root.chatId, headCheckpointId: checkpointId });
      foundationRuntime.invalidate();
      if (!resetContextCurrent()) return getState();
      await foundationRuntime.refreshStatus();
      if (!resetContextCurrent()) return getState();
      await loadCurrent(requestedEpoch);
      if (!resetContextCurrent()) return getState();
      cseRuntime.invalidate(); await cseRuntime.load(); await refreshCoverage(operation.epoch);
      return notify();
    } finally { if (active === operation) active = null; }
  }
  const fullRebuild = async expectedChatId => {
    const requestedEpoch = epoch, requestedChatId = String(expectedChatId ?? currentHostChatId()).trim();
    if (!requestedChatId || requestedChatId !== currentHostChatId() || (reachable?.root?.chatId && reachable.root.chatId !== requestedChatId)) throw errorWith('V3_MEMORY_STALE', '当前界面所属聊天已变化，完全重构未开始。');
    const result = await runManualWork('fullRebuild', () => resetDerivedGraph({ requestedEpoch, requestedChatId }));
    if (requestedEpoch === epoch && currentHostChatId() === requestedChatId && result?.chatId === requestedChatId && result.rebuildStatus === 'pendingRebuild') return startHistoricalRebuild();
    return result;
  };

  function diagnostic(floorId, { full = false } = {}) {
    const floor = reachable?.floors?.find(item => item.id === floorId);
    const view = getState().floors.find(item => item.floorId === floorId);
    if (!floor || !view) throw errorWith('V3_DIAGNOSTIC_FLOOR_MISSING', '找不到该楼诊断。');
    const memory = view.memory;
    const provenanceEntry = floorProvenance(reachable)[floorId] ?? {};
    const evidenceSafe = evidence => ({ ...evidence, quotedText: full ? evidence.quotedText : `[已隐藏原文 · ${evidence.quotedText.length} 字]` });
    const memoryCopy = memory ? clone(memory) : null;
    if (memoryCopy && !full) {
      memoryCopy.summaryEvidenceRefs = memoryCopy.summaryEvidenceRefs.map(evidenceSafe);
      for (const field of ['chronology', 'locations', 'participants', 'actions', 'observations', 'informationTransfers', 'privateCognition', 'commitments', 'eventFragments', 'openLoops', 'ambiguities', 'cseSignals']) memoryCopy[field].forEach(item => { item.evidenceRefs = (item.evidenceRefs ?? []).map(evidenceSafe); });
      memoryCopy.exactAnchors = memoryCopy.exactAnchors.map(anchor => ({ ...anchor, exactText: `[已隐藏原文 · ${anchor.exactText.length} 字]` }));
    }
    const payload = { plugin: 'ST-QianQianJie', schemaVersion: 3, promptVersion: EXTRACTOR_PROMPT_VERSION, extractorVersion: provenanceEntry.extractorVersion ?? memory?.extractorVersion ?? EXTRACTOR_VERSION, chatId: reachable.root.chatId, narrativeGeneration: reachable.root.narrativeGeneration, floorId, runId: view.runId ?? lastFailure?.runId ?? null, checkpointId: reachable.root.headCheckpointId, memoryId: view.memoryId, status: view.status, stage: active?.floorId === floorId ? active.phase : (lastFailure?.floorId === floorId ? lastFailure.phase : 'settled'), api: view.api ?? lastFailure?.api ?? null, attempts: view.attempts || lastFailure?.attempts || 0, transportAttempts: provenanceEntry.transportAttempts ?? lastFailure?.transportAttempts ?? null, responseFingerprint: provenanceEntry.responseFingerprint ?? null, error: lastFailure?.floorId === floorId ? { code: lastFailure.code, httpStatus: lastFailure.httpStatus ?? null, providerError: lastFailure.providerError ?? null, formatStage: lastFailure.formatStage, validationErrors: lastFailure.validationErrors, message: lastFailure.message } : null, structuredCounts: view.counts, floorMemory: memoryCopy, ...(full ? { canonicalContent: floor.content.canonicalContent, sessionCandidate: sessionCandidates.get(floorId) ?? null } : {}) };
    return JSON.stringify(sanitizeDiagnosticValue(payload), null, 2);
  }
  const copySafeDiagnostic = floorId => diagnostic(floorId, { full: false });
  const copyFullDiagnostic = floorId => diagnostic(floorId, { full: true });

  async function runAutomationBatch(reason = 'stableAssistant') {
    const config = automation();
    const manualHistorical = reason === MANUAL_HISTORY_REASON;
    const userInitiated = manualHistorical || reason === 'manualRetry';
    const authorizedChatId = manualHistorical ? historicalAuthorization : null;
    if (!enabled() || (!manualHistorical && !config.enabled) || (manualHistorical && !authorizedChatId) || workRun || active || cseRuntime.getState().activeCse) return getState();
    const operation = { kind: 'auto', token: ++autoEpoch, reason, phase: 'reconciling', mode: manualHistorical ? 'historical' : 'realtime', floorIds: [], promise: null };
    workRun = operation;
    notify();
    operation.promise = (async () => {
      try {
        const allowed = () => operation.token === autoEpoch && enabled() && (manualHistorical
          ? historicalAuthorization === authorizedChatId
          : automation().enabled);
        let historical = manualHistorical;
        let resumed = false;
        let processed = 0;
        let cseProcessed = 0;
        let fromAssistantSeq = null;
        let toAssistantSeq = null;
        const processedMessageIndexes = [];
        let capturedFloorIds = null;
        while (allowed()) {
          operation.phase = 'reconciling';
          notify();
          const foundation = await foundationRuntime.refreshStatus();
          if (foundation.status !== 'ready' || !allowed()) return getState();
          await load();
          if (!allowed() || !reachable?.root) return getState();
          if (manualHistorical && reachable.root.chatId !== authorizedChatId) return getState();
          const assessment = await refreshCoverage();
          if (assessment.status === 'unknown') throw errorWith('V3_MEMORY_COVERAGE_UNCONFIRMED', '当前聊天的可达覆盖尚未确认，历史重建已暂停。');
          capturedFloorIds ??= Object.freeze((reachable.floors ?? []).map(floor => floor.id));
          const capturedFloorSet = new Set(capturedFloorIds);
          const capturedTotal = capturedFloorIds.length;
          if (historical && assessment.completed >= capturedTotal && assessment.summaryCompleted >= capturedTotal) {
            if (manualHistorical && historicalAuthorization === authorizedChatId) historicalAuthorization = null;
            lastAutoRun = processed || cseProcessed
              ? Object.freeze({ status: 'completed', reason, mode: historical ? 'historical' : 'realtime', batchSize: config.batchSize, recovered: resumed, fromAssistantSeq, toAssistantSeq, processed, cseProcessed })
              : Object.freeze({ status: 'caughtUp', reason, mode: 'historical', batchSize: config.batchSize, available: 0, fromAssistantSeq: null, toAssistantSeq: null, processed: 0 });
            if (processed || cseProcessed) try { notifyUser?.({ kind: 'success', text: `千千结已完成历史记忆维护：新增摘要 ${processed} 楼，补齐人物状态 ${cseProcessed} 楼。` }); } catch { /* notification must not affect committed memory */ }
            return notify();
          }
          const inputKey = currentInputKey();
          if (!userInitiated && lastAutomaticInputKey === inputKey) {
            if (lastAutoRun?.status === 'failed') return notify();
            lastAutoRun = Object.freeze({ status: 'waiting', reason, mode: 'realtime', batchSize: config.batchSize, available: Math.max(0, assessment.total - assessment.completed), fromAssistantSeq: assessment.nextAssistantSeq, toAssistantSeq: reachable.floors.at(-1)?.assistantSeq ?? null, processed: 0, cseProcessed: 0 });
            return notify();
          }
          operation.mode = historical ? 'historical' : 'realtime';
          const summaryPending = (reachable.floors ?? []).slice(assessment.summaryCompleted)
            .filter(floor => capturedFloorSet.has(floor.id));
          const targets = historical
            ? summaryPending.slice(0, Math.min(config.batchSize, summaryPending.length))
            : assessment.summaryStatus === 'realtimeTail' && summaryPending.length >= config.batchSize
              ? summaryPending.slice(0, config.batchSize)
              : [];
          resumed ||= historical ? assessment.hasPartialWork : assessment.summaryHasPartialWork;
          if (targets.length) {
            operation.floorIds = targets.map(floor => floor.id);
            operation.phase = 'extracting';
            notify();
            for (const floor of targets) {
              if (!allowed()) return getState();
              const memory = currentMemoryMap(reachable).get(floor.id);
              if (memory?.recordStatus !== 'active') await extractFloorInternal(floor.id, { analyzeState: false });
              if (!allowed()) return getState();
              const currentFloor = getState().floors.find(item => item.floorId === floor.id);
              if (!currentFloor?.memoryId || !['ready', 'needsReview'].includes(currentFloor.status)) {
                if (manualHistorical && historicalAuthorization === authorizedChatId) historicalAuthorization = null;
                if (!historical) lastAutomaticInputKey = currentInputKey() ?? inputKey;
                lastAutoRun = Object.freeze({ status: 'failed', reason, mode: operation.mode, phase: 'extracting', batchSize: config.batchSize, floorId: floor.id, assistantSeq: floor.assistantSeq, message: getState().lastExtractorError?.message ?? 'FloorMemory 提取失败，可点击继续重建后从本楼重试。' });
                notifyOnce(`extracting:${operation.token}:${inputKey}:${floor.id}`, { kind: 'error', text: `千千结摘要提取失败：${safeErrorMessage(lastAutoRun.message)} 可在记忆管理中点击继续。` });
                return notify();
              }
              fromAssistantSeq ??= floor.assistantSeq;
              toAssistantSeq = floor.assistantSeq;
              processedMessageIndexes.push(floor.hostLocator?.messageIndex);
              processed += 1;
            }
          }
          if (!allowed()) return getState();
          await load();
          let afterExtraction = await refreshCoverage();
          if (afterExtraction.status === 'unknown') throw errorWith('V3_MEMORY_COVERAGE_UNCONFIRMED', '摘要保存后覆盖校验未确认，人物状态分析已暂停。');
          while (allowed() && afterExtraction.completed < capturedTotal) {
            const floor = reachable.floors?.[afterExtraction.completed];
            if (!floor || !capturedFloorSet.has(floor.id) || currentMemoryMap(reachable).get(floor.id)?.recordStatus !== 'active') break;
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
              if (!historical) lastAutomaticInputKey = currentInputKey() ?? inputKey;
              lastAutoRun = Object.freeze({ status: 'failed', reason, mode: operation.mode, phase: 'analyzingCse', batchSize: config.batchSize, floorId: floor.id, assistantSeq: floor.assistantSeq, message: getState().lastCseError?.message ?? 'CSE 分析失败，可点击继续重建后从本楼重试。' });
              const prefix = historical ? '千千结人物状态分析失败'
                : processed > 0 ? '千千结已保存新楼摘要，但最早待处理楼的人物状态分析失败'
                  : '千千结人物状态追赶失败';
              notifyOnce(`analyzingCse:${operation.token}:${inputKey}:${floor.id}`, { kind: 'warning', text: `${prefix}：${safeErrorMessage(lastAutoRun.message)} 后续合资格稳定楼会有限重试，也可现在点击继续。` });
              return notify();
            }
            cseProcessed += 1;
            await load();
            afterExtraction = await refreshCoverage();
            if (afterExtraction.status === 'unknown') throw errorWith('V3_MEMORY_COVERAGE_UNCONFIRMED', '人物状态保存后覆盖校验未确认，自动追赶已暂停。');
          }
          if (!historical) {
            lastAutomaticInputKey = null;
            const summaryDebt = afterExtraction.summaryStatus === 'historicalDebt' && afterExtraction.summaryCompleted < capturedTotal;
            if (summaryDebt) {
              lastAutoRun = Object.freeze({ status: 'authorizationRequired', reason, mode: 'historical', phase: cseProcessed ? 'analyzingCse' : 'extracting', batchSize: config.batchSize, available: capturedTotal - afterExtraction.summaryCompleted, fromAssistantSeq: afterExtraction.summaryNextAssistantSeq, toAssistantSeq: reachable.floors.at(capturedTotal - 1)?.assistantSeq ?? null, processed, cseProcessed });
              notifyOnce(`authorization:${inputKey}:${afterExtraction.summaryNextAssistantSeq}:${cseProcessed}`, { kind: 'warning', text: cseProcessed ? `千千结已补齐 ${cseProcessed} 楼人物状态；后续历史摘要缺口仍需在记忆管理中点击继续。` : '千千结发现需要用户确认的历史摘要缺口；请在记忆管理中点击继续。' });
              return notify();
            }
            const summaryWaiting = afterExtraction.summaryCompleted < capturedTotal;
            if (summaryWaiting) {
              lastAutoRun = Object.freeze({ status: 'waiting', reason, mode: 'realtime', phase: cseProcessed ? 'analyzingCse' : 'extracting', batchSize: config.batchSize, available: capturedTotal - afterExtraction.summaryCompleted, fromAssistantSeq: afterExtraction.summaryNextAssistantSeq, toAssistantSeq: reachable.floors.at(capturedTotal - 1)?.assistantSeq ?? null, processed, cseProcessed });
              if (cseProcessed) try { notifyUser?.({ kind: 'success', text: `千千结已补齐 ${cseProcessed} 楼人物状态；新摘要继续等待稳定批次。` }); } catch { /* notification must not affect committed memory */ }
              return notify();
            }
            const didWork = processed > 0 || cseProcessed > 0;
            lastAutoRun = Object.freeze({ status: didWork ? 'completed' : 'caughtUp', reason, mode: 'realtime', phase: cseProcessed ? 'analyzingCse' : 'extracting', batchSize: config.batchSize, recovered: resumed, fromAssistantSeq, toAssistantSeq, processed, cseProcessed, cseCompleted: cseProcessed > 0 });
            if (didWork) try { notifyUser?.({ kind: 'success', text: `千千结已自动维护完成：新增摘要 ${processed} 楼，补齐人物状态 ${cseProcessed} 楼。` }); } catch { /* notification must not affect committed memory */ }
            return notify();
          }
        }
        return getState();
      } catch (error) {
        if (operation.token === autoEpoch) {
          if (manualHistorical && historicalAuthorization === authorizedChatId) historicalAuthorization = null;
          if (!manualHistorical) lastAutomaticInputKey = currentInputKey();
          lastAutoRun = Object.freeze({ status: 'failed', reason, phase: operation.phase, batchSize: config.batchSize, floorId: operation.floorIds[0] ?? null, assistantSeq: null, message: safeErrorMessage(error?.message ?? '自动记忆失败，将在下一次稳定回复后重试。') });
          logger?.warn?.('[qianqianjie] V3 automatic memory failed', { code: error?.code ?? error?.name ?? 'V3_AUTO_MEMORY_FAILED' });
          notifyOnce(`outer:${operation.token}:${currentInputKey()}:${operation.phase}`, { kind: 'error', text: `千千结自动记忆未完成：${lastAutoRun.message} 可在记忆管理中点击继续。` });
          notify();
        }
        return getState();
      } finally {
        if (manualHistorical && historicalAuthorization === authorizedChatId) historicalAuthorization = null;
        if (workRun === operation) workRun = null;
        notify();
      }
    })();
    return operation.promise;
  }

  function scheduleAllowed(reason) {
    if (!enabled()) return false;
    return reason === MANUAL_HISTORY_REASON ? Boolean(historicalAuthorization) : automation().enabled;
  }

  function scheduleAutomation(reason = 'stableAssistant') {
    if (!scheduleAllowed(reason)) return Promise.resolve(getState());
    autoTriggerReason = reason;
    if (autoScheduled) return autoScheduled;
    autoScheduled = Promise.resolve().then(() => {
      if (workRun || active || cseRuntime.getState().activeCse) return getState();
      const nextReason = autoTriggerReason;
      autoTriggerReason = null;
      return runAutomationBatch(nextReason);
    }).finally(() => {
      autoScheduled = null;
      if (autoTriggerReason && !workRun && !active && !cseRuntime.getState().activeCse && scheduleAllowed(autoTriggerReason)) void scheduleAutomation(autoTriggerReason);
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
      if (workRun?.kind === 'auto' && workRun.mode !== 'historical') {
        autoEpoch += 1;
        active?.controller.abort();
        cseRuntime.cancelActive?.();
      }
    } else if (getState().cseFloors.some(floor => floor.status === 'pending')) {
      return scheduleAutomation('automationEnabledCatchup');
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
  const isAssistantSlot = message => Boolean(message && typeof message === 'object' && message.is_user === false && !(message.is_system === true && message.extra?.type));
  function tailSwipeBoundary(messageIndex, expected = null) {
    if (!Number.isSafeInteger(messageIndex)) return null;
    let snapshot;
    try { snapshot = hostAdapter.snapshot(); } catch { return null; }
    if (expected && !sameGenerationIdentity(expected, snapshot)) return null;
    const stableFloor = reachable?.floors?.at(-1) ?? null;
    const stableMessageIndex = stableFloor?.hostLocator?.messageIndex;
    const pending = foundationRuntime.getState()?.pending;
    if (!stableFloor || !Number.isSafeInteger(stableMessageIndex)
      || !pending || pending.messageIndex !== messageIndex
      || messageIndex <= stableMessageIndex || messageIndex !== snapshot.chat?.length - 1
      || !isAssistantSlot(snapshot.chat?.[messageIndex])) return null;
    if (expected && (expected.messageIndex !== messageIndex || expected.stableFloorId !== stableFloor.id
      || expected.stableMessageIndex !== stableMessageIndex)) return null;
    return Object.freeze({
      ...generationIdentity(snapshot),
      messageIndex,
      stableFloorId: stableFloor.id,
      stableMessageIndex,
    });
  }
  const mutationMessageIndex = (name, args) => {
    if (name === 'MESSAGE_SWIPED') return Number.isSafeInteger(args[0]) ? args[0] : null;
    if (name === 'MESSAGE_SWIPE_DELETED') return Number.isSafeInteger(args[0]?.messageId) ? args[0].messageId : null;
    return null;
  };
  const meaningfulText = value => {
    const text = typeof value === 'string' ? value.trim() : '';
    return text !== '' && text !== '...';
  };
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
    if (!enabled() || !automation().enabled || typeof foundationRuntime.stabilizeThrough !== 'function') return;
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
    if (automation().enabled) autoTriggerReason = 'earlyStableAssistant';
    void Promise.resolve(foundationRuntime.stabilizeThrough(arm.boundary)).catch(error => {
      if (generationArm?.boundary !== arm.boundary) return;
      lastFailure = Object.freeze({ floorId: null, runId: null, phase: 'foundation', code: error?.code ?? 'V3_EARLY_FOUNDATION_FAILED', attempts: 0, validationErrors: [], api: null, message: safeErrorMessage(error?.message) });
      notify();
    });
    return true;
  }

  function bind({ eventSource, eventTypes } = hostAdapter.snapshot()) {
    foundationRuntime.bind({ eventSource, eventTypes });
    if (bound || !eventSource?.on || !eventTypes) return false;
    const drainFoundationReload = () => {
      if (foundationReload) return foundationReload;
      foundationReload = Promise.resolve().then(async () => {
        while (awaitingFoundation && enabled()) {
          const foundationStatus = foundationRuntime.getState()?.status;
          if (!['ready', 'uninitialized'].includes(foundationStatus)) break;
          awaitingFoundation = false;
          const reloadEpoch = epoch;
          try {
            await load(reloadEpoch);
            if (reloadEpoch === epoch && autoTriggerReason && scheduleAllowed(autoTriggerReason)) {
              const reason = autoTriggerReason;
              autoTriggerReason = null;
              void scheduleAutomation(reason);
            }
          } catch (error) {
            if (reloadEpoch !== epoch) continue;
            lastFailure = Object.freeze({ floorId: null, runId: null, phase: 'load', code: error?.code ?? 'V3_MEMORY_LOAD_FAILED', attempts: 0, validationErrors: [], api: null, message: safeErrorMessage(error?.message) });
            notify();
          }
        }
      }).finally(() => { foundationReload = null; });
      return foundationReload;
    };
    if (typeof foundationRuntime.subscribe === 'function') unsubscribeFoundation = foundationRuntime.subscribe(state => {
      if (!awaitingFoundation || !['ready', 'uninitialized'].includes(state?.status)) return;
      void drainFoundationReload();
    });
    const generationStoppedEvent = eventTypes.GENERATION_STOPPED;
    const generationEndedEvent = eventTypes.GENERATION_ENDED;
    const generationStartedEvent = eventTypes.GENERATION_STARTED;
    if (generationStartedEvent && generationStoppedEvent && generationEndedEvent) {
      eventSource.on(generationStartedEvent, (type, _options, dryRun) => {
        if (dryRun === true) return;
        if (type !== 'swipe' || tailSwipeContext?.stopped === true) tailSwipeContext = null;
        else if (tailSwipeContext && !tailSwipeBoundary(tailSwipeContext.messageIndex, tailSwipeContext)) tailSwipeContext = null;
        if (formalGenerationActive) {
          if (type === undefined || type === null || type === '' || type === 'normal') generationArm = null;
          return;
        }
        formalGenerationActive = true;
        armEarlyGeneration(type);
        if (active?.phase === 'resetting') { epoch += 1; active.controller.abort('generationStarted'); }
      });
      eventSource.on(generationStoppedEvent, () => {
        formalGenerationActive = false;
        generationArm = null;
        if (tailSwipeContext && tailSwipeContext.stopped !== true && tailSwipeBoundary(tailSwipeContext.messageIndex, tailSwipeContext)) {
          tailSwipeContext = Object.freeze({ ...tailSwipeContext, stopped: true });
          awaitingFoundation = true;
          notify();
          return;
        }
        tailSwipeContext = null;
        cancelEarlyStabilization('generationStopped');
        cancelAutomation();
      });
      eventSource.on(generationEndedEvent, () => {
        formalGenerationActive = false;
        if (!generationArm?.proven) generationArm = null;
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
        const tailMutationIndex = mutationMessageIndex(name, args);
        const tailBoundary = tailMutationIndex === null ? null : tailSwipeBoundary(tailMutationIndex);
        if (tailBoundary) {
          if (name === 'MESSAGE_SWIPED' && args[1]?.pendingGeneration === true) tailSwipeContext = tailBoundary;
          awaitingFoundation = true;
          notify();
          return;
        }
        const sameTailFinal = name === 'MESSAGE_RECEIVED' && finalType === 'swipe' && tailSwipeContext
          && args[0] === tailSwipeContext?.messageIndex
          && Boolean(tailSwipeBoundary(tailSwipeContext.messageIndex, tailSwipeContext));
        if (sameTailFinal) {
          tailSwipeContext = null;
          generationArm = null;
          awaitingFoundation = true;
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
          awaitingFoundation = true;
          if (automation().enabled) autoTriggerReason = 'MESSAGE_RECEIVED';
          notify();
          return;
        }
        generationArm = null;
        tailSwipeContext = null;
        cancelEarlyStabilization(name);
        cancelAutomation();
        epoch += 1;
        active?.controller.abort();
        active = null;
        workRun = null;
        reachable = null;
        timeFallbackByFloor = new Map();
        coverage = unknownCoverage(0);
        lastFailure = null;
        sessionCandidates.clear();
        cseRuntime.invalidate();
        awaitingFoundation = true;
        if (name !== 'MESSAGE_RECEIVED') { emptyRealtimeOrigin = null; lastAutomaticInputKey = null; lastNoticeKey = null; }
        if (name === 'MESSAGE_RECEIVED' && automation().enabled) autoTriggerReason = name;
        if (name === 'CHAT_CHANGED' || name === 'CHAT_RENAMED' || HISTORY_MUTATION_EVENTS.has(name)) lastAutoRun = null;
        notify();
      });
    }
    bound = true; return true;
  }
  async function start() {
    if (!enabled()) return notify();
    await foundationRuntime.start();
    const state = await load();
    if (automation().enabled && state.cseFloors.some(floor => floor.status === 'pending')) void scheduleAutomation('startupCatchup');
    return state;
  }
  async function setEnabled(value) { if (value !== true) invalidate(); await foundationRuntime.setEnabled(value); if (value !== true) return notify(); return load(); }
  async function startHistoricalRebuild() {
    while (autoScheduled || workRun?.promise) await (autoScheduled ?? workRun.promise);
    if (!enabled()) return notify();
    if (mainGenerationActive()) {
      try { notifyUser?.({ kind: 'warning', text: '主模型正在生成，请等待完成后再开始重建。' }); } catch { /* notification is advisory */ }
      return notify();
    }
    await refreshStatus();
    const assessment = await refreshCoverage();
    if (mainGenerationActive()) {
      try { notifyUser?.({ kind: 'warning', text: '主模型正在生成，请等待完成后再开始重建。' }); } catch { /* notification is advisory */ }
      return notify();
    }
    if (!reachable?.root || !['historicalDebt', 'realtimeTail'].includes(assessment.status)) return notify();
    historicalAuthorization = reachable.root.chatId;
    return scheduleAutomation(MANUAL_HISTORY_REASON);
  }
  const shouldBlockMainGeneration = () => Boolean(enabled() && (
    (historicalAuthorization && reachable?.root?.chatId === historicalAuthorization)
    || active?.phase === 'resetting'
    || (workRun?.kind === 'manual' && workRun.reason === 'fullRebuild')
  ));
  const allowsRealtimeTailFromEmpty = () => Boolean(realtimeOriginFromReachable(reachable) || (emptyRealtimeOrigin && (reachable?.root
    ? emptyRealtimeOrigin.chatId === reachable.root.chatId
      && (emptyRealtimeOrigin.narrativeGeneration === null || emptyRealtimeOrigin.narrativeGeneration === reachable.root.narrativeGeneration)
    : emptyRealtimeOrigin.narrativeGeneration === null && emptyRealtimeOrigin.chatId === currentHostChatId())));
  function pauseHistoricalRebuild() {
    const wasHistorical = historicalAuthorization !== null || (workRun?.kind === 'auto' && workRun.mode === 'historical');
    const pausedOperationToken = workRun?.token ?? autoEpoch;
    historicalAuthorization = null;
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
  const retryAutomation = async () => {
    while (autoScheduled || workRun?.promise) await (autoScheduled ?? workRun.promise);
    return coverage.status === 'historicalDebt' ? startHistoricalRebuild() : scheduleAutomation('manualRetry');
  };
  const analyzeNextState = () => runManualWork('analyzingCse', async operation => { operation.phase = 'analyzingCse'; notify(); await cseRuntime.analyzeNext(); return notify(); });
  const retryStateAnalysis = floorId => runManualWork('analyzingCse', async operation => { operation.floorIds = [floorId]; operation.phase = 'analyzingCse'; notify(); await cseRuntime.analyzeFloor(floorId); return notify(); });
  const correctSubjectState = (subjectEntityId, edits) => runManualWork('revisingCse', async operation => { operation.phase = 'revisingCse'; notify(); await cseRuntime.correctSubjectState({ subjectEntityId, ...edits }); return load(); });
  return Object.freeze({ bind, start, setEnabled, refreshAutomation, startHistoricalRebuild, pauseHistoricalRebuild, retryAutomation, fullRebuild, invalidate, refreshStatus, confirmLatest, extractNext, extractFloor, analyzeNextState, retryStateAnalysis, correctSubjectState, editSummary, editMemory, restoreAi, markError, copySafeDiagnostic, copyFullDiagnostic, shouldBlockMainGeneration, allowsRealtimeTailFromEmpty, getState, subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); } });
}
