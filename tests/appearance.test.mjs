import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyAppearance, createAppearanceController, resolveAppearance } from '../src/ui/appearance.js';
import { fixedFontScale, scaleCssFontSizes, scaleCssSpacing } from '../src/ui/font-scale.js';

test('文字按钮的固定内距不再被通用间距转换重复缩放，字号仍沿外观倍率', () => {
  const source = '.tab{padding:calc(11px * var(--qqj-button-scale,.85)) calc(13px * var(--qqj-button-scale,.85));font-size:13px}.body{padding:8px}';
  const result = scaleCssSpacing(scaleCssFontSizes(source));
  assert.match(result, /padding:calc\(11px \* var\(--qqj-button-scale,\.85\)\) calc\(13px \* var\(--qqj-button-scale,\.85\)\);/u);
  assert.match(result, /font-size:calc\(13px \* var\(--qqj-ui-fixed-scale,1\)\)/u);
  assert.match(result, /\.body\{padding:calc\(8px \* var\(--qqj-ui-scale,1\)\)\}/u);
  assert.equal(scaleCssSpacing(result), result);
});

test('面板标题与人物名沿用用户字体，不再由固定宋体覆盖', async () => {
  const css = await readFile(new URL('../src/ui/panel.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /宋体,"Songti SC",serif/u);
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)];
  for (const selector of ['.qqj-view-heading h2', '.v3-cse-subject h4', '.qqj-person-summary strong', '.qqj-profile-title-row>h2']) {
    const declarations = blocks.filter(([, selectors]) => selectors.split(',').map(value => value.trim()).includes(selector));
    assert.ok(declarations.length, `${selector}须仍有实际字体声明`);
    assert.ok(declarations.some(([, , body]) => /font:[^;]*var\(--qqj-custom-font,inherit\),-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif/u.test(body)), `${selector}沿用自定义字体`);
  }
  assert.match(css, /\.primary-action\{[^}]*color:var\(--qqj-control-fg,var\(--qqj-color-on-accent\)\)/u);
});

test('外观仅写千千结 host 与其 Shadow Root 字体链接', () => {
  const attributes = {};
  const properties = {};
  const host = { setAttribute: (key, value) => { attributes[key] = value; }, style: { setProperty: (key, value) => { properties[key] = value; } } };
  const children = [];
  const root = { querySelector: () => null, append: node => children.push(node) };
  const documentRef = { createElement: tag => ({ tag, setAttribute(key, value) { this[key] = value; } }) };
  const unrelated = {};
  const result = applyAppearance({ host, root, documentRef, settings: { appearanceTheme: 'night', appearanceScale: 1.25, appearanceFontCssUrl: 'https://font.test/a.css', appearanceFontFamily: 'Test Font' } });
  assert.equal(result.theme, 'night');
  assert.equal(attributes['data-qqj-theme'], 'night');
  assert.equal(properties['--qqj-ui-scale'], '1.25');
  assert.equal(properties['--qqj-ui-fixed-scale'], String(1.25 / 0.85));
  assert.equal(properties['--qqj-custom-font'], '"Test Font"');
  assert.equal(children.length, 1);
  assert.deepEqual(unrelated, {});
});

test('共享字号不重复乘旧倍率，旧调用的固定字号缩放保持兼容', async () => {
  const css = await readFile(new URL('../src/ui/panel.css', import.meta.url), 'utf8');
  const scaled = scaleCssFontSizes(css, '--qqj-ui-fixed-scale', true);
  assert.match(scaled, /font:700 calc\(22px \* var\(--qqj-ui-scale,1\)\)\/1/u);
  assert.match(scaled, /font-size:var\(--qqj-font-meta\)/u);
  assert.match(scaled, /:host\{[^}]*font:calc\(13px \* var\(--qqj-ui-scale,1\)\)/u);
  assert.match(scaled, /font:600 var\(--qqj-font-subheading\)\/var\(--qqj-control-line\)/);
  assert.doesNotMatch(scaled, /font-size:\d+(?:\.\d+)?px/u);
  const important = scaleCssFontSizes('.tab{font-size:14px!important}.label{font-size:11px !important}');
  assert.match(important, /font-size:calc\(14px \* var\(--qqj-ui-fixed-scale,1\)\)!important/u);
  assert.match(important, /font-size:calc\(11px \* var\(--qqj-ui-fixed-scale,1\)\) !important/u);
  assert.match(await readFile(new URL('../src/ui/gouhua-dialog-style.js', import.meta.url), 'utf8'), /--sp-scale:var\(--qqj-ui-scale,1\)/u);
  for (const [slider, expectedRatio] of [[0.75, 0.75 / 0.85], [0.85, 1], [1, 1 / 0.85], [1.5, 1.5 / 0.85]]) {
    assert.equal(fixedFontScale(slider), expectedRatio);
    assert.equal(19 * fixedFontScale(slider) / (slider / 0.85), 19, '固定字号相对旧版85%基线保持单调比例');
  }
  assert.equal(fixedFontScale(0.75) < fixedFontScale(0.85), true);
  assert.equal(fixedFontScale(0.85) < fixedFontScale(1), true);
  assert.equal(fixedFontScale(1) < fixedFontScale(1.5), true);
  for (const [slider, ratio] of [[0.75, 0.75 / 0.85], [0.85, 1], [1, 1 / 0.85], [1.5, 1.5 / 0.85]]) {
    assert.ok(Math.abs(13 * ratio - 13 * slider / 0.85) < 1e-10, '设置小标题字号跟随固定字号倍率');
    assert.ok(Math.abs(20 * ratio - 20 * slider / 0.85) < 1e-10, '设置小标题行高跟随固定字号倍率');
  }
});

test('手动日间使用冷白表面与唯一强调红，夜间强调红保持同源', () => {
  const day = resolveAppearance({ value: { appearanceTheme: 'day' } });
  assert.equal(day.palette.paper, '#f7f8fa'); assert.equal(day.palette.panel, '#ffffff');
  assert.equal(day.palette.crimson, '#b63745'); assert.equal(day.palette.knot, day.palette.crimson);
  const night = resolveAppearance({ value: { appearanceTheme: 'night' } });
  assert.equal(night.palette.crimson, '#d9707a'); assert.equal(night.palette.knot, night.palette.crimson);
});

test('外观从字体 CSS URL 自动解析 family 并缓存进设置', async () => {
  const properties = {};
  const host = { setAttribute() {}, style: { setProperty: (key, value) => { properties[key] = value; } } };
  const root = { querySelector: () => null, append() {} };
  const documentRef = { createElement: tag => ({ tag, setAttribute() {} }) };
  const updated = [];
  const settings = {
    get: () => ({ appearanceTheme: 'auto', appearanceScale: 1, appearanceFontCssUrl: 'https://font.test/a.css', appearanceFontFamily: '' }),
    update: patch => updated.push(patch),
  };
  let fetched = 0;
  const fetchImpl = async () => { fetched += 1; return { ok: true, text: async () => "@font-face{font-family:'LXGW WenKai';src:url(a.woff2)}" }; };
  const result = applyAppearance({ host, root, documentRef, settings, fetchImpl });
  await result.fontReady;
  assert.equal(fetched, 1);
  assert.equal(properties['--qqj-custom-font'], '"LXGW WenKai"');
  assert.deepEqual(updated.at(-1), { appearanceFontFamily: 'LXGW WenKai' });
});

test('已有缓存 family 时直接套用，不再重复 fetch', async () => {
  const properties = {};
  const host = { setAttribute() {}, style: { setProperty: (key, value) => { properties[key] = value; } } };
  const root = { querySelector: () => null, append() {} };
  const documentRef = { createElement: tag => ({ tag, setAttribute() {} }) };
  let fetched = 0;
  const fetchImpl = async () => { fetched += 1; return { ok: true, text: async () => '' }; };
  const result = applyAppearance({ host, root, documentRef, fetchImpl, settings: { appearanceTheme: 'auto', appearanceScale: 1, appearanceFontCssUrl: 'https://font.test/a.css', appearanceFontFamily: 'Cached Font' } });
  await result.fontReady;
  assert.equal(fetched, 0);
  assert.equal(properties['--qqj-custom-font'], '"Cached Font"');
});

test('字体 CSS 解析失败时回退系统字体且不抛错', async () => {
  const properties = {};
  const host = { setAttribute() {}, style: { setProperty: (key, value) => { properties[key] = value; } } };
  const root = { querySelector: () => null, append() {} };
  const documentRef = { createElement: tag => ({ tag, setAttribute() {} }) };
  const fetchImpl = async () => { throw new Error('network'); };
  const result = applyAppearance({ host, root, documentRef, fetchImpl, settings: { appearanceTheme: 'auto', appearanceScale: 1, appearanceFontCssUrl: 'https://font.test/x.css', appearanceFontFamily: '' } });
  await result.fontReady;
  assert.equal(properties['--qqj-custom-font'], 'system-ui');
});

test('字体异步结果仅在 URL 仍为当前选择时应用', async () => {
  const properties = {};
  const host = { setAttribute() {}, style: { setProperty: (key, value) => { properties[key] = value; } } };
  const root = { querySelector: () => null, append() {} };
  const documentRef = { createElement: tag => ({ tag, setAttribute() {} }) };
  const deferred = new Map();
  const fetchImpl = url => new Promise((resolve, reject) => deferred.set(url, { resolve, reject }));
  let value = { appearanceTheme: 'auto', appearanceScale: 1, appearanceFontCssUrl: 'https://font.test/a.css', appearanceFontFamily: '' };
  const settings = { get: () => value, update: patch => { value = { ...value, ...patch }; } };

  const slowA = applyAppearance({ host, root, documentRef, settings, fetchImpl });
  value = { ...value, appearanceFontCssUrl: 'https://font.test/b.css', appearanceFontFamily: '' };
  const fastB = applyAppearance({ host, root, documentRef, settings, fetchImpl });
  deferred.get('https://font.test/b.css').resolve({ text: async () => "@font-face{font-family:'Font B'}" });
  await fastB.fontReady;
  deferred.get('https://font.test/a.css').resolve({ text: async () => "@font-face{font-family:'Font A'}" });
  await slowA.fontReady;
  assert.equal(properties['--qqj-custom-font'], '"Font B"', 'A 慢 B 快时旧成功结果不得覆盖 B');
  assert.equal(value.appearanceFontFamily, 'Font B');

  value = { ...value, appearanceFontCssUrl: 'https://font.test/c.css', appearanceFontFamily: '' };
  const pendingClear = applyAppearance({ host, root, documentRef, settings, fetchImpl });
  value = { ...value, appearanceFontCssUrl: '', appearanceFontFamily: '' };
  applyAppearance({ host, root, documentRef, settings, fetchImpl });
  deferred.get('https://font.test/c.css').resolve({ text: async () => "@font-face{font-family:'Font C'}" });
  await pendingClear.fontReady;
  assert.equal(properties['--qqj-custom-font'], 'system-ui', '清空 URL 后旧成功结果不得复活字体');

  value = { ...value, appearanceFontCssUrl: 'https://font.test/d.css', appearanceFontFamily: '' };
  const oldFailure = applyAppearance({ host, root, documentRef, settings, fetchImpl });
  value = { ...value, appearanceFontCssUrl: 'https://font.test/e.css', appearanceFontFamily: '' };
  const newSuccess = applyAppearance({ host, root, documentRef, settings, fetchImpl });
  deferred.get('https://font.test/e.css').resolve({ text: async () => "@font-face{font-family:'Font E'}" });
  await newSuccess.fontReady;
  deferred.get('https://font.test/d.css').reject(new Error('旧请求失败'));
  await oldFailure.fontReady;
  assert.equal(properties['--qqj-custom-font'], '"Font E"', '旧失败晚到不得把新字体改回系统字体');
});

test('跟随酒馆将实际透明主题背景合成到外观底色并保留文字 RGB', () => {
  const values = {
    '--SmartThemeBodyColor': 'rgba(206, 206, 206, 1)',
    '--SmartThemeQuoteColor': 'rgba(199, 174, 203, .9)',
    '--SmartThemeChatTintColor': 'rgba(26, 26, 26, .7)',
    '--SmartThemeBotMesBlurTintColor': 'rgba(237, 233, 229, 0)',
    '--SmartThemeUserMesBlurTintColor': 'rgba(162, 163, 189, .15)',
  };
  let observerCallback = null;
  class Observer { constructor(callback) { observerCallback = callback; } observe() {} disconnect() {} }
  const windowRef = {
    MutationObserver: Observer,
    getComputedStyle: () => ({ getPropertyValue: name => values[name] ?? '' }),
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  };
  const properties = {};
  const host = { setAttribute() {}, style: { setProperty: (name, value) => { properties[name] = value; } } };
  const documentRef = { documentElement: {}, defaultView: windowRef, createElement: () => ({ getContext: () => null }) };
  const states = [];
  const settings = { get: () => ({ appearanceTheme: 'auto', appearanceScale: 1, appearanceFontCssUrl: '' }) };
  const initial = resolveAppearance({ value: settings.get(), documentRef, windowRef });
  assert.equal(initial.effectiveTheme, 'night', '宿主亮文字代表深色主题');
  assert.equal(initial.palette.ink, 'rgb(206, 206, 206)', '正文前景继续使用宿主 RGB');
  assert.equal(initial.palette.knot, 'rgb(199, 174, 203)', '强调前景继续使用宿主 RGB');
  assert.equal(initial.palette.paper, 'rgb(24, 25, 26)', '聊天背景按 .7 alpha 合成到夜间 paper');
  assert.equal(initial.palette.panel, '#1c2327', 'alpha 0 的浅 RGB 不得成为实色卡片');
  assert.equal(initial.palette.thread, 'rgb(68, 81, 91)', '用户背景按 alpha 合成到夜间 thread');
  assert.equal(initial.palette.onPrimary, '#22282b', '浅紫强调底色使用深色按钮文字');
  assert.equal(Object.values(initial.palette).some(color => /rgba\(|#[\da-f]{8}$/iu.test(color)), false, '解析后的可绘制 palette 不得携带 alpha');
  const controller = createAppearanceController({ host, root: { querySelector: () => null }, settings, documentRef, windowRef, onChange: state => states.push(state) });
  assert.equal(states.at(-1).palette.knot, 'rgb(199, 174, 203)', '解析后的实色 palette 必须传给 FAB 与自有对话框');
  values['--SmartThemeBodyColor'] = 'rgb(30 35 40 / 12%)'; observerCallback();
  assert.equal(states.at(-1).effectiveTheme, 'day', '酒馆根节点换色后应即时同步有效主题');
  assert.equal(properties['--paper'], '#e8ecec', '合成深灰底与新的深色正文不搭配，回到已判定的日间 paper');
  assert.equal(properties['--ink'], 'rgb(30, 35, 40)');
  applyAppearance({ host, root: { querySelector: () => null }, settings: settings.get(), documentRef, windowRef });
  assert.equal(properties['--on-primary'], '#fff', '日间不可读的浅强调色回到主题强调色，按钮同步其可读前景');
  controller.destroy();
});

test('auto palette 合成 HEX alpha，手动主题仍用固定按钮前景', () => {
  const values = {
    '--SmartThemeBodyColor': '#cecece',
    '--SmartThemeQuoteColor': '#c7aecbe6',
    '--SmartThemeChatTintColor': '#1a1a1ab3',
    '--SmartThemeBotMesBlurTintColor': '#ede9e500',
    '--SmartThemeUserMesBlurTintColor': '#a2a3bd26',
  };
  const windowRef = { getComputedStyle: () => ({ getPropertyValue: name => values[name] ?? '' }), matchMedia: () => ({ matches: false }) };
  const documentRef = { documentElement: {}, defaultView: windowRef };
  const auto = resolveAppearance({ value: { appearanceTheme: 'auto' }, documentRef, windowRef });
  assert.equal(auto.palette.paper, 'rgb(24, 25, 26)');
  assert.equal(auto.palette.panel, '#1c2327');
  assert.equal(auto.palette.thread, 'rgb(68, 80, 91)');
  assert.equal(auto.palette.onPrimary, '#22282b');
  Object.assign(values, {
    '--SmartThemeQuoteColor': 'rgba(40, 20, 30, 1)',
    '--SmartThemeChatTintColor': '#1a1a1a',
    '--SmartThemeBotMesBlurTintColor': 'rgba(20, 30, 40, 1)',
    '--SmartThemeUserMesBlurTintColor': '#121314',
  });
  const opaque = resolveAppearance({ value: { appearanceTheme: 'auto' }, documentRef, windowRef });
  assert.equal(opaque.palette.knot, '#d9707a', '深色强调字与夜间底色不搭配时沿原夜间强调色');
  assert.equal(opaque.palette.paper, '#1a1a1a', '不透明聊天颜色仍直接使用');
  assert.equal(opaque.palette.panel, 'rgb(20, 30, 40)', '不透明机器人颜色仍直接使用');
  assert.equal(opaque.palette.thread, '#121314', '不透明用户颜色仍直接使用');
  assert.equal(opaque.palette.onPrimary, '#22282b', '按钮采用已修正强调色上的可读前景');
  assert.equal(resolveAppearance({ value: { appearanceTheme: 'day' }, documentRef, windowRef }).palette.onPrimary, '#fff');
  assert.equal(resolveAppearance({ value: { appearanceTheme: 'night' }, documentRef, windowRef }).palette.onPrimary, '#22282b');
});

test('几何缩放只处理内容间距，保视口断点、细边框和已计算token，且不重复放大', () => {
  const source = '@media(max-width:390px){.row{padding:4px 8px;gap:6px;margin-top:-2px;border:1px solid red;min-height:var(--qqj-control-height);border-radius:var(--qqj-radius-control)}}';
  const scaled = scaleCssSpacing(source);
  assert.match(scaled, /@media\(max-width:390px\)/);
  assert.match(scaled, /padding:calc\(4px \* var\(--qqj-ui-scale,1\)\) calc\(8px \* var\(--qqj-ui-scale,1\)\)/);
  assert.match(scaled, /gap:calc\(6px \* var\(--qqj-ui-scale,1\)\)/);
  assert.match(scaled, /margin-top:calc\(-2px \* var\(--qqj-ui-scale,1\)\)/);
  assert.match(scaled, /border:1px solid red/);
  assert.match(scaled, /min-height:var\(--qqj-control-height\)/);
  assert.equal(scaleCssSpacing(scaled), scaled);
});

test('固定夜间主按钮沿同一强调色计算可读前景', () => {
  assert.equal(resolveAppearance({ value: { appearanceTheme: 'night' } }).palette.onPrimary, '#22282b');
});

test('固定日间及auto回落的状态文字在本身浅色背景上可读', () => {
  const rgb = hex => [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16));
  const luminance = channels => channels.reduce((sum, channel, index) => { const value = channel / 255; return sum + (value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index]; }, 0);
  const windowRef = { matchMedia: () => ({ matches: true }) };
  for (const mode of ['day', 'auto']) {
    const { palette } = resolveAppearance({ value: { appearanceTheme: mode }, windowRef });
    for (const name of ['blue', 'success']) {
      const ink = rgb(palette[name]), paper = rgb(palette.panel);
      const background = ink.map((value, index) => .1 * value + .9 * paper[index]);
      const levels = [luminance(ink), luminance(background)].sort((left, right) => left - right);
      assert.ok((levels[1] + .05) / (levels[0] + .05) >= 4.5, `${mode} ${name}需满足正文小字对比度`);
    }
  }
});

function appearanceContrast(foreground, background) {
  const rgb = color => {
    if (!color.startsWith('#')) return color.match(/\d+/gu).map(Number);
    const hex = color.slice(1), full = hex.length === 3 ? [...hex].map(value => value + value).join('') : hex;
    return [0, 2, 4].map(index => Number.parseInt(full.slice(index, index + 2), 16));
  };
  const level = color => rgb(color).reduce((sum, value, index) => {
    const channel = value / 255;
    return sum + (channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index];
  }, 0);
  const [dark, light] = [level(foreground), level(background)].sort((left, right) => left - right);
  return (light + .05) / (dark + .05);
}

function hostAppearance(values, light = false) {
  const windowRef = { getComputedStyle: () => ({ getPropertyValue: name => values[name] ?? '' }), matchMedia: () => ({ matches: light }) };
  return resolveAppearance({ value: { appearanceTheme: 'auto' }, documentRef: { documentElement: {}, defaultView: windowRef }, windowRef });
}

const cdThemeColors = {
  '--SmartThemeBodyColor': 'rgba(225, 235, 244, 1)',
  '--SmartThemeQuoteColor': 'rgba(215, 232, 248, 1)',
  '--SmartThemeChatTintColor': 'rgba(30, 45, 64, .72)',
  '--SmartThemeBotMesBlurTintColor': 'rgba(245, 245, 245, 1)',
  '--SmartThemeUserMesBlurTintColor': 'rgba(230, 230, 230, 1)',
  '--SmartThemeBlurTintColor': 'rgba(30, 45, 64, .73)',
};

test('auto CD盒 keeps host text and uses its readable UI tint for the white bot surface', () => {
  const { mode, effectiveTheme, palette } = hostAppearance(cdThemeColors);
  assert.equal(mode, 'auto'); assert.equal(effectiveTheme, 'night');
  assert.equal(palette.ink, 'rgb(225, 235, 244)');
  assert.equal(palette.knot, 'rgb(215, 232, 248)');
  assert.equal(palette.paper, 'rgb(27, 39, 54)');
  assert.equal(palette.panel, 'rgb(29, 42, 57)', 'use the host blue UI tint before a fixed night fallback');
  for (const background of [palette.paper, palette.panel]) for (const foreground of [palette.ink, palette.soft, palette.knot, palette.blue]) {
    assert.ok(appearanceContrast(foreground, background) >= 4.5, `${foreground} on ${background}`);
  }
  assert.ok(appearanceContrast(palette.onPrimary, palette.knot) >= 4.5);
});

test('auto corrects an unreadable paper with the host UI tint while preserving a readable bot surface', () => {
  const { palette } = hostAppearance({
    '--SmartThemeBodyColor': '#202830', '--SmartThemeQuoteColor': '#9a2d42',
    '--SmartThemeChatTintColor': '#202830', '--SmartThemeBotMesBlurTintColor': '#ffffff',
    '--SmartThemeBlurTintColor': '#f0f4f8',
  });
  assert.equal(palette.paper, '#f0f4f8'); assert.equal(palette.panel, '#ffffff');
  assert.equal(palette.ink, '#202830'); assert.equal(palette.knot, '#9a2d42');
  for (const background of [palette.paper, palette.panel]) for (const foreground of [palette.ink, palette.soft]) assert.ok(appearanceContrast(foreground, background) >= 4.5);
});

test('auto keeps compatible day and night host palettes and handles transparent or absent backgrounds', () => {
  for (const values of [
    { '--SmartThemeBodyColor': '#202830', '--SmartThemeQuoteColor': '#9a2d42', '--SmartThemeChatTintColor': '#f0f2f4', '--SmartThemeBotMesBlurTintColor': '#ffffff' },
    { '--SmartThemeBodyColor': '#e1e9f2', '--SmartThemeQuoteColor': '#b7cde3', '--SmartThemeChatTintColor': '#111a24', '--SmartThemeBotMesBlurTintColor': '#1e2934' },
  ]) {
    const { palette } = hostAppearance(values);
    assert.equal(palette.paper, values['--SmartThemeChatTintColor']);
    assert.equal(palette.panel, values['--SmartThemeBotMesBlurTintColor']);
    assert.equal(palette.ink, values['--SmartThemeBodyColor']);
    assert.equal(palette.knot, values['--SmartThemeQuoteColor']);
  }
  const transparent = hostAppearance({ ...cdThemeColors, '--SmartThemeChatTintColor': 'transparent', '--SmartThemeBotMesBlurTintColor': '#ffffff00', '--SmartThemeBlurTintColor': 'rgba(255,255,255,0)' });
  assert.equal(transparent.palette.paper, '#13181b'); assert.equal(transparent.palette.panel, '#1c2327');
  for (const light of [false, true]) {
    const resolved = hostAppearance({}, light);
    assert.equal(resolved.effectiveTheme, light ? 'day' : 'night'); assert.equal(resolved.hasHostSignal, false);
    assert.ok(appearanceContrast(resolved.palette.ink, resolved.palette.panel) >= 4.5);
  }
});

test('auto substitutes unreadable foregrounds and keeps primary button contrast for a mid-tone accent', () => {
  const mid = hostAppearance({ '--SmartThemeBodyColor': '#888888', '--SmartThemeQuoteColor': '#22282b', '--SmartThemeChatTintColor': '#101820', '--SmartThemeBotMesBlurTintColor': '#1c2327' });
  for (const background of [mid.palette.paper, mid.palette.panel]) for (const foreground of [mid.palette.ink, mid.palette.soft, mid.palette.knot]) assert.ok(appearanceContrast(foreground, background) >= 4.5);
  const button = hostAppearance({ '--SmartThemeBodyColor': '#eeeeee', '--SmartThemeQuoteColor': '#888888', '--SmartThemeChatTintColor': '#000000', '--SmartThemeBotMesBlurTintColor': '#000000' });
  assert.equal(button.palette.knot, '#888888', 'a readable host accent remains the action color');
  assert.ok(appearanceContrast(button.palette.onPrimary, button.palette.knot) >= 4.5);
});

test('auto secondary text stays readable on the existing nine-percent accent note background', () => {
  const { palette } = hostAppearance({
    '--SmartThemeBodyColor': '#e7ecee', '--SmartThemeQuoteColor': '#d9707a',
    '--SmartThemeChatTintColor': 'rgba(30,45,64,.12)', '--SmartThemeBlurTintColor': 'rgba(30,45,64,.12)',
    '--SmartThemeBotMesBlurTintColor': 'rgba(245,245,245,.12)',
  });
  assert.equal(palette.panel, 'rgb(54, 60, 64)', 'keep the compatible host alpha surface');
  const accent = palette.knot.match(/\d+/gu)?.map(Number) ?? [];
  const accentRgb = palette.knot.startsWith('#') ? [1, 3, 5].map(index => Number.parseInt(palette.knot.slice(index, index + 2), 16)) : accent;
  const panel = [54, 60, 64];
  const note = `rgb(${accentRgb.map((value, index) => Math.round(.09 * value + .91 * panel[index])).join(', ')})`;
  assert.ok(appearanceContrast(palette.soft, note) >= 4.5, 'dialog note uses the same soft token on its real nine-percent accent tint');
});

test('auto preserves a host mid-gray foreground that is readable on the final black surfaces', () => {
  const { palette } = hostAppearance({
    '--SmartThemeBodyColor': '#888888', '--SmartThemeQuoteColor': '#dddddd',
    '--SmartThemeChatTintColor': '#000000', '--SmartThemeBotMesBlurTintColor': '#000000',
    '--SmartThemeBlurTintColor': '#000000',
  });
  assert.equal(palette.ink, '#888888');
  assert.equal(palette.paper, '#000000'); assert.equal(palette.panel, '#000000');
  assert.ok(appearanceContrast(palette.ink, palette.paper) >= 4.5);
  assert.ok(appearanceContrast(palette.ink, palette.panel) >= 4.5);
});
