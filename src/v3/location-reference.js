import { readMemoryTagBlocks } from '../memory-content-sanitizer.js';

const MAX_ITEMS = 8;
const MAX_ITEM_CHARACTERS = 500;
const MAX_TOTAL_CHARACTERS = 2000;
const EXCLUDED_ANCESTORS = new Set(['think', 'thinking', 'reasoning', 'reasoning_content', 'analysis', 'cot', 'thought', 'thoughts', 'code', 'pre', 'example', 'commentary']);

function withoutMarkdownCode(source) {
  return source.replace(/(^|\n)[ \t]*```[^\n]*\n[\s\S]*?(?:\n[ \t]*```[ \t]*(?=\n|$)|$)/gu, (block, prefix) => prefix + block.slice(prefix.length).replace(/[^\n]/gu, ' '));
}

function collectLocationReferences(values) {
  const result = [];
  const seen = new Set();
  let total = 0;
  for (const candidate of values) {
    if (result.length >= MAX_ITEMS) break;
    if (typeof candidate !== 'string') continue;
    const text = candidate.replace(/\s+/gu, ' ').trim();
    if (!text || text.length > MAX_ITEM_CHARACTERS || seen.has(text)) continue;
    if (total + text.length > MAX_TOTAL_CHARACTERS) break;
    seen.add(text); result.push(text); total += text.length;
  }
  return result.length ? Object.freeze(result) : null;
}

export function normalizeLocationReference(value) {
  return Array.isArray(value) ? collectLocationReferences(value) : null;
}

export function readLocationReference(raw) {
  const rawText = String(raw ?? '');
  if (!/<\s*location\b/iu.test(rawText)) return null;
  const source = withoutMarkdownCode(rawText);
  function* values() {
    for (const block of readMemoryTagBlocks(source)) {
      if (block.name !== 'location' || !block.closed || block.ancestors.some(name => EXCLUDED_ANCESTORS.has(name))) continue;
      yield block.text;
    }
  }
  return collectLocationReferences(values());
}
