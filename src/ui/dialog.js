import { createGouhuaDialogCore } from './gouhua-dialog-core.js';
import { gouhuaDialogCss } from './gouhua-dialog-style.js';
import { scaleCssSpacing } from './font-scale.js';

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
  root.innerHTML = `<style>${scaleCssSpacing(gouhuaDialogCss)}</style>`;
  let effectiveTheme = 'day';
  let dialogFontUrl = '', dialogFontLink = null;
  const viewport = documentRef.defaultView;
  const bindDialogViewport = () => {
    if (!viewport) return () => {};
    const visual = viewport.visualViewport;
    const sync = () => {
      Object.assign(host.style, { left: '0px', top: '0px', width: `${visual?.width || viewport.innerWidth}px`, height: `${visual?.height || viewport.innerHeight}px` });
      // 宿主 html 的 transform 会改变 fixed 原点，补偿后仍对齐可视视口。
      const origin = host.getBoundingClientRect();
      host.style.left = `${(visual?.offsetLeft || 0) - origin.left}px`;
      host.style.top = `${(visual?.offsetTop || 0) - origin.top}px`;
    };
    const listeners = [[viewport, 'resize'], [viewport, 'scroll'], [viewport, 'orientationchange'], [visual, 'resize'], [visual, 'scroll']];
    sync();
    for (const [target, type] of listeners) target?.addEventListener(type, sync);
    return () => { for (const [target, type] of listeners) target?.removeEventListener(type, sync); };
  };
  const core = createGouhuaDialogCore({
    $,
    mount: { appendChild: element => root.appendChild(element) },
    removeOverlay: () => { const element = root.querySelector?.('#sp-addon-dialog'); if (element) $(element).remove(); },
    getRootClass: () => `sp-root sp-${effectiveTheme}`,
    captureFocus: () => deepestActiveElement(documentRef),
    restoreFocus,
    schedule,
    subscribeContextChange: close => {
      const stopViewport = bindDialogViewport();
      const stopContext = subscribeContextChange?.(close);
      return () => { stopViewport(); stopContext?.(); };
    },
  });
  const info = ({ title = '', body = '', note = '', confirmText = '知道了' } = {}) => core.choose({ title, body, note, choices: [{ value: true, label: confirmText, primary: true }] }).then(value => value === true);
  return Object.freeze({
    host,
    confirm: core.confirm,
    choose: core.choose,
    prompt: core.prompt,
    custom: core.custom,
    info,
    hasActive: core.hasActive,
    cancelTop: core.cancelActive,
    closeAll: core.cancelActive,
    setAppearance({ mode = 'auto', effectiveTheme: nextTheme = 'day', palette = {}, scale, fixedScale = 1, family = '', fontCssUrl = '' } = {}) {
      effectiveTheme = nextTheme === 'night' ? 'night' : 'day';
      host.setAttribute('data-theme-mode', mode); host.setAttribute('data-effective-theme', effectiveTheme);
      host.style?.setProperty?.('--qqj-ui-scale', String(Number.isFinite(Number(scale)) ? Number(scale) : Number.isFinite(Number(fixedScale)) ? Number(fixedScale) * 0.85 : 1));
      host.style?.setProperty?.('--qqj-dialog-scale', String(Number.isFinite(Number(fixedScale)) ? Number(fixedScale) : 1));
      for (const [name, value] of Object.entries({ sheet: palette.panel, surface: palette.paper, ink: palette.ink, soft: palette.soft, divider: palette.line, primary: palette.knot, danger: palette.crimson, success: palette.success, blue: palette.blue, 'on-primary': palette.onPrimary })) if (value) host.style?.setProperty?.(`--qqj-dialog-${name}`, value);
      const safeFamily = fontCssUrl && typeof family === 'string' ? family.replace(/["\\\r\n]/g, ' ').replace(/\s+/g, ' ').trim() : '';
      host.style?.setProperty?.('--qqj-dialog-font', safeFamily ? `"${safeFamily}"` : 'system-ui');
      if (fontCssUrl !== dialogFontUrl) {
        dialogFontLink?.remove?.(); dialogFontLink = null; dialogFontUrl = fontCssUrl;
        if (fontCssUrl) {
          dialogFontLink = documentRef.createElement('link'); dialogFontLink.rel = 'stylesheet'; dialogFontLink.href = fontCssUrl;
          dialogFontLink.setAttribute('data-qqj-dialog-font', 'true'); root.appendChild(dialogFontLink);
        }
      }
    },
  });
}
