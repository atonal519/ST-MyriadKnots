import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDialogManager } from '../src/ui/dialog.js';

function fakeDom({ withContextChange = false } = {}) {
  let uid = 0;
  const mounted = [];
  const documentRef = { activeElement: null };
  class Element {
    constructor({ tag = 'div', classes = [], attrs = {} } = {}) {
      this.uid = ++uid; this.tag = tag; this.classes = new Set(classes); this.attrs = { ...attrs }; this.value = attrs.value ?? '';
      this.handlers = new Map(); this.children = []; this.parent = null; this.removed = false; this.htmlValue = ''; this.style = { setProperty: (name, value) => { this.style[name] = value; } };
    }
    focus(options) { documentRef.activeElement = this; this.focused = (this.focused ?? 0) + 1; this.focusOptions = options; }
    select() { this.selected = true; }
    setAttribute(name, value) { this.attrs[name] = String(value); }
  }
  const addChild = (parent, child) => { child.parent = parent; parent.children.push(child); return child; };
  const descendants = root => root.children.flatMap(child => [child, ...descendants(child)]);
  const matches = (element, selector) => {
    if (selector.startsWith('#')) return element.attrs.id === selector.slice(1);
    if (selector.startsWith('.')) return element.classes.has(selector.slice(1));
    const attr = selector.match(/^\[([^=\]]+)(?:="?([^"\]]+)"?)?\]$/);
    return Boolean(attr && Object.hasOwn(element.attrs, attr[1]) && (attr[2] == null || String(element.attrs[attr[1]]) === attr[2]));
  };
  const parseInto = (root, html) => {
    root.children = [];
    for (const match of String(html).matchAll(/<(button|input|div)\b([^>]*)>/gi)) {
      const attrs = {};
      for (const item of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[item[1]] = item[2] ?? '';
      addChild(root, new Element({ tag: match[1], classes: String(attrs.class || '').split(/\s+/).filter(Boolean), attrs }));
    }
  };
  class Collection {
    constructor(elements = []) { this.elements = elements; }
    get 0() { return this.elements[0]; }
    get length() { return this.elements.length; }
    first() { return new Collection(this.elements.slice(0, 1)); }
    last() { return new Collection(this.elements.slice(-1)); }
    find(selector) { return new Collection(this.elements.flatMap(element => descendants(element).filter(child => matches(child, selector)))); }
    on(event, handler) { for (const element of this.elements) { const list = element.handlers.get(event) ?? []; list.push(handler); element.handlers.set(event, list); } return this; }
    trigger(event) {
      for (const element of this.elements) {
        if (event === 'focus') element.focus();
        else if (event === 'select') element.select();
        const value = typeof event === 'string' ? { type: event, target: element, preventDefault() {} } : event;
        for (const handler of element.handlers.get(value.type) ?? []) handler.call(element, value);
      }
      return this;
    }
    attr(name) { return this.elements[0]?.attrs?.[name]; }
    val(value) { if (value === undefined) return this.elements[0]?.value; for (const element of this.elements) element.value = String(value); return this; }
    html(value) { if (value === undefined) return this.elements[0]?.htmlValue ?? ''; for (const element of this.elements) element.htmlValue = String(value); return this; }
    empty() { return this.html(''); }
    addClass(names) { for (const element of this.elements) for (const name of String(names).split(/\s+/).filter(Boolean)) element.classes.add(name); return this; }
    remove() { for (const element of this.elements) element.removed = true; return this; }
  }
  const $ = value => {
    if (value instanceof Element) return new Collection([value]);
    if (typeof value === 'string' && value.trim().startsWith('<')) {
      const root = new Element({ classes: ['sp-dialog-overlay'], attrs: { id: 'sp-addon-dialog' } }); parseInto(root, value); return new Collection([root]);
    }
    return new Collection([]);
  };
  const shadow = {
    innerHTML: '', activeElement: null,
    appendChild(element) { mounted.push(element); },
    querySelector(selector) { return mounted.findLast(item => !item.removed && matches(item, selector)) ?? null; },
  };
  documentRef.createElement = () => { const host = new Element(); host.id = ''; host.attachShadow = () => shadow; return host; };
  const contextListeners = new Set();
  const manager = createDialogManager({ documentRef, $, schedule: callback => callback(), subscribeContextChange: withContextChange ? handler => { contextListeners.add(handler); return () => contextListeners.delete(handler); } : undefined });
  const active = () => mounted.findLast(item => !item.removed);
  const find = selector => $(active()).find(selector);
  return { $, documentRef, manager, shadow, active, find, fireContextChange: () => { for (const handler of [...contextListeners]) handler(); } };
}

test('构画同源确认、提示、输入校验与外部关闭保留 QQJ 生命周期', async () => {
  const h = fakeDom();
  const trigger = { focus(options) { this.focused = (this.focused ?? 0) + 1; this.focusOptions = options; } };
  h.documentRef.activeElement = { shadowRoot: { activeElement: trigger } };

  const cancelled = h.manager.confirm({ title: '删除', body: '确定吗？' });
  assert.equal(h.manager.hasActive(), true);
  h.find('[data-dialog-choice="0"]').trigger('click');
  assert.equal(await cancelled, false);
  assert.equal(trigger.focused, 1); assert.deepEqual(trigger.focusOptions, { preventScroll: true });

  h.documentRef.activeElement = trigger;
  const accepted = h.manager.confirm({ title: '删除', body: '确定吗？' });
  h.find('[data-dialog-choice="1"]').trigger('click');
  assert.equal(await accepted, true);

  const prompted = h.manager.prompt({ title: '另存为', initialValue: ' 草稿 ', validate: value => value ? '' : '请输入名称' });
  const input = h.find('.sp-dialog-input');
  input.val(''); h.find('.sp-dialog-submit').trigger('click');
  assert.match(h.find('.sp-dialog-input-error').html(), /请输入名称/);
  assert.equal(h.manager.hasActive(), true);
  input.val(' 新预设 '); h.find('.sp-dialog-submit').trigger('click');
  assert.equal(await prompted, '新预设');

  const informed = h.manager.info({ title: '说明', body: '帮助', confirmText: '知道了' });
  assert.equal(h.find('[data-dialog-choice]').length, 1);
  h.find('[data-dialog-choice="0"]').trigger('click');
  assert.equal(await informed, true);

  const outside = h.manager.prompt({ title: '外部关闭', initialValue: '保留草稿' });
  h.$(h.active()).trigger({ type: 'click', target: h.active(), preventDefault() {} });
  assert.equal(await outside, null);
  assert.equal(h.manager.hasActive(), false);
});

test('打开新窗结算旧 Promise，closeAll/cancelTop 继续可用', async () => {
  const h = fakeDom();
  const old = h.manager.prompt({ title: '旧窗', initialValue: '未提交草稿' });
  const next = h.manager.confirm({ title: '新窗' });
  assert.equal(await old, null);
  assert.equal(h.manager.cancelTop(), true);
  assert.equal(await next, false);
  const final = h.manager.prompt({ title: '最终窗' });
  assert.equal(h.manager.closeAll(), true);
  assert.equal(await final, null);
});

test('宿主 CHAT_CHANGED 经同源生命周期立即关闭确认窗', async () => {
  const h = fakeDom({ withContextChange: true });
  let confirmed = false;
  const pending = h.manager.confirm({ title: '完全重构', body: '切聊后不可继续' }).then(value => { confirmed = value; return value; });
  h.fireContextChange();
  assert.equal(await pending, false);
  assert.equal(confirmed, false);
  assert.equal(h.manager.hasActive(), false);
});

test('复制构画实际结构/CSS闭包并映射 QQJ 实色主题', async () => {
  const h = fakeDom();
  const css = h.shadow.innerHTML;
  for (const marker of ['.sp-dialog-overlay', 'background:rgba(0,0,0,.55)', 'align-items:center', '.sp-dialog-sheet', 'box-shadow:var(--sp-shadow)', '.sp-dialog-note', '.sp-dialog-actions', '.sp-dialog-button-secondary', '.sp-dialog-input-error', 'width:100dvw', 'height:100dvh', '@keyframes sp-wi-fullview-in', 'prefers-reduced-motion:reduce']) assert.match(css, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(css, /align-items:flex-end|position:sticky/);
  const mobileRoot = css.indexOf('@media(max-width:640px){.sp-root{');
  const clickableOverlay = css.indexOf('.sp-dialog-overlay{');
  assert.ok(mobileRoot >= 0 && mobileRoot < clickableOverlay, '须保持构画原顺序：mobile root none 在前，overlay auto 在后');
  const active = h.manager.confirm({ title: '级联验证' });
  assert.equal(h.active().classes.has('sp-root'), true);
  assert.equal(h.active().classes.has('sp-dialog-overlay'), true, '同一遮罩同时命中两条同权重规则，顺序才决定最终点击能力');
  h.manager.closeAll(); await active;
  h.manager.setAppearance({ mode: 'auto', effectiveTheme: 'night', palette: { paper: '#paper', panel: '#panel', ink: '#ink', soft: '#soft', line: '#line', knot: '#knot' } });
  assert.equal(h.manager.host.style['--qqj-dialog-sheet'], '#panel');
  assert.equal(h.manager.host.style['--qqj-dialog-surface'], '#paper');
  assert.equal(h.manager.host.style['--qqj-dialog-primary'], '#knot');
  const source = await readFile(new URL('../src/ui/gouhua-dialog-core.js', import.meta.url), 'utf8');
  for (const name of ['prepareDialog', 'mountDialog', 'choose', 'confirm', 'prompt']) assert.match(source, new RegExp(`function ${name}\\(`));
  assert.doesNotMatch(source, /selectMany|selectOne|promptTextarea|promptFields/);
});
