import { sha256 } from './identity.js';

export const ROUTE_DIAGNOSTICS = Object.freeze(['GREETING_INVALID', 'SCANNER_UNAVAILABLE', 'SCAN_FAILED', 'SCAN_RESULT_INVALID', 'ENTRY_INVALID', 'ROUTE_INVALID', 'UNKNOWN']);
const fail = diagnosticCode => Object.assign(new Error('路线来源不可用'), { failClosed: true, diagnosticCode });
export const compareRouteKey = (a, b) => a === b ? 0 : (a < b ? -1 : 1);

const text = (value, diagnosticCode) => {
  if (typeof value !== 'string') throw fail(diagnosticCode);
  return value;
};

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
  if (!first || first.is_user === true || (first.is_system === true && !ejsSystem) || typeof first.mes !== 'string') throw fail('GREETING_INVALID');
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

function batchEntries(world, data) {
  const values = data?.entries && typeof data.entries === 'object' ? Object.entries(data.entries) : [];
  return values.map(([uid, entry]) => ({ world, uid: entry?.uid ?? entry?.id ?? uid, content: entry?.content })).filter(entry => entry.uid !== undefined && typeof entry.content === 'string');
}

async function readFrozenEntries(ctx, route) {
  const refs = route.worldInfoEntries;
  const warnings = [];
  const worlds = [...new Set(refs.map(entry => entry.world))];
  let books;
  if (typeof ctx?.loadWorldInfoBatch === 'function') {
    try { books = await ctx.loadWorldInfoBatch(worlds); }
    catch { books = new Map(worlds.map(world => [world, null])); warnings.push({ code: 'WORLDBOOK_READ_FAILED', count: worlds.length }); }
  } else {
    warnings.push({ code: 'WORLDBOOK_BATCH_UNAVAILABLE', count: refs.length });
    books = new Map();
    if (typeof ctx?.simulateWorldInfoActivation === 'function') {
      try { const result = await ctx.simulateWorldInfoActivation({ coreChat: Array.isArray(ctx.chat) ? ctx.chat.slice(0, 1) : ctx.chat, dryRun: true }); for (const item of activatedEntries(result)) { const list = books.get(item.world) || []; list.push(item); books.set(item.world, list); } }
      catch { /* fallback is best effort and remains non-blocking */ }
    }
  }
  const output = [];
  for (const ref of refs) {
    const data = books instanceof Map ? books.get(ref.world) : null;
    const entries = Array.isArray(data) ? data : batchEntries(ref.world, data);
    const found = entries.find(entry => String(entry.uid) === ref.uid);
    if (!found) { warnings.push({ code: 'WORLDBOOK_ENTRY_MISSING', world: ref.world.slice(0, 120), uid: ref.uid.slice(0, 120) }); continue; }
    const fingerprint = `sha256:${await sha256(found.content)}`;
    if (fingerprint !== ref.fingerprint) warnings.push({ code: 'WORLDBOOK_VERSION_CHANGED', world: ref.world.slice(0, 120), uid: ref.uid.slice(0, 120) });
    output.push({ world: ref.world, uid: ref.uid, fingerprint, content: cleanAnalysisText(found.content) });
  }
  return { entries: output, warnings: warnings.slice(0, 80) };
}

function activatedEntries(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.activatedEntries)) return result.activatedEntries;
  throw fail('SCAN_RESULT_INVALID');
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
      const worldInfoEntries = await normalizeWorldInfoEntries(activatedEntries(result));
      return { state: 'ready', greeting: { ...greeting, content: cleanAnalysisText(ctx.chat[0].mes) }, worldInfoEntries };
    },
    async collectAnalysisSources() { return collectAnalysisSources(contextProvider()); },
    async collectFrozenAnalysisSources(route) {
      if (!route || route.state !== 'ready' || !Array.isArray(route.worldInfoEntries)) throw fail('ROUTE_INVALID');
      const ctx = contextProvider();
      const greeting = { ...route.greeting, content: typeof route.greeting.content === 'string' ? route.greeting.content : cleanAnalysisText(ctx?.chat?.[0]?.mes) };
      const warnings = [];
      try { const normalized = await normalizeGreeting(ctx); if (normalized.fingerprint !== route.greeting.fingerprint) warnings.push({ code: 'GREETING_VERSION_CHANGED' }); }
      catch { warnings.push({ code: 'GREETING_CURRENT_UNAVAILABLE', count: 1 }); }
      const result = await readFrozenEntries(ctx, route);
      return { status: 'ready', sources: { greeting, worldInfoEntries: result.entries }, warnings: [...warnings, ...result.warnings].slice(0, 80) };
    },
  };
}

export function sameRouteSnapshot(a, b) {
  if (a?.state !== b?.state || a?.greeting?.floor !== b?.greeting?.floor || a?.greeting?.swipeId !== b?.greeting?.swipeId || a?.greeting?.fingerprint !== b?.greeting?.fingerprint) return false;
  const left = a?.worldInfoEntries; const right = b?.worldInfoEntries;
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((entry, index) => entry.world === right[index].world && entry.uid === right[index].uid && entry.fingerprint === right[index].fingerprint);
}
