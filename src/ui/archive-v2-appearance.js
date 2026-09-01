function text(value) { return typeof value === 'string' ? value.trim() : ''; }

export function applyArchiveV2Appearance({ host, root, settings, documentRef = globalThis.document } = {}) {
  const value = settings?.get?.() ?? settings ?? {};
  const theme = ['auto', 'day', 'night'].includes(value.appearanceTheme) ? value.appearanceTheme : 'auto';
  host?.setAttribute?.('data-qqj-theme', theme);
  const scale = Math.min(1.5, Math.max(0.75, Number(value.appearanceScale) || 1));
  host?.style?.setProperty?.('--qqj-ui-scale', String(scale));
  const family = text(value.appearanceFontFamily);
  const safeFamily = family.replace(/["\\\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
  host?.style?.setProperty?.('--qqj-custom-font', safeFamily ? `"${safeFamily}"` : 'system-ui');
  const old = root?.querySelector?.('link[data-qqj-custom-font]');
  const url = text(value.appearanceFontCssUrl);
  if (!url) old?.remove?.();
  else if (old?.href !== url) {
    old?.remove?.();
    const link = documentRef.createElement('link'); link.rel = 'stylesheet'; link.href = url; link.setAttribute?.('data-qqj-custom-font', 'true'); root?.append?.(link);
  }
  return { theme, scale, family, fontCssUrl: url };
}
