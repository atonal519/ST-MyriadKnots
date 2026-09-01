export const ARCHIVE_V2_SCHEMA_VERSION = 1;
export const ARCHIVE_V2_KIND = 'myriad-knots-archive';
export const ARCHIVE_V2_RECORD_ID = 'archive-v2';

const ARCHIVE_V2_ROOT_KEYS = new Set([
  'schemaVersion',
  'kind',
  'chatId',
  'identity',
  'initialization',
  'people',
  'events',
  'bonds',
  'nextSteps',
  'progress',
]);

export const ARCHIVE_V2_WARNING = Object.freeze({
  PERSONA_MISMATCH: 'persona_mismatch',
  CHARACTER_MISMATCH: 'character_mismatch',
});

export class ArchiveV2ValidationError extends Error {
  constructor(message, code = 'ARCHIVE_V2_INVALID') {
    super(message);
    this.name = 'ArchiveV2ValidationError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new ArchiveV2ValidationError(message, code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value, path = 'archive', ancestors = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} 必须是合法 JSON`, 'ARCHIVE_V2_NOT_JSON');
    return value;
  }
  if (value === null || typeof value !== 'object') {
    fail(`${path} 必须是合法 JSON`, 'ARCHIVE_V2_NOT_JSON');
  }
  if (ancestors.has(value)) fail(`${path} 不得包含循环引用`, 'ARCHIVE_V2_NOT_JSON');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      if (Object.getOwnPropertySymbols(value).length > 0
        || ownKeys.length !== value.length + 1
        || !ownKeys.includes('length')) {
        fail(`${path} 必须是连续 JSON 数组`, 'ARCHIVE_V2_NOT_JSON');
      }
      const copy = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
          fail(`${path} 必须是连续 JSON 数组`, 'ARCHIVE_V2_NOT_JSON');
        }
        copy.push(cloneJson(descriptor.value, `${path}[${index}]`, ancestors));
      }
      return copy;
    }
    if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) {
      fail(`${path} 必须是合法 JSON 对象`, 'ARCHIVE_V2_NOT_JSON');
    }
    const copy = {};
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        fail(`${path} 必须是合法 JSON 对象`, 'ARCHIVE_V2_NOT_JSON');
      }
      Object.defineProperty(copy, key, {
        value: cloneJson(descriptor.value, `${path}.${key}`, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

function requireObject(value, path) {
  if (!isPlainObject(value)) fail(`${path} 必须是对象`, 'ARCHIVE_V2_CONTAINER_INVALID');
}

function requireArray(value, path) {
  if (!Array.isArray(value)) fail(`${path} 必须是数组`, 'ARCHIVE_V2_CONTAINER_INVALID');
}

function requireNonEmptyString(value, path) {
  if (typeof value !== 'string' || !value.trim()) fail(`${path} 必须是非空字符串`, 'ARCHIVE_V2_FIELD_INVALID');
}

function validateSourceRef(value, path) {
  requireObject(value, path);
  for (const key of ['kind', 'locator', 'fingerprint']) {
    if (typeof value[key] !== 'string') fail(`${path}.${key} 必须是字符串`, 'ARCHIVE_V2_FIELD_INVALID');
  }
}

function validateOwnership(value, path, valueKind) {
  requireObject(value, path);
  if (!Object.hasOwn(value, 'value')) fail(`${path}.value 缺失`, 'ARCHIVE_V2_FIELD_INVALID');
  requireNonEmptyString(value.origin, `${path}.origin`);
  requireArray(value.sourceRefs, `${path}.sourceRefs`);
  value.sourceRefs.forEach((ref, index) => validateSourceRef(ref, `${path}.sourceRefs[${index}]`));
  if (typeof value.userProtected !== 'boolean') {
    fail(`${path}.userProtected 必须是布尔值`, 'ARCHIVE_V2_FIELD_INVALID');
  }
  if (valueKind === 'string' && typeof value.value !== 'string') {
    fail(`${path}.value 必须是字符串`, 'ARCHIVE_V2_FIELD_INVALID');
  }
  if (valueKind === 'string-array'
    && (!Array.isArray(value.value) || value.value.some(item => typeof item !== 'string'))) {
    fail(`${path}.value 必须是字符串数组`, 'ARCHIVE_V2_FIELD_INVALID');
  }
}

function validatePerson(value, identityId, path) {
  requireObject(value, path);
  if (value.identityId !== identityId) fail(`${path}.identityId 与索引不一致`, 'ARCHIVE_V2_PEOPLE_INVALID');
  if (Object.hasOwn(value, 'followed') && typeof value.followed !== 'boolean') {
    fail(`${path}.followed 必须是布尔值`, 'ARCHIVE_V2_FIELD_INVALID');
  }
  if (Object.hasOwn(value, 'sourceRefs')) requireArray(value.sourceRefs, `${path}.sourceRefs`);
  if (Object.hasOwn(value, 'displayName')) validateOwnership(value.displayName, `${path}.displayName`, 'string');
  if (Object.hasOwn(value, 'aliases')) validateOwnership(value.aliases, `${path}.aliases`, 'string-array');
  if (Object.hasOwn(value, 'fields')) {
    requireObject(value.fields, `${path}.fields`);
    for (const field of Object.keys(value.fields)) {
      validateOwnership(value.fields[field], `${path}.fields.${field}`);
    }
  }
}

function validatePeople(value) {
  requireObject(value, 'archive.people');
  requireArray(value.order, 'archive.people.order');
  requireObject(value.byId, 'archive.people.byId');
  const orderIds = new Set();
  for (const identityId of value.order) {
    requireNonEmptyString(identityId, 'archive.people.order identityId');
    if (orderIds.has(identityId)) fail('archive.people.order 不得重复', 'ARCHIVE_V2_PEOPLE_INVALID');
    orderIds.add(identityId);
  }
  const byIdKeys = Object.keys(value.byId);
  if (byIdKeys.length !== orderIds.size || byIdKeys.some(identityId => !orderIds.has(identityId))) {
    fail('archive.people.order 与 byId 不一致', 'ARCHIVE_V2_PEOPLE_INVALID');
  }
  for (const identityId of value.order) {
    if (!Object.hasOwn(value.byId, identityId)) {
      fail('archive.people.order 指向不存在的人物', 'ARCHIVE_V2_PEOPLE_INVALID');
    }
    validatePerson(value.byId[identityId], identityId, `archive.people.byId.${identityId}`);
  }
}

export function createEmptyArchiveV2({
  chatId,
  characterLocator,
  personaLocator,
  personaSummary = '',
} = {}) {
  const archive = {
    schemaVersion: ARCHIVE_V2_SCHEMA_VERSION,
    kind: ARCHIVE_V2_KIND,
    chatId,
    identity: {
      characterLocator,
      personaLocator,
      personaSummary,
    },
    initialization: {
      confirmedAt: null,
      sources: [],
    },
    people: {
      order: [],
      byId: {},
    },
    events: [],
    bonds: {},
    nextSteps: {
      items: [],
    },
    progress: {
      lastConfirmedFloor: null,
    },
  };
  return validateArchiveV2(archive, { expectedChatId: chatId });
}

function validateArchiveV2Internal(data, expectedChatId) {
  requireObject(data, 'archive');
  for (const key of Reflect.ownKeys(data)) {
    if (typeof key !== 'string' || !ARCHIVE_V2_ROOT_KEYS.has(key)) {
      fail('archive 包含未知顶层字段', 'ARCHIVE_V2_ROOT_KEY_UNKNOWN');
    }
  }
  if (data.schemaVersion !== ARCHIVE_V2_SCHEMA_VERSION) {
    fail('archive.schemaVersion 不受支持', 'ARCHIVE_V2_SCHEMA_UNSUPPORTED');
  }
  if (data.kind !== ARCHIVE_V2_KIND) fail('archive.kind 不匹配', 'ARCHIVE_V2_KIND_MISMATCH');
  requireNonEmptyString(data.chatId, 'archive.chatId');
  if (expectedChatId !== undefined && data.chatId !== expectedChatId) {
    fail('archive.chatId 与当前聊天不一致', 'ARCHIVE_V2_CHAT_MISMATCH');
  }

  requireObject(data.identity, 'archive.identity');
  requireNonEmptyString(data.identity.characterLocator, 'archive.identity.characterLocator');
  requireNonEmptyString(data.identity.personaLocator, 'archive.identity.personaLocator');
  if (typeof data.identity.personaSummary !== 'string') {
    fail('archive.identity.personaSummary 必须是字符串', 'ARCHIVE_V2_FIELD_INVALID');
  }

  requireObject(data.initialization, 'archive.initialization');
  if (data.initialization.confirmedAt !== null && typeof data.initialization.confirmedAt !== 'string') {
    fail('archive.initialization.confirmedAt 必须是 null 或字符串', 'ARCHIVE_V2_FIELD_INVALID');
  }
  requireArray(data.initialization.sources, 'archive.initialization.sources');
  if (Object.hasOwn(data.initialization, 'sourceFingerprint')) {
    requireNonEmptyString(data.initialization.sourceFingerprint, 'archive.initialization.sourceFingerprint');
  }
  data.initialization.sources.forEach((source, index) => {
    const path = `archive.initialization.sources[${index}]`;
    requireObject(source, path);
    for (const key of ['kind', 'locator', 'fingerprint', 'content']) {
      if (typeof source[key] !== 'string') fail(`${path}.${key} 必须是字符串`, 'ARCHIVE_V2_FIELD_INVALID');
    }
  });

  validatePeople(data.people);
  requireArray(data.events, 'archive.events');
  requireObject(data.bonds, 'archive.bonds');
  requireObject(data.nextSteps, 'archive.nextSteps');
  requireArray(data.nextSteps.items, 'archive.nextSteps.items');
  requireObject(data.progress, 'archive.progress');
  if (data.progress.lastConfirmedFloor !== null
    && (!Number.isInteger(data.progress.lastConfirmedFloor) || data.progress.lastConfirmedFloor < 0)) {
    fail('archive.progress.lastConfirmedFloor 必须是 null 或非负整数', 'ARCHIVE_V2_FIELD_INVALID');
  }

  return data;
}

export function validateArchiveV2(data, { expectedChatId } = {}) {
  try {
    return validateArchiveV2Internal(cloneJson(data), expectedChatId);
  } catch (error) {
    if (error instanceof ArchiveV2ValidationError) throw error;
    throw new ArchiveV2ValidationError('archive 无法安全验证或复制', 'ARCHIVE_V2_CLONE_FAILED');
  }
}

function captureHostSnapshot(contextProvider) {
  const raw = contextProvider();
  if (!isPlainObject(raw)) fail('宿主快照不可用', 'ARCHIVE_V2_CONTEXT_INVALID');
  const snapshot = {
    hostChatId: raw.hostChatId,
    chatId: raw.chatId,
    characterLocator: raw.characterLocator ?? raw.characterAvatar,
    personaLocator: raw.personaLocator ?? raw.personaAvatar,
  };
  for (const [key, value] of Object.entries(snapshot)) requireNonEmptyString(value, `context.${key}`);
  return Object.freeze(snapshot);
}

function sameSnapshot(left, right) {
  return left.hostChatId === right.hostChatId
    && left.chatId === right.chatId
    && left.characterLocator === right.characterLocator
    && left.personaLocator === right.personaLocator;
}

function validateEnvelope(envelope, expectedChatId) {
  if (!isPlainObject(envelope) || !Number.isInteger(envelope.revision) || envelope.revision < 1) {
    fail('后端记录外壳无效', 'ARCHIVE_V2_ENVELOPE_INVALID');
  }
  return {
    archive: validateArchiveV2(envelope.data, { expectedChatId }),
    revision: envelope.revision,
  };
}

function warningsFor(archive, snapshot) {
  const warnings = [];
  if (archive.identity.personaLocator !== snapshot.personaLocator) {
    warnings.push(ARCHIVE_V2_WARNING.PERSONA_MISMATCH);
  }
  if (archive.identity.characterLocator !== snapshot.characterLocator) {
    warnings.push(ARCHIVE_V2_WARNING.CHARACTER_MISMATCH);
  }
  return warnings;
}

export function createArchiveV2Adapter({ client, contextProvider, isEnabled = true } = {}) {
  if (typeof client?.get !== 'function' || typeof client?.put !== 'function') {
    throw new TypeError('archive-v2 client 必须提供 get 和 put');
  }
  if (typeof contextProvider !== 'function') throw new TypeError('archive-v2 contextProvider 必须是函数');
  if (typeof isEnabled !== 'boolean' && typeof isEnabled !== 'function') {
    throw new TypeError('archive-v2 isEnabled 必须是布尔值或函数');
  }

  let epoch = 0;
  let queue = Promise.resolve();
  const enabled = () => (typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true;

  function operationState(operation) {
    if (operation.epoch !== epoch) return 'stale';
    if (!enabled()) return 'disabled';
    try {
      return sameSnapshot(operation.snapshot, captureHostSnapshot(contextProvider)) ? 'current' : 'stale';
    } catch {
      return 'stale';
    }
  }

  function enqueue(run, prepare = value => value) {
    let operation;
    let prepared;
    try {
      operation = { epoch, snapshot: captureHostSnapshot(contextProvider) };
      prepared = prepare(operation.snapshot);
    } catch (error) {
      return Promise.reject(error);
    }

    const task = queue.then(async () => {
      const before = operationState(operation);
      if (before !== 'current') return { status: before };
      try {
        const result = await run(operation.snapshot, prepared);
        const after = operationState(operation);
        return after === 'current' ? result : { status: 'stale' };
      } catch (error) {
        if (operationState(operation) !== 'current') return { status: 'stale' };
        throw error;
      }
    });
    queue = task.then(() => undefined, () => undefined);
    return task;
  }

  async function readRecord(snapshot) {
    let envelope;
    try {
      envelope = await client.get(`chat-${snapshot.chatId}`, ARCHIVE_V2_RECORD_ID);
    } catch (error) {
      if (error?.status === 404) return { status: 'uninitialized' };
      throw error;
    }
    const { archive, revision } = validateEnvelope(envelope, snapshot.chatId);
    return { status: 'ready', archive, revision, warnings: warningsFor(archive, snapshot) };
  }

  async function writeRecord(snapshot, { archive, expectedRevision, successStatus, signal }) {
    let envelope;
    try {
      envelope = await client.put(
        `chat-${snapshot.chatId}`,
        ARCHIVE_V2_RECORD_ID,
        archive,
        expectedRevision,
        { signal },
      );
    } catch (error) {
      if (error?.status === 409) return { status: 'conflict' };
      throw error;
    }
    const saved = validateEnvelope(envelope, snapshot.chatId);
    return {
      status: successStatus,
      archive: saved.archive,
      revision: saved.revision,
      warnings: warningsFor(saved.archive, snapshot),
    };
  }

  return Object.freeze({
    read() {
      return enqueue(snapshot => readRecord(snapshot));
    },
    create({ archive, signal } = {}) {
      return enqueue(
        (snapshot, safeArchive) => writeRecord(snapshot, {
          archive: safeArchive,
          expectedRevision: 0,
          successStatus: 'created',
          signal,
        }),
        snapshot => validateArchiveV2(archive, { expectedChatId: snapshot.chatId }),
      );
    },
    save({ archive, expectedRevision, signal } = {}) {
      return enqueue(
        (snapshot, safeArchive) => writeRecord(snapshot, {
          archive: safeArchive,
          expectedRevision,
          successStatus: 'saved',
          signal,
        }),
        snapshot => {
          if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
            fail('expectedRevision 必须是正整数', 'ARCHIVE_V2_REVISION_INVALID');
          }
          return validateArchiveV2(archive, { expectedChatId: snapshot.chatId });
        },
      );
    },
    invalidate() {
      epoch += 1;
    },
  });
}
