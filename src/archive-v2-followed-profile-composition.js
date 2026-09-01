import { createArchiveV2Adapter } from './archive-v2.js';
import {
  applyArchiveV2FollowedProfileDraft,
  archiveV2FollowedProfilePrompt,
  createArchiveV2FollowedProfileDraft,
  createArchiveV2FollowedProfilePlan,
} from './archive-v2-followed-profile-foundation.js';
import { createArchiveV2MemorySnapshot } from './archive-v2-memory-foundation.js';
import { createArchiveV2MemoryStore } from './archive-v2-memory-store.js';
import { collectArchiveV2InitializationSources } from './archive-v2-sources.js';
import { parseJsonOutput } from './compact-api-client.js';
import { isUuid, readHostState } from './host-context.js';

export class ArchiveV2FollowedProfileCompositionError extends Error {
  constructor(message, code = 'ARCHIVE_V2_FOLLOWED_PROFILE_COMPOSITION_INVALID') {
    super(message);
    this.name = 'ArchiveV2FollowedProfileCompositionError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new ArchiveV2FollowedProfileCompositionError(message, code);
}

function sameIdentity(left, right) {
  return left.hostChatId === right.hostChatId
    && left.chatId === right.chatId
    && left.characterLocator === right.characterLocator
    && left.personaLocator === right.personaLocator;
}

function systemPrompt() {
  return [
    '你是千千结的关注人物基础人设整理器。只使用用户消息中提供的编码来源，不得读取或声称读取其他聊天、人物或资料。',
    '必须一次覆盖全部给定人物代号，不得新增、删除、合并、重命名或交换人物。姓名只用于识别，不得作为输出字段。',
    '只输出一个纯 JSON 根对象，根对象必须且只能包含 people。禁止 Markdown、代码围栏、解释、前后缀和思维链。',
    'people 每项必须且只能包含 person 与 fields；person 使用输入中的 P1、P2……且每个恰好一次。',
    'fields 是数组，每项必须且只能包含 field、text、evidence。未知或无法确认的字段直接省略，不要猜测。',
    'field 只能是 gender、age、appearance、personality、identity、abilities、likes、dislikes、principles、relationships、nsfwPreferences。',
    'text 必须是简洁非空字符串；evidence 必须是与该人物关联的来源代号数组，非空且不得引用输入外代号。',
    '不得输出 UUID、locator、fingerprint、followed、事件、好感、下一步或任何其他存储字段。',
  ].join('\n');
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

export function createArchiveV2FollowedProfileComposition({
  client,
  contextProvider,
  generateUtilityTask,
  isEnabled = true,
} = {}) {
  if (typeof client?.get !== 'function' || typeof client?.put !== 'function') {
    throw new TypeError('followed profile client 必须提供 get 和 put');
  }
  if (typeof contextProvider !== 'function') throw new TypeError('followed profile contextProvider 必须是函数');
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
      fail('当前聊天身份不可用', 'ARCHIVE_V2_FOLLOWED_PROFILE_CONTEXT_INVALID');
    }
    if (host?.ok !== true || !isUuid(host.chatId)) {
      fail('当前聊天身份不可用', 'ARCHIVE_V2_FOLLOWED_PROFILE_CONTEXT_INVALID');
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
      try { return sameIdentity(operation.identity, normalizedContext().identity); }
      catch { return false; }
    };
    return operation;
  }

  async function readReadyMemory(raw, operation) {
    const read = await memoryStore.readManifest();
    if (!operation.current()) return { status: operation.status() };
    if (read?.status !== 'ready' || read.manifest.status !== 'ready') {
      return { status: read?.status === 'ready' ? 'memory_not_ready' : (read?.status ?? 'memory_not_ready') };
    }
    if (!Array.isArray(raw?.chat)) fail('当前聊天正文不可用', 'ARCHIVE_V2_FOLLOWED_PROFILE_CONTEXT_INVALID');
    const snapshot = await createArchiveV2MemorySnapshot({
      ...raw,
      chat: raw.chat.slice(0, read.manifest.targetFloor + 1),
    });
    if (!operation.current()) return { status: operation.status() };
    if (snapshot.sourceFingerprint !== read.manifest.sourceFingerprint
      || snapshot.batches.length !== read.manifest.totalBatches) return { status: 'source_changed' };
    const ready = await memoryStore.readReadyBatches({ manifest: read.manifest, plans: snapshot.batches });
    if (!operation.current()) return { status: operation.status() };
    if (ready?.status !== 'ready') return { status: ready?.status ?? 'memory_not_ready' };
    const people = await memoryStore.readPeopleResult(ready);
    if (!operation.current()) return { status: operation.status() };
    if (people?.status !== 'ready') return { status: people?.status === 'missing' ? 'people_missing' : (people?.status ?? 'people_missing') };
    return { ...ready, peopleResult: people.result };
  }

  function publicArchiveState(read) {
    const order = Array.isArray(read.archive?.people?.order) ? read.archive.people.order : [];
    const followed = order.map(identityId => read.archive.people.byId[identityId]).filter(person => person?.followed === true);
    const enrichedCount = followed.filter(person => Object.keys(person.fields ?? {}).length > 0).length;
    return {
      status: followed.length ? 'ready' : 'empty',
      followedCount: followed.length,
      enrichedCount,
      revision: read.revision,
    };
  }

  async function inspect() {
    if (!enabled()) return setState({ status: 'disabled' }, null);
    const { identity } = normalizedContext();
    if (stateIdentity && sameIdentity(stateIdentity, identity)
      && ['running', 'draft', 'saving', 'error', 'conflict', 'saved'].includes(state.status)) return state;
    const read = await archiveAdapter.read();
    if (read?.status !== 'ready') return setState({ status: read?.status ?? 'error' }, identity);
    return setState(publicArchiveState(read), identity);
  }

  function generate() {
    if (activeGeneration) return activeGeneration.promise;
    if (!enabled()) return Promise.resolve({ status: 'disabled' });
    let context;
    try { context = normalizedContext(); }
    catch (error) { return Promise.reject(error); }
    const operation = operationFor(context.identity);
    setState({ status: 'running' }, context.identity);
    operation.promise = (async () => {
      try {
        const archiveRead = await archiveAdapter.read();
        if (!operation.current()) return { status: operation.status() };
        if (archiveRead?.status !== 'ready') return setState({ status: archiveRead?.status ?? 'error' }, context.identity);
        const followedCount = archiveRead.archive.people.order
          .filter(identityId => archiveRead.archive.people.byId[identityId]?.followed === true).length;
        if (!followedCount) return setState({ status: 'empty', followedCount: 0, enrichedCount: 0 }, context.identity);
        const memory = await readReadyMemory(context.raw, operation);
        if (!operation.current()) return { status: operation.status() };
        if (memory.status !== 'ready') {
          return setState({ status: memory.status, followedCount }, context.identity);
        }
        const collected = await collectArchiveV2InitializationSources(context.raw);
        if (!operation.current()) return { status: operation.status() };
        const plan = createArchiveV2FollowedProfilePlan({
          archive: archiveRead.archive,
          revision: archiveRead.revision,
          manifest: memory.manifest,
          batches: memory.batches,
          peopleResult: memory.peopleResult,
          sources: collected.candidates,
        });
        let response;
        try {
          response = await generateUtilityTask({
            includeCharacterCard: false,
            worldInfoSource: 'none',
            substituteMacros: false,
            systemPrompt: systemPrompt(),
            taskMessages: [{ role: 'user', content: archiveV2FollowedProfilePrompt(plan) }],
            signal: operation.controller.signal,
            maxTokens: 30000,
            temperature: 0.2,
          });
        } catch {
          if (!operation.current()) return { status: operation.status() };
          fail('基础人设生成请求失败', 'ARCHIVE_V2_FOLLOWED_PROFILE_REQUEST_FAILED');
        }
        if (!operation.current()) return { status: operation.status() };
        let draft;
        try { draft = createArchiveV2FollowedProfileDraft({ plan, output: unwrap(response) }); }
        catch {
          if (!operation.current()) return { status: operation.status() };
          fail('基础人设结果格式无效', 'ARCHIVE_V2_FOLLOWED_PROFILE_FORMAT');
        }
        if (!operation.current()) return { status: operation.status() };
        return setState({ status: 'draft', draft, followedCount }, context.identity);
      } catch (error) {
        if (!operation.current()) return { status: operation.status() };
        setState({ status: 'error' }, context.identity);
        throw error;
      }
    })();
    activeGeneration = operation;
    operation.promise.finally(() => {
      if (activeGeneration === operation) activeGeneration = null;
    }).catch(() => {});
    return operation.promise;
  }

  function commit() {
    if (activeCommit) return activeCommit.promise;
    if (!enabled()) return Promise.resolve({ status: 'disabled' });
    let context;
    try { context = normalizedContext(); }
    catch (error) { return Promise.reject(error); }
    if (!stateIdentity || !sameIdentity(stateIdentity, context.identity) || state.status !== 'draft') {
      return Promise.reject(new ArchiveV2FollowedProfileCompositionError(
        '没有可保存的基础人设草稿', 'ARCHIVE_V2_FOLLOWED_PROFILE_DRAFT_MISSING',
      ));
    }
    const operation = operationFor(context.identity);
    const draft = state.draft;
    setState({ status: 'saving', draft, followedCount: state.followedCount }, context.identity);
    operation.promise = (async () => {
      try {
        const current = await archiveAdapter.read();
        if (!operation.current()) return { status: operation.status() };
        if (current?.status !== 'ready' || current.revision !== draft.baseRevision) {
          setState({ status: 'conflict', draft, followedCount: state.followedCount }, context.identity);
          return { status: 'conflict' };
        }
        const applied = applyArchiveV2FollowedProfileDraft({
          archive: current.archive,
          revision: current.revision,
          draft,
        });
        const saved = await archiveAdapter.save({
          archive: applied.archive,
          expectedRevision: current.revision,
          signal: operation.controller.signal,
        });
        if (!operation.current()) return { status: operation.status() };
        if (saved?.status !== 'saved') {
          setState({ status: saved?.status === 'conflict' ? 'conflict' : (saved?.status ?? 'error'), draft }, context.identity);
          return { status: saved?.status ?? 'error' };
        }
        const result = {
          ...saved,
          savedFieldCount: applied.savedFieldCount,
          protectedFieldCount: applied.protectedFieldCount,
          followedCount: draft.people.length,
        };
        setState({
          status: 'saved',
          savedFieldCount: result.savedFieldCount,
          protectedFieldCount: result.protectedFieldCount,
          followedCount: result.followedCount,
        }, context.identity);
        return result;
      } catch (error) {
        if (!operation.current()) return { status: operation.status() };
        setState({ status: 'error', draft }, context.identity);
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
