import { scanAssistantCandidates } from './foundation-domain.js';
import { matchFloorCandidates } from './floor-binding.js';
import { parseSharedStoryClock, parseStoryClockReference } from '../story-clock.js';
import { projectTime, storyTimes, timeFingerprint, timeBodyReads } from './time-engine.js';
import { inferCanonicalCurrentTime } from './extractor.js';
import { estimateRecallTokens } from './recall-selector.js';

// Private projection: current selected body witnesses never rewrite foundation records.
export async function readTimeBody(reachable, host, { sanitizerOptions = {}, storyClockReferenceTags = 'Ti' } = {}) {
  const candidates = await scanAssistantCandidates(host.chat ?? [], { sanitizerOptions, chatId: reachable.root.chatId, captureRawContent: true });
  const binding = matchFloorCandidates(reachable.floors ?? [], candidates);
  if (binding.issue) throw Object.assign(new Error('正文楼绑定不唯一，未完成检查。'), { code: 'QQJ_TIME_BINDING' });
  const fallback = storyTimes(reachable.floorMemories ?? [], reachable.floors ?? []);
  const bodies = [], floors = [];
  let previous = null;
  for (const [index, candidate] of candidates.entries()) {
    const match = binding.candidateMatches.get(index);
    const shared = parseSharedStoryClock(candidate.rawContent), reference = parseStoryClockReference(candidate.rawContent, storyClockReferenceTags);
    const meta = shared?.endMeta ?? shared?.startMeta;
    const raw = meta?.date ? `${meta.date} ${meta.time ?? ''}` : reference?.referenceText ?? inferCanonicalCurrentTime(candidate.canonicalContent)?.text ?? '';
    const time = raw ? projectTime(raw.split(/\s*(?:→|->|⟶)\s*/u).at(-1), previous) : fallback.get(match?.floor.id) ?? projectTime('');
    previous = time;
    const timeSourceFingerprint = await timeFingerprint(raw ? [time.date, time.clock, time.date ? null : raw] : ['no-body-time']);
    const body = { timeSourceFingerprint, floorId: match?.floor.id ?? null, assistantSeq: candidate.assistantSeq, canonicalFingerprint: candidate.canonicalFingerprint,
      rawFingerprint: candidate.rawFingerprint, hostLocator: candidate.hostLocator, content: candidate.canonicalContent, observationTime: time };
    bodies.push(body);
    if (match) floors.push({ ...match.floor, assistantSeq: candidate.assistantSeq, canonicalFingerprint: candidate.canonicalFingerprint, timeSourceFingerprint, content: candidate.canonicalContent });
  }
  return { ...reachable, floors, bodyFloors: bodies, bodyTimes: new Map(bodies.filter(body => body.floorId).map(body => [body.floorId, body.observationTime])),
    bodySignature: await timeFingerprint(bodies.map(body => [body.floorId, body.hostLocator, body.rawFingerprint, body.canonicalFingerprint])) };
}

export function timeBodyStart(source) {
  const body = source.bodyFloors.at(-1);
  return body ? { floorId: body.floorId, hostLocator: body.hostLocator, rawFingerprint: body.rawFingerprint, canonicalFingerprint: body.canonicalFingerprint } : { awaitingFirst: true };
}
export function resolveTimeStart(start, source) {
  if (start?.awaitingFirst) return source.bodyFloors[0] ?? null;
  if (start?.floorId) return source.bodyFloors.find(body => body.floorId === start.floorId) ?? null;
  return source.bodyFloors.find(body => body.rawFingerprint === start?.rawFingerprint && body.canonicalFingerprint === start?.canonicalFingerprint
    && JSON.stringify(body.hostLocator) === JSON.stringify(start?.hostLocator)) ?? null;
}

export function planTimeBody(source, batches, { start = null, history = false, fragmentTokens = 1800, batchTokens = 3500 } = {}) {
  const reads = timeBodyReads(batches, source), startBody = resolveTimeStart(start, source);
  const eligible = source.bodyFloors.filter(body => body.floorId && (history || startBody && body.assistantSeq >= startBody.assistantSeq));
  const fragments = [];
  for (const body of eligible) {
    const covered = (reads.get(body.floorId) ?? []).sort((a, b) => a.from - b.from);
    let cursor = 0;
    const missing = [];
    for (const range of covered) { if (range.from > cursor) missing.push([cursor, range.from]); cursor = Math.max(cursor, range.to); }
    if (cursor < body.content.length) missing.push([cursor, body.content.length]);
    for (const [from, to] of missing) {
      let position = from;
      while (position < to) {
        let end = Math.min(to, position + 6000);
        while (estimateRecallTokens(body.content.slice(position, end)) > fragmentTokens) end = position + Math.max(1, Math.floor((end - position) * 0.8));
        if (end < to) { const paragraph = body.content.lastIndexOf('\n', end); if (paragraph > position + (end - position) / 2) end = paragraph + 1; }
        fragments.push({ floorId: body.floorId, assistantSeq: body.assistantSeq, canonicalFingerprint: body.canonicalFingerprint, rawFingerprint: body.rawFingerprint, timeSourceFingerprint: body.timeSourceFingerprint,
          from: position, to: end, totalCharacters: body.content.length, observationTime: body.observationTime, description: body.content.slice(position, end) });
        position = end;
      }
    }
  }
  const groups = [];
  for (const fragment of fragments) {
    let group = groups.at(-1);
    if (!group || new Set([...group, fragment].map(row => row.floorId)).size > 20 || estimateRecallTokens(JSON.stringify([...group, fragment])) > batchTokens) { group = []; groups.push(group); }
    group.push(fragment);
  }
  const fullyRead = body => body.floorId && (reads.get(body.floorId) ?? []).sort((a,b) => a.from-b.from).reduce((end, range) => range.from <= end ? Math.max(end, range.to) : end, 0) >= body.content.length;
  const checked = source.bodyFloors.filter(fullyRead).length;
  const earlierUnchecked = startBody ? source.bodyFloors.filter(body => body.assistantSeq < startBody.assistantSeq && !fullyRead(body)).length : 0;
  return { groups, floorCount: new Set(fragments.map(row => row.floorId)).size, batchCount: groups.length, apiCalls: groups.length,
    totalFloors: source.bodyFloors.length, checkedFloors: checked, earlierUnchecked, startAssistantSeq: startBody?.assistantSeq ?? null,
    pendingFloors: source.bodyFloors.filter(body => !body.floorId).length };
}
