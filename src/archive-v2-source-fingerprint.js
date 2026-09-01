import { sha256 } from './identity.js';

export async function computeArchiveV2SourceFingerprint(sources) {
  if (!Array.isArray(sources)) throw new TypeError('archive-v2 sources must be an array');
  const parts = [];
  for (const source of sources) {
    if (source === null || typeof source !== 'object'
      || typeof source.kind !== 'string'
      || typeof source.locator !== 'string'
      || typeof source.fingerprint !== 'string'
      || typeof source.content !== 'string') {
      throw new TypeError('archive-v2 source fingerprint input is invalid');
    }
    parts.push({
      kind: source.kind,
      locator: source.locator,
      fingerprint: source.fingerprint,
      contentFingerprint: `sha256:${await sha256(source.content)}`,
    });
  }
  return `sha256:${await sha256(JSON.stringify(parts))}`;
}
