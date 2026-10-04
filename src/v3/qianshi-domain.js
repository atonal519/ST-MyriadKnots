import { MultiDirectedGraph, DirectedGraph } from 'graphology';
import { topologicalSort, willCreateCycle } from 'graphology-dag';
import { deterministicUuid } from './foundation-domain.js';
import { formatStoryTime, isRelativeStoryTime, projectTime, storyTimes, timeDistance } from './time-engine.js';
import { calendarKey } from './calendar-rules.js';
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
const modelStatusSpelling = value => value.normalize('NFKC').trim().toLowerCase().replace(/[\s_-]+/gu, '');
const MODEL_STATUS_ALIASES = {
  planned: ['scheduled', 'todo', 'notstarted', '待办', '计划中', '未开始'],
  inProgress: ['ongoing', 'inprocess', 'underway', '进行中'],
  completed: ['complete', 'done', 'finished', '已完成'],
  cancelled: ['canceled', '已取消'],
  occurred: ['happened', '已发生'],
  unknown: ['unspecified', '未知', '不明', '不确定'],
};
const MODEL_STATUS_NAMES = new Map([...STATUSES].flatMap(status =>
  [status, ...MODEL_STATUS_ALIASES[status]].map(value => [modelStatusSpelling(value), status])));
// 所有模型入口共用有限的等价状态词和拼写归一化；落盘只保存规范状态。
// 不认识的词仍拒绝，不按描述猜剧情，也不把坏值默认成“已发生”。
const normalizeModelStatus = value => typeof value === 'string'
  ? MODEL_STATUS_NAMES.get(modelStatusSpelling(value)) ?? null : null;
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
  // Legacy review candidates may fill missing IDs, but a conflicting ID never replaces the formal event or relation.
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

const projectQianshiTime = (value, anchor = null, calendar = anchor?.calendar ?? null) => projectTime(value, anchor, { allowShortGregorianYear: true, calendar });
const GREGORIAN_MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function stableTopologicalOrder(graph, indices) {
  const remainingIncoming = new Map(graph.nodes().map(id => [id, graph.inDegree(id)]));
  const rank = id => indices.get(graph.getNodeAttribute(id, 'value').id);
  const ready = [];
  const push = id => {
    let index = ready.length;
    ready.push(id);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (rank(ready[parent]) <= rank(id)) break;
      ready[index] = ready[parent]; index = parent;
    }
    ready[index] = id;
  };
  const pop = () => {
    const first = ready[0], last = ready.pop();
    if (ready.length) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1, right = left + 1;
        if (left >= ready.length) break;
        const child = right < ready.length && rank(ready[right]) < rank(ready[left]) ? right : left;
        if (rank(last) <= rank(ready[child])) break;
        ready[index] = ready[child]; index = child;
      }
      ready[index] = last;
    }
    return first;
  };
  for (const [id, degree] of remainingIncoming) if (degree === 0) push(id);
  const ordered = [];
  while (ready.length) {
    const id = pop();
    ordered.push(graph.getNodeAttribute(id, 'value'));
    for (const next of graph.outNeighbors(id)) {
      const degree = remainingIncoming.get(next) - 1;
      remainingIncoming.set(next, degree);
      if (degree === 0) push(next);
    }
  }
  return ordered;
}

export function orderQianshiLineRecords(values, sourceIndex) {
  const sourceOrder = [...values].sort((left, right) => (left.assistantSeq ?? Number.MAX_SAFE_INTEGER) - (right.assistantSeq ?? Number.MAX_SAFE_INTEGER)
    || (sourceIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (sourceIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    || left.id.localeCompare(right.id));
  const graph = new DirectedGraph({ allowSelfLoops: false });
  for (const event of sourceOrder) graph.addNode(eventNode(event.id), { value: event });
  const indices = new Map(sourceOrder.map((event, index) => [event.id, index]));
  const timeDomain = time => time?.calendar ? `calendar:${calendarKey(time.calendar)}:${time.year === null ? 'yearless' : 'dated'}` : time?.monthIdentity ? `special:${time.monthIdentity}`
    : Number.isInteger(time?.day) ? 'absolute-day' : Number.isInteger(time?.monthDay) ? 'yearless-day' : null;
  const timedGroups = new Map();
  for (const event of sourceOrder) {
    const domain = timeDomain(event.parsedStoryTime);
    if (domain) {
      const group = timedGroups.get(domain);
      if (group) group.push(event);
      else timedGroups.set(domain, [event]);
    }
  }
  for (const group of timedGroups.values()) {
    const domain = timeDomain(group[0].parsedStoryTime), buckets = new Map();
    for (const event of group) {
      const time = event.parsedStoryTime;
      // A day number alone cannot identify a yearless date when its month is known.
      const dateKey = Number.isInteger(time.day) ? time.day
        : Number.isInteger(time.month) ? `month:${time.month}:day:${time.monthDay}`
          : Number.isInteger(time.monthDay) ? `day:${time.monthDay}`
            : Number.isInteger(time.weekOrdinal) && time.weekday ? `week:${time.weekday}:${time.weekOrdinal}` : `unknown:${event.id}`;
      const bucket = buckets.get(dateKey);
      if (bucket) bucket.push(event);
      else buckets.set(dateKey, [event]);
    }
    const orderedBuckets = [...buckets.values()].map(events => {
      const dayGraph = new DirectedGraph({ allowSelfLoops: false });
      for (const event of events) dayGraph.addNode(eventNode(event.id), { value: event });
      const clocked = events.filter(event => Number.isInteger(event.parsedStoryTime?.minute));
      for (let index = 1; index < clocked.length; index += 1) {
        const left = clocked[index - 1], right = clocked[index];
        const from = right.parsedStoryTime.minute >= left.parsedStoryTime.minute ? left : right;
        const to = from === left ? right : left;
        dayGraph.addDirectedEdge(eventNode(from.id), eventNode(to.id));
      }
      const ordered = stableTopologicalOrder(dayGraph, indices);
      for (let index = 1; index < ordered.length; index += 1) graph.addDirectedEdge(eventNode(ordered[index - 1].id), eventNode(ordered[index].id));
      return { events: ordered, firstSourceIndex: events.reduce((minimum, event) => Math.min(minimum, indices.get(event.id)), Number.MAX_SAFE_INTEGER) };
    });
    if (Number.isInteger(group[0].parsedStoryTime.day)) orderedBuckets.sort((left, right) => left.events[0].parsedStoryTime.day - right.events[0].parsedStoryTime.day);
    else orderedBuckets.sort((left, right) => left.firstSourceIndex - right.firstSourceIndex);
    let previousComparable = null;
    for (const bucket of orderedBuckets) {
      if (!previousComparable) { previousComparable = bucket; continue; }
      const left = previousComparable.events, right = bucket.events;
      const distance = timeDistance(left[0].parsedStoryTime, right[0].parsedStoryTime);
      // Incomparable dates keep source fallback without masking a later comparable pair.
      if (distance === null) {
        if (domain === 'yearless-day' && Number.isInteger(right[0].parsedStoryTime?.month)) previousComparable = bucket;
        continue;
      }
      const from = distance >= 0 ? left.at(-1) : right.at(-1), to = distance >= 0 ? right[0] : left[0];
      graph.addDirectedEdge(eventNode(from.id), eventNode(to.id));
      previousComparable = bucket;
    }
  }
  return stableTopologicalOrder(graph, indices);
}

function deriveQianshiLine(values, sourceIndex) {
  const records = orderQianshiLineRecords(values, sourceIndex);
  return { records, current: records.filter(event => event.updatesMatter).at(-1) ?? null };
}

const hasTrackableCurrent = matter => Boolean(matter && !matter.synthetic && matter.matterId && matter.currentEventId
  && matter.latestEventIds?.length === 1 && matter.latestEventIds[0] === matter.currentEventId);

function sourceTimeFor(event, floorTime, { aggregate = false, calendar = floorTime?.calendar ?? null } = {}) {
  // 人工确认的发生时间独立于来源楼；清空或只填时钟都不能偷偷继承楼层日期。
  if (event.timeManuallyEdited) {
    const raw = event.storyTime ?? '', separator = STORY_TIME_RANGE.exec(raw);
    const projected = projectQianshiTime(separator ? raw.slice(0, separator.index).trim() : raw, null, calendar);
    return separator ? { ...projected, rangeText: raw } : projected;
  }
  if (aggregate) return projectQianshiTime(event.storyTime ?? '', null, calendar);
  if (!event.storyTime) return floorTime ?? projectTime('');
  return projectQianshiTime(event.storyTime, floorTime ?? null, calendar);
}

function comparableBefore(left, right) {
  const distance = timeDistance(left, right);
  return distance !== null && distance > 0;
}

// 删除身份只来自有效前缀的原事件与所属楼标记；供冻结注入和旧刻度关联复核，不猜语义。
export function qianshiDeletedEvents(reachable) {
  return activeMemories(reachable).flatMap(({ memory }) => {
    const deleted = new Set(memory.qianshiDelta?.deletedEventIds ?? []);
    return (memory.qianshiDelta?.events ?? []).filter(event => deleted.has(event.id))
      .map(event => ({ eventId: event.id, matterId: event.matterId ?? `legacy-singleton:${event.id}` }));
  });
}

export function projectQianshiGraph(reachable, { identityProjection = null, progressCharacters = QIANSHI_PROGRESS_CHARACTER_BUDGET, calendar = reachable?.calendar ?? null } = {}) {
  const graph = new MultiDirectedGraph({ allowSelfLoops: false });
  const orderGraph = new DirectedGraph({ allowSelfLoops: false });
  const progressGraph = new DirectedGraph({ allowSelfLoops: false });
  const floors = reachable?.floors ?? [];
  const floorById = new Map(floors.map(floor => [floor.id, floor]));
  const floorTimes = storyTimes((reachable?.floorMemories ?? []), floors, (raw, anchor) => projectQianshiTime(raw, anchor, calendar));
  const directory = buildEntityIdentityDirectory({ entities: reachable?.entities ?? [], identityProjection: normalizeIdentityProjection(identityProjection ?? {}) });
  const entityById = new Map(directory.map(entry => [entry.entityId, entry]));
  const events = [], relations = [], discardedOrderRelations = [], danglingRelationIds = [], danglingContinuationIds = [], degradedFloorIds = new Set();
  const danglingRelations = [], danglingContinuations = [];
  const legacyReviewConflicts = [];
  const eventById = new Map();
  const eventMemoryFloorById = new Map();
  const relationById = new Map();
  const matterEvents = new Map();
  const sourceIndex = new Map();
  const memoryRows = activeMemories(reachable).map(({ floor, memory }) => ({ floor, memory, effective: effectiveQianshiDelta(memory) }));
  // Manual markers travel with their owning FloorMemory, so branch-prefix replay naturally restores the earlier state.
  const deletedEventIds = new Set(memoryRows.flatMap(({ memory }) => memory.qianshiDelta?.deletedEventIds ?? []));
  const trackingOverrides = new Map(memoryRows.flatMap(({ memory }) => memory.qianshiDelta?.trackingOverrides ?? [])
    .map(item => [item.matterId, item.following]));
  const manualMatterStatusOverrides = new Map(memoryRows.flatMap(({ memory }) => {
    const events = new Set((memory.qianshiDelta?.events ?? []).map(event => event.matterId).filter(Boolean));
    return (memory.qianshiDelta?.manualMatterStatusOverrides ?? []).filter(item => events.has(item.matterId));
  }).map(item => [item.matterId, item.status]));
  const addNode = (id, attributes) => { if (!graph.hasNode(id)) graph.addNode(id, attributes); };
  for (const { floor, memory, effective } of memoryRows) for (const conflict of effective.conflicts) {
    legacyReviewConflicts.push(frozen({ floorId: floor.id, memoryId: memory.id, ...conflict }));
  }
  const formalEventsById = new Map(memoryRows.flatMap(({ effective }) => effective.formalEvents.map(event => [event.id, event])));
  const eventEntries = [
    ...memoryRows.flatMap(row => row.effective.formalEvents.filter(event => !deletedEventIds.has(event.id)).map(event => ({ ...row, event, review: false }))),
    ...memoryRows.flatMap(row => row.effective.reviewEvents.filter(event => !deletedEventIds.has(event.id)).map(event => ({ ...row, event, review: true }))),
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
    const manualEventOverride = memory.qianshiDelta?.manualEventOverrides?.find(item => item.eventId === raw.id);
    if (manualEventOverride) {
      for (const key of ['title', 'description', 'object', 'status', 'actionStatus', 'storyTime']) if (Object.hasOwn(manualEventOverride, key)) {
        eventData[key] = manualEventOverride[key];
      }
      if (Object.hasOwn(manualEventOverride, 'status') || Object.hasOwn(manualEventOverride, 'actionStatus')) eventData.statusManuallyEdited = true;
      if (Object.hasOwn(manualEventOverride, 'storyTime')) eventData.timeManuallyEdited = true;
    }
    eventData.continuesFromEventIds = eventData.continuesFromEventIds.filter(id => !deletedEventIds.has(id));
    const sourceFloor = floorById.get(raw.sourceFloorId);
    const assistantSeq = aggregate ? sourceFloor?.assistantSeq ?? null : floor.assistantSeq;
    const event = frozen({ ...eventData, floorMemoryId: memory.id, assistantSeq,
      parsedStoryTime: sourceTimeFor(eventData, floorTimes.get(floor.id), { aggregate, calendar }) });
    if (eventById.has(event.id)) continue;
    sourceIndex.set(event.id, events.length);
    eventById.set(event.id, event); events.push(event);
    eventMemoryFloorById.set(event.id, memory.floorId);
    addNode(eventNode(event.id), { kind: 'event', value: event });
    progressGraph.addNode(eventNode(event.id), { value: event });
    const lineId = event.matterId ?? `legacy-singleton:${event.id}`;
    matterEvents.set(lineId, [...(matterEvents.get(lineId) ?? []), event]);
    addNode(matterNode(lineId), { kind: 'matter', matterId: lineId, synthetic: event.matterId === null });
    graph.addDirectedEdgeWithKey(`matter-progress:${lineId}:${event.id}`, matterNode(lineId), eventNode(event.id), { type: 'matterProgress' });
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
    ...memoryRows.flatMap(row => row.effective.formalRelations.filter(relation => !deletedEventIds.has(relation.fromEventId) && !deletedEventIds.has(relation.toEventId)).map(relation => ({ ...row, relation, review: false }))),
    ...memoryRows.flatMap(row => row.effective.reviewRelationEntries.filter(({ relation }) => !deletedEventIds.has(relation.fromEventId) && !deletedEventIds.has(relation.toEventId)).map(entry => ({ ...row, ...entry, review: true }))),
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
  const timeGroup = value => value?.calendar ? `calendar:${calendarKey(value.calendar)}:${value.year === null ? 'yearless' : 'dated'}` : Number.isInteger(value?.day) ? 'absolute'
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
    const sortableTime = value => Number.isInteger(value?.day) ? value.day : Number.isInteger(value?.calendarOrdinal) ? value.calendarOrdinal
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
    const { records, current } = deriveQianshiLine(values, sourceIndex);
    // 历史进展边只作证据；事项状态取最后一条有效接续记录（无接续时取最后记录），人工整线状态优先。
    const representative = current ?? records.at(-1);
    const origin = [...(advancing.length ? advancing : records)].sort((left, right) => left.assistantSeq - right.assistantSeq || left.id.localeCompare(right.id))[0];
    const synthetic = values.every(event => event.matterId === null);
    const trackingOverride = synthetic ? null : trackingOverrides.has(matterId) ? trackingOverrides.get(matterId) : null;
    const manualStatusOverride = synthetic ? null : manualMatterStatusOverrides.get(matterId) ?? null;
    const currentStatus = manualStatusOverride ?? current?.status ?? representative.status;
    const following = current ? ((manualStatusOverride && TERMINAL_STATUSES.has(manualStatusOverride)
      || current.statusManuallyEdited && TERMINAL_STATUSES.has(current.status))
      ? false : trackingOverride ?? !TERMINAL_STATUSES.has(currentStatus)) : false;
    matterDtos.push(frozen({ matterId, synthetic, title: representative.title, object: representative.object, status: currentStatus,
      manualStatusOverride, currentStatusManuallyEdited: Boolean(current?.statusManuallyEdited), currentEventId: current?.id ?? null, trackingOverride, following,
      people: frozen(representative.people.map(person => frozen({ ...person }))), latestEventIds: frozen(current ? [current.id] : []),
      recordIds: frozen(records.map(event => event.id)), eventIds: frozen(records.map(event => event.id)),
      sourceFloorId: representative.sourceFloorId, sourceAssistantSeq: representative.assistantSeq,
      storyTime: representative.storyTime, scheduledTime: representative.scheduledTime, description: representative.description,
      origin: frozen({ eventId: origin.id, title: origin.title, description: origin.description, storyTime: origin.storyTime, scheduledTime: origin.scheduledTime,
        sourceFloorId: origin.sourceFloorId, sourceAssistantSeq: origin.assistantSeq }) }));
  }
  matterDtos.sort((left, right) => Number(!left.following) - Number(!right.following)
    || Number(TERMINAL_STATUSES.has(left.status)) - Number(TERMINAL_STATUSES.has(right.status))
    || right.sourceAssistantSeq - left.sourceAssistantSeq || left.matterId.localeCompare(right.matterId));
  const progressLines = [], progressEventIds = [], progressMatterIds = [];
  for (const matter of matterDtos) {
    if (!matter.following) continue;
    const marker = matter.status === 'completed' && matter.trackingOverride === true ? '已完成，仍关注'
      : TERMINAL_STATUSES.has(matter.status) ? '刚完成' : matter.status === 'planned' ? '待办' : '进行中';
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
    deletedEvents: frozen(qianshiDeletedEvents(reachable).map(frozen)),
    sourceOrderByEventId: frozen(Object.fromEntries(sourceIndex)),
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
  const calendar = event.parsedStoryTime?.calendar ?? null;
  const time = ranged ? rangeSeparator && rangeStart ? projectQianshiTime(rangeStart, null, calendar) : null
      : relative && !event.parsedStoryTime?.date ? null
      : relative ? event.parsedStoryTime : sortableRaw ? projectQianshiTime(sortableRaw, null, calendar) : event.parsedStoryTime;
  const kind = time?.calendar ? `calendar:${calendarKey(time.calendar)}:${time.year === null ? 'yearless' : 'dated'}` : time?.monthIdentity ? `special:${time.monthIdentity}`
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
  else if (Number.isInteger(time?.year) && Number.isInteger(time?.month)) period = `${time.calendar?.prefix ?? ''}${time.year}年${time.month}月`;
  else if (Number.isInteger(time?.month)) period = `${time.calendar?.prefix ?? ''}${time.month}月`;
  return { day, period, full };
}

function timelineSegmentLabel(segment, groups) {
  if (segment.id === 'dated') return '完整日期';
  if (segment.id === 'month-day') return '仅月日';
  if (segment.id.startsWith('calendar:')) return segment.yearless ? '仅月日' : '完整日期';
  return clean(groups[0]?.period, 120) || '时间未明确';
}

/** Full-page projection: one parsed key per event, with no pairwise event comparison. */
export function projectQianshiTimeline(projection) {
  const events = Array.isArray(projection?.events) ? projection.events : [];
  const views = new Map(events.map(event => [event.id, recallTimelineTime(event)]));
  const segmentFor = view => {
    const tuple = timelineDateTuple(view);
    if (!tuple) return null;
    // 固定历法的年序不能与未经用户确认的其他纪年/公历混为同一时间轴。
    if (view.time?.calendar) return view.kind;
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
        yearless: view.time?.year === null && !view.time?.monthIdentity,
        hasFirstMonth: false, hasLastMonth: false, groups: new Map() };
      segments.set(segmentId, segment);
    } else if (Number.isInteger(view.time?.year)) segment.hasKnownYear = true;
    if (segment.yearless) {
      segment.hasFirstMonth ||= view.time.month === 1;
      segment.hasLastMonth ||= view.time.month === (view.time.calendar?.months ?? 12);
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
    const preserveSourceOrder = segment.yearless && segment.hasFirstMonth && segment.hasLastMonth;
    const groups = [...segment.groups.values()].sort((left, right) => preserveSourceOrder
      ? left.firstIndex - right.firstIndex : compareTuple(left.tuple, right.tuple) || left.firstIndex - right.firstIndex);
    const latest = preserveSourceOrder ? null : groups.at(-1);
    const label = timelineSegmentLabel(segment, groups);
    return frozen({ id: segment.id, label, groups: frozen(groups.map(group => frozen({ id: group.id, key: JSON.stringify(group.tuple), day: group.day,
      period: group.period, full: group.full,
      eventIds: frozen([...group.eventIds]) }))), latestGroupId: latest?.id ?? null });
  });
  const onlySegment = segments.size === 1 ? [...segments.values()][0] : null;
  const yearlessBoundaryAmbiguous = onlySegment?.yearless && onlySegment.hasFirstMonth && onlySegment.hasLastMonth;
  const hasGlobalLatest = resultSegments.length === 1 && undatedEventIds.length === 0 && !yearlessBoundaryAmbiguous;
  return frozen({ segments: frozen(resultSegments), undatedEventIds: frozen(undatedEventIds), hasGlobalLatest,
    globalLatestGroupId: hasGlobalLatest ? resultSegments[0].latestGroupId : null });
}

function recallSelection(projection, queryContext) {
  const eventById = new Map(projection.events.map(event => [event.id, event]));
  const documents = [
    ...projection.matters.filter(matter => !matter.synthetic).map(matter => ({ id: `matter:${matter.matterId}`, text: relevanceText(matter) })),
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
  const matterScores = projection.matters.filter(matter => !matter.synthetic).map(matter => {
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
  const pending = matterScores.filter(({ matter }) => matter.following && ['planned', 'inProgress', 'completed'].includes(matter.status))
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
  line: `- ${matter.title}${matter.object ? `（${matter.object}）` : ''}${matter.scheduledTime ? `；约定：${matter.scheduledTime}` : ''}；${matter.status === 'completed' ? '已记录完成，当前仍继续关注后续变化。' : '尚未记录完成。'}` });

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
  const pendingRows = [...new Set(matterIds ?? [])].map(id => matters.get(id)).filter(matter => matter?.following && ['planned', 'inProgress', 'completed'].includes(matter.status)).map(pendingRecallRow);
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
  const matters = prepareQianshiCandidatesFromMatters(projection.matters.filter(matter => !matter.synthetic && matter.currentEventId), { canonicalContent, precedingUserInput, characterBudget });
  if (!includeEventContextCandidates) return matters;
  const query = clean([canonicalContent, ...(precedingUserInput?.messages ?? []).map(message => message.content)].join(' '), 24000);
  if (!query || matters.stats.characters >= characterBudget) return matters;
  const eventCandidates = projection.events.filter(event => event.matterId === null || event.updatesMatter === false);
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
  matters = matters.filter(hasTrackableCurrent);
  const query = clean([canonicalContent, ...(precedingUserInput?.messages ?? []).map(message => message.content)].join(' '), 24000);
  const normalizedQuery = query.toLocaleLowerCase('zh-CN');
  // Following is an attention choice; it cannot reopen a line the user explicitly closed.
  const manuallyClosed = matter => Boolean((matter.manualStatusOverride && TERMINAL_STATUSES.has(matter.manualStatusOverride))
    || (matter.currentStatusManuallyEdited && TERMINAL_STATUSES.has(matter.status)));
  const documents = matters.filter(matter => !manuallyClosed(matter) && (matter.following === true || !TERMINAL_STATUSES.has(matter.status)))
    .map(matter => ({ id: matter.matterId, text: relevanceText(matter) }));
  const ranked = new Map(rankRecallDocuments({ documents, queries: [{ key: 'targetFloor', text: query, weight: 1 }] }).map(item => [item.id, item]));
  const scored = matters.map(matter => {
    const rank = ranked.get(matter.matterId);
    const unfinished = matter.following === true || !TERMINAL_STATUSES.has(matter.status);
    if (matter.trackingOverride === false) return { matter, relevant: false, score: 0 };
    const title = clean(matter.title, 500).toLocaleLowerCase('zh-CN');
    const object = clean(matter.object, 1000).toLocaleLowerCase('zh-CN');
    const terminalReopen = !manuallyClosed(matter) && (terminalMatterIds ? terminalMatterIds.has(matter.matterId)
      : Boolean(normalizedQuery && (title && normalizedQuery.includes(title) || object.length >= 2 && normalizedQuery.includes(object))));
    return { matter, relevant: unfinished ? (rank?.branchMatchCounts?.targetFloor ?? 0) > 0 : terminalReopen,
      score: Number(unfinished) * 100000 + (rank?.score ?? 0) * 10000 + matter.sourceAssistantSeq };
  }).filter(item => item.matter.trackingOverride !== false && !manuallyClosed(item.matter)
    && (!TERMINAL_STATUSES.has(item.matter.status) || item.relevant))
    .sort((left, right) => right.score - left.score || left.matter.matterId.localeCompare(right.matter.matterId));
  const request = [], bindings = [], lines = [];
  for (const { matter } of scored) {
    const key = `candidate-${request.length + 1}`;
    const value = { key, candidateType: 'matter', title: matter.title, status: matter.status,
      ...(matter.trackingOverride === true ? { tracking: 'following' } : {}), people: matter.people.map(person => person.name), object: matter.object,
      origin: { title: matter.origin.title, description: matter.origin.description, storyTime: matter.origin.storyTime,
        scheduledTime: matter.origin.scheduledTime, sourceAssistantSeq: matter.origin.sourceAssistantSeq },
      latestProgress: { title: matter.title, description: matter.description, storyTime: matter.storyTime,
        scheduledTime: matter.scheduledTime, sourceAssistantSeq: matter.sourceAssistantSeq } };
    const line = JSON.stringify(value);
    if (lines.join('\n').length + line.length > Math.max(0, characterBudget)) continue;
    request.push(frozen(value)); lines.push(line);
    bindings.push(frozen({ key, kind: 'matter', matterId: matter.matterId, originEventId: matter.origin.eventId,
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
    recordIds: [...(matter.recordIds ?? matter.eventIds ?? [])], eventIds: [...(matter.recordIds ?? matter.eventIds ?? [])], origin: { ...matter.origin } });
  const terminalPhrases = matter => [...new Set([clean(matter.title, 500).toLocaleLowerCase('zh-CN'), clean(matter.object, 1000).toLocaleLowerCase('zh-CN')]
    .filter((phrase, index) => phrase && (index === 0 || phrase.length >= 2)))];
  function updateTerminalIndex(state, matterId, prior, next) {
    if (prior && TERMINAL_STATUSES.has(prior.status)) for (const phrase of state.terminalPhrasesByMatter.get(matterId) ?? []) {
      const postings = phrase.length === 1 ? state.terminalSingleChar : state.terminalBigrams;
      const grams = phrase.length === 1 ? [phrase] : [...new Set(Array.from({ length: phrase.length - 1 }, (_, index) => phrase.slice(index, index + 2)))];
      for (const gram of grams) { const ids = postings.get(gram); ids?.delete(matterId); if (!ids?.size) postings.delete(gram); }
      state.terminalPhrasesByMatter.delete(matterId);
    }
    if (hasTrackableCurrent(next) && TERMINAL_STATUSES.has(next.status) && next.trackingOverride !== false
      && !(next.manualStatusOverride && TERMINAL_STATUSES.has(next.manualStatusOverride))
      && !(next.currentStatusManuallyEdited && TERMINAL_STATUSES.has(next.status))) {
      const phrases = terminalPhrases(next);
      state.terminalPhrasesByMatter.set(matterId, phrases);
      for (const phrase of phrases) {
        const postings = phrase.length === 1 ? state.terminalSingleChar : state.terminalBigrams;
        const grams = phrase.length === 1 ? [phrase] : [...new Set(Array.from({ length: phrase.length - 1 }, (_, index) => phrase.slice(index, index + 2)))];
        for (const gram of grams) postings.set(gram, new Set([...(postings.get(gram) ?? []), matterId]));
      }
    }
  }
  const addLineRecord = (matter, event) => {
    const recordIds = [...new Set([...(matter?.recordIds ?? matter?.eventIds ?? []), event.id])];
    const next = { ...matter, recordIds, eventIds: recordIds };
    return next;
  };
  function appendDelta(state, floor, memory, floorSeq, floorTimes) {
    const delta = memory?.qianshiDelta;
    // 有删除标记时回建统一完整投影，避免另算删除后接续而造成热/冷候选差异。
    if (delta?.deletedEventIds?.length) return false;
    const effective = effectiveQianshiDelta(memory);
    if (effective.reviewEvents.length || effective.reviewRelations.length) return false;
    if (!delta || !['ready', 'partial'].includes(delta.status)) return true;
    const aggregate = (memory.sourceFloorIds ?? [memory.floorId]).length > 1;
    const affected = new Set();
    for (const event of effective.events) {
      if (state.events.has(event.id)) continue;
      const assistantSeq = aggregate ? floorSeq.get(event.sourceFloorId) ?? null : floor.assistantSeq;
      const manualEventOverride = delta.manualEventOverrides?.find(item => item.eventId === event.id);
      const projectedEvent = { ...event, ...(manualEventOverride ? Object.fromEntries(
        ['title', 'description', 'object', 'status', 'actionStatus', 'storyTime'].filter(key => Object.hasOwn(manualEventOverride, key)).map(key => [key, manualEventOverride[key]])) : {}),
        ...(manualEventOverride && (Object.hasOwn(manualEventOverride, 'status') || Object.hasOwn(manualEventOverride, 'actionStatus')) ? { statusManuallyEdited: true } : {}),
        ...(manualEventOverride && Object.hasOwn(manualEventOverride, 'storyTime') ? { timeManuallyEdited: true } : {}), assistantSeq };
      projectedEvent.parsedStoryTime = sourceTimeFor(projectedEvent, floorTimes.get(floor.id), { aggregate });
      state.events.set(event.id, projectedEvent);
      state.sourceOrder.set(event.id, state.nextSourceOrder++);
      if (!event.matterId) continue;
      state.eventsByMatter.set(event.matterId, [...(state.eventsByMatter.get(event.matterId) ?? []), projectedEvent]);
      const prior = state.matters.get(event.matterId);
      const current = prior ?? { matterId: event.matterId, origin: { eventId: event.id, title: event.title, description: event.description,
        storyTime: projectedEvent.storyTime, scheduledTime: event.scheduledTime, sourceFloorId: event.sourceFloorId, sourceAssistantSeq: assistantSeq },
        title: event.title, object: event.object, status: event.status, currentEventId: null, people: [], latestEventIds: [], recordIds: [], eventIds: [], _frontier: [] };
      if (!prior) current.manualStatusOverride = delta.manualMatterStatusOverrides?.find(item => item.matterId === event.matterId)?.status ?? null;
      state.matters.set(event.matterId, addLineRecord(current, projectedEvent));
      affected.add(event.matterId);
    }
    for (const relation of effective.relations) {
      const prior = state.relations.get(relation.id);
      if (prior && (prior.type !== relation.type || prior.fromEventId !== relation.fromEventId || prior.toEventId !== relation.toEventId)) return false;
      state.relations.set(relation.id, relation);
      const from = state.events.get(relation.fromEventId), to = state.events.get(relation.toEventId);
      if (relation.type !== 'progress' || !from || !to || !from.matterId || from.matterId !== to.matterId || !to.updatesMatter) continue;
      if (state.matters.has(to.matterId)) affected.add(to.matterId);
    }
    for (const matterId of affected) {
      const prior = state.matters.get(matterId);
      const lineEvents = state.eventsByMatter.get(matterId) ?? [];
      const { records, current } = deriveQianshiLine(lineEvents, state.sourceOrder);
      const representative = current ?? records.at(-1);
      if (!representative) continue;
      const manualStatusOverride = prior.manualStatusOverride ?? null;
      const status = manualStatusOverride ?? current?.status ?? representative.status;
      const currentStatusManuallyEdited = Boolean(current?.statusManuallyEdited);
      const next = { ...prior, currentEventId: current?.id ?? null, latestEventIds: current ? [current.id] : [],
        _frontier: current ? [{ id: current.id, assistantSeq: current.assistantSeq }] : [],
        title: representative.title, object: representative.object, status, manualStatusOverride, currentStatusManuallyEdited,
        following: current ? ((currentStatusManuallyEdited && TERMINAL_STATUSES.has(status)
          || manualStatusOverride && TERMINAL_STATUSES.has(manualStatusOverride)) ? false : prior.trackingOverride ?? !TERMINAL_STATUSES.has(status)) : false,
        people: (representative.people ?? []).map(person => ({ ...person })), sourceFloorId: representative.sourceFloorId,
        sourceAssistantSeq: representative.assistantSeq, storyTime: representative.storyTime, scheduledTime: representative.scheduledTime,
        description: representative.description, recordIds: records.map(event => event.id), eventIds: records.map(event => event.id) };
      updateTerminalIndex(state, matterId, prior, next);
      if (!hasTrackableCurrent(prior) || !TERMINAL_STATUSES.has(prior.status) || prior.trackingOverride === true) state.activeMatterIds.delete(matterId);
      if (hasTrackableCurrent(next) && (!TERMINAL_STATUSES.has(next.status) || next.trackingOverride === true)
        && !(next.currentStatusManuallyEdited && TERMINAL_STATUSES.has(next.status))
        && !(manualStatusOverride && TERMINAL_STATUSES.has(manualStatusOverride))) state.activeMatterIds.add(matterId);
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
        const sourceOrder = new Map(Object.entries(projection.sourceOrderByEventId ?? Object.fromEntries([...events.keys()].map((id, index) => [id, index])))
          .map(([id, index]) => [id, Number(index)]));
        const eventsByMatter = new Map();
        for (const event of events.values()) if (event.matterId) eventsByMatter.set(event.matterId, [...(eventsByMatter.get(event.matterId) ?? []), event]);
        const matters = new Map(projection.matters.map(matter => [matter.matterId, { ...matterCopy(matter),
          _frontier: matter.latestEventIds.map(id => ({ id, assistantSeq: events.get(id)?.assistantSeq ?? matter.sourceAssistantSeq })) }]));
        snapshot = { chatId: root.chatId, generation: root.narrativeGeneration, identityKey: identityKey(options), keys,
          events, relations: new Map(projection.relations.map(relation => [relation.id, relation])), matters, activeMatterIds: new Set(),
          eventsByMatter, sourceOrder, nextSourceOrder: [...sourceOrder.values()].reduce((maximum, value) => Math.max(maximum, value + 1), 0),
          terminalBigrams: new Map(), terminalSingleChar: new Map(), terminalPhrasesByMatter: new Map() };
        for (const matter of matters.values()) {
          if (TERMINAL_STATUSES.has(matter.status) && matter.trackingOverride !== false) updateTerminalIndex(snapshot, matter.matterId, null, matter);
          if (hasTrackableCurrent(matter) && (!TERMINAL_STATUSES.has(matter.status) || matter.trackingOverride === true)
            && !(matter.manualStatusOverride && TERMINAL_STATUSES.has(matter.manualStatusOverride))
            && !(matter.currentStatusManuallyEdited && TERMINAL_STATUSES.has(matter.status))) snapshot.activeMatterIds.add(matter.matterId);
        }
      } else if (keys.length > snapshot.keys.length) {
        const memoryById = new Map((reachable.floorMemories ?? []).map(memory => [memory.id, memory]));
        const floorSeq = new Map((reachable.floors ?? []).map(item => [item.id, item.assistantSeq]));
        const floorTimes = storyTimes(reachable.floorMemories ?? [], reachable.floors ?? []);
        for (let index = snapshot.keys.length; index < keys.length; index += 1) {
          const [floorId, memoryId, ambiguousIds] = keys[index];
          const floor = reachable.floors[index];
          if (ambiguousIds) {
            snapshot = null;
            return this.prepare(reachable, options);
          }
          if (memoryId && !appendDelta(snapshot, floor, memoryById.get(memoryId), floorSeq, floorTimes)) {
            snapshot = null;
            return this.prepare(reachable, options);
          }
        }
        snapshot.keys = keys;
      }
      const query = qianshiCandidateQuery(options.canonicalContent, options.precedingUserInput);
      const reopened = matchingTerminalMatterIds(snapshot, query);
      const matters = [...snapshot.activeMatterIds].map(id => snapshot.matters.get(id)).filter(Boolean);
      for (const matter of snapshot.matters.values()) if (matter.trackingOverride === true && !matters.some(item => item.matterId === matter.matterId)
        && !(matter.manualStatusOverride && TERMINAL_STATUSES.has(matter.manualStatusOverride))) matters.push(matter);
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

// 所有入口先把模型的常见字段别名转成同一份关联格式，再校验候选身份。
// 未知类型和未知引用保留给编译器报错，不能丢掉后当成“没有关联”。
export function normalizeQianshiEventLinks(event) {
  const links = list(event?.links).map(link => ({
    candidateKey: keyText(typeof link === 'string' ? link
      : link?.candidateKey ?? link?.candidate ?? link?.targetKey ?? link?.target ?? link?.to),
    kind: keyText(link?.kind ?? link?.type).toLowerCase() || 'progress',
  }));
  if (!links.length) for (const candidateKey of list(event?.continues ?? event?.continuesCandidates ?? event?.relatedCandidates).map(keyText).filter(Boolean)) {
    links.push({ candidateKey, kind: 'progress' });
  }
  return links;
}

export async function compileQianshiDelta({ packet, floor, sourceFloorBindings = [], candidateBindings = [], candidateStats = null, entities = [], identityProjection = null, compiledBindings = null, recordBindings = null, compilationIssues = null, now = new Date().toISOString() } = {}) {
  const stats = { count: Number(candidateStats?.count) || 0, characters: Number(candidateStats?.characters) || 0 };
  const sourceByKey = new Map(sourceFloorBindings.map(item => [item.floorKey, item.floorId]));
  const sourceFloorIds = sourceByKey.size ? [...sourceByKey.values()] : [floor.id];
  const pending = reason => validateQianshiDelta({ schemaVersion: QIANSHI_SCHEMA_VERSION, status: 'pending', reason: clean(reason, 500) || '千事字段待补。', compiledAt: now,
    candidateStats: stats, events: [], relations: [] }, { floorIds: sourceFloorIds });
  const qianshi = packetQianshi(packet);
  if (qianshi === undefined) return pending('本次返回未包含千事字段。');
  if (!qianshi || typeof qianshi !== 'object' || Array.isArray(qianshi) || !Array.isArray(qianshi.events)) return pending('千事字段整体格式无效。');
  const candidateByKey = new Map(candidateBindings.map(item => [item.key, item]));
  const recordBindingByKey = new Map((recordBindings ?? []).map(item => [item.key, item]));
  const local = new Map();
  const events = [], relations = [], issues = [];
  // 只读编译回执供重判区分“旧条目引用错误”和不可校验的整份返回，不依赖中文错误文案。
  const addIssue = (index, code, message) => {
    issues.push(message);
    if (Array.isArray(compilationIssues)) compilationIssues.push({ index, code });
  };
  const resolvePerson = personDirectory(entities, identityProjection);
  const eventCompileIssue = (index, error) => {
    const number = index + 1;
    if (error?.code === 'QIANSHI_EVENT_KEY_DUPLICATE') return `第 ${number} 件事件的内部标识与前面重复，未保存。`;
    if (error?.code === 'QIANSHI_EVENT_SOURCE_FLOOR_INVALID') return `第 ${number} 件事件无法对应到原文楼层，未保存。`;
    if (error?.code === 'QIANSHI_EVENT_RECORD_KEY_INVALID') return `第 ${number} 件事件引用了无法对应的旧记录编号，未保存。`;
    if (error?.code === 'QIANSHI_EVENT_STATUS_INVALID') return `第 ${number} 件事件的整线或动作状态无法识别，未保存。`;
    if (error?.code === 'QIANSHI_EVENT_INVALID') return `第 ${number} 件事件缺少有效标题或说明，未保存。`;
    return `第 ${number} 件事件未能完成本地整理，原条目未保存。`;
  };
  for (const [index, raw] of qianshi.events.slice(0, 160).entries()) {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw qianshiError('QIANSHI_EVENT_INVALID', `events[${index}]`);
      const title = clean(raw.title ?? raw.name, 500), description = clean(raw.description ?? raw.summary ?? raw.content, 4000);
      if (!title || !description) throw qianshiError('QIANSHI_EVENT_INVALID', `events[${index}]`);
      const localKey = keyText(raw.key) || `event-${index + 1}`;
      if (recordBindings && /^record-/u.test(localKey) && !recordBindingByKey.has(localKey)) throw qianshiError('QIANSHI_EVENT_RECORD_KEY_INVALID', `events[${index}].key`);
      if (local.has(localKey)) throw qianshiError('QIANSHI_EVENT_KEY_DUPLICATE', `events[${index}].key`);
      const sourceFloorId = sourceByKey.size > 1 ? sourceByKey.get(keyText(raw.sourceFloorKey)) : floor.id;
      if (!sourceFloorId) throw qianshiError('QIANSHI_EVENT_SOURCE_FLOOR_INVALID', `events[${index}].sourceFloorKey`);
      // Only omitted legacy status fields default; an explicit unrecognized value rejects this event alone.
      const hasLineStatus = Object.hasOwn(raw, 'lineStatus'), hasStatus = Object.hasOwn(raw, 'status'), hasActionStatus = Object.hasOwn(raw, 'actionStatus');
      const parsedLineStatus = normalizeModelStatus(raw.lineStatus), parsedStatus = normalizeModelStatus(raw.status), parsedActionStatus = normalizeModelStatus(raw.actionStatus);
      const lineStatus = hasLineStatus ? parsedLineStatus : hasStatus ? parsedStatus : 'occurred';
      const actionStatus = hasActionStatus ? parsedActionStatus : hasLineStatus && hasStatus ? parsedStatus : null;
      if (!lineStatus || hasStatus && !parsedStatus || hasActionStatus && !parsedActionStatus) {
        throw qianshiError('QIANSHI_EVENT_STATUS_INVALID', `events[${index}].status`);
      }
      const rawLinks = normalizeQianshiEventLinks(raw);
      if (rawLinks.some(link => !['progress', 'context'].includes(link.kind))) {
        addIssue(index, 'QIANSHI_EVENT_LINK_KIND_INVALID', `第 ${index + 1} 件事件的关联类型无法识别，本条未保存。`);
        continue;
      }
      const resolvedLinks = rawLinks.map(link => ({ ...link, candidate: candidateByKey.get(link.candidateKey) })).filter(link => link.candidate);
      const invalidReference = rawLinks.length !== resolvedLinks.length;
      const matterIds = [...new Set(resolvedLinks.map(item => item.candidate.matterId))];
      if (invalidReference || matterIds.length > 1) {
        addIssue(index, 'QIANSHI_EVENT_REFERENCE_INVALID', `第 ${index + 1} 件事件引用了不存在或互相冲突的旧事项，本条未保存。`);
        continue;
      }
      const id = await deterministicUuid(['qianshi-event-v1', sourceFloorId, localKey, title, description, lineStatus]);
      // recordBindings is supplied only by the trusted stored-event rejudge path; ordinary extraction still derives new IDs.
      const recordBinding = recordBindingByKey.get(localKey) ?? null;
      const storyTime = clean(raw.storyTime ?? raw.occurredAt, 500) || null;
      const link = resolvedLinks.find(item => item.kind === 'progress') ?? resolvedLinks[0] ?? null;
      const invalidProgress = link?.kind === 'progress' && (!link.candidate.matterId || link.candidate.kind === 'event');
      if (invalidProgress) {
        addIssue(index, 'QIANSHI_EVENT_PROGRESS_TARGET_INVALID', `第 ${index + 1} 件事件把一次性记录当作持续事项接续，本条未保存。`);
        continue;
      }
      const updatesMatter = link ? link.kind === 'progress' : raw.matter === false ? false : raw.matter === true || ['planned', 'inProgress'].includes(lineStatus);
      const eventId = recordBinding?.event?.id ?? id;
      const matterId = link?.kind === 'context' && link.candidate.kind === 'event' ? null : link ? link.candidate.matterId
        : recordBinding && raw.matter !== true ? null : recordBinding?.preserveMatterIdOnNewLine ? recordBinding.event.matterId
          : await deterministicUuid([recordBinding ? 'qianshi-matter-rejudge-v1' : 'qianshi-matter-v1', eventId,
            recordBinding ? localKey : clean(raw.object, 1000), title]);
      const people = [...new Set(list(raw.people ?? raw.participants).map(value => clean(typeof value === 'string' ? value : value?.name, 500)).filter(Boolean))]
        .map(name => ({ entityId: resolvePerson(name), name }));
      const event = { id: eventId, matterId, updatesMatter, title, description, status: lineStatus, ...(actionStatus ? { actionStatus } : {}), storyTime,
        scheduledTime: clean(raw.scheduledTime ?? raw.expectedAt ?? raw.dueTime, 500) || null, people, object: clean(raw.object ?? raw.subject, 1000) || null,
        sourceFloorId, continuesFromEventIds: [...new Set((link?.candidate.latestEventIds ?? []).slice(0, 1))] };
      events.push(event); local.set(localKey, event);
      if (Array.isArray(compiledBindings)) compiledBindings.push(Object.freeze({ localKey, event: Object.freeze({ ...event }) }));
      if (updatesMatter && link?.kind === 'progress') for (const priorEventId of event.continuesFromEventIds) relations.push({ id: await deterministicUuid(['qianshi-relation-v1', 'progress', priorEventId, eventId]), type: 'progress', fromEventId: priorEventId, toEventId: eventId, certainty: 'explicit' });
    } catch (error) {
      addIssue(index, error?.code ?? 'QIANSHI_EVENT_INVALID', eventCompileIssue(index, error));
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
  const status = events.length ? issues.length ? 'partial' : 'ready' : qianshi.events.length === 0 ? 'empty' : 'pending';
  const reason = issues.length ? clean(`${issues.length} 项未能编译：${issues.slice(0, 3).join('；')}`, 500) : null;
  return validateQianshiDelta({ schemaVersion: QIANSHI_SCHEMA_VERSION, status, reason, compiledAt: now, candidateStats: stats, events, relations: dedupedRelations }, { floorIds: sourceFloorIds });
}

export function pendingQianshiDelta(previous, reason, now = new Date().toISOString()) {
  return validateQianshiDelta({ schemaVersion: QIANSHI_SCHEMA_VERSION, status: 'pending', reason: clean(reason, 500) || '千事字段待补。', compiledAt: now,
    candidateStats: { count: Number(previous?.candidateStats?.count) || 0, characters: Number(previous?.candidateStats?.characters) || 0 }, events: [], relations: [] });
}

export function publicQianshiSnapshot(reachable, history = null, identityProjection = null, calendar = null) {
  const projection = projectQianshiGraph(reachable, { identityProjection, calendar });
  const floorById = new Map((reachable?.floors ?? []).map(floor => [floor.id, floor]));
  const publicEvent = event => ({ id: event.id, matterId: event.matterId, title: event.title, description: event.description, status: event.status,
    actionStatus: event.actionStatus ?? null, statusManuallyEdited: event.statusManuallyEdited === true,
    timeManuallyEdited: event.timeManuallyEdited === true,
    updatesMatter: event.updatesMatter, storyTime: event.storyTime, scheduledTime: event.scheduledTime, people: event.people.map(person => ({ ...person })), object: event.object,
    sourceFloorId: event.sourceFloorId, sourceFloorMemoryId: event.floorMemoryId, sourceAssistantSeq: event.assistantSeq,
    sourceMessageIndex: floorById.get(event.sourceFloorId)?.hostLocator?.messageIndex ?? null });
  // 异常楼来自同一投影诊断，映射当前宿主楼号；不另存状态，也不把断链事件排除出年表。
  const anomalyFloors = projection.diagnostics.degradedFloorIds.map(floorId => {
    const floor = floorById.get(floorId);
    const continuations = projection.diagnostics.danglingContinuations.filter(item => item.memoryFloorId === floorId);
    const relations = projection.diagnostics.danglingRelations.filter(item => item.floorId === floorId);
    const eventIds = [...new Set([...continuations.map(item => item.eventId), ...relations.flatMap(item => [item.fromEventId, item.toEventId])])]
      .filter(id => projection.events.some(event => event.id === id));
    const reasons = [...new Set([...continuations.map(() => '找不到前序事件'),
      ...relations.map(item => item.reason === 'invalid-progress' ? '进展关联的事项身份不一致' : '关联的一端事件不存在')])];
    return { floorId, messageIndex: floor?.hostLocator?.messageIndex ?? null, assistantSeq: floor?.assistantSeq ?? null, eventIds, reasons };
  });
  return structuredClone({ status: 'ready', identity: { qqjChatId: reachable.root.chatId }, anchor: { narrativeGeneration: reachable.root.narrativeGeneration, headCheckpointId: reachable.root.headCheckpointId, rootRevision: reachable.rootRevision },
    coverage: projection.coverage, events: projection.events.map(publicEvent), matters: projection.matters, relations: projection.relations,
    timeline: projectQianshiTimeline(projection), currentProgress: projection.currentProgress,
    history: history ?? { status: 'idle', jobId: null, processedFloors: 0, totalFloors: 0, calls: 0, message: '' }, diagnostics: { ...projection.diagnostics, anomalyFloors } });
}
