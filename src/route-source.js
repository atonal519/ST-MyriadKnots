import { sha256 } from './identity.js';

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
const activatedEntries = result => {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.activatedEntries)) return result.activatedEntries;
  throw fail('SCAN_RESULT_INVALID');
};
const batchEntries = (world, data) => Object.entries(data?.entries && typeof data.entries === 'object' ? data.entries : {})
  .map(([uid, entry]) => ({ ...(entry || {}), world, uid: entry?.uid ?? entry?.id ?? uid }))
  .filter(entry => entry.uid !== undefined && typeof entry.content === 'string');

export async function collectSourceCatalogCandidates(ctx) {
  const character = currentCharacter(ctx) || {};
  const card = character.data || character;
  const avatar = String(character.avatar ?? ctx?.characterAvatar ?? '').trim();
  const candidates = [];
  const warnings = [];
  for (const [field, label] of CARD_FIELDS) {
    const content = typeof (card[field] ?? character[field]) === 'string' ? (card[field] ?? character[field]) : '';
    if (!content.trim()) continue;
    const source = { kind: 'card', locator: `card:${avatar}#${field}`, fingerprint: `sha256:${await sha256(content)}`, content };
    candidates.push({ id: sourceId(source), ...source, label, availability: 'card', selected: true, activated: false, linked: true });
  }
  const greeting = await normalizeGreeting(ctx);
  const greetingSource = { kind: 'greeting', locator: `greeting:0:${greeting.swipeId}`, fingerprint: greeting.fingerprint, content: ctx.chat[0].mes };
  candidates.push({ id: sourceId(greetingSource), ...greetingSource, label: '当前开场白', availability: 'greeting', selected: true, activated: false, linked: true });

  if (typeof ctx?.simulateWorldInfoActivation !== 'function') throw fail('SCANNER_UNAVAILABLE');
  let activated;
  try { activated = activatedEntries(await ctx.simulateWorldInfoActivation({ coreChat: ctx.chat.slice(0, 1), dryRun: true })); }
  catch (error) { if (error?.diagnosticCode) throw error; throw fail('SCAN_FAILED'); }
  const activatedMap = new Map();
  for (const raw of activated) {
    const entry = entryParts(raw);
    const key = `${entry.world}\u0000${entry.uid}`;
    if (!activatedMap.has(key)) activatedMap.set(key, raw);
  }
  const primary = typeof card?.extensions?.world === 'string' ? card.extensions.world.trim() : '';
  let auxiliary = [];
  if (typeof ctx?.getCharaAuxWorlds === 'function' && typeof ctx?.getCharaFilename === 'function') {
    try { auxiliary = ctx.getCharaAuxWorlds(ctx.getCharaFilename(ctx.characterId)) || []; }
    catch { warnings.push({ code: 'CHARACTER_AUX_WORLDS_UNAVAILABLE' }); }
  } else warnings.push({ code: 'CHARACTER_AUX_WORLDS_UNAVAILABLE' });
  const linkedWorlds = new Set([primary, ...(Array.isArray(auxiliary) ? auxiliary : [])].map(value => String(value || '').trim()).filter(Boolean));
  const worlds = [...new Set([...linkedWorlds, ...[...activatedMap.values()].map(entry => String(entry.world).trim())])];
  let books = new Map();
  if (worlds.length) {
    if (typeof ctx?.loadWorldInfoBatch !== 'function') warnings.push({ code: 'WORLDBOOK_BATCH_UNAVAILABLE', count: worlds.length });
    else try { books = await ctx.loadWorldInfoBatch(worlds); } catch { warnings.push({ code: 'WORLDBOOK_READ_FAILED', count: worlds.length }); }
  }
  const refs = new Map();
  for (const world of worlds) {
    const data = books instanceof Map ? books.get(world) : null;
    const entries = Array.isArray(data) ? data : batchEntries(world, data);
    if (linkedWorlds.has(world) && (!data || !entries.length)) warnings.push({ code: 'WORLDBOOK_READ_FAILED', world: world.slice(0, 120) });
    for (const entry of entries) refs.set(`${world}\u0000${String(entry.uid)}`, { world, uid: String(entry.uid), entry });
  }
  for (const [key, raw] of activatedMap) if (!refs.has(key)) refs.set(key, { world: String(raw.world).trim(), uid: String(raw.uid), entry: raw });
  const ordered = [...refs.values()].sort((left, right) => compareKey(left.world, right.world) || compareKey(left.uid, right.uid));
  for (const { world, uid, entry } of ordered) {
    const content = typeof entry.content === 'string' ? entry.content : '';
    if (!content) continue;
    const activatedNow = activatedMap.has(`${world}\u0000${uid}`);
    const linked = linkedWorlds.has(world);
    if (!activatedNow && !linked) continue;
    const disabled = entry.disable === true;
    const source = { kind: 'worldbook', locator: `${world}:${uid}`, fingerprint: `sha256:${await sha256(content)}`, content };
    const comment = typeof entry.comment === 'string' ? entry.comment.trim() : '';
    const keys = Array.isArray(entry.key) ? entry.key.map(value => String(value).trim()).filter(Boolean).join('、') : '';
    candidates.push({
      id: sourceId(source),
      ...source,
      label: `${world} · ${comment || keys || `条目 ${uid}`}`.slice(0, 240),
      availability: disabled ? 'disabled' : activatedNow ? 'activated' : 'enabled',
      selected: !disabled,
      activated: activatedNow,
      linked,
    });
  }
  return { candidates, warnings: warnings.slice(0, 40) };
}
