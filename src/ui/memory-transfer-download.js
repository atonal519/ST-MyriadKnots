const saved = () => ({ delivered: true, message: '记忆包已保存。' });
const cancelled = () => ({ delivered: false, message: '已取消导出。' });
const downloadCancelled = result => result?.delivered === false || result?.mode === 'ios-native-share' && result.completed === false;

function trackedWritable(stream) {
  let closed = false, aborting = null;
  return {
    write: value => stream.write(value),
    async close() { await stream.close(); closed = true; },
    abort() { return closed ? Promise.resolve() : aborting ??= stream.abort(); },
  };
}

export async function prepareMemoryBundleDownload(windowRef = globalThis, hostDownload) {
  if (typeof windowRef.showSaveFilePicker === 'function') {
    // Acquire the handle before any export work can consume the click's activation.
    const handle = await windowRef.showSaveFilePicker({ suggestedName: '千千结记忆.qqj-memory',
      types: [{ description: '千千结记忆包', accept: { 'application/octet-stream': ['.qqj-memory'] } }] });
    const writable = trackedWritable(await handle.createWritable());
    let stopped = false;
    return { mode: 'bundle', writable, finish: async () => stopped ? cancelled() : saved(),
      async abort() { stopped = true; await writable.abort(); } };
  }
  if (typeof hostDownload !== 'function') throw new Error('当前酒馆未提供可用的下载接口。');
  const nativeStore = windowRef.__TAURITAVERN__?.api?.extension?.store;
  if (typeof nativeStore?.getBlobStream === 'function' && typeof windowRef.navigator?.storage?.getDirectory === 'function') {
    const directory = await windowRef.navigator.storage.getDirectory();
    const name = `qqj-export-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
    const handle = await directory.getFileHandle(name, { create: true });
    if (typeof handle.createWritable !== 'function') {
      await directory.removeEntry(name);
      return volumeDownload(hostDownload);
    }
    let writable;
    try { writable = trackedWritable(await handle.createWritable()); }
    catch (error) { await directory.removeEntry(name); throw error; }
    let stopped = false, finishing = null, aborting = null, removing = null;
    const removeTemporary = () => removing ??= directory.removeEntry(name);
    return { mode: 'bundle', writable,
      finish(metadata) {
        if (finishing) return finishing;
        if (stopped) return Promise.resolve(aborting).then(cancelled);
        finishing = (async () => {
          const file = await handle.getFile();
          if (stopped) return cancelled();
          const result = await hostDownload(file, metadata.filename, file.type, { throwOnFailure: true });
          return stopped || downloadCancelled(result) ? cancelled() : saved();
        })().finally(removeTemporary);
        return finishing;
      },
      abort() {
        stopped = true;
        aborting ??= (async () => {
          if (finishing) {
            // Native download may still be streaming the disk-backed File.
            try { await finishing; } catch { /* finish preserves the delivery failure */ }
          } else {
            try { await writable.abort(); } finally { await removeTemporary(); }
          }
        })();
        return aborting;
      },
    };
  }
  return volumeDownload(hostDownload);
}

function volumeDownload(hostDownload) {
  let stopped = false;
  return { mode: 'volumes',
    async saveVolume(file) {
      if (stopped) throw new DOMException('已取消导出。', 'AbortError');
      const result = await hostDownload(file.blob, file.filename, file.blob.type, { throwOnFailure: true });
      if (stopped || downloadCancelled(result)) {
        stopped = true; throw new DOMException('已取消导出。', 'AbortError');
      }
    },
    finish: async () => stopped ? cancelled() : { delivered: true, message: '已提交全部下载（清单含在内），浏览器可能要求允许连续下载。' },
    async abort() { stopped = true; },
  };
}
