import { CHAT_IDENTITY_COLLECTION } from './chat-identity.js';
import { isUuid, readHostState } from './host-context.js';
import { V3_ROOT_RECORD_ID } from './v3/foundation-store.js';
import { MESSAGE_FLOOR_ANCHOR_KEY } from './v3/message-floor-anchor.js';
import { publicErrorMessage } from './public-error.js';

const RECEIPT_KEY = 'qqj_v3_recall_receipt';
const AUTO_HIDE_KEY = 'qianqianjieAutoHide';
const MEMORY_MESSAGE_KEYS = Object.freeze([RECEIPT_KEY, MESSAGE_FLOOR_ANCHOR_KEY, AUTO_HIDE_KEY]);
const errorWith = (code, message) => Object.assign(new Error(message), { code });
const clone = value => structuredClone(value);

function publicError(error) {
  return publicErrorMessage(error, { fallback: '删除未完成，请重试。' });
}

export function createChatMemoryManagement({
  client,
  session,
  hostAdapter,
  contextProvider = () => hostAdapter.snapshot().context,
  foundationRuntime,
  memoryRuntime,
  recallRuntime,
  peopleRuntime,
  timeRuntime,
  autoHideController,
  isMainGenerationActive = () => false,
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  if (!client?.list || !client?.get || !client?.remove || !session?.identity || !session?.suspend || !session?.resume || !hostAdapter?.snapshot || !autoHideController?.stop || typeof fetchImpl !== 'function') {
    throw new TypeError('当前聊天记忆删除依赖无效');
  }
  let active = null;
  let rebuilding = null;
  let pending = null;
  let lastResult = null;
  const subscribers = new Set();

  const inCurrentHost = (identity, requireMetadata = true) => {
    try {
      const snapshot = hostAdapter.snapshot();
      return snapshot.chatId === identity?.hostChatId && (!requireMetadata || snapshot.context?.chatMetadata?.qianqianjie?.chatId === identity?.chatId);
    } catch { return false; }
  };
  const getState = () => {
    const scopedActive = active && inCurrentHost(active.identity) ? active : null;
    const scopedPending = pending && inCurrentHost(pending.identity) ? pending : null;
    const scopedResult = lastResult && inCurrentHost({ hostChatId: lastResult.hostChatId, chatId: lastResult.chatId }, false);
    return Object.freeze({
      status: scopedActive ? 'deleting' : scopedPending ? 'failed' : scopedResult ? lastResult.status : 'idle',
      targetChatId: scopedActive?.identity.chatId ?? scopedPending?.identity.chatId ?? (scopedResult ? lastResult.chatId : null),
      phase: scopedActive?.phase ?? null,
      error: scopedPending?.error ?? null,
      deletedCount: scopedPending?.deletedCount ?? (scopedResult ? lastResult.deletedCount : 0),
      blockedByOtherChat: Boolean((pending && !scopedPending) || (active && !scopedActive)),
      workBusy: busy() || rebuilding !== null,
    });
  };
  const notify = () => { const state = getState(); for (const listener of subscribers) { try { listener(state); } catch { /* UI listener isolation */ } } return state; };
  const currentHost = identity => {
    const snapshot = hostAdapter.snapshot();
    if (snapshot.chatId !== identity.hostChatId || snapshot.context?.chatMetadata?.qianqianjie?.chatId !== identity.chatId) {
      throw errorWith('QQJ_DELETE_CHAT_CHANGED', '当前聊天已经变化，未删除其他聊天的数据。');
    }
    return snapshot;
  };
  function busy() {
    const memory = memoryRuntime?.getState?.() ?? {};
    const foundation = foundationRuntime?.getState?.() ?? {};
    const recall = recallRuntime?.getState?.() ?? {};
    const people = peopleRuntime?.getState?.() ?? {};
    return Boolean(isMainGenerationActive?.() || memory.memoryWorkBusy || memory.activeAutoMemory || memory.activeExtraction || memory.activeCse
      || foundation.activeRun || recall.activeRecall || people.active);
  }
  const invalidateRuntimes = deletedChatId => {
    try { memoryRuntime?.invalidate?.(deletedChatId ? { deletedChatId } : undefined); } catch { /* continue clearing other projections */ }
    try { foundationRuntime?.invalidate?.(); } catch { /* continue */ }
    try { recallRuntime?.invalidate?.('memoryDeleted'); } catch { /* continue */ }
    try { recallRuntime?.clearCurrent?.(); } catch { /* continue */ }
    try { peopleRuntime?.invalidate?.(); } catch { /* continue */ }
  };

  async function readPersistedChat(identity, { requireMetadata = true } = {}) {
    const snapshot = requireMetadata ? currentHost(identity) : hostAdapter.snapshot();
    if (snapshot.chatId !== identity.hostChatId) throw errorWith('QQJ_DELETE_CHAT_CHANGED', '当前聊天已经变化，未删除其他聊天的数据。');
    const context = snapshot.context;
    const character = Array.isArray(context.characters) ? context.characters[context.characterId] : context.characters?.[context.characterId];
    const response = await fetchImpl('/api/chats/get', {
      method: 'POST', cache: 'no-cache', headers: context.getRequestHeaders?.() ?? {},
      body: JSON.stringify({ ch_name: String(character?.name ?? context.name2 ?? ''), file_name: identity.hostChatId, avatar_url: identity.characterLocator }),
    });
    if (!response?.ok) throw errorWith('QQJ_DELETE_HOST_VERIFY_FAILED', '宿主保存后无法读回当前聊天。');
    const payload = await response.json();
    if (!Array.isArray(payload)) throw errorWith('QQJ_DELETE_HOST_VERIFY_FAILED', '宿主读回的当前聊天格式无效。');
    const header = payload[0]?.chat_metadata && typeof payload[0].chat_metadata === 'object' ? payload[0] : null;
    if (!header) throw errorWith('QQJ_DELETE_HOST_VERIFY_FAILED', '宿主读回缺少当前聊天元数据头。');
    return { metadata: header.chat_metadata, messages: payload.slice(1) };
  }

  const clearMemoryKeys = extra => {
    if (!extra || typeof extra !== 'object' || Array.isArray(extra) || !MEMORY_MESSAGE_KEYS.some(key => Object.hasOwn(extra, key))) return null;
    const next = { ...extra };
    for (const key of MEMORY_MESSAGE_KEYS) delete next[key];
    return next;
  };
  const hasMemoryKeys = message => MEMORY_MESSAGE_KEYS.some(key => Object.hasOwn(message?.extra ?? {}, key))
    || (Array.isArray(message?.swipe_info) && message.swipe_info.some(swipe => MEMORY_MESSAGE_KEYS.some(key => Object.hasOwn(swipe?.extra ?? {}, key))));
  const hasValidAutoHideMarker = extra => extra?.[AUTO_HIDE_KEY]?.schemaVersion === 1 && isUuid(extra[AUTO_HIDE_KEY].chatId);

  async function clearMessageMemoryKeys(identity, assertOwner) {
    const snapshot = currentHost(identity);
    const changed = [];
    for (const [messageIndex, message] of snapshot.chat.entries()) {
      const nextExtra = clearMemoryKeys(message?.extra);
      const restoreVisibility = hasValidAutoHideMarker(message?.extra);
      let swipeChanged = false;
      const nextSwipeInfo = Array.isArray(message?.swipe_info) ? message.swipe_info.map(swipe => {
        const next = clearMemoryKeys(swipe?.extra);
        if (!next) return swipe;
        swipeChanged = true;
        return { ...swipe, extra: next };
      }) : message?.swipe_info;
      if (!nextExtra && !swipeChanged) continue;
      changed.push({ message, messageIndex, extra: message.extra, swipeInfo: message.swipe_info, hadIsSystem: Object.hasOwn(message, 'is_system'), isSystem: message.is_system, restoreVisibility });
      if (nextExtra) message.extra = nextExtra;
      if (swipeChanged) message.swipe_info = nextSwipeInfo;
      if (restoreVisibility) message.is_system = false;
    }
    if (!changed.length) return 0;
    try {
      if (typeof snapshot.context?.saveChat !== 'function') throw errorWith('QQJ_DELETE_CHAT_SAVE_UNAVAILABLE', '宿主不支持保存聊天记忆标识清理结果。');
      await snapshot.context.saveChat();
      assertOwner?.();
      currentHost(identity);
      const persisted = await readPersistedChat(identity);
      assertOwner?.();
      const restoredIndexes = new Set(changed.filter(item => item.restoreVisibility).map(item => item.messageIndex));
      if (persisted.messages.length !== snapshot.chat.length || persisted.messages.some(hasMemoryKeys)
        || persisted.messages.some((message, index) => restoredIndexes.has(index) && message?.is_system !== false)) {
        throw errorWith('QQJ_DELETE_RECEIPT_VERIFY_FAILED', '聊天记忆标识没有完成持久化；原身份已保留，可重试。');
      }
      currentHost(identity);
      if (restoredIndexes.size) {
        try {
          const documentRef = globalThis.document;
          if (documentRef) for (const node of documentRef.querySelectorAll('#chat .mes[mesid]')) {
            if (restoredIndexes.has(Number(node.getAttribute('mesid')))) node.setAttribute('is_system', 'false');
          }
          snapshot.context.swipe?.refresh?.();
        } catch { /* 外观刷新失败不回滚已核验的聊天数据 */ }
      }
      return changed.length;
    } catch (error) {
      for (const item of changed) {
        item.message.extra = item.extra;
        item.message.swipe_info = item.swipeInfo;
        if (item.hadIsSystem) item.message.is_system = item.isSystem;
        else delete item.message.is_system;
      }
      throw error;
    }
  }

  async function clearMetadata(identity, { clearPrequel = false, assertOwner } = {}) {
    const snapshot = currentHost(identity);
    const context = snapshot.context;
    const metadata = context.chatMetadata;
    const previous = clone(metadata.qianqianjie);
    const hadPrequel = Object.hasOwn(metadata, 'qianqianjiePrequel');
    const previousPrequel = metadata.qianqianjiePrequel;
    delete metadata.qianqianjie;
    if (clearPrequel) delete metadata.qianqianjiePrequel;
    try {
      if (typeof context.saveChatMetadata === 'function') {
        if (await context.saveChatMetadata() !== true) throw errorWith('QQJ_DELETE_METADATA_SAVE_FAILED', '聊天元数据未能持久化。');
      } else if (typeof context.saveMetadata === 'function') await context.saveMetadata();
      else throw errorWith('QQJ_DELETE_METADATA_SAVE_UNAVAILABLE', '宿主不支持保存聊天元数据。');
      assertOwner?.();
      if (context.chatMetadata?.qianqianjie !== undefined || (clearPrequel && context.chatMetadata?.qianqianjiePrequel !== undefined)) throw errorWith('QQJ_DELETE_METADATA_VERIFY_FAILED', '聊天元数据清理后未能读回。');
      const persisted = await readPersistedChat(identity, { requireMetadata: false });
      assertOwner?.();
      if (persisted.metadata?.qianqianjie !== undefined || (clearPrequel && persisted.metadata?.qianqianjiePrequel !== undefined)) throw errorWith('QQJ_DELETE_METADATA_VERIFY_FAILED', '聊天元数据没有完成持久化；原身份已保留，可重试。');
    } catch (error) {
      metadata.qianqianjie = previous;
      if (clearPrequel && hadPrequel) metadata.qianqianjiePrequel = previousPrequel;
      throw error;
    }
  }

  async function removeEnvelope(collection, envelope, signal) {
    if (!envelope || typeof envelope.recordId !== 'string' || !Number.isSafeInteger(envelope.revision) || envelope.revision < 1) {
      throw errorWith('QQJ_DELETE_RECORD_INVALID', '后端返回了无法安全删除的记录版本。');
    }
    try { await client.remove(collection, envelope.recordId, envelope.revision, { signal }); }
    catch (error) { if (error?.status !== 404) throw error; }
  }

  async function perform(operation) {
    const { identity, controller } = operation;
    const collection = `chat-${identity.chatId}`;
    const assertCurrent = () => { currentHost(identity); operation.assertOwner?.(); };
    assertCurrent();
    invalidateRuntimes();
    await timeRuntime?.stop?.();
    assertCurrent();
    await autoHideController.stop();
    assertCurrent();

    operation.phase = 'deletingRecords'; notify();
    const listed = await client.list(collection, { signal: controller.signal });
    assertCurrent();
    if (!Array.isArray(listed)) throw errorWith('QQJ_DELETE_LIST_INVALID', '后端没有返回可核对的记录清单。');
    const records = [...listed];
    const regular = records.filter(item => item?.recordId !== V3_ROOT_RECORD_ID);
    const roots = records.filter(item => item?.recordId === V3_ROOT_RECORD_ID);
    let cursor = 0, firstError = null;
    await Promise.all(Array.from({ length: Math.min(4, regular.length) }, async () => {
      while (!firstError && cursor < regular.length) {
        const envelope = regular[cursor++];
        try {
          assertCurrent();
          await removeEnvelope(collection, envelope, controller.signal);
          operation.deletedCount += 1;
          assertCurrent();
        } catch (error) { firstError ??= error; }
      }
    }));
    if (firstError) throw firstError;
    for (const envelope of roots) {
      assertCurrent();
      await removeEnvelope(collection, envelope, controller.signal);
      operation.deletedCount += 1;
      assertCurrent();
    }

    operation.phase = 'deletingBinding'; notify();
    try {
      const binding = await client.get(CHAT_IDENTITY_COLLECTION, `binding-${identity.chatId}`);
      assertCurrent();
      await removeEnvelope(CHAT_IDENTITY_COLLECTION, { ...binding, recordId: `binding-${identity.chatId}` }, controller.signal);
      operation.deletedCount += 1;
      assertCurrent();
    } catch (error) { if (error?.status !== 404) throw error; }

    operation.phase = 'clearingHost'; notify();
    assertCurrent();
    await clearMessageMemoryKeys(identity, operation.assertOwner);
    assertCurrent();
    await clearMetadata(identity, operation);
    invalidateRuntimes(identity.chatId);
    session.resume(identity.chatId);
    return Object.freeze({ status: 'completed', hostChatId: identity.hostChatId, chatId: identity.chatId, deletedCount: operation.deletedCount });
  }

  function deleteCurrent({ clearPrequel = false, assertOwner = null } = {}) {
    if (active) return inCurrentHost(active.identity) ? active.promise : Promise.reject(errorWith('QQJ_DELETE_OTHER_CHAT_ACTIVE', '另一聊天正在删除记忆；当前聊天没有执行删除。'));
    let identity;
    try {
      if (pending && !inCurrentHost(pending.identity)) throw errorWith('QQJ_DELETE_OTHER_CHAT_PENDING', '另一聊天的记忆删除尚未完成；切回原聊天可继续删除。');
      identity = pending?.identity ?? session.identity();
      currentHost(identity);
      if (!pending && busy()) throw errorWith('QQJ_DELETE_BUSY', '当前正在生成或处理记忆，请等待完成后再删除。');
      if (!pending) session.suspend(identity.chatId);
    } catch (error) { return Promise.reject(error); }
    const operation = { identity, assertOwner: assertOwner ?? pending?.assertOwner, clearPrequel: clearPrequel || pending?.clearPrequel === true, controller: new AbortController(), phase: 'starting', deletedCount: pending?.deletedCount ?? 0, promise: null };
    active = operation; pending = null; lastResult = null; notify();
    operation.promise = perform(operation).then(result => {
      lastResult = result;
      return result;
    }).catch(error => {
      pending = Object.freeze({ identity, assertOwner: operation.assertOwner, clearPrequel: operation.clearPrequel, error: publicError(error), deletedCount: operation.deletedCount });
      logger?.warn?.('[qianqianjie] current chat memory deletion incomplete', { code: error?.code ?? error?.name ?? 'QQJ_DELETE_FAILED' });
      throw error;
    }).finally(() => { if (active === operation) active = null; notify(); });
    return operation.promise;
  }

  function fullRebuild(expectedChatId, options = {}) {
    const owner = readHostState(contextProvider());
    if (!owner.ok || (expectedChatId && owner.chatId !== expectedChatId)) return Promise.reject(errorWith('QQJ_REBUILD_CHAT_CHANGED', '当前聊天身份已经变化，完全重构未开始。'));
    const sameOwner = () => {
      const current = readHostState(contextProvider());
      if (!current.ok || current.hostChatId !== owner.hostChatId || current.characterAvatar !== owner.characterAvatar || current.personaAvatar !== owner.personaAvatar || isMainGenerationActive()) throw errorWith('QQJ_REBUILD_CHAT_CHANGED', '当前聊天或生成状态已经变化，完全重构已停止。');
    };
    if (rebuilding) return rebuilding.hostChatId === owner.hostChatId ? rebuilding.promise : Promise.reject(errorWith('QQJ_REBUILD_BUSY', '另一聊天正在完全重构。'));
    const operation = { hostChatId: owner.hostChatId, promise: null };
    rebuilding = operation; notify();
    operation.promise = (async () => {
      sameOwner();
      if (!pending) {
        try { session.identity(); }
        catch { await session.prepare(); sameOwner(); }
      }
      if (owner.chatId && readHostState(contextProvider()).chatId !== owner.chatId) throw errorWith('QQJ_REBUILD_CHAT_CHANGED', '确认的聊天身份已经变化，未删除新身份的数据。');
      await deleteCurrent({ clearPrequel: true, assertOwner: sameOwner });
      lastResult = null; notify();
      sameOwner();
      const prepared = await session.prepare();
      sameOwner();
      if (prepared?.status !== 'ready') throw errorWith('QQJ_REBUILD_IDENTITY_NOT_READY', '新聊天身份未完成准备，完全重构没有开始生成。');
      await timeRuntime?.authorizeHistory?.();
      return memoryRuntime.startHistoricalRebuild({ aggregate: options?.aggregate === true });
    })().finally(() => { if (rebuilding === operation) rebuilding = null; notify(); });
    return operation.promise;
  }

  return Object.freeze({
    deleteCurrent,
    fullRebuild,
    getState,
    subscribe(listener) { if (typeof listener !== 'function') throw new TypeError('删除状态 listener 无效'); subscribers.add(listener); return () => subscribers.delete(listener); },
  });
}

export const CHAT_RECALL_RECEIPT_KEY = RECEIPT_KEY;
