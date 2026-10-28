import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMemoryVolumes, openMemoryVolumes } from '../src/memory-transfer-volumes.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ARCHIVE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const header = { kind: 'header', value: { source: { chatId: CHAT }, messages: ['message-witness'], prequel: '保留的前情' } };
const record = (id, text) => ({ kind: 'record', id, data: { chatId: CHAT, text } });
const options = { archiveId: ARCHIVE, source: { chatId: CHAT }, exportedAt: '2026-10-28T00:00:00Z' };
async function volumes(entries, extra = {}) {
  const result = [];
  for await (const item of createMemoryVolumes(entries, { ...options, ...extra })) result.push(item);
  return result;
}
function selected(volumes, stats = { manifestTexts: 0, partReads: 0, sliceReads: 0, maxSlice: 0 }) {
  const files = volumes.map(item => ({
    name: item.filename, size: item.blob.size,
    text() {
      assert.equal(item.manifest, true, '正文卷不得调用File.text整卷转字符串');
      stats.manifestTexts++;
      return item.blob.text();
    },
    arrayBuffer() { stats.partReads++; return item.blob.arrayBuffer(); },
    slice(start, end) {
      stats.sliceReads++; stats.maxSlice = Math.max(stats.maxSlice, end - start);
      return item.blob.slice(start, end);
    },
  }));
  return { files, stats };
}

test('分卷跨任意UTF8字节与大于单卷的记录仍完整读取，随机读取只取记录切片', async () => {
  const text = '千千结🙂𠮷\n引号"和\\反斜线'.repeat(37);
  const entries = [header, record('first', text), record('second', '手工修改后的摘要')];
  const encoded = await volumes(entries, { partBytes: 113 });
  assert.ok(encoded.length > 10);
  assert.equal(encoded.at(-1).manifest, true);
  assert.ok(encoded.slice(0, -1).every(item => !item.manifest && item.blob.size <= 113));
  const decodedTexts = [];
  const source = selected(encoded);
  const opened = await openMemoryVolumes(source.files.reverse(), { onRecord: entry => decodedTexts.push(entry.data.text) });
  assert.deepEqual(decodedTexts, [text, '手工修改后的摘要']);
  assert.deepEqual(opened.header, header.value);
  assert.deepEqual(opened.recordIds, ['first', 'second']);
  assert.equal(source.stats.manifestTexts, 1);
  const readsBefore = source.stats.partReads;
  assert.deepEqual(await opened.readRecord('second'), entries[2].data);
  assert.deepEqual(await opened.readRecord('first'), entries[1].data);
  assert.equal(source.stats.partReads, readsBefore, '随机读取不重新载入完整正文卷');
  assert.ok(source.stats.sliceReads > 1);
  assert.ok(source.stats.maxSlice <= 113);
  await opened.verify();
});

test('分卷头像原图跨卷读取，正文与路径按原样保留', async () => {
  const avatar = { kind: 'avatar', path: '/user/images/manual.png', mimeType: 'image/png', data: 'YWJj'.repeat(200) };
  const encoded = await volumes([header, record('r', '保存的内容'), avatar], { partBytes: 89 });
  const opened = await openMemoryVolumes(selected(encoded).files);
  assert.deepEqual(opened.avatarPaths, [avatar.path]);
  assert.deepEqual(await opened.readAvatar(avatar.path), avatar);
  await assert.rejects(opened.readRecord('missing'), /缺少关联记录/);
  await assert.rejects(opened.readAvatar('/missing.png'), /缺少头像原图/);
});

test('逐条校验回调收到清单中的来源聊天编号', async () => {
  const encoded = await volumes([header, record('r', '内容')], { partBytes: 97 });
  const seen = [];
  await openMemoryVolumes(selected(encoded).files, { onRecord: (entry, chatId) => seen.push([entry.id, chatId]) });
  assert.deepEqual(seen, [['r', CHAT]]);
});

test('缺卷、混卷、重复文件与篡改的分卷都在完整打开前被拒绝', async t => {
  const encoded = await volumes([header, record('r', '足够跨卷的材料'.repeat(50))], { partBytes: 127 });
  const other = await volumes([header, record('r', '足够跨卷的材料'.repeat(50))], { partBytes: 127, archiveId: OTHER });
  await t.test('missing volume', async () => {
    const files = selected(encoded).files; files.splice(1, 1);
    await assert.rejects(openMemoryVolumes(files), /分卷缺失|全部记忆卷/);
  });
  await t.test('mixed archive', async () => {
    const files = selected(encoded).files; files[0] = selected(other).files[0];
    await assert.rejects(openMemoryVolumes(files), /记忆卷缺失/);
  });
  await t.test('duplicate file', async () => {
    const files = selected(encoded).files; files[1] = files[0];
    await assert.rejects(openMemoryVolumes(files), /分卷缺失、重复/);
  });
  await t.test('changed bytes', async () => {
    const changed = [...encoded], original = changed[0];
    const bytes = new Uint8Array(await original.blob.arrayBuffer()); bytes[0] ^= 1;
    changed[0] = { ...original, blob: new Blob([bytes]) };
    await assert.rejects(openMemoryVolumes(selected(changed).files), /记忆卷校验失败/);
  });
  await t.test('changed manifest', async () => {
    const changed = [...encoded], original = changed.at(-1);
    const value = JSON.parse(await original.blob.text()); value.totalBytes++;
    changed[changed.length - 1] = { ...original, blob: new Blob([JSON.stringify(value)]) };
    await assert.rejects(openMemoryVolumes(selected(changed).files), /分卷清单完整性校验失败/);
  });
});

test('完整且校验正确的分卷仍拒绝重复记录编号与重复头像路径', async () => {
  const duplicateRecord = await volumes([header, record('same', '第一条'), record('same', '第二条')], { partBytes: 73 });
  await assert.rejects(openMemoryVolumes(selected(duplicateRecord).files), /重复或无效的记忆记录/);
  const image = { kind: 'avatar', path: '/image.png', data: 'YWJj', mimeType: 'image/png' };
  const duplicateAvatar = await volumes([header, record('r', '内容'), image, image], { partBytes: 73 });
  await assert.rejects(openMemoryVolumes(selected(duplicateAvatar).files), /重复或无效的头像原图/);
});

test('下载方未请求下一卷时不预读全部来源，提前结束关闭来源迭代', async () => {
  let produced = 0, closed = false;
  async function* source() {
    try {
      produced++; yield header;
      for (let index = 0; index < 1000; index++) { produced++; yield record(`r-${index}`, '材料'.repeat(32)); }
    } finally { closed = true; }
  }
  const stream = createMemoryVolumes(source(), { ...options, partBytes: 64 });
  const first = await stream.next();
  assert.equal(first.done, false);
  assert.equal(first.value.manifest, false);
  assert.equal(first.value.blob.size, 64);
  assert.equal(produced, 1, '首卷位于header中，不预取下一条正文记录');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(produced, 1, '暂停下载期间没有后台收集后续卷或来源');
  await stream.return();
  assert.equal(closed, true);
});

test('打开后的verify发现卷已变化，不重新读取清单文本', async () => {
  const encoded = await volumes([header, record('r', '内容')], { partBytes: 97 });
  const source = selected(encoded), original = source.files[0];
  let changed = false;
  source.files[0] = { ...original, arrayBuffer: async () => {
    const bytes = new Uint8Array(await original.arrayBuffer()); if (changed) bytes[0] ^= 1; return bytes.buffer;
  } };
  const opened = await openMemoryVolumes(source.files);
  changed = true;
  await assert.rejects(opened.verify(), /记忆卷已变化/);
  assert.equal(source.stats.manifestTexts, 1);
});

test('HTTP手机缺少subtle时沿用宿主SHA，跨卷中文原字节校验与WebCrypto一致且仍拒绝篡改', async () => {
  const entries = [header, record('中文记录', '千千结🙂𠮷与人工摘要\n'.repeat(11))];
  const standard = await volumes(entries, { partBytes: 17 });
  const previousCrypto = globalThis.crypto, previousHost = globalThis.SillyTavern;
  let hashCalls = 0;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
  globalThis.SillyTavern = { libs: { sha256(bytes) {
    assert.ok(bytes instanceof Uint8Array); hashCalls++;
    return createHash('sha256').update(bytes).digest('hex');
  } } };
  try {
    const fallback = await volumes(entries, { partBytes: 17 });
    assert.ok(fallback.length > 10);
    for (let index = 0; index < standard.length; index++) {
      assert.deepEqual(new Uint8Array(await fallback[index].blob.arrayBuffer()), new Uint8Array(await standard[index].blob.arrayBuffer()));
    }
    const source = selected(fallback), first = source.files[0]; let changed = false;
    source.files[0] = { ...first, arrayBuffer: async () => {
      const bytes = new Uint8Array(await first.arrayBuffer()); if (changed) bytes[0] ^= 1; return bytes.buffer;
    } };
    const opened = await openMemoryVolumes(source.files);
    assert.deepEqual(await opened.readRecord('中文记录'), entries[1].data);
    await opened.verify();
    changed = true;
    await assert.rejects(opened.verify(), /记忆卷已变化/);
    await assert.rejects(openMemoryVolumes(source.files), /记忆卷校验失败/);
    assert.ok(hashCalls > fallback.length, '导出、预览与最终核对均保留字节摘要校验');
  } finally {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: previousCrypto });
    if (previousHost === undefined) delete globalThis.SillyTavern; else globalThis.SillyTavern = previousHost;
  }
});
