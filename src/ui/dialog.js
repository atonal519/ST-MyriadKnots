import { createGouhuaDialogCore } from './gouhua-dialog-core.js';
import { gouhuaDialogCss } from './gouhua-dialog-style.js';

const deepestActiveElement = documentRef => { let current = documentRef?.activeElement ?? null; while (current?.shadowRoot?.activeElement) current = current.shadowRoot.activeElement; return current; };
const restoreFocus = element => { try { element?.focus?.({ preventScroll: true }); } catch { element?.focus?.(); } };

// Thin QQJ adapter around Gouhua's production dialog manager. The copied core owns
// dialog markup, event handling, replacement, and Promise settlement.
export function createDialogManager({ documentRef = globalThis.document, $ = globalThis.jQuery ?? globalThis.$, schedule, subscribeContextChange } = {}) {
  if (!documentRef?.createElement) throw new TypeError('dialog documentRef 无效');
  if (typeof $ !== 'function') throw new TypeError('dialog jQuery 宿主依赖无效');
  const host = documentRef.createElement('div'); host.id = 'qqj-dialog-host';
  Object.assign(host.style ?? (host.style = {}), { position: 'fixed', top: '0', left: '0', width: '100dvw', height: '100dvh', zIndex: '2000003', pointerEvents: 'none' });
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${gouhuaDialogCss}</style>`;
  let effectiveTheme = 'day';
  const core = createGouhuaDialogCore({
    $,
    mount: { appendChild: element => root.appendChild(element) },
    removeOverlay: () => { const element = root.querySelector?.('#sp-addon-dialog'); if (element) $(element).remove(); },
    getRootClass: () => `sp-root sp-${effectiveTheme}`,
    captureFocus: () => deepestActiveElement(documentRef),
    restoreFocus,
    schedule,
    subscribeContextChange,
  });
  const info = ({ title = '', body = '', note = '', confirmText = '知道了' } = {}) => core.choose({ title, body, note, choices: [{ value: true, label: confirmText, primary: true }] }).then(value => value === true);
  return Object.freeze({
    host,
    confirm: core.confirm,
    prompt: core.prompt,
    custom: core.custom,
    info,
    hasActive: core.hasActive,
    cancelTop: core.cancelActive,
    closeAll: core.cancelActive,
    setAppearance({ mode = 'auto', effectiveTheme: nextTheme = 'day', palette = {} } = {}) {
      effectiveTheme = nextTheme === 'night' ? 'night' : 'day';
      host.setAttribute('data-theme-mode', mode); host.setAttribute('data-effective-theme', effectiveTheme);
      for (const [name, value] of Object.entries({ sheet: palette.panel, surface: palette.paper, ink: palette.ink, soft: palette.soft, divider: palette.line, primary: palette.knot })) if (value) host.style?.setProperty?.(`--qqj-dialog-${name}`, value);
    },
  });
}
