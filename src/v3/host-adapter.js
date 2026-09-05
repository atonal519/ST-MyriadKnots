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

function userIdentityFrom(context, source) {
  const displayName = text(context?.name1 ?? context?.userName ?? context?.username ?? context?.persona?.name);
  const personaIdentifier = text(
    context?.personaId
      ?? context?.persona?.id
      ?? context?.userAvatar
      ?? context?.personaAvatar
      ?? context?.user_avatar,
  );
  const aliases = [...new Set([displayName, '你', '{{user}}'].filter(Boolean))];
  return Object.freeze({
    displayName,
    aliases: Object.freeze(aliases),
    personaIdentifier,
    source,
  });
}

export function createHostAdapter({ globalRef = globalThis, mutationMetadataCapability = false } = {}) {
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
    return Object.freeze({
      context,
      chat: Array.isArray(context.chat) ? context.chat : [],
      chatId: String(context.chatId ?? context.getCurrentChatId?.() ?? '').trim(),
      eventSource: context.eventSource ?? null,
      eventTypes: context.eventTypes ?? {},
      mode: metadataCapability ? 'enhanced' : 'standard',
      source: standard ? 'SillyTavern' : 'Luker',
      userIdentity: userIdentityFrom(context, standard ? 'SillyTavern' : 'Luker'),
      capabilities: Object.freeze({ mutationMetadata: metadataCapability }),
    });
  }

  function getUserIdentity() {
    const standard = standardContext();
    const context = standard ?? fallbackContext();
    if (!context) throw new Error('宿主上下文不可用');
    return userIdentityFrom(context, standard ? 'SillyTavern' : 'Luker');
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

  return Object.freeze({ getContext, getUserIdentity, snapshot, mutationMetadata });
}

export function getPreferredHostContext(globalRef = globalThis) {
  return createHostAdapter({ globalRef }).getContext();
}
