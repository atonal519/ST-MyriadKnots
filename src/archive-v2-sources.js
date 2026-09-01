import { sha256 } from './identity.js';
import { cleanAnalysisText, collectSourceCatalogCandidates } from './route-source.js';
import { computeStableFloorSnapshot } from './stable-floor.js';

export const ARCHIVE_V2_SOURCE_WARNING = Object.freeze({
  GREETING_TRANSIENT_SWIPE_MISMATCH: 'greeting_transient_swipe_mismatch',
  WORLDBOOK_SCAN_FAILED: 'worldbook_scan_failed',
  WORLDBOOK_READ_FAILED: 'worldbook_read_failed',
  WORLDBOOK_BATCH_UNAVAILABLE: 'worldbook_batch_unavailable',
  WORLDBOOK_AUX_UNAVAILABLE: 'worldbook_aux_unavailable',
  CHAT_RANGE_INVALID: 'chat_range_invalid',
  CHAT_SWIPE_UNSTABLE: 'chat_swipe_unstable',
});

const ROUTE_WARNING_CODES = Object.freeze({
  WORLDBOOK_READ_FAILED: ARCHIVE_V2_SOURCE_WARNING.WORLDBOOK_READ_FAILED,
  WORLDBOOK_BATCH_UNAVAILABLE: ARCHIVE_V2_SOURCE_WARNING.WORLDBOOK_BATCH_UNAVAILABLE,
  CHARACTER_AUX_WORLDS_UNAVAILABLE: ARCHIVE_V2_SOURCE_WARNING.WORLDBOOK_AUX_UNAVAILABLE,
});

const ROUTE_KINDS = new Set(['card', 'greeting', 'worldbook']);
const SWIPE_ERRORS = new Set(['INVALID_SWIPE_ID', 'MISSING_SELECTED_SWIPE', 'TRANSIENT_SWIPE_MISMATCH']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function normalizeArchiveV2ChatRange(chatRange, chatLength) {
  if (chatRange === undefined) return { status: 'omitted' };
  if (!isPlainObject(chatRange)
    || !Number.isInteger(chatLength)
    || chatLength < 0
    || !Number.isInteger(chatRange.start)
    || !Number.isInteger(chatRange.end)
    || chatRange.start < 0
    || chatRange.end < chatRange.start
    || chatRange.end >= chatLength) {
    return { status: 'invalid', code: ARCHIVE_V2_SOURCE_WARNING.CHAT_RANGE_INVALID };
  }
  return { status: 'valid', start: chatRange.start, end: chatRange.end };
}

function bindIfFunction(target, name) {
  const value = target?.[name];
  return typeof value === 'function' ? (...args) => value.apply(target, args) : value;
}

function createArchiveGreetingCompatibleContext(ctx) {
  const first = Array.isArray(ctx?.chat) ? ctx.chat[0] : null;
  if (!first
    || typeof first !== 'object'
    || Array.isArray(first)
    || first.is_system !== true
    || first.is_user !== false
    || typeof first.mes !== 'string'
    || !first.mes.trim()) return ctx;
  const marker = first.is_ejs_processed;
  const ejsProcessed = marker === true
    || (Array.isArray(marker) && marker.length > 0 && marker.every(value => value === true));
  if (ejsProcessed) return ctx;
  const safe = Object.create(ctx && typeof ctx === 'object' ? ctx : null);
  safe.chat = ctx.chat.slice();
  safe.chat[0] = { ...first, is_system: false };
  return safe;
}

function createScanSafeContext(ctx, onScanFailure) {
  const safe = Object.create(ctx && typeof ctx === 'object' ? ctx : null);
  const scanner = ctx?.simulateWorldInfoActivation;
  safe.simulateWorldInfoActivation = async (...args) => {
    if (typeof scanner !== 'function') {
      onScanFailure();
      return { activatedEntries: [] };
    }
    try {
      return await scanner.apply(ctx, args);
    } catch {
      onScanFailure();
      return { activatedEntries: [] };
    }
  };
  for (const name of ['loadWorldInfoBatch', 'getCharaAuxWorlds', 'getCharaFilename']) {
    const bound = bindIfFunction(ctx, name);
    if (bound !== undefined) safe[name] = bound;
  }
  return safe;
}

function characterWithoutWorldbooks(ctx) {
  const characters = Array.isArray(ctx?.characters) ? ctx.characters.slice() : { ...(ctx?.characters || {}) };
  const character = characters[ctx?.characterId];
  if (!character || typeof character !== 'object') return characters;
  const copy = { ...character };
  if (character.data && typeof character.data === 'object') {
    copy.data = {
      ...character.data,
      extensions: { ...(character.data.extensions || {}), world: '' },
    };
  } else {
    copy.extensions = { ...(character.extensions || {}), world: '' };
  }
  characters[ctx.characterId] = copy;
  return characters;
}

function createWorldbooklessContext(ctx) {
  const safe = Object.create(ctx && typeof ctx === 'object' ? ctx : null);
  safe.characters = characterWithoutWorldbooks(ctx);
  safe.simulateWorldInfoActivation = async () => ({ activatedEntries: [] });
  safe.getCharaFilename = () => '';
  safe.getCharaAuxWorlds = () => [];
  safe.loadWorldInfoBatch = async () => new Map();
  return safe;
}

function sanitizeRouteCandidate(candidate) {
  if (!isPlainObject(candidate)
    || !ROUTE_KINDS.has(candidate.kind)
    || typeof candidate.locator !== 'string'
    || !candidate.locator
    || typeof candidate.fingerprint !== 'string'
    || !candidate.fingerprint.startsWith('sha256:')) return null;
  const content = cleanAnalysisText(candidate.content);
  if (!content) return null;
  const label = typeof candidate.label === 'string' && candidate.label.trim()
    ? candidate.label.trim().slice(0, 240)
    : candidate.kind;
  const availability = typeof candidate.availability === 'string' ? candidate.availability : candidate.kind;
  const selected = candidate.kind === 'worldbook'
    ? availability !== 'disabled' && candidate.selected === true
    : true;
  return {
    id: `${candidate.kind}:${candidate.locator}`,
    kind: candidate.kind,
    locator: candidate.locator,
    fingerprint: candidate.fingerprint,
    label,
    content,
    selected,
    availability,
  };
}

function greetingHasTransientSwipeMismatch(ctx) {
  const first = Array.isArray(ctx?.chat) ? ctx.chat[0] : null;
  if (!Array.isArray(first?.swipes)) return false;
  const swipeId = first.swipe_id === undefined ? 0 : first.swipe_id;
  if (!Number.isInteger(swipeId)
    || swipeId < 0
    || swipeId >= first.swipes.length
    || typeof first.swipes[swipeId] !== 'string'
    || typeof first.mes !== 'string') return false;
  return normalizedText(first.mes) !== normalizedText(first.swipes[swipeId]);
}

async function collectRouteCandidates(ctx, addWarning) {
  let scanFailed = false;
  const compatibleContext = createArchiveGreetingCompatibleContext(ctx);
  const safeContext = createScanSafeContext(compatibleContext, () => { scanFailed = true; });
  let result;
  try {
    result = await collectSourceCatalogCandidates(safeContext);
  } catch {
    scanFailed = true;
    result = await collectSourceCatalogCandidates(createWorldbooklessContext(compatibleContext));
  }
  if (scanFailed) addWarning(ARCHIVE_V2_SOURCE_WARNING.WORLDBOOK_SCAN_FAILED);
  for (const warning of Array.isArray(result?.warnings) ? result.warnings : []) {
    const code = ROUTE_WARNING_CODES[warning?.code];
    if (code) addWarning(code);
  }
  const candidates = Array.isArray(result?.candidates)
    ? result.candidates.map(sanitizeRouteCandidate).filter(Boolean)
    : [];
  if (!greetingHasTransientSwipeMismatch(ctx)) return candidates;
  addWarning(ARCHIVE_V2_SOURCE_WARNING.GREETING_TRANSIENT_SWIPE_MISMATCH);
  return candidates.filter(candidate => candidate.kind !== 'greeting');
}

function hiddenMessage(message) {
  return message?.is_hidden === true || message?.extra?.is_hidden === true;
}

function normalizedText(value) {
  return value.replace(/\r\n?/g, '\n');
}

function selectedChatContent(message, sourceIndex, unstableIndices, addWarning) {
  if (message.is_user === true) return { role: 'user', swipeId: null, content: message.mes };
  const swipeId = message.swipe_id === undefined ? 0 : Number(message.swipe_id);
  if (unstableIndices.has(sourceIndex) || !Number.isInteger(swipeId) || swipeId < 0) {
    addWarning(ARCHIVE_V2_SOURCE_WARNING.CHAT_SWIPE_UNSTABLE);
    return null;
  }
  if (!Array.isArray(message.swipes)) return { role: 'assistant', swipeId, content: message.mes };
  const selected = message.swipes[swipeId];
  if (typeof selected !== 'string'
    || (typeof message.mes === 'string' && normalizedText(message.mes) !== normalizedText(selected))) {
    addWarning(ARCHIVE_V2_SOURCE_WARNING.CHAT_SWIPE_UNSTABLE);
    return null;
  }
  return { role: 'assistant', swipeId, content: selected };
}

async function collectChatCandidates(ctx, range, addWarning) {
  const messages = ctx.chat;
  const snapshot = await computeStableFloorSnapshot(messages);
  const unstableIndices = new Set(
    (Array.isArray(snapshot?.errors) ? snapshot.errors : [])
      .filter(error => SWIPE_ERRORS.has(error?.code) && Number.isInteger(error?.sourceIndex))
      .map(error => error.sourceIndex),
  );
  const candidates = [];
  for (let sourceIndex = range.start; sourceIndex <= range.end; sourceIndex += 1) {
    if (sourceIndex === 0) continue;
    const message = messages[sourceIndex];
    if (!message || typeof message !== 'object' || message.is_system === true || hiddenMessage(message)) continue;
    if (typeof message.is_user !== 'boolean') continue;
    const selected = selectedChatContent(message, sourceIndex, unstableIndices, addWarning);
    if (!selected || typeof selected.content !== 'string') continue;
    const rawContent = normalizedText(selected.content);
    const content = cleanAnalysisText(rawContent);
    if (!content) continue;
    const locator = selected.role === 'assistant'
      ? `floor:${sourceIndex}:assistant:swipe:${selected.swipeId}`
      : `floor:${sourceIndex}:user`;
    const fingerprint = `sha256:${await sha256(`sourceIndex=${sourceIndex}\nrole=${selected.role}\nswipe=${selected.swipeId ?? '-'}\ncontent=${rawContent}`)}`;
    candidates.push({
      id: `chat:${locator}`,
      kind: 'chat',
      locator,
      fingerprint,
      label: `第 ${sourceIndex} 楼 · ${selected.role === 'user' ? '用户' : 'AI'}`,
      content,
      selected: false,
      availability: 'chat',
    });
  }
  return candidates;
}

export async function collectArchiveV2InitializationSources(ctx, { chatRange } = {}) {
  const warnings = [];
  const warningCodes = new Set();
  const addWarning = code => {
    if (typeof code !== 'string' || warningCodes.has(code)) return;
    warningCodes.add(code);
    warnings.push({ code });
  };

  const candidates = await collectRouteCandidates(ctx, addWarning);
  const range = normalizeArchiveV2ChatRange(chatRange, Array.isArray(ctx?.chat) ? ctx.chat.length : -1);
  if (range.status === 'invalid') addWarning(range.code);
  if (range.status === 'valid') candidates.push(...await collectChatCandidates(ctx, range, addWarning));

  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = `${candidate.kind}\u0000${candidate.locator}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...candidate });
  }
  return { status: 'ready', candidates: unique, warnings: warnings.map(warning => ({ ...warning })) };
}
