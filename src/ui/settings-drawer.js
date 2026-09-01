export function createSettingsDrawerState(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, value === true]));
  return Object.freeze({
    isOpen: (key, fallback = false) => values.has(key) ? values.get(key) : fallback === true,
    set: (key, open) => { values.set(key, open === true); },
    open: key => { values.set(key, true); },
    snapshot: () => Object.fromEntries(values),
  });
}

export function createSettingsDrawer({
  documentRef = globalThis.document,
  title,
  className = '',
  id = '',
  open = false,
  onToggle,
} = {}) {
  if (!documentRef?.createElement) throw new TypeError('settings drawer documentRef 无效');
  const drawer = documentRef.createElement('details');
  drawer.className = ['settings-block', 'settings-drawer', className].filter(Boolean).join(' ');
  if (id) drawer.id = id;
  drawer.open = open === true;
  const summary = documentRef.createElement('summary');
  summary.className = 'settings-drawer-summary';
  const heading = documentRef.createElement('h3');
  heading.textContent = String(title ?? '设置');
  summary.append(heading);
  const body = documentRef.createElement('div');
  body.className = 'settings-drawer-body';
  drawer.append(summary, body);
  drawer.addEventListener('toggle', () => onToggle?.(drawer.open));
  return Object.freeze({ drawer, summary, body });
}
