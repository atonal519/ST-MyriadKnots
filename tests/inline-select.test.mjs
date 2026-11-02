import test from 'node:test';
import assert from 'node:assert/strict';
import { createInlineSelect } from '../src/ui/inline-select.js';

class Node {
  constructor(tag, ownerDocument) { this.tagName = tag; this.ownerDocument = ownerDocument; this.children = []; this.events = {}; this.attributes = {}; this.className = ''; this.hidden = false; this.disabled = false; this.textContent = ''; }
  append(...nodes) { for (const node of nodes) { this.children.push(node); node.parentNode = this; } }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, listener) { (this.events[name] ||= []).push(listener); }
  fire(name, event = {}) { for (const listener of this.events[name] ?? []) listener({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...event }); }
  contains(target) { return target === this || this.children.some(child => child.contains?.(target)); }
  focus(options) { this.focused = (this.focused ?? 0) + 1; this.focusOptions = options; this.ownerDocument.activeElement = this; }
  getRootNode() { return this.ownerDocument; }
  get classList() { return { add: name => { if (!this.className.split(' ').includes(name)) this.className += `${this.className ? ' ' : ''}${name}`; }, remove: name => { this.className = this.className.split(' ').filter(value => value && value !== name).join(' '); } }; }
}

const documentRef = { activeElement: null, createElement: tag => new Node(tag, documentRef) };
const options = [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }];

test('内联选择保留值、键盘与禁用语义，并且焦点移到同级时只展开当前菜单', async () => {
  const changes = [], focuses = [];
  const first = createInlineSelect({ documentRef, options, value: 'a', onChange: value => changes.push(value), onFocus: () => focuses.push('first') });
  const second = createInlineSelect({ documentRef, options, value: 'b', onFocus: () => focuses.push('second') });

  first.trigger.fire('focus'); first.trigger.fire('click');
  assert.equal(first.list.hidden, false); assert.deepEqual(focuses, ['first']);
  first.node.fire('focusout', { relatedTarget: second.trigger });
  second.trigger.fire('focus'); second.trigger.fire('click');
  await new Promise(resolve => setTimeout(resolve, 0));
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

test('focusout 未提供目标时按实际焦点归属关闭，选项点击只触发一次', async () => {
  const changes = [];
  const select = createInlineSelect({ documentRef, options, value: 'a', onChange: value => changes.push(value) });
  select.trigger.fire('click');
  documentRef.activeElement = null;
  select.node.fire('focusout', { relatedTarget: null });
  await Promise.resolve();
  assert.equal(select.list.hidden, false, '焦点清理时机早于新焦点时不能在微任务内关掉菜单');
  assert.equal(select.list.children[1].attributes.tabindex, '-1', '显式 tabindex 让 WebKit 鼠标按下选项时也建立组件内焦点');
  select.list.children[1].focus();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(select.list.hidden, false, '按下后选项已取得内部焦点时，早于松手 click 的定时检查不得关闭菜单');
  select.list.children[1].fire('click');
  assert.equal(select.value, 'b'); assert.deepEqual(changes, ['b']); assert.equal(select.list.hidden, true);

  select.trigger.fire('click');
  const outside = documentRef.createElement('button');
  documentRef.activeElement = null;
  select.node.fire('focusout', { relatedTarget: null });
  outside.focus();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(select.list.hidden, true, '实际焦点已离开组件时应关闭');
});

test('局部更新预设名称保留选值、展开与禁用状态，不派发change', () => {
  const changes = [], picker = createInlineSelect({ documentRef, options, value: 'a', onChange: value => changes.push(value) });
  picker.open();
  assert.equal(picker.setOptionLabel('a', '甲的新名'), true);
  assert.equal(picker.trigger.children[0].textContent, '甲的新名');
  assert.equal(picker.list.children[0].textContent, '甲的新名');
  assert.equal(picker.value, 'a'); assert.equal(picker.list.hidden, false); assert.deepEqual(changes, []);
  picker.setValue('b'); picker.setValue('a'); assert.equal(picker.trigger.children[0].textContent, '甲的新名');
  picker.setDisabled(true); picker.setOptionLabel('a', '再次改名'); assert.equal(picker.trigger.disabled, true);
  assert.equal(picker.setOptionLabel('missing', '不存在'), false); assert.equal(picker.value, 'a');
});

const descendants = node => [node, ...node.children.flatMap(descendants)];
test('可搜索内联单选按完整路径过滤，清空搜索/取消不改已选，键盘只走可见选项',()=>{
 const changes=[],picker=createInlineSelect({documentRef,searchable:true,showChevron:false,searchPlaceholder:'搜索地点名称或路径',options:[{value:'',label:'无（顶层地点）'},{value:'l1',label:'宿舍 / 一楼'},{value:'l2',label:'宿舍 / 二楼'},{value:'other',label:'工作室 / 一楼'}],value:'l2',onChange:value=>changes.push(value)});
 const find=cls=>descendants(picker.node).find(node=>node.className.split(' ').includes(cls)),search=find('qqj-inline-select-search-input'),clear=find('qqj-inline-select-search-clear');assert.ok(search,'在原选择面板内提供搜索');assert.ok(clear);assert.equal(picker.trigger.children.some(node=>node.className==='qqj-inline-select-chevron'),false);
 picker.open();assert.equal(documentRef.activeElement,search);search.value='宿舍 一楼';search.fire('input');assert.deepEqual(picker.list.children.filter(node=>!node.hidden).map(node=>node.textContent),['宿舍 / 一楼']);assert.equal(picker.value,'l2');assert.deepEqual(changes,[]);
 search.fire('keydown',{key:'ArrowDown'});assert.equal(documentRef.activeElement,picker.list.children[1]);picker.list.children[1].fire('keydown',{key:'ArrowDown'});assert.equal(documentRef.activeElement,picker.list.children[1],'隐藏选项不进入方向键循环');
 clear.fire('click');assert.equal(search.value,'');assert.equal(picker.list.children.filter(node=>!node.hidden).length,4);assert.equal(picker.value,'l2');assert.deepEqual(changes,[]);search.fire('keydown',{key:'Escape'});assert.equal(picker.list.hidden,true);assert.equal(documentRef.activeElement,picker.trigger);assert.deepEqual(changes,[]);
 picker.open();search.value='不存在';search.fire('input');search.fire('keydown',{key:'Enter'});assert.equal(picker.value,'l2');assert.deepEqual(changes,[]);search.value='工作室 一楼';search.fire('input');search.fire('keydown',{key:'Enter'});assert.equal(picker.value,'other');assert.deepEqual(changes,['other']);assert.equal(picker.list.hidden,true);
});

test('搜索输入的Enter与Escape截住表单提交，IME确认不触发选择',()=>{
 const changes=[],picker=createInlineSelect({documentRef,searchable:true,options,value:'a',onChange:value=>changes.push(value)}),search=descendants(picker.node).find(node=>node.className==='settings-input qqj-inline-select-search-input');assert.ok(search);picker.open();search.value='乙';search.fire('input');let stopped=0;search.fire('keydown',{key:'Enter',isComposing:true,preventDefault(){stopped++;},stopPropagation(){stopped++;}});assert.equal(stopped,0);assert.equal(picker.value,'a');search.fire('keydown',{key:'Enter',preventDefault(){stopped++;},stopPropagation(){stopped++;}});assert.equal(stopped,2);assert.equal(picker.value,'b');assert.deepEqual(changes,['b']);
});

test('手动确认当前值仍通知onSelect，程序同步不通知',()=>{
 const changes=[],selections=[],picker=createInlineSelect({documentRef,options:[{value:'a',label:'甲'},{value:'b',label:'乙'}],value:'a',onChange:v=>changes.push(v),onSelect:v=>selections.push(v)});
 picker.list.children[0].fire('click');assert.deepEqual(changes,[]);assert.deepEqual(selections,['a']);picker.setValue('b');assert.deepEqual(selections,['a']);picker.list.children[0].fire('click');assert.deepEqual(changes,['a']);assert.deepEqual(selections,['a','a']);
});
