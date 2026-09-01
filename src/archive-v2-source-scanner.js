import { sha256 } from './identity.js';

const LIMITS = Object.freeze({ books: 500, entries: 5000, contentCharacters: 40000 });
const SCOPE_ORDER = Object.freeze(['char', 'chat', 'persona', 'global']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function currentCharacter(ctx) {
  return Array.isArray(ctx?.characters) ? ctx.characters[ctx.characterId] : ctx?.characters?.[ctx.characterId];
}

function uniqueNames(values) {
  return [...new Set(values.map(text).filter(Boolean))].slice(0, LIMITS.books);
}

function linkedWorldNames(ctx) {
  const names = [];
  try {
    const books = globalThis.TavernHelper?.getCharLorebooks?.();
    if (books?.primary) names.push(books.primary);
    if (Array.isArray(books?.additional)) names.push(...books.additional);
  } catch { /* use host fallbacks */ }
  const character = currentCharacter(ctx) ?? {};
  names.push(character.data?.extensions?.world, character.extensions?.world);
  try {
    const filename = ctx?.getCharaFilename?.(ctx.characterId);
    const auxiliary = filename ? ctx?.getCharaAuxWorlds?.(filename) : [];
    if (Array.isArray(auxiliary)) names.push(...auxiliary);
  } catch { /* auxiliary worlds are optional */ }
  return uniqueNames(names);
}

function chatWorldNames(ctx) {
  const raw = ctx?.chatMetadata?.world_info;
  return uniqueNames(Array.isArray(raw) ? raw : [raw]);
}

function globalWorldNames(ctx) {
  try {
    const names = globalThis.TavernHelper?.getLorebookSettings?.()?.selected_global_lorebooks;
    if (Array.isArray(names)) return uniqueNames(names);
  } catch { /* use host fallbacks */ }
  if (Array.isArray(ctx?.chatWorldInfo?.globalSelection)) return uniqueNames(ctx.chatWorldInfo.globalSelection);
  if (Array.isArray(globalThis.world_info?.globalSelect)) return uniqueNames(globalThis.world_info.globalSelect);
  return [];
}

async function allWorldNames(ctx, known) {
  const fallback = [...known];
  if (Array.isArray(globalThis.world_names) && globalThis.world_names.length) return uniqueNames([...fallback, ...globalThis.world_names]);
  try {
    const cached = ctx?.getWorldInfoNames?.();
    if (Array.isArray(cached) && cached.length) return uniqueNames([...fallback, ...cached]);
  } catch { /* continue */ }
  try {
    const helper = globalThis.TavernHelper;
    const fn = helper?.getWorldbookNames ?? helper?.getLorebooks;
    if (typeof fn === 'function') {
      const result = await fn.call(helper);
      if (Array.isArray(result) && result.length) return uniqueNames([...fallback, ...result]);
    }
  } catch { /* continue */ }
  if (typeof ctx?.updateWorldInfoList === 'function') {
    try {
      await ctx.updateWorldInfoList();
      const refreshed = ctx?.getWorldInfoNames?.();
      if (Array.isArray(refreshed) && refreshed.length) return uniqueNames([...fallback, ...refreshed]);
    } catch { /* an empty exclusion catalog is a safe degradation */ }
  }
  return uniqueNames(fallback);
}

async function loadBooks(ctx, names, warnings) {
  const books = new Map();
  if (!names.length) return books;
  if (typeof ctx?.loadWorldInfoBatch === 'function') {
    try {
      const result = await ctx.loadWorldInfoBatch(names);
      if (result instanceof Map) for (const name of names) if (result.has(name)) books.set(name, result.get(name));
    } catch { warnings.push({ code: 'WORLDBOOK_BATCH_READ_FAILED' }); }
  }
  for (const name of names) {
    if (books.has(name) || typeof ctx?.loadWorldInfo !== 'function') continue;
    try {
      const result = await ctx.loadWorldInfo(name);
      if (result) books.set(name, result);
    } catch { warnings.push({ code: 'WORLDBOOK_READ_FAILED', book: name.slice(0, 120) }); }
  }
  return books;
}

function entryRows(data) {
  if (Array.isArray(data)) return data.map((entry, index) => [String(entry?.uid ?? entry?.id ?? index), entry]);
  const entries = data?.entries;
  return entries && typeof entries === 'object' ? Object.entries(entries) : [];
}

function activatedEntryParts(raw) {
  const entry = raw?.entry && typeof raw.entry === 'object' ? raw.entry : raw;
  const book = text(raw?.world ?? raw?.book ?? raw?.worldName ?? entry?.world ?? entry?.book ?? entry?.worldName);
  const rawUid = raw?.uid ?? raw?.id ?? entry?.uid ?? entry?.id;
  const uid = rawUid === undefined || rawUid === null ? '' : String(rawUid).trim();
  return book && uid ? `${book}::${uid}` : '';
}

async function activatedKeys(ctx, warnings) {
  if (typeof ctx?.simulateWorldInfoActivation !== 'function') return new Set();
  try {
    const result = await ctx.simulateWorldInfoActivation({ coreChat: Array.isArray(ctx.chat) ? ctx.chat.slice(0, 1) : [], dryRun: true });
    const values = Array.isArray(result) ? result : result?.activatedEntries;
    if (!Array.isArray(values)) throw new TypeError('activation result invalid');
    return new Set(values.map(activatedEntryParts).filter(Boolean));
  } catch {
    warnings.push({ code: 'WORLDBOOK_ACTIVATION_FAILED' });
    return new Set();
  }
}

function preparedEntry({ book, uid, entry, scope, embedded = false }) {
  if (!entry || typeof entry !== 'object') return null;
  const content = typeof entry.content === 'string' ? entry.content.slice(0, LIMITS.contentCharacters) : '';
  const rawId = entry.uid ?? entry.id ?? uid;
  const id = rawId === undefined || rawId === null ? '' : String(rawId).trim();
  if (!id) return null;
  const keys = Array.isArray(entry.key) ? entry.key.map(text).filter(Boolean).join('、') : text(entry.key);
  const label = text(entry.comment) || keys || `条目 ${id}`;
  const disabled = entry.disable === true || entry.disabled === true;
  return Object.freeze({
    key: `${book}::${id}`,
    uid: id,
    label: label.slice(0, 512),
    preview: content.replace(/\s+/g, ' ').slice(0, 160),
    content,
    source: book,
    scope,
    embedded,
    disabled,
    hostEnabled: !disabled,
  });
}

export async function scanArchiveV2WorldInfo(ctx) {
  if (!ctx || typeof ctx !== 'object') throw new TypeError('世界书扫描上下文无效');
  const warnings = [];
  const activated = await activatedKeys(ctx, warnings);
  const scopedNames = new Map([
    ['char', linkedWorldNames(ctx)],
    ['chat', chatWorldNames(ctx)],
    ['persona', uniqueNames([ctx?.powerUserSettings?.persona_description_lorebook])],
    ['global', globalWorldNames(ctx)],
  ]);
  const relevantNames = uniqueNames([...scopedNames.values()].flat());
  const books = await loadBooks(ctx, relevantNames, warnings);
  const entries = [];
  const seen = new Set();
  for (const scope of SCOPE_ORDER) {
    for (const book of scopedNames.get(scope) ?? []) {
      const data = books.get(book);
      for (const [uid, entry] of entryRows(data)) {
        const prepared = preparedEntry({ book, uid, entry, scope });
        if (!prepared || seen.has(prepared.key)) continue;
        seen.add(prepared.key);
        entries.push(Object.freeze({
          ...prepared,
          activated: activated.has(prepared.key),
          availability: prepared.hostEnabled ? (activated.has(prepared.key) ? 'activated' : 'enabled') : 'disabled',
        }));
        if (entries.length >= LIMITS.entries) break;
      }
      if (entries.length >= LIMITS.entries) break;
    }
    if (entries.length >= LIMITS.entries) break;
  }
  if (!entries.some(entry => entry.scope === 'char')) {
    const embedded = currentCharacter(ctx)?.data?.character_book;
    const book = text(embedded?.name) || '角色内置世界书';
    const rows = Array.isArray(embedded?.entries) ? embedded.entries.map((entry, index) => [String(index), entry]) : [];
    for (const [uid, entry] of rows) {
      const prepared = preparedEntry({ book, uid, entry, scope: 'char', embedded: true });
      if (!prepared || seen.has(prepared.key)) continue;
      seen.add(prepared.key);
      entries.push(Object.freeze({
        ...prepared,
        activated: activated.has(prepared.key),
        availability: prepared.hostEnabled ? (activated.has(prepared.key) ? 'activated' : 'enabled') : 'disabled',
      }));
      if (entries.length >= LIMITS.entries) break;
    }
  }
  const bookNames = await allWorldNames(ctx, [...relevantNames, ...entries.map(entry => entry.source)]);
  return Object.freeze({
    entries: Object.freeze(entries),
    bookNames: Object.freeze(bookNames),
    warnings: Object.freeze(warnings.slice(0, 40).map(warning => Object.freeze(warning))),
  });
}

export async function createArchiveV2WorldInfoSourceCandidates(catalog) {
  if (!catalog || !Array.isArray(catalog.entries)) throw new TypeError('世界书目录无效');
  return Promise.all(catalog.entries.map(async entry => Object.freeze({
    id: `worldbook:${entry.source}:${entry.uid}`,
    kind: 'worldbook',
    locator: `${entry.source}:${entry.uid}`,
    world: entry.source,
    uid: entry.uid,
    permissionKey: entry.key,
    fingerprint: `sha256:${await sha256(entry.content)}`,
    label: `${entry.source} · ${entry.label}`.slice(0, 240),
    content: entry.content,
    selected: true,
    availability: entry.availability === 'activated' ? 'activated' : (entry.hostEnabled === false ? 'disabled' : 'enabled'),
    activated: entry.activated === true,
    hostEnabled: entry.hostEnabled !== false,
    linked: true,
    scope: entry.scope,
  })));
}
