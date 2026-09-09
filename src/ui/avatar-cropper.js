export const AVATAR_SOURCE_MAX_BYTES = 10 * 1024 * 1024;
export const AVATAR_OUTPUT_MAX_DATA_URL_LENGTH = 2 * 1024 * 1024;
export const AVATAR_OUTPUT_MAX_EDGE = 512;
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function avatarCropLayout({ naturalWidth, naturalHeight, frameWidth, frameHeight, zoom = 1, offsetX = 0, offsetY = 0 }) {
  if (![naturalWidth, naturalHeight, frameWidth, frameHeight].every(value => Number.isFinite(value) && value > 0)) throw new Error('头像图片尺寸无效。');
  const safeZoom = clamp(Number(zoom) || 1, 1, 3);
  const scale = Math.max(frameWidth / naturalWidth, frameHeight / naturalHeight) * safeZoom;
  const width = naturalWidth * scale, height = naturalHeight * scale;
  const maxX = Math.max(0, (width - frameWidth) / 2), maxY = Math.max(0, (height - frameHeight) / 2);
  const x = clamp(Number(offsetX) || 0, -maxX, maxX), y = clamp(Number(offsetY) || 0, -maxY, maxY);
  return Object.freeze({ zoom: safeZoom, width, height, left: (frameWidth - width) / 2 + x, top: (frameHeight - height) / 2 + y, offsetX: x, offsetY: y });
}

export async function loadAvatarSource(file, { imageFactory = () => new Image(), urlApi = URL, signal = null } = {}) {
  if (!file || !ALLOWED_TYPES.has(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 静态图片。');
  if (!Number.isFinite(file.size) || file.size < 1 || file.size > AVATAR_SOURCE_MAX_BYTES) throw new Error('原图不能超过 10 MiB。');
  const objectUrl = urlApi.createObjectURL(file);
  let image = null;
  try {
    image = imageFactory();
    await new Promise((resolve, reject) => {
      const cleanup = () => { signal?.removeEventListener?.('abort', abort); image.onload = null; image.onerror = null; };
      const finish = callback => value => { cleanup(); callback(value); };
      const abort = () => { image.src = ''; finish(reject)(Object.assign(new Error('头像读取已取消。'), { name: 'AbortError' })); };
      if (signal?.aborted) { abort(); return; }
      image.onload = finish(resolve);
      image.onerror = finish(() => reject(new Error('图片无法读取，请换一张重试。')));
      signal?.addEventListener?.('abort', abort, { once: true });
      image.src = objectUrl;
    });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('图片尺寸无效。');
    return Object.freeze({ image, objectUrl, release: () => urlApi.revokeObjectURL(objectUrl) });
  } catch (error) {
    if (image) { image.onload = null; image.onerror = null; image.src = ''; }
    urlApi.revokeObjectURL(objectUrl);
    throw error;
  }
}

export function cropAvatarDataUrl({ image, aspectRatio, zoom, offsetX, offsetY, canvas }) {
  if (!canvas?.getContext) throw new Error('当前浏览器不支持头像裁剪。');
  const aspect = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;
  const width = aspect >= 1 ? AVATAR_OUTPUT_MAX_EDGE : Math.max(1, Math.round(AVATAR_OUTPUT_MAX_EDGE * aspect));
  const height = aspect >= 1 ? Math.max(1, Math.round(AVATAR_OUTPUT_MAX_EDGE / aspect)) : AVATAR_OUTPUT_MAX_EDGE;
  canvas.width = width; canvas.height = height;
  const layout = avatarCropLayout({ naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, frameWidth: width, frameHeight: height, zoom, offsetX: (Number(offsetX) || 0) * width / 240, offsetY: (Number(offsetY) || 0) * width / 240 });
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, width, height);
  context.drawImage(image, layout.left, layout.top, layout.width, layout.height);
  const dataUrl = canvas.toDataURL('image/webp', 0.9);
  if (!/^data:image\/(?:png|jpeg|webp);base64,/u.test(dataUrl) || dataUrl.length > AVATAR_OUTPUT_MAX_DATA_URL_LENGTH) throw new Error('裁剪后的头像仍然过大，请换一张图片。');
  return dataUrl;
}
