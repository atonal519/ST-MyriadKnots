import { collectArchiveV2InitializationSources } from './archive-v2-sources.js';
import {
  buildArchiveV2SelectedPeoplePlan,
  createArchiveV2CandidateReview,
  mergeArchiveV2Candidates,
  removeArchiveV2Candidate,
  renameArchiveV2Candidate,
  setArchiveV2CandidateAliases,
  setArchiveV2CandidateSelected,
} from './archive-v2-candidate-review.js';
import {
  buildInitializedArchiveV2,
  createArchiveV2InitializationReview,
  setArchiveV2InitializationField,
} from './archive-v2-initialization-review.js';

const STAGES = new Set(['idle', 'sources', 'candidates', 'profiles', 'completed']);
const SOURCE_RESULT_KEYS = new Set(['status', 'candidates', 'warnings']);
const SOURCE_KEYS = new Set([
  'id',
  'kind',
  'locator',
  'fingerprint',
  'label',
  'content',
  'selected',
  'availability',
]);
const WARNING_KEYS = new Set(['code']);
const READY_RESULT_KEYS = new Set(['status', 'draft']);
const STATUS_RESULT_KEYS = new Set(['status']);
const COMMITTED_RESULT_KEYS = new Set(['status', 'archive', 'revision', 'warnings']);

export class ArchiveV2InitializationFlowError extends Error {
  constructor(message, code = 'ARCHIVE_V2_INITIALIZATION_FLOW_INVALID') {
    super(message);
    this.name = 'ArchiveV2InitializationFlowError';
    this.code = code;
  }
}

function fail(message, code = 'ARCHIVE_V2_INITIALIZATION_FLOW_INVALID') {
  throw new ArchiveV2InitializationFlowError(message, code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value, path = 'value', ancestors = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} 必须是合法 JSON`, 'ARCHIVE_V2_INITIALIZATION_FLOW_NOT_JSON');
    return value;
  }
  if (typeof value !== 'object') {
    fail(`${path} 必须是合法 JSON`, 'ARCHIVE_V2_INITIALIZATION_FLOW_NOT_JSON');
  }
  if (ancestors.has(value)) {
    fail(`${path} 不得循环引用`, 'ARCHIVE_V2_INITIALIZATION_FLOW_NOT_JSON');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (Object.getOwnPropertySymbols(value).length > 0
        || keys.length !== value.length + 1
        || !keys.includes('length')) {
        fail(`${path} 必须是连续 JSON 数组`, 'ARCHIVE_V2_INITIALIZATION_FLOW_NOT_JSON');
      }
      const output = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
          fail(`${path} 必须是连续 JSON 数组`, 'ARCHIVE_V2_INITIALIZATION_FLOW_NOT_JSON');
        }
        output.push(cloneJson(descriptor.value, `${path}[${index}]`, ancestors));
      }
      return output;
    }
    if (!isPlainObject(value)) {
      fail(`${path} 必须是普通 JSON 对象`, 'ARCHIVE_V2_INITIALIZATION_FLOW_NOT_JSON');
    }
    const output = {};
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        fail(`${path} 必须是普通 JSON 对象`, 'ARCHIVE_V2_INITIALIZATION_FLOW_NOT_JSON');
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
    if (error instanceof ArchiveV2InitializationFlowError) throw error;
    throw new ArchiveV2InitializationFlowError(
      `${path} 无法安全读取`,
      'ARCHIVE_V2_INITIALIZATION_FLOW_NOT_JSON',
    );
  }
}

function exactKeys(value, allowed, label) {
  if (!isPlainObject(value)) fail(`${label} 必须是对象`, 'ARCHIVE_V2_INITIALIZATION_FLOW_CONTRACT');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== allowed.size || keys.some(key => typeof key !== 'string' || !allowed.has(key))) {
    fail(`${label} 字段无效`, 'ARCHIVE_V2_INITIALIZATION_FLOW_CONTRACT');
  }
}

function initialState() {
  return {
    stage: 'idle',
    sources: [],
    warnings: [],
    candidateReview: null,
    profileReview: null,
    result: null,
  };
}

function captureSourceContext(sourceContextProvider) {
  let context;
  try {
    context = sourceContextProvider();
    if (context === null || (typeof context !== 'object' && typeof context !== 'function')) {
      fail('来源宿主上下文无效', 'ARCHIVE_V2_INITIALIZATION_FLOW_CONTEXT_INVALID');
    }
    const snapshot = {
      hostChatId: context.hostChatId,
      chatId: context.chatId,
      characterLocator: context.characterLocator ?? context.characterAvatar,
      personaLocator: context.personaLocator ?? context.personaAvatar,
    };
    for (const value of Object.values(snapshot)) {
      if (typeof value !== 'string' || !value.trim()) {
        fail('来源宿主身份无效', 'ARCHIVE_V2_INITIALIZATION_FLOW_CONTEXT_INVALID');
      }
    }
    return { context, snapshot: Object.freeze({ ...snapshot }) };
  } catch (error) {
    if (error instanceof ArchiveV2InitializationFlowError) throw error;
    throw new ArchiveV2InitializationFlowError(
      '来源宿主上下文读取失败',
      'ARCHIVE_V2_INITIALIZATION_FLOW_CONTEXT_INVALID',
    );
  }
}

function sameSnapshot(left, right) {
  return left.hostChatId === right.hostChatId
    && left.chatId === right.chatId
    && left.characterLocator === right.characterLocator
    && left.personaLocator === right.personaLocator;
}

function validateSourceResult(raw) {
  const value = safeClone(raw, 'source result');
  exactKeys(value, SOURCE_RESULT_KEYS, 'source result');
  if (value.status !== 'ready' || !Array.isArray(value.candidates) || !Array.isArray(value.warnings)) {
    fail('source result 状态无效', 'ARCHIVE_V2_INITIALIZATION_FLOW_CONTRACT');
  }
  const ids = new Set();
  const candidates = value.candidates.map(candidate => {
    exactKeys(candidate, SOURCE_KEYS, 'source candidate');
    for (const field of ['id', 'kind', 'locator', 'fingerprint', 'label', 'content', 'availability']) {
      if (typeof candidate[field] !== 'string' || !candidate[field]) {
        fail(`source candidate.${field} 无效`, 'ARCHIVE_V2_INITIALIZATION_FLOW_CONTRACT');
      }
    }
    if (typeof candidate.selected !== 'boolean'
      || (candidate.availability === 'disabled' && candidate.selected)
      || ids.has(candidate.id)) {
      fail('来源 selected 或 id 无效', 'ARCHIVE_V2_INITIALIZATION_FLOW_CONTRACT');
    }
    ids.add(candidate.id);
    return { ...candidate };
  });
  const warnings = value.warnings.map(warning => {
    exactKeys(warning, WARNING_KEYS, 'source warning');
    if (typeof warning.code !== 'string' || !warning.code) {
      fail('source warning.code 无效', 'ARCHIVE_V2_INITIALIZATION_FLOW_CONTRACT');
    }
    return { code: warning.code };
  });
  return { candidates, warnings };
}

function validateTaskResult(raw, { readyStatus = 'ready', terminalStatuses, label }) {
  const value = safeClone(raw, `${label} result`);
  if (value?.status === readyStatus) {
    exactKeys(value, READY_RESULT_KEYS, `${label} result`);
    return { status: readyStatus, draft: value.draft };
  }
  if (!terminalStatuses.has(value?.status)) {
    fail(`${label} 返回未知状态`, 'ARCHIVE_V2_INITIALIZATION_FLOW_CONTRACT');
  }
  exactKeys(value, STATUS_RESULT_KEYS, `${label} result`);
  return { status: value.status };
}

function validateCommitResult(raw) {
  const value = safeClone(raw, 'commit result');
  if (value?.status === 'created' || value?.status === 'already_initialized') {
    exactKeys(value, COMMITTED_RESULT_KEYS, 'commit result');
    if (!Number.isInteger(value.revision)
      || value.revision < 1
      || !Array.isArray(value.warnings)
      || value.warnings.some(warning => typeof warning !== 'string')) {
      fail('commit result 内容无效', 'ARCHIVE_V2_INITIALIZATION_FLOW_CONTRACT');
    }
    return value;
  }
  if (!new Set(['conflict', 'stale', 'disabled']).has(value?.status)) {
    fail('commit 返回未知状态', 'ARCHIVE_V2_INITIALIZATION_FLOW_CONTRACT');
  }
  exactKeys(value, STATUS_RESULT_KEYS, 'commit result');
  return { status: value.status };
}

export function createArchiveV2InitializationFlow({
  sourceContextProvider,
  recognizer,
  profileGenerator,
  committer,
  collectSources = collectArchiveV2InitializationSources,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof sourceContextProvider !== 'function') throw new TypeError('sourceContextProvider 必须是函数');
  if (typeof recognizer?.recognize !== 'function' || typeof recognizer?.invalidate !== 'function') {
    throw new TypeError('recognizer 必须提供 recognize 和 invalidate');
  }
  if (typeof profileGenerator?.generate !== 'function' || typeof profileGenerator?.invalidate !== 'function') {
    throw new TypeError('profileGenerator 必须提供 generate 和 invalidate');
  }
  if (typeof committer?.commit !== 'function') throw new TypeError('committer 必须提供 commit');
  if (typeof collectSources !== 'function' || typeof now !== 'function') {
    throw new TypeError('collectSources 和 now 必须是函数');
  }

  let state = initialState();
  let epoch = 0;
  let active = null;

  const current = operation => operation.epoch === epoch;
  const requireStage = allowed => {
    if (!allowed.includes(state.stage)) {
      fail(`阶段 ${state.stage} 不允许此操作`, 'ARCHIVE_V2_INITIALIZATION_FLOW_STAGE_INVALID');
    }
  };
  const requireEditable = allowed => {
    if (active) fail('初始化流程正忙', 'ARCHIVE_V2_INITIALIZATION_FLOW_BUSY');
    requireStage(allowed);
  };

  function getState() {
    return safeClone({ ...state, busy: active !== null }, 'flow state');
  }

  function startAsync(name, allowedStages, prepare, run) {
    if (active) {
      if (active.name === name) return active.promise;
      fail('初始化流程正忙', 'ARCHIVE_V2_INITIALIZATION_FLOW_BUSY');
    }
    requireStage(allowedStages);
    let prepared;
    try {
      prepared = prepare();
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = { name, epoch, promise: null };
    operation.promise = Promise.resolve().then(() => run(operation, prepared));
    active = operation;
    operation.promise.then(
      () => { if (active === operation) active = null; },
      () => { if (active === operation) active = null; },
    );
    return operation.promise;
  }

  function loadSources({ chatRange } = {}) {
    return startAsync(
      'loadSources',
      ['idle', 'sources'],
      () => ({
        ...captureSourceContext(sourceContextProvider),
        chatRange: chatRange === undefined ? undefined : safeClone(chatRange, 'chatRange'),
      }),
      async (operation, prepared) => {
        if (!current(operation)) return { status: 'stale' };
        let raw;
        try {
          raw = await collectSources(prepared.context, { chatRange: prepared.chatRange });
        } catch (error) {
          if (!current(operation)) return { status: 'stale' };
          throw error;
        }
        if (!current(operation)) return { status: 'stale' };
        let latest;
        try {
          latest = captureSourceContext(sourceContextProvider).snapshot;
        } catch (error) {
          if (!current(operation)) return { status: 'stale' };
          throw error;
        }
        if (!sameSnapshot(prepared.snapshot, latest)) return { status: 'stale' };
        const result = validateSourceResult(raw);
        if (!current(operation)) return { status: 'stale' };
        state = {
          stage: 'sources',
          sources: result.candidates,
          warnings: result.warnings,
          candidateReview: null,
          profileReview: null,
          result: null,
        };
        return { status: 'ready' };
      },
    );
  }

  function setSourceSelected(sourceId, selected) {
    requireEditable(['sources']);
    if (typeof sourceId !== 'string' || !sourceId || typeof selected !== 'boolean') {
      fail('来源选择参数无效');
    }
    const index = state.sources.findIndex(source => source.id === sourceId);
    if (index < 0) fail('来源不存在');
    if (selected && state.sources[index].availability === 'disabled') {
      fail('disabled 来源不能选中', 'ARCHIVE_V2_INITIALIZATION_FLOW_SOURCE_DISABLED');
    }
    state = {
      ...state,
      sources: state.sources.map((source, sourceIndex) => sourceIndex === index
        ? { ...source, selected }
        : source),
    };
    return getState();
  }

  function recognizeCandidates() {
    return startAsync(
      'recognizeCandidates',
      ['sources'],
      () => ({ sources: safeClone(state.sources, 'sources') }),
      async (operation, prepared) => {
        if (!current(operation)) return { status: 'stale' };
        let raw;
        try {
          raw = await recognizer.recognize({ sources: prepared.sources });
        } catch (error) {
          if (!current(operation)) return { status: 'stale' };
          throw error;
        }
        if (!current(operation)) return { status: 'stale' };
        const result = validateTaskResult(raw, {
          terminalStatuses: new Set(['stale', 'disabled']),
          label: 'recognizer',
        });
        if (result.status !== 'ready') return { status: result.status };
        const candidateReview = createArchiveV2CandidateReview(result.draft);
        if (!current(operation)) return { status: 'stale' };
        state = {
          ...state,
          stage: 'candidates',
          candidateReview,
          profileReview: null,
          result: null,
        };
        return { status: 'ready' };
      },
    );
  }

  function updateCandidate(update) {
    requireEditable(['candidates']);
    state = { ...state, candidateReview: update(state.candidateReview) };
    return getState();
  }

  function setCandidateSelected(candidateId, selected) {
    return updateCandidate(review => setArchiveV2CandidateSelected(review, candidateId, selected));
  }

  function renameCandidate(candidateId, displayName) {
    return updateCandidate(review => renameArchiveV2Candidate(review, candidateId, displayName));
  }

  function setCandidateAliases(candidateId, aliases) {
    return updateCandidate(review => setArchiveV2CandidateAliases(review, candidateId, aliases));
  }

  function mergeCandidates(options) {
    return updateCandidate(review => mergeArchiveV2Candidates(review, options));
  }

  function removeCandidate(candidateId) {
    return updateCandidate(review => removeArchiveV2Candidate(review, candidateId));
  }

  function generateProfiles() {
    return startAsync(
      'generateProfiles',
      ['candidates'],
      () => ({
        plan: buildArchiveV2SelectedPeoplePlan(state.candidateReview),
        sources: safeClone(state.sources, 'sources'),
      }),
      async (operation, prepared) => {
        if (!current(operation)) return { status: 'stale' };
        let raw;
        try {
          raw = await profileGenerator.generate({ plan: prepared.plan, sources: prepared.sources });
        } catch (error) {
          if (!current(operation)) return { status: 'stale' };
          throw error;
        }
        if (!current(operation)) return { status: 'stale' };
        const result = validateTaskResult(raw, {
          terminalStatuses: new Set(['empty', 'stale', 'disabled']),
          label: 'profile generator',
        });
        if (result.status !== 'ready') return { status: result.status };
        const profileReview = createArchiveV2InitializationReview(result.draft);
        if (!current(operation)) return { status: 'stale' };
        state = { ...state, stage: 'profiles', profileReview, result: null };
        return { status: 'ready' };
      },
    );
  }

  function setProfileField(options) {
    requireEditable(['profiles']);
    state = {
      ...state,
      profileReview: setArchiveV2InitializationField(state.profileReview, options),
    };
    return getState();
  }

  function backToSources() {
    requireEditable(['candidates']);
    state = { ...state, stage: 'sources', candidateReview: null, profileReview: null, result: null };
    return getState();
  }

  function backToCandidates() {
    requireEditable(['profiles']);
    state = { ...state, stage: 'candidates', profileReview: null, result: null };
    return getState();
  }

  function commitInitialization({ identity, confirmedAt } = {}) {
    return startAsync(
      'commitInitialization',
      ['profiles'],
      () => ({
        review: safeClone(state.profileReview, 'profileReview'),
        sources: safeClone(state.sources, 'sources'),
        identity: safeClone(identity, 'identity'),
        confirmedAt,
      }),
      async (operation, prepared) => {
        if (!current(operation)) return { status: 'stale' };
        const effectiveConfirmedAt = prepared.confirmedAt === undefined ? now() : prepared.confirmedAt;
        let archive;
        try {
          archive = await buildInitializedArchiveV2({
            review: prepared.review,
            sources: prepared.sources,
            identity: prepared.identity,
            confirmedAt: effectiveConfirmedAt,
          });
        } catch (error) {
          if (!current(operation)) return { status: 'stale' };
          throw error;
        }
        if (!current(operation)) return { status: 'stale' };
        let raw;
        try {
          raw = await committer.commit({ archive });
        } catch (error) {
          if (!current(operation)) return { status: 'stale' };
          throw error;
        }
        if (!current(operation)) return { status: 'stale' };
        const result = validateCommitResult(raw);
        if (result.status !== 'created' && result.status !== 'already_initialized') {
          return { status: result.status };
        }
        state = { ...initialState(), stage: 'completed', result };
        return safeClone(result, 'commit result');
      },
    );
  }

  function reset() {
    epoch += 1;
    active = null;
    state = initialState();
    let firstError;
    for (const invalidate of [recognizer.invalidate.bind(recognizer), profileGenerator.invalidate.bind(profileGenerator)]) {
      try { invalidate(); }
      catch (error) { firstError ??= error; }
    }
    if (firstError) throw firstError;
    return getState();
  }

  return Object.freeze({
    getState,
    loadSources,
    setSourceSelected,
    recognizeCandidates,
    setCandidateSelected,
    renameCandidate,
    setCandidateAliases,
    mergeCandidates,
    removeCandidate,
    generateProfiles,
    setProfileField,
    backToSources,
    backToCandidates,
    commitInitialization,
    reset,
  });
}

export const ARCHIVE_V2_INITIALIZATION_FLOW_STAGES = Object.freeze([...STAGES]);
