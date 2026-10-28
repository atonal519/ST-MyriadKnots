import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTransferView, downloadMemoryPackage } from '../src/ui/memory-transfer-view.js';

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.events = {}; this.textContent = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(key, callback) { this.events[key] = callback; }
  fire(key) { this.events[key]?.(); }
}
const flatten = node => [node, ...node.children.flatMap(flatten)];
const tick = () => new Promise(resolve => setImmediate(resolve));

test('mobile file selection is preview-only, confirm is scoped and settings can be left safely', async () => {
  const calls = [], downloads = [], toggles = []; let accept = false;
  const plan = { character: '<script>name</script>', messages: 187, summaries: 92, states: 90, replacesMemory: true };
  const runtime = { exportCurrent: async () => ({ filename: 'memory.json', text: '{}' }),
    preview: async text => { calls.push(['preview', text]); return plan; },
    importPreview: async value => { calls.push(['import', value]); return value; }, undo: async () => calls.push(['undo']) };
  const view = createMemoryTransferView({ runtime, documentRef: { createElement: tag => new Node(tag) }, download: value => downloads.push(value), confirmImpl: async () => accept, onToggle: open => toggles.push(open) });
  const nodes = () => flatten(view.node), button = text => nodes().find(node => node.tag === 'button' && node.textContent === text);
  assert.equal(view.node.tag, 'details'); assert.equal(view.node.open, false, '默认折叠导入导出操作');
  view.node.open = true; view.node.fire('toggle'); assert.deepEqual(toggles, [true]);
  button('导出当前聊天记忆').fire('click'); await tick(); assert.equal(downloads.length, 1);
  const input = nodes().find(node => node.type === 'file'); input.files = [{ size: 2, text: async () => '{}' }]; input.fire('change'); await tick();
  assert.deepEqual(calls.map(call => call[0]), ['preview']);
  view.node.open = false; view.node.fire('toggle'); view.node.open = true; view.node.fire('toggle');
  assert.deepEqual(toggles, [true, false, true]);
  assert.deepEqual(calls.map(call => call[0]), ['preview'], '收起再展开不重复读取记忆包');
  assert.ok(nodes().some(node => node.textContent.includes('<script>name</script>') && !node.innerHTML));
  button('确认导入').fire('click'); await tick(); assert.equal(calls.length, 1);
  accept = true; button('确认导入').fire('click'); await tick(); assert.deepEqual(calls[1], ['import', plan]);
  button('撤销上次导入').fire('click'); await tick(); assert.deepEqual(calls[2], ['undo']);
  view.dispose(); button('导出当前聊天记忆').fire('click'); await tick(); assert.equal(downloads.length, 1);
});

test('leaving settings during confirmation prevents import', async () => {
  let finish, imported = false;
  const view = createMemoryTransferView({ runtime: { preview: async () => ({ messages: 2, summaries: 1, states: 0 }), importPreview: async () => { imported = true; } },
    documentRef: { createElement: tag => new Node(tag) }, confirmImpl: () => new Promise(resolve => { finish = resolve; }) });
  const nodes = flatten(view.node), input = nodes.find(node => node.type === 'file');
  input.files = [{ size: 2, text: async () => '{}' }]; input.fire('change'); await tick();
  nodes.find(node => node.textContent === '确认导入').fire('click'); await tick(); view.dispose(); finish(true); await tick();
  assert.equal(imported, false);
});

test('oversized file metadata is rejected before reading, previewing or importing', async t => {
  for (const [label, size] of [['64 MiB + 1 byte', 64 * 1024 * 1024 + 1], ['100 MiB', 100 * 1024 * 1024],
    ['500 MiB', 500 * 1024 * 1024], ['1 GiB', 1024 * 1024 * 1024]]) await t.test(label, async () => {
    const calls = { text: 0, preview: 0, import: 0 };
    const view = createMemoryTransferView({ runtime: {
      preview: async () => { calls.preview += 1; return { messages: 2, summaries: 1, states: 0 }; },
      importPreview: async () => { calls.import += 1; return { summaries: 1 }; },
    }, documentRef: { createElement: tag => new Node(tag) }, confirmImpl: async () => true });
    const nodes = flatten(view.node), input = nodes.find(node => node.type === 'file');
    input.files = [{ size, text: async () => { calls.text += 1; return '{}'; } }];
    input.fire('change'); await tick();
    assert.deepEqual(calls, { text: 0, preview: 0, import: 0 });
    assert.equal(nodes.find(node => node.className === 'settings-result').textContent, '记忆包不能超过 64 MB。');
    for (const control of nodes.filter(node => node.tag === 'button' || node === input)) assert.equal(control.disabled, false);
    nodes.find(node => node.textContent === '确认导入').fire('click'); await tick();
    assert.deepEqual(calls, { text: 0, preview: 0, import: 0 });
    assert.equal(nodes.find(node => node.className === 'settings-result').textContent, '请先选择记忆包并完成预览。');
    view.dispose();
  });
});

test('file metadata at exactly 64 MiB reaches preview without automatically importing', async () => {
  const calls = { text: 0, preview: 0, import: 0 };
  const view = createMemoryTransferView({ runtime: {
    preview: async text => { calls.preview += 1; assert.equal(text, '{}'); return { messages: 2, summaries: 1, states: 0 }; },
    importPreview: async () => { calls.import += 1; return { summaries: 1 }; },
  }, documentRef: { createElement: tag => new Node(tag) } });
  const nodes = flatten(view.node), input = nodes.find(node => node.type === 'file');
  // Size metadata exercises the file-entry boundary; the body stays small in this UI unit test.
  input.files = [{ size: 64 * 1024 * 1024, text: async () => { calls.text += 1; return '{}'; } }];
  input.fire('change'); await tick();
  assert.deepEqual(calls, { text: 1, preview: 1, import: 0 });
  assert.equal(nodes.find(node => node.className === 'settings-result').textContent, '预览通过，点击“确认导入”恢复。');
  for (const control of nodes.filter(node => node.tag === 'button' || node === input)) assert.equal(control.disabled, false);
  view.dispose();
});

test('JSON download uses a mounted anchor and keeps the blob URL available for mobile browsers', () => {
  let clicked, removed, revoked, timer, appended;
  const link = { click() { clicked = true; }, remove() { removed = true; } };
  downloadMemoryPackage({ filename: '记忆.json', text: '{}' }, { createElement: () => link, body: { append(node) { appended = node; } },
    defaultView: { Blob, URL: { createObjectURL(blob) { assert.equal(blob.size, 2); return 'blob:test'; }, revokeObjectURL(url) { revoked = url; } },
      setTimeout(callback, delay) { assert.equal(delay, 60000); timer = callback; } } });
  assert.equal(link.download, '记忆.json'); assert.equal(appended, link); assert.ok(clicked && removed); assert.equal(revoked, undefined);
  timer(); assert.equal(revoked, 'blob:test');
});
