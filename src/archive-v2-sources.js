import { cleanAnalysisText, collectSourceCatalogCandidates } from './route-source.js';

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
const bind = (target, name) => typeof target?.[name] === 'function' ? (...args) => target[name](...args) : target?.[name];

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

function scanSafeContext(ctx, onFailure) {
  const safe = Object.create(ctx && typeof ctx === 'object' ? ctx : null);
  const scanner = ctx?.simulateWorldInfoActivation;
  safe.simulateWorldInfoActivation = async (...args) => {
    if (typeof scanner !== 'function') { onFailure(); return { activatedEntries: [] }; }
    try { return await scanner.apply(ctx, args); }
    catch { onFailure(); return { activatedEntries: [] }; }
  };
  for (const name of ['loadWorldInfoBatch', 'getCharaAuxWorlds', 'getCharaFilename']) {
    const value = bind(ctx, name);
    if (value !== undefined) safe[name] = value;
  }
  return safe;
}

function characterWithoutWorldbooks(ctx) {
  const characters = Array.isArray(ctx?.characters) ? ctx.characters.slice() : { ...(ctx?.characters || {}) };
  const character = characters[ctx?.characterId];
  if (!plain(character)) return characters;
  const copy = { ...character };
  if (plain(character.data)) copy.data = { ...character.data, extensions: { ...(character.data.extensions || {}), world: '' } };
  else copy.extensions = { ...(character.extensions || {}), world: '' };
  characters[ctx.characterId] = copy;
  return characters;
}

function worldbooklessContext(ctx) {
  const safe = Object.create(ctx && typeof ctx === 'object' ? ctx : null);
  safe.characters = characterWithoutWorldbooks(ctx);
  safe.simulateWorldInfoActivation = async () => ({ activatedEntries: [] });
  safe.getCharaFilename = () => '';
  safe.getCharaAuxWorlds = () => [];
  safe.loadWorldInfoBatch = async () => new Map();
  return safe;
}

function sanitize(candidate) {
  if (!plain(candidate) || !KINDS.has(candidate.kind) || typeof candidate.locator !== 'string' || !candidate.locator
    || typeof candidate.fingerprint !== 'string' || !candidate.fingerprint.startsWith('sha256:')) return null;
  const content = cleanAnalysisText(candidate.content);
  if (!content) return null;
  const availability = typeof candidate.availability === 'string' ? candidate.availability : candidate.kind;
  if (availability === 'disabled' || (candidate.kind === 'worldbook' && candidate.selected !== true)) return null;
  return {
    id: `${candidate.kind}:${candidate.locator}`,
    kind: candidate.kind,
    locator: candidate.locator,
    fingerprint: candidate.fingerprint,
    label: typeof candidate.label === 'string' && candidate.label.trim() ? candidate.label.trim().slice(0, 240) : candidate.kind,
    content,
    selected: true,
    availability,
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

export async function collectArchiveV2ProfileSources(ctx) {
  const warnings = [];
  const warningSet = new Set();
  const addWarning = code => {
    if (!warningSet.has(code)) { warningSet.add(code); warnings.push({ code }); }
  };
  const compatible = greetingCompatibleContext(ctx);
  let scanFailed = false;
  let result;
  try { result = await collectSourceCatalogCandidates(scanSafeContext(compatible, () => { scanFailed = true; })); }
  catch {
    scanFailed = true;
    result = await collectSourceCatalogCandidates(worldbooklessContext(compatible));
  }
  if (scanFailed) addWarning(ARCHIVE_V2_SOURCE_WARNING.WORLDBOOK_SCAN_FAILED);
  for (const warning of Array.isArray(result?.warnings) ? result.warnings : []) {
    const code = WARNING_MAP[warning?.code];
    if (code) addWarning(code);
  }
  let candidates = Array.isArray(result?.candidates) ? result.candidates.map(sanitize).filter(Boolean) : [];
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
