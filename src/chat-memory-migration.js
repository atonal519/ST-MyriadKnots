import { sha256 } from './identity.js';
import { isUuid } from './host-context.js';
import { CHAT_IDENTITY_COLLECTION } from './chat-identity.js';
import { captureTargetChatDescriptor } from './v3/host-adapter.js';
import { readTargetChat } from './v3/message-floor-anchor.js';
import { deterministicUuid, selectAssistantMessage } from './v3/foundation-domain.js';
import { sanitizeMemoryContent } from './memory-content-sanitizer.js';
import { initializeMigrationGraph, selectCompletedCarriedAliases } from './v3/memory-migration.js';
import { MIGRATION_ALIAS_KEY, migrationPartition } from './v3/migration-prefix.js';

const RECEIPT_KEY = 'qqj_v3_recall_receipt';
const ANCHOR_KEY = 'qianqianjie_floor';
const AUTO_HIDE_KEY = 'qianqianjieAutoHide';
const fail = (code, message) => Object.assign(new Error(message), { code });
const clone = value => structuredClone(value);
const fingerprint = async value => `sha256:${await sha256(value)}`;

export function cleanOwnedMessage(message, { ai = false, aliasId = null, sourceChatId = null } = {}) {
  const { swipes: _oldSwipes, swipe_info: _oldSwipeInfo, ...payload } = message;
  const result = clone(payload);
  const cleanExtra = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return aliasId && !value ? { [MIGRATION_ALIAS_KEY]: aliasId } : value;
    const next = { ...value };
    delete next[RECEIPT_KEY]; delete next[ANCHOR_KEY]; delete next[AUTO_HIDE_KEY]; delete next[MIGRATION_ALIAS_KEY];
    if (aliasId) next[MIGRATION_ALIAS_KEY] = aliasId;
    return next;
  };
  if (ai && aliasId) result.extra = cleanExtra(result.extra) ?? {};
  else if (result.extra) result.extra = cleanExtra(result.extra);
  if (result.is_system === true && message?.extra?.[AUTO_HIDE_KEY]?.schemaVersion === 1
    && message.extra[AUTO_HIDE_KEY].chatId === sourceChatId) result.is_system = false;
  if (ai) {
    const selected = selectAssistantMessage(message);
    if (!selected) throw fail('QQJ_MIGRATION_CARRY_INVALID', '要携带的 AI 消息已没有有效选中内容。');
    const selectedInfo = Number.isSafeInteger(message.swipe_id) && Array.isArray(message.swipe_info)
      ? message.swipe_info[message.swipe_id] : message.swipe_info?.[0];
    result.mes = selected.rawContent;
    result.swipes = [selected.rawContent];
    result.swipe_id = 0;
    result.swipe_info = selectedInfo ? [{ ...selectedInfo, extra: cleanExtra(selectedInfo.extra) }] : [];
  } else if (Array.isArray(_oldSwipes)) {
    const index = Number.isSafeInteger(message.swipe_id) ? message.swipe_id : 0;
    const selected = _oldSwipes[index];
    result.mes = typeof selected === 'string' ? selected : String(message.mes ?? '');
    result.swipes = [result.mes]; result.swipe_id = 0;
    result.swipe_info = Array.isArray(message.swipe_info) && message.swipe_info[index]
      ? [{ ...message.swipe_info[index], extra: cleanExtra(message.swipe_info[index].extra) }] : [];
  }
  return result;
}

export function chooseCarry(snapshot, freshUuid, sourceChatId) {
  const chat = snapshot.chat;
  let aiIndex = -1;
  for (let index = chat.length - 1; index >= 0; index -= 1) {
    const message = chat[index];
    const ownedHidden = message?.extra?.[AUTO_HIDE_KEY]?.schemaVersion === 1
      && message.extra[AUTO_HIDE_KEY].chatId === sourceChatId;
    if (message?.is_system === true && !ownedHidden) continue;
    if (selectAssistantMessage(message)) { aiIndex = index; break; }
  }
  let tailIndex = chat.length - 1;
  while (tailIndex >= 0) {
    const message = chat[tailIndex], ownedHidden = message?.extra?.[AUTO_HIDE_KEY]?.schemaVersion === 1
      && message.extra[AUTO_HIDE_KEY].chatId === sourceChatId;
    if (message?.extra?.type === 'narrator' || message?.is_system === true && !ownedHidden) tailIndex -= 1;
    else break;
  }
  const tailMessage = chat[tailIndex];
  const tailOwnedHidden = tailMessage?.extra?.[AUTO_HIDE_KEY]?.schemaVersion === 1 && tailMessage.extra[AUTO_HIDE_KEY].chatId === sourceChatId;
  const pendingUserIndex = tailIndex >= 0 && tailMessage?.is_user === true && (!tailMessage.is_system || tailOwnedHidden) ? tailIndex : -1;
  let userIndex = -1;
  const aliasId = aiIndex >= 0 ? freshUuid() : null;
  userIndex = pendingUserIndex >= 0 ? pendingUserIndex : aiIndex >= 0 ? (() => {
    for (let index = aiIndex - 1; index >= 0; index -= 1) {
      const message = chat[index], ownedHidden = message?.extra?.[AUTO_HIDE_KEY]?.schemaVersion === 1
        && message.extra[AUTO_HIDE_KEY].chatId === sourceChatId;
      if (message?.is_user === true && (!message.is_system || ownedHidden) && message.extra?.type !== 'narrator') return index;
    }
    return -1;
  })() : -1;
  const indexes = [userIndex, aiIndex].filter(index => index >= 0).sort((left, right) => left - right);
  const aiMessage = aiIndex >= 0 ? chat[aiIndex] : null;
  const selected = aiMessage ? selectAssistantMessage(aiMessage) : null;
  const sourceAnchor = aiMessage?.extra?.[ANCHOR_KEY];
  const messages = indexes.map(index => cleanOwnedMessage(chat[index], { ai: index === aiIndex,
    aliasId: index === aiIndex ? aliasId : null, sourceChatId }));
  return Object.freeze({ indexes: Object.freeze(indexes), messages: Object.freeze(messages), aliasId,
    aiIndex: indexes.includes(aiIndex) ? aiIndex : -1, userIndex: indexes.includes(userIndex) ? userIndex : -1,
    selectedRawContent: selected?.rawContent ?? null, sourceSwipeId: selected?.swipeId ?? null,
    selectedSwipeIndex: selected?.selectedSwipeIndex ?? null,
    sourceFloorId: sourceAnchor?.chatId === sourceChatId && isUuid(sourceAnchor.floorId) ? sourceAnchor.floorId : null,
    sourceAliasId: aiMessage?.extra?.[MIGRATION_ALIAS_KEY] ?? null });
}

function uniqueFileName(names, characterName, date) {
  const used = new Set((names ?? []).map(value => String(value).replace(/\.jsonl$/i, '')));
  const stem = `${characterName} - memory migration ${date.replace(/[:.]/g, '-')}`;
  let name = stem, suffix = 2;
  while (used.has(name)) name = `${stem} (${suffix++})`;
  return name;
}

export function selectCarriedSourceFloor(reachable, { priorAliasId = null, sourceFloorId = null, sourceMessageIndex = -1 } = {}) {
  const prior = priorAliasId && reachable?.migrationDescriptor?.carriedAliases?.find(item => item.aliasId === priorAliasId);
  if (prior) return reachable.floors.find(item => item.id === prior.floorId) ?? null;
  const liveFloors = migrationPartition(reachable).liveFloors;
  if (sourceFloorId) return liveFloors.find(item => item.id === sourceFloorId) ?? null;
  return liveFloors.find(item => item.hostLocator.messageIndex === sourceMessageIndex) ?? null;
}

export function createChatMemoryMigration({ client, session, hostAdapter, sourceStoreForIdentity,
  sanitizerOptions = () => ({}), listHostChats, freshUuid = () => globalThis.crypto?.randomUUID?.(),
  now = () => new Date(), fetchImpl = globalThis.fetch, copyPeople = null, copyTime = null, copyVector = null,
  captureStoryCalendar = () => null, persistStoryCalendar = async () => {},
} = {}) {
  if (!client?.get || !client?.put || !session?.identity || !hostAdapter?.snapshot || typeof sourceStoreForIdentity !== 'function'
    || typeof listHostChats !== 'function' || typeof fetchImpl !== 'function') throw new TypeError('记忆搬家依赖无效');
  let active = null;

  async function migrateCurrent() {
    if (active) throw fail('QQJ_MIGRATION_BUSY', '当前记忆搬家仍在执行。');
    const { identity, host, capturedUserName, capturedPrequel, capturedCalendar, carried } = (() => {
      const snapshot = hostAdapter.snapshot();
      const identity = session.identity();
      if (snapshot.chatId !== identity.hostChatId || snapshot.context?.chatMetadata?.qianqianjie?.chatId !== identity.chatId
        || !Array.isArray(snapshot.chat)) throw fail('QQJ_MIGRATION_SOURCE_INVALID', '当前聊天身份尚未准备完成，无法搬家。');
      const capturedHost = captureTargetChatDescriptor(snapshot, identity);
      const host = Object.freeze({ ...capturedHost, requestHeaders: Object.freeze({ ...(capturedHost.requestHeaders ?? {}) }) });
      const capturedUserName = String(snapshot.context.name1 ?? snapshot.context.userName ?? '');
      const capturedPrequel = typeof snapshot.context.chatMetadata?.qianqianjiePrequel === 'string' ? snapshot.context.chatMetadata.qianqianjiePrequel : null;
      const capturedCalendarValue = captureStoryCalendar(identity.chatId);
      const capturedCalendar = capturedCalendarValue ? structuredClone(capturedCalendarValue) : null;
      // Only these bounded payloads and scalar target fields survive the synchronous capture scope.
      const carried = chooseCarry(snapshot, freshUuid, identity.chatId);
      return Object.freeze({ identity, host, capturedUserName, capturedPrequel, capturedCalendar, carried });
    })();
    const operation = { sourceChatId: identity.chatId, hostChatId: identity.hostChatId, status: 'preparing' };
    active = operation;
    try {
      const sourceStore = sourceStoreForIdentity(identity);
      // Runtime mode strictly validates immutable business records; B rebuilds its own derived indexes.
      const sourceReachable = await sourceStore.readReachable({ mode: 'runtime' });
      if (sourceReachable.status !== 'ready' || sourceReachable.root.chatId !== identity.chatId) throw fail('QQJ_MIGRATION_SOURCE_NOT_READY', '当前完整记忆尚未通过读取校验，未创建新聊天。');
      const names = await listHostChats(host.avatarUrl);
      const created = now();
      const targetHostChatId = uniqueFileName(names, host.characterName, created.toISOString());
      const targetChatId = freshUuid();
      if (!isUuid(targetChatId)) throw fail('QQJ_MIGRATION_ID_INVALID', '新聊天编号无效。');
      const targetIdentity = Object.freeze({ ...identity, hostChatId: targetHostChatId, chatId: targetChatId });
      const target = Object.freeze({ ...host, chatId: targetChatId, hostChatId: targetHostChatId });
      const targetNarrativeGeneration = await deterministicUuid(['qqj-migration-generation-v1', targetChatId,
        sourceReachable.root.narrativeGeneration, sourceReachable.root.headCheckpointId]);
      const targetChat = carried.messages;
      const sourceCandidates = [];
      if (carried.aiIndex >= 0) {
        const canonicalContent = sanitizeMemoryContent(carried.selectedRawContent, sanitizerOptions());
        const [rawFingerprint, canonicalFingerprint] = await Promise.all([
          fingerprint(carried.selectedRawContent), fingerprint(canonicalContent),
        ]);
        const existingAlias = carried.sourceAliasId;
        const inherited = existingAlias && sourceReachable.migrationDescriptor?.carriedAliases?.find(item => item.aliasId === existingAlias);
        const sourceFloor = selectCarriedSourceFloor(sourceReachable, { priorAliasId: existingAlias,
          sourceFloorId: carried.sourceFloorId, sourceMessageIndex: carried.aiIndex });
        if (sourceFloor) sourceCandidates.push({ sourceMessageIndex: carried.aiIndex, targetMessageIndex: targetChat.findIndex(message => message.extra?.[MIGRATION_ALIAS_KEY] === carried.aliasId),
          aliasId: carried.aliasId, rawFingerprint, canonicalFingerprint, sourceFloorId: sourceFloor.id, priorAliasId: inherited?.aliasId ?? null });
      }
      const carriedAliases = selectCompletedCarriedAliases({ reachable: sourceReachable,
        carried: sourceCandidates.filter(item => item.targetMessageIndex >= 0), sourceCandidates: sourceCandidates.map(item => ({
          hostLocator: { messageIndex: item.sourceMessageIndex }, rawFingerprint: item.rawFingerprint, canonicalFingerprint: item.canonicalFingerprint,
          sourceFloorId: item.sourceFloorId, priorAliasId: item.priorAliasId,
        })), newUuid: freshUuid });
      const completeAliasFloors = new Set(carriedAliases.map(alias => alias.floorId));
      const partialSummary = sourceCandidates.find(item => !completeAliasFloors.has(item.sourceFloorId)
        && sourceReachable.floorMemories.some(memory => memory.floorId === item.sourceFloorId && memory.recordStatus === 'active'
          && String(memory.summary?.userText ?? memory.summary?.aiText ?? '').trim()));
      const acceptedAliasIds = new Set(carriedAliases.map(alias => alias.aliasId));
      for (const message of targetChat) {
        const aliasId = message?.extra?.[MIGRATION_ALIAS_KEY];
        if (aliasId && !acceptedAliasIds.has(aliasId)) delete message.extra[MIGRATION_ALIAS_KEY];
      }
      const copiedTime = copyTime
        ? await copyTime({ sourceIdentity: identity, targetIdentity, reachable: sourceReachable })
        : [];
      const timeBatchIds = Array.isArray(copiedTime) ? copiedTime : copiedTime?.batchIds ?? [];
      const sourceTimeHeadSnapshots = !Array.isArray(copiedTime) && copiedTime?.sourceHeadSnapshot
        ? [{ sourceChatId: identity.chatId, head: copiedTime.sourceHeadSnapshot }] : [];
      let vectorShardIds = [];
      if (copyVector) {
        try { vectorShardIds = await copyVector({ sourceIdentity: identity, targetIdentity, targetNarrativeGeneration, sourceReachable }) ?? []; }
        catch { vectorShardIds = []; }
      }
      const peopleWorkspace = copyPeople
        ? await copyPeople({ sourceIdentity: identity, targetIdentity, entities: sourceReachable.entities, sourceReachable })
        : null;
      // Keep the marker already embedded in the copied message; the descriptor is its stable authority.
      const initialized = await initializeMigrationGraph({ store: sourceStoreForIdentity(targetIdentity), sourceIdentity: identity,
        targetIdentity, sourceReachable, carriedAliases, targetChat,
        carriedSummary: partialSummary ? { sourceFloorId: partialSummary.sourceFloorId,
          sourceMemoryId: sourceReachable.floorMemories.find(memory => memory.floorId === partialSummary.sourceFloorId && memory.recordStatus === 'active')?.id,
          targetMessageIndex: partialSummary.targetMessageIndex } : null,
        timeBatchIds, vectorShardIds, peopleWorkspaceId: peopleWorkspace?.workspace ? 'v3-people-workspace' : null,
        peopleSnapshotIds: peopleWorkspace?.snapshotIds ?? [],
        sourcePrequelSnapshots: capturedPrequel === null ? [] : [capturedPrequel],
        sourceCalendarSnapshots: capturedCalendar ? [{ sourceChatId: identity.chatId, calendar: capturedCalendar }] : [],
        sourceTimeHeadSnapshots,
        sanitizerOptions: sanitizerOptions(), now, newUuid: freshUuid });

      const header = { chat_metadata: { qianqianjie: { schemaVersion: 2, chatId: targetChatId },
        ...(capturedPrequel === null ? {} : { qianqianjiePrequel: capturedPrequel }) },
        user_name: capturedUserName, character_name: host.characterName };
      const expected = [header, ...targetChat];
      const saved = await fetchImpl('/api/chats/save', { method: 'POST', cache: 'no-cache', headers: host.requestHeaders ?? {},
        body: JSON.stringify({ ch_name: host.characterName, file_name: targetHostChatId, avatar_url: host.avatarUrl, chat: expected, force: false }) });
      if (!saved?.ok) throw fail('QQJ_MIGRATION_HOST_SAVE_FAILED', '新聊天没有保存成功。');
      const verifyTarget = Object.freeze({ ...target, chatId: targetChatId });
      const persisted = await readTargetChat(verifyTarget, { fetchImpl });
      if (JSON.stringify(persisted.chat) !== JSON.stringify(targetChat)
        || persisted.header.chat_metadata?.qianqianjie?.chatId !== targetChatId
        || (capturedPrequel !== null && persisted.header.chat_metadata?.qianqianjiePrequel !== capturedPrequel)) throw fail('QQJ_MIGRATION_HOST_VERIFY_FAILED', '新聊天读回核验失败，身份绑定未发布。');
      if (capturedCalendar) await persistStoryCalendar(targetChatId, capturedCalendar);
      const createdAt = now()?.toISOString?.() ?? new Date().toISOString();
      const binding = { schemaVersion: 1, kind: 'qqj-chat-identity-binding', chatId: targetChatId,
        owner: { hostChatId: targetHostChatId, characterLocator: identity.characterLocator, personaLocator: identity.personaLocator },
        state: 'ready', sourceChatId: identity.chatId, createdAt, updatedAt: createdAt };
      await client.put(CHAT_IDENTITY_COLLECTION, `binding-${targetChatId}`, binding, 0);
      let opened = false;
      try {
        const current = hostAdapter.snapshot();
        const character = Array.isArray(current.context.characters) ? current.context.characters[current.context.characterId] : current.context.characters?.[current.context.characterId];
        const currentAvatar = String(character?.avatar ?? current.context.characterAvatar ?? '').trim();
        const open = current.context.openCharacterChat;
        if (currentAvatar === host.avatarUrl && typeof open === 'function') { await open.call(current.context, targetHostChatId); opened = true; }
      } catch { /* Opening B is only a presentation step; its saved business target remains valid. */ }
      return Object.freeze({ status: 'completed', chatId: targetChatId, hostChatId: targetHostChatId,
        opened, carriedMessageCount: targetChat.length, frozenFloorCount: initialized.reachable.floors.length, recordCount: initialized.recordCount });
    } finally { if (active === operation) active = null; }
  }
  return Object.freeze({ migrateCurrent, getState: () => Object.freeze({ status: active ? 'migrating' : 'idle', sourceChatId: active?.sourceChatId ?? null }) });
}
