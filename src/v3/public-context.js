import { selectRecallMemories } from './recall-source.js';
import { rankRecallDocuments } from './recall-ranking.js';
import { buildEntityIdentityDirectory, deriveUserIdentityProjection, resolveIdentityEntityId } from './entity-identity.js';
import { memorySourceFloorIds } from './memory-schema.js';
import { PEOPLE_PROFILE_FIELDS, hasPeopleProfileMaterial } from './people-profile-fields.js';

const clean = (value, limit = 12000) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
const effectiveSummary = memory => memory?.summary?.effectiveSource === 'user' ? memory.summary.userText ?? '' : memory?.summary?.aiText ?? '';
const sourceFloorIds = memory => memorySourceFloorIds(memory);
const sourceSeq = (memory, floorById) => Math.max(0, ...sourceFloorIds(memory).map(id => floorById.get(id)?.assistantSeq ?? 0));
const sourceLabel = (memory, floorById) => sourceFloorIds(memory).map(id => floorById.get(id)?.assistantSeq).filter(Number.isSafeInteger).map(seq => `AI #${seq}`).join('、') || `记忆 ${memory.id}`;
const sourced = (label, text, memory, floorById) => `${label}（${sourceLabel(memory, floorById)}；记忆 ${memory.id}）：${clean(text)}`;

function actorDocuments(memory, actorId, displayFor, projection, floorById) {
  const docs = [];
  for (const action of memory.actions ?? []) {
    if (resolveIdentityEntityId(action.actorEntityId, projection) !== actorId) continue;
    const completion = ({ intended: '打算', attempted: '尝试', completed: '完成', interrupted: '中断', uncertain: '结果未定' })[action.completion] ?? '行动';
    docs.push(sourced('本人行动', `${completion}「${action.action}」${action.result ? `；结果：${action.result}` : ''}`, memory, floorById));
  }
  for (const item of memory.privateCognition ?? []) if (resolveIdentityEntityId(item.ownerEntityId, projection) === actorId) {
    docs.push(sourced('本人私密想法', item.content, memory, floorById));
  }
  for (const item of memory.informationTransfers ?? []) {
    if (!(item.toEntityIds ?? []).some(id => resolveIdentityEntityId(id, projection) === actorId)) continue;
    docs.push(sourced(`明确传给${displayFor(actorId)}的信息`, `${item.claimText}${item.channel ? `（渠道：${item.channel}）` : ''}`, memory, floorById));
  }
  for (const item of memory.commitments ?? []) {
    const speaker = resolveIdentityEntityId(item.speakerEntityId, projection);
    const target = (item.targetEntityIds ?? []).some(id => resolveIdentityEntityId(id, projection) === actorId);
    if (speaker !== actorId && !target) continue;
    const status = ({ accepted: '已接受，尚不代表履行', refused: '已拒绝', pending: '待定', uncertain: '是否成立未定' })[item.status] ?? clean(item.status, 80);
    docs.push(sourced(speaker === actorId ? '本人作出的承诺或计划' : '明确接收的承诺或计划', `${item.kind === 'plan' ? '计划' : '承诺'}「${item.content}」（${status}）`, memory, floorById));
  }
  for (const item of memory.openLoops ?? []) {
    if (!(item.ownerEntityIds ?? []).some(id => resolveIdentityEntityId(id, projection) === actorId)) continue;
    docs.push(sourced('来源楼当时未结，后文可能已推进，以后文为准', item.description, memory, floorById));
  }
  return docs.map((text, index) => ({ id: `${memory.id}:${actorId}:${index}`, text, memory, seq: sourceSeq(memory, floorById) }));
}

function fitLines(lines, budget, maxLines = Infinity) {
  const output = [], indices = [];
  let used = 0, omitted = false;
  for (const [index, line] of lines.entries()) {
    if (output.length >= maxLines) { omitted = true; break; }
    const extra = line.length + (output.length ? 1 : 0);
    if (used + extra > budget) { omitted = true; continue; }
    output.push(line); indices.push(index); used += extra;
  }
  return { text: output.join('\n'), used, omitted, indices };
}

function namedPeople(people, participantNames, query) {
  const ids = new Set(), byName = new Map();
  for (const role of ['user', 'char']) {
    const candidates = people.filter(person => person.specialRole === role);
    if (candidates.length === 1) ids.add(candidates[0].entityId);
  }
  for (const person of people) for (const name of [person.displayName, ...(person.aliases ?? [])]) {
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, new Set());
    byName.get(name).add(person.entityId);
  }
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  const text = [...participantNames.filter(name => typeof name === 'string'), query].join('\n');
  const word = value => /[a-z0-9_]/i.test(value || '');
  for (let at = 0; at < text.length;) {
    const name = names.find(value => text.startsWith(value, at)
      && !(word(value[0]) && word(text[at - 1])) && !(word(value.at(-1)) && word(text[at + value.length])));
    if (!name) { at += text.codePointAt(at) > 0xffff ? 2 : 1; continue; }
    const candidates = byName.get(name);
    if (candidates.size === 1) ids.add([...candidates][0]);
    at += name.length;
  }
  return [...ids];
}

function profileLinesFor(person, entry, floorById) {
  const storedProfile = person?.profile;
  const profile = storedProfile ? structuredClone({
    ...Object.fromEntries(PEOPLE_PROFILE_FIELDS.map(field => [field, storedProfile[field]])),
    manualFields: storedProfile.manualFields,
  }) : null;
  const manualFields = new Set(profile?.manualFields ?? []);
  const fields = [...PEOPLE_PROFILE_FIELDS].sort((a, b) => Number(manualFields.has(b)) - Number(manualFields.has(a)));
  const effectiveFields = { ...profile, aliases: entry.aliases.join('、') };
  const profileLines = profile ? fields.map(field => manualFields.has(field)
    ? `- ${field}（人工决定）：${clean(effectiveFields[field]) || '已明确清空，不补填'}`
    : clean(effectiveFields[field]) ? `- ${field}：${clean(effectiveFields[field])}` : '').filter(Boolean) : [];
  const hasProtectedProfile = hasPeopleProfileMaterial(profile) || [...manualFields].some(field => field !== 'name' && field !== 'aliases');
  if (!hasProtectedProfile && entry.identityBrief) {
    const source = entry.identityBriefSource;
    const label = source?.legacy ? '历史简介，未记录引文' : '有据身份简介';
    const seq = floorById.get(source?.sourceFloorId)?.assistantSeq;
    profileLines.push(`- ${label}${seq ? `（AI #${seq}）` : ''}：${clean(entry.identityBrief, 400)}（作者侧记忆，不代表在场或知情）`);
  }
  return profileLines;
}

function stateLinesFor(subject) {
  const state = structuredClone(Object.fromEntries(['core', 'adaptive', 'situational'].map(layer => [layer,
    (subject?.[layer] ?? []).map(item => ({ text: item.text, visibility: item.visibility, reason: item.reason,
      sourceAssistantSeq: item.sourceAssistantSeq, sourceFloorId: item.sourceFloorId, towardEntityId: item.towardEntityId })),
  ])));
  const stateLines = [];
  for (const [label, items] of [['核心', state?.core], ['经历变化', state?.adaptive], ['当前情境', state?.situational]]) for (const item of items ?? []) {
    const text = clean(item.text);
    const visibility = item.visibility === 'authorial' ? '作者塑造参考，不代表人物知情' : item.visibility === 'private' ? '本人私密状态' : item.visibility === 'shared' ? '已共享' : item.visibility === 'expressed' ? '已表达' : '可观察';
    const source = item.sourceAssistantSeq ? `AI #${item.sourceAssistantSeq}` : item.sourceFloorId ?? '来源未知';
    const toward = item.towardEntityId ? `；态度对象：${item.towardEntityId}` : '';
    stateLines.push(`- ${label} / ${visibility}（${source}）：${text}${toward}${item.reason ? `；依据：${clean(item.reason)}` : ''}`);
  }
  return stateLines;
}

export function buildPublicContext({
  reachable, peopleState, currentStates, currentStateProvider, identity,
  query = '', focusQuery = '', entityIds = [], participantNames = [],
  maxCharacters = 12000, maxSummaries = null, summaryCharacters = null, recentSummaries = 0,
} = {}) {
  if (!reachable?.root || !Array.isArray(reachable.floors) || !Array.isArray(reachable.floorMemories)) {
    return { status: 'not-ready', identity, anchor: null, routerText: '', actors: [], coverage: { partial: false, cseStatus: 'not-ready', selectedCharacters: 0, maxCharacters: 0 } };
  }
  const limit = Number.isFinite(Number(maxCharacters)) ? Math.max(0, Math.min(40000, Math.floor(Number(maxCharacters)))) : 12000;
  const floorById = new Map(reachable.floors.map(floor => [floor.id, floor]));
  let projection = null, directory = [], profilesById = new Map(), profileLinesById = new Map(), peopleUnavailable = false;
  try {
    if (['error', 'unavailable', 'not-ready', 'disabled', 'idle'].includes(peopleState?.status)
      || peopleState?.status === 'loading' && !(Array.isArray(peopleState.people) && peopleState.people.length)) throw new Error('人物资料不可用');
    projection = deriveUserIdentityProjection({ ...reachable, identityProjection: peopleState });
    directory = buildEntityIdentityDirectory({ entities: reachable.entities ?? [], floorOrder: new Map(reachable.floors.map((floor, index) => [floor.id, index])), identityProjection: projection });
    profilesById = new Map((peopleState?.people ?? []).map(person => [resolveIdentityEntityId(person.entityId, projection), person]));
  } catch {
    // Unknown manual identity data cannot authorize restoring automatic actors.
    peopleUnavailable = true; projection = null; directory = []; profilesById.clear(); profileLinesById.clear();
  }
  const peopleById = new Map(directory.filter(entry => entry.entityType === 'person').map(entry => [entry.entityId, entry]));
  const { activeMemories } = selectRecallMemories(reachable);
  const summaries = activeMemories.map(memory => ({ memory, text: clean(effectiveSummary(memory)), manual: memory.summary?.effectiveSource === 'user', seq: sourceSeq(memory, floorById) }))
    .filter(item => item.text);
  const summaryLimit = maxSummaries !== null && Number.isFinite(Number(maxSummaries)) ? Math.max(0, Math.floor(Number(maxSummaries))) : Infinity;
  const recentCount = Number.isFinite(Number(recentSummaries)) ? Math.max(0, Math.floor(Number(recentSummaries))) : 0;
  const recent = recentCount > 0 ? summaries.slice().sort((a, b) => b.seq - a.seq).slice(0, Math.min(summaryLimit, recentCount)) : [];
  const queryText = clean(query, 8000);
  const names = Array.isArray(participantNames) ? participantNames.filter(name => typeof name === 'string').slice(0, 100).map(name => clean(name, 500)).filter(Boolean) : [];
  let selected = [...new Set([
    ...(entityIds ?? []).map(id => resolveIdentityEntityId(id, projection)).filter(id => peopleById.has(id)),
    ...(names.length ? namedPeople([...peopleById.values()], names, [queryText, ...recent.map(item => item.text)].join('\n')) : []),
  ])].slice(0, 100);
  try {
    profileLinesById = new Map(selected.map(id => [id, profileLinesFor(profilesById.get(id), peopleById.get(id), floorById)]));
    for (const id of selected) {
      const person = profilesById.get(id);
      if (person) profilesById.set(id, { displayName: structuredClone(person.displayName) });
    }
  } catch { peopleUnavailable = true; selected = []; }
  let actorStates, stateLinesById = new Map();
  try {
    const value = typeof currentStateProvider === 'function' ? currentStateProvider(selected) : currentStates;
    actorStates = { status: value?.status };
    const selectedIds = new Set(selected);
    stateLinesById = new Map((value?.subjects ?? []).filter(subject => selectedIds.has(resolveIdentityEntityId(subject.subjectEntityId, projection)))
      .map(subject => [resolveIdentityEntityId(subject.subjectEntityId, projection), stateLinesFor(subject)]));
  } catch { actorStates = { status: 'error' }; }
  const queries = queryText ? [{ key: 'topic', text: queryText, weight: 1 }] : [];
  const focusText = clean(focusQuery, 2000);
  if (focusText) queries.push({ key: 'focus', text: focusText, weight: 2 });
  const hasQuery = queries.length > 0;
  const summaryScores = rankRecallDocuments({ documents: summaries.map((item, index) => ({ id: index, text: item.text })), queries });
  const summaryScore = new Map(summaryScores.map(item => [item.id, item.score]));
  const rankedSummaries = summaries.map((item, index) => ({ ...item, score: summaryScore.get(index) ?? 0 }))
    .filter(item => !hasQuery || item.score > 0)
    .sort((a, b) => hasQuery ? b.score - a.score || Number(b.manual) - Number(a.manual) || b.seq - a.seq : Number(b.manual) - Number(a.manual) || b.seq - a.seq);
  const recentIds = new Set(recent.map(item => item.memory.id));
  const summaryCandidates = [...recent, ...rankedSummaries.filter(item => !recentIds.has(item.memory.id))];
  const routerBudget = summaryCharacters !== null && Number.isFinite(Number(summaryCharacters))
    ? Math.max(0, Math.min(limit, Math.floor(Number(summaryCharacters)))) : Math.min(Math.floor(limit * 0.25), 3000);
  const routerHeader = '[作者侧已发生背景与摘要；仅供调度参考，不代表房间人物均已知]';
  const summaryLines = summaryCandidates.map(item => `- ${item.manual ? '人工摘要' : '楼层摘要'}（${sourceLabel(item.memory, floorById)}；记忆 ${item.memory.id}）：${item.text}`);
  const router = fitLines(summaryLines, Math.max(0, routerBudget - routerHeader.length - 1), summaryLimit);
  if (maxSummaries !== null) router.indices.sort((a, b) => summaryCandidates[a].seq - summaryCandidates[b].seq);
  const routerText = router.text ? `${routerHeader}\n${router.indices.map(index => summaryLines[index]).join('\n')}` : '';
  let partial = router.omitted || peopleUnavailable || actorStates?.status === 'error';
  let remaining = Math.max(0, limit - routerText.length);
  const actorResults = [];
  for (let actorIndex = 0; actorIndex < selected.length; actorIndex++) {
    const entityId = selected[actorIndex];
    const actorBudget = Math.floor(remaining / (selected.length - actorIndex));
    const person = profilesById.get(entityId);
    const profileLines = profileLinesById.get(entityId) ?? [];
    const profileFit = fitLines(profileLines, Math.floor(actorBudget * 0.4));
    const stateLines = stateLinesById.get(entityId) ?? [];
    const stateFit = fitLines(stateLines, Math.floor(actorBudget * 0.3));
    const docs = [];
    for (const memory of activeMemories) docs.push(...actorDocuments(memory, entityId, id => peopleById.get(id)?.displayName ?? '未知人物', projection, floorById));
    const scores = rankRecallDocuments({ documents: docs.map(item => ({ id: item.id, text: item.text })), queries });
    const scoreById = new Map(scores.map(item => [item.id, item.score]));
    const rankedDocs = docs.filter(item => !hasQuery || (scoreById.get(item.id) ?? 0) > 0)
      .sort((a, b) => hasQuery ? (scoreById.get(b.id) ?? 0) - (scoreById.get(a.id) ?? 0) || b.seq - a.seq : b.seq - a.seq);
    const memoryBudget = Math.max(0, actorBudget - profileFit.used - stateFit.used);
    const memoryFit = fitLines(rankedDocs.map(item => `- ${item.text}`), memoryBudget);
    const includedDocs = rankedDocs.filter(item => memoryFit.text.split('\n').includes(`- ${item.text}`));
    const used = profileFit.used + stateFit.used + memoryFit.used;
    remaining -= used;
    partial ||= profileFit.omitted || stateFit.omitted || memoryFit.omitted;
    actorResults.push({
      entityId,
      displayName: person?.displayName || peopleById.get(entityId).displayName,
      profileText: profileFit.text,
      stateText: stateFit.text,
      memoryText: memoryFit.text,
      refs: [...new Map(includedDocs.map(item => [item.memory.id, { floorIds: sourceFloorIds(item.memory), memoryId: item.memory.id }])).values()],
    });
  }
  const selectedCharacters = routerText.length + actorResults.reduce((sum, actor) => sum + actor.profileText.length + actor.stateText.length + actor.memoryText.length, 0);
  return structuredClone({
    status: 'ready', identity,
    anchor: { narrativeGeneration: reachable.root.narrativeGeneration, headCheckpointId: reachable.root.headCheckpointId, rootRevision: reachable.rootRevision },
    routerText,
    selectedEntityIds: selected,
    actors: actorResults,
    coverage: { partial, cseStatus: actorStates?.status ?? 'not-ready', selectedCharacters, maxCharacters: limit, memoryFloors: activeMemories.length, candidateSummaries: summaryCandidates.length },
  });
}
