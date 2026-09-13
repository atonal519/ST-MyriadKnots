import { ensureChatUuid, isUuid, readHostState } from './host-context.js';

export class ChatSessionError extends Error {
  constructor(message, code = 'CHAT_SESSION_INVALID') {
    super(message);
    this.name = 'ChatSessionError';
    this.code = code;
  }
}

const sameHost = (left, right) => left.hostChatId === right.hostChatId
  && left.characterAvatar === right.characterAvatar
  && left.personaAvatar === right.personaAvatar;

export function createChatSession({ contextProvider, isEnabled = true, ensureChatId = ensureChatUuid, identityCoordinator = null } = {}) {
  if (typeof contextProvider !== 'function') throw new TypeError('session contextProvider 必须是函数');
  if (typeof isEnabled !== 'boolean' && typeof isEnabled !== 'function') throw new TypeError('session isEnabled 无效');
  if (typeof ensureChatId !== 'function') throw new TypeError('session ensureChatId 必须是函数');
  if (identityCoordinator !== null && typeof identityCoordinator?.prepare !== 'function') throw new TypeError('session identityCoordinator 无效');

  let epoch = 0;
  let active = null;
  let suspension = null;
  let state = Object.freeze({ status: 'idle' });
  const enabled = () => {
    try { return (typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true; }
    catch { return false; }
  };
  const capture = ({ allowNoChat = false } = {}) => {
    let raw;
    let host;
    try {
      raw = contextProvider();
      host = readHostState(raw);
    } catch {
      throw new ChatSessionError('当前聊天身份不可用', 'CHAT_SESSION_CONTEXT_INVALID');
    }
    if (host?.ok !== true && !(allowNoChat && host?.noChat === true)) {
      throw new ChatSessionError(host?.reason || '当前聊天身份不可用', 'CHAT_SESSION_CONTEXT_INVALID');
    }
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
    if (operation.epoch !== epoch || operation.controller?.signal.aborted) return 'stale';
    try { return sameHost(operation.host, capture().host) ? 'current' : 'stale'; }
    catch { return 'stale'; }
  };

  function prepare() {
    if (!enabled()) {
      state = Object.freeze({ status: 'disabled' });
      return Promise.resolve(state);
    }
    let context;
    try { context = capture({ allowNoChat: true }); }
    catch (error) { return Promise.reject(error); }
    if (context.host.noChat === true) {
      state = Object.freeze({ status: 'idle' });
      return Promise.resolve(state);
    }
    if (suspension) {
      if (sameHost(suspension.host, context.host) && context.host.chatId === suspension.identity.chatId) {
        state = Object.freeze({ status: 'suspended', identity: suspension.identity });
        return Promise.resolve(state);
      }
    }
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
    const operation = { epoch, host: context.host, controller: new AbortController() };
    state = Object.freeze({ status: 'preparing' });
    operation.promise = (async () => {
      try {
        const chatId = identityCoordinator
          ? await identityCoordinator.prepare(context.raw, context.host, { signal: operation.controller.signal })
          : await ensureChatId(context.raw, context.host);
        const current = currentFor(operation);
        if (current !== 'current') return Object.freeze({ status: current });
        const refreshed = capture().host;
        if (!isUuid(refreshed.chatId) || refreshed.chatId !== chatId) {
          throw new ChatSessionError('稳定 chatId 保存后未能读回', 'CHAT_SESSION_PERSIST_FAILED');
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

  function rename(event, previousIdentity, preparedIdentity) {
    if (!enabled()) return Promise.resolve(Object.freeze({ status: 'disabled' }));
    if (typeof identityCoordinator?.rename !== 'function') {
      return Promise.reject(new ChatSessionError('当前身份协调器不支持聊天改名', 'CHAT_SESSION_RENAME_UNAVAILABLE'));
    }
    let context;
    try { context = capture(); }
    catch (error) { return Promise.reject(error); }
    const operation = { epoch, host: context.host, controller: new AbortController() };
    state = Object.freeze({ status: 'preparing' });
    operation.promise = (async () => {
      try {
        const chatId = await identityCoordinator.rename(context.raw, context.host, {
          event,
          previousIdentity,
          preparedIdentity,
          signal: operation.controller.signal,
        });
        const current = currentFor(operation);
        if (current !== 'current') return Object.freeze({ status: current });
        const refreshed = capture().host;
        if (!isUuid(refreshed.chatId) || refreshed.chatId !== chatId) {
          throw new ChatSessionError('改名身份保存后未能读回', 'CHAT_SESSION_PERSIST_FAILED');
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
    if (!enabled()) throw new ChatSessionError('千千结已关闭', 'CHAT_SESSION_DISABLED');
    const host = capture().host;
    if (suspension && sameHost(suspension.host, host) && host.chatId === suspension.identity.chatId) {
      throw new ChatSessionError('当前聊天记忆正在清理，请等待完成或重试', 'CHAT_SESSION_SUSPENDED');
    }
    if (!isUuid(host.chatId)) throw new ChatSessionError('当前聊天尚未建立稳定 chatId', 'CHAT_SESSION_NOT_READY');
    if (identityCoordinator && (state.status !== 'ready'
      || state.identity?.chatId !== host.chatId
      || state.identity?.hostChatId !== host.hostChatId)) {
      throw new ChatSessionError('当前聊天身份尚未完成后端认领', 'CHAT_SESSION_NOT_READY');
    }
    return publicIdentity(host);
  }

  function invalidate() {
    epoch += 1;
    active?.controller?.abort('sessionInvalidated');
    active = null;
    let suspendedHere = false;
    if (suspension) {
      try { const host = capture().host; suspendedHere = sameHost(suspension.host, host) && host.chatId === suspension.identity.chatId; }
      catch { /* invalid host remains idle until it can be captured again */ }
    }
    state = Object.freeze(!enabled() ? { status: 'disabled' } : suspendedHere ? { status: 'suspended', identity: suspension.identity } : { status: 'idle' });
  }

  function suspend(chatId) {
    if (!enabled()) throw new ChatSessionError('千千结已关闭', 'CHAT_SESSION_DISABLED');
    const context = capture();
    if (!isUuid(chatId) || context.host.chatId !== chatId || state.status !== 'ready' || state.identity?.chatId !== chatId) {
      throw new ChatSessionError('当前聊天身份尚未准备好，不能清理记忆', 'CHAT_SESSION_NOT_READY');
    }
    epoch += 1;
    active?.controller?.abort('sessionSuspended');
    active = null;
    suspension = Object.freeze({ host: context.host, identity: state.identity });
    state = Object.freeze({ status: 'suspended', identity: suspension.identity });
    return state;
  }

  function resume(chatId) {
    if (!suspension || suspension.identity.chatId !== chatId) return false;
    epoch += 1;
    active?.controller?.abort('sessionResumed');
    active = null;
    suspension = null;
    state = Object.freeze({ status: enabled() ? 'idle' : 'disabled' });
    return true;
  }

  return Object.freeze({ prepare, rename, identity, invalidate, suspend, resume, getState: () => state });
}
