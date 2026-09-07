import test from 'node:test';
import assert from 'node:assert/strict';
import { createInlineSelect } from '../src/ui/inline-select.js';

class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.events = {}; this.attributes = {}; this.className = ''; this.hidden = false; this.disabled = false; this.textContent = ''; }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, listener) { (this.events[name] ||= []).push(listener); }
  fire(name, event = {}) { for (const listener of this.events[name] ?? []) listener({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...event }); }
  contains(target) { return target === this || this.children.some(child => child.contains?.(target)); }
  focus(options) { this.focused = (this.focused ?? 0) + 1; this.focusOptions = options; }
  get classList() { return { add: name => { if (!this.className.split(' ').includes(name)) this.className += `${this.className ? ' ' : ''}${name}`; }, remove: name => { this.className = this.className.split(' ').filter(value => value && value !== name).join(' '); } }; }
}

const documentRef = { createElement: tag => new Node(tag) };
const options = [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }];

test('内联选择保留值、键盘与禁用语义，并且焦点移到同级时只展开当前菜单', () => {
  const changes = [], focuses = [];
  const first = createInlineSelect({ documentRef, options, value: 'a', onChange: value => changes.push(value), onFocus: () => focuses.push('first') });
  const second = createInlineSelect({ documentRef, options, value: 'b', onFocus: () => focuses.push('second') });

  first.trigger.fire('focus'); first.trigger.fire('click');
  assert.equal(first.list.hidden, false); assert.deepEqual(focuses, ['first']);
  first.node.fire('focusout', { relatedTarget: second.trigger });
  second.trigger.fire('focus'); second.trigger.fire('click');
  assert.equal(first.list.hidden, true); assert.equal(second.list.hidden, false); assert.deepEqual(focuses, ['first', 'second']);

  second.trigger.fire('keydown', { key: 'Escape' });
  assert.equal(second.list.hidden, true); assert.deepEqual(second.trigger.focusOptions, undefined);
  first.trigger.fire('keydown', { key: 'Enter' });
  assert.equal(first.list.hidden, false, '键盘 Enter 应展开');
  first.trigger.fire('click');
  assert.equal(first.list.hidden, false, '原生 button 后续 click 不得把刚展开的菜单反向关闭');
  first.list.children[1].fire('click');
  assert.equal(first.node.value, 'b'); assert.deepEqual(changes, ['b']); assert.equal(first.list.hidden, true); assert.deepEqual(first.trigger.focusOptions, { preventScroll: true }, '鼠标选中后焦点应回到可见触发器');

  first.node.value = 'a';
  assert.equal(first.node.value, 'a'); assert.equal(first.trigger.children[0].textContent, '甲'); assert.deepEqual(changes, ['b'], '程序同步值不应冒充用户 change');
  first.node.disabled = true; first.trigger.fire('click'); first.list.children[1].fire('click');
  assert.equal(first.list.hidden, true); assert.equal(first.node.value, 'a'); assert.equal(first.trigger.disabled, true); assert.equal(first.list.children.every(node => node.disabled), true);

  first.node.disabled = false; first.trigger.fire('click'); first.list.children[1].fire('keydown', { key: 'Enter' }); first.list.children[1].fire('click');
  assert.equal(first.node.value, 'b'); assert.equal(first.list.hidden, true); assert.deepEqual(first.trigger.focusOptions, { preventScroll: true }, '键盘选中后焦点应回到可见触发器');
  assert.deepEqual(changes, ['b', 'b'], '键盘后的原生 click 不得重复触发 change');
});
