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
const HTML_VOID_TAGS = new Set(['br']);

function tagTokens(content, { htmlVoidTags = false } = {}) {
  return [...content.matchAll(TAG_PATTERN)].map(match => ({
    start: match.index,
    end: match.index + match[0].length,
    name: match[2].toLocaleLowerCase('en-US'),
    closing: match[1] === '/',
    selfClosing: match[3] === '/' || htmlVoidTags && HTML_VOID_TAGS.has(match[2].toLocaleLowerCase('en-US')),
  }));
}

function parseSanitizerTree(content, tokens) {
  const root = { children: [], textRanges: [] };
  const stack = [root];
  let cursor = 0;
  for (const token of tokens) {
    const parent = stack.at(-1);
    if (token.start > cursor) {
      parent.children.push(content.slice(cursor, token.start));
      parent.textRanges.push([cursor, token.start]);
    }
    if (token.selfClosing) {
      cursor = token.end;
      continue;
    }
    if (!token.closing) {
      const node = { name: token.name, closed: false, start: token.start, end: content.length, contentStart: token.end, contentEnd: content.length, children: [], textRanges: [] };
      parent.children.push(node);
      stack.push(node);
    } else if (stack.length > 1) {
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].name !== token.name) continue;
        stack[index].closed = true;
        stack[index].end = token.end;
        stack[index].contentEnd = token.start;
        stack.length = index;
        break;
      }
    }
    cursor = token.end;
  }
  stack.at(-1).children.push(content.slice(cursor));
  stack.at(-1).textRanges.push([cursor, content.length]);
  return root;
}

function renderSanitizerChildren(children, keep, rescueOnly = false) {
  let output = '';
  for (const child of children) {
    if (typeof child === 'string') {
      if (!rescueOnly) output += child;
      continue;
    }
    // Explicit keep blocks survive even inside discarded ancestors; unmatched wrappers only rescue visible text.
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

export function stripMemoryTagBlocks(raw, tagNames) {
  const source = String(raw ?? '');
  const names = new Set(normalizeMemoryTagList(tagNames).map(name => name.toLocaleLowerCase('en-US')));
  if (!names.size || !source) return source;
  const content = source.replace(/<!--[\s\S]*?-->/gu, ' ');
  const ranges = [];
  const visit = (children, textRanges, rescueText = false) => {
    if (rescueText) ranges.push(...textRanges);
    for (const child of children) {
      if (typeof child === 'string') continue;
      if (names.has(child.name)) {
        if (child.closed) ranges.push([child.start, child.end]);
        else visit(child.children, child.textRanges, true);
      } else {
        visit(child.children, child.textRanges, rescueText && !child.closed);
      }
    }
  };
  const tree = parseSanitizerTree(content, tagTokens(content, { htmlVoidTags: true }));
  visit(tree.children, tree.textRanges);
  if (!ranges.length) return content;
  ranges.sort((left, right) => left[0] - right[0]);
  let output = '', cursor = 0;
  for (const [start, end] of ranges) {
    output += content.slice(cursor, start) + ' ';
    cursor = end;
  }
  return output + content.slice(cursor);
}

export function readMemoryTagBlocks(raw) {
  const source = String(raw ?? '').replace(/<!--[\s\S]*?-->/gu, ' ');
  const blocks = [];
  const plainText = children => children.map(child => typeof child === 'string' ? child : plainText(child.children)).join(' ');
  const visit = (children, ancestors = [], parentRange = null) => {
    for (const child of children) {
      if (typeof child === 'string') continue;
      blocks.push(Object.freeze({ name: child.name, closed: child.closed, ancestors: Object.freeze([...ancestors]),
        depth: ancestors.length + 1, parentRange: parentRange && Object.freeze([...parentRange]),
        directText: child.textRanges.map(([start, end]) => source.slice(start, end)).join(' '),
        text: plainText(child.children).replace(/\s+/gu, ' ').trim(), rawContent: source.slice(child.contentStart, child.contentEnd) }));
      visit(child.children, [...ancestors, child.name], [child.start, child.end]);
    }
  };
  visit(parseSanitizerTree(source, tagTokens(source, { htmlVoidTags: true })).children);
  return Object.freeze(blocks);
}
