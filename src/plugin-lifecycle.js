import { createPluginGate } from './plugin-gate.js';

export function createPluginLifecycle({
  session,
  aborters = [],
  contextAborters = aborters,
  isEnabled = true,
  getUi = () => null,
  onPrepared = null,
  onDiagnostic = null,
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

  const prepareCurrent = mine => mine === prepareEpoch && enabled();

  function continuePrepared(result, mine, explicitEnable = false) {
    if (result?.status !== 'ready' || !result.identity || !(explicitEnable ? enabled() : prepareCurrent(mine)) || typeof onPrepared !== 'function') return;
    const isCurrent = () => prepareCurrent(mine);
    let continuation;
    try { continuation = onPrepared({ result, isCurrent, explicitEnable }); }
    catch (error) {
      try { onDiagnostic?.(error, explicitEnable ? 'pluginEnable' : 'identityPrepare'); } catch {}
      if (isCurrent()) logger?.warn?.('[qianqianjie] 身份成功后的后台加载失败', error);
      return;
    }
    void Promise.resolve(continuation).then(() => {
      if (isCurrent() && !explicitEnable) { try { onDiagnostic?.(null, 'identityPrepare'); } catch {} }
    }).catch(error => {
      try { onDiagnostic?.(error, explicitEnable ? 'pluginEnable' : 'identityPrepare'); } catch {}
      if (isCurrent()) logger?.warn?.('[qianqianjie] 身份成功后的后台加载失败', error);
    });
  }

  function invalidate({ cancelBusiness = true, contextChange = false } = {}) {
    prepareEpoch += 1;
    let firstError;
    for (const dependency of [...(cancelBusiness ? contextChange ? contextAborters : aborters : []), session]) {
      const operation = typeof dependency === 'function' ? dependency : dependency?.invalidate ?? dependency?.abortAll;
      if (typeof operation !== 'function') continue;
      try { operation.call(dependency, dependency === session ? { cancelTask: !enabled() } : undefined); } catch (error) { firstError ??= error; }
    }
    if (firstError) throw firstError;
  }

  async function prepare({ refresh = true, explicitEnable = false, entryPoint = 'direct' } = {}) {
    const mine = ++prepareEpoch;
    if (!enabled()) return { status: 'disabled' };
    let result;
    try { result = await session.prepare({ entryPoint: explicitEnable ? 'pluginEnable' : entryPoint }); }
    catch (error) {
      try { onDiagnostic?.(error, explicitEnable ? 'pluginEnable' : 'identityPrepare'); } catch {}
      throw error;
    }
    if (!enabled()) return { status: 'disabled' };
    if (!enabled() || (!explicitEnable && !prepareCurrent(mine))) return result;
    continuePrepared(result, mine, explicitEnable);
    if (refresh) await getUi()?.refresh?.();
    return result;
  }

  function scheduleIdentityPrepare(entryPoint) {
    if (!enabled()) return Promise.resolve({ status: 'disabled' });
    return Promise.resolve().then(() => prepare({ entryPoint })).catch(error => {
      logger?.warn?.('[qianqianjie] 聊天身份准备失败', error);
      return { status: 'error', error };
    });
  }

  function onChatChanged() {
    try { invalidate({ cancelBusiness: false }); }
    catch (error) { logger?.warn?.('[qianqianjie] 插件生命周期失效失败', error); }
    return scheduleIdentityPrepare('chatChanged');
  }

  function onIdentityChange() {
    try { invalidate({ contextChange: true }); }
    catch (error) { logger?.warn?.('[qianqianjie] 插件生命周期失效失败', error); }
    scheduleIdentityPrepare('personaChanged');
  }

  // Hosts reload the renamed file before CHAT_RENAMED. Its ordinary prepare
  // already preserves the file identity; the trailing event has no recovery work.
  async function onChatRenamed(event) {
    if (!enabled()) return { status: 'disabled' };
    const state = session.getState?.();
    const name = String(event?.newFileName ?? '').replace(/\.jsonl$/i, '');
    return state?.status === 'ready' && state.identity?.hostChatId === name ? state : { status: 'ignored' };
  }

  async function onCharacterRenamed(oldLocator, newLocator) {
    try { invalidate({ contextChange: true }); }
    catch (error) { logger?.warn?.('[qianqianjie] 插件生命周期失效失败', error); }
    if (typeof session.renameCharacter !== 'function') {
      logger?.warn?.('[qianqianjie] 角色改名缺少身份迁移能力');
      return { status: 'unavailable' };
    }
    try {
      return await session.renameCharacter(oldLocator, newLocator);
    } catch (error) {
      logger?.warn?.('[qianqianjie] 角色改名身份迁移失败', { code: error?.code ?? error?.name ?? 'QQJ_CHARACTER_RENAME_FAILED' });
      return { status: 'error', error };
    }
  }

  function bind({ eventSource, eventTypes } = {}) {
    if (bound || !eventSource?.on || !eventTypes) return false;
    if (eventTypes.CHAT_CHANGED) eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
    if (eventTypes.PERSONA_CHANGED) eventSource.on(eventTypes.PERSONA_CHANGED, onIdentityChange);
    if (eventTypes.CHAT_RENAMED) eventSource.on(eventTypes.CHAT_RENAMED, onChatRenamed);
    if (eventTypes.CHARACTER_RENAMED) eventSource.on(eventTypes.CHARACTER_RENAMED, onCharacterRenamed);
    bound = true;
    return true;
  }

  const gate = createPluginGate({
    initiallyEnabled: enabled(),
    invalidate,
    run: () => prepare({ explicitEnable: true }),
    setUiEnabled: value => getUi()?.setEnabled?.(value),
    disabledState: () => ({ status: 'disabled' }),
  });
  const setEnabled = value => gate.setEnabled(value);

  function start() {
    if (!enabled()) {
      getUi()?.setEnabled?.(false);
      return Promise.resolve({ status: 'disabled' });
    }
    return prepare({ refresh: false, entryPoint: 'startup' });
  }

  return Object.freeze({ bind, invalidate, prepare, setEnabled, start, onIdentityChange, onChatChanged, onChatRenamed, onCharacterRenamed });
}
