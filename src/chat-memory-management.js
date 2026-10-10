import { CHAT_IDENTITY_COLLECTION } from './chat-identity.js';
import { isUuid, readHostState } from './host-context.js';
import { V3_ROOT_RECORD_ID } from './v3/foundation-store.js';
import { captureTargetChatDescriptor } from './v3/host-adapter.js';
import { readTargetChat } from './v3/message-floor-anchor.js';
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
  vectorRuntime,
  timeRuntime,
  memoryMigration = null,
  autoHideController,
  coreRecordCache,
  captureHistoricalRebuildSources = snapshot => ({ context: snapshot.context, userIdentity: snapshot.userIdentity, worldInfo: {} }),
  createHistoricalRebuild = null,
  freshUuid = () => globalThis.crypto?.randomUUID?.(),
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
    let scopedRebuild = null;
    if (rebuilding) {
      try {
        const snapshot = hostAdapter.snapshot(), visibleChatId = snapshot.context?.chatMetadata?.qianqianjie?.chatId;
        const taskChatId = rebuilding.taskState?.chatId;
        if (snapshot.chatId === rebuilding.identity.hostChatId
          && (!visibleChatId || visibleChatId === rebuilding.chatId || visibleChatId === taskChatId)) scopedRebuild = rebuilding;
      } catch { /* task remains scoped to its captured target */ }
    }
    return Object.freeze({
      status: scopedActive ? 'deleting' : scopedPending ? 'failed' : scopedResult ? lastResult.status : 'idle',
      targetChatId: scopedActive?.identity.chatId ?? scopedPending?.identity.chatId ?? (scopedResult ? lastResult.chatId : null),
      phase: scopedActive?.phase ?? null,
      error: scopedPending?.error ?? null,
      deletedCount: scopedPending?.deletedCount ?? (scopedResult ? lastResult.deletedCount : 0),
      workBusy: busy() || Boolean(scopedRebuild?.promise) || memoryMigration?.getState?.().status === 'migrating',
      migrationState: memoryMigration?.getState?.() ?? Object.freeze({ status: 'idle' }),
      rebuildState: scopedRebuild?.taskState ?? null,
      pauseHistoricalRebuild: scopedRebuild?.taskControl?.pause ?? null,
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
      || foundation.activeRun || recall.activeRecall || people.active || vectorRuntime?.getState?.().active);
  }
  const invalidateRuntimes = deletedChatId => {
    // 一个投影清理失败仍继续清理其余投影，避免删除后保留旧材料。
    try { memoryRuntime?.invalidate?.(deletedChatId ? { deletedChatId } : undefined); } catch {}
    try { foundationRuntime?.invalidate?.(); } catch {}
    try { recallRuntime?.invalidate?.('memoryDeleted'); } catch {}
    try { recallRuntime?.clearCurrent?.(); } catch {}
    try { peopleRuntime?.invalidate?.(); } catch {}
    // 整档删除同时撤销派生向量任务，避免删除后的页面继续使用旧索引。
    try { vectorRuntime?.abortAll?.(); } catch {}
  };

  async function persistTargetCleanup(identity, target, initial, clearPrequel, allowMissingIdentity = false) {
    const latest = await readTargetChat(target, { fetchImpl, allowMissingIdentity });
    if (JSON.stringify(latest.header) !== JSON.stringify(initial.header) || JSON.stringify(latest.chat) !== JSON.stringify(initial.chat)) {
      throw errorWith('QQJ_DELETE_HOST_CONFLICT', '原聊天正文或元数据已改变，未覆盖人工修改。');
    }
    const header = clone(latest.header), messages = clone(latest.chat);
    const metadata = header.chat_metadata;
    const hadPrequel = Object.hasOwn(metadata, 'qianqianjiePrequel');
    const previousPrequel = metadata.qianqianjiePrequel;
    delete metadata.qianqianjie;
    if (clearPrequel) delete metadata.qianqianjiePrequel;
    const restoredIndexes = new Set();
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const message = messages[messageIndex];
      if (hasValidAutoHideMarker(message?.extra)) { message.is_system = false; restoredIndexes.add(messageIndex); }
      const extra = clearMemoryKeys(message?.extra);
      if (extra) message.extra = extra;
      if (Array.isArray(message?.swipe_info)) message.swipe_info = message.swipe_info.map(swipe => {
        const swipeExtra = clearMemoryKeys(swipe?.extra);
        return swipeExtra ? { ...swipe, extra: swipeExtra } : swipe;
      });
    }
    const expected = [header, ...messages];
    const response = await fetchImpl('/api/chats/save', {
      method: 'POST', cache: 'no-cache', headers: target.requestHeaders ?? {},
      body: JSON.stringify({ ch_name: target.characterName, file_name: target.hostChatId, avatar_url: target.avatarUrl, chat: expected, force: false }),
    });
    if (!response?.ok) throw errorWith([400, 409].includes(response?.status) ? 'QQJ_DELETE_HOST_CONFLICT' : 'QQJ_DELETE_HOST_SAVE_FAILED', '原聊天清理未能保存。');
    const persisted = await readTargetChat(target, { fetchImpl, allowMissingIdentity: true });
    const stripIntegrity = value => { const next = clone(value); if (next?.chat_metadata) delete next.chat_metadata.integrity; return next; };
    if (persisted.chat.length !== messages.length || JSON.stringify(persisted.chat) !== JSON.stringify(messages)
      || persisted.header.chat_metadata?.qianqianjie !== undefined
      || (clearPrequel && persisted.header.chat_metadata?.qianqianjiePrequel !== undefined)
      || JSON.stringify(stripIntegrity(persisted.header)) !== JSON.stringify(stripIntegrity(header))
      || persisted.chat.some(hasMemoryKeys)
      || [...restoredIndexes].some(index => persisted.chat[index]?.is_system !== false)) {
      throw errorWith('QQJ_DELETE_HOST_VERIFY_FAILED', '原聊天清理没有通过读回核验，可重试。');
    }
    if (inCurrentHost(identity)) {
      const current = hostAdapter.snapshot();
      const previous = initial.chat;
      if (current.chat?.length === previous.length && JSON.stringify(current.chat) === JSON.stringify(previous)) {
        if (JSON.stringify(current.context.chatMetadata) !== JSON.stringify(initial.header.chat_metadata)) return messages.length;
        current.chat.forEach((message, index) => {
          for (const key of Object.keys(message)) delete message[key];
          Object.assign(message, clone(persisted.chat[index]));
        });
        for (const key of Object.keys(current.context.chatMetadata)) delete current.context.chatMetadata[key];
        Object.assign(current.context.chatMetadata, clone(persisted.header.chat_metadata));
        try {
          if (globalThis.document) for (const node of globalThis.document.querySelectorAll('#chat .mes[mesid]')) {
            if (restoredIndexes.has(Number(node.getAttribute('mesid')))) node.setAttribute('is_system', 'false');
          }
          current.context.swipe?.refresh?.();
        } catch { /* saved data is authoritative */ }
      }
    }
    return messages.length;
  }

  async function adoptRebuiltTarget(identity, target, cleaned, rebuilt, chatBaseline = cleaned.chat, onAdopted = null) {
    if (!isUuid(rebuilt?.chatId)) return false;
    try {
      const rebuiltTarget = { ...target, chatId: rebuilt.chatId };
      const persisted = await readTargetChat(rebuiltTarget, { fetchImpl });
      const current = hostAdapter.snapshot();
      const currentMetadata = clone(current.context.chatMetadata ?? {});
      if (currentMetadata.qianqianjie?.schemaVersion === 2 && currentMetadata.qianqianjie.chatId === rebuilt.chatId) delete currentMetadata.qianqianjie;
      if (current.chatId !== identity.hostChatId || JSON.stringify(current.chat) !== JSON.stringify(chatBaseline)
        || JSON.stringify(currentMetadata) !== JSON.stringify(cleaned.header.chat_metadata ?? {})) return false;
      current.chat.forEach((message, index) => {
        for (const key of Object.keys(message)) delete message[key];
        Object.assign(message, clone(persisted.chat[index]));
      });
      for (const key of Object.keys(current.context.chatMetadata)) delete current.context.chatMetadata[key];
      Object.assign(current.context.chatMetadata, clone(persisted.header.chat_metadata ?? {}));
      onAdopted?.(captureChatAdoptionBaseline(current.chat));
      const prepared = await session.prepare();
      if (prepared?.status !== 'ready' || prepared.identity?.chatId !== rebuilt.chatId) return false;
      await foundationRuntime?.refreshStatus?.();
      await memoryRuntime?.refreshStatus?.();
      return true;
    } catch { /* the target job remains complete; the visible view can refresh through its normal lifecycle */ }
    return false;
  }

  function captureChatAdoptionBaseline(chat) {
    return chat.map(message => message && typeof message === 'object' ? {
      ...message,
      extra: message.extra && typeof message.extra === 'object' ? { ...message.extra } : message.extra,
      swipe_info: Array.isArray(message.swipe_info) ? message.swipe_info.map(swipe => swipe && typeof swipe === 'object' ? {
        ...swipe,
        extra: swipe.extra && typeof swipe.extra === 'object' ? { ...swipe.extra } : swipe.extra,
      } : swipe) : message.swipe_info,
    } : message);
  }

  const clearMemoryKeys = extra => {
    if (!extra || typeof extra !== 'object' || Array.isArray(extra) || !MEMORY_MESSAGE_KEYS.some(key => Object.hasOwn(extra, key))) return null;
    const next = { ...extra };
    for (const key of MEMORY_MESSAGE_KEYS) delete next[key];
    return next;
  };
  const hasMemoryKeys = message => MEMORY_MESSAGE_KEYS.some(key => Object.hasOwn(message?.extra ?? {}, key))
    || (Array.isArray(message?.swipe_info) && message.swipe_info.some(swipe => MEMORY_MESSAGE_KEYS.some(key => Object.hasOwn(swipe?.extra ?? {}, key))));
  // Only a valid marker from this plugin grants permission to restore a message's visibility.
  const hasValidAutoHideMarker = extra => extra?.[AUTO_HIDE_KEY]?.schemaVersion === 1 && isUuid(extra[AUTO_HIDE_KEY].chatId);

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
    const assertCurrent = () => { operation.assertOwner?.(); };
    invalidateRuntimes(identity.chatId);
    const stopTime = timeRuntime?.stop?.();
    const stopAutoHide = autoHideController.stop();
    await Promise.all([stopTime, stopAutoHide]);
    const initialTargetChat = await readTargetChat(operation.target, { fetchImpl, allowMissingIdentity: operation.skipSessionResume });

    operation.phase = 'deletingRecords'; notify();
    const listed = await client.list(collection, { signal: controller.signal });
    assertCurrent();
    if (!Array.isArray(listed)) throw errorWith('QQJ_DELETE_LIST_INVALID', '后端没有返回可核对的记录清单。');
    const records = [...listed];
    const roots = records.filter(item => item?.recordId === V3_ROOT_RECORD_ID);
    const regular = records.filter(item => item?.recordId !== V3_ROOT_RECORD_ID);
    for (const envelope of roots) {
      assertCurrent();
      await removeEnvelope(collection, envelope, controller.signal);
      operation.deletedCount += 1;
      await coreRecordCache?.invalidateIdentity?.(identity);
      assertCurrent();
    }
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

    operation.phase = 'deletingBinding'; notify();
    try {
      const binding = await client.get(CHAT_IDENTITY_COLLECTION, `binding-${identity.chatId}`);
      assertCurrent();
      await removeEnvelope(CHAT_IDENTITY_COLLECTION, { ...binding, recordId: `binding-${identity.chatId}` }, controller.signal);
      operation.deletedCount += 1;
      assertCurrent();
    } catch (error) { if (error?.status !== 404) throw error; }

    operation.phase = 'clearingHost'; notify();
    await persistTargetCleanup(identity, operation.target, initialTargetChat, operation.clearPrequel, operation.skipSessionResume);
    if (!operation.skipSessionResume) session.resume(identity.chatId);
    return Object.freeze({ status: 'completed', hostChatId: identity.hostChatId, chatId: identity.chatId, deletedCount: operation.deletedCount });
  }

  function deleteCurrent({ clearPrequel = false, assertOwner = null, identityOverride = null, targetOverride = null, skipSuspend = false } = {}) {
    if (active) {
      if (inCurrentHost(active.identity)) return active.promise;
      return Promise.reject(errorWith('QQJ_DELETE_BUSY', '另一聊天记忆清理仍在执行，请等待完成后再操作。'));
    }
    let identity;
    let target;
    try {
      if (identityOverride) {
        identity = identityOverride;
        target = targetOverride ?? pending?.target ?? captureTargetChatDescriptor(currentHost(identity), identity);
      } else if (pending && inCurrentHost(pending.identity)) {
        identity = pending.identity;
        target = pending.target;
      } else {
        if (pending) throw errorWith('QQJ_DELETE_BUSY', '另一聊天记忆清理尚未完成，请等待后再操作。');
        identity = session.identity();
        target = captureTargetChatDescriptor(currentHost(identity), identity);
      }
      if (!pending && busy()) throw errorWith('QQJ_DELETE_BUSY', '当前正在生成或处理记忆，请等待完成后再删除。');
      if (!pending && !skipSuspend) session.suspend(identity.chatId);
    } catch (error) { return Promise.reject(error); }
    const operation = { identity, target, assertOwner: assertOwner ?? pending?.assertOwner, clearPrequel: clearPrequel || pending?.clearPrequel === true, skipSessionResume: skipSuspend, controller: new AbortController(), phase: 'starting', deletedCount: pending?.deletedCount ?? 0, promise: null };
    active = operation; pending = null; lastResult = null; notify();
    operation.promise = perform(operation).then(result => {
      lastResult = result;
      return result;
    }).catch(error => {
      pending = Object.freeze({ identity, target, assertOwner: operation.assertOwner, clearPrequel: operation.clearPrequel, error: publicError(error), deletedCount: operation.deletedCount });
      logger?.warn?.('[qianqianjie] current chat memory deletion incomplete', { code: error?.code ?? error?.name ?? 'QQJ_DELETE_FAILED' });
      throw error;
    }).finally(() => { if (active === operation) active = null; notify(); });
    return operation.promise;
  }

  function fullRebuild(expectedChatId, options = {}) {
    if (typeof createHistoricalRebuild !== 'function') return Promise.reject(errorWith('QQJ_REBUILD_UNAVAILABLE', '目标聊天重构任务尚未接入。'));
    if (rebuilding) {
      let sameTarget = false;
      try {
        const snapshot = hostAdapter.snapshot(), visibleChatId = snapshot.context?.chatMetadata?.qianqianjie?.chatId;
        sameTarget = snapshot.chatId === rebuilding.identity.hostChatId
          && (!visibleChatId || visibleChatId === rebuilding.chatId || visibleChatId === rebuilding.taskState?.chatId);
      } catch { /* another active target is busy */ }
      if (!sameTarget) return Promise.reject(errorWith('QQJ_REBUILD_BUSY', '另一聊天的完全重构仍在执行。'));
      if (rebuilding.promise) return rebuilding.promise;
      if (!rebuilding.taskControl || !['paused', 'failed'].includes(rebuilding.taskState?.rebuildStatus)) return Promise.resolve(rebuilding.taskState);
      return continueHistoricalRebuild(rebuilding);
    }
    let identity, target, sources, initialSnapshot, provisionalIdentity = false, preserveMigrationPrefix = false;
    try {
      initialSnapshot = hostAdapter.snapshot();
      if (pending && inCurrentHost(pending.identity)) identity = pending.identity;
      else {
        try { identity = session.identity(); }
        catch (error) {
          const metadataChatId = initialSnapshot.context?.chatMetadata?.qianqianjie?.chatId;
          const host = readHostState(initialSnapshot.context);
          if (error?.code !== 'CHAT_SESSION_NOT_READY' || isUuid(metadataChatId) || !host.ok || typeof freshUuid !== 'function') throw error;
          identity = Object.freeze({ hostChatId: host.hostChatId, chatId: freshUuid(), characterLocator: host.characterAvatar,
            personaLocator: host.personaAvatar });
          provisionalIdentity = true;
        }
      }
      if (expectedChatId && identity.chatId !== expectedChatId) throw errorWith('QQJ_REBUILD_TARGET_INVALID', '重构目标身份与当前请求不一致。');
      target = pending?.identity?.chatId === identity.chatId ? pending.target : captureTargetChatDescriptor(initialSnapshot, identity);
      sources = captureHistoricalRebuildSources(initialSnapshot);
      const reachable = foundationRuntime?.getReachable?.();
      preserveMigrationPrefix = reachable?.root?.chatId === identity.chatId && Boolean(reachable.migrationDescriptor);
      if (busy()) throw errorWith('QQJ_REBUILD_BUSY', '当前记忆管理或生成任务仍在执行，请稍候再重构。');
      if (!pending && !provisionalIdentity && !preserveMigrationPrefix && inCurrentHost(identity)) session.suspend(identity.chatId);
    } catch (error) { return Promise.reject(error); }
    const operation = { identity, hostChatId: identity.hostChatId, chatId: identity.chatId, taskControl: null, taskState: null, unsubscribeTask: null, promise: null };
    rebuilding = operation; notify();
    operation.promise = (async () => {
      let cleaned;
      if (preserveMigrationPrefix) {
        // Historical maintenance runs against the existing migration-aware graph; deleting its root would erase the archive.
        cleaned = await readTargetChat(target, { fetchImpl });
      } else {
        await deleteCurrent({ clearPrequel: true, identityOverride: identity, targetOverride: target, skipSuspend: provisionalIdentity });
        lastResult = null; notify();
        cleaned = await readTargetChat(target, { fetchImpl, allowMissingIdentity: true });
      }
      operation.chatBaseline = captureChatAdoptionBaseline(cleaned.chat);
      operation.target = target; operation.cleaned = cleaned; operation.aggregate = options?.aggregate === true;
      const result = await createHistoricalRebuild({ identity, target, cleanedChat: cleaned, sourceContext: sources.context,
        sourceUserIdentity: sources.userIdentity, sourceWorldInfo: sources.worldInfo,
        provisionalIdentity, aggregate: options?.aggregate === true, forceMigrationRebuild: preserveMigrationPrefix,
        onTaskControl: control => attachTaskControl(operation, control) });
      return finishHistoricalRebuild(operation, identity, target, cleaned, result);
    })().catch(error => {
      operation.taskState = operation.taskControl?.getState?.() ?? Object.freeze({ rebuildStatus: 'failed' });
      operation.promise = null;
      if (!operation.taskControl && rebuilding === operation) rebuilding = null;
      notify(); throw error;
    });
    return operation.promise;
  }

  function migrateCurrent() {
    if (typeof memoryMigration?.migrateCurrent !== 'function') return Promise.reject(errorWith('QQJ_MIGRATION_UNAVAILABLE', '当前版本尚未接入一键记忆搬家。'));
    if (busy() || rebuilding || active) return Promise.reject(errorWith('QQJ_MIGRATION_BUSY', '当前记忆任务完成后再搬家。'));
    let task;
    try { task = memoryMigration.migrateCurrent(); }
    catch (error) { notify(); return Promise.reject(error); }
    notify();
    return Promise.resolve(task).finally(notify);
  }

  function attachTaskControl(operation, control) {
    operation.taskControl = control;
    operation.taskState = control?.getState?.() ?? null;
    operation.unsubscribeTask?.();
    operation.unsubscribeTask = control?.subscribe?.(state => { operation.taskState = state; notify(); }) ?? null;
    notify();
  }

  async function finishHistoricalRebuild(operation, identity, target, cleaned, result) {
    const rebuilt = result?.rebuildStatus ? result : result?.state?.rebuildStatus ? result.state : result;
    operation.taskState = rebuilt;
    if (['paused', 'failed', 'partial'].includes(rebuilt?.rebuildStatus)) {
      await adoptRebuiltTarget(identity, target, cleaned, rebuilt, operation.chatBaseline, baseline => { operation.chatBaseline = baseline; });
      operation.promise = null; notify(); return rebuilt;
    }
    await adoptRebuiltTarget(identity, target, cleaned, rebuilt, operation.chatBaseline, baseline => { operation.chatBaseline = baseline; });
    operation.unsubscribeTask?.();
    operation.unsubscribeTask = null;
    if (rebuilding === operation) rebuilding = null;
    notify();
    return rebuilt;
  }

  function continueHistoricalRebuild(operation) {
    operation.promise = Promise.resolve().then(() => operation.taskControl.start({ aggregate: operation.aggregate === true }))
      .then(result => finishHistoricalRebuild(operation, operation.identity, operation.target, operation.cleaned, result))
      .catch(error => { operation.taskState = operation.taskControl?.getState?.() ?? Object.freeze({ rebuildStatus: 'failed' }); operation.promise = null; notify(); throw error; });
    return operation.promise;
  }

  return Object.freeze({
    deleteCurrent,
    fullRebuild,
    migrateCurrent,
    getState,
    subscribe(listener) { if (typeof listener !== 'function') throw new TypeError('删除状态 listener 无效'); subscribers.add(listener); return () => subscribers.delete(listener); },
  });
}

export const CHAT_RECALL_RECEIPT_KEY = RECEIPT_KEY;
