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
    style: {}, shadowRoot: null,
    attachShadow() { this.shadowRoot = root; return root; },
    getBoundingClientRect() { return { left: Number.parseFloat(this.style.left) || 100, top: Number.parseFloat(this.style.top) || 100 }; },
  };
  const stored = new Map(saved ? [['qqj-fab-pos', JSON.stringify(saved)]] : []);
  const storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
  const listeners = {};
  const windowRef = { innerWidth: width, innerHeight: height, localStorage: storage, matchMedia: query => ({ matches: width <= 640 && query.includes('640') }), addEventListener: (name, fn) => { listeners[name] = fn; }, removeEventListener: name => { delete listeners[name]; } };
  const documentRef = { createElement: () => host };
  let clicks = 0;
  const fab = createFab({ documentRef, windowRef, storage, onClick: () => { clicks += 1; } });
  return { fab, host, button, root, stored, listeners, get clicks() { return clicks; } };
}

test('悬浮球使用构画同款视觉 token、独立位置和真实忙灯', () => {
  const h = harness({ saved: { x: 980, y: 790 } });
  assert.equal(h.host.id, 'qqj-fab-host'); assert.equal(h.host.style.left, '964px'); assert.equal(h.host.style.top, '764px');
  for (const token of ['width:36px', 'height:36px', 'opacity:.45', '1.5px solid', 'z-index:2000000', 'right:60px', 'right:58px', 'width:24px', '1.4s ease-in-out infinite', '0 0 28px', 'prefers-reduced-motion']) assert.match(h.root.innerHTML, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(h.root.innerHTML, /--SmartThemeQuoteColor/); assert.match(h.root.innerHTML, /--SmartThemeBodyColor/);
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

test('手机宽度不恢复或覆盖桌面坐标，始终回到错位后的安全默认位', async () => {
  const h = harness({ width: 390, height: 700, saved: { x: 12, y: 34 } });
  assert.equal(h.host.style.left, ''); assert.equal(h.host.style.right, '58px'); assert.equal(h.host.style.top, 'calc(100dvh - 100px - 44px)');
  await h.button.fire('pointerdown', { clientX: 100, clientY: 100 }); await h.button.fire('pointermove', { clientX: 120, clientY: 120 }); await h.button.fire('pointerup');
  assert.deepEqual(JSON.parse(h.stored.get('qqj-fab-pos')), { x: 12, y: 34 });
  h.fab.restore(); assert.equal(h.host.style.left, ''); assert.equal(h.host.style.right, '58px');
});
