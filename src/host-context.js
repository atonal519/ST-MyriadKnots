export function getHostContext() {
  const ctx = globalThis.SillyTavern?.getContext?.() ?? globalThis.Luker?.getContext?.();
  if (!ctx || typeof ctx !== 'object') throw new Error('宿主上下文不可用');
  return ctx;
}

export function readHostState(ctx = getHostContext()) {
  const characterId = ctx.characterId;
  if (ctx.groupId) return { ok: false, reason: '仅支持单人聊天' };
  const chatId = String(ctx.chatId ?? ctx.getCurrentChatId?.() ?? '').trim();
  if (!chatId) return { ok: false, noChat: true, reason: '当前没有聊天' };
  if (characterId === undefined || characterId === null || characterId === '') return { ok: false, reason: '仅支持单人聊天' };
  const character = Array.isArray(ctx.characters) ? ctx.characters[characterId] : ctx.characters?.[characterId];
  const characterAvatar = String(character?.avatar ?? ctx.characterAvatar ?? '').trim();
  const personaAvatar = String(ctx.userAvatar ?? ctx.personaAvatar ?? globalThis.user_avatar ?? '').trim();
  if (!characterAvatar) return { ok: false, reason: '缺少角色身份' };
  if (!personaAvatar) return { ok: false, reason: '缺少 Persona 身份' };
  const metadata = ctx.chatMetadata?.qianqianjie;
  return { ok: true, hostChatId: chatId, chatId: isUuid(metadata?.chatId) && [1, 2].includes(metadata.schemaVersion) ? metadata.chatId : null, characterAvatar, personaAvatar, characterId: String(characterId) };
}

export function isUuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }

export function newUuid() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  throw new Error('宿主缺少 UUID 生成能力');
}

export function createHostChatList({ fetchImpl = globalThis.fetch, headers = () => ({}) } = {}) {
  return async function listHostChats(characterAvatar, { signal } = {}) {
    const avatar = String(characterAvatar ?? '').trim();
    let response;
    try {
      response = await fetchImpl('/api/characters/chats', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ avatar_url: avatar, simple: true }),
        signal,
      });
    } catch (cause) {
      throw Object.assign(new Error('读取宿主聊天列表失败，未变更千千结身份。', { cause }), { code: 'QQJ_HOST_CHAT_LIST_FAILED' });
    }
    if (!response.ok) {
      throw Object.assign(new Error(`读取宿主聊天列表失败（HTTP ${response.status}），未变更千千结身份。`), {
        code: 'QQJ_HOST_CHAT_LIST_FAILED', status: response.status,
      });
    }
    let data;
    try { data = await response.json(); }
    catch (cause) {
      throw Object.assign(new Error('宿主聊天列表响应无效，未变更千千结身份。', { cause }), { code: 'QQJ_HOST_CHAT_LIST_INVALID' });
    }
    if (!Array.isArray(data)) {
      throw Object.assign(new Error('宿主聊天列表响应无效，未变更千千结身份。'), { code: 'QQJ_HOST_CHAT_LIST_INVALID' });
    }
    const names = [];
    for (const item of data) {
      const fileId = typeof item?.file_id === 'string' ? item.file_id.trim() : '';
      const fileName = typeof item?.file_name === 'string' ? item.file_name.trim() : '';
      if (!fileId && !fileName) {
        throw Object.assign(new Error('宿主聊天列表响应无效，未变更千千结身份。'), { code: 'QQJ_HOST_CHAT_LIST_INVALID' });
      }
      names.push(fileId || fileName.replace(/\.jsonl$/i, ''));
    }
    return names;
  };
}

export async function persistChatId(ctx, chatId) {
  const metadata = ctx.chatMetadata ?? {};
  if (metadata.qianqianjie?.chatId === chatId && metadata.qianqianjie.schemaVersion === 2) return false;
  if (typeof ctx.saveMetadata !== 'function' && typeof ctx.saveChatMetadata !== 'function') throw new Error('宿主不支持聊天元数据保存');
  const previous = metadata.qianqianjie;
  metadata.qianqianjie = { schemaVersion: 2, chatId };
  try {
    if (typeof ctx.saveChatMetadata === 'function') {
      const saved = await ctx.saveChatMetadata();
      if (saved !== true) throw new Error('聊天元数据未能持久化');
    } else {
      await ctx.saveMetadata();
    }
  }
  catch (error) { if (previous === undefined) delete metadata.qianqianjie; else metadata.qianqianjie = previous; throw error; }
  return true;
}

export async function ensureChatUuid(ctx, state) {
  if (state.chatId) return state.chatId;
  const chatId = newUuid();
  await persistChatId(ctx, chatId);
  return chatId;
}
