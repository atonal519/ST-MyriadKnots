import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryVolumes, MEMORY_VOLUME_BYTES } from '../src/memory-transfer-volumes.js';
import { writeMemoryBundle, openMemoryBundle } from '../src/memory-transfer-bundle.js';
import { sha256 } from '../src/identity.js';
import { stableJson } from '../src/memory-transfer-json.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ARCHIVE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const options = { archiveId: ARCHIVE, source: { chatId: CHAT }, exportedAt: '2026-10-28T00:00:00Z' };
const entries = text => [{ kind: 'header', value: { source: options.source, prequel: '手动前情🙂' } },
  { kind: 'record', id: 'first', data: { text } }, { kind: 'record', id: 'second', data: { text: '人工摘要' } }];
function sink() {
  const chunks = [];
  return { chunks, closed: false, aborted: null,
    async write(chunk) { chunks.push(chunk); }, async close() { this.closed = true; },
    async abort(reason) { this.aborted = reason; }, blob() { return new Blob(chunks); } };
}
async function bundle(text = '跨卷中文🙂𠮷'.repeat(60), extra = {}) {
  const writer = sink();
  const metadata = await writeMemoryBundle(createMemoryVolumes(entries(text), { ...options, partBytes: 113, ...extra }), writer);
  return { writer, metadata, blob: writer.blob() };
}
function diskFile(blob) {
  const slices = [];
  return { name: 'memory.qqj-memory', size: blob.size, slices,
    arrayBuffer() { assert.fail('不能读取整份记忆包'); }, text() { assert.fail('不能将整包转为字符串'); },
    slice(start = 0, end = blob.size) { slices.push([start, end]); return blob.slice(start, end); } };
}
const footer = size => new Blob([`QQJ-MEMORY-BNDL1${size.toString(16).padStart(16, '0')}`]);

test('单文件跨卷UTF8往返，仅读取footer、清单和当前卷，保留来源回调及随机读取', async () => {
  const text = '中文🙂𠮷\n"\\'.repeat(137), progress = [], writer = sink();
  const metadata = await writeMemoryBundle(createMemoryVolumes(entries(text), { ...options, partBytes: 113 }), writer, { onProgress: value => progress.push(value) });
  assert.equal(writer.closed, true); assert.equal(writer.aborted, null);
  assert.match(metadata.filename, /\.qqj-memory$/); assert.equal(metadata.bytes, writer.blob().size);
  assert.ok(metadata.parts > 10); assert.equal(progress.at(-1).manifest, true);
  const file = diskFile(writer.blob()), seen = [];
  const opened = await openMemoryBundle(file, { onRecord: (entry, chatId) => seen.push([entry.id, chatId]) });
  assert.deepEqual(seen, [['first', CHAT], ['second', CHAT]]);
  assert.deepEqual(await opened.readRecord('first'), { text });
  assert.deepEqual(await opened.readRecord('second'), { text: '人工摘要' });
  assert.equal(opened.header.prequel, '手动前情🙂');
  assert.ok(file.slices.every(([start, end]) => end - start <= MEMORY_VOLUME_BYTES));
  await opened.verify();
});

test('损坏、缺失和超界footer不能导入，也不扫描正文', async t => {
  const { blob } = await bundle();
  for (const [name, changed] of [
    ['magic', new Blob([blob.slice(0, -32), 'X'.repeat(32)])],
    ['truncated', blob.slice(0, -9)],
    ['length overflow', new Blob([blob.slice(0, -32), footer(Number.MAX_SAFE_INTEGER)])],
    ['too large manifest', new Blob([blob.slice(0, -32), footer(MEMORY_VOLUME_BYTES + 1)])],
  ]) await t.test(name, async () => {
    const file = diskFile(changed); await assert.rejects(openMemoryBundle(file), /记忆包|清单/);
    assert.equal(file.slices.length, 1);
  });
});

test('单文件缺少正文卷或正文被修改时复用分卷完整性检查', async () => {
  const { blob } = await bundle();
  await assert.rejects(openMemoryBundle(diskFile(new Blob([blob.slice(113)]))), /记忆包|大小|缺失/);
  await assert.rejects(openMemoryBundle(diskFile(new Blob(['X', blob.slice(1)]))), /记忆卷校验失败/);
});

test('单文件预览后正文变化仍由verify检测，不能沿用旧校验结果', async () => {
  const { blob } = await bundle(); let current = blob;
  const file = { name: 'changed.qqj-memory', size: blob.size, slice: (start, end) => current.slice(start, end) };
  const opened = await openMemoryBundle(file);
  current = new Blob(['X', blob.slice(1)]);
  await assert.rejects(opened.verify(), /记忆卷已变化/);
});

test('单卷保存未完成时不生成下一卷，写完清单及footer后仅关闭一次', async () => {
  let produced = 0, closedSource = false, announce, release;
  const entered = new Promise(resolve => { announce = resolve; }), gate = new Promise(resolve => { release = resolve; });
  async function* source() {
    try { for await (const part of createMemoryVolumes(entries('内容'.repeat(200)), { ...options, partBytes: 113 })) { produced++; yield part; } }
    finally { closedSource = true; }
  }
  const writer = sink(), write = writer.write.bind(writer); let writes = 0, closes = 0;
  writer.write = async value => { writes++; if (writes === 1) { announce(); await gate; } await write(value); };
  writer.close = async () => { closes++; };
  const writing = writeMemoryBundle(source(), writer);
  try {
    await entered; await new Promise(resolve => setImmediate(resolve));
    assert.equal(produced, 1); release(); const metadata = await writing;
    assert.equal(produced, metadata.parts + 1); assert.equal(closes, 1); assert.equal(closedSource, true);
    assert.equal(writes, metadata.parts + 2, '正文卷、清单、固定footer各按顺序写入');
  } finally { release(); await Promise.allSettled([writing]); }
});

test('保存失败停止来源并abort，未追加清单footer且不能导入', async () => {
  let produced = 0, returned = false;
  async function* source() {
    try { for await (const part of createMemoryVolumes(entries('材料'.repeat(200)), { ...options, partBytes: 113 })) { produced++; yield part; } }
    finally { returned = true; }
  }
  const writer = sink(), write = writer.write.bind(writer), failure = new Error('disk full');
  writer.write = async value => { if (produced === 2) throw failure; await write(value); };
  await assert.rejects(writeMemoryBundle(source(), writer), error => error === failure);
  assert.equal(produced, 2); assert.equal(returned, true); assert.equal(writer.aborted, failure); assert.equal(writer.closed, false);
  await assert.rejects(openMemoryBundle(diskFile(writer.blob())), /记忆包/);
});

test('取消时关闭来源，当前写入结束后不再取下一卷且不发布尾部', async () => {
  let produced = 0, returned = false, announce, release;
  const entered = new Promise(resolve => { announce = resolve; }), gate = new Promise(resolve => { release = resolve; });
  async function* source() {
    try { for await (const part of createMemoryVolumes(entries('材料'.repeat(200)), { ...options, partBytes: 113 })) { produced++; yield part; } }
    finally { returned = true; }
  }
  const writer = sink(), write = writer.write.bind(writer), controller = new AbortController(), reason = new DOMException('cancelled', 'AbortError');
  writer.write = async value => { announce(); await gate; await write(value); };
  const writing = writeMemoryBundle(source(), writer, { signal: controller.signal }), outcome = writing.then(value => ({ value }), error => ({ error }));
  try {
    await entered; controller.abort(reason); await new Promise(resolve => setImmediate(resolve));
    assert.equal(returned, true, '取消立即通知来源关闭');
    release(); assert.equal((await outcome).error, reason);
    assert.equal(produced, 1); assert.equal(writer.chunks.length, 1); assert.equal(writer.aborted, reason); assert.equal(writer.closed, false);
  } finally { release(); await Promise.allSettled([writing]); }
});

test('清单之后来源仍失败时不发布清单和footer', async () => {
  const writer = sink(), failure = new Error('late source failure');
  async function* source() {
    yield { filename: 'p.bin', manifest: false, part: 1, blob: new Blob(['payload']) };
    yield { filename: 'm.qqj-memory.index.json', manifest: true, part: 1, blob: new Blob(['{}']) };
    throw failure;
  }
  await assert.rejects(writeMemoryBundle(source(), writer), error => error === failure);
  assert.equal(writer.chunks.length, 1); assert.equal(writer.aborted, failure); assert.equal(writer.closed, false);
});

test('1GiB虚拟来源只逐卷传递同一8MiB Blob，不读取或收集全部正文', async () => {
  const part = new Blob([new Uint8Array(MEMORY_VOLUME_BYTES)]); let produced = 0, written = 0, largest = 0, closed = 0;
  part.arrayBuffer = part.text = () => assert.fail('写入不应把Blob转为整份内存');
  async function* source() {
    for (let index = 0; index < 128; index++) { produced++; yield { filename: `p-${index}.bin`, part: index + 1, manifest: false, blob: part }; }
    yield { filename: 'large.qqj-memory.index.json', manifest: true, part: 128, blob: new Blob(['{}']) };
  }
  const writer = { async write(blob) {
    largest = Math.max(largest, blob.size);
    if (written < 128) { assert.equal(blob, part); assert.equal(produced, written + 1, '严格背压，不预收下一卷'); }
    written++;
  }, async close() { closed++; } };
  const result = await writeMemoryBundle(source(), writer);
  assert.equal(result.bytes, 1024 ** 3 + 2 + 32); assert.equal(result.parts, 128);
  assert.equal(written, 130); assert.equal(largest, MEMORY_VOLUME_BYTES); assert.equal(closed, 1);
});

test('1GiB虚拟文件打开只切目录和首个8MiB卷，不调用整包读取', async () => {
  const payloadBytes = 1024 ** 3, parts = Array.from({ length: 128 }, (_, index) => ({ filename: `p-${index}.bin`, bytes: MEMORY_VOLUME_BYTES, checksum: '0'.repeat(64) }));
  const payload = { format: 'qqj-core-chat-memory-volumes', formatVersion: 3, ...options, partBytes: MEMORY_VOLUME_BYTES, totalBytes: payloadBytes, parts };
  const manifest = new Blob([JSON.stringify({ ...payload, checksum: await sha256(stableJson(payload)) })]);
  const tail = footer(manifest.size), slices = [], stop = new Error('virtual payload read');
  const file = { name: 'large.qqj-memory', size: payloadBytes + manifest.size + tail.size,
    arrayBuffer() { assert.fail('不能分配1GiB整包'); }, text() { assert.fail('不能将1GiB包转为字符串'); },
    slice(start, end) {
      slices.push([start, end]);
      if (start === payloadBytes) return manifest;
      if (start === payloadBytes + manifest.size) return tail;
      assert.equal(start, 0); assert.equal(end, MEMORY_VOLUME_BYTES);
      return { async arrayBuffer() { throw stop; } };
    } };
  await assert.rejects(openMemoryBundle(file), error => error === stop);
  assert.deepEqual(slices.map(([start, end]) => end - start), [32, manifest.size, MEMORY_VOLUME_BYTES]);
});
