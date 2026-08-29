export function getHostContext() {
  const luker = globalThis.Luker;
  const ctx = luker?.getContext?.();
  if (!ctx || typeof ctx !== 'object') throw new Error('宿主上下文不可用');
  return ctx;
}

export function readHostState(ctx = getHostContext()) {
  const characterId = ctx.characterId;
  if (ctx.groupId || characterId === undefined || characterId === null || characterId === '') return { ok: false, reason: '仅支持单人聊天' };
  const character = Array.isArray(ctx.characters) ? ctx.characters[characterId] : ctx.characters?.[characterId];
  const characterAvatar = String(character?.avatar ?? ctx.characterAvatar ?? '').trim();
  const personaAvatar = String(ctx.userAvatar ?? ctx.personaAvatar ?? globalThis.user_avatar ?? '').trim();
  const chatId = String(ctx.chatId ?? ctx.getCurrentChatId?.() ?? '').trim();
  if (!chatId) return { ok: false, reason: '当前没有聊天' };
  if (!characterAvatar) return { ok: false, reason: '缺少角色身份' };
  if (!personaAvatar) return { ok: false, reason: '缺少 Persona 身份' };
  const metadata = ctx.chatMetadata?.qianqianjie;
  return { ok: true, hostChatId: chatId, chatId: isUuid(metadata?.chatId) && metadata.schemaVersion === 1 ? metadata.chatId : null, characterAvatar, personaAvatar, characterId: String(characterId) };
}

export function isUuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }

export function newUuid() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  throw new Error('宿主缺少 UUID 生成能力');
}

export async function persistChatId(ctx, chatId) {
  const metadata = ctx.chatMetadata ?? {};
  if (metadata.qianqianjie?.chatId === chatId && metadata.qianqianjie.schemaVersion === 1) return false;
  if (typeof ctx.saveMetadata !== 'function' && typeof ctx.saveChatMetadata !== 'function') throw new Error('宿主不支持聊天元数据保存');
  const previous = metadata.qianqianjie;
  metadata.qianqianjie = { schemaVersion: 1, chatId };
  try { await (ctx.saveMetadata ?? ctx.saveChatMetadata)(); }
  catch (error) { if (previous === undefined) delete metadata.qianqianjie; else metadata.qianqianjie = previous; throw error; }
  return true;
}

export async function ensureChatUuid(ctx, state) {
  if (state.chatId) return state.chatId;
  const chatId = newUuid();
  await persistChatId(ctx, chatId);
  return chatId;
}
