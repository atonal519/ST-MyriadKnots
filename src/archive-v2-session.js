import { ensureChatUuid, isUuid, readHostState } from './host-context.js';

export class ArchiveV2SessionError extends Error {
  constructor(message, code = 'ARCHIVE_V2_SESSION_INVALID') {
    super(message);
    this.name = 'ArchiveV2SessionError';
    this.code = code;
  }
}

const sameHost = (left, right) => left.hostChatId === right.hostChatId
  && left.characterAvatar === right.characterAvatar
  && left.personaAvatar === right.personaAvatar;

export function createArchiveV2Session({ contextProvider, isEnabled = true, ensureChatId = ensureChatUuid, identityCoordinator = null } = {}) {
  if (typeof contextProvider !== 'function') throw new TypeError('session contextProvider 必须是函数');
  if (typeof isEnabled !== 'boolean' && typeof isEnabled !== 'function') throw new TypeError('session isEnabled 无效');
  if (typeof ensureChatId !== 'function') throw new TypeError('session ensureChatId 必须是函数');
  if (identityCoordinator !== null && typeof identityCoordinator?.prepare !== 'function') throw new TypeError('session identityCoordinator 无效');

  let epoch = 0;
  let active = null;
  let state = Object.freeze({ status: 'idle' });
  const enabled = () => {
    try { return (typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true; }
    catch { return false; }
  };
  const capture = () => {
    let raw;
    let host;
    try {
      raw = contextProvider();
      host = readHostState(raw);
    } catch {
      throw new ArchiveV2SessionError('当前聊天身份不可用', 'ARCHIVE_V2_SESSION_CONTEXT_INVALID');
    }
    if (host?.ok !== true) throw new ArchiveV2SessionError(host?.reason || '当前聊天身份不可用', 'ARCHIVE_V2_SESSION_CONTEXT_INVALID');
    return { raw, host };
  };
  const publicIdentity = host => Object.freeze({
    hostChatId: host.hostChatId,
    chatId: host.chatId,
    characterLocator: host.characterAvatar,
    personaLocator: host.personaAvatar,
  });
  const currentFor = operation => {
    if (!enabled()) return 'disabled';
    if (operation.epoch !== epoch) return 'stale';
    try { return sameHost(operation.host, capture().host) ? 'current' : 'stale'; }
    catch { return 'stale'; }
  };

  function prepare() {
    if (!enabled()) {
      state = Object.freeze({ status: 'disabled' });
      return Promise.resolve(state);
    }
    let context;
    try { context = capture(); }
    catch (error) { return Promise.reject(error); }
    if (active && sameHost(active.host, context.host)) return active.promise;
    if (state.status === 'ready'
      && state.identity?.hostChatId === context.host.hostChatId
      && state.identity?.chatId === context.host.chatId
      && state.identity?.characterLocator === context.host.characterAvatar
      && state.identity?.personaLocator === context.host.personaAvatar) return Promise.resolve(state);
    if (isUuid(context.host.chatId) && !identityCoordinator) {
      state = Object.freeze({ status: 'ready', identity: publicIdentity(context.host) });
      return Promise.resolve(state);
    }
    const operation = { epoch, host: context.host };
    state = Object.freeze({ status: 'preparing' });
    operation.promise = (async () => {
      try {
        const chatId = identityCoordinator
          ? await identityCoordinator.prepare(context.raw, context.host)
          : await ensureChatId(context.raw, context.host);
        const current = currentFor(operation);
        if (current !== 'current') return Object.freeze({ status: current });
        const refreshed = capture().host;
        if (!isUuid(refreshed.chatId) || refreshed.chatId !== chatId) {
          throw new ArchiveV2SessionError('稳定 chatId 保存后未能读回', 'ARCHIVE_V2_SESSION_PERSIST_FAILED');
        }
        state = Object.freeze({ status: 'ready', identity: publicIdentity(refreshed) });
        return state;
      } catch (error) {
        const current = currentFor(operation);
        if (current !== 'current') return Object.freeze({ status: current });
        state = Object.freeze({ status: 'error', error });
        throw error;
      }
    })();
    active = operation;
    operation.promise.finally(() => { if (active === operation) active = null; }).catch(() => {});
    return operation.promise;
  }

  function identity() {
    if (!enabled()) throw new ArchiveV2SessionError('千千结已关闭', 'ARCHIVE_V2_SESSION_DISABLED');
    const host = capture().host;
    if (!isUuid(host.chatId)) throw new ArchiveV2SessionError('当前聊天尚未建立稳定 chatId', 'ARCHIVE_V2_SESSION_NOT_READY');
    if (identityCoordinator && (state.status !== 'ready'
      || state.identity?.chatId !== host.chatId
      || state.identity?.hostChatId !== host.hostChatId)) {
      throw new ArchiveV2SessionError('当前聊天身份尚未完成后端认领', 'ARCHIVE_V2_SESSION_NOT_READY');
    }
    return publicIdentity(host);
  }

  function invalidate() {
    epoch += 1;
    active = null;
    state = Object.freeze({ status: enabled() ? 'idle' : 'disabled' });
  }

  return Object.freeze({ prepare, identity, invalidate, getState: () => state });
}
