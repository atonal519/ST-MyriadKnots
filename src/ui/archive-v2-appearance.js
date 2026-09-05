function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function sanitizeFamily(value) { return String(value ?? '').replace(/["\\\r\n]/g, ' ').replace(/\s+/g, ' ').trim(); }
function parseFontFamily(css) {
  const match = /@font-face\s*\{[^}]*?font-family\s*:\s*(['"]?)([^;'"}]+)\1/i.exec(String(css ?? ''));
  return match ? match[2].trim() : '';
}

export function applyArchiveV2Appearance({ host, root, settings, documentRef = globalThis.document, fetchImpl = globalThis.fetch } = {}) {
  const value = settings?.get?.() ?? settings ?? {};
  const theme = ['auto', 'day', 'night'].includes(value.appearanceTheme) ? value.appearanceTheme : 'auto';
  host?.setAttribute?.('data-qqj-theme', theme);
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
        if (family) {
          setFont(family);
          if (typeof settings?.update === 'function') settings.update({ appearanceFontFamily: family });
        }
      } catch { setFont(''); }
    })();
  }

  return { theme, scale, family: cachedFamily, fontCssUrl: url, fontReady };
}
