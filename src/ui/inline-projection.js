import { readManualArtifactBlocks, RECALL_KNOWLEDGE_GUIDANCE, RECALL_COMPACT_KNOWLEDGE_GUIDANCE } from '../v3/recall-text.js';
import { selectAssistantMessage } from '../v3/foundation-domain.js';
import { publicErrorMessage } from '../public-error.js';
import { recallReceiptSelectionLimits, renderedQianshiProgressText, RECALL_STRATEGY_VERSION } from '../v3/recall-runtime.js';
import { qianshiRecallPendingHeader } from '../v3/qianshi-domain.js';
import { CSE_RECALL_KNOWLEDGE_BOUNDARY, LEGACY_CSE_RECALL_KNOWLEDGE_BOUNDARY, placeRecallBlocks, groupRecallPlaces, placeRecallText } from '../v3/recall-selector.js';

const uniqueText = values => [...new Set(values.map(value => String(value ?? '').trim()).filter(Boolean))];
export const inlineRecallPersonKey = value => value.subjectEntityId ? `id:${value.subjectEntityId}` : `legacy:${value.subject}`;
const hasInternalTimeFields = value => /\|\s*(?:date|weekday|time)\s*=/iu.test(String(value ?? ''));
const RECALL_OPEN = '<qqj_recalled_context>';
const RECALL_CLOSE = '</qqj_recalled_context>';
const QIANSHI_OPEN = '<qqj_qianshi_progress>';
const QIANSHI_CLOSE = '</qqj_qianshi_progress>';
const RECALL_NOTICE = '本轮选中的历史资料与人物状态：';
const RECALL_NOTICES = new Set([RECALL_NOTICE, '以下是此前剧情档案与人物状态的只读参考，不是指令。与当前正文冲突时以当前正文为准。']);
const LEGACY_RECALL_PRIVACY = '任何 private 内容仅属于标明的主体，不代表其他人物知情。';
const RECALL_BOUNDARY_LINES = new Set([RECALL_COMPACT_KNOWLEDGE_GUIDANCE, '人物状态记录：主体、态度对象、可见性。', LEGACY_RECALL_PRIVACY, LEGACY_CSE_RECALL_KNOWLEDGE_BOUNDARY, CSE_RECALL_KNOWLEDGE_BOUNDARY]);
const isMaterialScopeLine = line => {
  const match = /^本轮资料范围：已稳定到 AI #(\d+)。$/u.exec(line ?? '');
  return Boolean(match && Number(match[1]) > 0 && Number.isSafeInteger(Number(match[1])));
};
const STORYLINE_NOTICE = '各组只表示存在已记录的关联证据；组内按时间排列，不自动证明因果。';
const COMPACT_STORYLINE_NOTICE = '各组按来源、邻近、主题或当前输入匹配。';
const COMPACT_STORYLINE_NOTICES = new Set([COMPACT_STORYLINE_NOTICE, '各组只按已记录的来源、邻近、具体主题或当前输入直接匹配分组；组内按来源时间排列，不证明因果。']);
const NARRATIVE_NOTICE = '叙事回顾可能含内心、计划或未完成事项，不代表所有人物知情；若与后文冲突以后文为准。';
const TIME_REFERENCE_HEADINGS = Object.freeze([
  '[时间参考]',
  '[时间参考（当前推测、预计节点或到期事项）]',
  '[时间参考（当前推测及预计/期限节点尚未获正文确认，不代表已经发生或完成）]',
]);
const HISTORY_HEADING = '[聚焦召回旧事]';
const RECENT_HEADING = '[近期剧情接续摘要]';
const DISTANT_HEADING = '[远期相关旧事]';
const STATE_HEADING = '[当前人物状态]';
const SAVED_STATE_HEADING = '[已保存人物状态依据]';
const LEGACY_STATE_HEADING = '[当前人物 Core / 状态]';
const CHANGE_HEADINGS = new Set(['[人物状态历史变化]', '[人物状态历史变化（记录当时前后，后文可能继续覆盖）]']);
const PROGRESSION_HEADINGS = new Set([
  '[时间推演（基于本轮材料的续写表现建议，不是新剧情事实）]',
  '[时间推演（仅供作者续写表现参考，不是新剧情事实，也不表示任何角色已知）]',
]);

const frozenText = (value, limit = 12000) => typeof value === 'string' ? value.trim().slice(0, limit) : '';

function recallProtocolText(injectionText, qianshiProgress, timeDependencies = null) {
  const source = typeof injectionText === 'string' ? injectionText : '';
  if (typeof qianshiProgress?.text !== 'string' || !qianshiProgress.text) return Object.freeze({ text: source, matched: false, only: false });
  const rendered = renderedQianshiProgressText(qianshiProgress, timeDependencies);
  if (!rendered) return Object.freeze({ text: source, matched: false, only: false });
  const block = `${QIANSHI_OPEN}\n${rendered}\n${QIANSHI_CLOSE}`;
  if (source === block) return Object.freeze({ text: '', matched: true, only: true });
  const suffix = `\n\n${block}`;
  return Object.freeze({ text: source.endsWith(suffix) ? source.slice(0, -suffix.length) : source, matched: source.endsWith(suffix), only: false });
}

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

const manualArtifactText = (text, blocks) => blocks?.get(text) ?? text;

const HISTORY_RELATION_PREFIX = /^(?:邻近背景：|同人物与主题：|邻近背景；仅因时序相邻，不表示因果：|同人物与具体主题词关联，不表示因果：|来源关联：)/u;
const DIRECT_COMMITMENT_PREFIXES = ['历史承诺·当时已拒绝：', '历史承诺·当时成立未定：', '当时共同接受的计划：', '当时计划：', '历史承诺·当时已接受：', '历史承诺·当时已作出：'];
const COMMITMENT_PREFIXES = [
  '来源楼当时已拒绝（不构成承诺；以后文为准）：',
  '来源楼当时是否成立不确定（不得当作有效承诺；以后文为准）：',
  '来源楼当时共同接受的计划（不代表如今尚未完成；以后文为准）：',
  '来源楼当时的计划（不代表已告知、已完成或如今仍有效；以后文为准）：',
  '来源楼当时已接受并成立（不代表如今尚未履行；以后文为准）：',
  '来源楼当时已作出（不代表如今尚未履行；以后文为准）：',
];

function historyMaterial(item, { group = '', fullText = item.text, sourcePrefix = '', boundary = '' } = {}) {
  if (item.materialKind) return item;
  if (item.manualArtifact) return Object.freeze({ ...item, materialKind: 'manualArtifact' });
  const narrative = group === 'narrative' || item.text.startsWith('[叙事回顾] ');
  const text = item.text.replace(/^\[叙事回顾\] /u, '').replace(HISTORY_RELATION_PREFIX, '');
  if (narrative) {
    const fragment = text.startsWith('[历史原文；时间未标注] ');
    const displayText = !fragment && group !== 'narrative' && item.text.startsWith('[叙事回顾] ') ? item.text.slice('[叙事回顾] '.length) : item.text;
    return Object.freeze({ ...item, materialKind: fragment ? 'sourceFragment' : 'narrative', displayText });
  }
  const privateHeader = /^(?:\[private；仅 ([^\]\n]+) 可用\]|\[私有资料；知情：([^\]\n]+)\]) /u.exec(text);
  const privateSection = group === 'private' ? /^\[(?:([^\]]+) 的私有认知（仅可用于 [^\]]+）|私有资料；知情：([^\]]+))\]$/u.exec(boundary) : null;
  const owner = privateHeader?.[1] ?? privateHeader?.[2] ?? privateSection?.[1] ?? privateSection?.[2];
  const privateText = privateHeader ? text.slice(privateHeader[0].length) : text;
  const directed = /^[^：\n]+ → [^：\n]+：/u.exec(privateText);
  const shared = ['shared', 'objective'].includes(group) ? /^表达者：[^。\n]+。接收者：[^。\n]+。内容：/u.exec(privateText) : null;
  const body = (shared ? privateText.slice(shared[0].length) : directed ? privateText.slice(directed[0].length) : privateText).replace(HISTORY_RELATION_PREFIX, '');
  const prefixIndex = [...COMMITMENT_PREFIXES, ...DIRECT_COMMITMENT_PREFIXES].findIndex(prefix => body.startsWith(prefix) && body.length > prefix.length);
  if (prefixIndex >= 0) {
    const prefix = [...COMMITMENT_PREFIXES, ...DIRECT_COMMITMENT_PREFIXES][prefixIndex];
    const compact = fullText.endsWith(body) ? fullText.slice(0, fullText.length - body.length) + DIRECT_COMMITMENT_PREFIXES[prefixIndex % 6] + body.slice(prefix.length) : fullText;
    const displayText = [sourcePrefix, compact.replace(/^(.*?)\[private；仅 ([^\]\n]+) 可用\] /u, '$1[私有资料；知情：$2] ')].filter(Boolean).join('：');
    return Object.freeze({ ...item, materialKind: 'personHistory', text: [sourcePrefix, fullText].filter(Boolean).join('：'),
      materialCaption: owner ? `知情：${owner}` : group === 'shared' ? boundary : '', displayText });
  }
  const oldOpenLoop = '来源楼当时未结（后文可能已推进，以后文为准）：';
  if (text.startsWith(oldOpenLoop)) return Object.freeze({ ...item, displayText: '当时未结事项：' + text.slice(oldOpenLoop.length) });
  if (owner) return Object.freeze({ ...item, displayText: [sourcePrefix, privateHeader ? privateText : fullText].filter(Boolean).join('：'), materialCaption: `知情：${owner}` });
  const transfer = /^([^\n]+) → ([^\n]+)（仅列明接收者知情，渠道：([^）]+)）：([\s\S]+)$/u.exec(fullText.replace(HISTORY_RELATION_PREFIX, ''));
  if (transfer) return Object.freeze({ ...item, displayText: [sourcePrefix, `表达者：${transfer[1]}；接收者：${transfer[2]}；渠道：${transfer[3]}；内容：${transfer[4]}`].filter(Boolean).join('：') });
  return item;
}

function parseHistoryBullet(line, allowedSequences, group, section, manualBlocks = null, boundary = '') {
  const match = /^- AI #(\d+)/u.exec(line);
  if (!match) return null;
  const assistantSeq = Number(match[1]);
  if (!Number.isSafeInteger(assistantSeq) || assistantSeq < 1) return null;
  let cursor = skipBalancedFullwidthParens(line, match[0].length);
  if (cursor === null || line[cursor] !== '：') return null;
  const sourcePrefix = line.slice(match[0].length, cursor);
  cursor += 1;
  const fullText = line.slice(cursor).trim();
  if (group === 'shared') {
    const boundaryStart = line.indexOf('（仅列明接收者知情，渠道：', cursor);
    if (boundaryStart > cursor && line.slice(cursor, boundaryStart).includes(' → ')) {
      const boundaryEnd = skipBalancedFullwidthParens(line, boundaryStart);
      if (boundaryEnd === null || line[boundaryEnd] !== '：') return null;
      cursor = boundaryEnd + 1;
    }
  }
  const text = line.slice(cursor).trim();
  const item = text ? Object.freeze({ assistantSeq, text: manualArtifactText(text, manualBlocks), section, ...(manualBlocks?.has(text) ? { manualArtifact: true } : {}) }) : null;
  return item && (allowedSequences.has(assistantSeq) || auxiliaryRecallHistory(item))
    ? historyMaterial(item, { group, fullText, sourcePrefix, boundary }) : null;
}

function splitTimeReference(injectionText) {
  const lines = injectionText.split('\n');
  if (lines[0] !== RECALL_OPEN || lines.at(-1) !== RECALL_CLOSE) return { historyText: injectionText, items: [], onlyTime: false };
  const index = Math.max(...TIME_REFERENCE_HEADINGS.map(heading => lines.lastIndexOf(heading)));
  let historyLines = lines, items = [];
  if (index >= 1) {
    const entries = lines.slice(index + 1, -1);
    if (!entries.length || entries.some(line => !line.startsWith('- ') || !line.slice(2).trim())) return { historyText: injectionText, items: [], onlyTime: false };
    items = entries.map(line => line.slice(2));
    historyLines = [...lines.slice(0, index), RECALL_CLOSE];
  }
  const corrections = historyLines.filter(line => line.startsWith('- [时间校正] ')).map(line => line.slice(2));
  return { historyText: historyLines.join('\n'), items: [...corrections, ...items],
    onlyTime: items.length > 0 && historyLines.slice(1, -1).every(line => !line || [...RECALL_NOTICES, ...RECALL_BOUNDARY_LINES, STORYLINE_NOTICE, ...COMPACT_STORYLINE_NOTICES].includes(line)) };
}

const LOCATION_REFERENCE_HEADINGS = ['[原消息地点标注]', '[原消息地点标注（仅作来源补充参照；当前正文与人工修订优先，不代表当前位置或人物在场）]'];
function splitLocationReferences(injectionText, selectedLocationReferences, schemaVersion) {
  if (typeof injectionText !== 'string' || !injectionText) return { historyText: injectionText, items: [] };
  const lines = injectionText.split('\n');
  const index = lines.findIndex(line => LOCATION_REFERENCE_HEADINGS.includes(line));
  if (index < 0) return { historyText: injectionText, items: [] };
  const boundaries = [RECALL_CLOSE, ...TIME_REFERENCE_HEADINGS];
  const end = lines.findIndex((line, lineIndex) => lineIndex > index && boundaries.includes(line));
  if (end < 0 || Number(schemaVersion) < 18 || !Array.isArray(selectedLocationReferences)) return { historyText: injectionText, items: [] };
  const entries = lines.slice(index + 1, end);
  if (!entries.length || entries.length > 8 || entries.some(line => !line.startsWith('- ') || !line.slice(2).trim())) return { historyText: injectionText, items: [] };
  const expected = selectedLocationReferences.map(value => `- ${value.sourceFloorId
    ? `旧楼 AI #${value.assistantSeq ?? '?'}：`
    : `原消息${Number.isSafeInteger(value.hostLocator?.messageIndex) ? `第 ${value.hostLocator.messageIndex + 1} 楼` : ''}：`}${frozenText(value.text, 500)}`);
  if (expected.length !== entries.length || expected.some((line, itemIndex) => line !== entries[itemIndex])) return { historyText: injectionText, items: [] };
  return { historyText: [...lines.slice(0, index), ...lines.slice(end)].join('\n'), items: entries.map(line => line.slice(2)), references: selectedLocationReferences.map(value => ({ sourceFloorId: value.sourceFloorId ?? '', assistantSeq: value.assistantSeq ?? null, hostLocator: value.hostLocator ? { ...value.hostLocator } : null, text: frozenText(value.text, 500) })) };
}

function timeReferenceDisplayItem(value, dependencyTexts = []) {
  const original = frozenText(value);
  const matched = dependencyTexts.find(text => original === text)
    ?? dependencyTexts.filter(text => original.includes(text)).sort((left, right) => right.length - left.length)[0];
  let text = matched ?? original;
  if (!matched && original.startsWith('[时间校正] ') && original.endsWith('）')) {
    const evidence = original.lastIndexOf('（依据：');
    const fixedStart = Math.max(original.indexOf('原观察'), original.indexOf('：观察于'), original.indexOf('：观察/发生于'));
    if (evidence > fixedStart) text = original.slice(0, evidence);
  }
  const compactObservation = Math.max(text.indexOf('：观察于'), text.indexOf('：观察/发生于'));
  if (compactObservation > 0) {
    const sourcePrefix = text.slice(0, compactObservation).split(' / ').at(-1)?.trim() ?? '';
    const currentHeader = /^可见性：(私密|可观察|已表达|已共享|作者设定)：/u;
    const source = !matched && original.startsWith('[时间校正] ')
      ? currentHeader.test(sourcePrefix) ? sourcePrefix.replace(currentHeader, '').trim() : sourcePrefix.slice(sourcePrefix.indexOf('：') + 1).trim()
      : sourcePrefix;
    const sourceStart = compactObservation + 1;
    const projections = ['；当前推测', '；当前状态待新观察确认', '；预计周期日 ', '；约定期限 ']
      .map(marker => ({ marker, index: text.indexOf(marker, sourceStart) })).filter(value => value.index >= 0).sort((a, b) => a.index - b.index);
    const projected = projections[0];
    if (!source || !projected) return Object.freeze({ text: original });
    let projection = '';
    if (projected.marker === '；当前状态待新观察确认') projection = '待新观察确认';
    else if (projected.marker === '；当前推测') {
      let start = projected.index + projected.marker.length;
      if (text[start] === '（') {
        const afterTime = skipBalancedFullwidthParens(text, start);
        if (afterTime === null || text[afterTime] !== '：') return Object.freeze({ text: original });
        start = afterTime + 1;
      } else if (text[start] === '：') start += 1;
      projection = text.slice(start).trim();
    } else projection = text.slice(projected.index + 1).trim();
    return projection ? Object.freeze({ source, projection }) : Object.freeze({ text: original });
  }
  const observation = text.indexOf('原观察');
  if (observation >= 0) {
    let sourceStart = observation + '原观察'.length;
    if (text[sourceStart] === '（') {
      const afterTime = skipBalancedFullwidthParens(text, sourceStart);
      if (afterTime === null || text[afterTime] !== '：') return Object.freeze({ text: original });
      sourceStart = afterTime + 1;
    } else if (matched && text[sourceStart] === '：') sourceStart += 1;
    else return Object.freeze({ text: original });
    const projections = ['；当前推测', '；当前状态待新观察确认', '；预计周期日 ', '；约定期限 ']
      .map(marker => ({ marker, index: text.indexOf(marker, sourceStart) })).filter(value => value.index >= 0).sort((a, b) => a.index - b.index);
    const projected = projections[0];
    if (!projected) return Object.freeze({ text: original });
    const elapsed = ['；已过', '；发生后经过时间未知', '；观察后已过']
      .map(marker => text.indexOf(marker, sourceStart)).filter(index => index >= 0 && index < projected.index).sort((a, b) => a - b)[0];
    const source = text.slice(sourceStart, elapsed ?? projected.index).trim() || '原观察';
    let projection = '';
    if (projected.marker === '；当前状态待新观察确认') projection = '待新观察确认';
    else if (projected.marker === '；当前推测') {
      let start = projected.index + projected.marker.length;
      if (text[start] === '（') {
        const afterTime = skipBalancedFullwidthParens(text, start);
        if (afterTime === null || text[afterTime] !== '：') return Object.freeze({ text: original });
        start = afterTime + 1;
      } else if (text[start] === '：') start += 1;
      projection = text.slice(start).trim();
    } else projection = text.slice(projected.index + 1).trim();
    return source && projection ? Object.freeze({ source, projection }) : Object.freeze({ text: original });
  }
  const annual = /：原日期 ([^；]+)；下次日期 (.+)$/u.exec(text);
  return annual ? Object.freeze({ source: `原日期 ${annual[1].trim()}`, projection: `下次日期 ${annual[2].trim()}` }) : Object.freeze({ text: original });
}

function qianshiObjectItems(text) {
  const sections = text ? text.split(/\n\n/u) : [];
  const scope = sections.find(value => /^本轮千事资料来源截至：AI #\d+。$/u.test(value)) ?? '';
  return sections.flatMap((section, sectionIndex) => {
    if (section === scope || section === RECALL_KNOWLEDGE_GUIDANCE) return [];
    const lines = section.split('\n');
    const hasHeading = /^\[[^\n]+\]$/u.test(lines[0]);
    const heading = hasHeading ? lines.shift() : '';
    const rows = [];
    for (const line of lines) {
      if (line.startsWith('- ')) rows.push(line.slice(2));
      else if (rows.length) rows[rows.length - 1] += `\n${line}`;
      else if (line) rows.push(line);
    }
    return rows.filter(Boolean).map((value, index) => {
      const title = value.split(/[；\n]/u)[0];
      const displayText = value.replace(/；尚未记录完成。$/u, '；完成状态：未记录。').replace(/；已记录完成，当前仍继续关注后续变化。$/u, '；状态：已完成；跟进：持续。');
      const knownHeading = qianshiRecallPendingHeader(heading, null) || heading === '[相关时间线]';
      return Object.freeze({ id: `qianshi:${sectionIndex}:${index}`, group: 'qianshi', title, text: value, displayText,
        ...(knownHeading && displayText.startsWith(`${title}；`) ? { bodyText: displayText.slice(title.length + 1) } : {}),
        caption: qianshiRecallPendingHeader(heading, null) ? '跟进事项' : heading === '[相关时间线]' ? '事件进度' : heading.replace(/^\[|\]$/gu, '') || '千事进度',
      });
    });
  });
}

function parseRecallHistory(injectionText, selectedFloors, manualBlocks = null) {
  if (typeof injectionText !== 'string' || !injectionText) return null;
  const lines = injectionText.split('\n');
  if (lines[0] !== RECALL_OPEN || lines.at(-1) !== RECALL_CLOSE || !RECALL_NOTICES.has(lines[1]) || !RECALL_BOUNDARY_LINES.has(lines[2])) return null;
  const bodyStart = isMaterialScopeLine(lines[3]) ? 4 : 3;
  const sequenceFloors = new Map();
  for (const value of selectedFloors) {
    if (!Number.isSafeInteger(value.assistantSeq)) continue;
    const existing = sequenceFloors.get(value.assistantSeq);
    if (existing !== undefined && existing !== value.floorId) return null;
    sequenceFloors.set(value.assistantSeq, value.floorId);
  }
  const allowedSequences = new Set(selectedFloors.map(value => value.assistantSeq).filter(Number.isSafeInteger));
  const items = [];
  let group = '', boundary = '', section = '', sawState = false, sawChange = false, sawHistory = false;
  for (let index = bodyStart; index < lines.length - 1; index += 1) {
    const line = lines[index];
    if (!line) continue;
    if (line === NARRATIVE_NOTICE && index === bodyStart) continue;
    if (line.startsWith('[覆盖说明] ')) {
      if (lines.slice(index + 1, -1).some(Boolean)) return null;
      break;
    }
    if (line === STATE_HEADING || line === SAVED_STATE_HEADING || line === LEGACY_STATE_HEADING) { group = 'states'; section = ''; sawState = true; continue; }
    if (CHANGE_HEADINGS.has(line)) { group = 'changes'; section = ''; sawChange = true; continue; }
    if (PROGRESSION_HEADINGS.has(line)) { group = 'progressions'; section = ''; continue; }
    if (line === HISTORY_HEADING || line === DISTANT_HEADING) { group = ''; section = 'distant'; sawHistory = true; continue; }
    if (line === RECENT_HEADING) { group = ''; section = 'recent'; sawHistory = true; continue; }
    if (line === '[客观相关旧事]') { group = 'objective'; continue; }
    if (line === '[叙事回顾]' || line.startsWith('[叙事回顾（')) { group = 'narrative'; continue; }
    if (line === '[已表达/已共享信息]' || line === '[已表达信息及接收范围]') { group = 'shared'; boundary = line; continue; }
    if (/^\[[^\[\]\n]+ 的私有认知（仅可用于 [^\[\]\n]+）\]$/u.test(line) || /^\[私有资料；知情：[^\]\n]+\]$/u.test(line)) { group = 'private'; boundary = line; continue; }
    if (['states', 'changes', 'progressions'].includes(group) && line.startsWith('- ')) continue;
    if (!group) return null;
    const item = parseHistoryBullet(line, allowedSequences, group, section, manualBlocks, boundary);
    if (!item) return null;
    items.push(item);
  }
  if (selectedFloors.length && !sawHistory) return null;
  if (!selectedFloors.length && !sawState && !sawChange) return null;
  return Object.freeze(items);
}

function parseStorylineHistory(injectionText, selectedFloors, selectedChanges, storylines, manualBlocks = null) {
  if (typeof injectionText !== 'string' || !injectionText || !Array.isArray(storylines)) return null;
  const lines = injectionText.split('\n');
  const noticeIndex = isMaterialScopeLine(lines[3]) ? 4 : 3;
  const compact = COMPACT_STORYLINE_NOTICES.has(lines[noticeIndex]);
  const bodyStart = noticeIndex + 1;
  if (lines[0] !== RECALL_OPEN || lines.at(-1) !== RECALL_CLOSE || !RECALL_NOTICES.has(lines[1]) || !RECALL_BOUNDARY_LINES.has(lines[2]) || !compact && lines[noticeIndex] !== STORYLINE_NOTICE) return null;
  const historySequences = new Set(selectedFloors.map(value => value.assistantSeq).filter(Number.isSafeInteger));
  const changeSequences = new Set(selectedChanges.map(value => value.assistantSeq).filter(Number.isSafeInteger));
  const allowedSequences = new Set([...historySequences, ...changeSequences]);
  const lineById = new Map(storylines.map(value => [value.storylineId, value]));
  const seenLines = new Set(), items = [];
  let currentLine = null, currentSequence = null, inStates = false, inProgressions = false;
  for (let index = bodyStart; index < lines.length - 1; index += 1) {
    const line = lines[index];
    if (!line) continue;
    if (line === NARRATIVE_NOTICE && index === bodyStart) continue;
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
      if (compact) {
        if (basis?.startsWith('[关联依据] ')) return null;
      } else {
        if (basis !== `[关联依据] ${expected.basis}`) return null;
        index += 1;
      }
      continue;
    }
    if (!currentLine) return null;
    const sourceMatch = /^\[来源 AI #(\d+)(?:（.*）)?\]$/u.exec(line);
    if (sourceMatch) {
      currentSequence = Number(sourceMatch[1]); inStates = false; inProgressions = false;
      if (!Number.isSafeInteger(currentSequence) || currentSequence < 1) return null;
      if (!allowedSequences.has(currentSequence)) {
        // Member-source space records can have a different carrier floor sequence.
        const next = lines[index + 1];
        const item = next?.startsWith('- [旧事] ') ? { text: next.slice('- [旧事] '.length).trim() }
          : parseHistoryBullet(next ?? '', allowedSequences, 'objective', '', manualBlocks);
        if (!item || !auxiliaryRecallHistory(item)) return null;
      }
      continue;
    }
    if (line === STATE_HEADING || line === SAVED_STATE_HEADING) { currentSequence = null; inStates = true; continue; }
    if (inStates && line.startsWith('- ')) continue;
    if (!Number.isSafeInteger(currentSequence)) return null;
    const currentChanges = selectedChanges.filter(value => value.assistantSeq === currentSequence && value.storylineId === currentLine.storylineId);
    if (currentChanges.some(value => line.startsWith(`- [变化] ${value.subject} / ${value.layer}：当时`) || line.startsWith(`- [变化] 主体：${value.subject} / ${value.layer}：当时`))) continue;
    const changeMatch = /^- \[变化；来源 AI #(\d+)\] /u.exec(line);
    if (changeMatch) {
      const assistantSeq = Number(changeMatch[1]);
      if (assistantSeq !== currentSequence || !selectedChanges.some(value => value.assistantSeq === assistantSeq && value.storylineId === currentLine.storylineId)) return null;
      continue;
    }
    const section = currentLine.storylineId === 'recent' ? 'recent' : 'distant';
    const text = line.startsWith('- [旧事] ') ? line.slice('- [旧事] '.length).trim() : '';
    const item = text ? Object.freeze({ assistantSeq: currentSequence, text: manualArtifactText(text, manualBlocks), section, ...(manualBlocks?.has(text) ? { manualArtifact: true } : {}) })
      : parseHistoryBullet(line, allowedSequences, 'objective', section, manualBlocks);
    if (!item || item.assistantSeq !== currentSequence || !historySequences.has(currentSequence) && !auxiliaryRecallHistory(item)) return null;
    items.push(Object.freeze({ ...historyMaterial(item, { group: 'objective' }), storylineId: currentLine.storylineId }));
  }
  if (storylines.length && seenLines.size !== storylines.length) return null;
  return Object.freeze(items);
}

// Frozen receipts retain the injection text, not item kinds. Only hide complete
// program-owned wrappers after protocol parsing; manual source blocks stay literal.
function auxiliaryRecallHistory(item) {
  if (item.manualArtifact) return false;
  const text = item.text.replace(HISTORY_RELATION_PREFIX, '');
  if (/^当前已知地点条件：.+（来源 AI #[1-9]\d*；设施存在不代表所有人物知情）$/u.test(text)) return true;
  if (/^有来源的历史设施（当前场地未核对）：.+（来源 AI #[1-9]\d*；设施存在不代表所有人物知情）$/u.test(text)) return true;
  if (/^.+：当时现场：.+；不代表之后仍持续（来源楼当时 AI #[1-9]\d*）$/u.test(text)) return true;
  if (/^.+：历史地点描述（持续性未标）：.+；未确认为当前固定设施（来源楼当时 AI #[1-9]\d*）$/u.test(text)) return true;
  if (/^.+：(?:场所归属|所在楼层|相对位置)：.+（来源楼当时 AI #[1-9]\d*）$/u.test(text)) return true;
  if (/^(?:当前地点设施|历史地点设施（场地未核对）)：.+（来源 AI #[1-9]\d*）$/u.test(text)) return true;
  if (/^.+：(?:当时现场|历史地点描述（持续性未标）)：.+（来源楼当时 AI #[1-9]\d*）$/u.test(text)) return true;
  if (/^来源楼当时(?:[（(]AI #[1-9]\d*[）)])?(?:位置[：:].+位于.+|最后见到[：:].+在.+|离开记录[：:].+已离开.+[；;]去向[：:]未知)(?:[；;]原句「[\s\S]*」)?$/u.test(text)) return true;
  const source = text.replace(/^来源楼当时(?:（AI #[1-9]\d*）)?/u, '');
  if (source === text) return false;
  const body = source.replace(/；原句「[\s\S]*」$/u, '');
  return /^地点包含：.+ 属于 .+$/u.test(body)
    || /^确认.+当时位于.+；这是该来源楼位置，不代表之后仍在此处$/u.test(body)
    || /^最后见到.+在.+；未确认楼末仍在此处$/u.test(body)
    || /^记录.+已离开(?:原地点.+|原处)，去向未知；(?:.+不是当前位置|不能推定当前位置)$/u.test(body);
}

function compactPlaceRecord(text) {
  return text
    .replace(/^当前已知地点条件：([\s\S]+)（来源 AI #(\d+)；设施存在不代表所有人物知情）$/u, '当前地点设施：$1（来源 AI #$2）')
    .replace(/^有来源的历史设施（当前场地未核对）：([\s\S]+)（来源 AI #(\d+)；设施存在不代表所有人物知情）$/u, '历史地点设施（场地未核对）：$1（来源 AI #$2）')
    .replace(/^([\s\S]+：当时现场：[\s\S]+)；不代表之后仍持续（来源楼当时 AI #(\d+)）$/u, '$1（来源楼当时 AI #$2）')
    .replace(/^([\s\S]+：历史地点描述（持续性未标）：[\s\S]+)；未确认为当前固定设施（来源楼当时 AI #(\d+)）$/u, '$1（来源楼当时 AI #$2）')
    .replace(/^(来源楼当时(?:（AI #\d+）)?)确认([\s\S]+)当时位于([\s\S]+)；这是该来源楼位置，不代表之后仍在此处(?=；原句「|$)/u, '$1位置：$2位于$3')
    .replace(/^(来源楼当时(?:（AI #\d+）)?)最后见到([\s\S]+)在([\s\S]+)；未确认楼末仍在此处(?=；原句「|$)/u, '$1最后见到：$2在$3')
    .replace(/^(来源楼当时(?:（AI #\d+）)?)记录([\s\S]+)已离开([\s\S]+)，去向未知；(?:.+不是当前位置|不能推定当前位置)(?=；原句「|$)/u, '$1离开记录：$2已离开$3；去向：未知')
    .replace(/（来源(?:楼当时)? AI #[1-9]\d*）$/u, '')
    .replace(/^来源楼当时(?:（AI #[1-9]\d*）)?/u, '当时');
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

const HEADER_TIME_PLACEHOLDERS = new Set(['', '未提取', '时间未明确', '来源归档']);
function inlineMemoryHeaderTime(floor, memory) {
  const manual = floor.manualTime === true;
  const times = uniqueText((memory?.chronology ?? [])
    .filter(item => manual || ['explicit', 'relative'].includes(item?.time?.kind))
    .map(item => String(item?.time?.sourceText ?? '').trim() || item?.time?.normalized))
    .filter(value => !HEADER_TIME_PLACEHOLDERS.has(value)).join('；');
  const rawFallback = manual ? '' : String(floor.timeFallback ?? '').trim();
  const fallback = HEADER_TIME_PLACEHOLDERS.has(rawFallback) || rawFallback === '多个故事时间戳存在冲突' ? '' : rawFallback;
  return times && fallback && hasInternalTimeFields(times) ? fallback : times || fallback;
}

export function projectInlineMemoryFloor(state, messageIndex, fallbackAssistantSeq = null, { migrationAliasId = null, memoryExcluded = false } = {}) {
  const floors = state?.floors ?? [];
  const inheritedFloor = floors.find(value => value?.frozen !== true && value?.inherited === true && value?.messageIndex === messageIndex) ?? null;
  const aliasHint = !state?.reviewReason && migrationAliasId && (state?.migrationAliases ?? []).some(alias =>
    alias.aliasId === migrationAliasId && alias.targetMessageIndex === messageIndex
      && floors.some(value => value?.frozen === true && value.floorId === alias.floorId));
  const floor = floors.find(value => value?.frozen !== true && value?.inherited !== true && value?.messageIndex === messageIndex) ?? null;
  const waitingCandidate = (state?.unregisteredCandidates ?? []).find(value => value?.messageIndex === messageIndex) ?? null;
  const assistantSeq = Number.isSafeInteger(floor?.assistantSeq) && floor.assistantSeq > 0
    ? floor.assistantSeq
    : Number.isSafeInteger(fallbackAssistantSeq) && fallbackAssistantSeq > 0 ? fallbackAssistantSeq : null;
  if (!floor && (inheritedFloor || aliasHint)) return Object.freeze({
    kind: 'assistant', floorId: null, assistantSeq, messageIndex, status: 'ready', statusText: '继承正文', readOnly: true,
    time: '来源归档', headerTime: '', locations: '来源归档', people: '来源归档',
    summary: '这是搬家时携带的正文；原楼摘要请在记忆管理中查看。', error: '', busy: Boolean(state?.memoryWorkBusy), canExtract: false,
  });
  if (memoryExcluded === true || floor?.memoryExcluded === true || waitingCandidate?.memoryExcluded === true) return Object.freeze({
    kind: 'assistant', floorId: floor?.floorId ?? null, assistantSeq, messageIndex, status: 'excluded',
    statusText: '该楼无需计入千千结', memoryExcluded: true, readOnly: floor?.frozen === true || floor?.inherited === true,
    time: '', headerTime: '', locations: '', people: '', summary: '', error: '', busy: Boolean(state?.memoryWorkBusy), canExtract: false,
  });
  if (!floor) {
    const snapshotStatus = state?.memorySnapshotStatus;
    const failed = snapshotStatus === 'error';
    const syncing = ['syncing', 'unavailable'].includes(snapshotStatus);
    const pending = waitingCandidate ?? (state?.pending?.messageIndex === messageIndex ? { reason: 'waitingNextUser' } : null);
    const waitingCopy = ({
      waitingNextUser: ['等待下一条用户消息', '这一楼尚未摘要。发送下一条用户消息后会重新检查。'],
      waitingEarlierFloor: ['等待前面楼层处理', '这一楼尚未摘要。前面的 AI 楼尚未确认，当前不会进入摘要处理。'],
      consecutiveAssistant: ['连续 AI，尚待确认', '这一楼尚未摘要。请到「千结」页顶部，点击「确认连续 AI 并分别记录」。'],
      registrationNeedsReview: ['消息对应关系待核对', '这一楼尚未摘要。消息与已有记忆的对应关系需要先核对。'],
    })[pending?.reason] ?? ['尚待确认', '这一楼尚未摘要，正在等待确认。'];
    return Object.freeze({
      kind: 'assistant', floorId: null, assistantSeq, messageIndex, status: failed ? 'error' : syncing ? 'syncing' : pending ? 'pending' : 'unavailable',
      statusText: failed ? '记忆读取失败' : syncing ? '正在读取本楼状态' : pending ? waitingCopy[0] : '尚未读取本楼状态',
      time: '未提取', headerTime: '', locations: '未提取', people: '未提取',
      summary: failed ? '暂时无法读取当前聊天的记忆状态。' : syncing ? '正在读取当前聊天的记忆状态。' : pending ? waitingCopy[1] : '当前记忆中没有这楼的已保存状态。',
      error: failed ? publicErrorMessage(state?.lastExtractorError, { fallback: '记忆读取失败，请稍后重试。' }) : '',
      busy: Boolean(state?.memoryWorkBusy || syncing), canExtract: false,
    });
  }
  const memory = floor.memory ?? null;
  const times = uniqueText((memory?.chronology ?? []).map(item => item?.time?.sourceText || item?.time?.normalized || item?.description)).join('；');
  const fallbackTime = String(floor.timeFallback ?? '').trim();
  const time = times && fallbackTime && hasInternalTimeFields(times) ? fallbackTime : times || fallbackTime || '时间未明确';
  const locations = uniqueText((memory?.locations ?? []).map(item => item?.name)).join('、') || '未提取';
  const names = new Map((state?.memoryEntities ?? []).map(entity => [entity?.entityId, entity?.displayName]));
  const people = uniqueText((memory?.participants ?? []).map(item => names.get(item?.entityId) || '未知人物')).join('、') || '未提取';
  const busy = Boolean(state?.memoryWorkBusy || state?.activeAutoMemory || state?.activeExtraction || state?.activeCse);
  const statusText = floor.status === 'running' ? '正在提取'
    : floor.status === 'ready' ? (floor.summarySource === 'user' ? '人工修订' : '摘要已保存')
      : ['error', 'failed'].includes(floor.status) ? '提取失败'
        : floor.status === 'unprocessed' ? '尚未提取' : '等待下一条用户消息';
  return Object.freeze({
    kind: 'assistant', floorId: floor.floorId, assistantSeq, messageIndex, status: floor.status, statusText, time, headerTime: inlineMemoryHeaderTime(floor, memory), locations, people,
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
    injectionText: '', qianshiProgressText: '', objectItems: Object.freeze([]), objectCount: 0, personHistoryItems: Object.freeze([]), personHistoryCount: 0, floorCount: 0, stateCount: 0, cseChangeCount: 0, selectedFloors: Object.freeze([]), historyItems: Object.freeze([]), historyGroups: Object.freeze([]), storylines: Object.freeze([]), storylineGroups: Object.freeze([]), stateItems: Object.freeze([]), cseChangeItems: Object.freeze([]), timeReferenceItems: Object.freeze([]), timeReferenceDisplayItems: Object.freeze([]), timeReferenceCount: 0, locationReferenceItems: Object.freeze([]), locationReferenceCount: 0, protocolRecognized: false,
  });
  const hasFloorArray = Array.isArray(receipt.selectedFloors), hasStateArray = Array.isArray(receipt.selectedStates);
  const rawFloors = hasFloorArray ? receipt.selectedFloors : [];
  const rawStates = hasStateArray ? receipt.selectedStates : [];
  const rawChanges = Array.isArray(receipt.selectedCseChanges) ? receipt.selectedCseChanges : [];
  const rawStorylines = Array.isArray(receipt.storylines) ? receipt.storylines : [];
  const rawStorylineIds = new Set(rawStorylines.map(value => value?.storylineId).filter(value => typeof value === 'string'));
  const newLimits = Number(receipt.schemaVersion) >= 11;
  const storylineProtocol = Number(receipt.schemaVersion) >= 12;
  // Older receipts remain displayable under their original count limits; current receipts use the expanded contract.
  const selectionLimits = recallReceiptSelectionLimits(receipt.strategyVersion);
  const expandedSelection = selectionLimits.expanded;
  const floorLimit = expandedSelection || newLimits ? selectionLimits.floors : 12;
  const stateLimit = expandedSelection || newLimits ? selectionLimits.states : 18;
  const changeLimit = expandedSelection || newLimits ? selectionLimits.cseChanges : 6;
  const storylineLimit = expandedSelection || storylineProtocol ? selectionLimits.storylines : 4;
  const safeShape = hasFloorArray && hasStateArray && rawFloors.length <= floorLimit && rawStates.length <= stateLimit && rawChanges.length <= changeLimit
    && (!newLimits || rawStates.length + rawChanges.length <= selectionLimits.combinedStatesAndChanges)
    && (!storylineProtocol || (rawStorylines.length <= storylineLimit && rawStorylines.every(value => value && typeof value === 'object' && !Array.isArray(value)
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
  const selectedFloorCount = new Set(selectedFloors.map(value => value.floorId).filter(Boolean)).size;
  const stateItems = Object.freeze((safeShape ? rawStates : []).map(value => {
    const subject = frozenText(value?.subject, 500), toward = frozenText(value?.toward, 500), text = frozenText(value?.text);
    const stateId = frozenText(value?.stateId, 500), sourceFloorId = frozenText(value?.sourceFloorId, 500), sourceDeltaId = frozenText(value?.sourceDeltaId, 500);
    const subjectEntityId = frozenText(value?.subjectEntityId, 500), towardEntityId = frozenText(value?.towardEntityId, 500), layer = frozenText(value?.layer, 80);
    const storylineId = frozenText(value?.storylineId, 80);
    return subject && text ? Object.freeze({ subject, toward, text,
      ...(stateId ? { stateId } : {}), ...(sourceFloorId ? { sourceFloorId } : {}), ...(sourceDeltaId ? { sourceDeltaId } : {}),
      ...(subjectEntityId ? { subjectEntityId } : {}), ...(towardEntityId ? { towardEntityId } : {}), ...(layer ? { layer } : {}), ...(storylineId ? { storylineId } : {}),
      ...(frozenText(value?.visibility,80)?{visibility:frozenText(value.visibility,80)}:{}),
      ...(Number.isSafeInteger(value?.sourceAssistantSeq)?{sourceAssistantSeq:value.sourceAssistantSeq}:{}),
      ...(frozenText(value?.origin,80)?{origin:frozenText(value.origin,80)}:{}),
    }) : null;
  }).filter(Boolean));
  const stateCount = stateItems.length;
  const cseChangeItems = Object.freeze((safeShape ? rawChanges : []).map(value => Object.freeze({
    subjectEntityId: frozenText(value.subjectEntityId, 500), subject: frozenText(value.subject, 500), layer: frozenText(value.layer, 80), action: frozenText(value.action, 80),
    floorId: frozenText(value.floorId, 500), assistantSeq: value.assistantSeq,
    storylineId: frozenText(value.storylineId, 80),
    before: value.before && typeof value.before === 'object' && !Array.isArray(value.before) ? Object.freeze({
      text: frozenText(value.before.text), visibility: frozenText(value.before.visibility, 80), toward: frozenText(value.before.toward, 500),
      ...(frozenText(value.before.towardEntityId, 500) ? { towardEntityId: frozenText(value.before.towardEntityId, 500) } : {}),
      ...(frozenText(value.before.stateId, 500) ? { stateId: frozenText(value.before.stateId, 500) } : {}),
      ...(frozenText(value.before.sourceFloorId, 500) ? { sourceFloorId: frozenText(value.before.sourceFloorId, 500) } : {}),
      ...(frozenText(value.before.sourceDeltaId, 500) ? { sourceDeltaId: frozenText(value.before.sourceDeltaId, 500) } : {}),
    }) : null,
    after: value.after && typeof value.after === 'object' && !Array.isArray(value.after) ? Object.freeze({
      text: frozenText(value.after.text), visibility: frozenText(value.after.visibility, 80), toward: frozenText(value.after.toward, 500),
      ...(frozenText(value.after.towardEntityId, 500) ? { towardEntityId: frozenText(value.after.towardEntityId, 500) } : {}),
      ...(frozenText(value.after.stateId, 500) ? { stateId: frozenText(value.after.stateId, 500) } : {}),
      ...(frozenText(value.after.sourceFloorId, 500) ? { sourceFloorId: frozenText(value.after.sourceFloorId, 500) } : {}),
      ...(frozenText(value.after.sourceDeltaId, 500) ? { sourceDeltaId: frozenText(value.after.sourceDeltaId, 500) } : {}),
    }) : null,
  })).filter(value => value.subject && (value.before?.text || value.after?.text)));
  const cseChangeCount = cseChangeItems.length;
  const hasExactStageCounts = [receipt.stages?.recentSummaryCount, receipt.stages?.distantHistoryItemCount, receipt.stages?.stateCount].every(Number.isSafeInteger);
  const recentSummaryCount = hasExactStageCounts ? receipt.stages.recentSummaryCount : null;
  const distantHistoryItemCount = hasExactStageCounts ? receipt.stages.distantHistoryItemCount : null;
  const exactStateCount = hasExactStageCounts ? receipt.stages.stateCount : null;
  const injectionText = typeof receipt.injectionText === 'string' ? receipt.injectionText : '';
  const signedQianshiProgress = Number(receipt.schemaVersion) >= 15 ? receipt.qianshiProgress : null;
  const manualBlocks = readManualArtifactBlocks(injectionText);
  const matchedPlaces = new Set();
  const placeBlocks = new Map();
  for (const [legacy, grouped, deduplicate] of [[false, true, true], [false, true, false], [false, false, false], [true, false, false]]) for (const block of placeRecallBlocks(receipt.selectedPlaces ?? [], legacy, grouped, deduplicate)) {
    placeBlocks.set(block, grouped ? receipt.selectedPlaces ?? [] : (receipt.selectedPlaces ?? []).filter(item => (item.kind === 'placeFoundation') === block.startsWith('[地点基础资料')));
  }
  for (const [block, values] of placeBlocks) {
    const marker = `${block}\n`, at = manualBlocks.text.lastIndexOf(marker);
    const end = manualBlocks.text.indexOf(RECALL_CLOSE);
    if (manualBlocks.valid && manualBlocks.text.startsWith(`${RECALL_OPEN}\n`) && at >= RECALL_OPEN.length && at + marker.length <= end) {
      for (const value of values) matchedPlaces.add(value);
      manualBlocks.text = manualBlocks.text.slice(0, at) + manualBlocks.text.slice(at + marker.length);
    }
  }
  const matchedPlaceItems = groupRecallPlaces([...matchedPlaces]).map((values, index) => {
    const first = values[0], colon = first.text.indexOf('：');
    const caption = values.every(value => value.kind === 'manualPlace') ? '当前地点事实 · 人工修订优先'
      : values.some(value => value.kind === 'manualPlace') ? '地点资料' : '地点基础资料';
    const title = colon >= 0 ? first.text.slice(0, colon) : '地点资料', text = placeRecallText(values, !receipt.strategyVersion || receipt.strategyVersion === RECALL_STRATEGY_VERSION);
    return Object.freeze({ id: `place:${index}`, group: 'place', placeEntityId: first.placeEntityId, title, text,
      ...(text.startsWith(`${title}：`) ? { bodyText: text.slice(title.length + 1) } : {}), caption });
  });
  const locationReferences = splitLocationReferences(manualBlocks.text, receipt.selectedLocationReferences, receipt.schemaVersion);
  const locationReferenceItems = Object.freeze(locationReferences.items.map(value => frozenText(value, 600)).filter(Boolean));
  const qianshiProtocol = recallProtocolText(locationReferences.historyText, signedQianshiProgress, receipt.timeDependencies);
  const storylines = Object.freeze((safeShape && storylineProtocol ? rawStorylines : []).map(value => Object.freeze({
    storylineId: frozenText(value.storylineId, 80), title: frozenText(value.title, 160), basis: frozenText(value.basis, 500),
  })));
  const timeReference = splitTimeReference(qianshiProtocol.text);
  const noOrdinaryRecall = !selectedFloors.length && !stateItems.length && !cseChangeItems.length && !storylines.length;
  const onlyMatchedPlaces = matchedPlaceItems.length > 0 && noOrdinaryRecall && timeReference.historyText === `${RECALL_OPEN}\n${RECALL_CLOSE}`;
  const containsManualArtifact = selectedFloors.some(floor => floor.reasons.includes('manualArtifact'));
  const parsedHistory = !manualBlocks.valid || containsManualArtifact && !manualBlocks.blocks.size ? null : safeShape ? (onlyMatchedPlaces || qianshiProtocol.only && noOrdinaryRecall
    ? Object.freeze([])
    : (timeReference.onlyTime || locationReferenceItems.length > 0 && noOrdinaryRecall) && noOrdinaryRecall
    ? Object.freeze([])
    : storylineProtocol ? parseStorylineHistory(timeReference.historyText, selectedFloors, cseChangeItems, storylines, manualBlocks.blocks) : parseRecallHistory(timeReference.historyText, selectedFloors, manualBlocks.blocks)) : null;
  const timeReferenceItems = Object.freeze(parsedHistory !== null && ['ready', 'empty'].includes(receipt.status ?? 'ready') ? timeReference.items : []);
  const timeReferenceCount = timeReferenceItems.length;
  const locationReferenceCount = locationReferenceItems.length;
  const dependencyTexts = [...(receipt.timeDependencies?.corrections ?? []), ...(receipt.timeDependencies?.reminders ?? [])]
    .map(value => frozenText(value?.text)).filter(Boolean);
  const timeReferenceDisplayItems = Object.freeze(timeReferenceItems.map(value => timeReferenceDisplayItem(value, dependencyTexts)));
  const personHistoryItems = Object.freeze((parsedHistory ?? []).filter(item => item.materialKind === 'personHistory'));
  const personHistoryCount = personHistoryItems.length;
  const historyItems = Object.freeze((parsedHistory ?? []).filter(item => !auxiliaryRecallHistory(item) && item.materialKind !== 'personHistory'));
  const historyCount = historyItems.length, personCount = new Set([...stateItems,...cseChangeItems].map(inlineRecallPersonKey)).size;
  const historyGroups = groupRecallHistory(historyItems, selectedFloors);
  const storylineGroups = Object.freeze(storylines.map(storyline => {
    const items = historyItems.filter(value => value.storylineId === storyline.storylineId);
    const floors = groupRecallHistory(items, selectedFloors).slice().reverse();
    return Object.freeze({ ...storyline, floors, stateItems: Object.freeze(stateItems.filter(value => value.storylineId === storyline.storylineId)), cseChangeItems: Object.freeze(cseChangeItems.filter(value => value.storylineId === storyline.storylineId)) });
  }));
  const protocolRecognized = parsedHistory !== null;
  const floorCount = protocolRecognized ? new Set(historyGroups.map(value => value.floorId || `sequence-${value.assistantSeq}`)).size : selectedFloorCount;
  const qianshiProgressText = qianshiProtocol.matched ? renderedQianshiProgressText(signedQianshiProgress, receipt.timeDependencies) : '';
  const status = receipt.status ?? (receipt.injectionText ? 'ready' : 'empty');
  const objectItems = Object.freeze(['ready', 'empty'].includes(status) ? [
    ...qianshiObjectItems(qianshiProgressText),
    ...timeReferenceItems.map((text, index) => {
      const source = timeReferenceDisplayItems[index]?.source;
      let title = source ?? text.split(/[：；\n]/u)[0];
      const observation = Math.max(text.indexOf('：观察于'), text.indexOf('：观察/发生于'));
      const prefix = observation > 0 ? text.slice(0, observation) : '';
      const standard = source && !text.startsWith('[时间校正] ') && (prefix === source || prefix.endsWith(` / ${source}`));
      if (standard) title = prefix;
      return Object.freeze({ id: `time:${index}`, group: 'time', title, text,
        ...(standard ? { bodyText: text.slice(prefix.length + 1) } : {}), caption: '时间参考' });
    }),
    ...matchedPlaceItems,
    ...(parsedHistory ?? []).filter(auxiliaryRecallHistory).map((item, index) => {
      const displayText = compactPlaceRecord(item.text), title = displayText.split(/[：；\n]/u)[0];
      return Object.freeze({ id: `place-history:${index}`, group: 'place', title, text: item.text, displayText,
        ...(displayText.startsWith(`${title}：`) ? { bodyText: displayText.slice(title.length + 1) } : {}), assistantSeq: item.assistantSeq,
        sourceFloorId: selectedFloors.find(floor => floor.assistantSeq === item.assistantSeq)?.floorId ?? '', caption: '当时地点记录' });
    }),
    ...(locationReferences.references ?? []).map((reference, index) => Object.freeze({ ...reference, id: `location:${index}`, group: 'place',
      title: reference.text, text: locationReferenceItems[index], bodyText: '', static: true, caption: '当时地点' })),
  ] : []);
  const objectCount = objectItems.length;
  const hideCard = protocolRecognized && ['ready', 'empty'].includes(status) && !historyItems.length && !stateItems.length && !cseChangeItems.length && !personHistoryCount && !objectCount;
  const rawReceiptAvailable = Boolean((containsManualArtifact || receipt.legacyReadOnly || receipt.restoredReceipt || receipt.reusedReceipt) && !protocolRecognized
    && ['ready', 'empty'].includes(status) && injectionText.trim());
  const terminated = receipt.status === 'stale' && (receipt.terminationEvent === 'GENERATION_STOPPED' || receipt.terminationEvent === 'GENERATION_ENDED'
    || (!receipt.terminationEvent && Array.isArray(receipt.skipReasons) && receipt.skipReasons.includes('stopped')));
  const terminationText = receipt.terminationEvent === 'GENERATION_ENDED' ? '生成已结束，召回未完成' : terminated ? '召回已停止' : null;
  const countText = [historyCount?`旧事 ${historyCount} 段`:'',personCount?`人物 ${personCount} 位`:'',personHistoryCount && !personCount ? `人物史料 ${personHistoryCount} 条` : '',objectCount ? `物 ${objectCount} 项` : ''].filter(Boolean).join(' · ');
  const statusText = receipt.legacyReadOnly && !protocolRecognized ? '旧版只读记录'
    : status === 'skipped' && receipt.skipReasons?.includes('recentBodyOnly') ? '近期正文已覆盖，无需召回'
    : status === 'ready' || status === 'empty' ? countText || (protocolRecognized?'无召回内容':'召回记录')
        : status === 'stale' ? terminationText ?? '本轮结果已失效'
          : status === 'error' ? '本轮召回失败' : '本轮已跳过';
  const phaseCopy = { input: '输入准备', source: '来源读取', selecting: '选材', commit: '提交前核验', receipt: '回执保存' };
  const stepCopy = { input: '输入准备', source: '来源读取', identity: '身份读取', root: '根版本读取', prepare: '准备缓存', read: '独立来源读取', projection: '来源投影', timeProjection: '时间投影', bodyWitness: '正文关联核验', qianshiProgress: '千事进度准备', queryContext: '查询上下文', prequelSelection: '前情选择', receiptValidation: '已有回执校验', receiptSourceVerification: '回执来源核验', semanticQuery: '语义查询', candidateBuild: '候选构建', utilityTask: '模型选材', responseParse: '结果解析', localSelection: '本地选材', qianshiSeal: '千事结果校验', commitVerification: '提交前核验', deletionWitness: '删除状态核验', receiptSeal: '回执封签', receiptSaveCall: '回执保存请求', receiptSaveWait: '等待回执保存', receiptSaveReturned: '回执保存返回', receiptSaveFailed: '回执保存失败', complete: '完成' };
  const terminationSummary = terminated
    ? `${receipt.diagnosticPhase ? `终止于${phaseCopy[receipt.diagnosticPhase] ?? '未知阶段'}${receipt.pendingStep ? ` · 终止步骤：${stepCopy[receipt.pendingStep] ?? '未记录'}` : ''}${receipt.lastCompletedStep ? ` · 上一步：${stepCopy[receipt.lastCompletedStep] ?? '未记录'}` : ''}` : '终止阶段未记录'} · ${Number.isFinite(receipt.timings?.totalMs) ? `召回等待 ${Number(receipt.timings.totalMs).toFixed(1)} ms` : '召回等待未记录'}${Number.isFinite(receipt.timings?.sourceMs) ? ` · 读取 ${Number(receipt.timings.sourceMs).toFixed(1)} ms` : ''}${Number.isFinite(receipt.timings?.selectorMs) ? ` · 选材 ${Number(receipt.timings.selectorMs).toFixed(1)} ms` : ''} · 本轮未注入`
    : null;
  const summary = receipt.status === 'skipped' && receipt.skipReasons?.includes('recentBodyOnly')
    ? '近期正文已覆盖，无需召回。' : terminationSummary ?? (hasExactStageCounts
    ? `近期摘要 ${recentSummaryCount} 条 · 远期旧事 ${distantHistoryItemCount} 条 · 当前人物状态 ${exactStateCount} 条${Number.isSafeInteger(receipt.stages?.cseChangeCount) ? ` · 历史变化 ${receipt.stages.cseChangeCount} 条` : ''}`
    : historyItems.length
    ? `已召回 ${historyItems.length} 条旧事${stateCount ? ` · ${stateCount} 条当前人物状态` : ''}${cseChangeCount ? ` · ${cseChangeCount} 条历史变化` : ''}`
    : stateCount || cseChangeCount ? `已记录${stateCount ? ` ${stateCount} 条当前人物状态` : ''}${stateCount && cseChangeCount ? ' ·' : ''}${cseChangeCount ? ` ${cseChangeCount} 条历史变化` : ''}`
      : floorCount || !safeShape || (receipt.legacyReadOnly && !protocolRecognized) ? '召回内容请在详细回执中查看。'
    : locationReferenceCount ? `本轮已注入 ${locationReferenceCount} 条原消息地点参照。`
    : qianshiProgressText ? '本轮已注入千事进度。'
      : status === 'empty' ? '本轮没有需要注入的记忆。' : '本轮没有已注入的记忆。');
  const visibleSummary = receipt.skipReasons?.includes('manualArtifactBudget')
    ? `${summary} 已选原文超出本轮预算，全文未注入。` : summary;
  return Object.freeze({
    kind: 'user', status, hideCard, statusText, summary: visibleSummary, ...(terminationSummary ? { statusDetail: terminationSummary } : receipt.legacyReadOnly?{statusDetail:'旧版只读记录'}:{}),
    receiptKey:JSON.stringify([receipt.createdAt??null,injectionText,selectedFloors,stateItems,cseChangeItems,personHistoryItems,objectItems]),
    injectionText, rawReceiptAvailable, qianshiProgressText, objectItems, objectCount, personHistoryItems, personHistoryCount, floorCount, historyCount, personCount, stateCount, cseChangeCount, recentSummaryCount, distantHistoryItemCount, selectedFloors, historyItems, historyGroups, storylines, storylineGroups, stateItems, cseChangeItems, timeReferenceItems, timeReferenceDisplayItems, timeReferenceCount, locationReferenceItems, locationReferenceCount, protocolRecognized,
  });
}
