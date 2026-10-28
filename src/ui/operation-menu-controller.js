export function createOperationMenuController(documentRef) {
  const menus = new Map();
  let listening = false;
  const tag = node => String(node?.tagName ?? node?.tag ?? '').toLowerCase();
  const children = node => Array.from(node?.children ?? []);
  const parts = menu => {
    const nodes = children(menu), trigger = nodes.find(node => tag(node) === 'summary');
    const body = nodes.find(node => node !== trigger);
    const items = [];
    const visit = node => { if (tag(node) === 'button') items.push(node); else for (const child of children(node)) visit(child); };
    if (body) visit(body);
    return { trigger, body, items };
  };
  const sync = menu => {
    const { trigger, body, items } = parts(menu);
    trigger?.setAttribute?.('aria-haspopup', 'menu');
    trigger?.setAttribute?.('aria-expanded', String(menu.open === true));
    body?.setAttribute?.('role', 'menu');
    for (const item of items) { item.setAttribute?.('role', 'menuitem'); item.setAttribute?.('tabindex', '-1'); }
  };
  const close = menu => { menu.open = false; sync(menu); };
  const inside = (menu, event, path) => path.includes(menu) || (!path.length && menu.contains?.(event?.target));
  const open = menu => {
    for (const other of menus.keys()) if (other !== menu && other.open) close(other);
    menu.open = true; sync(menu);
  };
  const unregister = menu => {
    const onToggle = menus.get(menu);
    if (!onToggle) return;
    menu.removeEventListener?.('toggle', onToggle);
    close(menu); menus.delete(menu);
  };
  const reset = () => { for (const menu of menus.keys()) unregister(menu); };

  const handleDocumentClick = event => {
    const path = typeof event?.composedPath === 'function' ? event.composedPath() : [];
    for (const menu of menus.keys()) {
      const clickedInside = inside(menu, event, path);
      const actionChosen = clickedInside && parts(menu).items.some(item => path.includes(item) || (!path.length && item.contains?.(event?.target)));
      if (menu.open && (!clickedInside || actionChosen)) close(menu);
    }
  };
  const handleDocumentKeydown = event => {
    if (event.defaultPrevented || !['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const path = typeof event?.composedPath === 'function' ? event.composedPath() : [];
    const menu = [...menus.keys()].find(value => inside(value, event, path));
    if (!menu || (event.key === 'Escape' && !menu.open)) return;
    const { trigger, items } = parts(menu);
    if (event.key === 'Escape') {
      close(menu); trigger?.focus?.({ preventScroll: true });
    } else {
      const available = items.filter(item => !item.disabled && !item.hidden);
      if (!available.length || (!menu.open && ['Home', 'End'].includes(event.key))) return;
      const index = available.findIndex(item => path.includes(item) || item === event.target);
      const offset = event.key === 'ArrowUp' ? -1 : 1;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1
        : index < 0 ? offset < 0 ? available.length - 1 : 0 : (index + offset + available.length) % available.length;
      open(menu); available[next]?.focus?.({ preventScroll: true });
    }
    event.preventDefault?.(); event.stopPropagation?.();
  };

  return Object.freeze({
    reset,
    register(menu) {
      if (menus.has(menu)) return menu;
      const onToggle = () => { if (menu.open) open(menu); else sync(menu); };
      menus.set(menu, onToggle); menu.addEventListener?.('toggle', onToggle);
      // Most callers register before appending the summary and action buttons.
      queueMicrotask(() => { if (menus.has(menu)) sync(menu); });
      return menu;
    },
    unregister,
    activate() {
      if (listening || typeof documentRef?.addEventListener !== 'function') return;
      documentRef.addEventListener('click', handleDocumentClick);
      documentRef.addEventListener('keydown', handleDocumentKeydown, true);
      for (const menu of menus.keys()) sync(menu);
      listening = true;
    },
    deactivate() {
      if (listening) { documentRef.removeEventListener?.('click', handleDocumentClick); documentRef.removeEventListener?.('keydown', handleDocumentKeydown, true); }
      listening = false;
      reset();
    },
  });
}
