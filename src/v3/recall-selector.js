const MAX_QUERY_CHARACTERS = 8000;
const MAX_RECALLED_FLOORS = 48;
const MAX_TOTAL_ITEMS = 48;
const MAX_CSE_ITEMS = 24;
const MAX_LINKED_FLOORS = 12;
const MAX_STORYLINES = 3;
const MAX_STORYLINE_HISTORY_ITEMS = 8;
const MAX_RECALL_TOKENS = 4000;
const MAX_RECALL_CHARACTERS = 16000;
const MAX_RECALL_WITH_PROGRESSION_TOKENS = 5000;
const MAX_RECALL_WITH_PROGRESSION_CHARACTERS = 20000;
export const RECENT_CONTINUITY_FLOORS = 4;
export const MAX_LLM_HISTORY_CANDIDATES = 48;
export const MAX_LLM_HISTORY_CHARACTERS = 24000;
export const MAX_LLM_CSE_CANDIDATES = 24;
export const MAX_LLM_CSE_CHARACTERS = 12000;
const HISTORY_GROUP_WEIGHTS = Object.freeze({ summary: 1, continuity: 1, fact: 2 });
import { rankRecallDocuments, tokenizeRecallText } from './recall-ranking.js';
import { formatChronologyAnchor } from './recall-source.js';

const clean = (value, maximum = 4000) => String(value ?? '').normalize('NFKC').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);
const cleanLiteral = (value, maximum = 4000) => String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);
const compact = value => clean(value, 12000).toLocaleLowerCase('zh-CN').replace(/[^\p{L}\p{N}]+/gu, '');
const playable = message => {
  if (!message || message.is_system === true || message.is_hidden === true || message.hidden === true || (message.is_user !== true && message.is_user !== false)) return false;
  const text = message.mes;
  return typeof text === 'string' && Boolean(text.trim());
};
const entityLabels = entity => [entity.displayName, ...(entity.aliases ?? [])].map(value => clean(value, 500)).filter(Boolean);
const genericAlias = value => /^(?:\{\{user\}\}|\{\{char\}\}|user|char|player|你|用户|主角)$/iu.test(value);

// The host does not expose a local tokenizer here. This intentionally errs on
// the high side for CJK text and is stored as an estimate in the receipt/UI.
export function estimateRecallTokens(value) {
  const text = String(value ?? '');
  let total = 0, latinRun = 0;
  const flushLatin = () => { if (latinRun) { total += Math.ceil(latinRun / 4); latinRun = 0; } };
  for (const character of text) {
    if (/^[A-Za-z0-9_]$/u.test(character)) { latinRun += 1; continue; }
    flushLatin();
    if (/\s/u.test(character)) continue;
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(character)) total += 1;
    else total += 0.5;
  }
  flushLatin();
  return Math.ceil(total);
}

function boundedRecallBudget(contextSize, { reservedTokens = 0, reservedCharacters = 0 } = {}, { maxTokens, maxCharacters }) {
  const size = Number(contextSize) || 8192;
  const totalCharacters = Math.max(800, Math.min(maxCharacters, Math.floor(size * 0.55)));
  const totalTokens = Math.max(800, Math.min(maxTokens, Math.floor(size * 0.48)));
  return Object.freeze({
    totalCharacters,
    totalTokens,
    characterLimit: Math.max(0, totalCharacters - Math.max(0, Math.floor(Number(reservedCharacters) || 0))),
    tokenLimit: Math.max(0, totalTokens - Math.max(0, Math.floor(Number(reservedTokens) || 0))),
  });
}

export function recallBudget(contextSize = 8192, reserved = {}) {
  return boundedRecallBudget(contextSize, reserved, { maxTokens: MAX_RECALL_TOKENS, maxCharacters: MAX_RECALL_CHARACTERS });
}

function recallBudgetWithProgression(contextSize = 8192, reserved = {}) {
  return boundedRecallBudget(contextSize, reserved, { maxTokens: MAX_RECALL_WITH_PROGRESSION_TOKENS, maxCharacters: MAX_RECALL_WITH_PROGRESSION_CHARACTERS });
}

export function buildRecallQueryFrame({ coreChat = [], assistantTurns = 1 } = {}) {
  const chat = Array.isArray(coreChat) ? coreChat : [];
  let latestUser = null;
  for (let index = chat.length - 1; index >= 0; index -= 1) {
    if (playable(chat[index]) && chat[index].is_user === true) { latestUser = { message: chat[index], index }; break; }
  }
  if (!latestUser) return Object.freeze({ messages: Object.freeze([]), latestUserText: '', latestUserCoreIndex: null, assistantTurns: 0 });
  const turnLimit = Number.isSafeInteger(assistantTurns) && assistantTurns > 0 ? assistantTurns : 0;
  let selected = [latestUser];
  if (turnLimit > 0) {
    let assistantCount = 0;
    let precedingAssistantIndex = -1;
    for (let index = latestUser.index - 1; index >= 0; index -= 1) {
      const message = chat[index];
      if (!playable(message) || message.is_user !== false) continue;
      assistantCount += 1;
      if (assistantCount > turnLimit) { precedingAssistantIndex = index; break; }
    }
    if (assistantCount > 0) {
      selected = [];
      for (let index = precedingAssistantIndex + 1; index <= latestUser.index; index += 1) {
        const message = chat[index];
        if (playable(message)) selected.push({ message, index });
      }
    }
  }
  const messages = Object.freeze(selected.map(({ message, index }) => Object.freeze({ role: message.is_user ? 'user' : 'assistant', text: clean(message.mes, 4000), index })));
  return Object.freeze({
    messages,
    latestUserText: clean(latestUser.message.mes, 4000),
    latestUserCoreIndex: latestUser.index,
    assistantTurns: messages.filter(message => message.role === 'assistant').length,
  });
}

export function buildRecallQueryContext({ coreChat = [], assistantTurns = 1 } = {}) {
  const frame = buildRecallQueryFrame({ coreChat, assistantTurns });
  const parts = frame.messages.map(message => `${message.role === 'user' ? '用户' : 'AI'}：${message.text}`).filter(value => value.length > 3);
  const beforeLatest = frame.messages.filter(message => message.index !== frame.latestUserCoreIndex);
  const previousUser = [...beforeLatest].reverse().find(message => message.role === 'user');
  const recentAssistant = [...beforeLatest].reverse().find(message => message.role === 'assistant');
  return Object.freeze({
    text: clean(parts.join('\n'), MAX_QUERY_CHARACTERS),
    latestUserText: frame.latestUserText,
    recentAssistantText: clean(recentAssistant?.text, 4000),
    previousUserText: clean(previousUser?.text, 4000),
    backgroundText: clean(beforeLatest.map(message => `${message.role === 'user' ? '用户' : 'AI'}：${message.text}`).join('\n'), MAX_QUERY_CHARACTERS),
    latestUserCoreIndex: frame.latestUserCoreIndex,
    messageCount: frame.messages.length,
    assistantTurns: frame.assistantTurns,
  });
}

function item(category, text, priority, { preserveForm = false, ...extra } = {}) {
  const value = preserveForm ? cleanLiteral(text, 2000) : clean(text, 2000);
  return value ? { category, text: value, priority, ...extra } : null;
}

function actionDisplay(value) {
  const prefix = ({
    intended: '意图（尚未行动）：',
    attempted: '尝试过（未确认完成）：',
    completed: '已完成：',
    interrupted: '行动中断：',
    uncertain: '是否完成不确定：',
  })[value.completion] ?? '是否发生不确定：';
  return `${prefix}${value.action}${value.result ? `；记录结果：${value.result}` : ''}`;
}

function commitmentDisplay(value) {
  if (value.status === 'refused') return `来源楼当时已拒绝（不构成承诺；以后文为准）：${value.content}`;
  if (value.status === 'uncertain') return `来源楼当时是否成立不确定（不得当作有效承诺；以后文为准）：${value.content}`;
  if (value.kind === 'plan' && value.status === 'accepted') return `来源楼当时共同接受的计划（不代表如今尚未完成；以后文为准）：${value.content}`;
  if (value.kind === 'plan') return `来源楼当时的计划（不代表已告知、已完成或如今仍有效；以后文为准）：${value.content}`;
  if (value.status === 'accepted') return `来源楼当时已接受并成立（不代表如今尚未履行；以后文为准）：${value.content}`;
  return `来源楼当时已作出（不代表如今尚未履行；以后文为准）：${value.content}`;
}

const sameExactText = (left, right) => {
  const a = cleanLiteral(left, 2000), b = cleanLiteral(right, 2000);
  return Boolean(a && b && a === b);
};

function exactAnchorDisplay(anchor, { standalonePrivate = false } = {}) {
  const reason = cleanLiteral(anchor.whyPreserve, 1000);
  return `${standalonePrivate ? '仅该人物可用的' : ''}原句「${cleanLiteral(anchor.exactText, 2000)}」${reason ? `（${reason}）` : ''}`;
}

const entityNameText = (ids, entityById) => [...new Set((ids ?? []).filter(Boolean))]
  .flatMap(id => entityLabels(entityById.get(id) ?? {}).filter(label => !genericAlias(label))).join(' ');

function historyFacts(memory, entityById) {
  const result = [], anchorAssignments = new Map(), standaloneAnchors = [];
  const add = (value, rankText, involvedEntityIds, statusKey = '') => {
    if (!value) return;
    const visibilityKey = value.category === 'private' ? 'private' : ['shared', 'transfer'].includes(value.category) ? 'shared' : 'observable';
    result.push({ ...value, _rankText: rankText, _entityText: entityNameText(involvedEntityIds, entityById), _coreText: rankText, _summary: memory.summary, _subjectKey: [...new Set((involvedEntityIds ?? []).filter(Boolean))].sort().join(','), _visibilityKey: visibilityKey, _statusKey: statusKey, _sourceOrder: result.length });
  };
  const assignAnchor = (fact, anchor) => anchorAssignments.set(fact, [...(anchorAssignments.get(fact) ?? []), anchor]);
  for (const anchor of memory.exactAnchors) {
    const privateFact = memory.privateCognition.find(fact => sameExactText(fact.content, anchor.exactText) && (!anchor.speakerEntityId || fact.ownerEntityId === anchor.speakerEntityId));
    const transferFact = memory.informationTransfers.find(fact => sameExactText(fact.claimText, anchor.exactText) && (!anchor.speakerEntityId || !fact.fromEntityId || fact.fromEntityId === anchor.speakerEntityId));
    const commitmentFact = memory.commitments.find(fact => (fact.exactAnchorId === anchor.anchorId && (!anchor.speakerEntityId || fact.speakerEntityId === anchor.speakerEntityId))
      || (sameExactText(fact.content, anchor.exactText) && (!anchor.speakerEntityId || fact.speakerEntityId === anchor.speakerEntityId)));
    const boundaryFact = privateFact ?? transferFact ?? commitmentFact;
    if (boundaryFact) assignAnchor(boundaryFact, anchor);
    else if (anchor.speakerEntityId) standaloneAnchors.push(anchor);
  }
  const decorate = (text, fact) => {
    const anchors = anchorAssignments.get(fact) ?? [];
    if (!anchors.length) return text;
    if (anchors.length === 1 && sameExactText(text, anchors[0].exactText)) return exactAnchorDisplay(anchors[0]);
    return `${text}；${anchors.map(anchor => exactAnchorDisplay(anchor)).join('；')}`;
  };
  for (const anchor of standaloneAnchors) add(item('private', exactAnchorDisplay(anchor, { standalonePrivate: true }), 160, { kind: 'exactAnchor', anchorKind: anchor.kind, ownerEntityId: anchor.speakerEntityId, preserveForm: true }), anchor.exactText, [anchor.speakerEntityId]);
  for (const value of memory.commitments) {
    const isShared = value.targetEntityIds.length > 0 && value.status !== 'uncertain' && (value.kind !== 'plan' || value.status === 'accepted');
    add(item(isShared ? 'shared' : 'private', decorate(commitmentDisplay(value), value), 120, { kind: 'commitment', commitmentKind: value.kind, speakerEntityId: value.speakerEntityId, ownerEntityId: value.speakerEntityId, targetEntityIds: value.targetEntityIds, status: value.status, preserveForm: true }), `${value.content} ${(anchorAssignments.get(value) ?? []).map(anchor => anchor.exactText).join(' ')}`, [value.speakerEntityId, ...value.targetEntityIds], value.status);
  }
  for (const value of memory.openLoops) add(item('objective', `来源楼当时未结（后文可能已推进，以后文为准）：${value.description}`, 110, { kind: 'openLoop' }), value.description, value.ownerEntityIds);
  for (const value of memory.locations) add(item('objective', `地点：${value.name}（${value.change}）`, 100, { kind: 'location' }), value.name, [value.entityId, ...value.participantEntityIds], value.change);
  for (const value of memory.events) add(item('objective', `${value.title}：${value.description}`, 90, { kind: 'event' }), `${value.title} ${value.description}`, [], value.candidateStatus);
  for (const value of memory.actions) add(item('objective', actionDisplay(value), 75, { kind: 'action', actorEntityId: value.actorEntityId, targetEntityIds: value.targetEntityIds, completion: value.completion, preserveForm: true }), `${value.action} ${value.result ?? ''}`, [value.actorEntityId, ...value.targetEntityIds], value.completion);
  for (const value of memory.observations) add(item('objective', value.description, 70, { kind: 'observation', subjectEntityId: value.subjectEntityId }), value.description, [value.subjectEntityId]);
  for (const value of memory.privateCognition) add(item('private', decorate(value.content, value), 85, { kind: value.kind, ownerEntityId: value.ownerEntityId, preserveForm: anchorAssignments.has(value) }), `${value.content} ${(anchorAssignments.get(value) ?? []).map(anchor => anchor.exactText).join(' ')}`, [value.ownerEntityId]);
  for (const value of memory.informationTransfers) {
    const effectiveFromEntityId = value.fromEntityId ?? anchorAssignments.get(value)?.[0]?.speakerEntityId ?? null;
    const rankText = `${value.claimText} ${(anchorAssignments.get(value) ?? []).map(anchor => anchor.exactText).join(' ')}`;
    if (value.toEntityIds.length) add(item('transfer', decorate(value.claimText, value), 85, { kind: value.channel, fromEntityId: effectiveFromEntityId, toEntityIds: value.toEntityIds, preserveForm: anchorAssignments.has(value) }), rankText, [effectiveFromEntityId, ...value.toEntityIds]);
    else if (effectiveFromEntityId) add(item('private', decorate(`未确认已告知他人：${value.claimText}`, value), 75, { kind: value.channel, ownerEntityId: effectiveFromEntityId, preserveForm: anchorAssignments.has(value) }), rankText, [effectiveFromEntityId]);
  }
  return result.map(value => ({ ...value, floorId: memory.floorId, floorMemoryId: memory.floorMemoryId, assistantSeq: memory.assistantSeq, _chronology: memory.chronology, _poolGroup: ['commitment', 'openLoop'].includes(value.kind) ? 'continuity' : 'fact' }));
}

function historySummary(memory, entityById) {
  const fullText = clean(memory.summary, 12000);
  const truncated = fullText.length > 2000;
  const text = truncated ? `${fullText.slice(0, 1988)}…（摘要已截断）` : fullText;
  if (!text) return null;
  const involvedEntityIds = (memory.participants ?? []).map(item => item.entityId).filter(Boolean);
  return {
    category: 'narrative', kind: 'summary', text, priority: 130,
    floorId: memory.floorId, floorMemoryId: memory.floorMemoryId, assistantSeq: memory.assistantSeq,
    _rankText: text, _entityText: '', _coreText: text, _summary: text,
    _subjectKey: involvedEntityIds.sort().join(','), _visibilityKey: 'narrative', _statusKey: '', _sourceOrder: -1,
    _chronology: memory.chronology, _poolGroup: 'summary', truncated,
  };
}

function stateCandidates(source, involvedIds) {
  const entityById = new Map(source.entities.map(entity => [entity.entityId, entity]));
  const allowDynamic = source.coverage.cseCurrent === true;
  const result = [];
  for (const subject of source.currentState) {
    if (!involvedIds.has(subject.subjectEntityId)) continue;
    const entity = entityById.get(subject.subjectEntityId);
    if (!entity) continue;
    const layers = allowDynamic ? ['core', 'adaptive', 'situational'] : ['core'];
    for (const layer of layers) for (const value of subject[layer] ?? []) {
      const visibility = ['private', 'observable', 'expressed', 'shared', 'authorial'].includes(value.visibility) ? value.visibility : 'private';
      result.push({
        stateId: value.stateId ?? null,
        category: visibility === 'private' ? 'privateState' : visibility === 'authorial' ? 'authorialState' : visibility === 'expressed' || visibility === 'shared' ? 'sharedState' : 'objectiveState',
        subjectEntityId: subject.subjectEntityId,
        subject: entity.displayName,
        layer,
        towardEntityId: value.towardEntityId,
        toward: entityById.get(value.towardEntityId)?.displayName ?? null,
        text: value.text,
        reason: value.reason,
        visibility,
        sourceFloorId: value.sourceFloorId ?? null,
        sourceDeltaId: value.sourceDeltaId ?? null,
        sourceAssistantSeq: value.sourceAssistantSeq,
        priority: layer === 'core' ? 150 : layer === 'adaptive' ? 115 : 95,
        _rankText: `${value.text} ${value.reason}`,
        _entityText: entityNameText([subject.subjectEntityId, value.towardEntityId], entityById),
        _coreText: value.text,
        _subjectKey: subject.subjectEntityId,
        _visibilityKey: visibility,
        _statusKey: '',
      });
    }
  }
  return result;
}

function cseChangeCandidates(source, involvedIds) {
  const entityById = new Map(source.entities.map(entity => [entity.entityId, entity]));
  const actionText = { add: '新增', remove: '移除', update: '更新', refine: '调整' };
  const result = [];
  for (const value of source.cseChanges ?? []) {
    const towardIds = [value.before?.towardEntityId, value.after?.towardEntityId].filter(Boolean);
    if (!involvedIds.has(value.subjectEntityId) && !towardIds.some(id => involvedIds.has(id))) continue;
    const subject = entityById.get(value.subjectEntityId);
    if (!subject || !['core', 'adaptive', 'situational'].includes(value.layer) || !['add', 'remove', 'update', 'refine'].includes(value.action)) continue;
    const beforeText = value.before?.text ?? '';
    const afterText = value.after?.text ?? '';
    result.push({
      ...value,
      category: 'cseChange',
      subject: subject.displayName,
      before: value.before ? { ...value.before, toward: entityById.get(value.before.towardEntityId)?.displayName ?? null } : null,
      after: value.after ? { ...value.after, toward: entityById.get(value.after.towardEntityId)?.displayName ?? null } : null,
      priority: value.layer === 'core' ? 145 : value.layer === 'adaptive' ? 110 : 90,
      _rankText: `${actionText[value.action]} ${beforeText} ${afterText} ${value.before?.reason ?? ''} ${value.after?.reason ?? ''}`,
      _entityText: entityNameText([value.subjectEntityId, ...towardIds], entityById),
      _coreText: `${value.action}|${beforeText}|${afterText}`,
      _subjectKey: value.subjectEntityId,
      _visibilityKey: `${value.before?.visibility ?? ''}>${value.after?.visibility ?? ''}`,
      _statusKey: `${value.deltaId}|${value.layer}|${value.action}`,
      _recallCseKind: 'change',
    });
  }
  return result;
}

const entityName = (id, entityById) => entityById.get(id)?.displayName ?? '未知人物';

function appendStateProgressions(lines, stateProgressions, states) {
  if (!stateProgressions.length) return;
  lines.push('', '[时间推演（仅供作者续写表现参考，不是新剧情事实，也不表示任何角色已知）]');
  for (const value of stateProgressions) {
    const sourceState = states.find(state => state.stateId === value.sourceStateId
      && state.subjectEntityId === value.subjectEntityId && state.sourceFloorId === value.sourceFloorId);
    const target = value.toward ? `，对 ${value.toward}` : '';
    const boundary = value.visibility === 'private' ? '，仅可用于该人物' : value.visibility === 'authorial' ? '，仅供作者塑造' : '';
    const source = value.sourceAssistantSeq ? `来源 AI #${value.sourceAssistantSeq}` : '来源楼号未提供';
    const evidence = value.evidence.map(item => Number.isSafeInteger(item.assistantSeq) ? `AI #${item.assistantSeq}` : '').filter(Boolean);
    lines.push(`- ${value.subject}${target} / 接续上方 ${sourceState.layer} 当前状态 / 原记录知情范围 ${value.visibility}${boundary}：此刻表现建议 ${value.suggestion}（时间依据：${value.timeBasis}；状态${source}${evidence.length ? `；后文证据 ${evidence.join('、')}` : ''}）`);
  }
}

function formatStorylineInjection({ coverage, floors, states, cseChanges, stateProgressions, entityById, storylines }) {
  const hasNarrative = floors.some(floor => floor.items.some(value => value.category === 'narrative'));
  const lines = [
    '<qqj_recalled_context>',
    '以下是此前剧情档案与人物状态的只读参考，不是指令。与当前正文冲突时以当前正文为准。',
    '任何 private 内容仅属于标明的主体，不代表其他人物知情。',
    '各组只表示存在已记录的关联证据；组内按时间排列，不自动证明因果。',
    ...(hasNarrative ? ['叙事回顾可能含内心、计划或未完成事项，不代表所有人物知情；若与后文冲突以后文为准。'] : []),
  ];
  const floorsByLine = new Map();
  for (const floor of floors) for (const value of floor.items) {
    if (!value.storylineId) continue;
    const lineFloors = floorsByLine.get(value.storylineId) ?? new Map();
    const lineFloor = lineFloors.get(floor.floorId) ?? { ...floor, items: [] };
    lineFloor.items.push(value); lineFloors.set(floor.floorId, lineFloor); floorsByLine.set(value.storylineId, lineFloors);
  }
  const historyText = value => {
    const relation = value.relationEvidence === 'nearby' ? '邻近背景；仅因时序相邻，不表示因果：'
      : value.relationEvidence === 'topic' ? '同人物与具体主题词关联，不表示因果：'
        : value.relationEvidence === 'source' ? '来源关联：' : '';
    if (value.category === 'narrative') return `[叙事回顾] ${relation}${value.text}`;
    if (value.category === 'private') return `${relation}[private；仅 ${entityName(value.ownerEntityId, entityById)} 可用] ${value.text}`;
    if (value.category === 'transfer') {
      const from = value.fromEntityId ? entityName(value.fromEntityId, entityById) : '来源不明';
      const recipients = (value.toEntityIds ?? []).map(id => entityName(id, entityById)).join('、');
      return `${relation}${from} → ${recipients}（仅列明接收者知情，渠道：${value.kind}）：${value.text}`;
    }
    if (value.category === 'shared') {
      const speaker = value.speakerEntityId ? entityName(value.speakerEntityId, entityById) : '来源不明';
      const targets = (value.targetEntityIds ?? []).map(id => entityName(id, entityById)).join('、');
      return `${speaker}${targets ? ` → ${targets}` : ''}：${relation}${value.text}`;
    }
    if (value.kind === 'action') {
      const actor = entityName(value.actorEntityId, entityById);
      const targets = (value.targetEntityIds ?? []).map(id => entityName(id, entityById)).join('、');
      return `（主体：${actor}${targets ? `；对象：${targets}` : ''}）：${relation}${value.text}`;
    }
    return `${relation}${value.text}`;
  };
  const stateSide = (value, currentEquivalent = false, timelineAssistantSeq = null, priorAssistantSeq = null) => {
    if (!value) return '无';
    if (currentEquivalent) return '见本线末尾当前快照（同一来源）';
    const target = value.toward ? `，对 ${value.toward}` : '';
    const boundary = value.visibility === 'private' ? '，仅可用于该人物' : value.visibility === 'authorial' ? '，作者塑造参考，不代表人物知情' : '';
    if (Number.isSafeInteger(priorAssistantSeq)) return `${value.visibility}${boundary}${target}：${value.text}（完整依据见 AI #${priorAssistantSeq} 上述“之后”状态，同一来源）`;
    const source = value.sourceAssistantSeq && value.sourceAssistantSeq !== timelineAssistantSeq ? `，状态来源 AI #${value.sourceAssistantSeq}` : '';
    return `${value.visibility}${boundary}${target}：${value.text}（依据：${value.reason || '未提供'}${source}）`;
  };
  for (const storyline of storylines) {
    lines.push('', `[剧情线 ${storyline.storylineId}｜${storyline.title}]`, `[关联依据] ${storyline.basis}`);
    const lineFloors = [...(floorsByLine.get(storyline.storylineId)?.values() ?? [])]
      .sort((a, b) => a.assistantSeq - b.assistantSeq || a.floorId.localeCompare(b.floorId));
    const lineStates = states.filter(value => value.storylineId === storyline.storylineId);
    const lineChanges = cseChanges.filter(value => value.storylineId === storyline.storylineId)
      .sort((a, b) => a.assistantSeq - b.assistantSeq || String(a.deltaId ?? '').localeCompare(String(b.deltaId ?? '')));
    const renderedAfters = [];
    const action = { add: '新增', remove: '移除', update: '更新', refine: '调整' };
    const timelineSeqs = [...new Set([...lineFloors.map(value => value.assistantSeq), ...lineChanges.map(value => value.assistantSeq)])].sort((a, b) => a - b);
    for (const assistantSeq of timelineSeqs) {
      const floor = lineFloors.find(value => value.assistantSeq === assistantSeq);
      const time = formatChronologyAnchor(floor?.chronology ?? []);
      lines.push(`[来源 AI #${assistantSeq}${time ? `（${time}）` : ''}]`);
      floor?.items.forEach(value => lines.push(`- [旧事] ${historyText(value)}`));
      for (const value of lineChanges.filter(item => item.assistantSeq === assistantSeq)) {
        const removeBoundary = value.action === 'remove' ? '；“之前”只是被移除的旧状态，不是当前状态' : '';
        const priorAfter = value.before && renderedAfters.find(item => item.subjectEntityId === value.subjectEntityId
          && item.layer === value.layer && sameStateSource(item.state, value.before));
        const currentEquivalent = value.after && lineStates.some(state => state.subjectEntityId === value.subjectEntityId && state.layer === value.layer && sameStateSource(state, value.after));
        lines.push(`- [变化] ${value.subject} / ${value.layer}：当时${action[value.action] ?? '变化'}；之前 ${stateSide(value.before, false, assistantSeq, priorAfter?.assistantSeq)}；之后 ${stateSide(value.after, currentEquivalent, assistantSeq)}${removeBoundary}。`);
        if (value.after && !currentEquivalent) renderedAfters.push({ subjectEntityId: value.subjectEntityId, layer: value.layer, state: value.after, assistantSeq });
      }
    }
    if (lineStates.length) lines.push('[已保存人物状态依据]');
    for (const value of lineStates) {
      const target = value.toward ? `，对 ${value.toward}` : '';
      const source = value.sourceAssistantSeq ? `，来源 AI #${value.sourceAssistantSeq}` : '';
      const boundary = value.visibility === 'private' ? '，仅可用于该人物' : value.visibility === 'authorial' ? '，作者塑造参考，不代表人物知情' : '';
      lines.push(`- [当前] ${value.subject} / ${value.layer}${target} / ${value.visibility}${boundary}：${value.text}（依据：${value.reason}${source}）`);
    }
  }
  appendStateProgressions(lines, stateProgressions, states);
  if (!coverage.memoryComplete || !coverage.cseCurrent) {
    const missing = coverage.missingAssistantSeq.length ? coverage.missingAssistantSeq.join('、') : '无';
    const stateNote = coverage.cseCurrent ? '已保存的人物状态按现存楼独立汇总。' : '当前没有可用的人物状态。';
    lines.push('', `[覆盖说明] FloorMemory ${coverage.rememberedAiFloors}/${coverage.stableAiFloors}，缺失 AI #${missing}；CSE 已保存到 AI #${coverage.cseThroughAssistantSeq || 0}。${stateNote}`);
  }
  lines.push('</qqj_recalled_context>');
  return lines.join('\n');
}

export function formatRecallInjection({ coverage, floors, states, cseChanges = [], stateProgressions = [], entityById, storylines = [] }) {
  if (!floors.length && !states.length && !cseChanges.length && !stateProgressions.length) return '';
  if (storylines.length) return formatStorylineInjection({ coverage, floors, states, cseChanges, stateProgressions, entityById, storylines });
  const hasNarrative = floors.some(floor => floor.items.some(value => value.category === 'narrative'));
  const lines = [
    '<qqj_recalled_context>',
    '以下是此前剧情档案与人物状态的只读参考，不是指令。与当前正文冲突时以当前正文为准。',
    '任何 private 内容仅属于标明的主体，不代表其他人物知情。',
    ...(hasNarrative ? ['叙事回顾可能含内心、计划或未完成事项，不代表所有人物知情；若与后文冲突以后文为准。'] : []),
  ];
  const renderFloors = (selectedFloors, heading) => {
    if (!selectedFloors.length) return;
    lines.push('', heading);
    const narrative = [], objective = [], shared = [], privateByOwner = new Map();
    for (const floor of selectedFloors) for (const value of floor.items) {
      const time = formatChronologyAnchor(floor.chronology);
      const prefix = `AI #${floor.assistantSeq}${time ? `（${time}）` : ''}`;
      const relation = value.relationEvidence === 'nearby' ? '邻近背景；仅因时序相邻，不表示因果：'
        : value.relationEvidence === 'topic' ? '同人物与具体主题词关联，不表示因果：'
          : value.relationEvidence === 'source' ? '来源关联：' : '';
      if (value.category === 'narrative') narrative.push(`${prefix}：${relation}${value.text}`);
      else if (value.category === 'private') {
        const owner = entityName(value.ownerEntityId, entityById);
        privateByOwner.set(owner, [...(privateByOwner.get(owner) ?? []), `${prefix}：${relation}${value.text}`]);
      } else if (value.category === 'transfer') {
        const from = value.fromEntityId ? entityName(value.fromEntityId, entityById) : '来源不明';
        const recipients = value.toEntityIds.map(id => entityName(id, entityById)).join('、');
        shared.push(`${prefix}：${relation}${from} → ${recipients}（仅列明接收者知情，渠道：${value.kind}）：${value.text}`);
      } else if (value.category === 'shared') {
        const speaker = value.speakerEntityId ? entityName(value.speakerEntityId, entityById) : null;
        const targets = (value.targetEntityIds ?? []).map(id => entityName(id, entityById)).join('、');
        const boundary = speaker ? `（${speaker}${targets ? ` → ${targets}` : ''}）` : '';
        shared.push(`${prefix}${boundary}：${relation}${value.text}`);
      } else if (value.kind === 'action') {
        const actor = entityName(value.actorEntityId, entityById);
        const targets = (value.targetEntityIds ?? []).map(id => entityName(id, entityById)).join('、');
        objective.push(`${prefix}（主体：${actor}${targets ? `；对象：${targets}` : ''}）：${relation}${value.text}`);
      } else objective.push(`${prefix}：${relation}${value.text}`);
    }
    if (narrative.length) {
      lines.push('[叙事回顾]');
      narrative.forEach(value => lines.push(`- ${value}`));
    }
    if (objective.length) { lines.push('[客观相关旧事]'); objective.forEach(value => lines.push(`- ${value}`)); }
    for (const [owner, values] of privateByOwner) { lines.push(`[${owner} 的私有认知（仅可用于 ${owner}）]`); values.forEach(value => lines.push(`- ${value}`)); }
    if (shared.length) { lines.push('[已表达/已共享信息]'); shared.forEach(value => lines.push(`- ${value}`)); }
  };
  const recentFloors = floors.filter(floor => floor.items.some(value => value.recallSection === 'recent'));
  const distantFloors = floors.filter(floor => floor.items.some(value => value.recallSection !== 'recent'));
  renderFloors(recentFloors, '[近期剧情接续摘要]');
  renderFloors(distantFloors, '[远期相关旧事]');
  if (states.length) {
    lines.push('', '[已保存人物状态依据]');
    for (const value of states) {
      const target = value.toward ? `，对 ${value.toward}` : '';
      const source = value.sourceAssistantSeq ? `，来源 AI #${value.sourceAssistantSeq}` : '';
      const boundary = value.visibility === 'private' ? '，仅可用于该人物' : value.visibility === 'authorial' ? '，作者塑造参考，不代表任何人物知情' : '';
      lines.push(`- ${value.subject} / ${value.layer}${target} / ${value.visibility}${boundary}：${value.text}（依据：${value.reason}${source}）`);
    }
  }
  if (cseChanges.length) {
    const stateSide = (value, currentEquivalent = false, priorAssistantSeq = null) => {
      if (!value) return '无';
      if (currentEquivalent) return '见该人物上方当前快照（同一来源）';
      const target = value.toward ? `，对 ${value.toward}` : '';
      const boundary = value.visibility === 'private' ? '，仅可用于该人物' : value.visibility === 'authorial' ? '，作者塑造参考，不代表任何人物知情' : '';
      if (Number.isSafeInteger(priorAssistantSeq)) return `${value.visibility}${boundary}${target}：${value.text}（完整依据见 AI #${priorAssistantSeq} 上述“之后”状态，同一来源）`;
      const source = value.sourceAssistantSeq ? `，状态来源 AI #${value.sourceAssistantSeq}` : '';
      return `${value.visibility}${boundary}${target}：${value.text}（依据：${value.reason || '未提供'}${source}）`;
    };
    const action = { add: '新增', remove: '移除', update: '更新', refine: '调整' };
    const renderedAfters = [];
    lines.push('', '[人物状态历史变化（记录当时前后，后文可能继续覆盖）]');
    for (const value of cseChanges) {
      const removeBoundary = value.action === 'remove' ? '；“之前”只是被移除的旧状态，不是当前状态' : '';
      const priorAfter = value.before && renderedAfters.find(item => item.storylineId === value.storylineId
        && item.subjectEntityId === value.subjectEntityId && item.layer === value.layer && sameStateSource(item.state, value.before));
      const currentEquivalent = value.after && states.some(state => state.subjectEntityId === value.subjectEntityId && state.layer === value.layer && sameStateSource(state, value.after));
      lines.push(`- ${value.subject} / ${value.layer} / 来源 AI #${value.assistantSeq}：当时${action[value.action] ?? '变化'}；之前 ${stateSide(value.before, false, priorAfter?.assistantSeq)}；之后 ${stateSide(value.after, currentEquivalent)}${removeBoundary}。`);
      if (value.after && !currentEquivalent) renderedAfters.push({ storylineId: value.storylineId, subjectEntityId: value.subjectEntityId, layer: value.layer, state: value.after, assistantSeq: value.assistantSeq });
    }
  }
  appendStateProgressions(lines, stateProgressions, states);
  if (!coverage.memoryComplete || !coverage.cseCurrent) {
    const missing = coverage.missingAssistantSeq.length ? coverage.missingAssistantSeq.join('、') : '无';
    const stateNote = coverage.cseCurrent ? '已保存的人物状态按现存楼独立汇总。' : '当前没有可用的人物状态。';
    lines.push('', `[覆盖说明] FloorMemory ${coverage.rememberedAiFloors}/${coverage.stableAiFloors}，缺失 AI #${missing}；CSE 已保存到 AI #${coverage.cseThroughAssistantSeq || 0}。${stateNote}`);
  }
  lines.push('</qqj_recalled_context>');
  return lines.join('\n');
}

// The .7/.2/.1 branch blend follows the STBME shared-ranking.js starting point
// (AGPL-3.0, commit 593b061b29b2ecc8153b7346df985a6d229a4973).
function recallQueries(queryContext, fallbackText) {
  const definitions = [
    { key: 'latestUser', text: clean(queryContext?.latestUserText, 4000) || fallbackText, weight: 0.7 },
    { key: 'recentAssistant', text: clean(queryContext?.recentAssistantText, 4000), weight: 0.2 },
    { key: 'previousUser', text: clean(queryContext?.previousUserText, 4000), weight: 0.1 },
  ].filter(value => value.text);
  const weightTotal = definitions.reduce((sum, value) => sum + value.weight, 0) || 1;
  return definitions.map(value => ({ ...value, normalizedWeight: value.weight / weightTotal }));
}

function scoreCandidates(candidates, queries, { summaryAssist = false, keepUnmatched = false } = {}) {
  if (!candidates.length) return [];
  const documents = candidates.map((value, index) => ({ id: index, text: value._rankText }));
  const ranked = rankRecallDocuments({ documents, queries });
  const entityRanked = rankRecallDocuments({ documents: candidates.map((value, index) => ({ id: index, text: value._entityText })), queries });
  const summaries = summaryAssist ? rankRecallDocuments({ documents: candidates.map((value, index) => ({ id: index, text: value._summary })), queries }) : [];
  return candidates.map((value, index) => {
    const ranking = ranked[index], entityRanking = entityRanked[index], summary = summaries[index];
    const branchScores = {}, entityBranchScores = {}, summaryScores = {};
    let score = 0, summaryScore = 0;
    for (const query of queries) {
      const contentScore = ranking.branchScores[query.key] ?? 0;
      const entityScore = entityRanking.branchScores[query.key] ?? 0;
      const branchScore = Math.min(1, contentScore + entityScore * 0.15);
      branchScores[query.key] = branchScore;
      entityBranchScores[query.key] = entityScore;
      score += branchScore * query.normalizedWeight;
      const auxiliary = summary?.branchScores?.[query.key] ?? 0;
      summaryScores[query.key] = auxiliary;
      summaryScore += auxiliary * query.normalizedWeight;
    }
    // A floor summary may break ties between facts that already match, but it
    // must never turn another fact from that floor into prompt material.
    const finalScore = score > 0 ? score * (summaryAssist ? 1 + summaryScore * 0.12 : 1) : 0;
    return { ...value, score: finalScore, _summaryScore: summaryScore, branchScores: Object.freeze(branchScores), entityBranchScores: Object.freeze(entityBranchScores), summaryScores: Object.freeze(summaryScores) };
  }).filter(value => keepUnmatched || value.score > 0);
}

const stateSourceKey = value => {
  const stateId = cleanLiteral(value?.stateId, 500);
  if (stateId) return `id:${stateId}`;
  const floorId = cleanLiteral(value?.sourceFloorId, 500), deltaId = cleanLiteral(value?.sourceDeltaId, 500);
  if (!floorId && !deltaId) return '';
  return `source:${floorId}|${deltaId}|${compact(value?.text)}|${value?.visibility ?? ''}|${value?.towardEntityId ?? ''}`;
};

const sameStateSource = (state, side) => {
  const left = stateSourceKey(state), right = stateSourceKey(side);
  return Boolean(left && right && left === right);
};

export function cseSelectionContext(source, queryContext) {
  const query = clean(queryContext?.text, MAX_QUERY_CHARACTERS);
  if (source?.status !== 'ready' || !query) return null;
  const queries = recallQueries(queryContext, query);
  const queryCompact = compact(query);
  const mentioned = new Set();
  for (const entity of source.entities ?? []) {
    if (entityLabels(entity).some(label => !genericAlias(label) && compact(label).length >= 2 && queryCompact.includes(compact(label)))) mentioned.add(entity.entityId);
  }
  const involvedIds = new Set((source.entities ?? []).filter(entity => ['user', 'char'].includes(entity.specialRole)).map(entity => entity.entityId));
  mentioned.forEach(id => involvedIds.add(id));
  const entityById = new Map((source.entities ?? []).map(entity => [entity.entityId, entity]));
  const entityOrder = [...involvedIds]
    .sort((a, b) => Number(mentioned.has(b)) - Number(mentioned.has(a))
      || Number(entityById.get(b)?.specialRole === 'char') - Number(entityById.get(a)?.specialRole === 'char')
      || Number(entityById.get(b)?.specialRole === 'user') - Number(entityById.get(a)?.specialRole === 'user')
      || (entityById.get(a)?.displayName ?? '').localeCompare(entityById.get(b)?.displayName ?? '', 'zh-CN'));
  const states = (source.coverage?.cseCurrent ? scoreCandidates(stateCandidates(source, involvedIds), queries, { keepUnmatched: true }) : [])
    .sort((a, b) => ((b.layer === 'core' && (b.branchScores.latestUser ?? 0) > 0) ? 1 : 0) - ((a.layer === 'core' && (a.branchScores.latestUser ?? 0) > 0) ? 1 : 0)
      || (b.branchScores.latestUser ?? 0) - (a.branchScores.latestUser ?? 0) || b.score - a.score || b.priority - a.priority
      || entityOrder.indexOf(a.subjectEntityId) - entityOrder.indexOf(b.subjectEntityId) || a.layer.localeCompare(b.layer));
  const changes = scoreCandidates(cseChangeCandidates(source, involvedIds), queries, { keepUnmatched: true })
    .filter(change => !(change.action === 'add' && states.some(state => state.subjectEntityId === change.subjectEntityId && state.layer === change.layer && sameStateSource(state, change.after))))
    .sort((a, b) => (b.branchScores.latestUser ?? 0) - (a.branchScores.latestUser ?? 0) || b.score - a.score || b.priority - a.priority
      || b.assistantSeq - a.assistantSeq || entityOrder.indexOf(a.subjectEntityId) - entityOrder.indexOf(b.subjectEntityId));
  return { query, queries, involvedIds, entityById, entityOrder, states, changes };
}

const duplicateKey = value => [compact(value._coreText), value._subjectKey, value._visibilityKey, value._statusKey ?? ''].join('|');
const historyStableKey = value => [value.floorId, value.floorMemoryId, value.assistantSeq, value._sourceOrder, duplicateKey(value)].join('|');
const cseStableKey = value => value._recallCseKind === 'change'
  ? ['change', value.deltaId, value.floorId, value.assistantSeq, value.subjectEntityId, value.layer, value.action, stateSourceKey(value.before), stateSourceKey(value.after)].join('|')
  : ['current', value.subjectEntityId, value.layer, stateSourceKey(value), duplicateKey(value)].join('|');
const publicItem = value => {
  const { _rankText, _entityText, _coreText, _summary, _summaryScore, _subjectKey, _visibilityKey, _statusKey, _sourceOrder, _chronology, _poolGroup, _adjacentSummary, _recallCseKind, _relationEvidence, _relationAnchorFloorId, _relationAnchorStableKey, _relationTerms, _storylineId, floorId, floorMemoryId, assistantSeq, branchScores, entityBranchScores, summaryScores, score, ...rest } = value;
  return { ...rest, ...(_relationEvidence ? { relationEvidence: _relationEvidence } : {}), ...(_storylineId ? { storylineId: _storylineId } : {}), rankScore: Number(score.toFixed(6)), rankBranches: branchScores, rankEntityBranches: entityBranchScores };
};

export function historySelectionContext(source, queryContext) {
  const query = clean(queryContext?.text, MAX_QUERY_CHARACTERS);
  if (source?.status !== 'ready' || !query) return null;
  const queries = recallQueries(queryContext, query);
  const bodyCoveredFloorIds = new Set([...(source.bodyMatch?.coveredFloorIds ?? []), ...(source.bodyMatch?.visibleFloorIds ?? [])]);
  const entityById = new Map(source.entities.map(entity => [entity.entityId, entity]));
  const recentWindow = [...source.floorMemories]
    .filter(memory => memory.assistantSeq <= source.coverage.stableThroughAssistantSeq && !bodyCoveredFloorIds.has(memory.floorId) && clean(memory.summary, 12000))
    .sort((a, b) => b.assistantSeq - a.assistantSeq || b.floorId.localeCompare(a.floorId))
    .slice(0, RECENT_CONTINUITY_FLOORS)
    .sort((a, b) => a.assistantSeq - b.assistantSeq || a.floorId.localeCompare(b.floorId));
  const recentWindowFloorIds = new Set(recentWindow.map(memory => memory.floorId));
  const recentSummaries = recentWindow
    .map(memory => historySummary(memory, entityById)).filter(Boolean)
    .map(value => ({ ...value, score: 1, branchScores: Object.freeze({}), entityBranchScores: Object.freeze({}), summaryScores: Object.freeze({}), recallSection: 'recent' }));
  const oldMemories = source.floorMemories.filter(memory => !bodyCoveredFloorIds.has(memory.floorId) && !recentWindowFloorIds.has(memory.floorId));
  const facts = scoreCandidates(oldMemories.flatMap(memory => historyFacts(memory, entityById)), queries, { keepUnmatched: true });
  const compactFactTextsByFloor = new Map();
  for (const fact of facts) {
    const texts = compactFactTextsByFloor.get(fact.floorId) ?? new Set();
    texts.add(compact(fact._coreText));
    compactFactTextsByFloor.set(fact.floorId, texts);
  }
  const summaries = scoreCandidates(oldMemories.map(memory => historySummary(memory, entityById)).filter(Boolean)
    .filter(summary => !compactFactTextsByFloor.get(summary.floorId)?.has(compact(summary._coreText))), queries, { keepUnmatched: true });
  const direct = [...facts, ...summaries].filter(value => value.score > 0)
    .sort((a, b) => b.score - a.score || b.priority - a.priority || b.assistantSeq - a.assistantSeq || a.floorId.localeCompare(b.floorId) || a._sourceOrder - b._sourceOrder);
  const summaryByFloor = new Map(summaries.map(value => [value.floorId, value]));
  const adjacent = [];
  for (const anchor of summaries.filter(value => value.score > 0).sort((a, b) => b.score - a.score).slice(0, 2)) {
    const memoryIndex = oldMemories.findIndex(memory => memory.floorId === anchor.floorId);
    for (const neighborIndex of [memoryIndex - 1, memoryIndex + 1]) {
      const neighbor = summaryByFloor.get(oldMemories[neighborIndex]?.floorId);
      if (!neighbor || neighbor.score > 0 || adjacent.includes(neighbor)) continue;
      adjacent.push({ ...neighbor, score: anchor.score * 0.2, _adjacentSummary: true, _relationEvidence: 'nearby' });
    }
  }
  return { query, queries, oldMemories, entityById, facts, summaries, direct, adjacent, bodyCoveredFloorIds, recentWindow, recentWindowFloorIds, recentSummaries };
}

const setIntersection = (left, right) => [...left].filter(value => right.has(value));
const RELATION_STOP_WORDS = Object.freeze([
  '当时', '后来', '之后', '此后', '随后', '如今', '现在', '已经', '仍然', '继续', '最后', '发生', '事情', '情况', '对方', '处理', '很多', '他们', '她们', '众人',
]);
const RELATION_STOP_TOKENS = new Set([...RELATION_STOP_WORDS, '的', '了', '很', '并', '与', '和', '又', '也', '都', '他', '她']);
const RELATION_GENERIC_ACTION_TOKENS = new Set(['看向', '看着', '望向']);
const RELATION_STOP_PATTERN = new RegExp(`(?:${RELATION_STOP_WORDS.join('|')})`, 'gu');

function relationTokens(value, entityTokenSet) {
  const withoutNarrativeGlue = clean(value, 12000).replace(RELATION_STOP_PATTERN, ' ');
  return new Set(tokenizeRecallText(withoutNarrativeGlue).filter(token => !entityTokenSet.has(token) && !RELATION_STOP_TOKENS.has(token)));
}

const relationAnchorOrder = (left, right) => (right.branchScores?.latestUser ?? 0) - (left.branchScores?.latestUser ?? 0)
  || right.score - left.score
  || right.priority - left.priority || right.assistantSeq - left.assistantSeq || left._sourceOrder - right._sourceOrder;

function balancedRelationAnchors(values, maximum = 8) {
  const groups = ['continuity', 'fact', 'summary'];
  const queues = new Map(groups.map(group => [group, values.filter(value => (value._poolGroup ?? 'fact') === group).sort(relationAnchorOrder)]));
  const result = [];
  for (let offset = 0; result.length < maximum; offset += 1) {
    let added = false;
    for (const group of groups) {
      const value = queues.get(group)?.[offset];
      if (!value) continue;
      result.push(value); added = true;
      if (result.length >= maximum) break;
    }
    if (!added) break;
  }
  return result;
}

function materiallySame(left, right) {
  const a = clean(left?._coreText ?? left?.text, 4000), b = clean(right?._coreText ?? right?.text, 4000);
  if (!a || !b) return false;
  const compactA = compact(a), compactB = compact(b);
  if (compactA && compactB && (compactA.includes(compactB) || compactB.includes(compactA))) return true;
  const aTokens = new Set(tokenizeRecallText(a)), bTokens = new Set(tokenizeRecallText(b));
  const smaller = Math.min(aTokens.size, bTokens.size);
  return smaller > 0 && setIntersection(aTokens, bTokens).length / smaller >= 0.72;
}

function expandLinkedHistory({ context, selectedHistory, selectedCse, excludedHistory = [] }) {
  if (!context || (!selectedHistory.length && !selectedCse.length)) return [];
  const allHistory = [...context.facts, ...context.summaries];
  const duplicateKeysByValue = new Map();
  const stableKeysByValue = new Map();
  const duplicateKeyFor = value => {
    if (!duplicateKeysByValue.has(value)) duplicateKeysByValue.set(value, duplicateKey(value));
    return duplicateKeysByValue.get(value);
  };
  const stableKeyFor = value => {
    if (!stableKeysByValue.has(value)) stableKeysByValue.set(value, historyStableKey(value));
    return stableKeysByValue.get(value);
  };
  const excludedStableKeys = new Set(excludedHistory.map(value => value?.stableKey ?? stableKeyFor(value?.value ?? value)));
  const excludedValues = excludedHistory.map(value => value?.value ?? value).filter(Boolean);
  const selectedStableKeys = new Set(selectedHistory.map(stableKeyFor));
  const selectedFloorIds = new Set(selectedHistory.map(value => value.floorId));
  const sourceAnchorFloorIds = [];
  const rememberAnchor = floorId => { if (floorId && !sourceAnchorFloorIds.includes(floorId)) sourceAnchorFloorIds.push(floorId); };
  for (const value of selectedCse) {
    for (const floorId of [value.floorId, value.sourceFloorId, value.before?.sourceFloorId, value.after?.sourceFloorId]) {
      if (floorId) selectedFloorIds.add(floorId);
      rememberAnchor(floorId);
    }
  }
  const selectedAnchors = balancedRelationAnchors(selectedHistory);
  selectedAnchors.forEach(value => rememberAnchor(value.floorId));
  const allowed = value => !selectedStableKeys.has(stableKeyFor(value))
    && !excludedStableKeys.has(stableKeyFor(value))
    && !excludedValues.some(excluded => materiallySame(value, excluded));
  const result = [];
  const add = (value, kind, anchor = null, relationTerms = []) => {
    if (!value || !allowed(value) || result.some(existing => duplicateKeyFor(existing) === duplicateKeyFor(value))) return false;
    const anchorFloorId = typeof anchor === 'string' ? anchor : anchor?.floorId ?? null;
    result.push({
      ...value,
      score: Math.max(value.score, kind === 'source' ? 0.65 : kind === 'topic' ? 0.45 : 0.15),
      _relationEvidence: kind,
      _relationAnchorFloorId: anchorFloorId,
      _relationAnchorStableKey: anchor && typeof anchor === 'object' ? stableKeyFor(anchor) : null,
      _relationTerms: relationTerms,
    });
    selectedStableKeys.add(stableKeyFor(value));
    return true;
  };

  const summaryByFloor = new Map(context.summaries.map(value => [value.floorId, value]));
  for (const floorId of sourceAnchorFloorIds.slice(0, 6)) add(summaryByFloor.get(floorId), 'source', floorId);

  const entityTokens = new Set([...context.entityById.values()].flatMap(entity => entityLabels(entity).flatMap(tokenizeRecallText)));
  const valuesByFloor = new Map();
  for (const value of allHistory) valuesByFloor.set(value.floorId, [...(valuesByFloor.get(value.floorId) ?? []), value]);
  const memoryByFloor = new Map(context.oldMemories.map(memory => [memory.floorId, memory]));
  const itemRecords = allHistory.map(value => {
    const memory = memoryByFloor.get(value.floorId);
    const participants = new Set((memory.participants ?? []).map(value => value.entityId).filter(Boolean));
    for (const entityId of String(value._subjectKey ?? '').split(',').filter(Boolean)) participants.add(entityId);
    return { value, memory, participants, tokens: relationTokens(value._rankText, entityTokens) };
  });
  const documentFrequency = new Map();
  const tokenFloors = new Map();
  for (const record of itemRecords) for (const token of record.tokens) {
    const floors = tokenFloors.get(token) ?? new Set();
    floors.add(record.value.floorId);
    tokenFloors.set(token, floors);
  }
  for (const [token, floors] of tokenFloors) documentFrequency.set(token, floors.size);
  const rareLimit = Math.max(2, Math.ceil(context.oldMemories.length * 0.12));
  const sourceLinkedAnchors = result.filter(value => value._relationEvidence === 'source');
  const anchors = [...selectedAnchors, ...sourceLinkedAnchors].map(value => itemRecords.find(record => stableKeyFor(record.value) === stableKeyFor(value))).filter(Boolean);
  const linkedItems = [];
  for (const anchor of anchors) {
    const candidates = itemRecords.flatMap(record => {
      if (record === anchor || selectedFloorIds.has(record.value.floorId) || !allowed(record.value)) return [];
      const sharedPeople = setIntersection(anchor.participants, record.participants);
      if (!sharedPeople.length) return [];
      const sharedTopics = setIntersection(anchor.tokens, record.tokens).filter(token => (documentFrequency.get(token) ?? Number.MAX_SAFE_INTEGER) <= rareLimit);
      const shorterSize = Math.max(1, Math.min(anchor.tokens.size, record.tokens.size));
      const sharedRatio = sharedTopics.length / shorterSize;
      if (!sharedTopics.length || sharedRatio < 0.25) return [];
      return [{ record, sharedTopics: sharedTopics.length, sharedRatio, distance: Math.abs(record.value.assistantSeq - anchor.value.assistantSeq) }];
    }).sort((a, b) => b.sharedTopics - a.sharedTopics || b.sharedRatio - a.sharedRatio || a.distance - b.distance
      || b.record.value.score - a.record.value.score || a.record.value.assistantSeq - b.record.value.assistantSeq);
    const before = candidates.find(value => value.record.value.assistantSeq < anchor.value.assistantSeq);
    const after = candidates.find(value => value.record.value.assistantSeq > anchor.value.assistantSeq);
    for (const candidate of [before, after].filter(Boolean)) {
      if (!linkedItems.some(value => stableKeyFor(value.record.value) === stableKeyFor(candidate.record.value))) linkedItems.push({ ...candidate, anchor: anchor.value });
    }
  }
  const linkedFloorIds = new Set();
  for (const { record, anchor, sharedTopics } of linkedItems.sort((a, b) => b.sharedTopics - a.sharedTopics || b.sharedRatio - a.sharedRatio || a.distance - b.distance
    || b.record.value.score - a.record.value.score || a.record.value.assistantSeq - b.record.value.assistantSeq)) {
    if (!linkedFloorIds.has(record.value.floorId) && linkedFloorIds.size >= MAX_LINKED_FLOORS) continue;
    const anchorRecord = itemRecords.find(value => stableKeyFor(value.value) === stableKeyFor(anchor));
    const terms = anchorRecord ? setIntersection(anchorRecord.tokens, record.tokens).filter(token => (documentFrequency.get(token) ?? Number.MAX_SAFE_INTEGER) <= rareLimit) : [];
    if (add(record.value, 'topic', anchor, terms.slice(0, 4))) linkedFloorIds.add(record.value.floorId);
  }
  return result.sort((a, b) => a.assistantSeq - b.assistantSeq || a.floorId.localeCompare(b.floorId) || a._sourceOrder - b._sourceOrder);
}

function expandLinkedCse({ source, historyContext, selectedHistory, linkedHistory, selectedCse, excludedCse = [] }) {
  const history = [...selectedHistory, ...linkedHistory];
  if (!history.length) return [];
  const floorIds = new Set(history.map(value => value.floorId).filter(Boolean));
  const memoryByFloor = new Map(historyContext.oldMemories.map(memory => [memory.floorId, memory]));
  const involvedIds = new Set();
  for (const value of history) {
    for (const id of String(value._subjectKey ?? '').split(',').filter(Boolean)) involvedIds.add(id);
    for (const participant of memoryByFloor.get(value.floorId)?.participants ?? []) if (participant.entityId) involvedIds.add(participant.entityId);
  }
  if (!involvedIds.size) return [];
  const candidates = scoreCandidates(cseChangeCandidates(source, involvedIds), historyContext.queries, { keepUnmatched: true });
  const selectedKeys = new Set(selectedCse.map(cseStableKey));
  const excludedValues = excludedCse.map(value => value?.value ?? value).filter(Boolean);
  const excludedKeys = new Set(excludedCse.map(value => value?.stableKey ?? cseStableKey(value?.value ?? value)));
  return candidates.filter(value => {
    if (selectedKeys.has(cseStableKey(value)) || excludedKeys.has(cseStableKey(value))) return false;
    if (excludedValues.some(excluded => materiallySame(value, excluded))) return false;
    return floorIds.has(value.floorId) || floorIds.has(value.before?.sourceFloorId) || floorIds.has(value.after?.sourceFloorId);
  }).map(value => ({ ...value, score: Math.max(value.score, 0.6), _relationEvidence: 'source' }))
    .sort((a, b) => a.assistantSeq - b.assistantSeq || b.priority - a.priority)
    .slice(0, MAX_CSE_ITEMS);
}

function buildStorylinePlan({ context, history, states, changes }) {
  if (!context) return { storylines: [], history: [], states: [], changes: [] };
  const entityTokens = new Set([...context.entityById.values()].flatMap(entity => entityLabels(entity).flatMap(tokenizeRecallText)));
  const memoryByFloor = new Map(context.oldMemories.map(memory => [memory.floorId, memory]));
  const recordFor = value => {
    const memory = memoryByFloor.get(value.floorId ?? value.sourceFloorId ?? value.before?.sourceFloorId ?? value.after?.sourceFloorId);
    const participants = new Set((memory?.participants ?? []).map(itemValue => itemValue.entityId).filter(Boolean));
    for (const entityId of String(value._subjectKey ?? '').split(',').filter(Boolean)) participants.add(entityId);
    for (const entityId of [value.subjectEntityId, value.towardEntityId, value.before?.towardEntityId, value.after?.towardEntityId].filter(Boolean)) participants.add(entityId);
    const relationText = value._rankText ?? value.text ?? `${value.before?.text ?? ''} ${value.after?.text ?? ''}`;
    const compactText = compact(relationText);
    for (const [entityId, entity] of context.entityById) {
      if (entityLabels(entity).some(label => !genericAlias(label) && compact(label).length >= 2 && compactText.includes(compact(label)))) participants.add(entityId);
    }
    return { value, participants, tokens: relationTokens(relationText, entityTokens) };
  };
  const historyRecords = new Map(history.map(value => [historyStableKey(value), recordFor(value)]));
  const queryRelationTokens = relationTokens(context.query, entityTokens);
  const documentFrequency = new Map();
  for (const record of historyRecords.values()) for (const token of record.tokens) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  const rareLimit = Math.max(2, Math.ceil(Math.max(1, history.length) * 0.25));
  const topicTerms = (left, right) => {
    const leftRecord = historyRecords.get(historyStableKey(left)) ?? recordFor(left);
    const rightRecord = historyRecords.get(historyStableKey(right)) ?? recordFor(right);
    const sharedPeople = setIntersection(leftRecord.participants, rightRecord.participants);
    const shared = setIntersection(leftRecord.tokens, rightRecord.tokens)
      .filter(token => token.length >= 2 && (documentFrequency.get(token) ?? Number.MAX_SAFE_INTEGER) <= rareLimit);
    const shorterSize = Math.max(1, Math.min(leftRecord.tokens.size, rightRecord.tokens.size));
    const sharedRatio = shared.length / shorterSize;
    const queryShared = shared.filter(token => queryRelationTokens.has(token) && !RELATION_GENERIC_ACTION_TOKENS.has(token));
    const strongSingle = shared.length === 1 && queryShared.length === 1 && sharedRatio >= 0.25;
    const sameFloorQueryEvidence = left.floorId && left.floorId === right.floorId && queryShared.length >= 2;
    const strongTopicOnly = !sharedPeople.length
      && queryShared.length >= 2 && shared.length >= 2 && (sharedRatio >= 0.25 || sameFloorQueryEvidence);
    const sharedPeopleTopic = sharedPeople.length && queryShared.length > 0
      && ((shared.length >= 2 && sharedRatio >= 0.25) || strongSingle);
    return sharedPeopleTopic || strongTopicOnly ? shared : [];
  };
  const lines = [];
  const assignedHistory = new Set();
  const historyLineLimit = Math.max(1, MAX_STORYLINES - Number(Boolean(states.length || changes.length)));
  const addHistory = (line, value, terms = []) => {
    const key = historyStableKey(value);
    if (assignedHistory.has(key)) return false;
    line.history.push(value); line.historyTerms.set(key, terms); terms.forEach(term => line.terms.set(term, (line.terms.get(term) ?? 0) + 1)); assignedHistory.add(key); return true;
  };
  const newLine = (anchor, kind = 'direct') => {
    if (lines.length >= MAX_STORYLINES || lines.filter(line => line.history.length).length >= historyLineLimit) return null;
    const line = { storylineId: `line-${lines.length + 1}`, kind, anchorKey: historyStableKey(anchor), history: [], states: [], changes: [], terms: new Map(), historyTerms: new Map() };
    lines.push(line); addHistory(line, anchor, anchor._relationTerms ?? []); return line;
  };
  const direct = history.filter(value => !value._relationEvidence).sort(relationAnchorOrder);
  const storylineAnchors = balancedRelationAnchors(direct, 12);
  const candidateLines = storylineAnchors.map((anchor, order) => {
    const members = [], evidenceByKey = new Map();
    for (const value of history) {
      const key = historyStableKey(value);
      const exactLink = value._relationAnchorStableKey === historyStableKey(anchor);
      const same = materiallySame(anchor, value);
      const evidence = value === anchor ? [] : (exactLink && value._relationTerms?.length ? value._relationTerms : topicTerms(anchor, value));
      if (value === anchor || exactLink || same || evidence.length) {
        members.push(value); evidenceByKey.set(key, evidence);
      }
    }
    const floorCount = new Set(members.map(value => value.floorId)).size;
    const relevance = members.slice().sort(relationAnchorOrder).slice(0, 4).reduce((sum, value) => sum + value.score, 0);
    const latestUserRelevance = Math.max(0, ...members.map(value => value.branchScores?.latestUser ?? 0));
    const anchorLatestUserRelevance = anchor.branchScores?.latestUser ?? 0;
    return {
      anchor,
      order,
      members,
      evidenceByKey,
      floorCount,
      latestUserRelevance,
      score: relevance + latestUserRelevance * 4 + anchorLatestUserRelevance * 2
        + Math.min(4, floorCount) * 0.8 + Math.min(8, members.length) * 0.08,
    };
  }).sort((a, b) => Number(b.floorCount >= 2) - Number(a.floorCount >= 2) || b.score - a.score || b.floorCount - a.floorCount || a.order - b.order);
  for (const candidate of candidateLines) {
    if (lines.length >= MAX_STORYLINES) break;
    if (lines.some(line => {
      const existingAnchor = line.history.find(value => historyStableKey(value) === line.anchorKey);
      return existingAnchor && (materiallySame(candidate.anchor, existingAnchor) || topicTerms(candidate.anchor, existingAnchor).length);
    })) continue;
    let available = candidate.members.filter(value => !assignedHistory.has(historyStableKey(value)));
    if (new Set(available.map(value => value.floorId)).size < 2) continue;
    const seedLimit = Math.min(4, MAX_STORYLINE_HISTORY_ITEMS);
    if (available.length > seedLimit) {
      const chronological = [...available].sort((a, b) => a.assistantSeq - b.assistantSeq || a._sourceOrder - b._sourceOrder);
      const retained = new Set([chronological[0], chronological.at(-1), ...[...available].sort(relationAnchorOrder).slice(0, seedLimit - 2)]);
      available = chronological.filter(value => retained.has(value)).slice(0, seedLimit);
    }
    const anchor = available.includes(candidate.anchor) ? candidate.anchor : available.slice().sort(relationAnchorOrder)[0];
    const kind = available.some(value => ['commitment', 'openLoop'].includes(value.kind)) ? 'continuity' : 'direct';
    const line = newLine(anchor, kind);
    if (!line) break;
    for (const value of available) if (value !== anchor) addHistory(line, value, candidate.evidenceByKey.get(historyStableKey(value)) ?? []);
  }
  // Attach remaining material only when an existing line has explicit source or topic evidence.
  for (const value of history) {
    if (assignedHistory.has(historyStableKey(value))) continue;
    let match = value._relationAnchorStableKey ? lines.find(line => line.history.some(itemValue => historyStableKey(itemValue) === value._relationAnchorStableKey)) : null;
    let terms = value._relationTerms ?? [];
    if (!match) for (const line of lines) {
      const anchor = line.history.find(existing => historyStableKey(existing) === line.anchorKey);
      if (!anchor) continue;
      if (materiallySame(value, anchor)) { match = line; break; }
      const evidence = topicTerms(value, anchor);
      if (evidence.length) { match = line; terms = evidence; break; }
    }
    if (match) addHistory(match, value, terms);
  }
  // Keep one directly relevant unresolved item when the multi-node lines did not already retain one.
  for (const value of direct.filter(value => ['commitment', 'openLoop'].includes(value.kind))) {
    if (lines.some(line => line.history.some(itemValue => ['commitment', 'openLoop'].includes(itemValue.kind)))) break;
    if (assignedHistory.has(historyStableKey(value))) continue;
    const line = newLine(value, 'continuity');
    if (!line) break;
    for (const related of direct) {
      if (assignedHistory.has(historyStableKey(related))) continue;
      const evidence = topicTerms(value, related);
      if (materiallySame(value, related) || evidence.length) addHistory(line, related, evidence);
    }
  }
  const keepLineEndpoints = line => {
    if (line.history.length <= MAX_STORYLINE_HISTORY_ITEMS) return;
    const chronological = [...line.history].sort((a, b) => a.assistantSeq - b.assistantSeq || a._sourceOrder - b._sourceOrder);
    const retained = new Set([chronological[0], chronological.at(-1)]);
    for (const value of [...chronological].sort(relationAnchorOrder)) {
      if (retained.size >= Math.min(6, MAX_STORYLINE_HISTORY_ITEMS)) break;
      retained.add(value);
    }
    for (let slot = 1; retained.size < MAX_STORYLINE_HISTORY_ITEMS && slot < MAX_STORYLINE_HISTORY_ITEMS - 1; slot += 1) {
      retained.add(chronological[Math.round(slot * (chronological.length - 1) / (MAX_STORYLINE_HISTORY_ITEMS - 1))]);
    }
    for (const value of chronological) {
      if (retained.size >= MAX_STORYLINE_HISTORY_ITEMS) break;
      retained.add(value);
    }
    line.history = chronological.filter(value => retained.has(value));
    line.terms = new Map();
    for (const value of line.history) for (const term of line.historyTerms.get(historyStableKey(value)) ?? []) line.terms.set(term, (line.terms.get(term) ?? 0) + 1);
  };
  for (const value of history) {
    if (assignedHistory.has(historyStableKey(value))) continue;
    const line = newLine(value, value._relationEvidence === 'source' ? 'source' : value._relationEvidence === 'topic' ? 'topic' : ['commitment', 'openLoop'].includes(value.kind) ? 'continuity' : 'direct');
    if (!line) break;
    for (const related of history) {
      if (assignedHistory.has(historyStableKey(related))) continue;
      const exactLink = related._relationAnchorStableKey === historyStableKey(value);
      const evidence = exactLink && related._relationTerms?.length ? related._relationTerms : topicTerms(value, related);
      if (materiallySame(value, related) || evidence.length) addHistory(line, related, evidence);
    }
  }
  lines.forEach(keepLineEndpoints);
  const lineForCse = value => {
    const sourceFloors = new Set([value.floorId, value.sourceFloorId, value.before?.sourceFloorId, value.after?.sourceFloorId].filter(Boolean));
    const cseRecord = recordFor(value);
    for (const line of lines) {
      if (!line.history.length) {
        const sourceKeys = candidate => new Set([
          candidate.stateId, candidate.sourceFloorId, candidate.sourceDeltaId, candidate.deltaId,
          candidate.before?.stateId, candidate.before?.sourceFloorId, candidate.before?.sourceDeltaId,
          candidate.after?.stateId, candidate.after?.sourceFloorId, candidate.after?.sourceDeltaId,
        ].filter(Boolean));
        const candidateKeys = sourceKeys(value);
        const relatedCse = [...line.states, ...line.changes].some(existing => {
          if (existing.subjectEntityId !== value.subjectEntityId) return false;
          if (setIntersection(candidateKeys, sourceKeys(existing)).length) return true;
          const existingRecord = recordFor(existing);
          const shared = setIntersection(cseRecord.tokens, existingRecord.tokens).filter(token => token.length >= 2);
          const shorterSize = Math.max(1, Math.min(cseRecord.tokens.size, existingRecord.tokens.size));
          return shared.length >= 2 && shared.length / shorterSize >= 0.25;
        });
        if (relatedCse) return line;
      }
      for (const itemValue of line.history) {
        const itemRecord = historyRecords.get(historyStableKey(itemValue));
        if (!itemRecord) continue;
        if (sourceFloors.has(itemValue.floorId) && itemValue._relationEvidence === 'source' && itemValue._relationAnchorFloorId === itemValue.floorId) return line;
        const sharedPeople = setIntersection(cseRecord.participants, itemRecord.participants);
        if (!sharedPeople.length) continue;
        if (sourceFloors.has(itemValue.floorId) && materiallySame(value, itemValue)) return line;
        const shared = setIntersection(cseRecord.tokens, itemRecord.tokens)
          .filter(token => token.length >= 2 && (documentFrequency.get(token) ?? Number.MAX_SAFE_INTEGER) <= rareLimit);
        const shorterSize = Math.max(1, Math.min(cseRecord.tokens.size, itemRecord.tokens.size));
        const sharedRatio = shared.length / shorterSize;
        const strongSingle = shared.length === 1 && queryRelationTokens.has(shared[0]) && !RELATION_GENERIC_ACTION_TOKENS.has(shared[0]);
        if ((shared.length >= 2 && sharedRatio >= 0.25) || (strongSingle && sharedRatio >= 0.25)) return line;
      }
    }
    return null;
  };
  const neutralCseLine = () => lines.find(line => line.kind === 'source' && !line.history.length)
    ?? (lines.length < MAX_STORYLINES
      ? (() => {
        const line = { storylineId: `line-${lines.length + 1}`, kind: 'source', anchorKey: null, history: [], states: [], changes: [], terms: new Map(), historyTerms: new Map() };
        lines.push(line);
        return line;
      })()
      : null);
  for (const value of changes) {
    let line = lineForCse(value);
    if (!line) line = neutralCseLine();
    if (line) line.changes.push(value);
  }
  for (const value of states) {
    let line = lineForCse(value);
    if (!line) line = neutralCseLine();
    if (line) line.states.push(value);
  }
  const publicLines = lines.map(line => {
    const terms = [...line.terms].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0], 'zh-CN')).map(([term]) => clean(term, 48)).filter(Boolean);
    const displayTerms = terms.filter(term => queryRelationTokens.has(term) && !RELATION_GENERIC_ACTION_TOKENS.has(term)
      && (/[A-Za-z0-9]/u.test(term) || [...term].length >= 3)).slice(0, 2);
    const cseOnly = !line.history.length && (line.states.length || line.changes.length);
    const sourceLinked = line.history.some(value => value._relationEvidence === 'source');
    const topicLinked = line.history.some(value => value._relationEvidence === 'topic') || terms.length;
    const kinds = new Set(line.history.map(value => value.kind));
    const title = cseOnly ? '相关人物状态补充'
      : displayTerms.length ? `“${displayTerms.join('、')}”相关旧事`
        : (line.states.length || line.changes.length) ? '人物状态与相关旧事'
        : kinds.has('openLoop') && kinds.size > 1 ? '相关未决事项与背景'
          : line.kind === 'continuity' ? (kinds.has('openLoop') ? '相关未决事项' : '相关承诺')
            : sourceLinked ? '来源关联旧事'
              : [...kinds].some(kind => ['thought', 'intention', 'privateCognition', 'observation'].includes(kind)) ? '认知与态度相关旧事'
                : '相关事件进展';
    const basis = cseOnly
      ? '当前输入直接匹配以下已有人物状态材料；各条按真实来源时间排列，不表示彼此存在因果。'
      : topicLinked
      ? `${displayTerms.length ? `同一人物与当前输入中的具体主题词“${displayTerms.join('、')}”共同出现` : '材料包含同一人物与重复的具体主题词'}；按时间排列，不表示因果。`
      : sourceLinked ? '人物状态或变化记录引用这些来源；按时间排列，不表示因果。'
        : line.kind === 'continuity' ? `当前输入直接匹配这条已存${kinds.has('openLoop') ? '未决事项' : '承诺'}；作为单节点补充保留，不表示完整因果线。`
          : '当前输入直接匹配这些已存材料；若只有单节点，它只是补充背景。';
    return { storylineId: line.storylineId, title, basis };
  });
  const decorate = (value, line) => ({ ...value, _storylineId: line.storylineId });
  const historySelectionOrder = line => {
    const chronological = [...line.history].sort((a, b) => a.assistantSeq - b.assistantSeq || a._sourceOrder - b._sourceOrder);
    const anchor = line.history.find(value => historyStableKey(value) === line.anchorKey);
    return [...new Set([anchor, chronological.at(-1), chronological[0], ...[...line.history].sort(relationAnchorOrder)].filter(Boolean))];
  };
  return {
    storylines: publicLines,
    history: lines.flatMap(line => historySelectionOrder(line).map(value => decorate(value, line))),
    states: lines.flatMap(line => line.states.map(value => decorate(value, line))),
    changes: lines.flatMap(line => line.changes.map(value => decorate(value, line))),
  };
}

function historyCandidateText(value, entityById) {
  const chronology = formatChronologyAnchor(value._chronology ?? []);
  const source = `AI #${value.assistantSeq}${chronology ? `（${chronology}）` : ''}`;
  const names = ids => [...new Set((ids ?? []).filter(Boolean))].map(id => entityName(id, entityById)).join('、');
  let boundary = '客观剧情事实';
  if (value.category === 'narrative') boundary = '叙事回顾；可能含内心、计划或未完成事项，不代表所有人物知情；若与后文冲突以后文为准';
  else if (value.category === 'private') boundary = `私有内容；仅 ${entityName(value.ownerEntityId, entityById)} 可用`;
  else if (value.category === 'transfer') boundary = `信息传递；${value.fromEntityId ? entityName(value.fromEntityId, entityById) : '来源不明'} → ${names(value.toEntityIds)}；仅列明接收者知情`;
  else if (value.category === 'shared') boundary = `已表达/已共享；${entityName(value.speakerEntityId, entityById)} → ${names(value.targetEntityIds) || '未列明对象'}`;
  else if (value.kind === 'action') boundary = `行动；主体 ${entityName(value.actorEntityId, entityById)}${names(value.targetEntityIds) ? `；对象 ${names(value.targetEntityIds)}` : ''}`;
  else if (value._entityText) boundary += `；相关人物 ${value._entityText}`;
  return `${source}｜${boundary}｜类型 ${value.kind}｜${value.text}`;
}

export function buildRecallHistoryCandidatePool({ source, queryContext, historyContext = null, maxCandidates = MAX_LLM_HISTORY_CANDIDATES, maxCharacters = MAX_LLM_HISTORY_CHARACTERS } = {}) {
  const context = historyContext ?? historySelectionContext(source, queryContext);
  const itemLimit = Math.max(0, Math.min(MAX_LLM_HISTORY_CANDIDATES, Math.floor(Number(maxCandidates) || 0)));
  const charLimit = Math.max(0, Math.min(MAX_LLM_HISTORY_CHARACTERS, Math.floor(Number(maxCharacters) || 0)));
  if (!context || itemLimit === 0 || charLimit === 0) return Object.freeze({ candidates: Object.freeze([]), text: '', limits: Object.freeze({ maxCandidates: itemLimit, maxCharacters: charLimit, actualCandidates: 0, actualCharacters: 0 }) });
  const seen = new Set();
  const grouped = { summary: [], continuity: [], fact: [] };
  for (const value of [...context.direct, ...context.adjacent]) {
    const key = duplicateKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    grouped[value._poolGroup ?? 'fact'].push(value);
  }
  const groupOrder = ['summary', 'continuity', 'fact'];
  const totalWeight = Object.values(HISTORY_GROUP_WEIGHTS).reduce((sum, value) => sum + value, 0);
  const itemTargets = {
    summary: Math.floor(itemLimit * HISTORY_GROUP_WEIGHTS.summary / totalWeight),
    continuity: Math.floor(itemLimit * HISTORY_GROUP_WEIGHTS.continuity / totalWeight),
  };
  itemTargets.fact = itemLimit - itemTargets.summary - itemTargets.continuity;
  const charTargets = {
    summary: Math.floor(charLimit * HISTORY_GROUP_WEIGHTS.summary / totalWeight),
    continuity: Math.floor(charLimit * HISTORY_GROUP_WEIGHTS.continuity / totalWeight),
  };
  charTargets.fact = charLimit - charTargets.summary - charTargets.continuity;
  const candidates = [], lines = [], selected = new Set(), groupCharacters = { summary: 0, continuity: 0, fact: 0 };
  const floorRoundRobin = values => {
    const queues = new Map();
    for (const value of values) queues.set(value.floorId, [...(queues.get(value.floorId) ?? []), value]);
    const ordered = [];
    for (let offset = 0; ordered.length < values.length; offset += 1) {
      let added = false;
      for (const queue of queues.values()) {
        if (!queue[offset]) continue;
        ordered.push(queue[offset]); added = true;
      }
      if (!added) break;
    }
    return ordered;
  };
  const totalCharacters = () => lines.reduce((sum, line) => sum + line.length, 0) + Math.max(0, lines.length - 1);
  const tryAdd = (value, group, groupCharacterLimit = null) => {
    if (selected.has(value) || candidates.length >= itemLimit) return false;
    const key = `R${candidates.length + 1}`;
    const text = historyCandidateText(value, context.entityById);
    const line = `${key}｜${text}`;
    const separator = lines.length ? 1 : 0;
    if (totalCharacters() + separator + line.length > charLimit) return false;
    if (groupCharacterLimit !== null && groupCharacters[group] + (groupCharacters[group] ? 1 : 0) + line.length > groupCharacterLimit) return false;
    lines.push(line); selected.add(value); groupCharacters[group] += (groupCharacters[group] ? 1 : 0) + line.length;
    candidates.push(Object.freeze({ key, stableKey: historyStableKey(value), source: group, sourceKind: value._adjacentSummary ? 'adjacent' : 'matched', text, value }));
    return true;
  };
  for (const group of groupOrder) {
    let count = 0;
    if (group === 'continuity') {
      const commitmentTarget = Math.floor(itemTargets.continuity / 2);
      const openLoopTarget = itemTargets.continuity - commitmentTarget;
      for (const [kind, target] of [['commitment', commitmentTarget], ['openLoop', openLoopTarget]]) {
        let kindCount = 0;
        for (const value of floorRoundRobin(grouped.continuity.filter(itemValue => itemValue.kind === kind))) {
          if (kindCount >= target) break;
          if (tryAdd(value, group, charTargets[group])) { kindCount += 1; count += 1; }
        }
      }
      for (const value of floorRoundRobin(grouped.continuity)) {
        if (count >= itemTargets.continuity) break;
        if (tryAdd(value, group, charTargets[group])) count += 1;
      }
      continue;
    }
    for (const value of floorRoundRobin(grouped[group])) {
      if (count >= itemTargets[group]) break;
      if (tryAdd(value, group, charTargets[group])) count += 1;
    }
  }
  const remainder = groupOrder.flatMap(group => grouped[group].filter(value => !selected.has(value)).map((value, order) => ({ group, value, order })))
    .sort((a, b) => b.value.score - a.value.score || b.value.priority - a.value.priority || groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group) || a.order - b.order);
  for (const entry of remainder) tryAdd(entry.value, entry.group);
  const formatted = lines.join('\n');
  return Object.freeze({
    candidates: Object.freeze(candidates),
    text: formatted,
    limits: Object.freeze({ maxCandidates: itemLimit, maxCharacters: charLimit, actualCandidates: candidates.length, actualCharacters: formatted.length, groupCandidates: Object.freeze(Object.fromEntries(groupOrder.map(group => [group, candidates.filter(value => value.source === group).length]))), groupCharacters: Object.freeze({ ...groupCharacters }) }),
  });
}

const cseSidePayload = value => value ? {
  text: value.text,
  reason: value.reason,
  visibility: value.visibility,
  toward: value.toward ?? null,
  sourceAssistantSeq: value.sourceAssistantSeq ?? null,
} : null;

function cseCandidatePayload(candidate) {
  const value = candidate.value;
  if (candidate.source === 'current') return {
    key: candidate.key,
    kind: 'current',
    layer: value.layer,
    visibility: value.visibility,
    toward: value.toward ?? null,
    text: value.text,
    reason: value.reason,
    sourceAssistantSeq: value.sourceAssistantSeq ?? null,
  };
  return {
    key: candidate.key,
    kind: 'change',
    layer: value.layer,
    action: value.action,
    assistantSeq: value.assistantSeq,
    before: cseSidePayload(value.before),
    after: cseSidePayload(value.after),
  };
}

function roundRobinBySubject(values, preferredSubjects) {
  const subjectOrder = [...preferredSubjects];
  for (const value of values) if (!subjectOrder.includes(value.subjectEntityId)) subjectOrder.push(value.subjectEntityId);
  const queues = new Map(subjectOrder.map(subject => [subject, values.filter(value => value.subjectEntityId === subject)]));
  const result = [];
  for (let offset = 0; result.length < values.length; offset += 1) {
    let added = false;
    for (const subject of subjectOrder) {
      const value = queues.get(subject)?.[offset];
      if (!value) continue;
      result.push(value); added = true;
    }
    if (!added) break;
  }
  return result;
}

export function buildRecallCseCandidatePool({ source, queryContext, cseContext = null, maxCandidates = MAX_LLM_CSE_CANDIDATES, maxCharacters = MAX_LLM_CSE_CHARACTERS } = {}) {
  const context = cseContext ?? cseSelectionContext(source, queryContext);
  const itemLimit = Math.max(0, Math.min(MAX_LLM_CSE_CANDIDATES, Math.floor(Number(maxCandidates) || 0)));
  const charLimit = Math.max(0, Math.min(MAX_LLM_CSE_CHARACTERS, Math.floor(Number(maxCharacters) || 0)));
  const empty = () => Object.freeze({ candidates: Object.freeze([]), groups: Object.freeze([]), text: '', limits: Object.freeze({ maxCandidates: itemLimit, maxCharacters: charLimit, actualCandidates: 0, actualCharacters: 0, currentCandidates: 0, changeCandidates: 0 }) });
  if (!context || itemLimit === 0 || charLimit === 0) return empty();
  const unique = values => {
    const seen = new Set();
    return values.filter(value => {
      const key = cseStableKey(value);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  };
  const currentOrder = roundRobinBySubject(unique(context.states), context.entityOrder);
  const changeOrder = roundRobinBySubject(unique(context.changes)
    .sort((a, b) => b.assistantSeq - a.assistantSeq || b.score - a.score || b.priority - a.priority), context.entityOrder);
  const half = Math.floor(itemLimit / 2);
  const currentTarget = half, changeTarget = itemLimit - half;
  const priorityOrder = [];
  for (let index = 0; index < Math.max(currentTarget, changeTarget); index += 1) {
    if (index < currentTarget && currentOrder[index]) priorityOrder.push({ source: 'current', value: currentOrder[index] });
    if (index < changeTarget && changeOrder[index]) priorityOrder.push({ source: 'change', value: changeOrder[index] });
  }
  priorityOrder.push(
    ...currentOrder.slice(currentTarget).map(value => ({ source: 'current', value })),
    ...changeOrder.slice(changeTarget).map(value => ({ source: 'change', value })),
  );
  const candidates = [];
  const groupsFor = list => {
    const bySubject = new Map();
    for (const candidate of list) bySubject.set(candidate.value.subjectEntityId, [...(bySubject.get(candidate.value.subjectEntityId) ?? []), candidate]);
    const selectedSubjects = [...bySubject.keys()].sort((a, b) => {
      const left = context.entityOrder.indexOf(a), right = context.entityOrder.indexOf(b);
      return (left < 0 ? Number.MAX_SAFE_INTEGER : left) - (right < 0 ? Number.MAX_SAFE_INTEGER : right)
        || (context.entityById.get(a)?.displayName ?? '').localeCompare(context.entityById.get(b)?.displayName ?? '', 'zh-CN');
    });
    return selectedSubjects.map(subjectEntityId => {
      const entity = context.entityById.get(subjectEntityId);
      const items = bySubject.get(subjectEntityId).sort((a, b) => Number(a.source === 'change') - Number(b.source === 'change')
        || (a.source === 'change' ? a.value.assistantSeq - b.value.assistantSeq : currentOrder.indexOf(a.value) - currentOrder.indexOf(b.value)));
      return { subject: entity?.displayName ?? items[0].value.subject, specialRole: entity?.specialRole ?? 'none', items: items.map(cseCandidatePayload) };
    });
  };
  for (const entry of priorityOrder) {
    if (candidates.length >= itemLimit) break;
    const candidate = Object.freeze({ key: `C${candidates.length + 1}`, stableKey: cseStableKey(entry.value), source: entry.source, value: entry.value });
    const attempted = [...candidates, candidate];
    const groups = groupsFor(attempted);
    if (JSON.stringify(groups).length > charLimit) continue;
    candidates.push(candidate);
  }
  if (!candidates.length) return empty();
  const groups = groupsFor(candidates);
  const text = JSON.stringify(groups);
  return Object.freeze({
    candidates: Object.freeze(candidates),
    groups: Object.freeze(groups.map(group => Object.freeze({ ...group, items: Object.freeze(group.items.map(item => Object.freeze(item))) }))),
    text,
    limits: Object.freeze({ maxCandidates: itemLimit, maxCharacters: charLimit, actualCandidates: candidates.length, actualCharacters: text.length, currentCandidates: candidates.filter(value => value.source === 'current').length, changeCandidates: candidates.filter(value => value.source === 'change').length }),
  });
}

export function selectRecall({ source, queryContext, historyContext: providedHistoryContext = null, cseContext: providedCseContext = null, contextSize = 8192, maxFloors = MAX_RECALLED_FLOORS, maxItems = MAX_TOTAL_ITEMS, selectedHistoryCandidates, selectedCseCandidates, excludedHistoryCandidates = [], excludedCseCandidates = [], stateProgressionCandidates = [], reservedTokens = 0, reservedCharacters = 0 } = {}) {
  const emptyStages = input => Object.freeze({ input, candidates: 0, dropRecent: 0, dropPersistent: 0, dropVisibility: 0, selected: 0, recentSummaryCount: 0, distantHistoryItemCount: 0, linkedHistoryItemCount: 0, stateCount: 0, currentStateCount: 0, cseChangeCount: 0, linkedCseChangeCount: 0, stateProgressionCount: 0, budgetDroppedCount: 0, finalInjectionItemCount: 0 });
  if (source?.status !== 'ready') return Object.freeze({ status: 'empty', injectionText: '', floors: Object.freeze([]), states: Object.freeze([]), cseChanges: Object.freeze([]), stateProgressions: Object.freeze([]), stages: emptyStages(0), skipReasons: Object.freeze(['sourceUnavailable']) });
  const query = clean(queryContext?.text, MAX_QUERY_CHARACTERS);
  if (!query) return Object.freeze({ status: 'empty', injectionText: '', floors: Object.freeze([]), states: Object.freeze([]), cseChanges: Object.freeze([]), stateProgressions: Object.freeze([]), coverage: source.coverage, stages: Object.freeze({ ...emptyStages(0), candidates: source.floorMemories.length }), skipReasons: Object.freeze(['emptyQuery']) });
  const historyContext = providedHistoryContext ?? historySelectionContext(source, queryContext);
  const cseContext = providedCseContext ?? cseSelectionContext(source, queryContext);
  const oldMemories = historyContext.oldMemories;
  const entityById = historyContext.entityById;
  const explicitHistorySelection = Array.isArray(selectedHistoryCandidates);
  const historicalByStableKey = new Map([...historyContext.direct, ...historyContext.adjacent].map(value => [historyStableKey(value), value]));
  const historical = (explicitHistorySelection
    ? selectedHistoryCandidates.map(value => historicalByStableKey.get(value?.stableKey ?? historyStableKey(value?.value ?? value))).filter(Boolean)
    : historyContext.direct).map(value => ({ ...value, recallSection: 'distant' }));
  const specialRoleById = new Map(source.entities.map(entity => [entity.entityId, entity.specialRole ?? null]));
  const explicitCseSelection = Array.isArray(selectedCseCandidates);
  const cseByStableKey = new Map([...(cseContext?.states ?? []), ...(cseContext?.changes ?? [])].map(value => [cseStableKey(value), value]));
  const selectedCse = explicitCseSelection
    ? selectedCseCandidates.map(value => cseByStableKey.get(value?.stableKey ?? cseStableKey(value?.value ?? value))).filter(Boolean)
    : null;
  const linkedHistory = expandLinkedHistory({ context: historyContext, selectedHistory: historical, selectedCse: selectedCse ?? [], excludedHistory: excludedHistoryCandidates })
    .map(value => ({ ...value, recallSection: 'distant' }));
  const linkedCse = expandLinkedCse({ source, historyContext, selectedHistory: historical, linkedHistory, selectedCse: selectedCse ?? [], excludedCse: excludedCseCandidates });
  const stateRanked = explicitCseSelection ? selectedCse.filter(value => value._recallCseKind !== 'change') : (cseContext?.states ?? []);
  const changeRanked = explicitCseSelection ? [...selectedCse.filter(value => value._recallCseKind === 'change'), ...linkedCse] : [...(cseContext?.changes ?? []).filter(value => value.score > 0), ...linkedCse];
  const allowedItems = Math.max(0, Math.min(MAX_TOTAL_ITEMS, Math.floor(Number(maxItems) || 0)));
  const cseItemTarget = MAX_CSE_ITEMS, historyTarget = allowedItems;
  let dropPersistent = 0;
  const historyKeys = new Set();
  const recentHistoryBase = [...historyContext.recentSummaries].reverse().filter(value => {
    const key = duplicateKey(value);
    if (historyKeys.has(key)) { dropPersistent += 1; return false; }
    historyKeys.add(key);
    return true;
  });
  const candidateHistory = historical.filter(value => {
    const key = duplicateKey(value);
    if (historyKeys.has(key)) { dropPersistent += 1; return false; }
    historyKeys.add(key);
    return true;
  });
  const cseKeys = new Set();
  const zeroCoreFallbackRoles = new Set();
  const eligibleStates = stateRanked.filter(value => {
    if (explicitCseSelection) return true;
    if (value.score > 0) return true;
    if (value.layer !== 'core') return false;
    const role = specialRoleById.get(value.subjectEntityId);
    if (!['user', 'char'].includes(role) || zeroCoreFallbackRoles.has(role)) return false;
    zeroCoreFallbackRoles.add(role);
    return true;
  });
  const uniqueStates = eligibleStates.filter(value => {
    const key = duplicateKey(value);
    if (cseKeys.has(key)) { dropPersistent += 1; return false; }
    cseKeys.add(key);
    return true;
  });
  const uniqueChanges = changeRanked.filter(value => {
    const key = duplicateKey(value);
    if (cseKeys.has(key)) { dropPersistent += 1; return false; }
    cseKeys.add(key);
    return true;
  });
  const uniqueLinkedHistory = linkedHistory.filter(value => {
    const key = duplicateKey(value);
    if (historyKeys.has(key)) { dropPersistent += 1; return false; }
    historyKeys.add(key); return true;
  });
  const priorityDirectKeys = new Set(balancedRelationAnchors(candidateHistory).map(historyStableKey));
  const priorityDirectHistory = candidateHistory.filter(value => priorityDirectKeys.has(historyStableKey(value)));
  const remainingDirectHistory = candidateHistory.filter(value => !priorityDirectKeys.has(historyStableKey(value)));
  const baseHistory = [...priorityDirectHistory, ...uniqueLinkedHistory, ...remainingDirectHistory];
  const storylinePlan = buildStorylinePlan({ context: historyContext, history: baseHistory, states: uniqueStates, changes: uniqueChanges });
  const recentStoryline = recentHistoryBase.length ? Object.freeze({
    storylineId: 'recent', title: '近期剧情接续', basis: '最近的连续摘要按真实来源时间排列；与当前可见正文重复的楼已排除。',
  }) : null;
  const recentHistory = recentHistoryBase.map(value => ({ ...value, _storylineId: 'recent' }));
  const uniqueHistory = storylinePlan.history;
  const plannedStates = storylinePlan.states;
  const plannedChanges = storylinePlan.changes;
  const storylineDefinitions = [...(recentStoryline ? [recentStoryline] : []), ...storylinePlan.storylines];
  const floorLimit = Math.max(0, Math.min(MAX_RECALLED_FLOORS, Number.isSafeInteger(maxFloors) ? maxFloors : MAX_RECALLED_FLOORS));
  const { characterLimit: charLimit, tokenLimit } = recallBudget(contextSize, { reservedTokens, reservedCharacters });
  const { characterLimit: progressionCharLimit, tokenLimit: progressionTokenLimit } = recallBudgetWithProgression(contextSize, { reservedTokens, reservedCharacters });
  const historyTokenTarget = Math.floor(tokenLimit * 0.72);
  const historyCharTarget = Math.floor(charLimit * 2 / 3), cseCharTarget = charLimit - historyCharTarget;
  const chosenStates = [], chosenChanges = [], chosenProgressions = [], chosenRecent = [], chosenDistant = [], chosenHistory = [], chosenFloorIds = new Set();
  const render = (states = chosenStates, changes = chosenChanges, history = chosenHistory, progressions = chosenProgressions) => {
    const floorMap = new Map();
    for (const value of history) {
      const floor = floorMap.get(value.floorId) ?? { floorId: value.floorId, floorMemoryId: value.floorMemoryId, assistantSeq: value.assistantSeq, chronology: value._chronology ?? [], score: 0, reasons: new Set(), items: [] };
      floor.score = Math.max(floor.score, value.score);
      floor.reasons.add(value.recallSection === 'recent' ? 'recentSummary' : value.kind);
      if (value._relationEvidence === 'source') floor.reasons.add('linkedSource');
      if (value._relationEvidence === 'topic') floor.reasons.add('linkedTopic');
      if (value._relationEvidence === 'nearby') floor.reasons.add('nearbyContext');
      if (value.truncated) floor.reasons.add('truncated');
      for (const [branch, branchScore] of Object.entries(value.branchScores)) if (branchScore > 0) floor.reasons.add(`bm25:${branch}`);
      if (Object.values(value.entityBranchScores).some(score => score > 0)) floor.reasons.add('entity');
      if (Object.values(value.summaryScores).some(score => score > 0)) floor.reasons.add('summary');
      floor.items.push(publicItem(value));
      floorMap.set(value.floorId, floor);
    }
    const floors = [...floorMap.values()].map(floor => ({ ...floor, reasons: [...floor.reasons] })).sort((a, b) => a.assistantSeq - b.assistantSeq || a.floorId.localeCompare(b.floorId));
    const subjectOrder = new Map((source.entities ?? []).map((entity, index) => [entity.entityId, index]));
    const publicStates = [...states]
      .sort((a, b) => (subjectOrder.get(a.subjectEntityId) ?? Number.MAX_SAFE_INTEGER) - (subjectOrder.get(b.subjectEntityId) ?? Number.MAX_SAFE_INTEGER)
        || a.layer.localeCompare(b.layer) || (a.sourceAssistantSeq ?? 0) - (b.sourceAssistantSeq ?? 0))
      .map(publicItem);
    const publicChanges = [...changes]
      .sort((a, b) => (subjectOrder.get(a.subjectEntityId) ?? Number.MAX_SAFE_INTEGER) - (subjectOrder.get(b.subjectEntityId) ?? Number.MAX_SAFE_INTEGER)
        || a.assistantSeq - b.assistantSeq || a.layer.localeCompare(b.layer))
      .map(value => ({ ...publicItem(value), floorId: value.floorId, assistantSeq: value.assistantSeq }));
    const activeIds = new Set([
      ...floors.flatMap(floor => floor.items.map(value => value.storylineId)),
      ...publicStates.map(value => value.storylineId),
      ...publicChanges.map(value => value.storylineId),
    ].filter(Boolean));
    const storylines = storylineDefinitions.filter(value => activeIds.has(value.storylineId));
    const publicProgressions = progressions.map(value => ({
      subjectEntityId: value.subjectEntityId, subject: value.subject, towardEntityId: value.towardEntityId ?? null, toward: value.toward ?? null,
      savedText: value.savedText, visibility: value.visibility, sourceStateId: value.sourceStateId, sourceFloorId: value.sourceFloorId,
      sourceAssistantSeq: value.sourceAssistantSeq ?? null, timeBasis: value.timeBasis, suggestion: value.suggestion,
      evidence: value.evidence.map(item => ({ kind: item.kind === 'recent' ? 'history' : item.kind, floorId: item.floorId, assistantSeq: item.assistantSeq })),
    }));
    return { floors, states: publicStates, cseChanges: publicChanges, stateProgressions: publicProgressions, storylines, text: formatRecallInjection({ coverage: source.coverage, floors, states: publicStates, cseChanges: publicChanges, stateProgressions: publicProgressions, entityById, storylines }) };
  };
  let dropSemanticDuplicate = 0;
  const historyCoversCse = value => {
    const sourceFloors = new Set([value.floorId, value.sourceFloorId, value.before?.sourceFloorId, value.after?.sourceFloorId].filter(Boolean));
    const parts = value._recallCseKind === 'change' ? [value.before?.text, value.after?.text].filter(Boolean) : [value.text].filter(Boolean);
    if (!sourceFloors.size || !parts.length) return false;
    const sameFloorHistory = chosenHistory.filter(itemValue => sourceFloors.has(itemValue.floorId));
    return parts.every(part => sameFloorHistory.some(itemValue => materiallySame({ text: part }, itemValue)));
  };
  const canAddCse = (value, kind, groupLimit = null) => {
    if (chosenStates.length + chosenChanges.length >= cseItemTarget) return false;
    if (chosenHistory.some(selected => duplicateKey(selected) === duplicateKey(value))) { dropPersistent += 1; return false; }
    if (historyCoversCse(value)) { dropSemanticDuplicate += 1; return false; }
    const states = kind === 'state' ? [...chosenStates, value] : chosenStates;
    const changes = kind === 'change' ? [...chosenChanges, value] : chosenChanges;
    if (groupLimit !== null && render(states, changes, []).text.length > groupLimit) return false;
    const text = render(states, changes, chosenHistory).text;
    return text.length <= charLimit && estimateRecallTokens(text) <= tokenLimit;
  };
  const canAddHistory = (value, groupLimit = null) => {
    if (chosenHistory.includes(value) || chosenHistory.length >= allowedItems) return false;
    if ([...chosenStates, ...chosenChanges].some(selected => duplicateKey(selected) === duplicateKey(value))) return false;
    const newFloor = !chosenFloorIds.has(value.floorId);
    if (newFloor && chosenFloorIds.size >= floorLimit) return false;
    if (groupLimit !== null) {
      const historyText = render([], [], [...chosenHistory, value]).text;
      if (historyText.length > groupLimit || estimateRecallTokens(historyText) > historyTokenTarget) return false;
    }
    const text = render(chosenStates, chosenChanges, [...chosenHistory, value]).text;
    return text.length <= charLimit && estimateRecallTokens(text) <= tokenLimit;
  };
  const addHistory = value => {
    chosenHistory.push(value);
    (value.recallSection === 'recent' ? chosenRecent : chosenDistant).push(value);
    chosenFloorIds.add(value.floorId);
  };
  const storylineHistoryOrder = [];
  const lineIds = [...new Set(uniqueHistory.map(value => value._storylineId))];
  for (let offset = 0; storylineHistoryOrder.length < uniqueHistory.length; offset += 1) {
    let added = false;
    for (const lineId of lineIds) {
      const value = uniqueHistory.filter(itemValue => itemValue._storylineId === lineId)[offset];
      if (!value) continue;
      storylineHistoryOrder.push(value); added = true;
    }
    if (!added) break;
  }
  for (const value of recentHistory) if (canAddHistory(value)) addHistory(value);
  for (const value of storylineHistoryOrder) if (canAddHistory(value, historyCharTarget)) addHistory(value);
  const cseCandidates = [...plannedChanges, ...plannedStates]
    .sort((a, b) => (b.branchScores.latestUser ?? 0) - (a.branchScores.latestUser ?? 0) || b.score - a.score || b.priority - a.priority || (b.assistantSeq ?? 0) - (a.assistantSeq ?? 0));
  for (const value of cseCandidates) {
    if (chosenStates.length + chosenChanges.length >= cseItemTarget) break;
    const kind = value._recallCseKind === 'change' ? 'change' : 'state';
    if (!canAddCse(value, kind)) continue;
    (kind === 'change' ? chosenChanges : chosenStates).push(value);
  }
  for (const value of recentHistory) if (canAddHistory(value)) addHistory(value);
  for (const value of uniqueHistory) if (canAddHistory(value)) addHistory(value);
  const selectedHistoryKeys = () => new Set(chosenHistory.map(historyStableKey));
  const selectedCseKeys = () => new Set([...chosenStates, ...chosenChanges].map(cseStableKey));
  let progressionBudgetDropped = 0;
  for (const value of Array.isArray(stateProgressionCandidates) ? stateProgressionCandidates.slice(0, 8) : []) {
    const cseKeysNow = selectedCseKeys(), historyKeysNow = selectedHistoryKeys();
    if (!cseKeysNow.has(value.sourceStateStableKey)) continue;
    if (!value.evidence.every(item => item.kind === 'recent'
      ? chosenRecent.some(recent => recent.floorId === item.floorId && recent.assistantSeq === item.assistantSeq && recent.text === item.text)
      : (item.kind === 'history' ? historyKeysNow : cseKeysNow).has(item.stableKey))) continue;
    const text = render(chosenStates, chosenChanges, chosenHistory, [...chosenProgressions, value]).text;
    if (text.length <= progressionCharLimit && estimateRecallTokens(text) <= progressionTokenLimit) chosenProgressions.push(value);
    else progressionBudgetDropped += 1;
  }
  const rendered = render();
  const floors = rendered.floors, states = rendered.states, cseChanges = rendered.cseChanges, stateProgressions = rendered.stateProgressions, storylines = rendered.storylines, injectionText = rendered.text;
  const skipReasons = [...(source.degradedReasons ?? [])];
  if (historyContext.bodyCoveredFloorIds.size) skipReasons.push('coreBodyDuplicate');
  if (!historical.length) skipReasons.push('noReliableMemoryMatch');
  if (dropPersistent) skipReasons.push('persistentStateDuplicate');
  if (!source.coverage.cseCurrent) skipReasons.push('dynamicStateCoverageIncomplete');
  return Object.freeze({
    status: injectionText ? 'ready' : 'empty',
    injectionText,
    coverage: source.coverage,
    query: Object.freeze({ text: query, latestUserText: clean(queryContext?.latestUserText, 4000) }),
    floors: Object.freeze(floors.map(floor => Object.freeze({ ...floor, reasons: Object.freeze(floor.reasons), items: Object.freeze(floor.items.map(value => Object.freeze(value))) }))),
    states: Object.freeze(states.map(value => Object.freeze(value))),
    cseChanges: Object.freeze(cseChanges.map(value => Object.freeze(value))),
    stateProgressions: Object.freeze(stateProgressions.map(value => Object.freeze({ ...value, evidence: Object.freeze(value.evidence.map(item => Object.freeze(item))) }))),
    storylines: Object.freeze(storylines.map(value => Object.freeze({ ...value }))),
    stages: Object.freeze({ input: queryContext?.messageCount ?? 0, candidates: source.floorMemories.length, dropRecent: source.floorMemories.length - oldMemories.length, dropPersistent, dropVisibility: source.coverage.cseCurrent ? 0 : source.currentState.reduce((sum, subject) => sum + subject.core.length + subject.adaptive.length + subject.situational.length, 0), selected: floors.length, recentSummaryCount: chosenRecent.length, distantHistoryItemCount: chosenDistant.length, linkedHistoryItemCount: chosenDistant.filter(value => value._relationEvidence === 'source' || value._relationEvidence === 'topic').length, stateCount: states.length, currentStateCount: states.length, cseChangeCount: cseChanges.length, linkedCseChangeCount: chosenChanges.filter(value => value._relationEvidence === 'source').length, stateProgressionCount: stateProgressions.length, storylineCount: storylines.length, semanticDuplicateCount: dropSemanticDuplicate, recentSummaryDroppedByBudget: recentHistory.length - chosenRecent.length, distantHistoryDroppedByBudget: uniqueHistory.length - chosenDistant.length, budgetDroppedCount: Math.max(0, recentHistory.length - chosenRecent.length) + Math.max(0, baseHistory.length - chosenDistant.length) + Math.max(0, uniqueStates.length + uniqueChanges.length - states.length - cseChanges.length - dropSemanticDuplicate) + progressionBudgetDropped, finalInjectionItemCount: chosenHistory.length + states.length + cseChanges.length + stateProgressions.length, estimatedTokenCount: estimateRecallTokens(injectionText), estimatedTokenBudget: progressionTokenLimit, ordinaryEstimatedTokenBudget: tokenLimit }),
    skipReasons: Object.freeze(skipReasons),
    limits: Object.freeze({ maxFloors: floorLimit, maxItems: allowedItems, maxCharacters: progressionCharLimit, ordinaryMaxCharacters: charLimit, actualCharacters: injectionText.length, estimatedTokenBudget: progressionTokenLimit, ordinaryEstimatedTokenBudget: tokenLimit, estimatedTokenCount: estimateRecallTokens(injectionText), tokenEstimateMethod: 'cjk1-latin4-punctuation2', historyEstimatedTokenTarget: historyTokenTarget, stateItemTarget: cseItemTarget, cseItemTarget, historyItemTarget: historyTarget, stateCharacterTarget: cseCharTarget, cseCharacterTarget: cseCharTarget, historyCharacterTarget: historyCharTarget }),
  });
}
