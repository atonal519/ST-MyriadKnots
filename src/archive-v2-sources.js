import { collectCardGreetingCandidates } from './route-source.js';
import { sanitizeArchiveV2SourceContent } from './memory-content-sanitizer.js';
import { filterArchiveV2SourcesByPermission } from './archive-v2-source-permission.js';
import { createArchiveV2WorldInfoSourceCandidates, scanArchiveV2WorldInfo } from './archive-v2-source-scanner.js';

export const ARCHIVE_V2_SOURCE_WARNING = Object.freeze({
  GREETING_TRANSIENT_SWIPE_MISMATCH: 'greeting_transient_swipe_mismatch',
  WORLDBOOK_SCAN_FAILED: 'worldbook_scan_failed',
  WORLDBOOK_READ_FAILED: 'worldbook_read_failed',
  WORLDBOOK_BATCH_UNAVAILABLE: 'worldbook_batch_unavailable',
  WORLDBOOK_AUX_UNAVAILABLE: 'worldbook_aux_unavailable',
});

const WARNING_MAP = Object.freeze({
  WORLDBOOK_READ_FAILED: ARCHIVE_V2_SOURCE_WARNING.WORLDBOOK_READ_FAILED,
  WORLDBOOK_BATCH_UNAVAILABLE: ARCHIVE_V2_SOURCE_WARNING.WORLDBOOK_BATCH_UNAVAILABLE,
  CHARACTER_AUX_WORLDS_UNAVAILABLE: ARCHIVE_V2_SOURCE_WARNING.WORLDBOOK_AUX_UNAVAILABLE,
});
const KINDS = new Set(['card', 'greeting', 'worldbook']);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const normalizedText = value => value.replace(/\r\n?/g, '\n');

function greetingCompatibleContext(ctx) {
  const first = Array.isArray(ctx?.chat) ? ctx.chat[0] : null;
  if (!plain(first) || first.is_system !== true || first.is_user !== false || typeof first.mes !== 'string' || !first.mes.trim()) return ctx;
  const marker = first.is_ejs_processed;
  const processed = marker === true || (Array.isArray(marker) && marker.length > 0 && marker.every(value => value === true));
  if (processed) return ctx;
  const safe = Object.create(ctx && typeof ctx === 'object' ? ctx : null);
  safe.chat = ctx.chat.slice();
  safe.chat[0] = { ...first, is_system: false };
  return safe;
}

function sanitize(candidate, sanitizerOptions) {
  if (!plain(candidate) || !KINDS.has(candidate.kind) || typeof candidate.locator !== 'string' || !candidate.locator
    || typeof candidate.fingerprint !== 'string' || !candidate.fingerprint.startsWith('sha256:')) return null;
  const content = sanitizeArchiveV2SourceContent(candidate.content, sanitizerOptions);
  if (!content) return null;
  const availability = typeof candidate.availability === 'string' ? candidate.availability : candidate.kind;
  if (candidate.kind === 'worldbook' && candidate.selected !== true) return null;
  return {
    id: `${candidate.kind}:${candidate.locator}`,
    kind: candidate.kind,
    locator: candidate.locator,
    fingerprint: candidate.fingerprint,
    label: typeof candidate.label === 'string' && candidate.label.trim() ? candidate.label.trim().slice(0, 240) : candidate.kind,
    content,
    selected: true,
    availability,
    ...(candidate.kind === 'worldbook' ? {
      world: typeof candidate.world === 'string' ? candidate.world : candidate.locator.split(':').slice(0, -1).join(':'),
      uid: candidate.uid === undefined || candidate.uid === null ? candidate.locator.split(':').at(-1) : String(candidate.uid),
      permissionKey: typeof candidate.permissionKey === 'string' ? candidate.permissionKey : undefined,
      hostEnabled: candidate.hostEnabled !== false,
    } : {}),
  };
}

function transientGreeting(ctx) {
  const first = Array.isArray(ctx?.chat) ? ctx.chat[0] : null;
  if (!Array.isArray(first?.swipes)) return false;
  const swipeId = first.swipe_id === undefined ? 0 : first.swipe_id;
  return !Number.isInteger(swipeId) || swipeId < 0 || swipeId >= first.swipes.length
    || typeof first.swipes[swipeId] !== 'string' || typeof first.mes !== 'string'
    || normalizedText(first.mes) !== normalizedText(first.swipes[swipeId]);
}

export async function collectArchiveV2ProfileSources(ctx, { sanitizerOptions } = {}) {
  const warnings = [];
  const warningSet = new Set();
  const addWarning = code => {
    if (!warningSet.has(code)) { warningSet.add(code); warnings.push({ code }); }
  };
  const compatible = greetingCompatibleContext(ctx);
  const ordinary = await collectCardGreetingCandidates(compatible);
  let catalog;
  try { catalog = await scanArchiveV2WorldInfo(compatible); }
  catch { catalog = { entries: [], warnings: [{ code: 'WORLDBOOK_SCAN_FAILED' }] }; }
  for (const warning of Array.isArray(catalog?.warnings) ? catalog.warnings : []) {
    const code = WARNING_MAP[warning?.code];
    if (code) addWarning(code); else if (warning?.code) addWarning(ARCHIVE_V2_SOURCE_WARNING.WORLDBOOK_SCAN_FAILED);
  }
  const worldbooks = await createArchiveV2WorldInfoSourceCandidates(catalog);
  let candidates = [...ordinary, ...worldbooks].map(candidate => sanitize(candidate, sanitizerOptions)).filter(Boolean);
  if (transientGreeting(ctx)) {
    addWarning(ARCHIVE_V2_SOURCE_WARNING.GREETING_TRANSIENT_SWIPE_MISMATCH);
    candidates = candidates.filter(candidate => candidate.kind !== 'greeting');
  }
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = `${candidate.kind}\u0000${candidate.locator}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return { status: 'ready', candidates: unique, warnings };
}

export async function collectArchiveV2PermittedSources(ctx, { chatId, permissionSettings, sanitizerOptions } = {}) {
  const result = await collectArchiveV2ProfileSources(ctx, { sanitizerOptions });
  const permitted = filterArchiveV2SourcesByPermission({ candidates: result.candidates, chatId, settings: permissionSettings });
  return {
    ...result,
    // Downstream profile/bond planners treat availability="disabled" as an
    // unconditional safety stop. A host-disabled entry only reaches this point
    // when the current chat has an explicit QQJ allow override, so expose its
    // effective permission without losing the original hostEnabled marker.
    candidates: permitted.map(candidate => candidate?.kind === 'worldbook' && candidate.availability === 'disabled'
      ? { ...candidate, availability: 'enabled' }
      : candidate),
  };
}
