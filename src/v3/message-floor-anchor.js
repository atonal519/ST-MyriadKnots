import { isUuid } from '../identity.js';

export const MESSAGE_FLOOR_ANCHOR_KEY = 'qianqianjie_floor';
export const MESSAGE_FLOOR_ANCHOR_SCHEMA_VERSION = 1;

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
