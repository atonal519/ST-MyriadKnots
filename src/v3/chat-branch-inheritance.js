import { sha256 } from '../identity.js';
import { createFoundationStore } from './foundation-store.js';
import {
  buildFoundationIndexes,
  projectFoundationPrefix,
  validatePreparedFoundation,
} from './foundation-runtime.js';
import {
  createCheckpointInputFingerprints,
  deterministicUuid,
  foundationInputSnapshot,
  scanAssistantCandidates,
} from './foundation-domain.js';
import {
  validateFoundationCheckpoint,
  validateFoundationFloor,
  validateFoundationRoot,
  validateFoundationRun,
  V3_INDEX_LAYOUT_FLOOR_ORDER,
} from './foundation-schema.js';
import { validateCseGraph } from './cse-schema.js';
import { matchFloorCandidates } from './floor-binding.js';
import { createPeopleWorkspaceStore } from './people-workspace.js';
import { persistBranchedMessageMetadata } from './message-floor-anchor.js';

const fail = (code, message) => Object.assign(new Error(message), { code });
const BRANCH_WRITE_CONCURRENCY = 4;
const emptyIndexManifest = () => ({ floor: [], entity: [], event: [], claim: [], knowledge: [], episode: [], thread: [], state: [], anchor: [], reverseRef: [] });
const nowIso = now => {
  const value = now()?.toISOString?.() ?? String(now());
  if (!Number.isFinite(Date.parse(value))) throw fail('V3_BRANCH_TIME_INVALID', '分支初始化时间无效。');
  return value;
};
const identity = (host, chatId) => Object.freeze({
  hostChatId: String(host.hostChatId ?? ''),
  chatId,
  characterLocator: String(host.characterAvatar ?? ''),
  personaLocator: String(host.personaAvatar ?? ''),
});
const rehome = (record, chatId, narrativeGeneration) => record ? { ...structuredClone(record), chatId, narrativeGeneration } : null;

function normalizeBranchCandidates(candidates, sourceChatId, targetChatId) {
  return candidates.map(candidate => {
    const anchor = candidate.messageAnchor;
    if (anchor?.status !== 'foreign' || anchor.anchor?.chatId !== targetChatId) return candidate;
    return Object.freeze({ ...candidate, messageAnchor: Object.freeze({ status: 'valid', anchor: anchor.anchor }) });
  });
}

function inheritedPrefix(source, candidates) {
  const matched = matchFloorCandidates(source.floors, candidates);
  if (matched.issue) throw fail('V3_BRANCH_FLOOR_MATCH_INVALID', '分支消息与源记忆楼无法安全对应，未创建继承档。');
  let count = 0;
  while (count < candidates.length) {
    const match = matched.candidateMatches.get(count);
    if (!match || match.floorIndex !== count) break;
    count += 1;
  }
  if (matched.matches.some(match => match.candidateIndex >= count || match.floorIndex >= count)) {
    throw fail('V3_BRANCH_NOT_PREFIX', '分支消息不是源聊天的连续前缀，未创建继承档。');
  }
  return Object.freeze({ count, candidates: candidates.slice(0, count), floors: source.floors.slice(0, count) });
}

async function copyLatestPeople({ peopleStore, sourceIdentity, targetIdentity, entities, now, signal }) {
  const existing = await peopleStore.read(targetIdentity);
  if (existing.data) return existing.data;
  const source = await peopleStore.read(sourceIdentity);
  if (!source.data) return null;
  const allowed = new Set(entities.map(entity => entity.id));
  const pickMap = value => Object.fromEntries(Object.entries(value ?? {}).filter(([entityId]) => allowed.has(entityId)));
  const redirects = Object.fromEntries(Object.entries(source.data.identityRedirectsByEntityId ?? {})
    .filter(([from, to]) => allowed.has(from) && allowed.has(to)));
  const uniqueAllowed = values => [...new Set((values ?? []).filter(entityId => allowed.has(entityId)))];
  const workspace = {
    ...structuredClone(source.data),
    chatId: targetIdentity.chatId,
    selectedEntityIds: uniqueAllowed(source.data.selectedEntityIds),
    personOrderEntityIds: uniqueAllowed(source.data.personOrderEntityIds),
    profilesByEntityId: pickMap(source.data.profilesByEntityId),
    avatarsByEntityId: pickMap(source.data.avatarsByEntityId),
    identityRedirectsByEntityId: redirects,
    deletedEntityIds: uniqueAllowed(source.data.deletedEntityIds),
    profileMaterialProgressByEntityId: {},
    updatedAt: now,
  };
  const hasContent = workspace.selectedEntityIds.length || workspace.personOrderEntityIds.length
    || Object.keys(workspace.profilesByEntityId).length || Object.keys(workspace.avatarsByEntityId).length
    || Object.keys(workspace.identityRedirectsByEntityId).length || workspace.deletedEntityIds.length;
  if (!hasContent) return null;
  try { return (await peopleStore.put(targetIdentity, workspace, 0, { signal })).data; }
  catch (error) {
    if (error?.status !== 409) throw error;
    const winner = await peopleStore.read(targetIdentity);
    if (!winner.data) throw error;
    return winner.data;
  }
}

async function saveRecords(store, records, signal) {
  let cursor = 0;
  let firstError = null;
  async function worker() {
    while (firstError === null) {
      const index = cursor;
      if (index >= records.length) return;
      cursor += 1;
      try {
        const result = await store.putRecord(records[index], { signal });
        if (!['saved', 'reused'].includes(result.status)) throw fail('V3_BRANCH_RECORD_CONFLICT', '分支记忆记录发生冲突，未提交目标根。');
      } catch (error) {
        firstError ??= error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(BRANCH_WRITE_CONCURRENCY, records.length) }, () => worker()));
  if (firstError) throw firstError;
}

export function createChatBranchInitializer({
  client,
  hostAdapter,
  sanitizerOptions = () => ({}),
  now = () => new Date(),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!client?.get || !client?.put || !hostAdapter?.snapshot) throw new TypeError('聊天分支初始化依赖无效');
  return async function initializeBranch({ host, sourceChatId, targetChatId, createdAt: initializationTime, signal } = {}) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const sourceIdentity = identity(host, sourceChatId);
    const targetIdentity = identity(host, targetChatId);
    const sourceStore = createFoundationStore({ client, contextProvider: () => sourceIdentity });
    const targetStore = createFoundationStore({ client, contextProvider: () => targetIdentity });
    const peopleStore = createPeopleWorkspaceStore({ client });
    const snapshot = hostAdapter.snapshot();
    if (snapshot.chatId !== sourceIdentity.hostChatId || !Array.isArray(snapshot.chat)) throw fail('V3_BRANCH_CHAT_CHANGED', '分支初始化期间聊天已经变化。');

    let target = await targetStore.readReachable();
    let bindings = [];
    let retainedFloorIds = [];
    if (['ready', 'needsReseal'].includes(target.status)) {
      const scanned = await scanAssistantCandidates(snapshot.chat, { sanitizerOptions: sanitizerOptions(), chatId: sourceChatId });
      const candidates = normalizeBranchCandidates(scanned, sourceChatId, targetChatId);
      const prefix = inheritedPrefix(target, candidates);
      if (prefix.count !== target.floors.length) throw fail('V3_BRANCH_TARGET_MISMATCH', '已准备的分支记忆与当前消息不一致。');
      bindings = prefix.floors.map((floor, index) => ({ messageIndex: prefix.candidates[index].hostLocator.messageIndex, floorId: floor.id }));
      retainedFloorIds = prefix.floors.map(floor => floor.id);
      await copyLatestPeople({ peopleStore, sourceIdentity, targetIdentity, entities: target.entities, now: initializationTime ?? nowIso(now), signal });
    } else if (target.status === 'uninitialized') {
      const source = await sourceStore.readReachable();
      if (['ready', 'needsReseal'].includes(source.status)) {
        const scanned = await scanAssistantCandidates(snapshot.chat, { sanitizerOptions: sanitizerOptions(), chatId: sourceChatId });
        const candidates = normalizeBranchCandidates(scanned, sourceChatId, targetChatId);
        const prefix = inheritedPrefix(source, candidates);
        if (prefix.count > 0) {
          const createdAt = initializationTime ?? nowIso(now);
          const inputSnapshot = await foundationInputSnapshot(candidates, prefix.count);
          const narrativeGeneration = await deterministicUuid(['generation', targetChatId, prefix.floors.map(floor => floor.content.canonicalFingerprint)]);
          const runId = await deterministicUuid(['foundation-branch-run-v1', targetChatId, sourceChatId, inputSnapshot.fingerprint]);
          const checkpointId = await deterministicUuid(['foundation-branch-checkpoint-v1', targetChatId, sourceChatId, inputSnapshot.fingerprint]);
          const floors = prefix.floors.map((floor, index) => validateFoundationFloor({
            ...rehome(floor, targetChatId, narrativeGeneration),
            assistantSeq: index + 1,
            predecessorFloorId: prefix.floors[index - 1]?.id ?? null,
            hostLocator: { ...prefix.candidates[index].hostLocator },
            processing: { ...floor.processing, runId, checkpointId },
            updatedAt: createdAt,
          }, { expectedChatId: targetChatId }));
          const rehomedSource = {
            ...source,
            floorMemories: source.floorMemories.map(record => rehome(record, targetChatId, narrativeGeneration)),
            stateDeltas: source.stateDeltas.map(record => rehome(record, targetChatId, narrativeGeneration)),
            entities: source.entities.map(record => rehome(record, targetChatId, narrativeGeneration)),
            baseline: rehome(source.baseline, targetChatId, narrativeGeneration),
          };
          const currentStateId = await deterministicUuid(['v3-cse-current-state', checkpointId]);
          const projected = await projectFoundationPrefix({ source: rehomedSource, floors, chatId: targetChatId, narrativeGeneration, now: createdAt, currentStateId });
          const indexes = await buildFoundationIndexes({ chatId: targetChatId, narrativeGeneration, checkpointId, floors, candidates: prefix.candidates, now: createdAt });
          const indexKeys = indexes.map(record => targetStore.recordKey(record));
          const floorIds = floors.map(floor => floor.id);
          const stateFingerprint = `sha256:${await sha256(JSON.stringify([narrativeGeneration, floorIds, floors.map(floor => floor.content.canonicalFingerprint)]))}`;
          const run = validateFoundationRun({
            schemaVersion: 3, recordType: 'run', id: runId, chatId: targetChatId, narrativeGeneration,
            parentCheckpointId: null, inputSnapshotFingerprint: inputSnapshot.fingerprint, mode: 'branchReplay', sessionEpoch: 0,
            inputFloorIds: floorIds, phase: 'completed', completedFloorIds: floorIds, failedItems: [],
            preparedRecordRefs: [...floors, ...projected.floorMemories, ...projected.entities, ...(projected.baseline ? [projected.baseline] : []), ...projected.stateDeltas, ...(projected.currentState ? [projected.currentState] : []), ...indexes]
              .map(record => targetStore.recordKey(record)),
            diagnostics: null, startedAt: createdAt, createdAt, updatedAt: createdAt, recordStatus: 'staged', supersedes: null,
          }, { expectedChatId: targetChatId });
          const checkpoint = validateFoundationCheckpoint({
            schemaVersion: 3, recordType: 'checkpoint', id: checkpointId, chatId: targetChatId, narrativeGeneration,
            parentCheckpointId: null, runId, sourceSnapshotFingerprint: inputSnapshot.fingerprint, indexLayout: V3_INDEX_LAYOUT_FLOOR_ORDER,
            capabilities: structuredClone(projected.capabilities), floorRange: { fromAssistantSeq: 1, toAssistantSeq: floors.length, floorIds },
            inputFingerprints: createCheckpointInputFingerprints(floors, { candidates: prefix.candidates, previous: source.checkpoint?.inputFingerprints }),
            producedRefs: { floors: floorIds, floorMemories: projected.floorMemories.map(record => record.id), entities: projected.entities.map(record => record.id), events: [], claims: [], knowledge: [], stateDeltas: projected.stateDeltas.map(record => record.id), currentStates: projected.currentState ? [projected.currentState.id] : [], stateProjections: [], episodes: [], threads: [], indexes: indexKeys },
            validation: { schemaValid: true, referencesValid: true, orderedReplayValid: true, stateFingerprint }, sealedAt: createdAt,
            createdAt, updatedAt: createdAt, recordStatus: 'active', supersedes: null,
          }, { expectedChatId: targetChatId });
          const boundary = floors.at(-1);
          const root = validateFoundationRoot({
            schemaVersion: 3, recordType: 'root', id: 'root', chatId: targetChatId, narrativeGeneration, status: 'ready',
            capabilities: structuredClone(projected.capabilities), headCheckpointId: checkpointId, sourceSnapshotFingerprint: inputSnapshot.fingerprint,
            stableBoundary: { assistantSeq: floors.length, floorId: boundary.id, canonicalFingerprint: boundary.content.canonicalFingerprint },
            baselineId: projected.baseline?.id ?? null, activeRunId: null,
            indexManifest: { ...emptyIndexManifest(), floor: indexKeys }, activeStateRefs: projected.currentState ? [projected.currentState.id] : [], activeThreadRefs: [],
            createdAt, updatedAt: createdAt, recordStatus: 'active', supersedes: null,
          }, { expectedChatId: targetChatId });
          await validatePreparedFoundation({ checkpoint, run, floors, floorMemories: projected.floorMemories, entities: projected.entities, indexes, indexKeys });
          await validateCseGraph({ root, checkpoint, run, floors, floorMemories: projected.floorMemories, entities: projected.entities, indexes, indexKeys, baseline: projected.baseline, stateDeltas: projected.stateDeltas, currentStates: projected.currentState ? [projected.currentState] : [] });
          await saveRecords(targetStore, [run, ...floors, ...projected.floorMemories, ...projected.entities, ...(projected.baseline ? [projected.baseline] : []), ...projected.stateDeltas, ...(projected.currentState ? [projected.currentState] : []), ...indexes], signal);
          const checkpointResult = await targetStore.putRecord(checkpoint, { signal });
          if (!['saved', 'reused'].includes(checkpointResult.status)) throw fail('V3_BRANCH_RECORD_CONFLICT', '分支记忆记录发生冲突，未提交目标根。');
          const committed = await targetStore.commitRoot(root, 0, { signal });
          if (!['saved'].includes(committed.status)) {
            target = await targetStore.readReachable();
            if (!['ready', 'needsReseal'].includes(target.status) || target.root.headCheckpointId !== checkpointId) throw fail('V3_BRANCH_ROOT_CONFLICT', '分支目标根发生冲突，未覆盖已有数据。');
          } else target = committed.reachable;
          bindings = floors.map((floor, index) => ({ messageIndex: prefix.candidates[index].hostLocator.messageIndex, floorId: floor.id }));
          retainedFloorIds = floorIds;
          await copyLatestPeople({ peopleStore, sourceIdentity, targetIdentity, entities: projected.entities, now: createdAt, signal });
        }
      } else if (source.status !== 'uninitialized') {
        throw fail('V3_BRANCH_SOURCE_UNAVAILABLE', '源聊天记忆暂时无法读取，未把错误当成空档。');
      }
    } else {
      throw fail('V3_BRANCH_TARGET_UNAVAILABLE', '分支目标记忆暂时无法读取。');
    }

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    await persistBranchedMessageMetadata({ hostAdapter, hostChatId: host.hostChatId, sourceChatId, targetChatId, bindings, retainedFloorIds, signal, fetchImpl });
    return Object.freeze({ status: retainedFloorIds.length ? 'inherited' : 'empty', inheritedFloors: retainedFloorIds.length });
  };
}
