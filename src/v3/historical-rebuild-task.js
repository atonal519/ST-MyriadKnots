import { createChatIdentityCoordinator } from '../chat-identity.js';
import { createChatSession } from '../chat-session.js';
import { readTargetChat } from './message-floor-anchor.js';
import { createHostAdapter } from './host-adapter.js';
import { createFoundationStore } from './foundation-store.js';
import { createFoundationRuntime } from './foundation-runtime.js';
import { createV3MemoryRuntime } from './memory-runtime.js';
import { createTimeRuntime, createTimeStore } from './time-runtime.js';

const clone = value => structuredClone(value);
const withoutIntegrity = header => {
  const value = clone(header);
  if (value?.chat_metadata) delete value.chat_metadata.integrity;
  return value;
};

function captureAuthorContext(source, target, chat) {
  const value = {};
  const rawCharacter = Array.isArray(source?.characters) ? source.characters[source.characterId] : source?.characters?.[source.characterId];
  const rawData = rawCharacter?.data ?? {};
  const character = {
    name: rawCharacter?.name ?? rawData.name, avatar: rawCharacter?.avatar ?? rawData.avatar,
    description: rawCharacter?.description ?? rawData.description,
    personality: rawCharacter?.personality ?? rawData.personality,
    scenario: rawCharacter?.scenario ?? rawData.scenario,
    extensions: { world: rawCharacter?.extensions?.world },
    data: {
      name: rawData.name, avatar: rawData.avatar, description: rawData.description,
      personality: rawData.personality, scenario: rawData.scenario,
      extensions: { world: rawData.extensions?.world },
      character_book: rawData.character_book ? { name: rawData.character_book.name, entries: clone(rawData.character_book.entries ?? []) } : undefined,
    },
  };
  value.name1 = String(source?.name1 ?? '');
  value.name2 = String(source?.name2 ?? character.name ?? target.characterName);
  value.characterId = 0;
  value.characters = [character];
  value.personaId = String(source?.personaId ?? '');
  value.personaDescription = String(source?.personaDescription ?? source?.powerUserSettings?.persona_description ?? source?.persona?.description ?? '');
  value.powerUserSettings = { persona_description: value.personaDescription, persona_description_lorebook: source?.powerUserSettings?.persona_description_lorebook };
  value.extensionSettings = { note: clone(source?.extensionSettings?.note ?? {}) };
  value.chatWorldInfo = { getNames: () => [...(source?.chatWorldInfoNames ?? [])], globalSelection: [...(source?.chatWorldInfoGlobalSelection ?? [])] };
  value.getCharaFilename = () => String(character.avatar ?? target.avatarUrl).replace(/\.[^.]+$/u, '');
  value.getCharaAuxWorlds = () => [...(source?.characterAuxWorlds ?? [])];
  value.chatId = target.hostChatId;
  value.getCurrentChatId = () => target.hostChatId;
  value.groupId = null;
  value.characterAvatar = target.avatarUrl;
  value.name2 ??= target.characterName;
  value.characterId ??= 0;
  value.characters ??= [{ name: target.characterName, avatar: target.avatarUrl }];
  value.characters[value.characterId] ??= { name: target.characterName, avatar: target.avatarUrl };
  value.characters[value.characterId].name ??= target.characterName;
  value.characters[value.characterId].avatar ??= target.avatarUrl;
  value.userAvatar = String(source?.userAvatar ?? '');
  value.chat = chat;
  value.chatMetadata = {};
  value.getRequestHeaders = () => target.requestHeaders;
  return value;
}

export async function runHistoricalRebuildTask({
  identity,
  provisionalIdentity = false,
  target,
  cleanedChat,
  sourceContext,
  sourceWorldInfo = {},
  sourceUserIdentity,
  client,
  coreRecordCache = null,
  isEnabled = true,
  newUuid,
  sanitizerOptions = () => ({}),
  scanCandidates,
  generateAnalysisTask,
  generateUtilityTask,
  automationSettings = () => ({ enabled: false, batchSize: 1 }),
  notifyUser = null,
  extractorPromptGuidance = () => '',
  csePromptGuidance = () => '',
  processingPrompt = () => '',
  storyClockReferenceTags = () => '',
  storyCalendarForChat = () => null,
  filterWorldInfoSources = sources => sources,
  identityProjectionProvider = null,
  qianshiExternalReferenceProvider = () => [],
  persistAnchors = null,
  generateTimeTask = null,
  isTimeEvolutionEnabled = () => false,
  aggregate = false,
  forceMigrationRebuild = false,
  fetchImpl = globalThis.fetch,
  logger = console,
  onTaskControl = null,
} = {}) {
  if (!identity?.chatId || !target?.hostChatId || !cleanedChat?.header || !Array.isArray(cleanedChat.chat)) throw new TypeError('历史重构任务目标无效');
  const chat = cleanedChat.chat;
  const taskTarget = { ...target };
  const targetContext = captureAuthorContext(sourceContext, taskTarget, chat);
  targetContext.getWorldInfoNames = () => [...(sourceWorldInfo.names ?? [])];
  targetContext.loadWorldInfo = name => sourceWorldInfo.loadWorldInfo?.(name) ?? null;
  const fixedWorldInfoBindings = Object.freeze({
    getSelectedWorldInfo: () => sourceWorldInfo.selected ?? [],
    getWorldInfoSettings: () => sourceWorldInfo.settings ?? {},
    getWorldInfoNames: () => sourceWorldInfo.names ?? [],
    getDefaultCaseSensitive: () => sourceWorldInfo.caseSensitive === true,
    getDefaultMatchWholeWords: () => sourceWorldInfo.matchWholeWords === true,
    getCharLorebooks: () => sourceWorldInfo.characterLorebooks ?? {},
    getGlobalWorldInfoSelection: () => sourceWorldInfo.globalSelection ?? [],
    loadWorldInfo: name => sourceWorldInfo.loadWorldInfo?.(name) ?? null,
  });
  targetContext.chatMetadata = clone(cleanedChat.header.chat_metadata ?? {});
  const hostGlobal = { SillyTavern: { getContext: () => targetContext } };
  const hostAdapter = createHostAdapter({ globalRef: hostGlobal, worldInfoBindings: fixedWorldInfoBindings, personaIdentifierProvider: () => sourceUserIdentity?.personaIdentifier ?? identity.personaLocator });
  let expectedHeader = clone(cleanedChat.header);
  let expectedMessages = JSON.stringify(chat);

  async function saveTargetFile(nextMessages = chat) {
    const latest = await readTargetChat(taskTarget, { fetchImpl, allowMissingIdentity: true });
    if (JSON.stringify(latest.header) !== JSON.stringify(expectedHeader) || JSON.stringify(latest.chat) !== expectedMessages) {
      throw Object.assign(new Error('原目标聊天在重构期间被修改。'), { code: 'QQJ_REBUILD_TARGET_CONFLICT' });
    }
    const header = clone(latest.header);
    header.chat_metadata = clone(targetContext.chatMetadata);
    const desired = [header, ...nextMessages];
    const response = await fetchImpl('/api/chats/save', {
      method: 'POST', cache: 'no-cache', headers: taskTarget.requestHeaders ?? {},
      body: JSON.stringify({ ch_name: taskTarget.characterName, file_name: taskTarget.hostChatId, avatar_url: taskTarget.avatarUrl, chat: desired, force: false }),
    });
    if (!response?.ok) throw Object.assign(new Error('原目标聊天没有确认保存。'), { code: [400, 409].includes(response?.status) ? 'QQJ_REBUILD_TARGET_CONFLICT' : 'QQJ_REBUILD_TARGET_SAVE_FAILED' });
    const persisted = await readTargetChat(taskTarget, { fetchImpl, allowMissingIdentity: true });
    if (JSON.stringify(persisted.chat) !== JSON.stringify(nextMessages)
      || persisted.header.chat_metadata?.qianqianjie?.chatId !== taskTarget.chatId
      || JSON.stringify(withoutIntegrity(persisted.header)) !== JSON.stringify(withoutIntegrity(header))) {
      throw Object.assign(new Error('原目标聊天保存后读回不一致。'), { code: 'QQJ_REBUILD_TARGET_VERIFY_FAILED' });
    }
    expectedHeader = clone(persisted.header);
    expectedMessages = JSON.stringify(persisted.chat);
    for (const key of Object.keys(targetContext.chatMetadata)) delete targetContext.chatMetadata[key];
    Object.assign(targetContext.chatMetadata, clone(persisted.header.chat_metadata ?? {}));
    return persisted;
  }
  targetContext.saveChat = async () => (await saveTargetFile(chat), true);
  targetContext.saveChatMetadata = async () => (await saveTargetFile(chat), true);

  const targetIdentityCoordinator = createChatIdentityCoordinator({
    client,
    freshUuid: newUuid,
    persist: async (context, chatId) => {
      taskTarget.chatId = chatId;
      context.chatMetadata.qianqianjie = { schemaVersion: 2, chatId };
      await targetContext.saveChatMetadata();
      return true;
    },
  });
  if (provisionalIdentity) targetContext.chatMetadata.qianqianjie = { schemaVersion: 2, chatId: taskTarget.chatId };
  const targetSession = createChatSession({ contextProvider: () => targetContext, isEnabled, identityCoordinator: targetIdentityCoordinator });
  const store = createFoundationStore({ client, contextProvider: () => targetSession.identity(), isEnabled, coreRecordCache });
  const preparedState = await targetSession.prepare().then(state => {
    if (state.status !== 'ready') throw Object.assign(new Error('原目标新身份未能完成准备。'), { code: 'QQJ_REBUILD_IDENTITY_NOT_READY' });
    return state.identity;
  });
  const storyCalendar = storyCalendarForChat(preparedState.chatId) ?? null;
  const foundationRuntime = createFoundationRuntime({
    hostAdapter, store, contextProvider: () => targetContext, prepareSession: () => targetSession.prepare(),
    deferChatChangeRefreshUntilPrepared: false, isEnabled, sanitizerOptions, scanCandidates, newUuid, logger, fetchImpl,
  });
  const timeRuntime = createTimeRuntime({
    store: createTimeStore({ client }), foundationStore: store, hostAdapter, session: targetSession,
    generateTimeTask, storyCalendarProvider: () => storyCalendar, sanitizerOptions,
    storyClockReferenceTags, newUuid, getReachable: () => foundationRuntime.getReachable(),
    getMemoryState: () => memoryRuntime?.getState?.(), isEnabled: isTimeEvolutionEnabled,
  });
  const memoryRuntime = createV3MemoryRuntime({
    storyCalendarProvider: () => storyCalendar, foundationRuntime, store, hostAdapter, generateAnalysisTask, generateUtilityTask,
    isEnabled, automationSettings, notifyUser, isMainGenerationActive: () => false,
    extractorPromptGuidance, csePromptGuidance, processingPrompt, storyClockReferenceTags,
    filterWorldInfoSources, sanitizerOptions, persistAnchors, identityProjectionProvider,
    captureBusinessIdentity: () => targetSession.identity(), storeForIdentity: identityValue => store.forIdentity(identityValue),
    onQianshiEventDeleted: () => {}, qianshiExternalReferenceProvider, newUuid, logger,
  });
  const waitForHistoricalSettlement = initialState => {
    const settled = state => state?.memoryWorkBusy !== true && state?.rebuildStatus !== 'rebuilding';
    if (settled(initialState) || typeof memoryRuntime.subscribe !== 'function') return Promise.resolve(initialState);
    return new Promise(resolve => {
      let unsubscribe = null, finished = false;
      const finish = state => {
        if (finished || !settled(state)) return;
        finished = true;
        unsubscribe?.();
        resolve(state);
      };
      unsubscribe = memoryRuntime.subscribe(finish);
      finish(memoryRuntime.getState());
    });
  };
  let migrationResetComplete = false;
  const taskControl = Object.freeze({
    getState: () => memoryRuntime.getState(),
    subscribe: listener => memoryRuntime.subscribe(listener),
    pause: () => memoryRuntime.pauseHistoricalRebuild(),
    start: async options => {
      if (forceMigrationRebuild && !migrationResetComplete) {
        await memoryRuntime.resetLiveMigrationMemoriesForRebuild();
        migrationResetComplete = true;
      }
      await timeRuntime.authorizeHistory?.();
      try { return await waitForHistoricalSettlement(await memoryRuntime.startHistoricalRebuild(options)); }
      finally { timeRuntime.invalidate?.(preparedState.chatId); }
    },
  });
  try { onTaskControl?.(taskControl); } catch { /* management progress is advisory */ }
  return taskControl.start({ aggregate: aggregate === true });
}
