import { validateArchiveV2 } from './archive-v2.js';

const READ_TERMINAL_STATUSES = new Set(['uninitialized', 'stale', 'disabled']);
const CREATE_TERMINAL_STATUSES = new Set(['conflict', 'stale', 'disabled']);
const TERMINAL_KEYS = new Set(['status']);
const READY_KEYS = new Set(['status', 'archive', 'revision', 'warnings']);

export class ArchiveV2InitializationCommitError extends Error {
  constructor(message, code = 'ARCHIVE_V2_INITIALIZATION_COMMIT_INVALID') {
    super(message);
    this.name = 'ArchiveV2InitializationCommitError';
    this.code = code;
  }
}

function fail(message, code = 'ARCHIVE_V2_INITIALIZATION_COMMIT_CONTRACT') {
  throw new ArchiveV2InitializationCommitError(message, code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value, path = 'result', ancestors = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} 不是合法 JSON`);
    return value;
  }
  if (typeof value !== 'object') fail(`${path} 不是合法 JSON`);
  if (ancestors.has(value)) fail(`${path} 不得循环引用`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (Object.getOwnPropertySymbols(value).length > 0
        || keys.length !== value.length + 1
        || !keys.includes('length')) {
        fail(`${path} 必须是连续 JSON 数组`);
      }
      const output = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
          fail(`${path} 必须是连续 JSON 数组`);
        }
        output.push(cloneJson(descriptor.value, `${path}[${index}]`, ancestors));
      }
      return output;
    }
    if (!isPlainObject(value)) fail(`${path} 必须是普通 JSON 对象`);
    const output = {};
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        fail(`${path} 必须是普通 JSON 对象`);
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

function safeContractClone(value, label) {
  try {
    return cloneJson(value, label);
  } catch (error) {
    if (error instanceof ArchiveV2InitializationCommitError) throw error;
    throw new ArchiveV2InitializationCommitError(
      `${label} 无法安全读取`,
      'ARCHIVE_V2_INITIALIZATION_COMMIT_CONTRACT',
    );
  }
}

function exactKeys(value, allowed, label) {
  if (!isPlainObject(value)) fail(`${label} 必须是对象`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== allowed.size || keys.some(key => typeof key !== 'string' || !allowed.has(key))) {
    fail(`${label} 字段无效`);
  }
}

function validateReadyResult(value, expectedStatus, expectedChatId, label) {
  exactKeys(value, READY_KEYS, label);
  if (value.status !== expectedStatus
    || !Number.isInteger(value.revision)
    || value.revision < 1
    || !Array.isArray(value.warnings)
    || value.warnings.some(warning => typeof warning !== 'string')) {
    fail(`${label} 内容无效`);
  }
  let archive;
  try {
    archive = validateArchiveV2(value.archive, { expectedChatId });
  } catch {
    fail(`${label}.archive 无效`);
  }
  return {
    status: expectedStatus,
    archive,
    revision: value.revision,
    warnings: [...value.warnings],
  };
}

function validateReadResult(raw, expectedChatId) {
  const value = safeContractClone(raw, 'read result');
  if (value?.status === 'ready') return validateReadyResult(value, 'ready', expectedChatId, 'read result');
  if (!READ_TERMINAL_STATUSES.has(value?.status)) fail('read 返回未知状态');
  exactKeys(value, TERMINAL_KEYS, 'read result');
  return { status: value.status };
}

function validateCreateResult(raw, expectedChatId) {
  const value = safeContractClone(raw, 'create result');
  if (value?.status === 'created') return validateReadyResult(value, 'created', expectedChatId, 'create result');
  if (!CREATE_TERMINAL_STATUSES.has(value?.status)) fail('create 返回未知状态');
  exactKeys(value, TERMINAL_KEYS, 'create result');
  return { status: value.status };
}

function prepareArchive(archive) {
  let firstCopy;
  try {
    firstCopy = validateArchiveV2(archive);
    if (typeof firstCopy.chatId !== 'string' || !firstCopy.chatId.trim()) fail('archive.chatId 无效');
    return validateArchiveV2(firstCopy, { expectedChatId: firstCopy.chatId });
  } catch (error) {
    if (error instanceof ArchiveV2InitializationCommitError) throw error;
    throw new ArchiveV2InitializationCommitError(
      '待创建 archive 无效',
      'ARCHIVE_V2_INITIALIZATION_COMMIT_ARCHIVE_INVALID',
    );
  }
}

export function createArchiveV2InitializationCommitter({ archiveAdapter } = {}) {
  if (typeof archiveAdapter?.read !== 'function' || typeof archiveAdapter?.create !== 'function') {
    throw new TypeError('archiveAdapter 必须提供 read 和 create');
  }
  let active = null;

  function commit({ archive } = {}) {
    if (active) return active;
    let safeArchive;
    try {
      safeArchive = prepareArchive(archive);
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = (async () => {
      const readResult = validateReadResult(await archiveAdapter.read(), safeArchive.chatId);
      if (readResult.status === 'ready') {
        return {
          status: 'already_initialized',
          archive: readResult.archive,
          revision: readResult.revision,
          warnings: readResult.warnings,
        };
      }
      if (readResult.status !== 'uninitialized') return { status: readResult.status };
      return validateCreateResult(
        await archiveAdapter.create({ archive: safeArchive }),
        safeArchive.chatId,
      );
    })();
    active = operation;
    operation.then(
      () => { if (active === operation) active = null; },
      () => { if (active === operation) active = null; },
    );
    return operation;
  }

  return Object.freeze({ commit });
}
