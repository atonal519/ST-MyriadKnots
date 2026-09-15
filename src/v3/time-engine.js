import { estimateRecallTokens } from './recall-selector.js';
import { sha256 } from '../identity.js';
import { resolveIdentityEntityId } from './entity-identity.js';

export const TIME_HEAD_ID = 'v3-time-head';
export const TIME_INPUT_CHARACTERS = 24000;
const DAY = 86400000;
export function timeDistance(from, to) {
  if (Number.isInteger(from?.day) && Number.isInteger(to?.day)) return to.day - from.day;
  if (from?.year === null && to?.year === null && from?.month && from.month === to.month) return to.monthDay - from.monthDay;
  return null;
}
const text = (value, max = 2000) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const fail = message => Object.assign(new Error(message), { code: 'QQJ_TIME_INVALID' });
export const timeFingerprint = async value => `sha256:${await sha256(JSON.stringify(value))}`;

// Full Gregorian dates and same-month yearless anchors are separate identities.
export function projectTime(value, anchor = null) {
  const raw = text(value, 500);
  const clock = raw.match(/(?:^|[T\s，])([01]?\d|2[0-3]):([0-5]\d)(?:[:：]\d{2})?(?:Z)?(?:$|[\s，])/u);
  const dateText = clock ? raw.replace(clock[0], ' ').trim() : raw;
  const date = !dateText && clock && anchor?.date ? { ...anchor } : projectDate(dateText, anchor);
  return { ...date, raw: raw || date.raw, minute: clock ? Number(clock[1]) * 60 + Number(clock[2]) : null,
    clock: clock ? `${clock[1].padStart(2, '0')}:${clock[2]}` : null };
}
export function timeHours(from, to) {
  const days = timeDistance(from, to);
  return days !== null && Number.isInteger(from?.minute) && Number.isInteger(to?.minute) ? days * 24 + (to.minute - from.minute) / 60 : null;
}
export function shiftTime(time, days) {
  if (Number.isInteger(time?.day)) return projectTime(`${new Date((time.day + days) * DAY).toISOString().slice(0, 10)}${time.clock ? ` ${time.clock}` : ''}`);
  return projectTime(`${days}天后${time?.clock ? ` ${time.clock}` : ''}`, time);
}
export function nextCycleTime(item) {
  // An unconfirmed expected cycle is still due; no automatic rollover claims it happened.
  return item.dueTime;
}
function projectDate(value, anchor = null) {
  const raw = text(value, 500);
  const match = raw.match(/(?:^|[^\d])(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日)?(?:[^\d]|$)/u);
  if (match) {
    const [year, month, day] = match.slice(1).map(Number);
    const stamp = Date.UTC(year, month - 1, day);
    const date = new Date(stamp);
    if (year >= 1000 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
      return { raw, date: date.toISOString().slice(0, 10), day: stamp / DAY, year, month, monthDay: day };
    }
  }
  const monthOnly = !/\d{4}[-/年]/u.test(raw) && raw.match(/(?:^|[^\d])(\d{1,2})[月/.-](\d{1,2})(?:日|号)?(?:[^\d]|$)/u);
  if (monthOnly) {
    const month = Number(monthOnly[1]), monthDay = Number(monthOnly[2]);
    if (month >= 1 && month <= 12 && monthDay >= 1 && monthDay <= [31,29,31,30,31,30,31,31,30,31,30,31][month - 1]) {
      return { raw, date: `${month}月${monthDay}日（年份未明）`, day: null, year: null, month, monthDay };
    }
  }
  let offset = null;
  if (/^(今天|当日|当天|今日)$/u.test(raw)) offset = 0;
  if (/^(昨天|昨日|前一天)$/u.test(raw)) offset = -1;
  if (/^(前天|前日)$/u.test(raw)) offset = -2;
  if (/^(明天|明日|次日|翌日)$/u.test(raw)) offset = 1;
  if (/^(后天|後天)$/u.test(raw)) offset = 2;
  const relative = raw.match(/^(\d{1,4})\s*(天|日|周|星期)(前|后|後)$/u);
  if (relative) offset = Number(relative[1]) * (['周', '星期'].includes(relative[2]) ? 7 : 1) * (relative[3] === '前' ? -1 : 1);
  if (offset !== null && Number.isInteger(anchor?.day)) {
    const day = anchor.day + offset;
    return { raw, date: new Date(day * DAY).toISOString().slice(0, 10), day };
  }
  if (offset !== null && anchor?.year === null && anchor?.month && anchor.monthDay + offset >= 1
    && anchor.monthDay + offset <= [31,28,31,30,31,30,31,31,30,31,30,31][anchor.month - 1]) {
    const monthDay = anchor.monthDay + offset;
    return { raw, date: `${anchor.month}月${monthDay}日（年份未明）`, day: null, year: null, month: anchor.month, monthDay };
  }
  return { raw: raw || '时间未知', date: null, day: null, year: null, month: null, monthDay: null };
}

export function storyTimes(memories, floors) {
  const byFloor = new Map(memories.filter(memory => memory.recordStatus === 'active').map(memory => [memory.floorId, memory]));
  const result = new Map();
  let previous = null;
  for (const floor of floors) {
    const memory = byFloor.get(floor.id);
    if (!memory) continue;
    let current = projectTime('');
    for (const entry of memory.chronology ?? []) {
      const time = entry.time ?? {};
      if (time.kind === 'sequenceOnly') continue;
      const anchor = time.relativeToFloorId ? result.get(time.relativeToFloorId) : previous;
      const raw = time.normalized || time.sourceText || '';
      const pieces = String(raw).split(/\s*(?:→|->|⟶)\s*/u);
      const candidate = projectTime(pieces.at(-1), anchor);
      if (time.kind === 'unknown' && !candidate.date) continue;
      current = pieces.length > 1 ? { ...candidate, rangeText: raw } : candidate;
    }
    result.set(floor.id, current);
    previous = current;
  }
  return result;
}

function evaluateTimeBatches(batches, reachable) {
  const memories = new Map((reachable.floorMemories ?? []).filter(memory => memory.recordStatus === 'active').map(memory => [memory.floorId, memory.id]));
  const floors = new Set((reachable.floors ?? []).map(floor => floor.id));
  const items = new Map(), processedSourceKeys = new Set();
  for (const batch of batches) {
    if (!floors.has(batch.cutoffFloorId) || !(batch.dependencies ?? []).every(ref => memories.get(ref.floorId) === ref.memoryId)) continue;
    let complete = true;
    for (const item of batch.changes ?? []) {
      const prior = items.get(item.id);
      // An update depends on the previously retained observation, including across a second fork.
      if (item.previousObservationKey && prior?.observationKey !== item.previousObservationKey) { complete = false; continue; }
      items.set(item.id, structuredClone(item));
    }
    if (complete) for (const key of batch.sourceKeys ?? []) processedSourceKeys.add(key);
  }
  return { items: [...items.values()], processedSourceKeys };
}

export function replayTimeBatches(batches, reachable) {
  return evaluateTimeBatches(batches, reachable).items;
}

export function bodyProjectionDue(observationTime, currentTime) {
  if (!observationTime?.date || !currentTime?.date) return false;
  const hours = timeHours(observationTime, currentTime);
  return hours !== null ? hours >= 6 : timeDistance(observationTime, currentTime) >= 1;
}

export function validTimeProjection(item, currentTime) {
  return Boolean(item.projection?.observationKey === item.observationKey && currentTime?.date
    && item.projection.applicableTime?.date === currentTime.date
    && (timeHours(item.projection.applicableTime, currentTime) === null
      || (timeHours(item.projection.applicableTime, currentTime) >= 0 && timeHours(item.projection.applicableTime, currentTime) < 6)));
}

export async function prepareTimeBatch(reachable, batches = [], { inputCharacters = TIME_INPUT_CHARACTERS, lastAttemptTime = null, inputTokens = 6000, allowInitialProjection = false } = {}) {
  const floors = reachable.floors ?? [], memories = reachable.floorMemories ?? [];
  const active = memories.filter(memory => memory.recordStatus === 'active');
  const seq = new Map(floors.map(floor => [floor.id, floor.assistantSeq]));
  const times = storyTimes(active, floors);
  const cutoff = floors.at(-1);
  const currentTime = times.get(cutoff?.id) ?? projectTime('');
  const replay = evaluateTimeBatches(batches, reachable);
  const items = replay.items.filter(item => item.status === 'active');
  const seen = replay.processedSourceKeys;
  const candidates = [], materialKeys = [];
  for (const memory of active) {
    const observations = (memory.observations ?? []).filter(item => ['physical', 'injury'].includes(item.kind) && item.subjectEntityId);
    const persistent = (memory.cseSignals ?? []).filter(item => item.signalType === 'persistentCondition');
    const commitments = (memory.commitments ?? []).filter(item => item.speakerEntityId && !['boundary', 'codePhrase'].includes(item.kind) && (item.status !== 'refused' || items.some(tracked => tracked.subjectEntityId === item.speakerEntityId && tracked.type === 'deadline')));
    const updates = [];
    for (const tracked of items) {
      if ((seq.get(memory.floorId) ?? 0) <= Math.max(...tracked.sourceRefs.map(ref => seq.get(ref.floorId) ?? 0))) continue;
      const linked = value => tracked.label.length >= 2 && text(value).includes(tracked.label);
      for (const action of memory.actions ?? []) if (action.actorEntityId === tracked.subjectEntityId && linked(`${action.action} ${action.result ?? ''}`)) {
        updates.push({ itemId: action.itemId, subjectEntityId: tracked.subjectEntityId, description: `${action.action}；结果：${action.result ?? '未明'}；完成状态：${action.completion}`, status: action.completion });
      }
      for (const event of memory.eventFragments ?? []) if (event.candidateStatus !== 'rejected' && linked(`${event.title} ${event.description}`)) updates.push({ itemId: event.itemId, subjectEntityId: tracked.subjectEntityId, description: `${event.title}：${event.description}` });
    }
    for (const [kind, values] of [['body', observations], ['body', persistent], ['deadline', commitments], ['update', updates]]) for (const value of values) {
      const sourceKey = await timeFingerprint([memory.floorId, memory.id, value.itemId, value, times.get(memory.floorId)]);
      materialKeys.push(sourceKey);
      if (seen.has(sourceKey)) continue;
      const description = text(value.description || value.content);
      const deadline = kind === 'deadline' ? projectTime(description.match(/(?:\d{1,4}\s*(?:天|日|周|星期)(?:前|后|後)|明天|明日|后天|次日|翌日)/u)?.[0] || description, times.get(memory.floorId)) : projectTime('');
      const distance = timeDistance(currentTime, deadline);
      const related = items.some(item => item.subjectEntityId === (value.subjectEntityId || value.speakerEntityId) && (kind === 'update' || description.includes(item.label)));
      const nearDeadline = ['promise', 'agreement'].includes(value.kind) && distance !== null && distance >= 0 && distance <= 7;
      candidates.push({ sourceKey, kind, subjectEntityId: value.subjectEntityId || value.speakerEntityId, description,
        ...(kind === 'deadline' ? { commitmentKind: value.kind } : kind === 'body' ? { observationKind: value.kind ?? value.signalType } : {}),
        status: value.status ?? null, floorId: memory.floorId, memoryId: memory.id, assistantSeq: seq.get(memory.floorId),
        observationTime: times.get(memory.floorId) ?? projectTime(''),
        observationElapsedDays: timeDistance(times.get(memory.floorId), currentTime),
        observationElapsedHours: timeHours(times.get(memory.floorId), currentTime),
        priority: related ? 4 : kind === 'body' || nearDeadline ? 3 : 1 });
    }
  }
  candidates.sort((a, b) => b.priority - a.priority || b.assistantSeq - a.assistantSeq);
  const progress = items.map(item => ({ ...item, elapsedDays: timeDistance(item.occurrenceTime, currentTime), elapsedHours: timeHours(item.occurrenceTime, currentTime),
    observationElapsedDays: timeDistance(item.observationTime, currentTime), observationElapsedHours: timeHours(item.observationTime, currentTime), nextExpectedTime: nextCycleTime(item, currentTime) }));
  const clockDue = progress.some(item => {
    const baseline = lastAttemptTime ?? item.projection?.applicableTime ?? item.observationTime;
    if (!currentTime.date || !baseline?.date) return false;
    if (item.type === 'body') {
      return bodyProjectionDue(baseline, currentTime);
    }
    const due = nextCycleTime(item, currentTime), before = timeDistance(baseline, due), after = timeDistance(currentTime, due);
    const beforeHours = timeHours(baseline, due), afterHours = timeHours(currentTime, due);
    return before !== null && after !== null && ((before > 7 && after <= 7) || (before > 0 && after <= 0)
      || (beforeHours !== null && afterHours !== null && ((beforeHours > 6 && afterHours <= 6) || (beforeHours > 0 && afterHours <= 0))));
  });
  const accepted = [], tracked = [];
  // A short shared history supplies completion/cancellation evidence during first-time registration.
  const context = [], candidatePeople = new Set(candidates.map(item => item.subjectEntityId));
  let contextTokens = 0;
  for (const memory of [...active].sort((a, b) => (seq.get(b.floorId) ?? 0) - (seq.get(a.floorId) ?? 0))) {
    const row = { floorId: memory.floorId, memoryId: memory.id, observationTime: times.get(memory.floorId),
      summary: text(memory.summary?.effectiveSource === 'user' ? memory.summary.userText : memory.summary?.aiText, 220),
      actions: (memory.actions ?? []).filter(action => candidatePeople.has(action.actorEntityId)).slice(0, 2).map(action => ({ actorEntityId: action.actorEntityId, action: text(action.action, 120), result: text(action.result, 120), completion: action.completion })),
      events: (memory.eventFragments ?? []).filter(event => event.candidateStatus !== 'rejected').slice(0, 1).map(event => text(`${event.title}：${event.description}`, 160)) };
    const tokens = estimateRecallTokens(JSON.stringify(row));
    if (contextTokens + tokens > 650) continue;
    context.push(row); contextTokens += tokens;
  }
  const people = (reachable.entities ?? []).filter(entity => entity.entityType === 'person').map(entity => ({ entityId: entity.id, name: entity.displayName }));
  const base = JSON.stringify({ currentTime, people, cutoffFloorId: cutoff?.id ?? null, observations: [], trackedItems: [], context });
  let used = base.length + 100, usedTokens = estimateRecallTokens(base + TIME_SYSTEM_PROMPT) + 1000;
  const tokenCost = value => estimateRecallTokens(JSON.stringify(value));
  const shortTime = time => time ? { date: time.date, clock: time.clock, ...(!time.date ? { raw: text(time.raw, 80) } : {}) } : null;
  const trackedDto = item => ({ id: item.id, subjectEntityId: item.subjectEntityId, type: item.type, label: item.label, status: item.status,
    observation: text(item.observation, 600), observationTime: shortTime(item.observationTime), occurrenceTime: shortTime(item.occurrenceTime), dueTime: shortTime(item.dueTime),
    periodDays: item.periodDays, elapsedDays: item.elapsedDays, elapsedHours: item.elapsedHours, observationElapsedDays: item.observationElapsedDays, observationElapsedHours: item.observationElapsedHours, nextExpectedTime: shortTime(item.nextExpectedTime) });
  const addTracked = (item, tokensLimit = inputTokens, charsLimit = inputCharacters) => { if (tracked.some(old => old.id === item.id)) return; const dto = trackedDto(item), size = JSON.stringify(dto).length, tokens = tokenCost(dto); if (used + size <= charsLimit && usedTokens + tokens <= tokensLimit) { tracked.push(item); used += size; usedTokens += tokens; } };
  const relatedProgress = progress.filter(item => candidatePeople.has(item.subjectEntityId));
  const trackedTokenLimit = usedTokens + Math.floor((inputTokens - usedTokens) * 0.55), trackedCharsLimit = used + Math.floor((inputCharacters - used) * 0.55);
  for (const item of relatedProgress) addTracked(item, trackedTokenLimit, trackedCharsLimit);
  for (const value of candidates) {
    const size = JSON.stringify(value).length, tokens = tokenCost(value);
    if (used + size <= inputCharacters && usedTokens + tokens <= inputTokens) { accepted.push(value); used += size; usedTokens += tokens; }
  }
  for (const item of progress.sort((a, b) => (timeDistance(currentTime, nextCycleTime(a, currentTime)) ?? Infinity) - (timeDistance(currentTime, nextCycleTime(b, currentTime)) ?? Infinity))) addTracked(item);
  const request = { currentTime, cutoffFloorId: cutoff?.id ?? null, people, observations: accepted, trackedItems: tracked.map(trackedDto), context };
  const signature = await timeFingerprint([materialKeys.sort(), context, currentTime.date, currentTime.clock]);
  const initialProjectionPending = tracked.some(item => item.type === 'body' && !item.projection && bodyProjectionDue(item.observationTime, currentTime));
  return { request, trackedRecords: tracked, signature, initialProjectionPending, shouldRequest: Boolean(cutoff && (accepted.length || clockDue && tracked.length || allowInitialProjection && initialProjectionPending)),
    sourceKeys: candidates.map(item => item.sourceKey), omitted: candidates.length - accepted.length + progress.length - tracked.length,
    cutoffFloorId: cutoff?.id ?? null, cutoffAssistantSeq: cutoff?.assistantSeq ?? 0 };
}

export const TIME_SYSTEM_PROMPT = `你是虚构故事的时间事项分析员。只分析身体状态、周期、约定期限；排除心理、关系、动机、行为规划和物品独立模拟。只作非露骨事实分析，不续写剧情，不提供临床判断、诊断或治疗方案。
一次处理所有人物。observations 是新来源；context是去重短历史，先检查其中后续履行、取消或结果证据，首次登记旧约定也不要把已结束事项当作活跃。trackedItems 是已登记观察，elapsedDays由程序算好，不重算日期。返回单个JSON对象：{"changes":[]}。
每次最多输出6个最重要事项，不凑满；每项observation和progression各用不超过80字的短句。
先评估已有trackedItems身体事项的自然进展：没有新事实时也根据程序给出的observationElapsedHours/observationElapsedDays估计宽泛的当前状态；occurrenceTime未知不代表观察后经过时间不可用，不强填发生时刻。新事实更新仍优先，不造护理或行动。期限必须有具体应履行的事项和明确期限；只有时间词的感叹、安慰或延后讨论不能当约定，已有此类误登记可paused停止追踪，不虚构完成。同一次伤跨楼观察应关联同一itemId，只有明确再次受伤才新增；重复旧条可paused停止重复追踪，不能据此宣称痊愈。
只登记仍相关、会随时间自然变化的状态；排除固定体型、身体构造和没有持续影响的瞬时反应。观察时间不等于发生时间，禁止直接抄观察日作为发生日；来源给出“昨天/前一天”等相对时间时，occurrenceTime原样保留来源完整相对表达，交由程序按该来源observationTime回溯；不自行换算绝对日，也不按currentTime回溯。无法确定发生日就留空。昨天的旧伤痕和今天的新伤痕是两次独立发生，不能合并为同一项。近期观察不足可不登记。同人物的trackedItems只供判断关联，不代表新来源与旧项一定相同。
每项形状：{"itemId":已有事项ID或null,"sourceKeys":[输入新来源键],"subjectEntityId":输入人物ID,"type":"body|cycle|deadline","label":"事项","observation":"原始观察","occurrenceTime":"明确发生时间或昨天等完整相对表达，未知空串","dueTime":"明确期限或周期预计日，未知空串","periodDays":明确周期天数或null,"status":"active|completed|cancelled|paused","stateRefs":[{"stateId":"输入明确给出的CSE状态ID","sourceFloorId":"其来源楼ID"}],"progression":"已有事项当前预计自然进展，未知空串"}。
新项必须绑定sourceKeys并保存原观察。身体观察相对当前已过至少6小时，或没有钟点但已跨日时，可在同一次登记给出当前自然推测；observationElapsedDays/Hours由程序计算。当前时点的新观察、时间未知或倒退不推演，progression留空。已有项没有新观察时sourceKeys空数组，observation沿用；已有项有新观察时以本项最新绑定观察为准，不用较早来源推演覆盖新事实；只有最新观察符合上述经过时间条件时才可给出当前自然推测。非active事项不推演。同处再次受伤是新发生的新项，不移动旧伤起点。取消约定不要补造改期。无明确时间不填现实日期。periodDays只写来源明确给出的周期天数，不用人口平均周期编造个体规律。nextExpectedTime保留未确认的预计节点；只有新的实际观察确认周期后才更新正式周期锚，不自动跳过未确认节点。预计周期不是已发生；到期未确认不等于已完成或违约。progression只能估计自然状态，不新增护理、服药、赴约或其他未发生行为。stateRefs只能引用本请求明确提供、同人物且确属同一观察的状态；无明确联系就留空。未出现的新来源不代表旧项消失。无需变化可空changes。`;

export async function compileTimeResponse(response, prepared, batches = []) {
  let data = response?.jsonData ?? response?.textData ?? response;
  if (typeof data === 'string') data = JSON.parse(data.replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, ''));
  if (!data || !Array.isArray(data.changes) || data.changes.length > 40) throw fail('时间事项结果格式无效。');
  const sources = new Map(prepared.request.observations.map(item => [item.sourceKey, item]));
  const prior = new Map([...prepared.request.trackedItems, ...(prepared.trackedRecords ?? [])].map(item => [item.id, item]));
  const people = new Set(prepared.request.people.map(item => item.entityId));
  const changes = [], ids = new Set();
  for (const value of data.changes) {
    if (!value || !people.has(value.subjectEntityId) || !['body', 'cycle', 'deadline'].includes(value.type)
      || !['active', 'completed', 'cancelled', 'paused'].includes(value.status) || !Array.isArray(value.sourceKeys)) throw fail('时间事项身份或字段无效。');
    const refs = value.sourceKeys.map(key => sources.get(key));
    const old = value.itemId ? prior.get(value.itemId) : null;
    if (refs.some(ref => !ref || ref.subjectEntityId !== value.subjectEntityId) || (value.itemId && (!old || old.subjectEntityId !== value.subjectEntityId || old.type !== value.type)) || (!old && !refs.length)) throw fail('时间事项来源无效。');
    const newest = [...refs].sort((a, b) => b.assistantSeq - a.assistantSeq)[0];
    const hasObservation = Boolean(newest);
    const observationTime = newest?.observationTime ?? old.observationTime;
    const observedOccurrence = projectTime(value.occurrenceTime, observationTime);
    const occurrenceTime = old && !(value.type === 'cycle' && hasObservation && observedOccurrence.date) ? old.occurrenceTime : observedOccurrence;
    const periodDays = Number.isInteger(value.periodDays) && value.periodDays > 0 && value.periodDays <= 3660 ? value.periodDays : old?.periodDays ?? null;
    const dueTime = value.type === 'cycle' && periodDays && occurrenceTime?.date ? shiftTime(occurrenceTime, periodDays) : hasObservation ? projectTime(value.dueTime, observationTime) : old.dueTime;
    const id = old?.id ?? `time-${(await timeFingerprint([value.subjectEntityId, value.type, value.sourceKeys, value.label])).slice(7, 39)}`;
    if (ids.has(id)) throw fail('时间事项重复。');
    ids.add(id);
    if (hasObservation && !text(value.observation)) throw fail('时间事项缺少原观察。');
    const observationKey = hasObservation ? await timeFingerprint([value.sourceKeys, value.observation]) : old.observationKey;
    const allowedStates = new Map((prepared.request.currentStates ?? []).filter(state => state.subjectEntityId === value.subjectEntityId).map(state => [`${state.stateId}|${state.sourceFloorId}`, state]));
    const stateRefs = hasObservation ? (Array.isArray(value.stateRefs) ? value.stateRefs : []).filter(ref => allowedStates.has(`${ref.stateId}|${ref.sourceFloorId}`) && refs.some(source => source.floorId === ref.sourceFloorId)).map(ref => ({ stateId: ref.stateId, sourceFloorId: ref.sourceFloorId, stateText: allowedStates.get(`${ref.stateId}|${ref.sourceFloorId}`).text, sourceDeltaId: allowedStates.get(`${ref.stateId}|${ref.sourceFloorId}`).sourceDeltaId ?? null })) : old.stateRefs;
    changes.push({ id, subjectEntityId: value.subjectEntityId, type: value.type, label: text(value.label, 150), status: value.status,
      observation: hasObservation ? text(value.observation) : old.observation, observationKey, periodDays,
      previousObservationKey: old?.observationKey ?? null, observationTime, occurrenceTime, dueTime,
      sourceRefs: hasObservation ? [...refs.map(ref => ({ floorId: ref.floorId, memoryId: ref.memoryId, sourceKey: ref.sourceKey })), ...(prepared.request.context ?? []).filter(row => !refs.some(ref => ref.floorId === row.floorId)).map(row => ({ floorId: row.floorId, memoryId: row.memoryId }))] : old.sourceRefs,
      stateRefs, projection: text(value.progression) && value.status === 'active'
        && ((!hasObservation && old && bodyProjectionDue(observationTime, prepared.request.currentTime))
          || hasObservation && value.type === 'body' && bodyProjectionDue(observationTime, prepared.request.currentTime)) ? {
        text: text(value.progression), applicableTime: prepared.request.currentTime, applicableFloorId: prepared.cutoffFloorId, observationKey,
      } : null });
  }
  const dependencies = [...new Map(changes.flatMap(item => item.sourceRefs).map(ref => [ref.floorId, { floorId: ref.floorId, memoryId: ref.memoryId }])).values()];
  return { schemaVersion: 1, chatId: prepared.request.chatId, id: `v3-time-batch-${(await timeFingerprint([prepared.signature, batches.length])).slice(7, 39)}`,
    signature: prepared.signature, currentTime: prepared.request.currentTime, cutoffFloorId: prepared.cutoffFloorId, cutoffAssistantSeq: prepared.cutoffAssistantSeq,
    sourceKeys: prepared.sourceKeys, dependencies, changes };
}

export function timeRecallProjection(items, source, currentTime) {
  const names = new Map(source.entities.map(entity => [entity.entityId, entity.displayName]));
  const states = source.currentState.flatMap(subject => ['core', 'adaptive', 'situational'].flatMap(layer => subject[layer].map(state => ({ ...state, subjectEntityId: subject.subjectEntityId }))));
  const corrections = {}, reminders = [];
  const mapped = items.map(item => ({ ...item, subjectEntityId: resolveIdentityEntityId(item.subjectEntityId, source.identityProjection) }));
  for (const item of mapped) {
    if (item.status !== 'active' || !names.has(item.subjectEntityId)) continue;
    const since = timeDistance(item.occurrenceTime, currentTime);
    const observed = `原观察（${item.observationTime?.date || item.observationTime?.raw || '时间未知'}${item.observationTime?.clock ? ` ${item.observationTime.clock}` : ''}）：${item.observation}`;
    const hours = timeHours(item.occurrenceTime, currentTime);
    const observationDays = timeDistance(item.observationTime, currentTime), observationHours = timeHours(item.observationTime, currentTime);
    const elapsed = since !== null && since >= 0 ? `；已过${since}天（第${since + 1}天）${hours !== null && hours >= 0 ? `，经过${Math.round(hours * 10) / 10}小时` : ''}` : `；发生后经过时间未知${observationDays !== null && observationDays >= 0 ? `；观察后已过${observationDays}天${observationHours !== null && observationHours >= 0 ? `，经过${Math.round(observationHours * 10) / 10}小时` : ''}` : ''}`;
    const validProjection = validTimeProjection(item, currentTime);
    const corrected = `${observed}${elapsed}；${validProjection ? `当前推测（${item.projection.applicableTime.date}${item.projection.applicableTime.clock ? ` ${item.projection.applicableTime.clock}` : ''}）：${item.projection.text}` : '当前状态待新观察确认'}`;
    let matchedState = false;
    for (const ref of item.stateRefs ?? []) {
      const match = states.find(state => state.stateId === ref.stateId && state.sourceFloorId === ref.sourceFloorId && state.subjectEntityId === item.subjectEntityId && (ref.stateText === undefined || state.text === ref.stateText) && (ref.sourceDeltaId === undefined || (state.sourceDeltaId ?? null) === ref.sourceDeltaId));
      if (match) { matchedState = true; corrections[`${ref.stateId}|${item.subjectEntityId}|${ref.sourceFloorId}`] = { itemId: item.id, text: corrected }; }
    }
    if (item.type === 'body' && validProjection && !matchedState) reminders.push({ itemId: item.id, distance: 0, text: `时间状态参考 / ${names.get(item.subjectEntityId)} / ${item.label}：${corrected}` });
    const due = nextCycleTime(item, currentTime);
    const distance = timeDistance(currentTime, due);
    if (['cycle', 'deadline'].includes(item.type) && distance !== null && distance <= 7) reminders.push({ itemId: item.id, distance,
      text: `${names.get(item.subjectEntityId)} / ${item.label}：${observed}；${item.type === 'cycle' ? '预计周期日' : '约定期限'} ${due.date}${due.clock ? ` ${due.clock}` : ''}${item.type === 'cycle' && due.date !== item.dueTime.date ? `（上次预计 ${item.dueTime.date} 尚未确认）` : ''}，${distance > 0 ? `还有${distance}天` : distance === 0 ? '已到本日' : `已过${-distance}天`}；尚未确认发生或完成。` });
  }
  reminders.sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance));
  return { corrections, reminders, currentTime };
}
