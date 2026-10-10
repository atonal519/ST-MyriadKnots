import { sha256 } from '../identity.js';
import { createCheckpointInputFingerprints, createFloorRecord, deterministicUuid, foundationInputSnapshot, scanAssistantCandidates } from './foundation-domain.js';
import { buildFoundationIndexes, validatePreparedFoundation } from './foundation-runtime.js';
import { validateFoundationCheckpoint, validateFoundationFloor, validateFoundationRoot, validateFoundationRun, V3_INDEX_LAYOUT_FLOOR_ORDER } from './foundation-schema.js';
import { validateBaselineRecord, validateCseGraph, validateCurrentStateRecord, validateStateDeltaRecord } from './cse-schema.js';
import { validateEntityRecord, validateFloorMemory } from './memory-schema.js';
import { replayCurrentState } from './cse-engine.js';
import { createMigrationDescriptor, migrationDescriptorRecordKey, migrationPartition, partitionScannedCandidates, validateMigrationDescriptor } from './migration-prefix.js';

const emptyIndexManifest = () => ({ floor: [], entity: [], event: [], claim: [], knowledge: [], episode: [], thread: [], state: [], anchor: [], reverseRef: [] });
const hash = async value => `sha256:${await sha256(JSON.stringify(value))}`;
const rehome = (record, chatId, narrativeGeneration) => record ? { ...structuredClone(record), chatId, narrativeGeneration } : null;
const timestamp = value => {
  const result = typeof value === 'string' ? value : value?.toISOString?.();
  if (!result || !Number.isFinite(Date.parse(result))) throw Object.assign(new TypeError('V3_MIGRATION_TIME_INVALID'), { code: 'V3_MIGRATION_TIME_INVALID' });
  return result;
};
const fail = code => { throw Object.assign(new Error(code), { code }); };

async function saveRecords(store, records) {
  let cursor = 0, failure = null;
  async function worker() {
    while (!failure) {
      const index = cursor++;
      if (index >= records.length) return;
      try {
        const result = await store.putRecord(records[index]);
        if (!['saved', 'reused'].includes(result.status)) fail('V3_MIGRATION_RECORD_WRITE_FAILED');
      } catch (error) { failure ??= error; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, records.length) }, () => worker()));
  if (failure) throw failure;
}

export function selectCompletedCarriedAliases({ reachable, carried = [], sourceCandidates = [], newUuid }) {
  const memories = new Map((reachable?.floorMemories ?? []).filter(item => item.recordStatus === 'active').map(item => [item.floorId, item]));
  const deltas = new Set((reachable?.stateDeltas ?? []).filter(item => item.recordStatus === 'active').map(item => item.floorId));
  const candidateByIndex = new Map(sourceCandidates.map(candidate => [candidate.hostLocator.messageIndex, candidate]));
  const priorAliases = new Map((reachable?.migrationDescriptor?.carriedAliases ?? []).map(alias => [alias.aliasId, alias]));
  const aliases = [];
  for (const item of carried) {
    if (!item || !Number.isSafeInteger(item.sourceMessageIndex) || !Number.isSafeInteger(item.targetMessageIndex)) continue;
    const candidate = candidateByIndex.get(item.sourceMessageIndex);
    const prior = item.priorAliasId ? priorAliases.get(item.priorAliasId) : null;
    const explicitFloorId = item.sourceFloorId ?? prior?.floorId;
    const floor = explicitFloorId
      ? reachable?.floors?.find(value => value.id === explicitFloorId
        && value.content.rawFingerprint === item.rawFingerprint && value.content.canonicalFingerprint === item.canonicalFingerprint)
      : migrationPartition(reachable).liveFloors.find(value => value.hostLocator.messageIndex === item.sourceMessageIndex
        && value.content.rawFingerprint === item.rawFingerprint && value.content.canonicalFingerprint === item.canonicalFingerprint);
    const memory = floor && memories.get(floor.id);
    if (!candidate || !floor || candidate.rawFingerprint !== item.rawFingerprint || candidate.canonicalFingerprint !== item.canonicalFingerprint
      || memory?.recordStatus !== 'active' || !deltas.has(floor.id)) continue;
    aliases.push({ aliasId: item.aliasId ?? newUuid(), floorId: floor.id, targetMessageIndex: item.targetMessageIndex,
      rawFingerprint: item.rawFingerprint, canonicalFingerprint: item.canonicalFingerprint });
  }
  return Object.freeze(aliases.map(value => Object.freeze(value)));
}

/** Initialize a fresh B collection with a complete, independently rehomed frozen graph. */
export async function initializeMigrationGraph({ store, sourceIdentity, targetIdentity, sourceReachable, carriedAliases = [], targetChat = [],
  carriedSummary = null, summarySources = [], sourcePrequelSnapshots = [], sourceCalendarSnapshots = [], sourceTimeHeadSnapshots = [], timeBatchIds = [], vectorShardIds = [], peopleWorkspaceId = null, peopleSnapshotIds = [],
  sanitizerOptions = {}, now = () => new Date(), newUuid }) {
  if (!store?.readReachable || !store?.putRecord || !store?.commitRoot || !sourceReachable?.root || sourceReachable.status !== 'ready'
    || sourceReachable.root.chatId !== sourceIdentity?.chatId || targetIdentity?.chatId === sourceIdentity.chatId) fail('V3_MIGRATION_SOURCE_NOT_READY');
  const current = await store.readReachable({ mode: 'full' });
  if (current.status !== 'uninitialized') fail('V3_MIGRATION_TARGET_NOT_EMPTY');
  const createdAt = timestamp(now());
  const chatId = targetIdentity.chatId;
  const narrativeGeneration = await deterministicUuid(['qqj-migration-generation-v1', chatId, sourceReachable.root.narrativeGeneration, sourceReachable.root.headCheckpointId]);
  const runId = await deterministicUuid(['qqj-migration-run-v1', chatId, narrativeGeneration]);
  const checkpointId = await deterministicUuid(['qqj-migration-checkpoint-v1', chatId, narrativeGeneration]);
  const floors = sourceReachable.floors.map(floor => validateFoundationFloor({
    ...rehome(floor, chatId, narrativeGeneration),
    processing: { ...floor.processing, runId, checkpointId },
    updatedAt: createdAt,
  }, { expectedChatId: chatId }));
  const floorMemories = sourceReachable.floorMemories.map(record => validateFloorMemory(rehome(record, chatId, narrativeGeneration), { expectedChatId: chatId }));
  const entities = sourceReachable.entities.map(record => validateEntityRecord(rehome(record, chatId, narrativeGeneration), { expectedChatId: chatId }));
  const baseline = sourceReachable.baseline ? validateBaselineRecord(rehome(sourceReachable.baseline, chatId, narrativeGeneration), { expectedChatId: chatId }) : null;
  const stateDeltas = sourceReachable.stateDeltas.map(record => validateStateDeltaRecord(rehome(record, chatId, narrativeGeneration), { expectedChatId: chatId }));
  const currentState = baseline ? await replayCurrentState({ chatId, narrativeGeneration, baselineId: baseline.id, floors, floorMemories, stateDeltas, now: createdAt,
    id: await deterministicUuid(['qqj-migration-current-state', chatId, checkpointId]) }) : null;
  if (currentState) validateCurrentStateRecord(currentState, { expectedChatId: chatId });

  const candidateScan = await scanAssistantCandidates(targetChat, { sanitizerOptions, chatId });
  const provisional = createMigrationDescriptor({ id: newUuid(), chatId, source: sourceIdentity, reachable: sourceReachable, carriedAliases, createdAt });
  const partitioned = partitionScannedCandidates({ ...sourceReachable, migrationDescriptor: provisional }, targetChat, chatId, candidateScan);
  const carriedSummaryCandidate = carriedSummary
    ? partitioned.live.find(item => item.hostLocator.messageIndex === carriedSummary.targetMessageIndex) ?? null : null;
  const carriedSummaryFloor = carriedSummary
    ? sourceReachable.floors.find(item => item.id === carriedSummary.sourceFloorId) ?? null : null;
  const carriedSummaryMemory = carriedSummary
    ? sourceReachable.floorMemories.find(item => item.id === carriedSummary.sourceMemoryId && item.floorId === carriedSummary.sourceFloorId
      && item.recordStatus === 'active' && item.summary && (item.sourceFloorIds?.length ?? 1) === 1) ?? null : null;
  const carriedSummaryIsExact = Boolean(carriedSummaryCandidate && carriedSummaryFloor && carriedSummaryMemory
    && carriedSummaryCandidate.rawFingerprint === carriedSummaryFloor.content.rawFingerprint
    && carriedSummaryCandidate.canonicalFingerprint === carriedSummaryFloor.content.canonicalFingerprint);
  let stableCount = 0;
  while (partitioned.all[stableCount]) {
    const candidate = partitioned.all[stableCount];
    if (candidate.archiveCandidate === true || candidate.stabilityProof?.kind === 'nextUser'
      || carriedSummaryIsExact && candidate === carriedSummaryCandidate) stableCount += 1;
    else break;
  }
  const realStableCount = partitioned.all.slice(0, stableCount).filter(candidate => candidate.archiveCandidate !== true).length;
  const liveSnapshot = await foundationInputSnapshot(partitioned.live, realStableCount);
  const migrationWitness = { descriptorId: provisional.id, aliasWitnesses: partitioned.aliasWitnesses };
  const sourceSnapshotFingerprint = await hash({ fingerprint: liveSnapshot.fingerprint, ...migrationWitness });

  let carriedLiveFloor = null, carriedLiveMemory = null;
  const inheritedSummarySources = [...(sourceReachable.migrationDescriptor?.summarySources ?? []), ...summarySources];
  if (carriedSummaryIsExact) {
    const candidate = carriedSummaryCandidate;
    const sourceMemory = carriedSummaryMemory;
    if (candidate && sourceMemory) {
      carriedLiveFloor = validateFoundationFloor(createFloorRecord({ id: newUuid(), chatId, narrativeGeneration,
        candidate: { ...candidate, assistantSeq: sourceReachable.floors.length + 1 },
        predecessorFloorId: sourceReachable.floors.at(-1)?.id ?? null, runId, checkpointId, stabilizedBy: 'manual', now: createdAt }), { expectedChatId: chatId });
      const remapEvidence = ref => ({ ...ref, floorId: carriedLiveFloor.id, anchorId: null });
      const seed = structuredClone(sourceMemory);
      seed.id = newUuid(); seed.chatId = chatId; seed.narrativeGeneration = narrativeGeneration;
      seed.floorId = carriedLiveFloor.id; seed.sourceRawFingerprint = candidate.rawFingerprint;
      seed.sourceFloorIds = [carriedLiveFloor.id];
      if (Array.isArray(seed.sourceFloorSnapshots)) seed.sourceFloorSnapshots = seed.sourceFloorSnapshots.map(snapshot => ({ ...snapshot, floorId: carriedLiveFloor.id }));
      seed.summaryEvidenceRefs = (seed.summaryEvidenceRefs ?? []).map(remapEvidence);
      for (const field of ['chronology', 'locations', 'participants', 'actions', 'observations', 'informationTransfers', 'privateCognition',
        'commitments', 'eventFragments', 'openLoops', 'ambiguities', 'cseSignals']) {
        seed[field] = (seed[field] ?? []).map(item => ({ ...item,
          ...(Array.isArray(item.evidenceRefs) ? { evidenceRefs: item.evidenceRefs.map(remapEvidence) } : {}) }));
      }
      seed.exactAnchors = (seed.exactAnchors ?? []).map(item => ({ ...item,
        ...(item.floorId ? { floorId: carriedLiveFloor.id } : {}),
        ...(item.sourceFloorId ? { sourceFloorId: carriedLiveFloor.id } : {}) }));
      // 千事事件仍由冻结楼唯一持有；B 的 live 摘要保留可用语义证据，不复制旧事件身份。
      seed.qianshiDelta = { schemaVersion: 1, status: 'empty', reason: null, compiledAt: createdAt,
        candidateStats: { count: 0, characters: 0 }, events: [], relations: [] };
      seed.createdAt = createdAt; seed.updatedAt = createdAt; seed.recordStatus = 'active'; seed.supersedes = null;
      carriedLiveMemory = validateFloorMemory(seed, { expectedChatId: chatId });
      inheritedSummarySources.push({ targetFloorId: carriedLiveFloor.id, sourceFloorId: carriedSummary.sourceFloorId,
        sourceChatId: sourceIdentity.chatId, rawFingerprint: candidate.rawFingerprint });
    }
  }
  const allFloors = carriedLiveFloor ? [...floors, carriedLiveFloor] : floors;
  const allFloorMemories = carriedLiveMemory ? [...floorMemories, carriedLiveMemory] : floorMemories;

  const indexes = await buildFoundationIndexes({ chatId, narrativeGeneration, checkpointId, floors: allFloors,
    candidates: partitioned.all.slice(0, allFloors.length), now: createdAt });
  const indexKeys = indexes.map(record => store.recordKey(record));
  const descriptor = validateMigrationDescriptor(createMigrationDescriptor({
    id: provisional.id, chatId, source: sourceIdentity, reachable: sourceReachable, carriedAliases,
    summarySources: inheritedSummarySources, sourcePrequelSnapshots, sourceCalendarSnapshots, sourceTimeHeadSnapshots,
    recordRefs: { floors: sourceReachable.floors.map(item => item.id), floorMemories: sourceReachable.floorMemories.map(item => item.id), entities: sourceReachable.entities.map(item => item.id),
      baselineId: baseline?.id ?? null, stateDeltas: stateDeltas.map(item => item.id), currentStateIds: currentState ? [currentState.id] : [],
      indexKeys, timeBatchIds, vectorShardIds, peopleWorkspaceId, peopleSnapshotIds }, createdAt,
  }), { expectedChatId: chatId });
  const floorIds = allFloors.map(floor => floor.id);
  const capabilities = { ...sourceReachable.checkpoint.capabilities };
  const run = validateFoundationRun({ schemaVersion: 3, recordType: 'run', id: runId, chatId, narrativeGeneration,
    parentCheckpointId: null, inputSnapshotFingerprint: sourceSnapshotFingerprint, mode: 'branchReplay', sessionEpoch: 0,
    inputFloorIds: floorIds, phase: 'completed', completedFloorIds: floorIds, failedItems: [], preparedRecordRefs: [], diagnostics: null,
    startedAt: createdAt, createdAt, updatedAt: createdAt, recordStatus: 'staged', supersedes: null }, { expectedChatId: chatId });
  const stateFingerprint = await hash([narrativeGeneration, floorIds, allFloors.map(floor => floor.content.canonicalFingerprint)]);
  const checkpoint = validateFoundationCheckpoint({ schemaVersion: 3, recordType: 'checkpoint', id: checkpointId, chatId, narrativeGeneration,
    parentCheckpointId: null, runId, sourceSnapshotFingerprint, indexLayout: V3_INDEX_LAYOUT_FLOOR_ORDER, capabilities,
    floorRange: { fromAssistantSeq: allFloors.length ? 1 : 0, toAssistantSeq: allFloors.length, floorIds },
    inputFingerprints: createCheckpointInputFingerprints(allFloors, { previous: sourceReachable.checkpoint?.inputFingerprints }),
    producedRefs: { floors: floorIds, floorMemories: allFloorMemories.map(record => record.id), entities: entities.map(record => record.id),
      events: [], claims: [], knowledge: [], stateDeltas: stateDeltas.map(record => record.id), currentStates: currentState ? [currentState.id] : [],
      stateProjections: [], episodes: [], threads: [], indexes: indexKeys },
    validation: { schemaValid: true, referencesValid: true, orderedReplayValid: true, stateFingerprint }, sealedAt: createdAt,
    createdAt, updatedAt: createdAt, recordStatus: 'active', supersedes: null }, { expectedChatId: chatId });
  const boundary = allFloors.at(-1) ?? null;
  const root = validateFoundationRoot({ schemaVersion: 3, recordType: 'root', id: 'root', chatId, narrativeGeneration, status: 'ready', capabilities,
    headCheckpointId: checkpointId, sourceSnapshotFingerprint,
    stableBoundary: { assistantSeq: allFloors.length, floorId: boundary?.id ?? null, canonicalFingerprint: boundary?.content?.canonicalFingerprint ?? null },
    baselineId: baseline?.id ?? null, activeRunId: null, migrationDescriptorId: descriptor.id,
    indexManifest: { ...emptyIndexManifest(), floor: indexKeys.filter(key => key.includes('-floorOrder-') || key.includes('-fingerprint-')), entity: indexKeys.filter(key => key.includes('-entity-')), reverseRef: indexKeys.filter(key => key.includes('-reverseRef-')) },
    activeStateRefs: currentState ? [currentState.id] : [], activeThreadRefs: [], createdAt, updatedAt: createdAt, recordStatus: 'active', supersedes: null }, { expectedChatId: chatId });

  await validatePreparedFoundation({ checkpoint, run, floors: allFloors, floorMemories: allFloorMemories, entities, indexes, indexKeys });
  await validateCseGraph({ root, checkpoint, run, floors: allFloors, floorMemories: allFloorMemories, entities, indexes, indexKeys, baseline, stateDeltas, currentStates: currentState ? [currentState] : [] });
  const contentRecords = [run, ...floors, ...(carriedLiveFloor ? [carriedLiveFloor] : []), ...floorMemories,
    ...(carriedLiveMemory ? [carriedLiveMemory] : []), ...entities, ...(baseline ? [baseline] : []), ...stateDeltas,
    ...(currentState ? [currentState] : []), ...indexes, descriptor, checkpoint];
  await saveRecords(store, contentRecords);
  const committed = await store.commitRoot(root, 0, { awaitCoreCachePublish: true });
  if (committed.status !== 'saved') fail('V3_MIGRATION_ROOT_CONFLICT');
  const result = committed.reachable;
  if (result?.status !== 'ready' || result.root.headCheckpointId !== checkpointId || result.migrationDescriptor?.id !== descriptor.id) fail('V3_MIGRATION_VERIFY_FAILED');
  return Object.freeze({ status: 'ready', reachable: result, descriptor, createdAt, recordCount: contentRecords.length });
}
