const TAG_NAME_PATTERN = /^[\p{L}][\p{L}\p{N}_-]*~?$/u;

export function normalizeArchiveV2TagList(value) {
  return String(value || '').split(/[,，\n]/).map(item => String(item).trim().toLowerCase())
    .filter(item => TAG_NAME_PATTERN.test(item) && !/~~|~.+/.test(item));
}

export const normalizeMemoryTagList = normalizeArchiveV2TagList;

const TAG_PATTERN = /<(\/?)\s*([\p{L}][\p{L}\p{N}_-]*~?)(?:\s[^>]*)?(\/?)>/giu;

function tagTokens(content) {
  return [...content.matchAll(TAG_PATTERN)].map(match => ({
    start: match.index,
    end: match.index + match[0].length,
    name: match[2].toLocaleLowerCase('en-US'),
    closing: match[1] === '/',
    selfClosing: match[3] === '/',
  }));
}

function pairedDropIntervals(tokens, keep) {
  const openByName = new Map();
  const intervals = [];
  for (const token of tokens) {
    if (token.selfClosing) continue;
    const stack = openByName.get(token.name) ?? [];
    if (!token.closing) {
      stack.push(token);
      openByName.set(token.name, stack);
      continue;
    }
    const opener = stack.pop();
    if (!opener || keep.has(token.name)) continue;
    intervals.push([opener.end, token.start]);
  }
  intervals.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]);
    else merged.push([...interval]);
  }
  return merged;
}

export function sanitizeArchiveV2SourceContent(raw, options = {}) {
  if (!raw) return '';
  const keep = normalizeArchiveV2TagList(options.keepTags ?? 'content');
  // Normalize extra even though every non-kept paired tag is stripped by default.
  // Keeping this call preserves the public setting contract and validation path.
  normalizeArchiveV2TagList(options.extraTags ?? '');
  let content = String(raw);
  content = content.replace(/<!--[\s\S]*?-->/g, '');
  const tokens = tagTokens(content);
  const intervals = pairedDropIntervals(tokens, new Set(keep));
  let intervalIndex = 0;
  const visibleText = (start, end) => {
    let cursor = start;
    let result = '';
    while (cursor < end) {
      while (intervalIndex < intervals.length && intervals[intervalIndex][1] <= cursor) intervalIndex += 1;
      const interval = intervals[intervalIndex];
      if (!interval || interval[0] >= end) return result + content.slice(cursor, end);
      if (interval[0] > cursor) result += content.slice(cursor, Math.min(interval[0], end));
      cursor = Math.max(cursor, interval[1]);
    }
    return result;
  };
  let cursor = 0;
  let output = '';
  for (const token of tokens) {
    output += visibleText(cursor, token.start);
    cursor = token.end;
  }
  output += visibleText(cursor, content.length);
  return output.replace(/\n{3,}/g, '\n\n').trim();
}

// Compatibility name. All V2 AI inputs call the shared sanitizer above.
export const sanitizeMemoryContent = sanitizeArchiveV2SourceContent;
