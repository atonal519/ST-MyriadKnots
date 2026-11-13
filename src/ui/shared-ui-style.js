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
  color_text: 'var(--ink,currentColor)',
  color_muted: 'var(--soft,currentColor)',
  color_accent: 'var(--knot,currentColor)',
  color_danger: 'var(--crimson,currentColor)',
  color_success: 'var(--success,currentColor)',
  color_surface: 'var(--panel,transparent)',
  color_line: 'var(--line,currentColor)',
  color_on_accent: 'var(--on-primary,#fff)',
  action_color: 'var(--qqj-color-muted)',
  item_color: 'var(--qqj-color-text)',
  disabled_color: 'var(--qqj-color-muted)',
  disabled_opacity: '.55',
  hover_background: 'color-mix(in srgb,var(--qqj-color-accent) 7%,var(--qqj-color-surface))',
  selected_background: 'color-mix(in srgb,var(--qqj-color-accent) 10%,var(--qqj-color-surface))',
  ...Object.fromEntries(Object.entries(QQJ_GEOMETRY_TOKENS)
    .filter(([key]) => key !== 'focus')
    .map(([key, value]) => [`radius_${key}`, `calc(${value} * var(--qqj-ui-scale,1))`])),
  radius_pill: '999px',
  chip_background: 'var(--panel,transparent)',
  chip_selected_background: 'var(--qqj-selected-background)',
  focus_ring: 'calc(2px * var(--qqj-ui-scale,1))',
  font_title: 'calc(24px * var(--qqj-ui-scale,1))',
  font_heading: 'calc(18px * var(--qqj-ui-scale,1))',
  font_subheading: 'calc(15px * var(--qqj-ui-scale,1))',
  font_body: 'calc(13px * var(--qqj-ui-scale,1))',
  font_caption: 'calc(12px * var(--qqj-ui-scale,1))',
  font_meta: 'calc(11px * var(--qqj-ui-scale,1))',
  button_scale: '.85',
  control_height: 'calc(36px * var(--qqj-ui-scale,1))',
  control_line: 'calc(20px * var(--qqj-ui-scale,1))',
  control_pad_y: 'calc(8px * var(--qqj-ui-scale,1) - 1px)',
  control_pad_x: 'calc(10px * var(--qqj-ui-scale,1))',
  radius_compact: 'calc(8px * 28 / 36 * var(--qqj-ui-scale,1))',
  compact_height: 'calc(28px * var(--qqj-ui-scale,1))',
  compact_line: 'calc(18px * var(--qqj-ui-scale,1))',
  compact_pad_y: 'calc(5px * var(--qqj-ui-scale,1) - 1px)',
  compact_pad_x: 'calc(8px * var(--qqj-ui-scale,1))',
  badge_height: 'calc(20px * var(--qqj-ui-scale,1))',
  badge_line: 'calc(16px * var(--qqj-ui-scale,1))',
  badge_pad_y: 'calc(2px * var(--qqj-ui-scale,1) - 1px)',
  badge_pad_x: 'calc(6px * var(--qqj-ui-scale,1))',
  icon_size: 'calc(32px * var(--qqj-button-scale,.85))',
  menu_icon_size: 'calc(28px * var(--qqj-button-scale,.85))',
  space_small: 'calc(4px * var(--qqj-ui-scale,1))',
  space_group: 'calc(8px * var(--qqj-ui-scale,1))',
  space_section: 'calc(12px * var(--qqj-ui-scale,1))',
  motion_fast: QQJ_MOTION_TOKENS.fast,
  motion_tab: QQJ_MOTION_TOKENS.tab,
});

const secondary = '.secondary-action,.sp-dialog-button-secondary,.qqj-update-status';
const menu = '.qqj-memory-menu-action,.qqj-profile-menu-action,.qqj-inline-select-option,.qqj-model-list-item,.qqj-qianshi-todo-row';
const icons = '.icon-btn,.qqj-memory-menu-toggle,.qqj-profile-menu-toggle,.qqj-cse-help,.qqj-people-order-handle,.extract,.exclude';
const navigation = '.tab,.recall-tab,.qqj-profile-tab,.qqj-relation-person,.event-pill,.person-pill';
const pills = '.qqj-profile-tab,.qqj-relation-person,.event-pill,.person-pill';
const controls = `${secondary},${menu},${icons},${navigation},.primary-action,.danger-action,.sp-dialog-button-primary,.qqj-inline-select-trigger`;
const selected = '.active,[aria-selected="true"],[aria-pressed="true"],[aria-expanded="true"]';
// Preserve the current 85% control geometry while text continues to follow appearance.
// Fields and surrounding layout keep their own scale; text buttons grow from content.
const buttonGeometryCss = `
:where(button,a.secondary-action,.qqj-memory-menu-toggle,.qqj-profile-menu-toggle){--qqj-control-height:0px;--qqj-control-line:calc(var(--qqj-font-body) * 20 / 13);--qqj-control-pad-y:calc(8px * var(--qqj-button-scale,.85) - 1px);--qqj-control-pad-x:calc(10px * var(--qqj-button-scale,.85));--qqj-compact-height:0px;--qqj-compact-line:calc(var(--qqj-font-caption) * 1.5);--qqj-compact-pad-y:calc(5px * var(--qqj-button-scale,.85) - 1px);--qqj-compact-pad-x:calc(8px * var(--qqj-button-scale,.85));--qqj-radius-control:calc(8px * var(--qqj-button-scale,.85));--qqj-radius-compact:calc(8px * 28 / 36 * var(--qqj-button-scale,.85));--qqj-radius-option:calc(6px * var(--qqj-button-scale,.85));--qqj-space-small:calc(4px * var(--qqj-button-scale,.85));--qqj-space-group:calc(8px * var(--qqj-button-scale,.85))}
`;
// Consumers use these local state values so a more specific component rule cannot
// turn a disabled or dangerous control back into an ordinary enabled action.
const interactionColorCss = `
:where(${secondary},${menu},${icons},${navigation}):is(:hover,:focus-visible,:active,${selected}):not(:disabled){--qqj-control-fg:var(--qqj-control-accent,var(--qqj-color-accent))}
:where(.tab,.recall-tab):is(.active,[aria-selected="true"]):not(:disabled){--qqj-control-fg:var(--qqj-color-text)}
:where(${secondary},${menu},${icons},${pills}):is(:hover,:focus-visible,:active):not(:disabled){--qqj-control-bg:var(--qqj-control-hover-bg,var(--qqj-hover-background))}
:where(${pills},.qqj-inline-select-option,.qqj-model-list-item):is(${selected}):not(:disabled){--qqj-control-bg:var(--qqj-selected-background);--qqj-control-border:var(--qqj-color-accent)}
.danger-action,:where(${controls}).danger{--qqj-control-fg:var(--qqj-color-danger);--qqj-control-accent:var(--qqj-color-danger);--qqj-control-hover-bg:color-mix(in srgb,var(--qqj-color-danger) 7%,var(--qqj-color-surface))}
:where(${controls}):disabled{--qqj-control-fg:var(--qqj-disabled-color);--qqj-control-opacity:var(--qqj-disabled-opacity);--qqj-control-bg:var(--qqj-control-disabled-bg,var(--qqj-color-line));--qqj-control-border:var(--qqj-color-line);opacity:var(--qqj-disabled-opacity)}
:where(${menu},${icons}):disabled{--qqj-control-disabled-bg:transparent}
:where(.qqj-memory-menu-action,.qqj-profile-menu-action):disabled{--qqj-control-border:transparent}
`;

const popoverMotionCss = `
@keyframes qqj-popover-in{from{opacity:0}to{opacity:1}}
.qqj-inline-select.open>.qqj-inline-select-options,.qqj-inline-select.open>.qqj-inline-select-search-panel,.qqj-profile-menu[open]>.qqj-profile-menu-pop,.qqj-memory-menu[open]>.qqj-memory-menu-pop{animation:qqj-popover-in var(--qqj-motion-fast) ease-out}
@media(prefers-reduced-motion:reduce){.qqj-inline-select.open>.qqj-inline-select-options,.qqj-inline-select.open>.qqj-inline-select-search-panel,.qqj-profile-menu[open]>.qqj-profile-menu-pop,.qqj-memory-menu[open]>.qqj-memory-menu-pop{animation:none}}
`;
const disclosureArrowCss = `
.settings-drawer-summary::before,.settings-group-summary::before,.settings-sub-summary::before,.qqj-inline-select-chevron,.qqj-model-list-chevron,.qqj-memory-chevron,.qqj-person-summary::before,.qqj-section-summary::before,.qqj-cse-floor-summary::before,.qqj-cse-floor-state-summary::before,.qqj-memory-key-quotes-summary::before,.qqj-window-unassigned-summary::before,.qqj-window-summary::before,.qqj-editor-group-summary::before,.qqj-help-section-summary::before{display:inline-flex;align-items:center;justify-content:center;flex:0 0 var(--qqj-font-heading);width:var(--qqj-font-heading);height:var(--qqj-font-heading);margin:0;font-size:var(--qqj-font-heading);font-weight:400;line-height:1;vertical-align:middle;transform-origin:center}
.qqj-memory-chevron,.qqj-memory-key-quotes-summary::before{background:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m9 18 6-6-6-6'/%3E%3C/svg%3E") center/100% 100% no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m9 18 6-6-6-6'/%3E%3C/svg%3E") center/100% 100% no-repeat}
`;
export const sharedUiCss = `:host{${cssVars(sharedTokens)}}${buttonGeometryCss}${interactionColorCss}${popoverMotionCss}${disclosureArrowCss}`;
export const sharedDialogCss = `.sp-root{${cssVars({ ...sharedTokens,
  color_text: 'var(--sp-on-surface)', color_muted: 'var(--sp-subtle)', color_accent: 'var(--sp-primary)',
  color_danger: 'var(--sp-danger)', color_success: 'var(--sp-success)', color_surface: 'var(--sp-sheet-bg)',
  color_line: 'var(--sp-divider)', color_on_accent: 'var(--sp-on-primary)',
})}}${buttonGeometryCss}${interactionColorCss}${popoverMotionCss}${disclosureArrowCss}`;
