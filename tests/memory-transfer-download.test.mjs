import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMemoryBundleDownload } from '../src/ui/memory-transfer-download.js';

const metadata = { filename: '千千结记忆-test.qqj-memory', parts: 128, bytes: 1024 ** 3 };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('保存选择器在点击调用时立即打开，逐块写入并close后确认保存，不调用宿主下载', async () => {
  const picker = deferred(), calls = [];
  const stream = { async write(value) { calls.push(['write', value]); }, async close() { calls.push(['close']); }, async abort() { calls.push(['abort']); } };
  const window = { showSaveFilePicker(options) { calls.push(['picker', options]); return picker.promise; },
    Blob() { assert.fail('保存器不得拼接整包Blob'); } };
  const preparing = prepareMemoryBundleDownload(window, () => assert.fail('FSA不应调用宿主download'));
  assert.equal(calls[0][0], 'picker', '不能先等待导出工作，以免丢失用户激活');
  picker.resolve({ async createWritable() { return stream; } });
  const target = await preparing;
  assert.equal(target.mode, 'bundle');
  const part = new Blob(['当前卷']); await target.writable.write(part); await target.writable.close();
  const result = await target.finish(metadata);
  assert.equal(result.delivered, true); assert.match(result.message, /已保存/);
  await target.abort(); await target.abort();
  assert.deepEqual(calls.slice(1), [['write', part], ['close']], '已关闭的文件不再abort');
});

test('用户取消文件选择时保留取消结果，不转成其他下载', async () => {
  const cancelled = new DOMException('已取消', 'AbortError');
  await assert.rejects(prepareMemoryBundleDownload({ showSaveFilePicker: () => Promise.reject(cancelled) },
    () => assert.fail('取消后不得下载')), error => error === cancelled);
});

function opfsFixture({ streaming = true } = {}) {
  const calls = [];
  const file = { name: 'temporary-file', size: 1024 ** 3, type: 'application/octet-stream',
    arrayBuffer() { assert.fail('不得读取整个1GB临时文件'); }, text() { assert.fail('不得将整个包转成文本'); } };
  const stream = { async write(part) { calls.push(['write', part]); }, async close() { calls.push(['close']); }, async abort() { calls.push(['abort']); } };
  const handle = { async createWritable() { calls.push(['createWritable']); return stream; }, async getFile() { calls.push(['getFile']); return file; } };
  const directory = { async getFileHandle(name, options) { calls.push(['getFileHandle', name, options]); return handle; },
    async removeEntry(name) { calls.push(['removeEntry', name]); } };
  const window = { __TAURITAVERN__: { api: { extension: { store: streaming ? { getBlobStream() {} } : {} } } },
    navigator: { storage: { async getDirectory() { calls.push(['getDirectory']); return directory; } } },
    Blob() { assert.fail('不得拼接整个包Blob'); } };
  return { window, calls, file, handle };
}

test('TT流式下载用磁盘File交付一次，未整包读入内存，完成后删除临时文件', async () => {
  const f = opfsFixture(), downloads = [];
  const target = await prepareMemoryBundleDownload(f.window, async (...args) => { downloads.push(args); return { delivered: true }; });
  assert.equal(target.mode, 'bundle');
  await target.writable.write(new Blob(['一卷'])); await target.writable.close();
  assert.equal((await target.finish(metadata)).delivered, true);
  assert.equal((await target.finish(metadata)).delivered, true);
  assert.deepEqual(downloads, [[f.file, metadata.filename, f.file.type, { throwOnFailure: true }]]);
  assert.equal(f.calls.filter(call => call[0] === 'getFile').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'removeEntry').length, 1);
  await target.abort(); await target.abort();
  assert.equal(f.calls.filter(call => call[0] === 'removeEntry').length, 1);
});

test('TT有OPFS目录但缺少createWritable时清临时文件并逐卷交付', async () => {
  const f = opfsFixture(), downloads = [];
  delete f.handle.createWritable;
  const target = await prepareMemoryBundleDownload(f.window, async (...args) => { downloads.push(args); return { delivered: true }; });
  assert.equal(target.mode, 'volumes');
  const removed = f.calls.filter(call => call[0] === 'removeEntry');
  assert.equal(removed.length, 1);
  assert.equal(removed[0][1], f.calls.find(call => call[0] === 'getFileHandle')[1]);
  for (const filename of ['memory.part-0001.bin', 'memory.index.json']) {
    const blob = new Blob([filename]);
    await target.saveVolume({ filename, blob });
    assert.deepEqual(downloads.at(-1), [blob, filename, blob.type, { throwOnFailure: true }]);
  }
  assert.equal(downloads.length, 2);
  assert.equal((await target.finish(metadata)).delivered, true);
  await target.abort();
  await assert.rejects(target.saveVolume({ filename: 'late.bin', blob: new Blob(['late']) }), error => error.name === 'AbortError');
  assert.equal(downloads.length, 2);
});

test('OPFS有createWritable但真实创建失败时清临时文件并保留原错误', async () => {
  const f = opfsFixture(), failure = new Error('quota exceeded'); let downloads = 0;
  f.handle.createWritable = async () => { throw failure; };
  await assert.rejects(prepareMemoryBundleDownload(f.window, async () => { downloads++; }), error => error === failure);
  assert.equal(f.calls.filter(call => call[0] === 'removeEntry').length, 1);
  assert.equal(downloads, 0, '真实I/O错误不能变成另一轮下载');
});

test('OPFS向原生交付期间取消必须等读取结束才清临时文件', async () => {
  const f = opfsFixture(), delivery = deferred(), started = deferred();
  const target = await prepareMemoryBundleDownload(f.window, async () => { started.resolve(); return delivery.promise; });
  await target.writable.close();
  const finish = target.finish(metadata); await started.promise;
  const stop = target.abort(); await tick();
  assert.equal(f.calls.filter(call => call[0] === 'removeEntry').length, 0, 'native仍在读，不能先删除');
  delivery.resolve({ delivered: true });
  assert.equal((await finish).delivered, false);
  await stop;
  assert.equal(f.calls.filter(call => call[0] === 'removeEntry').length, 1);
});

test('普通ST、旧TT和无OPFS的TT均逐卷等待宿主下载，最后清单也提交', async t => {
  for (const name of ['ST', 'TT2.2', 'TT without OPFS']) await t.test(name, async () => {
    const f = opfsFixture({ streaming: name !== 'TT2.2' });
    const window = name === 'ST' ? { navigator: f.window.navigator } : f.window;
    if (name === 'TT without OPFS') delete window.navigator;
    const firstDownload = deferred(), calls = [];
    const target = await prepareMemoryBundleDownload(window, (...args) => { calls.push(args); return calls.length === 1 ? firstDownload.promise : Promise.resolve(); });
    assert.equal(target.mode, 'volumes');
    const part = { filename: 'memory.part-0001.bin', blob: new Blob(['part']) };
    const index = { filename: 'memory.index.json', blob: new Blob(['index'], { type: 'application/json' }), manifest: true };
    let settled = false;
    const saving = target.saveVolume(part).then(() => { settled = true; }); await tick();
    assert.equal(settled, false, 'TT异步宿主尚未交付当前卷时，不应提前resolve');
    firstDownload.resolve({ delivered: true }); await saving;
    await target.saveVolume(index);
    assert.deepEqual(calls, [[part.blob, part.filename, part.blob.type, { throwOnFailure: true }],
      [index.blob, index.filename, index.blob.type, { throwOnFailure: true }]]);
    const result = await target.finish(metadata);
    assert.equal(result.delivered, true); assert.match(result.message, /已提交全部下载/); assert.match(result.message, /清单/); assert.match(result.message, /允许连续下载/);
    assert.doesNotMatch(result.message, /已保存/);
    assert.equal(f.calls.length, 0, '不支持整包交付时不得先写OPFS');
  });
});

test('宿主取消单卷下载会停止导出，缺失下载接口清晰报错', async () => {
  const target = await prepareMemoryBundleDownload({}, async () => ({ delivered: false }));
  await assert.rejects(target.saveVolume({ filename: 'part.bin', blob: new Blob(['part']) }), error => error.name === 'AbortError');
  assert.equal((await target.finish(metadata)).delivered, false);
  await assert.rejects(prepareMemoryBundleDownload({}), /下载接口/);
});

test('OPFS下载失败或原生取消仍清理临时文件，提前abort幂等且不开始交付', async t => {
  for (const mode of ['failure', 'cancelled', 'abort']) await t.test(mode, async () => {
    const f = opfsFixture(); let calls = 0;
    const failure = new Error('native download failed');
    const target = await prepareMemoryBundleDownload(f.window, async () => { calls++; if (mode === 'failure') throw failure; return { delivered: false }; });
    if (mode === 'abort') {
      await target.abort(); await target.abort();
      assert.equal((await target.finish(metadata)).delivered, false);
      assert.equal(calls, 0); assert.equal(f.calls.filter(call => call[0] === 'abort').length, 1);
    } else {
      await target.writable.close();
      if (mode === 'failure') await assert.rejects(target.finish(metadata), error => error === failure);
      else assert.equal((await target.finish(metadata)).delivered, false);
    }
    assert.equal(f.calls.filter(call => call[0] === 'removeEntry').length, 1);
  });
});

test('TT iOS真实分享结果completed=false取消，completed=true正常完成，两种保存模式均识别', async t => {
  for (const mode of ['volumes', 'bundle']) for (const completed of [false, true]) await t.test(`${mode} completed=${completed}`, async () => {
    const f = opfsFixture({ streaming: mode === 'bundle' }); let calls = 0;
    const target = await prepareMemoryBundleDownload(f.window, async () => {
      calls++; return { mode: 'ios-native-share', completed, savedPath: '', activity: null, cleanupError: null };
    });
    if (mode === 'bundle') {
      await target.writable.close();
      assert.equal((await target.finish(metadata)).delivered, completed);
      assert.equal(f.calls.filter(call => call[0] === 'removeEntry').length, 1);
    } else {
      const file = { filename: 'memory.part-0001.bin', blob: new Blob(['part']) };
      if (completed) await target.saveVolume(file);
      else {
        await assert.rejects(target.saveVolume(file), error => error.name === 'AbortError');
        await assert.rejects(target.saveVolume(file), error => error.name === 'AbortError');
      }
      assert.equal((await target.finish(metadata)).delivered, completed);
    }
    assert.equal(calls, 1, '取消不能继续原生分享或生成下一个下载');
  });
});
