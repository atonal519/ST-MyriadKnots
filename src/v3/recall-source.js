import { filterReachableDeltas, replayCurrentState } from './cse-engine.js';
import { assessMemoryCoverageFromHost } from './memory-coverage.js';

const safeText = (value, maximum = 4000) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);
const aliasText = alias => safeText(typeof alias === 'string' ? alias : alias?.name, 500);
const summaryText = memory => safeText(memory.summary?.effectiveSource === 'user' ? memory.summary?.userText : memory.summary?.aiText);
const sourceStatus = value => value?.status === 'stale' ? 'stale' : 'unavailable';

function memoryDto(memory, floor) {
  return Object.freeze({
    floorId: floor.id,
    floorMemoryId: memory.id,
    assistantSeq: floor.assistantSeq,
    summary: summaryText(memory),
    participants: Object.freeze((memory.participants ?? []).map(item => ({ entityId: item.entityId, presence: item.presence }))),
    locations: Object.freeze((memory.locations ?? []).map(item => ({ name: safeText(item.name, 500), change: item.change, entityId: item.entityId ?? null, participantEntityIds: Object.freeze([...(item.participantEntityIds ?? [])]) }))),
    commitments: Object.freeze((memory.commitments ?? []).map(item => ({ speakerEntityId: item.speakerEntityId, targetEntityIds: Object.freeze([...(item.targetEntityIds ?? [])]), kind: item.kind, content: safeText(item.content), status: item.status, exactAnchorId: item.exactAnchorId ?? null }))),
    openLoops: Object.freeze((memory.openLoops ?? []).map(item => ({ description: safeText(item.description), ownerEntityIds: Object.freeze([...(item.ownerEntityIds ?? [])]) }))),
    exactAnchors: Object.freeze((memory.exactAnchors ?? []).map(item => ({ anchorId: item.anchorId, kind: item.kind, exactText: safeText(item.exactText, 2000), speakerEntityId: item.speakerEntityId ?? null, whyPreserve: safeText(item.whyPreserve, 1000) }))),
    events: Object.freeze((memory.eventFragments ?? []).filter(item => item.candidateStatus !== 'rejected').map(item => ({ title: safeText(item.title, 500), description: safeText(item.description), candidateStatus: item.candidateStatus }))),
    actions: Object.freeze((memory.actions ?? []).map(item => ({ actorEntityId: item.actorEntityId, targetEntityIds: Object.freeze([...(item.targetEntityIds ?? [])]), action: safeText(item.action), completion: item.completion, result: item.result === null ? null : safeText(item.result) }))),
    observations: Object.freeze((memory.observations ?? []).map(item => ({ subjectEntityId: item.subjectEntityId ?? null, kind: item.kind, description: safeText(item.description) }))),
    privateCognition: Object.freeze((memory.privateCognition ?? []).map(item => ({ ownerEntityId: item.ownerEntityId, kind: item.kind, content: safeText(item.content) }))),
    informationTransfers: Object.freeze((memory.informationTransfers ?? []).map(item => ({ fromEntityId: item.fromEntityId ?? null, toEntityIds: Object.freeze([...(item.toEntityIds ?? [])]), claimText: safeText(item.claimText), channel: item.channel }))),
  });
}

function stateDto(replayed, entities, floorSeq) {
  const activeEntityIds = new Set(entities.map(entity => entity.entityId));
  const item = value => Object.freeze({
    text: safeText(value.text),
    visibility: ['private', 'observable', 'expressed', 'shared', 'authorial'].includes(value.visibility) ? value.visibility : 'private',
    reason: safeText(value.reason),
    origin: value.origin,
    towardEntityId: activeEntityIds.has(value.towardEntityId) ? value.towardEntityId : null,
    sourceAssistantSeq: floorSeq.get(value.sourceFloorId) ?? null,
  });
  return Object.freeze((replayed?.subjects ?? []).filter(subject => activeEntityIds.has(subject.subjectEntityId)).map(subject => Object.freeze({
    subjectEntityId: subject.subjectEntityId,
    core: Object.freeze((subject.core ?? []).map(item)),
    adaptive: Object.freeze((subject.adaptive ?? []).map(item)),
    situational: Object.freeze((subject.situational ?? []).map(item)),
  })));
}

export async function projectRecallSource(first, now, sourceReadAttempts = null, hostSnapshot = null, sanitizerOptions = {}, realtimeOrigin = false) {
  const floors = first.floors ?? [];
  const floorById = new Map(floors.map(floor => [floor.id, floor]));
  const memoryGroups = new Map();
  for (const memory of first.floorMemories ?? []) if (floorById.has(memory.floorId)) memoryGroups.set(memory.floorId, [...(memoryGroups.get(memory.floorId) ?? []), memory]);
  const activeMemories = [];
  for (const floor of floors) {
    const active = (memoryGroups.get(floor.id) ?? []).filter(memory => memory.recordStatus === 'active');
    if (active.length === 1) activeMemories.push(active[0]);
  }
  const activeMemoryIds = new Set(activeMemories.map(memory => memory.id));
  const degradedReasons = [];
  let trustedDeltas = [], replayed = null;
  try {
    trustedDeltas = filterReachableDeltas({ floors, floorMemories: first.floorMemories ?? [], stateDeltas: first.stateDeltas ?? [] });
    if (first.baseline) {
      const timestamp = now();
      replayed = await replayCurrentState({ chatId: first.root.chatId, narrativeGeneration: first.root.narrativeGeneration, baselineId: first.baseline.id, floors, floorMemories: first.floorMemories ?? [], stateDeltas: trustedDeltas, now: timestamp?.toISOString?.() ?? String(timestamp) });
    }
  } catch {
    trustedDeltas = [];
    replayed = null;
    degradedReasons.push('cseReplayUnavailable');
  }
  const entities = Object.freeze((first.entities ?? []).filter(entity => entity.recordStatus === 'active' && entity.status !== 'merged' && entity.status !== 'invalidated').map(entity => Object.freeze({
    entityId: entity.id,
    entityType: entity.entityType,
    displayName: safeText(entity.displayName, 500),
    aliases: Object.freeze([...new Set((entity.aliases ?? []).map(aliasText).filter(Boolean))]),
    specialRole: entity.specialRole,
  })));
  const floorSeq = new Map(floors.map(floor => [floor.id, floor.assistantSeq]));
  const missingAssistantSeq = Object.freeze(floors.filter(floor => !(memoryGroups.get(floor.id) ?? []).some(memory => activeMemoryIds.has(memory.id))).map(floor => floor.assistantSeq));
  const throughAssistantSeq = floorSeq.get(trustedDeltas.at(-1)?.floorId) ?? 0;
  const stableThroughAssistantSeq = floors.at(-1)?.assistantSeq ?? 0;
  const memoryComplete = floors.length > 0 && missingAssistantSeq.length === 0;
  const cseCurrent = degradedReasons.length === 0 && memoryComplete && trustedDeltas.length === activeMemories.length && throughAssistantSeq === stableThroughAssistantSeq;
  const coverage = Object.freeze({
    stableAiFloors: floors.length,
    stableThroughAssistantSeq,
    rememberedAiFloors: activeMemories.length,
    missingAssistantSeq,
    cseThroughAssistantSeq: throughAssistantSeq,
    memoryComplete,
    cseCurrent,
  });
  return Object.freeze({
    status: 'ready',
    chatId: first.root.chatId,
    narrativeGeneration: first.root.narrativeGeneration,
    headCheckpointId: first.root.headCheckpointId,
    rootRevision: first.rootRevision,
    sourceReadAttempts,
    readiness: hostSnapshot ? await assessMemoryCoverageFromHost({ reachable: first, snapshot: hostSnapshot, sanitizerOptions, captureGuard: true, realtimeOrigin }) : null,
    coverage,
    degradedReasons: Object.freeze(degradedReasons),
    entities,
    floorMemories: Object.freeze(activeMemories.map(memory => memoryDto(memory, floorById.get(memory.floorId)))),
    currentState: stateDto(replayed, entities, floorSeq),
  });
}

export async function readRecallSource({ store, now = () => new Date(), hostSnapshot = null, sanitizerOptions = {}, realtimeOrigin = false } = {}) {
  if (!store || typeof store.readReachable !== 'function') throw new TypeError('V3 recall source store 无效');
  const source = await store.readReachable({ mode: 'projection' });
  const attempts = exitPoint => Object.freeze({ reachableReads: 1, exitPoint });
  if (!['ready', 'needsReseal'].includes(source?.status) || !source.root || !source.checkpoint) {
    const exitPoint = source?.status === 'stale' ? 'stale' : 'unavailable';
    return Object.freeze({ status: sourceStatus(source), sourceReadAttempts: attempts(exitPoint) });
  }
  return projectRecallSource(source, now, attempts('ready'), hostSnapshot, sanitizerOptions, realtimeOrigin);
}
