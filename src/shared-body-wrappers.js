// Author source: ST-QianQianJie/src/shared-body-wrappers.js; distribute this file unchanged with each plugin.
// No host imports or import-time writes: callers own the settings container and save lifecycle.
export const TAG_NAME_SOURCE = String.raw`[\p{L}][\p{L}\p{M}\p{N}_-]*(?:~(?:[\p{L}\p{N}_][\p{L}\p{M}\p{N}_]*)?)?`;
const tagName = new RegExp(`^${TAG_NAME_SOURCE}$`, 'u');
const namedPair = new RegExp(`^\\[(${TAG_NAME_SOURCE})\\]\\.\\.\\.\\[\\/\\1\\]$`, 'iu');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const own = (value, key) => Object.hasOwn(value ?? {}, key);

function literalRule(value) {
  const index = value.indexOf('...');
  return index > 0 && index === value.lastIndexOf('...') && index + 3 < value.length
    ? { start: value.slice(0, index), end: value.slice(index + 3) } : null;
}

export function normalizeWrapperRules(value) {
  const rules = String(value ?? '').split(/[,，\n]/u).map(item => item.trim()).filter(Boolean).map(item => {
    const named = namedPair.exec(item);
    if (named) return `[${named[1].toLowerCase()}]...[/${named[1].toLowerCase()}]`;
    if (literalRule(item)) return item;
    const name = item.replace(/^<\s*([^<>]+?)\s*>$/u, '$1').trim().toLowerCase();
    return tagName.test(name) ? name : '';
  });
  return [...new Set(rules.filter(Boolean))];
}

export function getSharedBodyWrappers(extensionSettings) {
  const shared = extensionSettings['schedule-planner'] ??= {};
  if (!own(shared, 'bodyWrappers')) {
    const local = extensionSettings.qianqianjie;
    const merge = (key, localKey, fallback) => {
      const values = [];
      if (own(local, localKey)) values.push(local[localKey]);
      if (own(shared, key)) values.push(shared[key]);
      return [...new Set((values.length ? values : [fallback]).flatMap(normalizeWrapperRules))].join(',');
    };
    shared.bodyWrappers = { keepTags: merge('keepTags', 'sourceKeepTags', 'content'), extraTags: merge('extraTags', 'sourceExtraTags', '') };
  }
  return shared.bodyWrappers;
}

export function updateSharedBodyWrappers(extensionSettings, patch) {
  const current = getSharedBodyWrappers(extensionSettings);
  for (const key of ['keepTags', 'extraTags']) if (own(patch, key)) current[key] = normalizeWrapperRules(patch[key]).join(',');
  return current;
}

const htmlLayout = new Set('html body main article section header footer div p span strong em b i u s small mark blockquote ul ol li dl dt dd table thead tbody tfoot tr td th caption h1 h2 h3 h4 h5 h6 pre code a font center'.split(' '));
const htmlBlocks = new Set('main article section header footer div p blockquote ul ol li dl dt dd table tr h1 h2 h3 h4 h5 h6 pre center'.split(' '));
const htmlAttributes = String.raw`(?:\s(?:[^"'<>]|"[^"]*"|'[^']*')*)?`;
const htmlRawText = `<(script|style)${htmlAttributes}>[\\s\\S]*?(?:<\\/\\1\\s*>|$)`;

function parseBody(text, keep, extra, htmlFormatting = false) {
  const root = { kind: 'root', children: [] }, stack = [root];
  const literals = [...new Set([...keep, ...extra])].flatMap(rule => {
    const pair = literalRule(rule);
    return pair ? [{ ...pair, rule, named: namedPair.test(rule) }] : [];
  });
  const delimiters = [...new Set(literals.flatMap(pair => [pair.start, pair.end]))].sort((a, b) => b.length - a.length);
  const xml = `<\\/?${TAG_NAME_SOURCE}${htmlFormatting ? htmlAttributes : '(?:\\s[^>]*)?'}\\/?>`;
  const tokenRx = new RegExp([...delimiters.map(escape), '<!--[\\s\\S]*?-->', ...(htmlFormatting ? [htmlRawText, '<!doctype\\s+html[^>]*>'] : []), xml].join('|'), 'giu');
  let cursor = 0;
  for (const match of text.matchAll(tokenRx)) {
    const parent = stack.at(-1), token = match[0];
    if (match.index > cursor) parent.children.push(text.slice(cursor, match.index));
    const matches = (left, right, pair) => pair.named ? left.toLowerCase() === right.toLowerCase() : left === right;
    const closing = literals.find(pair => matches(token, pair.end, pair) && stack.some(node => node.kind === 'literal' && node.rule === pair.rule));
    const opening = closing ? null : literals.find(pair => matches(token, pair.start, pair));
    if (closing) {
      for (let index = stack.length - 1; index > 0; index--) if (stack[index].kind === 'literal' && stack[index].rule === closing.rule) {
        stack[index].closed = true; stack[index].closeToken = token; stack.length = index; break;
      }
    } else if (opening) {
      const node = { kind: 'literal', rule: opening.rule, openToken: token, closed: false, children: [] };
      parent.children.push(node); stack.push(node);
    } else if (htmlFormatting && /^<(?:script|style)(?:\s|>)/iu.test(token)) {
      parent.children.push({ kind: 'htmlRaw', children: parseBody(token, keep, extra) });
    } else if (htmlFormatting && /^<!doctype\s+html/iu.test(token)) {
      parent.children.push({ kind: 'htmlDeclaration', text: token });
    } else if (token.startsWith('<!--')) {
      // Recognize explicit literal markers before dropping ordinary comments.
    } else if (token.startsWith('<')) {
      const name = new RegExp(`^<\\/?(${TAG_NAME_SOURCE})`, 'iu').exec(token)?.[1]?.toLowerCase();
      if (!name) parent.children.push(token);
      else if (token.startsWith('</')) {
        for (let index = stack.length - 1; index > 0; index--) if (stack[index].kind === 'xml' && stack[index].name === name) {
          stack[index].closed = true; stack.length = index; break;
        }
      } else if (!/\/\s*>$/u.test(token)) {
        const node = { kind: 'xml', name, closed: false, children: [] };
        parent.children.push(node); stack.push(node);
      } else if (htmlFormatting && name === 'br') {
        parent.children.push({ kind: 'xml', name, closed: false, children: [] });
      }
    } else parent.children.push(token);
    cursor = match.index + token.length;
  }
  stack.at(-1).children.push(text.slice(cursor));
  return root.children;
}

function renderBody(children, keep, extra, rescueOnly = false, htmlContext = false, htmlFormatting = false) {
  let result = '';
  for (const node of children) {
    if (typeof node === 'string') { if (!rescueOnly) result += node; continue; }
    if (node.kind === 'htmlRaw') {
      if (!htmlContext) result += renderBody(node.children, keep, extra, rescueOnly);
      continue;
    }
    if (node.kind === 'htmlDeclaration') { if (!htmlContext && !rescueOnly) result += node.text; continue; }
    if (node.kind === 'literal') {
      if (node.closed && keep.has(node.rule)) result += renderBody(node.children, keep, extra, false, htmlFormatting, htmlFormatting);
      else if (!node.closed) result += (rescueOnly ? '' : node.openToken) + renderBody(node.children, keep, extra, rescueOnly, htmlContext, htmlFormatting);
      // Explicit literal cleaning drops the whole block; inner XML cannot rescue draft content.
      continue;
    }
    if (node.closed && keep.has(node.name)) result += renderBody(node.children, keep, extra, false, htmlFormatting, htmlFormatting);
    else if (htmlContext && !rescueOnly && !extra.has(node.name) && htmlLayout.has(node.name)) {
      const value = renderBody(node.children, keep, extra, false, true, htmlFormatting);
      result += htmlBlocks.has(node.name) && value ? `\n${value}\n` : value;
    } else if (htmlContext && !rescueOnly && node.name === 'br' && !node.closed && !extra.has('br')) {
      result += '\n' + renderBody(node.children, keep, extra, false, true, htmlFormatting);
    } else result += renderBody(node.children, keep, extra, node.closed || rescueOnly, htmlContext, htmlFormatting);
  }
  return result;
}

export function sanitizeStoryBody(raw, options = {}) {
  if (!raw) return '';
  const keep = new Set(normalizeWrapperRules(options.keepTags ?? 'content'));
  const extra = new Set(normalizeWrapperRules(options.extraTags ?? ''));
  let text = String(raw), htmlContext = false;
  const htmlFormatting = options.htmlFormatting === true;
  if (htmlFormatting) {
    const protectedFence = [...keep, ...extra].some(rule => { const pair = literalRule(rule); return pair && text.trim().startsWith(pair.start) && text.trim().endsWith(pair.end); });
    const fence = /^\s*(`{3}|~{3})(html)?[^\S\n]*\n([\s\S]*?)\n\1\s*$/iu.exec(text);
    if (!protectedFence && fence && (fence[2] || /^\s*(?:<!doctype\s+html\b|<html\b)/iu.test(fence[3]))) { text = fence[3]; htmlContext = true; }
    htmlContext ||= /^\s*(?:<!doctype\s+html[^>]*>\s*)?<html(?:\s[^>]*)?>[\s\S]*<\/html>\s*$/iu.test(text);
  }
  const result = renderBody(parseBody(text, keep, extra, htmlFormatting), keep, extra, false, htmlContext, htmlFormatting).replace(/\n{3,}/gu, '\n\n').trim();
  return htmlFormatting && !result.replace(/<!doctype\s+html[^>]*>/giu, '').replace(/(?:`{3}|~{3})(?:html)?/giu, '').trim() ? '' : result;
}
