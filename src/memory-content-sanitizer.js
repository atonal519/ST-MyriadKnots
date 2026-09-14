const TAG_NAME_PATTERN = /^[\p{L}][\p{L}\p{N}_-]*~?$/u;
const LITERAL_WRAPPER_SEPARATOR = '...';

function literalWrapperRule(value) {
  const separator = value.indexOf(LITERAL_WRAPPER_SEPARATOR);
  if (separator <= 0 || separator !== value.lastIndexOf(LITERAL_WRAPPER_SEPARATOR) || separator + LITERAL_WRAPPER_SEPARATOR.length >= value.length) return null;
  return Object.freeze({ start: value.slice(0, separator), end: value.slice(separator + LITERAL_WRAPPER_SEPARATOR.length) });
}

export function normalizeMemoryTagList(value) {
  return String(value || '').split(/[,，\n]/).map(item => String(item).trim()).map(item => {
    if (literalWrapperRule(item)) return item;
    const tagName = item.toLowerCase();
    return TAG_NAME_PATTERN.test(tagName) && !/~~|~.+/.test(tagName) ? tagName : '';
  }).filter(Boolean);
}

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

function parseSanitizerTree(content, tokens) {
  const root = { children: [] };
  const stack = [root];
  let cursor = 0;
  for (const token of tokens) {
    const parent = stack.at(-1);
    if (token.start > cursor) parent.children.push(content.slice(cursor, token.start));
    if (token.selfClosing) {
      cursor = token.end;
      continue;
    }
    if (!token.closing) {
      const node = { name: token.name, closed: false, children: [] };
      parent.children.push(node);
      stack.push(node);
    } else if (stack.length > 1) {
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].name !== token.name) continue;
        stack[index].closed = true;
        stack.length = index;
        break;
      }
    }
    cursor = token.end;
  }
  stack.at(-1).children.push(content.slice(cursor));
  return root;
}

function renderSanitizerChildren(children, keep, rescueOnly = false) {
  let output = '';
  for (const child of children) {
    if (typeof child === 'string') {
      if (!rescueOnly) output += child;
      continue;
    }
    if (child.closed && keep.has(child.name)) {
      output += renderSanitizerChildren(child.children, keep);
    } else if (!child.closed) {
      output += renderSanitizerChildren(child.children, keep, rescueOnly);
    } else {
      output += renderSanitizerChildren(child.children, keep, true);
    }
  }
  return output;
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

export function sanitizeMemoryContent(raw, options = {}) {
  if (!raw) return '';
  const keep = normalizeMemoryTagList(options.keepTags ?? 'content').filter(item => TAG_NAME_PATTERN.test(item));
  const extra = normalizeMemoryTagList(options.extraTags ?? '');
  const literalDropRules = extra.map(literalWrapperRule).filter(Boolean);
  let content = String(raw);
  content = dropLiteralWrappedContent(content, literalDropRules);
  content = content.replace(/<!--[\s\S]*?-->/g, '');
  const tokens = tagTokens(content);
  const output = renderSanitizerChildren(parseSanitizerTree(content, tokens).children, new Set(keep));
  return output.replace(/\n{3,}/g, '\n\n').trim();
}
