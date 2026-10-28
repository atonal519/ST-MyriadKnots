// Shared visual vocabulary for QQJ's independent ShadowRoot surfaces.
// Keep semantic tiers distinct: panel/dialog roots consume these values locally.
export const QQJ_GEOMETRY_TOKENS = Object.freeze({
  control: '8px',
  field: '8px',
  option: '6px',
  card: '10px',
  dialog: '12px',
  panel: '14px',
  focus: '2px',
});

export const QQJ_MOTION_TOKENS = Object.freeze({ fast: '150ms', tab: '180ms' });

const cssVars = (entries) => Object.entries(entries)
  .map(([name, value]) => `  --qqj-${name.replaceAll('_', '-')}: ${value};`)
  .join('\n');

const sharedTokens = Object.freeze({
  ...Object.fromEntries(Object.entries(QQJ_GEOMETRY_TOKENS)
    .filter(([key]) => key !== 'focus')
    .map(([key, value]) => [`radius_${key}`, value])),
  focus_ring: QQJ_GEOMETRY_TOKENS.focus,
  motion_fast: QQJ_MOTION_TOKENS.fast,
  motion_tab: QQJ_MOTION_TOKENS.tab,
});

const popoverMotionCss = `
@keyframes qqj-popover-in{from{opacity:0}to{opacity:1}}
.qqj-inline-select.open>.qqj-inline-select-options,.qqj-profile-menu[open]>.qqj-profile-menu-pop,.qqj-memory-menu[open]>.qqj-memory-menu-pop{animation:qqj-popover-in var(--qqj-motion-fast) ease-out}
@media(prefers-reduced-motion:reduce){.qqj-inline-select.open>.qqj-inline-select-options,.qqj-profile-menu[open]>.qqj-profile-menu-pop,.qqj-memory-menu[open]>.qqj-memory-menu-pop{animation:none}}
`;
export const sharedUiCss = `:host{${cssVars(sharedTokens)}}${popoverMotionCss}`;
export const sharedDialogCss = `.sp-root{${cssVars(sharedTokens)}}${popoverMotionCss}`;
