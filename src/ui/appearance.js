function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function sanitizeFamily(value) { return String(value ?? '').replace(/["\\\r\n]/g, ' ').replace(/\s+/g, ' ').trim(); }
function parseFontFamily(css) {
  const match = /@font-face\s*\{[^}]*?font-family\s*:\s*(['"]?)([^;'"}]+)\1/i.exec(String(css ?? ''));
  return match ? match[2].trim() : '';
}

const PALETTES = Object.freeze({
  day: Object.freeze({ paper: '#f7f8fa', panel: '#ffffff', ink: '#22282b', soft: '#637077', faint: '#929da2', line: '#dce2e5', thread: '#cbd4d8', crimson: '#b63745', knot: '#b63745', blue: '#4f8781', success: '#4b7d63' }),
  night: Object.freeze({ paper: '#13181b', panel: '#1c2327', ink: '#e7ecee', soft: '#9db0b5', faint: '#6c7c81', line: '#2b363b', thread: '#33424a', crimson: '#d9707a', knot: '#d9707a', blue: '#77b0aa', success: '#77b193' }),
});
const AUTO_FALLBACK_PALETTES = Object.freeze({
  day: Object.freeze({ paper: '#e8ecec', panel: '#f6f8f8', ink: '#22282b', soft: '#5c6a70', faint: '#93a1a5', line: '#d0d9db', thread: '#c1ccce', crimson: '#a8322f', knot: '#a8322f', blue: '#4f8781', success: '#4b7d63' }),
  night: PALETTES.night,
});
const opaqueRgb = values => {
  const channels = values.map(value => value.endsWith('%') ? Math.round(Math.min(100, Math.max(0, Number.parseFloat(value))) * 2.55) : Math.round(Math.min(255, Math.max(0, Number.parseFloat(value)))));
  return { value: `rgb(${channels.join(', ')})`, rgb: channels };
};
const cssColor = (documentRef, raw) => {
  const value = text(raw); if (!value) return null;
  if (value.toLowerCase() === 'transparent') return null;
  const hex = /^#([\da-f]{3,8})$/iu.exec(value);
  if (hex) {
    const body = hex[1], expanded = body.length <= 4 ? [...body].map(ch => ch + ch).join('') : body;
    if (![6, 8].includes(expanded.length)) return null;
    const opaque = expanded.slice(0, 6), number = Number.parseInt(opaque, 16);
    return { value: `#${opaque}`, rgb: [number >> 16, (number >> 8) & 255, number & 255] };
  }
  const rgb = /^rgba?\(\s*([\d.]+%?)\s*(?:,|\s)\s*([\d.]+%?)\s*(?:,|\s)\s*([\d.]+%?)(?:\s*(?:,|\/)\s*[\d.]+%?)?\s*\)$/iu.exec(value);
  if (rgb) return opaqueRgb(rgb.slice(1, 4));
  try {
    const canvas = documentRef?.createElement?.('canvas'), context = canvas?.getContext?.('2d'); if (!context) return null;
    context.fillStyle = '#010203'; context.fillStyle = value; if (context.fillStyle === '#010203' && value.toLowerCase() !== '#010203') return null;
    context.clearRect(0, 0, 1, 1); context.fillRect(0, 0, 1, 1); const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return { value: `rgb(${r}, ${g}, ${b})`, rgb: [r, g, b] };
  } catch { return null; }
};
const hostSignals = ({ documentRef, windowRef }) => {
  try {
    const computed = windowRef?.getComputedStyle?.(documentRef?.documentElement); if (!computed) return {};
    const read = name => text(computed.getPropertyValue(name));
    return { body: read('--SmartThemeBodyColor'), quote: read('--SmartThemeQuoteColor'), chat: read('--SmartThemeChatTintColor'), bot: read('--SmartThemeBotMesBlurTintColor'), user: read('--SmartThemeUserMesBlurTintColor') };
  } catch { return {}; }
};
const channel = value => Math.min(255, Math.max(0, Number(value) || 0));
const luminance = parsed => parsed?.rgb ? .2126 * channel(parsed.rgb[0]) + .7152 * channel(parsed.rgb[1]) + .0722 * channel(parsed.rgb[2]) : null;

export function resolveAppearance({ value = {}, documentRef = globalThis.document, windowRef = documentRef?.defaultView ?? globalThis } = {}) {
  const mode = ['auto', 'day', 'night'].includes(value.appearanceTheme) ? value.appearanceTheme : 'auto';
  const signals = hostSignals({ documentRef, windowRef }), bodyColor = cssColor(documentRef, signals.body);
  const hostTheme = bodyColor ? ((luminance(bodyColor) ?? 0) > 127 ? 'night' : 'day') : null;
  const systemTheme = windowRef?.matchMedia?.('(prefers-color-scheme: light)')?.matches ? 'day' : 'night';
  const effectiveTheme = mode === 'auto' ? (hostTheme ?? systemTheme) : mode;
  const palette = (mode === 'auto' ? AUTO_FALLBACK_PALETTES : PALETTES)[effectiveTheme];
  if (mode !== 'auto') return { mode, effectiveTheme, palette, hasHostSignal: Boolean(hostTheme) };
  const opaque = (raw, fallback) => cssColor(documentRef, raw)?.value ?? fallback;
  return {
    mode, effectiveTheme, hasHostSignal: Boolean(hostTheme),
    palette: {
      ...palette,
      ink: opaque(signals.body, palette.ink), knot: opaque(signals.quote, palette.knot), crimson: opaque(signals.quote, palette.crimson), blue: opaque(signals.quote, palette.blue),
      paper: opaque(signals.chat, palette.paper), panel: opaque(signals.bot, palette.panel), thread: opaque(signals.user, palette.thread),
    },
  };
}

export function applyAppearance({ host, root, settings, documentRef = globalThis.document, windowRef = documentRef?.defaultView ?? globalThis, fetchImpl = globalThis.fetch } = {}) {
  const value = settings?.get?.() ?? settings ?? {};
  const appearance = resolveAppearance({ value, documentRef, windowRef });
  host?.setAttribute?.('data-qqj-theme', appearance.effectiveTheme);
  host?.setAttribute?.('data-qqj-theme-mode', appearance.mode);
  for (const [name, color] of Object.entries(appearance.palette)) host?.style?.setProperty?.(`--${name}`, color);
  const scale = Math.min(1.5, Math.max(0.75, Number(value.appearanceScale) || 1));
  host?.style?.setProperty?.('--qqj-ui-scale', String(scale));

  const url = text(value.appearanceFontCssUrl);
  const cachedFamily = sanitizeFamily(value.appearanceFontFamily);
  const setFont = family => host?.style?.setProperty?.('--qqj-custom-font', family ? `"${family}"` : 'system-ui');

  const old = root?.querySelector?.('link[data-qqj-custom-font]');
  if (!url) old?.remove?.();
  else if (old?.href !== url) {
    old?.remove?.();
    const link = documentRef.createElement('link'); link.rel = 'stylesheet'; link.href = url; link.setAttribute?.('data-qqj-custom-font', 'true'); root?.append?.(link);
  }

  // 字体 family 不再由用户填写：URL 存在时从该 CSS 自动解析并缓存，跨域读不到时回退系统字体。
  let fontReady = Promise.resolve();
  if (!url) {
    setFont('');
    if (cachedFamily && typeof settings?.update === 'function') settings.update({ appearanceFontFamily: '' });
  } else if (cachedFamily) {
    setFont(cachedFamily);
  } else {
    setFont('');
    fontReady = (async () => {
      try {
        const response = await fetchImpl(url);
        const cssText = typeof response?.text === 'function' ? await response.text() : String(response ?? '');
        const family = sanitizeFamily(parseFontFamily(cssText));
        if (text((settings?.get?.() ?? settings ?? {}).appearanceFontCssUrl) !== url) return;
        if (family) {
          setFont(family);
          if (typeof settings?.update === 'function') settings.update({ appearanceFontFamily: family });
        }
      } catch {
        if (text((settings?.get?.() ?? settings ?? {}).appearanceFontCssUrl) === url) setFont('');
      }
    })();
  }

  return { theme: appearance.mode, mode: appearance.mode, effectiveTheme: appearance.effectiveTheme, hasHostSignal: appearance.hasHostSignal, palette: appearance.palette, scale, family: cachedFamily, fontCssUrl: url, fontReady };
}

export function createAppearanceController({ host, root, settings, documentRef = globalThis.document, windowRef = documentRef?.defaultView ?? globalThis, fetchImpl = globalThis.fetch, onChange } = {}) {
  let destroyed = false, current = null;
  const apply = () => { if (destroyed) return current; current = applyAppearance({ host, root, settings, documentRef, windowRef, fetchImpl }); onChange?.(current); return current; };
  const Observer = windowRef?.MutationObserver ?? globalThis.MutationObserver;
  const observer = typeof Observer === 'function' && documentRef?.documentElement ? new Observer(() => { if ((settings?.get?.() ?? settings)?.appearanceTheme === 'auto') apply(); }) : null;
  observer?.observe?.(documentRef.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  const media = windowRef?.matchMedia?.('(prefers-color-scheme: light)');
  const onSystem = () => { const value = settings?.get?.() ?? settings ?? {}; if (value.appearanceTheme === 'auto' && !resolveAppearance({ value, documentRef, windowRef }).hasHostSignal) apply(); };
  media?.addEventListener?.('change', onSystem);
  apply();
  return Object.freeze({ apply, getState: () => current, destroy() { destroyed = true; observer?.disconnect?.(); media?.removeEventListener?.('change', onSystem); } });
}
