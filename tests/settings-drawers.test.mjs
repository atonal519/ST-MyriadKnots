import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsDrawer, createSettingsDrawerState } from '../src/ui/settings-drawer.js';

class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.events = {}; this.className = ''; this.id = ''; this.open = false; this._text = ''; }
  append(...children) { this.children.push(...children); }
  addEventListener(name, handler) { (this.events[name] ||= []).push(handler); }
  fire(name) { for (const handler of this.events[name] || []) handler({ currentTarget: this, target: this }); }
  get textContent() { return this._text || this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); }
}

const documentRef = { createElement: tag => new Node(tag) };

test('五个一级设置组都使用可键盘操作的原生 details/summary，点击状态会被记录', () => {
  const state = createSettingsDrawerState();
  const drawers = ['general', 'worldbook', 'prompts', 'appearance', 'api'].map(key => createSettingsDrawer({
    documentRef,
    title: key,
    open: state.isOpen(key, key === 'general'),
    onToggle: open => state.set(key, open),
  }));
  assert.equal(drawers.length, 5);
  assert.ok(drawers.every(item => item.drawer.tagName === 'details' && item.summary.tagName === 'summary'));
  for (const { drawer } of drawers) { drawer.open = !drawer.open; drawer.fire('toggle'); }
  assert.deepEqual(state.snapshot(), { general: false, worldbook: true, prompts: true, appearance: true, api: true });
});

test('来源跳转强制展开世界书，普通重渲沿用用户本次开合状态', () => {
  const state = createSettingsDrawerState({ worldbook: false, prompts: true });
  state.open('worldbook');
  const focused = createSettingsDrawer({ documentRef, title: '世界书', open: state.isOpen('worldbook'), onToggle: open => state.set('worldbook', open) });
  assert.equal(focused.drawer.open, true);
  focused.drawer.open = false; focused.drawer.fire('toggle');
  const rerendered = createSettingsDrawer({ documentRef, title: '世界书', open: state.isOpen('worldbook'), onToggle: open => state.set('worldbook', open) });
  assert.equal(rerendered.drawer.open, false);
  assert.equal(state.isOpen('prompts'), true);
});
