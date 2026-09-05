export function createSettingsDrawerState(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, value === true]));
  return Object.freeze({
    isOpen: (key, fallback = false) => values.has(key) ? values.get(key) : fallback === true,
    set: (key, open) => { values.set(key, open === true); },
    open: key => { values.set(key, true); },
    snapshot: () => Object.fromEntries(values),
  });
}

const DRAWER_LEVELS = Object.freeze({
  block: { drawer: 'settings-block settings-drawer', summary: 'settings-drawer-summary', heading: 'h3', body: 'settings-drawer-body' },
  group: { drawer: 'settings-group', summary: 'settings-group-summary', heading: 'h3', body: 'settings-group-body' },
  sub: { drawer: 'settings-sub', summary: 'settings-sub-summary', heading: 'h4', body: 'settings-sub-body' },
});

export function createSettingsDrawer({
  documentRef = globalThis.document,
  title,
  className = '',
  id = '',
  open = false,
  level = 'block',
  onToggle,
} = {}) {
  if (!documentRef?.createElement) throw new TypeError('settings drawer documentRef 无效');
  const spec = DRAWER_LEVELS[level] ?? DRAWER_LEVELS.block;
  const drawer = documentRef.createElement('details');
  drawer.className = [spec.drawer, className].filter(Boolean).join(' ');
  if (id) drawer.id = id;
  drawer.open = open === true;
  const summary = documentRef.createElement('summary');
  summary.className = spec.summary;
  const heading = documentRef.createElement(spec.heading);
  heading.textContent = String(title ?? '设置');
  summary.append(heading);
  const body = documentRef.createElement('div');
  body.className = spec.body;
  drawer.append(summary, body);
  drawer.addEventListener('toggle', () => onToggle?.(drawer.open));
  return Object.freeze({ drawer, summary, heading, body });
}
