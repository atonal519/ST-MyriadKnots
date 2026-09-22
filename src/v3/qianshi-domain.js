import { MultiDirectedGraph, DirectedGraph } from 'graphology';
import { topologicalSort, willCreateCycle } from 'graphology-dag';
import { bfsFromNode } from 'graphology-traversal';
import { deterministicUuid } from './foundation-domain.js';
import { projectTime, storyTimes, timeDistance, timeHours } from './time-engine.js';
import { buildEntityIdentityDirectory, normalizeIdentityProjection } from './entity-identity.js';
import { rankRecallDocuments, tokenizeRecallText } from './recall-ranking.js';
import { QIANSHI_SCHEMA_VERSION, validateQianshiDelta } from './qianshi-schema.js';

export const QIANSHI_CANDIDATE_CHARACTER_BUDGET = 24000;
export const QIANSHI_PROGRESS_CHARACTER_BUDGET = 3200;
export const QIANSHI_HISTORY_INPUT_TOKENS = 70000;
export const QIANSHI_HISTORY_OUTPUT_TOKENS = 30000;
export const QIANSHI_RECALL_PROJECTION_VERSION = 2;

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

const nodeId = (kind, id) => `${kind}:${id}`;
const eventNode = id => nodeId('event', id);
const matterNode = id => nodeId('matter', id);
const personNode = id => nodeId('person', id);

function sourceTimeFor(event, floorTime) {
  if (!event.storyTime) return floorTime ?? projectTime('');
  return projectTime(event.storyTime, floorTime ?? null);
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
  const floorSeq = new Map(floors.map(floor => [floor.id, floor.assistantSeq]));
  const floorTimes = storyTimes((reachable?.floorMemories ?? []), floors);
  const directory = buildEntityIdentityDirectory({ entities: reachable?.entities ?? [], identityProjection: normalizeIdentityProjection(identityProjection ?? {}) });
  const entityById = new Map(directory.map(entry => [entry.entityId, entry]));
  const events = [], relations = [], discardedOrderRelations = [], danglingRelationIds = [], danglingContinuationIds = [], degradedFloorIds = new Set();
  const eventById = new Map();
  const matterEvents = new Map();
  const addNode = (id, attributes) => { if (!graph.hasNode(id)) graph.addNode(id, attributes); };
  for (const { floor, memory } of activeMemories(reachable)) {
    const delta = memory.qianshiDelta;
    if (!delta || !['ready', 'partial'].includes(delta.status)) continue;
    for (const raw of delta.events) {
      const event = frozen({ ...structuredClone(raw), floorMemoryId: memory.id, assistantSeq: floor.assistantSeq, parsedStoryTime: sourceTimeFor(raw, floorTimes.get(floor.id)) });
      if (eventById.has(event.id)) continue;
      eventById.set(event.id, event); events.push(event);
      addNode(eventNode(event.id), { kind: 'event', value: event });
      progressGraph.addNode(eventNode(event.id), { value: event });
      if (event.matterId !== null) {
        matterEvents.set(event.matterId, [...(matterEvents.get(event.matterId) ?? []), event]);
        addNode(matterNode(event.matterId), { kind: 'matter', matterId: event.matterId });
        graph.addDirectedEdgeWithKey(`matter-progress:${event.matterId}:${event.id}`, matterNode(event.matterId), eventNode(event.id), { type: 'matterProgress' });
      }
      for (const person of event.people) {
        const stable = person.entityId ?? `label:${person.name}`;
        addNode(personNode(stable), { kind: 'person', entityId: person.entityId, name: entityById.get(person.entityId)?.displayName ?? person.name });
        graph.addDirectedEdgeWithKey(`participates:${stable}:${event.id}`, personNode(stable), eventNode(event.id), { type: 'participates' });
      }
      orderGraph.addNode(eventNode(event.id), { value: event });
      for (const sourceId of event.continuesFromEventIds) if (!eventById.has(sourceId)) {
        danglingContinuationIds.push(`${event.id}:${sourceId}`); degradedFloorIds.add(event.sourceFloorId);
      }
    }
  }
  for (const { memory } of activeMemories(reachable)) {
    const delta = memory.qianshiDelta;
    if (!delta || !['ready', 'partial'].includes(delta.status)) continue;
    for (const relation of delta.relations) {
      if (!eventById.has(relation.fromEventId) || !eventById.has(relation.toEventId)) {
        danglingRelationIds.push(relation.id); degradedFloorIds.add(memory.floorId); continue;
      }
      const fromEvent = eventById.get(relation.fromEventId), toEvent = eventById.get(relation.toEventId);
      if (relation.type === 'progress' && (!fromEvent.matterId || fromEvent.matterId !== toEvent.matterId || !toEvent.updatesMatter)) {
        danglingRelationIds.push(relation.id); degradedFloorIds.add(memory.floorId); continue;
      }
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
  }
  const timeGroup = value => Number.isInteger(value?.day) ? 'absolute'
    : value?.monthIdentity ? `named:${value.monthIdentity}`
      : value?.year === null && Number.isInteger(value?.month) ? `month:${value.month}` : null;
  const timedGroups = new Map();
  for (const event of events) {
    const key = timeGroup(event.parsedStoryTime);
    if (key) timedGroups.set(key, [...(timedGroups.get(key) ?? []), event]);
  }
  for (const values of timedGroups.values()) {
    const sortableTime = value => Number.isInteger(value?.day) ? value.day
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
      if (representative && !comparableBefore(representative.parsedStoryTime, event.parsedStoryTime)
        && !comparableBefore(event.parsedStoryTime, representative.parsedStoryTime)) current.push(event);
      else timeBuckets.push([event]);
    }
    for (let index = 1; index < timeBuckets.length; index += 1) {
      const earlier = timeBuckets[index - 1], later = timeBuckets[index];
      if (!comparableBefore(earlier[0].parsedStoryTime, later[0].parsedStoryTime)) continue;
      const boundary = `time-boundary:${orderGraph.order}:${index}`;
      orderGraph.addNode(boundary, { value: null });
      for (const event of earlier) {
        const from = eventNode(event.id);
        if (!willCreateCycle(orderGraph, from, boundary)) orderGraph.addDirectedEdge(from, boundary, { relationId: null, inferredFromExplicitTime: true });
      }
      for (const event of later) {
        const to = eventNode(event.id);
        if (!willCreateCycle(orderGraph, boundary, to)) orderGraph.addDirectedEdge(boundary, to, { relationId: null, inferredFromExplicitTime: true });
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
  const deltaStatuses = eligible.map(({ memory }) => memory.qianshiDelta?.status ?? 'unprocessed');
  const coverage = frozen({
    eligibleFloors: eligible.length,
    readyFloors: deltaStatuses.filter(status => status === 'ready').length,
    emptyFloors: deltaStatuses.filter(status => status === 'empty').length,
    completeFloors: deltaStatuses.filter(status => ['ready', 'empty'].includes(status)).length,
    partialFloors: deltaStatuses.filter(status => status === 'partial').length,
    pendingFloors: deltaStatuses.filter(status => ['pending', 'unprocessed'].includes(status)).length,
    degradedFloors: degradedFloorIds.size,
    unavailableFloors: (floors.length - eligible.length),
  });
  return frozen({ graph, orderGraph, events: frozen(events), matters: frozen(matterDtos), relations: frozen(relations), currentProgress, coverage,
    diagnostics: frozen({ discardedOrderRelations: frozen(discardedOrderRelations), danglingRelationIds: frozen(danglingRelationIds),
      danglingContinuationIds: frozen(danglingContinuationIds), degradedFloorIds: frozen([...degradedFloorIds]), graphNodes: graph.order, graphEdges: graph.size,
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

const timeLabel = value => {
  if (!value) return '时间未知';
  const date = value.date || (value.raw && value.raw !== '时间未知' ? value.raw : '时间未知');
  return `${date}${value.clock && !String(date).includes(value.clock) ? ` ${value.clock}` : ''}`;
};

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

function matterOccurrenceTime(matter, eventById) {
  const latest = (matter.latestEventIds ?? []).map(id => eventById.get(id)).filter(Boolean)
    .sort((left, right) => right.assistantSeq - left.assistantSeq || right.id.localeCompare(left.id))[0];
  return latest?.parsedStoryTime ?? eventById.get(matter.origin?.eventId)?.parsedStoryTime ?? projectTime(matter.storyTime || matter.origin?.storyTime || '');
}

function continuityWindow(currentTime, recentStoryTimes) {
  const elapsed = (recentStoryTimes ?? []).map(value => ({ hours: timeHours(value, currentTime), days: timeDistance(value, currentTime) }))
    .filter(value => value.days !== null && value.days >= 0);
  const hours = elapsed.map(value => value.hours).filter(value => value !== null && value >= 0);
  const days = elapsed.map(value => value.days).filter(value => value !== null && value >= 0);
  return {
    hours: Math.min(72, Math.max(1, (hours.length ? Math.max(...hours) : 0) * 1.25)),
    days: Math.min(3, Math.max(0, Math.ceil((days.length ? Math.max(...days) : 0) * 1.25))),
  };
}

function withinContinuityWindow(from, to, window) {
  const hours = timeHours(from, to);
  if (hours !== null) return hours >= 0 && hours <= window.hours;
  const days = timeDistance(from, to);
  return days !== null && days >= 0 && days <= window.days;
}

function timeRelevantMatter(matter, eventById, currentTime, window) {
  if (!currentTime) return false;
  const occurrence = matterOccurrenceTime(matter, eventById);
  if (withinContinuityWindow(occurrence, currentTime, window)) return true;
  if (!matter.scheduledTime) return false;
  const scheduled = projectTime(matter.scheduledTime, occurrence);
  return withinContinuityWindow(currentTime, scheduled, window);
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

const GREGORIAN_ERA_PREFIX = /^(?:公元|公历|公曆|西历|西曆)/u;
const DAY_PERIOD_SUFFIX = /[\s，,]*(?:凌晨|清晨|拂晓|黎明|早晨|早上|上午|中午|正午|下午|傍晚|黄昏|晚上|夜晚|夜间|夜里|午夜|深夜)$/u;

function recallTimelineTime(event) {
  const raw = String(event.storyTime || event.parsedStoryTime?.raw || '').normalize('NFKC').trim();
  const sortableRaw = raw.replace(DAY_PERIOD_SUFFIX, '').trim();
  const time = sortableRaw && sortableRaw !== raw ? projectTime(sortableRaw) : event.parsedStoryTime;
  let era = '', monthName = '';
  if (time?.monthIdentity) try {
    const identity = JSON.parse(time.monthIdentity);
    era = typeof identity?.[0] === 'string' ? identity[0] : '';
    monthName = typeof identity?.[2] === 'string' ? identity[2] : '';
  } catch { /* invalid persisted identities remain incomparable */ }
  const explicitGregorian = GREGORIAN_ERA_PREFIX.test(raw);
  const explicitNamed = Boolean(era && raw.startsWith(era));
  const kind = explicitGregorian ? 'gregorian' : explicitNamed || era ? `named:${era}`
    : Number.isInteger(time?.year) ? 'bare' : time?.monthIdentity ? `month:${time.monthIdentity}` : 'unknown';
  const standardMonth = Number.isInteger(time?.month) && monthName !== `闰${time.month}月`;
  return { time, kind, explicit: explicitGregorian || explicitNamed, standardMonth };
}

function recallTimelineTimeComparator(events, calendarEvidenceEvents = events) {
  const views = new Map(events.map(event => [event.id, recallTimelineTime(event)]));
  const explicitCalendarsByYear = new Map();
  for (const event of calendarEvidenceEvents) {
    const view = views.get(event.id) ?? recallTimelineTime(event);
    if (!view.explicit || !Number.isInteger(view.time?.year)) continue;
    explicitCalendarsByYear.set(view.time.year, new Set([...(explicitCalendarsByYear.get(view.time.year) ?? []), view.kind]));
  }
  const calendar = view => {
    if (view.kind !== 'bare') return view.kind;
    const candidates = explicitCalendarsByYear.get(view.time?.year);
    return candidates?.size === 1 ? [...candidates][0] : 'bare';
  };
  return (left, right) => {
    const a = views.get(left.id), b = views.get(right.id);
    if (!a?.time || !b?.time || calendar(a) !== calendar(b)) return 0;
    if (a.standardMonth && b.standardMonth
      && [a.time.year, a.time.month, a.time.monthDay, b.time.year, b.time.month, b.time.monthDay].every(Number.isInteger)) {
      const dateOrder = a.time.year - b.time.year || a.time.month - b.time.month || a.time.monthDay - b.time.monthDay;
      if (dateOrder) return dateOrder;
      return Number.isInteger(a.time.minute) && Number.isInteger(b.time.minute) ? a.time.minute - b.time.minute : 0;
    }
    const distance = timeDistance(a.time, b.time);
    if (distance !== null && distance !== 0) return distance > 0 ? -1 : 1;
    return distance === 0 && Number.isInteger(a.time.minute) && Number.isInteger(b.time.minute)
      ? a.time.minute - b.time.minute : 0;
  };
}

function orderRecallTimelineEvents(events, relations, calendarEvidenceEvents = events) {
  if (events.length < 2) return events;
  const graph = new DirectedGraph({ allowSelfLoops: false });
  const byId = new Map(events.map(event => [event.id, event]));
  events.forEach(event => graph.addNode(event.id));
  const compareTime = recallTimelineTimeComparator(events, calendarEvidenceEvents);
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

/**
 * Query-specific prompt projection. The public/detail projection above remains
 * untouched; this view only decides what the next generation receives.
 */
export function projectQianshiRecall(reachable, { queryContext = null, currentTime = null, recentStoryTimes = [], identityProjection = null, characterBudget = 4000 } = {}) {
  const projection = projectQianshiGraph(reachable, { identityProjection });
  const eventById = new Map(projection.events.map(event => [event.id, event]));
  const matterById = new Map(projection.matters.map(matter => [matter.matterId, matter]));
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
  const window = continuityWindow(currentTime, recentStoryTimes);
  const pending = matterScores.filter(({ matter }) => ['planned', 'inProgress'].includes(matter.status)
    && timeRelevantMatter(matter, eventById, currentTime, window))
    .sort((left, right) => Number(right.direct) - Number(left.direct) || right.latestUserScore - left.latestUserScore || right.score - left.score
      || right.matter.sourceAssistantSeq - left.matter.sourceAssistantSeq || left.matter.matterId.localeCompare(right.matter.matterId));
  const selectedMatterIds = new Set([...directMatters, ...pending].map(item => item.matter.matterId));
  const selectedEventIds = new Set();
  for (const matterId of selectedMatterIds) {
    const matter = matterById.get(matterId);
    const directSeeds = (matter.eventIds ?? []).filter(id => matched(eventMatches.get(id)));
    const matterDirect = matched(rankById.get(`matter:${matterId}`));
    const seeds = matterDirect ? matter.eventIds : directSeeds.length ? directSeeds : [...(matter.latestEventIds ?? []), matter.origin?.eventId].filter(Boolean);
    const connected = connectedProgressEventIds(seeds, projection.relations);
    const ordered = (matter.eventIds ?? []).filter(id => connected.has(id));
    for (const id of representativeEventIds(ordered.length ? ordered : seeds, eventById)) selectedEventIds.add(id);
  }
  const independent = projection.events.filter(event => event.matterId === null && matched(eventMatches.get(event.id)))
    .sort((left, right) => (eventMatches.get(right.id)?.branchScores?.latestUser ?? 0) - (eventMatches.get(left.id)?.branchScores?.latestUser ?? 0)
      || (eventMatches.get(right.id)?.score ?? 0) - (eventMatches.get(left.id)?.score ?? 0)
      || right.assistantSeq - left.assistantSeq || left.id.localeCompare(right.id));
  independent.forEach(event => selectedEventIds.add(event.id));

  const timelineEvents = orderRecallTimelineEvents(projection.events.filter(event => selectedEventIds.has(event.id)), projection.relations, projection.events);
  const pendingMatterIds = new Set(pending.map(item => item.matter.matterId));
  const unresolvedHistoryTailIds = new Set(directMatters.filter(({ matter }) => ['planned', 'inProgress'].includes(matter.status) && !pendingMatterIds.has(matter.matterId))
    .map(({ matter }) => timelineEvents.filter(event => event.matterId === matter.matterId).at(-1)?.id).filter(Boolean));
  const timelineRows = timelineEvents.map(event => ({ event, line: `- ${timeLabel(event.parsedStoryTime)}：${event.title}${unresolvedHistoryTailIds.has(event.id) ? '（此后尚未记录完成）' : ''}` }));
  const pendingLines = pending.map(({ matter }) => {
    const schedule = matter.scheduledTime ? `；约定：${matter.scheduledTime}` : '';
    return `- ${matter.title}${matter.object ? `（${matter.object}）` : ''}${schedule}；尚未记录完成。`;
  });
  const maximumCharacters = Math.max(0, characterBudget);
  const timelineSource = timelineRows.map(row => ({ ...row, kind: 'event' }));
  const pendingSource = pending.map((item, index) => ({ matter: item.matter, line: pendingLines[index], kind: 'matter' }));
  const takeRows = (title, rows, limit, selected = []) => {
    for (const row of rows.slice(selected.length)) {
      const candidate = [title, ...selected.map(item => item.line), row.line].join('\n');
      if (candidate.length > limit) break;
      selected.push(row);
    }
    return selected;
  };
  let acceptedPending = [];
  if (pendingSource.length) {
    const firstPendingLength = ['[当前待接续]', pendingSource[0].line].join('\n').length;
    const pendingReserve = timelineSource.length
      ? Math.min(maximumCharacters, Math.max(Math.floor(maximumCharacters / 3), firstPendingLength))
      : maximumCharacters;
    acceptedPending = takeRows('[当前待接续]', pendingSource, pendingReserve);
  }
  const pendingText = acceptedPending.length ? ['[当前待接续]', ...acceptedPending.map(row => row.line)].join('\n') : '';
  const timelineLimit = Math.max(0, maximumCharacters - pendingText.length - (pendingText ? 2 : 0));
  const acceptedTimeline = takeRows('[相关时间线]', timelineSource, timelineLimit);
  const timelineText = acceptedTimeline.length ? ['[相关时间线]', ...acceptedTimeline.map(row => row.line)].join('\n') : '';
  const usedBeforePendingExpansion = timelineText.length + (timelineText && pendingText ? 2 : 0);
  if (acceptedPending.length < pendingSource.length) {
    acceptedPending = takeRows('[当前待接续]', pendingSource, Math.max(0, maximumCharacters - usedBeforePendingExpansion), acceptedPending);
  }
  const finalPendingText = acceptedPending.length ? ['[当前待接续]', ...acceptedPending.map(row => row.line)].join('\n') : '';
  const acceptedText = [timelineText, finalPendingText].filter(Boolean).join('\n\n');
  const eventIds = acceptedTimeline.map(row => row.event.id);
  const matterIds = acceptedPending.map(row => row.matter.matterId);
  return frozen({ projectionVersion: QIANSHI_RECALL_PROJECTION_VERSION, text: acceptedText, characterCount: acceptedText.length,
    eventIds: frozen([...new Set(eventIds)]), matterIds: frozen([...new Set(matterIds)]) });
}

export function prepareQianshiCandidates(reachable, { canonicalContent = '', precedingUserInput = null, characterBudget = QIANSHI_CANDIDATE_CHARACTER_BUDGET, identityProjection = null } = {}) {
  const projection = projectQianshiGraph(reachable, { identityProjection });
  const query = clean([canonicalContent, ...(precedingUserInput?.messages ?? []).map(message => message.content)].join(' '), 24000);
  const documents = projection.matters.map(matter => ({ id: matter.matterId, text: relevanceText(matter) }));
  const ranked = new Map(rankRecallDocuments({ documents, queries: [{ key: 'targetFloor', text: query, weight: 1 }] }).map(item => [item.id, item]));
  const scored = projection.matters.map(matter => {
    const rank = ranked.get(matter.matterId);
    const unfinished = !TERMINAL_STATUSES.has(matter.status);
    return { matter, relevant: (rank?.branchMatchCounts?.targetFloor ?? 0) > 0, score: Number(unfinished) * 100000 + (rank?.score ?? 0) * 10000 + matter.sourceAssistantSeq };
  }).filter(item => !TERMINAL_STATUSES.has(item.matter.status) || item.relevant)
    .sort((left, right) => right.score - left.score || left.matter.matterId.localeCompare(right.matter.matterId));
  const request = [], bindings = [], lines = [];
  for (const { matter } of scored) {
    const key = `candidate-${request.length + 1}`;
    const value = { key, title: matter.title, status: matter.status, people: matter.people.map(person => person.name), object: matter.object,
      origin: { title: matter.origin.title, description: matter.origin.description, storyTime: matter.origin.storyTime,
        scheduledTime: matter.origin.scheduledTime, sourceAssistantSeq: matter.origin.sourceAssistantSeq },
      latestProgress: { title: matter.title, description: matter.description, storyTime: matter.storyTime,
        scheduledTime: matter.scheduledTime, sourceAssistantSeq: matter.sourceAssistantSeq } };
    const line = JSON.stringify(value);
    if (lines.join('\n').length + line.length > Math.max(0, characterBudget)) continue;
    request.push(frozen(value)); lines.push(line);
    bindings.push(frozen({ key, matterId: matter.matterId, latestEventIds: frozen([...matter.latestEventIds]), sourceFloorId: matter.sourceFloorId,
      sourceAssistantSeq: matter.sourceAssistantSeq, latestStoryTime: matter.storyTime, latestScheduledTime: matter.scheduledTime }));
  }
  return frozen({ request: frozen(request), bindings: frozen(bindings), stats: frozen({ count: request.length, characters: lines.join('\n').length, budget: characterBudget }) });
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
      if (rawLinks.length !== resolvedLinks.length) issues.push(`事件 ${index + 1} 含无效旧事项候选引用。`);
      const matterIds = [...new Set(resolvedLinks.map(item => item.candidate.matterId))];
      if (matterIds.length > 1) { issues.push(`事件 ${index + 1} 同时引用多个旧事项，已按独立事件保存。`); resolvedLinks.length = 0; }
      const id = await deterministicUuid(['qianshi-event-v1', sourceFloorId, localKey, title, description, status]);
      const storyTime = clean(raw.storyTime ?? raw.occurredAt, 500) || null;
      const link = resolvedLinks[0] ?? null;
      const backdated = link?.kind === 'progress' && storyTime && link.candidate.latestStoryTime
        && comparableBefore(projectTime(storyTime), projectTime(link.candidate.latestStoryTime));
      const updatesMatter = link ? link.kind === 'progress' && !backdated : raw.matter === true || ['planned', 'inProgress'].includes(status);
      const matterId = link?.candidate.matterId ?? (updatesMatter ? await deterministicUuid(['qianshi-matter-v1', id, clean(raw.object, 1000), title]) : null);
      const people = [...new Set(list(raw.people ?? raw.participants).map(value => clean(typeof value === 'string' ? value : value?.name, 500)).filter(Boolean))]
        .map(name => ({ entityId: resolvePerson(name), name }));
      const event = { id, matterId, updatesMatter, title, description, status, storyTime,
        scheduledTime: clean(raw.scheduledTime ?? raw.expectedAt ?? raw.dueTime, 500) || null, people, object: clean(raw.object ?? raw.subject, 1000) || null,
        sourceFloorId, continuesFromEventIds: [...new Set(resolvedLinks.flatMap(item => item.candidate.latestEventIds ?? []))] };
      events.push(event); local.set(localKey, event);
      if (Array.isArray(compiledBindings)) compiledBindings.push(Object.freeze({ localKey, event: Object.freeze({ ...event }) }));
      if (updatesMatter && link?.kind === 'progress') for (const priorEventId of event.continuesFromEventIds) relations.push({ id: await deterministicUuid(['qianshi-relation-v1', 'progress', priorEventId, id]), type: 'progress', fromEventId: priorEventId, toEventId: id, certainty: 'explicit' });
    } catch (error) {
      issues.push(clean(error?.validationPath || error?.message || `事件 ${index + 1} 无效`, 300));
    }
  }
  const resolveEventRef = value => {
    const key = keyText(value);
    if (local.has(key)) return local.get(key).id;
    const candidate = candidateByKey.get(key);
    return candidate?.latestEventIds?.length === 1 ? candidate.latestEventIds[0] : null;
  };
  for (const [index, raw] of list(qianshi.order).slice(0, 320).entries()) {
    const fromEventId = resolveEventRef(raw?.before), toEventId = resolveEventRef(raw?.after);
    if (!fromEventId || !toEventId || fromEventId === toEventId) { issues.push(`先后关系 ${index + 1} 引用无效。`); continue; }
    relations.push({ id: await deterministicUuid(['qianshi-relation-v1', 'before', fromEventId, toEventId]), type: 'before', fromEventId, toEventId,
      certainty: raw?.certainty === 'strong' ? 'strong' : 'explicit' });
  }
  const dedupedRelations = [...new Map(relations.map(item => [item.id, item])).values()];
  const status = events.length ? issues.length ? 'partial' : 'ready' : issues.length ? 'pending' : 'empty';
  const reason = issues.length ? clean(`${issues.length} 项未能编译：${issues.slice(0, 3).join('；')}`, 500) : null;
  return validateQianshiDelta({ schemaVersion: QIANSHI_SCHEMA_VERSION, status, reason, compiledAt: now, candidateStats: stats, events, relations: dedupedRelations }, { floorIds: sourceFloorIds });
}

export function pendingQianshiDelta(previous, reason, now = new Date().toISOString()) {
  return validateQianshiDelta({ schemaVersion: QIANSHI_SCHEMA_VERSION, status: 'pending', reason: clean(reason, 500) || '千事字段待补。', compiledAt: now,
    candidateStats: { count: Number(previous?.candidateStats?.count) || 0, characters: Number(previous?.candidateStats?.characters) || 0 }, events: [], relations: [] });
}

export function publicQianshiSnapshot(reachable, history = null, identityProjection = null) {
  const projection = projectQianshiGraph(reachable, { identityProjection });
  const publicEvent = event => ({ id: event.id, matterId: event.matterId, title: event.title, description: event.description, status: event.status,
    updatesMatter: event.updatesMatter, storyTime: event.storyTime, scheduledTime: event.scheduledTime, people: event.people.map(person => ({ ...person })), object: event.object,
    sourceFloorId: event.sourceFloorId, sourceFloorMemoryId: event.floorMemoryId, sourceAssistantSeq: event.assistantSeq });
  return structuredClone({ status: 'ready', identity: { qqjChatId: reachable.root.chatId }, anchor: { narrativeGeneration: reachable.root.narrativeGeneration, headCheckpointId: reachable.root.headCheckpointId, rootRevision: reachable.rootRevision },
    coverage: projection.coverage, events: projection.events.map(publicEvent), matters: projection.matters, relations: projection.relations,
    currentProgress: projection.currentProgress, history: history ?? { status: 'idle', jobId: null, processedFloors: 0, totalFloors: 0, calls: 0, message: '' }, diagnostics: projection.diagnostics });
}
