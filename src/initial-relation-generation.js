import { isUuid, newUuid } from './host-context.js';
import { sha256 } from './identity.js';
import { computeStableFloorSnapshot } from './stable-floor.js';
import { sameRouteSnapshot, summarizeFrozenSourceDiagnostics } from './route-source.js';
import { parseJsonOutput } from './compact-api-client.js';
import { BASIC_FIELD_KEYS, DYNAMIC_FIELD_KEYS } from './people-foundation.js';

export const INITIAL_RELATION_SCHEMA_VERSION = 1;
export const INITIAL_RELATION_WRITER_ID = 'qianqianjie.initial-relation.v1';
export const INITIAL_RELATION_LIMITS = Object.freeze({ maxInputChars: 120000, maxSourceChars: 32000, maxSources: 220, maxItems: 240, maxItemChars: 1200, maxOutputChars: 120000, maxDraftChars: 160000, maxTokens: 16000 });
export const LAST_ATTEMPT_SCHEMA_VERSION = 1;
export const LAST_ATTEMPT_MAX_CHARS = 4096;
export const INITIAL_RELATION_SYSTEM_PROMPT = [
  'Create short evidence-backed relationship items for Myriad Knots.',
  'Return one JSON object with an items array. Each item uses only person, type, text, evidence, and optional relatedTo.',
  'Use only the supplied U/C person codes and A/H evidence codes. evidence must be an array, for example "evidence":["A8"]; for multiple sources use "evidence":["A2","A4"]. Never return UUIDs, locators, fingerprints, quotes, confidence, or storage fields.',
  'source_fact uses only A evidence. interpretation includes at least one H evidence. Uncertain content uses review.',
  'One statement per item. It is valid to return an empty items array when there is no reliable result.',
].join(' ');
export const BASIC_INFO_WRITER_ID = 'qianqianjie.basic-info.v1';
export const BASIC_INFO_LIMITS = Object.freeze({ maxItems: 12, maxFieldChars: 2400, maxOutputChars: 24000, maxTokens: 4000 });
export const BASIC_INFO_SYSTEM_PROMPT = [
  'Extract only explicit, stable character basics for Myriad Knots.',
  'Return one JSON object with a fields array. Each item uses only field, text, and evidence.',
  `field is one of: ${BASIC_FIELD_KEYS.join(', ')}. Use only supplied A/H evidence codes; evidence must be an array, for example "evidence":["A8"], or "evidence":["A2","A4"].`,
  'Reasonable classification, synonym mapping, and concise rephrasing are allowed only when they add no facts.',
  'Map explicit source headings and synonyms: skills / abilities / 能力 / 技能 / 专长 / explicitly skilled at -> abilities; likes / preferences / 喜好 / 爱好 / explicitly prefers -> likes; dislikes / aversions / 厌恶 / 雷点 / explicitly dislikes -> dislikes; values_and_drives / values / principles / 原则 / 价值观 / stable drives -> principles; relationships / family / connections / 人际关系 / 亲属关系 / 稳定社会关系 -> relationships.',
  'Do not guess missing information. Do not include relationship stages, affection, or the character current attitude toward the user.',
  'Do not infer abilities, likes, dislikes, or principles from common knowledge, appearance, tone, or a single action.',
  'For relationships, extract only explicit stable family, friendship, colleague, hierarchy, or faction ties. Exclude current affection, emotion, romantic stage, and temporary conflict.',
  'It is valid to return an empty fields array.',
].join(' ');
export const DYNAMIC_INFO_WRITER_ID = 'qianqianjie.dynamic-info.v1';
export const DYNAMIC_INFO_LIMITS = Object.freeze({ maxItems: 6, maxFieldChars: 2400, maxOutputChars: 16000, maxTokens: 4000 });
export const DYNAMIC_INFO_SYSTEM_PROMPT = [
  'Extract only evidence-backed current personal state for the single target character in Myriad Knots.',
  'Return one JSON object with a fields array. Each item uses only field, text, and evidence.',
  `field is one of: ${DYNAMIC_FIELD_KEYS.join(', ')}. Use only supplied M/H evidence codes; evidence must be an array, for example "evidence":["M1"], or "evidence":["M1","H2"].`,
  'M is compressed BaiBaiBook history and H is exact recent stable chat text. Prefer newer H when M and H differ, and never expand a compressed summary into a new fact.',
  'Map fixed headings and synonyms to the allowed keys, but never invent a new field or unsupported fact.',
  'personalityState is the currently expressed personality state; currentGoals are active personal or plot goals; currentSituation is the current predicament, pressure, environment, or position; currentSecrets are explicit still-hidden secrets; wellbeing is an ongoing physical or mental condition; stableChanges are genuinely established long-term changes.',
  'Exclude momentary emotion, event logs, ordinary world events, equipment inventories, and unrelated NPC memories.',
  'Never include affection, attitude, romantic intent, or relationship stage between the target and U. These belong to the relationship system.',
  'A secret must be explicit rather than uncertain speculation. stableChanges requires repeated, long-term, or explicitly established change evidence; one action is insufficient.',
  'For text, copy the shortest semantically complete continuous excerpt from exactly one cited source. Never paraphrase, summarize, substitute an object, or combine text across sources.',
  'It is valid to return an empty fields array.',
].join(' ');

const REF_KINDS = new Set(['persona', 'card', 'greeting', 'worldbook', 'chat']);
const FORBIDDEN_PATCH_KEYS = new Set(['userFacts', 'locks', 'displayName', 'sourceBinding', 'lifecycle', 'chatId', 'cardId', 'personaId', 'subject', 'status']);
const FORBIDDEN_AI_ITEM_KEYS = new Set([
  'uuid', 'identityid', 'sourcerefs', 'locator', 'fingerprint', 'anchor', 'confidence', 'id', 'writerid', 'operationid', 'baselinedigest', 'provenance', 'state',
  'userfacts', 'locks', 'displayname', 'sourcebinding', 'lifecycle', 'chatid', 'cardid', 'personaid', 'subject', 'status',
  'schemaversion', 'contractversion', 'peoplecontractversion', 'revision', 'generationid', 'createdat', 'updatedat', 'kind', 'data', 'draft', 'completedmemberids',
]);
const TYPE_ALIASES = new Map([
  ['source_fact', 'source_fact'], ['sourcefact', 'source_fact'], ['source_facts', 'source_fact'], ['fact', 'source_fact'], ['来源事实', 'source_fact'],
  ['interpretation', 'interpretation'], ['interpretations', 'interpretation'], ['insight', 'interpretation'], ['inference', 'interpretation'], ['归纳', 'interpretation'],
  ['review', 'review'], ['pending_review', 'review'], ['pending', 'review'], ['uncertain', 'review'], ['待确认', 'review'],
]);
const PROFILE_LISTS = ['sourceFacts', 'interpretations', 'pendingReview'];
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const clone = value => value === undefined ? undefined : structuredClone(value);
const same = (left, right) => { try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; } };
const envelope = value => Boolean(object(value) && value.schemaVersion === 1 && Number.isInteger(value.revision) && value.revision > 0 && isUuid(value.generationId)
  && typeof value.createdAt === 'string' && typeof value.updatedAt === 'string' && object(value.data));
const fail = (status, message, retryableFormat = false) => Object.assign(new Error(message), { relationStatus: status, retryableRecognitionFormat: retryableFormat });
const stale = () => Object.assign(new Error('首次关系生成已失效'), { stale: true });
const chatCollection = chatId => `chat-${chatId}`;
const profileCollection = chatId => `chat-${chatId}-people`;
const normalizeText = value => String(value ?? '').replace(/\r\n?/g, '\n').trim();
const EVIDENCE_CODE = /^[AHM]\d+$/iu;
function normalizeEvidence(value) {
  let codes;
  if (typeof value === 'string') {
    const plain = value.trim();
    if (EVIDENCE_CODE.test(plain)) codes = [plain];
    else if (/^(?:\[\s*[AHM]\d+\s*\])+$/iu.test(plain)) codes = [...plain.matchAll(/\[\s*([AHM]\d+)\s*\]/giu)].map(match => match[1]);
    else return null;
  } else if (Array.isArray(value)) {
    if (value.length < 1 || value.length > 12 || value.some(code => typeof code !== 'string' || !EVIDENCE_CODE.test(code.trim()))) return null;
    codes = value.map(code => code.trim());
  } else return null;
  const normalized = [...new Set(codes.map(code => code.toUpperCase()))];
  return normalized.length >= 1 && normalized.length <= 12 ? normalized : null;
}
const basicAliasKey = value => normalizeText(value).normalize('NFKC').toLocaleLowerCase().replace(/[\s_-]+/gu, '_').replace(/^_+|_+$/g, '');
const BASIC_FIELD_ALIASES = new Map();
for (const [field, aliases] of Object.entries({
  gender: ['gender', 'sex', '性别'],
  age: ['age', '年龄'],
  appearance: ['appearance', '外貌'],
  personality: ['personality', '性格'],
  identity: ['identity', '身份'],
  nsfwPreferences: ['nsfwPreferences', 'nsfw_preference', 'nsfw_preferences', 'NSFW 喜好'],
  abilities: ['abilities', 'ability', 'skills', 'skill', '能力', '技能', '专长', '明确擅长'],
  likes: ['likes', 'like', 'preferences', 'preference', '喜好', '爱好', '明确偏爱'],
  dislikes: ['dislikes', 'dislike', 'aversions', 'aversion', '厌恶', '雷点', '明确不喜欢'],
  principles: ['principles', 'principle', 'values_and_drives', 'values', 'value', '原则', '价值观', '稳定驱动力'],
  relationships: ['relationships', 'relationship', 'family', 'connections', 'connection', '人际关系', '亲属关系', '稳定社会关系'],
})) for (const alias of aliases) BASIC_FIELD_ALIASES.set(basicAliasKey(alias), field);
const normalizeBasicField = value => BASIC_FIELD_ALIASES.get(basicAliasKey(value)) || null;
const DYNAMIC_FIELD_ALIASES = new Map();
for (const [field, aliases] of Object.entries({
  personalityState: ['personalityState', 'personality_state', 'current_personality', 'current_personality_state', '当前性格状态', '性格状态'],
  currentGoals: ['currentGoals', 'current_goals', 'current_goal', 'goals', 'goal', '当前目标', '目标'],
  currentSituation: ['currentSituation', 'current_situation', 'situation', 'predicament', '当前处境', '处境'],
  currentSecrets: ['currentSecrets', 'current_secrets', 'current_secret', 'secrets', 'secret', '当前秘密', '秘密'],
  wellbeing: ['wellbeing', 'well_being', 'current_wellbeing', 'physical_mental_state', '当前身心状态', '身心状态'],
  stableChanges: ['stableChanges', 'stable_changes', 'stable_change', 'long_term_changes', 'long_term_change', '长期稳定变化', '稳定变化'],
})) for (const alias of aliases) DYNAMIC_FIELD_ALIASES.set(basicAliasKey(alias), field);
const normalizeDynamicField = value => DYNAMIC_FIELD_ALIASES.get(basicAliasKey(value)) || null;
const stableJson = value => JSON.stringify(value, (_key, item) => object(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = async value => `sha256:${await sha256(typeof value === 'string' ? value : stableJson(value))}`;
const refLocator = ref => `${ref.kind}\u0000${ref.locator}\u0000${ref.fingerprint}`;
const selectionStatus = value => typeof value === 'string' ? value : value?.status;
const emptySourceDiagnostics = () => ({ greeting: 'unavailable', worldbookTotal: 0, worldbookChanged: 0, worldbookMissing: 0, worldbookUnreadable: 0, codes: [] });
const safeCount = value => Number.isInteger(value) && value >= 0 ? Math.min(value, 100000) : 0;
const safeCode = value => String(value || 'unknown').replace(/[^a-z0-9_:-]/gi, '_').slice(0, 80) || 'unknown';
const FORMAT_STAGES = new Set(['none', 'http_response_json', 'stream_event_json', 'completion_json', 'output_truncated', 'relation_schema', 'relation_semantic']);
const API_SOURCES = new Set(['seven-utility', 'seven-main', 'seven-preset', 'local-preset', 'local', 'tavern', 'unknown']);
const FINISH_REASONS = new Set(['stop', 'length', 'max_tokens', 'content_filter', 'tool_calls', 'function_call', 'other']);
const BASIC_ATTEMPT_STATUSES = new Set(['ready', 'failed', 'conflict', 'stale', 'cancelled']);
const BASIC_REJECTION_CODES = new Set(['item_not_object', 'item_too_large', 'unknown_property', 'unknown_field', 'invalid_text', 'invalid_evidence', 'unknown_evidence', 'duplicate_field', 'item_limit']);
const DYNAMIC_REJECTION_CODES = new Set([...BASIC_REJECTION_CODES, 'relationship_scope', 'transient_state', 'uncertain_secret', 'evidence_mismatch', 'insufficient_stability']);
const safeFormatStage = value => FORMAT_STAGES.has(value) ? value : 'none';
const safeApiSource = value => API_SOURCES.has(value) ? value : 'unknown';
const safeModel = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || 'unknown';
const safeFinishReason = value => FINISH_REASONS.has(value) ? value : '';
const REJECTION_CODES = new Set(['item_not_object', 'forbidden_field', 'unknown_person', 'unknown_type', 'invalid_text', 'invalid_evidence', 'unknown_evidence', 'evidence_policy', 'unknown_related', 'item_too_large', 'duplicate', 'item_limit']);
const safeRejectionCodes = value => [...new Set((Array.isArray(value) ? value : []).filter(code => REJECTION_CODES.has(code)))].slice(0, 12);
const normalizeSourceDiagnostics = value => ({
  greeting: ['same', 'changed', 'unavailable'].includes(value?.greeting) ? value.greeting : 'unavailable',
  worldbookTotal: safeCount(value?.worldbookTotal),
  worldbookChanged: safeCount(value?.worldbookChanged),
  worldbookMissing: safeCount(value?.worldbookMissing),
  worldbookUnreadable: safeCount(value?.worldbookUnreadable),
  codes: [...new Set((Array.isArray(value?.codes) ? value.codes : []).map(safeCode))].slice(0, 8),
});

function routeDiagnostics(previous, current) {
  const refs = Array.isArray(previous?.worldInfoEntries) ? previous.worldInfoEntries : [];
  const now = new Map((Array.isArray(current?.worldInfoEntries) ? current.worldInfoEntries : []).map(item => [`${item?.world}\u0000${item?.uid}`, item]));
  let worldbookChanged = 0, worldbookMissing = 0;
  for (const ref of refs) {
    const item = now.get(`${ref?.world}\u0000${ref?.uid}`);
    if (!item) worldbookMissing += 1;
    else if (item.fingerprint !== ref.fingerprint) worldbookChanged += 1;
  }
  const greeting = !current?.greeting ? 'unavailable' : current.greeting.fingerprint === previous?.greeting?.fingerprint ? 'same' : 'changed';
  const codes = [
    ...(greeting === 'changed' ? ['GREETING_VERSION_CHANGED'] : greeting === 'unavailable' ? ['GREETING_CURRENT_UNAVAILABLE'] : []),
    ...(worldbookChanged ? ['WORLDBOOK_VERSION_CHANGED'] : []),
    ...(worldbookMissing ? ['WORLDBOOK_ENTRY_MISSING'] : []),
  ];
  return normalizeSourceDiagnostics({ greeting, worldbookTotal: refs.length, worldbookChanged, worldbookMissing, worldbookUnreadable: 0, codes });
}

function validRoute(route) {
  if (route?.state !== 'ready' || route.greeting?.floor !== 0 || !Number.isInteger(route.greeting?.swipeId)
    || route.greeting.swipeId < 0 || !/^sha256:[0-9a-f]{64}$/.test(route.greeting?.fingerprint) || !Array.isArray(route.worldInfoEntries)) return false;
  let prior = '';
  for (const entry of route.worldInfoEntries) {
    const key = `${entry?.world}\u0000${entry?.uid}`;
    if (typeof entry?.world !== 'string' || !entry.world || typeof entry?.uid !== 'string' || !entry.uid
      || !/^sha256:[0-9a-f]{64}$/.test(entry?.fingerprint) || key <= prior) return false;
    prior = key;
  }
  return true;
}

function attemptRecord(attempt, status = attempt.status, stage = attempt.stage, errorCode = attempt.errorCode) {
  const output = {
    schemaVersion: LAST_ATTEMPT_SCHEMA_VERSION,
    action: attempt.action,
    attemptedAt: attempt.attemptedAt,
    status: safeCode(status),
    stage: safeCode(stage),
    errorCode: safeCode(errorCode || 'none'),
    aiCalled: attempt.aiCalled === true,
    profileWrites: safeCount(attempt.profileWrites),
    targetCount: safeCount(attempt.targetCount),
    canonCount: safeCount(attempt.canonCount),
    formatStage: safeFormatStage(attempt.formatStage),
    apiSource: safeApiSource(attempt.apiSource),
    model: safeModel(attempt.model),
    ...(safeFinishReason(attempt.finishReason) ? { finishReason: safeFinishReason(attempt.finishReason) } : {}),
    acceptedItems: safeCount(attempt.acceptedItems),
    rejectedItems: safeCount(attempt.rejectedItems),
    rejectionCodes: safeRejectionCodes(attempt.rejectionCodes),
    emptyResult: attempt.emptyResult === true,
    sourceDiagnostics: normalizeSourceDiagnostics(attempt.sourceDiagnostics),
    ...(isUuid(attempt.operationId) ? { operationId: attempt.operationId } : {}),
    ...(/^sha256:[0-9a-f]{64}$/.test(attempt.baselineDigest || '') ? { baselineDigest: attempt.baselineDigest } : {}),
  };
  if (stableJson(output).length > LAST_ATTEMPT_MAX_CHARS) output.sourceDiagnostics.codes = [];
  return output;
}

const newAttempt = action => ({ action, attemptedAt: new Date().toISOString(), status: 'running', stage: 'loading', errorCode: 'none', aiCalled: false, profileWrites: 0, targetCount: 0, canonCount: 0, formatStage: 'none', apiSource: 'unknown', model: 'unknown', acceptedItems: 0, rejectedItems: 0, rejectionCodes: [], emptyResult: false, sourceDiagnostics: emptySourceDiagnostics() });

function captureTaskDiagnostics(attempt, value, { resetFormatStage = false } = {}) {
  const metadata = value?.taskMetadata;
  if (metadata) {
    attempt.apiSource = safeApiSource(metadata.source);
    attempt.model = safeModel(metadata.model);
    const finishReason = safeFinishReason(metadata.finishReason);
    if (finishReason) attempt.finishReason = finishReason; else delete attempt.finishReason;
  }
  if (resetFormatStage) attempt.formatStage = 'none';
  if (FORMAT_STAGES.has(value?.formatStage)) attempt.formatStage = value.formatStage;
  const finishReason = safeFinishReason(value?.finishReason);
  if (finishReason) attempt.finishReason = finishReason;
}

function newBasicAttempt(targetIdentityId, sources) {
  const sourceKinds = { card: 0, greeting: 0, worldbook: 0, chat: 0, memory: 0 };
  for (const source of sources) if (Object.hasOwn(sourceKinds, source?.kind)) sourceKinds[source.kind] += 1;
  return {
    attemptedAt: new Date().toISOString(), status: 'failed', aiCalled: false, targetIdentityId,
    sourceCount: sources.length, sourceKinds, acceptedFields: 0, rejectedFields: 0, rejectionCodes: [], emptyResult: false,
    profileWrites: 0, apiSource: 'unknown', model: 'unknown', finishReason: 'other',
  };
}

function basicAttemptRecord(attempt, status = attempt.status) {
  return {
    schemaVersion: 1,
    attemptedAt: typeof attempt.attemptedAt === 'string' ? attempt.attemptedAt.slice(0, 40) : new Date().toISOString(),
    status: BASIC_ATTEMPT_STATUSES.has(status) ? status : 'failed',
    aiCalled: attempt.aiCalled === true,
    targetIdentityId: isUuid(attempt.targetIdentityId) ? attempt.targetIdentityId : '',
    sourceCount: safeCount(attempt.sourceCount),
    sourceKinds: {
      card: safeCount(attempt.sourceKinds?.card), greeting: safeCount(attempt.sourceKinds?.greeting),
      worldbook: safeCount(attempt.sourceKinds?.worldbook), chat: safeCount(attempt.sourceKinds?.chat),
    },
    acceptedFields: safeCount(attempt.acceptedFields), rejectedFields: safeCount(attempt.rejectedFields),
    rejectionCodes: [...new Set((Array.isArray(attempt.rejectionCodes) ? attempt.rejectionCodes : []).filter(code => BASIC_REJECTION_CODES.has(code)))].slice(0, 12),
    emptyResult: attempt.emptyResult === true,
    profileWrites: safeCount(attempt.profileWrites),
    apiSource: safeApiSource(attempt.apiSource), model: safeModel(attempt.model), finishReason: safeFinishReason(attempt.finishReason) || 'other',
  };
}

function dynamicAttemptRecord(attempt, status = attempt.status) {
  const output = basicAttemptRecord(attempt, status);
  output.sourceKinds.memory = safeCount(attempt.sourceKinds?.memory);
  output.rejectionCodes = [...new Set((Array.isArray(attempt.rejectionCodes) ? attempt.rejectionCodes : []).filter(code => DYNAMIC_REJECTION_CODES.has(code)))].slice(0, 12);
  return output;
}

const relationFailure = (formatStage, message) => {
  const error = fail('failed_retryable', message, true);
  error.formatStage = formatStage;
  error.code = formatStage === 'relation_semantic' ? 'QQJ_RELATION_SEMANTIC' : 'QQJ_RELATION_SCHEMA';
  return error;
};

function captureItemDiagnostics(attempt, value) {
  const diagnostics = value?.itemDiagnostics;
  if (!diagnostics) return;
  attempt.acceptedItems = safeCount(diagnostics.acceptedItems);
  attempt.rejectedItems = safeCount(diagnostics.rejectedItems);
  attempt.rejectionCodes = safeRejectionCodes(diagnostics.rejectionCodes);
  attempt.emptyResult = diagnostics.emptyResult === true;
}

export const INITIAL_RELATION_PATCH_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: true,
  properties: {
    items: { type: 'array', maxItems: INITIAL_RELATION_LIMITS.maxItems, items: { $ref: '#/$defs/item' } },
  },
  $defs: {
    item: { type: 'object', additionalProperties: true, required: ['person', 'type', 'text', 'evidence'], properties: {
      person: { type: 'string' }, type: { type: 'string' }, text: { type: 'string', minLength: 1, maxLength: INITIAL_RELATION_LIMITS.maxItemChars },
      evidence: { anyOf: [{ type: 'string' }, { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string' } }] }, relatedTo: { type: 'string' },
    } },
  },
});

export const BASIC_INFO_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: true,
  properties: {
    fields: { type: 'array', maxItems: BASIC_INFO_LIMITS.maxItems, items: { type: 'object', additionalProperties: true, required: ['field', 'text', 'evidence'], properties: {
      field: { type: 'string' }, text: { type: 'string', minLength: 1, maxLength: BASIC_INFO_LIMITS.maxFieldChars },
      evidence: { anyOf: [{ type: 'string' }, { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string' } }] },
    } } },
  },
});

export const DYNAMIC_INFO_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: true,
  properties: {
    fields: { type: 'array', maxItems: DYNAMIC_INFO_LIMITS.maxItems, items: { type: 'object', additionalProperties: true, required: ['field', 'text', 'evidence'], properties: {
      field: { type: 'string' }, text: { type: 'string', minLength: 1, maxLength: DYNAMIC_INFO_LIMITS.maxFieldChars },
      evidence: { anyOf: [{ type: 'string' }, { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string' } }] },
    } } },
  },
});

export function validateBasicInfoResult(response, { sources } = {}) {
  const value = unwrapResult(response);
  if (stableJson(value).length > BASIC_INFO_LIMITS.maxOutputChars) throw fail('failed_retryable', '基础信息输出超过保存预算');
  const rawFields = value.fields === undefined ? [] : value.fields;
  if (!Array.isArray(rawFields)) throw fail('failed_retryable', '基础信息 fields 外壳无效');
  const evidence = new Map(); let authorIndex = 0, historyIndex = 0;
  for (const source of sources || []) {
    const code = source?.kind === 'chat' ? `H${++historyIndex}` : `A${++authorIndex}`;
    evidence.set(code, { kind: source.kind, locator: source.locator, fingerprint: source.fingerprint });
  }
  const accepted = new Map(), rejected = [];
  for (const raw of rawFields.slice(0, BASIC_INFO_LIMITS.maxItems)) {
    if (!object(raw)) { rejected.push('item_not_object'); continue; }
    if (stableJson(raw).length > BASIC_INFO_LIMITS.maxFieldChars * 4) { rejected.push('item_too_large'); continue; }
    if (Object.keys(raw).some(key => !['field', 'text', 'evidence'].includes(key))) { rejected.push('unknown_property'); continue; }
    const field = normalizeBasicField(raw.field);
    if (!field || !BASIC_FIELD_KEYS.includes(field)) { rejected.push('unknown_field'); continue; }
    const text = normalizeText(raw.text);
    if (!text || text.length > BASIC_INFO_LIMITS.maxFieldChars) { rejected.push('invalid_text'); continue; }
    const codes = normalizeEvidence(raw.evidence);
    if (!codes) { rejected.push('invalid_evidence'); continue; }
    if (!codes.length || codes.some(code => !evidence.has(code))) { rejected.push('unknown_evidence'); continue; }
    if (accepted.has(field)) { rejected.push('duplicate_field'); continue; }
    const sourceRefs = codes.map(code => clone(evidence.get(code)));
    accepted.set(field, { value: text, provenance: codes.some(code => code.startsWith('H')) ? 'ai' : 'source', sourceRefs });
  }
  if (rawFields.length > BASIC_INFO_LIMITS.maxItems) rejected.push('item_limit');
  return { fields: Object.fromEntries(accepted), diagnostics: { acceptedFields: accepted.size, rejectedFields: rejected.length, rejectionCodes: [...new Set(rejected)].slice(0, 12), emptyResult: rawFields.length === 0 } };
}

const RELATIONSHIP_DYNAMIC_TEXT = /(?:\b[CU]\s*(?:->|→)\s*[CU]\b|好感|关系阶段|恋爱阶段|暧昧阶段|(?:对|向)\s*(?:U|用户|\{\{user\}\}).{0,24}(?:态度|喜欢|爱慕|恋爱|追求|暧昧|结婚)|(?:想|要|试图|打算).{0,12}(?:追求|恋爱|结婚).{0,12}(?:U|用户|\{\{user\}\}))/iu;
const RELATIONSHIP_ACTION = '(?:好感|态度|喜欢|爱慕|恋爱|追求|暧昧|结婚|表白|爱上|亲密(?:关系)?|关系阶段)';
const TRANSIENT_DYNAMIC_TEXT = /(?:(?:此刻|刚才|刚刚|一时|突然|当下|这一刻|片刻|短暂).{0,18}(?:高兴|开心|愤怒|生气|害怕|恐惧|难过|悲伤|紧张|焦虑|震惊|尴尬|兴奋|沮丧|情绪|心情)|(?:高兴|开心|愤怒|生气|害怕|恐惧|难过|悲伤|紧张|焦虑|震惊|尴尬|兴奋|沮丧).{0,8}(?:一下|片刻|一会儿))/iu;
const UNCERTAIN_SECRET_TEXT = /(?:可能|也许|或许|疑似|似乎|大概|不确定|推测|猜测|speculat|uncertain|\bmaybe\b|\bperhaps\b)/iu;
const STABLE_CHANGE_EVIDENCE = /(?:(?:\d+|[一二三四五六七八九十百]+)年(?:来|以来)?|多年|年来|每次|总是|反复|一直|逐渐|养成|形成.{0,10}习惯|长期|长久|已经改变|已改变|从此|不再|稳定|permanent|long[- ]term|repeated|always|gradually|established|changed for good)/iu;
const GOAL_EVIDENCE = /(?:目标|计划|打算|决定|致力于|试图|正在(?:寻找|追查|修复|完成|保护|守护|逃离|调查)|\bgoal\b|\bplan(?:s|ned)?\b|intend|seek|trying to)/iu;
const SECRET_EVIDENCE = /(?:秘密|隐瞒|瞒着|未公开|保密|无人(?:知道|知晓)|没有人知道|不为人知|(?:从未|未曾).{0,16}(?:告诉|说过|透露)|\bsecret\b|conceal|hidden|never told|no one knows)/iu;

const regexEscape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function isRelationshipDynamicText(text, relationshipNames = []) {
  if (RELATIONSHIP_DYNAMIC_TEXT.test(text)) return true;
  return relationshipNames.some(rawName => {
    const name = normalizeText(rawName);
    if (name.length < 2) return false;
    const escaped = regexEscape(name);
    return new RegExp(`(?:${RELATIONSHIP_ACTION}.{0,18}${escaped}|${escaped}.{0,18}${RELATIONSHIP_ACTION})`, 'iu').test(text);
  });
}

const EXCERPT_PUNCTUATION = new Map([
  [',', '，'], ['，', '，'], [';', '；'], ['；', '；'], [':', '：'], ['：', '：'], ['.', '。'], ['。', '。'],
  ['!', '！'], ['！', '！'], ['?', '？'], ['？', '？'], ['“', '"'], ['”', '"'], ['‘', "'"], ['’', "'"], ['—', '-'], ['–', '-'],
]);
function normalizeExcerpt(value) {
  return normalizeText(value).normalize('NFKC').toLocaleLowerCase()
    .replace(/\s+/gu, ' ')
    .replace(/\s*([,，;；:：.。!?！？“”‘’—–])\s*/gu, mark => EXCERPT_PUNCTUATION.get(mark.trim()) || mark.trim())
    .trim();
}

function supportingExcerptSources(text, contents) {
  const excerpt = normalizeExcerpt(text);
  if (!excerpt) return [];
  return contents.filter(content => normalizeExcerpt(content).includes(excerpt));
}

export function validateDynamicInfoResult(response, { sources, relationshipNames = [] } = {}) {
  const value = unwrapResult(response);
  if (stableJson(value).length > DYNAMIC_INFO_LIMITS.maxOutputChars) throw fail('failed_retryable', '动态状态输出超过保存预算');
  const rawFields = value.fields === undefined ? [] : value.fields;
  if (!Array.isArray(rawFields)) throw fail('failed_retryable', '动态状态 fields 外壳无效');
  const evidence = new Map(); let authorIndex = 0, historyIndex = 0, memoryIndex = 0;
  for (const source of sources || []) {
    const code = source?.kind === 'memory' ? `M${++memoryIndex}` : source?.kind === 'chat' ? `H${++historyIndex}` : `A${++authorIndex}`;
    evidence.set(code, { ref: { kind: source.kind, locator: source.locator, fingerprint: source.fingerprint }, content: normalizeText(source.content) });
  }
  const accepted = new Map(), rejected = [];
  for (const raw of rawFields.slice(0, DYNAMIC_INFO_LIMITS.maxItems)) {
    if (!object(raw)) { rejected.push('item_not_object'); continue; }
    if (stableJson(raw).length > DYNAMIC_INFO_LIMITS.maxFieldChars * 4) { rejected.push('item_too_large'); continue; }
    if (Object.keys(raw).some(key => !['field', 'text', 'evidence'].includes(key))) { rejected.push('unknown_property'); continue; }
    const field = normalizeDynamicField(raw.field);
    if (!field || !DYNAMIC_FIELD_KEYS.includes(field)) { rejected.push('unknown_field'); continue; }
    const text = normalizeText(raw.text);
    if (!text || text.length > DYNAMIC_INFO_LIMITS.maxFieldChars) { rejected.push('invalid_text'); continue; }
    const codes = normalizeEvidence(raw.evidence);
    if (!codes) { rejected.push('invalid_evidence'); continue; }
    if (!codes.length || codes.some(code => !evidence.has(code))) { rejected.push('unknown_evidence'); continue; }
    if (isRelationshipDynamicText(text, relationshipNames)) { rejected.push('relationship_scope'); continue; }
    if (TRANSIENT_DYNAMIC_TEXT.test(text)) { rejected.push('transient_state'); continue; }
    if (field === 'currentSecrets' && UNCERTAIN_SECRET_TEXT.test(text)) { rejected.push('uncertain_secret'); continue; }
    const contents = codes.map(code => evidence.get(code).content);
    const supportingSources = supportingExcerptSources(text, contents);
    if (!supportingSources.length) { rejected.push('evidence_mismatch'); continue; }
    const normalizedExcerpt = normalizeExcerpt(text);
    if (field === 'currentGoals' && !GOAL_EVIDENCE.test(normalizedExcerpt)) { rejected.push('evidence_mismatch'); continue; }
    if (field === 'currentSecrets' && !SECRET_EVIDENCE.test(normalizedExcerpt)) { rejected.push('evidence_mismatch'); continue; }
    if (field === 'stableChanges' && !STABLE_CHANGE_EVIDENCE.test(normalizedExcerpt)) { rejected.push('insufficient_stability'); continue; }
    if (accepted.has(field)) { rejected.push('duplicate_field'); continue; }
    const sourceRefs = codes.map(code => clone(evidence.get(code).ref));
    accepted.set(field, { value: text, provenance: codes.some(code => code.startsWith('H') || code.startsWith('M')) ? 'ai' : 'source', sourceRefs });
  }
  if (rawFields.length > DYNAMIC_INFO_LIMITS.maxItems) rejected.push('item_limit');
  return { fields: Object.fromEntries(accepted), diagnostics: { acceptedFields: accepted.size, rejectedFields: rejected.length, rejectionCodes: [...new Set(rejected)].slice(0, 12), emptyResult: rawFields.length === 0 } };
}

function unwrapResult(response) {
  let value = response;
  if (typeof value === 'string') value = parseJsonOutput(value);
  if (object(value) && Object.hasOwn(value, 'jsonData')) value = value.jsonData;
  if (typeof value === 'string') value = parseJsonOutput(value);
  if (!object(value)) throw relationFailure('relation_schema', '关系生成结果结构无效');
  return value;
}

function validateRef(raw, whitelist) {
  if (!object(raw) || Object.keys(raw).some(key => !['kind', 'locator', 'fingerprint', 'anchor'].includes(key))) throw relationFailure('relation_schema', '关系来源引用字段越权');
  const ref = { kind: String(raw.kind ?? '').trim(), locator: String(raw.locator ?? '').trim(), fingerprint: String(raw.fingerprint ?? '').trim(), anchor: normalizeText(raw.anchor) };
  if (!REF_KINDS.has(ref.kind) || !ref.locator || !/^sha256:[0-9a-f]{64}$/.test(ref.fingerprint) || !ref.anchor || ref.anchor.length > 500) throw relationFailure('relation_schema', '关系来源引用无效');
  const source = whitelist.get(refLocator(ref));
  if (!source || !source.content.includes(ref.anchor)) throw relationFailure('relation_semantic', '关系来源锚点不在白名单');
  return ref;
}

function validateItem(raw, layer, identities, whitelist) {
  if (!object(raw)) throw relationFailure('relation_schema', '关系项目不是对象');
  const allowed = new Set(['value', 'relationToIdentityId', 'confidence', 'sourceRefs', ...(layer === 'pendingReview' ? ['proposedLayer', 'reason'] : [])]);
  if (Object.keys(raw).some(key => !allowed.has(key))) throw relationFailure('relation_schema', '关系项目包含系统或未知字段');
  const value = normalizeText(raw.value), confidence = Number(raw.confidence);
  if (!value || value.length > INITIAL_RELATION_LIMITS.maxItemChars || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw relationFailure('relation_schema', '关系项目内容或置信度无效');
  const relationToIdentityId = raw.relationToIdentityId == null || raw.relationToIdentityId === '' ? null : String(raw.relationToIdentityId);
  if (relationToIdentityId && !identities.has(relationToIdentityId)) throw relationFailure('relation_semantic', '关系项目引用未知身份');
  if (!Array.isArray(raw.sourceRefs) || raw.sourceRefs.length < 1 || raw.sourceRefs.length > 12) throw relationFailure('relation_schema', '关系项目缺少来源');
  const sourceRefs = raw.sourceRefs.map(ref => validateRef(ref, whitelist));
  if (layer === 'sourceFacts' && sourceRefs.some(ref => ref.kind === 'chat')) throw relationFailure('relation_semantic', '聊天归纳不能写入 sourceFacts');
  if (layer === 'interpretations' && !sourceRefs.some(ref => ref.kind === 'chat')) throw relationFailure('relation_semantic', 'interpretations 必须有稳定聊天证据');
  const output = { value, ...(relationToIdentityId ? { relationToIdentityId } : {}), confidence, sourceRefs };
  if (layer === 'pendingReview') {
    const proposedLayer = String(raw.proposedLayer ?? '').trim(), reason = normalizeText(raw.reason);
    if (!['sourceFacts', 'interpretations'].includes(proposedLayer) || !reason || reason.length > 800) throw relationFailure('relation_schema', '待确认项目字段无效');
    output.proposedLayer = proposedLayer; output.reason = reason;
  }
  return output;
}

export function validateInitialRelationResult(response, { targetIdentityIds, allIdentityIds, sources } = {}) {
  const value = unwrapResult(response);
  if (stableJson(value).length > INITIAL_RELATION_LIMITS.maxOutputChars) throw relationFailure('relation_schema', '关系输出超过保存预算');
  const rawItems = value.items === undefined ? [] : value.items;
  if (!Array.isArray(rawItems)) throw relationFailure('relation_schema', '关系 items 外壳无效');
  const ids = Array.isArray(allIdentityIds) ? allIdentityIds : [];
  const personEntries = ids.map((identityId, index) => [index === 0 ? 'U' : `C${index}`, identityId]);
  const people = new Map(personEntries), targets = new Set(targetIdentityIds || []), targetCodes = new Set(personEntries.filter(([, identityId]) => targets.has(identityId)).map(([code]) => code));
  const evidence = new Map(); let authorIndex = 0, historyIndex = 0;
  for (const source of sources || []) {
    const code = source?.kind === 'chat' ? `H${++historyIndex}` : `A${++authorIndex}`;
    evidence.set(code, { kind: source.kind, locator: source.locator, fingerprint: source.fingerprint });
  }
  const patches = new Map([...targets].map(identityId => [identityId, { identityId, sourceFacts: [], interpretations: [], pendingReview: [] }]));
  const diagnostics = { acceptedItems: 0, rejectedItems: 0, rejectionCodes: [], emptyResult: rawItems.length === 0 };
  const rejected = code => { diagnostics.rejectedItems += 1; if (REJECTION_CODES.has(code) && !diagnostics.rejectionCodes.includes(code)) diagnostics.rejectionCodes.push(code); };
  const seen = new Set();
  const limit = Math.min(rawItems.length, INITIAL_RELATION_LIMITS.maxItems);
  if (rawItems.length > limit) { diagnostics.rejectedItems += rawItems.length - limit; diagnostics.rejectionCodes.push('item_limit'); }
  for (const raw of rawItems.slice(0, limit)) {
    if (!object(raw)) { rejected('item_not_object'); continue; }
    if (stableJson(raw).length > INITIAL_RELATION_LIMITS.maxItemChars * 4) { rejected('item_too_large'); continue; }
    if (Object.keys(raw).some(key => FORBIDDEN_AI_ITEM_KEYS.has(String(key).replace(/[_-]/g, '').toLowerCase()))) { rejected('forbidden_field'); continue; }
    const person = String(raw.person ?? '').trim().toUpperCase();
    if (!people.has(person) || !targetCodes.has(person)) { rejected('unknown_person'); continue; }
    const typeKey = String(raw.type ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_'), type = TYPE_ALIASES.get(typeKey);
    if (!type) { rejected('unknown_type'); continue; }
    const text = normalizeText(raw.text);
    if (!text || text.length > INITIAL_RELATION_LIMITS.maxItemChars) { rejected('invalid_text'); continue; }
    const codes = normalizeEvidence(raw.evidence);
    if (!codes) { rejected('invalid_evidence'); continue; }
    if (!codes.length || codes.some(code => !evidence.has(code))) { rejected('unknown_evidence'); continue; }
    if ((type === 'source_fact' && codes.some(code => !code.startsWith('A'))) || (type === 'interpretation' && !codes.some(code => code.startsWith('H')))) { rejected('evidence_policy'); continue; }
    const relatedCode = raw.relatedTo === undefined || raw.relatedTo === null || raw.relatedTo === '' ? '' : String(raw.relatedTo).trim().toUpperCase();
    if (relatedCode && !people.has(relatedCode)) { rejected('unknown_related'); continue; }
    const sourceRefs = codes.map(code => clone(evidence.get(code)));
    const layer = type === 'source_fact' ? 'sourceFacts' : type === 'interpretation' ? 'interpretations' : 'pendingReview';
    const normalized = {
      value: text,
      ...(relatedCode ? { relationToIdentityId: people.get(relatedCode) } : {}),
      sourceRefs,
      ...(type === 'review' ? { proposedLayer: codes.some(code => code.startsWith('H')) ? 'interpretations' : 'sourceFacts', reason: 'AI 标记为待确认' } : {}),
    };
    const key = `${people.get(person)}\u0000${layer}\u0000${stableJson(normalized)}`;
    if (seen.has(key)) { rejected('duplicate'); continue; }
    seen.add(key); patches.get(people.get(person))[layer].push(normalized); diagnostics.acceptedItems += 1;
  }
  diagnostics.rejectionCodes = safeRejectionCodes(diagnostics.rejectionCodes);
  if (rawItems.length > 0 && diagnostics.acceptedItems === 0) {
    const error = relationFailure('relation_semantic', '关系输出没有可安全采用的项目');
    error.code = 'no_valid_items'; error.itemDiagnostics = diagnostics; throw error;
  }
  return { schemaVersion: 2, patches: [...patches.values()], itemDiagnostics: diagnostics };
}

function currentCharacter(ctx) {
  return Array.isArray(ctx?.characters) ? ctx.characters[ctx.characterId] : ctx?.characters?.[ctx.characterId];
}

async function authorSources(ctx, state, meta, routeSource) {
  const character = currentCharacter(ctx) || {}, card = character.data || character;
  const fields = ['description', 'personality', 'scenario', 'mes_example', 'system_prompt', 'post_history_instructions', 'creator_notes'];
  const sources = [];
  for (const field of fields) {
    const content = normalizeText(card[field] ?? character[field]);
    if (content) sources.push({ kind: 'card', locator: `card:${state.characterAvatar}#${field}`, fingerprint: await digest(content), content });
  }
  const settings = ctx?.powerUserSettings || {}, descriptor = settings.persona_descriptions?.[state.personaAvatar];
  const personaContent = normalizeText(descriptor?.description ?? settings.persona_description);
  if (personaContent) sources.push({ kind: 'persona', locator: `persona:${state.personaAvatar}#description`, fingerprint: await digest(personaContent), content: personaContent });
  let frozen;
  try { frozen = await routeSource.collectFrozenAnalysisSources(meta.route); }
  catch (error) {
    const blocked = fail('blocked_source_changed', '冻结路线来源当前不可读取');
    const worldbookTotal = meta.route?.worldInfoEntries?.length;
    blocked.sourceDiagnostics = normalizeSourceDiagnostics({ ...emptySourceDiagnostics(), worldbookTotal, worldbookUnreadable: worldbookTotal, codes: [error?.diagnosticCode || 'ROUTE_READ_FAILED'] });
    throw blocked;
  }
  const sourceDiagnostics = normalizeSourceDiagnostics(frozen?.diagnostics || summarizeFrozenSourceDiagnostics(meta.route, frozen));
  if (frozen?.status !== 'ready' || !frozen.sources || (frozen.warnings || []).length) {
    const blocked = fail('blocked_source_changed', '冻结 greeting 或世界书来源已变化'); blocked.sourceDiagnostics = sourceDiagnostics; throw blocked;
  }
  const greeting = frozen.sources.greeting;
  if (typeof greeting?.content === 'string' && greeting.content.trim()) sources.push({ kind: 'greeting', locator: `greeting:${greeting.floor}:swipe:${greeting.swipeId}`, fingerprint: greeting.fingerprint, content: greeting.content });
  for (const entry of frozen.sources.worldInfoEntries || []) if (entry.content) sources.push({ kind: 'worldbook', locator: `worldbook:${entry.world}:${entry.uid}`, fingerprint: entry.fingerprint, content: entry.content });
  return { sources, sourceDiagnostics };
}

async function chatSources(ctx, runtime) {
  const snapshot = await computeStableFloorSnapshot(ctx?.chat);
  if (snapshot.status !== 'ready') throw fail('mismatch', '当前聊天无法形成稳定 Canon');
  const ledger = runtime.data.stableFloorLedger;
  if (!Array.isArray(ledger?.entries) || ledger.entries.length !== snapshot.canon.length
    || ledger.entries.some((entry, index) => entry.signature !== snapshot.canon[index]?.signature)) throw fail('stale', '稳定楼 runtime 与当前聊天不一致');
  const output = [];
  for (const entry of snapshot.canon) {
    const message = ctx.chat[entry.sourceIndex];
    if (message?.is_system || message?.is_hidden || message?.extra?.is_hidden) continue;
    const content = normalizeText(message?.mes);
    if (!content) continue;
    output.push({ kind: 'chat', locator: `chat:${entry.identity}`, fingerprint: entry.contentHash, signature: entry.signature, content });
  }
  return { snapshot, sources: output };
}

function checkEnvelopeData(record, kind, chatId) {
  if (!envelope(record) || record.data.kind !== kind || record.data.chatId !== chatId) throw fail('mismatch', `${kind} 记录与当前聊天不一致`);
  if (Number.isInteger(record.data.schemaVersion) && record.data.schemaVersion > 1) throw fail('future_schema_readonly', `${kind} 来自未来版本`);
}

function completedIds(initialGeneration) {
  return new Set(Array.isArray(initialGeneration?.completedMemberIds) ? initialGeneration.completedMemberIds.filter(isUuid) : []);
}

function promptFor(plan, retry = false) {
  let characterIndex = 0, authorIndex = 0, historyIndex = 0;
  const people = plan.members.map(item => ({ code: item.subject === 'user' ? 'U' : `C${++characterIndex}`, identityId: item.identityId, displayName: item.displayName || '(unnamed)' }));
  const identities = people.map(item => `${item.code} | ${item.displayName}`).join('\n');
  const targetSet = new Set(plan.targetIdentityIds), targets = people.filter(item => targetSet.has(item.identityId)).map(item => item.code).join(', ') || '(none)';
  const sources = plan.sources.map(source => {
    const code = source.kind === 'chat' ? `H${++historyIndex}` : `A${++authorIndex}`;
    return `[${code}] type=${source.kind}\n${source.content}`;
  }).join('\n\n');
  return [
    '返回 {"items":[...]}。每条只写 person、type、text、evidence，可选 relatedTo。一个内容一个 item；不要求覆盖每个目标。',
    'evidence 必须是数组，例如 "evidence":["A8"]；多来源写成 "evidence":["A2","A4"]。',
    'type 只用 source_fact、interpretation、review。source_fact 只引用 A；interpretation 至少引用一个 H；不确定内容用 review。',
    '只复制 U/C 与 A/H 短代号。不要输出 UUID、locator、fingerprint、anchor、confidence、sourceRefs 或任何存储字段。没有可靠内容时返回 {"items":[]}。',
    ...(retry ? ['上一次没有得到可安全采用的 item。只修正 JSON、人物代号、类型和证据代号，不得新增来源。'] : []),
    `人物代号：\n${identities}`,
    `本次目标：${targets}`,
    `证据表：\n${sources}`,
  ].join('\n\n');
}

function basicInfoPrompt(plan, target, sources) {
  let authorIndex = 0, historyIndex = 0;
  const evidence = sources.map(source => {
    const code = source.kind === 'chat' ? `H${++historyIndex}` : `A${++authorIndex}`;
    return `[${code}] type=${source.kind}\n${source.content}`;
  }).join('\n\n');
  return [
    '返回 {"fields":[...]}。每条只写 field、text、evidence；同一 field 最多一条。',
    'evidence 必须是数组，例如 "evidence":["A8"]；多来源写成 "evidence":["A2","A4"]。',
    `field 只允许：${BASIC_FIELD_KEYS.join('、')}。`,
    '只提取明确且稳定的角色基础信息。没有证据的字段不要返回；不要猜测，不要用“未知”“未提及”等占位。',
    '允许不增加事实的合理分类、同义栏目映射和简洁整理。明确映射：skills / abilities / 能力 / 技能 / 专长 / 明确擅长 → abilities；likes / preferences / 喜好 / 爱好 / 明确偏爱 → likes；dislikes / aversions / 厌恶 / 雷点 / 明确不喜欢 → dislikes；values_and_drives / values / principles / 原则 / 价值观 / 稳定驱动力 → principles；relationships / family / connections / 人际关系 / 亲属关系 / 稳定社会关系 → relationships。',
    '例：来源明确“武艺剑术、赌场博戏”可归入 abilities，但“舞过一次剑”不得扩成精通所有兵器；来源明确“likes: 甜食”可归入 likes，但一次吃甜食不得推断长期嗜甜。',
    '不得从常识、外貌、语气或一次行为推测能力、喜好、厌恶或原则。',
    'relationships 只记录来源明确且相对稳定的亲属、朋友、同僚、上下级或所属势力等，例如“郑柠：亲生妹妹”“U：自幼相识的至交”；不得写当前好感、情绪、暧昧/关系阶段或临时矛盾。',
    '不要写关系阶段、好感、角色对 U 的当前态度。只使用 A/H 短代号，不要输出 UUID、locator、fingerprint 或存储字段。',
    `目标 C：${target.displayName || '(unnamed)'}`,
    `证据表：\n${evidence}`,
  ].join('\n\n');
}

function dynamicInfoPrompt(target, sources) {
  let historyIndex = 0, memoryIndex = 0;
  const evidence = sources.map(source => {
    const code = source.kind === 'memory' ? `M${++memoryIndex}` : `H${++historyIndex}`;
    return `[${code}] type=${source.kind}\n${source.content}`;
  }).join('\n\n');
  return [
    '返回 {"fields":[...]}。每条只写 field、text、evidence；同一 field 最多一条。',
    'evidence 必须是数组，例如 "evidence":["M1"]；多来源写成 "evidence":["M1","H2"]。',
    'M 是柏宝书压缩历史，H 是当前 Canon 中的近期精确正文；H 按时间从旧到新编号。M 与 H 冲突时优先信任更新的 H，不得把压缩摘要扩写成新事实。',
    `field 只允许：${DYNAMIC_FIELD_KEYS.join('、')}。`,
    '固定映射：personality_state / current_personality / 当前性格状态 → personalityState；goals / current_goals / 当前目标 → currentGoals；situation / predicament / 当前处境 → currentSituation；secrets / current_secrets / 当前秘密 → currentSecrets；wellbeing / physical_mental_state / 当前身心状态 → wellbeing；stable_changes / long_term_changes / 长期稳定变化 → stableChanges。',
    '只整理目标 C 目前仍成立的个人状态。text 必须复制某一条所引证据里的最短但语义完整的连续原文片段；禁止改写、概括、替换关键对象或跨来源拼接。资料不足就不返回该字段，不写“未知”“未提及”等占位。',
    'personalityState 写基础性格在当前阶段的表现或尚未稳定的偏移；currentGoals 写正在追求的个人或剧情目标；currentSituation 写现实压力、困局、环境或立场处境；currentSecrets 只写来源明确且仍未公开/仍在隐瞒的秘密；wellbeing 写持续的伤病、精神压力或能力受限；stableChanges 只写反复出现、长期形成或来源明确宣告已经稳定的改变。',
    '不得把一次行为扩成 stableChanges；不得把可能、猜测或不确定推断写成 currentSecrets。',
    '排除瞬时情绪、当前事件流水、普通世界事件、装备资产清单和无关 NPC 记忆。',
    '严格排除 C→U / U→C 的态度、好感、恋爱或关系目标、暧昧与关系阶段，即使来源出现也不要写入任何动态字段。',
    '只使用 M/H 短代号，不要输出 UUID、locator、fingerprint、writerId、operationId 或其他存储字段。',
    `目标 C：${target.displayName || '(unnamed)'}`,
    `证据表：\n${evidence}`,
  ].join('\n\n');
}

function basicSourceLocator(kind, locator) {
  const value = String(locator ?? '').trim();
  return kind === 'worldbook' && value.startsWith('worldbook:') ? value.slice('worldbook:'.length) : value;
}

function basicSourceMatchesRef(source, ref) {
  if (!object(source) || !object(ref) || source.kind !== ref.kind) return false;
  const sourceLocator = basicSourceLocator(source.kind, source.locator), refLocator = basicSourceLocator(ref.kind, ref.locator);
  if (!sourceLocator || !refLocator) return false;
  if (sourceLocator === refLocator) return true;
  if (source.kind !== 'greeting') return false;
  const expanded = sourceLocator.match(/^greeting:(\d+):swipe:(\d+)$/), compact = refLocator.match(/^greeting:(\d+):(\d+)$/);
  return Boolean(expanded && compact && expanded[1] === compact[1] && expanded[2] === compact[2]);
}

function basicTargetText(source, target) {
  const content = normalizeText(source?.content);
  if (!content) return false;
  return [target?.displayName, target?.sourceAnchor].map(normalizeText).filter(Boolean).some(value => content.includes(value));
}

function basicInfoSources(plan, target, ctx) {
  const refs = [target?.primarySourceRef, ...(Array.isArray(target?.sourceRefs) ? target.sourceRefs : [])].filter(object);
  const bound = source => refs.some(ref => basicSourceMatchesRef(source, ref));
  const character = currentCharacter(ctx) || {}, card = character.data || character;
  const currentName = normalizeText(card.name ?? character.name ?? ctx?.name2);
  const targetIsCurrentCharacter = Boolean(currentName && currentName === normalizeText(target?.displayName));
  const simulator = plan.meta?.data?.cardType === 'simulator';
  return plan.sources.filter(source => {
    if (source.kind === 'persona') return false;
    if (source.kind === 'card') return !simulator && (targetIsCurrentCharacter || bound(source));
    if (source.kind === 'greeting') return bound(source);
    if (source.kind === 'worldbook') return bound(source) || basicTargetText(source, target);
    if (source.kind === 'chat') return basicTargetText(source, target);
    return false;
  });
}

async function dynamicMemorySnapshot(memorySource) {
  const text = normalizeText(memorySource?.readRelativeText?.());
  return { text, fingerprint: await digest(text) };
}

async function dynamicInfoSources(plan, target, memorySnapshot) {
  const sources = [];
  if (memorySnapshot.text && basicTargetText({ content: memorySnapshot.text }, target)) sources.push({
    kind: 'memory', locator: 'baibai-book:injected-history:relativeText', fingerprint: memorySnapshot.fingerprint, content: memorySnapshot.text,
  });
  for (const source of plan.sources) if (source.kind === 'chat' && basicTargetText(source, target)) sources.push(source);
  return sources;
}

async function materializePatch(patch, operationId, baselineDigest) {
  const output = { identityId: patch.identityId, sourceFacts: [], interpretations: [], pendingReview: [] };
  for (const layer of PROFILE_LISTS) for (const raw of patch[layer]) {
    const hash = await sha256(`${operationId}\u0000${patch.identityId}\u0000${layer}\u0000${stableJson(raw)}`);
    output[layer].push({
      id: `qqj-initial-v1:${hash}`, ...clone(raw), writerId: INITIAL_RELATION_WRITER_ID, operationId, baselineDigest,
      provenance: layer === 'sourceFacts' ? 'source' : 'ai', state: layer === 'pendingReview' ? 'pending_review' : 'canon',
    });
  }
  return output;
}

async function validateRecoveryDraft(draft, plan) {
  const outerKeys = ['baseline', 'draftVersion', 'operationId', 'operationVersion', 'patches', 'schemaVersion'];
  const draftVersion = draft?.draftVersion;
  if (!object(draft) || Object.keys(draft).sort().join(',') !== outerKeys.sort().join(',') || draft.schemaVersion !== 1 || ![1, 2].includes(draftVersion) || draft.operationVersion !== draftVersion
    || !isUuid(draft.operationId) || draft.operationId !== plan.initialGeneration?.operationId || stableJson(draft).length > INITIAL_RELATION_LIMITS.maxDraftChars) throw fail('mismatch', '首次生成 recovery draft 外壳无效');
  const baseline = draft.baseline;
  const baselineKeys = ['cardId', 'canonDigest', 'chatId', 'digest', 'host', 'memberIds', 'personaId', 'revisions', 'routeDigest', 'schemaVersion', 'sourceDigest', 'targetIdentityIds'];
  if (!object(baseline) || Object.keys(baseline).sort().join(',') !== baselineKeys.sort().join(',') || baseline.schemaVersion !== 1 || !/^sha256:[0-9a-f]{64}$/.test(baseline.digest)
    || baseline.digest !== plan.initialGeneration?.baseline?.digest || !same(baseline, plan.initialGeneration.baseline)) throw fail('mismatch', '首次生成 recovery baseline 绑定无效');
  const baselineBody = clone(baseline); delete baselineBody.digest;
  if (await digest(baselineBody) !== baseline.digest) throw fail('mismatch', '首次生成 recovery baseline 已被篡改');
  const memberIds = plan.members.map(item => item.identityId), profileIds = plan.members.filter(item => item.subject === 'character').map(item => item.identityId), targetIds = plan.targetIdentityIds;
  if (!same(baseline.memberIds, memberIds) || !same(baseline.targetIdentityIds, targetIds) || baseline.chatId !== plan.baseline.chatId || baseline.cardId !== plan.baseline.cardId || baseline.personaId !== plan.baseline.personaId
    || !object(baseline.revisions) || Object.keys(baseline.revisions).sort().join(',') !== 'index,meta,profiles,runtime'
    || !object(baseline.revisions.profiles) || !['meta', 'index', 'runtime'].every(key => Number.isInteger(baseline.revisions[key]) && baseline.revisions[key] > 0)
    || Object.keys(baseline.revisions.profiles).some(identityId => !profileIds.includes(identityId) || !Number.isInteger(baseline.revisions.profiles[identityId]) || baseline.revisions.profiles[identityId] < 1)
    || Object.keys(baseline.revisions.profiles).length !== profileIds.length
    || !['routeDigest', 'canonDigest', 'sourceDigest'].every(key => /^sha256:[0-9a-f]{64}$/.test(baseline[key]))
    || !Array.isArray(baseline.memberIds) || !Array.isArray(baseline.targetIdentityIds) || new Set(baseline.memberIds).size !== baseline.memberIds.length || new Set(baseline.targetIdentityIds).size !== baseline.targetIdentityIds.length) throw fail('mismatch', '首次生成 recovery baseline 身份或版本无效');
  const targets = new Set(targetIds), identities = new Set(memberIds), whitelist = new Map(plan.sources.map(source => [refLocator(source), source]));
  if (!Array.isArray(draft.patches) || draft.patches.length !== targets.size) throw fail('mismatch', '首次生成 recovery patch 数量无效');
  const seenIdentities = new Set(), seenItems = new Map(); let itemCount = 0;
  for (const patch of draft.patches) {
    if (!object(patch) || Object.keys(patch).sort().join(',') !== ['identityId', ...PROFILE_LISTS].sort().join(',') || !targets.has(patch.identityId) || seenIdentities.has(patch.identityId)) throw fail('mismatch', '首次生成 recovery patch 身份无效');
    seenIdentities.add(patch.identityId);
    for (const layer of PROFILE_LISTS) {
      if (!Array.isArray(patch[layer])) throw fail('mismatch', '首次生成 recovery patch 分层无效');
      for (const item of patch[layer]) {
        const rawKeys = ['value', ...(draftVersion === 1 ? ['confidence'] : []), 'sourceRefs', ...(item?.relationToIdentityId === undefined ? [] : ['relationToIdentityId']), ...(layer === 'pendingReview' ? ['proposedLayer', 'reason'] : [])];
        const systemKeys = ['id', 'writerId', 'operationId', 'baselineDigest', 'provenance', 'state'];
        if (!object(item) || Object.keys(item).sort().join(',') !== [...rawKeys, ...systemKeys].sort().join(',')) throw fail('mismatch', '首次生成 recovery item 字段越权');
        const raw = Object.fromEntries(rawKeys.map(key => [key, clone(item[key])]));
        let normalized;
        if (draftVersion === 1) {
          try { normalized = validateItem(raw, layer, identities, whitelist); }
          catch { throw fail('mismatch', '首次生成 recovery item 来源或语义无效'); }
        } else {
          const value = normalizeText(raw.value), relationToIdentityId = raw.relationToIdentityId;
          if (!value || value.length > INITIAL_RELATION_LIMITS.maxItemChars || relationToIdentityId !== undefined && !identities.has(relationToIdentityId)
            || !Array.isArray(raw.sourceRefs) || raw.sourceRefs.length < 1 || raw.sourceRefs.length > 12) throw fail('mismatch', '首次生成 recovery v2 item 内容无效');
          const sourceRefs = raw.sourceRefs.map(ref => {
            if (!object(ref) || Object.keys(ref).sort().join(',') !== 'fingerprint,kind,locator' || !REF_KINDS.has(ref.kind)
              || typeof ref.locator !== 'string' || !ref.locator || !/^sha256:[0-9a-f]{64}$/.test(ref.fingerprint) || !whitelist.has(refLocator(ref))) throw fail('mismatch', '首次生成 recovery v2 证据无效');
            return { kind: ref.kind, locator: ref.locator, fingerprint: ref.fingerprint };
          });
          if (layer === 'sourceFacts' && sourceRefs.some(ref => ref.kind === 'chat') || layer === 'interpretations' && !sourceRefs.some(ref => ref.kind === 'chat')) throw fail('mismatch', '首次生成 recovery v2 分层证据无效');
          normalized = { value, ...(relationToIdentityId ? { relationToIdentityId } : {}), sourceRefs };
          if (layer === 'pendingReview') {
            if (!['sourceFacts', 'interpretations'].includes(raw.proposedLayer) || raw.reason !== 'AI 标记为待确认') throw fail('mismatch', '首次生成 recovery v2 review 无效');
            normalized.proposedLayer = raw.proposedLayer; normalized.reason = raw.reason;
          }
        }
        const expectedHash = await sha256(`${draft.operationId}\u0000${patch.identityId}\u0000${layer}\u0000${stableJson(normalized)}`);
        const expected = {
          id: `qqj-initial-v1:${expectedHash}`, ...normalized, writerId: INITIAL_RELATION_WRITER_ID, operationId: draft.operationId, baselineDigest: baseline.digest,
          provenance: layer === 'sourceFacts' ? 'source' : 'ai', state: layer === 'pendingReview' ? 'pending_review' : 'canon',
        };
        if (!same(item, expected)) throw fail('mismatch', '首次生成 recovery item 系统所有权无效');
        const prior = seenItems.get(item.id);
        if (prior) throw fail('mismatch', same(prior, item) ? '首次生成 recovery item 重复' : '首次生成 recovery item 冲突');
        seenItems.set(item.id, item); itemCount += 1;
      }
    }
  }
  if (itemCount > INITIAL_RELATION_LIMITS.maxItems || seenIdentities.size !== targets.size) throw fail('mismatch', '首次生成 recovery draft 超出项目预算');
  return draft;
}

export function createInitialRelationGenerationAdapter({ client, contextProvider, routeSource, generateRelationTask, memorySource, isEnabled = () => true } = {}) {
  if (!client?.get || !client?.put || typeof contextProvider !== 'function' || !routeSource?.collectFrozenAnalysisSources || typeof generateRelationTask !== 'function') throw new Error('首次关系生成依赖不可用');
  let generation = 0, invalidationEpoch = 0, serial = Promise.resolve(), activeController = null;
  const cache = new Map();
  const stateView = record => ({ ...(object(record?.data?.initialGeneration) ? clone(record.data.initialGeneration) : { schemaVersion: 1, status: 'uninitialized', completedMemberIds: [] }), ...(object(record?.data?.lastAttempt) ? { lastAttempt: clone(record.data.lastAttempt) } : {}) });
  const hostFingerprint = state => state.ok ? `${state.hostChatId}|${state.chatId}|${state.characterAvatar}|${state.personaAvatar}` : 'invalid';
  const snapshot = () => {
    const ctx = contextProvider();
    const characterId = ctx?.characterId, character = Array.isArray(ctx?.characters) ? ctx.characters[characterId] : ctx?.characters?.[characterId];
    const metadata = ctx?.chatMetadata?.qianqianjie;
    const state = { ok: !ctx?.groupId && characterId !== undefined && characterId !== null && Boolean(character?.avatar) && Boolean(ctx?.userAvatar || ctx?.personaAvatar) && metadata?.schemaVersion === 1 && isUuid(metadata?.chatId), hostChatId: String(ctx?.chatId ?? ctx?.getCurrentChatId?.() ?? ''), chatId: metadata?.chatId || null, characterAvatar: String(character?.avatar ?? ''), personaAvatar: String(ctx?.userAvatar ?? ctx?.personaAvatar ?? '') };
    return { ctx, state, fingerprint: hostFingerprint(state) };
  };
  const check = run => {
    const now = snapshot();
    if (!isEnabled() || run.token !== generation || !run.state.ok || now.fingerprint !== run.fingerprint) throw stale();
  };
  const read = async (run, collection, recordId, optional = false) => {
    try { const value = await client.get(collection, recordId); check(run); return value; }
    catch (error) { if (optional && error.status === 404) { check(run); return null; } throw error; }
  };
  const write = async (run, collection, recordId, data, revision) => {
    check(run); const value = await client.put(collection, recordId, data, revision); check(run);
    if (!envelope(value)) throw fail('storage_error', '后端写入响应无效');
    return value;
  };

  async function loadPlan(run) {
    if (!run.state.ok) throw fail('mismatch', '当前 chat/card/Persona 绑定无效');
    const collection = chatCollection(run.state.chatId);
    const [meta, index, stateRecord, runtime] = await Promise.all([
      read(run, collection, 'meta'), read(run, collection, 'people-index'), read(run, collection, 'people-state'), read(run, collection, 'runtime'),
    ]);
    checkEnvelopeData(meta, 'chat-profile', run.state.chatId); checkEnvelopeData(index, 'people-index', run.state.chatId);
    checkEnvelopeData(stateRecord, 'people-foundation-state', run.state.chatId); checkEnvelopeData(runtime, 'stable-floor-runtime', run.state.chatId);
    if (Number(index.data.contractVersion || 1) > 3 || Number(stateRecord.data.contractVersion || 1) > 1) throw fail('future_schema_readonly', '人物池或千人状态来自未来版本');
    if (meta.data.source?.card?.locator !== run.state.characterAvatar || meta.data.source?.persona?.locator !== run.state.personaAvatar
      || stateRecord.data.cardId !== meta.data.cardId || stateRecord.data.personaId !== meta.data.personaId) throw fail('mismatch', '首次生成 chat/card/Persona 绑定不一致');
    if (meta.data.status !== 'ready' || stateRecord.data.status !== 'ready' || runtime.data.status !== 'ready'
      || meta.data.cardId !== stateRecord.data.cardId || meta.data.personaId !== stateRecord.data.personaId || meta.data.route?.state !== 'ready') throw fail('mismatch', '首次生成依赖尚未 ready');
    const selected = (index.data.confirmed || []).filter(item => selectionStatus(item.selection) === 'selected');
    const members = [{ identityId: meta.data.personaId, subject: 'user', displayName: String(run.ctx?.name1 ?? ''), sourceRefs: [{ kind: 'persona', locator: run.state.personaAvatar }] }, ...selected.map(item => ({
      identityId: item.identityId,
      subject: 'character',
      displayName: item.displayName,
      sourceAnchor: normalizeText(item.sourceAnchor),
      ...(object(item.primarySourceRef) ? { primarySourceRef: clone(item.primarySourceRef) } : {}),
      sourceRefs: Array.isArray(item.sourceRefs) ? clone(item.sourceRefs) : item.primarySourceRef ? [clone(item.primarySourceRef)] : [],
    }))];
    if (members.some(item => !isUuid(item.identityId)) || new Set(members.map(item => item.identityId)).size !== members.length) throw fail('mismatch', '首次生成成员身份无效');
    const characterMembers = members.filter(item => item.subject === 'character');
    const active = new Set((stateRecord.data.activeMemberIds || []).filter(identityId => identityId !== meta.data.personaId)), expectedActive = new Set(characterMembers.map(item => item.identityId));
    const initialized = Array.isArray(stateRecord.data.initializedMembers) ? stateRecord.data.initializedMembers : [];
    if (active.size !== expectedActive.size || [...expectedActive].some(identityId => !active.has(identityId))
      || characterMembers.some(member => !initialized.some(item => item?.identityId === member.identityId && item.subject === 'character' && item.active === true))
      || initialized.some(item => item?.subject === 'character' && (item.active !== true || !expectedActive.has(item.identityId)))) throw fail('mismatch', '人物池与千人骨架成员集合不一致');
    const profiles = new Map();
    for (const member of characterMembers) {
      const record = await read(run, profileCollection(run.state.chatId), member.identityId);
      checkEnvelopeData(record, 'people-profile', run.state.chatId);
      if (record.data.identityId !== member.identityId || record.data.subject !== member.subject || Number(record.data.peopleContractVersion || 1) > 1) throw fail('future_schema_readonly', '人物档案身份或版本不兼容');
      const binding = record.data.sourceBinding;
      const bindingValid = object(binding) && binding.identityId === member.identityId && binding.kind === 'c-registry';
      if (!bindingValid) throw fail('mismatch', '人物档案 sourceBinding 与当前 foundation 不一致');
      profiles.set(member.identityId, record);
    }
    const initialGeneration = object(stateRecord.data.initialGeneration) ? stateRecord.data.initialGeneration : { schemaVersion: 1, status: 'uninitialized', completedMemberIds: [] };
    if (Number(initialGeneration.schemaVersion || 1) > 1) throw fail('future_schema_readonly', '首次生成状态来自未来版本');
    const done = completedIds(initialGeneration), targetIdentityIds = characterMembers.map(item => item.identityId).filter(id => !done.has(id));
    let author;
    try { author = await authorSources(run.ctx, run.state, meta.data, routeSource); check(run); }
    catch (error) {
      if (error.relationStatus === 'blocked_source_changed') return { meta, index, stateRecord, runtime, profiles, members, targetIdentityIds, initialGeneration, sourceDiagnostics: normalizeSourceDiagnostics(error.sourceDiagnostics), canonCount: runtime.data.stableFloorLedger?.entries?.length || 0, blockedStatus: 'blocked_source_changed', blockedError: error.message };
      throw error;
    }
    const chat = await chatSources(run.ctx, runtime); check(run);
    const sources = [...author.sources, ...chat.sources];
    const chars = sources.reduce((sum, source) => sum + source.content.length, 0);
    const oversized = sources.length > INITIAL_RELATION_LIMITS.maxSources || chars > INITIAL_RELATION_LIMITS.maxInputChars || sources.some(source => source.content.length > INITIAL_RELATION_LIMITS.maxSourceChars);
    const sourceDigest = await digest(sources.map(({ content, ...source }) => ({ ...source, contentDigest: null, content: content })));
    const baseline = {
      schemaVersion: 1, host: run.fingerprint, chatId: run.state.chatId, cardId: meta.data.cardId, personaId: meta.data.personaId,
      memberIds: members.map(item => item.identityId), targetIdentityIds, revisions: { meta: meta.revision, index: index.revision, runtime: runtime.revision, profiles: Object.fromEntries([...profiles].map(([id, record]) => [id, record.revision])) },
      routeDigest: await digest(meta.data.route), canonDigest: await digest(runtime.data.stableFloorLedger.entries.map(item => item.signature)), sourceDigest,
    };
    baseline.digest = await digest(baseline);
    return { meta, index, stateRecord, runtime, profiles, members, targetIdentityIds, sources, baseline, oversized, initialGeneration, sourceDiagnostics: author.sourceDiagnostics, canonCount: chat.snapshot.canon.length };
  }

  async function loadSelectedProfile(run, identityId) {
    if (!run.state.ok || !isUuid(identityId)) throw fail('mismatch', '当前 C 身份无效');
    const collection = chatCollection(run.state.chatId);
    const [meta, index, stateRecord] = await Promise.all([
      read(run, collection, 'meta'), read(run, collection, 'people-index'), read(run, collection, 'people-state'),
    ]);
    checkEnvelopeData(meta, 'chat-profile', run.state.chatId); checkEnvelopeData(index, 'people-index', run.state.chatId); checkEnvelopeData(stateRecord, 'people-foundation-state', run.state.chatId);
    if (Number(index.data.contractVersion || 1) > 3 || Number(stateRecord.data.contractVersion || 1) > 1) throw fail('future_schema_readonly', '人物池或千人状态来自未来版本');
    if (meta.data.status !== 'ready' || stateRecord.data.status !== 'ready' || meta.data.cardId !== stateRecord.data.cardId || meta.data.personaId !== stateRecord.data.personaId
      || meta.data.source?.card?.locator !== run.state.characterAvatar || meta.data.source?.persona?.locator !== run.state.personaAvatar) throw fail('mismatch', '当前 C 绑定不一致');
    const selected = (index.data.confirmed || []).filter(item => selectionStatus(item.selection) === 'selected');
    const binding = selected.find(item => item.identityId === identityId);
    if (!binding || !(stateRecord.data.activeMemberIds || []).includes(identityId)
      || !(stateRecord.data.initializedMembers || []).some(item => item?.identityId === identityId && item.subject === 'character' && item.active === true)) throw fail('mismatch', '目标 C 已不再处于选择状态');
    const profile = await read(run, profileCollection(run.state.chatId), identityId);
    checkEnvelopeData(profile, 'people-profile', run.state.chatId);
    if (Number(profile.data.peopleContractVersion || 1) > 1) throw fail('future_schema_readonly', '人物档案来自未来版本');
    if (profile.data.identityId !== identityId || profile.data.subject !== 'character' || profile.data.sourceBinding?.kind !== 'c-registry' || profile.data.sourceBinding?.identityId !== identityId) throw fail('mismatch', '目标 C 档案绑定不一致');
    return { meta, index, stateRecord, binding, profile };
  }

  async function putState(run, record, initialGeneration, lastAttempt) {
    const desired = { ...clone(record.data), initialGeneration, ...(lastAttempt ? { lastAttempt } : {}) };
    try { return await write(run, chatCollection(run.state.chatId), 'people-state', desired, record.revision); }
    catch (error) {
      if (error.status !== 409) throw error;
      const winner = await read(run, chatCollection(run.state.chatId), 'people-state'); checkEnvelopeData(winner, 'people-foundation-state', run.state.chatId);
      if (Number(winner.data.contractVersion || 1) > 1 || Number(winner.data.initialGeneration?.schemaVersion || 1) > 1) throw fail('future_schema_readonly', '首次生成 CAS 胜出者来自未来版本');
      if (same(winner.data.initialGeneration, initialGeneration) && (!lastAttempt || same(winner.data.lastAttempt, lastAttempt))) return winner;
      if (winner.data.initialGeneration?.operationId === initialGeneration.operationId
        && winner.data.initialGeneration?.status === 'ready'
        && winner.data.initialGeneration?.baseline?.digest === initialGeneration.baseline?.digest
        && ['applying', 'ready'].includes(initialGeneration.status)) return winner;
      const sameIdentity = winner.data.cardId === record.data.cardId && winner.data.personaId === record.data.personaId
        && winner.data.source?.card?.locator === record.data.source?.card?.locator && winner.data.source?.persona?.locator === record.data.source?.persona?.locator;
      if (sameIdentity && same(winner.data.initialGeneration, record.data.initialGeneration)) {
        const retry = { ...clone(winner.data), initialGeneration, ...(lastAttempt ? { lastAttempt } : {}) };
        try { return await write(run, chatCollection(run.state.chatId), 'people-state', retry, winner.revision); }
        catch (retryError) { if (retryError.status !== 409) throw retryError; }
      }
      throw fail('conflict', '首次生成状态 CAS 冲突');
    }
  }

  async function mark(run, plan, status, extra = {}, attempt = null, stage = status, errorCode = null) {
    const previous = plan.stateRecord.data.initialGeneration;
    const initialGeneration = { ...(object(previous) ? clone(previous) : {}), schemaVersion: 1, status, ...clone(extra) };
    if (attempt) { attempt.status = status; attempt.stage = stage; attempt.errorCode = errorCode || extra.errorCode || (status === 'ready' ? 'none' : status); }
    const record = await putState(run, plan.stateRecord, initialGeneration, attempt ? attemptRecord(attempt) : null);
    plan.stateRecord = record; plan.initialGeneration = record.data.initialGeneration;
    cache.set(run.state.chatId, stateView(record));
    return record;
  }

  async function persistAttempt(run, plan, attempt, status = attempt.status, stage = attempt.stage, errorCode = attempt.errorCode) {
    attempt.status = status; attempt.stage = stage; attempt.errorCode = errorCode || 'none';
    const desired = { ...clone(plan.stateRecord.data), lastAttempt: attemptRecord(attempt) };
    try {
      const record = await write(run, chatCollection(run.state.chatId), 'people-state', desired, plan.stateRecord.revision);
      plan.stateRecord = record; plan.initialGeneration = record.data.initialGeneration; cache.set(run.state.chatId, stateView(record)); return true;
    } catch (error) {
      if (error.status === 409) {
        try {
          const winner = await read(run, chatCollection(run.state.chatId), 'people-state'); checkEnvelopeData(winner, 'people-foundation-state', run.state.chatId);
          plan.stateRecord = winner; plan.initialGeneration = winner.data.initialGeneration;
        } catch { /* diagnostic persistence must not overwrite a winner */ }
      }
      return false;
    }
  }

  async function persistBasicAttempt(run, plan, attempt, status = attempt.status) {
    const desired = { ...clone(plan.stateRecord.data), lastBasicAttempt: basicAttemptRecord(attempt, status) };
    try {
      const record = await write(run, chatCollection(run.state.chatId), 'people-state', desired, plan.stateRecord.revision);
      plan.stateRecord = record;
      return true;
    } catch { return false; }
  }

  async function persistDynamicAttempt(run, plan, attempt, status = attempt.status) {
    const desired = { ...clone(plan.stateRecord.data), lastDynamicAttempt: dynamicAttemptRecord(attempt, status) };
    try {
      const record = await write(run, chatCollection(run.state.chatId), 'people-state', desired, plan.stateRecord.revision);
      plan.stateRecord = record;
      return true;
    } catch { return false; }
  }

  async function assertBaseline(run, expected, { allowProfileRevisionChanges = false } = {}) {
    const current = await loadPlan(run);
    if (current.blockedStatus) {
      const error = fail(current.blockedStatus, current.blockedError || '首次生成来源已变化');
      error.sourceDiagnostics = current.sourceDiagnostics; error.canonCount = current.canonCount; throw error;
    }
    if (current.baseline.digest !== expected.digest) {
      const comparable = value => {
        const copy = clone(value); delete copy.digest;
        if (allowProfileRevisionChanges && object(copy.revisions)) delete copy.revisions.profiles;
        return copy;
      };
      if (!allowProfileRevisionChanges || !same(comparable(current.baseline), comparable(expected))) throw fail('stale', '首次生成 baseline 已变化');
    }
    return current;
  }

  const applyingLinked = (plan, draft) => plan.initialGeneration?.status === 'applying'
    && plan.initialGeneration.operationId === draft.operationId && same(plan.initialGeneration.draft, draft)
    && plan.initialGeneration.baseline?.digest === draft.baseline.digest;

  async function guardApplying(run, draft) {
    const current = await assertBaseline(run, draft.baseline, { allowProfileRevisionChanges: true });
    if (!applyingLinked(current, draft)) throw fail('conflict', '首次生成 applying 状态已被其他操作改变');
    return current;
  }

  async function stopApplying(run, draft, error, trusted, attempt) {
    if (error.stale || error.name === 'AbortError') return;
    const status = ['blocked_source_changed', 'mismatch', 'future_schema_readonly', 'conflict'].includes(error.relationStatus) ? error.relationStatus : 'stale';
    try {
      const stateRecord = await read(run, chatCollection(run.state.chatId), 'people-state');
      checkEnvelopeData(stateRecord, 'people-foundation-state', run.state.chatId);
      const initial = stateRecord.data.initialGeneration;
      if (initial?.status !== 'applying' || initial.operationId !== trusted.operationId || initial.baseline?.digest !== trusted.baselineDigest
        || stateRecord.revision !== trusted.stateRevision || !same(initial.draft, draft)) return;
      const holder = { stateRecord, initialGeneration: initial };
      const corruptDraft = error.corruptDraft === true;
      await mark(run, holder, corruptDraft ? 'mismatch' : status, {
        errorCode: corruptDraft ? 'corrupt_draft' : String(error.relationStatus || status).slice(0, 80), stoppedAt: new Date().toISOString(),
        ...(corruptDraft ? { draft: undefined } : {}),
      }, attempt, 'applying', corruptDraft ? 'corrupt_draft' : error.relationStatus || status);
    } catch { /* a stale identity or CAS winner must not be overwritten */ }
  }

  async function applyDraft(run, plan, attempt) {
    const draft = plan.initialGeneration?.draft;
    const trusted = { operationId: plan.initialGeneration?.operationId, baselineDigest: plan.initialGeneration?.baseline?.digest, stateRevision: plan.stateRecord?.revision };
    try {
      if (!object(draft)) throw fail('mismatch', '首次生成 recovery draft 缺失');
      try { await validateRecoveryDraft(draft, plan); }
      catch (error) { error.corruptDraft = true; throw error; }
      let current = await guardApplying(run, draft);
      for (const patch of draft.patches) {
        current = await guardApplying(run, draft);
        const record = current.profiles.get(patch.identityId);
        if (!record) throw fail('mismatch', 'recovery draft 人物不存在');
        const next = clone(record.data);
        for (const layer of PROFILE_LISTS) {
          const existing = Array.isArray(next[layer]) ? next[layer] : [];
          const byId = new Map(existing.filter(object).map(item => [item.id, item]));
          for (const item of patch[layer] || []) {
            const prior = byId.get(item.id);
            if (prior && !same(prior, item)) throw fail('conflict', '同 operation 项目内容冲突');
            if (!prior) { existing.push(clone(item)); byId.set(item.id, item); }
          }
          next[layer] = existing;
        }
        if (!same(next, record.data)) {
          try { await write(run, profileCollection(run.state.chatId), patch.identityId, next, record.revision); attempt.profileWrites += 1; }
          catch (error) {
            if (error.status !== 409) throw error;
            const winner = await read(run, profileCollection(run.state.chatId), patch.identityId);
            checkEnvelopeData(winner, 'people-profile', run.state.chatId);
            if (Number(winner.data.peopleContractVersion || 1) > 1) throw fail('future_schema_readonly', '人物档案 CAS 胜出者来自未来版本');
            const allPresent = PROFILE_LISTS.every(layer => (patch[layer] || []).every(item => (winner.data[layer] || []).some(candidate => candidate?.id === item.id && same(candidate, item))));
            if (!allPresent) throw fail('conflict', '人物档案 CAS 胜出者与本 operation 不一致');
          }
          current = await guardApplying(run, draft);
        }
      }
      current = await guardApplying(run, draft);
      const done = new Set([...completedIds(current.initialGeneration), ...draft.patches.map(item => item.identityId)]);
      const operationDigest = await digest(draft.patches);
      current = await guardApplying(run, draft);
      await mark(run, current, 'ready', {
        operationId: current.initialGeneration.operationId, baseline: draft.baseline, completedMemberIds: [...done].sort(),
        completedAt: new Date().toISOString(), operationDigest, appliedMemberIds: draft.patches.map(item => item.identityId), draft: undefined,
      }, attempt, 'complete', 'none');
      return { status: 'ready', operationId: current.initialGeneration.operationId, completedMemberIds: [...done].sort(), reusedAi: true };
    } catch (error) {
      if (error.sourceDiagnostics) attempt.sourceDiagnostics = error.sourceDiagnostics;
      if (Number.isInteger(error.canonCount)) attempt.canonCount = error.canonCount;
      if (error.relationStatus) await stopApplying(run, draft, error, trusted, attempt);
      else if (!error.stale && error.name !== 'AbortError') {
        try {
          const stateRecord = await read(run, chatCollection(run.state.chatId), 'people-state');
          checkEnvelopeData(stateRecord, 'people-foundation-state', run.state.chatId);
          if (stateRecord.data.initialGeneration?.status === 'applying' && stateRecord.data.initialGeneration?.operationId === trusted.operationId
            && stateRecord.data.initialGeneration?.baseline?.digest === trusted.baselineDigest && same(stateRecord.data.initialGeneration?.draft, draft)) {
            const holder = { stateRecord, initialGeneration: stateRecord.data.initialGeneration };
            await persistAttempt(run, holder, attempt, 'storage_error', 'applying', 'storage_error');
          }
        } catch { /* diagnostic persistence must not change recovery semantics */ }
      }
      throw error;
    }
  }

  async function startRun(run) {
    const attempt = newAttempt('initial_start');
    let plan = await loadPlan(run);
    attempt.targetCount = plan.targetIdentityIds.length; attempt.canonCount = plan.canonCount; attempt.sourceDiagnostics = plan.sourceDiagnostics;
    if (plan.blockedStatus) {
      await mark(run, plan, plan.blockedStatus, { completedMemberIds: [...completedIds(plan.initialGeneration)], errorCode: plan.blockedStatus }, attempt, 'collecting_sources', plan.blockedStatus);
      return { status: plan.blockedStatus, zeroAi: true };
    }
    if (plan.initialGeneration.status === 'applying') { attempt.action = 'initial_resume'; attempt.operationId = plan.initialGeneration.operationId; attempt.baselineDigest = plan.initialGeneration.baseline?.digest; return applyDraft(run, plan, attempt); }
    if (plan.targetIdentityIds.length === 0) { await persistAttempt(run, plan, attempt, 'ready', 'complete', 'none'); return { status: 'ready', zeroAi: true, completedMemberIds: [...completedIds(plan.initialGeneration)] }; }
    if (plan.oversized) {
      attempt.baselineDigest = plan.baseline.digest;
      await mark(run, plan, 'input_too_large', { baseline: plan.baseline, completedMemberIds: [...completedIds(plan.initialGeneration)] }, attempt, 'validating_input', 'input_too_large');
      return { status: 'input_too_large', zeroAi: true };
    }
    const existing = plan.initialGeneration;
    const operationId = existing.status === 'generating' && existing.baseline?.digest === plan.baseline.digest && isUuid(existing.operationId) ? existing.operationId : newUuid();
    attempt.operationId = operationId; attempt.baselineDigest = plan.baseline.digest;
    if (!(existing.status === 'generating' && existing.operationId === operationId && existing.baseline?.digest === plan.baseline.digest)) {
      await mark(run, plan, 'generating', { operationId, baseline: plan.baseline, completedMemberIds: [...completedIds(existing)], startedAt: new Date().toISOString(), draft: undefined }, attempt, 'generating', 'none');
    }
    activeController = new AbortController();
    let validated;
    try {
      for (let formatAttempt = 0; formatAttempt < 2; formatAttempt += 1) {
        try {
          attempt.acceptedItems = 0; attempt.rejectedItems = 0; attempt.rejectionCodes = []; attempt.emptyResult = false;
          const responsePromise = generateRelationTask({
            includeCharacterCard: false, worldInfoSource: 'none', substituteMacros: false, systemPrompt: INITIAL_RELATION_SYSTEM_PROMPT,
            taskMessages: [{ role: 'user', content: promptFor(plan, formatAttempt === 1) }], jsonSchema: { name: 'qianqianjie_initial_relation_items_v2', value: INITIAL_RELATION_PATCH_SCHEMA, strict: false },
            signal: activeController.signal, maxTokens: INITIAL_RELATION_LIMITS.maxTokens, temperature: 0.1,
          });
          attempt.aiCalled = true;
          await persistAttempt(run, plan, attempt, 'generating', 'ai_called', 'none');
          const response = await responsePromise;
          check(run);
          captureTaskDiagnostics(attempt, response, { resetFormatStage: true });
          try {
            validated = validateInitialRelationResult(response, { targetIdentityIds: plan.targetIdentityIds, allIdentityIds: plan.members.map(item => item.identityId), sources: plan.sources });
            captureItemDiagnostics(attempt, validated);
          }
          catch (error) { captureTaskDiagnostics(attempt, error); captureItemDiagnostics(attempt, error); throw error; }
          break;
        } catch (error) {
          check(run);
          captureTaskDiagnostics(attempt, error);
          captureItemDiagnostics(attempt, error);
          if (!error?.retryableRecognitionFormat || formatAttempt === 1) throw error;
        }
      }
    } catch (error) {
      if (error.stale || error.name === 'AbortError') throw error;
      captureTaskDiagnostics(attempt, error);
      try { await mark(run, plan, 'failed_retryable', { operationId, baseline: plan.baseline, completedMemberIds: [...completedIds(plan.initialGeneration)], errorCode: String(error.code || error.relationStatus || 'generation_failed').slice(0, 80), draft: undefined }, attempt, 'ai_failed', error.code || error.relationStatus || 'generation_failed'); } catch { /* preserve original failure */ }
      throw error.relationStatus ? error : fail('failed_retryable', String(error.message || '关系生成失败'));
    } finally { activeController = null; }
    try { plan = await assertBaseline(run, plan.baseline); }
    catch (error) {
      if (['stale', 'blocked_source_changed'].includes(error.relationStatus)) {
        try {
          const current = await loadPlan(run);
          if (current.initialGeneration?.operationId === operationId) {
            if (error.sourceDiagnostics || current.sourceDiagnostics) attempt.sourceDiagnostics = error.sourceDiagnostics || current.sourceDiagnostics;
            if (Number.isInteger(error.canonCount ?? current.canonCount)) attempt.canonCount = error.canonCount ?? current.canonCount;
            await mark(run, current, error.relationStatus, { operationId, baseline: plan.baseline, completedMemberIds: [...completedIds(current.initialGeneration)], errorCode: error.relationStatus, draft: undefined }, attempt, 'baseline_check', error.relationStatus);
          }
        } catch { /* a changed identity/CAS must not be overwritten */ }
      }
      throw error;
    }
    const patches = [];
    for (const patch of validated.patches) patches.push(await materializePatch(patch, operationId, plan.baseline.digest));
    const draft = { schemaVersion: 1, draftVersion: 2, operationVersion: 2, operationId, baseline: plan.baseline, patches };
    if (stableJson(draft).length > INITIAL_RELATION_LIMITS.maxDraftChars) {
      await mark(run, plan, 'failed_retryable', { operationId, baseline: plan.baseline, completedMemberIds: [...completedIds(plan.initialGeneration)], errorCode: 'draft_too_large', draft: undefined }, attempt, 'validating_output', 'draft_too_large');
      throw fail('failed_retryable', 'recovery draft 超过保存预算');
    }
    await mark(run, plan, 'applying', { operationId, baseline: plan.baseline, completedMemberIds: [...completedIds(plan.initialGeneration)], draft }, attempt, 'applying', 'none');
    if (plan.initialGeneration.status === 'ready') return { status: 'ready', operationId, completedMemberIds: [...completedIds(plan.initialGeneration)], zeroAi: true };
    return applyDraft(run, plan, attempt);
  }

  async function resumeRun(run) {
    const attempt = newAttempt('initial_resume');
    const plan = await loadPlan(run);
    const initialGeneration = plan.initialGeneration;
    cache.set(run.state.chatId, stateView(plan.stateRecord));
    if (plan.blockedStatus) {
      attempt.targetCount = plan.targetIdentityIds.length; attempt.canonCount = plan.canonCount; attempt.sourceDiagnostics = plan.sourceDiagnostics;
      await mark(run, plan, plan.blockedStatus, { completedMemberIds: [...completedIds(plan.initialGeneration)], errorCode: plan.blockedStatus }, attempt, 'collecting_sources', plan.blockedStatus);
      return { status: plan.blockedStatus, zeroAi: true };
    }
    if (initialGeneration.status !== 'applying') return { status: initialGeneration.status || 'uninitialized', zeroAi: true, completedMemberIds: [...completedIds(initialGeneration)] };
    attempt.targetCount = plan.targetIdentityIds.length; attempt.canonCount = plan.canonCount; attempt.sourceDiagnostics = plan.sourceDiagnostics;
    attempt.operationId = initialGeneration.operationId; attempt.baselineDigest = initialGeneration.baseline?.digest;
    return applyDraft(run, plan, attempt);
  }

  async function adoptCurrentSourcesRun(run) {
    const attempt = newAttempt('adopt_current_sources');
    if (typeof routeSource.collect !== 'function') return { status: 'route_unavailable', zeroAi: true };
    const persistCollectionFailure = async errorCode => {
      try {
        const plan = await loadPlan(run);
        attempt.targetCount = plan.targetIdentityIds.length; attempt.canonCount = plan.canonCount; attempt.sourceDiagnostics = plan.sourceDiagnostics;
        await persistAttempt(run, plan, attempt, 'route_unavailable', 'collecting_current_sources', errorCode);
      } catch { /* identity/schema/storage uncertainty stays read-only */ }
    };
    let currentRoute;
    try { currentRoute = await routeSource.collect(); check(run); }
    catch (error) {
      const errorCode = safeCode(error?.diagnosticCode || 'route_collect_failed'); await persistCollectionFailure(errorCode);
      return { status: error?.diagnosticCode ? 'route_unavailable' : 'storage_error', errorCode, zeroAi: true };
    }
    if (!validRoute(currentRoute)) { await persistCollectionFailure('ROUTE_INVALID'); return { status: 'route_unavailable', errorCode: 'ROUTE_INVALID', zeroAi: true }; }
    const plan = await loadPlan(run);
    attempt.targetCount = plan.targetIdentityIds.length; attempt.canonCount = plan.canonCount; attempt.sourceDiagnostics = routeDiagnostics(plan.meta.data.route, currentRoute);
    if (completedIds(plan.initialGeneration).size > 0 || [...plan.profiles.values()].some(record => PROFILE_LISTS.some(layer => (Array.isArray(record.data[layer]) ? record.data[layer] : []).some(item => item?.writerId === INITIAL_RELATION_WRITER_ID)))) {
      await persistAttempt(run, plan, attempt, 'requires_rebuild', 'eligibility_check', 'requires_rebuild');
      return { status: 'requires_rebuild', zeroAi: true };
    }
    const nextMeta = { ...clone(plan.meta.data), route: clone(currentRoute) };
    let savedMeta;
    try { savedMeta = await write(run, chatCollection(run.state.chatId), 'meta', nextMeta, plan.meta.revision); }
    catch (error) {
      if (error.status !== 409) { await persistAttempt(run, plan, attempt, 'storage_error', 'updating_route', 'storage_error'); return { status: 'storage_error', zeroAi: true }; }
      const winner = await read(run, chatCollection(run.state.chatId), 'meta'); checkEnvelopeData(winner, 'chat-profile', run.state.chatId);
      if (winner.data.cardId !== plan.meta.data.cardId || winner.data.personaId !== plan.meta.data.personaId
        || winner.data.source?.card?.locator !== run.state.characterAvatar || winner.data.source?.persona?.locator !== run.state.personaAvatar
        || Number(winner.data.schemaVersion || 1) > 1 || !sameRouteSnapshot(winner.data.route, currentRoute)) {
        await persistAttempt(run, plan, attempt, 'conflict', 'updating_route', 'conflict'); return { status: 'conflict', zeroAi: true };
      }
      savedMeta = winner;
    }
    plan.meta = savedMeta;
    attempt.status = 'ready'; attempt.stage = 'complete'; attempt.errorCode = 'none';
    const resetInitialGeneration = { schemaVersion: 1, status: 'uninitialized', completedMemberIds: [] };
    try {
      const stateRecord = await putState(run, plan.stateRecord, resetInitialGeneration, attemptRecord(attempt));
      plan.stateRecord = stateRecord; plan.initialGeneration = stateRecord.data.initialGeneration; cache.set(run.state.chatId, stateView(stateRecord));
    } catch (error) {
      const status = error.relationStatus === 'conflict' || error.status === 409 ? 'conflict' : error.relationStatus || 'storage_error';
      return { status, adopted: false, routeAdopted: true, reloadRequired: true, zeroAi: true };
    }
    return { status: 'ready', adopted: true, zeroAi: true, sourceDiagnostics: clone(attempt.sourceDiagnostics) };
  }

  async function extractBasicInfoRun(run, options = {}) {
    const plan = await loadPlan(run);
    if (plan.blockedStatus) return { status: plan.blockedStatus, zeroAi: true };
    const characters = plan.members.filter(item => item.subject === 'character');
    const target = options.identityId ? characters.find(item => item.identityId === options.identityId) : characters[0];
    if (!target || !plan.profiles.has(target.identityId)) return { status: 'no_selected_character', zeroAi: true };
    const sources = basicInfoSources(plan, target, run.ctx);
    const attempt = newBasicAttempt(target.identityId, sources);
    const chars = sources.reduce((sum, source) => sum + source.content.length, 0);
    if (sources.length > INITIAL_RELATION_LIMITS.maxSources || chars > INITIAL_RELATION_LIMITS.maxInputChars || sources.some(source => source.content.length > INITIAL_RELATION_LIMITS.maxSourceChars)) {
      await persistBasicAttempt(run, plan, attempt, 'failed');
      return { status: 'input_too_large', zeroAi: true };
    }
    activeController = new AbortController();
    let validated;
    try {
      attempt.aiCalled = true;
      const response = await generateRelationTask({
        includeCharacterCard: false, worldInfoSource: 'none', substituteMacros: false, systemPrompt: BASIC_INFO_SYSTEM_PROMPT,
        taskMessages: [{ role: 'user', content: basicInfoPrompt(plan, target, sources) }], jsonSchema: { name: 'qianqianjie_basic_info_v1', value: BASIC_INFO_SCHEMA, strict: false },
        signal: activeController.signal, maxTokens: BASIC_INFO_LIMITS.maxTokens, temperature: 0.1,
      });
      check(run); captureTaskDiagnostics(attempt, response); validated = validateBasicInfoResult(response, { sources });
      attempt.acceptedFields = validated.diagnostics.acceptedFields;
      attempt.rejectedFields = validated.diagnostics.rejectedFields;
      attempt.rejectionCodes = validated.diagnostics.rejectionCodes;
      attempt.emptyResult = validated.diagnostics.emptyResult;
    } catch (error) {
      captureTaskDiagnostics(attempt, error);
      if (!error.stale && error.name !== 'AbortError') {
        try {
          const authoritative = await assertBaseline(run, plan.baseline);
          await persistBasicAttempt(run, authoritative, attempt, error.relationStatus === 'conflict' ? 'conflict' : 'failed');
        } catch { /* failed diagnostics must not outlive their authoritative baseline */ }
      }
      throw error;
    } finally { activeController = null; }
    let current;
    try { current = await assertBaseline(run, plan.baseline); }
    catch (error) {
      if (error.relationStatus === 'stale' && !error.stale) await persistBasicAttempt(run, plan, attempt, 'stale');
      throw error;
    }
    const record = current.profiles.get(target.identityId);
    if (!record) throw fail('mismatch', '当前 C 档案已变化');
    const basicFields = object(record.data.basicFields) ? clone(record.data.basicFields) : {};
    const operationId = newUuid(); let changed = false, skippedUserFields = 0;
    for (const [field, value] of Object.entries(validated.fields)) {
      if (basicFields[field]?.provenance === 'user') { skippedUserFields += 1; continue; }
      basicFields[field] = { ...clone(value), writerId: BASIC_INFO_WRITER_ID, operationId };
      changed = true;
    }
    if (!changed) {
      await persistBasicAttempt(run, current, attempt, 'ready');
      return { status: 'ready', zeroWrite: true, ...validated.diagnostics, skippedUserFields };
    }
    const desired = { ...clone(record.data), basicFields };
    try { await write(run, profileCollection(run.state.chatId), target.identityId, desired, record.revision); attempt.profileWrites = 1; }
    catch (error) {
      if (error.status === 409) { await persistBasicAttempt(run, current, attempt, 'conflict'); return { status: 'conflict', recoverable: true }; }
      await persistBasicAttempt(run, current, attempt, 'failed'); throw error;
    }
    await persistBasicAttempt(run, current, attempt, 'ready');
    return { status: 'ready', operationId, ...validated.diagnostics, skippedUserFields };
  }

  async function updateDynamicFieldsRun(run, options = {}) {
    const plan = await loadPlan(run);
    if (plan.blockedStatus) return { status: plan.blockedStatus, zeroAi: true };
    const characters = plan.members.filter(item => item.subject === 'character');
    const target = options.identityId ? characters.find(item => item.identityId === options.identityId) : characters[0];
    if (!target || !plan.profiles.has(target.identityId)) return { status: 'no_selected_character', zeroAi: true };
    const memoryBefore = await dynamicMemorySnapshot(memorySource); check(run);
    const sources = await dynamicInfoSources(plan, target, memoryBefore);
    const attempt = newBasicAttempt(target.identityId, sources);
    const chars = sources.reduce((sum, source) => sum + source.content.length, 0);
    if (sources.length > INITIAL_RELATION_LIMITS.maxSources || chars > INITIAL_RELATION_LIMITS.maxInputChars || sources.some(source => source.content.length > INITIAL_RELATION_LIMITS.maxSourceChars)) {
      await persistDynamicAttempt(run, plan, attempt, 'failed');
      return { status: 'input_too_large', zeroAi: true };
    }
    if (!sources.length) {
      attempt.emptyResult = true;
      await persistDynamicAttempt(run, plan, attempt, 'ready');
      return { status: 'ready', zeroAi: true, zeroWrite: true, acceptedFields: 0, rejectedFields: 0, rejectionCodes: [], emptyResult: true };
    }
    activeController = new AbortController();
    let validated;
    const assertMemoryStable = async () => {
      const currentMemory = await dynamicMemorySnapshot(memorySource); check(run);
      if (currentMemory.fingerprint !== memoryBefore.fingerprint) throw stale();
    };
    try {
      attempt.aiCalled = true;
      const response = await generateRelationTask({
        includeCharacterCard: false, worldInfoSource: 'none', substituteMacros: false, systemPrompt: DYNAMIC_INFO_SYSTEM_PROMPT,
        taskMessages: [{ role: 'user', content: dynamicInfoPrompt(target, sources) }], jsonSchema: { name: 'qianqianjie_dynamic_info_v1', value: DYNAMIC_INFO_SCHEMA, strict: false },
        signal: activeController.signal, maxTokens: DYNAMIC_INFO_LIMITS.maxTokens, temperature: 0.1,
      });
      check(run); await assertMemoryStable(); captureTaskDiagnostics(attempt, response);
      const relationshipNames = plan.members.filter(item => item.subject === 'user').map(item => item.displayName).filter(Boolean);
      validated = validateDynamicInfoResult(response, { sources, relationshipNames });
      attempt.acceptedFields = validated.diagnostics.acceptedFields;
      attempt.rejectedFields = validated.diagnostics.rejectedFields;
      attempt.rejectionCodes = validated.diagnostics.rejectionCodes;
      attempt.emptyResult = validated.diagnostics.emptyResult;
    } catch (error) {
      captureTaskDiagnostics(attempt, error);
      if (!error.stale && error.name !== 'AbortError') {
        await assertMemoryStable();
        try {
          const authoritative = await assertBaseline(run, plan.baseline);
          await persistDynamicAttempt(run, authoritative, attempt, error.relationStatus === 'conflict' ? 'conflict' : 'failed');
        } catch { /* failed diagnostics must not outlive their authoritative baseline */ }
      }
      throw error;
    } finally { activeController = null; }
    const current = await assertBaseline(run, plan.baseline);
    await assertMemoryStable();
    const record = current.profiles.get(target.identityId);
    if (!record) throw fail('mismatch', '当前 C 档案已变化');
    const dynamicFields = object(record.data.dynamicFields) ? clone(record.data.dynamicFields) : {};
    const operationId = newUuid(); let changed = false, skippedUserFields = 0;
    for (const [field, value] of Object.entries(validated.fields)) {
      if (dynamicFields[field]?.provenance === 'user') { skippedUserFields += 1; continue; }
      dynamicFields[field] = { ...clone(value), writerId: DYNAMIC_INFO_WRITER_ID, operationId };
      changed = true;
    }
    if (!changed) {
      await persistDynamicAttempt(run, current, attempt, 'ready');
      return { status: 'ready', zeroWrite: true, ...validated.diagnostics, skippedUserFields };
    }
    const desired = { ...clone(record.data), dynamicFields };
    try { await write(run, profileCollection(run.state.chatId), target.identityId, desired, record.revision); attempt.profileWrites = 1; }
    catch (error) {
      if (error.status === 409) { await persistDynamicAttempt(run, current, attempt, 'conflict'); return { status: 'conflict', recoverable: true }; }
      await persistDynamicAttempt(run, current, attempt, 'failed'); throw error;
    }
    await persistDynamicAttempt(run, current, attempt, 'ready');
    return { status: 'ready', operationId, ...validated.diagnostics, skippedUserFields };
  }

  async function saveBasicFieldRun(run, { identityId, field, value } = {}) {
    if (!BASIC_FIELD_KEYS.includes(field)) throw fail('mismatch', '基础字段无效');
    const text = normalizeText(value);
    if (text.length > BASIC_INFO_LIMITS.maxFieldChars) throw fail('invalid_text', '基础字段内容过长');
    const current = await loadSelectedProfile(run, identityId);
    const basicFields = object(current.profile.data.basicFields) ? clone(current.profile.data.basicFields) : {};
    if (text) basicFields[field] = { value: text, provenance: 'user', sourceRefs: [], locked: true, writerId: 'qianqianjie.user', operationId: newUuid() };
    else delete basicFields[field];
    const desired = { ...clone(current.profile.data), basicFields };
    if (same(desired, current.profile.data)) return { status: 'ready', unchanged: true };
    try { await write(run, profileCollection(run.state.chatId), identityId, desired, current.profile.revision); }
    catch (error) { if (error.status === 409) return { status: 'conflict', recoverable: true }; throw error; }
    return { status: 'ready', field, cleared: !text };
  }

  async function saveDynamicFieldRun(run, { identityId, field, value } = {}) {
    if (!DYNAMIC_FIELD_KEYS.includes(field)) throw fail('mismatch', '动态字段无效');
    const text = normalizeText(value);
    if (text.length > DYNAMIC_INFO_LIMITS.maxFieldChars) throw fail('invalid_text', '动态字段内容过长');
    const current = await loadSelectedProfile(run, identityId);
    const dynamicFields = object(current.profile.data.dynamicFields) ? clone(current.profile.data.dynamicFields) : {};
    if (text) dynamicFields[field] = { value: text, provenance: 'user', sourceRefs: [], locked: true, writerId: 'qianqianjie.user', operationId: newUuid() };
    else delete dynamicFields[field];
    const desired = { ...clone(current.profile.data), dynamicFields };
    if (same(desired, current.profile.data)) return { status: 'ready', unchanged: true };
    try { await write(run, profileCollection(run.state.chatId), identityId, desired, current.profile.revision); }
    catch (error) { if (error.status === 409) return { status: 'conflict', recoverable: true }; throw error; }
    return { status: 'ready', field, cleared: !text };
  }

  const enqueue = operation => {
    const entryEpoch = invalidationEpoch;
    const task = serial.then(async () => {
      if (entryEpoch !== invalidationEpoch || !isEnabled()) return { status: 'stale' };
      const run = { token: ++generation, ...snapshot() };
      try { return await operation(run); }
      catch (error) {
        if (error.stale || error.name === 'AbortError') return { status: 'stale' };
        return { status: error.relationStatus || 'storage_error', error: String(error.message || error), recoverable: true };
      }
    });
    serial = task.catch(() => {}); return task;
  };
  const invalidate = () => { generation += 1; invalidationEpoch += 1; activeController?.abort(); activeController = null; };
  return {
    start: () => enqueue(startRun), resume: () => enqueue(resumeRun), adoptCurrentSources: () => enqueue(adoptCurrentSourcesRun), cancel: invalidate, invalidate,
    extractBasicInfo: options => enqueue(run => extractBasicInfoRun(run, options)),
    saveBasicField: options => enqueue(run => saveBasicFieldRun(run, options)),
    updateDynamicFields: options => enqueue(run => updateDynamicFieldsRun(run, options)),
    saveDynamicField: options => enqueue(run => saveDynamicFieldRun(run, options)),
    getState: () => { const state = snapshot().state; return state.ok ? clone(cache.get(state.chatId) || { schemaVersion: 1, status: 'uninitialized', completedMemberIds: [] }) : { status: 'mismatch' }; },
  };
}
