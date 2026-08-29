import { collections, PROBE } from './constants.js';
import { identityIds, isUuid, newIdentityUuid } from './identity.js';
import { ensureChatUuid, getHostContext, readHostState } from './host-context.js';

const stale = () => Object.assign(new Error('运行已失效'), { stale: true });
const bad = (message = '后端记录无效') => Object.assign(new Error(message), { failClosed: true });
export function createDemoController({ client, contextProvider = getHostContext, toast = globalThis.toastr } = {}) {
  let run = 0; let pendingSave = null; let state = { status: 'idle' };
  const notify = (message, level = 'success') => { if (typeof toast?.[level] === 'function') toast[level](message); };
  const mismatch = (ids) => { notify('当前身份与已绑定档案不一致，已只读处理', 'warning'); state = { status: 'mismatch', ...ids }; return state; };
  return { getState: () => ({ ...state }), invalidate: () => { run += 1; }, runDemo: async () => {
    const token = ++run; const ctx = contextProvider(); const inherited = pendingSave; const current = readHostState(ctx);
    const fp = () => { const x = readHostState(contextProvider()); return x.ok ? `${x.hostChatId}|${x.characterAvatar}|${x.personaAvatar}` : 'invalid'; };
    const initial = current.ok ? fp() : ''; const guard = () => { if (token !== run || fp() !== initial) throw stale(); };
    if (!current.ok) { state = { status: 'stopped', reason: current.reason }; return state; }
    try {
      const ids = await identityIds(current); guard(); await client.health(); guard();
      const save = inherited ?? pendingSave;
      if (save) { try { await save; } catch { return { status: 'stopped', reason: '聊天元数据未持久化' }; } current.chatId = ctx.chatMetadata?.qianqianjie?.chatId ?? null; }
      if (!current.chatId && !pendingSave) { const p = ensureChatUuid(ctx, current); pendingSave = p; try { current.chatId = await p; } finally { if (pendingSave === p) pendingSave = null; } }
      guard();
      let old; try { old = await client.get(collections.chats, current.chatId); guard(); } catch (e) { if (e.status !== 404) throw e; old = null; }
      let candidateCard = isUuid(old?.data?.cardId) ? old.data.cardId : newIdentityUuid();
      let candidatePersona = isUuid(old?.data?.personaId) ? old.data.personaId : newIdentityUuid();
      let chat = old;
      if (!chat) { try { guard(); chat = await client.put(collections.chats, current.chatId, { schemaVersion: 1, kind: 'chat-demo-profile', chatId: current.chatId, cardId: candidateCard, personaId: candidatePersona, source: { characterAvatar: current.characterAvatar, personaAvatar: current.personaAvatar }, demoProbe: PROBE }, 0); guard(); } catch (e) { if (e.status !== 409) throw e; chat = await client.get(collections.chats, current.chatId); guard(); const s = chat?.data?.source; if (chat?.data?.chatId !== current.chatId || s?.characterAvatar !== current.characterAvatar || s?.personaAvatar !== current.personaAvatar || !isUuid(chat.data.cardId) || !isUuid(chat.data.personaId)) return mismatch(ids); candidateCard = chat.data.cardId; candidatePersona = chat.data.personaId; } }
      if (old?.data?.cardId === ids.cardRecordId && old?.data?.personaId === ids.personaRecordId) {
        const source = old.data.source;
        if ((source?.characterAvatar && source.characterAvatar !== current.characterAvatar) || (source?.personaAvatar && source.personaAvatar !== current.personaAvatar)) return mismatch(ids);
        try { guard(); chat = await client.put(collections.chats, current.chatId, { ...old.data, cardId: candidateCard, personaId: candidatePersona, source: { characterAvatar: current.characterAvatar, personaAvatar: current.personaAvatar } }, old.revision); guard(); }
        catch (e) { if (e.status !== 409) throw e; chat = await client.get(collections.chats, current.chatId); guard(); const s = chat?.data?.source; if (chat?.data?.chatId !== current.chatId || s?.characterAvatar !== current.characterAvatar || s?.personaAvatar !== current.personaAvatar || !isUuid(chat.data.cardId) || !isUuid(chat.data.personaId)) return mismatch(ids); candidateCard = chat.data.cardId; candidatePersona = chat.data.personaId; }
      }
      const map = async (collection, recordId, kind, locator, existingRef, candidate) => {
        let record; try { record = await client.get(collection, recordId); guard(); } catch (e) { if (e.status !== 404) throw e; if (isUuid(existingRef)) return { record: null, identityId: candidate, needsPut: true }; return { record: null, identityId: candidate, needsPut: true }; }
        const d = record?.data; if (d?.kind !== kind || d.avatar !== locator || (d.identityId !== undefined && !isUuid(d.identityId))) throw bad();
        return { record, identityId: isUuid(d.identityId) ? d.identityId : candidate, needsPut: !isUuid(d.identityId) };
      };
      const putMap = async (m, collection, recordId, kind, locator) => {
        if (!m.needsPut) return m;
        const data = { schemaVersion: 1, kind, avatar: locator, identityId: m.identityId }; let record;
        try { guard(); record = await client.put(collection, recordId, data, m.record?.revision ?? 0); guard(); }
        catch (e) { if (e.status !== 409) throw e; record = await client.get(collection, recordId); guard(); }
        const d = record?.data; if (d?.kind !== kind || d.avatar !== locator || !isUuid(d.identityId)) throw bad();
        return { ...m, record, identityId: d.identityId, needsPut: false };
      };
      const source = chat?.data?.source;
      if (old?.data && ((source?.characterAvatar !== undefined && source.characterAvatar !== current.characterAvatar) || (source?.personaAvatar !== undefined && source.personaAvatar !== current.personaAvatar))) return mismatch(ids);
      if (old?.data && old.data.personaId !== ids.personaRecordId && !isUuid(old.data.personaId)) return mismatch(ids);
      if (old?.data && old.data.cardId !== ids.cardRecordId && !isUuid(old.data.cardId)) return mismatch(ids);
      let card = await map(collections.cards, ids.cardRecordId, 'identity-card', current.characterAvatar, old?.data?.cardId, candidateCard);
      let persona = await map(collections.personas, ids.personaRecordId, 'identity-persona', current.personaAvatar, old?.data?.personaId, candidatePersona);
      if (card.invalid || persona.invalid || (old && ((isUuid(old.data.cardId) && card.identityId !== old.data.cardId) || (isUuid(old.data.personaId) && persona.identityId !== old.data.personaId)))) return mismatch(ids);
      if (old && (!source?.characterAvatar && (isUuid(old.data.cardId) ? card.needsPut : false) || !source?.personaAvatar && (isUuid(old.data.personaId) ? persona.needsPut : false))) return mismatch(ids);
      const mappingMigration = card.needsPut || persona.needsPut;
      card = await putMap(card, collections.cards, ids.cardRecordId, 'identity-card', current.characterAvatar);
      persona = await putMap(persona, collections.personas, ids.personaRecordId, 'identity-persona', current.personaAvatar); guard();
      const desired = { schemaVersion: 1, kind: 'chat-demo-profile', chatId: current.chatId, cardId: card.identityId, personaId: persona.identityId, source: { characterAvatar: current.characterAvatar, personaAvatar: current.personaAvatar }, demoProbe: PROBE };
      const validChat = value => value?.kind === 'chat-demo-profile' && value.chatId === current.chatId && value.source?.characterAvatar === current.characterAvatar && value.source?.personaAvatar === current.personaAvatar && isUuid(value.cardId) && isUuid(value.personaId) && value.cardId === card.identityId && value.personaId === persona.identityId;
      if (!validChat(chat.data)) {
        const legacy = chat.data?.cardId === ids.cardRecordId && chat.data?.personaId === ids.personaRecordId && chat.data?.chatId === current.chatId;
        const rebindable = chat.data?.chatId === current.chatId && isUuid(chat.data?.cardId) && isUuid(chat.data?.personaId);
        if (!legacy && (!rebindable || !source?.characterAvatar || !source?.personaAvatar)) return mismatch(ids);
        try { guard(); chat = await client.put(collections.chats, current.chatId, desired, chat.revision); guard(); }
        catch (e) { if (e.status !== 409) throw e; chat = await client.get(collections.chats, current.chatId); guard(); }
      }
      if (!validChat(chat?.data)) return mismatch(ids);
      const migrated = mappingMigration;
      state = { status: !old ? 'created' : (migrated ? 'migrated' : 'restored'), ...ids, chatId: current.chatId, cardIdentityId: card.identityId, personaIdentityId: persona.identityId };
      notify(migrated ? '身份档案已升级' : '已从后端恢复'); return state;
    } catch (e) { if (e.stale) return { status: 'stale' }; if (e.failClosed) return mismatch({}); throw e; }
  }};
}
