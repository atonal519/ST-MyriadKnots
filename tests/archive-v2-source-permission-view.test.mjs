import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchiveV2SourcePermissionView } from '../src/ui/archive-v2-source-permission-view.js';

class Node {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.events = {}; this.className = ''; this.id = ''; this.open = false;
    this.checked = false; this.indeterminate = false; this.value = ''; this.type = ''; this.placeholder = ''; this.scrollTop = 0; this._text = '';
  }
  append(...children) { this.children.push(...children); for (const child of children) if (child instanceof Node) child.parentNode = this; }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  addEventListener(name, handler) { (this.events[name] ||= []).push(handler); }
  async fire(name) { const event = { currentTarget: this, target: this, stopPropagation() {} }; for (const handler of this.events[name] || []) await handler(event); }
  get textContent() { return this._text || this.children.map(child => child?.textContent ?? '').join(''); }
  set textContent(value) { this._text = String(value); }
  descendants() { return this.children.flatMap(child => child instanceof Node ? [child, ...child.descendants()] : []); }
}

const documentRef = { createElement: tag => new Node(tag), defaultView: { getComputedStyle: node => ({ overflowY: node.className === 'host-scroll' ? 'auto' : 'visible' }) } };
const flush = () => new Promise(resolve => setImmediate(resolve));

test('世界书 UI 的整本勾选=排除，计数准确；条目按最终许可显示并保留书级开合与滚动', async () => {
  const snapshot = {
    status: 'ready', bookNames: ['甲书', '乙书'], excludedBooks: ['甲书'], warnings: [],
    entries: [
      { key: '乙书::1', source: '乙书', scope: 'char', label: '启用条目', preview: '启用预览', content: '启用全文', hostEnabled: true },
      { key: '乙书::2', source: '乙书', scope: 'char', label: '关闭条目', preview: '关闭预览', content: '关闭全文', hostEnabled: false },
    ],
    allowedKeys: ['乙书::1'],
  };
  const permissions = {
    inspectCurrent: async () => structuredClone(snapshot),
    setBookExcluded(name, excluded) { snapshot.excludedBooks = excluded ? [...new Set([...snapshot.excludedBooks, name])] : snapshot.excludedBooks.filter(item => item !== name); },
    setEntryAllowed(key, allowed) { snapshot.allowedKeys = allowed ? [...new Set([...snapshot.allowedKeys, key])] : snapshot.allowedKeys.filter(item => item !== key); },
    setEntriesAllowed(states) { for (const state of states) this.setEntryAllowed(state.key, state.allowed); },
  };
  const view = createArchiveV2SourcePermissionView({ permissions, documentRef });
  const root = view.renderSettings({ open: true });
  const hostScroll = new Node('div'); hostScroll.className = 'host-scroll'; hostScroll.append(root);
  await flush();
  assert.equal(root.tagName, 'details');
  assert.equal(root.open, true);
  assert.match(root.textContent, /整本排除 · 已排除 1 \/ 共 2 本/);
  const labels = root.descendants().filter(node => node.tagName === 'label');
  const excludedRow = labels.find(node => /甲书/.test(node.textContent));
  const includedRow = labels.find(node => /乙书/.test(node.textContent) && /构画与千千结/.test(node.textContent));
  assert.equal(excludedRow.children[0].checked, true);
  assert.equal(includedRow.children[0].checked, false);
  const entryRows = labels.filter(node => /条目/.test(node.textContent));
  assert.equal(entryRows.find(node => /启用条目/.test(node.textContent)).children[0].checked, true);
  assert.equal(entryRows.find(node => /关闭条目/.test(node.textContent)).children[0].checked, false);
  assert.match(root.textContent, /宿主当前关闭；千千结可单独覆盖/);

  const bookGroup = root.descendants().find(node => node.className === 'source-group source-book-group');
  bookGroup.open = false; await bookGroup.fire('toggle');
  hostScroll.scrollTop = 37;
  const closedEntry = entryRows.find(node => /关闭条目/.test(node.textContent)).children[0];
  closedEntry.checked = true; await closedEntry.fire('change'); await flush();
  const refreshedGroup = root.descendants().find(node => node.className === 'source-group source-book-group');
  assert.equal(refreshedGroup.open, false);
  assert.equal(hostScroll.scrollTop, 37);
  assert.equal(snapshot.allowedKeys.includes('乙书::2'), true);
});
