import { newIdentityUuid, sha256 } from '../identity.js';
import { buildFoundationIndexes } from './foundation-runtime.js';
import { deterministicUuid } from './foundation-domain.js';
import { validateFoundationCheckpoint, validateFoundationRoot, validateFoundationRun } from './foundation-schema.js';
import { validateCseGraph } from './cse-schema.js';
import {
  CSE_COMPILER_VERSION, CSE_PROMPT_VERSION, captureCseBaseline, createBaselineRoleEntities,
  createCseEnvelope, filterReachableDeltas, replayCurrentState, runCseRequest, selectTrackedSubjects, verifyCseBaselineFingerprint,
} from './cse-engine.js';
import { sanitizeDiagnosticValue, sanitizeSensitiveText } from './safe-metadata.js';

const emptyManifest = () => ({ floor: [], entity: [], event: [], claim: [], knowledge: [], episode: [], thread: [], state: [], anchor: [], reverseRef: [] });
const nowIso = now => { const value = now()?.toISOString?.() ?? String(now()); if (!Number.isFinite(Date.parse(value))) throw new TypeError('V3_CSE_TIME_INVALID'); return value; };
const hash = async value => `sha256:${await sha256(JSON.stringify(value))}`;
const errorWith = (code, message) => { const error = new Error(message ?? code); error.code = code; return error; };

export function createCseRuntime({ store, hostAdapter, generateUtilityTask, isEnabled = true, sanitizerOptions = () => ({}), now = () => new Date(), newUuid = newIdentityUuid, logger = console } = {}) {
  if (!store || ['readReachable', 'putRecord', 'commitRoot', 'recordKey'].some(name => typeof store[name] !== 'function')) throw new TypeError('V3 CSE store 无效');
  if (typeof generateUtilityTask !== 'function') throw new TypeError('V3 CSE utility route 无效');
  let epoch = 0, active = null, reachable = null, replayed = null, lastFailure = null, replayDiagnostic = null;
  const subscribers = new Set();
  const enabled = () => { try { return (typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true; } catch { return false; } };
  const notify = () => { const state = getState(); for (const listener of subscribers) { try { listener(state); } catch { /* listener isolation */ } } return state; };

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
    const value = providedReachable ?? await store.readReachable({ mode: 'projection' });
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
    const memoryByFloor = new Map((reachable?.floorMemories ?? []).filter(memory => memory.recordStatus === 'active').map(memory => [memory.floorId, memory]));
    const deltaByFloor = new Map(filterReachableDeltas({ floors, floorMemories: reachable?.floorMemories ?? [], stateDeltas: reachable?.stateDeltas ?? [] }).map(delta => [delta.floorId, delta]));
    const cseFloors = floors.map(floor => {
      const memory = memoryByFloor.get(floor.id), delta = deltaByFloor.get(floor.id);
      const running = active?.floorId === floor.id;
      const failure = lastFailure?.floorId === floor.id ? lastFailure : null;
      const status = !memory ? 'notApplicable' : running ? 'running' : delta ? (delta.noMaterialChange ? 'noChange' : 'ready') : failure && failure.code !== 'V3_CSE_PREVIOUS_GAP' ? 'failed' : 'pending';
      return Object.freeze({ floorId: floor.id, floorMemoryId: memory?.id ?? null, status, deltaId: delta?.id ?? null, noMaterialChange: delta?.noMaterialChange ?? false, error: failure?.message ?? null });
    });
    const entities = new Map((reachable?.entities ?? []).map(entity => [entity.id, entity]));
    const floorSeq = new Map(floors.map(floor => [floor.id, floor.assistantSeq]));
    const subjects = (replayed?.subjects ?? []).map(subject => ({
      subjectEntityId: subject.subjectEntityId,
      displayName: entities.get(subject.subjectEntityId)?.displayName ?? (subject.subjectEntityId === reachable?.baseline?.userPersona?.entityId ? reachable.baseline.userPersona.name : reachable?.baseline?.characterCard?.name) ?? '未知人物',
      core: subject.core.map(item => ({ ...item, sourceAssistantSeq: floorSeq.get(item.sourceFloorId) ?? null })),
      adaptive: subject.adaptive.map(item => ({ ...item, towardDisplayName: entities.get(item.towardEntityId)?.displayName ?? null, sourceAssistantSeq: floorSeq.get(item.sourceFloorId) ?? null })),
      situational: subject.situational.map(item => ({ ...item, sourceAssistantSeq: floorSeq.get(item.sourceFloorId) ?? null })),
    }));
    const pendingCount = cseFloors.filter(item => item.status === 'pending').length;
    return Object.freeze({ cseReady: reachable?.root?.capabilities?.cseReady === true, baselineId: reachable?.baseline?.id ?? null, currentStateId: reachable?.currentStates?.at(-1)?.id ?? null, replayedCurrentState: replayed, cseSubjects: Object.freeze(subjects), cseFloors: Object.freeze(cseFloors), csePendingCount: pendingCount, cseFailedCount: cseFloors.filter(item => item.status === 'failed').length, activeCse: active ? { floorId: active.floorId, runId: active.runId, phase: active.phase } : null, lastCseError: lastFailure, cseReplayDiagnostic: replayDiagnostic, csePromptVersion: CSE_PROMPT_VERSION, cseCompilerVersion: CSE_COMPILER_VERSION });
  }

  async function persist(records, signal) {
    for (const record of records) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const result = await store.putRecord(record, { signal });
      if (!['saved', 'reused'].includes(result.status)) throw errorWith('V3_CSE_PERSIST_FAILED', `CSE 记录写入失败：${result.status}`);
    }
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

  async function commitDelta(operation, initial, result, roleEntities) {
    const current = await store.readReachable();
    if (current.status !== 'ready' || current.rootRevision !== initial.rootRevision || current.root.headCheckpointId !== initial.root.headCheckpointId || current.root.narrativeGeneration !== initial.root.narrativeGeneration) throw errorWith('V3_CSE_STALE', '聊天或记忆在分析期间已变化，迟到状态不会写入。');
    const floor = current.floors.find(item => item.id === operation.floorId);
    const memory = current.floorMemories.find(item => item.id === operation.floorMemoryId && item.floorId === operation.floorId && item.recordStatus === 'active');
    if (!floor || !memory || floor.content.canonicalFingerprint !== operation.floorFingerprint) throw errorWith('V3_CSE_STALE', '当前楼正文或 FloorMemory 已变化，迟到状态不会写入。');
    const floorOrder = new Map(current.floors.map((item, index) => [item.id, index]));
    const deltas = filterReachableDeltas({ floors: current.floors, floorMemories: current.floorMemories, stateDeltas: current.stateDeltas })
      .filter(delta => floorOrder.get(delta.floorId) < floorOrder.get(floor.id));
    deltas.push(result.delta);
    const entitiesById = new Map(current.entities.map(entity => [entity.id, entity]));
    for (const entity of roleEntities) if (!entitiesById.has(entity.id) && [current.baseline.userPersona.entityId, current.baseline.characterCard.entityId].includes(entity.id)) entitiesById.set(entity.id, entity);
    const entities = [...entitiesById.values()];
    const nowValue = nowIso(now);
    const runId = operation.runId;
    const checkpointId = await deterministicUuid(['v3-cse-checkpoint', current.root.headCheckpointId, result.delta.id]);
    const indexes = await buildFoundationIndexes({ chatId: current.root.chatId, narrativeGeneration: current.root.narrativeGeneration, checkpointId, floors: current.floors, candidates: current.floors.map(item => ({ hostLocator: item.hostLocator, rawFingerprint: item.content.rawFingerprint, canonicalFingerprint: item.content.canonicalFingerprint })), entities, now: nowValue });
    const indexKeys = indexes.map(index => store.recordKey(index));
    const previousState = current.currentStates.at(-1) ?? null;
    const currentState = await replayCurrentState({ chatId: current.root.chatId, narrativeGeneration: current.root.narrativeGeneration, baselineId: current.baseline.id, floors: current.floors, floorMemories: current.floorMemories, stateDeltas: deltas, now: nowValue, previousId: previousState?.id ?? null });
    const activeMemories = current.floorMemories.filter(item => item.recordStatus === 'active');
    const cseReady = activeMemories.length > 0 && activeMemories.every(item => deltas.some(delta => delta.floorId === item.floorId && delta.floorMemoryId === item.id));
    const capabilities = { foundationReady: true, memoryReady: activeMemories.length > 0, cseReady, recallReady: false };
    const stateGraphFingerprint = await hash([current.root.narrativeGeneration, current.floors.map(item => item.id), current.floors.map(item => item.content.canonicalFingerprint)]);
    const run = validateFoundationRun({ schemaVersion: 3, recordType: 'run', id: runId, chatId: current.root.chatId, narrativeGeneration: current.root.narrativeGeneration, parentCheckpointId: current.root.headCheckpointId, inputSnapshotFingerprint: current.root.sourceSnapshotFingerprint, mode: 'cse', sessionEpoch: operation.epoch, inputFloorIds: [floor.id], phase: 'completed', completedFloorIds: [floor.id], failedItems: [], preparedRecordRefs: [store.recordKey(result.delta), store.recordKey(currentState), ...indexKeys, `v3-checkpoint-${checkpointId}`], diagnostics: { kind: 'cse', promptVersion: CSE_PROMPT_VERSION, compilerVersion: CSE_COMPILER_VERSION, floorId: floor.id, floorMemoryId: memory.id, api: result.metadata, attempts: result.attempts, transportAttempts: result.transportAttempts, responseFingerprint: result.responseFingerprint, isolated: result.isolated.slice(-40) }, startedAt: operation.startedAt, createdAt: nowValue, updatedAt: nowValue, recordStatus: 'active', supersedes: null }, { expectedChatId: current.root.chatId });
    const checkpoint = validateFoundationCheckpoint({ schemaVersion: 3, recordType: 'checkpoint', id: checkpointId, chatId: current.root.chatId, narrativeGeneration: current.root.narrativeGeneration, parentCheckpointId: current.root.headCheckpointId, runId, sourceSnapshotFingerprint: current.root.sourceSnapshotFingerprint, capabilities, floorRange: { fromAssistantSeq: current.floors.length ? 1 : 0, toAssistantSeq: current.floors.length, floorIds: current.floors.map(item => item.id) }, inputFingerprints: current.floors.map(item => ({ floorId: item.id, canonicalFingerprint: item.content.canonicalFingerprint })), producedRefs: { floors: current.floors.map(item => item.id), floorMemories: current.floorMemories.map(item => item.id), entities: entities.map(item => item.id), events: [], claims: [], knowledge: [], stateDeltas: deltas.map(item => item.id), currentStates: [currentState.id], stateProjections: [], episodes: [], threads: [], indexes: indexKeys }, validation: { schemaValid: true, referencesValid: true, orderedReplayValid: true, stateFingerprint: stateGraphFingerprint }, sealedAt: nowValue, createdAt: nowValue, updatedAt: nowValue, recordStatus: 'active', supersedes: null }, { expectedChatId: current.root.chatId });
    const root = validateFoundationRoot({ ...current.root, capabilities, headCheckpointId: checkpointId, indexManifest: { ...emptyManifest(), floor: indexKeys.filter(key => key.includes('-floorOrder-') || key.includes('-fingerprint-')), entity: indexKeys.filter(key => key.includes('-entity-')), reverseRef: indexKeys.filter(key => key.includes('-reverseRef-')) }, activeStateRefs: [currentState.id], updatedAt: nowValue }, { expectedChatId: current.root.chatId });
    await validateCseGraph({ root, checkpoint, run, floors: current.floors, floorMemories: current.floorMemories, entities, indexes, indexKeys, baseline: current.baseline, stateDeltas: deltas, currentStates: [currentState] });
    const newEntities = entities.filter(entity => !current.entities.some(old => old.id === entity.id));
    await persist([...newEntities, result.delta, currentState, ...indexes, run, checkpoint], operation.controller.signal);
    if (operation.epoch !== epoch || operation.controller.signal.aborted) throw errorWith('V3_CSE_STALE', 'CSE 操作已取消。');
    const committed = await store.commitRoot(root, current.rootRevision, { signal: operation.controller.signal });
    if (committed.status !== 'saved') throw errorWith(committed.status === 'conflict' ? 'V3_CSE_CAS_CONFLICT' : 'V3_CSE_COMMIT_FAILED', 'CSE 提交遇到并发更新，未覆盖新数据。');
    const next = await store.readReachable();
    if (next.status !== 'ready') throw errorWith('V3_CSE_COLD_READ_FAILED', 'CSE 提交后冷读取失败。');
    reachable = next; await calculateReplay(next); lastFailure = null; return notify();
  }

  async function analyzeFloor(floorId) {
    if (!enabled()) return notify();
    if (active) return getState();
    await load();
    let value = reachable;
    const floor = value?.floors?.find(item => item.id === floorId);
    const memory = value?.floorMemories?.find(item => item.floorId === floorId && item.recordStatus === 'active');
    if (!floor || !memory) throw errorWith('V3_CSE_FLOOR_UNAVAILABLE', '只有当前可达且已有 FloorMemory 的楼可以分析状态。');
    const operation = { floorId, floorMemoryId: memory.id, floorFingerprint: floor.content.canonicalFingerprint, epoch, controller: new AbortController(), runId: await deterministicUuid(['v3-cse-run', value.root.headCheckpointId, memory.id, newUuid()]), startedAt: nowIso(now), phase: 'baseline' };
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
      const tracked = selectTrackedSubjects({ baseline: value.baseline, entities, floorMemories: value.floorMemories, floorMemory: memory });
      const envelope = createCseEnvelope({ floor, floorMemory: memory, baseline: value.baseline, currentState: previousCurrentState, trackedSubjects: tracked, entities });
      const deltaId = await deterministicUuid(['v3-cse-delta', operation.runId, floor.id, memory.id]);
      const result = await runCseRequest({ generateUtilityTask, envelope, previousCurrentState, now: nowIso(now), deltaId, signal: operation.controller.signal });
      if (operation.epoch !== epoch || operation.controller.signal.aborted) throw errorWith('V3_CSE_STALE', '聊天已变化，迟到 CSE 结果已丢弃。');
      operation.phase = 'committing'; notify();
      await commitDelta(operation, value, result, roleEntities);
    } catch (error) {
      if (error?.code === 'V3_CSE_PREVIOUS_GAP') lastFailure = { floorId, runId: operation.runId, code: error.code, message: error.message, phase: 'pending' };
      else if (error?.name === 'AbortError' || error?.code === 'V3_CSE_STALE') lastFailure = { floorId, runId: operation.runId, code: 'V3_CSE_STALE', message: '聊天、分支或 FloorMemory 已变化，迟到状态没有写入。', phase: 'stale' };
      else lastFailure = { floorId, runId: operation.runId, code: String(error?.code ?? 'V3_CSE_FAILED').slice(0, 120), message: sanitizeSensitiveText(error?.message ?? '状态分析失败，可单独重试。').slice(0, 500), phase: 'retryableError', diagnostics: sanitizeDiagnosticValue(error?.cseDiagnostics ?? null) };
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

  function cancelActive() {
    if (!active) return false;
    epoch += 1;
    active.controller.abort();
    active = null;
    notify();
    return true;
  }
  function invalidate() { epoch += 1; active?.controller.abort(); active = null; reachable = null; replayed = null; lastFailure = null; replayDiagnostic = null; notify(); }
  return Object.freeze({ load, analyzeFloor, analyzeNext, cancelActive, invalidate, getState, subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); } });
}
