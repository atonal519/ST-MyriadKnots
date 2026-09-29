import { sha256 } from './identity.js';

const LIMITS = Object.freeze({ books: 500, entries: 5000, contentCharacters: 40000 });
const SCOPE_ORDER = Object.freeze(['char', 'chat', 'persona', 'global']);

function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function currentCharacter(ctx) { return Array.isArray(ctx?.characters) ? ctx.characters[ctx.characterId] : ctx?.characters?.[ctx.characterId]; }
function uniqueNames(values, { complete = false } = {}) {
  const names = [...new Set(values.map(text).filter(Boolean))];
  return complete ? names : names.slice(0, LIMITS.books);
}
function safeValue(callback, fallback = null) { try { return callback() ?? fallback; } catch { return fallback; } }

function characterFilename(ctx, character) {
  const hostName = safeValue(() => ctx?.getCharaFilename?.(ctx.characterId), '');
  if (text(hostName)) return text(hostName);
  return text(character?.avatar ?? character?.data?.avatar).replace(/\.[^.]+$/u, '');
}

function linkedWorldNames(ctx, bindings = {}, options = {}) {
  const names = [];
  const helperBooks = safeValue(() => globalThis.TavernHelper?.getCharLorebooks?.(), null);
  if (helperBooks?.primary) names.push(helperBooks.primary);
  if (Array.isArray(helperBooks?.additional)) names.push(...helperBooks.additional);
  const character = currentCharacter(ctx) ?? {};
  names.push(character.data?.extensions?.world, character.extensions?.world);
  const filename = characterFilename(ctx, character);
  const auxiliary = safeValue(() => ctx?.getCharaAuxWorlds?.(filename), null);
  if (Array.isArray(auxiliary)) names.push(...auxiliary);
  else {
    const settings = safeValue(() => bindings.getWorldInfoSettings?.(), null);
    const extra = settings?.charLore?.find?.(entry => text(entry?.name) === filename)?.extraBooks;
    if (Array.isArray(extra)) names.push(...extra);
  }
  return uniqueNames(names, options);
}

function chatWorldNames(ctx, options = {}) {
  const fromApi = safeValue(() => ctx?.chatWorldInfo?.getNames?.(), null);
  const raw = Array.isArray(fromApi) ? fromApi : ctx?.chatMetadata?.world_info;
  return uniqueNames(Array.isArray(raw) ? raw : [raw], options);
}

function globalWorldNames(ctx, bindings = {}, options = {}) {
  const helperNames = safeValue(() => globalThis.TavernHelper?.getLorebookSettings?.()?.selected_global_lorebooks, null);
  if (Array.isArray(helperNames)) return uniqueNames(helperNames, options);
  if (Array.isArray(ctx?.chatWorldInfo?.globalSelection)) return uniqueNames(ctx.chatWorldInfo.globalSelection, options);
  const moduleNames = safeValue(() => bindings.getSelectedWorldInfo?.(), null);
  return Array.isArray(moduleNames) ? uniqueNames(moduleNames, options) : [];
}

async function allWorldNames(ctx, bindings, known, options = {}) {
  const fallback = [...known];
  const moduleNames = safeValue(() => bindings.getWorldInfoNames?.(), null);
  if (Array.isArray(moduleNames) && moduleNames.length) return uniqueNames([...fallback, ...moduleNames], options);
  const cached = safeValue(() => ctx?.getWorldInfoNames?.(), null);
  if (Array.isArray(cached) && cached.length) return uniqueNames([...fallback, ...cached], options);
  const helper = globalThis.TavernHelper;
  try {
    const fn = helper?.getWorldbookNames ?? helper?.getLorebooks;
    const names = typeof fn === 'function' ? await fn.call(helper) : null;
    if (Array.isArray(names) && names.length) return uniqueNames([...fallback, ...names], options);
  } catch { /* use linked names */ }
  if (typeof ctx?.updateWorldInfoList === 'function') {
    try {
      await ctx.updateWorldInfoList();
      const refreshed = ctx?.getWorldInfoNames?.();
      if (Array.isArray(refreshed) && refreshed.length) return uniqueNames([...fallback, ...refreshed], options);
    } catch { /* an unavailable catalog does not change linked-source reads */ }
  }
  return uniqueNames(fallback, options);
}

function scopedWorldNames(ctx, bindings = {}, options = {}) {
  return new Map([
    ['char', linkedWorldNames(ctx, bindings, options)],
    ['chat', chatWorldNames(ctx, options)],
    ['persona', uniqueNames([ctx?.powerUserSettings?.persona_description_lorebook], options)],
    ['global', globalWorldNames(ctx, bindings, options)],
  ]);
}

export async function listWorldInfoBookNames(ctx, { bindings = {} } = {}) {
  if (!ctx || typeof ctx !== 'object') throw new TypeError('世界书扫描上下文无效');
  const scopedNames = scopedWorldNames(ctx, bindings);
  const embedded = currentCharacter(ctx)?.data?.character_book;
  const embeddedBook = text(embedded?.name) || '角色内置世界书';
  const embeddedRows = Array.isArray(embedded?.entries) ? embedded.entries : [];
  return Object.freeze(await allWorldNames(ctx, bindings, [
    ...[...scopedNames.values()].flat(),
    ...(embeddedRows.length ? [embeddedBook] : []),
  ]));
}

function sourceReadError(missing, warnings) {
  const error = new Error('关联世界书读取失败，本次 CSE 未发送。');
  error.code = 'V3_CSE_SOURCE_READ_FAILED';
  error.sourceDiagnostics = { missingBooks: missing.slice(0, 40), warnings: warnings.slice(0, 40) };
  return error;
}

async function loadBooks(ctx, bindings, names, warnings, strict) {
  const books = new Map();
  if (!names.length) return books;
  const batch = typeof ctx?.loadWorldInfoBatch === 'function' ? ctx.loadWorldInfoBatch.bind(ctx)
    : typeof bindings.loadWorldInfoBatch === 'function' ? bindings.loadWorldInfoBatch : null;
  const single = typeof ctx?.loadWorldInfo === 'function' ? ctx.loadWorldInfo.bind(ctx)
    : typeof bindings.loadWorldInfo === 'function' ? bindings.loadWorldInfo : null;
  if (batch) {
    try {
      const result = await batch(names);
      if (result instanceof Map) for (const name of names) { if (result.has(name) && result.get(name)) books.set(name, result.get(name)); }
      else if (result && typeof result === 'object') for (const name of names) { if (result[name]) books.set(name, result[name]); }
    } catch { warnings.push({ code: 'WORLDBOOK_BATCH_READ_FAILED' }); }
  }
  for (const name of names) {
    if (books.has(name) || !single) continue;
    try {
      const result = await single(name);
      if (result) books.set(name, result);
      else warnings.push({ code: 'WORLDBOOK_READ_EMPTY', book: name.slice(0, 120) });
    } catch { warnings.push({ code: 'WORLDBOOK_READ_FAILED', book: name.slice(0, 120) }); }
  }
  // CSE uses strict mode: every already-linked source must load before any of its material is sent.
  const missing = names.filter(name => !books.has(name));
  if (strict && missing.length) throw sourceReadError(missing, warnings);
  return books;
}

function entryRows(data) {
  if (Array.isArray(data)) return data.map((entry, index) => [String(entry?.uid ?? entry?.id ?? index), entry]);
  const entries = data?.entries;
  return entries && typeof entries === 'object' ? Object.entries(entries) : [];
}
function stringList(value) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return values.map(text).filter(Boolean);
}

function preparedEntry({ book, uid, entry, scope, embedded = false, complete = false }) {
  if (!entry || typeof entry !== 'object') return null;
  const rawContent = typeof entry.content === 'string' ? entry.content : '';
  const content = complete ? rawContent : rawContent.slice(0, LIMITS.contentCharacters);
  const rawId = entry.uid ?? entry.id ?? uid;
  const id = rawId === undefined || rawId === null ? '' : String(rawId).trim();
  if (!id) return null;
  const comment = text(entry.comment);
  const title = text(entry.title);
  const primaryKeys = stringList(entry.key ?? entry.keys);
  const secondaryKeys = stringList(entry.keysecondary ?? entry.secondary_keys);
  const label = comment || title || primaryKeys.join('、') || `条目 ${id}`;
  const disabled = entry.disable === true || entry.disabled === true || (embedded && entry.enabled === false);
  const extensions = entry.extensions && typeof entry.extensions === 'object' ? entry.extensions : {};
  return Object.freeze({
    key: `${book}::${id}`, uid: id, label: label.slice(0, 512), preview: content.replace(/\s+/g, ' ').slice(0, 160),
    // Display labels are bounded, but matching must still inspect both complete host fields independently.
    entryLabel: label.slice(0, 512), comment, title,
    content, source: book, scope, embedded, disabled, hostEnabled: !disabled, constant: entry.constant === true,
    primaryKeys: Object.freeze(primaryKeys), secondaryKeys: Object.freeze(secondaryKeys), selective: entry.selective === true,
    selectiveLogic: Number.isInteger(entry.selectiveLogic) ? entry.selectiveLogic : Number.isInteger(extensions.selectiveLogic) ? extensions.selectiveLogic : 0,
    caseSensitive: typeof entry.caseSensitive === 'boolean' ? entry.caseSensitive : typeof extensions.case_sensitive === 'boolean' ? extensions.case_sensitive : null,
    matchWholeWords: typeof entry.matchWholeWords === 'boolean' ? entry.matchWholeWords : typeof extensions.match_whole_words === 'boolean' ? extensions.match_whole_words : null,
  });
}

export async function scanWorldInfo(ctx, { bindings = {}, strict = false, complete = false, includeCatalog = true, filterBookNames = names => names } = {}) {
  if (!ctx || typeof ctx !== 'object') throw new TypeError('世界书扫描上下文无效');
  const warnings = [];
  // Full profile rebuilds opt into uncapped names and exact entry bodies; exceeding scanner limits fails visibly instead of yielding a partial source set.
  const scopedNames = scopedWorldNames(ctx, bindings, { complete });
  const relevantNames = uniqueNames([...scopedNames.values()].flat(), { complete });
  if (complete && relevantNames.length > LIMITS.books) {
    const error = new Error('关联世界书数量超过完整读取上限，本次人物资料未保存。');
    error.code = 'QQJ_PEOPLE_WORLDBOOK_INCOMPLETE';
    throw error;
  }
  const embedded = currentCharacter(ctx)?.data?.character_book;
  const embeddedBook = text(embedded?.name) || '角色内置世界书';
  const embeddedRows = Array.isArray(embedded?.entries) ? embedded.entries.map((entry, index) => [String(entry?.id ?? index), entry]) : [];
  const filteredNames = filterBookNames(uniqueNames([...relevantNames, ...(embeddedRows.length ? [embeddedBook] : [])], { complete }));
  if (!Array.isArray(filteredNames)) throw new TypeError('世界书整本过滤结果无效');
  const allowedBooks = new Set(uniqueNames(filteredNames, { complete }));
  if (complete && allowedBooks.size > LIMITS.books) {
    const error = new Error('关联世界书数量超过完整读取上限，本次人物资料未保存。');
    error.code = 'QQJ_PEOPLE_WORLDBOOK_INCOMPLETE';
    throw error;
  }
  for (const [scope, names] of scopedNames) scopedNames.set(scope, names.filter(name => allowedBooks.has(name)));
  const loadNames = relevantNames.filter(name => allowedBooks.has(name));
  let books;
  try {
    books = await loadBooks(ctx, bindings, loadNames, warnings, strict || complete);
  } catch (cause) {
    if (!complete) throw cause;
    const error = new Error('关联世界书读取不完整，本次人物资料未保存。', { cause });
    error.code = 'QQJ_PEOPLE_WORLDBOOK_INCOMPLETE';
    throw error;
  }
  const entries = [];
  const seen = new Set();
  for (const scope of SCOPE_ORDER) {
    for (const book of scopedNames.get(scope) ?? []) {
      for (const [uid, entry] of entryRows(books.get(book))) {
        const prepared = preparedEntry({ book, uid, entry, scope, complete });
        if (!prepared || seen.has(prepared.key)) continue;
        if (complete && entries.length >= LIMITS.entries) {
          const error = new Error('世界书条目数量超过完整读取上限，本次人物资料未保存。');
          error.code = 'QQJ_PEOPLE_WORLDBOOK_INCOMPLETE';
          throw error;
        }
        seen.add(prepared.key);
        entries.push(Object.freeze({ ...prepared, activated: false, availability: prepared.hostEnabled ? 'enabled' : 'disabled' }));
        if (!complete && entries.length >= LIMITS.entries) break;
      }
      if (!complete && entries.length >= LIMITS.entries) break;
    }
    if (!complete && entries.length >= LIMITS.entries) break;
  }
  for (const [uid, entry] of allowedBooks.has(embeddedBook) ? embeddedRows : []) {
    const prepared = preparedEntry({ book: embeddedBook, uid, entry, scope: 'char', embedded: true, complete });
    if (!prepared || seen.has(prepared.key)) continue;
    if (complete && entries.length >= LIMITS.entries) {
      const error = new Error('世界书条目数量超过完整读取上限，本次人物资料未保存。');
      error.code = 'QQJ_PEOPLE_WORLDBOOK_INCOMPLETE';
      throw error;
    }
    seen.add(prepared.key);
    entries.push(Object.freeze({ ...prepared, activated: false, availability: prepared.hostEnabled ? 'enabled' : 'disabled' }));
    if (!complete && entries.length >= LIMITS.entries) break;
  }
  const bookNames = includeCatalog ? await allWorldNames(ctx, bindings, [...loadNames, ...entries.map(entry => entry.source)], { complete }) : uniqueNames([...loadNames, ...entries.map(entry => entry.source)], { complete });
  return Object.freeze({
    entries: Object.freeze(entries), bookNames: Object.freeze(bookNames),
    warnings: Object.freeze(warnings.slice(0, 40).map(warning => Object.freeze(warning))),
    defaults: Object.freeze({
      caseSensitive: safeValue(() => bindings.getDefaultCaseSensitive?.(), false) === true,
      matchWholeWords: safeValue(() => bindings.getDefaultMatchWholeWords?.(), false) === true,
    }),
  });
}

export async function createWorldInfoSourceCandidates(catalog) {
  if (!catalog || !Array.isArray(catalog.entries)) throw new TypeError('世界书目录无效');
  return Promise.all(catalog.entries.map(async entry => Object.freeze({
    id: `worldbook:${entry.source}:${entry.uid}`, kind: 'worldbook', locator: `${entry.source}:${entry.uid}`,
    world: entry.source, uid: entry.uid, permissionKey: entry.key, fingerprint: `sha256:${await sha256(entry.content)}`,
    label: `${entry.source} · ${entry.label}`.slice(0, 240), entryLabel: entry.entryLabel ?? entry.label,
    comment: entry.comment ?? '', title: entry.title ?? '', content: entry.content, selected: true,
    primaryKeys: entry.primaryKeys, secondaryKeys: entry.secondaryKeys,
    availability: entry.hostEnabled === false ? 'disabled' : 'enabled', activated: false, hostEnabled: entry.hostEnabled !== false, linked: true, scope: entry.scope,
  })));
}
