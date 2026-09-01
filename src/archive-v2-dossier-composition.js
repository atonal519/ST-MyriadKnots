import { createArchiveV2Adapter } from './archive-v2.js';
import { isUuid, readHostState } from './host-context.js';

export const ARCHIVE_V2_DOSSIER_FIELD_KEYS = Object.freeze([
  'gender',
  'age',
  'appearance',
  'personality',
  'identity',
  'abilities',
  'likes',
  'dislikes',
  'principles',
  'relationships',
  'nsfwPreferences',
]);

const FIELD_KEYS = new Set(ARCHIVE_V2_DOSSIER_FIELD_KEYS);

export class ArchiveV2DossierCompositionError extends Error {
  constructor(message, code = 'ARCHIVE_V2_DOSSIER_INVALID') {
    super(message);
    this.name = 'ArchiveV2DossierCompositionError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new ArchiveV2DossierCompositionError(message, code);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameIdentity(left, right) {
  return left.hostChatId === right.hostChatId
    && left.chatId === right.chatId
    && left.characterLocator === right.characterLocator
    && left.personaLocator === right.personaLocator;
}

function userOwned(value) {
  return { value, origin: 'user', sourceRefs: [], userProtected: true };
}

export function createArchiveV2DossierComposition({ client, contextProvider, isEnabled = true } = {}) {
  if (typeof client?.get !== 'function' || typeof client?.put !== 'function') {
    throw new TypeError('dossier client 必须提供 get 和 put');
  }
  if (typeof contextProvider !== 'function') throw new TypeError('dossier contextProvider 必须是函数');
  if (typeof isEnabled !== 'boolean' && typeof isEnabled !== 'function') throw new TypeError('dossier isEnabled 无效');

  let epoch = 0;
  let activeMutation = null;
  let state = Object.freeze({ status: 'idle' });
  const enabled = () => {
    try { return (typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true; }
    catch { return false; }
  };

  function normalizedIdentity() {
    let host;
    try { host = readHostState(contextProvider()); }
    catch { fail('当前聊天身份不可用', 'ARCHIVE_V2_DOSSIER_CONTEXT_INVALID'); }
    if (host?.ok !== true || !isUuid(host.chatId)) {
      fail('当前聊天身份不可用', 'ARCHIVE_V2_DOSSIER_CONTEXT_INVALID');
    }
    return Object.freeze({
      hostChatId: host.hostChatId,
      chatId: host.chatId,
      characterLocator: host.characterAvatar,
      personaLocator: host.personaAvatar,
    });
  }

  const archiveAdapter = createArchiveV2Adapter({
    client,
    contextProvider: () => ({ ...normalizedIdentity() }),
    isEnabled,
  });

  function operationFor(identity) {
    const operation = { epoch, identity, controller: new AbortController() };
    operation.status = () => enabled() ? 'stale' : 'disabled';
    operation.current = () => {
      if (operation.epoch !== epoch || operation.controller.signal.aborted || !enabled()) return false;
      try { return sameIdentity(identity, normalizedIdentity()); }
      catch { return false; }
    };
    return operation;
  }

  function publicState(result) {
    state = Object.freeze(result && typeof result === 'object' ? { ...result } : { status: 'error' });
    return state;
  }

  async function inspect() {
    if (!enabled()) return publicState({ status: 'disabled' });
    const result = await archiveAdapter.read();
    return publicState(result);
  }

  function mutation(run) {
    if (activeMutation) return Promise.resolve({ status: 'busy' });
    if (!enabled()) return Promise.resolve(publicState({ status: 'disabled' }));
    let identity;
    try { identity = normalizedIdentity(); }
    catch (error) { return Promise.reject(error); }
    const operation = operationFor(identity);
    state = Object.freeze({ status: 'saving' });
    operation.promise = (async () => {
      try {
        const current = await archiveAdapter.read();
        if (!operation.current()) return publicState({ status: operation.status() });
        if (current?.status !== 'ready') return publicState({ status: current?.status ?? 'error' });
        const prepared = run(current);
        if (!prepared.changed) return publicState({ ...current, status: 'ready', changed: false });
        const saved = await archiveAdapter.save({
          archive: prepared.archive,
          expectedRevision: current.revision,
          signal: operation.controller.signal,
        });
        if (!operation.current()) return publicState({ status: operation.status() });
        if (saved?.status !== 'saved') return publicState({ status: saved?.status ?? 'error' });
        return publicState({ ...saved, changed: true, identityId: prepared.identityId });
      } catch (error) {
        if (!operation.current()) return publicState({ status: operation.status() });
        state = Object.freeze({ status: 'error' });
        throw error;
      }
    })();
    activeMutation = operation;
    operation.promise.finally(() => {
      if (activeMutation === operation) activeMutation = null;
    }).catch(() => {});
    return operation.promise;
  }

  function updatePerson({ identityId, displayName, fields } = {}) {
    if (typeof identityId !== 'string' || !identityId) fail('人物 identityId 无效');
    if (displayName !== undefined && (typeof displayName !== 'string' || !displayName.trim())) {
      fail('人物姓名不能为空', 'ARCHIVE_V2_DOSSIER_NAME_INVALID');
    }
    if (fields !== undefined && !isPlainObject(fields)) fail('人设字段无效');
    const incomingFields = fields ?? {};
    for (const [key, value] of Object.entries(incomingFields)) {
      if (!FIELD_KEYS.has(key) || typeof value !== 'string') fail('人设字段无效');
    }
    return mutation(current => {
      const person = current.archive.people.byId[identityId];
      if (!person) fail('人物已不存在', 'ARCHIVE_V2_DOSSIER_PERSON_MISSING');
      let changed = false;
      if (displayName !== undefined && person.displayName?.value !== displayName.trim()) {
        person.displayName = userOwned(displayName.trim());
        changed = true;
      }
      person.fields ??= {};
      for (const [key, value] of Object.entries(incomingFields)) {
        if (person.fields[key]?.value === value) continue;
        person.fields[key] = userOwned(value);
        changed = true;
      }
      return { archive: current.archive, changed, identityId };
    });
  }

  function renamePerson({ identityId, displayName } = {}) {
    return updatePerson({ identityId, displayName });
  }

  function setFollowed({ identityId, followed } = {}) {
    if (typeof identityId !== 'string' || !identityId || typeof followed !== 'boolean') {
      fail('人物关注状态无效');
    }
    return mutation(current => {
      const person = current.archive.people.byId[identityId];
      if (!person) fail('人物已不存在', 'ARCHIVE_V2_DOSSIER_PERSON_MISSING');
      const changed = person.followed !== followed;
      if (changed) person.followed = followed;
      return { archive: current.archive, changed, identityId };
    });
  }

  function invalidate() {
    epoch += 1;
    activeMutation?.controller.abort();
    archiveAdapter.invalidate();
    state = Object.freeze({ status: enabled() ? 'idle' : 'disabled' });
  }

  return Object.freeze({
    inspect,
    updatePerson,
    renamePerson,
    setFollowed,
    getState: () => state,
    invalidate,
  });
}
