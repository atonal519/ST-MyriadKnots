import { createArchiveV2DossierView } from './archive-v2-dossier-view.js';

const terminalCopy = Object.freeze({
  disabled: '千千结当前已关闭。',
  stale: '当前聊天或 Persona 已变化，迟到结果不会保存。',
  source_changed: '初始化快照与已保存批次不一致，请切回原聊天状态后重试。',
  conflict: '正式档案已经存在，本次没有覆盖。',
  error: '操作没有完成，已保存数据保持不变。',
});

export function createArchiveV2InitializationView({
  composition,
  memory,
  followedProfiles,
  dossier,
  documentRef = globalThis.document,
  dossierViewFactory = createArchiveV2DossierView,
} = {}) {
  for (const [value, label] of [
    [composition?.readArchive, 'composition.readArchive'],
    [memory?.inspect, 'memory.inspect'],
    [memory?.start, 'memory.start'],
    [memory?.consolidatePeople, 'memory.consolidatePeople'],
    [memory?.confirmPeople, 'memory.confirmPeople'],
    [followedProfiles?.inspect, 'followedProfiles.inspect'],
    [followedProfiles?.generate, 'followedProfiles.generate'],
    [followedProfiles?.commit, 'followedProfiles.commit'],
  ]) if (typeof value !== 'function') throw new TypeError(`${label} 必须是函数`);
  if (!documentRef?.createElement) throw new TypeError('documentRef 无效');
  const dossierView = dossierViewFactory({ actions: dossier, documentRef });
  let root = null;
  let content = null;
  let active = false;
  let destroyed = false;
  let epoch = 0;
  let readResult = null;
  let memoryResult = null;
  let followedResult = null;
  let memoryStartPromise = null;
  let peoplePromise = null;
  let commitPromise = null;
  let profilePromise = null;
  let profileCommitPromise = null;
  let pollTimer = null;
  let errorText = '';
  const selection = new Map();
  let selectionKey = '';

  const element = (tag, className = '', text = '') => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== '') node.textContent = text;
    return node;
  };
  const action = (text, handler, disabled = false, secondary = false) => {
    const node = element('button', `qqj-v2-button ${secondary ? 'qqj-v2-secondary' : 'qqj-v2-primary'}`, text);
    node.type = 'button';
    node.disabled = disabled;
    node.addEventListener('click', () => { if (!node.disabled) handler(); });
    return node;
  };
  const heading = (title, copy) => {
    const header = element('header', 'qqj-v2-heading');
    header.append(element('h2', '', title), element('p', '', copy));
    return header;
  };
  const busy = () => Boolean(memoryStartPromise || peoplePromise || commitPromise || profilePromise || profileCommitPromise);
  const pendingMemory = () => memoryStartPromise || peoplePromise || commitPromise;
  const current = token => active && !destroyed && token === epoch && root !== null;
  const people = result => Array.isArray(result?.peopleResult?.people) ? result.peopleResult.people : [];

  function syncSelection(result) {
    const list = people(result);
    const key = `${result?.peopleResult?.sourceFingerprint ?? ''}|${list.map(item => item.localId).join('|')}`;
    if (key === selectionKey) return list;
    selectionKey = key;
    selection.clear();
    for (const person of list) selection.set(person.localId, person.recommended === true);
    return list;
  }

  function progress(result) {
    const box = element('div', 'qqj-v2-memory-progress');
    const completed = Number(result?.completedBatches) || 0;
    const total = Number(result?.totalBatches) || 0;
    box.append(element('strong', '', total ? `${completed} / ${total} 批` : '等待扫描'));
    if (Number.isSafeInteger(result?.targetFloor)) box.append(element('span', '', `固定截止楼层：${result.targetFloor}`));
    if (Number.isSafeInteger(result?.eligibleFloorCount)) box.append(element('span', '', `有效 AI 楼：${result.eligibleFloorCount}`));
    return box;
  }

  function renderMemory() {
    const result = memoryResult ?? { status: 'error' };
    const section = element('section', 'qqj-v2-memory');
    if (errorText) section.append(element('p', 'qqj-v2-error', errorText));
    if (result.status === 'uninitialized') {
      section.append(heading('建立 V2 历史记忆', '扫描范围固定为点击时截止的全部有效 AI 正文；关闭面板不会中断。'));
      section.append(progress(result));
      if (result.overRecommendedLimit) section.append(element('p', 'qqj-v2-warning', '历史较长，扫描会分批在后台持续进行。'));
      section.append(action('开始扫描', startMemory, busy()));
      return section;
    }
    if (['running', 'writing_batch', 'preparing'].includes(result.status)) {
      section.append(heading('正在扫描历史正文', '任务会继续使用点击时固定的截止楼层；新消息不会被追加入本轮。'), progress(result));
      return section;
    }
    if (result.status === 'error') {
      section.append(heading('历史扫描没有完成', '已成功保存的批次仍在，可以手动继续。'), progress(result), action('继续扫描', startMemory, busy()));
      return section;
    }
    if (result.status !== 'ready') {
      section.append(heading('当前初始化不可继续', terminalCopy[result.status] ?? '请稍后重新打开千千结。'));
      return section;
    }
    if (result.peopleStatus === 'uninitialized' || result.peopleStatus === 'idle') {
      section.append(heading('历史记忆已经完成', '再次明确点击后，才会用已保存批次整理人物；不会重新读取聊天全文。'), progress(result), action('整理人物', consolidatePeople, busy()));
      return section;
    }
    if (result.peopleStatus === 'running') {
      section.append(heading('正在整理人物', '关闭面板不会中断；切换聊天、Persona 或禁用插件会使迟到结果失效。'), progress(result));
      return section;
    }
    if (result.peopleStatus === 'error') {
      section.append(heading('人物整理没有完成', '已保存的 memory 批次没有改变。'), action('重新整理', consolidatePeople, busy()));
      return section;
    }
    if (result.peopleStatus === 'committing') {
      section.append(heading('正在建立正式档案', '人物会原子写入同一份 archive-v2。'));
      return section;
    }
    if (result.peopleStatus === 'conflict') {
      section.append(heading('正式档案已经存在', '本次没有覆盖已有 archive-v2。'));
      return section;
    }
    if (result.peopleStatus === 'committed') {
      section.append(heading('人物已经写入档案', `关注 ${result.followedCount ?? 0} 人，静默 ${result.silentCount ?? 0} 人。`));
      return section;
    }
    const list = syncSelection(result);
    section.append(heading('选择关注人物', '未勾选人物会进入同档案静默池；用户本人不会作为千人候选。'));
    const cards = element('div', 'qqj-v2-memory-people-list');
    for (const person of list) {
      const row = element('label', 'qqj-v2-memory-person');
      const checkbox = element('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selection.get(person.localId) === true;
      checkbox.disabled = busy();
      checkbox.addEventListener('change', () => { selection.set(person.localId, checkbox.checked); render(); });
      const copy = element('span');
      copy.append(element('strong', '', person.displayName || '未命名人物'));
      if (person.recommendationReason) copy.append(element('small', '', person.recommendationReason));
      row.append(checkbox, copy);
      cards.append(row);
    }
    section.append(cards);
    const selected = [...selection.values()].filter(Boolean).length;
    section.append(element('p', 'qqj-v2-selection-count', `关注 ${selected} 人 · 静默 ${list.length - selected} 人`));
    section.append(action('确认并建立档案', confirmPeople, busy() || !list.length));
    return section;
  }

  function renderReady() {
    return dossierView.render({
      readResult,
      followedProfileResult: followedResult,
      busy: busy(),
      requestRender: render,
      onArchiveChange(result) {
        readResult = { status: 'ready', archive: result.archive, revision: result.revision, warnings: result.warnings ?? [] };
        followedResult = profileStateFromArchive(result.archive);
        render();
      },
      generateFollowedProfiles,
      commitFollowedProfiles,
    });
  }

  function render() {
    if (!root || destroyed) return;
    root.setAttribute('aria-busy', String(busy()));
    if (!active) return;
    if (readResult?.status === 'ready') content.replaceChildren(renderReady());
    else if (readResult?.status === 'uninitialized') content.replaceChildren(renderMemory());
    else {
      const status = readResult?.status ?? 'error';
      const box = element('section', 'qqj-v2-read-state');
      box.append(heading('档案暂不可用', terminalCopy[status] ?? '读取没有完成，请稍后重试。'));
      content.replaceChildren(box);
    }
  }

  function stopPolling() {
    if (pollTimer === null) return;
    (documentRef.defaultView?.clearInterval ?? globalThis.clearInterval)(pollTimer);
    pollTimer = null;
  }
  function poll() {
    if (!active || !pendingMemory()) return stopPolling();
    try { memoryResult = memory.getState(); render(); } catch { /* composition owns the authoritative error */ }
  }
  function startPolling() {
    if (pollTimer !== null || !active || !pendingMemory()) return;
    pollTimer = (documentRef.defaultView?.setInterval ?? globalThis.setInterval)(poll, 350);
    pollTimer?.unref?.();
  }

  function settleMemory(slot, promise, { commit = false } = {}) {
    promise.then(result => ({ ok: true, result }), () => ({ ok: false, result: { status: 'error' } })).then(async outcome => {
      if (slot() !== promise) return;
      if (memoryStartPromise === promise) memoryStartPromise = null;
      if (peoplePromise === promise) peoplePromise = null;
      if (commitPromise === promise) commitPromise = null;
      if (commit && outcome.ok && outcome.result?.status === 'created') {
        readResult = { status: 'ready', archive: outcome.result.archive, revision: outcome.result.revision, warnings: outcome.result.warnings ?? [] };
        followedResult = profileStateFromArchive(outcome.result.archive);
      } else {
        try { memoryResult = await memory.inspect(); }
        catch { memoryResult = { status: 'error' }; }
      }
      if (active) { stopPolling(); render(); }
    });
  }
  function startMemory() {
    if (busy()) return;
    errorText = '';
    const promise = Promise.resolve().then(() => memory.start());
    memoryStartPromise = promise;
    try { memoryResult = memory.getState(); } catch { memoryResult = { status: 'running' }; }
    startPolling(); render();
    settleMemory(() => memoryStartPromise, promise);
  }
  function consolidatePeople() {
    if (busy()) return;
    errorText = '';
    const promise = Promise.resolve().then(() => memory.consolidatePeople());
    peoplePromise = promise;
    try { memoryResult = memory.getState(); } catch { memoryResult = { status: 'ready', peopleStatus: 'running' }; }
    startPolling(); render();
    settleMemory(() => peoplePromise, promise);
  }
  function confirmPeople() {
    if (busy()) return;
    const selectedLocalIds = [...selection].filter(([, value]) => value).map(([localId]) => localId);
    const promise = Promise.resolve().then(() => memory.confirmPeople({ selectedLocalIds }));
    commitPromise = promise;
    try { memoryResult = memory.getState(); } catch { memoryResult = { status: 'ready', peopleStatus: 'committing' }; }
    startPolling(); render();
    settleMemory(() => commitPromise, promise, { commit: true });
  }

  function profileStateFromArchive(archive) {
    const order = Array.isArray(archive?.people?.order) ? archive.people.order : [];
    const followed = order.map(id => archive.people.byId?.[id]).filter(person => person?.followed === true);
    const enrichedCount = followed.filter(person => Object.keys(person.fields ?? {}).length > 0).length;
    return { status: followed.length ? 'ready' : 'empty', followedCount: followed.length, enrichedCount };
  }
  function settleProfile(slot, promise) {
    promise.then(result => ({ ok: true, result }), () => ({ ok: false, result: { status: 'error' } })).then(outcome => {
      if (slot() !== promise) return;
      if (profilePromise === promise) profilePromise = null;
      if (profileCommitPromise === promise) profileCommitPromise = null;
      try { followedResult = followedProfiles.getState(); }
      catch { followedResult = outcome.result; }
      if (outcome.ok && outcome.result?.status === 'saved') {
        readResult = { status: 'ready', archive: outcome.result.archive, revision: outcome.result.revision, warnings: outcome.result.warnings ?? [] };
      }
      if (active) render();
    });
  }
  function generateFollowedProfiles() {
    if (busy()) return;
    const promise = Promise.resolve().then(() => followedProfiles.generate());
    profilePromise = promise;
    try { followedResult = followedProfiles.getState(); } catch { followedResult = { status: 'running' }; }
    render(); settleProfile(() => profilePromise, promise);
  }
  function commitFollowedProfiles() {
    if (busy()) return;
    const promise = Promise.resolve().then(() => followedProfiles.commit());
    profileCommitPromise = promise;
    try { followedResult = followedProfiles.getState(); } catch { followedResult = { status: 'saving' }; }
    render(); settleProfile(() => profileCommitPromise, promise);
  }

  function mount(container) {
    if (destroyed) throw new Error('视图已经销毁');
    if (!container?.append) throw new TypeError('mount container 无效');
    root?.remove?.();
    root = element('section', 'qqj-v2-initialization');
    root.hidden = true;
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', '千千结 V2 千人档案');
    const style = element('link');
    style.rel = 'stylesheet';
    style.href = new URL('./archive-v2-initialization.css', import.meta.url).href;
    content = element('div', 'qqj-v2-content');
    root.append(style, content);
    container.append(root);
    return root;
  }

  async function activate() {
    if (destroyed || !root) throw new Error('视图尚未挂载');
    active = true;
    root.hidden = false;
    const token = ++epoch;
    errorText = '';
    readResult = { status: 'loading' };
    render();
    let result;
    try { result = await composition.readArchive(); }
    catch { result = { status: 'error' }; }
    if (!current(token)) return { status: 'stale' };
    readResult = result;
    if (result?.status === 'uninitialized') {
      try { memoryResult = pendingMemory() ? memory.getState() : await memory.inspect(); }
      catch { memoryResult = { status: 'error' }; }
      if (pendingMemory()) startPolling();
    } else if (result?.status === 'ready') {
      try { followedResult = profilePromise || profileCommitPromise ? followedProfiles.getState() : await followedProfiles.inspect(); }
      catch { followedResult = profileStateFromArchive(result.archive); }
    }
    if (current(token)) render();
    return result;
  }

  function deactivate() {
    if (!root || destroyed) return;
    active = false;
    epoch += 1;
    stopPolling();
    dossierView.invalidate();
    root.hidden = true;
  }

  function destroy() {
    if (destroyed) return;
    deactivate();
    destroyed = true;
    root?.remove?.();
    root = null;
    content = null;
  }

  return Object.freeze({ mount, activate, deactivate, destroy });
}
