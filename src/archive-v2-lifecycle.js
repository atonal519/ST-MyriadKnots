import { createPluginGate } from './plugin-gate.js';

export function createArchiveV2Lifecycle({
  session,
  compositions = [],
  aborters = [],
  isEnabled = true,
  getUi = () => null,
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

  function invalidate() {
    prepareEpoch += 1;
    let firstError;
    for (const dependency of [...compositions, ...aborters, session]) {
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
    if (mine !== prepareEpoch || !enabled()) return { status: enabled() ? 'stale' : 'disabled' };
    if (refresh) await getUi()?.refresh?.();
    return result;
  }

  function onIdentityChange() {
    try { invalidate(); }
    catch (error) { logger?.warn?.('[qianqianjie] V2 生命周期失效失败', error); }
    if (!enabled()) return;
    Promise.resolve().then(() => prepare()).catch(error => logger?.warn?.('[qianqianjie] V2 身份准备失败', error));
  }

  function bind({ eventSource, eventTypes } = {}) {
    if (bound || !eventSource?.on || !eventTypes) return false;
    for (const name of ['CHAT_CHANGED', 'PERSONA_CHANGED']) {
      if (eventTypes[name]) eventSource.on(eventTypes[name], onIdentityChange);
    }
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

  return Object.freeze({ bind, invalidate, prepare, setEnabled, start, onIdentityChange });
}
