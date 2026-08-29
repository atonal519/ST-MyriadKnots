export function mobilePanelRect(width, height, safeTop = 0, safeBottom = 0) {
  return { left: 10, width: Math.max(0, width - 20), right: 10, top: 20 + safeTop, height: Math.max(0, height - 40 - safeTop - safeBottom), bottom: 20 + safeBottom };
}
