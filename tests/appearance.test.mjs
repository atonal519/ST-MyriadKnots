import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAppearance, createAppearanceController, resolveAppearance } from '../src/ui/appearance.js';

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
  assert.equal(properties['--qqj-custom-font'], '"Test Font"');
  assert.equal(children.length, 1);
  assert.deepEqual(unrelated, {});
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

test('跟随酒馆使用有效宿主色，透明宿主色回退，并随根节点主题变化', () => {
  const values = {
    '--SmartThemeBodyColor': 'rgba(232, 236, 238, .08)',
    '--SmartThemeQuoteColor': 'rgba(120, 45, 55, .9)',
    '--SmartThemeChatTintColor': 'transparent',
    '--SmartThemeBotMesBlurTintColor': 'rgba(1, 2, 3, .1)',
    '--SmartThemeUserMesBlurTintColor': '#09101120',
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
  assert.equal(initial.palette.ink, 'rgb(232, 236, 238)', '低透明宿主色应保留 RGB 并转为实色');
  assert.equal(initial.palette.knot, 'rgb(120, 45, 55)');
  assert.equal(initial.palette.paper, '#13181b', '透明宿主色应回退本地实色');
  assert.equal(initial.palette.panel, 'rgb(1, 2, 3)', '低 alpha 面板色不能因透明度被丢弃');
  assert.equal(initial.palette.thread, '#091011', '八位 hex 应剥离 alpha');
  assert.equal(Object.values(initial.palette).some(color => /rgba\(|#[\da-f]{8}$/iu.test(color)), false, '解析后的可绘制 palette 不得携带 alpha');
  const controller = createAppearanceController({ host, root: { querySelector: () => null }, settings, documentRef, windowRef, onChange: state => states.push(state) });
  assert.equal(states.at(-1).palette.knot, 'rgb(120, 45, 55)', '解析后的实色 palette 必须传给 FAB 与自有对话框');
  values['--SmartThemeBodyColor'] = 'rgb(30 35 40 / 12%)'; observerCallback();
  assert.equal(states.at(-1).effectiveTheme, 'day', '酒馆根节点换色后应即时同步有效主题');
  assert.equal(properties['--paper'], '#e8ecec', '透明聊天色不得穿透已解析回退色');
  assert.equal(properties['--ink'], 'rgb(30, 35, 40)');
  controller.destroy();
});
