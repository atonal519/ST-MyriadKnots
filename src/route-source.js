import { sha256 } from './identity.js';
import { createArchiveV2WorldInfoSourceCandidates, scanArchiveV2WorldInfo } from './archive-v2-source-scanner.js';

const fail = code => Object.assign(new Error('V2 来源不可用'), { failClosed: true, diagnosticCode: code });
const hidden = message => message?.is_hidden === true || message?.extra?.is_hidden === true;
const compareKey = (left, right) => left === right ? 0 : left < right ? -1 : 1;

export function cleanAnalysisText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<st-regex\b[^>]*>[\s\S]*?<\/st-regex\s*>/gi, ' ')
    .replace(/<UpdateVariable\b[^>]*>[\s\S]*?<\/UpdateVariable\s*>/gi, ' ')
    .replace(/```(?:html|javascript|js|css|json|xml)?\s*[\s\S]*?```/gi, ' ')
    .replace(/\{\{\s*(?:setvar|getvar|setglobalvar|getglobalvar|addvar|incvar|decvar|run|macro)[\s\S]*?\}\}/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export async function fingerprintGreeting({ floor, swipeId, content } = {}) {
  if (floor !== 0 || !Number.isInteger(swipeId) || swipeId < 0 || typeof content !== 'string') throw fail('GREETING_INVALID');
  return `sha256:${await sha256(`floor=0\nswipe=${swipeId}\ncontent=${content}`)}`;
}

export async function normalizeGreeting(ctx) {
  const first = Array.isArray(ctx?.chat) ? ctx.chat[0] : null;
  const marker = first?.is_ejs_processed;
  const ejsProcessed = marker === true || (Array.isArray(marker) && marker.length > 0 && marker.every(value => value === true));
  const ejsSystem = first?.is_system === true && ejsProcessed;
  if (!first || hidden(first) || first.is_user === true || (first.is_system === true && !ejsSystem) || typeof first.mes !== 'string') throw fail('GREETING_INVALID');
  const swipeId = first.swipe_id === undefined ? 0 : first.swipe_id;
  if (!Number.isInteger(swipeId) || swipeId < 0) throw fail('GREETING_INVALID');
  if (Array.isArray(first.swipes)) {
    if (swipeId >= first.swipes.length || typeof first.swipes[swipeId] !== 'string') throw fail('GREETING_INVALID');
  } else if (swipeId !== 0 || ejsSystem) throw fail('GREETING_INVALID');
  return { floor: 0, swipeId, fingerprint: await fingerprintGreeting({ floor: 0, swipeId, content: first.mes }) };
}

function entryParts(entry) {
  const world = typeof entry?.world === 'string' ? entry.world.trim() : '';
  const uid = entry?.uid === undefined || entry?.uid === null ? '' : String(entry.uid);
  if (!world || !uid || typeof entry?.content !== 'string') throw fail('ENTRY_INVALID');
  return { world, uid, content: entry.content };
}

export async function normalizeWorldInfoEntries(entries) {
  if (!Array.isArray(entries)) throw fail('SCAN_RESULT_INVALID');
  const output = new Map();
  for (const raw of entries) {
    const entry = entryParts(raw);
    const fingerprint = `sha256:${await sha256(entry.content)}`;
    const key = `${entry.world}\u0000${entry.uid}`;
    if (output.has(key) && output.get(key).fingerprint !== fingerprint) throw fail('ENTRY_INVALID');
    output.set(key, { world: entry.world, uid: entry.uid, fingerprint });
  }
  return [...output.values()].sort((left, right) => compareKey(left.world, right.world) || compareKey(left.uid, right.uid));
}

const CARD_FIELDS = Object.freeze([
  ['description', '角色描述'], ['personality', '角色性格'], ['scenario', '场景设定'], ['mes_example', '对话示例'],
  ['system_prompt', '角色系统设定'], ['post_history_instructions', '历史后指令'], ['creator_notes', '创作者备注'],
]);
const currentCharacter = ctx => Array.isArray(ctx?.characters) ? ctx.characters[ctx.characterId] : ctx?.characters?.[ctx.characterId];
const sourceId = source => `${source.kind}:${source.locator}`;

export async function collectCardGreetingCandidates(ctx) {
  const character = currentCharacter(ctx) || {};
  const card = character.data || character;
  const avatar = String(character.avatar ?? ctx?.characterAvatar ?? '').trim();
  const candidates = [];
  for (const [field, label] of CARD_FIELDS) {
    const content = typeof (card[field] ?? character[field]) === 'string' ? (card[field] ?? character[field]) : '';
    if (!content.trim()) continue;
    const source = { kind: 'card', locator: `card:${avatar}#${field}`, fingerprint: `sha256:${await sha256(content)}`, content };
    candidates.push({ id: sourceId(source), ...source, label, availability: 'card', selected: true, activated: false, linked: true });
  }
  const greeting = await normalizeGreeting(ctx);
  const greetingSource = { kind: 'greeting', locator: `greeting:0:${greeting.swipeId}`, fingerprint: greeting.fingerprint, content: ctx.chat[0].mes };
  candidates.push({ id: sourceId(greetingSource), ...greetingSource, label: '当前开场白', availability: 'greeting', selected: true, activated: false, linked: true });
  return candidates;
}

export async function collectSourceCatalogCandidates(ctx) {
  const candidates = await collectCardGreetingCandidates(ctx);
  const catalog = await scanArchiveV2WorldInfo(ctx);
  candidates.push(...await createArchiveV2WorldInfoSourceCandidates(catalog));
  return { candidates, warnings: [...catalog.warnings] };
}
