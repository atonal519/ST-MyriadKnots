export function createOperationMenuController(documentRef) {
  const menus = new Map(), positioned = new WeakSet();
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
  const position = menu => {
    const { body } = parts(menu), view = documentRef?.defaultView;
    if (!body?.style || !menu.getBoundingClientRect || !view?.getComputedStyle) return;
    for (const key of ['top','bottom','maxHeight','overflowY','boxSizing']) body.style[key] = '';
    const anchor = menu.getBoundingClientRect(), natural = body.getBoundingClientRect();
    const gap = Math.max(0, natural.top - anchor.bottom);
    const viewport = view.visualViewport;
    let top = viewport?.offsetTop ?? 0, bottom = top + (viewport?.height ?? view.innerHeight);
    const parent = node => node.parentElement ?? node.parentNode?.host ?? node.parentNode;
    for (let node = parent(menu); node; node = parent(node)) {
      if (!node.getBoundingClientRect || !/auto|scroll|hidden|clip/u.test(view.getComputedStyle(node).overflowY)) continue;
      const rect = node.getBoundingClientRect(), edge = rect.top + (node.clientTop ?? 0);
      top = Math.max(top, edge); bottom = Math.min(bottom, edge + (node.clientHeight ?? rect.height));
    }
    const above = Math.max(0, anchor.top - top - gap), below = Math.max(0, bottom - anchor.bottom - gap);
    const up = natural.height > below && above > below;
    body.style.top = up ? 'auto' : `${anchor.height + gap}px`;
    body.style.bottom = up ? `${anchor.height + gap}px` : 'auto';
    body.style.maxHeight = `${up ? above : below}px`;
    body.style.boxSizing = 'border-box'; body.style.overflowY = 'auto';
  };
  const close = menu => { menu.open = false; positioned.delete(menu); sync(menu); };
  const inside = (menu, event, path) => path.includes(menu) || (!path.length && menu.contains?.(event?.target));
  const open = menu => {
    for (const other of menus.keys()) if (other !== menu && other.open) close(other);
    menu.open = true; sync(menu);
    if (!positioned.has(menu)) { position(menu); positioned.add(menu); }
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
      const area = parts(menu).body, item = available[next];
      if (area?.getBoundingClientRect && item?.getBoundingClientRect) {
        const bounds = area.getBoundingClientRect(), rect = item.getBoundingClientRect();
        if (rect.top < bounds.top) area.scrollTop -= bounds.top - rect.top;
        else if (rect.bottom > bounds.bottom) area.scrollTop += rect.bottom - bounds.bottom;
      }
    }
    event.preventDefault?.(); event.stopPropagation?.();
  };

  return Object.freeze({
    reset,
    register(menu) {
      if (menus.has(menu)) return menu;
      const onToggle = () => { if (menu.open) open(menu); else close(menu); };
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
