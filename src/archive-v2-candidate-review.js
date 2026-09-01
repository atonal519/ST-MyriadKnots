import {
  ARCHIVE_V2_CANDIDATE_DRAFT_KIND,
  ARCHIVE_V2_CANDIDATE_DRAFT_SCHEMA_VERSION,
  ARCHIVE_V2_RECOGNITION_LIMITS,
} from './archive-v2-recognition.js';

export const ARCHIVE_V2_CANDIDATE_REVIEW_SCHEMA_VERSION = 1;
export const ARCHIVE_V2_CANDIDATE_REVIEW_KIND = 'myriad-knots-candidate-review';
export const ARCHIVE_V2_SELECTED_PEOPLE_PLAN_KIND = 'myriad-knots-selected-people-plan';

const MAX_ID_CHARACTERS = 200;
const MAX_LOCATOR_CHARACTERS = 2000;
const SOURCE_KINDS = new Set(['card', 'greeting', 'worldbook', 'chat']);
const DRAFT_ROOT_KEYS = new Set(['schemaVersion', 'kind', 'chatId', 'sourceFingerprint', 'candidates']);
const REVIEW_ROOT_KEYS = new Set(['schemaVersion', 'kind', 'chatId', 'sourceFingerprint', 'candidates']);
const DRAFT_CANDIDATE_KEYS = new Set(['candidateId', 'displayName', 'aliases', 'reason', 'sourceRefs']);
const REVIEW_CANDIDATE_KEYS = new Set([...DRAFT_CANDIDATE_KEYS, 'selected']);
const SOURCE_REF_KEYS = new Set(['kind', 'locator', 'fingerprint']);

export class ArchiveV2CandidateReviewError extends Error {
  constructor(message, code = 'ARCHIVE_V2_CANDIDATE_REVIEW_INVALID') {
    super(message);
    this.name = 'ArchiveV2CandidateReviewError';
    this.code = code;
  }
}

function fail(message, code = 'ARCHIVE_V2_CANDIDATE_REVIEW_INVALID') {
  throw new ArchiveV2CandidateReviewError(message, code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(value, allowed, label) {
  if (!isPlainObject(value)) fail(`${label} 必须是对象`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== allowed.size || keys.some(key => typeof key !== 'string' || !allowed.has(key))) {
    fail(`${label} 字段无效`, 'ARCHIVE_V2_CANDIDATE_REVIEW_FIELDS_INVALID');
  }
}

function boundedString(value, maxLength, label, { trim = true } = {}) {
  if (typeof value !== 'string' || value.length > maxLength || !value.trim()) {
    fail(`${label} 无效`, 'ARCHIVE_V2_CANDIDATE_REVIEW_FIELD_INVALID');
  }
  return trim ? value.trim() : value;
}

function comparisonKey(value) {
  return value.normalize('NFKC').trim().toLowerCase();
}

function normalizeAliases(aliases, displayName, { enforceInputLimit = true } = {}) {
  if (!Array.isArray(aliases)
    || (enforceInputLimit && aliases.length > ARCHIVE_V2_RECOGNITION_LIMITS.maxAliases)) {
    fail('aliases 无效', 'ARCHIVE_V2_CANDIDATE_REVIEW_ALIASES_INVALID');
  }
  const output = [];
  const seen = new Set([comparisonKey(displayName)]);
  for (const alias of aliases) {
    const normalized = boundedString(
      alias,
      ARCHIVE_V2_RECOGNITION_LIMITS.maxAliasCharacters,
      'alias',
    );
    const key = comparisonKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (output.length > ARCHIVE_V2_RECOGNITION_LIMITS.maxAliases) {
      fail('aliases 超过数量上限', 'ARCHIVE_V2_CANDIDATE_REVIEW_ALIASES_INVALID');
    }
  }
  return output;
}

function sourceRef(value) {
  requireExactKeys(value, SOURCE_REF_KEYS, 'sourceRef');
  if (!SOURCE_KINDS.has(value.kind)) fail('sourceRef.kind 无效');
  const locator = boundedString(value.locator, MAX_LOCATOR_CHARACTERS, 'sourceRef.locator', { trim: false });
  if (typeof value.fingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value.fingerprint)) {
    fail('sourceRef.fingerprint 无效');
  }
  return { kind: value.kind, locator, fingerprint: value.fingerprint };
}

function normalizeSourceRefs(sourceRefs, maxRefs = ARCHIVE_V2_RECOGNITION_LIMITS.maxEvidence) {
  if (!Array.isArray(sourceRefs)
    || sourceRefs.length < 1
    || sourceRefs.length > maxRefs) {
    fail('sourceRefs 无效');
  }
  const output = [];
  const seen = new Set();
  for (const value of sourceRefs) {
    const ref = sourceRef(value);
    const key = `${ref.kind}\u0000${ref.locator}\u0000${ref.fingerprint}`;
    if (seen.has(key)) fail('sourceRefs 不得重复');
    seen.add(key);
    output.push(ref);
  }
  return output;
}

function baseCandidate(value, expectedKeys, {
  strictAliases = false,
  maxSourceRefs = ARCHIVE_V2_RECOGNITION_LIMITS.maxEvidence,
} = {}) {
  requireExactKeys(value, expectedKeys, 'candidate');
  const candidateId = boundedString(value.candidateId, MAX_ID_CHARACTERS, 'candidateId', { trim: false });
  const displayName = boundedString(
    value.displayName,
    ARCHIVE_V2_RECOGNITION_LIMITS.maxNameCharacters,
    'displayName',
  );
  const aliases = normalizeAliases(value.aliases, displayName);
  if (strictAliases && JSON.stringify(aliases) !== JSON.stringify(value.aliases)) {
    fail('整理态 aliases 必须已规范化', 'ARCHIVE_V2_CANDIDATE_REVIEW_ALIASES_INVALID');
  }
  const reason = boundedString(
    value.reason,
    ARCHIVE_V2_RECOGNITION_LIMITS.maxReasonCharacters,
    'reason',
  );
  return {
    candidateId,
    displayName,
    aliases,
    reason,
    sourceRefs: normalizeSourceRefs(value.sourceRefs, maxSourceRefs),
  };
}

function validateRoot(value, expectedKind, expectedKeys) {
  requireExactKeys(value, expectedKeys, 'root');
  if (value.schemaVersion !== ARCHIVE_V2_CANDIDATE_DRAFT_SCHEMA_VERSION
    || value.kind !== expectedKind) fail('schemaVersion 或 kind 无效');
  const chatId = boundedString(value.chatId, MAX_ID_CHARACTERS, 'chatId', { trim: false });
  if (typeof value.sourceFingerprint !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test(value.sourceFingerprint)) {
    fail('sourceFingerprint 无效');
  }
  if (!Array.isArray(value.candidates)
    || value.candidates.length > ARCHIVE_V2_RECOGNITION_LIMITS.maxCandidates) {
    fail('candidates 无效');
  }
  return { chatId, sourceFingerprint: value.sourceFingerprint };
}

function validateDraft(draft) {
  const root = validateRoot(draft, ARCHIVE_V2_CANDIDATE_DRAFT_KIND, DRAFT_ROOT_KEYS);
  const ids = new Set();
  const candidates = draft.candidates.map(value => {
    const candidate = baseCandidate(value, DRAFT_CANDIDATE_KEYS);
    if (ids.has(candidate.candidateId)) fail('candidateId 重复');
    ids.add(candidate.candidateId);
    return candidate;
  });
  return { ...root, candidates };
}

function validateReview(review) {
  const root = validateRoot(review, ARCHIVE_V2_CANDIDATE_REVIEW_KIND, REVIEW_ROOT_KEYS);
  if (review.schemaVersion !== ARCHIVE_V2_CANDIDATE_REVIEW_SCHEMA_VERSION) fail('整理态 schemaVersion 无效');
  const ids = new Set();
  const candidates = review.candidates.map(value => {
    const candidate = baseCandidate(value, REVIEW_CANDIDATE_KEYS, {
      strictAliases: true,
      maxSourceRefs: ARCHIVE_V2_RECOGNITION_LIMITS.maxSources,
    });
    if (typeof value.selected !== 'boolean') fail('selected 必须是布尔值');
    if (ids.has(candidate.candidateId)) fail('candidateId 重复');
    ids.add(candidate.candidateId);
    return { ...candidate, selected: value.selected };
  });
  return {
    schemaVersion: ARCHIVE_V2_CANDIDATE_REVIEW_SCHEMA_VERSION,
    kind: ARCHIVE_V2_CANDIDATE_REVIEW_KIND,
    ...root,
    candidates,
  };
}

function withCandidate(review, candidateId, update) {
  const safe = validateReview(review);
  const index = safe.candidates.findIndex(candidate => candidate.candidateId === candidateId);
  if (index < 0) fail('候选不存在', 'ARCHIVE_V2_CANDIDATE_REVIEW_NOT_FOUND');
  safe.candidates[index] = update(safe.candidates[index]);
  return safe;
}

export function createArchiveV2CandidateReview(draft) {
  const safe = validateDraft(draft);
  return {
    schemaVersion: ARCHIVE_V2_CANDIDATE_REVIEW_SCHEMA_VERSION,
    kind: ARCHIVE_V2_CANDIDATE_REVIEW_KIND,
    chatId: safe.chatId,
    sourceFingerprint: safe.sourceFingerprint,
    candidates: safe.candidates.map(candidate => ({ ...candidate, selected: false })),
  };
}

export function setArchiveV2CandidateSelected(review, candidateId, selected) {
  if (typeof selected !== 'boolean') fail('selected 必须是布尔值');
  return withCandidate(review, candidateId, candidate => ({ ...candidate, selected }));
}

export function renameArchiveV2Candidate(review, candidateId, displayName) {
  const normalized = boundedString(
    displayName,
    ARCHIVE_V2_RECOGNITION_LIMITS.maxNameCharacters,
    'displayName',
  );
  return withCandidate(review, candidateId, candidate => ({
    ...candidate,
    displayName: normalized,
    aliases: normalizeAliases(candidate.aliases, normalized),
  }));
}

export function setArchiveV2CandidateAliases(review, candidateId, aliases) {
  return withCandidate(review, candidateId, candidate => ({
    ...candidate,
    aliases: normalizeAliases(aliases, candidate.displayName),
  }));
}

function mergedSourceRefs(candidates) {
  const output = [];
  const seen = new Set();
  for (const candidate of candidates) for (const ref of candidate.sourceRefs) {
    const key = `${ref.kind}\u0000${ref.locator}\u0000${ref.fingerprint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ ...ref });
  }
  if (output.length > ARCHIVE_V2_RECOGNITION_LIMITS.maxSources) fail('合并后的 sourceRefs 超过上限');
  return output;
}

export function mergeArchiveV2Candidates(review, { targetId, sourceIds } = {}) {
  const safe = validateReview(review);
  if (!Array.isArray(sourceIds) || sourceIds.length < 1) {
    fail('sourceIds 不能为空', 'ARCHIVE_V2_CANDIDATE_REVIEW_MERGE_INVALID');
  }
  if (sourceIds.some(id => typeof id !== 'string' || !id)) {
    fail('sourceIds 无效', 'ARCHIVE_V2_CANDIDATE_REVIEW_MERGE_INVALID');
  }
  if (sourceIds.includes(targetId) || new Set(sourceIds).size !== sourceIds.length) {
    fail('sourceIds 包含目标或重复', 'ARCHIVE_V2_CANDIDATE_REVIEW_MERGE_INVALID');
  }
  const byId = new Map(safe.candidates.map(candidate => [candidate.candidateId, candidate]));
  const target = byId.get(targetId);
  if (!target || sourceIds.some(id => !byId.has(id))) {
    fail('合并候选不存在', 'ARCHIVE_V2_CANDIDATE_REVIEW_NOT_FOUND');
  }
  const sources = sourceIds.map(id => byId.get(id));
  const merged = {
    ...target,
    aliases: normalizeAliases(
      [
        ...target.aliases,
        ...sources.flatMap(candidate => [candidate.displayName, ...candidate.aliases]),
      ],
      target.displayName,
      { enforceInputLimit: false },
    ),
    sourceRefs: mergedSourceRefs([target, ...sources]),
    selected: [target, ...sources].some(candidate => candidate.selected),
  };
  const removed = new Set(sourceIds);
  return {
    ...safe,
    candidates: safe.candidates
      .filter(candidate => !removed.has(candidate.candidateId))
      .map(candidate => candidate.candidateId === targetId ? merged : candidate),
  };
}

export function removeArchiveV2Candidate(review, candidateId) {
  const safe = validateReview(review);
  const index = safe.candidates.findIndex(candidate => candidate.candidateId === candidateId);
  if (index < 0) fail('候选不存在', 'ARCHIVE_V2_CANDIDATE_REVIEW_NOT_FOUND');
  return { ...safe, candidates: safe.candidates.filter((_, candidateIndex) => candidateIndex !== index) };
}

export function buildArchiveV2SelectedPeoplePlan(review) {
  const safe = validateReview(review);
  return {
    schemaVersion: 1,
    kind: ARCHIVE_V2_SELECTED_PEOPLE_PLAN_KIND,
    chatId: safe.chatId,
    sourceFingerprint: safe.sourceFingerprint,
    people: safe.candidates.filter(candidate => candidate.selected).map(candidate => ({
      identityId: candidate.candidateId,
      displayName: candidate.displayName,
      aliases: [...candidate.aliases],
      recognitionReason: candidate.reason,
      sourceRefs: candidate.sourceRefs.map(ref => ({ ...ref })),
    })),
  };
}
