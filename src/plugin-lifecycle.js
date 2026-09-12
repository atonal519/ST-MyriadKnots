import { createPluginGate } from './plugin-gate.js';

export function createPluginLifecycle({
  session,
  aborters = [],
  isEnabled = true,
  getUi = () => null,
  onPrepared = null,
  logger = console,
} = {}) {
  if (typeof session?.prepare !== 'function' || typeof session?.invalidate !== 'function') {
    throw new TypeError('lifecycle session 无效');
  }
  const enabled = () => {
    try { return (typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true; }
    catch { return false; }
  };
  let prepareEpoch = 0;
  let bound = false;
  let renameTransition = null;

  const prepareCurrent = mine => mine === prepareEpoch && enabled();

  function continuePrepared(result, mine) {
    if (result?.status !== 'ready' || !result.identity || !prepareCurrent(mine) || typeof onPrepared !== 'function') return;
    const isCurrent = () => prepareCurrent(mine);
    let continuation;
    try { continuation = onPrepared({ result, isCurrent }); }
    catch (error) {
      if (isCurrent()) logger?.warn?.('[qianqianjie] 身份成功后的后台加载失败', error);
      return;
    }
    void Promise.resolve(continuation).catch(error => {
      if (isCurrent()) logger?.warn?.('[qianqianjie] 身份成功后的后台加载失败', error);
    });
  }

  function invalidate() {
    prepareEpoch += 1;
    let firstError;
    for (const dependency of [...aborters, session]) {
      const operation = typeof dependency === 'function' ? dependency : dependency?.invalidate ?? dependency?.abortAll;
      if (typeof operation !== 'function') continue;
      try { operation.call(dependency); } catch (error) { firstError ??= error; }
    }
    if (firstError) throw firstError;
  }

  async function prepare({ refresh = true } = {}) {
    const mine = ++prepareEpoch;
    if (!enabled()) return { status: 'disabled' };
    const result = await session.prepare();
    if (!prepareCurrent(mine)) return { status: enabled() ? 'stale' : 'disabled' };
    continuePrepared(result, mine);
    if (refresh) await getUi()?.refresh?.();
    return result;
  }

  function scheduleIdentityPrepare() {
    if (!enabled()) return Promise.resolve({ status: 'disabled' });
    return Promise.resolve().then(() => prepare()).catch(error => {
      logger?.warn?.('[qianqianjie] 聊天身份准备失败', error);
      return { status: 'error', error };
    });
  }

  function onChatChanged() {
    const previous = session.getState?.();
    const transition = previous?.status === 'ready' && previous.identity
      ? { previousIdentity: Object.freeze({ ...previous.identity }), preparePromise: null }
      : null;
    try { invalidate(); }
    catch (error) { logger?.warn?.('[qianqianjie] 插件生命周期失效失败', error); }
    const preparePromise = scheduleIdentityPrepare();
    if (transition) {
      transition.preparePromise = preparePromise;
      renameTransition = Object.freeze(transition);
    } else {
      renameTransition = null;
    }
  }

  function onIdentityChange() {
    renameTransition = null;
    try { invalidate(); }
    catch (error) { logger?.warn?.('[qianqianjie] 插件生命周期失效失败', error); }
    scheduleIdentityPrepare();
  }

  async function onChatRenamed(event) {
    const transition = renameTransition;
    if (!enabled()) return { status: 'disabled' };
    if (!transition?.previousIdentity || typeof session.rename !== 'function') {
      logger?.warn?.('[qianqianjie] 聊天改名缺少连续身份凭据，已保持当前独立档案');
      return { status: 'unverified' };
    }
    const prepared = await transition.preparePromise;
    if (renameTransition !== transition || prepared?.status !== 'ready' || !prepared.identity) {
      logger?.warn?.('[qianqianjie] 聊天改名期间身份已经变化，已保持当前独立档案');
      return { status: 'stale' };
    }
    renameTransition = null;
    try { invalidate(); }
    catch (error) { logger?.warn?.('[qianqianjie] 插件生命周期失效失败', error); }
    const mine = ++prepareEpoch;
    try {
      const result = await session.rename(event, transition.previousIdentity, prepared.identity);
      if (!prepareCurrent(mine)) return { status: enabled() ? 'stale' : 'disabled' };
      continuePrepared(result, mine);
      await getUi()?.refresh?.();
      return result;
    } catch (error) {
      logger?.warn?.('[qianqianjie] 聊天改名身份恢复失败', { code: error?.code ?? error?.name ?? 'QQJ_CHAT_RENAME_FAILED' });
      return { status: 'error', error };
    }
  }

  function bind({ eventSource, eventTypes } = {}) {
    if (bound || !eventSource?.on || !eventTypes) return false;
    if (eventTypes.CHAT_CHANGED) eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
    if (eventTypes.PERSONA_CHANGED) eventSource.on(eventTypes.PERSONA_CHANGED, onIdentityChange);
    if (eventTypes.CHAT_RENAMED) eventSource.on(eventTypes.CHAT_RENAMED, onChatRenamed);
    bound = true;
    return true;
  }

  const gate = createPluginGate({
    initiallyEnabled: enabled(),
    invalidate,
    run: () => prepare(),
    setUiEnabled: value => getUi()?.setEnabled?.(value),
    disabledState: () => ({ status: 'disabled' }),
  });
  const setEnabled = value => gate.setEnabled(value);

  function start() {
    if (!enabled()) {
      getUi()?.setEnabled?.(false);
      return Promise.resolve({ status: 'disabled' });
    }
    return prepare({ refresh: false });
  }

  return Object.freeze({ bind, invalidate, prepare, setEnabled, start, onIdentityChange, onChatChanged, onChatRenamed });
}
