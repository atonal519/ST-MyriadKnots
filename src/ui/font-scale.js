export function normalizeFontScale(value) {
  if (value === null || value === undefined || typeof value === 'string' && value.trim() === '') return 1;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1.5, Math.max(0.75, number)) : 1;
}

export function fixedFontScale(value) {
  return normalizeFontScale(value) / 0.85;
}

export function scaleCssFontSizes(css, variable = '--qqj-ui-fixed-scale', preserveHost = false) {
  const size = '(-?(?:\\d+(?:\\.\\d+)?|\\.\\d+))px';
  const shorthand = new RegExp(`(^|[;{]\\s*font\\s*:\\s*)((?:(?:normal|italic|oblique|small-caps|bold|bolder|lighter|[1-9]00)\\s+)*)${size}(?=\\s*\\/|\\s)`, 'gim');
  const fontSize = new RegExp(`(^|[;{]\\s*font-size\\s*:\\s*)${size}(\\s*!important\\b)?(?=\\s*(?:;|}))`, 'gim');
  const source = String(css ?? '');
  const hostBlocks = [];
  const protectedCss = preserveHost ? source.replace(/(:host\s*\{[^{}]*\})/g, block => {
    const token = `__QQJ_HOST_FONT_BLOCK_${hostBlocks.length}__`;
    hostBlocks.push(block);
    return token;
  }) : source;
  const scaled = protectedCss
    .replace(shorthand, (match, prefix, weight, pixels) => `${prefix}${weight}calc(${pixels}px * var(${variable},1))`)
    .replace(fontSize, (match, prefix, pixels, important = '') => `${prefix}calc(${pixels}px * var(${variable},1))${important}`);
  return hostBlocks.reduce((result, block, index) => result.replace(`__QQJ_HOST_FONT_BLOCK_${index}__`, block), scaled);
}
