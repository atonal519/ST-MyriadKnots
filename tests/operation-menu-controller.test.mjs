import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperationMenuController } from '../src/ui/operation-menu-controller.js';

class Node {
  constructor(tag, ownerDocument) { this.tagName = tag.toUpperCase(); this.ownerDocument = ownerDocument; this.children = []; this.listeners = new Map(); this.attributes = {}; this.open = false; this.disabled = false; }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  fire(type, extra = {}) { const event = { key: '', target: this, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra }; for (const listener of this.listeners.get(type) ?? []) listener(event); return event; }
  focus(options) { this.ownerDocument.activeElement = this; this.focusOptions = options; }
  getRootNode() { return this.ownerDocument; }
}

function harness() {
  const doc = new Node('document'); doc.ownerDocument = doc;
  const controller = createOperationMenuController(doc);
  const createMenu = () => {
    const menu = controller.register(new Node('details', doc));
    const trigger = new Node('summary', doc), body = new Node('div', doc);
    const actions = [new Node('button', doc), new Node('button', doc), new Node('button', doc)]; actions[1].disabled = true;
    body.append(...actions); menu.append(trigger, body);
    return { menu, trigger, body, actions };
  };
  return { doc, controller, createMenu };
}

test('行末操作菜单统一单开、状态标识与Escape关闭，焦点返回本菜单入口', async () => {
  const h = harness(), first = h.createMenu(), second = h.createMenu();
  h.controller.activate(); h.controller.activate(); await Promise.resolve();
  assert.equal(first.trigger.attributes['aria-haspopup'], 'menu');
  assert.equal(first.trigger.attributes['aria-expanded'], 'false');
  first.menu.open = true; first.menu.fire('toggle');
  assert.equal(first.trigger.attributes['aria-expanded'], 'true');
  second.menu.open = true; second.menu.fire('toggle');
  assert.equal(first.menu.open, false); assert.equal(second.menu.open, true);
  assert.equal(first.trigger.attributes['aria-expanded'], 'false');
  const escaped = h.doc.fire('keydown', { key: 'Escape', target: second.actions[0], composedPath: () => [second.actions[0], second.body, second.menu] });
  assert.equal(second.menu.open, false); assert.equal(second.trigger.attributes['aria-expanded'], 'false');
  assert.equal(escaped.defaultPrevented, true); assert.equal(escaped.stopped, true, 'Esc只关闭当前菜单，避免同时关闭主面板或弹窗');
  assert.equal(h.doc.activeElement, second.trigger); assert.deepEqual(second.trigger.focusOptions, { preventScroll: true });
  h.controller.deactivate();
  assert.equal(h.doc.listeners.get('click')?.size, 0); assert.equal(h.doc.listeners.get('keydown')?.size, 0);
});

test('行末菜单键盘跳过禁用项，执行动作或点击外部关闭，释放后旧节点不干扰新菜单', async () => {
  const h = harness(), current = h.createMenu(); h.controller.activate(); await Promise.resolve();
  const down = h.doc.fire('keydown', { key: 'ArrowDown', target: current.trigger, composedPath: () => [current.trigger, current.menu] });
  assert.equal(down.defaultPrevented, true); assert.equal(current.menu.open, true); assert.equal(h.doc.activeElement, current.actions[0]);
  h.doc.fire('keydown', { key: 'ArrowDown', target: current.actions[0], composedPath: () => [current.actions[0], current.body, current.menu] });
  assert.equal(h.doc.activeElement, current.actions[2], '方向键跳过不可用操作');
  assert.equal(current.body.attributes.role, 'menu'); assert.equal(current.actions[0].attributes.role, 'menuitem');
  h.doc.fire('click', { target: new Node('shadow-host', h.doc), composedPath: () => [current.trigger, current.menu] });
  assert.equal(current.menu.open, true, 'ShadowRoot重定向的target不能误判为外部');
  h.doc.fire('click', { target: current.actions[2], composedPath: () => [current.actions[2], current.body, current.menu] });
  assert.equal(current.menu.open, false, '执行一个次要动作后收起菜单');
  current.menu.open = true; current.menu.fire('toggle');
  h.doc.fire('click', { target: new Node('div', h.doc), composedPath: () => [] });
  assert.equal(current.menu.open, false);
  h.controller.unregister(current.menu);
  assert.equal(current.menu.listeners.get('toggle')?.size, 0);
  const next = h.createMenu(); await Promise.resolve(); next.menu.open = true; next.menu.fire('toggle');
  current.menu.open = true; current.menu.fire('toggle');
  assert.equal(next.menu.open, true, '旧菜单已释放，不再参与单开管理');
  h.controller.reset(); assert.equal(next.menu.listeners.get('toggle')?.size, 0);
  h.controller.deactivate();
});
