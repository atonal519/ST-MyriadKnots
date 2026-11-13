import { placeWorkspaceDependency } from './place-foundation.js';
import { deriveCseTimeline, filterReachableDeltas, projectCseDeltasForSources, replayCurrentState } from './cse-engine.js';
import { assessMemoryCoverageFromHost, memoryCoverageHostBindings } from './memory-coverage.js';
import {
  buildEntityIdentityDirectory, deriveUserIdentityProjection, projectCseStateIdentityReferences,
  projectFloorMemoryIdentityReferences, resolveIdentityEntityId,
} from './entity-identity.js';
import { memorySourceFloorIds } from './memory-schema.js';
import { projectVectorSources } from './vector-source.js';
import { migrationPartition } from './migration-prefix.js';
import { isMemoryExcludedFloor } from './memory-exclusion.js';

const safeText = (value, maximum = 4000) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);
const aliasText = alias => safeText(typeof alias === 'string' ? alias : alias?.name, 500);
const summaryText = memory => safeText(memory.summary?.effectiveSource === 'user' ? memory.summary?.userText : memory.summary?.aiText);
const sourceStatus = value => value?.status === 'stale' ? 'stale' : 'unavailable';

const chronologyText = item => safeText(item?.time?.sourceText || item?.time?.normalized || item?.description, 2000);
const CHRONOLOGY_KIND = Object.freeze({ explicit: '明确时间', relative: '相对时间', sequenceOnly: '先后顺序', unknown: '时间未知' });
const CHRONOLOGY_PRECISION = Object.freeze({ approximate: '约略', unresolved: '未解析' });
const hostLocatorDto = floor => floor?.hostLocator && Number.isSafeInteger(floor.hostLocator.messageIndex)
  ? Object.freeze({ messageIndex: floor.hostLocator.messageIndex, swipeId: floor.hostLocator.swipeId ?? null,
    selectedSwipeIndex: floor.hostLocator.selectedSwipeIndex ?? null }) : null;

export function formatChronologyAnchor(chronology) {
  const values = [];
  for (const item of Array.isArray(chronology) ? chronology : []) {
    const content = chronologyText(item);
    if (!content) continue;
    const kind = CHRONOLOGY_KIND[item?.time?.kind] ?? CHRONOLOGY_KIND.unknown;
    const qualifiers = [];
    if (CHRONOLOGY_PRECISION[item?.time?.precision]) qualifiers.push(CHRONOLOGY_PRECISION[item.time.precision]);
    if (Number.isSafeInteger(item?.time?.relativeToAssistantSeq) && item.time.relativeToAssistantSeq > 0) qualifiers.push(`相对 AI #${item.time.relativeToAssistantSeq}`);
    const value = `${kind}${qualifiers.length ? `（${qualifiers.join('；')}）` : ''}：${content}`;
    if (!values.includes(value)) values.push(value);
  }
  return values.join('；');
}

function chronologyDto(memory, floorSeqById) {
  return Object.freeze((memory.chronology ?? []).map(item => Object.freeze({
    time: Object.freeze({
      kind: item.time.kind,
      sourceText: item.time.sourceText === null ? null : safeText(item.time.sourceText, 500),
      normalized: item.time.normalized === null ? null : safeText(item.time.normalized, 500),
      precision: item.time.precision,
      relativeToAssistantSeq: item.time.relativeToFloorId ? (floorSeqById.get(item.time.relativeToFloorId) ?? null) : null,
    }),
    description: safeText(item.description, 2000),
  })));
}

function memoryDto(memory, floor, { chronologyAllowed = true, floorSeqById = new Map(), floorById = new Map() } = {}) {
  const sourceFloorIds = memorySourceFloorIds(memory);
  const currentSource=item=>item.source?{source:Object.freeze({kind:item.source.kind,locator:item.source.locator,knownFromFloorId:item.source.knownFromFloorId,knownFromAssistantSeq:floorSeqById.get(item.source.knownFromFloorId??memory.floorId)??null}),replacesItemIds:Object.freeze([...new Set([...(item.replacesItemIds??[]),...(item.source.replacesItemIds??[])])])}:{};
  const sourceRefs = refs => Object.freeze((refs ?? []).map(ref => Object.freeze({
    floorId: ref.floorId,
    assistantSeq: floorSeqById.get(ref.floorId) ?? null,
    quotedText: safeText(ref.quotedText, 500),
  })));
  return Object.freeze({
    floorId: floor.id,
    floorMemoryId: memory.id,
    assistantSeq: floor.assistantSeq,
    sourceFloorIds: Object.freeze(sourceFloorIds),
    sourceAssistantSeqs: Object.freeze(sourceFloorIds.map(floorId => floorSeqById.get(floorId)).filter(Number.isSafeInteger)),
    summary: summaryText(memory),
    summarySource: memory.summary?.effectiveSource === 'user' ? 'user' : 'ai',
    locationReferences: Object.freeze((Array.isArray(memory.sourceFloorSnapshots)
      ? memory.sourceFloorSnapshots.flatMap(snapshot => Array.isArray(snapshot.locationReference) ? snapshot.locationReference.map(text => Object.freeze({ text: safeText(text, 500), sourceFloorId: snapshot.floorId, assistantSeq: floorSeqById.get(snapshot.floorId) ?? null, hostLocator: hostLocatorDto(floorById.get(snapshot.floorId)) })) : [])
      : Array.isArray(memory.sourceLocationReference) ? memory.sourceLocationReference.map(text => Object.freeze({ text: safeText(text, 500), sourceFloorId: floor.id, assistantSeq: floor.assistantSeq, hostLocator: hostLocatorDto(floor) })) : [])),
    locationReferenceSources: Object.freeze(Array.isArray(memory.sourceFloorSnapshots)
      ? memory.sourceFloorSnapshots.map(snapshot => Object.freeze({ sourceFloorId: snapshot.floorId, cleared: snapshot.locationReference === null && Object.hasOwn(snapshot, 'locationReference') }))
      : Object.hasOwn(memory, 'sourceLocationReference') ? [Object.freeze({ sourceFloorId: floor.id, cleared: memory.sourceLocationReference === null })] : []),
    chronology: chronologyAllowed ? chronologyDto(memory, floorSeqById) : Object.freeze([]),
    participants: Object.freeze((memory.participants ?? []).map(item => ({ entityId: item.entityId, presence: item.presence }))),
    locations: Object.freeze((memory.locations ?? []).map(item => ({ name: safeText(item.name, 500), change: item.change, entityId: item.entityId ?? null, participantEntityIds: Object.freeze([...(item.participantEntityIds ?? [])]), sourceRefs: sourceRefs(item.evidenceRefs) }))),
    spatialFacts: memory.spatialFacts ? Object.freeze({
      containments: Object.freeze((memory.spatialFacts.containments ?? []).map(item => Object.freeze({ itemId:item.itemId,placeEntityId: item.placeEntityId, parentEntityId: item.parentEntityId,...(item.identityChange?{identityChange:item.identityChange,replacesItemIds:Object.freeze([...(item.replacesItemIds??[])])}:{}), sourceRefs: sourceRefs(item.evidenceRefs) }))),
      positions: Object.freeze((memory.spatialFacts.positions ?? []).map(item => Object.freeze({ subjectEntityId: item.subjectEntityId, placeEntityId: item.placeEntityId, status: item.status, sourceRefs: sourceRefs(item.evidenceRefs) }))),
      ...(memory.spatialFacts.relations ? { relations: Object.freeze(memory.spatialFacts.relations.map(item => Object.freeze({ itemId: item.itemId, kind: item.kind, placeEntityId: item.placeEntityId, referencePlaceEntityIds: Object.freeze([...item.referencePlaceEntityIds]), text: item.source?item.text:safeText(item.text, 1000), ...currentSource(item), sourceRefs: sourceRefs(item.evidenceRefs) }))) } : {}),
      ...(memory.spatialFacts.features ? { features: Object.freeze(memory.spatialFacts.features.map(item => Object.freeze({ itemId: item.itemId, placeEntityId: item.placeEntityId, ...(Object.hasOwn(item, 'kind') ? { kind: item.kind } : {}), text: item.source?item.text:safeText(item.text, 1000), replacesItemIds: Object.freeze([...item.replacesItemIds]), ...currentSource(item), sourceRefs: sourceRefs(item.evidenceRefs) }))) } : {}),
    }) : null,
    commitments: Object.freeze((memory.commitments ?? []).map(item => ({ speakerEntityId: item.speakerEntityId, targetEntityIds: Object.freeze([...(item.targetEntityIds ?? [])]), kind: item.kind, content: safeText(item.content), status: item.status, exactAnchorId: item.exactAnchorId ?? null }))),
    openLoops: Object.freeze((memory.openLoops ?? []).map(item => ({ description: safeText(item.description), ownerEntityIds: Object.freeze([...(item.ownerEntityIds ?? [])]) }))),
    exactAnchors: Object.freeze((memory.exactAnchors ?? []).map(item => ({ anchorId: item.anchorId, kind: item.kind,
      exactText: item.manual === true ? item.exactText : safeText(item.exactText, 2000), speakerEntityId: item.speakerEntityId ?? null,
      whyPreserve: safeText(item.whyPreserve, 1000), ...(item.manual === true ? { manual: true, carrier: item.carrier, knownEntityIds: Object.freeze([...(item.knownEntityIds ?? [])]) } : {}),
      ...(item.sourceFloorId ? { sourceFloorId: item.sourceFloorId } : {}) }))),
    events: Object.freeze((memory.eventFragments ?? []).filter(item => item.candidateStatus !== 'rejected').map(item => ({ title: safeText(item.title, 500), description: safeText(item.description), candidateStatus: item.candidateStatus }))),
    actions: Object.freeze((memory.actions ?? []).map(item => ({ actorEntityId: item.actorEntityId, targetEntityIds: Object.freeze([...(item.targetEntityIds ?? [])]), action: safeText(item.action), completion: item.completion, result: item.result === null ? null : safeText(item.result) }))),
    observations: Object.freeze((memory.observations ?? []).map(item => ({ subjectEntityId: item.subjectEntityId ?? null, kind: item.kind, description: safeText(item.description) }))),
    privateCognition: Object.freeze((memory.privateCognition ?? []).map(item => ({ ownerEntityId: item.ownerEntityId, kind: item.kind, content: safeText(item.content) }))),
    informationTransfers: Object.freeze((memory.informationTransfers ?? []).map(item => ({ fromEntityId: item.fromEntityId ?? null, toEntityIds: Object.freeze([...(item.toEntityIds ?? [])]), claimText: safeText(item.claimText), channel: item.channel }))),
  });
}

function personaCoreStateIds(deltas) {
  const ids = new Set();
  for (const delta of deltas) {
    const audits = delta.source?.calibrationAudit ?? [];
    for (const subject of delta.subjectSnapshots) for (const item of subject.core ?? []) {
      if (item.origin !== 'baseline' || item.sourceDeltaId !== delta.id) continue;
      if (audits.some(audit => audit.subjectEntityId === subject.subjectEntityId && audit.category === 'core'
        && audit.text === item.text
        && audit.evidence.every(evidence => evidence.source === 'userPersona'))) ids.add(item.id);
    }
  }
  return ids;
}

export function stateDto(replayed, entities, floorSeq, personaCoreIds) {
  const activeEntityIds = new Set(entities.map(entity => entity.entityId));
  const item = value => Object.freeze({
    stateId: value.id,
    text: safeText(value.text),
    visibility: ['private', 'observable', 'expressed', 'shared', 'authorial'].includes(value.visibility) ? value.visibility : 'private',
    reason: safeText(value.reason),
    origin: value.origin,
    towardEntityId: activeEntityIds.has(value.towardEntityId) ? value.towardEntityId : null,
    sourceFloorId: value.sourceFloorId ?? null,
    sourceDeltaId: value.sourceDeltaId ?? null,
    sourceAssistantSeq: floorSeq.get(value.sourceFloorId) ?? null,
  });
  return Object.freeze((replayed?.subjects ?? []).filter(subject => activeEntityIds.has(subject.subjectEntityId)).map(subject => Object.freeze({
    subjectEntityId: subject.subjectEntityId,
    core: Object.freeze((subject.core ?? []).filter(value => value.origin !== 'baseline' || !personaCoreIds.has(value.id)).map(item)),
    adaptive: Object.freeze((subject.adaptive ?? []).map(item)),
    situational: Object.freeze((subject.situational ?? []).map(item)),
  })));
}

export function cseChangesDto(timeline, entities, floorSeq, identityProjection, personaCoreIds, manualSubjectsByDelta = new Map()) {
  const activeEntityIds = new Set(entities.map(entity => entity.entityId));
  const state = value => value ? Object.freeze({
    stateId: value.id,
    text: safeText(value.text),
    visibility: ['private', 'observable', 'expressed', 'shared', 'authorial'].includes(value.visibility) ? value.visibility : 'private',
    reason: safeText(value.reason),
    origin: ['baseline', 'floor', 'reasonableProgression', 'manual'].includes(value.origin) ? value.origin : 'floor',
    towardEntityId: activeEntityIds.has(resolveIdentityEntityId(value.towardEntityId, identityProjection)) ? resolveIdentityEntityId(value.towardEntityId, identityProjection) : null,
    sourceFloorId: value.sourceFloorId ?? null,
    sourceDeltaId: value.sourceDeltaId ?? null,
    sourceAssistantSeq: floorSeq.get(value.sourceFloorId) ?? null,
  }) : null;
  return Object.freeze(timeline.flatMap(entry => {
    const assistantSeq = floorSeq.get(entry.floorId) ?? null;
    if (!assistantSeq) return [];
    return entry.changes.flatMap(subject => {
      const subjectEntityId = resolveIdentityEntityId(subject.subjectEntityId, identityProjection);
      if (!activeEntityIds.has(subjectEntityId)) return [];
      return subject.items.filter(change => !(change.category === 'core' && change.action === 'add'
        && change.after?.origin === 'baseline' && personaCoreIds.has(change.after.id))).map(change => Object.freeze({
        deltaId: entry.deltaId,
        floorId: entry.floorId,
        assistantSeq,
        subjectEntityId,
        layer: change.category,
        action: change.action,
        ...(manualSubjectsByDelta.get(entry.deltaId)?.has(subject.subjectEntityId) && (change.action === 'remove' || change.after?.origin === 'manual') ? { origin: 'manual' } : {}),
        before: state(change.before),
        after: state(change.after),
      }));
    });
  }));
}

// 向量索引与完整召回投影共享同一有效记忆选择，避免两条资格规则漂移。
export function selectRecallMemories(first) {
  const floors = first.floors ?? [];
  const floorById = new Map(floors.map(floor => [floor.id, floor]));
  const memoryGroups = new Map();
  for (const memory of first.floorMemories ?? []) if (floorById.has(memory.floorId)) {
    for (const floorId of memorySourceFloorIds(memory)) if (floorById.has(floorId)) {
      memoryGroups.set(floorId, [...(memoryGroups.get(floorId) ?? []), memory]);
    }
  }
  const activeMemories = [];
  const activeMemoryIds = new Set();
  for (const floor of floors) {
    const active = (memoryGroups.get(floor.id) ?? []).filter(memory => memory.recordStatus === 'active');
    if (active.length === 1 && !activeMemoryIds.has(active[0].id)) {
      activeMemories.push(active[0]);
      activeMemoryIds.add(active[0].id);
    }
  }
  return { floors, floorById, memoryGroups, activeMemories, activeMemoryIds };
}

export function isolateRecallAuxiliarySources(source, projection) {
  if (source?.status !== 'ready' || !projection?.unavailableSources?.length) return source;
  const people = projection.unavailableSources.includes('people'), places = projection.unavailableSources.includes('places');
  const manualKnownIds = new Set(source.floorMemories.flatMap(memory => (memory.exactAnchors ?? [])
    .filter(anchor => anchor.manual === true).flatMap(anchor => anchor.knownEntityIds ?? [])));
  const manualEntityNames = { ...(source.manualEntityNames ?? {}), ...Object.fromEntries(source.entities
    .filter(entity => entity.entityType === 'person' && manualKnownIds.has(entity.entityId))
    .map(entity => [entity.entityId, entity.displayName])) };
  const floorMemories = source.floorMemories.map(memory => ({ ...memory,
    ...(places ? { locations: [], spatialFacts: null } : {}),
    ...(people ? { participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], cseSignals: [] } : {}),
  }));
  return Object.freeze({ ...source, floorMemories,
    entities: source.entities.filter(entity => !(people && entity.entityType === 'person') && !(places && entity.entityType === 'place')),
    ...(people ? { currentState: [], cseChanges: [], manualEntityNames } : {}), ...(places ? { placeWorkspace: null } : {}),
    identityProjection: { ...source.identityProjection, ...projection },
    unavailableSources: projection.unavailableSources,
  });
}

export async function projectRecallSource(first, now, sourceReadAttempts = null, hostSnapshot = null, sanitizerOptions = {}, realtimeOrigin = false, identityProjectionValue = null) {
  let identityProjection = deriveUserIdentityProjection({ ...first, identityProjection: identityProjectionValue });
  const partition = migrationPartition(first);
  const readiness = hostSnapshot ? await assessMemoryCoverageFromHost({ reachable: first, snapshot: hostSnapshot, sanitizerOptions, captureGuard: true, realtimeOrigin }) : null;
  const hostBindings = memoryCoverageHostBindings(readiness);
  const unmatchedFloorIds = new Set(hostBindings?.unmatchedFloorIds ?? []);
  const selected = selectRecallMemories(first);
  const { floors, floorById, memoryGroups, activeMemoryIds } = selected;
  let activeMemories = selected.activeMemories.flatMap(memory => {
    if (!memorySourceFloorIds(memory).some(floorId => unmatchedFloorIds.has(floorId))) return [memory];
    const provenance = first.run?.diagnostics?.floorProvenance?.[memory.floorId] ?? {};
    const manualTime = provenance.timeEdited === true;
    const manualLocations = provenance.locationsEdited === true;
    const manualParticipants = provenance.participantsEdited === true;
    if (memory.summary?.effectiveSource !== 'user' && !manualTime && !manualLocations && !manualParticipants) return [];
    // A saved manual summary remains authoritative while its body is updating.
    // Automatic facts from the unconfirmed body do not accompany that summary.
    return [{ ...memory, summary: memory.summary?.effectiveSource === 'user' ? memory.summary : { effectiveSource: 'user', userText: '' },
      chronology: manualTime ? memory.chronology : [], locations: manualLocations ? memory.locations : [], participants: manualParticipants ? memory.participants : [], actions: [], observations: [], informationTransfers: [],
      privateCognition: [], commitments: [], eventFragments: [], openLoops: [], spatialFacts: null,
      exactAnchors: (memory.exactAnchors ?? []).filter(anchor => anchor.manual === true) }];
  });
  const confirmedFloors = floors.filter(floor => !unmatchedFloorIds.has(floor.id));
  const eligibleFloors = floors.filter(floor => !isMemoryExcludedFloor(
    hostBindings?.candidateByFloorId.has(floor.id) ? { ...floor, hostLocator: hostBindings.candidateByFloorId.get(floor.id).hostLocator } : floor,
    unmatchedFloorIds.has(floor.id) ? null : hostSnapshot?.chat, first.checkpoint, {
    frozen: partition.isFrozenFloor(floor.id),
  }));
  const eligibleFloorIds = new Set(eligibleFloors.map(floor => floor.id));
  activeMemories = activeMemories.filter(memory => eligibleFloorIds.has(memory.floorId));
  const degradedReasons = first.cseUnavailable === true ? ['cseReplayUnavailable'] : [];
  let trustedDeltas = [], replayed = null, cseTimeline = [];
  try {
    if (first.cseUnavailable === true) throw new TypeError('V3_RECALL_CSE_UNAVAILABLE');
    trustedDeltas = projectCseDeltasForSources({ floors, stateDeltas: first.stateDeltas ?? [], confirmedFloorIds: new Set(confirmedFloors.map(floor => floor.id)) });
    cseTimeline = deriveCseTimeline(trustedDeltas);
    if (first.baseline) {
      const timestamp = now();
      replayed = await replayCurrentState({ chatId: first.root.chatId, narrativeGeneration: first.root.narrativeGeneration, baselineId: first.baseline.id, floors, floorMemories: first.floorMemories ?? [], stateDeltas: trustedDeltas, now: timestamp?.toISOString?.() ?? String(timestamp) });
    }
  } catch {
    trustedDeltas = [];
    replayed = null;
    cseTimeline = [];
    if (!degradedReasons.includes('cseReplayUnavailable')) degradedReasons.push('cseReplayUnavailable');
  }
  const identityDirectory = buildEntityIdentityDirectory({ entities: first.entities ?? [], identityProjection });
  const entities = Object.freeze(identityDirectory.map(entry => Object.freeze({
    entityId: entry.entityId,
    entityType: entry.entityType,
    displayName: safeText(entry.displayName, 500),
    aliases: Object.freeze([...new Set(entry.aliases.map(aliasText).filter(Boolean))]),
    labels: Object.freeze([...entry.labels]),
    specialRole: entry.specialRole,
  })));
  const floorSeq = new Map(floors.map(floor => [floor.id, floor.assistantSeq]));
  // 主角人设由酒馆注入；记忆只省去它的基础资料副本，保留剧情变化与原始记录。
  const personaCoreIds = personaCoreStateIds(trustedDeltas);
  const missingAssistantSeq = Object.freeze(eligibleFloors.filter(floor => !(memoryGroups.get(floor.id) ?? []).some(memory => activeMemoryIds.has(memory.id))).map(floor => floor.assistantSeq));
  const throughAssistantSeq = floorSeq.get(trustedDeltas.at(-1)?.floorId) ?? 0;
  const stableThroughAssistantSeq = floors.at(-1)?.assistantSeq ?? 0;
  const memoryComplete = missingAssistantSeq.length === 0;
  const cseCurrent = degradedReasons.length === 0 && (trustedDeltas.length > 0 || eligibleFloors.length === 0);
  const coverage = Object.freeze({
    stableAiFloors: eligibleFloors.length,
    stableThroughAssistantSeq,
    rememberedAiFloors: eligibleFloors.length - missingAssistantSeq.length,
    missingAssistantSeq,
    cseThroughAssistantSeq: throughAssistantSeq,
    memoryComplete,
    cseCurrent,
  });
  const vectors = await projectVectorSources(activeMemories, floors);
  const projectedMemories = activeMemories.map(memory => projectFloorMemoryIdentityReferences(memory, identityProjection));
  if (projectedMemories.some(memory => memory.unavailableSources?.includes('places'))) identityProjection = { ...identityProjection,
    unavailableSources: [...new Set([...(identityProjection.unavailableSources ?? []), 'places'])] };
  const manualChangeTargets = new Set(trustedDeltas.flatMap(delta => (delta.source?.manualSubjectEntityIds ?? [])
    .map(id => `${delta.id}:${resolveIdentityEntityId(id, identityProjection)}`)));
  return isolateRecallAuxiliarySources(Object.freeze({
    status: 'ready',
    chatId: first.root.chatId,
    ...(first.migrationDescriptor ? { migrationDescriptor: Object.freeze({
      id: first.migrationDescriptor.id,
      frozenFloorIds: first.migrationDescriptor.frozenFloorIds,
      carriedAliases: first.migrationDescriptor.carriedAliases,
    }) } : {}),
    narrativeGeneration: first.root.narrativeGeneration,
    headCheckpointId: first.root.headCheckpointId,
    rootRevision: first.rootRevision,
    sourceReadAttempts,
    readiness,
    coverage,
    degradedReasons: Object.freeze(degradedReasons),
    entities,
    bodyMatchRefs: Object.freeze([...confirmedFloors.filter(floor => eligibleFloorIds.has(floor.id)).map(floor => {
      const memory = (memoryGroups.get(floor.id) ?? []).find(value => activeMemoryIds.has(value.id)) ?? null;
      const locator = hostBindings?.candidateByFloorId.get(floor.id)?.hostLocator ?? floor.hostLocator;
      if (!floor || !Number.isSafeInteger(locator?.messageIndex)
        || typeof floor.content?.rawFingerprint !== 'string' || typeof floor.content?.canonicalFingerprint !== 'string') return null;
      return Object.freeze({
        floorId: floor.id, floorMemoryId: memory?.id ?? null, assistantSeq: floor.assistantSeq,
        ...(partition.isFrozenFloor(floor.id) ? { frozen: true, sourceOrigin: partition.originForFloor(floor.id) } : {}),
        hostLocator: Object.freeze({ messageIndex: locator.messageIndex, swipeId: locator.swipeId ?? null, selectedSwipeIndex: locator.selectedSwipeIndex ?? null }),
        rawFingerprint: floor.content.rawFingerprint, canonicalFingerprint: floor.content.canonicalFingerprint,
      });
    }).filter(Boolean), ...(readiness?.unregisteredSummaryRefs ?? [])]),
    floorMemories: Object.freeze(projectedMemories.map(memory => {
      const floor = floorById.get(memory.floorId);
      return memoryDto(memory, floor, { floorSeqById: floorSeq, floorById });
    })),
    ...vectors,
    rawSources: Object.freeze(vectors.rawSources.filter(source => !unmatchedFloorIds.has(source.floorId))),
    currentState: Object.freeze(stateDto(projectCseStateIdentityReferences(replayed, identityProjection), entities, floorSeq, personaCoreIds).map(subject => Object.freeze({ ...subject,
      ...Object.fromEntries(['core', 'adaptive', 'situational'].map(layer => [layer, Object.freeze(subject[layer].filter(item => item.origin === 'manual' || !unmatchedFloorIds.has(item.sourceFloorId)))])) }))),
    cseChanges: Object.freeze(cseChangesDto(cseTimeline, entities, floorSeq, identityProjection, personaCoreIds, new Map(first.stateDeltas.map(delta => [delta.id, new Set(delta.source?.manualSubjectEntityIds ?? [])]))).filter(change =>
      manualChangeTargets.has(`${change.deltaId}:${change.subjectEntityId}`) || ![change.floorId, change.before?.sourceFloorId, change.after?.sourceFloorId].some(floorId => unmatchedFloorIds.has(floorId)))),
    identityProjection,
    placeWorkspace: identityProjection.placeWorkspace ?? null,
    placeWorkspaceDependency: placeWorkspaceDependency(first.root.chatId,identityProjection.placeWorkspaceRevision,identityProjection.placeWorkspace),
  }), identityProjection);
}

export async function readRecallSource({ store, signal = null, now = () => new Date(), hostSnapshot = null, sanitizerOptions = {}, realtimeOrigin = false, identityProjection = null, identityProjectionProvider = null } = {}) {
  if (!store || typeof store.readReachable !== 'function') throw new TypeError('V3 recall source store 无效');
  const source = await store.readReachable({ mode: 'projection', allowRecallCseFallback: true, signal });
  const attempts = exitPoint => Object.freeze({ reachableReads: 1, exitPoint });
  if (!['ready', 'needsReseal'].includes(source?.status) || !source.root || !source.checkpoint) {
    const exitPoint = source?.status === 'stale' ? 'stale' : 'unavailable';
    return Object.freeze({ status: sourceStatus(source), sourceReadAttempts: attempts(exitPoint) });
  }
  const projection = identityProjection ?? (typeof identityProjectionProvider === 'function' ? await identityProjectionProvider() : null);
  return projectRecallSource(source, now, attempts('ready'), hostSnapshot, sanitizerOptions, realtimeOrigin, projection?.data ?? projection);
}
