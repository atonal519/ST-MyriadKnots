import { computeArchiveV2SourceFingerprint } from './archive-v2-source-fingerprint.js';
import { parseJsonOutput } from './compact-api-client.js';
import { ARCHIVE_V2_RECOGNITION_LIMITS } from './archive-v2-recognition.js';
import { ARCHIVE_V2_SELECTED_PEOPLE_PLAN_KIND } from './archive-v2-candidate-review.js';

export const ARCHIVE_V2_PROFILE_DRAFT_SCHEMA_VERSION = 1;
export const ARCHIVE_V2_PROFILE_DRAFT_KIND = 'myriad-knots-people-profile-draft';
export const ARCHIVE_V2_PROFILE_FIELD_KEYS = Object.freeze([
  'gender',
  'age',
  'appearance',
  'personality',
  'identity',
  'abilities',
  'likes',
  'dislikes',
  'principles',
  'relationships',
]);
export const ARCHIVE_V2_PROFILE_LIMITS = Object.freeze({
  maxFieldCharacters: 1200,
  maxTotalFieldCharacters: 100000,
});

const MAX_ID_CHARACTERS = 200;
const MAX_LOCATOR_CHARACTERS = 2000;
const SOURCE_KINDS = new Set(['card', 'greeting', 'worldbook', 'chat']);
const SOURCE_AVAILABILITY = new Set(['card', 'greeting', 'activated', 'enabled', 'disabled', 'chat']);
const PLAN_ROOT_KEYS = new Set(['schemaVersion', 'kind', 'chatId', 'sourceFingerprint', 'people']);
const PLAN_PERSON_KEYS = new Set(['identityId', 'displayName', 'aliases', 'recognitionReason', 'sourceRefs']);
const SOURCE_REF_KEYS = new Set(['kind', 'locator', 'fingerprint']);
const AI_ROOT_KEYS = new Set(['people']);
const AI_PERSON_KEYS = new Set(['identityId', 'fields']);
const AI_FIELD_KEYS = new Set(['value', 'evidence']);

const AI_FIELD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['value', 'evidence'],
  properties: {
    value: { type: 'string', maxLength: ARCHIVE_V2_PROFILE_LIMITS.maxFieldCharacters },
    evidence: {
      type: 'array',
      maxItems: ARCHIVE_V2_RECOGNITION_LIMITS.maxEvidence,
      items: { type: 'string', pattern: '^S[1-9][0-9]*$' },
    },
  },
};
const PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['people'],
  properties: {
    people: {
      type: 'array',
      maxItems: ARCHIVE_V2_RECOGNITION_LIMITS.maxCandidates,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['identityId', 'fields'],
        properties: {
          identityId: { type: 'string', minLength: 1, maxLength: MAX_ID_CHARACTERS },
          fields: {
            type: 'object',
            additionalProperties: false,
            required: [...ARCHIVE_V2_PROFILE_FIELD_KEYS],
            properties: Object.fromEntries(ARCHIVE_V2_PROFILE_FIELD_KEYS.map(key => [key, AI_FIELD_SCHEMA])),
          },
        },
      },
    },
  },
};

export class ArchiveV2ProfileGenerationError extends Error {
  constructor(message, code = 'ARCHIVE_V2_PROFILE_GENERATION_INVALID') {
    super(message);
    this.name = 'ArchiveV2ProfileGenerationError';
    this.code = code;
  }
}

function fail(message, code = 'ARCHIVE_V2_PROFILE_GENERATION_INVALID') {
  throw new ArchiveV2ProfileGenerationError(message, code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, label) {
  if (!isPlainObject(value)) fail(`${label} 必须是对象`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== allowed.size || keys.some(key => typeof key !== 'string' || !allowed.has(key))) {
    fail(`${label} 字段无效`, 'ARCHIVE_V2_PROFILE_GENERATION_FIELDS_INVALID');
  }
}

function boundedString(value, maxLength, label, { trim = true } = {}) {
  if (typeof value !== 'string' || value.length > maxLength || !value.trim()) fail(`${label} 无效`);
  return trim ? value.trim() : value;
}

function sourceRef(value) {
  exactKeys(value, SOURCE_REF_KEYS, 'sourceRef');
  if (!SOURCE_KINDS.has(value.kind)) fail('sourceRef.kind 无效');
  const locator = boundedString(value.locator, MAX_LOCATOR_CHARACTERS, 'sourceRef.locator', { trim: false });
  if (typeof value.fingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value.fingerprint)) {
    fail('sourceRef.fingerprint 无效');
  }
  return { kind: value.kind, locator, fingerprint: value.fingerprint };
}

function sourceRefs(values) {
  if (!Array.isArray(values)
    || values.length < 1
    || values.length > ARCHIVE_V2_RECOGNITION_LIMITS.maxSources) fail('sourceRefs 无效');
  const output = [];
  const seen = new Set();
  for (const value of values) {
    const ref = sourceRef(value);
    const key = `${ref.kind}\u0000${ref.locator}\u0000${ref.fingerprint}`;
    if (seen.has(key)) fail('sourceRefs 重复');
    seen.add(key);
    output.push(ref);
  }
  return output;
}

function validatePlan(plan) {
  exactKeys(plan, PLAN_ROOT_KEYS, 'plan');
  if (plan.schemaVersion !== 1 || plan.kind !== ARCHIVE_V2_SELECTED_PEOPLE_PLAN_KIND) {
    fail('plan schemaVersion 或 kind 无效');
  }
  const chatId = boundedString(plan.chatId, MAX_ID_CHARACTERS, 'plan.chatId', { trim: false });
  if (typeof plan.sourceFingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(plan.sourceFingerprint)) {
    fail('plan.sourceFingerprint 无效');
  }
  if (!Array.isArray(plan.people) || plan.people.length > ARCHIVE_V2_RECOGNITION_LIMITS.maxCandidates) {
    fail('plan.people 无效');
  }
  const ids = new Set();
  const people = plan.people.map(value => {
    exactKeys(value, PLAN_PERSON_KEYS, 'plan.person');
    const identityId = boundedString(value.identityId, MAX_ID_CHARACTERS, 'identityId', { trim: false });
    if (ids.has(identityId)) fail('identityId 重复');
    ids.add(identityId);
    const displayName = boundedString(
      value.displayName,
      ARCHIVE_V2_RECOGNITION_LIMITS.maxNameCharacters,
      'displayName',
      { trim: false },
    );
    if (!Array.isArray(value.aliases) || value.aliases.length > ARCHIVE_V2_RECOGNITION_LIMITS.maxAliases) {
      fail('aliases 无效');
    }
    const aliases = value.aliases.map(alias => boundedString(
      alias,
      ARCHIVE_V2_RECOGNITION_LIMITS.maxAliasCharacters,
      'alias',
      { trim: false },
    ));
    const recognitionReason = boundedString(
      value.recognitionReason,
      ARCHIVE_V2_RECOGNITION_LIMITS.maxReasonCharacters,
      'recognitionReason',
      { trim: false },
    );
    return { identityId, displayName, aliases, recognitionReason, sourceRefs: sourceRefs(value.sourceRefs) };
  });
  return { chatId, sourceFingerprint: plan.sourceFingerprint, people };
}

function selectedSources(sources) {
  if (!Array.isArray(sources)) fail('sources 必须是数组');
  const selected = sources.filter(source => source?.selected === true && source?.availability !== 'disabled');
  if (!selected.length) fail('没有选中的可用来源', 'ARCHIVE_V2_PROFILE_GENERATION_SOURCE_INVALID');
  if (selected.length > ARCHIVE_V2_RECOGNITION_LIMITS.maxSources) {
    fail('来源超过数量上限', 'ARCHIVE_V2_PROFILE_GENERATION_SOURCE_LIMIT');
  }
  const output = [];
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
      fail('来源结构无效', 'ARCHIVE_V2_PROFILE_GENERATION_SOURCE_INVALID');
    }
    if (source.content.length > ARCHIVE_V2_RECOGNITION_LIMITS.maxSourceCharacters) {
      fail('单来源字符超限', 'ARCHIVE_V2_PROFILE_GENERATION_SOURCE_LIMIT');
    }
    totalCharacters += source.content.length;
    if (totalCharacters > ARCHIVE_V2_RECOGNITION_LIMITS.maxTotalSourceCharacters) {
      fail('来源总字符超限', 'ARCHIVE_V2_PROFILE_GENERATION_SOURCE_LIMIT');
    }
    const key = `${source.kind}\u0000${source.locator}`;
    if (seen.has(key)) fail('来源重复', 'ARCHIVE_V2_PROFILE_GENERATION_SOURCE_INVALID');
    seen.add(key);
    output.push({
      code: `S${output.length + 1}`,
      kind: source.kind,
      locator: source.locator,
      fingerprint: source.fingerprint,
      content: source.content,
    });
  }
  return output;
}

function validatePlanRefs(plan, sources) {
  const known = new Set(sources.map(source => `${source.kind}\u0000${source.locator}\u0000${source.fingerprint}`));
  for (const person of plan.people) for (const ref of person.sourceRefs) {
    if (!known.has(`${ref.kind}\u0000${ref.locator}\u0000${ref.fingerprint}`)) {
      fail('plan sourceRef 无法解析', 'ARCHIVE_V2_PROFILE_GENERATION_SOURCE_MISMATCH');
    }
  }
}

function captureSnapshot(contextProvider) {
  const raw = contextProvider();
  if (!isPlainObject(raw)) fail('宿主上下文不可用', 'ARCHIVE_V2_PROFILE_GENERATION_CONTEXT_INVALID');
  const snapshot = {
    hostChatId: raw.hostChatId,
    chatId: raw.chatId,
    characterLocator: raw.characterLocator ?? raw.characterAvatar,
    personaLocator: raw.personaLocator ?? raw.personaAvatar,
  };
  for (const value of Object.values(snapshot)) {
    if (typeof value !== 'string' || !value.trim()) fail('宿主上下文无效', 'ARCHIVE_V2_PROFILE_GENERATION_CONTEXT_INVALID');
  }
  return Object.freeze({ ...snapshot });
}

function sameSnapshot(left, right) {
  return left.hostChatId === right.hostChatId
    && left.chatId === right.chatId
    && left.characterLocator === right.characterLocator
    && left.personaLocator === right.personaLocator;
}

function promptFor(plan, sources) {
  const people = plan.people.map(person => ({
    identityId: person.identityId,
    displayName: person.displayName,
    aliases: person.aliases,
    recognitionReason: person.recognitionReason,
  }));
  return [
    '一次性为下列全部已确认人物生成基础档案。人物列表必须原样覆盖一次，不得新增、删除、合并或重命名。',
    `每个人必须返回 identityId 和 fields；fields 必须恰好包含：${ARCHIVE_V2_PROFILE_FIELD_KEYS.join(', ')}。`,
    '每个字段只返回 value 与 evidence。不能确定时 value="" 且 evidence=[]；非空 value 至少引用一个 S 代号。',
    '不得生成关系阶段、好感、当前目标、秘密、事件、下一步或任何存储字段。',
    `已确认人物：\n${JSON.stringify(people)}`,
    ...sources.map(source => `[${source.code}] kind=${source.kind}\n${source.content}`),
  ].join('\n\n');
}

function unwrapTaskResult(response) {
  let value = response;
  let finishReason;
  if (isPlainObject(value) && Object.hasOwn(value, 'jsonData')) {
    finishReason = value.taskMetadata?.finishReason;
    value = value.jsonData;
  }
  return parseJsonOutput(value, { finishReason });
}

function validateAiOutput(value, plan, sources) {
  exactKeys(value, AI_ROOT_KEYS, 'AI root');
  if (!Array.isArray(value.people) || value.people.length !== plan.people.length) {
    fail('AI 人物数量不匹配', 'ARCHIVE_V2_PROFILE_GENERATION_FORMAT');
  }
  const plannedIds = new Set(plan.people.map(person => person.identityId));
  const byId = new Map();
  const sourceByCode = new Map(sources.map(source => [source.code, source]));
  let totalCharacters = 0;
  for (const item of value.people) {
    exactKeys(item, AI_PERSON_KEYS, 'AI person');
    if (typeof item.identityId !== 'string' || !plannedIds.has(item.identityId) || byId.has(item.identityId)) {
      fail('AI identityId 无效', 'ARCHIVE_V2_PROFILE_GENERATION_FORMAT');
    }
    exactKeys(item.fields, new Set(ARCHIVE_V2_PROFILE_FIELD_KEYS), 'AI fields');
    const fields = {};
    for (const key of ARCHIVE_V2_PROFILE_FIELD_KEYS) {
      const field = item.fields[key];
      exactKeys(field, AI_FIELD_KEYS, `AI field ${key}`);
      if (typeof field.value !== 'string' || field.value.length > ARCHIVE_V2_PROFILE_LIMITS.maxFieldCharacters) {
        fail('AI 字段值超限', 'ARCHIVE_V2_PROFILE_GENERATION_FORMAT');
      }
      totalCharacters += field.value.length;
      if (totalCharacters > ARCHIVE_V2_PROFILE_LIMITS.maxTotalFieldCharacters) {
        fail('AI 总字段值超限', 'ARCHIVE_V2_PROFILE_GENERATION_FORMAT');
      }
      const valueText = field.value.trim();
      if (!Array.isArray(field.evidence)
        || field.evidence.length > ARCHIVE_V2_RECOGNITION_LIMITS.maxEvidence) {
        fail('AI evidence 无效', 'ARCHIVE_V2_PROFILE_GENERATION_FORMAT');
      }
      const evidence = [];
      const seen = new Set();
      for (const code of field.evidence) {
        if (typeof code !== 'string' || !sourceByCode.has(code) || seen.has(code)) {
          fail('AI evidence 引用无效', 'ARCHIVE_V2_PROFILE_GENERATION_FORMAT');
        }
        seen.add(code);
        evidence.push(code);
      }
      if ((valueText === '' && evidence.length !== 0) || (valueText !== '' && evidence.length === 0)) {
        fail('AI 字段值与证据不一致', 'ARCHIVE_V2_PROFILE_GENERATION_FORMAT');
      }
      fields[key] = {
        value: valueText,
        origin: 'ai',
        sourceRefs: evidence.map(code => {
          const source = sourceByCode.get(code);
          return { kind: source.kind, locator: source.locator, fingerprint: source.fingerprint };
        }),
        userProtected: false,
      };
    }
    byId.set(item.identityId, fields);
  }
  if (byId.size !== plan.people.length) fail('AI 人物覆盖不完整', 'ARCHIVE_V2_PROFILE_GENERATION_FORMAT');
  return byId;
}

function mapDraft(plan, fieldsById) {
  return {
    schemaVersion: ARCHIVE_V2_PROFILE_DRAFT_SCHEMA_VERSION,
    kind: ARCHIVE_V2_PROFILE_DRAFT_KIND,
    chatId: plan.chatId,
    sourceFingerprint: plan.sourceFingerprint,
    people: plan.people.map(person => ({
      identityId: person.identityId,
      displayName: person.displayName,
      aliases: [...person.aliases],
      recognitionReason: person.recognitionReason,
      sourceRefs: person.sourceRefs.map(ref => ({ ...ref })),
      fields: fieldsById.get(person.identityId),
    })),
  };
}

export function createArchiveV2ProfileGenerator({ contextProvider, generateTask, isEnabled = true } = {}) {
  if (typeof contextProvider !== 'function') throw new TypeError('contextProvider 必须是函数');
  if (typeof generateTask !== 'function') throw new TypeError('generateTask 必须是函数');
  if (typeof isEnabled !== 'boolean' && typeof isEnabled !== 'function') throw new TypeError('isEnabled 无效');
  let epoch = 0;
  let active = null;
  const enabled = () => (typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true;
  const current = operation => {
    if (operation.epoch !== epoch || !enabled()) return false;
    try { return sameSnapshot(operation.snapshot, captureSnapshot(contextProvider)); }
    catch { return false; }
  };

  function generate({ plan, sources } = {}) {
    if (active) return active.promise;
    if (!enabled()) return Promise.resolve({ status: 'disabled' });
    let snapshot;
    try { snapshot = captureSnapshot(contextProvider); }
    catch (error) { return Promise.reject(error); }
    const operation = { epoch, snapshot, controller: new AbortController(), promise: null };
    operation.promise = (async () => {
      let safePlan;
      try { safePlan = validatePlan(plan); }
      catch (error) { if (!current(operation)) return { status: 'stale' }; throw error; }
      if (safePlan.chatId !== snapshot.chatId) fail('plan.chatId 与当前聊天不一致');
      if (safePlan.people.length === 0) return current(operation) ? { status: 'empty' } : { status: 'stale' };

      let safeSources;
      try {
        safeSources = selectedSources(sources);
        const fingerprint = await computeArchiveV2SourceFingerprint(safeSources);
        if (fingerprint !== safePlan.sourceFingerprint) {
          fail('来源指纹与计划不一致', 'ARCHIVE_V2_PROFILE_GENERATION_SOURCE_MISMATCH');
        }
        validatePlanRefs(safePlan, safeSources);
      } catch (error) {
        if (!current(operation)) return { status: 'stale' };
        throw error;
      }
      if (!current(operation)) return { status: 'stale' };

      let response;
      try {
        response = await generateTask({
          includeCharacterCard: false,
          worldInfoSource: 'none',
          substituteMacros: false,
          systemPrompt: 'Generate basic profile fields only for the supplied confirmed people and coded sources. Return only the requested JSON object.',
          taskMessages: [{ role: 'user', content: promptFor(safePlan, safeSources) }],
          jsonSchema: { name: 'qianqianjie_v2_people_profiles', value: PROFILE_SCHEMA, strict: true },
          signal: operation.controller.signal,
          maxTokens: 30000,
          temperature: 0.2,
        });
      } catch {
        if (!current(operation)) return { status: 'stale' };
        throw new ArchiveV2ProfileGenerationError('基础档案生成请求失败', 'ARCHIVE_V2_PROFILE_GENERATION_FAILED');
      }
      if (!current(operation)) return { status: 'stale' };
      let fieldsById;
      try { fieldsById = validateAiOutput(unwrapTaskResult(response), safePlan, safeSources); }
      catch (error) {
        if (!current(operation)) return { status: 'stale' };
        throw new ArchiveV2ProfileGenerationError('基础档案结果格式无效', 'ARCHIVE_V2_PROFILE_GENERATION_FORMAT');
      }
      if (!current(operation)) return { status: 'stale' };
      const draft = mapDraft(safePlan, fieldsById);
      return current(operation) ? { status: 'ready', draft } : { status: 'stale' };
    })();
    active = operation;
    operation.promise.then(
      () => { if (active === operation) active = null; },
      () => { if (active === operation) active = null; },
    );
    return operation.promise;
  }

  function invalidate() {
    epoch += 1;
    active?.controller.abort();
  }

  return Object.freeze({ generate, invalidate, cancel: invalidate });
}
