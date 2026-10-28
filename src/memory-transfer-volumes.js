import { isUuid, sha256, sha256Bytes as hashBytes } from './identity.js';
import { stableJson } from './memory-transfer-json.js';

export const MEMORY_VOLUME_BYTES = 8 * 1024 * 1024;
const FORMAT = 'qqj-core-chat-memory-volumes';
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const check = (ok, message) => { if (!ok) throw new Error(message); };
const join = (pieces, length) => {
  if (pieces.length === 1) return pieces[0];
  const result = new Uint8Array(length); let offset = 0;
  for (const piece of pieces) { result.set(piece, offset); offset += piece.length; }
  return result;
};

// Each yielded Blob is released by the UI before requesting the next volume.
export async function* createMemoryVolumes(entries, { archiveId, source, exportedAt, partBytes = MEMORY_VOLUME_BYTES } = {}) {
  check(isUuid(archiveId) && Number.isSafeInteger(partBytes) && partBytes > 0 && partBytes <= MEMORY_VOLUME_BYTES, '分卷参数无效。');
  const prefix = `千千结记忆-${archiveId}`, parts = [];
  let buffer = new Uint8Array(partBytes), used = 0, totalBytes = 0;
  const part = async () => {
    const bytes = buffer.subarray(0, used), index = parts.length + 1;
    const filename = `${prefix}.qqj-memory.part-${String(index).padStart(4, '0')}.bin`;
    const checksum = await hashBytes(bytes);
    parts.push({ filename, bytes: used, checksum }); totalBytes += used;
    return { filename, part: index, manifest: false, blob: new Blob([bytes], { type: 'application/octet-stream' }) };
  };
  for await (const entry of entries) {
    const bytes = encoder.encode(`${JSON.stringify(entry)}\n`);
    for (let offset = 0; offset < bytes.length;) {
      const length = Math.min(partBytes - used, bytes.length - offset);
      buffer.set(bytes.subarray(offset, offset + length), used); used += length; offset += length;
      if (used === partBytes) {
        yield await part(); buffer = new Uint8Array(partBytes); used = 0;
      }
    }
  }
  if (used) yield await part();
  const payload = { format: FORMAT, formatVersion: 3, archiveId, source, exportedAt, partBytes, totalBytes, parts };
  const manifest = { ...payload, checksum: await sha256(stableJson(payload)) };
  yield { filename: `${prefix}.qqj-memory.index.json`, part: parts.length, manifest: true,
    blob: new Blob([JSON.stringify(manifest)], { type: 'application/json;charset=utf-8' }) };
}

// Files remain on disk. Only the current volume/record is decoded; the catalog
// contains byte ranges, never copies of record bodies.
export async function openMemoryVolumes(files, { onRecord = async () => {} } = {}) {
  const selected = Array.from(files), manifests = selected.filter(file => file.name.endsWith('.qqj-memory.index.json'));
  check(manifests.length === 1, '请同时选择一份分卷清单和它的全部记忆卷。');
  check(manifests[0].size <= MEMORY_VOLUME_BYTES, '分卷清单过大。');
  let manifest;
  try { manifest = JSON.parse(await manifests[0].text()); } catch { throw new Error('分卷清单不是有效的 JSON。'); }
  check(manifest && typeof manifest === 'object' && !Array.isArray(manifest), '这不是支持的千千结分卷清单。');
  const { checksum, ...payload } = manifest;
  check(manifest.format === FORMAT && manifest.formatVersion === 3 && isUuid(manifest.archiveId)
    && isUuid(manifest.source?.chatId) && Array.isArray(manifest.parts) && manifest.parts.length > 0
    && Number.isSafeInteger(manifest.partBytes) && manifest.partBytes > 0 && manifest.partBytes <= MEMORY_VOLUME_BYTES,
  '这不是支持的千千结分卷清单。');
  check(checksum === await sha256(stableJson(payload)), '分卷清单完整性校验失败。');
  const byName = new Map(selected.map(file => [file.name, file]));
  check(byName.size === selected.length && selected.length === manifest.parts.length + 1, '分卷缺失、重复或混入了其他文件，请重新选择全部记忆卷。');
  const ranges = [], records = new Map(), avatars = new Map();
  let total = 0, lineStart = 0, pieces = [], pending = 0, header = null;
  for (const part of manifest.parts) {
    const file = byName.get(part.filename);
    check(file && Number.isSafeInteger(part.bytes) && part.bytes > 0 && part.bytes <= manifest.partBytes && file.size === part.bytes,
      `记忆卷缺失或大小不符：${part.filename}。`);
    const start = total;
    const bytes = new Uint8Array(await file.arrayBuffer());
    check(await hashBytes(bytes) === part.checksum, `记忆卷校验失败：${part.filename}。`);
    ranges.push({ file, start, end: start + bytes.length });
    let cursor = 0;
    for (let index = 0; index < bytes.length; index++) if (bytes[index] === 10) {
      const tail = bytes.subarray(cursor, index); pieces.push(tail); pending += tail.length;
      let entry;
      try { entry = JSON.parse(decoder.decode(join(pieces, pending))); } catch { throw new Error('记忆卷内容损坏，无法读取记录。'); }
      const location = { start: lineStart, end: start + index };
      if (entry.kind === 'header') {
        check(header === null && entry.value?.source?.chatId === manifest.source.chatId, '分卷的聊天说明缺失、重复或归属不符。');
        header = entry.value;
      } else if (entry.kind === 'record') {
        check(typeof entry.id === 'string' && !records.has(entry.id), '分卷含有重复或无效的记忆记录。');
        await onRecord(entry, manifest.source.chatId);
        records.set(entry.id, location);
      } else if (entry.kind === 'avatar') {
        check(typeof entry.path === 'string' && !avatars.has(entry.path), '分卷含有重复或无效的头像原图。');
        avatars.set(entry.path, location);
      } else throw new Error('记忆卷包含不支持的内容。');
      pieces = []; pending = 0; cursor = index + 1; lineStart = start + cursor;
    }
    if (cursor < bytes.length) { const tail = bytes.slice(cursor); pieces.push(tail); pending += tail.length; }
    total += bytes.length;
  }
  check(pending === 0 && total === manifest.totalBytes && header && records.size > 0, '记忆分卷未完整结束，请重新选择完整导出。');
  const readEntry = async location => {
    const pieces = []; let length = 0;
    for (const range of ranges) {
      if (range.end <= location.start) continue;
      if (range.start >= location.end) break;
      const bytes = new Uint8Array(await range.file.slice(Math.max(0, location.start - range.start), Math.min(range.file.size, location.end - range.start)).arrayBuffer());
      pieces.push(bytes); length += bytes.length;
    }
    return JSON.parse(decoder.decode(join(pieces, length)));
  };
  return Object.freeze({ header, manifest, recordIds: [...records.keys()], avatarPaths: [...avatars.keys()],
    async readRecord(id) { check(records.has(id), `记忆分卷缺少关联记录：${id}。`); return (await readEntry(records.get(id))).data; },
    async readAvatar(path) { check(avatars.has(path), '分卷缺少头像原图。'); return readEntry(avatars.get(path)); },
    async verify() {
      for (const [index, range] of ranges.entries()) check(await hashBytes(await range.file.arrayBuffer()) === manifest.parts[index].checksum,
        `记忆卷已变化：${range.file.name}。请重新选择分卷。`);
    },
  });
}
