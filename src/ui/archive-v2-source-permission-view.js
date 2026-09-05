import { createSettingsDrawer } from './settings-drawer.js';

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
  const toggleRow = (label, checked, onChange) => {
    const row = element('label', 'source-toggle-row');
    const input = element('input'); input.type = 'checkbox'; input.checked = checked;
    input.addEventListener('change', onChange);
    const copy = element('span'); copy.append(element('strong', '', label));
    row.append(input, copy);
    return { row, input };
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
      title: '世界书排除',
      className: 'source-permission-settings',
      id: 'qqj-settings-worldbook',
      open,
      level: 'sub',
      onToggle: onDrawerToggle,
    });
    const count = element('p', 'source-exclude-count');
    const search = element('input', 'settings-input'); search.type = 'search'; search.placeholder = '搜索世界书';
    const body = element('div', 'source-permission-list');
    drawerBody.append(count, search, body);
    let snapshot = null;
    let revision = 0;
    let savedScroll = 0;
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
    const draw = () => {
      body.replaceChildren();
      if (snapshot?.status !== 'ready') { count.textContent = ''; body.append(element('p', 'settings-hint', '当前世界书暂时无法读取。角色卡与开场白仍按原规则可用。')); return; }
      const query = search.value.trim().toLocaleLowerCase('zh-Hans-CN');
      const excluded = new Set(snapshot.excludedBooks.map(canonical));
      const excludedCount = snapshot.bookNames.filter(name => excluded.has(canonical(name))).length;
      count.textContent = `已排除 ${excludedCount} / 共 ${snapshot.bookNames.length} 本`;
      const books = snapshot.bookNames.filter(name => !query || name.toLocaleLowerCase('zh-Hans-CN').includes(query));
      if (!books.length) { body.append(element('p', 'settings-hint', query ? '没有匹配的世界书。' : '当前聊天没有挂载的世界书。')); return; }
      for (const book of books) {
        const { row } = toggleRow(book, excluded.has(canonical(book)), async event => { permissions.setBookExcluded(book, event.currentTarget.checked); await refresh(); });
        body.append(row);
      }
      const scrollElement = scrollParent(body);
      if (scrollElement) scrollElement.scrollTop = savedScroll;
    };
    search.addEventListener('input', draw);
    void refresh();
    return block;
  }

  return Object.freeze({ renderPreflight, renderSettings });
}
