import { selectRecallMemories } from './recall-source.js';
import { rankRecallDocuments } from './recall-ranking.js';
import { buildEntityIdentityDirectory, normalizeIdentityProjection, resolveIdentityEntityId } from './entity-identity.js';
import { memorySourceFloorIds } from './memory-schema.js';
import { PEOPLE_PROFILE_FIELDS } from './people-profile-fields.js';

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

function fitLines(lines, budget) {
  const output = [];
  let used = 0, omitted = false;
  for (const line of lines) {
    const extra = line.length + (output.length ? 1 : 0);
    if (used + extra > budget) { omitted = true; continue; }
    output.push(line); used += extra;
  }
  return { text: output.join('\n'), used, omitted };
}

export function buildPublicContext({ reachable, peopleState, currentStates, identity, query = '', entityIds = [], maxCharacters = 12000 } = {}) {
  if (!reachable?.root || !Array.isArray(reachable.floors) || !Array.isArray(reachable.floorMemories)) {
    return { status: 'not-ready', identity, anchor: null, routerText: '', actors: [], coverage: { partial: false, cseStatus: 'not-ready', selectedCharacters: 0, maxCharacters: 0 } };
  }
  const limit = Number.isFinite(Number(maxCharacters)) ? Math.max(0, Math.min(40000, Math.floor(Number(maxCharacters)))) : 12000;
  const projection = normalizeIdentityProjection(peopleState ?? {});
  const directory = buildEntityIdentityDirectory({ entities: reachable.entities ?? [], identityProjection: projection });
  const peopleById = new Map(directory.filter(entry => entry.entityType === 'person').map(entry => [entry.entityId, entry]));
  const selected = [...new Set((entityIds ?? []).map(id => resolveIdentityEntityId(id, projection)).filter(id => peopleById.has(id)))];
  const profilesById = new Map((peopleState?.people ?? []).map(person => [resolveIdentityEntityId(person.entityId, projection), person]));
  const floorById = new Map(reachable.floors.map(floor => [floor.id, floor]));
  const { activeMemories } = selectRecallMemories(reachable);
  const queryText = clean(query, 8000);
  const queries = queryText ? [{ key: 'topic', text: queryText, weight: 1 }] : [];
  const summaries = activeMemories.map(memory => ({ memory, text: clean(effectiveSummary(memory)), manual: memory.summary?.effectiveSource === 'user', seq: sourceSeq(memory, floorById) }))
    .filter(item => item.text);
  const summaryScores = rankRecallDocuments({ documents: summaries.map((item, index) => ({ id: index, text: item.text })), queries });
  const summaryScore = new Map(summaryScores.map(item => [item.id, item.score]));
  const rankedSummaries = summaries.map((item, index) => ({ ...item, score: summaryScore.get(index) ?? 0 }))
    .filter(item => !queryText || item.score > 0)
    .sort((a, b) => queryText ? b.score - a.score || Number(b.manual) - Number(a.manual) || b.seq - a.seq : Number(b.manual) - Number(a.manual) || b.seq - a.seq);
  const routerBudget = Math.min(Math.floor(limit * 0.25), 3000);
  const routerHeader = '[作者侧已发生背景与摘要；仅供调度参考，不代表房间人物均已知]';
  const router = fitLines(rankedSummaries.map(item => `- ${item.manual ? '人工摘要' : '楼层摘要'}（${sourceLabel(item.memory, floorById)}；记忆 ${item.memory.id}）：${item.text}`), Math.max(0, routerBudget - routerHeader.length - 1));
  const routerText = router.text ? `${routerHeader}\n${router.text}` : '';
  let partial = router.omitted;
  let remaining = Math.max(0, limit - routerText.length);
  const actorResults = [];
  const stateSubjects = new Map((currentStates?.subjects ?? []).map(subject => [resolveIdentityEntityId(subject.subjectEntityId, projection), subject]));
  for (let actorIndex = 0; actorIndex < selected.length; actorIndex++) {
    const entityId = selected[actorIndex];
    const actorBudget = Math.floor(remaining / (selected.length - actorIndex));
    const person = profilesById.get(entityId);
    const profile = person?.profile;
    const manualFields = new Set(profile?.manualFields ?? []);
    const fields = [...PEOPLE_PROFILE_FIELDS].sort((a, b) => Number(manualFields.has(b)) - Number(manualFields.has(a)));
    const effectiveFields = { ...profile, aliases: peopleById.get(entityId).aliases.join('、') };
    const profileLines = fields.map(field => clean(effectiveFields[field]) ? `- ${field}：${clean(effectiveFields[field])}` : '').filter(Boolean);
    const profileFit = fitLines(profileLines, Math.floor(actorBudget * 0.4));
    const state = stateSubjects.get(entityId), stateLines = [];
    for (const [label, items] of [['核心', state?.core], ['经历变化', state?.adaptive], ['当前情境', state?.situational]]) for (const item of items ?? []) {
      const text = clean(item.text);
      const visibility = item.visibility === 'authorial' ? '作者塑造参考，不代表人物知情' : item.visibility === 'private' ? '本人私密状态' : item.visibility === 'shared' ? '已共享' : item.visibility === 'expressed' ? '已表达' : '可观察';
      const source = item.sourceAssistantSeq ? `AI #${item.sourceAssistantSeq}` : item.sourceFloorId ?? '来源未知';
      const toward = item.towardEntityId ? `；态度对象：${item.towardEntityId}` : '';
      stateLines.push(`- ${label} / ${visibility}（${source}）：${text}${toward}${item.reason ? `；依据：${clean(item.reason)}` : ''}`);
    }
    const stateFit = fitLines(stateLines, Math.floor(actorBudget * 0.3));
    const docs = [];
    for (const memory of activeMemories) docs.push(...actorDocuments(memory, entityId, id => peopleById.get(id)?.displayName ?? '未知人物', projection, floorById));
    const scores = rankRecallDocuments({ documents: docs.map(item => ({ id: item.id, text: item.text })), queries });
    const scoreById = new Map(scores.map(item => [item.id, item.score]));
    const rankedDocs = docs.filter(item => !queryText || (scoreById.get(item.id) ?? 0) > 0)
      .sort((a, b) => queryText ? (scoreById.get(b.id) ?? 0) - (scoreById.get(a.id) ?? 0) || b.seq - a.seq : b.seq - a.seq);
    const memoryBudget = Math.max(0, actorBudget - profileFit.used - stateFit.used);
    const memoryFit = fitLines(rankedDocs.map(item => `- ${item.text}`), memoryBudget);
    const includedDocs = rankedDocs.filter(item => memoryFit.text.split('\n').includes(`- ${item.text}`));
    const used = profileFit.used + stateFit.used + memoryFit.used;
    remaining -= used;
    partial ||= profileFit.omitted || stateFit.omitted || memoryFit.omitted;
    actorResults.push({
      entityId,
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
    actors: actorResults,
    coverage: { partial, cseStatus: currentStates?.status ?? 'not-ready', selectedCharacters, maxCharacters: limit, memoryFloors: activeMemories.length, candidateSummaries: rankedSummaries.length },
  });
}
