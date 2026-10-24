import { isUuid } from '../identity.js';

export const PREPARATION_STEPS = Object.freeze([
  'synchronizing',
  'snapshotClone',
  'sourceSelection',
  'sourceSanitization',
  'timeSources',
  'identityDirectory',
  'qianshiCandidates',
  'extractorEnvelope',
  'dependencySnapshot',
  'rootCheck',
  'extractorHandoff',
]);

const PREPARATION_STEP_SET = new Set(PREPARATION_STEPS);
const failureSteps = new WeakMap();
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,79}$/u;
const SAFE_INTERNAL_CODE = /^(?:(?:QQJ|V3|CHAT_SESSION|QIANSHI)_[A-Z0-9_]{1,80}|BACKEND_TIMEOUT)$/u;
const PLUGIN_FRAME = /(?:^|[/\\])((?:src\/[A-Za-z0-9_./-]+\.js)|index\.js|dist\/qqj-app\.js)(?:\?[^:\s)]*)?:(\d{1,7}):(\d{1,7})(?:\)?$|\s)/u;

export function normalizePreparationStep(value) {
  return PREPARATION_STEP_SET.has(value) ? value : null;
}

const PREPARATION_ENTRIES = new Set(['direct', 'startup', 'chatChanged', 'personaChanged', 'pluginEnable', 'sourcePrepare', 'memoryManagement']);
const READ_PHASES = new Set(['readTargetChat', 'identityBeforeSave', 'identityBeforeCommit', 'identityVerify']);
const VALUE_TYPES = new Set(['array', 'object', 'null', 'undefined', 'string', 'number', 'boolean']);
const IDENTITY_READ_REASONS = new Set(['payloadNotArray', 'headerMissing', 'metadataMissing', 'identityMissing', 'identityDifferent']);
const locator = value => typeof value === 'string' && value.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;

// 只接纳本插件读回判断所需的固定字段，不复制宿主头部或其他插件资料。
export function identityReadDiagnostic(value) {
  if (!value || !IDENTITY_READ_REASONS.has(value.reason)) return null;
  return Object.freeze({ reason: value.reason,
    readPhase: READ_PHASES.has(value.readPhase) ? value.readPhase : 'readTargetChat',
    payloadType: VALUE_TYPES.has(value.payloadType) ? value.payloadType : null,
    headerPresent: value.headerPresent === true, metadataPresent: value.metadataPresent === true,
    qqjPresent: value.qqjPresent === true, qqjSchemaVersion: Number.isSafeInteger(value.qqjSchemaVersion) ? value.qqjSchemaVersion : null,
    expectedChatId: isUuid(value.expectedChatId) ? value.expectedChatId : null,
    actualChatId: isUuid(value.actualChatId) ? value.actualChatId : null,
    actualIdentityPresent: value.actualIdentityPresent === true,
    allowedChatIds: Object.freeze((Array.isArray(value.allowedChatIds) ? value.allowedChatIds : []).filter(isUuid).slice(0, 8)),
    allowMissingIdentity: value.allowMissingIdentity === true,
    target: Object.freeze({ hostChatId: locator(value.target?.hostChatId), characterLocator: locator(value.target?.characterLocator), avatarUrl: locator(value.target?.avatarUrl) }),
  });
}

export function preparationContextDiagnostic(value) {
  const entryPoint = PREPARATION_ENTRIES.has(value?.entryPoint) ? value.entryPoint : null;
  const identityRead = identityReadDiagnostic(value?.identityRead);
  return { ...(entryPoint ? { entryPoint } : {}), ...(identityRead ? { identityRead } : {}) };
}

export function markPreparationFailure(error, step, entryPoint = null) {
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    const previous = failureSteps.get(error);
    failureSteps.set(error, { step: previous?.step ?? normalizePreparationStep(step) ?? 'extractorHandoff',
      entryPoint: previous?.entryPoint ?? (PREPARATION_ENTRIES.has(entryPoint) ? entryPoint : null) });
  }
  return error;
}

export function preparationStepFor(error) {
  return ((typeof error === 'object' && error !== null) || typeof error === 'function')
    ? failureSteps.get(error)?.step ?? null
    : null;
}

export function safeErrorName(value) {
  return typeof value === 'string' && SAFE_ERROR_NAME.test(value) ? value : null;
}

export function safeErrorCode(value) {
  if (Number.isSafeInteger(value)) return value;
  return typeof value === 'string' && SAFE_INTERNAL_CODE.test(value) ? value : null;
}

export function safeErrorLocation(value) {
  if (typeof value !== 'string') return null;
  for (const frame of value.split('\n').slice(1, 20)) {
    if (!/^\s*(?:at\s|[^@\s]+@)/u.test(frame)) continue;
    const matched = frame.match(PLUGIN_FRAME);
    if (!matched) continue;
    const line = Number(matched[2]), column = Number(matched[3]);
    if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1) continue;
    return `${matched[1]}:${line}:${column}`;
  }
  return null;
}

function technicalDetail(error, name, code) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (name === 'UsageGraphError' && /edge already exists in the graph/iu.test(message)) return 'Graphology 检测到重复图边。';
  if (name === 'DataCloneError' || code === 25) return '结构化复制失败。';
  if (name === 'TypeError') return '类型检查失败。';
  if (typeof code === 'string') return '插件内部错误码已记录。';
  return '未分类错误。';
}

export function preparationFailureDiagnostic(error, fallbackStep = null) {
  const name = safeErrorName(error?.name);
  const code = safeErrorCode(error?.code);
  const status = error?.httpStatus ?? error?.status;
  return Object.freeze({
    ...preparationContextDiagnostic({ entryPoint: failureSteps.get(error)?.entryPoint, identityRead: error?.identityRead }),
    prepareStep: preparationStepFor(error) ?? normalizePreparationStep(fallbackStep),
    name,
    code,
    httpStatus: Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null,
    detail: technicalDetail(error, name, code),
    location: safeErrorLocation(error?.stack),
  });
}

export function storedPreparationDiagnostic(value) {
  const legacyName = value?.name == null && typeof value?.code === 'string' && /Error$/u.test(value.code)
    ? safeErrorName(value.code)
    : null;
  const name = safeErrorName(value?.name) ?? legacyName;
  const numericCode = typeof value?.code === 'string' && /^-?\d{1,16}$/u.test(value.code) && Number.isSafeInteger(Number(value.code)) ? Number(value.code) : value?.code;
  const code = legacyName ? null : safeErrorCode(numericCode);
  const status = value?.httpStatus ?? value?.status;
  const detail = typeof value?.detail === 'string' && [
    'Graphology 检测到重复图边。',
    '结构化复制失败。',
    '类型检查失败。',
    '插件内部错误码已记录。',
    '未分类错误。',
  ].includes(value.detail) ? value.detail : null;
  const location = typeof value?.location === 'string'
    && /^(?:src\/[A-Za-z0-9_./-]+\.js|index\.js|dist\/qqj-app\.js):[1-9]\d{0,6}:[1-9]\d{0,6}$/u.test(value.location)
    ? value.location
    : null;
  return Object.freeze({ ...preparationContextDiagnostic(value), prepareStep: normalizePreparationStep(value?.prepareStep), name, code,
    httpStatus: Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null, detail, location });
}
