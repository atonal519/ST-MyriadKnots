const encoder = new TextEncoder();
export function isUuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
export function newIdentityUuid() { if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID(); throw new Error('宿主缺少 UUID 生成能力'); }
export async function sha256(value) {
  const bytes = encoder.encode(String(value));
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  throw new Error('宿主缺少 SHA-256');
}
