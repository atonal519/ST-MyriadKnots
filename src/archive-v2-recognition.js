import { newIdentityUuid } from './identity.js';
import { parseJsonOutput } from './compact-api-client.js';
import { computeArchiveV2SourceFingerprint } from './archive-v2-source-fingerprint.js';

export const ARCHIVE_V2_CANDIDATE_DRAFT_SCHEMA_VERSION = 1;
export const ARCHIVE_V2_CANDIDATE_DRAFT_KIND = 'myriad-knots-candidate-draft';

export const ARCHIVE_V2_RECOGNITION_LIMITS = Object.freeze({
  maxSources: 80,
  maxSourceCharacters: 24000,
  maxTotalSourceCharacters: 120000,
  maxCandidates: 80,
  maxNameCharacters: 120,
  maxAliases: 12,
  maxAliasCharacters: 120,
  maxReasonCharacters: 500,
  maxEvidence: 12,
});

const SOURCE_KINDS = new Set(['card', 'greeting', 'worldbook', 'chat']);
const SOURCE_AVAILABILITY = new Set(['card', 'greeting', 'activated', 'enabled', 'disabled', 'chat']);
const PERSON_KEYS = new Set(['name', 'aliases', 'reason', 'evidence']);

const RECOGNITION_SCHEMA = Object.freeze({
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
        required: ['name', 'reason', 'evidence'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: ARCHIVE_V2_RECOGNITION_LIMITS.maxNameCharacters },
          aliases: {
            type: 'array',
            maxItems: ARCHIVE_V2_RECOGNITION_LIMITS.maxAliases,
            items: { type: 'string', minLength: 1, maxLength: ARCHIVE_V2_RECOGNITION_LIMITS.maxAliasCharacters },
          },
          reason: { type: 'string', minLength: 1, maxLength: ARCHIVE_V2_RECOGNITION_LIMITS.maxReasonCharacters },
          evidence: {
            type: 'array',
            minItems: 1,
            maxItems: ARCHIVE_V2_RECOGNITION_LIMITS.maxEvidence,
            items: { type: 'string', pattern: '^S[1-9][0-9]*$' },
          },
        },
      },
    },
  },
});

export class ArchiveV2RecognitionError extends Error {
  constructor(message, code = 'ARCHIVE_V2_RECOGNITION_INVALID') {
    super(message);
    this.name = 'ArchiveV2RecognitionError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new ArchiveV2RecognitionError(message, code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireNonEmptyString(value, maxLength, field) {
  if (typeof value !== 'string' || value.length > maxLength || !value.trim()) {
    fail(`${field} 无效`, 'ARCHIVE_V2_RECOGNITION_FORMAT');
  }
  return value.trim();
}

function captureSnapshot(contextProvider) {
  const raw = contextProvider();
  if (!isPlainObject(raw)) fail('宿主上下文不可用', 'ARCHIVE_V2_RECOGNITION_CONTEXT_INVALID');
  const snapshot = {
    hostChatId: raw.hostChatId,
    chatId: raw.chatId,
    characterLocator: raw.characterLocator ?? raw.characterAvatar,
    personaLocator: raw.personaLocator ?? raw.personaAvatar,
  };
  for (const [key, value] of Object.entries(snapshot)) {
    if (typeof value !== 'string' || !value.trim()) {
      fail(`宿主 ${key} 无效`, 'ARCHIVE_V2_RECOGNITION_CONTEXT_INVALID');
    }
  }
  return Object.freeze({ ...snapshot });
}

function sameSnapshot(left, right) {
  return left.hostChatId === right.hostChatId
    && left.chatId === right.chatId
    && left.characterLocator === right.characterLocator
    && left.personaLocator === right.personaLocator;
}

function selectedSources(sources) {
  if (!Array.isArray(sources)) fail('来源必须是数组', 'ARCHIVE_V2_RECOGNITION_INPUT_INVALID');
  const selected = sources.filter(source => source?.selected === true && source?.availability !== 'disabled');
  if (!selected.length) fail('没有选中的可用来源', 'ARCHIVE_V2_RECOGNITION_NO_SOURCES');
  if (selected.length > ARCHIVE_V2_RECOGNITION_LIMITS.maxSources) {
    fail('选中来源超过上限', 'ARCHIVE_V2_RECOGNITION_SOURCE_LIMIT');
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
      fail('选中来源结构无效', 'ARCHIVE_V2_RECOGNITION_INPUT_INVALID');
    }
    if (source.content.length > ARCHIVE_V2_RECOGNITION_LIMITS.maxSourceCharacters) {
      fail('单个来源超过字符上限', 'ARCHIVE_V2_RECOGNITION_SOURCE_LIMIT');
    }
    totalCharacters += source.content.length;
    if (totalCharacters > ARCHIVE_V2_RECOGNITION_LIMITS.maxTotalSourceCharacters) {
      fail('来源总字符超过上限', 'ARCHIVE_V2_RECOGNITION_SOURCE_LIMIT');
    }
    const key = `${source.kind}\u0000${source.locator}`;
    if (seen.has(key)) fail('选中来源重复', 'ARCHIVE_V2_RECOGNITION_INPUT_INVALID');
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

function promptForSources(sources) {
  return [
    '只根据下列本次已选来源识别值得用户决定是否关注的人物候选。',
    '不得替用户决定关注，不得生成基础档案、关系阶段、好感度、事件或下一步。',
    '每项只返回 name、可选 aliases、简短具体 reason、以及 evidence 代号数组。',
    'evidence 只能使用下方 S1...Sn；没有可靠候选时返回 {"people":[]}。',
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

function validateAiOutput(value, sources) {
  if (!isPlainObject(value)
    || Reflect.ownKeys(value).length !== 1
    || !Object.hasOwn(value, 'people')
    || !Array.isArray(value.people)
    || value.people.length > ARCHIVE_V2_RECOGNITION_LIMITS.maxCandidates) {
    fail('AI 输出结构无效', 'ARCHIVE_V2_RECOGNITION_FORMAT');
  }
  const knownEvidence = new Set(sources.map(source => source.code));
  return value.people.map(item => {
    if (!isPlainObject(item)) fail('AI 人物项无效', 'ARCHIVE_V2_RECOGNITION_FORMAT');
    const keys = Reflect.ownKeys(item);
    if (keys.some(key => typeof key !== 'string' || !PERSON_KEYS.has(key))
      || !Object.hasOwn(item, 'name')
      || !Object.hasOwn(item, 'reason')
      || !Object.hasOwn(item, 'evidence')) {
      fail('AI 人物字段无效', 'ARCHIVE_V2_RECOGNITION_FORMAT');
    }
    const displayName = requireNonEmptyString(
      item.name,
      ARCHIVE_V2_RECOGNITION_LIMITS.maxNameCharacters,
      'name',
    );
    const reason = requireNonEmptyString(
      item.reason,
      ARCHIVE_V2_RECOGNITION_LIMITS.maxReasonCharacters,
      'reason',
    );
    const aliasesValue = item.aliases === undefined ? [] : item.aliases;
    if (!Array.isArray(aliasesValue) || aliasesValue.length > ARCHIVE_V2_RECOGNITION_LIMITS.maxAliases) {
      fail('aliases 无效', 'ARCHIVE_V2_RECOGNITION_FORMAT');
    }
    const aliases = aliasesValue.map(alias => requireNonEmptyString(
      alias,
      ARCHIVE_V2_RECOGNITION_LIMITS.maxAliasCharacters,
      'alias',
    ));
    if (!Array.isArray(item.evidence)
      || item.evidence.length < 1
      || item.evidence.length > ARCHIVE_V2_RECOGNITION_LIMITS.maxEvidence) {
      fail('evidence 无效', 'ARCHIVE_V2_RECOGNITION_FORMAT');
    }
    const evidence = [];
    const seen = new Set();
    for (const code of item.evidence) {
      if (typeof code !== 'string' || !knownEvidence.has(code) || seen.has(code)) {
        fail('evidence 引用无效', 'ARCHIVE_V2_RECOGNITION_FORMAT');
      }
      seen.add(code);
      evidence.push(code);
    }
    return { displayName, aliases, reason, evidence };
  });
}

function createCandidateId(createId, usedIds, index, chatId) {
  const candidateId = createId({ index, chatId });
  if (typeof candidateId !== 'string'
    || !candidateId.trim()
    || candidateId.length > 200
    || usedIds.has(candidateId)) {
    fail('candidateId 工厂返回无效或重复 ID', 'ARCHIVE_V2_RECOGNITION_ID_INVALID');
  }
  usedIds.add(candidateId);
  return candidateId;
}

function mapDraft(people, sources, snapshot, sourceFingerprint, createId) {
  const sourceByCode = new Map(sources.map(source => [source.code, source]));
  const usedIds = new Set();
  return {
    schemaVersion: ARCHIVE_V2_CANDIDATE_DRAFT_SCHEMA_VERSION,
    kind: ARCHIVE_V2_CANDIDATE_DRAFT_KIND,
    chatId: snapshot.chatId,
    sourceFingerprint,
    candidates: people.map((person, index) => ({
      candidateId: createCandidateId(createId, usedIds, index, snapshot.chatId),
      displayName: person.displayName,
      aliases: [...person.aliases],
      reason: person.reason,
      sourceRefs: person.evidence.map(code => {
        const source = sourceByCode.get(code);
        return { kind: source.kind, locator: source.locator, fingerprint: source.fingerprint };
      }),
    })),
  };
}

export function createArchiveV2CandidateRecognizer({
  contextProvider,
  generateTask,
  isEnabled = true,
  createId = newIdentityUuid,
} = {}) {
  if (typeof contextProvider !== 'function') throw new TypeError('contextProvider 必须是函数');
  if (typeof generateTask !== 'function') throw new TypeError('generateTask 必须是函数');
  if (typeof isEnabled !== 'boolean' && typeof isEnabled !== 'function') {
    throw new TypeError('isEnabled 必须是布尔值或函数');
  }
  if (typeof createId !== 'function') throw new TypeError('createId 必须是函数');

  let epoch = 0;
  let active = null;
  const enabled = () => (typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true;

  function current(operation) {
    if (operation.epoch !== epoch || !enabled()) return false;
    try {
      return sameSnapshot(operation.snapshot, captureSnapshot(contextProvider));
    } catch {
      return false;
    }
  }

  function recognize({ sources } = {}) {
    if (active) return active.promise;
    if (!enabled()) return Promise.resolve({ status: 'disabled' });
    let snapshot;
    try {
      snapshot = captureSnapshot(contextProvider);
    } catch (error) {
      return Promise.reject(error);
    }
    const controller = new AbortController();
    const operation = { epoch, snapshot, controller, promise: null };
    operation.promise = (async () => {
      let preparedSources;
      let sourceFingerprint;
      try {
        preparedSources = selectedSources(sources);
        sourceFingerprint = await computeArchiveV2SourceFingerprint(preparedSources);
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
          systemPrompt: 'You identify candidate people only from the supplied coded sources. Return only the requested JSON object.',
          taskMessages: [{ role: 'user', content: promptForSources(preparedSources) }],
          jsonSchema: { name: 'qianqianjie_v2_candidate_recognition', value: RECOGNITION_SCHEMA, strict: true },
          signal: controller.signal,
          maxTokens: 12000,
          temperature: 0.2,
        });
      } catch (error) {
        if (!current(operation)) return { status: 'stale' };
        throw new ArchiveV2RecognitionError('候选人物识别请求失败', 'ARCHIVE_V2_RECOGNITION_FAILED');
      }
      if (!current(operation)) return { status: 'stale' };

      let people;
      try {
        people = validateAiOutput(unwrapTaskResult(response), preparedSources);
      } catch (error) {
        if (!current(operation)) return { status: 'stale' };
        if (error instanceof ArchiveV2RecognitionError) throw error;
        throw new ArchiveV2RecognitionError('候选人物识别格式无效', 'ARCHIVE_V2_RECOGNITION_FORMAT');
      }
      if (!current(operation)) return { status: 'stale' };
      const draft = mapDraft(people, preparedSources, snapshot, sourceFingerprint, createId);
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

  return Object.freeze({
    recognize,
    invalidate,
    cancel: invalidate,
    getState() {
      return { status: !enabled() ? 'disabled' : active ? 'running' : 'idle' };
    },
  });
}
