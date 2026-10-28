import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTransferView, downloadMemoryPackage } from '../src/ui/memory-transfer-view.js';
import { createMemoryVolumes, MEMORY_VOLUME_BYTES } from '../src/memory-transfer-volumes.js';

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

test('确认后导入被拒时，错误显示在确认导入旁并恢复控件', async () => {
  const failure = '请等待聊天生成和记忆任务完成后再操作。';
  let attempted = 0;
  const plan = { messages: 3, summaries: 1, states: 1 };
  const view = createMemoryTransferView({ runtime: {
    preview: async () => plan,
    importPreview: async selected => { assert.equal(selected, plan); attempted++; throw new Error(failure); },
  }, documentRef: { createElement: tag => new Node(tag) }, confirmImpl: async () => true });
  const nodes = flatten(view.node), input = nodes.find(node => node.type === 'file');
  input.files = [{ size: 2, text: async () => '{}' }]; input.fire('change'); await tick();
  const confirm = nodes.find(node => node.textContent === '确认导入');
  confirm.fire('click'); await tick();
  assert.equal(attempted, 1);
  const body = view.node.children[1], error = body.children.find(node => node.textContent === failure);
  assert.ok(error, '保留实际导入失败原因');
  assert.equal(body.children.indexOf(error), body.children.indexOf(confirm) - 1, '错误应紧邻导入操作，不藏在导出区');
  assert.equal(error.role, 'status'); assert.equal(error['aria-live'], 'polite');
  assert.equal(confirm.disabled, false); assert.equal(input.disabled, false);
  view.dispose();
});

test('普通导出成功和失败都在导出区显示，不占用导入结果', async t => {
  for (const fail of [false, true]) await t.test(fail ? '失败' : '成功', async () => {
    let downloads = 0;
    const view = createMemoryTransferView({ runtime: { async exportCurrent() {
      if (fail) throw new Error('当前记忆尚未准备好。');
      return { filename: 'memory.json', text: '{}' };
    } }, documentRef: { createElement: tag => new Node(tag) }, download: () => { downloads++; } });
    const nodes = flatten(view.node), body = view.node.children[1];
    const button = nodes.find(node => node.textContent === '导出当前聊天记忆');
    button.fire('click'); await tick();
    const output = nodes.find(node => node['aria-label'] === '导出进度');
    const input = nodes.find(node => node.type === 'file');
    assert.match(output.textContent, fail ? /当前记忆尚未准备好/ : /记忆包已生成/);
    assert.ok(body.children.indexOf(output) < body.children.indexOf(input));
    assert.equal(nodes.find(node => node['aria-label'] === '导入与撤销结果').textContent, '');
    assert.equal(downloads, fail ? 0 : 1); assert.equal(button.disabled, false);
    view.dispose();
  });
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
    assert.equal(nodes.find(node => node.className === 'settings-result' && node['aria-label'] === '导入与撤销结果').textContent, '普通记忆包不能超过 64 MB，请在旧设备使用“自动导出大记忆包”。');
    for (const control of nodes.filter(node => !node.hidden && (node.tag === 'button' || node === input))) assert.equal(control.disabled, false);
    nodes.find(node => node.textContent === '确认导入').fire('click'); await tick();
    assert.deepEqual(calls, { text: 0, preview: 0, import: 0 });
    assert.equal(nodes.find(node => node.className === 'settings-result' && node['aria-label'] === '导入与撤销结果').textContent, '请先选择记忆包并完成预览。');
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
  assert.equal(nodes.find(node => node.className === 'settings-result' && node['aria-label'] === '导入与撤销结果').textContent, '预览通过，点击“确认导入”恢复。');
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

async function exportFiles() {
  const chatId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', files = [];
  for await (const file of createMemoryVolumes([
    { kind: 'record', id: 'sample', data: { chatId, text: '合成记忆正文'.repeat(20) } },
    { kind: 'header', value: { source: { chatId }, messages: [] } },
  ], { archiveId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', source: { chatId }, partBytes: 128,
    exportedAt: '2026-10-28T00:00:00.000Z' })) files.push(file);
  return files;
}
async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await tick();
  assert.ok(predicate(), '导出视图未完成预期动作');
}

test('导出进度紧邻取消按钮，并通过可访问状态区域播报', () => {
  const view = createMemoryTransferView({ runtime: {}, documentRef: { createElement: tag => new Node(tag) } });
  const body = view.node.children[1], status = body.children.find(node => node.className === 'settings-result');
  const cancel = body.children.findIndex(node => node.tag === 'button' && node.textContent === '取消导出');
  assert.equal(body.children[cancel + 1], status, '进度需在导出控件旁，不藏在导入与撤销按钮下面');
  assert.equal(status.role, 'status');
  assert.equal(status['aria-live'], 'polite');
  view.dispose();
});

test('核验进度未知总数不显示分母，已知总数照常显示', async () => {
  let progress, release;
  const waiting = new Promise(resolve => { release = resolve; });
  const view = createMemoryTransferView({ runtime: { async *exportVolumes({ onProgress }) {
    progress = onProgress; await waiting;
  } }, documentRef: { createElement: tag => new Node(tag) }, prepareBundleDownload: async () => ({ mode: 'volumes', async abort() {} }) });
  const nodes = () => flatten(view.node), status = () => nodes().find(node => node.className === 'settings-result');
  try {
    nodes().find(node => node.textContent === '自动导出大记忆包').fire('click');
    await waitFor(() => typeof progress === 'function');
    for (const total of [undefined, null]) {
      progress({ phase: 'graph', completed: 120, total });
      assert.equal(status().textContent, '正在核验记忆引用：120 项…');
    }
    progress({ phase: 'graph', completed: 120, total: 250 });
    assert.equal(status().textContent, '正在核验记忆引用：120 / 250 项…');
  } finally { view.dispose(); release(); await tick(); }
});

test('十一卷满8MiB后显示尾部核验进度，继续自动交付清单或取消并忽略迟到进度', async t => {
  for (const cancel of [false, true]) await t.test(cancel ? '尾部核验时取消' : '尾部核验后保存清单', async () => {
    const saved = [], chatId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    let releaseTail, releaseSettled, reachedTail = false, returned = 0, finished = 0, progress;
    const tail = new Promise(resolve => { releaseTail = resolve; });
    const settled = new Promise(resolve => { releaseSettled = resolve; });
    async function* entries(onProgress) {
      try {
        for (let index = 0; index < 11; index++) {
          onProgress({ phase: 'records', completed: index + 1 });
          const empty = { kind: 'record', id: `floor-${index}`, data: '' };
          yield { ...empty, data: 'x'.repeat(MEMORY_VOLUME_BYTES - JSON.stringify(empty).length - 1) };
        }
        onProgress({ phase: 'graph', completed: 0, total: 13 }); reachedTail = true;
        await tail;
        onProgress({ phase: 'manifest', completed: 1, total: 1 });
        yield { kind: 'header', value: { source: { chatId }, messages: [] } };
      } finally { returned++; }
    }
    const view = createMemoryTransferView({ runtime: { async *exportVolumes(options = {}) {
      progress = options.onProgress;
      try {
        yield* createMemoryVolumes(entries(progress ?? (() => {})), {
          archiveId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', source: { chatId },
          exportedAt: '2026-10-28T00:00:00.000Z',
        });
      } finally { await settled; }
    } }, documentRef: { createElement: tag => new Node(tag) }, prepareBundleDownload: async () => ({ mode: 'volumes',
      async saveVolume(file) {
        assert.match(status().textContent, file.manifest ? /正在保存分卷清单/ : new RegExp(`正在保存第 ${file.part} 卷`));
        saved.push({ filename: file.filename, size: file.blob.size, manifest: file.manifest });
      },
      async finish() { finished++; return { delivered: true, message: '已提交全部下载。' }; }, async abort() {} }) });
    const nodes = () => flatten(view.node), button = text => nodes().find(node => node.tag === 'button' && node.textContent === text);
    const status = () => nodes().find(node => node.className === 'settings-result');
    try {
      button('自动导出大记忆包').fire('click'); await waitFor(() => reachedTail);
      assert.equal(saved.length, 11); assert.ok(saved.every(file => file.size === MEMORY_VOLUME_BYTES));
      assert.equal(button('自动导出大记忆包').disabled, true); assert.equal(finished, 0);
      assert.match(status().textContent, /核验记忆引用.*0.*13/);
      for (const [phase, label] of [['auxiliary', '时间、人物与向量'], ['conversation', '聊天正文'], ['avatars', '人物头像'], ['verify', '复核存储记录']]) {
        progress({ phase, completed: 5, total: 11 }); assert.match(status().textContent, new RegExp(`${label}.*5.*11`));
      }
      if (cancel) {
        button('取消导出').fire('click'); await tick();
        progress({ phase: 'graph', completed: 13, total: 13 });
        assert.match(status().textContent, /正在取消导出/);
      }
      releaseTail();
      if (!cancel) {
        await waitFor(() => saved.at(-1)?.manifest);
        assert.equal(finished, 0, '清单已交付也要等导出器收尾，不提前显示完成');
        assert.equal(button('自动导出大记忆包').disabled, true);
      }
      releaseSettled(); await waitFor(() => !button('自动导出大记忆包').disabled);
      assert.equal(returned, 1);
      if (cancel) {
        assert.equal(saved.length, 11); assert.equal(finished, 0); assert.match(status().textContent, /已取消导出/);
      } else {
        assert.equal(saved.length, 13); assert.equal(saved.at(-1).manifest, true);
        assert.match(saved.at(-1).filename, /\.index\.json$/); assert.equal(finished, 1);
        assert.match(status().textContent, /已提交全部下载/);
      }
    } finally { releaseTail(); releaseSettled(); view.dispose(); }
  });
});

test('自动单包导出先选择一次目标，再逐卷写入，最后只保存一次并释放迭代器', async () => {
  const files = await exportFiles(), writes = []; let produced = 0, returned = 0, prepared = 0, closed = 0, finished = 0, metadata;
  let releaseFinish;
  const saved = new Promise(resolve => { releaseFinish = resolve; });
  const view = createMemoryTransferView({ runtime: { async *exportVolumes() {
    try { for (const file of files) { produced++; yield file; } } finally { returned++; }
  } }, documentRef: { createElement: tag => new Node(tag) }, prepareBundleDownload: async () => {
    prepared++; assert.equal(produced, 0, '先取得保存位置，不预先生成记忆卷');
    return { mode: 'bundle', writable: { async write(chunk) { writes.push(chunk); }, async close() { closed++; }, async abort() {} },
      async finish(value) { metadata = value; finished++; await saved; return { delivered: true, message: '大记忆包已保存。' }; }, async abort() {} };
  } });
  const nodes = () => flatten(view.node), button = text => nodes().find(node => node.tag === 'button' && node.textContent === text);
  button('自动导出大记忆包').fire('click');
  await waitFor(() => finished === 1);
  assert.equal(prepared, 1); assert.equal(produced, files.length); assert.equal(returned, 1); assert.equal(closed, 1);
  assert.ok(writes.length > files.length); assert.equal(metadata.parts, files.length - 1); assert.match(metadata.filename, /\.qqj-memory$/);
  assert.equal(button('导出当前聊天记忆').disabled, true, '最终保存完成前保持独占');
  assert.equal(button('下载下一卷'), undefined); assert.equal(button('结束导出'), undefined);
  releaseFinish(); await waitFor(() => button('导出当前聊天记忆').disabled === false);
  assert.match(nodes().find(node => node.className === 'settings-result').textContent, /已保存/);
  assert.match(nodes().find(node => node.className === 'settings-result').textContent, /JSONL/);
  view.dispose(); assert.equal(finished, 1);
});

test('兼容下载模式同样一键顺序保存全部卷和末尾清单，等待当前卷交接才生成下一卷', async () => {
  const files = await exportFiles(), downloaded = []; let produced = 0, saves = 0, active = 0, maximum = 0, finished = 0;
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const view = createMemoryTransferView({ runtime: { async *exportVolumes() { for (const file of files) { produced++; yield file; } } },
    documentRef: { createElement: tag => new Node(tag) }, prepareBundleDownload: async () => ({ mode: 'volumes',
      async saveVolume(file) { active++; maximum = Math.max(maximum, active); saves++; if (saves === 1) await gate; downloaded.push(file.filename); active--; },
      async finish() { finished++; return { delivered: false, message: '已提交全部下载，请允许连续下载。' }; }, async abort() {} }) });
  const nodes = () => flatten(view.node), button = text => nodes().find(node => node.tag === 'button' && node.textContent === text);
  button('自动导出大记忆包').fire('click'); await waitFor(() => saves === 1);
  assert.equal(produced, 1); assert.equal(active, 1);
  await tick(); assert.equal(produced, 1, '不能把所有卷生成后排队保留');
  releaseFirst(); await waitFor(() => finished === 1 && !button('导出当前聊天记忆').disabled);
  assert.deepEqual(downloaded, files.map(file => file.filename)); assert.match(downloaded.at(-1), /\.index\.json$/);
  assert.equal(maximum, 1); assert.match(nodes().find(node => node.className === 'settings-result').textContent, /已提交全部下载/);
  view.dispose();
});

test('目标选择中取消会清理迟到的目标，绝不启动记忆读取', async () => {
  let ready, exported = 0, aborted = 0;
  const target = new Promise(resolve => { ready = resolve; });
  const view = createMemoryTransferView({ runtime: { exportVolumes() { exported++; assert.fail('取消后不得读取记忆'); } },
    documentRef: { createElement: tag => new Node(tag) }, prepareBundleDownload: () => target });
  const nodes = () => flatten(view.node), button = text => nodes().find(node => node.tag === 'button' && node.textContent === text);
  button('自动导出大记忆包').fire('click'); await tick();
  assert.equal(button('取消导出').disabled, false);
  button('取消导出').fire('click'); await tick();
  ready({ mode: 'volumes', async abort() { aborted++; } });
  await waitFor(() => aborted === 1);
  assert.equal(exported, 0); assert.equal(button('导出当前聊天记忆').disabled, false);
  assert.match(nodes().find(node => node.className === 'settings-result').textContent, /取消/);
  view.dispose();
});

test('取消或离开自动导出会关闭两种模式的迭代器，忽略迟到卷且不触发保存', async t => {
  for (const mode of ['bundle', 'volumes']) for (const leave of ['cancel', 'dispose']) await t.test(mode + ' ' + leave, async () => {
    let resolveRead, produced = 0, returned = 0, finished = 0, aborted = 0, volumeSaves = 0;
    const waiting = new Promise(resolve => { resolveRead = resolve; });
    const view = createMemoryTransferView({ runtime: { async *exportVolumes() {
      try { produced++; await waiting; yield { filename: 'late.bin', blob: new Blob(['late']), part: 1 }; } finally { returned++; }
    } }, documentRef: { createElement: tag => new Node(tag) }, prepareBundleDownload: async () => ({ mode,
      writable: { async write() {}, async close() {}, async abort() {} }, async saveVolume() { volumeSaves++; },
      async finish() { finished++; }, async abort() { aborted++; } }) });
    const nodes = () => flatten(view.node), button = text => nodes().find(node => node.tag === 'button' && node.textContent === text);
    button('自动导出大记忆包').fire('click'); await waitFor(() => produced === 1);
    if (leave === 'cancel') button('取消导出').fire('click'); else view.dispose();
    resolveRead(); await waitFor(() => returned === 1 && aborted === 1);
    assert.equal(finished, 0); assert.equal(volumeSaves, 0);
    if (leave === 'cancel') { await waitFor(() => !button('导出当前聊天记忆').disabled); view.dispose(); }
  });
});

test('自动保存失败停止后续卷并恢复普通控件，不重试或写末尾清单', async () => {
  const files = await exportFiles(); let produced = 0, returned = 0, saves = 0, finished = 0, aborted = 0;
  const view = createMemoryTransferView({ runtime: { async *exportVolumes() {
    try { for (const file of files) { produced++; yield file; } } finally { returned++; }
  } }, documentRef: { createElement: tag => new Node(tag) }, prepareBundleDownload: async () => ({ mode: 'volumes',
    async saveVolume() { saves++; throw new Error('本卷保存失败'); }, async finish() { finished++; }, async abort() { aborted++; } }) });
  const nodes = () => flatten(view.node), button = text => nodes().find(node => node.tag === 'button' && node.textContent === text);
  button('自动导出大记忆包').fire('click'); await waitFor(() => aborted === 1 && !button('导出当前聊天记忆').disabled);
  assert.equal(produced, 1); assert.equal(returned, 1); assert.equal(saves, 1); assert.equal(finished, 0);
  assert.match(nodes().find(node => node.className === 'settings-result').textContent, /本卷保存失败/);
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
    assert.match(nodes.find(node => node.className === 'settings-result' && node['aria-label'] === '导入与撤销结果').textContent, /清单.*全部卷/);
    view.dispose();
  });
});

test('单个大记忆包直接传文件给流式预览，超过1GB也不由UI整文件读取', async () => {
  const file = { name: 'memory.qqj-memory', size: 1024 ** 3 + 1, text() { assert.fail('UI不得整包读取'); } };
  let previewed = 0;
  const view = createMemoryTransferView({ runtime: { async previewVolumes(files) { assert.deepEqual(files, [file]); previewed++; return { messages: 3, summaries: 1, states: 1 }; } },
    documentRef: { createElement: tag => new Node(tag) } });
  const input = flatten(view.node).find(node => node.type === 'file');
  assert.match(input.accept, /\.qqj-memory/);
  input.files = [file]; input.fire('change'); await waitFor(() => previewed === 1);
  view.dispose();
});

test('系统保存过程中离开页面，迟到成功不会改写状态或再次保存', async () => {
  const files = await exportFiles(); let resolveFinish, finishCalls = 0, abortCalls = 0;
  const waiting = new Promise(resolve => { resolveFinish = resolve; });
  const view = createMemoryTransferView({ runtime: { async *exportVolumes() { yield* files; } },
    documentRef: { createElement: tag => new Node(tag) }, prepareBundleDownload: async () => ({ mode: 'bundle',
      writable: { async write() {}, async close() {}, async abort() {} }, async finish() { finishCalls++; await waiting; return { message: '迟到保存成功' }; },
      async abort() { abortCalls++; } }) });
  const nodes = flatten(view.node), status = nodes.find(node => node.className === 'settings-result');
  nodes.find(node => node.textContent === '自动导出大记忆包').fire('click'); await waitFor(() => finishCalls === 1);
  view.dispose(); await waitFor(() => abortCalls === 1);
  resolveFinish(); await tick(); await tick();
  assert.equal(finishCalls, 1); assert.doesNotMatch(status.textContent, /迟到保存成功/);
});

test('保存目标不支持时不生成任何卷，保留明确提示并恢复控件', async () => {
  let produced = 0;
  const view = createMemoryTransferView({ runtime: { exportVolumes() { produced++; } },
    documentRef: { createElement: tag => new Node(tag) }, prepareBundleDownload: async () => { throw new Error('当前环境无法保存大记忆包'); } });
  const nodes = flatten(view.node), button = nodes.find(node => node.textContent === '自动导出大记忆包');
  button.fire('click'); await waitFor(() => !button.disabled);
  assert.equal(produced, 0); assert.match(nodes.find(node => node.className === 'settings-result').textContent, /当前环境无法保存/);
  view.dispose();
});
