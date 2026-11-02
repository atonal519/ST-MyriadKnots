import { MEMORY_VOLUME_BYTES, openMemoryVolumes } from './memory-transfer-volumes.js';

const MAGIC = 'QQJ-MEMORY-BNDL1', FOOTER_BYTES = 32;
const check = (ok, message) => { if (!ok) throw new Error(message); };
const checkAbort = signal => { if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError'); };

// The caller supplies a file writer, not a collector of every Blob. Successful
// writes close it here; callers may then deliver the completed disk-backed file.
export async function writeMemoryBundle(parts, writable, { onProgress = () => {}, signal } = {}) {
  const iterator = parts[Symbol.asyncIterator]();
  let returning, manifest = null, count = 0, bytes = 0;
  const returnSource = () => returning ??= Promise.resolve().then(() => iterator.return?.());
  const cancelled = () => { void returnSource().catch(() => {}); };
  signal?.addEventListener('abort', cancelled, { once: true });
  try {
    for (;;) {
      checkAbort(signal);
      const item = await iterator.next();
      checkAbort(signal);
      if (item.done) break;
      const file = item.value;
      check(!manifest && Number.isSafeInteger(file?.blob?.size) && file.blob.size > 0 && file.blob.size <= MEMORY_VOLUME_BYTES,
        '记忆包分卷或清单无效。');
      if (file.manifest) { manifest = file; continue; }
      check(Number.isSafeInteger(bytes + file.blob.size), '记忆包大小超出可读取范围。');
      await writable.write(file.blob);
      checkAbort(signal);
      bytes += file.blob.size; count++;
      onProgress({ part: count, parts: count, bytes, manifest: false });
    }
    check(manifest && count > 0, '记忆包缺少完整清单或正文卷。');
    check(Number.isSafeInteger(bytes + manifest.blob.size + FOOTER_BYTES), '记忆包大小超出可读取范围。');
    // Only publish the directory/footer after the source has completely ended.
    await writable.write(manifest.blob);
    checkAbort(signal);
    await writable.write(new Blob([`${MAGIC}${manifest.blob.size.toString(16).padStart(16, '0')}`]));
    checkAbort(signal);
    bytes += manifest.blob.size + FOOTER_BYTES;
    await writable.close();
    onProgress({ part: count, parts: count, bytes, manifest: true });
    return { filename: manifest.filename.replace(/\.qqj-memory\.index\.json$/, '.qqj-memory'), parts: count, bytes };
  } catch (error) {
    // Preserve the original read/write failure while attempting both cleanups.
    try { await returnSource(); } catch { /* source may already have failed */ }
    try { await writable.abort?.(error); } catch { /* writer may already be closed */ }
    throw error;
  } finally { signal?.removeEventListener('abort', cancelled); }
}

// The existing volume reader retains only ranges and the current record. These
// virtual files keep that behavior while all bytes live in one selected file.
export async function openMemoryBundle(file, { onRecord } = {}) {
  check(Number.isSafeInteger(file?.size) && file.size >= FOOTER_BYTES, '记忆包未完整结束，无法读取。');
  const footer = await file.slice(file.size - FOOTER_BYTES, file.size).text();
  check(new RegExp(`^${MAGIC}[0-9a-f]{16}$`).test(footer), '记忆包末尾信息损坏或文件尚未保存完整。');
  const manifestBytes = Number.parseInt(footer.slice(MAGIC.length), 16);
  check(Number.isSafeInteger(manifestBytes) && manifestBytes > 0 && manifestBytes <= MEMORY_VOLUME_BYTES
    && manifestBytes <= file.size - FOOTER_BYTES, '记忆包清单大小无效。');
  const payloadBytes = file.size - FOOTER_BYTES - manifestBytes;
  const text = await file.slice(payloadBytes, file.size - FOOTER_BYTES).text();
  let manifest;
  try { manifest = JSON.parse(text); } catch { throw new Error('记忆包清单不是有效的 JSON。'); }
  check(Array.isArray(manifest?.parts) && manifest.parts.length > 0, '记忆包缺少正文卷清单。');
  const files = [{ name: 'bundle.qqj-memory.index.json', size: manifestBytes, text: async () => text }];
  let offset = 0;
  for (const part of manifest.parts) {
    check(typeof part?.filename === 'string' && Number.isSafeInteger(part.bytes) && part.bytes > 0
      && part.bytes <= MEMORY_VOLUME_BYTES && part.bytes <= payloadBytes - offset, '记忆包正文卷缺失或大小不符。');
    const start = offset;
    files.push({ name: part.filename, size: part.bytes,
      arrayBuffer: () => file.slice(start, start + part.bytes).arrayBuffer(),
      slice: (from = 0, end = part.bytes) => file.slice(start + from, start + end) });
    offset += part.bytes;
  }
  check(offset === payloadBytes && manifest.totalBytes === payloadBytes, '记忆包正文大小与清单不符。');
  return openMemoryVolumes(files, { onRecord });
}
