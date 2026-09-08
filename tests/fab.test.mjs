import test from 'node:test';
import assert from 'node:assert/strict';
import { createFab } from '../src/ui/fab.js';

class FakeButton {
  constructor() { this.events = {}; this.attributes = {}; this.classes = new Set(); this.captured = []; this.released = []; }
  addEventListener(name, handler) { (this.events[name] ||= []).push(handler); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  setPointerCapture(id) { this.captured.push(id); }
  releasePointerCapture(id) { this.released.push(id); }
  get classList() { return { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name), contains: name => this.classes.has(name) }; }
  async fire(name, values = {}) {
    const event = { pointerId: 1, clientX: 0, clientY: 0, prevented: false, preventDefault() { this.prevented = true; }, ...values };
    for (const handler of this.events[name] || []) await handler(event);
    return event;
  }
}

function harness({ width = 1000, height = 800, saved = null } = {}) {
  const button = new FakeButton();
  const root = { html: '', querySelector: selector => selector === 'button' ? button : null, set innerHTML(value) { this.html = value; }, get innerHTML() { return this.html; } };
  const host = {
    attributes: {}, style: { setProperty(name, value) { this[name] = value; } }, shadowRoot: null,
    setAttribute(name, value) { this.attributes[name] = String(value); },
    attachShadow() { this.shadowRoot = root; return root; },
    getBoundingClientRect() { return { left: Number.parseFloat(this.style.left) || 100, top: Number.parseFloat(this.style.top) || 100 }; },
  };
  const stored = new Map(saved ? [['qqj-fab-pos', JSON.stringify(saved)]] : []);
  const writes = [];
  const storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => { writes.push([key, value]); stored.set(key, value); } };
  const listeners = {};
  const windowRef = { innerWidth: width, innerHeight: height, localStorage: storage, matchMedia: query => ({ matches: windowRef.innerWidth <= 640 && query.includes('640') }), addEventListener: (name, fn) => { listeners[name] = fn; }, removeEventListener: name => { delete listeners[name]; } };
  const documentRef = { createElement: () => host };
  let clicks = 0;
  const fab = createFab({ documentRef, windowRef, storage, onClick: () => { clicks += 1; } });
  return { fab, host, button, root, stored, writes, listeners, windowRef, get clicks() { return clicks; } };
}

test('悬浮球使用构画同款视觉 token、独立位置和真实忙灯', () => {
  const h = harness({ saved: { x: 980, y: 790 } });
  assert.equal(h.host.id, 'qqj-fab-host'); assert.equal(h.host.style.left, '964px'); assert.equal(h.host.style.top, '764px');
  for (const token of ['width:36px', 'height:36px', 'background:transparent', '1.5px solid', 'z-index:2000000', 'right:60px', 'right:58px', 'width:24px', '1.4s ease-in-out infinite', '0 0 28px', 'prefers-reduced-motion']) assert.match(h.root.innerHTML, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(h.root.innerHTML, /button\{[^}]*background:var\(--qqj-fab-surface\)/, '悬浮球在所有主题下保持透明底');
  assert.doesNotMatch(h.root.innerHTML, /--SmartTheme(?:Quote|Body)Color/, 'FAB 使用统一解析后的实色 palette，不绕过透明回退');
  assert.match(h.root.innerHTML, /stroke-width="1\.8"/);
  h.fab.setAppearance({ mode: 'auto', effectiveTheme: 'night', palette: { knot: '#resolved-knot', ink: '#resolved-ink', panel: '#resolved-panel' } });
  assert.equal(h.host.style['--qqj-fab-primary'], '#resolved-knot'); assert.equal(h.host.style['--qqj-fab-ink'], '#resolved-ink');
  assert.equal(h.host.style['--qqj-fab-surface'], '#resolved-panel');
  assert.equal(h.button.attributes['aria-busy'], 'false');
  assert.equal(h.fab.setBusy(true), true); assert.equal(h.button.classList.contains('busy'), true); assert.equal(h.button.attributes['aria-busy'], 'true');
  assert.equal(h.fab.setBusy(false), false); assert.equal(h.button.classList.contains('busy'), false); assert.equal(h.button.attributes['aria-busy'], 'false');
});

test('悬浮球区分点击和 5px 以上拖动，保存桌面位置并完整收尾 pointercancel', async () => {
  const h = harness();
  await h.button.fire('pointerdown', { pointerId: 7, clientX: 100, clientY: 100 });
  await h.button.fire('pointermove', { pointerId: 7, clientX: 110, clientY: 112 });
  await h.button.fire('pointerup', { pointerId: 7 });
  assert.deepEqual(JSON.parse(h.stored.get('qqj-fab-pos')), { x: 110, y: 112 }); assert.deepEqual(h.button.released, [7]);
  const suppressed = await h.button.fire('click'); assert.equal(suppressed.prevented, true); assert.equal(h.clicks, 0);
  await h.button.fire('click'); assert.equal(h.clicks, 1);

  await h.button.fire('pointerdown', { pointerId: 8, clientX: 110, clientY: 112 });
  await h.button.fire('pointermove', { pointerId: 8, clientX: 130, clientY: 132 });
  await h.button.fire('pointercancel', { pointerId: 8 });
  assert.deepEqual(h.button.released, [7, 8]);
  const cancelledClick = await h.button.fire('click'); assert.equal(cancelledClick.prevented, true); assert.equal(h.clicks, 1);
});

test('手机本页面会话保留拖拽位置并约束视口，重建仍默认且不覆盖桌面坐标', async () => {
  const h = harness({ width: 390, height: 700, saved: { x: 12, y: 34 } });
  assert.equal(h.host.style.left, ''); assert.equal(h.host.style.right, '58px'); assert.equal(h.host.style.top, 'calc(100dvh - 100px - 44px)');
  await h.button.fire('pointerdown', { clientX: 100, clientY: 100 }); await h.button.fire('pointermove', { clientX: 120, clientY: 120 }); await h.button.fire('pointerup');
  assert.deepEqual(JSON.parse(h.stored.get('qqj-fab-pos')), { x: 12, y: 34 }); assert.deepEqual(h.writes, []);
  h.fab.restore(); assert.equal(h.host.style.left, '120px'); assert.equal(h.host.style.top, '120px'); assert.equal(h.host.style.right, 'auto');
  h.windowRef.innerWidth = 70; h.windowRef.innerHeight = 90; h.fab.onResize();
  assert.equal(h.host.style.left, '34px'); assert.equal(h.host.style.top, '54px', '短视口按悬浮球尺寸限制底边'); assert.deepEqual(h.writes, []);
  h.windowRef.innerWidth = 1000; h.windowRef.innerHeight = 800; h.fab.onResize();
  assert.equal(h.host.style.left, '12px'); assert.equal(h.host.style.top, '34px', '切回桌面恢复桌面持久坐标'); assert.deepEqual(h.writes, []);
  h.windowRef.innerWidth = 390; h.windowRef.innerHeight = 700; h.fab.onResize();
  assert.equal(h.host.style.left, '34px'); assert.equal(h.host.style.top, '54px', '回到手机宽度继续使用本次会话坐标');

  const fresh = harness({ width: 390, height: 700 });
  assert.equal(fresh.host.style.left, ''); assert.equal(fresh.host.style.right, '58px'); assert.equal(fresh.host.style.top, 'calc(100dvh - 100px - 44px)');
  assert.deepEqual(fresh.writes, [], '重新创建手机 FAB 不读取或写入持久位置');
  await fresh.button.fire('pointerdown', { clientX: 100, clientY: 100 }); await fresh.button.fire('pointermove', { clientX: 130, clientY: 140 }); await fresh.button.fire('pointerup');
  fresh.windowRef.innerWidth = 1000; fresh.windowRef.innerHeight = 800; fresh.fab.onResize();
  assert.equal(fresh.host.style.left, ''); assert.equal(fresh.host.style.right, '60px'); assert.equal(fresh.host.style.top, 'calc(100dvh - 80px - 44px)', '无桌面存档时扩宽应使用桌面默认位');
  assert.deepEqual(fresh.writes, []);
});
