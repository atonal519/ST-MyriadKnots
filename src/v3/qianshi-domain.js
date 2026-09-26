import { MultiDirectedGraph, DirectedGraph } from 'graphology';
import { topologicalSort, willCreateCycle } from 'graphology-dag';
import { bfsFromNode } from 'graphology-traversal';
import { deterministicUuid } from './foundation-domain.js';
import { formatStoryTime, isRelativeStoryTime, projectTime, storyTimes, timeDistance } from './time-engine.js';
import { buildEntityIdentityDirectory, normalizeIdentityProjection } from './entity-identity.js';
import { rankRecallDocuments, tokenizeRecallText } from './recall-ranking.js';
import { QIANSHI_SCHEMA_VERSION, validateQianshiDelta } from './qianshi-schema.js';

export const QIANSHI_CANDIDATE_CHARACTER_BUDGET = 24000;
export const QIANSHI_PROGRESS_CHARACTER_BUDGET = 3200;
export const QIANSHI_HISTORY_INPUT_TOKENS = 70000;
export const QIANSHI_HISTORY_OUTPUT_TOKENS = 30000;
export const QIANSHI_RECALL_PROJECTION_VERSION = 4;

const STATUSES = new Set(['planned', 'inProgress', 'completed', 'cancelled', 'occurred', 'unknown']);
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'occurred']);
const clean = (value, maximum = 2000) => String(value ?? '')
  .normalize('NFKC')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maximum);
const list = value => Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
const keyText = value => clean(value, 160);
const frozen = value => Object.freeze(value);

function qianshiError(code, path = '') {
  const error = new TypeError(path ? `${code}:${path}` : code);
  error.code = code;
  error.validationPath = path;
  return error;
}

const activeMemories = reachable => {
  const floors = new Set((reachable?.floors ?? []).map(floor => floor.id));
  const groups = new Map();
  for (const memory of reachable?.floorMemories ?? []) if (floors.has(memory.floorId) && memory.recordStatus === 'active') groups.set(memory.floorId, [...(groups.get(memory.floorId) ?? []), memory]);
  return (reachable?.floors ?? []).flatMap(floor => {
    const values = groups.get(floor.id) ?? [];
    return values.length === 1 ? [{ floor, memory: values[0] }] : [];
  });
};

const eventSignature = event => {
  const value = structuredClone(event);
  delete value.important;
  return JSON.stringify(value);
};
const relationSignature = relation => JSON.stringify([relation.type, relation.fromEventId, relation.toEventId, relation.certainty]);

export function effectiveQianshiDelta(memory) {
  const delta = memory?.qianshiDelta;
  const formalEvents = ['ready', 'partial'].includes(delta?.status) ? (delta.events ?? []) : [];
  const formalRelations = ['ready', 'partial'].includes(delta?.status) ? (delta.relations ?? []) : [];
  const events = [...formalEvents], relations = [...formalRelations], reviewEvents = [], reviewRelations = [], reviewRelationEntries = [], conflicts = [];
  const eventById = new Map(formalEvents.map(event => [event.id, event]));
  const relationById = new Map(formalRelations.map(relation => [relation.id, relation]));
  for (const candidate of delta?.historyReview?.candidates ?? []) {
    if (!['pending', 'new'].includes(candidate.decision)) continue;
    const event = candidate.event, priorEvent = eventById.get(event.id);
    let eventCompatible = true;
    if (priorEvent) {
      if (eventSignature(priorEvent) !== eventSignature(event)) {
        conflicts.push(frozen({ kind: 'event', id: event.id }));
        eventCompatible = false;
      }
    } else {
      eventById.set(event.id, event); events.push(event); reviewEvents.push(event);
    }
    if (!eventCompatible) continue;
    for (const relation of candidate.relations ?? []) {
      const priorRelation = relationById.get(relation.id);
      if (priorRelation) {
        if (relationSignature(priorRelation) !== relationSignature(relation)) conflicts.push(frozen({ kind: 'relation', id: relation.id }));
      } else {
        relationById.set(relation.id, relation); relations.push(relation); reviewRelations.push(relation);
        reviewRelationEntries.push(frozen({ relation, ownerEventId: event.id, ownerEventSignature: eventSignature(event) }));
      }
    }
  }
  return frozen({ events: frozen(events), relations: frozen(relations), formalEvents: frozen([...formalEvents]),
    formalRelations: frozen([...formalRelations]), reviewEvents: frozen(reviewEvents), reviewRelations: frozen(reviewRelations), reviewRelationEntries: frozen(reviewRelationEntries),
    conflicts: frozen(conflicts) });
}

const nodeId = (kind, id) => `${kind}:${id}`;
const eventNode = id => nodeId('event', id);
const matterNode = id => nodeId('matter', id);
const personNode = id => nodeId('person', id);

const projectQianshiTime = (value, anchor = null) => projectTime(value, anchor, { allowShortGregorianYear: true });
const GREGORIAN_MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function sourceTimeFor(event, floorTime, { aggregate = false } = {}) {
  if (aggregate) return projectQianshiTime(event.storyTime ?? '', null);
  if (!event.storyTime) return floorTime ?? projectTime('');
  return projectQianshiTime(event.storyTime, floorTime ?? null);
}

function comparableBefore(left, right) {
  const distance = timeDistance(left, right);
  return distance !== null && distance > 0;
}

export function projectQianshiGraph(reachable, { identityProjection = null, progressCharacters = QIANSHI_PROGRESS_CHARACTER_BUDGET } = {}) {
  const graph = new MultiDirectedGraph({ allowSelfLoops: false });
  const orderGraph = new DirectedGraph({ allowSelfLoops: false });
  const progressGraph = new DirectedGraph({ allowSelfLoops: false });
  const floors = reachable?.floors ?? [];
  const floorById = new Map(floors.map(floor => [floor.id, floor]));
  const floorTimes = storyTimes((reachable?.floorMemories ?? []), floors);
  const directory = buildEntityIdentityDirectory({ entities: reachable?.entities ?? [], identityProjection: normalizeIdentityProjection(identityProjection ?? {}) });
  const entityById = new Map(directory.map(entry => [entry.entityId, entry]));
  const events = [], relations = [], discardedOrderRelations = [], danglingRelationIds = [], danglingContinuationIds = [], degradedFloorIds = new Set();
  const danglingRelations = [], danglingContinuations = [];
  const legacyReviewConflicts = [];
  const eventById = new Map();
  const eventMemoryFloorById = new Map();
  const relationById = new Map();
  const matterEvents = new Map();
  const addNode = (id, attributes) => { if (!graph.hasNode(id)) graph.addNode(id, attributes); };
  const memoryRows = activeMemories(reachable).map(({ floor, memory }) => ({ floor, memory, effective: effectiveQianshiDelta(memory) }));
  for (const { floor, memory, effective } of memoryRows) for (const conflict of effective.conflicts) {
    legacyReviewConflicts.push(frozen({ floorId: floor.id, memoryId: memory.id, ...conflict }));
  }
  const formalEventsById = new Map(memoryRows.flatMap(({ effective }) => effective.formalEvents.map(event => [event.id, event])));
  const eventEntries = [
    ...memoryRows.flatMap(row => row.effective.formalEvents.map(event => ({ ...row, event, review: false }))),
    ...memoryRows.flatMap(row => row.effective.reviewEvents.map(event => ({ ...row, event, review: true }))),
  ];
  const acceptedReviewEventById = new Map();
  for (const { floor, memory, event: raw, review } of eventEntries) {
    if (review) {
      const formal = formalEventsById.get(raw.id), accepted = acceptedReviewEventById.get(raw.id);
      if (formal) {
        if (eventSignature(formal) !== eventSignature(raw)) legacyReviewConflicts.push(frozen({ floorId: floor.id, memoryId: memory.id, kind: 'event', id: raw.id }));
        continue;
      }
      if (accepted) {
        if (eventSignature(accepted.event) !== eventSignature(raw)) legacyReviewConflicts.push(frozen({ floorId: floor.id, memoryId: memory.id, kind: 'event', id: raw.id }));
        continue;
      }
      acceptedReviewEventById.set(raw.id, { event: raw, memoryId: memory.id });
    }
    const aggregate = (memory.sourceFloorIds ?? [memory.floorId]).length > 1;
    const eventData = structuredClone(raw);
    delete eventData.important;
    const sourceFloor = floorById.get(raw.sourceFloorId);
    const assistantSeq = aggregate ? sourceFloor?.assistantSeq ?? null : floor.assistantSeq;
    const event = frozen({ ...eventData, floorMemoryId: memory.id, assistantSeq,
      parsedStoryTime: sourceTimeFor(raw, floorTimes.get(floor.id), { aggregate }) });
    if (eventById.has(event.id)) continue;
    eventById.set(event.id, event); events.push(event);
    eventMemoryFloorById.set(event.id, memory.floorId);
    addNode(eventNode(event.id), { kind: 'event', value: event });
    progressGraph.addNode(eventNode(event.id), { value: event });
    if (event.matterId !== null) {
      matterEvents.set(event.matterId, [...(matterEvents.get(event.matterId) ?? []), event]);
      addNode(matterNode(event.matterId), { kind: 'matter', matterId: event.matterId });
      graph.addDirectedEdgeWithKey(`matter-progress:${event.matterId}:${event.id}`, matterNode(event.matterId), eventNode(event.id), { type: 'matterProgress' });
    }
    for (const person of event.people) {
      const stable = person.entityId ?? `label:${person.name}`;
      const edgeKey = `participates:${stable}:${event.id}`;
      addNode(personNode(stable), { kind: 'person', entityId: person.entityId, name: entityById.get(person.entityId)?.displayName ?? person.name });
      if (!graph.hasEdge(edgeKey)) graph.addDirectedEdgeWithKey(edgeKey, personNode(stable), eventNode(event.id), { type: 'participates' });
    }
    orderGraph.addNode(eventNode(event.id), { value: event });
  }
  for (const event of events) for (const sourceId of event.continuesFromEventIds) if (!eventById.has(sourceId)) {
    danglingContinuationIds.push(`${event.id}:${sourceId}`);
    const memoryFloorId = eventMemoryFloorById.get(event.id);
    danglingContinuations.push(frozen({ floorId: event.sourceFloorId, memoryFloorId, eventId: event.id, sourceEventId: sourceId }));
    degradedFloorIds.add(memoryFloorId);
  }
  const formalRelationsById = new Map(memoryRows.flatMap(({ effective }) => effective.formalRelations.map(relation => [relation.id, relation])));
  const acceptedReviewRelationById = new Map();
  const relationEntries = [
    ...memoryRows.flatMap(row => row.effective.formalRelations.map(relation => ({ ...row, relation, review: false }))),
    ...memoryRows.flatMap(row => row.effective.reviewRelationEntries.map(entry => ({ ...row, ...entry, review: true }))),
  ];
  for (const { memory, floor, relation, review, ownerEventId, ownerEventSignature } of relationEntries) {
      if (review) {
        const formalOwner = formalEventsById.get(ownerEventId), acceptedOwner = acceptedReviewEventById.get(ownerEventId);
        const ownerAccepted = formalOwner && eventSignature(formalOwner) === ownerEventSignature
          || acceptedOwner && eventSignature(acceptedOwner.event) === ownerEventSignature;
        if (!ownerAccepted) continue;
        const formal = formalRelationsById.get(relation.id), accepted = acceptedReviewRelationById.get(relation.id);
        if (formal) {
          if (relationSignature(formal) !== relationSignature(relation)) legacyReviewConflicts.push(frozen({ floorId: floor.id, memoryId: memory.id, kind: 'relation', id: relation.id }));
          continue;
        }
        if (accepted) {
          if (relationSignature(accepted.relation) !== relationSignature(relation)) legacyReviewConflicts.push(frozen({ floorId: floor.id, memoryId: memory.id, kind: 'relation', id: relation.id }));
          continue;
        }
        acceptedReviewRelationById.set(relation.id, { relation, memoryId: memory.id });
      }
      if (!eventById.has(relation.fromEventId) || !eventById.has(relation.toEventId)) {
        danglingRelationIds.push(relation.id); danglingRelations.push(frozen({ floorId: memory.floorId, relationId: relation.id,
          fromEventId: relation.fromEventId, toEventId: relation.toEventId, reason: 'missing-event' }));
        degradedFloorIds.add(memory.floorId); continue;
      }
      const fromEvent = eventById.get(relation.fromEventId), toEvent = eventById.get(relation.toEventId);
      if (relation.type === 'progress' && (!fromEvent.matterId || fromEvent.matterId !== toEvent.matterId || !toEvent.updatesMatter)) {
        danglingRelationIds.push(relation.id); danglingRelations.push(frozen({ floorId: memory.floorId, relationId: relation.id,
          fromEventId: relation.fromEventId, toEventId: relation.toEventId, reason: 'invalid-progress' }));
        degradedFloorIds.add(memory.floorId); continue;
      }
      const previous = relationById.get(relation.id);
      if (previous && (previous.type !== relation.type || previous.fromEventId !== relation.fromEventId || previous.toEventId !== relation.toEventId)) {
        throw qianshiError('QIANSHI_RELATION_ID_CONFLICT', 'relations');
      }
      relationById.set(relation.id, relation);
  }
  for (const relation of relationById.values()) {
    const value = frozen({ ...structuredClone(relation) });
    relations.push(value);
    graph.addDirectedEdgeWithKey(`relation:${relation.id}`, eventNode(relation.fromEventId), eventNode(relation.toEventId), { type: relation.type, certainty: relation.certainty });
    if (relation.type === 'progress' && !progressGraph.hasDirectedEdge(eventNode(relation.fromEventId), eventNode(relation.toEventId))) {
      progressGraph.addDirectedEdgeWithKey(`progress:${relation.id}`, eventNode(relation.fromEventId), eventNode(relation.toEventId), { relationId: relation.id });
    }
    if (relation.type === 'before') {
      const from = eventNode(relation.fromEventId), to = eventNode(relation.toEventId);
      if (!orderGraph.hasDirectedEdge(from, to) && !willCreateCycle(orderGraph, from, to)) orderGraph.addDirectedEdgeWithKey(`order:${relation.id}`, from, to, { relationId: relation.id });
      else discardedOrderRelations.push(relation.id);
    }
  }
  const timeGroup = value => Number.isInteger(value?.day) ? 'absolute'
    : value?.monthIdentity ? `named:${value.monthIdentity}`
      : value?.year === null && Number.isInteger(value?.month) ? 'month-day' : null;
  const timedGroups = new Map();
  for (const event of events) {
    const key = timeGroup(event.parsedStoryTime);
    if (key) timedGroups.set(key, [...(timedGroups.get(key) ?? []), event]);
  }
  const sameTimedDate = (left, right) => {
    if (Number.isInteger(left?.day) && Number.isInteger(right?.day)) return left.day === right.day;
    if (left?.monthIdentity || right?.monthIdentity) return left?.monthIdentity === right?.monthIdentity
      && left?.monthDay === right?.monthDay && left?.weekOrdinal === right?.weekOrdinal && left?.weekday === right?.weekday;
    if (Number.isInteger(left?.month) && Number.isInteger(right?.month)) return left.month === right.month && left.monthDay === right.monthDay;
    if (Number.isInteger(left?.monthDay) && Number.isInteger(right?.monthDay)) return left.monthDay === right.monthDay
      && left.weekOrdinal === right.weekOrdinal && left.weekday === right.weekday;
    return false;
  };
  for (const values of timedGroups.values()) {
    const sortableTime = value => Number.isInteger(value?.day) ? value.day
      : Number.isInteger(value?.month) && Number.isInteger(value?.monthDay) && !value?.monthIdentity
        ? GREGORIAN_MONTH_DAYS.slice(0, value.month - 1).reduce((sum, days) => sum + days, 0) + value.monthDay
        : Number.isInteger(value?.monthDay) ? value.monthDay
          : Number.isInteger(value?.weekOrdinal) ? value.weekOrdinal * 7 : 0;
    values.sort((left, right) => {
      const a = left.parsedStoryTime, b = right.parsedStoryTime;
      return sortableTime(a) - sortableTime(b)
        || (a.minute ?? 0) - (b.minute ?? 0) || left.id.localeCompare(right.id);
    });
    const timeBuckets = [];
    for (const event of values) {
      const current = timeBuckets.at(-1), representative = current?.[0];
      if (representative && sameTimedDate(representative.parsedStoryTime, event.parsedStoryTime)) current.push(event);
      else timeBuckets.push([event]);
    }
    for (let index = 1; index < timeBuckets.length; index += 1) {
      const earlier = timeBuckets[index - 1], later = timeBuckets[index];
      if (!comparableBefore(earlier[0].parsedStoryTime, later[0].parsedStoryTime)) continue;
      for (const event of earlier) {
        const from = eventNode(event.id);
        for (const next of later) {
          const to = eventNode(next.id);
          if (comparableBefore(event.parsedStoryTime, next.parsedStoryTime)
            && !orderGraph.hasDirectedEdge(from, to) && !willCreateCycle(orderGraph, from, to)) {
            orderGraph.addDirectedEdgeWithKey(`time:${event.id}:${next.id}`, from, to, { relationId: null, inferredFromExplicitTime: true });
          }
        }
      }
    }
  }
  const topologicalIds = topologicalSort(orderGraph).map(id => orderGraph.getNodeAttribute(id, 'value')?.id).filter(Boolean);
  const topologicalRank = new Map(topologicalIds.map((id, index) => [id, index]));
  events.sort((left, right) => (topologicalRank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (topologicalRank.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    || left.assistantSeq - right.assistantSeq || left.id.localeCompare(right.id));
  const matterDtos = [];
  for (const [matterId, values] of matterEvents) {
    const advancing = values.filter(event => event.updatesMatter);
    if (!advancing.length) continue;
    const visited = [];
    const seed = advancing.find(event => progressGraph.inDegree(eventNode(event.id)) === 0) ?? advancing[0];
    bfsFromNode(progressGraph, eventNode(seed.id), (_node, attributes) => {
      if (attributes.value?.matterId === matterId && attributes.value.updatesMatter) visited.push(attributes.value);
    }, { mode: 'outbound' });
    const visitedIds = new Set(visited.map(event => event.id));
    const chain = [...visited, ...advancing.filter(event => !visitedIds.has(event.id))];
    const continued = new Set(relations.filter(relation => relation.type === 'progress' && chain.some(event => event.id === relation.fromEventId) && chain.some(event => event.id === relation.toEventId)).map(relation => relation.fromEventId));
    const currentEvents = chain.filter(event => !continued.has(event.id)).sort((left, right) => right.assistantSeq - left.assistantSeq || right.id.localeCompare(left.id));
    const representative = currentEvents[0] ?? chain.at(-1) ?? advancing.at(-1);
    const origin = [...advancing].sort((left, right) => left.assistantSeq - right.assistantSeq || (topologicalRank.get(left.id) ?? 0) - (topologicalRank.get(right.id) ?? 0) || left.id.localeCompare(right.id))[0];
    matterDtos.push(frozen({ matterId, title: representative.title, object: representative.object, status: representative.status,
      people: frozen(representative.people.map(person => frozen({ ...person }))), latestEventIds: frozen(currentEvents.map(event => event.id)),
      eventIds: frozen(chain.map(event => event.id)), sourceFloorId: representative.sourceFloorId, sourceAssistantSeq: representative.assistantSeq,
      storyTime: representative.storyTime, scheduledTime: representative.scheduledTime, description: representative.description,
      origin: frozen({ eventId: origin.id, title: origin.title, description: origin.description, storyTime: origin.storyTime, scheduledTime: origin.scheduledTime,
        sourceFloorId: origin.sourceFloorId, sourceAssistantSeq: origin.assistantSeq }) }));
  }
  matterDtos.sort((left, right) => Number(TERMINAL_STATUSES.has(left.status)) - Number(TERMINAL_STATUSES.has(right.status))
    || right.sourceAssistantSeq - left.sourceAssistantSeq || left.matterId.localeCompare(right.matterId));
  const progressLines = [], progressEventIds = [], progressMatterIds = [];
  for (const matter of matterDtos) {
    const marker = TERMINAL_STATUSES.has(matter.status) ? '刚完成' : matter.status === 'planned' ? '待办' : '进行中';
    const time = matter.scheduledTime || matter.storyTime;
    const line = `- [${marker}] ${matter.title}${matter.object ? `（${matter.object}）` : ''}${time ? `；时间：${time}` : ''}：${matter.description}`;
    if (progressLines.join('\n').length + line.length > Math.max(0, progressCharacters)) continue;
    progressLines.push(line); progressMatterIds.push(matter.matterId); progressEventIds.push(...matter.latestEventIds);
  }
  const currentProgress = frozen({ text: progressLines.length ? ['[当前剧情进度]', ...progressLines].join('\n') : '', characterCount: progressLines.join('\n').length,
    eventIds: frozen([...new Set(progressEventIds)]), matterIds: frozen(progressMatterIds) });
  const eligible = activeMemories(reachable);
  const eligibleStatuses = eligible.map(({ floor, memory }) => {
    const effective = effectiveQianshiDelta(memory);
    return { floorId: floor.id, status: memory.qianshiDelta?.status ?? 'unprocessed', hasEvents: effective.events.length > 0,
      legacyPendingOnly: memory.qianshiDelta?.status === 'pending' && effective.reviewEvents.length > 0 };
  });
  const deltaStatuses = eligibleStatuses.map(value => value.status);
  const completeFloorIds = eligibleStatuses.filter(value => (['ready', 'empty'].includes(value.status) || value.status === 'partial' && value.hasEvents || value.legacyPendingOnly)
    && (!degradedFloorIds.has(value.floorId) || value.status === 'partial' && value.hasEvents || value.legacyPendingOnly));
  const coverage = frozen({
    eligibleFloors: eligible.length,
    readyFloors: deltaStatuses.filter(status => status === 'ready').length,
    emptyFloors: deltaStatuses.filter(status => status === 'empty').length,
    completeFloors: completeFloorIds.length,
    partialFloors: eligibleStatuses.filter(value => value.status === 'partial' && !value.hasEvents && !degradedFloorIds.has(value.floorId)).length,
    pendingFloors: eligibleStatuses.filter(value => ['pending', 'unprocessed'].includes(value.status) && !value.legacyPendingOnly).length,
    degradedFloors: degradedFloorIds.size,
    unavailableFloors: (floors.length - eligible.length),
  });
  return frozen({ graph, orderGraph, events: frozen(events), matters: frozen(matterDtos), relations: frozen(relations), currentProgress, coverage,
    diagnostics: frozen({ discardedOrderRelations: frozen(discardedOrderRelations), danglingRelationIds: frozen(danglingRelationIds),
      danglingContinuationIds: frozen(danglingContinuationIds), danglingContinuations: frozen(danglingContinuations),
      danglingRelations: frozen(danglingRelations), degradedFloorIds: frozen([...degradedFloorIds]), legacyReviewConflicts: frozen(legacyReviewConflicts), graphNodes: graph.order, graphEdges: graph.size,
      progressNodes: progressGraph.order, progressEdges: progressGraph.size, orderNodes: orderGraph.order, orderEdges: orderGraph.size }) });
}

function relevanceText(value) {
  return clean([value.title, value.object, value.description, value.storyTime, value.scheduledTime, ...(value.people ?? []).map(person => person.name)].filter(Boolean).join(' '), 12000).toLocaleLowerCase('zh-CN');
}

const recallQueries = queryContext => [
  { key: 'latestUser', text: clean(queryContext?.latestUserText, 4000) || clean(queryContext?.text, 8000), weight: 0.7 },
  { key: 'recentAssistant', text: clean(queryContext?.recentAssistantText, 4000), weight: 0.2 },
  { key: 'previousUser', text: clean(queryContext?.previousUserText, 4000), weight: 0.1 },
].filter(query => query.text);

function connectedProgressEventIds(seedIds, relations) {
  const adjacent = new Map();
  for (const relation of relations) {
    if (relation.type !== 'progress') continue;
    adjacent.set(relation.fromEventId, [...(adjacent.get(relation.fromEventId) ?? []), relation.toEventId]);
    adjacent.set(relation.toEventId, [...(adjacent.get(relation.toEventId) ?? []), relation.fromEventId]);
  }
  const selected = new Set(seedIds), queue = [...selected];
  while (queue.length) for (const id of adjacent.get(queue.shift()) ?? []) if (!selected.has(id)) {
    selected.add(id); queue.push(id);
  }
  return selected;
}

function representativeEventIds(ids, eventById, maximum = 5) {
  const values = [];
  for (const event of ids.map(id => eventById.get(id)).filter(Boolean)) {
    const prior = values.at(-1);
    if (!prior || clean(prior.title, 500).toLocaleLowerCase('zh-CN') !== clean(event.title, 500).toLocaleLowerCase('zh-CN')) {
      values.push(event); continue;
    }
    if (TERMINAL_STATUSES.has(event.status) || !TERMINAL_STATUSES.has(prior.status)) values[values.length - 1] = event;
  }
  if (values.length <= maximum) return values.map(event => event.id);
  const chosen = new Set([values[0].id, values.at(-1).id]);
  for (const event of values) if (chosen.size < maximum && TERMINAL_STATUSES.has(event.status)) chosen.add(event.id);
  for (let index = values.length - 2; index > 0 && chosen.size < maximum; index -= 1) chosen.add(values[index].id);
  return values.filter(event => chosen.has(event.id)).map(event => event.id);
}

const DAY_PERIOD_SUFFIX = /[\s，,]*(?:凌晨|清晨|拂晓|黎明|早晨|早上|上午|中午|正午|下午|傍晚|黄昏|晚上|夜晚|夜间|夜里|午夜|深夜)$/u;
const STORY_TIME_RANGE = /(?:→|->|⟶|至|到|～|~|—|–|\s+-\s+|(?<=日)\s*-\s*(?=\d)|(?<=:\d{2})\s*-\s*(?=\d{1,2}:[0-5]\d))/u;
const STORY_SECONDS = /(?<!\d)(?:[01]?\d|2[0-3]):[0-5]\d[:：]([0-5]\d)(?:Z)?(?=$|[\s，])/u;

function recallTimelineTime(event) {
  const raw = String(event.storyTime || event.parsedStoryTime?.rangeText || event.parsedStoryTime?.raw || '').normalize('NFKC').trim();
  const sortableRaw = raw.replace(DAY_PERIOD_SUFFIX, '').trim();
  const rangeSeparator = STORY_TIME_RANGE.exec(sortableRaw);
  const rangeStart = rangeSeparator ? sortableRaw.slice(0, rangeSeparator.index).trim() : sortableRaw;
  const ranged = Boolean(event.parsedStoryTime?.rangeText) || Boolean(rangeSeparator);
  const relative = isRelativeStoryTime(rangeStart);
  const time = ranged ? rangeSeparator && rangeStart ? projectQianshiTime(rangeStart) : null
      : relative && !event.parsedStoryTime?.date ? null
      : relative ? event.parsedStoryTime : sortableRaw ? projectQianshiTime(sortableRaw) : event.parsedStoryTime;
  const kind = time?.monthIdentity ? `special:${time.monthIdentity}`
    : Number.isInteger(time?.day) ? 'dated' : Number.isInteger(time?.month) && Number.isInteger(time?.monthDay) ? 'month-day' : 'unknown';
  const standardMonth = !time?.monthIdentity && Number.isInteger(time?.month) && Number.isInteger(time?.monthDay);
  return { time, kind, standardMonth, second: rangeStart.match(STORY_SECONDS)?.[1] };
}

function recallTimelineTimeComparator(events) {
  const views = new Map(events.map(event => [event.id, recallTimelineTime(event)]));
  return (left, right) => {
    const a = views.get(left.id), b = views.get(right.id);
    if (!a?.time || !b?.time || a.kind !== b.kind) return 0;
    const distance = timeDistance(a.time, b.time);
    if (distance !== null && distance !== 0) return distance > 0 ? -1 : 1;
    return distance === 0 && Number.isInteger(a.time.minute) && Number.isInteger(b.time.minute)
      ? a.time.minute - b.time.minute : 0;
  };
}

function orderRecallTimelineEvents(events, relations) {
  if (events.length < 2) return events;
  const graph = new DirectedGraph({ allowSelfLoops: false });
  const byId = new Map(events.map(event => [event.id, event]));
  events.forEach(event => graph.addNode(event.id));
  const compareTime = recallTimelineTimeComparator(events);
  for (let leftIndex = 0; leftIndex < events.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < events.length; rightIndex += 1) {
    const left = events[leftIndex], right = events[rightIndex];
    const order = compareTime(left, right);
    if (!order) continue;
    const from = order < 0 ? left.id : right.id, to = order < 0 ? right.id : left.id;
    if (!graph.hasDirectedEdge(from, to) && !willCreateCycle(graph, from, to)) graph.addDirectedEdge(from, to);
  }
  for (const relation of relations) {
    if (relation.type !== 'progress' || !byId.has(relation.fromEventId) || !byId.has(relation.toEventId)) continue;
    if (compareTime(byId.get(relation.fromEventId), byId.get(relation.toEventId)) > 0) continue;
    if (!graph.hasDirectedEdge(relation.fromEventId, relation.toEventId)
      && !willCreateCycle(graph, relation.fromEventId, relation.toEventId)) graph.addDirectedEdge(relation.fromEventId, relation.toEventId);
  }
  return topologicalSort(graph).map(id => byId.get(id));
}

const timelineDateTuple = view => {
  const time = view.time;
  if (view.standardMonth && Number.isInteger(time?.year) && Number.isInteger(time?.month) && Number.isInteger(time?.monthDay)) {
    return [time.year, time.month, time.monthDay];
  }
  if (Number.isInteger(time?.day)) return [time.day];
  if (view.standardMonth && Number.isInteger(time?.month) && Number.isInteger(time?.monthDay)) return [time.month, time.monthDay];
  if (Number.isInteger(time?.monthDay)) return [time.monthDay];
  if (Number.isInteger(time?.weekOrdinal) && Number.isInteger(time?.weekday)) {
    return [time.weekOrdinal, time.weekday];
  }
  return null;
};

function compareOccurrenceTime(left, right) {
  const a = left.view.time, b = right.view.time;
  const aMinute = a?.minute, bMinute = b?.minute;
  if (Number.isInteger(aMinute) && Number.isInteger(bMinute)) {
    const hourOrder = Math.floor(aMinute / 60) - Math.floor(bMinute / 60);
    if (hourOrder) return hourOrder;
    const minuteOrder = aMinute % 60 - bMinute % 60;
    if (minuteOrder) return minuteOrder;
    if (left.view.second !== undefined && right.view.second !== undefined) {
      const secondOrder = Number(left.view.second) - Number(right.view.second);
      if (secondOrder) return secondOrder;
    }
  }
  return left.index - right.index;
}

const compareTuple = (left, right) => {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const order = (left[index] ?? -1) - (right[index] ?? -1);
    if (order) return order;
  }
  return 0;
};

function timelineDateCopy(view, raw) {
  const time = view.time;
  const full = formatStoryTime(time, raw || time?.raw || time?.date) || '时间未明';
  const monthDay = Number.isInteger(time?.monthDay) ? time.monthDay
    : Number.isInteger(time?.day) ? new Date(time.day * 86400000).getUTCDate() : null;
  const day = Number.isInteger(monthDay) ? `${monthDay}日` : full;
  let period = '';
  if (time?.monthIdentity) try {
    const [era, year, month] = JSON.parse(time.monthIdentity);
    period = `${era || ''}${Number.isInteger(year) ? `${year}年` : ''}${month || ''}`;
  } catch { /* Persisted invalid identities keep the original label. */ }
  else if (Number.isInteger(time?.year) && Number.isInteger(time?.month)) period = `${time.year}年${time.month}月`;
  else if (Number.isInteger(time?.month)) period = `${time.month}月`;
  return { day, period, full };
}

function timelineSegmentLabel(segment, groups) {
  if (segment.id === 'dated') return '完整日期';
  if (segment.id === 'month-day') return '仅月日';
  return clean(groups[0]?.period, 120) || '时间未明确';
}

/** Full-page projection: one parsed key per event, with no pairwise event comparison. */
export function projectQianshiTimeline(projection) {
  const events = Array.isArray(projection?.events) ? projection.events : [];
  const views = new Map(events.map(event => [event.id, recallTimelineTime(event)]));
  const segmentFor = view => {
    const tuple = timelineDateTuple(view);
    if (!tuple) return null;
    if (view.time?.monthIdentity) return `special:${view.time.monthIdentity}`;
    if (Number.isInteger(view.time?.day)) return 'dated';
    if (view.standardMonth && view.time?.year === null) return 'month-day';
    if (view.standardMonth && Number.isInteger(view.time?.year)) return 'dated';
    return null;
  };
  const eventIndex = new Map(events.map((event, index) => [event.id, index]));
  const segments = new Map(), undatedEventIds = [];
  for (const event of events) {
    const view = views.get(event.id), segmentId = segmentFor(view);
    if (!segmentId) { undatedEventIds.push(event.id); continue; }
    const copy = timelineDateCopy(view, event.storyTime || event.parsedStoryTime?.rangeText), tuple = timelineDateTuple(view);
    const groupKey = JSON.stringify(tuple);
    let segment = segments.get(segmentId);
    if (!segment) {
      segment = { id: segmentId, firstIndex: eventIndex.get(event.id), hasKnownYear: Number.isInteger(view.time?.year),
        hasJanuary: false, hasDecember: false, groups: new Map() };
      segments.set(segmentId, segment);
    } else if (Number.isInteger(view.time?.year)) segment.hasKnownYear = true;
    if (segmentId === 'month-day') {
      segment.hasJanuary ||= view.time.month === 1;
      segment.hasDecember ||= view.time.month === 12;
    }
    let group = segment.groups.get(groupKey);
    if (!group) {
      group = { id: `qianshi-day-${segment.firstIndex}-${segment.groups.size}`, segmentId, tuple, firstIndex: eventIndex.get(event.id), ...copy, eventIds: [] };
      segment.groups.set(groupKey, group);
    }
    group.eventIds.push(event.id);
  }
  for (const segment of segments.values()) for (const group of segment.groups.values()) group.eventIds.sort((leftId, rightId) =>
    compareOccurrenceTime({ view: views.get(leftId), index: eventIndex.get(leftId) }, { view: views.get(rightId), index: eventIndex.get(rightId) }));
  const segmentList = [...segments.values()].sort((left, right) => Number(right.hasKnownYear) - Number(left.hasKnownYear)
    || left.firstIndex - right.firstIndex);
  const resultSegments = segmentList.map(segment => {
    const preserveSourceOrder = segment.id === 'month-day' && segment.hasJanuary && segment.hasDecember;
    const groups = [...segment.groups.values()].sort((left, right) => preserveSourceOrder
      ? left.firstIndex - right.firstIndex : compareTuple(left.tuple, right.tuple) || left.firstIndex - right.firstIndex);
    const latest = preserveSourceOrder ? null : groups.at(-1);
    const label = timelineSegmentLabel(segment, groups);
    return frozen({ id: segment.id, label, groups: frozen(groups.map(group => frozen({ id: group.id, day: group.day,
      period: group.period, full: group.full,
      eventIds: frozen([...group.eventIds]) }))), latestGroupId: latest?.id ?? null });
  });
  const yearlessBoundaryAmbiguous = segments.size === 1 && [...segments.values()][0].id === 'month-day'
    && [...segments.values()][0].hasJanuary && [...segments.values()][0].hasDecember;
  const hasGlobalLatest = resultSegments.length === 1 && undatedEventIds.length === 0 && !yearlessBoundaryAmbiguous;
  return frozen({ segments: frozen(resultSegments), undatedEventIds: frozen(undatedEventIds), hasGlobalLatest,
    globalLatestGroupId: hasGlobalLatest ? resultSegments[0].latestGroupId : null });
}

function recallSelection(projection, queryContext) {
  const eventById = new Map(projection.events.map(event => [event.id, event]));
  const documents = [
    ...projection.matters.map(matter => ({ id: `matter:${matter.matterId}`, text: relevanceText(matter) })),
    ...projection.events.map(event => ({ id: `event:${event.id}`, text: relevanceText(event) })),
  ];
  const ranked = rankRecallDocuments({ documents, queries: recallQueries(queryContext) });
  const rankById = new Map(ranked.map(item => [item.id, item]));
  const strongestScore = Math.max(0, ...ranked.map(item => item.score ?? 0));
  const primaryTerms = new Set(tokenizeRecallText(clean(queryContext?.latestUserText, 4000) || clean(queryContext?.text, 8000)));
  const strongestPrimaryMatches = Math.max(0, ...ranked.map(item => item.branchMatchCounts?.latestUser ?? 0));
  const primaryEvidence = primaryTerms.size > 1 && primaryTerms.size <= 3 ? strongestPrimaryMatches > 1 : true;
  const relevanceThreshold = strongestScore * 0.7;
  const matched = item => primaryEvidence && strongestScore > 0 && (item?.score ?? 0) >= relevanceThreshold
    && Object.values(item.branchMatchCounts ?? {}).some(count => count > 0);
  const eventMatches = new Map(projection.events.map(event => [event.id, rankById.get(`event:${event.id}`)]));
  const matterScores = projection.matters.map(matter => {
    const matterRank = rankById.get(`matter:${matter.matterId}`);
    const eventRanks = (matter.eventIds ?? []).map(id => eventMatches.get(id)).filter(Boolean);
    const bestEvent = eventRanks.sort((left, right) => right.score - left.score)[0] ?? null;
    const best = !bestEvent || (matterRank?.score ?? 0) >= bestEvent.score ? matterRank : bestEvent;
    return { matter, direct: matched(matterRank) || eventRanks.some(matched), score: best?.score ?? 0,
      latestUserScore: best?.branchScores?.latestUser ?? 0 };
  });
  const directMatters = matterScores.filter(item => item.direct)
    .sort((left, right) => right.latestUserScore - left.latestUserScore || right.score - left.score
      || right.matter.sourceAssistantSeq - left.matter.sourceAssistantSeq || left.matter.matterId.localeCompare(right.matter.matterId));
  const pending = matterScores.filter(({ matter }) => ['planned', 'inProgress'].includes(matter.status))
    .sort((left, right) => Number(right.direct) - Number(left.direct) || right.latestUserScore - left.latestUserScore || right.score - left.score
      || right.matter.sourceAssistantSeq - left.matter.sourceAssistantSeq || left.matter.matterId.localeCompare(right.matter.matterId));
  const matterEventIds = matter => {
    const directSeeds = (matter.eventIds ?? []).filter(id => matched(eventMatches.get(id)));
    const matterDirect = matched(rankById.get(`matter:${matter.matterId}`));
    const seeds = matterDirect ? matter.eventIds : directSeeds.length ? directSeeds : [...(matter.latestEventIds ?? []), matter.origin?.eventId].filter(Boolean);
    const connected = connectedProgressEventIds(seeds, projection.relations);
    const ordered = (matter.eventIds ?? []).filter(id => connected.has(id));
    return representativeEventIds(ordered.length ? ordered : seeds, eventById);
  };
  const independent = projection.events.filter(event => event.matterId === null && matched(eventMatches.get(event.id)))
    .sort((left, right) => (eventMatches.get(right.id)?.branchScores?.latestUser ?? 0) - (eventMatches.get(left.id)?.branchScores?.latestUser ?? 0)
      || (eventMatches.get(right.id)?.score ?? 0) - (eventMatches.get(left.id)?.score ?? 0)
      || right.assistantSeq - left.assistantSeq || left.id.localeCompare(right.id));
  return { eventById, matterScores, directMatters, pending, independent, matterEventIds };
}

const eventRecallRow = (event, matterStatus = null, order = 0) => frozen({ eventId: event.id, matterId: event.matterId,
  matterStatus, order, line: `- ${formatStoryTime(event.parsedStoryTime, event.storyTime)}：${event.title}` });
const pendingRecallRow = matter => frozen({ matterId: matter.matterId,
  line: `- ${matter.title}${matter.object ? `（${matter.object}）` : ''}${matter.scheduledTime ? `；约定：${matter.scheduledTime}` : ''}；尚未记录完成。` });

function renderQianshiRows(eventRows, pendingRows, characterBudget) {
  const maximumCharacters = Math.max(0, characterBudget);
  const pendingMatterIds = new Set(pendingRows.map(row => row.matterId));
  const lastEventByMatter = new Map();
  for (const row of eventRows) if (row.matterId) lastEventByMatter.set(row.matterId, row.eventId);
  const timelineSource = eventRows.map(row => ({ ...row,
    line: `${row.line}${row.matterId && ['planned', 'inProgress'].includes(row.matterStatus) && !pendingMatterIds.has(row.matterId)
      && lastEventByMatter.get(row.matterId) === row.eventId ? '（此后尚未记录完成）' : ''}` }));
  const takeRows = (title, rows, limit, selected = []) => {
    for (const row of rows.slice(selected.length)) {
      const candidate = [title, ...selected.map(item => item.line), row.line].join('\n');
      if (candidate.length > limit) break;
      selected.push(row);
    }
    return selected;
  };
  let acceptedPending = [];
  if (pendingRows.length) {
    const firstPendingLength = ['[当前待接续]', pendingRows[0].line].join('\n').length;
    const pendingReserve = eventRows.length
      ? Math.min(maximumCharacters, Math.max(Math.floor(maximumCharacters / 3), firstPendingLength))
      : maximumCharacters;
    acceptedPending = takeRows('[当前待接续]', pendingRows, pendingReserve);
  }
  const pendingText = acceptedPending.length ? ['[当前待接续]', ...acceptedPending.map(row => row.line)].join('\n') : '';
  const timelineLimit = Math.max(0, maximumCharacters - pendingText.length - (pendingText ? 2 : 0));
  const acceptedTimeline = takeRows('[相关时间线]', timelineSource, timelineLimit);
  const timelineText = acceptedTimeline.length ? ['[相关时间线]', ...acceptedTimeline.map(row => row.line)].join('\n') : '';
  const usedBeforePendingExpansion = timelineText.length + (timelineText && pendingText ? 2 : 0);
  if (acceptedPending.length < pendingRows.length) {
    acceptedPending = takeRows('[当前待接续]', pendingRows, Math.max(0, maximumCharacters - usedBeforePendingExpansion), acceptedPending);
  }
  const finalPendingText = acceptedPending.length ? ['[当前待接续]', ...acceptedPending.map(row => row.line)].join('\n') : '';
  const acceptedText = [timelineText, finalPendingText].filter(Boolean).join('\n\n');
  const eventIds = acceptedTimeline.map(row => row.eventId);
  const matterIds = acceptedPending.map(row => row.matterId);
  return frozen({ projectionVersion: QIANSHI_RECALL_PROJECTION_VERSION, text: acceptedText, characterCount: acceptedText.length,
    eventIds: frozen([...new Set(eventIds)]), matterIds: frozen([...new Set(matterIds)]) });
}

function projectSelectedQianshi(projection, eventIds, matterIds, characterBudget) {
  const events = new Map(projection.events.map(event => [event.id, event]));
  const matters = new Map(projection.matters.map(matter => [matter.matterId, matter]));
  const statusByMatter = new Map(projection.matters.map(matter => [matter.matterId, matter.status]));
  const eventRows = [...new Set(eventIds ?? [])].map((id, order) => events.has(id)
    ? eventRecallRow(events.get(id), statusByMatter.get(events.get(id).matterId) ?? null, order) : null).filter(Boolean);
  const pendingRows = [...new Set(matterIds ?? [])].map(id => matters.get(id)).filter(matter => ['planned', 'inProgress'].includes(matter?.status)).map(pendingRecallRow);
  return renderQianshiRows(eventRows, pendingRows, characterBudget);
}

/** Query-specific prompt projection. Public/detail views remain unchanged. */
export function projectQianshiRecall(reachable, { queryContext = null, identityProjection = null, characterBudget = 4000,
  selectedEventIds = null, selectedMatterIds = null } = {}) {
  const projection = projectQianshiGraph(reachable, { identityProjection });
  if (Array.isArray(selectedEventIds) || Array.isArray(selectedMatterIds)) {
    return projectSelectedQianshi(projection, selectedEventIds ?? [], selectedMatterIds ?? [], characterBudget);
  }
  const selected = recallSelection(projection, queryContext), eventIds = new Set();
  for (const { matter } of selected.directMatters) for (const id of selected.matterEventIds(matter)) eventIds.add(id);
  for (const event of selected.independent) eventIds.add(event.id);
  const orderedEvents = orderRecallTimelineEvents(projection.events.filter(event => eventIds.has(event.id)), projection.relations, projection.events);
  return projectSelectedQianshi(projection, orderedEvents.map(event => event.id), selected.pending.map(item => item.matter.matterId), characterBudget);
}

export function prepareQianshiRecallCandidates(reachable, { queryContext = null, identityProjection = null,
  characterBudget = QIANSHI_CANDIDATE_CHARACTER_BUDGET } = {}) {
  const projection = projectQianshiGraph(reachable, { identityProjection });
  const selected = recallSelection(projection, queryContext);
  const matterById = new Map(projection.matters.map(matter => [matter.matterId, matter]));
  const rowsFor = ids => [...new Set(ids)].map(id => selected.eventById.get(id)).filter(Boolean)
    .map(event => eventRecallRow(event, matterById.get(event.matterId)?.status ?? null));
  const candidates = [], lines = [];
  let usedCharacters = 0;
  const add = candidate => {
    const key = `Q${candidates.length + 1}`;
    const value = frozen({ key, ...candidate });
    const line = JSON.stringify({ key, kind: value.kind, fact: value.fact });
    const characters = usedCharacters + (lines.length ? 1 : 0) + line.length;
    if (characters > Math.max(0, characterBudget)) return;
    candidates.push(value); lines.push(line); usedCharacters = characters;
  };
  for (const { matter } of selected.pending) {
    const currentStatusLine = pendingRecallRow(matter).line;
    add({ kind: 'pending', fact: { title: matter.title, status: matter.status, people: matter.people.map(person => person.name), object: matter.object, currentStatusLine },
      eventIds: frozen([]), matterIds: frozen([matter.matterId]), eventRows: frozen([]), pendingRows: frozen([pendingRecallRow(matter)]) });
  }
  for (const { matter } of selected.directMatters) {
    const eventIds = selected.matterEventIds(matter);
    add({ kind: 'history', fact: { title: matter.title, status: matter.status, people: matter.people.map(person => person.name), object: matter.object,
      events: eventIds.map(id => selected.eventById.get(id)).filter(Boolean).map(event => ({ title: event.title, description: event.description, storyTime: event.storyTime })) },
      eventIds: frozen(eventIds), matterIds: frozen([]), eventRows: frozen(rowsFor(eventIds)), pendingRows: frozen([]) });
  }
  for (const event of selected.independent) add({ kind: 'history', fact: { title: event.title, status: event.status, people: event.people.map(person => person.name),
    description: event.description, storyTime: event.storyTime, scheduledTime: event.scheduledTime }, eventIds: frozen([event.id]), matterIds: frozen([]),
    eventRows: frozen(rowsFor([event.id])), pendingRows: frozen([]) });
  const candidateEventIds = new Set(candidates.flatMap(candidate => candidate.eventRows.map(row => row.eventId)));
  const timelineOrder = new Map(orderRecallTimelineEvents(projection.events.filter(event => candidateEventIds.has(event.id)),
    projection.relations, projection.events).map((event, index) => [event.id, index]));
  const orderedCandidates = candidates.map(candidate => frozen({ ...candidate, eventRows: frozen(candidate.eventRows
    .map(row => frozen({ ...row, order: timelineOrder.get(row.eventId) ?? Number.MAX_SAFE_INTEGER }))) }));
  return frozen({ candidates: frozen(orderedCandidates), stats: frozen({ count: orderedCandidates.length, characters: lines.join('\n').length, budget: characterBudget }) });
}

export function projectQianshiCandidateSelection(candidates, { excludedKeys = [], characterBudget = 4000 } = {}) {
  const excluded = new Set(excludedKeys), eventRows = new Map(), pendingRows = new Map();
  for (const candidate of candidates ?? []) {
    if (excluded.has(candidate.key)) continue;
    for (const row of candidate.eventRows ?? []) if (!eventRows.has(row.eventId)) eventRows.set(row.eventId, row);
    for (const row of candidate.pendingRows ?? []) if (!pendingRows.has(row.matterId)) pendingRows.set(row.matterId, row);
  }
  return renderQianshiRows([...eventRows.values()].sort((left, right) => left.order - right.order), [...pendingRows.values()], characterBudget);
}

export function prepareQianshiCandidates(reachable, { canonicalContent = '', precedingUserInput = null, characterBudget = QIANSHI_CANDIDATE_CHARACTER_BUDGET,
  identityProjection = null, includeEventContextCandidates = false } = {}) {
  const projection = projectQianshiGraph(reachable, { identityProjection });
  const matters = prepareQianshiCandidatesFromMatters(projection.matters, { canonicalContent, precedingUserInput, characterBudget });
  if (!includeEventContextCandidates) return matters;
  const query = clean([canonicalContent, ...(precedingUserInput?.messages ?? []).map(message => message.content)].join(' '), 24000);
  if (!query || matters.stats.characters >= characterBudget) return matters;
  const eventCandidates = projection.events.filter(event => event.matterId === null);
  if (!eventCandidates.length) return matters;
  const ranked = rankRecallDocuments({ documents: eventCandidates.map(event => ({ id: event.id, text: relevanceText(event) })),
    queries: [{ key: 'targetFloor', text: query, weight: 1 }] });
  const ordered = new Map(ranked.map(item => [item.id, item]));
  const request = [...matters.request], bindings = [...matters.bindings], lines = matters.request.map(value => JSON.stringify(value));
  for (const event of eventCandidates.filter(item => (ordered.get(item.id)?.branchMatchCounts?.targetFloor ?? 0) > 0)
    .sort((left, right) => (ordered.get(right.id)?.score ?? 0) - (ordered.get(left.id)?.score ?? 0)
      || right.assistantSeq - left.assistantSeq || left.id.localeCompare(right.id))) {
    const key = `candidate-${request.length + 1}`;
    const value = { key, candidateType: 'event', title: event.title, status: event.status,
      people: event.people.map(person => person.name), object: event.object,
      origin: { title: event.title, description: event.description, storyTime: event.storyTime,
        scheduledTime: event.scheduledTime, sourceAssistantSeq: event.assistantSeq },
      latestProgress: { title: event.title, description: event.description, storyTime: event.storyTime,
        scheduledTime: event.scheduledTime, sourceAssistantSeq: event.assistantSeq } };
    const line = JSON.stringify(value);
    if (lines.join('\n').length + line.length > Math.max(0, characterBudget)) continue;
    request.push(frozen(value)); lines.push(line);
    bindings.push(frozen({ key, matterId: null, originEventId: event.id, latestEventIds: frozen([event.id]),
      sourceFloorId: event.sourceFloorId, sourceAssistantSeq: event.assistantSeq, latestStoryTime: event.storyTime,
      latestScheduledTime: event.scheduledTime }));
  }
  return frozen({ request: frozen(request), bindings: frozen(bindings), stats: frozen({ count: request.length,
    characters: lines.join('\n').length, budget: characterBudget }) });
}

function qianshiCandidateQuery(canonicalContent, precedingUserInput) {
  return clean([canonicalContent, ...(precedingUserInput?.messages ?? []).map(message => message.content)].join(' '), 24000).toLocaleLowerCase('zh-CN');
}

function prepareQianshiCandidatesFromMatters(matters, { canonicalContent = '', precedingUserInput = null, characterBudget = QIANSHI_CANDIDATE_CHARACTER_BUDGET, terminalMatterIds = null } = {}) {
  const query = clean([canonicalContent, ...(precedingUserInput?.messages ?? []).map(message => message.content)].join(' '), 24000);
  const normalizedQuery = query.toLocaleLowerCase('zh-CN');
  const documents = matters.filter(matter => !TERMINAL_STATUSES.has(matter.status)).map(matter => ({ id: matter.matterId, text: relevanceText(matter) }));
  const ranked = new Map(rankRecallDocuments({ documents, queries: [{ key: 'targetFloor', text: query, weight: 1 }] }).map(item => [item.id, item]));
  const scored = matters.map(matter => {
    const rank = ranked.get(matter.matterId);
    const unfinished = !TERMINAL_STATUSES.has(matter.status);
    const title = clean(matter.title, 500).toLocaleLowerCase('zh-CN');
    const object = clean(matter.object, 1000).toLocaleLowerCase('zh-CN');
    const terminalReopen = terminalMatterIds ? terminalMatterIds.has(matter.matterId)
      : Boolean(normalizedQuery && (title && normalizedQuery.includes(title) || object.length >= 2 && normalizedQuery.includes(object)));
    return { matter, relevant: unfinished ? (rank?.branchMatchCounts?.targetFloor ?? 0) > 0 : terminalReopen,
      score: Number(unfinished) * 100000 + (rank?.score ?? 0) * 10000 + matter.sourceAssistantSeq };
  }).filter(item => !TERMINAL_STATUSES.has(item.matter.status) || item.relevant)
    .sort((left, right) => right.score - left.score || left.matter.matterId.localeCompare(right.matter.matterId));
  const request = [], bindings = [], lines = [];
  for (const { matter } of scored) {
    const key = `candidate-${request.length + 1}`;
    const value = { key, candidateType: 'matter', title: matter.title, status: matter.status, people: matter.people.map(person => person.name), object: matter.object,
      origin: { title: matter.origin.title, description: matter.origin.description, storyTime: matter.origin.storyTime,
        scheduledTime: matter.origin.scheduledTime, sourceAssistantSeq: matter.origin.sourceAssistantSeq },
      latestProgress: { title: matter.title, description: matter.description, storyTime: matter.storyTime,
        scheduledTime: matter.scheduledTime, sourceAssistantSeq: matter.sourceAssistantSeq } };
    const line = JSON.stringify(value);
    if (lines.join('\n').length + line.length > Math.max(0, characterBudget)) continue;
    request.push(frozen(value)); lines.push(line);
    bindings.push(frozen({ key, matterId: matter.matterId, originEventId: matter.origin.eventId,
      latestEventIds: frozen([...matter.latestEventIds]), sourceFloorId: matter.sourceFloorId,
      sourceAssistantSeq: matter.sourceAssistantSeq, latestStoryTime: matter.storyTime, latestScheduledTime: matter.scheduledTime }));
  }
  return frozen({ request: frozen(request), bindings: frozen(bindings), stats: frozen({ count: request.length, characters: lines.join('\n').length, budget: characterBudget }) });
}

export function createQianshiCandidateIndex({ projector = projectQianshiGraph } = {}) {
  let snapshot = null;
  const identityKey = value => JSON.stringify(value?.identityProjection ?? {});
  const floorMemoryIds = reachable => {
    const groups = new Map();
    for (const memory of reachable?.floorMemories ?? []) if (memory.recordStatus === 'active') groups.set(memory.floorId, [...(groups.get(memory.floorId) ?? []), memory]);
    return (reachable?.floors ?? []).map(floor => {
      const values = groups.get(floor.id) ?? [];
      const memory = values.length === 1 ? values[0] : null;
      const ambiguousIds = values.length > 1 ? values.map(item => item.id).sort().join(',') : null;
      return [floor.id, memory?.id ?? null, ambiguousIds];
    });
  };
  const matterCopy = matter => ({ ...matter, people: (matter.people ?? []).map(person => ({ ...person })), latestEventIds: [...(matter.latestEventIds ?? [])],
    eventIds: [...(matter.eventIds ?? [])], origin: { ...matter.origin } });
  const terminalPhrases = matter => [...new Set([clean(matter.title, 500).toLocaleLowerCase('zh-CN'), clean(matter.object, 1000).toLocaleLowerCase('zh-CN')]
    .filter((phrase, index) => phrase && (index === 0 || phrase.length >= 2)))];
  function updateTerminalIndex(state, matterId, prior, next) {
    if (prior && TERMINAL_STATUSES.has(prior.status)) for (const phrase of state.terminalPhrasesByMatter.get(matterId) ?? []) {
      const postings = phrase.length === 1 ? state.terminalSingleChar : state.terminalBigrams;
      const grams = phrase.length === 1 ? [phrase] : [...new Set(Array.from({ length: phrase.length - 1 }, (_, index) => phrase.slice(index, index + 2)))];
      for (const gram of grams) { const ids = postings.get(gram); ids?.delete(matterId); if (!ids?.size) postings.delete(gram); }
      state.terminalPhrasesByMatter.delete(matterId);
    }
    if (next && TERMINAL_STATUSES.has(next.status)) {
      const phrases = terminalPhrases(next);
      state.terminalPhrasesByMatter.set(matterId, phrases);
      for (const phrase of phrases) {
        const postings = phrase.length === 1 ? state.terminalSingleChar : state.terminalBigrams;
        const grams = phrase.length === 1 ? [phrase] : [...new Set(Array.from({ length: phrase.length - 1 }, (_, index) => phrase.slice(index, index + 2)))];
        for (const gram of grams) postings.set(gram, new Set([...(postings.get(gram) ?? []), matterId]));
      }
    }
  }
  const addFrontierEvent = (matter, event, assistantSeq) => {
    const frontier = [...(matter?._frontier ?? []), { id: event.id, assistantSeq }]
      .filter((item, index, all) => all.findIndex(value => value.id === item.id) === index)
      .sort((left, right) => right.assistantSeq - left.assistantSeq || right.id.localeCompare(left.id));
    return { ...matter, _frontier: frontier, latestEventIds: frontier.map(item => item.id), eventIds: [...(matter?.eventIds ?? []), event.id] };
  };
  function appendDelta(state, floor, memory, floorSeq) {
    const delta = memory?.qianshiDelta;
    const effective = effectiveQianshiDelta(memory);
    if (effective.reviewEvents.length || effective.reviewRelations.length) return false;
    if (!delta || !['ready', 'partial'].includes(delta.status)) return true;
    const aggregate = (memory.sourceFloorIds ?? [memory.floorId]).length > 1;
    const affected = new Set();
    for (const event of effective.events) {
      if (state.events.has(event.id)) continue;
      const assistantSeq = aggregate ? floorSeq.get(event.sourceFloorId) ?? null : floor.assistantSeq;
      const projectedEvent = { ...event, assistantSeq };
      state.events.set(event.id, projectedEvent);
      if (!event.matterId || !event.updatesMatter) continue;
      const prior = state.matters.get(event.matterId);
      const current = prior ?? { matterId: event.matterId, origin: { eventId: event.id, title: event.title, description: event.description,
        storyTime: event.storyTime, scheduledTime: event.scheduledTime, sourceFloorId: event.sourceFloorId, sourceAssistantSeq: assistantSeq },
        people: [], latestEventIds: [], eventIds: [], _frontier: [] };
      state.matters.set(event.matterId, addFrontierEvent(current, projectedEvent, assistantSeq));
      affected.add(event.matterId);
    }
    for (const relation of effective.relations) {
      const prior = state.relations.get(relation.id);
      if (prior && (prior.type !== relation.type || prior.fromEventId !== relation.fromEventId || prior.toEventId !== relation.toEventId)) return false;
      state.relations.set(relation.id, relation);
      const from = state.events.get(relation.fromEventId), to = state.events.get(relation.toEventId);
      if (relation.type !== 'progress' || !from || !to || !from.matterId || from.matterId !== to.matterId || !to.updatesMatter) continue;
      const matter = state.matters.get(to.matterId);
      if (!matter) continue;
      const frontier = (matter._frontier ?? []).filter(item => item.id !== from.id);
      if (!frontier.some(item => item.id === to.id)) frontier.push({ id: to.id, assistantSeq: to.assistantSeq });
      frontier.sort((left, right) => right.assistantSeq - left.assistantSeq || right.id.localeCompare(left.id));
      state.matters.set(to.matterId, { ...matter, _frontier: frontier, latestEventIds: frontier.map(item => item.id) });
      affected.add(to.matterId);
    }
    for (const matterId of affected) {
      const prior = state.matters.get(matterId), representative = state.events.get(prior?._frontier?.[0]?.id);
      if (!representative) continue;
      const next = { ...prior, title: representative.title, object: representative.object, status: representative.status,
        people: (representative.people ?? []).map(person => ({ ...person })), sourceFloorId: representative.sourceFloorId,
        sourceAssistantSeq: representative.assistantSeq, storyTime: representative.storyTime, scheduledTime: representative.scheduledTime,
        description: representative.description };
      updateTerminalIndex(state, matterId, prior, next);
      if (!TERMINAL_STATUSES.has(prior.status)) state.activeMatterIds.delete(matterId);
      if (!TERMINAL_STATUSES.has(next.status)) state.activeMatterIds.add(matterId);
      state.matters.set(matterId, next);
    }
    return true;
  }
  function matchingTerminalMatterIds(state, query) {
    const candidates = new Set();
    for (let index = 0; index < query.length; index += 1) {
      const single = state.terminalSingleChar.get(query[index]);
      if (single) for (const id of single) candidates.add(id);
      if (index + 1 < query.length) {
        const ids = state.terminalBigrams.get(query.slice(index, index + 2));
        if (ids) for (const id of ids) candidates.add(id);
      }
    }
    const matched = new Set();
    for (const id of candidates) if ((state.terminalPhrasesByMatter.get(id) ?? []).some(phrase => query.includes(phrase))) matched.add(id);
    return matched;
  }
  return Object.freeze({
    prepare(reachable, options = {}) {
      const keys = floorMemoryIds(reachable), root = reachable?.root ?? {};
      const extendsLegacyReviewPrefix = snapshot && keys.length > snapshot.keys.length && activeMemories(reachable).some(({ memory }) => {
        const effective = effectiveQianshiDelta(memory);
        return effective.reviewEvents.length > 0 || effective.reviewRelations.length > 0;
      });
      const samePrefix = snapshot && snapshot.chatId === root.chatId && snapshot.generation === root.narrativeGeneration
        && snapshot.identityKey === identityKey(options) && snapshot.keys.length <= keys.length
        && !extendsLegacyReviewPrefix
        && snapshot.keys.every((key, index) => key.every((part, partIndex) => part === keys[index][partIndex]));
      if (!samePrefix) {
        const projection = projector(reachable, { identityProjection: options.identityProjection });
        const events = new Map(projection.events.map(event => [event.id, event]));
        const matters = new Map(projection.matters.map(matter => [matter.matterId, { ...matterCopy(matter),
          _frontier: matter.latestEventIds.map(id => ({ id, assistantSeq: events.get(id)?.assistantSeq ?? matter.sourceAssistantSeq })) }]));
        snapshot = { chatId: root.chatId, generation: root.narrativeGeneration, identityKey: identityKey(options), keys,
          events, relations: new Map(projection.relations.map(relation => [relation.id, relation])), matters, activeMatterIds: new Set(),
          terminalBigrams: new Map(), terminalSingleChar: new Map(), terminalPhrasesByMatter: new Map() };
        for (const matter of matters.values()) {
          if (TERMINAL_STATUSES.has(matter.status)) updateTerminalIndex(snapshot, matter.matterId, null, matter);
          else snapshot.activeMatterIds.add(matter.matterId);
        }
      } else if (keys.length > snapshot.keys.length) {
        const memoryById = new Map((reachable.floorMemories ?? []).map(memory => [memory.id, memory]));
        for (let index = snapshot.keys.length; index < keys.length; index += 1) {
          const [floorId, memoryId, ambiguousIds] = keys[index];
          const floor = reachable.floors[index];
          if (ambiguousIds) {
            snapshot = null;
            return this.prepare(reachable, options);
          }
          if (memoryId && !appendDelta(snapshot, floor, memoryById.get(memoryId), new Map(reachable.floors.map(item => [item.id, item.assistantSeq])))) {
            snapshot = null;
            return this.prepare(reachable, options);
          }
        }
        snapshot.keys = keys;
      }
      const query = qianshiCandidateQuery(options.canonicalContent, options.precedingUserInput);
      const reopened = matchingTerminalMatterIds(snapshot, query);
      const matters = [...snapshot.activeMatterIds].map(id => snapshot.matters.get(id)).filter(Boolean);
      for (const id of reopened) matters.push(snapshot.matters.get(id));
      return prepareQianshiCandidatesFromMatters(matters, { ...options, terminalMatterIds: reopened });
    },
    invalidate() { snapshot = null; },
  });
}

function packetQianshi(packet) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return undefined;
  for (const key of ['qianshi', '千事', 'timeline', '时间线']) if (Object.hasOwn(packet, key)) return packet[key];
  return undefined;
}

function personDirectory(entities, identityProjection) {
  const entries = buildEntityIdentityDirectory({ entities, identityProjection: normalizeIdentityProjection(identityProjection ?? {}) });
  const byLabel = new Map();
  for (const entry of entries) for (const label of [entry.displayName, ...entry.aliases]) {
    const normalized = clean(label, 500).toLocaleLowerCase('zh-CN');
    if (!normalized) continue;
    byLabel.set(normalized, [...(byLabel.get(normalized) ?? []), entry]);
  }
  return name => {
    const matches = byLabel.get(clean(name, 500).toLocaleLowerCase('zh-CN')) ?? [];
    const unique = [...new Map(matches.map(entry => [entry.entityId, entry])).values()];
    return unique.length === 1 ? unique[0].entityId : null;
  };
}

export async function compileQianshiDelta({ packet, floor, sourceFloorBindings = [], candidateBindings = [], candidateStats = null, entities = [], identityProjection = null, compiledBindings = null, now = new Date().toISOString() } = {}) {
  const stats = { count: Number(candidateStats?.count) || 0, characters: Number(candidateStats?.characters) || 0 };
  const sourceByKey = new Map(sourceFloorBindings.map(item => [item.floorKey, item.floorId]));
  const sourceFloorIds = sourceByKey.size ? [...sourceByKey.values()] : [floor.id];
  const pending = reason => validateQianshiDelta({ schemaVersion: QIANSHI_SCHEMA_VERSION, status: 'pending', reason: clean(reason, 500) || '千事字段待补。', compiledAt: now,
    candidateStats: stats, events: [], relations: [] }, { floorIds: sourceFloorIds });
  const qianshi = packetQianshi(packet);
  if (qianshi === undefined) return pending('本次返回未包含千事字段。');
  if (!qianshi || typeof qianshi !== 'object' || Array.isArray(qianshi) || !Array.isArray(qianshi.events)) return pending('千事字段整体格式无效。');
  const candidateByKey = new Map(candidateBindings.map(item => [item.key, item]));
  const local = new Map();
  const events = [], relations = [], issues = [];
  const resolvePerson = personDirectory(entities, identityProjection);
  const eventCompileIssue = (index, error) => {
    const number = index + 1;
    if (error?.code === 'QIANSHI_EVENT_KEY_DUPLICATE') return `第 ${number} 件事件的内部标识与前面重复，未保存。`;
    if (error?.code === 'QIANSHI_EVENT_SOURCE_FLOOR_INVALID') return `第 ${number} 件事件无法对应到原文楼层，未保存。`;
    if (error?.code === 'QIANSHI_EVENT_INVALID') return `第 ${number} 件事件缺少有效标题或说明，未保存。`;
    return `第 ${number} 件事件未能完成本地整理，原条目未保存。`;
  };
  for (const [index, raw] of qianshi.events.slice(0, 160).entries()) {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw qianshiError('QIANSHI_EVENT_INVALID', `events[${index}]`);
      const title = clean(raw.title ?? raw.name, 500), description = clean(raw.description ?? raw.summary ?? raw.content, 4000);
      if (!title || !description) throw qianshiError('QIANSHI_EVENT_INVALID', `events[${index}]`);
      const localKey = keyText(raw.key) || `event-${index + 1}`;
      if (local.has(localKey)) throw qianshiError('QIANSHI_EVENT_KEY_DUPLICATE', `events[${index}].key`);
      const sourceFloorId = sourceByKey.size > 1 ? sourceByKey.get(keyText(raw.sourceFloorKey)) : floor.id;
      if (!sourceFloorId) throw qianshiError('QIANSHI_EVENT_SOURCE_FLOOR_INVALID', `events[${index}].sourceFloorKey`);
      const status = STATUSES.has(raw.status) ? raw.status : 'occurred';
      const rawLinks = list(raw.links).map(link => ({ candidateKey: keyText(link?.candidateKey ?? link?.candidate), kind: link?.kind === 'context' ? 'context' : 'progress' }));
      if (!rawLinks.length) for (const candidateKey of list(raw.continues ?? raw.continuesCandidates ?? raw.relatedCandidates).map(keyText).filter(Boolean)) rawLinks.push({ candidateKey, kind: 'progress' });
      const resolvedLinks = rawLinks.map(link => ({ ...link, candidate: candidateByKey.get(link.candidateKey) })).filter(link => link.candidate);
      const invalidReference = rawLinks.length !== resolvedLinks.length;
      const matterIds = [...new Set(resolvedLinks.map(item => item.candidate.matterId))];
      if (matterIds.length > 1) resolvedLinks.length = 0;
      const id = await deterministicUuid(['qianshi-event-v1', sourceFloorId, localKey, title, description, status]);
      const storyTime = clean(raw.storyTime ?? raw.occurredAt, 500) || null;
      const link = resolvedLinks[0] ?? null;
      const invalidProgress = link?.kind === 'progress' && !link.candidate.matterId;
      const backdated = link?.kind === 'progress' && storyTime && link.candidate.latestStoryTime
        && comparableBefore(projectTime(storyTime), projectTime(link.candidate.latestStoryTime));
      const invalidLink = invalidReference || invalidProgress;
      const updatesMatter = invalidLink ? false : link ? link.kind === 'progress' && !backdated : raw.matter === true || ['planned', 'inProgress'].includes(status);
      const matterId = invalidLink ? null : link?.candidate.matterId ?? (updatesMatter ? await deterministicUuid(['qianshi-matter-v1', id, clean(raw.object, 1000), title]) : null);
      const people = [...new Set(list(raw.people ?? raw.participants).map(value => clean(typeof value === 'string' ? value : value?.name, 500)).filter(Boolean))]
        .map(name => ({ entityId: resolvePerson(name), name }));
      const event = { id, matterId, updatesMatter, title, description, status, storyTime,
        scheduledTime: clean(raw.scheduledTime ?? raw.expectedAt ?? raw.dueTime, 500) || null, people, object: clean(raw.object ?? raw.subject, 1000) || null,
        sourceFloorId, continuesFromEventIds: invalidLink ? [] : [...new Set(resolvedLinks.flatMap(item => item.candidate.latestEventIds ?? []))] };
      events.push(event); local.set(localKey, event);
      if (Array.isArray(compiledBindings)) compiledBindings.push(Object.freeze({ localKey, event: Object.freeze({ ...event }) }));
      if (updatesMatter && link?.kind === 'progress') for (const priorEventId of event.continuesFromEventIds) relations.push({ id: await deterministicUuid(['qianshi-relation-v1', 'progress', priorEventId, id]), type: 'progress', fromEventId: priorEventId, toEventId: id, certainty: 'explicit' });
    } catch (error) {
      issues.push(eventCompileIssue(index, error));
    }
  }
  const resolveEventRef = value => {
    const key = keyText(value);
    if (local.has(key)) return local.get(key).id;
    const candidate = candidateByKey.get(key);
    return candidate?.latestEventIds?.length === 1 ? candidate.latestEventIds[0] : null;
  };
  const rawOrder = Array.isArray(qianshi.order) && qianshi.order.length > 0 && qianshi.order.every(value => typeof value === 'string')
    ? qianshi.order.slice(1, 321).map((after, index) => ({ before: qianshi.order[index], after }))
    : list(qianshi.order).slice(0, 320);
  for (const [index, raw] of rawOrder.entries()) {
    const fromEventId = resolveEventRef(raw?.before), toEventId = resolveEventRef(raw?.after);
    if (!fromEventId || !toEventId || fromEventId === toEventId) continue;
    relations.push({ id: await deterministicUuid(['qianshi-relation-v1', 'before', fromEventId, toEventId]), type: 'before', fromEventId, toEventId,
      certainty: raw?.certainty === 'strong' ? 'strong' : 'explicit' });
  }
  const dedupedRelations = [...new Map(relations.map(item => [item.id, item])).values()];
  const status = events.length ? 'ready' : qianshi.events.length === 0 ? 'empty' : 'pending';
  const reason = issues.length && !events.length ? clean(`${issues.length} 项未能编译：${issues.slice(0, 3).join('；')}`, 500) : null;
  return validateQianshiDelta({ schemaVersion: QIANSHI_SCHEMA_VERSION, status, reason, compiledAt: now, candidateStats: stats, events, relations: dedupedRelations }, { floorIds: sourceFloorIds });
}

export function pendingQianshiDelta(previous, reason, now = new Date().toISOString()) {
  return validateQianshiDelta({ schemaVersion: QIANSHI_SCHEMA_VERSION, status: 'pending', reason: clean(reason, 500) || '千事字段待补。', compiledAt: now,
    candidateStats: { count: Number(previous?.candidateStats?.count) || 0, characters: Number(previous?.candidateStats?.characters) || 0 }, events: [], relations: [] });
}

export function publicQianshiSnapshot(reachable, history = null, identityProjection = null) {
  const projection = projectQianshiGraph(reachable, { identityProjection });
  const floorById = new Map((reachable?.floors ?? []).map(floor => [floor.id, floor]));
  const publicEvent = event => ({ id: event.id, matterId: event.matterId, title: event.title, description: event.description, status: event.status,
    updatesMatter: event.updatesMatter, storyTime: event.storyTime, scheduledTime: event.scheduledTime, people: event.people.map(person => ({ ...person })), object: event.object,
    sourceFloorId: event.sourceFloorId, sourceFloorMemoryId: event.floorMemoryId, sourceAssistantSeq: event.assistantSeq,
    sourceMessageIndex: floorById.get(event.sourceFloorId)?.hostLocator?.messageIndex ?? null });
  return structuredClone({ status: 'ready', identity: { qqjChatId: reachable.root.chatId }, anchor: { narrativeGeneration: reachable.root.narrativeGeneration, headCheckpointId: reachable.root.headCheckpointId, rootRevision: reachable.rootRevision },
    coverage: projection.coverage, events: projection.events.map(publicEvent), matters: projection.matters, relations: projection.relations,
    timeline: projectQianshiTimeline(projection), currentProgress: projection.currentProgress,
    history: history ?? { status: 'idle', jobId: null, processedFloors: 0, totalFloors: 0, calls: 0, message: '' }, diagnostics: projection.diagnostics });
}
