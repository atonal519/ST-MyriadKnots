import { isUuid, readHostState } from './host-context.js';
import { listWorldInfoBookNames } from './world-info-scanner.js';

const LIMITS = Object.freeze({ excludedBooks: 2000, keyCharacters: 1200 });

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

export function normalizeSourcePermissionSettings(settings) {
  return {
    excludedBooks: uniqueStrings(settings?.sourceWorldInfoExcludedBooks, LIMITS.excludedBooks),
  };
}

function candidateHostEnabled(candidate) {
  return candidate?.hostEnabled !== false && candidate?.availability !== 'disabled';
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

export function filterSourcesByPermission({ candidates, settings } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const permission = normalizeSourcePermissionSettings(settings);
  const excluded = new Set(permission.excludedBooks.map(canonical));
  return list.filter(candidate => {
    if (candidate?.kind !== 'worldbook') return true;
    const book = candidateBook(candidate);
    return Boolean(book)
      && candidateHostEnabled(candidate)
      && !excluded.has(canonical(book));
  });
}

export function filterWorldInfoSourcesByPermission({ sources, settings } = {}) {
  const list = Array.isArray(sources) ? sources : [];
  const permission = normalizeSourcePermissionSettings(settings);
  const excluded = new Set(permission.excludedBooks.map(canonical));
  if (!excluded.size) return list;
  return list.filter(source => !excluded.has(canonical(source?.sourceName)));
}

export function createSourcePermissionController({
  settings,
  contextProvider,
  bookNamesProvider = listWorldInfoBookNames,
} = {}) {
  if (typeof settings?.get !== 'function' || typeof settings?.update !== 'function') throw new TypeError('来源许可 settings 无效');
  if (typeof contextProvider !== 'function') throw new TypeError('来源许可 contextProvider 无效');
  if (typeof bookNamesProvider !== 'function') throw new TypeError('来源许可书名目录依赖无效');

  const identity = () => {
    const raw = contextProvider();
    const host = readHostState(raw);
    if (!host.ok || !isUuid(host.chatId)) throw new Error('当前聊天稳定身份不可用');
    return { raw, chatId: host.chatId, hostChatId: host.hostChatId };
  };
  const permissionSnapshot = () => typeof settings.sourcePermissionSnapshot === 'function'
    ? settings.sourcePermissionSnapshot()
    : settings.get();
  const permission = () => normalizeSourcePermissionSettings(permissionSnapshot());

  function setBookExcluded(bookName, excluded) {
    const name = text(bookName);
    if (!name || name.length > LIMITS.keyCharacters) throw new TypeError('世界书名称无效');
    if (typeof settings.setSharedWorldInfoExcluded === 'function') {
      return settings.setSharedWorldInfoExcluded(name, excluded === true);
    }
    const next = permission();
    next.excludedBooks = next.excludedBooks.filter(item => canonical(item) !== canonical(name));
    if (excluded === true) next.excludedBooks.push(name);
    settings.update({ sourceWorldInfoExcludedBooks: next.excludedBooks });
    return [...next.excludedBooks];
  }

  function filterCandidates({ chatId, candidates } = {}) {
    return filterSourcesByPermission({ candidates, chatId, settings: permissionSnapshot() });
  }

  function filterWorldInfoSources(sources) {
    return filterWorldInfoSourcesByPermission({ sources, settings: permissionSnapshot() });
  }

  async function inspectCurrent() {
    const start = identity();
    const names = await bookNamesProvider(start.raw);
    const end = identity();
    if (start.chatId !== end.chatId || start.hostChatId !== end.hostChatId) return { status: 'stale' };
    const current = permission();
    const seenBooks = new Set();
    const bookNames = names.filter(name => {
      const key = canonical(name);
      if (!key || seenBooks.has(key)) return false;
      seenBooks.add(key);
      return true;
    });
    return Object.freeze({
      status: 'ready',
      chatId: start.chatId,
      excludedBooks: Object.freeze([...current.excludedBooks]),
      bookNames: Object.freeze(bookNames),
    });
  }

  return Object.freeze({
    inspectCurrent,
    setBookExcluded,
    filterCandidates,
    filterWorldInfoSources,
  });
}
