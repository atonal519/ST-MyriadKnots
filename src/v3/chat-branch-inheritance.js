import { sha256 } from '../identity.js';
import { cloneHostJsonMetadata } from '../host-context.js';
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
import { partitionScannedCandidates, validateMigrationDescriptor } from './migration-prefix.js';
import { createPeopleWorkspaceStore } from './people-workspace.js';
import { createTimeStore } from './time-runtime.js';
import { assertCapturedBranchTargetMatches, persistBranchedMessageMetadata, readTargetChat, sameBranchMessageCore } from './message-floor-anchor.js';
import { captureTargetChatDescriptor } from './host-adapter.js';

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

function normalizeBranchCandidates(candidates, targetChatId) {
  return candidates.map(candidate => {
    const anchor = candidate.messageAnchor;
    if (anchor?.status !== 'foreign' || anchor.anchor?.chatId !== targetChatId) return candidate;
    return Object.freeze({ ...candidate, messageAnchor: Object.freeze({ status: 'valid', anchor: anchor.anchor }) });
  });
}

function inheritedPrefix(source, candidates) {
  const matched = matchFloorCandidates(source.floors, candidates);
  if (matched.issue) throw fail('V3_BRANCH_FLOOR_MATCH_INVALID', '分支消息与源记忆楼无法安全对应，未创建继承档。');
  // A branch inherits only the uniquely matched, uninterrupted floor prefix it still contains.
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

function branchMigrationDescriptor({ source, targetChatId, descriptorId, retainedFloors, projected, indexKeys, timeBatchIds, peopleCopy, partitioned, createdAt }) {
  const previous = source.migrationDescriptor;
  if (!previous) return null;
  const retained = new Set(retainedFloors.map(floor => floor.id));
  const frozenFloorIds = previous.frozenFloorIds.filter(floorId => retained.has(floorId));
  const frozen = new Set(frozenFloorIds);
  const witnessedIndexes = new Set((partitioned?.aliasWitnesses ?? []).map(witness => witness.messageIndex));
  const carriedAliases = previous.carriedAliases.filter(alias => frozen.has(alias.floorId) && witnessedIndexes.has(alias.targetMessageIndex));
  const summarySources = previous.summarySources.filter(item => retained.has(item.targetFloorId) && retained.has(item.sourceFloorId));
  const floorMemories = projected.floorMemories.filter(record => frozen.has(record.floorId));
  const stateDeltas = projected.stateDeltas.filter(record => frozen.has(record.floorId));
  return validateMigrationDescriptor({
    ...structuredClone(previous),
    id: descriptorId,
    chatId: targetChatId,
    createdAt,
    frozenFloorIds,
    floorOrigins: previous.floorOrigins.filter(origin => frozen.has(origin.floorId)),
    carriedAliases,
    summarySources,
    sourceFloorProvenance: previous.sourceFloorProvenance.filter(item => frozen.has(item.floorId)),
    recordRefs: {
      floors: frozenFloorIds,
      floorMemories: floorMemories.map(record => record.id),
      entities: projected.entities.map(record => record.id),
      baselineId: projected.baseline?.id ?? null,
      stateDeltas: stateDeltas.map(record => record.id),
      currentStateIds: projected.currentState ? [projected.currentState.id] : [],
      indexKeys: [...indexKeys],
      timeBatchIds: timeBatchIds.filter(id => previous.recordRefs.timeBatchIds.includes(id)),
      vectorShardIds: [],
      peopleWorkspaceId: peopleCopy?.workspace ? 'v3-people-workspace' : null,
      peopleSnapshotIds: peopleCopy?.snapshotIds ?? [],
    },
  }, { expectedChatId: targetChatId });
}

async function branchInputSnapshot(candidates, stableCount, partitioned, descriptorId) {
  if (!partitioned?.descriptorId) return foundationInputSnapshot(candidates, stableCount);
  const realCandidates = candidates.filter(candidate => candidate?.archiveCandidate !== true);
  const realStableCount = candidates.slice(0, stableCount).filter(candidate => candidate?.archiveCandidate !== true).length;
  const base = await foundationInputSnapshot(realCandidates, realStableCount);
  const witness = { descriptorId, aliasWitnesses: partitioned.aliasWitnesses };
  return Object.freeze({
    payload: Object.freeze({ ...base.payload, migration: Object.freeze(witness) }),
    fingerprint: `sha256:${await sha256(JSON.stringify({ fingerprint: base.fingerprint, ...witness }))}`,
  });
}

function projectSavedBranchMetadata(raw, hostAdapter, hostChatId, capturedChat, savedFile, targetChatId) {
  let live;
  try { live = hostAdapter.snapshot(); } catch { return; }
  if (live.chatId !== hostChatId || live.chat !== raw?.chat || live.context?.chatMetadata !== raw?.chatMetadata) return;
  for (let index = 0; index < capturedChat.length; index += 1) {
    const current = live.chat[index], captured = capturedChat[index], saved = savedFile.chat[index];
    if (!current || !captured || !saved || !sameBranchMessageCore(current, captured)) continue;
    const extra = current.extra && typeof current.extra === 'object' && !Array.isArray(current.extra) ? { ...current.extra } : {};
    for (const key of ['qianqianjie_floor', 'qqj_v3_recall_receipt', 'qianqianjieAutoHide']) {
      if (Object.hasOwn(saved.extra ?? {}, key)) extra[key] = structuredClone(saved.extra[key]);
      else delete extra[key];
    }
    current.extra = extra;
    if (Array.isArray(current.swipe_info) && Array.isArray(saved.swipe_info)) current.swipe_info = current.swipe_info.map((swipe, swipeIndex) => {
      const savedSwipe = saved.swipe_info[swipeIndex];
      if (!savedSwipe) return swipe;
      const swipeExtra = swipe?.extra && typeof swipe.extra === 'object' && !Array.isArray(swipe.extra) ? { ...swipe.extra } : {};
      for (const key of ['qianqianjie_floor', 'qqj_v3_recall_receipt', 'qianqianjieAutoHide']) {
        if (Object.hasOwn(savedSwipe.extra ?? {}, key)) swipeExtra[key] = structuredClone(savedSwipe.extra[key]);
        else delete swipeExtra[key];
      }
      return { ...swipe, extra: swipeExtra };
    });
  }
  const qianqianjie = raw.chatMetadata.qianqianjie && typeof raw.chatMetadata.qianqianjie === 'object'
    ? { ...raw.chatMetadata.qianqianjie } : {};
  qianqianjie.schemaVersion = 2;
  qianqianjie.chatId = targetChatId;
  raw.chatMetadata.qianqianjie = qianqianjie;
  const savedMetadata = savedFile.header?.chat_metadata;
  if (savedMetadata && Object.hasOwn(savedMetadata, 'integrity')) raw.chatMetadata.integrity = savedMetadata.integrity;
  else delete raw.chatMetadata.integrity;
}

export async function copyLatestPeople({ peopleStore, sourceIdentity, targetIdentity, entities, now, signal, snapshotSourceIds = null }) {
  const source = await peopleStore.read(sourceIdentity);
  const snapshotIds = Array.isArray(snapshotSourceIds)
    ? await peopleStore.copySnapshots(sourceIdentity, targetIdentity, snapshotSourceIds, source.data ? source : null)
    : null;
  const existing = await peopleStore.read(targetIdentity);
  if (existing.data) return snapshotIds ? Object.freeze({ workspace: existing.data, snapshotIds }) : existing.data;
  if (!source.data) return snapshotIds ? Object.freeze({ workspace: null, snapshotIds }) : null;
  const allowed = new Set(entities.map(entity => entity.id));
  const pickMap = value => Object.fromEntries(Object.entries(value ?? {}).filter(([entityId]) => allowed.has(entityId)));
  const redirects = Object.fromEntries(Object.entries(source.data.identityRedirectsByEntityId ?? {})
    .filter(([from, to]) => allowed.has(from) && allowed.has(to)));
  const uniqueAllowed = values => [...new Set((values ?? []).filter(entityId => allowed.has(entityId)))];
  // People keep their latest profile and manual fields; floor-scoped material progress belongs to the source chat.
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
  if (!hasContent) return snapshotIds ? Object.freeze({ workspace: null, snapshotIds }) : null;
  try {
    const saved = (await peopleStore.put(targetIdentity, workspace, 0, { signal })).data;
    return snapshotIds ? Object.freeze({ workspace: saved, snapshotIds }) : saved;
  }
  catch (error) {
    if (error?.status !== 409) throw error;
    const winner = await peopleStore.read(targetIdentity);
    if (!winner.data) throw error;
    return snapshotIds ? Object.freeze({ workspace: winner.data, snapshotIds }) : winner.data;
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
  vectorRuntimeProvider = () => null,
  sanitizerOptions = () => ({}),
  now = () => new Date(),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!client?.get || !client?.put || !hostAdapter?.snapshot) throw new TypeError('聊天分支初始化依赖无效');
  return async function initializeBranch({ raw, host, sourceChatId, targetChatId, createdAt: initializationTime, signal, taskInputs = null } = {}) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const sourceIdentity = identity(host, sourceChatId);
    const targetIdentity = identity(host, targetChatId);
    const liveSnapshot = taskInputs ? null : hostAdapter.snapshot();
    const snapshot = taskInputs ?? {
      chat: structuredClone(Array.isArray(liveSnapshot.chat) ? liveSnapshot.chat : []),
      chatMetadata: cloneHostJsonMetadata(liveSnapshot.context?.chatMetadata ?? {}),
      target: captureTargetChatDescriptor(liveSnapshot, { ...sourceIdentity, hostChatId: host.hostChatId }),
      sanitizerOptions: { ...sanitizerOptions() },
    };
    if (!Array.isArray(snapshot.chat) || !snapshot.target?.hostChatId || snapshot.target.hostChatId !== sourceIdentity.hostChatId) {
      throw fail('V3_BRANCH_TARGET_INVALID', '分支目标快照无效。');
    }
    const fixedTarget = { ...snapshot.target, chatId: targetChatId };
    const targetFile = await readTargetChat(fixedTarget, { signal, fetchImpl, allowedChatIds: [sourceChatId, targetChatId] });
    assertCapturedBranchTargetMatches(snapshot, targetFile, sourceChatId, targetChatId, { deferNewTargetAnchors: true });
    const sourceStore = createFoundationStore({ client, contextProvider: () => sourceIdentity });
    const targetStore = createFoundationStore({ client, contextProvider: () => targetIdentity });
    const peopleStore = createPeopleWorkspaceStore({ client });
    const timeStore = createTimeStore({ client });

    let target = await targetStore.readReachable();
    let sourceReachable = null;
    let bindings = [];
    let retainedFloorIds = [];
    if (['ready', 'needsReseal'].includes(target.status)) {
      const scanned = await scanAssistantCandidates(snapshot.chat, { sanitizerOptions: snapshot.sanitizerOptions, chatId: sourceChatId });
      const partitioned = partitionScannedCandidates(target, snapshot.chat, sourceChatId, scanned);
      const candidates = normalizeBranchCandidates(partitioned.all, targetChatId);
      const prefix = inheritedPrefix(target, candidates);
      if (prefix.count !== target.floors.length) throw fail('V3_BRANCH_TARGET_MISMATCH', '已准备的分支记忆与当前消息不一致。');
      bindings = prefix.floors.flatMap((floor, index) => prefix.candidates[index]?.archiveCandidate
        ? [] : [{ messageIndex: prefix.candidates[index].hostLocator.messageIndex, floorId: floor.id }]);
      retainedFloorIds = prefix.floors.map(floor => floor.id);
      assertCapturedBranchTargetMatches(snapshot, targetFile, sourceChatId, targetChatId, { expectedBindings: bindings });
      if (target.migrationDescriptor) {
        await peopleStore.read(targetIdentity);
        for (const snapshotId of target.migrationDescriptor.recordRefs.peopleSnapshotIds) {
          if (!await peopleStore.readSnapshot(targetIdentity, snapshotId)) {
            throw fail('QQJ_PEOPLE_SNAPSHOT_MISSING', '分支已提交的人物归档快照缺失，未完成恢复。');
          }
        }
      } else await copyLatestPeople({ peopleStore, sourceIdentity, targetIdentity, entities: target.entities,
        now: initializationTime ?? nowIso(now), signal });
    } else if (target.status === 'uninitialized') {
      const source = await sourceStore.readReachable();
      sourceReachable = source;
      if (['ready', 'needsReseal'].includes(source.status)) {
        const scanned = await scanAssistantCandidates(snapshot.chat, { sanitizerOptions: snapshot.sanitizerOptions, chatId: sourceChatId });
        const partitioned = partitionScannedCandidates(source, snapshot.chat, sourceChatId, scanned);
        const candidates = normalizeBranchCandidates(partitioned.all, targetChatId);
        const prefix = inheritedPrefix(source, candidates);
        if (prefix.count > 0) {
          const branchBindings = prefix.floors.flatMap((floor, index) => prefix.candidates[index]?.archiveCandidate
            ? [] : [{ messageIndex: prefix.candidates[index].hostLocator.messageIndex, floorId: floor.id }]);
          assertCapturedBranchTargetMatches(snapshot, targetFile, sourceChatId, targetChatId, { expectedBindings: branchBindings });
          const createdAt = initializationTime ?? nowIso(now);
          const descriptorId = source.migrationDescriptor
            ? await deterministicUuid(['branch-migration-descriptor-v1', targetChatId, source.migrationDescriptor.id,
              prefix.floors.map(floor => floor.id), partitioned.aliasWitnesses]) : null;
          const inputSnapshot = await branchInputSnapshot(candidates, prefix.count, partitioned, descriptorId);
          const generationParts = ['generation', targetChatId, prefix.floors.map(floor => floor.content.canonicalFingerprint)];
          if (descriptorId) generationParts.push(descriptorId);
          const narrativeGeneration = await deterministicUuid(generationParts);
          const runId = await deterministicUuid(['foundation-branch-run-v1', targetChatId, sourceChatId, inputSnapshot.fingerprint]);
          const checkpointId = await deterministicUuid(['foundation-branch-checkpoint-v1', targetChatId, sourceChatId, inputSnapshot.fingerprint]);
          const floors = prefix.floors.map((floor, index) => validateFoundationFloor({
            ...rehome(floor, targetChatId, narrativeGeneration),
            assistantSeq: index + 1,
            predecessorFloorId: prefix.floors[index - 1]?.id ?? null,
            hostLocator: { ...prefix.candidates[index].hostLocator },
            processing: { ...floor.processing, runId, checkpointId },
            // Keep the cloned timestamp valid even when a preparing binding is resumed much later.
            updatedAt: Date.parse(floor.updatedAt) > Date.parse(createdAt) ? floor.updatedAt : createdAt,
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
          const copiedTimeBatchIds = source.migrationDescriptor
            ? await timeStore.copyPrefix(sourceChatId, targetChatId, floors, signal) : [];
          const peopleCopy = source.migrationDescriptor
            ? await copyLatestPeople({ peopleStore, sourceIdentity, targetIdentity, entities: projected.entities, now: createdAt, signal,
              snapshotSourceIds: source.migrationDescriptor.recordRefs.peopleSnapshotIds }) : null;
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
            ...(descriptorId ? { migrationDescriptorId: descriptorId } : {}),
            indexManifest: { ...emptyIndexManifest(), floor: indexKeys }, activeStateRefs: projected.currentState ? [projected.currentState.id] : [], activeThreadRefs: [],
            createdAt, updatedAt: createdAt, recordStatus: 'active', supersedes: null,
          }, { expectedChatId: targetChatId });
          const descriptor = descriptorId ? branchMigrationDescriptor({ source, targetChatId, descriptorId,
            retainedFloors: floors, projected, indexKeys, timeBatchIds: copiedTimeBatchIds, peopleCopy, partitioned, createdAt }) : null;
          await validatePreparedFoundation({ checkpoint, run, floors, floorMemories: projected.floorMemories, entities: projected.entities, indexes, indexKeys });
          await validateCseGraph({ root, checkpoint, run, floors, floorMemories: projected.floorMemories, entities: projected.entities, indexes, indexKeys, baseline: projected.baseline, stateDeltas: projected.stateDeltas, currentStates: projected.currentState ? [projected.currentState] : [] });
          await saveRecords(targetStore, [run, ...floors, ...projected.floorMemories, ...projected.entities, ...(projected.baseline ? [projected.baseline] : []), ...projected.stateDeltas, ...(projected.currentState ? [projected.currentState] : []), ...indexes, ...(descriptor ? [descriptor] : [])], signal);
          const checkpointResult = await targetStore.putRecord(checkpoint, { signal });
          if (!['saved', 'reused'].includes(checkpointResult.status)) throw fail('V3_BRANCH_RECORD_CONFLICT', '分支记忆记录发生冲突，未提交目标根。');
          const committed = await targetStore.commitRoot(root, 0, { signal });
          if (!['saved'].includes(committed.status)) {
            target = await targetStore.readReachable();
            if (!['ready', 'needsReseal'].includes(target.status) || target.root.headCheckpointId !== checkpointId) throw fail('V3_BRANCH_ROOT_CONFLICT', '分支目标根发生冲突，未覆盖已有数据。');
          } else target = committed.reachable;
          bindings = branchBindings;
          retainedFloorIds = floorIds;
          await copyLatestPeople({ peopleStore, sourceIdentity, targetIdentity, entities: projected.entities, now: createdAt, signal });
        }
      } else if (source.status !== 'uninitialized') {
        throw fail('V3_BRANCH_SOURCE_UNAVAILABLE', '源聊天记忆暂时无法读取，未把错误当成空档。');
      }
    } else {
      throw fail('V3_BRANCH_TARGET_UNAVAILABLE', '分支目标记忆暂时无法读取。');
    }

    await timeStore.copyPrefix(sourceChatId, targetChatId, target.floors ?? [], signal);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const savedMessages = await persistBranchedMessageMetadata({ target: fixedTarget, chat: snapshot.chat, chatMetadata: snapshot.chatMetadata, sourceChatId, targetChatId, bindings, retainedFloorIds, signal, fetchImpl });
    projectSavedBranchMetadata(raw, hostAdapter, host.hostChatId, snapshot.chat, savedMessages, targetChatId);
    if (retainedFloorIds.length && target.status === 'ready') {
      try {
        if (!sourceReachable) {
          const sourceRoot = await sourceStore.readRoot();
          if (sourceRoot?.status === 'ready' && sourceRoot.data?.chatId === sourceChatId) {
            // A resumed target already supplies the validated copied prefix; only the source root is needed for cache ownership.
            sourceReachable = { ...target, root: sourceRoot.data };
          }
        }
        if (sourceReachable?.status === 'ready') {
          await vectorRuntimeProvider()?.copyPrefix?.(sourceIdentity, targetIdentity, target.root.narrativeGeneration,
            sourceReachable, { retainedFloorIds, targetReachable: target });
        }
      } catch { /* Vector indexes are derived caches; their failure must not block branch readiness. */ }
    }
    return Object.freeze({ status: retainedFloorIds.length ? 'inherited' : 'empty', inheritedFloors: retainedFloorIds.length, persistedIdentity: targetChatId });
  };
}
