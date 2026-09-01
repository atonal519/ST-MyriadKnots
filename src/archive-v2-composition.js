import { createArchiveV2Adapter } from './archive-v2.js';
import { isUuid, readHostState } from './host-context.js';

export class ArchiveV2CompositionError extends Error {
  constructor(message, code = 'ARCHIVE_V2_COMPOSITION_CONTEXT_INVALID') {
    super(message);
    this.name = 'ArchiveV2CompositionError';
    this.code = code;
  }
}

function contextError() {
  return new ArchiveV2CompositionError('当前聊天缺少可用的千千结稳定身份');
}

export function createArchiveV2Composition({
  client,
  contextProvider,
  isEnabled = true,
} = {}) {
  if (typeof client?.get !== 'function' || typeof client?.put !== 'function') {
    throw new TypeError('client 必须提供 get 和 put');
  }
  if (typeof contextProvider !== 'function') throw new TypeError('contextProvider 必须是函数');
  if (typeof isEnabled !== 'boolean' && typeof isEnabled !== 'function') {
    throw new TypeError('isEnabled 必须是布尔值或函数');
  }

  function normalizedContext() {
    let raw;
    let state;
    try {
      raw = contextProvider();
      state = readHostState(raw);
    } catch {
      throw contextError();
    }
    if (state?.ok !== true || !isUuid(state.chatId)) throw contextError();
    const identity = {
      hostChatId: state.hostChatId,
      chatId: state.chatId,
      characterLocator: state.characterAvatar,
      personaLocator: state.personaAvatar,
    };
    return { raw, identity };
  }

  const identityContextProvider = () => ({ ...normalizedContext().identity });
  const archiveAdapter = createArchiveV2Adapter({ client, contextProvider: identityContextProvider, isEnabled });

  function currentIdentity({ personaSummary = '' } = {}) {
    if (typeof personaSummary !== 'string') throw new TypeError('personaSummary 必须是字符串');
    const identity = identityContextProvider();
    return {
      characterLocator: identity.characterLocator,
      personaLocator: identity.personaLocator,
      personaSummary,
    };
  }

  function invalidate() {
    archiveAdapter.invalidate();
  }

  return Object.freeze({
    readArchive: () => archiveAdapter.read(),
    currentIdentity,
    invalidate,
  });
}
