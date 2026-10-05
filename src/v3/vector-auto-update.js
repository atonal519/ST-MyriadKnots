const stableSnapshotKey = (state, identity, generation) => {
  if (!state || state.status !== 'ready' || state.memorySnapshotStatus !== 'ready' || state.memorySyncStatus !== 'idle'
    || state.memoryWorkBusy || state.activeExtraction || state.qianshiHistoryActive || !identity?.chatId || !generation) return null;
  const floors = (state.floors ?? []).filter(floor => floor?.status === 'ready' && typeof floor.floorId === 'string'
    && typeof floor.canonicalFingerprint === 'string').map(floor => [floor.floorId, floor.assistantSeq,
    floor.canonicalFingerprint, floor.rawFingerprint ?? null,
    floor.memoryId ?? null, Array.isArray(floor.memory?.sourceFloorIds) ? floor.memory.sourceFloorIds : null]);
  return JSON.stringify([identity.chatId, generation, floors]);
};

// 只在記忆 runtime 已完成正式落盘后通知索引；普通摘要/CSE通知会被同一原文快照折叠。
export function createVectorAutoUpdater({ memoryRuntime, vectorRuntime, identityProvider, generationProvider,
  configProvider, isEnabled = () => true, isMainGenerationActive = () => false } = {}) {
  if (typeof memoryRuntime?.subscribe !== 'function' || typeof vectorRuntime?.updateIncrementally !== 'function') return Object.freeze({ dispose() {}, refresh() {} });
  let pendingKey = null, lastAttemptedKey = null, runningKey = null, runningScope = null, lastScope = null, draining = false, disposed = false;
  const scopeKey = () => {
    if (!isEnabled() || isMainGenerationActive()) return null;
    try {
      const identity = identityProvider(), generation = generationProvider(), config = configProvider();
      if (!identity?.chatId || !generation || !config) return null;
      return JSON.stringify([identity.chatId, generation, config]);
    } catch { return null; }
  };
  const currentKey = state => {
    if (!isEnabled() || isMainGenerationActive()) return null;
    try {
      const config = configProvider();
      if (!config) return null;
      const snapshot = stableSnapshotKey(state, identityProvider(), generationProvider());
      return snapshot ? JSON.stringify([snapshot, config]) : null;
    } catch { return null; }
  };
  const drain = async () => {
    if (draining || disposed) return;
    draining = true;
    try {
      while (pendingKey && !disposed) {
        const state = memoryRuntime.getState?.(), key = currentKey(state);
        if (!key) { pendingKey = null; return; }
        if (key !== pendingKey) pendingKey = key;
        if (key === lastAttemptedKey) { pendingKey = null; continue; }
        const vectorState = vectorRuntime.getState?.();
        if (vectorState?.active || vectorState?.updating) return;
        pendingKey = null;
        runningKey = key;
        runningScope = scopeKey();
        const result = await vectorRuntime.updateIncrementally();
        const finishedScope = runningScope;
        runningKey = null;
        runningScope = null;
        if (result?.status === 'busy') { pendingKey = key; return; }
        // A failed or suppressed operation is remembered to avoid same-source loops.
        // Readiness and cancellation are temporary gates; their next real wake can retry.
        if (!['notReady', 'disabled', 'cancelled'].includes(result?.status)) lastAttemptedKey = key;
        if (finishedScope && finishedScope !== scopeKey()) schedule(memoryRuntime.getState?.());
      }
    } finally { runningScope = null; draining = false; }
  };
  const schedule = state => {
    const scope = scopeKey();
    if (runningScope && runningScope !== scope) vectorRuntime.cancelIncrementally?.('scopeChanged');
    if (scope) lastScope = scope;
    const key = currentKey(state);
    if (!key) return;
    if (key !== lastAttemptedKey) pendingKey = key;
    void drain();
  };
  const releaseMemory = memoryRuntime.subscribe(schedule);
  const releaseVector = vectorRuntime.subscribe?.(state => {
    if (state?.cancelled === true) {
      const scope = scopeKey();
      if (state.userCancelled === true) {
        const cancelledKey = runningKey ?? pendingKey ?? currentKey(memoryRuntime.getState?.());
        pendingKey = null;
        if (cancelledKey) lastAttemptedKey = cancelledKey;
        return;
      }
      // Config/model changes may reuse the current source. Ordinary lifecycle resets
      // must not masquerade as a user cancel, while chat changes wait for fresh memory.
      const scopeChanged = runningScope ? runningScope !== scope : lastScope !== null && lastScope !== scope;
      if (scopeChanged && scope) schedule(memoryRuntime.getState?.());
      return;
    }
    if (pendingKey) void drain();
  });
  schedule(memoryRuntime.getState?.());
  return Object.freeze({ dispose() {
    disposed = true; pendingKey = null;
    try { releaseMemory?.(); } catch { /* lifecycle teardown must not interrupt unload */ }
    try { releaseVector?.(); } catch { /* lifecycle teardown must not interrupt unload */ }
  }, refresh() { schedule(memoryRuntime.getState?.()); } });
}
