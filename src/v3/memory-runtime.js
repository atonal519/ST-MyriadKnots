import { newIdentityUuid, sha256 } from '../identity.js';
import { buildFoundationIndexes } from './foundation-runtime.js';
import { deterministicUuid } from './foundation-domain.js';
import { validateFoundationCheckpoint, validateFoundationRoot, validateFoundationRun } from './foundation-schema.js';
import { runExtractorRequest, createExtractorEnvelope, EXTRACTOR_PROMPT_VERSION, EXTRACTOR_VERSION } from './extractor.js';
import { validateFloorMemory } from './memory-schema.js';
import { sanitizeDiagnosticValue, sanitizeSensitiveText, sanitizeTaskMetadata } from './safe-metadata.js';
import { createCseRuntime } from './cse-runtime.js';
import { filterReachableDeltas, replayCurrentState } from './cse-engine.js';
import { validateCseGraph } from './cse-schema.js';
import { assessMemoryCoverageFromHost } from './memory-coverage.js';

const EVENTS = Object.freeze(['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED']);
const HISTORY_MUTATION_EVENTS = new Set(['MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED']);
const MANUAL_HISTORY_REASON = 'manualHistoricalRebuild';
const emptyManifest = () => ({ floor: [], entity: [], event: [], claim: [], knowledge: [], episode: [], thread: [], state: [], anchor: [], reverseRef: [] });
const nowIso = now => { const value = now()?.toISOString?.() ?? String(now()); if (!Number.isFinite(Date.parse(value))) throw new TypeError('V3_MEMORY_TIME_INVALID'); return value; };
const hash = async value => `sha256:${await sha256(JSON.stringify(value))}`;
const clone = value => structuredClone(value);
const counts = memory => Object.fromEntries(['chronology', 'locations', 'participants', 'actions', 'observations', 'informationTransfers', 'privateCognition', 'commitments', 'eventFragments', 'exactAnchors', 'openLoops', 'ambiguities', 'cseSignals'].map(field => [field, memory?.[field]?.length ?? 0]));
const effectiveSummary = memory => memory?.summary?.effectiveSource === 'user' ? memory.summary.userText : memory?.summary?.aiText;
const safeApi = value => sanitizeTaskMetadata(value);
const safeErrorMessage = value => sanitizeSensitiveText(value ?? '提取失败，可重试。').slice(0, 500);
const unknownCoverage = total => Object.freeze({ status: 'unknown', completed: 0, total, nextAssistantSeq: null, pendingFloorIds: Object.freeze([]), realtimeProtected: false, hasPartialWork: false });
const emptyCaughtUpCoverage = () => Object.freeze({ status: 'caughtUp', completed: 0, total: 0, nextAssistantSeq: null, pendingFloorIds: Object.freeze([]), realtimeProtected: true, hasPartialWork: false });

function errorWith(code, message = code) { const error = new Error(message); error.code = code; return error; }
function currentMemoryMap(reachable) { return new Map((reachable?.floorMemories ?? []).map(memory => [memory.floorId, memory])); }
function floorProvenance(reachable) { return reachable?.run?.diagnostics?.floorProvenance && typeof reachable.run.diagnostics.floorProvenance === 'object' ? clone(reachable.run.diagnostics.floorProvenance) : {}; }

const SESSION_CANDIDATE_MAX_ENTRIES = 8;
const SESSION_CANDIDATE_MAX_CHARACTERS = 96000;
const normalizeAutoBatchSize = value => {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 20 ? number : 2;
};

export function createV3MemoryRuntime({ foundationRuntime, store, hostAdapter, generateUtilityTask, isEnabled = true, automationSettings = () => ({ enabled: false, batchSize: 2 }), notifyUser = null, isMainGenerationActive = () => false, customGuidance = () => '', sanitizerOptions = () => ({}), now = () => new Date(), newUuid = newIdentityUuid, logger = console } = {}) {
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
  let emptyRealtimeOrigin = null;
  let coverage = unknownCoverage(0);
  const sessionCandidates = new Map();
  const subscribers = new Set();
  const cseRuntime = createCseRuntime({ store, hostAdapter, generateUtilityTask, isEnabled, sanitizerOptions, now, newUuid, logger });
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
      return Object.freeze({ enabled: false, batchSize: 2 });
    }
  };
  const notify = () => { const snapshot = getState(); for (const listener of subscribers) { try { listener(snapshot); } catch { /* UI listener isolation */ } } return snapshot; };
  const cancelAutomation = () => {
    autoEpoch += 1;
    autoTriggerReason = null;
    historicalAuthorization = null;
    if (workRun?.kind === 'auto') {
      active?.controller.abort();
      cseRuntime.cancelActive?.();
    }
  };
  const invalidate = () => { cancelAutomation(); epoch += 1; active?.controller.abort(); active = null; workRun = null; reachable = null; coverage = unknownCoverage(0); emptyRealtimeOrigin = null; formalGenerationActive = false; lastFailure = null; lastAutoRun = null; awaitingFoundation = false; sessionCandidates.clear(); cseRuntime.invalidate(); notify(); };
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
    return Object.freeze({ floorId: floor.id, assistantSeq: floor.assistantSeq, messageIndex: floor.hostLocator.messageIndex, canonicalFingerprint: floor.content.canonicalFingerprint, status, memoryId: memory?.id ?? null, summary: effectiveSummary(memory) ?? '', summarySource: memory?.summary?.effectiveSource ?? null, aiSummary: memory?.summary?.aiText ?? '', revisionNote: memory?.summary?.revisionNote ?? null, extractorVersion: memory?.extractorVersion ?? EXTRACTOR_VERSION, counts: counts(memory), api: meta?.api ?? null, attempts: meta?.attempts ?? 0, runId: meta?.runId ?? null, checkpointId: reachable?.checkpoint?.id ?? null, needsReview: status === 'needsReview', error: lastFailure?.floorId === floor.id ? lastFailure.message : (memory?.recordStatus === 'invalidated' ? '该楼记忆已标记错误，可重新提取。' : null), memory });
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
    const auto = automation();
    const rebuildStatus = workRun?.kind === 'auto' && workRun.mode === 'historical' ? 'rebuilding'
        : lastAutoRun?.status === 'failed' && coverage.status !== 'caughtUp' ? 'failed'
          : lastAutoRun?.status === 'paused' && coverage.status !== 'caughtUp' ? 'paused'
          : coverage.status === 'caughtUp' ? 'caughtUp'
            : coverage.status === 'realtimeTail' ? 'waitingRealtime'
              : coverage.status === 'historicalDebt' ? 'pendingRebuild' : 'notReady';
    return Object.freeze({ ...foundation, ...cse, status: workRun || active || cse.activeCse ? 'running' : foundation.status, stableCount, rememberedCount, unprocessedCount: floors.filter(item => ['unprocessed', 'error', 'failed'].includes(item.status)).length, reviewCount: floors.filter(item => item.status === 'needsReview').length, failedCount: floors.filter(item => ['error', 'failed'].includes(item.status)).length, floors: Object.freeze(combinedFloors), memoryWorkBusy: workRun !== null, activeMemoryWork: workRun ? Object.freeze({ kind: workRun.kind, reason: workRun.reason, phase: workRun.phase, floorIds: Object.freeze([...workRun.floorIds]) }) : null, activeExtraction: active ? { floorId: active.floorId, runId: active.runId, phase: active.phase } : null, lastExtractorError: lastFailure, autoMemoryEnabled: auto.enabled, autoMemoryBatchSize: auto.batchSize, rebuildStatus, rebuildCompletedCount: coverage.completed, rebuildTotalCount: coverage.total, rebuildNextAssistantSeq: coverage.nextAssistantSeq, activeAutoMemory: workRun?.kind === 'auto' ? Object.freeze({ reason: workRun.reason, phase: workRun.phase, mode: workRun.mode ?? 'realtime', floorIds: Object.freeze([...workRun.floorIds]) }) : null, lastAutoMemory: lastAutoRun, promptVersion: EXTRACTOR_PROMPT_VERSION, extractorVersion: EXTRACTOR_VERSION });
  }
  async function refreshCoverage(expectedEpoch = epoch) {
    const source = reachable;
    const realtimeOrigin = Boolean(source?.root && emptyRealtimeOrigin
      && emptyRealtimeOrigin.chatId === source.root.chatId
      && (emptyRealtimeOrigin.narrativeGeneration === null || emptyRealtimeOrigin.narrativeGeneration === source.root.narrativeGeneration));
    const next = source
      ? await assessMemoryCoverageFromHost({ reachable: source, snapshot: hostAdapter.snapshot(), sanitizerOptions: sanitizerOptions(), realtimeOrigin })
      : unknownCoverage(0);
    if (expectedEpoch === epoch && reachable === source) {
      coverage = next;
      if (realtimeOrigin && emptyRealtimeOrigin?.narrativeGeneration === null) {
        emptyRealtimeOrigin = Object.freeze({ chatId: source.root.chatId, narrativeGeneration: source.root.narrativeGeneration });
      }
      if (next.status === 'caughtUp' && next.total === 0 && source?.root?.chatId) {
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
    if (nextReachable) await refreshCoverage(expectedEpoch);
    if (expectedEpoch !== epoch) return getState();
    notify();
    return getState();
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
    const current = await store.readReachable();
    if (current.status !== 'ready' || current.rootRevision !== oldReachable.rootRevision || current.root.headCheckpointId !== oldReachable.root.headCheckpointId || current.root.narrativeGeneration !== oldReachable.root.narrativeGeneration) throw errorWith('V3_MEMORY_STALE', '聊天记忆已变化，本次结果不会覆盖新版本。');
    const floor = current.floors.find(item => item.id === replacement.floorId);
    if (!floor || floor.content.canonicalFingerprint !== operation.floorFingerprint) throw errorWith('V3_MEMORY_STALE', '正文分支已变化，本次结果已作废。');
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
    const run = validateFoundationRun({ schemaVersion: 3, recordType: 'run', id: runId, chatId: current.root.chatId, narrativeGeneration: current.root.narrativeGeneration, parentCheckpointId: current.root.headCheckpointId, inputSnapshotFingerprint: current.root.sourceSnapshotFingerprint, mode: 'localReextract', sessionEpoch: operation.epoch, inputFloorIds: [replacement.floorId], phase: 'completed', completedFloorIds: [replacement.floorId], failedItems: [], preparedRecordRefs: [store.recordKey(replacement), ...newEntities.map(entity => store.recordKey(entity)), ...preparedStateRefs, ...indexKeys, `v3-checkpoint-${checkpointId}`], diagnostics: { kind: 'extractor', promptVersion: EXTRACTOR_PROMPT_VERSION, extractorVersion: EXTRACTOR_VERSION, floorProvenance: provenance, validationErrors: validationErrors.slice(-20) }, startedAt: operation.startedAt, createdAt: nowValue, updatedAt: nowValue, recordStatus: 'active', supersedes: null }, { expectedChatId: current.root.chatId });
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
    await load();
    const source = reachable ? clone(reachable) : null;
    const floor = source?.floors?.find(item => item.id === floorId);
    if (!floor) throw errorWith('V3_MEMORY_FLOOR_UNAVAILABLE', '只允许提取当前 root 可达的稳定 AI 楼。');
    const oldMemory = currentMemoryMap(source).get(floor.id) ?? null;
    const operation = { floorId: floor.id, floorFingerprint: floor.content.canonicalFingerprint, epoch, controller: new AbortController(), runId: await deterministicUuid(['v3-extractor-run', source.root.headCheckpointId, floor.id, newUuid()]), startedAt: nowIso(now), phase: 'extracting' };
    active = operation; notify();
    try {
      const userIdentity = typeof hostAdapter?.getUserIdentity === 'function'
        ? hostAdapter.getUserIdentity()
        : hostAdapter?.snapshot?.().userIdentity ?? null;
      const expectedScope = { batchId: operation.runId, chatId: source.root.chatId, narrativeGeneration: source.root.narrativeGeneration, checkpointId: source.root.headCheckpointId, floorId: floor.id };
      const envelope = await createExtractorEnvelope({ ...expectedScope, floor, entities: source.entities, userIdentity, identityHints: [], customGuidance: customGuidance() });
      const result = await runExtractorRequest({ generateUtilityTask, envelope, floor, existingEntities: source.entities, now: nowIso(now), supersedes: oldMemory?.id ?? null, preservedSummary: oldMemory?.summary?.effectiveSource === 'user' ? oldMemory.summary : null, expectedScope, signal: operation.controller.signal });
      operation.phase = 'validating'; notify();
      const foundationAfter = await foundationRuntime.refreshStatus();
      if (foundationAfter.status !== 'ready') throw errorWith('V3_MEMORY_STALE', '正文地基在提取期间发生变化，本次结果已作废。');
      if (operation.epoch !== epoch || operation.controller.signal.aborted) throw errorWith('V3_MEMORY_STALE', '聊天或正文已变化，迟到响应已丢弃。');
      operation.phase = 'committing'; notify();
      await commitRevision(operation, { oldReachable: source, replacement: result.memory, newEntities: result.newEntities, provenanceEntry: { api: result.metadata, attempts: result.attempts, transportAttempts: result.transportAttempts, responseFingerprint: result.responseFingerprint, extractorVersion: result.memory.extractorVersion, needsReview: result.needsReview }, action: oldMemory ? 'reextract' : 'extract', validationErrors: result.validationErrors });
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
    await load();
    const map = currentMemoryMap(reachable);
    const floor = reachable?.floors?.find(item => map.get(item.id)?.recordStatus !== 'active');
    if (!floor) return getState();
    return extractFloorInternal(floor.id);
  }
  async function reviseInternal(floorId, action, { userText = null, revisionNote = null } = {}) {
    if (active) return getState();
    const foundation = await foundationRuntime.refreshStatus();
    if (foundation.status !== 'ready') throw errorWith('V3_MEMORY_FOUNDATION_NOT_READY', '正文地基尚未完成安全对账，当前不能修订。');
    await load();
    const floor = reachable?.floors?.find(item => item.id === floorId), old = currentMemoryMap(reachable).get(floorId);
    if (!floor || !old) throw errorWith('V3_MEMORY_REVISION_UNAVAILABLE', '该楼还没有可修订的正式记忆。');
    const nowValue = nowIso(now);
    const summary = action === 'edit' ? { ...old.summary, userText: String(userText ?? '').trim(), effectiveSource: 'user', revisionNote: String(revisionNote ?? '').trim() || null }
      : action === 'restoreAi' ? { ...old.summary, userText: null, effectiveSource: 'ai', revisionNote: String(revisionNote ?? '').trim() || '恢复 AI 原摘要' }
        : { ...old.summary, revisionNote: String(revisionNote ?? '').trim() || '用户标记错误' };
    if (action === 'edit' && !summary.userText) throw errorWith('V3_MEMORY_SUMMARY_EMPTY', '摘要不能为空。');
    const id = await deterministicUuid(['v3-memory-revision', old.id, action, summary, nowValue]);
    const replacement = validateFloorMemory({ ...old, id, summary, createdAt: nowValue, updatedAt: nowValue, recordStatus: action === 'markError' ? 'invalidated' : 'active', supersedes: old.id }, { expectedChatId: old.chatId });
    const operation = { floorId, floorFingerprint: floor.content.canonicalFingerprint, epoch, controller: new AbortController(), runId: await deterministicUuid(['v3-memory-revision-run', id]), startedAt: nowValue, phase: 'committing' };
    active = operation; notify();
    const priorAudit = floorProvenance(reachable)[floorId] ?? {};
    try { await commitRevision(operation, { oldReachable: reachable, replacement, provenanceEntry: { api: priorAudit.api ?? null, attempts: priorAudit.attempts ?? 0, transportAttempts: priorAudit.transportAttempts ?? null, responseFingerprint: priorAudit.responseFingerprint ?? null, extractorVersion: priorAudit.extractorVersion ?? old.extractorVersion, needsReview: priorAudit.needsReview ?? false }, action }); }
    finally { active = null; }
    return notify();
  }
  const extractFloor = (floorId, options) => runManualWork('extracting', () => extractFloorInternal(floorId, options));
  const extractNext = () => runManualWork('extracting', () => extractNextInternal());
  const editSummary = (floorId, userText, revisionNote = '') => runManualWork('revising', () => reviseInternal(floorId, 'edit', { userText, revisionNote }));
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
        let fromAssistantSeq = null;
        let toAssistantSeq = null;
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
          if (assessment.status === 'caughtUp') {
            if (manualHistorical && historicalAuthorization === authorizedChatId) historicalAuthorization = null;
            lastAutoRun = processed
              ? Object.freeze({ status: 'completed', reason, mode: historical ? 'historical' : 'realtime', batchSize: config.batchSize, recovered: resumed, fromAssistantSeq, toAssistantSeq, processed })
              : Object.freeze({ status: 'caughtUp', reason, mode: 'historical', batchSize: config.batchSize, available: 0, fromAssistantSeq: null, toAssistantSeq: null, processed: 0 });
            if (processed) try { notifyUser?.({ kind: 'success', text: manualHistorical ? `千千结已完成 AI #${fromAssistantSeq}–${toAssistantSeq} 的历史记忆重建。` : `千千结已自动更新 AI #${fromAssistantSeq}–${toAssistantSeq} 的记忆与状态。` }); } catch { /* notification must not affect committed memory */ }
            return notify();
          }
          if (assessment.status === 'historicalDebt' && !manualHistorical) {
            lastAutoRun = Object.freeze({ status: 'authorizationRequired', reason, mode: 'historical', batchSize: config.batchSize, available: assessment.total - assessment.completed, fromAssistantSeq: assessment.nextAssistantSeq, toAssistantSeq: reachable.floors.at(-1)?.assistantSeq ?? null, processed: 0 });
            return notify();
          }
          operation.mode = historical ? 'historical' : 'realtime';
          const pending = (reachable.floors ?? []).slice(assessment.completed);
          if (!historical && pending.length < config.batchSize) {
            lastAutoRun = Object.freeze({ status: 'waiting', reason, mode: 'realtime', batchSize: config.batchSize, available: pending.length, fromAssistantSeq: pending[0]?.assistantSeq ?? null, toAssistantSeq: pending.at(-1)?.assistantSeq ?? null });
            return notify();
          }
          const targets = pending.slice(0, historical ? Math.min(config.batchSize, pending.length) : config.batchSize);
          if (!targets.length) return notify();
          resumed ||= assessment.hasPartialWork;
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
              lastAutoRun = Object.freeze({ status: 'failed', reason, mode: operation.mode, phase: 'extracting', batchSize: config.batchSize, floorId: floor.id, assistantSeq: floor.assistantSeq, message: getState().lastExtractorError?.message ?? 'FloorMemory 提取失败，可点击继续重建后从本楼重试。' });
              return notify();
            }
          }
          if (!allowed()) return getState();
          operation.phase = 'analyzingCse';
          notify();
          for (const floor of targets) {
            if (!allowed()) return getState();
            const before = getState().floors.find(item => item.floorId === floor.id);
            if (!['ready', 'noChange'].includes(before?.cse?.status)) await cseRuntime.analyzeFloor(floor.id);
            if (!allowed()) return getState();
            const after = getState().floors.find(item => item.floorId === floor.id);
            if (!['ready', 'noChange'].includes(after?.cse?.status)) {
              if (manualHistorical && historicalAuthorization === authorizedChatId) historicalAuthorization = null;
              lastAutoRun = Object.freeze({ status: 'failed', reason, mode: operation.mode, phase: 'analyzingCse', batchSize: config.batchSize, floorId: floor.id, assistantSeq: floor.assistantSeq, message: getState().lastCseError?.message ?? 'CSE 分析失败，可点击继续重建后从本楼重试。' });
              return notify();
            }
          }
          await load();
          fromAssistantSeq ??= targets[0].assistantSeq;
          toAssistantSeq = targets.at(-1).assistantSeq;
          processed += targets.length;
          if (!historical) {
            lastAutoRun = Object.freeze({ status: 'completed', reason, mode: 'realtime', batchSize: config.batchSize, recovered: resumed, fromAssistantSeq, toAssistantSeq, processed });
            try { notifyUser?.({ kind: 'success', text: `千千结已自动更新 AI #${fromAssistantSeq}–${toAssistantSeq} 的记忆与状态。` }); } catch { /* notification must not affect committed memory */ }
            return notify();
          }
        }
        return getState();
      } catch (error) {
        if (operation.token === autoEpoch) {
          if (manualHistorical && historicalAuthorization === authorizedChatId) historicalAuthorization = null;
          lastAutoRun = Object.freeze({ status: 'failed', reason, phase: operation.phase, batchSize: config.batchSize, floorId: operation.floorIds[0] ?? null, assistantSeq: null, message: safeErrorMessage(error?.message ?? '自动记忆失败，将在下一次稳定回复后重试。') });
          logger?.warn?.('[qianqianjie] V3 automatic memory failed', { code: error?.code ?? error?.name ?? 'V3_AUTO_MEMORY_FAILED' });
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
    }
    return Promise.resolve(notify());
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
      eventSource.on(generationStartedEvent, (_type, _options, dryRun) => {
        if (dryRun === true) return;
        formalGenerationActive = true;
      });
      eventSource.on(generationStoppedEvent, () => { formalGenerationActive = false; });
      eventSource.on(generationEndedEvent, () => { formalGenerationActive = false; });
    }
    for (const name of EVENTS) {
      const eventName = eventTypes[name]; if (!eventName) continue;
      eventSource.on(eventName, () => {
        cancelAutomation();
        epoch += 1;
        active?.controller.abort();
        active = null;
        workRun = null;
        reachable = null;
        coverage = unknownCoverage(0);
        lastFailure = null;
        sessionCandidates.clear();
        cseRuntime.invalidate();
        awaitingFoundation = true;
        if (name !== 'MESSAGE_RECEIVED') emptyRealtimeOrigin = null;
        if (name === 'MESSAGE_RECEIVED' && automation().enabled) autoTriggerReason = name;
        if (name === 'CHAT_CHANGED' || HISTORY_MUTATION_EVENTS.has(name)) lastAutoRun = null;
        notify();
      });
    }
    bound = true; return true;
  }
  async function start() { if (!enabled()) return notify(); await foundationRuntime.start(); return load(); }
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
    if (!reachable?.root || assessment.status !== 'historicalDebt') return notify();
    historicalAuthorization = reachable.root.chatId;
    return scheduleAutomation(MANUAL_HISTORY_REASON);
  }
  const shouldBlockMainGeneration = () => Boolean(enabled() && historicalAuthorization && reachable?.root?.chatId === historicalAuthorization);
  const allowsRealtimeTailFromEmpty = () => Boolean(emptyRealtimeOrigin && (reachable?.root
    ? emptyRealtimeOrigin.chatId === reachable.root.chatId
      && (emptyRealtimeOrigin.narrativeGeneration === null || emptyRealtimeOrigin.narrativeGeneration === reachable.root.narrativeGeneration)
    : emptyRealtimeOrigin.narrativeGeneration === null && emptyRealtimeOrigin.chatId === currentHostChatId()));
  function pauseHistoricalRebuild() {
    const wasHistorical = historicalAuthorization !== null || (workRun?.kind === 'auto' && workRun.mode === 'historical');
    historicalAuthorization = null;
    if (autoTriggerReason === MANUAL_HISTORY_REASON) autoTriggerReason = null;
    if (workRun?.kind === 'auto' && workRun.mode === 'historical') {
      autoEpoch += 1;
      active?.controller.abort();
      cseRuntime.cancelActive?.();
    }
    if (wasHistorical) lastAutoRun = Object.freeze({ status: 'paused', reason: MANUAL_HISTORY_REASON, mode: 'historical', batchSize: automation().batchSize, available: Math.max(0, coverage.total - coverage.completed), fromAssistantSeq: coverage.nextAssistantSeq, toAssistantSeq: reachable?.floors?.at(-1)?.assistantSeq ?? null, processed: 0 });
    return notify();
  }
  const retryAutomation = async () => {
    while (autoScheduled || workRun?.promise) await (autoScheduled ?? workRun.promise);
    return coverage.status === 'historicalDebt' ? startHistoricalRebuild() : scheduleAutomation('manualRetry');
  };
  const analyzeNextState = () => runManualWork('analyzingCse', async operation => { operation.phase = 'analyzingCse'; notify(); await cseRuntime.analyzeNext(); return notify(); });
  const retryStateAnalysis = floorId => runManualWork('analyzingCse', async operation => { operation.floorIds = [floorId]; operation.phase = 'analyzingCse'; notify(); await cseRuntime.analyzeFloor(floorId); return notify(); });
  return Object.freeze({ bind, start, setEnabled, refreshAutomation, startHistoricalRebuild, pauseHistoricalRebuild, retryAutomation, invalidate, refreshStatus, confirmLatest, extractNext, extractFloor, analyzeNextState, retryStateAnalysis, editSummary, restoreAi, markError, copySafeDiagnostic, copyFullDiagnostic, shouldBlockMainGeneration, allowsRealtimeTailFromEmpty, getState, subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); } });
}
