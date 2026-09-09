// Dependency-closed subset copied from ST-SevenDaysCal/style.css @ fb93e5466c14fa28158004454790100a0f284f53.
// QQJ-only palette bridge is isolated in .sp-root and keeps sheet/input surfaces opaque.
export const gouhuaDialogCss = `
:host{position:fixed;top:0;left:0;width:100vw;width:100dvw;height:100vh;height:100dvh;z-index:2000003;display:block;overflow:hidden;pointer-events:none}
*{box-sizing:border-box}
.sp-root{
    --sp-scale:1;
    --sp-font:var(--qqj-dialog-font,-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',Arial,sans-serif);
    --sp-fs-72:calc(11.52px * var(--sp-scale));
    --sp-fs-75:calc(12px * var(--sp-scale));
    --sp-fs-83:calc(13.28px * var(--sp-scale));
    --sp-fs-85:calc(13.6px * var(--sp-scale));
    --sp-fs-95:calc(15.2px * var(--sp-scale));
    --sp-fs-100:calc(16px * var(--sp-scale));
    --sp-sheet-bg:var(--qqj-dialog-sheet,#f6f8f8);
    --sp-sheet-bg-legacy:var(--qqj-dialog-sheet,#f6f8f8);
    --sp-on-surface:var(--qqj-dialog-ink,#22282b);
    --sp-subtle:var(--qqj-dialog-soft,#5c6a70);
    --sp-primary:var(--qqj-dialog-primary,#a8322f);
    --sp-on-primary:#fff;
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
.sp-night{--sp-shadow:0 8px 40px rgba(0,0,0,.65),0 2px 10px rgba(0,0,0,.45)}
.sp-day{--sp-shadow:0 8px 40px rgba(0,0,0,.12),0 2px 10px rgba(0,0,0,.07)}
@media(max-width:640px){.sp-root{position:fixed;top:0;left:0;right:auto;bottom:auto;width:100dvw;height:100dvh;pointer-events:none}}
@keyframes sp-wi-fullview-in{from{opacity:0}to{opacity:1}}
.sp-dialog-overlay{position:fixed;inset:0;box-sizing:border-box;z-index:2000002;pointer-events:auto;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:20px;animation:sp-wi-fullview-in .15s ease-out}
.sp-dialog-sheet{background-color:var(--sp-sheet-bg-legacy);background-image:linear-gradient(var(--sp-sheet-bg),var(--sp-sheet-bg));border-radius:12px;width:min(400px,calc(100vw - 40px));max-width:100%;padding:16px 18px 14px;box-shadow:var(--sp-shadow);display:flex;flex-direction:column;gap:10px}
.sp-dialog-head{font-size:var(--sp-fs-95);font-weight:600;color:var(--sp-on-surface)}
.sp-dialog-body{font-size:var(--sp-fs-85);line-height:1.65;color:var(--sp-on-surface);white-space:pre-wrap;word-break:break-word}
.sp-dialog-note{font-size:var(--sp-fs-75);color:var(--sp-subtle);line-height:1.55;padding:8px 10px;background:var(--sp-hover-bg);border-radius:6px;border-left:2px solid var(--sp-divider)}
.sp-dialog-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px;margin-top:4px}
.sp-dialog-button{padding:6px 16px;border-radius:8px;border:none;font-size:var(--sp-fs-83);cursor:pointer;font-weight:500;transition:opacity .15s}
.sp-dialog-button-secondary{background:transparent;color:var(--sp-subtle);border:1px solid var(--sp-divider)}
.sp-dialog-button-secondary:hover{color:var(--sp-on-surface);border-color:var(--sp-surface-high)}
.sp-dialog-button-primary{background:var(--sp-primary);color:var(--sp-on-primary)}
.sp-dialog-button-primary:hover{opacity:.88}
.sp-dialog-input{width:100%;padding:7px 11px;box-sizing:border-box;background-color:var(--sp-sheet-bg-legacy);background-image:linear-gradient(var(--sp-sheet-bg),var(--sp-sheet-bg));border:1px solid var(--sp-divider);border-radius:8px;color:var(--sp-on-surface);font-size:var(--sp-fs-85);font-family:var(--sp-font);outline:none}
.sp-dialog-input:focus{border-color:var(--sp-primary)}
.sp-dialog-input-error{min-height:1em;color:var(--sp-on-surface);font-size:var(--sp-fs-72);line-height:1.4}
.sp-dialog-input-error i{color:var(--sp-subtle);margin-right:3px}
.sp-dialog-sheet-custom{max-height:calc(100dvh - 40px);overflow:hidden}
.sp-dialog-custom{min-height:0;overflow-y:auto;overscroll-behavior:contain}
.qqj-avatar-crop-panel{display:grid;gap:12px;min-width:0}
.qqj-avatar-crop-frame{position:relative;width:min(240px,100%);margin-inline:auto;aspect-ratio:var(--qqj-avatar-aspect,1);overflow:hidden;border:1px solid var(--sp-divider);border-radius:10px;background:var(--sp-surface-high);touch-action:none;cursor:move}
.qqj-avatar-crop-image{position:absolute;max-width:none;max-height:none;user-select:none;pointer-events:none}
.qqj-avatar-zoom{display:grid;grid-template-columns:auto minmax(0,240px);align-items:center;justify-content:center;gap:9px;color:var(--sp-subtle);font-size:var(--sp-fs-75)}
.qqj-avatar-zoom input{min-width:0;accent-color:var(--sp-primary)}
@media(prefers-reduced-motion:reduce){.sp-root,.sp-root *{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}
`;
