const MUTATION_HINT_KEYS = Object.freeze([
  'messageId', 'messageIndex', 'previous', 'next', 'range', 'mutation', 'mutationType',
]);

function contextFrom(root) {
  const value = root?.getContext?.();
  return value && typeof value === 'object' ? value : null;
}

function text(value, maximum = 500) {
  const result = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return result.slice(0, maximum);
}

function userIdentityFrom(context, source, personaIdentifierProvider) {
  const displayName = text(context?.name1 ?? context?.userName ?? context?.username ?? context?.persona?.name);
  const personaIdentifier = text(
    context?.personaId
      ?? context?.persona?.id
      ?? context?.userAvatar
      ?? context?.personaAvatar
      ?? context?.user_avatar,
  ) || text(personaIdentifierProvider?.());
  const aliases = [...new Set([displayName, '你', '{{user}}'].filter(Boolean))];
  return Object.freeze({
    displayName,
    aliases: Object.freeze(aliases),
    personaIdentifier,
    source,
  });
}

export function createHostAdapter({ globalRef = globalThis, mutationMetadataCapability = false, worldInfoBindings = {}, personaIdentifierProvider = null } = {}) {
  const standardContext = () => contextFrom(globalRef?.SillyTavern);
  const fallbackContext = () => contextFrom(globalRef?.Luker);
  let observedMutationMetadata = mutationMetadataCapability === true;

  function getContext() {
    const context = standardContext() ?? fallbackContext();
    if (!context) throw new Error('宿主上下文不可用');
    return context;
  }

  function snapshot() {
    const standard = standardContext();
    const fallback = standard ? null : fallbackContext();
    const context = standard ?? fallback;
    if (!context) throw new Error('宿主上下文不可用');
    const metadataCapability = observedMutationMetadata || [
      context.getMessageMutationMetadata,
      context.getMutationMetadata,
      context.messageMutationMetadata,
    ].some(value => typeof value === 'function' || (value && typeof value === 'object'));
    const integrity = context.chatMetadata?.integrity;
    const chatComplete = integrity === undefined ? null : Boolean(integrity);
    return Object.freeze({
      context,
      chat: Array.isArray(context.chat) ? context.chat : [],
      chatId: String(context.chatId ?? context.getCurrentChatId?.() ?? '').trim(),
      eventSource: context.eventSource ?? null,
      eventTypes: context.eventTypes ?? {},
      mode: metadataCapability ? 'enhanced' : 'standard',
      source: standard ? 'SillyTavern' : 'Luker',
      userIdentity: userIdentityFrom(context, standard ? 'SillyTavern' : 'Luker', personaIdentifierProvider),
      capabilities: Object.freeze({ mutationMetadata: metadataCapability, chatComplete }),
    });
  }

  function getUserIdentity() {
    const standard = standardContext();
    const context = standard ?? fallbackContext();
    if (!context) throw new Error('宿主上下文不可用');
    return userIdentityFrom(context, standard ? 'SillyTavern' : 'Luker', personaIdentifierProvider);
  }

  function mutationMetadata(args = []) {
    for (let index = args.length - 1; index >= 0; index -= 1) {
      const candidate = args[index];
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      if (MUTATION_HINT_KEYS.some(key => Object.hasOwn(candidate, key))) {
        observedMutationMetadata = true;
        return candidate;
      }
    }
    return null;
  }

  function getWorldInfoBindings() { return worldInfoBindings && typeof worldInfoBindings === 'object' ? worldInfoBindings : {}; }

  return Object.freeze({ getContext, getUserIdentity, getWorldInfoBindings, snapshot, mutationMetadata });
}

export function getPreferredHostContext(globalRef = globalThis) {
  return createHostAdapter({ globalRef }).getContext();
}

export function captureTargetChatDescriptor(snapshot, identity) {
  const context = snapshot?.context;
  if (!context || !identity?.hostChatId || !identity?.chatId) throw new TypeError('V3 target chat identity 无效');
  if (context.groupId !== null && context.groupId !== undefined) throw Object.assign(new Error('暂不支持群聊标记修复。'), { code: 'V3_MESSAGE_ANCHOR_TARGET_UNSUPPORTED' });
  const character = Array.isArray(context.characters) ? context.characters[context.characterId] : context.characters?.[context.characterId];
  const characterName = String(character?.name ?? context.name2 ?? '').trim();
  const avatarUrl = String(character?.avatar ?? context.characterAvatar ?? '').trim();
  if (!characterName || !avatarUrl) throw Object.assign(new Error('原聊天存档定位信息不可用。'), { code: 'V3_MESSAGE_ANCHOR_TARGET_INVALID' });
  const requestHeaders = typeof context.getRequestHeaders === 'function' ? context.getRequestHeaders() : {};
  return Object.freeze({
    chatId: identity.chatId,
    hostChatId: identity.hostChatId,
    characterName,
    avatarUrl,
    requestHeaders,
    source: snapshot.source,
  });
}
