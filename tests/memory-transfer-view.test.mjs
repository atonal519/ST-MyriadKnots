import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTransferView, downloadMemoryPackage } from '../src/ui/memory-transfer-view.js';
import * as transferView from '../src/ui/memory-transfer-view.js';

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
    assert.equal(nodes.find(node => node.className === 'settings-result').textContent, '普通记忆包不能超过 64 MB，请在旧设备使用“分卷导出（大记忆）”。');
    for (const control of nodes.filter(node => !node.hidden && (node.tag === 'button' || node === input))) assert.equal(control.disabled, false);
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
  for (const control of nodes.filter(node => !node.hidden && (node.tag === 'button' || node === input))) assert.equal(control.disabled, false);
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

test('volume export produces one download per click and releases each previous URL before advancing', async () => {
  const downloads = [], releases = []; let produced = 0, finished = 0;
  const runtime = { async *exportVolumes() {
    try {
      for (const item of [
        { filename: 'memory.qqj-memory.part-0001.bin', part: 1, manifest: false },
        { filename: 'memory.qqj-memory.part-0002.bin', part: 2, manifest: false },
        { filename: 'memory.qqj-memory.index.json', manifest: true },
      ]) { produced += 1; yield { ...item, blob: new Blob(['test']) }; }
    } finally { finished += 1; }
  } };
  const view = createMemoryTransferView({ runtime, documentRef: { createElement: tag => new Node(tag) },
    downloadVolume: file => { downloads.push(file.filename); return () => releases.push(file.filename); } });
  const nodes = () => flatten(view.node), button = text => nodes().find(node => node.tag === 'button' && node.textContent === text);
  button('分卷导出（大记忆）').fire('click'); await tick();
  assert.equal(produced, 1); assert.equal(downloads.length, 1); assert.equal(releases.length, 0);
  assert.equal(button('导出当前聊天记忆').disabled, true);
  assert.equal(nodes().find(node => node.type === 'file').disabled, true);
  assert.equal(button('下载下一卷').disabled, false); assert.equal(button('结束导出').disabled, false);
  await tick(); assert.equal(produced, 1, 'waiting for the user must not generate another volume');
  button('下载下一卷').fire('click'); await tick();
  assert.deepEqual(releases, ['memory.qqj-memory.part-0001.bin']);
  assert.equal(produced, 2); assert.equal(downloads.length, 2);
  button('下载下一卷').fire('click'); await tick();
  assert.equal(produced, 3); assert.equal(downloads.at(-1), 'memory.qqj-memory.index.json');
  assert.equal(button('下载下一卷').hidden, true); assert.equal(finished, 0);
  button('结束导出').fire('click'); await tick();
  assert.equal(finished, 1); assert.deepEqual(releases, downloads);
  assert.equal(button('导出当前聊天记忆').disabled, false);
  assert.equal(nodes().find(node => node.type === 'file').disabled, false);
  assert.match(nodes().find(node => node.className === 'settings-result').textContent, /导出已完成/);
  assert.match(nodes().find(node => node.className === 'settings-result').textContent, /刷新状态.*查看记忆/);
  view.dispose(); assert.deepEqual(releases, downloads, 'disposing after completion must not retain or release old URLs again');
});

test('ending or leaving volume export closes the iterator and ignores a late volume', async t => {
  for (const leave of ['end', 'dispose']) await t.test(leave, async () => {
    let resolveRead, finished = 0, downloads = 0;
    const waiting = new Promise(resolve => { resolveRead = resolve; });
    const runtime = { async *exportVolumes() { try { await waiting; yield { filename: 'late.bin', blob: new Blob(['late']), part: 1 }; } finally { finished += 1; } } };
    const view = createMemoryTransferView({ runtime, documentRef: { createElement: tag => new Node(tag) },
      downloadVolume: () => { downloads += 1; return () => {}; } });
    const button = text => flatten(view.node).find(node => node.tag === 'button' && node.textContent === text);
    button('分卷导出（大记忆）').fire('click'); await tick();
    assert.equal(button('结束导出').disabled, false, 'stop remains available while reading a volume');
    if (leave === 'end') button('结束导出').fire('click'); else view.dispose();
    resolveRead(); await tick(); await tick();
    assert.equal(downloads, 0); assert.equal(finished, 1);
    if (leave === 'end') { assert.equal(button('导出当前聊天记忆').disabled, false); view.dispose(); }
  });
});

test('leaving after a volume download releases its URL and returns the active iterator', async () => {
  let released = 0, finished = 0;
  const view = createMemoryTransferView({ runtime: { async *exportVolumes() {
    try { yield { filename: 'memory.qqj-memory.part-0001.bin', blob: new Blob(['part']), part: 1 }; }
    finally { finished += 1; }
  } }, documentRef: { createElement: tag => new Node(tag) }, downloadVolume: () => () => { released += 1; } });
  flatten(view.node).find(node => node.textContent === '分卷导出（大记忆）').fire('click'); await tick();
  assert.equal(released, 0); assert.equal(finished, 0);
  view.dispose(); assert.equal(released, 1); await tick(); assert.equal(finished, 1);
});

test('a failed next volume releases the old URL and restores the ordinary controls', async () => {
  let released = 0, finished = 0;
  const view = createMemoryTransferView({ runtime: { async *exportVolumes() {
    try { yield { filename: 'first.bin', blob: new Blob(['part']), part: 1 }; throw new Error('read failed'); }
    finally { finished += 1; }
  } }, documentRef: { createElement: tag => new Node(tag) }, downloadVolume: () => () => { released += 1; } });
  const nodes = () => flatten(view.node);
  nodes().find(node => node.textContent === '分卷导出（大记忆）').fire('click'); await tick();
  nodes().find(node => node.textContent === '下载下一卷').fire('click'); await tick();
  assert.equal(released, 1); assert.equal(finished, 1);
  assert.equal(nodes().find(node => node.className === 'settings-result').textContent, 'read failed');
  assert.equal(nodes().find(node => node.textContent === '导出当前聊天记忆').disabled, false);
  assert.equal(nodes().find(node => node.type === 'file').disabled, false);
  view.dispose();
});

test('volume file selection passes file references without reading a complete file', async () => {
  const files = [
    { name: 'memory.qqj-memory.index.json', size: 900 },
    { name: 'memory.qqj-memory.part-0001.bin', size: 512 * 1024 * 1024 },
    { name: 'memory.qqj-memory.part-0002.bin', size: 512 * 1024 * 1024 },
  ].map(file => ({ ...file, text: () => assert.fail('volume UI must not read whole files') }));
  const plan = { messages: 3, summaries: 1, states: 1 }; let previewed = 0, imported = 0;
  const view = createMemoryTransferView({ runtime: {
    preview: () => assert.fail('volumes use the volume reader'),
    previewVolumes: async selected => { assert.deepEqual(selected, files); previewed += 1; return plan; },
    importPreview: async selected => { assert.equal(selected, plan); imported += 1; return { summaries: 1 }; },
  }, documentRef: { createElement: tag => new Node(tag) }, confirmImpl: async () => true });
  const nodes = flatten(view.node), input = nodes.find(node => node.type === 'file');
  assert.equal(input.multiple, true);
  input.files = files; input.fire('change'); await tick();
  assert.equal(previewed, 1); assert.equal(imported, 0);
  nodes.find(node => node.textContent === '确认导入').fire('click'); await tick(); assert.equal(imported, 1);
  view.dispose();
});

test('volume import requires the manifest and volume files together', async t => {
  for (const names of [['memory.qqj-memory.part-0001.bin'], ['memory.qqj-memory.index.json'], ['one.json', 'two.json']]) await t.test(names.join(', '), async () => {
    let called = 0;
    const view = createMemoryTransferView({ runtime: { preview: async () => { called += 1; }, previewVolumes: async () => { called += 1; } },
      documentRef: { createElement: tag => new Node(tag) } });
    const nodes = flatten(view.node), input = nodes.find(node => node.type === 'file');
    input.files = names.map(name => ({ name, size: 2, text: async () => { called += 1; return '{}'; } }));
    input.fire('change'); await tick(); assert.equal(called, 0);
    assert.match(nodes.find(node => node.className === 'settings-result').textContent, /清单.*全部卷/);
    view.dispose();
  });
});

test('volume download returns a release function instead of retaining every URL on a timer', () => {
  const revoked = []; let appended, clicked = false, removed = false;
  const file = { filename: 'memory.qqj-memory.part-0001.bin', blob: new Blob(['part']) };
  const link = { click() { clicked = true; }, remove() { removed = true; } };
  const release = transferView.downloadMemoryVolume(file, { createElement: () => link, body: { append(node) { appended = node; } },
    defaultView: { URL: { createObjectURL(blob) { assert.equal(blob, file.blob); return 'blob:volume'; }, revokeObjectURL(url) { revoked.push(url); } } } });
  assert.equal(link.download, file.filename); assert.equal(appended, link); assert.equal(clicked, true); assert.equal(removed, true);
  assert.deepEqual(revoked, []); assert.equal(typeof release, 'function'); release(); assert.deepEqual(revoked, ['blob:volume']);
});
