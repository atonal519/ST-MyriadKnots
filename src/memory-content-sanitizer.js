const TAG_NAME_PATTERN = /^[\p{L}][\p{L}\p{N}_-]*~?$/u;
const LITERAL_WRAPPER_SEPARATOR = '...';

function literalWrapperRule(value) {
  const separator = value.indexOf(LITERAL_WRAPPER_SEPARATOR);
  if (separator <= 0 || separator !== value.lastIndexOf(LITERAL_WRAPPER_SEPARATOR) || separator + LITERAL_WRAPPER_SEPARATOR.length >= value.length) return null;
  return Object.freeze({ start: value.slice(0, separator), end: value.slice(separator + LITERAL_WRAPPER_SEPARATOR.length) });
}

export function normalizeArchiveV2TagList(value) {
  return String(value || '').split(/[,，\n]/).map(item => String(item).trim()).map(item => {
    if (literalWrapperRule(item)) return item;
    const tagName = item.toLowerCase();
    return TAG_NAME_PATTERN.test(tagName) && !/~~|~.+/.test(tagName) ? tagName : '';
  }).filter(Boolean);
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

function dropLiteralWrappedContent(content, rules) {
  let result = content;
  for (const { start, end } of rules) {
    let cursor = 0;
    let output = '';
    while (cursor < result.length) {
      const opening = result.indexOf(start, cursor);
      if (opening < 0) { output += result.slice(cursor); break; }
      const closing = result.indexOf(end, opening + start.length);
      if (closing < 0) { output += result.slice(cursor); break; }
      output += result.slice(cursor, opening);
      cursor = closing + end.length;
    }
    result = output;
  }
  return result;
}

export function sanitizeArchiveV2SourceContent(raw, options = {}) {
  if (!raw) return '';
  const keep = normalizeArchiveV2TagList(options.keepTags ?? 'content').filter(item => TAG_NAME_PATTERN.test(item));
  const extra = normalizeArchiveV2TagList(options.extraTags ?? '');
  const literalDropRules = extra.map(literalWrapperRule).filter(Boolean);
  let content = String(raw);
  content = dropLiteralWrappedContent(content, literalDropRules);
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
