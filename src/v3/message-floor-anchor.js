import { isUuid } from '../identity.js';

export const MESSAGE_FLOOR_ANCHOR_KEY = 'qianqianjie_floor';
export const MESSAGE_FLOOR_ANCHOR_SCHEMA_VERSION = 1;
const RECALL_RECEIPT_KEY = 'qqj_v3_recall_receipt';
const AUTO_HIDE_MARKER_KEY = 'qianqianjieAutoHide';

const chatIdFrom = snapshot => String(snapshot?.context?.chatMetadata?.qianqianjie?.chatId ?? '').trim();
const fail = (code, message) => Object.assign(new Error(message), { code });
const assistantMessage = message => Boolean(message && typeof message === 'object' && message.is_user === false
  && !(message.extra?.type === 'narrator') && !(message.is_system === true && message.extra?.type)
  && (typeof message.mes === 'string' || (Array.isArray(message.swipes) && typeof message.swipes[Number.isSafeInteger(message.swipe_id) ? message.swipe_id : 0] === 'string')));

export function inspectMessageFloorAnchor(message, expectedChatId = '') {
  const value = message?.extra?.[MESSAGE_FLOOR_ANCHOR_KEY];
  if (value === undefined) return Object.freeze({ status: 'none', anchor: null });
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== MESSAGE_FLOOR_ANCHOR_SCHEMA_VERSION
    || !isUuid(value.chatId) || !isUuid(value.floorId)) return Object.freeze({ status: 'invalid', anchor: null });
  const anchor = Object.freeze({ schemaVersion: MESSAGE_FLOOR_ANCHOR_SCHEMA_VERSION, chatId: value.chatId, floorId: value.floorId });
  return Object.freeze({ status: expectedChatId && value.chatId !== expectedChatId ? 'foreign' : 'valid', anchor });
}

export function messageFloorAnchorCandidateSnapshot(value) {
  return JSON.stringify({
    is_user: value?.is_user, is_system: value?.is_system, mes: value?.mes, swipes: value?.swipes,
    swipe_id: value?.swipe_id, send_date: value?.send_date, type: value?.extra?.type,
  });
}

export async function readTargetChat(target, { signal, fetchImpl = globalThis.fetch, allowMissingIdentity = false, allowedChatIds = null } = {}) {
  if (!target?.hostChatId || !target?.characterName || !target?.avatarUrl || !isUuid(target.chatId)) {
    throw fail('V3_MESSAGE_ANCHOR_TARGET_INVALID', '原聊天存档定位信息无效。');
  }
  if (typeof fetchImpl !== 'function') throw fail('V3_MESSAGE_ANCHOR_READ_UNAVAILABLE', '宿主不支持读取指定聊天。');
  const response = await fetchImpl('/api/chats/get', {
    method: 'POST', cache: 'no-cache', headers: target.requestHeaders ?? {},
    body: JSON.stringify({ ch_name: target.characterName, file_name: target.hostChatId, avatar_url: target.avatarUrl }), signal,
  });
  if (!response?.ok) throw Object.assign(fail('V3_MESSAGE_ANCHOR_READ_FAILED', '无法读取原聊天存档。'), { status: response?.status });
  const payload = await response.json();
  if (payload?.new_chat === true) throw Object.assign(fail('V3_MESSAGE_ANCHOR_READ_FAILED', '目标聊天文件尚未创建。'), { missing: true });
  if (payload?.corrupted === true) throw fail('V3_MESSAGE_ANCHOR_READ_FAILED', '目标聊天文件已损坏。');
  const persistedChatId = payload?.[0]?.chat_metadata?.qianqianjie?.chatId;
  const acceptedIds = Array.isArray(allowedChatIds) ? allowedChatIds : [target.chatId];
  if (!Array.isArray(payload) || !payload[0] || !payload[0].chat_metadata
    || (persistedChatId ? !acceptedIds.includes(persistedChatId) : !allowMissingIdentity)) {
    throw fail('V3_MESSAGE_ANCHOR_READ_SCOPE_MISMATCH', '读取到的聊天身份与原目标不一致。');
  }
  return Object.freeze({ header: payload[0], chat: payload.slice(1) });
}

export async function clearExactMessageFloorAnchor({ hostAdapter, targetChat, chatId, floorId, messageIndex, signal, fetchImpl = globalThis.fetch } = {}) {
  if (!hostAdapter || typeof hostAdapter.snapshot !== 'function') throw new TypeError('V3 message anchor HostAdapter 无效');
  if (!isUuid(chatId) || !isUuid(floorId) || !Number.isSafeInteger(messageIndex) || messageIndex < 0) {
    throw fail('V3_MESSAGE_ANCHOR_CLEAR_SCOPE_INVALID', '待清理的消息记忆标识范围无效。');
  }
  if (!targetChat || targetChat.chatId !== chatId || !targetChat.header || typeof targetChat.onPersisted !== 'function') {
    throw fail('V3_MESSAGE_ANCHOR_TARGET_INVALID', '缺少已固定的原聊天保存目标。');
  }
  const before = hostAdapter.snapshot();
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (chatIdFrom(before) !== chatId || !Array.isArray(before.chat)) throw fail('V3_MESSAGE_ANCHOR_TARGET_INVALID', '固定聊天来源与待清理标识不一致。');
  const message = before.chat[messageIndex];
  const exactTarget = extra => {
    const inspected = inspectMessageFloorAnchor({ extra }, chatId);
    return inspected.status === 'valid' && inspected.anchor.floorId === floorId;
  };
  if (!assistantMessage(message) || !exactTarget(message.extra)) throw fail('V3_MESSAGE_ANCHOR_CLEAR_TARGET_CHANGED', '待清理的孤儿标识已经变化。');
  const anchorSnapshot = value => JSON.stringify({
    outer: value?.extra?.[MESSAGE_FLOOR_ANCHOR_KEY] ?? null,
    swipes: Array.isArray(value?.swipe_info) ? value.swipe_info.map(swipe => swipe?.extra?.[MESSAGE_FLOOR_ANCHOR_KEY] ?? null) : [],
  });
  const capturedCandidate = messageFloorAnchorCandidateSnapshot(message);
  const previousOuter = message.extra?.[MESSAGE_FLOOR_ANCHOR_KEY];
  const clearTarget = extra => {
    if (!exactTarget(extra)) return null;
    const next = extra && typeof extra === 'object' && !Array.isArray(extra) ? { ...extra } : {};
    delete next[MESSAGE_FLOOR_ANCHOR_KEY];
    return next;
  };
  const appliedOuter = clearTarget(message.extra);
  message.extra = appliedOuter;
  const changedSwipes = [];
  if (Array.isArray(message.swipe_info)) message.swipe_info = message.swipe_info.map(swipe => {
    const extra = clearTarget(swipe?.extra);
    if (!extra) return swipe;
    const applied = { ...swipe, extra };
    changedSwipes.push({ applied, previousAnchor: swipe?.extra?.[MESSAGE_FLOOR_ANCHOR_KEY] });
    return applied;
  });
  const expectedAnchors = anchorSnapshot(message);
  const restoreAnchor = (extra, previous, present = true) => {
    const next = extra && typeof extra === 'object' && !Array.isArray(extra) ? { ...extra } : {};
    if (present) next[MESSAGE_FLOOR_ANCHOR_KEY] = previous;
    else delete next[MESSAGE_FLOOR_ANCHOR_KEY];
    return next;
  };
  const rollback = () => {
    if (message.extra === appliedOuter && messageFloorAnchorCandidateSnapshot(message) === capturedCandidate) {
      message.extra = restoreAnchor(message.extra, previousOuter);
    }
    if (Array.isArray(message.swipe_info)) for (const changed of changedSwipes) {
      const index = message.swipe_info.indexOf(changed.applied);
      if (index >= 0) message.swipe_info[index] = { ...changed.applied, extra: restoreAnchor(changed.applied.extra, changed.previousAnchor) };
    }
  };
  try {
    if (typeof fetchImpl !== 'function') throw fail('V3_MESSAGE_ANCHOR_SAVE_UNAVAILABLE', '宿主不支持保存指定聊天。');
    const response = await fetchImpl('/api/chats/save', {
      method: 'POST', cache: 'no-cache', headers: targetChat.requestHeaders ?? {},
      body: JSON.stringify({
        ch_name: targetChat.characterName,
        file_name: targetChat.hostChatId,
        avatar_url: targetChat.avatarUrl,
        chat: [targetChat.header, ...before.chat],
        force: false,
      }), signal,
    });
    if (!response?.ok) throw fail([400, 409].includes(response?.status) ? 'V3_MESSAGE_ANCHOR_SAVE_CONFLICT' : 'V3_MESSAGE_ANCHOR_SAVE_FAILED', '原聊天未确认保存孤儿消息标记。');
    let saveResult = null;
    try { saveResult = await response.json(); } catch { /* native hosts may return no JSON body */ }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const persisted = await readTargetChat(targetChat, { signal, fetchImpl });
    const withoutIntegrity = header => {
      const value = structuredClone(header);
      if (value?.chat_metadata && typeof value.chat_metadata === 'object') delete value.chat_metadata.integrity;
      return value;
    };
    const previousIntegrity = targetChat.header?.chat_metadata?.integrity;
    const nextIntegrity = persisted.header?.chat_metadata?.integrity;
    const hasReturnedIntegrity = Boolean(saveResult && typeof saveResult === 'object'
      && (Object.hasOwn(saveResult, 'integrity') || Object.hasOwn(saveResult, 'chat_metadata')
        && saveResult.chat_metadata && Object.hasOwn(saveResult.chat_metadata, 'integrity')));
    const returnedIntegrity = Object.hasOwn(saveResult ?? {}, 'integrity') ? saveResult.integrity : saveResult?.chat_metadata?.integrity;
    const integrityValid = !hasReturnedIntegrity
      ? nextIntegrity === previousIntegrity
      : typeof returnedIntegrity === 'string' && returnedIntegrity.length > 0 && nextIntegrity === returnedIntegrity;
    if (!integrityValid || JSON.stringify(withoutIntegrity(persisted.header)) !== JSON.stringify(withoutIntegrity(targetChat.header)) || persisted.chat.length !== before.chat.length
      || JSON.stringify(persisted.chat) !== JSON.stringify(before.chat)
      || messageFloorAnchorCandidateSnapshot(persisted.chat[messageIndex]) !== capturedCandidate || anchorSnapshot(persisted.chat[messageIndex]) !== expectedAnchors) {
      throw fail('V3_MESSAGE_ANCHOR_VERIFY_FAILED', '孤儿消息记忆标识没有完成持久化，可安全重试。');
    }
    targetChat.onPersisted(persisted, { messageIndex, floorId, candidateFingerprint: capturedCandidate });
    return Object.freeze({ status: 'persisted', persisted: 1 });
  } catch (error) {
    rollback();
    throw error;
  }
}

export async function persistMessageFloorAnchors({ hostAdapter, chatId, bindings, signal, fetchImpl = globalThis.fetch } = {}) {
  if (!hostAdapter || typeof hostAdapter.snapshot !== 'function') throw new TypeError('V3 message anchor HostAdapter 无效');
  if (!isUuid(chatId)) throw fail('V3_MESSAGE_ANCHOR_CHAT_INVALID', '消息记忆标识缺少有效聊天身份。');
  if (!Array.isArray(bindings)) throw new TypeError('V3 message anchor bindings 无效');
  const before = hostAdapter.snapshot();
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (chatIdFrom(before) !== chatId || !Array.isArray(before.chat)) throw fail('V3_MESSAGE_ANCHOR_CHAT_CHANGED', '聊天已切换，未写入旧聊天的记忆标识。');
  const prepared = [];
  const seenMessages = new Set(), seenFloors = new Set();
  for (const binding of bindings) {
    const messageIndex = binding?.messageIndex, floorId = binding?.floorId;
    if (!Number.isSafeInteger(messageIndex) || messageIndex < 0 || !isUuid(floorId) || seenMessages.has(messageIndex) || seenFloors.has(floorId)) {
      throw fail('V3_MESSAGE_ANCHOR_BINDING_INVALID', '消息与记忆楼的绑定关系不唯一。');
    }
    const message = before.chat[messageIndex];
    if (!assistantMessage(message)) throw fail('V3_MESSAGE_ANCHOR_TARGET_MISSING', '待挂载的 AI 消息已经不存在。');
    const inspected = inspectMessageFloorAnchor(message, chatId);
    if (inspected.status === 'foreign' || inspected.status === 'invalid'
      || (inspected.status === 'valid' && inspected.anchor.floorId !== floorId)) {
      throw fail('V3_MESSAGE_ANCHOR_CONFLICT', '消息已有不属于当前记忆楼的标识，未静默覆盖。');
    }
    seenMessages.add(messageIndex); seenFloors.add(floorId);
    if (inspected.status !== 'valid') prepared.push({ message, messageIndex, floorId, previousAnchor: message?.extra?.[MESSAGE_FLOOR_ANCHOR_KEY] });
  }
  if (!prepared.length) return Object.freeze({ status: 'unchanged', persisted: 0 });
  const context = before.context;
  if (typeof context?.saveChat !== 'function') throw fail('V3_MESSAGE_ANCHOR_SAVE_UNAVAILABLE', '宿主不支持保存消息记忆标识。');
  const rollback = () => {
    for (const item of prepared) {
      const current = inspectMessageFloorAnchor(item.message, chatId);
      if (current.status !== 'valid' || current.anchor.floorId !== item.floorId) continue;
      const concurrent = item.message.extra && typeof item.message.extra === 'object' && !Array.isArray(item.message.extra) ? { ...item.message.extra } : {};
      if (item.previousAnchor === undefined) delete concurrent[MESSAGE_FLOOR_ANCHOR_KEY];
      else concurrent[MESSAGE_FLOOR_ANCHOR_KEY] = item.previousAnchor;
      item.message.extra = concurrent;
    }
  };
  for (const item of prepared) {
    const extra = item.message.extra && typeof item.message.extra === 'object' && !Array.isArray(item.message.extra) ? item.message.extra : {};
    item.message.extra = { ...extra, [MESSAGE_FLOOR_ANCHOR_KEY]: { schemaVersion: MESSAGE_FLOOR_ANCHOR_SCHEMA_VERSION, chatId, floorId: item.floorId } };
  }
  try {
    const saved = await context.saveChat();
    if (saved === false) throw fail('V3_MESSAGE_ANCHOR_SAVE_FAILED', '宿主未确认消息记忆标识已保存。');
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const after = hostAdapter.snapshot();
    if (chatIdFrom(after) !== chatId || after.chat !== before.chat
      || prepared.some(item => after.chat[item.messageIndex] !== item.message
        || inspectMessageFloorAnchor(item.message, chatId).anchor?.floorId !== item.floorId)) {
      throw fail('V3_MESSAGE_ANCHOR_CHAT_CHANGED', '保存消息记忆标识时聊天发生变化。');
    }
    if (typeof fetchImpl !== 'function') throw fail('V3_MESSAGE_ANCHOR_VERIFY_UNAVAILABLE', '宿主不支持读回消息记忆标识。');
    const character = Array.isArray(context.characters) ? context.characters[context.characterId] : context.characters?.[context.characterId];
    const response = await fetchImpl('/api/chats/get', { method: 'POST', cache: 'no-cache', headers: context.getRequestHeaders?.() ?? {}, body: JSON.stringify({ ch_name: String(character?.name ?? context.name2 ?? ''), file_name: before.chatId, avatar_url: String(character?.avatar ?? before.characterAvatar ?? '') }) });
    if (!response?.ok) throw fail('V3_MESSAGE_ANCHOR_VERIFY_FAILED', '宿主保存后无法读回消息记忆标识。');
    const payload = await response.json();
    const persisted = Array.isArray(payload) ? payload.slice(1) : null;
    if (!persisted || prepared.some(item => inspectMessageFloorAnchor(persisted[item.messageIndex], chatId).anchor?.floorId !== item.floorId)) {
      throw fail('V3_MESSAGE_ANCHOR_VERIFY_FAILED', '消息记忆标识没有完成持久化，可安全重试。');
    }
    return Object.freeze({ status: 'persisted', persisted: prepared.length });
  } catch (error) {
    rollback();
    throw error;
  }
}

export async function persistBranchedMessageMetadata({
  target,
  chat,
  initialSnapshot,
  sourceChatId,
  targetChatId,
  bindings = [],
  retainedFloorIds = [],
  signal,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!target?.hostChatId || !target?.characterName || !target?.avatarUrl || !Array.isArray(chat)) throw new TypeError('V3 branch target is invalid');
  if (!isUuid(sourceChatId) || !isUuid(targetChatId) || sourceChatId === targetChatId) throw fail('V3_BRANCH_MESSAGE_CHAT_INVALID', '分支消息缺少有效的新旧聊天身份。');
  if (!Array.isArray(bindings) || !Array.isArray(retainedFloorIds)) throw new TypeError('V3 branch message bindings 无效');
  const allowedFloors = new Set(retainedFloorIds);
  if ([...allowedFloors].some(floorId => !isUuid(floorId))) throw fail('V3_BRANCH_MESSAGE_BINDING_INVALID', '分支消息包含无效记忆楼。');
  const forcedByMessage = new Map();
  for (const binding of bindings) {
    if (!Number.isSafeInteger(binding?.messageIndex) || binding.messageIndex < 0 || !allowedFloors.has(binding?.floorId)
      || forcedByMessage.has(binding.messageIndex)) throw fail('V3_BRANCH_MESSAGE_BINDING_INVALID', '分支消息与记忆楼的绑定关系无效。');
    forcedByMessage.set(binding.messageIndex, binding.floorId);
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const allowedChatIds = [sourceChatId, targetChatId];
  const before = initialSnapshot ?? await readTargetChat(target, { signal, fetchImpl, allowedChatIds });
  if (!allowedChatIds.includes(before.header?.chat_metadata?.qianqianjie?.chatId)) {
    throw fail('V3_BRANCH_MESSAGE_CHAT_CHANGED', '分支目标聊天身份已被修改。');
  }
  const targetChat = structuredClone(chat);

  // Branch copies invalidate recall receipts and rehome only retained floor anchors and this plugin's hide markers.
  const rewriteExtra = (extra, forcedFloorId = null) => {
    const object = extra && typeof extra === 'object' && !Array.isArray(extra);
    const hasReceipt = object && Object.hasOwn(extra, RECALL_RECEIPT_KEY);
    const hasAnchor = object && Object.hasOwn(extra, MESSAGE_FLOOR_ANCHOR_KEY);
    const rebindAutoHide = object && extra[AUTO_HIDE_MARKER_KEY]?.schemaVersion === 1 && extra[AUTO_HIDE_MARKER_KEY].chatId === sourceChatId;
    if (!forcedFloorId && !hasReceipt && !hasAnchor && !rebindAutoHide) return null;
    const next = object ? { ...extra } : {};
    delete next[RECALL_RECEIPT_KEY];
    if (rebindAutoHide) next[AUTO_HIDE_MARKER_KEY] = { schemaVersion: 1, chatId: targetChatId };
    if (forcedFloorId) {
      next[MESSAGE_FLOOR_ANCHOR_KEY] = { schemaVersion: MESSAGE_FLOOR_ANCHOR_SCHEMA_VERSION, chatId: targetChatId, floorId: forcedFloorId };
    } else if (hasAnchor) {
      const inspected = inspectMessageFloorAnchor({ extra }, '');
      if (inspected.status === 'valid' && [sourceChatId, targetChatId].includes(inspected.anchor.chatId) && allowedFloors.has(inspected.anchor.floorId)) {
        next[MESSAGE_FLOOR_ANCHOR_KEY] = { ...inspected.anchor, chatId: targetChatId };
      } else {
        delete next[MESSAGE_FLOOR_ANCHOR_KEY];
      }
    }
    return next;
  };
  const changed = [];
  for (const [messageIndex, message] of targetChat.entries()) {
    if (!message || typeof message !== 'object') continue;
    const nextExtra = rewriteExtra(message.extra, forcedByMessage.get(messageIndex) ?? null);
    let swipeChanged = false;
    const nextSwipeInfo = Array.isArray(message.swipe_info) ? message.swipe_info.map(swipe => {
      const next = rewriteExtra(swipe?.extra);
      if (!next) return swipe;
      swipeChanged = true;
      return { ...swipe, extra: next };
    }) : message.swipe_info;
    if (!nextExtra && !swipeChanged) continue;
    const effectiveExtra = nextExtra ?? message.extra;
    const extrasEqual = JSON.stringify(effectiveExtra) === JSON.stringify(message.extra);
    const swipesEqual = JSON.stringify(nextSwipeInfo) === JSON.stringify(message.swipe_info);
    if (extrasEqual && swipesEqual) continue;
    changed.push({ message, extra: message.extra, swipeInfo: message.swipe_info });
    if (nextExtra) message.extra = nextExtra;
    if (swipeChanged) message.swipe_info = nextSwipeInfo;
  }
  const header = structuredClone(before.header);
  header.chat_metadata.qianqianjie = {
    ...(header.chat_metadata.qianqianjie && typeof header.chat_metadata.qianqianjie === 'object' ? header.chat_metadata.qianqianjie : {}),
    schemaVersion: 2,
    chatId: targetChatId,
  };
  if (!changed.length && before.header.chat_metadata?.qianqianjie?.chatId === targetChatId) {
    if (JSON.stringify(before.header) !== JSON.stringify(header) || JSON.stringify(before.chat) !== JSON.stringify(targetChat)) {
      throw fail('V3_BRANCH_MESSAGE_VERIFY_FAILED', '固定分支目标的消息标识与捕获状态不一致。');
    }
    return Object.freeze({ status: 'unchanged', persisted: 0, header: before.header, chat: before.chat });
  }
  if (typeof fetchImpl !== 'function') throw fail('V3_BRANCH_MESSAGE_SAVE_UNAVAILABLE', '宿主不支持保存分支消息标识。');
  const latest = await readTargetChat(target, { signal, fetchImpl, allowedChatIds });
  if (JSON.stringify(latest.header) !== JSON.stringify(before.header) || JSON.stringify(latest.chat) !== JSON.stringify(before.chat)) {
    throw fail('V3_BRANCH_MESSAGE_SAVE_CONFLICT', '分支目标聊天在初始化期间被修改。');
  }
  const response = await fetchImpl('/api/chats/save', {
    method: 'POST', cache: 'no-cache', headers: target.requestHeaders ?? {},
    body: JSON.stringify({ ch_name: target.characterName, file_name: target.hostChatId, avatar_url: target.avatarUrl, chat: [header, ...targetChat], force: false }),
    signal,
  });
  if (!response?.ok) throw fail([400, 409].includes(response?.status) ? 'V3_BRANCH_MESSAGE_SAVE_CONFLICT' : 'V3_BRANCH_MESSAGE_SAVE_FAILED', '分支消息标识未能保存到固定目标。');
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const persisted = await readTargetChat(target, { signal, fetchImpl });
  const withoutIntegrity = value => {
    const next = structuredClone(value);
    if (next?.chat_metadata && typeof next.chat_metadata === 'object') delete next.chat_metadata.integrity;
    return next;
  };
  if (JSON.stringify(withoutIntegrity(persisted.header)) !== JSON.stringify(withoutIntegrity(header))
    || JSON.stringify(persisted.chat) !== JSON.stringify(targetChat)) {
    throw fail('V3_BRANCH_MESSAGE_VERIFY_FAILED', '固定分支目标保存后读回不一致，可重试。');
  }
  return Object.freeze({ status: 'persisted', persisted: changed.length, header: persisted.header, chat: persisted.chat });
}

export async function persistTargetChatIdentity({ coordinates, raw, snapshot, chatId, listHostChats = null, signal, fetchImpl = globalThis.fetch } = {}) {
  if (!coordinates?.hostChatId || !coordinates?.characterName || !coordinates?.avatarUrl || !isUuid(chatId)
    || !Array.isArray(snapshot?.chat) || !snapshot.chatMetadata || typeof snapshot.chatMetadata !== 'object') {
    throw fail('V3_MESSAGE_ANCHOR_TARGET_INVALID', '固定聊天身份保存输入无效。');
  }
  if (snapshot.chatMetadata.qianqianjie?.chatId === chatId && snapshot.chatMetadata.qianqianjie?.schemaVersion === 2) {
    return Object.freeze({ persistedIdentity: chatId, header: null, chat: null, status: 'unchanged' });
  }
  const target = { ...coordinates, chatId };
  const capturedQqjId = snapshot.chatMetadata.qianqianjie?.chatId ?? null;
  let before;
  let create = false;
  try {
    before = await readTargetChat(target, { signal, fetchImpl, allowMissingIdentity: true,
      allowedChatIds: [capturedQqjId, chatId].filter(Boolean) });
  } catch (error) {
    if (!(error?.missing === true || error?.status === 404)) throw error;
    if (capturedQqjId) throw fail('QQJ_TARGET_CHAT_DELETED', '待保存身份的聊天文件已不存在，未重建已删除聊天。');
    if (typeof listHostChats === 'function') {
      const names = await listHostChats(coordinates.characterLocator, { signal });
      if (names.includes(coordinates.hostChatId)) throw fail('QQJ_TARGET_CHAT_DELETED', '待保存身份的聊天文件已不存在，未重建已删除聊天。');
    }
    create = true;
    before = { header: { chat_metadata: structuredClone(snapshot.chatMetadata) }, chat: structuredClone(snapshot.chat) };
  }
  const withoutIntegrity = value => {
    const next = structuredClone(value);
    if (next?.chat_metadata && typeof next.chat_metadata === 'object') delete next.chat_metadata.integrity;
    return next;
  };
  const capturedMetadata = structuredClone(snapshot.chatMetadata);
  const persistedMetadata = structuredClone(before.header.chat_metadata ?? {});
  delete capturedMetadata.integrity;
  delete persistedMetadata.integrity;
  if (JSON.stringify(snapshot.chat) !== JSON.stringify(before.chat)
    || JSON.stringify(capturedMetadata) !== JSON.stringify(persistedMetadata)) {
    throw fail('V3_TARGET_CHAT_CHANGED', '固定聊天在身份准备期间被修改，未覆盖已保存内容。');
  }
  const header = structuredClone(before.header);
  header.chat_metadata ??= {};
  if (header.chat_metadata.qianqianjie?.chatId === chatId && header.chat_metadata.qianqianjie?.schemaVersion === 2) {
    return Object.freeze({ persistedIdentity: chatId, header: before.header, chat: before.chat, status: 'unchanged' });
  }
  header.chat_metadata.qianqianjie = {
    ...(header.chat_metadata.qianqianjie && typeof header.chat_metadata.qianqianjie === 'object' ? header.chat_metadata.qianqianjie : {}),
    schemaVersion: 2, chatId,
  };
  if (!create) {
    const latest = await readTargetChat(target, { signal, fetchImpl, allowMissingIdentity: true,
      allowedChatIds: [capturedQqjId, chatId].filter(Boolean) });
    if (JSON.stringify(latest.header) !== JSON.stringify(before.header) || JSON.stringify(latest.chat) !== JSON.stringify(before.chat)) {
      throw fail('V3_TARGET_CHAT_CHANGED', '固定聊天在身份保存期间被修改，未覆盖已保存内容。');
    }
  }
  const response = await fetchImpl('/api/chats/save', {
    method: 'POST', cache: 'no-cache', headers: target.requestHeaders ?? {},
    body: JSON.stringify({ ch_name: target.characterName, file_name: target.hostChatId, avatar_url: target.avatarUrl,
      chat: [header, ...before.chat], force: false }), signal,
  });
  if (!response?.ok) throw fail([400, 409].includes(response?.status) ? 'V3_TARGET_CHAT_CHANGED' : 'V3_TARGET_CHAT_SAVE_FAILED', '固定聊天身份未能保存。');
  const persisted = await readTargetChat(target, { signal, fetchImpl });
  if (JSON.stringify(withoutIntegrity(persisted.header)) !== JSON.stringify(withoutIntegrity(header))
    || JSON.stringify(persisted.chat) !== JSON.stringify(before.chat)) {
    throw fail('V3_TARGET_CHAT_VERIFY_FAILED', '固定聊天身份保存后读回不一致。');
  }
  if (raw?.chatId === coordinates.hostChatId && raw?.chatMetadata
    && JSON.stringify(withoutIntegrity({ chat_metadata: raw.chatMetadata })) === JSON.stringify(withoutIntegrity({ chat_metadata: snapshot.chatMetadata }))) {
    raw.chatMetadata.qianqianjie = { ...(raw.chatMetadata.qianqianjie ?? {}), schemaVersion: 2, chatId };
    if (Object.hasOwn(persisted.header.chat_metadata, 'integrity')) raw.chatMetadata.integrity = persisted.header.chat_metadata.integrity;
    else delete raw.chatMetadata.integrity;
  }
  return Object.freeze({ persistedIdentity: chatId, header: persisted.header, chat: persisted.chat, status: 'persisted' });
}
