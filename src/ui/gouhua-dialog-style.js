import { scrollbarCss } from './scrollbar-style.js';
import { sharedDialogCss } from './shared-ui-style.js';

// Dependency-closed subset copied from ST-SevenDaysCal/style.css @ fb93e5466c14fa28158004454790100a0f284f53.
// QQJ-only palette bridge is isolated in .sp-root and keeps sheet/input surfaces opaque.
export const gouhuaDialogCss = `${scrollbarCss}${sharedDialogCss}
:host{position:fixed;top:0;left:0;width:100vw;width:100dvw;height:100vh;height:100dvh;z-index:2000003;display:block;overflow:hidden;pointer-events:none}
*{box-sizing:border-box}
.sp-root{
    --sp-scale:var(--qqj-ui-scale,1);
    --sp-font:var(--qqj-dialog-font,-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',Arial,sans-serif);
    --sp-fs-72:var(--qqj-font-meta);
    --sp-fs-75:var(--qqj-font-caption);
    --sp-fs-83:var(--qqj-font-body);
    --sp-fs-85:var(--qqj-font-body);
    --sp-fs-95:var(--qqj-font-subheading);
    --sp-fs-100:var(--qqj-font-body);
    --sp-sheet-bg:var(--qqj-dialog-sheet,#f6f8f8);
    --sp-sheet-bg-legacy:var(--qqj-dialog-sheet,#f6f8f8);
    --sp-on-surface:var(--qqj-dialog-ink,#22282b);
    --sp-subtle:var(--qqj-dialog-soft,#5c6a70);
    --sp-primary:var(--qqj-dialog-primary,#a8322f);
    --sp-danger:var(--qqj-dialog-danger,#b63745);
    --sp-success:var(--qqj-dialog-success,#3d6f55);
    --sp-blue:var(--qqj-dialog-blue,#3b706a);
    --sp-on-primary:var(--qqj-dialog-on-primary,#fff);
    --sp-divider:var(--qqj-dialog-divider,#d0d9db);
    --sp-surface-high:var(--qqj-dialog-surface,#e8ecec);
    --sp-hover-bg:color-mix(in srgb,var(--sp-primary) 9%,var(--sp-sheet-bg));
    position:fixed;
    z-index:2000001;
    font-family:var(--sp-font);
    font-size:var(--sp-fs-100);
    line-height:normal;
    letter-spacing:normal;
    word-spacing:normal;
    text-indent:0;
    text-align:left;
    text-transform:none;
    font-style:normal;
    font-variant:normal;
    white-space:normal;
}
.sp-root,.sp-root *{text-shadow:none!important}
/* Keep the complete focus ring inside controls at scroll and rounded clipping edges. */
.sp-root :is(button,summary,input,textarea,select,a,[tabindex]):focus-visible{outline:var(--qqj-focus-ring) solid var(--sp-primary);outline-offset:calc(-1 * var(--qqj-focus-ring))}
.sp-root :is(.sp-dialog-button-primary,.primary-action):focus-visible{outline-color:var(--sp-on-primary)}
.sp-root label:has(>input:is([type=checkbox],[type=radio]):focus-visible){outline:var(--qqj-focus-ring) solid var(--sp-primary);outline-offset:calc(-1 * var(--qqj-focus-ring));border-radius:var(--qqj-radius-option)}
.sp-root .qqj-profile-menu-toggle{border-radius:var(--qqj-radius-control);color:var(--qqj-control-fg,var(--qqj-action-color))}
.sp-night{--sp-shadow:0 8px 40px rgba(0,0,0,.65),0 2px 10px rgba(0,0,0,.45)}
.sp-day{--sp-shadow:0 8px 40px rgba(0,0,0,.12),0 2px 10px rgba(0,0,0,.07)}
@media(max-width:640px){.sp-root{position:fixed;top:0;left:0;right:auto;bottom:auto;width:100dvw;height:100dvh;pointer-events:none}}
@keyframes sp-wi-fullview-in{from{opacity:0}to{opacity:1}}
.sp-dialog-overlay{position:absolute;inset:0;width:auto;height:auto;box-sizing:border-box;z-index:2000002;pointer-events:auto;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:20px;animation:sp-wi-fullview-in var(--qqj-motion-fast) ease-out}
.sp-dialog-sheet{background-color:var(--sp-sheet-bg-legacy);background-image:linear-gradient(var(--sp-sheet-bg),var(--sp-sheet-bg));border-radius:var(--qqj-radius-dialog);width:400px;max-width:100%;max-height:100%;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:16px 18px 14px;box-shadow:var(--sp-shadow);display:flex;flex-direction:column;gap:10px}
.sp-dialog-sheet>.sp-dialog-head,.sp-dialog-sheet>.sp-dialog-input,.sp-dialog-sheet>.sp-dialog-input-error,.sp-dialog-sheet>.sp-dialog-actions{flex:0 0 auto}
.sp-dialog-head{min-width:0;overflow-wrap:anywhere;font-size:var(--sp-fs-95);font-weight:600;color:var(--sp-on-surface)}
.sp-dialog-content{display:grid;min-height:0;gap:10px;overflow-y:auto;overscroll-behavior:contain}
.sp-dialog-body{font-size:var(--sp-fs-85);line-height:1.65;color:var(--sp-on-surface);white-space:pre-wrap;word-break:break-word}
.sp-dialog-note{font-size:var(--sp-fs-75);color:var(--sp-subtle);line-height:1.55;padding:8px 10px;background:var(--sp-hover-bg);border-radius:var(--qqj-radius-option);border-left:2px solid var(--sp-divider)}
.sp-dialog-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px;margin-top:4px}
.sp-dialog-button{font-family:var(--sp-font);cursor:pointer;transition:opacity .15s;min-height:var(--qqj-control-height);padding:var(--qqj-control-pad-y) var(--qqj-control-pad-x);font-size:var(--qqj-font-body);line-height:var(--qqj-control-line);font-weight:500;border-radius:var(--qqj-radius-control);width:auto;max-width:100%;white-space:normal;overflow-wrap:anywhere;display:inline-flex;align-items:center;justify-content:center;text-align:center;justify-self:start;flex:0 1 auto;border:1px solid transparent}
.sp-dialog-button-secondary{background:var(--qqj-control-bg,var(--qqj-color-surface));color:var(--qqj-control-fg,var(--qqj-action-color));border:1px solid var(--sp-divider);border-color:var(--qqj-control-border,var(--qqj-color-line))}
.sp-dialog-button-secondary:hover{color:var(--qqj-control-fg,var(--qqj-action-color));border-color:var(--qqj-control-border,var(--qqj-color-line))}
.sp-dialog-button-primary{background:var(--qqj-control-bg,var(--qqj-color-accent));color:var(--qqj-control-fg,var(--qqj-color-on-accent))}
.sp-dialog-button-primary:hover:not(:disabled){opacity:.88}
.sp-dialog-input{width:100%;box-sizing:border-box;background-color:var(--sp-sheet-bg-legacy);background-image:linear-gradient(var(--sp-sheet-bg),var(--sp-sheet-bg));border:1px solid var(--sp-divider);color:var(--sp-on-surface);font-family:var(--sp-font);outline:none;min-height:var(--qqj-control-height);padding:var(--qqj-control-pad-y) var(--qqj-control-pad-x);font-size:var(--qqj-font-body);line-height:var(--qqj-control-line);font-weight:400;border-radius:var(--qqj-radius-field)}
.sp-dialog-input:focus{border-color:var(--sp-primary)}
.sp-dialog-input-error{min-height:1em;color:var(--qqj-color-danger);font-size:var(--qqj-font-caption);line-height:1.4}
.sp-dialog-input-error i{color:inherit;margin-right:3px}
.sp-dialog-sheet-custom{overflow:hidden}
.sp-dialog-custom{min-height:0;overflow-y:auto;overscroll-behavior:contain}
.sp-dialog-sheet-custom:has(.qqj-editor-dialog){max-height:min(80dvh,100%)}
.sp-dialog-sheet-custom:has(.qqj-editor-dialog)>.sp-dialog-custom{flex:1 1 auto;min-height:0}
.sp-dialog-sheet-custom:has(.qqj-editor-dialog)>.sp-dialog-head,.sp-dialog-sheet-custom:has(.qqj-editor-dialog)>.sp-dialog-input-error,.sp-dialog-sheet-custom:has(.qqj-editor-dialog)>.sp-dialog-actions{flex:0 0 auto}
@media(max-height:540px){.sp-dialog-overlay:has(.qqj-editor-dialog){padding:10px}.sp-dialog-sheet-custom:has(.qqj-editor-dialog){max-height:100%;padding:12px 14px;gap:8px}.sp-dialog-sheet-custom:has(.qqj-editor-dialog)>.sp-dialog-input-error:empty{display:none}}
.qqj-editor-dialog{display:grid;min-width:0;gap:12px;color:var(--sp-on-surface);font-family:var(--sp-font);font-size:var(--sp-fs-83);line-height:1.55}
.qqj-qianshi-todo{gap:8px}.qqj-qianshi-todo-scroll{display:grid;max-height:min(58dvh,480px);gap:4px;overflow-y:auto;overscroll-behavior:contain;padding:2px;border:1px solid var(--sp-divider);border-radius:var(--qqj-radius-field)}.qqj-qianshi-todo-row{appearance:none;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px;width:100%;min-width:0;margin:0;padding:8px 9px;border:0;border-radius:var(--qqj-radius-option);background:var(--qqj-control-bg,transparent);color:var(--qqj-control-fg,var(--qqj-item-color));font:inherit;font-size:var(--sp-fs-83);line-height:1.45;text-align:left;cursor:pointer;border-color:var(--qqj-control-border,transparent)}.qqj-qianshi-todo-row:hover,.qqj-qianshi-todo-row:focus-visible{background:var(--qqj-control-bg,transparent);color:var(--qqj-control-fg,var(--qqj-item-color))}.qqj-qianshi-todo-title{min-width:0;overflow-wrap:anywhere}.qqj-qianshi-todo-status{color:var(--sp-subtle);white-space:nowrap}.qqj-qianshi-todo-pager{display:flex;justify-content:space-between;gap:8px}.qqj-qianshi-todo-empty{margin:0;padding:10px;color:var(--sp-subtle);text-align:center}
.qqj-editor-intro{margin:0;padding:8px 10px;border-left:2px solid var(--sp-primary);border-radius:var(--qqj-radius-option);background:var(--sp-hover-bg);color:var(--sp-subtle);font-size:var(--sp-fs-75);overflow-wrap:anywhere}
.qqj-editor-group{display:grid;min-width:0;gap:8px;margin:0;padding:0;border:0}
.qqj-editor-dialog details.qqj-editor-group{display:block}
.qqj-editor-dialog .qqj-editor-group>:not(h3):not(.qqj-editor-group-summary){min-width:0;max-width:calc(100% - 12px);margin-inline-start:12px}
.qqj-editor-dialog details.qqj-editor-group>:not(summary){margin-block-start:8px}
.qqj-editor-group>h3{display:flex;align-items:center;margin:0;padding:0 0 5px;border-bottom:1px solid var(--sp-divider);color:var(--sp-on-surface);font-size:var(--sp-fs-85);font-weight:650;line-height:1.4}
.qqj-editor-group>h3::before{content:"";flex:0 0 12px;width:12px}
.qqj-editor-group-summary{display:flex;align-items:center;gap:var(--qqj-space-group);padding:7px var(--qqj-space-group);border-bottom:1px solid var(--sp-divider);color:var(--sp-on-surface);font-size:var(--sp-fs-85);font-weight:650;line-height:1.4;cursor:pointer;list-style:none}
.qqj-editor-group-summary::-webkit-details-marker{display:none}
.qqj-editor-group-summary::before{content:"›";color:var(--sp-subtle);font-weight:400;transition:transform .15s ease}
.qqj-editor-dialog details.qqj-editor-group[open]>.qqj-editor-group-summary::before{transform:rotate(90deg)}
.qqj-editor-dialog label{display:grid;min-width:0;gap:5px;color:var(--sp-subtle);font-size:var(--qqj-font-body);line-height:1.45}
.qqj-editor-dialog input.settings-input,.qqj-editor-dialog textarea.settings-input,.qqj-editor-dialog select.settings-input{width:100%;min-width:0;margin:0;border:1px solid var(--sp-divider);background:var(--sp-sheet-bg);color:var(--sp-on-surface);font:inherit;min-height:var(--qqj-control-height);padding:var(--qqj-control-pad-y) var(--qqj-control-pad-x);font-size:var(--qqj-font-body);line-height:var(--qqj-control-line);font-weight:400;border-radius:var(--qqj-radius-field)}
.qqj-editor-dialog textarea{min-height:80px;resize:vertical;white-space:pre-wrap;overflow-wrap:anywhere}
.qqj-editor-dialog .qqj-editor-textarea{min-height:min(42dvh,360px)}
.qqj-editor-inline-actions{display:flex;flex-wrap:wrap;gap:7px}
.qqj-editor-dialog button.secondary-action,.qqj-editor-dialog button.primary-action,.qqj-avatar-crop-panel button.secondary-action,.qqj-avatar-crop-panel a.secondary-action{appearance:none;box-sizing:border-box;margin:0;border:1px solid var(--sp-divider);background:var(--qqj-control-bg,var(--qqj-color-surface));color:var(--qqj-control-fg,var(--qqj-action-color));font:inherit;cursor:pointer;min-height:var(--qqj-control-height);padding:var(--qqj-control-pad-y) var(--qqj-control-pad-x);font-size:var(--qqj-font-body);line-height:var(--qqj-control-line);font-weight:500;border-radius:var(--qqj-radius-control);width:auto;max-width:100%;white-space:normal;overflow-wrap:anywhere;display:inline-flex;align-items:center;justify-content:center;text-align:center;justify-self:start;flex:0 1 auto;border-color:var(--qqj-control-border,var(--qqj-color-line))}
.qqj-editor-dialog button.primary-action{border-color:var(--qqj-control-border,var(--qqj-color-accent));background:var(--qqj-control-bg,var(--qqj-color-accent));color:var(--qqj-control-fg,var(--qqj-color-on-accent))}
.qqj-editor-dialog button:disabled{opacity:var(--qqj-disabled-opacity);cursor:not-allowed}
.qqj-editor-dialog .qqj-inline-select{display:grid;align-content:start;min-width:0;flex:1 1 110px}
.qqj-editor-dialog .qqj-inline-select-trigger{appearance:none;display:flex;align-items:center;justify-content:space-between;width:100%;min-width:0;border:1px solid var(--sp-divider);background:var(--qqj-control-bg,var(--qqj-color-surface));color:var(--qqj-control-fg,var(--qqj-item-color));font:inherit;text-align:left;cursor:pointer;min-height:var(--qqj-control-height);padding:var(--qqj-control-pad-y) var(--qqj-control-pad-x);font-size:var(--qqj-font-body);line-height:var(--qqj-control-line);border-radius:var(--qqj-radius-control);font-weight:400;gap:var(--qqj-space-group);border-color:var(--qqj-control-border,var(--qqj-color-line))}
.qqj-editor-dialog .qqj-inline-select-value{flex:1 1 auto;min-width:0;font-size:var(--qqj-font-body);white-space:normal;text-overflow:clip;overflow:visible;overflow-wrap:anywhere}
.qqj-editor-dialog .qqj-inline-select-chevron{color:var(--sp-subtle);transform:rotate(90deg);transition:transform .15s ease}
.qqj-editor-dialog .qqj-inline-select.open>.qqj-inline-select-trigger .qqj-inline-select-chevron{transform:rotate(-90deg);color:var(--qqj-control-fg,var(--qqj-item-color))}
.qqj-editor-dialog .qqj-inline-select-options{display:grid;grid-auto-rows:max-content;align-content:start;margin-top:4px;max-height:min(220px,34dvh);overflow:auto;padding:3px;border:1px solid var(--sp-divider);border-radius:var(--qqj-radius-field);background:var(--sp-sheet-bg);font-size:var(--sp-fs-83)}
.qqj-editor-dialog .qqj-inline-select-options[hidden]{display:none}
.qqj-editor-dialog .qqj-inline-select-option{width:100%;min-width:0;background:var(--qqj-control-bg,transparent);color:var(--qqj-control-fg,var(--qqj-item-color));font:inherit;text-align:left;cursor:pointer;min-height:var(--qqj-control-height);padding:var(--qqj-control-pad-y) var(--qqj-control-pad-x);font-size:var(--qqj-font-body);line-height:var(--qqj-control-line);border-radius:var(--qqj-radius-option);white-space:normal;overflow-wrap:anywhere;border:1px solid transparent;font-weight:400;border-color:var(--qqj-control-border,transparent)}
.qqj-editor-dialog .qqj-inline-select-option.active,.qqj-editor-dialog .qqj-inline-select-option:hover{background:var(--qqj-control-bg,transparent);color:var(--qqj-control-fg,var(--qqj-item-color))}
.qqj-editor-dialog input[type=checkbox]{width:calc(16px * var(--qqj-ui-scale,1));height:calc(16px * var(--qqj-ui-scale,1));accent-color:var(--sp-primary)}
.qqj-editor-dialog .qqj-cse-edit-row{display:grid;min-width:0;gap:7px;padding:8px 0;border-bottom:1px solid var(--sp-divider)}
.qqj-editor-dialog .qqj-cse-edit-meta{display:flex;min-width:0;align-items:center;gap:7px}
.qqj-editor-dialog .qqj-cse-edit-meta .qqj-inline-select{flex:1 1 110px}
.qqj-editor-dialog .qqj-cse-edit-meta>button{flex:0 0 auto;margin-left:auto}
.qqj-editor-dialog .qqj-qianshi-time-fields{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px}
.qqj-editor-dialog .qqj-qianshi-time-fields label{grid-column:span 2}
.qqj-editor-dialog .qqj-qianshi-time-fields label:first-child,.qqj-editor-dialog .qqj-qianshi-time-fields label:nth-child(2){grid-column:span 3}
.qqj-editor-dialog .qqj-qianshi-time-editor{display:grid;min-width:0;gap:5px;margin:0;padding:0;border:0}
.qqj-editor-dialog .qqj-qianshi-time-editor>legend{display:flex;align-items:center;justify-content:space-between;width:100%;gap:6px;margin:0 0 4px;padding:0;color:var(--sp-subtle);font-size:var(--sp-fs-75)}
.qqj-editor-dialog .qqj-qianshi-time-preview{margin:0;color:var(--sp-subtle);font-size:var(--sp-fs-72);line-height:1.5;overflow-wrap:anywhere}
.qqj-editor-dialog .qqj-qianshi-event-summary{overflow-wrap:anywhere}
.qqj-editor-dialog .qqj-qianshi-people-choices{display:grid;min-width:0;max-height:min(180px,30dvh);gap:3px;overflow-y:auto;overscroll-behavior:contain;padding:4px 8px;border:1px solid var(--sp-divider);border-radius:var(--qqj-radius-field);background:var(--sp-sheet-bg)}
.qqj-editor-dialog .qqj-qianshi-people-empty{margin:0;padding:6px 2px;color:var(--sp-subtle);font-size:var(--sp-fs-75)}
.qqj-editor-dialog .qqj-qianshi-person-choice[hidden]{display:none}
.qqj-editor-dialog .qqj-qianshi-person-choice{display:grid;grid-template-columns:18px minmax(0,1fr);align-items:center;gap:8px;padding:6px 2px}
.qqj-editor-dialog .qqj-qianshi-person-choice input{grid-column:1;grid-row:1}
.qqj-editor-dialog .qqj-qianshi-person-choice span,.qqj-editor-dialog .qqj-qianshi-person-choice small{grid-column:2}
.qqj-editor-dialog .settings-hint,.qqj-editor-dialog .qqj-qianshi-object-hint{margin:0;color:var(--sp-subtle);font-size:var(--qqj-font-caption);line-height:1.5;overflow-wrap:anywhere}
.qqj-editor-dialog .qqj-qianshi-retained-people{display:grid;min-width:0;gap:4px}
.qqj-editor-dialog .qqj-qianshi-retained-people:empty{display:none}
.qqj-editor-dialog .qqj-qianshi-retained-person{display:flex;align-items:center;justify-content:space-between;gap:6px;min-width:0;padding:4px 6px;border:1px solid var(--sp-divider);border-radius:var(--qqj-radius-control);color:var(--sp-subtle);font-size:var(--sp-fs-75)}
.qqj-editor-dialog .qqj-qianshi-retained-person>span{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.qqj-editor-dialog .qqj-qianshi-retained-person>button{flex:0 0 auto}
.qqj-editor-dialog .qqj-memory-edit-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;align-items:center}
@media(max-width:390px){.qqj-editor-dialog .qqj-cse-edit-meta{flex-wrap:wrap}.qqj-editor-dialog .qqj-cse-edit-meta .qqj-inline-select{flex:1 1 110px}.qqj-editor-dialog .qqj-qianshi-time-fields{grid-template-columns:repeat(2,minmax(0,1fr))}.qqj-editor-dialog .qqj-qianshi-time-fields label,.qqj-editor-dialog .qqj-qianshi-time-fields label:first-child,.qqj-editor-dialog .qqj-qianshi-time-fields label:nth-child(2){grid-column:span 1}}
.qqj-merge-dialog{display:grid;min-width:0;gap:14px;padding:2px 0 1px;color:var(--sp-on-surface)}
.qqj-merge-dialog-intro{min-width:0;margin:0;padding:9px 10px;border-left:2px solid var(--sp-divider);border-radius:var(--qqj-radius-option);background:var(--sp-hover-bg);color:var(--sp-subtle);font-size:var(--sp-fs-75);line-height:1.6;overflow-wrap:anywhere}
.qqj-merge-field{display:grid;min-width:0;gap:6px}
.qqj-merge-field-title{color:var(--sp-subtle);font-size:var(--sp-fs-75);font-weight:600;line-height:1.4}
.qqj-merge-select-host,.qqj-merge-dialog .qqj-inline-select{display:grid;min-width:0}
.qqj-merge-dialog .qqj-inline-select-trigger{appearance:none;-webkit-appearance:none;display:flex;align-items:center;justify-content:space-between;width:100%;min-width:0;margin:0;border:1px solid var(--sp-divider);background:var(--qqj-control-bg,var(--qqj-color-surface));color:var(--qqj-control-fg,var(--qqj-item-color));font:inherit;text-align:left;text-transform:none;cursor:pointer;min-height:var(--qqj-control-height);padding:var(--qqj-control-pad-y) var(--qqj-control-pad-x);font-size:var(--qqj-font-body);line-height:var(--qqj-control-line);border-radius:var(--qqj-radius-control);font-weight:400;gap:var(--qqj-space-group);border-color:var(--qqj-control-border,var(--qqj-color-line))}
.qqj-merge-dialog .qqj-inline-select-trigger:hover{border-color:var(--qqj-control-border,var(--qqj-color-line));background:var(--qqj-control-bg,var(--qqj-color-surface));color:var(--qqj-control-fg,var(--qqj-item-color))}
.qqj-merge-dialog .qqj-inline-select-trigger:focus-visible{color:var(--qqj-control-fg,var(--qqj-item-color))}
.qqj-merge-dialog .qqj-inline-select-value{min-width:0;white-space:normal;overflow-wrap:anywhere}
.qqj-merge-dialog .qqj-inline-select-chevron{color:var(--sp-subtle);transform:rotate(90deg);transition:transform .15s}
.qqj-merge-dialog .qqj-inline-select.open>.qqj-inline-select-trigger .qqj-inline-select-chevron{transform:rotate(-90deg);color:var(--qqj-control-fg,var(--qqj-item-color))}
.qqj-merge-dialog .qqj-inline-select-options{display:grid;grid-auto-rows:max-content;align-content:start;min-width:0;max-height:min(220px,36dvh);margin-top:4px;padding:3px;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;border:1px solid var(--sp-divider);border-radius:var(--qqj-radius-field);background:var(--sp-sheet-bg)}
.qqj-merge-dialog .qqj-inline-select-options[hidden]{display:none}
.qqj-merge-dialog .qqj-inline-select-option{appearance:none;-webkit-appearance:none;display:block;width:100%;min-width:0;margin:0;background:var(--qqj-control-bg,transparent);color:var(--qqj-control-fg,var(--qqj-item-color));font:inherit;text-align:left;text-transform:none;cursor:pointer;min-height:var(--qqj-control-height);padding:var(--qqj-control-pad-y) var(--qqj-control-pad-x);font-size:var(--qqj-font-body);line-height:var(--qqj-control-line);border-radius:var(--qqj-radius-option);white-space:normal;overflow-wrap:anywhere;border:1px solid transparent;font-weight:400;border-color:var(--qqj-control-border,transparent)}
.qqj-merge-dialog .qqj-inline-select-option:hover{background:var(--qqj-control-bg,transparent);color:var(--qqj-control-fg,var(--qqj-item-color))}
.qqj-merge-dialog .qqj-inline-select-option.active{border-color:var(--qqj-control-border,transparent);background:var(--qqj-control-bg,transparent);color:var(--qqj-control-fg,var(--qqj-item-color))}
.qqj-merge-dialog .qqj-inline-select-option:focus-visible{color:var(--qqj-control-fg,var(--qqj-item-color))}
.qqj-merge-dialog .qqj-inline-select-trigger:disabled,.qqj-merge-dialog .qqj-inline-select-option:disabled{opacity:var(--qqj-disabled-opacity);cursor:not-allowed;color:var(--qqj-control-fg,var(--qqj-item-color))}
.qqj-people-order-dialog{display:grid;min-width:0;gap:10px;color:var(--sp-on-surface)}
.qqj-people-order-intro{margin:0;color:var(--sp-subtle);font-size:var(--sp-fs-75);line-height:1.55;overflow-wrap:anywhere}
.qqj-people-order-list{display:grid;grid-auto-rows:max-content;align-content:start;min-width:0;max-height:min(52dvh,480px);gap:6px;padding:2px;overflow-y:auto;overscroll-behavior:contain}
.qqj-people-order-row{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:9px;padding:5px 9px;border:1px solid var(--sp-divider);border-radius:var(--qqj-radius-field);background:var(--sp-sheet-bg);min-height:calc(40px * var(--qqj-ui-scale,1))}
.qqj-people-order-row.dragging{border-color:var(--sp-primary);background:var(--sp-hover-bg)}
.qqj-people-order-handle{appearance:none;display:grid;place-items:center;margin:0;padding:0;border:0;border-radius:var(--qqj-radius-control);background:var(--qqj-control-bg,transparent);color:var(--qqj-control-fg,var(--qqj-action-color));font:700 calc(13px * var(--qqj-button-scale,.85))/1 var(--sp-font);letter-spacing:-3px;cursor:grab;touch-action:none;width:calc(30px * var(--qqj-button-scale,.85));height:calc(30px * var(--qqj-button-scale,.85));border-color:var(--qqj-control-border,var(--qqj-color-line))}
.qqj-people-order-handle:hover{background:var(--qqj-control-bg,transparent);color:var(--qqj-control-fg,var(--qqj-action-color))}
.qqj-people-order-handle:focus-visible{color:var(--qqj-control-fg,var(--qqj-action-color))}
.qqj-people-order-row.dragging .qqj-people-order-handle{cursor:grabbing;color:var(--qqj-control-fg,var(--qqj-action-color))}
.qqj-people-order-name{min-width:0;font-size:var(--sp-fs-85);line-height:1.45;overflow-wrap:anywhere}
.qqj-avatar-crop-panel{display:grid;gap:12px;min-width:0}
.qqj-avatar-preview-frame{display:flex;align-items:center;justify-content:center;min-width:0;overflow:hidden}
.qqj-avatar-preview-image{display:block;width:auto;height:auto;max-width:100%;max-height:min(50dvh,420px);object-fit:contain}
.qqj-avatar-crop-panel a.secondary-action{display:inline-flex;align-items:center;text-decoration:none}
.qqj-avatar-zoom[hidden]{display:none}
.qqj-avatar-crop-frame{position:relative;width:min(240px,100%);margin-inline:auto;aspect-ratio:var(--qqj-avatar-aspect,1);overflow:hidden;border:1px solid var(--sp-divider);border-radius:var(--qqj-radius-card);background:var(--sp-surface-high);touch-action:none;cursor:move}
.qqj-avatar-crop-image{position:absolute;max-width:none;max-height:none;user-select:none;pointer-events:none}
.qqj-avatar-zoom{display:grid;grid-template-columns:auto minmax(0,240px);align-items:center;justify-content:center;gap:9px;color:var(--sp-subtle);font-size:var(--sp-fs-75)}
.qqj-avatar-zoom input{min-width:0;accent-color:var(--sp-primary)}
.qqj-help-guide{display:grid;min-width:0;gap:8px;color:var(--sp-on-surface)}
.qqj-help-guide-intro{margin:0;padding:8px 10px;border-left:2px solid var(--sp-primary);border-radius:var(--qqj-radius-option);background:var(--sp-hover-bg);color:var(--sp-subtle);font-size:var(--sp-fs-75);line-height:1.6;overflow-wrap:anywhere}
.qqj-help-section{min-width:0;overflow:hidden;border:1px solid var(--sp-divider);border-radius:var(--qqj-radius-card);background:var(--sp-sheet-bg)}
.qqj-help-section-summary{display:flex;align-items:center;gap:var(--qqj-space-group);padding:9px 10px;border-radius:var(--qqj-radius-card);color:var(--sp-on-surface);font-size:var(--sp-fs-83);font-weight:600;line-height:1.45;list-style:none;cursor:pointer}
.qqj-help-section-summary::-webkit-details-marker{display:none}
.qqj-help-section-summary::before{content:"›";color:var(--sp-subtle);transition:transform .15s ease}
.qqj-help-section[open]>.qqj-help-section-summary::before{transform:rotate(90deg)}
.qqj-help-section-body{display:grid;gap:8px;padding:0 10px 10px;border-top:1px solid var(--sp-divider)}
.qqj-help-section-body p{margin:8px 0 0;color:var(--sp-on-surface);font-size:var(--sp-fs-75);line-height:1.7;white-space:normal;overflow-wrap:anywhere}
.qqj-help-list{display:grid;gap:6px;margin:8px 0 0;padding-left:18px;color:var(--sp-on-surface);font-size:var(--sp-fs-75);line-height:1.65}.qqj-help-list li{padding-left:1px;overflow-wrap:anywhere}
/* 千事状态使用有说明的四项单选，继承插件弹窗主题与字号，不调用系统选择框。 */
.qqj-qianshi-status-dialog{display:grid;min-width:0;gap:5px}
.qqj-qianshi-status-intro{margin:0;color:var(--sp-on-surface);font-size:var(--sp-fs-83);line-height:1.5;overflow-wrap:anywhere}
.qqj-qianshi-status-current{margin:0;color:var(--sp-subtle);font-size:var(--sp-fs-75);line-height:1.5}
.qqj-qianshi-status-choices{display:grid}
.qqj-qianshi-status-choice{display:grid;grid-template-columns:16px minmax(0,1fr);align-items:start;gap:9px;padding:9px 0;border-bottom:1px solid var(--sp-divider);cursor:pointer}
.qqj-qianshi-status-choice:last-child{border-bottom:0}
.qqj-qianshi-status-choice>input{margin:2px 0 0;accent-color:var(--sp-primary);width:calc(16px * var(--qqj-ui-scale,1));height:calc(16px * var(--qqj-ui-scale,1))}
.qqj-qianshi-status-choice>span{display:grid;min-width:0;gap:3px}
.qqj-qianshi-status-choice strong{color:var(--sp-on-surface);font-size:var(--sp-fs-83);font-weight:600;line-height:1.4}
.qqj-qianshi-status-choice>span>span{color:var(--sp-subtle);font-size:var(--sp-fs-75);line-height:1.45;overflow-wrap:anywhere}
.qqj-qianshi-status-choice>input:checked+span>strong{color:var(--sp-primary)}
/* 异常弹窗使用同一事件节点/编辑表单；这里只适配独立 shadow 弹窗的主题与宽度。 */
.qqj-qianshi-anomalies{--ink:var(--sp-on-surface);--soft:var(--sp-subtle);--faint:var(--sp-subtle);--line:var(--sp-divider);--paper:var(--sp-sheet-bg);--panel:var(--sp-sheet-bg);--knot:var(--sp-primary);--blue:var(--sp-blue);--success:var(--sp-success);--crimson:var(--sp-danger);display:grid;min-width:0;gap:10px;color:var(--ink);font-size:var(--sp-fs-75)}
.qqj-qianshi-anomaly-intro,.qqj-qianshi-anomalies .qqj-qianshi-feedback{margin:0;color:var(--soft);line-height:1.6;overflow-wrap:anywhere}
.qqj-qianshi-anomalies .qqj-qianshi-save-note{margin:4px 0 0;color:var(--soft);font-size:var(--sp-fs-72);line-height:1.5;overflow-wrap:anywhere}.qqj-qianshi-anomalies .qqj-qianshi-save-note.error{color:var(--crimson)}
.qqj-qianshi-anomaly-list{display:grid;min-width:0;gap:8px}.qqj-qianshi-anomaly-floor{min-width:0;padding:8px 10px;border:1px solid var(--line);border-radius:var(--qqj-radius-card)}.qqj-qianshi-anomaly-floor>summary{cursor:pointer;font-weight:600;line-height:1.6}.qqj-qianshi-anomaly-floor>summary>small{display:block;font-weight:400;color:var(--soft);overflow-wrap:anywhere}
.qqj-qianshi-anomalies .qqj-qianshi-event-row{position:relative;min-width:0;padding-top:10px}.qqj-qianshi-anomalies .qqj-qianshi-event>summary{padding-right:30px;list-style:none;cursor:pointer;line-height:1.6}.qqj-qianshi-anomalies summary::-webkit-details-marker{display:none}.qqj-qianshi-anomalies .qqj-qianshi-event-time{display:block;color:var(--soft)}.qqj-qianshi-anomalies .qqj-qianshi-state{margin-left:5px;font-size:var(--sp-fs-72);font-weight:400;color:var(--soft)}
.qqj-qianshi-anomalies .qqj-qianshi-preview{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:4px 0;color:var(--soft);line-height:1.6}.qqj-qianshi-anomalies .qqj-qianshi-event[open] .qqj-qianshi-preview{display:none}.qqj-qianshi-anomalies .qqj-qianshi-expanded{padding-top:8px}.qqj-qianshi-anomalies .qqj-qianshi-description{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65}.qqj-qianshi-anomalies .qqj-qianshi-meta{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 8px;line-height:1.6;color:var(--soft)}.qqj-qianshi-anomalies dd{margin:0;overflow-wrap:anywhere}
.qqj-qianshi-anomalies .qqj-profile-menu{position:absolute;top:8px;right:0;z-index:2}.qqj-qianshi-anomalies .qqj-profile-menu[open]{z-index:3}.qqj-qianshi-anomalies .qqj-profile-menu-toggle{display:grid;place-items:center;list-style:none;cursor:pointer;width:var(--qqj-menu-icon-size);height:var(--qqj-menu-icon-size);font-size:calc(18px * var(--qqj-button-scale,.85));line-height:1;color:var(--qqj-control-fg,var(--qqj-action-color))}.qqj-qianshi-anomalies .qqj-profile-menu-pop{display:none;position:absolute;right:0;width:max-content;border:1px solid var(--line);border-radius:var(--qqj-radius-control);background:var(--panel);box-shadow:var(--sp-shadow);top:calc(100% + var(--qqj-space-small));min-width:calc(132px * var(--qqj-ui-scale,1));padding:var(--qqj-space-small)}.qqj-qianshi-anomalies .qqj-profile-menu[open]>.qqj-profile-menu-pop{display:grid}
.qqj-qianshi-anomalies .qqj-qianshi-state{display:inline-flex;align-items:center;min-height:var(--qqj-badge-height);padding:var(--qqj-badge-pad-y) var(--qqj-badge-pad-x);border:1px solid var(--sp-divider);border-radius:var(--qqj-radius-pill);background:var(--sp-sheet-bg);color:var(--sp-subtle);font-size:var(--qqj-font-meta);font-weight:500;line-height:var(--qqj-badge-line)}
.qqj-qianshi-anomalies .qqj-qianshi-state.status-inProgress{color:var(--sp-blue);border-color:color-mix(in srgb,var(--sp-blue) 35%,var(--sp-divider))}.qqj-qianshi-anomalies .qqj-qianshi-state.status-completed{color:var(--sp-success);border-color:color-mix(in srgb,var(--sp-success) 35%,var(--sp-divider))}.qqj-qianshi-anomalies .qqj-qianshi-state.status-cancelled{color:var(--sp-danger);border-color:color-mix(in srgb,var(--sp-danger) 35%,var(--sp-divider))}.qqj-qianshi-anomalies .qqj-qianshi-state.status-unknown{border-style:dashed}
.qqj-qianshi-anomalies button{appearance:none;margin:0;border:1px solid var(--line);background:var(--qqj-control-bg,var(--qqj-color-surface));color:var(--qqj-control-fg,var(--qqj-action-color));font:inherit;cursor:pointer;min-height:var(--qqj-control-height);padding:var(--qqj-control-pad-y) var(--qqj-control-pad-x);font-size:var(--qqj-font-body);line-height:var(--qqj-control-line);font-weight:500;border-radius:var(--qqj-radius-control);border-color:var(--qqj-control-border,var(--qqj-color-line))}.qqj-qianshi-anomalies button:disabled{opacity:var(--qqj-disabled-opacity);cursor:not-allowed}.qqj-qianshi-anomalies .qqj-profile-menu-action{width:100%;text-align:left;min-height:var(--qqj-control-height);padding:var(--qqj-control-pad-y) var(--qqj-control-pad-x);font-size:var(--qqj-font-body);line-height:var(--qqj-control-line);font-weight:500;border-radius:var(--qqj-radius-option);border:1px solid transparent;white-space:normal;overflow-wrap:anywhere;border-color:var(--qqj-control-border,transparent);color:var(--qqj-control-fg,var(--qqj-item-color))}.qqj-qianshi-anomalies .danger{color:var(--qqj-control-fg,var(--qqj-color-danger))}.qqj-qianshi-anomalies .primary-action{background:var(--qqj-control-bg,var(--qqj-color-accent));color:var(--qqj-control-fg,var(--qqj-color-on-accent))}
.qqj-qianshi-anomalies .qqj-qianshi-text-form{display:grid;container-type:inline-size;min-width:0;gap:8px}.qqj-qianshi-anomalies .qqj-qianshi-text-label{display:grid;min-width:0;gap:4px;color:var(--soft)}.qqj-qianshi-anomalies .settings-input{width:100%;min-width:0;margin:0;border:1px solid var(--line);background:var(--paper);color:var(--ink);font:inherit;min-height:var(--qqj-control-height);padding:var(--qqj-control-pad-y) var(--qqj-control-pad-x);font-size:var(--qqj-font-body);line-height:var(--qqj-control-line);font-weight:500;border-radius:var(--qqj-radius-control)}.qqj-qianshi-anomalies textarea{resize:vertical;min-height:70px}
.qqj-qianshi-anomalies .qqj-qianshi-time-editor{display:grid;min-width:0;gap:5px;padding:0;margin:0;border:0}.qqj-qianshi-anomalies legend{display:flex;align-items:center;justify-content:space-between;width:100%;padding:0;margin:0 0 4px}.qqj-qianshi-anomalies .qqj-qianshi-time-fields{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px}.qqj-qianshi-anomalies .qqj-qianshi-time-prefix,.qqj-qianshi-anomalies .qqj-qianshi-time-year{grid-column:span 3}.qqj-qianshi-anomalies .qqj-qianshi-time-month,.qqj-qianshi-anomalies .qqj-qianshi-time-day,.qqj-qianshi-anomalies .qqj-qianshi-time-clock{grid-column:span 2}.qqj-qianshi-anomalies .qqj-qianshi-time-preview{margin:0;color:var(--soft);line-height:1.5;overflow-wrap:anywhere}.qqj-qianshi-anomalies .qqj-qianshi-edit-states{display:grid;gap:6px}.qqj-qianshi-anomalies .qqj-qianshi-edit-actions{display:flex;gap:6px}.qqj-qianshi-anomalies .qqj-qianshi-edit-error{margin:0;color:var(--crimson);line-height:1.6}
.qqj-qianshi-anomalies .qqj-inline-select-trigger{width:100%;display:flex;justify-content:space-between;text-align:left;font-weight:400;gap:var(--qqj-space-group);color:var(--qqj-control-fg,var(--qqj-item-color))}.qqj-qianshi-anomalies .qqj-inline-select-options{display:grid;gap:2px;max-height:180px;overflow:auto}.qqj-qianshi-anomalies .qqj-inline-select-options[hidden]{display:none}.qqj-qianshi-anomalies .qqj-inline-select-option{text-align:left;min-height:var(--qqj-control-height);padding:var(--qqj-control-pad-y) var(--qqj-control-pad-x);font-size:var(--qqj-font-body);line-height:var(--qqj-control-line);font-weight:400;border-radius:var(--qqj-radius-option);border:1px solid transparent;white-space:normal;overflow-wrap:anywhere;border-color:var(--qqj-control-border,transparent);color:var(--qqj-control-fg,var(--qqj-item-color))}
@media(max-width:390px){.qqj-merge-dialog{gap:12px}.qqj-merge-dialog .qqj-inline-select-options{max-height:min(190px,32dvh)}}
.qqj-editor-dialog .qqj-memory-edit-anchor{display:grid;min-width:0;gap:6px;padding:7px 0;border-bottom:1px solid var(--sp-divider)}.qqj-editor-dialog .qqj-memory-edit-anchor textarea{min-height:72px;resize:vertical}
.qqj-editor-dialog .qqj-exact-anchor-knowledge{min-width:0;margin-left:8px}.qqj-editor-dialog .qqj-exact-anchor-knowledge-hint{margin:4px 0;color:var(--sp-subtle);font-size:var(--sp-fs-72);line-height:1.45}.qqj-editor-dialog .qqj-exact-anchor-knowledge-list{display:grid;height:150px;overflow:auto;gap:3px;padding:5px 8px;border:1px solid var(--sp-divider);border-radius:var(--qqj-radius-field)}.qqj-editor-dialog .qqj-exact-anchor-knowledge-choice{display:flex;align-items:center;gap:7px;min-width:0;padding:3px 0;color:var(--sp-on-surface)}.qqj-editor-dialog .qqj-exact-anchor-knowledge-choice[hidden]{display:none}.qqj-editor-dialog .qqj-exact-anchor-knowledge-empty{margin:0;padding:5px 8px;color:var(--sp-subtle)}.qqj-editor-dialog .qqj-exact-anchor-knowledge-empty[hidden]{display:none}
@media(prefers-reduced-motion:reduce){.sp-root,.sp-root *{transition-duration:0s!important;scroll-behavior:auto!important}.sp-dialog-overlay{animation:none!important}}
.qqj-recent-items-dialog{display:grid;min-width:0;gap:10px;color:var(--sp-on-surface);font-family:var(--sp-font);font-size:var(--sp-fs-83);line-height:1.55}
.qqj-recent-items-dialog[hidden],.qqj-recent-items-dialog [hidden]{display:none!important}
.qqj-recent-items-dialog>.qqj-profile-switch-row{display:grid;gap:8px}
.qqj-recent-items-dialog .qqj-profile-toolbar-actions,.qqj-recent-items-dialog .qqj-recent-list-actions,.qqj-recent-items-dialog .qqj-recent-batch-controls{display:flex;align-items:center;flex-wrap:wrap;gap:6px}
.qqj-recent-items-dialog .qqj-recent-batch-controls{flex-basis:100%}
.qqj-recent-items-dialog .qqj-recent-primary-actions{display:flex;align-items:center;flex-wrap:wrap;gap:var(--qqj-space-group)}
.qqj-recent-items-dialog .qqj-recent-primary-actions>button.secondary-action{flex:0 0 auto;min-width:0;max-width:100%;min-height:var(--qqj-compact-height);padding:var(--qqj-compact-pad-y) var(--qqj-compact-pad-x);font-size:var(--qqj-font-caption);line-height:var(--qqj-compact-line);border-radius:var(--qqj-radius-compact)}
.qqj-recent-items-dialog>.v3-foundation{display:grid;min-width:0;gap:0}
.qqj-recent-items-dialog .settings-field{display:grid;min-width:0;gap:5px;padding:10px 0;border-bottom:1px solid var(--sp-divider)}
.qqj-recent-items-dialog .settings-field:last-child{border-bottom:0}
.qqj-recent-items-dialog .settings-result:empty,.qqj-recent-items-dialog .settings-hint:empty{display:none}
.qqj-recent-items-dialog .settings-result,.qqj-recent-items-dialog .settings-hint{margin:0;color:var(--sp-subtle);font-size:var(--qqj-font-caption);line-height:1.55;overflow-wrap:anywhere}
.qqj-recent-items-dialog .settings-result.error,.qqj-recent-items-dialog .error,.qqj-recent-items-dialog .danger{color:var(--qqj-control-fg,var(--qqj-color-danger))}
.qqj-recent-items-dialog .settings-result.success{color:var(--sp-success)}
.qqj-recent-items-dialog .qqj-recent-item-head{display:flex;align-items:center;gap:8px;min-width:0}
.qqj-recent-items-dialog .qqj-recent-item-head>span{flex:1;min-width:0;overflow-wrap:anywhere}
.qqj-recent-items-dialog .qqj-recent-item-title{font-size:var(--sp-fs-83);font-weight:600;line-height:1.5}
.qqj-recent-items-dialog .qqj-recent-item-description{margin:0;color:var(--sp-subtle);font-size:var(--sp-fs-75);line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}
.qqj-recent-items-dialog .qqj-recent-item-result,.qqj-recent-items-dialog .qqj-recent-item-readonly,.qqj-recent-items-dialog .qqj-recent-item-times{margin:0;color:var(--sp-subtle);font-size:var(--sp-fs-72);line-height:1.5;overflow-wrap:anywhere}
.qqj-recent-items-dialog .qqj-recent-item-keywords{display:flex;flex-wrap:wrap;gap:4px;margin:0}
.qqj-recent-items-dialog .qqj-recent-item-keyword{max-width:100%;border:1px solid var(--sp-divider);color:var(--sp-subtle);display:inline-flex;align-items:center;min-height:var(--qqj-badge-height);padding:var(--qqj-badge-pad-y) var(--qqj-badge-pad-x);font-size:var(--qqj-font-meta);font-weight:500;line-height:var(--qqj-badge-line);border-radius:var(--qqj-radius-pill);border-width:1px;border-style:solid;white-space:normal;overflow-wrap:anywhere;border-color:var(--sp-divider)}
.qqj-recent-items-dialog input[type=checkbox]{width:calc(16px * var(--qqj-ui-scale,1));min-width:calc(16px * var(--qqj-ui-scale,1));height:calc(16px * var(--qqj-ui-scale,1));flex:0 0 calc(16px * var(--qqj-ui-scale,1));margin:0;padding:0;accent-color:var(--sp-primary)}
.qqj-recent-items-dialog .qqj-profile-menu{position:relative;display:inline-block;flex:0 0 auto;z-index:2}
.qqj-recent-items-dialog .qqj-profile-menu[open]{z-index:5}
.qqj-recent-items-dialog .qqj-profile-menu>summary{list-style:none;cursor:pointer}
.qqj-recent-items-dialog .qqj-profile-menu>summary::-webkit-details-marker{display:none}
.qqj-recent-items-dialog .qqj-profile-menu-toggle{display:grid;place-items:center;padding:0;border:0;border-radius:var(--qqj-radius-control);background:var(--qqj-control-bg,transparent);color:var(--qqj-control-fg,var(--qqj-action-color));cursor:pointer;width:var(--qqj-menu-icon-size);height:var(--qqj-menu-icon-size);font-size:calc(18px * var(--qqj-button-scale,.85));line-height:1;border-color:var(--qqj-control-border,var(--qqj-color-line))}
.qqj-recent-items-dialog .qqj-profile-menu-pop{display:none;position:absolute;right:0;z-index:4;border:1px solid var(--sp-divider);border-radius:var(--qqj-radius-control);background:var(--sp-sheet-bg);box-shadow:var(--sp-shadow);top:calc(100% + var(--qqj-space-small));min-width:calc(132px * var(--qqj-ui-scale,1));padding:var(--qqj-space-small)}
.qqj-recent-items-dialog .qqj-profile-menu[open]>.qqj-profile-menu-pop{display:grid}
.qqj-recent-items-dialog .qqj-profile-menu-action{display:block;width:100%;background:var(--qqj-control-bg,transparent);color:var(--qqj-control-fg,var(--qqj-item-color));font:inherit;text-align:left;cursor:pointer;min-height:var(--qqj-control-height);padding:var(--qqj-control-pad-y) var(--qqj-control-pad-x);font-size:var(--qqj-font-body);line-height:var(--qqj-control-line);font-weight:500;border-radius:var(--qqj-radius-option);white-space:normal;overflow-wrap:anywhere;border:1px solid transparent;border-color:var(--qqj-control-border,transparent)}
.qqj-recent-items-dialog .qqj-profile-menu-action:hover,.qqj-recent-items-dialog .qqj-profile-menu-action:focus-visible{background:var(--qqj-control-bg,transparent);color:var(--qqj-control-fg,var(--qqj-item-color))}
.qqj-update-notice{min-width:0;max-width:70ch;white-space:normal;overflow-wrap:anywhere;color:var(--sp-on-surface);font-size:var(--sp-fs-85);line-height:1.65}.qqj-update-notice>:first-child{margin-top:0}.qqj-update-notice>:last-child{margin-bottom:0}.qqj-update-notice h1,.qqj-update-notice h2,.qqj-update-notice h3{line-height:1.35;margin:1.2em 0 .5em;font-size:1.1em}.qqj-update-notice a{color:var(--sp-primary);text-decoration:underline;text-underline-offset:2px}.qqj-update-notice pre{white-space:pre-wrap;overflow-wrap:anywhere}.qqj-update-notice code{font-size:.92em}

.qqj-api-model-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--qqj-space-group);align-items:center}.qqj-api-model-row>input{min-width:0}.qqj-api-advanced{padding-top:var(--qqj-space-group)}.qqj-api-target-note,.qqj-api-result{margin:0;color:var(--sp-subtle);font-size:var(--qqj-font-caption);line-height:1.55;overflow-wrap:anywhere}.qqj-api-result:empty{display:none}.qqj-api-result.success{color:var(--qqj-dialog-success)}.qqj-api-result.error{color:var(--qqj-dialog-danger)}.qqj-api-delete-confirm{display:grid;gap:var(--qqj-space-group)}.qqj-api-delete-confirm[hidden]{display:none}.qqj-api-editor-dialog .qqj-model-list-section{border:1px solid var(--sp-divider);border-radius:var(--qqj-radius-card);padding:var(--qqj-space-group);min-width:0}.qqj-api-editor-dialog .qqj-model-list-summary{cursor:pointer;color:var(--sp-subtle);font-size:var(--qqj-font-caption)}.qqj-api-editor-dialog .qqj-model-list-items{display:grid;gap:var(--qqj-space-small);max-height:calc(180px * var(--qqj-ui-scale,1));overflow:auto;margin-top:var(--qqj-space-group)}.qqj-api-editor-dialog .qqj-model-list-item{width:100%;text-align:left;justify-content:flex-start;border:1px solid var(--sp-divider);border-radius:var(--qqj-radius-option);background:var(--sp-sheet-bg-legacy);color:var(--sp-on-surface);min-height:var(--qqj-control-height);padding:var(--qqj-control-pad-y) var(--qqj-control-pad-x);font:inherit;overflow-wrap:anywhere}.qqj-api-editor-dialog .qqj-model-list-item.active{color:var(--sp-primary);border-color:var(--sp-primary)}

.qqj-api-editor-dialog .qqj-api-remove{color:var(--qqj-dialog-danger)}

.qqj-api-editor-dialog .qqj-editor-actions{display:flex;flex-wrap:wrap;gap:var(--qqj-space-group)}

.qqj-api-editor-dialog .qqj-editor-check{display:flex;align-items:center;gap:var(--qqj-space-group)}.qqj-api-editor-dialog .qqj-editor-check input[type=checkbox]{flex:0 0 auto;width:calc(16px * var(--qqj-ui-scale,1));height:calc(16px * var(--qqj-ui-scale,1));min-height:0;padding:0;margin:0;accent-color:var(--sp-primary)}
.qqj-place-editor{display:grid;gap:var(--qqj-space-group)}
.qqj-place-editor .qqj-place-level-field{display:grid;min-width:0;gap:var(--qqj-space-small)}
.qqj-place-editor .qqj-place-children-field,.qqj-place-editor .qqj-window-child-picker{display:grid;min-width:0;gap:var(--qqj-space-group)}
.qqj-place-editor .qqj-window-child-picker[hidden]{display:none}
.qqj-place-editor .qqj-window-child-picker .qqj-qianshi-person-choice>span{min-width:0;overflow-wrap:anywhere}
.qqj-editor-dialog .qqj-inline-select-search-panel{display:grid;min-width:0;gap:var(--qqj-space-small);margin-top:var(--qqj-space-small)}.qqj-editor-dialog .qqj-inline-select-search-panel[hidden],.qqj-editor-dialog .qqj-inline-select-searchable .qqj-inline-select-option[hidden],.qqj-editor-dialog .qqj-inline-select-search-panel>.qqj-inline-select-empty[hidden]{display:none}.qqj-editor-dialog .qqj-inline-select-search-row{display:flex;flex-wrap:wrap;align-items:center;gap:var(--qqj-space-small);min-width:0}.qqj-editor-dialog .qqj-inline-select-search-row>.qqj-inline-select-search-input{flex:1 1 calc(180px * var(--qqj-ui-scale,1));min-width:min(100%,calc(160px * var(--qqj-ui-scale,1)))}.qqj-editor-dialog .qqj-inline-select-search-clear{flex:0 0 auto}.qqj-editor-dialog .qqj-inline-select-search-panel>.qqj-inline-select-options{margin-top:0}.qqj-editor-dialog .qqj-inline-select-search-panel>.qqj-inline-select-empty{margin:0}
`;
