import test from 'node:test';
import assert from 'node:assert/strict';
import { AVATAR_SOURCE_MAX_BYTES, avatarCropLayout, cropAvatarDataUrl, loadAvatarSource } from '../src/ui/avatar-cropper.js';

test('头像裁剪按目标框比例 cover、限制拖动并输出最大边 512 的同构图', () => {
  const layout = avatarCropLayout({ naturalWidth: 1200, naturalHeight: 800, frameWidth: 240, frameHeight: 320, zoom: 1.5, offsetX: 999, offsetY: -999 });
  assert.ok(Math.abs(layout.width - 720) < 1e-9); assert.ok(Math.abs(layout.height - 480) < 1e-9); assert.ok(Math.abs(layout.offsetX - 240) < 1e-9); assert.ok(Math.abs(layout.offsetY + 80) < 1e-9);
  const draws = [], canvas = { getContext: () => ({ clearRect() {}, drawImage(...args) { draws.push(args); } }), toDataURL: type => `data:${type};base64,AAAA` };
  const result = cropAvatarDataUrl({ image: { naturalWidth: 1200, naturalHeight: 800 }, aspectRatio: 0.75, zoom: 1.5, offsetX: 20, offsetY: -15, canvas });
  assert.equal(canvas.width, 384); assert.equal(canvas.height, 512); assert.match(result, /^data:image\/webp/); assert.equal(draws.length, 1);
});

test('头像源文件拒绝危险类型与超限文件，切页取消挂起解码会立刻释放 object URL', async () => {
  let created = 0, revoked = 0, image;
  const urlApi = { createObjectURL() { created += 1; return 'blob:test'; }, revokeObjectURL(value) { assert.equal(value, 'blob:test'); revoked += 1; } };
  await assert.rejects(loadAvatarSource({ type: 'image/svg+xml', size: 100 }, { urlApi }), /PNG、JPEG 或 WebP/);
  await assert.rejects(loadAvatarSource({ type: 'image/png', size: AVATAR_SOURCE_MAX_BYTES + 1 }, { urlApi }), /10 MiB/);
  const controller = new AbortController();
  const pending = loadAvatarSource({ type: 'image/png', size: 100 }, { urlApi, signal: controller.signal, imageFactory: () => (image = { naturalWidth: 0, naturalHeight: 0, onload: null, onerror: null, src: '' }) });
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(image.src, ''); assert.equal(created, 1); assert.equal(revoked, 1);
});
