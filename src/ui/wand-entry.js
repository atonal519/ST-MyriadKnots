import { KNOT_ICON_SVG } from './brand.js';

export function installWandEntry(onClick) {
  let entry; let observer;
  const add = () => {
    if (entry?.isConnected) { observer?.disconnect(); return true; }
    const parent = document.querySelector('#sp_wand_container') || document.querySelector('#extensionsMenu');
    if (!parent) return false;
    entry = document.createElement('div'); entry.id = 'qqj_open_wand'; entry.className = 'list-group-item flex-container flexGap5'; entry.style.display = 'flex'; entry.style.flexDirection = 'row'; entry.style.flexWrap = 'nowrap'; entry.style.alignItems = 'center'; entry.style.whiteSpace = 'nowrap'; entry.setAttribute('role', 'button'); entry.tabIndex = 0;
    const icon = document.createElement('span'); icon.className = 'extensionsMenuExtensionButton'; icon.style.flexShrink = '0'; icon.innerHTML = KNOT_ICON_SVG;
    Object.assign(icon.firstElementChild.style, { width: '100%', height: '100%', display: 'block' });
    const label = document.createElement('span'); label.textContent = '千千结'; entry.append(icon, label);
    entry.addEventListener('click', event => onClick?.(event)); entry.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick?.(event); } }); parent.append(entry); observer?.disconnect(); return true;
  };
  if (!add() && document.body) { observer = new MutationObserver(add); observer.observe(document.body, { childList: true, subtree: true }); }
  return () => { observer?.disconnect(); entry?.remove(); };
}
