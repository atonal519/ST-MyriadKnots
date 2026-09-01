import { sha256 } from './identity.js';

export const ROUTE_DIAGNOSTICS = Object.freeze(['GREETING_INVALID', 'SCANNER_UNAVAILABLE', 'SCAN_FAILED', 'SCAN_RESULT_INVALID', 'ENTRY_INVALID', 'ROUTE_INVALID', 'UNKNOWN']);
const SOURCE_DIAGNOSTIC_CODES = new Set(['GREETING_VERSION_CHANGED', 'GREETING_CURRENT_UNAVAILABLE', 'WORLDBOOK_READ_FAILED', 'WORLDBOOK_BATCH_UNAVAILABLE', 'WORLDBOOK_ENTRY_MISSING', 'WORLDBOOK_VERSION_CHANGED']);
const fail = diagnosticCode => Object.assign(new Error('路线来源不可用'), { failClosed: true, diagnosticCode });
export const compareRouteKey = (a, b) => a === b ? 0 : (a < b ? -1 : 1);

const text = (value, diagnosticCode) => {
  if (typeof value !== 'string') throw fail(diagnosticCode);
  return value;
};
const hiddenMessage = value => value?.is_hidden === true || value?.extra?.is_hidden === true;

export async function fingerprintGreeting(greeting) {
  if (!greeting || greeting.floor !== 0 || !Number.isInteger(greeting.swipeId) || greeting.swipeId < 0) throw fail('GREETING_INVALID');
  const content = text(greeting.content, 'GREETING_INVALID');
  return `sha256:${await sha256(`floor=0\nswipe=${greeting.swipeId}\ncontent=${content}`)}`;
}

export async function normalizeGreeting(ctx) {
  const first = Array.isArray(ctx?.chat) ? ctx.chat[0] : null;
  const marker = first?.is_ejs_processed;
  const ejsProcessed = marker === true || (Array.isArray(marker) && marker.length > 0 && marker.every(value => value === true));
  const ejsSystem = first?.is_system === true && ejsProcessed;
  if (!first || hiddenMessage(first) || first.is_user === true || (first.is_system === true && !ejsSystem) || typeof first.mes !== 'string') throw fail('GREETING_INVALID');
  const rawSwipeId = first.swipe_id;
  if (ejsSystem && (!Number.isInteger(rawSwipeId) || rawSwipeId < 0)) throw fail('GREETING_INVALID');
  const swipeId = rawSwipeId === undefined ? 0 : rawSwipeId;
  if (!Number.isInteger(swipeId) || swipeId < 0) throw fail('GREETING_INVALID');
  if (ejsSystem) {
    if (!Array.isArray(first.swipes) || first.swipes.length === 0 || swipeId >= first.swipes.length || typeof first.swipes[swipeId] !== 'string') throw fail('GREETING_INVALID');
  } else if (Array.isArray(first.swipes)) {
    if (swipeId >= first.swipes.length || typeof first.swipes[swipeId] !== 'string') throw fail('GREETING_INVALID');
  } else if (swipeId !== 0) throw fail('GREETING_INVALID');
  return { floor: 0, swipeId, fingerprint: await fingerprintGreeting({ floor: 0, swipeId, content: first.mes }) };
}

function entryParts(entry) {
  const world = typeof entry?.world === 'string' ? entry.world.trim() : '';
  const uid = entry?.uid === undefined || entry?.uid === null ? '' : String(entry.uid);
  if (!world || !uid) throw fail('ENTRY_INVALID');
  return { world, uid, content: text(entry.content, 'ENTRY_INVALID') };
}

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

export async function normalizeWorldInfoEntries(entries) {
  if (!Array.isArray(entries)) throw fail('SCAN_RESULT_INVALID');
  const map = new Map();
  for (const raw of entries) {
    const part = entryParts(raw);
    const fingerprint = `sha256:${await sha256(part.content)}`;
    const key = `${part.world}\u0000${part.uid}`;
    const previous = map.get(key);
    if (previous && previous.fingerprint !== fingerprint) throw fail('ENTRY_INVALID');
    map.set(key, { world: part.world, uid: part.uid, fingerprint });
  }
  return [...map.values()].sort((a, b) => compareRouteKey(a.world, b.world) || compareRouteKey(a.uid, b.uid));
}

async function routeWorldInfoEntries(ctx, activated) {
  if (!Array.isArray(activated)) throw fail('SCAN_RESULT_INVALID');
  const refs = new Map();
  for (const entry of activated) {
    const world = typeof entry?.world === 'string' ? entry.world.trim() : '';
    const uid = entry?.uid === undefined || entry?.uid === null ? '' : String(entry.uid);
    if (!world || !uid) throw fail('ENTRY_INVALID');
    refs.set(`${world}\u0000${uid}`, { world, uid });
  }
  const selected = [...refs.values()].sort((a, b) => compareRouteKey(a.world, b.world) || compareRouteKey(a.uid, b.uid));
  if (typeof ctx?.loadWorldInfoBatch !== 'function' || selected.length === 0) return normalizeWorldInfoEntries(activated);
  const worlds = [...new Set(selected.map(entry => entry.world))];
  let books;
  try { books = await ctx.loadWorldInfoBatch(worlds); }
  catch { throw fail('SCAN_FAILED'); }
  const output = [];
  for (const ref of selected) {
    const data = books instanceof Map ? books.get(ref.world) : null;
    const entries = Array.isArray(data) ? data : batchEntries(ref.world, data);
    const found = entries.find(entry => String(entry.uid) === ref.uid);
    if (!found || typeof found.content !== 'string') throw fail('ENTRY_INVALID');
    output.push({ world: ref.world, uid: ref.uid, fingerprint: `sha256:${await sha256(found.content)}` });
  }
  return output;
}

export async function collectAnalysisSources(ctx) {
  const normalized = await normalizeGreeting(ctx);
  const scanner = ctx?.simulateWorldInfoActivation;
  if (typeof scanner !== 'function') throw fail('SCANNER_UNAVAILABLE');
  let result;
  try { result = await scanner.call(ctx, { coreChat: Array.isArray(ctx.chat) ? ctx.chat.slice(0, 1) : ctx.chat, dryRun: true }); }
  catch { throw fail('SCAN_FAILED'); }
  const raw = activatedEntries(result);
  const entries = [];
  const seen = new Set();
  for (const item of raw) {
    const part = entryParts(item); const key = `${part.world}\u0000${part.uid}`;
    const content = cleanAnalysisText(part.content);
    if (seen.has(key)) continue;
    seen.add(key); entries.push({ world: part.world, uid: part.uid, fingerprint: `sha256:${await sha256(part.content)}`, content });
  }
  entries.sort((a, b) => compareRouteKey(a.world, b.world) || compareRouteKey(a.uid, b.uid));
  return { greeting: { ...normalized, content: cleanAnalysisText(ctx.chat[0].mes) }, worldInfoEntries: entries };
}

const CARD_SOURCE_FIELDS = Object.freeze([
  ['description', '角色描述'], ['personality', '角色性格'], ['scenario', '场景设定'], ['mes_example', '对话示例'],
  ['system_prompt', '角色系统设定'], ['post_history_instructions', '历史后指令'], ['creator_notes', '创作者备注'],
]);
const sourceId = source => `${source.kind}:${source.locator}`;
const currentCharacter = ctx => Array.isArray(ctx?.characters) ? ctx.characters[ctx.characterId] : ctx?.characters?.[ctx.characterId];
const entryLabel = (world, uid, entry) => {
  const comment = typeof entry?.comment === 'string' ? entry.comment.trim() : '';
  const keys = Array.isArray(entry?.key) ? entry.key.map(value => String(value).trim()).filter(Boolean).join('、') : '';
  return `${world} · ${comment || keys || `条目 ${uid}`}`.slice(0, 240);
};

export async function collectSourceCatalogCandidates(ctx) {
  const character = currentCharacter(ctx) || {}, card = character.data || character;
  const avatar = String(character?.avatar ?? ctx?.characterAvatar ?? '').trim();
  const candidates = [], warnings = [];
  for (const [field, label] of CARD_SOURCE_FIELDS) {
    const content = typeof (card?.[field] ?? character?.[field]) === 'string' ? (card[field] ?? character[field]) : '';
    if (!content.trim()) continue;
    const source = { kind: 'card', locator: `card:${avatar}#${field}`, fingerprint: `sha256:${await sha256(content)}`, content };
    candidates.push({ id: sourceId(source), ...source, label, availability: 'card', selected: true, activated: false, linked: true });
  }
  const greeting = await normalizeGreeting(ctx);
  const greetingContent = ctx.chat[0].mes;
  const greetingSource = { kind: 'greeting', locator: `greeting:0:${greeting.swipeId}`, fingerprint: greeting.fingerprint, content: greetingContent };
  candidates.push({ id: sourceId(greetingSource), ...greetingSource, label: '当前开场白', availability: 'greeting', selected: true, activated: false, linked: true });

  if (typeof ctx?.simulateWorldInfoActivation !== 'function') throw fail('SCANNER_UNAVAILABLE');
  let activated;
  try { activated = activatedEntries(await ctx.simulateWorldInfoActivation({ coreChat: Array.isArray(ctx.chat) ? ctx.chat.slice(0, 1) : ctx.chat, dryRun: true })); }
  catch (error) { if (error?.diagnosticCode) throw error; throw fail('SCAN_FAILED'); }
  const activatedMap = new Map();
  for (const raw of activated) {
    const part = entryParts(raw), key = `${part.world}\u0000${part.uid}`;
    if (!activatedMap.has(key)) activatedMap.set(key, raw);
  }

  const primary = typeof card?.extensions?.world === 'string' ? card.extensions.world.trim() : '';
  let auxiliary = [];
  if (typeof ctx?.getCharaAuxWorlds === 'function' && typeof ctx?.getCharaFilename === 'function') {
    try { auxiliary = ctx.getCharaAuxWorlds(ctx.getCharaFilename(ctx.characterId)) || []; }
    catch { warnings.push({ code: 'CHARACTER_AUX_WORLDS_UNAVAILABLE' }); }
  } else warnings.push({ code: 'CHARACTER_AUX_WORLDS_UNAVAILABLE' });
  const linkedWorlds = new Set([primary, ...(Array.isArray(auxiliary) ? auxiliary : [])].map(value => String(value || '').trim()).filter(Boolean));
  const allWorlds = [...new Set([...linkedWorlds, ...[...activatedMap.values()].map(entry => String(entry.world).trim())])];
  let books = new Map();
  if (allWorlds.length) {
    if (typeof ctx?.loadWorldInfoBatch !== 'function') warnings.push({ code: 'WORLDBOOK_BATCH_UNAVAILABLE', count: allWorlds.length });
    else {
      try { books = await ctx.loadWorldInfoBatch(allWorlds); }
      catch { warnings.push({ code: 'WORLDBOOK_READ_FAILED', count: allWorlds.length }); books = new Map(); }
    }
  }
  const refs = new Map();
  for (const world of allWorlds) {
    const data = books instanceof Map ? books.get(world) : null;
    const entries = Array.isArray(data) ? data : batchEntries(world, data);
    if (linkedWorlds.has(world) && (!data || !entries.length)) warnings.push({ code: 'WORLDBOOK_READ_FAILED', world: world.slice(0, 120) });
    for (const entry of entries) refs.set(`${world}\u0000${String(entry.uid)}`, { world, uid: String(entry.uid), entry });
  }
  for (const [key, raw] of activatedMap) if (!refs.has(key)) refs.set(key, { world: String(raw.world).trim(), uid: String(raw.uid), entry: raw });
  const ordered = [...refs.values()].sort((a, b) => compareRouteKey(a.world, b.world) || compareRouteKey(a.uid, b.uid));
  for (const { world, uid, entry } of ordered) {
    const content = typeof entry?.content === 'string' ? entry.content : '';
    if (!content) continue;
    const isActivated = activatedMap.has(`${world}\u0000${uid}`), linked = linkedWorlds.has(world), disabled = entry?.disable === true;
    if (!isActivated && !linked) continue;
    const source = { kind: 'worldbook', locator: `${world}:${uid}`, fingerprint: `sha256:${await sha256(content)}`, content };
    const availability = disabled ? 'disabled' : isActivated ? 'activated' : 'enabled';
    candidates.push({ id: sourceId(source), ...source, label: entryLabel(world, uid, entry), availability, selected: !disabled, activated: isActivated, linked });
  }
  return { candidates, warnings: warnings.slice(0, 40) };
}

function batchEntries(world, data) {
  const values = data?.entries && typeof data.entries === 'object' ? Object.entries(data.entries) : [];
  return values.map(([uid, entry]) => ({ ...(entry || {}), world, uid: entry?.uid ?? entry?.id ?? uid, content: entry?.content })).filter(entry => entry.uid !== undefined && typeof entry.content === 'string');
}

async function readFrozenEntries(ctx, route) {
  const refs = route.worldInfoEntries;
  const warnings = [];
  const worlds = [...new Set(refs.map(entry => entry.world))];
  const unreadableWorlds = new Set();
  let books;
  if (typeof ctx?.loadWorldInfoBatch === 'function') {
    try { books = await ctx.loadWorldInfoBatch(worlds); }
    catch { books = new Map(); worlds.forEach(world => unreadableWorlds.add(world)); }
    if (books instanceof Map) {
      for (const world of worlds) {
        const data = books.get(world);
        if (!books.has(world) || data === null || data === undefined || (!Array.isArray(data) && (!data?.entries || typeof data.entries !== 'object'))) unreadableWorlds.add(world);
      }
    } else worlds.forEach(world => unreadableWorlds.add(world));
    if (unreadableWorlds.size) warnings.push({ code: 'WORLDBOOK_READ_FAILED', count: refs.filter(ref => unreadableWorlds.has(ref.world)).length });
  } else {
    warnings.push({ code: 'WORLDBOOK_BATCH_UNAVAILABLE', count: refs.length });
    books = new Map();
    if (typeof ctx?.simulateWorldInfoActivation === 'function') {
      try { const result = await ctx.simulateWorldInfoActivation({ coreChat: Array.isArray(ctx.chat) ? ctx.chat.slice(0, 1) : ctx.chat, dryRun: true }); for (const item of activatedEntries(result)) { const list = books.get(item.world) || []; list.push(item); books.set(item.world, list); } }
      catch { /* fallback is best effort and remains non-blocking */ }
    }
  }
  const foundEntries = [];
  for (const ref of refs) {
    if (unreadableWorlds.has(ref.world)) continue;
    const data = books instanceof Map ? books.get(ref.world) : null;
    const entries = Array.isArray(data) ? data : batchEntries(ref.world, data);
    const found = entries.find(entry => String(entry.uid) === ref.uid);
    if (!found) { warnings.push({ code: 'WORLDBOOK_ENTRY_MISSING', world: ref.world.slice(0, 120), uid: ref.uid.slice(0, 120) }); continue; }
    const fingerprint = `sha256:${await sha256(found.content)}`;
    foundEntries.push({ ref, found, fingerprint });
  }
  const mismatches = foundEntries.filter(item => item.fingerprint !== item.ref.fingerprint);
  let activatedFallback = null;
  if (mismatches.length && typeof ctx?.loadWorldInfoBatch === 'function' && typeof ctx?.simulateWorldInfoActivation === 'function') {
    try {
      const result = await ctx.simulateWorldInfoActivation({ coreChat: Array.isArray(ctx.chat) ? ctx.chat.slice(0, 1) : ctx.chat, dryRun: true });
      activatedFallback = new Map();
      for (const raw of activatedEntries(result)) {
        const part = entryParts(raw), key = `${part.world}\u0000${part.uid}`;
        const fingerprint = `sha256:${await sha256(part.content)}`;
        const previous = activatedFallback.get(key);
        if (previous && previous.fingerprint !== fingerprint) throw fail('ENTRY_INVALID');
        activatedFallback.set(key, { ...part, fingerprint });
      }
    } catch { activatedFallback = null; }
  }
  const output = [];
  for (const item of foundEntries) {
    if (item.fingerprint === item.ref.fingerprint) {
      output.push({ world: item.ref.world, uid: item.ref.uid, fingerprint: item.fingerprint, content: cleanAnalysisText(item.found.content) });
      continue;
    }
    const fallback = activatedFallback?.get(`${item.ref.world}\u0000${item.ref.uid}`);
    if (fallback?.fingerprint === item.ref.fingerprint) {
      output.push({ world: item.ref.world, uid: item.ref.uid, fingerprint: fallback.fingerprint, content: cleanAnalysisText(fallback.content) });
      continue;
    }
    warnings.push({ code: 'WORLDBOOK_VERSION_CHANGED', world: item.ref.world.slice(0, 120), uid: item.ref.uid.slice(0, 120) });
    output.push({ world: item.ref.world, uid: item.ref.uid, fingerprint: item.fingerprint, content: cleanAnalysisText(item.found.content) });
  }
  return { entries: output, warnings: warnings.slice(0, 80) };
}

function activatedEntries(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.activatedEntries)) return result.activatedEntries;
  throw fail('SCAN_RESULT_INVALID');
}

export function summarizeFrozenSourceDiagnostics(route, frozen) {
  const refs = Array.isArray(route?.worldInfoEntries) ? route.worldInfoEntries : [];
  const entries = Array.isArray(frozen?.sources?.worldInfoEntries) ? frozen.sources.worldInfoEntries : [];
  const warnings = Array.isArray(frozen?.warnings) ? frozen.warnings : [];
  const current = new Map(entries.map(entry => [`${entry?.world}\u0000${entry?.uid}`, entry]));
  let worldbookChanged = 0, absent = 0;
  for (const ref of refs) {
    const item = current.get(`${ref?.world}\u0000${ref?.uid}`);
    if (!item) absent += 1;
    else if (item.fingerprint !== ref.fingerprint) worldbookChanged += 1;
  }
  const warningCodes = warnings.map(item => String(item?.code || '')).filter(code => SOURCE_DIAGNOSTIC_CODES.has(code));
  const worldbookUnreadable = Math.min(absent, warnings.filter(item => item?.code === 'WORLDBOOK_READ_FAILED').reduce((total, item) => total + (Number.isInteger(item.count) && item.count > 0 ? item.count : 0), 0));
  const worldbookMissing = Math.max(0, absent - worldbookUnreadable);
  const greeting = warningCodes.includes('GREETING_CURRENT_UNAVAILABLE') ? 'unavailable'
    : warningCodes.includes('GREETING_VERSION_CHANGED') ? 'changed' : 'same';
  return {
    greeting,
    worldbookTotal: refs.length,
    worldbookChanged,
    worldbookMissing,
    worldbookUnreadable,
    codes: [...new Set(warningCodes)].slice(0, 8),
  };
}

export function createRouteSourceAdapter({ contextProvider } = {}) {
  if (typeof contextProvider !== 'function') throw new Error('路线来源宿主上下文不可用');
  return {
    async collect() {
      const ctx = contextProvider();
      const greeting = await normalizeGreeting(ctx);
      const scanner = ctx?.simulateWorldInfoActivation;
      if (typeof scanner !== 'function') throw fail('SCANNER_UNAVAILABLE');
      let result;
      try {
        result = await scanner.call(ctx, { coreChat: Array.isArray(ctx.chat) ? ctx.chat.slice(0, 1) : ctx.chat, dryRun: true });
      } catch {
        throw fail('SCAN_FAILED');
      }
      const worldInfoEntries = await routeWorldInfoEntries(ctx, activatedEntries(result));
      return { state: 'ready', greeting: { ...greeting, content: cleanAnalysisText(ctx.chat[0].mes) }, worldInfoEntries };
    },
    async collectAnalysisSources() { return collectAnalysisSources(contextProvider()); },
    async collectSourceCatalogCandidates() { return collectSourceCatalogCandidates(contextProvider()); },
    async collectFrozenAnalysisSources(route) {
      if (!route || route.state !== 'ready' || !Array.isArray(route.worldInfoEntries)) throw fail('ROUTE_INVALID');
      const ctx = contextProvider();
      const greeting = { ...route.greeting, content: typeof route.greeting.content === 'string' ? route.greeting.content : cleanAnalysisText(ctx?.chat?.[0]?.mes) };
      const warnings = [];
      try { const normalized = await normalizeGreeting(ctx); if (normalized.fingerprint !== route.greeting.fingerprint) warnings.push({ code: 'GREETING_VERSION_CHANGED' }); }
      catch { warnings.push({ code: 'GREETING_CURRENT_UNAVAILABLE', count: 1 }); }
      const result = await readFrozenEntries(ctx, route);
      const output = { status: 'ready', sources: { greeting, worldInfoEntries: result.entries }, warnings: [...warnings, ...result.warnings].slice(0, 80) };
      return { ...output, diagnostics: summarizeFrozenSourceDiagnostics(route, output) };
    },
  };
}

export function sameRouteSnapshot(a, b) {
  if (a?.state !== b?.state || a?.greeting?.floor !== b?.greeting?.floor || a?.greeting?.swipeId !== b?.greeting?.swipeId || a?.greeting?.fingerprint !== b?.greeting?.fingerprint) return false;
  const left = a?.worldInfoEntries; const right = b?.worldInfoEntries;
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((entry, index) => entry.world === right[index].world && entry.uid === right[index].uid && entry.fingerprint === right[index].fingerprint);
}
