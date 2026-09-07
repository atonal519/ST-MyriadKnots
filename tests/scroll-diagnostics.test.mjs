import test from 'node:test';
import assert from 'node:assert/strict';
import { createScrollDiagnostics } from '../src/ui/scroll-diagnostics.js';

class Target {
  constructor() {
    this.listeners = new Map();
    this.scrollTop = 0;
    this.scrollHeight = 980;
    this.clientHeight = 420;
  }
  addEventListener(name, listener) {
    const values = this.listeners.get(name) ?? [];
    values.push(listener);
    this.listeners.set(name, values);
  }
  removeEventListener(name, listener) {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter(value => value !== listener));
  }
  dispatch(name, event = {}) {
    event.defaultPrevented ??= false;
    event.cancelable ??= true;
    event.preventDefault ??= function preventDefault() { if (this.cancelable) this.defaultPrevented = true; };
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(event);
    return event;
  }
}

const touch = (x, y) => ({ clientX: x, clientY: y });
const contentTarget = { id: 'secret-id', className: 'secret-class', textContent: 'secret input', closest: () => null };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('界面滚动诊断被动记录纵向滚动、最终默认阻止状态与QQJ横滑标记', async () => {
  const target = new Target();
  const windowRef = { innerWidth: 390, innerHeight: 844, getComputedStyle: () => ({ overflowY: 'auto', touchAction: 'pan-y' }) };
  let page = 'settings';
  const diagnostics = createScrollDiagnostics({ target, getPage: () => page, windowRef, navigatorRef: { userAgent: 'Shell/1 Mobile' }, now: () => '2026-09-07T00:00:00.000Z' });
  diagnostics.start();

  target.dispatch('touchstart', { touches: [touch(200, 300)], target: contentTarget });
  target.dispatch('touchmove', { touches: [touch(196, 210)], target: contentTarget });
  target.scrollTop = 74; target.dispatch('scroll');
  target.dispatch('touchend', { changedTouches: [touch(195, 190)], target: contentTarget });
  await tick();
  let record = diagnostics.snapshot().records[0];
  assert.deepEqual({ dx: record.dx, dy: record.dy, start: record.startScrollTop, end: record.endScrollTop, scrolled: record.scrollEvent }, { dx: -5, dy: -110, start: 0, end: 74, scrolled: true });
  assert.equal(record.defaultPrevented, false); assert.equal(record.qqjSwipeIntercepted, false);
  assert.deepEqual(record.startStyle, { overflowY: 'auto', touchAction: 'pan-y' });
  assert.deepEqual(record.viewport, { width: 390, height: 844 });

  const externalPrevent = event => event.preventDefault();
  target.addEventListener('touchmove', externalPrevent);
  target.dispatch('touchstart', { touches: [touch(100, 200)], target: contentTarget });
  target.dispatch('touchmove', { touches: [touch(95, 120)], target: contentTarget });
  target.dispatch('touchend', { changedTouches: [touch(95, 110)], target: contentTarget });
  await tick();
  record = diagnostics.snapshot().records.at(-1);
  assert.equal(record.defaultPrevented, true, '微任务应读取同一事件经过其他监听器后的最终状态');
  assert.equal(record.qqjSwipeIntercepted, false, '其他监听器阻止默认行为不得误记成QQJ横滑拦截');
  target.removeEventListener('touchmove', externalPrevent);

  const qqjPrevent = event => { event.preventDefault(); diagnostics.markQqjSwipeIntercepted(); };
  target.addEventListener('touchmove', qqjPrevent);
  target.dispatch('touchstart', { touches: [touch(250, 100)], target: contentTarget });
  target.dispatch('touchmove', { touches: [touch(130, 105)], target: contentTarget });
  target.dispatch('touchend', { changedTouches: [touch(125, 105)], target: contentTarget });
  await tick();
  record = diagnostics.snapshot().records.at(-1);
  assert.equal(record.defaultPrevented, true); assert.equal(record.qqjSwipeIntercepted, true);
  assert.equal(record.page, 'settings'); assert.equal(record.target, 'content');
  const exported = JSON.stringify(diagnostics.snapshot());
  assert.match(exported, /Shell\/1 Mobile/);
  assert.doesNotMatch(exported, /secret-id|secret-class|secret input|url|chatId|floor|正文|API/);
});

test('诊断只在开启时采集、关开保留既有记录、取消手势归零且记录有界', async () => {
  const target = new Target();
  const profileButton = { closest: selector => selector === '.qqj-profile-switcher' ? {} : selector === 'button' ? {} : null };
  const diagnostics = createScrollDiagnostics({ target, maxRecords: 3, windowRef: { getComputedStyle: () => ({ overflowY: 'auto', touchAction: 'pan-y' }) } });
  const gesture = (outcome = 'touchend') => {
    target.dispatch('touchstart', { touches: [touch(90, 180)], target: profileButton });
    target.dispatch(outcome, outcome === 'touchcancel' ? { changedTouches: [touch(92, 120)], target: profileButton } : { changedTouches: [touch(92, 120)], target: profileButton });
  };

  gesture(); await tick(); assert.equal(diagnostics.snapshot().records.length, 0, '面板未开时不采集');
  diagnostics.start(); gesture('touchcancel'); await tick();
  assert.equal(diagnostics.snapshot().records[0].outcome, 'cancelled');
  assert.equal(diagnostics.snapshot().records[0].target, 'profile-strip', '已知内部滚动区优先于其中的普通按钮');
  diagnostics.stop(); gesture(); await tick(); assert.equal(diagnostics.snapshot().records.length, 1);
  diagnostics.start(); gesture(); gesture(); gesture(); gesture(); await tick();
  assert.equal(diagnostics.snapshot().records.length, 3);
  diagnostics.stop(); diagnostics.start(); gesture(); await tick();
  assert.equal(diagnostics.snapshot().records.length, 3, '关开面板后保留最近记录并继续按上限滚动');
});
