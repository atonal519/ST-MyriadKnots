export const QQJ_QIANSHI_BACKEND_BRIDGE_KEY = 'qqj_qianshi_backend_v1';

const clone = value => structuredClone(value);
const frozen = value => Object.freeze(value);

export function createPublicQianshiBridge({ memoryRuntime } = {}) {
  if (!memoryRuntime || typeof memoryRuntime.getQianshiSnapshot !== 'function') throw new TypeError('千事公共桥 memoryRuntime 无效');
  const safe = (task, fallback) => {
    try { return clone(task()); }
    catch (error) { return { status: 'error', message: String(error?.message ?? fallback).slice(0, 500) }; }
  };
  const getSnapshot = () => safe(() => memoryRuntime.getQianshiSnapshot(), '千事快照读取失败。');
  const getStatus = () => {
    const value = getSnapshot();
    return clone({ status: value.status, message: value.message ?? '', anchor: value.anchor ?? null, coverage: value.coverage ?? null, history: value.history ?? null });
  };
  const read = async () => getSnapshot();
  const prepareHistory = options => Promise.resolve(memoryRuntime.prepareQianshiHistory(clone(options ?? {}))).then(clone);
  const startHistory = planId => Promise.resolve(memoryRuntime.startQianshiHistory(planId)).then(clone);
  const stopHistory = () => Promise.resolve(memoryRuntime.stopQianshiHistory()).then(clone);
  return frozen({ schemaVersion: 1, kind: 'qqj-qianshi-backend-bridge', getStatus, getSnapshot, read, prepareHistory, startHistory, stopHistory });
}

export function installPublicQianshiBridge({ globalRef = globalThis, memoryRuntime } = {}) {
  const bridge = createPublicQianshiBridge({ memoryRuntime });
  globalRef[QQJ_QIANSHI_BACKEND_BRIDGE_KEY] = bridge;
  return frozen({ bridge, cleanup() { if (globalRef[QQJ_QIANSHI_BACKEND_BRIDGE_KEY] === bridge) delete globalRef[QQJ_QIANSHI_BACKEND_BRIDGE_KEY]; } });
}
