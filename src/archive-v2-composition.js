import { createArchiveV2Adapter } from './archive-v2.js';
import { createArchiveV2CandidateRecognizer } from './archive-v2-recognition.js';
import { createArchiveV2ProfileGenerator } from './archive-v2-profile-generation.js';
import { createArchiveV2InitializationCommitter } from './archive-v2-initialization-commit.js';
import { createArchiveV2InitializationFlow } from './archive-v2-initialization-flow.js';
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
  generateTask,
  isEnabled = true,
  collectSources,
  now,
  createId,
} = {}) {
  if (typeof client?.get !== 'function' || typeof client?.put !== 'function') {
    throw new TypeError('client 必须提供 get 和 put');
  }
  if (typeof contextProvider !== 'function') throw new TypeError('contextProvider 必须是函数');
  if (typeof generateTask !== 'function') throw new TypeError('generateTask 必须是函数');
  if (typeof isEnabled !== 'boolean' && typeof isEnabled !== 'function') {
    throw new TypeError('isEnabled 必须是布尔值或函数');
  }
  for (const [name, value] of Object.entries({ collectSources, now, createId })) {
    if (value !== undefined && typeof value !== 'function') throw new TypeError(`${name} 必须是函数`);
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
  const sourceContextProvider = () => {
    const { raw, identity } = normalizedContext();
    return { ...raw, ...identity };
  };

  const archiveAdapter = createArchiveV2Adapter({ client, contextProvider: identityContextProvider, isEnabled });
  const recognizerOptions = { contextProvider: identityContextProvider, generateTask, isEnabled };
  if (createId !== undefined) recognizerOptions.createId = createId;
  const recognizer = createArchiveV2CandidateRecognizer(recognizerOptions);
  const profileGenerator = createArchiveV2ProfileGenerator({
    contextProvider: identityContextProvider,
    generateTask,
    isEnabled,
  });
  const committer = createArchiveV2InitializationCommitter({ archiveAdapter });
  const flowOptions = { sourceContextProvider, recognizer, profileGenerator, committer };
  if (collectSources !== undefined) flowOptions.collectSources = collectSources;
  if (now !== undefined) flowOptions.now = now;
  const flow = createArchiveV2InitializationFlow(flowOptions);

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
    let firstError;
    try { flow.reset(); } catch (error) { firstError = error; }
    try { archiveAdapter.invalidate(); } catch (error) { firstError ??= error; }
    if (firstError) throw firstError;
  }

  return Object.freeze({
    flow,
    readArchive: () => archiveAdapter.read(),
    currentIdentity,
    invalidate,
  });
}
