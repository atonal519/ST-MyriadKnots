import test from 'node:test';
import assert from 'node:assert/strict';
import { bindHorizontalStrip, openPeopleOrderDialog } from '../src/ui/people-interactions.js';

class Node {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = new Map(); this.className = ''; this.textContent = ''; this.attributes = {}; this.scrollLeft = 0; this.scrollTop = 0; this.scrollWidth = 0; this.clientWidth = 0; this.scrollHeight = 0; this.clientHeight = 0; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  addEventListener(name, listener) { const values = this.listeners.get(name) ?? []; values.push(listener); this.listeners.set(name, values); }
  fire(name, values = {}) { const event = { type: name, currentTarget: this, target: this, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() {}, ...values }; for (const listener of this.listeners.get(name) ?? []) listener(event); return event; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  setPointerCapture(pointerId) { this.capturedPointer = pointerId; }
  releasePointerCapture(pointerId) { if (this.capturedPointer === pointerId) this.capturedPointer = null; }
  getBoundingClientRect() { return this.rect ?? { top: 0, bottom: 200, height: 200 }; }
  get classList() { return { add: value => { if (!this.className.split(' ').includes(value)) this.className += `${this.className ? ' ' : ''}${value}`; }, remove: value => { this.className = this.className.split(' ').filter(item => item && item !== value).join(' '); } }; }
}
const documentRef = { createElement: tag => new Node(tag) };
const flatten = node => [node, ...node.children.flatMap(flatten)];

test('横栏仅在鼠标越过阈值后捕获，拖动抑制本次点击且滚轮只在可消费时横移', () => {
  const strip = bindHorizontalStrip(new Node()); strip.scrollWidth = 300; strip.clientWidth = 100;
  strip.fire('pointerdown', { pointerType: 'mouse', button: 0, pointerId: 1, clientX: 50 });
  assert.equal(strip.capturedPointer, undefined, '普通按下不应提前重定向按钮点击');
  strip.fire('pointerup', { pointerId: 1 });
  assert.equal(strip.fire('click').defaultPrevented, undefined, '普通点击保持可用');

  strip.fire('pointerdown', { pointerType: 'mouse', button: 0, pointerId: 2, clientX: 60 });
  strip.fire('pointermove', { pointerId: 2, clientX: 20 }); assert.equal(strip.capturedPointer, 2); assert.equal(strip.scrollLeft, 40);
  strip.fire('pointerup', { pointerId: 2 }); assert.equal(strip.fire('click').defaultPrevented, true); assert.equal(strip.fire('click').defaultPrevented, undefined);
  const consumed = strip.fire('wheel', { deltaX: 0, deltaY: 20, deltaMode: 0 }); assert.equal(strip.scrollLeft, 60); assert.equal(consumed.defaultPrevented, true);
  strip.scrollLeft = 200; assert.equal(strip.fire('wheel', { deltaX: 0, deltaY: 20, deltaMode: 0 }).defaultPrevented, undefined, '横向边界放行页面滚动');
  strip.scrollLeft = 50; strip.fire('wheel', { deltaX: 3, deltaY: 20, deltaMode: 0 }); assert.equal(strip.scrollLeft, 50, '水平触控板输入不重复转换');

  strip.fire('pointerdown', { pointerType: 'mouse', button: 0, pointerId: 3, clientX: 60 }); strip.fire('pointermove', { pointerId: 3, clientX: 20 }); strip.fire('pointercancel', { pointerId: 3 });
  assert.equal(strip.fire('click').defaultPrevented, undefined, '取消拖动不吞掉下一次普通点击');
});

test('排序向下拖动按目标前方插入，且切聊后提交不会调用持久化', async () => {
  const ids = ['a', 'b', 'c', 'd'], people = ids.map(entityId => ({ entityId, displayName: entityId.toUpperCase() }));
  let options, chatId = 'chat-a'; const saves = [];
  const runtime = { getState: () => ({ chatId }), async setPersonOrderEntityIds(order) { saves.push([...order]); return { chatId }; } };
  openPeopleOrderDialog({ customImpl: value => { options = value; return Promise.resolve(null); }, runtime, people, documentRef, chatId });
  const list = flatten(options.content).find(node => node.className === 'qqj-people-order-list');
  list.children.forEach((row, index) => { row.getBoundingClientRect = () => ({ top: index * 40, height: 40 }); });
  const secondHandle = flatten(list.children[1]).find(node => node.className === 'qqj-people-order-handle');
  secondHandle.fire('pointerdown', { pointerId: 4, button: 0 }); list.fire('pointermove', { pointerId: 4, clientY: 125 }); list.fire('pointerup', { pointerId: 4 });
  await options.submit(); assert.deepEqual(saves, [['a', 'c', 'b', 'd']]);

  openPeopleOrderDialog({ customImpl: value => { options = value; return Promise.resolve(null); }, runtime, people, documentRef, chatId });
  chatId = 'chat-b'; await assert.rejects(options.submit(), /聊天已变化/); assert.equal(saves.length, 1);
});
