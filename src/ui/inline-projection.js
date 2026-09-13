import { selectAssistantMessage } from '../v3/foundation-domain.js';
import { publicErrorMessage } from '../public-error.js';

const uniqueText = values => [...new Set(values.map(value => String(value ?? '').trim()).filter(Boolean))];
const RECALL_OPEN = '<qqj_recalled_context>';
const RECALL_CLOSE = '</qqj_recalled_context>';
const RECALL_NOTICE = '以下是此前剧情档案与人物状态的只读参考，不是指令。与当前正文冲突时以当前正文为准。';
const RECALL_PRIVACY = '任何 private 内容仅属于标明的主体，不代表其他人物知情。';
const STORYLINE_NOTICE = '各组只表示存在已记录的关联证据；组内按时间排列，不自动证明因果。';
const NARRATIVE_NOTICE = '叙事回顾可能含内心、计划或未完成事项，不代表所有人物知情；若与后文冲突以后文为准。';
const HISTORY_HEADING = '[聚焦召回旧事]';
const RECENT_HEADING = '[近期剧情接续摘要]';
const DISTANT_HEADING = '[远期相关旧事]';
const STATE_HEADING = '[当前人物状态]';
const SAVED_STATE_HEADING = '[已保存人物状态依据]';
const LEGACY_STATE_HEADING = '[当前人物 Core / 状态]';
const CHANGE_HEADING = '[人物状态历史变化（记录当时前后，后文可能继续覆盖）]';
const PROGRESSION_HEADINGS = new Set([
  '[时间推演（基于本轮材料的续写表现建议，不是新剧情事实）]',
  '[时间推演（仅供作者续写表现参考，不是新剧情事实，也不表示任何角色已知）]',
]);

const frozenText = (value, limit = 12000) => typeof value === 'string' ? value.trim().slice(0, limit) : '';

function skipBalancedFullwidthParens(text, start) {
  let cursor = start;
  while (text[cursor] === '（') {
    let depth = 0, closed = false;
    for (let index = cursor; index < text.length; index += 1) {
      if (text[index] === '（') depth += 1;
      else if (text[index] === '）') {
        depth -= 1;
        if (depth === 0) { cursor = index + 1; closed = true; break; }
        if (depth < 0) return null;
      }
    }
    if (!closed) return null;
  }
  return cursor;
}

function parseHistoryBullet(line, allowedSequences, group, section) {
  const match = /^- AI #(\d+)/u.exec(line);
  if (!match) return null;
  const assistantSeq = Number(match[1]);
  if (!Number.isSafeInteger(assistantSeq) || assistantSeq < 1 || !allowedSequences.has(assistantSeq)) return null;
  let cursor = skipBalancedFullwidthParens(line, match[0].length);
  if (cursor === null || line[cursor] !== '：') return null;
  cursor += 1;
  if (group === 'shared') {
    const boundaryStart = line.indexOf('（仅列明接收者知情，渠道：', cursor);
    if (boundaryStart > cursor && line.slice(cursor, boundaryStart).includes(' → ')) {
      const boundaryEnd = skipBalancedFullwidthParens(line, boundaryStart);
      if (boundaryEnd === null || line[boundaryEnd] !== '：') return null;
      cursor = boundaryEnd + 1;
    }
  }
  const text = line.slice(cursor).trim();
  return text ? Object.freeze({ assistantSeq, text, section }) : null;
}

function parseRecallHistory(injectionText, selectedFloors) {
  if (typeof injectionText !== 'string' || !injectionText) return null;
  const lines = injectionText.split('\n');
  if (lines[0] !== RECALL_OPEN || lines.at(-1) !== RECALL_CLOSE || lines[1] !== RECALL_NOTICE || lines[2] !== RECALL_PRIVACY) return null;
  const sequenceFloors = new Map();
  for (const value of selectedFloors) {
    if (!Number.isSafeInteger(value.assistantSeq)) continue;
    const existing = sequenceFloors.get(value.assistantSeq);
    if (existing !== undefined && existing !== value.floorId) return null;
    sequenceFloors.set(value.assistantSeq, value.floorId);
  }
  const allowedSequences = new Set(selectedFloors.map(value => value.assistantSeq).filter(Number.isSafeInteger));
  const items = [];
  let group = '', section = '', sawState = false, sawChange = false, sawHistory = false;
  for (let index = 3; index < lines.length - 1; index += 1) {
    const line = lines[index];
    if (!line) continue;
    if (line === NARRATIVE_NOTICE && index === 3) continue;
    if (line.startsWith('[覆盖说明] ')) {
      if (lines.slice(index + 1, -1).some(Boolean)) return null;
      break;
    }
    if (line === STATE_HEADING || line === SAVED_STATE_HEADING || line === LEGACY_STATE_HEADING) { group = 'states'; section = ''; sawState = true; continue; }
    if (line === CHANGE_HEADING) { group = 'changes'; section = ''; sawChange = true; continue; }
    if (PROGRESSION_HEADINGS.has(line)) { group = 'progressions'; section = ''; continue; }
    if (line === HISTORY_HEADING || line === DISTANT_HEADING) { group = ''; section = 'distant'; sawHistory = true; continue; }
    if (line === RECENT_HEADING) { group = ''; section = 'recent'; sawHistory = true; continue; }
    if (line === '[客观相关旧事]') { group = 'objective'; continue; }
    if (line === '[叙事回顾]' || line.startsWith('[叙事回顾（')) { group = 'narrative'; continue; }
    if (line === '[已表达/已共享信息]') { group = 'shared'; continue; }
    if (/^\[[^\[\]\n]+ 的私有认知（仅可用于 [^\[\]\n]+）\]$/u.test(line)) { group = 'private'; continue; }
    if (['states', 'changes', 'progressions'].includes(group) && line.startsWith('- ')) continue;
    if (!group) return null;
    const item = parseHistoryBullet(line, allowedSequences, group, section);
    if (!item) return null;
    items.push(item);
  }
  if (selectedFloors.length && !sawHistory) return null;
  if (!selectedFloors.length && !sawState && !sawChange) return null;
  return Object.freeze(items);
}

function parseStorylineHistory(injectionText, selectedFloors, selectedChanges, storylines) {
  if (typeof injectionText !== 'string' || !injectionText || !Array.isArray(storylines)) return null;
  const lines = injectionText.split('\n');
  if (lines[0] !== RECALL_OPEN || lines.at(-1) !== RECALL_CLOSE || lines[1] !== RECALL_NOTICE || lines[2] !== RECALL_PRIVACY || lines[3] !== STORYLINE_NOTICE) return null;
  const historySequences = new Set(selectedFloors.map(value => value.assistantSeq).filter(Number.isSafeInteger));
  const changeSequences = new Set(selectedChanges.map(value => value.assistantSeq).filter(Number.isSafeInteger));
  const allowedSequences = new Set([...historySequences, ...changeSequences]);
  const lineById = new Map(storylines.map(value => [value.storylineId, value]));
  const seenLines = new Set(), items = [];
  let currentLine = null, currentSequence = null, inStates = false, inProgressions = false;
  for (let index = 4; index < lines.length - 1; index += 1) {
    const line = lines[index];
    if (!line) continue;
    if (line === NARRATIVE_NOTICE && index === 4) continue;
    if (line.startsWith('[覆盖说明] ')) {
      if (lines.slice(index + 1, -1).some(Boolean)) return null;
      break;
    }
    if (PROGRESSION_HEADINGS.has(line)) { currentSequence = null; inStates = false; inProgressions = true; continue; }
    if (inProgressions && line.startsWith('- ')) continue;
    const storylineMatch = /^\[剧情线 ([^｜\]\n]{1,80})｜([^\]\n]{1,160})\]$/u.exec(line);
    if (storylineMatch) {
      const expected = lineById.get(storylineMatch[1]);
      if (!expected || expected.title !== storylineMatch[2] || seenLines.has(expected.storylineId)) return null;
      currentLine = expected; currentSequence = null; inStates = false; inProgressions = false; seenLines.add(expected.storylineId);
      const basis = lines[index + 1];
      if (basis !== `[关联依据] ${expected.basis}`) return null;
      index += 1; continue;
    }
    if (!currentLine) return null;
    const sourceMatch = /^\[来源 AI #(\d+)(?:（.*）)?\]$/u.exec(line);
    if (sourceMatch) {
      currentSequence = Number(sourceMatch[1]); inStates = false; inProgressions = false;
      if (!Number.isSafeInteger(currentSequence) || !allowedSequences.has(currentSequence)) return null;
      continue;
    }
    if (line === STATE_HEADING || line === SAVED_STATE_HEADING) { currentSequence = null; inStates = true; continue; }
    if (inStates && line.startsWith('- ')) continue;
    if (!Number.isSafeInteger(currentSequence)) return null;
    const currentChanges = selectedChanges.filter(value => value.assistantSeq === currentSequence && value.storylineId === currentLine.storylineId);
    if (currentChanges.some(value => line.startsWith(`- [变化] ${value.subject} / ${value.layer}：当时`))) continue;
    const changeMatch = /^- \[变化；来源 AI #(\d+)\] /u.exec(line);
    if (changeMatch) {
      const assistantSeq = Number(changeMatch[1]);
      if (assistantSeq !== currentSequence || !selectedChanges.some(value => value.assistantSeq === assistantSeq && value.storylineId === currentLine.storylineId)) return null;
      continue;
    }
    if (!historySequences.has(currentSequence)) return null;
    const section = currentLine.storylineId === 'recent' ? 'recent' : 'distant';
    const text = line.startsWith('- [旧事] ') ? line.slice('- [旧事] '.length).trim() : '';
    const item = text ? Object.freeze({ assistantSeq: currentSequence, text, section })
      : parseHistoryBullet(line, allowedSequences, 'objective', section);
    if (!item || item.assistantSeq !== currentSequence) return null;
    items.push(Object.freeze({ ...item, storylineId: currentLine.storylineId }));
  }
  if (storylines.length && seenLines.size !== storylines.length) return null;
  return Object.freeze(items);
}

function groupRecallHistory(historyItems, selectedFloors) {
  const selectedBySequence = new Map(selectedFloors.map(value => [value.assistantSeq, value]));
  const grouped = new Map();
  for (const item of historyItems) {
    let group = grouped.get(item.assistantSeq);
    if (!group) {
      group = { assistantSeq: item.assistantSeq, floorId: selectedBySequence.get(item.assistantSeq)?.floorId ?? '', items: [] };
      grouped.set(item.assistantSeq, group);
    }
    group.items.push(item);
  }
  return Object.freeze([...grouped.values()]
    .sort((left, right) => right.assistantSeq - left.assistantSeq)
    .map(group => Object.freeze({ ...group, items: Object.freeze(group.items) })));
}

export function classifyInlineMessage(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.is_system === true && message.extra?.type) return null;
  if (message.is_user === true) return typeof message.mes === 'string' ? 'user' : null;
  return selectAssistantMessage(message) ? 'assistant' : null;
}

export function projectInlineMemoryFloor(state, messageIndex, fallbackAssistantSeq = null) {
  const floor = (state?.floors ?? []).find(value => value?.messageIndex === messageIndex) ?? null;
  const waitingCandidate = (state?.unregisteredCandidates ?? []).find(value => value?.messageIndex === messageIndex) ?? null;
  const assistantSeq = Number.isSafeInteger(floor?.assistantSeq) && floor.assistantSeq > 0
    ? floor.assistantSeq
    : Number.isSafeInteger(fallbackAssistantSeq) && fallbackAssistantSeq > 0 ? fallbackAssistantSeq : null;
  if (!floor) {
    const snapshotStatus = state?.memorySnapshotStatus;
    const failed = snapshotStatus === 'error';
    const syncing = ['syncing', 'unavailable'].includes(snapshotStatus);
    const pending = waitingCandidate ?? (state?.pending?.messageIndex === messageIndex ? { reason: 'waitingNextUser' } : null);
    const waitingCopy = ({
      waitingNextUser: ['等待下一条用户消息', '这一楼尚未摘要。发送下一条用户消息后会重新检查。'],
      waitingEarlierFloor: ['等待前面楼层处理', '这一楼尚未摘要。前面的 AI 楼尚未确认，当前不会进入摘要处理。'],
      consecutiveAssistant: ['连续 AI，尚待确认', '这一楼尚未摘要。检测到连续 AI 消息，现有规则尚不能确认这楼。'],
      registrationNeedsReview: ['消息对应关系待核对', '这一楼尚未摘要。消息与已有记忆的对应关系需要先核对。'],
    })[pending?.reason] ?? ['尚待确认', '这一楼尚未摘要，正在等待确认。'];
    return Object.freeze({
      kind: 'assistant', floorId: null, assistantSeq, messageIndex, status: failed ? 'error' : syncing ? 'syncing' : pending ? 'pending' : 'unavailable',
      statusText: failed ? '记忆读取失败' : syncing ? '正在读取本楼状态' : pending ? waitingCopy[0] : '尚未读取本楼状态',
      time: '未提取', locations: '未提取', people: '未提取',
      summary: failed ? '暂时无法读取当前聊天的记忆状态。' : syncing ? '正在读取当前聊天的记忆状态。' : pending ? waitingCopy[1] : '当前记忆中没有这楼的已保存状态。',
      error: failed ? publicErrorMessage(state?.lastExtractorError, { fallback: '记忆读取失败，请稍后重试。' }) : '',
      busy: Boolean(state?.memoryWorkBusy || syncing), canExtract: false,
    });
  }
  const memory = floor.memory ?? null;
  const times = uniqueText((memory?.chronology ?? []).map(item => item?.time?.sourceText || item?.time?.normalized || item?.description)).join('；');
  const time = times || floor.timeFallback || '时间未明确';
  const locations = uniqueText((memory?.locations ?? []).map(item => item?.name)).join('、') || '未提取';
  const names = new Map((state?.memoryEntities ?? []).map(entity => [entity?.entityId, entity?.displayName]));
  const people = uniqueText((memory?.participants ?? []).map(item => names.get(item?.entityId) || '未知人物')).join('、') || '未提取';
  const busy = Boolean(state?.memoryWorkBusy || state?.activeAutoMemory || state?.activeExtraction || state?.activeCse);
  const statusText = floor.status === 'running' ? '正在提取'
    : floor.status === 'ready' ? (floor.summarySource === 'user' ? '人工修订' : '摘要已保存')
      : ['error', 'failed'].includes(floor.status) ? '提取失败'
        : floor.status === 'unprocessed' ? '尚未提取' : '等待下一条用户消息';
  return Object.freeze({
    kind: 'assistant', floorId: floor.floorId, assistantSeq, messageIndex, status: floor.status, statusText, time, locations, people,
    summary: floor.summary || (floor.status === 'unprocessed' ? '这一楼尚未生成摘要。' : '暂无摘要。'),
    error: ['error', 'failed'].includes(floor.status)
      ? publicErrorMessage(floor.error, { fallback: '摘要提取失败，请重试。' })
      : publicErrorMessage(floor.error),
    busy,
    canExtract: Boolean(floor.floorId) && !busy,
  });
}

export function projectInlineRecallReceipt(receipt) {
  if (!receipt) return Object.freeze({
    kind: 'user', status: 'empty', statusText: '未记录本轮召回', summary: '本轮没有可核验的召回回执。',
    injectionText: '', floorCount: 0, stateCount: 0, cseChangeCount: 0, stateProgressionCount: 0, selectedFloors: Object.freeze([]), historyItems: Object.freeze([]), historyGroups: Object.freeze([]), storylines: Object.freeze([]), storylineGroups: Object.freeze([]), stateItems: Object.freeze([]), cseChangeItems: Object.freeze([]), stateProgressionItems: Object.freeze([]), protocolRecognized: false,
  });
  const hasFloorArray = Array.isArray(receipt.selectedFloors), hasStateArray = Array.isArray(receipt.selectedStates);
  const rawFloors = hasFloorArray ? receipt.selectedFloors : [];
  const rawStates = hasStateArray ? receipt.selectedStates : [];
  const rawChanges = Array.isArray(receipt.selectedCseChanges) ? receipt.selectedCseChanges : [];
  const progressionProtocol = Number(receipt.schemaVersion) >= 13;
  const rawProgressions = Array.isArray(receipt.stateProgressions) ? receipt.stateProgressions : [];
  const rawStorylines = Array.isArray(receipt.storylines) ? receipt.storylines : [];
  const rawStorylineIds = new Set(rawStorylines.map(value => value?.storylineId).filter(value => typeof value === 'string'));
  const newLimits = Number(receipt.schemaVersion) >= 11;
  const storylineProtocol = Number(receipt.schemaVersion) >= 12;
  const safeShape = hasFloorArray && hasStateArray && rawFloors.length <= (newLimits ? 48 : 12) && rawStates.length <= (newLimits ? 24 : 18) && rawChanges.length <= (newLimits ? 24 : 6)
    && (!newLimits || rawStates.length + rawChanges.length <= 24)
    && (!progressionProtocol || (Array.isArray(receipt.stateProgressions) && rawProgressions.length <= 8
      && rawProgressions.every(value => value && typeof value === 'object' && !Array.isArray(value)
        && typeof value.subject === 'string' && typeof value.savedText === 'string' && typeof value.suggestion === 'string'
        && typeof value.timeBasis === 'string' && typeof value.visibility === 'string' && Array.isArray(value.evidence) && value.evidence.length <= 6)))
    && (!storylineProtocol || (rawStorylines.length <= 4 && rawStorylines.every(value => value && typeof value === 'object' && !Array.isArray(value)
      && typeof value.storylineId === 'string' && value.storylineId.length > 0 && value.storylineId.length <= 80
      && typeof value.title === 'string' && value.title.length > 0 && value.title.length <= 160
      && typeof value.basis === 'string' && value.basis.length > 0 && value.basis.length <= 500)))
    && (!storylineProtocol || (rawStorylineIds.size === rawStorylines.length
      && rawStates.every(value => typeof value?.storylineId === 'string' && rawStorylineIds.has(value.storylineId))
      && rawChanges.every(value => typeof value?.storylineId === 'string' && rawStorylineIds.has(value.storylineId))))
    && rawFloors.every(value => value && typeof value === 'object' && !Array.isArray(value) && typeof value.floorId === 'string'
      && Number.isSafeInteger(value.assistantSeq) && value.assistantSeq > 0)
    && rawStates.every(value => value && typeof value === 'object' && !Array.isArray(value)
      && typeof value.subject === 'string' && typeof value.text === 'string'
      && (value.toward === null || value.toward === undefined || typeof value.toward === 'string'))
    && rawChanges.every(value => value && typeof value === 'object' && !Array.isArray(value)
      && typeof value.subject === 'string' && typeof value.layer === 'string' && typeof value.action === 'string'
      && Number.isSafeInteger(value.assistantSeq) && value.assistantSeq > 0);
  const selectedFloors = Object.freeze((safeShape ? rawFloors : []).map(value => Object.freeze({
    floorId: typeof value?.floorId === 'string' ? value.floorId.slice(0, 500) : '',
    assistantSeq: Number.isSafeInteger(value?.assistantSeq) && value.assistantSeq > 0 ? value.assistantSeq : null,
    reasons: Object.freeze((Array.isArray(value?.reasons) ? value.reasons : []).slice(0, 32).map(reason => String(reason).slice(0, 500))),
  })));
  const floorCount = new Set(selectedFloors.map(value => value.floorId).filter(Boolean)).size;
  const stateItems = Object.freeze((safeShape ? rawStates : []).map(value => {
    const subject = frozenText(value?.subject, 500), toward = frozenText(value?.toward, 500), text = frozenText(value?.text);
    const stateId = frozenText(value?.stateId, 500), sourceFloorId = frozenText(value?.sourceFloorId, 500), sourceDeltaId = frozenText(value?.sourceDeltaId, 500);
    const subjectEntityId = frozenText(value?.subjectEntityId, 500), layer = frozenText(value?.layer, 80);
    const storylineId = frozenText(value?.storylineId, 80);
    return subject && text ? Object.freeze({ subject, toward, text,
      ...(stateId ? { stateId } : {}), ...(sourceFloorId ? { sourceFloorId } : {}), ...(sourceDeltaId ? { sourceDeltaId } : {}),
      ...(subjectEntityId ? { subjectEntityId } : {}), ...(layer ? { layer } : {}), ...(storylineId ? { storylineId } : {}),
    }) : null;
  }).filter(Boolean));
  const stateCount = stateItems.length;
  const cseChangeItems = Object.freeze((safeShape ? rawChanges : []).map(value => Object.freeze({
    subjectEntityId: frozenText(value.subjectEntityId, 500), subject: frozenText(value.subject, 500), layer: frozenText(value.layer, 80), action: frozenText(value.action, 80),
    floorId: frozenText(value.floorId, 500), assistantSeq: value.assistantSeq,
    storylineId: frozenText(value.storylineId, 80),
    before: value.before && typeof value.before === 'object' && !Array.isArray(value.before) ? Object.freeze({
      text: frozenText(value.before.text), visibility: frozenText(value.before.visibility, 80),
      ...(frozenText(value.before.stateId, 500) ? { stateId: frozenText(value.before.stateId, 500) } : {}),
      ...(frozenText(value.before.sourceFloorId, 500) ? { sourceFloorId: frozenText(value.before.sourceFloorId, 500) } : {}),
      ...(frozenText(value.before.sourceDeltaId, 500) ? { sourceDeltaId: frozenText(value.before.sourceDeltaId, 500) } : {}),
    }) : null,
    after: value.after && typeof value.after === 'object' && !Array.isArray(value.after) ? Object.freeze({
      text: frozenText(value.after.text), visibility: frozenText(value.after.visibility, 80),
      ...(frozenText(value.after.stateId, 500) ? { stateId: frozenText(value.after.stateId, 500) } : {}),
      ...(frozenText(value.after.sourceFloorId, 500) ? { sourceFloorId: frozenText(value.after.sourceFloorId, 500) } : {}),
      ...(frozenText(value.after.sourceDeltaId, 500) ? { sourceDeltaId: frozenText(value.after.sourceDeltaId, 500) } : {}),
    }) : null,
  })).filter(value => value.subject && (value.before?.text || value.after?.text)));
  const cseChangeCount = cseChangeItems.length;
  const stateProgressionItems = Object.freeze((safeShape && progressionProtocol ? rawProgressions : []).map(value => Object.freeze({
    subjectEntityId: frozenText(value.subjectEntityId, 500), subject: frozenText(value.subject, 500),
    towardEntityId: frozenText(value.towardEntityId, 500) || null, toward: frozenText(value.toward, 500) || null,
    savedText: frozenText(value.savedText), visibility: frozenText(value.visibility, 80),
    sourceStateId: frozenText(value.sourceStateId, 500), sourceFloorId: frozenText(value.sourceFloorId, 500),
    sourceAssistantSeq: Number.isSafeInteger(value.sourceAssistantSeq) ? value.sourceAssistantSeq : null,
    timeBasis: frozenText(value.timeBasis, 300), suggestion: frozenText(value.suggestion, 600),
    evidence: Object.freeze(value.evidence.map(item => Object.freeze({
      kind: frozenText(item?.kind, 20), floorId: frozenText(item?.floorId, 500),
      assistantSeq: Number.isSafeInteger(item?.assistantSeq) ? item.assistantSeq : null,
    }))),
  })).filter(value => value.subject && value.savedText && value.suggestion && value.timeBasis));
  const stateProgressionCount = stateProgressionItems.length;
  const hasExactStageCounts = [receipt.stages?.recentSummaryCount, receipt.stages?.distantHistoryItemCount, receipt.stages?.stateCount].every(Number.isSafeInteger);
  const recentSummaryCount = hasExactStageCounts ? receipt.stages.recentSummaryCount : null;
  const distantHistoryItemCount = hasExactStageCounts ? receipt.stages.distantHistoryItemCount : null;
  const exactStateCount = hasExactStageCounts ? receipt.stages.stateCount : null;
  const injectionText = typeof receipt.injectionText === 'string' ? receipt.injectionText : '';
  const storylines = Object.freeze((safeShape && storylineProtocol ? rawStorylines : []).map(value => Object.freeze({
    storylineId: frozenText(value.storylineId, 80), title: frozenText(value.title, 160), basis: frozenText(value.basis, 500),
  })));
  const parsedHistory = safeShape ? (storylineProtocol ? parseStorylineHistory(injectionText, selectedFloors, cseChangeItems, storylines) : parseRecallHistory(injectionText, selectedFloors)) : null;
  const historyItems = parsedHistory ?? Object.freeze([]);
  const historyGroups = groupRecallHistory(historyItems, selectedFloors);
  const storylineGroups = Object.freeze(storylines.map(storyline => {
    const items = historyItems.filter(value => value.storylineId === storyline.storylineId);
    const floors = groupRecallHistory(items, selectedFloors).slice().reverse();
    return Object.freeze({ ...storyline, floors, stateItems: Object.freeze(stateItems.filter(value => value.storylineId === storyline.storylineId)), cseChangeItems: Object.freeze(cseChangeItems.filter(value => value.storylineId === storyline.storylineId)) });
  }));
  const protocolRecognized = parsedHistory !== null;
  const status = receipt.status ?? (receipt.injectionText ? 'ready' : 'empty');
  const statusText = receipt.legacyReadOnly ? '旧版只读记录'
    : status === 'ready' || status === 'empty' ? `寻回 ${floorCount} 个结`
        : status === 'stale' ? '本轮结果已失效'
          : status === 'error' ? '本轮召回失败' : '本轮已跳过';
  const summary = hasExactStageCounts
    ? `近期摘要 ${recentSummaryCount} 条 · 远期旧事 ${distantHistoryItemCount} 条 · 当前人物状态 ${exactStateCount} 条${Number.isSafeInteger(receipt.stages?.cseChangeCount) ? ` · 历史变化 ${receipt.stages.cseChangeCount} 条` : ''}`
    : historyItems.length
    ? `已召回 ${historyItems.length} 条旧事${stateCount ? ` · ${stateCount} 条当前人物状态` : ''}${cseChangeCount ? ` · ${cseChangeCount} 条历史变化` : ''}`
    : stateCount || cseChangeCount ? `已记录${stateCount ? ` ${stateCount} 条当前人物状态` : ''}${stateCount && cseChangeCount ? ' ·' : ''}${cseChangeCount ? ` ${cseChangeCount} 条历史变化` : ''}`
      : floorCount || !safeShape || (receipt.legacyReadOnly && !protocolRecognized) ? '召回内容请在详细回执中查看。'
    : status === 'empty' ? '本轮没有需要注入的记忆。' : '本轮没有已注入的记忆。';
  return Object.freeze({
    kind: 'user', status, statusText, summary,
    injectionText, floorCount, stateCount, cseChangeCount, stateProgressionCount, recentSummaryCount, distantHistoryItemCount, selectedFloors, historyItems, historyGroups, storylines, storylineGroups, stateItems, cseChangeItems, stateProgressionItems, protocolRecognized,
  });
}
