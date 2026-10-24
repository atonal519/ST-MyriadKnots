export const AVATAR_SOURCE_MAX_BYTES = 10 * 1024 * 1024;
const FORMATS = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' });
const FOLDER = 'qqj-avatars';
const GENERATED_FOLDER = '柏宝绘_千千结头像';

export function normalizeAvatarSource(value) {
  const path = typeof value?.path === 'string' ? `/${value.path.replace(/^\/+/, '')}` : '';
  if (!/^\/user\/images\/(?:qqj-avatars|柏宝绘_千千结头像)\/qqj-avatar-[A-Za-z0-9-]+\.(?:png|jpg|jpeg|webp)$/u.test(path) || !FORMATS[value?.mimeType]) throw new Error('头像原图记录无效。');
  let crop = null;
  if (value.crop != null) {
    const { aspectRatio, zoom, offsetX, offsetY } = value.crop;
    if (![aspectRatio, zoom, offsetX, offsetY].every(Number.isFinite) || aspectRatio <= 0 || zoom < 1 || zoom > 3) throw new Error('头像取景记录无效。');
    crop = Object.freeze({ aspectRatio, zoom, offsetX, offsetY });
  }
  return Object.freeze({ path, mimeType: value.mimeType, crop });
}

// 沿宿主 images/upload 保存原始字节；新文件名不可覆盖分支共用的旧图片。
export function createAvatarImageStore({ fetchImpl = globalThis.fetch, headers = () => ({}), uuid = () => globalThis.crypto.randomUUID() } = {}) {
  return Object.freeze({
    async upload(file, { signal, generated = false } = {}) {
      const format = FORMATS[file?.type];
      if (!format || !Number.isFinite(file.size) || file.size < 1 || file.size > AVATAR_SOURCE_MAX_BYTES || typeof file.arrayBuffer !== 'function') throw new Error('请选择不超过 10 MiB 的 PNG、JPEG 或 WebP 图片。');
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      const response = await fetchImpl('/api/images/upload', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers() }, signal,
        body: JSON.stringify({ image: btoa(binary), format, ch_name: generated ? GENERATED_FOLDER : FOLDER, filename: `qqj-avatar-${uuid()}.${format}` }) });
      if (!response.ok) throw new Error(`原图保存失败（${response.status}），请重试。`);
      let stored;
      try { stored = normalizeAvatarSource({ path: (await response.json())?.path, mimeType: file.type }); }
      catch (error) { if (error?.name === 'AbortError') throw error; throw new Error('原图保存失败：酒馆未返回有效图片路径，请重试。'); }
      return Object.freeze({ path: stored.path, mimeType: stored.mimeType });
    },
  });
}
