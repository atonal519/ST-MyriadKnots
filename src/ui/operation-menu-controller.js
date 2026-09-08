export function createOperationMenuController(documentRef) {
  const menus = new Set();
  let listening = false;

  const handleDocumentClick = event => {
    const path = typeof event?.composedPath === 'function' ? event.composedPath() : [];
    for (const menu of menus) {
      const clickedInside = path.includes(menu) || (!path.length && menu.contains?.(event?.target));
      if (menu.open && !clickedInside) menu.open = false;
    }
  };

  return Object.freeze({
    reset() { menus.clear(); },
    register(menu) { menus.add(menu); return menu; },
    activate() {
      if (listening || typeof documentRef?.addEventListener !== 'function') return;
      documentRef.addEventListener('click', handleDocumentClick);
      listening = true;
    },
    deactivate() {
      if (listening) documentRef.removeEventListener?.('click', handleDocumentClick);
      listening = false;
      menus.clear();
    },
  });
}
