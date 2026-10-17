import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyAppearance, createAppearanceController, resolveAppearance } from '../src/ui/appearance.js';
import { fixedFontScale, scaleCssFontSizes } from '../src/ui/font-scale.js';

test('面板标题与人物名沿用用户字体，不再由固定宋体覆盖', async () => {
  const css = await readFile(new URL('../src/ui/panel.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /宋体,"Songti SC",serif/u);
  assert.equal(css.match(/var\(--qqj-custom-font,inherit\),-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif/gu)?.length, 23);
  assert.match(css, /\.primary-action\{[^}]*color:var\(--on-primary,#fff\)/u);
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

test('固定字号以85%为旧版基线，面板根字号仍按滑杆值缩放', async () => {
  const css = await readFile(new URL('../src/ui/panel.css', import.meta.url), 'utf8');
  const scaled = scaleCssFontSizes(css, '--qqj-ui-fixed-scale', true);
  assert.match(scaled, /font:700 calc\(19px \* var\(--qqj-ui-fixed-scale,1\)\)\/1/u);
  assert.match(scaled, /font-size:calc\(8px \* var\(--qqj-ui-fixed-scale,1\)\)/u);
  assert.match(scaled, /:host\{[^}]*font:calc\(13px \* var\(--qqj-ui-scale,1\)\)/u);
  const summaryHeading = /\.settings-sub-summary h4\{[^}]*font:600 calc\((\d+(?:\.\d+)?)px \* var\(--qqj-ui-fixed-scale,1\)\)\/calc\((\d+(?:\.\d+)?)px \* var\(--qqj-ui-fixed-scale,1\)\)/u.exec(scaled);
  assert.deepEqual(summaryHeading?.slice(1).map(Number), [13, 20]);
  assert.doesNotMatch(scaled, /font-size:\d+(?:\.\d+)?px/u);
  const important = scaleCssFontSizes('.tab{font-size:14px!important}.label{font-size:11px !important}');
  assert.match(important, /font-size:calc\(14px \* var\(--qqj-ui-fixed-scale,1\)\)!important/u);
  assert.match(important, /font-size:calc\(11px \* var\(--qqj-ui-fixed-scale,1\)\) !important/u);
  assert.match(await readFile(new URL('../src/ui/gouhua-dialog-style.js', import.meta.url), 'utf8'), /--sp-scale:var\(--qqj-dialog-scale,1\)/u);
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
  assert.equal(properties['--paper'], 'rgb(88, 89, 89)', '聊天背景按切换后的日间 paper 合成');
  assert.equal(properties['--ink'], 'rgb(30, 35, 40)');
  applyAppearance({ host, root: { querySelector: () => null }, settings: settings.get(), documentRef, windowRef });
  assert.equal(properties['--on-primary'], '#22282b', 'auto palette 通过面板主按钮语义 token 输出前景');
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
  assert.equal(opaque.palette.knot, 'rgb(40, 20, 30)', '普通不透明宿主强调色保留原 RGB');
  assert.equal(opaque.palette.paper, '#1a1a1a', '不透明聊天颜色仍直接使用');
  assert.equal(opaque.palette.panel, 'rgb(20, 30, 40)', '不透明机器人颜色仍直接使用');
  assert.equal(opaque.palette.thread, '#121314', '不透明用户颜色仍直接使用');
  assert.equal(opaque.palette.onPrimary, '#fff', '深色强调底色使用白色按钮文字');
  assert.equal(resolveAppearance({ value: { appearanceTheme: 'day' }, documentRef, windowRef }).palette.onPrimary, '#fff');
  assert.equal(resolveAppearance({ value: { appearanceTheme: 'night' }, documentRef, windowRef }).palette.onPrimary, '#fff');
});
