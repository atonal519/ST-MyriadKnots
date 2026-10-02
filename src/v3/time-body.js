import { scanAssistantCandidates, selectAssistantMessage } from './foundation-domain.js';
import { matchFloorCandidates } from './floor-binding.js';
import { resolveStoryClock } from '../story-clock.js';
import { projectTime, projectTimeSource, storyTimes, timeFingerprint, timeBodyReads, createTimeBodyRequest, TIME_INPUT_TOKENS, TIME_BODY_AUXILIARY_TOKENS, TIME_SYSTEM_PROMPT } from './time-engine.js';
import { inferCanonicalCurrentTime } from './extractor.js';
import { estimateRecallTokens } from './recall-selector.js';
import { normalizeStoryClockReferenceTags } from '../story-clock.js';
import { stripMemoryTagBlocks } from '../memory-content-sanitizer.js';

export async function clockContentFingerprint(rawContent, referenceTags = '') {
  const raw = String(rawContent ?? '');
  const clocks = [...raw.matchAll(/<!--\s*(?:QQJ|SDC|myknots)-(?:start|end)\b[\s\S]*?-->/giu)].map(match => match[0]);
  const configured = new Set([...normalizeStoryClockReferenceTags(referenceTags), 'bbs_start', 'bbs_end'].map(name => name.toLocaleLowerCase('en-US')));
  const open = new Map(), references = [];
  const tagPattern = /<\s*(\/?)\s*(\p{L}[\p{L}\p{N}_-]*~?)(?=[\s/>])[^>]*>/giu;
  for (const token of raw.matchAll(tagPattern)) {
    const key = token[2].toLocaleLowerCase('en-US');
    if (!configured.has(key)) continue;
    const closing = token[1] === '/';
    if (!closing && !/\/\s*>$/u.test(token[0])) {
      const stack = open.get(key) ?? [];
      stack.push(token.index + token[0].length); open.set(key, stack);
    } else if (closing) {
      const start = open.get(key)?.pop();
      if (start !== undefined) references.push([key, raw.slice(start, token.index).replace(/<!--[\s\S]*?-->/gu, '').replace(/<\s*br\s*\/?>/giu, '\n').replace(/<[^>]*>/gu, '').trim()]);
    }
  }
  return timeFingerprint([clocks, references]);
}

function currentBodyClock(rawContent, canonicalContent, referenceTags, calendar = null) {
  const timestamp = resolveStoryClock(rawContent, referenceTags, calendar);
  if (timestamp && timestamp.status !== 'incomplete') return timestamp;
  const statusSource = stripMemoryTagBlocks(rawContent, 'content');
  const status = inferCanonicalCurrentTime(statusSource, { allowOpeningFallback: false });
  if (status?.kind === 'ambiguous') return Object.freeze({ status: 'ambiguous', source: 'status', signature: status.signature ?? 'ambiguous-status-time' });
  if (status?.text) return Object.freeze({ status: 'available', source: 'status', text: status.text, signature: JSON.stringify([status.kind, status.text]) });
  const content = inferCanonicalCurrentTime(canonicalContent);
  if (content?.text) return Object.freeze({ status: 'available', source: 'content', text: content.text, signature: JSON.stringify([content.kind, content.text]) });
  return timestamp?.status === 'incomplete' ? null : timestamp;
}

// Recent clock reads scan only their selected tail; persisted floors stay whole
// so the existing binder can reject ambiguous identity matches.
export async function readRecentBodyStoryTimes(host, { reachable = null, sanitizerOptions = {}, storyClockReferenceTags = '', limit = 32, calendar = null } = {}) {
  const chat = Array.isArray(host?.chat) ? host.chat : [];
  if (!(limit > 0)) return [];
  let startIndex = chat.length, visibleCount = 0;
  for (let index = chat.length - 1; index >= 0 && visibleCount < limit; index -= 1) {
    const message = chat[index];
    if (message?.is_system === true || message?.is_hidden === true || message?.hidden === true) continue;
    if (selectAssistantMessage(message)?.rawContent) { startIndex = index; visibleCount += 1; }
  }
  const candidates = (await scanAssistantCandidates(chat.slice(startIndex), { sanitizerOptions, chatId: reachable?.root?.chatId ?? '', captureRawContent: true }))
    .map(candidate => ({ ...candidate, hostLocator: { ...candidate.hostLocator, messageIndex: candidate.hostLocator.messageIndex + startIndex } }));
  const binding = matchFloorCandidates(reachable?.floors ?? [], candidates);
  const memories = storyTimes(reachable?.floorMemories ?? [], reachable?.floors ?? [], (raw, anchor) => projectTime(raw, anchor, { calendar }));
  const provenance = reachable?.run?.diagnostics?.floorProvenance ?? {};
  const visibleCandidates = candidates.map((candidate, index) => ({ candidate, match: binding.candidateMatches.get(index) }))
    .filter(({ candidate }) => {
      const message = chat[candidate.hostLocator.messageIndex];
      return message && message.is_system !== true && message.is_hidden !== true && message.hidden !== true;
    });
  const selected = visibleCandidates.slice(-limit);
  const reliable = [];
  let previous = null;
  for (const { candidate, match } of selected) {
    const messageIndex = candidate.hostLocator.messageIndex;
    const floorId = match?.floor.id;
    if (floorId && provenance[floorId]?.timeEdited === true) {
      const observationTime = memories.get(floorId) ?? projectTime('');
      previous = observationTime.date || Number.isInteger(observationTime.minute) ? observationTime : null;
      reliable.push({ messageIndex, floorId, observationTime, manual: true });
      continue;
    }
    const clock = currentBodyClock(candidate.rawContent, candidate.canonicalContent, storyClockReferenceTags, calendar);
    if (!clock) continue;
    if (clock.status === 'ambiguous') {
      previous = null;
      reliable.push({ messageIndex, floorId: floorId ?? null, observationTime: projectTime(''), ambiguous: true });
      continue;
    }
    const observationTime = projectTime(clock.text.split(/\s*(?:→|->|⟶)\s*/u).at(-1), previous, { calendar });
    if (!observationTime.date && !Number.isInteger(observationTime.minute)) continue;
    previous = observationTime;
    reliable.push({ messageIndex, floorId: floorId ?? null, observationTime });
  }
  return reliable;
}

// Private projection: current selected body witnesses never rewrite foundation records.
export async function readTimeBody(reachable, host, { sanitizerOptions = {}, storyClockReferenceTags = '', calendar = null } = {}) {
  const candidates = await scanAssistantCandidates(host.chat ?? [], { sanitizerOptions, chatId: reachable.root.chatId, captureRawContent: true });
  const binding = matchFloorCandidates(reachable.floors ?? [], candidates);
  if (binding.issue) throw Object.assign(new Error('正文楼绑定不唯一，未完成检查。'), { code: 'QQJ_TIME_BINDING' });
  const manualTimes = storyTimes(reachable.floorMemories ?? [], reachable.floors ?? [], (raw, anchor) => projectTime(raw, anchor, { calendar }));
  const manualSourceTimes = storyTimes(reachable.floorMemories ?? [], reachable.floors ?? [], projectTimeSource);
  const provenance = reachable.run?.diagnostics?.floorProvenance ?? {};
  const manualTime = floorId => Boolean(floorId && provenance[floorId]?.timeEdited === true);
  const bodies = [], floors = [];
  let previousHistory = null, previousVisible = null, previousHistorySource = null, previousVisibleSource = null;
  for (const [index, candidate] of candidates.entries()) {
    const match = binding.candidateMatches.get(index);
    const message = host.chat?.[candidate.hostLocator?.messageIndex];
    const visible = message && message.is_system !== true && message.is_hidden !== true && message.hidden !== true;
    const previous = visible ? previousVisible : previousHistory;
    const previousSource = visible ? previousVisibleSource : previousHistorySource;
    const clock = currentBodyClock(candidate.rawContent, candidate.canonicalContent, storyClockReferenceTags, calendar);
    // 历法改变日期可计算性，但不能改变旧正文读回的来源见证。
    const sourceClock = calendar ? currentBodyClock(candidate.rawContent, candidate.canonicalContent, storyClockReferenceTags) : clock;
    const sourceRaw = sourceClock?.text ?? '';
    const raw = clock?.text ?? '';
    const manual = manualTime(match?.floor.id);
    const ambiguous = !manual && clock?.status === 'ambiguous';
    const time = manual ? manualTimes.get(match?.floor.id) ?? projectTime('')
      : ambiguous ? projectTime('')
        : raw ? projectTime(raw.split(/\s*(?:→|->|⟶)\s*/u).at(-1), previous, { calendar }) : projectTime('');
    const sourceTime = manual ? manualSourceTimes.get(match?.floor.id) ?? projectTimeSource('')
      : sourceClock?.status === 'ambiguous' ? projectTimeSource('')
        : sourceRaw ? projectTimeSource(sourceRaw.split(/\s*(?:→|->|⟶)\s*/u).at(-1), previousSource) : projectTimeSource('');
    previousHistory = time; previousHistorySource = sourceTime;
    if (visible) { previousVisible = time; previousVisibleSource = sourceTime; }
    const timeSourceFingerprint = await timeFingerprint(manual ? [sourceTime.date, sourceTime.clock, sourceTime.date ? null : sourceTime.raw]
      : sourceClock?.status === 'ambiguous' ? ['ambiguous-body-time', sourceClock.signature]
        : sourceRaw ? [sourceTime.date, sourceTime.clock, sourceTime.date ? null : sourceRaw] : ['no-body-time']);
    const clockFingerprint = await clockContentFingerprint(candidate.rawContent, storyClockReferenceTags);
    const body = { stable: Boolean(candidate.stabilityProof), timeSourceKind: manual ? 'manual' : raw || ambiguous ? 'body' : 'unknown', timeSourceFingerprint, floorId: match?.floor.id ?? null, assistantSeq: candidate.assistantSeq, canonicalFingerprint: candidate.canonicalFingerprint,
      rawFingerprint: candidate.rawFingerprint, clockContentFingerprint: clockFingerprint, rawContent: candidate.rawContent, hostLocator: candidate.hostLocator, content: candidate.canonicalContent, observationTime: time };
    bodies.push(body);
    if (match) floors.push({ ...match.floor, assistantSeq: candidate.assistantSeq, canonicalFingerprint: candidate.canonicalFingerprint, timeSourceFingerprint, content: candidate.canonicalContent });
  }
  return { ...reachable, ...(calendar ? { calendar } : {}), floors, bodyFloors: bodies, bodyTimes: new Map(bodies.filter(body => body.floorId).map(body => [body.floorId, body.observationTime])),
    bodySignature: await timeFingerprint(bodies.map(body => [body.floorId, body.hostLocator, body.rawFingerprint, body.canonicalFingerprint])) };
}

export function timeBodyStart(source) {
  const body = source.bodyFloors.at(-1);
  return body ? { floorId: body.floorId, hostLocator: body.hostLocator, rawFingerprint: body.rawFingerprint, canonicalFingerprint: body.canonicalFingerprint } : { awaitingFirst: true };
}
export function resolveTimeStart(start, source) {
  if (start?.awaitingFirst) return source.bodyFloors[0] ?? null;
  if (start?.floorId) return source.bodyFloors.find(body => body.floorId === start.floorId) ?? null;
  const exact = source.bodyFloors.find(body => body.rawFingerprint === start?.rawFingerprint && body.canonicalFingerprint === start?.canonicalFingerprint
    && JSON.stringify(body.hostLocator) === JSON.stringify(start?.hostLocator));
  if (exact) return exact;
  if (typeof start?.rawFingerprint !== 'string' || !start.rawFingerprint || typeof start?.canonicalFingerprint !== 'string' || !start.canonicalFingerprint) return null;
  const relocated = source.bodyFloors.filter(body => body.rawFingerprint === start.rawFingerprint && body.canonicalFingerprint === start.canonicalFingerprint);
  return relocated.length === 1 ? relocated[0] : null;
}

export function planTimeBody(source, batches, { start = null, history = false, inputTokens = TIME_INPUT_TOKENS } = {}) {
  const reads = timeBodyReads(batches, source), startBody = resolveTimeStart(start, source);
  const eligible = source.bodyFloors.filter(body => body.floorId && (history || startBody && body.assistantSeq >= startBody.assistantSeq));
  const fragments = [], groups = [];
  const fits = rows => new Set(rows.map(row => row.floorId)).size <= 20
    && estimateRecallTokens(JSON.stringify(createTimeBodyRequest(source, rows, rows.at(-1))) + TIME_SYSTEM_PROMPT) <= inputTokens - TIME_BODY_AUXILIARY_TOKENS;
  const fragment = (body, from, to) => ({ floorId: body.floorId, assistantSeq: body.assistantSeq,
    canonicalFingerprint: body.canonicalFingerprint, rawFingerprint: body.rawFingerprint, timeSourceFingerprint: body.timeSourceFingerprint, clockContentFingerprint: body.clockContentFingerprint,
    from, to, totalCharacters: body.content.length, observationTime: body.observationTime, description: body.content.slice(from, to) });
  const add = row => { let group = groups.at(-1); if (!group || !fits([...group, row])) { group = []; groups.push(group); } group.push(row); fragments.push(row); };
  for (const body of eligible) {
    const versions = reads.get(body.floorId) ?? [];
    const isCurrentVersion = read => read.canonicalFingerprint === body.canonicalFingerprint
      && read.timeSourceFingerprint === body.timeSourceFingerprint && read.totalCharacters === body.content.length;
    const versionKey = read => JSON.stringify([read.canonicalFingerprint, read.timeSourceFingerprint, read.totalCharacters]);
    const byVersion = new Map();
    for (const read of versions) { const key = versionKey(read); byVersion.set(key, [...(byVersion.get(key) ?? []), read]); }
    const isCovered = ranges => ranges.sort((a, b) => a.from - b.from).reduce((end, range) => range.from <= end ? Math.max(end, range.to) : end, 0);
    const completeVersions = [...byVersion.values()].filter(ranges => isCovered([...ranges]) >= ranges[0].totalCharacters);
    if (completeVersions.length && (!history || completeVersions.some(ranges => isCurrentVersion(ranges[0])))) continue;
    const covered = versions.filter(isCurrentVersion).sort((a, b) => a.from - b.from);
    if (!covered.length && versions.length && !history) continue;
    let cursor = 0;
    const missing = [];
    for (const range of covered) { if (range.from > cursor) missing.push([cursor, range.from]); cursor = Math.max(cursor, range.to); }
    if (cursor < body.content.length) missing.push([cursor, body.content.length]);
    for (const [from, to] of missing) {
      const whole = fragment(body, from, to);
      if (fits([whole])) { add(whole); continue; }
      // Only an interval that cannot fit on its own is split; ordinary floors stay whole.
      let position = from;
      while (position < to) {
        let low = position + 1, high = to, end = position;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          if (fits([fragment(body, position, middle)])) { end = middle; low = middle + 1; }
          else high = middle - 1;
        }
        if (end === position) throw Object.assign(new Error('正文元数据超过输入预算，无法规划批次。'), { code: 'QQJ_TIME_INVALID' });
        if (end < to) { const paragraph = body.content.lastIndexOf('\n', end - 1); if (paragraph > position + (end - position) / 2) end = paragraph + 1; }
        add(fragment(body, position, end));
        position = end;
      }
    }
  }
  const fullyRead = body => body.floorId && (reads.get(body.floorId) ?? []).some(read => {
    const sameVersion = (reads.get(body.floorId) ?? []).filter(value => value.canonicalFingerprint === read.canonicalFingerprint
      && value.timeSourceFingerprint === read.timeSourceFingerprint && value.totalCharacters === read.totalCharacters);
    return sameVersion.sort((a, b) => a.from - b.from).reduce((end, range) => range.from <= end ? Math.max(end, range.to) : end, 0) >= read.totalCharacters;
  });
  const checked = source.bodyFloors.filter(fullyRead).length;
  const earlierUnchecked = startBody ? source.bodyFloors.filter(body => body.assistantSeq < startBody.assistantSeq && !fullyRead(body)).length : 0;
  return { groups, floorCount: new Set(fragments.map(row => row.floorId)).size, batchCount: groups.length, apiCalls: groups.length,
    totalFloors: source.bodyFloors.length, checkedFloors: checked, earlierUnchecked, startAssistantSeq: startBody?.assistantSeq ?? null,
    pendingFloors: source.bodyFloors.filter(body => !body.floorId).length };
}
