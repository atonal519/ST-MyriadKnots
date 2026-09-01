import { isUuid, readHostState } from './host-context.js';
import { scanArchiveV2WorldInfo } from './archive-v2-source-scanner.js';

const LIMITS = Object.freeze({ chats: 2000, disabledPerChat: 20000, overridesPerChat: 20000, excludedBooks: 2000, keyCharacters: 1200 });

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function canonical(value) {
  return text(value).normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('zh-Hans-CN');
}

function uniqueStrings(value, limit) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(text).filter(item => item && item.length <= LIMITS.keyCharacters))].slice(0, limit);
}

function normalizedDisabledByChat(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output = {};
  for (const [chatId, keys] of Object.entries(value).slice(0, LIMITS.chats)) {
    if (!isUuid(chatId)) continue;
    output[chatId] = uniqueStrings(keys, LIMITS.disabledPerChat);
  }
  return output;
}

function normalizedConfirmedChats(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output = {};
  for (const [chatId, confirmed] of Object.entries(value).slice(0, LIMITS.chats)) {
    if (isUuid(chatId) && confirmed === true) output[chatId] = true;
  }
  return output;
}

function normalizedOverridesByChat(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output = {};
  for (const [chatId, overrides] of Object.entries(value).slice(0, LIMITS.chats)) {
    if (!isUuid(chatId) || !overrides || typeof overrides !== 'object' || Array.isArray(overrides)) continue;
    const safe = {};
    for (const [key, allowed] of Object.entries(overrides).slice(0, LIMITS.overridesPerChat)) {
      const normalizedKey = text(key);
      if (normalizedKey && normalizedKey.length <= LIMITS.keyCharacters && typeof allowed === 'boolean') safe[normalizedKey] = allowed;
    }
    output[chatId] = safe;
  }
  return output;
}

export function normalizeArchiveV2SourcePermissionSettings(settings) {
  return {
    disabledByChat: normalizedDisabledByChat(settings?.sourceWorldInfoDisabledByChat),
    overridesByChat: normalizedOverridesByChat(settings?.sourceWorldInfoOverridesByChat),
    excludedBooks: uniqueStrings(settings?.sourceWorldInfoExcludedBooks, LIMITS.excludedBooks),
    confirmedChats: normalizedConfirmedChats(settings?.sourceWorldInfoConfirmedChats),
  };
}

function candidateHostEnabled(candidate) {
  return candidate?.hostEnabled !== false && candidate?.availability !== 'disabled';
}

function entryAllowed(permission, chatId, key, hostEnabled = true, legacyDisabled = null) {
  const overrides = permission.overridesByChat[chatId] ?? {};
  if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key] === true;
  if ((legacyDisabled ?? new Set(permission.disabledByChat[chatId] ?? [])).has(key)) return false;
  return hostEnabled === true;
}

function candidatePermissionKey(candidate) {
  const explicit = text(candidate?.permissionKey);
  if (explicit) return explicit;
  const world = text(candidate?.world);
  const uid = text(candidate?.uid);
  if (world && uid) return `${world}::${uid}`;
  const locator = text(candidate?.locator);
  const split = locator.lastIndexOf(':');
  return split > 0 ? `${locator.slice(0, split)}::${locator.slice(split + 1)}` : '';
}

function candidateBook(candidate) {
  const world = text(candidate?.world);
  if (world) return world;
  const key = candidatePermissionKey(candidate);
  const split = key.lastIndexOf('::');
  return split > 0 ? key.slice(0, split) : '';
}

export function filterArchiveV2SourcesByPermission({ candidates, chatId, settings } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!isUuid(chatId)) return list.filter(candidate => candidate?.kind !== 'worldbook');
  const permission = normalizeArchiveV2SourcePermissionSettings(settings);
  const excluded = new Set(permission.excludedBooks.map(canonical));
  const legacyDisabled = new Set(permission.disabledByChat[chatId] ?? []);
  return list.filter(candidate => {
    if (candidate?.kind !== 'worldbook') return true;
    const key = candidatePermissionKey(candidate);
    const book = candidateBook(candidate);
    return Boolean(key && book)
      && !excluded.has(canonical(book))
      && entryAllowed(permission, chatId, key, candidateHostEnabled(candidate), legacyDisabled);
  });
}

export function createArchiveV2SourcePermissionController({
  settings,
  contextProvider,
  scanner = scanArchiveV2WorldInfo,
} = {}) {
  if (typeof settings?.get !== 'function' || typeof settings?.update !== 'function') throw new TypeError('来源许可 settings 无效');
  if (typeof contextProvider !== 'function') throw new TypeError('来源许可 contextProvider 无效');
  if (typeof scanner !== 'function') throw new TypeError('来源许可 scanner 无效');

  const identity = () => {
    const raw = contextProvider();
    const host = readHostState(raw);
    if (!host.ok || !isUuid(host.chatId)) throw new Error('当前聊天稳定身份不可用');
    return { raw, chatId: host.chatId, hostChatId: host.hostChatId };
  };
  const permissionSnapshot = () => typeof settings.sourcePermissionSnapshot === 'function'
    ? settings.sourcePermissionSnapshot()
    : settings.get();
  const permission = () => normalizeArchiveV2SourcePermissionSettings(permissionSnapshot());
  const write = next => settings.update({
    sourceWorldInfoDisabledByChat: next.disabledByChat,
    sourceWorldInfoOverridesByChat: next.overridesByChat,
    sourceWorldInfoConfirmedChats: next.confirmedChats,
  });

  function isCurrentConfirmed() {
    try { return permission().confirmedChats[identity().chatId] === true; }
    catch { return false; }
  }

  function confirmCurrent() {
    const { chatId } = identity();
    const next = permission();
    next.confirmedChats[chatId] = true;
    write(next);
    return { chatId, confirmed: true };
  }

  function setEntryAllowed(key, allowed) {
    const { chatId } = identity();
    const entryKey = text(key);
    if (!entryKey || entryKey.length > LIMITS.keyCharacters) throw new TypeError('世界书条目键无效');
    const next = permission();
    const overrides = { ...(next.overridesByChat[chatId] ?? {}) };
    overrides[entryKey] = allowed === true;
    next.overridesByChat[chatId] = Object.fromEntries(Object.entries(overrides).slice(-LIMITS.overridesPerChat));
    write(next);
  }

  function setEntriesAllowed(states) {
    const { chatId } = identity();
    if (!Array.isArray(states)) throw new TypeError('世界书条目选择无效');
    const next = permission();
    const overrides = { ...(next.overridesByChat[chatId] ?? {}) };
    for (const state of states) {
      const key = text(state?.key);
      if (!key || key.length > LIMITS.keyCharacters) continue;
      overrides[key] = state.allowed === true;
    }
    next.overridesByChat[chatId] = Object.fromEntries(Object.entries(overrides).slice(-LIMITS.overridesPerChat));
    write(next);
  }

  function setBookExcluded(bookName, excluded) {
    const name = text(bookName);
    if (!name || name.length > LIMITS.keyCharacters) throw new TypeError('世界书名称无效');
    if (typeof settings.setSharedWorldInfoExcluded === 'function') {
      settings.setSharedWorldInfoExcluded(name, excluded === true);
      return;
    }
    const next = permission();
    next.excludedBooks = next.excludedBooks.filter(item => canonical(item) !== canonical(name));
    if (excluded === true) next.excludedBooks.push(name);
    settings.update({ sourceWorldInfoExcludedBooks: next.excludedBooks });
  }

  function filterCandidates({ chatId, candidates } = {}) {
    return filterArchiveV2SourcesByPermission({ candidates, chatId, settings: permissionSnapshot() });
  }

  async function inspectCurrent() {
    const start = identity();
    const scanned = await scanner(start.raw);
    const end = identity();
    if (start.chatId !== end.chatId || start.hostChatId !== end.hostChatId) return { status: 'stale' };
    const current = permission();
    const excluded = new Set(current.excludedBooks.map(canonical));
    const entries = scanned.entries.filter(entry => !excluded.has(canonical(entry.source)));
    const legacyDisabled = new Set(current.disabledByChat[start.chatId] ?? []);
    const allowedEntries = entries.filter(entry => entryAllowed(current, start.chatId, entry.key, entry.hostEnabled !== false, legacyDisabled));
    const seenBooks = new Set();
    const bookNames = [...scanned.bookNames, ...current.excludedBooks].filter(name => {
      const key = canonical(name);
      if (!key || seenBooks.has(key)) return false;
      seenBooks.add(key);
      return true;
    });
    return Object.freeze({
      status: 'ready',
      chatId: start.chatId,
      confirmed: current.confirmedChats[start.chatId] === true,
      entries,
      allowedKeys: Object.freeze(allowedEntries.map(entry => entry.key)),
      disabledKeys: Object.freeze([...(current.disabledByChat[start.chatId] ?? [])]),
      entryOverrides: Object.freeze({ ...(current.overridesByChat[start.chatId] ?? {}) }),
      excludedBooks: Object.freeze([...current.excludedBooks]),
      bookNames: Object.freeze(bookNames),
      warnings: scanned.warnings,
      stats: Object.freeze({
        books: new Set(allowedEntries.map(entry => entry.source)).size,
        entries: allowedEntries.length,
        characters: allowedEntries.reduce((sum, entry) => sum + entry.content.length, 0),
      }),
    });
  }

  return Object.freeze({
    inspectCurrent,
    isCurrentConfirmed,
    confirmCurrent,
    setEntryAllowed,
    setEntriesAllowed,
    setBookExcluded,
    filterCandidates,
    currentChatId: () => identity().chatId,
  });
}
