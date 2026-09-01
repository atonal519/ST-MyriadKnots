import { createSettingsDrawer } from './settings-drawer.js';

const SCOPE_LABELS = Object.freeze({ char: '角色世界书', chat: '聊天世界书', persona: 'Persona 世界书', global: '全局世界书' });

function canonical(value) {
  return String(value ?? '').trim().normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('zh-Hans-CN');
}

export function createArchiveV2SourcePermissionView({ permissions, documentRef = globalThis.document } = {}) {
  if (typeof permissions?.inspectCurrent !== 'function') throw new TypeError('来源许可控制器无效');
  const element = (tag, className = '', text = '') => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const button = (text, className, action) => {
    const node = element('button', className, text); node.type = 'button'; node.addEventListener('click', action); return node;
  };
  const scrollParent = node => {
    const view = documentRef.defaultView ?? globalThis;
    const getStyle = typeof view?.getComputedStyle === 'function' ? target => view.getComputedStyle(target) : null;
    for (let parent = node?.parentNode; parent; parent = parent.parentNode) {
      try {
        const overflowY = typeof getStyle === 'function' ? getStyle(parent)?.overflowY : '';
        if (overflowY === 'auto' || overflowY === 'scroll') return parent;
      } catch { /* detached test/document nodes fall back to the list itself */ }
    }
    return node;
  };

  function renderPreflight({ onOpenSettings, onContinue } = {}) {
    const box = element('section', 'source-preflight');
    box.append(element('h2', '', '初始化前，请先确认来源范围'));
    box.append(element('p', '', '千千结会按你在设置里允许的角色卡、开场白与世界书条目建立档案。这里不强制校验，也不会因世界书变化反复打扰。'));
    const actions = element('div', 'settings-actions');
    actions.append(button('去筛选世界书', 'secondary-action', () => onOpenSettings?.()), button('我已完成筛选，继续', 'primary-action', () => onContinue?.()));
    box.append(actions);
    return box;
  }

  function renderSettings({ open = false, onDrawerToggle } = {}) {
    const { drawer: block, body: drawerBody } = createSettingsDrawer({
      documentRef,
      title: '当前聊天 · 世界书来源',
      className: 'source-permission-settings',
      id: 'qqj-settings-worldbook',
      open,
      onToggle: onDrawerToggle,
    });
    const hint = element('p', 'settings-hint', '目录只列当前聊天挂载的世界书。无千千结覆盖时，勾选状态跟随酒馆；整本排除与构画共享，且优先于逐条选择。');
    const search = element('input', 'settings-input'); search.type = 'search'; search.placeholder = '搜索世界书、条目或预览';
    const body = element('div', 'source-permission-list');
    drawerBody.append(hint, search, body);
    let snapshot = null;
    let revision = 0;
    let savedScroll = 0;
    const groupOpen = new Map();
    const refresh = async () => {
      const mine = ++revision;
      const scrollElement = scrollParent(body);
      savedScroll = Number(scrollElement?.scrollTop) || savedScroll;
      body.replaceChildren(element('p', 'settings-hint', '正在读取当前世界书…'));
      let result;
      try { result = await permissions.inspectCurrent(); } catch { result = { status: 'error' }; }
      if (mine !== revision) return;
      snapshot = result;
      draw();
    };
    const toggleRow = (label, checked, onChange, muted = '') => {
      const row = element('label', 'source-toggle-row'); const input = element('input'); input.type = 'checkbox'; input.checked = checked;
      input.addEventListener('change', onChange); const copy = element('span'); copy.append(element('strong', '', label)); if (muted) copy.append(element('small', '', muted)); row.append(input, copy); return { row, input };
    };
    const detailsGroup = (id, className, defaultOpen) => {
      const group = element('details', className);
      group.open = groupOpen.has(id) ? groupOpen.get(id) : defaultOpen;
      group.addEventListener('toggle', () => groupOpen.set(id, group.open));
      return group;
    };
    const draw = () => {
      body.replaceChildren();
      if (snapshot?.status !== 'ready') { body.append(element('p', 'settings-hint', '当前世界书暂时无法读取。角色卡与开场白仍按原规则可用。')); return; }
      const query = search.value.trim().toLocaleLowerCase('zh-Hans-CN');
      const excluded = new Set(snapshot.excludedBooks.map(canonical));
      const excludedCount = snapshot.bookNames.filter(name => excluded.has(canonical(name))).length;
      const global = detailsGroup('exclude', 'source-group source-exclude-group', false);
      global.append(element('summary', '', `整本排除 · ${excludedCount > 0 ? `已排除 ${excludedCount} / ` : ''}共 ${snapshot.bookNames.length} 本`));
      for (const book of snapshot.bookNames.filter(name => !query || name.toLocaleLowerCase('zh-Hans-CN').includes(query))) {
        const { row } = toggleRow(book, excluded.has(canonical(book)), async event => { permissions.setBookExcluded(book, event.currentTarget.checked); await refresh(); }, '勾选后构画与千千结都会整本排除');
        global.append(row);
      }
      body.append(global);
      const allowed = new Set(snapshot.allowedKeys);
      const allAllowed = snapshot.entries.length > 0 && snapshot.entries.every(entry => allowed.has(entry.key));
      const someAllowed = snapshot.entries.some(entry => allowed.has(entry.key));
      const allCurrent = toggleRow('当前列表全部条目', allAllowed, async event => {
        permissions.setEntriesAllowed(snapshot.entries.map(entry => ({ key: entry.key, allowed: event.currentTarget.checked })));
        await refresh();
      }, `${snapshot.allowedKeys.length} / ${snapshot.entries.length} 条允许`).row;
      const allCurrentInput = allCurrent.querySelector?.('input');
      if (allCurrentInput) allCurrentInput.indeterminate = someAllowed && !allAllowed;
      body.append(allCurrent);
      const groups = new Map();
      for (const entry of snapshot.entries) {
        const haystack = `${entry.source}\n${entry.label}\n${entry.preview}`.toLocaleLowerCase('zh-Hans-CN');
        if (query && !haystack.includes(query)) continue;
        const key = `${entry.scope}\u0000${entry.source}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(entry);
      }
      for (const [key, entries] of groups) {
        const [scope, book] = key.split('\u0000');
        const group = detailsGroup(`book:${key}`, 'source-group source-book-group', true);
        const bookAllAllowed = entries.every(entry => allowed.has(entry.key));
        const bookSomeAllowed = entries.some(entry => allowed.has(entry.key));
        const summary = element('summary', 'source-group-summary');
        const summaryCheck = element('input');
        summaryCheck.type = 'checkbox';
        summaryCheck.className = 'source-group-checkbox';
        summaryCheck.checked = bookAllAllowed;
        summaryCheck.indeterminate = bookSomeAllowed && !bookAllAllowed;
        summaryCheck.addEventListener('click', event => event.stopPropagation?.());
        summaryCheck.addEventListener('change', async event => {
          event.stopPropagation?.();
          permissions.setEntriesAllowed(entries.map(entry => ({ key: entry.key, allowed: event.currentTarget.checked })));
          await refresh();
        });
        summary.append(summaryCheck, element('span', '', `${SCOPE_LABELS[scope] ?? scope} · ${book}`), element('small', '', `${entries.length} 条`));
        group.append(summary);
        for (const entry of entries) {
          const hostCopy = entry.hostEnabled === false ? '宿主当前关闭；千千结可单独覆盖' : (entry.activated ? '宿主当前激活' : '宿主当前启用');
          const muted = [hostCopy, entry.preview || '空条目'].filter(Boolean).join(' · ');
          const { row } = toggleRow(entry.label, allowed.has(entry.key), async event => { permissions.setEntryAllowed(entry.key, event.currentTarget.checked); await refresh(); }, muted);
          const full = element('details', 'source-entry-content');
          full.append(element('summary', '', '查看全文'), element('pre', '', entry.content || '（空条目）'));
          group.append(row, full);
        }
        body.append(group);
      }
      if (!groups.size) body.append(element('p', 'settings-hint', query ? '没有匹配条目。' : '当前聊天没有挂载的世界书条目。'));
      const scrollElement = scrollParent(body);
      if (scrollElement) scrollElement.scrollTop = savedScroll;
    };
    search.addEventListener('input', draw);
    void refresh();
    return block;
  }

  return Object.freeze({ renderPreflight, renderSettings });
}
