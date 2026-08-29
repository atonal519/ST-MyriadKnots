export function registerIntegration(api, register = globalThis.Luker?.getContext?.().registerExtensionApi) {
  if (typeof register === 'function') register('qianqianjie-demo', api);
  return api;
}

export function bindRerunEvents({ eventSource, eventTypes, controller, isEnabled = () => true, logger = console } = {}) {
  if (!eventSource?.on || !eventTypes || !controller?.invalidate || !(controller?.run || controller?.runDemo)) return false;
  const rerun = () => {
    controller.invalidate();
    if (!isEnabled()) return;
    Promise.resolve().then(() => (controller.run ?? controller.runDemo)()).catch(() => logger.warn('[qianqianjie-demo] 事件重跑失败'));
  };
  eventSource.on(eventTypes.CHAT_CHANGED, rerun);
  eventSource.on(eventTypes.PERSONA_CHANGED, rerun);
  return true;
}

export function bindStableFloorEvents({ eventSource, eventTypes, controller, isEnabled = () => true, logger = console } = {}) {
  if (!eventSource?.on || !eventTypes || !controller?.invalidate || !controller?.run) return false;
  let scheduled = false;
  const rerun = () => {
    controller.invalidate();
    if (!isEnabled()) return;
    if (scheduled) return;
    scheduled = true;
    Promise.resolve().then(() => { scheduled = false; return controller.run(); }).catch(() => logger.warn('[qianqianjie] 稳定楼刷新失败'));
  };
  const names = ['MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED'];
  let bound = 0;
  for (const name of names) {
    if (!eventTypes[name]) continue;
    eventSource.on(eventTypes[name], rerun);
    bound += 1;
  }
  return bound > 0;
}

export function createRerunOrchestrator({ demo, formal, isEnabled = () => true, logger = console } = {}) {
  let serial = Promise.resolve(); let epoch = 0;
  const invalidate = () => { epoch += 1; demo?.invalidate?.(); formal?.invalidate?.(); };
  const run = () => {
    const mine = epoch, admitted = isEnabled();
    if (!admitted) return Promise.resolve({ status: 'stale' });
    const current = () => admitted && isEnabled() && mine === epoch;
    serial = serial.then(async () => {
      if (!current()) return { status: 'stale' };
      const result = await demo?.runDemo?.();
      if (!current()) return { status: 'stale' };
      if (formal?.getFormalState) {
        const value = await formal.getFormalState();
        return current() ? value : { status: 'stale' };
      }
      return result;
    }).catch(() => { logger.warn('[qianqianjie-demo] 编排运行失败'); return { status: 'error' }; });
    return serial;
  };
  return { invalidate, run };
}

export function startInitialRun(controller, logger = console, isEnabled = () => true) {
  if (!isEnabled()) return false;
  Promise.resolve().then(() => (controller?.run ?? controller?.runDemo)?.()).catch(() => logger.warn('[qianqianjie-demo] 初始运行失败'));
  return true;
}
