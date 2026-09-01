import { computeArchiveV2SourceFingerprint } from './archive-v2-source-fingerprint.js';
import {
  ARCHIVE_V2_KIND,
  ARCHIVE_V2_SCHEMA_VERSION,
  validateArchiveV2,
} from './archive-v2.js';
import {
  ARCHIVE_V2_PROFILE_DRAFT_KIND,
  ARCHIVE_V2_PROFILE_DRAFT_SCHEMA_VERSION,
  ARCHIVE_V2_PROFILE_FIELD_KEYS,
  ARCHIVE_V2_PROFILE_LIMITS,
} from './archive-v2-profile-generation.js';
import { ARCHIVE_V2_RECOGNITION_LIMITS } from './archive-v2-recognition.js';

export const ARCHIVE_V2_INITIALIZATION_REVIEW_SCHEMA_VERSION = 1;
export const ARCHIVE_V2_INITIALIZATION_REVIEW_KIND = 'myriad-knots-people-profile-review';

const MAX_ID_CHARACTERS = 200;
const MAX_LOCATOR_CHARACTERS = 2000;
const SOURCE_KINDS = new Set(['card', 'greeting', 'worldbook', 'chat']);
const SOURCE_AVAILABILITY = new Set(['card', 'greeting', 'activated', 'enabled', 'disabled', 'chat']);
const PROFILE_ROOT_KEYS = new Set(['schemaVersion', 'kind', 'chatId', 'sourceFingerprint', 'people']);
const PERSON_KEYS = new Set([
  'identityId',
  'displayName',
  'aliases',
  'recognitionReason',
  'sourceRefs',
  'fields',
]);
const FIELD_KEYS = new Set(['value', 'origin', 'sourceRefs', 'userProtected']);
const SOURCE_REF_KEYS = new Set(['kind', 'locator', 'fingerprint']);
const IDENTITY_KEYS = new Set(['characterLocator', 'personaLocator', 'personaSummary']);
const PROFILE_FIELD_SET = new Set(ARCHIVE_V2_PROFILE_FIELD_KEYS);

export class ArchiveV2InitializationReviewError extends Error {
  constructor(message, code = 'ARCHIVE_V2_INITIALIZATION_REVIEW_INVALID') {
    super(message);
    this.name = 'ArchiveV2InitializationReviewError';
    this.code = code;
  }
}

function fail(message, code = 'ARCHIVE_V2_INITIALIZATION_REVIEW_INVALID') {
  throw new ArchiveV2InitializationReviewError(message, code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value, path = 'value', ancestors = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} 必须是合法 JSON`, 'ARCHIVE_V2_INITIALIZATION_REVIEW_NOT_JSON');
    return value;
  }
  if (typeof value !== 'object') {
    fail(`${path} 必须是合法 JSON`, 'ARCHIVE_V2_INITIALIZATION_REVIEW_NOT_JSON');
  }
  if (ancestors.has(value)) {
    fail(`${path} 不得包含循环引用`, 'ARCHIVE_V2_INITIALIZATION_REVIEW_NOT_JSON');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (Object.getOwnPropertySymbols(value).length > 0
        || keys.length !== value.length + 1
        || !keys.includes('length')) {
        fail(`${path} 必须是连续 JSON 数组`, 'ARCHIVE_V2_INITIALIZATION_REVIEW_NOT_JSON');
      }
      const output = [];
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
          fail(`${path} 必须是连续 JSON 数组`, 'ARCHIVE_V2_INITIALIZATION_REVIEW_NOT_JSON');
        }
        output.push(cloneJson(descriptor.value, `${path}[${index}]`, ancestors));
      }
      return output;
    }
    if (!isPlainObject(value)) {
      fail(`${path} 必须是合法 JSON 对象`, 'ARCHIVE_V2_INITIALIZATION_REVIEW_NOT_JSON');
    }
    const output = {};
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        fail(`${path} 必须是合法 JSON 对象`, 'ARCHIVE_V2_INITIALIZATION_REVIEW_NOT_JSON');
      }
      Object.defineProperty(output, key, {
        value: cloneJson(descriptor.value, `${path}.${key}`, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function safeClone(value, path) {
  try {
    return cloneJson(value, path);
  } catch (error) {
    if (error instanceof ArchiveV2InitializationReviewError) throw error;
    throw new ArchiveV2InitializationReviewError(
      `${path} 无法安全读取`,
      'ARCHIVE_V2_INITIALIZATION_REVIEW_NOT_JSON',
    );
  }
}

function exactKeys(value, allowed, label) {
  if (!isPlainObject(value)) fail(`${label} 必须是对象`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== allowed.size || keys.some(key => typeof key !== 'string' || !allowed.has(key))) {
    fail(`${label} 字段无效`, 'ARCHIVE_V2_INITIALIZATION_REVIEW_FIELDS_INVALID');
  }
}

function boundedString(value, maxLength, label, { allowEmpty = false, trim = false } = {}) {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && !value.trim())) {
    fail(`${label} 无效`, 'ARCHIVE_V2_INITIALIZATION_REVIEW_FIELD_INVALID');
  }
  return trim ? value.trim() : value;
}

function validateSourceRef(value) {
  exactKeys(value, SOURCE_REF_KEYS, 'sourceRef');
  if (!SOURCE_KINDS.has(value.kind)) fail('sourceRef.kind 无效');
  const locator = boundedString(value.locator, MAX_LOCATOR_CHARACTERS, 'sourceRef.locator');
  if (typeof value.fingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value.fingerprint)) {
    fail('sourceRef.fingerprint 无效');
  }
  return { kind: value.kind, locator, fingerprint: value.fingerprint };
}

function validateSourceRefs(values, { min = 0, max, label = 'sourceRefs' } = {}) {
  if (!Array.isArray(values) || values.length < min || values.length > max) fail(`${label} 无效`);
  const refs = [];
  const seen = new Set();
  for (const value of values) {
    const ref = validateSourceRef(value);
    const key = `${ref.kind}\u0000${ref.locator}\u0000${ref.fingerprint}`;
    if (seen.has(key)) fail(`${label} 不得重复`);
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

function validateField(value, { draftOnly = false, label } = {}) {
  exactKeys(value, FIELD_KEYS, label);
  if (typeof value.value !== 'string'
    || value.value.length > ARCHIVE_V2_PROFILE_LIMITS.maxFieldCharacters
    || (value.value !== '' && value.value !== value.value.trim())) {
    fail(`${label}.value 无效`);
  }
  const refs = validateSourceRefs(value.sourceRefs, {
    max: ARCHIVE_V2_RECOGNITION_LIMITS.maxEvidence,
    label: `${label}.sourceRefs`,
  });
  const aiOwned = value.origin === 'ai' && value.userProtected === false;
  const userOwned = value.origin === 'user' && value.userProtected === true;
  if ((draftOnly && !aiOwned) || (!draftOnly && !aiOwned && !userOwned)) {
    fail(`${label} 所有权组合无效`, 'ARCHIVE_V2_INITIALIZATION_REVIEW_OWNERSHIP_INVALID');
  }
  if (aiOwned && ((value.value === '' && refs.length !== 0) || (value.value !== '' && refs.length === 0))) {
    fail(`${label} 的 AI 值与来源不一致`, 'ARCHIVE_V2_INITIALIZATION_REVIEW_OWNERSHIP_INVALID');
  }
  if (userOwned && refs.length !== 0) {
    fail(`${label} 的用户值不得保留 AI 来源`, 'ARCHIVE_V2_INITIALIZATION_REVIEW_OWNERSHIP_INVALID');
  }
  return {
    value: value.value,
    origin: value.origin,
    sourceRefs: refs,
    userProtected: value.userProtected,
  };
}

function validatePerson(value, { draftOnly = false } = {}) {
  exactKeys(value, PERSON_KEYS, 'person');
  const identityId = boundedString(value.identityId, MAX_ID_CHARACTERS, 'person.identityId');
  const displayName = boundedString(
    value.displayName,
    ARCHIVE_V2_RECOGNITION_LIMITS.maxNameCharacters,
    'person.displayName',
  );
  if (!Array.isArray(value.aliases) || value.aliases.length > ARCHIVE_V2_RECOGNITION_LIMITS.maxAliases) {
    fail('person.aliases 无效');
  }
  const aliases = value.aliases.map(alias => boundedString(
    alias,
    ARCHIVE_V2_RECOGNITION_LIMITS.maxAliasCharacters,
    'person.alias',
  ));
  const recognitionReason = boundedString(
    value.recognitionReason,
    ARCHIVE_V2_RECOGNITION_LIMITS.maxReasonCharacters,
    'person.recognitionReason',
  );
  const sourceRefs = validateSourceRefs(value.sourceRefs, {
    min: 1,
    max: ARCHIVE_V2_RECOGNITION_LIMITS.maxSources,
    label: 'person.sourceRefs',
  });
  exactKeys(value.fields, PROFILE_FIELD_SET, 'person.fields');
  const fields = {};
  for (const field of ARCHIVE_V2_PROFILE_FIELD_KEYS) {
    fields[field] = validateField(value.fields[field], { draftOnly, label: `person.fields.${field}` });
  }
  return { identityId, displayName, aliases, recognitionReason, sourceRefs, fields };
}

function validateProfile(value, { expectedKind, expectedVersion, draftOnly = false, allowEmpty = false } = {}) {
  exactKeys(value, PROFILE_ROOT_KEYS, 'root');
  if (value.schemaVersion !== expectedVersion || value.kind !== expectedKind) {
    fail('schemaVersion 或 kind 无效');
  }
  const chatId = boundedString(value.chatId, MAX_ID_CHARACTERS, 'chatId');
  if (typeof value.sourceFingerprint !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test(value.sourceFingerprint)) {
    fail('sourceFingerprint 无效');
  }
  if (!Array.isArray(value.people)
    || (!allowEmpty && value.people.length < 1)
    || value.people.length > ARCHIVE_V2_RECOGNITION_LIMITS.maxCandidates) {
    fail('people 无效');
  }
  const ids = new Set();
  const people = value.people.map(item => {
    const person = validatePerson(item, { draftOnly });
    if (ids.has(person.identityId)) fail('identityId 不得重复');
    ids.add(person.identityId);
    return person;
  });
  let totalFieldCharacters = 0;
  for (const person of people) for (const field of ARCHIVE_V2_PROFILE_FIELD_KEYS) {
    totalFieldCharacters += person.fields[field].value.length;
    if (totalFieldCharacters > ARCHIVE_V2_PROFILE_LIMITS.maxTotalFieldCharacters) {
      fail('基础字段总字符超限', 'ARCHIVE_V2_INITIALIZATION_REVIEW_FIELD_LIMIT');
    }
  }
  return {
    schemaVersion: expectedVersion,
    kind: expectedKind,
    chatId,
    sourceFingerprint: value.sourceFingerprint,
    people,
  };
}

function validateDraft(value) {
  return validateProfile(value, {
    expectedKind: ARCHIVE_V2_PROFILE_DRAFT_KIND,
    expectedVersion: ARCHIVE_V2_PROFILE_DRAFT_SCHEMA_VERSION,
    draftOnly: true,
  });
}

function validateReview(value) {
  return validateProfile(value, {
    expectedKind: ARCHIVE_V2_INITIALIZATION_REVIEW_KIND,
    expectedVersion: ARCHIVE_V2_INITIALIZATION_REVIEW_SCHEMA_VERSION,
  });
}

function selectedSources(values) {
  if (!Array.isArray(values)) fail('sources 必须是数组', 'ARCHIVE_V2_INITIALIZATION_REVIEW_SOURCE_INVALID');
  const selected = values.filter(value => value?.selected === true && value?.availability !== 'disabled');
  if (!selected.length || selected.length > ARCHIVE_V2_RECOGNITION_LIMITS.maxSources) {
    fail('确认来源数量无效', 'ARCHIVE_V2_INITIALIZATION_REVIEW_SOURCE_LIMIT');
  }
  const snapshots = [];
  const seen = new Set();
  let totalCharacters = 0;
  for (const source of selected) {
    if (!isPlainObject(source)
      || !SOURCE_KINDS.has(source.kind)
      || !SOURCE_AVAILABILITY.has(source.availability)
      || typeof source.locator !== 'string'
      || !source.locator
      || typeof source.fingerprint !== 'string'
      || !source.fingerprint.startsWith('sha256:')
      || typeof source.content !== 'string') {
      fail('确认来源结构无效', 'ARCHIVE_V2_INITIALIZATION_REVIEW_SOURCE_INVALID');
    }
    if (source.content.length > ARCHIVE_V2_RECOGNITION_LIMITS.maxSourceCharacters) {
      fail('单个确认来源超限', 'ARCHIVE_V2_INITIALIZATION_REVIEW_SOURCE_LIMIT');
    }
    totalCharacters += source.content.length;
    if (totalCharacters > ARCHIVE_V2_RECOGNITION_LIMITS.maxTotalSourceCharacters) {
      fail('确认来源总字符超限', 'ARCHIVE_V2_INITIALIZATION_REVIEW_SOURCE_LIMIT');
    }
    const key = `${source.kind}\u0000${source.locator}`;
    if (seen.has(key)) fail('确认来源不得重复', 'ARCHIVE_V2_INITIALIZATION_REVIEW_SOURCE_INVALID');
    seen.add(key);
    snapshots.push({
      kind: source.kind,
      locator: source.locator,
      fingerprint: source.fingerprint,
      content: source.content,
    });
  }
  return snapshots;
}

function validateRefsResolve(review, sources) {
  const known = new Set(sources.map(source => `${source.kind}\u0000${source.locator}\u0000${source.fingerprint}`));
  const check = ref => {
    if (!known.has(`${ref.kind}\u0000${ref.locator}\u0000${ref.fingerprint}`)) {
      fail('审核态来源引用无法精确解析', 'ARCHIVE_V2_INITIALIZATION_REVIEW_SOURCE_MISMATCH');
    }
  };
  for (const person of review.people) {
    person.sourceRefs.forEach(check);
    for (const field of ARCHIVE_V2_PROFILE_FIELD_KEYS) person.fields[field].sourceRefs.forEach(check);
  }
}

function validateIdentity(value) {
  exactKeys(value, IDENTITY_KEYS, 'identity');
  const characterLocator = boundedString(value.characterLocator, MAX_LOCATOR_CHARACTERS, 'identity.characterLocator');
  const personaLocator = boundedString(value.personaLocator, MAX_LOCATOR_CHARACTERS, 'identity.personaLocator');
  if (typeof value.personaSummary !== 'string') fail('identity.personaSummary 必须是字符串');
  return { characterLocator, personaLocator, personaSummary: value.personaSummary };
}

function isValidIsoDateTime(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1
    && month >= 1
    && month <= 12
    && day >= 1
    && day <= days[month - 1]
    && hour <= 23
    && minute <= 59
    && second <= 59
    && offsetHour <= 23
    && offsetMinute <= 59
    && Number.isFinite(Date.parse(value));
}

function copyField(field) {
  return {
    value: field.value,
    origin: field.origin,
    sourceRefs: field.sourceRefs.map(ref => ({ ...ref })),
    userProtected: field.userProtected,
  };
}

export function createArchiveV2InitializationReview(profileDraft) {
  const draft = validateDraft(safeClone(profileDraft, 'profileDraft'));
  return {
    ...draft,
    schemaVersion: ARCHIVE_V2_INITIALIZATION_REVIEW_SCHEMA_VERSION,
    kind: ARCHIVE_V2_INITIALIZATION_REVIEW_KIND,
  };
}

export function setArchiveV2InitializationField(review, { identityId, field, value } = {}) {
  const safe = validateReview(safeClone(review, 'review'));
  if (typeof identityId !== 'string' || !identityId || !PROFILE_FIELD_SET.has(field)) {
    fail('人物或字段无效', 'ARCHIVE_V2_INITIALIZATION_REVIEW_NOT_FOUND');
  }
  if (typeof value !== 'string' || value.length > ARCHIVE_V2_PROFILE_LIMITS.maxFieldCharacters) {
    fail('字段新值无效', 'ARCHIVE_V2_INITIALIZATION_REVIEW_FIELD_INVALID');
  }
  const index = safe.people.findIndex(person => person.identityId === identityId);
  if (index < 0) fail('人物不存在', 'ARCHIVE_V2_INITIALIZATION_REVIEW_NOT_FOUND');
  const normalizedValue = value.trim();
  return validateReview({
    ...safe,
    people: safe.people.map((person, personIndex) => personIndex === index ? {
      ...person,
      fields: {
        ...person.fields,
        [field]: {
          value: normalizedValue,
          origin: 'user',
          sourceRefs: [],
          userProtected: true,
        },
      },
    } : person),
  });
}

export async function buildInitializedArchiveV2({ review, sources, identity, confirmedAt } = {}) {
  const safeReview = validateReview(safeClone(review, 'review'));
  const safeSources = selectedSources(safeClone(sources, 'sources'));
  const safeIdentity = validateIdentity(safeClone(identity, 'identity'));
  if (!isValidIsoDateTime(confirmedAt)) {
    fail('confirmedAt 必须是有效 ISO 日期时间', 'ARCHIVE_V2_INITIALIZATION_REVIEW_TIME_INVALID');
  }
  const fingerprint = await computeArchiveV2SourceFingerprint(safeSources);
  if (fingerprint !== safeReview.sourceFingerprint) {
    fail('确认来源指纹与审核态不一致', 'ARCHIVE_V2_INITIALIZATION_REVIEW_SOURCE_MISMATCH');
  }
  validateRefsResolve(safeReview, safeSources);

  const byId = {};
  for (const person of safeReview.people) {
    const personRefs = person.sourceRefs.map(ref => ({ ...ref }));
    const fields = {};
    for (const field of ARCHIVE_V2_PROFILE_FIELD_KEYS) fields[field] = copyField(person.fields[field]);
    Object.defineProperty(byId, person.identityId, {
      value: {
        identityId: person.identityId,
        followed: true,
        displayName: {
          value: person.displayName,
          origin: 'user',
          sourceRefs: person.sourceRefs.map(ref => ({ ...ref })),
          userProtected: true,
        },
        aliases: {
          value: [...person.aliases],
          origin: 'user',
          sourceRefs: person.sourceRefs.map(ref => ({ ...ref })),
          userProtected: true,
        },
        fields,
        sourceRefs: personRefs,
      },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  const archive = {
    schemaVersion: ARCHIVE_V2_SCHEMA_VERSION,
    kind: ARCHIVE_V2_KIND,
    chatId: safeReview.chatId,
    identity: safeIdentity,
    initialization: {
      confirmedAt,
      sourceFingerprint: safeReview.sourceFingerprint,
      sources: safeSources.map(source => ({ ...source })),
    },
    people: {
      order: safeReview.people.map(person => person.identityId),
      byId,
    },
    events: [],
    bonds: {},
    nextSteps: { items: [] },
    progress: { lastConfirmedFloor: null },
  };
  try {
    return validateArchiveV2(archive, { expectedChatId: safeReview.chatId });
  } catch {
    throw new ArchiveV2InitializationReviewError(
      '正式档案组装结果无效',
      'ARCHIVE_V2_INITIALIZATION_REVIEW_ASSEMBLY_INVALID',
    );
  }
}
