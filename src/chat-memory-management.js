import { CHAT_IDENTITY_COLLECTION } from './chat-identity.js';
import { isUuid } from './host-context.js';
import { V3_ROOT_RECORD_ID } from './v3/foundation-store.js';
import { MESSAGE_FLOOR_ANCHOR_KEY } from './v3/message-floor-anchor.js';
import { publicErrorMessage } from './public-error.js';

const RECEIPT_KEY = 'qqj_v3_recall_receipt';
const MEMORY_MESSAGE_KEYS = Object.freeze([RECEIPT_KEY, MESSAGE_FLOOR_ANCHOR_KEY]);
const errorWith = (code, message) => Object.assign(new Error(message), { code });
const clone = value => structuredClone(value);

function publicError(error) {
  return publicErrorMessage(error, { fallback: '删除未完成，请重试。' });
}

export function createChatMemoryManagement({
  client,
  session,
  hostAdapter,
  foundationRuntime,
  memoryRuntime,
  recallRuntime,
  peopleRuntime,
  autoHideController,
  isMainGenerationActive = () => false,
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  if (!client?.list || !client?.get || !client?.remove || !session?.identity || !session?.suspend || !session?.resume || !hostAdapter?.snapshot || !autoHideController?.restoreOwned || typeof fetchImpl !== 'function') {
    throw new TypeError('当前聊天记忆删除依赖无效');
  }
  let active = null;
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
      workBusy: busy(),
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

  async function clearMessageMemoryKeys(identity) {
    const snapshot = currentHost(identity);
    const changed = [];
    for (const message of snapshot.chat) {
      const nextExtra = clearMemoryKeys(message?.extra);
      let swipeChanged = false;
      const nextSwipeInfo = Array.isArray(message?.swipe_info) ? message.swipe_info.map(swipe => {
        const next = clearMemoryKeys(swipe?.extra);
        if (!next) return swipe;
        swipeChanged = true;
        return { ...swipe, extra: next };
      }) : message?.swipe_info;
      if (!nextExtra && !swipeChanged) continue;
      changed.push({ message, extra: message.extra, swipeInfo: message.swipe_info });
      if (nextExtra) message.extra = nextExtra;
      if (swipeChanged) message.swipe_info = nextSwipeInfo;
    }
    if (!changed.length) return 0;
    try {
      if (typeof snapshot.context?.saveChat !== 'function') throw errorWith('QQJ_DELETE_CHAT_SAVE_UNAVAILABLE', '宿主不支持保存聊天记忆标识清理结果。');
      await snapshot.context.saveChat();
      currentHost(identity);
      const persisted = await readPersistedChat(identity);
      if (persisted.messages.length !== snapshot.chat.length || persisted.messages.some(hasMemoryKeys)) {
        throw errorWith('QQJ_DELETE_RECEIPT_VERIFY_FAILED', '聊天记忆标识没有完成持久化；原身份已保留，可重试。');
      }
      currentHost(identity);
      return changed.length;
    } catch (error) {
      for (const item of changed) { item.message.extra = item.extra; item.message.swipe_info = item.swipeInfo; }
      throw error;
    }
  }

  async function clearMetadata(identity) {
    const snapshot = currentHost(identity);
    const context = snapshot.context;
    const metadata = context.chatMetadata;
    const previous = clone(metadata.qianqianjie);
    delete metadata.qianqianjie;
    try {
      if (typeof context.saveChatMetadata === 'function') {
        if (await context.saveChatMetadata() !== true) throw errorWith('QQJ_DELETE_METADATA_SAVE_FAILED', '聊天元数据未能持久化。');
      } else if (typeof context.saveMetadata === 'function') await context.saveMetadata();
      else throw errorWith('QQJ_DELETE_METADATA_SAVE_UNAVAILABLE', '宿主不支持保存聊天元数据。');
      if (context.chatMetadata?.qianqianjie !== undefined) throw errorWith('QQJ_DELETE_METADATA_VERIFY_FAILED', '聊天元数据清理后未能读回。');
      const persisted = await readPersistedChat(identity, { requireMetadata: false });
      if (persisted.metadata?.qianqianjie !== undefined) throw errorWith('QQJ_DELETE_METADATA_VERIFY_FAILED', '聊天元数据没有完成持久化；原身份已保留，可重试。');
    } catch (error) {
      metadata.qianqianjie = previous;
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
    if (!operation.visibilityRestored) {
      operation.phase = 'restoringVisibility'; notify();
      currentHost(identity);
      const visibility = await autoHideController.restoreOwned(identity.chatId);
      if (!['applied', 'unchanged'].includes(visibility?.status)) {
        throw errorWith('QQJ_DELETE_VISIBILITY_RESTORE_FAILED', '本插件隐藏的聊天楼层尚未恢复，已停止删除记忆。');
      }
      operation.visibilityRestored = true;
    }
    currentHost(identity);
    invalidateRuntimes();

    operation.phase = 'deletingRecords'; notify();
    const listed = await client.list(collection, { signal: controller.signal });
    if (!Array.isArray(listed)) throw errorWith('QQJ_DELETE_LIST_INVALID', '后端没有返回可核对的记录清单。');
    const records = [...listed];
    const regular = records.filter(item => item?.recordId !== V3_ROOT_RECORD_ID);
    const roots = records.filter(item => item?.recordId === V3_ROOT_RECORD_ID);
    for (const envelope of [...regular, ...roots]) {
      currentHost(identity);
      await removeEnvelope(collection, envelope, controller.signal);
      operation.deletedCount += 1;
    }

    operation.phase = 'deletingBinding'; notify();
    try {
      const binding = await client.get(CHAT_IDENTITY_COLLECTION, `binding-${identity.chatId}`);
      await removeEnvelope(CHAT_IDENTITY_COLLECTION, { ...binding, recordId: `binding-${identity.chatId}` }, controller.signal);
      operation.deletedCount += 1;
    } catch (error) { if (error?.status !== 404) throw error; }

    operation.phase = 'clearingHost'; notify();
    await clearMessageMemoryKeys(identity);
    await clearMetadata(identity);
    invalidateRuntimes(identity.chatId);
    session.resume(identity.chatId);
    return Object.freeze({ status: 'completed', hostChatId: identity.hostChatId, chatId: identity.chatId, deletedCount: operation.deletedCount });
  }

  function deleteCurrent() {
    if (active) return inCurrentHost(active.identity) ? active.promise : Promise.reject(errorWith('QQJ_DELETE_OTHER_CHAT_ACTIVE', '另一聊天正在删除记忆；当前聊天没有执行删除。'));
    let identity;
    try {
      if (pending && !inCurrentHost(pending.identity)) throw errorWith('QQJ_DELETE_OTHER_CHAT_PENDING', '另一聊天的记忆删除尚未完成；切回原聊天可继续删除。');
      identity = pending?.identity ?? session.identity();
      currentHost(identity);
      if (!pending && busy()) throw errorWith('QQJ_DELETE_BUSY', '当前正在生成或处理记忆，请等待完成后再删除。');
      if (!pending) session.suspend(identity.chatId);
    } catch (error) { return Promise.reject(error); }
    const operation = { identity, controller: new AbortController(), phase: 'starting', deletedCount: pending?.deletedCount ?? 0, visibilityRestored: pending?.visibilityRestored === true, promise: null };
    active = operation; pending = null; lastResult = null; notify();
    operation.promise = perform(operation).then(result => {
      lastResult = result;
      return result;
    }).catch(error => {
      pending = Object.freeze({ identity, error: publicError(error), deletedCount: operation.deletedCount, visibilityRestored: operation.visibilityRestored });
      logger?.warn?.('[qianqianjie] current chat memory deletion incomplete', { code: error?.code ?? error?.name ?? 'QQJ_DELETE_FAILED' });
      throw error;
    }).finally(() => { if (active === operation) active = null; notify(); });
    return operation.promise;
  }

  return Object.freeze({
    deleteCurrent,
    getState,
    subscribe(listener) { if (typeof listener !== 'function') throw new TypeError('删除状态 listener 无效'); subscribers.add(listener); return () => subscribers.delete(listener); },
  });
}

export const CHAT_RECALL_RECEIPT_KEY = RECEIPT_KEY;
