import { publicErrorMessage } from '../public-error.js';

const mib = bytes => `${(Math.max(0, Number(bytes) || 0) / (1024 * 1024)).toFixed(2)} MiB`;
const countAndSize = value => `${value?.count ?? 0} 条 · 约 ${mib(value?.bytes)}`;

export function createStorageManagementView({
  manager,
  documentRef = globalThis.document,
  confirmImpl = options => globalThis.confirm?.(`${options?.title ?? '请确认'}\n\n${options?.body ?? ''}`) === true,
} = {}) {
  if (!manager || ['getState', 'scan', 'cleanup', 'setAutoEnabled', 'subscribe'].some(name => typeof manager[name] !== 'function')) {
    throw new TypeError('存储管理视图 manager 无效');
  }
  if (!documentRef?.createElement) throw new TypeError('存储管理视图 documentRef 无效');
  let container = null, active = false, epoch = 0, unsubscribe = null, feedback = '';
  const element = (tag, className = '', value = '') => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (value !== '') node.textContent = value;
    return node;
  };
  const metric = (label, value) => {
    const row = element('div', 'qqj-storage-row');
    row.append(element('span', '', label), element('strong', '', value));
    return row;
  };
  const statusCopy = state => {
    if (state.status === 'scanning') return '正在读取当前聊天的后端记录…';
    if (state.status === 'cleaning') return '正在安全清理旧版本，请勿切换聊天…';
    if (state.status === 'uninitialized') return '当前聊天尚未建立千千结基础数据，没有可清理的旧版本。';
    if (state.status === 'notReady') return '当前基础数据尚未处于可安全核对的 ready 状态，请稍后刷新。';
    if (state.error) return publicErrorMessage(state.error, { fallback: '存储统计或清理暂时未完成，请稍后刷新。' });
    if (!state.stats) return '展开后会读取当前聊天的千千结后端记录；不会修改数据。';
    return '统计已刷新。占用为后端 JSON 的约数，不代表磁盘精确字节。';
  };
  function render(state = manager.getState()) {
    if (!active || !container) return;
    const page = element('div', 'qqj-storage-management');
    page.append(element('p', 'settings-hint', '只管理当前聊天的千千结后台文件。摘要历史、双丝网状态、千人人物资料、刻度和聊天正文都不会进入旧版本候选。'));
    const status = element('p', `settings-result${state.error ? ' error' : ''}`, statusCopy(state));
    status.setAttribute?.('role', 'status');
    page.append(status);
    if (state.stats) {
      const grid = element('div', 'qqj-storage-grid');
      grid.append(
        metric('总记录', countAndSize(state.stats.total)),
        metric('当前有效基础数据', countAndSize(state.stats.active)),
        metric('可清理的旧版本', countAndSize(state.stats.cleanup)),
        metric('其他保留资料', countAndSize(state.stats.retained)),
      );
      page.append(grid);
      const details = element('details', 'qqj-storage-breakdown');
      const summary = element('summary', '', '查看基础数据明细');
      const body = element('div', 'qqj-storage-breakdown-body');
      for (const [key, label] of [['story', '摘要与楼层'], ['people', '人物与状态'], ['runtime', '运行、检查点与索引']]) {
        body.append(metric(label, `有效 ${countAndSize(state.stats.breakdown.active[key])} · 旧版 ${countAndSize(state.stats.breakdown.cleanup[key])}`));
      }
      details.append(summary, body); page.append(details);
    }
    const toggle = element('label', 'setting-switch qqj-storage-auto');
    const input = element('input'); input.type = 'checkbox'; input.checked = state.autoEnabled === true;
    input.disabled = ['scanning', 'cleaning'].includes(state.status) || (!state.autoEnabled && !state.stats);
    toggle.append(input, element('span', '', '自动清理旧版本'));
    input.addEventListener('change', () => {
      try {
        manager.setAutoEnabled(input.checked);
        feedback = input.checked ? '自动清理已开启。' : '自动清理已关闭。';
      } catch (error) {
        input.checked = !input.checked;
        feedback = publicErrorMessage(error, { fallback: '自动清理设置未能保存。' });
      }
      render(manager.getState());
    });
    page.append(toggle, element('p', 'settings-hint', '默认关闭。开启后，每新增 10 个稳定 AI 楼检查一次；只有无引用旧文件达到 100 条或约 8 MiB 才会清理。任务忙碌时顺延到下一次空闲机会。'));
    if (state.autoPending) page.append(element('p', 'settings-result', '已到检查节点；当前有千千结任务在运行，自动检查会在空闲后继续。'));
    const actions = element('div', 'settings-actions');
    const refresh = element('button', 'secondary-action', '刷新统计'); refresh.type = 'button';
    const clean = element('button', 'danger-action', '清理旧版本'); clean.type = 'button';
    refresh.disabled = ['scanning', 'cleaning'].includes(state.status);
    clean.disabled = ['scanning', 'cleaning'].includes(state.status) || state.busy || !state.stats || (state.stats.cleanup?.count ?? 0) === 0 || state.status !== 'ready';
    refresh.addEventListener('click', async () => {
      feedback = '';
      try { await manager.scan(); }
      catch (error) { feedback = publicErrorMessage(error, { fallback: '刷新统计失败，请稍后重试。' }); }
      render(manager.getState());
    });
    clean.addEventListener('click', async () => {
      const mine = epoch;
      const confirmed = await Promise.resolve(confirmImpl({
        title: '清理当前聊天的后台旧版本',
        body: '只删除当前版本已经不再引用的千千结基础文件。当前摘要、双丝网状态、千人人物资料、刻度和聊天正文都会保留；删除的旧后台版本不可恢复。',
        confirmText: '确认清理', cancelText: '取消',
      }));
      if (!active || mine !== epoch) return;
      if (!confirmed) { feedback = '已取消清理。'; render(manager.getState()); return; }
      feedback = '';
      try {
        const result = await manager.cleanup();
        if (result.status === 'completed') feedback = result.deletedCount || result.convergedCount
          ? `清理完成：删除 ${result.deletedCount} 条${result.convergedCount ? `，另有 ${result.convergedCount} 条已由其他操作移除` : ''}。`
          : '当前已没有可清理的旧版本。';
        else if (result.status === 'stale') feedback = `已安全删除 ${result.deletedCount} 条，但当前版本在清理期间发生变化；请刷新后核对。`;
        else feedback = `部分完成：已删除 ${result.deletedCount} 条，仍有 ${result.remainingCount} 条可清理。${result.error ? ` ${publicErrorMessage(result.error, { fallback: '部分记录删除失败。' })}` : ''}`;
      } catch (error) { feedback = publicErrorMessage(error, { fallback: '清理未完成，请刷新后重试。' }); }
      render(manager.getState());
    });
    actions.append(refresh, clean); page.append(actions);
    const result = element('p', `settings-result${state.error ? ' error' : feedback ? ' success' : ''}`, feedback);
    result.setAttribute?.('role', 'status'); page.append(result);
    container.replaceChildren(page);
  }
  function mount(target) { container = target; render(manager.getState()); return target; }
  async function activate() {
    active = true; const mine = ++epoch;
    unsubscribe?.(); unsubscribe = manager.subscribe(state => render(state));
    render(manager.getState());
    try { await manager.scan(); }
    catch { /* manager state contains the public failure */ }
    if (active && mine === epoch) render(manager.getState());
    return manager.getState();
  }
  function deactivate() { active = false; epoch += 1; unsubscribe?.(); unsubscribe = null; }
  return Object.freeze({ mount, activate, deactivate });
}
