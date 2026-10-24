import { createActivitySignal } from './plugin-activity.js';
import { cloneHostJsonMetadata, ensureChatUuid, isUuid, readHostState } from './host-context.js';
import { captureTargetChatCoordinates } from './v3/host-adapter.js';
import { markPreparationFailure, preparationFailureDiagnostic } from './v3/preparation-diagnostic.js';

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

export function createChatSession({ contextProvider, isEnabled = true, ensureChatId = ensureChatUuid, identityCoordinator = null, captureTaskInputs = null } = {}) {
  if (typeof contextProvider !== 'function') throw new TypeError('session contextProvider 必须是函数');
  if (typeof isEnabled !== 'boolean' && typeof isEnabled !== 'function') throw new TypeError('session isEnabled 无效');
  if (typeof ensureChatId !== 'function') throw new TypeError('session ensureChatId 必须是函数');
  if (identityCoordinator !== null && typeof identityCoordinator?.prepare !== 'function') throw new TypeError('session identityCoordinator 无效');
  if (captureTaskInputs !== null && typeof captureTaskInputs !== 'function') throw new TypeError('session captureTaskInputs 无效');

  let active = null;
  const activity = createActivitySignal(() => ({ busy: active !== null, phase: active ? 'preparing' : null }));
  let suspension = null;
  let state = Object.freeze({ status: 'idle' });
  const failPreparation = (error, step, entryPoint) => {
    markPreparationFailure(error, step, entryPoint);
    state = Object.freeze({ status: 'error', error, preparationFailure: preparationFailureDiagnostic(error, step) });
    activity.notifyActivity();
    return error;
  };
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
    } catch (cause) {
      const error = new ChatSessionError('当前聊天身份不可用', 'CHAT_SESSION_CONTEXT_INVALID');
      error.cause = cause;
      throw error;
    }
    if (host?.ok !== true && !(allowNoChat && host?.noChat === true)) {
      throw new ChatSessionError(host?.reason || '当前聊天身份不可用', 'CHAT_SESSION_CONTEXT_INVALID');
    }
    return { raw, host };
  };
  const captureTaskSnapshot = ({ raw, host }) => {
    if (captureTaskInputs) return captureTaskInputs({ raw, host });
    const target = captureTargetChatCoordinates({ context: raw, chat: raw.chat, chatId: host.hostChatId }, {
      hostChatId: host.hostChatId,
      characterLocator: host.characterAvatar, personaLocator: host.personaAvatar,
    });
    return { chat: structuredClone(Array.isArray(raw.chat) ? raw.chat : []), chatMetadata: cloneHostJsonMetadata(raw.chatMetadata ?? {}), target, sanitizerOptions: {} };
  };
  const publicIdentity = host => Object.freeze({
    hostChatId: host.hostChatId,
    chatId: host.chatId,
    characterLocator: host.characterAvatar,
    personaLocator: host.personaAvatar,
  });
  function prepare({ entryPoint = 'direct' } = {}) {
    if (!enabled()) {
      state = Object.freeze({ status: 'disabled' });
      return Promise.resolve(state);
    }
    let context;
    try { context = capture({ allowNoChat: true }); }
    catch (error) {
      const cause = error?.cause ?? error;
      markPreparationFailure(error, 'synchronizing', entryPoint);
      markPreparationFailure(cause, 'synchronizing', entryPoint);
      state = Object.freeze({ status: 'error', error, preparationFailure: preparationFailureDiagnostic(cause, 'synchronizing') });
      activity.notifyActivity();
      return Promise.reject(error);
    }
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
    let taskInputs = null;
    try { taskInputs = identityCoordinator ? captureTaskSnapshot(context) : null; }
    catch (error) { return Promise.reject(failPreparation(error, 'snapshotClone', entryPoint)); }
    const operation = { host: context.host, controller: new AbortController() };
    state = Object.freeze({ status: 'preparing' });
    operation.promise = (async () => {
      try {
        const chatId = identityCoordinator
          ? await identityCoordinator.prepare(context.raw, context.host, { signal: operation.controller.signal, taskInputs })
          : await ensureChatId(context.raw, context.host);
        if (operation.controller.signal.aborted) return Object.freeze({ status: enabled() ? 'cancelled' : 'disabled' });
        if (!isUuid(chatId)) throw new ChatSessionError('聊天身份保存后无法确认。请到“记忆管理”页点击“复制状态诊断”反馈。', 'CHAT_SESSION_PERSIST_FAILED');
        const readyIdentity = Object.freeze({ ...publicIdentity(operation.host), chatId });
        const result = Object.freeze({ status: 'ready', identity: readyIdentity });
        try {
          const refreshed = capture().host;
          if (sameHost(operation.host, refreshed) && refreshed.chatId === chatId) state = result;
        } catch { /* A completed identity belongs to its captured host target, not the newly selected page. */ }
        return result;
      } catch (error) {
        if (operation.controller.signal.aborted) return Object.freeze({ status: enabled() ? 'cancelled' : 'disabled' });
        markPreparationFailure(error, 'identityDirectory', entryPoint);
        try { if (sameHost(operation.host, capture().host)) state = Object.freeze({ status: 'error', error, preparationFailure: preparationFailureDiagnostic(error, 'identityDirectory') }); } catch { /* Keep the current page state independent. */ }
        throw error;
      }
    })();
    active = operation; activity.notifyActivity();
    operation.promise.finally(() => { if (active === operation) active = null; activity.notifyActivity(); }).catch(() => {});
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
    let taskInputs;
    try { taskInputs = captureTaskSnapshot(context); }
    catch (error) { return Promise.reject(error); }
    const operation = { host: context.host, controller: new AbortController() };
    state = Object.freeze({ status: 'preparing' });
    operation.promise = (async () => {
      try {
        const chatId = await identityCoordinator.rename(context.raw, context.host, {
          event,
          previousIdentity,
          preparedIdentity,
          signal: operation.controller.signal,
          taskInputs,
        });
        if (operation.controller.signal.aborted) return Object.freeze({ status: enabled() ? 'cancelled' : 'disabled' });
        if (!isUuid(chatId)) throw new ChatSessionError('聊天改名后无法确认聊天身份。请到“记忆管理”页点击“复制状态诊断”反馈。', 'CHAT_SESSION_PERSIST_FAILED');
        const result = Object.freeze({ status: 'ready', identity: Object.freeze({ ...publicIdentity(operation.host), chatId }) });
        try { if (sameHost(operation.host, capture().host)) state = result; } catch { /* Result remains bound to its captured host. */ }
        return result;
      } catch (error) {
        if (operation.controller.signal.aborted) return Object.freeze({ status: enabled() ? 'cancelled' : 'disabled' });
        try { if (sameHost(operation.host, capture().host)) state = Object.freeze({ status: 'error', error }); } catch { /* Keep current page state independent. */ }
        throw error;
      }
    })();
    active = operation; activity.notifyActivity();
    operation.promise.finally(() => { if (active === operation) active = null; activity.notifyActivity(); }).catch(() => {});
    return operation.promise;
  }

  function renameCharacter(oldLocator, newLocator) {
    if (typeof identityCoordinator?.renameCharacter !== 'function') {
      return Promise.reject(new ChatSessionError('当前身份协调器不支持角色改名', 'CHAT_SESSION_CHARACTER_RENAME_UNAVAILABLE'));
    }
    return identityCoordinator.renameCharacter(oldLocator, newLocator);
  }

  function identity() {
    if (!enabled()) throw new ChatSessionError('千千结已关闭', 'CHAT_SESSION_DISABLED');
    const host = capture().host;
    if (suspension && sameHost(suspension.host, host) && host.chatId === suspension.identity.chatId) {
      throw new ChatSessionError('当前聊天记忆正在清理，请等待完成或重试', 'CHAT_SESSION_SUSPENDED');
    }
    if (!isUuid(host.chatId)) throw new ChatSessionError('当前聊天身份尚未准备好，请稍候。', 'CHAT_SESSION_NOT_READY');
    if (identityCoordinator && (state.status !== 'ready'
      || state.identity?.chatId !== host.chatId
      || state.identity?.hostChatId !== host.hostChatId)) {
      throw new ChatSessionError('当前聊天身份尚未准备好，请稍候。', 'CHAT_SESSION_NOT_READY');
    }
    return publicIdentity(host);
  }

  function invalidate({ cancelTask = false } = {}) {
    if (cancelTask) active?.controller?.abort('sessionInvalidated');
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
    active?.controller?.abort('sessionSuspended');
    active = null;
    suspension = Object.freeze({ host: context.host, identity: state.identity });
    state = Object.freeze({ status: 'suspended', identity: suspension.identity });
    return state;
  }

  function resume(chatId) {
    if (!suspension || suspension.identity.chatId !== chatId) return false;
    const suspendedIdentity = suspension.identity;
    const suspendedHost = suspension.host;
    const activeBelongsToSuspendedHost = active && sameHost(active.host, suspendedHost);
    if (activeBelongsToSuspendedHost) {
      active.controller?.abort('sessionResumed');
      active = null;
    }
    suspension = null;
    const readyBelongsToSuspendedHost = state.status === 'ready'
      && state.identity?.chatId === suspendedIdentity.chatId
      && state.identity?.hostChatId === suspendedHost.hostChatId
      && state.identity?.characterLocator === suspendedHost.characterAvatar
      && state.identity?.personaLocator === suspendedHost.personaAvatar;
    if (active || (state.status === 'ready' && !readyBelongsToSuspendedHost)) return true;
    state = Object.freeze(enabled() ? { status: 'idle' } : { status: 'disabled' });
    return true;
  }

  return Object.freeze({ getActivityState: activity.getActivityState, subscribeActivity: activity.subscribeActivity, prepare, rename, renameCharacter, identity, invalidate, suspend, resume, getState: () => state });
}
