import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourcePermissionView } from '../src/ui/source-permission-view.js';

class Node {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.events = {}; this.className = ''; this.id = ''; this.open = false;
    this.checked = false; this.indeterminate = false; this.value = ''; this.type = ''; this.placeholder = ''; this.scrollTop = 0; this._text = '';
  }
  append(...children) { this.children.push(...children); for (const child of children) if (child instanceof Node) child.parentNode = this; }
  replaceChildren(...children) { this.children = []; this.scrollTop = 0; this.append(...children); }
  addEventListener(name, handler) { (this.events[name] ||= []).push(handler); }
  async fire(name) { const event = { currentTarget: this, target: this, stopPropagation() {} }; for (const handler of this.events[name] || []) await handler(event); }
  get textContent() { return this._text || this.children.map(child => child?.textContent ?? '').join(''); }
  set textContent(value) { this._text = String(value); }
  descendants() { return this.children.flatMap(child => child instanceof Node ? [child, ...child.descendants()] : []); }
}

const documentRef = { createElement: tag => new Node(tag), defaultView: { getComputedStyle: node => ({ overflowY: ['host-scroll', 'source-permission-list'].includes(node.className) ? 'auto' : 'visible' }) } };
const flush = () => new Promise(resolve => setImmediate(resolve));

test('世界书排除 UI 只做整本排除：标题正确、勾选=排除、无任何条目级 UI', async () => {
  let inspectCalls = 0;
  const snapshot = {
    status: 'ready', bookNames: ['甲书', '乙书'], excludedBooks: ['甲书'], warnings: [],
    entries: [
      { key: '乙书::1', source: '乙书', scope: 'char', label: '启用条目', preview: '启用预览', content: '启用全文', hostEnabled: true },
      { key: '乙书::2', source: '乙书', scope: 'char', label: '关闭条目', preview: '关闭预览', content: '关闭全文', hostEnabled: false },
    ],
    allowedKeys: ['乙书::1'],
  };
  const permissions = {
    inspectCurrent: async () => { inspectCalls += 1; return structuredClone(snapshot); },
    setBookExcluded(name, excluded) {
      snapshot.excludedBooks = excluded ? [...new Set([...snapshot.excludedBooks, name])] : snapshot.excludedBooks.filter(item => item !== name);
      return [...snapshot.excludedBooks];
    },
    setEntryAllowed() { throw new Error('世界书排除视图不应操作条目'); },
    setEntriesAllowed() { throw new Error('世界书排除视图不应操作条目'); },
  };
  const view = createSourcePermissionView({ permissions, documentRef });
  const root = view.renderSettings({ open: true });
  const hostScroll = new Node('div'); hostScroll.className = 'host-scroll'; hostScroll.append(root);
  await flush();
  assert.equal(root.tagName, 'details');
  assert.equal(root.open, true);
  assert.equal(inspectCalls, 1);
  assert.match(root.textContent, /世界书排除/);
  assert.match(root.textContent, /已排除 1 \/ 共 2 本/);
  // 条目级 UI 全部拆除
  assert.equal(root.descendants().some(node => node.className?.includes?.('source-book-group')), false);
  assert.equal(root.descendants().some(node => node.className === 'source-entry-content'), false);
  assert.equal(root.textContent.includes('当前列表全部条目'), false);
  assert.equal(root.textContent.includes('构画与千千结'), false);
  // 每本一个整本排除勾选，状态准确
  const labels = root.descendants().filter(node => node.tagName === 'label');
  const excludedRow = labels.find(node => /甲书/.test(node.textContent));
  const includedRow = labels.find(node => /乙书/.test(node.textContent));
  assert.equal(excludedRow.children[0].checked, true);
  assert.equal(includedRow.children[0].checked, false);
  // 搜索后勾选乙书 => 原地整本排除，不重扫或重建当前行
  const search = root.descendants().find(node => node.type === 'search');
  search.value = '乙'; await search.fire('input');
  const list = root.descendants().find(node => node.className === 'source-permission-list');
  const visibleRow = list.children[0];
  const toggle = visibleRow.children[0];
  list.scrollTop = 37;
  toggle.checked = true; await toggle.fire('change'); await flush();
  assert.equal(snapshot.excludedBooks.includes('乙书'), true);
  assert.equal(inspectCalls, 1, '点击不应重新扫描世界书');
  assert.equal(root.descendants().find(node => node.className === 'source-permission-list'), list);
  assert.equal(list.children[0], visibleRow, '点击不应重建当前世界书行');
  assert.equal(visibleRow.children[0], toggle, '点击不应替换当前 checkbox');
  assert.equal(search.value, '乙');
  assert.equal(list.scrollTop, 37);
  assert.match(root.textContent, /已排除 2 \/ 共 2 本/);

  toggle.checked = false; await toggle.fire('change'); await flush();
  assert.deepEqual(snapshot.excludedBooks, ['甲书']);
  assert.equal(inspectCalls, 1);
  assert.equal(list.children[0], visibleRow);
  assert.equal(search.value, '乙');
  assert.equal(list.scrollTop, 37);
  assert.match(root.textContent, /已排除 1 \/ 共 2 本/);
});
