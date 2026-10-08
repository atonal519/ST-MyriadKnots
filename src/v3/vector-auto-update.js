const stableSnapshotKey = (state, config) => {
  if (!state || state.status !== 'ready' || state.memorySnapshotStatus !== 'ready' || state.memorySyncStatus !== 'idle'
    || state.memoryWorkBusy || state.activeExtraction || state.qianshiHistoryActive || typeof state.chatId !== 'string' || !state.chatId || !config) return null;
  const floors = (state.floors ?? []).filter(floor => floor?.status === 'ready' && typeof floor.floorId === 'string'
    && typeof floor.canonicalFingerprint === 'string').map(floor => [floor.floorId, floor.assistantSeq,
    floor.canonicalFingerprint, floor.rawFingerprint ?? null,
    floor.memoryId ?? null, Array.isArray(floor.memory?.sourceFloorIds) ? floor.memory.sourceFloorIds : null]);
  const targetKey = state.chatId;
  const sourceKey = JSON.stringify([state.chatId, floors]);
  return { targetKey, signature: JSON.stringify([targetKey, sourceKey, config]), sourceKey,
    targetIdentity: Object.freeze({ chatId: state.chatId }),
    config: structuredClone(config) };
};

// Keep only the committed target identity and source signature; the reader rechecks that target before use.
export function createVectorAutoUpdater({ memoryRuntime, vectorRuntime,
  configProvider, isEnabled = () => true, isMainGenerationActive = () => false } = {}) {
  if (typeof memoryRuntime?.subscribe !== 'function' || typeof vectorRuntime?.updateIncrementally !== 'function') return Object.freeze({ dispose() {}, refresh() {} });
  const pending = new Map();
  let lastAttemptedKey = null, runningTask = null, draining = false, disposed = false;
  const configSignature = () => { try { return JSON.stringify(configProvider()); } catch { return null; } };
  let observedConfig = configSignature();
  const nextTask = () => pending.values().next().value ?? null;
  const drain = async () => {
    if (draining || disposed || isMainGenerationActive()) return;
    draining = true;
    try {
      while (pending.size && !disposed && !isMainGenerationActive()) {
        const [targetKey, task] = pending.entries().next().value;
        pending.delete(targetKey);
        if (task.signature === lastAttemptedKey || task.signature === runningTask?.signature) continue;
        const vectorState = vectorRuntime.getState?.();
        if (vectorState?.active || vectorState?.updating) { pending.set(targetKey, task); return; }
        runningTask = task;
        const result = await vectorRuntime.updateIncrementally(task);
        runningTask = null;
        if (result?.status === 'busy') { pending.set(targetKey, task); return; }
        // Readiness gates can clear on a later committed notification; real failures stay deduplicated.
        if (!['notReady', 'disabled', 'cancelled'].includes(result?.status)) lastAttemptedKey = task.signature;
      }
    } finally { runningTask = null; draining = false; }
  };
  const schedule = state => {
    if (disposed || !isEnabled()) return;
    let config;
    try { config = configProvider(); } catch { return; }
    const task = stableSnapshotKey(state, config);
    if (!task || task.signature === lastAttemptedKey || task.signature === runningTask?.signature) return;
    pending.set(task.targetKey, task);
    void drain();
  };
  const releaseMemory = memoryRuntime.subscribe(schedule);
  const releaseVector = vectorRuntime.subscribe?.(state => {
    if (state?.cancelled === true && state.userCancelled === true) {
      const task = runningTask ?? nextTask();
      if (task) {
        if (pending.get(task.targetKey)?.signature === task.signature) pending.delete(task.targetKey);
        lastAttemptedKey = task.signature;
      }
      return;
    }
    const nextConfig = configSignature();
    if (nextConfig !== observedConfig) {
      observedConfig = nextConfig;
      schedule(memoryRuntime.getState?.());
      return;
    }
    if (pending.size) void drain();
  });
  schedule(memoryRuntime.getState?.());
  return Object.freeze({ dispose() {
    disposed = true; pending.clear();
    try { releaseMemory?.(); } catch { /* teardown must not interrupt plugin shutdown */ }
    try { releaseVector?.(); } catch { /* teardown must not interrupt plugin shutdown */ }
  }, refresh() { schedule(memoryRuntime.getState?.()); } });
}
