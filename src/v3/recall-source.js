import { deriveCseTimeline, filterReachableDeltas, replayCurrentState } from './cse-engine.js';
import { assessMemoryCoverageFromHost } from './memory-coverage.js';
import { buildEntityIdentityDirectory } from './entity-identity.js';

const safeText = (value, maximum = 4000) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);
const aliasText = alias => safeText(typeof alias === 'string' ? alias : alias?.name, 500);
const summaryText = memory => safeText(memory.summary?.effectiveSource === 'user' ? memory.summary?.userText : memory.summary?.aiText);
const sourceStatus = value => value?.status === 'stale' ? 'stale' : 'unavailable';

const chronologyText = item => safeText(item?.time?.sourceText || item?.time?.normalized || item?.description, 2000);
const CHRONOLOGY_KIND = Object.freeze({ explicit: '明确时间', relative: '相对时间', sequenceOnly: '先后顺序', unknown: '时间未知' });
const CHRONOLOGY_PRECISION = Object.freeze({ approximate: '约略', unresolved: '未解析' });

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

function memoryDto(memory, floor, { chronologyAllowed = true, floorSeqById = new Map() } = {}) {
  return Object.freeze({
    floorId: floor.id,
    floorMemoryId: memory.id,
    assistantSeq: floor.assistantSeq,
    summary: summaryText(memory),
    chronology: chronologyAllowed ? chronologyDto(memory, floorSeqById) : Object.freeze([]),
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
    core: Object.freeze((subject.core ?? []).map(item)),
    adaptive: Object.freeze((subject.adaptive ?? []).map(item)),
    situational: Object.freeze((subject.situational ?? []).map(item)),
  })));
}

function cseChangesDto(timeline, entities, floorSeq) {
  const activeEntityIds = new Set(entities.map(entity => entity.entityId));
  const state = value => value ? Object.freeze({
    stateId: value.id,
    text: safeText(value.text),
    visibility: ['private', 'observable', 'expressed', 'shared', 'authorial'].includes(value.visibility) ? value.visibility : 'private',
    reason: safeText(value.reason),
    origin: ['baseline', 'floor', 'reasonableProgression', 'manual'].includes(value.origin) ? value.origin : 'floor',
    towardEntityId: activeEntityIds.has(value.towardEntityId) ? value.towardEntityId : null,
    sourceFloorId: value.sourceFloorId ?? null,
    sourceDeltaId: value.sourceDeltaId ?? null,
    sourceAssistantSeq: floorSeq.get(value.sourceFloorId) ?? null,
  }) : null;
  return Object.freeze(timeline.flatMap(entry => {
    const assistantSeq = floorSeq.get(entry.floorId) ?? null;
    if (!assistantSeq) return [];
    return entry.changes.flatMap(subject => {
      if (!activeEntityIds.has(subject.subjectEntityId)) return [];
      return subject.items.map(change => Object.freeze({
        deltaId: entry.deltaId,
        floorId: entry.floorId,
        assistantSeq,
        subjectEntityId: subject.subjectEntityId,
        layer: change.category,
        action: change.action,
        before: state(change.before),
        after: state(change.after),
      }));
    });
  }));
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
  const degradedReasons = first.cseUnavailable === true ? ['cseReplayUnavailable'] : [];
  let trustedDeltas = [], replayed = null, cseTimeline = [];
  try {
    if (first.cseUnavailable === true) throw new TypeError('V3_RECALL_CSE_UNAVAILABLE');
    trustedDeltas = filterReachableDeltas({ floors, floorMemories: first.floorMemories ?? [], stateDeltas: first.stateDeltas ?? [] });
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
  const identityDirectory = buildEntityIdentityDirectory({ entities: first.entities ?? [] });
  const entities = Object.freeze(identityDirectory.map(entry => Object.freeze({
    entityId: entry.entityId,
    entityType: entry.entityType,
    displayName: safeText(entry.displayName, 500),
    aliases: Object.freeze([...new Set(entry.aliases.map(aliasText).filter(Boolean))]),
    specialRole: entry.specialRole,
  })));
  const floorSeq = new Map(floors.map(floor => [floor.id, floor.assistantSeq]));
  const readiness = hostSnapshot ? await assessMemoryCoverageFromHost({ reachable: first, snapshot: hostSnapshot, sanitizerOptions, captureGuard: true, realtimeOrigin }) : null;
  const missingAssistantSeq = Object.freeze(floors.filter(floor => !(memoryGroups.get(floor.id) ?? []).some(memory => activeMemoryIds.has(memory.id))).map(floor => floor.assistantSeq));
  const throughAssistantSeq = floorSeq.get(trustedDeltas.at(-1)?.floorId) ?? 0;
  const stableThroughAssistantSeq = floors.at(-1)?.assistantSeq ?? 0;
  const memoryComplete = floors.length > 0 && missingAssistantSeq.length === 0;
  const cseCurrent = degradedReasons.length === 0 && trustedDeltas.length > 0;
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
    readiness,
    coverage,
    degradedReasons: Object.freeze(degradedReasons),
    entities,
    bodyMatchRefs: Object.freeze([...floors.map(floor => {
      const memory = activeMemories.find(value => value.floorId === floor.id) ?? null;
      if (!floor || !Number.isSafeInteger(floor.hostLocator?.messageIndex)
        || typeof floor.content?.rawFingerprint !== 'string' || typeof floor.content?.canonicalFingerprint !== 'string') return null;
      return Object.freeze({
        floorId: floor.id, floorMemoryId: memory?.id ?? null, assistantSeq: floor.assistantSeq,
        hostLocator: Object.freeze({ messageIndex: floor.hostLocator.messageIndex, swipeId: floor.hostLocator.swipeId ?? null, selectedSwipeIndex: floor.hostLocator.selectedSwipeIndex ?? null }),
        rawFingerprint: floor.content.rawFingerprint, canonicalFingerprint: floor.content.canonicalFingerprint,
      });
    }).filter(Boolean), ...(readiness?.unregisteredSummaryRefs ?? [])]),
    floorMemories: Object.freeze(activeMemories.map(memory => {
      const floor = floorById.get(memory.floorId);
      return memoryDto(memory, floor, { floorSeqById: floorSeq });
    })),
    currentState: stateDto(replayed, entities, floorSeq),
    cseChanges: cseChangesDto(cseTimeline, entities, floorSeq),
  });
}

export async function readRecallSource({ store, now = () => new Date(), hostSnapshot = null, sanitizerOptions = {}, realtimeOrigin = false } = {}) {
  if (!store || typeof store.readReachable !== 'function') throw new TypeError('V3 recall source store 无效');
  const source = await store.readReachable({ mode: 'projection', allowRecallCseFallback: true });
  const attempts = exitPoint => Object.freeze({ reachableReads: 1, exitPoint });
  if (!['ready', 'needsReseal'].includes(source?.status) || !source.root || !source.checkpoint) {
    const exitPoint = source?.status === 'stale' ? 'stale' : 'unavailable';
    return Object.freeze({ status: sourceStatus(source), sourceReadAttempts: attempts(exitPoint) });
  }
  return projectRecallSource(source, now, attempts('ready'), hostSnapshot, sanitizerOptions, realtimeOrigin);
}
