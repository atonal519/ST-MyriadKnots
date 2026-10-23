const COPIES = Object.freeze({
  preparing: '正在准备记忆', migrating: '正在搬家', capturing: '正在读取资料', loading: '正在读取资料', source: '正在读取资料',
  inspecting: '正在核验记忆', validating: '正在核验记忆', reconciling: '正在同步楼层', syncing: '正在同步记忆',
  extracting: '正在提取摘要', analyzingCse: '正在分析人物状态', analyzing: '正在分析人物状态',
  selecting: '正在选取记忆', generating: '正在整理人物资料', building: '正在整理向量索引',
  committing: '正在保存记忆', sealing: '正在保存记忆', revising: '正在保存记忆', revisingCse: '正在保存人物状态',
  savingProfile: '正在保存人物资料', savingSelection: '正在保存人物选择', savingAvatar: '正在保存人物头像',
  deleting: '正在删除记忆', cleaning: '正在清理存储', scanning: '正在读取存储',
  checking: '正在检查更新', updating: '正在更新插件', request: '正在请求资料',
});

// 活动直接来自已有任务/Promise 的生命周期，不登记任务，也不驱动业务。
export function createActivitySignal(read) {
  const listeners = new Set();
  return Object.freeze({
    getActivityState: read,
    subscribeActivity(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    notifyActivity() { const value = read(); for (const listener of listeners) try { listener(value); } catch { /* display only */ } },
  });
}

export function createPluginActivity(sources = []) {
  const listeners = new Set();
  const read = () => {
    const states = sources.map(source => source.getActivityState?.()).filter(state => state?.busy === true);
    const phase = states[0]?.phase ?? null;
    return Object.freeze({ busy: states.length > 0, phase, copy: states.length ? COPIES[phase] ?? '千千结正在处理' : '' });
  };
  let state = read();
  const publish = () => {
    const next = read();
    if (next.busy === state.busy && next.phase === state.phase) return;
    state = next;
    for (const listener of listeners) try { listener(state); } catch { /* display only */ }
  };
  const releases = sources.map(source => (source.subscribeActivity ?? source.subscribe)?.call(source, publish)).filter(Boolean);
  return Object.freeze({ getState: () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { for (const release of releases) release(); listeners.clear(); } });
}
