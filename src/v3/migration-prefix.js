import { isUuid } from '../identity.js';
import { normalizeStoryCalendar } from './calendar-rules.js';

const fail = code => { throw Object.assign(new TypeError(code), { code }); };
const clone = value => structuredClone(value);
const descriptorKey = id => `v3-migration-${id}`;
const partitionMemo = new WeakMap();

export function validateMigrationDescriptor(input, { expectedChatId } = {}) {
  const value = clone(input);
  const exact = (object, keys) => {
    if (!object || typeof object !== 'object' || Array.isArray(object)) fail('V3_MIGRATION_DESCRIPTOR_INVALID');
    const actual = Object.keys(object).sort(), expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail('V3_MIGRATION_DESCRIPTOR_INVALID');
  };
  exact(value, ['schemaVersion', 'recordType', 'id', 'chatId', 'source', 'createdAt', 'frozenFloorIds', 'floorOrigins', 'carriedAliases', 'summarySources', 'sourcePrequelSnapshots', 'sourceCalendarSnapshots', 'sourceTimeHeadSnapshots', 'sourceFloorProvenance', 'recordRefs']);
  if (value.schemaVersion !== 1 || value.recordType !== 'migrationDescriptor' || !isUuid(value.id) || !isUuid(value.chatId)
    || (expectedChatId && value.chatId !== expectedChatId) || !Number.isFinite(Date.parse(value.createdAt))) fail('V3_MIGRATION_DESCRIPTOR_INVALID');
  exact(value.source, ['chatId', 'hostChatId', 'characterLocator', 'personaLocator', 'narrativeGeneration', 'headCheckpointId', 'sourceSnapshotFingerprint', 'rootRevision']);
  if (!isUuid(value.source.chatId) || !isUuid(value.source.narrativeGeneration)
    || typeof value.source.hostChatId !== 'string' || !value.source.hostChatId
    || typeof value.source.characterLocator !== 'string' || !value.source.characterLocator
    || typeof value.source.personaLocator !== 'string' || !value.source.personaLocator
    || typeof value.source.headCheckpointId !== 'string' || !value.source.headCheckpointId
    || typeof value.source.sourceSnapshotFingerprint !== 'string'
    || !Number.isSafeInteger(value.source.rootRevision) || value.source.rootRevision < 1) fail('V3_MIGRATION_DESCRIPTOR_INVALID');
  if (!Array.isArray(value.frozenFloorIds) || value.frozenFloorIds.some(id => !isUuid(id)) || new Set(value.frozenFloorIds).size !== value.frozenFloorIds.length) fail('V3_MIGRATION_DESCRIPTOR_INVALID');
  const floorSet = new Set(value.frozenFloorIds);
  if (!Array.isArray(value.floorOrigins) || value.floorOrigins.length !== value.frozenFloorIds.length) fail('V3_MIGRATION_DESCRIPTOR_INVALID');
  const origins = new Set();
  for (const origin of value.floorOrigins) {
    exact(origin, ['floorId', 'sourceChatId', 'sourceHostChatId', 'sourceMessageIndex', 'swipeId', 'selectedSwipeIndex']);
    if (!floorSet.has(origin.floorId) || origins.has(origin.floorId) || !isUuid(origin.sourceChatId)
      || typeof origin.sourceHostChatId !== 'string' || !origin.sourceHostChatId
      || !Number.isSafeInteger(origin.sourceMessageIndex) || origin.sourceMessageIndex < 0
      || (origin.swipeId !== null && !['string', 'number'].includes(typeof origin.swipeId))
      || (origin.selectedSwipeIndex !== null && (!Number.isSafeInteger(origin.selectedSwipeIndex) || origin.selectedSwipeIndex < 0))) fail('V3_MIGRATION_DESCRIPTOR_INVALID');
    origins.add(origin.floorId);
  }
  if (!Array.isArray(value.carriedAliases)) fail('V3_MIGRATION_DESCRIPTOR_INVALID');
  const aliasIndexes = new Set(), aliasIds = new Set();
  for (const alias of value.carriedAliases) {
    exact(alias, ['aliasId', 'floorId', 'targetMessageIndex', 'canonicalFingerprint', 'rawFingerprint']);
    if (!isUuid(alias.aliasId) || aliasIds.has(alias.aliasId) || !floorSet.has(alias.floorId)
      || !Number.isSafeInteger(alias.targetMessageIndex) || alias.targetMessageIndex < 0
      || aliasIndexes.has(alias.targetMessageIndex) || typeof alias.canonicalFingerprint !== 'string' || typeof alias.rawFingerprint !== 'string') fail('V3_MIGRATION_DESCRIPTOR_INVALID');
    aliasIds.add(alias.aliasId);
    aliasIndexes.add(alias.targetMessageIndex);
  }
  if (!Array.isArray(value.summarySources)) fail('V3_MIGRATION_DESCRIPTOR_INVALID');
  const summaryTargets = new Set();
  for (const item of value.summarySources) {
    exact(item, ['targetFloorId', 'sourceFloorId', 'sourceChatId', 'rawFingerprint']);
    if (!isUuid(item.targetFloorId) || !isUuid(item.sourceFloorId) || !isUuid(item.sourceChatId)
      || summaryTargets.has(item.targetFloorId) || typeof item.rawFingerprint !== 'string') fail('V3_MIGRATION_DESCRIPTOR_INVALID');
    summaryTargets.add(item.targetFloorId);
  }
  if (!Array.isArray(value.sourcePrequelSnapshots) || value.sourcePrequelSnapshots.some(item => typeof item !== 'string')) fail('V3_MIGRATION_DESCRIPTOR_INVALID');
  if (!Array.isArray(value.sourceCalendarSnapshots)) fail('V3_MIGRATION_DESCRIPTOR_INVALID');
  for (const item of value.sourceCalendarSnapshots) {
    exact(item, ['sourceChatId', 'calendar']);
    if (!isUuid(item.sourceChatId) || !normalizeStoryCalendar(item.calendar)) fail('V3_MIGRATION_DESCRIPTOR_INVALID');
  }
  if (!Array.isArray(value.sourceTimeHeadSnapshots)) fail('V3_MIGRATION_DESCRIPTOR_INVALID');
  for (const item of value.sourceTimeHeadSnapshots) {
    exact(item, ['sourceChatId', 'head']);
    if (!isUuid(item.sourceChatId) || !item.head || typeof item.head !== 'object' || Array.isArray(item.head)
      || item.head.schemaVersion !== 1 || item.head.chatId !== item.sourceChatId || !Array.isArray(item.head.batchIds)
      || item.head.batchIds.some(id => typeof id !== 'string' || !id)) fail('V3_MIGRATION_DESCRIPTOR_INVALID');
  }
  if (!Array.isArray(value.sourceFloorProvenance)) fail('V3_MIGRATION_DESCRIPTOR_INVALID');
  const provenanceFloors = new Set();
  for (const item of value.sourceFloorProvenance) {
    exact(item, ['floorId', 'timeEdited', 'storyClockSignature']);
    if (!floorSet.has(item.floorId) || provenanceFloors.has(item.floorId) || typeof item.timeEdited !== 'boolean'
      || (item.storyClockSignature !== null && typeof item.storyClockSignature !== 'string')) fail('V3_MIGRATION_DESCRIPTOR_INVALID');
    provenanceFloors.add(item.floorId);
  }
  exact(value.recordRefs, ['floors', 'floorMemories', 'entities', 'baselineId', 'stateDeltas', 'currentStateIds', 'indexKeys', 'timeBatchIds', 'vectorShardIds', 'peopleWorkspaceId', 'peopleSnapshotIds']);
  for (const key of ['floors', 'floorMemories', 'entities', 'stateDeltas', 'currentStateIds', 'indexKeys', 'timeBatchIds', 'vectorShardIds', 'peopleSnapshotIds']) {
    if (!Array.isArray(value.recordRefs[key]) || value.recordRefs[key].some(ref => typeof ref !== 'string' || !ref)) fail('V3_MIGRATION_DESCRIPTOR_INVALID');
  }
  if (value.recordRefs.floors.length !== value.frozenFloorIds.length
    || value.recordRefs.floors.some((id, index) => id !== value.frozenFloorIds[index])
    || (value.recordRefs.baselineId !== null && typeof value.recordRefs.baselineId !== 'string')
    || (value.recordRefs.peopleWorkspaceId !== null && typeof value.recordRefs.peopleWorkspaceId !== 'string')) fail('V3_MIGRATION_DESCRIPTOR_INVALID');
  return Object.freeze(value);
}

export function createMigrationDescriptor({ id, chatId, source, reachable, carriedAliases = [], summarySources = [], sourcePrequelSnapshots = [], sourceCalendarSnapshots = [], sourceTimeHeadSnapshots = [], timeBatchIds = [], vectorShardIds = [], recordRefs = null, createdAt }) {
  if (!reachable?.root || !reachable?.checkpoint || !Array.isArray(reachable.floors)) fail('V3_MIGRATION_SOURCE_NOT_READY');
  const originsByFloor = new Map();
  const previous = reachable.migrationDescriptor;
  for (const origin of previous?.floorOrigins ?? []) originsByFloor.set(origin.floorId, origin);
  const floorOrigins = reachable.floors.map(floor => originsByFloor.get(floor.id) ?? ({
    floorId: floor.id,
    sourceChatId: source.chatId,
    sourceHostChatId: source.hostChatId,
    sourceMessageIndex: floor.hostLocator.messageIndex,
    swipeId: floor.hostLocator.swipeId,
    selectedSwipeIndex: floor.hostLocator.selectedSwipeIndex,
  }));
  const frozenFloorIds = reachable.floors.map(floor => floor.id);
  const descriptor = {
    schemaVersion: 1, recordType: 'migrationDescriptor', id, chatId, createdAt,
    source: {
      chatId: source.chatId, hostChatId: source.hostChatId,
      characterLocator: source.characterLocator, personaLocator: source.personaLocator,
      narrativeGeneration: reachable.root.narrativeGeneration,
      headCheckpointId: reachable.root.headCheckpointId,
      sourceSnapshotFingerprint: reachable.root.sourceSnapshotFingerprint,
      rootRevision: reachable.rootRevision,
    },
    frozenFloorIds, floorOrigins, carriedAliases, summarySources,
    sourcePrequelSnapshots: [...new Set([...(previous?.sourcePrequelSnapshots ?? []), ...sourcePrequelSnapshots])],
    sourceCalendarSnapshots: [...new Map([...(previous?.sourceCalendarSnapshots ?? []), ...sourceCalendarSnapshots].map(item => [item.sourceChatId, clone(item)])).values()],
    sourceTimeHeadSnapshots: [...new Map([...(previous?.sourceTimeHeadSnapshots ?? []), ...sourceTimeHeadSnapshots].map(item => [item.sourceChatId, clone(item)])).values()],
    sourceFloorProvenance: (() => {
      const provenance = new Map((previous?.sourceFloorProvenance ?? []).map(item => [item.floorId, item]));
      const current = reachable.run?.diagnostics?.floorProvenance ?? {};
      for (const floor of reachable.floors) {
        const value = current[floor.id];
        if (value && typeof value === 'object') provenance.set(floor.id, { floorId: floor.id,
          timeEdited: value.timeEdited === true, storyClockSignature: typeof value.storyClockSignature === 'string' ? value.storyClockSignature : null });
      }
      return [...provenance.values()].filter(item => frozenFloorIds.includes(item.floorId));
    })(),
    recordRefs: recordRefs ? clone(recordRefs) : {
      floors: frozenFloorIds,
      floorMemories: reachable.checkpoint.producedRefs.floorMemories,
      entities: reachable.checkpoint.producedRefs.entities,
      baselineId: reachable.root.baselineId,
      stateDeltas: reachable.checkpoint.producedRefs.stateDeltas,
      currentStateIds: reachable.checkpoint.producedRefs.currentStates,
      indexKeys: reachable.checkpoint.producedRefs.indexes,
      timeBatchIds, vectorShardIds, peopleWorkspaceId: null, peopleSnapshotIds: [],
    },
  };
  return validateMigrationDescriptor(descriptor, { expectedChatId: chatId });
}

export function migrationPartition(reachable) {
  const descriptor = reachable?.migrationDescriptor;
  if (!descriptor) return Object.freeze({ descriptor: null, frozenFloorIds: new Set(), frozenFloors: Object.freeze([]),
    liveFloors: Object.freeze([...(reachable?.floors ?? [])]), isFrozenFloor: () => false, originForFloor: () => null,
    aliasForMessage: () => null, aliasById: () => null });
  if (reachable && typeof reachable === 'object') {
    const memo = partitionMemo.get(reachable);
    if (memo) return memo;
  }
  const frozen = new Set(descriptor?.frozenFloorIds ?? []);
  const originByFloor = new Map((descriptor?.floorOrigins ?? []).map(value => [value.floorId, value]));
  const aliases = new Map((descriptor?.carriedAliases ?? []).map(value => [value.targetMessageIndex, value]));
  const result = Object.freeze({
    descriptor,
    frozenFloorIds: frozen,
    frozenFloors: Object.freeze((reachable?.floors ?? []).filter(floor => frozen.has(floor.id))),
    liveFloors: Object.freeze((reachable?.floors ?? []).filter(floor => !frozen.has(floor.id))),
    isFrozenFloor: floorId => frozen.has(floorId),
    originForFloor: floorId => originByFloor.get(floorId) ?? null,
    aliasForMessage: messageIndex => aliases.get(messageIndex) ?? null,
    aliasById: aliasId => [...aliases.values()].find(value => value.aliasId === aliasId) ?? null,
  });
  if (reachable && typeof reachable === 'object') partitionMemo.set(reachable, result);
  return result;
}

export function floorProvenanceForReachable(reachable) {
  const current = reachable?.run?.diagnostics?.floorProvenance;
  const result = current && typeof current === 'object' ? clone(current) : {};
  const frozen = reachable?.migrationDescriptor?.sourceFloorProvenance ?? [];
  const byFloorId = new Map(frozen.map(item => [item.floorId, item]));
  for (const item of frozen) {
    result[item.floorId] = { ...(result[item.floorId] ?? {}), timeEdited: item.timeEdited,
      ...(item.storyClockSignature === null ? {} : { storyClockSignature: item.storyClockSignature }) };
  }
  for (const summary of reachable?.migrationDescriptor?.summarySources ?? []) {
    const source = byFloorId.get(summary.sourceFloorId);
    if (!source) continue;
    const live = result[summary.targetFloorId] ?? {};
    result[summary.targetFloorId] = {
      timeEdited: Object.hasOwn(live, 'timeEdited') ? live.timeEdited : source.timeEdited,
      ...((live.storyClockSignature ?? source.storyClockSignature) === undefined ? {} : {
        storyClockSignature: live.storyClockSignature ?? source.storyClockSignature,
      }),
    };
  }
  return result;
}

export function migrationDescriptorRecordKey(id) { return descriptorKey(id); }
export const MIGRATION_ALIAS_KEY = 'qianqianjie_migration_alias';

export function partitionScannedCandidates(reachable, chat, chatId, scanned) {
  const partition = migrationPartition(reachable);
  if (!partition.descriptor || !partition.frozenFloors.length) return Object.freeze({ all: scanned, live: scanned, aliasIndexes: new Set(), descriptorId: null, aliasWitnesses: Object.freeze([]) });
  const frozenById = new Map(partition.frozenFloors.map(floor => [floor.id, floor]));
  const aliasesById = new Map(partition.descriptor.carriedAliases.map(alias => [alias.aliasId, alias]));
  const aliasLocations = new Map();
  for (const [index, message] of (Array.isArray(chat) ? chat : []).entries()) {
    const aliasId = message?.extra?.[MIGRATION_ALIAS_KEY];
    if (aliasesById.has(aliasId)) {
      if (!aliasLocations.has(aliasId)) aliasLocations.set(aliasId, []);
      aliasLocations.get(aliasId).push(index);
    }
  }
  const live = [], aliasIndexes = new Set(), aliasWitnesses = [];
  for (const candidate of scanned) {
    const index = candidate.hostLocator.messageIndex, aliasId = chat?.[index]?.extra?.[MIGRATION_ALIAS_KEY];
    const alias = aliasesById.get(aliasId);
    const message = chat?.[index], frozenFloor = alias && frozenById.get(alias.floorId);
    const exactAlias = Boolean(alias && frozenFloor && aliasLocations.get(alias.aliasId)?.length === 1
      && candidate.rawFingerprint === alias.rawFingerprint && candidate.canonicalFingerprint === alias.canonicalFingerprint
      && candidate.rawFingerprint === frozenFloor.content.rawFingerprint
      && candidate.canonicalFingerprint === frozenFloor.content.canonicalFingerprint);
    if (exactAlias) {
      aliasIndexes.add(index);
      aliasWitnesses.push(Object.freeze({ aliasId: alias.aliasId, messageIndex: index, rawFingerprint: candidate.rawFingerprint, canonicalFingerprint: candidate.canonicalFingerprint }));
      continue;
    }
    live.push(Object.freeze({ ...candidate, assistantSeq: partition.frozenFloors.length + live.length + 1 }));
  }
  const historical = partition.frozenFloors.map(floor => Object.freeze({
    assistantSeq: floor.assistantSeq,
    archiveCandidate: true,
    archiveFloorId: floor.id,
    messageAnchor: Object.freeze({ status: 'archive', anchor: null }),
    hostLocator: Object.freeze({ ...floor.hostLocator }),
    rawFingerprint: floor.content.rawFingerprint,
    canonicalFingerprint: floor.content.canonicalFingerprint,
    sanitizerFingerprint: floor.content.sanitizerFingerprint,
    canonicalContent: floor.content.canonicalContent,
    stabilityProof: floor.stability?.proof ? Object.freeze({ ...floor.stability.proof }) : null,
  }));
  return Object.freeze({ all: Object.freeze([...historical, ...live]), live: Object.freeze(live), aliasIndexes, aliasWitnesses: Object.freeze(aliasWitnesses), descriptorId: partition.descriptor.id });
}
