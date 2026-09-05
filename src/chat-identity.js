import { isUuid, newUuid, persistChatId } from './host-context.js';
import { deterministicUuid } from './v3/foundation-domain.js';

export const CHAT_IDENTITY_COLLECTION = 'chat-identity-bindings';
const BINDING_PREFIX = 'binding-';

function errorWith(code, message) { return Object.assign(new Error(message), { code }); }
function ownerFrom(host) {
  return Object.freeze({
    hostChatId: String(host.hostChatId ?? ''),
    characterLocator: String(host.characterAvatar ?? ''),
    personaLocator: String(host.personaAvatar ?? ''),
  });
}
function sameOwner(left, right) {
  return left?.hostChatId === right?.hostChatId
    && left?.characterLocator === right?.characterLocator;
}
function bindingRecord({ chatId, owner, state = 'ready', sourceChatId = null, createdAt }) {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'qqj-chat-identity-binding',
    chatId,
    owner: { ...owner },
    state,
    sourceChatId,
    createdAt,
    updatedAt: createdAt,
  });
}
function validateBindingEnvelope(envelope, expectedChatId) {
  const value = envelope?.data;
  if (!Number.isSafeInteger(envelope?.revision) || envelope.revision < 1
    || !value || value.schemaVersion !== 1 || value.kind !== 'qqj-chat-identity-binding'
    || value.chatId !== expectedChatId || !isUuid(value.chatId)
    || !value.owner || typeof value.owner !== 'object'
    || !String(value.owner.hostChatId ?? '') || !String(value.owner.characterLocator ?? '') || !String(value.owner.personaLocator ?? '')
    || !['preparing', 'ready'].includes(value.state)
    || (value.sourceChatId !== null && !isUuid(value.sourceChatId))) {
    throw errorWith('QQJ_CHAT_BINDING_INVALID', '聊天身份认领记录损坏，已停止读写以避免串档。');
  }
  return Object.freeze({ data: value, revision: envelope.revision });
}

export function createChatIdentityCoordinator({
  client,
  persist = persistChatId,
  freshUuid = newUuid,
  now = () => new Date(),
} = {}) {
  if (!client || typeof client.get !== 'function' || typeof client.put !== 'function') throw new TypeError('聊天身份协调器需要 record/CAS client');
  if (typeof persist !== 'function' || typeof freshUuid !== 'function') throw new TypeError('聊天身份协调器参数无效');
  const key = chatId => `${BINDING_PREFIX}${chatId}`;
  const nowIso = () => {
    const value = now()?.toISOString?.() ?? String(now());
    if (!Number.isFinite(Date.parse(value))) throw errorWith('QQJ_CHAT_BINDING_TIME_INVALID', '聊天身份认领时间无效。');
    return value;
  };
  async function read(chatId) {
    try { return validateBindingEnvelope(await client.get(CHAT_IDENTITY_COLLECTION, key(chatId)), chatId); }
    catch (error) { if (error?.status === 404) return null; throw error; }
  }
  async function create(record) {
    try { return validateBindingEnvelope(await client.put(CHAT_IDENTITY_COLLECTION, key(record.chatId), record, 0), record.chatId); }
    catch (error) {
      if (error?.status !== 409) throw error;
      const winner = await read(record.chatId);
      if (!winner) throw errorWith('QQJ_CHAT_BINDING_CONFLICT', '聊天身份认领冲突且无法读取胜出记录。');
      return winner;
    }
  }
  async function legacyRootExists(chatId) {
    try { await client.get(`chat-${chatId}`, 'v3-root'); return true; }
    catch (error) { if (error?.status === 404) return false; throw error; }
  }
  async function claimReady(raw, owner, chatId) {
    const claimed = await create(bindingRecord({ chatId, owner, createdAt: nowIso() }));
    if (!sameOwner(claimed.data.owner, owner) || claimed.data.state !== 'ready') return null;
    await persist(raw, chatId);
    return chatId;
  }
  async function independent(raw, host, carriedChatId) {
    const owner = ownerFrom(host);
    const deterministicChatId = await deterministicUuid(['qqj-chat-independent-v2', carriedChatId, owner.hostChatId, owner.characterLocator]);
    const claimed = await claimReady(raw, owner, deterministicChatId);
    if (claimed) return claimed;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const fallback = freshUuid();
      if (fallback === carriedChatId) continue;
      const fallbackClaim = await claimReady(raw, owner, fallback);
      if (fallbackClaim) return fallbackClaim;
    }
    throw errorWith('QQJ_CHAT_BINDING_CONFLICT', '无法为当前聊天建立独立身份，请刷新后重试。');
  }
  async function prepare(raw, host) {
    const owner = ownerFrom(host);
    if (!isUuid(host.chatId)) {
      const claimed = await claimReady(raw, owner, freshUuid());
      if (claimed) return claimed;
      return independent(raw, host, 'new-chat');
    }
    let claimed = await read(host.chatId);
    if (!claimed) {
      if (await legacyRootExists(host.chatId)) return independent(raw, host, host.chatId);
      const wanted = bindingRecord({ chatId: host.chatId, owner, createdAt: nowIso() });
      claimed = await create(wanted);
    }
    if (sameOwner(claimed.data.owner, owner) && claimed.data.state === 'ready') {
      await persist(raw, claimed.data.chatId);
      return claimed.data.chatId;
    }
    return independent(raw, host, host.chatId);
  }
  return Object.freeze({ prepare, read });
}
