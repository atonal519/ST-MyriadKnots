import { newIdentityUuid, sha256 } from '../identity.js';
import { buildFoundationIndexes } from './foundation-runtime.js';
import { createCheckpointInputFingerprints, deterministicUuid, selectAssistantMessage } from './foundation-domain.js';
import { validateFoundationCheckpoint, validateFoundationRoot, validateFoundationRun } from './foundation-schema.js';
import { validateCseGraph, validateStateDeltaRecord } from './cse-schema.js';
import { diagnosticsWithRealtimeOrigin, realtimeOriginFromReachable } from './memory-coverage.js';
import {
  CSE_COMPILER_VERSION, CSE_PROMPT_VERSION, buildCseSystemPrompt, captureCseBaseline, createBaselineRoleEntities,
  createCseEnvelope, createManualCseCorrection, deriveCseTimeline, filterReachableDeltas, replayCurrentState, runCseRequest, selectTrackedSubjects, verifyCseBaselineFingerprint,
} from './cse-engine.js';
import { sanitizeDiagnosticValue, sanitizeSensitiveText } from './safe-metadata.js';
import { buildEntityIdentityDirectory, entitiesThroughFloorIds, identityLabelKey } from './entity-identity.js';
import { captureCseRequestSources } from '../cse-source-selection.js';

const emptyManifest = () => ({ floor: [], entity: [], event: [], claim: [], knowledge: [], episode: [], thread: [], state: [], anchor: [], reverseRef: [] });
const PHASE_A_PERSIST_CONCURRENCY = 6;
const nowIso = now => { const value = now()?.toISOString?.() ?? String(now()); if (!Number.isFinite(Date.parse(value))) throw new TypeError('V3_CSE_TIME_INVALID'); return value; };
const hash = async value => `sha256:${await sha256(JSON.stringify(value))}`;
const errorWith = (code, message) => { const error = new Error(message ?? code); error.code = code; return error; };

const normalizedMessageText = value => String(value ?? '').replace(/\r\n?/g, '\n');
const coreMeaning = items => JSON.stringify((items ?? []).map(item => [item.text, item.visibility, item.towardEntityId ?? null]));
const baselineSemanticPayload = baseline => baseline ? {
  userPersona: { ...baseline.userPersona, entityId: null },
  characterCard: { ...baseline.characterCard, entityId: null },
  worldInfoSources: baseline.worldInfoSources,
} : null;

async function captureCurrentUserInput({ hostAdapter, floor, expectedChatId }) {
  const snapshot = hostAdapter.snapshot();
  const qqjChatId = String(snapshot.context?.chatMetadata?.qianqianjie?.chatId ?? '').trim();
  const messageIndex = floor?.hostLocator?.messageIndex;
  const selected = Number.isSafeInteger(messageIndex) ? selectAssistantMessage(snapshot.chat[messageIndex]) : null;
  if (qqjChatId !== expectedChatId || !selected) {
    throw errorWith('V3_CSE_STALE', '目标楼当前选中正文或聊天身份已变化，迟到状态不会写入。');
  }
  if (messageIndex === 0) return null;
  const previous = snapshot.chat[messageIndex - 1];
  if (!previous || previous.is_user !== true || (previous.is_system === true && previous.extra?.type)) return null;
  let content = '';
  let selectedSwipeIndex = null;
  let swipeId = null;
  if (Array.isArray(previous.swipes)) {
    selectedSwipeIndex = Number.isSafeInteger(previous.swipe_id) ? previous.swipe_id : 0;
    const selectedUser = previous.swipes[selectedSwipeIndex];
    if (typeof selectedUser !== 'string') return null;
    content = normalizedMessageText(selectedUser);
    swipeId = previous.swipe_id ?? selectedSwipeIndex;
  } else if (typeof previous.mes === 'string') content = normalizedMessageText(previous.mes);
  if (!content.trim()) return null;
  return Object.freeze({ messageIndex: messageIndex - 1, swipeId, selectedSwipeIndex, content, fingerprint: `sha256:${await sha256(content)}` });
}

async function dependencySnapshot(value, floorId, entities, previousState, storyClockSignatureForFloor, currentUserInput, coreUserEditedSubjectEntityIds = [], hostAdapter) {
  const targetIndex = value?.floors?.findIndex(floor => floor.id === floorId) ?? -1;
  if (targetIndex < 0 || !value?.baseline) return null;
  const floors = value.floors.slice(0, targetIndex + 1);
  const floorIds = new Set(floors.map(floor => floor.id));
  const activeMemoryIds = floors.map(floor => (value.floorMemories ?? [])
    .filter(memory => memory.floorId === floor.id && memory.recordStatus === 'active')
    .map(memory => memory.id).sort());
  const deltas = filterReachableDeltas({ floors: value.floors, floorMemories: value.floorMemories ?? [], stateDeltas: value.stateDeltas ?? [] });
  const deltaByFloor = new Map(deltas.map(delta => [delta.floorId, delta.id]));
  const identityDirectory = buildEntityIdentityDirectory({ entities, floorIds }).map(entry => ({
    entityId: entry.entityId,
    entityType: entry.entityType,
    specialRole: entry.specialRole,
    displayName: entry.displayName,
    labels: [...entry.labels].map(label => [identityLabelKey(label), label]).sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1])),
  })).sort((left, right) => left.entityId.localeCompare(right.entityId));
  return {
    chatId: value.root.chatId,
    narrativeGeneration: value.root.narrativeGeneration,
    baseline: { id: value.baseline.id, fingerprint: value.baseline.fingerprint },
    floors: floors.map(floor => ({ id: floor.id, rawFingerprint: floor.content.rawFingerprint, canonicalFingerprint: floor.content.canonicalFingerprint,
      storyClockSignature: storyClockSignatureForFloor(floor) })),
    activeMemoryIds,
    precedingDeltaIds: floors.slice(0, -1).map(floor => deltaByFloor.get(floor.id) ?? null),
    targetDeltaId: deltaByFloor.get(floorId) ?? null,
    previousStateFingerprint: previousState?.fingerprint ?? null,
    identityDirectory,
    currentUserInput: currentUserInput ? { messageIndex: currentUserInput.messageIndex, swipeId: currentUserInput.swipeId, selectedSwipeIndex: currentUserInput.selectedSwipeIndex, fingerprint: currentUserInput.fingerprint } : null,
    coreUserEditedSubjectEntityIds: [...coreUserEditedSubjectEntityIds].sort(),
  };
}

const sameDependencySnapshot = (left, right) => Boolean(left && right && JSON.stringify(left) === JSON.stringify(right));

export function createCseRuntime({ store, hostAdapter, generateAnalysisTask, isEnabled = true, promptGuidance = () => '', processingPrompt = () => '', filterWorldInfoSources = sources => sources, sanitizerOptions = () => ({}), storyClockSignatureForFloor = () => '', onGraphCommitted = null, now = () => new Date(), newUuid = newIdentityUuid, logger = console } = {}) {
  if (!store || ['readReachable', 'putRecord', 'commitRoot', 'recordKey'].some(name => typeof store[name] !== 'function')) throw new TypeError('V3 CSE store 无效');
  if (typeof generateAnalysisTask !== 'function') throw new TypeError('V3 CSE analysis route 无效');
  if (typeof filterWorldInfoSources !== 'function') throw new TypeError('V3 CSE 世界书过滤器无效');
  let epoch = 0, active = null, reachable = null, replayed = null, lastFailure = null, replayDiagnostic = null;
  const subscribers = new Set();
  const enabled = () => { try { return (typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true; } catch { return false; } };
  const notify = () => { const state = getState(); for (const listener of subscribers) { try { listener(state); } catch { /* listener isolation */ } } return state; };

  async function coreUserEditedSubjects(deltas) {
    const protectedIds = new Set();
    const cache = new Map(deltas.map(delta => [delta.id, delta]));
    for (const activeDelta of deltas) {
      for (const audit of activeDelta.source?.calibrationAudit ?? []) {
        if (audit.category === 'core' && audit.evidence?.some(evidence => evidence.source === 'currentUserInput')) protectedIds.add(audit.subjectEntityId);
      }
      let delta = activeDelta;
      const visited = new Set();
      while (delta?.source?.manualSubjectEntityIds?.length && !visited.has(delta.id)) {
        visited.add(delta.id);
        let anchor = delta.supersedes ? cache.get(delta.supersedes) : null;
        if (!anchor && delta.supersedes && typeof store.readRecord === 'function') {
          const read = await store.readRecord('stateDelta', delta.supersedes);
          if (read.status === 'ready') { anchor = read.data; cache.set(anchor.id, anchor); }
        }
        for (const subjectId of delta.source.manualSubjectEntityIds) {
          const currentSubject = delta.subjectSnapshots.find(subject => subject.subjectEntityId === subjectId);
          const anchorSubject = anchor?.subjectSnapshots?.find(subject => subject.subjectEntityId === subjectId);
          if (currentSubject?.core?.some(item => item.origin === 'manual')
            || (anchorSubject && coreMeaning(currentSubject?.core) !== coreMeaning(anchorSubject.core))) protectedIds.add(subjectId);
        }
        delta = anchor;
      }
    }
    return [...protectedIds];
  }

  async function calculateReplay(value) {
    if (!value?.baseline) { replayed = null; replayDiagnostic = null; return; }
    const stored = value.currentStates?.at(-1) ?? null;
    const rebuilt = await replayCurrentState({ chatId: value.root.chatId, narrativeGeneration: value.root.narrativeGeneration, baselineId: value.baseline.id, floors: value.floors, floorMemories: value.floorMemories, stateDeltas: value.stateDeltas, now: nowIso(now) });
    replayed = stored?.fingerprint === rebuilt.fingerprint ? stored : rebuilt;
    replayDiagnostic = stored && stored.fingerprint !== rebuilt.fingerprint
      ? { code: 'V3_CSE_REPLAY_MISMATCH', message: '已存当前状态与可信增量重放不一致；界面已采用本地重放结果。', storedId: stored.id, replayFingerprint: rebuilt.fingerprint }
      : null;
  }

  async function load(providedReachable = null) {
    const value = providedReachable ?? await store.readReachable({ mode: 'runtime' });
    if (!['ready', 'needsReseal'].includes(value.status)) {
      if (value.status === 'uninitialized') { reachable = null; replayed = null; return notify(); }
      throw errorWith('V3_CSE_LOAD_FAILED', `CSE 图读取失败：${value.status}`);
    }
    reachable = value;
    await calculateReplay(value);
    return notify();
  }

  function getState() {
    const floors = reachable?.floors ?? [];
    const entities = new Map((reachable?.entities ?? []).map(entity => [entity.id, entity]));
    const memoryByFloor = new Map((reachable?.floorMemories ?? []).filter(memory => memory.recordStatus === 'active').map(memory => [memory.floorId, memory]));
    const reachableDeltas = filterReachableDeltas({ floors, floorMemories: reachable?.floorMemories ?? [], stateDeltas: reachable?.stateDeltas ?? [] });
    const deltaByFloor = new Map(reachableDeltas.map(delta => [delta.floorId, delta]));
    const timelineByFloor = new Map(deriveCseTimeline(reachableDeltas).map(item => [item.floorId, item]));
    const floorSeq = new Map(floors.map(floor => [floor.id, floor.assistantSeq]));
    const historyItem = item => item ? Object.freeze({
      text: item.text,
      visibility: item.visibility,
      reason: item.reason,
      origin: item.origin,
      towardEntityId: item.towardEntityId ?? null,
      towardDisplayName: entities.get(item.towardEntityId)?.displayName ?? null,
      sourceFloorId: item.sourceFloorId ?? null,
      sourceAssistantSeq: floorSeq.get(item.sourceFloorId) ?? null,
    }) : null;
    const cseFloors = floors.map(floor => {
      const memory = memoryByFloor.get(floor.id), delta = deltaByFloor.get(floor.id), timeline = timelineByFloor.get(floor.id);
      const running = active?.floorId === floor.id;
      const failure = lastFailure?.floorId === floor.id ? lastFailure : null;
      const status = !memory ? 'notApplicable' : running ? 'running' : delta ? (timeline?.noMaterialChange ? 'noChange' : 'ready') : failure && failure.code !== 'V3_CSE_PREVIOUS_GAP' ? 'failed' : 'pending';
      const record = delta ? Object.freeze({
        noMaterialChange: timeline?.noMaterialChange ?? true,
        isolationSummary: timeline?.isolationSummary ?? null,
        subjects: Object.freeze((timeline?.changes ?? []).map(subject => Object.freeze({
          subjectEntityId: subject.subjectEntityId,
          displayName: entities.get(subject.subjectEntityId)?.displayName ?? '未知人物',
          changes: Object.freeze(subject.items.map(item => Object.freeze({
            category: item.category,
            action: item.action,
            beforeText: item.before?.text ?? null,
            afterText: item.after?.text ?? null,
            before: historyItem(item.before),
            after: historyItem(item.after),
          }))),
        }))),
        endStateSubjects: Object.freeze((timeline?.endStateSubjects ?? []).filter(subject => ['core', 'adaptive', 'situational'].some(category => subject[category]?.length)).map(subject => Object.freeze({
          subjectEntityId: subject.subjectEntityId,
          displayName: entities.get(subject.subjectEntityId)?.displayName ?? '未知人物',
          core: Object.freeze((subject.core ?? []).map(historyItem)),
          adaptive: Object.freeze((subject.adaptive ?? []).map(historyItem)),
          situational: Object.freeze((subject.situational ?? []).map(historyItem)),
        }))),
      }) : null;
      return Object.freeze({ floorId: floor.id, floorMemoryId: memory?.id ?? null, status, deltaId: delta?.id ?? null, noMaterialChange: timeline?.noMaterialChange ?? false, record, error: failure?.message ?? null });
    });
    const subjects = (replayed?.subjects ?? []).map(subject => ({
      subjectEntityId: subject.subjectEntityId,
      displayName: entities.get(subject.subjectEntityId)?.displayName ?? (subject.subjectEntityId === reachable?.baseline?.userPersona?.entityId ? reachable.baseline.userPersona.name : reachable?.baseline?.characterCard?.name) ?? '未知人物',
      core: subject.core.map(item => ({ ...item, sourceAssistantSeq: floorSeq.get(item.sourceFloorId) ?? null })),
      adaptive: subject.adaptive.map(item => ({ ...item, towardDisplayName: entities.get(item.towardEntityId)?.displayName ?? null, sourceAssistantSeq: floorSeq.get(item.sourceFloorId) ?? null })),
      situational: subject.situational.map(item => ({ ...item, towardDisplayName: entities.get(item.towardEntityId)?.displayName ?? null, sourceAssistantSeq: floorSeq.get(item.sourceFloorId) ?? null })),
    }));
    const pendingCount = cseFloors.filter(item => item.status === 'pending').length;
    const mainCharacterEntityId = reachable?.baseline?.characterCard?.entityId ?? null;
    const mainCharacterDisplayName = mainCharacterEntityId
      ? entities.get(mainCharacterEntityId)?.displayName ?? reachable?.baseline?.characterCard?.name ?? null
      : null;
    const anchorFloorIndex = floors.findIndex(floor => floor.id === reachableDeltas.at(-1)?.floorId);
    const anchorFloorIds = new Set(floors.slice(0, anchorFloorIndex + 1).map(floor => floor.id));
    const cseTowardCandidates = buildEntityIdentityDirectory({ entities: reachable?.entities ?? [], floorIds: anchorFloorIds })
      .filter(entry => entry.entityType === 'person')
      .map(entry => Object.freeze({ entityId: entry.entityId, displayName: entry.displayName }));
    return Object.freeze({ cseReady: reachable?.root?.capabilities?.cseReady === true, baselineId: reachable?.baseline?.id ?? null, mainCharacterEntityId, mainCharacterDisplayName, currentStateId: replayed?.id ?? null, currentStateFingerprint: replayed?.fingerprint ?? null, replayedCurrentState: replayed, cseTowardCandidates: Object.freeze(cseTowardCandidates), cseSubjects: Object.freeze(subjects), cseFloors: Object.freeze(cseFloors), csePendingCount: pendingCount, cseFailedCount: cseFloors.filter(item => item.status === 'failed').length, activeCse: active ? { floorId: active.floorId, runId: active.runId, phase: active.phase } : null, lastCseError: lastFailure, cseReplayDiagnostic: replayDiagnostic, csePromptVersion: CSE_PROMPT_VERSION, cseCompilerVersion: CSE_COMPILER_VERSION });
  }

  async function persist(records, signal) {
    for (const record of records) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const result = await store.putRecord(record, { signal });
      if (!['saved', 'reused'].includes(result.status)) throw errorWith('V3_CSE_PERSIST_FAILED', `CSE 记录写入失败：${result.status}`);
    }
  }

  async function persistPhaseA(records, signal) {
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
          if (!['saved', 'reused'].includes(result.status)) throw errorWith('V3_CSE_PERSIST_FAILED', `CSE 记录写入失败：${result.status}`);
        } catch (error) {
          firstError ??= error;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(PHASE_A_PERSIST_CONCURRENCY, records.length) }, () => worker()));
    if (firstError) throw firstError;
  }

  async function ensureBaseline(value, operation) {
    if (value.baseline) return value;
    const created = await captureCseBaseline({ hostAdapter, chatId: value.root.chatId, narrativeGeneration: value.root.narrativeGeneration, entities: value.entities, sanitizerOptions: typeof sanitizerOptions === 'function' ? sanitizerOptions() : sanitizerOptions, now: operation.startedAt });
    const saved = await store.putRecord(created.baseline, { signal: operation.controller.signal });
    let adopted = ['saved', 'reused'].includes(saved.status) ? saved.data : null;
    if (saved.status === 'conflict') {
      const orphan = await store.readRecord('baseline', created.baseline.id);
      if (orphan.status === 'ready' && orphan.data.id === created.baseline.id && orphan.data.chatId === value.root.chatId && orphan.data.recordStatus === 'active' && await verifyCseBaselineFingerprint(orphan.data)) adopted = orphan.data;
    }
    if (!adopted || !await verifyCseBaselineFingerprint(adopted)) throw errorWith('V3_CSE_BASELINE_PERSIST_FAILED', '聊天基线写入或孤儿基线校验失败。');
    const root = validateFoundationRoot({ ...value.root, baselineId: adopted.id, updatedAt: operation.startedAt }, { expectedChatId: value.root.chatId });
    const committed = await store.commitRoot(root, value.rootRevision, { signal: operation.controller.signal });
    if (committed.status !== 'saved') {
      const winner = await store.readReachable();
      if (winner.status === 'ready' && winner.baseline) return winner;
      throw errorWith(committed.status === 'conflict' ? 'V3_CSE_BASELINE_CAS_CONFLICT' : 'V3_CSE_BASELINE_COMMIT_FAILED', '聊天基线提交遇到并发变化，未覆盖新数据。');
    }
    const next = await store.readReachable();
    if (next.status !== 'ready' || !next.baseline) throw errorWith('V3_CSE_BASELINE_COLD_READ_FAILED', '聊天基线提交后回读失败。');
    return next;
  }

  async function commitDeltaGraph({ operation, current, floor, memory, delta, deltas, entities, diagnostics }) {
    const nowValue = nowIso(now);
    const runId = operation.runId;
    const checkpointId = await deterministicUuid(['v3-cse-checkpoint', current.root.headCheckpointId, delta.id]);
    const indexes = await buildFoundationIndexes({ chatId: current.root.chatId, narrativeGeneration: current.root.narrativeGeneration, checkpointId, floors: current.floors, candidates: current.floors.map(item => ({ hostLocator: item.hostLocator, rawFingerprint: item.content.rawFingerprint, canonicalFingerprint: item.content.canonicalFingerprint })), entities, now: nowValue });
    const indexKeys = indexes.map(index => store.recordKey(index));
    const previousState = current.currentStates.at(-1) ?? null;
    const currentState = await replayCurrentState({ chatId: current.root.chatId, narrativeGeneration: current.root.narrativeGeneration, baselineId: current.baseline.id, floors: current.floors, floorMemories: current.floorMemories, stateDeltas: deltas, now: nowValue, previousId: previousState?.id ?? null });
    const activeMemories = current.floorMemories.filter(item => item.recordStatus === 'active');
    const cseReady = activeMemories.length > 0 && activeMemories.every(item => deltas.some(itemDelta => itemDelta.floorId === item.floorId && itemDelta.floorMemoryId === item.id));
    const capabilities = { foundationReady: true, memoryReady: activeMemories.length > 0, cseReady, recallReady: false };
    const stateGraphFingerprint = await hash([current.root.narrativeGeneration, current.floors.map(item => item.id), current.floors.map(item => item.content.canonicalFingerprint)]);
    const run = validateFoundationRun({ schemaVersion: 3, recordType: 'run', id: runId, chatId: current.root.chatId, narrativeGeneration: current.root.narrativeGeneration, parentCheckpointId: current.root.headCheckpointId, inputSnapshotFingerprint: current.root.sourceSnapshotFingerprint, mode: 'cse', sessionEpoch: operation.epoch, inputFloorIds: [floor.id], phase: 'completed', completedFloorIds: [floor.id], failedItems: [], preparedRecordRefs: [store.recordKey(delta), store.recordKey(currentState), ...indexKeys, `v3-checkpoint-${checkpointId}`], diagnostics: { ...diagnosticsWithRealtimeOrigin(current.run?.diagnostics, realtimeOriginFromReachable(current)), ...diagnostics, floorId: floor.id, floorMemoryId: memory.id }, startedAt: operation.startedAt, createdAt: nowValue, updatedAt: nowValue, recordStatus: 'active', supersedes: null }, { expectedChatId: current.root.chatId });
    const checkpoint = validateFoundationCheckpoint({ schemaVersion: 3, recordType: 'checkpoint', id: checkpointId, chatId: current.root.chatId, narrativeGeneration: current.root.narrativeGeneration, parentCheckpointId: current.root.headCheckpointId, runId, sourceSnapshotFingerprint: current.root.sourceSnapshotFingerprint, capabilities, floorRange: { fromAssistantSeq: current.floors.length ? 1 : 0, toAssistantSeq: current.floors.length, floorIds: current.floors.map(item => item.id) }, inputFingerprints: createCheckpointInputFingerprints(current.floors, { previous: current.checkpoint?.inputFingerprints }), producedRefs: { floors: current.floors.map(item => item.id), floorMemories: current.floorMemories.map(item => item.id), entities: entities.map(item => item.id), events: [], claims: [], knowledge: [], stateDeltas: deltas.map(item => item.id), currentStates: [currentState.id], stateProjections: [], episodes: [], threads: [], indexes: indexKeys }, validation: { schemaValid: true, referencesValid: true, orderedReplayValid: true, stateFingerprint: stateGraphFingerprint }, sealedAt: nowValue, createdAt: nowValue, updatedAt: nowValue, recordStatus: 'active', supersedes: null }, { expectedChatId: current.root.chatId });
    const root = validateFoundationRoot({ ...current.root, capabilities, headCheckpointId: checkpointId, indexManifest: { ...emptyManifest(), floor: indexKeys.filter(key => key.includes('-floorOrder-') || key.includes('-fingerprint-')), entity: indexKeys.filter(key => key.includes('-entity-')), reverseRef: indexKeys.filter(key => key.includes('-reverseRef-')) }, activeStateRefs: [currentState.id], updatedAt: nowValue }, { expectedChatId: current.root.chatId });
    await validateCseGraph({ root, checkpoint, run, floors: current.floors, floorMemories: current.floorMemories, entities, indexes, indexKeys, baseline: current.baseline, stateDeltas: deltas, currentStates: [currentState] });
    const newEntities = entities.filter(entity => !current.entities.some(old => old.id === entity.id));
    await persistPhaseA([...newEntities, delta, currentState, ...indexes], operation.controller.signal);
    await persist([run, checkpoint], operation.controller.signal);
    if (operation.epoch !== epoch || operation.controller.signal.aborted) throw errorWith('V3_CSE_STALE', 'CSE 操作已取消。');
    const committed = await store.commitRoot(root, current.rootRevision, { signal: operation.controller.signal });
    if (committed.status !== 'saved') throw errorWith(committed.status === 'conflict' ? 'V3_CSE_CAS_CONFLICT' : 'V3_CSE_COMMIT_FAILED', 'CSE 提交遇到并发更新，未覆盖新数据。');
    if (operation.epoch !== epoch || operation.controller.signal.aborted) throw errorWith('V3_CSE_STALE', 'CSE 操作已取消。');
    const next = committed.reachable;
    if (next?.status !== 'ready') throw errorWith('V3_CSE_COMMIT_SNAPSHOT_INVALID', 'CSE 提交后的已验证快照无效。');
    reachable = next; await calculateReplay(next); onGraphCommitted?.(next); lastFailure = null; return notify();
  }

  async function commitDelta(operation, result, roleEntities) {
    const current = await store.readReachable({ mode: 'runtime' });
    if (current.status !== 'ready' || operation.epoch !== epoch || operation.controller.signal.aborted) throw errorWith('V3_CSE_STALE', '聊天或记忆在分析期间已变化，迟到状态不会写入。');
    const floor = current.floors.find(item => item.id === operation.floorId);
    const memory = current.floorMemories.find(item => item.id === operation.floorMemoryId && item.floorId === operation.floorId && item.recordStatus === 'active');
    const memoryClockSignature = memory?.sourceStoryClockSignature ?? current.run?.diagnostics?.floorProvenance?.[floor?.id]?.storyClockSignature ?? storyClockSignatureForFloor(floor);
    if (!floor || !memory || !current.baseline || floor.content.canonicalFingerprint !== operation.floorFingerprint || floor.content.rawFingerprint !== operation.floorRawFingerprint || memoryClockSignature !== operation.storyClockSignature) throw errorWith('V3_CSE_STALE', '当前楼正文快照、时间戳快照或 FloorMemory 已变化，迟到状态不会写入。');
    const dependencyEntitiesById = new Map(current.entities.map(entity => [entity.id, entity]));
    for (const entity of roleEntities) if (!dependencyEntitiesById.has(entity.id)) dependencyEntitiesById.set(entity.id, entity);
    const dependencyTargetIndex = current.floors.findIndex(item => item.id === operation.floorId);
    const dependencyPrecedingFloors = current.floors.slice(0, dependencyTargetIndex);
    const dependencyPrecedingIds = new Set(dependencyPrecedingFloors.map(item => item.id));
    const dependencyPrecedingMemories = current.floorMemories.filter(item => item.recordStatus === 'active' && dependencyPrecedingIds.has(item.floorId));
    const dependencyPrecedingDeltas = filterReachableDeltas({ floors: dependencyPrecedingFloors, floorMemories: dependencyPrecedingMemories, stateDeltas: current.stateDeltas });
    const dependencyPreviousState = dependencyPrecedingDeltas.length
      ? await replayCurrentState({ chatId: current.root.chatId, narrativeGeneration: current.root.narrativeGeneration, baselineId: current.baseline?.id, floors: dependencyPrecedingFloors, floorMemories: dependencyPrecedingMemories, stateDeltas: dependencyPrecedingDeltas, now: nowIso(now) })
      : null;
    const currentUserInput = await captureCurrentUserInput({ hostAdapter, floor, expectedChatId: current.root.chatId });
    const coreUserEditedSubjectEntityIds = await coreUserEditedSubjects(dependencyPrecedingDeltas);
    const currentDependency = await dependencySnapshot(current, operation.floorId, [...dependencyEntitiesById.values()], dependencyPreviousState, currentFloor => current.floorMemories.find(item => item.floorId === currentFloor.id && item.recordStatus === 'active')?.sourceStoryClockSignature ?? current.run?.diagnostics?.floorProvenance?.[currentFloor.id]?.storyClockSignature ?? storyClockSignatureForFloor(currentFloor), currentUserInput, coreUserEditedSubjectEntityIds, hostAdapter);
    if (!sameDependencySnapshot(operation.dependencySnapshot, currentDependency)) throw errorWith('V3_CSE_STALE', '人物状态所依赖的楼层前缀、摘要、前态或身份目录已变化，迟到状态不会写入。');
    const floorOrder = new Map(current.floors.map((item, index) => [item.id, index]));
    const deltas = filterReachableDeltas({ floors: current.floors, floorMemories: current.floorMemories, stateDeltas: current.stateDeltas })
      .filter(delta => floorOrder.get(delta.floorId) < floorOrder.get(floor.id));
    deltas.push(result.delta);
    const entitiesById = new Map(current.entities.map(entity => [entity.id, entity]));
    for (const entity of roleEntities) if (!entitiesById.has(entity.id) && [current.baseline.userPersona.entityId, current.baseline.characterCard.entityId].includes(entity.id)) entitiesById.set(entity.id, entity);
    const entities = [...entitiesById.values()];
    return commitDeltaGraph({ operation, current, floor, memory, delta: result.delta, deltas, entities, diagnostics: { kind: 'cse', promptVersion: CSE_PROMPT_VERSION, compilerVersion: CSE_COMPILER_VERSION, promptGuidanceFingerprint: operation.promptGuidanceFingerprint ?? null, systemPromptFingerprint: operation.systemPromptFingerprint ?? null, api: result.metadata, attempts: result.attempts, transportAttempts: result.transportAttempts, responseFingerprint: result.responseFingerprint, isolated: result.isolated.slice(-40), sourceSelection: operation.sourceDiagnostics ?? null, cseRebuild: operation.cseRebuild } });
  }

  async function analyzeFloor(floorId, { cseRebuild = null } = {}) {
    if (!enabled()) return notify();
    if (active) return getState();
    await load();
    let value = reachable;
    const floor = value?.floors?.find(item => item.id === floorId);
    const memory = value?.floorMemories?.find(item => item.floorId === floorId && item.recordStatus === 'active');
    if (!floor || !memory) throw errorWith('V3_CSE_FLOOR_UNAVAILABLE', '只有当前可达且已有 FloorMemory 的楼可以分析状态。');
    const analysisFloor = memory.sourceCanonicalContent ? { ...floor, content: { ...floor.content, canonicalContent: memory.sourceCanonicalContent } } : floor;
    const sourceClockSignature = memory.sourceStoryClockSignature ?? value.run?.diagnostics?.floorProvenance?.[floorId]?.storyClockSignature ?? storyClockSignatureForFloor(floor);
    const operation = { floorId, floorMemoryId: memory.id, floorFingerprint: floor.content.canonicalFingerprint, floorRawFingerprint: floor.content.rawFingerprint, storyClockSignature: sourceClockSignature, cseRebuild: cseRebuild ? structuredClone(cseRebuild) : null, epoch, controller: new AbortController(), runId: await deterministicUuid(['v3-cse-run', value.root.headCheckpointId, memory.id, newUuid()]), startedAt: nowIso(now), phase: 'baseline' };
    active = operation; notify();
    try {
      value = await ensureBaseline(value, operation); reachable = value; await calculateReplay(value);
      operation.phase = 'analyzing'; notify();
      const roleEntities = await createBaselineRoleEntities(value.baseline);
      const entitiesById = new Map(value.entities.map(entity => [entity.id, entity]));
      for (const entity of roleEntities) if (!entitiesById.has(entity.id)) entitiesById.set(entity.id, entity);
      const entities = [...entitiesById.values()];
      const targetIndex = value.floors.findIndex(item => item.id === floor.id);
      const precedingFloors = value.floors.slice(0, targetIndex);
      const precedingFloorIds = new Set(precedingFloors.map(item => item.id));
      const trackedFloorIds = new Set(value.floors.slice(0, targetIndex + 1).map(item => item.id));
      const scopedEntities = entitiesThroughFloorIds(entities, trackedFloorIds);
      const precedingMemoryRecords = value.floorMemories.filter(item => precedingFloorIds.has(item.floorId));
      const precedingMemories = precedingMemoryRecords.filter(item => item.recordStatus === 'active');
      const brokenMemoryFloor = precedingFloors.some(precedingFloor => {
        const records = precedingMemoryRecords.filter(item => item.floorId === precedingFloor.id);
        return records.length > 0 && records.filter(item => item.recordStatus === 'active').length !== 1;
      });
      const precedingDeltas = filterReachableDeltas({ floors: precedingFloors, floorMemories: precedingMemories, stateDeltas: value.stateDeltas });
      if (brokenMemoryFloor || precedingDeltas.length !== precedingMemories.length) throw errorWith('V3_CSE_PREVIOUS_GAP', '前面还有未分析或已失效的楼；请先从最早待分析楼继续，当前楼保持待分析。');
      const rebuiltPrevious = precedingDeltas.length
        ? await replayCurrentState({ chatId: value.root.chatId, narrativeGeneration: value.root.narrativeGeneration, baselineId: value.baseline.id, floors: precedingFloors, floorMemories: precedingMemories, stateDeltas: precedingDeltas, now: nowIso(now) })
        : null;
      const storedPrevious = value.currentStates?.at(-1) ?? null;
      const previousCurrentState = rebuiltPrevious && storedPrevious?.fingerprint === rebuiltPrevious.fingerprint ? storedPrevious : rebuiltPrevious;
      const trackedMemories = value.floorMemories.filter(item => item.recordStatus === 'active' && trackedFloorIds.has(item.floorId));
      const tracked = selectTrackedSubjects({ baseline: value.baseline, entities: scopedEntities, floorMemories: trackedMemories, floorMemory: memory });
      const currentUserInput = await captureCurrentUserInput({ hostAdapter, floor, expectedChatId: value.root.chatId });
      const requestSources = await captureCseRequestSources({
        hostAdapter,
        baseline: value.baseline,
        floor,
        expectedChatId: value.root.chatId,
        filterWorldInfoSources,
        sanitizerOptions: typeof sanitizerOptions === 'function' ? sanitizerOptions() : sanitizerOptions,
        sourceSnapshot: { canonicalContent: memory.sourceCanonicalContent ?? floor.content.canonicalContent, rawFingerprint: memory.sourceRawFingerprint ?? floor.content.rawFingerprint },
      });
      operation.sourceDiagnostics = requestSources.diagnostics;
      const coreUserEditedSubjectEntityIds = await coreUserEditedSubjects(precedingDeltas);
      operation.dependencySnapshot = await dependencySnapshot(value, floor.id, entities, previousCurrentState, currentFloor => value.floorMemories.find(item => item.floorId === currentFloor.id && item.recordStatus === 'active')?.sourceStoryClockSignature ?? value.run?.diagnostics?.floorProvenance?.[currentFloor.id]?.storyClockSignature ?? storyClockSignatureForFloor(currentFloor), currentUserInput, coreUserEditedSubjectEntityIds, hostAdapter);
      if (!operation.dependencySnapshot) throw errorWith('V3_CSE_STALE', '人物状态分析依赖的楼层前缀不可用。');
      const envelope = createCseEnvelope({ floor: analysisFloor, floorMemory: memory, baseline: value.baseline, currentState: previousCurrentState, trackedSubjects: tracked, entities: scopedEntities, requestSources, currentUserInput, coreUserEditedSubjectEntityIds });
      const deltaId = await deterministicUuid(['v3-cse-delta', operation.runId, floor.id, memory.id]);
      const promptGuidanceSnapshot = typeof promptGuidance === 'function' ? promptGuidance() : promptGuidance;
      const processingPromptSnapshot = typeof processingPrompt === 'function' ? processingPrompt() : processingPrompt;
      operation.promptGuidanceFingerprint = `sha256:${await sha256(String(promptGuidanceSnapshot ?? ''))}`;
      operation.systemPromptFingerprint = `sha256:${await sha256(buildCseSystemPrompt(promptGuidanceSnapshot, processingPromptSnapshot))}`;
      const result = await runCseRequest({ generateAnalysisTask, envelope, previousCurrentState, now: nowIso(now), deltaId, promptGuidance: promptGuidanceSnapshot, processingPrompt: processingPromptSnapshot, signal: operation.controller.signal });
      if (operation.epoch !== epoch || operation.controller.signal.aborted) throw errorWith('V3_CSE_STALE', '聊天已变化，迟到 CSE 结果已丢弃。');
      operation.phase = 'committing'; notify();
      await commitDelta(operation, result, roleEntities);
    } catch (error) {
      if (error?.code === 'V3_CSE_PREVIOUS_GAP') lastFailure = { floorId, runId: operation.runId, code: error.code, message: error.message, phase: 'pending' };
      else if (error?.name === 'AbortError' || error?.code === 'V3_CSE_STALE') lastFailure = { floorId, runId: operation.runId, code: 'V3_CSE_STALE', message: '聊天、分支或 FloorMemory 已变化，迟到状态没有写入。', phase: 'stale' };
      else lastFailure = { floorId, runId: operation.runId, code: String(error?.code ?? 'V3_CSE_FAILED').slice(0, 120), message: sanitizeSensitiveText(error?.message ?? '状态分析失败，可单独重试。').slice(0, 500), phase: 'retryableError', diagnostics: sanitizeDiagnosticValue(error?.cseDiagnostics ?? error?.sourceDiagnostics ?? null) };
      logger?.warn?.('[qianqianjie] V3 CSE failed', { code: error?.code ?? error?.name ?? 'V3_CSE_FAILED' });
    } finally { if (active === operation) active = null; }
    return notify();
  }

  async function analyzeNext() {
    await load();
    const deltaByFloor = new Map(filterReachableDeltas({ floors: reachable?.floors ?? [], floorMemories: reachable?.floorMemories ?? [], stateDeltas: reachable?.stateDeltas ?? [] }).map(delta => [delta.floorId, delta]));
    const memoryByFloor = new Map((reachable?.floorMemories ?? []).filter(memory => memory.recordStatus === 'active').map(memory => [memory.floorId, memory]));
    const floor = reachable?.floors?.find(item => memoryByFloor.has(item.id) && !deltaByFloor.has(item.id));
    return floor ? analyzeFloor(floor.id) : getState();
  }

  async function correctSubjectState({ subjectEntityId, expectedCurrentStateId, expectedCurrentStateFingerprint, core, adaptive, situational } = {}) {
    if (!enabled()) throw errorWith('V3_CSE_DISABLED', '人物状态功能当前不可用。');
    if (active) throw errorWith('V3_CSE_BUSY', '人物状态正在处理，请稍后再保存。');
    const current = await store.readReachable({ mode: 'runtime' });
    if (current.status !== 'ready' || !current.baseline) throw errorWith('V3_CSE_MANUAL_TARGET_INVALID', '当前人物状态尚不可编辑。');
    reachable = current;
    await calculateReplay(current);
    if (!replayed || replayed.id !== expectedCurrentStateId || replayed.fingerprint !== expectedCurrentStateFingerprint
      || current.root.chatId !== replayed.chatId || current.root.narrativeGeneration !== replayed.narrativeGeneration) {
      throw errorWith('V3_CSE_MANUAL_STALE', '人物状态已变化，请保留当前草稿并重新打开编辑后再保存。');
    }
    const deltas = filterReachableDeltas({ floors: current.floors, floorMemories: current.floorMemories, stateDeltas: current.stateDeltas });
    const anchor = deltas.at(-1);
    const anchorIndex = current.floors.findIndex(floor => floor.id === anchor?.floorId);
    const floor = anchorIndex >= 0 ? current.floors[anchorIndex] : null;
    const memory = floor ? current.floorMemories.find(item => item.floorId === floor.id && item.id === anchor.floorMemoryId && item.recordStatus === 'active') : null;
    if (!anchor || !floor || !memory || !replayed.subjects.some(subject => subject.subjectEntityId === subjectEntityId)) throw errorWith('V3_CSE_MANUAL_TARGET_INVALID', '只能纠正当前已有状态的人物。');
    const prefixFloorIds = new Set(current.floors.slice(0, anchorIndex + 1).map(item => item.id));
    const towardCandidates = buildEntityIdentityDirectory({ entities: current.entities, floorIds: prefixFloorIds }).filter(entry => entry.entityType === 'person');
    const deltaId = await deterministicUuid(['v3-cse-manual-delta', anchor.id, subjectEntityId, newUuid()]);
    const timestamp = nowIso(now);
    const correction = await createManualCseCorrection({ anchorDelta: anchor, currentState: replayed, subjectEntityId, edits: { core, adaptive, situational }, allowedTowardEntityIds: towardCandidates.map(entry => entry.entityId), deltaId, now: timestamp });
    if (correction.status === 'unchanged') { lastFailure = null; return notify(); }
    const operation = { floorId: floor.id, floorMemoryId: memory.id, epoch, controller: new AbortController(), runId: await deterministicUuid(['v3-cse-manual-run', current.root.headCheckpointId, correction.delta.id]), startedAt: timestamp, phase: 'correcting' };
    active = operation;
    notify();
    try {
      return await commitDeltaGraph({ operation, current, floor, memory, delta: correction.delta, deltas: [...deltas.slice(0, -1), correction.delta], entities: current.entities, diagnostics: { kind: 'cseManualCorrection', promptVersion: CSE_PROMPT_VERSION, compilerVersion: CSE_COMPILER_VERSION, manualSubjectEntityIds: correction.delta.source.manualSubjectEntityIds, cseRebuild: null } });
    } catch (error) {
      lastFailure = { floorId: floor.id, runId: operation.runId, code: String(error?.code ?? 'V3_CSE_MANUAL_SAVE_FAILED').slice(0, 120), message: sanitizeSensitiveText(error?.message ?? '人物状态纠正保存失败。').slice(0, 500), phase: error?.code === 'V3_CSE_MANUAL_STALE' || error?.code === 'V3_CSE_CAS_CONFLICT' || error?.name === 'AbortError' ? 'stale' : 'retryableError' };
      throw error;
    } finally {
      if (active === operation) active = null;
      notify();
    }
  }

  async function restoreRecoveredDelta({ oldDelta, oldDiagnostics, oldFloorId, oldMemoryId, currentFloorId, currentMemoryId, entityMap = new Map(), priorStateDeltas = [] } = {}) {
    if (!enabled() || active || !oldDelta || oldDiagnostics?.kind !== 'cse') return Object.freeze({ status: 'pending', reason: 'unsupportedSource' });
    await load();
    let current = reachable;
    let floor = current?.floors?.find(item => item.id === currentFloorId);
    let memory = current?.floorMemories?.find(item => item.id === currentMemoryId && item.floorId === currentFloorId && item.recordStatus === 'active');
    if (!floor) return Object.freeze({ status: 'pending', reason: 'currentFloorMissing' });
    if (!memory) return Object.freeze({ status: 'pending', reason: 'currentMemoryMissing' });
    if (oldDelta.floorId !== oldFloorId || oldDelta.floorMemoryId !== oldMemoryId) return Object.freeze({ status: 'pending', reason: 'oldDeltaLinkMismatch' });
    if (oldDelta.source?.promptVersion !== CSE_PROMPT_VERSION) return Object.freeze({ status: 'pending', reason: 'csePromptVersionChanged' });
    if (oldDelta.source?.compilerVersion !== CSE_COMPILER_VERSION) return Object.freeze({ status: 'pending', reason: 'cseCompilerVersionChanged' });
    const promptSnapshot = typeof promptGuidance === 'function' ? promptGuidance() : promptGuidance;
    const promptFingerprint = `sha256:${await sha256(String(promptSnapshot ?? ''))}`;
    if (typeof oldDiagnostics.promptGuidanceFingerprint !== 'string') return Object.freeze({ status: 'pending', reason: 'csePromptUnproven' });
    if (oldDiagnostics.promptGuidanceFingerprint !== promptFingerprint) return Object.freeze({ status: 'pending', reason: 'promptChanged' });
    const oldBaselineResult = typeof store.readRecord === 'function' ? await store.readRecord('baseline', oldDelta.baselineId) : null;
    const oldBaseline = oldBaselineResult?.status === 'ready' && await verifyCseBaselineFingerprint(oldBaselineResult.data) ? oldBaselineResult.data : null;
    if (!oldBaseline) return Object.freeze({ status: 'pending', reason: 'oldBaselineUnproven' });
    if (!current?.baseline) {
      const captured = await captureCseBaseline({
        hostAdapter, chatId: current.root.chatId, narrativeGeneration: current.root.narrativeGeneration, entities: current.entities,
        sanitizerOptions: typeof sanitizerOptions === 'function' ? sanitizerOptions() : sanitizerOptions, now: nowIso(now),
      });
      if (JSON.stringify(baselineSemanticPayload(captured.baseline)) !== JSON.stringify(baselineSemanticPayload(oldBaseline))) {
        return Object.freeze({ status: 'pending', reason: 'baselineChanged' });
      }
      const baselineOperation = { epoch, controller: new AbortController(), startedAt: nowIso(now) };
      current = await ensureBaseline(current, baselineOperation);
      reachable = current;
      floor = current?.floors?.find(item => item.id === currentFloorId);
      memory = current?.floorMemories?.find(item => item.id === currentMemoryId && item.floorId === currentFloorId && item.recordStatus === 'active');
      if (!floor || !memory || !current?.baseline
        || JSON.stringify(baselineSemanticPayload(current.baseline)) !== JSON.stringify(baselineSemanticPayload(oldBaseline))) {
        return Object.freeze({ status: 'pending', reason: 'baselineChangedDuringAttach' });
      }
    } else if (current.baseline.id !== oldDelta.baselineId
      && JSON.stringify(baselineSemanticPayload(current.baseline)) !== JSON.stringify(baselineSemanticPayload(oldBaseline))) {
      return Object.freeze({ status: 'pending', reason: 'baselineChanged' });
    }
    const bindBaselineEntity = (oldId, currentId) => {
      const mapped = entityMap.get(oldId);
      if (mapped && mapped !== currentId) return false;
      entityMap.set(oldId, currentId);
      return true;
    };
    if (!bindBaselineEntity(oldBaseline.userPersona.entityId, current.baseline.userPersona.entityId)
      || !bindBaselineEntity(oldBaseline.characterCard.entityId, current.baseline.characterCard.entityId)) {
      return Object.freeze({ status: 'pending', reason: 'baselineEntityChanged' });
    }
    const proofSources = await captureCseRequestSources({
      hostAdapter, baseline: oldBaseline, floor, expectedChatId: current.root.chatId, filterWorldInfoSources,
      sanitizerOptions: typeof sanitizerOptions === 'function' ? sanitizerOptions() : sanitizerOptions,
    });
    if (!oldDiagnostics.sourceSelection?.sourceFingerprint
      || oldDiagnostics.sourceSelection.sourceFingerprint !== proofSources.diagnostics.sourceFingerprint) {
      return Object.freeze({ status: 'pending', reason: 'sourcesChanged' });
    }
    const requestSources = current.baseline.id === oldBaseline.id ? proofSources : await captureCseRequestSources({
      hostAdapter, baseline: current.baseline, floor, expectedChatId: current.root.chatId, filterWorldInfoSources,
      sanitizerOptions: typeof sanitizerOptions === 'function' ? sanitizerOptions() : sanitizerOptions,
    });
    const targetIndex = current.floors.findIndex(item => item.id === currentFloorId);
    if (targetIndex < 0) return Object.freeze({ status: 'pending', reason: 'targetMissing' });
    const precedingFloors = current.floors.slice(0, targetIndex);
    const precedingIds = new Set(precedingFloors.map(item => item.id));
    const currentPrefix = filterReachableDeltas({ floors: precedingFloors, floorMemories: current.floorMemories, stateDeltas: current.stateDeltas });
    const oldFloorOrder = new Map(priorStateDeltas.map((delta, index) => [delta.floorId, index]));
    const priorPrefix = priorStateDeltas.filter(delta => delta.floorId !== oldFloorId && oldFloorOrder.has(delta.floorId));
    if (currentPrefix.length !== priorPrefix.length || currentPrefix.some((delta, index) => delta.id !== priorPrefix[index]?.id)) {
      return Object.freeze({ status: 'pending', reason: 'previousStateChanged' });
    }
    const mapEntity = id => typeof id === 'string' ? entityMap.get(id) ?? id : id;
    const timestamp = nowIso(now);
    const deltaId = await deterministicUuid(['v3-cse-recovered-delta', current.root.headCheckpointId, currentFloorId, currentMemoryId, oldDelta.id]);
    const subjects = [];
    for (const subject of oldDelta.subjectSnapshots) {
      const rebound = { ...subject, subjectEntityId: mapEntity(subject.subjectEntityId) };
      for (const category of ['core', 'adaptive', 'situational']) {
        rebound[category] = [];
        for (const [index, item] of subject[category].entries()) {
          const belongsToTarget = item.sourceDeltaId === oldDelta.id || item.sourceFloorId === oldFloorId;
          rebound[category].push({
            ...item,
            id: belongsToTarget ? await deterministicUuid(['v3-cse-recovered-item', deltaId, rebound.subjectEntityId, category, index, item.id]) : item.id,
            towardEntityId: mapEntity(item.towardEntityId),
            sourceFloorId: belongsToTarget ? currentFloorId : item.sourceFloorId,
            sourceDeltaId: belongsToTarget ? deltaId : item.sourceDeltaId,
          });
        }
      }
      subjects.push(rebound);
    }
    const source = structuredClone(oldDelta.source);
    if (Array.isArray(source.calibrationAudit)) source.calibrationAudit = source.calibrationAudit.map(entry => ({
      ...entry,
      subjectEntityId: mapEntity(entry.subjectEntityId),
      previousTowardEntityId: mapEntity(entry.previousTowardEntityId),
      towardEntityId: mapEntity(entry.towardEntityId),
    }));
    if (Array.isArray(source.manualSubjectEntityIds)) source.manualSubjectEntityIds = source.manualSubjectEntityIds.map(mapEntity);
    const delta = validateStateDeltaRecord({
      ...oldDelta,
      id: deltaId,
      narrativeGeneration: current.root.narrativeGeneration,
      floorId: currentFloorId,
      floorMemoryId: currentMemoryId,
      baselineId: current.baseline.id,
      previousCurrentStateId: current.currentStates.at(-1)?.id ?? null,
      subjectSnapshots: subjects,
      fingerprint: `sha256:${await sha256(JSON.stringify([currentFloorId, currentMemoryId, subjects, oldDelta.noMaterialChange]))}`,
      source,
      createdAt: timestamp,
      updatedAt: timestamp,
      supersedes: oldDelta.id,
    }, { expectedChatId: current.root.chatId });
    const operation = { floorId: currentFloorId, floorMemoryId: currentMemoryId, epoch, controller: new AbortController(), runId: await deterministicUuid(['v3-cse-recovery-run', current.root.headCheckpointId, deltaId]), startedAt: timestamp, phase: 'committing' };
    const roleEntities = await createBaselineRoleEntities(current.baseline);
    const entitiesById = new Map(current.entities.map(entity => [entity.id, entity]));
    for (const entity of roleEntities) if (!entitiesById.has(entity.id)) entitiesById.set(entity.id, entity);
    await commitDeltaGraph({ operation, current, floor, memory, delta, deltas: [...currentPrefix, delta], entities: [...entitiesById.values()], diagnostics: { kind: 'cseRecovery', promptVersion: CSE_PROMPT_VERSION, compilerVersion: CSE_COMPILER_VERSION, promptGuidanceFingerprint: promptFingerprint, sourceSelection: requestSources.diagnostics, recoveredFromDeltaId: oldDelta.id, cseRebuild: null } });
    return Object.freeze({ status: 'restored', deltaId });
  }

  function cancelActive() {
    if (!active) return false;
    epoch += 1;
    active.controller.abort();
    active = null;
    notify();
    return true;
  }
  function invalidate() { epoch += 1; active?.controller.abort(); active = null; reachable = null; replayed = null; lastFailure = null; replayDiagnostic = null; notify(); }
  return Object.freeze({ load, analyzeFloor, analyzeNext, correctSubjectState, restoreRecoveredDelta, cancelActive, invalidate, getState, subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); } });
}
