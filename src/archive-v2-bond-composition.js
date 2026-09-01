import { createArchiveV2Adapter } from './archive-v2.js';
import {
  applyArchiveV2BondDraft,
  archiveV2BondBatchPrompt,
  createArchiveV2BondBatchDraft,
  createArchiveV2BondDraft,
  mergeArchiveV2BondDraftEdits,
} from './archive-v2-bond-foundation.js';
import {
  createArchiveV2BondBatches,
  createArchiveV2BondSourcePlan,
} from './archive-v2-bond-sources.js';
import { createArchiveV2MemoryStore } from './archive-v2-memory-store.js';
import { readArchiveV2ReadyMemory } from './archive-v2-ready-memory.js';
import { collectArchiveV2PermittedSources } from './archive-v2-sources.js';
import { composeArchiveV2SystemPrompt } from './archive-v2-prompt.js';
import { parseJsonOutput } from './compact-api-client.js';
import { isUuid, readHostState } from './host-context.js';

export class ArchiveV2BondCompositionError extends Error {
  constructor(message, code = 'ARCHIVE_V2_BOND_COMPOSITION_INVALID') {
    super(message);
    this.name = 'ArchiveV2BondCompositionError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new ArchiveV2BondCompositionError(message, code);
}

function failBatchRequest(error, batchNumber) {
  const code = String(error?.code ?? '');
  const details = {
    QQJ_OUTPUT_TRUNCATED: ['模型输出不完整', 'ARCHIVE_V2_BOND_OUTPUT_TRUNCATED'],
    QQJ_COMPLETION_JSON: ['模型输出不是合法的单一 JSON 对象', 'ARCHIVE_V2_BOND_RESPONSE_JSON_INVALID'],
    QQJ_TIMEOUT: ['API 请求超时', 'ARCHIVE_V2_BOND_REQUEST_TIMEOUT'],
    QQJ_CONFIG: ['API 配置不完整', 'ARCHIVE_V2_BOND_REQUEST_CONFIG'],
    QQJ_AUTH: ['API 认证失败', 'ARCHIVE_V2_BOND_REQUEST_AUTH'],
    QQJ_NOT_FOUND: ['API 地址不存在', 'ARCHIVE_V2_BOND_REQUEST_NOT_FOUND'],
    QQJ_RATE_LIMIT: ['API 请求过于频繁', 'ARCHIVE_V2_BOND_REQUEST_RATE_LIMIT'],
    QQJ_SERVER: ['API 服务暂时异常', 'ARCHIVE_V2_BOND_REQUEST_SERVER'],
    QQJ_NETWORK: ['无法连接 API', 'ARCHIVE_V2_BOND_REQUEST_NETWORK'],
    QQJ_EMPTY: ['模型没有返回内容', 'ARCHIVE_V2_BOND_RESPONSE_EMPTY'],
    QQJ_UNSUPPORTED: ['API 响应格式不受支持', 'ARCHIVE_V2_BOND_RESPONSE_UNSUPPORTED'],
    QQJ_HTTP_RESPONSE_JSON: ['API 响应不是合法 JSON', 'ARCHIVE_V2_BOND_RESPONSE_JSON_INVALID'],
    QQJ_STREAM_EVENT_JSON: ['流式响应事件不是合法 JSON', 'ARCHIVE_V2_BOND_RESPONSE_JSON_INVALID'],
  }[code] ?? ['API 请求失败', 'ARCHIVE_V2_BOND_REQUEST_FAILED'];
  fail(`第 ${batchNumber} 批：${details[0]}`, details[1]);
}

function failBatchFormat(error, batchNumber) {
  const detail = {
    ARCHIVE_V2_BOND_PERSON_MISMATCH: '返回的人物数量或代号与请求不一致',
    ARCHIVE_V2_BOND_SOURCE_MISMATCH: '返回内容引用了其他人物的来源',
    ARCHIVE_V2_BOND_NATIVE_SIGNAL_INVALID: '返回内容引用了无效的原生关系信息',
    ARCHIVE_V2_BOND_FORMAT: '返回字段结构不符合约定',
    QQJ_OUTPUT_TRUNCATED: '模型输出不完整',
    QQJ_COMPLETION_JSON: '模型输出不是合法的单一 JSON 对象',
  }[String(error?.code ?? '')] ?? '返回内容无法安全识别';
  const code = String(error?.code ?? '').startsWith('ARCHIVE_V2_BOND_')
    ? error.code
    : 'ARCHIVE_V2_BOND_FORMAT';
  fail(`第 ${batchNumber} 批：${detail}`, code);
}

function sameIdentity(left, right) {
  return left.hostChatId === right.hostChatId
    && left.chatId === right.chatId
    && left.characterLocator === right.characterLocator
    && left.personaLocator === right.personaLocator;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unwrap(response) {
  let value = response;
  let finishReason;
  if (isPlainObject(value) && Object.hasOwn(value, 'jsonData')) {
    finishReason = value.taskMetadata?.finishReason;
    value = value.jsonData;
  }
  return parseJsonOutput(value, { finishReason });
}

function systemPrompt() {
  return [
    '你是千千结的 C↔U 双丝网整理器。只使用用户消息中提供的编码来源，不得读取或声称读取其他聊天、世界书、变量或资料。',
    '本批人物代号只会是 P1～P4。必须一次覆盖全部给定人物，每个恰好一次；不得新增、删除、合并、改名、交换人物。',
    '只输出一个纯 JSON 根对象，且根对象必须且只能包含 people。禁止 Markdown、代码围栏、解释、前后缀和思维链。',
    'people 每项必须且只能包含 person、fields、nativeSignals。fields 与 nativeSignals 都是数组。',
    'fields 每项必须且只能包含 field、text、evidence；evidence 必须是当前人物可用的编码来源数组，非空。无证据就省略该字段。',
    'field 只能是 stage、cView、cEmotion、cDesire、cGoal、cConcern、cSecret、uView、uEmotion、uPlan、uBoundary、uExpectation、recentChanges。',
    'stage 只承担标准关系进度，必须且只能逐字选择以下一个值：陌生、相识、熟悉、暧昧、热恋。不得输出其他阶段、身份、关系定位或心理状态。',
    '作者自定义的关系名称、身份、定位、心理状态或阶段原文不写入 stage；如输入中存在对应只读原生信号，只在 nativeSignals 中引用其 N 代号，保留作者原文。',
    '详细关系含义写入 C→U、U→C 与 recentChanges；不得把整段说明塞进 stage，不得截取说明前两字假装阶段，也不得伪造精确好感数值。',
    'C→U 分别表示看法、情绪、欲望、目标、顾虑、秘密；U→C 分别表示看法、情绪、计划、边界、期待。不要用空话补齐。',
    'nativeSignals 只能选择输入 nativeSignalCandidates 中的 N 代号；不得自由书写路径、值或不存在的代号。无相关原生信号时输出空数组。',
    '不得输出后端字段、UUID、revision、fingerprint、HTML、事件候选、下一步建议或任何其他字段。',
  ].join('\n');
}

export function createArchiveV2BondComposition({
  client,
  contextProvider,
  generateUtilityTask,
  isEnabled = true,
  permissionSettings = () => ({}),
  sanitizerOptions = () => ({}),
  generalPrompt = () => '',
} = {}) {
  if (typeof client?.get !== 'function' || typeof client?.put !== 'function') {
    throw new TypeError('bond client 必须提供 get 和 put');
  }
  if (typeof contextProvider !== 'function') throw new TypeError('bond contextProvider 必须是函数');
  if (typeof generateUtilityTask !== 'function') throw new TypeError('generateUtilityTask 必须是函数');
  if (typeof isEnabled !== 'boolean' && typeof isEnabled !== 'function') throw new TypeError('isEnabled 无效');

  let epoch = 0;
  let state = Object.freeze({ status: 'idle' });
  let stateIdentity = null;
  let activeGeneration = null;
  let activeCommit = null;
  const enabled = () => {
    try { return (typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true; }
    catch { return false; }
  };

  function normalizedContext() {
    let raw;
    let host;
    try {
      raw = contextProvider();
      host = readHostState(raw);
    } catch {
      fail('当前聊天身份不可用', 'ARCHIVE_V2_BOND_CONTEXT_INVALID');
    }
    if (host?.ok !== true || !isUuid(host.chatId)) {
      fail('当前聊天身份不可用', 'ARCHIVE_V2_BOND_CONTEXT_INVALID');
    }
    return {
      raw,
      identity: Object.freeze({
        hostChatId: host.hostChatId,
        chatId: host.chatId,
        characterLocator: host.characterAvatar,
        personaLocator: host.personaAvatar,
      }),
    };
  }

  const identityContextProvider = () => ({ ...normalizedContext().identity });
  const archiveAdapter = createArchiveV2Adapter({ client, contextProvider: identityContextProvider, isEnabled });
  const memoryStore = createArchiveV2MemoryStore({ client, contextProvider: identityContextProvider, isEnabled });

  function setState(next, identity) {
    state = Object.freeze({ ...next });
    stateIdentity = identity ?? null;
    return state;
  }

  function operationFor(identity) {
    const operation = { epoch, identity, controller: new AbortController() };
    operation.status = () => enabled() ? 'stale' : 'disabled';
    operation.current = () => {
      if (operation.epoch !== epoch || operation.controller.signal.aborted || !enabled()) return false;
      try { return sameIdentity(identity, normalizedContext().identity); }
      catch { return false; }
    };
    return operation;
  }

  function identityMatchesArchive(archive, identity) {
    return archive.identity.characterLocator === identity.characterLocator
      && archive.identity.personaLocator === identity.personaLocator;
  }

  function publicArchiveState(read) {
    const followed = read.archive.people.order
      .filter(identityId => read.archive.people.byId[identityId]?.followed === true);
    const savedCount = followed.filter(identityId => Object.hasOwn(read.archive.bonds, identityId)).length;
    return {
      status: savedCount > 0 ? 'saved' : (followed.length ? 'ready' : 'empty'),
      archive: read.archive,
      revision: read.revision,
      warnings: read.warnings ?? [],
      followedCount: followed.length,
      savedCount,
    };
  }

  async function inspect() {
    if (!enabled()) return setState({ status: 'disabled' }, null);
    const { identity } = normalizedContext();
    if (stateIdentity && sameIdentity(stateIdentity, identity)
      && ['running', 'draft', 'saving', 'error', 'conflict'].includes(state.status)) return state;
    const read = await archiveAdapter.read();
    if (read?.status !== 'ready') return setState({ status: read?.status ?? 'error' }, identity);
    const next = publicArchiveState(read);
    if (!identityMatchesArchive(read.archive, identity)) next.status = 'persona_mismatch';
    return setState(next, identity);
  }

  function generate() {
    if (activeGeneration) return activeGeneration.promise;
    if (!enabled()) return Promise.resolve({ status: 'disabled' });
    let context;
    try { context = normalizedContext(); }
    catch (error) { return Promise.reject(error); }
    const operation = operationFor(context.identity);
    setState({ status: 'running', batchIndex: 0, totalBatches: 0 }, context.identity);
    operation.promise = (async () => {
      try {
        const archiveRead = await archiveAdapter.read();
        if (!operation.current()) return { status: operation.status() };
        if (archiveRead?.status !== 'ready') return setState({ status: archiveRead?.status ?? 'error' }, context.identity);
        if (!identityMatchesArchive(archiveRead.archive, context.identity)) {
          return setState({ ...publicArchiveState(archiveRead), status: 'persona_mismatch' }, context.identity);
        }
        const followed = archiveRead.archive.people.order
          .filter(identityId => archiveRead.archive.people.byId[identityId]?.followed === true);
        if (!followed.length) return setState({ ...publicArchiveState(archiveRead), status: 'empty' }, context.identity);
        if (followed.some(identityId => Object.hasOwn(archiveRead.archive.bonds, identityId))) {
          return setState(publicArchiveState(archiveRead), context.identity);
        }
        const workingArchiveState = publicArchiveState(archiveRead);
        setState({ ...workingArchiveState, status: 'running', batchIndex: 0, totalBatches: 0 }, context.identity);
        const memory = await readArchiveV2ReadyMemory({ raw: context.raw, memoryStore, operation });
        if (!operation.current()) return { status: operation.status() };
        if (memory.status !== 'ready') {
          return setState({ status: memory.status, followedCount: followed.length }, context.identity);
        }
        const collected = await collectArchiveV2PermittedSources(context.raw, {
          chatId: context.identity.chatId,
          permissionSettings: permissionSettings(),
          sanitizerOptions: sanitizerOptions(),
        });
        if (!operation.current()) return { status: operation.status() };
        const plan = await createArchiveV2BondSourcePlan({
          raw: context.raw,
          archive: archiveRead.archive,
          revision: archiveRead.revision,
          manifest: memory.manifest,
          batches: memory.batches,
          peopleResult: memory.peopleResult,
          routeSources: collected.candidates,
        });
        if (!operation.current()) return { status: operation.status() };
        const batches = createArchiveV2BondBatches(plan);
        const drafts = [];
        for (let index = 0; index < batches.length; index += 1) {
          setState({
            ...workingArchiveState,
            status: 'running',
            batchIndex: index + 1,
            totalBatches: batches.length,
            followedCount: followed.length,
          }, context.identity);
          let response;
          try {
            response = await generateUtilityTask({
              includeCharacterCard: false,
              worldInfoSource: 'none',
              substituteMacros: false,
              systemPrompt: composeArchiveV2SystemPrompt({ generalPrompt, machineContract: systemPrompt() }),
              taskMessages: [{ role: 'user', content: archiveV2BondBatchPrompt(batches[index]) }],
              signal: operation.controller.signal,
              maxTokens: 30000,
              temperature: 0.2,
            });
          } catch (error) {
            if (!operation.current()) return { status: operation.status() };
            failBatchRequest(error, index + 1);
          }
          if (!operation.current()) return { status: operation.status() };
          try { drafts.push(createArchiveV2BondBatchDraft({ batch: batches[index], output: unwrap(response) })); }
          catch (error) {
            if (!operation.current()) return { status: operation.status() };
            failBatchFormat(error, index + 1);
          }
        }
        const draft = createArchiveV2BondDraft({ plan, batchDrafts: drafts });
        if (!operation.current()) return { status: operation.status() };
        return setState({ status: 'draft', draft, followedCount: followed.length }, context.identity);
      } catch (error) {
        if (!operation.current()) return { status: operation.status() };
        setState({
          ...state,
          status: 'error',
          errorCode: error?.code ?? 'ARCHIVE_V2_BOND_ERROR',
          ...(error instanceof ArchiveV2BondCompositionError ? { errorDetail: error.message } : {}),
        }, context.identity);
        throw error;
      }
    })();
    activeGeneration = operation;
    operation.promise.finally(() => {
      if (activeGeneration === operation) activeGeneration = null;
    }).catch(() => {});
    return operation.promise;
  }

  function commit({ edits = {} } = {}) {
    if (activeCommit) return activeCommit.promise;
    if (!enabled()) return Promise.resolve({ status: 'disabled' });
    let context;
    try { context = normalizedContext(); }
    catch (error) { return Promise.reject(error); }
    if (!stateIdentity || !sameIdentity(stateIdentity, context.identity) || state.status !== 'draft') {
      return Promise.reject(new ArchiveV2BondCompositionError('没有可保存的双丝网草稿', 'ARCHIVE_V2_BOND_DRAFT_MISSING'));
    }
    const operation = operationFor(context.identity);
    const draft = mergeArchiveV2BondDraftEdits({ draft: state.draft, edits });
    setState({ status: 'saving', draft, followedCount: state.followedCount }, context.identity);
    operation.promise = (async () => {
      try {
        const current = await archiveAdapter.read();
        if (!operation.current()) return { status: operation.status() };
        if (current?.status !== 'ready' || current.revision !== draft.baseRevision) {
          setState({ status: 'conflict', draft, followedCount: state.followedCount }, context.identity);
          return { status: 'conflict' };
        }
        if (!identityMatchesArchive(current.archive, context.identity)) {
          setState({ status: 'persona_mismatch', archive: current.archive, revision: current.revision }, context.identity);
          return { status: 'persona_mismatch' };
        }
        const archive = applyArchiveV2BondDraft({ archive: current.archive, revision: current.revision, draft });
        const saved = await archiveAdapter.save({
          archive,
          expectedRevision: current.revision,
          signal: operation.controller.signal,
        });
        if (!operation.current()) return { status: operation.status() };
        if (saved?.status !== 'saved') {
          setState({ status: saved?.status === 'conflict' ? 'conflict' : (saved?.status ?? 'error'), draft }, context.identity);
          return { status: saved?.status ?? 'error' };
        }
        const result = { ...saved, followedCount: draft.people.length, savedCount: draft.people.length };
        setState({
          status: 'saved',
          archive: result.archive,
          revision: result.revision,
          warnings: result.warnings ?? [],
          followedCount: result.followedCount,
          savedCount: result.savedCount,
        }, context.identity);
        return result;
      } catch (error) {
        if (!operation.current()) return { status: operation.status() };
        setState({ status: 'error', draft, errorCode: error?.code ?? 'ARCHIVE_V2_BOND_ERROR' }, context.identity);
        throw error;
      }
    })();
    activeCommit = operation;
    operation.promise.finally(() => {
      if (activeCommit === operation) activeCommit = null;
    }).catch(() => {});
    return operation.promise;
  }

  function invalidate() {
    epoch += 1;
    activeGeneration?.controller.abort();
    activeCommit?.controller.abort();
    archiveAdapter.invalidate();
    memoryStore.invalidate();
    setState({ status: enabled() ? 'idle' : 'disabled' }, null);
  }

  return Object.freeze({ inspect, generate, commit, getState: () => state, invalidate });
}
